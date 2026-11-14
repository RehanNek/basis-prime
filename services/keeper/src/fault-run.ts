// The 1Click stand-in's three faults on testnet (PLAN.md 11.5; INTERFACES.md 14 and 17): for each one, a small move
// with the fault switch on, and the account's pending transfers and balances before, during and after.
//
//   pnpm --filter @pb/keeper faults -- --name <label> [--amount 11] [--late-seconds 90] [--skip-overdue] [--from <step>]
//                                       [--dry-run]
//
//   setup:        create, deposit (80 mUSDC), hl_init, to_hl (40 USDC, no fault): hedge-demo's own steps
//   to_hl_arrived: one check: its verdict lists the setup's move in `arrived` (pb-risk sees the USDC on Hyperliquid),
//                 which settles it. 40 USDC, so the credit stays over pb-risk's 95% match after Hyperliquid's 1 USDC fee
//   fault_refund: 11 USDC to Hyperliquid with the switch on "refund": the refund's msg settles the transfer
//   fault_fail:   11 USDC to Hyperliquid with the switch on "fail" (the 11 mUSDC stay at the deposit address): nothing
//                 comes back, so the transfer stays under way
//   fault_late:   11 USDC home with the switch on "late" (--late-seconds after the quoted time): the late delivery's
//                 msg settles it
//   fail_overdue: waits for the failed transfer's deadline (its quote's expiry plus 30 minutes, so about 35 minutes
//                 more): it is overdue, and the engine counts it as nothing and says so in `top`. --skip-overdue
//                 leaves this step out
//   home, withdraw: what is left comes home, and both tokens go back to the keeper
//
// Each fault step also records pb-risk's preview (no transaction) just after the account's call and once the fault
// has played out: equity with the money in transit (98% for the state, 0 for credit), `arrived` and `top`.
//
// The switch goes through the backend (POST /api/drill/fault), which holds SHIM_ADMIN_TOKEN, and is set back to "none"
// after each fault. It applies to every swap whose deposit arrives while it is on, so run this while nothing else is
// moving money through the stand-in. The account has no loan, so its moves need no verdict. The keeper's key signs
// (it owns the account); it is loaded from the repo's .env and never printed. The record goes to
// research/data/phase4_faults.json after every step; --from resumes from it.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { snapshotOf, faultChecks, type FaultMode, type FaultSnapshot } from "./fault-kit.js";
import { gateGear, gateSettings, log, nearBalance, ROOT } from "./gate-world.js";
import { stepsBefore, stepsPass, StepFailed, StepRunner, type Plan, type RunRecord, type StepRecord } from "./hedge-kit.js";
import { call, callForVerdict, leftovers, market, settle, signedIndex, state, STEPS, submit, until, waitFor, type Gate } from "./hedge-steps.js";
import { CHECK_DEPOSIT, eventsIn, TGAS_ACCOUNT, type Outcome } from "./near-tx.js";
import { attestationByTx } from "./outlayer.js";

const SETUP = ["create", "deposit", "hl_init", "to_hl"] as const;
const ARRIVED = "to_hl_arrived";
const FAULTS: { id: string; fault: FaultMode; move: "to_hl" | "home" }[] = [
  { id: "fault_refund", fault: "refund", move: "to_hl" },
  { id: "fault_fail", fault: "fail", move: "to_hl" },
  { id: "fault_late", fault: "late", move: "home" },
];
const CLOSE_OUT = ["home", "withdraw"] as const;
export const FAULT_STEP_IDS = [...SETUP, ARRIVED, ...FAULTS.map((f) => f.id), "fail_overdue", ...CLOSE_OUT];

function fail(message: string, code = 2): never {
  console.error(`fault-run: ${message}`);
  process.exit(code);
}

const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    name: { type: "string" },
    amount: { type: "string", default: "11" },
    "late-seconds": { type: "string", default: "90" },
    "skip-overdue": { type: "boolean", default: false },
    from: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const name = values.name ?? fail("give --name <label>: the client account is <label>.pbf.testnet");
