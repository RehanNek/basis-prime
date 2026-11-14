//! The factory's stage 3 upgrade, tried on the sandbox before it touches testnet (INTERFACES.md 33).
//!
//! The factory on testnet runs stage 2's code. Stage 3 changes nothing in what it stores: only the account code it
//! carries is new. So the upgrade is a plain redeploy with NO init call, and `migrate` must not run. The test puts
//! the live factory, pool and tokens into the sandbox under their testnet names, with their code and state as
//! `tests/fetch_live.py` read them on 11 Nov, and the MPC mock under the name the live config gives the signer.
//!
//! Fetch the live files first, into a folder of their own:
//! `python3 -I contracts/tests/fetch_live.py --out contracts/target/live-stage2 factory pool musdc mnbtc`.
mod common;

use std::time::Duration;

use common::*;
use near_api::{AccountId, NearToken};
use serde_json::{json, Value};

/// `pbf.testnet`'s code on 11 Nov, after gate 2, and the account code it carries (INTERFACES.md 32).
const STAGE2_FACTORY_SHA256: &str = "3fef6b1a63500a42d9dd52f5181010c5f2d670774e03b10701a67c6c65d19c00";
const STAGE2_ACCOUNT_SHA256_START: &str = "38261f9d";
/// The folder of `contracts/target/` the live files are in.
const LIVE: &str = "live-stage2";
/// What `pbf.testnet` held on 11 Nov, rounded down: 8.03 NEAR.
const FACTORY_NEAR: u128 = 8;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const BYTE: u128 = 10_000_000_000_000_000_000;

const WBTC: &str = "0x54114591963CF60EF3aA63bEfD6eC263D98145a4";
const WETH: &str = "0x4200000000000000000000000000000000000006";
/// The address of the MPC mock's fixed key, which every account in the sandbox gets.
const ADDRESS: &str = "0xd7f35513286b7a0c2a7d8648c72588751ce0dd7c";

/// The factory's views that read its stored state.
async fn factory_views(chain: &Chain, factory: &AccountId) -> Vec<Value> {
    let mut out = Vec::new();
    for method in ["get_config", "list_accounts", "accounts_count", "is_paused"] {
        out.push(chain.view::<Value>(factory, method, json!({})).await);
    }
    out
}

/// Aave's test market as stage 3 sets it: both collateral tokens, and a fee limit of 1 gwei.
fn aave() -> Value {
    json!({
        "chain_id": 84532, "pool": "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
        "usdc": { "symbol": "USDC", "address": "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", "decimals": 6 },
        "collateral": [
            { "symbol": "WBTC", "address": WBTC, "decimals": 8 },
            { "symbol": "WETH", "address": WETH, "decimals": 18 },
        ],
        "max_fee_per_gas": "1000000000",
    })
}

/// The approval of WETH that Node built and signed for the sandbox (`contracts/account/evm-vectors.mjs`): the first
/// transaction of an account whose fee limit is 1 gwei.
fn node_approval() -> Value {
    let vectors: Value = serde_json::from_str(include_str!("../../account/src/evm_vectors.json")).unwrap();
    let list = vectors["sandbox"]["transactions"].as_array().unwrap();
    list.iter().find(|tx| tx["name"] == "approve").expect("Node built no approval").clone()
}

