//! The factory's upgrade for the pause that lifts early, tried on the sandbox before it touches testnet
//! (INTERFACES.md 50.2).
//!
//! The factory on testnet runs the code of 13 Nov, 09:53 UTC (INTERFACES.md 47). This round changes nothing in what
//! it stores: only the account code it carries is new. So the upgrade is once more a plain redeploy with NO init
//! call. The test puts the live factory, pool and five tokens into the sandbox under their testnet names, with their
//! code and state as `tests/fetch_live.py` read them on 14 Nov at 21:24 UTC, and the two mocks under the names the
//! live config gives the signer and OutLayer.
//!
//! It makes one account with the live factory before the redeploy and one after it. Both sign a transfer out of
//! Hyperliquid and both accept a verdict that names that transfer as sent. The new account's pause ends there and
//! its borrow from the live pool goes through; the account made before keeps the rule of before, for 2 days and 1
//! hour.
//!
//! The live files are in a folder of their own:
//! `python3 -I contracts/tests/fetch_live.py --out contracts/target/live-pause factory pool musdc mnbtc`.
//! The config's three newer tokens (`meth`, `mwnear`, `musdt` at `pbf-ops.testnet`) were read the same way, with the
//! script's own `fetch`; its table of names doesn't list them yet.
mod common;

use std::time::Duration;

use common::rhea::call_with_gas;
use common::*;
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::{AccountId, NearToken};
use serde_json::{json, Value};

/// `pbf.testnet`'s code since 13 Nov 09:53 UTC, the account code it carries, and the pool's since 12 Nov 21:40,
/// which this upgrade leaves alone (INTERFACES.md 46 and 47).
const LIVE_FACTORY_SHA256: &str = "66cb907098640365ae9c52762e90ae548d9f35958b8a81d893201d9f449c3a95";
const LIVE_ACCOUNT_SHA256: &str = "79827e65a44d0edb1c640ea4401c3fcdf53e22aed10e7339b7e40a98f6470ea4";
const LIVE_POOL_SHA256: &str = "ca21d5336508de33b0e2c9ff068877bbf85d9b561ed1eb8d61c7f64a6963ab4c";
/// The folder of `contracts/target/` the live files are in.
const LIVE: &str = "live-pause";
/// What `pbf.testnet` held on 14 Nov at 21:30 UTC, rounded down: 10.13 NEAR.
const FACTORY_NEAR: u128 = 10;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const BYTE: u128 = 10_000_000_000_000_000_000;
/// 2 days and 1 hour, in ms: `SEND_OPEN_MS` in `contracts/account/src/hl.rs`.
const SEND_OPEN_MS: u64 = 2 * 86_400_000 + 3_600_000;
/// Where the transfers out of Hyperliquid go: any address will do here.
const FLOAT: &str = "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d";
const PAUSED: &str = "a signed Hyperliquid sendAsset can still be posted until then";
const LIFTED: &str = "Hyperliquid shows the signed transfer as sent: the pause on borrowing ends now";

/// The factory's views that read its stored state.
async fn factory_views(chain: &Chain, factory: &AccountId) -> Vec<Value> {
    let mut out = Vec::new();
    for method in ["get_config", "list_accounts", "accounts_count", "is_paused"] {
        out.push(chain.view::<Value>(factory, method, json!({})).await);
    }
    out
}

/// The live contracts' stand-ins and the client, for the calls both accounts make.
struct World {
    chain: Chain,
    config: Value,
    mpc: AccountId,
    outlayer: AccountId,
    client: AccountId,
}

impl World {
    async fn state(&self, account: &AccountId) -> Value {
        self.chain.view(account, "get_state", json!({})).await
    }

    /// The client makes `<name>.pbf.testnet` with 6 NEAR and 300 TGas, as every caller does.
    async fn create(&self, factory: &AccountId, name: &str) -> AccountId {
        let args = json!({ "name": name, "owner": self.client });
        let six = NearToken::from_near(6);
        let made = call_with_gas(&self.chain, &self.client, factory, "create_account", args, six, 300).await;
        assert_ok(&made, "create_account");
        assert!(made.clone().json::<bool>().unwrap(), "create_account reported a failed step: {made:?}");
        format!("{name}.{factory}").parse().unwrap()
    }

