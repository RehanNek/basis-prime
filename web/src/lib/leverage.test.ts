// The Perps order form's leverage slider (INTERFACES.md 51.11): an order's size as a multiple of the margin.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HL_DEFAULT_LEVERAGE, LEVERAGE_NOTE, LEVERAGE_STEP, leverageCap, leverageOf, leverageText, leverageWords, sizeForLeverage, sliderAt } from './leverage.ts';

test('the slider ends at Hyperliquid’s own setting: the account’s when it has a position, else a new account’s 20x or the coin’s most', () => {
  assert.deepEqual([HL_DEFAULT_LEVERAGE, LEVERAGE_STEP], [20, 0.5]);
  // 14 Nov, the user's new account: Hyperliquid testnet reported 20x cross for BTC (its most there is 40x) and for ETH (25x).
  assert.equal(leverageCap(null, 40), 20);
  assert.equal(leverageCap(null, 25), 20);
  assert.equal(leverageCap(null, 10), 10, 'SOL: its most is under 20x');
  assert.equal(leverageCap(undefined, undefined), 20);
  assert.equal(leverageCap(null, 0), 20);
  // With a position, Hyperliquid reports the account's own setting: the risk engine may have lowered it for a loan.
  assert.equal(leverageCap(5, 40), 5);
  assert.equal(leverageCap(25, 40), 25);
  assert.equal(leverageCap(0, 40), 20, 'a setting that makes no sense is passed over');
});

test('a leverage fills in the order’s size in USDC: margin times leverage, cut down to cents', () => {
  assert.equal(sizeForLeverage(298.379303, 3), '895.13', '895.137909, down');
  assert.equal(sizeForLeverage(300, 3), '900');
  assert.equal(sizeForLeverage(300, 0.5), '150');
  assert.equal(sizeForLeverage(512.4, 2.5), '1281');
  assert.equal(sizeForLeverage(100.25, 1), '100.25');
  assert.equal(sizeForLeverage(100.5, 1), '100.5');
  assert.equal(sizeForLeverage(1000, 20), '20000');
  assert.equal(sizeForLeverage(300, 0), '');
  assert.equal(sizeForLeverage(0, 5), '');
  assert.equal(sizeForLeverage(0.001, 1), '', 'under a cent');
});

test('any size typed reads back as a leverage, and the handle sits at the nearest half', () => {
  assert.equal(leverageOf(99_520_000n, 298.379303)!.toFixed(4), '0.3335', 'the user’s first order: $99.52 on $298.38');
  assert.equal(leverageOf(900_000_000n, 300), 3);
  assert.equal(leverageOf(900_000_000n, 0), null);
  assert.equal(leverageOf(0n, 300), 0);
  assert.equal(sliderAt(3, 20), 3);
  assert.equal(sliderAt(0.3335, 20), 0.5);
  assert.equal(sliderAt(0.2, 20), 0, 'nearer to nothing than to a half');
  assert.equal(sliderAt(2.76, 20), 3);
  assert.equal(sliderAt(31, 20), 20, 'never past the end');
  assert.equal(sliderAt(null, 20), 0);
  assert.equal(sliderAt(0, 20), 0);
});

test('the words: the leverage, and one line under the slider', () => {
  assert.equal(leverageText(3), '3x');
  assert.equal(leverageText(0.3335), '0.33x');
  assert.equal(leverageText(12.54), '12.5x');
  assert.equal(leverageText(null), '–');
  assert.equal(leverageText(0), '–');
  assert.equal(leverageWords({ leverage: null, equityUsd: 298.379303, cap: 20 }), 'Drag to size the order from your margin on Hyperliquid ($298.38), up to 20x.');
  assert.equal(leverageWords({ leverage: 3, equityUsd: 298.379303, cap: 20 }), 'This order is 3x your margin on Hyperliquid ($298.38).');
  assert.equal(
    leverageWords({ leverage: 21.8, equityUsd: 298.379303, cap: 20 }),
    'This order is 21.8x your margin on Hyperliquid ($298.38). That is more than the 20x Hyperliquid allows this account, so it would be refused.',
  );
  assert.match(LEVERAGE_NOTE, /sets the order’s size/);
  assert.match(LEVERAGE_NOTE, /doesn’t change the leverage setting on Hyperliquid/);
});
