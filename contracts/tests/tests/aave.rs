//! The account contract signing Aave's transactions through the MPC mock, with the pool and the factory beside it
//! (FUNDING.md 4.5; INTERFACES.md 33).
//!
//! The sandbox has no Ethereum chain, so nothing is sent: the test is about what the account signs, keeps and
//! lists. The world is `tests/account.rs`'s, with a config that names Aave's test market on Base Sepolia and both
//! of its collateral tokens. The test plays the engine (its verdicts carry Aave's line and the chain's nonce) and
//! the signer: it answers each `sign` with a signature made in Node for exactly that transaction
//! (`contracts/account/evm-vectors.mjs`), so what the deployed contract keeps can be compared byte for byte with
//! the transaction Node built.
//!
//! - An approval, a supply, the supply again with a higher tip, and a borrow: each is signed, and its entry appears
//!   in `get_state().evm.signed`.
//! - The signed borrow is listed as under way. No block ends that: only a verdict whose `evm.nonce` is above its
//!   nonce does, and that verdict backs nothing itself.
//! - A signature that times out keeps nothing, drops the listing and leaves the nonce free.
//!
//! Run with `--nocapture` to see the gas each call burnt and what a new account's storage locks.
mod common;

use std::time::Duration;

use common::rhea::{mint, NBTC};
use common::*;
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::{AccountId, NearToken};
use serde_json::{json, Value};

const REGISTRATION: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const PARAMS: &str = "4f0e2f3c8b9a1d7e6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605";
const VERSION: &str = "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12";
const GATEWAY_VERSION: &str = "cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34";
const HL_USDC: &str = "USDC:0xeb62eee3685fc4c43992febcd9e75443";
/// What a client attaches to open an account: the factory's minimum.
const OPENING: NearToken = NearToken::from_near(6);
/// One NEAR, and the NEAR one byte of storage locks, in yoctoNEAR.
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const BYTE: u128 = 10_000_000_000_000_000_000;

/// Aave's test market on Base Sepolia (INTERFACES.md 24 and 33).
const AAVE_POOL: &str = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
const AAVE_USDC: &str = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
const WBTC: &str = "0x54114591963CF60EF3aA63bEfD6eC263D98145a4";
const WETH: &str = "0x4200000000000000000000000000000000000006";
/// 0.02 WETH, in its 18 decimals.
const WETH_AMOUNT: u128 = 20_000_000_000_000_000;
/// The address of the MPC mock's fixed key, which every account in the sandbox gets (`tests/account.rs`).
const ADDRESS: &str = "0xd7f35513286b7a0c2a7d8648c72588751ce0dd7c";

/// A sandbox with both test tokens, a funded pool, the OutLayer and MPC mocks, the factory with Aave in its config,
/// and a client whose account was opened with a permission for Aave and knows its Ethereum address.
struct World {
    chain: Chain,
    mnbtc: AccountId,
    pool: AccountId,
    outlayer: AccountId,
    mpc: AccountId,
    operator: AccountId,
    client: AccountId,
    account: AccountId,
}

