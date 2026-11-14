// The moves gate (gate 4) against a made-up world: an account contract that answers as the real one does
// (contracts/account/src/lib.rs: withdraw, evm_withdraw, request_check and on_verdict, ft_on_transfer), a backend whose
// routes answer as services/api's do (INTERFACES.md 33 and 36), a stand-in that delivers when it sees a deposit, a
// keeper that runs the funding plan, and an Aave whose books move when a signed transaction is sent. Nothing here
// touches a chain.
import assert from "node:assert/strict";
import { test } from "node:test";

import { aaveSettings } from "./evm.js";
import type { AaveGate } from "./aave-steps.js";
import { planFor, planForCoin, StepFailed, StepRunner, type GateCoin, type RunRecord } from "./hedge-kit.js";
import type { World } from "./hedge-steps.js";
import type { LogEvent } from "./jsonl.js";
import { btcOutUnits, describeMovesGate, ETH_MOVE_UNITS, fitsOneMove, FLOAT_SPEND_LIMIT_WEI, MOVES_CLOSE_OUT, MOVES_FLOAT_NEEDS_WEI, MOVES_GATE, MOVES_PASS_POINT, MOVES_SETUP, MOVES_STEP_IDS, movesPermission, movesPlan, movesProblems, POOL_PART_MICRO, PROBE_NBTC_UNITS, usdcBackUnits, verdictSpent, WBTC_MOVE_UNITS, WETH_AIM_WEI, type MovesFound } from "./moves-kit.js";
import { MOVES_STEPS, stepArrived, stepBtcOut, stepDepositNbtc, stepFloat, stepFundMoves, stepLoanHome, stepUsdcOut } from "./moves-steps.js";
import type { AccountState, VerdictJson } from "./state.js";

const T0 = Date.UTC(2026, 10, 12, 9, 0);
const ACCOUNT = "demo.pbf.testnet";
const OWNER = "pbf-keeper.testnet";
const FACTORY = "pbf.testnet";
const MUSDC = "musdc.pbf-ops.testnet";
const MNBTC = "mnbtc.pbf-ops.testnet";
/** INTERFACES.md 51.2: test ETH on NEAR, for a gate run with --coin ETH. */
const METH = "meth.pbf-ops.testnet";
const AAVE_POOL = "0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27";
const USDC = "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f";
const WBTC = "0x54114591963cf60ef3aa63befd6ec263d98145a4";
const WETH = "0x4200000000000000000000000000000000000006";
/** The gas wallet, which is the stand-in's float on Base Sepolia. */
const FLOAT = "0x2031181d63507368232579af4c64a1c3428407ff";
const ADDRESS = `0x${"ac".repeat(20)}`;
const CONFIG = {
  gateway: { project_id: "pbf-keeper.testnet/pb-gateway", version_key: "9a7e", secrets_ref: null },
  risk: { project_id: "pbf-keeper.testnet/pb-risk", version_key: "4c1d" },
  lenders: { aave: { chain_id: 84_532, pool: AAVE_POOL, usdc: { symbol: "USDC", address: USDC, decimals: 6 }, collateral: [{ symbol: "WBTC", address: WBTC, decimals: 8 }, { symbol: "WETH", address: WETH, decimals: 18 }], max_fee_per_gas: "1000000000" } },
};
const TOKENS = [{ token: USDC, symbol: "USDC", decimals: 6 }, { token: WBTC, symbol: "WBTC", decimals: 8 }, { token: WETH, symbol: "WETH", decimals: 18 }];
const NO_ROOM = "Aave's test market has no room for 0.00054535 WBTC now, so the bitcoin arrives as wrapped test ETH of the same dollar value";

/**
 * The stand-in's prices, shaped as 1Click's were on 12 Nov (BTC $74,446, ETH $2,070.62): a price and a small fixed
 * cost. 0.0002 nBTC brings 0.0071513 WETH.
 */
const WEI_PER_UNIT = 359_500_000_000n;
const FIXED_WEI = 38_700_000_000_000n;
const wethFor = (units: bigint) => units * WEI_PER_UNIT - FIXED_WEI;
const nbtcFor = (wei: bigint) => ((wei / WEI_PER_UNIT) * 997n) / 1_000n;

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

interface Transfer {
  id: string;
  kind: string;
  token: string;
  amount: string;
  dep: string;
  deadline: string;
}

interface Quote {
  move: "to_evm" | "e_home";
  token: string;
  amountIn: bigint;
  delivers: { token: string; symbol: string; chain: string; amount: string };
  depositAddress: string;
  memo: string | null;
  transfer: string;
  status: string;
  hash: string | null;
}

interface Sim {
  now: number;
  blk: number;
  // ---- the account on NEAR ----
  exists: boolean;
  permission: unknown;
  address: string | null;
  counter: number;
  verdict: VerdictJson | null;
  intent: Record<string, unknown> | null;
  received: number;
  funding: { pid: string; steps: { k: string; l?: string; tok?: string; amt: string | number; done: boolean }[] } | null;
  pending: Transfer[];
  nextMove: number;
  poolDebt: bigint;
  /** Token balances on NEAR: token, then holder. */
  near: Record<string, Record<string, bigint>>;
  // ---- the account on Aave's chain ----
  signed: Signed[];
  /** The nonces of signed borrows, withdrawals and transfers the account lists as under way. */
  listed: number[];
  chainNonce: number;
  eth: bigint;
  wallet: Record<string, bigint>;
  posted: Record<string, bigint>;
  debt: bigint;
  /** Transfers out of the address that the chain has mined. */
  out: { token: string; amount: string; to: string; used: boolean }[];
  // ---- the stand-in and its float ----
  floatEth: bigint;
  quotes: Quote[];
  /** Aave has room for WBTC: the bitcoin arrives as WBTC. A number is the room, in WBTC's units: a move that brings more arrives as WETH. */
  wbtcRoom: boolean | bigint;
  standInOff: boolean;
  /** Aave's chain mines nothing that is sent. */
  stuck: boolean;
  floatShort: boolean;
  // ---- the engine ----
  fund: unknown[];
  preview: unknown;
  /** Checks, by their number, that bring no verdict: Aave's chain couldn't be read. */
  noVerdict: number[];
  /** The verdict allows no withdrawal: no room on the credit line. */
  noRoom: boolean;
  checks: number;
  // ---- what the gate did ----
  calls: { method: string; args: Record<string, unknown>; deposit: bigint }[];
  quoteAsks: Record<string, unknown>[];
  gasAsks: unknown[];
  submits: number[];
  /** The keeper runs the funding plan while the gate waits; a test may switch it off. */
  keeperOff: boolean;
  /**
   * The account's rules since the audit fixes of 12 Nov (INTERFACES.md 40.1): the block the permission last changed
   * in (set at the account's making when a permission comes with it), and the most Ethereum transactions listed at once.
   */
  permissionBlk: number;
  mostListed: number;
  /** The gas the gate attached to create_account, in TGas. */
  createTgas: number | null;
  /** INTERFACES.md 51.2: the most WETH the stand-in brings in one move today, when it is under its 0.02. */
  ethCapWei?: bigint;
}

/** A 1Click quote lives a day at most: the account records no move whose `exp` is further ahead (INTERFACES.md 40.1). */
const MAX_QUOTE_LIFE_MS = 24 * 60 * 60_000;
/** The account lists at most this many borrows, withdrawals and transfers on Aave's chain at once. */
const MAX_AAVE_LISTINGS = 8;

function sim(overrides: Partial<Sim> = {}): Sim {
  return {
    now: T0, blk: 5_000, exists: false, permission: null, address: null, counter: 3, verdict: null, intent: null, received: 0, funding: null, pending: [], nextMove: 0, poolDebt: 0n,
    near: { [MUSDC]: {}, [MNBTC]: {} }, signed: [], listed: [], chainNonce: 0, eth: 0n, wallet: {}, posted: {}, debt: 0n, out: [], floatEth: 48_000_000_000_000_000n, quotes: [], wbtcRoom: false,
    standInOff: false, stuck: false, floatShort: false, fund: [], preview: null, noVerdict: [], noRoom: false, checks: 0, calls: [], quoteAsks: [], gasAsks: [], submits: [], keeperOff: false, permissionBlk: 0, mostListed: 0, createTgas: null, ...overrides,
  };
}

/** An account that exists already, with its address, for the tests that start in the middle. */
const opened = (overrides: Partial<Sim> = {}) => sim({ exists: true, permission: movesPermission(), permissionBlk: 4_990, address: ADDRESS, eth: 2_000_000_000_000_000n, ...overrides });

/** The account lists a signed borrow, withdrawal or transfer on Aave's chain, eight at most. */
function list(s: Sim, nonce: number) {
  s.listed.push(nonce);
  s.mostListed = Math.max(s.mostListed, s.listed.length);
}
const LISTED_FULL = `${MAX_AAVE_LISTINGS} Ethereum transactions are listed already: send them, then ask for a check`;

const balance = (s: Sim, token: string, holder: string) => s.near[token]?.[holder] ?? 0n;
const credit = (s: Sim, token: string, holder: string, by: bigint) => ((s.near[token] ??= {})[holder] = balance(s, token, holder) + by);
const add = (book: Record<string, bigint>, token: string, by: bigint) => (book[token] = (book[token] ?? 0n) + by);

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
  if (e.kind === "supply") (add(s.wallet, e.token, -amount), add(s.posted, e.token, amount));
  if (e.kind === "borrow") ((s.debt += amount), add(s.wallet, USDC, amount));
  if (e.kind === "repay") {
    const paid = amount < s.debt ? amount : s.debt; // Aave takes only what is owed
    s.debt -= paid;
    add(s.wallet, USDC, -paid);
  }
  if (e.kind === "withdraw") (add(s.posted, e.token, -amount), add(s.wallet, e.token, amount));
  if (e.kind === "transfer") (add(s.wallet, e.token, -amount), s.out.push({ token: e.token, amount: e.amount, to: e.to ?? "", used: false }));
  s.chainNonce = nonce + 1;
}

