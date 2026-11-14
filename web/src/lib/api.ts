// The backend's endpoints (INTERFACES.md 7 and 11; services/api). The browser calls /api/... on its own origin,
// and Next proxies it to the backend (next.config.js), so no key ever reaches the page.
import type { CheckAnswer } from './broker-check.ts';
import type { Auth, GatewayAnswer } from './gateway.ts';
import type { SubmitAnswer } from './hl.ts';
import { currentToken, dropCurrentSession } from './session.ts';
import type { AccountState, BorrowerView, FundingState, Intent, LenderName, ParamsView, Permission, PoolView, Refusal, Tier, Verdict } from './types.ts';

export type { LenderName, Permission } from './types.ts';

export interface ConfigAnswer {
  network: string;
  ids: {
    factory: string;
    pool: string;
    operator: string;
    keeper: string;
    tokens: { id: string; symbol: string; decimals: number }[];
    drill: string;
    mpc: string;
    outlayer: string;
    risk_project: string;
    shim_float: string | null;
    /** Phase 3. */
    gateway_project?: string;
    hl_float?: string;
    hl_usdc_token?: string;
    hl_usdc_asset?: string;
  };
  /** Which of our contracts have code on chain now. */
  deployed: Record<string, boolean>;
  factory_config: Record<string, unknown> | null;
  preview_enabled: boolean;
  /** Orders run pb-gateway with the backend's OutLayer payment key. */
  gateway_enabled?: boolean;
  hl_api?: string;
  /** Phase 5: credit checks run pb-risk with the same key. */
  credit_check_enabled?: boolean;
  /**
   * INTERFACES.md 48.5: privacy level 1. `owner`: the backend shows an account only to its owner and to us, and the
   * app signs each wallet in. `open_accounts` are the accounts anyone may look at. A backend from before this sends
   * no `privacy`, which the app treats as `off`.
   */
  privacy?: { mode: 'owner' | 'off'; open_accounts?: string[]; session_recipient?: string; session_ms?: number } | null;
}

/** GET /api/markets: one coin of universe_v0.json, with testnet's listing and the pool's status. */
export interface MarketCoin {
  coin: string;
  allowed: boolean;
  tier: number;
  /** The P2 band either side of the reference price, as the gateway asked about enforces it (INTERFACES.md 42). */
  band_bp: number;
  universe_sz_decimals: number;
  client_cap_usd: number;
  testnet: {
    asset: number;
    sz_decimals: number;
    max_leverage: number;
    delisted: boolean;
    mark_px: string | null;
    oracle_px: string | null;
    mid_px: string | null;
    day_ntl_vlm: string | null;
    /** The current hourly funding rate: positive means longs pay shorts. */
    funding?: string | null;
  } | null;
  status: { status: 'allowed' | 'reduce_only' | 'removed' | 'frozen' | string; since: string; emergency: boolean } | null;
}

export interface MarketsAnswer {
  network: string;
  hl_api: string;
  hl_error: string | null;
  params_hash: string;
  params_hash_pinned: string | null;
  params_hash_matches: boolean | null;
  pool_statuses: 'read' | 'not_deployed';
  /**
   * INTERFACES.md 42: whose gateway the bands are for (the account asked about, or the factory's for a new one),
   * which gateway that is, and the least band it uses: 300 on testnet for a gateway built since the rule, else 0.
   * A backend from before the rule sends none of the three.
   */
  band_from?: 'account' | 'factory' | null;
  gateway_version?: string | null;
  /**
   * INTERFACES.md 50.4: how long the page signs an order or a cancel for on that gateway, in milliseconds: 230,000 on
   * testnet's new gateway, 110,000 on an older one. A backend from before the rule doesn't send it, and the page then
   * signs for 110 s (lib/gateway.ts, `orderLifeMs`).
   */
  order_life_ms?: number;
  band_floor_bp?: number;
  coins: MarketCoin[];
}

/** The moves a client starts through 1Click: USDC to and from Hyperliquid, and (stage 4) to and from Aave's chain. */
export type MoveName = 'to_hl' | 'home' | 'to_evm' | 'e_home';

/**
 * POST /api/quote with a move: the quote, and the account's next call once there is a deposit address.
 * Stage 4 (INTERFACES.md 36) adds the moves `to_evm` and `e_home`, the next call `evm_withdraw` with the quote's
 * expiry, what arrives and where (`delivers`), and the check to ask for first while the account owes our pool
 * (`needs_check`).
 */
