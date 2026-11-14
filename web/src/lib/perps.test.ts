// The Perps page's plain part (INTERFACES.md 49.3): the backend's answers read tolerantly, the book's totals and
// spread, candles as bars, the order's price and size, and the gateway's answer in words. The fixtures are rows as
// Hyperliquid testnet answered them on 13 Nov (l2Book, recentTrades, candleSnapshot, metaAndAssetCtxs).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MarketCoin } from './api.ts';
import {
  barAt,
  bookRows,
  bookView,
  buildOrder,
  candleChange,
  candleNote,
  candlesPath,
  CHART,
  chartModel,
  closeIntent,
  coinFacts,
  coinFromUsd,
  compactUsd,
  ctxFromMarkets,
  dayChange,
  EXPIRED_WORDS,
  fundingText,
  intervalMs,
  INTERVALS,
  isExpired,
  marketFillNote,
  marketPrice,
  mergeCtx,
  MIN_CANDLES,
  niceTicks,
  num,
  openInterestText,
  orderLabel,
  parseCandles,
  parsePerps,
  perpsPath,
  pickerCoins,
  priceAt,
  priceFromBook,
  priceText,
  progressWords,
  resultWords,
  sizeStep,
  sizeText,
  spreadOf,
  THIN_WORDS,
  timeLabel,
  TRADES_KEPT,
  usdFromCoin,
  withLivePrices,
  type Candle,
  type OrderIntent,
} from './perps.ts';

// ---------- fixtures ----------

const ANSWER = {
  coin: 'BTC',
  ctx: { mark: '68551.0', oracle: '69002.4', funding: '0.0000125', open_interest: '57.66534', day_volume: '2082520.1717299982', prev_day_px: '73386.0' },
  book: {
    bids: [
      { px: '68536.0', sz: '0.0003', n: 1 },
      { px: '68520.0', sz: '0.00015', n: 1 },
      { px: '68516.0', sz: '0.00271', n: 1 },
      { px: '68515.0', sz: '0.00035', n: 1 },
    ],
    asks: [
      { px: '68565.0', sz: '0.001', n: 1 },
      { px: '68570.0', sz: '0.004', n: 2 },
      { px: '68601.0', sz: '0.00015', n: 1 },
    ],
  },
  trades: [
    { coin: 'BTC', side: 'B', px: '68610.0', sz: '0.00007', time: 1794596981056, hash: '0x75f3', tid: 1080550089997328 },
    { coin: 'BTC', side: 'A', px: '68542.0', sz: '0.0002', time: 1794596990000, hash: '0x75f4', tid: 339914251011177 },
  ],
  read_at_ms: 1794596991000,
};

const market = (over: Partial<MarketCoin> = {}, testnet: Partial<NonNullable<MarketCoin['testnet']>> | null = {}): MarketCoin => ({
  coin: 'BTC',
  allowed: true,
  tier: 1,
  band_bp: 300,
  universe_sz_decimals: 5,
  client_cap_usd: 77_712_067,
  testnet: testnet === null ? null : { asset: 3, sz_decimals: 5, max_leverage: 40, delisted: false, mark_px: '68535.0', oracle_px: '69001.0', mid_px: '68559.5', day_ntl_vlm: '2082333.6', funding: '0.0000125', ...testnet },
  status: null,
  ...over,
});

const BTC = coinFacts(market())!;
const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({ coin: 'BTC', isBuy: true, kind: 'limit', size: '0.01', sizeIn: 'coin', price: '68500', reduceOnly: false, tif: 'Gtc', ...over });

/** `n` one-minute candles walking up from 68,000, each $10 above the last. */
const candles = (n: number, start = 68_000): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ t: 1_794_596_340_000 + i * 60_000, o: start + i * 10, c: start + i * 10 + (i % 2 ? -4 : 6), h: start + i * 10 + 12, l: start + i * 10 - 9, v: 0.01 * (i + 1) }));

// ---------- paths and numbers ----------

test('the two routes of INTERFACES.md 49.3, with the coin escaped', () => {
  assert.equal(perpsPath('BTC'), '/api/perps/BTC');
  assert.equal(perpsPath('k/PEPE'), '/api/perps/k%2FPEPE');
  assert.equal(candlesPath('ETH', '15m', 120), '/api/perps/ETH/candles?interval=15m&n=120');
  assert.deepEqual(INTERVALS.map((i) => i.id), ['1m', '5m', '15m', '1h', '4h', '1d']);
  assert.equal(intervalMs('4h'), 4 * 3_600_000);
});

test('a number is read from a number or a numeric string, and from nothing else', () => {
  assert.equal(num('68551.0'), 68551);
  assert.equal(num(12.5), 12.5);
  assert.equal(num('0'), 0);
  for (const bad of ['', ' ', 'abc', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, {}, [], true]) assert.equal(num(bad), null, String(bad));
});

// ---------- GET /api/perps/:coin ----------

