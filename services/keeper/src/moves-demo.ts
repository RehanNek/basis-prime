// The moves gate on testnet (FUNDING.md 10, gate 4; INTERFACES.md 36), end to end from the command line, modelled on
// the Aave gate (aave-demo.ts): the same world, the same record and resume.
//
//   pnpm --filter @pb/keeper funding:demo -- --lender aave --moves [--name <label>] [--from <step>] [--fund-wait 20]
//                                            [--dry-run]
//
// What it shows, in order:
//   - a fresh account holds test nBTC only, and signs the permission for Aave with its opening;
//   - test ETH for gas reaches its address on Base Sepolia, and nothing else: no collateral comes from the helper;
//   - the client moves a part of the nBTC to that address through the stand-in. It arrives as wrapped test ETH while
//     Aave's test market has no room for WBTC (the record says which, and why), and a check settles the move;
//   - one `fund` for Aave's part and about $100 from our pool; the keeper posts the collateral and borrows;
//   - the client brings the borrowed USDC home through the stand-in: it is in the account on NEAR and the move is
//     settled. That is the gate's pass point;
//   - then it leaves as a client would: USDC back to Aave's chain, a check to settle it, Aave repaid, our pool repaid,
//     the collateral back from Aave and home as nBTC, and everything withdrawn. The last step says how much test ETH
//     the stand-in's float used.
//
// The backend, the keeper and the stand-in must be running, all three from stage 4. The gate signs with the keeper's
// key only (it owns the gate's account); everything on Aave's chain is signed by the account itself, through Chain
// Signatures. The record goes to research/data/phase6_funding_moves.json, saved after every step. `--dry-run` reads
// what is there and lists what stands in the way, and sends nothing.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { BASE_SEPOLIA_ASSET_PREFIX } from "@pb/oneclick";

import { keeperWatches } from "./aave-kit.js";
import type { AaveGate } from "./aave-steps.js";
import { BASE_SEPOLIA_CHAIN_ID, DEFAULT_LOG_FILE } from "./config.js";
import { aaveSettings } from "./evm.js";
import { DEFAULT_FUND_WAIT_MIN } from "./funding-kit.js";
import { FACTORY, gateGear, gateSettings, http, log, nearBalance, ROOT } from "./gate-world.js";
import { planFor, planForCoin, stepsBefore, stepsPass, StepFailed, StepRunner, type GateCoin, type Plan, type RunRecord, type StepRecord } from "./hedge-kit.js";
import { market, type World } from "./hedge-steps.js";
import { readTail } from "./jsonl.js";
import { describeMovesGate, MOVES_CLOSE_OUT, MOVES_GATE, MOVES_PASS_POINT, MOVES_SETUP, MOVES_STEP_IDS, movesPermission, movesPlan, movesProblems, POOL_PART_MICRO, type BuiltVsLive, type MovesFound } from "./moves-kit.js";
import { MOVES_STEPS } from "./moves-steps.js";
import { pendingTransfers } from "./plan.js";

function fail(message: string, code = 2): never {
  console.error(`funding-demo: ${message}`);
  process.exit(code);
}

// ---------- settings ----------

const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    lender: { type: "string" },
    moves: { type: "boolean", default: false },
    name: { type: "string" },
    from: { type: "string" },
    coin: { type: "string", default: "BTC" },
    "fund-wait": { type: "string", default: String(DEFAULT_FUND_WAIT_MIN) },
    "dry-run": { type: "boolean", default: false },
  },
});
if (values.lender !== "aave" || !values.moves) fail("this is the moves gate: give --lender aave --moves");
const from = values.from;
if (from !== undefined && !MOVES_STEP_IDS.includes(from)) fail(`--from takes one of ${MOVES_STEP_IDS.join(", ")}`);
const dryRun = values["dry-run"];
const fundWaitMin = Number(values["fund-wait"]);
if (!Number.isFinite(fundWaitMin) || fundWaitMin < 2 || fundWaitMin > 30) fail("--fund-wait is minutes the keeper has to run the funding plan, from 2 to 30");

// INTERFACES.md 51.2: --coin ETH runs the same gate from the client's own test ETH: the account holds test ETH, moves
// 0.02 of it to Aave's chain, and brings the collateral home as test ETH. Without it, bitcoin, with the record of before.
if (values.coin !== "BTC" && values.coin !== "ETH") fail("--coin is BTC or ETH");
const coinName: "BTC" | "ETH" = values.coin;
const recordFile = `${ROOT}research/data/phase6_funding_moves${coinName === "ETH" ? "_eth" : ""}.json`;

