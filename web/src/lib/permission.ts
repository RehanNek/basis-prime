// The funding permission (FUNDING.md 4.2; INTERFACES.md 24 and 25), stage 2: what the owner signs so that part of a
// loan can come from an outside lender, in plain words, and the checks the account contract makes on it
// (contracts/types/src/lib.rs, Permission::problem). Pure functions, so the words can be tested.
import { fallBp, formatCushion, percent, sourceName } from './funding.ts';
import type { LenderName, Permission } from './types.ts';
import { formatBp } from './units.ts';

/** The lenders, in the order every list uses (INTERFACES.md 24). */
export const LENDER_ORDER: LenderName[] = ['aave', 'rhea'];

/** The app's default terms (INTERFACES.md 24): a cushion of 1.5, at most 25% a year, moves allowed. */
export const DEFAULT_TERMS = { min_hf_bp: 15_000, max_rate_bp: 2_500, moves: 'any' } as const;

/** The contract's own bounds: a cushion of 1.2 to 5.0, and a rate above 0 and at most 100% a year. */
export const CUSHION_BOUNDS_BP = { min: 12_000, max: 50_000 } as const;
export const RATE_BOUNDS_BP = { min: 1, max: 10_000 } as const;

/**
 * The lenders a config has settings for, from the `lenders` of the factory's or an account's `get_config()`. A config
 * from before Phase 6 has none.
 */
export function configuredLenders(config: unknown): LenderName[] {
  const lenders = (config as { lenders?: Partial<Record<LenderName, unknown>> | null } | null | undefined)?.lenders;
  if (!lenders || typeof lenders !== 'object') return [];
  return LENDER_ORDER.filter((l) => lenders[l] !== null && lenders[l] !== undefined);
}

/** The permission the app offers at account opening: every lender the account will have, on the default terms. */
export function defaultPermission(available: LenderName[]): Permission | null {
  const lenders = LENDER_ORDER.filter((l) => available.includes(l));
  return lenders.length > 0 ? { lenders, ...DEFAULT_TERMS } : null;
}

