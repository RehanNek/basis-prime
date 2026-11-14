//! Pool: the broker-funded USDC pool (PLAN.md 5.1).
//!
//! It lends the broker's capital to client accounts made by our factory. It holds its own limits whatever a verdict
//! says (RISK_ENGINE.md 12.2), so a wrong or compromised risk engine can lend at most a day's budget before the
//! operator pauses.
//!
//! - **Units.** Amounts are in the lending token's smallest unit. The lending token is USDC with 6 decimals (mUSDC on
//!   testnet), so one unit is one micro-USDC, the unit verdicts use. Rates are basis points a year.
//! - **Interest.** Each tier has a borrow index that grows at that tier's rate, updated on every interaction.
//!   Accounts store scaled debt: debt = scaled debt × the tier's index (`math.rs`).
//! - **Rounding** always favours the pool: debt and interest round up, repayments round down.
//! - **Capital** = cash + loans outstanding with interest − credit owed to accounts. A write-off removes the loan,
//!   so capital falls by it.
//! - **Pricing** (FUNDING.md 5; INTERFACES.md 26). When part of a client's loan comes from an outside lender, the
//!   operator's policy says what the client pays on it, and `settle` books the difference on the client's debt here:
//!   a fee adds to it, a subsidy comes off it, and what is left of a subsidy once that debt is zero is credit the
//!   account can claim. Pricing has its own map, so no borrower record changes shape.
//!
//! This file has the state, funding, borrowing and repaying, plan steps, links and write-offs. The operator's
//! settings are in `admin.rs`, the views in `views.rs`, the pricing maths in `pricing.rs`, and settling and credit in
//! `settle.rs`.
//!
//! Upgrading from stage 2 (the code on testnet since 11 Nov, `c4641c0e…`): deploy this code with the init call
//! `migrate({})`, in one transaction. It keeps everything the pool holds, the pricing limits and every pricing
//! record included, and adds what bounds a settlement's fee (INTERFACES.md 45.1): three limits at their defaults,
//! the fee windows and the reversed-fee totals, all empty.
use std::collections::BTreeMap;

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json;
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{
    assert_one_yocto, env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

mod admin;
mod events;
pub mod math;
/// Phase 6: the pricing types and maths, as pure functions.
pub mod pricing;
mod settle;
mod types;
mod views;
pub mod window;

#[cfg(test)]
mod tests;

use events::Event;
use math::{BP, WAD};
use pricing::{AccountFees, AccountPricing, FundingSettings, Pricing, PricingLimits};
pub use types::*;
use window::Window;

/// The loan goes out with `ft_transfer_call`; the token keeps about 10 TGas and gives the rest to the account's
/// `ft_on_transfer`.
const GAS_FOR_LOAN: Gas = Gas::from_tgas(75);
const GAS_FOR_DEFUND: Gas = Gas::from_tgas(15);
const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(15);
/// `register` prepays this much storage beyond the new record, so the record can grow (the verdict's book data, the
/// 24-hour step log) without the pool paying for it.
const RECORD_HEADROOM_BYTES: u64 = 1_200;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const LOAN_MSG: &str = r#"{"pb":{"loan":{}}}"#;

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> U128;
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Borrowers,
    Entities,
    HlLinks,
    Cosigns,
    StepPrices,
    Coins,
    Versions,
    Pricing,
    /// Added last (INTERFACES.md 45.1), so no live prefix moves.
    Fees,
}

/// One registered account, as the pool keeps it.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Borrower {
    created_at: u64,
    /// The pool's tier history: the tier from the last verdict it accepted (none before the first borrow).
    tier: Option<Tier>,
    last_upgrade_at: Option<u64>,
    kyb_entity: Option<String>,
    tier_override: Option<TierOverride>,
    blocked: bool,
    hl_address: Option<String>,
    /// The tier whose index the debt grows on, and the scaled debt.
    debt_tier: Tier,
    scaled: u128,
    /// The book data from the last borrow verdict (only tokens the pool has caps for).
    shares_bp: Vec<(String, u32)>,
    hold: Vec<(String, u128)>,
    hl_eq: u128,
    /// This account's part of the Hyperliquid exposure, in scaled units: min(scaled debt, Hyperliquid equity).
    hl_scaled: u128,
    /// Plan steps over the last 24 hours, in micro-USDC.
    steps: Window,
}

impl Borrower {
    fn new(now: u64) -> Self {
        Self {
            created_at: now,
            tier: None,
            last_upgrade_at: None,
            kyb_entity: None,
            tier_override: None,
            blocked: false,
            hl_address: None,
            debt_tier: Tier::Standard,
            scaled: 0,
            shares_bp: Vec::new(),
            hold: Vec::new(),
            hl_eq: 0,
            hl_scaled: 0,
            steps: Window::default(),
        }
    }

    fn debt(&self, index: &[u128; 3]) -> u128 {
        ok(math::debt(self.scaled, index[self.debt_tier.index()]))
    }

    /// As `debt`, for callbacks, which must not panic.
    fn debt_or_max(&self, index: &[u128; 3]) -> u128 {
        math::debt(self.scaled, index[self.debt_tier.index()]).unwrap_or(u128::MAX)
    }

