// The Home page's numbers (9 Nov redesign): how safe the loan is, in a bar and in words; what the account could
// borrow now; what it is worth. Pure functions, so the words can be tested without a wallet.
import type { AccountAnswer } from './api.ts';
import { belowLimit, borrowable } from './borrow.ts';
import type { BorrowerView, ParamsView, PoolView, RiskState, Tier, Token, Verdict } from './types.ts';
import { formatUsd } from './units.ts';

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export interface HealthView {
  key: RiskState | 'NO_LOAN' | 'UNKNOWN';
  label: string;
  tone: Tone;
  /** Where the marker sits on the bar, from 0 (safest) to 100; null when there is nothing to place. */
  marker: number | null;
  words: string;
}

/** The bar's zones, as shares of its width: Safe, Watch, Margin call, Unwind (globals.css draws the same 5:2:2:1). */
export const ZONES = { watch: 50, call: 70, unwind: 90 } as const;

const clamp = (x: number, low: number, high: number) => Math.min(high, Math.max(low, x));

/**
 * How far nBTC could fall against BTC before equity drops to the safety buffer, in basis points: the account's
 * hedge covers BTC's own moves, so a depeg of the bridged token is what eats the cushion. Null without nBTC.
 */
export function depegRoomBp(verdict: Verdict): number | null {
  const nbtc = verdict.pool?.hold?.nBTC;
  if (nbtc === undefined || !(nbtc > 0)) return null;
  return Math.max(0, Math.floor(((verdict.eq - verdict.mm) / nbtc) * 10_000));
}

/** RISK_ENGINE.md 8.1's states as a bar and a sentence. With no loan nothing is at risk, whatever the verdict says. */
export function healthView(verdict: Verdict | null, hasLoan: boolean): HealthView {
  if (!hasLoan) {
    return { key: 'NO_LOAN', label: 'No loan', tone: 'neutral', marker: 2, words: 'Nothing is borrowed, so nothing can be sold. Borrow when you’re ready.' };
  }
  if (!verdict) {
    return { key: 'UNKNOWN', label: 'Not checked yet', tone: 'neutral', marker: null, words: 'Run a check to see how safe the loan is.' };
  }
  const { eq, im, mm } = verdict;
  switch (verdict.state) {
    case 'HEALTHY': {
      const cushion = im > 0 ? (eq - im) / im : 1;
      const room = depegRoomBp(verdict);
      const words =
        room !== null
          ? `Safe. nBTC could fall ${(room / 100).toFixed(room < 1_000 ? 1 : 0)}% against BTC before a margin call.`
          : `Safe. Your equity is ${formatUsd(Math.max(0, eq - mm))} above the safety line.`;
      return { key: 'HEALTHY', label: 'Safe', tone: 'good', marker: clamp(ZONES.watch * (1 - clamp(cushion / 0.5, 0, 1)), 2, ZONES.watch - 2), words };
    }
    case 'WATCH':
      return {
        key: 'WATCH',
        label: 'Watch',
        tone: 'warn',
        marker: ZONES.watch + (ZONES.call - ZONES.watch) * clamp(im > mm ? (im - eq) / (im - mm) : 0.5, 0.05, 0.95),
        words: 'Close to the line. You can repay or add collateral, but you can’t borrow more until it’s safe again.',
      };
    case 'MARGIN_CALL':
      return {
        key: 'MARGIN_CALL',
        label: 'Margin call',
        tone: 'bad',
        marker: ZONES.call + (ZONES.unwind - ZONES.call) * clamp(mm > 0 ? (mm - eq) / (0.25 * mm) : 0.5, 0.05, 0.95),
        words: 'Margin call: add collateral or repay within 4 hours, or the account starts to unwind.',
      };
    case 'DELEVERAGE':
      return { key: 'DELEVERAGE', label: 'Unwinding', tone: 'bad', marker: 94, words: 'Unwinding: the signed plan is selling part of the book to cover the loan.' };
    case 'DEFAULT':
      return { key: 'DEFAULT', label: 'Defaulted', tone: 'bad', marker: 99, words: 'Defaulted: debt was left after everything was sold, and the pool wrote it off.' };
    default:
      return { key: 'UNKNOWN', label: String(verdict.state), tone: 'neutral', marker: null, words: '' };
  }
}

