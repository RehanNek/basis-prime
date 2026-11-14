// The borrow page's comparison (PLAN.md 5.8): what Rhea alone would lend against the nBTC, and the carry: the
// funding the hedge earns on Hyperliquid against the interest the loan costs. Phase 5: Rhea's terms come live from
// GET /api/rhea (mainnet), and the 3 Nov figures below stand in when it doesn't answer.
import type { RheaAnswer } from './api.ts';

/**
 * Rhea on mainnet, read on 3 Nov (research/rhea.md 4 and 3): nBTC's volatility ratio is 80% and USDC's 95%, so
 * 1 nBTC supports 0.80 x 0.95 = 76% of its value in USDC debt, and the position must end each borrow at a health
 * factor of 1.0 exactly: no buffer, liquidation starts at the borrow limit. USDC then cost 17.38% a year to borrow.
 */
export const RHEA = { nbtcLtvBp: 7_600, usdcBorrowBp: 1_738, readOn: '3 Nov 2026' } as const;

/** What Rhea alone would lend against nBTC worth `nbtcMicro` (micro-USD), at a health factor of 1.0. */
export function rheaAlone(nbtcMicro: bigint, ltvBp: number = RHEA.nbtcLtvBp): bigint {
  return (nbtcMicro * BigInt(ltvBp)) / 10_000n;
}

export interface RheaTerms {
  /** nBTC's volatility ratio x USDC's: what Rhea lends against nBTC alone. */
  nbtcLtvBp: number;
  usdcBorrowBp: number;
  /** `live`: GET /api/rhea answered; `3 Nov`: it didn't, and the figures of research/rhea.md stand in. */
  source: 'live' | '3 Nov';
  /** Where the figures come from, in words. */
  words: string;
}

/** Rhea's terms for the Borrow page: live from GET /api/rhea when it has them, else the 3 Nov figures, saying which. */
export function rheaTerms(answer: RheaAnswer | null | undefined, nowMs: number): RheaTerms {
  const nbtc = answer?.tokens.find((t) => t.token === 'nBTC');
  const usdc = answer?.usdc.borrow_apr_bp;
  if (answer && nbtc?.ltv_bp != null && usdc != null) {
    const minutes = Math.max(0, Math.round((nowMs - answer.read_at_ms) / 60_000));
    const age = minutes < 1 ? 'just now' : `${minutes} min ago`;
    return {
      nbtcLtvBp: nbtc.ltv_bp,
      usdcBorrowBp: usdc,
      source: 'live',
      words: `Rhea's terms on mainnet now: ${answer.contract} at block ${answer.block_height.toLocaleString('en-US')}, read ${age}${answer.stale ? ' (the last read that worked: mainnet isn\'t answering)' : ''}. Its LTV for nBTC is ${(nbtc.volatility_bp! / 10_000).toFixed(2)} x ${(answer.usdc.volatility_bp! / 10_000).toFixed(2)}.`,
    };
  }
  return {
    nbtcLtvBp: RHEA.nbtcLtvBp,
    usdcBorrowBp: RHEA.usdcBorrowBp,
    source: '3 Nov',
    words: `Rhea's terms as read on mainnet on ${RHEA.readOn} (research/rhea.md), because its live terms couldn't be read just now: its LTV for nBTC is 0.80 x 0.95.`,
  };
}

export interface CarryInput {
  /** Each Hyperliquid position: its coin, side and value in USD. */
  positions: { coin: string; side: 'long' | 'short'; value: number }[];
  /** Each coin's current hourly funding rate on Hyperliquid: positive means longs pay shorts. */
  fundingHourly: Record<string, number>;
  /** The loan, in USD, and its rate. */
  debtUsd: number;
  rateBp: number;
}

export interface Carry {
  /** Funding a year at today's hourly rates: positive is earned. */
  fundingYearUsd: number;
  interestYearUsd: number;
  netYearUsd: number;
  /** Coins whose funding rate isn't known: left out of the sum. */
  missing: string[];
}

const HOURS_A_YEAR = 24 * 365;

export function carry(input: CarryInput): Carry {
  let funding = 0;
  const missing: string[] = [];
  for (const p of input.positions) {
    const rate = input.fundingHourly[p.coin];
    if (rate === undefined || !Number.isFinite(rate)) {
      missing.push(p.coin);
      continue;
    }
    funding += (p.side === 'short' ? 1 : -1) * p.value * rate * HOURS_A_YEAR;
  }
  const interest = (input.debtUsd * input.rateBp) / 10_000;
  return { fundingYearUsd: funding, interestYearUsd: interest, netYearUsd: funding - interest, missing };
}
