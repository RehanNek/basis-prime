//! Upgrades from the code deployed on testnet (INTERFACES.md 21 and 23). Each test puts contracts' live code and
//! state into the sandbox under their testnet names, as `tests/fetch_live.py` read them from testnet (`view_code` and
//! `view_state`), then deploys the new build over them:
//! - the drill reads its old state after `migrate`, both ways;
//! - the factory reads its old state after `migrate`, which adds the config's place for lenders (Phase 6), and makes
//!   working accounts with the new account code, with and without a funding permission, which the live pool and
//!   tokens register;
//! - an old client account's state needs its own code: the new account code refuses it (client accounts are never
//!   upgraded, since they hold no keys).
//!
//! The pool's own upgrade is in `upgrade_pool_fees.rs`: its `migrate` reads the state the pool holds today, and no
//! longer the Phase 5 state saved in `target/live/` (INTERFACES.md 45.1, point 5).
//!
//! Fetch the live files first: `python3 -I contracts/tests/fetch_live.py`.
mod common;

use common::*;
use near_api::{AccountId, NearToken};
use serde_json::{json, Value};

/// `drill.pbf-ops.testnet`'s code on 9 Nov: the 7 Nov build, which holds only the owner and the shared ratio.
const LIVE_DRILL_SHA256: &str = "d3fd430880bb050ea7117412002a87ad2eb388ff03708149597cbc320de086e5";

/// The live drill in the sandbox, with its owner and its ratio as the live code reads them.
async fn live_drill(chain: &Chain) -> (AccountId, AccountId, Value) {
    let live = Live::load("drill");
    assert_eq!(live.sha256, LIVE_DRILL_SHA256, "target/live/drill.wasm is not the code deployed on 9 Nov");
    let drill = chain.deploy_live(&live, 5).await;
    assert_eq!(chain.code_sha256(&drill).await, LIVE_DRILL_SHA256);
    let owner: AccountId = chain.view(&drill, "owner", json!({})).await;
    let ratio: Value = chain.view(&drill, "get_ratio", json!({})).await;
    // The live code has no per-account ratios.
    let missing = chain.try_view::<Value>(&drill, "get_ratio_for", json!({ "account_id": "drill1.pbf.testnet" })).await;
    assert!(missing.is_err_and(|e| e.contains("MethodNotFound")), "the live drill already has get_ratio_for");
    (drill, chain.named_account(owner.as_str(), 5).await, ratio)
}

#[tokio::test]
async fn the_live_drill_upgrades_keeps_its_ratio_and_gains_per_account_ratios() {
    let chain = Chain::start().await;
    let (drill, owner, shared) = live_drill(&chain).await;
    assert_eq!(owner.as_str(), "pbf-ops.testnet");
    let stranger = chain.account("stranger", 5).await;
    let (client, other) = ("drill1.pbf.testnet", "hedge1.pbf.testnet");

    // The new code can't read the old state until it is migrated.
    chain.deploy(&drill, wasm("pb_drill")).await;
    let before = chain.try_view::<Value>(&drill, "get_ratio", json!({})).await;
    assert!(before.is_err_and(|e| e.contains("Cannot deserialize the contract state")));

    // Only the owner migrates, and the owner and the shared ratio come through.
    assert_refused(&chain.call(&stranger, &drill, "migrate", json!({}), yocto(0)).await, "only the owner can migrate");
    chain.ok(&owner, &drill, "migrate", json!({})).await;
    assert_eq!(chain.view::<AccountId>(&drill, "owner", json!({})).await, owner);
    assert_eq!(chain.view::<Value>(&drill, "get_ratio", json!({})).await, shared);
    assert_eq!(chain.view::<Value>(&drill, "get_ratio_for", json!({ "account_id": client })).await, shared);
    let again = chain.call(&owner, &drill, "migrate", json!({}), yocto(0)).await;
    assert_refused(&again, "Cannot deserialize the contract state");

    // An account's own ratio replaces the shared one for it alone.
    chain.ok(&owner, &drill, "set_ratio_for", json!({ "account_id": client, "bp": 7_500 })).await;
    let ratio_for = |account: &'static str| {
        let (chain, drill) = (&chain, &drill);
        async move { chain.view::<Value>(drill, "get_ratio_for", json!({ "account_id": account })).await["bp"].clone() }
    };
    assert_eq!(ratio_for(client).await, 7_500);
    assert_eq!(ratio_for(other).await, shared["bp"]);
    assert_eq!(chain.view::<Value>(&drill, "get_ratio", json!({})).await, shared);

    // A new shared ratio reaches the other accounts only; clearing the account's ratio brings the shared one back.
    chain.ok(&owner, &drill, "set_ratio", json!({ "bp": 9_000 })).await;
    assert_eq!((ratio_for(client).await, ratio_for(other).await), (json!(7_500), json!(9_000)));
    chain.ok(&owner, &drill, "clear_ratio_for", json!({ "account_id": client })).await;
    assert_eq!(ratio_for(client).await, 9_000);

    // Only the owner sets or clears an account's ratio, within the same 10,000 bp cap.
    let by_stranger =
        chain.call(&stranger, &drill, "set_ratio_for", json!({ "account_id": client, "bp": 1 }), yocto(0));
    assert_refused(&by_stranger.await, "only the owner can set the ratio");
    let by_stranger = chain.call(&stranger, &drill, "clear_ratio_for", json!({ "account_id": client }), yocto(0));
    assert_refused(&by_stranger.await, "only the owner can set the ratio");
    let above = chain.call(&owner, &drill, "set_ratio_for", json!({ "account_id": client, "bp": 10_001 }), yocto(0));
    assert_refused(&above.await, "the ratio is at most 10,000 bp");
}

