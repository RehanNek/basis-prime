// The Aave gate (gate 3) against a made-up world: a fake account contract that signs and stores Ethereum
// transactions, a fake backend whose routes answer as services/api's do (INTERFACES.md 33), and a fake Aave whose
// books move when a signed transaction is sent. Nothing here touches a chain.
import assert from "node:assert/strict";
import { test } from "node:test";

import { AAVE_DEPOSIT_USDC_MICRO, AAVE_STEP_IDS, aavePermission, aavePlan, aaveProblems, aaveRepayAmount, aaveSettlement, aaveSplitProblem, depositShort, describeAaveGate, keeperWatches, pickCollateral, WBTC_UNITS, WRAP_WEI, type AaveFound, type PoolPricing, type Room } from "./aave-kit.js";
import { AAVE_STEPS, stepAaveWithdraw, stepCollateral, stepDepositUsdc, stepEvmOut, stepFundAave, stepFundedAave, stepKeeperWatches, stepRepayAave, stepSettleAave, type AaveGate } from "./aave-steps.js";
import { aaveSettings } from "./evm.js";
import { planFor, StepFailed, StepRunner, type RunRecord } from "./hedge-kit.js";
import type { World } from "./hedge-steps.js";
import type { LogEvent } from "./jsonl.js";
import type { AccountState, VerdictJson } from "./state.js";

const T0 = Date.UTC(2026, 10, 11, 18, 0);
const ACCOUNT = "demo.pbf.testnet";
const POOL = "0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27";
const USDC = "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f";
const WBTC = "0x54114591963cf60ef3aa63befd6ec263d98145a4";
const WETH = "0x4200000000000000000000000000000000000006";
const GAS_WALLET = "0x2031181d63507368232579af4c64a1c3428407ff";
const ADDRESS = `0x${"ac".repeat(20)}`;
const CONFIG = { lenders: { aave: { chain_id: 84_532, pool: POOL, usdc: { symbol: "USDC", address: USDC, decimals: 6 }, collateral: [{ symbol: "WBTC", address: WBTC, decimals: 8 }, { symbol: "WETH", address: WETH, decimals: 18 }], max_fee_per_gas: "1000000000" } } };
const TOKENS = [{ token: USDC, symbol: "USDC", decimals: 6 }, { token: WBTC, symbol: "WBTC", decimals: 8 }, { token: WETH, symbol: "WETH", decimals: 18 }];
/** Read on Base Sepolia on 11 Nov: WBTC's cap is full, and WETH has about 764 of room. */
const FULL: Room[] = [{ token: WBTC, symbol: "WBTC", decimals: 8, room: "0" }, { token: WETH, symbol: "WETH", decimals: 18, room: "764071278225710971429" }];
const OPEN: Room[] = [{ token: WBTC, symbol: "WBTC", decimals: 8, room: "2500000000" }, FULL[1]!];

interface Signed {
  nonce: number;
  kind: string;
  token: string;
  amount: string;
  to: string | null;
  raw: string;
  hash: string;
  step: string | null;
}

interface Sim {
  now: number;
  blk: number;
  counter: number;
  verdict: VerdictJson | null;
  funding: { pid: string; steps: { k: string; l?: string; tok?: string; amt: string | number; done: boolean }[] } | null;
  signed: Signed[];
  /** Aave's chain: how many nonces it has used, the address's test ETH and tokens, and Aave's books. */
  chainNonce: number;
  eth: bigint;
  wallet: Record<string, bigint>;
  posted: Record<string, bigint>;
  debt: bigint;
  poolDebt: bigint;
  rooms: Room[];
  /** What request_check's verdict says for a `fund` intent, and what POST /api/funding-plan answers. */
  fund: unknown[];
  preview: unknown;
  /** What the pool does with each settle(), in order (a skip changes nothing); and checks the account refuses, by their number. */
  settles: unknown[];
  /** The pool's record of the account (its get_pricing). */
  pricing: PoolPricing;
  refuseChecks: number[];
  checks: number;
  keeperLog: LogEvent[];
  gasAsks: unknown[];
  submits: number[];
  calls: { method: string; args: Record<string, unknown>; deposit: bigint }[];
  out: { token: string; amount: string; to: string }[];
  /** What happens while the script sleeps: the keeper's work. */
  between?: (s: Sim) => void;
  /** INTERFACES.md 40.1: the block the permission last changed in. `fund` takes only a check read after it. */
  permissionBlk: number;
}

function sim(overrides: Partial<Sim> = {}): Sim {
  return { now: T0, blk: 5_000, counter: 8, verdict: null, funding: null, signed: [], chainNonce: 0, eth: 0n, wallet: {}, posted: {}, debt: 0n, poolDebt: 0n, rooms: FULL, fund: [], preview: null, settles: [], pricing: { fees_charged: "0", subsidy_paid: "0", settled_at: "0", last: [] }, refuseChecks: [], checks: 0, keeperLog: [], gasAsks: [], submits: [], calls: [], out: [], permissionBlk: 4_990, ...overrides };
}

