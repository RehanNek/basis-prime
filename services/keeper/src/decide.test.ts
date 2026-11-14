import assert from "node:assert/strict";
import { test } from "node:test";

import type { Prices } from "./bands.js";
import { afterAction, afterZeroSettle, CHECK_WAIT_MS, decide, FUND_CHECK_EVERY_MS, LENDER_RECHECK_MS, MAX_FUND_CHECKS, nextHourlyCheck, ordersSamePlan, pricesAtBlock, SECOND_CHECK_AIM_MS, type Action, type EvmSeen, type KeptPrices, type Memory, type Outcome, type Seen, type Verdict, CHECK_AGAIN_MS } from "./decide.js";
import { readFunding, readPlan, type LenderExt } from "./plan.js";

const S = 1_000;
const MIN = 60 * S;
const T0 = Date.UTC(2026, 10, 10, 12, 20); // 12:20 UTC

const PAR: Prices = { marks: { BTC: 76_000 }, pi: { nBTC: 10_000 } };
/** The small book's nBTC bands (made-up levels in the shape of RISK_ENGINE.md 13.2). */
const BANDS = { BTC: { hl50: 101_781_826_406, hl100: 103_038_392_164 }, nBTC: { im_bp: 8_500, mr_bp: 8_100, dl_bp: 7_700 } };

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return { state: "HEALTHY", action: "NONE", blk: 1_000, nonce: 3, receivedBlock: 1_005, at: T0, bands: BANDS, tokens: ["nBTC"], ...overrides };
}

function seen(overrides: Partial<Seen> = {}): Seen {
  return { hasLoan: true, counter: 3, verdict: verdict(), firstDeleverageAtMs: 0, plan: null, prices: PAR, perps: ["BTC"], ...overrides };
}

const pi = (bp: number): Prices => ({ marks: PAR.marks, pi: { nBTC: bp } });
const kinds = (actions: Action[]) => actions.map((a) => a.kind);
const checks = (actions: Action[]) => actions.filter((a) => a.kind === "request_check").map((a) => a.reason);
const noHourly = () => 0.99; // the hourly check lands at :59 of the next hour, out of the way

/** Runs decide for several ticks, 15 s apart, applying `ok` outcomes. */
function settle(memory: Memory, s: Seen, now: number) {
  const d = decide(memory, s, now, noHourly);
  let m = d.memory;
  for (const a of d.actions) m = afterAction(m, a, { ok: true }, now);
  return { ...d, memory: m };
}

test("no loan: nothing to watch, and the schedules start again with the next loan", () => {
  const d = decide({ nextHourlyAt: T0, lastCheckAt: T0 - 10 * MIN }, seen({ hasLoan: false }), T0);
  assert.deepEqual(d.actions, []);
  assert.equal(d.memory.nextHourlyAt, undefined);
  assert.equal(d.memory.verdictKey, "1000:1005");
});

test("a price that crosses one of the verdict's bands asks for one check, once", () => {
  const first = settle({}, seen(), T0);
  assert.deepEqual(first.actions, [], "the first look only takes the sides");
  const crossed = decide(first.memory, seen({ prices: pi(8_400) }), T0 + 15 * S, noHourly);
  assert.deepEqual(checks(crossed.actions), ["the nBTC ratio fell through 0.8500, where equity reaches the initial requirement (now 0.8400)"]);
  const again = decide(crossed.memory, seen({ prices: pi(8_390) }), T0 + 30 * S, noHourly);
  assert.deepEqual(again.actions, [], "the same side as last tick: no new check");
  const coin = decide(again.memory, seen({ prices: { marks: { BTC: 103_100 }, pi: { nBTC: 8_390 } } }), T0 + 45 * S, noHourly);
  assert.deepEqual(checks(coin.actions), [
    "BTC rose through $101,781.83, where Hyperliquid's margin ratio reaches 50% (now $103,100); " +
      "BTC rose through $103,038.39, where Hyperliquid's margin ratio reaches 100%, where it liquidates (now $103,100)",
  ]);
});

test("a held token with no band in the verdict: a move of 2 points of ratio asks for a check, once", () => {
  const noPi = verdict({ bands: { BTC: BANDS.BTC } });
  const first = settle({}, seen({ verdict: noPi }), T0);
  assert.deepEqual(decide(first.memory, seen({ verdict: noPi, prices: pi(9_850) }), T0 + 15 * S, noHourly).actions, [], "1.5 points: not yet");
  const moved = decide(first.memory, seen({ verdict: noPi, prices: pi(9_800) }), T0 + 15 * S, noHourly);
  assert.deepEqual(checks(moved.actions), ["the nBTC ratio moved from 1.0000 to 0.9800 since the last verdict, which has no band for it"]);
  assert.deepEqual(decide(moved.memory, seen({ verdict: noPi, prices: pi(9_500) }), T0 + 30 * S, noHourly).actions, [], "once per verdict");
});

test("a verdict the keeper asked for is measured from the prices when it asked", () => {
  const first = settle({}, seen(), T0);
  const asked = decide(first.memory, seen({ prices: pi(8_400) }), T0 + 15 * S, noHourly);
  let m = asked.memory;
  for (const a of asked.actions) m = afterAction(m, a, { ok: true }, T0 + 15 * S);
  // The WATCH verdict comes back; meanwhile the ratio fell through its MR band too.
  const watch = verdict({ state: "WATCH", blk: 1_030, receivedBlock: 1_034, at: T0 + 25 * S, bands: { nBTC: { mr_bp: 8_100, dl_bp: 7_700 } } });
  const back = decide(m, seen({ verdict: watch, prices: pi(8_000) }), T0 + 30 * S, noHourly);
  assert.deepEqual(kinds(back.actions), ["cancel_risky", "request_check"]);
  assert.match(checks(back.actions)[0]!, /fell through 0\.8100, where equity reaches the safety buffer \(now 0\.8000\)/);
});

test("leaving HEALTHY cancels the resting orders that add risk, once; so does a first look at an unhealthy account", () => {
  const healthy = settle({}, seen(), T0);
  const watch = verdict({ state: "WATCH", blk: 1_030, receivedBlock: 1_034 });
  const left = decide(healthy.memory, seen({ verdict: watch }), T0 + MIN, noHourly);
  assert.deepEqual(left.actions.filter((a) => a.kind === "cancel_risky"), [{ kind: "cancel_risky", reason: "the account left HEALTHY for WATCH" }]);
  assert.deepEqual(decide(left.memory, seen({ verdict: watch }), T0 + MIN + 15 * S, noHourly).actions, []);
  const call = verdict({ state: "MARGIN_CALL", blk: 1_060, receivedBlock: 1_063, at: T0 + 2 * MIN });
  assert.deepEqual(kinds(decide(left.memory, seen({ verdict: call }), T0 + 2 * MIN, noHourly).actions), [], "WATCH to MARGIN_CALL: already left HEALTHY");

  const firstLook = decide({}, seen({ verdict: call }), T0 + 2 * MIN, noHourly);
  assert.deepEqual(firstLook.actions, [{ kind: "cancel_risky", reason: "the account is MARGIN_CALL when the keeper first sees it" }]);
});

test("a margin call gets a check at least every 5 minutes after the last check or verdict", () => {
  const call = verdict({ state: "MARGIN_CALL", at: T0 });
  const m = settle({}, seen({ verdict: call }), T0).memory;
  assert.deepEqual(checks(decide(m, seen({ verdict: call }), T0 + 4 * MIN, noHourly).actions), []);
  assert.deepEqual(checks(decide(m, seen({ verdict: call }), T0 + 5 * MIN, noHourly).actions), ["a margin call: a check at least every 5 minutes"]);
});

test("DELEVERAGE: the second check goes about 2.5 minutes after the first verdict arrived, once", () => {
  const firstAt = T0 + 10 * S;
  const dl = verdict({ state: "DELEVERAGE", action: "DELEVERAGE", at: firstAt, bands: undefined });
  const look = settle({ lastState: "MARGIN_CALL" }, seen({ verdict: dl, firstDeleverageAtMs: firstAt }), T0 + 15 * S);
  assert.deepEqual(look.actions, [], "the first only starts the wait");
  assert.deepEqual(decide(look.memory, seen({ verdict: dl, firstDeleverageAtMs: firstAt }), firstAt + SECOND_CHECK_AIM_MS - S, noHourly).actions, [], "too early");
  const due = decide(look.memory, seen({ verdict: dl, firstDeleverageAtMs: firstAt }), firstAt + SECOND_CHECK_AIM_MS, noHourly);
  assert.deepEqual(checks(due.actions), ["the second check for DELEVERAGE, 150 s after the first verdict arrived"]);
  assert.deepEqual(due.memory.secondCheck, { firstAt, sentAt: firstAt + SECOND_CHECK_AIM_MS, tries: 1 });
  assert.deepEqual(decide(due.memory, seen({ verdict: dl, firstDeleverageAtMs: firstAt }), firstAt + SECOND_CHECK_AIM_MS + 15 * S, noHourly).actions, [], "asked once");
  // Its verdict hasn't confirmed the plan 40 s later: once more, while the window is open.
  const retry = decide(due.memory, seen({ verdict: dl, firstDeleverageAtMs: firstAt }), firstAt + 190 * S, noHourly);
  assert.deepEqual(checks(retry.actions), ["the second check for DELEVERAGE again, 190 s after the first: the plan isn't stored yet"]);
  // Past the window: the next check starts a new pair.
  const late = decide({ ...look.memory }, seen({ verdict: dl, firstDeleverageAtMs: firstAt }), firstAt + 6 * MIN, noHourly);
  assert.match(checks(late.actions)[0]!, /past the 5-minute window, so this check starts a new pair/);
});

const STORED = {
  pid: "2000",
  action: "DELEVERAGE",
  stored_at: String(BigInt(T0 + 3 * MIN) * 1_000_000n),
  steps: [
    { k: "repay", amt: 10_000_000, done: false },
    { k: "perp", coin: "BTC", buy: true, sz: "0.00375", px: "76190", done: false },
  ],
};

test("a confirmed plan runs: the gateway places its perp step, execute_step its repay; then one check", () => {
  const confirm = verdict({ state: "DELEVERAGE", action: "DELEVERAGE", blk: 2_000, receivedBlock: 2_004, at: T0 + 3 * MIN, bands: undefined });
  const plan = readPlan({ plan: STORED });
  const at = T0 + 3 * MIN + 10 * S;
  const run = decide({ lastState: "DELEVERAGE" }, seen({ verdict: confirm, firstDeleverageAtMs: T0 + 3 * MIN, plan }), at, noHourly);
  assert.deepEqual(run.actions, [
    { kind: "deleverage", pid: "2000", reason: "the stored DELEVERAGE plan 2000: the gateway places its steps 1:perp" },
    { kind: "execute_step", pid: "2000", i: 0, k: "repay", reason: "step 0 of the stored DELEVERAGE plan 2000: repay $10.00 to the pool from the account's USDC" },
  ]);
  let m = run.memory;
  for (const a of run.actions) m = afterAction(m, a, { ok: true }, at);
  // Next tick the account shows the repay done; nothing is sent twice, and a check follows.
  const done = readPlan({ plan: { ...STORED, steps: [{ ...STORED.steps[0], done: true }, STORED.steps[1]] } });
  const after = decide(m, seen({ verdict: confirm, firstDeleverageAtMs: T0 + 3 * MIN, plan: done }), at + 15 * S, noHourly);
  assert.deepEqual(checks(after.actions), ["the steps of plan 2000 have run: a check to see where the account stands"]);
  assert.equal(after.memory.recoveringSince, at + 15 * S);
  assert.deepEqual(decide(after.memory, seen({ verdict: confirm, firstDeleverageAtMs: T0 + 3 * MIN, plan: done }), at + 30 * S, noHourly).actions, []);
});

test("the gateway's P0 is tried again; its P2 asks for a new plan; an expired quote isn't run", () => {
  const confirm = verdict({ state: "DELEVERAGE", action: "DELEVERAGE", blk: 2_000, receivedBlock: 2_004, at: T0, bands: undefined });
  const perpOnly = readPlan({ plan: { ...STORED, steps: [STORED.steps[1]] } });
  const s = seen({ verdict: confirm, firstDeleverageAtMs: T0, plan: perpOnly });
  const first = decide({ lastState: "DELEVERAGE" }, s, T0 + 10 * S, noHourly);
  const busy = afterAction(first.memory, first.actions[0]!, { ok: false, retry: true, why: "P0" }, T0 + 10 * S);
  assert.deepEqual(decide(busy, s, T0 + 20 * S, noHourly).actions, [], "waits 15 s");
  const again = decide(busy, s, T0 + 25 * S, noHourly);
  assert.deepEqual(kinds(again.actions), ["deleverage"]);
  const refused = afterAction(again.memory, again.actions[0]!, { ok: false, replan: true, why: "P2" }, T0 + 25 * S);
  assert.deepEqual(checks(decide(refused, s, T0 + 40 * S, noHourly).actions), ["plan 2000 can't run as it is: a check for a new plan"]);

  const sell = readPlan({ plan: { ...STORED, steps: [{ k: "sell", tok: "mnbtc.pbf-ops.testnet", amt: "100000", min: 70_000_000, dep: "ab".repeat(32), exp: T0 + 4 * MIN, done: false }] } });
  const expired = decide({ lastState: "DELEVERAGE" }, seen({ verdict: confirm, firstDeleverageAtMs: T0, plan: sell }), T0 + 10 * S, noHourly);
  assert.deepEqual(kinds(expired.actions), ["request_check"]);
  assert.deepEqual(expired.notes, ["step 0 (sell) of plan 2000 can't run: its quote has less than 5 minutes left"]);
});

test("an older stored plan isn't run once the latest verdict asks for nothing; a REBALANCE plan runs at once", () => {
  const old = readPlan({ plan: STORED });
  const watch = verdict({ state: "WATCH", action: "NONE", blk: 2_100, receivedBlock: 2_103 });
  assert.deepEqual(kinds(decide({ lastState: "WATCH" }, seen({ verdict: watch, plan: old }), T0, noHourly).actions), []);

  const rebalance = verdict({ state: "WATCH", action: "REBALANCE", blk: 2_200, receivedBlock: 2_202 });
  const plan = readPlan({ plan: { pid: "2200", action: "REBALANCE", stored_at: "1", steps: [{ k: "to_hl", amt: 50_000_000, dep: "cd".repeat(32), exp: T0 + 9 * MIN, done: false }] } });
  const run = decide({ lastState: "WATCH" }, seen({ verdict: rebalance, plan }), T0, noHourly);
  assert.deepEqual(run.actions, [{ kind: "execute_step", pid: "2200", i: 0, k: "to_hl", reason: "step 0 of the stored REBALANCE plan 2200: move $50.00 of USDC to the account's Hyperliquid address", dep: "cd".repeat(32) }]);
});

