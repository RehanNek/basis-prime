// The Phase 6 gate on testnet (FUNDING.md 10, gate 2: "Rhea and pricing"), end to end from the command line, modelled
// on the earlier gates (hedge-demo, drill-demo): the same world, the same record and resume.
//
//   pnpm --filter @pb/keeper funding:demo -- --lender rhea [--name <label>] [--size small|full] [--from <step>]
//                                            [--aim 1.30] [--fund-wait 20] [--settle-wait 70] [--settle-every 120]
//                                            [--top-up-wait 25] [--dry-run]
//
// What it shows, in order:
//   - a fresh account signs the permission, with its opening, and one `fund` (the operator has the pool fill the
//     lender first for that moment, since our Rhea copy charges mainnet's rate, and puts the order back after);
//   - the keeper runs the funding plan, and the account ends with a Rhea loan and a pool loan;
//   - the operator sets a price under which a settlement books a fee, then one under which the next books a subsidy;
//   - bitcoin's price is dropped at our Rhea copy, and the keeper tops Rhea up. The drop is a hold on the keeper's
//     own price sync (rhea-price.ts), which would otherwise put the price straight back;
//   - the client repays everything, closes the hedge and brings the USDC home from Hyperliquid;
//   - a check then lifts the pause that transfer left, and the account borrows from our pool again and repays, minutes
//     after its USDC came home (INTERFACES.md 50.2; an account made before that deploy skips these three steps);
//   - the client withdraws.
//
// The steps are in funding-steps.ts (and hedge-steps.ts for the hedge and the way out); funding-kit.ts has the plan in
// words, which --dry-run prints together with what it finds on testnet and what still stands in the way. A dry run
// sends nothing and needs no key: PB_ENV_FILE=none runs it on the documented defaults alone.
//
// It needs the backend (API_URL), the 1Click stand-in (SHIM_URL) and the keeper running, the keeper with
// RHEA_ACCOUNT_ID and OPERATOR_PRIVATE_KEY set so that it keeps our Rhea copy's BTC price. The client account is
// <label>.pbf.testnet, owned by the keeper's account; without --name it is fund-<lender>-<month day hour minute>.
// The keys (KEEPER_PRIVATE_KEY, OPERATOR_PRIVATE_KEY) are loaded from the repo's .env inside the program and never
// printed. Every transaction hash, verdict, answer and timing goes to research/data/phase6_funding_<lender>.json after
// every step; --from resumes from it. Testnet only.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { DEFAULT_LOG_FILE, DEFAULT_RHEA_HOLD_FILE } from "./config.js";
import { ACT_HF_BP, NOW_HF_BP } from "./cushion.js";
import { DEFAULT_FUND_WAIT_MIN, DEFAULT_TOP_UP_WAIT_MIN, demoPermission, describeGate, DROP_AIM_BP, FUNDING_CLOSE_OUT, FUNDING_GATE, FUNDING_SETUP, FUNDING_STEP_IDS, GATE_LENDERS, gateProblems, keeperReady, passWords, type Found, type GateLender } from "./funding-kit.js";
import { btcOracle, FUNDING_STEPS, restoreOrder, type FundingGate } from "./funding-steps.js";
import { buildFloatTools, FACTORY, finalHeight, gateGear, gatePreflight, gateSettings, log, nearBalance, nearFree, ROOT } from "./gate-world.js";
import { hedgeNow, planFor, planForCoin, stepsBefore, stepsPass, StepFailed, StepRunner, type GateCoin, type Plan, type RunRecord, type Size, type StepRecord } from "./hedge-kit.js";
import { collateralOf, floatCheck, leftovers, market, priceFacts, STEPS } from "./hedge-steps.js";
import { readTail } from "./jsonl.js";
import { clearHold, priceOf, readPriceInfo, setHold } from "./rhea-price.js";

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
    name: { type: "string" },
    size: { type: "string", default: "small" },
    coin: { type: "string", default: "BTC" },
    from: { type: "string" },
    aim: { type: "string", default: (DROP_AIM_BP / 10_000).toFixed(2) },
    "fund-wait": { type: "string", default: String(DEFAULT_FUND_WAIT_MIN) },
    "settle-wait": { type: "string", default: "70" },
    "settle-every": { type: "string", default: "120" },
    "top-up-wait": { type: "string", default: String(DEFAULT_TOP_UP_WAIT_MIN) },
    "dry-run": { type: "boolean", default: false },
  },
});
// (--lender aave is gate 3, aave-demo.ts: funding-gate.ts, which the command runs, sends it there.)
if (!(GATE_LENDERS as readonly string[]).includes(values.lender ?? "")) fail("give --lender rhea or --lender aave");
const lender = values.lender as GateLender;
if (values.size !== "small" && values.size !== "full") fail("--size is small or full");
const size: Size = values.size;
const from = values.from;
if (from !== undefined && !FUNDING_STEP_IDS.includes(from)) fail(`--from takes one of ${FUNDING_STEP_IDS.join(", ")}`);
const dryRun = values["dry-run"];
const number = (flag: string, text: string, min: number, max: number, what: string) => {
  const n = Number(text);
  if (!Number.isFinite(n) || n < min || n > max) fail(`--${flag} is ${what}, from ${min} to ${max}`);
  return n;
};
const aimBp = Math.round(number("aim", values.aim, NOW_HF_BP / 10_000, (ACT_HF_BP - 1) / 10_000, "the cushion the price drop aims for") * 10_000);
const fundWaitMin = number("fund-wait", values["fund-wait"], 2, 30, "minutes the keeper has to run the funding plan");
const settleWaitMin = number("settle-wait", values["settle-wait"], 2, 180, "minutes a settlement step keeps trying");
const settleEverySec = number("settle-every", values["settle-every"], 30, 3_600, "seconds between two tries to settle");
const topUpWaitMin = number("top-up-wait", values["top-up-wait"], 3, 45, "minutes the keeper has to top Rhea up");

