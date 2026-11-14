// The Perps page's plain part (INTERFACES.md 49.1 and 49.3): everything it reads and works out, as pure functions.
//   - GET /api/perps/:coin (the market's figures, the order book and the recent trades) and
//     GET /api/perps/:coin/candles, read tolerantly: a number may come as a string, a row may be an object or a pair,
//     and anything that isn't a number is dropped rather than drawn;
//   - the book's rows with their running totals and depth shares, and the spread;
//   - candles as drawable bars with their price, volume and time scales;
//   - the order: the price a market order is sent at (inside the gateway's band), size typed in the coin or in USDC,
//     rounded by Hyperliquid's rules (lib/hl-rules.ts), and the gateway's answer in words.
// Nothing here reads the clock, the network or the browser.
import type { MarketCoin } from './api.ts';
import { cancelWords, EXPIRED_ORDER_WORDS, isExpired, orderWords, type AnswerWords, type GatewayAnswer, type GatewayOrder, type Tif } from './gateway.ts';
import { ownOrderBp } from './hl-reach.ts';
import { bandPercent, decFromNumber, decText, notionalMicro, parseDec, priceBand, roundOrder, roundPrice, type Band } from './hl-rules.ts';
import { orderWaitWords } from './order-life.ts';

// ---------- paths ----------

export const INTERVALS = [
  { id: '1m', ms: 60_000 },
  { id: '5m', ms: 300_000 },
  { id: '15m', ms: 900_000 },
  { id: '1h', ms: 3_600_000 },
  { id: '4h', ms: 14_400_000 },
  { id: '1d', ms: 86_400_000 },
] as const;

export type Interval = (typeof INTERVALS)[number]['id'];

export const intervalMs = (interval: Interval): number => INTERVALS.find((i) => i.id === interval)!.ms;

/** How many candles the chart asks for: more than the widest screen draws. */
export const CANDLES_ASKED = 240;

export const perpsPath = (coin: string): string => `/api/perps/${encodeURIComponent(coin)}`;
export const candlesPath = (coin: string, interval: Interval, n: number = CANDLES_ASKED): string =>
  `/api/perps/${encodeURIComponent(coin)}/candles?interval=${interval}&n=${n}`;

// ---------- reading numbers ----------

/** A finite number from a number or a numeric string; null for anything else. */
export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The first of these keys that holds a number. */
function pick(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const n = num(row[key]);
    if (n !== null) return n;
  }
  return null;
}

/** A price or size as Hyperliquid writes it, without trailing zeros: "68536.0" -> "68536". */
function plain(value: unknown, fallback: number): string {
  const dec = typeof value === 'string' ? parseDec(value) : null;
  return dec ? decText(dec) : String(fallback);
}

// ---------- GET /api/perps/:coin ----------

/** The market's figures (Hyperliquid's metaAndAssetCtxs). Each is null when the answer didn't carry it. */
export interface PerpsCtx {
  mark: number | null;
  oracle: number | null;
  /** The hourly funding rate: 0.0000125 is 0.00125% an hour, and positive means longs pay shorts. */
  funding: number | null;
  /** In the coin's own units. */
  openInterest: number | null;
  /** The last 24 hours' traded value, in dollars. */
  dayVolume: number | null;
  prevDayPx: number | null;
}

export interface BookLevel {
  px: number;
  sz: number;
  /** The price as Hyperliquid wrote it, for the order form. */
  pxText: string;
}

export interface PerpsTrade {
  time: number;
  px: number;
  sz: number;
  pxText: string;
  /** The taker bought. */
  isBuy: boolean;
  id: string;
}

export interface PerpsMarket {
  coin: string | null;
  ctx: PerpsCtx;
  /** Best first: bids from the highest price down, asks from the lowest up. */
  bids: BookLevel[];
  asks: BookLevel[];
  /** Newest first. */
  trades: PerpsTrade[];
  readAtMs: number | null;
}

const EMPTY_CTX: PerpsCtx = { mark: null, oracle: null, funding: null, openInterest: null, dayVolume: null, prevDayPx: null };

function parseCtx(raw: unknown): PerpsCtx {
  if (!isObject(raw)) return EMPTY_CTX;
  return {
    mark: pick(raw, ['mark', 'mark_px', 'markPx']),
    oracle: pick(raw, ['oracle', 'oracle_px', 'oraclePx']),
    funding: pick(raw, ['funding']),
    openInterest: pick(raw, ['open_interest', 'openInterest']),
    dayVolume: pick(raw, ['day_volume', 'day_ntl_vlm', 'dayNtlVlm']),
    prevDayPx: pick(raw, ['prev_day_px', 'prevDayPx']),
  };
}

