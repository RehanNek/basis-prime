// The Phase 4 gate on testnet (PLAN.md 11.5; INTERFACES.md 17): the depeg drill, with nobody touching anything after
// the shock. Modelled on hedge-demo's record and resume.
//
//   pnpm --filter @pb/keeper drill:demo -- --name <label> [--slide auto | 0.82,0.78,0.75] [--below 150] [--every 2]
//                                           [--max-hold 6] [--timeout 40] [--from <step>] [--dry-run]
//
//   1. the demo book (PLAN.md 2, the small one), with hedge-demo's own steps: create, deposit, hl_init, to_hl, agent,
//      approve, short, borrow, take_out. The account is <label>.pbf.testnet, owned by the keeper account.
//   2. keeper: the keeper (pnpm --filter @pb/keeper start, run separately) is running for real and watches the account.
//   3. drill: the slide, with the operator's key, on the account's own ratio (set_ratio_for, INTERFACES.md 21; the shared
//      set_ratio while the drill's deployed code has no per-account ratios); then it only watches. It records every verdict and change of state,
//      every stored plan and each step's `done`, pending transfers, the BTC position, and the keeper's log lines for
//      the account (its checks, the gateway's placements, the steps it ran), until the account is HEALTHY after a
//      DELEVERAGE plan, or the timeout. It never acts for the keeper.
//      The slide (`--slide auto`, the default) comes from a fresh preview's nBTC bands: each band less --below bp, so
//      the account goes WATCH, MARGIN_CALL, DELEVERAGE in turn (§17's 0.84,0.80,0.75 would skip MARGIN_CALL on the
//      small book at BTC $75.8k). Each level is held at least --every minutes, and until its state shows (at most
//      --max-hold minutes), so the keeper has time to notice and get a verdict.
//   4. reset: the account's own ratio cleared, or the shared one back to 1.0 on the old code (also done if the run stops
//      after the slide started).
//   5. the close-out, with hedge-demo's steps: repay, close_short, home, withdraw.
//
// It needs the backend (API_URL, default http://localhost:8788), the 1Click stand-in (SHIM_URL) and the keeper running.
// The keys (KEEPER_PRIVATE_KEY, OPERATOR_PRIVATE_KEY) are loaded from the repo's .env inside the program and never
// printed. The record goes to research/data/phase4_drill_small.json after every step; --from resumes from it.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { DEFAULT_LOG_FILE } from "./config.js";
import { DEFAULT_BELOW_BP, DrillContract, nbtcBands, PAR_BP, parseMinutes, parseSlide, showRatio, SLIDE_STATES, slideFromBands, slideWarnings, type NbtcBands } from "./drill-kit.js";
import { DrillWatch, keeperSees } from "./drill-watch.js";
import { buildFloatTools, gateGear, gatePreflight, gateSettings, log, nearBalance, ROOT } from "./gate-world.js";
import { hedgeNow, planFor, positionSize, stepsBefore, stepsPass, StepFailed, StepRunner, type Plan, type RunRecord, type StepRecord } from "./hedge-kit.js";
import { floatCheck, leftovers, market, priceFacts, STEPS, until, type Gate } from "./hedge-steps.js";
import { readTail } from "./jsonl.js";
import type { AccountState } from "./state.js";

const SETUP = ["create", "deposit", "hl_init", "to_hl", "agent", "approve", "short", "borrow", "take_out"] as const;
const CLOSE_OUT = ["repay", "close_short", "home", "withdraw"] as const;
export const DRILL_STEP_IDS = [...SETUP, "keeper", "drill", "reset", ...CLOSE_OUT] as const;

function fail(message: string, code = 2): never {
  console.error(`drill-demo: ${message}`);
  process.exit(code);
}

// ---------- settings ----------

const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    name: { type: "string" },
    slide: { type: "string", default: "auto" },
    below: { type: "string", default: String(DEFAULT_BELOW_BP) },
    every: { type: "string", default: "2" },
    "max-hold": { type: "string", default: "6" },
    timeout: { type: "string", default: "40" },
    from: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const name = values.name ?? fail("give --name <label>: the client account is <label>.pbf.testnet");
