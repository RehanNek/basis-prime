//! The pool's pricing against the real wasm and the real test token, in the sandbox (FUNDING.md 5; INTERFACES.md 26,
//! 30 and 45). A dev account plays the factory, and the accounts run `pb-testnet-borrower`; the tests sign each
//! account's own `settle` and `claim_credit` calls with its key, as the account contract makes them: `settle` with
//! 30 TGas and `claim_credit` with 40, neither with a deposit.
//!
//! The sandbox's clock is the real one, so a settlement here covers a few seconds. Each test works its expected fee
//! or subsidy out from the period the pool reports. The limits, the budgets and the rules on timing are covered to
//! the micro-dollar by the pool's unit tests, where the test sets the time.
mod common;

use std::time::Duration;

use common::*;
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::types::TxExecutionStatus;
use near_api::{AccountId, Contract, NearGas, NearToken};
use serde_json::{json, Value};

/// What the token charges to register an account for storage: 0.00125 NEAR.
const REGISTRATION: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const YEAR_NS: u128 = 365 * DAY_NS as u128;
/// The gas the account contract attaches to the pool's `settle` and `claim_credit` (contracts/account/src/lib.rs,
/// `GAS_FOR_SETTLE` and `GAS_FOR_CLAIM_CREDIT`).
const SETTLE_TGAS: u64 = 30;
const CLAIM_TGAS: u64 = 40;

/// As `Chain::call`, with no deposit and exactly `tgas` TGas for the whole transaction. That is a little less than
/// the account contract's call gets, since a transaction spends some of its gas becoming a receipt.
async fn call_with_gas(
    chain: &Chain,
    caller: &AccountId,
    contract: &AccountId,
    method: &str,
    args: Value,
    tgas: u64,
) -> ExecutionFinalResult {
    Contract(contract.clone())
        .call_function(method, args)
        .transaction()
        .gas(NearGas::from_tgas(tgas))
        .deposit(yocto(0))
        .with_signer(caller.clone(), chain.signer.clone())
        .wait_until(TxExecutionStatus::ExecutedOptimistic)
        .send_to(&chain.network)
        .await
        .unwrap_or_else(|e| panic!("{method} could not be sent: {e:?}"))
        .into_full()
        .expect("the outcome is complete")
}

/// What each receipt of a call burnt, in TGas to two places, with the contract it ran on.
fn gas_by_receipt(result: &ExecutionFinalResult) -> String {
    let receipts = result.receipt_outcomes().iter();
    let parts: Vec<String> =
        receipts.map(|r| format!("{} {:.2}", r.executor_id, r.gas_burnt.as_gas() as f64 / 1e12)).collect();
    format!("{:.2} TGas in all ({})", result.total_gas_burnt.as_gas() as f64 / 1e12, parts.join(", "))
}

/// debt × rate × time ÷ a year, as the pool rounds it: up for a fee, down for a subsidy.
fn fee_for(debt: u128, rate_bp: u128, period_ns: u128) -> u128 {
    (debt * rate_bp * period_ns).div_ceil(10_000 * YEAR_NS)
}

fn subsidy_for(debt: u128, rate_bp: u128, period_ns: u128) -> u128 {
    debt * rate_bp * period_ns / (10_000 * YEAR_NS)
}

/// One lender's line of a report (`LenderReport`).
fn line(lender: &str, debt: u128, rate_bp: u32, supply_bp: u32) -> Value {
    json!({ "lender": lender, "debt": debt.to_string(), "rate_bp": rate_bp, "supply_bp": supply_bp })
}

fn margin_120() -> Value {
    json!({ "lender": { "margin_bp": 120, "cap_bp": null } })
}

fn capped_at_8() -> Value {
    json!({ "lender": { "margin_bp": 0, "cap_bp": 800 } })
}

/// The data of the `pb-pool` event with this name that the call logged.
fn event(result: &ExecutionFinalResult, name: &str) -> Value {
    let logs = result.logs();
    let found = logs.iter().filter_map(|log| log.strip_prefix("EVENT_JSON:")).find_map(|text| {
        let event: Value = serde_json::from_str(text).ok()?;
        (event["standard"] == "pb-pool" && event["event"] == name).then(|| event["data"].clone())
    });
    found.unwrap_or_else(|| panic!("no {name} event: {result:?}"))
}

/// A sandbox with mUSDC and a pool lending it, funded by the operator.
struct World {
    chain: Chain,
    musdc: AccountId,
    pool: AccountId,
    operator: AccountId,
    factory: AccountId,
}