const from = values.from;
if (from !== undefined && !FAULT_STEP_IDS.includes(from)) fail(`--from takes one of ${FAULT_STEP_IDS.join(", ")}`);
const amountUsdc = Number(values.amount);
if (!Number.isFinite(amountUsdc) || amountUsdc < 10 || amountUsdc > 20) fail("--amount is the USDC per move, from 10 to 20");
const amountMicro = BigInt(Math.round(amountUsdc * 1e6));
const lateSeconds = Number(values["late-seconds"]);
if (!Number.isInteger(lateSeconds) || lateSeconds < 30 || lateSeconds > 900) fail("--late-seconds is a whole number from 30 to 900");
const dryRun = values["dry-run"];
const skipOverdue = values["skip-overdue"];
const stepIds = skipOverdue ? FAULT_STEP_IDS.filter((id) => id !== "fail_overdue") : FAULT_STEP_IDS;

const settings = gateSettings("fault-run", name, dryRun, fail);
const { account, owner, apiUrl } = settings;
const recordFile = `${ROOT}research/data/phase4_faults.json`;
const gear = gateGear(settings);
const { world } = gear;

interface FaultRecord extends RunRecord {
  version: 1;
  account: string;
  owner: string;
  api_url: string;
  amount_micro: string;
  late_seconds: number;
  started_utc: string;
  finished_utc?: string;
  plan: Plan;
  context: Record<string, unknown>;
  steps: StepRecord[];
  pass?: boolean;
  leftovers?: string[];
}

function save(record: FaultRecord) {
  writeFileSync(recordFile, `${JSON.stringify(record, null, 1)}\n`);
}

/**
 * The setup's sizes: 40 USDC to Hyperliquid (a first deposit over $10, whose credit stays over pb-risk's 95% match
 * after Hyperliquid's 1 USDC fee for a new address), and 40 more mUSDC on NEAR for the faults' moves.
 */
function faultPlan(btcPx: number): Plan {
  return {
    size: "small",
    btc_px: btcPx,
    deposit_usdc_micro: "80000000",
    deposit_nbtc_units: "1000",
    to_hl_micro: "40000000",
    short_sz: "0",
    burst: { count: 0, sz: "0" },
    caps: { to_hl_micro: "40000000", short_usd: 0, borrow_micro: "0", float_order_usd: 0, nbtc_usd: 10 },
  };
}

