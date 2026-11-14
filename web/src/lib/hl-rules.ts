// Hyperliquid's tick and lot rules for perps (for-developers/api/tick-and-lot-size), exactly, with bigint decimals:
//   - a size has at most szDecimals decimals;
//   - a price has at most 5 significant figures and at most 6 - szDecimals decimals, and an integer price is always
//     allowed, however many figures it has;
//   - an order is worth at least $10.
// The gateway refuses an unrounded order (INPUT) rather than rounding it (INTERFACES.md 9), so the page rounds
// before signing and shows what it will send. Values are written as Hyperliquid writes them: no trailing zeros and
// no exponent ("0.33", "74500").

/** A non-negative decimal: units / 10^scale. */
export interface Dec {
  units: bigint;
  scale: number;
}

export const MAX_PERP_DECIMALS = 6;
export const MAX_SIG_FIGS = 5;
export const MIN_NOTIONAL_USD = 10;

/** "1,234.50" -> {123450, 2}. Null for anything that isn't a plain non-negative decimal. */
export function parseDec(text: string): Dec | null {
  const clean = text.trim().replace(/,/g, '');
  const match = /^(\d*)(?:\.(\d*))?$/.exec(clean);
  if (!clean || !match || (match[1] === '' && !match[2])) return null;
  const whole = match[1] || '0';
  const fraction = match[2] ?? '';
  return { units: BigInt(whole + fraction), scale: fraction.length };
}

