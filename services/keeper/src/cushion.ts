// A lender's cushion between two checks (FUNDING.md 6.3 and 7.1; INTERFACES.md 27). The cushion (health factor) is
// what the posted bitcoin is worth to the lender, times its liquidation ratio, over the USDC owed there. The debt
// barely moves between checks, so the cushion moves with bitcoin's price: the keeper scales the last verdict's
// figure by how far the price has gone since, and asks for a check when that brings it near a level the engine acts
// at. The engine then reads the real position and plans the top-up; this is only the trigger.
//
//   target 1.5   new lender borrowing stops here
//   act    1.35  under it the engine plans a top-up (REBALANCE)
//   now    1.2   under it the top-up is REBALANCE_NOW
//
// Which price: the lender's own, where the keeper knows it (our Rhea copy on testnet has a fixed BTC price, which
// the keeper itself keeps in step with Hyperliquid's oracle); otherwise Hyperliquid's BTC mark.
import { showLevel, type Prices } from "./bands.js";
import { lenderName, type LenderExt } from "./plan.js";

/** risk_core::lender's levels, in bp of health factor (decided 11 Nov). */
export const TARGET_HF_BP = 15_000;
export const ACT_HF_BP = 13_500;
export const NOW_HF_BP = 12_000;
/** "Near the act level": 2% over it. From the target, that is bitcoin about 8% down. */
export const NEAR_HF_BP = 13_770;
/** Under the near level, a cushion that has lost another 1% since the verdict asks for a check too. */
export const HF_STEP_BP = 100;

/** A cushion in words: 13500 -> "1.35". */
export function showCushion(bp: number): string {
  return (bp / 10_000).toFixed(2);
}

/**
 * The collateral's price for a lender in two readings, from the same source in both: the lender's own if both have
 * it. Our Rhea copy has a price for each token it takes (INTERFACES.md 51.1): bitcoin's under the lender's name, as
 * before, and ether's under `<lender>:ETH`. The verdict doesn't say which the account posted, so the one that fell
 * furthest is taken: this is only the trigger for a check, and a check too many costs less than one too few.
 */
function btcPair(lender: string, ref: Prices, now: Prices): { from: number; to: number; own: boolean; coin: string } | null {
  const ok = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  let worst: { from: number; to: number; own: boolean; coin: string } | null = null;
  for (const key of Object.keys(now.lenders ?? {})) {
    if (key !== lender && !key.startsWith(`${lender}:`)) continue;
    const [from, to] = [ref.lenders?.[key], now.lenders?.[key]];
    if (!ok(from) || !ok(to)) continue;
    if (!worst || to / from < worst.to / worst.from) worst = { from, to, own: true, coin: key === lender ? "BTC" : key.slice(lender.length + 1) };
  }
  if (worst) return worst;
  const [from, to] = [ref.marks.BTC, now.marks.BTC];
  return ok(from) && ok(to) ? { from, to, own: false, coin: "BTC" } : null;
}

export interface CushionMove {
  lender: string;
  /** The verdict's cushion, and the keeper's estimate of it now, in bp. */
  was: number;
  est: number;
  words: string;
}

/**
 * Whether bitcoin has moved enough since the verdict to ask for a check on this lender position: its cushion has
 * come down to the near level, has fallen through the act or the now level, or is under the near level and has lost
 * another 1%. Null when it hasn't, when nothing is owed there, or when no price is known.
 */
export function cushionMove(e: LenderExt, ref: Prices, now: Prices): CushionMove | null {
  if (e.d <= 0 || e.hf_bp <= 0) return null;
  const px = btcPair(e.l, ref, now);
  if (!px) return null;
  const est = Math.round((e.hf_bp * px.to) / px.from);
  const through = (level: number) => e.hf_bp >= level && est < level;
  const further = est < NEAR_HF_BP && est <= e.hf_bp - (e.hf_bp * HF_STEP_BP) / 10_000;
  if (!through(NEAR_HF_BP) && !through(ACT_HF_BP) && !through(NOW_HF_BP) && !further) return null;
  const name = lenderName(e.l);
  const where = px.own ? `${px.coin === "ETH" ? "ether" : "bitcoin"}'s price at ${name}` : "BTC on Hyperliquid";
  const stands =
    est < NOW_HF_BP
      ? `under ${showCushion(NOW_HF_BP)}, where it must be topped up now`
      : est < ACT_HF_BP
        ? `under ${showCushion(ACT_HF_BP)}, where it gets topped up`
        : `close to ${showCushion(ACT_HF_BP)}, where it gets topped up`;
  return {
    lender: e.l,
    was: e.hf_bp,
    est,
    // The estimate is written to three places: at two, 1.348 would read "about 1.35, under 1.35".
    words: `${name}'s cushion was ${showCushion(e.hf_bp)} at the last check, and ${where} has gone from ${showLevel("price", px.from)} to ${showLevel("price", px.to)} since: about ${(est / 10_000).toFixed(3)} now, ${stands}`,
  };
}