    fn active_override(&self, now: u64) -> Option<&TierOverride> {
        self.tier_override.as_ref().filter(|o| now < o.expires_at.0)
    }

    /// The tier that applies now: an unexpired override, else the tier history (Standard before the first verdict).
    /// Preferred needs the KYB flag in every case.
    fn tier_now(&self, now: u64) -> Tier {
        let tier = match self.active_override(now) {
            Some(o) => o.tier,
            None => self.tier.unwrap_or(Tier::Standard),
        };
        if tier == Tier::Preferred && self.kyb_entity.is_none() {
            Tier::Standard
        } else {
            tier
        }
    }
}

/// The book-level totals the 12.1 caps compare: loans resting on each bridged token and on Hyperliquid, and the
/// NEAR-side holdings of accounts with a loan.
struct Book {
    wrappers: BTreeMap<String, u128>,
    hl: u128,
    hold: BTreeMap<String, u128>,
}

/// One borrow's numbers, worked out once and read by every limit.
struct Borrowing<'a> {
    account_id: &'a AccountId,
    amount: u128,
    tier: Tier,
    now: u64,
    /// The pool's capital, which a borrow doesn't change.
    capital: u128,
    /// The pool's loans, the account's debt, and its client's debt (with its KYB entity), each after the borrow.
    loans_after: u128,
    debt_after: u128,
    client_after: u128,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct TransferMsg {
    pool: TransferAction,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", rename_all = "lowercase")]
enum TransferAction {
    Fund,
    Repay,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Pool {
    operator: AccountId,
    factory: AccountId,
    token: AccountId,
    periods: Periods,
    rates: Rates,
    caps: Caps,
    budget_bp: u32,
    pending_budget: Option<PendingBudget>,
    paused: bool,

    cash: u128,
    funded: u128,
    defunded: u128,
    written_off: u128,

    /// Per tier (Preferred, Standard, Watch): the borrow index and the total scaled debt.
    index: [u128; 3],
    scaled: [u128; 3],
    accrued_at: u64,

    /// Loans made minus repayments, over the rolling 24 hours.
    lent: Window,
    /// Per bridged token and tier: Σ scaled debt × the token's share of collateral.
    wrapper_scaled: BTreeMap<String, [u128; 3]>,
    /// Per tier: Σ min(scaled debt, Hyperliquid equity in scaled units).
    hl_scaled: [u128; 3],
    /// Per NEAR token: holdings of accounts with a loan, in micro-USDC.
    book_hold: BTreeMap<String, u128>,

    borrowers: LookupMap<AccountId, Borrower>,
    /// Per KYB entity id: the scaled debt of its accounts, per tier.
    entities: LookupMap<String, [u128; 3]>,
    /// Hyperliquid address (lower-case) → the one account that linked it.
    hl_links: LookupMap<String, AccountId>,
    cosigns: LookupSet<CosignRequest>,
    step_prices: LookupMap<AccountId, StepPrice>,
    coins: IterableMap<String, CoinState>,
    versions: LookupMap<String, Vec<ProgramVersion>>,

    // Pricing (FUNDING.md 5; INTERFACES.md 26), since stage 2.
    /// The order the engine fills a loan's sources in, and how long a loan is expected to last.
    funding: FundingSettings,
    pricing_limits: PricingLimits,
    /// Per tier (Preferred, Standard, Watch): the policy of accounts that have none of their own.
    tier_pricing: [Option<Pricing>; 3],
    /// Fees added to debts and subsidies given, since the start, and the subsidies over the rolling 24 hours.
    fees_charged: u128,
    subsidy_paid: u128,
    subsidy_24h: Window,
    /// What the pool owes accounts: subsidy left over once a debt was zero, until the account claims it.
    credit: u128,
    /// Each account's own policy and settlement record.
    pricing: LookupMap<AccountId, AccountPricing>,

    // What bounds a settlement's fee (INTERFACES.md 45.1). `migrate` adds everything below to the stage 2 state.
    /// Fees booked over the rolling 24 hours, against `pool_fee_day_bp` of capital.
    fee_24h: Window,
    /// Fees the operator took back with `reverse_fee`, since the start.
    fees_reversed: u128,
    /// Each account's fees over the rolling 24 hours and its reversed fees, in a map of its own so that no stored
    /// pricing record changes shape.
    fees: LookupMap<AccountId, AccountFees>,
}

/// The pricing limits as the stage 2 code stored them: without the three that bound a fee.
#[near(serializers = [borsh])]
struct LimitsStage2 {
    max_rate_bp: u32,
    avg_plus_bp: u32,
    max_period_ns: u64,
    min_period_ns: u64,
    account_subsidy_day: U128,
    pool_subsidy_day_bp: u32,
}

/// The state of the stage 2 code, which `pool.pbf.testnet` holds until `migrate`.
#[near(serializers = [borsh])]
struct PoolStage2 {
    operator: AccountId,
    factory: AccountId,
    token: AccountId,
    periods: Periods,
    rates: Rates,
    caps: Caps,
    budget_bp: u32,
    pending_budget: Option<PendingBudget>,
    paused: bool,
    cash: u128,
    funded: u128,
    defunded: u128,
    written_off: u128,
    index: [u128; 3],
    scaled: [u128; 3],
    accrued_at: u64,
    lent: Window,
    wrapper_scaled: BTreeMap<String, [u128; 3]>,
    hl_scaled: [u128; 3],
    book_hold: BTreeMap<String, u128>,
    borrowers: LookupMap<AccountId, Borrower>,
    entities: LookupMap<String, [u128; 3]>,
    hl_links: LookupMap<String, AccountId>,
    cosigns: LookupSet<CosignRequest>,
    step_prices: LookupMap<AccountId, StepPrice>,
    coins: IterableMap<String, CoinState>,
    versions: LookupMap<String, Vec<ProgramVersion>>,
    funding: FundingSettings,
    pricing_limits: LimitsStage2,
    tier_pricing: [Option<Pricing>; 3],
    fees_charged: u128,
    subsidy_paid: u128,
    subsidy_24h: Window,
    credit: u128,
    pricing: LookupMap<AccountId, AccountPricing>,
}

#[near]
impl Pool {
    /// `token` is the lending token (6 decimals). `periods` defaults to the spec's (7 days, 30 days, 48 hours,
    /// 24 hours) and can't change later.
    #[init]
    pub fn new(operator: AccountId, factory: AccountId, token: AccountId, periods: Option<Periods>) -> Self {
        let periods = periods.unwrap_or_default();
        periods.assert_valid();
        Self {
            operator,
            factory,
            token,
            periods,
            rates: Rates::default(),
            caps: Caps::default(),
            budget_bp: 1_000,
            pending_budget: None,
            paused: false,
            cash: 0,
            funded: 0,
            defunded: 0,
            written_off: 0,
            index: [WAD; 3],
            scaled: [0; 3],
            accrued_at: env::block_timestamp(),
            lent: Window::default(),
            wrapper_scaled: BTreeMap::new(),
            hl_scaled: [0; 3],
            book_hold: BTreeMap::new(),
            borrowers: LookupMap::new(StorageKey::Borrowers),
            entities: LookupMap::new(StorageKey::Entities),
            hl_links: LookupMap::new(StorageKey::HlLinks),
            cosigns: LookupSet::new(StorageKey::Cosigns),
            step_prices: LookupMap::new(StorageKey::StepPrices),
            coins: IterableMap::new(StorageKey::Coins),
            versions: LookupMap::new(StorageKey::Versions),
            funding: FundingSettings::default(),
            pricing_limits: PricingLimits::default(),
            tier_pricing: [None, None, None],
            fees_charged: 0,
            subsidy_paid: 0,
            subsidy_24h: Window::default(),
            credit: 0,
            pricing: LookupMap::new(StorageKey::Pricing),
            fee_24h: Window::default(),
            fees_reversed: 0,
            fees: LookupMap::new(StorageKey::Fees),
        }
    }

    /// Moves the stage 2 state to this one. Everything the pool holds stays as it is: the operator, the settings,
    /// the cash, every borrower's record and debt, the funding order, the pricing limits it has, every tier's and
    /// account's policy, every pricing record, the fees, subsidies and credit. It adds what bounds a settlement's
    /// fee (INTERFACES.md 45.1): the three new limits at their defaults ($1,000,000 of a lender's debt counted, $1,000
    /// of fees a day per account, 0.5% of capital a day for the pool), and the fee windows and reversed-fee totals,
    /// empty. The pool account only, in the same transaction as the code upgrade. It refuses any other state, so it
    /// can't run twice.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: PoolStage2 = env::state_read().unwrap_or_else(|| env::panic_str("no pool state to migrate"));
        log!("migrated the pool: a settlement's fee now has daily limits, and the operator can take a wrong one back");
        let new = PricingLimits::default();
        let pricing_limits = PricingLimits {
            max_rate_bp: old.pricing_limits.max_rate_bp,
            avg_plus_bp: old.pricing_limits.avg_plus_bp,
            max_period_ns: old.pricing_limits.max_period_ns,
            min_period_ns: old.pricing_limits.min_period_ns,
            account_subsidy_day: old.pricing_limits.account_subsidy_day,
            pool_subsidy_day_bp: old.pricing_limits.pool_subsidy_day_bp,
            max_lender_debt: new.max_lender_debt,
            account_fee_day: new.account_fee_day,
            pool_fee_day_bp: new.pool_fee_day_bp,
        };
        Self {
            operator: old.operator,
            factory: old.factory,
            token: old.token,
            periods: old.periods,
            rates: old.rates,
            caps: old.caps,
            budget_bp: old.budget_bp,
            pending_budget: old.pending_budget,
            paused: old.paused,
            cash: old.cash,
            funded: old.funded,
            defunded: old.defunded,
            written_off: old.written_off,
            index: old.index,
            scaled: old.scaled,
            accrued_at: old.accrued_at,
            lent: old.lent,
            wrapper_scaled: old.wrapper_scaled,
            hl_scaled: old.hl_scaled,
            book_hold: old.book_hold,
            borrowers: old.borrowers,
            entities: old.entities,
            hl_links: old.hl_links,
            cosigns: old.cosigns,
            step_prices: old.step_prices,
            coins: old.coins,
            versions: old.versions,
            funding: old.funding,
            pricing_limits,
            tier_pricing: old.tier_pricing,
            fees_charged: old.fees_charged,
            subsidy_paid: old.subsidy_paid,
            subsidy_24h: old.subsidy_24h,
            credit: old.credit,
            pricing: old.pricing,
            fee_24h: Window::default(),
            fees_reversed: 0,
            fees: LookupMap::new(StorageKey::Fees),
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Funding (the operator only) and repaying (accounts), both by `ft_transfer_call` of the lending token.
    // ---------------------------------------------------------------------------------------------------------

    /// Receives the lending token. `msg` is `{"pool":"fund"}` (the operator adds capital) or `{"pool":"repay"}` (an
    /// account repays its loan; repaying is never paused, and anything above the debt is returned). Anything else is
    /// refused, and the token returns it.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token, "the pool accepts only its lending token");
        let request: TransferMsg = serde_json::from_str(&msg)
            .unwrap_or_else(|_| env::panic_str(r#"msg must be {"pool":"fund"} or {"pool":"repay"}"#));
        let unused = match request.pool {
            TransferAction::Fund => {
                self.fund(sender_id, amount.0);
                0
            }
            TransferAction::Repay => self.repay(sender_id, amount.0),
        };
        PromiseOrValue::Value(U128(unused))
    }

    /// The operator takes capital back, up to the pool's free cash: its cash less the credit it owes accounts.
    /// Lent-out money only comes back as repayments.
    #[payable]
    pub fn defund(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        self.assert_operator();
        require!(amount.0 > 0, "amount must be positive");
        require!(amount.0 <= self.free_cash(), "defund is limited to the pool's free cash");
        self.accrue();
        self.cash -= amount.0;
        self.defunded += amount.0;
        Event::Defund { amount }.emit();
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_DEFUND)
            .ft_transfer(self.operator.clone(), amount, Some("defund".to_string()))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_CALLBACK).on_defunded(amount))
    }

    /// Puts the cash back if the transfer to the operator failed. Never panics.
    #[private]
    pub fn on_defunded(&mut self, amount: U128, #[callback_result] sent: Result<(), PromiseError>) -> bool {
        if sent.is_ok() {
            return true;
        }
        self.cash = self.cash.saturating_add(amount.0);
        self.defunded = self.defunded.saturating_sub(amount.0);
        Event::DefundFailed { amount }.emit();
        false
    }

    // ---------------------------------------------------------------------------------------------------------
    // Borrowers
    // ---------------------------------------------------------------------------------------------------------

    /// The factory registers each account it creates, which starts the account's first week. Attach enough NEAR for
    /// the account's record (about 0.014 NEAR); the rest is refunded.
    #[payable]
    pub fn register(&mut self, account_id: AccountId) {
        require!(env::predecessor_account_id() == self.factory, "only the factory can register accounts");
        require!(!self.borrowers.contains_key(&account_id), "this account is already registered");
        let before = env::storage_usage();
        self.borrowers.insert(account_id.clone(), Borrower::new(env::block_timestamp()));
        self.borrowers.flush();
        charge_storage(before, RECORD_HEADROOM_BYTES);
        Event::Register { account_id: &account_id }.emit();
    }

    /// Lends `amount` to the calling account. The account contract calls this with its fresh `borrow` verdict; the
    /// pool then applies its own limits (PLAN.md 5.1), the RISK_ENGINE.md 12.2 limits first and the 12.1 book limits
    /// last, and sends the USDC with `ft_transfer_call` and msg `{"pb":{"loan":{}}}`. If the account doesn't take
    /// the money, the loan is undone. Attach 1 yoctoNEAR and at least 110 TGas.
    #[payable]
    pub fn borrow(&mut self, amount: U128, verdict: BorrowVerdict) -> Promise {
        assert_one_yocto();
        require!(!self.paused, "the pool is paused: no new loans");
        let account_id = env::predecessor_account_id();
        let mut b = self.borrower(&account_id);
        require!(!b.blocked, "this account is blocked after a write-off");
        let amount = amount.0;
        require!(amount > 0, "amount must be positive");
        require!(amount <= verdict.allow_borrow.0, "amount is above the verdict's borrow allowance");
        verdict.assert_valid();

        let now = env::block_timestamp();
        self.accrue();
        self.apply_pending_budget(now);
        // A borrow moves cash into loans, so capital is the same before and after it.
        let capital = self.capital(&self.index);
        let loans_after = ok(self.loans(&self.index).checked_add(amount));
        let before = self.book(&self.index);

        // Book the loan, then check every limit on the result. Any refusal panics, which undoes all of it.
        self.detach(&b);
        self.apply_verdict_tier(&mut b, verdict.tier, now);
        let tier = b.tier_now(now);
        self.move_debt(&mut b, tier);
        let debt_before = b.debt(&self.index);
        let debt_after = ok(debt_before.checked_add(amount));
        let client_after = ok(self.rest_of_entity(&b).checked_add(debt_after));
        let added = ok(math::scaled_for_loan(amount, self.index[tier.index()]));
        b.scaled = ok(b.scaled.checked_add(added));
        b.shares_bp = only_capped(&verdict.shares_bp, &self.caps.wrapper_cap_bp, |bp| bp);
        b.hold = only_capped(&verdict.hold, &self.caps.book_cap, |held: U128| held.0);
        b.hl_eq = verdict.hl_eq.0;
        self.attach(&mut b);
        require!(amount <= self.free_cash(), "the pool doesn't have that much cash");
        self.cash -= amount;
        self.lent.add(now, self.periods.bucket_ns(), to_i128(amount));

        let x =
            Borrowing { account_id: &account_id, amount, tier, now, capital, loans_after, debt_after, client_after };
        self.check_own_limits(&b, &x);
        self.check_book_limits(&verdict, &before, &x);

        let debt = b.debt(&self.index);
        self.borrowers.insert(account_id.clone(), b);
        self.note_pool_debt(&account_id, debt_before, debt);
        Event::Borrow { account_id: &account_id, amount: U128(amount), tier, debt: U128(debt) }.emit();
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_LOAN)
            .ft_transfer_call(account_id.clone(), U128(amount), None, LOAN_MSG.to_string())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_CALLBACK).on_lent(
                account_id,
                U128(amount),
                U128(added),
                tier,
                U64(now),
            ))
    }

    /// Undoes whatever part of a loan the account didn't take (the token returned it to the pool). Never panics.
    #[private]
    pub fn on_lent(
        &mut self,
        account_id: AccountId,
        amount: U128,
        scaled: U128,
        tier: Tier,
        lent_at: U64,
        #[callback_result] used: Result<U128, PromiseError>,
    ) -> U128 {
        let used = used.map(|u| u.0.min(amount.0)).unwrap_or(0);
        let returned = amount.0 - used;
        if returned > 0 {
            self.cash = self.cash.saturating_add(returned);
            self.lent.undo(lent_at.0, self.periods.bucket_ns(), to_i128(returned));
            if let Some(mut b) = self.borrowers.get(&account_id).cloned() {
                let debt_before = b.debt_or_max(&self.index);
                self.detach(&b);
                let cleared = if b.debt_tier == tier {
                    math::mul_div_floor(scaled.0, returned, amount.0).unwrap_or(scaled.0)
                } else {
                    math::scaled_for_repayment(returned, self.index[b.debt_tier.index()]).unwrap_or(0)
                };
                b.scaled = b.scaled.saturating_sub(cleared);
                self.attach(&mut b);
                let debt = b.debt_or_max(&self.index);
                self.borrowers.insert(account_id.clone(), b);
                self.note_pool_debt(&account_id, debt_before, debt);
            }
            Event::LoanReturned { account_id: &account_id, amount: U128(returned) }.emit();
        }
        U128(used)
    }

    /// Records the Hyperliquid address the calling account's owner has proved is theirs (the account contract checks
    /// the signature). Refused if another account linked it first, so one good record can't lift many accounts. An
    /// address stays reserved to the account that linked it. Attach about 0.002 NEAR for storage; the rest is
    /// refunded.
    #[payable]
    pub fn link(&mut self, hl_address: String) {
        let account_id = env::predecessor_account_id();
        let mut b = self.borrower(&account_id);
        let address = hl_address.to_ascii_lowercase();
        require!(
            address.len() == 42 && address.starts_with("0x") && address[2..].bytes().all(|c| c.is_ascii_hexdigit()),
            "hl_address must be 0x followed by 40 hex characters"
        );
        let before = env::storage_usage();
        match self.hl_links.get(&address) {
            Some(owner) => {
                require!(owner == &account_id, "this Hyperliquid address is already linked to another account")
            }
            None => {
                self.hl_links.insert(address.clone(), account_id.clone());
            }
        }
        b.hl_address = Some(address.clone());
        self.borrowers.insert(account_id.clone(), b);
        self.borrowers.flush();
        self.hl_links.flush();
        charge_storage(before, 0);
        Event::Link { account_id: &account_id, hl_address: &address }.emit();
    }

    /// The account contract calls this before every plan step except a repayment. It refuses while the pool is
    /// paused, and refuses a step that would take the account's total for the last 24 hours past $50k unless the
    /// operator co-signed this exact step. Steps in other tokens count at the operator's step prices. A refusal
    /// panics, so the account's callback sees a failed promise.
    pub fn check_step(&mut self, plan_id: String, step: u32, token: AccountId, amount: U128) {
        require!(!self.paused, "the pool is paused: plan steps wait");
        let account_id = env::predecessor_account_id();
        let mut b = self.borrower(&account_id);
        require!(!b.blocked, "this account is blocked after a write-off");
        require!(plan_id.len() <= MAX_NAME, "plan_id is too long");
        let value = self.step_value(&token, amount.0);
        let now = env::block_timestamp();
        let bucket = self.periods.bucket_ns();
        let total = u128::try_from(b.steps.total(now, bucket)).unwrap_or(0).saturating_add(value);
        if total > self.caps.cosign_steps_above.0 {
            let request =
                CosignRequest::Step { account_id: account_id.clone(), plan_id: plan_id.clone(), step, token, amount };
            require!(
                self.cosigns.remove(&request),
                "plan steps past the 24-hour limit ($50k) need the operator's co-signature"
            );
        }
        b.steps.add(now, bucket, to_i128(value));
        self.borrowers.insert(account_id.clone(), b);
        Event::Step { account_id: &account_id, plan_id: &plan_id, step, value: U128(value), total_24h: U128(total) }
            .emit();
    }

    /// Writes off an account's remaining debt after a DEFAULT verdict (PLAN.md 5.1): the loss comes out of capital, the
    /// account is blocked from borrowing, and the event is public. The account contract calls it for itself; the
    /// operator can too. Credit the pool owes the account comes off the loss first: the pool doesn't pay credit to
    /// an account whose debt it writes off.
    pub fn write_off(&mut self, account_id: AccountId) {
        let caller = env::predecessor_account_id();
        require!(
            caller == account_id || caller == self.operator,
            "only the account itself or the operator can write it off"
        );
        let mut b = self.borrower(&account_id);
        self.accrue();
        self.detach(&b);
        let debt = b.debt(&self.index);
        require!(debt > 0, "nothing to write off");
        b.scaled = 0;
        b.blocked = true;
        self.attach(&mut b);
        self.borrowers.insert(account_id.clone(), b);
        self.note_pool_debt(&account_id, debt, 0);
        let loss = debt - self.take_credit(&account_id, debt);
        self.written_off += loss;
        Event::WriteOff { account_id: &account_id, amount: U128(loss) }.emit();
    }
}