export interface BorrowEstimate {
  /** Micro-USDC, or null until a check has said anything. */
  amount: bigint | null;
  /** What sets it, in words. */
  why: string;
  /** "engine": a fresh, unused verdict's own answer; "line": the last verdict's line less today's debt. */
  basis: 'engine' | 'line' | 'pool' | 'none';
}

/**
 * What the account could borrow now. A fresh, unused verdict answers exactly (W*). Otherwise the last verdict's
 * credit line less what is owed today is a good guide, since a borrow moves both together. The pool's own limits
 * hold whatever any verdict says (RISK_ENGINE.md 7.2), so the smaller wins.
 */
export function borrowEstimate(input: {
  pool: PoolView;
  params: ParamsView;
  borrower: BorrowerView | null;
  verdict: Verdict | null;
  /** Can the verdict still back a borrow (fresh, and the counter hasn't moved)? */
  live: boolean;
  debt: bigint;
  nowNs: bigint;
}): BorrowEstimate {
  const { pool, params, borrower, verdict, live, debt, nowNs } = input;
  const limits = borrowable({ pool, params, borrower, verdict: null, nowNs });
  if (!verdict) return { amount: null, why: 'Run a check to see your limit', basis: 'none' };
  if (verdict.state !== 'HEALTHY') return { amount: 0n, why: 'Only a safe account can borrow more', basis: 'line' };
  const engine = live ? belowLimit(BigInt(Math.trunc(verdict.allow.borrow))) : belowLimit(BigInt(Math.trunc(verdict.credit.line)) - debt);
  const own = engine < 0n ? 0n : engine;
  if (limits.max < own) return { amount: limits.max, why: `Set by ${limits.binding.label}`, basis: 'pool' };
  return { amount: own, why: live ? 'From your latest check' : 'Your credit line, less what you owe', basis: live ? 'engine' : 'line' };
}

/** The pool's rate today for the account's tier, in basis points. */
export function rateFor(pool: PoolView, tier: Tier | undefined): number {
  const key = (tier ?? 'STANDARD').toLowerCase() as 'preferred' | 'standard' | 'watch';
  return pool.rate_bp[key];
}

export interface Worth {
  /** USD, or null when a price is missing. */
  total: number | null;
  onNear: number | null;
  onHl: number | null;
  debt: number;
}

/**
 * What the client would keep if everything were sold and the loan repaid, at today's prices: the tokens in the
 * account, plus the Hyperliquid equity, plus what is posted with lenders, less the debt. Display only, in floating
 * dollars.
 */
export function netWorth(input: {
  balances: AccountAnswer['balances'];
  tokens: Token[];
  /** USD per whole token, by the pool's symbol (USDC, nBTC). */
  prices: Record<string, number | null | undefined>;
  hlEquity: number | null | undefined;
  debt: bigint;
  /** Phase 6: USD of collateral posted with lenders, which has left the account's own balances. `debt` then counts the lenders' loans too. */
  atLenders?: number;
}): Worth {
  let onNear: number | null = 0;
  for (const b of input.balances) {
    const token = input.tokens.find((t) => t.id === b.token);
    const symbol = token?.symbol ?? b.symbol;
    const amount = Number(b.amount ?? '0') / 10 ** (token?.decimals ?? b.decimals);
    if (amount === 0) continue;
    const price = input.prices[symbol];
    if (price === null || price === undefined || !Number.isFinite(price)) {
      onNear = null;
      break;
    }
    onNear += amount * price;
  }
  const debt = Number(input.debt) / 1e6;
  const onHl = input.hlEquity ?? null;
  const total = onNear === null || onHl === null ? null : onNear + onHl + (input.atLenders ?? 0) - debt;
  return { total, onNear, onHl, debt };
}

/** "Short 0.015 BTC" for each Hyperliquid position, the biggest first. */
export function positionWords(positions: { coin: string; side: 'long' | 'short'; size: number; value: number }[]): string[] {
  return [...positions]
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .map((p) => `${p.side === 'short' ? 'Short' : 'Long'} ${p.size} ${p.coin}`);
}

/** "just now", "4 min ago", "3 h ago", "2 days ago". */
export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