/** One side of the book: rows as {px, sz} (Hyperliquid's l2Book) or as [px, sz]. Rows without a price and a size above 0 are dropped. */
function parseLevels(raw: unknown, side: 'bids' | 'asks'): BookLevel[] {
  if (!Array.isArray(raw)) return [];
  const levels: BookLevel[] = [];
  for (const row of raw) {
    const pxRaw = Array.isArray(row) ? row[0] : isObject(row) ? (row.px ?? row.price) : undefined;
    const szRaw = Array.isArray(row) ? row[1] : isObject(row) ? (row.sz ?? row.size) : undefined;
    const px = num(pxRaw);
    const sz = num(szRaw);
    if (px === null || sz === null || px <= 0 || sz <= 0) continue;
    levels.push({ px, sz, pxText: plain(pxRaw, px) });
  }
  return levels.sort((a, b) => (side === 'bids' ? b.px - a.px : a.px - b.px));
}

/** How many trades the page keeps. */
export const TRADES_KEPT = 40;

function parseTrades(raw: unknown): PerpsTrade[] {
  if (!Array.isArray(raw)) return [];
  const trades: PerpsTrade[] = [];
  raw.forEach((row, i) => {
    if (!isObject(row)) return;
    const px = num(row.px ?? row.price);
    const sz = num(row.sz ?? row.size);
    const time = num(row.time ?? row.t);
    if (px === null || sz === null || time === null || px <= 0 || sz <= 0) return;
    const side = String(row.side ?? '').toLowerCase();
    trades.push({ time, px, sz, pxText: plain(row.px ?? row.price, px), isBuy: side === 'b' || side === 'buy' || row.is_buy === true, id: `${String(row.tid ?? row.hash ?? time)}-${i}` });
  });
  return trades.sort((a, b) => b.time - a.time).slice(0, TRADES_KEPT);
}

/**
 * GET /api/perps/:coin: {"coin", "ctx", "book": {"bids", "asks"}, "trades", "read_at_ms"}. Hyperliquid's own
 * l2Book shape ("levels": [bids, asks]) is read too. Null when the answer isn't an object at all.
 */
export function parsePerps(raw: unknown): PerpsMarket | null {
  if (!isObject(raw)) return null;
  const book = isObject(raw.book) ? raw.book : {};
  const levels = Array.isArray(book.levels) ? book.levels : [];
  return {
    coin: typeof raw.coin === 'string' ? raw.coin : null,
    ctx: parseCtx(raw.ctx),
    bids: parseLevels(book.bids ?? levels[0], 'bids'),
    asks: parseLevels(book.asks ?? levels[1], 'asks'),
    trades: parseTrades(raw.trades),
    readAtMs: num(raw.read_at_ms),
  };
}

// ---------- the top bar ----------

/**
 * The figures GET /api/markets already has for a coin (testnet's mark, oracle, funding and day volume): what the top
 * bar shows while GET /api/perps/:coin hasn't answered, or can't. It has no open interest and no price a day ago.
 */
export function ctxFromMarkets(coin: MarketCoin | undefined | null): PerpsCtx {
  const listed = coin?.testnet && !coin.testnet.delisted ? coin.testnet : null;
  if (!listed) return EMPTY_CTX;
  return { mark: num(listed.mark_px), oracle: num(listed.oracle_px), funding: num(listed.funding), openInterest: null, dayVolume: num(listed.day_ntl_vlm), prevDayPx: null };
}

/** The live figures, each falling back to the markets list's when the live answer lacks it. */
export function mergeCtx(live: PerpsCtx | null | undefined, fallback: PerpsCtx): PerpsCtx {
  if (!live) return fallback;
  return {
    mark: live.mark ?? fallback.mark,
    oracle: live.oracle ?? fallback.oracle,
    funding: live.funding ?? fallback.funding,
    openInterest: live.openInterest ?? fallback.openInterest,
    dayVolume: live.dayVolume ?? fallback.dayVolume,
    prevDayPx: live.prevDayPx ?? fallback.prevDayPx,
  };
}