// -------------------------------------------------------------------------------------------------------------
// Internal helpers
// -------------------------------------------------------------------------------------------------------------

impl Pool {
    fn assert_operator(&self) {
        require!(env::predecessor_account_id() == self.operator, "only the operator can do this");
    }

    fn borrower(&self, account_id: &AccountId) -> Borrower {
        self.borrowers.get(account_id).cloned().unwrap_or_else(|| env::panic_str("not a registered account"))
    }

    fn fund(&mut self, sender_id: AccountId, amount: u128) {
        require!(sender_id == self.operator, "only the operator can fund the pool");
        self.accrue();
        self.cash = ok(self.cash.checked_add(amount));
        self.funded = ok(self.funded.checked_add(amount));
        Event::Fund { amount: U128(amount) }.emit();
    }

    /// Repays up to the account's debt and returns the unused part.
    fn repay(&mut self, account_id: AccountId, amount: u128) -> u128 {
        let mut b = self.borrower(&account_id);
        let now = env::block_timestamp();
        self.accrue();
        self.detach(&b);
        let tier = b.tier_now(now);
        self.move_debt(&mut b, tier);
        let debt = b.debt(&self.index);
        let used = if amount >= debt {
            b.scaled = 0;
            debt
        } else {
            b.scaled -= ok(math::scaled_for_repayment(amount, self.index[b.debt_tier.index()]));
            amount
        };
        self.attach(&mut b);
        let debt_after = b.debt(&self.index);
        self.borrowers.insert(account_id.clone(), b);
        self.note_pool_debt(&account_id, debt, debt_after);
        self.cash = ok(self.cash.checked_add(used));
        self.lent.add(now, self.periods.bucket_ns(), -to_i128(used));
        if used > 0 {
            Event::Repay { account_id: &account_id, amount: U128(used) }.emit();
        }
        amount - used
    }