// ---------- Phase 6, stage 2 ----------

const MNBTC = "mnbtc.pbf-ops.testnet";
const RHEA: LenderExt = { l: "rhea", c: 100_000_000_000, d: 50_667_000_000, hf_bp: 15_000, r_bp: 1_591, s_bp: 1_032, room: 0, liq_bp: 7_600 };
const steps = (actions: Action[]) => actions.map((a) => (a.kind === "execute_step" ? `${a.pid}:${a.i} ${a.k}` : a.kind));

test("Phase 6: a top-up plan's l_add and l_repay run at once, like any other stored step, and a check follows when they are done", () => {
  const rebalance = verdict({ state: "WATCH", action: "REBALANCE", blk: 2_300, receivedBlock: 2_302 });
  const raw = [
    { k: "l_add", l: "rhea", tok: MNBTC, amt: "2500000", done: false },
    { k: "l_repay", l: "rhea", amt: 10_133_000_000, done: false },
  ];
  const topUp = readPlan({ plan: { pid: "2300", action: "REBALANCE", stored_at: "1", steps: raw } });
  const ext = [{ ...RHEA, hf_bp: 12_500 }];
  const first = decide({ lastState: "WATCH" }, seen({ verdict: rebalance, plan: topUp, ext }), T0, noHourly);
  assert.deepEqual(first.actions, [
    { kind: "execute_step", pid: "2300", i: 0, k: "l_add", reason: "step 0 of the stored REBALANCE plan 2300: add 2500000 units of mnbtc.pbf-ops.testnet to the collateral at Rhea" },
    { kind: "execute_step", pid: "2300", i: 1, k: "l_repay", reason: "step 1 of the stored REBALANCE plan 2300: repay $10,133.00 to Rhea from the account's USDC" },
  ]);
  assert.deepEqual(first.notes, []);
  let m = first.memory;
  for (const a of first.actions) m = afterAction(m, a, { ok: true }, T0);
  const done = readPlan({ plan: { pid: "2300", action: "REBALANCE", stored_at: "1", steps: raw.map((s) => ({ ...s, done: true })) } });
  assert.deepEqual(checks(decide(m, seen({ verdict: rebalance, plan: done, ext }), T0 + 15 * S, noHourly).actions), ["the steps of plan 2300 have run: a check to see where the account stands"]);

  // A top-up the account refuses (say its verdict went stale) asks for a new plan, as any refused step does.
  const refused = afterAction(first.memory, first.actions[0]!, { ok: false, replan: true, why: "the verdict is 121 blocks old" }, T0);
  assert.deepEqual(checks(decide(refused, seen({ verdict: rebalance, plan: topUp, ext }), T0 + 15 * S, noHourly).actions), ["plan 2300 can't run as it is: a check for a new plan"]);

  // A kind that makes a loan has no place in a stored plan: said once, left alone, and no check asked because of it.
  const odd = readPlan({ plan: { pid: "2300", action: "REBALANCE", stored_at: "1", steps: [{ k: "l_borrow", l: "rhea", amt: 5_000_000, done: false }] } });
  const left = decide({ lastState: "WATCH" }, seen({ verdict: rebalance, plan: odd }), T0, noHourly);
  assert.deepEqual([left.actions, left.notes], [[], ["step 0 (l_borrow) of plan 2300 belongs in a funding plan, not in this one: the keeper leaves it alone"]]);
  const next = decide(left.memory, seen({ verdict: rebalance, plan: odd }), T0 + 15 * S, noHourly);
  assert.deepEqual([next.actions, next.notes], [[], []], "said once");
});

test("Phase 6: an l_add runs only under the check that ordered it; after another check has landed the keeper asks for a new plan, and an l_repay still runs", () => {
  const raw = [
    { k: "l_add", l: "rhea", tok: MNBTC, amt: "2500000", done: false },
    { k: "l_repay", l: "rhea", amt: 10_133_000_000, done: false },
  ];
  const topUp = readPlan({ plan: { pid: "2300", action: "REBALANCE", stored_at: "1", steps: raw } });
  // A later check has landed (blk 2330) that didn't store a plan of its own: the account holds plan 2300 still.
  const later = verdict({ state: "MARGIN_CALL", action: "DELEVERAGE", blk: 2_330, receivedBlock: 2_333, bands: undefined });
  const d = decide({ lastState: "MARGIN_CALL" }, seen({ verdict: later, plan: topUp, ext: [{ ...RHEA, hf_bp: 12_500 }] }), T0, noHourly);
  assert.deepEqual(steps(d.actions), ["2300:1 l_repay", "request_check"]);
  assert.deepEqual(checks(d.actions), ["plan 2300 can't run as it is: a check for a new plan"]);
  assert.ok(d.notes.includes("step 0 (l_add) of plan 2300 can't run any more: a later check has landed, and the account adds collateral only under the check that ordered it"));
  let m = d.memory;
  for (const a of d.actions) m = afterAction(m, a, { ok: true }, T0);
  const next = decide(m, seen({ verdict: later, plan: topUp, ext: [{ ...RHEA, hf_bp: 12_500 }] }), T0 + 15 * S, noHourly);
  assert.deepEqual([steps(next.actions), next.notes.filter((n) => n.includes("l_add"))], [[], []], "said and asked once");
  // The new check orders the top-up again under its own id: that plan's l_add runs.
  const ordered = verdict({ state: "WATCH", action: "REBALANCE", blk: 2_350, receivedBlock: 2_352 });
  const fresh = readPlan({ plan: { pid: "2350", action: "REBALANCE", stored_at: "1", steps: [raw[0]] } });
  assert.deepEqual(steps(decide(m, seen({ verdict: ordered, plan: fresh }), T0 + 30 * S, noHourly).actions), ["2350:0 l_add"]);
});

test("Phase 6: while a lender action is under way the keeper asks for no check and runs no top-up; when its block has passed, one fresh check, with the settlement behind it", () => {
  const hour = Date.UTC(2026, 10, 10, 13, 30);
  const scheduled = decide({}, seen({ ext: [RHEA], chainBlock: 6_000 }), T0, () => 0.5).memory;
  // The owner has just taken some collateral back at Rhea: listed until block 6020. The hourly check falls due now,
  // and bitcoin has fallen far enough to ask about Rhea's cushion.
  const pendingLender = { lender: "rhea", kind: "withdraw", amount: "100000", untilBlock: 6_020 };
  const low: Prices = { marks: { BTC: 60_000 }, pi: { nBTC: 10_000 } };
  const held = verdict({ blk: 6_001, receivedBlock: 6_004, bands: { BTC: { hl100: 200_000_000_000 } } });
  const during = decide(scheduled, seen({ verdict: held, ext: [RHEA], prices: low, pendingLender, chainBlock: 6_010 }), hour, () => 0.5);
  assert.deepEqual(during.actions, []);
  assert.deepEqual(during.notes, ["a check waits until block 6020 has passed: the account counts its withdrawal at Rhea as under way, and a check asked for now would be refused when its verdict lands (the hourly sample for the rating)"]);
  const still = decide(during.memory, seen({ verdict: held, ext: [RHEA], prices: low, pendingLender, chainBlock: 6_020 }), hour + 15 * S, () => 0.5);
  assert.deepEqual([still.actions, still.notes], [[], []], "block 6020 itself hasn't passed, and the wait is said once");

  const after = decide(during.memory, seen({ verdict: held, ext: [RHEA], prices: low, pendingLender, chainBlock: 6_021 }), hour + 30 * S, () => 0.5);
  assert.deepEqual(after.actions.map((a) => [a.kind, a.reason.split(":")[0]]), [
    ["request_check", "the account counted its withdrawal at Rhea as under way until block 6020, which has passed"],
    ["settle", "the hourly settlement, on the check just made"],
  ]);
  let m = after.memory;
  for (const a of after.actions) m = afterAction(m, a, { ok: true }, hour + 30 * S);
  assert.deepEqual(decide(m, seen({ verdict: held, ext: [RHEA], prices: low, pendingLender, chainBlock: 6_030 }), hour + 45 * S, () => 0.5).actions, [], "one check, not one a tick");

  // A top-up ordered by a verdict from before that block waits for the fresh check, which may order it again.
  const thin = verdict({ state: "WATCH", action: "REBALANCE", blk: 6_015, receivedBlock: 6_018 });
  const topUp = readPlan({ plan: { pid: "6015", action: "REBALANCE", stored_at: "1", steps: [{ k: "l_add", l: "rhea", tok: MNBTC, amt: "230000", done: false }] } });
  const early = decide({ lastState: "WATCH" }, seen({ verdict: thin, plan: topUp, ext: [{ ...RHEA, hf_bp: 12_900 }], pendingLender, chainBlock: 6_021 }), T0, noHourly);
  assert.deepEqual(steps(early.actions), ["request_check"], "no l_add on a cushion read too early");
  const again = verdict({ state: "WATCH", action: "REBALANCE", blk: 6_025, receivedBlock: 6_028 });
  const newPlan = readPlan({ plan: { pid: "6025", action: "REBALANCE", stored_at: "1", steps: [{ k: "l_add", l: "rhea", tok: MNBTC, amt: "230000", done: false }] } });
  assert.deepEqual(steps(decide(early.memory, seen({ verdict: again, plan: newPlan, ext: [{ ...RHEA, hf_bp: 12_900 }], chainBlock: 6_035 }), T0 + 15 * S, noHourly).actions), ["6025:0 l_add"]);
});

/** A $1,100 loan on the small demo book: post the nBTC at Rhea, borrow $570 there, then $530 from our pool. */
function fundingPlan(done: [boolean, boolean, boolean], expiresAt = T0 + 30 * MIN) {
  const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
  return readFunding({
    funding: {
      pid: "f5000",
      amount: "1100000000",
      stored_at: ns(T0),
      expires_at: ns(expiresAt),
      steps: [
        { k: "l_supply", l: "rhea", tok: MNBTC, amt: "1500000", done: done[0] },
        { k: "l_borrow", l: "rhea", amt: 570_000_000, done: done[1] },
        { k: "p_borrow", amt: 530_000_000, done: done[2] },
      ],
    },
  });
}

test("Phase 6: a funding plan runs from the moment it is stored: the collateral at once, a fresh check before each borrow, and the 20 blocks after Rhea's", () => {
  // `fund` used the verdict that answered it (nonce 7, counter 8). The account has no loan yet.
  const funded = verdict({ blk: 5_000, receivedBlock: 5_004, nonce: 7 });
  const posted = { ...RHEA, c: 1_130_000_000, d: 0, hf_bp: 0, room: 572_000_000 };
  let now = T0;
  const look = (m: Memory, s: Partial<Seen>) => {
    const d = decide(m, seen({ hasLoan: false, owesPool: false, perps: [], ...s }), now, noHourly);
    let memory = d.memory;
    for (const a of d.actions) memory = afterAction(memory, a, { ok: true }, now);
    now += 15 * S;
    return { ...d, memory };
  };

  // 1. No pool debt, so posting collateral needs no check: it goes out at once.
  const t1 = look({}, { counter: 8, verdict: funded, funding: fundingPlan([false, false, false]), chainBlock: 5_010 });
  assert.deepEqual(t1.actions, [{ kind: "execute_step", pid: "f5000", i: 0, k: "l_supply", reason: "step 0 of funding plan f5000: post 1500000 units of mnbtc.pbf-ops.testnet at Rhea as collateral" }]);

  // 2. The borrow at Rhea takes the room a fresh verdict gives, and the held one is from before the collateral moved.
  const t2 = look(t1.memory, { counter: 9, verdict: funded, funding: fundingPlan([true, false, false]), chainBlock: 5_025 });
  assert.deepEqual(t2.actions, [{ kind: "request_check", reason: "step 1 (l_borrow) of funding plan f5000 needs a fresh check first: the last one was made before the account's latest change" }]);

  // 3. The check is in, and it gives Rhea room: borrow.
  const checked = verdict({ blk: 5_040, receivedBlock: 5_044, nonce: 9 });
  const t3 = look(t2.memory, { counter: 9, verdict: checked, ext: [posted], funding: fundingPlan([true, false, false]), chainBlock: 5_050 });
  assert.deepEqual(steps(t3.actions), ["f5000:1 l_borrow"]);

  // 4. Rhea finishes the borrow a block or two later: for 20 blocks the account refuses every funding step, and a
  //    check asked for now would be refused when it lands. Said once.
  const pendingLender = { lender: "rhea", kind: "borrow", amount: "570000000", untilBlock: 5_075 };
  const waiting = { counter: 10, verdict: checked, ext: [posted], funding: fundingPlan([true, true, false]), pendingLender };
  const t4 = look(t3.memory, { ...waiting, chainBlock: 5_065 });
  assert.deepEqual([t4.actions, t4.notes], [[], ["step 2 (p_borrow) of funding plan f5000 waits: the account counts its borrow at Rhea as under way until block 5075 has passed"]]);
  const t5 = look(t4.memory, { ...waiting, chainBlock: 5_075 });
  assert.deepEqual([t5.actions, t5.notes], [[], []], "block 5075 itself hasn't passed");

  // 5. Past it: one fresh check, which is the pool step's check too. Then the pool lends what that verdict allows.
  const t6 = look(t5.memory, { ...waiting, chainBlock: 5_078 });
  assert.deepEqual(checks(t6.actions), ["the account counted its borrow at Rhea as under way until block 5075, which has passed: a fresh check"]);
  // The account drops the listing with its next call. A verdict from before block 5075 still backs nothing here,
  // even one whose nonce is the counter: Rhea's cushion in it can read too low.
  const early = verdict({ blk: 5_070, receivedBlock: 5_079, nonce: 11, allowBorrow: 530_000_000 });
  const stale = look(t6.memory, { hasLoan: true, counter: 11, verdict: early, ext: [posted], funding: fundingPlan([true, true, false]), chainBlock: 5_085 });
  assert.deepEqual(stale.actions, [], "no step on it, and the check for it is already on its way");
  const lent = [{ ...posted, d: 570_000_000, hf_bp: 15_060, room: 0 }];
  const again = verdict({ blk: 5_090, receivedBlock: 5_094, nonce: 11, allowBorrow: 530_000_000 });
  const t7 = look(stale.memory, { hasLoan: true, counter: 11, verdict: again, ext: lent, funding: fundingPlan([true, true, false]), chainBlock: 5_100 });
  assert.deepEqual(steps(t7.actions), ["f5000:2 p_borrow"]);
  assert.equal(t7.memory.lenderUntil, undefined, "a verdict read after block 5075: the wait is over");

  // 6. Every step has run: one check, to see where the account stands with both loans.
  const both = { hasLoan: true, owesPool: true, counter: 13, verdict: again, ext: lent, funding: fundingPlan([true, true, true]), chainBlock: 5_115 };
  const t8 = look(t7.memory, both);
  assert.deepEqual(checks(t8.actions), ["the steps of funding plan f5000 have run: a check to see where the account stands"]);
  assert.deepEqual(look(t8.memory, both).actions, [], "once");
  // A keeper that starts later and finds the plan already run has nothing to ask.
  assert.deepEqual(decide({}, seen({ ...both }), now, noHourly).actions, []);
});