test("the market's answer: figures as numbers, the book best first, trades newest first", () => {
  const m = parsePerps(ANSWER)!;
  assert.equal(m.coin, 'BTC');
  assert.deepEqual(m.ctx, { mark: 68551, oracle: 69002.4, funding: 0.0000125, openInterest: 57.66534, dayVolume: 2082520.1717299982, prevDayPx: 73386 });
  assert.deepEqual(m.bids.map((l) => l.px), [68536, 68520, 68516, 68515]);
  assert.deepEqual(m.asks.map((l) => l.px), [68565, 68570, 68601]);
  assert.equal(m.bids[0]!.pxText, '68536', "Hyperliquid's trailing .0 is dropped, so the form gets a clean price");
  assert.deepEqual(m.trades.map((t) => [t.px, t.isBuy]), [[68542, false], [68610, true]]);
  assert.equal(m.readAtMs, 1794596991000);
});

test('the book is sorted whatever order it came in, and rows that are not a price and a size are dropped', () => {
  const m = parsePerps({
    book: {
      bids: [['100', '1'], { px: '101', sz: '2' }, { price: 99.5, size: 3 }, { px: 'x', sz: '1' }, { px: '98', sz: '0' }, null, 'junk'],
      asks: [{ px: '103', sz: '1' }, { px: '102', sz: '4' }, { px: '-1', sz: '4' }],
    },
  })!;
  assert.deepEqual(m.bids.map((l) => [l.px, l.sz]), [[101, 2], [100, 1], [99.5, 3]]);
  assert.deepEqual(m.asks.map((l) => l.px), [102, 103]);
});

test("Hyperliquid's own l2Book shape and field names are read too", () => {
  const m = parsePerps({
    coin: 'ETH',
    ctx: { markPx: '1935.8', oraclePx: '1947.72', funding: '-0.0005204075', openInterest: '120.5', dayNtlVlm: '741870.45', prevDayPx: '2001.0' },
    book: { levels: [[{ px: '1935.1', sz: '0.5', n: 1 }], [{ px: '1936.0', sz: '0.25', n: 1 }]] },
    trades: [{ side: 'sell', price: 1935.4, size: 0.1, time: 5 }, { side: 'buy', px: '1936', sz: '0.2', time: 9 }],
  })!;
  assert.deepEqual(m.ctx, { mark: 1935.8, oracle: 1947.72, funding: -0.0005204075, openInterest: 120.5, dayVolume: 741870.45, prevDayPx: 2001 });
  assert.equal(m.bids[0]!.px, 1935.1);
  assert.equal(m.asks[0]!.px, 1936);
  assert.deepEqual(m.trades.map((t) => [t.time, t.isBuy]), [[9, true], [5, false]]);
});

test('an answer with parts missing still parses: empty book, no trades, figures null', () => {
  const m = parsePerps({ coin: 'DOGE' })!;
  assert.deepEqual(m.ctx, { mark: null, oracle: null, funding: null, openInterest: null, dayVolume: null, prevDayPx: null });
  assert.deepEqual([m.bids, m.asks, m.trades, m.readAtMs], [[], [], [], null]);
  assert.equal(parsePerps({ ctx: 'x', book: [], trades: {} })!.bids.length, 0);
  for (const bad of [null, undefined, 'x', 5, []]) assert.equal(parsePerps(bad), null);
});

test(`at most ${TRADES_KEPT} trades are kept, the newest`, () => {
  const many = Array.from({ length: 70 }, (_, i) => ({ side: 'B', px: '10', sz: '1', time: i, tid: i }));
  const m = parsePerps({ trades: many })!;
  assert.equal(m.trades.length, TRADES_KEPT);
  assert.equal(m.trades[0]!.time, 69);
  assert.equal(new Set(m.trades.map((t) => t.id)).size, TRADES_KEPT, 'each row has its own key');
});

// ---------- the top bar ----------

test('the top bar: prices with the coin’s decimals, the day’s change, volume, open interest and funding', () => {
  assert.equal(priceText(68551, 5), '68,551');
  assert.equal(priceText(1935.87, 4), '1,935.8', 'ETH: 5 significant figures');
  assert.equal(priceText(0.0645219, 0), '0.064521');
  assert.equal(priceText(null, 5), '–');
  assert.deepEqual(dayChange(68551, 73386, 5), { abs: '-4,835', pct: '-6.59%', dir: 'down' });
  assert.deepEqual(dayChange(1950, 1900, 4), { abs: '+50', pct: '+2.63%', dir: 'up' });
  assert.deepEqual(dayChange(10, 10, 2), { abs: '0', pct: '0.00%', dir: 'flat' });
  assert.equal(dayChange(68551, null, 5), null);
  assert.equal(dayChange(null, 73386, 5), null);
  assert.equal(dayChange(5, 0, 5), null, 'no division by a price of zero');
  assert.equal(compactUsd(2082520.17), '$2.08M');
  assert.equal(compactUsd(741870.45), '$741.9K');
  assert.equal(compactUsd(950.5), '$951');
  assert.equal(compactUsd(3_200_000_000), '$3.20B');
  assert.equal(compactUsd(null), '–');
  assert.deepEqual(openInterestText(57.66534, 68551, 'BTC'), { usd: '$3.95M', coins: '57.67 BTC' });
  assert.deepEqual(openInterestText(1_234_567, null, 'DOGE'), { usd: '–', coins: '1,234,567 DOGE' });
  assert.equal(openInterestText(null, 68551, 'BTC'), null);
  assert.deepEqual(fundingText(0.0000125), { text: '0.0013%', who: 'Longs pay shorts, every hour', dir: 'up' });
  assert.deepEqual(fundingText(-0.0005204075), { text: '-0.0520%', who: 'Shorts pay longs, every hour', dir: 'down' });
  assert.equal(fundingText(0)!.dir, 'flat');
  assert.equal(fundingText(null), null);
});