    /// The tier rule (PLAN.md 5.1): the pool keeps its own tier history. A downgrade applies at once; an upgrade at
    /// most once per 30 days; Preferred only with the KYB flag; and an unexpired override wins. A verdict that claims a
    /// better tier than this allows is refused, because its credit line was worked out for that tier.
    fn apply_verdict_tier(&self, b: &mut Borrower, claimed: Tier, now: u64) {
        if let Some(o) = b.active_override(now) {
            require!(!claimed.is_better_than(o.tier), "the verdict's tier is above the operator's override");
            return;
        }
        require!(
            claimed != Tier::Preferred || b.kyb_entity.is_some(),
            "a Preferred tier needs the operator's KYB flag"
        );
        match b.tier {
            Some(current) if claimed.is_better_than(current) => {
                if let Some(at) = b.last_upgrade_at {
                    require!(now >= at.saturating_add(self.periods.upgrade_ns.0), "only one tier upgrade per 30 days");
                }
                b.last_upgrade_at = Some(now);
                b.tier = Some(claimed);
            }
            // The first tier, the same tier, or a downgrade, which applies at once.
            _ => b.tier = Some(claimed),
        }
    }

    /// The RISK_ENGINE.md 12.2 limits, which rely on nothing the engine says.
    fn check_own_limits(&mut self, b: &Borrower, x: &Borrowing) {
        if x.now < b.created_at.saturating_add(self.periods.new_account_ns.0) {
            require!(
                x.debt_after <= self.caps.new_account_limit.0,
                "first-week limit: a new account can owe at most $25k in its first 7 days"
            );
        }
        require!(
            x.client_after <= self.caps.ceiling.get(x.tier).0,
            "tier ceiling: the client would owe more than its tier allows"
        );
        if x.amount > self.caps.cosign_borrow_above.0 {
            let request = CosignRequest::Borrow { account_id: x.account_id.clone(), amount: U128(x.amount) };
            require!(self.cosigns.remove(&request), "a borrow above $250k needs the operator's co-signature");
        }
        let budget = ok(math::mul_div_floor(x.capital, u128::from(self.budget_bp), BP));
        require!(
            self.lent.total(x.now, self.periods.bucket_ns()) <= to_i128(budget),
            "daily budget: loans minus repayments over 24 hours would pass 10% of capital"
        );
        require!(
            ok(x.loans_after.checked_mul(BP)) <= ok(x.capital.checked_mul(self.caps.max_utilisation_bp.into())),
            "utilisation limit: the pool would be more than 90% lent out"
        );
    }

