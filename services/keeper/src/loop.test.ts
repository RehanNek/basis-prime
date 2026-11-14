// The keeper loop against a scripted chain: a fake account contract that applies INTERFACES.md 14's rules (the two
// checks 2 to 5 minutes apart, the stored plan, execute_step marking steps done), a scripted engine that answers each
// check from the nBTC/BTC ratio, and a fake gateway. The drill's slide plays out tick by tick on a fake clock, and the
// test checks which actions the keeper took, and when.
import assert from "node:assert/strict";
import { test } from "node:test";

import { newestOf } from "./accounts.js";
import { keeperConfig } from "./config.js";
import { KEEP_PRICES_MS } from "./decide.js";
import { readEvm, type AaveSettings } from "./evm.js";
import type { LogEvent } from "./jsonl.js";
import { DEFAULT_MIN_PERIOD_MS, MOVE_FAR_MS, settleWords, showMicroUsd, tick, type AccountMemory, type KeeperDeps } from "./loop.js";
import { settlementIn, skippedTooSoon } from "./near-tx.js";
import type { AccountState, VerdictJson } from "./state.js";

const S = 1_000;
const MIN = 60 * S;
const T0 = Date.UTC(2026, 10, 10, 12, 20);
const ACCOUNT = "drill1.pbf.testnet";

/** The small book's engine, scripted: the state from the ratio, and after the buy-back, HEALTHY at any ratio. */
function engine(piBp: number, boughtBack: boolean): Pick<VerdictJson, "state" | "action" | "bands" | "plan"> {
  if (boughtBack) return { state: "HEALTHY", action: "NONE", bands: { nBTC: { im_bp: 6_900, mr_bp: 6_500, dl_bp: 6_000 } }, plan: [] };
  if (piBp >= 8_500) return { state: "HEALTHY", action: "NONE", bands: { nBTC: { im_bp: 8_500, mr_bp: 8_100, dl_bp: 7_700 } }, plan: [] };
  if (piBp >= 8_100) return { state: "WATCH", action: "NONE", bands: { nBTC: { mr_bp: 8_100, dl_bp: 7_700 } }, plan: [] };
  if (piBp >= 7_700) return { state: "MARGIN_CALL", action: "NONE", bands: { nBTC: { dl_bp: 7_700 } }, plan: [] };
  return {
    state: "DELEVERAGE",
    action: "DELEVERAGE",
    plan: [
      { k: "repay", amt: 10_000_000 },
      { k: "perp", coin: "BTC", buy: true, sz: "0.00375", px: "76190" },
    ],
  };
}

/** A fake account contract and chain: verdicts arrive 10 s after the check is asked for. */
class FakeChain {
  now = T0;
  block = 1_000;
  pi = 10_000;
  boughtBack = false;
  readonly times = new Map<number, number>();
  readonly actions: { at: number; what: string }[] = [];
  state: AccountState = {
    owner: "pbf-keeper.testnet",
    counter: 5,
    loan: { principal: "1097574230", open: true },
    verdict: null,
    deleverage: { first_at: "0" },
    plan: null,
    pending: [],
    hl: { path: "hyperliquid-1", address: "0x1b242c24f5e67e93d7b58c3dad77ccc90dacd7d0" },
  };

  constructor() {
    this.#store(engine(this.pi, false)); // the verdict the take-out left
  }

  advance(ms: number) {
    this.now += ms;
    this.block += Math.round(ms / 600);
  }

  /** request_check: pb-risk reads the chain now; the account stores the verdict 10 s later. */
  check(): { ok: true; hash: string } {
    this.actions.push({ at: this.now, what: "check" });
    const answer = engine(this.pi, this.boughtBack);
    this.advance(10 * S);
    this.#store(answer);
    return { ok: true, hash: `tx-check-${this.actions.length}` };
  }

  #store(answer: Pick<VerdictJson, "state" | "action" | "bands" | "plan">) {
    const blk = this.block - 5;
    this.times.set(this.block, this.now);
    this.state.verdict = { intent: { check: {} }, received_block: this.block, verdict: { ok: true, blk, nonce: this.state.counter, ...answer } };
    const now = BigInt(this.now) * 1_000_000n;
    // The two-check rule (contracts/account/src/records.rs), with Phase 4's stored plan (INTERFACES.md 14).
    const firstAt = BigInt(this.state.deleverage!.first_at);
    if (answer.action === "DELEVERAGE") {
      const waited = now - firstAt;
      if (firstAt > 0n && waited >= 120_000_000_000n && waited <= 300_000_000_000n) {
        this.state.plan = { pid: String(blk), action: "DELEVERAGE", stored_at: String(now), steps: (answer.plan as object[]).map((s) => ({ ...s, done: false })) };
        this.state.deleverage = { first_at: String(now) };
      } else if (firstAt === 0n || waited > 300_000_000_000n) {
        this.state.deleverage = { first_at: String(now) };
      }
    } else {
      this.state.deleverage = { first_at: "0" };
      if (answer.state === "HEALTHY" && answer.action === "NONE") this.state.plan = null;
    }
  }

  executeStep(pid: string, i: number) {
    this.actions.push({ at: this.now, what: `execute_step ${pid}:${i}` });
    const plan = this.state.plan as { pid: string; steps: { done: boolean }[] } | null;
    if (!plan || plan.pid !== pid || plan.steps[i]?.done) return { ok: false, failure: "refused" };
    plan.steps[i]!.done = true;
    return { ok: true };
  }

  gateway(mode: string) {
    this.actions.push({ at: this.now, what: `gateway ${mode}` });
    if (mode !== "deleverage") return { ok: true, acct: ACCOUNT };
    const plan = this.state.plan as { pid: string } | null;
    this.boughtBack = true;
    return { ok: true, acct: ACCOUNT, pid: plan?.pid, placed: [{ i: 1, k: "perp", status: "filled", filled_sz: "0.00375", avg_px: "76190" }], skipped: [{ i: 0, k: "repay", why: "execute_step runs it" }] };
  }
}

function deps(chain: FakeChain, events: LogEvent[], overrides: Partial<KeeperDeps> = {}): KeeperDeps {
  return {
    readMarket: async () => ({ prices: { marks: { BTC: 76_000 }, pi: { nBTC: chain.pi } }, summary: { nbtc_ratio_bp: chain.pi } }),
    listAccounts: async () => [ACCOUNT],
    readState: async () => structuredClone(chain.state),
    blockTimeMs: async (height) => chain.times.get(height) ?? chain.now,
    readPerps: async () => ["BTC"],
    requestCheck: async () => {
      const r = chain.check();
      return { ok: r.ok, hash: r.hash, accepted: true, reason: null, attestationUrl: `https://testnet-api.outlayer.ai/attestations/by-tx/${r.hash}`, seconds: 10 };
    },
    runGateway: async (_account, mode) => {
      const output = chain.gateway(mode);
      return { ok: true, retry: false, replan: false, code: null, reason: null, output, callId: `call-${chain.actions.length}`, attestationUrl: `https://testnet-api.outlayer.ai/attestations/by-call/call-${chain.actions.length}`, seconds: 6 };
    },
    executeStep: async (_account, pid, i) => {
      const r = chain.executeStep(pid, i);
      return { ok: r.ok, hash: `tx-step-${i}`, logs: [], seconds: 3, retry: false, ...(r.failure ? { failure: r.failure } : {}) };
    },
    log: (event, msg, fields = {}) => events.push({ t: new Date(chain.now).toISOString(), event, msg, ...fields }),
    now: () => chain.now,
    random: () => 0.99, // the hourly checks land at :59, after the drill
    ...overrides,
  };
}

