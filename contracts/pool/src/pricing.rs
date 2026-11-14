//! Pricing: what a client pays when part of the loan comes from an outside lender (FUNDING.md 5; INTERFACES.md 26).
//!
//! The client pays the lender its own rate, at the lender. The operator's policy says what the client should pay
//! instead, and each settlement books the difference on the client's debt to our pool: a **fee** adds to it, a
//! **subsidy** comes off it, and what is left of a subsidy once that debt is zero becomes a credit the account can
//! claim.
//!
//! **Types and pure functions only.** Nothing here reads or writes the pool's state. The pool stores these types and
//! calls `settlement` from its `settle` method (`settle.rs`); the operator's setters are in `admin.rs`, the views
//! in `views.rs` and the migration in `lib.rs`.
//!
//! - **Units.** Amounts are micro-USD. Rates are basis points a year. Times are nanoseconds.
//! - **Rounding** always favours the pool: a fee rounds up, a subsidy rounds down, a budget and an average round down.
//! - **Overflow** never panics: a function returns `None` or saturates, as `math.rs` does.
//! - **Three rules keep a client from gaming a settlement** (FUNDING.md 5.2 and 5.3; 13, cases 1 to 3):
//!   1. a subsidy never takes the client's rate below what the same lender pays depositors (`client_rate`);
//!   2. a lender's rate counts at no more than `max_rate_bp`, nor its 7-day average plus `avg_plus_bp`
//!      (`counted_rate`);
//!   3. of a period's two reported debts, the pool takes the one that favours it: the larger for a fee, the smaller
//!      for a subsidy (`settlement`).
//! - **And a wrong report can't cost much either way** (INTERFACES.md 45.1): a lender's debt counts at no more than
//!   `max_lender_debt`, and a fee is cut to two 24-hour budgets as a subsidy is (`cut_fee`, `cut_subsidy`).
use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId};
use pb_types::{LenderReport, AAVE, RHEA};

use crate::math::{mul_div_ceil, mul_div_floor, BP, YEAR_NS};
use crate::types::{Tier, USDC};
use crate::window::Window;

const HOUR_NS: u64 = 3_600 * 1_000_000_000;
const DAY_NS: u64 = 24 * HOUR_NS;
/// The name of our pool's own part in a settlement, next to the lenders' names.
pub const POOL: &str = "pool";
/// No policy rate, margin or limit is above 100% a year, like the pool's own curve (`Rates`).
const MAX_BP: u32 = 10_000;

// -------------------------------------------------------------------------------------------------------------
// Settings
// -------------------------------------------------------------------------------------------------------------

/// What a client pays on the lender's part of a loan (FUNDING.md 5.1). The operator sets it for one account or for a
/// whole tier. In JSON: `"pass_through"`, `{"lender":{"margin_bp":120,"cap_bp":null}}` or
/// `{"fixed":{"rate_bp":650}}`.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pricing {
    /// Each source at its own price: the lender's rate on the lender's part, our rate on ours. Nothing to settle.
    PassThrough,
    /// The lender's rate plus a margin (which may be negative), and never above the cap if there is one. We keep the
    /// margin and pay whatever is above the cap.
    Lender { margin_bp: i32, cap_bp: Option<u32> },
    /// One rate on the whole loan, our pool's part included. We keep or pay the whole difference.
    Fixed { rate_bp: u32 },
}

impl Pricing {
    /// What is wrong with this policy, if anything, in words that say what to fix.
    pub fn problem(&self) -> Option<&'static str> {
        match self {
            Pricing::PassThrough => None,
            Pricing::Lender { margin_bp, cap_bp } => {
                if margin_bp.unsigned_abs() > MAX_BP {
                    Some("margin_bp must be between -10,000 and 10,000 bp")
                } else if cap_bp.is_some_and(|cap| cap > MAX_BP) {
                    Some("cap_bp is capped at 10,000 bp (100% a year)")
                } else {
                    None
                }
            }
            Pricing::Fixed { rate_bp } => (*rate_bp > MAX_BP).then_some("rate_bp is capped at 10,000 bp (100% a year)"),
        }
    }

    pub fn assert_valid(&self) {
        if let Some(problem) = self.problem() {
            env::panic_str(problem);
        }
    }
}

/// What `set_pricing` sets a policy for. In JSON: `{"account":"<id>"}` or `{"tier":"STANDARD"}`.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PricingTarget {
    Account(AccountId),
    Tier(Tier),
}

/// Where an account's policy came from. In JSON: `"account"`, `"tier"` or `"default"`.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PricingFrom {
    Account,
    Tier,
    Default,
}

/// An account's policy is its own, else its tier's, else pass-through.
pub fn policy_for(own: Option<&Pricing>, tier: Option<&Pricing>) -> (Pricing, PricingFrom) {
    match (own, tier) {
        (Some(pricing), _) => (pricing.clone(), PricingFrom::Account),
        (None, Some(pricing)) => (pricing.clone(), PricingFrom::Tier),
        (None, None) => (Pricing::PassThrough, PricingFrom::Default),
    }
}

/// The order the engine fills a loan's sources in (FUNDING.md 6.4). In JSON: `"cheapest"`, `"pool_first"` or
/// `"lender_first"`.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FundingOrder {
    /// Sorted by what each source costs us: the default.
    Cheapest,
    PoolFirst,
    LenderFirst,
}

/// `get_params().funding`, which the engine reads. In JSON: `{"order":"lender_first","loan_days":90}`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FundingSettings {
    pub order: FundingOrder,
    /// How long a loan is expected to last, for weighing the cost of moving collateral to a lender: 90 days.
    pub loan_days: u32,
}

impl Default for FundingSettings {
    fn default() -> Self {
        Self { order: FundingOrder::Cheapest, loan_days: 90 }
    }
}

impl FundingSettings {
    pub fn problem(&self) -> Option<&'static str> {
        (self.loan_days == 0).then_some("loan_days must be at least 1")
    }

    pub fn assert_valid(&self) {
        if let Some(problem) = self.problem() {
            env::panic_str(problem);
        }
    }
}

/// What a wrong report can cost at most (FUNDING.md 5.3).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PricingLimits {
    /// A lender's rate never counts above this: 6,000 bp (60% a year).
    pub max_rate_bp: u32,
    /// Nor above its 7-day average plus this: 500 bp (5 points).
    pub avg_plus_bp: u32,
    /// One settlement covers at most this long: 48 hours. A plain JSON number, as INTERFACES.md 26 writes it.
    pub max_period_ns: u64,
    /// Two settlements of one account are at least this far apart: 10 minutes. Anyone may ask an account to settle,
    /// so a call that comes sooner is skipped (INTERFACES.md 30, point 4), unless its report shows new lender debt
    /// (`borrowed_since`). Left out of the JSON, it is 10 minutes.
    #[serde(default = "default_min_period_ns")]
    pub min_period_ns: u64,
    /// The most subsidy one account gets in 24 hours: $100.
    pub account_subsidy_day: U128,
    /// The most subsidy the whole pool pays in 24 hours, as a share of its capital: 5 bp.
    pub pool_subsidy_day_bp: u32,
    /// A lender's reported debt counts at no more than this in a settlement, at both ends of the period, for a fee
    /// and for a subsidy: $1,000,000 (INTERFACES.md 45.1). Left out of the JSON, it is $1,000,000.
    #[serde(default = "default_max_lender_debt")]
    pub max_lender_debt: U128,
    /// The most fee one account is charged in 24 hours: $1,000. Left out of the JSON, it is $1,000.
    #[serde(default = "default_account_fee_day")]
    pub account_fee_day: U128,
    /// The most fee the whole pool books in 24 hours, as a share of its capital: 50 bp (0.5%). Left out of the
    /// JSON, it is 50.
    #[serde(default = "default_pool_fee_day_bp")]
    pub pool_fee_day_bp: u32,
}

fn default_min_period_ns() -> u64 {
    HOUR_NS / 6
}

fn default_max_lender_debt() -> U128 {
    U128(1_000_000 * USDC)
}

fn default_account_fee_day() -> U128 {
    U128(1_000 * USDC)
}

fn default_pool_fee_day_bp() -> u32 {
    50
}

impl Default for PricingLimits {
    fn default() -> Self {
        Self {
            max_rate_bp: 6_000,
            avg_plus_bp: 500,
            max_period_ns: 48 * HOUR_NS,
            min_period_ns: default_min_period_ns(),
            account_subsidy_day: U128(100 * USDC),
            pool_subsidy_day_bp: 5,
            max_lender_debt: default_max_lender_debt(),
            account_fee_day: default_account_fee_day(),
            pool_fee_day_bp: default_pool_fee_day_bp(),
        }
    }
}

impl PricingLimits {
    /// What is wrong with these limits, if anything, in words that say what to fix.
    pub fn problem(&self) -> Option<&'static str> {
        if self.max_rate_bp > MAX_BP {
            Some("max_rate_bp is capped at 10,000 bp (100% a year)")
        } else if self.avg_plus_bp > MAX_BP {
            Some("avg_plus_bp is capped at 10,000 bp (100 points)")
        } else if self.max_period_ns == 0 || u128::from(self.max_period_ns) > YEAR_NS {
            Some("max_period_ns must be between 1 ns and a year")
        } else if self.min_period_ns == 0 || self.min_period_ns > self.max_period_ns {
            Some("min_period_ns must be between 1 ns and max_period_ns")
        } else if u128::from(self.pool_subsidy_day_bp) > BP {
            Some("pool_subsidy_day_bp is a share of capital, capped at 10,000 bp")
        } else if u128::from(self.pool_fee_day_bp) > BP {
            Some("pool_fee_day_bp is a share of capital, capped at 10,000 bp")
        } else {
            None
        }
    }

    pub fn assert_valid(&self) {
        if let Some(problem) = self.problem() {
            env::panic_str(problem);
        }
    }

    /// The whole pool's subsidy budget for 24 hours: `pool_subsidy_day_bp` of its capital, rounded down.
    pub fn pool_subsidy_day(&self, capital: u128) -> u128 {
        share_of(capital, self.pool_subsidy_day_bp)
    }

    /// The whole pool's fee budget for 24 hours: `pool_fee_day_bp` of its capital, rounded down.
    pub fn pool_fee_day(&self, capital: u128) -> u128 {
        share_of(capital, self.pool_fee_day_bp)
    }
}

/// `bp` of `capital`, rounded down.
fn share_of(capital: u128, bp: u32) -> u128 {
    let bp = u128::from(bp);
    mul_div_floor(capital, bp, BP).unwrap_or_else(|| (capital / BP).saturating_mul(bp))
}

