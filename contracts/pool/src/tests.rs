//! Unit tests: at least one for every rule, with the block time under the test's control. The sandbox tests in
//! `contracts/tests` repeat the limits against the real wasm and token.
//!
//! On chain, a refused call undoes everything it did. Here a refusal is a caught panic, so `Env::refuses` snapshots
//! the pool and its storage first and puts them back afterwards, as the chain would.
//!
//! Debts can be a micro-USDC or two above the amount lent, because scaled debt rounds in the pool's favour; `about`
//! allows for that, and tests that hit a limit exactly leave a dollar of room for it.
use std::collections::{BTreeMap, HashMap};
use std::panic::{catch_unwind, AssertUnwindSafe};

use near_sdk::borsh::{self, BorshDeserialize};
use near_sdk::json_types::{U128, U64};
use near_sdk::mock::with_mocked_blockchain;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, json};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{AccountId, MockedBlockchain, NearToken, PromiseError, PromiseOrValue, RuntimeFeesConfig};
use pb_types::LenderReport;

use crate::math::YEAR_NS;
use crate::pricing::{
    FundingOrder, FundingSettings, PricingFrom, PricingLimits, PricingTarget, PricingView, SettleAnswer, Settled,
};
use crate::*;

const POOL: &str = "pool.testnet";
const OPERATOR: &str = "ops.testnet";
const FACTORY: &str = "factory.testnet";
const TOKEN: &str = "musdc.testnet";
const NBTC: &str = "mnbtc.testnet";
const HOUR: u64 = 3_600 * 1_000_000_000;
const DAY: u64 = 24 * HOUR;

fn id(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn usd(dollars: u128) -> u128 {
    dollars * USDC
}

/// `actual` is `expected` or a few micro-USDC above it (rounding in the pool's favour).
fn about(actual: u128, expected: u128) {
    assert!(actual >= expected && actual <= expected + 5, "{actual} is not about {expected}");
}

/// A verdict with no bridged tokens, no NEAR-side holdings and no Hyperliquid equity.
fn verdict(tier: Tier, allow: u128) -> BorrowVerdict {
    BorrowVerdict { tier, allow_borrow: U128(allow), shares_bp: BTreeMap::new(), hold: BTreeMap::new(), hl_eq: U128(0) }
}

fn with_share(mut v: BorrowVerdict, token: &str, bp: u32) -> BorrowVerdict {
    v.shares_bp.insert(token.into(), bp);
    v
}

fn with_hold(mut v: BorrowVerdict, token: &str, dollars: u128) -> BorrowVerdict {
    v.hold.insert(token.into(), U128(usd(dollars)));
    v
}

fn with_hl(mut v: BorrowVerdict, dollars: u128) -> BorrowVerdict {
    v.hl_eq = U128(usd(dollars));
    v
}

/// Sets the caller, attached deposit and block time, keeping `storage` as the contract's storage.
fn install(storage: HashMap<Vec<u8>, Vec<u8>>, who: &str, yocto: u128, now: u64) {
    let context = VMContextBuilder::new()
        .current_account_id(id(POOL))
        .predecessor_account_id(id(who))
        .attached_deposit(NearToken::from_yoctonear(yocto))
        .block_timestamp(now)
        .build();
    near_sdk::env::set_blockchain_interface(MockedBlockchain::new(
        context,
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        vec![],
        storage,
        Default::default(),
        None,
    ));
}

/// As `install`, with the pool account holding `near` NEAR. The test VM counts its storage as 307,200 bytes, which
/// lock 3.072 NEAR.
fn install_holding(storage: HashMap<Vec<u8>, Vec<u8>>, who: &str, near: u128, now: u64) {
    let context = VMContextBuilder::new()
        .current_account_id(id(POOL))
        .predecessor_account_id(id(who))
        .account_balance(NearToken::from_near(near))
        .block_timestamp(now)
        .build();
    near_sdk::env::set_blockchain_interface(MockedBlockchain::new(
        context,
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        vec![],
        storage,
        Default::default(),
        None,
    ));
}

fn take_storage() -> HashMap<Vec<u8>, Vec<u8>> {
    with_mocked_blockchain(|b| b.take_storage())
}

/// A pool funded by the operator, with the clock under the test's control.
struct Env {
    pool: Pool,
    now: u64,
}

impl Env {
    fn new(capital: u128) -> Self {
        let now = DAY;
        install(HashMap::new(), OPERATOR, 0, now);
        let mut env = Env { pool: Pool::new(id(OPERATOR), id(FACTORY), id(TOKEN), None), now };
        if capital > 0 {
            env.fund(capital);
        }
        env
    }

    /// Calls the pool as `who`, with `yocto` attached, at the test's current time.
    fn as_(&mut self, who: &str, yocto: u128) -> &mut Pool {
        install(take_storage(), who, yocto, self.now);
        &mut self.pool
    }

    fn operator(&mut self) -> &mut Pool {
        self.as_(OPERATOR, 0)
    }

    /// Runs `f`, which must be refused with a message containing `expected`, then undoes whatever it changed.
    fn refuses(&mut self, expected: &str, f: impl FnOnce(&mut Env)) {
        let p = &mut self.pool;
        p.borrowers.flush();
        p.entities.flush();
        p.hl_links.flush();
        p.step_prices.flush();
        p.coins.flush();
        p.versions.flush();
        p.pricing.flush();
        p.fees.flush();
        let state = borsh::to_vec(&self.pool).unwrap();
        let storage = take_storage();
        install(storage.clone(), OPERATOR, 0, self.now);

        let err = catch_unwind(AssertUnwindSafe(|| f(self))).expect_err("expected a refusal");
        let msg = err.downcast_ref::<String>().cloned().or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()));
        let msg = msg.unwrap_or_default();
        assert!(msg.contains(expected), "expected a refusal with {expected:?}, got {msg:?}");

        // Drop the changed pool first (its collections write their caches on drop), then restore the storage.
        drop(std::mem::replace(&mut self.pool, Pool::try_from_slice(&state).unwrap()));
        install(storage, OPERATOR, 0, self.now);
    }

    fn view(&mut self) -> PoolView {
        self.operator().get_pool()
    }

    fn params(&mut self) -> ParamsView {
        self.operator().get_params()
    }

    fn fund(&mut self, amount: u128) {
        self.as_(TOKEN, 0).ft_on_transfer(id(OPERATOR), U128(amount), r#"{"pool":"fund"}"#.into()).detach();
    }

    fn register(&mut self, account: &str) {
        self.as_(FACTORY, NearToken::from_millinear(20).as_yoctonear()).register(id(account));
    }

    /// Registers the accounts and moves past their first week.
    fn mature(&mut self, accounts: &[&str]) {
        for account in accounts {
            self.register(account);
        }
        self.now += 8 * DAY;
    }

    fn borrow(&mut self, account: &str, amount: u128, v: BorrowVerdict) {
        self.as_(account, 1).borrow(U128(amount), v).detach();
    }

    fn standard(&mut self, account: &str, amount: u128) {
        self.borrow(account, amount, verdict(Tier::Standard, amount));
    }

    /// Repays through `ft_on_transfer` and returns the unused part.
    fn repay(&mut self, account: &str, amount: u128) -> u128 {
        match self.as_(TOKEN, 0).ft_on_transfer(id(account), U128(amount), r#"{"pool":"repay"}"#.into()) {
            PromiseOrValue::Value(unused) => unused.0,
            PromiseOrValue::Promise(_) => panic!("repay returned a promise"),
        }
    }

    fn step(&mut self, account: &str, plan: &str, i: u32, token: &str, amount: u128) {
        self.as_(account, 0).check_step(plan.into(), i, id(token), U128(amount));
    }

    fn debt(&mut self, account: &str) -> u128 {
        self.operator().debt_of(id(account)).0
    }

    fn borrower(&mut self, account: &str) -> BorrowerView {
        self.operator().get_borrower(id(account)).unwrap()
    }

    /// Raises the daily budget to 100% of capital and waits out its 48 hours, so other limits can be reached.
    fn open_budget(&mut self) {
        self.operator().set_daily_budget(10_000);
        self.now += 2 * DAY + 1;
    }

    fn set_caps(&mut self, change: impl FnOnce(&mut Caps)) {
        let mut caps = self.params().caps;
        change(&mut caps);
        self.operator().set_caps(caps);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Funding and defunding
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn the_operator_funds_the_pool() {
    let mut env = Env::new(usd(1_000_000));
    let view = env.view();
    assert_eq!((view.cash.0, view.capital.0, view.funded.0), (usd(1_000_000), usd(1_000_000), usd(1_000_000)));
}

#[test]
fn only_the_operator_funds_and_only_with_the_lending_token() {
    let mut env = Env::new(0);
    env.refuses("only the operator can fund the pool", |e| {
        e.as_(TOKEN, 0).ft_on_transfer(id("stranger.testnet"), U128(1), r#"{"pool":"fund"}"#.into()).detach()
    });
    env.refuses("accepts only its lending token", |e| {
        e.as_(NBTC, 0).ft_on_transfer(id(OPERATOR), U128(1), r#"{"pool":"fund"}"#.into()).detach()
    });
    env.refuses("msg must be", |e| e.as_(TOKEN, 0).ft_on_transfer(id(OPERATOR), U128(1), "fund".into()).detach());
    assert_eq!(env.view().cash.0, 0);
}

#[test]
fn defund_is_limited_to_free_cash_and_a_failed_transfer_puts_it_back() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.standard("a.testnet", usd(50_000));
    env.refuses("free cash", |e| e.as_(OPERATOR, 1).defund(U128(usd(950_000) + 1)).detach());
    env.refuses("only the operator", |e| e.as_("a.testnet", 1).defund(U128(1)).detach());
    env.refuses("1 yoctoNEAR", |e| e.as_(OPERATOR, 0).defund(U128(1)).detach());

    env.as_(OPERATOR, 1).defund(U128(usd(100_000))).detach();
    assert_eq!(env.view().cash.0, usd(850_000));
    assert!(!env.as_(POOL, 0).on_defunded(U128(usd(100_000)), Err(PromiseError::Failed)));
    let view = env.view();
    assert_eq!((view.cash.0, view.defunded.0), (usd(950_000), 0));
}

#[test]
fn funding_and_defunding_at_full_utilisation() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet", "c.testnet", "d.testnet"]);
    env.open_budget();
    for account in ["a.testnet", "b.testnet", "c.testnet"] {
        env.standard(account, usd(225_000));
    }
    env.standard("d.testnet", usd(224_999)); // just under 90% lent out
                                             // The operator takes back all the free cash: the pool is fully lent and the rate is at the top of the curve.
    env.as_(OPERATOR, 1).defund(U128(usd(100_001))).detach();
    let view = env.view();
    assert_eq!((view.cash.0, view.utilisation_bp), (0, 10_000));
    assert_eq!(view.rate_bp, PerTier { preferred: 5_100, standard: 5_200, watch: 5_500 });
    env.refuses("free cash", |e| e.as_(OPERATOR, 1).defund(U128(1)).detach());
    env.refuses("doesn't have that much cash", |e| e.standard("a.testnet", 1));
    // Funding brings utilisation back down, and lending resumes below 90%.
    env.fund(usd(100_001));
    assert_eq!(env.view().utilisation_bp, 9_000);
    env.refuses("utilisation limit", |e| e.standard("a.testnet", usd(2)));
}

// ---------------------------------------------------------------------------------------------------------------
// Registration and borrowing
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn only_the_factory_registers_each_account_once_with_storage_paid() {
    let mut env = Env::new(0);
    env.refuses("only the factory", |e| e.as_("a.testnet", 10u128.pow(22)).register(id("a.testnet")));
    env.refuses("attach at least", |e| e.as_(FACTORY, 0).register(id("a.testnet")));
    env.register("a.testnet");
    env.refuses("already registered", |e| e.register("a.testnet"));
    assert_eq!(env.borrower("a.testnet").created_at.0, DAY);
}

#[test]
fn a_borrow_books_the_debt_and_the_days_lending() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.standard("a.testnet", usd(40_000));
    about(env.debt("a.testnet"), usd(40_000));
    let view = env.view();
    about(view.loans.0, usd(40_000));
    assert_eq!((view.cash.0, view.lent_24h.0), (usd(960_000), usd(40_000) as i128));
    assert_eq!(env.borrower("a.testnet").tier, Tier::Standard);
}

#[test]
fn borrows_need_a_registered_account_and_stay_within_the_verdict() {
    let mut env = Env::new(usd(1_000_000));
    env.refuses("not a registered account", |e| e.standard("stranger.testnet", 1));
    env.mature(&["a.testnet"]);
    env.refuses("above the verdict's borrow allowance", |e| e.borrow("a.testnet", 2, verdict(Tier::Standard, 1)));
    env.refuses("1 yoctoNEAR", |e| e.as_("a.testnet", 0).borrow(U128(1), verdict(Tier::Standard, 1)).detach());
    env.refuses("too many tokens", |e| {
        let mut v = verdict(Tier::Standard, 1);
        for i in 0..9 {
            v.hold.insert(format!("T{i}"), U128(1));
        }
        e.borrow("a.testnet", 1, v)
    });
    assert_eq!(env.debt("a.testnet"), 0);
}

#[test]
fn no_loans_while_paused_but_repaying_still_works() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.standard("a.testnet", usd(10_000));
    env.operator().set_paused(true);
    env.refuses("paused", |e| e.standard("a.testnet", 1));
    // Repaying more than the debt returns the rest.
    let unused = env.repay("a.testnet", usd(10_500));
    assert!(unused <= usd(500) && usd(500) - unused <= 5);
    assert_eq!(env.debt("a.testnet"), 0);
    env.operator().set_paused(false);
    env.standard("a.testnet", 1);
}

#[test]
fn a_loan_the_account_does_not_take_is_undone() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.standard("a.testnet", usd(10_000));
    let scaled = U128(math::scaled_for_loan(usd(10_000), env.pool.index[Tier::Standard.index()]).unwrap());
    let lent_at = U64(env.now);
    let used =
        env.as_(POOL, 0).on_lent(id("a.testnet"), U128(usd(10_000)), scaled, Tier::Standard, lent_at, Ok(U128(0)));
    assert_eq!(used.0, 0);
    let view = env.view();
    assert_eq!((env.debt("a.testnet"), view.cash.0, view.lent_24h.0), (0, usd(1_000_000), 0));
}

#[test]
fn a_failed_loan_transfer_is_undone() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.standard("a.testnet", usd(10_000));
    let scaled = U128(math::scaled_for_loan(usd(10_000), env.pool.index[Tier::Standard.index()]).unwrap());
    let lent_at = U64(env.now);
    env.as_(POOL, 0).on_lent(
        id("a.testnet"),
        U128(usd(10_000)),
        scaled,
        Tier::Standard,
        lent_at,
        Err(PromiseError::Failed),
    );
    assert_eq!((env.debt("a.testnet"), env.view().cash.0), (0, usd(1_000_000)));
}

// ---------------------------------------------------------------------------------------------------------------
// The pool's own limits (RISK_ENGINE.md 12.2)
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn the_daily_budget_counts_loans_minus_repayments_over_24_hours() {
    let mut env = Env::new(usd(1_000_000)); // budget: 10% = $100k a day
    env.mature(&["a.testnet", "b.testnet"]);
    env.standard("a.testnet", usd(60_000));
    env.standard("b.testnet", usd(40_000));
    env.refuses("daily budget", |e| e.standard("a.testnet", 1));
    // Repayments free budget: the limit is on net new lending.
    env.repay("a.testnet", usd(30_000));
    env.standard("b.testnet", usd(30_000));
    env.refuses("daily budget", |e| e.standard("b.testnet", 1));
    // A day later (plus an hour, for the hourly buckets), the window has moved on.
    env.now += DAY + HOUR;
    env.standard("a.testnet", usd(99_000));
}

#[test]
fn raising_the_daily_budget_waits_48_hours_and_lowering_it_does_not() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.operator().set_daily_budget(2_000);
    let view = env.view();
    assert_eq!(view.daily_budget_bp, 1_000);
    assert_eq!(view.pending_budget.unwrap().from.0, env.now + 2 * DAY);
    env.refuses("daily budget", |e| e.standard("a.testnet", usd(100_001)));
    env.now += 2 * DAY;
    env.standard("a.testnet", usd(150_000));
    assert_eq!(env.view().daily_budget_bp, 2_000);
    env.operator().set_daily_budget(500);
    assert_eq!(env.view().daily_budget_bp, 500);
    env.refuses("only the operator", |e| e.as_("a.testnet", 0).set_daily_budget(10_000));
}

#[test]
fn a_new_account_can_owe_at_most_25k_in_its_first_week() {
    let mut env = Env::new(usd(1_000_000));
    env.register("new.testnet");
    env.register("other.testnet");
    env.standard("new.testnet", usd(25_000)); // exactly $25k in one go is fine
    env.refuses("first-week limit", |e| e.standard("new.testnet", 1));
    env.standard("other.testnet", usd(20_000));
    env.refuses("first-week limit", |e| e.standard("other.testnet", usd(5_001)));
    env.now += 7 * DAY;
    env.standard("new.testnet", usd(50_000));
}

#[test]
fn each_tier_has_a_ceiling() {
    let mut env = Env::new(usd(100_000_000));
    env.mature(&["w.testnet", "s.testnet", "p.testnet"]);
    env.open_budget();
    env.borrow("w.testnet", usd(100_000), verdict(Tier::Watch, usd(200_000)));
    env.refuses("tier ceiling", |e| e.borrow("w.testnet", 1, verdict(Tier::Watch, 1)));

    env.operator().cosign(CosignRequest::Borrow { account_id: id("s.testnet"), amount: U128(usd(1_000_000)) });
    env.standard("s.testnet", usd(1_000_000));
    env.refuses("tier ceiling", |e| e.standard("s.testnet", 1));

    env.operator().set_kyb(id("p.testnet"), Some("p-corp".into()));
    env.operator().cosign(CosignRequest::Borrow { account_id: id("p.testnet"), amount: U128(usd(5_000_000)) });
    env.borrow("p.testnet", usd(5_000_000), verdict(Tier::Preferred, usd(5_000_000)));
    env.refuses("tier ceiling", |e| e.borrow("p.testnet", 1, verdict(Tier::Preferred, 1)));
}