test("the drill, tick by tick: WATCH, MARGIN_CALL, DELEVERAGE confirmed 2.5 minutes later, the plan runs, HEALTHY", async () => {
  const chain = new FakeChain();
  const events: LogEvent[] = [];
  const d = deps(chain, events);
  const memory = new Map<string, AccountMemory>();
  // The slide: 0.84 after 1 minute, 0.80 after 4, 0.75 after 7. Nobody touches anything.
  const slide = [
    { at: T0 + 1 * MIN, bp: 8_400 },
    { at: T0 + 4 * MIN, bp: 8_000 },
    { at: T0 + 7 * MIN, bp: 7_500 },
  ];
  const end = T0 + 20 * MIN;
  while (chain.now < end) {
    for (const s of slide) if (chain.now >= s.at && chain.pi > s.bp) chain.pi = s.bp;
    const started = chain.now;
    await tick(d, memory);
    // The next tick 15 s after this one started (a check makes a tick last 10 s here).
    if (chain.now < started + 15 * S) chain.now = started + 15 * S;
  }

  const at = (ms: number) => Math.round((ms - T0) / S);
  const timeline = chain.actions.map((a) => `${at(a.at)} s ${a.what}`);
  assert.deepEqual(timeline, [
    "60 s check", // 0.84 crossed the IM band
    "75 s gateway cancel_risky", // the WATCH verdict: the account left HEALTHY
    "240 s check", // 0.80 crossed the MR band
    "420 s check", // 0.75 crossed the 0.8 x MR band: the first DELEVERAGE
    "585 s check", // 150 s after the first verdict arrived (at 430 s): the second check
    "600 s gateway deleverage", // the plan is stored: the gateway places the buy-back
    "600 s execute_step 1063:0", // and execute_step runs the repay
    "615 s check", // then a check: HEALTHY again
  ]);

  // The contract confirmed the second DELEVERAGE: 155 s after the first arrived, inside its 2-5 minute window.
  const verdicts = events.filter((e) => e.event === "verdict").map((e) => `${at(Date.parse(e.t))} s ${String(e.state)}`);
  assert.deepEqual(verdicts, ["0 s HEALTHY", "75 s WATCH", "255 s MARGIN_CALL", "435 s DELEVERAGE", "600 s DELEVERAGE", "630 s HEALTHY"]);
  assert.equal(chain.state.plan, null, "a HEALTHY verdict with no action clears the plan");

  // Every action is logged with its transaction or its attestation.
  const checks = events.filter((e) => e.event === "check");
  assert.equal(checks.length, 5);
  assert.ok(checks.every((e) => typeof e.tx === "string" && String(e.attestation_url).includes("/attestations/by-tx/")));
  const gateway = events.find((e) => e.event === "gateway" && e.mode === "deleverage")!;
  assert.deepEqual(gateway.placed, [{ i: 1, k: "perp", status: "filled", filled_sz: "0.00375", avg_px: "76190" }]);
  assert.match(String(gateway.attestation_url), /attestations\/by-call\//);
  const step = events.find((e) => e.event === "step")!;
  assert.deepEqual([step.pid, step.i, step.k, step.tx], ["1063", 0, "repay", "tx-step-0"]);
  const why = events.filter((e) => e.event === "decide" && e.action === "request_check").map((e) => e.msg);
  assert.match(why[3]!, /^the second check for DELEVERAGE, 15\d s after the first verdict arrived/);
  assert.match(why[4]!, /^the steps of plan 1063 have run/);
});

test("Phase 5: the drill moves only the account's own ratio; the keeper compares its bands with that one, not the shared 1.0", async () => {
  const chain = new FakeChain();
  const events: LogEvent[] = [];
  const asked: string[] = [];
  // The shared ratio stays at par; get_ratio_for answers the account's own, which the slide walks down.
  const d = deps(chain, events, {
    readMarket: async () => ({ prices: { marks: { BTC: 76_000 }, pi: { nBTC: 10_000 } }, summary: { nbtc_ratio_bp: 10_000 } }),
    readRatioFor: async (account) => (asked.push(account), chain.pi),
  });
  const memory = new Map<string, AccountMemory>();
  const slide = [
    { at: T0 + 1 * MIN, bp: 8_400 },
    { at: T0 + 4 * MIN, bp: 8_000 },
  ];
  while (chain.now < T0 + 6 * MIN) {
    for (const s of slide) if (chain.now >= s.at && chain.pi > s.bp) chain.pi = s.bp;
    const started = chain.now;
    await tick(d, memory);
    if (chain.now < started + 15 * S) chain.now = started + 15 * S;
  }
  const at = (ms: number) => Math.round((ms - T0) / S);
  assert.deepEqual(chain.actions.map((a) => `${at(a.at)} s ${a.what}`), ["60 s check", "75 s gateway cancel_risky", "240 s check"], "the same checks as with the shared ratio");
  assert.ok(asked.every((a) => a === ACCOUNT) && asked.length > 0);
  assert.ok(events.some((e) => e.event === "account" && e.nbtc_ratio_bp === 8_000), "the account's own ratio is in its log line");

  // No ratio of its own (the drill's old code answers null): the shared one stands.
  const plain = new FakeChain();
  const quiet: LogEvent[] = [];
  await tick(deps(plain, quiet, { readRatioFor: async () => null }), new Map());
  assert.ok(quiet.some((e) => e.event === "account" && !("nbtc_ratio_bp" in e)));
});

test("one account's failed read doesn't stop the others; an account with no contract is noted once", async () => {
  const chain = new FakeChain();
  const events: LogEvent[] = [];
  const d = deps(chain, events, {
    listAccounts: async () => ["bad.pbf.testnet", "none.pbf.testnet", ACCOUNT],
    readState: async (account) => {
      if (account === "bad.pbf.testnet") throw new Error("RPC timeout");
      if (account === "none.pbf.testnet") return null;
      return structuredClone(chain.state);
    },
  });
  const memory = new Map<string, AccountMemory>();
  await tick(d, memory);
  await tick(d, memory);
  assert.equal(events.filter((e) => e.account === "bad.pbf.testnet" && e.msg === "skipped this tick: RPC timeout").length, 2);
  assert.equal(events.filter((e) => e.account === "none.pbf.testnet").length, 1, "said once");
  assert.ok(events.some((e) => e.event === "account" && e.account === ACCOUNT && e.state === "HEALTHY"));
});

test("pending transfers: 1Click's status is logged when it changes, an overdue one is said once, and its end is noted", async () => {
  const chain = new FakeChain();
  const events: LogEvent[] = [];
  const deadlineNs = String(BigInt(T0 + 30 * S) * 1_000_000n);
  chain.state.pending = [
    { transfer: { id: "move:7", kind: "to_hl", token: "musdc.pbf-ops.testnet", amount: "11000000", dep: "ab".repeat(32), deadline: deadlineNs } },
    { transfer: { id: "move:8", kind: "home", token: "USDC", amount: "11000000", dep: "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d", deadline: deadlineNs } },
  ];
  const asked: string[] = [];
  let status = "PROCESSING";
  const d = deps(chain, events, { transferStatus: async (dep) => (asked.push(dep), status) });
  const memory = new Map<string, AccountMemory>();
  await tick(d, memory);
  chain.now += 31 * S;
  status = "REFUNDED";
  await tick(d, memory);
  chain.now += 31 * S;
  chain.state.pending = [];
  await tick(d, memory);

  const lines = events.filter((e) => e.event === "transfer").map((e) => e.msg);
  assert.deepEqual(lines, [
    "1Click says PROCESSING for transfer move:7 (to_hl)",
    "transfer move:7 (to_hl) is overdue: its deadline has passed, so borrowing and withdrawing with a loan are refused",
    "1Click says REFUNDED for transfer move:7 (to_hl)",
    "transfer move:8 (home) is overdue: its deadline has passed, so borrowing and withdrawing with a loan are refused",
    "transfer move:7 is no longer pending",
    "transfer move:8 is no longer pending",
  ]);
  assert.deepEqual(asked, ["ab".repeat(32), "ab".repeat(32)], "only NEAR deposit addresses are asked about, every 30 s");
});

test("with no accounts it still logs the tick; a failed market read is said and the tick goes on", async () => {
  const events: LogEvent[] = [];
  const chain = new FakeChain();
  await tick(deps(chain, events, { listAccounts: async () => [], readMarket: async () => { throw new Error("offline"); } }), new Map());
  assert.deepEqual(events.map((e) => e.msg), ["the market reads failed: offline", "0 client account(s) to look at"]);
});

test("config: --once, --account and --dry-run from the command line, testnet only", () => {
  const config = keeperConfig({ NEAR_NETWORK: "testnet", KEEPER_PRIVATE_KEY: "ed25519:x" }, ["--", "--once", "--account", "a.pbf.testnet", "--account", "b.pbf.testnet", "--dry-run"]);
  assert.equal(config.once, true);
  assert.equal(config.dryRun, true);
  assert.deepEqual(config.accounts, ["a.pbf.testnet", "b.pbf.testnet"]);
  assert.equal(config.keeperId, "pbf-keeper.testnet");
  assert.equal(config.gatewayProject, "pbf-keeper.testnet/pb-gateway");
  assert.equal(config.hasKeeperKey, true);
  assert.equal(config.hasPaymentKey, false);
  assert.equal(config.tickMs, 15_000);
  assert.equal(config.statusPort, 8789);
  assert.equal(config.drillId, "drill.pbf-ops.testnet");
  assert.match(config.logFile, /services\/keeper\/logs\/keeper\.jsonl$/);
  assert.equal(keeperConfig({}, []).once, false);
  assert.throws(() => keeperConfig({ NEAR_NETWORK: "mainnet" }, []), /testnet for now/);
  assert.throws(() => keeperConfig({ HL_API_URL: "https://api.hyperliquid.xyz" }, []), /Hyperliquid mainnet/);
});

test("config, Phase 6: the Rhea price job is off until RHEA_ACCOUNT_ID names our copy on testnet; Rhea itself is refused", () => {
  const off = keeperConfig({}, []);
  assert.deepEqual([off.rheaId, off.operatorId, off.hasOperatorKey, off.nbtcId], [undefined, "pbf-ops.testnet", false, "mnbtc.pbf-ops.testnet"]);
  assert.match(off.rheaHoldFile, /services\/keeper\/logs\/rhea-price-hold\.json$/);
  const on = keeperConfig({ RHEA_ACCOUNT_ID: "rhea.pbf-ops.testnet", OPERATOR_PRIVATE_KEY: "ed25519:x", RHEA_PRICE_HOLD_FILE: "/tmp/hold.json" }, []);
  assert.deepEqual([on.rheaId, on.hasOperatorKey, on.rheaHoldFile], ["rhea.pbf-ops.testnet", true, "/tmp/hold.json"]);
  assert.throws(() => keeperConfig({ RHEA_ACCOUNT_ID: "contract.main.burrow.near" }, []), /must be our Rhea copy on testnet/);
  assert.throws(() => keeperConfig({ RHEA_ACCOUNT_ID: "Rhea.testnet" }, []), /must be our Rhea copy on testnet/);
});

// ---------- Phase 6, stage 2 ----------

const USD = 1_000_000;

/**
 * A fake Phase 6 account that has just stored a funding plan (INTERFACES.md 25), with the rules the keeper has to
 * work around: steps in order; a borrowing step only on a fresh, unused, HEALTHY verdict; Rhea's borrow listed as
 * under way for 20 blocks, during which nothing that adds risk runs; the next call after those blocks drops it and
 * moves the counter. A block is a second here, and a verdict arrives 10 s after its check.
 */
class FundingChain {
  now = T0;
  block = 5_000;
  /** What Rhea counts the posted nBTC at, and what is owed there and to our pool, in micro-USD. */
  posted = 0;
  rheaDebt = 0;
  poolDebt = 0;
  /** What the pool would lend in all. */
  poolLine = 530 * USD;
  readonly actions: { at: number; what: string }[] = [];
  readonly settled: number[] = [];
  state: AccountState = {
    owner: "pbf-keeper.testnet",
    counter: 8,
    loan: { principal: "0", open: false },
    // The verdict that answered `fund`, which `fund` used: its nonce is behind the counter.
    verdict: { intent: { fund: { amount: "1100000000" } }, received_block: 4_996, verdict: { ok: true, state: "HEALTHY", action: "NONE", blk: 4_990, nonce: 7 } },
    deleverage: { first_at: "0" },
    plan: null,
    pending: [],
    permission: { lenders: ["rhea"], min_hf_bp: 15_000, max_rate_bp: 2_500, moves: "off" },
    // INTERFACES.md 40.1: the block the permission last changed in. Here, the account's making.
    permission_blk: 4_900,
    funding: {
      pid: "f4990",
      amount: "1100000000",
      stored_at: String(BigInt(T0) * 1_000_000n),
      expires_at: String(BigInt(T0 + 30 * MIN) * 1_000_000n),
      steps: [
        { k: "l_supply", l: "rhea", tok: "mnbtc.pbf-ops.testnet", amt: "1500000", done: false },
        { k: "l_borrow", l: "rhea", amt: 570 * USD, done: false },
        { k: "p_borrow", amt: 530 * USD, done: false },
      ],
    },
  };

  advance(ms: number) {
    this.now += ms;
    this.block += Math.round(ms / S);
  }

  #pending() {
    return (this.state.pending as { lender?: { until_block: number } }[]).find((p) => p.lender)?.lender ?? null;
  }

  /** "The next call after that block drops it and bumps the counter." */
  #dropPassed() {
    const pending = this.#pending();
    if (pending && this.block > pending.until_block) {
      this.state.pending = [];
      this.state.counter += 1;
    }
  }

  check() {
    this.actions.push({ at: this.now, what: "check" });
    this.#dropPassed();
    const room = Math.max(0, Math.floor((this.posted * 7_600) / 15_000) - this.rheaDebt);
    const ext = this.posted || this.rheaDebt ? [{ l: "rhea", c: this.posted, d: this.rheaDebt, hf_bp: this.rheaDebt ? Math.floor((this.posted * 7_600) / this.rheaDebt) : 0, r_bp: 600, s_bp: 300, room, liq_bp: 7_600 }] : [];
    const nonce = this.state.counter;
    this.advance(10 * S);
    this.state.verdict = { intent: { check: {} }, received_block: this.block, verdict: { ok: true, state: "HEALTHY", action: "NONE", blk: this.block - 5, nonce, ext, allow: { borrow: this.poolLine - this.poolDebt, withdraw: 0 } } };
  }

  /** set_permission (INTERFACES.md 40.1): the counter stays where it is, and the account records the block. */
  setPermission() {
    this.actions.push({ at: this.now, what: "set_permission" });
    this.state.permission_blk = this.block;
  }

  #usable(lender = false): string | null {
    const held = this.state.verdict!.verdict;
    // A step that reads the held verdict for a lender refuses one read before the permission last changed.
    if (lender && held.blk <= (this.state.permission_blk ?? 0)) return `the check was read before the permission last changed (block ${this.state.permission_blk}): ask for a new check`;
    if (held.nonce !== this.state.counter) return "the verdict was already used: ask for a new check";
    if (this.block - held.blk > 120) return "the verdict is too old";
    return null;
  }

  executeStep(pid: string, i: number): { ok: boolean; failure?: string } {
    this.actions.push({ at: this.now, what: `execute_step ${pid}:${i}` });
    const funding = this.state.funding as { pid: string; steps: { k: string; amt: number | string; done: boolean }[] };
    const step = funding.steps[i];
    if (funding.pid !== pid || !step || step.done) return { ok: false, failure: "refused" };
    if (funding.steps.slice(0, i).some((s) => !s.done)) return { ok: false, failure: `step ${i} of plan ${pid} must wait` };
    const pending = this.#pending();
    if (pending && this.block <= pending.until_block) return { ok: false, failure: "a lender action is still under way" };
    this.#dropPassed();
    const held = this.state.verdict!.verdict;
    if (step.k === "l_supply") {
      this.posted = 1_130 * USD;
    } else if (step.k === "l_borrow") {
      const why = this.#usable(true);
      if (why) return { ok: false, failure: why };
      const room = (held.ext as { room: number }[] | undefined)?.[0]?.room ?? 0;
      if (room <= 0) return { ok: false, failure: "the verdict gives rhea no room" };
      this.rheaDebt += Math.min(Number(step.amt), room);
      this.state.pending = [{ lender: { lender: "rhea", kind: "borrow", amount: String(step.amt), until_block: this.block + 20 } }];
    } else {
      const why = this.#usable();
      if (why) return { ok: false, failure: why };
      const lent = Math.min(Number(step.amt), held.allow?.borrow ?? 0);
      if (lent <= 0) return { ok: false, failure: "the verdict allows no borrowing now" };
      this.poolDebt += lent;
      this.state.loan = { principal: String(this.poolDebt), open: true };
    }
    step.done = true;
    this.state.counter += 1;
    return { ok: true };
  }
}

