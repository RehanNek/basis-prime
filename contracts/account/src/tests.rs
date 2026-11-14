//! Unit tests: at least one for every rule, with the block height, time and promise results under the test's
//! control. The sandbox tests in `contracts/tests/tests/account.rs` run the whole flow against the real pool, tokens
//! and the OutLayer mock.
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

use crate::*;

const ACCOUNT: &str = "alice.pbf.testnet";
const OWNER: &str = "owner.testnet";
const POOL: &str = "pool.pbf.testnet";
const USDC: &str = "musdc.testnet";
const NBTC: &str = "mnbtc.testnet";
const OUTLAYER: &str = "outlayer.testnet";
const MPC: &str = "v1.signer-prod.testnet";
const H0: u64 = 1_000;
const T0: u64 = 1_700_000_000 * 1_000_000_000;

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn params() -> String {
    "cd".repeat(32)
}

fn config() -> Config {
    Config {
        tokens: vec![
            TokenConfig { id: id(USDC), symbol: "USDC".into(), decimals: 6 },
            TokenConfig { id: id(NBTC), symbol: "nBTC".into(), decimals: 8 },
        ],
        pool_id: id(POOL),
        mpc_id: id(MPC),
        outlayer_id: id(OUTLAYER),
        risk: Program { project_id: "pbf-keeper.testnet/pb-risk".into(), version_key: "ab".repeat(32) },
        hl_chain: "Testnet".into(),
        signature_chain_id: "0x66eee".into(),
        usdc_token: id(USDC),
        params_hash: params(),
        model: "B-0.2".into(),
        drill_id: id("drill.pbf-ops.testnet"),
        gateway: Gateway {
            project_id: "pbf-keeper.testnet/pb-gateway".into(),
            version_key: "12".repeat(32),
            secrets_ref: None,
        },
        hl_usdc_token: HL_USDC.into(),
        lenders: Default::default(),
    }
}

/// Sets the caller, attached deposit, block height and time, and the promise results a callback sees.
fn ctx(who: &str, yocto: u128, height: u64, now: u64, results: Vec<PromiseResult>) {
    let context = VMContextBuilder::new()
        .current_account_id(id(ACCOUNT))
        .predecessor_account_id(id(who))
        .attached_deposit(NearToken::from_yoctonear(yocto))
        .block_height(height)
        .block_timestamp(now)
        .prepaid_gas(Gas::from_tgas(300))
        .build();
    testing_env!(context, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
}

fn at(who: &str, yocto: u128, height: u64) {
    ctx(who, yocto, height, T0 + (height - H0) * 600_000_000, vec![]);
}

fn account() -> Account {
    at("pbf.testnet", 0, H0);
    Account::new(id(OWNER), config(), None)
}

/// A verdict in the Appendix A shape: HEALTHY, Standard, allowing a $10k borrow and a $5k USDC withdrawal.
fn verdict(nonce: u64, blk: u64) -> Value {
    json!({
        "ok": true, "v": 1, "model": "B-0.2", "params": params(), "acct": ACCOUNT,
        "blk": blk, "nonce": nonce,
        "eq": 40_500_000_000i64, "eq_allow": 40_500_000_000i64, "mm": 15_616_000_000u64, "im": 19_520_000_000u64,
        "state": "HEALTHY", "action": "NONE", "since": 0,
        "score": 700, "tier": "STANDARD", "rate_bp": 650,
        "allow": { "withdraw": 5_000_000_000u64, "borrow": 10_000_000_000u64 },
        "credit": { "line": 94_500_000_000u64, "binding": "C4" },
        "volf_bp": 10_000, "top": ["replay 13 Mar 2020 rebound"], "topup": 0,
        "venues": { "hl_margin_ratio_bp": 357 },
        "pool": { "shares_bp": { "nBTC": 7_407 }, "hold": { "nBTC": 100_000_000_000u64 }, "hl_eq": 35_000_000_000i64 },
        "hr_bp": 10_000, "hr7_bp": 10_000, "exp_bp": 49_383,
        "bands": {}, "coins": { "uncertain": [], "stale": [], "reduce_only": [] },
        "plan": [], "in": "ef".repeat(32),
    })
}

/// OutLayer's answer arriving at `height` (and the matching time).
fn deliver_at(a: &mut Account, intent: Intent, answer: &Value, height: u64, now: u64) -> CheckOutcome {
    let bytes = near_sdk::serde_json::to_vec(answer).unwrap();
    ctx(ACCOUNT, 0, height, now, vec![PromiseResult::Successful(bytes)]);
    a.on_verdict(intent)
}

fn deliver(a: &mut Account, intent: Intent, answer: &Value, height: u64) -> CheckOutcome {
    deliver_at(a, intent, answer, height, T0 + (height - H0) * 600_000_000)
}

fn borrow_intent(amount: u128) -> Intent {
    Intent::Borrow { amount: U128(amount) }
}

fn withdraw_intent(token: &str, amount: u128) -> Intent {
    Intent::Withdraw { token: id(token), amount: U128(amount) }
}

/// The function calls the last call created: receiver, method, JSON arguments and deposit.
fn calls() -> Vec<(AccountId, String, Value, NearToken)> {
    let mut out = Vec::new();
    for receipt in get_created_receipts() {
        for action in receipt.actions {
            if let MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } = action {
                let args = near_sdk::serde_json::from_slice(&args).unwrap_or(Value::Null);
                let method = String::from_utf8(method_name).unwrap();
                out.push((receipt.receiver_id.clone(), method, args, attached_deposit));
            }
        }
    }
    out
}

/// The pool lent `amount`: its loan transfer arrived.
fn book_loan(a: &mut Account, amount: u128, height: u64) {
    at(USDC, 0, height);
    let kept = a.ft_on_transfer(id(POOL), U128(amount), r#"{"pb":{"loan":{}}}"#.into());
    assert!(matches!(kept, PromiseOrValue::Value(U128(0))));
}

/// The counter once the $1,000 loan has arrived: the borrow bumped it as it started and again as it ended.
const LOANED: u64 = 2;

/// An account with an open $1,000 loan, its borrow verdict used, at block H0 + 10. Its counter is `LOANED`.
fn with_loan() -> Account {
    let mut a = account();
    assert!(deliver(&mut a, borrow_intent(1_000_000_000), &verdict(0, H0 + 5), H0 + 8).accepted);
    at(OWNER, 1, H0 + 10);
    a.borrow(U128(1_000_000_000)).detach();
    book_loan(&mut a, 1_000_000_000, H0 + 11);
    ctx(ACCOUNT, 0, H0 + 12, T0, vec![PromiseResult::Successful(b"\"1000000000\"".to_vec())]);
    assert!(a.on_borrowed(U128(1_000_000_000)));
    a
}

// ---------------------------------------------------------------------------------------------------------------
// new and the views
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn a_new_account_keeps_its_owner_and_config_and_starts_its_counter_at_zero() {
    let a = account();
    assert_eq!(a.get_config(), config());
    let s = a.get_state();
    assert_eq!((s.owner, s.counter, s.blocked), (id(OWNER), 0, false));
    assert_eq!(s.loan, Loan::default());
    assert!(s.verdict.is_none() && s.hourly.is_empty() && s.pending.is_empty());
    assert_eq!(s.hl, Hl::new());
    assert_eq!((s.hl.path.as_str(), s.hl.address, s.hl.agent), ("hyperliquid-1", None, None));
}

#[test]
fn the_state_view_has_the_interfaces_shape() {
    let mut a = account();
    deliver(&mut a, borrow_intent(5), &verdict(0, H0), H0 + 2);
    let s = near_sdk::serde_json::to_value(a.get_state()).unwrap();
    let keys: Vec<&str> = s.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    let expected = ["owner", "counter", "blocked", "loan", "verdict", "margin_call", "deleverage", "hourly"];
    for key in expected.into_iter().chain(["pending", "hl"]) {
        assert!(keys.contains(&key), "no {key} in {s}");
    }
    assert_eq!(s["counter"], json!(0));
    assert_eq!(s["loan"], json!({ "principal": "0", "open": false }));
    assert_eq!(s["verdict"]["intent"], json!({ "borrow": { "amount": "5" } }));
    assert_eq!(s["verdict"]["received_block"], json!(H0 + 2));
    assert_eq!(s["verdict"]["verdict"], verdict(0, H0));
    assert_eq!(s["margin_call"], json!({ "since": "0", "below": false, "intervals": [] }));
    assert_eq!(s["deleverage"], json!({ "first_at": "0" }));
    assert_eq!((s["plan"].clone(), s["next_move"].clone()), (Value::Null, json!(0)));
    assert_eq!(s["hourly"][0]["hr_bp_min"], json!(10_000));
    let hl = json!({
        "path": "hyperliquid-1", "address": null, "agent": null, "next_nonce_ms": "0", "send_open_until_ms": "0",
        "open_sends": [], "send_floor_until_ms": "0", "signed": [],
    });
    assert_eq!(s["hl"], hl);
}

// ---------------------------------------------------------------------------------------------------------------
// ft_on_transfer
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn deposits_of_listed_tokens_are_kept() {
    let mut a = account();
    for (token, msg) in [(USDC, ""), (NBTC, ""), (NBTC, r#"{"pb":{"deposit":{}}}"#)] {
        at(token, 0, H0);
        assert!(matches!(a.ft_on_transfer(id(OWNER), U128(7), msg.into()), PromiseOrValue::Value(U128(0))));
    }
    assert_eq!(a.get_state().loan, Loan::default());
}

#[test]
fn any_other_token_is_returned_in_full() {
    let mut a = account();
    at("other.testnet", 0, H0);
    assert!(matches!(a.ft_on_transfer(id(OWNER), U128(7), String::new()), PromiseOrValue::Value(U128(7))));
}

#[test]
fn a_loan_from_the_pool_is_booked() {
    let mut a = account();
    book_loan(&mut a, 50_000_000_000, H0);
    assert_eq!(a.get_state().loan, Loan { principal: U128(50_000_000_000), open: true });
}

#[test]
fn a_loan_message_from_anyone_but_the_pool_or_in_another_token_is_returned() {
    let mut a = account();
    at(USDC, 0, H0);
    let loan = r#"{"pb":{"loan":{}}}"#;
    assert!(matches!(a.ft_on_transfer(id(OWNER), U128(7), loan.into()), PromiseOrValue::Value(U128(7))));
    at(NBTC, 0, H0);
    assert!(matches!(a.ft_on_transfer(id(POOL), U128(7), loan.into()), PromiseOrValue::Value(U128(7))));
    assert_eq!(a.get_state().loan, Loan::default());
}

#[test]
fn an_unknown_message_is_returned() {
    let mut a = account();
    at(USDC, 0, H0);
    // Phase 4 made `{"pb":{"transfer":"<id>"}}` a known message; a transfer id must be a string.
    for msg in [r#"{"pb":{"swap":{}}}"#, r#"{"pb":{"transfer":7}}"#, "hello"] {
        let back = a.ft_on_transfer(id(OWNER), U128(7), msg.into());
        assert!(matches!(back, PromiseOrValue::Value(U128(7))), "{msg}");
    }
}

// ---------------------------------------------------------------------------------------------------------------
// request_check
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn a_check_runs_the_pinned_program_with_the_right_input_and_limits() {
    let mut a = account();
    let deposit = NearToken::from_millinear(10).as_yoctonear();
    at("keeper.testnet", deposit, H0);
    a.request_check(withdraw_intent(NBTC, 5)).detach();
    let calls = calls();
    let (to, method, args, attached) = &calls[0];
    assert_eq!((to.as_str(), method.as_str(), attached.as_yoctonear()), (OUTLAYER, "request_execution", deposit));
    let source = json!({ "Project": { "project_id": "pbf-keeper.testnet/pb-risk", "version_key": "ab".repeat(32) } });
    assert_eq!(args["source"], source);
    let limits = json!({ "max_instructions": 2_000_000_000u64, "max_memory_mb": 256, "max_execution_seconds": 20 });
    assert_eq!(args["resource_limits"], limits);
    assert_eq!(args["response_format"], "Json");
    assert_eq!(args["secrets_ref"], Value::Null);
    // OutLayer refunds the unused deposit to whoever paid for the check.
    assert_eq!(args["payer_account_id"], "keeper.testnet");
    let input: Value = near_sdk::serde_json::from_str(args["input_data"].as_str().unwrap()).unwrap();
    let expected = json!({
        "mode": "check", "account": ACCOUNT, "network": "testnet", "snapshot": false,
        "intent": { "withdraw": { "token": NBTC, "amount": "5" } },
    });
    assert_eq!(input, expected);
    // The answer goes to on_verdict, with the intent.
    assert_eq!((calls[1].0.as_str(), calls[1].1.as_str()), (ACCOUNT, "on_verdict"));
    assert_eq!(calls[1].2["intent"], json!({ "withdraw": { "token": NBTC, "amount": "5" } }));
}

#[test]
#[should_panic(expected = "attach at least 0.01 NEAR for OutLayer")]
fn a_check_needs_a_deposit_for_outlayer() {
    let mut a = account();
    at(OWNER, NearToken::from_millinear(9).as_yoctonear(), H0);
    a.request_check(Intent::Check {}).detach();
}

#[test]
#[should_panic(expected = "no pb-risk version is pinned")]
fn no_check_runs_before_a_version_is_pinned() {
    at("pbf.testnet", 0, H0);
    let mut c = config();
    c.risk.version_key = String::new();
    let mut a = Account::new(id(OWNER), c, None);
    at(OWNER, NearToken::from_millinear(10).as_yoctonear(), H0);
    a.request_check(Intent::Check {}).detach();
}

#[test]
#[should_panic(expected = "not an allow-listed token")]
fn a_withdraw_intent_must_name_a_listed_token() {
    let mut a = account();
    at(OWNER, NearToken::from_millinear(10).as_yoctonear(), H0);
    a.request_check(withdraw_intent("other.testnet", 5)).detach();
}

// ---------------------------------------------------------------------------------------------------------------
// on_verdict: accepting a verdict
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn a_good_verdict_is_kept_with_its_intent_and_arrival_block() {
    let mut a = account();
    let outcome = deliver(&mut a, borrow_intent(9), &verdict(0, H0 + 3), H0 + 14);
    assert_eq!(outcome, CheckOutcome { accepted: true, reason: None });
    let held = a.verdict.clone().unwrap();
    assert_eq!((held.intent, held.received_block, held.verdict.blk), (borrow_intent(9), H0 + 14, H0 + 3));
    assert!(get_logs()[0].starts_with("verdict accepted"));
}

/// The verdict with one field changed is refused for `reason`, nothing is kept, and the log says why.
fn refused_with(change: impl FnOnce(&mut Value), reason: &str) {
    let mut a = account();
    let mut v = verdict(0, H0);
    change(&mut v);
    let outcome = deliver(&mut a, Intent::Check {}, &v, H0 + 5);
    assert!(!outcome.accepted, "accepted a verdict that should fail with {reason:?}");
    let why = outcome.reason.unwrap();
    assert!(why.contains(reason), "refused for {why:?}, not {reason:?}");
    assert_eq!(get_logs(), vec![format!("verdict refused: {why}")]);
    assert!(a.verdict.is_none() && a.hourly.is_empty(), "a refused verdict changed the state");
}

#[test]
fn a_verdict_that_is_not_ok_is_refused() {
    refused_with(|v| *v = json!({ "ok": false, "reason": "price stale" }), "ok is false: price stale");
}

#[test]
fn a_verdict_for_another_account_is_refused() {
    refused_with(|v| v["acct"] = json!("bob.pbf.testnet"), "acct bob.pbf.testnet is not this account");
}

#[test]
fn a_verdict_with_another_nonce_is_refused() {
    refused_with(|v| v["nonce"] = json!(1), "nonce 1 is not the counter 0");
}

#[test]
fn a_verdict_from_another_parameter_file_is_refused() {
    refused_with(|v| v["params"] = json!("00".repeat(32)), "is not this account's parameter file");
}

#[test]
fn a_verdict_from_another_model_is_refused() {
    refused_with(|v| v["model"] = json!("B-0.3"), "model B-0.3 is not this account's model B-0.2");
}

#[test]
fn a_verdict_from_a_later_block_is_refused() {
    refused_with(|v| v["blk"] = json!(H0 + 6), "is after the current block");
}

#[test]
fn a_malformed_verdict_is_refused() {
    refused_with(|v| v["eq"] = json!(1.5), "the verdict is malformed");
    refused_with(|v| v["state"] = json!("FINE"), "the verdict is malformed");
    refused_with(|v| drop(v.as_object_mut().unwrap().remove("allow")), "the verdict is malformed");
    refused_with(|v| *v = json!("hello"), "the answer is not a verdict");
}

#[test]
fn no_verdict_from_a_failed_or_timed_out_run_is_refused() {
    refused_with(|v| *v = Value::Null, "OutLayer returned no verdict");
    let mut a = account();
    ctx(ACCOUNT, 0, H0, T0, vec![PromiseResult::Failed]);
    assert_eq!(a.on_verdict(Intent::Check {}).reason.unwrap(), "OutLayer's call failed");
}

#[test]
fn a_verdict_over_4_kb_is_refused_unread() {
    let mut a = account();
    let mut v = verdict(0, H0);
    v["top"] = json!(["x".repeat(MAX_VERDICT_BYTES)]);
    let outcome = deliver(&mut a, Intent::Check {}, &v, H0 + 5);
    assert!(outcome.reason.unwrap().contains("-byte limit"));
    assert!(a.verdict.is_none());
}

#[test]
fn the_params_hash_matches_in_either_case() {
    let mut a = account();
    let mut v = verdict(0, H0);
    v["params"] = json!(params().to_uppercase());
    assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 5).accepted);
}

#[test]
fn a_verdict_older_than_the_one_held_is_refused() {
    let mut a = account();
    assert!(deliver(&mut a, Intent::Check {}, &verdict(0, H0 + 4), H0 + 6).accepted);
    let outcome = deliver(&mut a, borrow_intent(5), &verdict(0, H0 + 3), H0 + 7);
    assert!(outcome.reason.unwrap().contains("is older than the held verdict"));
    assert_eq!(a.verdict.as_ref().unwrap().intent, Intent::Check {});
}

#[test]
fn a_newer_verdict_replaces_the_held_one() {
    let mut a = account();
    deliver(&mut a, Intent::Check {}, &verdict(0, H0 + 4), H0 + 6);
    assert!(deliver(&mut a, borrow_intent(5), &verdict(0, H0 + 4), H0 + 7).accepted);
    assert_eq!(a.verdict.as_ref().unwrap().intent, borrow_intent(5));
}

// ---------------------------------------------------------------------------------------------------------------
// on_verdict: the records
// ---------------------------------------------------------------------------------------------------------------

fn margin_call(nonce: u64, blk: u64, since: u64) -> Value {
    let mut v = verdict(nonce, blk);
    v["state"] = json!("MARGIN_CALL");
    v["eq"] = json!(15_000_000_000i64);
    v["since"] = json!(since);
    v
}

#[test]
fn verdicts_below_the_buffer_run_the_margin_call_clock() {
    let mut a = account();
    let t1 = T0 + HOUR_NS;
    deliver_at(&mut a, Intent::Check {}, &margin_call(0, H0, t1), H0 + 2, t1);
    let t2 = t1 + 10 * MINUTE_NS;
    deliver_at(&mut a, Intent::Check {}, &margin_call(0, H0 + 3, t1), H0 + 5, t2);
    let m = a.get_state().margin_call;
    assert_eq!(m, MarginCall { since: U64(t1), below: true, intervals: vec![(U64(t1), U64(t2))] });
    // A HEALTHY verdict closes the interval at its arrival.
    let t3 = t2 + 5 * MINUTE_NS;
    deliver_at(&mut a, Intent::Check {}, &verdict(0, H0 + 6), H0 + 8, t3);
    let m = a.get_state().margin_call;
    assert_eq!(m, MarginCall { since: U64(0), below: false, intervals: vec![(U64(t1), U64(t3))] });
}

#[test]
fn with_no_loan_equity_below_the_buffer_does_not_count() {
    let mut a = account();
    let mut v = verdict(0, H0);
    v["eq"] = json!(0);
    deliver(&mut a, Intent::Check {}, &v, H0 + 2);
    assert!(a.get_state().margin_call.intervals.is_empty());
}

/// The drill's plan (INTERFACES.md 13): buy back part of the short through the gateway, then repay.
fn drill_plan() -> Value {
    json!([
        { "k": "perp", "coin": "BTC", "buy": true, "sz": "0.00375", "px": "76190" },
        { "k": "repay", "amt": 2_000_000_000u64 },
    ])
}

fn deleverage(blk: u64, ratio_bp: u32) -> Value {
    let mut v = verdict(0, blk);
    v["state"] = json!("DELEVERAGE");
    v["action"] = json!("DELEVERAGE");
    v["eq"] = json!(10_000_000_000i64);
    v["venues"]["hl_margin_ratio_bp"] = json!(ratio_bp);
    v["plan"] = drill_plan();
    v
}

/// The plan's steps as `get_state().plan` shows them, none started.
fn shown(steps: Value) -> Value {
    let mut steps = steps;
    for step in steps.as_array_mut().unwrap() {
        step["done"] = json!(false);
    }
    steps
}

#[test]
fn two_deleverage_verdicts_2_to_5_minutes_apart_confirm_the_plan() {
    let mut a = account();
    deliver_at(&mut a, Intent::Check {}, &deleverage(H0, 3_000), H0 + 2, T0);
    let s = a.get_state();
    assert_eq!((s.deleverage.first_at, s.plan), (U64(T0), None));
    let t2 = T0 + 3 * MINUTE_NS;
    deliver_at(&mut a, Intent::Check {}, &deleverage(H0 + 300, 3_000), H0 + 302, t2);
    // The second verdict's plan is stored, with its blk as the plan's id.
    let plan = a.get_state().plan.unwrap();
    assert_eq!((plan.pid.as_str(), plan.action, plan.stored_at), ("1300", Action::Deleverage, U64(t2)));
    assert_eq!(Value::Array(plan.steps), shown(drill_plan()));
}

#[test]
fn a_deleverage_verdict_at_an_80_percent_hyperliquid_ratio_is_confirmed_at_once() {
    let mut a = account();
    deliver(&mut a, Intent::Check {}, &deleverage(H0, 8_500), H0 + 2);
    assert!(a.get_state().plan.is_some());
}

#[test]
fn every_verdict_adds_to_the_hourly_record() {
    let mut a = account();
    let mut v = verdict(0, H0);
    v["hr_bp"] = json!(7_000);
    deliver_at(&mut a, Intent::Check {}, &v, H0 + 2, T0);
    v["blk"] = json!(H0 + 3);
    v["hr_bp"] = json!(9_000);
    v["exp_bp"] = json!(60_000);
    deliver_at(&mut a, Intent::Check {}, &v, H0 + 4, T0 + MINUTE_NS);
    assert_eq!(a.get_state().hourly, vec![HourRecord { hour: T0 / HOUR_NS, hr_bp_min: 7_000, exp_bp_max: 60_000 }]);
}

// ---------------------------------------------------------------------------------------------------------------
// borrow
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn a_borrow_sends_the_verdicts_terms_to_the_pool_and_bumps_the_counter() {
    let mut a = account();
    deliver(&mut a, borrow_intent(1), &verdict(0, H0), H0 + 5);
    at(OWNER, 1, H0 + 120);
    a.borrow(U128(10_000_000_000)).detach();
    let calls = calls();
    let (to, method, args, deposit) = &calls[0];
    assert_eq!((to.as_str(), method.as_str(), deposit.as_yoctonear()), (POOL, "borrow", 1));
    let terms = json!({
        "tier": "STANDARD", "allow_borrow": "10000000000",
        "shares_bp": { "nBTC": 7_407 }, "hold": { "nBTC": "100000000000" }, "hl_eq": "35000000000",
    });
    assert_eq!(args["verdict"], terms);
    assert_eq!(args["amount"], "10000000000");
    assert_eq!(a.get_state().counter, 1);
    assert_eq!(a.get_state().pending, vec![Pending::Borrow { amount: U128(10_000_000_000) }]);
    // The callback ends the borrow under way.
    ctx(ACCOUNT, 0, H0 + 125, T0, vec![PromiseResult::Successful(b"\"10000000000\"".to_vec())]);
    assert!(a.on_borrowed(U128(10_000_000_000)));
    assert!(a.get_state().pending.is_empty());
    // It bumps the counter again, so no verdict read while the borrow was under way can back anything.
    assert_eq!(a.get_state().counter, 2);
}

#[test]
fn a_refused_borrow_ends_the_borrow_under_way_and_spends_the_verdict() {
    let mut a = account();
    deliver(&mut a, borrow_intent(1), &verdict(0, H0), H0 + 5);
    at(OWNER, 1, H0 + 6);
    a.borrow(U128(5)).detach();
    ctx(ACCOUNT, 0, H0 + 8, T0, vec![PromiseResult::Failed]);
    assert!(!a.on_borrowed(U128(5)));
    assert_eq!(get_logs(), vec!["the pool refused the borrow of 5"]);
    let s = a.get_state();
    assert!(s.pending.is_empty() && s.counter == 2 && !s.loan.open);
}

#[test]
fn negative_hyperliquid_equity_goes_to_the_pool_as_zero() {
    let mut v: Verdict = near_sdk::serde_json::from_value(verdict(0, H0)).unwrap();
    v.pool.hl_eq = -5;
    assert_eq!(BorrowVerdict::from(&v).hl_eq, U128(0));
}

/// A borrow of `amount` with this verdict, from `who` at `height`.
fn try_borrow(v: Value, intent: Intent, who: &str, yocto: u128, height: u64, amount: u128) {
    let mut a = account();
    deliver(&mut a, intent, &v, H0 + 5);
    at(who, yocto, height);
    a.borrow(U128(amount)).detach();
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn only_the_owner_borrows() {
    try_borrow(verdict(0, H0), borrow_intent(1), "keeper.testnet", 1, H0 + 6, 5);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn a_borrow_needs_one_yocto() {
    try_borrow(verdict(0, H0), borrow_intent(1), OWNER, 0, H0 + 6, 5);
}

#[test]
#[should_panic(expected = "no verdict: ask for a check first")]
fn a_borrow_needs_a_verdict() {
    let mut a = account();
    at(OWNER, 1, H0);
    a.borrow(U128(5)).detach();
}

#[test]
#[should_panic(expected = "the verdict is 121 blocks old, above the 120-block limit")]
fn a_verdict_older_than_120_blocks_is_refused() {
    try_borrow(verdict(0, H0), borrow_intent(1), OWNER, 1, H0 + 121, 5);
}

#[test]
#[should_panic(expected = "the verdict was already used")]
fn a_verdict_backs_one_borrow_only() {
    let mut a = account();
    deliver(&mut a, borrow_intent(1), &verdict(0, H0), H0 + 5);
    at(OWNER, 1, H0 + 6);
    a.borrow(U128(5)).detach();
    ctx(ACCOUNT, 0, H0 + 8, T0, vec![PromiseResult::Successful(b"\"5\"".to_vec())]);
    a.on_borrowed(U128(5));
    at(OWNER, 1, H0 + 9);
    a.borrow(U128(5)).detach();
}

#[test]
#[should_panic(expected = "the verdict doesn't answer a borrow")]
fn a_borrow_needs_a_borrow_verdict() {
    try_borrow(verdict(0, H0), Intent::Check {}, OWNER, 1, H0 + 6, 5);
}

#[test]
#[should_panic(expected = "amount is above the verdict's borrow allowance")]
fn a_borrow_is_limited_by_the_allowance() {
    try_borrow(verdict(0, H0), borrow_intent(1), OWNER, 1, H0 + 6, 10_000_000_001);
}

#[test]
#[should_panic(expected = "the verdict's state isn't HEALTHY")]
fn no_borrow_unless_healthy() {
    let mut v = verdict(0, H0);
    v["state"] = json!("WATCH");
    try_borrow(v, borrow_intent(1), OWNER, 1, H0 + 6, 5);
}

#[test]
#[should_panic(expected = "a borrow is already under way")]
fn one_borrow_at_a_time() {
    let mut a = account();
    deliver(&mut a, borrow_intent(1), &verdict(0, H0), H0 + 5);
    at(OWNER, 1, H0 + 6);
    a.borrow(U128(5)).detach();
    // A new verdict with the new counter arrives before the first borrow ends.
    deliver(&mut a, borrow_intent(1), &verdict(1, H0 + 6), H0 + 7);
    at(OWNER, 1, H0 + 8);
    a.borrow(U128(5)).detach();
}

// ---------------------------------------------------------------------------------------------------------------
// repay
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn the_owner_repays_the_pool_with_its_usdc() {
    let mut a = with_loan();
    at(OWNER, 1, H0 + 20);
    a.repay(U128(400_000_000)).detach();
    let calls = calls();
    let (to, method, args, deposit) = &calls[0];
    assert_eq!((to.as_str(), method.as_str(), deposit.as_yoctonear()), (USDC, "ft_transfer_call", 1));
    assert_eq!(args["receiver_id"], POOL);
    assert_eq!(args["amount"], "400000000");
    assert_eq!(args["msg"], r#"{"pool":"repay"}"#);
    // The pool used all of it: the loan shrinks and stays open.
    ctx(ACCOUNT, 0, H0 + 22, T0, vec![PromiseResult::Successful(b"\"400000000\"".to_vec())]);
    assert_eq!(a.on_repaid(U128(400_000_000), a.loan_seq), U128(400_000_000));
    assert_eq!(a.get_state().loan, Loan { principal: U128(600_000_000), open: true });
}

#[test]
fn a_repayment_that_partly_comes_back_clears_the_loan() {
    let mut loan = Loan { principal: U128(1_000), open: true };
    // Principal repaid exactly, but interest may be left: still open.
    loan.book_repayment(1_000, 1_000);
    assert_eq!(loan, Loan { principal: U128(0), open: true });
    // The next repayment comes back partly: the pool's whole debt is paid.
    loan.book_repayment(100, 3);
    assert_eq!(loan, Loan { principal: U128(0), open: false });
    let mut loan = Loan { principal: U128(1_000), open: true };
    loan.book_repayment(2_000, 1_010);
    assert_eq!(loan, Loan { principal: U128(0), open: false });
}

#[test]
fn a_repayment_the_pool_took_nothing_of_changes_nothing() {
    let mut loan = Loan { principal: U128(1_000), open: true };
    loan.book_repayment(500, 0);
    assert_eq!(loan, Loan { principal: U128(1_000), open: true });
    // With only interest possibly left, nothing used means nothing was owed.
    let mut loan = Loan { principal: U128(0), open: true };
    loan.book_repayment(500, 0);
    assert!(!loan.open);
}

#[test]
fn a_failed_repayment_changes_nothing() {
    let mut a = with_loan();
    ctx(ACCOUNT, 0, H0 + 22, T0, vec![PromiseResult::Failed]);
    assert_eq!(a.on_repaid(U128(400_000_000), a.loan_seq), U128(0));
    assert_eq!(a.get_state().loan, Loan { principal: U128(1_000_000_000), open: true });
}

#[test]
#[should_panic(expected = "only the owner can repay, unless the verdict says DELEVERAGE")]
fn only_the_owner_repays_normally() {
    let mut a = with_loan();
    at("keeper.testnet", 1, H0 + 20);
    a.repay(U128(5)).detach();
}

#[test]
fn anyone_repays_when_the_verdict_says_deleverage() {
    let mut a = with_loan();
    let mut v = deleverage(H0 + 20, 0);
    v["nonce"] = json!(LOANED);
    assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 21).accepted);
    at("keeper.testnet", 1, H0 + 22);
    a.repay(U128(5)).detach();
    assert_eq!(calls()[0].1, "ft_transfer_call");
}

// ---------------------------------------------------------------------------------------------------------------
// withdraw
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn with_no_loan_a_withdrawal_needs_no_verdict() {
    let mut a = account();
    at(OWNER, 1, H0);
    a.withdraw(id(NBTC), U128(5), id("dest.testnet"), None).detach();
    let calls = calls();
    assert_eq!(calls.len(), 3);
    assert_eq!((calls[0].0.as_str(), calls[0].1.as_str()), (NBTC, "storage_deposit"));
    assert_eq!(calls[0].2, json!({ "account_id": "dest.testnet", "registration_only": true }));
    assert_eq!(calls[0].3, STORAGE_DEPOSIT);
    assert_eq!((calls[1].1.as_str(), calls[1].3.as_yoctonear()), ("ft_transfer", 1));
    assert_eq!(calls[1].2, json!({ "receiver_id": "dest.testnet", "amount": "5" }));
    // Then on_sent, which bumps the counter again once the tokens have gone.
    assert_eq!(
        (calls[2].0.as_str(), calls[2].1.as_str(), calls[2].2.clone()),
        (ACCOUNT, "on_sent", json!({ "id": null }))
    );
    assert_eq!(a.get_state().counter, 1);
}

#[test]
#[should_panic(expected = "the verdict was already used")]
fn with_a_loan_a_withdrawal_needs_a_fresh_verdict() {
    let mut a = with_loan();
    at(OWNER, 1, H0 + 20);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
}

#[test]
fn with_a_loan_a_verdict_for_the_same_token_and_amount_lets_it_out() {
    let mut a = with_loan();
    assert!(deliver(&mut a, withdraw_intent(NBTC, 5), &verdict(LOANED, H0 + 20), H0 + 25).accepted);
    at(OWNER, 1, H0 + 30);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
    assert_eq!(a.get_state().counter, LOANED + 1);
    // The verdict is spent.
    let again = deliver(&mut a, withdraw_intent(NBTC, 5), &verdict(LOANED, H0 + 30), H0 + 31);
    assert!(again.reason.unwrap().contains("nonce"));
}

/// With an open loan, a withdrawal backed by verdict `v` for `intent`.
fn try_withdraw(v: Value, intent: Intent, token: &str, amount: u128) {
    let mut a = with_loan();
    assert!(deliver(&mut a, intent, &v, H0 + 25).accepted);
    at(OWNER, 1, H0 + 30);
    a.withdraw(id(token), U128(amount), id(OWNER), None).detach();
}

#[test]
#[should_panic(expected = "a withdrawal needs a verdict for this token and amount")]
fn a_withdrawal_verdict_is_for_one_amount() {
    try_withdraw(verdict(LOANED, H0 + 20), withdraw_intent(NBTC, 5), NBTC, 6);
}

#[test]
#[should_panic(expected = "a withdrawal needs a verdict for this token and amount")]
fn a_withdrawal_verdict_is_for_one_token() {
    try_withdraw(verdict(LOANED, H0 + 20), withdraw_intent(NBTC, 5), USDC, 5);
}

#[test]
#[should_panic(expected = "a withdrawal needs a verdict for this token and amount")]
fn a_borrow_verdict_does_not_back_a_withdrawal() {
    try_withdraw(verdict(LOANED, H0 + 20), borrow_intent(5), NBTC, 5);
}

/// The engine's answer to a withdraw intent: `allow.withdraw` is the amount if it allows it, else 0.
fn answer(allowed: u128) -> Value {
    let mut v = verdict(LOANED, H0 + 20);
    v["allow"]["withdraw"] = json!(allowed);
    v
}

#[test]
#[should_panic(expected = "the verdict doesn't allow this withdrawal")]
fn a_withdrawal_the_engine_refused_stays_in() {
    try_withdraw(answer(0), withdraw_intent(NBTC, 5), NBTC, 5);
}

#[test]
#[should_panic(expected = "the verdict doesn't allow this withdrawal")]
fn a_withdrawal_needs_its_whole_amount_allowed() {
    try_withdraw(answer(5_000_000_000), withdraw_intent(USDC, 5_000_000_001), USDC, 5_000_000_001);
}

#[test]
fn a_withdrawal_the_engine_allowed_goes_out() {
    try_withdraw(answer(5_000_000_000), withdraw_intent(USDC, 5_000_000_000), USDC, 5_000_000_000);
    try_withdraw(answer(5), withdraw_intent(NBTC, 5), NBTC, 5);
}

#[test]
#[should_panic(expected = "the verdict's state isn't HEALTHY")]
fn no_withdrawal_with_a_loan_unless_healthy() {
    let mut v = verdict(LOANED, H0 + 20);
    v["state"] = json!("WATCH");
    try_withdraw(v, withdraw_intent(NBTC, 5), NBTC, 5);
}

#[test]
#[should_panic(expected = "blocks old, above the 120-block limit")]
fn a_stale_verdict_backs_no_withdrawal() {
    let mut a = with_loan();
    deliver(&mut a, withdraw_intent(NBTC, 5), &verdict(LOANED, H0 + 20), H0 + 25);
    at(OWNER, 1, H0 + 141);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
}

#[test]
#[should_panic(expected = "a borrow is under way")]
fn no_withdrawal_while_a_borrow_is_under_way() {
    let mut a = account();
    deliver(&mut a, borrow_intent(1), &verdict(0, H0), H0 + 5);
    at(OWNER, 1, H0 + 6);
    a.borrow(U128(5)).detach();
    at(OWNER, 1, H0 + 7);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn only_the_owner_withdraws() {
    let mut a = account();
    at("keeper.testnet", 1, H0);
    a.withdraw(id(NBTC), U128(5), id("keeper.testnet"), None).detach();
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn a_withdrawal_needs_one_yocto() {
    let mut a = account();
    at(OWNER, 0, H0);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
}

#[test]
#[should_panic(expected = "not an allow-listed token")]
fn only_listed_tokens_are_withdrawn() {
    let mut a = account();
    at(OWNER, 1, H0);
    a.withdraw(id("other.testnet"), U128(5), id(OWNER), None).detach();
}

#[test]
fn after_the_loan_is_cleared_withdrawals_need_no_verdict_again() {
    let mut a = with_loan();
    ctx(ACCOUNT, 0, H0 + 22, T0, vec![PromiseResult::Successful(b"\"1000000020\"".to_vec())]);
    a.on_repaid(U128(1_100_000_000), a.loan_seq);
    assert!(!a.get_state().loan.open);
    at(OWNER, 1, H0 + 30);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
    assert_eq!(calls().len(), 3);
}

// Verdicts read while money is on its way (research/audit.md, A1).

#[test]
#[should_panic(expected = "the verdict was already used")]
fn a_verdict_read_while_a_borrow_was_under_way_backs_no_withdrawal() {
    let mut a = account();
    assert!(deliver(&mut a, borrow_intent(1_000_000_000), &verdict(0, H0 + 5), H0 + 8).accepted);
    at(OWNER, 1, H0 + 10);
    a.borrow(U128(1_000_000_000)).detach();
    // A check reads the account after the borrow started but before the pool lent: no loan yet, so the engine allows
    // any withdrawal. Its verdict carries the bumped counter, so it is accepted.
    assert!(deliver(&mut a, withdraw_intent(USDC, 1_000_000_000), &verdict(1, H0 + 10), H0 + 12).accepted);
    book_loan(&mut a, 1_000_000_000, H0 + 13);
    ctx(ACCOUNT, 0, H0 + 14, T0, vec![PromiseResult::Successful(b"\"1000000000\"".to_vec())]);
    assert!(a.on_borrowed(U128(1_000_000_000)));
    // The loan is open now. Without the second bump, that verdict would let the loan straight out again.
    at(OWNER, 1, H0 + 15);
    a.withdraw(id(USDC), U128(1_000_000_000), id(OWNER), None).detach();
}

#[test]
#[should_panic(expected = "the verdict was already used")]
fn a_verdict_read_while_a_withdrawals_tokens_were_on_their_way_backs_nothing() {
    let mut a = with_loan();
    assert!(deliver(&mut a, withdraw_intent(NBTC, 5), &verdict(LOANED, H0 + 20), H0 + 21).accepted);
    at(OWNER, 1, H0 + 22);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
    // A check reads the account before the token has moved the 5: it still counts them, and carries the counter.
    assert!(deliver(&mut a, withdraw_intent(NBTC, 5), &verdict(LOANED + 1, H0 + 22), H0 + 23).accepted);
    // The tokens have gone: on_sent moves the counter on, so that verdict can't let another 5 out.
    ctx(ACCOUNT, 0, H0 + 24, time(H0 + 24), vec![PromiseResult::Successful(Vec::new())]);
    assert!(a.on_sent(None));
    assert_eq!(a.get_state().counter, LOANED + 2);
    at(OWNER, 1, H0 + 25);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
}

#[test]
fn a_verdict_read_after_the_money_moved_backs_the_next_action() {
    let mut a = with_loan();
    assert!(deliver(&mut a, withdraw_intent(NBTC, 5), &verdict(LOANED, H0 + 20), H0 + 21).accepted);
    at(OWNER, 1, H0 + 22);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
    ctx(ACCOUNT, 0, H0 + 24, time(H0 + 24), vec![PromiseResult::Successful(Vec::new())]);
    assert!(a.on_sent(None));
    assert!(deliver(&mut a, withdraw_intent(NBTC, 5), &verdict(LOANED + 2, H0 + 25), H0 + 26).accepted);
    at(OWNER, 1, H0 + 27);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
    assert_eq!(calls()[1].1, "ft_transfer");
}

#[test]
fn a_send_that_failed_still_moves_the_counter_on_and_drops_only_a_named_transfer() {
    let mut a = account();
    at(OWNER, 1, H0);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
    ctx(ACCOUNT, 0, H0 + 2, time(H0 + 2), vec![PromiseResult::Failed]);
    assert!(!a.on_sent(None));
    assert_eq!(a.get_state().counter, 2);
    assert!(get_logs().is_empty() && transfers(&a).is_empty());
}

// ---------------------------------------------------------------------------------------------------------------
// Hyperliquid (INTERFACES.md 8)
// ---------------------------------------------------------------------------------------------------------------

const HL_USDC: &str = "USDC:0xeb62eee3685fc4c43992febcd9e75443";
/// The real derived key of `client1.pb.testnet` at path `hyperliquid-1`, and its address (PLAN.md 5.2).
const KEY: &str = "secp256k1:5CDPH1jf7MkUQ45W6WDKeK8fUT8XtyeVMDQ1bYX88yWxwpeyT3i4bMdAKg3CQzkRtYejctYykFyrgtnXAm8HCG4r";
const ADDRESS: &str = "0xd7f35513286b7a0c2a7d8648c72588751ce0dd7c";
const AGENT: &str = "0x6ecdc34d53c1dc5ab647718a2e0f949643b2017c";
/// The stand-in's Hyperliquid float (INTERFACES.md 1).
const FLOAT: &str = "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d";
const NOW_MS: u64 = T0 / 1_000_000;
const DAY_MS: u64 = 86_400_000;

/// A real answer of the signer from Phase 0 (run 5): big_r starts with 03, but recovery_id is 0.
const SIGNER_ANSWER: &str = r#"{"scheme":"Secp256k1","big_r":{"affine_point":"03c108d226eef8ea52e8c49dd4ffe260add49c1478f8305122e2cee5f755b6df22"},"s":{"scalar":"680ca8be54a7349ca45980f38c0c76ef37406385b782c1d895e8ac5e257a0785"},"recovery_id":0}"#;

/// The gas the last call attached to its call of `method`.
fn gas(method: &str) -> Gas {
    let actions = get_created_receipts().into_iter().flat_map(|r| r.actions);
    let mut found = actions.filter_map(|action| match action {
        MockAction::FunctionCallWeight { method_name, prepaid_gas, .. } if method_name == method.as_bytes() => {
            Some(prepaid_gas)
        }
        _ => None,
    });
    found.next().unwrap_or_else(|| panic!("no call to {method}"))
}

/// Schedules `hl_init`'s promise, if it made one, and returns its value otherwise.
fn run_hl_init(a: &mut Account) -> Option<String> {
    match a.hl_init() {
        PromiseOrValue::Promise(p) => {
            p.detach();
            None
        }
        PromiseOrValue::Value(address) => address,
    }
}

/// The MPC signer answered `hl_init` with `key`.
fn give_key(a: &mut Account, key: &str) -> Option<String> {
    ctx(ACCOUNT, 0, H0, T0, vec![PromiseResult::Successful(near_sdk::serde_json::to_vec(key).unwrap())]);
    a.on_hl_key()
}

/// The gateway answered `request_agent` with `answer`.
fn give_agent(a: &mut Account, answer: &Value) -> CheckOutcome {
    ctx(ACCOUNT, 0, H0, T0, vec![PromiseResult::Successful(near_sdk::serde_json::to_vec(answer).unwrap())]);
    a.on_agent()
}

fn agent_answer(acct: &str, agent: &str) -> Value {
    json!({ "ok": true, "acct": acct, "agent": agent })
}

/// Gives an account its Hyperliquid address and the gateway's agent.
fn add_agent(a: &mut Account) {
    assert_eq!(give_key(a, KEY).as_deref(), Some(ADDRESS));
    assert!(give_agent(a, &agent_answer(ACCOUNT, AGENT)).accepted);
}

fn with_agent() -> Account {
    let mut a = account();
    add_agent(&mut a);
    a
}

/// The signer's answer arrives for the action the last call asked it to sign. Returns `on_hl_signed`'s result.
fn sign_with(a: &mut Account, result: PromiseResult) -> Option<SignedAction> {
    let (_, _, args, _) = calls().into_iter().find(|c| c.1 == "on_hl_signed").expect("no on_hl_signed callback");
    let kind: ActionKind = near_sdk::serde_json::from_value(args["kind"].clone()).unwrap();
    let action = args["action"].as_str().unwrap().to_string();
    let transfer: Option<String> = near_sdk::serde_json::from_value(args["transfer"].clone()).unwrap();
    ctx(ACCOUNT, 0, H0 + 9, T0, vec![result]);
    a.on_hl_signed(kind, action, args["nonce"].as_u64().unwrap(), transfer)
}

fn signed_ok() -> PromiseResult {
    PromiseResult::Successful(SIGNER_ANSWER.as_bytes().to_vec())
}

#[test]
fn hl_init_asks_the_signer_for_the_key_at_hyperliquid_1() {
    let mut a = account();
    at("anyone.testnet", 0, H0);
    assert_eq!(run_hl_init(&mut a), None);
    let calls = calls();
    let (to, method, args, deposit) = &calls[0];
    assert_eq!((to.as_str(), method.as_str(), deposit.as_yoctonear()), (MPC, "derived_public_key", 0));
    assert_eq!(*args, json!({ "path": "hyperliquid-1", "predecessor": ACCOUNT, "domain_id": 0 }));
    assert_eq!(gas("derived_public_key"), Gas::from_tgas(50));
    assert_eq!((calls[1].0.as_str(), calls[1].1.as_str()), (ACCOUNT, "on_hl_key"));
    assert_eq!(gas("on_hl_key"), Gas::from_tgas(10));
}

#[test]
fn the_derived_key_becomes_the_address_and_hl_init_then_does_nothing() {
    let mut a = account();
    assert_eq!(give_key(&mut a, KEY).as_deref(), Some(ADDRESS));
    assert_eq!(get_logs(), vec![format!("Hyperliquid address {ADDRESS}")]);
    assert_eq!(a.get_state().hl.address.as_deref(), Some(ADDRESS));
    at("anyone.testnet", 0, H0 + 1);
    assert_eq!(run_hl_init(&mut a).as_deref(), Some(ADDRESS));
    assert!(get_created_receipts().is_empty(), "hl_init called out although the address is set");
}

#[test]
fn a_failed_or_bad_key_answer_stores_nothing_and_says_why() {
    let mut a = account();
    ctx(ACCOUNT, 0, H0, T0, vec![PromiseResult::Failed]);
    assert_eq!(a.on_hl_key(), None);
    assert_eq!(get_logs(), vec!["no Hyperliquid address: the MPC signer's derived_public_key failed"]);
    ctx(ACCOUNT, 0, H0, T0, vec![PromiseResult::Successful(b"{\"key\":1}".to_vec())]);
    assert_eq!(a.on_hl_key(), None);
    assert_eq!(get_logs(), vec!["no Hyperliquid address: the answer is not a key"]);
    assert_eq!(give_key(&mut a, &KEY.replace("secp256k1", "ed25519")), None);
    assert!(get_logs()[0].contains("is not secp256k1"), "{:?}", get_logs());
    let long = format!("secp256k1:{}", "1".repeat(300));
    assert_eq!(give_key(&mut a, &long), None);
    assert!(get_logs()[0].contains("above 256"), "{:?}", get_logs());
    assert_eq!(a.get_state().hl.address, None);
}

#[test]
fn a_second_key_answer_keeps_the_first_address() {
    let mut a = account();
    give_key(&mut a, KEY);
    let other = "secp256k1:KMvbJB2SU3nHsuttGzkHjJydvkWF18bnJXqJjoW3AwdYnCb28QLd4jLdkCZYyEiU1i29fRWqJN2opfVCT7BPvfz";
    assert_eq!(give_key(&mut a, other).as_deref(), Some(ADDRESS));
    assert_eq!(a.get_state().hl.address.as_deref(), Some(ADDRESS));
}

#[test]
fn request_agent_runs_the_pinned_gateway_on_this_account() {
    let mut a = account();
    let deposit = NearToken::from_millinear(10).as_yoctonear();
    at(OWNER, deposit, H0);
    a.request_agent().detach();
    let calls = calls();
    let (to, method, args, attached) = &calls[0];
    assert_eq!((to.as_str(), method.as_str(), attached.as_yoctonear()), (OUTLAYER, "request_execution", deposit));
    let source =
        json!({ "Project": { "project_id": "pbf-keeper.testnet/pb-gateway", "version_key": "12".repeat(32) } });
    assert_eq!(args["source"], source);
    let limits = json!({ "max_instructions": 2_000_000_000u64, "max_memory_mb": 256, "max_execution_seconds": 20 });
    assert_eq!(args["resource_limits"], limits);
    assert_eq!((args["response_format"].clone(), args["secrets_ref"].clone()), (json!("Json"), Value::Null));
    assert_eq!(args["payer_account_id"], OWNER);
    let input: Value = near_sdk::serde_json::from_str(args["input_data"].as_str().unwrap()).unwrap();
    assert_eq!(input, json!({ "mode": "agent_address", "account": ACCOUNT, "network": "testnet" }));
    assert_eq!((calls[1].0.as_str(), calls[1].1.as_str()), (ACCOUNT, "on_agent"));
    assert_eq!((gas("request_execution"), gas("on_agent")), (Gas::from_tgas(200), Gas::from_tgas(30)));
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn only_the_owner_asks_for_an_agent() {
    let mut a = account();
    at("keeper.testnet", NearToken::from_millinear(10).as_yoctonear(), H0);
    a.request_agent().detach();
}

#[test]
#[should_panic(expected = "attach at least 0.01 NEAR for OutLayer")]
fn an_agent_request_needs_a_deposit_for_outlayer() {
    let mut a = account();
    at(OWNER, NearToken::from_millinear(9).as_yoctonear(), H0);
    a.request_agent().detach();
}

#[test]
#[should_panic(expected = "no pb-gateway version is pinned in this account's config")]
fn no_agent_request_runs_before_a_gateway_version_is_pinned() {
    at("pbf.testnet", 0, H0);
    let mut c = config();
    c.gateway.version_key = String::new();
    let mut a = Account::new(id(OWNER), c, None);
    at(OWNER, NearToken::from_millinear(10).as_yoctonear(), H0);
    a.request_agent().detach();
}

#[test]
fn the_gateways_agent_is_kept_lowercase_with_its_block() {
    let mut a = account();
    let outcome = give_agent(&mut a, &agent_answer(ACCOUNT, &AGENT.to_uppercase().replace("0X", "0x")));
    assert_eq!(outcome, CheckOutcome { accepted: true, reason: None });
    assert_eq!(get_logs(), vec![format!("agent {AGENT} accepted")]);
    assert_eq!(a.get_state().hl.agent, Some(Agent { address: AGENT.into(), received_block: H0 }));
}

#[test]
fn an_agent_for_another_account_or_from_a_failed_run_is_refused() {
    let mut a = account();
    let outcome = give_agent(&mut a, &agent_answer("bob.pbf.testnet", AGENT));
    assert_eq!(outcome.reason.as_deref(), Some("acct bob.pbf.testnet is not this account"));
    assert_eq!(get_logs(), vec!["agent refused: acct bob.pbf.testnet is not this account"]);
    let refused = json!({ "ok": false, "code": "AUTH", "reason": "the caller is not the account" });
    assert_eq!(give_agent(&mut a, &refused).reason.as_deref(), Some("ok is false: AUTH the caller is not the account"));
    let reason = give_agent(&mut a, &agent_answer(ACCOUNT, "0x1234")).reason.unwrap();
    assert!(reason.contains("is not 0x and 40 hex digits"), "{reason}");
    assert!(give_agent(&mut a, &Value::Null).reason.unwrap().contains("OutLayer returned no answer"));
    ctx(ACCOUNT, 0, H0, T0, vec![PromiseResult::Failed]);
    assert_eq!(a.on_agent().reason.as_deref(), Some("OutLayer's call failed"));
    assert_eq!(a.get_state().hl.agent, None);
}

#[test]
fn a_new_agent_answer_replaces_the_old_agent() {
    let mut a = with_agent();
    let other = "0x2077fecbc310678f3c04271f6c43a34a2967b32c";
    assert!(give_agent(&mut a, &agent_answer(ACCOUNT, other)).accepted);
    assert_eq!(a.get_state().hl.agent.unwrap().address, other);
}

#[test]
fn approve_agent_has_the_signer_sign_the_approve_agent_digest() {
    let mut a = with_agent();
    at(OWNER, 1, H0);
    a.hl_approve_agent().detach();
    let calls = calls();
    let (to, method, args, deposit) = &calls[0];
    assert_eq!((to.as_str(), method.as_str(), deposit.as_yoctonear()), (MPC, "sign", 1));
    let name = format!("pb valid_until {}", NOW_MS + 180 * DAY_MS);
    let action = ApproveAgent {
        kind: "approveAgent",
        hyperliquid_chain: "Testnet",
        signature_chain_id: "0x66eee",
        agent_address: AGENT,
        agent_name: &name,
        nonce: NOW_MS,
    };
    let payload = hex(&action.digest().unwrap());
    let request = json!({ "path": "hyperliquid-1", "payload_v2": { "Ecdsa": payload }, "domain_id": 0 });
    assert_eq!(*args, json!({ "request": request }));
    assert_eq!((gas("sign"), gas("on_hl_signed")), (Gas::from_tgas(50), Gas::from_tgas(15)));
    // The callback carries the action exactly as it will be posted, and its nonce.
    let (to, method, args, _) = &calls[1];
    assert_eq!((to.as_str(), method.as_str()), (ACCOUNT, "on_hl_signed"));
    let expected = format!(
        r#"{{"type":"approveAgent","hyperliquidChain":"Testnet","signatureChainId":"0x66eee","agentAddress":"{AGENT}","agentName":"{name}","nonce":{NOW_MS}}}"#
    );
    // An approval records no 1Click transfer.
    assert_eq!(*args, json!({ "kind": "approveAgent", "action": expected, "nonce": NOW_MS, "transfer": null }));
    assert_eq!(a.get_state().hl.next_nonce_ms, U64(NOW_MS + 1));
}

#[test]
fn the_signed_action_is_kept_with_r_s_and_v_and_an_event_is_logged() {
    let mut a = with_agent();
    at(OWNER, 1, H0);
    a.hl_approve_agent().detach();
    let entry = sign_with(&mut a, signed_ok()).expect("nothing was signed");
    let signature = HlSignature {
        r: "0xc108d226eef8ea52e8c49dd4ffe260add49c1478f8305122e2cee5f755b6df22".into(),
        s: "0x680ca8be54a7349ca45980f38c0c76ef37406385b782c1d895e8ac5e257a0785".into(),
        // From recovery_id 0, not from big_r's 03 prefix.
        v: 27,
    };
    assert_eq!(
        (entry.index, entry.kind, entry.nonce, entry.signed_block),
        (0, ActionKind::ApproveAgent, NOW_MS, H0 + 9)
    );
    assert_eq!(entry.signature, signature);
    let posted: Value = near_sdk::serde_json::from_str(&entry.action).unwrap();
    assert_eq!((posted["type"].clone(), posted["agentAddress"].clone()), (json!("approveAgent"), json!(AGENT)));
    assert_eq!(a.get_state().hl.signed, vec![entry]);
    let event = format!(
        r#"EVENT_JSON:{{"standard":"pb-pool","version":"1.0.0","event":"hl_signed","data":[{{"account":"{ACCOUNT}","index":0,"kind":"approveAgent","nonce":{NOW_MS}}}]}}"#
    );
    assert_eq!(get_logs(), vec![event]);
    // The next one gets index 1 and the next nonce.
    at(OWNER, 1, H0);
    a.hl_approve_agent().detach();
    let second = sign_with(&mut a, signed_ok()).unwrap();
    assert_eq!((second.index, second.nonce), (1, NOW_MS + 1));
}

#[test]
fn a_failed_or_malformed_signature_stores_nothing_and_says_why() {
    let mut a = with_agent();
    at(OWNER, 1, H0);
    a.hl_approve_agent().detach();
    assert_eq!(sign_with(&mut a, PromiseResult::Failed), None);
    assert_eq!(get_logs(), vec!["nothing signed: the MPC signer failed or timed out"]);
    at(OWNER, 1, H0);
    a.hl_approve_agent().detach();
    let bad = SIGNER_ANSWER.replace("\"recovery_id\":0", "\"recovery_id\":4");
    assert_eq!(sign_with(&mut a, PromiseResult::Successful(bad.into_bytes())), None);
    assert_eq!(get_logs(), vec!["nothing signed: recovery_id 4 is not 0 or 1"]);
    let hl = a.get_state().hl;
    assert!(hl.signed.is_empty());
    // The nonces were taken all the same, so a retry signs with a new one.
    assert_eq!(hl.next_nonce_ms, U64(NOW_MS + 2));
}

#[test]
fn approving_an_agent_is_allowed_with_a_loan() {
    let mut a = with_loan();
    add_agent(&mut a);
    at(OWNER, 1, H0 + 20);
    a.hl_approve_agent().detach();
    assert_eq!(calls()[0].1, "sign");
}

#[test]
#[should_panic(expected = "no Hyperliquid address yet: call hl_init first")]
fn approving_an_agent_needs_the_address() {
    let mut a = account();
    assert!(give_agent(&mut a, &agent_answer(ACCOUNT, AGENT)).accepted);
    at(OWNER, 1, H0);
    a.hl_approve_agent().detach();
}

#[test]
#[should_panic(expected = "no agent yet: call request_agent first")]
fn approving_an_agent_needs_the_agent() {
    let mut a = account();
    give_key(&mut a, KEY);
    at(OWNER, 1, H0);
    a.hl_approve_agent().detach();
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn only_the_owner_approves_an_agent() {
    let mut a = with_agent();
    at("keeper.testnet", 1, H0);
    a.hl_approve_agent().detach();
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn approving_an_agent_needs_one_yocto() {
    let mut a = with_agent();
    at(OWNER, 0, H0);
    a.hl_approve_agent().detach();
}

#[test]
fn hl_withdraw_has_the_signer_sign_send_asset_from_the_perp_balance() {
    let mut a = account();
    give_key(&mut a, KEY);
    at(OWNER, 1, H0);
    a.hl_withdraw(U128(1_234_500), FLOAT.to_uppercase().replace("0X", "0x"), None, None, None).detach();
    let calls = calls();
    let (to, method, args, deposit) = &calls[0];
    assert_eq!((to.as_str(), method.as_str(), deposit.as_yoctonear()), (MPC, "sign", 1));
    let action = SendAsset {
        kind: "sendAsset",
        hyperliquid_chain: "Testnet",
        signature_chain_id: "0x66eee",
        destination: FLOAT,
        source_dex: "",
        destination_dex: "",
        token: HL_USDC,
        amount: "1.2345",
        from_sub_account: "",
        nonce: NOW_MS,
    };
    assert_eq!(args["request"]["payload_v2"]["Ecdsa"], hex(&action.digest().unwrap()));
    // The destination is stored lowercase, and the amount is the decimal string.
    let expected = format!(
        r#"{{"type":"sendAsset","hyperliquidChain":"Testnet","signatureChainId":"0x66eee","destination":"{FLOAT}","sourceDex":"","destinationDex":"","token":"{HL_USDC}","amount":"1.2345","fromSubAccount":"","nonce":{NOW_MS}}}"#
    );
    // With no `exp`, no 1Click transfer is recorded.
    assert_eq!(calls[1].2, json!({ "kind": "sendAsset", "action": expected, "nonce": NOW_MS, "transfer": null }));
    let entry = sign_with(&mut a, signed_ok()).unwrap();
    assert_eq!((entry.kind, entry.action), (ActionKind::SendAsset, expected));
}

#[test]
#[should_panic(expected = "the verdict was already used")]
fn hl_withdraw_bumps_the_counter_like_a_withdrawal() {
    let mut a = account();
    give_key(&mut a, KEY);
    // A borrow verdict read before the Hyperliquid withdrawal still counts that USDC.
    assert!(deliver(&mut a, borrow_intent(1_000_000_000), &verdict(0, H0 + 5), H0 + 8).accepted);
    at(OWNER, 1, H0 + 9);
    a.hl_withdraw(U128(1_000_000), FLOAT.into(), None, None, None).detach();
    assert_eq!(a.get_state().counter, 1);
    // So it can't back a borrow, even once the send window has closed (the block height is kept fresh here).
    let until = a.get_state().hl.send_open_until_ms.0;
    ctx(OWNER, 1, H0 + 10, until * 1_000_000, vec![]);
    a.borrow(U128(1_000_000_000)).detach();
}

#[test]
fn approving_an_agent_leaves_the_counter_alone() {
    let mut a = with_agent();
    at(OWNER, 1, H0);
    a.hl_approve_agent().detach();
    assert_eq!(a.get_state().counter, 0);
}

#[test]
#[should_panic(expected = "no Hyperliquid withdrawal while a loan is open")]
fn hl_withdraw_is_refused_while_a_loan_is_open() {
    let mut a = with_loan();
    give_key(&mut a, KEY);
    at(OWNER, 1, H0 + 20);
    a.hl_withdraw(U128(1_000_000), FLOAT.into(), None, None, None).detach();
}

#[test]
#[should_panic(expected = "a borrow is under way")]
fn hl_withdraw_is_refused_while_a_borrow_is_under_way() {
    let mut a = account();
    give_key(&mut a, KEY);
    deliver(&mut a, borrow_intent(1), &verdict(0, H0), H0 + 5);
    at(OWNER, 1, H0 + 6);
    a.borrow(U128(5)).detach();
    at(OWNER, 1, H0 + 7);
    a.hl_withdraw(U128(1_000_000), FLOAT.into(), None, None, None).detach();
}

#[test]
fn after_the_loan_is_cleared_hl_withdraw_works_again() {
    let mut a = with_loan();
    give_key(&mut a, KEY);
    ctx(ACCOUNT, 0, H0 + 22, T0, vec![PromiseResult::Successful(b"\"1000000020\"".to_vec())]);
    a.on_repaid(U128(1_100_000_000), a.loan_seq);
    at(OWNER, 1, H0 + 30);
    a.hl_withdraw(U128(1_000_000), FLOAT.into(), None, None, None).detach();
    assert_eq!(calls()[0].1, "sign");
}

#[test]
#[should_panic(expected = "no Hyperliquid address yet: call hl_init first")]
fn hl_withdraw_needs_the_address() {
    let mut a = account();
    at(OWNER, 1, H0);
    a.hl_withdraw(U128(1_000_000), FLOAT.into(), None, None, None).detach();
}

#[test]
#[should_panic(expected = "destination must be 0x and 40 hex digits")]
fn hl_withdraw_needs_a_0x_destination() {
    let mut a = account();
    give_key(&mut a, KEY);
    at(OWNER, 1, H0);
    a.hl_withdraw(U128(1_000_000), "alice.testnet".into(), None, None, None).detach();
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn hl_withdraw_needs_a_positive_amount() {
    let mut a = account();
    give_key(&mut a, KEY);
    at(OWNER, 1, H0);
    a.hl_withdraw(U128(0), FLOAT.into(), None, None, None).detach();
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn only_the_owner_withdraws_from_hyperliquid() {
    let mut a = account();
    give_key(&mut a, KEY);
    at("keeper.testnet", 1, H0);
    a.hl_withdraw(U128(1_000_000), FLOAT.into(), None, None, None).detach();
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn hl_withdraw_needs_one_yocto() {
    let mut a = account();
    give_key(&mut a, KEY);
    at(OWNER, 0, H0);
    a.hl_withdraw(U128(1_000_000), FLOAT.into(), None, None, None).detach();
}

// ---------------------------------------------------------------------------------------------------------------
// The send window: no verdict-backed action while a signed sendAsset could still be posted
// ---------------------------------------------------------------------------------------------------------------

/// An account that asked the signer for a `sendAsset` at T0, with a fresh borrow verdict for the bumped counter.
fn after_a_send() -> Account {
    let mut a = account();
    give_key(&mut a, KEY);
    at(OWNER, 1, H0);
    a.hl_withdraw(U128(1_000_000), FLOAT.into(), None, None, None).detach();
    assert!(deliver(&mut a, borrow_intent(1_000_000_000), &verdict(1, H0 + 4), H0 + 5).accepted);
    a
}

#[test]
fn hl_withdraw_opens_the_send_window_for_2_days_and_an_hour() {
    let a = after_a_send();
    let hl = a.get_state().hl;
    assert_eq!(hl.send_open_until_ms, U64(NOW_MS + 2 * DAY_MS + 3_600_000));
    let view = near_sdk::serde_json::to_value(a.get_state()).unwrap();
    assert_eq!(view["hl"]["send_open_until_ms"], json!((NOW_MS + SEND_OPEN_MS).to_string()));
}

#[test]
#[should_panic(
    expected = "no borrow until 2023-11-16 23:13:20 UTC (1700176400000 ms): a signed Hyperliquid sendAsset can still be posted until then"
)]
fn no_borrow_while_a_signed_send_could_still_be_posted() {
    let mut a = after_a_send();
    at(OWNER, 1, H0 + 6);
    a.borrow(U128(1_000_000_000)).detach();
}

#[test]
#[should_panic(expected = "no borrow until")]
fn the_send_window_still_holds_1_ms_before_it_ends() {
    let mut a = after_a_send();
    ctx(OWNER, 1, H0 + 6, (NOW_MS + SEND_OPEN_MS - 1) * 1_000_000, vec![]);
    a.borrow(U128(1_000_000_000)).detach();
}

#[test]
fn borrowing_works_again_once_the_send_window_closes() {
    let mut a = after_a_send();
    // The verdict's block height is still fresh; only the clock has moved.
    ctx(OWNER, 1, H0 + 6, (NOW_MS + SEND_OPEN_MS) * 1_000_000, vec![]);
    a.borrow(U128(1_000_000_000)).detach();
    assert_eq!(calls()[0].1, "borrow");
}

#[test]
fn a_withdrawal_with_no_loan_still_works_during_the_send_window() {
    let mut a = after_a_send();
    at(OWNER, 1, H0 + 6);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
    let methods: Vec<String> = calls().into_iter().map(|c| c.1).collect();
    assert_eq!(methods, vec!["storage_deposit", "ft_transfer", "on_sent"]);
}

#[test]
fn checks_and_repayments_are_never_held_back_by_the_send_window() {
    let mut a = with_loan();
    // hl_withdraw can't run with a loan open, so open the window by hand.
    a.hl.note_send(NOW_MS, NOW_MS);
    at("keeper.testnet", NearToken::from_millinear(10).as_yoctonear(), H0 + 20);
    a.request_check(Intent::Check {}).detach();
    assert_eq!(calls()[0].1, "request_execution");
    at(OWNER, 1, H0 + 21);
    a.repay(U128(400_000_000)).detach();
    assert_eq!(calls()[0].1, "ft_transfer_call");
}

#[test]
#[should_panic(expected = "no withdrawal with a loan open until 2023-11-16 23:13:20 UTC (1700176400000 ms)")]
fn a_withdrawal_with_a_loan_open_waits_for_the_send_window() {
    let mut a = with_loan();
    a.hl.note_send(NOW_MS, NOW_MS);
    assert!(deliver(&mut a, withdraw_intent(NBTC, 5), &verdict(LOANED, H0 + 20), H0 + 25).accepted);
    at(OWNER, 1, H0 + 30);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
}

#[test]
fn a_failed_send_signature_keeps_the_window_open() {
    let mut a = account();
    give_key(&mut a, KEY);
    at(OWNER, 1, H0);
    a.hl_withdraw(U128(1_000_000), FLOAT.into(), None, None, None).detach();
    assert_eq!(sign_with(&mut a, PromiseResult::Failed), None);
    // The signer's answer may be public even though it never arrived.
    assert_eq!(a.get_state().hl.send_open_until_ms, U64(NOW_MS + SEND_OPEN_MS));
}

#[test]
fn approving_an_agent_opens_no_send_window() {
    let mut a = with_agent();
    at(OWNER, 1, H0);
    a.hl_approve_agent().detach();
    assert_eq!(a.get_state().hl.send_open_until_ms, U64(0));
}

// ---------------------------------------------------------------------------------------------------------------
// The pause that lifts early (INTERFACES.md 50.2): an accepted verdict names an open transfer as sent
// ---------------------------------------------------------------------------------------------------------------

/// The line an accepted verdict logs when it ends the pause before its time.
const LIFTED: &str = "Hyperliquid shows the signed transfer as sent: the pause on borrowing ends now";
const PAUSED: &str = "no borrow until";

/// `v`, naming these nonces as sent.
fn naming(mut v: Value, sent: &[u64]) -> Value {
    v["sent"] = json!(sent);
    v
}

/// An account that asked the signer for `n` `sendAsset`s a minute apart, the first at T0, and their nonces. No
/// answer of the signer has arrived. Its counter is `n`.
fn after_sends(n: u64) -> (Account, Vec<u64>) {
    let mut a = account();
    give_key(&mut a, KEY);
    for i in 0..n {
        at(OWNER, 1, H0 + i * 100);
        a.hl_withdraw(U128(1_000_000), FLOAT.into(), None, None, None).detach();
    }
    (a, (0..n).map(|i| NOW_MS + i * 60_000).collect())
}

fn listed_sends(a: &Account) -> Vec<u64> {
    a.get_state().hl.open_sends.iter().map(|nonce| nonce.0).collect()
}

fn lifted() -> bool {
    get_logs().iter().any(|line| line == LIFTED)
}

/// The owner's borrow of $1,000 at `height` and `now_ms`: what it was refused with, or `None` if it went to the pool.
fn try_to_borrow(a: &mut Account, height: u64, now_ms: u64) -> Option<String> {
    ctx(OWNER, 1, height, now_ms * 1_000_000, vec![]);
    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| a.borrow(U128(1_000_000_000)).detach()));
    match caught {
        Ok(()) => {
            assert_eq!(calls()[0].1, "borrow");
            None
        }
        Err(_) => Some(refusal(|| a.borrow(U128(1_000_000_000)).detach())),
    }
}

#[test]
fn a_verdict_that_names_the_transfer_as_sent_ends_the_pause_and_the_borrow_right_after_goes_through() {
    let mut a = after_a_send();
    let hl = a.get_state().hl;
    assert_eq!((listed_sends(&a), hl.send_open_until_ms), (vec![NOW_MS], U64(NOW_MS + SEND_OPEN_MS)));
    // Before the check that names it, the borrow is refused.
    let refused = try_to_borrow(&mut a, H0 + 6, NOW_MS + 3_600).unwrap();
    assert!(refused.starts_with("no borrow until 2023-11-16 23:13:20 UTC"), "{refused}");
    // The check that names it ends the pause and says so.
    let sent = naming(verdict(1, H0 + 7), &[NOW_MS]);
    assert!(deliver(&mut a, borrow_intent(1_000_000_000), &sent, H0 + 8).accepted);
    assert!(lifted(), "{:?}", get_logs());
    let hl = a.get_state().hl;
    assert_eq!((hl.open_sends, hl.send_open_until_ms, hl.send_floor_until_ms), (vec![], U64(0), U64(0)));
    // The borrow right after it goes through, on that same verdict.
    assert_eq!(try_to_borrow(&mut a, H0 + 9, NOW_MS + 5_400), None);
}

#[test]
fn a_verdict_that_does_not_name_the_transfer_keeps_the_pause() {
    let mut a = after_a_send();
    let before = a.get_state().hl;
    // With no `sent`, and with an empty one.
    for (i, v) in [verdict(1, H0 + 7), naming(verdict(1, H0 + 7), &[])].iter().enumerate() {
        let height = H0 + 8 + i as u64;
        assert!(deliver(&mut a, borrow_intent(1_000_000_000), v, height).accepted);
        assert!(!lifted());
        assert_eq!(a.get_state().hl, before);
        assert!(try_to_borrow(&mut a, height, NOW_MS + 6_000).unwrap().starts_with(PAUSED));
    }
}

#[test]
fn with_two_transfers_open_naming_one_keeps_the_pause_until_the_others_2_days_and_1_hour() {
    for (named, left) in [(0, 1), (1, 0)] {
        let (mut a, nonces) = after_sends(2);
        assert_eq!(listed_sends(&a), nonces);
        assert_eq!(a.get_state().hl.send_open_until_ms, U64(nonces[1] + SEND_OPEN_MS));
        let v = naming(verdict(2, H0 + 104), &[nonces[named]]);
        assert!(deliver(&mut a, borrow_intent(1_000_000_000), &v, H0 + 105).accepted);
        assert!(!lifted());
        let until = nonces[left] + SEND_OPEN_MS;
        assert_eq!((listed_sends(&a), a.get_state().hl.send_open_until_ms), (vec![nonces[left]], U64(until)));
        // 1 ms before the other's time is up the borrow is still refused; at that time it goes through. The verdict
        // stays fresh: only the clock moves here.
        assert!(try_to_borrow(&mut a, H0 + 106, until - 1).unwrap().starts_with(PAUSED));
        assert_eq!(try_to_borrow(&mut a, H0 + 106, until), None);
    }
    // Both named, in one verdict or in two: the pause ends.
    let (mut a, nonces) = after_sends(2);
    assert!(deliver(&mut a, Intent::Check {}, &naming(verdict(2, H0 + 104), &nonces[..1]), H0 + 105).accepted);
    assert!(!lifted());
    assert!(deliver(&mut a, borrow_intent(1_000_000_000), &naming(verdict(2, H0 + 106), &nonces), H0 + 107).accepted);
    assert!(lifted());
    assert_eq!(a.get_state().hl.send_open_until_ms, U64(0));
    assert_eq!(try_to_borrow(&mut a, H0 + 108, nonces[1] + 60_000), None);
}

#[test]
fn a_ninth_transfer_moves_the_oldest_into_the_floor_and_the_floor_holds_whatever_a_verdict_names() {
    let (a, nonces) = after_sends(8);
    assert_eq!((listed_sends(&a), a.get_state().hl.send_floor_until_ms), (nonces, U64(0)));
    let (mut a, nonces) = after_sends(9);
    let floor = nonces[0] + SEND_OPEN_MS;
    let hl = a.get_state().hl;
    assert_eq!(listed_sends(&a), nonces[1..]);
    assert_eq!((hl.send_floor_until_ms, hl.send_open_until_ms), (U64(floor), U64(nonces[8] + SEND_OPEN_MS)));
    // A verdict names all nine as sent. The eight leave the list, and the pause holds until the floor.
    let v = naming(verdict(9, H0 + 801), &nonces);
    assert!(deliver(&mut a, borrow_intent(1_000_000_000), &v, H0 + 802).accepted);
    assert!(!lifted());
    let hl = a.get_state().hl;
    assert_eq!((hl.open_sends, hl.send_floor_until_ms, hl.send_open_until_ms), (vec![], U64(floor), U64(floor)));
    assert!(try_to_borrow(&mut a, H0 + 803, floor - 1).unwrap().starts_with("no borrow until 2023-11-16 23:13:20 UTC"));
    assert_eq!(try_to_borrow(&mut a, H0 + 803, floor), None);
}

#[test]
fn a_refused_verdict_lifts_nothing_even_if_it_names_the_transfer() {
    let changes: [(fn(&mut Value), &str); 5] = [
        (|v| v["nonce"] = json!(0), "nonce 0 is not the counter 1"),
        (|v| v["model"] = json!("B-0.3"), "model B-0.3 is not this account's model B-0.2"),
        (|v| v["acct"] = json!("bob.pbf.testnet"), "is not this account"),
        (|v| v["ok"] = json!(false), "ok is false"),
        (|v| v["top"] = json!(["x".repeat(4_096)]), "above the 4096-byte limit"),
    ];
    for (change, why) in changes {
        let mut a = after_a_send();
        let before = a.get_state().hl;
        let mut v = naming(verdict(1, H0 + 7), &[NOW_MS]);
        change(&mut v);
        let outcome = deliver(&mut a, borrow_intent(1_000_000_000), &v, H0 + 8);
        assert!(!outcome.accepted && outcome.reason.as_ref().unwrap().contains(why), "{outcome:?}");
        assert!(!lifted());
        assert_eq!(a.get_state().hl, before, "{why}");
        // The verdict held from before is still fresh, and the pause still holds the borrow back.
        assert!(try_to_borrow(&mut a, H0 + 9, NOW_MS + 5_400).unwrap().starts_with(PAUSED), "{why}");
    }
}

#[test]
fn a_verdict_naming_a_nonce_the_account_never_noted_changes_nothing() {
    let mut a = after_a_send();
    let before = a.get_state().hl;
    let strange = naming(verdict(1, H0 + 7), &[NOW_MS - 1, NOW_MS + 1, 0, u64::MAX]);
    assert!(deliver(&mut a, borrow_intent(1_000_000_000), &strange, H0 + 8).accepted);
    assert!(!lifted());
    assert_eq!(a.get_state().hl, before);
    assert!(try_to_borrow(&mut a, H0 + 9, NOW_MS + 5_400).unwrap().starts_with(PAUSED));
    // An account with nothing open isn't touched either.
    let mut a = account();
    let before = a.get_state().hl;
    assert!(deliver(&mut a, Intent::Check {}, &naming(verdict(0, H0), &[NOW_MS]), H0 + 2).accepted);
    assert!(!lifted());
    assert_eq!(a.get_state().hl, before);
}

#[test]
fn a_transfer_that_is_2_days_and_1_hour_old_leaves_the_list_by_itself() {
    let (mut a, nonces) = after_sends(2);
    let v = verdict(2, H0 + 104);
    // An accepted verdict that names nothing, 1 ms before the first one's time is up: both are still listed.
    let last_ms = nonces[0] + SEND_OPEN_MS - 1;
    assert!(deliver_at(&mut a, Intent::Check {}, &v, H0 + 105, last_ms * 1_000_000).accepted);
    assert_eq!(listed_sends(&a), nonces);
    // At its time the first has gone, and the pause still holds for the second.
    assert!(deliver_at(&mut a, Intent::Check {}, &v, H0 + 106, (last_ms + 1) * 1_000_000).accepted);
    let until = nonces[1] + SEND_OPEN_MS;
    assert_eq!((listed_sends(&a), a.get_state().hl.send_open_until_ms), (vec![nonces[1]], U64(until)));
    // Once the second is that old too, the list is empty and the time is 0. The pause ended on time, not early.
    assert!(deliver_at(&mut a, Intent::Check {}, &v, H0 + 107, until * 1_000_000).accepted);
    assert!(!lifted());
    let hl = a.get_state().hl;
    assert_eq!((hl.open_sends, hl.send_open_until_ms, hl.send_floor_until_ms), (vec![], U64(0), U64(0)));
    // The next transfer drops old ones too: a week on, only the new one is listed.
    let (mut a, _) = after_sends(2);
    let later = NOW_MS + 7 * DAY_MS;
    ctx(OWNER, 1, H0 + 200, later * 1_000_000, vec![]);
    a.hl_withdraw(U128(1_000_000), FLOAT.into(), None, None, None).detach();
    assert_eq!((listed_sends(&a), a.get_state().hl.send_open_until_ms), (vec![later], U64(later + SEND_OPEN_MS)));
}

#[test]
fn the_view_shows_the_open_transfers_as_strings_and_the_floor() {
    let (a, nonces) = after_sends(9);
    let view = near_sdk::serde_json::to_value(a.get_state()).unwrap();
    let listed: Vec<String> = nonces[1..].iter().map(|nonce| nonce.to_string()).collect();
    assert_eq!(view["hl"]["open_sends"], json!(listed));
    assert_eq!(view["hl"]["open_sends"][0], json!("1700000060000"));
    assert_eq!(view["hl"]["send_floor_until_ms"], json!("1700176400000"));
    assert_eq!(view["hl"]["send_open_until_ms"], json!((nonces[8] + SEND_OPEN_MS).to_string()));
    // With nothing open, an empty list and "0".
    let view = near_sdk::serde_json::to_value(account().get_state()).unwrap();
    assert_eq!((view["hl"]["open_sends"].clone(), view["hl"]["send_floor_until_ms"].clone()), (json!([]), json!("0")));
}

#[test]
fn a_transfer_is_listed_from_the_moment_its_signature_is_asked_for_even_if_the_answer_never_arrives() {
    let mut a = account();
    give_key(&mut a, KEY);
    at(OWNER, 1, H0);
    a.hl_withdraw(U128(1_000_000), FLOAT.into(), None, None, None).detach();
    // Asked for, and not answered yet.
    assert_eq!(listed_sends(&a), vec![NOW_MS]);
    // The signer's call fails or times out. Nothing is signed, and the transfer stays listed: the signer's answer may
    // be public all the same.
    assert_eq!(sign_with(&mut a, PromiseResult::Failed), None);
    let hl = a.get_state().hl;
    assert!(hl.signed.is_empty());
    assert_eq!((listed_sends(&a), hl.send_open_until_ms), (vec![NOW_MS], U64(NOW_MS + SEND_OPEN_MS)));
    // The same for a plan's `home` step.
    let mut a = with_plan(json!([home_step()]));
    give_key(&mut a, KEY);
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert!(listed_sends(&a).is_empty());
    assert!(step_ready(&mut a, PID, 0, checked(), H0 + 27));
    assert_eq!(listed_sends(&a), vec![time(H0 + 27) / 1_000_000]);
    assert_eq!(sign_with(&mut a, PromiseResult::Failed), None);
    assert_eq!(listed_sends(&a), vec![time(H0 + 27) / 1_000_000]);
}

// ---------------------------------------------------------------------------------------------------------------
// hl_withdraw from spot; the gateway's secrets_ref
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn hl_withdraw_can_send_from_the_spot_balance() {
    let mut a = account();
    give_key(&mut a, KEY);
    at(OWNER, 1, H0);
    a.hl_withdraw(U128(9_500_000_000), FLOAT.into(), Some("spot".into()), None, None).detach();
    let made = calls();
    let action = SendAsset {
        kind: "sendAsset",
        hyperliquid_chain: "Testnet",
        signature_chain_id: "0x66eee",
        destination: FLOAT,
        source_dex: "spot",
        destination_dex: "",
        token: HL_USDC,
        amount: "9500",
        from_sub_account: "",
        nonce: NOW_MS,
    };
    assert_eq!(made[0].2["request"]["payload_v2"]["Ecdsa"], hex(&action.digest().unwrap()));
    let posted: Value = near_sdk::serde_json::from_str(made[1].2["action"].as_str().unwrap()).unwrap();
    assert_eq!((posted["sourceDex"].clone(), posted["destinationDex"].clone()), (json!("spot"), json!("")));
    // An empty source_dex is the perp balance, as when it is left out.
    at(OWNER, 1, H0 + 1);
    a.hl_withdraw(U128(9_500_000_000), FLOAT.into(), Some(String::new()), None, None).detach();
    let posted: Value = near_sdk::serde_json::from_str(calls()[1].2["action"].as_str().unwrap()).unwrap();
    assert_eq!(posted["sourceDex"], "");
}

#[test]
#[should_panic(expected = r#"source_dex must be "" (perps) or "spot""#)]
fn hl_withdraw_takes_only_perps_or_spot() {
    let mut a = account();
    give_key(&mut a, KEY);
    at(OWNER, 1, H0);
    a.hl_withdraw(U128(1_000_000), FLOAT.into(), Some("perp".into()), None, None).detach();
}

#[test]
fn request_agent_passes_the_gateways_secrets_ref_through() {
    at("pbf.testnet", 0, H0);
    let mut c = config();
    c.gateway.secrets_ref = Some(SecretsRef { profile: "pb-gateway".into(), account_id: id("pbf-keeper.testnet") });
    let mut a = Account::new(id(OWNER), c, None);
    let deposit = NearToken::from_millinear(10).as_yoctonear();
    at(OWNER, deposit, H0);
    a.request_agent().detach();
    assert_eq!(calls()[0].2["secrets_ref"], json!({ "profile": "pb-gateway", "account_id": "pbf-keeper.testnet" }));
    // pb-risk's checks still send none.
    at(OWNER, deposit, H0 + 1);
    a.request_check(Intent::Check {}).detach();
    assert_eq!(calls()[0].2["secrets_ref"], Value::Null);
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 4: the stored plan (INTERFACES.md 13 and 14)
// ---------------------------------------------------------------------------------------------------------------

/// A 1Click deposit address on NEAR: a fresh implicit account, as the stand-in gives.
const DEP: &str = "2b6f1e0c9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f";
/// The plan `with_plan` stores: the verdict's `blk`, H0 + 20.
const PID: &str = "1020";
const MINUTE_MS: u64 = 60_000;

/// The block time at `height`, as `at` sets it.
fn time(height: u64) -> u64 {
    T0 + (height - H0) * 600_000_000
}

/// A quote's expiry: 10 minutes after T0.
fn quote_exp() -> u64 {
    NOW_MS + 10 * MINUTE_MS
}

fn to_hl_step(amt: u128, exp: u64) -> Value {
    json!({ "k": "to_hl", "amt": amt.to_string(), "dep": DEP, "exp": exp })
}

fn sell_step(tok: &str) -> Value {
    json!({ "k": "sell", "tok": tok, "amt": "1500000", "min": 1_100_000_000u64, "dep": DEP, "exp": quote_exp() })
}

fn home_step() -> Value {
    json!({ "k": "home", "amt": 5_000_000u64, "dep": FLOAT.to_uppercase().replace("0X", "0x"), "exp": quote_exp() })
}

fn with_nonce(mut v: Value, nonce: u64) -> Value {
    v["nonce"] = json!(nonce);
    v
}

/// A REBALANCE verdict for counter `nonce` at block `blk`, with these steps.
fn rebalance(nonce: u64, blk: u64, steps: Value) -> Value {
    let mut v = verdict(nonce, blk);
    v["action"] = json!("REBALANCE");
    v["venues"]["hl_margin_ratio_bp"] = json!(6_500);
    v["plan"] = steps;
    v
}

/// An account with a $1,000 loan (counter `LOANED`) and a stored REBALANCE plan of `steps`, from a verdict at H0 + 20.
fn with_plan(steps: Value) -> Account {
    let mut a = with_loan();
    assert!(deliver(&mut a, Intent::Check {}, &rebalance(LOANED, H0 + 20, steps), H0 + 21).accepted);
    a
}

/// An account with a loan and the drill's DELEVERAGE plan, confirmed by two verdicts 3 minutes apart. Its id is the
/// second verdict's `blk`, 1320.
fn with_drill_plan() -> Account {
    let mut a = with_loan();
    let first = with_nonce(deleverage(H0 + 20, 3_000), LOANED);
    assert!(deliver(&mut a, Intent::Check {}, &first, H0 + 21).accepted);
    assert!(a.get_state().plan.is_none());
    let second = with_nonce(deleverage(H0 + 320, 3_000), LOANED);
    assert!(deliver_at(&mut a, Intent::Check {}, &second, H0 + 321, time(H0 + 21) + 3 * MINUTE_NS).accepted);
    a
}

/// `who` runs step `i` of plan `pid` at `height`.
fn run_step(a: &mut Account, who: &str, pid: &str, i: u32, height: u64) {
    at(who, 0, height);
    a.execute_step(pid.into(), i).detach();
}

/// The first call of step `i` answered with `result`. Returns whether the step went on to send.
fn step_ready(a: &mut Account, pid: &str, i: u32, result: PromiseResult, height: u64) -> bool {
    ctx(ACCOUNT, 0, height, time(height), vec![result]);
    match a.on_step_ready(pid.into(), i) {
        PromiseOrValue::Promise(p) => {
            p.detach();
            true
        }
        PromiseOrValue::Value(sent) => sent,
    }
}

fn checked() -> PromiseResult {
    PromiseResult::Successful(Vec::new())
}

/// The data of the `name` events the last call logged, each checked for the pool's standard and version.
fn events(name: &str) -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|text| near_sdk::serde_json::from_str::<Value>(text).unwrap())
        .filter(|e| e["event"] == name)
        .map(|e| {
            assert_eq!((e["standard"].as_str(), e["version"].as_str()), (Some("pb-pool"), Some("1.0.0")));
            e["data"].clone()
        })
        .collect()
}

fn transfers(a: &Account) -> Vec<Transfer> {
    a.transfers().cloned().collect()
}

fn step_done(a: &Account, i: usize) -> bool {
    a.plan.as_ref().unwrap().steps[i].done
}

#[test]
fn a_rebalance_plan_is_stored_as_soon_as_its_verdict_is_accepted() {
    let a = with_plan(json!([to_hl_step(100_000_000, quote_exp())]));
    assert_eq!(events("plan_stored"), vec![json!({ "pid": PID, "action": "REBALANCE", "steps": ["to_hl"] })]);
    let view = near_sdk::serde_json::to_value(a.get_state()).unwrap();
    let expected = json!({
        "pid": PID, "action": "REBALANCE", "stored_at": time(H0 + 21).to_string(),
        "steps": shown(json!([to_hl_step(100_000_000, quote_exp())])),
    });
    assert_eq!(view["plan"], expected);
    // REBALANCE_NOW is stored at once too.
    let mut a = with_loan();
    let mut v = rebalance(LOANED, H0 + 20, json!([to_hl_step(5, quote_exp())]));
    v["action"] = json!("REBALANCE_NOW");
    assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 21).accepted);
    assert_eq!(a.get_state().plan.unwrap().action, Action::RebalanceNow);
}

#[test]
fn the_confirming_deleverage_verdicts_plan_is_stored_with_its_blk_as_pid() {
    let a = with_drill_plan();
    assert_eq!(
        events("plan_stored"),
        vec![json!({ "pid": "1320", "action": "DELEVERAGE", "steps": ["perp", "repay"] })]
    );
    let plan = a.get_state().plan.unwrap();
    assert_eq!((plan.pid.as_str(), plan.action), ("1320", Action::Deleverage));
    assert_eq!(Value::Array(plan.steps), shown(drill_plan()));
}

#[test]
fn a_first_deleverage_verdict_keeps_the_plan_held() {
    let mut a = with_plan(json!([to_hl_step(5, quote_exp())]));
    let first = with_nonce(deleverage(H0 + 30, 3_000), LOANED);
    assert!(deliver(&mut a, Intent::Check {}, &first, H0 + 31).accepted);
    let plan = a.get_state().plan.unwrap();
    assert_eq!((plan.pid.as_str(), plan.action), (PID, Action::Rebalance));
}

#[test]
fn a_newer_plan_replaces_the_old_one_with_its_steps_not_started() {
    let mut a = with_plan(json!([to_hl_step(5, quote_exp())]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert!(step_done(&a, 0));
    let newer = rebalance(LOANED + 1, H0 + 30, json!([to_hl_step(7, quote_exp()), repay_step()]));
    assert!(deliver(&mut a, Intent::Check {}, &newer, H0 + 31).accepted);
    let plan = a.get_state().plan.unwrap();
    assert_eq!((plan.pid.as_str(), plan.steps.len()), ("1030", 2));
    assert!(!step_done(&a, 0) && !step_done(&a, 1));
}

fn repay_step() -> Value {
    json!({ "k": "repay", "amt": 2_000_000_000u64 })
}

#[test]
fn a_plan_read_at_the_same_block_does_not_replace_the_stored_one() {
    let mut a = with_plan(json!([to_hl_step(5, quote_exp())]));
    let same = rebalance(LOANED, H0 + 20, json!([repay_step()]));
    assert!(deliver(&mut a, Intent::Check {}, &same, H0 + 22).accepted);
    assert!(get_logs().contains(&"plan 1020 kept: a plan read at block 1020 can't replace it".to_string()));
    assert_eq!(a.plan.as_ref().unwrap().steps.len(), 1);
    assert!(events("plan_stored").is_empty());
}

#[test]
fn none_while_healthy_clears_the_plan_and_none_in_another_state_keeps_it() {
    let mut a = with_plan(json!([to_hl_step(5, quote_exp())]));
    let mut watch = verdict(LOANED, H0 + 30);
    watch["state"] = json!("WATCH");
    assert!(deliver(&mut a, Intent::Check {}, &watch, H0 + 31).accepted);
    assert!(a.get_state().plan.is_some());
    assert!(deliver(&mut a, Intent::Check {}, &verdict(LOANED, H0 + 32), H0 + 33).accepted);
    assert!(a.get_state().plan.is_none());
    assert!(get_logs().contains(&"plan cleared: the account is HEALTHY".to_string()));
}

#[test]
fn steps_of_unknown_kinds_are_kept_and_shown() {
    let a = with_plan(json!([{ "k": "hedge", "coin": "BTC" }, "an old text step"]));
    let steps = a.get_state().plan.unwrap().steps;
    let expected =
        json!([{ "k": "hedge", "coin": "BTC", "done": false }, { "step": "an old text step", "done": false }]);
    assert_eq!(Value::Array(steps), expected);
    assert_eq!(events("plan_stored")[0]["steps"], json!(["hedge", ""]));
}

#[test]
fn a_verdict_with_more_than_4_plan_steps_is_refused() {
    refused_with(|v| v["plan"] = Value::Array(vec![repay_step(); 5]), "the plan has 5 steps, above the 4 allowed");
    let mut a = account();
    let v = rebalance(0, H0, Value::Array(vec![repay_step(); 4]));
    assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 1).accepted);
}

// execute_step: refusals.

#[test]
#[should_panic(expected = "no plan is stored")]
fn execute_step_needs_a_stored_plan() {
    let mut a = with_loan();
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
}

#[test]
#[should_panic(expected = "plan 999 is not the stored plan, 1020")]
fn execute_step_needs_the_stored_plans_id() {
    let mut a = with_plan(json!([repay_step()]));
    run_step(&mut a, "keeper.testnet", "999", 0, H0 + 25);
}

#[test]
#[should_panic(expected = "plan 1020 has no step 1")]
fn execute_step_needs_a_step_that_exists() {
    let mut a = with_plan(json!([repay_step()]));
    run_step(&mut a, "keeper.testnet", PID, 1, H0 + 25);
}

#[test]
#[should_panic(expected = "step 0 of plan 1020 has already run")]
fn each_step_runs_once() {
    let mut a = with_plan(json!([repay_step()]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    run_step(&mut a, "anyone.testnet", PID, 0, H0 + 26);
}

#[test]
#[should_panic(expected = "step 0 is a perp step: the gateway places this one")]
fn the_gateway_places_perp_steps() {
    let mut a = with_drill_plan();
    run_step(&mut a, "keeper.testnet", "1320", 0, H0 + 330);
}

#[test]
#[should_panic(expected = "step 0 is a cancel step: the gateway places this one")]
fn the_gateway_places_cancel_steps() {
    let mut a = with_plan(json!([{ "k": "cancel" }]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
}

#[test]
#[should_panic(expected = "step 0 is a hedge step, which the account can't run")]
fn a_step_of_an_unknown_kind_does_not_run() {
    let mut a = with_plan(json!([{ "k": "hedge" }]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
}

#[test]
#[should_panic(expected = "step 0 can't run: its dep is missing or not valid")]
fn a_step_with_a_bad_field_does_not_run() {
    let mut a = with_plan(json!([{ "k": "to_hl", "amt": "5", "dep": "Not An Account", "exp": quote_exp() }]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
}

#[test]
#[should_panic(expected = "step 0's quote has 299 s left: a step needs 5 minutes")]
fn a_step_needs_5_minutes_of_its_quote_left() {
    let exp = time(H0 + 30) / 1_000_000 + 5 * MINUTE_MS - 1;
    let mut a = with_plan(json!([to_hl_step(5, exp)]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 30);
}

#[test]
fn a_step_with_exactly_5_minutes_left_runs() {
    let exp = time(H0 + 30) / 1_000_000 + 5 * MINUTE_MS;
    let mut a = with_plan(json!([to_hl_step(5, exp)]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 30);
    assert_eq!(calls()[0].1, "check_step");
}

#[test]
#[should_panic(expected = "the step's token is not an allow-listed token")]
fn a_sell_step_sells_a_listed_token() {
    let mut a = with_plan(json!([sell_step("other.testnet")]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
}

#[test]
#[should_panic(expected = "no Hyperliquid address yet: call hl_init first")]
fn a_home_step_needs_the_hyperliquid_address() {
    let mut a = with_plan(json!([home_step()]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
}

#[test]
#[should_panic(expected = "8 transfers are under way already: wait for one to settle")]
fn no_step_sends_while_8_transfers_are_under_way() {
    let mut a = with_plan(json!([to_hl_step(5, quote_exp())]));
    for n in 0..8 {
        a.record_transfer(Transfer::new(format!("move:{n}"), TransferKind::ToHl, USDC, 1, DEP, quote_exp()));
    }
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
}

// execute_step: the drill's repay.

#[test]
fn anyone_runs_a_repay_step_which_needs_no_check_step() {
    let mut a = with_drill_plan();
    run_step(&mut a, "keeper.testnet", "1320", 1, H0 + 330);
    let made = calls();
    assert_eq!((made[0].0.as_str(), made[0].1.as_str()), (USDC, "ft_balance_of"));
    assert_eq!(made[0].2, json!({ "account_id": ACCOUNT }));
    assert_eq!((made[1].0.as_str(), made[1].1.as_str()), (ACCOUNT, "on_step_ready"));
    assert_eq!(made[1].2, json!({ "pid": "1320", "i": 1 }));
    assert!(made.iter().all(|c| c.1 != "check_step"));
    assert_eq!(events("step_run"), vec![json!({ "pid": "1320", "i": 1, "k": "repay" })]);
    assert!(step_done(&a, 1));
    // A repay leaves the counter alone: it only lowers risk.
    assert_eq!(a.get_state().counter, LOANED);
    // The account holds $1,500, under the step's $2,000: it repays $1,500, and the pool keeps at most the debt.
    assert!(step_ready(&mut a, "1320", 1, PromiseResult::Successful(b"\"1500000000\"".to_vec()), H0 + 332));
    let made = calls();
    assert_eq!((made[0].0.as_str(), made[0].1.as_str()), (USDC, "ft_transfer_call"));
    assert_eq!(
        made[0].2,
        json!({ "receiver_id": POOL, "amount": "1500000000", "memo": null, "msg": r#"{"pool":"repay"}"# })
    );
    assert_eq!((made[1].1.as_str(), made[1].2.clone()), ("on_repaid", json!({ "amount": "1500000000", "seq": 1 })));
}

#[test]
fn a_repay_step_repays_at_most_its_amount() {
    let mut a = with_drill_plan();
    run_step(&mut a, "keeper.testnet", "1320", 1, H0 + 330);
    assert!(step_ready(&mut a, "1320", 1, PromiseResult::Successful(b"\"9000000000\"".to_vec()), H0 + 332));
    assert_eq!(calls()[0].2["amount"], "2000000000");
}

#[test]
fn a_repay_step_that_finds_no_usdc_or_cant_read_it_may_run_again() {
    // Run before a sale's USDC has arrived, it repays nothing, and can run once the USDC is there.
    let mut a = with_drill_plan();
    run_step(&mut a, "keeper.testnet", "1320", 1, H0 + 330);
    assert!(!step_ready(&mut a, "1320", 1, PromiseResult::Successful(b"\"0\"".to_vec()), H0 + 332));
    let why =
        "step 1 of plan 1320 didn't go out, as the account holds no USDC yet: nothing was sent, and it may run again";
    assert_eq!(get_logs(), vec![why]);
    assert!(get_created_receipts().is_empty() && !step_done(&a, 1));
    run_step(&mut a, "keeper.testnet", "1320", 1, H0 + 333);
    assert!(step_ready(&mut a, "1320", 1, PromiseResult::Successful(b"\"5\"".to_vec()), H0 + 334));
    assert_eq!(calls()[0].2["amount"], "5");
    // A failed read changes nothing either.
    let mut a = with_drill_plan();
    run_step(&mut a, "keeper.testnet", "1320", 1, H0 + 330);
    assert!(!step_ready(&mut a, "1320", 1, PromiseResult::Failed, H0 + 332));
    assert!(!step_done(&a, 1));
}

#[test]
fn a_blocked_account_still_runs_repay_steps() {
    let mut a = with_drill_plan();
    a.blocked = true;
    run_step(&mut a, "keeper.testnet", "1320", 1, H0 + 330);
    assert_eq!(calls()[0].1, "ft_balance_of");
}

// execute_step: sell, to_hl and home.

#[test]
fn a_to_hl_step_asks_the_pool_then_sends_and_records_its_transfer() {
    let mut a = with_plan(json!([to_hl_step(100_000_000, quote_exp())]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    let made = calls();
    assert_eq!((made[0].0.as_str(), made[0].1.as_str(), made[0].3.as_yoctonear()), (POOL, "check_step", 0));
    assert_eq!(made[0].2, json!({ "plan_id": PID, "step": 0, "token": USDC, "amount": "100000000" }));
    assert_eq!((made[1].1.as_str(), made[1].2.clone()), ("on_step_ready", json!({ "pid": PID, "i": 0 })));
    assert_eq!((gas("check_step"), gas("on_step_ready")), (Gas::from_tgas(15), Gas::from_tgas(90)));
    assert_eq!(events("step_run"), vec![json!({ "pid": PID, "i": 0, "k": "to_hl" })]);
    // Like a withdrawal, it bumps the counter.
    assert_eq!(a.get_state().counter, LOANED + 1);
    assert!(step_done(&a, 0) && transfers(&a).is_empty());
    // The pool allowed it: the USDC goes to the deposit address, and the transfer is recorded.
    assert!(step_ready(&mut a, PID, 0, checked(), H0 + 27));
    let made = calls();
    assert_eq!((made[0].0.as_str(), made[0].1.as_str()), (USDC, "storage_deposit"));
    assert_eq!(made[0].2, json!({ "account_id": DEP, "registration_only": true }));
    assert_eq!(
        (made[1].1.as_str(), made[1].2.clone()),
        ("ft_transfer", json!({ "receiver_id": DEP, "amount": "100000000" }))
    );
    assert_eq!((made[2].0.as_str(), made[2].1.as_str()), (ACCOUNT, "on_sent"));
    assert_eq!((made[2].2.clone(), gas("on_sent")), (json!({ "id": "1020:0" }), Gas::from_tgas(10)));
    let deadline = (quote_exp() + 30 * MINUTE_MS) * 1_000_000;
    let expected = Transfer::new("1020:0".into(), TransferKind::ToHl, USDC, 100_000_000, DEP, quote_exp());
    assert_eq!(expected.deadline, U64(deadline));
    assert_eq!(a.get_state().pending, vec![Pending::Transfer(expected.clone())]);
    let view = near_sdk::serde_json::to_value(a.get_state()).unwrap();
    let shape = json!([{ "transfer": {
        "id": "1020:0", "kind": "to_hl", "token": USDC, "amount": "100000000", "dep": DEP, "deadline": deadline.to_string(),
    } }]);
    assert_eq!(view["pending"], shape);
    // The tokens went out: the transfer stays under way, and the counter moves on again.
    ctx(ACCOUNT, 0, H0 + 28, time(H0 + 28), vec![checked()]);
    assert!(a.on_sent(Some("1020:0".into())));
    assert_eq!(transfers(&a), vec![expected]);
    assert_eq!(a.get_state().counter, LOANED + 2);
}

#[test]
fn a_transfer_whose_tokens_did_not_go_out_is_dropped() {
    let mut a = with_plan(json!([to_hl_step(100_000_000, quote_exp())]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert!(step_ready(&mut a, PID, 0, checked(), H0 + 27));
    ctx(ACCOUNT, 0, H0 + 28, time(H0 + 28), vec![PromiseResult::Failed]);
    assert!(!a.on_sent(Some("1020:0".into())));
    assert!(transfers(&a).is_empty());
    assert_eq!(get_logs(), vec!["transfer 1020:0 didn't go out: nothing was sent"]);
}

#[test]
fn a_sell_step_checks_and_sends_its_own_token() {
    let mut a = with_plan(json!([sell_step(NBTC)]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert_eq!(calls()[0].2, json!({ "plan_id": PID, "step": 0, "token": NBTC, "amount": "1500000" }));
    assert!(step_ready(&mut a, PID, 0, checked(), H0 + 27));
    let made = calls();
    assert_eq!((made[0].0.as_str(), made[1].0.as_str(), made[1].1.as_str()), (NBTC, NBTC, "ft_transfer"));
    let t = &transfers(&a)[0];
    assert_eq!(
        (t.id.as_str(), t.kind, t.token.as_str(), t.amount),
        ("1020:0", TransferKind::Sell, NBTC, U128(1_500_000))
    );
}

#[test]
fn a_step_the_pool_refuses_sends_nothing_and_may_run_again() {
    let mut a = with_plan(json!([to_hl_step(100_000_000, quote_exp())]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert!(!step_ready(&mut a, PID, 0, PromiseResult::Failed, H0 + 27));
    assert!(get_created_receipts().is_empty() && transfers(&a).is_empty());
    assert!(get_logs()[0].contains("didn't go out, as the pool refused it: nothing was sent, and it may run again"));
    assert!(!step_done(&a, 0));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 28);
    assert_eq!(calls()[0].1, "check_step");
}

#[test]
fn a_step_whose_plan_was_replaced_meanwhile_sends_nothing() {
    let mut a = with_plan(json!([to_hl_step(100_000_000, quote_exp())]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    let newer = rebalance(LOANED + 1, H0 + 26, json!([to_hl_step(7, quote_exp())]));
    assert!(deliver(&mut a, Intent::Check {}, &newer, H0 + 26).accepted);
    assert!(!step_ready(&mut a, PID, 0, checked(), H0 + 27));
    assert_eq!(get_logs(), vec!["plan 1020 was replaced before step 0 went out: nothing was sent"]);
    assert!(get_created_receipts().is_empty() && !step_done(&a, 0));
}

#[test]
fn a_blocked_account_runs_no_step_that_sends() {
    for step in [to_hl_step(5, quote_exp()), sell_step(NBTC), home_step()] {
        let mut a = with_plan(json!([step]));
        a.blocked = true;
        at("keeper.testnet", 0, H0 + 25);
        let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| a.execute_step(PID.into(), 0).detach()));
        let why = refused.expect_err("a step that sends ran on a blocked account");
        let why = why.downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(why.contains("this account is blocked after a default"), "{step}: {why}");
    }
}

#[test]
fn a_home_step_signs_send_asset_to_dep_and_opens_the_send_window() {
    let mut a = with_plan(json!([home_step()]));
    give_key(&mut a, KEY);
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert_eq!(calls()[0].2, json!({ "plan_id": PID, "step": 0, "token": USDC, "amount": "5000000" }));
    assert!(step_ready(&mut a, PID, 0, checked(), H0 + 27));
    let nonce = time(H0 + 27) / 1_000_000;
    let action = SendAsset {
        kind: "sendAsset",
        hyperliquid_chain: "Testnet",
        signature_chain_id: "0x66eee",
        destination: FLOAT,
        source_dex: "",
        destination_dex: "",
        token: HL_USDC,
        amount: "5",
        from_sub_account: "",
        nonce,
    };
    let made = calls();
    assert_eq!((made[0].0.as_str(), made[0].1.as_str()), (MPC, "sign"));
    assert_eq!(made[0].2["request"]["payload_v2"]["Ecdsa"], hex(&action.digest().unwrap()));
    assert_eq!(made[1].2["transfer"], "1020:0");
    assert_eq!(a.get_state().hl.send_open_until_ms, U64(nonce + SEND_OPEN_MS));
    let expected = Transfer::new("1020:0".into(), TransferKind::Home, "USDC", 5_000_000, FLOAT, quote_exp());
    assert_eq!(transfers(&a), vec![expected.clone()]);
    // Signed: the action is kept for the backend to post, and the transfer stays under way.
    let entry = sign_with(&mut a, signed_ok()).unwrap();
    assert_eq!((entry.kind, entry.nonce), (ActionKind::SendAsset, nonce));
    assert_eq!(transfers(&a), vec![expected]);
}

#[test]
fn a_home_step_whose_signature_fails_drops_its_transfer_but_keeps_the_send_window() {
    let mut a = with_plan(json!([home_step()]));
    give_key(&mut a, KEY);
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert!(step_ready(&mut a, PID, 0, checked(), H0 + 27));
    assert_eq!(sign_with(&mut a, PromiseResult::Failed), None);
    assert!(transfers(&a).is_empty());
    assert!(a.get_state().hl.send_open_until_ms.0 > 0);
}

// Transfers: settled by msg or by a verdict.

#[test]
fn a_transfer_settles_when_its_delivery_or_refund_arrives_with_its_msg() {
    let mut a = with_plan(json!([sell_step(NBTC), to_hl_step(100_000_000, quote_exp())]));
    for i in 0..2 {
        run_step(&mut a, "keeper.testnet", PID, i, H0 + 25);
        assert!(step_ready(&mut a, PID, i, checked(), H0 + 27));
    }
    assert_eq!(transfers(&a).len(), 2);
    // The sale's USDC arrives: it is kept, and the sale is done.
    at(USDC, 0, H0 + 40);
    let kept = a.ft_on_transfer(id("solver.testnet"), U128(1_200_000_000), r#"{"pb":{"transfer":"1020:0"}}"#.into());
    assert!(matches!(kept, PromiseOrValue::Value(U128(0))));
    assert_eq!(events("transfer_done"), vec![json!({ "id": "1020:0", "how": "arrived" })]);
    // The move to Hyperliquid is refunded in the token sent.
    at(USDC, 0, H0 + 41);
    let kept = a.ft_on_transfer(id("solver.testnet"), U128(100_000_000), r#"{"pb":{"transfer":"1020:1"}}"#.into());
    assert!(matches!(kept, PromiseOrValue::Value(U128(0))));
    assert_eq!(events("transfer_done"), vec![json!({ "id": "1020:1", "how": "refunded" })]);
    assert!(transfers(&a).is_empty());
}

#[test]
fn a_transfer_msg_for_no_transfer_under_way_is_kept_as_a_deposit() {
    let mut a = account();
    at(NBTC, 0, H0);
    let kept = a.ft_on_transfer(id("solver.testnet"), U128(5), r#"{"pb":{"transfer":"1020:3"}}"#.into());
    assert!(matches!(kept, PromiseOrValue::Value(U128(0))));
    assert!(get_logs().contains(&"no transfer 1020:3 is under way: kept as a deposit".to_string()));
    assert!(events("transfer_done").is_empty());
}

#[test]
fn a_verdict_settles_the_transfers_it_lists_as_arrived() {
    let mut a = with_plan(json!([to_hl_step(100_000_000, quote_exp())]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert!(step_ready(&mut a, PID, 0, checked(), H0 + 27));
    let mut v = verdict(LOANED + 1, H0 + 40);
    v["arrived"] = json!(["1020:0", "move:9"]);
    assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 41).accepted);
    assert_eq!(events("transfer_done"), vec![json!({ "id": "1020:0", "how": "verdict" })]);
    assert!(transfers(&a).is_empty());
}

// The owner's own moves.

fn to_hl_move() -> Option<Move> {
    Some(Move { kind: TransferKind::ToHl, exp: quote_exp(), expect: None })
}

#[test]
fn a_move_to_hyperliquid_records_transfer_move_n() {
    let mut a = account();
    at(OWNER, 1, H0);
    a.withdraw(id(USDC), U128(25_000_000), id(DEP), to_hl_move()).detach();
    let made = calls();
    assert_eq!(
        made.iter().map(|c| c.1.as_str()).collect::<Vec<_>>(),
        vec!["storage_deposit", "ft_transfer", "on_sent"]
    );
    assert_eq!(made[2].2, json!({ "id": "move:0" }));
    let expected = Transfer::new("move:0".into(), TransferKind::ToHl, USDC, 25_000_000, DEP, quote_exp());
    assert_eq!(transfers(&a), vec![expected]);
    assert_eq!(a.get_state().next_move, 1);
    // The next move is move:1.
    at(OWNER, 1, H0 + 1);
    a.withdraw(id(USDC), U128(5), id(DEP), to_hl_move()).detach();
    assert_eq!(transfers(&a)[1].id, "move:1");
}

#[test]
#[should_panic(expected = "a to_hl move sends the USDC token")]
fn a_move_to_hyperliquid_sends_usdc() {
    let mut a = account();
    at(OWNER, 1, H0);
    a.withdraw(id(NBTC), U128(5), id(DEP), to_hl_move()).detach();
}

#[test]
#[should_panic(expected = "a sell move sends a token other than USDC")]
fn a_sale_sends_another_token() {
    let mut a = account();
    at(OWNER, 1, H0);
    a.withdraw(id(USDC), U128(5), id(DEP), Some(Move { kind: TransferKind::Sell, exp: quote_exp(), expect: None }))
        .detach();
}

#[test]
#[should_panic(expected = "a home move is hl_withdraw's")]
fn a_move_home_is_not_a_withdrawal() {
    let mut a = account();
    at(OWNER, 1, H0);
    a.withdraw(id(USDC), U128(5), id(DEP), Some(Move { kind: TransferKind::Home, exp: quote_exp(), expect: None }))
        .detach();
}

#[test]
#[should_panic(expected = "exp must be the quote's expiry, in the future, in unix ms")]
fn a_move_needs_a_quote_expiry_in_the_future() {
    let mut a = account();
    at(OWNER, 1, H0);
    a.withdraw(id(USDC), U128(5), id(DEP), Some(Move { kind: TransferKind::ToHl, exp: NOW_MS, expect: None })).detach();
}

#[test]
#[should_panic(expected = "8 transfers are under way already")]
fn no_move_starts_while_8_transfers_are_under_way() {
    let mut a = account();
    for n in 0..8 {
        at(OWNER, 1, H0 + n);
        a.withdraw(id(USDC), U128(5), id(DEP), to_hl_move()).detach();
    }
    at(OWNER, 1, H0 + 9);
    a.withdraw(id(USDC), U128(5), id(DEP), to_hl_move()).detach();
}

#[test]
fn a_move_home_records_transfer_move_n_and_drops_it_if_the_signature_fails() {
    let mut a = account();
    give_key(&mut a, KEY);
    at(OWNER, 1, H0);
    a.hl_withdraw(U128(9_500_000_000), FLOAT.into(), None, Some(quote_exp()), None).detach();
    assert_eq!(calls()[1].2["transfer"], "move:0");
    let expected = Transfer::new("move:0".into(), TransferKind::Home, "USDC", 9_500_000_000, FLOAT, quote_exp());
    assert_eq!(transfers(&a), vec![expected.clone()]);
    assert!(sign_with(&mut a, signed_ok()).is_some());
    assert_eq!(transfers(&a), vec![expected]);
    at(OWNER, 1, H0 + 1);
    a.hl_withdraw(U128(1_000_000), FLOAT.into(), None, Some(quote_exp()), None).detach();
    assert_eq!(sign_with(&mut a, PromiseResult::Failed), None);
    assert_eq!(transfers(&a).iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["move:0"]);
}

// Overdue transfers.

/// An account with no loan whose $25 move to Hyperliquid (move:0) left at T0, with a fresh borrow verdict, at block
/// time `now`.
fn after_a_move(now: u64) -> Account {
    let mut a = account();
    at(OWNER, 1, H0);
    a.withdraw(id(USDC), U128(25_000_000), id(DEP), to_hl_move()).detach();
    assert!(deliver_at(&mut a, borrow_intent(1_000_000_000), &verdict(1, H0 + 4), H0 + 5, now).accepted);
    a
}

/// The move's deadline: its quote's expiry plus 30 minutes.
fn move_deadline() -> u64 {
    (quote_exp() + 30 * MINUTE_MS) * 1_000_000
}

#[test]
#[should_panic(expected = "no borrow while transfer move:0 is overdue: its deadline was 2023-11-14 22:53:20 UTC")]
fn no_borrow_while_a_transfer_is_overdue() {
    let mut a = after_a_move(move_deadline() + 1);
    ctx(OWNER, 1, H0 + 6, move_deadline() + 1, vec![]);
    a.borrow(U128(1_000_000_000)).detach();
}

#[test]
fn a_transfer_is_not_overdue_until_its_deadline_has_passed() {
    let mut a = after_a_move(move_deadline());
    ctx(OWNER, 1, H0 + 6, move_deadline(), vec![]);
    a.borrow(U128(1_000_000_000)).detach();
    assert_eq!(calls()[0].1, "borrow");
}

#[test]
fn once_the_overdue_transfer_settles_borrowing_works_again() {
    let mut a = after_a_move(move_deadline() + 1);
    ctx(USDC, 0, H0 + 6, move_deadline() + 1, vec![]);
    let kept = a.ft_on_transfer(id("solver.testnet"), U128(25_000_000), r#"{"pb":{"transfer":"move:0"}}"#.into());
    assert!(matches!(kept, PromiseOrValue::Value(U128(0))));
    ctx(OWNER, 1, H0 + 7, move_deadline() + 2, vec![]);
    a.borrow(U128(1_000_000_000)).detach();
    assert_eq!(calls()[0].1, "borrow");
}

#[test]
#[should_panic(expected = "no withdrawal with a loan open while transfer 1020:0 is overdue")]
fn no_withdrawal_with_a_loan_while_a_transfer_is_overdue() {
    let mut a = with_plan(json!([to_hl_step(100_000_000, quote_exp())]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert!(step_ready(&mut a, PID, 0, checked(), H0 + 27));
    let late = move_deadline() + 1;
    assert!(deliver_at(&mut a, withdraw_intent(NBTC, 5), &verdict(LOANED + 1, H0 + 40), H0 + 41, late).accepted);
    ctx(OWNER, 1, H0 + 42, late, vec![]);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
}

#[test]
fn with_no_loan_a_withdrawal_goes_out_while_a_transfer_is_overdue() {
    let mut a = after_a_move(move_deadline() + 1);
    ctx(OWNER, 1, H0 + 6, move_deadline() + 1, vec![]);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
    assert_eq!(calls()[1].1, "ft_transfer");
}

#[test]
fn an_overdue_transfer_never_holds_back_steps_repayments_or_checks() {
    let mut a = with_plan(json!([repay_step()]));
    a.record_transfer(Transfer::new("move:0".into(), TransferKind::ToHl, USDC, 1, DEP, NOW_MS));
    let late = move_deadline() + 1;
    ctx("keeper.testnet", 0, H0 + 25, late, vec![]);
    a.execute_step(PID.into(), 0).detach();
    ctx(OWNER, 1, H0 + 26, late, vec![]);
    a.repay(U128(5)).detach();
    ctx("keeper.testnet", NearToken::from_millinear(10).as_yoctonear(), H0 + 27, late, vec![]);
    a.request_check(Intent::Check {}).detach();
    assert_eq!(calls()[0].1, "request_execution");
}

// DEFAULT.

fn default_verdict(nonce: u64, blk: u64) -> Value {
    let mut v = verdict(nonce, blk);
    v["state"] = json!("DEFAULT");
    v["eq"] = json!(-50_000_000i64);
    v
}

/// A DEFAULT verdict read at `blk`, arriving at `height` (0.6 s a block, so 300 blocks are 3 minutes).
fn deliver_default(a: &mut Account, blk: u64, height: u64) -> CheckOutcome {
    deliver(a, Intent::Check {}, &default_verdict(LOANED, blk), height)
}

const FIRST_DEFAULT: &str = "DEFAULT: a first check. A second DEFAULT verdict 2 to 5 minutes later blocks the account";
const CONFIRMED_DEFAULT: &str = "DEFAULT confirmed: the account is blocked, and the pool writes off its debt";

#[test]
fn a_single_default_verdict_blocks_nothing_and_writes_nothing_off() {
    let mut a = with_loan();
    assert!(deliver_default(&mut a, H0 + 20, H0 + 21).accepted);
    assert!(get_created_receipts().is_empty(), "a first DEFAULT called the pool");
    assert!(get_logs().contains(&FIRST_DEFAULT.to_string()));
    assert!(!a.get_state().blocked);
    let view = near_sdk::serde_json::to_value(a.get_state()).unwrap();
    assert_eq!(view["default"], json!({ "first_at": time(H0 + 21).to_string() }));
    // The owner can still repay, and a verdict that isn't DEFAULT clears the record.
    at(OWNER, 1, H0 + 22);
    a.repay(U128(5)).detach();
    assert!(deliver(&mut a, Intent::Check {}, &verdict(LOANED, H0 + 30), H0 + 31).accepted);
    assert_eq!(a.get_state().default_check.first_at, U64(0));
}

#[test]
fn a_second_default_verdict_2_to_5_minutes_later_blocks_and_writes_off() {
    let mut a = with_loan();
    assert!(deliver_default(&mut a, H0 + 20, H0 + 21).accepted);
    // 3 minutes later, the second DEFAULT confirms it.
    assert!(deliver_default(&mut a, H0 + 320, H0 + 321).accepted);
    let made = calls();
    assert_eq!((made[0].0.as_str(), made[0].1.as_str(), made[0].3.as_yoctonear()), (POOL, "write_off", 0));
    assert_eq!((made[0].2.clone(), gas("write_off")), (json!({ "account_id": ACCOUNT }), Gas::from_tgas(15)));
    assert!(get_logs().contains(&CONFIRMED_DEFAULT.to_string()));
    assert!(a.get_state().blocked);
    // A later DEFAULT verdict doesn't write off again.
    assert!(deliver_default(&mut a, H0 + 330, H0 + 331).accepted);
    assert!(get_created_receipts().is_empty());
}

#[test]
fn a_second_default_too_soon_waits_for_a_later_one_and_one_too_late_starts_again() {
    let mut a = with_loan();
    assert!(deliver_default(&mut a, H0 + 20, H0 + 21).accepted);
    // A minute later is too soon: nothing happens, and the first check stands.
    assert!(deliver_default(&mut a, H0 + 120, H0 + 121).accepted);
    assert!(get_created_receipts().is_empty() && !a.get_state().blocked);
    assert_eq!(a.get_state().default_check.first_at, U64(time(H0 + 21)));
    // 3 minutes after the first, it is confirmed.
    assert!(deliver_default(&mut a, H0 + 320, H0 + 321).accepted);
    assert!(a.get_state().blocked);
    // 6 minutes after a first check is too late: that verdict starts a new pair instead.
    let mut a = with_loan();
    assert!(deliver_default(&mut a, H0 + 20, H0 + 21).accepted);
    assert!(deliver_default(&mut a, H0 + 620, H0 + 621).accepted);
    assert!(get_created_receipts().is_empty() && !a.get_state().blocked);
    assert_eq!(a.get_state().default_check.first_at, U64(time(H0 + 621)));
}

#[test]
fn any_other_verdict_between_two_defaults_starts_the_pair_again() {
    let mut a = with_loan();
    assert!(deliver_default(&mut a, H0 + 20, H0 + 21).accepted);
    let mut call = verdict(LOANED, H0 + 120);
    call["state"] = json!("MARGIN_CALL");
    assert!(deliver(&mut a, Intent::Check {}, &call, H0 + 121).accepted);
    assert!(deliver_default(&mut a, H0 + 320, H0 + 321).accepted);
    assert!(get_created_receipts().is_empty() && !a.get_state().blocked);
}

#[test]
fn a_default_is_never_confirmed_at_once() {
    // Unlike DELEVERAGE, an 80% Hyperliquid margin ratio doesn't confirm it.
    let mut a = with_loan();
    let mut v = default_verdict(LOANED, H0 + 20);
    v["venues"]["hl_margin_ratio_bp"] = json!(9_000);
    assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 21).accepted);
    assert!(!a.get_state().blocked);
    assert!(calls().iter().all(|c| c.1 != "write_off"));
}

/// An account blocked after a confirmed DEFAULT, with a fresh verdict answering `intent`.
fn blocked(intent: Intent) -> Account {
    let mut a = with_loan();
    give_key(&mut a, KEY);
    assert!(deliver_default(&mut a, H0 + 20, H0 + 21).accepted);
    assert!(deliver_default(&mut a, H0 + 320, H0 + 321).accepted);
    assert!(a.get_state().blocked);
    assert!(deliver(&mut a, intent, &verdict(LOANED, H0 + 322), H0 + 323).accepted);
    a
}

#[test]
#[should_panic(expected = "this account is blocked after a default")]
fn a_blocked_account_borrows_nothing() {
    let mut a = blocked(borrow_intent(5));
    at(OWNER, 1, H0 + 324);
    a.borrow(U128(5)).detach();
}

#[test]
#[should_panic(expected = "this account is blocked after a default")]
fn a_blocked_account_withdraws_nothing() {
    let mut a = blocked(withdraw_intent(NBTC, 5));
    at(OWNER, 1, H0 + 324);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
}

#[test]
#[should_panic(expected = "this account is blocked after a default")]
fn a_blocked_account_sends_nothing_from_hyperliquid() {
    let mut a = blocked(Intent::Check {});
    a.loan = Loan::default();
    at(OWNER, 1, H0 + 324);
    a.hl_withdraw(U128(5), FLOAT.into(), None, None, None).detach();
}

#[test]
fn a_blocked_account_still_repays() {
    let mut a = blocked(Intent::Check {});
    at(OWNER, 1, H0 + 324);
    a.repay(U128(5)).detach();
    assert_eq!(calls()[0].1, "ft_transfer_call");
}

#[test]
fn after_the_write_off_a_repayment_still_runs_and_books_what_the_pool_takes() {
    let mut a = blocked(Intent::Check {});
    at(OWNER, 1, H0 + 324);
    a.repay(U128(400_000_000)).detach();
    // The write-off left the pool no debt, so it sends everything back: nothing is booked, and nothing breaks.
    ctx(ACCOUNT, 0, H0 + 326, time(H0 + 326), vec![PromiseResult::Successful(b"\"0\"".to_vec())]);
    assert_eq!(a.on_repaid(U128(400_000_000), a.loan_seq), U128(0));
    assert_eq!(a.get_state().loan, Loan { principal: U128(1_000_000_000), open: true });
    // Had the pool still been owed, the repayment would count as usual.
    ctx(ACCOUNT, 0, H0 + 327, time(H0 + 327), vec![PromiseResult::Successful(b"\"400000000\"".to_vec())]);
    assert_eq!(a.on_repaid(U128(400_000_000), a.loan_seq), U128(400_000_000));
    assert_eq!(a.get_state().loan.principal, U128(600_000_000));
}

// Lifting the block after review.

/// The pool's `get_borrower` answer, in its shape (`contracts/pool/src/types.rs`, `BorrowerView`).
fn borrower_answer(blocked: bool, debt: u128) -> PromiseResult {
    let view = json!({
        "created_at": "1", "first_week_until": "2", "debt": debt.to_string(), "tier": "STANDARD",
        "history_tier": "STANDARD", "last_upgrade_at": null, "kyb_entity": null, "tier_override": null,
        "blocked": blocked, "hl_address": null, "steps_24h": "0", "shares_bp": {}, "hold": {}, "hl_eq": "0",
    });
    PromiseResult::Successful(near_sdk::serde_json::to_vec(&view).unwrap())
}

#[test]
fn lift_block_asks_the_pool_and_lifts_the_block_once_the_pool_has_and_nothing_is_owed() {
    let mut a = blocked(Intent::Check {});
    // Anyone may ask: the pool's answer decides.
    at("keeper.testnet", 0, H0 + 324);
    a.lift_block().detach();
    let made = calls();
    assert_eq!((made[0].0.as_str(), made[0].1.as_str(), made[0].3.as_yoctonear()), (POOL, "get_borrower", 0));
    assert_eq!((made[0].2.clone(), gas("get_borrower")), (json!({ "account_id": ACCOUNT }), Gas::from_tgas(10)));
    assert_eq!(
        (made[1].0.as_str(), made[1].1.as_str(), gas("on_unblock")),
        (ACCOUNT, "on_unblock", Gas::from_tgas(10))
    );
    // The operator has lifted the pool's block, and the write-off left no debt.
    ctx(ACCOUNT, 0, H0 + 326, time(H0 + 326), vec![borrower_answer(false, 0)]);
    assert!(a.on_unblock());
    assert_eq!(get_logs(), vec!["block lifted: the pool has lifted its own, and the account owes it nothing"]);
    let s = a.get_state();
    assert!(!s.blocked);
    assert_eq!((s.loan, s.default_check.first_at), (Loan::default(), U64(0)));
    // The pool's debt is the authority: with none, a withdrawal needs no verdict again.
    at(OWNER, 1, H0 + 327);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
    assert_eq!(calls()[1].1, "ft_transfer");
}

#[test]
fn the_block_stays_while_the_pool_blocks_it_or_a_debt_is_left() {
    let cases = [
        (borrower_answer(true, 0), "the pool still blocks it"),
        (borrower_answer(false, 5), "it still owes the pool 5"),
        (PromiseResult::Successful(b"null".to_vec()), "the pool doesn't know this account"),
        (PromiseResult::Successful(b"\"7\"".to_vec()), "the pool's answer is not a borrower"),
        (PromiseResult::Failed, "the pool's get_borrower failed"),
    ];
    for (answer, why) in cases {
        let mut a = blocked(Intent::Check {});
        ctx(ACCOUNT, 0, H0 + 326, time(H0 + 326), vec![answer]);
        assert!(!a.on_unblock(), "{why}");
        assert_eq!(get_logs(), vec![format!("the block stays: {why}")]);
        assert!(a.get_state().blocked, "{why}");
    }
}

#[test]
#[should_panic(expected = "this account is not blocked")]
fn lift_block_needs_a_blocked_account() {
    let mut a = with_loan();
    at("keeper.testnet", 0, H0 + 20);
    a.lift_block().detach();
}

// Repaying during outages.

/// An account with a loan whose held verdict, of `state` with action NONE, arrived at block time `t`.
fn held_since(state: &str, t: u64) -> Account {
    let mut a = with_loan();
    let mut v = verdict(LOANED, H0 + 20);
    v["state"] = json!(state);
    v["eq"] = json!(15_000_000_000i64);
    assert!(deliver_at(&mut a, Intent::Check {}, &v, H0 + 21, t).accepted);
    a
}

#[test]
fn anyone_may_repay_once_a_margin_call_verdict_is_over_30_minutes_old() {
    for state in ["MARGIN_CALL", "DELEVERAGE", "DEFAULT"] {
        let mut a = held_since(state, T0);
        ctx("keeper.testnet", 1, H0 + 22, T0 + 30 * MINUTE_NS + 1, vec![]);
        a.repay(U128(5)).detach();
        assert_eq!(calls()[0].1, "ft_transfer_call", "{state}");
    }
}

#[test]
#[should_panic(expected = "only the owner can repay, unless the verdict says DELEVERAGE, or MARGIN_CALL or worse")]
fn a_margin_call_verdict_30_minutes_old_is_not_yet_an_outage() {
    let mut a = held_since("MARGIN_CALL", T0);
    ctx("keeper.testnet", 1, H0 + 22, T0 + 30 * MINUTE_NS, vec![]);
    a.repay(U128(5)).detach();
}

#[test]
#[should_panic(expected = "only the owner can repay")]
fn an_old_watch_verdict_lets_only_the_owner_repay() {
    let mut a = held_since("WATCH", T0);
    ctx("keeper.testnet", 1, H0 + 22, T0 + DAY_NS, vec![]);
    a.repay(U128(5)).detach();
}

#[test]
fn the_state_view_shows_when_the_verdict_arrived() {
    let a = held_since("WATCH", T0 + 7);
    let view = near_sdk::serde_json::to_value(a.get_state()).unwrap();
    assert_eq!(view["verdict"]["received_at"], json!((T0 + 7).to_string()));
}

// Forgetting a transfer that failed.

/// The owner forgets transfer `id` at block time `now`.
fn forget(a: &mut Account, who: &str, yocto: u128, id: &str, now: u64) {
    ctx(who, yocto, H0 + 6, now, vec![]);
    a.forget_transfer(id.into());
}

#[test]
fn the_owner_forgets_an_overdue_transfer_and_borrowing_works_again() {
    let late = move_deadline() + 1;
    let mut a = after_a_move(late);
    forget(&mut a, OWNER, 1, "move:0", late);
    assert_eq!(events("transfer_done"), vec![json!({ "id": "move:0", "how": "forgotten" })]);
    assert!(transfers(&a).is_empty());
    ctx(OWNER, 1, H0 + 7, late, vec![]);
    a.borrow(U128(1_000_000_000)).detach();
    assert_eq!(calls()[0].1, "borrow");
}

#[test]
#[should_panic(expected = "transfer move:0 isn't overdue yet: its deadline is 2023-11-14 22:53:20 UTC")]
fn a_transfer_that_is_not_overdue_yet_cannot_be_forgotten() {
    let mut a = after_a_move(move_deadline());
    forget(&mut a, OWNER, 1, "move:0", move_deadline());
}

#[test]
#[should_panic(expected = "no transfer move:9 is under way")]
fn only_a_transfer_under_way_can_be_forgotten() {
    let late = move_deadline() + 1;
    let mut a = after_a_move(late);
    forget(&mut a, OWNER, 1, "move:9", late);
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn only_the_owner_forgets_a_transfer() {
    let late = move_deadline() + 1;
    let mut a = after_a_move(late);
    forget(&mut a, "keeper.testnet", 1, "move:0", late);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn forgetting_a_transfer_needs_one_yocto() {
    let late = move_deadline() + 1;
    let mut a = after_a_move(late);
    forget(&mut a, OWNER, 0, "move:0", late);
}

#[test]
fn money_that_arrives_after_its_transfer_was_forgotten_is_kept_as_a_deposit() {
    let late = move_deadline() + 1;
    let mut a = after_a_move(late);
    forget(&mut a, OWNER, 1, "move:0", late);
    ctx(USDC, 0, H0 + 7, late + MINUTE_NS, vec![]);
    let kept = a.ft_on_transfer(id("solver.testnet"), U128(25_000_000), r#"{"pb":{"transfer":"move:0"}}"#.into());
    assert!(matches!(kept, PromiseOrValue::Value(U128(0))));
    assert!(get_logs().contains(&"no transfer move:0 is under way: kept as a deposit".to_string()));
    assert!(events("transfer_done").is_empty());
}

#[test]
fn a_plan_steps_overdue_transfer_can_be_forgotten_too() {
    let mut a = with_plan(json!([to_hl_step(100_000_000, quote_exp())]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert!(step_ready(&mut a, PID, 0, checked(), H0 + 27));
    forget(&mut a, OWNER, 1, "1020:0", move_deadline() + 1);
    assert_eq!(events("transfer_done"), vec![json!({ "id": "1020:0", "how": "forgotten" })]);
    assert!(transfers(&a).is_empty());
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 6: the permission, the new intents and verdict fields, fund, cancel_funding and the funding plan's steps
// (INTERFACES.md 25)
// ---------------------------------------------------------------------------------------------------------------

const WBTC: &str = "0x54114591963CF60EF3aA63bEfD6eC263D98145a4";
const AAVE_USDC: &str = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
/// What the funding tests ask for in all: $10,000.
const ASKED: u128 = 10_000_000_000;
/// The plan `funded` stores: `f` and its verdict's `blk`, H0 + 5.
const FID: &str = "f1005";

/// Both lenders, as INTERFACES.md 24 gives them: Rhea taking nBTC, and Aave on Base Sepolia taking WBTC.
fn lenders() -> Lenders {
    let both = json!({
        "rhea": { "contract_id": "rhea.pbf-ops.testnet", "collateral": [NBTC] },
        "aave": {
            "chain_id": 84532, "pool": "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
            "usdc": { "symbol": "USDC", "address": AAVE_USDC, "decimals": 6 },
            "collateral": [{ "symbol": "WBTC", "address": WBTC, "decimals": 8 }],
            "max_fee_per_gas": "5000000000",
        },
    });
    near_sdk::serde_json::from_value(both).unwrap()
}

/// The app's default terms, naming these lenders.
fn permission(lenders: &[&str]) -> Permission {
    let lenders = lenders.iter().map(|l| l.to_string()).collect();
    Permission { lenders, min_hf_bp: 15_000, max_rate_bp: 2_500, moves: Moves::Any }
}

fn both() -> Option<Permission> {
    Some(permission(&["aave", "rhea"]))
}

/// A new account whose config has both lenders, opened with this permission.
fn lender_account(permission: Option<Permission>) -> Account {
    at("pbf.testnet", 0, H0);
    Account::new(id(OWNER), Config { lenders: lenders(), ..config() }, permission)
}

fn fund_intent(amount: u128) -> Intent {
    Intent::Fund { amount: U128(amount) }
}

/// A HEALTHY verdict that answers a `fund` with these steps.
fn fund_verdict(nonce: u64, blk: u64, steps: Value) -> Value {
    let mut v = verdict(nonce, blk);
    v["fund"] = steps;
    v["allow"]["fund"] = json!(ASKED);
    v
}

fn p_borrow(amt: u128) -> Value {
    json!({ "k": "p_borrow", "amt": amt as u64 })
}

fn l_supply() -> Value {
    json!({ "k": "l_supply", "l": "rhea", "tok": NBTC, "amt": "131000000" })
}

fn l_borrow(l: &str, amt: u128) -> Value {
    json!({ "k": "l_borrow", "l": l, "amt": amt as u64 })
}

/// Rhea lends $4,000 against new collateral and our pool the other $6,000.
fn three_steps() -> Value {
    json!([l_supply(), l_borrow("rhea", 4_000_000_000), p_borrow(6_000_000_000)])
}

/// The owner calls `fund(ASKED)` at H0 + 8 on a fund verdict with these steps, read at H0 + 5 for counter 0.
fn fund_with(a: &mut Account, steps: Value) -> FundingView {
    assert!(deliver(a, fund_intent(ASKED), &fund_verdict(0, H0 + 5, steps), H0 + 6).accepted);
    at(OWNER, 1, H0 + 8);
    a.fund(U128(ASKED))
}

/// An account with both lenders permitted and a funding plan of these steps, stored at H0 + 8. Its counter is 1.
fn funded(steps: Value) -> Account {
    let mut a = lender_account(both());
    fund_with(&mut a, steps);
    a
}

/// A funded account whose only step is our pool's $6,000, holding a fresh check verdict for the bumped counter.
fn ready_to_borrow() -> Account {
    let mut a = funded(json!([p_borrow(6_000_000_000)]));
    assert!(deliver(&mut a, Intent::Check {}, &verdict(1, H0 + 10), H0 + 11).accepted);
    a
}

/// The pool's answer to a funding step's borrow of `amount` arrives at `height`.
fn step_borrowed(a: &mut Account, i: u32, amount: u128, result: PromiseResult, height: u64) -> bool {
    ctx(ACCOUNT, 0, height, time(height), vec![result]);
    a.on_step_borrowed(FID.into(), i, U128(amount))
}

fn fund_step_done(a: &Account, i: usize) -> bool {
    a.funding.as_ref().unwrap().steps[i].done
}

/// What `call` is refused with: the words of its `require!` or `env::panic_str`. In unit tests the second arrives
/// wrapped as the mock's `GuestPanic { panic_msg: "…" }`, which this unwraps.
fn refusal(call: impl FnOnce()) -> String {
    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(call));
    let payload = caught.expect_err("the call was not refused");
    let text = payload.downcast_ref::<String>().cloned();
    let text = text.or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
    match text.split_once("panic_msg: \"") {
        Some((_, words)) => words.strip_suffix("\" })").unwrap_or(words).replace("\\\"", "\""),
        None => text,
    }
}

// new, set_permission and the views.

#[test]
fn a_new_account_keeps_the_permission_it_was_opened_with() {
    let a = lender_account(both());
    let s = near_sdk::serde_json::to_value(a.get_state()).unwrap();
    let terms = json!({ "lenders": ["aave", "rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any" });
    assert_eq!((s["permission"].clone(), s["funding"].clone(), s["counter"].clone()), (terms, Value::Null, json!(0)));
    assert_eq!(near_sdk::serde_json::to_value(a.get_config()).unwrap()["lenders"]["aave"]["chain_id"], 84532);
}

#[test]
fn an_account_opened_without_a_permission_shows_null_for_it_and_for_the_funding_plan() {
    for a in [account(), lender_account(None)] {
        let s = near_sdk::serde_json::to_value(a.get_state()).unwrap();
        let fields = s.as_object().unwrap();
        assert_eq!((fields.get("permission"), fields.get("funding")), (Some(&Value::Null), Some(&Value::Null)));
    }
}

#[test]
#[should_panic(expected = "the permission names aave, which this account has no settings for")]
fn a_new_account_refuses_a_permission_its_config_cannot_back() {
    at("pbf.testnet", 0, H0);
    Account::new(id(OWNER), config(), both());
}

#[test]
#[should_panic(expected = "the permission's max_rate_bp must be 1 to 10000")]
fn a_new_account_refuses_a_permission_with_terms_out_of_range() {
    at("pbf.testnet", 0, H0);
    Account::new(id(OWNER), config(), Some(Permission { max_rate_bp: 0, ..permission(&[]) }));
}

#[test]
fn the_owner_replaces_the_permission_which_logs_it_and_leaves_the_counter() {
    let mut a = lender_account(both());
    at(OWNER, 1, H0 + 1);
    let only_rhea = Permission { min_hf_bp: 20_000, moves: Moves::Off, ..permission(&["rhea"]) };
    a.set_permission(Some(only_rhea.clone()));
    let terms = json!({ "lenders": ["rhea"], "min_hf_bp": 20000, "max_rate_bp": 2500, "moves": "off" });
    assert_eq!(events("permission_set"), vec![json!({ "permission": terms })]);
    let s = a.get_state();
    assert_eq!((s.permission, s.counter, s.permission_blk), (Some(only_rhea), 0, H0 + 1));
}

#[test]
fn the_owner_cancels_the_permission_with_null_and_can_give_one_to_an_account_opened_without() {
    let mut a = lender_account(both());
    at(OWNER, 1, H0 + 1);
    a.set_permission(None);
    assert_eq!(events("permission_set"), vec![json!({ "permission": null })]);
    assert_eq!((a.get_state().permission, a.get_state().counter), (None, 0));
    at(OWNER, 1, H0 + 2);
    a.set_permission(both());
    assert_eq!((a.get_state().permission, a.get_state().counter), (both(), 0));
}

#[test]
fn a_check_made_under_the_old_permission_still_backs_a_loan_from_our_pool() {
    // The permission is about lenders. Changing it leaves the counter alone (research/audit.md, A8), so the held
    // check still backs our pool's own loan. What it no longer backs is a plan at a lender: `fund` and the lender
    // steps refuse it (`fund_refuses_a_check_read_at_or_before_the_block_the_permission_last_changed` and the tests
    // after it).
    let mut a = lender_account(both());
    assert!(deliver(&mut a, borrow_intent(5), &verdict(0, H0 + 1), H0 + 2).accepted);
    at(OWNER, 1, H0 + 3);
    a.set_permission(None);
    at(OWNER, 1, H0 + 4);
    a.borrow(U128(5)).detach();
    assert_eq!(calls()[0].1, "borrow");
}

#[test]
fn set_permission_is_the_owners_with_1_yocto_and_refuses_a_permission_that_does_not_fit() {
    let mut a = lender_account(both());
    at("stranger.testnet", 1, H0 + 1);
    assert_eq!(refusal(|| a.set_permission(None)), "only the owner can do this");
    at(OWNER, 0, H0 + 1);
    assert!(refusal(|| a.set_permission(None)).contains("1 yoctoNEAR"));
    let cases: [(Permission, &str); 4] = [
        (permission(&["rhea", "rhea"]), "the permission names rhea twice"),
        (permission(&["compound"]), r#"the permission names "compound": the lenders are "rhea" and "aave""#),
        (
            Permission { min_hf_bp: 11_999, ..permission(&["rhea"]) },
            "the permission's min_hf_bp must be 12000 to 50000",
        ),
        (Permission { max_rate_bp: 10_001, ..permission(&[]) }, "the permission's max_rate_bp must be 1 to 10000"),
    ];
    for (bad, words) in cases {
        at(OWNER, 1, H0 + 1);
        let refused = refusal(|| a.set_permission(Some(bad)));
        assert!(refused.starts_with(words), "{refused:?} doesn't start with {words:?}");
    }
    // An account with no lenders in its config takes a permission that names none, and refuses one that names any.
    let mut plain = account();
    at(OWNER, 1, H0 + 1);
    plain.set_permission(Some(permission(&[])));
    at(OWNER, 1, H0 + 2);
    let refused = refusal(|| plain.set_permission(Some(permission(&["rhea"]))));
    assert_eq!(refused, "the permission names rhea, which this account has no settings for");
    // Nothing a refusal touched changed.
    assert_eq!((a.get_state().permission, a.get_state().counter), (both(), 0));
}

// The new intents.

#[test]
fn a_check_passes_the_three_new_intents_to_the_engine_in_the_interfaces_json() {
    let mut a = lender_account(None);
    let deposit = NearToken::from_millinear(10).as_yoctonear();
    let cases = [
        (fund_intent(94_500_000_000), json!({ "fund": { "amount": "94500000000" } })),
        (
            Intent::LenderWithdraw { lender: "rhea".into(), token: NBTC.into(), amount: U128(131_000_000) },
            json!({ "lender_withdraw": { "lender": "rhea", "token": NBTC, "amount": "131000000" } }),
        ),
        (
            Intent::LenderWithdraw { lender: "aave".into(), token: WBTC.to_lowercase(), amount: U128(7) },
            json!({ "lender_withdraw": { "lender": "aave", "token": WBTC.to_lowercase(), "amount": "7" } }),
        ),
        (
            Intent::EvmWithdraw { token: AAVE_USDC.into(), amount: U128(5_000_000) },
            json!({ "evm_withdraw": { "token": AAVE_USDC, "amount": "5000000" } }),
        ),
        (
            Intent::EvmWithdraw { token: WBTC.into(), amount: U128(9) },
            json!({ "evm_withdraw": { "token": WBTC, "amount": "9" } }),
        ),
    ];
    for (intent, expected) in cases {
        // The JSON reads back as the same intent.
        assert_eq!(near_sdk::serde_json::from_value::<Intent>(expected.clone()).unwrap(), intent);
        at("keeper.testnet", deposit, H0);
        a.request_check(intent).detach();
        let calls = calls();
        let input: Value = near_sdk::serde_json::from_str(calls[0].2["input_data"].as_str().unwrap()).unwrap();
        assert_eq!((input["mode"].as_str(), &input["intent"]), (Some("check"), &expected));
        assert_eq!((calls[1].1.as_str(), &calls[1].2["intent"]), ("on_verdict", &expected));
    }
}

#[test]
fn a_new_intent_that_does_not_fit_the_accounts_settings_is_refused() {
    let lender_withdraw = |lender: &str, token: &str, amount: u128| Intent::LenderWithdraw {
        lender: lender.into(),
        token: token.into(),
        amount: U128(amount),
    };
    let evm_withdraw = |token: &str, amount: u128| Intent::EvmWithdraw { token: token.into(), amount: U128(amount) };
    let cases = [
        (fund_intent(0), "a fund intent needs a positive amount"),
        (lender_withdraw("rhea", NBTC, 0), "a lender_withdraw intent needs a positive amount"),
        (lender_withdraw("compound", NBTC, 5), r#"a lender_withdraw intent names "aave" or "rhea""#),
        (lender_withdraw("rhea", USDC, 5), "musdc.testnet is not one of rhea's collateral tokens"),
        (lender_withdraw("rhea", WBTC, 5), "is not one of rhea's collateral tokens"),
        (lender_withdraw("aave", AAVE_USDC, 5), "is not one of aave's collateral tokens"),
        (evm_withdraw(WBTC, 0), "an evm_withdraw intent needs a positive amount"),
        (evm_withdraw("0x0000000000000000000000000000000000000001", 5), "not a token of this account's Aave settings"),
        (evm_withdraw(NBTC, 5), "not a token of this account's Aave settings"),
    ];
    let mut a = lender_account(both());
    for (intent, words) in cases {
        at(OWNER, NearToken::from_millinear(10).as_yoctonear(), H0);
        let refused = refusal(|| a.request_check(intent.clone()).detach());
        assert!(refused.contains(words), "{intent:?} was refused with {refused:?}, not {words:?}");
    }
    // With no lenders in the config, only `fund` can be asked: the pool alone then funds it.
    let mut plain = account();
    for (intent, words) in [
        (lender_withdraw("rhea", NBTC, 5), "this account has no settings for rhea"),
        (lender_withdraw("aave", WBTC, 5), "this account has no settings for aave"),
        (evm_withdraw(WBTC, 5), "this account has no settings for aave"),
    ] {
        at(OWNER, NearToken::from_millinear(10).as_yoctonear(), H0);
        assert_eq!(refusal(|| plain.request_check(intent).detach()), words);
    }
    at(OWNER, NearToken::from_millinear(10).as_yoctonear(), H0);
    plain.request_check(fund_intent(5)).detach();
    assert_eq!(calls()[0].1, "request_execution");
}

// The verdict's new fields.

fn ext_line(l: &str) -> Value {
    json!({
        "l": l, "c": 100_000_000_000u64, "d": 50_667_000_000u64, "hf_bp": 15_000, "r_bp": 1_591, "s_bp": 1_032,
        "room": 4_000_000_000u64, "liq_bp": 7_600,
    })
}

#[test]
fn a_verdict_with_the_lender_fields_is_kept_and_the_account_reads_them() {
    let mut a = lender_account(both());
    let mut v = fund_verdict(0, H0 + 5, three_steps());
    v["ext"] = json!([ext_line("aave"), ext_line("rhea")]);
    v["evm"] = json!({ "nonce": 7 });
    assert!(deliver(&mut a, fund_intent(ASKED), &v, H0 + 6).accepted);
    let held = a.verdict.clone().unwrap();
    assert_eq!(held.intent, fund_intent(ASKED));
    let read = &held.verdict;
    assert_eq!((read.allow.fund, read.allow.borrow), (ASKED, 10_000_000_000));
    assert_eq!(read.ext.iter().map(|e| e.l.as_str()).collect::<Vec<_>>(), vec!["aave", "rhea"]);
    let rhea = &read.ext[1];
    assert_eq!((rhea.c, rhea.d, rhea.hf_bp, rhea.room), (100_000_000_000, 50_667_000_000, 15_000, 4_000_000_000));
    assert_eq!((rhea.r_bp, rhea.s_bp, rhea.liq_bp), (1_591, 1_032, 7_600));
    assert_eq!(read.evm, Some(EvmSeen { nonce: 7 }));
    // The steps stay in the kept JSON, where `fund` and the view read them.
    assert_eq!(fund_steps(&held.json), three_steps().as_array().unwrap().clone());
    assert_eq!(a.get_state().verdict.unwrap().verdict, v);
}

#[test]
fn a_verdict_without_the_lender_fields_is_kept_exactly_as_before() {
    let mut a = account();
    assert!(deliver(&mut a, Intent::Check {}, &verdict(0, H0 + 3), H0 + 5).accepted);
    let held = a.verdict.clone().unwrap();
    let read = &held.verdict;
    assert!(read.ext.is_empty() && read.fund.is_empty() && read.evm.is_none());
    assert_eq!((read.allow.fund, read.allow.withdraw, read.allow.borrow), (0, 5_000_000_000, 10_000_000_000));
    assert!(fund_steps(&held.json).is_empty());
    assert_eq!(a.get_state().verdict.unwrap().verdict, verdict(0, H0 + 3));
    // A null `evm` and an empty `ext` read as none, too.
    let mut v = verdict(0, H0 + 4);
    v["evm"] = Value::Null;
    v["ext"] = json!([]);
    assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 6).accepted);
}

#[test]
fn a_verdict_with_more_than_6_funding_steps_is_refused() {
    refused_with(|v| v["fund"] = Value::Array(vec![p_borrow(1); 7]), "fund has 7 steps, above the 6 allowed");
    let mut a = account();
    let six = fund_verdict(0, H0, Value::Array(vec![p_borrow(1); 6]));
    assert!(deliver(&mut a, fund_intent(6), &six, H0 + 1).accepted);
}

#[test]
fn a_verdict_with_more_than_2_lender_lines_or_a_lender_it_does_not_know_is_refused() {
    let lines = |ls: &[&str]| Value::Array(ls.iter().map(|l| ext_line(l)).collect());
    refused_with(|v| v["ext"] = lines(&["aave", "rhea", "aave"]), "ext has 3 lenders, above the 2 allowed");
    refused_with(|v| v["ext"] = lines(&["compound"]), r#"ext names "compound": the lenders are "aave" and "rhea""#);
    refused_with(|v| v["ext"] = lines(&["rhea", "rhea"]), "ext names rhea twice");
}

#[test]
fn a_verdict_whose_lender_fields_are_malformed_is_refused() {
    refused_with(|v| v["ext"] = json!([{ "l": "rhea", "d": 5, "r_bp": 1, "s_bp": 1 }]), "the verdict is malformed");
    refused_with(
        |v| v["ext"] = json!([{ "l": "rhea", "d": 5.5, "r_bp": 1, "s_bp": 1, "room": 0 }]),
        "the verdict is malformed",
    );
    refused_with(|v| v["ext"] = json!({ "rhea": {} }), "the verdict is malformed");
    refused_with(|v| v["fund"] = json!("p_borrow"), "the verdict is malformed");
    refused_with(|v| v["allow"]["fund"] = json!(-1), "the verdict is malformed");
    refused_with(|v| v["evm"] = json!({ "nonce": "7" }), "the verdict is malformed");
    // An `ext` line needs only the fields the account acts on: the lender, its debt, its two rates and the room.
    let mut a = account();
    let mut v = verdict(0, H0);
    v["ext"] = json!([{ "l": "rhea", "d": 5, "r_bp": 1, "s_bp": 1, "room": 0 }]);
    assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 1).accepted);
}

// fund.

#[test]
fn fund_stores_the_verdicts_steps_as_the_funding_plan_and_bumps_the_counter() {
    let mut a = lender_account(both());
    let view = fund_with(&mut a, three_steps());
    let stored = json!({ "pid": FID, "amount": "10000000000", "steps": ["l_supply", "l_borrow", "p_borrow"] });
    assert_eq!(events("funding_stored"), vec![stored]);
    let expected = json!({
        "pid": FID, "amount": "10000000000",
        "stored_at": time(H0 + 8).to_string(), "expires_at": (time(H0 + 8) + 30 * MINUTE_NS).to_string(),
        "steps": [
            { "k": "l_supply", "l": "rhea", "tok": NBTC, "amt": "131000000", "done": false },
            { "k": "l_borrow", "l": "rhea", "amt": 4_000_000_000u64, "done": false },
            { "k": "p_borrow", "amt": 6_000_000_000u64, "done": false },
        ],
    });
    assert_eq!(near_sdk::serde_json::to_value(&view).unwrap(), expected);
    let s = a.get_state();
    assert_eq!((s.funding, s.counter), (Some(view), 1));
    // It moved no money: nothing was called, and nothing is under way.
    assert!(calls().is_empty() && s.pending.is_empty() && !s.loan.open);
}

#[test]
fn an_account_with_no_lenders_funds_from_the_pool_alone() {
    let mut a = account();
    let view = fund_with(&mut a, json!([p_borrow(ASKED)]));
    assert_eq!((view.pid.as_str(), view.steps.len()), (FID, 1));
}

#[test]
fn the_steps_may_borrow_less_than_was_asked_for_but_never_more() {
    let mut a = lender_account(both());
    fund_with(&mut a, json!([l_borrow("aave", 3_000_000_000), p_borrow(6_999_999_999)]));
    let mut a = lender_account(both());
    assert!(
        deliver(
            &mut a,
            fund_intent(ASKED),
            &fund_verdict(0, H0 + 5, json!([l_borrow("aave", 4_000_000_000), p_borrow(6_000_000_001)])),
            H0 + 6
        )
        .accepted
    );
    at(OWNER, 1, H0 + 8);
    let refused = refusal(|| drop(a.fund(U128(ASKED))));
    assert_eq!(refused, "the funding steps borrow 10000000001 in all, above the 10000000000 asked for");
    assert!(a.get_state().funding.is_none() && a.get_state().counter == 0);
}

/// `fund(amount)` by `who` with `yocto` at `height`, on `a` as it is: what it is refused with.
fn fund_refused(a: &mut Account, who: &str, yocto: u128, height: u64, amount: u128) -> String {
    at(who, yocto, height);
    refusal(|| drop(a.fund(U128(amount))))
}

/// A lender account that got this verdict for `intent` at H0 + 6, and what `fund(ASKED)` at H0 + 8 is refused with.
fn fund_refused_on(permission: Option<Permission>, intent: Intent, v: Value) -> String {
    let mut a = lender_account(permission);
    assert!(deliver(&mut a, intent, &v, H0 + 6).accepted);
    fund_refused(&mut a, OWNER, 1, H0 + 8, ASKED)
}

#[test]
fn fund_is_the_owners_with_1_yocto_and_a_positive_amount() {
    let mut a = lender_account(both());
    assert!(deliver(&mut a, fund_intent(ASKED), &fund_verdict(0, H0 + 5, three_steps()), H0 + 6).accepted);
    assert_eq!(fund_refused(&mut a, "keeper.testnet", 1, H0 + 8, ASKED), "only the owner can do this");
    assert!(fund_refused(&mut a, OWNER, 0, H0 + 8, ASKED).contains("1 yoctoNEAR"));
    assert_eq!(fund_refused(&mut a, OWNER, 1, H0 + 8, 0), "amount must be positive");
}

#[test]
fn fund_needs_a_fresh_unused_healthy_verdict_that_answers_fund_for_this_amount() {
    let mut a = lender_account(both());
    assert_eq!(fund_refused(&mut a, OWNER, 1, H0 + 8, ASKED), "no verdict: ask for a check first");
    let good = || fund_verdict(0, H0 + 5, three_steps());
    assert!(deliver(&mut a, fund_intent(ASKED), &good(), H0 + 6).accepted);
    // 120 blocks after the block it read it still works; one more and it is too old.
    let old = fund_refused(&mut a, OWNER, 1, H0 + 5 + FRESH_BLOCKS + 1, ASKED);
    assert_eq!(old, "the verdict is 121 blocks old, above the 120-block limit");
    assert_eq!(fund_refused(&mut a, OWNER, 1, H0 + 8, ASKED - 1), "the verdict doesn't answer fund for this amount");
    for other in [borrow_intent(ASKED), Intent::Check {}, fund_intent(ASKED + 1)] {
        let refused = fund_refused_on(both(), other, good());
        assert_eq!(refused, "the verdict doesn't answer fund for this amount");
    }
    let mut watch = good();
    watch["state"] = json!("WATCH");
    assert_eq!(fund_refused_on(both(), fund_intent(ASKED), watch), "the verdict's state isn't HEALTHY");
    // A verdict the counter has moved past backs nothing.
    at(OWNER, 1, H0 + 7);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
    assert_eq!(fund_refused(&mut a, OWNER, 1, H0 + 8, ASKED), "the verdict was already used: ask for a new check");
    // At exactly 120 blocks, a good verdict is still good.
    let mut a = lender_account(both());
    assert!(deliver(&mut a, fund_intent(ASKED), &good(), H0 + 6).accepted);
    at(OWNER, 1, H0 + 5 + FRESH_BLOCKS);
    assert_eq!(a.fund(U128(ASKED)).pid, FID);
}

#[test]
fn fund_needs_steps_that_are_funding_steps_with_valid_fields() {
    let refused = |steps: Value| fund_refused_on(both(), fund_intent(ASKED), fund_verdict(0, H0 + 5, steps));
    assert_eq!(
        fund_refused_on(both(), fund_intent(ASKED), verdict(0, H0 + 5)),
        "the verdict has no funding steps: the engine found nothing to lend"
    );
    assert_eq!(refused(json!([])), "the verdict has no funding steps: the engine found nothing to lend");
    assert_eq!(refused(json!([p_borrow(5), { "k": "p_borrow" }])), "step 1 can't run: its amt is missing or not valid");
    assert_eq!(
        refused(json!([{ "k": "l_borrow", "l": "compound", "amt": 5 }])),
        "step 0 can't run: its l is missing or not valid"
    );
    assert_eq!(refused(json!(["p_borrow"])), "step 0 has no kind, so the account can't run it");
    assert_eq!(refused(json!([{ "k": "repay", "amt": 5 }])), "step 0 is a repay step, which is not a funding step");
    // A top-up's steps belong to the unwind plan, not here.
    assert_eq!(
        refused(json!([p_borrow(5), { "k": "l_repay", "l": "rhea", "amt": 5 }])),
        "step 1 is a l_repay step, which only a top-up plan holds"
    );
    assert_eq!(
        refused(json!([{ "k": "l_add", "l": "rhea", "tok": NBTC, "amt": 5 }])),
        "step 0 is a l_add step, which only a top-up plan holds"
    );
    // Collateral goes to a lender only as one of its listed tokens.
    assert_eq!(
        refused(json!([{ "k": "l_supply", "l": "rhea", "tok": USDC, "amt": 5 }])),
        "step 0 can't run: musdc.testnet is not one of rhea's collateral tokens in this account's settings"
    );
}

#[test]
fn fund_uses_only_a_lender_the_config_has_and_the_permission_names() {
    let steps = || fund_verdict(0, H0 + 5, json!([l_borrow("aave", 4_000_000_000), p_borrow(6_000_000_000)]));
    let not_named = "step 0 names aave, which the owner's permission doesn't name";
    assert_eq!(fund_refused_on(Some(permission(&["rhea"])), fund_intent(ASKED), steps()), not_named);
    assert_eq!(fund_refused_on(Some(permission(&[])), fund_intent(ASKED), steps()), not_named);
    assert_eq!(fund_refused_on(None, fund_intent(ASKED), steps()), not_named);
    // Named, it goes through.
    let mut a = lender_account(Some(permission(&["aave"])));
    assert!(deliver(&mut a, fund_intent(ASKED), &steps(), H0 + 6).accepted);
    at(OWNER, 1, H0 + 8);
    assert_eq!(a.fund(U128(ASKED)).steps.len(), 2);
    // An account whose config has no such lender refuses it whatever else holds.
    let mut plain = account();
    assert!(deliver(&mut plain, fund_intent(ASKED), &steps(), H0 + 6).accepted);
    let refused = fund_refused(&mut plain, OWNER, 1, H0 + 8, ASKED);
    assert_eq!(refused, "step 0 names aave, which this account has no settings for");
}

#[test]
#[should_panic(expected = "this account is blocked after a default")]
fn a_blocked_account_stores_no_funding_plan() {
    let mut a = blocked(fund_intent(ASKED));
    at(OWNER, 1, H0 + 324);
    a.fund(U128(ASKED));
}

#[test]
#[should_panic(expected = "no funding while transfer move:0 is overdue: its deadline was 2023-11-14 22:53:20 UTC")]
fn no_funding_plan_is_stored_while_a_transfer_is_overdue() {
    let mut a = account();
    at(OWNER, 1, H0);
    a.withdraw(id(USDC), U128(25_000_000), id(DEP), to_hl_move()).detach();
    let v = fund_verdict(1, H0 + 4, json!([p_borrow(ASKED)]));
    assert!(deliver_at(&mut a, fund_intent(ASKED), &v, H0 + 5, move_deadline() + 1).accepted);
    ctx(OWNER, 1, H0 + 6, move_deadline() + 1, vec![]);
    a.fund(U128(ASKED));
}

/// A second `fund(ASKED)` at `height` and block time `now`, on a fund verdict read at `blk` for the counter as it is.
fn fund_again(a: &mut Account, blk: u64, height: u64, now: u64) -> Result<FundingView, String> {
    let v = fund_verdict(a.get_state().counter, blk, json!([p_borrow(ASKED)]));
    assert!(deliver_at(a, fund_intent(ASKED), &v, height, now).accepted);
    ctx(OWNER, 1, height + 1, now, vec![]);
    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| a.fund(U128(ASKED))));
    caught.map_err(|_| get_logs().join(" "))
}

#[test]
fn a_funding_plan_with_steps_still_to_run_holds_back_the_next_until_it_is_done_expired_or_cancelled() {
    let mut a = funded(three_steps());
    let expires = time(H0 + 8) + 30 * MINUTE_NS;
    // Up to its last nanosecond the first plan stands.
    at(OWNER, 1, H0 + 20);
    let v = fund_verdict(1, H0 + 18, json!([p_borrow(ASKED)]));
    assert!(deliver_at(&mut a, fund_intent(ASKED), &v, H0 + 19, expires).accepted);
    ctx(OWNER, 1, H0 + 20, expires, vec![]);
    let refused = refusal(|| drop(a.fund(U128(ASKED))));
    assert_eq!(refused, "funding plan f1005 still has steps to run: wait for them, or drop it with cancel_funding");
    // Once it has expired, a new one replaces it.
    ctx(OWNER, 1, H0 + 20, expires + 1, vec![]);
    assert_eq!(a.fund(U128(ASKED)).pid, "f1018");
    assert_eq!(a.get_state().counter, 2);
    // A plan whose steps have all started gives way too.
    a.funding.as_mut().unwrap().steps[0].done = true;
    assert_eq!(fund_again(&mut a, H0 + 30, H0 + 31, expires + 2).unwrap().pid, "f1030");
    // And so does one the owner cancelled.
    ctx(OWNER, 1, H0 + 40, expires + 3, vec![]);
    a.cancel_funding();
    assert_eq!(fund_again(&mut a, H0 + 41, H0 + 42, expires + 4).unwrap().pid, "f1041");
}

#[test]
fn two_funding_plans_never_share_an_id_even_after_a_cancel() {
    let mut a = funded(json!([p_borrow(ASKED)]));
    at(OWNER, 1, H0 + 9);
    a.cancel_funding();
    // A second check that read the same block as the first plan's verdict can't make a second `f1005`.
    let v = fund_verdict(1, H0 + 5, json!([p_borrow(ASKED)]));
    assert!(deliver(&mut a, fund_intent(ASKED), &v, H0 + 10).accepted);
    let refused = fund_refused(&mut a, OWNER, 1, H0 + 11, ASKED);
    assert_eq!(refused, "a funding plan was already stored from block 1005: ask for a new check");
    // One block later it can.
    let v = fund_verdict(1, H0 + 6, json!([p_borrow(ASKED)]));
    assert!(deliver(&mut a, fund_intent(ASKED), &v, H0 + 12).accepted);
    at(OWNER, 1, H0 + 13);
    assert_eq!(a.fund(U128(ASKED)).pid, "f1006");
}

#[test]
fn a_healthy_verdict_clears_the_unwind_plan_and_never_the_funding_plan() {
    let mut a = funded(three_steps());
    let top_up = rebalance(1, H0 + 20, json!([repay_step()]));
    assert!(deliver(&mut a, Intent::Check {}, &top_up, H0 + 21).accepted);
    assert!(a.get_state().plan.is_some() && a.get_state().funding.is_some());
    assert!(deliver(&mut a, Intent::Check {}, &verdict(1, H0 + 30), H0 + 31).accepted);
    let s = a.get_state();
    assert!(s.plan.is_none(), "a HEALTHY verdict keeps the unwind plan");
    assert_eq!(s.funding.unwrap().pid, FID);
}

// cancel_funding.

#[test]
fn the_owner_cancels_the_funding_plan_which_logs_it_and_leaves_the_counter() {
    let mut a = funded(three_steps());
    at(OWNER, 1, H0 + 9);
    a.cancel_funding();
    assert_eq!(events("funding_cancelled"), vec![json!({ "pid": FID })]);
    assert_eq!((a.get_state().funding, a.get_state().counter), (None, 1));
    // With no plan left, its steps are gone and there is nothing more to cancel.
    at(OWNER, 1, H0 + 10);
    assert_eq!(refusal(|| a.cancel_funding()), "no funding plan is stored");
    at("keeper.testnet", 0, H0 + 10);
    assert_eq!(refusal(|| a.execute_step(FID.into(), 0).detach()), "no funding plan is stored");
}

#[test]
fn cancel_funding_is_the_owners_with_1_yocto() {
    let mut a = funded(three_steps());
    at("keeper.testnet", 1, H0 + 9);
    assert_eq!(refusal(|| a.cancel_funding()), "only the owner can do this");
    at(OWNER, 0, H0 + 9);
    assert!(refusal(|| a.cancel_funding()).contains("1 yoctoNEAR"));
    assert!(a.get_state().funding.is_some());
}

#[test]
fn a_pool_step_that_has_started_still_ends_after_its_plan_is_cancelled() {
    let mut a = ready_to_borrow();
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 12);
    at(OWNER, 1, H0 + 13);
    a.cancel_funding();
    book_loan(&mut a, 6_000_000_000, H0 + 13);
    assert!(step_borrowed(&mut a, 0, 6_000_000_000, PromiseResult::Successful(b"\"6000000000\"".to_vec()), H0 + 14));
    let s = a.get_state();
    assert_eq!((s.loan.principal, s.pending.len(), s.counter, s.funding), (U128(6_000_000_000), 0, 3, None));
}

// execute_step on the funding plan: what every step needs.

/// What step `i` of funding plan `pid`, run by a stranger at `height` and block time `now`, is refused with.
fn step_refused(a: &mut Account, pid: &str, i: u32, height: u64, now: u64) -> String {
    ctx("anyone.testnet", 0, height, now, vec![]);
    let refused = refusal(|| a.execute_step(pid.into(), i).detach());
    assert!(calls().is_empty(), "a refused step still called something");
    refused
}

#[test]
fn a_funding_step_needs_the_stored_funding_plan_and_a_step_that_exists_and_has_not_run() {
    let mut a = lender_account(both());
    assert_eq!(step_refused(&mut a, FID, 0, H0 + 9, time(H0 + 9)), "no funding plan is stored");
    let mut a = funded(three_steps());
    let now = time(H0 + 9);
    assert_eq!(step_refused(&mut a, "f999", 0, H0 + 9, now), "plan f999 is not the stored funding plan, f1005");
    assert_eq!(step_refused(&mut a, FID, 3, H0 + 9, now), "plan f1005 has no step 3");
    a.funding.as_mut().unwrap().steps[0].done = true;
    assert_eq!(step_refused(&mut a, FID, 0, H0 + 9, now), "step 0 of plan f1005 has already run");
    // The unwind plan's ids are numbers, so an `f` id never reaches it, and a number never reaches the funding plan.
    assert_eq!(step_refused(&mut a, "1005", 0, H0 + 9, now), "no plan is stored");
}

#[test]
fn funding_steps_run_strictly_in_order() {
    let mut a = funded(three_steps());
    let now = time(H0 + 9);
    assert_eq!(step_refused(&mut a, FID, 2, H0 + 9, now), "step 2 of plan f1005 must wait: step 0 hasn't run yet");
    assert_eq!(step_refused(&mut a, FID, 1, H0 + 9, now), "step 1 of plan f1005 must wait: step 0 hasn't run yet");
    a.funding.as_mut().unwrap().steps[0].done = true;
    assert_eq!(step_refused(&mut a, FID, 2, H0 + 9, now), "step 2 of plan f1005 must wait: step 1 hasn't run yet");
}

#[test]
fn a_funding_step_runs_only_inside_the_plans_30_minutes() {
    let mut a = ready_to_borrow();
    let expires = time(H0 + 8) + 30 * MINUTE_NS;
    let refused = step_refused(&mut a, FID, 0, H0 + 12, expires + 1);
    assert_eq!(refused, "plan f1005 expired at 2023-11-14 22:43:24 UTC: call fund again for a new one");
    // At its last nanosecond it still runs.
    ctx("anyone.testnet", 0, H0 + 12, expires, vec![]);
    a.execute_step(FID.into(), 0).detach();
    assert_eq!(calls()[0].1, "borrow");
}

#[test]
fn a_funding_step_never_runs_on_a_blocked_account_or_while_a_transfer_is_overdue() {
    let mut a = ready_to_borrow();
    a.blocked = true;
    assert_eq!(step_refused(&mut a, FID, 0, H0 + 12, time(H0 + 12)), "this account is blocked after a default");
    a.blocked = false;
    // A transfer whose deadline passed long ago.
    a.pending.push(Pending::Transfer(Transfer::new("move:0".into(), TransferKind::ToHl, USDC, 5, DEP, 0)));
    let refused = step_refused(&mut a, FID, 0, H0 + 12, time(H0 + 12));
    assert_eq!(refused, "no funding step while transfer move:0 is overdue: its deadline was 1970-01-01 00:30:00 UTC");
    assert!(!fund_step_done(&a, 0) && a.get_state().counter == 1);
}

// execute_step on the funding plan: the pool's step.

#[test]
fn anyone_runs_the_pool_step_which_borrows_on_a_fresh_verdict_and_bumps_the_counter_twice() {
    let mut a = ready_to_borrow();
    run_step(&mut a, "anyone.testnet", FID, 0, H0 + 12);
    let calls = calls();
    let (to, method, args, deposit) = &calls[0];
    assert_eq!((to.as_str(), method.as_str(), deposit.as_yoctonear()), (POOL, "borrow", 1));
    // The step's own $6,000, under the fresh verdict's $10,000 allowance, with that verdict's terms.
    let terms = json!({
        "tier": "STANDARD", "allow_borrow": "10000000000",
        "shares_bp": { "nBTC": 7_407 }, "hold": { "nBTC": "100000000000" }, "hl_eq": "35000000000",
    });
    assert_eq!((&args["amount"], &args["verdict"]), (&json!("6000000000"), &terms));
    assert_eq!((calls[1].0.as_str(), calls[1].1.as_str()), (ACCOUNT, "on_step_borrowed"));
    assert_eq!(calls[1].2, json!({ "pid": FID, "i": 0, "amount": "6000000000" }));
    assert_eq!(events("step_run"), vec![json!({ "pid": FID, "i": 0, "k": "p_borrow" })]);
    let s = a.get_state();
    assert_eq!((s.counter, s.pending.clone()), (2, vec![Pending::Borrow { amount: U128(6_000_000_000) }]));
    assert!(fund_step_done(&a, 0));
    // The loan arrives, and the callback ends the borrow and moves the counter on again (research/audit.md, A1).
    book_loan(&mut a, 6_000_000_000, H0 + 13);
    assert!(step_borrowed(&mut a, 0, 6_000_000_000, PromiseResult::Successful(b"\"6000000000\"".to_vec()), H0 + 14));
    let s = a.get_state();
    assert_eq!((s.counter, s.pending.len(), s.loan), (3, 0, Loan { principal: U128(6_000_000_000), open: true }));
    assert!(fund_step_done(&a, 0) && !a.funding.as_ref().unwrap().unfinished());
}

#[test]
fn the_pool_step_borrows_no_more_than_the_fresh_verdict_allows() {
    let mut a = funded(json!([p_borrow(6_000_000_000)]));
    let mut v = verdict(1, H0 + 10);
    v["allow"]["borrow"] = json!(2_500_000_000u64);
    // Any intent's verdict will do: every verdict carries the allowance.
    assert!(deliver(&mut a, withdraw_intent(NBTC, 5), &v, H0 + 11).accepted);
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 12);
    let calls = calls();
    assert_eq!(
        (&calls[0].2["amount"], &calls[0].2["verdict"]["allow_borrow"]),
        (&json!("2500000000"), &json!("2500000000"))
    );
    assert_eq!(calls[1].2["amount"], "2500000000");
    assert_eq!(a.get_state().pending, vec![Pending::Borrow { amount: U128(2_500_000_000) }]);
}

#[test]
fn the_pool_step_needs_a_fresh_healthy_verdict_with_the_current_counter() {
    // The fund verdict itself was spent by `fund`.
    let mut a = funded(json!([p_borrow(6_000_000_000)]));
    let now = time(H0 + 12);
    assert_eq!(step_refused(&mut a, FID, 0, H0 + 12, now), "the verdict was already used: ask for a new check");
    // A fresh one that allows nothing.
    let mut none = verdict(1, H0 + 10);
    none["allow"]["borrow"] = json!(0);
    assert!(deliver(&mut a, Intent::Check {}, &none, H0 + 11).accepted);
    assert_eq!(step_refused(&mut a, FID, 0, H0 + 12, now), "the verdict allows no borrowing now");
    // One that isn't HEALTHY.
    let mut watch = verdict(1, H0 + 12);
    watch["state"] = json!("WATCH");
    assert!(deliver(&mut a, Intent::Check {}, &watch, H0 + 13).accepted);
    assert_eq!(step_refused(&mut a, FID, 0, H0 + 14, time(H0 + 14)), "the verdict's state isn't HEALTHY");
    // A good one, once it is more than 120 blocks old.
    assert!(deliver(&mut a, Intent::Check {}, &verdict(1, H0 + 15), H0 + 16).accepted);
    let old = step_refused(&mut a, FID, 0, H0 + 136, time(H0 + 136));
    assert_eq!(old, "the verdict is 121 blocks old, above the 120-block limit");
    // Nothing a refusal touched changed, and the same verdict still runs the step in time.
    assert!(!fund_step_done(&a, 0) && a.get_state().counter == 1 && a.get_state().pending.is_empty());
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 135);
    assert_eq!(calls()[0].1, "borrow");
}

#[test]
fn the_pool_step_waits_for_a_borrow_under_way_and_for_an_open_send_window() {
    let mut a = ready_to_borrow();
    a.pending.push(Pending::Borrow { amount: U128(5) });
    assert_eq!(step_refused(&mut a, FID, 0, H0 + 12, time(H0 + 12)), "a borrow is already under way");
    a.pending.clear();
    a.hl.send_open_until_ms = U64(NOW_MS + 60_000);
    let refused = step_refused(&mut a, FID, 0, H0 + 12, time(H0 + 12));
    assert!(refused.starts_with("no borrow until 2023-11-14 22:14:20 UTC"), "{refused}");
    assert!(refused.ends_with("a signed Hyperliquid sendAsset can still be posted until then"), "{refused}");
}

#[test]
fn a_pool_step_the_pool_refused_may_run_again_and_still_moves_the_counter_on() {
    for answer in [PromiseResult::Failed, PromiseResult::Successful(b"\"0\"".to_vec())] {
        let mut a = ready_to_borrow();
        run_step(&mut a, "keeper.testnet", FID, 0, H0 + 12);
        assert!(!step_borrowed(&mut a, 0, 6_000_000_000, answer, H0 + 14));
        let logs = get_logs();
        assert_eq!(logs[0], "the pool refused the borrow of 6000000000");
        assert_eq!(logs[1], "step 0 of plan f1005 didn't go out: nothing was lent, and it may run again");
        let s = a.get_state();
        assert_eq!((s.counter, s.pending.len(), s.loan.open), (3, 0, false));
        assert!(!fund_step_done(&a, 0));
        // It runs again on a new verdict for the counter as it is now.
        assert!(deliver(&mut a, Intent::Check {}, &verdict(3, H0 + 15), H0 + 16).accepted);
        run_step(&mut a, "keeper.testnet", FID, 0, H0 + 17);
        assert_eq!(calls()[0].1, "borrow");
    }
}

#[test]
fn a_pool_step_that_lent_only_a_part_stays_done_so_the_plan_never_lends_more_than_its_step() {
    let mut a = ready_to_borrow();
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 12);
    book_loan(&mut a, 1_000_000_000, H0 + 13);
    assert!(!step_borrowed(&mut a, 0, 6_000_000_000, PromiseResult::Successful(b"\"1000000000\"".to_vec()), H0 + 14));
    assert!(fund_step_done(&a, 0));
    assert_eq!((a.get_state().counter, a.get_state().loan.principal), (3, U128(1_000_000_000)));
}

#[test]
fn a_refused_pool_step_of_a_plan_that_was_replaced_meanwhile_reopens_no_step() {
    let mut a = ready_to_borrow();
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 12);
    // The step has started, so the plan has no step left to run, and the owner stores a new plan.
    let v = fund_verdict(2, H0 + 13, json!([p_borrow(ASKED)]));
    assert!(deliver(&mut a, fund_intent(ASKED), &v, H0 + 14).accepted);
    at(OWNER, 1, H0 + 15);
    assert_eq!(a.fund(U128(ASKED)).pid, "f1013");
    a.funding.as_mut().unwrap().steps[0].done = true;
    assert!(!step_borrowed(&mut a, 0, 6_000_000_000, PromiseResult::Failed, H0 + 16));
    assert!(fund_step_done(&a, 0), "the old plan's refusal reopened the new plan's step");
    assert!(a.get_state().pending.is_empty());
}

#[test]
fn a_verdict_read_while_a_pool_step_was_under_way_backs_nothing_afterwards() {
    let mut a = ready_to_borrow();
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 12);
    // A check read before the pool lent carries the new counter, 2, and shows no loan.
    assert!(deliver(&mut a, withdraw_intent(USDC, 5_000_000_000), &verdict(2, H0 + 12), H0 + 13).accepted);
    book_loan(&mut a, 6_000_000_000, H0 + 13);
    assert!(step_borrowed(&mut a, 0, 6_000_000_000, PromiseResult::Successful(b"\"6000000000\"".to_vec()), H0 + 14));
    at(OWNER, 1, H0 + 15);
    let refused = refusal(|| a.withdraw(id(USDC), U128(5_000_000_000), id(OWNER), None).detach());
    assert_eq!(refused, "the verdict was already used: ask for a new check");
}

// execute_step on the funding plan: the steps the account can't run yet, and the top-up's checks. Rhea's steps have
// their own section below.

#[test]
fn the_two_moves_between_chains_answer_that_the_account_cannot_run_them_yet() {
    let exp = quote_exp();
    let not_yet = |k: &str| format!("step 0 is a {k} step: the account can't run {k} steps yet");
    let cases = [
        (
            json!({ "k": "to_evm", "tok": NBTC, "amt": "131000000", "min": "130000000", "dep": DEP, "exp": exp }),
            not_yet("to_evm"),
        ),
        (json!({ "k": "e_home", "amt": 5, "dep": WBTC, "exp": exp }), not_yet("e_home")),
    ];
    for (step, words) in cases {
        let mut a = funded(json!([step, p_borrow(5)]));
        assert!(deliver(&mut a, Intent::Check {}, &verdict(1, H0 + 10), H0 + 11).accepted);
        let refused = step_refused(&mut a, FID, 0, H0 + 12, time(H0 + 12));
        assert_eq!(refused, words);
        assert!(!fund_step_done(&a, 0) && a.get_state().counter == 1);
        // So the pool's step behind it waits.
        let waits = step_refused(&mut a, FID, 1, H0 + 12, time(H0 + 12));
        assert_eq!(waits, "step 1 of plan f1005 must wait: step 0 hasn't run yet");
    }
}

#[test]
fn a_stored_lender_step_is_refused_once_the_owner_stops_permitting_its_lender() {
    let mut a = funded(three_steps());
    at(OWNER, 1, H0 + 9);
    a.set_permission(Some(permission(&["aave"])));
    let refused = step_refused(&mut a, FID, 0, H0 + 10, time(H0 + 10));
    assert_eq!(refused, "step 0 names rhea, which the owner's permission doesn't name");
    at(OWNER, 1, H0 + 11);
    a.set_permission(None);
    let refused = step_refused(&mut a, FID, 0, H0 + 12, time(H0 + 12));
    assert_eq!(refused, "step 0 names rhea, which the owner's permission doesn't name");
    // The pool's own step needs no permission, and reads no check for a lender: it runs on the check it holds.
    let mut a = ready_to_borrow();
    at(OWNER, 1, H0 + 12);
    a.set_permission(None);
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 15);
    assert_eq!(calls()[0].1, "borrow");
}

/// A lender account with this permission and a stored REBALANCE plan of `steps` (plan 1020), and what running its
/// step 0 is refused with.
fn top_up_refused(permission: Option<Permission>, steps: Value) -> String {
    let mut a = lender_account(permission);
    assert!(deliver(&mut a, Intent::Check {}, &rebalance(0, H0 + 20, steps), H0 + 21).accepted);
    let refused = step_refused(&mut a, PID, 0, H0 + 25, time(H0 + 25));
    assert!(!step_done(&a, 0) && a.get_state().counter == 0);
    refused
}

#[test]
fn a_top_ups_lender_steps_are_read_and_checked_before_they_run() {
    let repay = json!({ "k": "l_repay", "l": "aave", "amt": 10_133_000_000u64 });
    let add = json!({ "k": "l_add", "l": "aave", "tok": WBTC, "amt": "5000000" });
    // Aave's steps are Ethereum transactions, which need the account's address there. A top-up runs whatever the
    // permission says, so the answer is the same with none.
    for permission in [both(), None] {
        let refused = top_up_refused(permission.clone(), json!([repay.clone(), repay_step()]));
        assert_eq!(refused, "no Ethereum address yet: call hl_init first");
        let refused = top_up_refused(permission, json!([add.clone()]));
        assert_eq!(refused, "no Ethereum address yet: call hl_init first");
    }
    assert_eq!(
        top_up_refused(both(), json!([{ "k": "l_repay", "l": "rhea" }])),
        "step 0 can't run: its amt is missing or not valid"
    );
    assert_eq!(
        top_up_refused(both(), json!([{ "k": "l_add", "l": "rhea", "tok": USDC, "amt": 5 }])),
        "step 0 can't run: musdc.testnet is not one of rhea's collateral tokens in this account's settings"
    );
    // The steps that make a loan belong to a funding plan, which only the owner's `fund` stores.
    for k in ["p_borrow", "l_supply", "l_borrow", "to_evm", "e_home"] {
        let refused = top_up_refused(both(), json!([{ "k": k, "l": "rhea", "tok": NBTC, "amt": 5 }]));
        assert_eq!(refused, format!("step 0 is a {k} step, which only a funding plan runs"));
    }
    // An account with no settings for the lender says so.
    let mut plain = account();
    assert!(deliver(&mut plain, Intent::Check {}, &rebalance(0, H0 + 20, json!([l_repay_step()])), H0 + 21).accepted);
    let refused = step_refused(&mut plain, PID, 0, H0 + 25, time(H0 + 25));
    assert_eq!(refused, "step 0 names rhea, which this account has no settings for");
}

#[test]
fn a_top_up_plan_with_lender_steps_is_stored_and_its_other_steps_still_run() {
    let mut a = lender_account(both());
    let steps = json!([{ "k": "l_repay", "l": "rhea", "amt": 5 }, repay_step()]);
    assert!(deliver(&mut a, Intent::Check {}, &rebalance(0, H0 + 20, steps), H0 + 21).accepted);
    assert_eq!(events("plan_stored")[0]["steps"], json!(["l_repay", "repay"]));
    // The unwind plan's steps run in any order, as before.
    run_step(&mut a, "keeper.testnet", PID, 1, H0 + 25);
    assert_eq!(calls()[0].1, "ft_balance_of");
    assert!(step_done(&a, 1) && !step_done(&a, 0));
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 6, stage 2: Rhea. The funding plan's lender steps, the top-up's, the direct calls for leaving, the lender
// action under way, and the settlement with our pool (INTERFACES.md 25; FUNDING.md 4.4, 4.6 and 4.7)
// ---------------------------------------------------------------------------------------------------------------

const RHEA_ID: &str = "rhea.pbf-ops.testnet";
/// $4,000 in Rhea's inner units: 18 decimals, where USDC has 6.
const INNER_4K: &str = "4000000000000000000000";
/// 1.31 nBTC in Rhea's inner units: 18 decimals, where nBTC has 8.
const INNER_BTC: &str = "1310000000000000000";
/// The last block of the wait `borrowing_at_rhea` leaves: 20 blocks after the borrow went out at H0 + 14.
const WAIT_ENDS: u64 = H0 + 34;

/// The methods the last call called, in order.
fn methods() -> Vec<String> {
    calls().into_iter().map(|c| c.1).collect()
}

/// The last call's call of `method`: its receiver, its arguments and its deposit.
fn call_of(method: &str) -> (AccountId, Value, NearToken) {
    let found = calls().into_iter().find(|c| c.1 == method);
    let (to, _, args, deposit) = found.unwrap_or_else(|| panic!("no call to {method}"));
    (to, args, deposit)
}

/// A HEALTHY check verdict whose `ext` shows a $50,667 loan at Rhea, and gives Rhea `room` more.
fn rhea_verdict(nonce: u64, blk: u64, room: u128) -> Value {
    let mut v = verdict(nonce, blk);
    v["ext"] = json!([ext_line("rhea")]);
    v["ext"][0]["room"] = json!(room as u64);
    v
}

/// That verdict's lender report, as the pool's `settle` takes it.
fn rhea_report() -> Value {
    json!([{ "lender": "rhea", "debt": "50667000000", "rate_bp": 1591, "supply_bp": 1032 }])
}

fn l_repay_step() -> Value {
    json!({ "k": "l_repay", "l": "rhea", "amt": 10_133_000_000u64 })
}

fn l_add_step() -> Value {
    json!({ "k": "l_add", "l": "rhea", "tok": NBTC, "amt": "5000000" })
}

/// A lender action listed until block `until_block`: a borrow of USDC, or a withdrawal of nBTC.
fn listed(kind: LenderKind, amount: u128, until_block: u64) -> Pending {
    let token = (kind == LenderKind::Withdraw).then(|| NBTC.to_string());
    let (lender, until_block) = ("rhea".to_string(), Some(until_block));
    Pending::Lender(LenderAction { lender, kind, amount: U128(amount), token, until_block, evm_nonce: None })
}

/// A $1,000 loan from our pool, as the account records it.
fn pool_loan() -> Loan {
    Loan { principal: U128(1_000_000_000), open: true }
}

/// A token's answer to a transfer to Rhea: how much of it Rhea used.
fn used(amount: u128) -> PromiseResult {
    PromiseResult::Successful(format!("\"{amount}\"").into_bytes())
}

/// The pool's `settle` answer.
fn settled(answer: Value) -> PromiseResult {
    PromiseResult::Successful(near_sdk::serde_json::to_vec(&answer).unwrap())
}

fn skipped() -> PromiseResult {
    settled(json!({ "skipped": "settled 10 minutes ago" }))
}

/// The token's answer to the posting of step `i` of plan `pid` arrives at `height`. Returns what Rhea took.
fn supplied(a: &mut Account, pid: &str, i: u32, amount: u128, result: PromiseResult, height: u64) -> u128 {
    ctx(ACCOUNT, 0, height, time(height), vec![result]);
    a.on_supplied(pid.into(), i, U128(amount)).0
}

/// The pool's `settle` answer for `l_borrow` step `i` arrives at `height`. Returns whether the borrow went to Rhea.
fn step_settled(a: &mut Account, i: u32, amount: u128, result: PromiseResult, height: u64) -> bool {
    ctx(ACCOUNT, 0, height, time(height), vec![result]);
    match a.on_step_settled(FID.into(), i, "rhea".into(), U128(amount)) {
        PromiseOrValue::Promise(p) => {
            p.detach();
            true
        }
        PromiseOrValue::Value(sent) => sent,
    }
}

/// Rhea's `execute_with_pyth` returns at `height`, for step `i` of plan `pid` or for the owner's withdrawal.
fn lender_sent(a: &mut Account, pid: Option<&str>, i: u32, result: PromiseResult, height: u64) -> bool {
    ctx(ACCOUNT, 0, height, time(height), vec![result]);
    a.on_lender_sent(pid.map(str::to_string), i)
}

/// The pool's `check_step` answers for `l_repay` step `i` of plan 1020, which is about to send `amount`. Returns
/// whether the repayment went out.
fn repay_checked(a: &mut Account, i: u32, amount: u128, result: PromiseResult, height: u64) -> bool {
    ctx(ACCOUNT, 0, height, time(height), vec![result]);
    match a.on_repay_checked(PID.into(), i, U128(amount)) {
        PromiseOrValue::Promise(p) => {
            p.detach();
            true
        }
        PromiseOrValue::Value(sent) => sent,
    }
}

/// The pool's `check_step` answers for `l_add` step 0 of plan `pid`, which is about to post 0.05 nBTC. Returns
/// whether the collateral went out.
fn add_ready(a: &mut Account, pid: &str, result: PromiseResult, height: u64) -> bool {
    ctx(ACCOUNT, 0, height, time(height), vec![result]);
    match a.on_add_ready(pid.into(), 0, id(NBTC), U128(5_000_000)) {
        PromiseOrValue::Promise(p) => {
            p.detach();
            true
        }
        PromiseOrValue::Value(_) => false,
    }
}

/// The account's USDC balance arrives for `l_repay` step `i` of plan 1020. Returns whether the step went on: to the
/// pool's `check_step`, for what it is about to send.
fn repay_ready(a: &mut Account, i: u32, result: PromiseResult, height: u64) -> bool {
    ctx(ACCOUNT, 0, height, time(height), vec![result]);
    match a.on_repay_ready(PID.into(), i) {
        PromiseOrValue::Promise(p) => {
            p.detach();
            true
        }
        PromiseOrValue::Value(sent) => sent,
    }
}

/// The pool's `settle` answer arrives for `settle` or a repayment. Returns `on_settled`'s result.
fn settle_answered(a: &mut Account, result: PromiseResult) -> bool {
    ctx(ACCOUNT, 0, H0 + 2, T0, vec![result]);
    a.on_settled()
}

/// A funded account ($4,000 from Rhea against new collateral, then $6,000 from our pool) whose collateral step has
/// run, holding a fresh verdict for its counter, 1, that gives Rhea `room`.
fn ready_for_rhea(room: u128) -> Account {
    let mut a = funded(three_steps());
    a.funding.as_mut().unwrap().steps[0].done = true;
    assert!(deliver(&mut a, Intent::Check {}, &rhea_verdict(1, H0 + 10, room), H0 + 11).accepted);
    a
}

/// `ready_for_rhea` once its `l_borrow` step has started at H0 + 12 and the pool has settled at H0 + 14: the $4,000
/// borrow is with Rhea, listed until block `WAIT_ENDS`. The counter is 2.
fn borrowing_at_rhea() -> Account {
    let mut a = ready_for_rhea(4_000_000_000);
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 12);
    assert!(step_settled(&mut a, 1, 4_000_000_000, skipped(), H0 + 14));
    a
}

/// A lender account with this permission and a stored REBALANCE plan of `steps` (plan 1020), from a verdict read at
/// H0 + 20 whose `ext` shows the loan at Rhea.
fn with_top_up(permission: Option<Permission>, steps: Value) -> Account {
    let mut a = lender_account(permission);
    let mut v = rebalance(0, H0 + 20, steps);
    v["ext"] = json!([ext_line("rhea")]);
    assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 21).accepted);
    a
}

// l_supply.

#[test]
fn anyone_runs_an_l_supply_step_which_registers_at_rhea_and_posts_the_collateral() {
    let mut a = funded(three_steps());
    run_step(&mut a, "anyone.testnet", FID, 0, H0 + 9);
    assert_eq!(methods(), vec!["storage_deposit", "ft_transfer_call", "on_supplied"]);
    // Rhea's registration: 0.1 NEAR of the account's own.
    let (to, args, deposit) = call_of("storage_deposit");
    assert_eq!((to.as_str(), deposit), (RHEA_ID, NearToken::from_millinear(100)));
    assert_eq!(args, json!({ "account_id": ACCOUNT, "registration_only": true }));
    // The step's 1.31 nBTC, in the token's own units, straight into collateral.
    let (to, args, deposit) = call_of("ft_transfer_call");
    assert_eq!((to.as_str(), deposit.as_yoctonear()), (NBTC, 1));
    let sent =
        json!({ "receiver_id": RHEA_ID, "amount": "131000000", "memo": null, "msg": "\"OnlyIncreaseCollateral\"" });
    assert_eq!(args, sent);
    let (to, args, _) = call_of("on_supplied");
    assert_eq!((to.as_str(), args), (ACCOUNT, json!({ "pid": FID, "i": 0, "amount": "131000000" })));
    assert_eq!(
        (gas("storage_deposit"), gas("ft_transfer_call"), gas("on_supplied")),
        (Gas::from_tgas(10), Gas::from_tgas(100), Gas::from_tgas(10))
    );
    assert_eq!(events("step_run"), vec![json!({ "pid": FID, "i": 0, "k": "l_supply" })]);
    // With no loan from our pool it needed no verdict: `fund` had spent the only one. Like a withdrawal, it bumps
    // the counter, and it lists nothing as under way.
    let s = a.get_state();
    assert_eq!((s.counter, s.pending.len(), s.loan.open), (2, 0, false));
    assert!(fund_step_done(&a, 0));
    // Rhea took it all: the counter moves on again, and the account knows it is registered there.
    assert_eq!(supplied(&mut a, FID, 0, 131_000_000, used(131_000_000), H0 + 11), 131_000_000);
    assert_eq!(get_logs(), vec!["posted 131000000 at Rhea as collateral"]);
    assert_eq!(a.get_state().counter, 3);
    assert!(fund_step_done(&a, 0) && a.rhea_registered);
    // So the next posting pays no registration.
    a.funding.as_mut().unwrap().steps[0].done = false;
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 12);
    assert_eq!(methods(), vec!["ft_transfer_call", "on_supplied"]);
}

#[test]
fn an_l_supply_step_rhea_took_nothing_of_may_run_again() {
    for answer in [PromiseResult::Failed, used(0)] {
        let mut a = funded(three_steps());
        run_step(&mut a, "keeper.testnet", FID, 0, H0 + 9);
        assert_eq!(supplied(&mut a, FID, 0, 131_000_000, answer, H0 + 11), 0);
        let why = "step 0 of plan f1005 didn't go out: Rhea took no collateral, and it may run again";
        assert_eq!(get_logs(), vec![why]);
        // The counter still moves on: a verdict read meanwhile may have missed the tokens.
        assert_eq!(a.get_state().counter, 3);
        assert!(!fund_step_done(&a, 0) && !a.rhea_registered);
        // It registers again, in case that was what failed. Rhea sends the 0.1 NEAR back if it wasn't.
        run_step(&mut a, "keeper.testnet", FID, 0, H0 + 12);
        assert_eq!(methods(), vec!["storage_deposit", "ft_transfer_call", "on_supplied"]);
    }
    // A plan the owner dropped meanwhile has no step to open again.
    let mut a = funded(three_steps());
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 9);
    at(OWNER, 1, H0 + 10);
    a.cancel_funding();
    assert_eq!(supplied(&mut a, FID, 0, 131_000_000, PromiseResult::Failed, H0 + 11), 0);
    assert!(a.get_state().funding.is_none());
}

#[test]
fn while_the_account_owes_our_pool_l_supply_needs_a_fresh_healthy_verdict_with_the_current_counter() {
    let mut a = funded(three_steps());
    a.loan = pool_loan();
    // `fund` spent the fund verdict.
    let refused = step_refused(&mut a, FID, 0, H0 + 9, time(H0 + 9));
    assert_eq!(refused, "the verdict was already used: ask for a new check");
    let mut watch = verdict(1, H0 + 10);
    watch["state"] = json!("WATCH");
    assert!(deliver(&mut a, Intent::Check {}, &watch, H0 + 11).accepted);
    assert_eq!(step_refused(&mut a, FID, 0, H0 + 12, time(H0 + 12)), "the verdict's state isn't HEALTHY");
    assert!(deliver(&mut a, Intent::Check {}, &verdict(1, H0 + 13), H0 + 14).accepted);
    let old = step_refused(&mut a, FID, 0, H0 + 134, time(H0 + 134));
    assert_eq!(old, "the verdict is 121 blocks old, above the 120-block limit");
    // A signed sendAsset that could still be posted holds it back, as it holds back a borrow.
    a.hl.send_open_until_ms = U64(NOW_MS + 60_000);
    let refused = step_refused(&mut a, FID, 0, H0 + 15, time(H0 + 15));
    assert!(refused.starts_with("no collateral posting until 2023-11-14 22:14:20 UTC"), "{refused}");
    a.hl.send_open_until_ms = U64(0);
    // So does a borrow from our pool that is under way, whose loan no verdict shows yet.
    a.pending.push(Pending::Borrow { amount: U128(5) });
    let refused = step_refused(&mut a, FID, 0, H0 + 15, time(H0 + 15));
    assert_eq!(refused, "a borrow is under way: wait for it to finish");
    a.pending.clear();
    assert!(!fund_step_done(&a, 0) && a.get_state().counter == 1);
    // On a fresh HEALTHY verdict, of any intent, it runs, and that verdict backs nothing more.
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 15);
    assert_eq!(call_of("ft_transfer_call").0.as_str(), NBTC);
    assert_eq!(a.get_state().counter, 2);
}

#[test]
fn a_verdict_read_before_the_collateral_was_posted_backs_nothing_afterwards() {
    let mut a = funded(three_steps());
    // A borrow verdict that counts the bitcoin as free, for the counter as it is.
    assert!(deliver(&mut a, borrow_intent(5), &verdict(1, H0 + 9), H0 + 10).accepted);
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 11);
    at(OWNER, 1, H0 + 12);
    assert_eq!(refusal(|| a.borrow(U128(5)).detach()), "the verdict was already used: ask for a new check");
    // One read while the tokens were on their way backs nothing once they have gone.
    assert!(deliver(&mut a, borrow_intent(5), &verdict(2, H0 + 12), H0 + 13).accepted);
    supplied(&mut a, FID, 0, 131_000_000, used(131_000_000), H0 + 14);
    at(OWNER, 1, H0 + 15);
    assert_eq!(refusal(|| a.borrow(U128(5)).detach()), "the verdict was already used: ask for a new check");
}

// l_borrow.

#[test]
fn an_l_borrow_step_has_the_pool_settle_first_and_lists_the_borrow_as_under_way() {
    let mut a = ready_for_rhea(4_000_000_000);
    run_step(&mut a, "anyone.testnet", FID, 1, H0 + 12);
    // Nothing goes to Rhea yet: the pool settles the client's price up to now, with the verdict's lender report.
    // Rhea's debt in it is the verdict's $50,667 plus the $4,000 this step borrows.
    assert_eq!(methods(), vec!["settle", "on_step_settled"]);
    let (to, args, deposit) = call_of("settle");
    assert_eq!((to.as_str(), deposit.as_yoctonear()), (POOL, 0));
    let report = json!([{ "lender": "rhea", "debt": "54667000000", "rate_bp": 1591, "supply_bp": 1032 }]);
    assert_eq!(args, json!({ "report": report, "closes": rhea_report() }));
    let (to, args, _) = call_of("on_step_settled");
    let settled = json!({ "pid": FID, "i": 1, "lender": "rhea", "amount": "4000000000" });
    assert_eq!((to.as_str(), args), (ACCOUNT, settled));
    assert_eq!((gas("settle"), gas("on_step_settled")), (Gas::from_tgas(30), Gas::from_tgas(180)));
    assert_eq!(events("step_run"), vec![json!({ "pid": FID, "i": 1, "k": "l_borrow" })]);
    // The borrow is listed from this moment, in micro-USD, and the verdict is spent.
    let view = near_sdk::serde_json::to_value(a.get_state()).unwrap();
    let pending = json!([{
        "lender": { "lender": "rhea", "kind": "borrow", "amount": "4000000000", "until_block": H0 + 32 },
    }]);
    assert_eq!(view["pending"], pending);
    assert_eq!((&view["counter"], &view["loan"]), (&json!(2), &json!({ "principal": "0", "open": false })));
    assert!(fund_step_done(&a, 1));
}

#[test]
fn the_borrow_steps_report_counts_what_the_step_borrows_at_its_lender_and_no_other_report_does() {
    // The verdict shows $50,667 owed at each lender and gives Rhea $2,500 of room. The step asks for $4,000.
    let mut a = funded(three_steps());
    a.funding.as_mut().unwrap().steps[0].done = true;
    let mut v = rhea_verdict(1, H0 + 10, 2_500_000_000);
    let rhea = v["ext"][0].clone();
    v["ext"] = json!([ext_line("aave"), rhea]);
    assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 11).accepted);
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 12);
    // Rhea's line carries its debt plus the $2,500 the step really borrows. Aave's is as the verdict shows it. So
    // a loan taken now and repaid before the next settlement still shows at one end of the period.
    let line = |l: &str, debt: &str| json!({ "lender": l, "debt": debt, "rate_bp": 1591, "supply_bp": 1032 });
    let report = json!([line("aave", "50667000000"), line("rhea", "53167000000")]);
    assert_eq!(call_of("settle").1["report"], report);
    assert_eq!(call_of("on_step_settled").1["amount"], "2500000000");
    // `settle` and the settlement at a repayment report what the verdict shows, with nothing added.
    let mut a = lender_account(both());
    assert!(deliver(&mut a, Intent::Check {}, &rhea_verdict(0, H0 + 5, 2_500_000_000), H0 + 6).accepted);
    at("keeper.testnet", 0, H0 + 8);
    a.settle().detach();
    assert_eq!(call_of("settle").1, json!({ "report": rhea_report() }));
    at(OWNER, 1, H0 + 8);
    a.lender_repay("rhea".into(), U128(5)).detach();
    assert_eq!(call_of("settle").1, json!({ "report": rhea_report() }));
}

#[test]
fn once_the_pool_has_settled_the_account_borrows_at_rhea_and_has_the_usdc_sent_to_itself() {
    let nothing = json!({ "fee": "0", "subsidy": "0", "credit": "0", "period_ns": "3600000000000" });
    // An answer that says the pool skipped the settlement counts as settled.
    for answer in [skipped(), settled(nothing)] {
        let mut a = ready_for_rhea(4_000_000_000);
        run_step(&mut a, "keeper.testnet", FID, 1, H0 + 12);
        assert!(step_settled(&mut a, 1, 4_000_000_000, answer, H0 + 14));
        assert_eq!(methods(), vec!["execute_with_pyth", "on_lender_sent"]);
        // Borrow, then withdraw up to the same amount, in Rhea's 18 decimals, with 1 yoctoNEAR.
        let (to, args, deposit) = call_of("execute_with_pyth");
        assert_eq!((to.as_str(), deposit.as_yoctonear()), (RHEA_ID, 1));
        let actions = json!({ "actions": [
            { "Borrow": { "token_id": USDC, "amount": INNER_4K } },
            { "Withdraw": { "token_id": USDC, "max_amount": INNER_4K } },
        ] });
        assert_eq!(args, actions);
        assert_eq!(call_of("on_lender_sent").1, json!({ "pid": FID, "i": 1 }));
        assert_eq!((gas("execute_with_pyth"), gas("on_lender_sent")), (Gas::from_tgas(150), Gas::from_tgas(10)));
        // The 20 blocks count from here. The account books no loan: Rhea doesn't say whether it lent.
        let s = a.get_state();
        assert_eq!(s.pending, vec![listed(LenderKind::Borrow, 4_000_000_000, WAIT_ENDS)]);
        assert_eq!((s.counter, s.loan), (2, Loan::default()));
        // Rhea took the call: the step stays done and the borrow stays listed.
        assert!(lender_sent(&mut a, Some(FID), 1, checked(), H0 + 15));
        let s = a.get_state();
        assert_eq!((s.counter, s.pending.len(), s.loan), (2, 1, Loan::default()));
        assert!(fund_step_done(&a, 1));
    }
}

#[test]
fn an_l_borrow_step_borrows_no_more_than_the_room_the_fresh_verdict_gives_rhea() {
    // The step asks for $4,000, and the verdict gives Rhea $2,500 of room.
    let mut a = ready_for_rhea(2_500_000_000);
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 12);
    assert_eq!(call_of("on_step_settled").1["amount"], "2500000000");
    assert_eq!(a.get_state().pending, vec![listed(LenderKind::Borrow, 2_500_000_000, H0 + 32)]);
    // More room than the step asks for lends the step's amount.
    let mut a = ready_for_rhea(9_000_000_000);
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 12);
    assert_eq!(call_of("on_step_settled").1["amount"], "4000000000");
    // No room is a refusal, and so is a verdict with no line for Rhea.
    let no_room = "the verdict leaves no room to borrow at Rhea now";
    let mut a = ready_for_rhea(0);
    assert_eq!(step_refused(&mut a, FID, 1, H0 + 12, time(H0 + 12)), no_room);
    let mut a = funded(three_steps());
    a.funding.as_mut().unwrap().steps[0].done = true;
    let mut v = verdict(1, H0 + 10);
    v["ext"] = json!([ext_line("aave")]);
    assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 11).accepted);
    assert_eq!(step_refused(&mut a, FID, 1, H0 + 12, time(H0 + 12)), no_room);
    let s = a.get_state();
    assert!(!fund_step_done(&a, 1) && s.counter == 1 && s.pending.is_empty());
}

#[test]
fn an_l_borrow_step_needs_a_fresh_healthy_verdict_with_the_current_counter() {
    let mut a = funded(three_steps());
    a.funding.as_mut().unwrap().steps[0].done = true;
    // `fund` spent the fund verdict.
    let refused = step_refused(&mut a, FID, 1, H0 + 12, time(H0 + 12));
    assert_eq!(refused, "the verdict was already used: ask for a new check");
    let mut watch = rhea_verdict(1, H0 + 12, 4_000_000_000);
    watch["state"] = json!("WATCH");
    assert!(deliver(&mut a, Intent::Check {}, &watch, H0 + 13).accepted);
    assert_eq!(step_refused(&mut a, FID, 1, H0 + 14, time(H0 + 14)), "the verdict's state isn't HEALTHY");
    assert!(deliver(&mut a, Intent::Check {}, &rhea_verdict(1, H0 + 15, 4_000_000_000), H0 + 16).accepted);
    let old = step_refused(&mut a, FID, 1, H0 + 136, time(H0 + 136));
    assert_eq!(old, "the verdict is 121 blocks old, above the 120-block limit");
    // It waits for a borrow from our pool that is under way, and for an open send window, as our pool's step does.
    a.pending.push(Pending::Borrow { amount: U128(5) });
    assert_eq!(step_refused(&mut a, FID, 1, H0 + 17, time(H0 + 17)), "a borrow is already under way");
    a.pending.clear();
    a.hl.send_open_until_ms = U64(NOW_MS + 60_000);
    let refused = step_refused(&mut a, FID, 1, H0 + 17, time(H0 + 17));
    assert!(refused.starts_with("no borrow until 2023-11-14 22:14:20 UTC"), "{refused}");
    a.hl.send_open_until_ms = U64(0);
    // Nothing a refusal touched changed, and the same verdict still runs the step in time.
    let s = a.get_state();
    assert!(!fund_step_done(&a, 1) && s.counter == 1 && s.pending.is_empty());
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 135);
    assert_eq!(methods(), vec!["settle", "on_step_settled"]);
}

#[test]
fn if_the_pools_settlement_fails_nothing_is_borrowed_and_the_step_may_run_again() {
    let mut a = ready_for_rhea(4_000_000_000);
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 12);
    assert!(!step_settled(&mut a, 1, 4_000_000_000, PromiseResult::Failed, H0 + 14));
    assert!(get_created_receipts().is_empty(), "something went to Rhea");
    let logs = get_logs();
    assert_eq!(logs[0], "the pool's settlement failed");
    let why = "step 1 of plan f1005 didn't go out, as the pool's settlement failed: nothing was borrowed, and it may \
               run again";
    assert_eq!(logs[1], why);
    // The listing is gone and the counter has moved on, so no verdict read meanwhile backs anything.
    let s = a.get_state();
    assert_eq!((s.counter, s.pending.len(), s.loan), (3, 0, Loan::default()));
    assert!(!fund_step_done(&a, 1));
    // It runs again on a new verdict for the counter as it is now.
    assert!(deliver(&mut a, Intent::Check {}, &rhea_verdict(3, H0 + 15, 4_000_000_000), H0 + 16).accepted);
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 17);
    assert_eq!(methods(), vec!["settle", "on_step_settled"]);
    // An account blocked while the pool was settling borrows nothing either.
    let mut a = ready_for_rhea(4_000_000_000);
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 12);
    a.blocked = true;
    assert!(!step_settled(&mut a, 1, 4_000_000_000, skipped(), H0 + 14));
    assert!(get_created_receipts().is_empty() && a.get_state().pending.is_empty());
    assert!(get_logs().last().unwrap().contains("didn't go out, as the account can't borrow now"));
}

#[test]
fn if_rhea_refuses_the_call_itself_the_borrow_is_dropped_and_the_step_may_run_again() {
    let mut a = borrowing_at_rhea();
    assert!(!lender_sent(&mut a, Some(FID), 1, PromiseResult::Failed, H0 + 15));
    let why = "step 1 of plan f1005 didn't go out, as Rhea refused it: nothing was borrowed, and it may run again";
    assert_eq!(get_logs(), vec![why]);
    let s = a.get_state();
    assert_eq!((s.counter, s.pending.len(), s.loan), (3, 0, Loan::default()));
    assert!(!fund_step_done(&a, 1));
    // A plan the owner replaced meanwhile keeps its own steps as they are.
    let mut a = borrowing_at_rhea();
    a.funding.as_mut().unwrap().pid = "f2000".into();
    assert!(!lender_sent(&mut a, Some(FID), 1, PromiseResult::Failed, H0 + 15));
    assert!(fund_step_done(&a, 1) && a.get_state().pending.is_empty());
}

#[test]
fn a_lender_borrow_rhea_took_runs_once_so_a_plan_never_borrows_more_than_the_owner_asked_for() {
    let mut a = borrowing_at_rhea();
    assert!(lender_sent(&mut a, Some(FID), 1, checked(), H0 + 15));
    // Rhea may have lent or not: the account can't tell, so the step never runs again, even after the wait.
    for height in [H0 + 16, WAIT_ENDS + 1] {
        let refused = step_refused(&mut a, FID, 1, height, time(height));
        assert_eq!(refused, "step 1 of plan f1005 has already run");
    }
}

#[test]
fn a_lender_the_permission_no_longer_names_is_never_borrowed_from() {
    let mut a = ready_for_rhea(4_000_000_000);
    at(OWNER, 1, H0 + 12);
    a.set_permission(Some(permission(&["aave"])));
    // A new check, read after the change, doesn't bring the lender back.
    assert!(deliver(&mut a, Intent::Check {}, &rhea_verdict(1, H0 + 13, 4_000_000_000), H0 + 14).accepted);
    let refused = step_refused(&mut a, FID, 1, H0 + 15, time(H0 + 15));
    assert_eq!(refused, "step 1 names rhea, which the owner's permission doesn't name");
    assert!(a.get_state().pending.is_empty());
}

// The lender action under way.

#[test]
fn while_a_lender_action_is_under_way_nothing_that_adds_risk_runs() {
    let mut a = borrowing_at_rhea();
    a.loan = pool_loan();
    let wait = "until block 1034 has passed: a borrow at rhea is still under way";
    // Through its last block.
    for height in [H0 + 15, WAIT_ENDS] {
        at(OWNER, 1, height);
        assert_eq!(refusal(|| a.borrow(U128(5)).detach()), format!("no borrow {wait}"));
        at(OWNER, 1, height);
        let refused = refusal(|| a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach());
        assert_eq!(refused, format!("no withdrawal with a loan open {wait}"));
        at(OWNER, 1, height);
        let refused = refusal(|| a.lender_withdraw("rhea".into(), NBTC.into(), U128(5)).detach());
        assert_eq!(refused, format!("no lender withdrawal {wait}"));
        // Our pool's step, the next of the plan.
        assert_eq!(step_refused(&mut a, FID, 2, height, time(height)), format!("no funding step {wait}"));
    }
    // A posting of collateral for a new loan waits too.
    a.funding.as_mut().unwrap().steps[0].done = false;
    assert_eq!(step_refused(&mut a, FID, 0, H0 + 15, time(H0 + 15)), format!("no funding step {wait}"));
    let s = a.get_state();
    assert_eq!((s.counter, s.pending), (2, vec![listed(LenderKind::Borrow, 4_000_000_000, WAIT_ENDS)]));
}

#[test]
fn repaying_checking_and_settling_never_wait_for_a_lender_action() {
    let mut a = borrowing_at_rhea();
    a.loan = pool_loan();
    at(OWNER, 1, H0 + 16);
    a.repay(U128(5)).detach();
    assert_eq!(call_of("ft_transfer_call").1["msg"], r#"{"pool":"repay"}"#);
    at(OWNER, 1, H0 + 16);
    a.lender_repay("rhea".into(), U128(5)).detach();
    assert_eq!(call_of("ft_transfer_call").1["msg"], "\"OnlyRepay\"");
    at("keeper.testnet", NearToken::from_millinear(10).as_yoctonear(), H0 + 16);
    a.request_check(Intent::Check {}).detach();
    assert_eq!(methods()[0], "request_execution");
    // A verdict read meanwhile is kept, and the pool settles on it.
    assert!(deliver(&mut a, Intent::Check {}, &rhea_verdict(2, H0 + 17, 0), H0 + 18).accepted);
    at("keeper.testnet", 0, H0 + 19);
    a.settle().detach();
    assert_eq!(methods(), vec!["settle", "on_settled"]);
    assert_eq!((a.get_state().counter, a.get_state().pending.len()), (2, 1));
}

#[test]
fn the_first_call_after_its_last_block_drops_the_lender_action_and_bumps_the_counter() {
    let mut a = borrowing_at_rhea();
    // A check read while the borrow was listed carries the counter of that time, 2.
    assert!(deliver(&mut a, borrow_intent(5), &verdict(2, H0 + 20), H0 + 21).accepted);
    assert_eq!((a.get_state().counter, a.get_state().pending.len()), (2, 1));
    // One block after the wait, the keeper's next check ends it, before the engine reads the counter.
    let deposit = NearToken::from_millinear(10).as_yoctonear();
    at("keeper.testnet", deposit, WAIT_ENDS + 1);
    a.request_check(Intent::Check {}).detach();
    assert_eq!(get_logs(), vec!["the lender action's 20 blocks are over: the counter moves on"]);
    assert_eq!((a.get_state().counter, a.get_state().pending.len()), (3, 0));
    // So the verdict read meanwhile, which may not show what Rhea did, backs nothing.
    at(OWNER, 1, WAIT_ENDS + 2);
    assert_eq!(refusal(|| a.borrow(U128(5)).detach()), "the verdict was already used: ask for a new check");
    // It happens once.
    at("keeper.testnet", deposit, WAIT_ENDS + 3);
    a.request_check(Intent::Check {}).detach();
    assert!(get_logs().is_empty());
    assert_eq!(a.get_state().counter, 3);
}

#[test]
fn after_the_wait_our_pools_step_runs_on_a_check_asked_for_after_it() {
    let mut a = borrowing_at_rhea();
    assert!(lender_sent(&mut a, Some(FID), 1, checked(), H0 + 15));
    // The keeper asks for a check once the wait is over, which ends it: the engine then reads the new counter, 3,
    // and Rhea's position as it really is.
    at("keeper.testnet", NearToken::from_millinear(10).as_yoctonear(), WAIT_ENDS + 1);
    a.request_check(Intent::Check {}).detach();
    assert!(deliver(&mut a, Intent::Check {}, &rhea_verdict(3, WAIT_ENDS + 2, 0), WAIT_ENDS + 4).accepted);
    run_step(&mut a, "keeper.testnet", FID, 2, WAIT_ENDS + 5);
    let (to, args, _) = call_of("borrow");
    assert_eq!((to.as_str(), &args["amount"]), (POOL, &json!("6000000000")));
    let s = a.get_state();
    assert_eq!((s.counter, s.pending), (4, vec![Pending::Borrow { amount: U128(6_000_000_000) }]));
    assert!(!a.funding.as_ref().unwrap().unfinished());
}

#[test]
fn a_verdict_read_during_the_wait_and_delivered_after_it_is_refused() {
    let mut a = borrowing_at_rhea();
    let late = deliver(&mut a, Intent::Check {}, &verdict(2, WAIT_ENDS), WAIT_ENDS + 1);
    assert_eq!(late.reason.unwrap(), "nonce 2 is not the counter 3");
    assert_eq!((a.get_state().counter, a.get_state().pending.len()), (3, 0));
    // One for the new counter is kept.
    assert!(deliver(&mut a, Intent::Check {}, &verdict(3, WAIT_ENDS + 2), WAIT_ENDS + 3).accepted);
}

#[test]
fn every_call_that_reads_a_verdict_or_the_counter_ends_a_wait_that_is_over() {
    let deposit = NearToken::from_millinear(10).as_yoctonear();
    let calls: [(&str, &str, u128, fn(&mut Account)); 12] = [
        ("request_check", "keeper.testnet", deposit, |a| a.request_check(Intent::Check {}).detach()),
        ("borrow", OWNER, 1, |a| a.borrow(U128(5)).detach()),
        ("fund", OWNER, 1, |a| drop(a.fund(U128(5)))),
        ("set_permission", OWNER, 1, |a| a.set_permission(None)),
        ("repay", OWNER, 1, |a| a.repay(U128(5)).detach()),
        ("withdraw", OWNER, 1, |a| a.withdraw(id(USDC), U128(5), id(OWNER), None).detach()),
        ("hl_withdraw", OWNER, 1, |a| a.hl_withdraw(U128(5), FLOAT.into(), None, None, None).detach()),
        ("execute_step", "keeper.testnet", 0, |a| a.execute_step(FID.into(), 2).detach()),
        ("lender_repay", OWNER, 1, |a| a.lender_repay("rhea".into(), U128(5)).detach()),
        ("lender_withdraw", OWNER, 1, |a| a.lender_withdraw("rhea".into(), NBTC.into(), U128(5)).detach()),
        ("settle", "keeper.testnet", 0, |a| a.settle().detach()),
        ("claim_credit", OWNER, 0, |a| a.claim_credit().detach()),
    ];
    for (name, who, yocto, call) in calls {
        let mut a = borrowing_at_rhea();
        // In its last block the borrow is still listed.
        at(who, yocto, WAIT_ENDS);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| call(&mut a)));
        assert!(a.lender_actions().any(|l| l.kind == LenderKind::Borrow), "{name} dropped the borrow too early");
        // One block later the call drops it and moves the counter on, before anything else it does.
        let mut a = borrowing_at_rhea();
        at(who, yocto, WAIT_ENDS + 1);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| call(&mut a)));
        assert!(!a.lender_actions().any(|l| l.kind == LenderKind::Borrow), "{name} left the borrow listed");
        assert!(a.get_state().counter >= 3, "{name} left the counter at {}", a.get_state().counter);
    }
}

// lender_repay.

#[test]
fn the_owner_repays_rhea_from_the_accounts_usdc_with_no_permission_and_no_verdict() {
    let mut a = lender_account(None);
    at(OWNER, 1, H0 + 1);
    a.lender_repay("rhea".into(), U128(10_133_000_000)).detach();
    // No verdict is held, so nothing is settled now: the next hourly settlement covers it.
    assert_eq!(methods(), vec!["ft_transfer_call", "on_lender_repaid"]);
    let (to, args, deposit) = call_of("ft_transfer_call");
    assert_eq!((to.as_str(), deposit.as_yoctonear()), (USDC, 1));
    let sent = json!({ "receiver_id": RHEA_ID, "amount": "10133000000", "memo": null, "msg": "\"OnlyRepay\"" });
    assert_eq!(args, sent);
    let (to, args, _) = call_of("on_lender_repaid");
    assert_eq!((to.as_str(), args), (ACCOUNT, json!({ "amount": "10133000000" })));
    assert_eq!((gas("ft_transfer_call"), gas("on_lender_repaid")), (Gas::from_tgas(100), Gas::from_tgas(10)));
    // A repayment only lowers risk: the counter stays.
    assert_eq!(a.get_state().counter, 0);
}

#[test]
fn a_lender_repayment_has_the_pool_settle_only_when_a_fresh_verdict_is_held() {
    let mut a = lender_account(both());
    assert!(deliver(&mut a, Intent::Check {}, &rhea_verdict(0, H0 + 5, 0), H0 + 6).accepted);
    at(OWNER, 1, H0 + 8);
    a.lender_repay("rhea".into(), U128(5)).detach();
    assert_eq!(methods(), vec!["settle", "on_settled", "ft_transfer_call", "on_lender_repaid"]);
    assert_eq!(call_of("settle").1, json!({ "report": rhea_report() }));
    assert_eq!((gas("settle"), gas("on_settled")), (Gas::from_tgas(30), Gas::from_tgas(10)));
    // The repayment spends nothing, so the verdict is still fresh for the next call.
    assert_eq!(a.get_state().counter, 0);
    // Once the verdict is over 120 blocks old the repayment goes alone.
    at(OWNER, 1, H0 + 5 + FRESH_BLOCKS + 1);
    a.lender_repay("rhea".into(), U128(5)).detach();
    assert_eq!(methods(), vec!["ft_transfer_call", "on_lender_repaid"]);
    // And so it does once the counter has moved past the verdict.
    at(OWNER, 1, H0 + 9);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
    at(OWNER, 1, H0 + 10);
    a.lender_repay("rhea".into(), U128(5)).detach();
    assert_eq!(methods(), vec!["ft_transfer_call", "on_lender_repaid"]);
}

/// What `who`'s `lender_repay(lender, amount)` with `yocto` is refused with.
fn lender_repay_refused(a: &mut Account, who: &str, yocto: u128, lender: &str, amount: u128) -> String {
    at(who, yocto, H0 + 1);
    let refused = refusal(|| a.lender_repay(lender.into(), U128(amount)).detach());
    assert!(calls().is_empty(), "a refused repayment still called something");
    refused
}

#[test]
fn lender_repay_is_the_owners_with_1_yocto_unless_repay_is_open_to_anyone() {
    let mut a = lender_account(both());
    let refused = lender_repay_refused(&mut a, "keeper.testnet", 1, "rhea", 5);
    assert!(refused.starts_with("only the owner can repay, unless the verdict says DELEVERAGE"), "{refused}");
    assert!(lender_repay_refused(&mut a, OWNER, 0, "rhea", 5).contains("1 yoctoNEAR"));
    assert_eq!(lender_repay_refused(&mut a, OWNER, 1, "rhea", 0), "amount must be positive");
    // Aave's repayment is an Ethereum transaction, which needs the account's address there.
    assert_eq!(lender_repay_refused(&mut a, OWNER, 1, "aave", 5), "no Ethereum address yet: call hl_init first");
    assert_eq!(lender_repay_refused(&mut a, OWNER, 1, "compound", 5), r#"lender must be "rhea" or "aave""#);
    let mut plain = account();
    assert_eq!(lender_repay_refused(&mut plain, OWNER, 1, "rhea", 5), "this account has no settings for rhea");
    // Once the verdict says DELEVERAGE, anyone repays Rhea, as anyone repays the pool.
    let mut unwind = deleverage(H0 + 5, 0);
    unwind["ext"] = json!([ext_line("rhea")]);
    assert!(deliver(&mut a, Intent::Check {}, &unwind, H0 + 6).accepted);
    at("keeper.testnet", 1, H0 + 7);
    a.lender_repay("rhea".into(), U128(5)).detach();
    assert_eq!(call_of("ft_transfer_call").1["msg"], "\"OnlyRepay\"");
    // And so they do once a MARGIN_CALL verdict is over 30 minutes old.
    let mut a = lender_account(both());
    let mut call = margin_call(0, H0 + 5, T0);
    call["ext"] = json!([ext_line("rhea")]);
    assert!(deliver_at(&mut a, Intent::Check {}, &call, H0 + 6, T0).accepted);
    ctx("keeper.testnet", 1, H0 + 7, T0 + 30 * MINUTE_NS + 1, vec![]);
    a.lender_repay("rhea".into(), U128(5)).detach();
    assert_eq!(call_of("ft_transfer_call").1["msg"], "\"OnlyRepay\"");
}

#[test]
fn anyone_but_the_owner_repays_rhea_no_more_than_the_debt_the_verdict_shows() {
    // Rhea keeps what is above the debt as a deposit, out of reach of the pool's steps. A stranger can't put it there.
    let mut a = lender_account(both());
    let mut unwind = deleverage(H0 + 5, 0);
    unwind["ext"] = json!([ext_line("rhea")]);
    assert!(deliver(&mut a, Intent::Check {}, &unwind, H0 + 6).accepted);
    at("stranger.testnet", 1, H0 + 7);
    a.lender_repay("rhea".into(), U128(900_000_000_000)).detach();
    assert_eq!(call_of("ft_transfer_call").1["amount"], "50667000000");
    assert_eq!(call_of("on_lender_repaid").1, json!({ "amount": "50667000000" }));
    // The owner sends what they like, and takes the rest back with lender_withdraw.
    at(OWNER, 1, H0 + 7);
    a.lender_repay("rhea".into(), U128(900_000_000_000)).detach();
    assert_eq!(call_of("ft_transfer_call").1["amount"], "900000000000");
    // A verdict that shows no debt at Rhea lets a stranger send nothing.
    let mut a = lender_account(both());
    assert!(deliver(&mut a, Intent::Check {}, &deleverage(H0 + 5, 0), H0 + 6).accepted);
    let refused = lender_repay_refused(&mut a, "stranger.testnet", 1, "rhea", 5);
    assert_eq!(refused, "the verdict shows no debt at rhea: only the owner can send it more");
    let mut none = deleverage(H0 + 7, 0);
    none["ext"] = json!([ext_line("rhea")]);
    none["ext"][0]["d"] = json!(0);
    assert!(deliver(&mut a, Intent::Check {}, &none, H0 + 8).accepted);
    let refused = lender_repay_refused(&mut a, "stranger.testnet", 1, "rhea", 5);
    assert_eq!(refused, "the verdict shows no debt at rhea: only the owner can send it more");
}

#[test]
fn repaying_a_lender_is_never_held_back() {
    // Blocked after a default, with an overdue transfer, a borrow and a lender action under way, and a signed
    // sendAsset that could still be posted: the repayment goes all the same.
    let mut a = lender_account(both());
    a.blocked = true;
    a.pending.push(Pending::Transfer(Transfer::new("move:0".into(), TransferKind::ToHl, USDC, 5, DEP, 0)));
    a.pending.push(Pending::Borrow { amount: U128(5) });
    a.pending.push(listed(LenderKind::Withdraw, 5, H0 + 20));
    a.hl.send_open_until_ms = U64(NOW_MS + 60_000);
    at(OWNER, 1, H0 + 1);
    a.lender_repay("rhea".into(), U128(5)).detach();
    assert_eq!(methods(), vec!["ft_transfer_call", "on_lender_repaid"]);
    assert_eq!((a.get_state().counter, a.get_state().pending.len()), (0, 3));
}

#[test]
fn what_rhea_used_of_a_repayment_is_logged_and_the_account_books_nothing() {
    let mut a = with_loan();
    let before = a.get_state();
    let cases = [
        (used(4), 4, "repaid 4 at Rhea"),
        (used(9), 5, "repaid 5 at Rhea"),
        (used(0), 0, "Rhea took nothing of the 5 sent, and it came back"),
        (PromiseResult::Failed, 0, "the repayment of 5 at Rhea failed"),
    ];
    for (result, repaid, log) in cases {
        ctx(ACCOUNT, 0, H0 + 20, T0, vec![result]);
        assert_eq!(a.on_lender_repaid(U128(5)), U128(repaid));
        assert_eq!(get_logs(), vec![log]);
    }
    assert_eq!(a.get_state(), before);
}

// lender_withdraw.

fn lender_withdraw_intent(amount: u128) -> Intent {
    Intent::LenderWithdraw { lender: "rhea".into(), token: NBTC.into(), amount: U128(amount) }
}

/// A HEALTHY verdict read at H0 + 5 for counter 0, whose `allow.withdraw` is `amount`.
fn allowing(amount: u128) -> Value {
    let mut v = verdict(0, H0 + 5);
    v["allow"]["withdraw"] = json!(amount as u64);
    v
}

/// What the owner's `lender_withdraw` of 1.31 nBTC from Rhea at `height` is refused with.
fn lender_withdraw_refused(a: &mut Account, height: u64) -> String {
    at(OWNER, 1, height);
    let refused = refusal(|| a.lender_withdraw("rhea".into(), NBTC.into(), U128(131_000_000)).detach());
    assert!(calls().is_empty(), "a refused withdrawal still called something");
    refused
}

/// A lender account that owes our pool $1,000 and holds verdict `v` for `intent`: what the owner's `lender_withdraw`
/// of 1.31 nBTC at H0 + 8 is refused with.
fn lender_withdraw_refused_on(intent: Intent, v: Value) -> String {
    let mut a = lender_account(both());
    a.loan = pool_loan();
    assert!(deliver(&mut a, intent, &v, H0 + 6).accepted);
    let refused = lender_withdraw_refused(&mut a, H0 + 8);
    assert!(a.get_state().pending.is_empty() && a.get_state().counter == 0);
    refused
}

#[test]
fn with_no_loan_from_our_pool_the_owner_takes_collateral_back_from_rhea_without_a_verdict() {
    let mut a = lender_account(None);
    at(OWNER, 1, H0 + 1);
    a.lender_withdraw("rhea".into(), NBTC.into(), U128(131_000_000)).detach();
    assert_eq!(methods(), vec!["execute_with_pyth", "on_lender_sent"]);
    // Out of the collateral, then sent to the account, in Rhea's 18 decimals, with 1 yoctoNEAR.
    let (to, args, deposit) = call_of("execute_with_pyth");
    assert_eq!((to.as_str(), deposit.as_yoctonear(), gas("execute_with_pyth")), (RHEA_ID, 1, Gas::from_tgas(150)));
    let actions = json!({ "actions": [
        { "DecreaseCollateral": { "token_id": NBTC, "amount": INNER_BTC } },
        { "Withdraw": { "token_id": NBTC, "max_amount": INNER_BTC } },
    ] });
    assert_eq!(args, actions);
    assert_eq!(call_of("on_lender_sent").1, json!({ "pid": null, "i": 0 }));
    // It bumps the counter and is listed for 20 blocks, in the token's own units, with the token that is leaving.
    let view = near_sdk::serde_json::to_value(a.get_state()).unwrap();
    let pending = json!([{ "lender": {
        "lender": "rhea", "kind": "withdraw", "amount": "131000000", "token": NBTC, "until_block": H0 + 21,
    } }]);
    assert_eq!((&view["pending"], &view["counter"]), (&pending, &json!(1)));
    // Rhea took the call: it stays listed.
    assert!(lender_sent(&mut a, None, 0, checked(), H0 + 3));
    assert_eq!((a.get_state().pending.len(), a.get_state().counter), (1, 1));
    // Had Rhea refused the call itself, nothing moved there: the listing goes at once, and the counter moves on.
    assert!(!lender_sent(&mut a, None, 0, PromiseResult::Failed, H0 + 3));
    assert_eq!(get_logs(), vec!["Rhea refused the withdrawal: nothing was taken back"]);
    assert_eq!((a.get_state().pending.len(), a.get_state().counter), (0, 2));
}

#[test]
fn while_the_account_owes_our_pool_lender_withdraw_needs_a_fresh_healthy_verdict_that_allows_it() {
    let mut a = lender_account(both());
    a.loan = pool_loan();
    assert_eq!(lender_withdraw_refused(&mut a, H0 + 8), "no verdict: ask for a check first");
    // The verdict must answer a lender_withdraw of this lender, token and amount.
    let other = "with a loan open, taking collateral back needs a verdict for this lender, token and amount";
    let asked = lender_withdraw_intent(131_000_000);
    assert_eq!(lender_withdraw_refused_on(Intent::Check {}, allowing(131_000_000)), other);
    assert_eq!(lender_withdraw_refused_on(withdraw_intent(NBTC, 131_000_000), allowing(131_000_000)), other);
    assert_eq!(lender_withdraw_refused_on(lender_withdraw_intent(131_000_001), allowing(131_000_001)), other);
    // The engine answers with the amount if it allows the withdrawal, and 0 if it doesn't.
    let refused = lender_withdraw_refused_on(asked.clone(), allowing(0));
    assert_eq!(refused, "the verdict doesn't allow this withdrawal");
    let mut watch = allowing(131_000_000);
    watch["state"] = json!("WATCH");
    assert_eq!(lender_withdraw_refused_on(asked.clone(), watch), "the verdict's state isn't HEALTHY");
    // A good verdict, once it is over 120 blocks old.
    assert!(deliver(&mut a, asked, &allowing(131_000_000), H0 + 6).accepted);
    let old = lender_withdraw_refused(&mut a, H0 + 5 + FRESH_BLOCKS + 1);
    assert_eq!(old, "the verdict is 121 blocks old, above the 120-block limit");
    // In time it goes out, and the verdict backs nothing more.
    at(OWNER, 1, H0 + 8);
    a.lender_withdraw("rhea".into(), NBTC.into(), U128(131_000_000)).detach();
    assert_eq!(methods(), vec!["execute_with_pyth", "on_lender_sent"]);
    assert_eq!(a.get_state().pending, vec![listed(LenderKind::Withdraw, 131_000_000, H0 + 28)]);
    assert_eq!(a.get_state().counter, 1);
    let again = lender_withdraw_refused(&mut a, H0 + 29);
    assert_eq!(again, "the verdict was already used: ask for a new check");
}

#[test]
fn with_a_loan_open_lender_withdraw_waits_as_a_withdrawal_does() {
    let ready = || {
        let mut a = lender_account(both());
        a.loan = pool_loan();
        assert!(deliver(&mut a, lender_withdraw_intent(131_000_000), &allowing(131_000_000), H0 + 6).accepted);
        a
    };
    // A signed sendAsset that could still be posted.
    let mut a = ready();
    a.hl.send_open_until_ms = U64(NOW_MS + 60_000);
    let refused = lender_withdraw_refused(&mut a, H0 + 8);
    assert!(refused.starts_with("no lender withdrawal with a loan open until 2023-11-14 22:14:20 UTC"), "{refused}");
    // An overdue transfer.
    let mut a = ready();
    a.pending.push(Pending::Transfer(Transfer::new("move:0".into(), TransferKind::ToHl, USDC, 5, DEP, 0)));
    let refused = lender_withdraw_refused(&mut a, H0 + 8);
    assert!(refused.starts_with("no lender withdrawal with a loan open while transfer move:0 is overdue"), "{refused}");
    // A borrow from our pool under way, with or without a loan yet.
    let mut a = ready();
    a.loan = Loan::default();
    a.pending.push(Pending::Borrow { amount: U128(5) });
    assert_eq!(lender_withdraw_refused(&mut a, H0 + 8), "a borrow is under way: wait for it to finish");
    // A blocked account.
    let mut a = ready();
    a.blocked = true;
    assert_eq!(lender_withdraw_refused(&mut a, H0 + 8), "this account is blocked after a default");
}

/// What `who`'s `lender_withdraw(lender, token, amount)` with `yocto` is refused with.
fn lender_withdraw_call_refused(
    a: &mut Account,
    who: &str,
    yocto: u128,
    lender: &str,
    token: &str,
    amount: u128,
) -> String {
    at(who, yocto, H0 + 1);
    refusal(|| a.lender_withdraw(lender.into(), token.into(), U128(amount)).detach())
}

#[test]
fn lender_withdraw_is_the_owners_with_1_yocto_for_usdc_or_a_collateral_token_at_rhea() {
    let mut a = lender_account(both());
    let refused = lender_withdraw_call_refused;
    assert_eq!(refused(&mut a, "keeper.testnet", 1, "rhea", NBTC, 5), "only the owner can do this");
    assert!(refused(&mut a, OWNER, 0, "rhea", NBTC, 5).contains("1 yoctoNEAR"));
    assert_eq!(refused(&mut a, OWNER, 1, "rhea", NBTC, 0), "amount must be positive");
    assert_eq!(refused(&mut a, OWNER, 1, "aave", WBTC, 5), "no Ethereum address yet: call hl_init first");
    assert_eq!(refused(&mut a, OWNER, 1, "aave", NBTC, 5), format!("{NBTC} is not one of aave's collateral tokens"));
    assert_eq!(refused(&mut a, OWNER, 1, "compound", NBTC, 5), r#"lender must be "rhea" or "aave""#);
    for token in ["other.testnet", WBTC, "Not A Token"] {
        let words = format!("{token} is not USDC or one of rhea's collateral tokens");
        assert_eq!(refused(&mut a, OWNER, 1, "rhea", token, 5), words);
    }
    let too_large = refused(&mut a, OWNER, 1, "rhea", NBTC, u128::MAX / 10);
    assert_eq!(too_large, "amount is too large for Rhea to take");
    let mut plain = account();
    assert_eq!(refused(&mut plain, OWNER, 1, "rhea", NBTC, 5), "this account has no settings for rhea");
    // Nothing a refusal touched changed.
    assert!(a.get_state().pending.is_empty() && a.get_state().counter == 0);
}

#[test]
fn usdc_a_repayment_left_at_rhea_comes_back_without_a_verdict_and_lists_nothing() {
    // It backs no loan at Rhea and comes to the account itself. So anyone may bring it back, even on a blocked
    // account that owes our pool, with a lender action under way.
    for who in [OWNER, "keeper.testnet"] {
        let mut a = borrowing_at_rhea();
        a.loan = pool_loan();
        a.blocked = true;
        at(who, 1, H0 + 16);
        a.lender_withdraw("rhea".into(), USDC.into(), U128(4_000_000_000)).detach();
        // A plain deposit needs no prices: it goes through Rhea's `execute`, with no callback.
        assert_eq!(methods(), vec!["execute"]);
        let (to, args, deposit) = call_of("execute");
        assert_eq!((to.as_str(), deposit.as_yoctonear(), gas("execute")), (RHEA_ID, 1, Gas::from_tgas(150)));
        assert_eq!(args, json!({ "actions": [{ "Withdraw": { "token_id": USDC, "max_amount": INNER_4K } }] }));
        let s = a.get_state();
        assert_eq!((s.counter, s.pending), (2, vec![listed(LenderKind::Borrow, 4_000_000_000, WAIT_ENDS)]));
    }
    // It still wants its 1 yoctoNEAR and a positive amount.
    let mut a = lender_account(both());
    let refused = lender_withdraw_call_refused;
    assert!(refused(&mut a, "keeper.testnet", 0, "rhea", USDC, 5).contains("1 yoctoNEAR"));
    assert_eq!(refused(&mut a, "keeper.testnet", 1, "rhea", USDC, 0), "amount must be positive");
}

// settle and claim_credit.

#[test]
fn anyone_has_the_pool_settle_with_the_fresh_verdicts_lender_report() {
    let mut a = lender_account(both());
    let mut v = verdict(0, H0 + 5);
    v["ext"] = json!([ext_line("aave"), ext_line("rhea")]);
    assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 6).accepted);
    at("anyone.testnet", 0, H0 + 8);
    a.settle().detach();
    assert_eq!(methods(), vec!["settle", "on_settled"]);
    let (to, args, deposit) = call_of("settle");
    assert_eq!((to.as_str(), deposit.as_yoctonear()), (POOL, 0));
    let line = |l: &str| json!({ "lender": l, "debt": "50667000000", "rate_bp": 1591, "supply_bp": 1032 });
    assert_eq!(args, json!({ "report": [line("aave"), line("rhea")] }));
    assert_eq!(call_of("on_settled").0.as_str(), ACCOUNT);
    assert_eq!((gas("settle"), gas("on_settled")), (Gas::from_tgas(30), Gas::from_tgas(10)));
    // It spends nothing: the counter stays, and the verdict still backs an action.
    assert_eq!(a.get_state().counter, 0);
    // An account with nothing at a lender reports no lines, and the pool still settles its own part.
    let mut plain = account();
    assert!(deliver(&mut plain, Intent::Check {}, &verdict(0, H0 + 5), H0 + 6).accepted);
    at("anyone.testnet", 0, H0 + 8);
    plain.settle().detach();
    assert_eq!(call_of("settle").1, json!({ "report": [] }));
}

#[test]
fn settle_needs_a_fresh_verdict_with_the_current_counter() {
    let mut a = lender_account(both());
    at("keeper.testnet", 0, H0 + 8);
    assert_eq!(refusal(|| a.settle().detach()), "no verdict: ask for a check first");
    assert!(deliver(&mut a, Intent::Check {}, &rhea_verdict(0, H0 + 5, 0), H0 + 6).accepted);
    at("keeper.testnet", 0, H0 + 5 + FRESH_BLOCKS + 1);
    assert_eq!(refusal(|| a.settle().detach()), "the verdict is 121 blocks old, above the 120-block limit");
    at(OWNER, 1, H0 + 9);
    a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach();
    at("keeper.testnet", 0, H0 + 10);
    assert_eq!(refusal(|| a.settle().detach()), "the verdict was already used: ask for a new check");
    assert!(calls().is_empty());
}

#[test]
fn a_settlements_fee_is_booked_as_debt_to_our_pool_and_a_subsidy_comes_off_it() {
    // An account that borrowed only at Rhea owes our pool nothing, until the pool charges it a fee.
    let mut a = lender_account(both());
    let fee = json!({ "fee": "680000000", "subsidy": "0", "credit": "0", "period_ns": "3600000000000" });
    assert!(settle_answered(&mut a, settled(fee)));
    assert_eq!(get_logs(), vec!["the pool settled: a fee of 680000000 and a subsidy of 0"]);
    assert_eq!(a.get_state().loan, Loan { principal: U128(680_000_000), open: true });
    // From then on it owes our pool, so a withdrawal needs a verdict.
    at(OWNER, 1, H0 + 3);
    let refused = refusal(|| a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach());
    assert_eq!(refused, "no verdict: ask for a check first");
    // A subsidy comes off the debt.
    let subsidy = json!({ "fee": "0", "subsidy": "457506", "credit": "0", "period_ns": "3600000000000" });
    assert!(settle_answered(&mut a, settled(subsidy)));
    assert_eq!(a.get_state().loan, Loan { principal: U128(679_542_494), open: true });
    // One larger than the debt takes the record to zero, never below. The loan stays open until a repayment comes
    // back unused, which shows the pool's own figure is zero too.
    let large = json!({ "fee": "0", "subsidy": "900000000", "credit": "220457506", "period_ns": "3600000000000" });
    assert!(settle_answered(&mut a, settled(large)));
    assert_eq!(a.get_state().loan, Loan { principal: U128(0), open: true });
    ctx(ACCOUNT, 0, H0 + 5, T0, vec![used(0)]);
    a.on_repaid(U128(5), a.loan_seq);
    assert_eq!(a.get_state().loan, Loan::default());
}

#[test]
fn a_skipped_failed_or_unreadable_settlement_leaves_the_loan_record_alone() {
    let mut a = with_loan();
    let before = a.get_state().loan;
    assert!(settle_answered(&mut a, skipped()));
    assert_eq!(get_logs(), vec!["the pool settled nothing: settled 10 minutes ago"]);
    assert!(!settle_answered(&mut a, PromiseResult::Failed));
    assert_eq!(get_logs(), vec!["the pool's settlement failed"]);
    // An answer the account can't read, or one over 4 KB, still counts as settled.
    let unread = "the pool settled, but its answer couldn't be read: the loan record is unchanged";
    for answer in [json!({ "fee": 5 }), json!("no"), json!({ "note": "x".repeat(5_000) })] {
        assert!(settle_answered(&mut a, settled(answer)));
        assert_eq!(get_logs(), vec![unread]);
    }
    assert_eq!(a.get_state().loan, before);
}

#[test]
fn the_owner_collects_the_accounts_credit_at_the_pool() {
    let mut a = lender_account(both());
    at(OWNER, 0, H0 + 1);
    a.claim_credit().detach();
    assert_eq!(methods(), vec!["claim_credit"]);
    let (to, _, deposit) = call_of("claim_credit");
    assert_eq!((to.as_str(), deposit.as_yoctonear(), gas("claim_credit")), (POOL, 0, Gas::from_tgas(40)));
    // The pool pays in USDC, which the account keeps as it keeps any deposit. It books nothing.
    assert_eq!((a.get_state().counter, a.get_state().loan), (0, Loan::default()));
    at("keeper.testnet", 0, H0 + 2);
    assert_eq!(refusal(|| a.claim_credit().detach()), "only the owner can do this");
    assert!(calls().is_empty());
}

// The top-up's lender steps.

#[test]
fn anyone_runs_a_top_ups_l_repay_step_which_repays_rhea_from_the_accounts_usdc() {
    // The owner has no permission in place: a top-up runs all the same.
    let mut a = with_top_up(None, json!([l_repay_step()]));
    run_step(&mut a, "anyone.testnet", PID, 0, H0 + 25);
    // The verdict that ordered it is still fresh, so the pool settles; and the account reads its USDC.
    assert_eq!(methods(), vec!["settle", "on_settled", "ft_balance_of", "on_repay_ready"]);
    assert_eq!(call_of("settle").1, json!({ "report": rhea_report() }));
    let (to, args, _) = call_of("ft_balance_of");
    assert_eq!((to.as_str(), args), (USDC, json!({ "account_id": ACCOUNT })));
    assert_eq!(call_of("on_repay_ready").1, json!({ "pid": PID, "i": 0 }));
    assert_eq!((gas("ft_balance_of"), gas("on_repay_ready")), (Gas::from_tgas(5), Gas::from_tgas(145)));
    assert_eq!(events("step_run"), vec![json!({ "pid": PID, "i": 0, "k": "l_repay" })]);
    // A repayment only lowers risk: the counter stays.
    assert!(step_done(&a, 0) && a.get_state().counter == 0);
    // The account holds $8,000, under the step's $10,133: it asks the pool for a step of $8,000, and repays it.
    assert!(repay_ready(&mut a, 0, used(8_000_000_000), H0 + 27));
    assert_eq!(methods(), vec!["check_step", "on_repay_checked"]);
    assert_eq!(call_of("on_repay_checked").1, json!({ "pid": PID, "i": 0, "amount": "8000000000" }));
    assert_eq!((gas("check_step"), gas("on_repay_checked")), (Gas::from_tgas(15), Gas::from_tgas(120)));
    assert!(repay_checked(&mut a, 0, 8_000_000_000, checked(), H0 + 28));
    assert_eq!(methods(), vec!["ft_transfer_call", "on_lender_repaid"]);
    let (to, args, deposit) = call_of("ft_transfer_call");
    assert_eq!((to.as_str(), deposit.as_yoctonear()), (USDC, 1));
    let sent = json!({ "receiver_id": RHEA_ID, "amount": "8000000000", "memo": null, "msg": "\"OnlyRepay\"" });
    assert_eq!(args, sent);
    assert_eq!((gas("ft_transfer_call"), gas("on_lender_repaid")), (Gas::from_tgas(100), Gas::from_tgas(10)));
    // With more USDC than the step asks for, it repays the step's amount.
    let mut a = with_top_up(both(), json!([l_repay_step()]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert!(repay_ready(&mut a, 0, used(50_000_000_000), H0 + 27));
    assert_eq!(call_of("check_step").1["amount"], "10133000000");
    assert!(repay_checked(&mut a, 0, 10_133_000_000, checked(), H0 + 28));
    assert_eq!(call_of("ft_transfer_call").1["amount"], "10133000000");
    // If the pool refuses the step (it is paused, or the day's steps are past its limit), nothing moves and the
    // step may run again.
    assert!(!repay_checked(&mut a, 0, 10_133_000_000, PromiseResult::Failed, H0 + 29));
    assert!(get_created_receipts().is_empty() && !step_done(&a, 0));
    let said = "step 0 of plan 1020 didn't go out, as the pool refused it: nothing was sent, and it may run again";
    assert_eq!(get_logs(), vec![said]);
}

#[test]
fn an_l_repay_step_runs_on_a_blocked_account_and_may_run_again_if_it_finds_no_usdc() {
    // A blocked account, with a lender action under way, whose verdict is spent: the step runs, and settles nothing.
    let mut a = with_top_up(both(), json!([l_repay_step()]));
    a.blocked = true;
    a.pending.push(listed(LenderKind::Borrow, 5, H0 + 40));
    a.counter = 1;
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert_eq!(methods(), vec!["ft_balance_of", "on_repay_ready"]);
    let cases =
        [(used(0), "the account holds no USDC yet"), (PromiseResult::Failed, "the account's USDC couldn't be read")];
    for (balance, why) in cases {
        a.plan.as_mut().unwrap().steps[0].done = true;
        assert!(!repay_ready(&mut a, 0, balance, H0 + 27));
        let log = format!("step 0 of plan 1020 didn't go out, as {why}: nothing was sent, and it may run again");
        assert_eq!(get_logs(), vec![log]);
        assert!(get_created_receipts().is_empty() && !step_done(&a, 0));
    }
    // If a newer plan replaced this one meanwhile, nothing moves.
    let newer = rebalance(1, H0 + 26, json!([repay_step()]));
    assert!(deliver(&mut a, Intent::Check {}, &newer, H0 + 27).accepted);
    assert!(!repay_ready(&mut a, 0, used(5), H0 + 28));
    assert_eq!(get_logs(), vec!["plan 1020 was replaced before step 0 went out: nothing was sent"]);
    assert!(get_created_receipts().is_empty());
}

#[test]
fn anyone_runs_a_top_ups_l_add_step_which_posts_spare_collateral_at_rhea() {
    // No permission, and no loan from our pool, so it needs no verdict: this one is spent.
    let mut a = with_top_up(None, json!([l_add_step()]));
    a.counter = 5;
    run_step(&mut a, "anyone.testnet", PID, 0, H0 + 25);
    // The pool is asked first, as for a transfer step. Once it has taken the step, the collateral goes to Rhea.
    assert_eq!(methods(), vec!["check_step", "on_add_ready"]);
    let ready = json!({ "pid": PID, "i": 0, "token": NBTC, "amount": "5000000" });
    assert_eq!(call_of("on_add_ready").1, ready);
    assert_eq!((gas("check_step"), gas("on_add_ready")), (Gas::from_tgas(15), Gas::from_tgas(130)));
    assert_eq!(events("step_run"), vec![json!({ "pid": PID, "i": 0, "k": "l_add" })]);
    assert!(add_ready(&mut a, PID, checked(), H0 + 26));
    assert_eq!(methods(), vec!["storage_deposit", "ft_transfer_call", "on_supplied"]);
    let (to, args, deposit) = call_of("ft_transfer_call");
    assert_eq!((to.as_str(), deposit.as_yoctonear()), (NBTC, 1));
    let sent =
        json!({ "receiver_id": RHEA_ID, "amount": "5000000", "memo": null, "msg": "\"OnlyIncreaseCollateral\"" });
    assert_eq!(args, sent);
    assert_eq!(call_of("on_supplied").1, json!({ "pid": PID, "i": 0, "amount": "5000000" }));
    // Like a withdrawal, it bumps the counter.
    assert!(step_done(&a, 0) && a.get_state().counter == 6);
    // Rhea took none: the step may run again. Then Rhea took it all.
    assert_eq!(supplied(&mut a, PID, 0, 5_000_000, used(0), H0 + 27), 0);
    assert!(!step_done(&a, 0) && a.get_state().counter == 7);
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 28);
    assert!(add_ready(&mut a, PID, checked(), H0 + 29));
    assert_eq!(supplied(&mut a, PID, 0, 5_000_000, used(5_000_000), H0 + 30), 5_000_000);
    assert!(step_done(&a, 0) && a.rhea_registered && a.get_state().counter == 9);
    // If the pool refuses the step, nothing goes to Rhea and the step may run again.
    a.plan.as_mut().unwrap().steps[0].done = true;
    assert!(!add_ready(&mut a, PID, PromiseResult::Failed, H0 + 31));
    assert!(get_created_receipts().is_empty() && !step_done(&a, 0));
    let said = "step 0 of plan 1020 didn't go out, as the pool refused it: nothing was sent, and it may run again";
    assert_eq!(get_logs(), vec![said]);
}

#[test]
fn an_l_add_step_runs_only_while_the_held_verdict_is_the_one_that_ordered_it() {
    let mut a = lender_account(both());
    a.loan = pool_loan();
    assert!(deliver(&mut a, Intent::Check {}, &rebalance(0, H0 + 20, json!([l_add_step()])), H0 + 21).accepted);
    // A later check orders nothing. The account isn't HEALTHY, so the plan stays stored. That verdict is fresh and
    // carries the current counter, but it is not the reading that wanted the top-up.
    let mut watch = verdict(0, H0 + 22);
    watch["state"] = json!("WATCH");
    assert!(deliver(&mut a, Intent::Check {}, &watch, H0 + 23).accepted);
    assert_eq!(a.get_state().plan.unwrap().pid, PID);
    let stale = "step 0 of plan 1020 can't run: the latest check, read at block 1022, is not the one that ordered it";
    assert_eq!(step_refused(&mut a, PID, 0, H0 + 25, time(H0 + 25)), stale);
    // The same holds with no loan from our pool, where the step needs no fresh verdict.
    a.loan = Loan::default();
    assert_eq!(step_refused(&mut a, PID, 0, H0 + 25, time(H0 + 25)), stale);
    assert!(!step_done(&a, 0) && a.get_state().counter == 0);
    // A new check that orders the top-up again keeps the stored plan (research/audit.md, A15), and its step runs
    // under that check.
    a.loan = pool_loan();
    assert!(deliver(&mut a, Intent::Check {}, &rebalance(0, H0 + 26, json!([l_add_step()])), H0 + 27).accepted);
    assert_eq!(a.get_state().plan.unwrap().pid, PID);
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 28);
    assert_eq!(methods(), vec!["check_step", "on_add_ready"]);
    assert!(add_ready(&mut a, PID, checked(), H0 + 29));
    assert_eq!(call_of("on_supplied").1, json!({ "pid": PID, "i": 0, "amount": "5000000" }));
    // A repayment is never held back: an old plan's l_repay still runs under a later verdict.
    let mut a = with_top_up(both(), json!([l_repay_step()]));
    assert!(deliver(&mut a, Intent::Check {}, &watch, H0 + 23).accepted);
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert!(methods().contains(&"on_repay_ready".to_string()));
}

#[test]
fn while_the_account_owes_our_pool_an_l_add_step_needs_a_fresh_verdict_with_the_current_counter_in_any_state() {
    let mut a = lender_account(both());
    a.loan = pool_loan();
    // The verdict that ordered the top-up says WATCH.
    let mut v = rebalance(0, H0 + 20, json!([l_add_step()]));
    v["state"] = json!("WATCH");
    assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 21).accepted);
    let old = step_refused(&mut a, PID, 0, H0 + 141, time(H0 + 141));
    assert_eq!(old, "the verdict is 121 blocks old, above the 120-block limit");
    // Never while a borrow from our pool is under way, or on a blocked account.
    a.pending.push(Pending::Borrow { amount: U128(5) });
    let refused = step_refused(&mut a, PID, 0, H0 + 25, time(H0 + 25));
    assert_eq!(refused, "a borrow is under way: wait for it to finish");
    a.pending.clear();
    a.blocked = true;
    let refused = step_refused(&mut a, PID, 0, H0 + 25, time(H0 + 25));
    assert_eq!(refused, "this account is blocked after a default");
    a.blocked = false;
    assert!(!step_done(&a, 0) && a.get_state().counter == 0);
    // In time it runs, in any state, through a lender wait, an overdue transfer and an open send window: a top-up
    // only keeps the lender from selling.
    a.pending.push(listed(LenderKind::Borrow, 5, H0 + 40));
    a.pending.push(Pending::Transfer(Transfer::new("move:0".into(), TransferKind::ToHl, USDC, 5, DEP, 0)));
    a.hl.send_open_until_ms = U64(NOW_MS + 60_000);
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert_eq!(methods(), vec!["check_step", "on_add_ready"]);
    assert_eq!(a.get_state().counter, 1);
    // That verdict is spent now: after a posting, or anything else that moved the counter, a new check comes first.
    a.plan.as_mut().unwrap().steps[0].done = false;
    let refused = step_refused(&mut a, PID, 0, H0 + 26, time(H0 + 26));
    assert_eq!(refused, "the verdict was already used: ask for a new check");
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 6, stage 3: Aave through Chain Signatures. The Ethereum transactions the account signs, the steps and the
// direct calls at Aave, and the signed transaction that counts as done until a verdict has seen it mined
// (INTERFACES.md 33; FUNDING.md 4.5)
// ---------------------------------------------------------------------------------------------------------------

const WETH: &str = "0x4200000000000000000000000000000000000006";
const AAVE_POOL: &str = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
/// 0.02 WETH, in WETH's 18 decimals.
const WETH_AMOUNT: u128 = 20_000_000_000_000_000;
/// The account's fee limit in these tests: 1 gwei, as on testnet. A first try offers half of it.
const MAX_FEE: u128 = 1_000_000_000;
const FIRST_FEE: u128 = MAX_FEE / 2;

fn evm_address(text: &str) -> Address {
    parse_evm_address(text).unwrap()
}

/// A lender account with both lenders permitted, whose Aave settings list WBTC and WETH with a fee limit of 1 gwei,
/// and whose Ethereum address is known: it is its Hyperliquid address.
fn aave_account() -> Account {
    at("pbf.testnet", 0, H0);
    let mut lenders = lenders();
    let aave = lenders.aave.as_mut().unwrap();
    aave.collateral.push(pb_types::EvmToken { symbol: "WETH".into(), address: WETH.into(), decimals: 18 });
    aave.max_fee_per_gas = U128(MAX_FEE);
    let mut a = Account::new(id(OWNER), Config { lenders, ..config() }, both());
    assert_eq!(give_key(&mut a, KEY).as_deref(), Some(ADDRESS));
    a
}

/// The transaction the account builds for this kind: Base Sepolia, half the config's fee limit and a tip of
/// 1,000,000 wei.
fn evm_tx(nonce: u64, kind: EvmKind, to: &str, data: Vec<u8>) -> EvmTx {
    let (tip, max_fee, gas_limit) = (TIP_WEI, FIRST_FEE, kind.gas_limit());
    EvmTx { chain_id: 84532, nonce, tip, max_fee, gas_limit, to: evm_address(to), data }
}

/// Checks that the last call asked the signer, with the account's key path and 1 yoctoNEAR, to sign exactly `tx`,
/// and that the answer goes to `on_evm_signed`.
fn assert_asked_to_sign(tx: &EvmTx) {
    let (to, args, deposit) = call_of("sign");
    assert_eq!((to.as_str(), deposit.as_yoctonear()), (MPC, 1));
    let request = json!({
        "path": "hyperliquid-1", "payload_v2": { "Ecdsa": hex(&tx.signing_hash()) }, "domain_id": 0,
    });
    assert_eq!(args, json!({ "request": request }));
    let (to, args, _) = call_of("on_evm_signed");
    assert_eq!((to.as_str(), args), (ACCOUNT, json!({ "digest": hex(&tx.signing_hash()) })));
    assert_eq!((gas("sign"), gas("on_evm_signed")), (Gas::from_tgas(50), Gas::from_tgas(20)));
}

/// The signer's answer to the Ethereum transaction under way arrives at `height`.
fn evm_signed(a: &mut Account, result: PromiseResult, height: u64) -> Option<EvmSignedView> {
    let digest = a.evm.signing.as_ref().map(|signing| hex(&signing.tx.signing_hash())).unwrap_or_default();
    ctx(ACCOUNT, 0, height, time(height), vec![result]);
    a.on_evm_signed(digest)
}

/// The signature in the signer's real answer (`SIGNER_ANSWER`), as a transaction carries it.
fn real_signature() -> EvmSignature {
    EvmSignature::from_signer(&hl_signature(SIGNER_ANSWER.as_bytes()).unwrap()).unwrap()
}

/// What `get_state().evm.signed` shows for `tx` once the signer's real answer has signed it.
fn kept_as(tx: &EvmTx, kind: &str, token: &str, amount: u128, step: Value, height: u64) -> Value {
    let raw = tx.raw(&real_signature());
    json!({
        "nonce": tx.nonce, "kind": kind, "token": token.to_lowercase(), "amount": amount.to_string(),
        "to": address_text(&tx.to), "raw": format!("0x{}", hex(&raw)), "hash": format!("0x{}", hex(&tx_hash(&raw))),
        "step": step, "signed_at": time(height).to_string(),
    })
}

fn evm_view(a: &Account) -> Value {
    near_sdk::serde_json::to_value(a.get_state()).unwrap()["evm"].clone()
}

fn pending_view(a: &Account) -> Value {
    near_sdk::serde_json::to_value(a.get_state()).unwrap()["pending"].clone()
}

/// A lender action at Aave, listed until a verdict shows the chain has used `nonce`.
fn listed_at_aave(kind: LenderKind, amount: u128, token: &str, nonce: u64) -> Pending {
    let (lender, token) = ("aave".to_string(), Some(token.to_lowercase()));
    let amount = U128(amount);
    Pending::Lender(LenderAction { lender, kind, amount, token, until_block: None, evm_nonce: Some(nonce) })
}

/// A HEALTHY check verdict whose `ext` shows a $50,667 loan at Aave and gives Aave `room` more, and whose reading of
/// Aave's chain found `chain_nonce` as the address's next nonce.
fn aave_verdict(nonce: u64, blk: u64, room: u128, chain_nonce: u64) -> Value {
    let mut v = verdict(nonce, blk);
    v["ext"] = json!([ext_line("aave")]);
    v["ext"][0]["room"] = json!(room as u64);
    v["evm"] = json!({ "nonce": chain_nonce });
    v
}

/// Aave lends $4,000 against 0.02 WETH posted there, and our pool the other $6,000.
fn aave_steps() -> Value {
    let supply = json!({ "k": "l_supply", "l": "aave", "tok": WETH, "amt": WETH_AMOUNT.to_string() });
    json!([supply, l_borrow("aave", 4_000_000_000), p_borrow(6_000_000_000)])
}

/// An Aave account with that funding plan, stored at H0 + 8. Its counter is 1.
fn funded_at_aave() -> Account {
    let mut a = aave_account();
    fund_with(&mut a, aave_steps());
    a
}

/// `funded_at_aave` once its collateral is signed for (Ethereum nonce 0, counter 3), holding a fresh verdict that
/// gives Aave $4,000 of room.
fn ready_for_aave() -> Account {
    let mut a = funded_at_aave();
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 9);
    assert!(evm_signed(&mut a, signed_ok(), H0 + 10).is_some());
    assert!(deliver(&mut a, Intent::Check {}, &aave_verdict(3, H0 + 11, 4_000_000_000, 0), H0 + 12).accepted);
    a
}

/// `ready_for_aave` once its `l_borrow` step has run and the signer has signed the borrow (Ethereum nonce 1): the
/// borrow is listed until a verdict has seen that nonce used. The counter is 4.
fn borrowing_at_aave() -> Account {
    let mut a = ready_for_aave();
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 13);
    ctx(ACCOUNT, 0, H0 + 15, time(H0 + 15), vec![skipped()]);
    let asked = a.on_step_settled(FID.into(), 1, "aave".into(), U128(4_000_000_000));
    assert!(matches!(asked, PromiseOrValue::Promise(_)));
    assert!(evm_signed(&mut a, signed_ok(), H0 + 16).is_some());
    a
}

// evm_approve.

#[test]
fn anyone_has_the_approval_of_a_token_signed_once() {
    let mut a = aave_account();
    assert_eq!(evm_view(&a), json!({ "nonce": 0, "signed": [], "approved": [] }));
    at("anyone.testnet", 0, H0 + 1);
    a.evm_approve(WETH.into()).detach();
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
    // approve(Aave's Pool, the largest amount), sent to the token, with the account's first nonce there.
    let tx = evm_tx(0, EvmKind::Approve, WETH, approve_data(&evm_address(AAVE_POOL)));
    assert_asked_to_sign(&tx);
    // Nothing is kept until the signer answers, and it needs no verdict and lists nothing.
    assert_eq!(evm_view(&a), json!({ "nonce": 0, "signed": [], "approved": [] }));
    let entry = evm_signed(&mut a, signed_ok(), H0 + 3).expect("nothing was signed");
    let kept = kept_as(&tx, "approve", WETH, 0, Value::Null, H0 + 3);
    assert_eq!(near_sdk::serde_json::to_value(&entry).unwrap(), kept);
    let logged = json!({ "nonce": 0, "kind": "approve", "hash": kept["hash"] });
    assert_eq!(events("evm_signed"), vec![logged]);
    // The view also lists the token as approved, which tells a caller that a supply or a repayment can go out.
    assert_eq!(evm_view(&a), json!({ "nonce": 1, "signed": [kept], "approved": [WETH] }));
    let s = a.get_state();
    assert_eq!((s.counter, s.pending.len()), (0, 0));
    // A stranger can't have it signed twice; the owner can, and so can anyone for another token.
    at("anyone.testnet", 0, H0 + 4);
    let again = refusal(|| a.evm_approve(WETH.to_uppercase().replace("0X", "0x")).detach());
    assert!(again.ends_with("is signed already: only the owner can have it signed again"), "{again}");
    at("anyone.testnet", 0, H0 + 4);
    a.evm_approve(AAVE_USDC.into()).detach();
    assert_asked_to_sign(&evm_tx(1, EvmKind::Approve, AAVE_USDC, approve_data(&evm_address(AAVE_POOL))));
    assert!(evm_signed(&mut a, signed_ok(), H0 + 5).is_some());
    at(OWNER, 0, H0 + 6);
    a.evm_approve(WETH.into()).detach();
    assert_asked_to_sign(&evm_tx(2, EvmKind::Approve, WETH, approve_data(&evm_address(AAVE_POOL))));
    // Each token is listed once, in the order it was first approved.
    assert!(evm_signed(&mut a, signed_ok(), H0 + 7).is_some());
    assert_eq!(evm_view(&a)["approved"], json!([WETH, AAVE_USDC.to_lowercase()]));
}

#[test]
fn an_approval_is_for_one_of_the_aave_settings_tokens_on_an_account_with_an_ethereum_address() {
    let mut a = aave_account();
    for token in ["0x0000000000000000000000000000000000000001", NBTC, "weth"] {
        at("anyone.testnet", 0, H0 + 1);
        let refused = refusal(|| a.evm_approve(token.into()).detach());
        assert_eq!(refused, format!("{token} is not USDC or one of aave's collateral tokens"));
    }
    let mut no_address = lender_account(both());
    at("anyone.testnet", 0, H0 + 1);
    let refused = refusal(|| no_address.evm_approve(WBTC.into()).detach());
    assert_eq!(refused, "no Ethereum address yet: call hl_init first");
    let mut plain = account();
    at("anyone.testnet", 0, H0 + 1);
    assert_eq!(refusal(|| plain.evm_approve(WBTC.into()).detach()), "this account has no settings for aave");
    assert!(calls().is_empty());
}

#[test]
fn one_ethereum_transaction_is_signed_at_a_time_so_each_takes_its_own_nonce() {
    let mut a = aave_account();
    at("anyone.testnet", 0, H0 + 1);
    a.evm_approve(WETH.into()).detach();
    // Until the signer answers, nothing else is signed: not another approval, a repayment or a withdrawal.
    let busy = "Ethereum transaction 0 is being signed: wait for the signer's answer";
    at("anyone.testnet", 0, H0 + 2);
    assert_eq!(refusal(|| a.evm_approve(WBTC.into()).detach()), busy);
    at(OWNER, 1, H0 + 2);
    assert_eq!(refusal(|| a.lender_repay("aave".into(), U128(5)).detach()), busy);
    at(OWNER, 1, H0 + 2);
    assert_eq!(refusal(|| a.lender_withdraw("aave".into(), WETH.into(), U128(5)).detach()), busy);
    at(OWNER, 1, H0 + 2);
    let to = "0x2031181d63507368232579af4c64a1c3428407ff";
    assert_eq!(refusal(|| a.evm_withdraw(WETH.into(), U128(5), to.into(), None, None).detach()), busy);
    assert_eq!((a.get_state().counter, a.get_state().pending.len()), (0, 0));
    // The signer times out within 200 blocks. If its answer never reached the account, the next transaction may be
    // signed 250 blocks on, with the nonce that was never used.
    at("anyone.testnet", 0, H0 + 1 + SIGNING_BLOCKS);
    assert_eq!(refusal(|| a.evm_approve(WBTC.into()).detach()), busy);
    at("anyone.testnet", 0, H0 + 2 + SIGNING_BLOCKS);
    a.evm_approve(WBTC.into()).detach();
    assert_asked_to_sign(&evm_tx(0, EvmKind::Approve, WBTC, approve_data(&evm_address(AAVE_POOL))));
}

#[test]
fn a_failed_or_malformed_signature_keeps_no_transaction_and_uses_no_nonce() {
    let bad =
        PromiseResult::Successful(br#"{"big_r":{"affine_point":"04ab"},"s":{"scalar":"00"},"recovery_id":0}"#.to_vec());
    for answer in [PromiseResult::Failed, bad] {
        let mut a = aave_account();
        at("anyone.testnet", 0, H0 + 1);
        a.evm_approve(WETH.into()).detach();
        assert_eq!(evm_signed(&mut a, answer, H0 + 3), None);
        assert!(get_logs()[0].starts_with("no Ethereum transaction signed, as "), "{:?}", get_logs());
        assert!(events("evm_signed").is_empty());
        assert_eq!(evm_view(&a), json!({ "nonce": 0, "signed": [], "approved": [] }));
        // The signer is free again, and the next transaction takes the nonce that wasn't used.
        at("anyone.testnet", 0, H0 + 4);
        a.evm_approve(WETH.into()).detach();
        assert_asked_to_sign(&evm_tx(0, EvmKind::Approve, WETH, approve_data(&evm_address(AAVE_POOL))));
    }
    // An answer with no transaction waiting for it changes nothing.
    let mut a = aave_account();
    assert_eq!(evm_signed(&mut a, signed_ok(), H0 + 3), None);
    assert_eq!(get_logs(), vec!["no Ethereum transaction was waiting for this signature"]);
}

#[test]
fn an_answer_that_comes_after_the_account_moved_on_is_never_taken_for_the_next_transactions() {
    // The first approval's answer never reached the account, and 250 blocks on a second one is being signed.
    let mut a = aave_account();
    at("anyone.testnet", 0, H0 + 1);
    a.evm_approve(WETH.into()).detach();
    let first = hex(&a.evm.signing.as_ref().unwrap().tx.signing_hash());
    at("anyone.testnet", 0, H0 + 2 + SIGNING_BLOCKS);
    a.evm_approve(WBTC.into()).detach();
    let second = a.evm.signing.clone();
    assert_ne!(first, hex(&second.as_ref().unwrap().tx.signing_hash()));
    // Now the first one's answer arrives. It is a signature of another transaction, so nothing is kept for it and
    // the second is still under way.
    ctx(ACCOUNT, 0, H0 + 3 + SIGNING_BLOCKS, time(H0 + 3 + SIGNING_BLOCKS), vec![signed_ok()]);
    assert_eq!(a.on_evm_signed(first), None);
    assert_eq!(get_logs(), vec!["no Ethereum transaction was waiting for this signature"]);
    assert_eq!((a.evm.signing.clone(), evm_view(&a)), (second, json!({ "nonce": 0, "signed": [], "approved": [] })));
    let entry = evm_signed(&mut a, signed_ok(), H0 + 4 + SIGNING_BLOCKS).expect("nothing was signed");
    assert_eq!((entry.nonce, entry.token.as_str()), (0, WBTC.to_lowercase().as_str()));
}

#[test]
fn an_answer_the_account_cannot_read_keeps_the_action_listed_as_a_signature_may_exist() {
    let unread = || {
        PromiseResult::Successful(br#"{"big_r":{"affine_point":"04ab"},"s":{"scalar":"00"},"recovery_id":0}"#.to_vec())
    };
    let mut a = aave_account();
    at(OWNER, 1, H0 + 1);
    a.lender_withdraw("aave".into(), WETH.into(), U128(WETH_AMOUNT)).detach();
    assert_eq!(evm_signed(&mut a, unread(), H0 + 3), None);
    let logs = get_logs();
    assert!(logs[0].starts_with("no Ethereum transaction signed, as big_r 04ab is not"), "{logs:?}");
    assert_eq!(logs[1], "the signer did answer, so transaction 0 still counts until a check shows its nonce used");
    // Nothing is kept and the nonce stays free, but the withdrawal stays listed and the counter stays.
    let first = listed_at_aave(LenderKind::Withdraw, WETH_AMOUNT, WETH, 0);
    assert_eq!(evm_view(&a), json!({ "nonce": 0, "signed": [], "approved": [] }));
    assert_eq!((a.get_state().pending, a.get_state().counter), (vec![first.clone()], 1));
    // The next transaction takes the same nonce, so only one of the two can ever be mined. If the signer's call
    // for it fails, only its own listing goes.
    at(OWNER, 1, H0 + 4);
    a.lender_withdraw("aave".into(), WBTC.into(), U128(5)).detach();
    let second = listed_at_aave(LenderKind::Withdraw, 5, WBTC, 0);
    assert_eq!((a.get_state().pending, a.get_state().counter), (vec![first.clone(), second], 2));
    assert_eq!(evm_signed(&mut a, PromiseResult::Failed, H0 + 6), None);
    assert_eq!((a.get_state().pending, a.get_state().counter), (vec![first.clone()], 3));
    // Nor does a failed signature of a kind that lists nothing drop it.
    at("anyone.testnet", 0, H0 + 7);
    a.evm_approve(WETH.into()).detach();
    assert_eq!(evm_signed(&mut a, PromiseResult::Failed, H0 + 8), None);
    assert_eq!((a.get_state().pending, a.get_state().counter), (vec![first], 3));
    // A verdict that has seen nonce 0 used ends it.
    assert!(deliver(&mut a, Intent::Check {}, &aave_verdict(3, H0 + 9, 0, 1), H0 + 10).accepted);
    assert_eq!((a.get_state().pending.len(), a.get_state().counter), (0, 4));
}

// The funding plan's steps at Aave.

#[test]
fn an_l_supply_step_at_aave_signs_the_supply_and_bumps_the_counter_as_rheas_does() {
    let mut a = funded_at_aave();
    run_step(&mut a, "anyone.testnet", FID, 0, H0 + 9);
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
    // supply(WETH, 0.02 WETH in its 18 decimals, the account's own address, 0), sent to Aave's Pool.
    let (weth, me) = (evm_address(WETH), evm_address(ADDRESS));
    let tx = evm_tx(0, EvmKind::Supply, AAVE_POOL, supply_data(&weth, WETH_AMOUNT, &me));
    assert_asked_to_sign(&tx);
    assert_eq!(events("step_run"), vec![json!({ "pid": FID, "i": 0, "k": "l_supply" })]);
    // With no loan from our pool it needed no verdict. It bumps the counter and lists nothing: a supply moves the
    // token from the account's address into its own collateral.
    let s = a.get_state();
    assert_eq!((s.counter, s.pending.len()), (2, 0));
    assert!(fund_step_done(&a, 0));
    // The signed transaction is kept with its step, and the counter moves on again.
    let entry = evm_signed(&mut a, signed_ok(), H0 + 11).expect("nothing was signed");
    let kept = kept_as(&tx, "supply", WETH, WETH_AMOUNT, json!("f1005:0"), H0 + 11);
    assert_eq!(near_sdk::serde_json::to_value(&entry).unwrap(), kept);
    assert_eq!(events("evm_signed"), vec![json!({ "nonce": 0, "kind": "supply", "hash": kept["hash"] })]);
    assert_eq!(evm_view(&a), json!({ "nonce": 1, "signed": [kept], "approved": [] }));
    assert_eq!((a.get_state().counter, a.get_state().pending.len()), (3, 0));
    assert!(fund_step_done(&a, 0));
}

#[test]
fn an_l_supply_step_the_signer_did_not_sign_may_run_again() {
    let mut a = funded_at_aave();
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 9);
    assert_eq!(evm_signed(&mut a, PromiseResult::Failed, H0 + 11), None);
    let logs = get_logs();
    assert_eq!(logs[0], "no Ethereum transaction signed, as the MPC signer failed or timed out");
    assert_eq!(logs[1], "step 0 of plan f1005 didn't go out: nothing was signed, and it may run again");
    assert!(!fund_step_done(&a, 0));
    assert_eq!((a.get_state().counter, evm_view(&a)), (3, json!({ "nonce": 0, "signed": [], "approved": [] })));
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 12);
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
}

#[test]
fn while_the_account_owes_our_pool_an_l_supply_step_at_aave_needs_a_fresh_healthy_verdict() {
    let mut a = funded_at_aave();
    a.loan = pool_loan();
    let refused = step_refused(&mut a, FID, 0, H0 + 9, time(H0 + 9));
    assert_eq!(refused, "the verdict was already used: ask for a new check");
    let mut watch = verdict(1, H0 + 10);
    watch["state"] = json!("WATCH");
    assert!(deliver(&mut a, Intent::Check {}, &watch, H0 + 11).accepted);
    assert_eq!(step_refused(&mut a, FID, 0, H0 + 12, time(H0 + 12)), "the verdict's state isn't HEALTHY");
    assert!(!fund_step_done(&a, 0) && a.get_state().counter == 1 && a.evm.signing.is_none());
    assert!(deliver(&mut a, Intent::Check {}, &verdict(1, H0 + 13), H0 + 14).accepted);
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 15);
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
}

#[test]
fn an_l_borrow_step_at_aave_settles_first_with_the_debt_plus_the_borrow_and_lists_the_borrow() {
    let mut a = ready_for_aave();
    run_step(&mut a, "anyone.testnet", FID, 1, H0 + 13);
    // The pool settles first, as for Rhea: Aave's debt in the report is the verdict's $50,667 plus this $4,000, and
    // the period up to now closes on the $50,667.
    assert_eq!(methods(), vec!["settle", "on_step_settled"]);
    let line = |debt: &str| json!([{ "lender": "aave", "debt": debt, "rate_bp": 1591, "supply_bp": 1032 }]);
    assert_eq!(call_of("settle").1, json!({ "report": line("54667000000"), "closes": line("50667000000") }));
    let settled = json!({ "pid": FID, "i": 1, "lender": "aave", "amount": "4000000000" });
    assert_eq!(call_of("on_step_settled").1, settled);
    assert_eq!(events("step_run"), vec![json!({ "pid": FID, "i": 1, "k": "l_borrow" })]);
    // The borrow is listed from this moment with the nonce its transaction will carry, and no last block: only a
    // verdict that has seen that nonce used ends it.
    let pending = json!([{ "lender": {
        "lender": "aave", "kind": "borrow", "amount": "4000000000", "token": AAVE_USDC.to_lowercase(), "evm_nonce": 1,
    } }]);
    assert_eq!(pending_view(&a), pending);
    assert_eq!((a.get_state().counter, a.get_state().loan), (4, Loan::default()));
    assert!(fund_step_done(&a, 1));
    // The signer is kept for this borrow meanwhile, so its nonce can't go to another transaction.
    at("anyone.testnet", 0, H0 + 14);
    let busy = refusal(|| a.evm_approve(AAVE_USDC.into()).detach());
    assert_eq!(busy, "Ethereum transaction 1 is being signed: wait for the signer's answer");

    // Once the pool has settled, the signer signs borrow(USDC, $4,000, the variable rate, 0, the account's own).
    ctx(ACCOUNT, 0, H0 + 15, time(H0 + 15), vec![skipped()]);
    let asked = a.on_step_settled(FID.into(), 1, "aave".into(), U128(4_000_000_000));
    assert!(matches!(asked, PromiseOrValue::Promise(_)));
    drop(asked);
    let (usdc, me) = (evm_address(AAVE_USDC), evm_address(ADDRESS));
    let tx = evm_tx(1, EvmKind::Borrow, AAVE_POOL, borrow_data(&usdc, 4_000_000_000, &me));
    assert_asked_to_sign(&tx);
    let entry = evm_signed(&mut a, signed_ok(), H0 + 16).expect("nothing was signed");
    let kept = kept_as(&tx, "borrow", AAVE_USDC, 4_000_000_000, json!("f1005:1"), H0 + 16);
    assert_eq!(near_sdk::serde_json::to_value(&entry).unwrap(), kept);
    assert_eq!(evm_view(&a)["nonce"], 2);
    assert_eq!(evm_view(&a)["signed"][1], kept);
    // The account books no loan of Aave's, and the borrow stays listed: signed is as good as sent.
    assert_eq!(pending_view(&a), pending);
    assert_eq!((a.get_state().counter, a.get_state().loan), (4, Loan::default()));
}

#[test]
fn if_the_pools_settlement_or_the_signature_fails_no_borrow_is_signed_and_the_step_may_run_again() {
    // The pool's settlement fails: the signer is never asked.
    let mut a = ready_for_aave();
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 13);
    ctx(ACCOUNT, 0, H0 + 15, time(H0 + 15), vec![PromiseResult::Failed]);
    let asked = a.on_step_settled(FID.into(), 1, "aave".into(), U128(4_000_000_000));
    assert!(matches!(asked, PromiseOrValue::Value(false)));
    assert!(get_created_receipts().is_empty(), "the signer was asked");
    let logs = get_logs();
    assert_eq!(logs[1], "no Ethereum transaction signed, as the pool's settlement failed");
    assert_eq!(logs[2], "step 1 of plan f1005 didn't go out: nothing was signed, and it may run again");
    let s = a.get_state();
    assert_eq!((s.counter, s.pending.len(), evm_view(&a)["nonce"].clone()), (5, 0, json!(1)));
    assert!(!fund_step_done(&a, 1) && a.evm.signing.is_none());

    // The account was blocked while the pool settled: the same.
    let mut a = ready_for_aave();
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 13);
    a.blocked = true;
    ctx(ACCOUNT, 0, H0 + 15, time(H0 + 15), vec![skipped()]);
    let asked = a.on_step_settled(FID.into(), 1, "aave".into(), U128(4_000_000_000));
    assert!(matches!(asked, PromiseOrValue::Value(false)));
    assert!(get_created_receipts().is_empty(), "the signer was asked");
    assert!(get_logs().contains(&"no Ethereum transaction signed, as the account can't borrow now".to_string()));
    assert!(a.get_state().pending.is_empty() && a.evm.signing.is_none() && !fund_step_done(&a, 1));

    // The signer gives no signature: the same, and the nonce stays free for the next transaction.
    let mut a = ready_for_aave();
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 13);
    ctx(ACCOUNT, 0, H0 + 15, time(H0 + 15), vec![skipped()]);
    drop(a.on_step_settled(FID.into(), 1, "aave".into(), U128(4_000_000_000)));
    assert_eq!(evm_signed(&mut a, PromiseResult::Failed, H0 + 16), None);
    let s = a.get_state();
    assert_eq!((s.counter, s.pending.len(), evm_view(&a)["nonce"].clone()), (5, 0, json!(1)));
    assert!(!fund_step_done(&a, 1));
    // It runs again on a new verdict for the counter as it is now.
    assert!(deliver(&mut a, Intent::Check {}, &aave_verdict(5, H0 + 17, 4_000_000_000, 1), H0 + 18).accepted);
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 19);
    assert_eq!(methods(), vec!["settle", "on_step_settled"]);
}

#[test]
fn an_l_borrow_step_at_aave_borrows_no_more_than_the_room_the_verdict_gives_aave() {
    let mut a = funded_at_aave();
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 9);
    assert!(evm_signed(&mut a, signed_ok(), H0 + 10).is_some());
    // A verdict that gives room at Rhea only is no room at Aave.
    assert!(deliver(&mut a, Intent::Check {}, &rhea_verdict(3, H0 + 11, 4_000_000_000), H0 + 12).accepted);
    let refused = step_refused(&mut a, FID, 1, H0 + 13, time(H0 + 13));
    assert_eq!(refused, "the verdict leaves no room to borrow at Aave now");
    assert!(a.evm.signing.is_none() && a.get_state().pending.is_empty());
    assert!(deliver(&mut a, Intent::Check {}, &aave_verdict(3, H0 + 14, 2_500_000_000, 0), H0 + 15).accepted);
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 16);
    assert_eq!(call_of("on_step_settled").1["amount"], "2500000000");
    assert_eq!(a.get_state().pending, vec![listed_at_aave(LenderKind::Borrow, 2_500_000_000, AAVE_USDC, 1)]);
}

// The signed transaction that counts as done.

#[test]
fn while_a_signed_aave_transaction_is_not_seen_mined_nothing_that_adds_risk_runs() {
    let mut a = borrowing_at_aave();
    a.loan = pool_loan();
    let wait = "until a check shows Ethereum transaction 1 mined: a borrow at aave is still under way";
    // No block ends this wait: a signed transaction can be sent at any time.
    for height in [H0 + 17, H0 + 5_000] {
        at(OWNER, 1, height);
        assert_eq!(refusal(|| a.borrow(U128(5)).detach()), format!("no borrow {wait}"));
        at(OWNER, 1, height);
        let refused = refusal(|| a.withdraw(id(NBTC), U128(5), id(OWNER), None).detach());
        assert_eq!(refused, format!("no withdrawal with a loan open {wait}"));
        at(OWNER, 1, height);
        let refused = refusal(|| a.lender_withdraw("aave".into(), WETH.into(), U128(5)).detach());
        assert_eq!(refused, format!("no lender withdrawal {wait}"));
        at(OWNER, 1, height);
        let refused = refusal(|| a.lender_withdraw("rhea".into(), NBTC.into(), U128(5)).detach());
        assert_eq!(refused, format!("no lender withdrawal {wait}"));
        at(OWNER, 1, height);
        let to = "0x2031181d63507368232579af4c64a1c3428407ff";
        let refused = refusal(|| a.evm_withdraw(WETH.into(), U128(5), to.into(), None, None).detach());
        assert_eq!(refused, format!("no Ethereum withdrawal with a loan open {wait}"));
        let now = time(H0 + 17);
        assert_eq!(step_refused(&mut a, FID, 2, height, now), format!("no funding step {wait}"));
    }
    assert_eq!(a.get_state().pending, vec![listed_at_aave(LenderKind::Borrow, 4_000_000_000, AAVE_USDC, 1)]);
    // Repaying, at either lender or the pool, is not held back.
    at(OWNER, 1, H0 + 18);
    a.lender_repay("aave".into(), U128(5)).detach();
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
}

#[test]
fn a_verdict_that_has_seen_the_nonce_used_drops_the_aave_action_and_bumps_the_counter() {
    let mut a = borrowing_at_aave();
    // The chain's next nonce is still 1: the borrow isn't mined, and stays listed.
    assert!(deliver(&mut a, Intent::Check {}, &aave_verdict(4, H0 + 20, 0, 1), H0 + 21).accepted);
    assert_eq!((a.get_state().counter, a.get_state().pending.len()), (4, 1));
    // A verdict with no reading of Aave's chain says nothing about it.
    assert!(deliver(&mut a, Intent::Check {}, &verdict(4, H0 + 22), H0 + 23).accepted);
    assert_eq!((a.get_state().counter, a.get_state().pending.len()), (4, 1));
    // The chain's next nonce is 2: it has used nonce 1, whether the borrow went through or reverted. The listing
    // goes, and the counter moves on.
    assert!(deliver(&mut a, Intent::Check {}, &aave_verdict(4, H0 + 24, 0, 2), H0 + 25).accepted);
    let logs = get_logs();
    assert_eq!(logs.last().unwrap(), "Aave's chain has used the signed transaction's nonce: the counter moves on");
    assert_eq!((a.get_state().counter, a.get_state().pending.len()), (5, 0));
    // So that verdict itself backs nothing: its reading of the position may be a block behind its reading of the
    // nonce. The next check does, and our pool's step runs on it.
    let refused = step_refused(&mut a, FID, 2, H0 + 26, time(H0 + 26));
    assert_eq!(refused, "the verdict was already used: ask for a new check");
    assert!(deliver(&mut a, Intent::Check {}, &aave_verdict(5, H0 + 27, 0, 2), H0 + 28).accepted);
    assert_eq!(a.get_state().counter, 5);
    run_step(&mut a, "keeper.testnet", FID, 2, H0 + 29);
    assert_eq!(call_of("borrow").0.as_str(), POOL);
}

#[test]
fn a_verdict_drops_every_aave_action_whose_nonce_the_chain_has_passed_and_leaves_rheas() {
    let mut a = aave_account();
    a.pending.push(listed_at_aave(LenderKind::Withdraw, 5, WETH, 3));
    a.pending.push(listed_at_aave(LenderKind::Transfer, 5, WETH, 4));
    a.pending.push(listed_at_aave(LenderKind::Transfer, 5, AAVE_USDC, 5));
    a.pending.push(listed(LenderKind::Borrow, 5, H0 + 20));
    assert!(deliver(&mut a, Intent::Check {}, &aave_verdict(0, H0 + 1, 0, 5), H0 + 2).accepted);
    // Nonces 3 and 4 are used; 5 is the next, so its transfer isn't mined. Rhea's 20 blocks are their own matter.
    let left = vec![listed_at_aave(LenderKind::Transfer, 5, AAVE_USDC, 5), listed(LenderKind::Borrow, 5, H0 + 20)];
    assert_eq!((a.get_state().pending, a.get_state().counter), (left, 1));
}

// The top-up's steps at Aave.

/// An Aave account with this permission and a stored REBALANCE plan of `steps` (plan 1020), from a verdict read at
/// H0 + 20 whose `ext` shows the loan at Aave.
fn with_aave_top_up(steps: Value) -> Account {
    let mut a = aave_account();
    let mut v = rebalance(0, H0 + 20, steps);
    v["ext"] = json!([ext_line("aave")]);
    assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 21).accepted);
    a
}

#[test]
fn a_top_ups_l_add_step_at_aave_signs_a_supply_under_the_verdict_that_ordered_it() {
    let add = json!({ "k": "l_add", "l": "aave", "tok": WETH, "amt": WETH_AMOUNT.to_string() });
    let mut a = with_aave_top_up(json!([add]));
    run_step(&mut a, "anyone.testnet", PID, 0, H0 + 25);
    let (weth, me) = (evm_address(WETH), evm_address(ADDRESS));
    let tx = evm_tx(0, EvmKind::Supply, AAVE_POOL, supply_data(&weth, WETH_AMOUNT, &me));
    assert_asked_to_sign(&tx);
    assert_eq!(events("step_run"), vec![json!({ "pid": PID, "i": 0, "k": "l_add" })]);
    assert!(step_done(&a, 0) && a.get_state().counter == 1);
    let entry = evm_signed(&mut a, signed_ok(), H0 + 27).expect("nothing was signed");
    assert_eq!((entry.kind, entry.step.as_deref(), entry.amount), (EvmKind::Supply, Some("1020:0"), U128(WETH_AMOUNT)));
    assert_eq!((a.get_state().counter, a.get_state().pending.len()), (2, 0));
    // With no signature the step may run again.
    a.plan.as_mut().unwrap().steps[0].done = false;
    a.counter = 0;
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 28);
    assert_eq!(evm_signed(&mut a, PromiseResult::Failed, H0 + 30), None);
    assert!(!step_done(&a, 0));
    // A later check that didn't order it leaves it stored, and it no longer runs.
    let mut watch = verdict(a.get_state().counter, H0 + 31);
    watch["state"] = json!("WATCH");
    assert!(deliver(&mut a, Intent::Check {}, &watch, H0 + 32).accepted);
    let stale = step_refused(&mut a, PID, 0, H0 + 33, time(H0 + 33));
    assert!(stale.ends_with("is not the one that ordered it"), "{stale}");
}

#[test]
fn a_top_ups_l_repay_step_at_aave_signs_a_repayment_of_the_steps_amount_and_is_never_held_back() {
    // A blocked account whose verdict is spent, with a signed borrow still listed: the repayment is signed anyway.
    let mut a = with_aave_top_up(json!([{ "k": "l_repay", "l": "aave", "amt": 10_133_000_000u64 }]));
    a.blocked = true;
    a.counter = 1;
    a.pending.push(listed_at_aave(LenderKind::Borrow, 5, AAVE_USDC, 7));
    run_step(&mut a, "anyone.testnet", PID, 0, H0 + 25);
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
    // repay(USDC, exactly the step's $10,133, the variable rate, the account's own), from the USDC at the address.
    let (usdc, me) = (evm_address(AAVE_USDC), evm_address(ADDRESS));
    let tx = evm_tx(0, EvmKind::Repay, AAVE_POOL, repay_data(&usdc, Some(10_133_000_000), &me));
    assert_asked_to_sign(&tx);
    assert_eq!(events("step_run"), vec![json!({ "pid": PID, "i": 0, "k": "l_repay" })]);
    // A repayment only lowers risk: the counter stays, and nothing new is listed.
    assert!(step_done(&a, 0) && a.get_state().counter == 1 && a.get_state().pending.len() == 1);
    let entry = evm_signed(&mut a, signed_ok(), H0 + 27).expect("nothing was signed");
    assert_eq!((entry.kind, entry.step.as_deref()), (EvmKind::Repay, Some("1020:0")));
    assert_eq!((a.get_state().counter, a.get_state().pending.len()), (1, 1));
    // With a fresh verdict held, the pool settles the client's price beside it.
    let mut a = with_aave_top_up(json!([{ "k": "l_repay", "l": "aave", "amt": 10_133_000_000u64 }]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert_eq!(methods(), vec!["settle", "on_settled", "sign", "on_evm_signed"]);
    // With no signature the step may run again.
    assert_eq!(evm_signed(&mut a, PromiseResult::Failed, H0 + 27), None);
    assert!(!step_done(&a, 0) && a.get_state().counter == 0);
}

// lender_repay at Aave.

#[test]
fn a_repayment_of_the_whole_debt_at_aave_says_all_of_it_and_a_part_says_its_amount() {
    let (usdc, me) = (evm_address(AAVE_USDC), evm_address(ADDRESS));
    // With no verdict held the account knows no debt there: the amount goes as it is.
    let mut a = aave_account();
    at(OWNER, 1, H0 + 1);
    a.lender_repay("aave".into(), U128(60_000_000_000)).detach();
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
    assert_asked_to_sign(&evm_tx(0, EvmKind::Repay, AAVE_POOL, repay_data(&usdc, Some(60_000_000_000), &me)));
    // The held verdict shows $50,667 owed at Aave. A part of it is sent exactly.
    let mut a = aave_account();
    assert!(deliver(&mut a, Intent::Check {}, &aave_verdict(0, H0 + 1, 0, 0), H0 + 2).accepted);
    at(OWNER, 1, H0 + 3);
    a.lender_repay("aave".into(), U128(50_666_999_999)).detach();
    // The verdict is fresh, so the pool settles beside the repayment.
    assert_eq!(methods(), vec!["settle", "on_settled", "sign", "on_evm_signed"]);
    let part = evm_tx(0, EvmKind::Repay, AAVE_POOL, repay_data(&usdc, Some(50_666_999_999), &me));
    assert_asked_to_sign(&part);
    let entry = evm_signed(&mut a, signed_ok(), H0 + 4).expect("nothing was signed");
    assert_eq!((entry.kind, entry.amount, entry.step.clone()), (EvmKind::Repay, U128(50_666_999_999), None));
    // That debt or more is sent as "all of it": Aave then takes the debt as it stands when the transaction runs,
    // interest included, and leaves no dust.
    for amount in [50_667_000_000, 60_000_000_000] {
        at(OWNER, 1, H0 + 5);
        a.lender_repay("aave".into(), U128(amount)).detach();
        let whole = evm_tx(1, EvmKind::Repay, AAVE_POOL, repay_data(&usdc, None, &me));
        assert_asked_to_sign(&whole);
        assert!(hex(&whole.data).contains(&"f".repeat(64)));
        let entry = evm_signed(&mut a, PromiseResult::Failed, H0 + 6);
        assert_eq!(entry, None);
    }
    // A repayment leaves the counter alone and lists nothing.
    assert_eq!((a.get_state().counter, a.get_state().pending.len()), (0, 0));
}

#[test]
fn anyone_but_the_owner_repays_aave_only_when_repay_is_open_and_no_more_than_the_verdict_shows() {
    let mut a = aave_account();
    let refused = lender_repay_refused(&mut a, "keeper.testnet", 1, "aave", 5);
    assert!(refused.starts_with("only the owner can repay, unless the verdict says DELEVERAGE"), "{refused}");
    let mut unwind = deleverage(H0 + 5, 0);
    unwind["ext"] = json!([ext_line("rhea")]);
    assert!(deliver(&mut a, Intent::Check {}, &unwind, H0 + 6).accepted);
    let refused = lender_repay_refused(&mut a, "keeper.testnet", 1, "aave", 5);
    assert_eq!(refused, "the verdict shows no debt at aave: only the owner can send it more");
    let mut unwind = deleverage(H0 + 7, 0);
    unwind["ext"] = json!([ext_line("aave")]);
    assert!(deliver(&mut a, Intent::Check {}, &unwind, H0 + 8).accepted);
    // More than the debt is cut to it, which is the whole debt.
    at("stranger.testnet", 1, H0 + 9);
    a.lender_repay("aave".into(), U128(900_000_000_000)).detach();
    let (usdc, me) = (evm_address(AAVE_USDC), evm_address(ADDRESS));
    assert_asked_to_sign(&evm_tx(0, EvmKind::Repay, AAVE_POOL, repay_data(&usdc, None, &me)));
    assert_eq!(a.evm.signing.as_ref().unwrap().amount, 50_667_000_000);
}

#[test]
fn repaying_aave_is_not_held_back_by_a_block_a_transfer_a_borrow_or_a_lender_action() {
    let mut a = aave_account();
    a.blocked = true;
    a.pending.push(Pending::Transfer(Transfer::new("move:0".into(), TransferKind::ToHl, USDC, 5, DEP, 0)));
    a.pending.push(Pending::Borrow { amount: U128(5) });
    a.pending.push(listed(LenderKind::Withdraw, 5, H0 + 20));
    a.pending.push(listed_at_aave(LenderKind::Borrow, 5, AAVE_USDC, 3));
    a.hl.send_open_until_ms = U64(NOW_MS + 60_000);
    at(OWNER, 1, H0 + 1);
    a.lender_repay("aave".into(), U128(5)).detach();
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
    assert_eq!((a.get_state().counter, a.get_state().pending.len()), (0, 4));
}

// lender_withdraw at Aave.

#[test]
fn with_no_loan_from_our_pool_the_owner_takes_collateral_back_from_aave_without_a_verdict() {
    let mut a = aave_account();
    at(OWNER, 1, H0 + 1);
    a.lender_withdraw("aave".into(), WETH.into(), U128(WETH_AMOUNT)).detach();
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
    // withdraw(WETH, the amount, the account's own address), sent to Aave's Pool.
    let (weth, me) = (evm_address(WETH), evm_address(ADDRESS));
    let tx = evm_tx(0, EvmKind::Withdraw, AAVE_POOL, withdraw_data(&weth, Some(WETH_AMOUNT), &me));
    assert_asked_to_sign(&tx);
    // It bumps the counter and is listed at once, in the token's own units, with the token and the nonce.
    let pending = json!([{ "lender": {
        "lender": "aave", "kind": "withdraw", "amount": WETH_AMOUNT.to_string(), "token": WETH, "evm_nonce": 0,
    } }]);
    assert_eq!((pending_view(&a), a.get_state().counter), (pending.clone(), 1));
    let entry = evm_signed(&mut a, signed_ok(), H0 + 3).expect("nothing was signed");
    assert_eq!(
        near_sdk::serde_json::to_value(&entry).unwrap(),
        kept_as(&tx, "withdraw", WETH, WETH_AMOUNT, Value::Null, H0 + 3)
    );
    assert_eq!((pending_view(&a), a.get_state().counter), (pending, 1));
    // An account that owes our pool nothing needs no verdict to leave: a second withdrawal, of another token, is
    // signed while the first still waits for one. Each stays listed.
    at(OWNER, 1, H0 + 4);
    a.lender_withdraw("aave".into(), WBTC.into(), U128(5)).detach();
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
    let both = vec![
        listed_at_aave(LenderKind::Withdraw, WETH_AMOUNT, WETH, 0),
        listed_at_aave(LenderKind::Withdraw, 5, WBTC, 1),
    ];
    assert_eq!((a.get_state().pending, a.get_state().counter), (both, 2));
    // With no signature, that listing goes at once and the counter moves on.
    assert_eq!(evm_signed(&mut a, PromiseResult::Failed, H0 + 6), None);
    let first = vec![listed_at_aave(LenderKind::Withdraw, WETH_AMOUNT, WETH, 0)];
    assert_eq!((a.get_state().pending, a.get_state().counter, evm_view(&a)["nonce"].clone()), (first, 3, json!(1)));
}

/// What the owner's `lender_withdraw` of 0.02 WETH from Aave at `height` is refused with.
fn aave_withdraw_refused(a: &mut Account, height: u64) -> String {
    at(OWNER, 1, height);
    let refused = refusal(|| a.lender_withdraw("aave".into(), WETH.into(), U128(WETH_AMOUNT)).detach());
    assert!(calls().is_empty(), "a refused withdrawal still called something");
    refused
}

#[test]
fn while_the_account_owes_our_pool_lender_withdraw_at_aave_needs_a_fresh_healthy_verdict_that_allows_it() {
    let asked = Intent::LenderWithdraw { lender: "aave".into(), token: WETH.into(), amount: U128(WETH_AMOUNT) };
    let allowing = |amount: u128| {
        let mut v = verdict(0, H0 + 5);
        v["allow"]["withdraw"] = json!(amount as u64);
        v
    };
    let refused_on = |intent: Intent, v: Value| {
        let mut a = aave_account();
        a.loan = pool_loan();
        assert!(deliver(&mut a, intent, &v, H0 + 6).accepted);
        let refused = aave_withdraw_refused(&mut a, H0 + 8);
        assert!(a.get_state().pending.is_empty() && a.get_state().counter == 0 && a.evm.signing.is_none());
        refused
    };
    let mut a = aave_account();
    a.loan = pool_loan();
    assert_eq!(aave_withdraw_refused(&mut a, H0 + 8), "no verdict: ask for a check first");
    let other = "with a loan open, taking collateral back needs a verdict for this lender, token and amount";
    assert_eq!(refused_on(Intent::Check {}, allowing(WETH_AMOUNT)), other);
    let at_rhea = Intent::LenderWithdraw { lender: "rhea".into(), token: WETH.into(), amount: U128(WETH_AMOUNT) };
    assert_eq!(refused_on(at_rhea, allowing(WETH_AMOUNT)), other);
    assert_eq!(refused_on(asked.clone(), allowing(0)), "the verdict doesn't allow this withdrawal");
    let mut watch = allowing(WETH_AMOUNT);
    watch["state"] = json!("WATCH");
    assert_eq!(refused_on(asked.clone(), watch), "the verdict's state isn't HEALTHY");
    // On a verdict for exactly this withdrawal it is signed, and the verdict backs nothing more.
    assert!(deliver(&mut a, asked, &allowing(WETH_AMOUNT), H0 + 6).accepted);
    at(OWNER, 1, H0 + 8);
    a.lender_withdraw("aave".into(), WETH.into(), U128(WETH_AMOUNT)).detach();
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
    assert_eq!(a.get_state().pending, vec![listed_at_aave(LenderKind::Withdraw, WETH_AMOUNT, WETH, 0)]);
    assert_eq!(a.get_state().counter, 1);
}

#[test]
fn lender_withdraw_at_aave_is_the_owners_with_1_yocto_for_one_of_aaves_collateral_tokens() {
    let mut a = aave_account();
    let refused = lender_withdraw_call_refused;
    assert_eq!(refused(&mut a, "keeper.testnet", 1, "aave", WETH, 5), "only the owner can do this");
    assert!(refused(&mut a, OWNER, 0, "aave", WETH, 5).contains("1 yoctoNEAR"));
    assert_eq!(refused(&mut a, OWNER, 1, "aave", WETH, 0), "amount must be positive");
    // Aave keeps nothing of a repayment, so its USDC is not something to take back.
    for token in [AAVE_USDC, NBTC, "0x0000000000000000000000000000000000000001"] {
        let words = format!("{token} is not one of aave's collateral tokens");
        assert_eq!(refused(&mut a, OWNER, 1, "aave", token, 5), words);
    }
    a.blocked = true;
    assert_eq!(refused(&mut a, OWNER, 1, "aave", WETH, 5), "this account is blocked after a default");
    a.blocked = false;
    a.pending.push(Pending::Borrow { amount: U128(5) });
    assert_eq!(refused(&mut a, OWNER, 1, "aave", WETH, 5), "a borrow is under way: wait for it to finish");
    a.pending.clear();
    let mut plain = lender_account(both());
    plain.config.lenders.aave = None;
    assert_eq!(refused(&mut plain, OWNER, 1, "aave", WETH, 5), "this account has no settings for aave");
    assert!(a.get_state().pending.is_empty() && a.get_state().counter == 0 && a.evm.signing.is_none());
}

// evm_withdraw.

const ELSEWHERE: &str = "0x2031181d63507368232579AF4c64a1c3428407fF";

#[test]
fn with_no_loan_from_our_pool_the_owner_sends_a_token_away_from_the_ethereum_address_without_a_verdict() {
    let mut a = aave_account();
    at(OWNER, 1, H0 + 1);
    a.evm_withdraw(AAVE_USDC.into(), U128(99_000_000), ELSEWHERE.into(), None, None).detach();
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
    // transfer(to, $99), sent to the token itself.
    let tx = evm_tx(0, EvmKind::Transfer, AAVE_USDC, transfer_data(&evm_address(ELSEWHERE), 99_000_000));
    assert_asked_to_sign(&tx);
    // It is listed although the pool is owed nothing: the signature can be used at any later time.
    let pending = json!([{ "lender": {
        "lender": "aave", "kind": "transfer", "amount": "99000000", "token": AAVE_USDC.to_lowercase(), "evm_nonce": 0,
    } }]);
    assert_eq!((pending_view(&a), a.get_state().counter), (pending, 1));
    let entry = evm_signed(&mut a, signed_ok(), H0 + 3).expect("nothing was signed");
    assert_eq!(
        near_sdk::serde_json::to_value(&entry).unwrap(),
        kept_as(&tx, "transfer", AAVE_USDC, 99_000_000, Value::Null, H0 + 3)
    );
    // So no loan can be taken on tokens that a kept signature is about to send away: not from our pool, and not by
    // a funding plan's steps.
    assert!(deliver(&mut a, borrow_intent(5), &verdict(1, H0 + 4), H0 + 5).accepted);
    at(OWNER, 1, H0 + 6);
    let refused = refusal(|| a.borrow(U128(5)).detach());
    let wait = "until a check shows Ethereum transaction 0 mined: a transfer at aave is still under way";
    assert_eq!(refused, format!("no borrow {wait}"));
    // With no loan the owner can still send more away, and take collateral back.
    at(OWNER, 1, H0 + 7);
    a.evm_withdraw(WETH.into(), U128(5), ELSEWHERE.into(), None, None).detach();
    assert_asked_to_sign(&evm_tx(1, EvmKind::Transfer, WETH, transfer_data(&evm_address(ELSEWHERE), 5)));
    // With no signature the listing goes at once.
    assert_eq!(evm_signed(&mut a, PromiseResult::Failed, H0 + 8), None);
    assert_eq!(a.get_state().pending, vec![listed_at_aave(LenderKind::Transfer, 99_000_000, AAVE_USDC, 0)]);
}

#[test]
fn while_the_account_owes_our_pool_evm_withdraw_needs_a_fresh_healthy_verdict_that_allows_it() {
    let asked = Intent::EvmWithdraw { token: WETH.into(), amount: U128(WETH_AMOUNT) };
    let allowing = |amount: u128| {
        let mut v = verdict(0, H0 + 5);
        v["allow"]["withdraw"] = json!(amount as u64);
        v
    };
    let try_it = |a: &mut Account, height: u64| {
        at(OWNER, 1, height);
        let refused = refusal(|| a.evm_withdraw(WETH.into(), U128(WETH_AMOUNT), ELSEWHERE.into(), None, None).detach());
        assert!(calls().is_empty() && a.evm.signing.is_none());
        refused
    };
    let refused_on = |intent: Intent, v: Value| {
        let mut a = aave_account();
        a.loan = pool_loan();
        assert!(deliver(&mut a, intent, &v, H0 + 6).accepted);
        try_it(&mut a, H0 + 8)
    };
    let mut a = aave_account();
    a.loan = pool_loan();
    assert_eq!(try_it(&mut a, H0 + 8), "no verdict: ask for a check first");
    let other = "with a loan open, an Ethereum withdrawal needs a verdict for this token and amount";
    assert_eq!(refused_on(Intent::Check {}, allowing(WETH_AMOUNT)), other);
    let less = Intent::EvmWithdraw { token: WETH.into(), amount: U128(WETH_AMOUNT - 1) };
    assert_eq!(refused_on(less, allowing(WETH_AMOUNT)), other);
    assert_eq!(refused_on(asked.clone(), allowing(0)), "the verdict doesn't allow this withdrawal");
    let mut watch = allowing(WETH_AMOUNT);
    watch["state"] = json!("WATCH");
    assert_eq!(refused_on(asked.clone(), watch), "the verdict's state isn't HEALTHY");
    // It waits for a signed sendAsset and an overdue transfer, as a withdrawal on NEAR does.
    assert!(deliver(&mut a, asked, &allowing(WETH_AMOUNT), H0 + 6).accepted);
    a.hl.send_open_until_ms = U64(NOW_MS + 60_000);
    assert!(try_it(&mut a, H0 + 8).starts_with("no Ethereum withdrawal with a loan open until 2023-11-14"));
    a.hl.send_open_until_ms = U64(0);
    a.pending.push(Pending::Transfer(Transfer::new("move:0".into(), TransferKind::ToHl, USDC, 5, DEP, 0)));
    assert!(try_it(&mut a, H0 + 8).starts_with("no Ethereum withdrawal with a loan open while transfer move:0"));
    a.pending.clear();
    assert_eq!(try_it(&mut a, H0 + 5 + FRESH_BLOCKS + 1), "the verdict is 121 blocks old, above the 120-block limit");
    assert_eq!(a.get_state().counter, 0);
    // On a verdict for exactly this withdrawal it is signed and listed, and the verdict backs nothing more.
    at(OWNER, 1, H0 + 8);
    a.evm_withdraw(WETH.into(), U128(WETH_AMOUNT), ELSEWHERE.into(), None, None).detach();
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
    assert_eq!(a.get_state().pending, vec![listed_at_aave(LenderKind::Transfer, WETH_AMOUNT, WETH, 0)]);
    assert_eq!(a.get_state().counter, 1);
}

#[test]
fn evm_withdraw_is_the_owners_with_1_yocto_for_a_token_of_the_aave_settings_to_an_address() {
    let mut a = aave_account();
    let mut refused = |who: &str, yocto: u128, token: &str, amount: u128, to: &str| {
        at(who, yocto, H0 + 1);
        refusal(|| a.evm_withdraw(token.into(), U128(amount), to.into(), None, None).detach())
    };
    assert_eq!(refused("keeper.testnet", 1, WETH, 5, ELSEWHERE), "only the owner can do this");
    assert!(refused(OWNER, 0, WETH, 5, ELSEWHERE).contains("1 yoctoNEAR"));
    assert_eq!(refused(OWNER, 1, WETH, 0, ELSEWHERE), "amount must be positive");
    assert_eq!(refused(OWNER, 1, NBTC, 5, ELSEWHERE), format!("{NBTC} is not USDC or one of aave's collateral tokens"));
    for to in ["", "0x2031", OWNER] {
        assert_eq!(refused(OWNER, 1, WETH, 5, to), "to must be 0x and 40 hex digits");
    }
    let mut no_address = lender_account(both());
    at(OWNER, 1, H0 + 1);
    let unknown = refusal(|| no_address.evm_withdraw(WBTC.into(), U128(5), ELSEWHERE.into(), None, None).detach());
    assert_eq!(unknown, "no Ethereum address yet: call hl_init first");
    let mut plain = account();
    at(OWNER, 1, H0 + 1);
    let none = refusal(|| plain.evm_withdraw(WBTC.into(), U128(5), ELSEWHERE.into(), None, None).detach());
    assert_eq!(none, "this account has no settings for aave");
    a.blocked = true;
    at(OWNER, 1, H0 + 1);
    let blocked = refusal(|| a.evm_withdraw(WETH.into(), U128(5), ELSEWHERE.into(), None, None).detach());
    assert_eq!(blocked, "this account is blocked after a default");
    a.blocked = false;
    a.pending.push(Pending::Borrow { amount: U128(5) });
    at(OWNER, 1, H0 + 1);
    let borrowing = refusal(|| a.evm_withdraw(WETH.into(), U128(5), ELSEWHERE.into(), None, None).detach());
    assert_eq!(borrowing, "a borrow is under way: wait for it to finish");
    assert!(a.evm.signing.is_none() && a.get_state().counter == 0);
}

#[test]
fn a_verdict_that_names_the_token_in_another_case_still_answers_the_withdrawal() {
    // The app may write an address with capitals and the check without: it is the same token.
    let allowing = |nonce: u64| {
        let mut v = verdict(nonce, H0 + 5);
        v["allow"]["withdraw"] = json!(5);
        v
    };
    let mut a = aave_account();
    a.loan = pool_loan();
    let asked = Intent::EvmWithdraw { token: WBTC.to_lowercase(), amount: U128(5) };
    assert!(deliver(&mut a, asked, &allowing(0), H0 + 6).accepted);
    at(OWNER, 1, H0 + 8);
    a.evm_withdraw(WBTC.into(), U128(5), ELSEWHERE.into(), None, None).detach();
    assert_eq!(a.get_state().pending, vec![listed_at_aave(LenderKind::Transfer, 5, WBTC, 0)]);

    let mut a = aave_account();
    a.loan = pool_loan();
    let asked = Intent::LenderWithdraw { lender: "aave".into(), token: WBTC.to_lowercase(), amount: U128(5) };
    assert!(deliver(&mut a, asked, &allowing(0), H0 + 6).accepted);
    at(OWNER, 1, H0 + 8);
    a.lender_withdraw("aave".into(), WBTC.into(), U128(5)).detach();
    assert_eq!(a.get_state().pending, vec![listed_at_aave(LenderKind::Withdraw, 5, WBTC, 0)]);
}

// evm_bump.

/// An Aave account whose supply of 0.02 WETH is signed (Ethereum nonce 0), at the first fees: half the limit of
/// 1 gwei, and a tip of 1,000,000 wei.
fn with_a_signed_supply() -> Account {
    let mut a = funded_at_aave();
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 9);
    assert!(evm_signed(&mut a, signed_ok(), H0 + 10).is_some());
    a
}

#[test]
fn anyone_has_a_kept_transaction_signed_again_with_higher_fees() {
    let mut a = with_a_signed_supply();
    let before = a.get_state();
    // The first try was signed at H0 + 10. Anyone bumps it a minute later (100 of the test's blocks), by an eighth
    // at most.
    at("anyone.testnet", 0, H0 + 110);
    a.evm_bump(0, U128(562_500_000), U128(2_000_000)).detach();
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
    // The same call with the same nonce and gas limit, at the new fees.
    let (weth, me) = (evm_address(WETH), evm_address(ADDRESS));
    let mut tx = evm_tx(0, EvmKind::Supply, AAVE_POOL, supply_data(&weth, WETH_AMOUNT, &me));
    (tx.max_fee, tx.tip) = (562_500_000, 2_000_000);
    assert_asked_to_sign(&tx);
    let entry = evm_signed(&mut a, signed_ok(), H0 + 111).expect("nothing was signed");
    // It replaces the kept one, and uses no new nonce. Nothing else changes.
    let kept = kept_as(&tx, "supply", WETH, WETH_AMOUNT, json!("f1005:0"), H0 + 111);
    assert_eq!(near_sdk::serde_json::to_value(&entry).unwrap(), kept);
    assert_eq!(evm_view(&a), json!({ "nonce": 1, "signed": [kept.clone()], "approved": [] }));
    assert_eq!(events("evm_signed"), vec![json!({ "nonce": 0, "kind": "supply", "hash": kept["hash"] })]);
    let after = a.get_state();
    assert_eq!((after.counter, after.pending, after.funding), (before.counter, before.pending, before.funding));
    // With no signature the kept transaction stays as it was.
    at("anyone.testnet", 0, H0 + 215);
    a.evm_bump(0, U128(620_000_000), U128(4_000_000)).detach();
    assert_eq!(evm_signed(&mut a, PromiseResult::Failed, H0 + 216), None);
    assert_eq!(evm_view(&a), json!({ "nonce": 1, "signed": [kept], "approved": [] }));
}

/// What anyone's `evm_bump` of the kept transaction `nonce` to these fees is refused with.
fn bump_refused(a: &mut Account, nonce: u64, max_fee: u128, tip: u128) -> String {
    at("anyone.testnet", 0, H0 + 12);
    let refused = refusal(|| a.evm_bump(nonce, U128(max_fee), U128(tip)).detach());
    assert!(calls().is_empty() && a.evm.signing.is_none());
    refused
}

#[test]
fn a_bump_only_raises_fees_by_a_tenth_or_more_and_never_above_the_accounts_limit() {
    let mut a = with_a_signed_supply();
    assert_eq!(bump_refused(&mut a, 1, MAX_FEE, 2_000_000), "no signed transaction with nonce 1 is kept");
    let mut plain = account();
    at("anyone.testnet", 0, H0 + 12);
    let none = refusal(|| plain.evm_bump(0, U128(MAX_FEE), U128(2_000_000)).detach());
    assert_eq!(none, "this account has no settings for aave");
    let above = bump_refused(&mut a, 0, MAX_FEE + 1, 2_000_000);
    assert_eq!(above, "max_fee is above this account's limit of 1000000000 wei a gas");
    assert_eq!(bump_refused(&mut a, 0, 600_000_000, 600_000_001), "tip can't be above max_fee");
    // A node takes a replacement only if the fee and the tip are both a tenth higher. The first try offered half
    // the limit and a tip of 1,000,000 wei.
    let low = "a bump raises both the fee and the tip by at least a tenth";
    for (max_fee, tip) in [
        (FIRST_FEE - 1, 2_000_000),
        (FIRST_FEE, 2_000_000),
        (549_999_999, 2_000_000),
        (MAX_FEE, 999_999),
        (MAX_FEE, 1_000_000),
        (MAX_FEE, 1_099_999),
    ] {
        assert_eq!(bump_refused(&mut a, 0, max_fee, tip), low, "{max_fee} and {tip}");
    }
    // A tenth higher each is one. The owner needn't wait a minute for it.
    at(OWNER, 0, H0 + 12);
    a.evm_bump(0, U128(550_000_000), U128(1_100_000)).detach();
    let bumped = a.evm.signing.as_ref().map(|s| (s.bump, s.tx.max_fee, s.tx.tip));
    assert_eq!(bumped, Some((true, 550_000_000, 1_100_000)));
    // While it is being signed, no other transaction is.
    at(OWNER, 0, H0 + 13);
    let busy = refusal(|| a.evm_bump(0, U128(560_000_000), U128(5_000_000)).detach());
    assert_eq!(busy, "Ethereum transaction 0 is being signed: wait for the signer's answer");
    assert!(evm_signed(&mut a, signed_ok(), H0 + 14).is_some());
    // The next bump counts from the fees now kept: a tenth above them at least, an eighth at most.
    assert_eq!(bump_refused(&mut a, 0, 600_000_000, 1_200_000), low);
    let eighth = "a bump raises the fee by an eighth at most: 618750000 wei a gas";
    assert_eq!(bump_refused(&mut a, 0, 618_750_001, 1_300_000), eighth);
    assert_eq!(bump_refused(&mut a, 0, MAX_FEE, MAX_FEE), eighth);
    // Once a verdict has seen the nonce used, the transaction is mined, and there is nothing to bump.
    assert!(deliver(&mut a, Intent::Check {}, &aave_verdict(3, H0 + 15, 0, 1), H0 + 16).accepted);
    at("anyone.testnet", 0, H0 + 17);
    let mined = refusal(|| a.evm_bump(0, U128(MAX_FEE), U128(9_000_000)).detach());
    assert_eq!(mined, "the transaction with nonce 0 is mined already");
}

#[test]
fn a_first_try_offers_half_the_configs_fee_limit_and_a_tip_that_never_passes_it() {
    // Half the limit, so there is room to bump. If that is under 1,000,000 wei it is also the tip, and it is never 0.
    for (limit, first) in [(400_000, 200_000), (1, 1)] {
        at("pbf.testnet", 0, H0);
        let mut lenders = lenders();
        lenders.aave.as_mut().unwrap().max_fee_per_gas = U128(limit);
        let mut a = Account::new(id(OWNER), Config { lenders, ..config() }, both());
        assert_eq!(give_key(&mut a, KEY).as_deref(), Some(ADDRESS));
        at("anyone.testnet", 0, H0 + 1);
        a.evm_approve(WBTC.into()).detach();
        let tx = &a.evm.signing.as_ref().unwrap().tx;
        assert_eq!((tx.chain_id, tx.nonce, tx.tip, tx.max_fee, tx.gas_limit), (84532, 0, first, first, 100_000));
    }
    // The stage 2 fixture's limit of 5 gwei gives 2.5 gwei and a tip of 1,000,000 wei.
    let mut a = lender_account(both());
    assert_eq!(give_key(&mut a, KEY).as_deref(), Some(ADDRESS));
    at("anyone.testnet", 0, H0 + 1);
    a.evm_approve(WBTC.into()).detach();
    let tx = &a.evm.signing.as_ref().unwrap().tx;
    assert_eq!((tx.tip, tx.max_fee), (1_000_000, 2_500_000_000));
}

#[test]
fn every_new_account_shows_its_ethereum_side_and_one_without_aave_never_uses_it() {
    for a in [account(), lender_account(both()), aave_account()] {
        assert_eq!(evm_view(&a), json!({ "nonce": 0, "signed": [], "approved": [] }));
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 6, stage 4: the owner's moves between NEAR and the account's address on Aave's chain, each recorded as a
// 1Click transfer until it settles (INTERFACES.md 36)
// ---------------------------------------------------------------------------------------------------------------

fn to_evm_move() -> Option<Move> {
    Some(Move { kind: TransferKind::ToEvm, exp: quote_exp(), expect: None })
}

/// A 1Click delivery or refund of `amount` of the NEAR token `token` arrives with the msg of transfer `id`.
fn delivered(a: &mut Account, token: &str, amount: u128, id: &str, height: u64) {
    at(token, 0, height);
    let msg = format!(r#"{{"pb":{{"transfer":"{id}"}}}}"#);
    let kept = a.ft_on_transfer(self::id("solver.testnet"), U128(amount), msg);
    assert!(matches!(kept, PromiseOrValue::Value(U128(0))), "the tokens were sent back");
}

/// An `e_home` transfer of this token and amount to `ELSEWHERE`, as `evm_withdraw` with `exp` records it.
fn e_home(id: &str, token: &str, amount: u128) -> Transfer {
    Transfer::new(id.into(), TransferKind::EHome, token, amount, &ELSEWHERE.to_lowercase(), quote_exp())
}

// to_evm: withdraw with a transfer.

#[test]
fn a_move_to_aaves_chain_sends_any_listed_token_and_records_transfer_move_n() {
    let mut a = aave_account();
    at(OWNER, 1, H0 + 1);
    a.withdraw(id(NBTC), U128(55_000), id(DEP), to_evm_move()).detach();
    // It is a withdrawal to the 1Click deposit address, which needs no verdict with no loan from our pool.
    assert_eq!(methods(), vec!["storage_deposit", "ft_transfer", "on_sent"]);
    assert_eq!(call_of("ft_transfer").1, json!({ "receiver_id": DEP, "amount": "55000" }));
    assert_eq!(call_of("on_sent").1, json!({ "id": "move:0" }));
    let bitcoin = Transfer::new("move:0".into(), TransferKind::ToEvm, NBTC, 55_000, DEP, quote_exp());
    assert_eq!(transfers(&a), vec![bitcoin.clone()]);
    let shape = json!([{ "transfer": {
        "id": "move:0", "kind": "to_evm", "token": NBTC, "amount": "55000", "dep": DEP,
        "deadline": bitcoin.deadline.0.to_string(),
    } }]);
    assert_eq!(pending_view(&a), shape);
    assert_eq!((a.get_state().next_move, a.get_state().counter), (1, 1));
    // The tokens went out: the transfer stays under way, and the counter moves on again.
    ctx(ACCOUNT, 0, H0 + 2, time(H0 + 2), vec![checked()]);
    assert!(a.on_sent(Some("move:0".into())));
    assert_eq!((transfers(&a), a.get_state().counter), (vec![bitcoin.clone()], 2));
    // USDC goes the same way: it is how Aave is repaid once the loan has come home.
    at(OWNER, 1, H0 + 3);
    a.withdraw(id(USDC), U128(23_100_000), id(DEP), to_evm_move()).detach();
    let dollars = Transfer::new("move:1".into(), TransferKind::ToEvm, USDC, 23_100_000, DEP, quote_exp());
    assert_eq!(transfers(&a), vec![bitcoin, dollars]);
    // It signs nothing on Aave's chain and lists no action there.
    assert!(a.evm.signing.is_none() && a.get_state().pending.len() == 2);
}

#[test]
fn a_move_to_aaves_chain_whose_tokens_do_not_go_out_is_dropped() {
    let mut a = aave_account();
    at(OWNER, 1, H0 + 1);
    a.withdraw(id(NBTC), U128(55_000), id(DEP), to_evm_move()).detach();
    ctx(ACCOUNT, 0, H0 + 2, time(H0 + 2), vec![PromiseResult::Failed]);
    assert!(!a.on_sent(Some("move:0".into())));
    assert!(transfers(&a).is_empty());
    assert_eq!(get_logs(), vec!["transfer move:0 didn't go out: nothing was sent"]);
    // The next move doesn't take its name.
    assert_eq!(a.get_state().next_move, 1);
}

#[test]
fn a_move_to_aaves_chain_needs_aave_in_the_config_and_the_accounts_address_there() {
    // No Aave settings: there is nowhere for the token to go.
    let mut plain = account();
    at(OWNER, 1, H0 + 1);
    let none = refusal(|| plain.withdraw(id(NBTC), U128(5), id(DEP), to_evm_move()).detach());
    assert_eq!(none, "this account has no settings for aave");
    // Aave settings, but the account hasn't learnt its address.
    let mut no_address = lender_account(both());
    at(OWNER, 1, H0 + 1);
    let unknown = refusal(|| no_address.withdraw(id(NBTC), U128(5), id(DEP), to_evm_move()).detach());
    assert_eq!(unknown, "no Ethereum address yet: call hl_init first");
    for a in [&plain, &no_address] {
        assert!(calls().is_empty() && transfers(a).is_empty() && a.get_state().next_move == 0);
    }
    // And the rules of every withdrawal and every move hold.
    let mut a = aave_account();
    let mut refused = |who: &str, yocto: u128, token: &str, amount: u128, transfer: Option<Move>| {
        at(who, yocto, H0 + 1);
        refusal(|| a.withdraw(id(token), U128(amount), id(DEP), transfer).detach())
    };
    assert_eq!(refused("keeper.testnet", 1, NBTC, 5, to_evm_move()), "only the owner can do this");
    assert!(refused(OWNER, 0, NBTC, 5, to_evm_move()).contains("1 yoctoNEAR"));
    assert_eq!(refused(OWNER, 1, NBTC, 0, to_evm_move()), "amount must be positive");
    assert_eq!(refused(OWNER, 1, "other.testnet", 5, to_evm_move()), "not an allow-listed token");
    let late = Some(Move { kind: TransferKind::ToEvm, exp: NOW_MS, expect: None });
    assert_eq!(refused(OWNER, 1, NBTC, 5, late), "exp must be the quote's expiry, in the future, in unix ms");
    // The way home starts on Aave's chain, with `evm_withdraw`.
    let home = Some(Move { kind: TransferKind::EHome, exp: quote_exp(), expect: None });
    assert_eq!(refused(OWNER, 1, NBTC, 5, home), "an e_home move is evm_withdraw's");
    assert!(calls().is_empty() && transfers(&a).is_empty());
}

#[test]
fn while_the_account_owes_our_pool_a_move_to_aaves_chain_needs_the_verdict_a_withdrawal_needs() {
    let mut a = aave_account();
    a.loan = pool_loan();
    let try_it = |a: &mut Account, height: u64| {
        at(OWNER, 1, height);
        let before = transfers(a);
        let refused = refusal(|| a.withdraw(id(NBTC), U128(55_000), id(DEP), to_evm_move()).detach());
        assert!(calls().is_empty() && transfers(a) == before, "a refused move went out");
        refused
    };
    assert_eq!(try_it(&mut a, H0 + 1), "no verdict: ask for a check first");
    // A verdict for another amount, and one that allows nothing, don't back it.
    let allowing = |nonce: u64, blk: u64, amount: u64| {
        let mut v = verdict(nonce, blk);
        v["allow"]["withdraw"] = json!(amount);
        v
    };
    assert!(deliver(&mut a, withdraw_intent(NBTC, 54_999), &allowing(0, H0 + 2, 55_000), H0 + 3).accepted);
    let other = "with a loan open, a withdrawal needs a verdict for this token and amount";
    assert_eq!(try_it(&mut a, H0 + 4), other);
    assert!(deliver(&mut a, withdraw_intent(NBTC, 55_000), &allowing(0, H0 + 5, 0), H0 + 6).accepted);
    assert_eq!(try_it(&mut a, H0 + 7), "the verdict doesn't allow this withdrawal");
    // On a verdict for exactly this withdrawal it goes out, recorded, and the verdict backs nothing more.
    assert!(deliver(&mut a, withdraw_intent(NBTC, 55_000), &allowing(0, H0 + 8, 55_000), H0 + 9).accepted);
    at(OWNER, 1, H0 + 10);
    a.withdraw(id(NBTC), U128(55_000), id(DEP), to_evm_move()).detach();
    assert_eq!(methods(), vec!["storage_deposit", "ft_transfer", "on_sent"]);
    let sent = transfers(&a);
    assert_eq!((sent.len(), sent[0].kind, sent[0].token.as_str()), (1, TransferKind::ToEvm, NBTC));
    assert_eq!(a.get_state().counter, 1);
    assert_eq!(try_it(&mut a, H0 + 11), "the verdict was already used: ask for a new check");
}

#[test]
fn a_verdict_that_lists_a_move_to_aaves_chain_as_arrived_settles_it() {
    let mut a = aave_account();
    at(OWNER, 1, H0 + 1);
    a.withdraw(id(NBTC), U128(55_000), id(DEP), to_evm_move()).detach();
    at(OWNER, 1, H0 + 2);
    a.withdraw(id(USDC), U128(23_100_000), id(DEP), to_evm_move()).detach();
    // The account can't see Aave's chain: a verdict without it changes nothing.
    assert!(deliver(&mut a, Intent::Check {}, &aave_verdict(2, H0 + 3, 0, 0), H0 + 4).accepted);
    assert_eq!(transfers(&a).len(), 2);
    // The engine has found the bitcoin at the address.
    let mut v = aave_verdict(2, H0 + 5, 0, 0);
    v["arrived"] = json!(["move:0"]);
    assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 6).accepted);
    assert_eq!(events("transfer_done"), vec![json!({ "id": "move:0", "how": "verdict" })]);
    let left = transfers(&a);
    assert_eq!((left.len(), left[0].id.as_str(), a.get_state().counter), (1, "move:1", 2));
}

#[test]
fn a_move_to_aaves_chain_that_comes_back_on_near_is_settled_as_refunded() {
    let mut a = aave_account();
    at(OWNER, 1, H0 + 1);
    a.withdraw(id(NBTC), U128(55_000), id(DEP), to_evm_move()).detach();
    at(OWNER, 1, H0 + 2);
    a.withdraw(id(USDC), U128(23_100_000), id(DEP), to_evm_move()).detach();
    // 1Click sends back the token it was sent, with the transfer's msg.
    delivered(&mut a, NBTC, 55_000, "move:0", H0 + 3);
    assert_eq!(events("transfer_done"), vec![json!({ "id": "move:0", "how": "refunded" })]);
    delivered(&mut a, USDC, 23_100_000, "move:1", H0 + 4);
    assert_eq!(events("transfer_done"), vec![json!({ "id": "move:1", "how": "refunded" })]);
    assert!(transfers(&a).is_empty());
    // A refund that comes after a verdict settled the transfer names nothing under way, and is kept as a deposit.
    delivered(&mut a, NBTC, 55_000, "move:0", H0 + 5);
    assert!(get_logs().contains(&"no transfer move:0 is under way: kept as a deposit".to_string()));
    assert!(events("transfer_done").is_empty());
}

#[test]
fn an_overdue_move_to_aaves_chain_holds_back_borrowing_until_the_owner_forgets_it() {
    let late = move_deadline() + 1;
    let mut a = aave_account();
    at(OWNER, 1, H0 + 1);
    a.withdraw(id(NBTC), U128(55_000), id(DEP), to_evm_move()).detach();
    assert!(deliver_at(&mut a, borrow_intent(1_000_000_000), &verdict(1, H0 + 4), H0 + 5, late).accepted);
    ctx(OWNER, 1, H0 + 6, late, vec![]);
    let refused = refusal(|| a.borrow(U128(1_000_000_000)).detach());
    assert!(refused.starts_with("no borrow while transfer move:0 is overdue"), "{refused}");
    forget(&mut a, OWNER, 1, "move:0", late);
    assert_eq!(events("transfer_done"), vec![json!({ "id": "move:0", "how": "forgotten" })]);
    ctx(OWNER, 1, H0 + 7, late, vec![]);
    a.borrow(U128(1_000_000_000)).detach();
    assert_eq!(calls()[0].1, "borrow");
}

// e_home: evm_withdraw with exp.

#[test]
fn a_move_home_from_aaves_chain_signs_the_transfer_and_records_move_n_as_usdc() {
    let mut a = aave_account();
    at(OWNER, 1, H0 + 1);
    a.evm_withdraw(AAVE_USDC.into(), U128(23_033_364), ELSEWHERE.into(), Some(quote_exp()), None).detach();
    // The same signed transfer as without `exp`: transfer(the deposit address, the amount), sent to the token.
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
    let tx = evm_tx(0, EvmKind::Transfer, AAVE_USDC, transfer_data(&evm_address(ELSEWHERE), 23_033_364));
    assert_asked_to_sign(&tx);
    // It is listed as a transfer under way on Aave's chain, as before, and recorded as a 1Click transfer too: the
    // USDC is named as Hyperliquid's is, and the deposit address is in lower case.
    let listed = listed_at_aave(LenderKind::Transfer, 23_033_364, AAVE_USDC, 0);
    let home = e_home("move:0", "USDC", 23_033_364);
    assert_eq!(a.get_state().pending, vec![listed.clone(), Pending::Transfer(home.clone())]);
    let shape = json!({ "transfer": {
        "id": "move:0", "kind": "e_home", "token": "USDC", "amount": "23033364", "dep": ELSEWHERE.to_lowercase(),
        "deadline": home.deadline.0.to_string(),
    } });
    assert_eq!(pending_view(&a)[1], shape);
    assert_eq!((a.get_state().next_move, a.get_state().counter), (1, 1));
    assert_eq!(a.evm.signing.as_ref().and_then(|s| s.transfer.clone()).as_deref(), Some("move:0"));
    // Signed: the transaction is kept, and both stay under way.
    let entry = evm_signed(&mut a, signed_ok(), H0 + 3).expect("nothing was signed");
    assert_eq!((entry.nonce, entry.kind, entry.amount), (0, EvmKind::Transfer, U128(23_033_364)));
    assert_eq!(a.get_state().pending, vec![listed.clone(), Pending::Transfer(home)]);
    // The loan arrives on NEAR as the account's USDC, with the transfer's msg: that settles the 1Click transfer.
    // The token that came is not the one that was sent, so it has arrived, not come back.
    delivered(&mut a, USDC, 22_900_000, "move:0", H0 + 5);
    assert_eq!(events("transfer_done"), vec![json!({ "id": "move:0", "how": "arrived" })]);
    // The signed transfer stays listed until a verdict has seen its nonce used, as any signed transfer does.
    assert_eq!(a.get_state().pending, vec![listed]);
    assert!(deliver(&mut a, Intent::Check {}, &aave_verdict(1, H0 + 6, 0, 1), H0 + 7).accepted);
    assert!(a.get_state().pending.is_empty());
}

#[test]
fn a_move_home_of_collateral_is_recorded_with_the_tokens_address_and_arrives_as_bitcoin() {
    let mut a = aave_account();
    at(OWNER, 1, H0 + 1);
    a.evm_withdraw(WBTC.into(), U128(55_000), ELSEWHERE.into(), Some(quote_exp()), None).detach();
    assert_eq!(transfers(&a), vec![e_home("move:0", &WBTC.to_lowercase(), 55_000)]);
    assert!(evm_signed(&mut a, signed_ok(), H0 + 3).is_some());
    // WETH is recorded the same way, in its own 18 decimals.
    at(OWNER, 1, H0 + 4);
    a.evm_withdraw(WETH.into(), U128(WETH_AMOUNT), ELSEWHERE.into(), Some(quote_exp()), None).detach();
    assert_eq!(transfers(&a)[1], e_home("move:1", WETH, WETH_AMOUNT));
    assert!(evm_signed(&mut a, signed_ok(), H0 + 5).is_some());
    // Each comes home as bitcoin on NEAR.
    delivered(&mut a, NBTC, 54_000, "move:0", H0 + 6);
    assert_eq!(events("transfer_done"), vec![json!({ "id": "move:0", "how": "arrived" })]);
    delivered(&mut a, NBTC, 61_000, "move:1", H0 + 7);
    assert_eq!(events("transfer_done"), vec![json!({ "id": "move:1", "how": "arrived" })]);
    assert!(transfers(&a).is_empty());
}

#[test]
fn a_move_home_that_is_not_signed_leaves_no_transfer() {
    let unread =
        PromiseResult::Successful(br#"{"big_r":{"affine_point":"04ab"},"s":{"scalar":"00"},"recovery_id":0}"#.to_vec());
    // The signer fails: the 1Click transfer and the listing both go, the counter moves on, and the nonce stays free.
    let mut a = aave_account();
    at(OWNER, 1, H0 + 1);
    a.evm_withdraw(AAVE_USDC.into(), U128(23_033_364), ELSEWHERE.into(), Some(quote_exp()), None).detach();
    assert_eq!(evm_signed(&mut a, PromiseResult::Failed, H0 + 3), None);
    let logs = get_logs();
    assert_eq!(logs[0], "no Ethereum transaction signed, as the MPC signer failed or timed out");
    assert_eq!(logs[1], "transfer move:0 didn't go out: nothing was sent");
    assert!(a.get_state().pending.is_empty() && events("transfer_done").is_empty());
    assert_eq!((a.get_state().counter, a.get_state().next_move), (2, 1));
    assert_eq!(evm_view(&a), json!({ "nonce": 0, "signed": [], "approved": [] }));
    // The next move takes the next name and the nonce that wasn't used.
    at(OWNER, 1, H0 + 4);
    a.evm_withdraw(AAVE_USDC.into(), U128(23_033_364), ELSEWHERE.into(), Some(quote_exp()), None).detach();
    assert_eq!(transfers(&a), vec![e_home("move:1", "USDC", 23_033_364)]);
    assert_eq!(a.evm.signing.as_ref().map(|s| s.tx.nonce), Some(0));
    // The signer answers something the account can't read: nothing is kept to send, so the 1Click transfer goes.
    // The listing on Aave's chain stays, because a signature may exist.
    assert_eq!(evm_signed(&mut a, unread, H0 + 6), None);
    assert!(transfers(&a).is_empty());
    assert_eq!(a.get_state().pending, vec![listed_at_aave(LenderKind::Transfer, 23_033_364, AAVE_USDC, 0)]);
}

#[test]
fn without_exp_evm_withdraw_records_no_transfer_and_with_it_the_rules_of_a_move_hold() {
    let mut a = aave_account();
    at(OWNER, 1, H0 + 1);
    a.evm_withdraw(AAVE_USDC.into(), U128(5), ELSEWHERE.into(), None, None).detach();
    assert!(transfers(&a).is_empty() && a.get_state().next_move == 0);
    assert_eq!(a.evm.signing.as_ref().map(|s| s.transfer.clone()), Some(None));
    // While that one is being signed, a move home is refused before it takes a name.
    at(OWNER, 1, H0 + 2);
    let busy =
        refusal(|| a.evm_withdraw(AAVE_USDC.into(), U128(5), ELSEWHERE.into(), Some(quote_exp()), None).detach());
    assert_eq!(busy, "Ethereum transaction 0 is being signed: wait for the signer's answer");
    assert!(transfers(&a).is_empty() && a.get_state().next_move == 0);
    assert!(evm_signed(&mut a, signed_ok(), H0 + 3).is_some());
    // The quote's expiry must be in the future.
    at(OWNER, 1, H0 + 4);
    let late = refusal(|| a.evm_withdraw(AAVE_USDC.into(), U128(5), ELSEWHERE.into(), Some(NOW_MS), None).detach());
    assert_eq!(late, "exp must be the quote's expiry, in the future, in unix ms");
    // And at most 8 transfers are under way at once.
    for n in 0..8 {
        at(OWNER, 1, H0 + 5 + n);
        a.withdraw(id(USDC), U128(5), id(DEP), to_evm_move()).detach();
    }
    at(OWNER, 1, H0 + 20);
    let full =
        refusal(|| a.evm_withdraw(AAVE_USDC.into(), U128(5), ELSEWHERE.into(), Some(quote_exp()), None).detach());
    assert_eq!(full, "8 transfers are under way already: wait for one to settle");
    assert!(a.evm.signing.is_none() && transfers(&a).len() == 8);
}

#[test]
fn while_the_account_owes_our_pool_a_move_home_needs_the_verdict_evm_withdraw_needs() {
    let asked = Intent::EvmWithdraw { token: AAVE_USDC.to_lowercase(), amount: U128(23_033_364) };
    let allowing = |amount: u64| {
        let mut v = verdict(0, H0 + 5);
        v["allow"]["withdraw"] = json!(amount);
        v
    };
    let try_it = |a: &mut Account, height: u64| {
        at(OWNER, 1, height);
        let call =
            || a.evm_withdraw(AAVE_USDC.into(), U128(23_033_364), ELSEWHERE.into(), Some(quote_exp()), None).detach();
        let refused = refusal(call);
        assert!(calls().is_empty() && a.evm.signing.is_none());
        assert!(transfers(a).is_empty() && a.get_state().next_move == 0, "a refused move was recorded");
        refused
    };
    let mut a = aave_account();
    a.loan = pool_loan();
    assert_eq!(try_it(&mut a, H0 + 1), "no verdict: ask for a check first");
    assert!(deliver(&mut a, Intent::Check {}, &allowing(23_033_364), H0 + 6).accepted);
    let other = "with a loan open, an Ethereum withdrawal needs a verdict for this token and amount";
    assert_eq!(try_it(&mut a, H0 + 7), other);
    assert!(deliver(&mut a, asked.clone(), &allowing(0), H0 + 6).accepted);
    assert_eq!(try_it(&mut a, H0 + 7), "the verdict doesn't allow this withdrawal");
    // On a verdict for exactly this withdrawal the move is signed, listed and recorded.
    assert!(deliver(&mut a, asked, &allowing(23_033_364), H0 + 6).accepted);
    at(OWNER, 1, H0 + 7);
    a.evm_withdraw(AAVE_USDC.into(), U128(23_033_364), ELSEWHERE.into(), Some(quote_exp()), None).detach();
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
    let listed = listed_at_aave(LenderKind::Transfer, 23_033_364, AAVE_USDC, 0);
    assert_eq!(a.get_state().pending, vec![listed, Pending::Transfer(e_home("move:0", "USDC", 23_033_364))]);
    assert_eq!(a.get_state().counter, 1);
}

#[test]
fn a_bump_of_a_move_homes_transfer_leaves_its_1click_transfer_alone() {
    let mut a = aave_account();
    at(OWNER, 1, H0 + 1);
    a.evm_withdraw(AAVE_USDC.into(), U128(23_033_364), ELSEWHERE.into(), Some(quote_exp()), None).detach();
    assert!(evm_signed(&mut a, signed_ok(), H0 + 3).is_some());
    let before = a.get_state().pending;
    // Signed again with higher fees, or not signed again: the move is the same move.
    for answer in [signed_ok(), PromiseResult::Failed] {
        at(OWNER, 0, H0 + 4);
        let kept = a.evm.signed[0].tx.clone();
        a.evm_bump(0, U128(kept.max_fee * 11 / 10), U128(kept.tip * 11 / 10)).detach();
        assert_eq!(a.evm.signing.as_ref().map(|s| (s.bump, s.transfer.clone())), Some((true, None)));
        evm_signed(&mut a, answer, H0 + 5);
        assert_eq!(a.get_state().pending, before);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The fixes after the second audit pass (research/audit.md, "Second pass"; INTERFACES.md 40): A7, A8, A9, A12, A14
// ---------------------------------------------------------------------------------------------------------------

/// The block time at `height` in unix ms, as `at` sets it.
fn ms_at(height: u64) -> u64 {
    time(height) / 1_000_000
}

/// 1 January 2100, in unix ms.
const YEAR_2100_MS: u64 = 4_102_444_800_000;
const FAR: &str = "exp is more than 24 hours ahead: a 1Click quote lives a day at most";

/// The account's state as `get_state()` shows it, in JSON.
fn state_view(a: &Account) -> Value {
    near_sdk::serde_json::to_value(a.get_state()).unwrap()
}

// A7: no transfer is recorded with an expiry more than 24 hours ahead.

#[test]
fn no_move_is_recorded_with_an_expiry_more_than_24_hours_ahead() {
    // The hole (A7): with no loan and no verdict, an owner records a million dollars "on its way home" from an
    // address that never held it, with an expiry in 2100.
    let mut a = aave_account();
    at(OWNER, 1, H0 + 1);
    let million = U128(1_000_000_000_000);
    let call = || a.evm_withdraw(AAVE_USDC.into(), million, ELSEWHERE.into(), Some(YEAR_2100_MS), None).detach();
    assert_eq!(refusal(call), FAR);
    assert!(calls().is_empty() && a.get_state().pending.is_empty() && a.evm.signing.is_none());
    // The second way: a withdrawal to the owner's own wallet, labelled as a move of any kind.
    for (token, kind) in [(USDC, TransferKind::ToHl), (USDC, TransferKind::ToEvm), (NBTC, TransferKind::Sell)] {
        at(OWNER, 1, H0 + 1);
        let far = Some(Move { kind, exp: YEAR_2100_MS, expect: None });
        assert_eq!(refusal(|| a.withdraw(id(token), U128(5), id(OWNER), far).detach()), FAR, "{kind:?}");
    }
    // And a move home from Hyperliquid.
    at(OWNER, 1, H0 + 1);
    let call = || a.hl_withdraw(U128(5), FLOAT.into(), None, Some(YEAR_2100_MS), None).detach();
    assert_eq!(refusal(call), FAR);
    assert!(calls().is_empty() && a.get_state().pending.is_empty() && a.get_state().next_move == 0);
    // A day and a millisecond is too far. A day is the longest a 1Click quote lives, and is taken.
    at(OWNER, 1, H0 + 2);
    let over = Some(Move { kind: TransferKind::ToHl, exp: ms_at(H0 + 2) + DAY_MS + 1, expect: None });
    assert_eq!(refusal(|| a.withdraw(id(USDC), U128(5), id(DEP), over).detach()), FAR);
    at(OWNER, 1, H0 + 2);
    let day = Some(Move { kind: TransferKind::ToHl, exp: ms_at(H0 + 2) + DAY_MS, expect: None });
    a.withdraw(id(USDC), U128(5), id(DEP), day).detach();
    assert_eq!(transfers(&a).len(), 1);
    at(OWNER, 1, H0 + 3);
    a.evm_withdraw(AAVE_USDC.into(), U128(5), ELSEWHERE.into(), Some(ms_at(H0 + 3) + DAY_MS), None).detach();
    assert_eq!(transfers(&a).len(), 2);
}

#[test]
fn a_plan_step_whose_quote_expires_more_than_24_hours_ahead_sends_nothing() {
    // The engine never makes such a step. If it is wrong, the account still records no such transfer.
    let far = "the step's quote expires more than 24 hours ahead";
    let dep = FLOAT.to_string();
    let steps = [
        json!({ "k": "to_hl", "amt": "100000000", "dep": DEP, "exp": YEAR_2100_MS }),
        json!({ "k": "sell", "tok": NBTC, "amt": "1500000", "min": 1_100_000_000u64, "dep": DEP, "exp": YEAR_2100_MS }),
        json!({ "k": "home", "amt": 5_000_000u64, "dep": dep, "exp": YEAR_2100_MS }),
    ];
    // What step 0, run by the keeper at H0 + 25, is refused with.
    let refused = |a: &mut Account| {
        at("keeper.testnet", 0, H0 + 25);
        refusal(|| a.execute_step(PID.into(), 0).detach())
    };
    for step in steps {
        let mut a = with_plan(json!([step.clone()]));
        assert_eq!(refused(&mut a), far, "{step}");
        assert!(!step_done(&a, 0) && a.get_state().counter == LOANED && transfers(&a).is_empty());
    }
    // A day and a millisecond is too far, and a day runs.
    let mut a = with_plan(json!([to_hl_step(100_000_000, ms_at(H0 + 25) + DAY_MS + 1)]));
    assert_eq!(refused(&mut a), far);
    let mut a = with_plan(json!([to_hl_step(100_000_000, ms_at(H0 + 25) + DAY_MS)]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert_eq!(calls()[0].1, "check_step");
}

// A8: set_permission leaves the counter alone, and a check read before it backs nothing at a lender.

#[test]
fn set_permission_leaves_the_counter_alone_so_a_check_on_its_way_still_arrives() {
    // The hole (A8): an owner whose account was going bad called set_permission each time a check was asked for,
    // and the check, read for the old counter, arrived stale. No margin call, no unwind.
    let mut a = with_loan();
    let counter = a.get_state().counter;
    at(OWNER, 1, H0 + 30);
    a.set_permission(Some(permission(&[])));
    assert_eq!(events("permission_set").len(), 1);
    assert_eq!(a.get_state().counter, counter, "set_permission moved the counter");
    // The check that was on its way, read a block earlier for the counter as it was, arrives and is kept.
    let unwind = with_nonce(deleverage(H0 + 29, 3_000), counter);
    let outcome = deliver(&mut a, Intent::Check {}, &unwind, H0 + 31);
    assert!(outcome.accepted, "{:?}", outcome.reason);
    assert_eq!(state_view(&a)["verdict"]["verdict"]["action"], "DELEVERAGE");
    // However often the owner calls it.
    for height in [H0 + 32, H0 + 33, H0 + 34] {
        at(OWNER, 1, height);
        a.set_permission(None);
    }
    assert_eq!(a.get_state().counter, counter);
}

#[test]
fn get_state_shows_the_block_the_permission_last_changed() {
    // 0 if none was ever set; the block of `new` when a permission came with it.
    for a in [account(), lender_account(None)] {
        assert_eq!(state_view(&a)["permission_blk"], json!(0));
    }
    let mut a = lender_account(both());
    assert_eq!(state_view(&a)["permission_blk"], json!(H0));
    // Then the block of the last set_permission, a cancel included.
    at(OWNER, 1, H0 + 7);
    a.set_permission(Some(permission(&["rhea"])));
    assert_eq!(state_view(&a)["permission_blk"], json!(H0 + 7));
    at(OWNER, 1, H0 + 9);
    a.set_permission(None);
    assert_eq!(state_view(&a)["permission_blk"], json!(H0 + 9));
}

/// What the stored-permission rule answers for a check read at or before block `blk`.
fn before_permission(blk: u64) -> String {
    format!("the check was read before the permission last changed (block {blk}): ask for a new check")
}

#[test]
fn fund_refuses_a_check_read_at_or_before_the_block_the_permission_last_changed() {
    let mut a = lender_account(both());
    at(OWNER, 1, H0 + 6);
    a.set_permission(both());
    // A check read a block before the change arrives after it and is kept: the counter didn't move. But it was
    // made under the old permission, so it backs no funding plan.
    assert!(deliver(&mut a, fund_intent(ASKED), &fund_verdict(0, H0 + 5, three_steps()), H0 + 7).accepted);
    at(OWNER, 1, H0 + 8);
    assert_eq!(refusal(|| drop(a.fund(U128(ASKED)))), before_permission(H0 + 6));
    // Nor does one read in the same block.
    assert!(deliver(&mut a, fund_intent(ASKED), &fund_verdict(0, H0 + 6, three_steps()), H0 + 9).accepted);
    at(OWNER, 1, H0 + 10);
    assert_eq!(refusal(|| drop(a.fund(U128(ASKED)))), before_permission(H0 + 6));
    assert!(a.get_state().funding.is_none() && a.get_state().counter == 0);
    // One read a block later does.
    assert!(deliver(&mut a, fund_intent(ASKED), &fund_verdict(0, H0 + 7, three_steps()), H0 + 11).accepted);
    at(OWNER, 1, H0 + 12);
    assert_eq!(a.fund(U128(ASKED)).pid, "f1007");
    // An account opened with its permission counts from the block it was opened in.
    let mut a = lender_account(both());
    assert!(deliver(&mut a, fund_intent(ASKED), &fund_verdict(0, H0, three_steps()), H0 + 1).accepted);
    at(OWNER, 1, H0 + 2);
    assert_eq!(refusal(|| drop(a.fund(U128(ASKED)))), before_permission(H0));
}

#[test]
fn a_borrow_step_at_a_lender_refuses_a_check_read_before_the_permission_last_changed() {
    // Rhea.
    let mut a = ready_for_rhea(4_000_000_000);
    at(OWNER, 1, H0 + 12);
    a.set_permission(both());
    assert_eq!(step_refused(&mut a, FID, 1, H0 + 13, time(H0 + 13)), before_permission(H0 + 12));
    assert!(!fund_step_done(&a, 1) && a.get_state().counter == 1 && a.get_state().pending.is_empty());
    assert!(deliver(&mut a, Intent::Check {}, &rhea_verdict(1, H0 + 13, 4_000_000_000), H0 + 14).accepted);
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 15);
    assert_eq!(methods(), vec!["settle", "on_step_settled"]);
    // Aave.
    let mut a = ready_for_aave();
    at(OWNER, 1, H0 + 13);
    a.set_permission(both());
    assert_eq!(step_refused(&mut a, FID, 1, H0 + 14, time(H0 + 14)), before_permission(H0 + 13));
    assert!(!fund_step_done(&a, 1) && a.evm.signing.is_none() && a.get_state().pending.is_empty());
    assert!(deliver(&mut a, Intent::Check {}, &aave_verdict(3, H0 + 14, 4_000_000_000, 0), H0 + 15).accepted);
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 16);
    assert_eq!(methods(), vec!["settle", "on_step_settled"]);
}

#[test]
fn a_collateral_step_that_reads_a_check_refuses_one_read_before_the_permission_last_changed() {
    // With no loan from our pool an l_supply step reads no check, so the permission's block doesn't hold it back.
    let mut a = funded_at_aave();
    at(OWNER, 1, H0 + 9);
    a.set_permission(both());
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 10);
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
    // While the account owes our pool it reads one, which must have been read after the change.
    let mut a = funded_at_aave();
    a.loan = pool_loan();
    at(OWNER, 1, H0 + 9);
    a.set_permission(both());
    assert!(deliver(&mut a, Intent::Check {}, &verdict(1, H0 + 9), H0 + 10).accepted);
    assert_eq!(step_refused(&mut a, FID, 0, H0 + 11, time(H0 + 11)), before_permission(H0 + 9));
    assert!(!fund_step_done(&a, 0) && a.evm.signing.is_none());
    assert!(deliver(&mut a, Intent::Check {}, &verdict(1, H0 + 10), H0 + 12).accepted);
    run_step(&mut a, "keeper.testnet", FID, 0, H0 + 13);
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
}

#[test]
fn a_top_ups_l_add_step_refuses_a_check_read_before_the_permission_last_changed() {
    // The plan came from a check read at H0 + 20, and the permission changes two blocks later.
    let add = json!({ "k": "l_add", "l": "aave", "tok": WETH, "amt": WETH_AMOUNT.to_string() });
    let mut a = with_aave_top_up(json!([add.clone()]));
    at(OWNER, 1, H0 + 22);
    a.set_permission(None);
    assert_eq!(step_refused(&mut a, PID, 0, H0 + 25, time(H0 + 25)), before_permission(H0 + 22));
    assert!(!step_done(&a, 0) && a.evm.signing.is_none() && a.get_state().counter == 0);
    // A new check orders the top-up again. The stored plan is kept, and its step runs under that check.
    let mut again = rebalance(0, H0 + 26, json!([add]));
    again["ext"] = json!([ext_line("aave")]);
    assert!(deliver(&mut a, Intent::Check {}, &again, H0 + 27).accepted);
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 28);
    assert!(methods().contains(&"sign".to_string()));
}

#[test]
fn a_top_ups_l_repay_step_still_repays_on_a_check_read_before_the_permission_changed_and_skips_its_settlement() {
    // Repaying never stops. A check read before the permission changed backs nothing at a lender, so the pool
    // isn't asked to settle on it. The repayment itself goes out all the same.
    let repay = json!({ "k": "l_repay", "l": "aave", "amt": 10_133_000_000u64 });
    // With no change of the permission, the pool settles beside the repayment.
    let mut a = with_aave_top_up(json!([repay.clone()]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert_eq!(methods(), vec!["settle", "on_settled", "sign", "on_evm_signed"]);
    // The plan came from a check read at H0 + 20, and the permission changes two blocks later: only the repayment.
    let mut a = with_aave_top_up(json!([repay]));
    at(OWNER, 1, H0 + 22);
    a.set_permission(None);
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
    let (usdc, me) = (evm_address(AAVE_USDC), evm_address(ADDRESS));
    assert_asked_to_sign(&evm_tx(0, EvmKind::Repay, AAVE_POOL, repay_data(&usdc, Some(10_133_000_000), &me)));
    assert_eq!(events("step_run"), vec![json!({ "pid": PID, "i": 0, "k": "l_repay" })]);
    assert!(step_done(&a, 0) && a.get_state().counter == 0);
    // Rhea's repayment step the same: it reads the account's USDC and repays, and the pool isn't asked.
    let mut a = with_top_up(both(), json!([l_repay_step()]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert_eq!(methods(), vec!["settle", "on_settled", "ft_balance_of", "on_repay_ready"]);
    let mut a = with_top_up(both(), json!([l_repay_step()]));
    at(OWNER, 1, H0 + 22);
    a.set_permission(both());
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert_eq!(methods(), vec!["ft_balance_of", "on_repay_ready"]);
    assert!(step_done(&a, 0));
    // A check read after the change settles again.
    let mut again = rebalance(0, H0 + 26, json!([l_repay_step()]));
    again["ext"] = json!([ext_line("rhea")]);
    assert!(deliver(&mut a, Intent::Check {}, &again, H0 + 27).accepted);
    run_step(&mut a, "keeper.testnet", "1026", 0, H0 + 28);
    assert_eq!(methods(), vec!["settle", "on_settled", "ft_balance_of", "on_repay_ready"]);
}

// A9: anyone but the owner repays all of Aave's debt or nothing, one repayment at a time.

/// An Aave account holding a DELEVERAGE verdict read at `blk`, which opens repaying to anyone: it shows $50,667 owed
/// at Aave, and `chain_nonce` as the address's next nonce there (none if the engine didn't read it).
fn unwinding_at_aave(a: &mut Account, blk: u64, chain_nonce: Option<u64>) {
    let mut unwind = with_nonce(deleverage(blk, 0), a.get_state().counter);
    unwind["ext"] = json!([ext_line("aave")]);
    if let Some(nonce) = chain_nonce {
        unwind["evm"] = json!({ "nonce": nonce });
    }
    assert!(deliver(a, Intent::Check {}, &unwind, blk + 1).accepted);
}

#[test]
fn anyone_but_the_owner_repays_all_of_aaves_debt_or_nothing() {
    // The hole (A9): a stranger had the account sign repayments of 1 micro-USD without limit, each holding the one
    // signing slot and taking a nonce, while the keeper's own top-up waited.
    let mut a = aave_account();
    unwinding_at_aave(&mut a, H0 + 7, Some(0));
    let part = "anyone but the owner repays all of Aave's debt (50667000000) or nothing";
    for amount in [1, 50_666_999_999] {
        assert_eq!(lender_repay_refused(&mut a, "stranger.testnet", 1, "aave", amount), part);
    }
    assert!(a.evm.signing.is_none() && evm_view(&a)["nonce"] == 0);
    // The whole debt goes out, as "all of it".
    at("stranger.testnet", 1, H0 + 9);
    a.lender_repay("aave".into(), U128(50_667_000_000)).detach();
    let (usdc, me) = (evm_address(AAVE_USDC), evm_address(ADDRESS));
    assert_asked_to_sign(&evm_tx(0, EvmKind::Repay, AAVE_POOL, repay_data(&usdc, None, &me)));
    assert!(evm_signed(&mut a, signed_ok(), H0 + 10).is_some());
    // The owner repays any part, as before.
    at(OWNER, 1, H0 + 11);
    a.lender_repay("aave".into(), U128(1)).detach();
    assert!(methods().contains(&"sign".to_string()));
    assert_eq!(evm_signed(&mut a, PromiseResult::Failed, H0 + 12), None);
}

#[test]
fn anyone_but_the_owner_waits_until_a_check_shows_the_signed_repayment_mined() {
    let mut a = aave_account();
    unwinding_at_aave(&mut a, H0 + 7, Some(0));
    at("stranger.testnet", 1, H0 + 9);
    a.lender_repay("aave".into(), U128(50_667_000_000)).detach();
    assert!(evm_signed(&mut a, signed_ok(), H0 + 10).is_some());
    // The repayment is signed with nonce 0 and the held check found the chain's next nonce at 0: it isn't mined.
    let waiting = "a repayment at Aave is signed and not mined yet (nonce 0): send it, then ask for a check";
    assert_eq!(lender_repay_refused(&mut a, "stranger.testnet", 1, "aave", 50_667_000_000), waiting);
    assert_eq!(lender_repay_refused(&mut a, "keeper.testnet", 1, "aave", 900_000_000_000), waiting);
    assert!(a.evm.signing.is_none() && evm_view(&a)["nonce"] == 1);
    // A check that didn't read Aave's chain shows nothing mined.
    unwinding_at_aave(&mut a, H0 + 20, None);
    assert_eq!(lender_repay_refused(&mut a, "stranger.testnet", 1, "aave", 50_667_000_000), waiting);
    // The owner isn't held back.
    at(OWNER, 1, H0 + 22);
    a.lender_repay("aave".into(), U128(5)).detach();
    assert!(methods().contains(&"sign".to_string()));
    assert_eq!(evm_signed(&mut a, PromiseResult::Failed, H0 + 23), None);
    // Once a check shows the chain has used nonce 0, and a debt is still there, anyone repays it again.
    unwinding_at_aave(&mut a, H0 + 30, Some(1));
    at("stranger.testnet", 1, H0 + 32);
    a.lender_repay("aave".into(), U128(50_667_000_000)).detach();
    assert!(methods().contains(&"sign".to_string()));
    assert_eq!(a.evm.signing.as_ref().map(|s| s.tx.nonce), Some(1));
}

#[test]
fn rheas_repayment_and_the_plans_repay_step_are_not_held_to_aaves_rule() {
    // At Rhea anyone repays a part, as before: Rhea takes it at once, and nothing is signed.
    let mut a = lender_account(both());
    let mut unwind = deleverage(H0 + 5, 0);
    unwind["ext"] = json!([ext_line("rhea")]);
    assert!(deliver(&mut a, Intent::Check {}, &unwind, H0 + 6).accepted);
    at("stranger.testnet", 1, H0 + 7);
    a.lender_repay("rhea".into(), U128(1)).detach();
    assert!(methods().contains(&"ft_transfer_call".to_string()));
    // A top-up's l_repay step at Aave repays the step's amount, a part of the debt, while a signed repayment waits.
    let mut a = with_aave_top_up(json!([{ "k": "l_repay", "l": "aave", "amt": 10_133_000_000u64 }]));
    at(OWNER, 1, H0 + 22);
    a.lender_repay("aave".into(), U128(5)).detach();
    assert!(evm_signed(&mut a, signed_ok(), H0 + 23).is_some());
    run_step(&mut a, "anyone.testnet", PID, 0, H0 + 25);
    assert!(methods().contains(&"sign".to_string()));
}

// A12, in part: a transfer that leaves NEAR for good is settled by a deposit with its msg only as a refund.

#[test]
fn a_deposit_with_the_msg_of_a_move_that_left_near_settles_it_only_as_a_refund() {
    // The hole (A12): one unit of a listed token with a transfer's msg, from anyone, settled that transfer.
    let mut a = aave_account();
    at(OWNER, 1, H0 + 1);
    a.withdraw(id(USDC), U128(25_000_000), id(DEP), to_hl_move()).detach();
    at(OWNER, 1, H0 + 2);
    a.withdraw(id(NBTC), U128(55_000), id(DEP), to_evm_move()).detach();
    let kept = |id: &str| format!("kept as a deposit: not a refund of transfer {id}");
    // Not the token it sent, or under 80% of what it sent: the tokens are kept, and the record stays.
    let not_refunds =
        [(USDC, 1, "move:0"), (NBTC, 25_000_000, "move:0"), (USDC, 19_999_999, "move:0"), (NBTC, 1, "move:1")];
    for (height, (token, amount, id)) in not_refunds.into_iter().enumerate() {
        delivered(&mut a, token, amount, id, H0 + 3 + height as u64);
        assert!(get_logs().contains(&kept(id)), "{:?}", get_logs());
        assert!(events("transfer_done").is_empty(), "{amount} of {token} settled {id}");
    }
    delivered(&mut a, USDC, 55_000, "move:1", H0 + 8);
    delivered(&mut a, NBTC, 43_999, "move:1", H0 + 9);
    assert!(events("transfer_done").is_empty());
    assert_eq!(transfers(&a).len(), 2);
    // The token it sent, 80% of the amount or more: a refund.
    delivered(&mut a, USDC, 20_000_000, "move:0", H0 + 10);
    assert_eq!(events("transfer_done"), vec![json!({ "id": "move:0", "how": "refunded" })]);
    delivered(&mut a, NBTC, 44_000, "move:1", H0 + 11);
    assert_eq!(events("transfer_done"), vec![json!({ "id": "move:1", "how": "refunded" })]);
    assert!(transfers(&a).is_empty());
}

#[test]
fn a_plans_move_to_hyperliquid_is_settled_by_a_verdict_or_a_refund_and_by_nothing_else() {
    let mut a = with_plan(json!([to_hl_step(100_000_000, quote_exp())]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert!(step_ready(&mut a, PID, 0, checked(), H0 + 27));
    delivered(&mut a, USDC, 1, "1020:0", H0 + 28);
    assert!(get_logs().contains(&"kept as a deposit: not a refund of transfer 1020:0".to_string()));
    assert_eq!(transfers(&a).len(), 1);
    let mut v = verdict(a.get_state().counter, H0 + 40);
    v["arrived"] = json!(["1020:0"]);
    assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 41).accepted);
    assert_eq!(events("transfer_done"), vec![json!({ "id": "1020:0", "how": "verdict" })]);
}

#[test]
fn a_sale_and_the_moves_home_settle_on_their_msg_as_before() {
    // Their delivery arrives in another token, and the record holds no floor for it (the open part of A12).
    let mut a = aave_account();
    at(OWNER, 1, H0 + 1);
    a.withdraw(
        id(NBTC),
        U128(1_500_000),
        id(DEP),
        Some(Move { kind: TransferKind::Sell, exp: quote_exp(), expect: None }),
    )
    .detach();
    at(OWNER, 1, H0 + 2);
    a.evm_withdraw(AAVE_USDC.into(), U128(23_033_364), ELSEWHERE.into(), Some(quote_exp()), None).detach();
    assert!(evm_signed(&mut a, signed_ok(), H0 + 3).is_some());
    at(OWNER, 1, H0 + 4);
    a.hl_withdraw(U128(9_500_000_000), FLOAT.into(), None, Some(quote_exp()), None).detach();
    for (height, id) in ["move:0", "move:1", "move:2"].into_iter().enumerate() {
        delivered(&mut a, USDC, 1, id, H0 + 5 + height as u64);
        assert_eq!(events("transfer_done"), vec![json!({ "id": id, "how": "arrived" })]);
    }
    assert!(transfers(&a).is_empty());
}

// A14: at most 8 signed transactions are listed on Aave's chain at once.

#[test]
fn at_most_8_ethereum_transactions_are_listed_at_once() {
    // The hole (A14): with no loan from our pool the owner could add listings without limit.
    let mut a = aave_account();
    for n in 0..8u64 {
        at(OWNER, 1, H0 + 1 + 2 * n);
        if n % 2 == 0 {
            a.evm_withdraw(WETH.into(), U128(5), ELSEWHERE.into(), None, None).detach();
        } else {
            a.lender_withdraw("aave".into(), WETH.into(), U128(5)).detach();
        }
        assert!(evm_signed(&mut a, signed_ok(), H0 + 2 + 2 * n).is_some());
    }
    let (listed, counter) = (a.get_state().pending, a.get_state().counter);
    assert_eq!((listed.len(), counter), (8, 8));
    let full = "8 Ethereum transactions are listed already: send them, then ask for a check";
    at(OWNER, 1, H0 + 20);
    assert_eq!(refusal(|| a.evm_withdraw(WETH.into(), U128(5), ELSEWHERE.into(), None, None).detach()), full);
    at(OWNER, 1, H0 + 20);
    assert_eq!(
        refusal(|| a.evm_withdraw(WETH.into(), U128(5), ELSEWHERE.into(), Some(quote_exp()), None).detach()),
        full
    );
    at(OWNER, 1, H0 + 20);
    assert_eq!(refusal(|| a.lender_withdraw("aave".into(), WETH.into(), U128(5)).detach()), full);
    assert!(calls().is_empty() && a.evm.signing.is_none());
    assert_eq!((a.get_state().pending, a.get_state().counter, a.get_state().next_move), (listed, counter, 0));
    // A check that shows them mined drops them, and there is room again.
    assert!(deliver(&mut a, Intent::Check {}, &aave_verdict(counter, H0 + 21, 0, 8), H0 + 22).accepted);
    assert!(a.get_state().pending.is_empty());
    at(OWNER, 1, H0 + 23);
    a.evm_withdraw(WETH.into(), U128(5), ELSEWHERE.into(), None, None).detach();
    assert_eq!(methods(), vec!["sign", "on_evm_signed"]);
}

// ---------------------------------------------------------------------------------------------------------------
// The pool's finding P4, the account's part (research/audit.md, "Second pass"; INTERFACES.md 45, item 8): at a
// borrow from a lender the pool is told both ends of the period
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn a_borrow_step_tells_the_pool_the_debts_as_they_stood_and_no_other_settlement_does() {
    let line = |l: &str, debt: &str| json!({ "lender": l, "debt": debt, "rate_bp": 1591, "supply_bp": 1032 });
    // Rhea. The verdict shows $50,667 owed at each lender, and the step borrows $2,500 more at Rhea. `closes` is
    // the verdict's own lines: the period up to now ends on the debts as they stood. `report` has the borrow added:
    // the next period starts there. Without `closes` the pool took one figure for both ends, and charged or paid
    // for debt that wasn't there yet (P4).
    let mut a = funded(three_steps());
    a.funding.as_mut().unwrap().steps[0].done = true;
    let mut v = rhea_verdict(1, H0 + 10, 2_500_000_000);
    let rhea = v["ext"][0].clone();
    v["ext"] = json!([ext_line("aave"), rhea]);
    assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 11).accepted);
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 12);
    let sent = call_of("settle").1;
    assert_eq!(sent["closes"], json!([line("aave", "50667000000"), line("rhea", "50667000000")]));
    assert_eq!(sent["report"], json!([line("aave", "50667000000"), line("rhea", "53167000000")]));
    assert_eq!(sent.as_object().unwrap().len(), 2);
    // Aave: the same, for the $4,000 its step borrows.
    let mut a = ready_for_aave();
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 13);
    let sent = call_of("settle").1;
    let both_ends = json!({ "report": [line("aave", "54667000000")], "closes": [line("aave", "50667000000")] });
    assert_eq!(sent, both_ends);
    // Every other settlement passes the verdict's lines alone, as before: nothing changed between its two ends.
    let only_report = |sent: Value, lender: &str| {
        assert_eq!(sent, json!({ "report": [line(lender, "50667000000")] }), "{lender}");
        assert!(sent.get("closes").is_none());
    };
    // `settle`, and the settlement beside a repayment, at Rhea and at Aave.
    let mut a = lender_account(both());
    assert!(deliver(&mut a, Intent::Check {}, &rhea_verdict(0, H0 + 5, 0), H0 + 6).accepted);
    at("keeper.testnet", 0, H0 + 8);
    a.settle().detach();
    only_report(call_of("settle").1, "rhea");
    at(OWNER, 1, H0 + 8);
    a.lender_repay("rhea".into(), U128(5)).detach();
    only_report(call_of("settle").1, "rhea");
    let mut a = aave_account();
    assert!(deliver(&mut a, Intent::Check {}, &aave_verdict(0, H0 + 5, 0, 0), H0 + 6).accepted);
    at(OWNER, 1, H0 + 8);
    a.lender_repay("aave".into(), U128(5)).detach();
    only_report(call_of("settle").1, "aave");
    // And the one beside a top-up's repayment step.
    let mut a = with_top_up(both(), json!([l_repay_step()]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    only_report(call_of("settle").1, "rhea");
    let mut a = with_aave_top_up(json!([{ "k": "l_repay", "l": "aave", "amt": 10_133_000_000u64 }]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    only_report(call_of("settle").1, "aave");
}

// ---------------------------------------------------------------------------------------------------------------
// The account's Low findings (research/audit.md, "Second pass"; INTERFACES.md 47): A16, A17 point 3, A10, A13
// ---------------------------------------------------------------------------------------------------------------

/// As `ctx`, with the account holding `free` yoctoNEAR above what its 500 KB of storage locks.
fn ctx_with_free_near(who: &str, yocto: u128, height: u64, results: Vec<PromiseResult>, free: u128) {
    let locked = 500_000 * 10u128.pow(19);
    let context = VMContextBuilder::new()
        .current_account_id(id(ACCOUNT))
        .predecessor_account_id(id(who))
        .attached_deposit(NearToken::from_yoctonear(yocto))
        .block_height(height)
        .block_timestamp(time(height))
        .prepaid_gas(Gas::from_tgas(300))
        .storage_usage(500_000)
        .account_balance(NearToken::from_yoctonear(locked + free))
        .build();
    testing_env!(context, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
}

// A16: the account's own NEAR.

#[test]
fn a_withdrawal_pays_a_new_receivers_registration_only_while_the_account_keeps_its_near_reserve() {
    // The hole (A16): each withdrawal to a new receiver paid 0.00125 NEAR of the account's own, with no floor, so an
    // owner with no loan could spend what a later verdict's storage needs.
    let (reserve, fee) = (3 * 10u128.pow(23), 1_250 * 10u128.pow(18));
    let mut a = account();
    // The reserve of 0.3 NEAR is still there after the registration: it is paid, as before.
    ctx_with_free_near(OWNER, 1, H0 + 1, vec![], reserve + fee + 1_000);
    a.withdraw(id(NBTC), U128(5), id("new.testnet"), None).detach();
    assert_eq!(methods(), vec!["storage_deposit", "ft_transfer", "on_sent"]);
    // It wouldn't be: the tokens go out without it, and reach only a receiver the token knows already.
    ctx_with_free_near(OWNER, 1, H0 + 2, vec![], reserve + fee - 1_000);
    a.withdraw(id(NBTC), U128(5), id("new.testnet"), None).detach();
    assert_eq!(methods(), vec!["ft_transfer", "on_sent"]);
    assert_eq!(call_of("ft_transfer").1, json!({ "receiver_id": "new.testnet", "amount": "5" }));
    // If the token doesn't know the receiver, nothing goes out and `on_sent` says so, as for any failed send.
    ctx(ACCOUNT, 0, H0 + 3, time(H0 + 3), vec![PromiseResult::Failed]);
    assert!(!a.on_sent(None));
    // A plan step's own send, the unwind, pays the registration with no reserve, as before.
    let mut a = with_plan(json!([to_hl_step(100_000_000, quote_exp())]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    ctx_with_free_near(ACCOUNT, 0, H0 + 27, vec![checked()], 0);
    assert!(matches!(a.on_step_ready(PID.into(), 0), PromiseOrValue::Promise(_)));
    assert_eq!(methods(), vec!["storage_deposit", "ft_transfer", "on_sent"]);
}

// A17, point 3: the permission's rate and cushion hold at a borrow step.

#[test]
fn a_borrow_step_holds_the_lender_to_the_permissions_rate_and_cushion() {
    // The hole (A17): the permission's `max_rate_bp` and `min_hf_bp` were stored and never read on chain. The
    // permission here allows 25% a year and asks for a cushion of 1.5.
    let with_line = |r_bp: u64, d: u64, hf_bp: u64| {
        let mut a = ready_for_rhea(4_000_000_000);
        let mut v = rhea_verdict(1, H0 + 12, 4_000_000_000);
        v["ext"][0]["r_bp"] = json!(r_bp);
        v["ext"][0]["d"] = json!(d);
        v["ext"][0]["hf_bp"] = json!(hf_bp);
        assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 13).accepted);
        a
    };
    let refused = |a: &mut Account| {
        let refused = step_refused(a, FID, 1, H0 + 14, time(H0 + 14));
        assert!(!fund_step_done(a, 1) && a.get_state().pending.is_empty() && a.get_state().counter == 1);
        refused
    };
    // The lender's rate is above the permission's: nothing is borrowed there.
    let mut a = with_line(2_501, 0, 0);
    assert_eq!(refused(&mut a), "Rhea's rate (2501 bp) is above the 2500 bp the permission allows");
    // The lender is owed already and the cushion there is under the permission's.
    let mut a = with_line(1_591, 50_667_000_000, 14_999);
    assert_eq!(refused(&mut a), "the cushion at Rhea (14999 bp) is under the 15000 bp the permission asks for");
    // At the permission's own figures the step runs. With nothing owed there yet, there is no cushion to ask for.
    for (r_bp, d, hf_bp) in [(2_500, 50_667_000_000, 15_000), (1_591, 0, 0)] {
        let mut a = with_line(r_bp, d, hf_bp);
        run_step(&mut a, "keeper.testnet", FID, 1, H0 + 14);
        assert_eq!(methods(), vec!["settle", "on_step_settled"]);
    }
    // Aave is held to the same.
    let mut a = ready_for_aave();
    let mut v = aave_verdict(3, H0 + 13, 4_000_000_000, 0);
    v["ext"][0]["r_bp"] = json!(2_501);
    assert!(deliver(&mut a, Intent::Check {}, &v, H0 + 14).accepted);
    let words = step_refused(&mut a, FID, 1, H0 + 15, time(H0 + 15));
    assert_eq!(words, "Aave's rate (2501 bp) is above the 2500 bp the permission allows");
    assert!(a.evm.signing.is_none() && a.get_state().pending.is_empty());
}

// A10: a bump's fees.

#[test]
fn a_bump_raises_the_fee_by_an_eighth_at_most_and_anyone_but_the_owner_waits_a_minute() {
    // The hole (A10): anyone could bump a transaction straight to the fee limit, which used up all the room for
    // later bumps and made the account pay its full limit. The supply here was signed at H0 + 10 at 0.5 gwei.
    let mut a = with_a_signed_supply();
    let eighth = "a bump raises the fee by an eighth at most: 562500000 wei a gas";
    // A minute is 100 of the test's blocks. The owner bumps at once, but by no more than an eighth.
    at(OWNER, 0, H0 + 12);
    assert_eq!(refusal(|| a.evm_bump(0, U128(MAX_FEE), U128(2_000_000)).detach()), eighth);
    at(OWNER, 0, H0 + 12);
    assert_eq!(refusal(|| a.evm_bump(0, U128(562_500_001), U128(2_000_000)).detach()), eighth);
    assert!(a.evm.signing.is_none());
    // Anyone else waits until the kept transaction is 60 seconds old.
    at("anyone.testnet", 0, H0 + 109);
    let early = refusal(|| a.evm_bump(0, U128(550_000_000), U128(1_100_000)).detach());
    assert_eq!(early, "anyone but the owner bumps a transaction once it is 60 seconds old: wait 1 s");
    at("anyone.testnet", 0, H0 + 110);
    a.evm_bump(0, U128(562_500_000), U128(2_000_000)).detach();
    assert_eq!(a.evm.signing.as_ref().map(|s| (s.bump, s.tx.max_fee, s.tx.tip)), Some((true, 562_500_000, 2_000_000)));
    assert!(evm_signed(&mut a, signed_ok(), H0 + 111).is_some());
    // The minute counts again from the new signature, and the eighth from the new fee.
    at("anyone.testnet", 0, H0 + 112);
    let early = refusal(|| a.evm_bump(0, U128(620_000_000), U128(2_200_000)).detach());
    assert_eq!(early, "anyone but the owner bumps a transaction once it is 60 seconds old: wait 60 s");
    at(OWNER, 0, H0 + 112);
    a.evm_bump(0, U128(632_812_500), U128(2_200_000)).detach();
    assert_eq!(a.evm.signing.as_ref().map(|s| s.tx.max_fee), Some(632_812_500));
}

// A13: a fee that lands between a repayment and its result.

#[test]
fn a_fee_booked_while_a_repayment_is_on_its_way_keeps_the_loan_open() {
    // The hole (A13): the pool works out what a repayment leaves over before a settlement's fee is added, and the
    // fee reaches the account first. `on_repaid` then saw money come back, and closed a loan that still owed the fee.
    let mut a = with_loan();
    at(OWNER, 1, H0 + 20);
    a.repay(U128(1_100_000_000)).detach();
    // The repayment remembers the loan record's count as it goes out.
    let sent_at = call_of("on_repaid").1["seq"].as_u64().unwrap();
    // A settlement's fee of $5 lands first.
    let fee = json!({ "fee": "5000000", "subsidy": "0", "credit": "0", "period_ns": "3600000000000" });
    assert!(settle_answered(&mut a, settled(fee)));
    assert_eq!(a.get_state().loan, Loan { principal: U128(1_005_000_000), open: true });
    // Then the repayment's result: the pool used $1,000.40 of the $1,100 and sent the rest back.
    ctx(ACCOUNT, 0, H0 + 22, time(H0 + 22), vec![PromiseResult::Successful(b"\"1000400000\"".to_vec())]);
    assert_eq!(a.on_repaid(U128(1_100_000_000), sent_at), U128(1_000_400_000));
    // The principal comes down by what the pool used, and the loan stays open: the fee is still owed.
    assert_eq!(a.get_state().loan, Loan { principal: U128(4_600_000), open: true });
    // The next repayment, sent after the fee, comes back partly unused and closes it.
    at(OWNER, 1, H0 + 23);
    a.repay(U128(10_000_000)).detach();
    let sent_at = call_of("on_repaid").1["seq"].as_u64().unwrap();
    ctx(ACCOUNT, 0, H0 + 24, time(H0 + 24), vec![PromiseResult::Successful(b"\"4700000\"".to_vec())]);
    assert_eq!(a.on_repaid(U128(10_000_000), sent_at), U128(4_700_000));
    assert_eq!(a.get_state().loan, Loan { principal: U128(0), open: false });
    // A loan that arrives while a repayment is on its way does the same.
    let mut a = with_loan();
    at(OWNER, 1, H0 + 20);
    a.repay(U128(1_100_000_000)).detach();
    let sent_at = call_of("on_repaid").1["seq"].as_u64().unwrap();
    book_loan(&mut a, 500_000_000, H0 + 21);
    ctx(ACCOUNT, 0, H0 + 22, time(H0 + 22), vec![PromiseResult::Successful(b"\"1000400000\"".to_vec())]);
    a.on_repaid(U128(1_100_000_000), sent_at);
    assert_eq!(a.get_state().loan, Loan { principal: U128(499_600_000), open: true });
}

// A12, the rest: a sale and the moves home, when the quote says what will arrive.

#[test]
fn a_move_that_says_what_to_expect_is_settled_only_by_a_credible_delivery_or_refund() {
    // The hole (A12, the rest): one unit of a listed token with the msg, from anyone, settled a sale or a move home.
    let usdc = |amount: u128| Some(Expect { token: id(USDC), amount: U128(amount) });
    let sale = |expect: Option<Expect>| Some(Move { kind: TransferKind::Sell, exp: quote_exp(), expect });
    let mut a = aave_account();
    // A sale of bitcoin whose quote says $1,000 will arrive, a move home from Aave's chain that expects $23, and one
    // from Hyperliquid that expects $9,400.
    at(OWNER, 1, H0 + 1);
    a.withdraw(id(NBTC), U128(1_500_000), id(DEP), sale(usdc(1_000_000_000))).detach();
    at(OWNER, 1, H0 + 2);
    let home = Some(quote_exp());
    a.evm_withdraw(AAVE_USDC.into(), U128(23_033_364), ELSEWHERE.into(), home, usdc(23_000_000)).detach();
    assert!(evm_signed(&mut a, signed_ok(), H0 + 3).is_some());
    at(OWNER, 1, H0 + 4);
    a.hl_withdraw(U128(9_500_000_000), FLOAT.into(), None, home, usdc(9_400_000_000)).detach();
    // Each record shows what it expects.
    let shown: Vec<Value> =
        pending_view(&a).as_array().unwrap().iter().filter_map(|p| p.get("transfer").cloned()).collect();
    assert_eq!(shown[0]["expect"], json!({ "token": USDC, "amount": "1000000000" }));
    assert_eq!(shown[1]["expect"], json!({ "token": USDC, "amount": "23000000" }));
    assert_eq!(shown[2]["expect"], json!({ "token": USDC, "amount": "9400000000" }));
    // One unit, another token, or under 80% of the figure: kept as a deposit, and the record stays.
    let not_it = [
        (USDC, 1, "move:0"),
        (USDC, 799_999_999, "move:0"),
        (NBTC, 1_199_999, "move:0"),
        (USDC, 1, "move:1"),
        (NBTC, 23_000_000, "move:1"),
        (USDC, 7_519_999_999, "move:2"),
    ];
    for (n, (token, amount, id)) in not_it.into_iter().enumerate() {
        delivered(&mut a, token, amount, id, H0 + 5 + n as u64);
        let kept = format!("kept as a deposit: not the delivery or the refund of transfer {id}");
        assert!(get_logs().contains(&kept), "{:?}", get_logs());
        assert!(events("transfer_done").is_empty(), "{amount} of {token} settled {id}");
    }
    assert_eq!(transfers(&a).len(), 3);
    // The token the quote named, 80% of its amount or more: arrived.
    for (amount, id) in [(800_000_000, "move:0"), (18_400_000, "move:1"), (9_400_000_000, "move:2")] {
        delivered(&mut a, USDC, amount, id, H0 + 12);
        assert_eq!(events("transfer_done"), vec![json!({ "id": id, "how": "arrived" })]);
    }
    // A sale's refund is the token it sent, 80% or more of what it sent.
    at(OWNER, 1, H0 + 13);
    a.withdraw(id(NBTC), U128(1_500_000), id(DEP), sale(usdc(1_000_000_000))).detach();
    delivered(&mut a, NBTC, 1_200_000, "move:3", H0 + 14);
    assert_eq!(events("transfer_done"), vec![json!({ "id": "move:3", "how": "refunded" })]);
    assert!(transfers(&a).is_empty());
}

#[test]
fn expect_names_a_listed_token_and_an_amount_and_only_a_recorded_sale_or_move_home_takes_it() {
    let expect = |token: &str, amount: u128| Some(Expect { token: id(token), amount: U128(amount) });
    let mut a = aave_account();
    let mut sale_refused = |kind: TransferKind, token: &str, expect: Option<Expect>| {
        at(OWNER, 1, H0 + 1);
        let transfer = Some(Move { kind, exp: quote_exp(), expect });
        refusal(|| a.withdraw(id(token), U128(5), id(DEP), transfer).detach())
    };
    let unlisted = "expect names a token that isn't allow-listed";
    assert_eq!(sale_refused(TransferKind::Sell, NBTC, expect("other.testnet", 5)), unlisted);
    assert_eq!(sale_refused(TransferKind::Sell, NBTC, expect(USDC, 0)), "expect's amount must be positive");
    // A move to Hyperliquid or to Aave's chain brings nothing back to NEAR.
    for kind in [TransferKind::ToHl, TransferKind::ToEvm] {
        assert_eq!(sale_refused(kind, USDC, expect(USDC, 5)), "only a sell move takes expect");
    }
    // Without `exp` nothing is recorded, so there is nothing to expect.
    let needs_exp = "expect needs exp: only a recorded move expects a delivery";
    at(OWNER, 1, H0 + 1);
    let call = || a.evm_withdraw(AAVE_USDC.into(), U128(5), ELSEWHERE.into(), None, expect(USDC, 5)).detach();
    assert_eq!(refusal(call), needs_exp);
    at(OWNER, 1, H0 + 1);
    assert_eq!(refusal(|| a.hl_withdraw(U128(5), FLOAT.into(), None, None, expect(USDC, 5)).detach()), needs_exp);
    at(OWNER, 1, H0 + 1);
    let call =
        || a.evm_withdraw(AAVE_USDC.into(), U128(5), ELSEWHERE.into(), Some(quote_exp()), expect(USDC, 0)).detach();
    assert_eq!(refusal(call), "expect's amount must be positive");
    assert!(calls().is_empty() && transfers(&a).is_empty() && a.evm.signing.is_none());
    // A record without `expect` shows none.
    at(OWNER, 1, H0 + 2);
    a.withdraw(id(NBTC), U128(5), id(DEP), Some(Move { kind: TransferKind::Sell, exp: quote_exp(), expect: None }))
        .detach();
    assert!(pending_view(&a)[0]["transfer"].get("expect").is_none());
}

// A17, point 4: the pool's pause and its day's step limit reach the lender steps.

/// The pool's answer to `settle` while it is paused.
fn paused() -> PromiseResult {
    settled(json!({ "skipped": "the pool is paused: settlements wait" }))
}

#[test]
fn a_paused_pool_stops_a_borrow_step_at_either_lender() {
    // The hole (A17): a settlement the pool skipped counted as settled, whatever the reason, so a borrow at a lender
    // went on while the pool was paused.
    let mut a = ready_for_rhea(4_000_000_000);
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 12);
    assert!(!step_settled(&mut a, 1, 4_000_000_000, paused(), H0 + 14));
    assert!(calls().is_empty(), "something went to Rhea");
    let said = "step 1 of plan f1005 didn't go out, as the pool is paused: nothing was borrowed, and it may run again";
    assert!(get_logs().contains(&said.to_string()), "{:?}", get_logs());
    assert!(!fund_step_done(&a, 1) && a.get_state().pending.is_empty());
    // Any other reason to skip still counts as settled, as before.
    let mut a = ready_for_rhea(4_000_000_000);
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 12);
    assert!(step_settled(&mut a, 1, 4_000_000_000, skipped(), H0 + 14));
    // Aave: no signature is asked for.
    let mut a = ready_for_aave();
    run_step(&mut a, "keeper.testnet", FID, 1, H0 + 13);
    ctx(ACCOUNT, 0, H0 + 15, time(H0 + 15), vec![paused()]);
    let asked = a.on_step_settled(FID.into(), 1, "aave".into(), U128(4_000_000_000));
    assert!(matches!(asked, PromiseOrValue::Value(false)));
    assert!(get_created_receipts().is_empty(), "the signer was asked");
    assert!(get_logs().contains(&"no Ethereum transaction signed, as the pool is paused".to_string()));
    assert!(!fund_step_done(&a, 1) && a.evm.signing.is_none() && a.get_state().pending.is_empty());
}

#[test]
fn a_top_up_at_rhea_asks_the_pools_check_step_first() {
    // The hole (A17): a top-up's steps at Rhea sent the account's tokens to the lender without asking the pool, so
    // its pause and its $50,000 a day for plan steps didn't reach them.
    // l_repay: once the account's USDC is read, the pool is asked for what the step will send: the smaller of the
    // step's $10,133 and the $4,000 the account holds.
    let mut a = with_top_up(both(), json!([l_repay_step()]));
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 25);
    assert!(repay_ready(&mut a, 0, used(4_000_000_000), H0 + 27));
    assert_eq!(methods()[0], "check_step");
    let asked = json!({ "plan_id": PID, "step": 0, "token": USDC, "amount": "4000000000" });
    assert_eq!(call_of("check_step").1, asked);
    assert_eq!(call_of("check_step").0.as_str(), POOL);
    // l_add: the pool is asked for the token and the amount the step posts.
    let mut a = with_top_up(None, json!([l_add_step()]));
    run_step(&mut a, "anyone.testnet", PID, 0, H0 + 25);
    assert_eq!(methods()[0], "check_step");
    let asked = json!({ "plan_id": PID, "step": 0, "token": NBTC, "amount": "5000000" });
    assert_eq!(call_of("check_step").1, asked);
    assert!(step_done(&a, 0) && a.get_state().counter == 1);
}

// A15: a plan that is replaced before the keeper can run it (INTERFACES.md 47.5).

/// An `l_add` step at Rhea for `amt` units of nBTC.
fn l_add_of(amt: u64) -> Value {
    json!({ "k": "l_add", "l": "rhea", "tok": NBTC, "amt": amt.to_string() })
}

/// A lender account whose stored REBALANCE plan (1020) is an `l_add` then an `l_repay` at Rhea, from a check read at
/// H0 + 20. Its counter is 0.
fn with_two_step_top_up() -> Account {
    with_top_up(both(), json!([l_add_of(5_000_000), l_repay_step()]))
}

/// A REBALANCE verdict read at `blk` for counter 0, whose plan is `steps`, with Rhea's line.
fn top_up_again(blk: u64, steps: Value) -> Value {
    let mut v = rebalance(0, blk, steps);
    v["ext"] = json!([ext_line("rhea")]);
    v
}

/// The stored plan's id, and whether each of its steps has started.
fn stored(a: &Account) -> (String, Vec<bool>) {
    let plan = a.plan.as_ref().expect("no plan is stored");
    (plan.pid.to_string(), plan.steps.iter().map(|s| s.done).collect())
}

#[test]
fn a_newer_check_that_orders_the_same_steps_keeps_the_stored_plan_for_100_blocks() {
    // The hole (A15): each accepted REBALANCE verdict replaced the stored plan, so checks that kept arriving could
    // hold back a top-up the keeper was about to run.
    let mut a = with_two_step_top_up();
    a.plan.as_mut().unwrap().steps[1].done = true;
    // Same action, same steps in the same order by kind, lender and token; another amount. Read 99 blocks later.
    let same = json!([l_add_of(7_000_000), { "k": "l_repay", "l": "rhea", "amt": 5 }]);
    assert!(deliver(&mut a, Intent::Check {}, &top_up_again(H0 + 26, same.clone()), H0 + 27).accepted);
    assert!(events("plan_stored").is_empty(), "the newer plan was stored");
    assert_eq!(stored(&a), ("1020".to_string(), vec![false, true]));
    assert!(deliver(&mut a, Intent::Check {}, &top_up_again(H0 + 119, same.clone()), H0 + 120).accepted);
    assert_eq!(stored(&a), ("1020".to_string(), vec![false, true]));
    // The kept plan keeps its own amounts.
    assert_eq!(a.get_state().plan.unwrap().steps[0]["amt"], "5000000");
    // At 100 blocks after the stored plan's own check, the newer one replaces it.
    assert!(deliver(&mut a, Intent::Check {}, &top_up_again(H0 + 120, same), H0 + 121).accepted);
    assert_eq!(stored(&a), ("1120".to_string(), vec![false, false]));
    assert_eq!(events("plan_stored").len(), 1);
}

#[test]
fn a_plan_of_another_shape_or_a_more_severe_action_replaces_the_stored_one_at_once() {
    let other_shapes = [
        // Another kind, another lender, another token, another order, one step fewer, one more.
        json!([{ "k": "repay", "amt": 5 }, l_repay_step()]),
        json!([l_add_of(5_000_000), { "k": "l_repay", "l": "aave", "amt": 5 }]),
        json!([{ "k": "l_add", "l": "aave", "tok": WBTC, "amt": "5" }, l_repay_step()]),
        json!([l_repay_step(), l_add_of(5_000_000)]),
        json!([l_add_of(5_000_000)]),
        json!([l_add_of(5_000_000), l_repay_step(), repay_step()]),
    ];
    for steps in other_shapes {
        let mut a = with_two_step_top_up();
        a.plan.as_mut().unwrap().steps[0].done = true;
        assert!(deliver(&mut a, Intent::Check {}, &top_up_again(H0 + 26, steps.clone()), H0 + 27).accepted);
        let (pid, done) = stored(&a);
        assert!(pid == "1026" && done.iter().all(|d| !d), "{steps} didn't replace the plan: {pid} {done:?}");
    }
    // The same steps under a more severe action.
    let mut a = with_two_step_top_up();
    let mut now = top_up_again(H0 + 26, json!([l_add_of(5_000_000), l_repay_step()]));
    now["action"] = json!("REBALANCE_NOW");
    assert!(deliver(&mut a, Intent::Check {}, &now, H0 + 27).accepted);
    assert_eq!(stored(&a).0, "1026");
    assert_eq!(a.get_state().plan.unwrap().action, Action::RebalanceNow);
}

#[test]
fn a_plan_with_no_step_left_is_replaced_at_once_and_a_healthy_check_still_clears_a_kept_one() {
    // The keeper asks for a check as soon as a plan's steps have run: that check's plan is stored.
    let mut a = with_two_step_top_up();
    for step in a.plan.as_mut().unwrap().steps.iter_mut() {
        step.done = true;
    }
    let same = json!([l_add_of(5_000_000), l_repay_step()]);
    assert!(deliver(&mut a, Intent::Check {}, &top_up_again(H0 + 26, same.clone()), H0 + 27).accepted);
    assert_eq!(stored(&a), ("1026".to_string(), vec![false, false]));
    // A check of the same shape keeps that one, and a HEALTHY check with nothing to do clears it, as before.
    assert!(deliver(&mut a, Intent::Check {}, &top_up_again(H0 + 30, same), H0 + 31).accepted);
    assert_eq!(stored(&a).0, "1026");
    assert!(deliver(&mut a, Intent::Check {}, &verdict(0, H0 + 32), H0 + 33).accepted);
    assert!(a.get_state().plan.is_none());
}

#[test]
fn a_kept_plans_l_add_runs_under_the_newer_check_that_orders_it_and_under_no_other() {
    let mut a = with_top_up(both(), json!([l_add_of(5_000_000)]));
    // A newer check orders the same top-up: the plan keeps its id, and its step runs under that check.
    assert!(deliver(&mut a, Intent::Check {}, &top_up_again(H0 + 26, json!([l_add_of(6_000_000)])), H0 + 27).accepted);
    assert_eq!(stored(&a).0, "1020");
    run_step(&mut a, "keeper.testnet", PID, 0, H0 + 28);
    assert_eq!(methods(), vec!["check_step", "on_add_ready"]);
    // The kept plan's own amount goes out.
    assert_eq!(call_of("check_step").1["amount"], "5000000");
    // A later check that orders nothing leaves the plan stored, and its step no longer runs.
    let mut a = with_top_up(both(), json!([l_add_of(5_000_000)]));
    assert!(deliver(&mut a, Intent::Check {}, &top_up_again(H0 + 26, json!([l_add_of(6_000_000)])), H0 + 27).accepted);
    let mut watch = verdict(0, H0 + 28);
    watch["state"] = json!("WATCH");
    assert!(deliver(&mut a, Intent::Check {}, &watch, H0 + 29).accepted);
    let stale = "step 0 of plan 1020 can't run: the latest check, read at block 1028, is not the one that ordered it";
    assert_eq!(step_refused(&mut a, PID, 0, H0 + 30, time(H0 + 30)), stale);
    // A check of another shape replaces the plan: the old id's step is gone with it.
    let other = top_up_again(H0 + 31, json!([l_repay_step()]));
    assert!(deliver(&mut a, Intent::Check {}, &other, H0 + 32).accepted);
    let gone = step_refused(&mut a, PID, 0, H0 + 33, time(H0 + 33));
    assert_eq!(gone, "plan 1020 is not the stored plan, 1031");
    // And a check read before the permission last changed confirms nothing for a lender.
    let mut a = with_top_up(both(), json!([l_add_of(5_000_000)]));
    assert!(deliver(&mut a, Intent::Check {}, &top_up_again(H0 + 26, json!([l_add_of(6_000_000)])), H0 + 27).accepted);
    at(OWNER, 1, H0 + 28);
    a.set_permission(both());
    assert_eq!(step_refused(&mut a, PID, 0, H0 + 29, time(H0 + 29)), before_permission(H0 + 28));
}