/** The account has the signer sign a transaction, and stores it. */
function sign(s: Sim, kind: string, token: string, amount: bigint | string, to: string | null = null, step: string | null = null): Signed {
  const nonce = s.signed.length;
  const entry: Signed = { nonce, kind, token, amount: String(amount), to, raw: "0x02", hash: `0x${String(nonce).padStart(64, "0")}`, step };
  s.signed.push(entry);
  return entry;
}

/** Aave's chain mines a signed transaction: the books and the address move as the call says. */
function mine(s: Sim, nonce: number) {
  if (nonce !== s.chainNonce) return;
  const e = s.signed[nonce]!;
  const amount = BigInt(e.amount.length > 40 ? "0" : e.amount);
  const add = (book: Record<string, bigint>, token: string, by: bigint) => (book[token] = (book[token] ?? 0n) + by);
  if (e.kind === "supply") (add(s.wallet, e.token, -amount), add(s.posted, e.token, amount));
  if (e.kind === "borrow") ((s.debt += amount), add(s.wallet, USDC, amount));
  if (e.kind === "repay") {
    const paid = amount < s.debt ? amount : s.debt; // Aave takes only what is owed
    s.debt -= paid;
    add(s.wallet, USDC, -paid);
  }
  if (e.kind === "withdraw") (add(s.posted, e.token, -amount), add(s.wallet, e.token, amount));
  if (e.kind === "transfer") (add(s.wallet, e.token, -amount), s.out.push({ token: e.token, amount: e.amount, to: e.to ?? "" }));
  s.chainNonce = nonce + 1;
}

const ext = (s: Sim) => {
  const collateral = Object.values(s.posted).some((v) => v > 0n) ? 1_130_000_000 : 0;
  return collateral || s.debt ? [{ l: "aave", c: collateral, d: Number(s.debt), hf_bp: s.debt ? 15_000 : 0, r_bp: 74, s_bp: 9, room: 0, liq_bp: 8_300 }] : [];
};

function check(s: Sim, intent: Record<string, unknown>): VerdictJson {
  s.blk += 20;
  const v = { ok: true, state: "HEALTHY", action: "NONE", blk: s.blk, nonce: s.counter, ext: ext(s), evm: { nonce: s.chainNonce }, ...("fund" in intent ? { fund: s.fund } : {}) } as VerdictJson;
  s.verdict = v;
  return v;
}

