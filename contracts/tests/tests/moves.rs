//! The owner's moves between NEAR and the account's address on Aave's chain, with the pool, the factory and the MPC
//! mock (INTERFACES.md 36; FUNDING.md 6.4 and 9).
//!
//! The sandbox has no Ethereum chain and no 1Click, so the test plays both: it is the engine (its verdicts say what
//! has arrived at the address), the signer (it answers `sign` with the signature Node made for exactly that
//! transaction, `contracts/account/evm-vectors.mjs`) and 1Click (a deposit address on NEAR, and a solver that pays a
//! delivery or a refund with the transfer's msg). The world is `tests/aave.rs`'s.
//!
//! - `to_evm`: `withdraw` with a transfer sends a token to the deposit address and records `move:<n>`. A verdict
//!   that lists it in `arrived` settles it; so does its refund on NEAR.
//! - `e_home`: `evm_withdraw` with `exp` signs the transfer on Aave's chain and records `move:<n>`. The delivery on
//!   NEAR settles it. If the signer never signs, no transfer is left.
//! - Both without a loan from our pool, which needs no verdict, and with one, where each needs its own.
mod common;

use std::time::Duration;

use common::rhea::{mint, token_balance, NBTC};
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

/// Aave's test market on Base Sepolia (INTERFACES.md 24 and 33).
const AAVE_POOL: &str = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
const AAVE_USDC: &str = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
const WBTC: &str = "0x54114591963CF60EF3aA63bEfD6eC263D98145a4";
const WETH: &str = "0x4200000000000000000000000000000000000006";
/// 0.02 WETH, in its 18 decimals.
const WETH_AMOUNT: u128 = 20_000_000_000_000_000;
/// The stand-in's float on Aave's chain, which is every deposit address there (INTERFACES.md 36).
const FLOAT: &str = "0x2031181d63507368232579AF4c64a1c3428407fF";
/// The address of the MPC mock's fixed key, which every account in the sandbox gets (`tests/account.rs`).
const ADDRESS: &str = "0xd7f35513286b7a0c2a7d8648c72588751ce0dd7c";

/// A sandbox with both test tokens, a funded pool, the OutLayer and MPC mocks, the factory with Aave in its config,
/// a client whose account holds 1 mNBTC and $50, a 1Click deposit address on NEAR, and a solver.
struct World {
    chain: Chain,
    musdc: AccountId,
    mnbtc: AccountId,
    pool: AccountId,
    outlayer: AccountId,
    mpc: AccountId,
    operator: AccountId,
    client: AccountId,
    account: AccountId,
    dep: AccountId,
    solver: AccountId,
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
        let dep = chain.account("dep", 5).await;
        let solver = chain.account("solver", 5).await;
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
        // 1 gwei.
        let config = config(&musdc, &mnbtc, &pool, &outlayer, &chain.root);
        let init = json!({ "operator": operator, "config": config });
        let deployed = chain.contract("factory", 9, wasm("pb_factory"), Some(("new", init))).await;
        assert_eq!(deployed, factory);
        let account: AccountId = format!("alice.{factory}").parse().unwrap();
        let w = World { chain, musdc, mnbtc, pool, outlayer, mpc, operator, client, account, dep, solver };