export interface MoveQuoteAnswer extends QuoteAnswer {
  /**
   * Testnet's stand-in for 1Click adds this when it delivers another asset than the one asked for: wrapped test ETH
   * for bitcoin, while Aave's test pool for WBTC is full (services/oneclick-client/src/types.ts, ShimNote). `why` is
   * its reason in words.
   */
  shim?: { asked?: string; delivers?: string; symbol?: string; why?: string } | null;
  move: {
    kind: MoveName;
    account: string;
    hl_address?: string;
    next:
      | { method: 'withdraw'; args: { token: string; amount: string; receiver: string; transfer?: { kind: 'to_hl' | 'to_evm'; exp: number } } }
      // INTERFACES.md 47.3: a move home's call also carries `expect`, what the quote says will arrive on NEAR.
      | { method: 'hl_withdraw'; args: { amount: string; destination: string; exp?: number; expect?: { token: string; amount: string } } }
      | { method: 'evm_withdraw'; args: { token: string; amount: string; to: string; exp?: number; expect?: { token: string; amount: string } } }
      | null;
    /** Phase 4: the pending transfer the account will record, `move:<n>`, or null when it records none. */
    transfer_id?: string | null;
    exp_ms?: number | null;
    /** Stage 4: the token that arrives, its name, the chain it arrives on, and how much, in that token's own units. */
    delivers?: { token: string; symbol: string; chain: string; amount: string } | null;
    /** Stage 4: the intent to ask a check for before the next call, while the account owes our pool; else null. */
    needs_check?: Intent | null;
  };
}

export type PoolAnswer =
  | { pool_id: string; deployed: false; reason: string }
  | { pool_id: string; deployed: true; block_height: number; pool: PoolView; params: ParamsView };

export interface AccountAnswer {
  account_id: string;
  /** The newest final block among the reads. */
  block_height: number;
  exists: boolean;
  has_contract: boolean;
  state: AccountState | null;
  balances: { token: string; symbol: string; decimals: number; amount: string | null }[];
  /** pool.debt_of, with interest; null until the pool is live. */
  debt: string | null;
  borrower: BorrowerView | null;
  /** Our contracts this read needed that aren't live yet. */
  not_deployed: string[];
}

export interface PreviewAnswer {
  account: string;
  intent: Intent;
  verdict: Verdict | Refusal;
  run: { call_id: string | null; compute_cost: string | null; time_ms: number | null; attestation_url: string | null };
  program: { project_id: string; version_key: string | null };
}

export interface QuoteBody {
  dry: boolean;
  originAsset: string;
  destinationAsset: string;
  amount: string;
  recipient: string;
  refundTo: string;
  slippageTolerance?: number;
}

/** The parts of a 1Click quote the deposit page shows. */
export interface QuoteAnswer {
  correlationId: string;
  quote: {
    depositAddress?: string;
    depositMemo?: string | null;
    amountIn: string;
    amountInFormatted: string;
    amountOut: string;
    amountOutFormatted: string;
    minAmountOut: string;
    /** 1Click's dollar figures for what leaves and what arrives: the difference is what the move costs. */
    amountInUsd?: string;
    amountOutUsd?: string;
    deadline?: string;
    timeEstimate: number;
  };
}

export type SwapStatus = 'PENDING_DEPOSIT' | 'KNOWN_DEPOSIT_TX' | 'PROCESSING' | 'SUCCESS' | 'INCOMPLETE_DEPOSIT' | 'REFUNDED' | 'FAILED';

export interface StatusAnswer {
  status: SwapStatus;
  updatedAt: string;
  swapDetails?: { refundReason?: string; destinationChainTxHashes?: { hash: string; explorerUrl: string }[] };
}