const ext = (s: Sim) => {
  const collateral = Object.values(s.posted).some((v) => v > 0n) ? 40_500_000 : 0;
  return collateral || s.debt ? [{ l: "aave", c: collateral, d: Number(s.debt), hf_bp: s.debt ? 15_000 : 0, r_bp: 74, s_bp: 9, room: 0, liq_bp: 8_300 }] : [];
};

/**
 * OutLayer's answer reaches the account (on_verdict, accept): the verdict is kept with its intent; every transfer it
 * names in `arrived` is settled; and if it shows that Aave's chain has used a listed transaction's nonce, the listing
 * is dropped and the counter moves on, so this verdict itself backs nothing.
 */
function accept(s: Sim, intent: Record<string, unknown>): VerdictJson {
  s.blk += 20;
  // The engine: a move to Aave's chain has arrived once the address holds what it was to bring.
  const arrived = s.pending.filter((t) => t.kind === "to_evm" && s.quotes.find((q) => q.depositAddress === t.dep)?.status === "SUCCESS").map((t) => t.id);
  const asked = (intent.withdraw ?? intent.evm_withdraw) as { amount?: string } | undefined;
  const v = { ok: true, state: "HEALTHY", action: "NONE", blk: s.blk, nonce: s.counter, ext: ext(s), evm: { nonce: s.chainNonce }, arrived, allow: { borrow: 0, withdraw: asked && !s.noRoom ? Number(asked.amount) : 0 }, ...("fund" in intent ? { fund: s.fund } : {}) } as unknown as VerdictJson;
  s.pending = s.pending.filter((t) => !arrived.includes(t.id));
  s.verdict = v;
  s.intent = intent;
  s.received = s.blk + 2;
  if (s.listed.some((n) => n < s.chainNonce)) {
    s.listed = s.listed.filter((n) => n >= s.chainNonce);
    s.counter += 1;
  }
  return v;
}

/** The stand-in, each time it looks: a deposit it finds is delivered from its float. */
function standIn(s: Sim) {
  if (s.standInOff) return;
  for (const q of s.quotes.filter((x) => x.status === "PENDING_DEPOSIT")) {
    if (q.move === "to_evm") {
      if (balance(s, q.token, q.depositAddress) < q.amountIn) continue;
      add(s.wallet, q.delivers.token, BigInt(q.delivers.amount));
      // WETH is wrapped from the float's own test ETH.
      if (q.delivers.token === WETH) s.floatEth -= BigInt(q.delivers.amount);
      s.floatEth -= 20_000_000_000_000n;
    } else {
      const paid = s.out.find((o) => !o.used && o.to === FLOAT && o.token === q.token && o.amount === q.amountIn.toString());
      if (!paid) continue;
      paid.used = true;
      // Delivered on NEAR with the transfer's msg: ft_on_transfer settles the move it names.
      credit(s, q.delivers.token, ACCOUNT, BigInt(q.delivers.amount));
      s.pending = s.pending.filter((t) => t.id !== q.transfer);
      // WETH that comes back is unwrapped: the float's test ETH goes round.
      if (q.token === WETH) s.floatEth += q.amountIn - 10_000_000_000_000n;
    }
    q.status = "SUCCESS";
    q.hash = `D${s.quotes.indexOf(q)}`;
  }
}

/** The keeper, each tick: the next step of the funding plan, then a check once the borrow is mined. */
function keeper(s: Sim) {
  const f = s.funding;
  const next = f?.steps.find((x) => !x.done);
  if (s.keeperOff || !f || !next) return;
  if (next.k === "l_supply") {
    if (!s.signed.some((e) => e.kind === "approve" && e.token === next.tok)) return mine(s, sign(s, "approve", next.tok!, (1n << 256n) - 1n).nonce);
    next.done = true;
    mine(s, sign(s, "supply", next.tok!, String(next.amt), null, `${f.pid}:0`).nonce);
  } else if (next.k === "l_borrow") {
    next.done = true;
    const e = sign(s, "borrow", USDC, String(next.amt), null, `${f.pid}:1`);
    list(s, e.nonce);
    mine(s, e.nonce);
  } else if (next.k === "p_borrow") {
    next.done = true;
    s.poolDebt += BigInt(next.amt);
    credit(s, MUSDC, ACCOUNT, BigInt(next.amt));
  }
  if (f.steps.every((x) => x.done)) accept(s, { check: {} });
}

/** POST /api/quote for a move, as the backend and the stand-in answer together (hl-handlers.ts; evm-routes.ts). */
function quote(s: Sim, body: { dry: boolean; move: "to_evm" | "e_home"; token: string; amount: string; to?: string }) {
  s.quoteAsks.push(body);
  const amount = BigInt(body.amount);
  const base = (t: (typeof TOKENS)[number], out: bigint) => ({ token: t.token, symbol: t.symbol, chain: "Base Sepolia", amount: out.toString() });
  let delivers: Quote["delivers"];
  let note: string | null = null;
  if (body.move === "to_evm" && body.token === MNBTC) {
    const asWbtc = (amount * 9_978n) / 10_000n;
    if (s.wbtcRoom === true || (typeof s.wbtcRoom === "bigint" && asWbtc <= s.wbtcRoom)) delivers = base(TOKENS[1]!, asWbtc);
    else {
      const out = wethFor(amount);
      const most = (amount * 20_000_000_000_000_000n) / out;
      // The stand-in's refusal (evm-routes.ts, fillProblem), as the backend passes 1Click's errors on (server.ts).
      const refusal = (words: string) => ({ status: 400, body: { error: "oneclick", message: `1Click /v0/quote answered HTTP 400: ${words}` } });
      if (out > 20_000_000_000_000_000n) return refusal(`This would arrive as ${Number(out) / 1e18} WETH, and the stand-in brings at most 0.02 WETH in one move: its float has little test ETH. Send at most ${Number(most) / 1e8} nBTC (${most} units)`);
      if (s.floatShort) return refusal(`The stand-in's float holds 0.004 test ETH and 0 WETH: it can't wrap ${Number(out) / 1e18} more and keep 0.003 for gas. Ask for less, or send the float (${FLOAT}) test ETH on Base Sepolia`);
      delivers = base(TOKENS[2]!, out);
      note = NO_ROOM;
    }
  } else if (body.move === "to_evm" && body.token === METH) {
    // INTERFACES.md 51.2: test ETH arrives as WETH (1Click priced 0.02 ETH to Base at 0.0199954 on 14 Nov). Past
    // 0.02 WETH the backend answers the stand-in's refusal as 400 move_too_large, in the stand-in's own words.
    const out = (amount * 99_977n) / 100_000n;
    const most = (amount * 20_000_000_000_000_000n) / out;
    if (out > 20_000_000_000_000_000n || (s.ethCapWei !== undefined && out > s.ethCapWei)) {
      const cap = s.ethCapWei ?? 20_000_000_000_000_000n;
      return { status: 400, body: { error: "move_too_large", message: `This would arrive as ${Number(out) / 1e18} WETH, and the stand-in brings at most ${Number(cap) / 1e18} WETH in one move: its float has little test ETH. Send at most ${Number((amount * cap) / out) / 1e18} ETH (${(amount * cap) / out} units)` } };
    }
    void most;
    delivers = base(TOKENS[2]!, out);
  } else if (body.move === "to_evm") delivers = base(TOKENS[0]!, (amount * 9_997n) / 10_000n);
  else if (body.token === USDC) delivers = { token: MUSDC, symbol: "USDC", chain: "NEAR", amount: ((amount * 9_999n) / 10_000n).toString() };
  // INTERFACES.md 51.2: with `to` naming test ETH, WETH comes home as test ETH; else collateral comes home as nBTC.
  else if (body.token === WETH && body.to === METH) delivers = { token: METH, symbol: "ETH", chain: "NEAR", amount: ((amount * 99_970n) / 100_000n).toString() };
  else delivers = { token: MNBTC, symbol: "nBTC", chain: "NEAR", amount: (body.token === WETH ? nbtcFor(amount) : (amount * 9_976n) / 10_000n).toString() };

  // While the account owes our pool, taking a token out needs a verdict for exactly that.
  const needs_check = s.poolDebt === 0n ? null : body.move === "to_evm" ? { withdraw: { token: body.token, amount: body.amount } } : { evm_withdraw: { token: body.token, amount: body.amount } };
  const shim = note ? { shim: { asked: `1cs_v1:base-sepolia:erc20:${WBTC}`, delivers: `1cs_v1:base-sepolia:erc20:${WETH}`, symbol: "WETH", why: note } } : {};
  const move = { kind: body.move, account: ACCOUNT, hl_address: ADDRESS, delivers, needs_check };
  if (body.dry) return { status: 200, body: { quote: { amountIn: body.amount, amountOut: delivers.amount }, ...shim, move: { ...move, next: null, transfer_id: null, exp_ms: null } } };

  const n = s.quotes.length;
  const transfer = `move:${s.nextMove}`;
  const exp = s.now + 600_000;
  // A deposit on NEAR gets an address of its own; one on Aave's chain goes to the float, told apart by its memo.
  const depositAddress = body.move === "to_evm" ? String(n + 1).padStart(64, "d") : FLOAT;
  const memo = body.move === "to_evm" ? null : `memo-${n}`;
  s.quotes.push({ move: body.move, token: body.token, amountIn: amount, delivers, depositAddress, memo, transfer, status: "PENDING_DEPOSIT", hash: null });
  const next = body.move === "to_evm" ? { method: "withdraw", args: { token: body.token, amount: body.amount, receiver: depositAddress, transfer: { kind: "to_evm", exp } } } : { method: "evm_withdraw", args: { token: body.token, amount: body.amount, to: depositAddress, exp } };
  return { status: 200, body: { quote: { amountIn: body.amount, amountOut: delivers.amount, depositAddress, depositMemo: memo }, ...shim, move: { ...move, next, transfer_id: transfer, exp_ms: exp } } };
}