test("Phase 6: while the account owes our pool, posting collateral waits for a fresh check too", () => {
  const used = verdict({ blk: 5_000, receivedBlock: 5_004, nonce: 7 });
  const owing = { owesPool: true, counter: 8, funding: fundingPlan([false, false, false]), chainBlock: 5_010 };
  const first = decide({}, seen({ ...owing, verdict: used }), T0, noHourly);
  assert.deepEqual(checks(first.actions), ["step 0 (l_supply) of funding plan f5000 needs a fresh check first: the last one was made before the account's latest change"]);
  const fresh = verdict({ blk: 5_020, receivedBlock: 5_024, nonce: 8 });
  assert.deepEqual(steps(decide(first.memory, seen({ ...owing, verdict: fresh, chainBlock: 5_030 }), T0 + 15 * S, noHourly).actions), ["f5000:0 l_supply"]);
  // A verdict over 90 blocks old would be too old by the time the step lands (the account's limit is 120).
  assert.deepEqual(checks(decide({}, seen({ ...owing, verdict: fresh, chainBlock: 5_111 }), T0, noHourly).actions), ["step 0 (l_supply) of funding plan f5000 needs a fresh check first: the last one is 91 blocks old"]);
});

test("Phase 6: a check that can't back the step is asked again every 150 s, three times in all; then the keeper stops the plan and says why", () => {
  const plan = fundingPlan([true, false, false]);
  const noRoom = [{ ...RHEA, d: 0, hf_bp: 0, room: 0 }];
  let m: Memory = {};
  const asked: number[] = [];
  const notes: string[] = [];
  for (let t = 0; t <= 9 * MIN; t += 15 * S) {
    // Each check brings a new verdict that is fresh and HEALTHY, and still gives Rhea no room.
    const v = verdict({ blk: 5_000 + t / S, receivedBlock: 5_004 + t / S, nonce: 9 });
    const d = decide(m, seen({ hasLoan: false, counter: 9, verdict: v, ext: noRoom, funding: plan, chainBlock: 5_010 + t / S }), T0 + t, noHourly);
    m = d.memory;
    for (const a of d.actions) {
      assert.equal(a.kind, "request_check");
      assert.match(a.reason, /^step 1 \(l_borrow\) of funding plan f5000 needs a fresh check first: the last one gives Rhea no room to lend against the collateral posted there$/);
      asked.push(t / S);
      m = afterAction(m, a, { ok: true }, T0 + t);
    }
    notes.push(...d.notes);
  }
  assert.deepEqual(asked, [0, 150, 300]);
  assert.deepEqual([FUND_CHECK_EVERY_MS, MAX_FUND_CHECKS], [150 * S, 3]);
  assert.deepEqual(notes, ["step 1 (l_borrow) of funding plan f5000 can't run: after 3 checks, the last one gives Rhea no room to lend against the collateral posted there: the keeper stops this plan here, and the client can ask again"]);

  // Not HEALTHY, and a pool that may lend nothing, are said the same way.
  const watch = verdict({ state: "WATCH", blk: 5_000, receivedBlock: 5_004, nonce: 9 });
  assert.match(checks(decide({ lastState: "WATCH" }, seen({ counter: 9, verdict: watch, funding: plan }), T0, noHourly).actions)[0]!, /the last one says WATCH, and new borrowing needs HEALTHY$/);
  const dry = verdict({ blk: 5_000, receivedBlock: 5_004, nonce: 9, allowBorrow: 0 });
  assert.match(checks(decide({}, seen({ counter: 9, verdict: dry, funding: fundingPlan([true, true, false]) }), T0, noHourly).actions)[0]!, /^step 2 \(p_borrow\) of funding plan f5000 needs a fresh check first: the last one lets our pool lend nothing now$/);
});

test("Phase 6: a refused funding step is tried again, three times in all; an expired plan and a step that moves money between chains are left, each with one note", () => {
  const v = verdict({ blk: 5_000, receivedBlock: 5_004, nonce: 9 });
  const ext = [{ ...RHEA, d: 0, hf_bp: 0, room: 572_000_000 }];
  const s = seen({ counter: 9, verdict: v, ext, funding: fundingPlan([true, false, false]), chainBlock: 5_010 });
  let m: Memory = {};
  const tried: number[] = [];
  const notes: string[] = [];
  for (let t = 0; t <= 2 * MIN; t += 15 * S) {
    const d = decide(m, s, T0 + t, noHourly);
    m = d.memory;
    for (const a of d.actions) {
      assert.deepEqual(steps([a]), ["f5000:1 l_borrow"]);
      tried.push(t / S);
      m = afterAction(m, a, { ok: false, replan: true, why: "Rhea has too little USDC free" }, T0 + t);
    }
    notes.push(...d.notes);
  }
  assert.deepEqual(tried, [0, 15, 30]);
  assert.deepEqual(notes, ["step 1 (l_borrow) of funding plan f5000 didn't go through in 3 tries (Rhea has too little USDC free): the keeper stops this plan here, and the client can ask again"]);
  assert.equal(m.plans?.f5000, undefined, "a funding plan's steps are kept apart from the stored plan's");

  // A step that went out shows `done` within a tick; if it doesn't, it is tried again after a minute.
  const sent = afterAction(decide({}, s, T0, noHourly).memory, { kind: "execute_step", pid: "f5000", i: 1, k: "l_borrow", reason: "" }, { ok: true }, T0);
  assert.deepEqual(decide(sent, s, T0 + 45 * S, noHourly).actions, []);
  assert.deepEqual(steps(decide(sent, s, T0 + 60 * S, noHourly).actions), ["f5000:1 l_borrow"]);

  // Past its 30 minutes, by the chain's clock: nothing more is run.
  const late = seen({ counter: 9, verdict: v, ext, funding: fundingPlan([true, false, false]), chainNowMs: T0 + 31 * MIN });
  const expired = decide({}, late, T0 + 31 * MIN, noHourly);
  assert.deepEqual([expired.actions, expired.notes], [[], ["funding plan f5000 ran out of its 30 minutes with step 1 (l_borrow) of funding plan f5000 still to run: the client can ask for the rest again"]]);
  assert.deepEqual(decide(expired.memory, late, T0 + 32 * MIN, noHourly).notes, []);
  // With no loan either, an expired plan is nothing to watch.
  assert.deepEqual(decide({}, { ...late, hasLoan: false }, T0 + 31 * MIN, noHourly), { actions: [], notes: [], memory: { verdictKey: "5000:5004", lastCounter: 9, lastState: "HEALTHY" } });

  // Stage 4's kinds: the keeper says so and waits.
  const move = readFunding({ funding: { pid: "f6000", amount: "5", stored_at: "1", expires_at: String(BigInt(T0 + 30 * MIN) * 1_000_000n), steps: [{ k: "to_evm", tok: MNBTC, amt: "1500000", min: "1490000", dep: "ab".repeat(32), exp: T0 + 9 * MIN, done: false }] } });
  const left = decide({}, seen({ counter: 9, verdict: v, funding: move }), T0, noHourly);
  assert.deepEqual([left.actions, left.notes], [[], ["step 0 (to_evm) of funding plan f6000 moves money between chains, which the keeper doesn't run yet: move 1500000 units of mnbtc.pbf-ops.testnet through 1Click to the account's own Ethereum address"]]);
});

test("Phase 6: bitcoin's fall asks for a check when it brings a lender's cushion near 1.35, once per verdict, and again as it falls through 1.35 and 1.2", () => {
  const btc = (mark: number, rhea?: number): Prices => ({ marks: { BTC: mark }, pi: { nBTC: 10_000 }, ...(rhea !== undefined ? { lenders: { rhea } } : {}) });
  // The verdict has a BTC band far above, so the keeper has no other reason to ask as BTC falls.
  const far = { BTC: { hl100: 200_000_000_000 } };
  const held = verdict({ bands: far });
  const first = settle({}, seen({ verdict: held, ext: [RHEA], prices: btc(76_000) }), T0);
  // 1.5 x 70,000 / 76,000 = 1.382: not near yet. At 69,700 it is 1.376, inside 2% of 1.35.
  assert.deepEqual(checks(decide(first.memory, seen({ verdict: held, ext: [RHEA], prices: btc(70_000) }), T0 + 15 * S, noHourly).actions), []);
  const near = decide(first.memory, seen({ verdict: held, ext: [RHEA], prices: btc(69_700) }), T0 + 15 * S, noHourly);
  assert.deepEqual(checks(near.actions), ["Rhea's cushion was 1.50 at the last check, and BTC on Hyperliquid has gone from $76,000 to $69,700 since: about 1.376 now, close to 1.35, where it gets topped up"]);
  assert.deepEqual(decide(near.memory, seen({ verdict: held, ext: [RHEA], prices: btc(60_000) }), T0 + 30 * S, noHourly).actions, [], "once per verdict");

  // The verdict that check brings says 1.376 and asks for nothing. From there, a fall through 1.35 asks again.
  let m = near.memory;
  for (const a of near.actions) m = afterAction(m, a, { ok: true }, T0 + 15 * S);
  const thin = verdict({ blk: 1_030, receivedBlock: 1_034, at: T0 + 25 * S, bands: far });
  const ext = [{ ...RHEA, hf_bp: 13_757 }];
  assert.deepEqual(checks(decide(m, seen({ verdict: thin, ext, prices: btc(69_200) }), T0 + 30 * S, noHourly).actions), [], "1.366: under the near level already, and not yet 1% lower");
  const act = decide(m, seen({ verdict: thin, ext, prices: btc(68_300) }), T0 + 30 * S, noHourly);
  assert.deepEqual(checks(act.actions), ["Rhea's cushion was 1.38 at the last check, and BTC on Hyperliquid has gone from $69,700 to $68,300 since: about 1.348 now, under 1.35, where it gets topped up"]);

  // Where the keeper knows the lender's own price (our Rhea copy's), that is the one that counts, not Hyperliquid's.
  const own = settle({}, seen({ verdict: held, ext: [RHEA], prices: btc(76_000, 76_010) }), T0);
  assert.deepEqual(checks(decide(own.memory, seen({ verdict: held, ext: [RHEA], prices: btc(60_000, 76_000) }), T0 + 15 * S, noHourly).actions), [], "the copy hasn't moved");
  const drilled = decide(own.memory, seen({ verdict: held, ext: [RHEA], prices: btc(76_000, 60_000) }), T0 + 15 * S, noHourly);
  assert.deepEqual(checks(drilled.actions), ["Rhea's cushion was 1.50 at the last check, and bitcoin's price at Rhea has gone from $76,010 to $60,000 since: about 1.184 now, under 1.20, where it must be topped up now"]);

  // Nothing owed there, or a rise: nothing to ask.
  assert.deepEqual(checks(decide(first.memory, seen({ verdict: held, ext: [{ ...RHEA, d: 0, hf_bp: 0 }], prices: btc(40_000) }), T0 + 15 * S, noHourly).actions), []);
  assert.deepEqual(checks(decide(first.memory, seen({ verdict: held, ext: [RHEA], prices: btc(90_000) }), T0 + 15 * S, noHourly).actions), []);
});

test("Phase 6: where a lender is owed, the hourly check is followed by settle(); one whose check failed goes behind the next check", () => {
  const at = Date.UTC(2026, 10, 10, 13, 30);
  const scheduled = decide({}, seen({ ext: [RHEA] }), T0, () => 0.5);
  const hourly = decide(scheduled.memory, seen({ ext: [RHEA] }), at, () => 0.1);
  assert.deepEqual(hourly.actions, [
    { kind: "request_check", reason: "the hourly sample for the rating" },
    { kind: "settle", reason: "the hourly settlement, on the check just made: what the client pays on the lender's part against the operator's price" },
  ]);
  let m = hourly.memory;
  for (const a of hourly.actions) m = afterAction(m, a, { ok: true }, at);
  assert.equal(m.settleDue, undefined);
  assert.deepEqual(kinds(decide(m, seen({ ext: [RHEA] }), at + 15 * S, () => 0.1).actions), [], "once an hour");

  // No lender debt: the hourly check alone, as before.
  const plain = decide(decide({}, seen(), T0, () => 0.5).memory, seen({ ext: [{ ...RHEA, d: 0, hf_bp: 0 }] }), at, () => 0.1);
  assert.deepEqual(kinds(plain.actions), ["request_check"]);

  // The check didn't go out, so the loop held the settlement back: both go again on the next tick.
  let failed = afterAction(hourly.memory, hourly.actions[0]!, { ok: false, retry: true, why: "RPC timeout" }, at);
  failed = afterAction(failed, hourly.actions[1]!, { ok: false, retry: true, why: "the check before it failed" }, at);
  assert.deepEqual(failed.settleDue, { tries: 1 });
  const again = decide(failed, seen({ ext: [RHEA] }), at + 15 * S, () => 0.1);
  assert.deepEqual(again.actions.map((a) => a.kind), ["request_check", "settle"]);
  assert.match(again.actions[0]!.reason, /^again: the hourly sample/);
  // A settlement the pool or the account refused is left for the next hour's, which covers the time since.
  assert.equal(afterAction(hourly.memory, hourly.actions[1]!, { ok: false, retry: false, why: "refused" }, at).settleDue, undefined);
});