/** Dollars in short: 2082333.6 -> "$2.08M", 741870 -> "$741.9K", 950.5 -> "$951". */
export function compactUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '–';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** A price for reading: grouped, with the decimals the coin's prices may have (5 significant figures, 6 - szDecimals decimals). */
export function priceText(value: number | null, szDecimals: number): string {
  if (value === null || !Number.isFinite(value) || value < 0) return '–';
  const dec = decFromNumber(value);
  if (!dec) return '–';
  const [whole, fraction] = decText(roundPrice(dec, szDecimals, 'down')).split('.');
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}`;
}

export type Direction = 'up' | 'down' | 'flat';

export interface Change {
  /** The move in the coin's price, signed: "-4,835" or "+12.5". */
  abs: string;
  /** "-6.59%". */
  pct: string;
  dir: Direction;
}

/** The 24-hour change: the mark against the price a day ago. Null when either is missing. */
export function dayChange(mark: number | null, prevDayPx: number | null, szDecimals: number): Change | null {
  if (mark === null || prevDayPx === null || prevDayPx <= 0) return null;
  const diff = mark - prevDayPx;
  const pct = (diff / prevDayPx) * 100;
  const dir: Direction = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
  const sign = diff > 0 ? '+' : diff < 0 ? '-' : '';
  return { abs: `${sign}${priceText(Math.abs(diff), szDecimals)}`, pct: `${sign}${Math.abs(pct).toFixed(2)}%`, dir };
}

/** The hourly funding rate as a percentage, "0.0013%", with who pays whom. */
export function fundingText(rate: number | null): { text: string; who: string; dir: Direction } | null {
  if (rate === null) return null;
  const pct = rate * 100;
  return {
    text: `${pct < 0 ? '-' : ''}${Math.abs(pct).toFixed(4)}%`,
    who: rate > 0 ? 'Longs pay shorts, every hour' : rate < 0 ? 'Shorts pay longs, every hour' : 'Nobody pays this hour',
    dir: rate > 0 ? 'up' : rate < 0 ? 'down' : 'flat',
  };
}

/** Open interest comes in the coin's units: shown in dollars at the mark, with the coins beside it. */
export function openInterestText(openInterest: number | null, mark: number | null, coin: string): { usd: string; coins: string } | null {
  if (openInterest === null) return null;
  const coins = `${openInterest.toLocaleString('en-US', { maximumFractionDigits: openInterest >= 1000 ? 0 : 2 })} ${coin}`;
  return { usd: mark === null ? '–' : compactUsd(openInterest * mark), coins };
}

// ---------- the order book ----------

export interface BookRow {
  px: number;
  pxText: string;
  sz: number;
  /** This level's size and every better one's on its side, added up. */
  total: number;
  /** `total` as a share (0 to 1) of the deepest total shown on either side: the width of the bar behind the row. */
  share: number;
}

export interface Spread {
  bid: number;
  ask: number;
  abs: number;
  /** As a percentage of the middle price. */
  pct: number;
  mid: number;
}

export interface BookView {
  /** Best first on both sides: the page draws the asks bottom-up, so the two best prices meet at the spread. */
  bids: BookRow[];
  asks: BookRow[];
  spread: Spread | null;
}

/** The best `depth` levels of one side with their running totals. `share` is left at 0 for `bookView` to set. */
export function bookRows(levels: BookLevel[], depth: number): BookRow[] {
  let total = 0;
  return levels.slice(0, Math.max(0, depth)).map((level) => {
    total += level.sz;
    return { px: level.px, pxText: level.pxText, sz: level.sz, total, share: 0 };
  });
}

/** The gap between the best bid and the best ask. Null when a side is empty, or the book is crossed. */
export function spreadOf(bestBid: number | null | undefined, bestAsk: number | null | undefined): Spread | null {
  if (typeof bestBid !== 'number' || typeof bestAsk !== 'number' || !(bestBid > 0) || !(bestAsk > 0) || bestAsk < bestBid) return null;
  const mid = (bestBid + bestAsk) / 2;
  const abs = bestAsk - bestBid;
  return { bid: bestBid, ask: bestAsk, abs, pct: (abs / mid) * 100, mid };
}

/** Both sides, `depth` levels each, with every row's depth share measured against the deeper side. */
export function bookView(bids: BookLevel[], asks: BookLevel[], depth: number): BookView {
  const bidRows = bookRows(bids, depth);
  const askRows = bookRows(asks, depth);
  const deepest = Math.max(bidRows.at(-1)?.total ?? 0, askRows.at(-1)?.total ?? 0);
  const withShare = (rows: BookRow[]) => rows.map((row) => ({ ...row, share: deepest > 0 ? Math.min(1, row.total / deepest) : 0 }));
  return { bids: withShare(bidRows), asks: withShare(askRows), spread: spreadOf(bids[0]?.px, asks[0]?.px) };
}

/** A size with the coin's decimals, so a column of them lines up: 0.0003 with 5 decimals -> "0.00030". */
export function sizeText(size: number, szDecimals: number): string {
  if (!Number.isFinite(size)) return '–';
  return size.toLocaleString('en-US', { minimumFractionDigits: szDecimals, maximumFractionDigits: szDecimals });
}

// ---------- candles ----------

export interface Candle {
  /** When the candle opened, ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * Hyperliquid's candleSnapshot rows ({t, T, s, i, o, c, h, l, v, n}, numbers as strings), as a list or under
 * "candles". A row without a time or one of its four prices is dropped; a high below, or a low above, the open and
 * close is stretched to hold them; a missing volume counts as 0. Oldest first, one candle per opening time (the later
 * row wins).
 */
export function parseCandles(raw: unknown): Candle[] {
  const rows = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.candles) ? raw.candles : [];
  const byTime = new Map<number, Candle>();
  for (const row of rows) {
    if (!isObject(row)) continue;
    const t = num(row.t);
    const o = num(row.o);
    const h = num(row.h);
    const l = num(row.l);
    const c = num(row.c);
    if (t === null || o === null || h === null || l === null || c === null) continue;
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
    const v = num(row.v);
    byTime.set(t, { t, o, c, h: Math.max(h, o, c), l: Math.min(l, o, c), v: v !== null && v > 0 ? v : 0 });
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/** Below this many candles the chart says the market is thin. */
export const MIN_CANDLES = 10;
export const THIN_WORDS = 'Testnet has few trades in this market';

/** What the chart says about its data: nothing when there is enough, the thin line when there is little or none. */
export function candleNote(candles: Candle[]): string | null {
  return candles.length < MIN_CANDLES || candles.every((c) => c.v === 0) ? THIN_WORDS : null;
}

export interface ChartBox {
  width: number;
  height: number;
}

export interface ChartBar {
  candle: Candle;
  /** The bar's middle. */
  x: number;
  /** The wick, top (the high) to bottom (the low). y grows downward. */
  wickTop: number;
  wickBottom: number;
  /** The body, between the open and the close, at least 1 pixel tall. */
  bodyTop: number;
  bodyHeight: number;
  /** The close is at or above the open. */
  up: boolean;
  volTop: number;
  volHeight: number;
}

export interface ChartModel {
  /** The price pane and, under it, the volume pane. */
  plot: { left: number; right: number; top: number; bottom: number };
  volume: { top: number; bottom: number };
  /** The distance between two bars' middles, and a body's width. */
  step: number;
  bodyWidth: number;
  bars: ChartBar[];
  /** The price scale's ends, with a little air around the candles. */
  min: number;
  max: number;
  priceTicks: { y: number; price: number }[];
  timeTicks: { x: number; t: number }[];
  /** The last close: its line and label. */
  last: { y: number; price: number; up: boolean };
}

/** The chart's fixed measures: the price axis on the right, the time axis at the bottom, the volume pane's share. */
export const CHART = { axisRight: 62, axisBottom: 20, padTop: 8, gap: 6, volumeShare: 0.18, minStep: 6, maxStep: 14 } as const;

/** Round steps for a scale: 1, 2, 2.5 or 5 times a power of ten, giving about `count` ticks between min and max. */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min) || count < 1) return [];
  const rough = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough)!;
  const ticks: number[] = [];
  for (let k = Math.ceil(min / step); k * step <= max; k += 1) ticks.push(Number((k * step).toPrecision(12)));
  return ticks;
}

/**
 * The candles as bars in a box of pixels. The newest candle sits at the right edge and each bar takes `step` pixels,
 * between CHART.minStep and CHART.maxStep: a narrow box shows only the newest candles that fit, and a few candles
 * stay slim at the right instead of being stretched across. A price range of nothing (one flat candle) gets half a
 * percent of air each side, so nothing divides by zero. Null when there is no candle, or the box is too small to draw in.
 */
export function chartModel(candles: Candle[], box: ChartBox): ChartModel | null {
  const plot = { left: 0, right: box.width - CHART.axisRight, top: CHART.padTop, bottom: 0 };
  const below = box.height - CHART.axisBottom;
  const volumeHeight = Math.round((below - plot.top) * CHART.volumeShare);
  plot.bottom = below - volumeHeight - CHART.gap;
  const width = plot.right - plot.left;
  if (candles.length === 0 || !(width >= CHART.minStep * 2) || !(plot.bottom - plot.top >= 40)) return null;

  const shown = candles.slice(-Math.max(1, Math.floor(width / CHART.minStep)));
  const step = Math.min(CHART.maxStep, Math.max(CHART.minStep, width / shown.length));
  const bodyWidth = Math.max(1, Math.floor(step * 0.68));

  let low = Math.min(...shown.map((c) => c.l));
  let high = Math.max(...shown.map((c) => c.h));
  const air = high > low ? (high - low) * 0.06 : Math.max(high * 0.005, 1e-9);
  low -= air;
  high += air;
  const yOf = (price: number) => plot.top + ((high - price) / (high - low)) * (plot.bottom - plot.top);
  const maxVolume = Math.max(...shown.map((c) => c.v));
  const volume = { top: plot.bottom + CHART.gap, bottom: below };

  const bars: ChartBar[] = shown.map((candle, i) => {
    const x = plot.right - step / 2 - (shown.length - 1 - i) * step;
    const bodyTop = yOf(Math.max(candle.o, candle.c));
    const volHeight = maxVolume > 0 ? Math.max(candle.v > 0 ? 1 : 0, (candle.v / maxVolume) * (volume.bottom - volume.top)) : 0;
    return {
      candle,
      x,
      wickTop: yOf(candle.h),
      wickBottom: yOf(candle.l),
      bodyTop,
      bodyHeight: Math.max(1, yOf(Math.min(candle.o, candle.c)) - bodyTop),
      up: candle.c >= candle.o,
      volTop: volume.bottom - volHeight,
      volHeight,
    };
  });

  const priceTicks = niceTicks(low, high, Math.max(2, Math.floor((plot.bottom - plot.top) / 56))).map((price) => ({ y: yOf(price), price }));
  // A time label about every 90 pixels, on the bars themselves.
  const every = Math.max(1, Math.ceil(90 / step));
  const timeTicks = bars.filter((_, i) => (bars.length - 1 - i) % every === Math.floor(every / 2)).map((bar) => ({ x: bar.x, t: bar.candle.t }));
  const lastCandle = shown.at(-1)!;
  return { plot, volume, step, bodyWidth, bars, min: low, max: high, priceTicks, timeTicks, last: { y: yOf(lastCandle.c), price: lastCandle.c, up: lastCandle.c >= lastCandle.o } };
}

/** The crosshair's candle: the bar nearest to x. Null with no bars, or when x is outside the price and volume panes. */
export function barAt(model: ChartModel, x: number): ChartBar | null {
  if (model.bars.length === 0 || x < model.plot.left || x > model.plot.right) return null;
  const first = model.bars[0]!.x;
  const i = Math.round((x - first) / model.step);
  return model.bars[Math.min(model.bars.length - 1, Math.max(0, i))] ?? null;
}

/** The crosshair's price: what y stands for on the price scale. Null outside the price pane. */
export function priceAt(model: ChartModel, y: number): number | null {
  const { top, bottom } = model.plot;
  if (y < top || y > bottom) return null;
  return model.max - ((y - top) / (bottom - top)) * (model.max - model.min);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');

/**
 * A candle's time for the axis: "14:35" within a day, "13 Nov" for daily candles and for the first candle of a day.
 * `full` is the crosshair's: "13 Nov 14:35". Local time, or UTC for the tests.
 */
export function timeLabel(tMs: number, interval: Interval, opts: { full?: boolean; utc?: boolean } = {}): string {
  const d = new Date(tMs);
  const [day, month, hours, minutes] = opts.utc ? [d.getUTCDate(), d.getUTCMonth(), d.getUTCHours(), d.getUTCMinutes()] : [d.getDate(), d.getMonth(), d.getHours(), d.getMinutes()];
  const date = `${day} ${MONTHS[month]}`;
  const clock = `${two(hours)}:${two(minutes)}`;
  if (interval === '1d') return date;
  if (opts.full) return `${date} ${clock}`;
  return hours === 0 && minutes === 0 ? date : clock;
}

/** A candle's own move, for the crosshair's line: "+0.36%". */
export function candleChange(candle: Candle): { pct: string; dir: Direction } {
  const pct = candle.o > 0 ? ((candle.c - candle.o) / candle.o) * 100 : 0;
  return { pct: `${pct > 0 ? '+' : pct < 0 ? '-' : ''}${Math.abs(pct).toFixed(2)}%`, dir: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' };
}

// ---------- the order ----------

/** What the form needs to know about a coin: is it listed on testnet, its size rule, its prices and its band. */
export interface CoinFacts {
  coin: string;
  allowed: boolean;
  /** Listed on Hyperliquid testnet, and not delisted. */
  listed: boolean;
  szDecimals: number;
  mark: number | null;
  /** The price the gateway's band is measured from: testnet's oracle, else its mark (as the trade page takes it). */
  reference: number | null;
  band: Band | null;
  bandBp: number;
  /** The pool's status for the coin when it isn't plainly allowed: "reduce_only", "removed", "frozen". */
  status: string | null;
}

/** The same reading of GET /api/markets as the trade page's: testnet's size rule wins, and the oracle is the reference. */
export function coinFacts(coin: MarketCoin | undefined | null): CoinFacts | null {
  if (!coin) return null;
  const listed = coin.testnet && !coin.testnet.delisted ? coin.testnet : null;
  const oracle = num(listed?.oracle_px);
  const mark = num(listed?.mark_px);
  const reference = oracle ?? mark;
  return {
    coin: coin.coin,
    allowed: coin.allowed,
    listed: Boolean(listed),
    szDecimals: listed?.sz_decimals ?? coin.universe_sz_decimals,
    mark,
    reference,
    band: reference !== null && reference > 0 ? priceBand(reference, coin.band_bp) : null,
    bandBp: coin.band_bp,
    status: coin.status && coin.status.status !== 'allowed' ? coin.status.status : null,
  };
}

/**
 * The markets list's row for a coin with the live mark and oracle laid over it. The list is read every 30 seconds and
 * the market every second, so the form prices a market order from the same figures the top bar shows. A coin testnet
 * doesn't list, and a figure the live answer lacks, stay as the list has them.
 */
export function withLivePrices(coin: MarketCoin | undefined | null, live: PerpsCtx | null | undefined): MarketCoin | null {
  if (!coin) return null;
  if (!live || !coin.testnet || coin.testnet.delisted) return coin;
  return { ...coin, testnet: { ...coin.testnet, mark_px: live.mark !== null ? String(live.mark) : coin.testnet.mark_px, oracle_px: live.oracle !== null ? String(live.oracle) : coin.testnet.oracle_px } };
}

/** The coins the picker offers: the allow-listed ones, those Hyperliquid testnet lists first. */
export function pickerCoins(coins: MarketCoin[]): { coin: string; listed: boolean }[] {
  return coins
    .filter((c) => c.allowed)
    .map((c) => ({ coin: c.coin, listed: Boolean(c.testnet && !c.testnet.delisted) }))
    .sort((a, b) => Number(b.listed) - Number(a.listed));
}

/**
 * The limit price of a market order: an immediate-or-cancel limit past the reference on the side that fills, inside
 * the band, rounded to Hyperliquid's rules toward the reference (a buy down, a sell up). How far past is one rule for
 * every order this app means to fill at once (lib/hl-reach.ts, ownOrderBp): 2.3% with testnet's 3% band. The very edge
 * of the band would often be refused, since the gateway measures from its own reference price (P2). Null without a
 * reference price.
 */
export function marketPrice(input: { reference: number | null; bandBp: number; isBuy: boolean; szDecimals: number }): string | null {
  if (input.reference === null || !(input.reference > 0)) return null;
  const target = input.reference * (1 + ((input.isBuy ? 1 : -1) * ownOrderBp(input.bandBp)) / 10_000);
  const dec = decFromNumber(target);
  if (!dec) return null;
  const rounded = roundPrice(dec, input.szDecimals, input.isBuy ? 'down' : 'up');
  return rounded.units > 0n ? decText(rounded) : null;
}

/** USDC typed into the size field, as the coin's size at `price`, cut down to the coin's decimals. Exact. */
export function coinFromUsd(usd: string, price: string, szDecimals: number): string | null {
  const u = parseDec(usd);
  const p = parseDec(price);
  if (!u || !p || p.units === 0n) return null;
  const units = (u.units * 10n ** BigInt(p.scale + szDecimals)) / (p.units * 10n ** BigInt(u.scale));
  return decText({ units, scale: szDecimals });
}

/** A size in the coin as dollars at `price`, to the cent, rounded down: what the field shows after switching to USDC. */
export function usdFromCoin(size: string, price: string): string | null {
  const s = parseDec(size);
  const p = parseDec(price);
  if (!s || !p) return null;
  return decText({ units: notionalMicro(s, p) / 10_000n, scale: 2 });
}

export type OrderKind = 'limit' | 'market';
export type SizeUnit = 'coin' | 'usd';

/** What the client asked for, before any rounding. */
export interface OrderIntent {
  coin: string;
  isBuy: boolean;
  kind: OrderKind;
  size: string;
  sizeIn: SizeUnit;
  /** The limit price typed; a market order ignores it. */
  price: string;
  reduceOnly: boolean;
  /** A limit order's; a market order is always immediate-or-cancel. */
  tif: Tif;
}

export interface BuiltOrder {
  /** What the wallet will sign, or null while something stops it. */
  order: GatewayOrder | null;
  /** The order's worth in micro-USD: at its limit, or for a market order at the mark. */
  worthMicro: bigint;
  /** The price a market order is sent at. */
  marketPx: string | null;
  /** Why it can't be sent, in words. */
  problems: string[];
  /** What rounding changed, and what to know before sending. */
  notes: string[];
}

/**
 * The order the wallet signs, from what was typed and the coin's facts.
 *   - Market: the limit is `marketPrice`, immediate-or-cancel. USDC is turned into a size at the mark.
 *   - Limit: the typed price, rounded so it is never worse than typed. USDC is turned into a size at that price.
 *   - A limit price outside the gateway's band stops the order here, with the band in words: the gateway would
 *     refuse it (P2) after the wait.
 *   - `closing`: the order closes a whole position. Hyperliquid's $10 minimum is then left for Hyperliquid to judge,
 *     so a small position can still be closed from here.
 */
export function buildOrder(intent: OrderIntent, facts: CoinFacts | null, opts: { closing?: boolean } = {}): BuiltOrder {
  const none = (problem: string): BuiltOrder => ({ order: null, worthMicro: 0n, marketPx: null, problems: [problem], notes: [] });
  if (!facts) return none(`${intent.coin} isn't a market here.`);
  if (!facts.listed) return none(`${intent.coin} isn't listed on Hyperliquid testnet, so it can't be traded here.`);
  if (!facts.allowed) return none(`${intent.coin} isn't on the broker's list of coins.`);

  const market = intent.kind === 'market';
  const marketPx = market ? marketPrice({ reference: facts.reference, bandBp: facts.bandBp, isBuy: intent.isBuy, szDecimals: facts.szDecimals }) : null;
  if (market && !marketPx) return none(`There is no price for ${intent.coin} right now, so a market order can't be sent. Use a limit order.`);
  const price = market ? marketPx! : intent.price;

  const markDec = facts.mark !== null && facts.mark > 0 ? decFromNumber(facts.mark) : null;
  let size = intent.size;
  if (intent.sizeIn === 'usd') {
    // A market order fills near the mark, not at its limit, so that is the price its dollars are counted at.
    const at = market ? (markDec ? decText(markDec) : price) : roundedPrice(price, intent.isBuy, facts.szDecimals);
    size = (at && coinFromUsd(intent.size, at, facts.szDecimals)) || '';
  }

  const rounded = roundOrder({ size, price, isBuy: intent.isBuy, szDecimals: facts.szDecimals });
  // In USDC the size field holds dollars, so its hint is in dollars too.
  const problems = rounded.problems
    .filter((p) => !(opts.closing && p.includes("Hyperliquid's minimum")))
    .map((p) => (intent.sizeIn === 'usd' && p.startsWith('Enter a size') ? 'Enter an amount in USDC, like 100' : p));
  const notes = market ? rounded.changes.filter((c) => c.startsWith('size')) : [...rounded.changes];
  const limit = num(rounded.limitPx);
  if (!market && facts.band && limit !== null && limit > 0) {
    const off = Math.abs(limit / facts.band.reference - 1) * 10_000;
    if (off > facts.band.bandBp) {
      problems.push(
        `The price is ${(off / 100).toFixed(2)}% ${limit > facts.band.reference ? 'above' : 'below'} the reference price. The broker's risk checks take prices within ${bandPercent(facts.bandBp)} of it: ` +
          `${priceText(facts.band.low, facts.szDecimals)} to ${priceText(facts.band.high, facts.szDecimals)}.`,
      );
    } else if (off > facts.band.bandBp * 0.9) {
      notes.push('The price is near the edge of what the risk checks take. They measure from their own reference price, so it may be refused.');
    }
  }
  if (facts.status === 'reduce_only' && !intent.reduceOnly) notes.push(`${facts.coin} is reduce-only for now: only orders that shrink a position pass.`);
  else if (facts.status && facts.status !== 'reduce_only') notes.push(`The broker marks ${facts.coin} ${facts.status.replace('_', '-')}: the order may be refused.`);

  const sz = parseDec(rounded.sz);
  const worthMicro = market && sz && markDec ? notionalMicro(sz, markDec) : rounded.notionalMicro;
  const order: GatewayOrder | null =
    problems.length === 0 ? { coin: facts.coin, is_buy: intent.isBuy, sz: rounded.sz, limit_px: rounded.limitPx, reduce_only: intent.reduceOnly, tif: market ? 'Ioc' : intent.tif } : null;
  return { order, worthMicro, marketPx, problems, notes };
}

