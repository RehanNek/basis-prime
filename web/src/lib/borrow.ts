// What an account can borrow now: the smaller of the engine's answer (W*, the verdict's allow.borrow) and
// the pool's own limits, which hold whatever any verdict says (RISK_ENGINE.md 7.2 and 12.2; PLAN.md 5.1).
// The UI names whichever binds. Amounts are micro-USDC.
import type { BorrowerView, ParamsView, PoolView, Tier, Verdict } from './types.ts';

export interface Limit {
  label: string;
  amount: bigint;
  /** The verdict's W*, or one of the pool's own limits. */
  source: 'verdict' | 'pool';
}

export interface Borrowable {
  /** The most to ask for, a small margin below the binding limit. */
  max: bigint;
  binding: Limit;
  limits: Limit[];
}

const BP = 10_000n;
const tierKey = (tier: Tier) => tier.toLowerCase() as 'preferred' | 'standard' | 'watch';
const atLeastZero = (x: bigint) => (x < 0n ? 0n : x);

/**
 * Debt rounds up by 1-2 micro-USDC, and interest accrues between a verdict and its borrow (PLAN.md 5.1, as
 * built), so stay 0.01% plus 2 micro-USDC below a limit.
 */
export function belowLimit(limit: bigint): bigint {
  return atLeastZero(limit - limit / 10_000n - 2n);
}

/** The pool's limits for one account, and the verdict's W* when there is one. `nowNs` is the time in nanoseconds. */
export function borrowable(input: {
  pool: PoolView;
  params: ParamsView;
  borrower: BorrowerView | null;
  verdict?: Verdict | null;
  nowNs: bigint;
}): Borrowable {
  const { pool, params, borrower, verdict, nowNs } = input;
  const capital = BigInt(pool.capital);
  const loans = BigInt(pool.loans);
  const debt = BigInt(borrower?.debt ?? '0');
  const caps = params.caps;

  const limits: Limit[] = [];
  const poolLimit = (label: string, amount: bigint) => limits.push({ label, amount, source: 'pool' });
  if (verdict) limits.push({ label: "the risk engine's answer", amount: BigInt(Math.trunc(verdict.allow.borrow)), source: 'verdict' });
  if (pool.paused) poolLimit('the pool is paused', 0n);
  if (borrower?.blocked) poolLimit('the account is blocked after a write-off', 0n);
  if (!borrower) poolLimit('the account is not registered with the pool', 0n);
  poolLimit("the pool's cash", BigInt(pool.cash));
  poolLimit('utilisation at most 90%', (capital * BigInt(caps.max_utilisation_bp)) / BP - loans);
  poolLimit("the pool's daily lending budget", BigInt(pool.daily_budget) - BigInt(pool.lent_24h));
  poolLimit('one client at most 25% of the pool', (capital * BigInt(caps.client_share_bp)) / BP - debt);
  if (borrower) {
    poolLimit(`the ${borrower.tier.toLowerCase()} tier's ceiling`, BigInt(caps.ceiling[tierKey(borrower.tier)]) - debt);
    if (nowNs < BigInt(borrower.first_week_until)) poolLimit("a new account's first-week limit", BigInt(caps.new_account_limit) - debt);
  }

  const clean = limits.map((l) => ({ ...l, amount: atLeastZero(l.amount) }));
  const binding = clean.reduce((low, l) => (l.amount < low.amount ? l : low));
  return { max: belowLimit(binding.amount), binding, limits: clean };
}
