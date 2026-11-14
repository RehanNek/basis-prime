// The depeg drill on testnet (INTERFACES.md 5 and 17): sets the nBTC/BTC ratio that pb-risk reads in place of its
// price readings, signed with the operator's key, the drill contract's owner.
//
//   pnpm --filter @pb/keeper drill -- --ratio 0.75
//   pnpm --filter @pb/keeper drill -- --slide 0.82,0.78,0.75 --every 2     walks it down by itself
//   pnpm --filter @pb/keeper drill -- --slide auto --account <name>        the same, from the account's own bands
//   pnpm --filter @pb/keeper drill -- --reset                             back to 1.0
//   pnpm --filter @pb/keeper drill -- --show                              reads the ratio, sends nothing
//   add --dry-run to any of them to see what it would send
//
// With --account <name>, each of them acts on that account's own ratio (INTERFACES.md 21): set_ratio_for, and for
// --reset clear_ratio_for, so the drill shocks only that account. While the drill contract's deployed code has no
// per-account ratios (no get_ratio_for), it falls back to the shared set_ratio, which every account reads, and says so.
//
// The slide's values depend on the book (RISK_ENGINE.md 13.2): on the small demo book at BTC $75,800 the states turn
// below 0.8406, 0.7970 and 0.7594, so §17's example 0.84,0.80,0.75 would skip MARGIN_CALL. `--slide auto` takes the
// account's last verdict's nBTC bands and lands each step --below basis points (default 150) past its band. Each level
// is held --every minutes (default 2), long enough for the keeper to notice and get a verdict.
//
// The operator's key (OPERATOR_PRIVATE_KEY) is loaded from the repo's .env inside the program and never printed.
// Testnet only.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { JsonRpcProvider } from "near-api-js";