interface MovesRecord extends RunRecord {
  version: 1;
  account: string;
  owner: string;
  lender: "aave";
  moves: true;
  api_url: string;
  shim_url: string;
  keeper_log: string;
  permission: ReturnType<typeof movesPermission>;
  started_utc: string;
  finished_utc?: string;
  plan: Plan;
  context: Record<string, unknown>;
  steps: StepRecord[];
  pass?: boolean;
  /** FUNDING.md 10's gate 4 itself: every step up to the loan's arrival on NEAR passed. */
  pass_point?: boolean;
  leftovers?: string[];
}

/** A resumed run goes on with the account in the record; a new one gets a name of its own, so the account is fresh. */
function accountName(): string {
  if (values.name) return values.name;
  if (from) {
    if (!existsSync(recordFile)) fail(`--from ${from} needs ${recordFile}`);
    return (JSON.parse(readFileSync(recordFile, "utf8")) as MovesRecord).account.split(".")[0]!;
  }
  const t = new Date().toISOString();
  return `fund-move-${t.slice(5, 7)}${t.slice(8, 10)}${t.slice(11, 13)}${t.slice(14, 16)}`;
}

const name = accountName();
const settings = gateSettings("funding-demo", name, dryRun, fail);
const { account, owner, apiUrl, shimUrl } = settings;
const keeperLog = settings.env("KEEPER_LOG_FILE") ?? DEFAULT_LOG_FILE;
const evmChainId = Number(settings.env("EVM_CHAIN_ID") ?? BASE_SEPOLIA_CHAIN_ID);
// The gate posts no order, so the coin's size decimals play no part here: 4 is ETH's on Hyperliquid.
const gateCoin: GateCoin | undefined = coinName === "ETH" ? { coin: "ETH", szDecimals: 4, token: settings.env("METH_TOKEN_ID") ?? "meth.pbf-ops.testnet", tokenDecimals: 18 } : undefined;
const gear = gateGear(settings, gateCoin);
const { world } = gear;
const POOL = `pool.${FACTORY}`;

function save(record: MovesRecord) {
  writeFileSync(recordFile, `${JSON.stringify(record, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 1)}\n`);
}

/** A read that may fail: null instead of an error, so a dry run can say everything that is missing in one go. */
async function soft<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** The sha256 of a built file, or null when it isn't there. */
function builtHash(file: string): string | null {
  return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null;
}

/** What was built here against what the factory has: its account code and the two programs its config pins. */
async function builtVsLive(config: unknown): Promise<BuiltVsLive[]> {
  const pinned = (part: string) => {
    const key = (config as Record<string, { version_key?: unknown } | undefined> | null)?.[part]?.version_key;
    return typeof key === "string" ? key.toLowerCase() : null;
  };
  const accountCode = await soft(() => world.near.view<string>(FACTORY, "account_code_hash"));
  const files = { account: `${ROOT}contracts/target/near/pb_account/pb_account.wasm`, risk: `${ROOT}risk/target/wasm32-wasip2/release/pb-risk.wasm`, gateway: `${ROOT}risk/target/wasm32-wasip2/release/pb-gateway.wasm` };
  return [
    { what: "account code", file: files.account, built: builtHash(files.account), live: typeof accountCode === "string" ? accountCode.toLowerCase() : null },
    { what: "pinned pb-risk", file: files.risk, built: builtHash(files.risk), live: pinned("risk") },
    { what: "pinned pb-gateway", file: files.gateway, built: builtHash(files.gateway), live: pinned("gateway") },
  ];
}