impl World {
    async fn new() -> Self {
        let chain = Chain::start().await;
        let token = wasm("pb_testnet_token");
        let musdc_init = json!({ "name": "Mock USDC", "symbol": "mUSDC", "decimals": 6 });
        let mnbtc_init = json!({ "name": "Mock nBTC", "symbol": "mNBTC", "decimals": 8 });
        let musdc = chain.contract("musdc", 10, token.clone(), Some(("new", musdc_init))).await;
        let mnbtc = chain.contract("mnbtc", 10, token, Some(("new", mnbtc_init))).await;
        let operator = chain.account("operator", 50).await;
        let client = chain.account("client", 50).await;
        let outlayer = chain.contract("outlayer", 10, wasm("pb_testnet_outlayer_mock"), None).await;
        // The config names `mpc.<root>` as the MPC signer.
        let mpc = chain.contract("mpc", 10, wasm("pb_testnet_mpc_mock"), None).await;

        // The pool lends mUSDC to accounts the factory registers, and the operator funds it with $100,000.
        let factory: AccountId = format!("factory.{}", chain.root).parse().unwrap();
        let init = json!({ "operator": operator, "factory": factory, "token": musdc });
        let pool = chain.contract("pool", 20, wasm("pb_pool"), Some(("new", init))).await;
        let args = json!({ "account_id": pool, "registration_only": true });
        chain.ok_with(&operator, &musdc, "storage_deposit", args, REGISTRATION).await;
        mint(&chain, &musdc, &operator, usd(100_000)).await;
        let fund = json!({ "receiver_id": pool, "amount": usd(100_000).to_string(), "msg": r#"{"pool":"fund"}"# });
        chain.ok_with(&operator, &musdc, "ft_transfer_call", fund, one_yocto()).await;

        // The factory, whose config has Aave's test market with WBTC and WETH as collateral and a fee limit of
        // 1 gwei. Its code locks 7.1 NEAR.
        let config = config(&musdc, &mnbtc, &pool, &outlayer, &chain.root);
        let init = json!({ "operator": operator, "config": config });
        let deployed = chain.contract("factory", 9, wasm("pb_factory"), Some(("new", init))).await;
        assert_eq!(deployed, factory);
        let account: AccountId = format!("alice.{factory}").parse().unwrap();
        let w = World { chain, mnbtc, pool, outlayer, mpc, operator, client, account };

        // The client opens its account and permits Aave in the same call.
        let args = json!({ "name": "alice", "owner": w.client, "permission": terms() });
        let made = w.chain.call(&w.client, &factory, "create_account", args, OPENING).await;
        assert_ok(&made, "create_account");
        assert!(made.clone().json::<bool>().unwrap(), "create_account reported a failed step: {made:?}");
        w
    }

    async fn state(&self) -> Value {
        self.chain.view(&self.account, "get_state", json!({})).await
    }

    async fn counter(&self) -> u64 {
        self.state().await["counter"].as_u64().unwrap()
    }

    /// The lender actions under way, as `get_state().pending` lists them.
    async fn lender_actions(&self) -> Vec<Value> {
        self.state().await["pending"].as_array().unwrap().iter().filter_map(|p| p.get("lender").cloned()).collect()
    }

    /// The pending OutLayer request from the account whose input has this intent.
    async fn request(&self, intent: &Value) -> Option<Value> {
        let pending: Vec<Value> = self.chain.view(&self.outlayer, "pending_requests", json!({})).await;
        pending.into_iter().find(|r| {
            let input: Value = serde_json::from_str(r["input_data"].as_str().unwrap_or("null")).unwrap_or_default();
            r["caller"] == json!(self.account) && input["intent"] == *intent
        })
    }

    /// Asks for a check of `intent` and answers it as the engine would: a HEALTHY verdict read at the latest block
    /// for the account's counter, changed by `shape`. The account must keep it. Returns the transaction.
    async fn check(&self, intent: Value, shape: impl FnOnce(&mut Value)) -> ExecutionFinalResult {
        let args = json!({ "intent": intent });
        let deposit = NearToken::from_millinear(10);
        let call = self.chain.call_in_background(&self.client, &self.account, "request_check", args, deposit);
        let mut request = None;
        for _ in 0..80 {
            request = self.request(&intent).await;
            if request.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let request = request.expect("the check never reached OutLayer");
        let mut answer = verdict(&self.account, self.counter().await, self.chain.height().await);
        shape(&mut answer);
        let resolve = json!({ "request_id": request["request_id"], "output": answer });
        self.chain.ok(&self.operator, &self.outlayer, "resolve_execution", resolve).await;
        let result = call.await.unwrap();
        assert_ok(&result, "request_check");
        assert_eq!(result.clone().json::<Value>().unwrap(), json!({ "accepted": true, "reason": null }));
        result
    }

    /// A plain check whose verdict carries Aave's line, with `debt` owed there and `room` to borrow more, and the
    /// next nonce the engine found for the account's address on Aave's chain. Returns the transaction.
    async fn check_at_aave(&self, debt: u128, room: u128, chain_nonce: u64) -> ExecutionFinalResult {
        let shape = |v: &mut Value| {
            v["ext"] = json!([aave_line(debt, room)]);
            v["evm"] = json!({ "nonce": chain_nonce });
        };
        self.check(json!({ "check": {} }), shape).await
    }

    /// As `check_at_aave`, for a check whose transaction the test doesn't look at.
    async fn accept_at_aave(&self, debt: u128, room: u128, chain_nonce: u64) {
        let _ = self.check_at_aave(debt, room, chain_nonce).await;
    }

    /// `caller` calls `method` on the account in the background, with 300 TGas, and the test waits for its `sign`
    /// request to reach the MPC mock: the request `wanted`, or with none the account's first. Returns the request
    /// and the call. The mock can go on listing a request that timed out, which is why a test names the one it wants.
    async fn start_signing(
        &self,
        caller: &AccountId,
        method: &'static str,
        args: Value,
        deposit: NearToken,
        wanted: Option<&Value>,
    ) -> (Value, tokio::task::JoinHandle<ExecutionFinalResult>) {
        let call = self.chain.call_in_background(caller, &self.account, method, args, deposit);
        let mut seen = Vec::new();
        for _ in 0..80 {
            let pending: Vec<Value> = self.chain.view(&self.mpc, "pending_requests", json!({})).await;
            seen = pending.into_iter().filter(|p| p["signer_id"] == json!(self.account)).collect();
            if let Some(p) = seen.iter().find(|p| wanted.is_none_or(|wanted| p["request"] == *wanted)) {
                return (p["request"].clone(), call);
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        panic!("the signature {method} should ask for never reached the MPC mock, which has {seen:?}");
    }

    /// The MPC mock answers `request` with the signature Node made for the transaction `tx`.
    async fn sign(&self, request: &Value, tx: &Value) {
        let args = json!({ "signer_id": self.account, "request": request, "response": signer_answer(tx) });
        self.chain.ok(&self.operator, &self.mpc, "respond", args).await;
    }

    /// `caller` calls `method`, which must ask the signer to sign exactly the transaction `tx` that Node built. The
    /// mock answers with Node's signature. Returns the entry the account kept, and the transaction.
    async fn signed(
        &self,
        caller: &AccountId,
        method: &'static str,
        args: Value,
        deposit: NearToken,
        tx: &Value,
    ) -> (Value, ExecutionFinalResult) {
        // The request is for the hash Node signed, so the account built the same transaction.
        let (request, call) = self.start_signing(caller, method, args, deposit, Some(&sign_request(tx))).await;
        self.sign(&request, tx).await;
        let result = call.await.unwrap();
        assert_ok(&result, method);
        (result.clone().json::<Value>().unwrap(), result)
    }

    /// What the account owes our pool, by the pool's own figure.
    async fn pool_debt(&self) -> u128 {
        str_u128(&self.chain.view::<Value>(&self.pool, "debt_of", json!({ "account_id": self.account })).await)
    }
}

/// The permission the client signs as it opens the account: Aave, at the app's default terms.
fn terms() -> Value {
    json!({ "lenders": ["aave"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any" })
}

fn config(musdc: &AccountId, mnbtc: &AccountId, pool: &AccountId, outlayer: &AccountId, root: &AccountId) -> Value {
    let aave = json!({
        "chain_id": 84532,
        "pool": AAVE_POOL,
        "usdc": { "symbol": "USDC", "address": AAVE_USDC, "decimals": 6 },
        "collateral": [
            { "symbol": "WBTC", "address": WBTC, "decimals": 8 },
            { "symbol": "WETH", "address": WETH, "decimals": 18 },
        ],
        "max_fee_per_gas": "1000000000",
    });
    json!({
        "tokens": [
            { "id": musdc, "symbol": "USDC", "decimals": 6 },
            { "id": mnbtc, "symbol": "nBTC", "decimals": 8 },
        ],
        "pool_id": pool,
        "mpc_id": format!("mpc.{root}"),
        "outlayer_id": outlayer,
        "risk": { "project_id": "pbf-keeper.testnet/pb-risk", "version_key": VERSION },
        "hl_chain": "Testnet",
        "signature_chain_id": "0x66eee",
        "usdc_token": musdc,
        "params_hash": PARAMS,
        "model": "B-0.2",
        "drill_id": format!("drill.{root}"),
        "gateway": { "project_id": "pbf-keeper.testnet/pb-gateway", "version_key": GATEWAY_VERSION },
        "hl_usdc_token": HL_USDC,
        "lenders": { "rhea": null, "aave": aave },
    })
}

/// A HEALTHY Standard verdict for `account` at block `blk` with counter `nonce`, allowing a $2,000 borrow from our
/// pool (`tests/account.rs` has the same).
fn verdict(account: &AccountId, nonce: u64, blk: u64) -> Value {
    json!({
        "ok": true, "v": 1, "model": "B-0.2", "params": PARAMS, "acct": account,
        "blk": blk, "nonce": nonce,
        "eq": 31_000_000_000u64, "eq_allow": 31_000_000_000u64, "mm": 4_000_000_000u64, "im": 5_000_000_000u64,
        "state": "HEALTHY", "action": "NONE", "since": 0,
        "score": 650, "tier": "STANDARD", "rate_bp": 400,
        "allow": { "withdraw": 0, "borrow": 2_000_000_000u64 },
        "credit": { "line": 2_000_000_000u64, "binding": "C5" },
        "volf_bp": 10_000, "top": ["nBTC depeg 20%"], "topup": 0,
        "venues": { "hl_margin_ratio_bp": 0 },
        "pool": { "shares_bp": { "nBTC": 9_355 }, "hold": { "nBTC": 29_000_000_000u64 }, "hl_eq": 0 },
        "hr_bp": 10_000, "hr7_bp": 10_000, "exp_bp": 9_355,
        "bands": {}, "coins": { "uncertain": [], "stale": [], "reduce_only": [] },
        "plan": [], "in": "11".repeat(32),
    })
}

/// The account's line at Aave as a verdict's `ext` carries it: 0.02 WETH posted, worth $60.
fn aave_line(debt: u128, room: u128) -> Value {
    let cushion = if debt == 0 { 0 } else { 60_000_000 * 8_300 / debt };
    json!({
        "l": "aave", "c": 60_000_000, "d": debt as u64, "hf_bp": cushion as u64, "r_bp": 550, "s_bp": 400,
        "room": room as u64, "liq_bp": 8_300,
    })
}

/// The transaction Node built and signed under this name for the sandbox's address
/// (`contracts/account/src/evm_vectors.json`, written by `contracts/account/evm-vectors.mjs`).
fn node_tx(name: &str) -> Value {
    let vectors: Value = serde_json::from_str(include_str!("../../account/src/evm_vectors.json")).unwrap();
    assert_eq!(vectors["sandbox"]["account"], ADDRESS);
    let list = vectors["sandbox"]["transactions"].as_array().unwrap();
    list.iter().find(|tx| tx["name"] == name).unwrap_or_else(|| panic!("Node built no {name}")).clone()
}

/// What the account must ask the signer for `tx`: its key path, and the hash Node signed.
fn sign_request(tx: &Value) -> Value {
    let digest = tx["signing_hash"].as_str().unwrap().trim_start_matches("0x");
    json!({ "path": "hyperliquid-1", "payload_v2": { "Ecdsa": digest }, "domain_id": 0 })
}

/// Node's signature of `tx` in the real signer's format: `r` is the x of `big_r`, and `recovery_id` the parity.
fn signer_answer(tx: &Value) -> Value {
    let part = |field: &str| tx[field].as_str().unwrap().trim_start_matches("0x").to_string();
    let parity = tx["y_parity"].as_u64().unwrap();
    let big_r = format!("{}{}", if parity == 0 { "02" } else { "03" }, part("r"));
    json!({ "scheme": "Secp256k1", "big_r": { "affine_point": big_r }, "s": { "scalar": part("s") }, "recovery_id": parity })
}

/// Checks that `entry`, as the account kept it, is Node's transaction `tx`, byte for byte, with these labels.
fn assert_kept(entry: &Value, tx: &Value, kind: &str, token: &str, amount: u128, step: Value) {
    let mut expected = json!({
        "nonce": tx["nonce"].as_str().unwrap().parse::<u64>().unwrap(), "kind": kind, "token": token.to_lowercase(),
        "amount": amount.to_string(), "to": tx["to"], "raw": tx["raw"], "hash": tx["hash"], "step": step,
    });
    expected["signed_at"] = entry["signed_at"].clone();
    assert_eq!(*entry, expected, "the account kept another {kind} than Node built");
    assert!(str_u128(&entry["signed_at"]) > 0);
}

/// The data of the `pb-pool` events with this name that a transaction logged.
fn events(result: &ExecutionFinalResult, name: &str) -> Vec<Value> {
    let logs = result.logs();
    let events = logs.iter().filter_map(|log| log.strip_prefix("EVENT_JSON:"));
    let parsed = events.filter_map(|text| serde_json::from_str::<Value>(text).ok());
    parsed.filter(|e| e["standard"] == "pb-pool" && e["event"] == name).map(|e| e["data"].clone()).collect()
}

/// How many of a call's receipts ran on `contract`.
fn receipts_on(result: &ExecutionFinalResult, contract: &AccountId) -> usize {
    result.receipt_outcomes().iter().filter(|r| &r.executor_id == contract).count()
}

/// Prints what a call burnt in all, and checks it fits in a transaction's 300 TGas with room to spare. Every call
/// here was sent with 300 TGas attached.
fn burnt(what: &str, result: &ExecutionFinalResult) -> f64 {
    let gas = result.total_gas_burnt.as_gas() as f64 / 1e12;
    println!("GAS  {what}: {gas:.1} TGas");
    assert!(gas < 150.0, "{what} burnt {gas:.1} TGas, over half of what a transaction can carry");
    gas
}

/// An amount of yoctoNEAR in NEAR, to four places.
fn near(yocto: u128) -> f64 {
    (yocto / (NEAR / 10_000)) as f64 / 10_000.0
}

#[tokio::test]
async fn an_aave_loan_is_signed_step_by_step_and_its_borrow_counts_until_a_verdict_sees_it_mined() {
    let w = World::new().await;
    let c = &w.chain;

    // What a new account needs: its code, its state, and what the opening deposit leaves it.
    let code = wasm("pb_account").len() as u128;
    let (stored, held) = (u128::from(c.storage_usage(&w.account).await), c.balance(&w.account).await);
    let free = held - stored * BYTE;
    println!(
        "NEAR opening: code {code} B, storage {stored} B = {:.4} NEAR locked, balance {:.4}, free {:.4}",
        near(stored * BYTE),
        near(held),
        near(free)
    );
    assert!(free > NEAR * 11 / 20, "a new account has {:.4} NEAR free, under 0.55", near(free));

    // The account's config has Aave with both collateral tokens, and its Ethereum side is empty.
    let config: Value = c.view(&w.account, "get_config", json!({})).await;
    assert_eq!(
        config["lenders"]["aave"]["collateral"][1],
        json!({ "symbol": "WETH", "address": WETH, "decimals": 18 })
    );
    assert_eq!(w.state().await["evm"], json!({ "nonce": 0, "signed": [], "approved": [] }));

    // Nothing is signed before the account knows its address, which is its Hyperliquid address.
    let early = c.call(&w.operator, &w.account, "evm_approve", json!({ "token": WETH }), yocto(0)).await;
    assert_refused(&early, "no Ethereum address yet: call hl_init first");
    let init = c.call(&w.operator, &w.account, "hl_init", json!({}), yocto(0)).await;
    assert_ok(&init, "hl_init");
    assert_eq!(init.json::<Value>().unwrap(), json!(ADDRESS));

    // Anyone has the approval signed: approve(Aave's Pool, the largest amount) on WETH, with the address's nonce 0.
    let approve = node_tx("approve");
    let token = json!({ "token": WETH });
    let (entry, result) = w.signed(&w.operator, "evm_approve", token.clone(), yocto(0), &approve).await;
    burnt("evm_approve", &result);
    assert_kept(&entry, &approve, "approve", WETH, 0, Value::Null);
    assert_eq!(events(&result, "evm_signed"), vec![json!({ "nonce": 0, "kind": "approve", "hash": approve["hash"] })]);
    assert_eq!(w.state().await["evm"], json!({ "nonce": 1, "signed": [entry], "approved": [WETH] }));
    assert_eq!((w.counter().await, w.lender_actions().await.len()), (0, 0));
    let again = c.call(&w.operator, &w.account, "evm_approve", token, yocto(0)).await;
    assert_refused(&again, "is signed already: only the owner can have it signed again");

    // The client deposits 1 mNBTC and asks for $30 in all. The engine answers with Aave first: post 0.02 WETH
    // there, borrow $20 against it, then $10 from our pool.
    mint(c, &w.mnbtc, &w.client, NBTC).await;
    let args = json!({ "receiver_id": w.account, "amount": NBTC.to_string(), "msg": "" });
    c.ok_with(&w.client, &w.mnbtc, "ft_transfer_call", args, one_yocto()).await;
    let steps = json!([
        { "k": "l_supply", "l": "aave", "tok": WETH, "amt": WETH_AMOUNT.to_string() },
        { "k": "l_borrow", "l": "aave", "amt": 20_000_000 },
        { "k": "p_borrow", "amt": 10_000_000 },
    ]);
    let shape = |v: &mut Value| {
        v["fund"] = steps;
        v["allow"]["fund"] = json!(30_000_000);
        v["ext"] = json!([aave_line(0, 0)]);
        v["evm"] = json!({ "nonce": 0 });
    };
    let _ = w.check(json!({ "fund": { "amount": "30000000" } }), shape).await;
    let stored = c.call(&w.client, &w.account, "fund", json!({ "amount": "30000000" }), one_yocto()).await;
    assert_ok(&stored, "fund");
    let pid = stored.json::<Value>().unwrap()["pid"].as_str().unwrap().to_string();
    assert_eq!(w.counter().await, 1);

    // Step 0: the keeper has the supply signed. supply(WETH, 0.02 WETH, the account's own address, 0) on Aave's
    // Pool, with nonce 1. It is kept with its step, and the counter moves on twice, as for Rhea.
    let supply = node_tx("supply");
    let step = |i: u32| json!({ "pid": pid, "i": i });
    let size = c.storage_usage(&w.account).await;
    let (entry, result) = w.signed(&w.operator, "execute_step", step(0), yocto(0), &supply).await;
    burnt("execute_step (l_supply at Aave)", &result);
    assert_kept(&entry, &supply, "supply", WETH, WETH_AMOUNT, json!(format!("{pid}:0")));
    assert_eq!(events(&result, "step_run"), vec![json!({ "pid": pid, "i": 0, "k": "l_supply" })]);
    assert_eq!(events(&result, "evm_signed"), vec![json!({ "nonce": 1, "kind": "supply", "hash": supply["hash"] })]);
    let state = w.state().await;
    assert_eq!((state["counter"].clone(), state["evm"]["nonce"].clone()), (json!(3), json!(2)));
    assert_eq!(state["evm"]["signed"][1], entry);
    assert_eq!(state["funding"]["steps"][0]["done"], true);
    assert!(w.lender_actions().await.is_empty(), "a supply is listed as under way");
    println!("NEAR a kept supply adds {} B to the account's state", c.storage_usage(&w.account).await - size);

    // The owner has it signed again with a tenth more fee and twice the tip, for a node that won't take the first,
    // which offered half the limit. The new one replaces the kept one and uses no new nonce. Anyone else waits a
    // minute, and no one raises the fee by more than an eighth at once (research/audit.md, A10).
    let bumped = node_tx("supply_bumped");
    let bump = json!({ "nonce": 1, "max_fee": "550000000", "tip": "2000000" });
    let early = c.call(&w.operator, &w.account, "evm_bump", bump.clone(), yocto(0)).await;
    assert_refused(&early, "anyone but the owner bumps a transaction once it is 60 seconds old");
    let far = json!({ "nonce": 1, "max_fee": "1000000000", "tip": "2000000" });
    let refused = c.call(&w.client, &w.account, "evm_bump", far, yocto(0)).await;
    assert_refused(&refused, "a bump raises the fee by an eighth at most: 562500000 wei a gas");
    let (entry, result) = w.signed(&w.client, "evm_bump", bump.clone(), yocto(0), &bumped).await;
    burnt("evm_bump", &result);
    assert_kept(&entry, &bumped, "supply", WETH, WETH_AMOUNT, json!(format!("{pid}:0")));
    let state = w.state().await;
    assert_eq!((state["counter"].clone(), state["evm"]["nonce"].clone()), (json!(3), json!(2)));
    assert_eq!(state["evm"]["signed"], json!([state["evm"]["signed"][0], entry]));
    let same = c.call(&w.client, &w.account, "evm_bump", bump, yocto(0)).await;
    assert_refused(&same, "a bump raises both the fee and the tip by at least a tenth");

    // The engine reads Aave: the supply is mined (the chain's next nonce is 2), and there is room for $20.
    w.accept_at_aave(0, 20_000_000, 2).await;

    // Step 1: the borrow. The pool settles first, then the signer signs borrow(USDC, $20, the variable rate, 0, the
    // account's own address) with nonce 2. It is listed from the moment the step starts.
    let borrow = node_tx("borrow");
    let wanted = sign_request(&borrow);
    let (request, call) = w.start_signing(&w.operator, "execute_step", step(1), yocto(0), Some(&wanted)).await;
    let listed = json!({
        "lender": "aave", "kind": "borrow", "amount": "20000000", "token": AAVE_USDC.to_lowercase(), "evm_nonce": 2,
    });
    assert_eq!(w.lender_actions().await, vec![listed.clone()]);
    assert_eq!(w.counter().await, 4);
    w.sign(&request, &borrow).await;
    let result = call.await.unwrap();
    assert_ok(&result, "execute_step (l_borrow at Aave)");
    burnt("execute_step (l_borrow at Aave)", &result);
    assert!(receipts_on(&result, &w.pool) >= 1, "the pool wasn't asked to settle first: {result:?}");
    let entry = result.clone().json::<Value>().unwrap();
    assert_kept(&entry, &borrow, "borrow", AAVE_USDC, 20_000_000, json!(format!("{pid}:1")));
    assert_eq!(events(&result, "evm_signed"), vec![json!({ "nonce": 2, "kind": "borrow", "hash": borrow["hash"] })]);
    let state = w.state().await;
    assert_eq!((state["counter"].clone(), state["evm"]["nonce"].clone()), (json!(4), json!(3)));
    assert_eq!(state["evm"]["signed"].as_array().unwrap().len(), 3);
    assert_eq!(state["evm"]["signed"][2], entry);
    assert_eq!(w.lender_actions().await, vec![listed.clone()]);
    // The account books no loan of Aave's.
    assert_eq!(state["loan"]["open"], false);

    // Signed is as good as sent, so nothing that adds risk runs: not our pool's step, and no block ends the wait.
    let wait = "no funding step until a check shows Ethereum transaction 2 mined: a borrow at aave is still under way";
    assert_refused(&c.call(&w.operator, &w.account, "execute_step", step(2), yocto(0)).await, wait);
    c.fast_forward(30).await;
    assert_refused(&c.call(&w.operator, &w.account, "execute_step", step(2), yocto(0)).await, wait);
    // A check that finds the chain's next nonce still at 2 changes nothing: the borrow isn't mined.
    w.accept_at_aave(0, 0, 2).await;
    assert_eq!((w.lender_actions().await, w.counter().await), (vec![listed], 4));
    assert_refused(&c.call(&w.operator, &w.account, "execute_step", step(2), yocto(0)).await, wait);
    // Nor is a kept transaction that isn't mined past bumping.
    let low = json!({ "nonce": 2, "max_fee": "1000000000", "tip": "1000001" });
    let refused = c.call(&w.operator, &w.account, "evm_bump", low, yocto(0)).await;
    assert_refused(&refused, "a bump raises both the fee and the tip by at least a tenth");

    // The keeper sends the borrow and it is mined. The next check finds the chain's next nonce at 3, above the
    // borrow's: the listing goes and the counter moves on.
    let seen = w.check_at_aave(20_000_000, 0, 3).await;
    burnt("request_check (the verdict that sees the borrow mined)", &seen);
    assert!(
        seen.logs().contains(&"Aave's chain has used the signed transaction's nonce: the counter moves on"),
        "{seen:?}"
    );
    assert_eq!((w.lender_actions().await.len(), w.counter().await), (0, 5));
    let mined = json!({ "nonce": 2, "max_fee": "1000000000", "tip": "2000000" });
    let refused = c.call(&w.operator, &w.account, "evm_bump", mined, yocto(0)).await;
    assert_refused(&refused, "the transaction with nonce 2 is mined already");

    // That verdict backs nothing itself. A second check does, and our pool lends its $10 on it.
    let spent = c.call(&w.operator, &w.account, "execute_step", step(2), yocto(0)).await;
    assert_refused(&spent, "the verdict was already used: ask for a new check");
    w.accept_at_aave(20_000_000, 0, 3).await;
    let lent = c.call(&w.operator, &w.account, "execute_step", step(2), yocto(0)).await;
    assert_ok(&lent, "execute_step (p_borrow)");
    // The pool's figure has a moment's interest in it already.
    let debt = w.pool_debt().await;
    assert!((10_000_000..10_000_100).contains(&debt), "the account owes our pool {debt}");
    let state = w.state().await;
    assert_eq!((state["loan"]["open"].clone(), state["evm"]["nonce"].clone()), (json!(true), json!(3)));

    // While the account owes our pool, a way out of Aave's chain needs a verdict for exactly it.
    let out = json!({ "token": WETH, "amount": "5", "to": "0x2031181d63507368232579AF4c64a1c3428407fF" });
    let refused = c.call(&w.client, &w.account, "evm_withdraw", out, one_yocto()).await;
    assert_refused(&refused, "the verdict was already used: ask for a new check");
    let back = json!({ "lender": "aave", "token": WETH, "amount": "5" });
    let refused = c.call(&w.client, &w.account, "lender_withdraw", back, one_yocto()).await;
    assert_refused(&refused, "the verdict was already used: ask for a new check");
    assert_eq!((w.lender_actions().await.len(), w.state().await["evm"]["nonce"].clone()), (0, json!(3)));

    // What the account has left once it holds a funding plan, a verdict and three signed transactions.
    let (stored, held) = (u128::from(c.storage_usage(&w.account).await), c.balance(&w.account).await);
    println!(
        "NEAR after the loan: storage {stored} B, balance {:.4}, free {:.4}",
        near(held),
        near(held - stored * BYTE)
    );
}

#[tokio::test]
async fn a_signature_that_times_out_keeps_nothing_drops_the_listing_and_leaves_the_nonce_free() {
    let w = World::new().await;
    let c = &w.chain;
    assert_ok(&c.call(&w.client, &w.account, "hl_init", json!({}), yocto(0)).await, "hl_init");

    // With no loan from our pool, the owner takes 0.02 WETH back from Aave without a verdict. It is listed at once.
    let back = json!({ "lender": "aave", "token": WETH, "amount": WETH_AMOUNT.to_string() });
    let (_, call) = w.start_signing(&w.client, "lender_withdraw", back, one_yocto(), None).await;
    let listed = json!({
        "lender": "aave", "kind": "withdraw", "amount": WETH_AMOUNT.to_string(), "token": WETH, "evm_nonce": 0,
    });
    assert_eq!((w.lender_actions().await, w.counter().await), (vec![listed], 1));
    // Meanwhile no other transaction is signed.
    let busy = c.call(&w.operator, &w.account, "evm_approve", json!({ "token": WETH }), yocto(0)).await;
    assert_refused(&busy, "Ethereum transaction 0 is being signed: wait for the signer's answer");

    // The signer never answers, and gives up after 200 blocks. Nothing is kept, the listing goes, the counter moves
    // on, and nonce 0 was never used.
    c.fast_forward(210).await;
    let timed_out = call.await.unwrap();
    assert_eq!(timed_out.clone().json::<Value>().unwrap(), Value::Null);
    let log = "no Ethereum transaction signed, as the MPC signer failed or timed out";
    assert!(timed_out.logs().contains(&log), "{timed_out:?}");
    let state = w.state().await;
    assert_eq!(state["evm"], json!({ "nonce": 0, "signed": [], "approved": [] }));
    assert_eq!((w.lender_actions().await.len(), state["counter"].clone()), (0, json!(2)));

    // The next transaction takes nonce 0: it is the approval Node built with that nonce.
    let approve = node_tx("approve");
    let (entry, _) = w.signed(&w.operator, "evm_approve", json!({ "token": WETH }), yocto(0), &approve).await;
    assert_kept(&entry, &approve, "approve", WETH, 0, Value::Null);
    assert_eq!(w.state().await["evm"], json!({ "nonce": 1, "signed": [entry], "approved": [WETH] }));
}
