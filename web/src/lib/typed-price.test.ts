// The price-as-you-type rule (INTERFACES.md 49.5): 400 ms after the last keystroke, and again before it runs out.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nextPriceAsk, PRICE_DELAY_MS, PRICE_LIFE_MS, priceDue, priceStale } from './typed-price.ts';

const T = 1_794_700_000_000;

test('the price is asked for 400 ms after the last keystroke, not on every key', () => {
  assert.equal(PRICE_DELAY_MS, 400);
  assert.equal(priceDue(T, T + 399), false);
  assert.equal(priceDue(T, T + 400), true);
  // Another key within the 400 ms starts the wait again.
  assert.equal(priceDue(T + 300, T + 400), false);
  assert.equal(priceDue(T + 300, T + 700), true);
  assert.equal(priceDue(null, T), false);
  assert.equal(nextPriceAsk({ lastKeyMs: T, pricedAtMs: null, nowMs: T + 100 }), 300);
  assert.equal(nextPriceAsk({ lastKeyMs: T, pricedAtMs: null, nowMs: T + 900 }), 0);
  assert.equal(nextPriceAsk({ lastKeyMs: null, pricedAtMs: null, nowMs: T }), null);
});

test('a price that has run out is asked for again by itself; a newer keystroke comes first', () => {
  assert.equal(priceStale(T, T + PRICE_LIFE_MS - 1), false);
  assert.equal(priceStale(T, T + PRICE_LIFE_MS), true);
  assert.equal(priceStale(null, T), false);
  // A price is on screen for what was typed: the next ask is when it runs out.
  assert.equal(nextPriceAsk({ lastKeyMs: T, pricedAtMs: T + 500, nowMs: T + 10_500 }), 20_000);
  assert.equal(nextPriceAsk({ lastKeyMs: T, pricedAtMs: T + 500, nowMs: T + 40_000 }), 0);
  // The amount changed after that price came: the old price doesn't count, and the 400 ms run from the new key.
  assert.equal(nextPriceAsk({ lastKeyMs: T + 5_000, pricedAtMs: T + 500, nowMs: T + 5_100 }), 300);
});
