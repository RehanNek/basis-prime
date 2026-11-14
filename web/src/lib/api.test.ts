// The paths the pages read. Runs with: pnpm --filter @pb/web test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MARKETS_PATH, marketsPath } from './api.ts';

test('a page that has an account asks for the markets as that account’s own gateway sees them (INTERFACES.md 42)', () => {
  // With the account, `band_bp` is the band its pinned gateway enforces: 3% at least on testnet for a new gateway,
  // the parameter file's band for an older one.
  assert.equal(marketsPath('alice.pbf.testnet'), '/api/markets?account=alice.pbf.testnet');
  // A page with no account keeps the plain path: the band a new account would get.
  assert.equal(marketsPath(null), '/api/markets');
  assert.equal(marketsPath(undefined), MARKETS_PATH);
  assert.equal(marketsPath(''), MARKETS_PATH);
  // The account goes in as one query value, whatever it holds.
  assert.equal(marketsPath('a&b=c.pbf.testnet'), '/api/markets?account=a%26b%3Dc.pbf.testnet');
});
