import assert from "node:assert/strict";
import { test } from "node:test";

import { DrillContract, isMissingMethod, nbtcBands, parseMinutes, parseRatio, parseSlide, runSlide, slideFromBands, slideSchedule, slideWarnings } from "./drill-kit.js";
import { DrillWatch, keeperSees } from "./drill-watch.js";
import type { LogEvent } from "./jsonl.js";
import type { NearCall } from "./near-tx.js";
import type { AccountState } from "./state.js";

const T0 = Date.UTC(2026, 10, 10, 12, 0);
const ACCOUNT = "drill1.pbf.testnet";

test("ratios and slides from the command line", () => {
  assert.equal(parseRatio("0.75"), 7_500);
  assert.equal(parseRatio("1"), 10_000);
  assert.equal(parseRatio(".8412"), 8_412);
  for (const bad of ["0", "1.5", "0.12345", "-0.5", "abc", ""]) assert.throws(() => parseRatio(bad), /ratio/, bad);
  assert.deepEqual(parseSlide("0.84,0.80,0.75"), [8_400, 8_000, 7_500]);
  assert.equal(parseMinutes("2.5"), 2.5);
  assert.throws(() => parseMinutes("0"), /minutes/);
  assert.deepEqual(slideSchedule([8_400, 8_000, 7_500], 3, T0), [
    { at: T0, bp: 8_400 },
    { at: T0 + 180_000, bp: 8_000 },
    { at: T0 + 360_000, bp: 7_500 },
  ]);
  assert.deepEqual(slideWarnings([8_400, 8_400, 9_000]), ["step 2 (0.8400) isn't below step 1 (0.8400)", "step 3 (0.9000) isn't below step 2 (0.8400)"]);
});

test("the slide sets each ratio at its time with the drill's owner, and stops when told", async () => {
  const sent: { method: string; args: unknown }[] = [];
  const call: NearCall = async (contract, method, args, options) => {
    sent.push({ method, args });
    return { label: options.label, hash: `H${sent.length}`, ok: true, gas_tgas: 1, seconds: 1, logs: [] };
  };
  const drill = new DrillContract("drill.pbf-ops.testnet", async () => ({ bp: 10_000, set_at: "0" }) as never, call);
  let now = T0;
  const said: string[] = [];
  const txs = await runSlide(drill, slideSchedule([8_400, 8_000, 7_500], 3, T0), { now: () => now, sleep: async (ms) => void (now += ms), say: (l) => said.push(l) });
  assert.deepEqual(sent, [
    { method: "set_ratio", args: { bp: 8_400 } },
    { method: "set_ratio", args: { bp: 8_000 } },
    { method: "set_ratio", args: { bp: 7_500 } },
  ]);
  assert.equal(now, T0 + 360_000, "the last one six minutes in");
  assert.equal(txs.length, 3);
  assert.match(said[2]!, /^step 3 of 3: set the nBTC\/BTC ratio to 0\.7500 \(tx H3\)$/);

  let calls = 0;
  const stopped = await runSlide(drill, slideSchedule([8_400, 8_000], 3, now), { now: () => now, sleep: async (ms) => void (now += ms), say: () => {}, stop: () => ++calls > 1 });
  assert.equal(stopped.length, 1, "told to stop before the second");
  await assert.rejects(new DrillContract("d", async () => null as never, null).set(8_000), /no signing key/);
  await assert.rejects(drill.set(10_001), /at most 10000/);
});

/** near-api-js 7.4.0's error for a view the contract doesn't have, as the live drill answered get_ratio_for on 9 Nov. */
function missingMethod(): Error {
  const error = new Error("Contract method is not found at block height 276893096");
  error.name = "ContractMethodNotFoundError";
  return error;
}

