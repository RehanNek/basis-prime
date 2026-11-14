// The funding plan as the keeper runs it, in words (FUNDING.md 4.3; INTERFACES.md 25).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fundingPlanView, nsToMs, pendingLender, planLends, planRunning, stepWords } from './fund.ts';
import type { FundingState, FundingStep } from './types.ts';

const TOKENS = [
  { id: 'musdc.pbf-ops.testnet', symbol: 'USDC', label: 'mUSDC', decimals: 6 },
  { id: 'mnbtc.pbf-ops.testnet', symbol: 'nBTC', label: 'mNBTC', decimals: 8 },
];

const STORED_MS = 1_794_000_000_000;
const MINUTE = 60_000;

/** INTERFACES.md 25's example: post nBTC with Rhea, borrow from Rhea, then from our pool. Stored at STORED_MS. */
const plan = (done: boolean[]): FundingState => ({
  pid: 'f276800123',
  amount: '94500000000',
  stored_at: `${STORED_MS}000000`,
  expires_at: `${STORED_MS + 30 * MINUTE}000000`,
  steps: [
    { k: 'l_supply', l: 'rhea', tok: 'mnbtc.pbf-ops.testnet', amt: '131000000', done: done[0] },
    { k: 'l_borrow', l: 'rhea', amt: 50_667_000_000, done: done[1] },
    { k: 'p_borrow', amt: 43_833_000_000, done: done[2] },
  ],
});

test('each kind of step is said in plain words, with dollars and token amounts', () => {
  const say = (step: FundingStep) => stepWords(step, TOKENS);
  assert.equal(say({ k: 'p_borrow', amt: 43_833_000_000 }), 'Borrow up to $43,833.00 from our pool');
  assert.equal(say({ k: 'l_supply', l: 'rhea', tok: 'mnbtc.pbf-ops.testnet', amt: '131000000' }), 'Post 1.31 nBTC with Rhea, to borrow against');
  assert.equal(say({ k: 'l_borrow', l: 'rhea', amt: '50667000000' }), 'Borrow up to $50,667.00 from Rhea');
  assert.equal(say({ k: 'l_borrow', l: 'aave', amt: 56_667_000_000 }), 'Borrow up to $56,667.00 from Aave');
  assert.equal(say({ k: 'to_evm', tok: 'mnbtc.pbf-ops.testnet', amt: '75000000' }), 'Move 0.75 nBTC to the account’s own Ethereum address, through 1Click');
  assert.equal(say({ k: 'e_home', amt: 56_667_000_000 }), 'Bring $56,667.00 of USDC home to NEAR, through 1Click');
  assert.equal(say({ k: 'l_repay', l: 'rhea', amt: 10_133_000_000 }), 'Repay $10,133.00 to Rhea');
  assert.equal(say({ k: 'l_add', l: 'rhea', tok: 'mnbtc.pbf-ops.testnet', amt: '5000000' }), 'Add 0.05 nBTC to what is posted with Rhea');
  // A token on another chain that this page has no reading of (on Aave's test market it may be ether), and a kind it doesn't know.
  assert.equal(say({ k: 'l_supply', l: 'aave', tok: '0x54114591963CF60EF3aA63bEfD6eC263D98145a4', amt: '75000000' }), 'Post collateral with Aave, to borrow against');
  assert.equal(say({ k: 'later' }), 'A step this page doesn’t know (later)');
});

test('a fresh plan waits on its first step, and the keeper’s turn is said', () => {
  const view = fundingPlanView(plan([false, false, false]), STORED_MS + MINUTE, { tokens: TOKENS })!;
  assert.equal(view.status, 'running');
  assert.equal(view.headline, 'Your $94,500.00 loan is on its way: step 1 of 3.');
  assert.equal(view.detail, 'The keeper runs the steps in order, and you approve nothing more. The plan lasts 30 minutes: about 29 minutes left.');
  assert.deepEqual(view.steps.map((s) => s.mark), ['busy', 'todo', 'todo']);
  assert.equal(view.steps[0]!.how, 'The keeper is running it now.');
  assert.equal(view.steps[1]!.how, null);
  assert.equal(view.show, true);
  assert.equal(planRunning(plan([false, false, false]), STORED_MS + MINUTE), true);
});

