// INTERFACES.md 49: swaps between two NEAR test tokens (the Spot page), and the price when 1Click gives none.
//
// A swap between two of the five NEAR test tokens is priced like every other quote: the real 1Click's dry quote for
// the two mainnet twins (assets.ts, NEAR_TWINS). On 13 Nov it priced all twenty directions, down to a cent's worth;
// it refuses less than about 7 satoshis of bitcoin ("Amount is too low for bridge, try at least 7").
//
// When 1Click refuses a pair or an amount (HTTP 400), a swap that touches one of section 49's three tokens falls
// back to the two dollar prices in 1Click's own token list (GET /v0/tokens):
//
//   amountOut = amountIn x price(origin) / price(destination), in whole units, rounded down
//
// No cost is taken off, because the list gives none and the stand-in never makes one up. The quote says so in its
// note (`shim`, the field a quote already uses when it delivers another token than the one asked for), with
// 1Click's own words for its refusal. If the list has no price for either token, there is no fallback: 1Click's
// refusal goes back as it came. mUSDC and mNBTC between themselves are never priced from the list: that pair
// answers what it answered before section 49.
//
// Token amounts are whole units in BigInt from end to end (6, 8, 18 and 24 decimals). A list price is a JSON number;
// it is read as a decimal with 12 places and becomes a whole number of 10^-12 dollars before any arithmetic.
import type { QuoteRequest, QuoteResponse, ShimNote, TokenInfo } from "@pb/oneclick";

import { formatUnits, parseUnits, type ShimAsset } from "./assets.js";
import { RouteRefused } from "./evm-routes.js";

/** A list price is kept to this many decimal places of a dollar. */
export const LIST_PRICE_DECIMALS = 12;
/**
 * The delivery time of a quote priced from the list, in seconds. 1Click's own estimate for every swap among the five
 * on NEAR was 20 or 22 s on 13 Nov; this is the longer one.
 */
export const LIST_PRICE_SECONDS = 22;

/** The note on a quote priced from 1Click's token list. `asked` and `delivers` are the same asset: nothing is swapped for another token. */
export type ListPriceNote = ShimNote & {
  price: "token_list";
  /** What 1Click said when it gave no quote. */
  said: string;
  /** The two list prices used, in dollars for one whole token, and when 1Click last set them. */
  usd: { origin: number; destination: number; originUpdatedAt: string; destinationUpdatedAt: string };
};

/** Both sides are NEAR test tokens. */
export function isNearSwap(origin: ShimAsset, destination: ShimAsset): boolean {
  return origin.chain === "near" && destination.chain === "near";
}

/** Whether a 1Click refusal of this pair is answered from the token list: a NEAR swap with at least one of section 49's tokens. */
export function listPriceCovers(origin: ShimAsset, destination: ShimAsset): boolean {
  return isNearSwap(origin, destination) && Boolean(origin.checkDeployed || destination.checkDeployed);
}

/** A list price as a whole number of 10^-12 dollars; null for anything that isn't a positive price. */
export function listPriceUnits(price: unknown): bigint | null {
  if (typeof price !== "number" || !Number.isFinite(price) || !(price > 0) || price >= 1e15) return null;
  const units = parseUnits(price.toFixed(LIST_PRICE_DECIMALS), LIST_PRICE_DECIMALS);
  return units > 0n ? units : null;
}

/**
 * `amountIn` units of a token with `decimalsIn` decimals, each whole token worth `priceIn`, as units of a token with
 * `decimalsOut` decimals worth `priceOut` (both prices in 10^-12 dollars). Rounded down; BigInt throughout.
 */
export function convertAtListPrices(amountIn: bigint, decimalsIn: number, priceIn: bigint, decimalsOut: number, priceOut: bigint): bigint {
  return (amountIn * priceIn * 10n ** BigInt(decimalsOut)) / (priceOut * 10n ** BigInt(decimalsIn));
}

/** Dollars, as a decimal string, of `amount` units at `price` (10^-12 dollars for a whole token). Rounded down to 10^-12. */
function usdText(amount: bigint, decimals: number, price: bigint): string {
  return formatUnits((amount * price) / 10n ** BigInt(decimals), LIST_PRICE_DECIMALS);
}

/**
 * The quote for `request` at the token list's two prices, or null when it can't be made honestly: the list lacks a
 * price for either twin, or the request's slippage isn't a whole number of basis points (then 1Click's refusal may
 * be about that, and it goes back as it came). An amount worth less than one unit of the destination is refused in
 * words.
 */
export function listPriceQuote(request: QuoteRequest, origin: ShimAsset, destination: ShimAsset, list: TokenInfo[], said: string, now: number): { priced: QuoteResponse; note: ListPriceNote } | null {
  const slippage = request.slippageTolerance;
  if (!Number.isInteger(slippage) || slippage < 0 || slippage > 10_000) return null;
  const [from, to] = [origin, destination].map((asset) => list.find((t) => t.assetId === asset.mainnetAssetId));
  const [priceIn, priceOut] = [listPriceUnits(from?.price), listPriceUnits(to?.price)];
  if (!from || !to || priceIn === null || priceOut === null) return null;

  const amountIn = BigInt(request.amount);
  const amountOut = convertAtListPrices(amountIn, origin.decimals, priceIn, destination.decimals, priceOut);
  if (amountOut <= 0n) {
    throw new RouteRefused(`That is too little ${origin.symbol} to arrive as any ${destination.symbol}: 1Click gave no quote for it ("${said}"), and at its token list's prices it is worth less than the smallest unit of ${destination.symbol}`);
  }
  const minAmountOut = (amountOut * BigInt(10_000 - slippage)) / 10_000n;
  const note: ListPriceNote = {
    asked: destination.assetId,
    delivers: destination.assetId,
    symbol: destination.symbol,
    why: `1Click gave no quote for this ("${said}"), so the price is from 1Click's token list: ${origin.symbol} at $${from.price} and ${destination.symbol} at $${to.price}, with no cost taken off`,
    price: "token_list",
    said,
    usd: { origin: from.price, destination: to.price, originUpdatedAt: from.priceUpdatedAt, destinationUpdatedAt: to.priceUpdatedAt },
  };
  return {
    note,
    priced: {
      correlationId: "token-list-price",
      timestamp: new Date(now).toISOString(),
      signature: "",
      quoteRequest: request,
      quote: {
        amountIn: amountIn.toString(),
        amountInFormatted: formatUnits(amountIn, origin.decimals),
        amountInUsd: usdText(amountIn, origin.decimals, priceIn),
        minAmountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        amountOutFormatted: formatUnits(amountOut, destination.decimals),
        amountOutUsd: usdText(amountOut, destination.decimals, priceOut),
        minAmountOut: minAmountOut.toString(),
        timeEstimate: LIST_PRICE_SECONDS,
      },
    },
  };
}
