// Home before a wallet connects (INTERFACES.md 50.1 point 1): the row of live prices.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { homeMarkets } from './landing.ts';
import { readTokens } from './spot.ts';

const LIST = readTokens({
  tokens: [
    { symbol: 'USDC', name: 'USD Coin', price_usd: 1, decimals: 6 },
    { symbol: 'nBTC', name: 'Bitcoin', price_usd: 97_412.5, decimals: 8 },
    { symbol: 'ETH', name: 'Ether', price_usd: '3184.2', decimals: 18 },
    { symbol: 'NEAR', name: 'NEAR', price_usd: 2.4571, decimals: 24 },
    { symbol: 'SOL', name: 'Solana', price_usd: 161.05, decimals: 9 },
  ],
});

test('signed out, Home shows BTC, ETH and NEAR with live prices, each linked to Spot and to its market on Perps', () => {
  assert.deepEqual(homeMarkets(LIST), [
    { symbol: 'BTC', price: '$97,412.50', spotHref: '/spot', perpsHref: '/perps?coin=BTC' },
    { symbol: 'ETH', price: '$3,184.20', spotHref: '/spot', perpsHref: '/perps?coin=ETH' },
    { symbol: 'NEAR', price: '$2.46', spotHref: '/spot', perpsHref: '/perps?coin=NEAR' },
  ]);
});

test('while the price list hasn’t answered, or names no price, the row still shows each coin, with a dash', () => {
  assert.deepEqual(homeMarkets([]).map((m) => [m.symbol, m.price]), [['BTC', '—'], ['ETH', '—'], ['NEAR', '—']]);
  const noBtcPrice = readTokens({ tokens: [{ symbol: 'BTC', name: 'Bitcoin', price_usd: null, decimals: 8 }, { symbol: 'wNEAR', name: 'NEAR', price_usd: 2.5, decimals: 24 }] });
  assert.deepEqual(homeMarkets(noBtcPrice).map((m) => [m.symbol, m.price]), [['BTC', '—'], ['ETH', '—'], ['NEAR', '$2.50']]);
});