function gate(s: Sim, options: Partial<AaveGate["options"]> = {}, record: RunRecord = { context: {}, steps: [] }, coin?: GateCoin) {
  const held = (book: Record<string, bigint>, all: boolean) => TOKENS.map((t) => ({ ...t, amount: (book[t.token] ?? 0n).toString() })).filter((t) => all || t.amount !== "0");
  const tx = (label: string, result?: unknown) => ({ label, hash: `N${s.calls.length}`, ok: true, gas_tgas: 20, seconds: 2, logs: [], ...(result !== undefined ? { result } : {}) });
  const refused = (label: string, failure: string) => ({ label, hash: `N${s.calls.length}`, ok: false, failure, gas_tgas: 3, seconds: 1, logs: [] });
  /** What a call that had a transaction signed answers: the entry, as get_state().evm.signed shows it (EvmSignedView). */
  const view = (e: Signed) => ({ ...e, signed_at: (BigInt(s.now) * 1_000_000n).toString() });
  /** What the account asks of a held verdict before a withdrawal with a loan open, in its own words. */
  const verdictProblem = (what: string, noun: string, intent: Record<string, unknown>, amount: string): string | null => {
    if (s.poolDebt === 0n) return null;
    if (s.listed.length) return `no ${what} until a check shows Ethereum transaction ${s.listed[0]} mined: a transfer at aave is still under way`;
    if (!s.verdict) return "no verdict: ask for a check first";
    if (s.verdict.nonce !== s.counter) return "the verdict was already used: ask for a new check";
    if (JSON.stringify(s.intent) !== JSON.stringify(intent)) return `with a loan open, ${noun} needs a verdict for this token and amount`;
    if (!((s.verdict.allow?.withdraw ?? 0) >= Number(amount))) return "the verdict doesn't allow this withdrawal";
    return null;
  };
  const world = {
    account: ACCOUNT,
    owner: OWNER,
    ids: { factory: FACTORY, pool: "pool.pbf.testnet", musdc: MUSDC, mnbtc: MNBTC, mpc: "v1.signer-prod.testnet", hlFloat: "0x" },
    near: {
      exists: async () => s.exists,
      finalBlockMs: async () => s.now,
      call: async (contract: string, method: string, args: Record<string, unknown>, o: { tgas: number; deposit: bigint; label: string }) => {
        s.calls.push({ method, args, deposit: o.deposit });
        const amount = BigInt(typeof args.amount === "string" ? args.amount : "0");
        switch (method) {
          case "create_account":
            // The factory, since the audit's F2: its callback's calls need 180 TGas with today's 2 tokens.
            s.createTgas = o.tgas;
            if (o.tgas < 180) return refused(o.label, "attach at least 180 TGas: 300 TGas is the safe amount");
            s.exists = true;
            s.permission = args.permission ?? null;
            // `new` records the block when a permission comes with it; 0 if none was ever set.
            s.permissionBlk = args.permission ? s.blk : 0;
            return tx(o.label);
          case "mint":
            credit(s, contract, String(args.account_id), amount);
            return tx(o.label);
          case "ft_transfer_call":
            if (balance(s, contract, OWNER) < amount) return refused(o.label, "The account doesn't have enough balance");
            credit(s, contract, OWNER, -amount);
            credit(s, contract, String(args.receiver_id), amount);
            return tx(o.label, amount.toString());
          case "hl_init":
            s.address = ADDRESS;
            return tx(o.label, ADDRESS);
          case "request_check": {
            s.checks += 1;
            // No verdict at all: the account's on_verdict answers that OutLayer's call failed, and keeps nothing.
            if (s.noVerdict.includes(s.checks)) return tx(o.label, { accepted: false, reason: "OutLayer's call failed" });
            accept(s, args.intent as Record<string, unknown>);
            return tx(o.label, { accepted: true, reason: null });
          }
          case "fund":
            // A check read before the permission last changed backs no fund (the audit's A8).
            if (!s.verdict) return refused(o.label, "no verdict: ask for a check first");
            if (s.verdict.blk <= s.permissionBlk) return refused(o.label, `the check was read before the permission last changed (block ${s.permissionBlk}): ask for a new check`);
            s.funding = { pid: `f${s.blk}`, steps: (s.fund as { k: string; amt: number }[]).map((f) => ({ ...f, done: false })) };
            s.counter += 1;
            return tx(o.label);
          case "withdraw": {
            const token = String(args.token);
            const move = args.transfer as { kind: string; exp: number } | undefined;
            if (o.deposit !== 1n) return refused(o.label, "Requires attached deposit of exactly 1 yoctoNEAR");
            if (move?.kind === "to_evm" && !s.address) return refused(o.label, "no Ethereum address yet: call hl_init first");
            if (move && !(move.exp > s.now)) return refused(o.label, "exp must be the quote's expiry, in the future, in unix ms");
            if (move && move.exp - s.now > MAX_QUOTE_LIFE_MS) return refused(o.label, "exp is more than 24 hours ahead: a 1Click quote lives a day at most");
            const problem = verdictProblem("withdrawal with a loan open", "a withdrawal", { withdraw: { token, amount: String(args.amount) } }, String(args.amount));
            if (problem) return refused(o.label, problem);
            s.counter += 1;
            // on_sent: the counter moves on again; if the tokens didn't go out, the move is dropped and the answer is false.
            s.counter += 1;
            if (balance(s, token, ACCOUNT) < amount) return { ...tx(o.label, false), logs: move ? [`transfer move:${s.nextMove} didn't go out: nothing was sent`] : [] };
            if (move) s.pending.push({ id: `move:${s.nextMove++}`, kind: move.kind, token, amount: String(args.amount), dep: String(args.receiver), deadline: (BigInt(move.exp) * 1_000_000n).toString() });
            credit(s, token, ACCOUNT, -amount);
            credit(s, token, String(args.receiver), amount);
            return tx(o.label, true);
          }
          case "evm_withdraw": {
            const token = String(args.token).toLowerCase();
            if (o.deposit !== 1n) return refused(o.label, "Requires attached deposit of exactly 1 yoctoNEAR");
            const problem = verdictProblem("Ethereum withdrawal with a loan open", "an Ethereum withdrawal", { evm_withdraw: { token, amount: String(args.amount) } }, String(args.amount));
            if (problem) return refused(o.label, problem);
            const exp = args.exp as number | undefined;
            if (exp !== undefined && !(exp > s.now)) return refused(o.label, "exp must be the quote's expiry, in the future, in unix ms");
            if (exp !== undefined && exp - s.now > MAX_QUOTE_LIFE_MS) return refused(o.label, "exp is more than 24 hours ahead: a 1Click quote lives a day at most");
            if (s.listed.length >= MAX_AAVE_LISTINGS) return refused(o.label, LISTED_FULL);
            const e = sign(s, "transfer", token, String(args.amount), String(args.to));
            s.counter += 1;
            list(s, e.nonce);
            // With `exp` the move is recorded: `USDC` for the Aave settings' USDC, the token's address for collateral.
            if (exp !== undefined) s.pending.push({ id: `move:${s.nextMove++}`, kind: "e_home", token: token === USDC ? "USDC" : token, amount: String(args.amount), dep: String(args.to).toLowerCase(), deadline: (BigInt(exp) * 1_000_000n).toString() });
            return tx(o.label, view(e));
          }
          case "evm_approve":
            return tx(o.label, view(sign(s, "approve", String(args.token), (1n << 256n) - 1n)));
          case "lender_repay":
            return tx(o.label, view(sign(s, "repay", USDC, String(args.amount))));
          case "lender_withdraw": {
            if (s.listed.length >= MAX_AAVE_LISTINGS) return refused(o.label, LISTED_FULL);
            const e = sign(s, "withdraw", String(args.token), String(args.amount));
            s.counter += 1;
            list(s, e.nonce);
            return tx(o.label, view(e));
          }
          case "repay": {
            // The pool takes at most the debt, and the rest stays in the account.
            const used = amount < s.poolDebt ? amount : s.poolDebt;
            if (balance(s, MUSDC, ACCOUNT) < amount) return tx(o.label, "0");
            credit(s, MUSDC, ACCOUNT, -used);
            s.poolDebt -= used;
            return tx(o.label, used.toString());
          }
          default:
            throw new Error(`unexpected call ${method}`);
        }
      },
      view: async (contract: string, method: string, args: { account_id?: string } = {}) => {
        if (method === "get_state") {
          const state = {
            owner: OWNER,
            counter: s.counter,
            permission: s.permission,
            loan: { principal: s.poolDebt.toString(), open: s.poolDebt > 0n },
            verdict: s.verdict ? { intent: s.intent, received_block: s.received, verdict: s.verdict } : null,
            pending: s.pending.map((transfer) => ({ transfer })),
            next_move: s.nextMove,
            permission_blk: s.permissionBlk,
            hl: { path: "hyperliquid-1", address: s.address },
            funding: s.funding ? { ...s.funding, amount: "1", stored_at: String(BigInt(T0) * 1_000_000n), expires_at: String(BigInt(T0 + 1_800_000) * 1_000_000n) } : null,
            evm: { nonce: s.signed.length, signed: s.signed },
          };
          return structuredClone(state) as unknown as AccountState;
        }
        if (method === "get_config") return CONFIG;
        if (method === "ft_balance_of") return balance(s, contract, args.account_id!).toString();
        if (method === "debt_of") return s.poolDebt.toString();
        throw new Error(`unexpected view ${method}`);
      },
    },
    api: {
      get: async (path: string) => {
        if (path === "/api/evm/gas") return { status: 200, body: { on: true, gas_wallet: FLOAT, balance: s.floatEth.toString() } };
        if (path.startsWith("/api/status?")) {
          const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));
          const q = s.quotes.find((x) => x.depositAddress === query.get("depositAddress") && (x.memo ?? null) === query.get("depositMemo"));
          if (!q) return { status: 404, body: { message: "No swap for that deposit address" } };
          return { status: 200, body: { status: q.status, swapDetails: { destinationChainTxHashes: q.hash ? [{ hash: q.hash }] : [] } } };
        }
        if (path !== `/api/lender/${ACCOUNT}`) throw new Error(`unexpected GET ${path}`);
        const lenders = ext(s).map((e) => ({ l: "aave", posted: e.c, debt: e.d, hf_bp: e.hf_bp, held: held(s.posted, false) }));
        const signed = s.signed.map((e) => ({ nonce: e.nonce, kind: e.kind, token: e.token, amount: e.amount, hash: e.hash, status: e.nonce < s.chainNonce ? "mined" : "signed" }));
        return { status: 200, body: { lenders, evm: s.address ? { address: s.address, nonce: s.signed.length, chain_nonce: s.chainNonce, eth: s.eth.toString(), wallet: held(s.wallet, true), posted: held(s.posted, false), signed, chain_error: null } : null } };
      },
      post: async (path: string, body: { nonce?: number; mint?: { token: string; amount: string }; dry?: boolean; move?: "to_evm" | "e_home"; token?: string; amount?: string; to?: string }) => {
        if (path === "/api/quote") return quote(s, { dry: body.dry!, move: body.move!, token: body.token!, amount: body.amount!, ...(body.to !== undefined ? { to: body.to } : {}) });
        if (path === "/api/funding-plan") return s.preview ? { status: 200, body: s.preview } : { status: 502, body: { message: "pb-risk did not complete" } };
        if (path === "/api/evm/submit") {
          s.submits.push(body.nonce!);
          if (!s.stuck) mine(s, body.nonce!);
          return { status: 200, body: { status: "sent" } };
        }
        if (path !== "/api/evm/gas") throw new Error(`unexpected POST ${path}`);
        s.gasAsks.push(Object.fromEntries(Object.entries(body).filter(([k]) => k !== "account")));
        // The helper tops an address under 0.001 test ETH up to 0.002, from the gas wallet: the float's own test ETH.
        if (s.eth < 1_000_000_000_000_000n) {
          s.floatEth -= 2_000_000_000_000_000n - s.eth + 10_000_000_000_000n;
          s.eth = 2_000_000_000_000_000n;
        }
        if (body.mint) add(s.wallet, body.mint.token, BigInt(body.mint.amount));
        return { status: 200, body: { address: s.address, gas_wallet: FLOAT } };
      },
    },
    sleep: async (ms: number) => {
      s.now += ms;
      standIn(s);
      keeper(s);
    },
    now: () => s.now,
    log: () => {},
    ...(coin ? { coin } : {}),
  } as unknown as World;
  const at = (ms: number) => new Date(s.now + ms).toISOString();
  const keeperLog = (): LogEvent[] => [{ t: at(-60_000), event: "start", msg: "the keeper is starting", evm: "sepolia.base.org (chain 84532)" }, { t: at(-5_000), event: "tick", accounts: [ACCOUNT] }];
  const g: AaveGate = {
    runner: new StepRunner(record, () => {}, () => {}, () => s.now),
    plan: movesPlan(coin ? planForCoin("small", 74_446, coin, 1_890.1) : planFor("small", 74_446)),
    world,
    name: "demo",
    permission: movesPermission(),
    keeperLog,
    options: { askMicro: 2_000_000_000n, poolCapMicro: POOL_PART_MICRO, fundWaitMs: 20 * 60_000, settleWaitMs: 0, settleEveryMs: 0, ...options },
  };
  return { gate: g, record };
}