test('steps go from waiting to done in order, and a loan step waits for a fresh check', () => {
  const view = fundingPlanView(plan([true, false, false]), STORED_MS + 2 * MINUTE, { tokens: TOKENS })!;
  assert.deepEqual(view.steps.map((s) => [s.mark, s.what]), [
    ['done', 'Post 1.31 nBTC with Rhea, to borrow against'],
    ['busy', 'Borrow up to $50,667.00 from Rhea'],
    ['todo', 'Borrow up to $43,833.00 from our pool'],
  ]);
  assert.equal(view.headline, 'Your $94,500.00 loan is on its way: step 2 of 3.');
  assert.equal(view.steps[1]!.how, 'The keeper asks the risk engine for a fresh check, then borrows what it allows.');
});

test('a Rhea borrow that is still finishing keeps its step spinning, and the next one waits for it', () => {
  const pending = [{ lender: { lender: 'rhea', kind: 'borrow', amount: '50667000000', until_block: 276_800_150 } }];
  const view = fundingPlanView(plan([true, true, false]), STORED_MS + 3 * MINUTE, { tokens: TOKENS, pending })!;
  assert.deepEqual(view.steps.map((s) => s.mark), ['done', 'busy', 'busy']);
  assert.equal(view.steps[1]!.how, 'Rhea is finishing it: a few seconds more.');
  assert.equal(view.steps[2]!.how, 'Waiting for Rhea to finish the step before.');
  // The account drops the entry only at its next call: once its last block has passed, the borrow counts as done.
  assert.deepEqual(fundingPlanView(plan([true, true, false]), STORED_MS + 3 * MINUTE, { tokens: TOKENS, pending, height: 276_800_150 })!.steps.map((s) => s.mark), ['done', 'busy', 'busy']);
  assert.deepEqual(fundingPlanView(plan([true, true, false]), STORED_MS + 3 * MINUTE, { tokens: TOKENS, pending, height: 276_800_151 })!.steps.map((s) => s.mark), ['done', 'done', 'busy']);
  // Once the account drops the pending action, the borrow is done and the pool's step is the keeper's.
  const after = fundingPlanView(plan([true, true, false]), STORED_MS + 3 * MINUTE, { tokens: TOKENS, pending: [] })!;
  assert.deepEqual(after.steps.map((s) => s.mark), ['done', 'done', 'busy']);
});

test('a plan whose every step has run is done, and stays in view until its 30 minutes are over', () => {
  const view = fundingPlanView(plan([true, true, true]), STORED_MS + 5 * MINUTE)!;
  assert.equal(view.status, 'done');
  assert.equal(view.headline, 'Every step of your $94,500.00 loan has run.');
  assert.deepEqual(view.steps.map((s) => s.mark), ['done', 'done', 'done']);
  assert.equal(view.show, true);
  assert.equal(fundingPlanView(plan([true, true, true]), STORED_MS + 31 * MINUTE)!.show, false);
  assert.equal(planRunning(plan([true, true, true]), STORED_MS + 5 * MINUTE), false);
});

test('a plan that runs out of time says so, marks the step that didn’t run, and stays in view to be dropped', () => {
  const view = fundingPlanView(plan([true, false, false]), STORED_MS + 31 * MINUTE, { tokens: TOKENS })!;
  assert.equal(view.status, 'expired');
  assert.equal(view.headline, 'This plan ran out of time with 2 of its 3 steps still to run.');
  assert.match(view.detail, /^Nothing more of it will run\. The steps that ran stay as they are/);
  assert.deepEqual(view.steps.map((s) => s.mark), ['done', 'failed', 'todo']);
  assert.equal(view.steps[1]!.how, 'It didn’t run before the plan’s 30 minutes were over.');
  assert.equal(view.minutesLeft, 0);
  assert.equal(view.show, true);
  // fund() takes a new plan once the old one has expired, so it no longer counts as running.
  assert.equal(planRunning(plan([true, false, false]), STORED_MS + 31 * MINUTE), false);
});

test('the loan is what the steps borrow in all, when the check lent less than was asked', () => {
  // Asked for $2,000; the check's steps borrow $577.60 from Rhea and $527.00 from our pool.
  const less: FundingState = {
    ...plan([false, false, false]),
    amount: '2000000000',
    steps: [{ k: 'l_supply', l: 'rhea', tok: 'mnbtc.pbf-ops.testnet', amt: '1500000' }, { k: 'l_borrow', l: 'rhea', amt: 577_600_000 }, { k: 'p_borrow', amt: '527000000' }],
  };
  assert.equal(planLends(less), 1_104_600_000n);
  assert.equal(fundingPlanView(less, STORED_MS + MINUTE)!.headline, 'Your $1,104.60 loan is on its way: step 1 of 3.');
  assert.equal(planLends(plan([true, true, true])), 94_500_000_000n);
});

