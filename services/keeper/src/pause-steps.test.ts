// Gate 2's three steps of INTERFACES.md 50.2 (pause_lifted, borrow_again, repay_again) against a fake account that
// keeps the contract's own rules: a check's `sent` takes nonces off `open_sends`, `send_open_until_ms` drops to "0"
// when none is left, and `borrow` wants the pause off and a fresh, unused borrow verdict that allows the amount.
// Nothing here reaches a chain or Hyperliquid.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BORROW_AGAIN_MICRO,
  borrowAgainAmount,
  describeGate,
  FRESH_BLOCKS,
  FRESH_MARGIN_BLOCKS,
  FUNDING_CLOSE_OUT,
  FUNDING_STEP_IDS,
  heldBacksBorrow,
  LEDGER_WAIT_MS,
  ledgerFrom,
  olderAccountWords,
  PAUSE_CHECKS,
  PAUSE_RETRY_WAIT_MS,
  passWords,
  pauseLifted,
  pauseStaysWords,
  sendsInLedger,
  showsOpenSends,
} from "./funding-kit.js";
import { FUNDING_STEPS, stepBorrowAgain, stepPauseLifted, stepRepayAgain } from "./funding-steps.js";
import { planFor, stepsBefore, stepsPass, type StepRecord } from "./hedge-kit.js";
import { sendOpenProblem, STEPS } from "./hedge-steps.js";
import { ACCOUNT, ADDRESS, chain, fakeGate, FLOAT, KEEPER, MNBTC, MUSDC, NONCE, olderChain, POOL, SEND_OPEN_MS, sendRow, stops, T0, USD, verdict } from "./pause-fakes.js";

// ---------- the step list ----------

test("50.2, gate 2's way out: after the transfer home the pause is lifted, the account borrows again and repays, and only then withdraws", () => {
  assert.deepEqual([...FUNDING_CLOSE_OUT], ["repay_rhea", "repay", "credit", "rhea_withdraw", "close_short", "home", "pause_lifted", "borrow_again", "repay_again", "withdraw"]);
  const at = (id: string) => FUNDING_STEP_IDS.indexOf(id);
  assert.deepEqual([at("pause_lifted") - at("home"), at("borrow_again") - at("home"), at("repay_again") - at("home"), at("withdraw") - at("home")], [1, 2, 3, 4]);
  // Each has its function, and --from takes each (funding-demo.ts checks --from against this list).
  for (const id of ["pause_lifted", "borrow_again", "repay_again"]) {
    assert.equal(typeof FUNDING_STEPS[id], "function", id);
    assert.ok(!(id in STEPS), `${id} is the funding gate's own`);
    assert.ok(FUNDING_STEP_IDS.includes(id), id);
  }
  assert.deepEqual([FUNDING_STEPS.pause_lifted, FUNDING_STEPS.borrow_again, FUNDING_STEPS.repay_again], [stepPauseLifted, stepBorrowAgain, stepRepayAgain]);
});

test("50.2, the dry run's plan says the three new steps in their place, what each sends and checks, and that an older account skips them", () => {
  const lines = describeGate({ account: ACCOUNT, owner: KEEPER, operator: "pbf-ops.testnet", lender: "rhea", rheaId: "rhea.pbf-ops.testnet", pool: POOL, apiUrl: "http://localhost:8788", plan: planFor("small", 76_000), recordFile: "r.json", holdFile: "h.json", aimBp: 13_000, settleWaitMin: 70, settleEverySec: 120 });
  const line = (start: string) => lines.findIndex((l) => l.startsWith(start));
  const order = [line("20 close_short, home"), line("21 pause_lifted"), line("22 borrow_again"), line("23 repay_again"), line("24 withdraw")];
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!)), JSON.stringify(order));
  const text = lines.join("\n");
  assert.ok(text.includes('request_check with {"borrow":{"amount":"50000000"}} (0.01 NEAR)'));
  assert.ok(text.includes('get_state().hl.send_open_until_ms is "0" and open_sends is empty'));
  assert.ok(text.includes("one more check 30 s later; a second miss fails the step"));
  assert.ok(text.includes("for $50 or what the result allows if that is less, with 1 yoctoNEAR"));
  assert.ok(text.includes("(another check only if its 120 blocks ran out)"));
  assert.ok(text.includes("an account made before the pause could lift early shows no open_sends: steps 21 to 23 are skipped"));
});

