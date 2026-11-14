//! The pool against the real wasm and the real test token, in the sandbox. Every limit is tested by trying to break
//! it (PLAN.md 10). A dev account plays the factory, and borrowers run `pb-testnet-borrower`, which takes loans the
//! way the account contract will.
//!
//! Most tests use a pool whose first week and budget timelock last 3 seconds, so they can reach the other limits; one
//! test keeps the spec's 7 days. Time-based rules beyond that are covered by the pool's unit tests.
mod common;

use std::time::Duration;

use common::*;
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::{AccountId, NearToken};
use serde_json::{json, Value};

/// What the token charges to register an account for storage: 0.00125 NEAR.
const REGISTRATION: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);

/// The sandbox pool's periods: a 3-second first week and budget timelock; the rest as in the spec.
fn short_periods() -> Value {
    json!({
        "new_account_ns": (3 * SECOND_NS).to_string(),
        "upgrade_ns": (30 * DAY_NS).to_string(),
        "budget_delay_ns": (3 * SECOND_NS).to_string(),
        "window_ns": DAY_NS.to_string(),
    })
}

fn on(token: &str, bp: u32, amount: u128) -> Value {
    let mut v = verdict("STANDARD", amount);
    v["shares_bp"][token] = json!(bp);
    v
}

fn holding(token: &str, dollars: u128, amount: u128) -> Value {
    let mut v = verdict("STANDARD", amount);
    v["hold"][token] = json!(usd(dollars).to_string());
    v
}

fn with_hl(dollars: u128, amount: u128) -> Value {
    let mut v = verdict("STANDARD", amount);
    v["hl_eq"] = json!(usd(dollars).to_string());
    v
}

/// A sandbox with mUSDC and mNBTC, and a pool lending mUSDC that the operator funded.
struct World {
    chain: Chain,
    musdc: AccountId,
    mnbtc: AccountId,
    pool: AccountId,
    operator: AccountId,
    factory: AccountId,
}

impl World {
    async fn new(capital: u128, periods: Option<Value>) -> Self {
        let chain = Chain::start().await;
        let token = wasm("pb_testnet_token");
        let musdc_init = json!({ "name": "Mock USDC", "symbol": "mUSDC", "decimals": 6 });
        let mnbtc_init = json!({ "name": "Mock nBTC", "symbol": "mNBTC", "decimals": 8 });
        let musdc = chain.contract("musdc", 10, token.clone(), Some(("new", musdc_init))).await;
        let mnbtc = chain.contract("mnbtc", 10, token, Some(("new", mnbtc_init))).await;
        let operator = chain.account("operator", 50).await;
        let factory = chain.account("factory", 50).await;
        let init = json!({ "operator": operator, "factory": factory, "token": musdc, "periods": periods });
        let pool = chain.contract("pool", 20, wasm("pb_pool"), Some(("new", init))).await;
        let w = World { chain, musdc, mnbtc, pool, operator, factory };
        w.register_on_token(&w.pool).await;
        if capital > 0 {
            w.mint(&w.operator, capital).await;
            let funded = w.fund(&w.operator, capital).await;
            assert!(funded.receipt_failures().is_empty(), "funding failed: {funded:?}");
        }
        w
    }

    async fn register_on_token(&self, account: &AccountId) {
        let args = json!({ "account_id": account, "registration_only": true });
        self.chain.ok_with(&self.operator, &self.musdc, "storage_deposit", args, REGISTRATION).await;
    }

    /// The faucet: mints mUSDC to `to`, registering it if needed.
    async fn mint(&self, to: &AccountId, amount: u128) {
        let args = json!({ "account_id": to, "amount": amount.to_string() });
        self.chain.ok_with(&self.operator, &self.musdc, "mint", args, REGISTRATION).await;
    }