test('while the live figures are missing, the top bar shows what the markets list has', () => {
  const fallback = ctxFromMarkets(market());
  assert.deepEqual(fallback, { mark: 68535, oracle: 69001, funding: 0.0000125, openInterest: null, dayVolume: 2082333.6, prevDayPx: null });
  assert.deepEqual(ctxFromMarkets(market({}, { delisted: true })), { mark: null, oracle: null, funding: null, openInterest: null, dayVolume: null, prevDayPx: null });
  assert.deepEqual(ctxFromMarkets(undefined).mark, null);
  assert.equal(mergeCtx(null, fallback), fallback);
  const live = parsePerps(ANSWER)!.ctx;
  assert.deepEqual(mergeCtx(live, fallback), live, 'the live answer wins where it has a figure');
  assert.deepEqual(mergeCtx({ ...live, mark: null, funding: null }, fallback), { ...live, mark: 68535, funding: 0.0000125 });
});

// ---------- the order book ----------

test('book rows carry a running total from the best price outward', () => {
  const m = parsePerps(ANSWER)!;
  const rows = bookRows(m.bids, 3);
  assert.deepEqual(rows.map((r) => r.px), [68536, 68520, 68516]);
  assert.deepEqual(rows.map((r) => Number(r.total.toFixed(5))), [0.0003, 0.00045, 0.00316]);
  assert.equal(bookRows(m.bids, 0).length, 0);
  assert.equal(bookRows([], 10).length, 0);
});

test('depth shares are measured against the deeper side, so the two sides compare', () => {
  const m = parsePerps(ANSWER)!;
  const view = bookView(m.bids, m.asks, 10);
  // Bids add up to 0.00351, asks to 0.00515: the asks are deeper, so the last ask is the full bar.
  assert.equal(view.asks.at(-1)!.share, 1);
  assert.ok(Math.abs(view.bids.at(-1)!.share - 0.00351 / 0.00515) < 1e-9);
  assert.ok(Math.abs(view.asks[0]!.share - 0.001 / 0.00515) < 1e-9);
  for (const side of [view.bids, view.asks]) {
    for (let i = 1; i < side.length; i += 1) assert.ok(side[i]!.share >= side[i - 1]!.share, 'a bar never shrinks going outward');
  }
  const empty = bookView([], [], 10);
  assert.deepEqual([empty.bids, empty.asks, empty.spread], [[], [], null]);
});

test('the spread: the gap, its share of the middle price, and none for an empty or crossed book', () => {
  const m = parsePerps(ANSWER)!;
  const s = bookView(m.bids, m.asks, 10).spread!;
  assert.equal(s.abs, 29);
  assert.equal(s.mid, 68550.5);
  assert.ok(Math.abs(s.pct - (29 / 68550.5) * 100) < 1e-12);
  assert.equal(spreadOf(100, 100)!.abs, 0, 'a locked book has a spread of nothing');
  assert.equal(spreadOf(101, 100), null, 'crossed');
  assert.equal(spreadOf(undefined, 100), null);
  assert.equal(spreadOf(100, null), null);
  assert.equal(spreadOf(0, 100), null);
});

test('sizes line up in a column', () => {
  assert.equal(sizeText(0.0003, 5), '0.00030');
  assert.equal(sizeText(1234.5, 2), '1,234.50');
  assert.equal(sizeText(12, 0), '12');
  assert.equal(sizeStep(5), '0.00001');
  assert.equal(sizeStep(0), '1');
});

// ---------- candles ----------

test("candleSnapshot rows become candles: strings to numbers, oldest first, one per opening time", () => {
  const rows = [
    { t: 1794596400000, T: 1794596459999, s: 'BTC', i: '1m', o: '68338.0', c: '68239.0', h: '68412.0', l: '68239.0', v: '0.05983', n: 52 },
    { t: 1794596340000, T: 1794596399999, s: 'BTC', i: '1m', o: '68394.0', c: '68308.0', h: '68410.0', l: '68306.0', v: '0.01146', n: 42 },
    { t: 1794596400000, T: 1794596459999, s: 'BTC', i: '1m', o: '68338.0', c: '68250.0', h: '68412.0', l: '68239.0', v: '0.06', n: 53 },
  ];
  const parsed = parseCandles(rows);
  assert.deepEqual(parsed, [
    { t: 1794596340000, o: 68394, c: 68308, h: 68410, l: 68306, v: 0.01146 },
    { t: 1794596400000, o: 68338, c: 68250, h: 68412, l: 68239, v: 0.06 },
  ]);
  assert.deepEqual(parseCandles({ coin: 'BTC', interval: '1m', candles: rows }), parsed, 'wrapped under "candles" reads the same');
});