test("Phase 5: per-account ratios (set_ratio_for, clear_ratio_for, get_ratio_for), and the shared set_ratio on the old code", async () => {
  const sent: { method: string; args: unknown; label: string }[] = [];
  const call: NearCall = async (_contract, method, args, options) => {
    sent.push({ method, args, label: options.label });
    return { label: options.label, hash: `H${sent.length}`, ok: true, gas_tgas: 1, seconds: 1, logs: [] };
  };
  const own = new Map<string, number>();
  const views = async (_c: string, method: string, args?: Record<string, unknown>) => {
    if (method === "get_ratio") return { bp: 10_000, set_at: "1" };
    if (method === "get_ratio_for") return { bp: own.get(String(args?.account_id)) ?? 10_000, set_at: "2" };
    throw new Error(`no ${method}`);
  };
  const drill = new DrillContract("drill.pbf-ops.testnet", views as never, call);
  assert.equal(await drill.perAccount(ACCOUNT), true);
  const set = await drill.setFor(ACCOUNT, 7_800);
  own.set(ACCOUNT, 7_800);
  assert.deepEqual([set.shared, (await drill.ratioFor(ACCOUNT)).bp, (await drill.ratio()).bp], [false, 7_800, 10_000]);
  const cleared = await drill.clearFor(ACCOUNT);
  assert.deepEqual(sent, [
    { method: "set_ratio_for", args: { account_id: ACCOUNT, bp: 7_800 }, label: `set_ratio_for ${ACCOUNT} 0.7800` },
    { method: "clear_ratio_for", args: { account_id: ACCOUNT }, label: `clear_ratio_for ${ACCOUNT}` },
  ]);
  assert.equal(cleared.shared, false);
  const said: string[] = [];
  let now = T0;
  await runSlide(drill, slideSchedule([8_200], 2, T0), { now: () => now, sleep: async (ms) => void (now += ms), say: (l) => said.push(l) }, ACCOUNT);
  assert.deepEqual(sent.at(-1)?.method, "set_ratio_for");
  assert.match(said[0]!, /^step 1 of 1: set drill1\.pbf\.testnet's nBTC\/BTC ratio to 0\.8200 \(tx H3\)$/);

  // The drill's deployed code today: no get_ratio_for. The tools set the shared ratio, and say every account sees it.
  sent.length = 0;
  const oldDrill = new DrillContract("drill.pbf-ops.testnet", (async (_c: string, method: string) => {
    if (method === "get_ratio") return { bp: 9_000, set_at: "1" };
    throw missingMethod();
  }) as never, call);
  assert.equal(await oldDrill.perAccount(ACCOUNT), false);
  assert.equal((await oldDrill.ratioFor(ACCOUNT)).bp, 9_000, "it reads the shared ratio");
  assert.equal((await oldDrill.setFor(ACCOUNT, 8_000)).shared, true);
  assert.equal((await oldDrill.clearFor(ACCOUNT)).shared, true);
  assert.deepEqual(sent.map((s) => [s.method, s.args]), [["set_ratio", { bp: 8_000 }], ["set_ratio", { bp: 10_000 }]]);
  said.length = 0;
  await runSlide(oldDrill, slideSchedule([7_900], 2, now), { now: () => now, sleep: async (ms) => void (now += ms), say: (l) => said.push(l) }, ACCOUNT);
  assert.match(said[0]!, /set the shared nBTC\/BTC ratio \(the drill has no per-account ratios yet\) to 0\.7900/);

  assert.ok(isMissingMethod(missingMethod()) && !isMissingMethod(new Error("RPC timeout")) && !isMissingMethod("x"));
  await assert.rejects(new DrillContract("d", (async () => { throw new Error("RPC timeout"); }) as never, call).perAccount(ACCOUNT), /RPC timeout/, "another failure isn't taken for old code");
  await assert.rejects(drill.setFor(ACCOUNT, 0), /above 0/);
});

function state(overrides: Partial<AccountState> & { v?: Record<string, unknown>; received?: number } = {}): AccountState {
  const { v, received, ...rest } = overrides;
  return {
    owner: "pbf-keeper.testnet",
    counter: 5,
    loan: { principal: "1097574230", open: true },
    verdict: v ? { intent: { check: {} }, received_block: received ?? 100, verdict: { ok: true, blk: 90, nonce: 5, state: "HEALTHY", action: "NONE", ...v } as never } : null,
    plan: null,
    pending: [],
    hl: { path: "hyperliquid-1", address: "0x1b242c24f5e67e93d7b58c3dad77ccc90dacd7d0" },
    ...rest,
  };
}

test("the drill's record: states in order, the plan confirmed twice, the buy-back, HEALTHY after it", () => {
  const w = new DrillWatch(ACCOUNT);
  let t = T0;
  const look = (s: AccountState, btc: number, bp: number) => w.observe({ at: (t += 15_000), state: s, btc, ratioBp: bp });
  look(state({ v: { state: "HEALTHY" }, received: 100 }), -0.015, 10_000);
  look(state({ v: { state: "WATCH", blk: 200 }, received: 205 }), -0.015, 8_400);
  look(state({ v: { state: "MARGIN_CALL", blk: 300 }, received: 305 }), -0.015, 8_000);
  look(state({ v: { state: "DELEVERAGE", action: "DELEVERAGE", blk: 400 }, received: 405 }), -0.015, 7_500);
  assert.equal(w.done(), false);
  const plan = { pid: "500", action: "DELEVERAGE", stored_at: "1", steps: [{ k: "repay", amt: 10_000_000, done: false }, { k: "perp", coin: "BTC", buy: true, sz: "0.00375", px: "76190", done: false }] };
  look(state({ v: { state: "DELEVERAGE", action: "DELEVERAGE", blk: 500 }, received: 505, plan }), -0.015, 7_500);
  const placedAt = new Date(t).toISOString();
  w.keeper([
    { t: placedAt, event: "gateway", msg: "pb-gateway ran deleverage", account: ACCOUNT, mode: "deleverage", ok: true, placed: [{ i: 1, k: "perp", status: "filled", filled_sz: "0.00375" }], attestation_url: "https://a/c1" },
    { t: placedAt, event: "step", msg: "execute_step ran step 0 (repay) of plan 500", account: ACCOUNT, pid: "500", i: 0, tx: "H1" },
    { t: new Date(t).toISOString(), event: "check", msg: "for someone else", account: "other.pbf.testnet" },
    { t: new Date(t).toISOString(), event: "tick", msg: "1 client account(s) to look at" },
  ]);
  look(state({ v: { state: "DELEVERAGE", action: "DELEVERAGE", blk: 500 }, received: 505, plan: { ...plan, steps: [{ ...plan.steps[0], done: true }, plan.steps[1]] } }), -0.01125, 7_500);
  look(state({ v: { state: "HEALTHY", blk: 600 }, received: 605 }), -0.01125, 7_500);

  assert.equal(w.done(), true);
  const checks = w.checks();
  assert.deepEqual(
    { ...checks, buy_back: { ...checks.buy_back, gateway_placed: checks.buy_back.gateway_placed.length } },
    {
      watch_seen: true,
      margin_call_seen: true,
      deleverage_verdicts: 2,
      in_order: true,
      plan_stored: { pid: "500", action: "DELEVERAGE", steps: ["0: repay $10.00 to the pool from the account's USDC", "1: buy 0.00375 BTC at 76190, reduce-only, at once or not at all"] },
      confirmed_twice: true,
      buy_back: { gateway_placed: 1, btc_at_plan: -0.015, btc_now: -0.01125, bought: true },
      healthy_after_plan: true,
      pass: true,
    },
  );
  const kinds = w.events.map((e) => e.kind);
  assert.deepEqual(kinds.filter((k) => k === "state").length, 4, "HEALTHY > WATCH > MARGIN_CALL > DELEVERAGE > HEALTHY");
  assert.ok(w.events.some((e) => e.what === "step 0 (repay) of plan 500 is done"));
  assert.ok(w.events.some((e) => e.what === "the BTC position went from -0.015 to -0.01125"));
  assert.equal(w.events.filter((e) => e.kind === "keeper").length, 2, "only this account's actions");
  assert.equal(w.keeper([{ t: placedAt, event: "step", msg: "execute_step ran step 0 (repay) of plan 500", account: ACCOUNT }]).length, 0, "each line once");
});

test("the drill fails when WATCH is skipped, or nothing was bought back", () => {
  const w = new DrillWatch(ACCOUNT);
  w.observe({ at: T0, state: state({ v: { state: "MARGIN_CALL", blk: 1 }, received: 2 }), btc: -0.015, ratioBp: 8_000 });
  const plan = { pid: "3", action: "DELEVERAGE", stored_at: "1", steps: [] };
  w.observe({ at: T0 + 1, state: state({ v: { state: "DELEVERAGE", action: "DELEVERAGE", blk: 3 }, received: 4, plan }), btc: -0.015, ratioBp: 7_500 });
  w.observe({ at: T0 + 2, state: state({ v: { state: "HEALTHY", blk: 5 }, received: 6 }), btc: -0.015, ratioBp: 7_500 });
  const checks = w.checks();
  assert.deepEqual([checks.watch_seen, checks.in_order, checks.confirmed_twice, checks.buy_back.bought, checks.healthy_after_plan, checks.pass], [false, false, false, false, true, false]);
});

test("the keeper is watching: a recent real tick that lists the account, and the account seen with its loan", () => {
  const at = (s: number) => new Date(T0 + s * 1000).toISOString();
  const events: LogEvent[] = [
    { t: at(0), event: "start", msg: "the keeper is starting" },
    { t: at(1), event: "tick", msg: "1 client account(s) to look at", accounts: [ACCOUNT] },
    { t: at(2), event: "account", msg: "HEALTHY", account: ACCOUNT, loan: true },
  ];
  assert.equal(keeperSees(events, ACCOUNT, T0 + 30_000).ok, true);
  // A tick is held while a check waits its turn at OutLayer, so the keeper counts as running for 4 minutes after one.
  assert.equal(keeperSees(events, ACCOUNT, T0 + 90_000).ok, true);
  assert.match(keeperSees(events, ACCOUNT, T0 + 300_000).why, /last tick was 299 s ago/);
  assert.match(keeperSees([{ ...events[0]!, msg: "the keeper is starting in a dry run: it sends nothing" }, ...events.slice(1)], ACCOUNT, T0 + 30_000).why, /dry run/);
  assert.match(keeperSees(events.slice(0, 2), ACCOUNT, T0 + 30_000).why, /hasn't seen drill1\.pbf\.testnet with a loan/);
  assert.match(keeperSees(events, "other.pbf.testnet", T0 + 30_000).why, /doesn't list other\.pbf\.testnet/);
  assert.match(keeperSees([], ACCOUNT, T0).why, /no tick yet/);
});

test("the slide from the live bands: each band less 150 bp, so no state is skipped", () => {
  // The small book at BTC $75,800 (the risk side, 8 Nov): WATCH below 0.8406, MARGIN_CALL below 0.7970, DELEVERAGE below 0.7594.
  const bands = nbtcBands({ BTC: { hl100: 103_038_392_164 }, nBTC: { im_bp: 8_406, mr_bp: 7_970, dl_bp: 7_594 } })!;
  assert.deepEqual(slideFromBands(bands), [8_256, 7_820, 7_444]);
  assert.deepEqual(slideFromBands(bands, 200), [8_206, 7_770, 7_394]);
  assert.equal(nbtcBands({ nBTC: { im_bp: 8_406, mr_bp: 7_970 } }), null, "all three, or none");
  assert.equal(nbtcBands(undefined), null);
  assert.throws(() => slideFromBands({ im_bp: 7_000, mr_bp: 7_500, dl_bp: 6_000 }), /don't go down/);
  assert.throws(() => slideFromBands(bands, 9_000), /whole basis points from 0 to 2000/);
});
