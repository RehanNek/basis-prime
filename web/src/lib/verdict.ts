// The verdict in plain words (RISK_ENGINE.md Appendix A and 8), and whether a stored verdict can back an
// action now, by the same rules the account contract applies (INTERFACES.md 4).
import { belowLimit } from './borrow.ts';
import type { Intent, Refusal, RiskAction, RiskState, StoredVerdict, Tier, Token, Verdict } from './types.ts';
import { displayUnits, formatBp, formatUsd } from './units.ts';

/** INTERFACES.md 4: a verdict backs an action for at most 120 blocks after the block pb-risk read (`blk`). */
export const VERDICT_LIFETIME_BLOCKS = 120;
/** Testnet's block time, measured on 7 Nov over 1,000 blocks: so 120 blocks is a little over a minute. */
export const SECONDS_PER_BLOCK = 0.61;

export interface Freshness {
  /** Blocks since pb-risk read the chain. */
  age: number;
  blocksLeft: number;
  secondsLeft: number;
  fresh: boolean;
}

export function freshness(blk: number, height: number): Freshness {
  const age = Math.max(0, height - blk);
  const blocksLeft = Math.max(0, VERDICT_LIFETIME_BLOCKS - age);
  return { age, blocksLeft, secondsLeft: Math.round(blocksLeft * SECONDS_PER_BLOCK), fresh: age <= VERDICT_LIFETIME_BLOCKS };
}

/**
 * What the action needs the verdict to answer. Phase 6 (INTERFACES.md 25) adds `fund` and `lender_withdraw`. A `fund`
 * verdict may lend less than was asked: `partial` says the client has seen that and goes on with it.
 */
export type Use =
  | { borrow: { amount: string } }
  | { withdraw: { token: string; amount: string } }
  | { fund: { amount: string; partial?: boolean } }
  | { lender_withdraw: { lender: string; token: string; amount: string } }
  | { evm_withdraw: { token: string; amount: string } };

/**
 * INTERFACES.md 40.1 (the second audit's A8): changing the lender permission no longer moves the counter. The account
 * records the block of the change (`permission_blk` in get_state; 0 if none was ever set, and missing on an account
 * made before the fix), and `fund` refuses a held verdict whose `blk` isn't above it. So a check the engine read at
 * or before that block can't back a loan.
 */
export const beforePermissionChange = (blk: number, permissionBlk: number | null | undefined): boolean =>
  typeof permissionBlk === 'number' && permissionBlk > 0 && blk <= permissionBlk;

/** What the app says of such a check. The flow then asks for a new one, as it does for a check that was used. */
export const BEFORE_PERMISSION_WORDS = 'It was run before your lender permission last changed: a check from before the change can’t back a loan.';

/**
 * Can the stored verdict back this action now? The account contract refuses unless the verdict carries
 * the current counter, is at most 120 blocks old, answers this kind of intent, and allows the amount. For `fund` it
 * must also have been read after the permission last changed: `permissionBlk` is the account's `permission_blk`.
 */