#[tokio::test]
async fn the_live_stage_2_factory_takes_the_stage_3_code_with_no_init_call_and_its_new_accounts_sign_for_aave() {
    let chain = Chain::start().await;
    // The live pool and tokens, under the testnet names the factory's config gives them, and the live factory.
    for name in ["pool", "musdc", "mnbtc"] {
        chain.deploy_live(&Live::load_from(LIVE, name), 10).await;
    }
    let live = Live::load_from(LIVE, "factory");
    assert_eq!(live.sha256, STAGE2_FACTORY_SHA256, "target/{LIVE}/factory.wasm is not stage 2's code");
    let factory = chain.deploy_live(&live, FACTORY_NEAR).await;
    assert_eq!(factory.as_str(), "pbf.testnet");
    let before = factory_views(&chain, &factory).await;
    let old_account_code: String = chain.view(&factory, "account_code_hash", json!({})).await;
    assert!(old_account_code.starts_with(STAGE2_ACCOUNT_SHA256_START), "it carries {old_account_code}");
    // Its config has Rhea and no Aave yet, and it lists seven accounts.
    let config = before[0].clone();
    assert_eq!(config["lenders"]["rhea"]["contract_id"], "rhea.pbf-ops.testnet");
    assert_eq!(config["lenders"]["aave"], Value::Null);
    assert_eq!((before[2].clone(), before[1].as_array().unwrap().len()), (json!(7), 7));
    // The MPC mock stands in for the signer the live config names.
    let mpc = chain.named_account(config["mpc_id"].as_str().unwrap(), 10).await;
    chain.deploy(&mpc, wasm("pb_testnet_mpc_mock")).await;

    // The mistake to rule out: the new code sent with `migrate` as its init call, as stage 2's upgrade was. It is
    // refused as a whole, and the factory keeps stage 2's code and state.
    let mistake = chain.deploy_with_init(&factory, wasm("pb_factory"), "migrate").await;
    assert_refused(&mistake, "Cannot deserialize the contract state");
    assert_eq!(chain.code_sha256(&factory).await, STAGE2_FACTORY_SHA256);
    assert_eq!(factory_views(&chain, &factory).await, before);

    // The upgrade as it will be sent: the new code, and no init call. The factory reads its state as it is: the
    // same config, the same seven accounts, not paused. Only the account code it carries is new.
    chain.deploy(&factory, wasm("pb_factory")).await;
    assert_eq!(chain.code_sha256(&factory).await, sha256_hex(&wasm("pb_factory")));
    assert_eq!(factory_views(&chain, &factory).await, before);
    let carried: String = chain.view(&factory, "account_code_hash", json!({})).await;
    assert_eq!(carried, sha256_hex(&wasm("pb_account")), "the factory doesn't carry the stage 3 account code");
    // Its balance covers the larger code, with room left.
    let (stored, held) = (u128::from(chain.storage_usage(&factory).await), chain.balance(&factory).await);
    let free = held - stored * BYTE;
    println!(
        "NEAR the factory after the redeploy: storage {stored} B, free {} milliNEAR of {FACTORY_NEAR}",
        free / (NEAR / 1000)
    );
    assert!(free > NEAR / 4, "the redeployed factory has under 0.25 NEAR free");

    // `migrate` on the upgraded factory is refused too, and changes nothing. Only the factory account can call it at
    // all, and for it the mistake is the same as before: the code sent again with `migrate` as its init call.
    let stranger = chain.account("stranger", 5).await;
    let refused = chain.call(&stranger, &factory, "migrate", json!({}), yocto(0)).await;
    assert_refused(&refused, "Method migrate is private");
    let mistake = chain.deploy_with_init(&factory, wasm("pb_factory"), "migrate").await;
    assert_refused(&mistake, "Cannot deserialize the contract state");
    assert_eq!(chain.code_sha256(&factory).await, sha256_hex(&wasm("pb_factory")));
    assert_eq!(factory_views(&chain, &factory).await, before);

    // The operator lists WBTC and WETH for Aave, with a fee limit of 1 gwei. Rhea's settings stay.
    let operator = chain.named_account("pbf-ops.testnet", 5).await;
    let mut with_aave = config.clone();
    with_aave["lenders"]["aave"] = aave();
    chain.ok(&operator, &factory, "set_config", json!({ "config": with_aave })).await;
    assert_eq!(chain.view::<Value>(&factory, "get_config", json!({})).await, with_aave);

    // A client opens an account and permits both lenders in one call.
    let client = chain.account("client", 20).await;
    let terms = json!({ "lenders": ["aave", "rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any" });
    let args = json!({ "name": "w1stage3", "owner": client, "permission": terms });
    let made = chain.call(&client, &factory, "create_account", args, NearToken::from_near(6)).await;
    assert_ok(&made, "create_account");
    assert!(made.clone().json::<bool>().unwrap(), "create_account reported a failed step: {made:?}");
    let account: AccountId = "w1stage3.pbf.testnet".parse().unwrap();
    // It runs the stage 3 code with the new config, and the live pool and tokens have registered it.
    assert_eq!(chain.code_sha256(&account).await, sha256_hex(&wasm("pb_account")));
    assert_eq!(chain.view::<Value>(&account, "get_config", json!({})).await, with_aave);
    let state: Value = chain.view(&account, "get_state", json!({})).await;
    assert_eq!((state["owner"].clone(), state["permission"].clone()), (json!(client), terms));
    assert_eq!(state["evm"], json!({ "nonce": 0, "signed": [], "approved": [] }));
    let pool: AccountId = config["pool_id"].as_str().unwrap().parse().unwrap();
    let borrower: Value = chain.view(&pool, "get_borrower", json!({ "account_id": account })).await;
    assert!(!borrower.is_null(), "the live pool doesn't know the new account");
    for token in config["tokens"].as_array().unwrap() {
        let token: AccountId = token["id"].as_str().unwrap().parse().unwrap();
        let storage: Value = chain.view(&token, "storage_balance_of", json!({ "account_id": account })).await;
        assert!(!storage.is_null(), "{token} doesn't know the new account");
    }
    // The factory lists it after the seven it had.
    let listed: Vec<Value> = chain.view(&factory, "list_accounts", json!({})).await;
    assert_eq!(listed[..7], before[1].as_array().unwrap()[..]);
    assert_eq!((listed.len(), listed[7]["account_id"].clone()), (8, json!(account)));
    assert_eq!(chain.view::<u64>(&factory, "accounts_count", json!({})).await, 8);

    // The new account learns its address from the signer, and anyone has its approval of WETH signed: the account
    // asks the signer for exactly the hash Node signed, and keeps Node's transaction byte for byte.
    let init = chain.call(&operator, &account, "hl_init", json!({}), yocto(0)).await;
    assert_ok(&init, "hl_init");
    assert_eq!(init.json::<Value>().unwrap(), json!(ADDRESS));
    let tx = node_approval();
    let digest = tx["signing_hash"].as_str().unwrap().trim_start_matches("0x");
    let wanted = json!({ "path": "hyperliquid-1", "payload_v2": { "Ecdsa": digest }, "domain_id": 0 });
    let call = chain.call_in_background(&operator, &account, "evm_approve", json!({ "token": WETH }), yocto(0));
    let mut asked = false;
    for _ in 0..80 {
        let pending: Vec<Value> = chain.view(&mpc, "pending_requests", json!({})).await;
        asked = pending.iter().any(|p| p["signer_id"] == json!(account) && p["request"] == wanted);
        if asked {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(asked, "evm_approve never asked the signer for the hash Node signed");
    let part = |field: &str| tx[field].as_str().unwrap().trim_start_matches("0x").to_string();
    let parity = tx["y_parity"].as_u64().unwrap();
    let big_r = format!("{}{}", if parity == 0 { "02" } else { "03" }, part("r"));
    let answer = json!({ "big_r": { "affine_point": big_r }, "s": { "scalar": part("s") }, "recovery_id": parity });
    let args = json!({ "signer_id": account, "request": wanted, "response": answer });
    chain.ok(&operator, &mpc, "respond", args).await;
    let signed = call.await.unwrap();
    assert_ok(&signed, "evm_approve");
    let entry = signed.json::<Value>().unwrap();
    assert_eq!(
        (entry["nonce"].clone(), entry["kind"].clone(), entry["token"].clone()),
        (json!(0), json!("approve"), json!(WETH))
    );
    assert_eq!((entry["raw"].clone(), entry["hash"].clone()), (tx["raw"].clone(), tx["hash"].clone()));
    let evm = chain.view::<Value>(&account, "get_state", json!({})).await["evm"].clone();
    assert_eq!(evm, json!({ "nonce": 1, "signed": [entry], "approved": [WETH] }));
}
