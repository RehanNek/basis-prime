// Don't let a client start an order Hyperliquid can't take (INTERFACES.md 50.4). Hyperliquid testnet takes no trade
// more than about 2.4% from its oracle price, and its own mark often stands that far out: then no order in that
// market can fill. The keeper's gates work this out before they open a hedge (services/keeper/src/hedge-kit.ts:
// HL_TESTNET_REACH_BP, BAND_EDGE_BP, reachOf, hedgeNow); this is the same rule with the same figures, from the mark
// and oracle price the markets answer already carries. Testnet only: on mainnet nothing here stops anything.

/** Hyperliquid testnet's own limit on a trade's distance from its oracle price, in bp (hedge-kit.ts, HL_TESTNET_REACH_BP). */
export const HL_TESTNET_REACH_BP = 240;
/** How far inside the gateway band's edge a price stays, in bp (hedge-kit.ts, BAND_EDGE_BP). */
export const BAND_EDGE_BP = 10;

/**
 * How far from the oracle price an order may be, in bp, and whether Hyperliquid's own limit is what sets it
 * (hedge-kit.ts, reachOf): the nearer of Hyperliquid's 2.4% and the account's gateway band less its edge. With a 3%
 * band that is Hyperliquid's 2.4%; with an older gateway's 1%, the band's 0.9%.
 */
export function reachOf(bandBp: number): { bp: number; venue: boolean } {
  const band = bandBp - BAND_EDGE_BP;
  return HL_TESTNET_REACH_BP < band ? { bp: HL_TESTNET_REACH_BP, venue: true } : { bp: band, venue: false };
}

/** How far through the mark an order has to be priced to meet the book, in bp: the keeper's own 0.3% (hedge-kit.ts, THROUGH_MARK_BP). */
export const THROUGH_MARK_BP = 30;

/**
 * How far past the reference price this app prices an order that should fill at once (a market order on Perps, the
 * Basis trade's short and its close, the setup's short): as far as an order may be priced, less a tenth of a percent,
 * because the gateway and Hyperliquid each measure from a price of their own, a little off the one this page sees.
 * With testnet's 3% band that is 2.3%; with a 1% band, 0.8%. Until 14 Nov it was half the band (1.5%), which marked a
 * coin as not trading while the keeper's own runs, priced out to 2.4%, still traded it.
 */
export const ownOrderBp = (bandBp: number): number => Math.max(0, reachOf(bandBp).bp - BAND_EDGE_BP);

/**
 * How far the mark may stand from the oracle price before such an order stops meeting the book: 0.3% nearer than
 * the order's own price. With testnet's 3% band, 2.0%; with a 1% band, 0.5%.
 */
export const ownFillBp = (bandBp: number): number => Math.max(0, ownOrderBp(bandBp) - THROUGH_MARK_BP);

export type Trading =
  | { ok: true; gapBp: number | null }
  /**
   * `venue`: the mark is further from the oracle than Hyperliquid itself trades. `gateway`: further than the account's
   * own gateway takes. `page`: inside both, but too near the price this app sends an order at for it to meet the book.
   */
  | { ok: false; gapBp: number; why: 'venue' | 'gateway' | 'page'; limitBp: number };

/**
 * Can an order in this market fill now, opened and closed again? As the keeper's hedgeNow says it: not while the mark
 * stands as far from the oracle as an order may be priced (a sell held to the lowest price that could trade would
 * still sit over the book, and a buy held to the highest, under it). Without both prices there is nothing to
 * measure, and nothing is stopped. On mainnet nothing is stopped.
 */