async function setFault(mode: FaultMode | "none", delaySeconds?: number) {
  const { status, body } = await world.api.post("/api/drill/fault", { fault: mode, ...(delaySeconds !== undefined && { delay_seconds: delaySeconds }) }, 15_000);
  if (status !== 200) throw new Error(`POST /api/drill/fault answered HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
  return (body as { fault: unknown }).fault;
}

async function snap(): Promise<FaultSnapshot> {
  const st = await state(world);
  const musdc = await world.near.view<string>(world.ids.musdc, "ft_balance_of", { account_id: account });
  let hl: FaultSnapshot["hl"] = { withdrawable: null, account_value: null };
  const address = st.hl?.address;
  if (address) {
    try {
      const ch = await world.hl.info<{ withdrawable?: string; marginSummary?: { accountValue?: string } }>({ type: "clearinghouseState", user: address });
      hl = { withdrawable: Number(ch.withdrawable ?? 0), account_value: Number(ch.marginSummary?.accountValue ?? 0) };
    } catch {
      // Hyperliquid didn't answer: the snapshot says so with nulls
    }
  }
  return snapshotOf(world.now(), st as { counter: number; pending?: unknown[] }, musdc, hl);
}

/** pb-risk's preview of the account (no transaction): what the engine makes of the money in transit. */
async function engineView() {
  try {
    const { status, body } = await world.api.post("/api/preview", { account, intent: { check: {} } });
    const answer = body as { verdict?: Record<string, unknown>; run?: { call_id?: string | null; attestation_url?: string | null }; message?: string } | null;
    if (status !== 200 || !answer?.verdict) return { error: `the preview answered HTTP ${status}: ${answer?.message ?? ""}`.trim() };
    const v = answer.verdict;
    return { ok: v.ok, eq: v.eq ?? null, eq_allow: v.eq_allow ?? null, top: v.top ?? null, arrived: v.arrived ?? null, reason: v.reason ?? null, call_id: answer.run?.call_id ?? null, attestation_url: answer.run?.attestation_url ?? null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The stand-in's own transaction (the refund or the delivery), and the account's events in it. */
async function txEvidence(hash: string | null | undefined, sender: string | null) {
  if (!hash || !sender) return null;
  try {
    const outcome = (await gear.provider.viewTransactionStatus({ txHash: hash, accountId: sender, waitUntil: "FINAL" })) as unknown as Outcome;
    const logs = (outcome.receipts_outcome ?? []).flatMap((r) => r.outcome?.logs ?? []);
    return { tx: hash, events: eventsIn(logs), logs: logs.slice(0, 12) };
  } catch (error) {
    return { tx: hash, error: error instanceof Error ? error.message : String(error) };
  }
}

interface MoveQuote {
  correlationId: string;
  quote: { depositAddress: string; depositMemo?: string | null; amountIn: string; amountOut: string; amountOutFormatted: string; timeEstimate: number; deadline?: string };
  move: { next: { method: string; args: Record<string, unknown> } | null; transfer_id?: string | null; exp_ms?: number | null };
}

async function faultStep(runner: StepRunner<FaultRecord>, id: string, fault: FaultMode, move: "to_hl" | "home", shimFloat: string | null) {
  const where = move === "to_hl" ? "to Hyperliquid" : "home";
  await runner.run(id, `${fault}: a ${amountUsdc} USDC move ${where}, with the stand-in's fault switch on "${fault}"`, {}, async (step) => {
    const before = await snap();
    const switched = await setFault(fault, fault === "late" ? lateSeconds : undefined);
    try {
      const { status, body } = await world.api.post("/api/quote", { dry: false, move, account, amount: amountMicro.toString() });
      if (status !== 200) throw new Error(`the move quote failed: HTTP ${status} ${JSON.stringify(body).slice(0, 300)}`);
      const quote = body as MoveQuote;
      const next = quote.move.next;
      if (!next) throw new Error("the quote has no call to make");
      const transferId = quote.move.transfer_id ?? null;
      const called = world.now();
      if (move === "to_hl") {
        if (next.method !== "withdraw") throw new Error("the quote has no withdraw to send");
        await call(world, step, account, "withdraw", next.args, 300, 1n, `withdraw to the deposit address (${fault})`);
      } else {
        if (next.method !== "hl_withdraw") throw new Error("the quote has no hl_withdraw to send");
        const st = await state(world);
        const last = Math.max(-1, ...(st.hl?.signed ?? []).map((e) => e.index));
        const tx = await call(world, step, account, "hl_withdraw", { ...next.args, source_dex: "" }, 300, 1n, `hl_withdraw (${fault})`);
        const index = await signedIndex(world, tx, "sendAsset", last);
        const posted = await submit(world, step, index, `submit sendAsset #${index}`);
        if (!posted.ok) throw new Error(`Hyperliquid refused the sendAsset: ${JSON.stringify(posted.answer).slice(0, 200)}`);
      }
      const during = await snap();
      const engineDuring = await engineView();
      const timeoutMs = (quote.quote.timeEstimate + (fault === "late" ? lateSeconds : 0) + 300) * 1000;
      const { final, seen } = await settle(world, quote.quote.depositAddress, quote.quote.depositMemo, timeoutMs);
      const seconds = Math.round((world.now() - called) / 1000);
      // The account learns of a refund or a delivery from its msg, a few seconds after the stand-in sends it.
      const after =
        fault === "fail"
          ? (await world.sleep(20_000), await snap())
          : await until(world, `transfer ${transferId} to leave pending`, 90_000, 3_000, snap, (s) => !transferId || !s.transfers.some((t) => t.id === transferId)).catch(() => snap());
      const shim = (final as { shim?: { refundTxHash?: string | null } }).shim;
      const delivery = (final as { swapDetails?: { destinationChainTxHashes?: { hash: string }[] } }).swapDetails?.destinationChainTxHashes?.[0]?.hash;
      const evidence = fault === "refund" ? await txEvidence(shim?.refundTxHash, shimFloat) : fault === "late" ? await txEvidence(delivery, shimFloat) : null;
      const engineAfter = await engineView();
      const checks = faultChecks({
        fault,
        transferId,
        amountMicro,
        ...(fault === "late" ? { deliveredMicro: BigInt(quote.quote.amountOut), late: { seconds, delaySeconds: lateSeconds } } : {}),
        before,
        during,
        after,
        status: final.status,
      });
      for (const line of checks.words) log(`  ${line}`);
      const deadline = during.transfers.find((t) => t.id === transferId)?.deadlineMs ?? null;
      return {
        ok: checks.pass,
        detail: {
          fault: switched,
          move,
          amount_micro: amountMicro.toString(),
          quote: { correlationId: quote.correlationId, depositAddress: quote.quote.depositAddress, depositMemo: quote.quote.depositMemo ?? null, amountIn: quote.quote.amountIn, amountOut: quote.quote.amountOut, timeEstimate: quote.quote.timeEstimate, deadline: quote.quote.deadline ?? null },
          transfer_id: transferId,
          exp_ms: quote.move.exp_ms ?? null,
          statuses: seen,
          final: { status: final.status, reason: final.swapDetails?.refundReason ?? null, shim: shim ?? null, delivery_tx: delivery ?? null },
          seconds_to_final: seconds,
          before,
          during,
          after,
          ...(deadline && { overdue_after: new Date(deadline).toISOString() }),
          evidence,
          engine: { during: engineDuring, after: engineAfter },
          checks,
        },
      };
    } finally {
      await setFault("none").catch((error: unknown) => log(`  could not set the fault switch back to none: ${String(error)}. Set it on the Drill page.`));
    }
  });
}