impl World {
    async fn new(capital: u128) -> Self {
        let chain = Chain::start().await;
        let musdc_init = json!({ "name": "Mock USDC", "symbol": "mUSDC", "decimals": 6 });
        let musdc = chain.contract("musdc", 10, wasm("pb_testnet_token"), Some(("new", musdc_init))).await;
        let operator = chain.account("operator", 50).await;
        let factory = chain.account("factory", 50).await;
        let init = json!({ "operator": operator, "factory": factory, "token": musdc, "periods": null });
        let pool = chain.contract("pool", 20, wasm("pb_pool"), Some(("new", init))).await;
        let w = World { chain, musdc, pool, operator, factory };
        w.register_on_token(&w.pool).await;
        let mint = json!({ "account_id": w.operator, "amount": capital.to_string() });
        w.chain.ok_with(&w.operator, &w.musdc, "mint", mint, REGISTRATION).await;
        let fund = json!({ "receiver_id": w.pool, "amount": capital.to_string(), "msg": r#"{"pool":"fund"}"# });
        let funded = w.chain.call(&w.operator, &w.musdc, "ft_transfer_call", fund, one_yocto()).await;
        assert!(funded.receipt_failures().is_empty(), "funding failed: {funded:?}");
        w
    }

    async fn register_on_token(&self, account: &AccountId) {
        let args = json!({ "account_id": account, "registration_only": true });
        self.chain.ok_with(&self.operator, &self.musdc, "storage_deposit", args, REGISTRATION).await;
    }

    /// An account the factory registered with the pool, running the borrower stand-in and registered on mUSDC.
    async fn borrower(&self, name: &str) -> AccountId {
        let id = self.unregistered_borrower(name).await;
        self.register_on_token(&id).await;
        id
    }

    /// As `borrower`, but not registered on mUSDC, so a transfer to it fails.
    async fn unregistered_borrower(&self, name: &str) -> AccountId {
        let id = self.chain.contract(name, 5, wasm("pb_testnet_borrower"), None).await;
        let args = json!({ "account_id": id });
        self.chain.ok_with(&self.factory, &self.pool, "register", args, NearToken::from_millinear(20)).await;
        id
    }

    async fn borrow(&self, account: &AccountId, amount: u128) {
        let args = json!({ "amount": amount.to_string(), "verdict": verdict("STANDARD", amount) });
        let result = self.chain.call(account, &self.pool, "borrow", args, one_yocto()).await;
        assert_ok(&result, "borrow");
    }

    /// An operator's call, which must succeed.
    async fn admin(&self, method: &str, args: Value) {
        let _ = self.admin_logged(method, args).await;
    }

    /// As `admin`, returning the outcome for its events.
    async fn admin_logged(&self, method: &str, args: Value) -> ExecutionFinalResult {
        let result = self.chain.call(&self.operator, &self.pool, method, args, yocto(0)).await;
        assert_ok(&result, method);
        result
    }

    /// Lets two settlements of one account be 2 seconds apart, so a test can wait for the second.
    async fn short_gap(&self) {
        self.set_limit("min_period_ns", json!(2 * SECOND_NS)).await;
    }

    /// Changes one of the pricing limits and leaves the others as they are.
    async fn set_limit(&self, field: &str, value: Value) {
        let mut limits = self.view("get_params", json!({})).await["pricing_limits"].clone();
        limits[field] = value;
        self.admin("set_pricing_limits", json!({ "limits": limits })).await;
    }

    async fn policy(&self, account: &AccountId, pricing: Value) {
        self.admin("set_pricing", json!({ "target": { "account": account }, "pricing": pricing })).await;
    }

    /// The account's own `settle` call: the pool's answer.
    async fn settle(&self, account: &AccountId, report: Value) -> Value {
        self.settle_logged(account, report).await.1
    }

    /// As `settle`, with the outcome for its events.
    async fn settle_logged(&self, account: &AccountId, report: Value) -> (ExecutionFinalResult, Value) {
        self.settle_with(account, json!({ "report": report })).await
    }

    /// A settlement at a borrow, as a new account's `l_borrow` step makes it: `closes` is the lender report as it
    /// stood before the borrow, and `report` shows the debt with it (INTERFACES.md 45.1, point 4).
    async fn settle_closing(&self, account: &AccountId, report: Value, closes: Value) -> Value {
        self.settle_with(account, json!({ "report": report, "closes": closes })).await.1
    }

    async fn settle_with(&self, account: &AccountId, args: Value) -> (ExecutionFinalResult, Value) {
        let result = call_with_gas(&self.chain, account, &self.pool, "settle", args, SETTLE_TGAS).await;
        assert_ok(&result, "settle");
        let answer = result.clone().json::<Value>().expect("settle answers JSON");
        (result, answer)
    }

    async fn claim(&self, account: &AccountId) -> ExecutionFinalResult {
        call_with_gas(&self.chain, account, &self.pool, "claim_credit", json!({}), CLAIM_TGAS).await
    }

    async fn view(&self, method: &str, args: Value) -> Value {
        self.chain.view(&self.pool, method, args).await
    }

    async fn pricing(&self, account: &AccountId) -> Value {
        self.view("get_pricing", json!({ "account_id": account })).await
    }

    async fn debt(&self, account: &AccountId) -> u128 {
        str_u128(&self.view("debt_of", json!({ "account_id": account })).await)
    }

    async fn balance(&self, account: &AccountId) -> u128 {
        str_u128(&self.chain.view::<Value>(&self.musdc, "ft_balance_of", json!({ "account_id": account })).await)
    }
}

#[tokio::test]
async fn only_the_operator_sets_pricing_and_the_views_show_what_was_set() {
    let w = World::new(usd(1_000_000)).await;
    let (a, b) = (w.borrower("a").await, w.borrower("b").await);
    let stranger = w.chain.account("stranger", 10).await;

    // Before anything is set: pass-through for every account, the default limits, and no tier policy.
    let params = w.view("get_params", json!({})).await;
    assert_eq!(params["funding"], json!({ "order": "cheapest", "loan_days": 90 }));
    let default_limits = json!({
        "max_rate_bp": 6000, "avg_plus_bp": 500, "max_period_ns": 172_800_000_000_000u64,
        "min_period_ns": 600_000_000_000u64, "account_subsidy_day": "100000000", "pool_subsidy_day_bp": 5,
        "max_lender_debt": "1000000000000", "account_fee_day": "1000000000", "pool_fee_day_bp": 50,
    });
    assert_eq!((params["pricing_limits"].clone(), params["tier_pricing"].clone()), (default_limits.clone(), json!({})));
    let fresh = json!({
        "pricing": "pass_through", "from": "default", "fees_charged": "0", "fees_reversed": "0", "subsidy_paid": "0",
        "credit": "0", "settled_at": "0", "last": [],
    });
    assert_eq!(w.pricing(&a).await, fresh);
    assert_eq!(w.pricing(&stranger).await, Value::Null);

    // Nobody but the operator changes a policy, the limits or the funding order.
    let tier = json!({ "target": { "tier": "STANDARD" }, "pricing": margin_120() });
    let funding = json!({ "funding": { "order": "lender_first", "loan_days": 30 } });
    let mut limits = default_limits.clone();
    limits["account_subsidy_day"] = json!(usd(20).to_string());
    let calls = [
        ("set_pricing", tier.clone()),
        ("set_pricing", json!({ "target": { "account": a }, "pricing": capped_at_8() })),
        ("set_pricing_limits", json!({ "limits": limits })),
        ("set_funding", funding.clone()),
    ];
    for (method, args) in &calls {
        for caller in [&stranger, &a, &w.factory] {
            let result = w.chain.call(caller, &w.pool, method, args.clone(), yocto(0)).await;
            assert_refused(&result, "only the operator can do this");
        }
    }
    // So is taking a fee back.
    let reverse = json!({ "account_id": a, "amount": "1" });
    for caller in [&stranger, &a, &w.factory] {
        let result = w.chain.call(caller, &w.pool, "reverse_fee", reverse.clone(), yocto(0)).await;
        assert_refused(&result, "only the operator can do this");
    }
    // The pool's own callbacks and its migration are closed to everyone else.
    let paid = json!({ "account_id": a, "amount": usd(1_000).to_string() });
    let result = w.chain.call(&stranger, &w.pool, "on_credit_paid", paid, yocto(0)).await;
    assert_refused(&result, "Method on_credit_paid is private");
    let result = w.chain.call(&w.operator, &w.pool, "migrate", json!({}), yocto(0)).await;
    assert_refused(&result, "Method migrate is private");
    // Only a registered account settles or claims.
    let report = json!([line("rhea", usd(50_667), 1_591, 0)]);
    for caller in [&stranger, &w.operator, &w.factory] {
        let result = w.chain.call(caller, &w.pool, "settle", json!({ "report": report }), yocto(0)).await;
        assert_refused(&result, "not a registered account");
        assert_refused(&w.claim(caller).await, "not a registered account");
    }

    // The operator sets each, and every change is a public event.
    for (method, args) in &calls {
        let result = w.admin_logged(method, args.clone()).await;
        assert!(has_event(&result, method), "no {method} event: {result:?}");
    }
    let result = w.admin_logged("set_pricing", tier.clone()).await;
    assert_eq!(event(&result, "set_pricing"), tier);
    let params = w.view("get_params", json!({})).await;
    assert_eq!(params["funding"], funding["funding"]);
    assert_eq!(params["pricing_limits"], limits);
    assert_eq!(params["tier_pricing"], json!({ "STANDARD": margin_120() }));
    // a has its own policy; b has none, so it pays its tier's.
    let (own, tiers) = (w.pricing(&a).await, w.pricing(&b).await);
    assert_eq!((own["pricing"].clone(), own["from"].clone()), (capped_at_8(), json!("account")));
    assert_eq!((tiers["pricing"].clone(), tiers["from"].clone()), (margin_120(), json!("tier")));
    let borrower = w.view("get_borrower", json!({ "account_id": a })).await;
    assert_eq!(borrower["pricing"], capped_at_8());
    assert_eq!((borrower["fees_charged"].clone(), borrower["credit"].clone()), (json!("0"), json!("0")));
    let pool = w.view("get_pool", json!({})).await;
    assert_eq!((pool["fees_charged"].clone(), pool["subsidy_paid"].clone()), (json!("0"), json!("0")));
    assert_eq!(pool["fees_reversed"], "0");
    assert_eq!(
        (pool["subsidy_left_24h"].clone(), pool["credit_owed"].clone()),
        (json!(usd(500).to_string()), json!("0"))
    );
    // The limits a stage 2 caller knows still set: the three on a fee take their defaults when they are left out.
    let mut six = limits.clone();
    for field in ["max_lender_debt", "account_fee_day", "pool_fee_day_bp"] {
        six.as_object_mut().unwrap().remove(field);
    }
    w.admin("set_pricing_limits", json!({ "limits": six })).await;
    assert_eq!(w.view("get_params", json!({})).await["pricing_limits"], limits);

    // Null clears a policy, and a wrong one is refused with what to fix.
    w.admin("set_pricing", json!({ "target": { "account": a }, "pricing": null })).await;
    assert_eq!(w.pricing(&a).await["from"], "tier");
    let wrong = [
        (json!({ "target": { "account": stranger }, "pricing": margin_120() }), "not a registered account"),
        (json!({ "target": { "tier": "WATCH" }, "pricing": { "fixed": { "rate_bp": 10_001 } } }), "rate_bp is capped"),
        (
            json!({ "target": { "tier": "WATCH" }, "pricing": { "lender": { "margin_bp": -10_001 } } }),
            "margin_bp must be between -10,000 and 10,000 bp",
        ),
    ];
    for (args, expected) in wrong {
        let result = w.chain.call(&w.operator, &w.pool, "set_pricing", args, yocto(0)).await;
        assert_refused(&result, expected);
    }
    limits["pool_fee_day_bp"] = json!(10_001);
    let result = w.chain.call(&w.operator, &w.pool, "set_pricing_limits", json!({ "limits": limits }), yocto(0)).await;
    assert_refused(&result, "pool_fee_day_bp is a share of capital, capped at 10,000 bp");
    limits["min_period_ns"] = json!(0);
    let result = w.chain.call(&w.operator, &w.pool, "set_pricing_limits", json!({ "limits": limits }), yocto(0)).await;
    assert_refused(&result, "min_period_ns must be between 1 ns and max_period_ns");
}

#[tokio::test]
async fn a_fee_adds_to_the_debt_and_a_subsidy_comes_off_it_between_two_reports() {
    let w = World::new(usd(1_000_000)).await;
    let (a, b, quiet) = (w.borrower("a").await, w.borrower("b").await, w.borrower("quiet").await);
    for account in [&a, &b, &quiet] {
        w.borrow(account, usd(10_000)).await;
    }
    w.policy(&a, margin_120()).await;
    w.policy(&b, capped_at_8()).await;
    let aave = json!([line("aave", usd(56_667), 533, 410)]);
    let rhea = json!([line("rhea", usd(50_667), 1_591, 0)]);

    // An account with no lender debt and no policy has nothing to settle, and the pool stores nothing for it.
    let (result, answer) = w.settle_logged(&quiet, json!([])).await;
    assert_eq!(answer, json!({ "skipped": "nothing to settle: no lender debt and no pricing policy" }));
    assert!(result.logs().is_empty(), "a skipped settlement logged: {result:?}");
    assert_eq!(w.pricing(&quiet).await["settled_at"], "0");

    // The first settlement only stores its report.
    let (result, first) = w.settle_logged(&a, aave.clone()).await;
    assert_eq!(
        (first["fee"].clone(), first["subsidy"].clone(), first["period_ns"].clone()),
        (json!("0"), json!("0"), json!("0"))
    );
    assert!(has_event(&result, "settle"));
    assert_eq!(w.pricing(&a).await["last"], aave);
    w.settle(&b, rhea.clone()).await;

    // Anyone may ask an account to settle, so a second one inside 10 minutes is skipped and changes nothing.
    let before = w.pricing(&a).await;
    let (result, answer) = w.settle_logged(&a, aave.clone()).await;
    let why = answer["skipped"].as_str().unwrap_or_else(|| panic!("not skipped: {answer}"));
    assert!(why.starts_with("too soon: this account settled "), "{why}");
    assert!(why.ends_with(" ago, and two settlements are at least 10 minutes apart"), "{why}");
    assert!(result.logs().is_empty(), "a skipped settlement logged: {result:?}");
    assert_eq!(w.pricing(&a).await, before);
    // A report that shows a new borrow at a lender is never too soon: the account's `l_borrow` step sends one, with
    // the lender's debt as it will be. Here $10,000 more at Aave, seconds after the account's first report.
    w.settle(&quiet, aave.clone()).await;
    let same = w.settle(&quiet, aave.clone()).await;
    assert!(same["skipped"].as_str().is_some_and(|why| why.starts_with("too soon")), "not skipped: {same}");
    let more = json!([line("aave", usd(66_667), 533, 410)]);
    let settled = w.settle(&quiet, more.clone()).await;
    assert!(settled.get("skipped").is_none() && str_u128(&settled["period_ns"]) > 0, "not settled: {settled}");
    assert_eq!(w.pricing(&quiet).await["last"], more);
    // A report that names a lender twice, or one the pool doesn't know, is refused.
    let twice = json!([line("aave", 1, 533, 410), line("aave", 1, 533, 410)]);
    let result = w.chain.call(&a, &w.pool, "settle", json!({ "report": twice }), yocto(0)).await;
    assert_refused(&result, "the report names aave twice");
    let unknown = json!([line("compound", 1, 533, 410)]);
    let result = w.chain.call(&a, &w.pool, "settle", json!({ "report": unknown }), yocto(0)).await;
    assert_refused(&result, "the lenders are");

    // With a 2-second minimum, the next settlements run. The pool's view before them:
    w.short_gap().await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let pool_before = w.view("get_pool", json!({})).await;

    // a: Aave's 5.33% plus a 1.2-point margin on $56,667, for the seconds since the first report.
    let debt = w.debt(&a).await;
    let (result, fee) = w.settle_logged(&a, aave.clone()).await;
    let period_ns = str_u128(&fee["period_ns"]);
    assert!(period_ns >= 3 * SECOND_NS as u128, "the settlement covered {period_ns} ns");
    let expected = fee_for(usd(56_667), 120, period_ns);
    assert!(expected > 0);
    assert_eq!(
        (str_u128(&fee["fee"]), fee["subsidy"].clone(), fee["credit"].clone()),
        (expected, json!("0"), json!("0"))
    );
    let mut logged = fee.clone();
    logged["account_id"] = json!(a);
    assert_eq!(event(&result, "settle"), logged);
    println!("settle (a fee) burnt {}: {fee}", gas_by_receipt(&result));
    // The fee is on the debt (with a few seconds of interest), and in the totals.
    let after = w.debt(&a).await;
    assert!(after >= debt + expected && after <= debt + expected + 200, "debt {debt} -> {after}, fee {expected}");
    assert_eq!(str_u128(&fee["debt"]), after);
    assert_eq!(str_u128(&w.pricing(&a).await["fees_charged"]), expected);

    // b: Rhea's 15.91% capped at 8% on $50,667.
    let debt = w.debt(&b).await;
    let subsidy = w.settle(&b, rhea.clone()).await;
    let expected_subsidy = subsidy_for(usd(50_667), 791, str_u128(&subsidy["period_ns"]));
    assert!(expected_subsidy > 0);
    assert_eq!(
        (subsidy["fee"].clone(), str_u128(&subsidy["subsidy"]), subsidy["cut"].clone()),
        (json!("0"), expected_subsidy, json!("0"))
    );
    println!("settle (a subsidy): {subsidy}");
    let after = w.debt(&b).await;
    assert!(after + expected_subsidy >= debt && after + expected_subsidy <= debt + 200, "debt {debt} -> {after}");
    let view = w.pricing(&b).await;
    assert_eq!(
        (str_u128(&view["subsidy_paid"]), view["credit"].clone(), view["last"].clone()),
        (expected_subsidy, json!("0"), rhea)
    );
    println!("get_pricing: {view}");

    // The pool's totals follow, and the daily lending window doesn't move: nothing was lent or repaid.
    let pool = w.view("get_pool", json!({})).await;
    assert_eq!((str_u128(&pool["fees_charged"]), str_u128(&pool["subsidy_paid"])), (expected, expected_subsidy));
    assert_eq!(
        (pool["lent_24h"].clone(), pool["cash"].clone()),
        (pool_before["lent_24h"].clone(), pool_before["cash"].clone())
    );
    assert_eq!(pool["lent_24h"], usd(30_000).to_string());
    assert_eq!(pool["credit_owed"], "0");
    let left = str_u128(&pool["capital"]) * 5 / 10_000 - expected_subsidy;
    assert_eq!(str_u128(&pool["subsidy_left_24h"]), left);
}

#[tokio::test]
async fn credit_is_paid_in_usdc_and_put_back_when_the_transfer_fails() {
    let w = World::new(usd(1_000_000)).await;
    let (a, lost) = (w.borrower("a").await, w.unregistered_borrower("lost").await);
    w.short_gap().await;
    // A lender's debt counts at $1,000,000 at most; this test wants more, so that a few seconds make cents.
    w.set_limit("max_lender_debt", json!(usd(50_000_000).to_string())).await;
    // Neither account owes the pool anything, so a subsidy is credit at once. $50M at Rhea makes it a few cents.
    let rhea = json!([line("rhea", usd(50_000_000), 1_591, 0)]);
    for account in [&a, &lost] {
        w.policy(account, capped_at_8()).await;
        w.settle(account, rhea.clone()).await;
    }
    assert_refused(&w.claim(&a).await, "no credit to claim");
    tokio::time::sleep(Duration::from_secs(3)).await;
    let mut credit = Vec::new();
    for account in [&a, &lost] {
        let answer = w.settle(account, rhea.clone()).await;
        let expected = subsidy_for(usd(50_000_000), 791, str_u128(&answer["period_ns"]));
        assert!(expected > 100_000, "the subsidy was only {expected}");
        assert_eq!(
            (str_u128(&answer["subsidy"]), str_u128(&answer["credit"]), answer["debt"].clone()),
            (expected, expected, json!("0"))
        );
        credit.push(expected);
    }
    let (credit_a, credit_lost) = (credit[0], credit[1]);

    // Credit is money the pool owes: capital is cash plus loans less the credit.
    let pool = w.view("get_pool", json!({})).await;
    assert_eq!((str_u128(&pool["cash"]), str_u128(&pool["loans"])), (usd(1_000_000), 0));
    assert_eq!(str_u128(&pool["credit_owed"]), credit_a + credit_lost);
    assert_eq!(str_u128(&pool["capital"]), usd(1_000_000) - credit_a - credit_lost);
    // The operator can't take the cash behind it.
    let all = json!({ "amount": usd(1_000_000).to_string() });
    let result = w.chain.call(&w.operator, &w.pool, "defund", all, one_yocto()).await;
    assert_refused(&result, "defund is limited to the pool's free cash");

    // While the pool is paused, credit waits.
    w.admin("set_paused", json!({ "paused": true })).await;
    assert_refused(&w.claim(&a).await, "the pool is paused: credit waits");
    let answer = w.settle(&a, rhea.clone()).await;
    assert_eq!(answer, json!({ "skipped": "the pool is paused: settlements wait" }));
    w.admin("set_paused", json!({ "paused": false })).await;

    // a claims: the USDC arrives, and the pool's cash and credit fall by it.
    let result = w.claim(&a).await;
    assert_ok(&result, "claim_credit");
    println!("claim_credit burnt {}", gas_by_receipt(&result));
    assert_eq!(event(&result, "claim_credit"), json!({ "account_id": a, "amount": credit_a.to_string() }));
    assert_eq!(result.clone().json::<Value>().unwrap(), json!(credit_a.to_string()));
    assert_eq!(w.balance(&a).await, credit_a);
    assert_eq!(w.balance(&w.pool).await, usd(1_000_000) - credit_a);
    let pool = w.view("get_pool", json!({})).await;
    assert_eq!((str_u128(&pool["cash"]), str_u128(&pool["credit_owed"])), (usd(1_000_000) - credit_a, credit_lost));
    assert_eq!(str_u128(&pool["capital"]), usd(1_000_000) - credit_a - credit_lost);
    assert_eq!(w.pricing(&a).await["credit"], "0");
    assert_refused(&w.claim(&a).await, "no credit to claim");

    // `lost` isn't registered on the token, so the transfer to it fails: its credit and the pool's cash are back.
    let result = w.claim(&lost).await;
    println!("claim_credit with a failed transfer burnt {}", gas_by_receipt(&result));
    assert_eq!(event(&result, "claim_credit_failed"), json!({ "account_id": lost, "amount": credit_lost.to_string() }));
    assert_eq!(result.clone().json::<Value>().unwrap(), json!("0"));
    assert_eq!(str_u128(&w.pricing(&lost).await["credit"]), credit_lost);
    let pool = w.view("get_pool", json!({})).await;
    assert_eq!((str_u128(&pool["cash"]), str_u128(&pool["credit_owed"])), (usd(1_000_000) - credit_a, credit_lost));
    assert_eq!(w.balance(&w.pool).await, usd(1_000_000) - credit_a);
    // Once it is registered, the same claim pays.
    w.register_on_token(&lost).await;
    assert_ok(&w.claim(&lost).await, "claim_credit");
    assert_eq!(w.balance(&lost).await, credit_lost);
    assert_eq!(w.view("get_pool", json!({})).await["credit_owed"], "0");
}

#[tokio::test]
async fn a_wrong_report_books_a_fee_within_its_limits_and_the_operator_takes_it_back() {
    let w = World::new(usd(1_000_000)).await;
    let a = w.borrower("a").await;
    w.borrow(&a, usd(10_000)).await;
    w.short_gap().await;
    w.policy(&a, margin_120()).await;
    let aave = json!([line("aave", usd(56_667), 533, 410)]);
    w.settle(&a, aave).await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let before = w.view("get_pool", json!({})).await;

    // research/audit.md, P3: a wrong report shows $17.5 trillion owed at Aave. It counts at $1,000,000, so the
    // 1.2-point margin for these seconds is a fraction of a cent, where it would have been tens of thousands of
    // dollars.
    let wrong = json!([line("aave", usd(17_500_000_000_000), 533, 410)]);
    let (result, first) = w.settle_logged(&a, wrong.clone()).await;
    let period_ns = str_u128(&first["period_ns"]);
    let fee = fee_for(usd(1_000_000), 120, period_ns);
    assert!(fee > 0 && fee < usd(1) && fee_for(usd(17_500_000_000_000), 120, period_ns) > usd(10_000));
    assert_eq!((str_u128(&first["fee"]), first["cut"].clone()), (fee, json!("0")));
    assert_eq!(first["parts"][0]["debt"], usd(1_000_000).to_string());
    println!("settle (a wrong report, its debt counted at the limit) burnt {}: {first}", gas_by_receipt(&result));
    // Capital, the daily lending budget and the rates are where they were.
    let after = w.view("get_pool", json!({})).await;
    assert!(str_u128(&after["capital"]) - str_u128(&before["capital"]) < usd(1));
    assert_eq!(
        (after["rate_bp"].clone(), after["daily_budget_bp"].clone()),
        (before["rate_bp"].clone(), before["daily_budget_bp"].clone())
    );
    assert!(str_u128(&after["daily_budget"]) - str_u128(&before["daily_budget"]) < usd(1));

    // The account's fees are also limited by the day. With the limit 100 micro-dollars above what it has been
    // charged, the next fee is cut to those 100, and the answer says what was cut.
    w.set_limit("account_fee_day", json!((fee + 100).to_string())).await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let (result, second) = w.settle_logged(&a, wrong.clone()).await;
    let full = fee_for(usd(1_000_000), 120, str_u128(&second["period_ns"]));
    assert!(full > 100, "the second fee was only {full}");
    assert_eq!((second["fee"].clone(), str_u128(&second["cut"])), (json!("100"), full - 100));
    let mut logged = second.clone();
    logged["account_id"] = json!(a);
    assert_eq!(event(&result, "settle"), logged);
    println!("settle (a fee cut to its budget): {second}");
    // The budget is used up: the next fee is cut to nothing, and the report is stored all the same.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let third = w.settle(&a, wrong.clone()).await;
    assert_eq!((third["fee"].clone(), third["subsidy"].clone()), (json!("0"), json!("0")));
    assert!(str_u128(&third["cut"]) > 0);
    let charged = fee + 100;
    assert_eq!(str_u128(&w.pricing(&a).await["fees_charged"]), charged);

    // The operator takes the wrong fees back: never more than was charged, and nobody else can.
    let all = json!({ "account_id": a, "amount": charged.to_string() });
    let too_much = json!({ "account_id": a, "amount": (charged + 1).to_string() });
    let refused = w.chain.call(&w.operator, &w.pool, "reverse_fee", too_much, yocto(0)).await;
    assert_refused(&refused, "that is more than the fees charged to this account, less those already reversed");
    assert_refused(
        &w.chain.call(&a, &w.pool, "reverse_fee", all.clone(), yocto(0)).await,
        "only the operator can do this",
    );
    let (debt, pool) = (w.debt(&a).await, w.view("get_pool", json!({})).await);
    let result = w.admin_logged("reverse_fee", all).await;
    let reversed = event(&result, "reverse_fee");
    println!("reverse_fee: {reversed}");
    let after = w.debt(&a).await;
    assert_eq!(reversed, json!({ "account_id": a, "amount": charged.to_string(), "debt": reversed["debt"] }));
    assert!(after + charged >= debt && after + charged <= debt + 200, "debt {debt} -> {after}, less {charged}");
    // No cash moved, the lending window is where it was, and the totals show what was charged and taken back.
    let now = w.view("get_pool", json!({})).await;
    assert_eq!((now["cash"].clone(), now["lent_24h"].clone()), (pool["cash"].clone(), pool["lent_24h"].clone()));
    assert_eq!((str_u128(&now["fees_charged"]), str_u128(&now["fees_reversed"])), (charged, charged));
    let view = w.pricing(&a).await;
    assert_eq!((str_u128(&view["fees_charged"]), str_u128(&view["fees_reversed"])), (charged, charged));
    println!("get_pricing after a reversal: {view}");
    let again = json!({ "account_id": a, "amount": "1" });
    let refused = w.chain.call(&w.operator, &w.pool, "reverse_fee", again, yocto(0)).await;
    assert_refused(&refused, "that is more than the fees charged to this account, less those already reversed");
}

#[tokio::test]
async fn a_borrow_that_passes_the_debt_before_it_earns_no_subsidy_for_a_lender_it_owed_nothing() {
    let w = World::new(usd(1_000_000)).await;
    let (old, new) = (w.borrower("old").await, w.borrower("new").await);
    w.short_gap().await;
    for account in [&old, &new] {
        w.policy(account, capped_at_8()).await;
    }
    let rhea = json!([line("rhea", usd(50_667), 1_591, 0)]);
    let nothing = json!([line("rhea", 0, 1_591, 0)]);
    // research/audit.md, P4: each account borrows $50,667 at Rhea, repays it at once with no fresh verdict, and
    // borrows again a few seconds later. An account from before reports one figure at a borrow, the debt with it.
    // A new account also passes `closes`, the debt just before.
    w.settle(&old, rhea.clone()).await;
    w.settle_closing(&new, rhea.clone(), nothing.clone()).await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    // The old way pays the cap's subsidy for the gap, in which Rhea was owed nothing.
    let paid = w.settle(&old, rhea.clone()).await;
    let expected = subsidy_for(usd(50_667), 791, str_u128(&paid["period_ns"]));
    assert!(expected > 0);
    assert_eq!(str_u128(&paid["subsidy"]), expected);
    // The new way closes the gap on nothing owed, pays nothing, and starts the next period from the new loan.
    let (result, closed) = w.settle_with(&new, json!({ "report": rhea, "closes": nothing })).await;
    assert_eq!((closed["subsidy"].clone(), closed["fee"].clone()), (json!("0"), json!("0")));
    assert_eq!(
        closed["parts"][0],
        json!({
            "source": "rhea", "debt": "0", "counted_bp": 1591, "client_bp": 800, "fee": "0", "subsidy": "0",
        })
    );
    assert!(str_u128(&closed["period_ns"]) >= 3 * SECOND_NS as u128);
    println!("settle (with closes) burnt {}: {closed}", gas_by_receipt(&result));
    assert_eq!(w.pricing(&new).await["last"], rhea);
    tokio::time::sleep(Duration::from_secs(3)).await;
    let held = w.settle(&new, rhea.clone()).await;
    assert_eq!(str_u128(&held["subsidy"]), subsidy_for(usd(50_667), 791, str_u128(&held["period_ns"])));
    assert!(str_u128(&held["subsidy"]) > 0);
    // `closes` is checked as the report is.
    let twice = json!([line("rhea", 0, 1_591, 0), line("rhea", 0, 1_591, 0)]);
    let refused = w.chain.call(&new, &w.pool, "settle", json!({ "report": rhea, "closes": twice }), yocto(0)).await;
    assert_refused(&refused, "the report names rhea twice");
}
