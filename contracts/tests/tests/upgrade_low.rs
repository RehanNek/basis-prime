//! The factory's upgrade for the account's Low findings, tried on the sandbox before it touches testnet
//! (INTERFACES.md 47).
//!
//! The factory on testnet runs the code of 12 Nov, 21:42 UTC (INTERFACES.md 46). This round changes nothing in what
//! it stores: only the account code it carries is new. So the upgrade is once more a plain redeploy with NO init
//! call. The test puts the live factory, pool and tokens into the sandbox under their testnet names, with their code
//! and state as `tests/fetch_live.py` read them on 12 Nov at 22:55 UTC, and the MPC mock under the name the live
//! config gives the signer.
//!
//! The live files are in a folder of their own:
//! `python3 -I contracts/tests/fetch_live.py --out contracts/target/live-low pool factory musdc mnbtc`.
mod common;

use common::rhea::{call_with_gas, mint, token_balance};
use common::*;
use near_api::{AccountId, NearToken};
use serde_json::{json, Value};

/// `pbf.testnet`'s code since 12 Nov 21:42 UTC, the account code it carries, and the pool's since 21:40, which this
/// upgrade leaves alone (INTERFACES.md 46).
const LIVE_FACTORY_SHA256: &str = "2cb452a5dd667eeab46688212fa0496fd6219965447dfda26484373acbb92609";
const LIVE_ACCOUNT_SHA256: &str = "b8acf77b236f0559c5bbf51ee1f7cf5134bf0933999a595b8c5776608e3b1269";
const LIVE_POOL_SHA256: &str = "ca21d5336508de33b0e2c9ff068877bbf85d9b561ed1eb8d61c7f64a6963ab4c";
/// The folder of `contracts/target/` the live files are in.
const LIVE: &str = "live-low";
/// What `pbf.testnet` held on 12 Nov, rounded down.
const FACTORY_NEAR: u128 = 10;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const BYTE: u128 = 10_000_000_000_000_000_000;

/// The factory's views that read its stored state.
async fn factory_views(chain: &Chain, factory: &AccountId) -> Vec<Value> {
    let mut out = Vec::new();
    for method in ["get_config", "list_accounts", "accounts_count", "is_paused"] {
        out.push(chain.view::<Value>(factory, method, json!({})).await);
    }
    out
}