const from = values.from;
if (from !== undefined && !(DRILL_STEP_IDS as readonly string[]).includes(from)) fail(`--from takes one of ${DRILL_STEP_IDS.join(", ")}`);
const autoSlide = values.slide === "auto";
let fixedPoints: number[] = [];
let every: number;
let maxHold: number;
let below: number;
let timeoutMin: number;
try {
  if (!autoSlide) fixedPoints = parseSlide(values.slide);
  every = parseMinutes(values.every);
  maxHold = parseMinutes(values["max-hold"]);
  if (maxHold < every) throw new Error("--max-hold must be at least --every");
  below = Number(values.below);
  if (!Number.isInteger(below) || below < 0 || below > 2_000) throw new Error("--below is whole basis points from 0 to 2000");
  timeoutMin = Number(values.timeout);
  if (!Number.isFinite(timeoutMin) || timeoutMin < 5 || timeoutMin > 180) throw new Error("--timeout is a number of minutes from 5 to 180");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const dryRun = values["dry-run"];

const settings = gateSettings("drill-demo", name, dryRun, fail);
if (!settings.keys.operator && !dryRun) fail("OPERATOR_PRIVATE_KEY is empty in .env: the operator owns the drill contract and sets its ratio");
const { account, owner, apiUrl, hlFloat } = settings;
const keeperLog = settings.env("KEEPER_LOG_FILE") ?? DEFAULT_LOG_FILE;
const recordFile = `${ROOT}research/data/phase4_drill_small.json`;
const gear = gateGear(settings);
const { world } = gear;
const drill = new DrillContract(settings.drillId, world.near.view, gear.operatorCall);

interface DrillRecord extends RunRecord {
  version: 1;
  account: string;
  owner: string;
  size: "small";
  api_url: string;
  keeper_log: string;
  slide: { mode: "auto" | "fixed"; points_bp: number[]; below_bp: number; every_minutes: number; max_hold_minutes: number; timeout_minutes: number };
  started_utc: string;
  finished_utc?: string;
  plan: Plan;
  context: Record<string, unknown>;
  steps: StepRecord[];
  pass?: boolean;
  leftovers?: string[];
}

function save(record: DrillRecord) {
  writeFileSync(recordFile, `${JSON.stringify(record, null, 1)}\n`);
}

const state = () => world.near.view<AccountState>(account, "get_state");

/** The account's BTC position on Hyperliquid (negative: a short), read straight from Hyperliquid's info API. */
async function btcPosition(st: AccountState | null): Promise<number | null> {
  const address = st?.hl?.address;
  if (!address) return null;
  try {
    return positionSize(await world.hl.info<unknown>({ type: "clearinghouseState", user: address }), "BTC");
  } catch {
    return null;
  }
}

// ---------- the Phase 4 steps ----------

async function stepKeeper(runner: StepRunner<DrillRecord>) {
  await runner.run("keeper", "the keeper is running and watches the account with its loan", {}, async () => {
    const st = await state();
    if (!("plan" in st)) throw new Error(`${account}'s get_state has no "plan": its code is from before Phase 4, so it can't store or run a plan. Use a new --name once the factory makes Phase 4 accounts`);
    const seen = await until(world, "the keeper to watch the account", 300_000, 5_000, async () => keeperSees(readTail(keeperLog).events, account, world.now()), (r) => r.ok).catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}. ${keeperSees(readTail(keeperLog).events, account, world.now()).why}. The keeper's log: ${keeperLog}`);
    });
    return { ok: true, detail: { ...seen, keeper_log: keeperLog, verdict: st.verdict?.verdict ?? null } };
  });
}

let slideStarted = false;

