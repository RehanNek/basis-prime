//! The factory and the account contract against the real pool, the real test tokens, the OutLayer mock and the MPC
//! mock, in the sandbox (PLAN.md 10 and 11.3). The OutLayer mock holds each `request_execution` until the test
//! resolves it with a canned verdict, the way OutLayer's worker answers with `pb-risk`'s. The MPC mock holds each
//! `sign` until the test answers it with a real signature from Phase 0.
//!
//! - The full flow: factory → account → deposits → check → borrow → repay → withdraw.
//! - Refusals: an old verdict (fast-forward), a verdict used twice, a verdict from another program (wrong `params`
//!   or `model`), a verdict for another account, and a withdrawal with a loan and no verdict.
//! - With no loan a withdrawal needs no verdict; a token that isn't listed bounces; a failed creation is refunded.
//! - The Hyperliquid side (INTERFACES.md 8): `hl_init`, `request_agent`, `hl_approve_agent` and `hl_withdraw` (from
//!   perps and from spot), with their refusals (not the owner, no address or agent, a loan open, an agent for another
//!   account, no gateway version pinned) and a signature that times out. Also the gateway's `secrets_ref`, and the
//!   send window: after a `sendAsset`, a borrow is refused while a withdrawal with no loan still goes out.
//! - Phase 4 (INTERFACES.md 13 and 14), with a sandbox account playing each 1Click deposit address and the 1Click
//!   solver that pays back:
//!   - the drill's path: two DELEVERAGE verdicts 2.5 minutes apart store the plan; anyone runs its `repay`; `perp`
//!     is refused;
//!   - a REBALANCE end to end: a `sell` and a `to_hl` step through the pool's `check_step` to their deposit
//!     addresses; the sale's USDC arrives by msg, and a verdict says the move to Hyperliquid arrived;
//!   - a refund by msg, a late arrival after the deadline (an overdue transfer holds back borrowing until it
//!     arrives), and DEFAULT, which writes the debt off once two verdicts 2.5 minutes apart say it;
//!   - DEFAULT's two checks, a repayment after the write-off, and the block lifting once the pool's review has;
//!   - a DELEVERAGE plan's `home` step, signed by the MPC mock, and its USDC arriving by msg;
//!   - a transfer that 1Click failed: forgotten by the owner once overdue, and its money kept if it comes later.
//! - Phase 6 (INTERFACES.md 25): an account opened with a funding permission, `fund` storing the verdict's steps,
//!   anyone running the pool's step on a fresh verdict, a lender step that waits for a fresh verdict, and the permission
//!   cancelled under a stored plan.
mod common;

use std::time::Duration;

use common::*;
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::{AccountId, NearToken};
use serde_json::{json, Value};

const REGISTRATION: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const PARAMS: &str = "4f0e2f3c8b9a1d7e6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605";
const VERSION: &str = "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12";
const GATEWAY_VERSION: &str = "cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34";
const HL_USDC: &str = "USDC:0xeb62eee3685fc4c43992febcd9e75443";
/// One mNBTC is 10^8 units.
const BTC: u128 = 100_000_000;

/// A sandbox with mUSDC and mNBTC, a funded pool, the OutLayer and MPC mocks, the factory, and a client with one
/// account.
struct World {
    chain: Chain,
    musdc: AccountId,
    mnbtc: AccountId,
    pool: AccountId,
    outlayer: AccountId,
    mpc: AccountId,
    factory: AccountId,
    operator: AccountId,
    client: AccountId,
    account: AccountId,
}

impl World {
    async fn new() -> Self {
        Self::on(Chain::start().await).await
    }