#[tokio::test]
async fn the_live_factory_takes_the_account_code_with_the_low_fixes_with_no_init_call_and_makes_accounts_with_it() {
    let chain = Chain::start().await;
    // The live pool and tokens, under the testnet names the factory's config gives them, and the live factory. The
    // pool isn't part of this upgrade, and the tree builds the same pool that is live.
    for name in ["pool", "musdc", "mnbtc"] {
        chain.deploy_live(&Live::load_from(LIVE, name), 10).await;
    }
    assert_eq!(Live::load_from(LIVE, "pool").sha256, LIVE_POOL_SHA256);
    assert_eq!(sha256_hex(&wasm("pb_pool")), LIVE_POOL_SHA256, "this round must not change the pool");
    let live = Live::load_from(LIVE, "factory");
    assert_eq!(live.sha256, LIVE_FACTORY_SHA256, "target/{LIVE}/factory.wasm is not the live factory's code");
    let factory = chain.deploy_live(&live, FACTORY_NEAR).await;
    assert_eq!(factory.as_str(), "pbf.testnet");
    let before = factory_views(&chain, &factory).await;
    assert_eq!(chain.view::<String>(&factory, "account_code_hash", json!({})).await, LIVE_ACCOUNT_SHA256);
    assert_ne!(sha256_hex(&wasm("pb_account")), LIVE_ACCOUNT_SHA256, "the account this tree builds is the live one");
    let config = before[0].clone();
    let had = before[1].as_array().unwrap().len();
    assert_eq!(before[2], json!(had));
    assert!(had >= 16, "the live factory listed 16 accounts on 12 Nov at 22:55 UTC, not {had}");
    // The MPC mock stands in for the signer the live config names.
    let mpc = chain.named_account(config["mpc_id"].as_str().unwrap(), 10).await;
    chain.deploy(&mpc, wasm("pb_testnet_mpc_mock")).await;

    // The mistake to rule out: the new code sent with `migrate` as its init call. It is refused as a whole, and the
    // factory keeps its code and state.
    let mistake = chain.deploy_with_init(&factory, wasm("pb_factory"), "migrate").await;
    assert_refused(&mistake, "Cannot deserialize the contract state");
    assert_eq!(chain.code_sha256(&factory).await, LIVE_FACTORY_SHA256);
    assert_eq!(factory_views(&chain, &factory).await, before);

    // The upgrade as it will be sent: the new code, and no init call. The factory reads its state as it is: the
    // same config, the same accounts, not paused. Only the account code it carries is new.
    let stored_before = chain.storage_usage(&factory).await;
    chain.deploy(&factory, wasm("pb_factory")).await;
    assert_eq!(chain.code_sha256(&factory).await, sha256_hex(&wasm("pb_factory")));
    assert_eq!(factory_views(&chain, &factory).await, before);
    let carried: String = chain.view(&factory, "account_code_hash", json!({})).await;
    assert_eq!(carried, sha256_hex(&wasm("pb_account")), "the factory doesn't carry the new account code");
    let (stored, held) = (chain.storage_usage(&factory).await, chain.balance(&factory).await);
    let free = held - u128::from(stored) * BYTE;
    println!(
        "NEAR the factory after the redeploy: storage {stored} B, {} B more than before, free {} milliNEAR of {FACTORY_NEAR}",
        i128::from(stored) - i128::from(stored_before),
        free / (NEAR / 1000)
    );
    assert!(free > NEAR, "the redeployed factory has under 1 NEAR free");

    // A new account: made with 6 NEAR and 300 TGas as every caller does, with the live config, known to the live pool
    // and tokens, listed after the ones the factory had.
    let client = chain.account("client", 30).await;
    let terms = json!({ "lenders": ["aave", "rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any" });
    let args = json!({ "name": "w1low", "owner": client, "permission": terms });
    let made = call_with_gas(&chain, &client, &factory, "create_account", args, NearToken::from_near(6), 300).await;
    assert_ok(&made, "create_account");
    assert!(made.clone().json::<bool>().unwrap(), "create_account reported a failed step: {made:?}");
    let account: AccountId = "w1low.pbf.testnet".parse().unwrap();
    assert_eq!(chain.code_sha256(&account).await, sha256_hex(&wasm("pb_account")));
    assert_eq!(chain.view::<Value>(&account, "get_config", json!({})).await, config);
    let pool: AccountId = config["pool_id"].as_str().unwrap().parse().unwrap();
    let borrower: Value = chain.view(&pool, "get_borrower", json!({ "account_id": account })).await;
    assert!(!borrower.is_null(), "the live pool doesn't know the new account");
    let listed: Vec<Value> = chain.view(&factory, "list_accounts", json!({})).await;
    assert_eq!(listed[..had], before[1].as_array().unwrap()[..]);
    assert_eq!((listed.len(), listed[had]["account_id"].clone()), (had + 1, json!(account)));
    let (stored, held) = (u128::from(chain.storage_usage(&account).await), chain.balance(&account).await);
    let free = (held - stored * BYTE) / (NEAR / 1000);
    println!("NEAR a new account: storage {stored} B, free {free} milliNEAR of 6");
    assert!(held - stored * BYTE > NEAR * 11 / 20, "a new account has under 0.55 NEAR free");

    // Every field an older reader uses is still in its state, and the permission came in as before.
    let state: Value = chain.view(&account, "get_state", json!({})).await;
    for field in ["loan", "pending", "counter", "permission", "permission_blk", "next_move", "evm", "hl"] {
        assert!(!state[field].is_null() || field == "evm" || field == "hl", "get_state lost {field}: {state}");
    }
    assert_eq!((state["permission"].clone(), state["counter"].clone()), (terms, json!(0)));
    assert_eq!(state["loan"], json!({ "principal": "0", "open": false }), "the loan record's view changed shape");

    // A deposit and a plain withdrawal work as before: test bitcoin from the live token's faucet in, half of it out to
    // a receiver the token doesn't know yet. The account pays that registration from its own NEAR, as it has plenty.
    let mnbtc: AccountId = "mnbtc.pbf-ops.testnet".parse().unwrap();
    mint(&chain, &mnbtc, &client, 100_000).await;
    let deposit = json!({ "receiver_id": account, "amount": "100000", "msg": "" });
    chain.ok_with(&client, &mnbtc, "ft_transfer_call", deposit, one_yocto()).await;
    let friend = chain.account("friend", 5).await;
    let out = json!({ "token": mnbtc, "amount": "50000", "receiver": friend });
    let sent = chain.call(&client, &account, "withdraw", out, one_yocto()).await;
    assert_ok(&sent, "a withdrawal to a receiver the token doesn't know");
    assert_eq!(token_balance(&chain, &mnbtc, &friend).await, 50_000);
    assert_eq!(token_balance(&chain, &mnbtc, &account).await, 50_000);
}