    /// The per-client and book limits (PLAN.md 5.1; RISK_ENGINE.md 12.1), which use the verdict's book data. A cap
    /// already passed (say, after a defund) only blocks borrows that would add to it.
    fn check_book_limits(&self, verdict: &BorrowVerdict, before: &Book, x: &Borrowing) {
        let share_of_capital = |bp: u32| ok(math::mul_div_floor(x.capital, bp.into(), BP));
        require!(
            x.client_after <= share_of_capital(self.caps.client_share_bp),
            "one-client limit: the client (with its KYB entity's other accounts) would owe more than 25% of capital"
        );
        for (token, bp) in &verdict.shares_bp {
            if *bp > 0 && self.coins.get(token).is_some_and(|c| c.status == CoinStatus::Frozen) {
                env::panic_str(&format!("{token} is frozen: no new loan may rest on it"));
            }
        }
        let after = self.book(&self.index);
        let within = |cap: u128, was: u128, now: u128| now <= cap || now <= was;
        for (token, bp) in &self.caps.wrapper_cap_bp {
            let (was, now) = (amount_of(&before.wrappers, token), amount_of(&after.wrappers, token));
            require!(
                within(share_of_capital(*bp), was, now),
                format!("bridged-token cap: loans resting on {token} would pass its share of capital")
            );
        }
        require!(
            within(share_of_capital(self.caps.hl_cap_bp), before.hl, after.hl),
            "Hyperliquid cap: loans resting on Hyperliquid balances would pass 50% of capital"
        );
        for (token, cap) in &self.caps.book_cap {
            let (was, now) = (amount_of(&before.hold, token), amount_of(&after.hold, token));
            require!(
                within(cap.0, was, now),
                format!(
                    "NEAR-side book cap: accounts with a loan would hold more {token} than 1Click can sell in 24 hours"
                )
            );
        }
    }