#[tokio::test]
async fn the_live_drill_can_also_migrate_in_the_deploys_own_transaction() {
    let chain = Chain::start().await;
    let (drill, owner, shared) = live_drill(&chain).await;
    let deployed = chain.deploy_with_init(&drill, wasm("pb_drill"), "migrate").await;
    assert_ok(&deployed, "deploy with migrate");
    assert_eq!(chain.view::<Value>(&drill, "get_ratio", json!({})).await, shared);
    chain.ok(&owner, &drill, "set_ratio_for", json!({ "account_id": "drill1.pbf.testnet", "bp": 8_000 })).await;
    let ratio: Value = chain.view(&drill, "get_ratio_for", json!({ "account_id": "drill1.pbf.testnet" })).await;
    assert_eq!(ratio["bp"], 8_000);
}

/// `pbf.testnet`'s code on 9 Nov: the Phase 4 factory, which carries the account code below.
// The Phase 5 factory, live since 9 Nov and fetched again on 11 Nov before stage 2. (The first save held the Phase 4
// factory, f7efc538…; it is kept in contracts/target/live-2026-11-09/.)
const LIVE_FACTORY_SHA256: &str = "2064eae1b81bb641db59ff490bc8b1881194507e26becd4480e618c0413845fa";
/// The account code of the Phase 4 clients, as `drill1.pbf.testnet` runs it (9 Nov).
const LIVE_ACCOUNT_SHA256: &str = "1a293b2aef45e41aee08f7ca2c6a745074390ed6af12cc971970024dd2ef1eda";
/// The account code the live (Phase 5) factory carries and gives new clients (INTERFACES.md, "Phase 5: live on testnet").
const LIVE_FACTORY_ACCOUNT_SHA256: &str = "496b93521b9b3489c369961c0f6eae36162a69e4073239139689f9d0815a4e06";

/// The factory's views that read its stored state.
async fn factory_views(chain: &Chain, factory: &AccountId) -> Vec<Value> {
    let mut out = Vec::new();
    for method in ["get_config", "list_accounts", "accounts_count", "is_paused"] {
        out.push(chain.view::<Value>(factory, method, json!({})).await);
    }
    out
}

/// The lenders of INTERFACES.md 24, for the live config: our Rhea copy taking the test nBTC, and Aave on Base Sepolia.
fn lenders() -> Value {
    json!({
        "rhea": { "contract_id": "rhea.pbf-ops.testnet", "collateral": ["mnbtc.pbf-ops.testnet"] },
        "aave": {
            "chain_id": 84532, "pool": "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
            "usdc": { "symbol": "USDC", "address": "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", "decimals": 6 },
            "collateral": [{ "symbol": "WBTC", "address": "0x54114591963CF60EF3aA63bEfD6eC263D98145a4", "decimals": 8 }],
            "max_fee_per_gas": "5000000000",
        },
    })
}