/**
 * A market order only fills against prices up to its limit. When the best price on the other side of the book is
 * already past that limit, the order would be cancelled unfilled: this says so before the wait. Null when it can fill,
 * or when the book's best price isn't known.
 */
export function marketFillNote(input: { isBuy: boolean; marketPx: string | null; bestBid: number | null | undefined; bestAsk: number | null | undefined; szDecimals: number }): string | null {
  const limit = num(input.marketPx);
  if (limit === null) return null;
  if (input.isBuy && typeof input.bestAsk === 'number' && input.bestAsk > limit) {
    return `The lowest price on offer is ${priceText(input.bestAsk, input.szDecimals)}, above the ${priceText(limit, input.szDecimals)} this order can pay. It would not fill right now.`;
  }
  if (!input.isBuy && typeof input.bestBid === 'number' && input.bestBid < limit) {
    return `The highest bid is ${priceText(input.bestBid, input.szDecimals)}, below the ${priceText(limit, input.szDecimals)} this order can accept. It would not fill right now.`;
  }
  return null;
}

/** A typed limit price rounded the safe way for its side, or null when it isn't a price. */
function roundedPrice(price: string, isBuy: boolean, szDecimals: number): string | null {
  const dec = parseDec(price);
  if (!dec || dec.units === 0n) return null;
  return decText(roundPrice(dec, szDecimals, isBuy ? 'down' : 'up'));
}