export function verdictUse(stored: StoredVerdict | null, counter: number, height: number, use: Use, permissionBlk?: number | null): { ok: boolean; why: string } {
  if (!stored) return { ok: false, why: 'No check yet: run one first.' };
  const { verdict, intent } = stored;
  if (verdict.nonce !== counter) {
    return { ok: false, why: 'Already used: each check backs one action, and this one has backed one.' };
  }
  const age = freshness(verdict.blk, height);
  if (!age.fresh) return { ok: false, why: `Too old: ${age.age} blocks since the risk engine read the chain, and a check lasts ${VERDICT_LIFETIME_BLOCKS} (about a minute).` };

  if ('borrow' in use) {
    if (!('borrow' in intent)) return { ok: false, why: `It answers ${intentKind(intent)}, not a borrow: ask for a borrow check.` };
    const allowed = BigInt(Math.trunc(verdict.allow.borrow));
    if (BigInt(use.borrow.amount) > allowed) {
      return { ok: false, why: `It allows borrowing up to ${displayUnits(allowed, 6, 6)} USDC, less than ${displayUnits(use.borrow.amount, 6, 6)}.` };
    }
  } else if ('fund' in use) {
    // fund(amount) on the account: the same amount, a HEALTHY state and at least one funding step.
    if (!('fund' in intent)) return { ok: false, why: `It answers ${intentKind(intent)}, not a loan: run the check again.` };
    if (beforePermissionChange(verdict.blk, permissionBlk)) return { ok: false, why: BEFORE_PERMISSION_WORDS };
    if (intent.fund.amount !== use.fund.amount) return { ok: false, why: 'It answers a loan of another amount.' };
    if (verdict.state !== 'HEALTHY') return { ok: false, why: 'Only a safe account can borrow more.' };
    const lends = fundLends(stored);
    if (lends === 0n) return { ok: false, why: 'The engine found nothing to lend now.' };
    if (lends < BigInt(use.fund.amount) && !use.fund.partial) {
      return { ok: false, why: `It would lend ${formatUsd(lends)} of the ${formatUsd(use.fund.amount)} you asked for.` };
    }
  } else if ('lender_withdraw' in use) {
    if (!('lender_withdraw' in intent)) return { ok: false, why: `It answers ${intentKind(intent)}, not taking collateral back from a lender: run the check again.` };
    const asked = intent.lender_withdraw;
    const wanted = use.lender_withdraw;
    if (asked.lender !== wanted.lender || asked.token !== wanted.token || asked.amount !== wanted.amount) {
      return { ok: false, why: 'It answers another lender, token or amount.' };
    }
    if (BigInt(Math.trunc(verdict.allow.withdraw)) < BigInt(wanted.amount)) {
      return { ok: false, why: 'It doesn’t allow taking this much back: what stays posted must still cover your loans, with the cushion the engine keeps.' };
    }
  } else if ('evm_withdraw' in use) {
    // Stage 3: sending a token out of the address on Aave's chain, with `allow.withdraw` equal to the amount.
    if (!('evm_withdraw' in intent)) return { ok: false, why: `It answers ${intentKind(intent)}, not sending a token out of the address: run the check again.` };
    if (intent.evm_withdraw.token !== use.evm_withdraw.token || intent.evm_withdraw.amount !== use.evm_withdraw.amount) {
      return { ok: false, why: 'It answers another token or amount.' };
    }
    if (BigInt(Math.trunc(verdict.allow.withdraw)) < BigInt(use.evm_withdraw.amount)) {
      return { ok: false, why: 'It doesn’t allow sending this much out: what stays must still cover your loans.' };
    }
  } else {
    if (!('withdraw' in intent)) return { ok: false, why: `It answers ${intentKind(intent)}, not a withdrawal: ask for a withdraw check.` };
    if (intent.withdraw.token !== use.withdraw.token || intent.withdraw.amount !== use.withdraw.amount) {
      return { ok: false, why: 'It answers a withdrawal of another token or amount.' };
    }
  }
  return { ok: true, why: `Fresh for ${age.blocksLeft} more blocks (about ${age.secondsLeft} s).` };
}

/** What a `fund` verdict's steps lend in all, in micro-USD: 0 for any other verdict, and for one with no steps. */
export function fundLends(stored: StoredVerdict | null): bigint {
  if (!stored || !('fund' in stored.intent)) return 0n;
  const { fund, allow } = stored.verdict;
  if (!Array.isArray(fund) || fund.length === 0) return 0n;
  const lends = BigInt(Math.trunc(allow.fund ?? 0));
  return lends > 0n ? lends : 0n;
}

/**
 * After a refusal: the smaller amount the same check still backs, or 0. For a borrow, a little under the verdict's
 * allowance. For a loan from every source, what its steps lend, when that is less than was asked.
 */