test("after a plan, a WATCH account is checked every 5 minutes until it is HEALTHY", () => {
  const watch = verdict({ state: "WATCH", blk: 3_000, receivedBlock: 3_002, at: T0 });
  const m: Memory = { ...settle({ lastState: "WATCH" }, seen({ verdict: watch }), T0).memory, recoveringSince: T0 - MIN };
  assert.deepEqual(checks(decide(m, seen({ verdict: watch }), T0 + 4 * MIN, noHourly).actions), []);
  assert.deepEqual(checks(decide(m, seen({ verdict: watch }), T0 + 5 * MIN, noHourly).actions), ["not HEALTHY yet after the plan: another check"]);
  const healthy = verdict({ state: "HEALTHY", blk: 3_100, receivedBlock: 3_104, at: T0 + 6 * MIN });
  assert.equal(decide(m, seen({ verdict: healthy }), T0 + 6 * MIN, noHourly).memory.recoveringSince, undefined);
});

test("a verdict an action used is refreshed after a quiet minute", () => {
  const used = settle({}, seen({ counter: 4 }), T0).memory; // nonce 3, counter 4: a borrow or a withdrawal used it
  assert.deepEqual(decide(used, seen({ counter: 4 }), T0 + 50 * S, noHourly).actions, []);
  const refresh = decide(used, seen({ counter: 4 }), T0 + 60 * S, noHourly);
  assert.deepEqual(checks(refresh.actions), ["an action used the last verdict, so its bands describe the book before it: a fresh check"]);
  assert.deepEqual(decide(refresh.memory, seen({ counter: 4 }), T0 + 2 * MIN, noHourly).actions, [], "once per verdict");
});

test("one check each hour at a random minute; a check that failed to send is sent again", () => {
  const scheduled = decide({}, seen(), T0, () => 0.5);
  assert.equal(scheduled.memory.nextHourlyAt, Date.UTC(2026, 10, 10, 13, 30));
  assert.deepEqual(checks(decide(scheduled.memory, seen(), Date.UTC(2026, 10, 10, 13, 30), () => 0.1).actions), ["the hourly sample for the rating"]);

  const asked = decide(scheduled.memory, seen(), Date.UTC(2026, 10, 10, 13, 30), () => 0.1);
  const failed = afterAction(asked.memory, asked.actions[0]!, { ok: false, retry: true, why: "RPC timeout" }, Date.UTC(2026, 10, 10, 13, 30));
  assert.deepEqual(checks(decide(failed, seen(), Date.UTC(2026, 10, 10, 13, 30, 15), () => 0.1).actions), ["again: the hourly sample for the rating"]);
});

test("nextHourlyCheck always lands in the next clock hour", () => {
  for (const r of [0, 0.25, 0.999]) assert.equal(new Date(nextHourlyCheck(T0, () => r)).getUTCHours(), 13);
});

test("DELEVERAGE: the second check is timed on the chain's clock, which first_at is measured in", () => {
  const firstAt = T0;
  const dl = verdict({ state: "DELEVERAGE", action: "DELEVERAGE", at: firstAt, bands: undefined });
  const m = settle({ lastState: "MARGIN_CALL" }, seen({ verdict: dl, firstDeleverageAtMs: firstAt }), T0 + 5 * S).memory;
  // The keeper's clock is 20 s ahead of the chain's: by the chain, 150 s haven't passed yet.
  const ahead = decide(m, seen({ verdict: dl, firstDeleverageAtMs: firstAt, chainNowMs: firstAt + 140 * S }), firstAt + 160 * S, noHourly);
  assert.deepEqual(checks(ahead.actions), []);
  const due = decide(m, seen({ verdict: dl, firstDeleverageAtMs: firstAt, chainNowMs: firstAt + 150 * S }), firstAt + 170 * S, noHourly);
  assert.deepEqual(checks(due.actions), ["the second check for DELEVERAGE, 150 s after the first verdict arrived"]);
});

test("a repay after a sale waits until the sale's transfer has resolved", () => {
  const confirm = verdict({ state: "DELEVERAGE", action: "DELEVERAGE", blk: 2_000, receivedBlock: 2_004, at: T0, bands: undefined });
  const steps = [
    { k: "perp", coin: "BTC", buy: false, sz: "0.001", px: "75000", done: false },
    { k: "sell", tok: "mnbtc.pbf-ops.testnet", amt: "100000", min: 70_000_000, dep: "ab".repeat(32), exp: T0 + 9 * MIN, done: false },
    { k: "repay", amt: 70_000_000, done: false },
  ];
  const before = readPlan({ plan: { ...STORED, steps } });
  const first = decide({ lastState: "DELEVERAGE" }, seen({ verdict: confirm, firstDeleverageAtMs: T0, plan: before }), T0 + 10 * S, noHourly);
  assert.deepEqual(first.actions.map((a) => (a.kind === "execute_step" ? `${a.kind} ${a.i}` : a.kind)), ["deleverage", "execute_step 1"], "not the repay yet");
  let m = first.memory;
  for (const a of first.actions) m = afterAction(m, a, { ok: true }, T0 + 10 * S);
  const selling = readPlan({ plan: { ...STORED, steps: [steps[0], { ...steps[1], done: true }, steps[2]] } });
  const waiting = decide(m, seen({ verdict: confirm, firstDeleverageAtMs: T0, plan: selling, transfers: ["2000:1"] }), T0 + 25 * S, noHourly);
  assert.deepEqual(waiting.actions, [], "the sale's USDC hasn't arrived");
  const arrived = decide(waiting.memory, seen({ verdict: confirm, firstDeleverageAtMs: T0, plan: selling, transfers: [] }), T0 + 60 * S, noHourly);
  assert.deepEqual(arrived.actions.map((a) => a.kind === "execute_step" && a.i), [2]);
});

// ---------- one check at a time (11 Nov: a check can wait a minute or more for its turn at OutLayer) ----------

const CROSSED = "the nBTC ratio fell through 0.8500, where equity reaches the initial requirement (now 0.8400)";
const BTC_CROSSED =
  "BTC rose through $101,781.83, where Hyperliquid's margin ratio reaches 50% (now $103,100); " +
  "BTC rose through $103,038.39, where Hyperliquid's margin ratio reaches 100%, where it liquidates (now $103,100)";
/** The RPC stopped waiting for the check's transaction: no outcome came back, so the keeper doesn't know how it ended. */
const UNSEEN: Outcome = { ok: false, retry: true, pending: true, why: "RPC timeout" };

/** A check asked for at T0 + 15 s (the nBTC ratio crossed a band) whose end the keeper didn't see. */
function unseenCheck(): Memory {
  const first = settle({}, seen(), T0);
  const crossed = decide(first.memory, seen({ prices: pi(8_400) }), T0 + 15 * S, noHourly);
  assert.deepEqual(checks(crossed.actions), [CROSSED]);
  return afterAction(crossed.memory, crossed.actions[0]!, UNSEEN, T0 + 40 * S);
}

test("one check at a time: a check whose end wasn't seen is given 150 s before it is asked again, three times in all", () => {
  let m = unseenCheck();
  assert.deepEqual(m.checkPending, { at: T0 + 15 * S }, "the wait is measured from the moment the keeper asked");
  assert.equal(CHECK_WAIT_MS, 150 * S);
  const sent: number[] = [];
  for (let t = 45; t <= 900; t += 15) {
    const d = decide(m, seen({ prices: pi(8_400) }), T0 + t * S, noHourly);
    assert.deepEqual(d.notes, []);
    m = d.memory;
    for (const a of d.actions) {
      assert.deepEqual(a, { kind: "request_check", reason: `again: ${CROSSED}` });
      sent.push(t);
      m = afterAction(m, a, UNSEEN, T0 + (t + 25) * S);
    }
  }
  assert.deepEqual(sent, [165, 315], "150 s after each was asked for; with the first, three in all");
});

test("one check at a time: a check known to have failed is over, and is asked again on the next tick", () => {
  const first = settle({}, seen(), T0);
  const crossed = decide(first.memory, seen({ prices: pi(8_400) }), T0 + 15 * S, noHourly);
  // The chain reported the failure (the transaction has a hash), or the account refused the verdict.
  const failed = afterAction(crossed.memory, crossed.actions[0]!, { ok: false, retry: true, why: "a receipt failed" }, T0 + 20 * S);
  assert.equal(failed.checkPending, undefined);
  assert.deepEqual(checks(decide(failed, seen({ prices: pi(8_400) }), T0 + 30 * S, noHourly).actions), [`again: ${CROSSED}`]);
  // One that came back with its verdict leaves nothing to wait for.
  assert.equal(afterAction({ ...crossed.memory, checkPending: { at: T0 } }, crossed.actions[0]!, { ok: true }, T0 + 20 * S).checkPending, undefined);
});

test("one check at a time: what asks meanwhile is kept, said once, and goes out as one check when the first is over", () => {
  const m = unseenCheck();
  const high: Prices = { marks: { BTC: 103_100 }, pi: { nBTC: 8_400 } };
  const held = decide(m, seen({ prices: high }), T0 + 30 * S, noHourly);
  assert.deepEqual(held.actions, []);
  assert.deepEqual(held.notes, [
    "a check waits its turn: the one the keeper asked for 15 s ago hasn't come back, and another now would only queue behind it. " +
      `It goes out when that one's verdict lands, or 150 s after it was asked for (${BTC_CROSSED})`,
  ]);
  const still = decide(held.memory, seen({ prices: high }), T0 + 150 * S, noHourly);
  assert.deepEqual([still.actions, still.notes], [[], []], "135 s after it asked: still waiting, and said once");
  // 150 s after it asked, with no verdict: one check for everything that asked.
  const over = decide(still.memory, seen({ prices: high }), T0 + 165 * S, noHourly);
  assert.deepEqual(over.actions, [{ kind: "request_check", reason: BTC_CROSSED }]);
  assert.equal(over.memory.checkHeld, undefined);
  assert.deepEqual(decide(afterAction(over.memory, over.actions[0]!, { ok: true }, T0 + 170 * S), seen({ prices: high }), T0 + 180 * S, noHourly).actions, [], "and nothing is left to ask");
});

test("one check at a time: a verdict that lands ends the wait; the check isn't asked again, and only what asked meanwhile goes out", () => {
  const m = unseenCheck();
  // The check did go through: its verdict lands a minute later. Nothing else asked, so there is no second check.
  const landed = verdict({ blk: 1_060, receivedBlock: 1_064, at: T0 + 70 * S });
  const quiet = decide(m, seen({ verdict: landed, prices: pi(8_400) }), T0 + 75 * S, noHourly);
  assert.deepEqual([quiet.actions, quiet.notes], [[], []]);
  assert.deepEqual([quiet.memory.checkPending, quiet.memory.retryCheck], [undefined, undefined]);

  // BTC crossed its bands while the check was out: that is asked about once the verdict is in, as one check.
  const high: Prices = { marks: { BTC: 103_100 }, pi: { nBTC: 8_400 } };
  const held = decide(m, seen({ prices: high }), T0 + 30 * S, noHourly);
  const after = decide(held.memory, seen({ verdict: landed, prices: high }), T0 + 75 * S, noHourly);
  assert.deepEqual(after.actions, [{ kind: "request_check", reason: BTC_CROSSED }]);
  assert.deepEqual([after.memory.checkPending, after.memory.retryCheck, after.memory.checkHeld], [undefined, undefined, undefined]);
});

test("Phase 6: while a check is on its way, a funding step that needs one waits for it and counts no try of its own", () => {
  const plan = fundingPlan([true, false, false]);
  const noRoom = [{ ...RHEA, d: 0, hf_bp: 0, room: 0 }];
  const s = seen({ hasLoan: false, counter: 9, verdict: verdict({ blk: 5_000, receivedBlock: 5_004, nonce: 9 }), ext: noRoom, funding: plan, chainBlock: 5_010 });
  // No check comes back at all: each is given its 150 s, and after three the keeper stops the plan.
  let m: Memory = {};
  const asked: number[] = [];
  const notes: string[] = [];
  for (let t = 0; t <= 8 * MIN; t += 15 * S) {
    const d = decide(m, s, T0 + t, noHourly);
    m = d.memory;
    notes.push(...d.notes);
    for (const a of d.actions) {
      assert.deepEqual(a, { kind: "request_check", reason: "step 1 (l_borrow) of funding plan f5000 needs a fresh check first: the last one gives Rhea no room to lend against the collateral posted there" });
      asked.push(t / S);
      m = afterAction(m, a, UNSEEN, T0 + t + 10 * S);
    }
  }
  assert.deepEqual(asked, [0, 150, 300], "never two at once");
  const waits = "step 1 (l_borrow) of funding plan f5000 needs a fresh check first, and waits for the one the keeper asked for 15 s ago: the last one gives Rhea no room to lend against the collateral posted there";
  assert.deepEqual(notes, [
    waits,
    waits,
    waits,
    "step 1 (l_borrow) of funding plan f5000 can't run: after 3 checks, the last one gives Rhea no room to lend against the collateral posted there: the keeper stops this plan here, and the client can ask again",
  ]);

  // A check asked for something else (the hourly one, say) is the step's check too: the step asks for none of its own.
  const other: Memory = { verdictKey: "5000:5004", lastState: "HEALTHY", lastCounter: 9, lastCheckAt: T0 - 20 * S, checkPending: { at: T0 - 20 * S } };
  const behind = decide(other, s, T0, noHourly);
  assert.deepEqual(behind.actions, []);
  assert.equal(behind.memory.fundings?.f5000?.check, undefined, "no try counted");
  // Its verdict lands, and gives Rhea room: the step runs on it.
  const good = seen({ hasLoan: false, counter: 9, verdict: verdict({ blk: 5_020, receivedBlock: 5_024, nonce: 9 }), ext: [{ ...RHEA, d: 0, hf_bp: 0, room: 572_000_000 }], funding: plan, chainBlock: 5_030 });
  assert.deepEqual(steps(decide(behind.memory, good, T0 + 30 * S, noHourly).actions), ["f5000:1 l_borrow"]);
});