/// What is wrong with a lender report, if anything: each lender is "aave" or "rhea" and is named once.
pub fn report_problem(report: &[LenderReport]) -> Option<String> {
    for (i, line) in report.iter().enumerate() {
        if line.lender != AAVE && line.lender != RHEA {
            return Some(format!(r#"the report names {:?}: the lenders are "aave" and "rhea""#, line.lender));
        }
        if report[..i].iter().any(|other| other.lender == line.lender) {
            return Some(format!("the report names {} twice", line.lender));
        }
    }
    None
}

// -------------------------------------------------------------------------------------------------------------
// What the pool stores
// -------------------------------------------------------------------------------------------------------------

/// One account's pricing record. It lives in a map of its own, so no borrower record changes shape (FUNDING.md 5.4).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AccountPricing {
    /// The account's own policy, if the operator set one.
    pub pricing: Option<Pricing>,
    /// The report the last settlement stored: the start of the next period.
    pub last: Vec<LenderReport>,
    /// When that was; 0 before the first settlement.
    pub settled_at: u64,
    /// Fees added to the account's debt and subsidies given to it, since the start.
    pub fees_charged: u128,
    pub subsidy_paid: u128,
    /// Subsidy left over once the debt was zero, which the account can claim in USDC.
    pub credit: u128,
    /// Subsidies over the rolling 24 hours, against `account_subsidy_day`.
    pub subsidy_24h: Window,
    /// Each lender's rates as this account's settlements reported them, for the 7-day average.
    pub rates: Vec<(String, RateHistory)>,
    /// Our pool's own part since the last settlement.
    pub pool: PoolPart,
}

impl AccountPricing {
    /// The time the next settlement covers: none before the first one, which only stores its report.
    pub fn elapsed_ns(&self, now: u64) -> u64 {
        if self.settled_at == 0 {
            0
        } else {
            now.saturating_sub(self.settled_at)
        }
    }

    /// A lender's 7-day average rate at `now`, if this account has reported it in that time.
    pub fn average_bp(&self, lender: &str, now: u64) -> Option<u32> {
        self.rates.iter().find(|(name, _)| name == lender).and_then(|(_, history)| history.average(now))
    }

    /// Adds a report's rates to the history. A rate goes in at no more than `max_rate_bp`, since it never counts
    /// above that: one wrong report can't lift the average, and with it the limit, for the whole week.
    pub fn note_rates(&mut self, now: u64, report: &[LenderReport], max_rate_bp: u32) {
        for line in report {
            let rate_bp = line.rate_bp.min(max_rate_bp);
            match self.rates.iter_mut().find(|(name, _)| *name == line.lender) {
                Some((_, history)) => history.add(now, rate_bp),
                None => {
                    let mut history = RateHistory::default();
                    history.add(now, rate_bp);
                    self.rates.push((line.lender.clone(), history));
                }
            }
        }
    }

    /// The record as `get_pricing` shows it. `tier` is the policy of the account's tier, if one is set, and
    /// `fees_reversed` comes from the account's fees record.
    pub fn view(&self, tier: Option<&Pricing>, fees_reversed: u128) -> PricingView {
        let (pricing, from) = policy_for(self.pricing.as_ref(), tier);
        PricingView {
            pricing,
            from,
            fees_charged: U128(self.fees_charged),
            fees_reversed: U128(fees_reversed),
            subsidy_paid: U128(self.subsidy_paid),
            credit: U128(self.credit),
            settled_at: U64(self.settled_at),
            last: self.last.clone(),
        }
    }
}

/// What the pool keeps on an account's fees beside its pricing record (INTERFACES.md 45.1). It lives in a map of
/// its own, so that no stored pricing record changes shape.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AccountFees {
    /// Fees charged over the rolling 24 hours, against `account_fee_day`.
    pub fee_24h: Window,
    /// Fees the operator took back with `reverse_fee`, since the start.
    pub fees_reversed: u128,
}

/// `get_pricing(account_id)`: the policy that applies, where it came from, and the account's totals.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PricingView {
    pub pricing: Pricing,
    pub from: PricingFrom,
    pub fees_charged: U128,
    /// Of `fees_charged`, what the operator took back with `reverse_fee`.
    pub fees_reversed: U128,
    pub subsidy_paid: U128,
    pub credit: U128,
    pub settled_at: U64,
    pub last: Vec<LenderReport>,
}

/// Our pool's own part of an account's loan since its last settlement, which only a `Fixed` policy adjusts
/// (INTERFACES.md 30, point 1).
///
/// A settlement can't take the debt as it stands at that moment: a client would borrow from the pool just before
/// one that pays a subsidy, or repay just before one that charges a fee. Nor can it take the tier's rate at that
/// moment, which one large borrow moves for a minute. So the pool notes the debt at every borrow and repayment, and
/// this adds up what the client really paid the pool and how much it owed for how long. A settlement then compares
/// the fixed rate with the rate the pool really charged, on the debt's average over the period.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PoolPart {
    /// The debt to our pool right after it last changed, and when it was last noted (0: never).
    debt: u128,
    seen_at: u64,
    /// Since the last settlement: the pool's own interest on that debt, and the debt × the time it was owed, in
    /// micro-USD × ns.
    interest: u128,
    debt_ns: u128,
}

impl PoolPart {
    /// Notes the debt as it stands at `now`, interest included, before a borrow, a repayment or a settlement changes
    /// it. What it grew by since the last note is the pool's interest. Never panics.
    pub fn see(&mut self, now: u64, debt: u128) {
        if self.seen_at != 0 {
            let dt = now.saturating_sub(self.seen_at);
            self.interest = self.interest.saturating_add(debt.saturating_sub(self.debt));
            self.debt_ns = self.debt_ns.saturating_add(self.debt.saturating_mul(dt.into()));
        }
        self.debt = debt;
        self.seen_at = now;
    }

    /// The debt after that change.
    pub fn set(&mut self, debt: u128) {
        self.debt = debt;
    }

    /// Starts the next period at `now`, owing `debt`.
    pub fn restart(&mut self, now: u64, debt: u128) {
        *self = Self { debt, seen_at: now, interest: 0, debt_ns: 0 };
    }

    /// The period's figures for `settlement`, after `see`: the debt's average over `elapsed_ns`, and the rate the
    /// pool really charged on it, in bp a year to the nearest. `fixed_bp` is the policy's fixed rate, if it has one:
    /// the average rounds up when that rate makes a fee, and down otherwise. With nothing owed in the period, the
    /// debt is 0 and the rate is `rate_now_bp`, the tier's rate now. It saturates, which only ever lowers a rate.
    pub fn figures(&self, elapsed_ns: u64, fixed_bp: Option<u32>, rate_now_bp: u32) -> (u128, u32) {
        if self.debt_ns == 0 || elapsed_ns == 0 {
            return (0, rate_now_bp);
        }
        let rate = self.interest.saturating_mul(BP * YEAR_NS).saturating_add(self.debt_ns / 2) / self.debt_ns;
        let rate_bp = u32::try_from(rate).unwrap_or(u32::MAX);
        let elapsed = u128::from(elapsed_ns);
        let debt = if fixed_bp.is_some_and(|fixed| fixed > rate_bp) {
            self.debt_ns.div_ceil(elapsed)
        } else {
            self.debt_ns / elapsed
        };
        (debt, rate_bp)
    }
}

/// What `settle` answers: the settlement, or `{"skipped":"<why>"}` when there was none and nothing changed.
#[near(serializers = [json])]
#[serde(untagged)]
#[derive(Clone, Debug, PartialEq)]
pub enum SettleAnswer {
    Skipped { skipped: String },
    Settled(Settled),
}

/// One settlement as booked. Amounts are micro-USD.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Settled {
    /// Added to the account's debt to our pool.
    pub fee: U128,
    /// Given to the account, after the budgets' cut: it comes off the debt first, and the rest goes to the credit.
    pub subsidy: U128,
    /// The account's credit afterwards, which it can claim in USDC.
    pub credit: U128,
    /// The time this settlement covered: all the time since the last one when it works out a fee, and at most
    /// `max_period_ns` of it otherwise.
    pub period_ns: U64,
    /// What the 24-hour budgets cut from the fee or from the subsidy. It isn't owed later.
    pub cut: U128,
    /// The account's debt to our pool afterwards.
    pub debt: U128,
    /// The policy it used, and where that came from.
    pub pricing: Pricing,
    pub from: PricingFrom,
    /// Each lender's part ("aave" before "rhea"), then our pool's, before the budgets' cut.
    pub parts: Vec<PartView>,
}

/// One source's part of a settlement, as the answer and the event show it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PartView {
    pub source: String,
    pub debt: U128,
    pub counted_bp: u32,
    pub client_bp: u32,
    pub fee: U128,
    pub subsidy: U128,
}

impl From<&Part> for PartView {
    fn from(part: &Part) -> Self {
        Self {
            source: part.source.clone(),
            debt: U128(part.debt),
            counted_bp: part.counted_bp,
            client_bp: part.client_bp,
            fee: U128(part.adjustment.fee()),
            subsidy: U128(part.adjustment.subsidy()),
        }
    }
}

/// One lender's reported borrow rates over the last 7 days, for the limit on what a rate counts at.
///
/// **It averages reports, not time.** Each day's reports are averaged, then the days that have any are averaged. A
/// rate that held for an hour and was reported once weighs as much as one that held all day and was reported once.
/// Averaging by day first means a burst of reports inside a few hours moves one day's figure, not the whole week's.
///
/// It keeps today and the 7 days before it, so a report counts for at least 7 whole days: between 7 and 8.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RateHistory {
    /// (day number, the sum of that day's reported rates in bp, how many reports), oldest first; at most `KEEP`.
    days: Vec<(u64, u64, u32)>,
}

impl RateHistory {
    /// Today plus the 7 days before it.
    const KEEP: u64 = 8;

    /// Records a rate reported at time `now`.
    pub fn add(&mut self, now: u64, rate_bp: u32) {
        let today = now / DAY_NS;
        self.days.retain(|(day, _, _)| day + Self::KEEP > today);
        match self.days.last_mut() {
            Some((day, sum, count)) if *day == today => {
                *sum = sum.saturating_add(rate_bp.into());
                *count = count.saturating_add(1);
            }
            _ => self.days.push((today, rate_bp.into(), 1)),
        }
    }

