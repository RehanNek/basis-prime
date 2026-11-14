// One loan, several sources (FUNDING.md 8; INTERFACES.md 29), stage 2: what the client owes in all, to our pool and to
// each lender, what each part costs them under the pool's pricing policy, which source a repayment pays first, and the
// credit the pool owes back. Pure functions, so the words can be tested.
import type { FundingSource, LenderPosition, Pricing, PricingView } from './api.ts';
import { blendedBp, sourceName, toMicro } from './funding.ts';
import { clientRateBp } from './pricing.ts';
import { formatBp, formatUsd } from './units.ts';

export interface LoanPart {
  source: FundingSource;
  name: string;
  /** Micro-USD owed to this source. */
  debt: bigint;
  /** What the source itself charges, bp a year. Null when it wasn't read. */
  ownBp: number | null;
  /** What the client pays on this part under the pool's policy. Null when the source's rate wasn't read. */
  payBp: number | null;
}

export interface LoanView {
  /** Everything owed, to our pool and to every lender. */
  total: bigint;
  /** The sources with something owed: lenders first, in their usual order, then our pool. */
  parts: LoanPart[];
  /** What the whole loan costs the client, weighted by amount. Null when a part's rate isn't known. */
  rateBp: number | null;
  /** The line under the total. */
  words: string;
}

/** A source's name inside a sentence: "our pool", "Rhea". */
export const inSentence = (source: string): string => (source === 'pool' ? 'our pool' : sourceName(source));

/**
 * The whole loan: our pool's part (`poolDebt`, with interest, at the pool's rate for the account's tier) and each
 * lender's, as the latest check read it. `pricing` is the pool's policy for the account, when it has one.
 */
export function loanView(input: { poolDebt: bigint; poolRateBp: number | null; lenders: LenderPosition[]; pricing?: Pricing | null }): LoanView {
  const { poolDebt, poolRateBp, lenders, pricing } = input;
  const parts: LoanPart[] = [];
  for (const position of lenders) {
    const debt = toMicro(position.debt);
    if (debt <= 0n) continue;
    const ownBp = typeof position.rate_bp === 'number' ? position.rate_bp : null;
    parts.push({ source: position.l, name: sourceName(position.l), debt, ownBp, payBp: ownBp === null ? null : clientRateBp(pricing, position.l, ownBp, position.supply_bp ?? 0) });
  }
  if (poolDebt > 0n) parts.push({ source: 'pool', name: sourceName('pool'), debt: poolDebt, ownBp: poolRateBp, payBp: poolRateBp === null ? null : clientRateBp(pricing, 'pool', poolRateBp) });
  const total = parts.reduce((sum, p) => sum + p.debt, 0n);
  const rateBp = blendedBp(parts.map((p) => ({ amount: p.debt, rate_bp: p.payBp })));
  const rate = rateBp === null ? '' : `At ${formatBp(rateBp)} a year`;
  let words: string;
  if (parts.length === 0) words = 'Nothing borrowed';
  else if (parts.length === 1 && parts[0]!.source === 'pool') words = rate ? `${rate}, from the broker’s pool` : 'From the broker’s pool';
  else {
    const split = parts.map((p) => `${formatUsd(p.debt)} from ${inSentence(p.source)}`).join(', ');
    words = rate ? `${rate} on the whole loan: ${split}` : split;
  }
  return { total, parts, rateBp, words };
}

export interface RepayOrder {
  /** The sources with something owed, the one a repayment pays first on top. */
  order: LoanPart[];
  /** Which one it pays first, and why. Empty when nothing is owed. */
  why: string;
}

const known = (bp: number | null): number => (bp === null ? -1 : bp);

/**
 * Which source a repayment pays first: the dearest for the client. Between two that cost the client the same, the one
 * whose own rate is higher; then a lender before our pool, since a smaller loan there widens the cushion on what is
 * posted with it. `only` is the client's own pick instead: the repayment then goes to that source alone.
 */