// INTERFACES.md 51.1: --coin ETH runs the same gate with test ETH as the collateral and an ETH short. Without it,
// bitcoin, as before, with the record of before.
if (values.coin !== "BTC" && values.coin !== "ETH") fail("--coin is BTC or ETH");
const coinName: "BTC" | "ETH" = values.coin;
const recordFile = `${ROOT}research/data/phase6_funding_${lender}${coinName === "ETH" ? "_eth" : ""}.json`;

interface FundingRecord extends RunRecord {
  version: 1;
  account: string;
  owner: string;
  operator: string;
  lender: GateLender;
  rhea: string;
  size: Size;
  api_url: string;
  keeper_log: string;
  permission: ReturnType<typeof demoPermission>;
  started_utc: string;
  finished_utc?: string;
  plan: Plan;
  context: Record<string, unknown>;
  steps: StepRecord[];
  pass?: boolean;
  leftovers?: string[];
}

/** A resumed run goes on with the account in the record; a new one gets a name of its own, so the account is fresh. */
function accountName(): string {
  if (values.name) return values.name;
  if (from) {
    if (!existsSync(recordFile)) fail(`--from ${from} needs ${recordFile}`);
    return (JSON.parse(readFileSync(recordFile, "utf8")) as FundingRecord).account.split(".")[0]!;
  }
  const t = new Date().toISOString();
  return `fund-${lender}-${t.slice(5, 7)}${t.slice(8, 10)}${t.slice(11, 13)}${t.slice(14, 16)}`;
}

const name = accountName();
const settings = gateSettings("funding-demo", name, dryRun, fail);
const { account, owner, apiUrl, operator } = settings;
const rheaId = settings.env("RHEA_ACCOUNT_ID") ?? "rhea.pbf-ops.testnet";
if (!rheaId.endsWith(".testnet")) fail(`RHEA_ACCOUNT_ID (${rheaId}) isn't on testnet: the gate runs against our own copy only`);
const keeperLog = settings.env("KEEPER_LOG_FILE") ?? DEFAULT_LOG_FILE;
const holdFile = settings.env("RHEA_PRICE_HOLD_FILE") ?? DEFAULT_RHEA_HOLD_FILE;
// The coin's size decimals are Hyperliquid's own, read from its meta in main() before anything is sized or sent.
const gateCoin: GateCoin | undefined = coinName === "ETH" ? { coin: "ETH", szDecimals: 4, token: settings.env("METH_TOKEN_ID") ?? "meth.pbf-ops.testnet", tokenDecimals: 18 } : undefined;
const gear = gateGear(settings, gateCoin);
const { world } = gear;
const POOL = `pool.${FACTORY}`;

function save(record: FundingRecord) {
  writeFileSync(recordFile, `${JSON.stringify(record, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 1)}\n`);
}

// ---------- what is there ----------

