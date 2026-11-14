// What a client pays when part of a loan comes from an outside lender (FUNDING.md 5; INTERFACES.md 26), stage 2: the
// operator's policies in words, the rate a policy makes a client pay, the checks the pool makes on a policy
// (contracts/pool/src/pricing.rs), and the Book page's view of GET /api/pricing. Pure functions, so they can be tested.
import type { FundingOrder, FundingPlanAnswer, FundingSettings, FundingSource, Micro, Pricing, PricingAnswer, PricingLimits, PricingTarget, PricingView } from './api.ts';
import { blendedBp, planView, sourceName, toMicro, type PlanView } from './funding.ts';
import type { Tier } from './types.ts';
import { formatBp, formatUsd } from './units.ts';

/** No policy rate, margin or cap is above 100% a year (pricing.rs, MAX_BP). */
export const MAX_POLICY_BP = 10_000;

export const TIERS: Tier[] = ['PREFERRED', 'STANDARD', 'WATCH'];
const TIER_NAMES: Record<Tier, string> = { PREFERRED: 'Preferred', STANDARD: 'Standard', WATCH: 'Watch' };
export const tierName = (tier: Tier): string => TIER_NAMES[tier] ?? String(tier);

/** Basis points as points of interest: 120 -> "1.20 points", 100 -> "1.00 point". */
const points = (bp: number): string => `${(Math.abs(bp) / 100).toFixed(2)} point${Math.abs(bp) === 100 ? '' : 's'}`;

/** A policy in a few words: what the client pays on the lender's part, or on the whole loan. */
export function pricingWords(pricing: Pricing | null | undefined): string {
  if (!pricing || pricing === 'pass_through') return 'Each source at its own rate';
  if ('fixed' in pricing) return `${formatBp(pricing.fixed.rate_bp)} a year on the whole loan`;
  const { margin_bp, cap_bp } = pricing.lender;
  const base = margin_bp === 0 ? 'The lender’s rate' : `The lender’s rate ${margin_bp > 0 ? 'plus' : 'less'} ${points(margin_bp)}`;
  return cap_bp === null || cap_bp === undefined ? base : `${base}, but never above ${formatBp(cap_bp)}`;
}

/** What is wrong with a policy, as the pool would say it, or null when the pool would take it (Pricing::problem). */
export function pricingProblem(pricing: Pricing): string | null {
  if (pricing === 'pass_through') return null;
  const whole = (n: unknown) => typeof n === 'number' && Number.isInteger(n);
  if ('fixed' in pricing) {
    const rate = pricing.fixed.rate_bp;
    return !whole(rate) || rate < 0 || rate > MAX_POLICY_BP ? 'The rate must be between 0% and 100% a year.' : null;
  }
  const { margin_bp, cap_bp } = pricing.lender;
  if (!whole(margin_bp) || Math.abs(margin_bp) > MAX_POLICY_BP) return 'The margin must be between -100 and 100 points.';
  if (cap_bp !== null && (!whole(cap_bp) || cap_bp < 0 || cap_bp > MAX_POLICY_BP)) return 'The cap must be between 0% and 100% a year.';
  return null;
}

export type PolicyKind = 'pass_through' | 'lender' | 'fixed';

/** Which of the three kinds a policy is. */
export function policyKind(pricing: Pricing | null | undefined): PolicyKind {
  return !pricing || pricing === 'pass_through' ? 'pass_through' : 'fixed' in pricing ? 'fixed' : 'lender';
}

/** "1.2" or "-0.5" (points or percent) -> 120 or -50 bp. Null when it isn't a number with at most two decimals. */
export function parsePoints(text: string, signed = false): number | null {
  const match = (signed ? /^-?\d{1,3}(\.\d{0,2})?$/ : /^\d{1,3}(\.\d{0,2})?$/).exec(text.trim());
  return match ? Math.round(Number(match[0]) * 100) : null;
}

/**
 * The operator's form as a policy. `margin` is in points and may be negative, `cap` and `rate` are percent a year; an
 * empty `cap` means no cap. The problem says what to fix.
 */
export function pricingFromForm(form: { kind: PolicyKind; margin: string; cap: string; rate: string }): { pricing: Pricing | null; problem: string | null } {
  if (form.kind === 'pass_through') return { pricing: 'pass_through', problem: null };
  let pricing: Pricing;
  if (form.kind === 'fixed') {
    const rate = parsePoints(form.rate);
    if (rate === null) return { pricing: null, problem: form.rate.trim() ? 'Enter the rate as a percent, like 6.5' : null };
    pricing = { fixed: { rate_bp: rate } };
  } else {
    const margin = form.margin.trim() ? parsePoints(form.margin, true) : 0;
    if (margin === null) return { pricing: null, problem: 'Enter the margin in points, like 1.2 or -0.5' };
    const cap = form.cap.trim() ? parsePoints(form.cap) : null;
    if (form.cap.trim() && cap === null) return { pricing: null, problem: 'Enter the cap as a percent, like 8, or leave it empty' };
    pricing = { lender: { margin_bp: margin, cap_bp: cap } };
  }
  const problem = pricingProblem(pricing);
  return problem ? { pricing: null, problem } : { pricing, problem: null };
}

