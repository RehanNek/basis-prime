//! The factory's stage 4 upgrade, tried on the sandbox before it touches testnet (INTERFACES.md 36).
//!
//! The factory on testnet runs stage 3's code. Stage 4 changes nothing in what it stores: only the account code it
//! carries is new, with the two moves between NEAR and Aave's chain. So the upgrade is again a plain redeploy with
//! NO init call, and `migrate` must not run. The test puts the live factory, pool and tokens into the sandbox under
//! their testnet names, with their code and state as `tests/fetch_live.py` read them after gate 3, and the MPC mock
//! under the name the live config gives the signer.
//!
//! The live files are in a folder of their own:
//! `python3 -I contracts/tests/fetch_live.py --out contracts/target/live-stage3 factory pool musdc mnbtc`.
mod common;

use std::time::Duration;

use common::rhea::{mint, token_balance};
use common::*;
use near_api::{AccountId, NearToken};
use serde_json::{json, Value};

/// `pbf.testnet`'s code after gate 3, and the account code it carries (INTERFACES.md 35).
const STAGE3_FACTORY_SHA256: &str = "317efd5a950bfe0dcc981fe48be5bcbcb250e86e0369fdbd653ad09fc14154c7";
const STAGE3_ACCOUNT_SHA256: &str = "fae0d5bd894957296d3c781fcfd165e0da2d84cd436a915335c6dd0919cd6836";
/// The folder of `contracts/target/` the live files are in.
const LIVE: &str = "live-stage3";
/// What `pbf.testnet` held on 12 Nov, rounded down: 10.03 NEAR.
const FACTORY_NEAR: u128 = 10;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const BYTE: u128 = 10_000_000_000_000_000_000;

const AAVE_USDC: &str = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
/// The stand-in's float on Aave's chain, which is every deposit address there.
const FLOAT: &str = "0x2031181d63507368232579AF4c64a1c3428407fF";
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

/// The move home that Node built and signed for the sandbox (`contracts/account/evm-vectors.mjs`): $20 of USDC
/// sent to the float, as the first transaction of an account whose fee limit is 1 gwei.
fn node_home() -> Value {
    let vectors: Value = serde_json::from_str(include_str!("../../account/src/evm_vectors.json")).unwrap();
    let list = vectors["sandbox"]["transactions"].as_array().unwrap();
    list.iter().find(|tx| tx["name"] == "home_usdc").expect("Node built no move home").clone()
}