#[test]
fn a_borrow_above_250k_needs_the_operators_cosignature_once() {
    let mut env = Env::new(usd(10_000_000));
    env.mature(&["a.testnet"]);
    env.refuses("co-signature", |e| e.standard("a.testnet", usd(250_001)));
    env.standard("a.testnet", usd(250_000)); // at the threshold: no co-signature needed
    let request = CosignRequest::Borrow { account_id: id("a.testnet"), amount: U128(usd(300_000)) };
    env.refuses("only the operator", |e| e.as_("a.testnet", 0).cosign(request.clone()));
    env.operator().cosign(request.clone());
    assert!(env.operator().is_cosigned(request.clone()));
    env.refuses("co-signature", |e| e.standard("a.testnet", usd(300_001))); // a different amount
    env.standard("a.testnet", usd(300_000));
    assert!(!env.operator().is_cosigned(request.clone()));
    env.repay("a.testnet", usd(300_000));
    env.refuses("co-signature", |e| e.standard("a.testnet", usd(300_000))); // it was used once
                                                                            // The operator can withdraw a co-signature before it is used.
    env.operator().cosign(request.clone());
    env.operator().revoke_cosign(request.clone());
    env.refuses("co-signature", |e| e.standard("a.testnet", usd(300_000)));
    env.refuses("no such co-signature", |e| e.operator().revoke_cosign(request));
}

#[test]
fn utilisation_stays_at_or_below_90_percent() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet", "c.testnet", "d.testnet"]);
    env.open_budget();
    for account in ["a.testnet", "b.testnet", "c.testnet"] {
        env.standard(account, usd(225_000));
    }
    env.refuses("utilisation limit", |e| e.standard("d.testnet", usd(225_000) + 1));
    env.standard("d.testnet", usd(224_999));
}

// ---------------------------------------------------------------------------------------------------------------
// Tier history (RISK_ENGINE.md 12.2) and the KYB flag
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn a_forged_preferred_tier_without_kyb_is_refused() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    let preferred = verdict(Tier::Preferred, usd(1_000));
    env.refuses("needs the operator's KYB flag", |e| e.borrow("a.testnet", usd(1_000), preferred.clone()));
    env.operator().set_kyb(id("a.testnet"), Some("acme".into()));
    env.borrow("a.testnet", usd(1_000), preferred);
    assert_eq!(env.borrower("a.testnet").tier, Tier::Preferred);
    // Removing the KYB flag takes the account down to Standard at once.
    env.operator().set_kyb(id("a.testnet"), None);
    assert_eq!(env.borrower("a.testnet").tier, Tier::Standard);
}

#[test]
fn a_downgrade_applies_at_once_and_upgrades_come_at_most_once_per_30_days() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.operator().set_kyb(id("a.testnet"), Some("acme".into()));
    env.borrow("a.testnet", usd(1_000), verdict(Tier::Watch, usd(1_000))); // the first tier is not an upgrade
    env.standard("a.testnet", usd(1_000)); // upgrade 1
    assert_eq!(env.borrower("a.testnet").tier, Tier::Standard);
    env.now += 29 * DAY;
    env.refuses("one tier upgrade per 30 days", |e| {
        e.borrow("a.testnet", usd(1_000), verdict(Tier::Preferred, usd(1_000)))
    });
    env.borrow("a.testnet", usd(1_000), verdict(Tier::Watch, usd(1_000))); // a downgrade applies at once
    assert_eq!(env.borrower("a.testnet").tier, Tier::Watch);
    env.now += DAY;
    env.borrow("a.testnet", usd(1_000), verdict(Tier::Preferred, usd(1_000))); // 30 days after upgrade 1
    assert_eq!(env.borrower("a.testnet").tier, Tier::Preferred);
}

#[test]
fn an_override_sets_the_tier_until_it_expires() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.standard("a.testnet", usd(1_000)); // the history says Standard
    let until = U64(env.now + 10 * DAY);
    env.refuses("needs the operator's KYB flag", |e| {
        e.operator().set_tier_override(id("a.testnet"), Tier::Preferred, "review".into(), until)
    });
    env.refuses("give a reason", |e| e.operator().set_tier_override(id("a.testnet"), Tier::Watch, "".into(), until));
    env.refuses("only the operator", |e| {
        e.as_("a.testnet", 0).set_tier_override(id("a.testnet"), Tier::Watch, "x".into(), until)
    });
    env.operator().set_tier_override(id("a.testnet"), Tier::Watch, "late statements".into(), until);
    assert_eq!(env.borrower("a.testnet").tier, Tier::Watch);
    env.refuses("above the operator's override", |e| e.standard("a.testnet", usd(1_000)));
    env.borrow("a.testnet", usd(1_000), verdict(Tier::Watch, usd(1_000)));
    // Once it expires, the tier history applies again.
    env.now += 10 * DAY;
    assert_eq!(env.borrower("a.testnet").tier, Tier::Standard);
    env.standard("a.testnet", usd(1_000));
    let tomorrow = U64(env.now + DAY);
    env.operator().set_tier_override(id("a.testnet"), Tier::Watch, "again".into(), tomorrow);
    env.operator().clear_tier_override(id("a.testnet"));
    assert_eq!(env.borrower("a.testnet").tier, Tier::Standard);
}

#[test]
fn debt_moves_to_the_rate_of_the_tier_that_applies() {
    let mut env = Env::new(usd(10_000_000));
    env.mature(&["a.testnet"]);
    env.standard("a.testnet", usd(100_000));
    let until = U64(env.now + 2 * YEAR_NS as u64);
    env.operator().set_tier_override(id("a.testnet"), Tier::Watch, "late statements".into(), until);
    env.now += YEAR_NS as u64;
    // Watch: about 5% + 0.0075% (1% utilisation) a year.
    let owed = env.debt("a.testnet");
    assert!(owed > usd(105_000) && owed < usd(105_100), "owes {owed}");
}

// ---------------------------------------------------------------------------------------------------------------
// Per-client and book limits (PLAN.md 5.1; RISK_ENGINE.md 12.1)
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn one_client_owes_at_most_25_percent_and_a_kyb_entity_counts_as_one() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet", "c.testnet", "d.testnet"]);
    env.open_budget();
    env.standard("a.testnet", usd(250_000));
    env.refuses("one-client limit", |e| e.standard("a.testnet", 1));
    // Two accounts of one entity share the limit.
    env.operator().set_kyb(id("b.testnet"), Some("acme".into()));
    env.operator().set_kyb(id("c.testnet"), Some("acme".into()));
    env.standard("b.testnet", usd(150_000));
    env.refuses("one-client limit", |e| e.standard("c.testnet", usd(100_001)));
    env.standard("c.testnet", usd(99_999));
    about(env.operator().entity_debt("acme".into()).0, usd(249_999));
    // An unrelated account still has its own limit.
    env.standard("d.testnet", usd(100_000));
}

#[test]
fn moving_an_account_between_entities_moves_its_debt() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.operator().set_kyb(id("a.testnet"), Some("one".into()));
    env.standard("a.testnet", usd(10_000));
    env.operator().set_kyb(id("a.testnet"), Some("two".into()));
    assert_eq!(env.operator().entity_debt("one".into()).0, 0);
    about(env.operator().entity_debt("two".into()).0, usd(10_000));
}

#[test]
fn no_new_loan_rests_on_a_frozen_token() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.operator().set_coin_status("nBTC".into(), CoinStatus::Frozen, None);
    let on_nbtc = |bp| with_share(verdict(Tier::Standard, usd(1_000)), "nBTC", bp);
    env.refuses("nBTC is frozen", |e| e.borrow("a.testnet", usd(1_000), on_nbtc(100)));
    // A loan resting on other collateral still goes through; so does one after the freeze is lifted.
    env.borrow("a.testnet", usd(1_000), on_nbtc(0));
    env.operator().set_coin_status("nBTC".into(), CoinStatus::Allowed, None);
    env.borrow("a.testnet", usd(1_000), on_nbtc(5_000));
}

#[test]
fn loans_resting_on_each_bridged_token_stay_within_its_cap() {
    // nBTC 30%, ETH 15% and USDT 30% of a $1M pool.
    for (token, cap) in [("nBTC", 300_000), ("ETH", 150_000), ("USDT", 300_000)] {
        let mut env = Env::new(usd(1_000_000));
        env.mature(&["a.testnet", "b.testnet"]);
        env.open_budget();
        let on_token = |amount, bp| with_share(verdict(Tier::Standard, amount), token, bp);
        env.borrow("a.testnet", usd(cap / 2), on_token(usd(cap / 2), 10_000));
        env.refuses("bridged-token cap", |e| {
            e.borrow("b.testnet", usd(cap / 2) + 1, on_token(usd(cap / 2) + 1, 10_000))
        });
        // A loan half resting on the token counts half.
        env.borrow("b.testnet", usd(cap / 2), on_token(usd(cap / 2), 5_000));
        about(env.view().wrappers[token].amount.0, usd(cap / 2 + cap / 4));
    }
}

#[test]
fn a_cap_passed_after_a_defund_only_blocks_borrows_that_add_to_it() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet"]);
    env.open_budget();
    env.borrow("a.testnet", usd(140_000), with_share(verdict(Tier::Standard, usd(140_000)), "ETH", 10_000));
    env.as_(OPERATOR, 1).defund(U128(usd(400_000))).detach(); // ETH's cap is now 15% of $600k = $90k
    env.refuses("bridged-token cap", |e| {
        e.borrow("b.testnet", 1, with_share(verdict(Tier::Standard, 1), "ETH", 10_000))
    });
    env.standard("b.testnet", usd(10_000)); // a loan that doesn't rest on ETH is fine
}

#[test]
fn loans_resting_on_hyperliquid_stay_within_half_of_capital() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet", "c.testnet"]);
    env.open_budget();
    // Each account counts min(debt, Hyperliquid equity).
    env.borrow("a.testnet", usd(250_000), with_hl(verdict(Tier::Standard, usd(250_000)), 1_000_000));
    env.borrow("b.testnet", usd(249_999), with_hl(verdict(Tier::Standard, usd(249_999)), 249_999));
    about(env.view().hyperliquid.amount.0, usd(499_999));
    env.refuses("Hyperliquid cap", |e| {
        e.borrow("c.testnet", usd(10_000), with_hl(verdict(Tier::Standard, usd(10_000)), 2))
    });
    env.standard("c.testnet", usd(10_000)); // no Hyperliquid equity: nothing of it rests there
}

#[test]
fn the_books_near_side_holdings_stay_within_24_hours_of_1click_capacity() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet", "c.testnet"]);
    let holding = |token, dollars| with_hold(verdict(Tier::Standard, usd(1_000)), token, dollars);
    env.borrow("a.testnet", usd(1_000), holding("nBTC", 11_000_000));
    env.refuses("NEAR-side book cap", |e| e.borrow("b.testnet", usd(1_000), holding("nBTC", 1_000_001)));
    env.borrow("b.testnet", usd(1_000), holding("wNEAR", 6_000_000));
    env.refuses("NEAR-side book cap", |e| e.borrow("c.testnet", usd(1_000), holding("wNEAR", 1)));
    // Only accounts with a loan count: once a.testnet repays in full, its nBTC leaves the book.
    env.repay("a.testnet", usd(2_000));
    env.borrow("c.testnet", usd(1_000), holding("nBTC", 12_000_000));
    assert_eq!(env.view().book["nBTC"].amount.0, usd(12_000_000));
}

// ---------------------------------------------------------------------------------------------------------------
// Interest
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn each_tier_pays_the_base_rate_plus_its_spread() {
    let mut env = Env::new(usd(10_000_000));
    env.mature(&["p.testnet", "s.testnet", "w.testnet"]);
    env.operator().set_kyb(id("p.testnet"), Some("p-corp".into()));
    env.borrow("p.testnet", usd(100_000), verdict(Tier::Preferred, usd(100_000)));
    env.borrow("s.testnet", usd(100_000), verdict(Tier::Standard, usd(100_000)));
    env.borrow("w.testnet", usd(100_000), verdict(Tier::Watch, usd(100_000)));
    // 3% utilisation: base = 6% × 3/80 = 0.225%, so the tiers pay 1.225%, 2.225% and 5.225%.
    assert_eq!(env.view().rate_bp, PerTier { preferred: 123, standard: 223, watch: 523 });
    env.now += YEAR_NS as u64;
    let interest = |milli_pct: u128| usd(100_000) * milli_pct / 100_000;
    for (account, rate) in [("p.testnet", 1_225), ("s.testnet", 2_225), ("w.testnet", 5_225)] {
        let owed = env.debt(account);
        let expected = usd(100_000) + interest(rate);
        assert!(owed >= expected && owed <= expected + 10, "{account}: owes {owed}, expected about {expected}");
    }
    let view = env.view();
    assert!(view.interest_earned.0 >= interest(1_225 + 2_225 + 5_225));
    assert_eq!(view.capital.0, view.cash.0 + view.loans.0);
}

#[test]
fn rates_follow_utilisation_and_the_operators_curve() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet", "c.testnet"]);
    env.open_budget();
    for account in ["a.testnet", "b.testnet", "c.testnet"] {
        env.standard(account, usd(200_000));
    }
    // 60%: base 4.5%, as in RISK_ENGINE.md 13 (Standard 6.5%).
    assert_eq!(env.view().rate_bp.standard, 650);
    let mut rates = env.params().rates;
    rates.spread_bp.standard = 300;
    env.refuses("only the operator", |e| e.as_("a.testnet", 0).set_rates(rates.clone()));
    env.operator().set_rates(rates);
    assert_eq!(env.view().rate_bp.standard, 750);
    let mut bad = env.params().rates;
    bad.at_kink_bp = bad.at_full_bp + 1;
    env.refuses("at_kink_bp", |e| e.operator().set_rates(bad));
}

// ---------------------------------------------------------------------------------------------------------------
// Write-offs
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn a_write_off_comes_out_of_capital_and_blocks_the_account() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet"]);
    env.standard("a.testnet", usd(30_000));
    env.refuses("only the account itself or the operator", |e| e.as_("b.testnet", 0).write_off(id("a.testnet")));
    env.refuses("nothing to write off", |e| e.as_("b.testnet", 0).write_off(id("b.testnet")));
    env.as_("a.testnet", 0).write_off(id("a.testnet"));
    let view = env.view();
    about(view.written_off.0, usd(30_000));
    assert_eq!((view.loans.0, view.capital.0), (0, usd(970_000)));
    assert!(view.interest_earned.0 <= 5);
    assert!(env.borrower("a.testnet").blocked);
    env.refuses("blocked", |e| e.standard("a.testnet", 1));
    env.refuses("blocked", |e| e.step("a.testnet", "p", 0, TOKEN, 1));
    env.operator().unblock(id("a.testnet"));
    env.standard("a.testnet", 1);
}

// ---------------------------------------------------------------------------------------------------------------
// Plan steps and links
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn plan_steps_past_50k_a_day_need_the_cosignature_in_one_step_or_many() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.refuses("co-signature", |e| e.step("a.testnet", "plan-1", 0, TOKEN, usd(50_001)));
    for i in 0..5 {
        env.step("a.testnet", "plan-1", i, TOKEN, usd(10_000)); // $50k in five steps
    }
    env.refuses("co-signature", |e| e.step("a.testnet", "plan-1", 5, TOKEN, 1)); // the sixth splits its way past
    let request = CosignRequest::Step {
        account_id: id("a.testnet"),
        plan_id: "plan-1".into(),
        step: 5,
        token: id(TOKEN),
        amount: U128(usd(5_000)),
    };
    env.operator().cosign(request);
    env.step("a.testnet", "plan-1", 5, TOKEN, usd(5_000));
    env.refuses("co-signature", |e| e.step("a.testnet", "plan-1", 5, TOKEN, usd(5_000))); // used once
    assert_eq!(env.borrower("a.testnet").steps_24h.0, usd(55_000));
    env.now += DAY + HOUR;
    env.step("a.testnet", "plan-1", 6, TOKEN, usd(50_000));
}

#[test]
fn steps_in_other_tokens_count_at_the_operators_price() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.refuses("no step price", |e| e.step("a.testnet", "p", 0, NBTC, 1));
    env.refuses("only the operator", |e| e.as_("a.testnet", 0).set_step_price(id(NBTC), 8, U128(usd(120_000))));
    env.operator().set_step_price(id(NBTC), 8, U128(usd(120_000)));
    // 0.41666667 nBTC at $120k is $50,000.0004; 0.41666666 is $49,999.9992.
    env.refuses("co-signature", |e| e.step("a.testnet", "p", 0, NBTC, 41_666_667));
    env.step("a.testnet", "p", 0, NBTC, 41_666_666);
    assert_eq!(env.borrower("a.testnet").steps_24h.0, usd(50_000) - 800);
}

#[test]
fn no_plan_steps_while_paused_or_from_strangers() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.operator().set_paused(true);
    env.refuses("paused", |e| e.step("a.testnet", "p", 0, TOKEN, 1));
    env.operator().set_paused(false);
    env.refuses("not a registered account", |e| e.step("stranger.testnet", "p", 0, TOKEN, 1));
    env.step("a.testnet", "p", 0, TOKEN, 1);
}

#[test]
fn a_hyperliquid_address_links_to_one_account_only() {
    let mut env = Env::new(0);
    env.mature(&["a.testnet", "b.testnet"]);
    let address = format!("0x{}", "aB".repeat(20));
    let deposit = NearToken::from_millinear(5).as_yoctonear();
    env.refuses("attach at least", |e| e.as_("a.testnet", 0).link(address.clone()));
    env.as_("a.testnet", deposit).link(address.clone());
    env.as_("a.testnet", deposit).link(address.to_uppercase().replacen("0X", "0x", 1)); // the same address
    env.refuses("already linked to another account", |e| e.as_("b.testnet", deposit).link(address.to_lowercase()));
    env.refuses("40 hex characters", |e| e.as_("b.testnet", deposit).link("0x1234".into()));
    env.refuses("not a registered account", |e| e.as_("c.testnet", deposit).link(format!("0x{}", "1".repeat(40))));
    assert_eq!(env.operator().hl_link_owner(address.clone()), Some(id("a.testnet")));
    assert_eq!(env.borrower("a.testnet").hl_address, Some(address.to_lowercase()));
}

