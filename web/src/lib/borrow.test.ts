// What an account can borrow now: W* against the pool's own limits (RISK_ENGINE.md 7.2, 12.2).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { belowLimit, borrowable } from './borrow.ts';
import { BORROWER, DEMO_BORROW, PARAMS, POOL } from './test-fixtures.ts';

const IN_FIRST_WEEK = 2000n * 1_000_000_000n;
const AFTER_FIRST_WEEK = BigInt(BORROWER.first_week_until) + 1n;

test("the demo's $24,150 verdict binds inside the first week's $25k", () => {
  const result = borrowable({ pool: POOL, params: PARAMS, borrower: BORROWER, verdict: DEMO_BORROW, nowNs: IN_FIRST_WEEK });
  assert.equal(result.binding.label, "the risk engine's answer");
  assert.equal(result.binding.source, 'verdict');
  assert.equal(result.binding.amount, 24_150_000_000n);
  assert.equal(result.max, belowLimit(24_150_000_000n));
  assert.equal(result.max, 24_147_584_998n, '0.01% plus 2 micro-USDC below');
  assert.ok(result.limits.some((l) => l.label === "a new account's first-week limit" && l.amount === 25_000_000_000n));
});

test("without a verdict, the pool's limits alone: the first-week limit, then, after the first week, the daily budget", () => {
  const first = borrowable({ pool: POOL, params: PARAMS, borrower: BORROWER, nowNs: IN_FIRST_WEEK });
  assert.equal(first.binding.label, "a new account's first-week limit");
  assert.equal(first.binding.source, 'pool');
  assert.equal(first.binding.amount, 25_000_000_000n);

  const later = borrowable({ pool: POOL, params: PARAMS, borrower: { ...BORROWER, debt: '5000000000' }, nowNs: AFTER_FIRST_WEEK });
  assert.equal(later.binding.label, "the pool's daily lending budget");
  assert.equal(later.binding.amount, 30_000_000_000n);
  assert.ok(!later.limits.some((l) => l.label.includes('first-week')), 'the first week is over');
});

test('a paused pool, a blocked account or an unregistered one can borrow nothing', () => {
  assert.equal(borrowable({ pool: { ...POOL, paused: true }, params: PARAMS, borrower: BORROWER, nowNs: IN_FIRST_WEEK }).binding.label, 'the pool is paused');
  assert.equal(borrowable({ pool: POOL, params: PARAMS, borrower: { ...BORROWER, blocked: true }, nowNs: IN_FIRST_WEEK }).max, 0n);
  const unregistered = borrowable({ pool: POOL, params: PARAMS, borrower: null, nowNs: IN_FIRST_WEEK });
  assert.equal(unregistered.binding.label, 'the account is not registered with the pool');
  assert.equal(unregistered.max, 0n);
});

test('limits already passed count as zero, never negative; lending in the last 24 hours uses up the budget', () => {
  const busy = { ...POOL, lent_24h: '29000000000', loans: '29000000000', cash: '271000000000' };
  const result = borrowable({ pool: busy, params: PARAMS, borrower: { ...BORROWER, debt: '26000000000' }, nowNs: IN_FIRST_WEEK });
  assert.equal(result.binding.label, "a new account's first-week limit");
  assert.equal(result.binding.amount, 0n);
  assert.equal(result.limits.find((l) => l.label === "the pool's daily lending budget")?.amount, 1_000_000_000n);
  assert.equal(belowLimit(0n), 0n);
});
