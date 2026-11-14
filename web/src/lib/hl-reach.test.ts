// Don't let a client start an order Hyperliquid can't take (INTERFACES.md 50.4): which markets can trade now.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BAND_EDGE_BP, coinTradingNow, defaultCoin, firstTrading, HL_TESTNET_REACH_BP, NONE_TRADING_WORDS, NOT_TRADING_MARK, notTradingWords, orderStopped, reachOf, tradingNow } from './hl-reach.ts';

/** A coin's row of the markets answer, with the mark a share under (or over) the oracle price. */
const row = (oracle: number, offPercent: number, bandBp = 300) => ({ band_bp: bandBp, testnet: { mark_px: String(oracle * (1 + offPercent / 100)), oracle_px: String(oracle) } });

// 13 Nov, 22:28 UTC: BTC's mark stood 2.60% under its oracle price, ETH's 1.13% under, NEAR's 0.10% under.
const BTC = row(68_800, -2.6);
const ETH = row(1_950, -1.13);
const NEAR = row(3.5, -0.1);

test('the figures are the keeper’s own: Hyperliquid testnet trades up to about 2.4% from its oracle price, and a price stays 0.1% inside the gateway’s band', () => {
  assert.deepEqual([HL_TESTNET_REACH_BP, BAND_EDGE_BP], [240, 10]);
  // With testnet's 3% band Hyperliquid's own limit is the nearer one; with an older gateway's 1%, the band is.
  assert.deepEqual(reachOf(300), { bp: 240, venue: true });
  assert.deepEqual(reachOf(100), { bp: 90, venue: false });
});

test('which coins can trade now: BTC 2.6% from its reference price can’t, ETH at 1.13% and NEAR at 0.10% can', () => {
  const btc = coinTradingNow(BTC, true);
  assert.equal(btc.ok, false);
  assert.deepEqual(btc.ok ? null : [btc.why, btc.limitBp, Math.round(btc.gapBp)], ['venue', 240, 260]);
  assert.equal(coinTradingNow(ETH, true).ok, true);
  assert.equal(coinTradingNow(NEAR, true).ok, true);
  // Over the oracle is as far as under it: a short that couldn't be closed isn't opened.
  assert.equal(coinTradingNow(row(68_800, 2.6), true).ok, false);
  // Just inside Hyperliquid's limit, but past where this app prices an order that fills at once (half the band, 1.5%).
  const two = coinTradingNow(row(68_800, -2.0), true);
  assert.deepEqual(two.ok ? null : [two.why, two.limitBp], ['page', 150]);
  assert.equal(coinTradingNow(row(68_800, -1.49), true).ok, true);
  // An account on an older gateway: its 1% band is the nearer limit.
  const old = coinTradingNow(row(68_800, -0.95, 100), true);
  assert.deepEqual(old.ok ? null : [old.why, old.limitBp], ['gateway', 90]);
  // Nothing to measure from, nothing stopped.
  assert.equal(coinTradingNow({ band_bp: 300, testnet: { mark_px: '68000', oracle_px: null } }, true).ok, true);
  assert.equal(coinTradingNow({ band_bp: 300, testnet: null }, true).ok, true);
  assert.equal(coinTradingNow(undefined, true).ok, true);
});

test('on mainnet nothing changes: the same prices stop nothing', () => {
  assert.equal(coinTradingNow(BTC, false).ok, true);
  assert.equal(tradingNow({ mark: 67_000, oracle: 68_800, bandBp: 300, testnet: false }).ok, true);
  assert.equal(orderStopped({ trading: coinTradingNow(BTC, false), kind: 'market', limitPx: null, reference: 68_800, bandBp: 300 }), false);
});

test('the default pick is the first coin that can trade now; with none, the first that can be picked, and the page says so', () => {
  const options = [
    { coin: 'BTC', usable: true, tradesNow: false },
    { coin: 'ETH', usable: true, tradesNow: true },
    { coin: 'NEAR', usable: true, tradesNow: true },
  ];
  assert.equal(firstTrading(options)?.coin, 'ETH');
  assert.equal(firstTrading([{ coin: 'BTC', usable: false, tradesNow: true }, { coin: 'NEAR', usable: true, tradesNow: true }])?.coin, 'NEAR', 'a coin that can’t be picked is never the default');
  assert.equal(firstTrading(options.map((o) => ({ ...o, tradesNow: false })))?.coin, 'BTC');
  assert.equal(firstTrading([]), null);
  // A trade under way keeps its coin: the account already holds it, whatever the market does now.
  const withSymbols = options.map((o) => ({ ...o, symbol: o.coin === 'BTC' ? 'nBTC' : o.coin }));
  assert.equal(defaultCoin(withSymbols, (symbol) => symbol === 'nBTC')?.coin, 'BTC');
  assert.equal(defaultCoin(withSymbols, () => false)?.coin, 'ETH');
  assert.equal(NONE_TRADING_WORDS, 'No coin here is trading on Hyperliquid testnet right now: each one’s price is too far from its reference price. Try again later.');
});

test('the words: the dropdown marks the coin, and one line says why in plain words and what to do', () => {
  assert.equal(NOT_TRADING_MARK, 'not trading on Hyperliquid testnet right now');
  assert.equal(
    notTradingWords('BTC', coinTradingNow(BTC, true)),
    'Hyperliquid testnet’s BTC price is 2.6% away from its reference price right now, and it takes no order that far out. Pick another coin, or try BTC again later.',
  );
  assert.equal(
    notTradingWords('BTC', coinTradingNow(BTC, true), 'market'),
    'Hyperliquid testnet’s BTC price is 2.6% away from its reference price right now, and it takes no order that far out. Pick another market, or try BTC again later.',
  );
  assert.equal(
    notTradingWords('BTC', coinTradingNow(row(68_800, -2.0), true)),
    'Hyperliquid testnet’s BTC price is 2.0% away from its reference price right now, too far for an order placed from here to fill at once. Pick another coin, or try BTC again later.',
  );
  assert.equal(
    notTradingWords('BTC', coinTradingNow(row(68_800, -0.95, 100), true)),
    'Hyperliquid testnet’s BTC price is 0.9% away from its reference price right now, and your account’s risk checks take no order more than 0.9% out. Pick another coin, or try BTC again later.',
  );
  assert.equal(notTradingWords('ETH', coinTradingNow(ETH, true)), null);
  for (const words of [notTradingWords('BTC', coinTradingNow(BTC, true))!, NONE_TRADING_WORDS]) assert.doesNotMatch(words, /oracle|mark\b|gateway|bp\b/i);
});

test('on Perps, in a market that can’t trade now, a market order is stopped and so is a limit priced out of reach; a nearer limit is left to Hyperliquid', () => {
  const trading = coinTradingNow(BTC, true);
  assert.equal(orderStopped({ trading, kind: 'market', limitPx: null, reference: 68_800, bandBp: 300 }), true);
  assert.equal(orderStopped({ trading, kind: 'limit', limitPx: '66900', reference: 68_800, bandBp: 300 }), true, '2.76% under the reference');
  assert.equal(orderStopped({ trading, kind: 'limit', limitPx: '69500', reference: 68_800, bandBp: 300 }), false, '1.02% over: it can rest on the book');
  assert.equal(orderStopped({ trading, kind: 'limit', limitPx: '', reference: 68_800, bandBp: 300 }), false, 'no price typed yet');
  // A market that trades stops nothing.
  assert.equal(orderStopped({ trading: coinTradingNow(ETH, true), kind: 'market', limitPx: null, reference: 1_950, bandBp: 300 }), false);
});