function gate(s: Sim, options: Partial<AaveGate["options"]> = {}) {
  const held = (book: Record<string, bigint>, all: boolean) => TOKENS.map((t) => ({ ...t, amount: (book[t.token] ?? 0n).toString() })).filter((t) => all || t.amount !== "0");
  const tx = (label: string, result?: unknown) => ({ label, hash: `N${s.calls.length}`, ok: true, gas_tgas: 20, seconds: 2, logs: [], ...(result !== undefined ? { result } : {}) });
  const world = {
    account: ACCOUNT,
    owner: "pbf-keeper.testnet",
    ids: { factory: "pbf.testnet", pool: "pool.pbf.testnet", musdc: "musdc.pbf-ops.testnet", mnbtc: "mnbtc.pbf-ops.testnet", mpc: "v1.signer-prod.testnet", hlFloat: "0x" },
    near: {
      call: async (_contract: string, method: string, args: Record<string, unknown>, o: { deposit: bigint; label: string }) => {
        s.calls.push({ method, args, deposit: o.deposit });
        switch (method) {
          case "request_check": {
            s.checks += 1;
            if (s.refuseChecks.includes(s.checks)) return tx(o.label, { accepted: false, reason: "nonce 8 is not the counter 9" });
            check(s, args.intent as Record<string, unknown>);
            return tx(o.label, { accepted: true });
          }
          case "fund":
            // The audit's A8: a check read before the permission last changed backs no fund.
            if (!s.verdict || s.verdict.blk <= s.permissionBlk) return { ...tx(o.label), ok: false, failure: `the check was read before the permission last changed (block ${s.permissionBlk}): ask for a new check` };
            s.funding = { pid: `f${s.blk}`, steps: (s.fund as { k: string; amt: number }[]).map((f) => ({ ...f, done: false })) };
            s.counter += 1;
            return tx(o.label);
          case "settle": {
            const next = (s.settles.shift() ?? { skipped: "the last settlement was 1 minute ago" }) as Error | { skipped?: string; fee?: string; subsidy?: string };
            if (next instanceof Error) throw next;
            // The pool books it in its own record; the account's settle() answers true either way, as on testnet.
            if (next.skipped === undefined) {
              s.pricing = {
                fees_charged: (BigInt(s.pricing.fees_charged) + BigInt(next.fee ?? "0")).toString(),
                subsidy_paid: (BigInt(s.pricing.subsidy_paid) + BigInt(next.subsidy ?? "0")).toString(),
                settled_at: (BigInt(s.now) * 1_000_000n).toString(),
                last: [{ lender: "aave", debt: s.debt.toString(), rate_bp: 74, supply_bp: 9 }],
              };
            }
            return tx(o.label, true);
          }
          case "evm_approve":
            sign(s, "approve", String(args.token), (1n << 256n) - 1n);
            return tx(o.label);
          case "lender_repay":
            sign(s, "repay", USDC, String(args.amount));
            return tx(o.label);
          case "lender_withdraw":
            sign(s, "withdraw", String(args.token), String(args.amount));
            return tx(o.label);
          case "evm_withdraw":
            sign(s, "transfer", String(args.token), String(args.amount), String(args.to));
            return tx(o.label);
          default:
            throw new Error(`unexpected call ${method}`);
        }
      },
      view: async (_contract: string, method: string) => {
        if (method === "get_state") {
          const state = { owner: "pbf-keeper.testnet", counter: s.counter, loan: { principal: s.poolDebt.toString(), open: s.poolDebt > 0n }, verdict: s.verdict ? { intent: { check: {} }, received_block: s.blk + 2, verdict: s.verdict } : null, pending: [], permission_blk: s.permissionBlk, hl: { path: "hl", address: ADDRESS }, funding: s.funding ? { ...s.funding, amount: "1", stored_at: String(BigInt(T0) * 1_000_000n), expires_at: String(BigInt(T0 + 1_800_000) * 1_000_000n) } : null, evm: { nonce: s.signed.length, signed: s.signed } };
          return structuredClone(state) as AccountState;
        }
        if (method === "get_config") return CONFIG;
        if (method === "debt_of") return s.poolDebt.toString();
        if (method === "get_pricing") return structuredClone(s.pricing);
        throw new Error(`unexpected view ${method}`);
      },
    },
    api: {
      get: async (path: string) => {
        if (path === "/api/lenders") return { status: 200, body: { lenders: [{ l: "aave", network: "mainnet" }, { l: "aave", network: "testnet", collateral_room: s.rooms }] } };
        if (path !== `/api/lender/${ACCOUNT}`) throw new Error(`unexpected GET ${path}`);
        const lenders = ext(s).map((e) => ({ l: "aave", posted: e.c, debt: e.d, hf_bp: e.hf_bp, held: held(s.posted, false) }));
        const signed = s.signed.map((e) => ({ nonce: e.nonce, kind: e.kind, token: e.token, amount: e.amount, hash: e.hash, status: e.nonce < s.chainNonce ? "mined" : "signed" }));
        return { status: 200, body: { lenders, evm: { address: ADDRESS, nonce: s.signed.length, chain_nonce: s.chainNonce, eth: s.eth.toString(), wallet: held(s.wallet, true), posted: held(s.posted, false), signed, chain_error: null } } };
      },
      post: async (path: string, body: { nonce?: number; mint?: { token: string; amount: string }; wrap?: { amount: string } }) => {
        if (path === "/api/funding-plan") return s.preview ? { status: 200, body: s.preview } : { status: 502, body: { message: "pb-risk did not complete" } };
        if (path === "/api/evm/submit") {
          s.submits.push(body.nonce!);
          mine(s, body.nonce!);
          return { status: 200, body: { status: "sent" } };
        }
        if (path !== "/api/evm/gas") throw new Error(`unexpected POST ${path}`);
        s.gasAsks.push(Object.fromEntries(Object.entries(body).filter(([k]) => k !== "account")));
        if (s.eth < 1_000_000_000_000_000n) s.eth = 2_000_000_000_000_000n;
        if (body.mint) s.wallet[body.mint.token] = (s.wallet[body.mint.token] ?? 0n) + BigInt(body.mint.amount);
        if (body.wrap) s.wallet[WETH] = (s.wallet[WETH] ?? 0n) + BigInt(body.wrap.amount);
        return { status: 200, body: { address: ADDRESS, gas_wallet: GAS_WALLET } };
      },
    },
    sleep: async (ms: number) => {
      s.now += ms;
      s.between?.(s);
    },
    now: () => s.now,
    log: () => {},
  } as unknown as World;
  const record: RunRecord = { context: {}, steps: [] };
  const g: AaveGate = {
    runner: new StepRunner(record, () => {}, () => {}, () => s.now),
    plan: planFor("small", 76_000),
    world,
    name: "demo",
    permission: aavePermission(),
    keeperLog: () => s.keeperLog,
    options: { askMicro: 2_000_000_000n, fundWaitMs: 20 * 60_000, settleWaitMs: 10 * 60_000, settleEveryMs: 120_000, ...options },
  };
  return { gate: g, record };
}

const detail = (record: RunRecord, id: string) => record.steps.find((x) => x.id === id)!.detail as Record<string, unknown>;
/** Runs a step that is expected to stop the gate, and answers the reason its record gives. */
async function stopped(run: Promise<void>, record: RunRecord, id: string): Promise<string> {
  await assert.rejects(run, (e: unknown) => e instanceof StepFailed);
  return String(detail(record, id).why);
}