/**
 * The rate a policy makes the client pay on one source, in bp a year (pricing.rs, client_rate, and the Fixed rule for
 * our pool's own part). `ownBp` is what the source itself charges; `supplyBp` is what a lender pays depositors.
 *
 * The floor: when the policy's rate is under the lender's own (a subsidy), it is raised to the lender's deposit rate
 * if that is higher, and never above the lender's own. The pool settles on the lender's rate as it counts it (at most
 * 60%, and its 7-day average plus 5 points), which this page can't know: here the rate counts as reported.
 */
export function clientRateBp(pricing: Pricing | null | undefined, source: FundingSource | string, ownBp: number, supplyBp = 0): number {
  if (!pricing || pricing === 'pass_through') return ownBp;
  if (source === 'pool') return 'fixed' in pricing ? pricing.fixed.rate_bp : ownBp;
  const target = 'fixed' in pricing ? pricing.fixed.rate_bp : Math.min(Math.max(0, ownBp + pricing.lender.margin_bp), pricing.lender.cap_bp ?? Number.MAX_SAFE_INTEGER);
  return target < ownBp ? Math.min(Math.max(target, supplyBp), ownBp) : target;
}

/**
 * How a client's rate on a lender's part differs from the lender's own, in a few words, or null when it doesn't:
 * "Rhea charges 15.91%; we pay the rest", "Aave charges 5.33%; the rest is our margin".
 */
export function policyNote(source: string, ownBp: number, payBp: number): string | null {
  if (payBp === ownBp) return null;
  if (source === 'pool') return `Our pool’s own rate is ${formatBp(ownBp)}`;
  return `${sourceName(source)} charges ${formatBp(ownBp)}; ${payBp < ownBp ? 'we pay the rest' : 'the rest is our margin'}`;
}

/**
 * Under a lender card's rate, when the pool's policy makes the client pay another rate than the lender charges:
 * "You pay 10.32%: we pay the rest". Null when they are the same, or the lender's rate wasn't read.
 */
export function cardRateNote(pricing: Pricing | null | undefined, lender: string, ownBp: number | null, supplyBp: number | null): string | null {
  if (ownBp === null) return null;
  const pays = clientRateBp(pricing, lender, ownBp, supplyBp ?? 0);
  if (pays === ownBp) return null;
  return `You pay ${formatBp(pays)}: ${pays < ownBp ? 'we pay the rest' : 'the rest is our margin'}`;
}

/** What a lender pays depositors, from a plan's `ext` (the engine's reading of each lender position): 0 when it isn't there. */
function supplyBp(ext: unknown[] | undefined, lender: string): number {
  const entry = (ext ?? []).find((e) => (e as { l?: unknown } | null)?.l === lender) as { s_bp?: unknown } | undefined;
  return typeof entry?.s_bp === 'number' ? entry.s_bp : 0;
}

/**
 * "Where it comes from" with what the client pays: the borrow panel's sources (lib/funding.ts, planView), each at the
 * rate the pool's policy for the account makes of it, and the whole loan at those rates. A row whose rate the policy
 * changes says how. With no policy, or pass-through, it is planView's own answer.
 */
export function pricedPlan(answer: FundingPlanAnswer | null | undefined, pricing: Pricing | null | undefined): PlanView | null {
  const view = planView(answer);
  if (!view || !pricing || pricing === 'pass_through') return view;
  const sources = (answer?.sources ?? []).filter((s) => toMicro(s.amount) > 0n);
  const pays = sources.map((s) => (s.rate_bp === null ? null : clientRateBp(pricing, s.source, s.rate_bp, supplyBp(answer?.ext, s.source))));
  const blended = blendedBp(sources.map((s, i) => ({ amount: s.amount, rate_bp: pays[i] ?? null })));
  return {
    ...view,
    rows: view.rows.map((row, i) => {
      const own = sources[i]?.rate_bp ?? null;
      const pay = pays[i] ?? null;
      const note = own !== null && pay !== null ? policyNote(row.source, own, pay) : null;
      return { ...row, rate: pay === null ? null : formatBp(pay), ...(note && { note }) };
    }),
    rate: blended === null ? null : formatBp(blended),
  };
}