        // The client opens its account, permits Aave in the same call, and deposits 1 mNBTC and $50.
        let terms = json!({ "lenders": ["aave"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any" });
        let args = json!({ "name": "alice", "owner": w.client, "permission": terms });
        let made = w.chain.call(&w.client, &factory, "create_account", args, NearToken::from_near(6)).await;
        assert_ok(&made, "create_account");
        assert!(made.clone().json::<bool>().unwrap(), "create_account reported a failed step: {made:?}");
        for (token, amount) in [(&w.mnbtc, NBTC), (&w.musdc, usd(50))] {
            mint(&w.chain, token, &w.client, amount).await;
            let args = json!({ "receiver_id": w.account, "amount": amount.to_string(), "msg": "" });
            w.chain.ok_with(&w.client, token, "ft_transfer_call", args, one_yocto()).await;
        }
        w
    }

    async fn state(&self) -> Value {
        self.chain.view(&self.account, "get_state", json!({})).await
    }

    async fn counter(&self) -> u64 {
        self.state().await["counter"].as_u64().unwrap()
    }

    /// The pending entries of one sort, `transfer` (1Click) or `lender` (a signed action on Aave's chain).
    async fn pending(&self, sort: &str) -> Vec<Value> {
        self.state().await["pending"].as_array().unwrap().iter().filter_map(|p| p.get(sort).cloned()).collect()
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

    /// As `check`, for a check whose transaction the test doesn't look at.
    async fn accept(&self, intent: Value, shape: impl FnOnce(&mut Value)) {
        let _ = self.check(intent, shape).await;
    }

    /// The owner calls `method` in the background, and the test waits for its `sign` request to reach the MPC mock:
    /// the request `wanted`, or with none the account's first. Returns the request and the call.
    async fn start_signing(
        &self,
        method: &'static str,
        args: Value,
        wanted: Option<&Value>,
    ) -> (Value, tokio::task::JoinHandle<ExecutionFinalResult>) {
        let call = self.chain.call_in_background(&self.client, &self.account, method, args, one_yocto());
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

    /// The owner's `evm_withdraw` with these arguments, which must ask the signer to sign exactly the transaction
    /// `tx` that Node built. The mock answers with Node's signature. Returns the entry the account kept.
    async fn signed_transfer(&self, args: Value, tx: &Value) -> Value {
        let (request, call) = self.start_signing("evm_withdraw", args, Some(&sign_request(tx))).await;
        let args = json!({ "signer_id": self.account, "request": request, "response": signer_answer(tx) });
        self.chain.ok(&self.operator, &self.mpc, "respond", args).await;
        let result = call.await.unwrap();
        assert_ok(&result, "evm_withdraw");
        let entry = result.json::<Value>().unwrap();
        assert_eq!((entry["raw"].clone(), entry["hash"].clone()), (tx["raw"].clone(), tx["hash"].clone()));
        entry
    }

    /// 1Click pays the account `amount` of `token` on NEAR from `from`, with the msg of transfer `id`: a delivery
    /// from the solver, or a refund from the deposit address.
    async fn pay(&self, from: &AccountId, token: &AccountId, amount: u128, id: &str) -> ExecutionFinalResult {
        let msg = json!({ "pb": { "transfer": id } }).to_string();
        let args = json!({ "receiver_id": self.account, "amount": amount.to_string(), "msg": msg });
        let result = self.chain.call(from, token, "ft_transfer_call", args, one_yocto()).await;
        assert_ok(&result, "the 1Click payment");
        result
    }

    /// The `withdraw` arguments of a `to_evm` move of `amount` of `token`, on a quote with 10 minutes left.
    async fn to_evm(&self, token: &AccountId, amount: u128) -> Value {
        let exp = self.now_ms().await + 10 * MINUTE_MS;
        let transfer = json!({ "kind": "to_evm", "exp": exp });
        json!({ "token": token, "amount": amount.to_string(), "receiver": self.dep, "transfer": transfer })
    }

    /// The `evm_withdraw` arguments of an `e_home` move of `amount` of `token`, on a quote with 10 minutes left.
    async fn e_home(&self, token: &str, amount: u128) -> Value {
        let exp = self.now_ms().await + 10 * MINUTE_MS;
        json!({ "token": token, "amount": amount.to_string(), "to": FLOAT, "exp": exp })
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

fn plain() -> Value {
    json!({ "check": {} })
}

/// The move home that Node built and signed for the sandbox (`contracts/account/evm-vectors.mjs`): $20 of USDC
/// sent to the float, as an account's first transaction on Aave's chain.
fn node_home() -> Value {
    let vectors: Value = serde_json::from_str(include_str!("../../account/src/evm_vectors.json")).unwrap();
    let list = vectors["sandbox"]["transactions"].as_array().unwrap();
    list.iter().find(|tx| tx["name"] == "home_usdc").expect("Node built no move home").clone()
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
    json!({ "big_r": { "affine_point": big_r }, "s": { "scalar": part("s") }, "recovery_id": parity })
}

/// The data of the `pb-pool` events with this name that a transaction logged.
fn events(result: &ExecutionFinalResult, name: &str) -> Vec<Value> {
    let logs = result.logs();
    let events = logs.iter().filter_map(|log| log.strip_prefix("EVENT_JSON:"));
    let parsed = events.filter_map(|text| serde_json::from_str::<Value>(text).ok());
    parsed.filter(|e| e["standard"] == "pb-pool" && e["event"] == name).map(|e| e["data"].clone()).collect()
}

/// What a recorded transfer must show, apart from its deadline.
fn shown(transfer: &Value) -> Value {
    let mut shown = transfer.clone();
    shown.as_object_mut().unwrap().remove("deadline");
    shown
}

#[tokio::test]
async fn with_no_loan_from_our_pool_the_owners_moves_are_recorded_and_settled_without_a_verdict() {
    let w = World::new().await;
    let c = &w.chain;

    // Nothing moves towards Aave's chain before the account knows its address there.
    let early = w.owner_call("withdraw", w.to_evm(&w.mnbtc, 55_000).await).await;
    assert_refused(&early, "no Ethereum address yet: call hl_init first");
    let init = c.call(&w.operator, &w.account, "hl_init", json!({}), yocto(0)).await;
    assert_ok(&init, "hl_init");
    assert_eq!(init.json::<Value>().unwrap(), json!(ADDRESS));

    // to_evm, collateral: the owner sends 0.00055 mNBTC to 1Click's deposit address. It needs no verdict, and is
    // recorded as move:0 with the token's id.
    let sent = w.owner_call("withdraw", w.to_evm(&w.mnbtc, 55_000).await).await;
    assert_ok(&sent, "the move of bitcoin to Aave's chain");
    let bitcoin = json!({ "id": "move:0", "kind": "to_evm", "token": w.mnbtc, "amount": "55000", "dep": w.dep });
    let pending = w.pending("transfer").await;
    assert_eq!(pending.iter().map(shown).collect::<Vec<_>>(), vec![bitcoin]);
    assert_eq!(token_balance(c, &w.mnbtc, &w.dep).await, 55_000);
    let state = w.state().await;
    assert_eq!((state["next_move"].clone(), state["counter"].clone()), (json!(1), json!(2)));
    // The account can't see Aave's chain. A verdict that doesn't list the transfer leaves it under way, and one
    // that lists it in `arrived` settles it.
    w.accept(plain(), |_| {}).await;
    assert_eq!(w.pending("transfer").await.len(), 1);
    let seen = w.check(plain(), |v| v["arrived"] = json!(["move:0"])).await;
    assert_eq!(events(&seen, "transfer_done"), vec![json!({ "id": "move:0", "how": "verdict" })]);
    assert!(w.pending("transfer").await.is_empty());

    // to_evm, USDC: $20 goes the same way (move:1), and this time 1Click refunds it on NEAR with the msg.
    let sent = w.owner_call("withdraw", w.to_evm(&w.musdc, usd(20)).await).await;
    assert_ok(&sent, "the move of USDC to Aave's chain");
    let dollars = json!({ "id": "move:1", "kind": "to_evm", "token": w.musdc, "amount": "20000000", "dep": w.dep });
    assert_eq!(w.pending("transfer").await.iter().map(shown).collect::<Vec<_>>(), vec![dollars]);
    assert_eq!(token_balance(c, &w.musdc, &w.account).await, usd(30));
    let refunded = w.pay(&w.dep, &w.musdc, usd(20), "move:1").await;
    assert_eq!(events(&refunded, "transfer_done"), vec![json!({ "id": "move:1", "how": "refunded" })]);
    assert!(w.pending("transfer").await.is_empty());
    assert_eq!(token_balance(c, &w.musdc, &w.account).await, usd(50));

    // e_home, the loan: the owner has the account sign transfer(the float, $20) of Aave's USDC, with the quote's
    // expiry. The account asks the signer for exactly the hash Node signed and keeps Node's transaction.
    let entry = w.signed_transfer(w.e_home(AAVE_USDC, 20_000_000).await, &node_home()).await;
    let kept = (entry["nonce"].clone(), entry["kind"].clone(), entry["token"].clone(), entry["to"].clone());
    assert_eq!(kept, (json!(0), json!("transfer"), json!(AAVE_USDC.to_lowercase()), json!(AAVE_USDC.to_lowercase())));
    // It is recorded as move:2: the USDC is named as Hyperliquid's is, and the deposit address is in lower case.
    let home = json!({
        "id": "move:2", "kind": "e_home", "token": "USDC", "amount": "20000000", "dep": FLOAT.to_lowercase(),
    });
    assert_eq!(w.pending("transfer").await.iter().map(shown).collect::<Vec<_>>(), vec![home]);
    // The signed transfer is also listed as under way on Aave's chain, as it is without `exp`.
    let listed = json!({
        "lender": "aave", "kind": "transfer", "amount": "20000000", "token": AAVE_USDC.to_lowercase(), "evm_nonce": 0,
    });
    assert_eq!(w.pending("lender").await, vec![listed.clone()]);
    // 1Click's solver delivers $19.90 on NEAR with the msg: the transfer has arrived.
    mint(c, &w.musdc, &w.solver, 19_900_000).await;
    let delivered = w.pay(&w.solver, &w.musdc, 19_900_000, "move:2").await;
    assert_eq!(events(&delivered, "transfer_done"), vec![json!({ "id": "move:2", "how": "arrived" })]);
    assert!(w.pending("transfer").await.is_empty());
    assert_eq!(token_balance(c, &w.musdc, &w.account).await, usd(50) + 19_900_000);
    // The signed transfer stays listed until a verdict shows that Aave's chain has used its nonce.
    assert_eq!(w.pending("lender").await, vec![listed]);
    w.accept(plain(), |v| v["evm"] = json!({ "nonce": 1 })).await;
    assert!(w.pending("lender").await.is_empty());

    // e_home, collateral, with a signer that never answers: the move is recorded and listed while it waits.
    let (_, call) = w.start_signing("evm_withdraw", w.e_home(WETH, WETH_AMOUNT).await, None).await;
    let waiting = json!({
        "id": "move:3", "kind": "e_home", "token": WETH, "amount": WETH_AMOUNT.to_string(),
        "dep": FLOAT.to_lowercase(),
    });
    assert_eq!(w.pending("transfer").await.iter().map(shown).collect::<Vec<_>>(), vec![waiting]);
    assert_eq!(w.pending("lender").await.len(), 1);
    // The signer gives up after 200 blocks. Nothing was signed, so no transfer is left and nothing is listed.
    c.fast_forward(210).await;
    let timed_out = call.await.unwrap();
    assert_eq!(timed_out.clone().json::<Value>().unwrap(), Value::Null);
    assert!(timed_out.logs().contains(&"transfer move:3 didn't go out: nothing was sent"), "{timed_out:?}");
    let state = w.state().await;
    assert_eq!(state["pending"], json!([]));
    assert_eq!((state["next_move"].clone(), state["evm"]["nonce"].clone()), (json!(4), json!(1)));
}

#[tokio::test]
async fn while_the_account_owes_our_pool_each_move_needs_a_verdict_for_exactly_it() {
    let w = World::new().await;
    let c = &w.chain;
    assert_ok(&c.call(&w.client, &w.account, "hl_init", json!({}), yocto(0)).await, "hl_init");

    // The owner borrows $10 from our pool.
    w.accept(json!({ "borrow": { "amount": "10000000" } }), |_| {}).await;
    assert_ok(&w.owner_call("borrow", json!({ "amount": "10000000" })).await, "borrow");
    assert_eq!(w.state().await["loan"]["open"], true);

    // to_evm: the borrow's verdict is used up, and a plain check doesn't answer a withdrawal.
    let used = w.owner_call("withdraw", w.to_evm(&w.mnbtc, 55_000).await).await;
    assert_refused(&used, "the verdict was already used: ask for a new check");
    w.accept(plain(), |_| {}).await;
    let other = w.owner_call("withdraw", w.to_evm(&w.mnbtc, 55_000).await).await;
    assert_refused(&other, "with a loan open, a withdrawal needs a verdict for this token and amount");
    assert!(w.pending("transfer").await.is_empty());
    // A verdict for a withdrawal of this token and amount, which the engine allows, lets it out.
    let asked = json!({ "withdraw": { "token": w.mnbtc, "amount": "55000" } });
    w.accept(asked, |v| v["allow"]["withdraw"] = json!(55_000)).await;
    let sent = w.owner_call("withdraw", w.to_evm(&w.mnbtc, 55_000).await).await;
    assert_ok(&sent, "the move of bitcoin to Aave's chain");
    let bitcoin = json!({ "id": "move:0", "kind": "to_evm", "token": w.mnbtc, "amount": "55000", "dep": w.dep });
    assert_eq!(w.pending("transfer").await.iter().map(shown).collect::<Vec<_>>(), vec![bitcoin]);
    assert_eq!(token_balance(c, &w.mnbtc, &w.dep).await, 55_000);
    // The next check finds it at the address.
    let seen = w.check(plain(), |v| v["arrived"] = json!(["move:0"])).await;
    assert_eq!(events(&seen, "transfer_done"), vec![json!({ "id": "move:0", "how": "verdict" })]);

    // e_home: the same. A plain check doesn't answer it; a verdict for an `evm_withdraw` of this token and amount
    // does.
    let other = w.owner_call("evm_withdraw", w.e_home(AAVE_USDC, 20_000_000).await).await;
    assert_refused(&other, "with a loan open, an Ethereum withdrawal needs a verdict for this token and amount");
    assert!(w.pending("transfer").await.is_empty() && w.pending("lender").await.is_empty());
    let asked = json!({ "evm_withdraw": { "token": AAVE_USDC.to_lowercase(), "amount": "20000000" } });
    w.accept(asked, |v| v["allow"]["withdraw"] = json!(20_000_000)).await;
    w.signed_transfer(w.e_home(AAVE_USDC, 20_000_000).await, &node_home()).await;
    let home = json!({
        "id": "move:1", "kind": "e_home", "token": "USDC", "amount": "20000000", "dep": FLOAT.to_lowercase(),
    });
    assert_eq!(w.pending("transfer").await.iter().map(shown).collect::<Vec<_>>(), vec![home]);
    assert_eq!(w.pending("lender").await.len(), 1);
    // That verdict backs nothing more: a second move home needs a new one.
    let again = w.owner_call("evm_withdraw", w.e_home(AAVE_USDC, 20_000_000).await).await;
    assert_refused(&again, "is still under way");

    // The delivery on NEAR settles the transfer, and a verdict that has seen the nonce used ends the listing.
    mint(c, &w.musdc, &w.solver, 19_900_000).await;
    let delivered = w.pay(&w.solver, &w.musdc, 19_900_000, "move:1").await;
    assert_eq!(events(&delivered, "transfer_done"), vec![json!({ "id": "move:1", "how": "arrived" })]);
    w.accept(plain(), |v| v["evm"] = json!({ "nonce": 1 })).await;
    let state = w.state().await;
    assert_eq!((state["pending"].clone(), state["loan"]["open"].clone()), (json!([]), json!(true)));
    let debt: Value = c.view(&w.pool, "debt_of", json!({ "account_id": w.account })).await;
    assert!(str_u128(&debt) >= 10_000_000, "the account owes our pool {debt}");
}