// ---------- the rules, on their own ----------

test('50.2, the pause is lifted only when the account shows open_sends, the list is empty and send_open_until_ms is "0"', () => {
  assert.equal(pauseLifted({ open_sends: [], send_open_until_ms: "0", send_floor_until_ms: "0" }), true);
  // One still open; a floor holding the end up with nothing listed; an account from before; a missing field; nothing.
  assert.equal(pauseLifted({ open_sends: [String(NONCE)], send_open_until_ms: "0" }), false);
  assert.equal(pauseLifted({ open_sends: [], send_open_until_ms: String(T0 + 1) }), false);
  assert.equal(pauseLifted({ send_open_until_ms: "0" }), false);
  assert.equal(pauseLifted({ open_sends: [] }), false);
  assert.equal(pauseLifted(null), false);
  assert.equal(pauseLifted(undefined), false);
  assert.deepEqual([showsOpenSends({ open_sends: [] }), showsOpenSends({ send_open_until_ms: "5" }), showsOpenSends(null)], [true, false, false]);
});

test("50.2, a transfer counts as sent when Hyperliquid's history has a send by the account's own address with its nonce: money coming in, and another address's send, don't count", () => {
  const open = [String(NONCE), String(NONCE + 5)];
  assert.deepEqual(sendsInLedger([sendRow(NONCE)], ADDRESS, open), [String(NONCE)]);
  assert.deepEqual(sendsInLedger([sendRow(NONCE), sendRow(NONCE + 5)], ADDRESS.toUpperCase().replace("0X", "0x"), open), open, "the address in any case");
  // A send to the account (the float paying in), with the same number by chance.
  assert.deepEqual(sendsInLedger([sendRow(NONCE, FLOAT, ADDRESS)], ADDRESS, open), []);
  // Another kind of row, a nonce that isn't open, and an answer that isn't a list.
  assert.deepEqual(sendsInLedger([{ time: 1, hash: "0x", delta: { type: "deposit", usdc: "5", nonce: NONCE } }, sendRow(NONCE + 9)], ADDRESS, open), []);
  assert.deepEqual(sendsInLedger(null, ADDRESS, open), []);
  assert.deepEqual(sendsInLedger({ error: "x" }, ADDRESS, open), []);
  assert.equal(ledgerFrom(open), NONCE - 3_600_000, "the history is read from an hour before the oldest open nonce, as the engine reads it");
});

test("50.2, the second loan is $50, or what the check allows if that is less; a check that allows nothing, or isn't HEALTHY, gives no amount and says what it said", () => {
  assert.equal(BORROW_AGAIN_MICRO, 50n * USD);
  assert.deepEqual(borrowAgainAmount(verdict({ allow: { borrow: 400_000_000 } })), { amount: 50n * USD });
  assert.deepEqual(borrowAgainAmount(verdict({ allow: { borrow: 50_000_000 } })), { amount: 50n * USD });
  assert.deepEqual(borrowAgainAmount(verdict({ allow: { borrow: 31_250_000 } })), { amount: 31_250_000n });
  assert.deepEqual(borrowAgainAmount(verdict({ allow: { borrow: 0 } })), { problem: "the check allows no new loan. It said: ok true, state HEALTHY, action NONE, allow.borrow 0" });
  assert.deepEqual(borrowAgainAmount(verdict({ state: "WATCH", allow: { borrow: 90_000_000 } })), { problem: "the check allows no new loan. It said: ok true, state WATCH, action NONE, allow.borrow 90000000" });
  assert.deepEqual(borrowAgainAmount({ ok: false, reason: "no price for nBTC" }), { problem: 'the check allows no new loan. It said: ok false, state none, action none, allow.borrow none, reason "no price for nBTC"' });
});