// ---------------------------------------------------------------------------------------------------------------
// The rest of the operator's settings
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn coin_statuses_carry_their_time_and_only_bridged_tokens_freeze() {
    let mut env = Env::new(0);
    env.operator().set_coin_status("DOGE".into(), CoinStatus::ReduceOnly, Some(true));
    let state = env.operator().coin_status("DOGE".into()).unwrap();
    assert_eq!((state.status, state.since.0, state.emergency), (CoinStatus::ReduceOnly, env.now, true));
    env.refuses("only a bridged token", |e| e.operator().set_coin_status("DOGE".into(), CoinStatus::Frozen, None));
    env.refuses("either allowed or frozen", |e| e.operator().set_coin_status("ETH".into(), CoinStatus::Removed, None));
    env.refuses("only the operator", |e| e.as_("a.testnet", 0).set_coin_status("ETH".into(), CoinStatus::Frozen, None));
    env.operator().set_coin_status("ETH".into(), CoinStatus::Frozen, None);
    assert_eq!(env.operator().coin_statuses().len(), 2);
}

#[test]
fn published_versions_keep_their_times() {
    let mut env = Env::new(0);
    env.operator().publish_version("pb-risk".into(), "aa".repeat(32), "bb".repeat(32));
    env.now += DAY;
    env.operator().publish_version("pb-risk".into(), "cc".repeat(32), "bb".repeat(32));
    env.refuses("already published", |e| e.operator().publish_version("pb-risk".into(), "aa".repeat(32), "dd".into()));
    env.refuses("only the operator", |e| {
        e.as_("a.testnet", 0).publish_version("pb-risk".into(), "ee".into(), "ff".into())
    });
    let versions = env.operator().versions("pb-risk".into());
    assert_eq!(versions.len(), 2);
    assert_eq!(versions[0].published_at.0 + DAY, versions[1].published_at.0);
    assert_eq!(env.operator().latest_version("pb-risk".into()).unwrap().hash, "cc".repeat(32));
    assert!(env.operator().latest_version("pb-gateway".into()).is_none());
}

#[test]
fn every_admin_call_is_refused_from_a_non_operator() {
    let mut env = Env::new(0);
    env.register("a.testnet");
    let request = CosignRequest::Borrow { account_id: id("a.testnet"), amount: U128(1) };
    type AdminCall = Box<dyn FnOnce(&mut Pool)>;
    let calls: Vec<AdminCall> = vec![
        Box::new(|p| p.set_rates(Rates::default())),
        Box::new(|p| p.set_caps(Caps::default())),
        Box::new(|p| p.set_daily_budget(1)),
        Box::new(|p| p.set_kyb(id("a.testnet"), Some("x".into()))),
        Box::new(|p| p.set_tier_override(id("a.testnet"), Tier::Watch, "x".into(), U64(u64::MAX))),
        Box::new(|p| p.clear_tier_override(id("a.testnet"))),
        Box::new({
            let request = request.clone();
            move |p| p.cosign(request)
        }),
        Box::new(move |p| p.revoke_cosign(request)),
        Box::new(|p| p.set_step_price(id(NBTC), 8, U128(1))),
        Box::new(|p| p.set_coin_status("BTC".into(), CoinStatus::Removed, None)),
        Box::new(|p| p.publish_version("pb-risk".into(), "a".into(), "b".into())),
        Box::new(|p| p.set_paused(true)),
        Box::new(|p| p.unblock(id("a.testnet"))),
        Box::new(|p| p.defund(U128(1)).detach()),
        Box::new(|p| p.set_pricing(PricingTarget::Account(id("a.testnet")), Some(Pricing::PassThrough))),
        Box::new(|p| p.set_pricing(PricingTarget::Tier(Tier::Watch), None)),
        Box::new(|p| p.set_pricing_limits(PricingLimits::default())),
        Box::new(|p| p.set_funding(FundingSettings::default())),
        Box::new(|p| p.reverse_fee(id("a.testnet"), U128(1))),
    ];
    for call in calls {
        env.refuses("only the operator", |e| call(e.as_("a.testnet", 1)));
    }
}

#[test]
fn caps_are_checked_when_set() {
    let mut env = Env::new(0);
    env.refuses("capped at 10,000 bp", |e| e.set_caps(|c| c.client_share_bp = 10_001));
    env.refuses("too many tokens", |e| {
        e.set_caps(|c| {
            for i in 0..8 {
                c.book_cap.insert(format!("T{i}"), U128(1));
            }
        })
    });
    env.set_caps(|c| c.hl_cap_bp = 4_000);
    assert_eq!(env.params().caps.hl_cap_bp, 4_000);
}

// ---------------------------------------------------------------------------------------------------------------
// Pricing (FUNDING.md 5; INTERFACES.md 26 and 30): policies, settlements, limits and credit
// ---------------------------------------------------------------------------------------------------------------

/// The loan of INTERFACES.md 26's worked numbers.
const RHEA_PART: u128 = 50_667 * USDC;
const AAVE_PART: u128 = 56_667 * USDC;
const CAPPED_AT_8: Pricing = Pricing::Lender { margin_bp: 0, cap_bp: Some(800) };
const MARGIN_120: Pricing = Pricing::Lender { margin_bp: 120, cap_bp: None };
/// An hour of the Rhea part's subsidy under an 8% cap, with Rhea at 15.91%: $0.4575 (INTERFACES.md 26).
const RHEA_HOUR: u128 = 457_506;
/// An hour of the Aave part's fee under a 1.2-point margin: $680.004 a year over 8,760 hours, rounded up.
const AAVE_HOUR: u128 = 77_627;
const MINUTE: u64 = HOUR / 60;

fn line(lender: &str, debt: u128, rate_bp: u32, supply_bp: u32) -> LenderReport {
    LenderReport { lender: lender.into(), debt: U128(debt), rate_bp, supply_bp }
}

/// Rhea lends $50,667 at 15.91% and pays depositors nothing.
fn rhea() -> Vec<LenderReport> {
    vec![line("rhea", RHEA_PART, 1_591, 0)]
}

/// Aave lends $56,667 at 5.33% and pays depositors 4.10%.
fn aave() -> Vec<LenderReport> {
    vec![line("aave", AAVE_PART, 533, 410)]
}

/// The last call's last event, as JSON.
fn last_event() -> serde_json::Value {
    let logs = get_logs();
    let log = logs.iter().rev().find_map(|l| l.strip_prefix("EVENT_JSON:")).expect("the call logged no event");
    serde_json::from_str(log).unwrap()
}

fn as_json<T: near_sdk::serde::Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap()
}

impl Env {
    fn settle(&mut self, account: &str, report: Vec<LenderReport>) -> SettleAnswer {
        self.as_(account, 0).settle(report, None)
    }

    /// A settlement at a borrow, which must be booked: `closes` is the lender report as it stood before the borrow
    /// and `report` shows the debt with it.
    fn settled_closing(&mut self, account: &str, report: Vec<LenderReport>, closes: Vec<LenderReport>) -> Settled {
        match self.as_(account, 0).settle(report, Some(closes)) {
            SettleAnswer::Settled(settled) => settled,
            SettleAnswer::Skipped { skipped } => panic!("the settlement was skipped: {skipped}"),
        }
    }

    /// A settlement that must be booked.
    fn settled(&mut self, account: &str, report: Vec<LenderReport>) -> Settled {
        match self.settle(account, report) {
            SettleAnswer::Settled(settled) => settled,
            SettleAnswer::Skipped { skipped } => panic!("the settlement was skipped: {skipped}"),
        }
    }

    /// A settlement that must be skipped: returns why.
    fn skipped(&mut self, account: &str, report: Vec<LenderReport>) -> String {
        match self.settle(account, report) {
            SettleAnswer::Skipped { skipped } => skipped,
            SettleAnswer::Settled(settled) => panic!("the settlement was booked: {settled:?}"),
        }
    }

    fn pricing(&mut self, account: &str) -> PricingView {
        self.operator().get_pricing(id(account)).unwrap()
    }

    fn policy(&mut self, account: &str, pricing: Pricing) {
        self.operator().set_pricing(PricingTarget::Account(id(account)), Some(pricing));
    }

    fn set_limits(&mut self, change: impl FnOnce(&mut PricingLimits)) {
        let mut limits = self.params().pricing_limits;
        change(&mut limits);
        self.operator().set_pricing_limits(limits);
    }

    fn claim(&mut self, account: &str) {
        self.as_(account, 0).claim_credit().detach();
    }

    /// Sets the account's policy, stores its first report, and settles again after `wait`.
    fn settled_after(&mut self, account: &str, pricing: Pricing, report: Vec<LenderReport>, wait: u64) -> Settled {
        self.policy(account, pricing);
        self.settled(account, report.clone());
        self.now += wait;
        self.settled(account, report)
    }
}

/// A $1M pool that is 60% lent, so Standard pays 6.5% (RISK_ENGINE.md 13): a, b and c owe $200k each.
fn sixty_percent_lent() -> Env {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet", "c.testnet"]);
    env.open_budget();
    for account in ["a.testnet", "b.testnet", "c.testnet"] {
        env.standard(account, usd(200_000));
    }
    assert_eq!(env.view().rate_bp.standard, 650);
    env
}

// ---- Policies and settings ----

#[test]
fn an_accounts_policy_is_its_own_else_its_tiers_else_pass_through() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet"]);
    let fresh = PricingView {
        pricing: Pricing::PassThrough,
        from: PricingFrom::Default,
        fees_charged: U128(0),
        fees_reversed: U128(0),
        subsidy_paid: U128(0),
        credit: U128(0),
        settled_at: U64(0),
        last: vec![],
    };
    assert_eq!(env.pricing("a.testnet"), fresh);
    assert_eq!(env.operator().get_pricing(id("stranger.testnet")), None);
    assert!(env.params().tier_pricing.is_empty());

    // A tier's policy reaches every account of that tier with none of its own.
    env.operator().set_pricing(PricingTarget::Tier(Tier::Standard), Some(MARGIN_120));
    assert_eq!(
        last_event(),
        json!({"standard": "pb-pool", "version": "1.0.0", "event": "set_pricing",
               "data": {"target": {"tier": "STANDARD"}, "pricing": {"lender": {"margin_bp": 120, "cap_bp": null}}}})
    );
    for account in ["a.testnet", "b.testnet"] {
        let view = env.pricing(account);
        assert_eq!((view.pricing, view.from), (MARGIN_120, PricingFrom::Tier));
    }
    assert_eq!(
        as_json(&env.params().tier_pricing),
        json!({"STANDARD": {"lender": {"margin_bp": 120, "cap_bp": null}}})
    );

    // An account's own policy wins, and the borrower view shows the one that applies.
    env.policy("a.testnet", CAPPED_AT_8);
    assert_eq!(
        last_event(),
        json!({"standard": "pb-pool", "version": "1.0.0", "event": "set_pricing",
               "data": {"target": {"account": "a.testnet"}, "pricing": {"lender": {"margin_bp": 0, "cap_bp": 800}}}})
    );
    let view = env.pricing("a.testnet");
    assert_eq!((view.pricing, view.from), (CAPPED_AT_8, PricingFrom::Account));
    assert_eq!(env.borrower("a.testnet").pricing, CAPPED_AT_8);
    assert_eq!(env.borrower("b.testnet").pricing, MARGIN_120);

    // An account follows its tier: on Watch, which has no policy, b pays pass-through.
    let tomorrow = U64(env.now + DAY);
    env.operator().set_tier_override(id("b.testnet"), Tier::Watch, "late statements".into(), tomorrow);
    let view = env.pricing("b.testnet");
    assert_eq!((view.pricing, view.from), (Pricing::PassThrough, PricingFrom::Default));
    env.operator().set_pricing(PricingTarget::Tier(Tier::Watch), Some(Pricing::Fixed { rate_bp: 900 }));
    assert_eq!(env.pricing("b.testnet").pricing, Pricing::Fixed { rate_bp: 900 });
    assert_eq!(env.params().tier_pricing.len(), 2);

    // Null clears a policy: the account falls back to its tier's, and the tier to pass-through.
    env.operator().set_pricing(PricingTarget::Account(id("a.testnet")), None);
    assert_eq!(last_event()["data"], json!({"target": {"account": "a.testnet"}, "pricing": null}));
    let view = env.pricing("a.testnet");
    assert_eq!((view.pricing, view.from), (MARGIN_120, PricingFrom::Tier));
    env.operator().set_pricing(PricingTarget::Tier(Tier::Standard), None);
    assert_eq!(env.pricing("a.testnet"), fresh);
    assert_eq!(as_json(&env.params().tier_pricing), json!({"WATCH": {"fixed": {"rate_bp": 900}}}));
}

#[test]
fn only_the_operator_sets_a_policy_and_only_a_valid_one_for_a_registered_account() {
    let mut env = Env::new(0);
    env.register("a.testnet");
    let account = || PricingTarget::Account(id("a.testnet"));
    env.refuses("only the operator can do this", |e| e.as_("a.testnet", 0).set_pricing(account(), Some(MARGIN_120)));
    env.refuses("only the operator can do this", |e| {
        e.as_(FACTORY, 0).set_pricing(PricingTarget::Tier(Tier::Standard), Some(MARGIN_120))
    });
    env.refuses("not a registered account", |e| {
        e.operator().set_pricing(PricingTarget::Account(id("stranger.testnet")), Some(MARGIN_120))
    });
    env.refuses("margin_bp must be between -10,000 and 10,000 bp", |e| {
        e.operator().set_pricing(account(), Some(Pricing::Lender { margin_bp: 10_001, cap_bp: None }))
    });
    env.refuses("cap_bp is capped at 10,000 bp", |e| {
        e.operator().set_pricing(account(), Some(Pricing::Lender { margin_bp: 0, cap_bp: Some(10_001) }))
    });
    env.refuses("rate_bp is capped at 10,000 bp", |e| {
        e.operator().set_pricing(PricingTarget::Tier(Tier::Watch), Some(Pricing::Fixed { rate_bp: 10_001 }))
    });
    assert_eq!(env.pricing("a.testnet").from, PricingFrom::Default);
}

#[test]
fn the_operator_sets_the_limits_and_the_funding_order_and_get_params_shows_them() {
    let mut env = Env::new(0);
    let params = env.params();
    assert_eq!((params.funding, params.pricing_limits), (FundingSettings::default(), PricingLimits::default()));
    let shown = as_json(&env.params());
    assert_eq!(shown["funding"], json!({"order": "cheapest", "loan_days": 90}));
    assert_eq!(
        shown["pricing_limits"],
        json!({"max_rate_bp": 6000, "avg_plus_bp": 500, "max_period_ns": 172_800_000_000_000u64,
               "min_period_ns": 600_000_000_000u64, "account_subsidy_day": "100000000", "pool_subsidy_day_bp": 5,
               "max_lender_debt": "1000000000000", "account_fee_day": "1000000000", "pool_fee_day_bp": 50})
    );
    assert_eq!(shown["tier_pricing"], json!({}));

    let funding = FundingSettings { order: FundingOrder::LenderFirst, loan_days: 30 };
    env.operator().set_funding(funding.clone());
    assert_eq!(
        last_event(),
        json!({"standard": "pb-pool", "version": "1.0.0", "event": "set_funding",
               "data": {"funding": {"order": "lender_first", "loan_days": 30}}})
    );
    assert_eq!(env.params().funding, funding);

    env.set_limits(|l| {
        l.account_subsidy_day = U128(usd(20));
        l.min_period_ns = MINUTE;
        l.max_lender_debt = U128(usd(250_000));
        l.account_fee_day = U128(usd(40));
        l.pool_fee_day_bp = 10;
    });
    assert_eq!(
        last_event(),
        json!({"standard": "pb-pool", "version": "1.0.0", "event": "set_pricing_limits",
               "data": {"limits": {"max_rate_bp": 6000, "avg_plus_bp": 500, "max_period_ns": 172_800_000_000_000u64,
                                   "min_period_ns": 60_000_000_000u64, "account_subsidy_day": "20000000",
                                   "pool_subsidy_day_bp": 5, "max_lender_debt": "250000000000",
                                   "account_fee_day": "40000000", "pool_fee_day_bp": 10}}})
    );
    let limits = env.params().pricing_limits;
    assert_eq!((limits.account_subsidy_day.0, limits.max_lender_debt.0), (usd(20), usd(250_000)));
    assert_eq!((limits.account_fee_day.0, limits.pool_fee_day_bp), (usd(40), 10));
    env.refuses("pool_fee_day_bp is a share of capital, capped at 10,000 bp", |e| {
        e.set_limits(|l| l.pool_fee_day_bp = 10_001)
    });

    // Wrong settings are refused with what to fix, and nobody else sets them.
    let none = FundingSettings { order: FundingOrder::Cheapest, loan_days: 0 };
    env.refuses("loan_days must be at least 1", |e| e.operator().set_funding(none));
    env.refuses("max_period_ns must be between 1 ns and a year", |e| e.set_limits(|l| l.max_period_ns = 0));
    env.refuses("min_period_ns must be between 1 ns and max_period_ns", |e| e.set_limits(|l| l.min_period_ns = 0));
    env.refuses("max_rate_bp is capped at 10,000 bp", |e| e.set_limits(|l| l.max_rate_bp = 10_001));
    env.refuses("only the operator can do this", |e| e.as_(FACTORY, 0).set_pricing_limits(PricingLimits::default()));
    env.refuses("only the operator can do this", |e| e.as_(FACTORY, 0).set_funding(FundingSettings::default()));
    assert_eq!(env.params().funding, funding);
}

// ---- Who may settle, and when ----

#[test]
fn only_a_registered_account_settles_or_claims_and_a_report_names_each_lender_once() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.refuses("not a registered account", |e| drop(e.settle("stranger.testnet", rhea())));
    env.refuses("not a registered account", |e| drop(e.settle(OPERATOR, rhea())));
    env.refuses("not a registered account", |e| e.claim("stranger.testnet"));
    env.refuses("not a registered account", |e| e.claim(OPERATOR));
    env.refuses("the report names rhea twice", |e| drop(e.settle("a.testnet", [rhea(), rhea()].concat())));
    env.refuses("the report names", |e| drop(e.settle("a.testnet", vec![line("compound", usd(1), 500, 400)])));
    // An account settles only itself: the report is booked on the caller.
    env.settled("a.testnet", rhea());
    assert_eq!(env.pricing("a.testnet").last, rhea());
}

