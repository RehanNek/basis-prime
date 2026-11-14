//! The pool's upgrade for the three findings of the second audit pass (INTERFACES.md 45; research/audit.md, P3, P5
//! and P4), tried on the sandbox before it touches testnet.
//!
//! The pool on testnet runs stage 2's code and holds real test state: 13 accounts, 7 of them with a pricing record.
//! The new code's root state has more fields (three limits on a fee, the pool's fee window and its reversed fees,
//! and a map of each account's), so the upgrade is the new code with `migrate` as its init call, in one transaction
//! signed by the pool account. The test puts the live pool and its lending token into the sandbox under their
//! testnet names, with their code and state as `tests/fetch_live.py` read them on 12 Nov at 19:50 UTC, runs the
//! upgrade, and compares every view the old pool answered with what the new one answers. Then old accounts settle,
//! a fee is cut to its budget, and the operator takes one back, all on the migrated state.
//!
//! The live files are in a folder of their own:
//! `python3 -I contracts/tests/fetch_live.py --out contracts/target/live-pool-fees pool factory musdc mnbtc`.
mod common;

use std::time::Duration;

use common::*;
use near_api::AccountId;
use serde_json::{json, Value};

/// `pool.pbf.testnet`'s code since stage 2 (INTERFACES.md 32).
const LIVE_POOL_SHA256: &str = "c4641c0e8d61015fa6d608abf46f0b00d2fa1bcb882b4cd02738b878d64024a2";
/// The folder of `contracts/target/` the live files are in.
const LIVE: &str = "live-pool-fees";
/// What `pool.pbf.testnet` held on 12 Nov, rounded down: 6.77 NEAR.
const POOL_NEAR: u128 = 6;
/// The pool's cash on 12 Nov: $10,000,000.003927.
const CASH: u128 = 10_000_000_003_927;
const YEAR_NS: u128 = 365 * DAY_NS as u128;

/// The 13 accounts the live pool knows. The last seven have a pricing record.
const ACCOUNTS: [&str; 13] = [
    "demo1.pbf.testnet",
    "drill1.pbf.testnet",
    "hedge1.pbf.testnet",
    "faults1.pbf.testnet",
    "quiethare6001.pbf.testnet",
    "quiethare-hedge.pbf.testnet",
    "gate2a.pbf.testnet",
    "fund-rhea-watch1.pbf.testnet",
    "fund-aave-11112049.pbf.testnet",
    "fund-move-11120836.pbf.testnet",
    "fund-move-11121239.pbf.testnet",
    "fund-rhea-11121251.pbf.testnet",
    "fund-rhea-11121507.pbf.testnet",
];

/// Every view of the pool that reads its stored state: its settings, its totals, the coin statuses, the published
/// versions, and for each account the borrower view, the debt and the pricing view. The live pool has no loans
/// out, so none of them moves with the clock inside the test's minute.
async fn pool_views(chain: &Chain, pool: &AccountId) -> Vec<Value> {
    let mut out = Vec::new();
    for method in ["get_params", "get_pool", "coin_statuses"] {
        out.push(chain.view::<Value>(pool, method, json!({})).await);
    }
    for program in ["pb-risk", "pb-gateway"] {
        out.push(chain.view::<Value>(pool, "versions", json!({ "program": program })).await);
    }
    for account in ACCOUNTS {
        for method in ["get_borrower", "debt_of", "get_pricing"] {
            out.push(chain.view::<Value>(pool, method, json!({ "account_id": account })).await);
        }
    }
    out
}

/// Where an account's three views start in `pool_views`.
fn views_of(account: &str) -> usize {
    5 + 3 * ACCOUNTS.iter().position(|a| *a == account).expect("not one of the live accounts")
}