/** Reads, and nothing else: what the gate needs to find before it sends its first transaction. */
async function look(): Promise<MovesFound> {
  const [accountExists, ownerNear, factory, config, gas, tokens] = await Promise.all([
    soft(() => world.near.exists(account)),
    soft(() => nearBalance(gear.provider, owner)),
    soft(() => world.near.view<unknown>(FACTORY, "get_config")),
    soft(() => world.api.get("/api/config")),
    soft(() => world.api.get("/api/evm/gas")),
    // The stand-in's own list of what it moves (1Click's GET /v0/tokens): its Base Sepolia assets are stage 4's.
    soft(() => http("GET", `${shimUrl}/v0/tokens`, undefined, 15_000)),
  ]);
  const listed = tokens?.status === 200 && Array.isArray(tokens.body) ? (tokens.body as { assetId?: unknown; symbol?: unknown }[]) : null;
  // The keeper can't list an account that doesn't exist yet: before the run, only that it ticks and knows Aave's chain.
  const watched = keeperWatches(readTail(keeperLog).events, account, Date.now());
  const keeper = watched.ok || accountExists || !/doesn't list/.test(watched.why) ? watched : { ok: true, why: `the keeper ticked at ${watched.last_tick_at}; it will list ${account} within a minute of its making` };
  return {
    account,
    accountExists,
    resuming: from !== undefined,
    owner,
    ownerNear,
    factoryAave: factory === null ? undefined : aaveSettings(factory),
    evmChainId,
    backend: config?.status === 200,
    gas: gas?.status === 200 ? (gas.body as NonNullable<MovesFound["gas"]>) : null,
    shimBase: listed ? listed.filter((t) => typeof t.assetId === "string" && t.assetId.startsWith(BASE_SEPOLIA_ASSET_PREFIX)).map((t) => String(t.symbol)) : null,
    keeper,
    code: await builtVsLive(factory),
  };
}

/** What a stopped run left open, in words: the moves under way, and what the account holds or owes on Aave's chain. */
async function leftOpen(w: World): Promise<string[]> {
  const lines: string[] = [];
  const state = await soft(() => w.near.view<{ pending?: unknown }>(account, "get_state"));
  for (const t of pendingTransfers(state?.pending)) {
    lines.push(`${t.id} (${t.kind}, ${t.amount} of ${t.token}) is still under way${t.deadlineMs ? `, until ${new Date(t.deadlineMs).toISOString()}` : ""}: a run that goes on waits for it and doesn't ask for it again`);
  }
  const view = await soft(() => w.api.get(`/api/lender/${account}`));
  const body = view?.status === 200 ? (view.body as { lenders?: { l: string; debt: number }[]; evm?: { address: string; wallet: { symbol: string; amount: string; decimals: number }[]; posted: { symbol: string; amount: string; decimals: number }[] } | null }) : null;
  if (!body?.evm) return [...lines, "what the account holds on Aave's chain couldn't be read: look at GET /api/lender/<account> once the backend answers"];
  const show = (t: { symbol: string; amount: string; decimals: number }) => `${Number(t.amount) / 10 ** t.decimals} ${t.symbol}`;
  const owed = body.lenders?.find((l) => l.l === "aave")?.debt ?? 0;
  if (owed > 0) lines.push(`${account} owes Aave about $${(owed / 1e6).toFixed(2)} (the last verdict's figure): the usdc_out and repay_aave steps send USDC back and repay it`);
  for (const p of body.evm.posted.filter((t) => t.amount !== "0")) lines.push(`${show(p)} is posted at Aave: the aave_withdraw step takes it back once Aave is repaid`);
  for (const t of body.evm.wallet.filter((x) => x.amount !== "0")) lines.push(`${show(t)} is at the account's address ${body.evm.address}: ${t.symbol === "USDC" ? "the loan_home step brings a loan home; a little is left over after repaying Aave" : `the btc_home step brings it home as ${coinName === "ETH" ? "test ETH" : "nBTC"}`}`);
  return lines;
}

// ---------- the run ----------