    /// A HEALTHY Standard verdict for `account` with its counter, read now, allowing a $2,000 borrow. It rests on
    /// no bridged token and no Hyperliquid balance, so only the pool's own limits apply.
    async fn verdict(&self, account: &AccountId) -> Value {
        let counter = self.state(account).await["counter"].as_u64().unwrap();
        json!({
            "ok": true, "v": 1, "model": self.config["model"], "params": self.config["params_hash"], "acct": account,
            "blk": self.chain.height().await, "nonce": counter,
            "eq": 31_000_000_000u64, "eq_allow": 31_000_000_000u64, "mm": 4_000_000_000u64, "im": 5_000_000_000u64,
            "state": "HEALTHY", "action": "NONE", "since": 0,
            "score": 650, "tier": "STANDARD", "rate_bp": 400,
            "allow": { "withdraw": 0, "borrow": 2_000_000_000u64 },
            "credit": { "line": 2_000_000_000u64, "binding": "C5" },
            "volf_bp": 10_000, "top": [], "topup": 0,
            "venues": { "hl_margin_ratio_bp": 0 },
            "pool": { "shares_bp": {}, "hold": {}, "hl_eq": 0 },
            "hr_bp": 10_000, "hr7_bp": 10_000, "exp_bp": 0,
            "bands": {}, "coins": { "uncertain": [], "stale": [], "reduce_only": [] },
            "plan": [], "in": "11".repeat(32),
        })
    }

