//! The factory's upgrade for the fixes after the second audit pass, tried on the sandbox before it touches testnet
//! (INTERFACES.md 40).
//!
//! The factory on testnet runs stage 4's code. The fixes change nothing in what it stores: the account code it
//! carries is new, and it works out `on_created`'s gas from the number of tokens. So the upgrade is again a plain
//! redeploy with NO init call, and `migrate` must not run. The test puts the live factory, pool and tokens into the
//! sandbox under their testnet names, with their code and state as `tests/fetch_live.py` read them after gate 4, and
//! the MPC mock under the name the live config gives the signer.
//!
//! The live files are in a folder of their own:
//! `python3 -I contracts/tests/fetch_live.py --out contracts/target/live-stage4 factory pool musdc mnbtc`.
mod common;

use common::rhea::{call_with_gas, mint, token_balance};
use common::*;
use near_api::{AccountId, NearToken};
use serde_json::{json, Value};

/// `pbf.testnet`'s code after gate 4, the account code it carries, and the pool's, which this upgrade leaves alone
/// (INTERFACES.md 38).
const STAGE4_FACTORY_SHA256: &str = "ce6fcd5ac83087c6a5ccd4560ba8920f265ba12c11e4afba215ab5e8c43024b5";
const STAGE4_ACCOUNT_SHA256: &str = "94ceb936a349f9eb587d10214a152097ff2fefc33752a5a51c7e902ebc92e59d";
const LIVE_POOL_SHA256: &str = "c4641c0e8d61015fa6d608abf46f0b00d2fa1bcb882b4cd02738b878d64024a2";
/// The folder of `contracts/target/` the live files are in.
const LIVE: &str = "live-stage4";
/// What `pbf.testnet` held on 12 Nov, rounded down: 10.03 NEAR.
const FACTORY_NEAR: u128 = 10;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const BYTE: u128 = 10_000_000_000_000_000_000;

const AAVE_USDC: &str = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
/// The stand-in's float on Aave's chain, which is every deposit address there.
const FLOAT: &str = "0x2031181d63507368232579AF4c64a1c3428407fF";
/// 1 January 2100, in unix ms.
const YEAR_2100_MS: u64 = 4_102_444_800_000;
const FAR: &str = "exp is more than 24 hours ahead: a 1Click quote lives a day at most";

/// The factory's views that read its stored state.
async fn factory_views(chain: &Chain, factory: &AccountId) -> Vec<Value> {
    let mut out = Vec::new();
    for method in ["get_config", "list_accounts", "accounts_count", "is_paused"] {
        out.push(chain.view::<Value>(factory, method, json!({})).await);
    }
    out
}