/** A price clicked in the book, as the form's limit price: rounded to the coin's rules for the side picked. */
export function priceFromBook(pxText: string, isBuy: boolean, szDecimals: number): string {
  return roundedPrice(pxText, isBuy, szDecimals) ?? pxText;
}

/**
 * Closing a position in one click: a market order for all of it on the other side, reduce-only. `szi` is
 * Hyperliquid's signed size as it wrote it ("-0.0123" is a short), so the size is exact.
 */
export function closeIntent(position: { coin: string; szi: string }): OrderIntent | null {
  const text = position.szi.trim();
  const short = text.startsWith('-');
  const size = parseDec(short ? text.slice(1) : text);
  if (!size || size.units === 0n) return null;
  return { coin: position.coin, isBuy: short, kind: 'market', size: decText(size), sizeIn: 'coin', price: '', reduceOnly: true, tif: 'Ioc' };
}

/** "Buy 0.01 BTC at market" or "Sell 0.5 ETH at 1,950": what an order is, for the button, the progress line and the result. */
export function orderLabel(order: GatewayOrder, kind: OrderKind): string {
  return `${order.is_buy ? 'Buy' : 'Sell'} ${order.sz} ${order.coin} ${kind === 'market' ? 'at market' : `at ${order.limit_px}`}`;
}