    fn step_value(&self, token: &AccountId, amount: u128) -> u128 {
        if token == &self.token {
            return amount;
        }
        let price =
            self.step_prices.get(token).unwrap_or_else(|| env::panic_str("no step price is set for this token"));
        ok(math::mul_div_ceil(amount, price.price.0, 10u128.pow(price.decimals.into())))
    }

    // Interest.

    /// Brings every tier's index up to now, at the rates the utilisation set since the last update.
    fn accrue(&mut self) {
        let now = env::block_timestamp();
        self.index = self.indices_at(now);
        self.accrued_at = self.accrued_at.max(now);
    }

    /// The indices as they stand at `now`, without saving them (the views use this).
    fn indices_at(&self, now: u64) -> [u128; 3] {
        let dt = u128::from(now.saturating_sub(self.accrued_at));
        let rates = self.rates_wad(&self.index);
        let mut index = self.index;
        for (i, rate) in index.iter_mut().zip(rates) {
            *i = ok(math::grow_index(*i, rate, dt));
        }
        index
    }

    /// Each tier's rate a year (WAD) at the utilisation these indices imply.
    fn rates_wad(&self, index: &[u128; 3]) -> [u128; 3] {
        let loans = self.loans(index);
        let u = ok(math::utilisation(loans, self.capital_with(loans)));
        let r = &self.rates;
        let base = ok(math::base_rate(
            u,
            math::bp_to_wad(r.kink_bp),
            math::bp_to_wad(r.at_kink_bp),
            math::bp_to_wad(r.at_full_bp),
        ));
        Tier::ALL.map(|t| base + math::bp_to_wad(r.spread_bp.get(t)))
    }