/** The slide: fixed from --slide, or from the bands of a fresh preview (the held verdict's if the preview fails). */
async function slidePoints(): Promise<{ points: number[]; source: string; bands: NbtcBands | null }> {
  if (!autoSlide) return { points: fixedPoints, source: "--slide", bands: null };
  const { status, body } = await world.api.post("/api/preview", { account, intent: { check: {} } }).catch(() => ({ status: 0, body: null }));
  const preview = status === 200 ? nbtcBands((body as { verdict?: { bands?: unknown } } | null)?.verdict?.bands) : null;
  const held = preview ? null : nbtcBands((await state()).verdict?.verdict?.bands);
  const bands = preview ?? held;
  if (!bands) throw new Error("neither a preview nor the held verdict has nBTC bands (im_bp, mr_bp, dl_bp): is the loan out? Or give --slide 0.82,0.78,0.75");
  return { points: slideFromBands(bands, below), source: preview ? "a preview's bands" : "the held verdict's bands", bands };
}

async function stepDrill(runner: StepRunner<DrillRecord>) {
  await runner.run("drill", "the slide, then watch the keeper act until the account is HEALTHY again", { observe: true }, async (step) => {
    const { points, source, bands } = await slidePoints();
    runner.record.slide.points_bp = points;
    log(`  the slide from ${source}: ${points.map(showRatio).join(", ")}${bands ? ` (bands ${showRatio(bands.im_bp)}, ${showRatio(bands.mr_bp)}, ${showRatio(bands.dl_bp)}, less ${below} bp)` : ""}`);
    for (const warning of slideWarnings(points)) log(`  note: ${warning}`);
    // With three steps each one should show its state (WATCH, MARGIN_CALL, DELEVERAGE) before the next goes.
    const gated = points.length === SLIDE_STATES.length;
    const watch = new DrillWatch(account);
    const start = world.now();
    const deadline = start + timeoutMin * 60_000;
    const since = new Date(start - 60_000).toISOString();
    const ratioTxs: { bp: number; hash: string | null; ok: boolean; at: string; waited_for: string | null; shared: boolean }[] = [];
    let next = 0;
    let lastSetAt = 0;
    let lastSave = 0;
    const first = await state();
    watch.observe({ at: world.now(), state: first, btc: await btcPosition(first), ratioBp: (await drill.ratioFor(account)).bp });
    runner.record.context.drill_watch = { points, source, bands, events: watch.events };
    const reached = (i: number) => watch.verdicts.some((v) => v.state === SLIDE_STATES[i] && Date.parse(v.at) >= lastSetAt);
    for (;;) {
      const now = world.now();
      const held = now - lastSetAt;
      const due = next === 0 || (held >= every * 60_000 && (!gated || reached(next - 1) || held >= maxHold * 60_000));
      if (next < points.length && due && !watch.done()) {
        const waitedFor = next === 0 ? null : gated && !reached(next - 1) ? `${SLIDE_STATES[next - 1]} didn't show within ${maxHold} min` : gated ? `${SLIDE_STATES[next - 1]} showed` : null;
        slideStarted = true;
        const tx = await drill.setFor(account, points[next]!);
        step.tx(tx);
        lastSetAt = world.now();
        ratioTxs.push({ bp: points[next]!, hash: tx.hash, ok: tx.ok, at: new Date(lastSetAt).toISOString(), waited_for: waitedFor, shared: tx.shared });
        const whose = tx.shared ? "the shared ratio (the drill has no per-account ratios yet, so every account sees it)" : `${account}'s own ratio`;
        log(`  ${watch.note(lastSetAt, `the drill set ${whose} to ${showRatio(points[next]!)} (step ${next + 1} of ${points.length}${waitedFor ? `; ${waitedFor}` : ""})`, { tx: tx.hash, ok: tx.ok }).what}${tx.ok ? "" : `: FAILED ${tx.failure ?? ""}`}`);
        if (!tx.ok) throw new Error(`${tx.label} failed: ${tx.failure ?? "no reason given"} (tx ${tx.hash})`);
        next++;
      }
      const st = await state().catch(() => null);
      const [btc, ratio] = await Promise.all([btcPosition(st), drill.ratioFor(account).then((r) => r.bp, () => null)]);
      for (const e of watch.observe({ at: world.now(), state: st, btc, ratioBp: ratio })) log(`  ${e.what}`);
      for (const e of watch.keeper(readTail(keeperLog).events.filter((l) => l.t >= since))) log(`  keeper ${e.what}`);
      if (watch.done()) break;
      if (world.now() >= deadline) {
        log(`  the timeout of ${timeoutMin} minutes has passed`);
        break;
      }
      if (world.now() - lastSave >= 30_000) {
        lastSave = world.now();
        runner.record.context.drill_watch = { points, source, bands, events: watch.events, checks: watch.checks() };
        save(runner.record);
      }
      await world.sleep(5_000);
    }
    const checks = watch.checks();
    runner.record.context.drill_watch = { points, source, bands, events: watch.events, checks };
    return {
      ok: checks.pass,
      detail: {
        slide: { source, bands, below_bp: below, points_bp: points },
        ratio_txs: ratioTxs,
        checks,
        verdicts: watch.verdicts,
        plans: watch.plans,
        gateway_placements: watch.placements,
        step_runs: watch.stepRuns,
        keeper_checks: watch.checksAsked,
        seconds_to_healthy: watch.done() ? Math.round((world.now() - start) / 1000) : null,
      },
    };
  });
}