const WBTC = '0x54114591963CF60EF3aA63bEfD6eC263D98145a4';
const WITH_WBTC = [...TOKENS, { id: WBTC, symbol: 'WBTC', label: 'WBTC', decimals: 8 }];

/** A `fund` answer with Aave (INTERFACES.md 33): post WBTC at Aave, borrow there, then from our pool. */
const aavePlan = (done: boolean[]): FundingState => ({
  pid: 'f276800123',
  amount: '945000000',
  stored_at: `${STORED_MS}000000`,
  expires_at: `${STORED_MS + 30 * MINUTE}000000`,
  steps: [
    { k: 'l_supply', l: 'aave', tok: WBTC.toLowerCase(), amt: '1500000', done: done[0] },
    { k: 'l_borrow', l: 'aave', amt: 566_670_000, done: done[1] },
    { k: 'p_borrow', amt: 378_330_000, done: done[2] },
  ],
});
const signed = (entries: [number, string][]) => new Map(entries.map(([i, status]) => [`f276800123:${i}`, { hash: `0xhash${i}`, status }]));
const marks = (done: boolean[], entries: [number, string][], at = 2 * MINUTE) => fundingPlanView(aavePlan(done), STORED_MS + at, { tokens: WITH_WBTC, signed: signed(entries) })!;

test('a step at Aave names its token by its address on that chain, whatever the case', () => {
  assert.equal(stepWords({ k: 'l_supply', l: 'aave', tok: WBTC.toLowerCase(), amt: '1500000' }, WITH_WBTC), 'Post 0.015 WBTC with Aave, to borrow against');
});

test('a step at Aave goes from waiting to signing, signed, sent and mined, and the next step waits for the mining', () => {
  // Started, and the signature hasn't come back yet.
  const signing = marks([true, false, false], []);
  assert.deepEqual(signing.steps.map((s) => s.mark), ['busy', 'todo', 'todo']);
  assert.equal(signing.steps[0]!.how, 'Signing: Chain Signatures sign it for the account, usually in 8 to 20 seconds.');
  assert.equal(signing.steps[1]!.how, 'Waiting: it runs once the step before is mined on Base Sepolia.');
  // Signed, then sent: still not done, with the transaction to link to.
  const isSigned = marks([true, false, false], [[0, 'signed']]);
  assert.equal(isSigned.steps[0]!.how, 'Signed, not mined yet: it waits to be sent to Base Sepolia.');
  assert.deepEqual(isSigned.steps[0]!.tx, { hash: '0xhash0', status: 'signed' });
  assert.equal(marks([true, false, false], [[0, 'sent']]).steps[0]!.how, 'Sent to Base Sepolia, not mined yet.');
  // Mined: done, and the borrow is the keeper's turn.
  const mined = marks([true, false, false], [[0, 'mined']]);
  assert.deepEqual(mined.steps.map((s) => s.mark), ['done', 'busy', 'todo']);
  assert.equal(mined.steps[0]!.how, 'Mined on Base Sepolia.');
  assert.equal(mined.steps[1]!.how, 'The keeper asks the risk engine for a fresh check, then has the account sign the borrow and sends it to Base Sepolia.');
});

test('a borrow at Aave that is signed but not mined says so, and says the loan already counts', () => {
  const view = marks([true, true, false], [[0, 'mined'], [1, 'signed']]);
  assert.deepEqual(view.steps.map((s) => s.mark), ['done', 'busy', 'todo']);
  assert.equal(view.steps[1]!.how, 'Signed, not mined yet: it waits to be sent to Base Sepolia. The loan already counts: a signed transaction never expires, and anyone can send it.');
  assert.equal(marks([true, true, false], [[0, 'mined'], [1, 'sent']]).steps[1]!.how, 'Sent to Base Sepolia, not mined yet. The loan already counts: a signed transaction never expires, and anyone can send it.');
  // Our pool's step waits for it.
  assert.equal(view.steps[2]!.how, 'Waiting: it runs once the step before is mined on Base Sepolia.');
  // The step under way is the borrow, not the one after it.
  assert.equal(view.headline, 'Your $945.00 loan is on its way: step 2 of 3.');
});