test('a broken candle row is dropped, not drawn', () => {
  const good = { t: 1, o: '10', h: '12', l: '9', c: '11', v: '5' };
  const parsed = parseCandles([good, { ...good, t: 2, h: 'x' }, { ...good, t: null }, { ...good, t: 3, o: '0' }, { ...good, t: 4, l: '-1' }, null, 'row', 7, { t: 5 }]);
  assert.deepEqual(parsed.map((c) => c.t), [1]);
  // A high below the close, or a low above the open, is stretched to hold both; a missing volume is 0.
  assert.deepEqual(parseCandles([{ t: 9, o: 10, h: 10.5, l: 10.2, c: 11 }]), [{ t: 9, o: 10, c: 11, h: 11, l: 10, v: 0 }]);
  for (const bad of [null, undefined, 'x', 5, {}, { candles: 'x' }]) assert.deepEqual(parseCandles(bad), []);
});

test(`thin data says "${THIN_WORDS}"`, () => {
  assert.equal(candleNote([]), THIN_WORDS);
  assert.equal(candleNote(candles(MIN_CANDLES - 1)), THIN_WORDS);
  assert.equal(candleNote(candles(MIN_CANDLES)), null);
  assert.equal(candleNote(candles(40).map((c) => ({ ...c, v: 0 }))), THIN_WORDS, 'candles with no volume are no trades');
});

test('round steps for the price scale', () => {
  assert.deepEqual(niceTicks(68_000, 68_500, 5), [68_000, 68_100, 68_200, 68_300, 68_400, 68_500]);
  assert.deepEqual(niceTicks(0.0641, 0.0668, 3), [0.065, 0.066]);
  assert.deepEqual(niceTicks(1, 1, 4), []);
  assert.deepEqual(niceTicks(Number.NaN, 2, 4), []);
});

test('candles as bars: the newest at the right edge, inside the box, highs above lows', () => {
  const box = { width: 800, height: 400 };
  const data = candles(60);
  const model = chartModel(data, box)!;
  assert.equal(model.bars.length, 60);
  assert.equal(model.plot.right, 800 - CHART.axisRight);
  const lastBar = model.bars.at(-1)!;
  assert.ok(Math.abs(lastBar.x - (model.plot.right - model.step / 2)) < 1e-9);
  for (const bar of model.bars) {
    assert.ok(bar.x - model.bodyWidth / 2 >= model.plot.left && bar.x + model.bodyWidth / 2 <= model.plot.right, 'inside the pane, left and right');
    assert.ok(bar.wickTop >= model.plot.top && bar.wickBottom <= model.plot.bottom, 'inside the pane, top and bottom');
    assert.ok(bar.wickTop <= bar.bodyTop && bar.bodyTop + bar.bodyHeight <= bar.wickBottom + 1e-9, 'the body sits within the wick');
    assert.ok(bar.bodyHeight >= 1);
    assert.equal(bar.up, bar.candle.c >= bar.candle.o);
    assert.ok(bar.volTop >= model.volume.top - 1e-9 && bar.volTop + bar.volHeight <= model.volume.bottom + 1e-9, 'volume stays in its own pane');
  }
  assert.ok(model.volume.top > model.plot.bottom, 'volume sits under the prices');
  assert.ok(model.volume.bottom <= box.height - CHART.axisBottom);
  // A higher price is drawn higher up.
  assert.ok(model.bars[59]!.wickTop < model.bars[0]!.wickTop);
  // The biggest volume fills its pane.
  assert.ok(Math.abs(lastBar.volHeight - (model.volume.bottom - model.volume.top)) < 1e-9);
  // The last price's line is at the last close.
  assert.equal(model.last.price, data.at(-1)!.c);
  assert.ok(model.last.y > model.plot.top && model.last.y < model.plot.bottom);
  assert.ok(model.priceTicks.length >= 2);
  for (const tick of model.priceTicks) assert.ok(tick.y >= model.plot.top && tick.y <= model.plot.bottom);
  assert.ok(model.timeTicks.length >= 2 && model.timeTicks.length <= 12);
});

test("at a phone's width only the newest candles that fit are drawn, none thinner than the least step", () => {
  const model = chartModel(candles(240), { width: 340, height: 240 })!;
  const fits = Math.floor((340 - CHART.axisRight) / CHART.minStep);
  assert.equal(model.bars.length, fits);
  assert.equal(model.bars.at(-1)!.candle.t, candles(240).at(-1)!.t, 'the newest candle is kept');
  assert.ok(model.step >= CHART.minStep);
  assert.ok(model.bars[0]!.x - model.bodyWidth / 2 >= 0);
});

test('a few candles stay slim at the right instead of being stretched across', () => {
  const model = chartModel(candles(3), { width: 900, height: 400 })!;
  assert.equal(model.step, CHART.maxStep);
  assert.ok(model.bars[0]!.x > model.plot.right - 3 * CHART.maxStep - 1);
});