#[test]
fn an_account_with_no_lender_debt_and_no_policy_has_nothing_to_settle() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.standard("a.testnet", usd(10_000));
    let before = (env.view(), env.pricing("a.testnet"));
    let why = "nothing to settle: no lender debt and no pricing policy";
    assert_eq!(env.skipped("a.testnet", vec![]), why);
    assert_eq!(env.skipped("a.testnet", vec![line("rhea", 0, 1_591, 1_032)]), why);
    assert_eq!(as_json(&env.settle("a.testnet", vec![])), json!({ "skipped": why }));
    assert!(get_logs().is_empty(), "a skipped settlement logs nothing");
    assert_eq!((env.view(), env.pricing("a.testnet")), before);
    assert!(env.pool.pricing.get(&id("a.testnet")).is_none(), "a skipped settlement stores nothing");
}

#[test]
fn pass_through_stores_each_report_and_books_nothing() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.standard("a.testnet", usd(10_000));
    let both = [aave(), rhea()].concat();
    // The first settlement only stores its report.
    let first = env.settled("a.testnet", both.clone());
    assert_eq!((first.fee.0, first.subsidy.0, first.credit.0, first.period_ns.0), (0, 0, 0, 0));
    env.now += HOUR;
    let debt = env.debt("a.testnet");
    let second = env.settled("a.testnet", both.clone());
    assert_eq!((second.fee.0, second.subsidy.0, second.cut.0, second.period_ns.0), (0, 0, 0, HOUR));
    assert_eq!(
        (second.debt.0, second.pricing.clone(), second.from),
        (debt, Pricing::PassThrough, PricingFrom::Default)
    );
    let sources: Vec<_> = second.parts.iter().map(|p| (p.source.as_str(), p.counted_bp, p.client_bp)).collect();
    assert_eq!(sources, [("aave", 533, 533), ("rhea", 1_591, 1_591), ("pool", 208, 208)]);
    let view = env.pricing("a.testnet");
    assert_eq!((view.settled_at.0, view.last, view.fees_charged.0, view.subsidy_paid.0), (env.now, both, 0, 0));
}

#[test]
fn a_settlement_too_soon_is_skipped_and_changes_nothing() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.standard("a.testnet", usd(10_000));
    env.policy("a.testnet", MARGIN_120);
    env.settled("a.testnet", aave());
    // Anyone may ask an account to settle, so the pool keeps two settlements 10 minutes apart.
    env.now += 5 * MINUTE;
    let before = (env.view(), env.pricing("a.testnet"), env.borrower("a.testnet"));
    let why = "too soon: this account settled 5 minutes ago, and two settlements are at least 10 minutes apart";
    assert_eq!(as_json(&env.settle("a.testnet", aave())), json!({ "skipped": why }));
    assert!(get_logs().is_empty(), "a skipped settlement logs nothing");
    assert_eq!((env.view(), env.pricing("a.testnet"), env.borrower("a.testnet")), before);
    env.now += 5 * MINUTE - 1;
    assert!(env.skipped("a.testnet", aave()).starts_with("too soon: this account settled 9 minutes ago"));
    // At 10 minutes it runs, for the whole 10 minutes: skipping cost the pool nothing.
    env.now += 1;
    let settled = env.settled("a.testnet", aave());
    assert_eq!((settled.period_ns.0, settled.fee.0), (10 * MINUTE, 12_938)); // $680.004 a year ÷ 52,560, rounded up

    // The operator can change the distance, and short ones read in seconds.
    env.set_limits(|l| l.min_period_ns = 90 * 1_000_000_000);
    env.now += 30 * 1_000_000_000;
    let why = "too soon: this account settled 30 seconds ago, and two settlements are at least 90 seconds apart";
    assert_eq!(env.skipped("a.testnet", aave()), why);
}

#[test]
fn a_borrow_at_a_lender_right_after_a_settlement_is_settled_not_skipped() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet"]);
    let small = vec![line("aave", usd(1_000), 533, 410)];
    for account in ["a.testnet", "b.testnet"] {
        env.policy(account, MARGIN_120);
        env.settled(account, small.clone());
    }
    // A minute later a's `l_borrow` step reports Aave's debt with the $55,667 it is about to borrow. That is far more
    // than interest could have added, so the 10 minutes don't apply.
    env.now += MINUTE;
    let settled = env.settled("a.testnet", aave());
    // The minute is charged on the larger debt, and the next period starts from it.
    assert_eq!((settled.period_ns.0, settled.fee.0), (MINUTE, 1_294)); // $680.004 a year ÷ 525,600, rounded up
    assert_eq!(settled.parts[0].debt.0, AAVE_PART);
    let view = env.pricing("a.testnet");
    assert_eq!((view.last, view.settled_at.0), (aave(), env.now));
    // The same report again shows nothing new, so it waits like any other.
    assert!(env.skipped("a.testnet", aave()).starts_with("too soon: this account settled 0 seconds ago"));

    // A first borrow at another lender counts too: Rhea owed nothing in the last report.
    let both = [small.clone(), rhea()].concat();
    let settled = env.settled("b.testnet", both.clone());
    assert_eq!((settled.period_ns.0, env.pricing("b.testnet").last), (MINUTE, both));

    // Even in the block of a settlement: there is nothing to charge yet, but the loan is on record from then on.
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.policy("a.testnet", MARGIN_120);
    env.settled("a.testnet", small);
    let settled = env.settled("a.testnet", aave());
    assert_eq!((settled.period_ns.0, settled.fee.0, env.pricing("a.testnet").last), (0, 0, aave()));
}

#[test]
fn a_client_who_borrows_at_a_lender_holds_and_repays_before_the_next_settlement_still_pays_the_margin() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.policy("a.testnet", MARGIN_120);
    // The keeper's hourly settlement finds $1,000 owed at Aave.
    let small = vec![line("aave", usd(1_000), 533, 410)];
    env.settled("a.testnet", small.clone());
    // A minute later the client borrows $55,667 more there. The step's report shows the $56,667 it will owe.
    env.now += MINUTE;
    let at_the_borrow = env.settled("a.testnet", aave());
    // The client holds the loan for 58 minutes and repays it with no fresh verdict, so nothing settles then. A minute
    // later the keeper finds $1,000 again.
    env.now += 59 * MINUTE;
    let hourly = env.settled("a.testnet", small);
    // The pool takes the larger of its two reports: the margin is charged on $56,667 for the whole hour.
    assert_eq!((hourly.period_ns.0, hourly.parts[0].debt.0), (59 * MINUTE, AAVE_PART));
    let paid = at_the_borrow.fee.0 + hourly.fee.0;
    assert!((AAVE_HOUR..=AAVE_HOUR + 1).contains(&paid), "the hour's fees were {paid}");
    assert_eq!(env.pricing("a.testnet").fees_charged.0, paid);
    // Had the borrow's report been skipped as too soon, both ends of the hour would have shown $1,000, and the
    // client would have paid the margin on that alone: 0.14 cents instead of 7.76.
    assert_eq!(usd(1_000) * 120 / 10_000 / 8_760, 1_369);
}

#[test]
fn a_report_whose_lender_debt_did_not_rise_is_still_skipped_inside_the_10_minutes() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.policy("a.testnet", MARGIN_120);
    env.settled("a.testnet", aave());
    env.now += 5 * MINUTE;
    let before = (env.view(), env.pricing("a.testnet"));
    let at_aave = |debt: u128| vec![line("aave", debt, 533, 410)];
    // The same debt; the debt with five minutes of Aave's own 5.33% (2.9 cents); less debt, after a repayment; and
    // no debt at all. None of them shows a borrow.
    let own_interest = AAVE_PART * 533 / 10_000 / 105_120 + 1;
    assert_eq!(own_interest, 28_733);
    for report in [aave(), at_aave(AAVE_PART + own_interest), at_aave(usd(1_000)), at_aave(0), vec![]] {
        let why = env.skipped("a.testnet", report);
        assert!(why.starts_with("too soon: this account settled 5 minutes ago"), "{why}");
    }
    // Interest is allowed up to the 60% a lender's rate can count at: 32 cents on $56,667 in five minutes. Up to
    // there a report is skipped, and nothing has changed.
    let most = AAVE_PART * 6_000 * 300 / (10_000 * 365 * 86_400) + 1;
    assert_eq!(most, 323_442);
    assert!(env.skipped("a.testnet", at_aave(AAVE_PART + most)).starts_with("too soon"));
    assert_eq!((env.view(), env.pricing("a.testnet")), before);
    // A micro-dollar more is a borrow, and settles.
    let settled = env.settled("a.testnet", at_aave(AAVE_PART + most + 1));
    assert_eq!(settled.period_ns.0, 5 * MINUTE);
}

// ---- A fee and a subsidy (INTERFACES.md 26's worked numbers, an hour of each) ----

#[test]
fn a_margin_on_a_cheap_lender_adds_a_fee_to_the_debt_which_the_exposures_follow_and_the_daily_window_does_not() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    // The loan rests on nBTC and on Hyperliquid, so both exposure records count all of it.
    let v = with_hl(with_share(verdict(Tier::Standard, usd(10_000)), "nBTC", 10_000), 1_000_000);
    env.borrow("a.testnet", usd(10_000), v);
    env.policy("a.testnet", MARGIN_120);
    env.settled("a.testnet", aave());
    env.now += HOUR;
    let (debt, before) = (env.debt("a.testnet"), env.view());

    // Aave lends $56,667 at 5.33% and the client pays 6.53%: $680.004 a year, 7.76 cents an hour.
    let settled = env.settled("a.testnet", aave());
    assert_eq!((settled.fee.0, settled.subsidy.0, settled.credit.0, settled.period_ns.0), (AAVE_HOUR, 0, 0, HOUR));
    let event = last_event();
    assert_eq!((event["event"].clone(), event["data"]["fee"].clone()), (json!("settle"), json!("77627")));

    // The fee is on the debt, and the pool's loans, capital and exposures follow it.
    about(env.debt("a.testnet"), debt + AAVE_HOUR);
    assert_eq!(settled.debt.0, env.debt("a.testnet"));
    let after = env.view();
    about(after.loans.0, before.loans.0 + AAVE_HOUR);
    about(after.capital.0, before.capital.0 + AAVE_HOUR);
    about(after.interest_earned.0, before.interest_earned.0 + AAVE_HOUR);
    about(after.wrappers["nBTC"].amount.0, before.wrappers["nBTC"].amount.0 + AAVE_HOUR);
    about(after.hyperliquid.amount.0, before.hyperliquid.amount.0 + AAVE_HOUR);
    assert_eq!(after.hyperliquid.amount.0, env.debt("a.testnet"));
    // No money was lent: the cash and the daily lending window are where they were.
    assert_eq!((after.cash, after.lent_24h), (before.cash, before.lent_24h));
    assert_eq!(after.lent_24h.0, usd(10_000) as i128);
    // The totals show it everywhere.
    assert_eq!((after.fees_charged.0, after.subsidy_paid.0, after.credit_owed.0), (AAVE_HOUR, 0, 0));
    let borrower = env.borrower("a.testnet");
    assert_eq!((borrower.fees_charged.0, borrower.subsidy_paid.0, borrower.credit.0), (AAVE_HOUR, 0, 0));
    assert_eq!(env.pricing("a.testnet").fees_charged.0, AAVE_HOUR);
}

#[test]
fn a_fee_on_an_account_that_owes_the_pool_nothing_becomes_its_debt() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    // The account borrowed and repaid, so the pool still holds its book data: $5M of nBTC on NEAR.
    env.borrow("a.testnet", usd(1_000), with_hold(verdict(Tier::Standard, usd(1_000)), "nBTC", 5_000_000));
    env.repay("a.testnet", usd(2_000));
    assert_eq!((env.debt("a.testnet"), env.view().book["nBTC"].amount.0), (0, 0));

    let lent = env.view().lent_24h;
    let settled = env.settled_after("a.testnet", MARGIN_120, aave(), HOUR);
    assert_eq!(settled.fee.0, AAVE_HOUR);
    let debt = env.debt("a.testnet");
    about(debt, AAVE_HOUR);
    // It is an account with a loan again, so its holdings are back in the book. Nothing was lent.
    let view = env.view();
    assert_eq!((view.loans.0, view.book["nBTC"].amount.0, view.lent_24h), (debt, usd(5_000_000), lent));
    // The fee is repaid like any debt.
    assert_eq!(env.repay("a.testnet", usd(1)), usd(1) - debt);
    assert_eq!(env.debt("a.testnet"), 0);
}

#[test]
fn a_cap_on_a_dear_lender_takes_a_subsidy_off_the_debt_and_opens_no_room_in_the_daily_window() {
    let mut env = Env::new(usd(1_000_000)); // the daily budget is 10%: $100k
    env.mature(&["a.testnet", "b.testnet"]);
    env.standard("a.testnet", usd(60_000));
    env.standard("b.testnet", usd(40_000));
    env.policy("a.testnet", CAPPED_AT_8);
    env.settled("a.testnet", rhea());
    env.now += HOUR;
    let (debt, before) = (env.debt("a.testnet"), env.view());
    // The day's lending is used up, give or take the hour's interest.
    env.refuses("daily budget", |e| e.standard("b.testnet", 300_000));

    // Rhea lends $50,667 at 15.91% and the client pays 8%: $4,007.76 a year, 45.75 cents an hour.
    let settled = env.settled("a.testnet", rhea());
    assert_eq!((settled.fee.0, settled.subsidy.0, settled.cut.0, settled.credit.0), (0, RHEA_HOUR, 0, 0));
    about(env.debt("a.testnet"), debt - RHEA_HOUR);
    assert_eq!(settled.debt.0, env.debt("a.testnet"));
    let after = env.view();
    about(after.loans.0, before.loans.0 - RHEA_HOUR);
    about(after.capital.0, before.capital.0 - RHEA_HOUR);
    assert_eq!((after.cash, after.lent_24h), (before.cash, before.lent_24h));
    assert_eq!((after.fees_charged.0, after.subsidy_paid.0, after.credit_owed.0), (0, RHEA_HOUR, 0));
    let borrower = env.borrower("a.testnet");
    assert_eq!((borrower.fees_charged.0, borrower.subsidy_paid.0, borrower.credit.0), (0, RHEA_HOUR, 0));

    // A subsidy isn't a repayment: had it been, these 30 cents would now fit in the day's budget.
    env.refuses("daily budget", |e| e.standard("b.testnet", 300_000));
    // A real repayment does open room.
    env.repay("a.testnet", usd(1));
    env.standard("b.testnet", 300_000);
}

#[test]
fn the_floor_keeps_a_subsidised_rate_at_the_lenders_deposit_rate() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.standard("a.testnet", usd(10_000));
    // With Rhea's real deposit rate of 10.32%, the client pays 10.32%, not 8%: $2,832.29 a year (INTERFACES.md 26).
    let report = vec![line("rhea", RHEA_PART, 1_591, 1_032)];
    let settled = env.settled_after("a.testnet", CAPPED_AT_8, report, HOUR);
    assert_eq!(settled.subsidy.0, 2_832_285_300 / 8_760);
    assert_eq!((settled.parts[0].counted_bp, settled.parts[0].client_bp), (1_591, 1_032));
}

#[test]
fn the_figure_that_favours_the_pool_is_taken_between_two_reports() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet"]);
    for account in ["a.testnet", "b.testnet"] {
        env.standard(account, usd(10_000));
    }
    // A subsidy: $1,000 at Rhea when the last report was stored and $50,667 now. It is worked out on $1,000.
    env.policy("a.testnet", CAPPED_AT_8);
    env.settled("a.testnet", vec![line("rhea", usd(1_000), 1_591, 0)]);
    // A fee: $56,667 at Aave when the last report was stored and $1,000 now. It is worked out on $56,667.
    env.policy("b.testnet", MARGIN_120);
    env.settled("b.testnet", aave());
    env.now += HOUR;
    let subsidy = env.settled("a.testnet", rhea());
    assert_eq!((subsidy.subsidy.0, subsidy.parts[0].debt.0), (usd(1_000) * 791 / 10_000 / 8_760, usd(1_000)));
    let fee = env.settled("b.testnet", vec![line("aave", usd(1_000), 533, 410)]);
    assert_eq!((fee.fee.0, fee.parts[0].debt.0), (AAVE_HOUR, AAVE_PART));
}

// ---- Credit ----

#[test]
fn a_subsidy_past_a_debt_of_zero_becomes_credit_which_capital_subtracts() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.standard("a.testnet", 100_000); // the account owes the pool 10 cents
    env.policy("a.testnet", CAPPED_AT_8);
    env.settled("a.testnet", rhea());
    env.now += HOUR;
    let (debt, before) = (env.debt("a.testnet"), env.view());
    assert!((100_000..100_010).contains(&debt));

    // 45.75 cents of subsidy: 10 cents clear the debt and the rest is credit.
    let settled = env.settled("a.testnet", rhea());
    let credit = RHEA_HOUR - debt;
    assert_eq!((settled.subsidy.0, settled.debt.0, settled.credit.0), (RHEA_HOUR, 0, credit));
    assert_eq!(env.debt("a.testnet"), 0);
    assert_eq!((env.pricing("a.testnet").credit.0, env.borrower("a.testnet").credit.0), (credit, credit));
    // Credit is money the pool owes: capital is cash plus loans less the credit.
    let after = env.view();
    assert_eq!((after.cash, after.loans.0, after.credit_owed.0), (before.cash, 0, credit));
    assert_eq!(after.capital.0, after.cash.0 - credit);
    assert_eq!(before.capital.0 - after.capital.0, RHEA_HOUR);
    assert_eq!(after.subsidy_paid.0, RHEA_HOUR);

    // The next subsidy goes to the credit whole, and a fee adds to the debt without touching the credit.
    env.now += HOUR;
    let settled = env.settled("a.testnet", rhea());
    assert_eq!((settled.subsidy.0, settled.credit.0), (RHEA_HOUR, credit + RHEA_HOUR));
    env.policy("a.testnet", Pricing::Lender { margin_bp: 120, cap_bp: None });
    env.now += HOUR;
    let settled = env.settled("a.testnet", rhea());
    assert!(settled.fee.0 > 0 && settled.debt.0 >= settled.fee.0);
    assert_eq!(settled.credit.0, credit + RHEA_HOUR);
    assert_eq!(env.view().credit_owed.0, credit + RHEA_HOUR);
}

