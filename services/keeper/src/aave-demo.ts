// The Aave gate on testnet (FUNDING.md 10, gate 3: "Aave"; INTERFACES.md 33), end to end from the command line,
// modelled on the Rhea gate (funding-demo.ts): the same world, the same record and resume.
//
//   pnpm --filter @pb/keeper funding:demo -- --lender aave [--name <label>] [--from <step>] [--fund-wait 20]
//                                            [--settle-wait 70] [--settle-every 120] [--dry-run]
//
// What it shows, in order:
//   - a fresh account signs the permission for both lenders with its opening, and deposits test USDC;
//   - test ETH for gas and the collateral reach its address on Base Sepolia through the backend's gas helper: test
//     WBTC from Aave's faucet when Aave's supply cap has room, wrapped test ETH otherwise;
//   - one `fund`; the keeper approves the collateral, posts it at Aave and borrows there, and borrows from our pool
//     too if the engine gave a pool part (on this small book it may give Aave's alone: the record says which);
//   - the engine's verdict shows the Aave position; a settlement is tried;
//   - the client repays Aave, and our pool if it lent, takes the collateral back, sends it out of the address with evm_withdraw
//     (to the gas wallet's address, so wrapped test ETH isn't lost), and withdraws its USDC.
//
// The backend and the keeper must be running, both from stage 3. The gate signs with the keeper's key only (it owns
// the gate's account); everything on Aave's chain is signed by the account itself, through Chain Signatures.
// The record goes to research/data/phase6_funding_aave.json, saved after every step. `--dry-run` reads what is there
// and lists what stands in the way, and sends nothing.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { AAVE_CLOSE_OUT, AAVE_GATE, AAVE_SETUP, AAVE_STEP_IDS, aavePermission, aavePlan, aaveProblems, depositShort, describeAaveGate, keeperWatches, type AaveFound, type Room } from "./aave-kit.js";
import { AAVE_STEPS, type AaveGate } from "./aave-steps.js";
import { BASE_SEPOLIA_CHAIN_ID, DEFAULT_LOG_FILE } from "./config.js";
import { aaveSettings } from "./evm.js";
import { DEFAULT_FUND_WAIT_MIN } from "./funding-kit.js";
import { FACTORY, gateGear, gateSettings, log, nearBalance, ROOT } from "./gate-world.js";
import { planFor, stepsBefore, stepsPass, StepFailed, StepRunner, type Plan, type RunRecord, type StepRecord } from "./hedge-kit.js";
import { market, type World } from "./hedge-steps.js";
import { readTail } from "./jsonl.js";

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
    from: { type: "string" },
    "fund-wait": { type: "string", default: String(DEFAULT_FUND_WAIT_MIN) },
    "settle-wait": { type: "string", default: "70" },
    "settle-every": { type: "string", default: "120" },
    "dry-run": { type: "boolean", default: false },
  },
});
if (values.lender !== "aave") fail("this is the Aave gate: give --lender aave");
const from = values.from;
if (from !== undefined && !AAVE_STEP_IDS.includes(from)) fail(`--from takes one of ${AAVE_STEP_IDS.join(", ")}`);
const dryRun = values["dry-run"];
const number = (flag: string, text: string, min: number, max: number, what: string) => {
  const n = Number(text);
  if (!Number.isFinite(n) || n < min || n > max) fail(`--${flag} is ${what}, from ${min} to ${max}`);
  return n;
};
const fundWaitMin = number("fund-wait", values["fund-wait"], 2, 30, "minutes the keeper has to run the funding plan");
const settleWaitMin = number("settle-wait", values["settle-wait"], 2, 180, "minutes the settlement step keeps trying");
const settleEverySec = number("settle-every", values["settle-every"], 30, 3_600, "seconds between two tries to settle");

const recordFile = `${ROOT}research/data/phase6_funding_aave.json`;

