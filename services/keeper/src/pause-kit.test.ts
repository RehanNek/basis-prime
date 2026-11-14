// The short pause gate (pause-demo.ts; INTERFACES.md 50.2): its step list, its refusal on an account made before the
// deploy, its plan in words, what stands in its way, and its last line. The three lift steps themselves are tested in
// pause-steps.test.ts; this file runs them the way this gate does. Nothing here reaches a chain or Hyperliquid.
import assert from "node:assert/strict";
import { test } from "node:test";

import { needsLiftWords } from "./funding-kit.js";
import { stepBorrowAgain, stepPauseLifted, stepRepayAgain } from "./funding-steps.js";
import { planFor, stepsPass, type StepRecord } from "./hedge-kit.js";
import { STEPS } from "./hedge-steps.js";
import { ACCOUNT, chain, fakeGate, KEEPER, MUSDC, NONCE, olderChain, stops, T0, USD } from "./pause-fakes.js";
import { ACCOUNT_CODE_BEFORE_LIFT, describePauseGate, PAUSE_OWNER_NEAR, PAUSE_STEP_IDS, PAUSE_STEPS, pauseLeftovers, pausePassWords, pauseProblems, RISK_BEFORE_LIFT, type PauseFound } from "./pause-kit.js";

const NEW_CODE = "0c".repeat(32);
const NEW_RISK = "5e".repeat(32);

// ---------- the steps ----------

test("the pause gate's steps, in order: an account, USDC to Hyperliquid and straight back, the lift, a loan and its repayment, the withdrawal; no agent, order, lender or operator step", () => {
  assert.deepEqual([...PAUSE_STEP_IDS], ["create", "deposit", "hl_init", "to_hl", "home", "pause_lifted", "borrow_again", "repay_again", "withdraw"]);
  assert.deepEqual(Object.keys(PAUSE_STEPS), [...PAUSE_STEP_IDS], "each step has its function, and there is no other");
  // The steps that exist: hedge-demo's for the account, the two moves and the withdrawal, gate 2's three for the lift.
  assert.deepEqual(
    PAUSE_STEP_IDS.map((id) => PAUSE_STEPS[id]),
    [STEPS.create, STEPS.deposit, STEPS.hl_init, STEPS.to_hl, STEPS.home, stepPauseLifted, stepBorrowAgain, stepRepayAgain, STEPS.withdraw],
  );
  for (const id of ["agent", "approve", "short", "borrow", "close_short", "keeper", "order", "fund", "fee_policy", "price_drop", "repay_rhea"]) assert.ok(!PAUSE_STEP_IDS.includes(id), id);
  // The transfer home comes right before the lift, and nothing sits between the lift and the loan.
  assert.deepEqual(PAUSE_STEP_IDS.slice(PAUSE_STEP_IDS.indexOf("home"), PAUSE_STEP_IDS.indexOf("home") + 3), ["home", "pause_lifted", "borrow_again"]);
});

test("the pause gate doesn't pass on an account made before the deploy: pause_lifted fails and says so, nothing is sent, and the other two steps refuse it as well", async () => {
  const c = olderChain();
  const { gate, sent, asked, logged, record, detail, step } = fakeGate(c, [], { mustLift: true });
  await stops(PAUSE_STEPS.pause_lifted!(gate));
  const words = needsLiftWords(ACCOUNT);
  assert.equal(words, `${ACCOUNT} was made before the pause could lift early (its state shows no open_sends), so it keeps the 2 days and 1 hour. This gate proves the lift and can't pass on it: run it with a new --name once the factory makes accounts with the new code`);
  assert.deepEqual([step("pause_lifted").ok, step("pause_lifted").pass, detail("pause_lifted").why], [false, false, words]);
  assert.deepEqual([sent.length, asked.length, logged.length], [0, 0, 0], "no check, no read of Hyperliquid, and no line about skipping");
  assert.equal(stepsPass(record.steps, PAUSE_STEP_IDS), false);
  // Resumed past the lift, the loan and the repayment say the same and send nothing.
  await stops(PAUSE_STEPS.borrow_again!(gate));
  await stops(PAUSE_STEPS.repay_again!(gate));
  assert.deepEqual([detail("borrow_again").why, detail("repay_again").why, sent.length], [words, words, 0]);
  // Gate 2 runs the same three steps without this setting: there they are skipped, and pass.
  const gate2 = fakeGate(olderChain());
  await PAUSE_STEPS.pause_lifted!(gate2.gate);
  assert.deepEqual([gate2.step("pause_lifted").ok, typeof gate2.detail("pause_lifted").skipped], [true, "string"]);
});