export function repayOrder(parts: LoanPart[], only?: FundingSource | null): RepayOrder {
  const owed = parts.filter((p) => p.debt > 0n);
  const order = [...owed].sort((a, b) => known(b.payBp) - known(a.payBp) || known(b.ownBp) - known(a.ownBp) || Number(a.source === 'pool') - Number(b.source === 'pool'));
  const first = order[0];
  if (!first) return { order, why: '' };
  const picked = only ? order.find((p) => p.source === only) : undefined;
  if (picked) return { order: [picked], why: `This pays ${inSentence(picked.source)} alone, as you chose.` };
  const next = order[1];
  if (!next) return { order, why: `This pays ${inSentence(first.source)}: it is the only source you owe.` };
  if (first.payBp === null || next.payBp === null) {
    return { order, why: `This pays ${inSentence(first.source)} first. Not every source’s rate was read, so the page can’t say which costs you most.` };
  }
  if (first.payBp > next.payBp) {
    // Every other source and what it costs, the dearer first: two with a loan from both lenders and our pool.
    const others = order
      .slice(1)
      .filter((p) => p.payBp !== null)
      .map((p) => `${formatBp(p.payBp!)} for ${inSentence(p.source)}`);
    return { order, why: `This pays ${inSentence(first.source)} first: it costs you the most, ${formatBp(first.payBp)} a year against ${others.join(' and ')}.` };
  }
  const widens = first.source === 'pool' ? '' : ` A smaller loan with ${first.name} widens your cushion there.`;
  if (order.some((p) => p.payBp !== first.payBp)) {
    // The dearest two cost the same, and a third costs less.
    return { order, why: `This pays ${inSentence(first.source)} first: nothing costs you more, at ${formatBp(first.payBp)} a year.${widens}` };
  }
  return {
    order,
    why:
      first.source === 'pool'
        ? `This pays ${inSentence(first.source)} first. Your sources cost you the same, ${formatBp(first.payBp)} a year.`
        : `This pays ${inSentence(first.source)} first. Your sources cost you the same, ${formatBp(first.payBp)} a year, and a smaller loan with ${first.name} widens your cushion there.`,
  };
}

/**
 * The USDC a repayment can come from (stage 3). Our pool and Rhea are repaid from the account's USDC on NEAR. Aave is
 * repaid from the USDC at the account's own address on Aave's chain, where its loan arrived.
 */
export interface Purses {
  near: bigint;
  evm: bigint;
}

const purseOf = (source: FundingSource): keyof Purses => (source === 'aave' ? 'evm' : 'near');
const least = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * What a lender is sent over the debt read, when a repayment pays it off: 0.002% for the interest of the next minutes
 * and 100 micro-USD of dust, as the keeper's gate sends (services/keeper/src/funding-kit.ts, rheaRepayAmount). The
 * debt grows between the read and the transaction, so the debt alone would leave a little owed. Rhea keeps what is
 * above the debt as the account's plain deposit, which `lender_withdraw` of the USDC token brings back.
 */
export const lenderExtra = (debt: bigint): bigint => (debt > 0n ? debt / 50_000n + 100n : 0n);

/** What paying a lender off sends: the debt and its little extra. */
export const lenderPayoff = (debt: bigint): bigint => debt + lenderExtra(debt);

/**
 * Is the USDC at the account's address too little to pay Aave off? Interest grows every second, so paying a loan off
 * takes a little more than was borrowed: the debt and its little extra. Never with nothing owed there.
 */
export const shortOfPayoff = (aaveDebt: bigint, atAddress: bigint): boolean => aaveDebt > 0n && atAddress < lenderPayoff(aaveDebt);

/**
 * A repayment of `amount` micro-USD cut into one payment per source, in `order`. A lender takes at most its pay-off
 * amount (the debt and its little extra), our pool at most what it is owed. Anything left over goes to our pool when
 * it is owed something, because the pool sends back what is above the debt. With no pool debt the rest is dropped.
 *
 * With `purses`, no source is sent more than the USDC held where it is repaid from: a source whose purse is empty is
 * passed over, and the payment goes on to the next.
 */