const detail = (record: RunRecord, id: string) => record.steps.find((x) => x.id === id)!.detail as Record<string, unknown>;
/** Runs a step that is expected to stop the gate, and answers what its record says: its `why`, or the error it threw. */
async function stopped(run: Promise<void>, record: RunRecord, id: string): Promise<string> {
  await assert.rejects(run, (e: unknown) => e instanceof StepFailed);
  return String(detail(record, id).why ?? detail(record, id).error);
}
const methods = (s: Sim) => s.calls.map((c) => c.method);

test("the moves gate's sizes: 0.02 nBTC or more, a probe that says what arrives, 0.0195 WETH at most, about $100 from our pool, and USDC back with a little over", () => {
  // The book: 0.02 test nBTC, worth well over the $1,000 the engine lends nothing under; more when bitcoin is cheap.
  const plan = movesPlan(planFor("small", 74_446));
  assert.deepEqual([plan.deposit_nbtc_units, plan.deposit_usdc_micro], ["2000000", "0"]);
  assert.equal(movesPlan(planFor("small", 50_000)).deposit_nbtc_units, "2600000", "$1,300 of bitcoin at $50,000");
  // Aave alone: this account's nBTC on NEAR is something Rhea would lend against too.
  assert.deepEqual(movesPermission(), { lenders: ["aave"], min_hf_bp: 15_000, max_rate_bp: 2_500, moves: "any" });

  // The probe arrives as WETH: the gate sends what brings 0.0195, under the stand-in's 0.02 a move.
  const probe = { symbol: "WETH", amount: wethFor(PROBE_NBTC_UNITS).toString() };
  assert.deepEqual([PROBE_NBTC_UNITS, probe.amount, WETH_AIM_WEI], [20_000n, "7151300000000000", 19_500_000_000_000_000n]);
  const units = btcOutUnits(probe);
  assert.equal(units, 54_535n);
  assert.ok(wethFor(units) < 20_000_000_000_000_000n && wethFor(units) > 19_500_000_000_000_000n, "a fixed cost in the price makes it a little over the aim, and still under the limit");
  // It arrives as WBTC (Aave has room): 0.015 nBTC, as gate 3 posted.
  assert.deepEqual([btcOutUnits({ symbol: "WBTC", amount: "19956" }), WBTC_MOVE_UNITS], [1_500_000n, 1_500_000n]);
  assert.throws(() => btcOutUnits({ symbol: "WETH", amount: "0" }), /would deliver nothing/);
  // The stand-in's refusal of too much WETH names the most nBTC that fits: the gate sends 2.5% under it.
  assert.equal(fitsOneMove("the quote was refused (HTTP 400): 1Click /v0/quote answered HTTP 400: This would arrive as 0.5392113 WETH, and the stand-in brings at most 0.02 WETH in one move: its float has little test ETH. Send at most 0.00055636 nBTC (55636 units)"), 54_245n);
  assert.equal(fitsOneMove("The stand-in's Base Sepolia float is off: set EVM_GAS_PRIVATE_KEY (the gas wallet is the float there)"), null);

  // Our pool's part: while it is owed, a move needs room on the credit line, so the gate asks it for about $100.
  assert.equal(POOL_PART_MICRO, 100_000_000n);
  // USDC back to repay Aave: the debt, and the larger of 1% and 1 USDC.
  assert.deepEqual([usdcBackUnits(23_033_364n), usdcBackUnits(570_000_000n)], [24_033_364n, 575_700_000n]);
  // The float: 0.02 to wrap, 0.003 it keeps, a top-up and fees; and what a run may leave it down by.
  assert.deepEqual([MOVES_FLOAT_NEEDS_WEI, FLOAT_SPEND_LIMIT_WEI], [25_200_000_000_000_000n, 7_000_000_000_000_000n]);

  // The account's own words for a verdict that can't back a call (contracts/account/src/lib.rs): a new check, then again.
  for (const words of [
    "withdraw (usdc_out) failed: the verdict was already used: ask for a new check (tx N4)",
    "no withdrawal with a loan open until a check shows Ethereum transaction 3 mined: a transfer at aave is still under way",
    "with a loan open, an Ethereum withdrawal needs a verdict for this token and amount",
    "the verdict is 131 blocks old, above the 120-block limit",
    "no verdict: ask for a check first",
  ]) assert.equal(verdictSpent(words), true, words);
  for (const words of ["the verdict doesn't allow this withdrawal", "the verdict's state isn't HEALTHY", "no withdrawal with a loan open while transfer move:2 is overdue: its deadline was 2026-11-12 09:10:00 UTC", "exp must be the quote's expiry, in the future, in unix ms"]) {
    assert.equal(verdictSpent(words), false, words);
  }
});