#[tokio::test]
async fn the_live_stage_3_factory_takes_the_stage_4_code_with_no_init_call_and_its_new_accounts_make_both_moves() {
    let chain = Chain::start().await;
    // The live pool and tokens, under the testnet names the factory's config gives them, and the live factory.
    for name in ["pool", "musdc", "mnbtc"] {
        chain.deploy_live(&Live::load_from(LIVE, name), 10).await;
    }
    let live = Live::load_from(LIVE, "factory");
    assert_eq!(live.sha256, STAGE3_FACTORY_SHA256, "target/{LIVE}/factory.wasm is not stage 3's code");
    let factory = chain.deploy_live(&live, FACTORY_NEAR).await;
    assert_eq!(factory.as_str(), "pbf.testnet");
    let before = factory_views(&chain, &factory).await;
    assert_eq!(chain.view::<String>(&factory, "account_code_hash", json!({})).await, STAGE3_ACCOUNT_SHA256);
    // Its config has both lenders, Aave with a fee limit of 1 gwei, and it lists eight accounts.
    let config = before[0].clone();
    assert_eq!(config["lenders"]["rhea"]["contract_id"], "rhea.pbf-ops.testnet");
    assert_eq!(config["lenders"]["aave"]["max_fee_per_gas"], "1000000000");
    assert_eq!(config["lenders"]["aave"]["usdc"]["address"], AAVE_USDC);
    assert_eq!((before[2].clone(), before[1].as_array().unwrap().len()), (json!(8), 8));
    // The MPC mock stands in for the signer the live config names.
    let mpc = chain.named_account(config["mpc_id"].as_str().unwrap(), 10).await;
    chain.deploy(&mpc, wasm("pb_testnet_mpc_mock")).await;

    // The mistake to rule out: the new code sent with `migrate` as its init call. It is refused as a whole, and the
    // factory keeps stage 3's code and state.
    let mistake = chain.deploy_with_init(&factory, wasm("pb_factory"), "migrate").await;
    assert_refused(&mistake, "Cannot deserialize the contract state");
    assert_eq!(chain.code_sha256(&factory).await, STAGE3_FACTORY_SHA256);
    assert_eq!(factory_views(&chain, &factory).await, before);

    // The upgrade as it will be sent: the new code, and no init call. The factory reads its state as it is: the
    // same config, the same eight accounts, not paused. Only the account code it carries is new.
    let stored_before = chain.storage_usage(&factory).await;
    chain.deploy(&factory, wasm("pb_factory")).await;
    assert_eq!(chain.code_sha256(&factory).await, sha256_hex(&wasm("pb_factory")));
    assert_eq!(factory_views(&chain, &factory).await, before);
    let carried: String = chain.view(&factory, "account_code_hash", json!({})).await;
    assert_eq!(carried, sha256_hex(&wasm("pb_account")), "the factory doesn't carry the stage 4 account code");
    // Its balance covers the larger code, with room left.
    let (stored, held) = (chain.storage_usage(&factory).await, chain.balance(&factory).await);
    let free = held - u128::from(stored) * BYTE;
    println!(
        "NEAR the factory after the redeploy: storage {stored} B, {} B more, free {} milliNEAR of {FACTORY_NEAR}",
        stored - stored_before,
        free / (NEAR / 1000)
    );
    assert!(free > NEAR, "the redeployed factory has under 1 NEAR free");

    // `migrate` on the upgraded factory is refused too, and changes nothing.
    let stranger = chain.account("stranger", 5).await;
    let refused = chain.call(&stranger, &factory, "migrate", json!({}), yocto(0)).await;
    assert_refused(&refused, "Method migrate is private");
    let again = chain.call(&factory, &factory, "migrate", json!({}), yocto(0)).await;
    assert_refused(&again, "Cannot deserialize the contract state");
    assert_eq!(factory_views(&chain, &factory).await, before);

    // A client opens an account and permits both lenders in one call. No `set_config` is needed: the config has
    // both already.
    let client = chain.account("client", 20).await;
    let terms = json!({ "lenders": ["aave", "rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any" });
    let args = json!({ "name": "w1stage4", "owner": client, "permission": terms });
    let made = chain.call(&client, &factory, "create_account", args, NearToken::from_near(6)).await;
    assert_ok(&made, "create_account");
    assert!(made.clone().json::<bool>().unwrap(), "create_account reported a failed step: {made:?}");
    let account: AccountId = "w1stage4.pbf.testnet".parse().unwrap();
    // It runs the stage 4 code with the live config, and the live pool and tokens have registered it.
    assert_eq!(chain.code_sha256(&account).await, sha256_hex(&wasm("pb_account")));
    assert_eq!(chain.view::<Value>(&account, "get_config", json!({})).await, config);
    let pool: AccountId = config["pool_id"].as_str().unwrap().parse().unwrap();
    let borrower: Value = chain.view(&pool, "get_borrower", json!({ "account_id": account })).await;
    assert!(!borrower.is_null(), "the live pool doesn't know the new account");
    // The factory lists it after the eight it had.
    let listed: Vec<Value> = chain.view(&factory, "list_accounts", json!({})).await;
    assert_eq!(listed[..8], before[1].as_array().unwrap()[..]);
    assert_eq!((listed.len(), listed[8]["account_id"].clone()), (9, json!(account)));
    // What the opening deposit leaves the new account.
    let (stored, held) = (u128::from(chain.storage_usage(&account).await), chain.balance(&account).await);
    println!("NEAR a new account: storage {stored} B, free {} milliNEAR of 6", (held - stored * BYTE) / (NEAR / 1000));
    assert!(held - stored * BYTE > NEAR * 11 / 20, "a new account has under 0.55 NEAR free");

    // The new account makes both of stage 4's moves. It learns its address, takes test bitcoin from the live
    // token's faucet, and sends some towards Aave's chain: recorded as move:0.
    let init = chain.call(&client, &account, "hl_init", json!({}), yocto(0)).await;
    assert_ok(&init, "hl_init");
    assert_eq!(init.json::<Value>().unwrap(), json!(ADDRESS));
    let mnbtc: AccountId = "mnbtc.pbf-ops.testnet".parse().unwrap();
    mint(&chain, &mnbtc, &client, 100_000).await;
    let deposit = json!({ "receiver_id": account, "amount": "100000", "msg": "" });
    chain.ok_with(&client, &mnbtc, "ft_transfer_call", deposit, one_yocto()).await;
    let dep = chain.account("dep", 5).await;
    let block = near_api::Chain::block().fetch_from(&chain.network).await.expect("no block");
    let exp = block.header.timestamp_nanosec.parse::<u64>().unwrap() / 1_000_000 + 600_000;
    let to_evm = json!({ "kind": "to_evm", "exp": exp });
    let args = json!({ "token": mnbtc, "amount": "55000", "receiver": dep, "transfer": to_evm });
    let sent = chain.call(&client, &account, "withdraw", args, one_yocto()).await;
    assert_ok(&sent, "the move of bitcoin to Aave's chain");
    assert_eq!(token_balance(&chain, &mnbtc, &dep).await, 55_000);
    let pending = chain.view::<Value>(&account, "get_state", json!({})).await["pending"].clone();
    let moved = &pending[0]["transfer"];
    let shown = (moved["id"].clone(), moved["kind"].clone(), moved["token"].clone(), moved["dep"].clone());
    assert_eq!(shown, (json!("move:0"), json!("to_evm"), json!(mnbtc), json!(dep)));

    // And it signs a move home through the MPC mock: it asks the signer for exactly the hash Node signed, keeps
    // Node's transaction byte for byte, and records move:1.
    let tx = node_home();
    let digest = tx["signing_hash"].as_str().unwrap().trim_start_matches("0x");
    let wanted = json!({ "path": "hyperliquid-1", "payload_v2": { "Ecdsa": digest }, "domain_id": 0 });
    let args = json!({ "token": AAVE_USDC, "amount": "20000000", "to": FLOAT, "exp": exp });
    let call = chain.call_in_background(&client, &account, "evm_withdraw", args, one_yocto());
    let mut asked = false;
    for _ in 0..80 {
        let pending: Vec<Value> = chain.view(&mpc, "pending_requests", json!({})).await;
        asked = pending.iter().any(|p| p["signer_id"] == json!(account) && p["request"] == wanted);
        if asked {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(asked, "evm_withdraw never asked the signer for the hash Node signed");
    let part = |field: &str| tx[field].as_str().unwrap().trim_start_matches("0x").to_string();
    let parity = tx["y_parity"].as_u64().unwrap();
    let big_r = format!("{}{}", if parity == 0 { "02" } else { "03" }, part("r"));
    let answer = json!({ "big_r": { "affine_point": big_r }, "s": { "scalar": part("s") }, "recovery_id": parity });
    let args = json!({ "signer_id": account, "request": wanted, "response": answer });
    chain.ok(&client, &mpc, "respond", args).await;
    let signed = call.await.unwrap();
    assert_ok(&signed, "evm_withdraw");
    let entry = signed.json::<Value>().unwrap();
    assert_eq!((entry["raw"].clone(), entry["hash"].clone()), (tx["raw"].clone(), tx["hash"].clone()));
    let pending = chain.view::<Value>(&account, "get_state", json!({})).await["pending"].clone();
    let home = &pending[2]["transfer"];
    let shown = (home["id"].clone(), home["kind"].clone(), home["token"].clone(), home["dep"].clone());
    assert_eq!(shown, (json!("move:1"), json!("e_home"), json!("USDC"), json!(FLOAT.to_lowercase())));
    assert_eq!(pending[1]["lender"]["kind"], "transfer");
}
