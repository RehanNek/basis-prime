//! The stored plan and the 1Click transfers under way (INTERFACES.md 13 and 14).
//!
//! - **The plan.** A confirmed DELEVERAGE plan, or a REBALANCE or REBALANCE_NOW plan: the verdict's step objects, at
//!   most 4. Each step keeps its JSON as the verdict gave it, and whether it has started. The plan's id, `pid`, is
//!   the `blk` of the verdict it came from. `execute_step` runs `repay`, `sell`, `to_hl` and `home`; the gateway
//!   places `cancel` and `perp`. Steps of other kinds are kept, so the gateway can read them, but nothing here runs
//!   them.
//! - **Transfers.** Each 1Click transfer the account starts, for a plan step or for the owner, stays recorded until
//!   its delivery or refund arrives with its msg, or a verdict lists it in `arrived`. A transfer past its deadline is
//!   overdue, and holds back borrowing and withdrawals with a loan. None is recorded for a quote that expires more
//!   than 24 hours ahead (`MAX_QUOTE_LIFE_MS`).
//!
//! Phase 6 (INTERFACES.md 25): a top-up plan may also hold `l_repay` and `l_add` steps, which act at a lender. They are
//! read and checked in `funding.rs`, and `execute_step` runs them on a path of their own, at Rhea (`lender.rs`) and at
//! Aave (`evm.rs`).
//!
//! Stage 4 (INTERFACES.md 36): the owner's moves between NEAR and the account's address on Aave's chain are transfers
//! too. `withdraw` with a `to_evm` move sends a token there, and `evm_withdraw` with `exp` brings one home (`e_home`).
//!
//! Nothing here panics, because `on_verdict` and the callbacks use it.
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::{near, serde_json, AccountId};

use crate::hl::parse_address;
use crate::verdict::Action;

/// A verdict's plan has at most this many steps.
pub const MAX_STEPS: usize = 4;
/// At most this many 1Click transfers are under way at once.
pub const MAX_TRANSFERS: usize = 8;
/// A step that sends through 1Click starts only with at least this much of its quote left: 5 minutes.
pub const QUOTE_LEFT_MS: u64 = 5 * 60_000;
/// A stored plan with a step still to run is kept, and a newer verdict's plan of the same action and shape dropped,
/// for a verdict read fewer than this many blocks after the stored plan's own (research/audit.md, A15). Past it the
/// newer plan replaces the stored one, so a plan the account keeps refusing doesn't stay for good.
pub const KEEP_PLAN_BLOCKS: u64 = 100;
/// A transfer is overdue this long after its quote expires: 30 minutes.
pub const OVERDUE_AFTER_MS: u64 = 30 * 60_000;
/// No transfer is recorded for a quote that expires later than this from now: 24 hours, the longest a 1Click quote
/// lives. Without it a record could stand for money "on its way" for as long as its owner chose (research/audit.md,
/// A7).
pub const MAX_QUOTE_LIFE_MS: u64 = 24 * 60 * 60_000;

/// The plan the account holds. `stored_at` is the block time it was stored (ns).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub pid: u64,
    pub action: Action,
    pub stored_at: u64,
    pub steps: Vec<Step>,
    /// The `blk` of the newest verdict that ordered this plan: its own at first, then that of each newer verdict
    /// whose plan has the same action and shape while this one is kept. No view shows it.
    pub confirmed: u64,
}

/// One step: its JSON object, compact, and whether it has started.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub json: String,
    pub done: bool,
}

/// The plan as `get_state().plan` shows it. Each step is its object with `done` added.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PlanView {
    pub pid: String,
    pub action: Action,
    pub stored_at: U64,
    pub steps: Vec<Value>,
}

impl Plan {
    /// A plan of these steps, none of them started. A step that isn't an object is kept as `{"step": <it>}`, which
    /// has no kind, so nothing runs it.
    pub fn new(pid: u64, action: Action, now: u64, steps: &[Value]) -> Self {
        Self { pid, action, stored_at: now, steps: steps_from(steps), confirmed: pid }
    }