    fn loans(&self, index: &[u128; 3]) -> u128 {
        (0..3).map(|t| ok(math::debt(self.scaled[t], index[t]))).sum()
    }

    fn capital(&self, index: &[u128; 3]) -> u128 {
        self.capital_with(self.loans(index))
    }

    /// Capital with these loans: cash plus loans, less the credit the pool owes accounts (INTERFACES.md 30, point 3).
    fn capital_with(&self, loans: u128) -> u128 {
        self.cash.saturating_add(loans).saturating_sub(self.credit)
    }

    /// The cash a loan or a defund may take: the credit owed to accounts stays in the pool.
    fn free_cash(&self) -> u128 {
        self.cash.saturating_sub(self.credit)
    }

    /// Tells the account's pricing record, if it has one, that its debt to the pool went from `before` (with
    /// interest up to now) to `after`, so the next settlement knows what the account owed and for how long
    /// (`pricing::PoolPart`). Never panics, so callbacks can use it.
    fn note_pool_debt(&mut self, account_id: &AccountId, before: u128, after: u128) {
        if let Some(record) = self.pricing.get_mut(account_id) {
            record.pool.see(env::block_timestamp(), before);
            record.pool.set(after);
        }
    }

    /// Takes up to `amount` off the credit the pool owes this account, and returns what it took.
    fn take_credit(&mut self, account_id: &AccountId, amount: u128) -> u128 {
        let Some(record) = self.pricing.get_mut(account_id) else { return 0 };
        let taken = record.credit.min(amount);
        record.credit -= taken;
        self.credit = self.credit.saturating_sub(taken);
        taken
    }