#[test]
fn claim_credit_pays_the_account_in_usdc_and_a_failed_transfer_puts_the_credit_back() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet"]);
    env.refuses("no credit to claim", |e| e.claim("a.testnet"));
    env.settled_after("a.testnet", CAPPED_AT_8, rhea(), HOUR);
    env.refuses("no credit to claim", |e| e.claim("b.testnet"));
    let before = env.view();
    assert_eq!((before.credit_owed.0, before.cash.0), (RHEA_HOUR, usd(1_000_000)));

    // The claim takes the credit and the cash at once, so it can't be claimed twice while the transfer is on its way.
    env.claim("a.testnet");
    assert_eq!(
        last_event(),
        json!({"standard": "pb-pool", "version": "1.0.0", "event": "claim_credit",
               "data": {"account_id": "a.testnet", "amount": "457506"}})
    );
    // It pays with a plain `ft_transfer` on the lending token, with 1 yoctoNEAR. Never `ft_transfer_call` with the
    // loan message: the account contract would book that as a new loan.
    let receipts = get_created_receipts();
    assert_eq!(receipts[0].receiver_id, id(TOKEN));
    let MockAction::FunctionCallWeight { method_name, args, attached_deposit, prepaid_gas, .. } =
        &receipts[0].actions[0]
    else {
        panic!("the claim made no call to the token")
    };
    assert_eq!(method_name.as_slice(), b"ft_transfer");
    let args: serde_json::Value = serde_json::from_slice(args).unwrap();
    assert_eq!(args, json!({"receiver_id": "a.testnet", "amount": "457506", "memo": "credit"}));
    assert_eq!((attached_deposit.as_yoctonear(), prepaid_gas.as_tgas()), (1, 15));
    // Its own callback checks the transfer, and the two take 25 of the 40 TGas the account contract attaches.
    assert_eq!(receipts[1].receiver_id, id(POOL));
    let MockAction::FunctionCallWeight { method_name, prepaid_gas, .. } = &receipts[1].actions[0] else {
        panic!("the claim has no callback")
    };
    assert_eq!((method_name.as_slice(), prepaid_gas.as_tgas()), (&b"on_credit_paid"[..], 10));
    assert_eq!(receipts.len(), 2);
    let paid = env.view();
    assert_eq!((paid.credit_owed.0, paid.cash.0), (0, usd(1_000_000) - RHEA_HOUR));
    assert_eq!(paid.capital, before.capital, "paying credit doesn't change capital");
    assert_eq!(env.pricing("a.testnet").credit.0, 0);
    env.refuses("no credit to claim", |e| e.claim("a.testnet"));

    // The transfer failed: the credit and the cash are back.
    let back = env.as_(POOL, 0).on_credit_paid(id("a.testnet"), U128(RHEA_HOUR), Err(PromiseError::Failed));
    assert_eq!(back.0, 0);
    assert_eq!(
        last_event(),
        json!({"standard": "pb-pool", "version": "1.0.0", "event": "claim_credit_failed",
               "data": {"account_id": "a.testnet", "amount": "457506"}})
    );
    assert_eq!(env.view(), before);
    assert_eq!(env.pricing("a.testnet").credit.0, RHEA_HOUR);

    // It went through: the pool keeps the books as the claim left them.
    env.claim("a.testnet");
    let sent = env.as_(POOL, 0).on_credit_paid(id("a.testnet"), U128(RHEA_HOUR), Ok(()));
    assert_eq!(sent.0, RHEA_HOUR);
    assert_eq!((env.view().credit_owed.0, env.pricing("a.testnet").credit.0), (0, 0));
    // The totals keep what was given, claimed or not.
    assert_eq!((env.view().subsidy_paid.0, env.pricing("a.testnet").subsidy_paid.0), (RHEA_HOUR, RHEA_HOUR));
}

#[test]
fn neither_a_loan_nor_a_defund_takes_the_cash_behind_credit() {
    let mut env = Env::new(usd(1_000));
    env.mature(&["a.testnet", "b.testnet"]);
    env.open_budget();
    env.set_caps(|c| {
        c.max_utilisation_bp = 10_000;
        c.client_share_bp = 10_000;
    });
    env.settled_after("a.testnet", CAPPED_AT_8, rhea(), HOUR);
    assert_eq!(env.view().credit_owed.0, RHEA_HOUR);
    env.refuses("defund is limited to the pool's free cash", |e| {
        e.as_(OPERATOR, 1).defund(U128(usd(1_000) - RHEA_HOUR + 1)).detach()
    });
    env.refuses("the pool doesn't have that much cash", |e| e.standard("b.testnet", usd(1_000) - RHEA_HOUR + 1));
    env.as_(OPERATOR, 1).defund(U128(usd(1_000) - RHEA_HOUR)).detach();
    // What is left is exactly the credit, and the account can still claim it.
    assert_eq!((env.view().cash.0, env.view().capital.0), (RHEA_HOUR, 0));
    env.claim("a.testnet");
    assert_eq!(env.view().cash.0, 0);
}

#[test]
fn a_claim_waits_while_the_pools_cash_does_not_cover_it() {
    let mut env = Env::new(usd(1_000));
    env.mature(&["a.testnet"]);
    env.settled_after("a.testnet", CAPPED_AT_8, rhea(), HOUR);
    // The books say the cash is there; take it away underneath to stand for a pool that is fully lent.
    env.pool.cash = RHEA_HOUR - 1;
    env.refuses("the pool is short of cash right now", |e| e.claim("a.testnet"));
    env.pool.cash = RHEA_HOUR;
    env.claim("a.testnet");
    assert_eq!(env.view().cash.0, 0);
}

#[test]
fn a_paused_pool_and_a_blocked_account_settle_nothing_and_pay_no_credit() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.settled_after("a.testnet", CAPPED_AT_8, rhea(), HOUR);
    env.now += HOUR;
    let before = (env.view(), env.pricing("a.testnet"));

    env.operator().set_paused(true);
    assert_eq!(env.skipped("a.testnet", rhea()), "the pool is paused: settlements wait");
    env.refuses("the pool is paused: credit waits", |e| e.claim("a.testnet"));
    env.operator().set_paused(false);
    assert_eq!((env.view(), env.pricing("a.testnet")), before);

    // After a write-off the account is blocked: no more subsidies, and no credit paid out.
    env.standard("a.testnet", usd(1_000));
    env.operator().write_off(id("a.testnet"));
    assert_eq!(env.skipped("a.testnet", rhea()), "this account is blocked after a write-off");
    env.refuses("this account is blocked after a write-off", |e| e.claim("a.testnet"));
}

#[test]
fn a_write_off_takes_the_accounts_credit_off_the_loss() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.settled_after("a.testnet", CAPPED_AT_8, rhea(), HOUR);
    env.standard("a.testnet", usd(1_000));
    let (debt, before) = (env.debt("a.testnet"), env.view());
    assert_eq!(before.credit_owed.0, RHEA_HOUR);

    // The pool owes the account 45.75 cents and the account owes the pool $1,000: the loss is the difference.
    env.operator().write_off(id("a.testnet"));
    assert_eq!(last_event()["data"], json!({"account_id": "a.testnet", "amount": (debt - RHEA_HOUR).to_string()}));
    let after = env.view();
    assert_eq!((after.written_off.0, after.credit_owed.0, after.loans.0), (debt - RHEA_HOUR, 0, 0));
    assert_eq!(before.capital.0 - after.capital.0, debt - RHEA_HOUR);
    assert_eq!(env.pricing("a.testnet").credit.0, 0);
    // Unblocked after the operator's review, it has no credit left to claim.
    env.operator().unblock(id("a.testnet"));
    env.refuses("no credit to claim", |e| e.claim("a.testnet"));
}

// ---- A fixed rate, and our pool's own part (INTERFACES.md 30, point 1) ----

#[test]
fn a_fixed_rate_charges_663_dollars_a_year_on_the_aave_part_and_nothing_on_ours_when_the_tier_pays_the_same() {
    let mut env = sixty_percent_lent();
    env.set_limits(|l| l.max_period_ns = YEAR_NS as u64);
    let settled = env.settled_after("a.testnet", Pricing::Fixed { rate_bp: 650 }, aave(), YEAR_NS as u64);
    // Aave: $56,667 × (6.50% − 5.33%) = $663.0039. Ours: the tier paid 6.50% all year, which is the fixed rate.
    assert_eq!((settled.fee.0, settled.subsidy.0, settled.period_ns.0), (663_003_900, 0, YEAR_NS as u64));
    let [aave_part, pool_part] = &settled.parts[..] else { panic!("expected two parts: {:?}", settled.parts) };
    assert_eq!((aave_part.source.as_str(), aave_part.counted_bp, aave_part.client_bp), ("aave", 533, 650));
    assert_eq!((aave_part.fee.0, aave_part.subsidy.0), (663_003_900, 0));
    assert_eq!((pool_part.source.as_str(), pool_part.counted_bp, pool_part.client_bp), ("pool", 650, 650));
    assert_eq!((pool_part.fee.0, pool_part.subsidy.0), (0, 0));
    about(pool_part.debt.0, usd(200_000));
}

#[test]
fn a_fixed_rate_settles_our_part_against_what_the_pool_really_charged_either_way() {
    // The tier pays 6.5%. Fixed at 8%, the pool charges 1.5 points more on the $200k: $0.3425 an hour.
    let mut env = sixty_percent_lent();
    let settled = env.settled_after("a.testnet", Pricing::Fixed { rate_bp: 800 }, vec![], HOUR);
    assert!((342_466..=342_467).contains(&settled.fee.0), "the fee was {}", settled.fee.0);
    let pool_part = &settled.parts[0];
    assert_eq!((pool_part.source.as_str(), pool_part.counted_bp, pool_part.client_bp), ("pool", 650, 800));
    about(pool_part.debt.0, usd(200_000));

    // Fixed at 5%, the pool gives 1.5 points back.
    let mut env = sixty_percent_lent();
    let debt = env.debt("a.testnet");
    let settled = env.settled_after("a.testnet", Pricing::Fixed { rate_bp: 500 }, vec![], HOUR);
    assert_eq!((settled.fee.0, settled.subsidy.0), (0, 342_465));
    // Over the hour the client paid 6.5% and got 1.5 points back: the debt grew at 5%.
    let grown = env.debt("a.testnet") - debt;
    let at_5_percent = usd(200_000) * 500 / 10_000 / 8_760;
    assert!(grown.abs_diff(at_5_percent) <= 5, "the debt grew by {grown}, not about {at_5_percent}");

    // Under the other policies our part is never adjusted.
    for pricing in [Pricing::PassThrough, MARGIN_120, CAPPED_AT_8] {
        let mut env = sixty_percent_lent();
        let settled = env.settled_after("a.testnet", pricing, vec![], HOUR);
        assert_eq!((settled.fee.0, settled.subsidy.0), (0, 0));
    }
}

#[test]
fn borrowing_from_the_pool_just_before_a_settlement_earns_no_subsidy_on_debt_that_was_not_there() {
    // The pool is 41% lent, so Standard pays 5.075%, and a's fixed rate is 3%. a owes $10k for 59 minutes of the
    // hour and $200k for the last one.
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet", "c.testnet"]);
    env.open_budget();
    for (account, dollars) in [("a.testnet", 10_000), ("b.testnet", 200_000), ("c.testnet", 200_000)] {
        env.standard(account, usd(dollars));
    }
    env.policy("a.testnet", Pricing::Fixed { rate_bp: 300 });
    env.settled("a.testnet", vec![]);
    env.now += 59 * MINUTE;
    env.standard("a.testnet", usd(190_000));
    env.now += MINUTE;
    assert_eq!(env.view().rate_bp.standard, 650);

    // Had the settlement taken the debt and the rate at that moment, it would have paid 3.5 points on $200k for the
    // whole hour: 80 cents. The client really paid 5.075% on $10k for 59 minutes and 6.5% on $200k for one, so it
    // gets back what that was above 3%: under 4 cents.
    let naive = usd(200_000) * (650 - 300) / 10_000 / 8_760;
    assert_eq!(naive, 799_086);
    let settled = env.settled("a.testnet", vec![]);
    assert!((30_000..40_000).contains(&settled.subsidy.0), "the subsidy was {}", settled.subsidy.0);
    // The part shows the hour's average debt, $13,167, and the average rate the pool charged on it.
    let pool_part = &settled.parts[0];
    let average = (usd(10_000) * 59 + usd(200_000)) / 60;
    assert!(pool_part.debt.0.abs_diff(average) < 2_000, "the average debt was {}", pool_part.debt.0);
    assert!((540..=548).contains(&pool_part.counted_bp), "the pool's rate counted at {}", pool_part.counted_bp);
}

#[test]
fn repaying_the_pool_just_before_a_settlement_does_not_dodge_the_fee() {
    // a's fixed rate is 9% and its tier pays 6.5%. a owes $200k for 59 minutes of the hour, then repays $190k.
    let mut env = sixty_percent_lent();
    env.policy("a.testnet", Pricing::Fixed { rate_bp: 900 });
    env.settled("a.testnet", vec![]);
    env.now += 59 * MINUTE;
    env.repay("a.testnet", usd(190_000));
    env.now += MINUTE;

    // On the $10k left, the fee would be about 5 cents. On what a really owed, it is 2.5 points on an average of
    // $196,833 for the hour: 56 cents.
    let settled = env.settled("a.testnet", vec![]);
    let expected = (usd(200_000) * 59 + usd(10_000)) / 60 * 250 / 10_000 / 8_760;
    assert!(settled.fee.0.abs_diff(expected) <= expected / 100, "the fee was {}, not about {expected}", settled.fee.0);
    assert!(settled.fee.0 > 500_000);
}

#[test]
fn pushing_the_pools_rate_up_just_before_a_settlement_earns_no_extra_subsidy() {
    // As above: a owes $10k at 5.075% with a fixed rate of 3%. A minute before the settlement, two other accounts
    // borrow $240k each, which takes the pool to 89% lent and Standard to 27.8%.
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet", "c.testnet", "d.testnet", "e.testnet"]);
    env.open_budget();
    for (account, dollars) in [("a.testnet", 10_000), ("b.testnet", 200_000), ("c.testnet", 200_000)] {
        env.standard(account, usd(dollars));
    }
    env.policy("a.testnet", Pricing::Fixed { rate_bp: 300 });
    env.settled("a.testnet", vec![]);
    env.now += 59 * MINUTE;
    for account in ["d.testnet", "e.testnet"] {
        env.standard(account, usd(240_000));
    }
    env.now += MINUTE;
    assert_eq!(env.view().rate_bp.standard, 2_780);

    // At the rate of that moment the hour's subsidy would be 28 cents. The client paid 5.075% for 59 minutes and
    // 27.8% for one, 5.45% on average, and gets back what that was above 3%: under 3 cents.
    let naive = usd(10_000) * (2_780 - 300) / 10_000 / 8_760;
    assert_eq!(naive, 283_105);
    let settled = env.settled("a.testnet", vec![]);
    assert!((23_000..30_000).contains(&settled.subsidy.0), "the subsidy was {}", settled.subsidy.0);
    assert!((540..=550).contains(&settled.parts[0].counted_bp));
}

// ---- The limits (FUNDING.md 5.3) ----

#[test]
fn a_lenders_rate_counts_at_no_more_than_its_7_day_average_plus_5_points() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.policy("a.testnet", CAPPED_AT_8);
    // Seven days of Rhea at 15.91%, settled once a day: $10.98 of subsidy a day.
    env.settled("a.testnet", rhea());
    for _ in 0..6 {
        env.now += DAY;
        let settled = env.settled("a.testnet", rhea());
        assert_eq!((settled.subsidy.0, settled.parts[0].counted_bp), (RHEA_PART * 791 / 10_000 / 365, 1_591));
    }
    // On the eighth day one large depositor leaves and Rhea reads 45%. That report closes a day at 15.91%.
    let spike = vec![line("rhea", RHEA_PART, 4_500, 0)];
    env.now += DAY;
    assert_eq!(env.settled("a.testnet", spike.clone()).parts[0].counted_bp, 1_591);
    // An hour at 45%: the week's average is (7 × 15.91% + 45%) ÷ 8 = 19.54%, so the rate counts at 24.54%.
    env.now += HOUR;
    let settled = env.settled("a.testnet", spike);
    assert_eq!((settled.parts[0].counted_bp, settled.parts[0].client_bp), (2_454, 800));
    assert_eq!(settled.subsidy.0, RHEA_PART * (2_454 - 800) / 10_000 / 8_760); // 96 cents, not $2.14
}

#[test]
fn a_lenders_rate_never_counts_above_60_percent_in_a_settlement_or_in_its_average() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    let dear = vec![line("rhea", RHEA_PART, 7_500, 0)];
    let settled = env.settled_after("a.testnet", CAPPED_AT_8, dear.clone(), HOUR);
    assert_eq!((settled.parts[0].counted_bp, settled.parts[0].client_bp), (6_000, 800));
    assert_eq!(settled.subsidy.0, RHEA_PART * (6_000 - 800) / 10_000 / 8_760);
    // The report goes into the average at 60% too, so it can't lift the limit for the week after.
    let a = id("a.testnet");
    assert_eq!(env.pool.pricing.get(&a).unwrap().average_bp("rhea", env.now), Some(6_000));
    // The operator lowers the cap: it applies to the next settlement.
    env.set_limits(|l| l.max_rate_bp = 2_000);
    env.now += HOUR;
    let settled = env.settled("a.testnet", dear);
    assert_eq!(settled.parts[0].counted_bp, 2_000);
}

#[test]
fn a_subsidy_covers_at_most_48_hours_and_a_fee_all_the_time_since_the_last_settlement() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet"]);
    // A subsidy: 30 days with no settlement pay for 48 hours of them.
    let late = env.settled_after("a.testnet", CAPPED_AT_8, rhea(), 30 * DAY);
    assert_eq!((late.period_ns.0, late.subsidy.0), (48 * HOUR, RHEA_PART * 791 * 48 / (10_000 * 8_760)));
    // A fee: the margin is owed for all 30 days (research/audit.md, P5). $680.004 a year × 30 ÷ 365, rounded up.
    let late = env.settled_after("b.testnet", MARGIN_120, aave(), 30 * DAY);
    assert_eq!((late.period_ns.0, late.fee.0, late.cut.0), (30 * DAY, 55_890_740, 0));

    // The same for our pool's own part under a fixed rate. The tier pays 6.5% on the $200k. Fixed at 8%, the 1.5
    // points more are owed for all 30 days: $246.58.
    let mut env = sixty_percent_lent();
    let late = env.settled_after("a.testnet", Pricing::Fixed { rate_bp: 800 }, vec![], 30 * DAY);
    assert_eq!((late.period_ns.0, late.fee.0), (30 * DAY, 246_575_343));
    // Fixed at 5%, the 1.5 points less are given for 48 hours: $16.44.
    let mut env = sixty_percent_lent();
    let late = env.settled_after("a.testnet", Pricing::Fixed { rate_bp: 500 }, vec![], 30 * DAY);
    assert_eq!((late.period_ns.0, late.subsidy.0), (48 * HOUR, 16_438_356));
}

