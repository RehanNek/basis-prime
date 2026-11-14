// A fake account and gate for the three steps of INTERFACES.md 50.2 (pause_lifted, borrow_again, repay_again): gate
// 2's tests and the pause gate's tests share it. The account keeps the contract's own rules: a check's `sent` takes
// nonces off `open_sends`, `send_open_until_ms` drops to "0" when none is left, and `borrow` wants the pause off and
// a fresh, unused borrow verdict that allows the amount. Nothing here reaches a chain or Hyperliquid.
import assert from "node:assert/strict";

import type { SendPause } from "./funding-kit.js";
import type { FundingGate } from "./funding-steps.js";
import { planFor, StepFailed, StepRunner, type RunRecord, type StepRecord } from "./hedge-kit.js";
import type { TxResult, World } from "./hedge-steps.js";

export const ACCOUNT = "demo.pbf.testnet";
export const KEEPER = "pbf-keeper.testnet";
export const POOL = "pool.pbf.testnet";
export const MUSDC = "musdc.pbf-ops.testnet";
export const MNBTC = "mnbtc.pbf-ops.testnet";
export const ADDRESS = "0x303d6eccb884202707872ae95bf36049cd5099aa";
export const FLOAT = "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d";
export const T0 = 1_794_600_000_000;
export const USD = 1_000_000n;
/** The account's SEND_OPEN_MS: 2 days and 1 hour. */
export const SEND_OPEN_MS = 49 * 3_600_000;
/** The transfer home's nonce, signed two minutes before the step runs. */
export const NONCE = T0 - 120_000;

/** Hyperliquid's own row for a transfer out, as read live on testnet on 13 Nov (userNonFundingLedgerUpdates). */
export const sendRow = (nonce: number, user = ADDRESS, destination = FLOAT) => ({
  time: nonce + 13_279,
  hash: "0x830259a7a2a23e5b847c042e0e2650010200718d3da55d2d26cb04fa61a61846",
  delta: { type: "send", user, destination, sourceDex: "", destinationDex: "", token: "USDC", amount: "442.0", usdcValue: "442.0", fee: "0.0", nativeTokenFee: "0.0", nonce, feeToken: "" },
});

export type Verdict = Record<string, unknown>;
export const verdict = (more: Verdict = {}): Verdict => ({ ok: true, state: "HEALTHY", action: "NONE", allow: { borrow: 400_000_000, withdraw: 0 }, ...more });

export interface Chain {
  now: number;
  block: number;
  state: {
    owner: string;
    counter: number;
    loan: { principal: string; open: boolean };
    verdict: { intent: unknown; received_block: number; verdict: Verdict } | null;
    hl: (SendPause & { path: string }) | null;
  };
  balances: Record<string, bigint>;
  poolDebt: bigint;
  /** Hyperliquid's history for the account's address. */
  ledger: unknown[];
  /** Handed out one per request_check; then a HEALTHY one that names every open nonce as sent. */
  verdicts: Verdict[];
  /** After a check's result is accepted: lets a test put the account in a state the rule wouldn't. */
  afterCheck?: (c: Chain) => void;
  /** What happens while the script sleeps. */
  between?: (c: Chain) => void;
  poolRefuses?: boolean;
  /** The pool takes the debt and the money doesn't reach the account. */
  loanLost?: boolean;
}

/** An account made after the deploy, just after its USDC came home: one transfer open, the pause on. */
export function chain(overrides: Partial<Chain> = {}): Chain {
  return {
    now: T0,
    block: 9_000,
    state: {
      owner: KEEPER,
      counter: 40,
      loan: { principal: "0", open: false },
      verdict: { intent: { check: {} }, received_block: 8_700, verdict: verdict({ blk: 8_698, nonce: 31 }) },
      hl: { path: "hyperliquid-1", address: ADDRESS, send_open_until_ms: String(NONCE + SEND_OPEN_MS), open_sends: [String(NONCE)], send_floor_until_ms: "0" },
    },
    balances: { [`${MUSDC}:${ACCOUNT}`]: 430n * USD, [`${MNBTC}:${ACCOUNT}`]: 1_500_000n },
    poolDebt: 0n,
    ledger: [sendRow(NONCE)],
    verdicts: [],
    ...overrides,
  };
}

/** An account made before the deploy: the pause is on, and its state shows no `open_sends`. */
export const olderChain = (overrides: Partial<Chain> = {}) => {
  const c = chain(overrides);
  c.state.hl = { path: "hyperliquid-1", address: ADDRESS, send_open_until_ms: String(NONCE + SEND_OPEN_MS) };
  return c;
};

export interface Sent {
  contract: string;
  method: string;
  args: Record<string, unknown>;
  deposit: bigint;
}