#[tokio::test]
async fn the_live_stage_4_factory_takes_the_fixed_code_with_no_init_call_and_its_new_accounts_hold_the_new_rules() {
    let chain = Chain::start().await;
    // The live pool and tokens, under the testnet names the factory's config gives them, and the live factory. The
    // pool isn't part of this upgrade: it stays the code it was that day. The tree has since built a newer pool (the
    // fee limits of INTERFACES.md 45, `upgrade_pool_fees.rs`), so the two are no longer the same code.
    for name in ["pool", "musdc", "mnbtc"] {
        chain.deploy_live(&Live::load_from(LIVE, name), 10).await;
    }
    assert_eq!(Live::load_from(LIVE, "pool").sha256, LIVE_POOL_SHA256);
    assert_ne!(sha256_hex(&wasm("pb_pool")), LIVE_POOL_SHA256, "the pool this tree builds is the newer one");
    let live = Live::load_from(LIVE, "factory");
    assert_eq!(live.sha256, STAGE4_FACTORY_SHA256, "target/{LIVE}/factory.wasm is not stage 4's code");
    let factory = chain.deploy_live(&live, FACTORY_NEAR).await;
    assert_eq!(factory.as_str(), "pbf.testnet");
    let before = factory_views(&chain, &factory).await;
    assert_eq!(chain.view::<String>(&factory, "account_code_hash", json!({})).await, STAGE4_ACCOUNT_SHA256);
    // Its config has both lenders and two tokens, and it lists nine accounts.
    let config = before[0].clone();
    assert_eq!(config["lenders"]["rhea"]["contract_id"], "rhea.pbf-ops.testnet");
    assert_eq!(config["lenders"]["aave"]["usdc"]["address"], AAVE_USDC);
    assert_eq!(config["tokens"].as_array().unwrap().len(), 2);
    assert_eq!((before[2].clone(), before[1].as_array().unwrap().len()), (json!(9), 9));
    // The MPC mock stands in for the signer the live config names.
    let mpc = chain.named_account(config["mpc_id"].as_str().unwrap(), 10).await;
    chain.deploy(&mpc, wasm("pb_testnet_mpc_mock")).await;

    // The mistake to rule out: the new code sent with `migrate` as its init call. It is refused as a whole, and the
    // factory keeps stage 4's code and state.
    let mistake = chain.deploy_with_init(&factory, wasm("pb_factory"), "migrate").await;
    assert_refused(&mistake, "Cannot deserialize the contract state");
    assert_eq!(chain.code_sha256(&factory).await, STAGE4_FACTORY_SHA256);
    assert_eq!(factory_views(&chain, &factory).await, before);

    // The upgrade as it will be sent: the new code, and no init call. The factory reads its state as it is: the
    // same config, the same nine accounts, not paused. Only the account code it carries is new.
    let stored_before = chain.storage_usage(&factory).await;
    chain.deploy(&factory, wasm("pb_factory")).await;
    assert_eq!(chain.code_sha256(&factory).await, sha256_hex(&wasm("pb_factory")));
    assert_eq!(factory_views(&chain, &factory).await, before);
    let carried: String = chain.view(&factory, "account_code_hash", json!({})).await;
    assert_eq!(carried, sha256_hex(&wasm("pb_account")), "the factory doesn't carry the fixed account code");
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

    // F2: with the live config's 2 tokens `create_account` needs 180 TGas and says so. It works on exactly that,
    // and callers go on attaching 300.
    let client = chain.account("client", 30).await;
    let six = NearToken::from_near(6);
    let terms = json!({ "lenders": ["aave", "rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any" });
    let args = json!({ "name": "w1fixed", "owner": client, "permission": terms });
    let short = call_with_gas(&chain, &client, &factory, "create_account", args.clone(), six, 179).await;
    assert_refused(&short, "attach at least 180 TGas: 300 TGas is the safe amount");
    let made = call_with_gas(&chain, &client, &factory, "create_account", args, six, 180).await;
    assert_ok(&made, "create_account with 180 TGas");
    assert!(made.clone().json::<bool>().unwrap(), "create_account reported a failed step: {made:?}");
    println!("GAS  create_account burnt {:.1} TGas of the 180 attached", made.total_gas_burnt.as_gas() as f64 / 1e12);
    let account: AccountId = "w1fixed.pbf.testnet".parse().unwrap();

    // The new account runs the fixed code with the live config, and the live pool and tokens have registered it.
    assert_eq!(chain.code_sha256(&account).await, sha256_hex(&wasm("pb_account")));
    assert_eq!(chain.view::<Value>(&account, "get_config", json!({})).await, config);
    let pool: AccountId = config["pool_id"].as_str().unwrap().parse().unwrap();
    let borrower: Value = chain.view(&pool, "get_borrower", json!({ "account_id": account })).await;
    assert!(!borrower.is_null(), "the live pool doesn't know the new account");
    for token in config["tokens"].as_array().unwrap() {
        let token: AccountId = token["id"].as_str().unwrap().parse().unwrap();
        let storage: Value = chain.view(&token, "storage_balance_of", json!({ "account_id": account })).await;
        assert!(!storage.is_null(), "{token} doesn't know the new account");
    }
    // The factory lists it after the nine it had.
    let listed: Vec<Value> = chain.view(&factory, "list_accounts", json!({})).await;
    assert_eq!(listed[..9], before[1].as_array().unwrap()[..]);
    assert_eq!((listed.len(), listed[9]["account_id"].clone()), (10, json!(account)));
    // What the opening deposit leaves it.
    let (stored, held) = (u128::from(chain.storage_usage(&account).await), chain.balance(&account).await);
    println!("NEAR a new account: storage {stored} B, free {} milliNEAR of 6", (held - stored * BYTE) / (NEAR / 1000));
    assert!(held - stored * BYTE > NEAR * 11 / 20, "a new account has under 0.55 NEAR free");

    // A8: its state shows the block its permission came in, and its counter starts at 0.
    let state: Value = chain.view(&account, "get_state", json!({})).await;
    let opened_at = state["permission_blk"].as_u64().expect("no permission_blk in the new account's state");
    assert!(opened_at > 0 && opened_at <= chain.height().await);
    assert_eq!((state["permission"].clone(), state["counter"].clone()), (terms, json!(0)));
    // Changing the permission moves that block on and leaves the counter where it was.
    let none = json!({ "permission": null });
    chain.ok_with(&client, &account, "set_permission", none, one_yocto()).await;
    let state: Value = chain.view(&account, "get_state", json!({})).await;
    assert!(state["permission_blk"].as_u64().unwrap() > opened_at);
    assert_eq!(state["counter"], json!(0));

    // A7: a move with an expiry far ahead is refused, both ways out. It takes test bitcoin from the live token's
    // faucet first, and learns its address on Aave's chain.
    assert_ok(&chain.call(&client, &account, "hl_init", json!({}), yocto(0)).await, "hl_init");
    let mnbtc: AccountId = "mnbtc.pbf-ops.testnet".parse().unwrap();
    mint(&chain, &mnbtc, &client, 100_000).await;
    let deposit = json!({ "receiver_id": account, "amount": "100000", "msg": "" });
    chain.ok_with(&client, &mnbtc, "ft_transfer_call", deposit, one_yocto()).await;
    let dep = chain.account("dep", 5).await;
    let to_evm = |exp: u64| {
        let transfer = json!({ "kind": "to_evm", "exp": exp });
        json!({ "token": mnbtc, "amount": "55000", "receiver": dep, "transfer": transfer })
    };
    let far = chain.call(&client, &account, "withdraw", to_evm(YEAR_2100_MS), one_yocto()).await;
    assert_refused(&far, FAR);
    let home = json!({ "token": AAVE_USDC, "amount": "1000000000000", "to": FLOAT, "exp": YEAR_2100_MS });
    let far = chain.call(&client, &account, "evm_withdraw", home, one_yocto()).await;
    assert_refused(&far, FAR);
    let state: Value = chain.view(&account, "get_state", json!({})).await;
    assert_eq!((state["pending"].clone(), state["next_move"].clone()), (json!([]), json!(0)));
    // A quote of 10 minutes is recorded as before.
    let block = near_api::Chain::block().fetch_from(&chain.network).await.expect("no block");
    let exp = block.header.timestamp_nanosec.parse::<u64>().unwrap() / 1_000_000 + 600_000;
    let sent = chain.call(&client, &account, "withdraw", to_evm(exp), one_yocto()).await;
    assert_ok(&sent, "the move of bitcoin to Aave's chain");
    assert_eq!(token_balance(&chain, &mnbtc, &dep).await, 55_000);
    let pending = chain.view::<Value>(&account, "get_state", json!({})).await["pending"].clone();
    assert_eq!(
        (pending[0]["transfer"]["id"].clone(), pending[0]["transfer"]["kind"].clone()),
        (json!("move:0"), json!("to_evm"))
    );
}