function fundingDeps(chain: FundingChain, events: LogEvent[], overrides: Partial<KeeperDeps> = {}): KeeperDeps {
  return {
    readMarket: async () => ({ prices: { marks: { BTC: 76_000 }, pi: {}, lenders: { rhea: 76_000 } }, chainNowMs: chain.now, readAt: chain.now, chainBlock: chain.block, summary: { block: chain.block } }),
    listAccounts: async () => [ACCOUNT],
    readState: async () => structuredClone(chain.state),
    blockTimeMs: async () => chain.now,
    readPerps: async () => [],
    requestCheck: async () => {
      chain.check();
      return { ok: true, hash: `tx-check-${chain.actions.length}`, accepted: true, reason: null, attestationUrl: null, seconds: 10 };
    },
    runGateway: async () => {
      throw new Error("no gateway run in this test");
    },
    executeStep: async (_account, pid, i) => {
      const r = chain.executeStep(pid, i);
      return { ok: r.ok, hash: `tx-step-${i}`, logs: [], seconds: 3, retry: false, ...(r.failure ? { failure: r.failure } : {}) };
    },
    settle: async () => {
      chain.settled.push(chain.now);
      return { ok: true, hash: "tx-settle", result: { fee: "380", subsidy: "0", credit: "0", period_ns: "3600000000000" }, logs: [], seconds: 2, retry: false };
    },
    log: (event, msg, fields = {}) => events.push({ t: new Date(chain.now).toISOString(), event, msg, ...fields }),
    now: () => chain.now,
    random: () => 0.99,
    ...overrides,
  };
}

test("Phase 6: a funding plan, tick by tick: the collateral at once, a check and Rhea's borrow, 20 blocks, a check and our pool's borrow, then one last check", async () => {
  const chain = new FundingChain();
  const events: LogEvent[] = [];
  const d = fundingDeps(chain, events);
  const memory = new Map<string, AccountMemory>();
  while (chain.now < T0 + 4 * MIN) {
    const started = chain.now;
    await tick(d, memory);
    if (chain.now < started + 15 * S) chain.advance(started + 15 * S - chain.now);
  }
  const at = (ms: number) => Math.round((ms - T0) / S);
  assert.deepEqual(chain.actions.map((a) => `${at(a.at)} s ${a.what}`), [
    "0 s execute_step f4990:0", // no pool debt yet: the nBTC goes to Rhea without a check
    "15 s check", // the borrow at Rhea needs a verdict made after the collateral arrived
    "30 s execute_step f4990:1", // it gives Rhea $572 of room: borrow $570. Listed as under way until block 5050
    "60 s check", // block 5060: the 20 blocks have passed. One fresh check, which is the pool step's check too
    "75 s execute_step f4990:2", // our pool lends $530
    "90 s check", // every step has run: where does the account stand?
  ]);
  assert.deepEqual([chain.posted, chain.rheaDebt, chain.poolDebt], [1_130 * USD, 570 * USD, 530 * USD]);
  assert.ok((chain.state.funding as { steps: { done: boolean }[] }).steps.every((s) => s.done));

  // Every step and check is in the log with its transaction, and the wait is said once in plain words.
  assert.deepEqual(events.filter((e) => e.event === "step").map((e) => [e.pid, e.i, e.k, e.ok, e.tx]), [
    ["f4990", 0, "l_supply", true, "tx-step-0"],
    ["f4990", 1, "l_borrow", true, "tx-step-1"],
    ["f4990", 2, "p_borrow", true, "tx-step-2"],
  ]);
  assert.deepEqual(events.filter((e) => e.event === "note").map((e) => e.msg), ["step 2 (p_borrow) of funding plan f4990 waits: the account counts its borrow at Rhea as under way until block 5050 has passed"]);
  const why = events.filter((e) => e.event === "decide" && e.action === "request_check").map((e) => e.msg);
  assert.match(why[0]!, /^step 1 \(l_borrow\) of funding plan f4990 needs a fresh check first/);
  assert.equal(why[1], "the account counted its borrow at Rhea as under way until block 5050, which has passed: a fresh check");
  assert.match(why[2]!, /^the steps of funding plan f4990 have run/);

  // The account's line shows the plan's progress, the lender position and the action under way.
  const shown = events.filter((e) => e.event === "account");
  assert.deepEqual((shown[0]!.funding as { steps: { k: string; done: boolean }[] }).steps.map((s) => `${s.k}:${s.done}`), ["l_supply:false", "l_borrow:false", "p_borrow:false"]);
  assert.ok(shown.some((e) => (e.pending_lender as { until_block?: number } | undefined)?.until_block === 5_050));
  assert.deepEqual((shown.at(-1)!.lenders as { d: number; hf_bp: number }[]).map((l) => [l.d, l.hf_bp]), [[570 * USD, 15_066]]);
  assert.equal(shown.at(-1)!.loan, true);
});