/** A read that may fail: null instead of an error, so a dry run can say everything that is missing in one go. */
async function soft<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** Reads, and nothing else: what the gate needs to find before it sends its first transaction. */
async function look(plan: Plan): Promise<Found> {
  const [accountExists, copyExists, ownerNear, factory, params, oracle, config, lenders, float] = await Promise.all([
    soft(() => world.near.exists(account)),
    soft(() => world.near.exists(rheaId)),
    soft(() => nearBalance(gear.provider, owner)),
    soft(() => world.near.view<{ lenders?: Found["factoryLenders"] }>(FACTORY, "get_config")),
    soft(() => world.near.view<NonNullable<Found["poolParams"]>>(POOL, "get_params")),
    soft(() => btcOracle(world)),
    soft(() => world.api.get("/api/config")),
    soft(() => world.api.get("/api/lenders")),
    soft(() => floatCheck(world, plan)),
  ]);
  const setting = copyExists ? await soft(() => world.near.view<unknown>(rheaId, "get_token_pyth_info", { token_id: collateralOf(world) })) : null;
  const info = copyExists ? readPriceInfo(setting, gateCoin ? { coin: "ETH", decimals: gateCoin.tokenDecimals } : undefined) : null;
  const rows = lenders?.status === 200 ? ((lenders.body as { lenders?: { l: string; network: string; rate_bp: number; supply_bp: number; free: string }[] }).lenders ?? []) : [];
  const row = rows.find((r) => r.l === "rhea" && r.network === "testnet");
  // The keeper can't list an account that doesn't exist yet: before the run, only that it ticks and keeps the price.
  const ready = keeperReady(readTail(keeperLog).events, account, Date.now(), coinName);
  const keeper = ready.ok || accountExists || !/doesn't list/.test(ready.why) ? ready : { ok: true, why: `the keeper ticked at ${ready.last_tick_at}; it will list ${account} within a minute of its making` };
  // The hedge, for a run that still has to open it: Hyperliquid's mark against its oracle price and the top of its
  // book, and the band of the account's gateway (for an account not made yet, the gateway the factory pins).
  const opensHedge = from === undefined || FUNDING_STEP_IDS.indexOf(from) <= FUNDING_STEP_IDS.indexOf("short");
  const hedge = opensHedge ? await soft(async () => hedgeNow(await priceFacts(world, coinName), gateCoin?.szDecimals, coinName)) : undefined;
  return {
    account,
    accountExists,
    resuming: from !== undefined,
    owner,
    ownerNear,
    operator,
    hasOperatorKey: Boolean(settings.keys.operator) || dryRun,
    rheaId,
    nbtcId: collateralOf(world),
    factoryLenders: factory === null ? null : (factory.lenders ?? undefined),
    copyExists,
    copyPrice: info === null ? null : typeof info === "string" ? info : priceOf(info),
    oracle,
    rheaTerms: row ? { rate_bp: row.rate_bp, supply_bp: row.supply_bp, free: row.free } : null,
    poolParams: params,
    backend: config?.status === 200 ? (config.body as NonNullable<Found["backend"]>) : null,
    keeper,
    floatProblem: float === null ? "couldn't read the float on Hyperliquid testnet" : from ? null : float.problem,
    ...(hedge !== undefined ? { hedge } : {}),
    // Rhea lends about half the bitcoin's value at a cushion of 1.5.
    expectDebtMicro: BigInt(Math.round(((Number(plan.deposit_nbtc_units) / 10 ** (plan.token_decimals ?? 8)) * plan.btc_px * 1e6) / 2)),
    coin: coinName,
  };
}

// ---------- the run ----------