/**
 * A policy with a dollar example, for the operator's form: what a client would pay on $10,000 from a lender at
 * `lenderBp` that pays depositors `supplyBp`, and what we keep or pay. When the floor lifts the client's rate, it says so.
 */
export function pricingExample(pricing: Pricing, lenderBp: number, supplyBp = 0): string {
  const pays = clientRateBp(pricing, 'rhea', lenderBp, supplyBp);
  const year = (bp: number) => `$${Math.round(Math.abs(bp)).toLocaleString('en-US')}`;
  const start = `On $10,000 from a lender at ${formatBp(lenderBp)}, the client pays ${formatBp(pays)}: ${year(pays)} a year.`;
  if (pays === lenderBp) return `${start} We keep nothing and pay nothing.`;
  const floored = pays !== clientRateBp(pricing, 'rhea', lenderBp, 0);
  const ours = pays > lenderBp ? `We keep ${year(pays - lenderBp)}.` : `We pay ${year(lenderBp - pays)}.`;
  return `${start} ${ours}${floored ? ` The client never pays less than that lender pays its own depositors, ${formatBp(supplyBp)}.` : ''}`;
}

const ORDERS: Record<FundingOrder, string> = {
  cheapest: 'The cheapest source first',
  pool_first: 'Our pool first',
  lender_first: 'A lender first',
};
export const FUNDING_ORDERS = Object.keys(ORDERS) as FundingOrder[];

/** The source order in words. An order this page doesn't know counts as the cheapest first, as the engine reads it. */
export const orderWords = (order: string): string => ORDERS[order as FundingOrder] ?? ORDERS.cheapest;

/** The loan life from the operator's form: a whole number of days, at least 1 (FundingSettings::problem). */
export function fundingFromForm(form: { order: FundingOrder; days: string }): { funding: FundingSettings | null; problem: string | null } {
  const text = form.days.trim();
  if (!/^\d{1,5}$/.test(text) || Number(text) < 1) return { funding: null, problem: text ? 'The loan life must be a whole number of days, at least 1.' : null };
  return { funding: { order: form.order, loan_days: Number(text) }, problem: null };
}

/** `{"account": "<id>"}` or `{"tier": "STANDARD"}` in words. */
export const targetWords = (target: PricingTarget): string => ('account' in target ? target.account : `every ${tierName(target.tier)} account`);

const FROM: Record<PricingView['from'], string> = { account: 'Set for this account', tier: 'From its tier', default: 'The default' };

/** Where an account's policy came from. */
export const fromWords = (from: string): string => FROM[from as PricingView['from']] ?? from;

/**
 * What is lent through each lender, largest first: the sum of `lender_debt`, what each account owes a lender by its
 * held verdict. The pool's own `last` report isn't used: for a fresh loan it stays at 0 until the next settlement.
 */
export function lentThrough(accounts: { lender_debt?: { lender: string; debt: Micro }[] }[]): { lender: string; name: string; amount: bigint }[] {
  const sums = new Map<string, bigint>();
  for (const account of accounts) {
    for (const line of account.lender_debt ?? []) sums.set(line.lender, (sums.get(line.lender) ?? 0n) + toMicro(line.debt));
  }
  return [...sums.entries()]
    .filter(([, amount]) => amount > 0n)
    .map(([lender, amount]) => ({ lender, name: sourceName(lender), amount }))
    .sort((a, b) => (a.amount === b.amount ? a.name.localeCompare(b.name) : a.amount > b.amount ? -1 : 1));
}

/** The limits in a sentence: what a wrong report can cost at most (FUNDING.md 5.3). */
export function limitsWords(limits: PricingLimits | null | undefined): string | null {
  if (!limits) return null;
  return `A lender’s rate counts at no more than ${formatBp(limits.max_rate_bp)} a year, nor its 7-day average plus ${points(limits.avg_plus_bp)}. One account gets at most ${formatUsd(toMicro(limits.account_subsidy_day))} of subsidy a day, and the whole pool pays at most ${formatBp(limits.pool_subsidy_day_bp)} of its capital a day.`;
}

const nsToMs = (ns: string | number | null | undefined): number | null => {
  try {
    const ms = Number(BigInt(ns ?? 0) / 1_000_000n);
    return ms > 0 ? ms : null;
  } catch {
    return null;
  }
};

/**
 * The three limits on fees (INTERFACES.md 45.1; the second audit's P3), each in one plain line with a dollar figure.
 * `capital` is the pool's capital in micro-USD: with it the pool's line gives the pool's own figure, and without it
 * the same share on $10,000. A limit an older answer doesn't carry gets no line.
 */