    /// The average at time `now`, rounded down. None with no report in the last 7 days.
    pub fn average(&self, now: u64) -> Option<u32> {
        let today = now / DAY_NS;
        let (mut sum, mut days) = (0u64, 0u64);
        for (day, total, count) in &self.days {
            if day + Self::KEEP > today && *count > 0 {
                sum = sum.saturating_add(total / u64::from(*count));
                days += 1;
            }
        }
        (days > 0).then(|| u32::try_from(sum / days).unwrap_or(u32::MAX))
    }
}

// -------------------------------------------------------------------------------------------------------------
// One settlement
// -------------------------------------------------------------------------------------------------------------

/// What a settlement books on the client's debt to our pool, in micro-USD. A fee and a subsidy are never zero.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Adjustment {
    Nothing,
    /// The client paid less than the policy says: this is added to the debt.
    Fee(u128),
    /// The client paid more than the policy says: this comes off the debt.
    Subsidy(u128),
}

impl Adjustment {
    /// Fees less subsidies, as one adjustment.
    pub fn net(fees: u128, subsidies: u128) -> Self {
        match fees.cmp(&subsidies) {
            std::cmp::Ordering::Greater => Adjustment::Fee(fees - subsidies),
            std::cmp::Ordering::Less => Adjustment::Subsidy(subsidies - fees),
            std::cmp::Ordering::Equal => Adjustment::Nothing,
        }
    }

    /// The fee, or 0.
    pub fn fee(self) -> u128 {
        match self {
            Adjustment::Fee(amount) => amount,
            _ => 0,
        }
    }

    /// The subsidy, or 0.
    pub fn subsidy(self) -> u128 {
        match self {
            Adjustment::Subsidy(amount) => amount,
            _ => 0,
        }
    }
}

/// One source's part of a settlement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Part {
    /// "aave", "rhea" or "pool".
    pub source: String,
    /// The debt the adjustment is worked out on. For a lender it is the figure that favours the pool: the smaller of
    /// the two reports for a subsidy, the larger otherwise.
    pub debt: u128,
    /// The source's rate as counted: a lender's reported rate after the limits, or our tier's rate now.
    pub counted_bp: u32,
    /// What the policy has the client pay on this part.
    pub client_bp: u32,
    pub adjustment: Adjustment,
}

/// A settlement's result: each part, and the total to book.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settlement {
    /// The time a subsidy covers: the time since the last settlement, cut to `max_period_ns`.
    pub period_ns: u64,
    /// The time a fee covers: all the time since the last settlement (INTERFACES.md 45.1, point 3).
    pub fee_period_ns: u64,
    /// The lenders by name ("aave" before "rhea"), then our pool.
    pub parts: Vec<Part>,
    /// The parts' fees less their subsidies, still to be cut to the budgets (`cut_fee`, `cut_subsidy`).
    pub total: Adjustment,
}

impl Settlement {
    /// The time the total covers: a fee's when it is a fee, else a subsidy's.
    pub fn covered_ns(&self) -> u64 {
        match self.total {
            Adjustment::Fee(_) => self.fee_period_ns,
            _ => self.period_ns,
        }
    }
}

/// One settlement's inputs.
#[derive(Clone, Debug)]
pub struct Period<'a> {
    /// The time since the last settlement.
    pub elapsed_ns: u64,
    /// The report the last settlement stored, and the one that closes this period: the report this settlement
    /// brings, or what it passes as `closes` (the debts just before a borrow).
    pub previous: &'a [LenderReport],
    pub new: &'a [LenderReport],
    /// The account's debt to our pool and the rate the pool charges on it. The pool passes the period's averages
    /// (`PoolPart::figures`), so neither can be moved just before a settlement.
    pub pool_debt: u128,
    pub tier_rate_bp: u32,
}

/// The rate a lender's reported rate counts at: at most `max_rate_bp`, and at most its 7-day average plus
/// `avg_plus_bp`. With no history yet, only `max_rate_bp` applies.
///
/// This stops FUNDING.md 13, case 2: a rate pushed up for a few hours earns no subsidy beyond 5 points.
pub fn counted_rate(reported_bp: u32, average_bp: Option<u32>, limits: &PricingLimits) -> u32 {
    let capped = reported_bp.min(limits.max_rate_bp);
    match average_bp {
        Some(average) => capped.min(average.saturating_add(limits.avg_plus_bp)),
        None => capped,
    }
}

/// What the policy has the client pay on a lender's part, given the lender's counted rate and its deposit rate.
///
/// **The floor:** when that is below the counted rate (a subsidy), it is raised to the lender's deposit rate if that
/// is higher, and never above the counted rate. This stops FUNDING.md 13, case 1: borrowing through us and lending
/// the money straight back to the same lender earns nothing.
pub fn client_rate(pricing: &Pricing, counted_bp: u32, supply_bp: u32) -> u32 {
    let target = match pricing {
        Pricing::PassThrough => counted_bp,
        Pricing::Lender { margin_bp, cap_bp } => {
            let with_margin = i64::from(counted_bp).saturating_add(i64::from(*margin_bp)).max(0);
            let with_margin = u32::try_from(with_margin).unwrap_or(u32::MAX);
            cap_bp.map_or(with_margin, |cap| with_margin.min(cap))
        }
        Pricing::Fixed { rate_bp } => *rate_bp,
    };
    if target < counted_bp {
        target.max(supply_bp).min(counted_bp)
    } else {
        target
    }
}

/// debt × rate × time ÷ a year, in one division so it rounds once: up for a fee, down for a subsidy.
fn interest(debt: u128, rate_bp: u32, period_ns: u64, round_up: bool) -> Option<u128> {
    let per_year = debt.checked_mul(rate_bp.into())?;
    let divisor = BP * YEAR_NS;
    if round_up {
        mul_div_ceil(per_year, period_ns.into(), divisor)
    } else {
        mul_div_floor(per_year, period_ns.into(), divisor)
    }
}

/// A part's adjustment: a fee on `larger` over `fee_ns` when the client's rate is above the counted rate, a subsidy
/// on `smaller` over `subsidy_ns` when it is below. Returns the debt used with it.
fn adjust(
    (larger, smaller): (u128, u128),
    (counted_bp, client_bp): (u32, u32),
    (fee_ns, subsidy_ns): (u64, u64),
) -> Option<(u128, Adjustment)> {
    if client_bp > counted_bp {
        let fee = interest(larger, client_bp - counted_bp, fee_ns, true)?;
        Some((larger, if fee == 0 { Adjustment::Nothing } else { Adjustment::Fee(fee) }))
    } else if client_bp < counted_bp {
        let subsidy = interest(smaller, counted_bp - client_bp, subsidy_ns, false)?;
        Some((smaller, if subsidy == 0 { Adjustment::Nothing } else { Adjustment::Subsidy(subsidy) }))
    } else {
        Some((larger, Adjustment::Nothing))
    }
}

fn line<'a>(report: &'a [LenderReport], lender: &str) -> Option<&'a LenderReport> {
    report.iter().find(|line| line.lender == lender)
}

/// Whether `new` shows a borrow at some lender since `previous`, `elapsed_ns` ago: more debt there than interest
/// alone could have added. Such a report is never skipped as too soon. If it were, a client could borrow at a lender
/// right after a settlement and repay before the next one, and the pool would never see that loan or charge its fee.
///
/// Interest is allowed at the highest of `max_rate_bp` and the lender's own rate in either report, rounded up, so
/// a debt that only grew by itself never counts as a borrow. A lender that `previous` doesn't name owed nothing.
pub fn borrowed_since(previous: &[LenderReport], new: &[LenderReport], elapsed_ns: u64, max_rate_bp: u32) -> bool {
    new.iter().any(|now| {
        let before = line(previous, &now.lender);
        let (debt, rate_bp) = before.map_or((0, 0), |b| (b.debt.0, b.rate_bp));
        let rate_bp = rate_bp.max(now.rate_bp).max(max_rate_bp);
        let grown = interest(debt, rate_bp, elapsed_ns, true).and_then(|added| debt.checked_add(added));
        grown.is_some_and(|most| now.debt.0 > most)
    })
}

/// One settlement (INTERFACES.md 26): what the policy says the client should have paid over the period, against
/// what each source really cost. `average_bp` gives a lender's 7-day average rate, if it has any history.
///
/// - **The period** is the time since the last settlement. A fee covers all of it, so no fee lapses however late
///   a settlement comes. A subsidy covers at most `max_period_ns` of it.
/// - **Each lender's part** uses the previous report's rates, since those held over the period. A lender in only
///   one of the two reports has a debt of 0 in the other, and its rates come from the report that has it.
/// - **The debt** is the figure that favours the pool: the larger of the two reports for a fee, the smaller for a
///   subsidy. This stops FUNDING.md 13, case 3: showing a large debt when a subsidy is settled and a small one in
///   between, or the reverse for a fee. Each report's debt counts at no more than `max_lender_debt`, so a wrong
///   report can't make a fee or a subsidy of any size.
/// - **Our pool's own part** adjusts only under `Fixed`: the account's debt to us, at the fixed rate against the
///   rate the pool charged (`pool_debt` and `tier_rate_bp`).
///
/// None means an absurd amount overflowed; the contract refuses the call.
pub fn settlement(
    pricing: &Pricing,
    limits: &PricingLimits,
    period: &Period,
    average_bp: impl Fn(&str) -> Option<u32>,
) -> Option<Settlement> {
    let fee_period_ns = period.elapsed_ns;
    let period_ns = period.elapsed_ns.min(limits.max_period_ns);
    let times = (fee_period_ns, period_ns);
    let counted = |report: Option<&LenderReport>| report.map_or(0, |r| r.debt.0.min(limits.max_lender_debt.0));
    let mut names: Vec<&str> = period.previous.iter().chain(period.new).map(|line| line.lender.as_str()).collect();
    names.sort_unstable();
    names.dedup();

    let mut parts = Vec::with_capacity(names.len() + 1);
    for name in names {
        let (before, after) = (line(period.previous, name), line(period.new, name));
        let rates = before.or(after)?;
        let (debt_before, debt_after) = (counted(before), counted(after));
        let counted_bp = counted_rate(rates.rate_bp, average_bp(name), limits);
        let client_bp = client_rate(pricing, counted_bp, rates.supply_bp);
        let debts = (debt_before.max(debt_after), debt_before.min(debt_after));
        let (debt, adjustment) = adjust(debts, (counted_bp, client_bp), times)?;
        parts.push(Part { source: name.to_string(), debt, counted_bp, client_bp, adjustment });
    }

    let pool_bp = match pricing {
        Pricing::Fixed { rate_bp } => *rate_bp,
        _ => period.tier_rate_bp,
    };
    let (debt, adjustment) = adjust((period.pool_debt, period.pool_debt), (period.tier_rate_bp, pool_bp), times)?;
    parts.push(Part {
        source: POOL.to_string(),
        debt,
        counted_bp: period.tier_rate_bp,
        client_bp: pool_bp,
        adjustment,
    });

    let (mut fees, mut subsidies) = (0u128, 0u128);
    for part in &parts {
        fees = fees.checked_add(part.adjustment.fee())?;
        subsidies = subsidies.checked_add(part.adjustment.subsidy())?;
    }
    Some(Settlement { period_ns, fee_period_ns, parts, total: Adjustment::net(fees, subsidies) })
}