#[test]
fn the_audits_p3_case_a_report_of_17_5_trillion_dollars_at_a_lender_books_23_cents_and_stops_nothing() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet"]);
    env.standard("a.testnet", usd(10_000));
    env.policy("a.testnet", MARGIN_120);
    env.settled("a.testnet", aave());
    env.now += 10 * MINUTE;
    let before = env.view();

    // A wrong or compromised engine shows $17.5 trillion owed at Aave. Uncounted, the 1.2-point margin on it for
    // ten minutes was $3,995,434 on a $1M pool. The debt counts at $1,000,000, so the fee is 23 cents.
    let wrong = vec![line("aave", usd(17_500_000_000_000), 533, 410)];
    let settled = env.settled("a.testnet", wrong.clone());
    assert_eq!((settled.fee.0, settled.cut.0, settled.parts[0].debt.0), (228_311, 0, usd(1_000_000)));
    // Capital, the daily lending budget, the subsidy budget and every tier's rate are where they were.
    let after = env.view();
    assert!(
        after.capital.0 - before.capital.0 < usd(1),
        "capital went from {:?} to {:?}",
        before.capital,
        after.capital
    );
    assert!(after.daily_budget.0 - before.daily_budget.0 < usd(1));
    assert!(after.subsidy_left_24h.0 - before.subsidy_left_24h.0 < usd(1));
    assert_eq!((after.rate_bp.clone(), after.utilisation_bp), (before.rate_bp, before.utilisation_bp));

    // About 315 such fees used to overflow the pool's utilisation, and then every method stopped until a redeploy.
    // 320 more of them, ten minutes apart, add $73, and the pool lends, takes repayments and answers as before.
    for _ in 0..320 {
        env.now += 10 * MINUTE;
        assert_eq!(env.settled("a.testnet", wrong.clone()).fee.0, 228_311);
    }
    env.standard("b.testnet", usd(1_000));
    assert_eq!(env.repay("b.testnet", usd(2_000)), usd(1_000) - 1);
    let view = env.view();
    assert_eq!(view.fees_charged.0, 321 * 228_311);
    assert!(view.capital.0 < usd(1_000_100), "capital is {:?}", view.capital);
}

#[test]
fn an_accounts_subsidies_stop_at_100_dollars_in_24_hours() {
    let mut env = Env::new(usd(10_000_000)); // the pool's own budget is $5,000 a day: out of the way
    env.mature(&["a.testnet", "b.testnet"]);
    env.set_limits(|l| l.max_lender_debt = U128(usd(5_000_000)));
    // $5M at Rhea under the 8% cap earns $45.15 an hour.
    let big = vec![line("rhea", usd(5_000_000), 1_591, 0)];
    let hour = usd(5_000_000) * 791 / 10_000 / 8_760;
    assert_eq!(hour, 45_148_401);
    for account in ["a.testnet", "b.testnet"] {
        env.policy(account, CAPPED_AT_8);
        env.settled(account, big.clone());
    }
    let hourly = |env: &mut Env| {
        env.now += HOUR;
        let s = env.settled("a.testnet", big.clone());
        (s.subsidy.0, s.cut.0)
    };
    assert_eq!(hourly(&mut env), (hour, 0));
    assert_eq!(hourly(&mut env), (hour, 0));
    // The third hour would take the day past $100: it is cut to the $9.70 left, and the cut isn't owed later.
    assert_eq!(hourly(&mut env), (usd(100) - 2 * hour, 3 * hour - usd(100)));
    assert_eq!(hourly(&mut env), (0, hour));
    let view = env.pricing("a.testnet");
    assert_eq!((view.subsidy_paid.0, view.credit.0), (usd(100), usd(100)));
    // The limit is each account's own: b still gets its hours.
    env.now += HOUR;
    assert_eq!(env.settled("b.testnet", big.clone()).subsidy.0, usd(100));
    // A day later a's budget is whole again: the 26 hours since its last settlement earn $1,173.86, cut to $100.
    env.now += DAY + HOUR;
    let s = env.settled("a.testnet", big.clone());
    assert_eq!((s.subsidy.0, s.cut.0), (usd(100), usd(5_000_000) * 791 * 26 / (10_000 * 8_760) - usd(100)));
    assert_eq!(env.pricing("a.testnet").subsidy_paid.0, usd(200));
}

#[test]
fn the_pools_subsidies_stop_at_5_bp_of_its_capital_in_24_hours() {
    let mut env = Env::new(usd(100_000)); // 5 bp of $100k is $50 a day
    env.mature(&["a.testnet", "b.testnet"]);
    env.set_limits(|l| l.max_lender_debt = U128(usd(5_000_000)));
    assert_eq!(env.view().subsidy_left_24h.0, usd(50));
    let big = vec![line("rhea", usd(5_000_000), 1_591, 0)];
    let hour = 45_148_401;
    for account in ["a.testnet", "b.testnet"] {
        env.policy(account, CAPPED_AT_8);
        env.settled(account, big.clone());
    }
    env.now += HOUR;
    // a's hour fits. It becomes credit, which comes off capital, so the budget is a hair under $50 now.
    let s = env.settled("a.testnet", big.clone());
    assert_eq!((s.subsidy.0, s.cut.0), (hour, 0));
    let left = env.view().subsidy_left_24h.0;
    assert_eq!(left, (usd(100_000) - hour) * 5 / 10_000 - hour);
    // b's hour is cut to what is left of the pool's budget, though b's own budget is untouched.
    let s = env.settled("b.testnet", big.clone());
    assert_eq!((s.subsidy.0, s.cut.0), (left, hour - left));
    assert_eq!(env.view().subsidy_left_24h.0, 0);
    env.now += HOUR;
    for account in ["a.testnet", "b.testnet"] {
        let s = env.settled(account, big.clone());
        assert_eq!((s.subsidy.0, s.cut.0, s.fee.0), (0, hour, 0));
    }
    assert_eq!(env.view().subsidy_paid.0, hour + left);
    // A fee is never cut.
    env.policy("a.testnet", MARGIN_120);
    env.now += HOUR;
    assert!(env.settled("a.testnet", big.clone()).fee.0 > 0);
    // A day later the budget is back: b's 26 hours earn $1,173.86, cut to the pool's $49.98.
    env.now += DAY + HOUR;
    let left = env.view().subsidy_left_24h.0;
    assert!(left > usd(49) && left < usd(50));
    let s = env.settled("b.testnet", big);
    assert_eq!((s.subsidy.0, s.cut.0), (left, usd(5_000_000) * 791 * 26 / (10_000 * 8_760) - left));
}

#[test]
fn an_accounts_fees_stop_at_1000_dollars_in_24_hours() {
    let mut env = Env::new(usd(10_000_000)); // the pool's own fee budget is $50,000 a day: out of the way
    env.mature(&["a.testnet", "b.testnet"]);
    // $1M at Aave, the most that counts, under a 100-point margin: $114.16 an hour.
    let full = Pricing::Lender { margin_bp: 10_000, cap_bp: None };
    let big = vec![line("aave", usd(1_000_000), 533, 410)];
    let hour = usd(1_000_000).div_ceil(8_760);
    assert_eq!(hour, 114_155_252);
    for account in ["a.testnet", "b.testnet"] {
        env.policy(account, full.clone());
        env.settled(account, big.clone());
    }
    let hourly = |env: &mut Env| {
        env.now += HOUR;
        let s = env.settled("a.testnet", big.clone());
        (s.fee.0, s.cut.0, s.subsidy.0)
    };
    for _ in 0..8 {
        assert_eq!(hourly(&mut env), (hour, 0, 0));
    }
    // The ninth hour would take the day past $1,000: it is cut to the $86.76 left, and the cut isn't owed later.
    assert_eq!(hourly(&mut env), (usd(1_000) - 8 * hour, 9 * hour - usd(1_000), 0));
    let before = env.debt("a.testnet");
    assert_eq!(hourly(&mut env), (0, hour, 0));
    // A fee that is cut to nothing leaves the debt to its own interest, and still stores the report.
    assert!(env.debt("a.testnet") - before < usd(1));
    let view = env.pricing("a.testnet");
    assert_eq!((view.fees_charged.0, view.settled_at.0), (usd(1_000), env.now));
    let debt = env.debt("a.testnet");
    assert!(debt >= usd(1_000) && debt < usd(1_001), "a owes {debt}");
    // The limit is each account's own: b is charged for its 11 hours, $1,255.71, cut to its own $1,000.
    env.now += HOUR;
    let s = env.settled("b.testnet", big.clone());
    let eleven_hours = (usd(1_000_000) * 11).div_ceil(8_760);
    assert_eq!((s.fee.0, s.cut.0, s.period_ns.0), (usd(1_000), eleven_hours - usd(1_000), 11 * HOUR));
    // A day later a's budget is whole again: the 26 hours since its last settlement cost $2,968.04, cut to $1,000.
    env.now += DAY + HOUR;
    let s = env.settled("a.testnet", big.clone());
    assert_eq!((s.fee.0, s.cut.0), (usd(1_000), (usd(1_000_000) * 26).div_ceil(8_760) - usd(1_000)));
    assert_eq!(env.pricing("a.testnet").fees_charged.0, usd(2_000));
    // The subsidy budget is another one, and it is untouched.
    assert_eq!(env.view().subsidy_left_24h.0, env.view().capital.0 * 5 / 10_000);
}

#[test]
fn the_pools_fees_stop_at_50_bp_of_its_capital_in_24_hours() {
    let mut env = Env::new(usd(100_000)); // 50 bp of $100k is $500 a day
    let accounts = ["a.testnet", "b.testnet", "c.testnet"];
    env.mature(&accounts);
    let full = Pricing::Lender { margin_bp: 10_000, cap_bp: None };
    let big = vec![line("aave", usd(1_000_000), 533, 410)];
    let hour = 114_155_252;
    for account in accounts {
        env.policy(account, full.clone());
        env.settled(account, big.clone());
    }
    // What is left of the pool's budget before a settlement: 50 bp of its capital, less the fees of the last 24
    // hours. A fee is income, so the budget grows a hair with each one.
    let left = |env: &mut Env, charged: u128| env.view().capital.0 * 50 / 10_000 - charged;
    env.now += HOUR;
    // The first hour: all three fit, $342.47.
    for account in accounts {
        let s = env.settled(account, big.clone());
        assert_eq!((s.fee.0, s.cut.0), (hour, 0));
    }
    // The second hour: a's fits, b's is cut to what is left of the pool's budget though b's own is far from used,
    // and c's is cut to nothing.
    env.now += HOUR;
    assert_eq!(env.settled("a.testnet", big.clone()).fee.0, hour);
    let room = left(&mut env, 4 * hour);
    assert!(room > usd(45) && room < usd(46), "the pool's fee budget has {room} left");
    let s = env.settled("b.testnet", big.clone());
    assert_eq!((s.fee.0, s.cut.0), (room, hour - room));
    // b's fee is capital too, so c finds 50 bp of it left: 23 cents of its $114.16.
    let crumb = left(&mut env, 4 * hour + room);
    assert!(crumb > 0 && crumb < usd(1), "the pool's fee budget has {crumb} left");
    let s = env.settled("c.testnet", big.clone());
    assert_eq!((s.fee.0, s.cut.0, s.subsidy.0), (crumb, hour - crumb, 0));
    assert_eq!(env.view().fees_charged.0, 4 * hour + room + crumb);
    // So one day's fees move capital by half a percent at most, however wrong the reports are.
    assert!(env.view().capital.0 < usd(100_000) + usd(503));
    // A subsidy is never cut by the fee budget.
    env.policy("c.testnet", CAPPED_AT_8);
    let dear = vec![line("rhea", RHEA_PART, 1_591, 0)];
    env.now += HOUR;
    env.settled("c.testnet", dear.clone());
    env.now += HOUR;
    assert_eq!(env.settled("c.testnet", dear).subsidy.0, RHEA_HOUR);
    // A day later the budget is back: a's 27 hours cost $3,082.19, cut to its own $1,000, which the pool's budget
    // cuts again to its $502.
    env.now += DAY + HOUR;
    let room = left(&mut env, 0);
    assert!(room > usd(502) && room < usd(503));
    let s = env.settled("a.testnet", big.clone());
    assert_eq!((s.fee.0, s.cut.0), (room, (usd(1_000_000) * 27).div_ceil(8_760) - room));
}

#[test]
fn the_budgets_hold_when_the_operator_lifts_the_limit_on_a_lenders_debt() {
    // research/audit.md, P3, with the first limit out of the way: the report's $17.5 trillion counts in full.
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet"]);
    env.set_limits(|l| l.max_lender_debt = U128(usd(100_000_000_000_000)));
    let wrong = vec![line("aave", usd(17_500_000_000_000), 533, 410)];
    for account in ["a.testnet", "b.testnet"] {
        env.policy(account, MARGIN_120);
        env.settled(account, aave());
    }
    env.now += 10 * MINUTE;
    // The margin on it for ten minutes is $3,995,434. The account's budget lets $1,000 of it through.
    let s = env.settled("a.testnet", wrong.clone());
    assert_eq!((s.fee.0, s.cut.0), (usd(1_000), 3_995_433_789_955 - usd(1_000)));
    // The pool's budget is 50 bp of $1M: $5,000 a day, however many accounts report wrongly. Here b's ten minutes
    // and then a whole day of both, every ten minutes.
    assert_eq!(env.settled("b.testnet", wrong.clone()).fee.0, usd(1_000));
    for _ in 0..144 {
        env.now += 10 * MINUTE;
        for account in ["a.testnet", "b.testnet"] {
            env.settled(account, wrong.clone());
        }
    }
    let view = env.view();
    assert_eq!(view.fees_charged.0, usd(2_000), "a day and ten minutes of wrong reports");
    assert!(view.capital.0 < usd(1_002_001));
    // And the operator takes it all back: what is left is a day's interest on the $2,000.
    for account in ["a.testnet", "b.testnet"] {
        let charged = env.pricing(account).fees_charged;
        env.operator().reverse_fee(id(account), charged);
    }
    let view = env.view();
    assert_eq!(view.fees_reversed, view.fees_charged);
    assert!(view.loans.0 < usd(1) && view.capital.0 < usd(1_000_001), "loans {:?}", view.loans);
}

#[test]
fn the_operator_takes_a_wrong_fee_back_within_the_fees_charged_and_the_debt() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet"]);
    env.standard("a.testnet", usd(10_000));
    // Thirty days of a 1.2-point margin on $56,667 at Aave: a fee of $55.89 on each account.
    let fee = 55_890_740;
    for account in ["a.testnet", "b.testnet"] {
        env.policy(account, MARGIN_120);
        env.settled(account, aave());
    }
    env.now += 30 * DAY;
    for account in ["a.testnet", "b.testnet"] {
        assert_eq!(env.settled(account, aave()).fee.0, fee);
    }
    let (debt, before) = (env.debt("a.testnet"), env.view());

    // Only the operator, for a registered account, and for no more than was charged.
    env.refuses("only the operator can do this", |e| e.as_("a.testnet", 0).reverse_fee(id("a.testnet"), U128(1)));
    env.refuses("only the operator can do this", |e| e.as_(FACTORY, 0).reverse_fee(id("a.testnet"), U128(1)));
    env.refuses("not a registered account", |e| e.operator().reverse_fee(id("stranger.testnet"), U128(1)));
    env.refuses("amount must be positive", |e| e.operator().reverse_fee(id("a.testnet"), U128(0)));
    let too_much = "that is more than the fees charged to this account, less those already reversed";
    env.refuses(too_much, |e| e.operator().reverse_fee(id("a.testnet"), U128(fee + 1)));

    // $50 of it comes off the debt. No cash moves, and the daily lending window stays where it was: it is not a
    // repayment.
    env.operator().reverse_fee(id("a.testnet"), U128(usd(50)));
    let event = last_event();
    let after_debt = env.debt("a.testnet");
    assert_eq!(
        event,
        json!({"standard": "pb-pool", "version": "1.0.0", "event": "reverse_fee",
               "data": {"account_id": "a.testnet", "amount": "50000000", "debt": after_debt.to_string()}})
    );
    assert!(after_debt + usd(50) >= debt && after_debt + usd(50) <= debt + 2, "{debt} less $50 gave {after_debt}");
    let after = env.view();
    assert_eq!((after.cash, after.lent_24h), (before.cash, before.lent_24h));
    about(after.loans.0 + usd(50), before.loans.0);
    about(after.capital.0 + usd(50), before.capital.0);
    // The totals keep what was charged and show what was taken back, for the pool and for the account.
    assert_eq!((after.fees_charged.0, after.fees_reversed.0), (2 * fee, usd(50)));
    let view = env.pricing("a.testnet");
    assert_eq!((view.fees_charged.0, view.fees_reversed.0), (fee, usd(50)));
    assert_eq!(as_json(&view)["fees_reversed"], "50000000");
    assert_eq!(as_json(&after)["fees_reversed"], "50000000");
    assert_eq!(env.pricing("b.testnet").fees_reversed.0, 0);

    // What is left to reverse is the fee less the $50, and not a micro-dollar more.
    env.refuses(too_much, |e| e.operator().reverse_fee(id("a.testnet"), U128(fee - usd(50) + 1)));
    env.operator().reverse_fee(id("a.testnet"), U128(fee - usd(50)));
    assert_eq!(env.pricing("a.testnet").fees_reversed.0, fee);
    env.refuses(too_much, |e| e.operator().reverse_fee(id("a.testnet"), U128(1)));
    about(env.debt("a.testnet"), debt - fee);

    // b owed nothing but its fee, and has repaid $40 of it. Only what it still owes can come off.
    env.repay("b.testnet", usd(40));
    let owed = env.debt("b.testnet");
    assert!(owed < fee);
    env.refuses("that is more than the account owes the pool", |e| {
        e.operator().reverse_fee(id("b.testnet"), U128(owed + 1))
    });
    env.operator().reverse_fee(id("b.testnet"), U128(owed));
    assert_eq!(last_event()["data"], json!({"account_id": "b.testnet", "amount": owed.to_string(), "debt": "0"}));
    assert_eq!((env.debt("b.testnet"), env.pricing("b.testnet").fees_reversed.0), (0, owed));
    env.refuses("that is more than the account owes the pool", |e| e.operator().reverse_fee(id("b.testnet"), U128(1)));
    assert_eq!(env.view().fees_reversed.0, fee + owed);
    // It works on a paused pool: the operator pauses first, then corrects.
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.settled_after("a.testnet", MARGIN_120, aave(), HOUR);
    env.operator().set_paused(true);
    env.operator().reverse_fee(id("a.testnet"), U128(AAVE_HOUR));
    assert!(env.debt("a.testnet") <= 2, "what is left is the rounding of the fee's own booking");
}