test("Phase 6: an account with only a lender loan is watched like any other; the hourly check is followed by settle(), which is held back while the check hasn't come back", async () => {
  const chain = new FundingChain();
  chain.posted = 1_130 * USD;
  chain.rheaDebt = 570 * USD;
  chain.state.funding = null;
  chain.check(); // a verdict that shows the Rhea loan: nothing is owed to our pool
  const events: LogEvent[] = [];
  let checkWorks = true;
  let asked = 0;
  const d = fundingDeps(chain, events, {
    random: () => 0, // the hourly check lands at 13:00
    requestCheck: async () => {
      asked += 1;
      // The RPC stopped waiting before the verdict was back: no outcome, so no hash.
      if (!checkWorks) return { ok: false, hash: null, attestationUrl: null, seconds: 120, failure: "RPC timeout" };
      chain.check();
      return { ok: true, hash: "tx-check", accepted: true, reason: null, attestationUrl: null, seconds: 10 };
    },
  });
  const memory = new Map<string, AccountMemory>();
  await tick(d, memory);
  assert.equal(events.find((e) => e.event === "account")!.loan, true, "a debt at a lender is a loan");
  chain.advance(Date.UTC(2026, 10, 10, 13, 0) - chain.now);
  checkWorks = false;
  await tick(d, memory);
  assert.deepEqual(chain.settled, [], "no fresh verdict, no settle()");
  assert.equal(events.filter((e) => e.event === "settle").at(-1)!.msg, "not settled this time: the check before it brought no verdict, so it goes behind the next check");
  const lost = events.filter((e) => e.event === "check").at(-1)!;
  assert.equal(lost.msg, "the check failed to come back: RPC timeout. Its verdict may still land, so the keeper asks for another only if none has 150 s after it asked");
  assert.deepEqual([lost.tx, lost.unseen], [null, true]);
  // One check at a time: the first may still be waiting its turn at OutLayer, so the next ticks ask for no other.
  checkWorks = true;
  for (let i = 0; i < 9; i++) {
    chain.advance(15 * S);
    await tick(d, memory);
  }
  assert.deepEqual([asked, chain.settled.length], [1, 0], "135 s after it asked: still the one check");
  assert.equal(events.filter((e) => e.event === "decide" && e.action === "request_check").length, 1);
  // 150 s after it asked, with no verdict: the check again, and the settlement behind it.
  chain.advance(15 * S);
  await tick(d, memory);
  assert.equal(asked, 2);
  assert.equal(events.filter((e) => e.event === "decide" && e.action === "request_check").at(-1)!.msg, "again: the hourly sample for the rating");
  assert.equal(chain.settled.length, 1);
  const settle = events.filter((e) => e.event === "settle").at(-1)!;
  assert.equal(settle.msg, "settled: a fee of $0.00038 was added to what the account owes our pool");
  assert.deepEqual([settle.tx, settle.fee, settle.subsidy, settle.period_ns], ["tx-settle", "380", "0", "3600000000000"]);
  chain.advance(15 * S);
  await tick(d, memory);
  assert.equal(chain.settled.length, 1, "once an hour");
});

test("one check at a time: a check the chain reported as failed is asked again on the next tick; one that didn't come back but brings its verdict after all is not, and the settlement goes out on that verdict", async () => {
  const chain = new FundingChain();
  chain.posted = 1_130 * USD;
  chain.rheaDebt = 570 * USD;
  chain.state.funding = null;
  chain.check();
  const events: LogEvent[] = [];
  let outcome: "works" | "unseen" | "failed" = "works";
  let asked = 0;
  const d = fundingDeps(chain, events, {
    random: () => 0, // the hourly check lands at 13:00
    requestCheck: async () => {
      asked += 1;
      if (outcome === "unseen") return { ok: false, hash: null, attestationUrl: null, seconds: 120, failure: "RPC timeout" };
      if (outcome === "failed") return { ok: false, hash: "tx-failed", attestationUrl: null, seconds: 4, failure: "a receipt failed: the yield timed out" };
      chain.check();
      return { ok: true, hash: "tx-check", accepted: true, reason: null, attestationUrl: null, seconds: 10 };
    },
  });
  const memory = new Map<string, AccountMemory>();
  const last = (event: string) => events.filter((e) => e.event === event).at(-1)!;
  await tick(d, memory);
  chain.advance(Date.UTC(2026, 10, 10, 13, 0) - chain.now);

  // The chain says the check failed: it is over, so the next tick asks again.
  outcome = "failed";
  await tick(d, memory);
  assert.equal(last("check").msg, "the check failed: a receipt failed: the yield timed out");
  assert.equal(last("check").unseen, undefined);
  chain.advance(15 * S);
  outcome = "unseen";
  await tick(d, memory);
  assert.equal(asked, 2, "asked again on the next tick");
  assert.match(String(last("check").msg), /^the check failed to come back: RPC timeout/);

  // This one's end wasn't seen. The keeper asks for no other, and 25 s later its verdict lands after all.
  chain.advance(15 * S);
  outcome = "works";
  await tick(d, memory);
  assert.deepEqual([asked, chain.settled.length], [2, 0]);
  chain.check();
  await tick(d, memory);
  assert.equal(asked, 2, "the first brought its verdict: no second check");
  assert.equal(chain.settled.length, 1, "and the settlement that waited for it goes out on it");
  assert.equal(events.filter((e) => e.event === "decide" && e.action === "settle").at(-1)!.msg, "the hourly settlement, on the check that has now come back: what the client pays on the lender's part against the operator's price");
  chain.advance(15 * S);
  await tick(d, memory);
  assert.deepEqual([asked, chain.settled.length], [2, 1], "once an hour");
});

test("Phase 6: the pool's answer to a settlement, in words", () => {
  assert.equal(settleWords({ skipped: "the last settlement was 4 minutes ago" }).words, "nothing settled: the last settlement was 4 minutes ago");
  assert.equal(settleWords({ fee: "0", subsidy: "457500", credit: "0", period_ns: "3600000000000" }).words, "settled: a subsidy of $0.4575 was taken off what the account owes our pool");
  assert.equal(settleWords({ fee: "0", subsidy: "12340000", credit: "2000000", period_ns: "1" }).words, "settled: a subsidy of $12.34 was taken off what the account owes our pool; $2.00 of credit is the account's to claim");
  assert.equal(settleWords({ fee: "0", subsidy: "0", credit: "0", period_ns: "1" }).words, "settled: nothing to add or take off this time");
  assert.equal(settleWords(true).words, "settle() answered true");
  assert.deepEqual([showMicroUsd("94500000000"), showMicroUsd(380), showMicroUsd("x")], ["$94,500.00", "$0.00038", "$0.00"]);
});

test("an account made before Phase 6 is shown as before, with no funding plan and no lenders", async () => {
  const old = new FakeChain();
  const oldEvents: LogEvent[] = [];
  await tick(deps(old, oldEvents), new Map());
  const line = oldEvents.find((e) => e.event === "account" && e.account === ACCOUNT)!;
  assert.deepEqual(["funding" in line, "lenders" in line, "pending_lender" in line], [false, false, false]);
});

test("Stage 3, tick by tick: the keeper approves the collateral, sends each transaction the moment the account has signed it, and runs the next step only once the chain has used its nonce", async () => {
  const wbtc = "0x54114591963cf60ef3aa63befd6ec263d98145a4";
  const aave: AaveSettings = { chainId: 84_532, pool: "0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27", usdc: { symbol: "USDC", address: "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f", decimals: 6 }, collateral: [{ symbol: "WBTC", address: wbtc, decimals: 8 }], maxFeePerGas: "1000000000" };
  let now = T0;
  let block = 5_000;
  /** How many of the account's transactions Aave's chain has used, and the nonces sent to it. */
  let chainNonce = 0;
  const sentToChain: number[] = [];
  const calls: string[] = [];
  const evm = { nonce: 0, signed: [] as { nonce: number; kind: string; token: string; amount: string; raw: string; hash: string; step: string | null }[] };
  const steps = [
    { k: "l_supply", l: "aave", tok: "0x54114591963CF60EF3aA63bEfD6eC263D98145a4", amt: "1500000", done: false },
    { k: "p_borrow", amt: 530 * USD, done: false },
  ];
  const state: AccountState = {
    owner: "pbf-keeper.testnet",
    counter: 8,
    loan: { principal: "0", open: false },
    verdict: { intent: { fund: { amount: "530000000" } }, received_block: 4_996, verdict: { ok: true, state: "HEALTHY", action: "NONE", blk: 4_990, nonce: 7, evm: { nonce: 0 } } },
    deleverage: { first_at: "0" },
    plan: null,
    pending: [],
    hl: { path: "hl", address: "0x2031181d63507368232579af4c64a1c3428407ff" },
    funding: { pid: "f4990", amount: "530000000", stored_at: String(BigInt(T0) * 1_000_000n), expires_at: String(BigInt(T0 + 30 * MIN) * 1_000_000n), steps },
    evm,
  };
  /** The account has the signer sign a transaction and stores it. */
  const sign = (kind: string, step: string | null) => {
    evm.signed.push({ nonce: evm.nonce, kind, token: wbtc, amount: "1500000", raw: "0x02", hash: `0x${String(evm.nonce).padStart(64, "0")}`, step });
    evm.nonce += 1;
  };
  const ok = { ok: true, hash: "tx", logs: [], seconds: 1, retry: false };
  const events: LogEvent[] = [];
  const deps: KeeperDeps = {
    readMarket: async () => ({ prices: { marks: { BTC: 76_000 }, pi: {} }, chainNowMs: now, readAt: now, chainBlock: block, summary: { block } }),
    listAccounts: async () => [ACCOUNT],
    readState: async () => structuredClone(state),
    blockTimeMs: async () => now,
    readPerps: async () => [],
    requestCheck: async () => {
      calls.push("check");
      // The engine reads Aave's chain as it stands: its verdict says how many nonces the chain had used.
      state.verdict = { intent: { check: {} }, received_block: block + 2, verdict: { ok: true, state: "HEALTHY", action: "NONE", blk: block, nonce: state.counter, evm: { nonce: chainNonce }, allow: { borrow: 530 * USD } } };
      return { ok: true, hash: "tx-check", accepted: true, reason: null, attestationUrl: null, seconds: 5 };
    },
    runGateway: async () => {
      throw new Error("no gateway run in this test");
    },
    executeStep: async (_account, pid, i) => {
      calls.push(`step ${pid}:${i}`);
      steps[i]!.done = true;
      if (i === 0) sign("supply", `${pid}:0`);
      else state.loan = { principal: String(530 * USD), open: true };
      return ok;
    },
    readAave: async () => aave,
    readEvmNonce: async () => chainNonce,
    readApproved: async (token) => token === wbtc && chainNonce >= 1,
    evmApprove: async (_account, token) => {
      calls.push(`approve ${token}`);
      sign("approve", null);
      return ok;
    },
    sendEvm: async (_account, latest, known) => {
      const lines: string[] = [];
      for (const e of readEvm(latest)!.signed) {
        if (e.nonce < known || sentToChain.includes(e.nonce)) continue;
        sentToChain.push(e.nonce);
        lines.push(`signed transaction ${e.nonce} (${e.kind}) sent`);
      }
      return lines;
    },
    log: (event, msg, fields = {}) => events.push({ t: new Date(now).toISOString(), event, msg, ...fields }),
    now: () => now,
    random: () => 0.99,
  };
  const memory = new Map<string, AccountMemory>();
  const seenAt: Record<number, string[]> = {};
  for (let i = 1; i <= 6; i += 1) {
    const before = calls.length;
    await tick(deps, memory);
    seenAt[i] = calls.slice(before);
    // Aave's chain mines what it was sent before the next tick.
    chainNonce = sentToChain.length;
    now += 15 * S;
    block += 15;
  }
  assert.deepEqual(seenAt, {
    1: [`approve ${wbtc}`],
    2: ["step f4990:0"],
    // The supply is mined: a fresh check, whose verdict has read Aave after it.
    3: ["check"],
    4: ["step f4990:1"],
    5: ["check"],
    6: [],
  });
  // Each transaction went out on the tick that signed it, not one later.
  assert.deepEqual(events.filter((e) => e.event === "evm_send").map((e) => [e.t, e.msg]), [
    [new Date(T0).toISOString(), "signed transaction 0 (approve) sent"],
    [new Date(T0 + 15 * S).toISOString(), "signed transaction 1 (supply) sent"],
  ]);
  assert.equal(events.find((e) => e.event === "evm")!.msg, `evm_approve for ${wbtc}: the account signed the transaction`);
  assert.deepEqual(memory.get(ACCOUNT)!.approved, [wbtc]);
  assert.deepEqual((events.filter((e) => e.event === "account").at(-1) as { evm?: unknown }).evm, { nonce: 2, chain_nonce: 2, pending: [] });
});