test("on an account that shows open_sends the pause gate's lift, loan and repayment pass as they do in gate 2, and its last line says how soon after the USDC came home the loan arrived", async () => {
  const c = chain();
  // The home step ended 20 s before the lift starts; the transfer was signed 120 s before (the fake's nonce).
  const home: StepRecord = { id: "home", label: "home", ok: true, expect_fail: false, pass: true, started_utc: new Date(T0 - 100_000).toISOString(), seconds: 80, txs: [], gateway: [], detail: null };
  const { gate, sent, record } = fakeGate(c, [home], { mustLift: true });
  for (const id of ["pause_lifted", "borrow_again", "repay_again"]) await PAUSE_STEPS[id]!(gate);
  assert.deepEqual(sent.map((s) => s.method), ["request_check", "borrow", "repay"]);
  assert.deepEqual([c.poolDebt, c.state.loan.open, c.balances[`${MUSDC}:${ACCOUNT}`]], [0n, false, 430n * USD]);
  assert.equal(stepsPass(record.steps, ["home", "pause_lifted", "borrow_again", "repay_again"]), true);
  assert.equal(pausePassWords(record.steps, record.context), "1 check lifted the pause, and a loan of $50.00 from our pool arrived 20 s after the USDC came home from Hyperliquid (120 s after that transfer was signed). It was repaid, and both tokens were withdrawn");
  // Two checks, and a record with no home step to time from: the line still stands.
  assert.equal(
    pausePassWords([{ ...home, id: "borrow_again", detail: { borrowed: "31250000", seconds_since_home: null } }], { pause_lifted: { checks: 2, open_before: [] } }),
    "2 checks lifted the pause, and a loan of $31.25 from our pool arrived after the USDC came home from Hyperliquid. It was repaid, and both tokens were withdrawn",
  );
});

// ---------- the dry run ----------

const WORDS = { account: ACCOUNT, owner: KEEPER, apiUrl: "http://localhost:8788", shimUrl: "http://localhost:8787", plan: planFor("small", 68_000), recordFile: "research/data/pause_gate.json" };

test("the pause gate's dry run names its nine steps in order, what each sends and checks, and that an older account stops it at pause_lifted", () => {
  const lines = describePauseGate(WORDS);
  const at = PAUSE_STEP_IDS.map((id, i) => lines.findIndex((l) => l.startsWith(`${i + 1} ${id} `)));
  assert.ok(at.every((line, i) => line > 0 && (i === 0 || line === at[i - 1]! + 1)), `one line a step, in order: ${JSON.stringify(at)}`);
  assert.equal(lines[0], `account ${ACCOUNT}, owned by ${KEEPER}; backend http://localhost:8788; the 1Click stand-in http://localhost:8787`);
  assert.equal(lines[1], "the book: $440 of test USDC and 0.015 test nBTC (about $1,020 at BTC $68,000). $430 of the USDC goes to Hyperliquid and comes straight back. No hedge, no agent, no order, no lender, no operator call");
  const text = lines.join("\n");
  assert.ok(text.includes("hl_withdraw of what Hyperliquid shows as withdrawable less a cent"));
  assert.ok(text.includes("This is the transfer that starts the pause"));
  assert.ok(text.includes('request_check with {"borrow":{"amount":"50000000"}} (0.01 NEAR)'));
  assert.ok(text.includes('get_state().hl.send_open_until_ms is "0" and open_sends is empty'));
  assert.ok(text.includes("An account that shows no open_sends was made before the deploy: the step fails and says so"));
  assert.ok(text.includes("for $50 or what the result allows if that is less, with 1 yoctoNEAR"));
  assert.ok(text.includes("the record: research/data/pause_gate.json, saved after every step; --from <step> resumes from it"));
  assert.equal(lines.filter((l) => /Checks: /.test(l)).length, 9, "every step says what it checks");
  // The steps the other gates need and this one doesn't are not in it.
  for (const word of ["request_agent", "hl_approve_agent", "/api/order", "set_pricing", "set_funding", "lender_"]) assert.ok(!text.includes(word), word);
});