test('one flat candle, or none, never divides by zero', () => {
  const flat = chartModel([{ t: 1, o: 100, h: 100, l: 100, c: 100, v: 0 }], { width: 600, height: 300 })!;
  const bar = flat.bars[0]!;
  for (const value of [bar.x, bar.wickTop, bar.wickBottom, bar.bodyTop, bar.bodyHeight, bar.volTop, bar.volHeight, flat.last.y, flat.min, flat.max]) assert.ok(Number.isFinite(value));
  assert.ok(flat.min < 100 && flat.max > 100);
  assert.equal(bar.volHeight, 0);
  assert.equal(chartModel([], { width: 600, height: 300 }), null);
  assert.equal(chartModel(candles(20), { width: 0, height: 0 }), null, 'before the box is measured');
  assert.equal(chartModel(candles(20), { width: 70, height: 300 }), null, 'too narrow to draw in');
});

test('the crosshair finds the candle under it and the price at its height', () => {
  const model = chartModel(candles(60), { width: 800, height: 400 })!;
  const bar = model.bars[17]!;
  assert.equal(barAt(model, bar.x), bar);
  assert.equal(barAt(model, bar.x + model.step * 0.4), bar, 'anywhere over the bar');
  assert.equal(barAt(model, model.plot.left), model.bars[0], 'left of the first bar: the first');
  assert.equal(barAt(model, model.plot.right), model.bars.at(-1));
  assert.equal(barAt(model, model.plot.right + 10), null, 'over the price axis: none');
  assert.equal(barAt(model, -1), null);
  assert.equal(priceAt(model, model.plot.top), model.max);
  assert.equal(priceAt(model, model.plot.bottom), model.min);
  assert.ok(Math.abs(priceAt(model, model.last.y)! - model.last.price) < 1e-6);
  assert.equal(priceAt(model, model.plot.bottom + 5), null, 'over the volume: no price');
});

test('time labels: the clock within a day, the date for daily candles and at midnight', () => {
  const t = Date.UTC(2026, 10, 13, 14, 35);
  assert.equal(timeLabel(t, '5m', { utc: true }), '14:35');
  assert.equal(timeLabel(Date.UTC(2026, 10, 13, 0, 0), '1h', { utc: true }), '13 Nov');
  assert.equal(timeLabel(t, '1d', { utc: true }), '13 Nov');
  assert.equal(timeLabel(t, '1m', { utc: true, full: true }), '13 Nov 14:35');
  assert.equal(timeLabel(Date.UTC(2026, 0, 2, 9, 5), '1h', { utc: true, full: true }), '2 Jan 09:05');
  assert.deepEqual(candleChange({ t: 1, o: 100, h: 102, l: 99, c: 101.5, v: 1 }), { pct: '+1.50%', dir: 'up' });
  assert.deepEqual(candleChange({ t: 1, o: 100, h: 100, l: 98, c: 98, v: 1 }), { pct: '-2.00%', dir: 'down' });
  assert.equal(candleChange({ t: 1, o: 100, h: 100, l: 100, c: 100, v: 0 }).dir, 'flat');
});

// ---------- the order ----------

test("a coin's facts are read as the trade page reads them: testnet's size rule, the oracle as the reference", () => {
  assert.deepEqual(BTC, { coin: 'BTC', allowed: true, listed: true, szDecimals: 5, mark: 68535, reference: 69001, band: { reference: 69001, low: 69001 * 0.97, high: 69001 * 1.03, bandBp: 300 }, bandBp: 300, status: null });
  const zec = coinFacts(market({ coin: 'ZEC', universe_sz_decimals: 2 }, { sz_decimals: 0, delisted: true }))!;
  assert.deepEqual([zec.listed, zec.szDecimals, zec.reference, zec.band], [false, 2, null, null], 'delisted on testnet: not listed, no price');
  assert.equal(coinFacts(market({}, null))!.listed, false);
  assert.equal(coinFacts(market({}, { oracle_px: null }))!.reference, 68535, 'no oracle: the mark stands in');
  assert.equal(coinFacts(market({ status: { status: 'reduce_only', since: '1', emergency: false } }))!.status, 'reduce_only');
  assert.equal(coinFacts(market({ status: { status: 'allowed', since: '1', emergency: false } }))!.status, null);
  assert.equal(coinFacts(undefined), null);
});

test('the form prices from the live mark and oracle when the market has answered', () => {
  const live = parsePerps(ANSWER)!.ctx;
  const facts = coinFacts(withLivePrices(market(), live))!;
  assert.deepEqual([facts.mark, facts.reference], [68551, 69002.4]);
  assert.equal(marketPrice({ reference: facts.reference, bandBp: facts.bandBp, isBuy: true, szDecimals: 5 }), '70589', '69002.4 x 1.023 = 70589.455');
  assert.deepEqual(withLivePrices(market(), null), market(), 'no live answer: the list as it is');
  assert.equal(withLivePrices(market(), { ...live, oracle: null })!.testnet!.oracle_px, '69001.0', 'a missing live figure keeps the list\u2019s');
  assert.equal(coinFacts(withLivePrices(market({}, { delisted: true }), live))!.listed, false, 'a delisted coin stays unlisted');
  assert.equal(withLivePrices(undefined, live), null);
});