// ---------- The fixes after the second audit pass (INTERFACES.md 40.4, items 10 to 12) ----------

test("the audit's A8, tick by tick: the owner changes the permission after the keeper's check, the counter stays where it was, and the keeper asks for a new check before Rhea's borrow", async () => {
  const chain = new FundingChain();
  const events: LogEvent[] = [];
  const d = fundingDeps(chain, events);
  const memory = new Map<string, AccountMemory>();
  let counterThen: number | null = null;
  while (chain.now < T0 + 4 * MIN) {
    const started = chain.now;
    await tick(d, memory);
    if (chain.now < started + 15 * S) chain.advance(started + 15 * S - chain.now);
    // Right after the keeper's first check has come back, the owner signs set_permission again.
    if (counterThen === null && chain.actions.some((a) => a.what === "check")) {
      counterThen = chain.state.counter;
      chain.setPermission();
      assert.equal(chain.state.counter, counterThen, "set_permission no longer moves the counter");
    }
  }
  const at = (ms: number) => Math.round((ms - T0) / S);
  assert.deepEqual(chain.actions.map((a) => `${at(a.at)} s ${a.what}`), [
    "0 s execute_step f4990:0",
    "15 s check", // read at block 5020
    "30 s set_permission", // block 5030: the check just made is from before it
    "30 s check", // so not the borrow, which the account would refuse: a new check, at once
    "45 s execute_step f4990:1", // on a check read after the change
    "75 s check",
    "90 s execute_step f4990:2",
    "105 s check",
  ]);
  assert.deepEqual(events.filter((e) => e.event === "step").map((e) => [e.i, e.k, e.ok]), [[0, "l_supply", true], [1, "l_borrow", true], [2, "p_borrow", true]], "no step was sent to be refused");
  assert.equal(events.filter((e) => e.event === "decide" && e.action === "request_check").map((e) => e.msg)[1], "step 1 (l_borrow) of funding plan f4990 needs a fresh check first: the last one was read before the permission last changed (block 5030)");
  assert.deepEqual([chain.rheaDebt, chain.poolDebt], [570 * USD, 530 * USD]);
});

test("the audit's P4: after a check, a debt the pool's last report still shows at a lender, and the new verdict doesn't, is settled once; the pool's record is read no more than it must be", async () => {
  const chain = new FundingChain();
  chain.posted = 1_130 * USD;
  chain.rheaDebt = 570 * USD;
  chain.state.funding = null;
  chain.check(); // a verdict that shows the Rhea loan
  const events: LogEvent[] = [];
  // The pool's record of the account: its last settlement stored a report with $570 owed at Rhea.
  const pool = { last: [{ lender: "rhea", debt: String(570 * USD) }] as { lender: string; debt: string }[] | null, takes: true };
  let reads = 0;
  const d = fundingDeps(chain, events, {
    readPricing: async () => {
      reads += 1;
      return pool.last ? { last: structuredClone(pool.last) } : null;
    },
    settle: async () => {
      chain.settled.push(chain.now);
      // The pool stores the verdict's report as its last, unless it answers "too soon" and changes nothing. The
      // account's settle() answers true either way.
      if (pool.takes) pool.last = [{ lender: "rhea", debt: String(chain.rheaDebt) }];
      return { ok: true, hash: `tx-settle-${chain.settled.length}`, result: true, logs: [], seconds: 2, retry: false };
    },
  });
  const memory = new Map<string, AccountMemory>();
  /** A check lands (the client's own, say), and the keeper looks. */
  const checked = async () => {
    chain.advance(15 * S);
    chain.check();
    await tick(d, memory);
    return [reads, chain.settled.length];
  };
  const idle = async () => {
    chain.advance(15 * S);
    await tick(d, memory);
    return [reads, chain.settled.length];
  };

  // Rhea is owed: nothing to settle. One read tells the keeper the pool holds no line for Aave, and it asks no more.
  await tick(d, memory);
  assert.deepEqual([reads, chain.settled.length], [1, 0]);
  assert.deepEqual(await checked(), [1, 0], "a new verdict that still shows Rhea owed: no read");
  assert.deepEqual(await idle(), [1, 0]);

  // The client repays Rhea, and a check shows nothing owed there. The pool's last report still says $570: one settlement.
  chain.rheaDebt = 0;
  assert.deepEqual(await checked(), [2, 1]);
  assert.deepEqual(events.filter((e) => e.event === "decide" && e.action === "settle").map((e) => e.msg), ["the pool's last report still shows debt at Rhea, and this check shows nothing owed there: one settlement, so the pool's record says so too"]);
  assert.deepEqual(events.filter((e) => e.event === "settle").map((e) => [e.msg, e.tx, e.ok]), [["settle() answered true", "tx-settle-1", true]]);
  assert.deepEqual(pool.last, [{ lender: "rhea", debt: "0" }], "the pool now holds a report of zero");
  // It doesn't repeat: not on the same verdict, and after the next check one read shows the zero. Then no read at all.
  assert.deepEqual(await idle(), [2, 1]);
  assert.deepEqual(await checked(), [3, 1]);
  assert.deepEqual(await checked(), [3, 1]);
  assert.deepEqual(await checked(), [3, 1]);

  // Borrowed again and repaid again. This time the pool answers "too soon" and keeps its report: the keeper settles
  // again after the next check, and stops once the record shows zero.
  chain.rheaDebt = 100 * USD;
  pool.last = [{ lender: "rhea", debt: String(100 * USD) }];
  assert.deepEqual(await checked(), [3, 1], "owed: nothing to look at");
  chain.rheaDebt = 0;
  pool.takes = false;
  assert.deepEqual(await checked(), [4, 2]);
  assert.deepEqual(pool.last, [{ lender: "rhea", debt: String(100 * USD) }]);
  pool.takes = true;
  assert.deepEqual(await checked(), [5, 3]);
  assert.deepEqual(await checked(), [6, 3]);
  assert.deepEqual(await checked(), [6, 3]);

  // Not on a verdict the account can't settle on: one that an action has used, or one read while a lender action is
  // still listed as under way (it may not show that lender's debt yet). Neither costs a read.
  chain.rheaDebt = 50 * USD;
  pool.last = [{ lender: "rhea", debt: String(50 * USD) }];
  await checked();
  chain.rheaDebt = 0;
  chain.advance(15 * S);
  chain.check();
  chain.state.counter += 1; // something used the verdict
  await tick(d, memory);
  assert.deepEqual([reads, chain.settled.length], [6, 3]);
  chain.advance(15 * S);
  chain.check();
  chain.state.pending = [{ lender: { lender: "rhea", kind: "borrow", amount: "50000000", until_block: chain.block + 20 } }];
  await tick(d, memory);
  assert.deepEqual([reads, chain.settled.length], [6, 3]);
  // Nor on a verdict too old for the account to settle on (the first one a keeper sees after it starts may be days old).
  chain.state.pending = [];
  chain.advance(15 * S);
  chain.check();
  chain.advance(100 * S); // a block is a second here: 105 blocks after the verdict was read, and the keeper's limit is 90
  await tick(d, memory);
  assert.deepEqual([reads, chain.settled.length], [6, 3]);
  // The next plain check: one read, one settlement.
  assert.deepEqual(await checked(), [7, 4]);

  // An account the pool has no record of, and a keeper with no way to read the record: one read at most, no settlement.
  const fresh = new FundingChain();
  fresh.state.funding = null;
  fresh.check();
  let freshReads = 0;
  const none = fundingDeps(fresh, [], { readPricing: async () => ((freshReads += 1), null) });
  const m2 = new Map<string, AccountMemory>();
  for (let i = 0; i < 3; i++) {
    await tick(none, m2);
    fresh.advance(15 * S);
    fresh.check();
  }
  assert.deepEqual([freshReads, fresh.settled.length], [1, 0]);
  const blind = new Map<string, AccountMemory>();
  await tick(fundingDeps(fresh, []), blind);
  assert.equal(fresh.settled.length, 0);
});

