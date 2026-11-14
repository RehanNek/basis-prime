//! The pool's public types: what callers pass in and what the views return.
use std::collections::BTreeMap;

use near_sdk::json_types::{I128, U128, U64};
use near_sdk::{near, require, AccountId};

use crate::math::BP;
use crate::pricing::{FundingSettings, Pricing, PricingLimits};

/// One USDC in micro-USDC, the lending token's smallest unit.
pub const USDC: u128 = 1_000_000;
const HOUR_NS: u64 = 3_600 * 1_000_000_000;
const DAY_NS: u64 = 24 * HOUR_NS;
/// Longest name the pool stores: token and coin names, entity ids, plan ids, program names and hashes.
pub const MAX_NAME: usize = 64;
/// At most this many tokens in a verdict's maps, and in each cap table.
pub const MAX_TOKENS: usize = 8;

/// A rating tier (RISK_ENGINE.md 6), written as in the verdict: "PREFERRED", "STANDARD" or "WATCH".
#[near(serializers = [borsh, json])]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tier {
    Preferred,
    Standard,
    Watch,
}

impl Tier {
    pub const ALL: [Tier; 3] = [Tier::Preferred, Tier::Standard, Tier::Watch];

    pub fn index(self) -> usize {
        self as usize
    }

    /// The tier's name, as JSON writes it.
    pub fn name(self) -> &'static str {
        match self {
            Tier::Preferred => "PREFERRED",
            Tier::Standard => "STANDARD",
            Tier::Watch => "WATCH",
        }
    }

    /// Preferred is better than Standard, which is better than Watch.
    pub fn is_better_than(self, other: Tier) -> bool {
        (self as u8) < (other as u8)
    }
}

/// One value per tier.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PerTier<T> {
    pub preferred: T,
    pub standard: T,
    pub watch: T,
}

impl<T: Clone> PerTier<T> {
    pub fn get(&self, tier: Tier) -> T {
        match tier {
            Tier::Preferred => self.preferred.clone(),
            Tier::Standard => self.standard.clone(),
            Tier::Watch => self.watch.clone(),
        }
    }

    pub fn from_fn(f: impl Fn(Tier) -> T) -> Self {
        Self { preferred: f(Tier::Preferred), standard: f(Tier::Standard), watch: f(Tier::Watch) }
    }
}

/// The interest-rate curve (RISK_ENGINE.md 7.1), in basis points a year.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Rates {
    /// Utilisation where the curve steepens: 8,000 bp (80%).
    pub kink_bp: u32,
    /// Base rate at the kink: 600 bp (6%).
    pub at_kink_bp: u32,
    /// Base rate at 100% utilisation: 5,000 bp (50%).
    pub at_full_bp: u32,
    /// Added to the base rate per tier: Preferred +100, Standard +200, Watch +500.
    pub spread_bp: PerTier<u32>,
}

impl Default for Rates {
    fn default() -> Self {
        Self {
            kink_bp: 8_000,
            at_kink_bp: 600,
            at_full_bp: 5_000,
            spread_bp: PerTier { preferred: 100, standard: 200, watch: 500 },
        }
    }
}

impl Rates {
    pub fn assert_valid(&self) {
        require!(self.kink_bp > 0 && u128::from(self.kink_bp) < BP, "kink_bp must be between 0 and 10,000");
        require!(self.at_kink_bp <= self.at_full_bp, "at_kink_bp can't be above at_full_bp");
        let spreads = [self.spread_bp.preferred, self.spread_bp.standard, self.spread_bp.watch];
        require!(
            std::iter::once(self.at_full_bp).chain(spreads).all(|bp| u128::from(bp) <= BP),
            "rates are capped at 10,000 bp (100% a year)"
        );
    }
}

/// The pool's limits (PLAN.md 5.1; RISK_ENGINE.md 12). Amounts are micro-USDC. The daily lending budget is set
/// separately, because raising it waits 48 hours (`set_daily_budget`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Caps {
    /// Utilisation after a loan: at most 9,000 bp (90%).
    pub max_utilisation_bp: u32,
    /// One client's debt (a KYB entity's accounts together): at most 2,500 bp (25%) of capital.
    pub client_share_bp: u32,
    /// The most an account may owe in its first week: $25k.
    pub new_account_limit: U128,
    /// The most one client may owe, per tier: Preferred $5M, Standard $1M, Watch $100k.
    pub ceiling: PerTier<U128>,
    /// Borrows above this need the operator's co-signature: $250k.
    pub cosign_borrow_above: U128,
    /// Plan steps that take an account's 24-hour total above this need the co-signature: $50k.
    pub cosign_steps_above: U128,
    /// Loans resting on each bridged token, as a share of capital: nBTC 3,000, ETH 1,500, USDT 3,000 bp.
    pub wrapper_cap_bp: BTreeMap<String, u32>,
    /// Loans resting on Hyperliquid, Σ min(debt, Hyperliquid equity): at most 5,000 bp (50%) of capital.
    pub hl_cap_bp: u32,
    /// Holdings of each NEAR token across accounts with a loan: nBTC and ETH $12M, wNEAR $6M, USDT $24M.
    pub book_cap: BTreeMap<String, U128>,
}