async function main() {
  const mark = await soft(() => market(world, "BTC"));
  if (!mark && !dryRun) fail("couldn't read BTC's price on Hyperliquid testnet");
  if (!mark) log("couldn't read BTC's price on Hyperliquid testnet: the plan below is sized at $76,000");
  let plan = planFor(size, mark?.mark ?? 76_000);
  if (gateCoin) {
    // The same book in dollars, in the coin: its price and its size decimals are Hyperliquid's own.
    const coinMark = await soft(() => market(world, gateCoin.coin));
    if (!coinMark) fail(`couldn't read ${gateCoin.coin}'s price and size decimals on Hyperliquid testnet`);
    gateCoin.szDecimals = coinMark.szDecimals;
    plan = planForCoin(size, mark?.mark ?? 76_000, gateCoin, coinMark.mark);
  }
  for (const line of describeGate({ account, owner, operator, lender, rheaId, pool: POOL, apiUrl, plan, recordFile, holdFile, aimBp, settleWaitMin, settleEverySec, fundWaitMin })) log(line);
  log("");
  const found = await look(plan);
  const { lines, problems } = gateProblems(found);
  for (const line of lines) log(`found: ${line}`);
  if (dryRun) {
    for (const p of problems) log(`in the way: ${p}`);
    log(`dry run: nothing sent. ${problems.length ? `${problems.length} thing(s) to put right before a real run.` : "Nothing stands in the way of a real run."} The record would go to ${recordFile}`);
    return;
  }
  if (problems.length) fail(problems.join("; "));
  await gatePreflight(world, apiUrl, fail);
  log("building the float tools...");
  buildFloatTools();

  let record: FundingRecord;
  if (from) {
    if (!existsSync(recordFile)) fail(`--from ${from} needs ${recordFile}`);
    const saved = JSON.parse(readFileSync(recordFile, "utf8")) as FundingRecord;
    if (saved.account !== account) fail(`${recordFile} is for ${saved.account}, not ${account}`);
    const { pass: _p, finished_utc: _f, leftovers: _l, ...rest } = saved;
    record = { ...rest, steps: stepsBefore(saved.steps, FUNDING_STEP_IDS, from) };
    // The pool's order is put back whenever a run stops. A run that goes on before the client's fund sets it again.
    if (!record.steps.some((s) => s.id === "fund")) record.steps = record.steps.filter((s) => s.id !== "order");
    log(`resuming at ${from}, with ${record.steps.length} earlier step(s) kept`);
  } else {
    if (existsSync(recordFile)) {
      const kept = recordFile.replace(/\.json$/, `.${Date.now()}.json`);
      renameSync(recordFile, kept);
      log(`the previous record is kept as ${kept}`);
    }
    record = { version: 1, account, owner, operator, lender, rhea: rheaId, size, api_url: apiUrl, keeper_log: keeperLog, permission: demoPermission(lender), started_utc: new Date().toISOString(), plan, context: {}, steps: [] };
  }
  const runner = new StepRunner<FundingRecord>(record, save, log);
  let holding = false;
  const gate: FundingGate = {
    runner,
    plan: record.plan,
    world,
    name,
    permission: record.permission,
    lender,
    rheaId,
    operator: { id: operator, call: gear.operatorCall },
    keeperLog: () => readTail(keeperLog).events,
    hold: {
      set: (hold) => {
        setHold(holdFile, hold, Date.now());
        holding = true;
      },
      clear: () => {
        clearHold(holdFile, `funding:demo for ${account}`);
        holding = false;
      },
    },
    freeNear: () => nearFree(gear.provider, account),
    finalBlock: () => finalHeight(gear.provider),
    options: {
      // More than the book can carry, so the preview answers with the most it can: the size's own cap.
      askMicro: BigInt(record.plan.caps.borrow_micro),
      aimBp,
      fundWaitMs: fundWaitMin * 60_000,
      settleWaitMs: settleWaitMin * 60_000,
      settleEveryMs: settleEverySec * 1_000,
      topUpWaitMs: topUpWaitMin * 60_000,
    },
  };
  try {
    for (const id of FUNDING_SETUP) if (!runner.done(id)) await STEPS[id](gate);
    for (const id of FUNDING_GATE) if (!runner.done(id)) await FUNDING_STEPS[id]!(gate);
    for (const id of FUNDING_CLOSE_OUT) {
      if (runner.done(id)) continue;
      if (id in FUNDING_STEPS) await FUNDING_STEPS[id]!(gate);
      else await STEPS[id as keyof typeof STEPS](gate);
    }
  } catch (error) {
    if (!(error instanceof StepFailed)) throw error;
    log(`stopped at ${error.step.id}: ${error.message}`);
    record.leftovers = await leftovers(world, true);
    for (const line of record.leftovers) log(`left open: ${line}`);
    log(`fix what stopped it, then resume: pnpm --filter @pb/keeper funding:demo -- --lender ${lender} --name ${name} --size ${size}${coinName === "ETH" ? " --coin ETH" : ""} --from ${error.step.id}`);
  } finally {
    // Two things never outlive the run. The price hold: cleared, the keeper brings the copy's price back on its next
    // tick. And the pool's funding order, if the run stopped between setting it and putting it back.
    if (holding) {
      clearHold(holdFile, `funding:demo for ${account}`);
      log(`the price hold is cleared: the keeper brings our Rhea copy's ${coinName} price back to the oracle's`);
    }
    const sent: { hash: string | null; ok: boolean }[] = [];
    const back = await restoreOrder(gate, { tx: (t) => sent.push(t), gateway: () => {} }).catch((error: unknown) => ({ restored: false, funding: null, error: error instanceof Error ? error.message : String(error) }));
    if (back.restored) log(`the pool's funding order is back as it was (tx ${sent.at(-1)?.hash ?? "none"})`);
    if ("error" in back) log(`THE POOL'S FUNDING ORDER COULD NOT BE PUT BACK: ${back.error}. Its value before the run is in the record under context.funding_order.before: set it with the operator's set_funding`);
    save(record);
  }
  record.pass = stepsPass(record.steps, FUNDING_STEP_IDS);
  record.finished_utc = new Date().toISOString();
  save(record);
  const bad = record.steps.filter((s) => !s.pass).map((s) => s.id);
  log(record.pass ? `GATE 2 PASSED: ${passWords(record.steps)}. Record: ${recordFile}` : `NOT PASSED${bad.length ? `: ${bad.join(", ")}` : ": not every step ran"}. Record: ${recordFile}`);
  process.exitCode = record.pass ? 0 : 1;
}

await main();