test("the audit's A7: a transfer whose deadline is more than 24.5 hours ahead is logged as move_far, once", async () => {
  const chain = new FakeChain();
  const events: LogEvent[] = [];
  const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
  const HOUR = 60 * MIN;
  chain.state.pending = [
    // A real quote lives a day at most, and the deadline is its expiry and 30 minutes: this one is as late as a real one gets.
    { transfer: { id: "move:3", kind: "to_hl", token: "musdc.pbf-ops.testnet", amount: "11000000", dep: "ab".repeat(32), deadline: ns(T0 + 24 * HOUR + 30 * MIN) } },
    // An account made before the fix took any expiry: here, 30 days.
    { transfer: { id: "move:4", kind: "e_home", token: "USDC", amount: "1000000000000", dep: "0x2031181d63507368232579af4c64a1c3428407ff", deadline: ns(T0 + 30 * 24 * HOUR) } },
  ];
  const d = deps(chain, events);
  const memory = new Map<string, AccountMemory>();
  for (let i = 0; i < 3; i++) {
    await tick(d, memory);
    chain.now += 15 * S;
  }
  const far = events.filter((e) => e.event === "move_far");
  assert.deepEqual(far.map((e) => e.msg), [
    "transfer move:4 (e_home) is listed as on its way until 2026-12-10T12:20:00.000Z, 720 hours from now. A 1Click quote lasts a day at most, so no real transfer has a deadline that far off. Only an account made before the fix of 12 Nov can record one",
  ]);
  assert.deepEqual([far[0]!.account, far[0]!.id, far[0]!.kind, far[0]!.token, far[0]!.amount, far[0]!.hours_ahead], [ACCOUNT, "move:4", "e_home", "USDC", "1000000000000", 720]);
  // One second past 24.5 hours is far; and a plan step's transfer is looked at the same way as the owner's move.
  chain.state.pending = [{ transfer: { id: "9000:1", kind: "sell", token: "mnbtc.pbf-ops.testnet", amount: "5", dep: "cd".repeat(32), deadline: ns(chain.now + 24 * HOUR + 30 * MIN + S) } }];
  await tick(d, memory);
  assert.equal(events.filter((e) => e.event === "move_far").at(-1)!.id, "9000:1");
  assert.equal(MOVE_FAR_MS, 24.5 * HOUR);
});

test("the audit's P4: the settlement that reports a repaid lender as zero goes out before a step of the same tick borrows there again", async () => {
  // The client borrowed at Rhea before and repaid it: the pool's last report still shows $570 owed there. Now a new
  // funding plan is stored (the default plan of these tests), and its second step borrows at Rhea again.
  const chain = new FundingChain();
  const events: LogEvent[] = [];
  let last = [{ lender: "rhea", debt: String(570 * USD) }];
  const d = fundingDeps(chain, events, {
    readPricing: async () => ({ last: structuredClone(last) }),
    settle: async () => {
      chain.settled.push(chain.now);
      last = [{ lender: "rhea", debt: String(chain.rheaDebt) }];
      return { ok: true, hash: "tx-settle", result: true, logs: [], seconds: 2, retry: false };
    },
  });
  const memory = new Map<string, AccountMemory>();
  while (chain.now < T0 + 45 * S) {
    const started = chain.now;
    await tick(d, memory);
    if (chain.now < started + 15 * S) chain.advance(started + 15 * S - chain.now);
  }
  // 0 s: the held verdict is the one `fund` used, so nothing can settle on it. 15 s: the keeper asks for the borrow's
  // check. 30 s: that verdict shows nothing owed at Rhea: the zero is reported first, then the borrow runs.
  const order = events.filter((e) => e.event === "settle" || e.event === "step" || e.event === "check").map((e) => (e.event === "step" ? `step ${e.i} ${e.k}` : e.event));
  assert.deepEqual(order, ["step 0 l_supply", "check", "settle", "step 1 l_borrow"]);
  assert.deepEqual(chain.settled.map((at) => Math.round((at - T0) / S)), [30]);
  assert.equal(chain.rheaDebt, 570 * USD, "and the borrow went through on the same verdict: settle() leaves the counter alone");
});

// ---------- INTERFACES.md 44: the keeper's price watch, measured from the verdict's own block ----------

/** A check of the Rhea gate's account on 12 Nov, as the account stored it: read at `blk`, with `debt` owed at Rhea on a cushion of `hf`. */
const gateVerdict = (blk: number, received: number, debt: number, hf: number): NonNullable<AccountState["verdict"]> => ({
  intent: { check: {} },
  received_block: received,
  verdict: { ok: true, state: "HEALTHY", action: "NONE", blk, nonce: 9, ext: [{ l: "rhea", c: 1_072_437_000, d: debt, hf_bp: hf, r_bp: 600, s_bp: 300, room: 0, liq_bp: 7_600 }], allow: { borrow: 0, withdraw: 0 } },
});

/**
 * The Rhea gate's account on 12 Nov at 15:17 UTC (INTERFACES.md 43): $541.98 owed at Rhea on a cushion of 1.50,
 * nothing owed to our pool, no plan. Its last verdict is the gate's own, and the keeper asked for none in the last
 * five minutes. `rhea` is what our Rhea copy counts a bitcoin at, which the market read carries.
 */
function gateOf12Nov(events: LogEvent[], overrides: Partial<KeeperDeps> = {}) {
  const chain = new FundingChain();
  chain.state.funding = null;
  chain.state.counter = 9;
  chain.rheaDebt = 541_984_373;
  chain.posted = 1_072_437_000;
  chain.state.verdict = gateVerdict(277_380_071, 277_380_097, 541_983_997, 15_032);
  const copy = { rhea: 71_498.2 };
  const d = fundingDeps(chain, events, {
    readMarket: async () => ({ prices: { marks: { BTC: 71_480 }, pi: {}, lenders: { rhea: copy.rhea } }, chainNowMs: chain.now, readAt: chain.now, chainBlock: chain.block, summary: { block: chain.block, rhea_btc: copy.rhea } }),
    ...overrides,
  });
  const memory = new Map<string, AccountMemory>();
  /** One tick that began at `block`, at 15:mm:ss UTC. */
  const tickAt = async (minute: number, second: number, block: number) => {
    chain.now = Date.UTC(2026, 10, 12, 15, minute, second);
    chain.block = block;
    await tick(d, memory);
  };
  /** The gate's hold: the keeper sets our Rhea copy's price 13.56% under the oracle, and Rhea counts the collateral for that much less. */
  const drop = () => {
    copy.rhea = 61_807.19;
    chain.posted = Math.round((1_072_437_000 * 61_807.19) / 71_498.2);
  };
  return { chain, memory, tickAt, drop };
}

const CUSHION_OF_12_NOV = "Rhea's cushion was 1.50 at the last check, and bitcoin's price at Rhea has gone from $71,498.2 to $61,807.19 since: about 1.300 now, under 1.35, where it gets topped up";

test("INTERFACES.md 44, the 12 Nov sequence tick by tick: the gate's check is read, our Rhea copy's price is then set 13.6% lower, the keeper first sees that verdict a tick later, and it asks for a check on Rhea's cushion at once", async () => {
  const events: LogEvent[] = [];
  const { chain, memory, tickAt, drop } = gateOf12Nov(events);
  // 15:17:37, 15:17:52 and 15:18:07: the copy counts a bitcoin at $71,498.20, and nothing asks for a check.
  await tickAt(17, 37, 277_380_294);
  await tickAt(17, 52, 277_380_321);
  await tickAt(18, 7, 277_380_349);
  assert.deepEqual([chain.actions, events.filter((e) => e.event === "decide")], [[], []]);

  // The gate's own check: read at block 277380343 with a cushion of 1.50, stored in block 277380363 (15:18:15). The
  // gate's hold then drops the price, and the keeper's next tick, which began at block 277380377, sets the copy to
  // $61,807.19 and only then looks at the account: the first it sees of that verdict.
  chain.state.verdict = gateVerdict(277_380_343, 277_380_363, 541_984_373, 15_038);
  drop();
  await tickAt(18, 26, 277_380_377);
  const seenNow = events.filter((e) => e.event === "verdict").at(-1)!;
  assert.deepEqual([seenNow.blk, seenNow.received_block], [277_380_343, 277_380_363]);
  // The cushion decision, measured from what the keeper read by block 277380343, and the check.
  assert.deepEqual(events.filter((e) => e.event === "decide").map((e) => [e.action, e.msg]), [["request_check", CUSHION_OF_12_NOV]]);
  assert.deepEqual(chain.actions.map((a) => a.what), ["check"]);
  const check = events.filter((e) => e.event === "check").at(-1)!;
  assert.deepEqual([check.msg, check.why], ["asked for a check; the verdict is in", CUSHION_OF_12_NOV]);

  // The keeper's own check shows the cushion at 1.30, where the engine plans the top-up. That verdict is measured
  // from the moment the keeper asked, as before: no second check.
  await tickAt(18, 51, 277_380_422);
  const own = events.filter((e) => e.event === "account").at(-1)!;
  assert.deepEqual((own.lenders as { hf_bp: number }[]).map((l) => l.hf_bp), [12_999]);
  await tickAt(19, 6, 277_380_449);
  assert.equal(chain.actions.length, 1);
});

test("INTERFACES.md 44: a tick the account skips on an error loses no check: the verdict is first seen a tick later, and is still measured from its own block", async () => {
  const events: LogEvent[] = [];
  let limited = false;
  const { chain, memory, tickAt, drop } = gateOf12Nov(events, {
    readState: async () => {
      if (limited) throw new Error("Rate limits exceeded");
      return structuredClone(chain.state);
    },
  });
  await tickAt(17, 37, 277_380_294);
  await tickAt(17, 52, 277_380_321);
  await tickAt(18, 7, 277_380_349);
  chain.state.verdict = gateVerdict(277_380_343, 277_380_363, 541_984_373, 15_038);
  drop();
  // The tick that would have seen the new verdict first can't read the account.
  limited = true;
  await tickAt(18, 26, 277_380_377);
  assert.equal(events.at(-1)!.msg, "skipped this tick: Rate limits exceeded");
  assert.equal(chain.actions.length, 0);
  assert.deepEqual(memory.get(ACCOUNT)!.kept!.map((k) => k.block), [277_380_294, 277_380_321, 277_380_349], "a tick that read nothing of the account keeps nothing for it");
  // The next one can, 15 s later: the check is still due, and goes out.
  limited = false;
  await tickAt(18, 41, 277_380_404);
  assert.deepEqual(events.filter((e) => e.event === "decide").map((e) => [e.action, e.msg]), [["request_check", CUSHION_OF_12_NOV]]);
  assert.deepEqual(chain.actions.map((a) => a.what), ["check"]);
});