export function feeLimitLines(limits: PricingLimits | null | undefined, capital?: Micro | null): string[] {
  if (!limits) return [];
  const lines: string[] = [];
  if (limits.max_lender_debt !== undefined) {
    lines.push(`A lender’s reported debt counts at no more than ${formatUsd(toMicro(limits.max_lender_debt))} in a settlement, for a fee and for a subsidy.`);
  }
  if (limits.account_fee_day !== undefined) {
    lines.push(`One account is charged at most ${formatUsd(toMicro(limits.account_fee_day))} of fees in 24 hours. A fee above that is cut, and isn’t owed later.`);
  }
  if (typeof limits.pool_fee_day_bp === 'number') {
    const own = capital === null || capital === undefined ? 0n : toMicro(capital);
    const base = own > 0n ? own : 10_000_000_000n;
    const most = formatUsd((base * BigInt(Math.trunc(limits.pool_fee_day_bp))) / 10_000n);
    lines.push(`The whole pool books at most ${formatBp(limits.pool_fee_day_bp)} of its capital in fees in 24 hours: ${most} on ${own > 0n ? 'its' : 'each'} ${formatUsd(base)}.`);
  }
  return lines;
}

/** The pool's `max_period_ns` when the answer has none: 48 hours. */
const MAX_PERIOD_HOURS = 48;

/**
 * What one settlement covers (INTERFACES.md 45.1, point 3; the audit's P5): a fee covers all the time since the last
 * settlement, and a subsidy at most the pool's `max_period_ns` of it, 48 hours. The fee limits above bound what a
 * long gap can charge.
 */
export function periodWords(limits: PricingLimits | null | undefined): string {
  const ms = nsToMs(limits?.max_period_ns);
  const hours = ms === null ? MAX_PERIOD_HOURS : Math.round(ms / 3_600_000);
  return `A fee covers all the time since the account’s last settlement. A subsidy covers at most ${hours} hours of it.`;
}

export interface PricingBookRow {
  account: string;
  pays: string;
  from: string;
  /** "Rhea $50,667.00", one per lender with a loan; empty with none. */
  lent: string[];
  fees: string;
  subsidy: string;
  credit: string;
  /** Block time of the last settlement, ms, or null when none has run. */
  settledAtMs: number | null;
}

export interface PricingBook {
  order: string;
  loanDays: string;
  fees: string;
  subsidy: string;
  subsidyLeft: string;
  limits: string | null;
  /** The three limits on fees, one line each; empty for a pool from before them. */
  feeLimits: string[];
  lent: { name: string; amount: string }[];
  /** Every tier, with its policy or the default. */
  tiers: { tier: Tier; name: string; pays: string; own: boolean }[];
  accounts: PricingBookRow[];
  /** INTERFACES.md 48.5: the per-client lines are kept from this viewer: the page says so in their place. */
  accountsHidden: boolean;
}

/**
 * GET /api/pricing as the Book page shows it. Null when there is nothing to show: no answer, one of another shape, or
 * a pool from before stage 2, whose `funding`, `limits` and `pool` are null and whose lists are empty. `capital` is
 * the pool's capital (micro-USD), for the dollar figure in the pool's daily limit on fees.
 */
export function pricingBook(answer: PricingAnswer | null | undefined, capital?: Micro | null): PricingBook | null {
  if (!answer || !answer.pool || !Array.isArray(answer.accounts)) return null;
  const tiers = Array.isArray(answer.tiers) ? answer.tiers : [];
  return {
    order: orderWords(answer.funding?.order ?? 'cheapest'),
    loanDays: answer.funding?.loan_days ? `${answer.funding.loan_days} days` : '—',
    fees: formatUsd(toMicro(answer.pool.fees_charged)),
    subsidy: formatUsd(toMicro(answer.pool.subsidy_paid)),
    subsidyLeft: formatUsd(toMicro(answer.pool.subsidy_left_24h)),
    limits: limitsWords(answer.limits),
    feeLimits: feeLimitLines(answer.limits, capital),
    lent: lentThrough(answer.accounts).map((l) => ({ name: l.name, amount: formatUsd(l.amount) })),
    tiers: TIERS.map((tier) => {
      const own = tiers.find((t) => t.tier === tier);
      return { tier, name: tierName(tier), pays: pricingWords(own?.pricing), own: Boolean(own) };
    }),
    accountsHidden: answer.accounts_hidden === true,
    accounts: answer.accounts.map((a) => ({
      account: a.account,
      pays: pricingWords(a.pricing),
      from: fromWords(a.from),
      lent: lentThrough([a]).map((l) => `${l.name} ${formatUsd(l.amount)}`),
      fees: formatUsd(toMicro(a.fees_charged)),
      subsidy: formatUsd(toMicro(a.subsidy_paid)),
      credit: formatUsd(toMicro(a.credit)),
      settledAtMs: nsToMs(a.settled_at),
    })),
  };
}