/** A decimal written canonically: 75000.0 -> "75000", 0.50 -> "0.5". */
export function decText({ units, scale }: Dec): string {
  const digits = units.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** A JS number as a decimal, for prices computed from a mark (display maths only). */
export function decFromNumber(value: number): Dec | null {
  if (!Number.isFinite(value) || value < 0) return null;
  return parseDec(value.toFixed(12));
}

const pow10 = (n: number) => 10n ** BigInt(n);

/** floor(log10(x)) for x > 0: the position of the first significant digit. */
export function magnitude({ units, scale }: Dec): number {
  return units.toString().length - 1 - scale;
}

export type RoundMode = 'down' | 'up';

/** To `decimals` decimal places, rounding down or up. */
export function roundTo(dec: Dec, decimals: number, mode: RoundMode): Dec {
  if (dec.scale <= decimals) return { units: dec.units * pow10(decimals - dec.scale), scale: decimals };
  const step = pow10(dec.scale - decimals);
  const floor = dec.units / step;
  const up = mode === 'up' && dec.units % step !== 0n;
  return { units: up ? floor + 1n : floor, scale: decimals };
}

/** How many decimals a price of this size may have: at most 6 - szDecimals, and only within 5 significant figures. */
export function priceDecimals(price: Dec, szDecimals: number): number {
  if (price.units === 0n) return 0;
  const bySigFigs = MAX_SIG_FIGS - 1 - magnitude(price);
  return Math.max(0, Math.min(MAX_PERP_DECIMALS - szDecimals, bySigFigs));
}

/**
 * The nearest valid price in one direction. A buy rounds down and a sell rounds up, so a rounded limit is never
 * worse for the client than the one typed. Rounding up can reach the next power of ten (9.99996 -> 10), which is
 * still valid.
 */
export function roundPrice(price: Dec, szDecimals: number, mode: RoundMode): Dec {
  if (isIntegral(price)) return roundTo(price, 0, mode); // an integer price is always allowed
  return roundTo(price, priceDecimals(price, szDecimals), mode);
}

export function isIntegral({ units, scale }: Dec): boolean {
  return units % pow10(scale) === 0n;
}

/** Is this price valid as typed? Integers always are; otherwise 5 significant figures and 6 - szDecimals decimals. */
export function isValidPrice(price: Dec, szDecimals: number): boolean {
  if (price.units === 0n) return false;
  if (isIntegral(price)) return true;
  const trimmed = parseDec(decText(price))!;
  return trimmed.scale <= priceDecimals(trimmed, szDecimals);
}

/** A size cut down to szDecimals. */
export function roundSize(size: Dec, szDecimals: number): Dec {
  return roundTo(size, szDecimals, 'down');
}

/** size x price in micro-USD, exactly (rounded down). */
export function notionalMicro(size: Dec, price: Dec): bigint {
  const units = size.units * price.units * 1_000_000n;
  return units / pow10(size.scale + price.scale);
}

export interface RoundedOrder {
  /** What will be signed, in Hyperliquid's writing. */
  sz: string;
  limitPx: string;
  /** What was changed by rounding, in words. */
  changes: string[];
  notionalMicro: bigint;
  /** Why it can't be sent, in words; empty when it can. */
  problems: string[];
}

/** Rounds a typed size and price for a buy or a sell, and lists what stops it. */
export function roundOrder(input: { size: string; price: string; isBuy: boolean; szDecimals: number }): RoundedOrder {
  const problems: string[] = [];
  const changes: string[] = [];
  const size = parseDec(input.size);
  const price = parseDec(input.price);
  if (!size) problems.push('Enter a size, like 0.01');
  if (!price) problems.push('Enter a limit price, like 75000');
  if (!size || !price) return { sz: '', limitPx: '', changes, notionalMicro: 0n, problems };

  const sz = roundSize(size, input.szDecimals);
  const px = roundPrice(price, input.szDecimals, input.isBuy ? 'down' : 'up');
  const szText = decText(sz);
  const pxText = decText(px);
  if (szText !== decText(size)) changes.push(`size cut to ${szText} (at most ${input.szDecimals} decimals)`);
  if (pxText !== decText(price)) changes.push(`price ${input.isBuy ? 'lowered' : 'raised'} to ${pxText} (5 significant figures, at most ${Math.max(0, MAX_PERP_DECIMALS - input.szDecimals)} decimals)`);
  if (sz.units === 0n) problems.push(`The size rounds to 0: the smallest step is ${decText({ units: 1n, scale: input.szDecimals })}`);
  if (px.units === 0n) problems.push('The price rounds to 0');
  const notional = notionalMicro(sz, px);
  if (sz.units > 0n && px.units > 0n && notional < BigInt(MIN_NOTIONAL_USD) * 1_000_000n) {
    problems.push(`The order is worth $${(Math.floor(Number(notional) / 1e4) / 100).toFixed(2)}; Hyperliquid's minimum is $${MIN_NOTIONAL_USD}`);
  }
  return { sz: szText, limitPx: pxText, changes, notionalMicro: notional, problems };
}

export interface Band {
  reference: number;
  low: number;
  high: number;
  bandBp: number;
}

/** The P2 band around a reference price (RISK_ENGINE.md 9): |p / P - 1| <= band. */
export function priceBand(reference: number, bandBp: number): Band {
  const f = bandBp / 10_000;
  return { reference, low: reference * (1 - f), high: reference * (1 + f), bandBp };
}

/** A band in percent, as it was given: 100 is "1%", 300 is "3%", 250 is "2.5%". Never rounded to a whole percent. */
export function bandPercent(bandBp: number): string {
  return `${Number((bandBp / 100).toFixed(2))}%`;
}

/**
 * INTERFACES.md 42: on testnet a gateway built since 12 Nov uses the parameter file's band or 3%, whichever is larger.
 * The markets answer says so with `band_floor_bp` (300, or 0 for an older gateway and on mainnet). When that floor is
 * what set a coin's band, the page adds this sentence; a coin whose own band is wider needs none.
 */
export function bandFloorWords(bandBp: number, floorBp: number | null | undefined): string | null {
  return typeof floorBp === 'number' && floorBp > 0 && bandBp <= floorBp
    ? 'This wider band is a testnet allowance, because Hyperliquid testnet’s price often stands away from its oracle.'
    : null;
}

/** Where a limit price sits against the band, in words, or null when it is comfortably inside. */
export function bandProblem(limitPx: number, band: Band): string | null {
  if (!Number.isFinite(limitPx) || limitPx <= 0) return null;
  const off = (limitPx / band.reference - 1) * 10_000;
  if (Math.abs(off) > band.bandBp) {
    return `The limit is ${(Math.abs(off) / 100).toFixed(2)}% ${off > 0 ? 'above' : 'below'} the reference, outside the ${bandPercent(band.bandBp)} band: the gateway refuses it (P2)`;
  }
  if (Math.abs(off) > band.bandBp * 0.9) return 'The limit is near the edge of the band; the gateway measures from its own reference price, which may differ a little';
  return null;
}

/** A price shown with the decimals the coin's prices may have. */
export function showPrice(value: number | string, szDecimals: number): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '?';
  const dec = decFromNumber(n);
  if (!dec) return '?';
  return decText(roundPrice(dec, szDecimals, 'down'));
}