#[tokio::test]
async fn the_live_pool_takes_the_fee_limits_with_migrate_and_keeps_everything_it_holds() {
    let chain = Chain::start().await;
    let live = Live::load_from(LIVE, "pool");
    assert_eq!(live.sha256, LIVE_POOL_SHA256, "target/{LIVE}/pool.wasm is not the code deployed since stage 2");
    assert_eq!(live.values.len(), 21, "the live pool holds its root state, 13 borrowers and 7 pricing records");
    let pool = chain.deploy_live(&live, POOL_NEAR).await;
    assert_eq!(pool.as_str(), "pool.pbf.testnet");
    // Its lending token, which holds the pool's cash and knows its accounts.
    let musdc = chain.deploy_live(&Live::load_from(LIVE, "musdc"), 10).await;

    let before = pool_views(&chain, &pool).await;
    assert_eq!(before.len(), 5 + 3 * 13);
    assert!(before.iter().all(|view| !view.is_null()), "the live pool doesn't know one of its accounts");
    assert!(before[0]["pricing_limits"].get("max_lender_debt").is_none(), "the live pool already limits a fee");
    assert_eq!(before[0]["pricing_limits"]["min_period_ns"], 120_000_000_000u64);
    assert_eq!(before[0]["funding"], json!({ "order": "lender_first", "loan_days": 90 }));
    assert_eq!((before[1]["cash"].clone(), before[1]["loans"].clone()), (json!(CASH.to_string()), json!("0")));
    assert_eq!((before[1]["fees_charged"].clone(), before[1]["subsidy_paid"].clone()), (json!("847"), json!("703")));
    let no_method = |method: &'static str, args: Value| {
        let (chain, pool) = (&chain, &pool);
        async move { chain.try_view::<Value>(pool, method, args).await.is_err_and(|e| e.contains("MethodNotFound")) }
    };
    let reverse = json!({ "account_id": ACCOUNTS[12], "amount": "1" });
    assert!(no_method("reverse_fee", reverse).await, "the live pool already has reverse_fee");

    // The new state has more fields, so the new build can't read the old state until it is migrated.
    chain.deploy(&pool, wasm("pb_pool")).await;
    let unread = chain.try_view::<Value>(&pool, "get_params", json!({})).await;
    assert!(unread.is_err_and(|e| e.contains("Cannot deserialize the contract state")));
    // Only the pool account itself migrates: not the operator, not a stranger.
    let operator = chain.named_account("pbf-ops.testnet", 5).await;
    let stranger = chain.account("stranger", 5).await;
    for caller in [&operator, &stranger] {
        let refused = chain.call(caller, &pool, "migrate", json!({}), yocto(0)).await;
        assert_refused(&refused, "Method migrate is private");
    }
    // The upgrade as it will be sent: the new code and `migrate` in one transaction, signed by the pool account.
    let upgraded = chain.deploy_with_init(&pool, wasm("pb_pool"), "migrate").await;
    assert_ok(&upgraded, "deploy with migrate");
    println!("deploy with migrate burnt {:.1} TGas in all", upgraded.total_gas_burnt.as_gas() as f64 / 1e12);
    assert_eq!(chain.code_sha256(&pool).await, sha256_hex(&wasm("pb_pool")));

    // Every view the old pool answered answers the same, but for the new fields: the three limits on a fee at
    // their defaults, and nothing reversed yet, for the pool and for each account.
    let mut expected = before.clone();
    expected[0]["pricing_limits"]["max_lender_debt"] = json!("1000000000000");
    expected[0]["pricing_limits"]["account_fee_day"] = json!("1000000000");
    expected[0]["pricing_limits"]["pool_fee_day_bp"] = json!(50);
    expected[1]["fees_reversed"] = json!("0");
    for account in ACCOUNTS {
        expected[views_of(account) + 2]["fees_reversed"] = json!("0");
    }
    let after = pool_views(&chain, &pool).await;
    assert_eq!(after, expected);
    // In full, for the limits: the six it had, its 2 minutes between settlements included, and the three new ones.
    assert_eq!(
        after[0]["pricing_limits"],
        json!({
            "max_rate_bp": 6000, "avg_plus_bp": 500, "max_period_ns": 172_800_000_000_000u64,
            "min_period_ns": 120_000_000_000u64, "account_subsidy_day": "100000000", "pool_subsidy_day_bp": 5,
            "max_lender_debt": "1000000000000", "account_fee_day": "1000000000", "pool_fee_day_bp": 50,
        })
    );
    // And one pricing record in full, as it stood on testnet.
    let gate = "gate2a.pbf.testnet";
    assert_eq!(
        after[views_of(gate) + 2],
        json!({
            "pricing": { "lender": { "margin_bp": 0, "cap_bp": 0 } }, "from": "account", "fees_charged": "234",
            "fees_reversed": "0", "subsidy_paid": "179", "credit": "0", "settled_at": "1794412208985900181",
            "last": [{ "lender": "rhea", "debt": "562730949", "rate_bp": 1603, "supply_bp": 1024 }],
        })
    );

    // It can't run twice, from anyone.
    let again = chain.call(&pool, &pool, "migrate", json!({}), yocto(0)).await;
    assert_refused(&again, "Cannot deserialize the contract state");
    assert_refused(&chain.call(&stranger, &pool, "migrate", json!({}), yocto(0)).await, "Method migrate is private");
    assert_eq!(pool_views(&chain, &pool).await, expected);

    // The state also writes back. The old accounts are contracts on testnet. Here plain accounts stand under their
    // names and sign their calls.
    //
    // A settlement: `gate2a` last settled on 11 Nov with $562.73 at Rhea, under a policy that pays what Rhea charges
    // above its deposit rate. It settles on from that record: a subsidy for the time since, 48 hours at most, which
    // is credit because it owes the pool nothing.
    let gate = chain.named_account(gate, 5).await;
    let report = json!([{ "lender": "rhea", "debt": "562730949", "rate_bp": 1603, "supply_bp": 1024 }]);
    let settled = chain.call(&gate, &pool, "settle", json!({ "report": report }), yocto(0)).await;
    assert_ok(&settled, "settle");
    let answer: Value = settled.json().unwrap();
    let period_ns = str_u128(&answer["period_ns"]);
    assert!(period_ns > 3_600 * SECOND_NS as u128 && period_ns <= 48 * 3_600 * SECOND_NS as u128, "{answer}");
    let subsidy = 562_730_949 * (1_603 - 1_024) * period_ns / (10_000 * YEAR_NS);
    assert_eq!(
        (str_u128(&answer["subsidy"]), str_u128(&answer["credit"]), answer["fee"].clone()),
        (subsidy, subsidy, json!("0"))
    );
    // The claim is paid from the live token.
    let balance = |account: AccountId| {
        let (chain, musdc) = (&chain, &musdc);
        async move { str_u128(&chain.view::<Value>(musdc, "ft_balance_of", json!({ "account_id": account })).await) }
    };
    let held = balance(gate.clone()).await;
    assert_ok(&chain.call(&gate, &pool, "claim_credit", json!({}), yocto(0)).await, "claim_credit");
    assert_eq!(balance(gate.clone()).await, held + subsidy);
    assert_eq!(balance(pool.clone()).await, CASH - subsidy);

    // A fee cut to its budget. The operator (`pbf-ops.testnet`) lets settlements be 2 seconds apart and an account
    // be charged a tenth of a cent a day. `fund-rhea-11121507` pays 5 points over Rhea. Its borrow of $1,000,000
    // passes both figures, as a new account's does: `closes` shows that it owed Rhea nothing until now, so the
    // hours since its last settlement cost it nothing.
    let mut limits = after[0]["pricing_limits"].clone();
    limits["min_period_ns"] = json!(2 * SECOND_NS);
    limits["account_fee_day"] = json!("1000");
    chain.ok(&operator, &pool, "set_pricing_limits", json!({ "limits": limits })).await;
    let margin = chain.named_account(ACCOUNTS[12], 5).await;
    let nothing = json!([{ "lender": "rhea", "debt": "0", "rate_bp": 1593, "supply_bp": 1017 }]);
    let borrowed =
        json!([{ "lender": "rhea", "debt": usd(1_000_000).to_string(), "rate_bp": 1593, "supply_bp": 1017 }]);
    let at_the_borrow =
        chain.call(&margin, &pool, "settle", json!({ "report": borrowed, "closes": nothing }), yocto(0)).await;
    assert_ok(&at_the_borrow, "settle with closes");
    let answer: Value = at_the_borrow.json().unwrap();
    assert_eq!(
        (answer["fee"].clone(), answer["subsidy"].clone(), answer["cut"].clone()),
        (json!("0"), json!("0"), json!("0"))
    );
    tokio::time::sleep(Duration::from_secs(3)).await;
    // A few seconds of 5 points on $1,000,000 are about half a cent: the fee is cut to the tenth of a cent left.
    let settled = chain.call(&margin, &pool, "settle", json!({ "report": borrowed }), yocto(0)).await;
    assert_ok(&settled, "settle");
    assert!(has_event(&settled, "settle"));
    let answer: Value = settled.json().unwrap();
    let full = (usd(1_000_000) * 500 * str_u128(&answer["period_ns"])).div_ceil(10_000 * YEAR_NS);
    assert!(full > 1_000, "the fee before its cut was only {full}");
    assert_eq!((answer["fee"].clone(), str_u128(&answer["cut"])), (json!("1000"), full - 1_000));
    let debt = |account: AccountId| {
        let (chain, pool) = (&chain, &pool);
        async move { str_u128(&chain.view::<Value>(pool, "debt_of", json!({ "account_id": account })).await) }
    };
    let owed = debt(margin.clone()).await;
    assert!((1_000..=1_002).contains(&owed), "the account owes {owed} after a fee of 1,000");

    // The operator takes 600 of it back, and no more than was charged: 206 on testnet and 1,000 here.
    let too_much = json!({ "account_id": margin, "amount": "1207" });
    let refused = chain.call(&operator, &pool, "reverse_fee", too_much, yocto(0)).await;
    assert_refused(&refused, "that is more than the fees charged to this account, less those already reversed");
    let back = json!({ "account_id": margin, "amount": "600" });
    assert_refused(
        &chain.call(&stranger, &pool, "reverse_fee", back.clone(), yocto(0)).await,
        "only the operator can do this",
    );
    let reversed = chain.call(&operator, &pool, "reverse_fee", back, yocto(0)).await;
    assert_ok(&reversed, "reverse_fee");
    assert!(has_event(&reversed, "reverse_fee"));
    let left = debt(margin.clone()).await;
    assert!(left + 600 >= owed && left + 600 <= owed + 2, "{owed} less 600 left {left}");
    let pricing: Value = chain.view(&pool, "get_pricing", json!({ "account_id": margin })).await;
    assert_eq!((pricing["fees_charged"].clone(), pricing["fees_reversed"].clone()), (json!("1206"), json!("600")));
    // The pool's totals: what testnet had, and what this test added.
    let view: Value = chain.view(&pool, "get_pool", json!({})).await;
    assert_eq!((view["fees_charged"].clone(), view["fees_reversed"].clone()), (json!("1847"), json!("600")));
    assert_eq!((str_u128(&view["subsidy_paid"]), view["credit_owed"].clone()), (703 + subsidy, json!("0")));
    assert_eq!(str_u128(&view["cash"]), CASH - subsidy);
    // Every other account is as it was.
    let now = pool_views(&chain, &pool).await;
    for account in ACCOUNTS.iter().filter(|a| **a != gate.as_str() && **a != margin.as_str()) {
        let at = views_of(account);
        assert_eq!(now[at..at + 3], expected[at..at + 3], "{account} changed");
    }
}