// ---- The two ends of a period (INTERFACES.md 45.1, point 4; research/audit.md, P4) ----

#[test]
fn the_audits_p4_case_a_lender_repaid_and_borrowed_from_again_earns_no_subsidy_for_the_gap() {
    // Under an 8% cap with Rhea at 15.91%: borrow $50,667 at Rhea, repay it two blocks later, and borrow again 47
    // hours later. Rhea was owed nothing in between.
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["old.testnet", "new.testnet"]);
    let nothing = vec![line("rhea", 0, 1_591, 0)];
    for account in ["old.testnet", "new.testnet"] {
        env.policy(account, CAPPED_AT_8);
    }
    // The first borrow. An account from before reports one figure, the debt with the borrow. A new account also
    // passes what stood before it.
    env.settled("old.testnet", rhea());
    env.settled_closing("new.testnet", rhea(), nothing.clone());
    // Both repay Rhea with no fresh verdict, so nothing settles then. 47 hours later both borrow again.
    env.now += 47 * HOUR;
    // The old account's report shows $50,667 at both ends of the period, so the pool pays 7.91 points on it for 47
    // hours: $21.50, for interest the client never paid Rhea.
    let old = env.settled("old.testnet", rhea());
    assert_eq!((old.subsidy.0, old.parts[0].debt.0), (RHEA_PART * 791 * 47 / (10_000 * 8_760), RHEA_PART));
    assert_eq!(old.subsidy.0, 21_502_820);
    // The new account's period closes on the debt before the borrow, which is nothing: no subsidy for the gap.
    let new = env.settled_closing("new.testnet", rhea(), nothing.clone());
    assert_eq!((new.subsidy.0, new.fee.0, new.cut.0, new.period_ns.0), (0, 0, 0, 47 * HOUR));
    assert_eq!((new.parts[0].source.as_str(), new.parts[0].debt.0), ("rhea", 0));
    // The next period starts from the report with the borrow, and an hour of it earns an hour's subsidy.
    assert_eq!(env.pricing("new.testnet").last, rhea());
    env.now += HOUR;
    assert_eq!(env.settled("new.testnet", rhea()).subsidy.0, RHEA_HOUR);
}

#[test]
fn a_borrow_that_reports_the_debt_before_it_is_charged_no_margin_for_the_time_it_owed_the_lender_nothing() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["old.testnet", "new.testnet"]);
    let nothing = vec![line("aave", 0, 533, 410)];
    for account in ["old.testnet", "new.testnet"] {
        env.policy(account, MARGIN_120);
        // The keeper's settlement after the client repaid Aave: the pool holds a zero.
        env.settled(account, nothing.clone());
    }
    // Six days later the client borrows $56,667 there again.
    env.now += 6 * DAY;
    // One figure for both ends: the larger debt is the new loan, so the margin is charged for six days in which
    // Aave was owed nothing. $680.004 a year × 6 ÷ 365 is $11.18.
    let old = env.settled("old.testnet", aave());
    assert_eq!((old.fee.0, old.parts[0].debt.0), (11_178_148, AAVE_PART));
    // Both figures: the period closes on nothing owed, and nothing is charged.
    let new = env.settled_closing("new.testnet", aave(), nothing.clone());
    assert_eq!((new.fee.0, new.subsidy.0, new.parts[0].debt.0), (0, 0, 0));
    assert_eq!(env.pricing("new.testnet").last, aave());
    // From the borrow on the margin runs on the loan, as for anyone.
    env.now += HOUR;
    assert_eq!(env.settled("new.testnet", aave()).fee.0, AAVE_HOUR);
}

#[test]
fn closes_is_checked_as_the_report_is_and_a_borrow_with_it_is_never_too_soon() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.policy("a.testnet", MARGIN_120);
    let small = vec![line("aave", usd(1_000), 533, 410)];
    env.settled("a.testnet", small.clone());
    // `closes` names each lender once, and only "aave" or "rhea".
    env.refuses("the report names aave twice", |e| {
        drop(e.as_("a.testnet", 0).settle(aave(), Some([small.clone(), small.clone()].concat())))
    });
    env.refuses("the report names", |e| {
        drop(e.as_("a.testnet", 0).settle(aave(), Some(vec![line("compound", 0, 500, 400)])))
    });
    env.refuses("the report names rhea twice", |e| {
        drop(e.as_("a.testnet", 0).settle([rhea(), rhea()].concat(), Some(small.clone())))
    });
    // A minute after a settlement, a borrow's report shows new debt, so it settles: the minute is charged on the
    // $1,000 that was there, and the next period starts from the $56,667.
    env.now += MINUTE;
    let settled = env.settled_closing("a.testnet", aave(), small.clone());
    assert_eq!((settled.period_ns.0, settled.parts[0].debt.0), (MINUTE, usd(1_000)));
    assert_eq!(settled.fee.0, (usd(1_000) * 120).div_ceil(10_000 * 525_600)); // 23 micro-dollars
    assert_eq!(env.pricing("a.testnet").last, aave());
    // With no new debt in `report`, the 10 minutes hold whatever `closes` says.
    env.now += MINUTE;
    let answer = env.as_("a.testnet", 0).settle(aave(), Some(small.clone()));
    assert!(matches!(answer, SettleAnswer::Skipped { skipped } if skipped.starts_with("too soon")));
    // An account with no record, no policy and no debt in either report still has nothing to settle.
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    let none = vec![line("aave", 0, 533, 410)];
    let answer = env.as_("a.testnet", 0).settle(none.clone(), Some(none));
    assert_eq!(as_json(&answer), json!({"skipped": "nothing to settle: no lender debt and no pricing policy"}));
}

#[test]
fn a_pool_that_pays_no_subsidy_at_all_still_charges_fees() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet", "b.testnet"]);
    env.set_limits(|l| l.pool_subsidy_day_bp = 0);
    assert_eq!(env.view().subsidy_left_24h.0, 0);
    let s = env.settled_after("a.testnet", CAPPED_AT_8, rhea(), HOUR);
    assert_eq!((s.subsidy.0, s.cut.0, s.credit.0), (0, RHEA_HOUR, 0));
    assert_eq!(env.settled_after("b.testnet", MARGIN_120, aave(), HOUR).fee.0, AAVE_HOUR);
}

#[test]
fn a_report_too_large_to_work_out_is_skipped_not_a_panic() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.standard("a.testnet", usd(10_000));
    let absurd = vec![line("aave", u128::MAX, 533, 410)];
    env.policy("a.testnet", MARGIN_120);
    // A lender's debt counts at $1,000,000 at most, so this can only happen once the operator lifts that limit.
    env.set_limits(|l| l.max_lender_debt = U128(u128::MAX));
    // Not even as an account's first report.
    assert_eq!(env.skipped("a.testnet", absurd.clone()), "the amounts are too large to settle");
    assert_eq!(env.pricing("a.testnet").settled_at.0, 0);
    env.settled("a.testnet", aave());
    env.now += HOUR;
    let before = (env.pricing("a.testnet"), env.debt("a.testnet"));
    assert_eq!(env.skipped("a.testnet", absurd), "the amounts are too large to settle");
    assert_eq!((env.pricing("a.testnet"), env.debt("a.testnet")), before);
    // The next good report settles from the last one stored, for all the time since.
    env.now += HOUR;
    let settled = env.settled("a.testnet", aave());
    assert_eq!((settled.period_ns.0, settled.fee.0), (2 * HOUR, 155_253)); // $680.004 a year ÷ 4,380, rounded up
}

#[test]
fn a_pool_account_short_of_near_for_storage_skips_the_settlement_rather_than_fail_it() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.standard("a.testnet", usd(10_000));
    env.policy("a.testnet", MARGIN_120);
    // The pool account holds 3 NEAR and its storage locks 3.07: storing one more record would fail the call, and
    // with it the account's step at the lender.
    install_holding(take_storage(), "a.testnet", 3, env.now);
    let answer = env.pool.settle(aave(), None);
    let why = "the pool account is short of NEAR for storage: the operator must top it up";
    assert_eq!(as_json(&answer), json!({ "skipped": why }));
    assert_eq!(env.pricing("a.testnet").settled_at.0, 0);
    // With 4 NEAR it settles.
    install_holding(take_storage(), "a.testnet", 4, env.now);
    assert!(matches!(env.pool.settle(aave(), None), SettleAnswer::Settled(_)));
    assert_eq!(env.pricing("a.testnet").settled_at.0, env.now);
}

// ---- The answers and the event, as the account contract, the keeper and the backend read them ----

#[test]
fn the_settlement_answer_the_event_and_the_views_read_as_interfaces_26_says() {
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    env.standard("a.testnet", usd(10_000));
    let report = vec![line("rhea", RHEA_PART, 1_591, 1_032)];
    env.policy("a.testnet", CAPPED_AT_8);
    let first = env.settle("a.testnet", report.clone());
    let debt = env.debt("a.testnet").to_string();
    assert_eq!(
        as_json(&first),
        json!({"fee": "0", "subsidy": "0", "credit": "0", "period_ns": "0", "cut": "0", "debt": debt,
               "pricing": {"lender": {"margin_bp": 0, "cap_bp": 800}}, "from": "account",
               "parts": [{"source": "rhea", "debt": "0", "counted_bp": 1591, "client_bp": 1032,
                          "fee": "0", "subsidy": "0"},
                         {"source": "pool", "debt": "0", "counted_bp": 208, "client_bp": 208,
                          "fee": "0", "subsidy": "0"}]})
    );
    env.now += HOUR;
    let second = env.settle("a.testnet", report);
    let event = last_event();
    let debt = env.debt("a.testnet").to_string();
    let answer = json!({"fee": "0", "subsidy": "323320", "credit": "0", "period_ns": "3600000000000", "cut": "0",
                        "debt": debt, "pricing": {"lender": {"margin_bp": 0, "cap_bp": 800}}, "from": "account",
                        "parts": [{"source": "rhea", "debt": "50667000000", "counted_bp": 1591, "client_bp": 1032,
                                   "fee": "0", "subsidy": "323320"},
                                  {"source": "pool", "debt": "10000000001", "counted_bp": 208, "client_bp": 208,
                                   "fee": "0", "subsidy": "0"}]});
    assert_eq!(as_json(&second), answer);
    // The event carries the same, with the account.
    let mut data = answer.clone();
    data["account_id"] = json!("a.testnet");
    assert_eq!(event, json!({"standard": "pb-pool", "version": "1.0.0", "event": "settle", "data": data}));

    assert_eq!(
        as_json(&env.pricing("a.testnet")),
        json!({"pricing": {"lender": {"margin_bp": 0, "cap_bp": 800}}, "from": "account", "fees_charged": "0",
               "fees_reversed": "0", "subsidy_paid": "323320", "credit": "0", "settled_at": env.now.to_string(),
               "last": [{"lender": "rhea", "debt": "50667000000", "rate_bp": 1591, "supply_bp": 1032}]})
    );
    let pool = as_json(&env.view());
    let shown = json!({"fees_charged": pool["fees_charged"], "fees_reversed": pool["fees_reversed"],
                       "subsidy_paid": pool["subsidy_paid"], "subsidy_left_24h": pool["subsidy_left_24h"],
                       "credit_owed": pool["credit_owed"]});
    let left = (env.view().capital.0 * 5 / 10_000 - 323_320).to_string();
    assert_eq!(
        shown,
        json!({"fees_charged": "0", "fees_reversed": "0", "subsidy_paid": "323320", "subsidy_left_24h": left,
               "credit_owed": "0"})
    );
    let borrower = as_json(&env.borrower("a.testnet"));
    let shown = json!({"pricing": borrower["pricing"], "fees_charged": borrower["fees_charged"],
                       "subsidy_paid": borrower["subsidy_paid"], "credit": borrower["credit"]});
    assert_eq!(
        shown,
        json!({"pricing": {"lender": {"margin_bp": 0, "cap_bp": 800}}, "fees_charged": "0",
               "subsidy_paid": "323320", "credit": "0"})
    );
}

#[test]
fn the_answers_fee_and_subsidy_are_exactly_what_was_booked_on_the_accounts_debt() {
    // The account contract keeps its own record of its loan here: what it borrowed less what it repaid, plus each
    // settlement's `fee` and less its `subsidy`, never below zero. So those two must be what the pool booked.
    let mut env = Env::new(usd(1_000_000));
    env.mature(&["a.testnet"]);
    let mut record = 0u128;
    let settle = |env: &mut Env, record: &mut u128, report: Vec<LenderReport>| {
        let before = env.debt("a.testnet");
        let answer = env.settled("a.testnet", report);
        *record = (*record + answer.fee.0).saturating_sub(answer.subsidy.0);
        (before, env.debt("a.testnet"), answer)
    };

    // A fee on an account that owes nothing opens a loan on both sides. The pool's figure can be a micro-dollar or
    // two above the fee, as after any borrow, because its scaled debt rounds up.
    env.policy("a.testnet", MARGIN_120);
    settle(&mut env, &mut record, aave());
    env.now += HOUR;
    let (before, after, answer) = settle(&mut env, &mut record, aave());
    assert_eq!((before, answer.fee.0, answer.subsidy.0, record), (0, AAVE_HOUR, 0, AAVE_HOUR));
    assert!((AAVE_HOUR..=AAVE_HOUR + 2).contains(&after), "a fee of {AAVE_HOUR} made a debt of {after}");
    assert_eq!(answer.debt.0, after);

    // A fee on top of a loan adds exactly the fee.
    env.standard("a.testnet", usd(1_000));
    record += usd(1_000);
    env.now += HOUR;
    let (before, after, answer) = settle(&mut env, &mut record, aave());
    assert_eq!(answer.fee.0, AAVE_HOUR);
    assert!(after >= before + AAVE_HOUR && after <= before + AAVE_HOUR + 2, "{before} + {AAVE_HOUR} gave {after}");

    // A subsidy smaller than the debt comes off it whole: nothing goes to credit.
    env.policy("a.testnet", CAPPED_AT_8);
    env.now += HOUR;
    let (_, _, answer) = settle(&mut env, &mut record, rhea());
    assert_eq!((answer.fee.0, answer.subsidy.0), (0, 0), "Rhea is new in this report, so nothing is given yet");
    env.now += HOUR;
    let (before, after, answer) = settle(&mut env, &mut record, rhea());
    assert_eq!((answer.fee.0, answer.subsidy.0, answer.credit.0), (0, RHEA_HOUR, 0));
    assert!(after + RHEA_HOUR >= before && after + RHEA_HOUR <= before + 2, "{before} - {RHEA_HOUR} gave {after}");
    // Both records still agree, but for the pool's interest: 2% a year on the $1,000 for three hours, 0.7 cents.
    assert!(after >= record && after - record < 7_000, "the pool says {after} and the account {record}");

    // A subsidy larger than the debt takes it to zero on both sides, and the pool keeps the rest as credit.
    env.repay("a.testnet", after - 100_000);
    record -= after - 100_000;
    env.now += HOUR;
    let (before, after, answer) = settle(&mut env, &mut record, rhea());
    assert!((100_000..100_010).contains(&before));
    assert_eq!((answer.subsidy.0, after, record), (RHEA_HOUR, 0, 0));
    assert_eq!(answer.credit.0, RHEA_HOUR - before);

    // What the budgets cut was never given, so it isn't in `subsidy`.
    env.set_limits(|l| l.account_subsidy_day = U128(2 * RHEA_HOUR + 7));
    env.now += HOUR;
    let (_, _, answer) = settle(&mut env, &mut record, rhea());
    assert_eq!((answer.subsidy.0, answer.cut.0), (7, RHEA_HOUR - 7));
    assert_eq!(answer.credit.0, RHEA_HOUR - before + 7);
}

// ---- Upgrading the pool on testnet ----

