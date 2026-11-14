// The verdict's bands as trigger levels for the keeper (RISK_ENGINE.md 8.3; INTERFACES.md 6 and 17). Each tick the
// keeper compares the prices now with every level, and asks for a check when a price has crossed one since the last
// tick. A crossing of an equity level is also where the state changes, so this is the keeper's "state change" test.
//
//   coin bands, by coin:   hl50, hl100 (Hyperliquid's margin ratio reaches 50% or 100%), im, mr (equity reaches IM or
//                          MR), as micro-USD prices. The keeper compares them with Hyperliquid's mark.
//   token bands, by token: im_bp, mr_bp, dl_bp (equity reaches IM, MR or 0.8 x MR), as the token's ratio to its
//                          coin in basis points. On testnet the nBTC ratio is the drill's.
//
// A verdict carries bands for at most three assets, and none in DELEVERAGE or without a loan. For a held asset with no
// band, a big move since the verdict asks for a check instead: 2 points of ratio, or 5% of a mark.

export type Side = "above" | "below";

export interface BandLevel {
  /** "BTC.hl100", "nBTC.mr_bp". */
  id: string;
  asset: string;
  field: string;
  kind: "price" | "pi";
  /** USD for a price, basis points for a ratio. */
  level: number;
  meaning: string;
}

/** Prices now: Hyperliquid marks in USD by coin, and ratios (π) in bp by token. */
export interface Prices {
  marks: Record<string, number>;
  pi: Record<string, number>;
  /**
   * Phase 6: bitcoin's price in USD as a lender itself counts it, by lender name, where the keeper knows it. On
   * testnet that is our Rhea copy's fixed BTC price (rhea-price.ts). cushion.ts reads it.
   */
  lenders?: Record<string, number>;
}

const PRICE_FIELDS: Record<string, string> = {
  hl50: "Hyperliquid's margin ratio reaches 50%",
  hl100: "Hyperliquid's margin ratio reaches 100%, where it liquidates",
  im: "equity reaches the initial requirement",
  mr: "equity reaches the safety buffer",
};
const PI_FIELDS: Record<string, string> = {
  im_bp: "equity reaches the initial requirement",
  mr_bp: "equity reaches the safety buffer",
  dl_bp: "equity reaches 0.8 times the safety buffer",
};

/** A ratio move that asks for a check when the verdict has no band for the token: 2 points (200 bp). */
export const PI_MOVE_BP = 200;
/** A mark move that asks for a check when the verdict has no band for the coin: 5%. */
export const MARK_MOVE = 0.05;

/** Every level in a verdict's `bands`. Unknown fields and non-numbers are skipped. */
export function bandLevels(bands: unknown): BandLevel[] {
  if (!bands || typeof bands !== "object") return [];
  const levels: BandLevel[] = [];
  for (const [asset, entry] of Object.entries(bands as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    for (const [field, value] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      if (field in PRICE_FIELDS) levels.push({ id: `${asset}.${field}`, asset, field, kind: "price", level: value / 1e6, meaning: PRICE_FIELDS[field]! });
      else if (field in PI_FIELDS) levels.push({ id: `${asset}.${field}`, asset, field, kind: "pi", level: value, meaning: PI_FIELDS[field]! });
    }
  }
  return levels;
}

export function priceFor(level: Pick<BandLevel, "asset" | "kind">, prices: Prices): number | undefined {
  const value = level.kind === "price" ? prices.marks[level.asset] : prices.pi[level.asset];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Which side of each level the price is on now. A level whose price isn't known is left out. */
export function sidesOf(levels: BandLevel[], prices: Prices): Record<string, Side> {
  const sides: Record<string, Side> = {};
  for (const level of levels) {
    const price = priceFor(level, prices);
    if (price !== undefined) sides[level.id] = price >= level.level ? "above" : "below";
  }
  return sides;
}

export interface Crossing {
  level: BandLevel;
  from: Side;
  to: Side;
  price: number;
}

/** The levels whose side changed between two readings. */
export function crossings(levels: BandLevel[], before: Record<string, Side>, prices: Prices): Crossing[] {
  const now = sidesOf(levels, prices);
  const out: Crossing[] = [];
  for (const level of levels) {
    const from = before[level.id];
    const to = now[level.id];
    if (from && to && from !== to) out.push({ level, from, to, price: priceFor(level, prices)! });
  }
  return out;
}

export function showLevel(kind: BandLevel["kind"], value: number): string {
  return kind === "pi" ? (value / 10_000).toFixed(4) : `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** "nBTC/BTC fell through 0.8412, where equity reaches the safety buffer (now 0.8400)". */
export function crossingWords(c: Crossing): string {
  const what = c.level.kind === "pi" ? `the ${c.level.asset} ratio` : `${c.level.asset}`;
  const way = c.to === "below" ? "fell through" : "rose through";
  return `${what} ${way} ${showLevel(c.level.kind, c.level.level)}, where ${c.level.meaning} (now ${showLevel(c.level.kind, c.price)})`;
}

/** What the account holds that has a price: its Hyperliquid perps by coin, and its NEAR tokens that have a ratio. */
export interface Held {
  perps: string[];
  tokens: string[];
}

/**
 * Held assets with no band in the verdict, whose price moved far since the verdict was first seen. Each asset fires
 * once per verdict (`fired` holds the ones that have).
 */
export function bigMoves(held: Held, levels: BandLevel[], ref: Prices, now: Prices, fired: string[]): { asset: string; words: string }[] {
  const banded = new Set(levels.map((l) => `${l.kind}:${l.asset}`));
  const out: { asset: string; words: string }[] = [];
  for (const token of held.tokens) {
    const key = `pi:${token}`;
    if (banded.has(key) || fired.includes(key)) continue;
    const before = ref.pi[token];
    const after = now.pi[token];
    if (before === undefined || after === undefined) continue;
    if (Math.abs(after - before) >= PI_MOVE_BP) {
      out.push({ asset: key, words: `the ${token} ratio moved from ${showLevel("pi", before)} to ${showLevel("pi", after)} since the last verdict, which has no band for it` });
    }
  }
  for (const coin of held.perps) {
    const key = `price:${coin}`;
    if (banded.has(key) || fired.includes(key)) continue;
    const before = ref.marks[coin];
    const after = now.marks[coin];
    if (!before || after === undefined) continue;
    if (Math.abs(after / before - 1) >= MARK_MOVE) {
      out.push({ asset: key, words: `${coin} moved from ${showLevel("price", before)} to ${showLevel("price", after)} since the last verdict, which has no band for it` });
    }
  }
  return out;
}