test('the picker offers the allow-listed coins, those testnet lists first', () => {
  const coins = [market({ coin: 'ZEC' }, { delisted: true }), market({ coin: 'BTC' }), market({ coin: 'XYZ', allowed: false }), market({ coin: 'HYPE' }, null), market({ coin: 'ETH' })];
  assert.deepEqual(pickerCoins(coins), [{ coin: 'BTC', listed: true }, { coin: 'ETH', listed: true }, { coin: 'ZEC', listed: false }, { coin: 'HYPE', listed: false }]);
});

test("a market order's price is the trade page's Close sum: 2.3% past the reference with testnet's 3% band, on the side that fills", () => {
  // Every order meant to fill at once: reference * (1 + (isBuy ? 1 : -1) * ownOrderBp(band) / 10_000), a buy rounded down and a sell up.
  assert.equal(marketPrice({ reference: 69001, bandBp: 300, isBuy: true, szDecimals: 5 }), '70588', '69001 x 1.023 = 70588.023, down');
  assert.equal(marketPrice({ reference: 69001, bandBp: 300, isBuy: false, szDecimals: 5 }), '67414', '69001 x 0.977 = 67413.977, up');
  assert.equal(marketPrice({ reference: 1947.72, bandBp: 300, isBuy: true, szDecimals: 4 }), '1992.5', 'ETH: 1992.5176, 5 significant figures, down');
  assert.equal(marketPrice({ reference: 1947.72, bandBp: 300, isBuy: false, szDecimals: 4 }), '1903', '1902.9224, up');
  assert.equal(marketPrice({ reference: 69001, bandBp: 100, isBuy: true, szDecimals: 5 }), '69553', "mainnet's 1% band for BTC: 0.8% past");
  for (const [bandBp, isBuy] of [[300, true], [300, false], [100, true], [250, false]] as const) {
    const px = Number(marketPrice({ reference: 69001, bandBp, isBuy, szDecimals: 5 }));
    assert.ok(Math.abs(px / 69001 - 1) <= (bandBp - 20) / 10_000, 'never nearer than 0.2% to the band’s edge, so it is always inside the band');
    assert.ok(Math.abs(px / 69001 - 1) <= 0.023, 'and never past 2.3%: a tenth of a percent inside what Hyperliquid testnet takes');
    assert.ok(isBuy ? px > 69001 : px < 69001, 'on the side that fills');
  }
  assert.equal(marketPrice({ reference: null, bandBp: 300, isBuy: true, szDecimals: 5 }), null);
  assert.equal(marketPrice({ reference: 0, bandBp: 300, isBuy: true, szDecimals: 5 }), null);
});

test('USDC typed as a size becomes coins, cut down to the coin’s decimals, and back', () => {
  assert.equal(coinFromUsd('500', '68535', 5), '0.00729', '500 / 68535 = 0.0072955...');
  assert.equal(coinFromUsd('1,000.50', '1935.8', 4), '0.5168');
  assert.equal(coinFromUsd('100', '0.064521', 0), '1549', 'a whole number of DOGE');
  assert.equal(coinFromUsd('5', '68535', 5), '0.00007');
  assert.equal(coinFromUsd('0.5', '68535', 5), '0', 'too little for one step');
  assert.equal(coinFromUsd('abc', '68535', 5), null);
  assert.equal(coinFromUsd('100', '0', 5), null);
  assert.equal(coinFromUsd('100', '', 5), null);
  assert.equal(usdFromCoin('0.00729', '68535'), '499.62');
  assert.equal(usdFromCoin('2', '1935.8'), '3871.6');
  assert.equal(usdFromCoin('', '1935.8'), null);
});

test('a limit order: rounded by Hyperliquid’s rules, never worse than typed, and worth what it says', () => {
  const built = buildOrder(intent({ size: '0.012345678', price: '68500.7' }), BTC);
  assert.deepEqual(built.order, { coin: 'BTC', is_buy: true, sz: '0.01234', limit_px: '68500', reduce_only: false, tif: 'Gtc' });
  assert.equal(built.worthMicro, 845_290_000n, '0.01234 x 68,500');
  assert.equal(built.notes.length, 2, 'the size and the price were both rounded, and the page says so');
  assert.deepEqual(built.problems, []);
  const sell = buildOrder(intent({ isBuy: false, price: '68500.7', tif: 'Alo', reduceOnly: true }), BTC);
  assert.deepEqual(sell.order, { coin: 'BTC', is_buy: false, sz: '0.01', limit_px: '68501', reduce_only: true, tif: 'Alo' }, 'a sell rounds up');
});

test('a market order: immediate-or-cancel at the market price, worth its size at the mark', () => {
  const buy = buildOrder(intent({ kind: 'market', price: 'ignored', tif: 'Gtc' }), BTC);
  assert.deepEqual(buy.order, { coin: 'BTC', is_buy: true, sz: '0.01', limit_px: '70588', reduce_only: false, tif: 'Ioc' });
  assert.equal(buy.marketPx, '70588');
  assert.equal(buy.worthMicro, 685_350_000n, '0.01 x the mark 68,535, not the limit');
  const sell = buildOrder(intent({ kind: 'market', isBuy: false }), BTC);
  assert.equal(sell.order!.limit_px, '67414');
  const none = buildOrder(intent({ kind: 'market' }), coinFacts(market({}, { oracle_px: null, mark_px: null })));
  assert.equal(none.order, null);
  assert.match(none.problems[0]!, /no price for BTC right now/);
});