/** An error the backend answered (or the proxy, when the backend isn't running). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(path: string, init?: RequestInit, fetchImpl: typeof fetch = fetch): Promise<T> {
  let response: Response;
  // INTERFACES.md 48.3: every call carries the wallet's sign-in token, when there is one.
  const token = currentToken();
  try {
    response = await fetchImpl(path, { ...init, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...init?.headers } });
  } catch {
    throw new ApiError(0, 'offline', 'The page could not reach its server.');
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (response.ok && body !== undefined) return body as T;
  const fields = (body ?? {}) as { error?: string; message?: string };
  // INTERFACES.md 48.6: the backend says the token is no good (it restarted, or the token ran out): drop it, and the
  // pages show the sign-in card again.
  if (response.status === 401 && fields.error === 'sign_in') dropCurrentSession();
  if (!fields.error && response.status >= 500) {
    // Next's proxy answers this way when nothing listens on API_URL.
    throw new ApiError(response.status, 'backend_down', 'The backend is not running: start it with pnpm --filter @pb/api start');
  }
  throw new ApiError(response.status, fields.error ?? 'http_error', fields.message ?? `The backend answered HTTP ${response.status}`);
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/** The paths pages read with useApi. */
export const CONFIG_PATH = '/api/config';
/** INTERFACES.md 48.5: the signed-in wallet's own client accounts, newest first. A wallet's token is needed. */
export const ACCOUNTS_MINE_PATH = '/api/accounts/mine';
export interface MineAnswer {
  wallet: string;
  accounts: { account_id: string; created_at?: string | number | null }[];
  read_at_ms: number;
}
/** INTERFACES.md 48.2: what a sign-in answers. The token is good until `expires_at_ms`. */
export interface SessionAnswer {
  token: string;
  wallet: string;
  expires_at_ms: number;
}
/** POST /api/session: the wallet's signed sign-in message, in the shape orders use, with the session's recipient. */
export const postSession = (auth: Auth) => api<SessionAnswer>('/api/session', post({ auth }));
export const POOL_PATH = '/api/pool';
export const accountPath = (id: string) => `/api/account/${encodeURIComponent(id)}`;
export const statusPath = (depositAddress: string, depositMemo?: string | null) =>
  `/api/status?${new URLSearchParams(depositMemo ? { depositAddress, depositMemo } : { depositAddress })}`;

export const preview = (account: string, intent: Intent) => api<PreviewAnswer>('/api/preview', post({ account, intent }));
/**
 * INTERFACES.md 49.3 and 49.4: the broker pays for the check. The keeper sends `request_check` with its own NEAR and
 * asks again when OutLayer returns nothing; the answer comes once a result is accepted, or with the reason it wasn't.
 * The account's owner only. lib/broker-check.ts says what the page does with each answer.
 */
export const postCheck = (account: string, intent: Intent) => api<CheckAnswer>('/api/check', post({ account, intent }));

/**
 * INTERFACES.md 49.3 (services/api/src/portfolio.ts): one point per check result the keeper saw the account store,
 * oldest first, at most 500. `equity_micro` is what the engine counted the account as worth, in micro-USD, and can be
 * below zero; `debt_micro` is what it owed our pool then, null where the keeper's log line doesn't say.
 */
export interface PortfolioAnswer {
  points: { t_ms: number; equity_micro: number | string; debt_micro: number | string | null }[];
  read_at_ms?: number;
  /** False when the backend found no keeper log to read: the chart then stays empty. */
  keeper_log?: boolean;
}
export const portfolioPath = (account: string) => `/api/portfolio/${encodeURIComponent(account)}`;
export const quote = (body: QuoteBody) => api<QuoteAnswer>('/api/quote', post(body));

// ---------- Phase 3 (INTERFACES.md 11) ----------

export const MARKETS_PATH = '/api/markets';
/**
 * The markets as one account's own gateway sees them (INTERFACES.md 42): with an account, each coin's `band_bp` is the
 * band that account's pinned gateway enforces. On testnet that is 3% at least for a gateway built since 12 Nov, and
 * the parameter file's band for an older one. A page with no account keeps the plain path, which answers with the
 * band a new account would get.
 */
export const marketsPath = (account?: string | null): string => (account ? `${MARKETS_PATH}?account=${encodeURIComponent(account)}` : MARKETS_PATH);
/** `fresh` re-reads the approved agents at once, after an approval. */
export const hlPath = (account: string, fresh = false) => `/api/hl/${encodeURIComponent(account)}${fresh ? '?fresh=1' : ''}`;

/**
 * Moving USDC between the account and its Hyperliquid address: `amount` is micro-USDC either way. Stage 4
 * (INTERFACES.md 36): `to_evm` and `e_home` also name the `token` that leaves, a NEAR token id for `to_evm` and a 0x
 * address on Aave's chain for `e_home`, with `amount` in that token's own units.
 */
/** INTERFACES.md 51.2: with `e_home` and a collateral token, `to` is the NEAR token it comes home as; left out, bitcoin, as before. */
export const quoteMove = (body: { dry: boolean; move: MoveName; account: string; amount: string; token?: string; to?: string }) => api<MoveQuoteAnswer>('/api/quote', post(body));
export const sendOrder = (account: string, auth: Auth) => api<GatewayAnswer>('/api/order', post({ account, auth }));
export const sendCancel = (account: string, auth: Auth) => api<GatewayAnswer>('/api/cancel', post({ account, auth }));
export const setLeverage = (account: string) => api<GatewayAnswer>('/api/set-leverage', post({ account }));
/** Posts hl.signed[index], which the backend reads from the chain itself, to Hyperliquid. */
export const submitSigned = (account: string, index: number) => api<SubmitAnswer>('/api/hl/submit', post({ account, index }));

