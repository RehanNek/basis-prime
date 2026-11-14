//! The account's part of the pool's finding P4, on the built contracts (research/audit.md, "Second pass";
//! INTERFACES.md 45, item 8): at an `l_borrow` step the account calls the pool's `settle(report, closes)`.
//!
//! - With the pool this tree builds: the step runs, and the pool keeps `report`, the lender's debt with this borrow
//!   added, as the start of the next period.
//! - With the pool that was live on testnet before this change (`c4641c0e…`, which knows no `closes`): the same
//!   step runs all the same. The older pool reads `report` and ignores what it doesn't know, so a new account never
//!   meets a refusal, whichever of the two is deployed first.
//!
//! What the pool charges on each end of the period is the pool's own to test (`contracts/pool`).
//!
//! The older pool's code is the file `tests/fetch_live.py` saved before this change:
//! `python3 -I contracts/tests/fetch_live.py --out contracts/target/live-pool-fees pool`.
//!
//! The world is `tests/audit_fixes.rs`'s.
mod common;

use std::time::Duration;

use common::rhea::mint;
use common::*;
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::{AccountId, NearToken};
use serde_json::{json, Value};

const REGISTRATION: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const PARAMS: &str = "4f0e2f3c8b9a1d7e6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605";
const VERSION: &str = "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12";
const GATEWAY_VERSION: &str = "cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34";
const HL_USDC: &str = "USDC:0xeb62eee3685fc4c43992febcd9e75443";
/// The pool's code on testnet before this change (INTERFACES.md 45).
const OLDER_POOL_SHA256: &str = "c4641c0e8d61015fa6d608abf46f0b00d2fa1bcb882b4cd02738b878d64024a2";

/// Aave's test market on Base Sepolia (INTERFACES.md 24 and 33).
const AAVE_POOL: &str = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
const AAVE_USDC: &str = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
const WBTC: &str = "0x54114591963CF60EF3aA63bEfD6eC263D98145a4";
const WETH: &str = "0x4200000000000000000000000000000000000006";

/// A sandbox with both test tokens, a funded pool running `pool_wasm`, the OutLayer and MPC mocks, the factory with
/// Aave in its config, and a client whose account was opened with a permission for Aave and knows its address there.
struct World {
    chain: Chain,
    pool: AccountId,
    outlayer: AccountId,
    mpc: AccountId,
    operator: AccountId,
    client: AccountId,
    account: AccountId,
}