    async fn fund(&self, from: &AccountId, amount: u128) -> ExecutionFinalResult {
        let args = json!({ "receiver_id": self.pool, "amount": amount.to_string(), "msg": r#"{"pool":"fund"}"# });
        self.chain.call(from, &self.musdc, "ft_transfer_call", args, one_yocto()).await
    }

    async fn repay(&self, from: &AccountId, amount: u128) -> ExecutionFinalResult {
        let args = json!({ "receiver_id": self.pool, "amount": amount.to_string(), "msg": r#"{"pool":"repay"}"# });
        self.chain.call(from, &self.musdc, "ft_transfer_call", args, one_yocto()).await
    }

    /// An account the factory registered with the pool, running the borrower stand-in and registered on mUSDC.
    async fn borrower(&self, name: &str) -> AccountId {
        let id = self.unregistered_borrower(name).await;
        self.register_on_token(&id).await;
        id
    }

    /// As `borrower`, but not registered on mUSDC, so a loan transfer to it fails.
    async fn unregistered_borrower(&self, name: &str) -> AccountId {
        let id = self.chain.contract(name, 5, wasm("pb_testnet_borrower"), None).await;
        let args = json!({ "account_id": id });
        self.chain.ok_with(&self.factory, &self.pool, "register", args, NearToken::from_millinear(20)).await;
        id
    }

    async fn borrow(&self, account: &AccountId, amount: u128, verdict: Value) -> ExecutionFinalResult {
        let args = json!({ "amount": amount.to_string(), "verdict": verdict });
        self.chain.call(account, &self.pool, "borrow", args, one_yocto()).await
    }

    async fn borrow_ok(&self, account: &AccountId, amount: u128, verdict: Value) {
        let result = self.borrow(account, amount, verdict).await;
        assert_ok(&result, "borrow");
        assert!(has_event(&result, "borrow"), "no borrow event: {result:?}");
    }

    async fn standard(&self, account: &AccountId, amount: u128) {
        self.borrow_ok(account, amount, verdict("STANDARD", amount)).await;
    }

    async fn refused(&self, account: &AccountId, amount: u128, verdict: Value, expected: &str) {
        let result = self.borrow(account, amount, verdict).await;
        assert_refused(&result, expected);
    }

    async fn admin(&self, method: &str, args: Value) {
        self.chain.ok(&self.operator, &self.pool, method, args).await;
    }

    async fn debt(&self, account: &AccountId) -> u128 {
        str_u128(&self.chain.view::<Value>(&self.pool, "debt_of", json!({ "account_id": account })).await)
    }

    async fn pool_view(&self) -> Value {
        self.chain.view(&self.pool, "get_pool", json!({})).await
    }

    async fn balance(&self, token: &AccountId, account: &AccountId) -> u128 {
        str_u128(&self.chain.view::<Value>(token, "ft_balance_of", json!({ "account_id": account })).await)
    }

    /// Repays an account's whole debt (minting it a little extra first, for the interest).
    async fn repay_all(&self, account: &AccountId) {
        self.mint(account, usd(10)).await;
        let debt = self.debt(account).await;
        let result = self.repay(account, debt + usd(5)).await;
        assert!(result.receipt_failures().is_empty(), "repay failed: {result:?}");
        assert_eq!(self.debt(account).await, 0);
    }

    /// Raises the daily budget to 100% of capital. It applies only after the (sandbox-short) timelock.
    async fn open_budget(&self) {
        self.admin("set_daily_budget", json!({ "bp": 10_000 })).await;
        assert_eq!(self.pool_view().await["daily_budget_bp"], 1_000, "a raise must wait for its timelock");
        tokio::time::sleep(Duration::from_secs(4)).await;
    }
}

#[tokio::test]
async fn only_the_operator_funds_defunds_and_changes_settings() {
    let w = World::new(usd(1_000_000), None).await;
    let stranger = w.chain.account("stranger", 10).await;
    w.mint(&stranger, usd(10)).await;

    // Funding from anyone but the operator is refused, and the token hands the money back.
    let result = w.fund(&stranger, usd(10)).await;
    assert_refused(&result, "only the operator can fund the pool");
    assert_eq!(w.balance(&w.musdc, &stranger).await, usd(10));
    assert_eq!(str_u128(&w.pool_view().await["cash"]), usd(1_000_000));

    // A repayment from an account the pool doesn't know is refused the same way.
    assert_refused(&w.repay(&stranger, usd(10)).await, "not a registered account");
    assert_eq!(w.balance(&w.musdc, &stranger).await, usd(10));

    // Defunding is limited to free cash; within it, the money goes back to the operator.
    let result = w
        .chain
        .call(&w.operator, &w.pool, "defund", json!({ "amount": (usd(1_000_000) + 1).to_string() }), one_yocto())
        .await;
    assert_refused(&result, "free cash");
    w.chain.ok_with(&w.operator, &w.pool, "defund", json!({ "amount": usd(100_000).to_string() }), one_yocto()).await;
    assert_eq!(w.balance(&w.musdc, &w.operator).await, usd(100_000));
    assert_eq!(str_u128(&w.pool_view().await["cash"]), usd(900_000));

    // Every admin call from anyone else is refused.
    let a = w.borrower("a").await;
    let params: Value = w.chain.view(&w.pool, "get_params", json!({})).await;
    let calls = [
        ("set_paused", json!({ "paused": true })),
        ("set_daily_budget", json!({ "bp": 10_000 })),
        ("set_rates", json!({ "rates": params["rates"] })),
        ("set_caps", json!({ "caps": params["caps"] })),
        ("set_kyb", json!({ "account_id": a, "entity": "acme" })),
        (
            "set_tier_override",
            json!({ "account_id": a, "tier": "PREFERRED", "reason": "x", "expires_at": u64::MAX.to_string() }),
        ),
        ("clear_tier_override", json!({ "account_id": a })),
        ("cosign", json!({ "request": { "borrow": { "account_id": a, "amount": usd(1_000_000).to_string() } } })),
        ("revoke_cosign", json!({ "request": { "borrow": { "account_id": a, "amount": "1" } } })),
        ("set_step_price", json!({ "token": w.mnbtc, "decimals": 8, "price": "1" })),
        ("set_coin_status", json!({ "coin": "nBTC", "status": "frozen" })),
        ("publish_version", json!({ "program": "pb-risk", "hash": "aa", "params": "bb" })),
        ("unblock", json!({ "account_id": a })),
    ];
    for (method, args) in calls {
        let result = w.chain.call(&stranger, &w.pool, method, args, NearToken::from_yoctonear(0)).await;
        assert_refused(&result, "only the operator can do this");
    }
    let result = w.chain.call(&stranger, &w.pool, "defund", json!({ "amount": "1" }), one_yocto()).await;
    assert_refused(&result, "only the operator can do this");

    // Only the factory registers accounts.
    let args = json!({ "account_id": stranger });
    let result = w.chain.call(&stranger, &w.pool, "register", args, NearToken::from_millinear(20)).await;
    assert_refused(&result, "only the factory can register accounts");

    // One Hyperliquid address links to one account.
    let b = w.borrower("b").await;
    let address = format!("0x{}", "ab".repeat(20));
    let deposit = NearToken::from_millinear(5);
    w.chain.ok_with(&a, &w.pool, "link", json!({ "hl_address": address }), deposit).await;
    let result = w
        .chain
        .call(&b, &w.pool, "link", json!({ "hl_address": address.to_uppercase().replacen("0X", "0x", 1) }), deposit)
        .await;
    assert_refused(&result, "already linked to another account");
    let owner: Option<AccountId> = w.chain.view(&w.pool, "hl_link_owner", json!({ "hl_address": address })).await;
    assert_eq!(owner, Some(a));
}

#[tokio::test]
async fn a_new_account_owes_at_most_25k_in_its_first_week() {
    let w = World::new(usd(1_000_000), None).await; // the spec's 7-day first week
    let a = w.borrower("a").await;
    w.refused(&a, usd(25_001), verdict("STANDARD", usd(25_001)), "first-week limit").await;
    w.standard(&a, usd(25_000)).await;
    w.refused(&a, 1, verdict("STANDARD", 1), "first-week limit").await;
    assert_eq!(w.balance(&w.musdc, &a).await, usd(25_000));
}

#[tokio::test]
async fn the_daily_budget_the_pause_and_the_cosignature() {
    let w = World::new(usd(2_000_000), Some(short_periods())).await; // budget: 10% = $200k a day
    let (a, b, c) = (w.borrower("a").await, w.borrower("b").await, w.borrower("c").await);
    tokio::time::sleep(Duration::from_secs(4)).await; // past the first "week"

    // No loans while paused; repaying still works.
    w.admin("set_paused", json!({ "paused": true })).await;
    w.refused(&a, usd(1_000), verdict("STANDARD", usd(1_000)), "the pool is paused").await;
    w.admin("set_paused", json!({ "paused": false })).await;

    // A dollar over the budget (it is 10% of capital, which grows a little with interest).
    w.standard(&a, usd(150_000)).await;
    w.standard(&b, usd(50_000)).await;
    w.refused(&c, usd(1), verdict("STANDARD", usd(1)), "daily budget").await;

    w.admin("set_paused", json!({ "paused": true })).await;
    let result = w.repay(&a, usd(50_000)).await;
    assert!(result.receipt_failures().is_empty(), "repaying while paused failed: {result:?}");
    assert!(w.debt(&a).await < usd(100_001));
    w.admin("set_paused", json!({ "paused": false })).await;

    // Repayments free budget: it counts loans minus repayments.
    w.standard(&c, usd(50_000)).await;
    w.refused(&c, usd(1), verdict("STANDARD", usd(1)), "daily budget").await;

    // Raising the budget waits for its timelock (open_budget checks that it didn't apply at once).
    w.open_budget().await;

    // A borrow above $250k needs the operator's co-signature, for that account and amount, once.
    w.refused(&c, usd(300_000), verdict("STANDARD", usd(300_000)), "needs the operator's co-signature").await;
    let request = json!({ "borrow": { "account_id": c, "amount": usd(300_000).to_string() } });
    w.admin("cosign", json!({ "request": request })).await;
    w.refused(&b, usd(300_000), verdict("STANDARD", usd(300_000)), "needs the operator's co-signature").await;
    w.standard(&c, usd(300_000)).await;
    w.refused(&c, usd(300_000), verdict("STANDARD", usd(300_000)), "needs the operator's co-signature").await;
}

#[tokio::test]
async fn tier_ceilings_the_kyb_flag_and_upgrades() {
    let w = World::new(usd(30_000_000), Some(short_periods())).await;
    let (watch, standard, preferred, upgrader) =
        (w.borrower("w").await, w.borrower("s").await, w.borrower("p").await, w.borrower("u").await);
    w.open_budget().await;

    w.borrow_ok(&watch, usd(100_000), verdict("WATCH", usd(100_000))).await;
    w.refused(&watch, 1, verdict("WATCH", 1), "tier ceiling").await;

    w.admin(
        "cosign",
        json!({ "request": { "borrow": { "account_id": standard, "amount": usd(1_000_000).to_string() } } }),
    )
    .await;
    w.standard(&standard, usd(1_000_000)).await;
    w.refused(&standard, 1, verdict("STANDARD", 1), "tier ceiling").await;

    // A verdict claiming Preferred for an account without the KYB flag is refused.
    w.refused(&preferred, usd(1_000), verdict("PREFERRED", usd(1_000)), "needs the operator's KYB flag").await;
    w.admin("set_kyb", json!({ "account_id": preferred, "entity": "p-corp" })).await;
    w.admin(
        "cosign",
        json!({ "request": { "borrow": { "account_id": preferred, "amount": usd(5_000_000).to_string() } } }),
    )
    .await;
    w.borrow_ok(&preferred, usd(5_000_000), verdict("PREFERRED", usd(5_000_000))).await;
    w.refused(&preferred, 1, verdict("PREFERRED", 1), "tier ceiling").await;

    // Watch to Standard is one upgrade; a second one within 30 days is refused.
    w.admin("set_kyb", json!({ "account_id": upgrader, "entity": "u-corp" })).await;
    w.borrow_ok(&upgrader, usd(1_000), verdict("WATCH", usd(1_000))).await;
    w.borrow_ok(&upgrader, usd(1_000), verdict("STANDARD", usd(1_000))).await;
    w.refused(&upgrader, usd(1_000), verdict("PREFERRED", usd(1_000)), "only one tier upgrade per 30 days").await;
    let view: Value = w.chain.view(&w.pool, "get_borrower", json!({ "account_id": upgrader })).await;
    assert_eq!(view["tier"], "STANDARD");
}

#[tokio::test]
async fn utilisation_one_client_and_the_book_limits() {
    let w = World::new(usd(1_000_000), Some(short_periods())).await;
    let mut accounts = Vec::new();
    for name in ["a", "b", "c", "d", "e", "f"] {
        accounts.push(w.borrower(name).await);
    }
    let [a, b, c, d, e, f] = <[AccountId; 6]>::try_from(accounts).unwrap();
    w.open_budget().await;

    // One client owes at most 25% of capital, and two accounts of one KYB entity count as one client.
    w.standard(&a, usd(250_000)).await;
    w.refused(&a, 1, verdict("STANDARD", 1), "one-client limit").await;
    w.admin("set_kyb", json!({ "account_id": b, "entity": "acme" })).await;
    w.admin("set_kyb", json!({ "account_id": c, "entity": "acme" })).await;
    w.standard(&b, usd(150_000)).await;
    w.refused(&c, usd(100_001), verdict("STANDARD", usd(100_001)), "one-client limit").await;
    w.standard(&c, usd(99_999)).await;

    // Utilisation stays at or below 90%.
    w.standard(&d, usd(250_000)).await;
    w.refused(&e, usd(150_002), verdict("STANDARD", usd(150_002)), "utilisation limit").await;
    w.standard(&e, usd(150_000)).await;
    for account in [&a, &b, &c, &d, &e] {
        w.repay_all(account).await;
    }

    // Loans resting on each bridged token stay within its cap: nBTC 30%, ETH 15%, USDT 30%.
    w.borrow_ok(&a, usd(200_000), on("nBTC", 10_000, usd(200_000))).await;
    w.refused(&b, usd(100_001), on("nBTC", 10_000, usd(100_001)), "loans resting on nBTC").await;
    w.borrow_ok(&b, usd(100_000), on("nBTC", 5_000, usd(100_000))).await; // half on nBTC counts half
    w.refused(&d, usd(150_001), on("ETH", 10_000, usd(150_001)), "loans resting on ETH").await;
    w.borrow_ok(&d, usd(100_000), on("ETH", 10_000, usd(100_000))).await;
    w.borrow_ok(&e, usd(200_000), on("USDT", 10_000, usd(200_000))).await;
    w.refused(&f, usd(100_001), on("USDT", 10_000, usd(100_001)), "loans resting on USDT").await;

    // No new loan rests on a frozen token; other collateral still borrows.
    w.admin("set_coin_status", json!({ "coin": "nBTC", "status": "frozen" })).await;
    w.refused(&e, usd(1_000), on("nBTC", 1, usd(1_000)), "nBTC is frozen").await;
    w.borrow_ok(&e, usd(1_000), on("nBTC", 0, usd(1_000))).await;
    w.admin("set_coin_status", json!({ "coin": "nBTC", "status": "allowed" })).await;
    for account in [&a, &b, &c, &d, &e] {
        w.repay_all(account).await;
    }

    // Loans resting on Hyperliquid, Σ min(debt, Hyperliquid equity), stay within 50% of capital.
    w.borrow_ok(&a, usd(250_000), with_hl(1_000_000, usd(250_000))).await;
    w.borrow_ok(&b, usd(249_999), with_hl(249_999, usd(249_999))).await;
    w.refused(&e, usd(1_000), with_hl(100, usd(1_000)), "Hyperliquid cap").await;
    w.standard(&e, usd(1_000)).await;

    // Holdings of each NEAR token across accounts with a loan stay within its book cap (nBTC $12M, wNEAR $6M).
    w.borrow_ok(&f, usd(1_000), holding("nBTC", 11_000_000, usd(1_000))).await;
    w.refused(&e, usd(1_000), holding("nBTC", 1_000_001, usd(1_000)), "NEAR-side book cap").await;
    w.borrow_ok(&e, usd(1_000), holding("wNEAR", 6_000_000, usd(1_000))).await;
    w.refused(&d, usd(1_000), holding("wNEAR", 1, usd(1_000)), "NEAR-side book cap").await;
    let view = w.pool_view().await;
    assert_eq!(view["book"]["nBTC"]["amount"], usd(11_000_000).to_string());
    assert_eq!(view["book"]["wNEAR"]["amount"], usd(6_000_000).to_string());
}

#[tokio::test]
async fn plan_steps_past_50k_a_day_need_the_cosignature() {
    let w = World::new(usd(1_000_000), Some(short_periods())).await;
    let (a, b) = (w.borrower("a").await, w.borrower("b").await);
    let step = |plan: &str, i: u32, token: &AccountId, amount: u128| json!({ "plan_id": plan, "step": i, "token": token, "amount": amount.to_string() });

    // In one step...
    let result = w.chain.call(&a, &w.pool, "check_step", step("plan-1", 0, &w.musdc, usd(50_001)), yocto(0)).await;
    assert_refused(&result, "need the operator's co-signature");
    // ...or in many: five steps of $10k pass, and a sixth would take the day past $50k.
    for i in 0..5 {
        w.chain.ok(&a, &w.pool, "check_step", step("plan-1", i, &w.musdc, usd(10_000))).await;
    }
    let result = w.chain.call(&a, &w.pool, "check_step", step("plan-1", 5, &w.musdc, 1), yocto(0)).await;
    assert_refused(&result, "need the operator's co-signature");
    let mut request = step("plan-1", 5, &w.musdc, usd(5_000));
    request["account_id"] = json!(a);
    let request = json!({ "step": request });
    w.admin("cosign", json!({ "request": request })).await;
    w.chain.ok(&a, &w.pool, "check_step", step("plan-1", 5, &w.musdc, usd(5_000))).await;
    let result = w.chain.call(&a, &w.pool, "check_step", step("plan-1", 5, &w.musdc, usd(5_000)), yocto(0)).await;
    assert_refused(&result, "need the operator's co-signature");

    // Steps in other tokens count at the operator's price.
    let result = w.chain.call(&b, &w.pool, "check_step", step("plan-2", 0, &w.mnbtc, 1), yocto(0)).await;
    assert_refused(&result, "no step price is set");
    w.admin("set_step_price", json!({ "token": w.mnbtc, "decimals": 8, "price": usd(120_000).to_string() })).await;
    let result = w.chain.call(&b, &w.pool, "check_step", step("plan-2", 0, &w.mnbtc, 41_666_667), yocto(0)).await;
    assert_refused(&result, "need the operator's co-signature");
    w.chain.ok(&b, &w.pool, "check_step", step("plan-2", 0, &w.mnbtc, 41_666_666)).await;

    // While paused, no plan step runs.
    w.admin("set_paused", json!({ "paused": true })).await;
    let result = w.chain.call(&b, &w.pool, "check_step", step("plan-2", 1, &w.musdc, 1), yocto(0)).await;
    assert_refused(&result, "the pool is paused");
}

#[tokio::test]
async fn interest_per_tier_write_offs_and_loans_that_go_back() {
    let w = World::new(usd(10_000_000), Some(short_periods())).await;
    let (p, s, x) = (w.borrower("p").await, w.borrower("s").await, w.borrower("x").await);
    let unregistered = w.unregistered_borrower("no-storage").await;
    let refuser = w.borrower("refuser").await;
    tokio::time::sleep(Duration::from_secs(4)).await;

    // Each tier pays the base rate plus its spread: at 3% utilisation, 1.225%, 2.225% and 5.225%.
    w.admin("set_kyb", json!({ "account_id": p, "entity": "p-corp" })).await;
    w.borrow_ok(&p, usd(100_000), verdict("PREFERRED", usd(100_000))).await;
    w.borrow_ok(&s, usd(100_000), verdict("STANDARD", usd(100_000))).await;
    w.borrow_ok(&x, usd(100_000), verdict("WATCH", usd(100_000))).await;
    let rates = w.pool_view().await["rate_bp"].clone();
    assert_eq!(rates, json!({ "preferred": 123, "standard": 223, "watch": 523 }));
    tokio::time::sleep(Duration::from_secs(10)).await;
    let interest = |debt: u128| debt - usd(100_000);
    let (ip, is, ix) = (interest(w.debt(&p).await), interest(w.debt(&s).await), interest(w.debt(&x).await));
    assert!(0 < ip && ip < is && is < ix, "interest should grow with the tier's rate: {ip} {is} {ix}");
    let ratio = ix as f64 / is as f64; // 5.225 / 2.225 = 2.35, give or take the seconds between the borrows
    assert!((1.8..3.0).contains(&ratio), "Watch should pay about 2.35× Standard's interest, paid {ratio}");

    // A write-off comes out of capital, is public, and blocks the account.
    let capital_before = str_u128(&w.pool_view().await["capital"]);
    let result = w.chain.call(&x, &w.pool, "write_off", json!({ "account_id": x }), yocto(0)).await;
    assert_ok(&result, "write_off");
    assert!(has_event(&result, "write_off"));
    let view = w.pool_view().await;
    let written_off = str_u128(&view["written_off"]);
    assert!(written_off > usd(100_000));
    assert!(str_u128(&view["capital"]) < capital_before - usd(99_999));
    assert_eq!(w.debt(&x).await, 0);
    w.refused(&x, 1, verdict("WATCH", 1), "blocked after a write-off").await;

    // A loan the account can't receive (not registered on the token) is undone.
    let cash_before = str_u128(&w.pool_view().await["cash"]);
    let result = w.borrow(&unregistered, usd(1_000), verdict("STANDARD", usd(1_000))).await;
    assert!(has_event(&result, "loan_returned"), "the loan wasn't undone: {result:?}");
    assert_eq!(w.debt(&unregistered).await, 0);
    assert_eq!(str_u128(&w.pool_view().await["cash"]), cash_before);

    // So is a loan the account hands back.
    w.chain.ok(&refuser, &refuser, "set_refuse", json!({ "refuse": true })).await;
    let result = w.borrow(&refuser, usd(1_000), verdict("STANDARD", usd(1_000))).await;
    assert!(has_event(&result, "loan_returned"), "the loan wasn't undone: {result:?}");
    assert_eq!(w.debt(&refuser).await, 0);
    assert_eq!(w.balance(&w.musdc, &refuser).await, 0);

    // A defund the operator can't receive (it left the token) puts the cash back.
    let operator_balance = w.balance(&w.musdc, &w.operator).await;
    if operator_balance > 0 {
        let args = json!({ "receiver_id": p, "amount": operator_balance.to_string() });
        w.chain.ok_with(&w.operator, &w.musdc, "ft_transfer", args, one_yocto()).await;
    }
    w.chain.ok_with(&w.operator, &w.musdc, "storage_unregister", json!({}), one_yocto()).await;
    let cash_before = str_u128(&w.pool_view().await["cash"]);
    let result =
        w.chain.call(&w.operator, &w.pool, "defund", json!({ "amount": usd(1_000).to_string() }), one_yocto()).await;
    assert!(has_event(&result, "defund_failed"), "the defund wasn't undone: {result:?}");
    assert_eq!(str_u128(&w.pool_view().await["cash"]), cash_before);
}