// ---------- Phase 4 (INTERFACES.md 17) ----------

export type FaultMode = 'none' | 'refund' | 'fail' | 'late';

/** GET /api/drill: the drill's nBTC/BTC ratio and owner, and the stand-in's fault switch. */
export interface DrillAnswer {
  network: string;
  drill_id: string;
  deployed: boolean;
  block_height: number | null;
  /** bp: 10,000 is 1.0. set_at is a block time in ns. */
  ratio: { bp: number; set_at: string } | null;
  owner: string | null;
  faults_enabled: boolean;
  fault: { mode: FaultMode; delaySeconds: number } | null;
  fault_error: string | null;
  /**
   * Phase 5 (INTERFACES.md 21), with ?account=: the ratio pb-risk reads for that account. `per_account` says whether the
   * drill's code has per-account ratios yet; `shared` whether the account reads the shared one.
   */
  account_ratio?: { account: string; per_account: boolean; ratio: { bp: number; set_at: string } | null; shared: boolean } | null;
}

/** One line of the keeper's JSON-lines log (services/keeper/src/loop.ts). */
export interface KeeperEvent {
  t: string;
  event: string;
  msg?: string;
  account?: string;
  [field: string]: unknown;
}

/** GET /api/keeper/:account: the keeper's lines for the account, newest first, and whether the keeper is running. */
export interface KeeperAnswer {
  account: string;
  log_found: boolean;
  keeper: { last_tick_at: string | null; running: boolean; dry_run: boolean; watches: boolean; nbtc_ratio_bp: number | null };
  events: KeeperEvent[];
}

export const DRILL_PATH = '/api/drill';
/** The drill, with the ratio pb-risk reads for one account (its own, when the drill has per-account ratios). */
export const drillPathFor = (account: string) => `/api/drill?account=${encodeURIComponent(account)}`;
export const keeperPath = (account: string) => `/api/keeper/${encodeURIComponent(account)}`;
/** Sets the stand-in's fault switch (testnet). The backend holds the stand-in's admin token. */
export const setFault = (fault: FaultMode, delaySeconds?: number) =>
  api<{ fault: { mode: FaultMode; delaySeconds: number } }>('/api/drill/fault', post({ fault, ...(delaySeconds !== undefined && { delay_seconds: delaySeconds }) }));

// ---------- Phase 5 (INTERFACES.md 18, 19 and 22) ----------

/** The NEAR-side tokens a credit check takes (RISK_ENGINE.md 5.4), by the pool's names. */
export type SpotToken = 'USDC' | 'nBTC' | 'ETH' | 'USDT' | 'wNEAR';

export interface CreditBook {
  /** USDC margin on Hyperliquid, micro-USD. */
  usdc: string;
  /** Each position at the mark, micro-USD, negative for a short. */
  positions: { coin: string; usd: string }[];
}

export interface CreditRequest {
  hl_address?: string;
  book?: CreditBook;
  spot?: { token: SpotToken; amount: string }[];
}

/** pb-risk's credit_check output (INTERFACES.md 18). Amounts are integer micro-USD. */
export interface CreditResult {
  ok: true;
  v: number;
  mode: 'credit_check';
  model: string;
  params: string;
  network: string;
  hl_address: string | null;
  book: CreditBook | null;
  spot: { token: SpotToken; amount: string }[];
  at_ms: number;
  near_blk: number;
  verdict: {
    eq: number;
    eq_allow: number;
    mm: number;
    im: number;
    score: number;
    tier: Tier;
    rate_bp: number;
    rate_bp_at_60: number;
    credit: { line: number; binding: string };
    top: string[];
    topup: number;
    venues?: { hl_margin_ratio_bp?: number };
    coins?: { uncertain: string[]; stale: string[]; reduce_only: string[] };
    hr_bp?: number;
    hr7_bp?: number;
    exp_bp?: number;
    volf_bp?: number;
  };
  limits: { first_week: number; ceiling: number };
  unlisted: string[];
  unlisted_more?: number;
  without_unlisted: { line: number; binding: string; score: number; tier: Tier; rate_bp: number } | null;
  ignored: { what: string; why: string }[];
  /** Each coin's reference price, micro-USD. */
  prices: Record<string, number>;
  pi: Record<string, { bp: number; source: string }>;
  rhea: {
    contract: string;
    blk: number;
    max: number;
    safe: number;
    usdc_borrow_apr_bp: number;
    usdc_volatility_bp: number;
    tokens: { token: string; value: number; volatility_bp: number; collateral: boolean }[];
    error?: string;
  };
  pool: { id: string; util_bp: number };
  /** Phase 6 (INTERFACES.md 27): how the line would be funded. Missing from an older engine. */
  funding?: CreditFunding;
  in: string;
}

