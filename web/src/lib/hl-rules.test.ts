// Hyperliquid's tick and lot rules (for-developers/api/tick-and-lot-size), with the docs' own examples.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bandFloorWords, bandPercent, bandProblem, decText, isValidPrice, parseDec, priceBand, roundOrder, roundPrice, roundSize, showPrice } from './hl-rules.ts';

const dec = (text: string) => parseDec(text)!;
const price = (text: string, sz: number, mode: 'down' | 'up' = 'down') => decText(roundPrice(dec(text), sz, mode));

test("the docs' examples: 5 significant figures, 6 - szDecimals decimals, integers always", () => {
  assert.ok(isValidPrice(dec('1234.5'), 0));
  assert.ok(!isValidPrice(dec('1234.56'), 0));
  assert.ok(isValidPrice(dec('0.001234'), 0));
  assert.ok(!isValidPrice(dec('0.0012345'), 0));
  assert.ok(isValidPrice(dec('0.01234'), 1));
  assert.ok(!isValidPrice(dec('0.012345'), 1));
  assert.ok(isValidPrice(dec('123456'), 0), 'an integer price is valid however many figures it has');
  assert.ok(!isValidPrice(dec('12345.6'), 0));
  assert.ok(isValidPrice(dec('74500.000'), 5), 'trailing zeros are not figures');
  assert.ok(!isValidPrice(dec('0'), 0));
});

test('prices round the safe way: a buy down, a sell up, never worse than typed', () => {
  assert.equal(price('75824.6', 5, 'down'), '75824', 'BTC (szDecimals 5) prices are whole numbers here');
  assert.equal(price('75824.6', 5, 'up'), '75825');
  assert.equal(price('2246.15', 4, 'down'), '2246.1', 'ETH: 4 integer digits leave one decimal');
  assert.equal(price('89.4375', 2, 'up'), '89.438');
  assert.equal(price('0.0049185', 0, 'down'), '0.004918', 'kPEPE: at most 6 decimals');
  assert.equal(price('9.99996', 0, 'up'), '10', 'rounding up across a power of ten');
  assert.equal(price('123456', 0), '123456');
  assert.equal(price('1234.5', 0), '1234.5', 'already valid: unchanged');
});

test('sizes are cut to szDecimals', () => {
  assert.equal(decText(roundSize(dec('0.333333'), 5)), '0.33333');
  assert.equal(decText(roundSize(dec('12.9'), 0)), '12');
  assert.equal(decText(roundSize(dec('0.10'), 2)), '0.1');
});

test('an order: what will be signed, what rounding changed, and why it cannot go', () => {
  const ok = roundOrder({ size: '0.33', price: '74500', isBuy: false, szDecimals: 5 });
  assert.deepEqual([ok.sz, ok.limitPx, ok.changes, ok.problems], ['0.33', '74500', [], []]);
  assert.equal(ok.notionalMicro, 24_585_000_000n);

  const rounded = roundOrder({ size: '0.000123456', price: '75824.6', isBuy: true, szDecimals: 5 });
  assert.equal(rounded.sz, '0.00012');
  assert.equal(rounded.limitPx, '75824');
  assert.equal(rounded.changes.length, 2);
  assert.match(rounded.problems[0]!, /worth \$9\.09; Hyperliquid's minimum is \$10/, 'cut down to the cent, so it never reads as $10');

  assert.deepEqual(roundOrder({ size: '', price: '1', isBuy: true, szDecimals: 0 }).problems, ['Enter a size, like 0.01']);
  assert.match(roundOrder({ size: '0.000001', price: '75000', isBuy: true, szDecimals: 5 }).problems[0]!, /rounds to 0: the smallest step is 0\.00001/);
});

test('the band is the figure the markets answer gives, in the check and in the words: 3% on testnet for a new gateway', () => {
  // INTERFACES.md 42: 300 for an account that pins the new gateway, 100 for an older one. Nothing here is fixed at 1%.
  const wide = priceBand(72_987, 300);
  const narrow = priceBand(72_987, 100);
  // 12 Nov: testnet's mark stood 1.96% over its oracle. A sell priced near the mark is inside 3% and outside 1%.
  assert.equal(bandProblem(74_197, wide), null);
  assert.match(bandProblem(74_197, narrow)!, /1\.66% above the reference, outside the 1% band/);
  assert.match(bandProblem(75_400, wide)!, /3\.31% above the reference, outside the 3% band/);
  // A band that isn't a whole percent is said as it is, not rounded.
  assert.match(bandProblem(77_000, priceBand(75_000, 250))!, /outside the 2\.5% band/);
  assert.equal(bandPercent(300), '3%');
  assert.equal(bandPercent(100), '1%');
  assert.equal(bandPercent(250), '2.5%');
  assert.equal(bandPercent(125), '1.25%');
});

test('a band the testnet floor widened says so in one sentence; a band of the coin’s own doesn’t', () => {
  const words = 'This wider band is a testnet allowance, because Hyperliquid testnet’s price often stands away from its oracle.';
  // `band_floor_bp` is 300 for a gateway built since the rule, and the coin's band is that floor.
  assert.equal(bandFloorWords(300, 300), words);
  // An older gateway (floor 0), an answer from before the field, and a coin whose own band is wider than the floor.
  assert.equal(bandFloorWords(100, 0), null);
  assert.equal(bandFloorWords(100, undefined), null);
  assert.equal(bandFloorWords(500, 300), null);
});

test("the band: P2 refuses a limit more than the coin's band from the reference", () => {
  const band = priceBand(75_000, 100);
  assert.equal(band.low, 74_250);
  assert.equal(band.high, 75_750);
  assert.equal(bandProblem(75_000, band), null);
  assert.match(bandProblem(76_000, band)!, /1\.33% above the reference, outside the 1% band/);
  assert.match(bandProblem(74_300, band)!, /near the edge/);
  assert.equal(showPrice(75_750.123, 5), '75750');
  assert.equal(showPrice('89.43712', 2), '89.437');
});