import { DEFAULT_BELOW_BP, DrillContract, nbtcBands, PAR_BP, parseMinutes, parseRatio, parseSlide, runSlide, showRatio, slideFromBands, slideSchedule, slideWarnings } from "./drill-kit.js";
import { nearCaller, type TxResult } from "./near-tx.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const say = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} drill: ${line}`);
function fail(message: string): never {
  console.error(`drill: ${message}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    ratio: { type: "string" },
    slide: { type: "string" },
    account: { type: "string" },
    below: { type: "string", default: String(DEFAULT_BELOW_BP) },
    every: { type: "string", default: "2" },
    reset: { type: "boolean", default: false },
    show: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});
const chosen = [values.ratio !== undefined, values.slide !== undefined, values.reset, values.show].filter(Boolean).length;
if (chosen !== 1) fail("give one of --ratio <0.75>, --slide <0.82,0.78,0.75 | auto --account <name>> [--every <minutes>], --reset or --show");
const auto = values.slide === "auto";
if (auto && !values.account) fail("--slide auto takes the bands of --account <name> (<name>.pbf.testnet)");
let fixed: number[] = [];
let every: number;
let below: number;
try {
  fixed = values.reset || values.show ? [PAR_BP] : values.ratio !== undefined ? [parseRatio(values.ratio)] : auto ? [] : parseSlide(values.slide!);
  every = parseMinutes(values.every);
  below = Number(values.below);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const envFile = `${ROOT}.env`;
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = (key: string) => process.env[key]?.trim() || undefined;
if ((env("NEAR_NETWORK") ?? "testnet") !== "testnet") fail("NEAR_NETWORK isn't testnet: the drill exists on testnet only");
const operator = env("OPERATOR_ACCOUNT_ID") ?? "pbf-ops.testnet";
const drillId = env("DRILL_ACCOUNT_ID") ?? "drill.pbf-ops.testnet";
const factory = env("FACTORY_ACCOUNT_ID") ?? "pbf.testnet";
const dryRun = values["dry-run"];
const key = env("OPERATOR_PRIVATE_KEY");
if (!key && !dryRun && !values.show) fail("OPERATOR_PRIVATE_KEY is empty in .env");

const provider = new JsonRpcProvider({ url: env("NEAR_RPC_URL") ?? "https://test.rpc.fastnear.com" });
const view = async <T>(contract: string, method: string, args: Record<string, unknown> = {}) =>
  (await provider.callFunction({ contractId: contract, method, args, blockQuery: { finality: "final" } })) as T;
const drill = new DrillContract(drillId, view, key && !dryRun ? nearCaller(provider, operator, key) : null);

const target = values.account ? (values.account.includes(".") ? values.account : `${values.account}.${factory}`) : null;
const setAtIso = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
const now = await drill.ratio();
say(`${drillId}: the shared nBTC/BTC ratio is ${showRatio(now.bp)}, set ${setAtIso(now.set_at)}`);
const perAccount = target ? await drill.perAccount(target) : false;
if (target) {
  if (perAccount) {
    const own = await drill.ratioFor(target);
    say(`${target} reads ${showRatio(own.bp)}${own.bp === now.bp && own.set_at === now.set_at ? " (the shared ratio: it has none of its own)" : `, its own, set ${setAtIso(own.set_at)}`}`);
  } else {
    say(`the drill contract has no per-account ratios yet (no get_ratio_for): ${target} reads the shared ratio, and setting it moves every account`);
  }
}
if (values.show) process.exit(0);

const owner = await drill.owner();
if (owner !== operator) fail(`${drillId} belongs to ${owner}, not ${operator}: only its owner can set the ratio`);

let points = fixed;
if (auto) {
  const account = target!;
  const state = await view<{ verdict?: { verdict?: { bands?: unknown; state?: string } } | null }>(account, "get_state");
  const bands = nbtcBands(state.verdict?.verdict?.bands);
  if (!bands) fail(`${account}'s last verdict has no nBTC bands (im_bp, mr_bp, dl_bp): ask for a check while the loan is out, or give --slide <ratios>`);
  try {
    points = slideFromBands(bands, below);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  say(`${account}'s bands: IM at ${showRatio(bands.im_bp)}, MR at ${showRatio(bands.mr_bp)}, 0.8 x MR at ${showRatio(bands.dl_bp)}; each step ${below} bp past its band`);
}

const schedule = slideSchedule(points, every, Date.now());
for (const warning of slideWarnings(points)) say(`note: ${warning}`);
const whose = target && perAccount ? `${target}'s own ratio` : target ? "the shared ratio (every account reads it)" : "the shared ratio";
for (const [i, point] of schedule.entries()) {
  const what = values.reset && target && perAccount ? `clear ${target}'s own ratio (back to the shared one)` : `set ${whose} to ${showRatio(point.bp)}`;
  say(`${i === 0 ? "now" : new Date(point.at).toISOString().slice(11, 19)}: ${what}`);
}
if (dryRun) {
  say("dry run: nothing sent");
  process.exit(0);
}
if (schedule.length > 1) say(`the slide takes ${((schedule.length - 1) * every).toFixed(1)} minutes; Ctrl-C stops it (the ratio stays where it is: --reset${target ? ` --account ${values.account}` : ""} puts it back)`);

const io = { now: Date.now, sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)), say };
let sent: TxResult[];
if (values.reset && target) {
  const tx = await drill.clearFor(target);
  say(tx.ok ? (tx.shared ? "set the shared ratio back to 1.0 (the drill has no per-account ratios yet)" : `cleared ${target}'s own ratio`) : `${tx.label} FAILED: ${tx.failure ?? "no reason given"}`);
  sent = [tx];
} else {
  sent = await runSlide(drill, schedule, io, target ?? undefined);
}
for (const tx of sent) if (tx.hash) say(`https://testnet.nearblocks.io/txns/${tx.hash}`);
const after = target ? await drill.ratioFor(target) : await drill.ratio();
say(`${target ? `${target} reads` : "the shared ratio is"} ${showRatio(after.bp)} now`);
process.exitCode = sent.length === schedule.length && sent.every((t) => t.ok) ? 0 : 1;