impl World {
    async fn with_pool(pool_wasm: Vec<u8>) -> Self {
        let chain = Chain::start().await;
        let token = wasm("pb_testnet_token");
        let musdc_init = json!({ "name": "Mock USDC", "symbol": "mUSDC", "decimals": 6 });
        let mnbtc_init = json!({ "name": "Mock nBTC", "symbol": "mNBTC", "decimals": 8 });
        let musdc = chain.contract("musdc", 10, token.clone(), Some(("new", musdc_init))).await;
        let mnbtc = chain.contract("mnbtc", 10, token, Some(("new", mnbtc_init))).await;
        let operator = chain.account("operator", 50).await;
        let client = chain.account("client", 50).await;
        let outlayer = chain.contract("outlayer", 10, wasm("pb_testnet_outlayer_mock"), None).await;
        let mpc = chain.contract("mpc", 10, wasm("pb_testnet_mpc_mock"), None).await;

        let factory: AccountId = format!("factory.{}", chain.root).parse().unwrap();
        let init = json!({ "operator": operator, "factory": factory, "token": musdc });
        let pool = chain.contract("pool", 20, pool_wasm, Some(("new", init))).await;
        let args = json!({ "account_id": pool, "registration_only": true });
        chain.ok_with(&operator, &musdc, "storage_deposit", args, REGISTRATION).await;
        mint(&chain, &musdc, &operator, usd(100_000)).await;
        let fund = json!({ "receiver_id": pool, "amount": usd(100_000).to_string(), "msg": r#"{"pool":"fund"}"# });
        chain.ok_with(&operator, &musdc, "ft_transfer_call", fund, one_yocto()).await;

        let config = config(&musdc, &mnbtc, &pool, &outlayer, &chain.root);
        let init = json!({ "operator": operator, "config": config });
        let deployed = chain.contract("factory", 9, wasm("pb_factory"), Some(("new", init))).await;
        assert_eq!(deployed, factory);
        let account: AccountId = format!("alice.{factory}").parse().unwrap();
        let w = World { chain, pool, outlayer, mpc, operator, client, account };

        let terms = json!({ "lenders": ["aave"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any" });
        let args = json!({ "name": "alice", "owner": w.client, "permission": terms });
        let made = w.chain.call(&w.client, &factory, "create_account", args, NearToken::from_near(6)).await;
        assert_ok(&made, "create_account");
        assert!(made.clone().json::<bool>().unwrap(), "create_account reported a failed step: {made:?}");
        assert_ok(&w.chain.call(&w.client, &w.account, "hl_init", json!({}), yocto(0)).await, "hl_init");
        w
    }

    async fn counter(&self) -> u64 {
        let state: Value = self.chain.view(&self.account, "get_state", json!({})).await;
        state["counter"].as_u64().unwrap()
    }

    /// The pending OutLayer request from the account whose input has this intent.
    async fn request(&self, intent: &Value) -> Value {
        for _ in 0..80 {
            let pending: Vec<Value> = self.chain.view(&self.outlayer, "pending_requests", json!({})).await;
            let found = pending.into_iter().find(|r| {
                let input: Value = serde_json::from_str(r["input_data"].as_str().unwrap_or("null")).unwrap_or_default();
                r["caller"] == json!(self.account) && input["intent"] == *intent
            });
            if let Some(request) = found {
                return request;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        panic!("the check never reached OutLayer");
    }

    /// Asks for a check of `intent`, which the engine answers with a HEALTHY verdict read at the latest block for
    /// the account's counter, changed by `shape`. The account must keep it.
    async fn accept(&self, intent: Value, shape: impl FnOnce(&mut Value)) {
        let args = json!({ "intent": intent });
        let deposit = NearToken::from_millinear(10);
        let call = self.chain.call_in_background(&self.client, &self.account, "request_check", args, deposit);
        let request = self.request(&intent).await;
        let mut answer = verdict(&self.account, self.counter().await, self.chain.height().await);
        shape(&mut answer);
        let resolve = json!({ "request_id": request["request_id"], "output": answer });
        self.chain.ok(&self.operator, &self.outlayer, "resolve_execution", resolve).await;
        let result = call.await.unwrap();
        assert_ok(&result, "request_check");
        assert_eq!(result.json::<Value>().unwrap(), json!({ "accepted": true, "reason": null }));
    }

    /// The pool's pricing record of the account.
    async fn pricing(&self) -> Value {
        self.chain.view(&self.pool, "get_pricing", json!({ "account_id": self.account })).await
    }

    /// One `fund` for $20 from Aave alone, then the plan's `l_borrow` step, run by the operator. The engine's
    /// verdicts show $5 owed at Aave already and room for $20 more. The step asks the pool to settle first, and
    /// only when the pool has answered does the account ask the signer, which the mock answers. Returns the step's
    /// transaction.
    async fn borrow_20_at_aave(&self) -> ExecutionFinalResult {
        let c = &self.chain;
        let step = json!({ "k": "l_borrow", "l": "aave", "amt": 20_000_000 });
        let amount = json!({ "amount": "20000000" });
        let asked = |v: &mut Value| {
            v["fund"] = json!([step]);
            v["allow"]["fund"] = json!(20_000_000);
            v["ext"] = json!([aave_line()]);
            v["evm"] = json!({ "nonce": 0 });
        };
        self.accept(json!({ "fund": amount.clone() }), asked).await;
        let stored = c.call(&self.client, &self.account, "fund", amount, one_yocto()).await;
        assert_ok(&stored, "fund");
        let pid = stored.json::<Value>().unwrap()["pid"].as_str().unwrap().to_string();
        let fresh = |v: &mut Value| {
            v["ext"] = json!([aave_line()]);
            v["evm"] = json!({ "nonce": 0 });
        };
        self.accept(json!({ "check": {} }), fresh).await;

        let args = json!({ "pid": pid, "i": 0 });
        let call = c.call_in_background(&self.operator, &self.account, "execute_step", args, yocto(0));
        let mut request = None;
        for _ in 0..80 {
            let pending: Vec<Value> = c.view(&self.mpc, "pending_requests", json!({})).await;
            request = pending.into_iter().find(|p| p["signer_id"] == json!(self.account));
            if request.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        // The signer is asked only once the pool's `settle` has succeeded.
        let request =
            request.expect("the borrow never reached the MPC mock: the pool didn't settle")["request"].clone();
        let answer = json!({
            "big_r": { "affine_point": "03c108d226eef8ea52e8c49dd4ffe260add49c1478f8305122e2cee5f755b6df22" },
            "s": { "scalar": "680ca8be54a7349ca45980f38c0c76ef37406385b782c1d895e8ac5e257a0785" },
            "recovery_id": 0,
        });
        let args = json!({ "signer_id": self.account, "request": request, "response": answer });
        c.ok(&self.operator, &self.mpc, "respond", args).await;
        call.await.unwrap()
    }
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

/// A HEALTHY Standard verdict for `account` at block `blk` with counter `nonce` (`tests/account.rs` has the same).
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

/// The account's line at Aave as a verdict's `ext` carries it: $60 posted, $5 owed, room for $20 more.
fn aave_line() -> Value {
    json!({
        "l": "aave", "c": 60_000_000, "d": 5_000_000, "hf_bp": 99_600, "r_bp": 550, "s_bp": 400, "room": 20_000_000,
        "liq_bp": 8_300,
    })
}

/// How many of a call's receipts ran on `contract`.
fn receipts_on(result: &ExecutionFinalResult, contract: &AccountId) -> usize {
    result.receipt_outcomes().iter().filter(|r| &r.executor_id == contract).count()
}

/// Checks that the borrow step went through with the pool settling first, and that the pool keeps the report with
/// the borrow in it: $5 owed before, $20 borrowed, so $25 at the start of the next period.
async fn assert_settled_and_signed(w: &World, step: &ExecutionFinalResult) {
    // Every receipt succeeded, the pool's `settle` among them: it took the call as the account sent it.
    assert_ok(step, "execute_step (l_borrow at Aave)");
    assert!(receipts_on(step, &w.pool) >= 1, "the pool wasn't asked to settle: {step:?}");
    let entry = step.clone().json::<Value>().unwrap();
    assert_eq!((entry["kind"].clone(), entry["amount"].clone()), (json!("borrow"), json!("20000000")));
    let kept = json!([{ "lender": "aave", "debt": "25000000", "rate_bp": 550, "supply_bp": 400 }]);
    assert_eq!(w.pricing().await["last"], kept);
}

#[tokio::test]
async fn a_borrow_step_gives_the_pool_both_ends_of_the_period_and_the_pool_keeps_the_one_with_the_borrow() {
    let w = World::with_pool(wasm("pb_pool")).await;
    let step = w.borrow_20_at_aave().await;
    assert_settled_and_signed(&w, &step).await;
}

#[tokio::test]
async fn the_pool_from_before_this_change_takes_the_new_accounts_borrow_step_as_it_took_the_old_ones() {
    // The older pool's `settle` has one argument. It reads `report` and passes over `closes`.
    let older = Live::load_from("live-pool-fees", "pool");
    assert_eq!(
        older.sha256, OLDER_POOL_SHA256,
        "target/live-pool-fees/pool.wasm is not the pool from before this change"
    );
    let w = World::with_pool(older.wasm).await;
    let step = w.borrow_20_at_aave().await;
    assert_settled_and_signed(&w, &step).await;
}