#[tokio::test]
async fn the_live_factory_upgrades_with_migrate_keeps_its_state_and_gains_a_place_for_lenders() {
    let chain = Chain::start().await;
    let live = Live::load("factory");
    assert_eq!(live.sha256, LIVE_FACTORY_SHA256, "target/live/factory.wasm is not the code deployed on 9 Nov");
    let factory = chain.deploy_live(&live, 10).await;
    let before = factory_views(&chain, &factory).await;
    assert_eq!(chain.view::<String>(&factory, "account_code_hash", json!({})).await, LIVE_FACTORY_ACCOUNT_SHA256);
    assert!(before[2].as_u64().unwrap() > 0, "the live factory lists no accounts");
    assert!(before[0].get("lenders").is_none(), "the live factory's config already has lenders");

    // The new config has one more field, so the new build can't read the old state until it is migrated.
    chain.deploy(&factory, wasm("pb_factory")).await;
    let unread = chain.try_view::<Value>(&factory, "get_config", json!({})).await;
    assert!(unread.is_err_and(|e| e.contains("Cannot deserialize the contract state")));
    // Only the factory account itself migrates. With no arguments, the config gets no lenders yet.
    let stranger = chain.account("stranger", 5).await;
    let by_stranger = chain.call(&stranger, &factory, "migrate", json!({}), yocto(0)).await;
    assert_refused(&by_stranger, "Method migrate is private");
    chain.ok(&factory, &factory, "migrate", json!({})).await;
    // The operator, the config, the pause flag and the list all came through.
    let mut expected = before.clone();
    expected[0]["lenders"] = json!({ "rhea": null, "aave": null });
    assert_eq!(factory_views(&chain, &factory).await, expected);
    let code_hash: String = chain.view(&factory, "account_code_hash", json!({})).await;
    assert_eq!(code_hash, sha256_hex(&wasm("pb_account")), "the factory doesn't carry the new account code");
    // It can't run twice.
    let again = chain.call(&factory, &factory, "migrate", json!({}), yocto(0)).await;
    assert_refused(&again, "Cannot deserialize the contract state");
    assert_eq!(factory_views(&chain, &factory).await, expected);

    // The state also writes back: the operator (`pbf-ops.testnet`, INTERFACES.md 1) pauses and resumes creation,
    // and gives new accounts their lenders with `set_config`.
    let operator = chain.named_account("pbf-ops.testnet", 5).await;
    chain.ok(&operator, &factory, "set_paused", json!({ "paused": true })).await;
    assert!(chain.view::<bool>(&factory, "is_paused", json!({})).await);
    chain.ok(&operator, &factory, "set_paused", json!({ "paused": false })).await;
    assert_eq!(factory_views(&chain, &factory).await, expected);
    let mut config = expected[0].clone();
    config["lenders"] = lenders();
    chain.ok(&operator, &factory, "set_config", json!({ "config": config })).await;
    assert_eq!(chain.view::<Value>(&factory, "get_config", json!({})).await, config);
    // Lenders that don't fit the config are refused: Rhea's collateral must be a listed token.
    let mut bad = config.clone();
    bad["lenders"]["rhea"]["collateral"] = json!(["other.pbf-ops.testnet"]);
    let refused = chain.call(&operator, &factory, "set_config", json!({ "config": bad }), yocto(0)).await;
    assert_refused(&refused, "lenders.rhea.collateral must be listed tokens other than usdc_token");
}

#[tokio::test]
async fn the_live_factory_can_migrate_with_its_lenders_in_one_call() {
    let chain = Chain::start().await;
    let factory = chain.deploy_live(&Live::load("factory"), 10).await;
    let before = factory_views(&chain, &factory).await;
    chain.deploy(&factory, wasm("pb_factory")).await;
    // Lenders that don't fit are refused, and the old state stays for another try.
    let mut bad = lenders();
    bad["aave"]["pool"] = json!("0x8bAB");
    let refused = chain.call(&factory, &factory, "migrate", json!({ "lenders": bad }), yocto(0)).await;
    assert_refused(&refused, "lenders.aave.pool must be 0x and 40 hex digits");
    chain.ok(&factory, &factory, "migrate", json!({ "lenders": lenders() })).await;
    let mut expected = before;
    expected[0]["lenders"] = lenders();
    assert_eq!(factory_views(&chain, &factory).await, expected);
}