    /// The client asks `account` for a check before a $100 borrow, and the OutLayer mock answers it with a verdict
    /// that names `sent` as sent (or has no `sent` at all). The verdict must be accepted. Returns the transaction.
    async fn check(&self, account: &AccountId, sent: Option<&[u64]>) -> ExecutionFinalResult {
        let intent = json!({ "borrow": { "amount": usd(100).to_string() } });
        let args = json!({ "intent": intent });
        let deposit = NearToken::from_millinear(10);
        let call = self.chain.call_in_background(&self.client, account, "request_check", args, deposit);
        let mut request = None;
        for _ in 0..80 {
            let pending: Vec<Value> = self.chain.view(&self.outlayer, "pending_requests", json!({})).await;
            request = pending.into_iter().find(|r| r["caller"] == json!(account));
            if request.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let request = request.expect("the check never reached OutLayer");
        let mut answer = self.verdict(account).await;
        if let Some(sent) = sent {
            answer["sent"] = json!(sent);
        }
        let resolve = json!({ "request_id": request["request_id"], "output": answer });
        self.chain.ok(&self.client, &self.outlayer, "resolve_execution", resolve).await;
        let result = call.await.unwrap();
        assert_ok(&result, "request_check");
        let outcome: Value = result.clone().json().unwrap();
        assert_eq!(outcome["accepted"], true, "{outcome}");
        result
    }

    /// The client has `account` sign a transfer of $5 out of Hyperliquid, and the MPC mock signs it. Returns the
    /// transfer's nonce.
    async fn sign_a_transfer_out(&self, account: &AccountId) -> u64 {
        assert_ok(&self.chain.call(&self.client, account, "hl_init", json!({}), yocto(0)).await, "hl_init");
        let args = json!({ "amount": "5000000", "destination": FLOAT });
        let call = self.chain.call_in_background(&self.client, account, "hl_withdraw", args, one_yocto());
        let mut request = None;
        for _ in 0..80 {
            let pending: Vec<Value> = self.chain.view(&self.mpc, "pending_requests", json!({})).await;
            request = pending.into_iter().find(|p| p["signer_id"] == json!(account));
            if request.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let request = request.expect("the hl_withdraw signature never reached the MPC mock")["request"].clone();
        // One of the signer's real answers from Phase 0 (research/data/day1_mpc_probe.json, run 10).
        let answer = json!({
            "scheme": "Secp256k1",
            "big_r": { "affine_point": "02808c355953d28d9a7cad50e58eaa331fcd4ea75fe176d78535d1548513b75c38" },
            "s": { "scalar": "2e1c6182bb7a1d0a6213cb7c2a14f023bcb8b1c22409597e5b07721be2b5927d" },
            "recovery_id": 1,
        });
        let args = json!({ "signer_id": account, "request": request, "response": answer });
        self.chain.ok(&self.client, &self.mpc, "respond", args).await;
        let signed = call.await.unwrap();
        assert_ok(&signed, "hl_withdraw");
        let entry: Value = signed.json().unwrap();
        assert_eq!(entry["kind"], "sendAsset");
        entry["nonce"].as_u64().unwrap()
    }

    async fn borrow(&self, account: &AccountId) -> ExecutionFinalResult {
        let args = json!({ "amount": usd(100).to_string() });
        self.chain.call(&self.client, account, "borrow", args, one_yocto()).await
    }
}

#[tokio::test]
async fn the_live_factory_takes_the_account_code_whose_pause_lifts_early_and_only_its_new_accounts_lift_it() {
    let chain = Chain::start().await;
    // The live pool and tokens, under the testnet names the factory's config gives them, and the live factory. The
    // pool isn't part of this upgrade, and the tree builds the same pool that is live.
    for name in ["pool", "musdc", "mnbtc", "meth", "mwnear", "musdt"] {
        chain.deploy_live(&Live::load_from(LIVE, name), 10).await;
    }
    assert_eq!(Live::load_from(LIVE, "pool").sha256, LIVE_POOL_SHA256);
    assert_eq!(sha256_hex(&wasm("pb_pool")), LIVE_POOL_SHA256, "this round must not change the pool");
    let live = Live::load_from(LIVE, "factory");
    assert_eq!(live.sha256, LIVE_FACTORY_SHA256, "target/{LIVE}/factory.wasm is not the live factory's code");
    let factory = chain.deploy_live(&live, FACTORY_NEAR).await;
    assert_eq!(factory.as_str(), "pbf.testnet");
    let config: Value = chain.view(&factory, "get_config", json!({})).await;
    assert_eq!(chain.view::<String>(&factory, "account_code_hash", json!({})).await, LIVE_ACCOUNT_SHA256);
    assert_ne!(sha256_hex(&wasm("pb_account")), LIVE_ACCOUNT_SHA256, "the account this tree builds is the live one");
    // The mocks stand in for the signer and for OutLayer, under the names the live config gives them.
    let mpc = chain.named_account(config["mpc_id"].as_str().unwrap(), 10).await;
    chain.deploy(&mpc, wasm("pb_testnet_mpc_mock")).await;
    let outlayer = chain.named_account(config["outlayer_id"].as_str().unwrap(), 10).await;
    chain.deploy(&outlayer, wasm("pb_testnet_outlayer_mock")).await;
    let client = chain.account("client", 40).await;
    let w = World { chain, config: config.clone(), mpc, outlayer, client };
    let chain = &w.chain;

    // An account made before the redeploy: it runs the account code that is live today.
    let old = w.create(&factory, "w1before").await;
    assert_eq!(chain.code_sha256(&old).await, LIVE_ACCOUNT_SHA256);
    let before = factory_views(chain, &factory).await;
    let had = before[1].as_array().unwrap().len();
    assert_eq!(before[2], json!(had));
    assert!(had >= 23, "the live factory listed 22 accounts on 14 Nov at 21:30 UTC, and one was made here: not {had}");

    // The mistake to rule out: the new code sent with `migrate` as its init call. It is refused as a whole, and the
    // factory keeps its code and state.
    let mistake = chain.deploy_with_init(&factory, wasm("pb_factory"), "migrate").await;
    assert_refused(&mistake, "Cannot deserialize the contract state");
    assert_eq!(chain.code_sha256(&factory).await, LIVE_FACTORY_SHA256);
    assert_eq!(factory_views(chain, &factory).await, before);

    // The upgrade as it will be sent: the new code, and no init call. The factory reads its state as it is: the
    // same config, the same accounts, not paused. Only the account code it carries is new.
    let stored_before = chain.storage_usage(&factory).await;
    chain.deploy(&factory, wasm("pb_factory")).await;
    assert_eq!(chain.code_sha256(&factory).await, sha256_hex(&wasm("pb_factory")));
    assert_eq!(factory_views(chain, &factory).await, before);
    let carried: String = chain.view(&factory, "account_code_hash", json!({})).await;
    assert_eq!(carried, sha256_hex(&wasm("pb_account")), "the factory doesn't carry the new account code");
    let (stored, held) = (chain.storage_usage(&factory).await, chain.balance(&factory).await);
    let free = held - u128::from(stored) * BYTE;
    println!(
        "NEAR the factory after the redeploy: storage {stored} B, {} B more than before, free {} milliNEAR",
        i128::from(stored) - i128::from(stored_before),
        free / (NEAR / 1000)
    );
    assert!(free > NEAR, "the redeployed factory has under 1 NEAR free");

    // A new account: made as every caller does, with the live config, known to the live pool, listed after the ones
    // the factory had. The account made before keeps its code.
    let new = w.create(&factory, "w1pause").await;
    assert_eq!(chain.code_sha256(&new).await, sha256_hex(&wasm("pb_account")));
    assert_eq!(chain.code_sha256(&old).await, LIVE_ACCOUNT_SHA256);
    assert_eq!(chain.view::<Value>(&new, "get_config", json!({})).await, config);
    let pool: AccountId = config["pool_id"].as_str().unwrap().parse().unwrap();
    let borrower: Value = chain.view(&pool, "get_borrower", json!({ "account_id": new })).await;
    assert!(!borrower.is_null(), "the live pool doesn't know the new account");
    let listed: Vec<Value> = chain.view(&factory, "list_accounts", json!({})).await;
    assert_eq!(listed[..had], before[1].as_array().unwrap()[..]);
    assert_eq!((listed.len(), listed[had]["account_id"].clone()), (had + 1, json!(new)));
    let (stored, held) = (u128::from(chain.storage_usage(&new).await), chain.balance(&new).await);
    let free = (held - stored * BYTE) / (NEAR / 1000);
    println!("NEAR a new account: storage {stored} B, free {free} milliNEAR of 6");
    // The account code is 4.4 KB larger than the one that is live, so 6 NEAR leaves 0.56 NEAR where it left 0.60.
    assert!(held - stored * BYTE > NEAR * 11 / 20, "a new account has under 0.55 NEAR free");

    // Every field an older reader uses is still in its state, and `hl` has gained the two new ones. The account made
    // before shows neither: that is how a reader tells the two apart.
    let state = w.state(&new).await;
    for field in ["loan", "pending", "counter", "permission_blk", "next_move", "evm", "hl"] {
        assert!(!state[field].is_null(), "get_state lost {field}: {state}");
    }
    for field in ["path", "address", "agent", "next_nonce_ms", "send_open_until_ms", "signed"] {
        assert!(state["hl"].get(field).is_some(), "get_state().hl lost {field}: {state}");
    }
    assert_eq!(
        (state["hl"]["open_sends"].clone(), state["hl"]["send_floor_until_ms"].clone()),
        (json!([]), json!("0"))
    );
    let old_hl = w.state(&old).await["hl"].clone();
    assert!(old_hl.get("open_sends").is_none() && old_hl.get("send_floor_until_ms").is_none(), "{old_hl}");

    // The new account signs a transfer out of Hyperliquid. It is listed, and the pause is on for 2 days and 1 hour.
    let nonce = w.sign_a_transfer_out(&new).await;
    let until = (nonce + SEND_OPEN_MS).to_string();
    let hl = w.state(&new).await["hl"].clone();
    assert_eq!(
        (hl["open_sends"].clone(), hl["send_open_until_ms"].clone()),
        (json!([nonce.to_string()]), json!(until))
    );
    // A check that doesn't name it is accepted, and the borrow is refused.
    let unnamed = w.check(&new, None).await;
    assert!(!unnamed.logs().contains(&LIFTED), "{unnamed:?}");
    assert_refused(&w.borrow(&new).await, PAUSED);
    assert_eq!(w.state(&new).await["hl"], hl);
    // A check that names it is accepted, says that the pause has ended, and empties the list.
    let named = w.check(&new, Some(&[nonce])).await;
    assert!(named.logs().contains(&LIFTED), "{named:?}");
    let hl = w.state(&new).await["hl"].clone();
    assert_eq!((hl["open_sends"].clone(), hl["send_open_until_ms"].clone()), (json!([]), json!("0")));
    assert_eq!(hl["send_floor_until_ms"], json!("0"));
    // The borrow right after it goes through: the live pool lends the $100.
    assert_ok(&w.borrow(&new).await, "the borrow after the pause was lifted");
    let state = w.state(&new).await;
    assert_eq!(state["loan"], json!({ "principal": usd(100).to_string(), "open": true }));
    let debt = str_u128(&chain.view::<Value>(&pool, "debt_of", json!({ "account_id": new })).await);
    assert!(debt >= usd(100) && debt < usd(101), "the pool books {debt} for a $100 loan");
    let usdc: AccountId = config["usdc_token"].as_str().unwrap().parse().unwrap();
    let got = str_u128(&chain.view::<Value>(&usdc, "ft_balance_of", json!({ "account_id": new })).await);
    assert!(got > usd(99) && got <= usd(100), "the account holds {got} of the $100 it borrowed");

    // The account made before the redeploy does the same, and behaves as before: the verdict that names its transfer
    // is accepted, nothing in `hl` moves, and the borrow waits for the 2 days and 1 hour.
    let nonce = w.sign_a_transfer_out(&old).await;
    let until = nonce + SEND_OPEN_MS;
    let hl = w.state(&old).await["hl"].clone();
    assert_eq!(hl["send_open_until_ms"], json!(until.to_string()));
    let named = w.check(&old, Some(&[nonce])).await;
    assert!(!named.logs().contains(&LIFTED), "{named:?}");
    assert_eq!(w.state(&old).await["hl"], hl);
    assert!(hl.get("open_sends").is_none());
    assert_refused(&w.borrow(&old).await, &format!("({until} ms): {PAUSED}"));
    assert_eq!(w.state(&old).await["loan"], json!({ "principal": "0", "open": false }));
}