    /// Whether a verdict's plan orders the same steps as this one: as many, and in the same order by kind (`k`),
    /// lender (`l`) and token (`tok`), compared in lower case. Amounts, quotes, deposit addresses and expiries may
    /// differ.
    pub fn same_shape(&self, steps: &[Value]) -> bool {
        let shape = |step: &Value| {
            let field = |name: &str| text(step, name).unwrap_or_default().to_ascii_lowercase();
            (field("k"), field("l"), field("tok"))
        };
        self.steps.len() == steps.len()
            && self.steps.iter().zip(steps).all(|(mine, theirs)| shape(&read(&mine.json)) == shape(theirs))
    }

    /// Whether a step hasn't run yet.
    pub fn unfinished(&self) -> bool {
        self.steps.iter().any(|step| !step.done)
    }

    /// Each step's kind, `k`, or "" if it has none.
    pub fn kinds(&self) -> Vec<String> {
        self.steps.iter().map(|s| kind_of(&s.json)).collect()
    }

    pub fn view(&self) -> PlanView {
        let steps = step_views(&self.steps);
        PlanView { pid: self.pid.to_string(), action: self.action, stored_at: U64(self.stored_at), steps }
    }
}

/// A verdict's step objects as stored steps, none of them started. A step that isn't an object is kept as
/// `{"step": <it>}`, which has no kind, so nothing runs it.
pub fn steps_from(steps: &[Value]) -> Vec<Step> {
    steps
        .iter()
        .map(|s| {
            let object = if s.is_object() { s.clone() } else { json!({ "step": s }) };
            Step { json: serde_json::to_string(&object).unwrap_or_default(), done: false }
        })
        .collect()
}

/// Stored steps as the views show them: each step's object with `done` added.
pub fn step_views(steps: &[Step]) -> Vec<Value> {
    steps
        .iter()
        .map(|s| {
            let mut step = read(&s.json);
            if let Value::Object(fields) = &mut step {
                fields.insert("done".into(), Value::Bool(s.done));
            }
            step
        })
        .collect()
}

/// A step's kind, `k`, or "" if it has none.
pub fn kind_of(json: &str) -> String {
    read(json).get("k").and_then(Value::as_str).unwrap_or_default().to_string()
}

/// A stored step's JSON, read with the same reader as verdicts (`from_slice`), so the wasm carries one copy of it.
pub(crate) fn read(json: &str) -> Value {
    serde_json::from_slice(json.as_bytes()).unwrap_or(Value::Null)
}

/// A step the account runs itself, with the fields it uses (INTERFACES.md 13). Amounts are in token units, which for
/// USDC are micro-USD; `exp` is the quote's expiry in unix ms.
#[derive(Clone, Debug, PartialEq)]
pub enum Run {
    /// Repay up to `amt` of the account's USDC.
    Repay { amt: u128 },
    /// Send `amt` of `tok` to the 1Click deposit address `dep`, which pays USDC back.
    Sell { tok: AccountId, amt: u128, dep: AccountId, exp: u64 },
    /// Send `amt` of USDC to the 1Click deposit address `dep`, which pays the account's Hyperliquid address.
    ToHl { amt: u128, dep: AccountId, exp: u64 },
    /// Sign a `sendAsset` of `amt` of perp USDC to `dep`, a 0x address that pays the account back.
    Home { amt: u128, dep: String, exp: u64 },
}

impl Run {
    /// The quote's expiry, for the steps that send through 1Click.
    pub fn exp(&self) -> Option<u64> {
        match self {
            Run::Repay { .. } => None,
            Run::Sell { exp, .. } | Run::ToHl { exp, .. } | Run::Home { exp, .. } => Some(*exp),
        }
    }
}