export function tradingNow(input: { mark: number | null | undefined; oracle: number | null | undefined; bandBp: number; testnet: boolean }): Trading {
  const { mark, oracle, bandBp, testnet } = input;
  if (typeof mark !== 'number' || typeof oracle !== 'number' || !(mark > 0) || !(oracle > 0)) return { ok: true, gapBp: null };
  const gapBp = Math.abs(mark / oracle - 1) * 10_000;
  if (!testnet || !(bandBp > 0)) return { ok: true, gapBp };
  const reach = reachOf(bandBp);
  if (gapBp >= reach.bp) return { ok: false, gapBp, why: reach.venue ? 'venue' : 'gateway', limitBp: reach.bp };
  if (gapBp >= ownFillBp(bandBp)) return { ok: false, gapBp, why: 'page', limitBp: ownFillBp(bandBp) };
  return { ok: true, gapBp };
}

/** The same from a row of the markets answer: testnet's mark and oracle price for the coin, and the account's band. */
export function coinTradingNow(coin: { band_bp: number; testnet: { mark_px: string | null; oracle_px: string | null } | null } | null | undefined, testnet: boolean): Trading {
  const price = (text: string | null | undefined) => (text === null || text === undefined || text === '' ? null : Number(text));
  return tradingNow({ mark: price(coin?.testnet?.mark_px), oracle: price(coin?.testnet?.oracle_px), bandBp: coin?.band_bp ?? 0, testnet });
}

/** What the dropdown says beside a coin that can't trade now. */
export const NOT_TRADING_MARK = 'not trading on Hyperliquid testnet right now';

const percent = (bp: number): string => `${(bp / 100).toFixed(1)}%`;

/**
 * Why, in one line, and what to do. `other` is what to pick in its place: "coin" on the Basis trade tab, "market" on
 * Perps. Null while the market can trade.
 */
export function notTradingWords(coin: string, trading: Trading, other: 'coin' | 'market' = 'coin'): string | null {
  if (trading.ok) return null;
  const gap = `Hyperliquid testnet’s ${coin} price is ${percent(trading.gapBp)} away from its reference price right now`;
  const next = `Pick another ${other}, or try ${coin} again later.`;
  if (trading.why === 'venue') return `${gap}, and it takes no order that far out. ${next}`;
  if (trading.why === 'gateway') return `${gap}, and your account’s risk checks take no order more than ${percent(trading.limitBp)} out. ${next}`;
  return `${gap}, too far for an order placed from here to fill at once. ${next}`;
}

/** Said when no coin of the list can trade now: the button stays off. */
export const NONE_TRADING_WORDS = 'No coin here is trading on Hyperliquid testnet right now: each one’s price is too far from its reference price. Try again later.';

/**
 * The first of the list that can be picked and can trade now: the default. When none can trade, the first that can
 * be picked (its line then says why the button is off). Null for an empty list.
 */
export function firstTrading<T extends { usable: boolean; tradesNow: boolean }>(options: T[]): T | null {
  const usable = options.filter((o) => o.usable);
  return usable.find((o) => o.tradesNow) ?? usable[0] ?? null;
}

/**
 * The coin the Basis trade tab opens on: the one the account already holds (a trade under way keeps its coin, whatever
 * the market does), else the first that can trade now.
 */
export function defaultCoin<T extends { symbol: string; usable: boolean; tradesNow: boolean }>(options: T[], holds: (symbol: string) => boolean): T | null {
  return options.find((o) => o.usable && holds(o.symbol)) ?? firstTrading(options);
}

/**
 * On Perps, in a market that can't trade now: would this order be taken? A market order must fill at once, so no.
 * A limit order is refused when its price is further from the reference than an order may be; nearer, it can rest
 * on the book, and Hyperliquid answers for it.
 */
export function orderStopped(input: { trading: Trading; kind: 'market' | 'limit'; limitPx: string | number | null | undefined; reference: number | null | undefined; bandBp: number }): boolean {
  if (input.trading.ok) return false;
  if (input.kind === 'market') return true;
  const px = Number(input.limitPx);
  const reference = input.reference;
  if (!(px > 0) || typeof reference !== 'number' || !(reference > 0)) return false;
  return Math.abs(px / reference - 1) * 10_000 > reachOf(input.bandBp).bp;
}