test("INTERFACES.md 44: each tick's prices are kept with the final block the tick began at, for 10 minutes; a tick with no block, or whose read of the account's own ratio failed, is not kept", async () => {
  const events: LogEvent[] = [];
  let ratio: number | Error = 9_900;
  let block = true;
  const { chain, memory, tickAt } = gateOf12Nov(events, {
    readRatioFor: async () => {
      if (ratio instanceof Error) throw ratio;
      return ratio;
    },
    readMarket: async () => ({ prices: { marks: { BTC: 71_480 }, pi: { nBTC: 10_000 }, lenders: { rhea: 71_498.2 } }, chainNowMs: chain.now, readAt: chain.now, ...(block ? { chainBlock: chain.block } : {}), summary: {} }),
  });
  const kept = () => memory.get(ACCOUNT)!.kept!;
  // 45 ticks, 15 s and 27 blocks apart, from 15:00:00: the last 41 of them span 10 minutes.
  for (let i = 0; i < 45; i++) await tickAt(Math.floor(i / 4), (i % 4) * 15, 277_000_000 + i * 27);
  assert.equal(KEEP_PRICES_MS, 10 * MIN);
  assert.equal(kept().length, 41);
  assert.deepEqual([kept()[0]!.block, kept().at(-1)!.block], [277_000_000 + 4 * 27, 277_000_000 + 44 * 27]);
  assert.equal(chain.now - kept()[0]!.at, 10 * MIN);
  // What is kept is what the account was shown: the market's prices, with the account's own ratio.
  assert.deepEqual(kept().at(-1)!.prices, { marks: { BTC: 71_480 }, pi: { nBTC: 9_900 }, lenders: { rhea: 71_498.2 } });

  // The account's own ratio can't be read: the tick goes on with the shared one, as before, but isn't kept.
  ratio = new Error("Rate limits exceeded");
  await tickAt(11, 15, 277_000_000 + 45 * 27);
  assert.deepEqual([kept().length, kept().at(-1)!.block], [40, 277_000_000 + 44 * 27]);
  // No block was read: not kept either.
  ratio = 9_900;
  block = false;
  await tickAt(11, 30, 277_000_000 + 46 * 27);
  assert.deepEqual([kept().length, kept().at(-1)!.block], [39, 277_000_000 + 44 * 27]);
  block = true;
  await tickAt(11, 45, 277_000_000 + 47 * 27);
  assert.deepEqual([kept().length, kept().at(-1)!.block], [39, 277_000_000 + 47 * 27]);
});

// ---------- INTERFACES.md 45.3: the pool's three findings, the keeper's side ----------

/** The two lines a settlement leaves in its transaction's logs, as gate 2's own run of 12 Nov shows them (research/data/phase6_funding_rhea.json). */
const TOO_SOON_LOG = "the pool settled nothing: too soon: this account settled 88 seconds ago, and two settlements are at least 2 minutes apart";
const settleEvent = (fee: string, subsidy: string, cut: string, periodNs = "233028571815") =>
  `EVENT_JSON:{"standard":"pb-pool","version":"1.0.0","event":"settle","data":{"account_id":"${ACCOUNT}","pricing":{"lender":{"margin_bp":500,"cap_bp":null}},"from":"account","period_ns":"${periodNs}","fee":"${fee}","subsidy":"${subsidy}","cut":"${cut}","credit":"0","debt":"509888252","parts":[{"source":"rhea","debt":"544616555","counted_bp":1593,"client_bp":2093,"fee":"${fee}","subsidy":"${subsidy}"}]}}`;

test("INTERFACES.md 45.3, item 11: the pool's answer to a settlement is read from the transaction's logs, and what its 24-hour limits cut is said in words", () => {
  // The account's settle() answers only `true`. The pool's own event, or the account's line when the pool booked nothing.
  const fee = settlementIn(["verdict accepted: nonce 9", settleEvent("202", "0", "0"), "the pool settled: a fee of 202 and a subsidy of 0"]);
  assert.deepEqual(fee, { fee: "202", subsidy: "0", cut: "0", credit: "0", period_ns: "233028571815", debt: "509888252" });
  assert.equal(settleWords(fee).words, "settled: a fee of $0.000202 was added to what the account owes our pool");
  assert.deepEqual(settleWords(fee).fields, { fee: "202", subsidy: "0", credit: "0", period_ns: "233028571815", cut: "0" });
  const skipped = settlementIn([TOO_SOON_LOG]);
  assert.deepEqual(skipped, { skipped: "too soon: this account settled 88 seconds ago, and two settlements are at least 2 minutes apart" });
  assert.equal(settleWords(skipped).words, "nothing settled: too soon: this account settled 88 seconds ago, and two settlements are at least 2 minutes apart");
  assert.deepEqual([skippedTooSoon(skipped), skippedTooSoon(fee), skippedTooSoon(settlementIn(["the pool settled nothing: the pool is paused: settlements wait"])), skippedTooSoon(true)], [true, false, false, false]);
  assert.equal(settlementIn(["verdict accepted: nonce 9"]), null);
  assert.equal(settlementIn([]), null);
  // An event of another kind, or a settle event without its sums, isn't one.
  assert.equal(settlementIn(['EVENT_JSON:{"standard":"pb-pool","version":"1.0.0","event":"set_pricing","data":{"fee":"1","subsidy":"0"}}', 'EVENT_JSON:{"standard":"pb-pool","version":"1.0.0","event":"settle","data":{"account_id":"a"}}', "EVENT_JSON:not json"]), null);

  // INTERFACES.md 45.1: a fee is cut to the pool's 24-hour budgets now, as a subsidy is, and the cut isn't owed later.
  assert.equal(settleWords(settlementIn([settleEvent("150", "0", "52")])).words, "settled: a fee of $0.00015 was added to what the account owes our pool; the pool's 24-hour fee limits took $0.000052 off it, which isn't owed later");
  assert.equal(settleWords(settlementIn([settleEvent("0", "100", "76")])).words, "settled: a subsidy of $0.0001 was taken off what the account owes our pool; the pool's 24-hour subsidy budgets took $0.000076 off it");
  assert.equal(settleWords(settlementIn([settleEvent("0", "0", "202")])).words, "settled: nothing added or taken off, because the pool's 24-hour limits cut all $0.000202 of it");
  assert.equal(settleWords(settlementIn([settleEvent("0", "0", "0")])).words, "settled: nothing to add or take off this time");
});

test("INTERFACES.md 45.3, item 9, tick by tick: an account that owes our pool only is settled behind each hourly check while its policy isn't pass-through; the pool's record is read once an hour for it, and not at all where a lender is owed", async () => {
  const chain = new FundingChain();
  chain.state.funding = null;
  chain.poolDebt = 500 * USD;
  chain.state.loan = { principal: String(500 * USD), open: true };
  chain.check(); // a verdict with no lender position at all
  const events: LogEvent[] = [];
  const pool: { priced: boolean; fails: boolean } = { priced: true, fails: false };
  let reads = 0;
  const d = fundingDeps(chain, events, {
    random: () => 0, // the hourly check lands on the hour
    readPricing: async () => {
      reads += 1;
      if (pool.fails) throw new Error("Rate limits exceeded");
      return { last: [], priced: pool.priced };
    },
  });
  const memory = new Map<string, AccountMemory>();
  const hour = async (h: number) => {
    chain.advance(Date.UTC(2026, 10, 10, h, 0) - chain.now);
    await tick(d, memory);
    const seen = [reads, chain.settled.length];
    // The tick after: the keeper's own check has brought a verdict, and nothing more is read or settled.
    chain.advance(15 * S);
    await tick(d, memory);
    assert.deepEqual([reads, chain.settled.length], seen, "nothing on the tick after");
    return seen;
  };

  // The first look reads the pool's record once, for the lender lines (the P4 look). No tick after that reads it.
  await tick(d, memory);
  for (let i = 0; i < 4; i++) {
    chain.advance(15 * S);
    await tick(d, memory);
  }
  assert.deepEqual([reads, chain.settled.length, chain.actions.length], [1, 0, 1]);

  // 13:00: the hourly check is due. One read says the policy isn't pass-through: the settlement goes behind the check.
  assert.deepEqual(await hour(13), [2, 1]);
  assert.deepEqual(events.filter((e) => e.event === "decide").map((e) => [e.action, e.msg]), [
    ["request_check", "the hourly sample for the rating"],
    ["settle", "the hourly settlement, on the check just made: what the client pays on the lender's part against the operator's price"],
  ]);
  // 14:00: again, one read and one settlement. In between, no read.
  assert.deepEqual(await hour(14), [3, 2]);
  // The operator takes the policy away: the hour's check goes out, with one read and no settlement.
  pool.priced = false;
  assert.deepEqual(await hour(15), [4, 2]);
  assert.equal(events.filter((e) => e.event === "check").length, 3);
  // A record that can't be read: said, and no settlement behind this hour's check.
  pool.priced = true;
  pool.fails = true;
  assert.deepEqual(await hour(16), [5, 2]);
  assert.equal(events.filter((e) => e.event === "error").at(-1)!.msg, "the pool's record of what the account pays couldn't be read (Rate limits exceeded): no settlement behind this hour's check");
  pool.fails = false;
  assert.deepEqual(await hour(17), [6, 3]);

  // Where a lender is owed the settlement goes out anyway, so the policy isn't read: no read on the hour.
  const lent = new FundingChain();
  lent.posted = 1_130 * USD;
  lent.rheaDebt = 570 * USD;
  lent.state.funding = null;
  lent.check();
  let lentReads = 0;
  const dl = fundingDeps(lent, [], { random: () => 0, readPricing: async () => ((lentReads += 1), { last: [{ lender: "rhea", debt: String(570 * USD) }], priced: true }) });
  const ml = new Map<string, AccountMemory>();
  await tick(dl, ml);
  assert.equal(lentReads, 1, "the first look, for Aave's line");
  lent.advance(Date.UTC(2026, 10, 10, 13, 0) - lent.now);
  await tick(dl, ml);
  assert.deepEqual([lentReads, lent.settled.length], [1, 1]);
});