// -------------------------------------------------------------------------------------------------------------
// Budgets, and booking the result
// -------------------------------------------------------------------------------------------------------------

/// What is left of a 24-hour budget after `paid_24h` (never below zero).
pub fn budget_left(budget: u128, paid_24h: u128) -> u128 {
    budget.saturating_sub(paid_24h)
}

/// Cuts a subsidy to what is left of the account's and the pool's 24-hour budgets (FUNDING.md 5.3). `account_paid_24h`
/// and `pool_paid_24h` are the subsidies already given over the rolling 24 hours, and `capital` is the pool's. What
/// is cut is not owed later.
pub fn cut_subsidy(
    limits: &PricingLimits,
    subsidy: u128,
    account_paid_24h: u128,
    pool_paid_24h: u128,
    capital: u128,
) -> u128 {
    subsidy
        .min(budget_left(limits.account_subsidy_day.0, account_paid_24h))
        .min(budget_left(limits.pool_subsidy_day(capital), pool_paid_24h))
}

/// Cuts a fee to what is left of the account's and the pool's 24-hour fee budgets (INTERFACES.md 45.1), as
/// `cut_subsidy` cuts a subsidy to its own. `account_charged_24h` and `pool_charged_24h` are the fees already booked
/// over the rolling 24 hours, and `capital` is the pool's. What is cut is not owed later.
pub fn cut_fee(
    limits: &PricingLimits,
    fee: u128,
    account_charged_24h: u128,
    pool_charged_24h: u128,
    capital: u128,
) -> u128 {
    fee.min(budget_left(limits.account_fee_day.0, account_charged_24h))
        .min(budget_left(limits.pool_fee_day(capital), pool_charged_24h))
}

/// Books an adjustment: returns the account's debt to our pool and its credit afterwards. A fee adds to the debt.
/// A subsidy takes the debt down, and once the debt is zero the rest becomes credit. None on overflow.
pub fn apply(adjustment: Adjustment, debt: u128, credit: u128) -> Option<(u128, u128)> {
    match adjustment {
        Adjustment::Nothing => Some((debt, credit)),
        Adjustment::Fee(fee) => Some((debt.checked_add(fee)?, credit)),
        Adjustment::Subsidy(subsidy) => {
            let off_debt = subsidy.min(debt);
            Some((debt - off_debt, credit.checked_add(subsidy - off_debt)?))
        }
    }
}

#[cfg(test)]
mod tests {
    use near_sdk::borsh;
    use near_sdk::serde_json::{self, json};

    use super::*;

    const HOUR: u64 = HOUR_NS;
    const DAY: u64 = DAY_NS;
    const YEAR: u64 = YEAR_NS as u64;
    /// The loan of INTERFACES.md 26's worked numbers, in micro-USD.
    const RHEA_PART: u128 = 50_667 * USDC;
    const AAVE_PART: u128 = 56_667 * USDC;
    const POOL_PART: u128 = 37_833 * USDC;

    fn usd(dollars: u128) -> u128 {
        dollars * USDC
    }

    /// Micro-USD to the nearest cent.
    fn cents(micro: u128) -> u128 {
        (micro + 5_000) / 10_000
    }

    fn report(lender: &str, debt: u128, rate_bp: u32, supply_bp: u32) -> LenderReport {
        LenderReport { lender: lender.into(), debt: U128(debt), rate_bp, supply_bp }
    }

    fn rhea(supply_bp: u32) -> Vec<LenderReport> {
        vec![report(RHEA, RHEA_PART, 1_591, supply_bp)]
    }

    fn aave() -> Vec<LenderReport> {
        vec![report(AAVE, AAVE_PART, 533, 410)]
    }

    /// The limits with a period of up to a year, for the worked numbers.
    fn year_limits() -> PricingLimits {
        PricingLimits { max_period_ns: YEAR, ..Default::default() }
    }

    /// A settlement over `elapsed_ns` with the same report at both ends, no rate history, and nothing owed to our
    /// pool.
    fn steady(pricing: &Pricing, limits: &PricingLimits, elapsed_ns: u64, report: &[LenderReport]) -> Settlement {
        let period = Period { elapsed_ns, previous: report, new: report, pool_debt: 0, tier_rate_bp: 650 };
        settlement(pricing, limits, &period, |_| None).unwrap()
    }

    /// The same between two different reports.
    fn between(pricing: &Pricing, previous: &[LenderReport], new: &[LenderReport]) -> Settlement {
        let period = Period { elapsed_ns: YEAR, previous, new, pool_debt: 0, tier_rate_bp: 650 };
        settlement(pricing, &year_limits(), &period, |_| None).unwrap()
    }

    const CAPPED_AT_8: Pricing = Pricing::Lender { margin_bp: 0, cap_bp: Some(800) };
    const MARGIN_120: Pricing = Pricing::Lender { margin_bp: 120, cap_bp: None };
    const FIXED_650: Pricing = Pricing::Fixed { rate_bp: 650 };

    // ---- Each policy, both signs, and INTERFACES.md 26's worked numbers ----

    #[test]
    fn pass_through_settles_nothing_on_any_part() {
        let both = [aave(), rhea(1_032)].concat();
        let period = Period { elapsed_ns: YEAR, previous: &both, new: &both, pool_debt: POOL_PART, tier_rate_bp: 650 };
        let s = settlement(&Pricing::PassThrough, &year_limits(), &period, |_| None).unwrap();
        assert_eq!(s.total, Adjustment::Nothing);
        let sources: Vec<_> = s.parts.iter().map(|p| (p.source.as_str(), p.counted_bp, p.client_bp)).collect();
        assert_eq!(sources, [("aave", 533, 533), ("rhea", 1_591, 1_591), ("pool", 650, 650)]);
        assert!(s.parts.iter().all(|p| p.adjustment == Adjustment::Nothing));
    }

    #[test]
    fn a_margin_on_a_cheap_lender_is_a_fee_of_680_dollars_a_year() {
        let s = steady(&MARGIN_120, &year_limits(), YEAR, &aave());
        assert_eq!((s.parts[0].counted_bp, s.parts[0].client_bp), (533, 653));
        assert_eq!(s.total, Adjustment::Fee(680_004_000));
        assert_eq!(cents(s.total.fee()), 68_000); // $680.00
        assert_eq!(s.parts[0].adjustment, s.total);
    }

    #[test]
    fn a_cap_on_a_dear_lender_is_a_subsidy_of_4007_76_a_year_and_0_4575_an_hour() {
        let s = steady(&CAPPED_AT_8, &year_limits(), YEAR, &rhea(0));
        assert_eq!((s.parts[0].counted_bp, s.parts[0].client_bp), (1_591, 800));
        assert_eq!(s.total, Adjustment::Subsidy(4_007_759_700));
        assert_eq!(cents(s.total.subsidy()), 400_776); // $4,007.76

        let hour = steady(&CAPPED_AT_8, &PricingLimits::default(), HOUR, &rhea(0));
        assert_eq!(hour.total, Adjustment::Subsidy(457_506));
        assert_eq!((hour.total.subsidy() + 50) / 100, 4_575); // $0.4575
    }

    #[test]
    fn with_rheas_real_deposit_rate_the_client_pays_10_32_percent_and_the_subsidy_is_2832_29() {
        let s = steady(&CAPPED_AT_8, &year_limits(), YEAR, &rhea(1_032));
        assert_eq!(s.parts[0].client_bp, 1_032);
        assert_eq!(s.total, Adjustment::Subsidy(2_832_285_300));
        assert_eq!(cents(s.total.subsidy()), 283_229); // $2,832.29
    }

    #[test]
    fn a_fixed_rate_is_a_fee_of_663_dollars_on_the_aave_part_and_nothing_on_ours() {
        let report = aave();
        let period =
            Period { elapsed_ns: YEAR, previous: &report, new: &report, pool_debt: POOL_PART, tier_rate_bp: 650 };
        let s = settlement(&FIXED_650, &year_limits(), &period, |_| None).unwrap();
        assert_eq!(s.parts[0].adjustment, Adjustment::Fee(663_003_900));
        assert_eq!(cents(s.parts[0].adjustment.fee()), 66_300); // $663.00
        assert_eq!(
            s.parts[1],
            Part {
                source: "pool".into(),
                debt: POOL_PART,
                counted_bp: 650,
                client_bp: 650,
                adjustment: Adjustment::Nothing
            }
        );
        assert_eq!(s.total, Adjustment::Fee(663_003_900));
    }

    #[test]
    fn a_fixed_rate_settles_our_pools_part_against_the_tiers_rate_either_way() {
        let pool_only = |tier_rate_bp| {
            let period = Period { elapsed_ns: YEAR, previous: &[], new: &[], pool_debt: POOL_PART, tier_rate_bp };
            settlement(&FIXED_650, &year_limits(), &period, |_| None).unwrap()
        };
        // The tier pays 8%: the pool gives back 1.5 points. $37,833 × 1.5% = $567.495.
        assert_eq!(pool_only(800).total, Adjustment::Subsidy(567_495_000));
        // The tier pays 5%: the pool charges 1.5 points more.
        assert_eq!(pool_only(500).total, Adjustment::Fee(567_495_000));
        // Under the other policies our part is never adjusted.
        let period = Period { elapsed_ns: YEAR, previous: &[], new: &[], pool_debt: POOL_PART, tier_rate_bp: 800 };
        for pricing in [Pricing::PassThrough, MARGIN_120, CAPPED_AT_8] {
            assert_eq!(settlement(&pricing, &year_limits(), &period, |_| None).unwrap().total, Adjustment::Nothing);
        }
    }