/** The smallest size the coin trades in: 5 decimals -> "0.00001". */
export function sizeStep(szDecimals: number): string {
  return decText({ units: 1n, scale: szDecimals });
}

// ---------- the gateway's answer ----------

/** What the page says when the gateway answers that the signed message ran out: every page's words (INTERFACES.md 50.4), once, with "Sign again". */
export const EXPIRED_WORDS = EXPIRED_ORDER_WORDS;
export { isExpired };

export interface ResultWords extends AnswerWords {
  /** The signed message ran out before the gateway read it: nothing was placed, and "Sign again" signs a fresh one. */
  expired: boolean;
}

/**
 * An order's or a cancel's answer in words: lib/gateway.ts's, except for the two cases this page words itself. An
 * expired message gets `EXPIRED_WORDS`. An immediate-or-cancel order that met nothing on the book says so plainly.
 */
export function resultWords(answer: GatewayAnswer, what: { kind: 'order' } | { kind: 'cancel'; oid: number }): ResultWords {
  if (isExpired(answer)) return { ok: false, expired: true, headline: EXPIRED_WORDS, lines: [] };
  if (!answer.ok && answer.code === 'HL' && /could not immediately match/i.test(answer.reason ?? '')) {
    return { ok: false, expired: false, headline: 'Nothing was placed. There was nobody to trade with at a price the risk checks take.', lines: ['Try again in a moment, or place a limit order and let it rest on the book.'] };
  }
  const words = what.kind === 'order' ? orderWords(answer) : cancelWords(answer, what.oid);
  return { ...words, expired: false };
}

export type Waiting = 'signing' | 'checking';

/**
 * The line while an order is on its way, with the seconds so far. The gateway runs in a sealed computer and takes one
 * order at a time: usually 20 to 60 seconds. Past 30 seconds the line is the calm one of INTERFACES.md 50.4: the order
 * is waiting its turn, which is not an error, and the page waits for as long as the order lives.
 */
export function progressWords(phase: Waiting, seconds: number, network: 'testnet' | 'mainnet' = 'testnet'): string {
  if (phase === 'signing') return 'Waiting for your wallet to sign. Nothing is sent until you do.';
  const s = Math.max(0, Math.floor(seconds));
  const calm = orderWaitWords(s * 1000, network);
  if (calm) return `${calm} ${s} s so far. You don't need to do anything.`;
  return `The broker's risk checks are running in a sealed computer: ${s} s. This usually takes 20 to 60 seconds.`;
}