/**
 * A failed transfer can't settle by a msg: 1Click's FAILED returns nothing. Its right record is "still under way" until
 * its deadline, then overdue: borrowing waits, and the engine counts it as nothing and names it in `top`
 * (INTERFACES.md 14 and 15, as built). This step waits for the deadline, then shows both.
 */
async function stepOverdue(runner: StepRunner<FaultRecord>) {
  await runner.run("fail_overdue", "the failed transfer goes overdue: still under way, and the engine counts it as nothing", {}, async () => {
    const failed = runner.record.steps.find((s) => s.id === "fault_fail")?.detail as { transfer_id?: string | null } | undefined;
    const id = failed?.transfer_id;
    if (!id) throw new Error("the fail step named no transfer, so there is nothing to watch go overdue");
    const before = await snap();
    const transfer = before.transfers.find((t) => t.id === id);
    if (!transfer?.deadlineMs) return { ok: false, detail: { id, before, why: `transfer ${id} is no longer under way: something settled it` } };
    const waitMs = Math.max(0, transfer.deadlineMs - (await world.near.finalBlockMs())) + 60_000;
    log(`  transfer ${id} is due at ${new Date(transfer.deadlineMs).toISOString()}: waiting about ${Math.round(waitMs / 60_000)} min for it to go overdue`);
    await until(world, `transfer ${id}'s deadline`, waitMs + 5 * 60_000, 30_000, () => world.near.finalBlockMs(), (ms) => ms > transfer.deadlineMs! + 30_000);
    const after = await snap();
    const engine = await engineView();
    const still = after.transfers.some((t) => t.id === id);
    const top = (engine as { top?: unknown }).top;
    const named = Array.isArray(top) && top.some((line) => typeof line === "string" && /overdue/.test(line) && (line.includes(id) || /more transfers/.test(line)));
    const words = [still ? null : `transfer ${id} left pending`, named ? null : `the engine's top doesn't name ${id} as overdue: ${JSON.stringify(top)}`].filter(Boolean);
    for (const line of words) log(`  ${line}`);
    return { ok: still && named, detail: { id, deadline: new Date(transfer.deadlineMs).toISOString(), before, after, engine, checks: { still_under_way: still, top_names_it: named, words } } };
  });
}

