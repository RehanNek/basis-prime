//! The fixes after the second audit pass, on the built contracts (research/audit.md, "Second pass"; INTERFACES.md
//! 40). Each test plays out the hole the audit found, and the account or the factory now refuses it.
//!
//! - A7: a move with an expiry far ahead is not recorded: `evm_withdraw` and `withdraw` with a transfer.
//! - A8: `set_permission` leaves the counter alone, so a check on its way still arrives; and `fund` refuses a check
//!   read at or before the block the permission changed.
//! - A9: anyone but the owner repays all of Aave's debt or nothing, one repayment at a time.
//! - A12: one unit of a token with a move's msg no longer settles a move that left NEAR for good.
//! - X2 and F2, at the factory: a Rhea collateral token with more than 18 decimals is refused, and `create_account`
//!   says how much gas it needs.
//!
//! The world is `tests/moves.rs`'s: the factory with Aave in its config, the pool, both test tokens and the mocks.
mod common;

use std::time::Duration;

use common::rhea::{call_with_gas, mint, token_balance, NBTC};
use common::*;
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::{AccountId, NearToken};
use serde_json::{json, Value};

const REGISTRATION: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const PARAMS: &str = "4f0e2f3c8b9a1d7e6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605";
const VERSION: &str = "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12";
const GATEWAY_VERSION: &str = "cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34";
const HL_USDC: &str = "USDC:0xeb62eee3685fc4c43992febcd9e75443";
const MINUTE_MS: u64 = 60_000;
const DAY_MS: u64 = 24 * 60 * MINUTE_MS;
/// 1 January 2100, in unix ms.
const YEAR_2100_MS: u64 = 4_102_444_800_000;
const FAR: &str = "exp is more than 24 hours ahead: a 1Click quote lives a day at most";

/// Aave's test market on Base Sepolia (INTERFACES.md 24 and 33).
const AAVE_POOL: &str = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
const AAVE_USDC: &str = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
const WBTC: &str = "0x54114591963CF60EF3aA63bEfD6eC263D98145a4";
const WETH: &str = "0x4200000000000000000000000000000000000006";
/// The stand-in's float on Aave's chain, which is every deposit address there.
const FLOAT: &str = "0x2031181d63507368232579AF4c64a1c3428407fF";

/// A sandbox with both test tokens, a funded pool, the OutLayer and MPC mocks, the factory with Aave in its config,
/// and a client whose account holds 1 mNBTC and $50 and knows its address on Aave's chain.
struct World {
    chain: Chain,
    musdc: AccountId,
    mnbtc: AccountId,
    outlayer: AccountId,
    mpc: AccountId,
    factory: AccountId,
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
        let mpc = chain.contract("mpc", 10, wasm("pb_testnet_mpc_mock"), None).await;

        let factory: AccountId = format!("factory.{}", chain.root).parse().unwrap();
        let init = json!({ "operator": operator, "factory": factory, "token": musdc });
        let pool = chain.contract("pool", 20, wasm("pb_pool"), Some(("new", init))).await;
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
        let w = World { chain, musdc, mnbtc, outlayer, mpc, factory, operator, client, account };