test("the collateral: WBTC from Aave's faucet when its cap has room, wrapped test ETH when it is full, and a clear word when neither fits", () => {
  const wbtc = pickCollateral(OPEN);
  assert.deepEqual(wbtc, { symbol: "WBTC", token: WBTC, decimals: 8, amount: "1500000", how: "mint", why: "Aave's test market takes WBTC now (room for 25 WBTC): 0.015 WBTC from Aave's faucet" });
  assert.deepEqual(pickCollateral(FULL), { symbol: "WETH", token: WETH, decimals: 18, amount: "20000000000000000", how: "wrap", why: "Aave's test market has no room for WBTC now (room for 0 WBTC), and takes WETH (room for 764.0712782257109 WETH): 0.02 test ETH wrapped by the gas wallet" });
  // No cap at all is room; room for less than the gate's 0.015 WBTC isn't.
  assert.equal((pickCollateral([{ ...OPEN[0]!, room: null }]) as { how: string }).how, "mint");
  assert.equal((pickCollateral([{ ...OPEN[0]!, room: "1499999" }, FULL[1]!]) as { how: string }).how, "wrap");
  assert.deepEqual(pickCollateral([FULL[0]!, { ...FULL[1]!, room: "0" }]), { problem: "Aave's test market has room for neither collateral now: WBTC room for 0 WBTC, WETH room for 0 WETH" });
  assert.match((pickCollateral(null) as { problem: string }).problem, /gave no collateral_room/);
  assert.deepEqual([WBTC_UNITS, WRAP_WEI], [1_500_000n, 20_000_000_000_000_000n]);
  // What to repay: the debt, 0.1% and a little dust.
  assert.equal(aaveRepayAmount(570_000_000n), 570_571_000n);
  // The split the gate wants: a part from Aave and a part from our pool, and none from Rhea.
  const part = (source: string, amount: number) => ({ source, amount, rate_bp: 74 });
  assert.equal(aaveSplitProblem([part("aave", 20), part("pool", 30)]), null);
  assert.match(aaveSplitProblem([part("pool", 30)])!, /none from Aave/);
  assert.equal(aaveSplitProblem([part("aave", 30)]), null, "Aave's part alone is enough: a pool part isn't needed");
  assert.match(aaveSplitProblem([])!, /found nothing to lend/);
  assert.match(aaveSplitProblem([part("aave", 1), part("rhea", 1), part("pool", 1)])!, /a part from Rhea too/);
});

test("the deposit: $1,200 of test USDC, over the engine's $1,000 floor, and a resumed run adds only what is missing", async () => {
  const small = planFor("small", 76_000);
  const plan = aavePlan(small);
  assert.equal(plan.deposit_usdc_micro, "1200000000");
  assert.ok(AAVE_DEPOSIT_USDC_MICRO > 1_000_000_000n, "the engine lends nothing to an account worth under $1,000");
  assert.equal(depositShort(small, plan), true, "a record from the first live run, which deposited $440");
  assert.equal(depositShort(plan, plan), false);

  // The first live run's account: $440 is there already.
  let balance = 440_000_000n;
  const calls: { method: string; amount: string }[] = [];
  const world = {
    account: ACCOUNT,
    owner: "pbf-keeper.testnet",
    ids: { musdc: "musdc.pbf-ops.testnet" },
    near: {
      call: async (_contract: string, method: string, args: { amount: string }, o: { label: string }) => {
        calls.push({ method, amount: args.amount });
        if (method === "ft_transfer_call") balance += BigInt(args.amount);
        return { label: o.label, hash: `N${calls.length}`, ok: true, gas_tgas: 5, seconds: 1, logs: [] };
      },
      view: async () => balance.toString(),
    },
  } as unknown as World;
  const record: RunRecord = { context: {}, steps: [] };
  const g = { runner: new StepRunner(record, () => {}, () => {}, () => T0), plan, world } as unknown as AaveGate;
  await stepDepositUsdc(g);
  assert.deepEqual(calls, [{ method: "mint", amount: "760000000" }, { method: "ft_transfer_call", amount: "760000000" }]);
  assert.deepEqual(detail(record, "deposit"), { musdc: "1200000000", held_before: "440000000", added: "760000000" });
  // Once more: nothing is missing, so nothing is sent.
  await stepDepositUsdc(g);
  assert.equal(calls.length, 2);
  assert.deepEqual(detail(record, "deposit"), { musdc: "1200000000", held_before: "1200000000", added: "0" });
});