test("50.2, the check that lifted the pause backs the borrow while it answers a borrow, is unused and has 15 of its 120 blocks left; otherwise another is needed", () => {
  const held = { intent: { borrow: { amount: "50000000" } }, verdict: verdict({ blk: 9_000, nonce: 40 }) };
  assert.deepEqual([FRESH_BLOCKS, FRESH_MARGIN_BLOCKS], [120, 15]);
  assert.deepEqual(heldBacksBorrow(held, 40, 9_105), { ok: true });
  assert.deepEqual(heldBacksBorrow(held, 40, 9_106), { ok: false, why: "the check result the account holds is 106 blocks old, and the account takes one for 120" });
  assert.deepEqual(heldBacksBorrow(held, 41, 9_010), { ok: false, why: "the check result the account holds was used already" });
  assert.deepEqual(heldBacksBorrow({ ...held, intent: { check: {} } }, 40, 9_010), { ok: false, why: "the check result the account holds doesn't answer a borrow" });
  assert.deepEqual(heldBacksBorrow(null, 40, 9_010), { ok: false, why: "the account holds no check result" });
});

test("50.2, what stops a borrow while a transfer is open: an older account is told to use a new one, as before; one that shows open_sends is told a check lifts it", () => {
  const until = NONCE + SEND_OPEN_MS;
  const date = new Date(until).toISOString();
  // An account made before: the sentence of before, word for word.
  assert.equal(
    sendOpenProblem(ACCOUNT, { address: ADDRESS, send_open_until_ms: String(until) }, T0, "borrowing"),
    `${ACCOUNT} signed a transfer out of Hyperliquid that can be posted until ${date}: borrowing waits until then. Use a new --name.`,
  );
  const lifts = sendOpenProblem(ACCOUNT, { address: ADDRESS, send_open_until_ms: String(until), open_sends: [String(NONCE)], send_floor_until_ms: "0" }, T0, "borrowing")!;
  assert.match(lifts, /^demo\.pbf\.testnet signed a transfer out of Hyperliquid that no check has seen as sent yet: borrowing waits\. A check lifts this once Hyperliquid's history shows the transfer/);
  assert.ok(lifts.includes("run from pause_lifted") && lifts.includes(`ends by itself at ${date}`) && !lifts.includes("Use a new --name"));
  // A floor: no check ends it sooner, so a new account it is.
  const floor = sendOpenProblem(ACCOUNT, { address: ADDRESS, send_open_until_ms: String(until), open_sends: [], send_floor_until_ms: String(until) }, T0, "borrowing")!;
  assert.ok(floor.includes("no check ends that sooner") && floor.includes("Use a new --name."));
  // Nothing open, the pause over, no Hyperliquid address at all: nothing is in the way.
  for (const hl of [{ address: ADDRESS, send_open_until_ms: "0", open_sends: [] }, { address: ADDRESS, send_open_until_ms: String(T0 - 1) }, { address: ADDRESS }, null, undefined]) {
    assert.equal(sendOpenProblem(ACCOUNT, hl, T0, "borrowing"), null);
  }
});

// ---------- an account made before the deploy ----------

test("50.2, on an account that doesn't show open_sends the three steps are skipped with one line, nothing is sent or asked, and they count as passed", async () => {
  const c = olderChain();
  const { gate, sent, asked, logged, record, detail } = fakeGate(c);
  for (const id of ["pause_lifted", "borrow_again", "repay_again"]) await FUNDING_STEPS[id]!(gate);
  assert.deepEqual([sent.length, asked.length], [0, 0]);
  const words = olderAccountWords(ACCOUNT);
  assert.equal(words, `${ACCOUNT} was made before the pause could lift early (its state shows no open_sends): it keeps the 2 days and 1 hour, so pause_lifted, borrow_again and repay_again are skipped`);
  assert.deepEqual(logged, [`  ${words}`], "one line, said once");
  for (const id of ["pause_lifted", "borrow_again", "repay_again"]) assert.equal(detail(id).skipped, words, id);
  assert.deepEqual(record.steps.map((s) => [s.id, s.ok, s.pass]), [["pause_lifted", true, true], ["borrow_again", true, true], ["repay_again", true, true]]);
  assert.equal(c.state.hl!.send_open_until_ms, String(NONCE + SEND_OPEN_MS), "the account is as it was");
});

// ---------- pause_lifted ----------

test("50.2, pause_lifted: once Hyperliquid's history shows the transfer, one check with a borrow intent for $50 is asked, and the step passes on send_open_until_ms \"0\" and an empty list", async () => {
  const c = chain({ ledger: [] });
  // Hyperliquid's history shows the transfer on the third look.
  c.between = (now) => {
    if (now.now >= T0 + 10_000) now.ledger = [sendRow(NONCE)];
  };
  const { gate, sent, asked, record, detail, step } = fakeGate(c);
  await stepPauseLifted(gate);
  assert.equal(step("pause_lifted").ok, true);
  assert.deepEqual(asked, Array.from({ length: 3 }, () => ({ type: "userNonFundingLedgerUpdates", user: ADDRESS, startTime: NONCE - 3_600_000 })), "Hyperliquid's own request, from an hour before the transfer");
  assert.deepEqual(sent, [{ contract: ACCOUNT, method: "request_check", args: { intent: { borrow: { amount: "50000000" } } }, deposit: 10n ** 22n }], "one check, with 0.01 NEAR, and nothing else");
  assert.deepEqual([c.state.hl!.send_open_until_ms, c.state.hl!.open_sends], ["0", []]);
  const d = detail("pause_lifted");
  assert.deepEqual([d.open_before, d.send_open_until_ms_before, d.send_open_until_ms, d.open_sends], [[String(NONCE)], String(NONCE + SEND_OPEN_MS), "0", []]);
  assert.deepEqual(d.ledger, { shown: [String(NONCE)], waited_s: 10 });
  assert.deepEqual((d.checks as { verdict: { sent: number[] } }[]).map((k) => k.verdict.sent), [[NONCE]]);
  // The verdict's block: ten blocks went by while the history was looked at, and the check's result read two blocks before it landed.
  assert.deepEqual(record.context.pause_lifted, { blk: 9_011, checks: 1, open_before: [String(NONCE)], sent: [NONCE] });
});

test('50.2, pause_lifted fails when the list is empty and send_open_until_ms isn\'t "0" (a floor), and when send_open_until_ms is "0" and a transfer is still listed', async () => {
  // A floor: the checks name the transfer, the list empties, and the end stays where the floor holds it.
  const floor = chain();
  floor.state.hl!.send_floor_until_ms = String(T0 + 3_600_000);
  const a = fakeGate(floor);
  const why = await stops(stepPauseLifted(a.gate));
  assert.equal(why, "step pause_lifted did not go as expected");
  assert.deepEqual([floor.state.hl!.open_sends, floor.state.hl!.send_open_until_ms], [[], String(T0 + 3_600_000)]);
  assert.equal(a.step("pause_lifted").ok, false);
  assert.match(String(a.detail("pause_lifted").why), /^the pause is still on after 2 check\(s\): the account holds a floor until .* and no check ends the pause before it$/);
  // The other half, which the contract's rule never gives: "0" with a transfer still listed is not lifted either.
  const odd = chain({ verdicts: [verdict(), verdict()], afterCheck: (c) => (c.state.hl!.send_open_until_ms = "0") });
  const b = fakeGate(odd);
  await stops(stepPauseLifted(b.gate));
  assert.deepEqual([odd.state.hl!.send_open_until_ms, odd.state.hl!.open_sends, b.step("pause_lifted").ok], ["0", [String(NONCE)], false]);
});

test("50.2, pause_lifted asks once more when the first check leaves the pause on: 30 s later, with the same intent, and the second check's result lifts it", async () => {
  // The engine's read of the history trailed: the first result names nothing as sent.
  const c = chain({ verdicts: [verdict()] });
  const { gate, checks, slept, logged, detail, record, step } = fakeGate(c);
  await stepPauseLifted(gate);
  assert.equal(step("pause_lifted").ok, true);
  assert.deepEqual(checks().map((k) => k.args), [{ intent: { borrow: { amount: "50000000" } } }, { intent: { borrow: { amount: "50000000" } } }]);
  assert.deepEqual([PAUSE_RETRY_WAIT_MS, slept.filter((ms) => ms === PAUSE_RETRY_WAIT_MS).length], [30_000, 1]);
  assert.deepEqual(logged, ["  the check left the pause on (the engine's read of Hyperliquid's history can trail): one more check in 30 s"]);
  const seen = detail("pause_lifted").checks as { send_open_until_ms: string; open_sends: string[] }[];
  assert.deepEqual(seen.map((k) => [k.send_open_until_ms, k.open_sends]), [[String(NONCE + SEND_OPEN_MS), [String(NONCE)]], ["0", []]]);
  assert.equal((record.context.pause_lifted as { checks: number }).checks, 2);
});

test("50.2, pause_lifted fails after the second check that leaves the pause on, in plain words, and never asks a third", async () => {
  const c = chain({ verdicts: [verdict(), verdict(), verdict({ sent: [NONCE] })] });
  const { gate, checks, detail, step, record } = fakeGate(c);
  await stops(stepPauseLifted(gate));
  assert.deepEqual([PAUSE_CHECKS, checks().length, step("pause_lifted").ok, step("pause_lifted").pass], [2, 2, false, false]);
  const until = new Date(NONCE + SEND_OPEN_MS).toISOString();
  assert.equal(
    detail("pause_lifted").why,
    `the pause is still on after 2 check(s): the account still lists transfer(s) ${NONCE} as not yet seen in Hyperliquid's history, and borrowing stays closed until ${until}. Either Hyperliquid's history doesn't show the transfer home yet, or the engine in use doesn't read it (is the new pb-risk the one the account pins?)`,
  );
  assert.equal(detail("pause_lifted").why, pauseStaysWords(c.state.hl, 2));
  assert.equal(record.context.pause_lifted, undefined);
});

test("50.2, pause_lifted asks for no check while Hyperliquid's history doesn't show the transfer: after two minutes it stops, and says to run it again", async () => {
  const c = chain({ ledger: [sendRow(NONCE, FLOAT, ADDRESS)] });
  const { gate, sent, asked } = fakeGate(c);
  const why = await stops(stepPauseLifted(gate));
  assert.match(why, new RegExp(`^timed out after 120 s waiting for Hyperliquid's history to show the transfer\\(s\\) ${NONCE} as sent; last seen: it showed 0 of 1\\. No check was asked for: run from pause_lifted again once the transfer shows$`));
  assert.equal(LEDGER_WAIT_MS, 120_000);
  assert.equal(sent.length, 0);
  assert.ok(asked.length > 20, "it kept looking, every 5 s");
});

test("50.2, pause_lifted run again after it passed asks for no second check while the result it brought still backs a borrow", async () => {
  const c = chain();
  const { gate, checks, detail } = fakeGate(c);
  await stepPauseLifted(gate);
  await stepPauseLifted(gate);
  assert.equal(checks().length, 1);
  assert.match(String(detail("pause_lifted").already), /no check was asked for/);
});

// ---------- borrow_again and repay_again ----------

test("50.2, borrow_again borrows $50 from our pool on the check that lifted the pause, with no second check, and the USDC arrives; repay_again closes the loan", async () => {
  const c = chain();
  const home: StepRecord = { id: "home", label: "home", ok: true, expect_fail: false, pass: true, started_utc: new Date(T0 - 200_000).toISOString(), seconds: 80, txs: [], gateway: [], detail: null };
  const { gate, sent, checks, detail, record, step } = fakeGate(c, [home]);
  await stepPauseLifted(gate);
  c.now += 20_000;
  c.block += 20;
  await stepBorrowAgain(gate);
  assert.equal(checks().length, 1, "the one check served both");
  assert.deepEqual(sent.at(-1), { contract: ACCOUNT, method: "borrow", args: { amount: "50000000" }, deposit: 1n });
  assert.deepEqual([c.poolDebt, c.balances[`${MUSDC}:${ACCOUNT}`], c.state.loan.open], [50n * USD, 480n * USD, true]);
  const d = detail("borrow_again");
  assert.deepEqual([d.borrowed, d.asked, d.allowed, d.checks_asked_here, d.usdc_before, d.usdc_after, d.debt_after], ["50000000", "50000000", "400000000", 0, "430000000", "480000000", "50000000"]);
  assert.equal(d.seconds_since_home, 140, "from the end of the home step to the loan's arrival");
  assert.equal(record.context.borrowed_again, "50000000");

  await stepRepayAgain(gate);
  assert.deepEqual(sent.at(-1), { contract: ACCOUNT, method: "repay", args: { amount: "51050000" }, deposit: 1n }, "the debt, a tenth of a percent and a dollar more: the pool sends back what is above it");
  assert.deepEqual([c.poolDebt, c.state.loan, c.balances[`${MUSDC}:${ACCOUNT}`]], [0n, { principal: "0", open: false }, 430n * USD]);
  assert.deepEqual([step("repay_again").ok, (detail("repay_again").loan as { open: boolean }).open, detail("repay_again").debt_after], [true, false, "0"]);
  assert.equal(stepsPass(record.steps, ["home", "pause_lifted", "borrow_again", "repay_again"]), true);
});

test("50.2, borrow_again borrows what the check allows when that is under $50, and fails without borrowing when it allows nothing, with what the check said", async () => {
  const less = chain({ verdicts: [verdict({ allow: { borrow: 31_250_000 }, sent: [NONCE] })] });
  const a = fakeGate(less);
  await stepPauseLifted(a.gate);
  await stepBorrowAgain(a.gate);
  assert.deepEqual(a.sent.at(-1)!.args, { amount: "31250000" });
  assert.deepEqual([less.poolDebt, a.detail("borrow_again").borrowed, a.detail("borrow_again").allowed], [31_250_000n, "31250000", "31250000"]);

  const none = chain({ verdicts: [verdict({ allow: { borrow: 0 }, sent: [NONCE] })] });
  const b = fakeGate(none);
  await stepPauseLifted(b.gate);
  assert.equal(b.step("pause_lifted").ok, true, "the pause lifted all the same");
  await stops(stepBorrowAgain(b.gate));
  assert.equal(b.detail("borrow_again").why, "the check allows no new loan. It said: ok true, state HEALTHY, action NONE, allow.borrow 0");
  assert.deepEqual([b.sent.filter((s) => s.method === "borrow").length, none.poolDebt], [0, 0n]);
});

test("50.2, borrow_again asks for a second check only when the first one's blocks ran out, or its result was used or replaced", async () => {
  // 110 blocks on: the result that lifted the pause has under 15 of its 120 left.
  const late = chain();
  const a = fakeGate(late);
  await stepPauseLifted(a.gate);
  late.block += 110;
  await stepBorrowAgain(a.gate);
  assert.deepEqual(a.sent.map((s) => s.method), ["request_check", "request_check", "borrow"]);
  assert.deepEqual([a.detail("borrow_again").checks_asked_here, a.logged.at(-1)], [1, "  the check result the account holds is 112 blocks old, and the account takes one for 120: one more check"]);
  assert.equal(late.poolDebt, 50n * USD);
  // The keeper's own check came in between: the held result answers a plain check, not a borrow.
  const replaced = chain();
  const b = fakeGate(replaced);
  await stepPauseLifted(b.gate);
  replaced.state.verdict = { intent: { check: {} }, received_block: replaced.block, verdict: verdict({ blk: replaced.block - 1, nonce: replaced.state.counter }) };
  await stepBorrowAgain(b.gate);
  assert.deepEqual(b.sent.map((s) => s.method), ["request_check", "request_check", "borrow"]);
  // 60 blocks on: still good, and no second check.
  const soon = chain();
  const d = fakeGate(soon);
  await stepPauseLifted(d.gate);
  soon.block += 60;
  await stepBorrowAgain(d.gate);
  assert.deepEqual(d.sent.map((s) => s.method), ["request_check", "borrow"]);
});

test("50.2, borrow_again fails when the pause is still on, when the pool refuses the loan, and when the loan doesn't reach the account", async () => {
  // Run out of order: the pause is on, and nothing is sent.
  const paused = chain();
  const a = fakeGate(paused);
  await stops(stepBorrowAgain(a.gate));
  assert.equal(a.detail("borrow_again").why, `the pause on borrowing is still on for ${ACCOUNT}: run from pause_lifted first`);
  assert.equal(a.sent.length, 0);

  const refused = chain({ poolRefuses: true });
  const b = fakeGate(refused);
  await stepPauseLifted(b.gate);
  await stops(stepBorrowAgain(b.gate));
  assert.deepEqual([b.detail("borrow_again").why, b.detail("borrow_again").logs], ["the pool refused the borrow", ["the pool refused the borrow: the daily lending budget"]]);

  const lost = chain({ loanLost: true });
  const k = fakeGate(lost);
  await stepPauseLifted(k.gate);
  const why = await stops(stepBorrowAgain(k.gate));
  assert.match(why, /^timed out after 30 s waiting for the loan of \$50\.00 to arrive in demo\.pbf\.testnet; last seen: the account held 430000000 micro-USDC \(430000000 before\) and owed the pool 50000000 \(0 before\)$/);
});

// ---------- the record ----------

const OLD_IDS = FUNDING_STEP_IDS.filter((id) => !["pause_lifted", "borrow_again", "repay_again"].includes(id));
const passed = (id: string): StepRecord => ({ id, label: id, ok: true, expect_fail: false, pass: true, started_utc: new Date(T0 - 3_600_000).toISOString(), seconds: 5, txs: [], gateway: [], detail: null });

test("50.2, a record written before the three steps existed still resumes: every step it has is kept, the three new ones run in their place, and the run can pass", async () => {
  // A run of before that stopped at the withdrawal: all of its steps up to `home`.
  const old = OLD_IDS.filter((id) => id !== "withdraw").map(passed);
  const kept = stepsBefore(old, FUNDING_STEP_IDS, "withdraw");
  assert.deepEqual(kept.map((s) => s.id), old.map((s) => s.id), "--from withdraw keeps everything the old record has");
  assert.equal(stepsPass([...kept, passed("withdraw")], FUNDING_STEP_IDS), false, "the gate doesn't pass until the three new steps have run");

  // The account is one made before the deploy: the three steps are skipped, and the gate passes with the withdrawal.
  const c = olderChain();
  const { gate, record } = fakeGate(c, kept);
  for (const id of FUNDING_CLOSE_OUT) {
    if (gate.runner.done(id)) continue;
    assert.ok(["pause_lifted", "borrow_again", "repay_again", "withdraw"].includes(id), `${id} runs again`);
    if (id in FUNDING_STEPS) await FUNDING_STEPS[id]!(gate);
    else record.steps.push(passed(id));
  }
  assert.deepEqual(record.steps.slice(-4).map((s) => s.id), ["pause_lifted", "borrow_again", "repay_again", "withdraw"]);
  assert.equal(stepsPass(record.steps, FUNDING_STEP_IDS), true);
  // Every step id of before is still one --from takes, and resuming a finished old record at a new step drops only the withdrawal.
  for (const id of ["create", "fund", "top_up", "repay", "close_short", "home", "withdraw"]) assert.ok(FUNDING_STEP_IDS.includes(id), id);
  assert.deepEqual(stepsBefore(OLD_IDS.map(passed), FUNDING_STEP_IDS, "pause_lifted").map((s) => s.id), OLD_IDS.filter((id) => id !== "withdraw"));
});

test("50.2, the gate's last line says whether the second loan was shown or skipped", () => {
  const base = "a Rhea loan and a pool loan, a fee and a subsidy, a top-up, and everything repaid and withdrawn";
  assert.equal(passWords([{ id: "borrow_again", detail: { borrowed: "50000000" } }]), `${base}; and after the USDC came home from Hyperliquid, a check lifted the pause and a second loan was borrowed and repaid`);
  assert.equal(passWords([{ id: "borrow_again", detail: { skipped: "an older account" } }]), `${base}. The second loan after the transfer home was skipped: the account was made before the pause could lift early`);
  assert.equal(passWords([]), `${base}. The second loan after the transfer home was skipped: the account was made before the pause could lift early`);
});