async function main() {
  const mark = await soft(() => market(world, "BTC"));
  if (!mark) log("couldn't read BTC's price on Hyperliquid testnet: the plan below is sized at $76,000");
  let sized = planFor("small", mark?.mark ?? 76_000);
  if (gateCoin) {
    // The same book in dollars, in test ETH: the coin's price is Hyperliquid's own.
    const coinMark = await soft(() => market(world, gateCoin.coin));
    if (!coinMark) fail(`couldn't read ${gateCoin.coin}'s price on Hyperliquid testnet`);
    gateCoin.szDecimals = coinMark.szDecimals;
    sized = planForCoin("small", mark?.mark ?? 76_000, gateCoin, coinMark.mark);
  }
  const plan = movesPlan(sized);
  for (const line of describeMovesGate({ account, owner, pool: POOL, apiUrl, shimUrl, plan, recordFile, fundWaitMin })) log(line);
  log("");
  const { lines, problems } = movesProblems(await look());
  for (const line of lines) log(`found: ${line}`);
  if (dryRun) {
    for (const p of problems) log(`in the way: ${p}`);
    log(`dry run: nothing sent. ${problems.length ? `${problems.length} thing(s) to put right before a real run.` : "Nothing stands in the way of a real run."} The record would go to ${recordFile}`);
    return;
  }
  if (problems.length) fail(problems.join("; "));

  let record: MovesRecord;
  if (from) {
    if (!existsSync(recordFile)) fail(`--from ${from} needs ${recordFile}`);
    const saved = JSON.parse(readFileSync(recordFile, "utf8")) as MovesRecord;
    if (saved.account !== account) fail(`${recordFile} is for ${saved.account}, not ${account}`);
    const { pass: _p, pass_point: _pp, finished_utc: _f, leftovers: _l, ...rest } = saved;
    record = { ...rest, steps: stepsBefore(saved.steps, MOVES_STEP_IDS, from) };
    log(`resuming at ${from}, with ${record.steps.length} earlier step(s) kept`);
  } else {
    if (existsSync(recordFile)) {
      const kept = recordFile.replace(/\.json$/, `.${Date.now()}.json`);
      renameSync(recordFile, kept);
      log(`the previous record is kept as ${kept}`);
    }
    record = { version: 1, account, owner, lender: "aave", moves: true, api_url: apiUrl, shim_url: shimUrl, keeper_log: keeperLog, permission: movesPermission(), started_utc: new Date().toISOString(), plan, context: {}, steps: [] };
  }
  const runner = new StepRunner<MovesRecord>(record, save, log);
  const gate: AaveGate = {
    runner,
    plan: record.plan,
    world,
    name,
    permission: record.permission,
    keeperLog: () => readTail(keeperLog).events,
    options: {
      // More than the book can carry, so the preview answers with the most it can; the fund step then asks for
      // Aave's part and at most $100 of our pool's.
      askMicro: BigInt(record.plan.caps.borrow_micro),
      poolCapMicro: POOL_PART_MICRO,
      fundWaitMs: fundWaitMin * 60_000,
      // The moves gate tries no settlement: gate 3 showed it.
      settleWaitMs: 0,
      settleEveryMs: 0,
    },
  };
  try {
    for (const id of [...MOVES_SETUP, ...MOVES_GATE, ...MOVES_CLOSE_OUT]) if (!runner.done(id)) await MOVES_STEPS[id]!(gate);
  } catch (error) {
    if (!(error instanceof StepFailed)) throw error;
    log(`stopped at ${error.step.id}: ${error.message}`);
    record.leftovers = await leftOpen(world);
    for (const line of record.leftovers) log(`left open: ${line}`);
    log(`fix what stopped it, then resume: pnpm --filter @pb/keeper funding:demo -- --lender aave --moves${coinName === "ETH" ? " --coin ETH" : ""} --name ${name} --from ${error.step.id}`);
  } finally {
    save(record);
  }
  const upToPass = MOVES_STEP_IDS.slice(0, MOVES_STEP_IDS.indexOf(MOVES_PASS_POINT) + 1);
  record.pass_point = upToPass.every((id) => record.steps.some((s) => s.id === id && s.pass));
  record.pass = stepsPass(record.steps, MOVES_STEP_IDS);
  record.finished_utc = new Date().toISOString();
  save(record);
  const bad = record.steps.filter((s) => !s.pass).map((s) => s.id);
  const used = (record.context.collateral as { symbol?: string } | undefined)?.symbol ?? "collateral";
  const pooled = (record.context.funding as { pool_part?: boolean } | undefined)?.pool_part === true;
  // 14 Nov: a plan whose pool step never ran (no verdict came before the plan ran out) is said as that, not as "no pool part".
  const poolDropped = (record.context.funding as { pool_part_dropped?: string } | undefined)?.pool_part_dropped;
  const eth = (record.context.float as { used_eth?: number | null } | undefined)?.used_eth;
  if (record.pass) {
    log(`GATE 4 PASSED: ${coinName === "ETH" ? "test ETH" : "nBTC"} moved to Aave's chain as ${used}, an Aave loan against it${pooled ? " and a pool loan" : poolDropped ? " (the plan's pool part did not run: no check brought a verdict before the plan ran out)" : " (the engine gave no pool part)"}, the loan home in the account on NEAR, and everything repaid, brought home and withdrawn. The float used ${eth ?? "an unread amount of"} test ETH. Record: ${recordFile}`);
  } else if (record.pass_point) {
    log(`THE GATE'S PASS POINT IS REACHED (the borrowed USDC is in the account on NEAR and its move is settled), but leaving isn't finished${bad.length ? `: ${bad.join(", ")}` : ": not every step ran"}. Record: ${recordFile}`);
  } else {
    log(`NOT PASSED${bad.length ? `: ${bad.join(", ")}` : ": not every step ran"}. Record: ${recordFile}`);
  }
  process.exitCode = record.pass ? 0 : 1;
}

await main();