/** `extra.mustLift` is the pause gate's setting: an older account then fails the three steps (funding-steps.ts, LiftGate). */
export function fakeGate(c: Chain, steps: StepRecord[] = [], extra: { mustLift?: boolean } = {}) {
  const sent: Sent[] = [];
  const logged: string[] = [];
  const asked: Record<string, unknown>[] = [];
  const slept: number[] = [];
  const bal = (token: string, holder: string) => c.balances[`${token}:${holder}`] ?? 0n;
  const add = (token: string, holder: string, amount: bigint) => (c.balances[`${token}:${holder}`] = bal(token, holder) + amount);
  const tx = (label: string, result: unknown = null): TxResult => ({ label, hash: `H${sent.length}`, ok: true, gas_tgas: 5, seconds: 1, logs: [], result });
  const refused = (label: string, failure: string): TxResult => ({ ...tx(label), ok: false, failure });
  const world: World = {
    account: ACCOUNT,
    owner: KEEPER,
    ids: { factory: "pbf.testnet", pool: POOL, musdc: MUSDC, mnbtc: MNBTC, mpc: "v1.signer-prod.testnet", hlFloat: FLOAT },
    near: {
      call: async (contract, method, args, o) => {
        sent.push({ contract, method, args, deposit: o.deposit });
        const amount = BigInt(String(args.amount ?? "0"));
        const hl = c.state.hl;
        switch (method) {
          case "request_check": {
            c.block += 3;
            const open = hl?.open_sends;
            const v: Verdict = { blk: c.block - 2, nonce: c.state.counter, ...(c.verdicts.shift() ?? verdict(open?.length ? { sent: open.map(Number) } : {})) };
            c.state.verdict = { intent: args.intent, received_block: c.block, verdict: v };
            // The account's rule on accepting a result (INTERFACES.md 50.2): the nonces `sent` names leave the list,
            // and the pause's end is the later of the floor and the newest one still open plus 2 days and 1 hour.
            if (hl && Array.isArray(hl.open_sends)) {
              const named = ((v.sent as number[] | undefined) ?? []).map(String);
              hl.open_sends = hl.open_sends.filter((n) => !named.includes(n));
              const newest = hl.open_sends.length ? Number(hl.open_sends.at(-1)) + SEND_OPEN_MS : 0;
              hl.send_open_until_ms = String(Math.max(Number(hl.send_floor_until_ms ?? 0), newest));
            }
            c.afterCheck?.(c);
            return tx(o.label, { accepted: true, reason: null });
          }
          case "borrow": {
            // The account's own refusals, in its order (contracts/account/src/lib.rs, `borrow`).
            if (Number(hl?.send_open_until_ms ?? 0) > c.now) return refused(o.label, "borrow waits: a signed transfer out of Hyperliquid could still be posted");
            const held = c.state.verdict;
            if (!held || held.verdict.nonce !== c.state.counter) return refused(o.label, "the verdict was already used: ask for a new check");
            const age = c.block - Number(held.verdict.blk);
            if (age > 120) return refused(o.label, `the verdict is ${age} blocks old, above the 120-block limit`);
            if (!(held.intent as Record<string, unknown>).borrow) return refused(o.label, "the verdict doesn't answer a borrow");
            if (BigInt(Number((held.verdict.allow as { borrow?: number }).borrow ?? 0)) < amount) return refused(o.label, "amount is above the verdict's borrow allowance");
            c.state.counter += 2;
            if (c.poolRefuses) return { ...tx(o.label, false), logs: ["the pool refused the borrow: the daily lending budget"] };
            c.poolDebt += amount;
            c.state.loan = { principal: c.poolDebt.toString(), open: true };
            if (!c.loanLost) add(MUSDC, ACCOUNT, amount);
            return tx(o.label, true);
          }
          case "repay": {
            const used = amount < c.poolDebt ? amount : c.poolDebt;
            if (bal(MUSDC, ACCOUNT) < amount) return refused(o.label, "the account holds too little USDC");
            add(MUSDC, ACCOUNT, -used);
            c.poolDebt -= used;
            c.state.loan = { principal: c.poolDebt.toString(), open: c.poolDebt > 0n };
            c.state.counter += 1;
            return tx(o.label);
          }
          default:
            throw new Error(`unexpected call ${method}`);
        }
      },
      view: async <T>(contract: string, method: string, args: Record<string, unknown> = {}) => {
        if (method === "get_state") return structuredClone(c.state) as T;
        if (method === "debt_of") return c.poolDebt.toString() as T;
        if (method === "ft_balance_of") return bal(contract, String(args.account_id)).toString() as T;
        throw new Error(`unexpected view ${contract}.${method}`);
      },
      exists: async () => true,
      finalBlockMs: async () => c.now,
    },
    api: {
      get: async (path) => {
        throw new Error(`unexpected GET ${path}`);
      },
      post: async (path) => {
        throw new Error(`unexpected POST ${path}`);
      },
    },
    hl: {
      info: async <T>(body: Record<string, unknown>) => {
        asked.push(body);
        if (body.type !== "userNonFundingLedgerUpdates") throw new Error(`unexpected info ${String(body.type)}`);
        return structuredClone(c.ledger) as T;
      },
    },
    float: { order: async () => ({ oid: null, text: "" }), cancel: async () => "", close: async () => "" },
    sign: async () => {
      throw new Error("nothing is signed for the gateway in these steps");
    },
    sleep: async (ms) => {
      slept.push(ms);
      c.now += ms;
      c.block += Math.round(ms / 1_000);
      c.between?.(c);
    },
    now: () => c.now,
    log: (line) => logged.push(line),
  };
  const record: RunRecord = { context: {}, steps };
  const gate = {
    runner: new StepRunner(record, () => {}, () => {}, () => c.now),
    plan: planFor("small", 76_000),
    world,
    name: "demo",
    lender: "rhea",
    rheaId: "rhea.pbf-ops.testnet",
    finalBlock: async () => c.block,
    ...extra,
  } as unknown as FundingGate;
  const step = (id: string) => record.steps.find((s) => s.id === id)!;
  const detail = (id: string) => step(id).detail as Record<string, unknown>;
  const checks = () => sent.filter((s) => s.method === "request_check");
  return { gate, sent, logged, asked, slept, record, step, detail, checks };
}

/** Runs a step that is expected to stop the run, and gives back why. */
export async function stops(run: Promise<void>): Promise<string> {
  let message = "";
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof StepFailed, String(error));
    message = error.message;
    return true;
  });
  return message;
}
