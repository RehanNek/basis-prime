// Amounts, names and the backend client's errors.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { api, ApiError, accountPath, statusPath } from './api.ts';
import { accountIdFor, isAccountId, nameProblem } from './names.ts';
import { displayUnits, formatBp, formatDollars, formatUnits, formatUsd, nearToYocto, parseUnits } from './units.ts';

test('typed amounts become exact token units, and back', () => {
  assert.equal(parseUnits('24150', 6), '24150000000');
  assert.equal(parseUnits('0.25', 8), '25000000');
  assert.equal(parseUnits('1,000.5', 6), '1000500000');
  assert.equal(parseUnits('.5', 6), '500000');
  assert.equal(parseUnits('5.', 6), '5000000');
  assert.throws(() => parseUnits('0.0000001', 6), /At most 6 decimal places/);
  assert.throws(() => parseUnits('-1', 6), /Enter an amount/);
  assert.throws(() => parseUnits('', 6), /Enter an amount/);
  assert.throws(() => parseUnits('1e5', 6), /Enter an amount/);
  assert.equal(formatUnits('24150000000', 6), '24150');
  assert.equal(formatUnits('25000000', 8), '0.25');
  assert.equal(formatUnits(-1500000n, 6), '-1.5');
  assert.equal(nearToYocto('4'), '4000000000000000000000000');
});

test('amounts for reading: grouped, rounded down; dollars from micro-USD; basis points', () => {
  assert.equal(displayUnits('24150250000', 6), '24,150.25');
  assert.equal(displayUnits('123456789', 8, 4), '1.2345');
  assert.equal(displayUnits('0', 6), '0');
  assert.equal(formatUsd(24_150_000_000), '$24,150.00');
  assert.equal(formatUsd('1234567'), '$1.23');
  assert.equal(formatUsd(-5_000_000), '-$5.00');
  assert.equal(formatUsd(Number.NaN), '?');
  assert.equal(formatBp(650), '6.50%');
  assert.equal(formatDollars(-11.6), '-$11.60', "Hyperliquid's own numbers, the sign before the dollar");
  assert.equal(formatDollars(25011.6), '$25,011.60');
  assert.equal(formatDollars(null), '?');
});

test('client account names: one part of an account id, and the whole id within 64 characters', () => {
  assert.equal(accountIdFor('alice', 'pbf.testnet'), 'alice.pbf.testnet');
  assert.equal(nameProblem('alice', 'pbf.testnet'), null);
  assert.equal(nameProblem('my-fund_2', 'pbf.testnet'), null);
  assert.match(nameProblem('', 'pbf.testnet')!, /Pick a name/);
  assert.match(nameProblem('a.b', 'pbf.testnet')!, /No dots/);
  assert.match(nameProblem('Alice', 'pbf.testnet')!, /lowercase/);
  assert.match(nameProblem('-alice', 'pbf.testnet')!, /lowercase/);
  assert.match(nameProblem('a'.repeat(53), 'pbf.testnet')!, /Too long/);
  assert.equal(nameProblem('a'.repeat(52), 'pbf.testnet'), null);

  assert.ok(isAccountId('alice.testnet') && !isAccountId('alice testnet') && !isAccountId('x'));
});

test('the backend client: paths, its own errors, and a backend that is not running', async () => {
  assert.equal(accountPath('alice.pbf.testnet'), '/api/account/alice.pbf.testnet');
  assert.equal(statusPath('abc', 'm 1'), '/api/status?depositAddress=abc&depositMemo=m+1');
  assert.equal(statusPath('abc'), '/api/status?depositAddress=abc');

  const answer = (status: number, body: string) => (async () => new Response(body, { status })) as typeof fetch;
  assert.deepEqual(await api('/api/pool', undefined, answer(200, '{"deployed":false}')), { deployed: false });

  await assert.rejects(api('/api/preview', undefined, answer(404, '{"error":"not_deployed","message":"no contract yet"}')), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'not_deployed');
    assert.equal(error.message, 'no contract yet');
    return true;
  });
  await assert.rejects(api('/api/pool', undefined, answer(500, 'Internal Server Error')), (error: unknown) => {
    assert.ok(error instanceof ApiError && error.code === 'backend_down');
    assert.match(error.message, /pnpm --filter @pb\/api start/);
    return true;
  });
});