/// Reads a stored step. The error ends the sentence "step <i> …". Amounts may be JSON integers or strings of digits.
pub fn parse_step(json: &str) -> Result<Run, String> {
    let step = read(json);
    let bad = |field: &str| format!("can't run: its {field} is missing or not valid");
    let amt = || int(&step, "amt").filter(|a| *a > 0).ok_or_else(|| bad("amt"));
    let exp = || int(&step, "exp").and_then(|e| u64::try_from(e).ok()).ok_or_else(|| bad("exp"));
    let account = |field: &str| text(&step, field).and_then(|s| s.parse::<AccountId>().ok()).ok_or_else(|| bad(field));
    match step.get("k").and_then(Value::as_str).unwrap_or_default() {
        "repay" => Ok(Run::Repay { amt: amt()? }),
        "sell" => Ok(Run::Sell { tok: account("tok")?, amt: amt()?, dep: account("dep")?, exp: exp()? }),
        "to_hl" => Ok(Run::ToHl { amt: amt()?, dep: account("dep")?, exp: exp()? }),
        "home" => {
            let dep = text(&step, "dep").and_then(parse_address).ok_or_else(|| bad("dep"))?;
            Ok(Run::Home { amt: amt()?, dep, exp: exp()? })
        }
        k @ ("cancel" | "perp") => Err(format!("is a {k} step: the gateway places this one")),
        // A top-up's lender steps (Phase 6) run on a path of their own (`execute_top_up_step`), never through here.
        k @ ("l_repay" | "l_add") => Err(format!("is a {k} step, which runs as a lender step")),
        k @ ("p_borrow" | "l_supply" | "l_borrow" | "to_evm" | "e_home") => {
            Err(format!("is a {k} step, which only a funding plan runs"))
        }
        "" => Err("has no kind, so the account can't run it".into()),
        k => Err(format!("is a {k} step, which the account can't run")),
    }
}

pub(crate) fn text<'a>(step: &'a Value, field: &str) -> Option<&'a str> {
    step.get(field).and_then(Value::as_str)
}

/// A field that is a whole number: a JSON integer, or a string of digits.
pub(crate) fn int(step: &Value, field: &str) -> Option<u128> {
    match step.get(field)? {
        Value::Number(n) => n.as_u64().map(u128::from),
        Value::String(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => s.parse().ok(),
        _ => None,
    }
}

/// What a transfer is: a sale of a NEAR token for USDC, USDC to Hyperliquid, USDC home from Hyperliquid, a NEAR token
/// to the account's address on Aave's chain, or a token home from that address.
///
/// A kind is stored as its place in this list, so a new kind goes at the end.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransferKind {
    Sell,
    ToHl,
    Home,
    ToEvm,
    EHome,
}

/// What a transfer's quote says will arrive on NEAR (INTERFACES.md 47.3): a listed token and an amount in its own
/// units. With it, a deposit with the transfer's msg settles the transfer only when it is credible: this token and
/// at least 80% of this amount (research/audit.md, A12).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Expect {
    pub token: AccountId,
    pub amount: U128,
}

/// A 1Click transfer under way (INTERFACES.md 14 and 36).
/// - `id`: `<pid>:<i>` for a plan step, `move:<n>` for the owner's own move.
/// - `token`: the token sent. On NEAR, its contract id. `USDC` for Hyperliquid's USDC, and for the USDC on Aave's
///   chain that an `e_home` sends. A collateral token on Aave's chain is its `0x` address in lower case.
/// - `dep`: the 1Click deposit address it went to: a NEAR account, or a `0x` address in lower case.
/// - `deadline`: the quote's expiry plus 30 minutes (ns). After it, the transfer is overdue.
/// - `expect`: what the quote says will arrive on NEAR, for a `sell`, a `home` or an `e_home` the owner started with
///   one. Left out of the view when there is none.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Transfer {
    pub id: String,
    pub kind: TransferKind,
    pub token: String,
    pub amount: U128,
    pub dep: String,
    pub deadline: U64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect: Option<Expect>,
}