test('a plan whose last step is at Aave is done only once that step is mined', () => {
  // The order with our pool first: the Aave borrow is the last step.
  const last: FundingState = { ...aavePlan([]), steps: [{ k: 'p_borrow', amt: 378_330_000, done: true }, { k: 'l_borrow', l: 'aave', amt: 566_670_000, done: true }] };
  const view = (status: string, at = 2 * MINUTE) => fundingPlanView(last, STORED_MS + at, { signed: new Map([['f276800123:1', { hash: '0xb', status }]]) })!;
  assert.equal(view('sent').status, 'running');
  assert.equal(view('sent').headline, 'Your $945.00 loan is on its way: its last step is waiting to be mined on Base Sepolia.');
  // Even after the plan's 30 minutes: a signed transaction can still be sent.
  assert.equal(view('signed', 31 * MINUTE).status, 'running');
  assert.equal(view('mined').status, 'done');
  assert.equal(view('mined').headline, 'Every step of your $945.00 loan has run.');
});

test('a step that Base Sepolia mined and reverted is marked failed, and the plan says a step failed', () => {
  const view = marks([true, true, true], [[0, 'mined'], [1, 'failed']]);
  assert.deepEqual(view.steps.map((s) => s.mark), ['done', 'failed', 'done']);
  assert.equal(view.steps[1]!.how, 'Base Sepolia mined it, but it failed there, so nothing moved.');
  assert.equal(view.headline, 'A step of your $945.00 loan failed on Base Sepolia: nothing moved in it.');
});

test('a step signed again with a higher fee whose earlier signing was mined is over, and the next step runs', () => {
  // The backend says `replaced`: the chain used the nonce for the other signing of the same call.
  const view = marks([true, false, false], [[0, 'replaced']]);
  assert.deepEqual(view.steps.map((s) => s.mark), ['done', 'busy', 'todo']);
  assert.equal(view.steps[0]!.how, 'Base Sepolia mined an earlier signing of this step, so this later one never will be.');
  assert.deepEqual(view.steps[0]!.tx, { hash: '0xhash0', status: 'replaced' });
  assert.equal(view.headline, 'Your $945.00 loan is on its way: step 2 of 3.');
});

test('with no reading of the signed transactions, a started step at Aave counts as done, as at Rhea', () => {
  const view = fundingPlanView(aavePlan([true, true, false]), STORED_MS + MINUTE, { tokens: WITH_WBTC })!;
  assert.deepEqual(view.steps.map((s) => s.mark), ['done', 'done', 'busy']);
  // Aave's pending action has no last block, so it doesn't count as "Rhea is finishing".
  const pending = [{ lender: { lender: 'aave', kind: 'borrow', amount: '566670000', evm_nonce: 1 } }];
  assert.deepEqual(fundingPlanView(aavePlan([true, true, false]), STORED_MS + MINUTE, { tokens: WITH_WBTC, pending })!.steps.map((s) => s.mark), ['done', 'done', 'busy']);
});

test('the last minute reads as one minute, not none', () => {
  const view = fundingPlanView(plan([false, false, false]), STORED_MS + 30 * MINUTE - 5_000)!;
  assert.equal(view.minutesLeft, 1);
  assert.match(view.detail, /about 1 minute left\.$/);
});

test('an account with no plan shows nothing', () => {
  assert.equal(fundingPlanView(null, STORED_MS), null);
  assert.equal(fundingPlanView(undefined, STORED_MS), null);
  assert.equal(fundingPlanView({ ...plan([]), steps: [] }, STORED_MS), null);
  assert.equal(planRunning(null, STORED_MS), false);
});

test('the account’s pending lender action is read from the list, or from an object', () => {
  const entry = { lender: 'rhea', kind: 'borrow', amount: '50667000000', until_block: 123 };
  assert.deepEqual(pendingLender([{ transfer: { id: 'move:1' } }, { lender: entry }]), { ...entry, evm_nonce: null });
  assert.deepEqual(pendingLender({ lender: entry }), { ...entry, evm_nonce: null });
  // Aave's has no last block: it counts until the chain has used its nonce (INTERFACES.md 33).
  assert.deepEqual(pendingLender([{ lender: { lender: 'aave', kind: 'borrow', amount: '323000000', token: '0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f', evm_nonce: 2 } }]), {
    lender: 'aave', kind: 'borrow', amount: '323000000', until_block: null, evm_nonce: 2,
  });
  assert.equal(pendingLender([{ transfer: { id: 'move:1' } }]), null);
  assert.equal(pendingLender(undefined), null);
});

test('block times in nanoseconds read as milliseconds', () => {
  assert.equal(nsToMs('1794000000000000000'), 1_794_000_000_000);
  assert.equal(nsToMs('not a time'), 0);
  assert.equal(nsToMs(undefined), 0);
});