    #[test]
    fn a_fee_on_one_part_and_a_subsidy_on_another_net_into_one_total() {
        let both = [aave(), rhea(0)].concat();
        let s = steady(&FIXED_650, &year_limits(), YEAR, &both);
        assert_eq!(s.parts[0].adjustment, Adjustment::Fee(663_003_900));
        assert_eq!(s.parts[1].adjustment, Adjustment::Subsidy(4_767_764_700)); // $50,667 × (15.91% − 6.5%)
        assert_eq!(s.total, Adjustment::Subsidy(4_767_764_700 - 663_003_900));
        assert_eq!(Adjustment::net(7, 7), Adjustment::Nothing);
    }

    #[test]
    fn a_negative_margin_is_a_subsidy_and_the_clients_rate_never_goes_below_zero() {
        let discount = Pricing::Lender { margin_bp: -100, cap_bp: None };
        assert_eq!(client_rate(&discount, 533, 0), 433);
        assert_eq!(steady(&discount, &year_limits(), YEAR, &aave()).parts[0].client_bp, 433);
        assert_eq!(client_rate(&Pricing::Lender { margin_bp: -10_000, cap_bp: None }, 533, 0), 0);
        // A margin and a cap together: the margin applies under the cap, and the cap wins above it.
        let both = Pricing::Lender { margin_bp: 120, cap_bp: Some(800) };
        assert_eq!(client_rate(&both, 533, 410), 653);
        assert_eq!(client_rate(&both, 750, 410), 800);
        assert_eq!(client_rate(&both, 1_591, 410), 800);
    }

    // ---- The three rules, each with the trick it stops (FUNDING.md 13, cases 1 to 3) ----

    #[test]
    fn case_1_borrowing_through_us_and_lending_it_back_earns_nothing() {
        // Without the floor: we subsidise Rhea's 15.91% down to 6.5%, about $4,770 a year. The client deposits the
        // USDC back at Rhea for 10.32% and pockets the 3.82 points between, about $1,930 a year.
        let unprotected = steady(&FIXED_650, &year_limits(), YEAR, &rhea(0));
        assert_eq!(cents(unprotected.total.subsidy()), 476_776);
        assert_eq!(cents(RHEA_PART * (1_032 - 650) / BP), 193_548);

        // With it, the client pays Rhea's deposit rate, so lending the money back earns 10.32% − 10.32% = 0.
        let s = steady(&FIXED_650, &year_limits(), YEAR, &rhea(1_032));
        assert_eq!(s.parts[0].client_bp, 1_032);
        assert_eq!(s.total, Adjustment::Subsidy(2_832_285_300));

        // The floor stops at the lender's own rate: it never turns a subsidy into a fee.
        assert_eq!(client_rate(&FIXED_650, 1_591, 1_700), 1_591);
        assert_eq!(steady(&FIXED_650, &year_limits(), YEAR, &rhea(1_700)).total, Adjustment::Nothing);
        // And it leaves a fee alone, whatever the deposit rate.
        assert_eq!(client_rate(&MARGIN_120, 533, 5_000), 653);
    }

    #[test]
    fn case_2_a_rate_pushed_up_for_a_few_hours_counts_at_the_7_day_average_plus_5_points() {
        // Rhea has averaged 15.91%. One large depositor pulls out and the rate reads 45% for an hour.
        let spike = vec![report(RHEA, RHEA_PART, 4_500, 0)];
        let period = Period { elapsed_ns: HOUR, previous: &spike, new: &spike, pool_debt: 0, tier_rate_bp: 650 };
        let limits = PricingLimits::default();

        let s = settlement(&CAPPED_AT_8, &limits, &period, |_| Some(1_591)).unwrap();
        assert_eq!(s.parts[0].counted_bp, 2_091);
        assert_eq!(s.total, Adjustment::Subsidy(RHEA_PART * (2_091 - 800) / BP / 8_760)); // $0.75 for the hour

        // Uncapped it would have been $2.14: the trick's extra is cut to 5 points' worth.
        let uncapped = PricingLimits { avg_plus_bp: 10_000, ..limits };
        let s = settlement(&CAPPED_AT_8, &uncapped, &period, |_| Some(1_591)).unwrap();
        assert_eq!(s.total, Adjustment::Subsidy(RHEA_PART * (4_500 - 800) / BP / 8_760));

        // A rate at or under the average plus 5 points counts in full.
        assert_eq!(counted_rate(2_091, Some(1_591), &limits), 2_091);
        assert_eq!(counted_rate(1_400, Some(1_591), &limits), 1_400);
    }

    #[test]
    fn a_lenders_rate_never_counts_above_60_percent_and_with_no_history_only_that_applies() {
        let limits = PricingLimits::default();
        assert_eq!(counted_rate(7_500, None, &limits), 6_000);
        assert_eq!(counted_rate(5_900, None, &limits), 5_900);
        assert_eq!(counted_rate(7_500, Some(5_800), &limits), 6_000); // the average plus 5 points is 63%
        assert_eq!(counted_rate(7_500, Some(u32::MAX), &limits), 6_000);

        let dear = vec![report(RHEA, RHEA_PART, 7_500, 0)];
        let s = steady(&FIXED_650, &year_limits(), YEAR, &dear);
        assert_eq!(s.parts[0].counted_bp, 6_000);
        assert_eq!(s.total, Adjustment::Subsidy(RHEA_PART * (6_000 - 650) / BP));
    }

    #[test]
    fn case_3_the_pool_takes_the_smaller_debt_for_a_subsidy_and_the_larger_for_a_fee() {
        // A subsidy: the client shows $50,667 at Rhea when it is settled and held $1,000 in between, or the other
        // way round. Either way the subsidy is worked out on $1,000.
        let (small, large) = (vec![report(RHEA, usd(1_000), 1_591, 0)], rhea(0));
        for (previous, new) in [(&small, &large), (&large, &small)] {
            let s = between(&CAPPED_AT_8, previous, new);
            assert_eq!(s.parts[0].debt, usd(1_000));
            assert_eq!(s.total, Adjustment::Subsidy(usd(1_000) * 791 / BP)); // $79.10, not $4,007.76
        }
        // A fee: the client shows $1,000 at Aave when it is settled and held $56,667 in between, or the other way
        // round. Either way the fee is worked out on $56,667.
        let (small, large) = (vec![report(AAVE, usd(1_000), 533, 410)], aave());
        for (previous, new) in [(&small, &large), (&large, &small)] {
            let s = between(&MARGIN_120, previous, new);
            assert_eq!(s.parts[0].debt, AAVE_PART);
            assert_eq!(s.total, Adjustment::Fee(680_004_000));
        }
    }

    #[test]
    fn a_report_shows_a_borrow_when_the_debt_rose_by_more_than_interest_could_add() {
        let limits = PricingLimits::default();
        let rose = |previous: &[LenderReport], new: &[LenderReport], elapsed_ns| {
            borrowed_since(previous, new, elapsed_ns, limits.max_rate_bp)
        };
        // Five minutes at the 60% limit add at most $0.289 to $50,667: 50,667 × 0.6 × 300 s ÷ a year, rounded up.
        let (five_minutes, most) = (HOUR / 12, 289_196);
        let with = |extra: u128| vec![report(RHEA, RHEA_PART + extra, 1_591, 0)];
        assert!(!rose(&rhea(0), &rhea(0), five_minutes));
        assert!(!rose(&rhea(0), &with(RHEA_PART * 1_591 / BP / 105_120), five_minutes), "Rhea's own interest");
        assert!(!rose(&rhea(0), &with(most), five_minutes));
        assert!(rose(&rhea(0), &with(most + 1), five_minutes));
        assert!(rose(&rhea(0), &with(usd(10_000)), five_minutes));
        // In the same block there is no interest: any rise is a borrow.
        assert!(!rose(&rhea(0), &rhea(0), 0));
        assert!(rose(&rhea(0), &with(1), 0));
        // A repayment is not a borrow, and neither is a lender dropping out of the report.
        assert!(!rose(&rhea(0), &[report(RHEA, usd(1_000), 1_591, 0)], five_minutes));
        assert!(!rose(&rhea(0), &[], five_minutes));
        // A lender new in the report owed nothing before: any debt there is a borrow, a line with none is not.
        assert!(rose(&rhea(0), &[rhea(0), aave()].concat(), five_minutes));
        assert!(rose(&[], &aave(), 0));
        assert!(!rose(&rhea(0), &[rhea(0), vec![report(AAVE, 0, 533, 410)]].concat(), five_minutes));
        // A lender that really charges more than the limit: its own rate sets what interest could add.
        let dear = vec![report(RHEA, RHEA_PART, 30_000, 0)];
        let grown = vec![report(RHEA, RHEA_PART + RHEA_PART * 3 / 105_120, 30_000, 0)]; // 300% for five minutes
        assert!(!rose(&dear, &grown, five_minutes));
        assert!(!rose(&rhea(0), &grown, five_minutes), "the rate in the new report counts as well");
        let same_rise = with(RHEA_PART * 3 / 105_120);
        assert!(rose(&rhea(0), &same_rise, five_minutes), "with Rhea at 15.91% in both, that much is a borrow");
        // An absurd stored debt can't be worked out, so nothing counts as a borrow on top of it.
        assert!(!rose(&[report(RHEA, u128::MAX, 1_591, 0)], &[report(RHEA, u128::MAX, 1_591, 0)], five_minutes));
    }

    #[test]
    fn a_lender_in_only_one_report_owes_nothing_in_the_other() {
        // New in this report: no subsidy for a debt that wasn't reported before, and a fee on what is owed now.
        assert_eq!(between(&CAPPED_AT_8, &[], &rhea(0)).total, Adjustment::Nothing);
        assert_eq!(between(&MARGIN_120, &[], &aave()).total, Adjustment::Fee(680_004_000));
        // Gone from this report: the same, with the previous report's rates.
        assert_eq!(between(&CAPPED_AT_8, &rhea(0), &[]).total, Adjustment::Nothing);
        assert_eq!(between(&MARGIN_120, &aave(), &[]).total, Adjustment::Fee(680_004_000));
        // No lender at all: only our pool's part is listed.
        let s = between(&MARGIN_120, &[], &[]);
        assert_eq!((s.parts.len(), s.parts[0].source.as_str(), s.total), (1, "pool", Adjustment::Nothing));
    }

    #[test]
    fn the_previous_reports_rates_are_the_ones_that_count() {
        let previous = vec![report(RHEA, RHEA_PART, 1_591, 0)];
        let new = vec![report(RHEA, RHEA_PART, 700, 1_500)];
        let s = between(&CAPPED_AT_8, &previous, &new);
        assert_eq!((s.parts[0].counted_bp, s.parts[0].client_bp), (1_591, 800));
        assert_eq!(s.total, Adjustment::Subsidy(4_007_759_700));
    }