/** "Rhea", "Aave and Rhea". */
export function lenderList(lenders: string[]): string {
  const names = lenders.map(sourceName);
  return names.length <= 1 ? (names[0] ?? 'None') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * What the account would refuse about this permission, in plain words, or null when it would take it. `available` is
 * the lenders the account's config has settings for. A permission that names no lender is one the page won't send:
 * cancelling says the same thing more plainly.
 */
export function permissionProblem(permission: Permission, available: LenderName[]): string | null {
  if (permission.lenders.length === 0) return 'Pick at least one lender. To stop lenders altogether, cancel the permission instead.';
  for (const [i, l] of permission.lenders.entries()) {
    if (!LENDER_ORDER.includes(l)) return `${sourceName(l)} isn’t a lender this account knows: the lenders are Aave and Rhea.`;
    if (!available.includes(l)) return `This account has no settings for ${sourceName(l)}, so it can’t be named.`;
    if (permission.lenders.indexOf(l) !== i) return `${sourceName(l)} is named twice.`;
  }
  const { min_hf_bp: cushion, max_rate_bp: rate } = permission;
  if (!Number.isInteger(cushion) || cushion < CUSHION_BOUNDS_BP.min || cushion > CUSHION_BOUNDS_BP.max) {
    return `The smallest cushion must be between ${formatCushion(CUSHION_BOUNDS_BP.min)} and ${formatCushion(CUSHION_BOUNDS_BP.max)}.`;
  }
  if (!Number.isInteger(rate) || rate < RATE_BOUNDS_BP.min || rate > RATE_BOUNDS_BP.max) {
    return 'The highest rate must be above 0% and at most 100% a year.';
  }
  return null;
}

const MOVES: Record<Permission['moves'], string> = {
  any: 'Allowed',
  lower_cost_only: 'Only to a cheaper lender',
  off: 'Not allowed',
};

/** A `moves` setting in a word or two. */
export const movesWords = (moves: Permission['moves']): string => MOVES[moves] ?? String(moves);

export interface Term {
  label: string;
  value: string;
  /** What the term means, with a number to picture it. */
  note: string;
}

/**
 * The permission's four terms, each with what it means: which lenders, the smallest cushion, the highest rate, moves.
 * `posted` is what a lender takes from this account, in a word (lib/funding.ts): bitcoin, or "bitcoin or ether" for an
 * account whose settings let Rhea take test ETH too (INTERFACES.md 51.1).
 */
export function permissionTerms(permission: Permission, posted = 'bitcoin'): Term[] {
  const one = permission.lenders.length === 1;
  return [
    {
      label: one ? 'Lender' : 'Lenders',
      value: lenderList(permission.lenders),
      note: `Part of a loan may come from ${one ? 'this lender' : 'these lenders'}. A lender looks only at the ${posted} posted with it.`,
    },
    {
      label: 'Smallest cushion',
      value: formatCushion(permission.min_hf_bp),
      note: `At 1.00 a lender sells the ${posted} posted with it. A new loan there must leave at least ${formatCushion(permission.min_hf_bp)}, so ${posted} could fall ${percent(fallBp(permission.min_hf_bp))} first.`,
    },
    {
      label: 'Highest rate',
      value: `${formatBp(permission.max_rate_bp)} a year`,
      note: `The engine borrows from a lender only while its rate is at or under this. On $1,000 for a year, that is at most $${((1_000 * permission.max_rate_bp) / 10_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}.`,
    },
    {
      label: 'Moving a loan between lenders',
      value: movesWords(permission.moves),
      note: 'The engine doesn’t move a running loan yet. This is your answer for when it can.',
    },
  ];
}

/** The permission in one line, for a list. */
export function permissionSummary(permission: Permission | null | undefined): string {
  if (!permission) return 'No permission is signed: every loan comes from our pool alone.';
  if (permission.lenders.length === 0) return 'The permission names no lender, so every loan comes from our pool alone.';
  return `${lenderList(permission.lenders)} may lend to this account, down to a cushion of ${formatCushion(permission.min_hf_bp)} and up to ${formatBp(permission.max_rate_bp)} a year.`;
}

/** What the permission never allows (FUNDING.md 4.6), said once wherever it is signed. `posted` as in `permissionTerms`. */
export const permissionLimits = (posted = 'bitcoin'): string =>
  `It moves no money by itself. Every loan still needs your own signature for its amount, your ${posted} goes to a lender only as your own position there, and repaying is never blocked.`;
export const PERMISSION_LIMITS = permissionLimits();

/** What cancelling does, and doesn't (FUNDING.md 4.2). */
export const CANCEL_WORDS =
  'After cancelling, the account takes no new loan from a lender. What it already owes a lender stays until you repay it, and the engine still tops up a thin cushion.';

/**
 * A change leaves the account's counter alone (INTERFACES.md 40.1). The account records the block instead, and a new
 * loan needs a check read after it. A check for a withdrawal is not touched.
 */
export const CHANGE_WORDS = 'A check you ran before the change can’t back a new loan after it: run it again.';

/** "1.5" -> 15000, for the cushion field. Null when it isn't a number with at most two decimals. */
export function parseCushion(text: string): number | null {
  const match = /^\d{1,2}(\.\d{0,2})?$/.exec(text.trim());
  return match ? Math.round(Number(match[0]) * 10_000) : null;
}

/** "25" or "25.5" (percent a year) -> 2500 or 2550 bp. Null when it isn't a number with at most two decimals. */
export function parsePercent(text: string): number | null {
  const match = /^\d{1,3}(\.\d{0,2})?$/.exec(text.trim());
  return match ? Math.round(Number(match[0]) * 100) : null;
}

/** The Account page's form for a permission: the cushion as "1.5" and the rate as a percent, as people type them. */
export interface PermissionDraft {
  lenders: LenderName[];
  cushion: string;
  rate: string;
  moves: Permission['moves'];
}

/** A permission as the form shows it: 15000 -> "1.5", 2500 -> "25". */
export function draftOf(permission: Permission): PermissionDraft {
  return { lenders: [...permission.lenders], cushion: String(permission.min_hf_bp / 10_000), rate: String(permission.max_rate_bp / 100), moves: permission.moves };
}

/** The form as a permission the account would take, or what to fix. The lenders come out in the usual order. */
export function permissionFromDraft(draft: PermissionDraft, available: LenderName[]): { permission: Permission | null; problem: string | null } {
  const cushion = parseCushion(draft.cushion);
  if (cushion === null) return { permission: null, problem: 'Enter the smallest cushion as a number, like 1.5' };
  const rate = parsePercent(draft.rate);
  if (rate === null) return { permission: null, problem: 'Enter the highest rate as a percent, like 25' };
  const permission: Permission = { lenders: LENDER_ORDER.filter((l) => draft.lenders.includes(l)), min_hf_bp: cushion, max_rate_bp: rate, moves: draft.moves };
  const problem = permissionProblem(permission, available);
  return problem ? { permission: null, problem } : { permission, problem: null };
}

/** Are two permissions the same terms? Both null counts as the same. */
export function samePermission(a: Permission | null | undefined, b: Permission | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.min_hf_bp === b.min_hf_bp && a.max_rate_bp === b.max_rate_bp && a.moves === b.moves && a.lenders.length === b.lenders.length && a.lenders.every((l, i) => l === b.lenders[i]);
}