/** After the deploy, with everything running: a fresh name, the keeper's NEAR, the factory's new code and engine, the backend, the stand-in and the float. */
const READY: PauseFound = {
  account: ACCOUNT,
  accountExists: false,
  resuming: false,
  owner: KEEPER,
  ownerNear: 21.74,
  factoryPaused: false,
  accountCode: NEW_CODE,
  factoryRisk: NEW_RISK,
  apiUrl: "http://localhost:8788",
  backend: { hl_api: "https://api.hyperliquid-testnet.xyz" },
  shimUrl: "http://localhost:8787",
  standIn: true,
  floatUsdc: 5_120.5,
  toHlUsd: 430,
};

test("the pause gate's dry run: with everything in place nothing stands in the way, and each thing found is said in a line", () => {
  assert.deepEqual(pauseProblems(READY), {
    problems: [],
    lines: [
      `${ACCOUNT} doesn't exist yet: it will be made`,
      "the factory gives new accounts the code 0c0c0c0c…, not the one from before the deploy",
      "the factory pins pb-risk 5e5e5e5e…, not the one from before the deploy",
      `${KEEPER} holds 21.7400 NEAR`,
      "the backend answers, and talks to Hyperliquid testnet",
      "the 1Click stand-in answers",
      "the float holds 5120.50 USDC in perps on Hyperliquid: enough for the $430 the stand-in delivers",
    ],
  });
});

test("the pause gate's dry run before the deploy: the factory's account code and its engine are both the ones from before, and each is said with what comes first", () => {
  const { problems } = pauseProblems({ ...READY, accountCode: ACCOUNT_CODE_BEFORE_LIFT, factoryRisk: RISK_BEFORE_LIFT });
  assert.deepEqual(problems, [
    "the factory still gives new accounts the code from before the deploy (account_code_hash 79827e65…): a new account wouldn't show open_sends, and the gate would stop at pause_lifted. The factory's redeploy comes first",
    "the factory still pins the engine from before the deploy (pb-risk fb2cee3b…): its results name no transfer as sent, so no check would lift the pause. The factory's set_config with the new risk.version_key comes first",
  ]);
  // The two values are the factory's own of 13 Nov, the way back in research/send_pause_plan.md.
  assert.deepEqual([ACCOUNT_CODE_BEFORE_LIFT.slice(0, 8), RISK_BEFORE_LIFT.slice(0, 8), ACCOUNT_CODE_BEFORE_LIFT.length, RISK_BEFORE_LIFT.length], ["79827e65", "fb2cee3b", 64, 64]);
});