export function repaySplit(amount: bigint, order: LoanPart[], purses?: Purses): { source: FundingSource; amount: bigint }[] {
  const out: { source: FundingSource; amount: bigint }[] = [];
  const have = purses ? { ...purses } : null;
  let left = amount > 0n ? amount : 0n;
  for (const part of order) {
    if (left === 0n) break;
    const takes = part.source === 'pool' ? part.debt : lenderPayoff(part.debt);
    const pays = least(left, have ? least(takes, have[purseOf(part.source)]) : takes);
    if (pays > 0n) out.push({ source: part.source, amount: pays });
    if (have) have[purseOf(part.source)] -= pays;
    left -= pays;
  }
  const over = have ? least(left, have.near) : left;
  if (over > 0n) {
    const pool = out.find((p) => p.source === 'pool');
    if (pool) pool.amount += over;
    else if (order.some((p) => p.source === 'pool')) out.push({ source: 'pool', amount: over });
  }
  return out;
}

/** The extra the pool is sent on "all", which it returns: 0.1% of the pool's part plus $1, for interest on the way. */
export const poolExtra = (poolDebt: bigint): bigint => (poolDebt > 0n ? poolDebt / 1_000n + 1_000_000n : 0n);

/**
 * "All": every lender's pay-off amount, and our pool's part with its extra, each up to the USDC held where it is
 * repaid from.
 */
export function repayMost(order: LoanPart[], purses: Purses): bigint {
  const have = { ...purses };
  let all = 0n;
  for (const part of order) {
    const takes = part.source === 'pool' ? part.debt + poolExtra(part.debt) : lenderPayoff(part.debt);
    const pays = least(takes, have[purseOf(part.source)]);
    have[purseOf(part.source)] -= pays;
    all += pays;
  }
  return all;
}

/** The same USDC for every source: an account that has no address on Aave's chain repays everything from NEAR. */
export const onNear = (usdc: bigint): Purses => ({ near: usdc, evm: 0n });

/** Does this split pay a lender off, sending it more than the debt read? Then the page says where the rest goes. */
export function paysOff(split: { source: FundingSource; amount: bigint }[], order: LoanPart[]): FundingSource[] {
  return split.filter((p) => p.source !== 'pool' && p.amount > (order.find((o) => o.source === p.source)?.debt ?? p.amount)).map((p) => p.source);
}

/** Dollars that keep amounts under a cent readable: 4,100 micro-USD is "$0.0041", not "$0.00". */
export function usdOrDust(micro: bigint): string {
  if (micro <= 0n || micro >= 10_000n) return formatUsd(micro);
  return `$0.${micro.toString().padStart(6, '0').replace(/0+$/, '')}`;
}

/**
 * USDC of the account's that is sitting at a lender as a plain deposit (GET /api/lender/:account, `deposit` on Rhea's
 * entry): what a repayment above the debt left there. Only lenders with something there are listed.
 */
export function depositsAt(lenders: Pick<LenderPosition, 'l' | 'deposit'>[] | null | undefined): { l: LenderPosition['l']; name: string; amount: bigint }[] {
  return (lenders ?? []).map((p) => ({ l: p.l, name: sourceName(p.l), amount: toMicro(p.deposit) })).filter((d) => d.amount > 0n);
}

/** The line that says so, and what bringing it back does. */
export function depositWords(name: string, amount: bigint): string {
  return `${usdOrDust(amount)} of yours is sitting at ${name}. A repayment sent ${name} a little more than it was owed, and it kept the rest as your deposit. Bringing it back puts it in your account as USDC, and needs no check.`;
}

/** "$192.53 to Rhea, then $107.47 to our pool". */
export function splitWords(split: { source: FundingSource; amount: bigint }[]): string {
  return split.map((p, i) => `${i > 0 ? 'then ' : ''}${formatUsd(p.amount)} to ${inSentence(p.source)}`).join(', ');
}

/** What the pool owes the account back, in micro-USD: 0 with no pricing answer. */
export function creditOwed(pricing: Pick<PricingView, 'credit'> | null | undefined): bigint {
  const credit = toMicro(pricing?.credit);
  return credit > 0n ? credit : 0n;
}

/** Why the pool owes a credit, for the client. */
export function creditWords(credit: bigint): string {
  return `Our pool owes you ${formatUsd(credit)}. It pays part of a lender’s rate for you, and that came to more than you owe the pool. Claiming sends it to your account as USDC.`;
}
