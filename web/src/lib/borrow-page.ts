// The Borrow page's figures in words (INTERFACES.md 49.1 point 8): what you can borrow and at what rate, what you owe,
// what "Repay everything" would pay, and how old a lender's figure is when it comes from an earlier check.
import { formatBp, formatUsd } from './units.ts';
import { SECONDS_PER_BLOCK, VERDICT_LIFETIME_BLOCKS } from './verdict.ts';

/** A check within its own lifetime (120 blocks, a little over a minute) is fresh: its figures need no note. */
const FRESH_BLOCKS = VERDICT_LIFETIME_BLOCKS;

/**
 * "You can borrow $304.56 now, at 6.50% a year." Amounts are micro-USD; null while it isn't known. `exact` is true when
 * the figure has the risk engine's own answer from the last minute in it; without one it is the pool's limit alone,
 * and the line says "about".
 */
export function borrowHeadline(input: { canBorrow: bigint | null; rateBp: number | null; exact?: boolean }): string {
  if (input.canBorrow === null) return 'Reading what you can borrow…';
  if (input.canBorrow <= 0n) return 'You can’t borrow more right now.';
  return `You can borrow ${input.exact === false ? 'about ' : ''}${formatUsd(input.canBorrow)} now${input.rateBp === null ? '' : `, at ${formatBp(input.rateBp)} a year`}.`;
}

/** "You owe $1,025.73, at 8.08% a year." The rate is the whole loan's, weighted by amount. */
export function oweHeadline(input: { owed: bigint; rateBp: number | null }): string {
  if (input.owed <= 0n) return 'You owe nothing.';
  return `You owe ${formatUsd(input.owed)}${input.rateBp === null ? '' : `, at ${formatBp(input.rateBp)} a year`}.`;
}

/**
 * What stays owed after a payment: each source's debt less what the payment sends it, never below zero. A source sent
 * a little over its debt is paid off; the extra doesn't count against another source's debt.
 */
export function owedAfter(owed: { source: string; debt: bigint }[], payment: { source: string; amount: bigint }[]): bigint {
  let left = 0n;
  for (const part of owed) {
    const paid = payment.filter((p) => p.source === part.source).reduce((sum, p) => sum + p.amount, 0n);
    if (part.debt > paid) left += part.debt - paid;
  }
  return left;
}

/**
 * What "Repay everything" does, before it is pressed. `pays` is what the account's own USDC can pay now, where each
 * source is repaid from; `left` is what would stay owed after it (`owedAfter`). `source` names the one lender the
 * client picked to pay alone ("Aave"); without it the words are about the whole loan.
 */
export function everythingWords(input: { pays: bigint; left: bigint; source?: string | null }): string {
  if (input.pays <= 0n) return 'The account holds no USDC to repay with. Add funds, or bring USDC home from Hyperliquid, first.';
  const button = `“${everythingLabel(input.source)}”`;
  if (input.left <= 0n) {
    return `${button} sends ${formatUsd(input.pays)}: ${input.source ? `all ${input.source} is owed` : 'the whole loan'} and a little over, because interest grows by the second. What isn’t needed stays yours.`;
  }
  return `${button} sends ${formatUsd(input.pays)}, all the USDC the account can pay with now. ${formatUsd(input.left)} stays owed${input.source ? ` to ${input.source}` : ''}.`;
}

/** The button's own words: "Repay everything", or "Repay all of Aave" with one lender picked to pay alone. */
export const everythingLabel = (source?: string | null): string => (source ? `Repay all of ${source}` : 'Repay everything');

/**
 * A lender's figures come from the account's last check, not from the lender now. When that check is more than a
 * minute or so old, the page says so beside the figure: "as of the last check, about 12 minutes ago". Null while the
 * check is fresh, or when the page doesn't know which block it read.
 */
export function checkAgeWords(checkBlk: number | null | undefined, height: number): string | null {
  if (typeof checkBlk !== 'number' || !(checkBlk > 0) || !(height > checkBlk)) return null;
  const blocks = height - checkBlk;
  if (blocks <= FRESH_BLOCKS) return null;
  const minutes = Math.round((blocks * SECONDS_PER_BLOCK) / 60);
  if (minutes < 60) return `as of the last check, about ${Math.max(1, minutes)} minute${minutes <= 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `as of the last check, about ${hours} hour${hours === 1 ? '' : 's'} ago`;
}
