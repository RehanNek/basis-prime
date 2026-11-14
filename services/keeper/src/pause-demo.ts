// The short pause gate on testnet (INTERFACES.md 50.2), end to end from the command line, modelled on the other gates
// (hedge-demo, funding-demo): the same world, the same record and resume.
//
//   pnpm --filter @pb/keeper pause:demo -- [--name <label>] [--from <step>] [--dry-run]
//
// It proves one thing: an account borrows again minutes after its USDC came home from Hyperliquid, because a check
// that sees the transfer in Hyperliquid's own history lifts the pause. In order:
//   create, deposit, hl_init   a fresh account with test USDC and test nBTC, and its Hyperliquid address;
//   to_hl, home                USDC to Hyperliquid and straight back: the transfer home starts the pause;
//   pause_lifted               a check with a borrow intent; the account must then show no pause;
//   borrow_again, repay_again  a loan from our pool on that check's result, and its repayment;
//   withdraw                   both tokens back to the client.
// No hedge, no agent, no order, no lender and no operator call: Hyperliquid's prices and the gateway play no part.
// On an account made before the deploy (its state shows no open_sends) it stops at pause_lifted and doesn't pass.
//
// The steps are hedge-steps.ts's and funding-steps.ts's own; pause-kit.ts has the step list and the plan in words,
// which --dry-run prints together with what it finds and what stands in the way. A dry run sends nothing and needs
// no key: PB_ENV_FILE=none runs it on the documented defaults alone.
//
// It needs the backend (API_URL) and the 1Click stand-in (SHIM_URL) running; the keeper service plays no part. The
// client account is <label>.pbf.testnet, owned by the keeper's account; without --name it is
// pause-<month day hour minute>. The key (KEEPER_PRIVATE_KEY) is loaded from the repo's .env inside the program and
// never printed. Every transaction hash, check result and timing goes to research/data/pause_gate.json after every
// step; --from resumes from it. Testnet only.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import type { SendPause } from "./funding-kit.js";
import type { LiftGate } from "./funding-steps.js";
import { FACTORY, finalHeight, gateGear, gateSettings, http, log, nearBalance, ROOT } from "./gate-world.js";
import { planFor, StepFailed, StepRunner, stepsBefore, stepsPass, type Plan, type RunRecord, type StepRecord } from "./hedge-kit.js";
import { market } from "./hedge-steps.js";
import { describePauseGate, PAUSE_STEP_IDS, PAUSE_STEPS, pauseLeftovers, pausePassWords, pauseProblems, type PauseFound } from "./pause-kit.js";

function fail(message: string, code = 2): never {
  console.error(`pause-demo: ${message}`);
  process.exit(code);
}

// ---------- settings ----------

const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    name: { type: "string" },
    from: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const from = values.from;
if (from !== undefined && !PAUSE_STEP_IDS.includes(from)) fail(`--from takes one of ${PAUSE_STEP_IDS.join(", ")}`);
const dryRun = values["dry-run"];

const recordFile = `${ROOT}research/data/pause_gate.json`;

interface PauseRecord extends RunRecord {
  version: 1;
  gate: "pause";
  account: string;
  owner: string;
  api_url: string;
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
    return (JSON.parse(readFileSync(recordFile, "utf8")) as PauseRecord).account.split(".")[0]!;
  }
  const t = new Date().toISOString();
  return `pause-${t.slice(5, 7)}${t.slice(8, 10)}${t.slice(11, 13)}${t.slice(14, 16)}`;
}

const name = accountName();
const settings = gateSettings("pause-demo", name, dryRun, fail);
const { account, owner, apiUrl, shimUrl } = settings;
const gear = gateGear(settings);
const { world } = gear;