    #[test]
    fn a_report_names_aave_and_rhea_once_each_and_lists_aave_first() {
        assert_eq!(report_problem(&[]), None);
        assert_eq!(report_problem(&[rhea(0), aave()].concat()), None);
        let twice = report_problem(&[rhea(0), rhea(0)].concat()).unwrap();
        assert!(twice.contains("names rhea twice"), "{twice}");
        let stranger = report_problem(&[report("compound", 1, 1, 1)]).unwrap();
        assert!(stranger.contains(r#"the lenders are "aave" and "rhea""#), "{stranger}");

        // Whatever order the report came in, the parts are aave, rhea, pool.
        let s = steady(&Pricing::PassThrough, &year_limits(), YEAR, &[rhea(0), aave()].concat());
        assert_eq!(s.parts.iter().map(|p| p.source.as_str()).collect::<Vec<_>>(), ["aave", "rhea", "pool"]);
        // A lender named twice is settled once, on its first line.
        let doubled = [rhea(0), rhea(0)].concat();
        assert_eq!(steady(&CAPPED_AT_8, &year_limits(), YEAR, &doubled).total, Adjustment::Subsidy(4_007_759_700));
    }

    // ---- The period, rounding and overflow ----

    #[test]
    fn a_subsidy_is_cut_at_48_hours_and_a_fee_covers_all_the_time_since_the_last_settlement() {
        let limits = PricingLimits::default();
        let two_days = steady(&CAPPED_AT_8, &limits, 48 * HOUR, &rhea(0));
        assert_eq!((two_days.period_ns, two_days.covered_ns()), (48 * HOUR, 48 * HOUR));
        assert_eq!(two_days.total, Adjustment::Subsidy(RHEA_PART * 791 * 48 / (BP * 8_760)));
        let fee_two_days = steady(&MARGIN_120, &limits, 48 * HOUR, &aave());
        assert_eq!(fee_two_days.total, Adjustment::Fee(3_726_050)); // $680.004 a year × 48 ÷ 8,760, rounded up
        for late in [48 * HOUR + 1, 72 * HOUR, 30 * DAY, u64::MAX] {
            // A late subsidy pays for 48 hours, whatever the gap.
            let subsidy = steady(&CAPPED_AT_8, &limits, late, &rhea(0));
            assert_eq!(
                (subsidy.total, subsidy.period_ns, subsidy.covered_ns()),
                (two_days.total, 48 * HOUR, 48 * HOUR)
            );
            // A late fee is owed for the whole gap (research/audit.md, P5).
            let fee = steady(&MARGIN_120, &limits, late, &aave());
            assert_eq!((fee.fee_period_ns, fee.covered_ns()), (late, late));
            assert!(fee.total.fee() >= fee_two_days.total.fee());
        }
        // Thirty days of the margin: $680.004 a year × 30 ÷ 365, rounded up.
        assert_eq!(steady(&MARGIN_120, &limits, 30 * DAY, &aave()).total, Adjustment::Fee(55_890_740));
        // One settlement can hold both: under a fixed rate Aave's part is a fee and Rhea's a subsidy, each over its
        // own time. Here 96 hours of fee and 48 of subsidy.
        let both = [aave(), rhea(0)].concat();
        let s = steady(&FIXED_650, &limits, 96 * HOUR, &both);
        assert_eq!(s.parts[0].adjustment, Adjustment::Fee((663_003_900u128 * 96).div_ceil(8_760)));
        assert_eq!(s.parts[1].adjustment, Adjustment::Subsidy(4_767_764_700 * 48 / 8_760));
        let just_under = steady(&CAPPED_AT_8, &limits, 48 * HOUR - 1, &rhea(0));
        assert!(just_under.period_ns < two_days.period_ns && just_under.total.subsidy() <= two_days.total.subsidy());
        // No time, nothing to settle.
        assert_eq!(steady(&CAPPED_AT_8, &limits, 0, &rhea(0)).total, Adjustment::Nothing);
        assert_eq!(steady(&MARGIN_120, &limits, 0, &aave()).total, Adjustment::Nothing);
    }

    #[test]
    fn a_lenders_debt_counts_at_no_more_than_a_million_dollars_at_both_ends_of_the_period() {
        let limits = PricingLimits::default();
        assert_eq!(limits.max_lender_debt.0, usd(1_000_000));
        // research/audit.md, P3: a wrong report shows $17.5 trillion owed at Aave.
        let wrong = vec![report(AAVE, usd(17_500_000_000_000), 533, 410)];
        let ten_minutes = HOUR / 6;
        // A fee takes the larger of the two debts. It counts at $1,000,000, at either end or at both: 23 cents for
        // ten minutes of a 1.2-point margin, where the report as it came would have made $3,995,434.
        for (previous, new) in [(&aave(), &wrong), (&wrong, &aave()), (&wrong, &wrong)] {
            let period = Period { elapsed_ns: ten_minutes, previous, new, pool_debt: 0, tier_rate_bp: 650 };
            let s = settlement(&MARGIN_120, &limits, &period, |_| None).unwrap();
            assert_eq!((s.parts[0].debt, s.total), (usd(1_000_000), Adjustment::Fee(228_311)));
        }
        // A subsidy takes the smaller, and that too counts at $1,000,000 when both reports are wrong.
        let wrong = vec![report(RHEA, usd(17_500_000_000_000), 1_591, 0)];
        let period = Period { elapsed_ns: HOUR, previous: &wrong, new: &wrong, pool_debt: 0, tier_rate_bp: 650 };
        let s = settlement(&CAPPED_AT_8, &limits, &period, |_| None).unwrap();
        assert_eq!(
            (s.parts[0].debt, s.total),
            (usd(1_000_000), Adjustment::Subsidy(usd(1_000_000) * 791 / BP / 8_760))
        );
        // A debt under the limit counts as it is, and the operator can move the limit.
        assert_eq!(steady(&MARGIN_120, &limits, HOUR, &aave()).parts[0].debt, AAVE_PART);
        let tight = PricingLimits { max_lender_debt: U128(usd(10_000)), ..Default::default() };
        assert_eq!(steady(&MARGIN_120, &tight, HOUR, &aave()).parts[0].debt, usd(10_000));
        let none = PricingLimits { max_lender_debt: U128(0), ..Default::default() };
        assert_eq!(steady(&MARGIN_120, &none, HOUR, &aave()).total, Adjustment::Nothing);
    }

    #[test]
    fn a_fee_rounds_up_and_a_subsidy_rounds_down_at_one_micro_dollar() {
        let limits = PricingLimits::default();
        let fee = Pricing::Lender { margin_bp: 1, cap_bp: None };
        let subsidy = Pricing::Lender { margin_bp: -1, cap_bp: None };
        let hour = |pricing: &Pricing, debt: u128| steady(pricing, &limits, HOUR, &[report(AAVE, debt, 533, 0)]).total;

        // $87.60 at 1 bp for an hour is exactly one micro-dollar: 87,600,000 ÷ 10,000 ÷ 8,760.
        assert_eq!(hour(&fee, 87_600_000), Adjustment::Fee(1));
        assert_eq!(hour(&subsidy, 87_600_000), Adjustment::Subsidy(1));
        // One micro-dollar more of debt: the fee rounds up to 2 and the subsidy stays at 1.
        assert_eq!(hour(&fee, 87_600_001), Adjustment::Fee(2));
        assert_eq!(hour(&subsidy, 87_600_001), Adjustment::Subsidy(1));
        // One micro-dollar less: the fee is still 1 and the subsidy rounds down to nothing.
        assert_eq!(hour(&fee, 87_599_999), Adjustment::Fee(1));
        assert_eq!(hour(&subsidy, 87_599_999), Adjustment::Nothing);
        // The smallest fee there is: one micro-dollar of debt for one nanosecond still costs a micro-dollar.
        assert_eq!(steady(&fee, &limits, 1, &[report(AAVE, 1, 533, 0)]).total, Adjustment::Fee(1));
        assert_eq!(hour(&fee, 0), Adjustment::Nothing);
    }

    #[test]
    fn property_splitting_a_period_never_earns_the_pool_less_or_pays_the_client_more() {
        let limits = PricingLimits::default();
        for (debt, parts) in [(RHEA_PART, 7u64), (usd(3), 24), (999_999, 5), (123_456_789_012, 48)] {
            let line = [report(RHEA, debt, 1_591, 0)];
            let whole = 24 * HOUR;
            let fee = |ns| steady(&Pricing::Lender { margin_bp: 120, cap_bp: None }, &limits, ns, &line).total.fee();
            let subsidy = |ns| steady(&CAPPED_AT_8, &limits, ns, &line).total.subsidy();
            assert!(u128::from(parts) * fee(whole / parts) + fee(whole % parts) >= fee(whole));
            assert!(u128::from(parts) * subsidy(whole / parts) + subsidy(whole % parts) <= subsidy(whole));
        }
    }

    #[test]
    fn absurd_amounts_are_reported_not_wrapped() {
        // An absurd lender debt counts at `max_lender_debt`, so it only overflows if the operator lifts that limit.
        let absurd = [report(RHEA, u128::MAX, 1_591, 0)];
        let period = Period { elapsed_ns: HOUR, previous: &absurd, new: &absurd, pool_debt: 0, tier_rate_bp: 650 };
        assert!(settlement(&CAPPED_AT_8, &PricingLimits::default(), &period, |_| None).is_some());
        let lifted = PricingLimits { max_lender_debt: U128(u128::MAX), ..Default::default() };
        assert_eq!(settlement(&CAPPED_AT_8, &lifted, &period, |_| None), None);
        let period = Period { elapsed_ns: HOUR, previous: &[], new: &[], pool_debt: u128::MAX, tier_rate_bp: 800 };
        assert_eq!(settlement(&FIXED_650, &PricingLimits::default(), &period, |_| None), None);

        assert_eq!(apply(Adjustment::Fee(1), u128::MAX, 0), None);
        assert_eq!(apply(Adjustment::Subsidy(2), 0, u128::MAX), None);
        assert_eq!(client_rate(&Pricing::Lender { margin_bp: i32::MAX, cap_bp: None }, u32::MAX, 0), u32::MAX);
        assert_eq!(
            counted_rate(u32::MAX, Some(u32::MAX), &PricingLimits { max_rate_bp: u32::MAX, ..year_limits() }),
            u32::MAX
        );
        let greedy = PricingLimits { pool_subsidy_day_bp: 10_000, pool_fee_day_bp: 10_000, ..Default::default() };
        assert_eq!(greedy.pool_subsidy_day(u128::MAX), u128::MAX / BP * BP);
        assert_eq!(greedy.pool_fee_day(u128::MAX), u128::MAX / BP * BP);
    }

    // ---- The limits and the budgets ----

    #[test]
    fn the_default_limits_are_the_specs() {
        let limits = PricingLimits::default();
        assert_eq!((limits.max_rate_bp, limits.avg_plus_bp, limits.pool_subsidy_day_bp), (6_000, 500, 5));
        assert_eq!(limits.max_period_ns, 48 * 3_600 * 1_000_000_000);
        assert_eq!(limits.min_period_ns, 600 * 1_000_000_000);
        assert_eq!((limits.max_lender_debt.0, limits.account_fee_day.0), (usd(1_000_000), usd(1_000)));
        assert_eq!(limits.pool_fee_day_bp, 50);
        assert_eq!(limits.account_subsidy_day.0, usd(100));
        assert_eq!(limits.problem(), None);
        assert_eq!(year_limits().problem(), None);
        assert_eq!(FundingSettings::default(), FundingSettings { order: FundingOrder::Cheapest, loan_days: 90 });
    }

    #[test]
    fn limits_and_policies_are_checked_and_say_what_to_fix() {
        let limits = |change: fn(&mut PricingLimits)| {
            let mut l = PricingLimits::default();
            change(&mut l);
            l.problem().unwrap_or_default()
        };
        assert!(limits(|l| l.max_rate_bp = 10_001).contains("max_rate_bp is capped at 10,000"));
        assert!(limits(|l| l.avg_plus_bp = 10_001).contains("avg_plus_bp is capped at 10,000"));
        assert!(limits(|l| l.max_period_ns = 0).contains("max_period_ns must be between 1 ns and a year"));
        assert!(limits(|l| l.max_period_ns = YEAR + 1).contains("max_period_ns must be between 1 ns and a year"));
        assert!(limits(|l| l.pool_subsidy_day_bp = 10_001).contains("pool_subsidy_day_bp is a share of capital"));
        assert!(limits(|l| l.pool_fee_day_bp = 10_001).contains("pool_fee_day_bp is a share of capital"));
        // The two new amounts may be anything, zero and the largest number included.
        assert_eq!(limits(|l| (l.max_lender_debt, l.account_fee_day) = (U128(0), U128(0))), "");
        assert_eq!(limits(|l| (l.max_lender_debt, l.account_fee_day) = (U128(u128::MAX), U128(u128::MAX))), "");
        assert!(limits(|l| l.min_period_ns = 0).contains("min_period_ns must be between 1 ns and max_period_ns"));
        assert!(limits(|l| l.min_period_ns = 48 * HOUR + 1).contains("min_period_ns must be between 1 ns and"));

        for fine in [Pricing::PassThrough, MARGIN_120, CAPPED_AT_8, FIXED_650, Pricing::Fixed { rate_bp: 10_000 }] {
            assert_eq!(fine.problem(), None);
        }
        let policy = |p: Pricing| p.problem().unwrap_or_default();
        assert!(policy(Pricing::Lender { margin_bp: 10_001, cap_bp: None }).contains("margin_bp must be between"));
        assert!(policy(Pricing::Lender { margin_bp: i32::MIN, cap_bp: None }).contains("margin_bp must be between"));
        assert!(policy(Pricing::Lender { margin_bp: 0, cap_bp: Some(10_001) }).contains("cap_bp is capped"));
        assert!(policy(Pricing::Fixed { rate_bp: 10_001 }).contains("rate_bp is capped"));
        assert_eq!(
            FundingSettings { order: FundingOrder::PoolFirst, loan_days: 0 }.problem(),
            Some("loan_days must be at least 1")
        );
    }

    #[test]
    #[should_panic(expected = "max_period_ns must be between 1 ns and a year")]
    fn limits_that_are_wrong_are_refused() {
        PricingLimits { max_period_ns: 0, ..Default::default() }.assert_valid();
    }

    #[test]
    fn a_subsidy_is_cut_to_what_is_left_of_the_accounts_100_dollars_a_day() {
        let limits = PricingLimits::default();
        let capital = usd(10_000_000); // the pool's budget is $5,000: out of the way
        assert_eq!(cut_subsidy(&limits, usd(30), 0, 0, capital), usd(30));
        assert_eq!(cut_subsidy(&limits, usd(30), usd(70), 0, capital), usd(30));
        assert_eq!(cut_subsidy(&limits, usd(30), usd(80), 0, capital), usd(20));
        assert_eq!(cut_subsidy(&limits, usd(30), usd(100), 0, capital), 0);
        assert_eq!(cut_subsidy(&limits, usd(30), usd(250), 0, capital), 0);
        assert_eq!(cut_subsidy(&limits, usd(100) + 1, 0, 0, capital), usd(100));
        // The worked example's Rhea subsidy is $0.46 an hour, about $11 a day: well inside it.
        assert!(24 * 457_506 < limits.account_subsidy_day.0);
    }

    #[test]
    fn a_subsidy_is_cut_to_what_is_left_of_5_bp_of_the_pools_capital_a_day() {
        let limits = PricingLimits::default();
        assert_eq!(limits.pool_subsidy_day(usd(1_000_000)), usd(500));
        assert_eq!(limits.pool_subsidy_day(usd(100_000)), usd(50));
        assert_eq!(limits.pool_subsidy_day(19_999), 9, "the budget rounds down");
        assert_eq!(limits.pool_subsidy_day(0), 0);

        let capital = usd(100_000);
        assert_eq!(cut_subsidy(&limits, usd(30), 0, usd(20), capital), usd(30));
        assert_eq!(cut_subsidy(&limits, usd(30), 0, usd(45), capital), usd(5));
        assert_eq!(cut_subsidy(&limits, usd(30), 0, usd(50), capital), 0);
        assert_eq!(cut_subsidy(&limits, usd(30), 0, usd(60), capital), 0);
        // Both budgets at once: the tighter one wins.
        assert_eq!(cut_subsidy(&limits, usd(30), usd(90), usd(45), capital), usd(5));
        assert_eq!(cut_subsidy(&limits, usd(30), usd(98), usd(45), capital), usd(2));
        // A pool with no capital pays no subsidy.
        assert_eq!(cut_subsidy(&limits, usd(30), 0, 0, 0), 0);
        assert_eq!(budget_left(10, 4), 6);
        assert_eq!(budget_left(10, 11), 0);
    }

    #[test]
    fn a_fee_is_cut_to_what_is_left_of_the_accounts_1000_dollars_a_day_and_of_50_bp_of_the_pools_capital() {
        let limits = PricingLimits::default();
        // The account's budget, with the pool's out of the way: 50 bp of $10M is $50,000.
        let capital = usd(10_000_000);
        assert_eq!(limits.pool_fee_day(capital), usd(50_000));
        assert_eq!(cut_fee(&limits, usd(300), 0, 0, capital), usd(300));
        assert_eq!(cut_fee(&limits, usd(300), usd(700), 0, capital), usd(300));
        assert_eq!(cut_fee(&limits, usd(300), usd(800), 0, capital), usd(200));
        assert_eq!(cut_fee(&limits, usd(300), usd(1_000), 0, capital), 0);
        assert_eq!(cut_fee(&limits, usd(300), usd(2_500), 0, capital), 0);
        assert_eq!(cut_fee(&limits, usd(1_000) + 1, 0, 0, capital), usd(1_000));
        // The worked example's Aave margin is 7.76 cents an hour, $1.86 a day: far inside it.
        assert!(24 * 77_627 < limits.account_fee_day.0);
        // The pool's budget: 50 bp of $100k is $500 a day, and it rounds down.
        let capital = usd(100_000);
        assert_eq!(limits.pool_fee_day(capital), usd(500));
        assert_eq!(limits.pool_fee_day(19_999), 99);
        assert_eq!(cut_fee(&limits, usd(300), 0, usd(100), capital), usd(300));
        assert_eq!(cut_fee(&limits, usd(300), 0, usd(450), capital), usd(50));
        assert_eq!(cut_fee(&limits, usd(300), 0, usd(500), capital), 0);
        assert_eq!(cut_fee(&limits, usd(300), 0, usd(600), capital), 0);
        // Both at once: the tighter one wins. A pool with no capital books no fee.
        assert_eq!(cut_fee(&limits, usd(300), usd(900), usd(450), capital), usd(50));
        assert_eq!(cut_fee(&limits, usd(300), usd(980), usd(450), capital), usd(20));
        assert_eq!(cut_fee(&limits, usd(300), 0, 0, 0), 0);
    }

    #[test]
    fn a_fee_adds_to_the_debt_and_a_subsidy_takes_it_to_zero_then_becomes_credit() {
        assert_eq!(apply(Adjustment::Nothing, 100, 5), Some((100, 5)));
        assert_eq!(apply(Adjustment::Fee(10), 100, 5), Some((110, 5)));
        assert_eq!(apply(Adjustment::Fee(10), 0, 5), Some((10, 5)));
        assert_eq!(apply(Adjustment::Subsidy(30), 100, 5), Some((70, 5)));
        assert_eq!(apply(Adjustment::Subsidy(100), 100, 5), Some((0, 5)));
        assert_eq!(apply(Adjustment::Subsidy(130), 100, 5), Some((0, 35)));
        assert_eq!(apply(Adjustment::Subsidy(30), 0, 0), Some((0, 30)));
    }

    // ---- The 7-day average ----

    #[test]
    fn the_average_is_of_reports_not_of_time() {
        let mut history = RateHistory::default();
        assert_eq!(history.average(0), None, "no history yet");
        // One day: 10% reported at the first minute and 20% three times in the last hour. By time it was 10% nearly
        // all day; by reports it is 17.5%.
        history.add(60, 1_000);
        for minute in [23 * 60, 23 * 60 + 20, 23 * 60 + 40] {
            history.add(minute * 60 * 1_000_000_000, 2_000);
        }
        assert_eq!(history.average(DAY - 1), Some(1_750));
        // The next day has one report. Each day counts once, however many reports it has: (17.5% + 10%) ÷ 2.
        history.add(DAY + HOUR, 1_000);
        assert_eq!(history.average(DAY + HOUR), Some(1_375));
        // It rounds down, so the limit it sets is never too loose.
        history.add(2 * DAY, 1_001);
        assert_eq!(history.average(2 * DAY), Some(1_250)); // (1,750 + 1,000 + 1,001) ÷ 3 = 1,250.33
    }

    #[test]
    fn a_burst_of_reports_in_one_day_moves_that_days_figure_only() {
        let mut history = RateHistory::default();
        for day in 0..7 {
            history.add(day * DAY, 1_591);
        }
        // Day 7: the rate is pushed to 45% and reported 1,000 times.
        for i in 0..1_000 {
            history.add(7 * DAY + i, 4_500);
        }
        // (7 × 15.91% + 45%) ÷ 8 = 19.55%, so the rate counts at 24.55% at most, not at 45%.
        assert_eq!(history.average(7 * DAY + HOUR), Some(1_954));
        assert_eq!(counted_rate(4_500, history.average(7 * DAY + HOUR), &PricingLimits::default()), 2_454);
    }

    #[test]
    fn the_average_drops_a_report_after_a_week() {
        let mut history = RateHistory::default();
        history.add(DAY - 1, 1_000); // the last moment of day 0
        assert_eq!(history.average(7 * DAY + DAY - 1), Some(1_000), "dropped before 7 days had passed");
        assert_eq!(history.average(8 * DAY), None, "kept past 8 days");

        // Across the boundary: days 0 to 7 report 10%, 11%, … 17%. On day 7 all eight count; on day 8 the first has
        // gone and a new one is in.
        let mut history = RateHistory::default();
        for day in 0..8u64 {
            history.add(day * DAY + HOUR, 1_000 + 100 * day as u32);
        }
        assert_eq!(history.average(7 * DAY + 2 * HOUR), Some(1_350));
        assert_eq!(history.average(8 * DAY), Some(1_400), "day 0 still counted");
        history.add(8 * DAY, 1_800);
        assert_eq!(history.average(8 * DAY), Some(1_450));
        assert_eq!(history.days.len(), 8);
        // After a long silence there is no history again, and only max_rate_bp applies.
        assert_eq!(history.average(30 * DAY), None);
        history.add(30 * DAY, 900);
        assert_eq!((history.days.len(), history.average(30 * DAY)), (1, Some(900)));
    }

    // ---- JSON and storage ----

    #[test]
    fn the_json_forms_are_the_ones_in_interfaces_26() {
        let text = |value: serde_json::Value| value.to_string();
        let to = |pricing: &Pricing| serde_json::to_string(pricing).unwrap();
        assert_eq!(to(&Pricing::PassThrough), r#""pass_through""#);
        assert_eq!(to(&MARGIN_120), r#"{"lender":{"margin_bp":120,"cap_bp":null}}"#);
        assert_eq!(to(&CAPPED_AT_8), r#"{"lender":{"margin_bp":0,"cap_bp":800}}"#);
        assert_eq!(to(&FIXED_650), r#"{"fixed":{"rate_bp":650}}"#);
        for pricing in [Pricing::PassThrough, MARGIN_120, CAPPED_AT_8, FIXED_650] {
            assert_eq!(serde_json::from_str::<Pricing>(&to(&pricing)).unwrap(), pricing);
        }
        // `cap_bp` may be left out, and a negative margin is a plain number.
        assert_eq!(serde_json::from_str::<Pricing>(r#"{"lender":{"margin_bp":120}}"#).unwrap(), MARGIN_120);
        let discount: Pricing = serde_json::from_str(r#"{"lender":{"margin_bp":-50,"cap_bp":null}}"#).unwrap();
        assert_eq!(discount, Pricing::Lender { margin_bp: -50, cap_bp: None });
        assert!(serde_json::from_str::<Pricing>(r#""free""#).is_err());

        for (order, name) in [
            (FundingOrder::Cheapest, "cheapest"),
            (FundingOrder::PoolFirst, "pool_first"),
            (FundingOrder::LenderFirst, "lender_first"),
        ] {
            assert_eq!(serde_json::to_value(order).unwrap(), json!(name));
        }
        let funding = FundingSettings { order: FundingOrder::LenderFirst, loan_days: 90 };
        assert_eq!(serde_json::to_string(&funding).unwrap(), r#"{"order":"lender_first","loan_days":90}"#);
        assert_eq!(
            serde_json::from_str::<FundingSettings>(r#"{"order":"lender_first","loan_days":90}"#).unwrap(),
            funding
        );

        let account: PricingTarget = serde_json::from_str(r#"{"account":"alice.pbf.testnet"}"#).unwrap();
        assert_eq!(account, PricingTarget::Account("alice.pbf.testnet".parse().unwrap()));
        let tier: PricingTarget = serde_json::from_str(r#"{"tier":"STANDARD"}"#).unwrap();
        assert_eq!(tier, PricingTarget::Tier(Tier::Standard));
        assert_eq!(serde_json::to_string(&tier).unwrap(), r#"{"tier":"STANDARD"}"#);
        assert_eq!(serde_json::to_string(&account).unwrap(), r#"{"account":"alice.pbf.testnet"}"#);

        assert_eq!(
            serde_json::to_string(&PricingLimits::default()).unwrap(),
            text(json!({"max_rate_bp": 6000, "avg_plus_bp": 500, "max_period_ns": 172_800_000_000_000u64,
                        "min_period_ns": 600_000_000_000u64, "account_subsidy_day": "100000000",
                        "pool_subsidy_day_bp": 5, "max_lender_debt": "1000000000000",
                        "account_fee_day": "1000000000", "pool_fee_day_bp": 50}))
        );
        // `min_period_ns` may be left out, as INTERFACES.md 26 wrote the limits before it existed: it is 10 minutes.
        let five = r#"{"max_rate_bp":6000,"avg_plus_bp":500,"max_period_ns":172800000000000,
                       "account_subsidy_day":"100000000","pool_subsidy_day_bp":5}"#;
        assert_eq!(serde_json::from_str::<PricingLimits>(five).unwrap(), PricingLimits::default());
        // So may the three limits on a fee (INTERFACES.md 45.1), each on its own: the limits as stage 2 took them
        // still read, with $1,000,000, $1,000 and 50 bp.
        let six = r#"{"max_rate_bp":6000,"avg_plus_bp":500,"max_period_ns":172800000000000,"min_period_ns":120000000000,
                      "account_subsidy_day":"100000000","pool_subsidy_day_bp":5}"#;
        let live = PricingLimits { min_period_ns: 120_000_000_000, ..Default::default() };
        assert_eq!(serde_json::from_str::<PricingLimits>(six).unwrap(), live);
        let one = six.replace(r#""pool_subsidy_day_bp":5"#, r#""pool_subsidy_day_bp":5,"account_fee_day":"250000000""#);
        let expected = PricingLimits { account_fee_day: U128(usd(250)), ..live };
        assert_eq!(serde_json::from_str::<PricingLimits>(&one).unwrap(), expected);
    }

    #[test]
    fn an_accounts_policy_is_its_own_else_its_tiers_else_pass_through_and_the_view_says_which() {
        assert_eq!(policy_for(Some(&FIXED_650), Some(&MARGIN_120)), (FIXED_650, PricingFrom::Account));
        assert_eq!(policy_for(None, Some(&MARGIN_120)), (MARGIN_120, PricingFrom::Tier));
        assert_eq!(policy_for(None, None), (Pricing::PassThrough, PricingFrom::Default));

        let fresh = AccountPricing::default();
        assert_eq!(
            serde_json::to_value(fresh.view(None, 0)).unwrap(),
            json!({"pricing": "pass_through", "from": "default", "fees_charged": "0", "fees_reversed": "0",
                   "subsidy_paid": "0", "credit": "0", "settled_at": "0", "last": []})
        );
        let record = AccountPricing {
            pricing: Some(CAPPED_AT_8),
            last: rhea(1_032),
            settled_at: 1_762_819_200_000_000_000,
            fees_charged: 12,
            subsidy_paid: 457_506,
            credit: 3,
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(record.view(Some(&MARGIN_120), 5)).unwrap(),
            json!({"pricing": {"lender": {"margin_bp": 0, "cap_bp": 800}}, "from": "account", "fees_charged": "12",
                   "fees_reversed": "5", "subsidy_paid": "457506", "credit": "3", "settled_at": "1762819200000000000",
                   "last": [{"lender": "rhea", "debt": "50667000000", "rate_bp": 1591, "supply_bp": 1032}]})
        );
        assert_eq!(serde_json::to_value(fresh.view(Some(&MARGIN_120), 0)).unwrap()["from"], "tier");
    }

    #[test]
    fn the_first_settlement_covers_no_time_and_later_ones_the_time_since() {
        let mut record = AccountPricing::default();
        assert_eq!(record.elapsed_ns(1_762_819_200_000_000_000), 0);
        record.settled_at = 10 * HOUR;
        assert_eq!(record.elapsed_ns(11 * HOUR), HOUR);
        assert_eq!(record.elapsed_ns(9 * HOUR), 0);
    }

    #[test]
    fn the_stored_records_survive_a_round_trip_through_storage() {
        let mut record = AccountPricing {
            pricing: Some(Pricing::Lender { margin_bp: -50, cap_bp: Some(800) }),
            last: [aave(), rhea(1_032)].concat(),
            settled_at: 7 * DAY,
            fees_charged: 680_004_000,
            subsidy_paid: 457_506,
            credit: 9,
            ..Default::default()
        };
        record.subsidy_24h.add(7 * DAY, HOUR, 457_506);
        assert_eq!(borsh::from_slice::<AccountPricing>(&borsh::to_vec(&record).unwrap()).unwrap(), record);

        let mut history = RateHistory::default();
        history.add(DAY, 1_591);
        history.add(2 * DAY, 1_600);
        assert_eq!(borsh::from_slice::<RateHistory>(&borsh::to_vec(&history).unwrap()).unwrap(), history);

        let limits = PricingLimits::default();
        assert_eq!(borsh::from_slice::<PricingLimits>(&borsh::to_vec(&limits).unwrap()).unwrap(), limits);
        let funding = FundingSettings::default();
        assert_eq!(borsh::from_slice::<FundingSettings>(&borsh::to_vec(&funding).unwrap()).unwrap(), funding);
        for target in [PricingTarget::Tier(Tier::Watch), PricingTarget::Account("alice.pbf.testnet".parse().unwrap())] {
            assert_eq!(borsh::from_slice::<PricingTarget>(&borsh::to_vec(&target).unwrap()).unwrap(), target);
        }
    }
}