/** A move to Hyperliquid that arrived settles through the next verdict's `arrived` (INTERFACES.md 14 and 15). */
async function stepArrived(runner: StepRunner<FaultRecord>) {
  await runner.run(ARRIVED, "one check: its verdict lists the setup's move in arrived, which settles it", { observe: true }, async (step) => {
    const before = await snap();
    const moves = before.transfers.filter((t) => t.kind === "to_hl");
    if (moves.length === 0) return { ok: false, detail: { before, why: "no move to Hyperliquid is under way: the account recorded none (does its get_state carry next_move?)" } };
    const prev = (await state(world)).verdict?.received_block ?? 0;
    const tx = await callForVerdict(world, step, account, "request_check", { intent: { check: {} } }, TGAS_ACCOUNT, CHECK_DEPOSIT, "request_check (arrived)");
    const st = await waitFor(world, tx, "the verdict", () => state(world), (s) => (s.verdict?.received_block ?? 0) > prev);
    const after = await snap();
    const v = st.verdict!.verdict;
    const settled = moves.filter((t) => !after.transfers.some((x) => x.id === t.id)).map((t) => t.id);
    if (settled.length < moves.length) log(`  still under way: ${moves.filter((t) => !settled.includes(t.id)).map((t) => t.id).join(", ")}; the verdict's arrived: ${JSON.stringify(v.arrived ?? null)}`);
    return {
      ok: settled.length === moves.length,
      detail: { moves, arrived: v.arrived ?? null, settled, before, after, verdict: { state: v.state, eq: v.eq, eq_allow: v.eq_allow, top: v.top }, tx: tx.hash, attestation_url: tx.hash ? attestationByTx(settings.outlayerApi, tx.hash) : null, evidence: eventsIn(tx.logs) },
    };
  });
}