interface AaveRecord extends RunRecord {
  version: 1;
  account: string;
  owner: string;
  lender: "aave";
  api_url: string;
  keeper_log: string;
  permission: ReturnType<typeof aavePermission>;
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
    return (JSON.parse(readFileSync(recordFile, "utf8")) as AaveRecord).account.split(".")[0]!;
  }
  const t = new Date().toISOString();
  return `fund-aave-${t.slice(5, 7)}${t.slice(8, 10)}${t.slice(11, 13)}${t.slice(14, 16)}`;
}

const name = accountName();
const settings = gateSettings("funding-demo", name, dryRun, fail);
const { account, owner, apiUrl } = settings;
const keeperLog = settings.env("KEEPER_LOG_FILE") ?? DEFAULT_LOG_FILE;
const evmChainId = Number(settings.env("EVM_CHAIN_ID") ?? BASE_SEPOLIA_CHAIN_ID);
const gear = gateGear(settings);
const { world } = gear;
const POOL = `pool.${FACTORY}`;

function save(record: AaveRecord) {
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

/** Reads, and nothing else: what the gate needs to find before it sends its first transaction. */
async function look(): Promise<AaveFound> {
  const [accountExists, ownerNear, factory, config, lenders, gas] = await Promise.all([
    soft(() => world.near.exists(account)),
    soft(() => nearBalance(gear.provider, owner)),
    soft(() => world.near.view<unknown>(FACTORY, "get_config")),
    soft(() => world.api.get("/api/config")),
    soft(() => world.api.get("/api/lenders")),
    soft(() => world.api.get("/api/evm/gas")),
  ]);
  const rows = lenders?.status === 200 ? ((lenders.body as { lenders?: { l: string; network: string; collateral_room?: Room[] }[] }).lenders ?? []) : [];
  const rooms = rows.find((r) => r.l === "aave" && r.network === "testnet")?.collateral_room;
  // The keeper can't list an account that doesn't exist yet: before the run, only that it ticks and is a stage 3 keeper.
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
    rooms: rooms && rooms.length ? rooms : null,
    gas: gas?.status === 200 ? (gas.body as NonNullable<AaveFound["gas"]>) : null,
    keeper,
  };
}

/** What a stopped run left on Aave's chain, in words, from the backend's read of the address and of Aave's books. */
async function leftOnAave(w: World): Promise<string[]> {
  const view = await soft(() => w.api.get(`/api/lender/${account}`));
  const body = view?.status === 200 ? (view.body as { lenders?: { l: string; debt: number }[]; evm?: { address: string; wallet: { symbol: string; amount: string; decimals: number }[]; posted: { symbol: string; amount: string; decimals: number }[] } | null }) : null;
  if (!body?.evm) return ["what the account holds on Aave's chain couldn't be read: look at GET /api/lender/<account> once the backend answers"];
  const show = (t: { symbol: string; amount: string; decimals: number }) => `${Number(t.amount) / 10 ** t.decimals} ${t.symbol}`;
  const lines: string[] = [];
  const owed = body.lenders?.find((l) => l.l === "aave")?.debt ?? 0;
  if (owed > 0) lines.push(`${account} owes Aave about $${(owed / 1e6).toFixed(2)} (the last verdict's figure): the repay_aave step repays it`);
  for (const p of body.evm.posted.filter((t) => t.amount !== "0")) lines.push(`${show(p)} is posted at Aave: the aave_withdraw step takes it back once Aave is repaid`);
  for (const t of body.evm.wallet.filter((x) => x.amount !== "0")) lines.push(`${show(t)} is at the account's address ${body.evm.address}: the evm_out step sends the collateral out`);
  return lines;
}

// ---------- the run ----------