/// `pool.pbf.testnet`'s state on 12 Nov 2026 at 19:50 UTC (block 277,408,462), as `tests/fetch_live.py` read it with
/// the RPC's `view_state` into `target/live-pool-fees/pool.state.json`: the `STATE` value, its 13 borrower records
/// (key 0x00 and the account id in borsh) and its 7 pricing records (key 0x07 and the same). Its code is the stage 2
/// build, `c4641c0e…`.
const TESTNET_STATE: &str = "0f0000007062662d6f70732e746573746e65740b0000007062662e746573746e6574150000006d757364632e7062662d6f70732e746573746e6574000029f90f260200000042076935090000009e22299d000000004f91944e0000401f0000580200008813000064000000c8000000f401000028230000c409000000ba1dd2050000000000000000000000005039278c04000000000000000000000010a5d4e8000000000000000000000000e87648170000000000000000000000004429353a000000000000000000000000743ba40b00000000000000000000000300000003000000455448dc0500000400000055534454b80b0000040000006e425443b80b000088130000040000000300000045544800c0bcf7e90a000000000000000000000400000055534454008079efd31500000000000000000000040000006e42544300c0bcf7e90a0000000000000000000005000000774e4541520060defb740500000000000000000000e8030000000057af724e18090000000000000000000000a0724e1809000000000000000000000000000000000000000000000000000000000000000000000000000000000000a3df00bdb63be10d00000000000000003eb9c0bfbcc0e10d0000000000000000e0586deee14fe30d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000078e059db5063e71806000000159b07000000000045feffffffffffffffffffffffffffff209b070000000000ddffffffffffffffffffffffffffffff249b070000000000c20d640c000000000000000000000000259b07000000000063f19bf3ffffffffffffffffffffffff279b0700000000007bfdffffffffffffffffffffffffffff2b9b07000000000054ffffffffffffffffffffffffffffff0200000003000000455448000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000040000006e425443000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000300000045544800000000000000000000000000000000040000006e42544300000000000000000000000000000000010000000001000000010100000002010000000301000000040000000002000000057602000000056d0100000006025a00000070170000f401000000009e22299d000000b08ef01b00000000e1f505000000000000000000000000050000000000004f030000000000000000000000000000bf02000000000000000000000000000003000000259b070000000000b1000000000000000000000000000000279b070000000000ab0000000000000000000000000000002b9b070000000000b0000000000000000000000000000000000000000000000000000000000000000100000007";
const TESTNET_BORROWERS: [(&str, &str); 13] = [
    ("demo1.pbf.testnet", "3fc81b7185c1e51801020000000000020000000000000000000000000000000001000000040000006e4254430813000001000000040000006e4254435057656c040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
    ("drill1.pbf.testnet", "b26950cea415e61801010000000000010000000000000000000000000000000001000000040000006e4254433e1c000001000000040000006e425443e60fe44300000000000000000000000090c076190000000000000000000000000000000000000000000000000000000000000000"),
    ("gate2a.pbf.testnet", "24a8afb8a207e71801010000000000010000000000000000000000000000000001000000040000006e4254438c14000001000000040000006e4254430ac5394200000000000000000000000095158b190000000000000000000000000000000000000000000000000000000000000000"),
    ("hedge1.pbf.testnet", "a8b67095df0ce61801010000000000010000000000000000000000000000000001000000040000006e4254433f1c000001000000040000006e425443a3afe043000000000000000000000000c5f784190000000000000000000000000000000000000000000000000000000000000000"),
    ("faults1.pbf.testnet", "660cd4df9e16e61800000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
    ("quiethare6001.pbf.testnet", "97fd884105e3e51801020000000000020000000000000000000000000000000001000000040000006e4254439219000001000000040000006e4254437288e368040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
    ("quiethare-hedge.pbf.testnet", "2ee1c9f6aa0ee61801010000000000010000000000000000000000000000000001000000040000006e4254433f1c000001000000040000006e42544310bbf043000000000000000000000000104685190000000000000000000000000000000000000000000000000000000000000000"),
    ("fund-rhea-watch1.pbf.testnet", "0b52d8b69b62e71801010000000000010000000000000000000000000000000001000000040000006e4254436314000001000000040000006e425443286a0040000000000000000000000000f95194190000000000000000000000000000000000000000000000000000000000000000"),
    ("fund-aave-11112049.pbf.testnet", "eff3665dc018e7180101000000000001000000000000000000000000000000000100000003000000455448490100000100000003000000455448891b7a02000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
    ("fund-move-11120836.pbf.testnet", "c1f5428c4b3fe71801020000000000020000000000000000000000000000000002000000030000004554480b010000040000006e425443712500000200000003000000455448b9866002000000000000000000000000040000006e4254438ab05055000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
    ("fund-move-11121239.pbf.testnet", "a6a6565e904ce71801020000000000020000000000000000000000000000000002000000030000004554480a010000040000006e42544373250000020000000300000045544864a45802000000000000000000000000040000006e425443889a8b54000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
    ("fund-rhea-11121251.pbf.testnet", "58643e03404de71801020000000000020000000000000000000000000000000001000000040000006e4254437814000001000000040000006e425443ab7c2d4100000000000000000000000011a88c190000000000000000000000000000000000000000000000000000000000000000"),
    ("fund-rhea-11121507.pbf.testnet", "bf890cd2ab54e71801010000000000010000000000000000000000000000000001000000040000006e4254436a14000001000000040000006e425443d6b4da3f000000000000000000000000c72d6e190000000000000000000000000000000000000000000000000000000000000000"),
];
const TESTNET_PRICING: [(&str, &str); 7] = [
    ("gate2a.pbf.testnet", "0101000000000100000000010000000400000072686561c5978a21000000000000000000000000430600000004000095843a996508e718ea000000000000000000000000000000b300000000000000000000000000000000000000000000000000000000000000010000000f9b070000000000b3000000000000000000000000000000010000000400000072686561010000002051000000000000bd12000000000000030000000000000000000000000000000000000072103be97d08e71822000000000000000000000000000000dfc75c89630f88ec0200000000000000"),
    ("fund-rhea-watch1.pbf.testnet", "01010000000001000000000100000004000000726865610000000000000000000000000000000039060000f903000078e059db5063e718ca000000000000000000000000000000b000000000000000000000000000000000000000000000000000000000000000010000002b9b070000000000b0000000000000000000000000000000010000000400000072686561010000002151000000000000fa18000000000000040000000000000000000000000000000000000078e059db5063e7180000000000000000000000000000000000000000000000000000000000000000"),
    ("fund-aave-11112049.pbf.testnet", "000200000004000000616176651a765f010000000000000000000000004a0000000900000004000000726865610000000000000000000000000000000038060000f803000078b4f0f7201ae71800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000400000061617665010000002051000000000000bc0100000000000006000000040000007268656101000000205100000000000050250000000000000600000000000000000000000000000000000000d4f4a01f2b1ae71817000000000000000000000000000000a895f42e029370fd0100000000000000"),
    ("fund-move-11120836.pbf.testnet", "00010000000400000061617665c6b750010000000000000000000000004a0000000900000026f51cc4b63fe71800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000400000061617665010000002151000000000000940000000000000002000000000000000000000000000000000000005967bda3c03fe718070000000000000000000000000000007ee2c69d320d7c3a0000000000000000"),
    ("fund-move-11121239.pbf.testnet", "00010000000400000061617665f75a4c010000000000000000000000004a000000090000001f35ecd3044de718000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000004000000616176650100000021510000000000009400000000000000020000000000000000000000000000000000000010cb517e114de718080000000000000000000000000000004073e5674d2d064b0000000000000000"),
    ("fund-rhea-11121251.pbf.testnet", "01010000000001000000000100000004000000726865610000000000000000000000000000000038060000f9030000afc37a36114ee718cd000000000000000000000000000000b10000000000000000000000000000000000000000000000000000000000000001000000259b070000000000b1000000000000000000000000000000010000000400000072686561010000002151000000000000f6180000000000000400000000000000000000000000000000000000afc37a36114ee7180000000000000000000000000000000000000000000000000000000000000000"),
    ("fund-rhea-11121507.pbf.testnet", "0101f4010000000100000004000000726865610000000000000000000000000000000039060000f9030000275475f47f5ee718ce000000000000000000000000000000ab0000000000000000000000000000000000000000000000000000000000000001000000279b070000000000ab000000000000000000000000000000010000000400000072686561010000002151000000000000da310000000000000800000000000000000000000000000000000000275475f47f5ee7180000000000000000000000000000000000000000000000000000000000000000"),
];
/// When the testnet pool last accrued interest: 12 Nov 2026, 19:36 UTC.
const TESTNET_ACCRUED_AT: u64 = 1_794_512_175_459_065_976;
const TESTNET_OPERATOR: &str = "pbf-ops.testnet";
/// The same pool's `STATE` on 9 Nov, under the Phase 5 code: a layout `migrate` no longer reads.
const PHASE_5_STATE: &str = "0f0000007062662d6f70732e746573746e65740b0000007062662e746573746e6574150000006d757364632e7062662d6f70732e746573746e6574000029f90f260200000042076935090000009e22299d000000004f91944e0000401f0000580200008813000064000000c8000000f401000028230000c409000000ba1dd2050000000000000000000000005039278c04000000000000000000000010a5d4e8000000000000000000000000e87648170000000000000000000000004429353a000000000000000000000000743ba40b00000000000000000000000300000003000000455448dc0500000400000055534454b80b0000040000006e425443b80b000088130000040000000300000045544800c0bcf7e90a000000000000000000000400000055534454008079efd31500000000000000000000040000006e42544300c0bcf7e90a0000000000000000000005000000774e4541520060defb740500000000000000000000e80300000000a1a8724e18090000000000000000000000a0724e18090000000000000000000000000000000000000000000000000000000000000000000000000000000000004702c30b2cd2e00d0000000000000000e32fa76da4ede00d000000000000000069dbbe5b0e40e10d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000032aeb1ed7f16e61803000000b69a0700000000005affffffffffffffffffffffffffffffc39a07000000000073fdffffffffffffffffffffffffffffc59a070000000000d2fdffffffffffffffffffffffffffff01000000040000006e42544300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000040000006e42544300000000000000000000000000000000010000000001000000010100000002010000000301000000040000000002000000057602000000056d0100000006";

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

/// Puts `pool.pbf.testnet`'s stage 2 state into the test's storage, an hour after it last accrued.
fn testnet_state() -> u64 {
    let now = TESTNET_ACCRUED_AT + HOUR;
    install(HashMap::new(), POOL, 0, now);
    near_sdk::env::storage_write(b"STATE", &unhex(TESTNET_STATE));
    for (prefix, records) in [(0u8, &TESTNET_BORROWERS[..]), (7, &TESTNET_PRICING[..])] {
        for (account, record) in records {
            let key = [&[prefix][..], &borsh::to_vec(&id(account)).unwrap()].concat();
            near_sdk::env::storage_write(&key, &unhex(record));
        }
    }
    now
}

/// The testnet pool after `migrate`.
fn migrated() -> Env {
    let now = testnet_state();
    Env { pool: Pool::migrate(), now }
}

#[test]
fn migrate_keeps_everything_the_testnet_pool_holds_and_adds_the_limits_on_a_fee() {
    let mut env = migrated();
    assert_eq!(get_logs().len(), 1, "migrate says what it did in one line");
    // Every setting is as `get_params` showed it on testnet.
    let params = env.params();
    assert_eq!(
        (params.operator.as_str(), params.factory.as_str(), params.token.as_str()),
        (TESTNET_OPERATOR, "pbf.testnet", "musdc.pbf-ops.testnet")
    );
    assert_eq!((params.periods, params.rates, params.caps), (Periods::default(), Rates::default(), Caps::default()));
    assert_eq!((params.daily_budget_bp, params.pending_budget), (1_000, None));
    assert_eq!(params.funding, FundingSettings { order: FundingOrder::LenderFirst, loan_days: 90 });
    assert!(params.tier_pricing.is_empty());
    // The limits it had stay, the 2 minutes between settlements included, and the three new ones take their
    // defaults: $1,000,000 of a lender's debt counted, $1,000 of fees a day per account, 50 bp of capital a day.
    let limits = PricingLimits { min_period_ns: 2 * MINUTE, ..Default::default() };
    assert_eq!(params.pricing_limits, limits);
    assert_eq!(
        as_json(&params.pricing_limits),
        json!({"max_rate_bp": 6000, "avg_plus_bp": 500, "max_period_ns": 172_800_000_000_000u64,
               "min_period_ns": 120_000_000_000u64, "account_subsidy_day": "100000000", "pool_subsidy_day_bp": 5,
               "max_lender_debt": "1000000000000", "account_fee_day": "1000000000", "pool_fee_day_bp": 50})
    );
    // The money: $10M funded, nothing lent, $0.003927 earned, and the totals of its settlements so far.
    let view = env.view();
    assert_eq!((view.cash.0, view.funded.0, view.defunded.0), (usd(10_000_000) + 3_927, usd(10_000_000), 0));
    assert_eq!((view.loans.0, view.capital.0, view.interest_earned.0), (0, usd(10_000_000) + 3_927, 3_927));
    assert_eq!((view.written_off.0, view.paused, view.lent_24h.0), (0, false, -1_514));
    assert_eq!((view.fees_charged.0, view.subsidy_paid.0, view.credit_owed.0), (847, 703, 0));
    assert_eq!(view.subsidy_left_24h.0, 5_000_000_001 - 524, "50 cents of subsidy in the last 24 hours still count");
    assert_eq!(env.pool.index, [1_000_146_248_293_998_499, 1_000_292_509_156_423_998, 1_000_731_373_992_761_568]);
    // Every borrower is there, owing what it owed: nothing.
    for (account, _) in TESTNET_BORROWERS {
        assert_eq!((env.borrower(account).debt.0, env.debt(account)), (0, 0));
    }
    let first = env.borrower("demo1.pbf.testnet");
    assert_eq!((first.created_at.0, first.history_tier), (1_794_052_805_449_467_967, Some(Tier::Watch)));
    assert_eq!(env.borrower("faults1.pbf.testnet").history_tier, None);
    // Every pricing record is there as it was: its policy, its last report, its totals.
    let gate = env.pricing("gate2a.pbf.testnet");
    let capped = Pricing::Lender { margin_bp: 0, cap_bp: Some(0) };
    assert_eq!((gate.pricing, gate.from, gate.settled_at.0), (capped, PricingFrom::Account, 1_794_412_208_985_900_181));
    assert_eq!((gate.fees_charged.0, gate.subsidy_paid.0, gate.credit.0), (234, 179, 0));
    assert_eq!(gate.last, vec![line("rhea", 562_730_949, 1_603, 1_024)]);
    let margin = env.pricing("fund-rhea-11121507.pbf.testnet");
    assert_eq!(margin.pricing, Pricing::Lender { margin_bp: 500, cap_bp: None });
    assert_eq!((margin.fees_charged.0, margin.subsidy_paid.0), (206, 171));
    let aave_account = env.pricing("fund-aave-11112049.pbf.testnet");
    assert_eq!((aave_account.pricing, aave_account.from), (Pricing::PassThrough, PricingFrom::Default));
    assert_eq!(aave_account.last, vec![line("aave", 23_033_370, 74, 9), line("rhea", 0, 1_592, 1_016)]);
    let (mut fees, mut subsidies) = (0, 0);
    for (account, _) in TESTNET_PRICING {
        let record = env.pricing(account);
        fees += record.fees_charged.0;
        subsidies += record.subsidy_paid.0;
        assert_eq!(record.fees_reversed.0, 0);
    }
    assert_eq!((fees, subsidies), (847, 703), "the accounts' totals add up to the pool's");
    // What is new starts empty: no fee in any window, nothing reversed.
    assert_eq!((view.fees_reversed.0, env.pool.fee_24h.total(env.now, HOUR)), (0, 0));
    assert!(env.pool.fees.get(&id("gate2a.pbf.testnet")).is_none());
    // The root state grows by 61 bytes: the three limits (36), an empty window (4), a total (16) and the new map's
    // key (5).
    assert_eq!(borsh::to_vec(&env.pool).unwrap().len(), unhex(TESTNET_STATE).len() + 61);
}

#[test]
fn the_migrated_pool_settles_cuts_a_fee_to_its_budget_and_takes_one_back() {
    let mut env = migrated();
    let (gate, margin) = ("gate2a.pbf.testnet", "fund-rhea-11121507.pbf.testnet");
    // An old record settles on from where it stood. `gate2a` last settled on 11 Nov with $562.73 at Rhea, under a
    // policy that pays what Rhea charges above its deposit rate. The 28 hours since count as 28 hours of subsidy.
    let since = env.now - 1_794_412_208_985_900_181;
    let settled = env.settled(gate, vec![line("rhea", 562_730_949, 1_603, 1_024)]);
    assert_eq!(settled.period_ns.0, since);
    assert_eq!(settled.subsidy.0, 562_730_949 * (1_603 - 1_024) * u128::from(since) / (10_000 * YEAR_NS));
    assert_eq!(settled.credit.0, settled.subsidy.0, "it owes the pool nothing, so the subsidy is credit");
    // An account under a 5-point margin borrows $1M at Rhea. Its borrow passes both figures, so the 2.5 hours since
    // its last settlement, in which it owed Rhea nothing, cost it nothing. Then it settles a year late: $50,000 of
    // margin, cut to the $1,000 a day an account can be charged.
    let borrowed = vec![line("rhea", usd(1_000_000), 1_593, 1_017)];
    let at_the_borrow = env.settled_closing(margin, borrowed.clone(), vec![line("rhea", 0, 1_593, 1_017)]);
    assert_eq!((at_the_borrow.fee.0, at_the_borrow.subsidy.0), (0, 0));
    env.now += YEAR_NS as u64;
    let late = env.settled(margin, borrowed);
    assert_eq!((late.fee.0, late.cut.0, late.period_ns.0), (usd(1_000), usd(49_000), YEAR_NS as u64));
    about(env.debt(margin), usd(1_000));
    let view = env.view();
    assert_eq!((view.fees_charged.0, view.fees_reversed.0), (847 + usd(1_000), 0));
    // The account's fees over the last 24 hours are in the new map, under the new last storage key (8), and no
    // older key moved: its pricing record is still under 7.
    env.pool.fees.flush();
    env.pool.pricing.flush();
    let key = |prefix: u8| [&[prefix][..], &borsh::to_vec(&id(margin)).unwrap()].concat();
    assert!(near_sdk::env::storage_has_key(&key(8)) && near_sdk::env::storage_has_key(&key(7)));
    assert_eq!(env.pool.fees.get(&id(margin)).unwrap().fee_24h.total(env.now, HOUR), usd(1_000) as i128);
    // The operator of the testnet pool takes $900 of it back.
    env.as_(TESTNET_OPERATOR, 0).reverse_fee(id(margin), U128(usd(900)));
    about(env.debt(margin), usd(100));
    assert_eq!((env.view().fees_reversed.0, env.pricing(margin).fees_reversed.0), (usd(900), usd(900)));
    // It lends as before.
    env.as_(gate, 1).borrow(U128(usd(1_000)), verdict(Tier::Standard, usd(1_000))).detach();
    about(env.debt(gate), usd(1_000));
}

#[test]
#[should_panic(expected = "Cannot deserialize the contract state")]
fn migrate_refuses_a_state_that_is_already_migrated() {
    let env = migrated();
    install(take_storage(), POOL, 0, env.now);
    near_sdk::env::state_write(&env.pool);
    Pool::migrate();
}

#[test]
#[should_panic(expected = "Cannot deserialize the contract state")]
fn migrate_refuses_the_phase_5_state_it_once_read() {
    install(HashMap::new(), POOL, 0, DAY);
    near_sdk::env::storage_write(b"STATE", &unhex(PHASE_5_STATE));
    Pool::migrate();
}

#[test]
#[should_panic(expected = "no pool state to migrate")]
fn migrate_needs_a_state() {
    install(HashMap::new(), POOL, 0, DAY);
    Pool::migrate();
}

#[test]
fn a_tiers_name_is_what_json_writes() {
    for tier in Tier::ALL {
        assert_eq!(json!(tier.name()), as_json(&tier));
    }
}