test("the pause gate's dry run catches each single thing out of place: the keeper's NEAR, the backend, the stand-in, the float, the factory, a used name, an older account", () => {
  const one = (change: Partial<PauseFound>) => {
    const { problems } = pauseProblems({ ...READY, ...change });
    assert.equal(problems.length, 1, JSON.stringify(problems));
    return problems[0]!;
  };
  assert.equal(PAUSE_OWNER_NEAR, 6.2);
  assert.match(one({ ownerNear: 6.19 }), /^pbf-keeper\.testnet holds 6\.19 NEAR: a new account takes 6, and the checks and gas about 0\.2 more\. Top it up from the testnet faucet$/);
  assert.match(one({ ownerNear: null }), /couldn't read pbf-keeper\.testnet's balance/);
  assert.equal(one({ backend: null }), "the backend at http://localhost:8788 doesn't answer: pnpm --filter @pb/api start");
  assert.match(one({ backend: { hl_api: "https://api.hyperliquid.xyz" } }), /not Hyperliquid testnet$/);
  assert.equal(one({ standIn: false }), "the 1Click stand-in at http://localhost:8787 doesn't answer GET /v0/tokens: pnpm --filter @pb/oneclick-shim start");
  assert.equal(one({ standIn: null }), one({ standIn: false }));
  assert.match(one({ floatUsdc: 430.5 }), /^the float holds 430\.50 USDC in perps on Hyperliquid, and the stand-in delivers the gate's \$430 from it/);
  assert.match(one({ floatUsdc: null }), /couldn't read the float/);
  // Going on from `home` or later, the move to Hyperliquid has run: a float that is short, or unread, stands in
  // nobody's way (14 Nov: the float was short because the stopped account itself held the USDC).
  const after = { accountExists: true, resuming: true, ownRisk: NEW_RISK, toHlDone: true };
  assert.deepEqual(pauseProblems({ ...READY, ...after, hl: { send_open_until_ms: "0", open_sends: [] }, floatUsdc: 355.25 }).problems, []);
  assert.deepEqual(pauseProblems({ ...READY, ...after, hl: { send_open_until_ms: "0", open_sends: [] }, floatUsdc: null }).problems, []);
  assert.equal(one({ factoryPaused: true }), "the factory is paused: it makes no account");
  assert.match(one({ accountCode: null }), /couldn't read the factory/);
  assert.match(one({ accountExists: null }), /couldn't read whether demo\.pbf\.testnet exists/);
  assert.match(one({ accountExists: true }), /exists already: the gate starts from a fresh account, so give a new --name \(or --from <step> to go on with this one\)$/);

  // Going on with an account (--from): its own state and its own pinned engine count, not the factory's.
  const resumed = { accountExists: true, resuming: true, ownRisk: NEW_RISK, accountCode: ACCOUNT_CODE_BEFORE_LIFT, factoryRisk: RISK_BEFORE_LIFT };
  const shows = pauseProblems({ ...READY, ...resumed, hl: { open_sends: [String(NONCE)], send_open_until_ms: "5" }, ownerNear: 0.5 });
  assert.deepEqual([shows.problems, shows.lines[0]], [[], `${ACCOUNT} exists and shows open_sends: resuming`]);
  assert.equal(one({ ...resumed, hl: { send_open_until_ms: "5" } }), needsLiftWords(ACCOUNT));
  assert.match(one({ ...resumed, hl: { open_sends: [] }, ownRisk: RISK_BEFORE_LIFT }), /pins the engine from before the deploy \(pb-risk fb2cee3b…\)/);
  assert.match(one({ ...resumed, hl: null }), /couldn't read demo\.pbf\.testnet's state/);
  assert.match(one({ ...resumed, hl: { open_sends: [] }, ownerNear: 0.1 }), /the checks \(0\.01 each\) and the gas take about 0\.2/);
  // Resumed before hl_init: the state has no Hyperliquid part to read yet, and that isn't held against it.
  assert.deepEqual(pauseProblems({ ...READY, ...resumed }).problems, []);
});

// ---------- a stopped run ----------

test("what a stopped pause gate leaves is said with the step that deals with it: a loan, the tokens; and it touches nothing of the float's", async () => {
  const c = chain();
  const { gate, sent } = fakeGate(c, [], { mustLift: true });
  await PAUSE_STEPS.pause_lifted!(gate);
  await PAUSE_STEPS.borrow_again!(gate);
  const before = sent.length;
  const lines = await pauseLeftovers(gate.world);
  assert.deepEqual(lines, [
    // The fake has no backend to read Hyperliquid through: the line says so and the rest still shows.
    `couldn't read ${ACCOUNT} on Hyperliquid`,
    `${ACCOUNT} owes our pool $50.00: --from repay_again repays it`,
    `${ACCOUNT} holds $480.00 of test USDC and 0.015 test nBTC: --from withdraw sends them back to ${KEEPER}`,
  ]);
  assert.equal(sent.length, before, "reads only");
});