    /// The same world on `chain`.
    async fn on(chain: Chain) -> Self {
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
        let factory: AccountId = format!("factory.{}", chain.root).parse().unwrap();
        // The pool lends mUSDC with the spec's periods, to accounts the factory registers.
        let init = json!({ "operator": operator, "factory": factory, "token": musdc });
        let pool = chain.contract("pool", 20, wasm("pb_pool"), Some(("new", init))).await;
        let config = config(&musdc, &mnbtc, &pool, &outlayer, &chain.root);
        let init = json!({ "operator": operator, "config": config });
        // 8 NEAR covers the factory's code (7.04 NEAR of storage, with the account code that runs Rhea's steps) with
        // under 1 NEAR to spare, so it can't front a refund of 6 NEAR that it hasn't received.
        let deployed = chain.contract("factory", 8, wasm("pb_factory"), Some(("new", init))).await;
        assert_eq!(deployed, factory);
        let account: AccountId = format!("alice.{factory}").parse().unwrap();
        let w = World { chain, musdc, mnbtc, pool, outlayer, mpc, factory, operator, client, account };

        // The operator funds the pool with $100,000.
        let args = json!({ "account_id": w.pool, "registration_only": true });
        w.chain.ok_with(&w.operator, &w.musdc, "storage_deposit", args, REGISTRATION).await;
        w.mint(&w.musdc, &w.operator.clone(), usd(100_000)).await;
        let fund = json!({ "receiver_id": w.pool, "amount": usd(100_000).to_string(), "msg": r#"{"pool":"fund"}"# });
        w.chain.ok_with(&w.operator, &w.musdc, "ft_transfer_call", fund, one_yocto()).await;

        let created = w.create("alice").await;
        assert_ok(&created, "create_account");
        assert!(created.clone().json::<bool>().unwrap(), "create_account reported a failed step: {created:?}");
        w
    }

    async fn create(&self, name: &str) -> ExecutionFinalResult {
        let args = json!({ "name": name, "owner": self.client });
        self.chain.call(&self.client, &self.factory, "create_account", args, NearToken::from_near(6)).await
    }

    async fn mint(&self, token: &AccountId, to: &AccountId, amount: u128) {
        let args = json!({ "account_id": to, "amount": amount.to_string() });
        self.chain.ok_with(&self.operator, token, "mint", args, REGISTRATION).await;
    }

    async fn balance(&self, token: &AccountId, of: &AccountId) -> u128 {
        str_u128(&self.chain.view::<Value>(token, "ft_balance_of", json!({ "account_id": of })).await)
    }

    /// The client sends `amount` of `token` to its account with `msg`.
    async fn send(&self, token: &AccountId, amount: u128, msg: &str) -> ExecutionFinalResult {
        let args = json!({ "receiver_id": self.account, "amount": amount.to_string(), "msg": msg });
        self.chain.call(&self.client, token, "ft_transfer_call", args, one_yocto()).await
    }

    async fn state(&self) -> Value {
        self.chain.view(&self.account, "get_state", json!({})).await
    }

    async fn debt(&self) -> u128 {
        str_u128(&self.chain.view::<Value>(&self.pool, "debt_of", json!({ "account_id": self.account })).await)
    }

    /// The pending OutLayer request from the account whose input has this intent.
    async fn pending(&self, intent: &Value) -> Option<Value> {
        let pending: Vec<Value> = self.chain.view(&self.outlayer, "pending_requests", json!({})).await;
        pending.into_iter().find(|r| {
            let input: Value = serde_json::from_str(r["input_data"].as_str().unwrap_or("null")).unwrap_or_default();
            r["caller"] == json!(self.account) && input["intent"] == *intent
        })
    }

    /// Asks for a check of `intent` and answers it with `make(request, height)`, the canned verdict. Returns the
    /// pending request and `on_verdict`'s outcome.
    async fn check(&self, intent: Value, make: impl FnOnce(u64) -> Value) -> (Value, Value) {
        let (request, outcome, _) = self.check_logged(intent, make).await;
        (request, outcome)
    }

    /// As `check`, and also returns the transaction, for its logs.
    async fn check_logged(
        &self,
        intent: Value,
        make: impl FnOnce(u64) -> Value,
    ) -> (Value, Value, ExecutionFinalResult) {
        let deposit = NearToken::from_millinear(10);
        let args = json!({ "intent": intent });
        let call = self.chain.call_in_background(&self.client, &self.account, "request_check", args, deposit);
        let mut request = None;
        for _ in 0..80 {
            request = self.pending(&intent).await;
            if request.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let request = request.expect("the check never reached OutLayer");
        let answer = make(self.chain.height().await);
        let resolve = json!({ "request_id": request["request_id"], "output": answer });
        self.chain.ok(&self.operator, &self.outlayer, "resolve_execution", resolve).await;
        let result = call.await.unwrap();
        assert_ok(&result, "request_check");
        let outcome = result.clone().json::<Value>().unwrap();
        (request, outcome, result)
    }

    /// The account's owner calls `method` on it with 1 yoctoNEAR.
    async fn owner_call(&self, method: &str, args: Value) -> ExecutionFinalResult {
        self.chain.call(&self.client, &self.account, method, args, one_yocto()).await
    }

    async fn hl(&self) -> Value {
        self.state().await["hl"].clone()
    }

    /// The owner asks `account` for the gateway's agent, and the test answers the run with `answer(request_id)`,
    /// which resolves it on the OutLayer mock. Returns the pending request and `on_agent`'s outcome.
    async fn request_agent(&self, account: &AccountId, answer: impl AsyncFnOnce(u64)) -> (Value, Value) {
        let deposit = NearToken::from_millinear(10);
        let call = self.chain.call_in_background(&self.client, account, "request_agent", json!({}), deposit);
        let mut request = None;
        for _ in 0..80 {
            let pending: Vec<Value> = self.chain.view(&self.outlayer, "pending_requests", json!({})).await;
            request = pending.into_iter().find(|r| {
                let input: Value = serde_json::from_str(r["input_data"].as_str().unwrap_or("null")).unwrap_or_default();
                r["caller"] == json!(account) && input["mode"] == "agent_address"
            });
            if request.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let request = request.expect("the agent request never reached OutLayer");
        answer(request["request_id"].as_u64().unwrap()).await;
        let result = call.await.unwrap();
        assert_ok(&result, "request_agent");
        (request, result.json::<Value>().unwrap())
    }

    /// The owner calls `method` (`hl_approve_agent` or `hl_withdraw`) in the background, and the test waits for its
    /// `sign` request to reach the MPC mock. Returns the request and the call.
    async fn start_signing(
        &self,
        method: &'static str,
        args: Value,
    ) -> (Value, tokio::task::JoinHandle<ExecutionFinalResult>) {
        let call = self.chain.call_in_background(&self.client, &self.account, method, args, one_yocto());
        for _ in 0..80 {
            let pending: Vec<Value> = self.chain.view(&self.mpc, "pending_requests", json!({})).await;
            if let Some(p) = pending.into_iter().find(|p| p["signer_id"] == json!(self.account)) {
                return (p["request"].clone(), call);
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        panic!("the {method} signature never reached the MPC mock");
    }

    /// The MPC mock answers `request` with `answer`, the real signer's format.
    async fn sign(&self, request: &Value, answer: &Value) {
        let args = json!({ "signer_id": self.account, "request": request, "response": answer });
        self.chain.ok(&self.operator, &self.mpc, "respond", args).await;
    }
}

/// Two of the signer's real answers from Phase 0 (research/data/day1_mpc_probe.json runs 5 and 10). In both, big_r's
/// prefix disagrees with recovery_id, so v must come from recovery_id.
fn signer_answer(run: u8) -> Value {
    let (big_r, s, recovery_id) = match run {
        5 => (
            "03c108d226eef8ea52e8c49dd4ffe260add49c1478f8305122e2cee5f755b6df22",
            "680ca8be54a7349ca45980f38c0c76ef37406385b782c1d895e8ac5e257a0785",
            0,
        ),
        _ => (
            "02808c355953d28d9a7cad50e58eaa331fcd4ea75fe176d78535d1548513b75c38",
            "2e1c6182bb7a1d0a6213cb7c2a14f023bcb8b1c22409597e5b07721be2b5927d",
            1,
        ),
    };
    json!({ "scheme": "Secp256k1", "big_r": { "affine_point": big_r }, "s": { "scalar": s }, "recovery_id": recovery_id })
}

/// The `hl_signed` event for `entry`, as the account logs it.
fn hl_signed_event(account: &AccountId, entry: &Value) -> String {
    let data = json!([{ "account": account, "index": entry["index"], "kind": entry["kind"], "nonce": entry["nonce"] }]);
    format!(r#"EVENT_JSON:{{"standard":"pb-pool","version":"1.0.0","event":"hl_signed","data":{data}}}"#)
}

fn config(musdc: &AccountId, mnbtc: &AccountId, pool: &AccountId, outlayer: &AccountId, root: &AccountId) -> Value {
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
    })
}

/// A HEALTHY Standard verdict for `account` at block `blk` with counter `nonce`, allowing a $2,000 borrow.
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

fn borrow(amount: u128) -> Value {
    json!({ "borrow": { "amount": amount.to_string() } })
}

#[tokio::test]
async fn the_full_flow_deposit_check_borrow_repay_withdraw() {
    let w = World::new().await;

    // The factory made the account with its config, registered it with the pool and on both tokens.
    let config: Value = w.chain.view(&w.account, "get_config", json!({})).await;
    assert_eq!(config["params_hash"], PARAMS);
    assert_eq!(w.state().await["owner"], json!(w.client));
    let borrower: Value = w.chain.view(&w.pool, "get_borrower", json!({ "account_id": w.account })).await;
    assert!(!borrower.is_null(), "the pool doesn't know the account");
    for token in [&w.musdc, &w.mnbtc] {
        let storage: Value = w.chain.view(token, "storage_balance_of", json!({ "account_id": w.account })).await;
        assert!(!storage.is_null(), "{token} doesn't know the account");
    }
    let account_for: Value = w.chain.view(&w.factory, "account_for", json!({ "name": "alice" })).await;
    assert_eq!(account_for, json!(w.account));

    // The client deposits $1,000 of mUSDC and 0.5 mNBTC.
    w.mint(&w.musdc, &w.client, usd(1_000)).await;
    w.mint(&w.mnbtc, &w.client, BTC / 2).await;
    assert_ok(&w.send(&w.musdc, usd(1_000), "").await, "the mUSDC deposit");
    assert_ok(&w.send(&w.mnbtc, BTC / 2, r#"{"pb":{"deposit":{}}}"#).await, "the mNBTC deposit");
    assert_eq!(w.balance(&w.musdc, &w.account).await, usd(1_000));
    assert_eq!(w.balance(&w.mnbtc, &w.account).await, BTC / 2);

    // A borrow check runs the pinned program on this account and intent, and the verdict is kept.
    let (request, outcome) = w.check(borrow(usd(1_500)), |height| verdict(&w.account, 0, height)).await;
    assert_eq!(outcome, json!({ "accepted": true, "reason": null }));
    let source = json!({ "Project": { "project_id": "pbf-keeper.testnet/pb-risk", "version_key": VERSION } });
    assert_eq!(request["source"], source);
    assert_eq!(request["payer_account_id"], json!(w.client));
    let input: Value = serde_json::from_str(request["input_data"].as_str().unwrap()).unwrap();
    assert_eq!(input["mode"], "check");
    assert_eq!(input["account"], json!(w.account));
    let state = w.state().await;
    assert_eq!(state["verdict"]["intent"], borrow(usd(1_500)));
    assert_eq!(state["hourly"].as_array().unwrap().len(), 1);

    // The owner borrows $1,500: the pool lends it, and the loan arrives and is booked.
    let borrowed = w.owner_call("borrow", json!({ "amount": usd(1_500).to_string() })).await;
    assert_ok(&borrowed, "borrow");
    assert!(has_event(&borrowed, "borrow"), "the pool logged no loan: {borrowed:?}");
    assert_eq!(w.balance(&w.musdc, &w.account).await, usd(2_500));
    let state = w.state().await;
    assert_eq!(state["loan"], json!({ "principal": usd(1_500).to_string(), "open": true }));
    // The counter moved on as the borrow started, and again once the loan had arrived.
    assert_eq!((state["counter"].clone(), state["pending"].clone()), (json!(2), json!([])));
    assert!(w.debt().await >= usd(1_500));

    // The same verdict can't back a second borrow.
    let again = w.owner_call("borrow", json!({ "amount": usd(100).to_string() })).await;
    assert_refused(&again, "the verdict was already used");

    // With the loan out, a withdrawal without a fresh verdict is refused.
    let args = json!({ "token": w.mnbtc, "amount": (BTC / 2).to_string(), "receiver": w.client });
    assert_refused(&w.owner_call("withdraw", args.clone()).await, "the verdict was already used");

    // Repaying a little more than the debt clears it; the pool sends the rest back.
    let repaid = w.owner_call("repay", json!({ "amount": usd(1_501).to_string() })).await;
    assert_ok(&repaid, "repay");
    assert_eq!(w.debt().await, 0);
    assert_eq!(w.state().await["loan"], json!({ "principal": "0", "open": false }));
    let left = w.balance(&w.musdc, &w.account).await;
    assert!(left >= usd(999) && left <= usd(1_000), "{left} mUSDC left after repaying");

    // With no loan, withdrawals need no verdict.
    assert_ok(&w.owner_call("withdraw", args).await, "the mNBTC withdrawal");
    assert_eq!(w.balance(&w.mnbtc, &w.client).await, BTC / 2);
    let args = json!({ "token": w.musdc, "amount": left.to_string(), "receiver": w.client });
    assert_ok(&w.owner_call("withdraw", args).await, "the mUSDC withdrawal");
    assert_eq!(w.balance(&w.musdc, &w.account).await, 0);
    // Each withdrawal moves it on twice too: as it starts, and once its tokens have gone.
    assert_eq!(w.state().await["counter"], json!(6));
}

#[tokio::test]
async fn old_reused_foreign_and_wrong_program_verdicts_are_refused() {
    let w = World::new().await;
    w.mint(&w.mnbtc, &w.client, BTC).await;
    assert_ok(&w.send(&w.mnbtc, BTC, "").await, "the mNBTC deposit");
    let amount = json!({ "amount": usd(500).to_string() });

    // A verdict from another program: another parameter file, or another model. Nothing is kept.
    let (_, outcome) = w
        .check(borrow(usd(500)), |height| {
            let mut v = verdict(&w.account, 0, height);
            v["params"] = json!("00".repeat(32));
            v
        })
        .await;
    assert_eq!(outcome["accepted"], false);
    assert!(outcome["reason"].as_str().unwrap().contains("is not this account's parameter file"), "{outcome}");
    let (_, outcome) = w
        .check(borrow(usd(501)), |height| {
            let mut v = verdict(&w.account, 0, height);
            v["model"] = json!("B-9.9");
            v
        })
        .await;
    assert!(outcome["reason"].as_str().unwrap().contains("model B-9.9 is not this account's model"), "{outcome}");

    // A verdict for another account.
    let bob: AccountId = format!("bob.{}", w.factory).parse().unwrap();
    let (_, outcome) = w.check(borrow(usd(502)), |height| verdict(&bob, 0, height)).await;
    assert!(outcome["reason"].as_str().unwrap().contains("is not this account"), "{outcome}");
    assert!(w.state().await["verdict"].is_null(), "a refused verdict was kept");
    assert_refused(&w.owner_call("borrow", amount.clone()).await, "no verdict: ask for a check first");

    // A good verdict that is more than 120 blocks old by the time the owner borrows.
    let (_, outcome) = w.check(borrow(usd(500)), |height| verdict(&w.account, 0, height)).await;
    assert_eq!(outcome["accepted"], true);
    w.chain.fast_forward(130).await;
    assert_refused(&w.owner_call("borrow", amount.clone()).await, "above the 120-block limit");

    // A fresh one works once, and only once.
    let (_, outcome) = w.check(borrow(usd(500)), |height| verdict(&w.account, 0, height)).await;
    assert_eq!(outcome["accepted"], true);
    assert_ok(&w.owner_call("borrow", amount.clone()).await, "borrow");
    assert_refused(&w.owner_call("borrow", amount).await, "the verdict was already used");
    // A verdict that still carries the old counter is refused on arrival.
    let (_, outcome) = w.check(borrow(usd(503)), |height| verdict(&w.account, 0, height)).await;
    assert!(outcome["reason"].as_str().unwrap().contains("nonce 0 is not the counter 2"), "{outcome}");

    // With the loan out, a withdrawal needs a verdict for exactly that withdrawal, which the engine allows by
    // answering with `allow.withdraw` equal to the amount (0 if it refuses).
    let withdraw = json!({ "token": w.mnbtc, "amount": (BTC / 10).to_string(), "receiver": w.client });
    assert_refused(&w.owner_call("withdraw", withdraw.clone()).await, "the verdict was already used");
    let intent = json!({ "withdraw": { "token": w.mnbtc, "amount": (BTC / 10).to_string() } });
    let account = &w.account;
    let answer = |allowed: u128| {
        move |height| {
            let mut v = verdict(account, 2, height);
            v["allow"]["withdraw"] = json!(allowed);
            v
        }
    };
    let (_, outcome) = w.check(intent.clone(), answer(0)).await;
    assert_eq!(outcome["accepted"], true);
    assert_refused(&w.owner_call("withdraw", withdraw.clone()).await, "the verdict doesn't allow this withdrawal");
    let (_, outcome) = w.check(intent, answer(BTC / 10)).await;
    assert_eq!(outcome["accepted"], true);
    assert_ok(&w.owner_call("withdraw", withdraw).await, "the withdrawal with its verdict");
    assert_eq!(w.balance(&w.mnbtc, &w.client).await, BTC / 10);
}

/// research/audit.md, A1: a check that read the account while money was on its way carries the counter of that moment,
/// and the account has moved it on since, so the verdict is refused.
#[tokio::test]
async fn verdicts_read_while_a_loan_or_a_withdrawal_was_on_its_way_back_nothing() {
    let w = World::new().await;
    w.with_loan().await;
    let usdc = w.balance(&w.musdc, &w.account).await;
    let account = &w.account;
    let allowing = |nonce: u64, amount: u128| {
        move |height| {
            let mut v = verdict(account, nonce, height);
            v["allow"]["withdraw"] = json!(amount);
            v
        }
    };
    // Read after the borrow started but before the pool lent, the engine saw no loan and allowed any withdrawal.
    let all_usdc = json!({ "withdraw": { "token": w.musdc, "amount": usdc.to_string() } });
    let (_, outcome) = w.check(all_usdc, allowing(1, usdc)).await;
    assert!(outcome["reason"].as_str().unwrap().contains("nonce 1 is not the counter 2"), "{outcome}");
    let args = json!({ "token": w.musdc, "amount": usdc.to_string(), "receiver": w.client });
    assert_refused(&w.owner_call("withdraw", args).await, "the verdict was already used");
    assert_eq!(w.balance(&w.musdc, &w.account).await, usdc);

    // A withdrawal with its verdict moves the counter on as it starts and once the tokens have gone.
    let tenth = json!({ "withdraw": { "token": w.mnbtc, "amount": (BTC / 10).to_string() } });
    let (_, outcome) = w.check(tenth.clone(), allowing(2, BTC / 10)).await;
    assert_eq!(outcome["accepted"], true, "{outcome}");
    let args = json!({ "token": w.mnbtc, "amount": (BTC / 10).to_string(), "receiver": w.client });
    assert_ok(&w.owner_call("withdraw", args).await, "the withdrawal with its verdict");
    assert_eq!(w.counter().await, 4);
    // A check that read the account before the token moved still counted that 0.1 mNBTC: refused.
    let (_, outcome) = w.check(tenth, allowing(3, BTC / 10)).await;
    assert!(outcome["reason"].as_str().unwrap().contains("nonce 3 is not the counter 4"), "{outcome}");
    assert_eq!(w.balance(&w.mnbtc, &w.client).await, BTC / 10);
}

#[tokio::test]
async fn with_no_loan_withdrawals_need_no_verdict_and_unlisted_tokens_bounce() {
    let w = World::new().await;
    w.mint(&w.mnbtc, &w.client, BTC).await;
    assert_ok(&w.send(&w.mnbtc, BTC, "").await, "the mNBTC deposit");

    // No check has ever run, and the owner takes the deposit back.
    let args = json!({ "token": w.mnbtc, "amount": BTC.to_string(), "receiver": w.client });
    assert_ok(&w.owner_call("withdraw", args).await, "the withdrawal");
    assert_eq!(w.balance(&w.mnbtc, &w.client).await, BTC);
    assert!(w.state().await["verdict"].is_null());

    // Only the owner withdraws.
    let operator_try = json!({ "token": w.mnbtc, "amount": "1", "receiver": w.operator });
    let refused = w.chain.call(&w.operator, &w.account, "withdraw", operator_try, one_yocto()).await;
    assert_refused(&refused, "only the owner can do this");

    // A token that isn't on the allow-list comes back to the sender in full.
    let token = wasm("pb_testnet_token");
    let init = json!({ "name": "Other", "symbol": "OTH", "decimals": 6 });
    let other = w.chain.contract("other", 10, token, Some(("new", init))).await;
    w.mint(&other, &w.client, 1_000).await;
    let args = json!({ "account_id": w.account, "registration_only": true });
    w.chain.ok_with(&w.client, &other, "storage_deposit", args, REGISTRATION).await;
    let sent = w.send(&other, 1_000, "").await;
    assert_ok(&sent, "the transfer of an unlisted token");
    assert_eq!(w.balance(&other, &w.account).await, 0);
    assert_eq!(w.balance(&other, &w.client).await, 1_000);

    // So does a loan message that doesn't come from the pool.
    w.mint(&w.musdc, &w.client, 1_000).await;
    assert_ok(&w.send(&w.musdc, 1_000, r#"{"pb":{"loan":{}}}"#).await, "the fake loan");
    assert_eq!(w.balance(&w.musdc, &w.client).await, 1_000);
    assert_eq!(w.state().await["loan"]["open"], false);
}

#[tokio::test]
async fn the_factory_refunds_a_failed_creation_and_only_the_operator_runs_it() {
    let w = World::new().await;
    let listed: Vec<Value> = w.chain.view(&w.factory, "list_accounts", json!({})).await;
    assert_eq!(listed.len(), 1);
    assert_eq!((listed[0]["account_id"].clone(), listed[0]["owner"].clone()), (json!(w.account), json!(w.client)));
    assert!(str_u128(&listed[0]["created_at"]) > 0);

    // "alice" exists already, so creating it again fails and the client gets the 6 NEAR back.
    let before = w.chain.balance(&w.client).await;
    let again = w.create("alice").await;
    assert!(!again.clone().json::<bool>().unwrap(), "{again:?}");
    // Gas refunds from earlier transactions can land meanwhile, so the balance may even rise.
    let spent = before as i128 - w.chain.balance(&w.client).await as i128;
    let limit = NearToken::from_millinear(100).as_yoctonear() as i128;
    assert!(spent < limit, "the failed creation kept {spent} yoctoNEAR");
    assert!(again.logs().iter().any(|l| l.contains("could not create")), "{again:?}");
    // A failed creation isn't listed.
    assert_eq!(w.chain.view::<u32>(&w.factory, "accounts_count", json!({})).await, 1);

    // Only the operator pauses the factory, and a paused factory creates nothing.
    let refused = w.chain.call(&w.client, &w.factory, "set_paused", json!({ "paused": true }), yocto(0)).await;
    assert_refused(&refused, "only the operator can do this");
    w.chain.ok(&w.operator, &w.factory, "set_paused", json!({ "paused": true })).await;
    assert_refused(&w.create("bob").await, "the factory is paused");
    w.chain.ok(&w.operator, &w.factory, "set_paused", json!({ "paused": false })).await;

    // A new config applies to accounts created afterwards; the existing one keeps its own.
    let mut config: Value = w.chain.view(&w.factory, "get_config", json!({})).await;
    config["model"] = json!("B-0.3");
    let refused = w.chain.call(&w.client, &w.factory, "set_config", json!({ "config": config }), yocto(0)).await;
    assert_refused(&refused, "only the operator can do this");
    w.chain.ok(&w.operator, &w.factory, "set_config", json!({ "config": config })).await;
    let created = w.create("bob").await;
    assert!(created.clone().json::<bool>().unwrap(), "{created:?}");
    let bob: AccountId = format!("bob.{}", w.factory).parse().unwrap();
    let bob_config: Value = w.chain.view(&bob, "get_config", json!({})).await;
    assert_eq!(bob_config["model"], "B-0.3");
    let alice_config: Value = w.chain.view(&w.account, "get_config", json!({})).await;
    assert_eq!(alice_config["model"], "B-0.2");
    // Both accounts are listed, oldest first, in pages.
    assert_eq!(w.chain.view::<u32>(&w.factory, "accounts_count", json!({})).await, 2);
    let page: Vec<Value> = w.chain.view(&w.factory, "list_accounts", json!({ "from_index": 1, "limit": 1 })).await;
    assert_eq!(page.len(), 1);
    assert_eq!(page[0]["account_id"], json!(bob));

    // The factory publishes the hash of the code it deploys.
    let hash: String = w.chain.view(&w.factory, "account_code_hash", json!({})).await;
    assert_eq!(hash.len(), 64);
}

/// The derived address of the MPC mock's fixed key: the real one of `client1.pb.testnet` (PLAN.md 5.2).
const HL_ADDRESS: &str = "0xd7f35513286b7a0c2a7d8648c72588751ce0dd7c";
const AGENT: &str = "0x6ecdc34d53c1dc5ab647718a2e0f949643b2017c";
/// The stand-in's Hyperliquid float (INTERFACES.md 1).
const FLOAT: &str = "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d";
const DAY_MS: u64 = 86_400_000;

#[tokio::test]
async fn hl_init_request_agent_and_approve_agent_through_the_signer() {
    let w = World::new().await;
    let empty = json!({
        "path": "hyperliquid-1", "address": null, "agent": null, "next_nonce_ms": "0", "send_open_until_ms": "0",
        "open_sends": [], "send_floor_until_ms": "0", "signed": [],
    });
    assert_eq!(w.hl().await, empty);

    // Nothing can be signed before the address is known.
    assert_refused(&w.owner_call("hl_approve_agent", json!({})).await, "no Hyperliquid address yet");
    let withdraw = json!({ "amount": "1000000", "destination": FLOAT });
    assert_refused(&w.owner_call("hl_withdraw", withdraw).await, "no Hyperliquid address yet");

    // Anyone can derive the address, once.
    let init = w.chain.call(&w.operator, &w.account, "hl_init", json!({}), yocto(0)).await;
    assert_ok(&init, "hl_init");
    assert_eq!(init.json::<Value>().unwrap(), json!(HL_ADDRESS));
    assert_eq!(w.hl().await["address"], HL_ADDRESS);
    let again = w.chain.call(&w.client, &w.account, "hl_init", json!({}), yocto(0)).await;
    assert_eq!(again.clone().json::<Value>().unwrap(), json!(HL_ADDRESS));
    assert!(again.logs().is_empty(), "hl_init called the signer again: {again:?}");

    // The agent comes only from the owner's own gateway run, for this account.
    assert_refused(&w.owner_call("hl_approve_agent", json!({})).await, "no agent yet: call request_agent first");
    let deposit = NearToken::from_millinear(10);
    let refused = w.chain.call(&w.operator, &w.account, "request_agent", json!({}), deposit).await;
    assert_refused(&refused, "only the owner can do this");
    let refused = w.chain.call(&w.client, &w.account, "request_agent", json!({}), NearToken::from_millinear(9)).await;
    assert_refused(&refused, "attach at least 0.01 NEAR for OutLayer");
    let bob: AccountId = format!("bob.{}", w.factory).parse().unwrap();
    let (request, outcome) = w
        .request_agent(&w.account, async |id| {
            let output = json!({ "ok": true, "acct": bob, "agent": AGENT });
            let args = json!({ "request_id": id, "output": output });
            w.chain.ok(&w.operator, &w.outlayer, "resolve_execution", args).await;
        })
        .await;
    let source =
        json!({ "Project": { "project_id": "pbf-keeper.testnet/pb-gateway", "version_key": GATEWAY_VERSION } });
    assert_eq!(request["source"], source);
    assert_eq!(request["payer_account_id"], json!(w.client));
    // The factory's config names no secrets reference, so none goes.
    assert_eq!(request["secrets_ref"], Value::Null);
    let input: Value = serde_json::from_str(request["input_data"].as_str().unwrap()).unwrap();
    assert_eq!(input, json!({ "mode": "agent_address", "account": w.account, "network": "testnet" }));
    assert_eq!(outcome["accepted"], false);
    assert!(outcome["reason"].as_str().unwrap().contains("is not this account"), "{outcome}");
    assert!(w.hl().await["agent"].is_null(), "an agent for another account was kept");
    let (_, outcome) = w
        .request_agent(&w.account, async |id| {
            let args = json!({ "request_id": id, "agent": AGENT.to_uppercase().replace("0X", "0x") });
            w.chain.ok(&w.operator, &w.outlayer, "resolve_agent", args).await;
        })
        .await;
    assert_eq!(outcome, json!({ "accepted": true, "reason": null }));
    let agent = w.hl().await["agent"].clone();
    assert_eq!(agent["address"], AGENT);
    assert!(agent["received_block"].as_u64().unwrap() > 0);

    // Only the owner approves, with 1 yoctoNEAR.
    let refused = w.chain.call(&w.operator, &w.account, "hl_approve_agent", json!({}), one_yocto()).await;
    assert_refused(&refused, "only the owner can do this");
    let refused = w.chain.call(&w.client, &w.account, "hl_approve_agent", json!({}), yocto(0)).await;
    assert_refused(&refused, "Requires attached deposit of exactly 1 yoctoNEAR");

    // The signer gets the approveAgent digest under hyperliquid-1, and its answer comes back as {r, s, v}.
    let (request, call) = w.start_signing("hl_approve_agent", json!({})).await;
    assert_eq!((request["path"].clone(), request["domain_id"].clone()), (json!("hyperliquid-1"), json!(0)));
    let digest = request["payload_v2"]["Ecdsa"].as_str().unwrap();
    assert!(digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()), "{digest}");
    w.sign(&request, &signer_answer(5)).await;
    let signed = call.await.unwrap();
    assert_ok(&signed, "hl_approve_agent");
    let entry: Value = signed.clone().json().unwrap();
    let nonce = entry["nonce"].as_u64().unwrap();
    assert_eq!((entry["index"].clone(), entry["kind"].clone()), (json!(0), json!("approveAgent")));
    let signature = json!({
        "r": "0xc108d226eef8ea52e8c49dd4ffe260add49c1478f8305122e2cee5f755b6df22",
        "s": "0x680ca8be54a7349ca45980f38c0c76ef37406385b782c1d895e8ac5e257a0785",
        "v": 27,
    });
    assert_eq!(entry["signature"], signature);
    let action: Value = serde_json::from_str(entry["action"].as_str().unwrap()).unwrap();
    let expected = json!({
        "type": "approveAgent", "hyperliquidChain": "Testnet", "signatureChainId": "0x66eee", "agentAddress": AGENT,
        "agentName": format!("pb valid_until {}", nonce + 180 * DAY_MS), "nonce": nonce,
    });
    assert_eq!(action, expected);
    assert!(signed.logs().contains(&hl_signed_event(&w.account, &entry).as_str()), "{signed:?}");
    let hl = w.hl().await;
    assert_eq!(hl["signed"], json!([entry]));
    assert_eq!(hl["next_nonce_ms"], json!((nonce + 1).to_string()));

    // A signature that times out stores nothing; the next one takes a new nonce.
    let (_, call) = w.start_signing("hl_approve_agent", json!({})).await;
    w.chain.fast_forward(210).await;
    let timed_out = call.await.unwrap();
    assert_eq!(timed_out.clone().json::<Value>().unwrap(), Value::Null);
    assert!(timed_out.logs().contains(&"nothing signed: the MPC signer failed or timed out"), "{timed_out:?}");
    let hl = w.hl().await;
    assert_eq!(hl["signed"].as_array().unwrap().len(), 1);
    assert!(str_u128(&hl["next_nonce_ms"]) > u128::from(nonce + 1));

    // An account made while no gateway version is pinned can't ask for an agent.
    let mut config: Value = w.chain.view(&w.factory, "get_config", json!({})).await;
    config["gateway"]["version_key"] = json!("");
    w.chain.ok(&w.operator, &w.factory, "set_config", json!({ "config": config })).await;
    assert!(w.create("bob").await.json::<bool>().unwrap());
    let refused = w.chain.call(&w.client, &bob, "request_agent", json!({}), deposit).await;
    assert_refused(&refused, "no pb-gateway version is pinned in this account's config");

    // A secrets reference in the config goes to OutLayer with the agent request, as it is.
    let secrets = json!({ "profile": "pb-gateway", "account_id": "pbf-keeper.testnet" });
    config["gateway"]["version_key"] = json!(GATEWAY_VERSION);
    config["gateway"]["secrets_ref"] = secrets.clone();
    w.chain.ok(&w.operator, &w.factory, "set_config", json!({ "config": config })).await;
    assert!(w.create("carol").await.json::<bool>().unwrap());
    let carol: AccountId = format!("carol.{}", w.factory).parse().unwrap();
    let (request, outcome) = w
        .request_agent(&carol, async |id| {
            let args = json!({ "request_id": id, "agent": AGENT });
            w.chain.ok(&w.operator, &w.outlayer, "resolve_agent", args).await;
        })
        .await;
    assert_eq!(request["secrets_ref"], secrets);
    assert_eq!(outcome["accepted"], true, "{outcome}");
}

#[tokio::test]
async fn hl_withdraw_needs_no_loan_and_holds_back_borrowing_while_its_send_can_land() {
    let w = World::new().await;
    assert_ok(&w.chain.call(&w.client, &w.account, "hl_init", json!({}), yocto(0)).await, "hl_init");

    // The refusals: not the owner, not a 0x address, nothing to send, a balance that is neither perps nor spot.
    let args = json!({ "amount": "9500000000", "destination": FLOAT });
    let refused = w.chain.call(&w.operator, &w.account, "hl_withdraw", args, one_yocto()).await;
    assert_refused(&refused, "only the owner can do this");
    let args = json!({ "amount": "9500000000", "destination": "alice.testnet" });
    assert_refused(&w.owner_call("hl_withdraw", args).await, "destination must be 0x and 40 hex digits");
    let args = json!({ "amount": "0", "destination": FLOAT });
    assert_refused(&w.owner_call("hl_withdraw", args).await, "amount must be positive");
    let args = json!({ "amount": "1000000", "destination": FLOAT, "source_dex": "perp" });
    assert_refused(&w.owner_call("hl_withdraw", args).await, "source_dex must be");

    // With a loan open, nothing leaves Hyperliquid.
    w.mint(&w.musdc, &w.client, usd(10)).await;
    assert_ok(&w.send(&w.musdc, usd(10), "").await, "the mUSDC deposit");
    w.mint(&w.mnbtc, &w.client, BTC).await;
    assert_ok(&w.send(&w.mnbtc, BTC, "").await, "the mNBTC deposit");
    let (_, outcome) = w.check(borrow(usd(500)), |height| verdict(&w.account, 0, height)).await;
    assert_eq!(outcome["accepted"], true, "{outcome}");
    assert_ok(&w.owner_call("borrow", json!({ "amount": usd(500).to_string() })).await, "borrow");
    let args = json!({ "amount": "1000000", "destination": FLOAT });
    assert_refused(&w.owner_call("hl_withdraw", args).await, "no Hyperliquid withdrawal while a loan is open");
    // Repaying a little more than the debt clears the loan.
    assert_ok(&w.owner_call("repay", json!({ "amount": usd(501).to_string() })).await, "repay");
    assert_eq!(w.state().await["loan"]["open"], false);

    // With no loan, the signer signs sendAsset of $9,500 from the perp balance to the float.
    let args = json!({ "amount": "9500000000", "destination": FLOAT.to_uppercase().replace("0X", "0x") });
    let (request, call) = w.start_signing("hl_withdraw", args).await;
    w.sign(&request, &signer_answer(10)).await;
    let signed = call.await.unwrap();
    assert_ok(&signed, "hl_withdraw");
    let entry: Value = signed.clone().json().unwrap();
    let nonce = entry["nonce"].as_u64().unwrap();
    assert_eq!((entry["index"].clone(), entry["kind"].clone()), (json!(0), json!("sendAsset")));
    // big_r starts with 02 here, but recovery_id is 1: v is 28.
    assert_eq!(entry["signature"]["v"], 28);
    let expected = format!(
        r#"{{"type":"sendAsset","hyperliquidChain":"Testnet","signatureChainId":"0x66eee","destination":"{FLOAT}","sourceDex":"","destinationDex":"","token":"{HL_USDC}","amount":"9500","fromSubAccount":"","nonce":{nonce}}}"#
    );
    assert_eq!(entry["action"], json!(expected));
    assert!(signed.logs().contains(&hl_signed_event(&w.account, &entry).as_str()), "{signed:?}");

    // And $1.2345 from the spot balance.
    let args = json!({ "amount": "1234500", "destination": FLOAT, "source_dex": "spot" });
    let (request, call) = w.start_signing("hl_withdraw", args).await;
    w.sign(&request, &signer_answer(5)).await;
    let signed = call.await.unwrap();
    assert_ok(&signed, "hl_withdraw from spot");
    let spot: Value = signed.clone().json().unwrap();
    assert_eq!(spot["index"], 1);
    let action: Value = serde_json::from_str(spot["action"].as_str().unwrap()).unwrap();
    let dexes = (action["sourceDex"].clone(), action["destinationDex"].clone(), action["amount"].clone());
    assert_eq!(dexes, (json!("spot"), json!(""), json!("1.2345")));

    // Until the newest send can no longer be posted, a borrow is refused, even with a fresh verdict.
    let until = spot["nonce"].as_u64().unwrap() + 2 * DAY_MS + 3_600_000;
    assert_eq!(w.hl().await["send_open_until_ms"], json!(until.to_string()));
    let counter = w.state().await["counter"].as_u64().unwrap();
    let (_, outcome) = w.check(borrow(usd(100)), |height| verdict(&w.account, counter, height)).await;
    assert_eq!(outcome["accepted"], true, "{outcome}");
    let refused = w.owner_call("borrow", json!({ "amount": usd(100).to_string() })).await;
    assert_refused(&refused, &format!("({until} ms): a signed Hyperliquid sendAsset can still be posted until then"));
    // A withdrawal with no loan needs no verdict, so it still goes out.
    let args = json!({ "token": w.mnbtc, "amount": BTC.to_string(), "receiver": w.client });
    assert_ok(&w.owner_call("withdraw", args).await, "the mNBTC withdrawal");
    assert_eq!(w.balance(&w.mnbtc, &w.client).await, BTC);
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 4: the stored plan, execute_step and 1Click transfers (INTERFACES.md 13 and 14)
// ---------------------------------------------------------------------------------------------------------------

const MINUTE_MS: u64 = 60_000;

impl World {
    /// The latest block's time, in ms.
    async fn now_ms(&self) -> u64 {
        let block = near_api::Chain::block().fetch_from(&self.chain.network).await.expect("no block");
        block.header.timestamp_nanosec.parse::<u64>().unwrap() / 1_000_000
    }

    /// Fast-forwards until the block time is at least `ms`. A fast-forwarded block moves the clock by about 0.3 s on
    /// the default node and about 10 s on the slow clock's, so a first short step measures it.
    async fn wait_until_ms(&self, ms: u64) {
        let mut per_block: Option<u64> = None;
        loop {
            let now = self.now_ms().await;
            if now >= ms {
                return;
            }
            let blocks = per_block.map_or(10, |p| ((ms - now) / p + 1).min(2_000));
            self.chain.fast_forward(blocks).await;
            per_block = Some(((self.now_ms().await - now) / blocks).max(1));
        }
    }

    /// Deposits $1,000 of mUSDC and 0.5 mNBTC, and borrows $1,500 with a HEALTHY verdict. The counter is then 2.
    async fn with_loan(&self) {
        self.mint(&self.musdc, &self.client, usd(1_000)).await;
        self.mint(&self.mnbtc, &self.client, BTC / 2).await;
        assert_ok(&self.send(&self.musdc, usd(1_000), "").await, "the mUSDC deposit");
        assert_ok(&self.send(&self.mnbtc, BTC / 2, "").await, "the mNBTC deposit");
        let (_, outcome) = self.check(borrow(usd(1_500)), |height| verdict(&self.account, 0, height)).await;
        assert_eq!(outcome["accepted"], true, "{outcome}");
        assert_ok(&self.owner_call("borrow", json!({ "amount": usd(1_500).to_string() })).await, "borrow");
    }

    /// A check answered with `v(height)`, which must be accepted. Returns the transaction.
    async fn accepted(&self, v: impl FnOnce(u64) -> Value) -> ExecutionFinalResult {
        let (_, outcome, result) = self.check_logged(json!({ "check": {} }), v).await;
        assert_eq!(outcome, json!({ "accepted": true, "reason": null }));
        result
    }

    async fn counter(&self) -> u64 {
        self.state().await["counter"].as_u64().unwrap()
    }

    async fn pid(&self) -> String {
        self.state().await["plan"]["pid"].as_str().expect("no plan is stored").to_string()
    }

    /// `caller` runs step `i` of plan `pid`, with no deposit.
    async fn run_step(&self, caller: &AccountId, pid: &str, i: u32) -> ExecutionFinalResult {
        self.chain.call(caller, &self.account, "execute_step", json!({ "pid": pid, "i": i }), yocto(0)).await
    }

    /// The transfers under way.
    async fn transfers(&self) -> Vec<Value> {
        let pending = self.state().await["pending"].as_array().unwrap().clone();
        pending.into_iter().filter_map(|p| p.get("transfer").cloned()).collect()
    }

    /// `from`, playing 1Click, pays `amount` of `token` to the account with the msg for transfer `id`. It gets the
    /// tokens from the faucet first.
    async fn pay_back(&self, from: &AccountId, token: &AccountId, amount: u128, id: &str) -> ExecutionFinalResult {
        self.mint(token, from, amount).await;
        let msg = json!({ "pb": { "transfer": id } }).to_string();
        let args = json!({ "receiver_id": self.account, "amount": amount.to_string(), "msg": msg });
        let result = self.chain.call(from, token, "ft_transfer_call", args, one_yocto()).await;
        assert_ok(&result, "the 1Click payment");
        result
    }
}

/// The data of the `name` events a transaction logged.
fn events(result: &ExecutionFinalResult, name: &str) -> Vec<Value> {
    let logs = result.logs();
    let events = logs.iter().filter_map(|log| log.strip_prefix("EVENT_JSON:"));
    let parsed = events.map(|text| serde_json::from_str::<Value>(text).unwrap());
    parsed.filter(|e| e["event"] == name).map(|e| e["data"].clone()).collect()
}

/// `v` with this action, state, Hyperliquid margin ratio and plan.
fn planned(mut v: Value, state: &str, action: &str, ratio_bp: u64, plan: Value) -> Value {
    v["state"] = json!(state);
    v["action"] = json!(action);
    v["venues"]["hl_margin_ratio_bp"] = json!(ratio_bp);
    v["plan"] = plan;
    v
}

/// The drill's plan (INTERFACES.md 13): buy back part of the short through the gateway, then repay $1,000.
fn drill_plan() -> Value {
    json!([
        { "k": "perp", "coin": "BTC", "buy": true, "sz": "0.00375", "px": "76190" },
        { "k": "repay", "amt": usd(1_000) },
    ])
}

#[tokio::test]
async fn the_drill_path_two_deleverage_checks_store_the_plan_and_anyone_runs_its_repay() {
    let w = World::new().await;
    w.with_loan().await;
    let account = w.account.clone();
    let deleverage = |height| planned(verdict(&account, 2, height), "DELEVERAGE", "DELEVERAGE", 3_000, drill_plan());

    // The first DELEVERAGE verdict stores no plan: one bad price can't start an unwind.
    let _ = w.accepted(deleverage).await;
    let state = w.state().await;
    assert!(state["plan"].is_null());
    let first_at = str_u128(&state["deleverage"]["first_at"]) as u64 / 1_000_000;
    assert!(first_at > 0);

    // The second, 2.5 minutes later, confirms it: its plan is stored, with its blk as the plan's id.
    w.wait_until_ms(first_at + 150_000).await;
    let result = w.accepted(deleverage).await;
    let state = w.state().await;
    let blk = state["verdict"]["verdict"]["blk"].as_u64().unwrap();
    let pid = w.pid().await;
    assert_eq!(pid, blk.to_string());
    let waited = str_u128(&state["deleverage"]["first_at"]) as u64 / 1_000_000 - first_at;
    assert!((120_000..=300_000).contains(&waited), "the checks were {waited} ms apart");
    assert_eq!(
        events(&result, "plan_stored"),
        vec![json!({ "pid": pid, "action": "DELEVERAGE", "steps": ["perp", "repay"] })]
    );
    let mut steps = drill_plan();
    for step in steps.as_array_mut().unwrap() {
        step["done"] = json!(false);
    }
    assert_eq!(state["plan"]["steps"], steps);

    // The gateway places the buy-back; execute_step refuses it.
    let refused = w.run_step(&w.operator, &pid, 0).await;
    assert_refused(&refused, "step 0 is a perp step: the gateway places this one");

    // Anyone runs the repay, with no check_step: $1,000 of the account's $2,500 goes to the pool.
    let debt = w.debt().await;
    let repaid = w.run_step(&w.operator, &pid, 1).await;
    assert_ok(&repaid, "the repay step");
    assert_eq!(repaid.clone().json::<Value>().unwrap(), json!(usd(1_000).to_string()));
    assert_eq!(events(&repaid, "step_run"), vec![json!({ "pid": pid, "i": 1, "k": "repay" })]);
    assert!(events(&repaid, "step").is_empty(), "the repay asked the pool's check_step");
    assert!(has_event(&repaid, "repay"), "the pool logged no repayment: {repaid:?}");
    assert!(w.debt().await <= debt - usd(1_000) + 10);
    assert_eq!(w.balance(&w.musdc, &w.account).await, usd(1_500));
    let state = w.state().await;
    assert_eq!((state["plan"]["steps"][1]["done"].clone(), state["counter"].clone()), (json!(true), json!(2)));
    assert_refused(&w.run_step(&w.client, &pid, 1).await, "has already run");

    // A HEALTHY verdict with nothing to do clears the plan.
    let _ = w.accepted(|height| verdict(&account, 2, height)).await;
    assert!(w.state().await["plan"].is_null());
}

#[tokio::test]
async fn a_rebalance_runs_end_to_end_through_the_pools_check_step_and_1click() {
    let w = World::new().await;
    w.with_loan().await;
    // The pool counts mNBTC steps at $80,000 a coin, above market, toward the account's $50k a day.
    let price = json!({ "token": w.mnbtc, "decimals": 8, "price": usd(80_000).to_string() });
    w.chain.ok(&w.operator, &w.pool, "set_step_price", price).await;
    // Sandbox accounts play the quotes' deposit addresses and the solver that pays back.
    let dep_sell = w.chain.account("depsell", 5).await;
    let dep_hl = w.chain.account("dephl", 5).await;
    let solver = w.chain.account("solver", 5).await;

    // A REBALANCE verdict: sell 0.01 mNBTC for USDC, and move $500 of USDC to Hyperliquid. It is stored at once.
    let exp = w.now_ms().await + 10 * MINUTE_MS;
    let plan = json!([
        { "k": "sell", "tok": w.mnbtc, "amt": (BTC / 100).to_string(), "min": usd(750), "dep": dep_sell, "exp": exp },
        { "k": "to_hl", "amt": usd(500).to_string(), "dep": dep_hl, "exp": exp },
    ]);
    let account = w.account.clone();
    let result = w.accepted(|height| planned(verdict(&account, 2, height), "HEALTHY", "REBALANCE", 6_500, plan)).await;
    let pid = w.pid().await;
    assert_eq!(
        events(&result, "plan_stored"),
        vec![json!({ "pid": pid, "action": "REBALANCE", "steps": ["sell", "to_hl"] })]
    );

    // Each step asks the pool's check_step, then sends its token to the deposit address and records its transfer.
    let sold = w.run_step(&w.operator, &pid, 0).await;
    assert_ok(&sold, "the sell step");
    let step = events(&sold, "step");
    assert_eq!(step.len(), 1, "{sold:?}");
    assert_eq!((step[0]["plan_id"].clone(), step[0]["step"].clone()), (json!(pid), json!(0)));
    assert_eq!(step[0]["value"], usd(800).to_string());
    assert_eq!(w.balance(&w.mnbtc, &dep_sell).await, BTC / 100);
    let moved = w.run_step(&w.operator, &pid, 1).await;
    assert_ok(&moved, "the to_hl step");
    assert_eq!(events(&moved, "step")[0]["total_24h"], usd(1_300).to_string());
    assert_eq!(w.balance(&w.musdc, &dep_hl).await, usd(500));
    assert_eq!(w.balance(&w.musdc, &w.account).await, usd(2_000));
    let deadline = ((exp + 30 * MINUTE_MS) * 1_000_000).to_string();
    let expected = json!([
        { "id": format!("{pid}:0"), "kind": "sell", "token": w.mnbtc, "amount": (BTC / 100).to_string(), "dep": dep_sell, "deadline": deadline },
        { "id": format!("{pid}:1"), "kind": "to_hl", "token": w.musdc, "amount": usd(500).to_string(), "dep": dep_hl, "deadline": deadline },
    ]);
    assert_eq!(Value::Array(w.transfers().await), expected);
    let state = w.state().await;
    assert_eq!(state["counter"], json!(6), "each step that sends moves the counter on as it starts and once sent");
    let borrower: Value = w.chain.view(&w.pool, "get_borrower", json!({ "account_id": w.account })).await;
    assert_eq!(borrower["steps_24h"], usd(1_300).to_string());

    // The sale's USDC arrives with its msg: kept, and the sale is done.
    let paid = w.pay_back(&solver, &w.musdc, usd(790), &format!("{pid}:0")).await;
    assert_eq!(events(&paid, "transfer_done"), vec![json!({ "id": format!("{pid}:0"), "how": "arrived" })]);
    assert_eq!(w.balance(&w.musdc, &w.account).await, usd(2_790));
    // pb-risk sees the move on Hyperliquid and lists it in `arrived`. That verdict is HEALTHY with nothing to do, so
    // it also clears the plan.
    let id = format!("{pid}:1");
    let result = w
        .accepted(|height| {
            let mut v = verdict(&account, 6, height);
            v["arrived"] = json!([id]);
            v
        })
        .await;
    assert_eq!(events(&result, "transfer_done"), vec![json!({ "id": format!("{pid}:1"), "how": "verdict" })]);
    assert!(w.transfers().await.is_empty());
    assert!(w.state().await["plan"].is_null());
}

#[tokio::test]
async fn refunds_late_arrivals_and_a_default_keep_the_records_right() {
    // A transfer is overdue 30 minutes after its quote expires: the slow clock's node gets there in about 200 blocks.
    let w = World::on(Chain::start_with_slow_clock().await).await;
    w.mint(&w.musdc, &w.client, usd(1_000)).await;
    w.mint(&w.mnbtc, &w.client, BTC / 2).await;
    assert_ok(&w.send(&w.musdc, usd(1_000), "").await, "the mUSDC deposit");
    assert_ok(&w.send(&w.mnbtc, BTC / 2, "").await, "the mNBTC deposit");
    let dep_hl = w.chain.account("dephl", 5).await;
    let dep_sell = w.chain.account("depsell", 5).await;
    let solver = w.chain.account("solver", 5).await;

    // The owner moves $100 to Hyperliquid through 1Click (move:0), and 1Click refunds it with the msg.
    let exp = w.now_ms().await + 10 * MINUTE_MS;
    let to_hl = json!({ "token": w.musdc, "amount": usd(100).to_string(), "receiver": dep_hl, "transfer": { "kind": "to_hl", "exp": exp } });
    assert_ok(&w.owner_call("withdraw", to_hl).await, "the move to Hyperliquid");
    assert_eq!(w.transfers().await[0]["id"], "move:0");
    assert_eq!(w.state().await["next_move"], json!(1));
    let refund =
        json!({ "receiver_id": w.account, "amount": usd(100).to_string(), "msg": r#"{"pb":{"transfer":"move:0"}}"# });
    let refunded = w.chain.call(&dep_hl, &w.musdc, "ft_transfer_call", refund, one_yocto()).await;
    assert_ok(&refunded, "the refund");
    assert_eq!(events(&refunded, "transfer_done"), vec![json!({ "id": "move:0", "how": "refunded" })]);
    assert_eq!(w.balance(&w.musdc, &w.account).await, usd(1_000));
    assert!(w.transfers().await.is_empty());

    // The owner sells 0.01 mNBTC through 1Click (move:1), and the USDC comes late.
    let exp = w.now_ms().await + 30_000;
    let sell = json!({ "token": w.mnbtc, "amount": (BTC / 100).to_string(), "receiver": dep_sell, "transfer": { "kind": "sell", "exp": exp } });
    assert_ok(&w.owner_call("withdraw", sell).await, "the sale");
    let deadline_ms = exp + 30 * MINUTE_MS;
    assert_eq!(w.transfers().await[0]["deadline"], json!((deadline_ms * 1_000_000).to_string()));
    w.wait_until_ms(deadline_ms + 5_000).await;
    // Overdue: a borrow is refused, even with a fresh verdict.
    let counter = w.counter().await;
    let (_, outcome) = w.check(borrow(usd(500)), |height| verdict(&w.account, counter, height)).await;
    assert_eq!(outcome["accepted"], true, "{outcome}");
    let amount = json!({ "amount": usd(500).to_string() });
    assert_refused(&w.owner_call("borrow", amount.clone()).await, "no borrow while transfer move:1 is overdue");
    // The late USDC arrives with its msg, and borrowing works again.
    let paid = w.pay_back(&solver, &w.musdc, usd(790), "move:1").await;
    assert_eq!(events(&paid, "transfer_done"), vec![json!({ "id": "move:1", "how": "arrived" })]);
    let (_, outcome) = w.check(borrow(usd(500)), |height| verdict(&w.account, counter, height)).await;
    assert_eq!(outcome["accepted"], true, "{outcome}");
    assert_ok(&w.owner_call("borrow", amount).await, "the borrow after the late arrival");
    assert!(w.debt().await >= usd(500));

    // DEFAULT, said twice 2.5 minutes apart: the account blocks itself and has the pool write off its debt.
    let counter = w.counter().await;
    let first = w.accepted(|height| defaulted(&w.account, counter, height)).await;
    assert!(!has_event(&first, "write_off"), "one DEFAULT verdict wrote the debt off: {first:?}");
    w.wait_until_ms(w.now_ms().await + 150_000).await;
    let result = w.accepted(|height| defaulted(&w.account, counter, height)).await;
    assert!(has_event(&result, "write_off"), "the pool wrote nothing off: {result:?}");
    assert_eq!(w.debt().await, 0);
    let pool: Value = w.chain.view(&w.pool, "get_pool", json!({})).await;
    assert!(str_u128(&pool["written_off"]) >= usd(500));
    let borrower: Value = w.chain.view(&w.pool, "get_borrower", json!({ "account_id": w.account })).await;
    assert_eq!(borrower["blocked"], true);
    assert_eq!(w.state().await["blocked"], true);
    let blocked = "this account is blocked after a default";
    assert_refused(&w.owner_call("borrow", json!({ "amount": "1" })).await, blocked);
    let out = json!({ "token": w.mnbtc, "amount": "1", "receiver": w.client });
    assert_refused(&w.owner_call("withdraw", out).await, blocked);
}

/// A DEFAULT verdict for `account` at block `blk` with counter `nonce`.
fn defaulted(account: &AccountId, nonce: u64, blk: u64) -> Value {
    let mut v = verdict(account, nonce, blk);
    v["state"] = json!("DEFAULT");
    v
}

/// research/audit.md, A2.
#[tokio::test]
async fn a_default_needs_two_checks_and_its_block_lifts_after_the_pools_review() {
    // The two checks are 2 to 5 minutes apart: the slow clock's node gets there in about 15 blocks.
    let w = World::on(Chain::start_with_slow_clock().await).await;
    w.with_loan().await;
    let debt = w.debt().await;
    // One DEFAULT verdict changes nothing.
    let counter = w.counter().await;
    let first = w.accepted(|height| defaulted(&w.account, counter, height)).await;
    assert!(!has_event(&first, "write_off"), "one DEFAULT verdict wrote the debt off: {first:?}");
    assert_eq!(w.state().await["blocked"], false);
    assert!(w.debt().await >= debt);
    // 2.5 minutes later a second one confirms it: the account blocks itself, and the pool writes the debt off.
    w.wait_until_ms(w.now_ms().await + 150_000).await;
    let second = w.accepted(|height| defaulted(&w.account, counter, height)).await;
    assert!(has_event(&second, "write_off"), "the pool wrote nothing off: {second:?}");
    assert_eq!((w.debt().await, w.state().await["blocked"].clone()), (0, json!(true)));
    let borrower: Value = w.chain.view(&w.pool, "get_borrower", json!({ "account_id": w.account })).await;
    assert_eq!(borrower["blocked"], true);

    // Repaying still runs. The pool is owed nothing now, so it sends the money back.
    let usdc = w.balance(&w.musdc, &w.account).await;
    assert_ok(
        &w.owner_call("repay", json!({ "amount": usd(100).to_string() })).await,
        "a repayment after the write-off",
    );
    assert_eq!(w.balance(&w.musdc, &w.account).await, usdc);

    // The account's block stays while the pool's does. Anyone may ask: the pool's answer decides.
    let keeper = w.chain.account("keeper", 5).await;
    let kept = w.chain.call(&keeper, &w.account, "lift_block", json!({}), yocto(0)).await;
    assert_ok(&kept, "lift_block");
    assert!(!kept.clone().json::<bool>().unwrap());
    assert!(kept.logs().iter().any(|l| l.contains("the block stays: the pool still blocks it")), "{kept:?}");
    // After review, the operator lifts the pool's block, and then the account's lifts too.
    w.chain.ok(&w.operator, &w.pool, "unblock", json!({ "account_id": w.account })).await;
    let lifted = w.chain.call(&keeper, &w.account, "lift_block", json!({}), yocto(0)).await;
    assert_ok(&lifted, "lift_block");
    assert!(lifted.json::<bool>().unwrap());
    let state = w.state().await;
    assert_eq!(
        (state["blocked"].clone(), state["loan"].clone()),
        (json!(false), json!({ "principal": "0", "open": false }))
    );
    // Owing nothing, the owner withdraws with no verdict.
    let out = json!({ "token": w.mnbtc, "amount": (BTC / 2).to_string(), "receiver": w.client });
    assert_ok(&w.owner_call("withdraw", out).await, "the withdrawal once the block has lifted");
    assert_eq!(w.balance(&w.mnbtc, &w.client).await, BTC / 2);
}

#[tokio::test]
async fn a_deleverage_plans_home_step_is_signed_by_the_mpc_mock_and_its_usdc_arrives_by_msg() {
    let w = World::new().await;
    assert_ok(&w.chain.call(&w.client, &w.account, "hl_init", json!({}), yocto(0)).await, "hl_init");
    w.with_loan().await;
    let solver = w.chain.account("solver", 5).await;

    // At an 80% Hyperliquid margin ratio, one DELEVERAGE verdict is enough. Its plan brings $20 home.
    let exp = w.now_ms().await + 10 * MINUTE_MS;
    let plan = json!([{ "k": "home", "amt": usd(20), "dep": FLOAT, "exp": exp }]);
    let account = w.account.clone();
    let _ = w.accepted(|height| planned(verdict(&account, 2, height), "DELEVERAGE", "DELEVERAGE", 8_500, plan)).await;
    let pid = w.pid().await;

    // The step asks the pool, then the MPC signer signs the sendAsset to dep from the perp balance.
    let args = json!({ "pid": pid, "i": 0 });
    let call = w.chain.call_in_background(&w.operator, &w.account, "execute_step", args, yocto(0));
    let mut request = None;
    for _ in 0..240 {
        let pending: Vec<Value> = w.chain.view(&w.mpc, "pending_requests", json!({})).await;
        request = pending.into_iter().find(|p| p["signer_id"] == json!(w.account)).map(|p| p["request"].clone());
        if request.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let request = request.expect("the home step's signature never reached the MPC mock");
    w.sign(&request, &signer_answer(5)).await;
    let signed = call.await.unwrap();
    assert_ok(&signed, "the home step");
    assert!(has_event(&signed, "step") && has_event(&signed, "hl_signed"), "{signed:?}");
    let entry: Value = signed.clone().json().unwrap();
    let action: Value = serde_json::from_str(entry["action"].as_str().unwrap()).unwrap();
    let sent =
        (action["type"].clone(), action["destination"].clone(), action["sourceDex"].clone(), action["amount"].clone());
    assert_eq!(sent, (json!("sendAsset"), json!(FLOAT), json!(""), json!("20")));
    let nonce = entry["nonce"].as_u64().unwrap();
    assert_eq!(w.hl().await["send_open_until_ms"], json!((nonce + 2 * DAY_MS + 3_600_000).to_string()));
    let transfers = w.transfers().await;
    assert_eq!(transfers.len(), 1);
    let home = (
        transfers[0]["id"].clone(),
        transfers[0]["kind"].clone(),
        transfers[0]["token"].clone(),
        transfers[0]["dep"].clone(),
    );
    assert_eq!(home, (json!(format!("{pid}:0")), json!("home"), json!("USDC"), json!(FLOAT)));

    // The backend posts it, and 1Click pays the account with the msg.
    let paid = w.pay_back(&solver, &w.musdc, usd(20) - 200_000, &format!("{pid}:0")).await;
    assert_eq!(events(&paid, "transfer_done"), vec![json!({ "id": format!("{pid}:0"), "how": "arrived" })]);
    assert!(w.transfers().await.is_empty());
}

#[tokio::test]
async fn a_failed_transfer_is_forgotten_once_overdue_and_money_that_comes_later_is_kept() {
    // 1Click fails this move: nothing comes back, and no msg arrives. The slow clock reaches its deadline fast.
    let w = World::on(Chain::start_with_slow_clock().await).await;
    w.mint(&w.musdc, &w.client, usd(1_000)).await;
    w.mint(&w.mnbtc, &w.client, BTC / 2).await;
    assert_ok(&w.send(&w.musdc, usd(1_000), "").await, "the mUSDC deposit");
    assert_ok(&w.send(&w.mnbtc, BTC / 2, "").await, "the mNBTC deposit");
    let dep_hl = w.chain.account("dephl", 5).await;
    let solver = w.chain.account("solver", 5).await;
    let exp = w.now_ms().await + 30_000;
    let to_hl = json!({ "token": w.musdc, "amount": usd(100).to_string(), "receiver": dep_hl, "transfer": { "kind": "to_hl", "exp": exp } });
    assert_ok(&w.owner_call("withdraw", to_hl).await, "the move to Hyperliquid");
    let forget = json!({ "id": "move:0" });
    assert_refused(&w.owner_call("forget_transfer", forget.clone()).await, "transfer move:0 isn't overdue yet");

    // Overdue: borrowing is held back.
    w.wait_until_ms(exp + 30 * MINUTE_MS + 5_000).await;
    let counter = w.counter().await;
    let (_, outcome) = w.check(borrow(usd(500)), |height| verdict(&w.account, counter, height)).await;
    assert_eq!(outcome["accepted"], true, "{outcome}");
    let amount = json!({ "amount": usd(500).to_string() });
    assert_refused(&w.owner_call("borrow", amount.clone()).await, "no borrow while transfer move:0 is overdue");

    // Only the owner forgets it.
    let refused = w.chain.call(&w.operator, &w.account, "forget_transfer", forget.clone(), one_yocto()).await;
    assert_refused(&refused, "only the owner can do this");
    let forgotten = w.owner_call("forget_transfer", forget).await;
    assert_ok(&forgotten, "forget_transfer");
    assert_eq!(events(&forgotten, "transfer_done"), vec![json!({ "id": "move:0", "how": "forgotten" })]);
    assert!(w.transfers().await.is_empty());

    // Borrowing works again: money in transit already counted as 0.
    let (_, outcome) = w.check(borrow(usd(500)), |height| verdict(&w.account, counter, height)).await;
    assert_eq!(outcome["accepted"], true, "{outcome}");
    assert_ok(&w.owner_call("borrow", amount).await, "the borrow after forgetting");

    // The money arrives after all, and is kept as a deposit.
    let before = w.balance(&w.musdc, &w.account).await;
    let paid = w.pay_back(&solver, &w.musdc, usd(100), "move:0").await;
    assert!(events(&paid, "transfer_done").is_empty());
    assert!(paid.logs().iter().any(|l| l.contains("no transfer move:0 is under way: kept as a deposit")), "{paid:?}");
    assert_eq!(w.balance(&w.musdc, &w.account).await, before + usd(100));
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 6: funding from lenders (INTERFACES.md 25)
// ---------------------------------------------------------------------------------------------------------------

fn fund(amount: u128) -> Value {
    json!({ "fund": { "amount": amount.to_string() } })
}

/// A HEALTHY verdict for `account` and counter `nonce` that answers a `fund` with these steps.
fn fund_verdict(account: &AccountId, nonce: u64, steps: Value) -> impl FnOnce(u64) -> Value + '_ {
    move |height| {
        let mut v = verdict(account, nonce, height);
        // What the steps borrow in all.
        let borrows = |s: &&Value| s["k"] == "p_borrow" || s["k"] == "l_borrow";
        let lent: u64 = steps.as_array().into_iter().flatten().filter(borrows).filter_map(|s| s["amt"].as_u64()).sum();
        v["allow"]["fund"] = json!(lent);
        v["fund"] = steps;
        v["ext"] = json!([{ "l": "rhea", "c": 0, "d": 0, "hf_bp": 0, "r_bp": 1_591, "s_bp": 1_032, "room": 0, "liq_bp": 7_600 }]);
        v
    }
}

#[tokio::test]
async fn an_account_opened_with_a_permission_funds_a_loan_through_fund_and_the_pool_step() {
    let w = World::new().await;
    // alice was opened the old way, with no permission.
    let state = w.state().await;
    assert_eq!((state["permission"].clone(), state["funding"].clone()), (Value::Null, Value::Null));

    // The operator gives new accounts a lender: a stand-in for Rhea that takes mNBTC.
    let mut config: Value = w.chain.view(&w.factory, "get_config", json!({})).await;
    assert_eq!(config["lenders"], json!({ "rhea": null, "aave": null }));
    let rhea = format!("rhea.{}", w.chain.root);
    config["lenders"] = json!({ "rhea": { "contract_id": rhea, "collateral": [w.mnbtc] }, "aave": null });
    w.chain.ok(&w.operator, &w.factory, "set_config", json!({ "config": config })).await;

    // A permission the config can't back is refused before anything is created, and one it can opens the account
    // with it: opening and permitting are one signature.
    let terms = |lenders: Value| json!({ "lenders": lenders, "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any" });
    let args = json!({ "name": "bob", "owner": w.client, "permission": terms(json!(["aave"])) });
    let refused = w.chain.call(&w.client, &w.factory, "create_account", args, NearToken::from_near(6)).await;
    assert_refused(&refused, "the permission names aave, which this account has no settings for");
    let args = json!({ "name": "bob", "owner": w.client, "permission": terms(json!(["rhea"])) });
    let made = w.chain.call(&w.client, &w.factory, "create_account", args, NearToken::from_near(6)).await;
    assert_ok(&made, "create_account with a permission");
    assert!(made.clone().json::<bool>().unwrap(), "create_account reported a failed step: {made:?}");
    let bob: AccountId = format!("bob.{}", w.factory).parse().unwrap();
    let w = World { account: bob.clone(), ..w };
    assert_eq!(w.state().await["permission"], terms(json!(["rhea"])));
    assert_eq!(w.chain.view::<Value>(&bob, "get_config", json!({})).await, config);

    // bob deposits, and asks for $1,500 in all. The engine answers with the pool alone.
    w.mint(&w.musdc, &w.client, usd(1_000)).await;
    w.mint(&w.mnbtc, &w.client, BTC / 2).await;
    assert_ok(&w.send(&w.musdc, usd(1_000), "").await, "the mUSDC deposit");
    assert_ok(&w.send(&w.mnbtc, BTC / 2, "").await, "the mNBTC deposit");
    let steps = json!([{ "k": "p_borrow", "amt": usd(1_500) as u64 }]);
    let (request, outcome) = w.check(fund(usd(1_500)), fund_verdict(&bob, 0, steps)).await;
    assert_eq!(outcome, json!({ "accepted": true, "reason": null }));
    let input: Value = serde_json::from_str(request["input_data"].as_str().unwrap()).unwrap();
    assert_eq!(input["intent"], fund(usd(1_500)));

    // Only the owner stores the plan, for the amount the verdict answers. It moves no money.
    let amount = json!({ "amount": usd(1_500).to_string() });
    let by_stranger = w.chain.call(&w.operator, &bob, "fund", amount.clone(), one_yocto()).await;
    assert_refused(&by_stranger, "only the owner can do this");
    let other = w.owner_call("fund", json!({ "amount": usd(1_499).to_string() })).await;
    assert_refused(&other, "the verdict doesn't answer fund for this amount");
    let stored = w.owner_call("fund", amount.clone()).await;
    assert_ok(&stored, "fund");
    let view = stored.clone().json::<Value>().unwrap();
    let pid = view["pid"].as_str().unwrap().to_string();
    assert!(pid.strip_prefix('f').is_some_and(|blk| blk.parse::<u64>().is_ok()), "{pid} is not f and a block");
    let logged = json!({ "pid": pid, "amount": usd(1_500).to_string(), "steps": ["p_borrow"] });
    assert_eq!(events(&stored, "funding_stored"), vec![logged]);
    assert_eq!(view["steps"], json!([{ "k": "p_borrow", "amt": usd(1_500) as u64, "done": false }]));
    let state = w.state().await;
    assert_eq!((state["funding"].clone(), state["counter"].clone()), (view, json!(1)));
    assert_eq!((w.debt().await, w.balance(&w.musdc, &bob).await), (0, usd(1_000)));
    assert_refused(&w.owner_call("fund", amount).await, "still has steps to run");

    // The fund verdict is spent, so the pool's step waits for a fresh one. Then anyone runs it.
    assert_refused(&w.run_step(&w.operator, &pid, 0).await, "the verdict was already used");
    let fresh = w.accepted(|height| verdict(&bob, 1, height)).await;
    assert!(!has_event(&fresh, "plan_stored"));
    assert_eq!(w.state().await["funding"]["pid"], json!(pid), "a HEALTHY verdict cleared the funding plan");
    let ran = w.run_step(&w.operator, &pid, 0).await;
    assert_ok(&ran, "the pool step");
    assert_eq!(events(&ran, "step_run"), vec![json!({ "pid": pid, "i": 0, "k": "p_borrow" })]);
    assert_eq!(ran.clone().json::<bool>().unwrap(), true, "the whole loan didn't arrive");
    assert!(w.debt().await >= usd(1_500));
    assert_eq!(w.balance(&w.musdc, &bob).await, usd(2_500));
    let state = w.state().await;
    // The counter moved on as the borrow started and again as it ended.
    assert_eq!((state["counter"].clone(), state["pending"].clone()), (json!(3), json!([])));
    assert_eq!(state["loan"], json!({ "principal": usd(1_500).to_string(), "open": true }));
    assert_eq!(state["funding"]["steps"][0]["done"], true);
    assert_refused(&w.run_step(&w.operator, &pid, 0).await, "has already run");

    // A second plan, with Rhea's steps first: stored, in order, and not run yet.
    let steps = json!([
        { "k": "l_supply", "l": "rhea", "tok": w.mnbtc, "amt": (BTC / 10).to_string() },
        { "k": "l_borrow", "l": "rhea", "amt": usd(300) as u64 },
        { "k": "p_borrow", "amt": usd(200) as u64 },
    ]);
    let (_, outcome) = w.check(fund(usd(500)), fund_verdict(&bob, 3, steps)).await;
    assert_eq!(outcome["accepted"], true, "{outcome}");
    let stored = w.owner_call("fund", json!({ "amount": usd(500).to_string() })).await;
    assert_ok(&stored, "the second fund");
    let second = stored.json::<Value>().unwrap()["pid"].as_str().unwrap().to_string();
    assert_ne!(second, pid);
    assert_refused(&w.run_step(&w.operator, &pid, 0).await, "is not the stored funding plan");
    // The account owes the pool and `fund` spent the verdict: posting collateral waits for a fresh one.
    let waits = w.run_step(&w.operator, &second, 0).await;
    assert_refused(&waits, "the verdict was already used: ask for a new check");
    assert_refused(&w.run_step(&w.operator, &second, 2).await, "must wait: step 0 hasn't run yet");

    // The owner cancels the permission under the stored plan: its lender step is refused for that from now on.
    // The counter stays where it was (research/audit.md, A8), and the account notes the block the permission changed.
    let opened_at = w.state().await["permission_blk"].as_u64().expect("no permission_blk in the state");
    let cancelled = w.owner_call("set_permission", json!({ "permission": null })).await;
    assert_ok(&cancelled, "set_permission");
    assert_eq!(events(&cancelled, "permission_set"), vec![json!({ "permission": null })]);
    let state = w.state().await;
    assert_eq!((state["permission"].clone(), state["counter"].clone()), (Value::Null, json!(4)));
    assert!(state["permission_blk"].as_u64().unwrap() > opened_at && opened_at > 0);
    let refused = w.run_step(&w.operator, &second, 0).await;
    assert_refused(&refused, "step 0 names rhea, which the owner's permission doesn't name");

    // The owner drops the plan. Nothing more was lent, and mNBTC never left.
    let dropped = w.owner_call("cancel_funding", json!({})).await;
    assert_ok(&dropped, "cancel_funding");
    assert_eq!(events(&dropped, "funding_cancelled"), vec![json!({ "pid": second })]);
    assert_eq!(w.state().await["funding"], Value::Null);
    assert_eq!((w.balance(&w.musdc, &bob).await, w.balance(&w.mnbtc, &bob).await), (usd(2_500), BTC / 2));
    assert_refused(&w.run_step(&w.operator, &second, 0).await, "no funding plan is stored");
}
