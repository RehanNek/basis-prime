// Shapes from the spec, for the helpers' tests: RISK_ENGINE.md Appendix A's verdict, INTERFACES.md 4's
// get_state, and the pool's views with the defaults of contracts/pool/src/types.rs.
import type { AccountState, BorrowerView, ParamsView, PoolView, Verdict } from './types.ts';

/** RISK_ENGINE.md Appendix A, field for field. */
export const APPENDIX_A: Verdict = {
  ok: true,
  v: 1,
  model: 'B-0.2',
  params: '<sha256 of universe_v0.json>',
  acct: 'acme.pbf.testnet',
  blk: 123456789,
  nonce: 42,
  eq: 40500000000,
  eq_allow: 40500000000,
  mm: 15616000000,
  im: 19520000000,
  state: 'HEALTHY',
  action: 'NONE',
  since: 0,
  score: 700,
  tier: 'STANDARD',
  rate_bp: 650,
  allow: { withdraw: 0, borrow: 0 },
  credit: { line: 94500000000, binding: 'C4' },
  volf_bp: 10000,
  top: ['replay 13 Mar 2020 rebound', 'ADL BTC 2/3S then 2/3S', 'nBTC depeg 20%'],
  topup: 11251000000,
  venues: { hl_margin_ratio_bp: 357 },
  pool: { shares_bp: { nBTC: 7407 }, hold: { nBTC: 100000000000 }, hl_eq: 35000000000 },
  hr_bp: 10000,
  hr7_bp: 10000,
  exp_bp: 49383,
  bands: { BTC: { hl50: 103110, hl100: 104383, im: 104195, mr: 104213 }, nBTC: { im_bp: 8309, mr_bp: 7914, dl_bp: 7574 } },
  coins: { uncertain: [], stale: [], reduce_only: [] },
  plan: [],
  in: '<sha256 of every input read>',
};

/** The quarter-size demo's borrow verdict (PLAN.md 2): a $24,150 Standard line, nothing drawn yet. */
export const DEMO_BORROW: Verdict = {
  ...APPENDIX_A,
  acct: 'alice.pbf.testnet',
  nonce: 3,
  blk: 1000,
  allow: { withdraw: 0, borrow: 24_150_000_000 },
  credit: { line: 24_150_000_000, binding: 'C4' },
};

/** INTERFACES.md 4. */
export const STATE: AccountState = {
  owner: 'alice.testnet',
  counter: 3,
  blocked: false,
  loan: { principal: '0' },
  verdict: { intent: { borrow: { amount: '24150000000' } }, received_block: 1003, verdict: DEMO_BORROW },
  margin_call: { since: '0', intervals: [] },
  deleverage: { first_at: '0', confirmed_plan: null },
  hourly: [{ hour: 493600, hr_bp_min: 10000, exp_bp_max: 49383 }],
  pending: [],
  hl: { path: 'hyperliquid-1', address: null },
};

const usd = (dollars: number) => String(dollars * 1_000_000);

/** A pool funded with $300k, nothing lent. */
export const POOL: PoolView = {
  cash: usd(300_000),
  loans: '0',
  capital: usd(300_000),
  utilisation_bp: 0,
  rate_bp: { preferred: 100, standard: 200, watch: 500 },
  interest_earned: '0',
  written_off: '0',
  funded: usd(300_000),
  defunded: '0',
  paused: false,
  lent_24h: '0',
  daily_budget: usd(30_000),
  daily_budget_bp: 1000,
  pending_budget: null,
  wrappers: { nBTC: { amount: '0', cap: usd(90_000) } },
  hyperliquid: { amount: '0', cap: usd(150_000) },
  book: { nBTC: { amount: '0', cap: usd(12_000_000) } },
};

export const PARAMS: ParamsView = {
  operator: 'pbf-ops.testnet',
  factory: 'pbf.testnet',
  token: 'musdc.pbf-ops.testnet',
  periods: { new_account_ns: String(7 * 86_400e9), upgrade_ns: String(30 * 86_400e9), budget_delay_ns: String(2 * 86_400e9), window_ns: String(86_400e9) },
  rates: { kink_bp: 8000, at_kink_bp: 600, at_full_bp: 5000, spread_bp: { preferred: 100, standard: 200, watch: 500 } },
  caps: {
    max_utilisation_bp: 9000,
    client_share_bp: 2500,
    new_account_limit: usd(25_000),
    ceiling: { preferred: usd(5_000_000), standard: usd(1_000_000), watch: usd(100_000) },
    cosign_borrow_above: usd(250_000),
    cosign_steps_above: usd(50_000),
    wrapper_cap_bp: { nBTC: 3000, ETH: 1500, USDT: 3000 },
    hl_cap_bp: 5000,
    book_cap: { nBTC: usd(12_000_000) },
  },
  daily_budget_bp: 1000,
  pending_budget: null,
};

/** Created at t = 1,000 s; its first week runs to 1,000 s + 7 days. */
export const BORROWER: BorrowerView = {
  created_at: '1000000000000',
  first_week_until: String(1000e9 + 7 * 86_400e9),
  debt: '0',
  tier: 'STANDARD',
  history_tier: null,
  last_upgrade_at: null,
  kyb_entity: null,
  tier_override: null,
  blocked: false,
  hl_address: null,
  steps_24h: '0',
  shares_bp: {},
  hold: {},
  hl_eq: '0',
};