impl Default for Caps {
    fn default() -> Self {
        let usd = |dollars: u128| U128(dollars * USDC);
        Self {
            max_utilisation_bp: 9_000,
            client_share_bp: 2_500,
            new_account_limit: usd(25_000),
            ceiling: PerTier { preferred: usd(5_000_000), standard: usd(1_000_000), watch: usd(100_000) },
            cosign_borrow_above: usd(250_000),
            cosign_steps_above: usd(50_000),
            wrapper_cap_bp: [("nBTC", 3_000), ("ETH", 1_500), ("USDT", 3_000)]
                .into_iter()
                .map(|(token, bp)| (token.to_string(), bp))
                .collect(),
            hl_cap_bp: 5_000,
            book_cap: [("nBTC", 12_000_000), ("ETH", 12_000_000), ("wNEAR", 6_000_000), ("USDT", 24_000_000)]
                .into_iter()
                .map(|(token, dollars)| (token.to_string(), usd(dollars)))
                .collect(),
        }
    }
}

impl Caps {
    pub fn assert_valid(&self) {
        let shares = [self.max_utilisation_bp, self.client_share_bp, self.hl_cap_bp];
        require!(
            shares.into_iter().chain(self.wrapper_cap_bp.values().copied()).all(|bp| u128::from(bp) <= BP),
            "a share of capital is capped at 10,000 bp"
        );
        require!(
            self.wrapper_cap_bp.len() <= MAX_TOKENS && self.book_cap.len() <= MAX_TOKENS,
            "too many tokens in a cap table"
        );
        require!(
            self.wrapper_cap_bp.keys().chain(self.book_cap.keys()).all(|t| !t.is_empty() && t.len() <= MAX_NAME),
            "token names must be 1 to 64 bytes"
        );
    }
}

/// The pool's time periods, fixed at init so the operator can't shorten them later. `new` uses the spec's values
/// when none are given; the sandbox tests pass short ones.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Periods {
    /// An account's first week, with the new-account limit: 7 days.
    pub new_account_ns: U64,
    /// At most one tier upgrade per this period: 30 days.
    pub upgrade_ns: U64,
    /// Raising the daily lending budget takes effect after this: 48 hours.
    pub budget_delay_ns: U64,
    /// The rolling window for the daily budget and plan steps: 24 hours.
    pub window_ns: U64,
}

impl Default for Periods {
    fn default() -> Self {
        Self {
            new_account_ns: U64(7 * DAY_NS),
            upgrade_ns: U64(30 * DAY_NS),
            budget_delay_ns: U64(2 * DAY_NS),
            window_ns: U64(DAY_NS),
        }
    }
}

impl Periods {
    pub fn assert_valid(&self) {
        require!(
            self.new_account_ns.0 > 0 && self.upgrade_ns.0 > 0 && self.budget_delay_ns.0 > 0,
            "periods must be positive"
        );
        require!(self.window_ns.0 >= 24, "the window must be at least 24 ns (it is kept in 24 buckets)");
    }

    /// The window is kept in hourly buckets: one twenty-fourth of it.
    pub fn bucket_ns(&self) -> u64 {
        self.window_ns.0 / 24
    }
}

/// What the account contract passes to `borrow`, copied from its fresh `borrow` verdict (RISK_ENGINE.md
/// Appendix A). The account contract checks the verdict itself: freshness, program version and nonce. The pool only
/// reads the fields below, and its own limits hold whatever they say (RISK_ENGINE.md 12.2).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct BorrowVerdict {
    /// The verdict's `tier`. The pool refuses a better tier than its own tier history allows.
    pub tier: Tier,
    /// The verdict's `allow.borrow` (W*): how much more the account may borrow now. The pool refuses more.
    pub allow_borrow: U128,
    /// The verdict's `pool.shares_bp`: each bridged token's share of the account's collateral, in bp.
    pub shares_bp: BTreeMap<String, u32>,
    /// The verdict's `pool.hold`: the account's NEAR-side holdings per token, valued in micro-USDC.
    pub hold: BTreeMap<String, U128>,
    /// The verdict's `pool.hl_eq`: the account's Hyperliquid equity in micro-USDC (0 if negative).
    pub hl_eq: U128,
}

impl BorrowVerdict {
    pub fn assert_valid(&self) {
        require!(self.shares_bp.len() <= MAX_TOKENS && self.hold.len() <= MAX_TOKENS, "too many tokens in the verdict");
        require!(self.shares_bp.values().all(|bp| u128::from(*bp) <= BP), "a collateral share is at most 10,000 bp");
    }
}

/// Something only the operator's co-signature lets through (PLAN.md 5.1): a borrow above $250k, or one plan step
/// that takes an account past $50k in 24 hours. Each co-signature is used once.
/// In JSON: `{"borrow":{"account_id":"…","amount":"…"}}` or
/// `{"step":{"account_id":"…","plan_id":"…","step":0,"token":"…","amount":"…"}}`.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum CosignRequest {
    Borrow { account_id: AccountId, amount: U128 },
    Step { account_id: AccountId, plan_id: String, step: u32, token: AccountId, amount: U128 },
}

