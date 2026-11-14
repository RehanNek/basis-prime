// The Home page's setup checklist (9 Nov redesign): five steps from a wallet to a hedged loan, each read from the
// chain and Hyperliquid, so the list is right after a reload or on another device.
import type { AccountAnswer, LenderAccountAnswer } from './api.ts';
import { hlSummary, loanOpen, setupStep, type HlAnswer } from './hl.ts';

export type SetupKey = 'wallet' | 'account' | 'collateral' | 'hedge' | 'aave' | 'borrow';

/**
 * Stage 3, testnet only: "Get test collateral for Aave", for an account whose config has Aave. `needed` until the
 * account's address on Aave's chain holds collateral or Aave holds some; `skipped` when the client chose to borrow
 * without it. Accounts without Aave, and mainnet, have no such step.
 */
export type TestCollateralStep = 'needed' | 'done' | 'skipped';

/** Where the hedge stands: its four setup parts (INTERFACES.md 12), then the short itself. */
export type HedgePart = 'address' | 'margin' | 'agent' | 'approve' | 'short' | 'done' | 'unavailable';

export interface SetupStepView {
  key: SetupKey;
  title: string;
  done: boolean;
  /** Passed over by the client: it counts as done for the order of the steps, and the list says it was skipped. */
  skipped?: boolean;
}

export interface SetupView {
  steps: SetupStepView[];
  done: number;
  /** The first step not done, or null when all are. */
  next: SetupKey | null;
  hedge: HedgePart;
  complete: boolean;
}

/**
 * Home's checklist (the user, 14 Nov: "all we want is to guide a person till they open the account. step 3 and
 * beyond are not required", and "we want that thing to go away after the account setup is done"): the wallet and the
 * account, nothing after. It is complete, and Home drops it, the moment the account is open. Collateral, the hedge
 * and the loan are the Basis trade tab's to lead through.
 */
export function openingView(view: SetupView): SetupView {
  const steps = view.steps.filter((s) => s.key === 'wallet' || s.key === 'account');
  const next = steps.find((s) => !s.done)?.key ?? null;
  return { steps, done: steps.filter((s) => s.done).length, next, hedge: view.hedge, complete: next === null };
}

export const TITLES: Record<SetupKey, string> = {
  wallet: 'Connect your NEAR wallet',
  account: 'Open your account',
  collateral: 'Add collateral',
  hedge: 'Hedge on Hyperliquid',
  aave: 'Get test collateral for Aave',
  borrow: 'Borrow',
};

/** The hedge parts in order, with what each does in a few words. */
export const HEDGE_PARTS: { part: Exclude<HedgePart, 'done' | 'unavailable'>; title: string }[] = [
  { part: 'address', title: 'Create the account’s Hyperliquid address' },
  { part: 'margin', title: 'Move USDC there as margin' },
  { part: 'agent', title: 'Connect the trading agent' },
  { part: 'approve', title: 'Approve the agent on Hyperliquid' },
  { part: 'short', title: 'Open the short' },
];

export function hedgePart(hl: HlAnswer | undefined): HedgePart {
  if (!hl) return 'address';
  if (!hl.gateway) return 'unavailable';
  const step = setupStep(hl);
  if (step === 'init') return 'address';
  if (step === 'fund') return 'margin';
  if (step === 'agent') return 'agent';
  if (step === 'approve') return 'approve';
  const positions = hl.hyperliquid ? hlSummary(hl.hyperliquid).positions : [];
  return positions.some((p) => p.side === 'short') ? 'done' : 'short';
}

/**
 * Where the testnet step "Get test collateral for Aave" stands (INTERFACES.md 33), or undefined when the account has
 * no such step: not on testnet, no reading of the account at its lenders yet, or no Aave in its config. It is done
 * once the address holds a token Aave takes (anything there but USDC), or Aave already holds some.
 *
 * `helperOn` is `on` from GET /api/evm/gas: whether the backend's gas helper, which hands the collateral out, is
 * running. Without it there is nothing to press, so the step shows only if it is done already.
 */
export function testCollateralStep(input: { testnet: boolean; lender: LenderAccountAnswer | null | undefined; skipped: boolean; helperOn: boolean | undefined }): TestCollateralStep | undefined {
  const { testnet, lender, skipped, helperOn } = input;
  if (!testnet || !lender || !(lender.config_lenders ?? []).includes('aave')) return undefined;
  const digits = (amount: unknown): boolean => typeof amount === 'string' && /^\d+$/.test(amount) && BigInt(amount) > 0n;
  const atAddress = (lender.evm?.wallet ?? []).some((t) => t.symbol !== 'USDC' && digits(t.amount));
  // What Aave holds is read live from its chain (`evm.posted`). The lender's row comes from the last check, which
  // still shows collateral after a close took it back, so it counts only while there is no live reading.
  const live = lender.evm?.posted;
  const atAave = live ? live.some((h) => digits(h.amount)) : lender.lenders.some((p) => p.l === 'aave' && ((p.held ?? []).some((h) => digits(h.amount)) || Number(p.posted) > 0));
  if (atAddress || atAave) return 'done';
  if (helperOn !== true) return undefined;
  return skipped ? 'skipped' : 'needed';
}

/** Units of a token the account holds, by the pool's symbol. */
export function held(account: AccountAnswer | undefined, symbol: string): bigint {
  const balance = account?.balances.find((b) => b.symbol === symbol)?.amount;
  return balance ? BigInt(balance) : 0n;
}

/**
 * `borrowed` (Phase 6): the account owes a lender. A loan that came from a lender alone leaves the account's own loan
 * record, which counts our pool's part, closed: the borrow step is done all the same.
 */
export function setupView(input: {
  signedIn: boolean;
  account: AccountAnswer | undefined;
  hl: HlAnswer | undefined;
  borrowed?: boolean;
  /** Stage 3: the testnet step before the borrow, for an account whose config has Aave. Left out, there is no such step. */
  testCollateral?: TestCollateralStep;
}): SetupView {
  const { signedIn, account, hl } = input;
  const state = account?.state ?? null;
  const hedge = state ? hedgePart(hl) : 'address';
  const done: Record<SetupKey, boolean> = {
    wallet: signedIn,
    account: state !== null,
    collateral: held(account, 'nBTC') > 0n,
    hedge: hedge === 'done',
    // A loan that is already open doesn't wait for test collateral.
    aave: input.testCollateral !== 'needed' || (state !== null && (loanOpen(state.loan) || Boolean(input.borrowed))),
    borrow: state !== null && (loanOpen(state.loan) || Boolean(input.borrowed)),
  };
  const keys: SetupKey[] = input.testCollateral ? ['wallet', 'account', 'collateral', 'hedge', 'aave', 'borrow'] : ['wallet', 'account', 'collateral', 'hedge', 'borrow'];
  const steps = keys.map((key): SetupStepView => ({ key, title: TITLES[key], done: done[key], ...(key === 'aave' && input.testCollateral === 'skipped' && { skipped: true }) }));
  const count = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done)?.key ?? null;
  return { steps, done: count, next, hedge, complete: next === null };
}