function save(record: PauseRecord) {
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
async function look(plan: Plan): Promise<PauseFound> {
  const [accountExists, ownerNear, factoryPaused, accountCode, factory, config, tokens, float] = await Promise.all([
    soft(() => world.near.exists(account)),
    soft(() => nearBalance(gear.provider, owner)),
    soft(() => world.near.view<boolean>(FACTORY, "is_paused")),
    soft(() => world.near.view<string>(FACTORY, "account_code_hash")),
    soft(() => world.near.view<{ risk?: { version_key?: string } }>(FACTORY, "get_config")),
    soft(() => world.api.get("/api/config")),
    soft(() => http("GET", `${shimUrl}/v0/tokens`, undefined, 15_000)),
    soft(() => world.hl.info<{ withdrawable?: string }>({ type: "clearinghouseState", user: world.ids.hlFloat })),
  ]);
  // An account that exists has its own code and its own pinned engine, whatever the factory gives a new one.
  const [own, ownConfig] = accountExists
    ? await Promise.all([soft(() => world.near.view<{ hl?: SendPause | null }>(account, "get_state")), soft(() => world.near.view<{ risk?: { version_key?: string } }>(account, "get_config"))])
    : [null, null];
  return {
    account,
    accountExists,
    resuming: from !== undefined,
    ...(accountExists ? { ...(own === null ? { hl: null } : own.hl ? { hl: own.hl } : {}), ownRisk: ownConfig?.risk?.version_key ?? null } : {}),
    owner,
    ownerNear,
    factoryPaused,
    accountCode,
    factoryRisk: factory === null ? null : (factory.risk?.version_key ?? ""),
    apiUrl,
    backend: config?.status === 200 ? (config.body as NonNullable<PauseFound["backend"]>) : null,
    shimUrl,
    standIn: tokens === null ? null : tokens.status === 200,
    floatUsdc: float === null ? null : Number(float.withdrawable ?? 0),
    toHlUsd: Number(plan.to_hl_micro) / 1e6,
    // Going on from a step after `to_hl`: the stand-in has delivered that move already.
    ...(from !== undefined && PAUSE_STEP_IDS.indexOf(from) > PAUSE_STEP_IDS.indexOf("to_hl") ? { toHlDone: true } : {}),
  };
}

// ---------- the run ----------

async function main() {
  const mark = await soft(() => market(world, "BTC"));
  if (!mark) log("couldn't read BTC's price on Hyperliquid testnet: the plan below values the nBTC at $76,000. The price plays no part in this gate's steps");
  const plan = planFor("small", mark?.mark ?? 76_000);
  for (const line of describePauseGate({ account, owner, apiUrl, shimUrl, plan, recordFile })) log(line);
  log("");
  const found = await look(plan);
  const { lines, problems } = pauseProblems(found);
  for (const line of lines) log(`found: ${line}`);
  if (dryRun) {
    for (const p of problems) log(`in the way: ${p}`);
    log(`dry run: nothing sent. ${problems.length ? `${problems.length} thing(s) to put right before a real run.` : "Nothing stands in the way of a real run."} The record would go to ${recordFile}`);
    return;
  }
  if (problems.length) fail(problems.join("; "));

  let record: PauseRecord;
  if (from) {
    if (!existsSync(recordFile)) fail(`--from ${from} needs ${recordFile}`);
    const saved = JSON.parse(readFileSync(recordFile, "utf8")) as PauseRecord;
    if (saved.account !== account) fail(`${recordFile} is for ${saved.account}, not ${account}`);
    const { pass: _p, finished_utc: _f, leftovers: _l, ...rest } = saved;
    record = { ...rest, steps: stepsBefore(saved.steps, PAUSE_STEP_IDS, from) };
    log(`resuming at ${from}, with ${record.steps.length} earlier step(s) kept`);
  } else {
    if (existsSync(recordFile)) {
      const kept = recordFile.replace(/\.json$/, `.${Date.now()}.json`);
      renameSync(recordFile, kept);
      log(`the previous record is kept as ${kept}`);
    }
    record = { version: 1, gate: "pause", account, owner, api_url: apiUrl, started_utc: new Date().toISOString(), plan, context: {}, steps: [] };
  }
  const runner = new StepRunner<PauseRecord>(record, save, log);
  // mustLift: this gate's point is the lift, so an account that shows no open_sends fails pause_lifted.
  const gate: LiftGate = { runner, plan: record.plan, world, name, finalBlock: () => finalHeight(gear.provider), mustLift: true };
  try {
    for (const id of PAUSE_STEP_IDS) if (!runner.done(id)) await PAUSE_STEPS[id]!(gate);
  } catch (error) {
    if (!(error instanceof StepFailed)) throw error;
    const why = (error.step.detail as { why?: unknown } | null)?.why;
    log(`stopped at ${error.step.id}: ${typeof why === "string" ? why : error.message}`);
    record.leftovers = await pauseLeftovers(world);
    for (const line of record.leftovers) log(`left open: ${line}`);
    log(`fix what stopped it, then resume: pnpm --filter @pb/keeper pause:demo -- --name ${name} --from ${error.step.id}`);
  }
  record.pass = stepsPass(record.steps, PAUSE_STEP_IDS);
  record.finished_utc = new Date().toISOString();
  save(record);
  const bad = record.steps.filter((s) => !s.pass).map((s) => s.id);
  log(record.pass ? `PAUSE GATE PASSED: ${pausePassWords(record.steps, record.context)}. Record: ${recordFile}` : `NOT PASSED${bad.length ? `: ${bad.join(", ")}` : ": not every step ran"}. Record: ${recordFile}`);
  process.exitCode = record.pass ? 0 : 1;
}

await main();