/// A coin's or bridged token's status (RISK_ENGINE.md 5.5 and 3.3). Coins are allowed, reduce-only or removed;
/// bridged tokens (nBTC, ETH, USDT) are allowed or frozen.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoinStatus {
    Allowed,
    ReduceOnly,
    Removed,
    Frozen,
}

/// A status with the time it was set. `emergency` marks an emergency removal (its notice is 24 hours, not 7 days).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CoinState {
    pub status: CoinStatus,
    pub since: U64,
    pub emergency: bool,
}

/// The price the pool counts a plan step's token at, in micro-USDC per whole token, kept above market.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct StepPrice {
    pub decimals: u8,
    pub price: U128,
}

/// A published version of an OutLayer program (`pb-risk` or `pb-gateway`), with its parameter file's hash. An
/// account moves to it when its owner accepts it, or 30 days after `published_at` (PLAN.md 5.1).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ProgramVersion {
    pub hash: String,
    pub params: String,
    pub published_at: U64,
}

/// The operator's manual tier for one account, with a reason and an expiry.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TierOverride {
    pub tier: Tier,
    pub reason: String,
    pub expires_at: U64,
}

/// A raise of the daily lending budget, waiting for its 48 hours.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingBudget {
    pub bp: u32,
    pub from: U64,
}

/// An amount against its cap, both in micro-USDC.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Exposure {
    pub amount: U128,
    pub cap: U128,
}

/// The whole pool at a glance (PLAN.md 5.1, "Views"). Amounts are micro-USDC; interest is included up to now.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PoolView {
    pub cash: U128,
    pub loans: U128,
    /// Cash plus loans, less `credit_owed`.
    pub capital: U128,
    pub utilisation_bp: u32,
    /// Each tier's rate now: the base rate at today's utilisation plus the tier's spread.
    pub rate_bp: PerTier<u32>,
    pub interest_earned: U128,
    pub written_off: U128,
    pub funded: U128,
    pub defunded: U128,
    pub paused: bool,
    /// Loans made minus repayments over the last 24 hours, and the budget they count against.
    pub lent_24h: I128,
    pub daily_budget: U128,
    pub daily_budget_bp: u32,
    pub pending_budget: Option<PendingBudget>,
    /// Loans resting on each bridged token, against its cap.
    pub wrappers: BTreeMap<String, Exposure>,
    /// Loans resting on Hyperliquid balances, against the cap.
    pub hyperliquid: Exposure,
    /// NEAR-side holdings of accounts with a loan, per token, against the book caps.
    pub book: BTreeMap<String, Exposure>,
    /// Pricing (FUNDING.md 5.5): fees added to debts and subsidies given, since the start, and what is left of the
    /// pool's subsidy budget for the rolling 24 hours. `fees_reversed` is the part of `fees_charged` the operator
    /// took back.
    pub fees_charged: U128,
    pub fees_reversed: U128,
    pub subsidy_paid: U128,
    pub subsidy_left_24h: U128,
    /// What the pool owes accounts in credit they haven't claimed yet.
    pub credit_owed: U128,
}

/// The pool's settings.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ParamsView {
    pub operator: AccountId,
    pub factory: AccountId,
    pub token: AccountId,
    pub periods: Periods,
    pub rates: Rates,
    pub caps: Caps,
    pub daily_budget_bp: u32,
    pub pending_budget: Option<PendingBudget>,
    /// The order the engine fills a loan's sources in, and how long a loan is expected to last.
    pub funding: FundingSettings,
    pub pricing_limits: PricingLimits,
    /// The tiers that have a pricing policy, by name. A tier with none isn't listed: it passes through.
    pub tier_pricing: BTreeMap<String, Pricing>,
}

/// One account as the pool sees it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct BorrowerView {
    pub created_at: U64,
    /// The new-account limit applies until this time.
    pub first_week_until: U64,
    pub debt: U128,
    /// The tier that applies now: an unexpired override, else the tier history (Standard before any verdict).
    pub tier: Tier,
    /// The pool's tier history: the tier from the last verdict it accepted.
    pub history_tier: Option<Tier>,
    pub last_upgrade_at: Option<U64>,
    pub kyb_entity: Option<String>,
    pub tier_override: Option<TierOverride>,
    pub blocked: bool,
    pub hl_address: Option<String>,
    /// Plan steps (other than repayments) over the last 24 hours, in micro-USDC at the pool's step prices.
    pub steps_24h: U128,
    /// The book data from the account's last borrow verdict.
    pub shares_bp: BTreeMap<String, u32>,
    pub hold: BTreeMap<String, U128>,
    pub hl_eq: U128,
    /// The pricing policy that applies now (its own, else its tier's, else pass-through), and the account's fees,
    /// subsidies and unclaimed credit (FUNDING.md 5.5). `get_pricing` has the rest.
    pub pricing: Pricing,
    pub fees_charged: U128,
    pub subsidy_paid: U128,
    pub credit: U128,
}
