// The Phase 3 gate on testnet (PLAN.md 11.4), end to end from the command line, modelled on scripts/first-loan.py.
//
//   pnpm --filter @pb/keeper hedge:demo -- --name <label> [--size small|full] [--from <step>] [--until <step>] [--dry-run]
//
// --until <step> stops after that step: `--until take_out` leaves the demo book with the loan taken out, as the
// Phase 4 drill starts from (drill-demo.ts runs the same steps itself).
//
// It needs the backend (API_URL, default http://localhost:8788) and the 1Click stand-in (SHIM_URL, 8787) running.
// The keeper (KEEPER_ACCOUNT_ID, KEEPER_PRIVATE_KEY from the repo's .env, loaded here and never printed) owns the
// client account <label>.pbf.testnet: it signs the NEAR transactions, and the NEP-413 order messages for pb-gateway.
// The float tools (services/oneclick-shim) post the other side of each trade on testnet's thin book.
//
// The steps are in hedge-steps.ts, and the world they run in (gate-world.ts) is shared with the Phase 4 scripts.
// Every transaction hash, gateway answer, call_id, attestation URL and timing goes to
// research/data/phase3_hedge_<size>.json, which is also the state `--from <step>` resumes from. The run passes when
// every step's ok equals !expect_fail, and each refusal came with the code it should have. Testnet only.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { buildFloatTools, gateGear, gatePreflight, gateSettings, log, ROOT } from "./gate-world.js";
import { hedgeNow, isStepId, planFor, resumeAt, runPasses, runPassesUntil, STEP_IDS, StepFailed, StepRunner, type HedgeRecord, type Plan, type Size, type StepId } from "./hedge-kit.js";
import { floatCheck, leftovers, market, priceFacts, STEPS, type Gate } from "./hedge-steps.js";

function fail(message: string, code = 2): never {
  console.error(`hedge-demo: ${message}`);
  process.exit(code);
}

// ---------- settings ----------

const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    name: { type: "string" },
    size: { type: "string", default: "small" },
    from: { type: "string" },
    until: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const name = values.name ?? fail("give --name <label>: the client account is <label>.pbf.testnet");
if (values.size !== "small" && values.size !== "full") fail("--size is small or full");
const size: Size = values.size;
if (values.from !== undefined && !isStepId(values.from)) fail(`--from takes one of ${STEP_IDS.join(", ")}`);
const from = values.from as StepId | undefined;
if (values.until !== undefined && !isStepId(values.until)) fail(`--until takes one of ${STEP_IDS.join(", ")}`);
const until = values.until as StepId | undefined;
if (from && until && STEP_IDS.indexOf(until) < STEP_IDS.indexOf(from)) fail(`--until ${until} comes before --from ${from}`);
const dryRun = values["dry-run"];

const settings = gateSettings("hedge-demo", name, dryRun, fail);
const { account, owner, apiUrl, hlApi, hlFloat } = settings;
const recordFile = `${ROOT}research/data/phase3_hedge_${size}.json`;
const { world } = gateGear(settings);

// ---------- the run ----------

function save(record: HedgeRecord) {
  writeFileSync(recordFile, `${JSON.stringify(record, null, 1)}\n`);
}

function describe(plan: Plan) {
  const usd = (sz: string) => `$${(Number(sz) * plan.btc_px).toFixed(2)}`;
  return [
    `account ${account}, owned by ${owner}; backend ${apiUrl}; Hyperliquid ${new URL(hlApi).host}; size ${plan.size}, BTC at ${plan.btc_px}`,
    `1 create        create_account with 6 NEAR (skipped if ${account} exists and the keeper owns it)`,
    `2 deposit       mint and deposit ${Number(plan.deposit_usdc_micro) / 1e6} mUSDC and ${Number(plan.deposit_nbtc_units) / 1e8} mNBTC (${usd(String(Number(plan.deposit_nbtc_units) / 1e8))})`,
    "3 hl_init       derive the Hyperliquid address; record the MPC signer's gas",
    `4 to_hl         move ${Number(plan.to_hl_micro) / 1e6} USDC to Hyperliquid through the stand-in`,
    "5 agent         request_agent (0.01 NEAR)",
    "6 approve       hl_approve_agent, /api/hl/submit, until extraAgents lists the agent",
    `7 short         the float bids ${plan.short_sz} BTC 0.3% under the mark, inside the band of the account's gateway; IOC sells through /api/order (${usd(plan.short_sz)})`,
    "8 borrow        a preview, a borrow check for the line less 0.5%, then borrow",
    "  take_out      a withdrawal check, then the loan's mUSDC goes to the keeper (the client takes the loan out)",
    "9 refuse_close  closing the whole short, with the loan out: must be refused (P5-P9)",
    `  burst         ${plan.burst.count} sells of ${plan.burst.sz} BTC (${usd(plan.burst.sz)} each) at once; the account must stay within the checks`,
    "  refuse_coin   an order for TAO, outside the allow-list: must be refused with P1",
    "10 repay (the keeper puts the loan back first), close_short (against a float ask), home (hl_withdraw, submit, delivered), withdraw both tokens",
    `caps: to Hyperliquid ${Number(plan.caps.to_hl_micro) / 1e6} USDC, short $${plan.caps.short_usd}, borrow ${Number(plan.caps.borrow_micro) / 1e6} USDC, the float's side $${plan.caps.float_order_usd}, nBTC $${plan.caps.nbtc_usd}`,
  ];
}