async function main() {
  const { mark } = await market(world, "BTC");
  const plan = faultPlan(mark);
  log(`account ${account}, owned by ${owner}; backend ${apiUrl}; ${amountUsdc} USDC per move; the late delivery ${lateSeconds} s after the quoted time`);
  log(`setup: deposit ${Number(plan.deposit_usdc_micro) / 1e6} mUSDC, hl_init, ${Number(plan.to_hl_micro) / 1e6} USDC to Hyperliquid, and one check to settle it (arrived); then refund (to Hyperliquid), fail (to Hyperliquid), late (home); ${skipOverdue ? "" : "then the wait for the failed transfer to go overdue (about 35 min); "}then home and withdraw`);
  const drill = await world.api.get("/api/drill").catch(() => ({ status: 0, body: null }));
  const fault = drill.status === 200 ? ((drill.body as { faults_enabled?: boolean; fault?: { mode?: string } | null; fault_error?: string | null } | null) ?? null) : null;
  const config = await world.api.get("/api/config").catch(() => ({ status: 0, body: null }));
  const shimFloat = ((config.body as { ids?: { shim_float?: string | null } } | null)?.ids?.shim_float as string | null | undefined) ?? null;
  const exists = await world.near.exists(account);
  const balance = await nearBalance(gear.provider, owner);
  const previews = (config.body as { preview_enabled?: boolean } | null)?.preview_enabled === true;
  const problems = [
    previews ? null : "the backend's previews are off (OUTLAYER_PAYMENT_KEY): the run records the engine's view with them",
    drill.status !== 200 ? `the backend at ${apiUrl} doesn't answer GET /api/drill: is it running with the Phase 4 code?` : null,
    fault && !fault.faults_enabled ? `the backend's fault switch is off: ${fault.fault_error ?? "SHIM_ADMIN_TOKEN is empty"}` : null,
    fault?.fault?.mode && fault.fault.mode !== "none" ? `the fault switch is on "${fault.fault.mode}" now: set it to none first (another run may be using it)` : null,
    !exists && balance < 5.5 ? `${owner} holds ${balance.toFixed(2)} NEAR; creating ${account} takes 5` : null,
  ].filter((p): p is string => Boolean(p));
  log(`the fault switch: ${fault?.fault ? JSON.stringify(fault.fault) : (fault?.fault_error ?? "unknown")}; ${exists ? `${account} exists` : `${account} doesn't exist yet`}; ${owner} holds ${balance.toFixed(4)} NEAR`);
  if (dryRun) {
    for (const p of problems) log(`problem: ${p}`);
    log(`dry run: nothing sent. The record would go to ${recordFile}`);
    return;
  }
  if (problems.length) fail(problems.join("; "));

  let record: FaultRecord;
  if (from) {
    if (!existsSync(recordFile)) fail(`--from ${from} needs ${recordFile}`);
    const saved = JSON.parse(readFileSync(recordFile, "utf8")) as FaultRecord;
    if (saved.account !== account) fail(`${recordFile} is for ${saved.account}, not ${account}`);
    const { pass: _p, finished_utc: _f, leftovers: _l, ...rest } = saved;
    record = { ...rest, steps: stepsBefore(saved.steps, FAULT_STEP_IDS, from) };
    log(`resuming at ${from}, with ${record.steps.length} earlier step(s) kept`);
  } else {
    if (existsSync(recordFile)) {
      const kept = recordFile.replace(/\.json$/, `.${Date.now()}.json`);
      renameSync(recordFile, kept);
      log(`the previous record is kept as ${kept}`);
    }
    record = { version: 1, account, owner, api_url: apiUrl, amount_micro: amountMicro.toString(), late_seconds: lateSeconds, started_utc: new Date().toISOString(), plan, context: {}, steps: [] };
  }
  const runner = new StepRunner<FaultRecord>(record, save, log);
  const gate: Gate = { runner, plan: record.plan, world, name };
  try {
    for (const id of SETUP) if (!runner.done(id)) await STEPS[id](gate);
    if (!runner.done(ARRIVED)) await stepArrived(runner);
    for (const f of FAULTS) if (!runner.done(f.id)) await faultStep(runner, f.id, f.fault, f.move, shimFloat);
    if (!skipOverdue && !runner.done("fail_overdue")) await stepOverdue(runner);
    for (const id of CLOSE_OUT) if (!runner.done(id)) await STEPS[id](gate);
  } catch (error) {
    if (!(error instanceof StepFailed)) throw error;
    log(`stopped at ${error.step.id}: ${error.message}`);
    record.leftovers = await leftovers(world, false);
    for (const line of record.leftovers) log(`left open: ${line}`);
    log(`fix what stopped it, then resume: pnpm --filter @pb/keeper faults -- --name ${name} --from ${error.step.id}`);
  }
  record.pass = stepsPass(record.steps, stepIds);
  record.finished_utc = new Date().toISOString();
  save(record);
  const bad = record.steps.filter((s) => !s.pass).map((s) => s.id);
  log(record.pass ? `ALL THREE FAULTS LEFT THE RECORDS RIGHT${skipOverdue ? " (the overdue wait left out)" : ""}. Record: ${recordFile}` : `NOT PASSED${bad.length ? `: ${bad.join(", ")}` : ": not every step ran"}. Record: ${recordFile}`);
  process.exitCode = record.pass ? 0 : 1;
}

await main();