test("a check that failed three times is asked again two minutes later while what asked for it still holds: a thin cushion isn't left until the hourly check", () => {
  // 13 Nov: OutLayer gave no verdict for six minutes. The cushion rule asks once per verdict, so after three failed
  // tries nothing asked again, and a top-up waited 25 minutes for a check that never went out.
  const btc = (mark: number, rhea: number): Prices => ({ marks: { BTC: mark }, pi: { nBTC: 10_000 }, lenders: { rhea } });
  const held = verdict({ bands: { BTC: { hl100: 200_000_000_000 } } });
  const down = seen({ verdict: held, ext: [RHEA], prices: btc(76_000, 60_000) });
  const words = "Rhea's cushion was 1.50 at the last check, and bitcoin's price at Rhea has gone from $76,010 to $60,000 since: about 1.184 now, under 1.20, where it must be topped up now";
  let m = settle({}, seen({ verdict: held, ext: [RHEA], prices: btc(76_000, 76_010) }), T0).memory;
  let at = T0 + 15 * S;
  const failed = { ok: false, retry: true };
  // Three tries, each failing: the ask, then "again" twice.
  const said: string[] = [];
  for (let i = 0; i < 3; i++) {
    const d = decide(m, down, at, noHourly);
    said.push(...checks(d.actions));
    m = d.memory;
    for (const a of d.actions) m = afterAction(m, a, failed, at);
    at += 130 * S;
  }
  assert.deepEqual(said, [words, `again: ${words}`, `again: ${words}`]);
  const gaveUpAt = at - 130 * S;
  assert.equal(m.checkGaveUpAt, gaveUpAt);
  // Given up: nothing asks for two minutes, though the price is still down.
  assert.deepEqual(checks(decide(m, down, gaveUpAt + 15 * S, noHourly).actions), []);
  assert.deepEqual(checks(decide(m, down, gaveUpAt + CHECK_AGAIN_MS - S, noHourly).actions), []);
  // Two minutes on, the cushion is still thin: it asks again, in its own words, and the count starts over.
  const again = decide(m, down, gaveUpAt + CHECK_AGAIN_MS, noHourly);
  assert.deepEqual(checks(again.actions), [words]);
  assert.equal(again.memory.checkGaveUpAt, undefined);
  // Had the price come back in the meantime, nothing would ask.
  assert.deepEqual(checks(decide(m, seen({ verdict: held, ext: [RHEA], prices: btc(76_000, 76_010) }), gaveUpAt + CHECK_AGAIN_MS, noHourly).actions), []);
  // A new verdict ends it: the marks are the new verdict's own.
  const fresh = verdict({ blk: 1_030, receivedBlock: 1_034, at: gaveUpAt + 60 * S, bands: { BTC: { hl100: 200_000_000_000 } } });
  assert.equal(decide(m, seen({ verdict: fresh, ext: [RHEA], prices: btc(76_000, 60_000) }), gaveUpAt + 70 * S, noHourly).memory.checkGaveUpAt, undefined);
  // A check refused for good (retry false) isn't asked again this way.
  const first = decide(settle({}, seen({ verdict: held, ext: [RHEA], prices: btc(76_000, 76_010) }), T0).memory, down, T0 + 15 * S, noHourly);
  let refused = first.memory;
  for (const a of first.actions) refused = afterAction(refused, a, { ok: false, retry: false }, T0 + 15 * S);
  assert.equal(refused.checkGaveUpAt, undefined);
});

test("Phase 6: the fresh check after a lender action, and a cushion that asks for one, wait their turn behind a check that is on its way", () => {
  const far = { BTC: { hl100: 200_000_000_000 } };
  // A withdrawal at Rhea was listed until block 6020, which has passed. A check asked for 20 s ago is still out.
  const pendingLender = { lender: "rhea", kind: "withdraw", amount: "100000", untilBlock: 6_020 };
  const held = verdict({ blk: 6_001, receivedBlock: 6_004, bands: far });
  const base = settle({}, seen({ verdict: held, ext: [RHEA], chainBlock: 6_005 }), T0).memory;
  const out: Memory = { ...base, lastCheckAt: T0 + 10 * S, checkPending: { at: T0 + 10 * S } };
  const s = seen({ verdict: held, ext: [RHEA], pendingLender, chainBlock: 6_021 });
  const waits = decide(out, s, T0 + 30 * S, noHourly);
  assert.deepEqual([waits.actions, waits.notes], [[], []], "the check that is out, if read after block 6020, is the fresh one");
  assert.equal(waits.memory.lenderRecheck, undefined);
  // It never comes back: 150 s after it was asked for, the lender's fresh check goes out.
  const goes = decide(waits.memory, s, T0 + 160 * S, noHourly);
  assert.deepEqual(checks(goes.actions), ["the account counted its withdrawal at Rhea as under way until block 6020, which has passed: a fresh check"]);
  assert.deepEqual(goes.memory.lenderRecheck, { until: 6_020, at: T0 + 160 * S });
  // That one fails for good. With no verdict from after the block, another goes 150 s later, not sooner.
  const m = afterAction(goes.memory, goes.actions[0]!, { ok: false, retry: false, why: "refused" }, T0 + 165 * S);
  assert.equal(LENDER_RECHECK_MS, 150 * S);
  assert.deepEqual(decide(m, s, T0 + 295 * S, noHourly).actions, []);
  assert.equal(checks(decide(m, s, T0 + 310 * S, noHourly).actions).length, 1);

  // Bitcoin falls far enough to ask about Rhea's cushion while a check is out: kept, and asked when it is over.
  const btc = (mark: number): Prices => ({ marks: { BTC: mark }, pi: { nBTC: 10_000 } });
  const calm = verdict({ bands: far });
  const first = settle({}, seen({ verdict: calm, ext: [RHEA], prices: btc(76_000) }), T0).memory;
  const near = decide({ ...first, lastCheckAt: T0 + 5 * S, checkPending: { at: T0 + 5 * S } }, seen({ verdict: calm, ext: [RHEA], prices: btc(69_700) }), T0 + 15 * S, noHourly);
  assert.deepEqual(near.actions, []);
  assert.match(near.notes[0]!, /^a check waits its turn: the one the keeper asked for 10 s ago hasn't come back.*\(Rhea's cushion was 1\.50 at the last check/);
  const sent = decide(near.memory, seen({ verdict: calm, ext: [RHEA], prices: btc(69_700) }), T0 + 155 * S, noHourly);
  assert.deepEqual(checks(sent.actions), ["Rhea's cushion was 1.50 at the last check, and BTC on Hyperliquid has gone from $76,000 to $69,700 since: about 1.376 now, close to 1.35, where it gets topped up"]);
});

test("Phase 6: a settlement whose check comes back after the keeper stopped waiting goes out on that verdict, with no second check", () => {
  const at = Date.UTC(2026, 10, 10, 13, 30);
  const scheduled = decide({}, seen({ ext: [RHEA] }), T0, () => 0.5);
  const hourly = decide(scheduled.memory, seen({ ext: [RHEA] }), at, () => 0.1);
  // The check's end wasn't seen, so the loop held the settlement back.
  let m = afterAction(hourly.memory, hourly.actions[0]!, UNSEEN, at + 100 * S);
  m = afterAction(m, hourly.actions[1]!, { ok: false, retry: true, why: "the check before it failed" }, at + 100 * S);
  assert.deepEqual([m.settleDue, m.checkPending], [{ tries: 1 }, { at }]);
  assert.deepEqual(decide(m, seen({ ext: [RHEA] }), at + 110 * S, () => 0.1).actions, [], "still out: nothing");

  // Its verdict lands: settle() alone, on that verdict.
  const landed = verdict({ blk: 1_200, receivedBlock: 1_204, at: at + 115 * S });
  const settled = decide(m, seen({ verdict: landed, ext: [RHEA] }), at + 125 * S, () => 0.1);
  assert.deepEqual(settled.actions, [{ kind: "settle", reason: "the hourly settlement, on the check that has now come back: what the client pays on the lender's part against the operator's price" }]);
  assert.equal(afterAction(settled.memory, settled.actions[0]!, { ok: true }, at + 126 * S).settleDue, undefined);

  // No verdict 150 s after it asked: the check again, with the settlement behind it.
  const again = decide(m, seen({ ext: [RHEA] }), at + 150 * S, () => 0.1);
  assert.deepEqual(kinds(again.actions), ["request_check", "settle"]);
  assert.match(again.actions[0]!.reason, /^again: the hourly sample/);
});

// ---------- Stage 3: Aave, on its own chain (INTERFACES.md 33) ----------

const WBTC = "0x54114591963cf60ef3aa63befd6ec263d98145a4";
const AAVE_USDC = "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f";
const AAVE: LenderExt = { l: "aave", c: 1_130_000_000, d: 570_000_000, hf_bp: 15_000, r_bp: 74, s_bp: 9, room: 0, liq_bp: 8_300 };
type Tx = EvmSeen["signed"][number];
const tx = (nonce: number, kind: string, step: string | null = null, tip = "1000000"): Tx => ({ nonce, kind, step, tip });
/** The account's side on Aave's chain: its own nonce, the chain's, what it signed, and the tokens found approved. */
const evmOf = (nonce: number, chainNonce: number, signed: Tx[] = [], approved: string[] = []): EvmSeen => ({ nonce, chainNonce, signed, approved, usdc: AAVE_USDC, maxFee: "1000000000" });

/** A $1,100 loan with Aave: post 0.015 WBTC there, borrow $570 from it, then $530 from our pool. */
function aavePlan(done: [boolean, boolean, boolean]) {
  const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
  return readFunding({
    funding: {
      pid: "f5000",
      amount: "1100000000",
      stored_at: ns(T0),
      expires_at: ns(T0 + 30 * MIN),
      steps: [
        { k: "l_supply", l: "aave", tok: "0x54114591963CF60EF3aA63bEfD6eC263D98145a4", amt: "1500000", done: done[0] },
        { k: "l_borrow", l: "aave", amt: 570_000_000, done: done[1] },
        { k: "p_borrow", amt: 530_000_000, done: done[2] },
      ],
    },
  });
}

test("Stage 3: an Aave funding plan: the approval first, each transaction mined before the next step, a fresh check after each, and a second check at once when the account's counter moved", () => {
  // `fund` used the verdict that answered it (nonce 7, counter 8); the chain had used none of the account's nonces.
  const funded = verdict({ blk: 5_000, receivedBlock: 5_004, nonce: 7, evmNonce: 0 });
  const approve = tx(0, "approve");
  const supply = tx(1, "supply", "f5000:0");
  const borrow = tx(2, "borrow", "f5000:1");
  let now = T0;
  let m: Memory = {};
  const look = (s: Partial<Seen>) => {
    const d = decide(m, seen({ hasLoan: false, counter: 8, verdict: funded, chainBlock: 5_010, ...s }), now, noHourly);
    m = d.memory;
    for (const a of d.actions) m = afterAction(m, a, { ok: true }, now);
    now += 15 * S;
    return d;
  };

  // The Pool isn't approved for WBTC yet: evm_approve, and nothing else.
  const first = look({ funding: aavePlan([false, false, false]), evm: evmOf(0, 0) });
  assert.deepEqual(first.actions, [{ kind: "evm_approve", token: WBTC, reason: `step 0 (l_supply) of funding plan f5000 takes ${WBTC} from the account's address: Aave's Pool is approved for it first (once per token)` }]);
  // The approval is signed (the account's nonce is 1) and not mined yet (the chain's is 0): the step waits, said once.
  const waits = look({ funding: aavePlan([false, false, false]), evm: evmOf(1, 0, [approve]) });
  assert.deepEqual([waits.actions, waits.notes], [[], ["step 0 (l_supply) of funding plan f5000 waits: the account's transaction 0 on Aave's chain (an approval) isn't mined yet"]]);
  assert.deepEqual(look({ funding: aavePlan([false, false, false]), evm: evmOf(1, 0, [approve]) }).notes, []);
  // Mined, and the allowance is there. The account owes our pool nothing, so the collateral goes without a check.
  const posts = look({ funding: aavePlan([false, false, false]), evm: evmOf(1, 1, [approve], [WBTC]) });
  assert.deepEqual(steps(posts.actions), ["f5000:0 l_supply"]);

  // The supply is signed and not mined: the borrow waits, and no check is asked for yet.
  const supplying = look({ funding: aavePlan([true, false, false]), evm: evmOf(2, 1, [approve, supply], [WBTC]) });
  assert.deepEqual([supplying.actions, supplying.notes], [[], ["step 1 (l_borrow) of funding plan f5000 waits: the account's transaction 1 on Aave's chain (a supply at Aave) isn't mined yet"]]);
  // Mined: one fresh check, for the step and for the transaction together.
  const checked = look({ funding: aavePlan([true, false, false]), evm: evmOf(2, 2, [approve, supply], [WBTC]) });
  // (A minute has passed since `fund` used the last verdict, so the keeper's usual refresh rides the same check.)
  assert.deepEqual(checked.actions, [
    { kind: "request_check", reason: "the account's transaction 1 on Aave's chain (a supply at Aave) has been mined: a fresh check; an action used the last verdict, so its bands describe the book before it: a fresh check" },
  ]);
  // Its verdict read the chain after the supply (evm.nonce 2) and gives Aave room: the borrow runs.
  const posted = [{ ...AAVE, d: 0, hf_bp: 0, room: 600_000_000 }];
  const sees = verdict({ blk: 5_060, receivedBlock: 5_064, nonce: 8, evmNonce: 2 });
  const borrows = look({ verdict: sees, ext: posted, chainBlock: 5_070, funding: aavePlan([true, false, false]), evm: evmOf(2, 2, [approve, supply], [WBTC]) });
  assert.deepEqual(steps(borrows.actions), ["f5000:1 l_borrow"]);

  // The borrow is signed, and the account lists it as under way until the chain has used its nonce.
  const borrowing = look({ verdict: sees, ext: posted, chainBlock: 5_085, funding: aavePlan([true, true, false]), evm: evmOf(3, 2, [approve, supply, borrow], [WBTC]) });
  assert.deepEqual([borrowing.actions, borrowing.notes], [[], ["step 2 (p_borrow) of funding plan f5000 waits: the account's transaction 2 on Aave's chain (a borrow at Aave) isn't mined yet"]]);
  const again = look({ verdict: sees, ext: posted, chainBlock: 5_100, funding: aavePlan([true, true, false]), evm: evmOf(3, 3, [approve, supply, borrow], [WBTC]) });
  assert.deepEqual(checks(again.actions), ["the account's transaction 2 on Aave's chain (a borrow at Aave) has been mined: a fresh check"]);
  // That verdict saw the borrow mined, so the account dropped it from `pending`, which moved its counter to 9: the
  // pool's step needs one more check, and it goes at once, not 150 s later.
  const dropped = verdict({ blk: 5_110, receivedBlock: 5_114, nonce: 8, evmNonce: 3 });
  const once = look({ hasLoan: true, counter: 9, verdict: dropped, ext: [AAVE], chainBlock: 5_120, funding: aavePlan([true, true, false]), evm: evmOf(3, 3, [approve, supply, borrow], [WBTC]) });
  assert.deepEqual(once.actions, [{ kind: "request_check", reason: "step 2 (p_borrow) of funding plan f5000 needs a fresh check first: the last one was made before the account's latest change" }]);
  const ready = verdict({ blk: 5_130, receivedBlock: 5_134, nonce: 9, evmNonce: 3, allowBorrow: 530_000_000 });
  const lends = look({ hasLoan: true, counter: 9, verdict: ready, ext: [AAVE], chainBlock: 5_140, funding: aavePlan([true, true, false]), evm: evmOf(3, 3, [approve, supply, borrow], [WBTC]) });
  assert.deepEqual(steps(lends.actions), ["f5000:2 p_borrow"]);

  // Every step has run: the last check, and USDC approved for Aave's Pool ahead of any repayment.
  const done = look({ hasLoan: true, counter: 10, owesPool: true, verdict: ready, ext: [AAVE], chainBlock: 5_150, funding: aavePlan([true, true, true]), evm: evmOf(3, 3, [approve, supply, borrow], [WBTC]) });
  assert.deepEqual(done.actions, [
    { kind: "evm_approve", token: AAVE_USDC, reason: "Aave is owed: its Pool is approved to take USDC from the account's address now, so that a repayment needs no extra step later" },
    { kind: "request_check", reason: "the steps of funding plan f5000 have run: a check to see where the account stands" },
  ]);
  assert.equal(now - T0, 12 * 15 * S, "twelve ticks, with transactions mined and checks back inside a tick");
});