/**
 * An account whose Rhea loan the client has just repaid, with nothing owed to our pool: no loan is left. The pool's
 * last report still shows $570 at Rhea, and the pool keeps `minMs` between two settlements of an account. Its
 * `settle` answers as the real one does: the account's call answers `true`, and the logs carry the pool's answer.
 */
function repaidLender(events: LogEvent[], minMs: number) {
  const chain = new FundingChain();
  chain.posted = 1_130 * USD;
  chain.rheaDebt = 570 * USD;
  chain.state.funding = null;
  chain.check();
  const pool = { last: [{ lender: "rhea", debt: String(570 * USD) }], settledAt: chain.now - 30 * S, minMs, busy: false };
  const counts = { reads: 0, periodReads: 0, checks: 0 };
  const d = fundingDeps(chain, events, {
    readPricing: async () => ((counts.reads += 1), { last: structuredClone(pool.last), priced: false }),
    readMinPeriodMs: async () => ((counts.periodReads += 1), pool.minMs),
    requestCheck: async () => {
      counts.checks += 1;
      chain.check();
      return { ok: true, hash: `tx-check-${counts.checks}`, accepted: true, reason: null, attestationUrl: null, seconds: 10 };
    },
    settle: async () => {
      chain.settled.push(chain.now);
      const since = chain.now - pool.settledAt;
      const hash = `tx-settle-${chain.settled.length}`;
      // `busy`: something else keeps settling the account, so the pool's last settlement is always a moment ago.
      if (pool.busy || since < pool.minMs) {
        return { ok: true, hash, result: true, logs: [`the pool settled nothing: too soon: this account settled ${Math.round((pool.busy ? 20 * S : since) / S)} seconds ago, and two settlements are at least 2 minutes apart`], seconds: 2, retry: false };
      }
      pool.last = [{ lender: "rhea", debt: String(chain.rheaDebt) }];
      pool.settledAt = chain.now;
      return { ok: true, hash, result: true, logs: [settleEvent("0", "0", "0", `${since}000000`), "the pool settled: a fee of 0 and a subsidy of 0"], seconds: 2, retry: false };
    },
  });
  const memory = new Map<string, AccountMemory>();
  const idle = async (ticks = 1) => {
    for (let i = 0; i < ticks; i++) {
      chain.advance(15 * S);
      await tick(d, memory);
    }
  };
  return { chain, pool, counts, d, memory, idle };
}

test("INTERFACES.md 45.3, item 10, tick by tick: the pool skips the settlement that reports a repaid lender as zero as too soon; the keeper reads the pool's time between two settlements once, waits it out, and asks for one more check with the settlement behind it", async () => {
  const events: LogEvent[] = [];
  const { chain, pool, counts, d, memory, idle } = repaidLender(events, 2 * MIN);
  const notes = () => events.filter((e) => e.event === "note").map((e) => e.msg);
  await tick(d, memory);
  assert.deepEqual([counts.reads, chain.settled.length], [1, 0], "Rhea is owed: one read, for Aave's line");

  // The client repays Rhea, and its check shows nothing owed: no loan is left. The keeper settles, 55 s after the
  // pool's last settlement of the account, and the pool skips it. The keeper learns that from the logs alone.
  chain.rheaDebt = 0;
  chain.advance(15 * S);
  chain.check();
  await tick(d, memory);
  assert.deepEqual([counts.reads, chain.settled.length, counts.periodReads, counts.checks], [2, 1, 1, 0]);
  assert.equal(events.filter((e) => e.event === "settle").at(-1)!.msg, "nothing settled: too soon: this account settled 55 seconds ago, and two settlements are at least 2 minutes apart");
  assert.deepEqual(notes(), ["the pool skipped that settlement as too soon, so its record still shows the lender's debt: one more check, with the settlement behind it, in 120 s, the time the pool keeps between two settlements (try 1 of 2)"]);
  assert.deepEqual(pool.last, [{ lender: "rhea", debt: String(570 * USD) }]);

  // For the next 105 s nothing is asked or sent, not even when another check lands (it would only be skipped again).
  await idle(3);
  chain.advance(15 * S);
  chain.check();
  await tick(d, memory);
  await idle(3);
  assert.deepEqual([counts.reads, chain.settled.length, counts.periodReads, counts.checks], [2, 1, 1, 0]);

  // 120 s after the skip: one check, and the settlement behind it. The pool takes it, and its record shows zero.
  await idle();
  assert.deepEqual([chain.settled.length, counts.checks], [2, 1]);
  assert.deepEqual(events.filter((e) => e.event === "decide").slice(-2).map((e) => [e.action, e.msg]), [
    ["request_check", "the pool skipped, as too soon, the settlement that reports a repaid lender as zero, and the time it keeps between two settlements has passed: one more check, with that settlement behind it"],
    ["settle", "the settlement that reports a repaid lender as zero, again, on the check just made: the pool skipped the last one as too soon"],
  ]);
  assert.equal(events.filter((e) => e.event === "settle").at(-1)!.msg, "settled: nothing to add or take off this time");
  assert.deepEqual(pool.last, [{ lender: "rhea", debt: "0" }]);
  assert.equal(memory.get(ACCOUNT)!.decide.zeroAgain, undefined);

  // Afterwards: one read sees the zero, and then nothing more is read, asked or sent.
  await idle(12);
  assert.deepEqual([counts.reads, chain.settled.length, counts.periodReads, counts.checks], [3, 2, 1, 1]);
  assert.equal(notes().length, 1);
});

test("INTERFACES.md 45.3, item 10: a pool that keeps answering too soon is asked twice more and no further; a pool whose time can't be read is given its own default of 10 minutes", async () => {
  const events: LogEvent[] = [];
  const { chain, pool, counts, d, memory, idle } = repaidLender(events, 2 * MIN);
  const notes = () => events.filter((e) => e.event === "note").map((e) => String(e.msg));
  await tick(d, memory);
  pool.busy = true;
  chain.rheaDebt = 0;
  chain.advance(15 * S);
  chain.check();
  await tick(d, memory); // the first settlement, skipped
  await idle(8); // 120 s: the first try more, skipped
  assert.deepEqual([chain.settled.length, counts.checks], [2, 1]);
  await idle(8); // the second, skipped: the keeper stops asking
  assert.deepEqual([chain.settled.length, counts.checks], [3, 2]);
  assert.deepEqual(notes().map((n) => n.startsWith("the pool skipped that settlement as too soon, so its record still shows the lender's debt: one more check")), [true, true, false]);
  assert.match(notes()[0]!, /\(try 1 of 2\)$/);
  assert.match(notes()[1]!, /\(try 2 of 2\)$/);
  assert.equal(notes()[2], "the pool skipped that settlement as too soon again, after 2 more tries: the keeper stops asking, and looks at the pool's record again after the account's next check");
  assert.deepEqual(memory.get(ACCOUNT)!.decide.zeroAgain, { tries: 2, waitMs: 2 * MIN, stopped: true });
  // The verdict the last try's check brought is looked at as any new verdict is, as before this rule: one
  // settlement, skipped again, and no new round of tries. Then nothing, however long it lasts.
  await idle(40);
  assert.deepEqual([chain.settled.length, counts.checks, counts.periodReads, notes().length], [4, 2, 1, 3]);
  // The account's next check, once the pool is free again: its record takes the zero, and the keeper's note is gone.
  pool.busy = false;
  chain.advance(15 * S);
  chain.check();
  await tick(d, memory);
  assert.deepEqual([chain.settled.length, pool.last], [5, [{ lender: "rhea", debt: "0" }]]);
  assert.equal(memory.get(ACCOUNT)!.decide.zeroAgain, undefined);

  // A pool whose limits can't be read: the keeper waits the pool's own default, 10 minutes, and says so.
  const blindEvents: LogEvent[] = [];
  const blind = repaidLender(blindEvents, 2 * MIN);
  const db = { ...blind.d, readMinPeriodMs: async () => Promise.reject(new Error("Rate limits exceeded")) };
  await tick(db, blind.memory);
  blind.chain.rheaDebt = 0;
  blind.chain.advance(15 * S);
  blind.chain.check();
  await tick(db, blind.memory);
  assert.equal(DEFAULT_MIN_PERIOD_MS, 10 * MIN);
  assert.equal(blind.memory.get(ACCOUNT)!.decide.zeroAgain!.waitMs, 10 * MIN);
  assert.match(String(blindEvents.filter((e) => e.event === "note").at(-1)!.msg), /in 600 s, the time the pool keeps between two settlements; the pool's own figure couldn't be read, so its default is taken \(try 1 of 2\)$/);
});

test("--newest: the keeper watches only the accounts the factory made last, with no name to give; not together with --account", () => {
  assert.equal(keeperConfig({}, ["--", "--newest", "1"]).newest, 1);
  assert.equal(keeperConfig({}, ["--newest", "3"]).newest, 3);
  assert.equal(keeperConfig({}, []).newest, undefined);
  for (const bad of ["0", "101", "1.5", "two", ""]) assert.throws(() => keeperConfig({}, ["--newest", bad]), /--newest takes a whole number from 1 to 100/);
  assert.throws(() => keeperConfig({}, ["--newest", "1", "--account", "a.pbf.testnet"]), /give --account or --newest, not both/);
  // The factory lists its accounts oldest first.
  const made = ["demo1.pbf.testnet", "gate2a.pbf.testnet", "fund-rhea-watch1.pbf.testnet"];
  assert.deepEqual(newestOf(made, 1), ["fund-rhea-watch1.pbf.testnet"]);
  assert.deepEqual(newestOf(made, 2), ["gate2a.pbf.testnet", "fund-rhea-watch1.pbf.testnet"]);
  assert.deepEqual(newestOf(made, 100), made);
  assert.deepEqual(newestOf(made, undefined), made);
  assert.deepEqual(newestOf([], 1), []);
});
