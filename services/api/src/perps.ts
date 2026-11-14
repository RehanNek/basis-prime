// INTERFACES.md 49.3: what the Perps screen shows of one market, read from Hyperliquid testnet's public info API.
//
//   GET /api/perps/:coin                      the market's figures, its order book and its last trades (kept 1 s)
//   GET /api/perps/:coin/candles?interval=&n= the price chart's candles (kept 5 s)
//
// Both are open to anyone: they name no client. Only coins of our own list (research/data/universe_v0.json) are
// answered, so the routes can't be used to make the backend ask Hyperliquid about anything else. The answers are
// kept for a moment and shared, so ten open pages cost Hyperliquid what one does.
//
// The request shapes are Hyperliquid's own, checked against @nktkas/hyperliquid 0.33.3's types
// (esm/api/info/_methods): {"type":"metaAndAssetCtxs"}, {"type":"l2Book","coin"}, {"type":"recentTrades","coin"} and
// {"type":"candleSnapshot","req":{"coin","interval","startTime","endTime"}}. Prices and sizes stay the decimal
// strings Hyperliquid gives, so nothing is rounded on the way.
import type { Deps } from "./handlers.js";
import { marketInfo } from "./hl.js";
import { badRequest, HttpError } from "./validate.js";

/** How long each answer is kept. */
export const PERPS_TTL_MS = 1_000;
export const CANDLES_TTL_MS = 5_000;
/** At most this many levels a side, trades and candles in one answer. */
export const BOOK_LEVELS = 20;
export const TRADES_SHOWN = 40;
export const MAX_CANDLES = 500;
export const DEFAULT_CANDLES = 200;

/** Hyperliquid's candle intervals (candleSnapshot's own list), with each one's length in ms. */
export const CANDLE_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "3d": 259_200_000,
  "1w": 604_800_000,
  "1M": 2_592_000_000,
};

interface PerpMeta {
  universe: { name: string }[];
}
interface AssetCtx {
  markPx?: string;
  oraclePx?: string;
  funding?: string;
  openInterest?: string;
  dayNtlVlm?: string;
  prevDayPx?: string;
}
interface Level {
  px: string;
  sz: string;
  n: number;
}
interface Trade {
  side: "B" | "A";
  px: string;
  sz: string;
  time: number;
  tid: number;
}
/** One candle as Hyperliquid gives it: open and close times (ms), and open, close, high, low and volume as strings. */
export interface Candle {
  t: number;
  T: number;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
}

/** The coin as our list writes it, or a 404: the routes answer our own coins only. */
async function ourCoin(deps: Deps, coin: string): Promise<string> {
  if (!/^[A-Za-z0-9]{1,16}$/.test(coin)) throw badRequest("The coin in the path is a perp's name, like BTC");
  const { coins } = await deps.universe();
  const found = coins.find(([name]) => name.toUpperCase() === coin.toUpperCase());
  if (!found) throw new HttpError(404, "unknown_coin", `${coin.slice(0, 16)} isn't one of our perps`);
  return found[0];
}

/** GET /api/perps/:coin. */
export async function getPerp(deps: Deps, coinInPath: string) {
  const coin = await ourCoin(deps, coinInPath);
  return deps.hlCache.get(`perp:${coin}`, PERPS_TTL_MS, async () => {
    const [[meta, ctxs], book, trades] = await Promise.all([
      marketInfo<[PerpMeta, AssetCtx[]]>(deps.hl, deps.hlCache),
      deps.hl.info<{ levels?: [Level[], Level[]] } | null>({ type: "l2Book", coin }),
      deps.hl.info<Trade[] | null>({ type: "recentTrades", coin }),
    ]);
    const index = meta.universe.findIndex((u) => u.name === coin);
    // Listed in our file and not on this network: Hyperliquid testnet doesn't have every mainnet coin.
    if (index < 0) throw new HttpError(404, "not_listed", `${coin} isn't listed on Hyperliquid testnet`);
    const ctx = ctxs[index] ?? {};
    const levels = (side: Level[] | undefined) => (Array.isArray(side) ? side.slice(0, BOOK_LEVELS).map((l) => ({ px: l.px, sz: l.sz, n: l.n })) : []);
    return {
      coin,
      ctx: {
        mark: ctx.markPx ?? null,
        oracle: ctx.oraclePx ?? null,
        /** The current hourly funding rate: positive means longs pay shorts. */
        funding: ctx.funding ?? null,
        open_interest: ctx.openInterest ?? null,
        day_volume: ctx.dayNtlVlm ?? null,
        prev_day_px: ctx.prevDayPx ?? null,
      },
      /** Bids from the highest down, asks from the lowest up, as Hyperliquid orders them. */
      book: { bids: levels(book?.levels?.[0]), asks: levels(book?.levels?.[1]) },
      /** The newest first. `side` is the taker's: "B" bought, "A" sold. */
      trades: (Array.isArray(trades) ? trades : [])
        .slice()
        .sort((a, b) => b.time - a.time)
        .slice(0, TRADES_SHOWN)
        .map((t) => ({ side: t.side, px: t.px, sz: t.sz, time: t.time, tid: t.tid })),
      read_at_ms: deps.now(),
    };
  });
}

/** GET /api/perps/:coin/candles?interval=&n=: the last `n` candles of `interval` (1h and 200 unless said), oldest first. */
export async function getCandles(deps: Deps, coinInPath: string, query: URLSearchParams) {
  const coin = await ourCoin(deps, coinInPath);
  const interval = query.get("interval") || "1h";
  const length = CANDLE_MS[interval];
  if (length === undefined) throw badRequest(`interval must be one of ${Object.keys(CANDLE_MS).join(", ")}`);
  const asked = query.get("n");
  const n = asked === null || asked === "" ? DEFAULT_CANDLES : Number(asked);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CANDLES) throw badRequest(`n must be a whole number from 1 to ${MAX_CANDLES}`);
  return deps.hlCache.get(`candles:${coin}:${interval}:${n}`, CANDLES_TTL_MS, async () => {
    const now = deps.now();
    const candles = await deps.hl.info<Candle[] | null>({ type: "candleSnapshot", req: { coin, interval, startTime: now - n * length, endTime: now } });
    const list = (Array.isArray(candles) ? candles : []).map((c) => ({ t: c.t, T: c.T, o: c.o, c: c.c, h: c.h, l: c.l, v: c.v, n: c.n }));
    return { coin, interval, candles: list.sort((a, b) => a.t - b.t).slice(-n), read_at_ms: now };
  });
}