export interface CreditAnswer {
  input: { hl_address: string | null; book: CreditBook | null; spot: { token: SpotToken; amount: string }[] };
  result: CreditResult | Refusal;
  run: { call_id: string | null; attestation_url: string | null; time_ms: number | null; compute_cost: string | null };
  program: { project_id: string; version_key: string | null };
  /** SHA-256 of the result in sorted form: what the attestation calls output_hash. */
  output_sha256: string;
  attestation: {
    found: boolean;
    wasm_hash: string | null;
    output_hash: string | null;
    input_hash: string | null;
    timestamp: number | null;
    wasm_matches: boolean | null;
    output_matches: boolean | null;
    error: string | null;
  };
  computed_at_ms: number;
  cached: boolean;
  age_s: number;
}

export interface CreditExample {
  book: CreditBook;
  spot: { token: SpotToken; amount: string }[];
  btc_usd: string;
  price_source: string;
  read_at_ms: number;
}

/** GET /api/rhea: Rhea's terms on mainnet now. */
export interface RheaAnswer {
  contract: string;
  network: 'mainnet';
  view: string;
  rpc: string;
  block_height: number;
  read_at_ms: number;
  age_s: number;
  stale: boolean;
  usdc: { token_id: string; volatility_bp: number | null; borrow_apr_bp: number | null; supply_apr_bp: number | null };
  tokens: { token: SpotToken; token_id: string; listed: boolean; volatility_bp: number | null; collateral: boolean; can_borrow: boolean; borrow_apr_bp: number | null; supply_apr_bp: number | null; ltv_bp: number | null }[];
}

export type ActivityKind = 'create' | 'deposit' | 'borrow' | 'repay' | 'to_hl' | 'home' | 'arrived' | 'refund' | 'plan' | 'plan_step' | 'withdraw' | 'setup' | 'check' | 'kyb' | 'other';

export interface ActivityItem {
  at_ms: number;
  block: number | null;
  tx: string | null;
  ok: boolean;
  kind: ActivityKind;
  by: string;
  /** Tokens into (+) or out of (-) the account, in each token's units. */
  moves: { token: string; amount: string; other: string }[];
  detail: Record<string, unknown>;
  source: 'indexer' | 'keeper_log';
  attestation_url?: string | null;
}

/** GET /api/activity/:account. */
export interface ActivityAnswer {
  account: string;
  read_at_ms: number;
  indexer: { host: string; docs: string };
  total: number | null;
  listed: number;
  detailed: number;
  more: boolean;
  keeper_log: boolean;
  items: ActivityItem[];
  cached: boolean;
  stale?: boolean;
}

/** pb-risk's `book` output (INTERFACES.md 19). */
export interface BookStressResult {
  ok: true;
  v: number;
  mode: 'book';
  blk: number;
  capital: number;
  loans: number;
  accounts: { acct: string; debt: number; eq: number }[];
  worst: { scenario: string; pool_loss: number } | null;
  limit: number;
  pass: boolean;
  top: { scenario: string; pool_loss: number }[];
  in: string;
}

export interface BookStressLine {
  t: string;
  ok: boolean;
  result: BookStressResult | Refusal | null;
  error: string | null;
  call_id: string | null;
  attestation_url: string | null;
  time_ms: number | null;
  compute_cost: string | null;
  program: { project_id: string | null; version_key: string | null } | null;
}

/** GET /api/book-stress: the keeper's latest daily run. */
export interface BookStressAnswer {
  log_found: boolean;
  latest: BookStressLine | null;
  last_result: BookStressLine | null;
  history: { t: string; ok: boolean; pass: boolean | null; worst_loss: number | null; limit: number | null; attestation_url: string | null; error: string | null }[];
}

export const RHEA_PATH = '/api/rhea';
export const BOOK_STRESS_PATH = '/api/book-stress';
export const CREDIT_EXAMPLE_PATH = '/api/credit-check/example';
export const activityPath = (account: string) => `/api/activity/${encodeURIComponent(account)}`;
/** A credit check: a paid pb-risk run, unless the same one ran in the last minute. */
export const creditCheck = (body: CreditRequest) => api<CreditAnswer>('/api/credit-check', post(body));

// ---------- Phase 6 (INTERFACES.md 24, 27 and 28): funding from lenders ----------