test("Stage 3: an approval that doesn't come is asked for three times, a minute apart, and then left with one note", () => {
  const s = seen({ hasLoan: false, counter: 8, verdict: verdict({ blk: 5_000, receivedBlock: 5_004, nonce: 7, evmNonce: 0 }), chainBlock: 5_010, funding: aavePlan([false, false, false]), evm: evmOf(0, 0) });
  let m: Memory = {};
  const asked: number[] = [];
  const notes: string[] = [];
  for (let t = 0; t <= 5 * MIN; t += 15 * S) {
    const d = decide(m, s, T0 + t, noHourly);
    m = d.memory;
    notes.push(...d.notes);
    for (const a of d.actions) {
      // (`fund` used the last verdict, so after a quiet minute the keeper also refreshes it, as for any account.)
      if (a.kind === "evm_approve") asked.push(t / S);
      else assert.equal(a.kind, "request_check");
      m = afterAction(m, a, a.kind === "evm_approve" ? { ok: false, retry: true, why: "the signer didn't answer" } : { ok: true }, T0 + t);
    }
  }
  assert.deepEqual(asked, [0, 60, 120]);
  assert.deepEqual(notes, [`${WBTC} still isn't approved for Aave's Pool after 3 tries of evm_approve: the keeper stops asking, and what needs it waits`]);
});

test("Stage 3: a top-up at Aave: USDC is approved first, the repayment runs on the same verdict, and nothing more is asked or run until it is mined", () => {
  const thin = verdict({ state: "WATCH", action: "REBALANCE", blk: 2_300, receivedBlock: 2_302, evmNonce: 3, bands: { BTC: { hl100: 200_000_000_000 } } });
  const raw = [{ k: "l_repay", l: "aave", amt: 74_320_000, done: false }];
  const topUp = readPlan({ plan: { pid: "2300", action: "REBALANCE", stored_at: "1", steps: raw } });
  const ext = [{ ...AAVE, hf_bp: 13_200 }];
  const s = (evm: EvmSeen, over: Partial<Seen> = {}) => seen({ verdict: thin, plan: topUp, ext, evm, ...over });

  const first = decide({ lastState: "WATCH" }, s(evmOf(3, 3)), T0, noHourly);
  assert.deepEqual(first.actions, [{ kind: "evm_approve", token: AAVE_USDC, reason: `step 0 (l_repay) of plan 2300 takes ${AAVE_USDC} from the account's address: Aave's Pool is approved for it first (once per token)` }]);
  // The approval is on its way: nothing.
  const approving = decide(first.memory, s(evmOf(4, 3, [tx(3, "approve")])), T0 + 15 * S, noHourly);
  assert.deepEqual([approving.actions, approving.notes], [[], []]);
  // Mined. An approval changes no position, so the verdict that ordered the top-up still stands, and the step runs.
  const runs = decide(approving.memory, s(evmOf(4, 4, [tx(3, "approve")], [AAVE_USDC])), T0 + 30 * S, noHourly);
  assert.deepEqual(steps(runs.actions), ["2300:0 l_repay"]);
  let m = afterAction(runs.memory, runs.actions[0]!, { ok: true }, T0 + 30 * S);

  // The repayment is signed and not mined. Bitcoin falls further, but the cushion the verdict shows is from before
  // the repayment: no cushion check, no "steps have run" check, no second top-up.
  const done = readPlan({ plan: { pid: "2300", action: "REBALANCE", stored_at: "1", steps: [{ ...raw[0], done: true }] } });
  const signed = [tx(3, "approve"), tx(4, "repay", "2300:0")];
  const low: Prices = { marks: { BTC: 60_000 }, pi: { nBTC: 10_000 } };
  const unmined = decide(m, s(evmOf(5, 4, signed, [AAVE_USDC]), { plan: done, prices: low }), T0 + 45 * S, noHourly);
  assert.deepEqual([unmined.actions, unmined.notes], [[], []]);
  // Mined: one check, for the plan and the transaction together.
  const mined = decide(unmined.memory, s(evmOf(5, 5, signed, [AAVE_USDC]), { plan: done, prices: low }), T0 + 60 * S, noHourly);
  assert.deepEqual(mined.actions, [{ kind: "request_check", reason: "the account's transaction 4 on Aave's chain (a repayment to Aave) has been mined: a fresh check; the steps of plan 2300 have run: a check to see where the account stands" }]);
  m = afterAction(mined.memory, mined.actions[0]!, { ok: true }, T0 + 60 * S);
  assert.deepEqual(decide(m, s(evmOf(5, 5, signed, [AAVE_USDC]), { plan: done, prices: low }), T0 + 75 * S, noHourly).actions, [], "one check, not one a tick");

  // A top-up ordered by a verdict from before a transaction was mined waits for the fresh check, as at Rhea.
  const early = decide({ lastState: "WATCH" }, s(evmOf(4, 4, [tx(3, "repay")], [AAVE_USDC])), T0, noHourly);
  assert.deepEqual(steps(early.actions), ["request_check"]);
  assert.match(early.actions[0]!.reason, /^the account's transaction 3 on Aave's chain \(a repayment to Aave\) has been mined: a fresh check$/);
  // A Rhea top-up isn't held back by Aave's chain.
  const rheaPlan = readPlan({ plan: { pid: "2300", action: "REBALANCE", stored_at: "1", steps: [{ k: "l_repay", l: "rhea", amt: 5_000_000, done: false }] } });
  assert.deepEqual(steps(decide({ lastState: "WATCH" }, s(evmOf(5, 4, signed, [AAVE_USDC]), { plan: rheaPlan, ext: [RHEA] }), T0, noHourly).actions), ["2300:0 l_repay"]);
});

test("INTERFACES.md 47.1 (A10): a transaction that stays unmined is signed again after 3 minutes with a fee limit a tenth above the kept one and ten times the tip, never above that fee limit; seven times at most, and not within a minute of its signing", () => {
  const v = verdict({ evmNonce: 4, bands: { BTC: { hl100: 200_000_000_000 } } });
  const stuckAt = (kept: Tx, memory: Memory, t: number) => decide(memory, seen({ verdict: v, ext: [AAVE], evm: evmOf(5, 4, [kept], [AAVE_USDC]) }), T0 + t, noHourly);
  // The account's first try: half the config's limit of 1 gwei as its fee limit, and a tip of 1,000,000 wei.
  let kept: Tx = { ...tx(4, "repay"), fee: "500000000" };
  let m: Memory = {};
  const bumps: [number, string, string][] = [];
  const notes: string[] = [];
  for (let t = 0; t <= 30 * MIN; t += 15 * S) {
    const d = stuckAt(kept, m, t);
    m = d.memory;
    notes.push(...d.notes);
    for (const a of d.actions) {
      assert.equal(a.kind, "evm_bump");
      if (a.kind !== "evm_bump") continue;
      assert.equal(a.nonce, 4);
      bumps.push([t / S, a.maxFee, a.tip]);
      kept = { ...kept, fee: a.maxFee, tip: a.tip }; // the account signed nonce 4 again with these
      m = afterAction(m, a, { ok: true }, T0 + t);
    }
  }
  // Each fee limit is the kept one and a tenth: seven fit under the config's 1,000,000,000 from half of it. The tip
  // goes up tenfold until that would pass the new fee limit, and is the fee limit from then on.
  assert.deepEqual(bumps, [
    [180, "550000000", "10000000"],
    [360, "605000000", "100000000"],
    [540, "665500000", "665500000"],
    [720, "732050000", "732050000"],
    [900, "805255000", "805255000"],
    [1080, "885780500", "885780500"],
    [1260, "974358550", "974358550"],
  ]);
  assert.deepEqual(notes, []);
  const first = stuckAt({ ...tx(4, "repay"), fee: "500000000" }, { evmStuck: { nonce: 4, since: T0 - 180 * S, bumps: 0 } }, 0);
  assert.deepEqual(first.actions, [
    {
      kind: "evm_bump",
      nonce: 4,
      maxFee: "550000000",
      tip: "10000000",
      reason: "the account's transaction 4 on Aave's chain (a repayment to Aave) isn't mined after 180 s: signed again with a fee limit of 550000000 wei instead of 500000000, a tenth more, and a tip of 10000000 wei instead of 1000000; the config's limit is 1000000000 wei",
    },
  ]);
  // A tenth more is rounded up, the lowest the account takes: 500,000,001 gives 550,000,002, and 7 gives 8.
  const due: Memory = { evmStuck: { nonce: 4, since: T0 - 180 * S, bumps: 0 } };
  const feeAfter = (fee: string) => (stuckAt({ ...tx(4, "repay", null, "1"), fee }, due, 0).actions[0] as { maxFee: string }).maxFee;
  assert.deepEqual([feeAfter("500000001"), feeAfter("7"), feeAfter("10")], ["550000002", "8", "11"]);

  // A fee limit within a tenth of the config's can't go higher: said once, and left.
  let near: Memory = {};
  const said: string[] = [];
  for (let t = 0; t <= 8 * MIN; t += 15 * S) {
    const d = stuckAt({ ...tx(4, "repay"), fee: "950000000" }, near, t);
    near = d.memory;
    assert.deepEqual(d.actions, []);
    said.push(...d.notes);
  }
  assert.deepEqual(said, ["the account's transaction 4 on Aave's chain (a repayment to Aave) isn't mined after 180 s, and the keeper can't sign it again with more: a tenth above its fee limit (950000000 wei) would be 1045000000 wei, over the config's limit of 1000000000 wei"]);
  // Fees the keeper can't read: said, and nothing sent.
  const unread = stuckAt(tx(4, "repay"), due, 0);
  assert.deepEqual([unread.actions, unread.notes], [[], ["the account's transaction 4 on Aave's chain (a repayment to Aave) isn't mined after 180 s, and the keeper can't sign it again with more: its fees or the config's fee limit can't be read"]]);

  // The account makes anyone but its owner wait a minute from the block time a transaction was signed. The owner
  // has just bumped this one itself, 10 s ago: the keeper leaves it, says nothing, and bumps once the minute is over.
  const justSigned: Tx = { ...tx(4, "repay", null, "10000000"), fee: "550000000", signedAtMs: T0 - 10 * S };
  const waits = stuckAt(justSigned, due, 0);
  assert.deepEqual([waits.actions, waits.notes], [[], []]);
  assert.deepEqual(stuckAt(justSigned, waits.memory, 45 * S).actions, []);
  const then = stuckAt(justSigned, waits.memory, 50 * S);
  assert.deepEqual(then.actions.map((a) => (a.kind === "evm_bump" ? [a.maxFee, a.tip] : [])), [["605000000", "100000000"]]);
  // The chain's own clock counts, where the keeper has it.
  const byChain = decide(due, seen({ verdict: v, ext: [AAVE], evm: evmOf(5, 4, [justSigned], [AAVE_USDC]), chainNowMs: T0 + 55 * S }), T0, noHourly);
  assert.equal(byChain.actions.length, 1);

  // Once the chain has used the nonce, the watch on it ends.
  assert.equal(decide(m, seen({ verdict: verdict({ evmNonce: 5 }), ext: [AAVE], evm: evmOf(5, 5, [tx(4, "repay")], [AAVE_USDC]) }), T0 + 31 * MIN, noHourly).memory.evmStuck, undefined);
});

// ---------- Stage 4: the moves between NEAR and Aave's chain (INTERFACES.md 36) ----------