test("the moves gate's dry run: every step in words, and what stands in the way of a real run", () => {
  const lines = describeMovesGate({ account: ACCOUNT, owner: OWNER, pool: "pool.pbf.testnet", apiUrl: "http://localhost:8788", shimUrl: "http://localhost:8787", plan: movesPlan(planFor("small", 74_446)), recordFile: "research/data/phase6_funding_moves.json", fundWaitMin: 20 });
  const numbered = lines.map((l) => /^ ?(\d+) (\S+)/.exec(l)).filter((m): m is RegExpExecArray => m !== null).map((m) => m[2]);
  assert.deepEqual(numbered, MOVES_STEP_IDS, "one line for each step, in the order they run");
  assert.deepEqual(Object.keys(MOVES_STEPS), [...MOVES_STEP_IDS]);
  assert.deepEqual(MOVES_STEP_IDS, [...MOVES_SETUP, ...MOVES_GATE, ...MOVES_CLOSE_OUT]);
  assert.equal(MOVES_GATE.at(-1), MOVES_PASS_POINT, "the gate passes when the loan is home; leaving comes after");
  assert.ok(lines[1]!.startsWith("the book: 0.02 test nBTC (about $1,489 at BTC $74,446)"), lines[1]);
  assert.ok(lines.some((l) => l.includes('{"lenders":["aave"],"min_hf_bp":15000,"max_rate_bp":2500,"moves":"any"}')));

  const ready: MovesFound = { account: ACCOUNT, accountExists: false, resuming: false, owner: OWNER, ownerNear: 6.85, factoryAave: aaveSettings(CONFIG), evmChainId: 84_532, backend: true, gas: { on: true, gas_wallet: FLOAT, balance: "48000000000000000" }, shimBase: ["USDC", "WBTC", "WETH"], keeper: { ok: true, why: "the keeper ticked 5 s ago and watches demo.pbf.testnet" } };
  const good = movesProblems(ready);
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.lines, [
    "demo.pbf.testnet is free",
    "pbf-keeper.testnet holds 6.85 NEAR",
    "the factory's Aave settings: chain 84532, collateral WBTC and WETH",
    `the gas wallet ${FLOAT}, which is the stand-in's float on Base Sepolia, holds 0.048 ETH`,
    "the stand-in knows Base Sepolia's USDC, WBTC, WETH. Whether its float there is on shows at the first quote: it needs EVM_GAS_PRIVATE_KEY",
    "the keeper ticked 5 s ago and watches demo.pbf.testnet",
  ]);

  // Everything that can be wrong, each said in one line.
  const bad = movesProblems({ ...ready, accountExists: true, ownerNear: 2, factoryAave: null, gas: { on: false, gas_wallet: null, balance: null }, shimBase: ["USDC"], keeper: { ok: false, why: "the keeper's last tick was 900 s ago: is it running?" } });
  assert.deepEqual(bad.problems, [
    "demo.pbf.testnet exists already: a run needs a fresh account, so give another --name (or --from to go on with this one)",
    "the factory's config has no Aave settings (lenders.aave), so a new account couldn't move anything to Aave's chain",
    "the backend's gas helper is off: set EVM_GAS_PRIVATE_KEY in .env and start the backend again",
    "the stand-in that is running doesn't know Base Sepolia's tokens: it is from before stage 4, or the factory had no Aave settings when it started. Build and start it again",
    "the keeper's last tick was 900 s ago: is it running?",
  ]);
  assert.match(movesProblems({ ...ready, gas: { on: true, gas_wallet: FLOAT, balance: "20000000000000000" } }).problems[0]!, /the float holds 0\.02 ETH, and a run needs it to hold 0\.0252 ETH \(0\.02 to wrap, 0\.003 it keeps for gas, a top-up for the address\)/);
  assert.deepEqual(movesProblems({ ...ready, accountExists: true, resuming: true, gas: { on: true, gas_wallet: FLOAT, balance: "20000000000000000" } }).problems, [], "a run that goes on has had its wrap");
  assert.match(movesProblems({ ...ready, ownerNear: 5 }).problems[0]!, /holds 5 NEAR, and a run needs about 6\.7/);
  // What was built here against what the factory has: a deploy that isn't finished stops a fresh run before it costs 6 NEAR.
  const built = "94ceb936".padEnd(64, "0");
  const same = { what: "account code", file: "contracts/target/near/pb_account/pb_account.wasm", built, live: built };
  assert.ok(movesProblems({ ...ready, code: [same] }).lines.includes("the factory's account code is the one built here (94ceb936…)"));
  assert.deepEqual(movesProblems({ ...ready, code: [{ ...same, live: "fae0d5bd".padEnd(64, "0") }] }).problems, ["the factory's account code is fae0d5bd…, and the one built here is 94ceb936…: the deploy of what is built here isn't finished"]);
  assert.deepEqual(movesProblems({ ...ready, code: [{ ...same, what: "pinned pb-risk", live: null }] }).problems, ["couldn't read the factory's pinned pb-risk"]);
  assert.deepEqual(movesProblems({ ...ready, code: [{ ...same, built: null }] }).problems, [], "no built file: said, not a stop");
  assert.deepEqual(movesProblems({ ...ready, accountExists: true, resuming: true, code: [{ ...same, live: "fae0d5bd".padEnd(64, "0") }] }).problems, [], "a run that goes on keeps its account's code");
  assert.match(movesProblems({ ...ready, backend: false }).problems[0]!, /doesn't answer GET \/api\/config/);
  assert.match(movesProblems({ ...ready, shimBase: null }).problems[0]!, /the stand-in doesn't answer GET \/v0\/tokens/);
  assert.match(movesProblems({ ...ready, gas: null }).problems[0]!, /no GET \/api\/evm\/gas/);
  assert.match(movesProblems({ ...ready, evmChainId: 11_155_111 }).problems[0]!, /name chain 84532, and EVM_CHAIN_ID is 11155111/);
});

test("the moves gate, start to end: nBTC out as WETH, a check that settles it, one fund, the loan home on NEAR, then USDC back, both loans repaid, the bitcoin home, and the float's test ETH back", async () => {
  const s = sim();
  const aimed = wethFor(54_535n);
  s.fund = [{ k: "l_supply", l: "aave", tok: WETH, amt: aimed.toString() }, { k: "l_borrow", l: "aave", amt: 23_000_000 }, { k: "p_borrow", amt: 99_400_000 }];
  // The engine could lend $700 from our pool on this book; the gate asks for Aave's part and $100.
  s.preview = { total: 723_100_000, sources: [{ source: "aave", amount: 23_100_000, rate_bp: 74 }, { source: "pool", amount: 700_000_000, rate_bp: 650 }], steps: s.fund, blended_bp: 630, verdict: { ok: true } };
  const { gate: g, record } = gate(s);

  // ---- setup and the gate itself, up to its pass point ----
  for (const id of [...MOVES_SETUP, ...MOVES_GATE]) await MOVES_STEPS[id]!(g);
  assert.deepEqual(record.steps.map((x) => [x.id, x.pass]), [...MOVES_SETUP, ...MOVES_GATE].map((id) => [id, true]));

  // The account is opened with the permission for Aave, and holds test nBTC only.
  const create = s.calls.find((c) => c.method === "create_account")!;
  assert.deepEqual([create.args, create.deposit, s.createTgas], [{ name: "demo", owner: OWNER, permission: movesPermission() }, 6n * 10n ** 24n, 300], "300 TGas, of the 180 the factory asks for now");
  assert.deepEqual(detail(record, "deposit"), { mnbtc: "2000000", held_before: "0", added: "2000000" });
  // Gas to the address, and nothing else: no collateral comes from the helper.
  assert.deepEqual(s.gasAsks, [{}]);
  assert.deepEqual(detail(record, "gas").float_before, { gas_wallet: FLOAT, eth_before: "48000000000000000" });

  // The bitcoin goes out: a probe, a price, a committed quote, then the account's withdraw with the transfer. No check: no loan yet.
  assert.deepEqual(s.quoteAsks.slice(0, 3), [
    { dry: true, move: "to_evm", token: MNBTC, amount: "20000" },
    { dry: true, move: "to_evm", token: MNBTC, amount: "54535" },
    { dry: false, move: "to_evm", token: MNBTC, amount: "54535" },
  ]);
  const out = s.calls.find((c) => c.method === "withdraw")!;
  assert.deepEqual([out.args, out.deposit], [{ token: MNBTC, amount: "54535", receiver: "1".padStart(64, "d"), transfer: { kind: "to_evm", exp: s.quotes[0]!.amountIn === 54_535n ? (out.args.transfer as { exp: number }).exp : 0 } }, 1n]);
  assert.deepEqual(record.context.collateral, { symbol: "WETH", token: WETH, decimals: 18, amount: aimed.toString(), how: "move", why: NO_ROOM, gas_wallet: FLOAT, address: ADDRESS });
  assert.equal(aimed, 19_566_632_500_000_000n);
  const btcOut = detail(record, "btc_out").move as { transfer_id: string; needed_check: unknown; stand_in: { statuses: string[] } };
  assert.deepEqual([btcOut.transfer_id, btcOut.needed_check, btcOut.stand_in.statuses], ["move:0", null, ["PENDING_DEPOSIT", "SUCCESS"]]);
  // A check settles it: the verdict's `arrived` names the move, and the account lists it no more.
  assert.deepEqual([detail(record, "arrived").settled, detail(record, "arrived").checks], [["move:0"], 1]);

  // One fund, for Aave's part and $100 of our pool's, a little under: not the $723 the engine could lend.
  const fund = s.calls.filter((c) => c.method === "fund");
  assert.equal(fund.length, 1);
  assert.deepEqual([fund[0]!.args, fund[0]!.deposit], [{ amount: (record.context.funding as { amount: string }).amount }, 1n]);
  const asked = BigInt((record.context.funding as { amount: string }).amount);
  assert.ok(asked > 122_000_000n && asked < 123_100_000n, `asked ${asked}`);
  assert.deepEqual(record.context.loans, { aave_debt_micro: 23_000_000, aave_posted_units: aimed.toString(), pool_debt_micro: "99400000", pool_part: true });

  // The loan comes home. Our pool is owed, so the check the quote names comes first; then evm_withdraw with the
  // quote's expiry, the signed transfer sent and mined, and the stand-in's delivery on NEAR settles the move.
  const home = detail(record, "loan_home");
  assert.deepEqual([home.sent_from_the_address, home.arrived_micro, home.musdc], ["23000000", "22997700", "122397700"]);
  const loanHome = home.move as { transfer_id: string; needed_check: unknown; deposit_address: string; deposit_memo: string; transfer: { nonce: number; status: string }; stand_in: { statuses: string[] } };
  assert.deepEqual(loanHome.needed_check, { evm_withdraw: { token: USDC, amount: "23000000" } });
  assert.deepEqual([loanHome.transfer_id, loanHome.deposit_address, loanHome.deposit_memo, loanHome.transfer, loanHome.stand_in.statuses], ["move:1", FLOAT, "memo-1", { nonce: 3, hash: s.signed[3]!.hash, submit: { status: "sent" }, status: "mined" }, ["PENDING_DEPOSIT", "SUCCESS"]]);
  const evmWithdraw = s.calls.find((c) => c.method === "evm_withdraw")!;
  assert.deepEqual([evmWithdraw.args.token, evmWithdraw.args.amount, evmWithdraw.args.to, evmWithdraw.deposit], [USDC, "23000000", FLOAT, 1n]);
  const before = methods(s).lastIndexOf("evm_withdraw");
  assert.deepEqual(s.calls[before - 1], { method: "request_check", args: { intent: { evm_withdraw: { token: USDC, amount: "23000000" } } }, deposit: 10n ** 22n });
  assert.deepEqual([s.pending, balance(s, MUSDC, ACCOUNT), s.wallet[USDC]], [[], 122_397_700n, 0n], "the gate's pass point: the USDC is in the account on NEAR and the move is settled");

  // ---- leaving, as a client would ----
  s.debt += 9_000n; // interest at Aave since the borrow
  for (const id of MOVES_CLOSE_OUT) await MOVES_STEPS[id]!(g);
  assert.deepEqual(record.steps.map((x) => [x.id, x.pass]), MOVES_STEP_IDS.map((id) => [id, true]));

  // USDC back: what Aave is owed and 1 USDC over. The first check shows the loan's transfer home mined, which moves
  // the account's counter on, so the account wants a new check: the gate asks again, and the withdraw goes through.
  const usdcOut = detail(record, "usdc_out");
  assert.deepEqual([usdcOut.owed_micro, usdcOut.added_by_the_client_micro, usdcOut.at_the_address], ["23000000", "0", "23992800"]);
  const back = usdcOut.move as { transfer_id: string; needed_check: unknown; checked_again_because: string[] };
  assert.deepEqual([back.transfer_id, back.needed_check], ["move:2", { withdraw: { token: MUSDC, amount: "24000000" } }]);
  assert.deepEqual(back.checked_again_because, [`withdraw (usdc_out) failed: the verdict was already used: ask for a new check (tx N${methods(s).indexOf("withdraw", methods(s).indexOf("evm_withdraw")) + 1})`]);
  assert.deepEqual([detail(record, "usdc_arrived").settled, detail(record, "usdc_arrived").checks], [["move:2"], 1], "settled before the USDC is spent");

  // Aave repaid from what arrived (no faucet), our pool repaid, the collateral back from Aave.
  const repaid = detail(record, "repay_aave");
  assert.deepEqual([repaid.owed_micro, repaid.sent_micro, repaid.faucet, repaid.owed_after_micro], [23_009_000, "23033009", null, 0]);
  assert.deepEqual([s.debt, s.poolDebt, s.posted[WETH]], [0n, 0n, 0n]);
  assert.equal((detail(record, "repay").debt_before as string), "99400000");

  // The bitcoin comes home as nBTC. Nothing is owed to our pool now, so no check is needed for it.
  const btcHome = detail(record, "btc_home");
  assert.deepEqual([btcHome.sent_from_the_address, btcHome.arrived_units], [[{ symbol: "WETH", amount: aimed.toString() }], nbtcFor(aimed).toString()]);
  assert.equal(nbtcFor(aimed), 54_263n);
  assert.deepEqual(((btcHome.moves as { needed_check: unknown; transfer_id: string }[])[0]!).needed_check, null);
  assert.deepEqual(s.calls.filter((c) => c.method === "evm_withdraw").map((c) => [c.args.token, c.args.amount, c.args.to]), [[USDC, "23000000", FLOAT], [WETH, aimed.toString(), FLOAT]]);

  // Everything is withdrawn, and no move is left under way.
  assert.deepEqual([balance(s, MUSDC, ACCOUNT), balance(s, MNBTC, ACCOUNT), s.pending], [0n, 0n, []]);
  assert.equal(balance(s, MNBTC, OWNER), 2_000_000n - 54_535n + 54_263n);

  // The float has its test ETH back, less the 0.002 top-up and its fees (the top-up, two deliveries on Aave's chain
  // and the unwrap); the record says how much the run used.
  const float = detail(record, "float");
  assert.deepEqual([float.eth_before, float.eth_after, float.used_wei, float.used_eth], ["48000000000000000", "45940000000000000", "2060000000000000", 0.00206]);
  assert.deepEqual(float.left_at_the_address, { eth_wei: "2000000000000000", tokens: [{ symbol: "USDC", amount: "983800" }] });
  assert.deepEqual(record.context.float, { gas_wallet: FLOAT, eth_before: "48000000000000000", eth_after: "45940000000000000", used_wei: "2060000000000000", used_eth: 0.00206, left_at_the_address: float.left_at_the_address });

  // Every transaction the client signed on Aave's chain went through the backend's route; the keeper's own were its.
  assert.deepEqual(s.submits, [3, 4, 5, 6, 7]);
  assert.deepEqual(s.signed.map((e) => e.kind), ["approve", "supply", "borrow", "transfer", "approve", "repay", "withdraw", "transfer"]);
  assert.equal(record.context.checks_that_failed, undefined, "no check failed");
  // The account's rules since the audit fixes (INTERFACES.md 40.1), which this made-up account holds the gate to:
  // - the permission came with the account's making, and the fund's own check was read after that block;
  assert.deepEqual([s.permissionBlk, (s.funding!.pid)], [5_000, "f5040"]);
  // - every move's exp is its quote's expiry, ten minutes ahead: far inside the day a quote may live;
  const exps = s.calls.flatMap((c) => (c.method === "withdraw" && c.args.transfer ? [(c.args.transfer as { exp: number }).exp] : c.method === "evm_withdraw" ? [c.args.exp as number] : []));
  assert.equal(exps.length, 5, "four moves; the USDC's withdraw was signed twice, the first time on a check the account had used");
  assert.deepEqual(s.quotes.map((q) => q.status), ["SUCCESS", "SUCCESS", "SUCCESS", "SUCCESS"]);
  assert.ok(exps.every((exp) => exp > T0 && exp - T0 < 2 * 60 * 60_000), "each was ten minutes after its quote, in a run of under two hours");
  // - never more than one borrow, withdrawal or transfer on Aave's chain listed at once, of the eight an account lists;
  assert.equal(s.mostListed, 1);
  // - Aave is repaid by the owner, in full; and every deposit the gate makes is a plain one, with no transfer's msg.
  assert.deepEqual(s.calls.filter((c) => c.method === "ft_transfer_call").map((c) => c.args.msg), ["", ""]);

  // The gate ran no funding-plan step itself, and asked the faucet for nothing.
  assert.ok(!methods(s).includes("execute_step"));
  assert.deepEqual(s.gasAsks, [{}]);
});

test("a moves gate that is resumed asks again for nothing its account already has", async () => {
  // The deposit: only what is missing.
  const part = opened();
  credit(part, MNBTC, ACCOUNT, 1_200_000n);
  const a = gate(part);
  await stepDepositNbtc(a.gate);
  assert.deepEqual([methods(part), detail(a.record, "deposit")], [["mint", "ft_transfer_call"], { mnbtc: "2000000", held_before: "1200000", added: "800000" }]);

  // The collateral is at the address already: no quote, no withdraw, and the record learns which token it is.
  const there = opened({ wallet: { [WETH]: 19_566_632_500_000_000n } });
  const b = gate(there);
  await stepBtcOut(b.gate);
  assert.deepEqual([there.quoteAsks, there.calls], [[], []]);
  assert.equal(detail(b.record, "btc_out").already, "the address holds WETH already");
  assert.deepEqual(b.record.context.collateral, { symbol: "WETH", token: WETH, decimals: 18, amount: "19566632500000000", how: "move", why: "found at the address when the run went on", gas_wallet: FLOAT, address: ADDRESS });
  // And with nothing under way, the check that settles a move has nothing to ask for.
  await stepArrived(b.gate, "arrived");
  assert.deepEqual([there.calls, typeof detail(b.record, "arrived").already], [[], "string"]);

  // The move was under way when the run stopped: it is waited for, not asked for again.
  const under = opened();
  credit(under, MNBTC, ACCOUNT, 2_000_000n);
  under.standInOff = true;
  const c = gate(under);
  assert.equal(await stopped(stepBtcOut(c.gate), c.record, "btc_out"), "timed out after 600 s waiting for the stand-in to deliver btc_out (move:0); last seen: its status was PENDING_DEPOSIT");
  const asks = under.quoteAsks.length;
  under.standInOff = false;
  const again = gate(under, {}, c.record);
  await stepBtcOut(again.gate);
  assert.deepEqual([under.quoteAsks.length, methods(under).filter((m) => m === "withdraw").length], [asks, 1]);
  assert.deepEqual((detail(c.record, "btc_out").move as { resumed: string }).resumed, "move:0");
  assert.equal((c.record.context.collateral as { symbol: string }).symbol, "WETH");

  // The fund: with the plan stored and the record of it, nothing is signed again; without the record, the gate stops.
  const funded = opened({ funding: { pid: "f5020", steps: [{ k: "l_borrow", l: "aave", amt: 23_000_000, done: false }] } });
  const d = gate(funded);
  d.record.context.funding = { pid: "f5020", amount: "122484500" };
  await stepFundMoves(d.gate);
  assert.deepEqual([funded.calls, detail(d.record, "fund").already], [[], "the funding plan f5020 is stored"]);
  const stray = gate(funded);
  assert.match(await stopped(stepFundMoves(stray.gate), stray.record, "fund"), /has a funding plan or an Aave loan already, and the record doesn't say which fund made it/);
  assert.deepEqual(funded.calls, []);

  // The loan's move home was under way, its transfer signed and not yet mined: the gate asks for no quote and signs
  // nothing. It sends the kept transfer again, as the keeper does, and waits for the delivery.
  const coming = opened({ wallet: { [USDC]: 23_000_000n }, debt: 23_000_000n, pending: [{ id: "move:1", kind: "e_home", token: "USDC", amount: "23000000", dep: FLOAT, deadline: "0" }], nextMove: 2 });
  coming.quotes.push({ move: "e_home", token: USDC, amountIn: 23_000_000n, delivers: { token: MUSDC, symbol: "USDC", chain: "NEAR", amount: "22997700" }, depositAddress: FLOAT, memo: "memo-0", transfer: "move:1", status: "PENDING_DEPOSIT", hash: null });
  const kept = sign(coming, "transfer", USDC, 23_000_000n, FLOAT);
  const e = gate(coming);
  await stepLoanHome(e.gate);
  assert.deepEqual([coming.calls, coming.quoteAsks, coming.submits, detail(e.record, "loan_home").arrived_micro], [[], [], [0], "22997700"]);
  assert.deepEqual(detail(e.record, "loan_home").move, { resumed: "move:1", transfer: { nonce: 0, hash: kept.hash, submit: { status: "sent" }, status: "mined" } });
  // Run again once it is home: nothing to bring. Without this run's own move in the record, that is a failure, not a pass.
  assert.match(await stopped(stepLoanHome(e.gate), e.record, "loan_home"), /holds no USDC to bring home, and the record shows no move home/);
  e.record.context.moves = { loan_home: { transfer_id: "move:1", deposit_address: FLOAT, deposit_memo: "memo-0" } };
  await stepLoanHome(e.gate);
  assert.equal(detail(e.record, "loan_home").already, "the address holds no USDC and no move home is under way: the loan is in the account");

  // USDC back: the address already holds enough to repay what the held verdict shows owed.
  const enough = opened({ wallet: { [USDC]: 23_992_800n }, debt: 23_000_000n });
  accept(enough, { check: {} });
  const f = gate(enough);
  await stepUsdcOut(f.gate);
  assert.deepEqual([enough.calls, enough.quoteAsks, detail(f.record, "usdc_out").already], [[], [], "the address holds 23992800 units of USDC, enough to repay the 23000000 owed"]);
});

test("a check that brings no verdict is waited out and asked again, with each reason in the record; and a move is stopped in words before anything is signed", async () => {
  // Aave's chain can't be read twice: no verdict at all. The third check settles the move.
  const s = opened();
  credit(s, MNBTC, ACCOUNT, 2_000_000n);
  const { gate: g, record } = gate(s);
  await stepBtcOut(g);
  s.noVerdict = [1, 2];
  const started = s.now;
  await stepArrived(g, "arrived");
  const arrived = detail(record, "arrived");
  assert.deepEqual([arrived.settled, arrived.checks, arrived.checks_that_failed], [["move:0"], 3, ["the account refused the verdict: OutLayer's call failed", "the account refused the verdict: OutLayer's call failed"]]);
  assert.equal(s.now - started, 120_000, "a minute's wait after each check that failed");
  assert.deepEqual(record.context.checks_that_failed, [
    { at: new Date(started).toISOString(), check: "request_check (arrived)", why: "the account refused the verdict: OutLayer's call failed" },
    { at: new Date(started + 60_000).toISOString(), check: "request_check (arrived, try 2)", why: "the account refused the verdict: OutLayer's call failed" },
  ]);
  // No verdict ever names the move: the step fails after four checks, saying what the account still lists.
  const blind = opened({ pending: [{ id: "move:4", kind: "to_evm", token: MNBTC, amount: "54535", dep: "ab".repeat(32), deadline: "0" }] });
  const never = gate(blind);
  assert.equal(await stopped(stepArrived(never.gate, "arrived"), never.record, "arrived"), `after 4 checks the account still lists move:4 (54535 of ${MNBTC}): no verdict's arrived named it`);
  assert.equal(blind.checks, 4);

  // The loan's move home, with our pool owed: the check it needs fails three times. Nothing is signed, no deposit
  // address is asked for, and every reason is in the record.
  const owing = opened({ wallet: { [USDC]: 23_000_000n }, debt: 23_000_000n, poolDebt: 99_400_000n, noVerdict: [1, 2, 3] });
  const h = gate(owing);
  assert.equal(
    await stopped(stepLoanHome(h.gate), h.record, "loan_home"),
    "request_check (loan_home) brought no verdict in 3 tries: (1) the account refused the verdict: OutLayer's call failed; (2) the account refused the verdict: OutLayer's call failed; (3) the account refused the verdict: OutLayer's call failed",
  );
  assert.deepEqual([methods(owing), owing.quoteAsks.map((q) => q.dry)], [["request_check", "request_check", "request_check"], [true]]);
  assert.equal((h.record.context.checks_that_failed as unknown[]).length, 3);
  // The next run's check comes back, and the move goes through.
  await stepLoanHome(gate(owing, {}, h.record).gate);
  assert.equal(detail(h.record, "loan_home").arrived_micro, "22997700");

  // No room on the credit line: the verdict allows no withdrawal, and the gate says so and signs nothing.
  const full = opened({ wallet: { [USDC]: 23_000_000n }, debt: 23_000_000n, poolDebt: 740_000_000n, noRoom: true });
  const i = gate(full);
  assert.equal(await stopped(stepLoanHome(i.gate), i.record, "loan_home"), "the check doesn't allow loan_home now: the account is HEALTHY, and the verdict allows no withdrawal. While our pool is owed, a move needs room on the credit line");
  assert.deepEqual([methods(full), full.quoteAsks.map((q) => q.dry)], [["request_check"], [true]]);

  // A quote the float can't fill is refused at quote time, in the stand-in's words: nothing is signed, no check is paid for.
  const short = opened({ floatShort: true });
  credit(short, MNBTC, ACCOUNT, 2_000_000n);
  const j = gate(short);
  assert.equal(await stopped(stepBtcOut(j.gate), j.record, "btc_out"), `the quote was refused (HTTP 400): 1Click /v0/quote answered HTTP 400: The stand-in's float holds 0.004 test ETH and 0 WETH: it can't wrap 0.0071513 more and keep 0.003 for gas. Ask for less, or send the float (${FLOAT}) test ETH on Base Sepolia`);
  assert.deepEqual(short.calls, []);

  // A wait that runs out says what it waited for and what it last saw: here, a transfer that Aave's chain doesn't mine.
  const stuck = opened({ wallet: { [USDC]: 23_000_000n }, debt: 23_000_000n, stuck: true });
  const m = gate(stuck);
  assert.equal(await stopped(stepLoanHome(m.gate), m.record, "loan_home"), `timed out after 120 s waiting for Aave's chain to mine the transfer (nonce 0, 0x${"0".repeat(64)}); last seen: its status was "signed", and the chain had used 0 of the address's nonces`);
  // The run goes on once the chain mines again: the move isn't asked for a second time.
  stuck.stuck = false;
  await stepLoanHome(gate(stuck, {}, m.record).gate);
  assert.deepEqual([methods(stuck).filter((x) => x === "evm_withdraw").length, stuck.quoteAsks.length, stuck.submits, detail(m.record, "loan_home").arrived_micro], [1, 2, [0, 0], "22997700"]);

  // The account's withdraw goes through but the tokens don't leave: the account drops the move, and the gate stops there.
  const empty = opened();
  credit(empty, MNBTC, ACCOUNT, 10_000n);
  const k = gate(empty);
  assert.match(await stopped(stepBtcOut(k.gate), k.record, "btc_out"), /^the move didn't go out, and the account dropped it again: transfer move:0 didn't go out: nothing was sent/);
  assert.deepEqual(empty.pending, []);

  // The float's test ETH didn't come back (the WETH is still wrapped there): the last step says so, and how much.
  const down = opened({ floatEth: 26_000_000_000_000_000n });
  const l = gate(down);
  l.record.context.float = { gas_wallet: FLOAT, eth_before: "48000000000000000" };
  assert.match(await stopped(stepFloat(l.gate), l.record, "float"), /^the float is 0\.022 test ETH down on the run, more than the gas and the top-ups a run uses \(0\.007\): the WETH that came home may still be wrapped at the float/);
  assert.equal(detail(l.record, "float").used_wei, "22000000000000000");
  const unnoted = gate(opened());
  assert.match(await stopped(stepFloat(unnoted.gate), unnoted.record, "float"), /doesn't say what the float held before the run/);
});

test("when Aave has room the bitcoin goes as WBTC; and with no pool loan the moves need no check, and the client adds what the routes cost", async () => {
  const s = sim({ wbtcRoom: true });
  s.fund = [{ k: "l_supply", l: "aave", tok: WBTC, amt: "1496700" }, { k: "l_borrow", l: "aave", amt: 570_000_000 }];
  // On this book the engine gives Aave's part alone.
  s.preview = { total: 572_000_000, sources: [{ source: "aave", amount: 572_000_000, rate_bp: 74 }], steps: s.fund, blended_bp: 74, verdict: { ok: true } };
  const { gate: g, record } = gate(s);
  for (const id of MOVES_STEP_IDS) await MOVES_STEPS[id]!(g);
  assert.deepEqual(record.steps.map((x) => [x.id, x.pass]), MOVES_STEP_IDS.map((id) => [id, true]));

  // 0.015 nBTC goes out and arrives as WBTC; no note, because nothing was changed.
  assert.deepEqual(s.quoteAsks.slice(0, 3).map((q) => q.amount), ["20000", "1500000", "1500000"]);
  assert.deepEqual(record.context.collateral, { symbol: "WBTC", token: WBTC, decimals: 8, amount: "1496700", how: "move", why: "the stand-in delivered the bitcoin as WBTC", gas_wallet: FLOAT, address: ADDRESS });
  assert.deepEqual([(record.context.funding as { pool_part: boolean }).pool_part, s.poolDebt], [false, 0n]);

  // No loan from our pool: the account asks no verdict for a move, so the gate pays for no check before one.
  const intents = s.calls.filter((c) => c.method === "request_check").map((c) => Object.keys(c.args.intent as object)[0]);
  assert.deepEqual(intents, ["check", "fund", "check", "check", "check"], "the two that settle a move, the fund, and one after each of the repayment and the withdrawal from Aave");
  for (const id of ["loan_home", "usdc_out"]) assert.equal((detail(record, id).move as { needed_check: unknown }).needed_check, null, id);

  // The loan came home less the route's cost, and more than that goes back: the client adds the difference.
  assert.deepEqual([detail(record, "loan_home").arrived_micro, detail(record, "usdc_out").owed_micro, detail(record, "usdc_out").added_by_the_client_micro], ["569943000", "570000000", "5757000"]);
  const added = s.calls.filter((c) => c.method === "mint" || c.method === "ft_transfer_call").slice(2);
  assert.deepEqual(added.map((c) => [c.method, c.args.amount]), [["mint", "5757000"], ["ft_transfer_call", "5757000"]]);
  assert.equal(detail(record, "repay").already, "no loan");

  // Aave has room for the probe's WBTC and not for the whole 0.015: that would arrive as 0.54 WETH, which the stand-in
  // refuses, saying how much fits. The gate sends 2.5% under that, and it arrives as WETH.
  const little = opened({ wbtcRoom: 30_000n });
  credit(little, MNBTC, ACCOUNT, 2_000_000n);
  const tight = gate(little);
  await stepBtcOut(tight.gate);
  assert.deepEqual(little.quoteAsks.map((q) => [q.dry, q.amount]), [[true, "20000"], [true, "1500000"], [true, "54245"], [false, "54245"]]);
  assert.deepEqual([(tight.record.context.collateral as { symbol: string }).symbol, (tight.record.context.collateral as { amount: string }).amount], ["WETH", wethFor(54_245n).toString()]);
  assert.match(String((detail(tight.record, "btc_out").move as { sized: string }).sized), /^Aave has room for the probe's WBTC and not for the 0\.015 nBTC a WBTC move sends: the quote was refused \(HTTP 400\): 1Click \/v0\/quote answered HTTP 400: This would arrive as 0\.5392113 WETH/);
  // A little more room, and the smaller move fits it: it arrives as WBTC after all, and the record says so.
  const more = opened({ wbtcRoom: 100_000n });
  credit(more, MNBTC, ACCOUNT, 2_000_000n);
  const fitted = gate(more);
  await stepBtcOut(fitted.gate);
  assert.deepEqual([(fitted.record.context.collateral as { symbol: string }).symbol, (fitted.record.context.collateral as { amount: string }).amount, (fitted.record.context.collateral as { why: string }).why], ["WBTC", "54125", "the stand-in delivered the bitcoin as WBTC"]);

  // The WBTC comes home as nBTC, and the float wrapped nothing: the run used the top-up and fees only.
  assert.deepEqual([detail(record, "btc_home").sent_from_the_address, detail(record, "btc_home").arrived_units], [[{ symbol: "WBTC", amount: "1496700" }], "1493107"]);
  assert.equal(detail(record, "float").used_wei, "2050000000000000");
  assert.deepEqual([s.debt, s.posted[WBTC], s.pending, balance(s, MNBTC, ACCOUNT), balance(s, MUSDC, ACCOUNT)], [0n, 0n, [], 0n, 0n]);
});

// ---------- INTERFACES.md 51.2: the same gate from the client's own test ETH (--coin ETH) ----------

const ETH_COIN: GateCoin = { coin: "ETH", szDecimals: 4, token: METH, tokenDecimals: 18 };
/** 0.02 test ETH arrives as 0.0199954 WETH, as 1Click priced it on 14 Nov. */
const WETH_ARRIVED = 19_995_400_000_000_000n;

test("51.2, the moves gate in ETH, start to end: the account holds test ETH, 0.02 of it goes out and arrives as WETH with no probe, Aave lends against it, and the collateral comes home as test ETH", async () => {
  const s = sim();
  s.fund = [{ k: "l_supply", l: "aave", tok: WETH, amt: WETH_ARRIVED.toString() }, { k: "l_borrow", l: "aave", amt: 21_000_000 }, { k: "p_borrow", amt: 99_400_000 }];
  s.preview = { total: 721_000_000, sources: [{ source: "aave", amount: 21_000_000, rate_bp: 74 }, { source: "pool", amount: 700_000_000, rate_bp: 650 }], steps: s.fund, blended_bp: 630, verdict: { ok: true } };
  const { gate: g, record } = gate(s, {}, { context: {}, steps: [] }, ETH_COIN);

  for (const id of [...MOVES_SETUP, ...MOVES_GATE]) await MOVES_STEPS[id]!(g);
  assert.deepEqual(record.steps.map((x) => [x.id, x.pass]), [...MOVES_SETUP, ...MOVES_GATE].map((id) => [id, true]));

  // The book: $1,300 of test ETH at $1,890.1, in ten-thousandths of an ETH rounded up, and no bitcoin.
  assert.equal(g.plan.deposit_nbtc_units, "687800000000000000");
  assert.deepEqual(detail(record, "deposit"), { mnbtc: "687800000000000000", held_before: "0", added: "687800000000000000" });
  assert.deepEqual(s.calls.filter((c) => c.method === "mint" || c.method === "ft_transfer_call").map((c) => [c.method, c.args.amount]), [["mint", "687800000000000000"], ["ft_transfer_call", "687800000000000000"]]);
  assert.equal(balance(s, MNBTC, ACCOUNT), 0n);
  assert.equal(record.steps.find((x) => x.id === "deposit")!.label, "mint and deposit the test ETH");

  // The ether goes out: no probe. A price for 0.02 ETH (the gate's own look, then the move's), a committed quote, the withdraw.
  assert.equal(ETH_MOVE_UNITS, 20_000_000_000_000_000n);
  assert.deepEqual(s.quoteAsks.slice(0, 3), [
    { dry: true, move: "to_evm", token: METH, amount: "20000000000000000" },
    { dry: true, move: "to_evm", token: METH, amount: "20000000000000000" },
    { dry: false, move: "to_evm", token: METH, amount: "20000000000000000" },
  ]);
  const out = s.calls.find((c) => c.method === "withdraw")!;
  assert.deepEqual([out.args.token, out.args.amount, (out.args.transfer as { kind: string }).kind, out.deposit], [METH, "20000000000000000", "to_evm", 1n]);
  assert.deepEqual(record.context.collateral, { symbol: "WETH", token: WETH, decimals: 18, amount: WETH_ARRIVED.toString(), how: "move", why: "the stand-in delivered the ether as WETH", gas_wallet: FLOAT, address: ADDRESS });
  assert.equal(record.steps.find((x) => x.id === "btc_out")!.label, "the account's test ETH moves to its address on Aave's chain through the stand-in");
  assert.deepEqual([detail(record, "arrived").settled, detail(record, "arrived").checks], [["move:0"], 1]);
  assert.deepEqual(record.context.loans, { aave_debt_micro: 21_000_000, aave_posted_units: WETH_ARRIVED.toString(), pool_debt_micro: "99400000", pool_part: true });

  // Leaving: everything as for bitcoin, and the WETH comes home as test ETH: the quote is asked with `to`.
  for (const id of MOVES_CLOSE_OUT) await MOVES_STEPS[id]!(g);
  assert.deepEqual(record.steps.map((x) => [x.id, x.pass]), MOVES_STEP_IDS.map((id) => [id, true]));
  const home = s.quoteAsks.filter((q) => q.move === "e_home" && q.token === WETH);
  assert.deepEqual(home.at(-1), { dry: false, move: "e_home", token: WETH, amount: WETH_ARRIVED.toString(), to: METH });
  const btcHome = detail(record, "btc_home");
  const cameHome = (WETH_ARRIVED * 99_970n) / 100_000n;
  assert.deepEqual([btcHome.sent_from_the_address, btcHome.arrived_units], [[{ symbol: "WETH", amount: WETH_ARRIVED.toString() }], cameHome.toString()]);
  assert.equal(record.steps.find((x) => x.id === "btc_home")!.label, "the collateral comes home: from the address on Aave's chain to the account on NEAR, as test ETH");
  // Everything is withdrawn to the keeper: the test ETH that never left, and what came home. No bitcoin was ever touched.
  assert.deepEqual([balance(s, MUSDC, ACCOUNT), balance(s, METH, ACCOUNT), balance(s, MNBTC, ACCOUNT), balance(s, MNBTC, OWNER), s.pending], [0n, 0n, 0n, 0n, []]);
  assert.equal(balance(s, METH, OWNER), 687_800_000_000_000_000n - 20_000_000_000_000_000n + cameHome);
  assert.deepEqual(s.quotes.map((q) => q.status), ["SUCCESS", "SUCCESS", "SUCCESS", "SUCCESS"]);
});

test("51.2, when the stand-in takes less than 0.02 ETH today the gate sends 2.5% under what its refusal names, and says so; a refusal that names no amount stops the step in the stand-in's words", async () => {
  // The float can wrap 0.015 today.
  const s = opened({ ethCapWei: 15_000_000_000_000_000n, near: { [MUSDC]: {}, [METH]: { [ACCOUNT]: 687_800_000_000_000_000n } } });
  const { gate: g, record } = gate(s, {}, { context: {}, steps: [] }, ETH_COIN);
  await stepBtcOut(g);
  const most = (20_000_000_000_000_000n * 15_000_000_000_000_000n) / ((20_000_000_000_000_000n * 99_977n) / 100_000n);
  const sent = (most * 975n) / 1_000n;
  assert.deepEqual(s.quoteAsks.map((q) => [q.dry, q.amount]), [[true, "20000000000000000"], [true, sent.toString()], [false, sent.toString()]]);
  assert.equal(s.calls.find((c) => c.method === "withdraw")!.args.amount, sent.toString());
  assert.match(String((detail(record, "btc_out").move as { sized: string }).sized), /^the stand-in takes less than 0\.02 test ETH today: the quote was refused \(HTTP 400\): This would arrive as 0\.0199954 WETH, and the stand-in brings at most 0\.015 WETH in one move/);
  assert.equal(fitsOneMove("the quote was refused (HTTP 400): Send at most 0.015 ETH (15003450793682546 units)"), 14_628_364_523_840_482n);

  // The bitcoin gate's first move is untouched by all this: with no coin set it still probes with 0.0002 nBTC.
  const btc = opened({ near: { [MUSDC]: {}, [MNBTC]: { [ACCOUNT]: 2_000_000n } } });
  const b = gate(btc);
  await stepBtcOut(b.gate);
  assert.deepEqual(btc.quoteAsks[0], { dry: true, move: "to_evm", token: MNBTC, amount: "20000" });
  assert.equal(b.record.steps[0]!.label, "the account's nBTC moves to its address on Aave's chain through the stand-in");
});

test("51.2, the moves gate's dry run in ETH: the book in test ETH, the first move with no probe, and the collateral home as test ETH; in bitcoin the lines are the ones of before", () => {
  const words = { account: ACCOUNT, owner: OWNER, pool: "pool.pbf.testnet", apiUrl: "http://localhost:8788", shimUrl: "http://localhost:8787", recordFile: "r.json", fundWaitMin: 20 };
  const eth = describeMovesGate({ ...words, plan: movesPlan(planForCoin("small", 74_446, ETH_COIN, 1_890.1)) });
  assert.equal(eth[1], "the book: 0.6878 test ETH (about $1,300 at ETH $1,890.1) in the account on NEAR, and nothing else. The engine lends nothing to an account worth under $1,000");
  assert.ok(eth.includes(" 2 deposit         mint and deposit the test ETH (only what the account is short of)"));
  assert.equal(eth.filter((l) => l.startsWith(" 6 btc_out")).length, 1);
  assert.match(eth.find((l) => l.startsWith(" 6 btc_out"))!, /with move "to_evm" and test ETH as the token, for 0\.02 ETH/);
  assert.match(eth.find((l) => l.startsWith("16 btc_home"))!, /with "to" naming test ETH.*delivered as test ETH in the account on NEAR/);
  const btc = describeMovesGate({ ...words, plan: movesPlan(planFor("small", 74_446)) });
  assert.equal(btc[1], "the book: 0.02 test nBTC (about $1,489 at BTC $74,446) in the account on NEAR, and nothing else. The engine lends nothing to an account worth under $1,000");
  assert.match(btc.find((l) => l.startsWith(" 6 btc_out"))!, /for a probe of 0\.0002 nBTC/);
  assert.match(btc.find((l) => l.startsWith("16 btc_home"))!, /^16 btc_home        "e_home" for the collateral; evm_withdraw.*delivered as nBTC in the account on NEAR/);
  assert.equal(btc.length, eth.length, "the same steps");
});
