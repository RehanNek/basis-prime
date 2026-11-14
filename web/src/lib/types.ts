// The shapes the web app reads, as INTERFACES.md fixes them: the account's get_state (4), the verdict
// (RISK_ENGINE.md Appendix A), and the pool's views (as built in contracts/pool/src/types.rs).
// Token amounts are U128 strings in the token's units; USD amounts in verdicts are JSON integers in micro-USD.

/** INTERFACES.md 6: what a check is asked to answer. */
export type Intent =
  | { check: Record<string, never> }
  | { borrow: { amount: string } }
  | { withdraw: { token: string; amount: string } }
  /** Phase 6 (INTERFACES.md 25): one loan of this much in all (micro-USD). The engine picks the sources. */
  | { fund: { amount: string } }
  /** Phase 6: taking collateral back from a lender. `token` is a NEAR token id, or for Aave a 0x address; `amount` its own units. */
  | { lender_withdraw: { lender: string; token: string; amount: string } }
  /** Stage 3 (INTERFACES.md 33): sending a token out of the account's address on Aave's chain. `token` is its 0x address. */
  | { evm_withdraw: { token: string; amount: string } };

/** An outside lender, always listed in this order: Aave first, then Rhea (INTERFACES.md 24). */
export type LenderName = 'aave' | 'rhea';

/** The funding permission an account's owner signs (INTERFACES.md 24; FUNDING.md 4.2). Null means none. */
export interface Permission {
  lenders: LenderName[];
  /** The smallest cushion a new lender loan may leave, in bp of a health factor: 15000 is 1.5. */
  min_hf_bp: number;
  /** The dearest lender rate the engine may still borrow at, in bp a year: 2500 is 25%. */
  max_rate_bp: number;
  /** May the engine move a running loan between sources? It doesn't yet (FUNDING.md 16). */
  moves: 'off' | 'lower_cost_only' | 'any';
}

/** One step of a funding plan (INTERFACES.md 25). `amt` is micro-USD for a loan, the token's own units for collateral. */
export interface FundingStep {
  k: string;
  l?: string;
  tok?: string;
  amt?: number | string;
  /** Started, as in the unwind plan. */
  done?: boolean;
  [field: string]: unknown;
}

/** get_state().funding: the plan `fund(amount)` stored. Times are block times in ns; the plan lasts 30 minutes. */
export interface FundingState {
  pid: string;
  amount: string;
  stored_at: string;
  expires_at: string;
  steps: FundingStep[];
}

export type RiskState = 'HEALTHY' | 'WATCH' | 'MARGIN_CALL' | 'DELEVERAGE' | 'DEFAULT';
export type RiskAction = 'NONE' | 'REBALANCE' | 'REBALANCE_NOW' | 'DELEVERAGE';
export type Tier = 'PREFERRED' | 'STANDARD' | 'WATCH';

/** RISK_ENGINE.md Appendix A. */
export interface Verdict {
  ok: true;
  v: number;
  model: string;
  params: string;
  acct: string;
  /** The block height pb-risk read: a verdict is fresh for 120 blocks from here. */
  blk: number;
  /** The account's counter when it was read. One verdict backs one action. */
  nonce: number;
  eq: number;
  eq_allow: number;
  mm: number;
  im: number;
  state: RiskState;
  action: RiskAction;
  since: number;
  score: number;
  tier: Tier;
  rate_bp: number;
  /** `fund` (Phase 6): what the verdict's funding steps borrow in all, for a `fund` intent. */
  allow: { withdraw: number; borrow: number; fund?: number };
  credit: { line: number; binding: string };
  volf_bp: number;
  top: string[];
  topup: number;
  venues?: { hl_margin_ratio_bp?: number };
  pool?: { shares_bp?: Record<string, number>; hold?: Record<string, number>; hl_eq?: number };
  hr_bp?: number;
  hr7_bp?: number;
  exp_bp?: number;
  bands?: Record<string, Record<string, number>>;
  coins?: { uncertain: string[]; stale: string[]; reduce_only: string[] };
  plan?: unknown[];
  /** Phase 6 (INTERFACES.md 25): the funding steps for a `fund` intent, at most 6, and each lender position. */
  fund?: FundingStep[];
  ext?: unknown[];
  in?: string;
}

/** pb-risk's answer when it can't produce a verdict (INTERFACES.md 6, "Errors"). */
export interface Refusal {
  ok: false;
  reason: string;
}

/** The verdict as the account stores it (INTERFACES.md 4, get_state). */
export interface StoredVerdict {
  intent: Intent;
  received_block: number;
  verdict: Verdict;
}

