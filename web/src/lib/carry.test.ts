// Rhea alone, and the carry of the hedged book (PLAN.md 5.8, Borrow page).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RheaAnswer } from './api.ts';
import { carry, RHEA, rheaAlone, rheaTerms } from './carry.ts';

test("Rhea alone lends 76% of the nBTC (0.80 x 0.95, research/rhea.md 4)", () => {
  assert.equal(RHEA.nbtcLtvBp, 7_600);
  assert.equal(rheaAlone(25_000_000_000n), 19_000_000_000n, '$25k of nBTC: $19k');
});

test('the carry: a short earns positive funding, a long pays it, and the loan costs its rate', () => {
  // The demo book: a $25k BTC short at testnet's 0.0041% an hour (research/day1.md 12), a $24,150 loan at 6.5%.
  const c = carry({ positions: [{ coin: 'BTC', side: 'short', value: 25_000 }], fundingHourly: { BTC: 0.000041 }, debtUsd: 24_150, rateBp: 650 });
  assert.equal(Math.round(c.fundingYearUsd), 8_979);
  assert.equal(Math.round(c.interestYearUsd), 1_570);
  assert.equal(Math.round(c.netYearUsd), 7_409);
  const long = carry({ positions: [{ coin: 'ETH', side: 'long', value: 1_000 }, { coin: 'SOL', side: 'short', value: 1 }], fundingHourly: { ETH: 0.0001 }, debtUsd: 0, rateBp: 0 });
  assert.equal(Math.round(long.fundingYearUsd), -876);
  assert.deepEqual(long.missing, ['SOL']);
});

/** GET /api/rhea as it answered on 9 Nov (block 223,738,912), nBTC and USDC only. */
const LIVE: RheaAnswer = {
  contract: 'contract.main.burrow.near',
  network: 'mainnet',
  view: 'get_assets',
  rpc: 'free.rpc.fastnear.com',
  block_height: 223_738_912,
  read_at_ms: Date.UTC(2026, 10, 9, 8, 0),
  age_s: 0,
  stale: false,
  usdc: { token_id: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', volatility_bp: 9_500, borrow_apr_bp: 1_588, supply_apr_bp: 1_030 },
  tokens: [{ token: 'nBTC', token_id: 'nbtc.bridge.near', listed: true, volatility_bp: 8_000, collateral: true, can_borrow: true, borrow_apr_bp: 201, supply_apr_bp: 49, ltv_bp: 7_600 }],
};

test("Rhea's terms come live from /api/rhea, and the 3 Nov figures stand in when it doesn't answer, saying so", () => {
  const live = rheaTerms(LIVE, LIVE.read_at_ms + 3 * 60_000);
  assert.deepEqual([live.source, live.nbtcLtvBp, live.usdcBorrowBp], ['live', 7_600, 1_588]);
  assert.match(live.words, /contract\.main\.burrow\.near at block 223,738,912, read 3 min ago\. Its LTV for nBTC is 0\.80 x 0\.95\./);
  assert.match(rheaTerms({ ...LIVE, stale: true }, LIVE.read_at_ms).words, /read just now \(the last read that worked/);
  const fallback = rheaTerms(undefined, 0);
  assert.deepEqual([fallback.source, fallback.nbtcLtvBp, fallback.usdcBorrowBp], ['3 Nov', 7_600, 1_738]);
  assert.match(fallback.words, /on 3 Nov 2026 \(research\/rhea\.md\), because its live terms couldn't be read/);
  assert.equal(rheaTerms({ ...LIVE, tokens: [] }, 0).source, '3 Nov', 'no nBTC terms: the fallback');
  assert.equal(rheaAlone(25_000_000_000n, 7_000), 17_500_000_000n);
});