export function lesserAmount(stored: StoredVerdict): bigint {
  if ('borrow' in stored.intent) return belowLimit(BigInt(Math.trunc(stored.verdict.allow.borrow)));
  if ('fund' in stored.intent && stored.verdict.state === 'HEALTHY') {
    const lends = fundLends(stored);
    return lends < BigInt(stored.intent.fund.amount) ? lends : 0n;
  }
  return 0n;
}

function intentKind(intent: Intent): string {
  if ('borrow' in intent) return 'a borrow';
  if ('withdraw' in intent) return 'a withdrawal';
  if ('fund' in intent) return 'a loan';
  if ('lender_withdraw' in intent) return 'taking collateral back from a lender';
  if ('evm_withdraw' in intent) return 'sending a token out of the address on Aave’s chain';
  return 'a plain check';
}

/** An intent in words: "a check", "borrowing 24,150 USDC", "withdrawing 0.25 nBTC". */
export function intentWords(intent: Intent, tokens: Token[]): string {
  if ('borrow' in intent) return `borrowing ${displayUnits(intent.borrow.amount, 6)} USDC`;
  if ('withdraw' in intent) {
    const token = tokens.find((t) => t.id === intent.withdraw.token);
    return `withdrawing ${token ? `${displayUnits(intent.withdraw.amount, token.decimals)} ${token.symbol}` : `${intent.withdraw.amount} units of ${intent.withdraw.token}`}`;
  }
  if ('fund' in intent) return `a loan of ${displayUnits(intent.fund.amount, 6)} USDC, from the sources the engine picks`;
  if ('lender_withdraw' in intent) {
    const { lender, amount } = intent.lender_withdraw;
    const token = tokens.find((t) => t.id === intent.lender_withdraw.token);
    const name = lender === 'aave' ? 'Aave' : lender === 'rhea' ? 'Rhea' : lender;
    return `taking ${token ? `${displayUnits(amount, token.decimals)} ${token.symbol}` : `${amount} units of ${intent.lender_withdraw.token}`} back from ${name}`;
  }
  if ('evm_withdraw' in intent) {
    const token = tokens.find((t) => t.id.toLowerCase() === intent.evm_withdraw.token.toLowerCase());
    const amount = intent.evm_withdraw.amount;
    return `sending ${token ? `${displayUnits(amount, token.decimals)} ${token.symbol}` : `${amount} units of ${intent.evm_withdraw.token}`} out of the account’s address on Aave’s chain`;
  }
  return 'a check';
}

export type Tone = 'success' | 'warning' | 'danger' | 'dark' | 'secondary';

/** RISK_ENGINE.md 8.1. States apply only while there is a loan: with none, an account is always HEALTHY. */
const STATES: Record<RiskState, { label: string; tone: Tone; words: string }> = {
  HEALTHY: { label: 'Healthy', tone: 'success', words: 'Equity is above the initial requirement: borrowing and withdrawing are open, within the allowances.' },
  WATCH: { label: 'Watch', tone: 'warning', words: 'Equity is between the safety buffer and the initial requirement: only actions that lower risk.' },
  MARGIN_CALL: { label: 'Margin call', tone: 'warning', words: 'Equity is below the safety buffer: there are 4 hours to add collateral, repay or reduce.' },
  DELEVERAGE: { label: 'Deleverage', tone: 'danger', words: 'Equity is well below the safety buffer, or a margin call ran out: anyone can run the signed unwind plan.' },
  DEFAULT: { label: 'Default', tone: 'dark', words: 'Debt is left after everything was sold: the pool writes it off from its own capital.' },
};

/** RISK_ENGINE.md 8.2 and 8.4. */
const ACTIONS: Record<RiskAction, string | null> = {
  NONE: null,
  REBALANCE: 'Rebalance: move USDC to the Hyperliquid margin, back to a 30% margin ratio.',
  REBALANCE_NOW: 'Rebalance now: Hyperliquid is close to liquidating, so margin moves at once.',
  DELEVERAGE: 'Deleverage: unwind part of the book, step by step, until equity is back above the initial requirement.',
};