async function stepReset(runner: StepRunner<DrillRecord>) {
  await runner.run("reset", "clear the account's own nBTC/BTC ratio (or set the shared one back to 1.0 on the drill's old code)", {}, async (step) => {
    const tx = await drill.clearFor(account);
    step.tx(tx);
    const ratio = await drill.ratioFor(account);
    if (ratio.bp === PAR_BP) slideStarted = false;
    return { ok: tx.ok && ratio.bp === PAR_BP, detail: { ratio, shared: tx.shared } };
  });
}

// ---------- the run ----------

async function main() {
  const { mark } = await market(world, "BTC");
  const plan = planFor("small", mark);
  log(`account ${account}, owned by ${owner}; backend ${apiUrl}; the small demo book at BTC ${mark}: ${Number(plan.deposit_nbtc_units) / 1e8} mNBTC, ${Number(plan.deposit_usdc_micro) / 1e6} mUSDC, ${Number(plan.to_hl_micro) / 1e6} USDC to Hyperliquid, a ${plan.short_sz} BTC short, the loan taken out`);
  log(
    autoSlide
      ? `the slide: from a preview's nBTC bands once the loan is out, each step ${below} bp past its band (at BTC $75.8k about 0.8256, 0.7820, 0.7444)`
      : `the slide: ${fixedPoints.map(showRatio).join(", ")}`,
  );
  log(`each level held at least ${every} min, and until its state shows (at most ${maxHold} min); the watch ends when the account is HEALTHY after a DELEVERAGE plan, or after ${timeoutMin} minutes`);
  if (!autoSlide) for (const warning of slideWarnings(fixedPoints)) log(`note: ${warning}`);
  if (autoSlide && (await world.near.exists(account))) {
    const held = nbtcBands((await state().catch(() => null))?.verdict?.verdict?.bands);
    log(held ? `${account}'s held verdict's bands now give ${slideFromBands(held, below).map(showRatio).join(", ")}` : `${account}'s held verdict has no nBTC bands yet`);
  }
  const float = await floatCheck(world, plan);
  log(`the float (${hlFloat}): ${float.withdrawable.toFixed(2)} USDC in perps; this run needs about ${float.need_usdc} USDC`);
  // Whether the hedge can go through the gateway now (INTERFACES.md 42). The short step stops in the same words if not.
  const hedge = await priceFacts(world, "BTC").then(hedgeNow, (error: unknown) => ({ ok: false, why: `couldn't work out whether the hedge can go through the gateway now (${error instanceof Error ? error.message : String(error)})` }));
  log(hedge.ok ? hedge.why : `note: ${hedge.why}`);
  const exists = await world.near.exists(account);
  const balance = await nearBalance(gear.provider, owner);
  const needNear = exists ? 0.5 : 5.5;
  log(`${owner} holds ${balance.toFixed(4)} NEAR; ${exists ? `${account} exists` : `creating ${account} takes 6 NEAR`}, and the keeper's checks about 0.01 NEAR each`);
  const ratioNow = await drill.ratioFor(account);
  const drillOwner = await drill.owner();
  const perAccount = await drill.perAccount(account);
  log(`${settings.drillId}: ${account} reads ${showRatio(ratioNow.bp)}, owned by ${drillOwner}; ${perAccount ? "the slide sets the account's own ratio (set_ratio_for)" : "no per-account ratios yet, so the slide sets the shared ratio, which every account reads"}`);
  const keeperNow = keeperSees(readTail(keeperLog).events, account, Date.now());
  log(`the keeper: ${keeperNow.why} (log ${keeperLog})`);
  const problems = [
    float.problem && !from ? float.problem : null,
    balance < needNear ? `${owner} holds ${balance.toFixed(2)} NEAR, under the ${needNear} this run needs: top it up from the testnet faucet` : null,
    drillOwner !== settings.operator ? `${settings.drillId} belongs to ${drillOwner}, not ${settings.operator}` : null,
  ].filter((p): p is string => Boolean(p));
  if (dryRun) {
    for (const p of problems) log(`problem: ${p}`);
    log(`dry run: nothing sent. The record would go to ${recordFile}`);
    return;
  }
  if (problems.length) fail(problems.join("; "));
  await gatePreflight(world, apiUrl, fail);
  log("building the float tools...");
  buildFloatTools();

  let record: DrillRecord;
  if (from) {
    if (!existsSync(recordFile)) fail(`--from ${from} needs ${recordFile}`);
    const saved = JSON.parse(readFileSync(recordFile, "utf8")) as DrillRecord;
    if (saved.account !== account) fail(`${recordFile} is for ${saved.account}, not ${account}`);
    const { pass: _p, finished_utc: _f, leftovers: _l, ...rest } = saved;
    record = { ...rest, steps: stepsBefore(saved.steps, DRILL_STEP_IDS, from) };
    log(`resuming at ${from}, with ${record.steps.length} earlier step(s) kept`);
  } else {
    if (existsSync(recordFile)) {
      const kept = recordFile.replace(/\.json$/, `.${Date.now()}.json`);
      renameSync(recordFile, kept);
      log(`the previous record is kept as ${kept}`);
    }
    record = {
      version: 1,
      account,
      owner,
      size: "small",
      api_url: apiUrl,
      keeper_log: keeperLog,
      slide: { mode: autoSlide ? "auto" : "fixed", points_bp: fixedPoints, below_bp: below, every_minutes: every, max_hold_minutes: maxHold, timeout_minutes: timeoutMin },
      started_utc: new Date().toISOString(),
      plan,
      context: {},
      steps: [],
    };
  }
  const runner = new StepRunner<DrillRecord>(record, save, log);
  const gate: Gate = { runner, plan: record.plan, world, name };
  try {
    for (const id of SETUP) if (!runner.done(id)) await STEPS[id](gate);
    if (!runner.done("keeper")) await stepKeeper(runner);
    if (!runner.done("drill")) await stepDrill(runner);
    if (!runner.done("reset")) await stepReset(runner);
    for (const id of CLOSE_OUT) if (!runner.done(id)) await STEPS[id](gate);
  } catch (error) {
    if (!(error instanceof StepFailed)) throw error;
    log(`stopped at ${error.step.id}: ${error.message}`);
    if (slideStarted) {
      const tx = await drill.clearFor(account).catch(() => null);
      log(tx?.ok ? "the ratio is back at 1.0" : `the ratio could not be reset: pnpm --filter @pb/keeper drill -- --reset --account ${name}`);
    }
    record.leftovers = await leftovers(world, true);
    for (const line of record.leftovers) log(`left open: ${line}`);
    log(`fix what stopped it, then resume: pnpm --filter @pb/keeper drill:demo -- --name ${name} --from ${error.step.id}`);
  }
  record.pass = stepsPass(record.steps, DRILL_STEP_IDS);
  record.finished_utc = new Date().toISOString();
  save(record);
  const bad = record.steps.filter((s) => !s.pass).map((s) => s.id);
  log(record.pass ? `THE DRILL PASSED. Record: ${recordFile}` : `NOT PASSED${bad.length ? `: ${bad.join(", ")}` : ": not every step ran"}. Record: ${recordFile}`);
  process.exitCode = record.pass ? 0 : 1;
}

await main();
