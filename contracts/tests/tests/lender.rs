//! The account contract, the pool and Rhea's own contract file together in the sandbox, before any of it goes to
//! testnet (FUNDING.md 4.3, 4.4, 4.6, 4.7 and 5.2; INTERFACES.md 25 and 26).
//!
//! The world is `tests/account.rs`'s, with our copy of Rhea beside it (`common/rhea.rs`): the factory, the real pool,
//! both test tokens and the OutLayer mock. The copy charges what mainnet charged on 10 Nov, the pool's source order is
//! `lender_first`, and the factory's config names the copy as `lenders.rhea`. The test plays the engine: it answers
//! each check with a verdict whose `ext` line is read from Rhea's own views, the way `pb-read` reads them.
//!
//! - A loan from Rhea and from our pool, step by step: `l_supply`, `l_borrow`, the 20 blocks of waiting, `p_borrow`.
//! - Pricing: a margin books a fee, also on a loan repaid before the next settlement; a cap books a subsidy, which
//!   ends as credit that `claim_credit` pays.
//! - A borrow Rhea refuses, and a top-up after bitcoin falls: `l_add`, then `l_repay`.
//! - Leaving: Rhea repaid, what was left there brought back, the collateral out, the pool repaid, everything
//!   withdrawn.
//!
//! Run with `--nocapture` to see the gas each call burnt and what a new account's storage locks.
mod common;

use std::time::Duration;

use common::rhea::*;
use common::*;
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::{AccountId, NearToken};
use serde_json::{json, Value};

const REGISTRATION: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const PARAMS: &str = "4f0e2f3c8b9a1d7e6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605";
const VERSION: &str = "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12";
const GATEWAY_VERSION: &str = "cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34";
const HL_USDC: &str = "USDC:0xeb62eee3685fc4c43992febcd9e75443";
/// BTC's fixed price on the copy when a test starts, in dollars.
const BTC_USD: u128 = 75_000;
const YEAR_NS: u128 = 365 * DAY_NS as u128;
/// What a client attaches to open an account: the factory's minimum.
const OPENING: NearToken = NearToken::from_near(6);
/// One NEAR, and the NEAR one byte of storage locks, in yoctoNEAR.
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const BYTE: u128 = 10_000_000_000_000_000_000;

/// A sandbox with both test tokens, our copy of Rhea charging mainnet's rate, a funded pool, the OutLayer mock, the
/// factory, and a client whose account was opened with a permission for Rhea.
struct World {
    chain: Chain,
    musdc: AccountId,
    mnbtc: AccountId,
    pool: AccountId,
    outlayer: AccountId,
    factory: AccountId,
    operator: AccountId,
    client: AccountId,
    account: AccountId,
    rhea: Rhea,
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

        // Our copy of Rhea, owned by the operator, with $1,000,000 to lend. The operator then borrows 85.15% of it
        // back, so the copy charges mainnet's 15.91% and has $148,500 left for clients.
        let rhea = Rhea::stand_up(&chain, &operator, &musdc, &mnbtc, BTC_USD, usd(1_000_000)).await;
        rhea.charge_mainnets_rate(&chain).await;