const TIERS: Record<Tier, { name: string; cap: string }> = {
  PREFERRED: { name: 'Preferred', cap: '85%' },
  STANDARD: { name: 'Standard', cap: '70%' },
  WATCH: { name: 'Watch', cap: '50%' },
};

/** The bound that set the credit line (RISK_ENGINE.md 7.2), in words. Anything after the code is kept. */
export function bindingWords(binding: string, tier?: Tier): string {
  const code = /^C\d/.exec(binding)?.[0];
  const rest = binding.slice(code?.length ?? 0).replace(/^[\s:_-]+/, '');
  const t = tier ? TIERS[tier] : undefined;
  const words: Record<string, string> = {
    C0: 'what the collateral is worth for credit (no credit under $1,000)',
    C1: 'staying above the initial requirement after the loan, in the worst stress scenario',
    C2: 'the pool losing nothing on a normal bad day',
    C3: 'the pool losing at most 5% of the loan on an extreme day',
    C4: t ? `the ${t.name} tier's cap: ${t.cap} of the collateral` : "the tier's cap on the collateral",
    C5: "the client's limit, which grows with each good month",
    C6: "the pool's room: at most 90% lent out, and one client at most 25% of it",
    C7: "the pool's cap on loans resting on one bridged token",
    C8: 'a position that would take more than a day to unwind',
    C9: 'a score below 450: no new credit',
  };
  const said = code ? words[code] : undefined;
  if (!said) return binding || 'not given';
  return rest ? `${said} (${rest})` : said;
}

export interface VerdictSummary {
  ok: boolean;
  state: { label: string; tone: Tone; words: string } | null;
  action: string | null;
  headline: string;
  facts: { label: string; value: string }[];
  risks: string[];
  warnings: string[];
}

/** Everything the UI shows about a verdict, in words. */
export function summarizeVerdict(answer: Verdict | Refusal): VerdictSummary {
  if (!answer.ok) {
    return { ok: false, state: null, action: null, headline: `The risk engine made no decision: ${answer.reason}`, facts: [], risks: [], warnings: [] };
  }
  const v = answer;
  const state = STATES[v.state] ?? { label: v.state, tone: 'secondary' as const, words: '' };
  const tier = TIERS[v.tier];
  const facts = [
    { label: 'Can borrow now', value: formatUsd(v.allow.borrow) },
    { label: 'Credit line (the most it may owe)', value: formatUsd(v.credit.line) },
    { label: 'What sets the line', value: bindingWords(v.credit.binding, v.tier) },
    { label: 'Can withdraw now, with a loan', value: `${formatUsd(v.allow.withdraw)} of USDC` },
    { label: 'Equity (for credit)', value: `${formatUsd(v.eq)} (${formatUsd(v.eq_allow)})` },
    { label: 'Initial requirement / safety buffer', value: `${formatUsd(v.im)} / ${formatUsd(v.mm)}` },
    { label: 'Score and tier', value: `${v.score}, ${tier?.name ?? v.tier}` },
    { label: 'Rate', value: `${formatBp(v.rate_bp)} a year` },
  ];

  const warnings: string[] = [];
  if (v.topup > 0) warnings.push(`A Hyperliquid top-up of ${formatUsd(v.topup)} would remove a liquidation from the top risks.`);
  const coins = v.coins ?? { uncertain: [], stale: [], reduce_only: [] };
  if (coins.uncertain.length) warnings.push(`Prices uncertain for ${coins.uncertain.join(', ')}: no new risk in them.`);
  if (coins.stale.length) warnings.push(`Prices stale for ${coins.stale.join(', ')}.`);
  if (coins.reduce_only.length) warnings.push(`Reduce-only: ${coins.reduce_only.join(', ')}.`);

  return {
    ok: true,
    state,
    action: v.action in ACTIONS ? ACTIONS[v.action] : v.action, // NONE has no words of its own
    headline: `${state.label}. It may borrow ${formatUsd(v.allow.borrow)} more now, against a credit line of ${formatUsd(v.credit.line)}.`,
    facts,
    risks: v.top ?? [],
    warnings,
  };
}