    /// The debt of the other accounts in this account's KYB entity, if it has one. With the account detached, the
    /// entity's total is exactly the others' (RISK_ENGINE.md 12.1: an entity counts as one client).
    fn rest_of_entity(&self, b: &Borrower) -> u128 {
        let Some(entity) = &b.kyb_entity else { return 0 };
        let scaled = self.entities.get(entity).copied().unwrap_or_default();
        (0..3).map(|t| ok(math::debt(scaled[t], self.index[t]))).sum()
    }

    fn book(&self, index: &[u128; 3]) -> Book {
        let to_debt = |scaled: &[u128; 3]| -> u128 { (0..3).map(|t| ok(math::debt(scaled[t], index[t]))).sum() };
        Book {
            wrappers: self.wrapper_scaled.iter().map(|(token, s)| (token.clone(), to_debt(s))).collect(),
            hl: to_debt(&self.hl_scaled),
            hold: self.book_hold.clone(),
        }
    }

    // The pool's totals follow each account: `detach` takes an account's part out before its record changes, and
    // `attach` puts it back after. Neither panics, so callbacks can use them.

    fn detach(&mut self, b: &Borrower) {
        self.apply_share(b, false);
    }

    fn attach(&mut self, b: &mut Borrower) {
        let hl_scaled = math::scaled_for_loan(b.hl_eq, self.index[b.debt_tier.index()]).unwrap_or(u128::MAX);
        b.hl_scaled = b.scaled.min(hl_scaled);
        self.apply_share(b, true);
    }

    fn apply_share(&mut self, b: &Borrower, add: bool) {
        let t = b.debt_tier.index();
        bump(&mut self.scaled[t], b.scaled, add);
        bump(&mut self.hl_scaled[t], b.hl_scaled, add);
        for (token, bp) in &b.shares_bp {
            let part = math::mul_div_ceil(b.scaled, (*bp).into(), BP).unwrap_or(b.scaled);
            bump(&mut self.wrapper_scaled.entry(token.clone()).or_default()[t], part, add);
        }
        if b.scaled > 0 {
            for (token, held) in &b.hold {
                bump(self.book_hold.entry(token.clone()).or_default(), *held, add);
            }
        }
        if let Some(entity) = &b.kyb_entity {
            let mut total = self.entities.get(entity).copied().unwrap_or_default();
            bump(&mut total[t], b.scaled, add);
            if total == [0; 3] {
                self.entities.remove(entity);
            } else {
                self.entities.insert(entity.clone(), total);
            }
        }
    }

    /// Moves an account's debt onto another tier's index (between `detach` and `attach`).
    fn move_debt(&self, b: &mut Borrower, to: Tier) {
        if b.debt_tier != to {
            let debt = b.debt(&self.index);
            b.scaled = ok(math::scaled_for_loan(debt, self.index[to.index()]));
            b.debt_tier = to;
        }
    }

    /// The daily budget in force at `now`: a raise counts once its 48 hours have passed.
    fn budget_bp_at(&self, now: u64) -> u32 {
        match &self.pending_budget {
            Some(p) if now >= p.from.0 => p.bp,
            _ => self.budget_bp,
        }
    }

    fn apply_pending_budget(&mut self, now: u64) {
        if self.pending_budget.as_ref().is_some_and(|p| now >= p.from.0) {
            self.budget_bp = self.budget_bp_at(now);
            self.pending_budget = None;
        }
    }
}

/// Unwraps checked math. Overflow means an absurd amount, so the call is refused.
fn ok<T>(value: Option<T>) -> T {
    value.unwrap_or_else(|| env::panic_str("arithmetic overflow"))
}

fn to_i128(amount: u128) -> i128 {
    i128::try_from(amount).unwrap_or(i128::MAX)
}

fn bump(total: &mut u128, value: u128, add: bool) {
    *total = if add { total.saturating_add(value) } else { total.saturating_sub(value) };
}

fn amount_of(map: &BTreeMap<String, u128>, token: &str) -> u128 {
    map.get(token).copied().unwrap_or(0)
}

/// Keeps the verdict's entries for tokens the pool has a cap for; the others don't affect any limit.
fn only_capped<V: Copy, C, T>(
    entries: &BTreeMap<String, V>,
    caps: &BTreeMap<String, C>,
    value: impl Fn(V) -> T,
) -> Vec<(String, T)> {
    entries.iter().filter(|(token, _)| caps.contains_key(*token)).map(|(token, v)| (token.clone(), value(*v))).collect()
}

/// Requires the attached deposit to cover the storage added since `before`, plus `headroom` bytes, and refunds the
/// rest to the caller.
fn charge_storage(before: u64, headroom: u64) {
    let bytes = env::storage_usage().saturating_sub(before).saturating_add(headroom);
    let cost = env::storage_byte_cost().saturating_mul(bytes.into());
    let deposit = env::attached_deposit();
    require!(deposit >= cost, format!("attach at least {cost} for storage"));
    let refund = deposit.saturating_sub(cost);
    if !refund.is_zero() {
        Promise::new(env::predecessor_account_id()).transfer(refund).detach();
    }
}