        let args = json!({ "name": "alice", "owner": w.client, "permission": terms() });
        let made = w.chain.call(&w.client, &w.factory, "create_account", args, NearToken::from_near(6)).await;
        assert_ok(&made, "create_account");
        assert!(made.clone().json::<bool>().unwrap(), "create_account reported a failed step: {made:?}");
        for (token, amount) in [(&w.mnbtc, NBTC), (&w.musdc, usd(50))] {
            mint(&w.chain, token, &w.client, amount).await;
            let args = json!({ "receiver_id": w.account, "amount": amount.to_string(), "msg": "" });
            w.chain.ok_with(&w.client, token, "ft_transfer_call", args, one_yocto()).await;
        }
        assert_ok(&w.chain.call(&w.client, &w.account, "hl_init", json!({}), yocto(0)).await, "hl_init");
        w
    }

    async fn state(&self) -> Value {
        self.chain.view(&self.account, "get_state", json!({})).await
    }

    async fn counter(&self) -> u64 {
        self.state().await["counter"].as_u64().unwrap()
    }

    /// The latest block's time, in ms.
    async fn now_ms(&self) -> u64 {
        let block = near_api::Chain::block().fetch_from(&self.chain.network).await.expect("no block");
        block.header.timestamp_nanosec.parse::<u64>().unwrap() / 1_000_000
    }

    /// The account's owner calls `method` on it with 1 yoctoNEAR.
    async fn owner_call(&self, method: &str, args: Value) -> ExecutionFinalResult {
        self.chain.call(&self.client, &self.account, method, args, one_yocto()).await
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

    /// Asks for a check of `intent`. Once the request is with OutLayer, `meanwhile` runs. Then the engine answers
    /// with `answer`. Returns `on_verdict`'s outcome.
    async fn check_while(
        &self,
        intent: Value,
        meanwhile: impl AsyncFnOnce(),
        answer: impl AsyncFnOnce() -> Value,
    ) -> Value {
        let args = json!({ "intent": intent });
        let deposit = NearToken::from_millinear(10);
        let call = self.chain.call_in_background(&self.client, &self.account, "request_check", args, deposit);
        let request = self.request(&intent).await;
        meanwhile().await;
        let resolve = json!({ "request_id": request["request_id"], "output": answer().await });
        self.chain.ok(&self.operator, &self.outlayer, "resolve_execution", resolve).await;
        let result = call.await.unwrap();
        assert_ok(&result, "request_check");
        result.json::<Value>().unwrap()
    }

    /// A check of `intent` that the engine answers with a HEALTHY verdict read at the latest block for the account's
    /// counter, changed by `shape`. The account must keep it.
    async fn accept(&self, intent: Value, shape: impl FnOnce(&mut Value)) {
        let answer = async || {
            let mut v = verdict(&self.account, self.counter().await, self.chain.height().await);
            shape(&mut v);
            v
        };
        let outcome = self.check_while(intent, async || {}, answer).await;
        assert_eq!(outcome, json!({ "accepted": true, "reason": null }));
    }

    /// The account's 1Click transfers under way.
    async fn transfers(&self) -> Vec<Value> {
        self.state().await["pending"].as_array().unwrap().iter().filter_map(|p| p.get("transfer").cloned()).collect()
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

fn plain() -> Value {
    json!({ "check": {} })
}

/// The data of the `pb-pool` events with this name that a transaction logged.
fn events(result: &ExecutionFinalResult, name: &str) -> Vec<Value> {
    let logs = result.logs();
    let events = logs.iter().filter_map(|log| log.strip_prefix("EVENT_JSON:"));
    let parsed = events.filter_map(|text| serde_json::from_str::<Value>(text).ok());
    parsed.filter(|e| e["standard"] == "pb-pool" && e["event"] == name).map(|e| e["data"].clone()).collect()
}

#[tokio::test]
async fn a7_and_a12_a_far_expiry_is_refused_and_one_unit_with_a_moves_msg_no_longer_settles_it() {
    let w = World::new().await;
    let c = &w.chain;
    let dep = c.account("dep", 5).await;
    let stranger = c.account("stranger", 5).await;

    // A7, the hole: with no loan and no verdict, the owner records a million dollars "on its way home" from an
    // address that never held it, with an expiry in 2100.
    let million = json!({ "token": AAVE_USDC, "amount": "1000000000000", "to": FLOAT, "exp": YEAR_2100_MS });
    assert_refused(&w.owner_call("evm_withdraw", million).await, FAR);
    // The second way: a withdrawal to the owner's own wallet, labelled as a move.
    for kind in ["to_evm", "to_hl"] {
        let transfer = json!({ "kind": kind, "exp": YEAR_2100_MS });
        let own = json!({ "token": w.musdc, "amount": "1000000", "receiver": w.client, "transfer": transfer });
        assert_refused(&w.owner_call("withdraw", own).await, FAR);
    }
    // And a day and a few minutes is too far already.
    let over = json!({ "kind": "to_evm", "exp": w.now_ms().await + DAY_MS + 10 * MINUTE_MS });
    let args = json!({ "token": w.mnbtc, "amount": "55000", "receiver": dep, "transfer": over });
    assert_refused(&w.owner_call("withdraw", args).await, FAR);
    let state = w.state().await;
    assert_eq!(
        (state["pending"].clone(), state["next_move"].clone(), state["counter"].clone()),
        (json!([]), json!(0), json!(0))
    );
    assert_eq!(state["evm"], json!({ "nonce": 0, "signed": [], "approved": [] }));

    // A quote of 10 minutes, as the stand-in gives, is recorded as before.
    let transfer = json!({ "kind": "to_evm", "exp": w.now_ms().await + 10 * MINUTE_MS });
    let args = json!({ "token": w.mnbtc, "amount": "55000", "receiver": dep, "transfer": transfer });
    assert_ok(&w.owner_call("withdraw", args).await, "the move of bitcoin to Aave's chain");
    assert_eq!(w.transfers().await.len(), 1);

    // A12, the hole: one unit of a listed token with the move's msg, from anyone, used to settle it. Now it is kept
    // as a deposit and the record stays, whatever the token.
    let msg = json!({ "pb": { "transfer": "move:0" } }).to_string();
    for (token, amount) in [(&w.mnbtc, 1u128), (&w.musdc, 55_000), (&w.mnbtc, 43_999)] {
        mint(c, token, &stranger, amount).await;
        let args = json!({ "receiver_id": w.account, "amount": amount.to_string(), "msg": msg });
        let sent = c.call(&stranger, token, "ft_transfer_call", args, one_yocto()).await;
        assert_ok(&sent, "the deposit with the move's msg");
        assert!(sent.logs().contains(&"kept as a deposit: not a refund of transfer move:0"), "{sent:?}");
        assert!(events(&sent, "transfer_done").is_empty());
        assert_eq!(token_balance(c, token, &stranger).await, 0, "the tokens were sent back");
    }
    assert_eq!(w.transfers().await.len(), 1);
    // 1Click's refund, the token it was sent and all of it, settles the move.
    let args = json!({ "receiver_id": w.account, "amount": "55000", "msg": msg });
    let refunded = c.call(&dep, &w.mnbtc, "ft_transfer_call", args, one_yocto()).await;
    assert_ok(&refunded, "the refund");
    assert_eq!(events(&refunded, "transfer_done"), vec![json!({ "id": "move:0", "how": "refunded" })]);
    assert!(w.transfers().await.is_empty());
}

#[tokio::test]
async fn a8_set_permission_leaves_the_counter_alone_and_fund_asks_for_a_check_read_after_it() {
    let w = World::new().await;
    let opened_at = w.state().await["permission_blk"].as_u64().expect("no permission_blk in the state");
    assert!(opened_at > 0, "the account was opened with a permission");

    // The hole: an owner called set_permission while a check was on its way, and the check, read for the counter
    // as it was, arrived stale. Now the counter stays, and the check is kept.
    let counter = w.counter().await;
    let change = async || {
        let set = w.owner_call("set_permission", json!({ "permission": terms() })).await;
        assert_ok(&set, "set_permission");
        assert_eq!(events(&set, "permission_set"), vec![json!({ "permission": terms() })]);
    };
    let read_before = w.chain.height().await;
    let answer = async || {
        let mut call = verdict(&w.account, counter, read_before);
        call["state"] = json!("MARGIN_CALL");
        call
    };
    let outcome = w.check_while(plain(), change, answer).await;
    assert_eq!(outcome, json!({ "accepted": true, "reason": null }), "the check on its way arrived stale");
    let state = w.state().await;
    let changed_at = state["permission_blk"].as_u64().unwrap();
    assert_eq!(state["counter"], json!(counter));
    assert_eq!(state["verdict"]["verdict"]["state"], "MARGIN_CALL");
    assert!(changed_at > read_before && changed_at > opened_at);

    // A check for `fund` that was read at the block the permission changed, or before, backs no plan.
    let amount = json!({ "amount": "30000000" });
    let steps = json!([{ "k": "p_borrow", "amt": 30_000_000 }]);
    let fund_answer = |blk: u64| {
        let mut v = verdict(&w.account, counter, blk);
        v["fund"] = steps.clone();
        v["allow"]["fund"] = json!(30_000_000);
        v
    };
    let intent = json!({ "fund": amount.clone() });
    let outcome = w.check_while(intent.clone(), async || {}, async || fund_answer(changed_at)).await;
    assert_eq!(outcome["accepted"], true, "{outcome}");
    let words =
        format!("the check was read before the permission last changed (block {changed_at}): ask for a new check");
    assert_refused(&w.owner_call("fund", amount.clone()).await, &words);
    assert_eq!(w.state().await["funding"], Value::Null);
    // One read after it does.
    let later = async || fund_answer(w.chain.height().await);
    let outcome = w.check_while(intent, async || {}, later).await;
    assert_eq!(outcome["accepted"], true, "{outcome}");
    let stored = w.owner_call("fund", amount).await;
    assert_ok(&stored, "fund");
    assert_eq!(w.counter().await, counter + 1);
}

#[tokio::test]
async fn a9_anyone_but_the_owner_repays_all_of_aaves_debt_or_nothing_one_repayment_at_a_time() {
    let w = World::new().await;
    let c = &w.chain;
    let stranger = c.account("stranger", 5).await;
    // The engine says DELEVERAGE, which opens repaying to anyone, and shows $20 owed at Aave.
    let unwinding = |v: &mut Value| {
        v["state"] = json!("DELEVERAGE");
        v["action"] = json!("DELEVERAGE");
        v["ext"] = json!([{
            "l": "aave", "c": 60_000_000, "d": 20_000_000, "hf_bp": 11_000, "r_bp": 550, "s_bp": 400, "room": 0,
            "liq_bp": 8_300,
        }]);
        v["evm"] = json!({ "nonce": 0 });
    };
    w.accept(plain(), unwinding).await;

    // The hole: a stranger had the account sign repayments of 1 micro-USD without limit.
    let repay = |amount: u128| json!({ "lender": "aave", "amount": amount.to_string() });
    let part = "anyone but the owner repays all of Aave's debt (20000000) or nothing";
    for amount in [1, 19_999_999] {
        let refused = c.call(&stranger, &w.account, "lender_repay", repay(amount), one_yocto()).await;
        assert_refused(&refused, part);
    }
    assert_eq!(w.state().await["evm"]["nonce"], 0);

    // The whole debt is signed, as "all of it". The mock answers with a well-formed signature.
    let call = c.call_in_background(&stranger, &w.account, "lender_repay", repay(20_000_000), one_yocto());
    let mut request = None;
    for _ in 0..80 {
        let pending: Vec<Value> = c.view(&w.mpc, "pending_requests", json!({})).await;
        request = pending.into_iter().find(|p| p["signer_id"] == json!(w.account));
        if request.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let request = request.expect("the repayment never reached the MPC mock")["request"].clone();
    let answer = json!({
        "big_r": { "affine_point": "03c108d226eef8ea52e8c49dd4ffe260add49c1478f8305122e2cee5f755b6df22" },
        "s": { "scalar": "680ca8be54a7349ca45980f38c0c76ef37406385b782c1d895e8ac5e257a0785" },
        "recovery_id": 0,
    });
    let args = json!({ "signer_id": w.account, "request": request, "response": answer });
    c.ok(&w.operator, &w.mpc, "respond", args).await;
    let signed = call.await.unwrap();
    assert_ok(&signed, "lender_repay");
    let entry = signed.json::<Value>().unwrap();
    assert_eq!((entry["nonce"].clone(), entry["kind"].clone()), (json!(0), json!("repay")));
    // "All of it": the amount in the call's data is the largest there is.
    assert!(entry["raw"].as_str().unwrap().contains(&"f".repeat(64)), "{entry}");

    // A second one waits until a check shows the first mined.
    let waiting = "a repayment at Aave is signed and not mined yet (nonce 0): send it, then ask for a check";
    let refused = c.call(&stranger, &w.account, "lender_repay", repay(20_000_000), one_yocto()).await;
    assert_refused(&refused, waiting);
    assert_eq!(w.state().await["evm"]["nonce"], 1);
    // The owner is held to neither rule.
    let own = c.call_in_background(&w.client, &w.account, "lender_repay", repay(5), one_yocto());
    // Its request reaches the signer, which never answers and gives up after 200 blocks.
    let mut asked = false;
    for _ in 0..80 {
        let pending: Vec<Value> = c.view(&w.mpc, "pending_requests", json!({})).await;
        asked = pending.iter().any(|p| p["signer_id"] == json!(w.account));
        if asked {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(asked, "the owner's repayment never reached the MPC mock");
    c.fast_forward(210).await;
    let timed_out = own.await.unwrap();
    assert_eq!(timed_out.clone().json::<Value>().unwrap(), Value::Null);
    assert!(timed_out.logs().iter().any(|log| log.starts_with("no Ethereum transaction signed")), "{timed_out:?}");
}

#[tokio::test]
async fn x2_and_f2_the_factory_refuses_a_19_decimal_rhea_collateral_and_says_how_much_gas_it_needs() {
    let w = World::new().await;
    let c = &w.chain;
    // X2: Rhea counts every token in 18 decimals, so a collateral token with more is refused in the config.
    let mut config: Value = c.view(&w.factory, "get_config", json!({})).await;
    config["tokens"].as_array_mut().unwrap().push(json!({ "id": "wide.testnet", "symbol": "WIDE", "decimals": 19 }));
    c.ok(&w.operator, &w.factory, "set_config", json!({ "config": config })).await;
    let mut with_rhea = config.clone();
    with_rhea["lenders"]["rhea"] = json!({ "contract_id": "rhea.testnet", "collateral": ["wide.testnet"] });
    let refused = c.call(&w.operator, &w.factory, "set_config", json!({ "config": with_rhea.clone() }), yocto(0)).await;
    assert_refused(&refused, "lenders.rhea.collateral tokens have at most 18 decimals");
    with_rhea["tokens"][2]["decimals"] = json!(18);
    c.ok(&w.operator, &w.factory, "set_config", json!({ "config": with_rhea })).await;
    // Put the config back: the other tokens here aren't real contracts.
    config["tokens"].as_array_mut().unwrap().pop();
    c.ok(&w.operator, &w.factory, "set_config", json!({ "config": config })).await;

    // F2: with 2 tokens `create_account` needs 180 TGas, says so, and works on exactly that.
    let args = |name: &str| json!({ "name": name, "owner": w.client });
    let six = NearToken::from_near(6);
    let short = call_with_gas(c, &w.client, &w.factory, "create_account", args("bob"), six, 179).await;
    assert_refused(&short, "attach at least 180 TGas: 300 TGas is the safe amount");
    let made = call_with_gas(c, &w.client, &w.factory, "create_account", args("bob"), six, 180).await;
    assert_ok(&made, "create_account with 180 TGas");
    assert!(made.clone().json::<bool>().unwrap(), "create_account reported a failed step: {made:?}");
    println!("GAS  create_account with 2 tokens burnt {:.1} TGas of 180", made.total_gas_burnt.as_gas() as f64 / 1e12);
    let bob: AccountId = format!("bob.{}", w.factory).parse().unwrap();
    let state: Value = c.view(&bob, "get_state", json!({})).await;
    // Opened without a permission, it has none and no block for one.
    assert_eq!((state["permission"].clone(), state["permission_blk"].clone()), (Value::Null, json!(0)));
}

#[tokio::test]
async fn a12_a_sale_that_says_what_to_expect_is_settled_only_by_a_credible_delivery() {
    // research/audit.md, A12, the rest (INTERFACES.md 47.3): the owner sells 0.00055 mNBTC through 1Click, and the
    // quote says $40 will arrive.
    let w = World::new().await;
    let c = &w.chain;
    let dep = c.account("dep", 5).await;
    let stranger = c.account("stranger", 5).await;
    let solver = c.account("solver", 5).await;
    let expect = json!({ "token": w.musdc, "amount": "40000000" });
    let transfer = json!({ "kind": "sell", "exp": w.now_ms().await + 10 * MINUTE_MS, "expect": expect });
    let args = json!({ "token": w.mnbtc, "amount": "55000", "receiver": dep, "transfer": transfer });
    assert_ok(&w.owner_call("withdraw", args).await, "the sale");
    assert_eq!(w.transfers().await[0]["expect"], expect);
    assert_eq!(token_balance(c, &w.mnbtc, &dep).await, 55_000);

    // The hole: one unit of a listed token with the sale's msg, from anyone, settled it. Now it is kept as a
    // deposit and the record stays, and so is anything under 80% of what the quote said.
    let msg = json!({ "pb": { "transfer": "move:0" } }).to_string();
    for (from, amount) in [(&stranger, 1u128), (&solver, 31_999_999)] {
        mint(c, &w.musdc, from, amount).await;
        let args = json!({ "receiver_id": w.account, "amount": amount.to_string(), "msg": msg });
        let sent = c.call(from, &w.musdc, "ft_transfer_call", args, one_yocto()).await;
        assert_ok(&sent, "the deposit with the sale's msg");
        let kept = "kept as a deposit: not the delivery or the refund of transfer move:0";
        assert!(sent.logs().contains(&kept), "{sent:?}");
        assert!(events(&sent, "transfer_done").is_empty());
    }
    assert_eq!(w.transfers().await.len(), 1);
    // The solver's delivery, $39.80 of the $40, settles it as arrived.
    mint(c, &w.musdc, &solver, 39_800_000).await;
    let args = json!({ "receiver_id": w.account, "amount": "39800000", "msg": msg });
    let delivered = c.call(&solver, &w.musdc, "ft_transfer_call", args, one_yocto()).await;
    assert_ok(&delivered, "the delivery");
    assert_eq!(events(&delivered, "transfer_done"), vec![json!({ "id": "move:0", "how": "arrived" })]);
    assert!(w.transfers().await.is_empty());

    // A second sale is refunded: the token it sent, all of it, back from the deposit address.
    let transfer = json!({ "kind": "sell", "exp": w.now_ms().await + 10 * MINUTE_MS, "expect": expect });
    let args = json!({ "token": w.mnbtc, "amount": "55000", "receiver": dep, "transfer": transfer });
    assert_ok(&w.owner_call("withdraw", args).await, "the second sale");
    let msg = json!({ "pb": { "transfer": "move:1" } }).to_string();
    let args = json!({ "receiver_id": w.account, "amount": "55000", "msg": msg });
    let refunded = c.call(&dep, &w.mnbtc, "ft_transfer_call", args, one_yocto()).await;
    assert_ok(&refunded, "the refund");
    assert_eq!(events(&refunded, "transfer_done"), vec![json!({ "id": "move:1", "how": "refunded" })]);
    // `expect` must name a listed token, and only a sale takes one here.
    let bad = json!({ "kind": "to_evm", "exp": w.now_ms().await + 10 * MINUTE_MS, "expect": expect });
    let args = json!({ "token": w.mnbtc, "amount": "5", "receiver": dep, "transfer": bad });
    assert_refused(&w.owner_call("withdraw", args).await, "only a sell move takes expect");
}
