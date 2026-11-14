// A price as the amount is typed (INTERFACES.md 49.1 point 6 and 49.5): no "Get a price" button. The page asks for the
// price 400 ms after the last keystroke, and asks again by itself before the figure on screen runs out.

/** How long after the last keystroke the price is asked for. */
export const PRICE_DELAY_MS = 400;
/** A price on screen is asked for again after this long, so it never runs out while someone reads it. */
export const PRICE_LIFE_MS = 30_000;

/** Is it time to ask? Only once typing has stopped for 400 ms. Null: nothing was typed. */
export function priceDue(lastKeyMs: number | null, nowMs: number): boolean {
  return lastKeyMs !== null && nowMs - lastKeyMs >= PRICE_DELAY_MS;
}

/** Has the price on screen run out? Null: there is none, which isn't stale. */
export function priceStale(pricedAtMs: number | null, nowMs: number): boolean {
  return pricedAtMs !== null && nowMs - pricedAtMs >= PRICE_LIFE_MS;
}

/**
 * In how many milliseconds the page asks next, or null when it has nothing to ask.
 * - An amount was typed and has no price yet: 400 ms after the last keystroke.
 * - A price is on screen for that amount: when it runs out.
 */
export function nextPriceAsk(input: { lastKeyMs: number | null; pricedAtMs: number | null; nowMs: number }): number | null {
  const { lastKeyMs, pricedAtMs, nowMs } = input;
  if (lastKeyMs === null) return null;
  // The price on screen is for what was last typed only if it came after that keystroke.
  if (pricedAtMs !== null && pricedAtMs >= lastKeyMs) return Math.max(0, pricedAtMs + PRICE_LIFE_MS - nowMs);
  return Math.max(0, lastKeyMs + PRICE_DELAY_MS - nowMs);
}