async function main() {
  const mark = await soft(() => market(world, "BTC"));
  if (!mark) log("couldn't read BTC's price on Hyperliquid testnet: the plan below is sized at $76,000");
  const plan = aavePlan(planFor("small", mark?.mark ?? 76_000));
  for (const line of describeAaveGate({ account, owner, pool: POOL, apiUrl, plan, recordFile, fundWaitMin, settleWaitMin, settleEverySec })) log(line);
  log("");
  const { lines, problems } = aaveProblems(await look());
  for (const line of lines) log(`found: ${line}`);
  if (dryRun) {
    for (const p of problems) log(`in the way: ${p}`);
    log(`dry run: nothing sent. ${problems.length ? `${problems.length} thing(s) to put right before a real run.` : "Nothing stands in the way of a real run."} The record would go to ${recordFile}`);
    return;
  }
  if (problems.length) fail(problems.join("; "));

  let record: AaveRecord;
  if (from) {
    if (!existsSync(recordFile)) fail(`--from ${from} needs ${recordFile}`);
    const saved = JSON.parse(readFileSync(recordFile, "utf8")) as AaveRecord;
    if (saved.account !== account) fail(`${recordFile} is for ${saved.account}, not ${account}`);
    const { pass: _p, finished_utc: _f, leftovers: _l, ...rest } = saved;
    record = { ...rest, steps: stepsBefore(saved.steps, AAVE_STEP_IDS, from) };
    if (depositShort(saved.plan, plan)) {
      // A record from before the gate's deposit was raised: the deposit step runs again and adds what is missing.
      log(`the record's plan deposited $${Number(saved.plan.deposit_usdc_micro) / 1e6} of test USDC and the gate now takes $${Number(plan.deposit_usdc_micro) / 1e6}: the deposit step runs again and adds the difference`);
      record.plan = { ...saved.plan, deposit_usdc_micro: plan.deposit_usdc_micro };
      record.steps = record.steps.filter((s) => s.id !== "deposit");
    }
    log(`resuming at ${from}, with ${record.steps.length} earlier step(s) kept`);
  } else {
    if (existsSync(recordFile)) {
      const kept = recordFile.replace(/\.json$/, `.${Date.now()}.json`);
      renameSync(recordFile, kept);
      log(`the previous record is kept as ${kept}`);
    }
    record = { version: 1, account, owner, lender: "aave", api_url: apiUrl, keeper_log: keeperLog, permission: aavePermission(), started_utc: new Date().toISOString(), plan, context: {}, steps: [] };
  }
  const runner = new StepRunner<AaveRecord>(record, save, log);
  const gate: AaveGate = {
    runner,
    plan: record.plan,
    world,
    name,
    permission: record.permission,
    keeperLog: () => readTail(keeperLog).events,
    options: {
      // More than the book can carry, so the preview answers with the most it can: the size's own cap.
      askMicro: BigInt(record.plan.caps.borrow_micro),
      fundWaitMs: fundWaitMin * 60_000,
      settleWaitMs: settleWaitMin * 60_000,
      settleEveryMs: settleEverySec * 1_000,
    },
  };
  try {
    for (const id of [...AAVE_SETUP, ...AAVE_GATE, ...AAVE_CLOSE_OUT]) if (!runner.done(id)) await AAVE_STEPS[id]!(gate);
  } catch (error) {
    if (!(error instanceof StepFailed)) throw error;
    log(`stopped at ${error.step.id}: ${error.message}`);
    record.leftovers = await leftOnAave(world);
    for (const line of record.leftovers) log(`left open: ${line}`);
    log(`fix what stopped it, then resume: pnpm --filter @pb/keeper funding:demo -- --lender aave --name ${name} --from ${error.step.id}`);
  } finally {
    save(record);
  }
  record.pass = stepsPass(record.steps, AAVE_STEP_IDS);
  record.finished_utc = new Date().toISOString();
  save(record);
  const bad = record.steps.filter((s) => !s.pass).map((s) => s.id);
  const used = (record.context.collateral as { symbol?: string } | undefined)?.symbol ?? "collateral";
  const pooled = (record.context.funding as { pool_part?: boolean } | undefined)?.pool_part === true;
  log(record.pass ? `GATE 3 PASSED: an Aave loan against ${used}${pooled ? " and a pool loan" : " (the engine gave no pool part)"}, the position in the engine's verdict, and everything repaid, taken back and withdrawn. Record: ${recordFile}` : `NOT PASSED${bad.length ? `: ${bad.join(", ")}` : ": not every step ran"}. Record: ${recordFile}`);
  process.exitCode = record.pass ? 0 : 1;
}

await main();