/// `pool.pbf.testnet`'s code on 9 Nov, and both test tokens'.
const LIVE_POOL_SHA256: &str = "f9c3b708e9ac6b34d4a9400121751a73cd8a0ada1eab1c3b3e9f68f8bc7ec484";
const LIVE_TOKEN_SHA256: &str = "f17e208da721c9d1740288997f3d9f057152d5ac212d32d376d80def1f57a714";

#[tokio::test]
async fn the_upgraded_live_factory_makes_working_accounts_with_the_new_code() {
    let chain = Chain::start().await;
    // The live pool and tokens, under the testnet names the factory's config gives them.
    for (name, sha256) in [("pool", LIVE_POOL_SHA256), ("musdc", LIVE_TOKEN_SHA256), ("mnbtc", LIVE_TOKEN_SHA256)] {
        let live = Live::load(name);
        assert_eq!(live.sha256, sha256, "target/live/{name}.wasm is not the code deployed on 9 Nov");
        chain.deploy_live(&live, 10).await;
    }
    let factory = chain.deploy_live(&Live::load("factory"), 10).await;
    // The upgrade as it will be sent: the new code and `migrate` in one transaction.
    let upgraded = chain.deploy_with_init(&factory, wasm("pb_factory"), "migrate").await;
    assert_ok(&upgraded, "deploy with migrate");
    let config: Value = chain.view(&factory, "get_config", json!({})).await;
    assert_eq!(config["lenders"], json!({ "rhea": null, "aave": null }));
    let count: u64 = chain.view(&factory, "accounts_count", json!({})).await;

    // A client makes an account through the upgraded factory, with its live state.
    let client = chain.account("client", 20).await;
    let args = json!({ "name": "w1audit", "owner": client });
    let made = chain.call(&client, &factory, "create_account", args, NearToken::from_near(6)).await;
    assert_ok(&made, "create_account");
    assert!(made.clone().json::<bool>().unwrap(), "create_account reported a failed step: {made:?}");
    let account: AccountId = "w1audit.pbf.testnet".parse().unwrap();
    // It runs the new code with the live config, and the live pool and tokens have registered it.
    assert_eq!(chain.code_sha256(&account).await, sha256_hex(&wasm("pb_account")));
    assert_eq!(chain.view::<Value>(&account, "get_config", json!({})).await, config);
    let state: Value = chain.view(&account, "get_state", json!({})).await;
    let fresh = (state["owner"].clone(), state["counter"].clone(), state["blocked"].clone(), state["default"].clone());
    assert_eq!(fresh, (json!(client), json!(0), json!(false), json!({ "first_at": "0" })));
    let pool: AccountId = config["pool_id"].as_str().unwrap().parse().unwrap();
    let borrower: Value = chain.view(&pool, "get_borrower", json!({ "account_id": account })).await;
    assert!(!borrower.is_null(), "the live pool doesn't know the new account");
    for token in config["tokens"].as_array().unwrap() {
        let token: AccountId = token["id"].as_str().unwrap().parse().unwrap();
        let storage: Value = chain.view(&token, "storage_balance_of", json!({ "account_id": account })).await;
        assert!(!storage.is_null(), "{token} doesn't know the new account");
    }
    assert_eq!(chain.view::<u64>(&factory, "accounts_count", json!({})).await, count + 1);
    // Opened the old way, with no permission, it has none, and no funding plan.
    assert_eq!((state["permission"].clone(), state["funding"].clone()), (Value::Null, Value::Null));

    // Once the operator has given the config its lenders, a client opens an account and permits them in one call.
    let operator = chain.named_account("pbf-ops.testnet", 5).await;
    let mut with_lenders = config.clone();
    with_lenders["lenders"] = lenders();
    chain.ok(&operator, &factory, "set_config", json!({ "config": with_lenders })).await;
    let terms = json!({ "lenders": ["aave", "rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any" });
    let args = json!({ "name": "w1funded", "owner": client, "permission": terms });
    let made = chain.call(&client, &factory, "create_account", args, NearToken::from_near(6)).await;
    assert_ok(&made, "create_account with a permission");
    assert!(made.clone().json::<bool>().unwrap(), "create_account reported a failed step: {made:?}");
    let funded: AccountId = "w1funded.pbf.testnet".parse().unwrap();
    assert_eq!(chain.view::<Value>(&funded, "get_config", json!({})).await, with_lenders);
    let state: Value = chain.view(&funded, "get_state", json!({})).await;
    assert_eq!((state["permission"].clone(), state["funding"].clone()), (terms, Value::Null));
    // The first account keeps the config it was made with: no lenders.
    assert_eq!(chain.view::<Value>(&account, "get_config", json!({})).await, config);
    assert_eq!(chain.view::<u64>(&factory, "accounts_count", json!({})).await, count + 2);

    // What a new account's storage locks (a byte locks 10^19 yoctoNEAR), against the factory's minimum deposit. The
    // factory keeps 0.0245 NEAR of the deposit for the registrations and its own record.
    let (plain, permitted) = (chain.storage_usage(&account).await, chain.storage_usage(&funded).await);
    let code = wasm("pb_account").len() as u64;
    println!("storage: account code {code} B; a new account {plain} B; with lenders and a permission {permitted} B");
    assert!(plain > code && permitted > plain);
    let locked = u128::from(permitted) * 10u128.pow(19);
    let handed_over = |near: u128| (near * 1_000_000 - 24_500) * 10u128.pow(18);
    // The 5 NEAR that the first Phase 6 code asked for no longer covers the storage of the code that signs Aave's
    // transactions (540 KB with the pause that lifts early). The factory asks for 6, which leaves an account over
    // 0.55 NEAR to work with, and says so up front. Of that, Rhea's registration takes 0.1, and an account's state can
    // grow by about a quarter of a NEAR's worth: its plans, a verdict, and the 20 Hyperliquid actions and 20 Ethereum
    // transactions it keeps.
    let half = 5 * 10u128.pow(23);
    assert!(
        locked + half > handed_over(5),
        "5 NEAR leaves a new account 0.5 NEAR again: the minimum can come back down"
    );
    assert!(locked + half + half / 10 < handed_over(6), "6 NEAR leaves a new account under 0.55 NEAR to work with");
    let args = json!({ "name": "w1min", "owner": client });
    let at_5 = chain.call(&client, &factory, "create_account", args, NearToken::from_near(5)).await;
    assert_refused(&at_5, "attach at least 6 NEAR");
    assert_eq!(chain.view::<u64>(&factory, "accounts_count", json!({})).await, count + 2);
}

/// Client accounts hold no keys, so their code is never replaced: a fix reaches only accounts made after the factory
/// carries it. The fixed code also keeps DEFAULT's two-check record in its state (research/audit.md, A2), so it can't
/// read an old account's state at all. It refuses it rather than misreading it, and the old code still reads it.
#[tokio::test]
async fn an_old_accounts_state_needs_its_own_code_and_the_new_code_refuses_it() {
    let chain = Chain::start().await;
    let live = Live::load("account");
    assert_eq!(live.sha256, LIVE_ACCOUNT_SHA256, "target/live/account.wasm is not drill1's code on 9 Nov");
    let account = chain.deploy_live(&live, 10).await;
    let state: Value = chain.view(&account, "get_state", json!({})).await;
    assert_eq!(state["owner"].as_str().map(|o| !o.is_empty()), Some(true));
    assert!(state.get("default").is_none(), "the live account already has DEFAULT's record");
    chain.deploy(&account, wasm("pb_account")).await;
    let refused = chain.try_view::<Value>(&account, "get_state", json!({})).await;
    assert!(refused.is_err_and(|e| e.contains("Cannot deserialize the contract state")));
    chain.deploy(&account, live.wasm.clone()).await;
    assert_eq!(chain.view::<Value>(&account, "get_state", json!({})).await, state);
}