/** INTERFACES.md 4: the account's get_state. */
export interface AccountState {
  owner: string;
  counter: number;
  /**
   * INTERFACES.md 40.1: the block height of the last change to the lender permission, or of the account's creation
   * when a permission came with it; 0 if none was ever set. Missing on an account made before the audit fix. `fund`
   * needs a check read after it.
   */
  permission_blk?: number;
  blocked: boolean;
  /** `open` stays true until a repayment comes back partly unused (INTERFACES.md 4, as built). */
  loan: { principal: string; open?: boolean };
  verdict: StoredVerdict | null;
  margin_call?: { since: string; below?: boolean; intervals: [string, string][] };
  deleverage?: { first_at: string; confirmed_plan?: unknown };
  hourly?: { hour: number; hr_bp_min: number; exp_bp_max: number }[];
  /** Borrows under way, and (Phase 4) pending 1Click transfers: {"transfer": {id, kind, token, amount, dep, deadline}}. */
  pending?: unknown[];
  hl?: HlState;
  /** Phase 4 (INTERFACES.md 14): the stored plan, with each step's `done`. */
  plan?: unknown;
  /** Phase 4: the n of the id `move:<n>` the account's next move gets. */
  next_move?: number | string;
  /** Phase 6 (INTERFACES.md 25): the owner's funding permission, or null. Missing on accounts made before it. */
  permission?: Permission | null;
  /** Phase 6: the funding plan `fund` stored, or null. */
  funding?: FundingState | null;
  /**
   * Stage 3 (INTERFACES.md 33): the account's own Ethereum nonce and the transactions it had signed, the newest 20,
   * oldest first. `step` is "<pid>:<i>" for one a plan step signed, else null. `approved` lists the tokens (0x
   * addresses) whose approval for Aave's Pool the account has signed; an older account contract leaves it out.
   */
  evm?: { nonce: number; signed: EvmSignedEntry[]; approved?: string[] } | null;
}

/** One Ethereum transaction the account had the MPC signer sign. The backend sends `raw` to the chain. */
export interface EvmSignedEntry {
  nonce: number;
  /** `approve`, `supply`, `borrow`, `repay`, `withdraw` or `transfer`. */
  kind: string;
  token?: string | null;
  amount?: string | null;
  to?: string | null;
  raw?: string;
  hash: string;
  step?: string | null;
  signed_at?: string;
}

/** One action the account had the MPC signer sign (INTERFACES.md 8). The backend posts it to Hyperliquid. */
export interface HlSignedEntry {
  index: number;
  kind: 'approveAgent' | 'sendAsset' | string;
  /** Compact JSON of the action as it is posted. */
  action: string;
  nonce: number;
  signature: { r: string; s: string; v: number };
  signed_block: number;
}

/** INTERFACES.md 8: get_state().hl. The Phase 3 fields are missing on accounts made before it. */
export interface HlState {
  path: string;
  address: string | null;
  agent?: { address: string; received_block: number } | null;
  next_nonce_ms?: string;
  signed?: HlSignedEntry[];
  /** Until then (ms), a signed sendAsset can still be posted, so borrow is refused. "0" before the first. */
  send_open_until_ms?: string;
  /**
   * INTERFACES.md 50.2, on accounts made after the fix: the nonces (unix ms) of the transfers out the account signed
   * that no accepted check has named as sent, oldest first, at most 8. An account made before doesn't show the field.
   */
  open_sends?: string[];
  /** INTERFACES.md 50.2: the pause's floor once a ninth transfer pushed the oldest off the list; "0" when unused. */
  send_floor_until_ms?: string;
}

export interface PerTier<T> {
  preferred: T;
  standard: T;
  watch: T;
}

export interface Exposure {
  amount: string;
  cap: string;
}

/** The pool's get_pool. Amounts are micro-USDC strings. */
export interface PoolView {
  cash: string;
  loans: string;
  capital: string;
  utilisation_bp: number;
  rate_bp: PerTier<number>;
  interest_earned: string;
  written_off: string;
  funded: string;
  defunded: string;
  paused: boolean;
  /** Loans made minus repayments over the last 24 hours; can be negative. */
  lent_24h: string;
  daily_budget: string;
  daily_budget_bp: number;
  pending_budget: { bp: number; from: string } | null;
  wrappers: Record<string, Exposure>;
  hyperliquid: Exposure;
  book: Record<string, Exposure>;
}

/** The pool's get_params. */
export interface ParamsView {
  operator: string;
  factory: string;
  token: string;
  periods: { new_account_ns: string; upgrade_ns: string; budget_delay_ns: string; window_ns: string };
  rates: { kink_bp: number; at_kink_bp: number; at_full_bp: number; spread_bp: PerTier<number> };
  caps: {
    max_utilisation_bp: number;
    client_share_bp: number;
    new_account_limit: string;
    ceiling: PerTier<string>;
    cosign_borrow_above: string;
    cosign_steps_above: string;
    wrapper_cap_bp: Record<string, number>;
    hl_cap_bp: number;
    book_cap: Record<string, string>;
  };
  daily_budget_bp: number;
  pending_budget: { bp: number; from: string } | null;
  /** Phase 6, stage 2: the source order and the loan life the engine plans with. Missing from a pool before it. */
  funding?: { order: string; loan_days: number };
}

/** The pool's get_borrower: one account as the pool sees it. */
export interface BorrowerView {
  created_at: string;
  first_week_until: string;
  debt: string;
  tier: Tier;
  history_tier: Tier | null;
  last_upgrade_at: string | null;
  kyb_entity: string | null;
  tier_override: { tier: Tier; reason: string; expires_at: string } | null;
  blocked: boolean;
  hl_address: string | null;
  steps_24h: string;
  shares_bp: Record<string, number>;
  hold: Record<string, string>;
  hl_eq: string;
}

/** A token the accounts hold. */
export interface Token {
  id: string;
  /** The pool's name for it (INTERFACES.md 2): USDC, nBTC. */
  symbol: string;
  /** What the wallet shows on testnet: mUSDC, mNBTC. */
  label: string;
  decimals: number;
}
