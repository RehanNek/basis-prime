// Runs with Node's own TypeScript support: pnpm --filter @pb/web test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ago, borrowEstimate, depegRoomBp, healthView, netWorth, positionWords, rateFor, ZONES } from './cockpit.ts';
import { APPENDIX_A, BORROWER, DEMO_BORROW, PARAMS, POOL } from './test-fixtures.ts';
import type { Token } from './types.ts';

test('no loan: nothing at risk, whatever the last verdict said', () => {
  const view = healthView({ ...APPENDIX_A, state: 'MARGIN_CALL' }, false);
  assert.equal(view.key, 'NO_LOAN');
  assert.equal(view.tone, 'neutral');
  assert.match(view.words, /Nothing is borrowed/);
});

test('a loan with no check yet asks for one and places no marker', () => {
  const view = healthView(null, true);
  assert.equal(view.key, 'UNKNOWN');
  assert.equal(view.marker, null);
});

test('Appendix A is safe, far from the line, and says how far nBTC could fall', () => {
  // (40,500 - 15,616) / 100,000 of nBTC = 24.9%: a depeg that size takes equity down to the safety buffer.
  assert.equal(depegRoomBp(APPENDIX_A), 2488);
  const view = healthView(APPENDIX_A, true);
  assert.equal(view.key, 'HEALTHY');
  assert.equal(view.label, 'Safe');
  assert.equal(view.words, 'Safe. nBTC could fall 25% against BTC before a margin call.');
  assert.ok(view.marker !== null && view.marker < 10, 'twice the initial requirement sits at the safe end');
});

test('without nBTC, the cushion is said in dollars', () => {
  const view = healthView({ ...APPENDIX_A, pool: {} }, true);
  assert.equal(view.words, 'Safe. Your equity is $24,884.00 above the safety line.');
});

test('the marker moves through the zones with the state', () => {
  const watch = healthView({ ...APPENDIX_A, state: 'WATCH', eq: 17_568_000_000 }, true);
  assert.equal(watch.tone, 'warn');
  assert.ok(watch.marker! > ZONES.watch && watch.marker! < ZONES.call);
  assert.ok(Math.abs(watch.marker! - 60) < 0.5, 'halfway between the buffer and the requirement is halfway across Watch');

  const call = healthView({ ...APPENDIX_A, state: 'MARGIN_CALL', eq: 14_000_000_000 }, true);
  assert.ok(call.marker! > ZONES.call && call.marker! < ZONES.unwind);
  assert.match(call.words, /within 4 hours/);

  assert.ok(healthView({ ...APPENDIX_A, state: 'DELEVERAGE' }, true).marker! > ZONES.unwind);
  assert.equal(healthView({ ...APPENDIX_A, state: 'DEFAULT' }, true).label, 'Defaulted');
});

const IN_FIRST_WEEK = 2_000n * 10n ** 9n;

test("a fresh, unused borrow verdict is the engine's own answer, below the pool's limits", () => {
  const estimate = borrowEstimate({ pool: POOL, params: PARAMS, borrower: BORROWER, verdict: DEMO_BORROW, live: true, debt: 0n, nowNs: IN_FIRST_WEEK });
  assert.equal(estimate.basis, 'engine');
  assert.equal(estimate.amount, 24_150_000_000n - 2_415_000n - 2n);
});

test("an older verdict's line less today's debt, capped by the pool's first-week limit", () => {
  const estimate = borrowEstimate({ pool: POOL, params: PARAMS, borrower: BORROWER, verdict: APPENDIX_A, live: false, debt: 0n, nowNs: IN_FIRST_WEEK });
  assert.equal(estimate.basis, 'pool');
  assert.equal(estimate.amount, 25_000_000_000n - 2_500_000n - 2n);
  assert.equal(estimate.why, "Set by a new account's first-week limit");

  const afterWeek = borrowEstimate({ pool: POOL, params: PARAMS, borrower: BORROWER, verdict: DEMO_BORROW, live: false, debt: 10_000_000_000n, nowNs: 10n ** 18n });
  assert.equal(afterWeek.basis, 'line');
  assert.equal(afterWeek.amount, 14_150_000_000n - 1_415_000n - 2n);
});

test('no verdict: no number yet; an unsafe account: nothing more', () => {
  assert.equal(borrowEstimate({ pool: POOL, params: PARAMS, borrower: BORROWER, verdict: null, live: false, debt: 0n, nowNs: IN_FIRST_WEEK }).amount, null);
  const watch = borrowEstimate({ pool: POOL, params: PARAMS, borrower: BORROWER, verdict: { ...DEMO_BORROW, state: 'WATCH' }, live: true, debt: 0n, nowNs: IN_FIRST_WEEK });
  assert.equal(watch.amount, 0n);
});

test("the tier's rate, Standard when the pool doesn't know the account yet", () => {
  assert.equal(rateFor(POOL, 'PREFERRED'), 100);
  assert.equal(rateFor(POOL, undefined), 200);
});

const TOKENS: Token[] = [
  { id: 'musdc.pbf-ops.testnet', symbol: 'USDC', label: 'mUSDC', decimals: 6 },
  { id: 'mnbtc.pbf-ops.testnet', symbol: 'nBTC', label: 'mNBTC', decimals: 8 },
];

test('net worth: the tokens at today\'s prices, plus Hyperliquid, less the loan', () => {
  const balances = [
    { token: TOKENS[0]!.id, symbol: 'USDC', decimals: 6, amount: '10000000' },
    { token: TOKENS[1]!.id, symbol: 'nBTC', decimals: 8, amount: '1500000' },
  ];
  const worth = netWorth({ balances, tokens: TOKENS, prices: { USDC: 1, nBTC: 76_000 }, hlEquity: 428, debt: 1_090_000_000n });
  assert.equal(worth.onNear, 1_150);
  assert.equal(worth.total, 488);
  // A missing price leaves the total unknown rather than wrong.
  assert.equal(netWorth({ balances, tokens: TOKENS, prices: { USDC: 1 }, hlEquity: 428, debt: 0n }).total, null);
  assert.equal(netWorth({ balances, tokens: TOKENS, prices: { USDC: 1, nBTC: 76_000 }, hlEquity: null, debt: 0n }).total, null);
});

test('net worth counts what is posted with a lender, against the whole loan', () => {
  // $380 of bitcoin posted with Rhea has left the account's own balance; the debt is our pool's $800 plus Rhea's $192.53.
  const balances = [
    { token: TOKENS[0]!.id, symbol: 'USDC', decimals: 6, amount: '10000000' },
    { token: TOKENS[1]!.id, symbol: 'nBTC', decimals: 8, amount: '1000000' },
  ];
  const worth = netWorth({ balances, tokens: TOKENS, prices: { USDC: 1, nBTC: 76_000 }, hlEquity: 428, debt: 992_530_000n, atLenders: 380 });
  assert.equal(worth.onNear, 770);
  assert.equal(Math.round(worth.total! * 100), 58_547);
});

test('positions and times in words', () => {
  assert.deepEqual(
    positionWords([
      { coin: 'ETH', side: 'long', size: 0.1, value: 300 },
      { coin: 'BTC', side: 'short', size: 0.015, value: 1_140 },
    ]),
    ['Short 0.015 BTC', 'Long 0.1 ETH'],
  );
  const now = 10_000_000;
  assert.equal(ago(now - 10_000, now), 'just now');
  assert.equal(ago(now - 4 * 60_000, now), '4 min ago');
  assert.equal(ago(now - 3 * 3_600_000, now), '3 h ago');
  assert.equal(ago(now - 2 * 86_400_000, now), '2 days ago');
});