/** Where part of a loan comes from: a lender, or our own pool. */
export type FundingSource = LenderName | 'pool';
/** A micro-USD amount as the backend sends it: a JSON integer from a verdict, or a string of digits. Readers take either. */
export type Micro = number | string;

/** One lender in a credit check's `funding`: what it would lend against the bitcoin, and what the whole loan costs. */
export interface CreditFundingLender {
  l: LenderName;
  chain: string;
  collateral: string;
  rate_bp: number;
  supply_bp: number;
  liq_bp: number;
  ltv_bp: number;
  penalty_bp: number;
  free: Micro;
  /** What the lender would lend at the target cushion, cut to the line; `pool` is the rest. */
  lends: Micro;
  pool: Micro;
  /** How far bitcoin can fall before the lender sells. */
  fall_bp: number;
  /** The whole loan's cost a year, with the pool's rate at 60% lent. */
  blended_bp: number;
  /** The cost of getting the bitcoin to the lender's chain, and the interest saved over `loan_days`. Null for Rhea, and when no quote came. */
  /**
   * Stage 3: the trip is counted there and back. `back` and `back_bp` are the way back, `total` both ways, and
   * `back_quoted` is false when no quote came for the way back and it was counted as the way there. An engine from
   * before stage 3 sends the way there alone.
   */
  move: { cost_bp: number; cost: Micro; back_bp?: number; back?: Micro; back_quoted?: boolean; total?: Micro; saves: Micro; source: string } | null;
  used: boolean;
  why: string;
}

/** INTERFACES.md 27: how a credit check's line would be funded. */
export interface CreditFunding {
  line: Micro;
  pool_rate_bp: number;
  target_hf_bp: number;
  loan_days: number;
  lenders: CreditFundingLender[];
  choice: FundingSource;
}

/** GET /api/lenders: each lender's terms now. `free` is a micro-USD string. */
export interface LenderTerms {
  l: LenderName;
  network: string;
  chain: string;
  collateral: string;
  rate_bp: number;
  supply_bp: number;
  free: string;
  ltv_bp: number;
  liq_bp: number;
  penalty_bp: number;
  source: string;
  stale: boolean;
  /** When this lender's terms were read, which a stale row needs. */
  read_at_ms?: number;
  /**
   * Stage 3, on Aave's testnet row: what Aave's pool can still take of each collateral token, in the token's own units,
   * or null when the token has no cap. Aave's test pool for WBTC is capped and can be full; WETH then stands in.
   */
  collateral_room?: { token: string; symbol: string; decimals: number; room: string | null }[];
}

export interface LendersAnswer {
  read_at_ms: number;
  lenders: LenderTerms[];
}

export type CushionStatus = 'none' | 'safe' | 'thin' | 'act';

/** One lender as an account stands there: what is posted, what is owed, and the cushion (`hf_bp`: 15000 is 1.5). */
export interface LenderPosition {
  l: LenderName;
  posted: Micro;
  debt: Micro;
  hf_bp: number;
  liq_bp: number;
  /** Null when the lender's rate wasn't read. */
  rate_bp: number | null;
  supply_bp: number | null;
  room: Micro;
  status: CushionStatus;
  /**
   * Stage 2: the collateral posted there, in each token's own units, from the lender's own record. It is the most the
   * client can take back. Empty for Aave until stage 3, and when the lender couldn't be read.
   */
  held?: { token: string; symbol: string; decimals: number; amount: string }[];
  /**
   * Stage 2, on Rhea's entry: USDC lying there as the account's plain deposit, a micro-USD string, "0" when none. A
   * repayment above the debt leaves the rest there, and `lender_withdraw` of the USDC token brings it back.
   */
  deposit?: string;
  /**
   * INTERFACES.md 51.13: `debt`, `hf_bp`, `room` and `status` go by what the lender itself reports now, not by the
   * held verdict. On Rhea's entry when its own record could be read; never on Aave's yet.
   */
  debt_live?: boolean;
}

/**
 * What a client pays on the lender's part of a loan (INTERFACES.md 26; contracts/pool/src/pricing.rs): each source at
 * its own rate, the lender's rate plus a margin with an optional cap, or one rate on the whole loan. Rates are bp a year.
 */
export type Pricing = 'pass_through' | { lender: { margin_bp: number; cap_bp: number | null } } | { fixed: { rate_bp: number } };

/** What `set_pricing` sets a policy for. */
export type PricingTarget = { account: string } | { tier: Tier };

/** The order the engine fills a loan's sources in. */
export type FundingOrder = 'cheapest' | 'pool_first' | 'lender_first';