test('size in USDC: at the limit for a limit order, at the mark for a market order', () => {
  const limit = buildOrder(intent({ size: '500', sizeIn: 'usd', price: '68000' }), BTC);
  assert.equal(limit.order!.sz, '0.00735', '500 / 68,000');
  const atMarket = buildOrder(intent({ kind: 'market', size: '500', sizeIn: 'usd' }), BTC);
  assert.equal(atMarket.order!.sz, '0.00729', '500 / the mark 68,535');
  assert.equal(atMarket.order!.limit_px, '70588');
  assert.deepEqual(buildOrder(intent({ size: '', sizeIn: 'usd' }), BTC).problems, ['Enter an amount in USDC, like 100']);
  assert.deepEqual(buildOrder(intent({ size: '500', sizeIn: 'usd', price: '' }), BTC).problems, ['Enter an amount in USDC, like 100', 'Enter a limit price, like 75000']);
});

test('what stops an order is said in words, and nothing is signed', () => {
  assert.deepEqual(buildOrder(intent({ size: '' }), BTC).problems, ['Enter a size, like 0.01']);
  assert.deepEqual(buildOrder(intent({ size: '0.000001' }), BTC).problems, ['The size rounds to 0: the smallest step is 0.00001']);
  const small = buildOrder(intent({ size: '0.0001' }), BTC);
  assert.equal(small.order, null);
  assert.match(small.problems[0]!, /worth \$6\.85; Hyperliquid's minimum is \$10/);
  assert.match(buildOrder(intent(), coinFacts(market({}, { delisted: true }))).problems[0]!, /isn't listed on Hyperliquid testnet/);
  assert.match(buildOrder(intent(), coinFacts(market({ allowed: false }))).problems[0]!, /isn't on the broker's list/);
  assert.match(buildOrder(intent(), null).problems[0]!, /isn't a market here/);
});

test("a limit price outside the gateway's band is stopped before the wait, with the band in words", () => {
  // The band is 3% around 69,001: 66,930.97 to 71,071.03.
  const high = buildOrder(intent({ price: '72000' }), BTC);
  assert.equal(high.order, null);
  assert.equal(high.problems[0], "The price is 4.35% above the reference price. The broker's risk checks take prices within 3% of it: 66,930 to 71,071.");
  const low = buildOrder(intent({ isBuy: false, price: '60000' }), BTC);
  assert.match(low.problems[0]!, /13\.04% below the reference price/);
  const edge = buildOrder(intent({ price: '71000' }), BTC);
  assert.ok(edge.order, 'inside the band: it can go');
  assert.match(edge.notes[0]!, /near the edge/);
  assert.deepEqual(buildOrder(intent({ price: '69500' }), BTC).notes, []);
});

test('a market order that the book cannot fill inside the band says so before the wait', () => {
  const base = { marketPx: '70036', bestBid: 68536, bestAsk: 68565, szDecimals: 5 };
  assert.equal(marketFillNote({ ...base, isBuy: true }), null, 'the best ask is under the limit: it fills');
  assert.equal(marketFillNote({ ...base, isBuy: true, bestAsk: 70500 }), 'The lowest price on offer is 70,500, above the 70,036 this order can pay. It would not fill right now.');
  assert.equal(marketFillNote({ ...base, isBuy: false, marketPx: '67966' }), null);
  assert.equal(marketFillNote({ ...base, isBuy: false, marketPx: '67966', bestBid: 67000 }), 'The highest bid is 67,000, below the 67,966 this order can accept. It would not fill right now.');
  assert.equal(marketFillNote({ ...base, isBuy: true, bestAsk: null }), null, 'no book: nothing to say');
  assert.equal(marketFillNote({ ...base, isBuy: true, marketPx: null }), null);
});

test('a coin the pool marks reduce-only says so, unless the order is reduce-only', () => {
  const facts = coinFacts(market({ status: { status: 'reduce_only', since: '1', emergency: false } }));
  assert.match(buildOrder(intent(), facts).notes[0]!, /reduce-only for now/);
  assert.deepEqual(buildOrder(intent({ reduceOnly: true }), facts).notes, []);
  assert.match(buildOrder(intent(), coinFacts(market({ status: { status: 'frozen', since: '1', emergency: true } }))).notes[0]!, /marks BTC frozen/);
});

test('a price clicked in the book is rounded for the side picked', () => {
  assert.equal(priceFromBook('68536', true, 5), '68536');
  assert.equal(priceFromBook('1935.87', true, 4), '1935.8');
  assert.equal(priceFromBook('1935.87', false, 4), '1935.9');
  assert.equal(priceFromBook('junk', true, 4), 'junk');
});

test('Close is one order: all of the position, the other side, reduce-only, at the market', () => {
  assert.deepEqual(closeIntent({ coin: 'BTC', szi: '-0.01230' }), { coin: 'BTC', isBuy: true, kind: 'market', size: '0.0123', sizeIn: 'coin', price: '', reduceOnly: true, tif: 'Ioc' });
  assert.deepEqual(closeIntent({ coin: 'ETH', szi: '2.5' })!.isBuy, false, 'a long is closed by selling');
  assert.equal(closeIntent({ coin: 'ETH', szi: '0.0' }), null);
  assert.equal(closeIntent({ coin: 'ETH', szi: 'x' }), null);
  // The whole path: a short of 0.0123 BTC is bought back at the market price, immediate-or-cancel, reduce-only.
  const built = buildOrder(closeIntent({ coin: 'BTC', szi: '-0.0123' })!, BTC);
  assert.deepEqual(built.order, { coin: 'BTC', is_buy: true, sz: '0.0123', limit_px: '70588', reduce_only: true, tif: 'Ioc' });
  assert.equal(orderLabel(built.order!, 'market'), 'Buy 0.0123 BTC at market');
  // A position worth less than Hyperliquid's $10 can still be closed: that minimum is left to Hyperliquid.
  const dust = closeIntent({ coin: 'BTC', szi: '0.0001' })!;
  assert.equal(buildOrder(dust, BTC).order, null);
  assert.deepEqual(buildOrder(dust, BTC, { closing: true }).order, { coin: 'BTC', is_buy: false, sz: '0.0001', limit_px: '67414', reduce_only: true, tif: 'Ioc' });
  assert.equal(orderLabel({ coin: 'ETH', is_buy: false, sz: '0.5', limit_px: '1950', reduce_only: false, tif: 'Gtc' }, 'limit'), 'Sell 0.5 ETH at 1950');
});

// ---------- the gateway's answer ----------

test('an expired message says once that the order waited too long, that nothing was placed, and to sign again', () => {
  const expired = { ok: false, code: 'AUTH', reason: 'the message has expired: sign it again' };
  assert.ok(isExpired(expired));
  assert.deepEqual(resultWords(expired, { kind: 'order' }), {
    ok: false,
    expired: true,
    headline: 'The order waited too long at the risk engine, and its signature ran out. Nothing was placed. Sign again to send it.',
    lines: [],
  });
  assert.equal(resultWords(expired, { kind: 'cancel', oid: 7 }).headline, EXPIRED_WORDS);
  assert.ok(!isExpired({ ok: false, code: 'AUTH', reason: 'the wrong signer' }), 'another AUTH refusal is not an expiry');
  assert.ok(!isExpired({ ok: false, code: 'P2', reason: 'the plan expired' }));
  assert.ok(!isExpired({ ok: true }));
});

test("every other answer comes back in lib/gateway.ts's words", () => {
  const filled = resultWords({ ok: true, status: 'filled', filled_sz: '0.01', avg_px: '68560', sent: { coin: 'BTC', is_buy: true, sz: '0.01', limit_px: '70036', reduce_only: false, tif: 'Ioc' } }, { kind: 'order' });
  assert.deepEqual([filled.ok, filled.expired, filled.headline], [true, false, 'Buy 0.01 BTC at 70036: filled 0.01 at an average 68560.']);
  const refused = resultWords({ ok: false, code: 'P8', reason: 'equity below the initial requirement' }, { kind: 'order' });
  assert.equal(refused.ok, false);
  assert.match(refused.headline, /^Refused by check P8\./);
  assert.deepEqual(refused.lines, ['The gateway says: equity below the initial requirement']);
  assert.equal(resultWords({ ok: true, hl: { response: { data: { statuses: ['success'] } } } }, { kind: 'cancel', oid: 42 }).headline, 'Order 42 is cancelled.');
  const unmatched = resultWords({ ok: false, code: 'HL', reason: 'Hyperliquid refused the order: Order could not immediately match against any resting orders. asset=3' }, { kind: 'order' });
  assert.deepEqual([unmatched.ok, unmatched.expired], [false, false]);
  assert.match(unmatched.headline, /^Nothing was placed\./);
});

test('the progress line is honest about the wait: usually 20 to 60 seconds, and past 30 the one calm line, never an error', () => {
  assert.match(progressWords('signing', 0), /Waiting for your wallet to sign/);
  assert.equal(progressWords('checking', 14.9), "The broker's risk checks are running in a sealed computer: 14 s. This usually takes 20 to 60 seconds.");
  assert.match(progressWords('checking', 30), /30 s\. This usually takes 20 to 60 seconds/);
  // INTERFACES.md 50.4: an order may wait up to its whole life, 230 s on testnet's new gateway.
  assert.equal(progressWords('checking', 75), "The order is waiting its turn at the risk engine. It can take a few minutes on testnet. 75 s so far. You don't need to do anything.");
  assert.match(progressWords('checking', 229), /^The order is waiting its turn at the risk engine\./);
  assert.doesNotMatch(progressWords('checking', 229), /fail|error|expired/i);
  assert.match(progressWords('checking', -3), /: 0 s\./);
});