impl Transfer {
    /// A transfer for a quote that expires at `exp_ms`.
    pub fn new(id: String, kind: TransferKind, token: &str, amount: u128, dep: &str, exp_ms: u64) -> Self {
        let deadline = exp_ms.saturating_add(OVERDUE_AFTER_MS).saturating_mul(1_000_000);
        let (token, dep) = (token.to_string(), dep.to_string());
        Self { id, kind, token, amount: U128(amount), dep, deadline: U64(deadline), expect: None }
    }

    /// The same transfer with what its quote says will arrive on NEAR.
    pub fn expecting(mut self, expect: Option<Expect>) -> Self {
        self.expect = expect;
        self
    }

    pub fn overdue(&self, now: u64) -> bool {
        now > self.deadline.0
    }
}

/// The owner's 1Click move, the optional `transfer` argument of `withdraw`: `{"kind": "to_hl", "exp": <ms>}`, where
/// `exp` is the quote's expiry in unix ms. `kind` is `to_hl`, `sell` or `to_evm`. A `sell` may add `expect`, what the
/// quote says will arrive: `{"token": "<a listed token>", "amount": "<units>"}`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Move {
    pub kind: TransferKind,
    pub exp: u64,
    #[serde(default)]
    pub expect: Option<Expect>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEP: &str = "2b6f1e0c9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f";

    fn parse(step: Value) -> Result<Run, String> {
        parse_step(&step.to_string())
    }

    #[test]
    fn the_steps_the_account_runs_are_read_with_their_fields() {
        let repay = parse(json!({ "k": "repay", "amt": 250_000_000u64 }));
        assert_eq!(repay, Ok(Run::Repay { amt: 250_000_000 }));
        let sell = json!({ "k": "sell", "tok": "mnbtc.testnet", "amt": "1500000", "min": 1_100_000_000u64, "dep": DEP, "exp": 1_794_000_600_000u64 });
        let expected = Run::Sell {
            tok: "mnbtc.testnet".parse().unwrap(),
            amt: 1_500_000,
            dep: DEP.parse().unwrap(),
            exp: 1_794_000_600_000,
        };
        assert_eq!(parse(sell), Ok(expected));
        let to_hl = parse(json!({ "k": "to_hl", "amt": "100000000", "dep": DEP, "exp": "1794000600000" }));
        assert_eq!(to_hl, Ok(Run::ToHl { amt: 100_000_000, dep: DEP.parse().unwrap(), exp: 1_794_000_600_000 }));
        let float = "0xFC9D786B69b900ec51dfe8ebbf19ed47be59009d";
        let home = parse(json!({ "k": "home", "amt": 5_000_000u64, "dep": float, "exp": 1_794_000_600_000u64 }));
        let lower = "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d".to_string();
        assert_eq!(home, Ok(Run::Home { amt: 5_000_000, dep: lower, exp: 1_794_000_600_000 }));
    }

    #[test]
    fn the_gateways_steps_and_unknown_kinds_do_not_run_here() {
        let perp = json!({ "k": "perp", "coin": "BTC", "buy": true, "sz": "0.00375", "px": "76190" });
        assert_eq!(parse(perp), Err("is a perp step: the gateway places this one".into()));
        assert_eq!(parse(json!({ "k": "cancel" })), Err("is a cancel step: the gateway places this one".into()));
        assert_eq!(parse(json!({ "k": "hedge" })), Err("is a hedge step, which the account can't run".into()));
        assert_eq!(parse(json!({ "step": "BUY_BACK BTC" })), Err("has no kind, so the account can't run it".into()));
        assert_eq!(parse(json!({ "k": 5 })), Err("has no kind, so the account can't run it".into()));
    }

    #[test]
    fn a_step_with_a_missing_or_bad_field_does_not_run() {
        let cases = [
            (json!({ "k": "repay" }), "amt"),
            (json!({ "k": "repay", "amt": 0 }), "amt"),
            (json!({ "k": "repay", "amt": -5 }), "amt"),
            (json!({ "k": "repay", "amt": 1.5 }), "amt"),
            (json!({ "k": "repay", "amt": "+5" }), "amt"),
            (json!({ "k": "to_hl", "amt": 5, "exp": 1 }), "dep"),
            (json!({ "k": "to_hl", "amt": 5, "dep": "Not An Account", "exp": 1 }), "dep"),
            (json!({ "k": "to_hl", "amt": 5, "dep": DEP }), "exp"),
            (json!({ "k": "sell", "amt": 5, "dep": DEP, "exp": 1 }), "tok"),
            (json!({ "k": "home", "amt": 5, "dep": DEP, "exp": 1 }), "dep"),
            (json!({ "k": "home", "amt": 5, "dep": "0xfc9d", "exp": 1 }), "dep"),
        ];
        for (step, field) in cases {
            let expected = format!("can't run: its {field} is missing or not valid");
            assert_eq!(parse(step.clone()), Err(expected), "{step}");
        }
    }

    #[test]
    fn a_new_plan_keeps_each_step_and_shows_it_with_done() {
        let steps =
            [json!({ "k": "perp", "coin": "BTC" }), json!("an old text step"), json!({ "k": "repay", "amt": 5 })];
        let mut plan = Plan::new(276_800_123, Action::Deleverage, 7, &steps);
        assert_eq!(plan.kinds(), vec!["perp", "", "repay"]);
        plan.steps[2].done = true;
        let view = serde_json::to_value(plan.view()).unwrap();
        let expected = json!({
            "pid": "276800123", "action": "DELEVERAGE", "stored_at": "7",
            "steps": [
                { "k": "perp", "coin": "BTC", "done": false },
                { "step": "an old text step", "done": false },
                { "k": "repay", "amt": 5, "done": true },
            ],
        });
        assert_eq!(view, expected);
    }

    #[test]
    fn a_step_cannot_claim_it_is_done() {
        let plan = Plan::new(1, Action::Rebalance, 0, &[json!({ "k": "to_hl", "done": true })]);
        assert_eq!(plan.view().steps[0]["done"], json!(false));
    }

    #[test]
    fn a_transfer_is_overdue_30_minutes_after_its_quote_expires() {
        let t = Transfer::new("1:0".into(), TransferKind::ToHl, "musdc.testnet", 5, DEP, 1_000);
        assert_eq!(t.deadline, U64((1_000 + 30 * 60_000) * 1_000_000));
        assert!(!t.overdue(t.deadline.0));
        assert!(t.overdue(t.deadline.0 + 1));
        let view = serde_json::to_value(&t).unwrap();
        let expected = json!({
            "id": "1:0", "kind": "to_hl", "token": "musdc.testnet", "amount": "5", "dep": DEP,
            "deadline": t.deadline.0.to_string(),
        });
        assert_eq!(view, expected);
        // A far expiry doesn't overflow.
        assert_eq!(Transfer::new("x".into(), TransferKind::Home, "USDC", 1, "0x", u64::MAX).deadline, U64(u64::MAX));
    }

    #[test]
    fn the_two_moves_to_and_from_aaves_chain_are_kinds_of_their_own_after_the_first_three() {
        let kinds =
            [TransferKind::Sell, TransferKind::ToHl, TransferKind::Home, TransferKind::ToEvm, TransferKind::EHome];
        let names: Vec<Value> = kinds.iter().map(|k| serde_json::to_value(k).unwrap()).collect();
        assert_eq!(names, vec!["sell", "to_hl", "home", "to_evm", "e_home"]);
        // A kind is stored as its place in the list: the first three keep theirs, so a transfer stored before the
        // new kinds reads the same.
        let stored: Vec<Vec<u8>> = kinds.iter().map(|k| near_sdk::borsh::to_vec(k).unwrap()).collect();
        assert_eq!(stored, vec![vec![0], vec![1], vec![2], vec![3], vec![4]]);
        // `withdraw`'s `transfer` argument reads the new kind.
        let read: Move = serde_json::from_value(json!({ "kind": "to_evm", "exp": 1_794_000_600_000u64 })).unwrap();
        assert_eq!(read, Move { kind: TransferKind::ToEvm, exp: 1_794_000_600_000, expect: None });
    }
}