/** The pool's `get_params().funding`: the source order, and how long a loan is expected to last. */
export interface FundingSettings {
  order: FundingOrder;
  loan_days: number;
}

/** One lender's line in a settlement report: the debt there (micro-USD) and the lender's rates. */
export interface LenderReport {
  lender: string;
  debt: string;
  rate_bp: number;
  supply_bp: number;
}

/** The pool's `get_pricing(account_id)`: the policy that applies, where it came from, and the account's totals. */
export interface PricingView {
  pricing: Pricing;
  from: 'account' | 'tier' | 'default';
  fees_charged: string;
  /** INTERFACES.md 45.1: fees the operator took back with `reverse_fee`. Missing on a pool from before it. */
  fees_reversed?: string;
  subsidy_paid: string;
  /** What the pool owes the account: subsidies past a debt of zero. `claim_credit` pays it. */
  credit: string;
  settled_at: string;
  last: LenderReport[];
}

/** The pool's `get_params().pricing_limits`: what a wrong report can cost at most. */
export interface PricingLimits {
  max_rate_bp: number;
  avg_plus_bp: number;
  max_period_ns: number | string;
  /** Two settlements of one account are at least this far apart: 10 minutes. */
  min_period_ns?: number | string;
  account_subsidy_day: string;
  pool_subsidy_day_bp: number;
  /**
   * INTERFACES.md 45.1 (the second audit's P3): what a settlement's fee can be at most. A pool, or a backend, from
   * before the fix carries none of the three, so each is optional.
   * - `max_lender_debt` (micro-USD, $1,000,000 by default): a lender's reported debt counts at no more than this in a
   *   settlement, for a fee and for a subsidy.
   * - `account_fee_day` (micro-USD, $1,000 by default): the most fee one account is charged in 24 hours.
   * - `pool_fee_day_bp` (50 by default): the most fee the whole pool books in 24 hours, as a share of its capital.
   */
  max_lender_debt?: string;
  account_fee_day?: string;
  pool_fee_day_bp?: number;
}

/** GET /api/pricing (stage 2): the pool's pricing for the Book page. Money is micro-USD in strings. */
export interface PricingAnswer {
  read_at_ms: number;
  /** `funding`, `limits` and `pool` are null on a pool from before stage 2, and the lists are then empty. */
  funding: FundingSettings | null;
  limits: PricingLimits | null;
  pool: { fees_charged: string; subsidy_paid: string; subsidy_left_24h: string; fees_reversed?: string } | null;
  /** Only the tiers that have a policy of their own. */
  tiers: { tier: Tier; pricing: Pricing }[];
  accounts: PricingAccount[];
  /** INTERFACES.md 48.5: true when the per-account list is kept from this viewer: `accounts` is then empty. */
  accounts_hidden?: boolean;
}

/**
 * One account in GET /api/pricing: the pool's `get_pricing` for it, and `lender_debt`, what it owes each lender by its
 * held verdict. `last` is the pool's own record, which stays at 0 for a fresh loan until its next settlement.
 */
export interface PricingAccount extends PricingView {
  account: string;
  lender_debt: { lender: string; debt: string }[];
}

/** GET /api/lender/:account: the account at each lender, from get_state() and the held verdict. */
export interface LenderAccountAnswer {
  account: string;
  read_at_ms: number;
  /** The lenders the account's own config has settings for. Missing from an older backend. */
  config_lenders?: LenderName[];
  permission: Permission | null;
  /** The funding plan `fund` stored, with each step's `done`, or null. */
  funding: FundingState | null;
  verdict_blk: number | null;
  lenders: LenderPosition[];
  /** The pool's `get_pricing` answer, or null until the pool has it. */
  pricing: PricingView | null;
  /** Stage 3: the account's address on Aave's chain, what sits there, and the transactions it signed. Missing before it. */
  evm?: EvmAnswer | null;
}

/**
 * Where a signed Ethereum transaction stands: signed by the account, sent to the chain, mined, mined and reverted
 * (`failed`), or `replaced`: the chain used its nonce for another transaction, so this one can never go through.
 */
export type EvmStatus = 'signed' | 'sent' | 'mined' | 'failed' | 'replaced';

/** One entry of `evm.signed` in GET /api/lender/:account. `step` is "<pid>:<i>" for a plan step's; a backend from before it leaves it out, and the page joins it from get_state(). */
export interface EvmSigned {
  nonce: number;
  kind: string;
  token?: string | null;
  amount?: string | null;
  hash: string;
  status: EvmStatus | string;
  step?: string | null;
}