        // The pool lends mUSDC to accounts the factory registers. The operator funds it with $100,000, and has the
        // engine try a lender before the pool.
        let factory: AccountId = format!("factory.{}", chain.root).parse().unwrap();
        let init = json!({ "operator": operator, "factory": factory, "token": musdc });
        let pool = chain.contract("pool", 20, wasm("pb_pool"), Some(("new", init))).await;
        let args = json!({ "account_id": pool, "registration_only": true });
        chain.ok_with(&operator, &musdc, "storage_deposit", args, REGISTRATION).await;
        mint(&chain, &musdc, &operator, usd(100_000)).await;
        let fund = json!({ "receiver_id": pool, "amount": usd(100_000).to_string(), "msg": r#"{"pool":"fund"}"# });
        chain.ok_with(&operator, &musdc, "ft_transfer_call", fund, one_yocto()).await;
        let order = json!({ "funding": { "order": "lender_first", "loan_days": 90 } });
        chain.ok(&operator, &pool, "set_funding", order).await;
        // What a plan step in mNBTC counts at toward the pool's $50,000 a day: $75,000 a coin. A top-up at Rhea asks
        // the pool's `check_step` first (research/audit.md, A17), and the pool refuses a token with no step price.
        let price = json!({ "token": mnbtc, "decimals": 8, "price": usd(BTC_USD).to_string() });
        chain.ok(&operator, &pool, "set_step_price", price).await;

        // The factory, whose config names the copy as Rhea, taking mNBTC. Its code locks 7.04 NEAR.
        let config = config(&musdc, &mnbtc, &pool, &outlayer, &rhea.id, &chain.root);
        let init = json!({ "operator": operator, "config": config });
        let deployed = chain.contract("factory", 8, wasm("pb_factory"), Some(("new", init))).await;
        assert_eq!(deployed, factory);
        let account: AccountId = format!("alice.{factory}").parse().unwrap();
        let w = World { chain, musdc, mnbtc, pool, outlayer, factory, operator, client, account, rhea };

        // The client opens its account and permits Rhea in the same call.
        let args = json!({ "name": "alice", "owner": w.client, "permission": terms() });
        let made = w.chain.call(&w.client, &w.factory, "create_account", args, OPENING).await;
        assert_ok(&made, "create_account");
        assert!(made.clone().json::<bool>().unwrap(), "create_account reported a failed step: {made:?}");
        w
    }

    /// The client gets `amount` of `token` from the faucet and deposits it in its account.
    async fn deposit(&self, token: &AccountId, amount: u128) {
        mint(&self.chain, token, &self.client, amount).await;
        let args = json!({ "receiver_id": self.account, "amount": amount.to_string(), "msg": "" });
        self.chain.ok_with(&self.client, token, "ft_transfer_call", args, one_yocto()).await;
    }

    async fn balance(&self, token: &AccountId) -> u128 {
        token_balance(&self.chain, token, &self.account).await
    }

    async fn state(&self) -> Value {
        self.chain.view(&self.account, "get_state", json!({})).await
    }

    async fn counter(&self) -> u64 {
        self.state().await["counter"].as_u64().unwrap()
    }

    /// The stored top-up plan's id.
    async fn pid(&self) -> String {
        self.state().await["plan"]["pid"].as_str().expect("no plan is stored").to_string()
    }

    /// The lender action under way, as `get_state().pending` lists it.
    async fn lender_action(&self) -> Option<Value> {
        self.state().await["pending"].as_array().unwrap().iter().find_map(|p| p.get("lender").cloned())
    }

    /// What the account owes our pool, by the pool's own figure.
    async fn pool_debt(&self) -> u128 {
        str_u128(&self.chain.view::<Value>(&self.pool, "debt_of", json!({ "account_id": self.account })).await)
    }

    /// The pool's pricing record of the account.
    async fn pricing(&self) -> Value {
        self.chain.view(&self.pool, "get_pricing", json!({ "account_id": self.account })).await
    }

    /// What Rhea shows for the account. Null before it registers.
    async fn at_rhea(&self) -> Value {
        self.rhea.account(&self.chain, &self.account).await
    }

    /// The account's debt at Rhea in micro-USD, rounded up, as the engine reads it.
    async fn rhea_debt(&self) -> u128 {
        let shown = self.at_rhea().await;
        if shown.is_null() {
            return 0;
        }
        balance_of(&shown["borrowed"], &self.musdc).div_ceil(USDC_INNER)
    }

    /// The account's cushion at Rhea in bp, worked out from Rhea's views.
    async fn cushion(&self) -> u128 {
        self.rhea.health_bp(&self.chain, &self.account).await.expect("no debt at Rhea")
    }

    /// Rhea's USDC borrow and deposit rates now, in bp a year.
    async fn rhea_rates(&self) -> (u32, u32) {
        let usdc = self.rhea.assets(&self.chain).await[0].clone();
        let bp = |field: &str| {
            let rate: f64 = usdc[field].as_str().unwrap_or_else(|| panic!("no {field}: {usdc}")).parse().unwrap();
            (rate * 10_000.0).round() as u32
        };
        (bp("borrow_apr"), bp("supply_apr"))
    }

    /// The account's line at Rhea as a verdict's `ext` carries it, read from Rhea's own views. `room` is what the
    /// engine would let the account borrow there now: its cushion maths isn't run here, so the test gives it.
    async fn rhea_line(&self, room: u128) -> Value {
        let (r_bp, s_bp) = self.rhea_rates().await;
        let debt = self.rhea_debt().await;
        let cushion = if debt == 0 { 0 } else { self.cushion().await };
        json!({
            "l": "rhea", "d": debt as u64, "hf_bp": cushion as u64, "r_bp": r_bp, "s_bp": s_bp, "room": room as u64,
            "liq_bp": 7_600,
        })
    }

    /// The pending OutLayer request from the account whose input has this intent.
    async fn request(&self, intent: &Value) -> Option<Value> {
        let pending: Vec<Value> = self.chain.view(&self.outlayer, "pending_requests", json!({})).await;
        pending.into_iter().find(|r| {
            let input: Value = serde_json::from_str(r["input_data"].as_str().unwrap_or("null")).unwrap_or_default();
            r["caller"] == json!(self.account) && input["intent"] == *intent
        })
    }

    /// Asks for a check of `intent` and answers it as the engine would: a HEALTHY verdict read at the latest block,
    /// for the account's counter as it is once the request has reached OutLayer, changed by `shape`. Asking ends a
    /// lender wait that is over, which moves the counter, so it is read afterwards. Returns `on_verdict`'s outcome
    /// and the transaction.
    async fn check(&self, intent: Value, shape: impl FnOnce(&mut Value)) -> (Value, ExecutionFinalResult) {
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
        (result.clone().json::<Value>().unwrap(), result)
    }

    /// As `check`, for a verdict the account must keep.
    async fn accept(&self, intent: Value, shape: impl FnOnce(&mut Value)) {
        let (outcome, _) = self.check(intent, shape).await;
        assert_eq!(outcome, json!({ "accepted": true, "reason": null }));
    }

    /// A plain check whose verdict carries the account's line at Rhea, with `room` to borrow there.
    async fn accept_with_room(&self, room: u128) -> Value {
        let line = self.rhea_line(room).await;
        self.accept(plain(), |v| v["ext"] = json!([line])).await;
        line
    }

    /// The account's owner calls `method` on it with 1 yoctoNEAR.
    async fn owner_call(&self, method: &str, args: Value) -> ExecutionFinalResult {
        self.chain.call(&self.client, &self.account, method, args, one_yocto()).await
    }

    /// `caller` runs step `i` of plan `pid`, with no deposit and 300 TGas.
    async fn run_step(&self, caller: &AccountId, pid: &str, i: u32) -> ExecutionFinalResult {
        self.chain.call(caller, &self.account, "execute_step", json!({ "pid": pid, "i": i }), yocto(0)).await
    }

    /// The owner asks for `amount` in all, the engine answers with `steps`, and the owner's `fund` stores them.
    /// Returns the funding plan's id.
    async fn fund(&self, amount: u128, steps: Value) -> String {
        let line = self.rhea_line(0).await;
        let intent = json!({ "fund": { "amount": amount.to_string() } });
        let shape = |v: &mut Value| {
            v["fund"] = steps;
            v["allow"]["fund"] = json!(amount as u64);
            v["ext"] = json!([line]);
        };
        self.accept(intent, shape).await;
        let stored = self.owner_call("fund", json!({ "amount": amount.to_string() })).await;
        assert_ok(&stored, "fund");
        stored.json::<Value>().unwrap()["pid"].as_str().unwrap().to_string()
    }

    /// Lets the lender action under way finish its 20 blocks. Returns its last block.
    async fn end_wait(&self) -> u64 {
        let listed = self.lender_action().await.expect("no lender action is under way");
        let until = listed["until_block"].as_u64().unwrap();
        loop {
            let height = self.chain.height().await;
            if height > until {
                return until;
            }
            self.chain.fast_forward(until - height + 1).await;
        }
    }

    /// A whole loan through a funding plan: `sats` of mNBTC posted at Rhea, `at_rhea` borrowed there, the wait, and
    /// with `at_pool` that much borrowed from our pool last. Returns the plan's id.
    async fn open_loan(&self, sats: u128, at_rhea: u128, at_pool: Option<u128>) -> String {
        let mut steps = vec![l_supply(&self.mnbtc, sats), l_borrow(at_rhea)];
        steps.extend(at_pool.map(p_borrow));
        let pid = self.fund(at_rhea + at_pool.unwrap_or(0), json!(steps)).await;
        assert_ok(&self.run_step(&self.operator, &pid, 0).await, "l_supply");
        self.accept_with_room(at_rhea).await;
        assert_ok(&self.run_step(&self.operator, &pid, 1).await, "l_borrow");
        self.end_wait().await;
        if at_pool.is_some() {
            self.accept_with_room(0).await;
            assert_ok(&self.run_step(&self.operator, &pid, 2).await, "p_borrow");
        }
        pid
    }

    /// The operator sets what this account pays, and lets two of its settlements be 2 seconds apart.
    async fn price(&self, pricing: Value) {
        let args = json!({ "target": { "account": self.account }, "pricing": pricing });
        self.chain.ok(&self.operator, &self.pool, "set_pricing", args).await;
        let mut limits = self.chain.view::<Value>(&self.pool, "get_params", json!({})).await["pricing_limits"].clone();
        limits["min_period_ns"] = json!(2 * SECOND_NS);
        self.chain.ok(&self.operator, &self.pool, "set_pricing_limits", json!({ "limits": limits })).await;
    }

    /// Anyone has the account settle with the pool. Returns the pool's `settle` event and the transaction.
    async fn settle(&self) -> (Value, ExecutionFinalResult) {
        let result = self.chain.call(&self.operator, &self.account, "settle", json!({}), yocto(0)).await;
        assert_ok(&result, "settle");
        assert!(result.clone().json::<bool>().unwrap(), "the pool's settle failed: {result:?}");
        let settled = events(&result, "settle");
        (settled.first().unwrap_or_else(|| panic!("the pool settled nothing: {result:?}")).clone(), result)
    }
}

/// The permission the client signs as it opens the account: Rhea, at the app's default terms.
fn terms() -> Value {
    json!({ "lenders": ["rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any" })
}

fn config(
    musdc: &AccountId,
    mnbtc: &AccountId,
    pool: &AccountId,
    outlayer: &AccountId,
    rhea: &AccountId,
    root: &AccountId,
) -> Value {
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
        "lenders": { "rhea": { "contract_id": rhea, "collateral": [mnbtc] }, "aave": null },
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

/// The intent of a plain check.
fn plain() -> Value {
    json!({ "check": {} })
}

fn l_supply(token: &AccountId, sats: u128) -> Value {
    json!({ "k": "l_supply", "l": "rhea", "tok": token, "amt": sats.to_string() })
}

fn l_borrow(amount: u128) -> Value {
    json!({ "k": "l_borrow", "l": "rhea", "amt": amount as u64 })
}

fn p_borrow(amount: u128) -> Value {
    json!({ "k": "p_borrow", "amt": amount as u64 })
}

/// Makes `v` a REBALANCE verdict with this plan and this line at Rhea: what the engine answers when a lender's
/// cushion is thin.
fn top_up(v: &mut Value, plan: Value, line: Value) {
    v["action"] = json!("REBALANCE");
    v["plan"] = plan;
    v["ext"] = json!([line]);
}

fn margin_120() -> Value {
    json!({ "lender": { "margin_bp": 120, "cap_bp": null } })
}

fn capped_at_8() -> Value {
    json!({ "lender": { "margin_bp": 0, "cap_bp": 800 } })
}

/// debt × rate × time ÷ a year, as the pool rounds it: up for a fee, down for a subsidy.
fn fee_for(debt: u128, rate_bp: u128, period_ns: u128) -> u128 {
    (debt * rate_bp * period_ns).div_ceil(10_000 * YEAR_NS)
}

fn subsidy_for(debt: u128, rate_bp: u128, period_ns: u128) -> u128 {
    debt * rate_bp * period_ns / (10_000 * YEAR_NS)
}

/// The data of the `pb-pool` events with this name that a transaction logged, the account's and the pool's.
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

/// Prints what a call burnt in all, and checks it is a call that fits in a transaction's 300 TGas with room to
/// spare. Every call here was sent with 300 TGas attached.
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
async fn a_loan_from_rhea_and_from_our_pool_runs_step_by_step() {
    let w = World::new().await;
    let c = &w.chain;

    // The account was opened through the factory with its permission, on a config that names the copy as Rhea, and
    // the pool has the engine try the lender first. The copy charges mainnet's rate.
    let state = w.state().await;
    assert_eq!(
        (state["permission"].clone(), state["funding"].clone(), state["counter"].clone()),
        (terms(), Value::Null, json!(0))
    );
    let config: Value = c.view(&w.account, "get_config", json!({})).await;
    assert_eq!(
        config["lenders"],
        json!({ "rhea": { "contract_id": w.rhea.id, "collateral": [w.mnbtc] }, "aave": null })
    );
    let params: Value = c.view(&w.pool, "get_params", json!({})).await;
    assert_eq!(params["funding"], json!({ "order": "lender_first", "loan_days": 90 }));
    let (r_bp, s_bp) = w.rhea_rates().await;
    assert!((1_585..=1_597).contains(&r_bp) && (1_010..=1_022).contains(&s_bp), "Rhea charges {r_bp} and pays {s_bp}");
    assert_eq!(w.at_rhea().await, Value::Null, "the account is registered with Rhea before it posts anything");

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

    // The client deposits 2 mNBTC and $1,000, and asks for $31,500 in all. The engine answers with Rhea first: post
    // 1 mNBTC there, borrow $30,000 against it, then $1,500 from our pool.
    w.deposit(&w.mnbtc, 2 * NBTC).await;
    w.deposit(&w.musdc, usd(1_000)).await;
    let steps = json!([l_supply(&w.mnbtc, NBTC), l_borrow(usd(30_000)), p_borrow(usd(1_500))]);
    let pid = w.fund(usd(31_500), steps).await;
    assert_eq!(w.counter().await, 1);

    // l_supply. `fund` spent its verdict, and with no loan from our pool the posting needs none. Anyone runs it.
    let posted = w.run_step(&w.operator, &pid, 0).await;
    assert_ok(&posted, "l_supply");
    burnt("execute_step l_supply, with Rhea's registration", &posted);
    assert_eq!(events(&posted, "step_run"), vec![json!({ "pid": pid, "i": 0, "k": "l_supply" })]);
    assert_eq!(posted.clone().json::<Value>().unwrap(), json!(NBTC.to_string()), "Rhea didn't take it all");
    // Rhea's views show the collateral, and the account's own mNBTC is down by it.
    assert_eq!(w.rhea.collateral_inner(c, &w.account).await, NBTC * NBTC_INNER);
    assert_eq!(w.balance(&w.mnbtc).await, NBTC);
    // The account registered with Rhea in the same call, for 0.1 NEAR of its own: two receipts ran there.
    assert_eq!(receipts_on(&posted, &w.rhea.id), 2);
    let storage: Value = c.view(&w.rhea.id, "storage_balance_of", json!({ "account_id": w.account })).await;
    assert_eq!(storage["total"], json!(RHEA_STORAGE.as_yoctonear().to_string()));
    let (stored, after) = (u128::from(c.storage_usage(&w.account).await), c.balance(&w.account).await);
    let paid = held - after;
    assert!(paid <= NEAR / 10 && paid > NEAR / 10 - NEAR / 500, "the posting cost the account {:.4} NEAR", near(paid));
    println!(
        "NEAR after Rhea's registration: storage {stored} B, balance {:.4}, free {:.4}",
        near(after),
        near(after - stored * BYTE)
    );
    // Like a withdrawal, the posting moved the counter on as it started and again as it ended.
    let state = w.state().await;
    assert_eq!((state["counter"].clone(), state["pending"].clone()), (json!(3), json!([])));
    assert_eq!(state["funding"]["steps"][0]["done"], true);

    // l_borrow needs a fresh verdict: the one `fund` used is spent. The engine reads no debt at Rhea yet and gives
    // it $30,000 of room.
    assert_refused(&w.run_step(&w.operator, &pid, 1).await, "the verdict was already used: ask for a new check");
    let line = w.accept_with_room(usd(30_000)).await;
    assert_eq!(line["d"], 0);
    let usdc = w.balance(&w.musdc).await;
    let lent = w.run_step(&w.operator, &pid, 1).await;
    assert_ok(&lent, "l_borrow");
    burnt("execute_step l_borrow", &lent);
    assert_eq!(events(&lent, "step_run"), vec![json!({ "pid": pid, "i": 1, "k": "l_borrow" })]);
    assert!(lent.clone().json::<bool>().unwrap(), "Rhea didn't take the call: {lent:?}");
    // The pool settled first, with Rhea's debt plus this borrow, and keeps that report for the next settlement.
    assert_eq!(events(&lent, "settle").len(), 1, "the pool didn't settle: {lent:?}");
    let reported = json!({
        "lender": "rhea", "debt": usd(30_000).to_string(), "rate_bp": line["r_bp"], "supply_bp": line["s_bp"],
    });
    assert_eq!(w.pricing().await["last"], json!([reported]));
    // Rhea lent, and the USDC is in the account: all of it, or one unit less.
    let debt = w.rhea.debt_inner(c, &w.account).await;
    assert!(debt >= usd(30_000) * USDC_INNER && debt < usd(30_001) * USDC_INNER, "Rhea shows a debt of {debt}");
    let got = w.balance(&w.musdc).await - usdc;
    assert!(got == usd(30_000) || got == usd(30_000) - 1, "{got} arrived");
    // The account books no loan of Rhea's. It lists the borrow as under way for 20 blocks.
    let state = w.state().await;
    assert_eq!(
        (state["loan"].clone(), state["counter"].clone()),
        (json!({ "principal": "0", "open": false }), json!(4))
    );
    let listed = w.lender_action().await.expect("the borrow isn't listed");
    let until = listed["until_block"].as_u64().unwrap();
    let expected =
        json!({ "lender": "rhea", "kind": "borrow", "amount": usd(30_000).to_string(), "until_block": until });
    assert_eq!((listed, state["pending"].as_array().unwrap().len()), (expected, 1));

    // While it is listed, nothing that adds risk runs: not a borrow from our pool, by the owner or by the plan's
    // next step, and not a withdrawal of collateral from Rhea.
    let wait = format!("until block {until} has passed: a borrow at rhea is still under way");
    let refused = w.owner_call("borrow", json!({ "amount": usd(1_500).to_string() })).await;
    assert_refused(&refused, &format!("no borrow {wait}"));
    assert_refused(&w.run_step(&w.operator, &pid, 2).await, &format!("no funding step {wait}"));
    let out = json!({ "lender": "rhea", "token": w.mnbtc, "amount": "5" });
    assert_refused(&w.owner_call("lender_withdraw", out).await, &format!("no lender withdrawal {wait}"));
    assert!(c.height().await <= until, "the 20 blocks ran out before the refusals were through");

    // After the wait the keeper's next check ends it, which moves the counter on, and the engine reads Rhea's real
    // position. Then our pool's step runs.
    assert_eq!(w.end_wait().await, until);
    let line = w.accept_with_room(0).await;
    assert!(u128::from(line["d"].as_u64().unwrap()) >= debt.div_ceil(USDC_INNER), "the engine's line: {line}");
    let state = w.state().await;
    assert_eq!((state["counter"].clone(), state["pending"].clone()), (json!(5), json!([])));
    let borrowed = w.run_step(&w.operator, &pid, 2).await;
    assert_ok(&borrowed, "p_borrow");
    burnt("execute_step p_borrow", &borrowed);
    assert_eq!(events(&borrowed, "step_run"), vec![json!({ "pid": pid, "i": 2, "k": "p_borrow" })]);
    assert!(borrowed.clone().json::<bool>().unwrap(), "the whole loan didn't arrive");
    let state = w.state().await;
    assert_eq!(state["loan"], json!({ "principal": usd(1_500).to_string(), "open": true }));
    assert_eq!((state["counter"].clone(), state["pending"].clone()), (json!(7), json!([])));
    assert!(state["funding"]["steps"].as_array().unwrap().iter().all(|s| s["done"] == true));
    assert!(w.pool_debt().await >= usd(1_500));
    let all = w.balance(&w.musdc).await;
    assert!(all == usd(32_500) || all == usd(32_500) - 1, "the account holds {all}");

    // What the whole loan left the account in NEAR.
    let (stored, held) = (u128::from(c.storage_usage(&w.account).await), c.balance(&w.account).await);
    println!(
        "NEAR after the first loan: storage {stored} B, balance {:.4}, free {:.4}",
        near(held),
        near(held - stored * BYTE)
    );
    // Rhea's registration took 0.1 NEAR. What is left covers the most an account's state can grow by, about a quarter
    // of a NEAR's worth, twice over.
    assert!(held - stored * BYTE > NEAR * 9 / 20, "the account has under 0.45 NEAR free after its first loan");
}

#[tokio::test]
async fn the_pool_prices_a_rhea_loan_with_a_fee_then_a_subsidy_that_ends_as_credit() {
    let w = World::new().await;
    let c = &w.chain;
    w.deposit(&w.mnbtc, 2 * NBTC).await;
    w.deposit(&w.musdc, usd(100)).await;

    // The operator has this client pay Rhea's rate plus 1.2 points. The client borrows $30,000 at Rhea only.
    w.price(margin_120()).await;
    w.open_loan(2 * NBTC, usd(30_000), None).await;
    // The borrow step's settlement was the account's first, so it only stored its report: Rhea's debt, which was
    // nothing, plus the $30,000 it was about to borrow. Nothing is owed to the pool.
    let stored = w.pricing().await;
    assert_eq!(
        (stored["last"][0]["debt"].clone(), stored["fees_charged"].clone()),
        (json!(usd(30_000).to_string()), json!("0"))
    );
    assert_eq!((w.state().await["loan"].clone(), w.pool_debt().await), (json!({ "principal": "0", "open": false }), 0));

    // The client repays Rhea before the next settlement, a dollar above the debt. No fresh verdict is held, so
    // nothing settles now.
    let pay = w.rhea_debt().await + usd(1);
    let repaid = w.owner_call("lender_repay", json!({ "lender": "rhea", "amount": pay.to_string() })).await;
    assert_ok(&repaid, "lender_repay");
    burnt("lender_repay", &repaid);
    assert_eq!(repaid.clone().json::<Value>().unwrap(), json!(pay.to_string()));
    assert!(events(&repaid, "settle").is_empty(), "a repayment with no fresh verdict settled");
    assert_eq!(w.rhea_debt().await, 0);

    // The next settlement shows no debt at Rhea any more. The margin is charged all the same, on the $30,000 the
    // borrow step reported, for the time since: the fee the gap would have lost.
    let line = w.accept_with_room(0).await;
    assert_eq!(line["d"], 0);
    let (settled, result) = w.settle().await;
    burnt("settle (a fee)", &result);
    let period = str_u128(&settled["period_ns"]);
    let fee = fee_for(usd(30_000), 120, period);
    println!("a fee of {fee} micro-USD on $30,000 over {:.1} s: {settled}", period as f64 / 1e9);
    assert!(fee > 0 && period >= 2 * u128::from(SECOND_NS));
    assert_eq!(
        (settled["account_id"].clone(), str_u128(&settled["fee"]), settled["subsidy"].clone()),
        (json!(w.account), fee, json!("0"))
    );
    // The account's loan record and the pool's debt agree: the fee is the whole loan, and it is open.
    assert_eq!(w.state().await["loan"], json!({ "principal": fee.to_string(), "open": true }));
    let owed = w.pool_debt().await;
    assert!(owed >= fee && owed <= fee + 1, "the pool counts a debt of {owed} for a fee of {fee}");
    assert_eq!(str_u128(&w.pricing().await["fees_charged"]), fee);
    // Owing the pool, even only a fee, the owner needs a verdict to take anything out.
    let out = json!({ "token": w.mnbtc, "amount": "5", "receiver": w.client });
    assert_refused(&w.owner_call("withdraw", out).await, "a withdrawal needs a verdict for this token and amount");

    // Now the operator caps what this client pays at 8%, under Rhea's rate. The client borrows $30,000 again, with
    // a second plan: the collateral is still posted.
    w.price(capped_at_8()).await;
    let second = w.fund(usd(30_000), json!([l_borrow(usd(30_000))])).await;
    let line = w.accept_with_room(usd(30_000)).await;
    let (r_bp, s_bp) = (line["r_bp"].as_u64().unwrap() as u128, line["s_bp"].as_u64().unwrap() as u128);
    let lent = w.run_step(&w.operator, &second, 0).await;
    assert_ok(&lent, "the second l_borrow");
    // Its report shows more debt than the last one, so the pool settles however soon it comes. A subsidy counts the
    // smaller debt of the two reports, which is none, so nothing is booked yet.
    let at_borrow = events(&lent, "settle");
    assert_eq!((at_borrow[0]["fee"].clone(), at_borrow[0]["subsidy"].clone()), (json!("0"), json!("0")));
    w.end_wait().await;

    // An hour's settlement, here a few seconds': the pool pays the difference between Rhea's rate and the client's.
    // A subsidy never takes the client under what Rhea pays depositors, so the client's rate is the larger of the
    // 8% cap and Rhea's deposit rate.
    w.accept_with_room(0).await;
    let before = w.pool_debt().await;
    let (settled, result) = w.settle().await;
    burnt("settle (a subsidy)", &result);
    let period = str_u128(&settled["period_ns"]);
    let subsidy = subsidy_for(usd(30_000), r_bp - s_bp.max(800), period);
    println!(
        "a subsidy of {subsidy} micro-USD on $30,000 at {r_bp} bp against {} bp over {:.1} s: {settled}",
        s_bp.max(800),
        period as f64 / 1e9
    );
    assert!(subsidy > before, "a subsidy of {subsidy} doesn't pass the debt of {before}");
    assert_eq!(
        (settled["fee"].clone(), str_u128(&settled["subsidy"]), settled["cut"].clone()),
        (json!("0"), subsidy, json!("0"))
    );
    // It went past the pool debt, so the debt is gone and the rest is credit.
    let credit = str_u128(&settled["credit"]);
    assert!(credit + before <= subsidy && credit + before + 2 >= subsidy, "credit {credit}, debt before {before}");
    assert_eq!((settled["debt"].clone(), w.pool_debt().await), (json!("0"), 0));
    assert_eq!(str_u128(&w.pricing().await["credit"]), credit);
    // The account's record is down to nothing too, and stays open until a repayment comes back unused.
    assert_eq!(w.state().await["loan"], json!({ "principal": "0", "open": true }));

    // The owner collects the credit: the pool pays it in USDC, and the account books nothing.
    let stranger = c.call(&w.operator, &w.account, "claim_credit", json!({}), yocto(0)).await;
    assert_refused(&stranger, "only the owner can do this");
    let usdc = w.balance(&w.musdc).await;
    let claimed = c.call(&w.client, &w.account, "claim_credit", json!({}), yocto(0)).await;
    assert_ok(&claimed, "claim_credit");
    burnt("claim_credit", &claimed);
    assert_eq!(claimed.clone().json::<Value>().unwrap(), json!(credit.to_string()));
    assert_eq!(w.balance(&w.musdc).await, usdc + credit);
    assert_eq!(w.pricing().await["credit"], "0");
    assert_eq!(c.view::<Value>(&w.pool, "get_pool", json!({})).await["credit_owed"], "0");
    assert_eq!(w.state().await["loan"], json!({ "principal": "0", "open": true }));

    // A repayment the pool sends back whole shows that nothing is owed there, and closes the record.
    assert_ok(&w.owner_call("repay", json!({ "amount": "1" })).await, "repay");
    assert_eq!((w.state().await["loan"].clone(), w.pool_debt().await), (json!({ "principal": "0", "open": false }), 0));
}

#[tokio::test]
async fn a_borrow_rhea_refuses_reopens_its_step_and_a_fall_in_bitcoin_is_topped_up() {
    let w = World::new().await;
    let c = &w.chain;
    w.deposit(&w.mnbtc, 2 * NBTC).await;

    // The plan posts 1 mNBTC and borrows $60,000 against it. At $75,000 Rhea lends at most $57,000 on it.
    let pid = w.fund(usd(60_000), json!([l_supply(&w.mnbtc, NBTC), l_borrow(usd(60_000))])).await;
    assert_ok(&w.run_step(&w.operator, &pid, 0).await, "l_supply");
    w.accept_with_room(usd(60_000)).await;
    let refused = w.run_step(&w.operator, &pid, 1).await;
    burnt("execute_step l_borrow that Rhea refuses", &refused);
    // The call itself goes through, and answers that the borrow didn't: the one failing receipt is Rhea's.
    assert!(refused.clone().into_result().is_ok(), "the step's own call failed: {refused:?}");
    assert!(!refused.clone().json::<bool>().unwrap());
    let failures = refused.receipt_failures();
    assert!(failures.len() == 1 && failures[0].executor_id == w.rhea.id, "{failures:?}");
    assert!(format!("{refused:?}").contains("compute_max_discount"), "{refused:?}");
    let reopened =
        format!("step 1 of plan {pid} didn't go out, as Rhea refused it: nothing was borrowed, and it may run again");
    assert!(refused.logs().iter().any(|log| *log == reopened), "{:?}", refused.logs());
    // Nothing is booked anywhere: no debt at Rhea, no USDC, no loan in the account, and nothing owed to the pool.
    // The listing is gone, the counter has moved on (4 as the step started, 5 as it was dropped), and the step is
    // open again.
    assert_eq!((w.rhea_debt().await, w.balance(&w.musdc).await, w.pool_debt().await), (0, 0, 0));
    let state = w.state().await;
    assert_eq!(
        (state["loan"].clone(), state["pending"].clone()),
        (json!({ "principal": "0", "open": false }), json!([]))
    );
    assert_eq!((state["counter"].clone(), state["funding"]["steps"][1]["done"].clone()), (json!(5), json!(false)));
    let stored = w.pricing().await;
    let none = (json!("0"), json!("0"), json!("0"));
    assert_eq!((stored["fees_charged"].clone(), stored["subsidy_paid"].clone(), stored["credit"].clone()), none);

    // The step runs again on a new verdict. This one gives Rhea $40,000 of room, so it borrows that.
    w.accept_with_room(usd(40_000)).await;
    let lent = w.run_step(&w.operator, &pid, 1).await;
    assert_ok(&lent, "l_borrow, again");
    assert!(lent.clone().json::<bool>().unwrap());
    let got = w.balance(&w.musdc).await;
    assert!(got == usd(40_000) || got == usd(40_000) - 1, "{got} arrived");
    assert_eq!(w.lender_action().await.unwrap()["amount"], json!(usd(40_000).to_string()));
    let roomy = w.cushion().await;
    assert!((14_240..=14_250).contains(&roomy), "the cushion is {roomy}");
    // The borrow's 20 blocks run out before the next check is asked for. A check asked for inside them and answered
    // after them would be refused, since the end of the wait moves the counter on.
    w.end_wait().await;

    // Bitcoin falls to $60,000, and the cushion at Rhea to 1.14. The engine orders a top-up: half an mNBTC more.
    let _ = w.rhea.set_btc_price(c, 60_000).await;
    let thin = w.cushion().await;
    assert!(thin < 12_000, "the cushion is {thin}");
    let add = json!([{ "k": "l_add", "l": "rhea", "tok": w.mnbtc, "amt": (NBTC / 2).to_string() }]);
    let line = w.rhea_line(0).await;
    w.accept(plain(), |v| top_up(v, add.clone(), line)).await;
    let first = w.pid().await;
    // A later check that orders nothing keeps the plan stored, since the account isn't HEALTHY. But that reading
    // didn't ask for the top-up, so its `l_add` no longer runs.
    w.accept(plain(), |v| v["state"] = json!("WATCH")).await;
    assert_eq!(w.pid().await, first);
    let stale = w.run_step(&w.operator, &first, 0).await;
    assert_refused(&stale, &format!("step 0 of plan {first} can't run: the latest check, read at block"));
    assert_refused(&stale, "is not the one that ordered it");
    assert_eq!(w.rhea.collateral_inner(c, &w.account).await, NBTC * NBTC_INNER);
    // The next check orders it again. The stored plan is kept under its own id (research/audit.md, A15), and its
    // step runs under that check: no permission is asked, and no verdict beyond one that orders it.
    let line = w.rhea_line(0).await;
    w.accept(plain(), |v| top_up(v, add.clone(), line)).await;
    let plan = w.pid().await;
    assert_eq!(plan, first, "a check that orders the same top-up replaced the stored plan");
    let before = w.counter().await;
    let added = w.run_step(&w.operator, &plan, 0).await;
    assert_ok(&added, "l_add");
    burnt("execute_step l_add", &added);
    assert_eq!(events(&added, "step_run"), vec![json!({ "pid": plan, "i": 0, "k": "l_add" })]);
    // The account registered with Rhea once, at its first posting: this time one receipt ran there.
    assert_eq!(receipts_on(&added, &w.rhea.id), 1);
    assert_eq!(w.rhea.collateral_inner(c, &w.account).await, NBTC * 3 / 2 * NBTC_INNER);
    assert_eq!((w.balance(&w.mnbtc).await, w.counter().await), (NBTC / 2, before + 2));
    let topped = w.cushion().await;
    assert!(topped >= 15_000, "the cushion is {topped} after the top-up");

    // Bitcoin falls on to $45,000, and the cushion to 1.28. With little spare collateral left, the engine has the
    // account repay $10,000 from its USDC.
    let _ = w.rhea.set_btc_price(c, 45_000).await;
    let thin = w.cushion().await;
    assert!(thin < 13_500, "the cushion is {thin}");
    let repay = json!([{ "k": "l_repay", "l": "rhea", "amt": usd(10_000) as u64 }]);
    let line = w.rhea_line(0).await;
    w.accept(plain(), |v| top_up(v, repay.clone(), line)).await;
    let plan = w.pid().await;
    let (usdc, owed, before) = (w.balance(&w.musdc).await, w.rhea_debt().await, w.counter().await);
    // While the pool is paused, its `check_step` refuses the step: nothing goes to Rhea, and the step may run again.
    c.ok(&w.operator, &w.pool, "set_paused", json!({ "paused": true })).await;
    let held = w.run_step(&w.operator, &plan, 0).await;
    assert_refused(&held, "the pool is paused: plan steps wait");
    let said =
        format!("step 0 of plan {plan} didn't go out, as the pool refused it: nothing was sent, and it may run again");
    assert!(held.logs().iter().any(|log| *log == said), "{:?}", held.logs());
    assert_eq!((w.balance(&w.musdc).await, w.rhea_debt().await >= owed), (usdc, true));
    assert_eq!(w.state().await["plan"]["steps"][0]["done"], false);
    c.ok(&w.operator, &w.pool, "set_paused", json!({ "paused": false })).await;
    let repaid = w.run_step(&w.operator, &plan, 0).await;
    assert_ok(&repaid, "l_repay");
    // The pool counted the step: $37,500 for the half coin posted, and this $10,000.
    let counted = events(&repaid, "step");
    assert_eq!(counted.len(), 1, "the pool's check_step didn't run: {repaid:?}");
    assert_eq!(
        (counted[0]["value"].clone(), counted[0]["total_24h"].clone()),
        (json!(usd(10_000).to_string()), json!(usd(47_500).to_string()))
    );
    burnt("execute_step l_repay", &repaid);
    assert_eq!(events(&repaid, "step_run"), vec![json!({ "pid": plan, "i": 0, "k": "l_repay" })]);
    assert!(repaid.logs().iter().any(|log| *log == format!("repaid {} at Rhea", usd(10_000))), "{:?}", repaid.logs());
    assert_eq!(w.balance(&w.musdc).await, usdc - usd(10_000));
    let left = w.rhea_debt().await;
    assert!(left <= owed - usd(10_000) + usd(1) && left >= owed - usd(10_000), "the debt went from {owed} to {left}");
    // A repayment only lowers risk: the counter stays where it was.
    assert_eq!(w.counter().await, before);
    let topped = w.cushion().await;
    assert!(topped >= 15_000, "the cushion is {topped} after the repayment");
}

#[tokio::test]
async fn the_owner_leaves_rhea_and_the_pool_and_takes_everything_out() {
    let w = World::new().await;
    let c = &w.chain;
    w.deposit(&w.mnbtc, 2 * NBTC).await;
    w.deposit(&w.musdc, usd(1_000)).await;
    // 1 mNBTC posted at Rhea, $30,000 borrowed there and $1,500 from our pool.
    w.open_loan(NBTC, usd(30_000), Some(usd(1_500))).await;

    // The owner repays Rhea a dollar above the debt, which grows every moment. Rhea clears the debt and keeps the
    // rest as the account's deposit there.
    let pay = w.rhea_debt().await + usd(1);
    let repaid = w.owner_call("lender_repay", json!({ "lender": "rhea", "amount": pay.to_string() })).await;
    assert_ok(&repaid, "lender_repay");
    assert_eq!(repaid.clone().json::<Value>().unwrap(), json!(pay.to_string()));
    let shown = w.at_rhea().await;
    assert_eq!(shown["borrowed"], json!([]), "a debt is left at Rhea");
    let left = balance_of(&shown["supplied"], &w.musdc) / USDC_INNER;
    assert!(left > 0 && left <= usd(1), "{left} was left at Rhea");

    // Anyone brings that rest back to the account, with no verdict: it backs no loan and goes nowhere else.
    let (usdc, before) = (w.balance(&w.musdc).await, w.state().await);
    let back = json!({ "lender": "rhea", "token": w.musdc, "amount": usd(5).to_string() });
    let brought = c.call(&w.operator, &w.account, "lender_withdraw", back, one_yocto()).await;
    assert_ok(&brought, "lender_withdraw of the USDC left at Rhea");
    burnt("lender_withdraw of USDC, by anyone", &brought);
    assert_eq!(w.balance(&w.musdc).await, usdc + left);
    assert_eq!(w.at_rhea().await["supplied"], json!([]));
    let after = w.state().await;
    assert_eq!(
        (after["counter"].clone(), after["pending"].clone()),
        (before["counter"].clone(), before["pending"].clone())
    );

    // The collateral is another matter while the pool is owed: only the owner, and only on a verdict that answers
    // exactly this withdrawal.
    let part = json!({ "lender": "rhea", "token": w.mnbtc, "amount": (NBTC * 2 / 5).to_string() });
    let stranger = c.call(&w.operator, &w.account, "lender_withdraw", part.clone(), one_yocto()).await;
    assert_refused(&stranger, "only the owner can do this");
    w.accept_with_room(0).await;
    let other = "with a loan open, taking collateral back needs a verdict for this lender, token and amount";
    assert_refused(&w.owner_call("lender_withdraw", part.clone()).await, other);
    w.accept(json!({ "lender_withdraw": part }), |v| v["allow"]["withdraw"] = json!(NBTC * 2 / 5)).await;
    let before = w.counter().await;
    let out = w.owner_call("lender_withdraw", part.clone()).await;
    assert_ok(&out, "lender_withdraw of collateral, with a verdict");
    burnt("lender_withdraw of collateral", &out);
    assert!(out.clone().json::<bool>().unwrap(), "Rhea didn't take the call");
    assert_eq!(w.balance(&w.mnbtc).await, NBTC + NBTC * 2 / 5);
    assert_eq!(w.rhea.collateral_inner(c, &w.account).await, NBTC * 3 / 5 * NBTC_INNER);
    // It is listed for 20 blocks with the token that is leaving, and the verdict backs nothing more.
    let listed = w.lender_action().await.expect("the withdrawal isn't listed");
    let expected = json!({
        "lender": "rhea", "kind": "withdraw", "amount": (NBTC * 2 / 5).to_string(), "token": w.mnbtc,
        "until_block": listed["until_block"],
    });
    assert_eq!((listed, w.counter().await), (expected, before + 1));

    // The owner repays the pool with more than the debt. The pool sends the rest back, which closes the loan.
    assert_ok(&w.owner_call("repay", json!({ "amount": usd(1_600).to_string() })).await, "repay");
    assert_eq!((w.state().await["loan"].clone(), w.pool_debt().await), (json!({ "principal": "0", "open": false }), 0));

    // With nothing owed to the pool, the rest of the collateral comes back with no verdict, once the wait is over.
    let rest = json!({ "lender": "rhea", "token": w.mnbtc, "amount": (NBTC * 3 / 5).to_string() });
    assert_refused(&w.owner_call("lender_withdraw", rest.clone()).await, "a withdrawal at rhea is still under way");
    w.end_wait().await;
    let out = w.owner_call("lender_withdraw", rest).await;
    assert_ok(&out, "lender_withdraw of collateral, with no verdict");
    assert_eq!(w.balance(&w.mnbtc).await, 2 * NBTC);
    // Rhea's views end empty.
    let shown = w.at_rhea().await;
    assert_eq!((&shown["supplied"], &shown["collateral"], &shown["borrowed"]), (&json!([]), &json!([]), &json!([])));

    // And everything goes back to the owner's wallet, with no verdict: nothing is owed anywhere.
    let usdc = w.balance(&w.musdc).await;
    assert!(usdc > 0);
    for (token, amount) in [(&w.mnbtc, 2 * NBTC), (&w.musdc, usdc)] {
        let wallet = token_balance(c, token, &w.client).await;
        let args = json!({ "token": token, "amount": amount.to_string(), "receiver": w.client });
        assert_ok(&w.owner_call("withdraw", args).await, "withdraw");
        assert_eq!((w.balance(token).await, token_balance(c, token, &w.client).await), (0, wallet + amount));
    }
}