test("Stage 4: when the stand-in says a move to Aave's chain is delivered, the keeper asks for one check, with or without a loan, and again only if that check fails", () => {
  const words = "the stand-in says transfer move:7 to Aave's chain is delivered: a check, whose verdict settles it once it sees the money at the address";
  // A fresh account with nBTC only and no loan: nothing else is watched, and this one check is still asked for.
  const idle = seen({ hasLoan: false });
  const quiet = decide({}, idle, T0, noHourly);
  assert.deepEqual([quiet.actions, quiet.memory.arrivedAsked], [[], undefined]);
  const first = decide(quiet.memory, seen({ hasLoan: false, delivered: ["move:7"] }), T0 + 15 * S, noHourly);
  assert.deepEqual(first.actions, [{ kind: "request_check", reason: words }]);
  let m = afterAction(first.memory, first.actions[0]!, { ok: true }, T0 + 15 * S);
  assert.deepEqual(decide(m, seen({ hasLoan: false, delivered: ["move:7"] }), T0 + 30 * S, noHourly).actions, [], "once for a transfer, while the account still lists it");
  // The check didn't come back: 150 s later it is asked again; one known to have failed, on the next tick.
  m = afterAction(first.memory, first.actions[0]!, UNSEEN, T0 + 40 * S);
  assert.deepEqual(decide(m, seen({ hasLoan: false, delivered: ["move:7"] }), T0 + 150 * S, noHourly).actions, []);
  assert.deepEqual(decide(m, seen({ hasLoan: false, delivered: ["move:7"] }), T0 + 165 * S, noHourly).actions, [{ kind: "request_check", reason: `again: ${words}` }]);
  m = afterAction(first.memory, first.actions[0]!, { ok: false, retry: true, why: "a receipt failed" }, T0 + 20 * S);
  assert.deepEqual(checks(decide(m, seen({ hasLoan: false, delivered: ["move:7"] }), T0 + 30 * S, noHourly).actions), [`again: ${words}`]);
  // A second transfer delivered later gets its own check; two at once share one.
  m = afterAction(first.memory, first.actions[0]!, { ok: true }, T0 + 15 * S);
  assert.match(checks(decide(m, seen({ hasLoan: false, delivered: ["move:7", "move:9"] }), T0 + 45 * S, noHourly).actions)[0]!, /^the stand-in says transfer move:9 to Aave's chain is delivered/);
  assert.match(checks(decide({}, seen({ hasLoan: false, delivered: ["move:1", "move:2"] }), T0, noHourly).actions)[0]!, /^the stand-in says transfers move:1, move:2 to Aave's chain are delivered: a check, whose verdict settles them/);

  // With a loan it is one more reason for a check, behind any check that is already out.
  const loan = settle({}, seen(), T0);
  const withLoan = decide(loan.memory, seen({ delivered: ["move:8"] }), T0 + 15 * S, noHourly);
  assert.deepEqual(checks(withLoan.actions), [words.replace("move:7", "move:8")]);
  assert.deepEqual(withLoan.memory.arrivedAsked, ["move:8"]);
  const out: Memory = { ...loan.memory, lastCheckAt: T0 + 5 * S, checkPending: { at: T0 + 5 * S } };
  const held = decide(out, seen({ delivered: ["move:8"] }), T0 + 15 * S, noHourly);
  assert.deepEqual([held.actions, held.memory.arrivedAsked], [[], undefined], "not asked while a check is out, and not counted as asked");
  assert.equal(checks(decide(held.memory, seen({ delivered: ["move:8"] }), T0 + 155 * S, noHourly).actions).length, 1);
});

// ---------- The fixes after the second audit pass (INTERFACES.md 40; research/audit.md A8) ----------

test("the audit's A8: a lender's step waits for a check read after the permission last changed, which the counter no longer shows", () => {
  // The check was read at block 5040 and the counter hasn't moved since (9): before the fix, that was all it took.
  const posted = { ...RHEA, c: 1_130_000_000, d: 0, hf_bp: 0, room: 572_000_000 };
  const checked = verdict({ blk: 5_040, receivedBlock: 5_044, nonce: 9 });
  const base = { hasLoan: false, owesPool: false, perps: [], counter: 9, ext: [posted], funding: fundingPlan([true, false, false]), chainBlock: 5_050 };
  const run = (s: Partial<Seen>, m: Memory = {}, now = T0) => decide(m, seen({ ...base, verdict: checked, ...s }), now, noHourly);

  // An account from before the fix has no permission_blk; one whose permission is older than the check, or was never set (0), is no different.
  for (const permissionBlk of [undefined, 0, 5_039]) {
    assert.deepEqual(steps(run(permissionBlk === undefined ? {} : { permissionBlk }).actions), ["f5000:1 l_borrow"], String(permissionBlk));
  }
  // The owner changed the permission in block 5045, after the check: the account would refuse the borrow, so the
  // keeper asks for a new check first and runs nothing. The check's own block counts as before the change too.
  const held = run({ permissionBlk: 5_045 });
  assert.deepEqual(held.actions, [{ kind: "request_check", reason: "step 1 (l_borrow) of funding plan f5000 needs a fresh check first: the last one was read before the permission last changed (block 5045)" }]);
  assert.deepEqual(kinds(run({ permissionBlk: 5_040 }).actions), ["request_check"], "a check read in the block of the change is not above it");

  // That check comes back, read after the change: the borrow runs on it.
  let m = afterAction(held.memory, held.actions[0]!, { ok: true }, T0);
  const after = verdict({ blk: 5_060, receivedBlock: 5_064, nonce: 9 });
  assert.deepEqual(steps(run({ verdict: after, permissionBlk: 5_045, chainBlock: 5_070 }, m, T0 + 15 * S).actions), ["f5000:1 l_borrow"]);
  // A check that came back and found the permission changed again is asked again at once, not 150 s later.
  const again = run({ verdict: after, permissionBlk: 5_066, chainBlock: 5_070 }, m, T0 + 15 * S);
  assert.deepEqual(checks(again.actions), ["step 1 (l_borrow) of funding plan f5000 needs a fresh check first: the last one was read before the permission last changed (block 5066)"]);
  // And three checks in all, as for any other reason: then the plan stops, in words.
  m = afterAction(again.memory, again.actions[0]!, { ok: true }, T0 + 15 * S);
  const third = run({ verdict: verdict({ blk: 5_080, receivedBlock: 5_084, nonce: 9 }), permissionBlk: 5_086, chainBlock: 5_090 }, m, T0 + 30 * S);
  assert.equal(checks(third.actions).length, 1);
  m = afterAction(third.memory, third.actions[0]!, { ok: true }, T0 + 30 * S);
  const stopped = run({ verdict: verdict({ blk: 5_100, receivedBlock: 5_104, nonce: 9 }), permissionBlk: 5_106, chainBlock: 5_110 }, m, T0 + 45 * S);
  assert.deepEqual([stopped.actions, stopped.notes], [[], ["step 1 (l_borrow) of funding plan f5000 can't run: after 3 checks, the last one was read before the permission last changed (block 5106): the keeper stops this plan here, and the client can ask again"]]);

  // Posting collateral reads a verdict while the account owes our pool: the same rule.
  const owing = { owesPool: true, hasLoan: true, funding: fundingPlan([false, false, false]) };
  assert.deepEqual(steps(run({ ...owing, permissionBlk: 5_039 }).actions), ["f5000:0 l_supply"]);
  assert.deepEqual(checks(run({ ...owing, permissionBlk: 5_045 }).actions), ["step 0 (l_supply) of funding plan f5000 needs a fresh check first: the last one was read before the permission last changed (block 5045)"]);
  // Our pool's own step isn't a lender's: the account asks no such thing of it.
  const lent = [{ ...posted, d: 570_000_000, hf_bp: 15_060, room: 0 }];
  const pool = run({ hasLoan: true, ext: lent, funding: fundingPlan([true, true, false]), verdict: verdict({ blk: 5_040, receivedBlock: 5_044, nonce: 9, allowBorrow: 530_000_000 }), permissionBlk: 5_045 });
  assert.deepEqual(steps(pool.actions), ["f5000:2 p_borrow"]);
});

// ---------- INTERFACES.md 44: a verdict the keeper didn't ask for is measured from its own block ----------

/** What a tick read: BTC on Hyperliquid, bitcoin's price at Rhea (where it was read), and the nBTC ratio. */
const read = (mark: number, rhea?: number, ratio = 10_000): Prices => ({ marks: { BTC: mark }, pi: { nBTC: ratio }, ...(rhea !== undefined ? { lenders: { rhea } } : {}) });
/** Kept ticks, oldest first and 15 s apart: the final block when each began, and what it read. */
const keptTicks = (...ticks: [number, Prices][]): KeptPrices[] => ticks.map(([block, prices], i) => ({ block, at: T0 + i * 15 * S, prices }));

test("INTERFACES.md 44: of the kept ticks that began at or before a verdict's block, the newest is passed over and the one before it is the reference", () => {
  const [a, b, c, d] = [read(76_000, 76_000), read(75_900, 76_000), read(75_800, 65_000), read(75_700, 65_000)];
  const kept = keptTicks([1_000, a], [1_028, b], [1_056, c], [1_084, d]);
  // The tick that began at block 1056 set Rhea's price itself, and the new price landed a few blocks later. A verdict
  // read at block 1060 doesn't have it, though the tick's own number says it could.
  assert.equal(pricesAtBlock(kept, 1_060), b, "not the tick that began at 1056: what it read can be newer than its block");
  assert.equal(pricesAtBlock(kept, 1_056), b, "nor for a verdict read at the very block it began at");
  assert.equal(pricesAtBlock(kept, 1_055), a);
  assert.equal(pricesAtBlock(kept, 1_090), c);
  assert.equal(pricesAtBlock(kept, 1_020), a, "only one kept tick is that old: that one");
  assert.equal(pricesAtBlock(kept, 999), undefined, "nothing that old is kept");
  assert.equal(pricesAtBlock(undefined, 1_060), undefined);
  assert.equal(pricesAtBlock([], 1_060), undefined);

  // A tick whose read of Rhea's price failed is passed over: Rhea's cushion is measured on Rhea's price at both ends.
  const gap = keptTicks([1_000, a], [1_028, read(75_900)], [1_056, c], [1_084, d]);
  assert.equal(pricesAtBlock(gap, 1_060), a);
  assert.equal(pricesAtBlock(keptTicks([1_028, read(75_900)], [1_056, c]), 1_040), undefined, "the only tick that old has no price for Rhea");
  // A keeper that reads no lender's price passes nothing over for that.
  const plain = keptTicks([1_000, read(76_000)], [1_028, read(75_900)], [1_056, read(75_800)]);
  assert.deepEqual(pricesAtBlock(plain, 1_060), read(75_900));
});

test("INTERFACES.md 44: a verdict the keeper didn't ask for is measured from what the keeper had read by the verdict's own block, for a lender's cushion, a band and a big move; one it asked for, from the moment it asked; with nothing that old kept, from now", () => {
  const far = { BTC: { hl100: 200_000_000_000 } };
  // The keeper holds a verdict it has seen, and asked for no check of its own.
  const first = settle({}, seen({ verdict: verdict({ bands: far }), ext: [RHEA], prices: read(76_000, 76_000), chainBlock: 1_010 }), T0);
  assert.deepEqual(first.actions, []);

  // Someone else's check is read at block 1050. Bitcoin's price at Rhea then falls from $76,000 to $65,000, and the
  // keeper first sees the verdict in the tick that began at block 1084, with the lower price.
  const theirs = verdict({ blk: 1_050, receivedBlock: 1_070, at: T0 + 40 * S, bands: far });
  const fell = keptTicks([1_000, read(76_000, 76_000)], [1_028, read(76_000, 76_000)], [1_056, read(76_000, 65_000)], [1_084, read(76_000, 65_000)]);
  const sight = (kept: KeptPrices[] | undefined, memory: Memory = first.memory) =>
    decide(memory, seen({ verdict: theirs, ext: [RHEA], prices: read(76_000, 65_000), chainBlock: 1_084, ...(kept ? { kept } : {}) }), T0 + 45 * S, noHourly);
  assert.deepEqual(checks(sight(fell).actions), ["Rhea's cushion was 1.50 at the last check, and bitcoin's price at Rhea has gone from $76,000 to $65,000 since: about 1.283 now, under 1.35, where it gets topped up"]);
  assert.deepEqual(sight(fell).memory.refPrices, read(76_000, 76_000), "the reference is what the keeper read by block 1050");
  assert.deepEqual(checks(decide(sight(fell).memory, seen({ verdict: theirs, ext: [RHEA], prices: read(76_000, 64_000), chainBlock: 1_112 }), T0 + 60 * S, noHourly).actions), [], "once per verdict");

  // Nothing that old is kept (the keeper has just started, or the verdict is more than 10 minutes old): from now.
  assert.deepEqual(sight(undefined).actions, []);
  assert.deepEqual(sight(fell.slice(2)).actions, []);
  assert.deepEqual(sight(fell.slice(2)).memory.refPrices, read(76_000, 65_000));

  // A verdict the keeper asked for is measured from the moment it asked, as before: here it asked after the fall.
  const asked: Memory = { ...first.memory, lastCheckAt: T0 + 30 * S, checkPrices: read(76_000, 65_000) };
  assert.deepEqual(sight(fell, asked).actions, []);
  assert.deepEqual(sight(fell, asked).memory.refPrices, read(76_000, 65_000));

  // The state bands use the same reference: the ratio fell through the verdict's 0.85 band after block 1050.
  const banded = verdict({ blk: 1_050, receivedBlock: 1_070, at: T0 + 40 * S });
  const slid = keptTicks([1_000, read(76_000, undefined, 10_000)], [1_028, read(76_000, undefined, 10_000)], [1_056, read(76_000, undefined, 8_400)], [1_084, read(76_000, undefined, 8_400)]);
  const band = decide(first.memory, seen({ verdict: banded, prices: read(76_000, undefined, 8_400), chainBlock: 1_084, kept: slid }), T0 + 45 * S, noHourly);
  assert.deepEqual(checks(band.actions), ["the nBTC ratio fell through 0.8500, where equity reaches the initial requirement (now 0.8400)"]);
  assert.deepEqual(decide(first.memory, seen({ verdict: banded, prices: read(76_000, undefined, 8_400), chainBlock: 1_084 }), T0 + 45 * S, noHourly).actions, [], "with nothing kept: from now");

  // And so does the big-move test, for a token the verdict has no band for.
  const bandless = verdict({ blk: 1_050, receivedBlock: 1_070, at: T0 + 40 * S, bands: far });
  const moved = keptTicks([1_000, read(76_000, undefined, 10_000)], [1_028, read(76_000, undefined, 10_000)], [1_056, read(76_000, undefined, 9_800)], [1_084, read(76_000, undefined, 9_800)]);
  const big = decide(first.memory, seen({ verdict: bandless, prices: read(76_000, undefined, 9_800), chainBlock: 1_084, kept: moved }), T0 + 45 * S, noHourly);
  assert.deepEqual(checks(big.actions), ["the nBTC ratio moved from 1.0000 to 0.9800 since the last verdict, which has no band for it"]);
});

test("INTERFACES.md 44: a tick that set Rhea's price itself is not the reference for a verdict read in the blocks just after it began", () => {
  const far = { BTC: { hl100: 200_000_000_000 } };
  const first = settle({}, seen({ verdict: verdict({ bands: far }), ext: [RHEA], prices: read(76_000, 76_000), chainBlock: 1_010 }), T0);
  // The tick that began at block 1056 set Rhea's price to $65,000; the new price landed in block 1064. Someone else's
  // check was read at block 1060, in between: its cushion of 1.50 is from before the fall.
  const kept = keptTicks([1_000, read(76_000, 76_000)], [1_028, read(76_000, 76_000)], [1_056, read(76_000, 65_000)], [1_084, read(76_000, 65_000)]);
  const theirs = verdict({ blk: 1_060, receivedBlock: 1_078, at: T0 + 40 * S, bands: far });
  const sight = decide(first.memory, seen({ verdict: theirs, ext: [RHEA], prices: read(76_000, 65_000), chainBlock: 1_084, kept }), T0 + 45 * S, noHourly);
  assert.deepEqual(checks(sight.actions), ["Rhea's cushion was 1.50 at the last check, and bitcoin's price at Rhea has gone from $76,000 to $65,000 since: about 1.283 now, under 1.35, where it gets topped up"]);
});

// ---------- INTERFACES.md 45.3: the pool's three findings, the keeper's side ----------

test("INTERFACES.md 45.3, item 9: the hourly settlement goes out for an account whose policy isn't pass-through, with no lender owed; a pass-through account, and one whose policy wasn't read, get the check alone", () => {
  const at = Date.UTC(2026, 10, 10, 13, 30);
  const hourlySettle = "the hourly settlement, on the check just made: what the client pays on the lender's part against the operator's price";
  // An account that owes our pool only (no lender position at all), under a fixed rate.
  const scheduled = decide({}, seen(), T0, () => 0.5);
  const fixed = decide(scheduled.memory, seen({ priced: true }), at, () => 0.1);
  assert.deepEqual(fixed.actions, [
    { kind: "request_check", reason: "the hourly sample for the rating" },
    { kind: "settle", reason: hourlySettle },
  ]);
  let m = fixed.memory;
  for (const a of fixed.actions) m = afterAction(m, a, { ok: true }, at);
  assert.deepEqual(kinds(decide(m, seen({ priced: true }), at + 15 * S, () => 0.1).actions), [], "once an hour: the policy counts on the tick the hourly check is due");
  // Pass-through, or a policy that couldn't be read: the hourly check alone, as before.
  assert.deepEqual(kinds(decide(scheduled.memory, seen({ priced: false }), at, () => 0.1).actions), ["request_check"]);
  assert.deepEqual(kinds(decide(scheduled.memory, seen(), at, () => 0.1).actions), ["request_check"]);
  // A lender repaid, the policy still there: settled all the same. And where a lender is owed nothing changes.
  assert.deepEqual(kinds(decide(scheduled.memory, seen({ ext: [{ ...RHEA, d: 0, hf_bp: 0 }], priced: true }), at, () => 0.1).actions), ["request_check", "settle"]);
  assert.deepEqual(kinds(decide(scheduled.memory, seen({ ext: [RHEA] }), at, () => 0.1).actions), ["request_check", "settle"]);
});

test("INTERFACES.md 45.3, item 10: a zero settlement the pool skipped as too soon is tried again once the pool's time between two settlements has passed, with a check before it, twice at most", () => {
  const WAIT = 2 * MIN;
  const check = "the pool skipped, as too soon, the settlement that reports a repaid lender as zero, and the time it keeps between two settlements has passed: one more check, with that settlement behind it";
  const again = { kind: "settle", reason: "the settlement that reports a repaid lender as zero, again, on the check just made: the pool skipped the last one as too soon", zero: true };
  const SKIPPED: Outcome = { ok: true, retry: false, tooSoon: true };
  const TAKEN: Outcome = { ok: true, retry: false };

  // How it went is booked. Too soon: one more try in the pool's time. Taken: nothing more. Not sent: as it was.
  const armed = afterZeroSettle({}, SKIPPED, T0, WAIT);
  assert.deepEqual(armed.zeroAgain, { at: T0 + WAIT, tries: 0, waitMs: WAIT });
  assert.equal(afterZeroSettle({}, TAKEN, T0, WAIT).zeroAgain, undefined);
  assert.equal(afterZeroSettle(armed, TAKEN, T0, WAIT).zeroAgain, undefined);
  assert.deepEqual(afterZeroSettle(armed, { ok: false, retry: true, why: "the check before it failed" }, T0, WAIT).zeroAgain, armed.zeroAgain);

  // A lender repaid usually leaves no loan at all: the try goes out from there too. Nothing before its time.
  const idle = seen({ hasLoan: false });
  const known: Memory = { ...decide({}, idle, T0, noHourly).memory, ...armed };
  assert.deepEqual(decide(known, idle, T0 + WAIT - 15 * S, noHourly).actions, []);
  assert.deepEqual(decide(known, idle, T0 + WAIT - 15 * S, noHourly).memory.zeroAgain, armed.zeroAgain, "kept while there is no loan");
  const first = decide(known, idle, T0 + WAIT, noHourly);
  assert.deepEqual(first.actions, [{ kind: "request_check", reason: check }, again]);
  assert.deepEqual(first.memory.zeroAgain, { tries: 1, waitMs: WAIT }, "asked for: no time set until its end is known");
  assert.deepEqual(decide(first.memory, idle, T0 + WAIT + 15 * S, noHourly).actions, [], "asked once");

  // The pool takes it: over. It skips it again: a second try, and after that the keeper stops asking.
  assert.equal(afterZeroSettle(first.memory, TAKEN, T0 + WAIT, WAIT).zeroAgain, undefined);
  const twice = afterZeroSettle(first.memory, SKIPPED, T0 + WAIT, WAIT);
  assert.deepEqual(twice.zeroAgain, { at: T0 + 2 * WAIT, tries: 1, waitMs: WAIT });
  const second = decide({ ...first.memory, ...twice }, idle, T0 + 2 * WAIT, noHourly);
  assert.deepEqual(kinds(second.actions), ["request_check", "settle"]);
  const stopped = afterZeroSettle(second.memory, SKIPPED, T0 + 2 * WAIT, WAIT);
  assert.deepEqual(stopped.zeroAgain, { tries: 2, waitMs: WAIT, stopped: true });
  assert.deepEqual(decide(stopped, idle, T0 + 10 * WAIT, noHourly).actions, [], "twice at most");
  assert.deepEqual(afterZeroSettle(stopped, SKIPPED, T0 + 10 * WAIT, WAIT).zeroAgain, stopped.zeroAgain, "a later skip starts nothing new");
  assert.equal(afterZeroSettle(stopped, TAKEN, T0 + 10 * WAIT, WAIT).zeroAgain, undefined, "until the pool takes one");

  // The try's check failed, so its settlement never went: it goes behind the check that is asked again.
  let failed = afterAction(first.memory, first.actions[0]!, { ok: false, retry: true, why: "a receipt failed" }, T0 + WAIT);
  failed = afterZeroSettle(failed, { ok: false, retry: true, why: "the check before it failed" }, T0 + WAIT, WAIT);
  const retried = decide(failed, idle, T0 + WAIT + 15 * S, noHourly);
  assert.deepEqual(retried.actions, [{ kind: "request_check", reason: `again: ${check}` }, again]);
  assert.deepEqual(retried.memory.zeroAgain, { tries: 1, waitMs: WAIT }, "the same try, not a new one");

  // With a loan (the account still owes our pool) it is one more reason for a check, and the settlement behind that
  // check is this one. While another check is out it waits its turn, and still goes behind the next.
  const loan = settle({}, seen(), T0);
  const owing: Memory = { ...loan.memory, ...armed };
  assert.deepEqual(decide(owing, seen(), T0 + WAIT - 15 * S, noHourly).actions, []);
  const withLoan = decide(owing, seen(), T0 + WAIT, noHourly);
  assert.deepEqual(withLoan.actions, [{ kind: "request_check", reason: check }, again]);
  assert.deepEqual(withLoan.memory.zeroAgain, { tries: 1, waitMs: WAIT });
  const out: Memory = { ...owing, lastCheckAt: T0 + WAIT - 5 * S, checkPending: { at: T0 + WAIT - 5 * S } };
  const held = decide(out, seen(), T0 + WAIT, noHourly);
  assert.deepEqual([held.actions, held.memory.checkHeld], [[], [check]]);
  assert.deepEqual(decide(held.memory, seen(), T0 + WAIT + CHECK_WAIT_MS, noHourly).actions, [{ kind: "request_check", reason: check }, again]);
});

// ---------- INTERFACES.md 47: the account's Low findings, the keeper's side ----------

test("INTERFACES.md 47.5 (A15): the keeper runs the account's stored plan under its own id; a kept plan's l_add runs when the held verdict orders the same steps again, and not under a check of another shape", () => {
  const raw = [
    { k: "l_add", l: "rhea", tok: MNBTC, amt: "2500000", done: false },
    { k: "l_repay", l: "rhea", amt: 10_133_000_000, done: false },
  ];
  // The account stored the plan of the check read at block 2300. A second check, read at block 2330, orders the same
  // two steps with other amounts: an account made since 47.5 keeps plan 2300, and runs its l_add under that check.
  const kept = readPlan({ plan: { pid: "2300", action: "REBALANCE", stored_at: "1", steps: raw } })!;
  const again = verdict({ state: "WATCH", action: "REBALANCE", blk: 2_330, receivedBlock: 2_333, planSteps: [{ k: "l_add", l: "rhea", tok: MNBTC }, { k: "l_repay", l: "rhea" }] });
  const ext = [{ ...RHEA, hf_bp: 12_500 }];
  const d = decide({ lastState: "WATCH" }, seen({ verdict: again, plan: kept, ext }), T0, noHourly);
  assert.deepEqual(steps(d.actions), ["2300:0 l_add", "2300:1 l_repay"], "the stored plan's id, never the newer verdict's block");
  assert.deepEqual(d.notes, []);
  assert.equal(ordersSamePlan(again, kept), true);

  // A held verdict of another shape, another action, or with no plan of its own doesn't back the l_add: as before,
  // the keeper says so and asks for a new plan, and the l_repay still runs.
  const others = [
    verdict({ state: "WATCH", action: "REBALANCE", blk: 2_330, receivedBlock: 2_333, planSteps: [{ k: "l_repay", l: "rhea" }] }),
    verdict({ state: "WATCH", action: "REBALANCE", blk: 2_330, receivedBlock: 2_333, planSteps: [{ k: "l_add", l: "aave", tok: MNBTC }, { k: "l_repay", l: "rhea" }] }),
    verdict({ state: "WATCH", action: "REBALANCE", blk: 2_330, receivedBlock: 2_333, planSteps: [{ k: "l_add", l: "rhea", tok: "other.testnet" }, { k: "l_repay", l: "rhea" }] }),
    verdict({ state: "WATCH", action: "REBALANCE_NOW", blk: 2_330, receivedBlock: 2_333, planSteps: [{ k: "l_add", l: "rhea", tok: MNBTC }, { k: "l_repay", l: "rhea" }] }),
    verdict({ state: "WATCH", action: "REBALANCE", blk: 2_330, receivedBlock: 2_333 }),
  ];
  for (const other of others) {
    assert.equal(ordersSamePlan(other, kept), false);
    const no = decide({ lastState: "WATCH" }, seen({ verdict: other, plan: kept, ext }), T0, noHourly);
    assert.deepEqual(steps(no.actions), ["2300:1 l_repay", "request_check"]);
    assert.ok(no.notes.includes("step 0 (l_add) of plan 2300 can't run any more: a later check has landed, and the account adds collateral only under the check that ordered it"));
  }

  // Whatever words the account refuses a step with, the keeper does the same: one check for a new plan.
  const tried = decide({ lastState: "WATCH" }, seen({ verdict: again, plan: kept, ext }), T0, noHourly);
  for (const why of ["step 0 of plan 2300 can't run: the latest check, read at block 2330, is not the one that ordered it", "step 0 of plan 2300 can't run: the latest check doesn't order this step", "anything else"]) {
    const refused = afterAction(tried.memory, tried.actions[0]!, { ok: false, replan: true, why }, T0);
    assert.deepEqual(checks(decide(refused, seen({ verdict: again, plan: kept, ext }), T0 + 15 * S, noHourly).actions), ["plan 2300 can't run as it is: a check for a new plan"]);
  }
});

test("INTERFACES.md 47.7: a top-up step our pool refuses (paused, or past the day's step limit) is tried three times, said once, and the check for a new plan waits three minutes", () => {
  const raw = [{ k: "l_repay", l: "rhea", amt: 72_800_000, done: false }];
  const topUp = readPlan({ plan: { pid: "2300", action: "REBALANCE", stored_at: "1", steps: raw } })!;
  const rebalance = verdict({ state: "HEALTHY", action: "REBALANCE", blk: 2_300, receivedBlock: 2_302, bands: { BTC: { hl100: 200_000_000_000 } } });
  const ext = [{ ...RHEA, hf_bp: 13_000 }];
  // The account's own words for a step that didn't go out: the keeper passes them on and doesn't read them.
  const why = "step 0 of plan 2300 didn't go out, as the pool refused it: the pool is paused, and it may run again";
  let m: Memory = { lastState: "HEALTHY" };
  const sent: number[] = [];
  const notes: string[] = [];
  const asked: [number, string][] = [];
  for (let t = 0; t <= 12 * MIN; t += 15 * S) {
    const d = decide(m, seen({ verdict: rebalance, plan: topUp, ext }), T0 + t, noHourly);
    m = d.memory;
    notes.push(...d.notes);
    for (const a of d.actions) {
      if (a.kind === "execute_step") sent.push(t / S);
      if (a.kind === "request_check") asked.push([t / S, a.reason]);
      // The step's transaction goes through and moves nothing; a check goes out as asked.
      m = afterAction(m, a, a.kind === "execute_step" ? { ok: false, retry: true, why } : { ok: true }, T0 + t);
    }
  }
  assert.deepEqual(sent, [0, 15, 30], "three tries, 15 s apart, and no more");
  assert.deepEqual(notes, [`step 0 (l_repay) of plan 2300 didn't go out in 3 tries (${why}): the keeper asks for a new plan in 3 minutes and tries again then`]);
  assert.deepEqual(asked, [[225, "step 0 (l_repay) of plan 2300 didn't go out 3 minutes ago: a check for a new plan, to try again"]], "one check, three minutes after the last try gave up");
  // The plan that check brings (a new id) is tried afresh.
  const next = readPlan({ plan: { pid: "3500", action: "REBALANCE", stored_at: "1", steps: raw } })!;
  const fresh = decide(m, seen({ verdict: verdict({ ...rebalance, blk: 3_500, receivedBlock: 3_502 }), plan: next, ext }), T0 + 13 * MIN, noHourly);
  assert.deepEqual(steps(fresh.actions), ["3500:0 l_repay"]);
  // Steps that ran are followed by their check at once, as before.
  const done = readPlan({ plan: { pid: "2300", action: "REBALANCE", stored_at: "1", steps: [{ ...raw[0], done: true }] } })!;
  assert.deepEqual(checks(decide({ lastState: "HEALTHY" }, seen({ verdict: rebalance, plan: done, ext }), T0, noHourly).actions), ["the steps of plan 2300 have run: a check to see where the account stands"]);
});