async function main() {
  const { mark } = await market(world, "BTC");
  const plan = planFor(size, mark);
  for (const line of describe(plan)) log(line);
  const float = await floatCheck(world, plan);
  log(`the float (${hlFloat}): ${float.withdrawable.toFixed(2)} USDC in perps, can trade ${float.max_sz} BTC now (${JSON.stringify(float.leverage)}), about ${float.room_after_move} BTC after the move; this run needs about ${float.need_usdc} USDC and a ${float.side_btc} BTC side`);
  const floatProblem = float.problem;
  // Whether the hedge can go through the gateway now, opened and closed again (INTERFACES.md 42): its orders must
  // sit inside the band of the gateway the account pins and meet Hyperliquid's real book.
  const hedge = await priceFacts(world, "BTC").then(hedgeNow, (error: unknown) => ({ ok: false, why: `couldn't work out whether the hedge can go through the gateway now (${error instanceof Error ? error.message : String(error)})` }));
  log(hedge.why);
  if (dryRun) {
    if (floatProblem) log(floatProblem);
    log(`dry run: nothing sent. ${(await world.near.exists(account)) ? `${account} exists.` : `${account} doesn't exist yet.`} The record would go to ${recordFile}`);
    return;
  }
  if (floatProblem && !from) fail(floatProblem);
  if (!hedge.ok && !from) fail(hedge.why);
  await gatePreflight(world, apiUrl, fail);
  log("building the float tools...");
  buildFloatTools();

  let record: HedgeRecord;
  if (from) {
    if (!existsSync(recordFile)) fail(`--from ${from} needs ${recordFile}`);
    const saved = JSON.parse(readFileSync(recordFile, "utf8")) as HedgeRecord;
    if (saved.account !== account) fail(`${recordFile} is for ${saved.account}, not ${account}`);
    record = resumeAt(saved, from);
    log(`resuming at ${from}, with ${record.steps.length} earlier step(s) kept`);
  } else {
    if (existsSync(recordFile)) {
      const kept = recordFile.replace(/\.json$/, `.${Date.now()}.json`);
      renameSync(recordFile, kept);
      log(`the previous record is kept as ${kept}`);
    }
    record = { version: 1, account, owner, size, api_url: apiUrl, started_utc: new Date().toISOString(), plan, context: {}, steps: [] };
  }
  const runner = new StepRunner(record, save, log);
  const gate: Gate = { runner, plan: record.plan, world, name };
  const last = until ? STEP_IDS.indexOf(until) : STEP_IDS.length - 1;
  try {
    for (const id of STEP_IDS.slice(0, last + 1)) {
      if (runner.done(id)) continue;
      await STEPS[id](gate);
    }
  } catch (error) {
    if (!(error instanceof StepFailed)) throw error;
    log(`stopped at ${error.step.id}: ${error.message}`);
    record.leftovers = await leftovers(world, true);
    for (const line of record.leftovers) log(`left open: ${line}`);
    log(`fix what stopped it, then resume: pnpm --filter @pb/keeper hedge:demo -- --name ${name} --size ${size} --from ${error.step.id}${until ? ` --until ${until}` : ""}`);
  }
  record.pass = until ? runPassesUntil(record, until) : runPasses(record);
  record.finished_utc = new Date().toISOString();
  save(record);
  const bad = record.steps.filter((s) => !s.pass).map((s) => s.id);
  const scope = until ? ` UP TO ${until}` : "";
  log(record.pass ? `ALL STEPS${scope} AS EXPECTED. Record: ${recordFile}` : `NOT PASSED${bad.length ? `: ${bad.join(", ")}` : ": not every step ran"}. Record: ${recordFile}`);
  if (until && record.pass) log(`stopped after ${until}, as asked. Resume with --from ${STEP_IDS[last + 1] ?? until}`);
  process.exitCode = record.pass ? 0 : 1;
}

await main();