test("the dry run: every step in words, and what stands in the way of a real run", () => {
  const lines = describeAaveGate({ account: ACCOUNT, owner: "pbf-keeper.testnet", pool: "pool.pbf.testnet", apiUrl: "http://localhost:8788", plan: planFor("small", 76_000), recordFile: "research/data/phase6_funding_aave.json", fundWaitMin: 20, settleWaitMin: 70, settleEverySec: 120 });
  const numbered = lines.map((l) => /^ ?(\d+) (\S+)/.exec(l)).filter((m): m is RegExpExecArray => m !== null).map((m) => m[2]);
  assert.deepEqual(numbered, AAVE_STEP_IDS, "one line for each step, in the order they run");
  assert.deepEqual(Object.keys(AAVE_STEPS), [...AAVE_STEP_IDS]);

  const ready: AaveFound = { account: ACCOUNT, accountExists: false, resuming: false, owner: "pbf-keeper.testnet", ownerNear: 6.85, factoryAave: aaveSettings(CONFIG), evmChainId: 84_532, backend: true, rooms: FULL, gas: { on: true, gas_wallet: GAS_WALLET, balance: "49000000000000000" }, keeper: { ok: true, why: "the keeper ticked 5 s ago and watches demo.pbf.testnet" } };
  const good = aaveProblems(ready);
  assert.deepEqual(good.problems, []);
  assert.ok(good.lines.includes(`the gas wallet ${GAS_WALLET} holds 0.049 ETH`));
  assert.ok(good.lines.some((l) => l.startsWith("collateral: Aave's test market has no room for WBTC now")));

  // Everything that can be wrong, each said in one line.
  const bad = aaveProblems({ ...ready, accountExists: true, ownerNear: 2, factoryAave: null, rooms: null, gas: { on: false, gas_wallet: null, balance: null }, keeper: { ok: false, why: "the keeper's last tick was 900 s ago: is it running?" } });
  assert.deepEqual(bad.problems, [
    "demo.pbf.testnet exists already: a run needs a fresh account, so give another --name (or --from to go on with this one)",
    "the factory's config has no Aave settings (lenders.aave): stage 3's factory isn't live yet, so a new account couldn't use Aave",
    "the backend's GET /api/lenders gave no collateral_room for Aave's test market: is the stage 3 backend running, and does the factory's config have Aave?",
    "the backend's gas helper is off: set EVM_GAS_PRIVATE_KEY in .env and start the backend again",
    "the keeper's last tick was 900 s ago: is it running?",
  ]);
  // The wrapped path needs more in the gas wallet: 0.02 to wrap, the 0.01 it keeps, and a top-up.
  assert.match(aaveProblems({ ...ready, gas: { on: true, gas_wallet: GAS_WALLET, balance: "25000000000000000" } }).problems[0]!, /holds 0\.025 ETH, and this run needs it to hold 0\.0321 ETH \(0\.02 to wrap, 0\.01 it keeps, and a top-up\)/);
  assert.deepEqual(aaveProblems({ ...ready, rooms: OPEN, gas: { on: true, gas_wallet: GAS_WALLET, balance: "25000000000000000" } }).problems, [], "the faucet's WBTC costs the wallet only gas");
  // A run that goes on with its account has had its wrap: the wallet needs its reserve and a top-up, not a second 0.02.
  const resumed = { ...ready, accountExists: true, resuming: true };
  assert.deepEqual(aaveProblems({ ...resumed, gas: { on: true, gas_wallet: GAS_WALLET, balance: "27992340567997860" } }).problems, [], "the first live run, resumed");
  assert.match(aaveProblems({ ...resumed, gas: { on: true, gas_wallet: GAS_WALLET, balance: "9000000000000000" } }).problems[0]!, /holds 0\.009 ETH, and this run needs it to hold 0\.0121 ETH:/);
  assert.match(aaveProblems({ ...ready, ownerNear: 5 }).problems[0]!, /holds 5 NEAR, and a run needs about 6\.6/);
  assert.match(aaveProblems({ ...ready, backend: false }).problems[0]!, /doesn't answer GET \/api\/config/);
  assert.match(aaveProblems({ ...ready, gas: null }).problems[0]!, /no GET \/api\/evm\/gas: it is from before stage 3/);

  // The keeper: a recent tick from a stage 3 keeper that lists the account.
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  const start: LogEvent = { t: at(-60_000), event: "start", msg: "the keeper is starting", evm: "sepolia.base.org (chain 84532)" };
  const tick: LogEvent = { t: at(-10_000), event: "tick", accounts: [ACCOUNT] };
  assert.deepEqual(keeperWatches([start, tick], ACCOUNT, T0), { ok: true, why: `the keeper ticked 10 s ago and watches ${ACCOUNT}`, last_tick_at: at(-10_000) });
  assert.match(keeperWatches([{ ...start, evm: undefined }, tick], ACCOUNT, T0).why, /from before stage 3/);
  assert.match(keeperWatches([start, { ...tick, accounts: [] }], ACCOUNT, T0).why, /doesn't list demo\.pbf\.testnet yet/);
  assert.match(keeperWatches([start, { ...tick, t: at(-300_000) }], ACCOUNT, T0).why, /last tick was 300 s ago/);
  assert.match(keeperWatches([{ ...start, msg: "the keeper is starting in a dry run: it sends nothing" }, tick], ACCOUNT, T0).why, /dry run/);
  assert.match(keeperWatches([], ACCOUNT, T0).why, /no tick yet/);
});

test("the collateral step asks the gas helper for test ETH and the collateral Aave has room for, and the record says which and why", async () => {
  // WBTC's cap is full: 0.02 test ETH is wrapped.
  const full = sim();
  const a = gate(full);
  await stepCollateral(a.gate);
  assert.deepEqual(full.gasAsks, [{ wrap: { amount: "20000000000000000" } }]);
  assert.deepEqual(a.record.context.collateral, { symbol: "WETH", token: WETH, decimals: 18, amount: "20000000000000000", how: "wrap", why: (pickCollateral(FULL) as { why: string }).why, gas_wallet: GAS_WALLET, address: ADDRESS });
  assert.equal(a.record.steps[0]!.pass, true);
  // The cap has room: 0.015 WBTC from the faucet. A resumed run that holds part of it asks for the rest only.
  const open = sim({ rooms: OPEN, wallet: { [WBTC]: 500_000n } });
  const b = gate(open);
  await stepCollateral(b.gate);
  assert.deepEqual(open.gasAsks, [{ mint: { token: WBTC, amount: "1000000" } }]);
  assert.equal((b.record.context.collateral as { symbol: string }).symbol, "WBTC");
  // Room for neither: nothing is asked for, and the step says so.
  const none = sim({ rooms: [FULL[0]!, { ...FULL[1]!, room: "0" }] });
  const c = gate(none);
  assert.match(await stopped(stepCollateral(c.gate), c.record, "collateral"), /room for neither collateral/);
  assert.deepEqual(none.gasAsks, []);
});

test("the Aave gate from the keeper's check to the last transfer: one fund, the keeper's steps, a settlement, and everything repaid, taken back and sent out", async () => {
  // INTERFACES.md 40.1 (the audit's A8): the permission last changed in block 5010. `fund` takes only a check read
  // after that, and the fund step's own check is (block 5020).
  const s = sim({ rooms: OPEN, permissionBlk: 5_010 });
  const at = (ms: number) => new Date(s.now + ms).toISOString();
  s.keeperLog = [{ t: at(-60_000), event: "start", msg: "the keeper is starting", evm: "sepolia.base.org (chain 84532)" }, { t: at(-5_000), event: "tick", accounts: [ACCOUNT] }];
  s.fund = [{ k: "l_supply", l: "aave", tok: WBTC, amt: "1500000" }, { k: "l_borrow", l: "aave", amt: 570_000_000 }, { k: "p_borrow", amt: 400_000_000 }];
  s.preview = { total: 975_000_000, sources: [{ source: "aave", amount: 572_000_000, rate_bp: 74 }, { source: "pool", amount: 403_000_000, rate_bp: 650 }], steps: s.fund, blended_bp: 312, verdict: { ok: true } };
  const { gate: g, record } = gate(s);

  await stepKeeperWatches(g);
  await stepCollateral(g);
  await stepFundAave(g);
  // 0.5% under what the preview can lend, rounded as the other gates round it; the plan is the verdict's three steps.
  const fund = s.calls.find((c) => c.method === "fund")!;
  assert.deepEqual([fund.deposit, s.funding?.steps.map((x) => x.k)], [1n, ["l_supply", "l_borrow", "p_borrow"]]);
  assert.deepEqual([(record.context.funding as { from_aave: string }).from_aave, (record.context.funding as { pool_part: boolean }).pool_part], ["570000000", true]);

  // The keeper's work, while the script waits: the approval, the supply and the borrow, each mined, then our pool's loan.
  let ticks = 0;
  s.between = (x) => {
    ticks += 1;
    if (ticks === 1) mine(x, sign(x, "approve", WBTC, (1n << 256n) - 1n).nonce);
    if (ticks === 2) ((x.funding!.steps[0]!.done = true), mine(x, sign(x, "supply", WBTC, 1_500_000n, null, `${x.funding!.pid}:0`).nonce));
    if (ticks === 3) ((x.funding!.steps[1]!.done = true), mine(x, sign(x, "borrow", USDC, 570_000_000n, null, `${x.funding!.pid}:1`).nonce));
    if (ticks === 4) ((x.funding!.steps[2]!.done = true), (x.poolDebt = 400_000_000n), check(x, { check: {} }));
  };
  await stepFundedAave(g);
  s.between = undefined;
  const funded = detail(record, "funded");
  assert.deepEqual((funded.ext as { d: number }).d, 570_000_000, "the engine's verdict shows the Aave loan");
  assert.deepEqual((funded.transactions as { kind: string; status: string }[]).map((t) => [t.kind, t.status]), [["approve", "mined"], ["supply", "mined"], ["borrow", "mined"]]);
  assert.deepEqual(record.context.loans, { aave_debt_micro: 570_000_000, aave_posted_units: "1500000", pool_debt_micro: "400000000", pool_part: true });

  // A settlement: the pool says "too soon" once, one check is refused (the keeper's own landed first), then it books one.
  s.settles = [{ skipped: "the last settlement was 1 minute ago" }, { fee: "0", subsidy: "12", credit: "0", period_ns: "240000000000" }];
  s.refuseChecks = [s.checks + 2];
  await stepSettleAave(g);
  const tries = detail(record, "settle").tries as { said: string }[];
  assert.deepEqual(tries.map((t) => t.said.split(":")[0]), ["nothing settled", "the check before it didn't hold", "settled"]);
  assert.equal(tries[2]!.said, "settled: the pool's report has $570.00 owed to Aave at 0.74% a year, and a subsidy of 0.000012 USDC was taken off");
  assert.deepEqual(detail(record, "settle").settlement, { fee: "0", subsidy: "12", aave_debt: "570000000", rate_bp: 74, settled_at: s.pricing.settled_at, words: tries[2]!.said });

  // Aave is repaid: the interest's USDC from the faucet, the client's own approval (the keeper hadn't yet), the repayment.
  s.debt += 9_000n; // interest since the borrow
  await stepRepayAave(g);
  const repay = detail(record, "repay_aave");
  assert.deepEqual([repay.owed_micro, repay.sent_micro, repay.owed_after_micro], [570_000_000, "570571000", 0]);
  assert.deepEqual(s.gasAsks.at(-1), { mint: { token: USDC, amount: "1000000" } }, "one mint of 1 test USDC before the repayment");
  assert.equal(s.wallet[USDC], 991_000n, "the borrowed 570 and the faucet's 1, less the 570.009 Aave took");
  assert.equal((repay.verdict as { state: string }).state, "HEALTHY");
  assert.deepEqual(s.calls.filter((c) => c.method === "evm_approve" || c.method === "lender_repay").map((c) => [c.method, c.args, c.deposit]), [
    ["evm_approve", { token: USDC }, 0n],
    ["lender_repay", { lender: "aave", amount: "570571000" }, 1n],
  ]);
  assert.equal(s.debt, 0n);

  // The collateral comes back from Aave and leaves the address for the gas wallet's.
  await stepAaveWithdraw(g);
  assert.deepEqual(s.calls.filter((c) => c.method === "lender_withdraw").map((c) => [c.args, c.deposit]), [[{ lender: "aave", token: WBTC, amount: "1500000" }, 1n]]);
  assert.deepEqual([s.posted[WBTC], s.wallet[WBTC]], [0n, 1_500_000n]);
  await stepEvmOut(g);
  assert.deepEqual(s.out, [{ token: WBTC, amount: "1500000", to: GAS_WALLET }]);
  assert.deepEqual(s.calls.at(-1), { method: "evm_withdraw", args: { token: WBTC, amount: "1500000", to: GAS_WALLET }, deposit: 1n });
  assert.equal(s.wallet[WBTC], 0n);
  // Every transaction the client signed went through the backend's route, in nonce order.
  assert.deepEqual(s.submits, [3, 4, 5, 6]);
  assert.deepEqual(record.steps.map((x) => [x.id, x.pass]), [["keeper", true], ["collateral", true], ["fund", true], ["funded", true], ["settle", true], ["repay_aave", true], ["aave_withdraw", true], ["evm_out", true]]);

  // The collateral isn't taken back while a verdict still shows Aave owed; and a resumed repayment, whose USDC
  // from the faucet is at the address already, asks the faucet for no more.
  const owing = sim({ rooms: OPEN, posted: { [WBTC]: 1_500_000n }, debt: 570_000_000n, wallet: { [USDC]: 571_000_000n }, eth: 2_000_000_000_000_000n });
  check(owing, { check: {} });
  const early = gate(owing);
  assert.equal(await stopped(stepAaveWithdraw(early.gate), early.record, "aave_withdraw"), "the held verdict still shows 570.00 USDC owed to Aave: the repay_aave step comes first");
  assert.equal(owing.calls.length, 0);
  const resumed = gate(owing);
  await stepRepayAave(resumed.gate);
  assert.deepEqual([owing.gasAsks, owing.debt, detail(resumed.record, "repay_aave").faucet], [[], 0n, null]);

  // Run again, the leaving steps find nothing left to do.
  const again = gate(s);
  again.record.context.collateral = record.context.collateral;
  await stepRepayAave(again.gate);
  await stepAaveWithdraw(again.gate);
  await stepEvmOut(again.gate);
  assert.deepEqual(again.record.steps.map((x) => (x.detail as { already?: string }).already), ["the held verdict shows nothing owed to Aave", "Aave's books show nothing posted", "the address holds no WBTC"]);
});

test("the fund step signs nothing unless the loan has a part from Aave; with a pool loan, a settlement that never comes stops the gate", async () => {
  const s = sim({ rooms: OPEN });
  s.fund = [{ k: "p_borrow", amt: 400_000_000 }];
  s.preview = { total: 400_000_000, sources: [{ source: "pool", amount: 400_000_000, rate_bp: 650 }], steps: s.fund, verdict: { ok: true } };
  const poolOnly = gate(s);
  assert.match(await stopped(stepFundAave(poolOnly.gate), poolOnly.record, "fund"), /none from Aave/);
  assert.equal(s.calls.length, 0, "not even the check was paid for");
  // The preview has both parts, but the check a moment later gives the pool's alone: still nothing is signed.
  s.preview = { total: 975_000_000, sources: [{ source: "aave", amount: 572_000_000, rate_bp: 74 }, { source: "pool", amount: 403_000_000, rate_bp: 650 }], steps: [], verdict: { ok: true } };
  const checked = gate(s);
  assert.match(await stopped(stepFundAave(checked.gate), checked.record, "fund"), /has no loan from Aave: nothing was signed/);
  assert.deepEqual(s.calls.map((c) => c.method), ["request_check"]);
  s.preview = null;
  await assert.rejects(stepFundAave(gate(s).gate), /the funding preview failed: HTTP 502 pb-risk did not complete/);

  // With a pool loan, a settlement that never comes stops the step after its time, with what the pool last said.
  const dry = sim();
  const waited = gate(dry, { settleWaitMs: 5 * 60_000 });
  assert.match(await stopped(stepSettleAave(waited.gate), waited.record, "settle"), /booked no settlement in 5 minutes; it last said: nothing settled: the pool's record of the account didn't move/);
});

test("the gate runs on Aave's part alone: no pool part is recorded and not waited for, and a settlement that doesn't come is written down, not failed", async () => {
  // A small book: wrapped test ETH at the address, and the engine lends from Aave only.
  const s = sim();
  s.fund = [{ k: "l_supply", l: "aave", tok: WETH, amt: "20000000000000000" }, { k: "l_borrow", l: "aave", amt: 23_000_000 }];
  s.preview = { total: 23_100_000, sources: [{ source: "aave", amount: 23_100_000, rate_bp: 74 }], steps: s.fund, blended_bp: 74, verdict: { ok: true } };
  const { gate: g, record } = gate(s);
  await stepCollateral(g);
  await stepFundAave(g);
  const fund = detail(record, "fund");
  assert.deepEqual([fund.from_aave, fund.from_pool, fund.pool_part, fund.note], ["23000000", "0", false, "the engine gave Aave's part alone: the run goes on without a pool loan"]);
  assert.deepEqual(s.funding?.steps.map((x) => x.k), ["l_supply", "l_borrow"]);
  assert.equal((record.context.funding as { pool_part: boolean }).pool_part, false);

  // The keeper runs the two steps; our pool lends nothing, and the step passes all the same.
  let ticks = 0;
  s.between = (x) => {
    ticks += 1;
    if (ticks === 1) mine(x, sign(x, "approve", WETH, (1n << 256n) - 1n).nonce);
    if (ticks === 2) ((x.funding!.steps[0]!.done = true), mine(x, sign(x, "supply", WETH, WRAP_WEI).nonce));
    if (ticks === 3) ((x.funding!.steps[1]!.done = true), mine(x, sign(x, "borrow", USDC, 23_000_000n).nonce), check(x, { check: {} }));
  };
  await stepFundedAave(g);
  s.between = undefined;
  const funded = detail(record, "funded");
  assert.deepEqual([funded.pool_part, funded.pool_debt_micro, (funded.ext as { d: number }).d], [false, "0", 23_000_000]);
  assert.deepEqual(record.context.loans, { aave_debt_micro: 23_000_000, aave_posted_units: "20000000000000000", pool_debt_micro: "0", pool_part: false });

  // The settlement: the pool says "too soon", then settle() itself fails, then "too soon" again. Three tries, written down.
  s.settles = [{ skipped: "the last settlement was 1 minute ago" }, new Error("settle failed: the account isn't a borrower of the pool"), { skipped: "nothing to settle" }];
  await stepSettleAave(g);
  const settle = detail(record, "settle");
  assert.equal(settle.settled, false);
  const still = "nothing settled: the pool's record of the account didn't move (it settles at most once in its period)";
  assert.equal(settle.note, `the account has no pool loan, and the pool booked no settlement in 3 tries; it last said: ${still}`);
  assert.deepEqual((settle.tries as { said: string }[]).map((t) => t.said), [still, "settle() didn't go through: settle failed: the account isn't a borrower of the pool", still]);
  // And one that does come is kept as a settlement.
  const lucky = sim({ debt: 23_000_000n });
  const again = gate(lucky);
  again.record.context.funding = { pool_part: false };
  lucky.settles = [{ fee: "3", subsidy: "0", credit: "0", period_ns: "240000000000" }];
  await stepSettleAave(again.gate);
  assert.equal(detail(again.record, "settle").settled, true);
  assert.equal(detail(again.record, "settle").in_words, "settled: the pool's report has $23.00 owed to Aave at 0.74% a year, and a fee of 0.000003 USDC was added");

  // The pool's record decides, not the account's answer: a later settled_at on a report with Aave's loan in it.
  const was: PoolPricing = { fees_charged: "0", subsidy_paid: "0", settled_at: "100", last: [] };
  const leg = { lender: "aave", debt: "23033369", rate_bp: 74, supply_bp: 9 };
  assert.equal(aaveSettlement(was, { ...was, last: [leg] }), null, "the same settled_at: nothing new");
  assert.equal(aaveSettlement(was, { ...was, settled_at: "200", last: [{ ...leg, debt: "0" }] }), null, "nothing owed to Aave in the report");
  assert.equal(aaveSettlement(was, null), null);
  // Pass-through pricing, as on testnet on 11 Nov: the client pays what Aave charges.
  assert.equal(aaveSettlement(was, { ...was, settled_at: "200", last: [leg, { lender: "rhea", debt: "0", rate_bp: 1592, supply_bp: 1016 }] })!.words, "settled: the pool's report has $23.03 owed to Aave at 0.74% a year, and nothing was added or taken off");

  // Leaving is the same: Aave repaid, the wrapped ETH back from Aave and out to the gas wallet's address.
  await stepRepayAave(g);
  await stepAaveWithdraw(g);
  await stepEvmOut(g);
  assert.deepEqual(s.out, [{ token: WETH, amount: "20000000000000000", to: GAS_WALLET }]);
  assert.deepEqual(record.steps.map((x) => [x.id, x.pass]), [["collateral", true], ["fund", true], ["funded", true], ["settle", true], ["repay_aave", true], ["aave_withdraw", true], ["evm_out", true]]);
});