/** A token at the account's address: its 0x address, name, decimals and amount in its own units. */
export interface EvmToken {
  token: string;
  symbol: string;
  decimals: number;
  amount: string;
  /** Not answered today: whether Aave's pool may take this token from the address (its one-time approval is mined). */
  approved?: boolean;
}

/**
 * INTERFACES.md 33: `evm` in GET /api/lender/:account (services/api/src/evm-handlers.ts, `EvmView`). `eth` is the
 * address's gas in wei. When Aave's chain couldn't be read, `chain_error` says why: `chain_nonce` and `eth` are then
 * null, `wallet` is empty and every transaction shows as `signed`.
 */
export interface EvmAnswer {
  address: string | null;
  nonce: number | null;
  chain_nonce: number | null;
  eth: string | number | null;
  wallet: EvmToken[];
  signed: EvmSigned[];
  /** What Aave's own books say the address has posted, token by token: the same list as Aave's `held`. */
  posted?: EvmToken[];
  chain_error?: string | null;
}

/**
 * GET /api/evm/gas (reads only; services/api/src/evm-handlers.ts, `getEvmGas`): whether testnet's gas helper is on.
 * The page shows "Get test collateral for Aave" and "Get test gas" only when it is.
 */
export interface EvmGasInfo {
  on: boolean;
  chain_id?: number;
  gas_wallet?: string | null;
  balance?: string | null;
}

/** One thing POST /api/evm/gas sent: `mined` says whether it was mined within the route's 20 seconds, `ok` whether it went through. */
interface EvmGasSent {
  hash: string | null;
  mined?: boolean;
  ok?: boolean;
}

/**
 * POST /api/evm/gas (testnet; services/api/src/evm-handlers.ts, `postEvmGas`): the gas wallet's top-up of the address,
 * Aave's faucet mint when one was asked for, and the wrapped test ETH when that was. `wrap.hash` is the transfer of
 * the WETH to the address.
 */
export interface EvmGasAnswer {
  address: string;
  eth: EvmGasSent & { balance: string | number | null; sent: string | number | null };
  mint: (EvmGasSent & { hash: string; amount: string; token?: string; symbol?: string }) | null;
  wrap?: (EvmGasSent & { hash: string; amount: string; token?: string; symbol?: string; deposit_hash?: string }) | null;
  gas_wallet?: string;
}

/**
 * POST /api/evm/submit: the signed transaction's hash, and whether it was `sent`, already `known`, or `mined`. A mined
 * one says whether it failed there (`reverted`).
 */
export interface EvmSubmitAnswer {
  hash: string;
  status: 'sent' | 'known' | 'mined' | string;
  block?: number | null;
  reverted?: boolean;
}

/**
 * POST /api/funding-plan: a preview of where a loan of `asked` would come from. `asked` is a string, `total` and each
 * amount a JSON number; the readers take either. A refusal comes with HTTP 200, `total` 0 and no sources.
 */
export interface FundingPlanAnswer {
  asked?: Micro;
  total?: Micro;
  /** A source's rate is null when the engine's answer didn't carry it. */
  sources?: { source: FundingSource; amount: Micro; rate_bp: number | null }[];
  steps?: unknown[];
  ext?: unknown[];
  blended_bp?: number | null;
  verdict?: { ok: boolean; reason?: string } | null;
  run?: unknown;
}

/** Sends the account's signed Ethereum transaction of that nonce to Aave's chain. The backend reads it from the chain itself. */
export const evmSubmit = (account: string, nonce: number) => api<EvmSubmitAnswer>('/api/evm/submit', post({ account, nonce }));
/**
 * Testnet: tops the address's gas up. With `mint`, Aave's faucet also hands it a test token (units of the token's own
 * decimals); with `wrap`, the gas wallet wraps that much of its own test ETH (wei) and sends the WETH to the address.
 */
export const evmGas = (account: string, ask?: { mint: { token: string; amount: string } } | { wrap: { amount: string } }) => api<EvmGasAnswer>('/api/evm/gas', post({ account, ...ask }));

export const LENDERS_PATH = '/api/lenders';
export const EVM_GAS_PATH = '/api/evm/gas';
export const PRICING_PATH = '/api/pricing';
export const lenderPath = (account: string) => `/api/lender/${encodeURIComponent(account)}`;
/** Where a loan of `amount` (micro-USDC) would come from: a pb-risk preview with the `fund` intent. Nothing is sent. */
export const fundingPlan = (account: string, amount: string) => api<FundingPlanAnswer>('/api/funding-plan', post({ account, amount }));
