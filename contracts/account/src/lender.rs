//! Rhea, the lender on NEAR (FUNDING.md 4.4; INTERFACES.md 25; research/rhea.md 2).
//!
//! - **The calls.** Rhea is Burrow's contract, so the account calls it directly. Each shape below was read from
//!   Burrow's 0.15.7 source at commit `a479b83` (`fungible_token.rs`, `actions.rs`, `actions_only.rs`,
//!   `actions_pyth.rs`, `storage.rs`), and the sandbox tests ran it against Rhea's release file (research/rhea.md 12,
//!   "A client's calls"):
//!   - register, once: `storage_deposit({"account_id", "registration_only": true})` with 0.1 NEAR;
//!   - post collateral: the token's `ft_transfer_call` to Rhea with msg `"\"OnlyIncreaseCollateral\""`;
//!   - repay: USDC's `ft_transfer_call` to Rhea with msg `"\"OnlyRepay\""`. Rhea keeps what is above the debt as a
//!     plain deposit, which `lender_withdraw` brings back;
//!   - borrow: `execute_with_pyth({"actions": [{"Borrow": …}, {"Withdraw": …}]})` with 1 yoctoNEAR;
//!   - take collateral back: `execute_with_pyth` with `DecreaseCollateral`, then `Withdraw`;
//!   - take a plain deposit back: `execute` with `Withdraw`.
//! - **Amounts.** Inside an action they are in Rhea's inner decimals, 18 for USDC and for nBTC. A `ft_transfer_call`
//!   carries the token's own units.
//! - **Rhea doesn't report failure.** With a live price feed, as on mainnet, `execute_with_pyth` returns before Rhea
//!   has borrowed or withdrawn, and succeeds even if that then fails. Our testnet copy has fixed prices, so there a
//!   refused borrow fails the call itself; the token's transfer still comes later. So the account books no Rhea
//!   loan. It lists the action as under way for 20 blocks ([`LenderAction`]), the engine counts a listed borrow as
//!   debt, and nothing else that adds risk runs until the wait is over.
//! - **The lender report.** A verdict's `ext` lines, as the pool's `settle` takes them ([`lender_report`]).
//! - **Aave's listings** (stage 3; `evm.rs`). A signed Ethereum transaction never expires, so a signed borrow,
//!   collateral withdrawal or transfer is listed here too, with its `evm_nonce` instead of a last block. It stays
//!   until a verdict shows that the chain has used that nonce.
//!
//! Nothing here panics, because the callbacks use it.
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{near, AccountId};

use pb_types::LenderReport;

use crate::verdict::Ext;

/// A Rhea borrow or withdrawal counts as under way for this many blocks after the account's call: Rhea finishes it a
/// block or two later.
pub const LENDER_WAIT_BLOCKS: u64 = 20;
/// At most this many signed borrows, withdrawals and transfers on Aave's chain are listed as under way at once
/// (research/audit.md, A14).
pub const MAX_AAVE_LISTINGS: usize = 8;
/// Rhea's inner decimals for USDC and nBTC: the token's own decimals plus the asset's `extra_decimals`.
pub const RHEA_DECIMALS: u8 = 18;
/// The `ft_transfer_call` msg that posts the tokens sent straight into collateral (`TokenReceiverMsg`).
pub const SUPPLY_MSG: &str = r#""OnlyIncreaseCollateral""#;
/// The `ft_transfer_call` msg that repays with the tokens sent.
pub const LENDER_REPAY_MSG: &str = r#""OnlyRepay""#;

/// What a lender action under way is.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LenderKind {
    Borrow,
    Withdraw,
    /// A token sent away from the account's Ethereum address (`evm_withdraw`). Only Aave's chain has these.
    Transfer,
}

impl LenderKind {
    /// The kind in words, for messages.
    pub fn word(self) -> &'static str {
        match self {
            Self::Borrow => "borrow",
            Self::Withdraw => "withdrawal",
            Self::Transfer => "transfer",
        }
    }
}

/// A lender action under way, as `get_state().pending` shows it.
///
/// At Rhea: `{"lender": {"lender": "rhea", "kind": "borrow", "amount": "…", "until_block": 123}}`, and for a
/// withdrawal `{"lender": {"lender": "rhea", "kind": "withdraw", "amount": "…", "token": "<id>", "until_block": 123}}`.
///
/// At Aave (INTERFACES.md 33): `{"lender": {"lender": "aave", "kind": "borrow" | "withdraw" | "transfer",
/// "amount": "…", "token": "0x…", "evm_nonce": 2}}`.
/// - `amount`: micro-USD for a borrow, the token's own units for a withdrawal or a transfer.
/// - `token`: the token that is leaving: a NEAR id at Rhea, a `0x` address in lower case at Aave. Rhea's borrow is
///   always USDC and leaves it out.
/// - `until_block` (Rhea): the last block of the wait. The first call after it drops the action and bumps the
///   counter.
/// - `evm_nonce` (Aave): the nonce of the signed transaction. The action stays until a verdict's `evm.nonce` is above
///   it, which shows the chain has used that nonce; the account then drops it and bumps the counter.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct LenderAction {
    pub lender: String,
    pub kind: LenderKind,
    pub amount: U128,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until_block: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evm_nonce: Option<u64>,
}

impl LenderAction {
    /// Whether the wait is still on at block `height`. One with no last block waits for a verdict instead.
    pub fn waiting(&self, height: u64) -> bool {
        self.until_block.is_none_or(|until| height <= until)
    }

    /// Whether a verdict that read `chain_nonce` on Aave's chain shows this action's transaction mined or reverted.
    pub fn seen_mined(&self, chain_nonce: u64) -> bool {
        self.evm_nonce.is_some_and(|nonce| chain_nonce > nonce)
    }
}

/// `amount` of a token with `decimals` decimals, in Rhea's inner units. None for a token with more than 18 decimals,
/// or an amount too large to write.
pub fn rhea_inner(amount: u128, decimals: u8) -> Option<U128> {
    let extra = RHEA_DECIMALS.checked_sub(decimals)?;
    amount.checked_mul(10u128.pow(u32::from(extra))).map(U128)
}

/// Burrow's `AssetAmount`: `amount` is exact, `max_amount` is "up to". A field left out is none.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct AssetAmount<'a> {
    pub token_id: &'a AccountId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<U128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_amount: Option<U128>,
}

/// The three of Burrow's `Action`s the account sends, such as `{"Borrow": {"token_id": "…", "amount": "…"}}`.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub enum RheaAction<'a> {
    Borrow(AssetAmount<'a>),
    Withdraw(AssetAmount<'a>),
    DecreaseCollateral(AssetAmount<'a>),
}

/// The arguments of Rhea's `execute_with_pyth` and `execute`.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct RheaActions<'a> {
    pub actions: Vec<RheaAction<'a>>,
}

/// Up to `inner` of `token` out of the account's plain deposit at Rhea, sent to the account. `max_amount`, as Rhea's
/// own app sends it: with `amount` a withdrawal can fail by one share once interest has moved Rhea's books.
fn withdraw(token: &AccountId, inner: U128) -> RheaAction<'_> {
    RheaAction::Withdraw(AssetAmount { token_id: token, amount: None, max_amount: Some(inner) })
}

/// Borrow `inner` of USDC and have it sent to the account, in one call.
pub fn borrow_actions(usdc: &AccountId, inner: U128) -> RheaActions<'_> {
    let borrow = RheaAction::Borrow(AssetAmount { token_id: usdc, amount: Some(inner), max_amount: None });
    RheaActions { actions: vec![borrow, withdraw(usdc, inner)] }
}

/// Take `inner` of `token` out of the collateral and have it sent to the account, in one call.
pub fn collateral_out_actions(token: &AccountId, inner: U128) -> RheaActions<'_> {
    let out = RheaAction::DecreaseCollateral(AssetAmount { token_id: token, amount: Some(inner), max_amount: None });
    RheaActions { actions: vec![out, withdraw(token, inner)] }
}

/// Have up to `inner` of the account's plain deposit of `token` sent to the account. It touches no collateral.
pub fn deposit_out_actions(token: &AccountId, inner: U128) -> RheaActions<'_> {
    RheaActions { actions: vec![withdraw(token, inner)] }
}

/// A verdict's `ext` lines as the pool's `settle` takes them: each lender's debt and its two rates.
pub fn lender_report(ext: &[Ext]) -> Vec<LenderReport> {
    ext.iter()
        .map(|e| LenderReport { lender: e.l.clone(), debt: U128(e.d), rate_bp: e.r_bp, supply_bp: e.s_bp })
        .collect()
}

/// What the account reads of the pool's `settle` answer: `{"skipped": "<why>"}` when the pool settled nothing, else
/// `{"fee": "<micro-USD>", "subsidy": "<micro-USD>", …}`. A fee was added to the account's debt to the pool, and a
/// subsidy was taken off it.
#[derive(Deserialize, Debug, Default, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct Settled {
    #[serde(default)]
    pub skipped: Option<String>,
    #[serde(default)]
    pub fee: Option<U128>,
    #[serde(default)]
    pub subsidy: Option<U128>,
}

#[cfg(test)]
mod tests {
    use near_sdk::serde_json::{self, json};

    use super::*;

    fn id(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    #[test]
    fn rheas_inner_units_are_18_decimals_whatever_the_tokens_own() {
        // $4,000 of USDC (6 decimals) and 1.31 nBTC (8 decimals).
        assert_eq!(rhea_inner(4_000_000_000, 6), Some(U128(4_000_000_000_000_000_000_000)));
        assert_eq!(rhea_inner(131_000_000, 8), Some(U128(1_310_000_000_000_000_000)));
        assert_eq!(rhea_inner(7, 18), Some(U128(7)));
        // A token with more decimals than Rhea's 18, or an amount that doesn't fit, has no inner amount.
        assert_eq!(rhea_inner(7, 24), None);
        assert_eq!(rhea_inner(u128::MAX / 10, 6), None);
    }

    #[test]
    fn a_borrow_is_borrow_then_withdraw_up_to_the_same_amount() {
        let usdc = id("musdc.testnet");
        let args = serde_json::to_value(borrow_actions(&usdc, U128(5))).unwrap();
        let expected = json!({ "actions": [
            { "Borrow": { "token_id": "musdc.testnet", "amount": "5" } },
            { "Withdraw": { "token_id": "musdc.testnet", "max_amount": "5" } },
        ] });
        assert_eq!(args, expected);
    }

    #[test]
    fn taking_collateral_back_is_decrease_collateral_then_withdraw() {
        let nbtc = id("mnbtc.testnet");
        let args = serde_json::to_value(collateral_out_actions(&nbtc, U128(9))).unwrap();
        let expected = json!({ "actions": [
            { "DecreaseCollateral": { "token_id": "mnbtc.testnet", "amount": "9" } },
            { "Withdraw": { "token_id": "mnbtc.testnet", "max_amount": "9" } },
        ] });
        assert_eq!(args, expected);
        // A plain deposit comes back with a withdrawal alone.
        let args = serde_json::to_value(deposit_out_actions(&nbtc, U128(9))).unwrap();
        assert_eq!(args, json!({ "actions": [{ "Withdraw": { "token_id": "mnbtc.testnet", "max_amount": "9" } }] }));
    }

    #[test]
    fn the_two_transfer_messages_are_json_strings() {
        assert_eq!(serde_json::from_str::<String>(SUPPLY_MSG).unwrap(), "OnlyIncreaseCollateral");
        assert_eq!(serde_json::from_str::<String>(LENDER_REPAY_MSG).unwrap(), "OnlyRepay");
    }

    #[test]
    fn a_lender_action_has_the_interfaces_json_and_waits_through_its_last_block() {
        let action = LenderAction {
            lender: "rhea".into(),
            kind: LenderKind::Borrow,
            amount: U128(50_667_000_000),
            token: None,
            until_block: Some(123),
            evm_nonce: None,
        };
        let expected = json!({ "lender": "rhea", "kind": "borrow", "amount": "50667000000", "until_block": 123 });
        assert_eq!(serde_json::to_value(&action).unwrap(), expected);
        assert_eq!(serde_json::from_value::<LenderAction>(expected).unwrap(), action);
        assert!(action.waiting(123) && !action.waiting(124));
        // A withdrawal names the collateral token that is leaving.
        let out = LenderAction {
            kind: LenderKind::Withdraw,
            amount: U128(131_000_000),
            token: Some("mnbtc.testnet".into()),
            ..action
        };
        let expected = json!({
            "lender": "rhea", "kind": "withdraw", "amount": "131000000", "token": "mnbtc.testnet", "until_block": 123,
        });
        assert_eq!(serde_json::to_value(&out).unwrap(), expected);
        assert_eq!(serde_json::to_value(LenderKind::Withdraw).unwrap(), json!("withdraw"));
        assert_eq!((LenderKind::Borrow.word(), LenderKind::Withdraw.word()), ("borrow", "withdrawal"));
    }

    #[test]
    fn an_aave_action_carries_its_ethereum_nonce_and_waits_for_a_verdict_not_a_block() {
        let usdc = "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f";
        let action = LenderAction {
            lender: "aave".into(),
            kind: LenderKind::Borrow,
            amount: U128(56_667_000_000),
            token: Some(usdc.into()),
            until_block: None,
            evm_nonce: Some(2),
        };
        let expected =
            json!({ "lender": "aave", "kind": "borrow", "amount": "56667000000", "token": usdc, "evm_nonce": 2 });
        assert_eq!(serde_json::to_value(&action).unwrap(), expected);
        assert_eq!(serde_json::from_value::<LenderAction>(expected).unwrap(), action);
        // No block ends it. A chain nonce above its own does: the chain has then used that nonce.
        assert!(action.waiting(u64::MAX));
        assert!(!action.seen_mined(2) && action.seen_mined(3));
        // A transfer away from the address is a third kind, and Rhea's actions have no Ethereum nonce.
        assert_eq!(serde_json::to_value(LenderKind::Transfer).unwrap(), json!("transfer"));
        assert_eq!(LenderKind::Transfer.word(), "transfer");
        let rhea = LenderAction { until_block: Some(9), evm_nonce: None, ..action };
        assert!(!rhea.seen_mined(u64::MAX));
    }

    #[test]
    fn the_lender_report_carries_each_lenders_debt_and_rates() {
        let line = |l: &str, d: u128, r_bp: u32, s_bp: u32| Ext {
            l: l.into(),
            c: 100_000_000_000,
            d,
            hf_bp: 15_000,
            r_bp,
            s_bp,
            room: 7,
            liq_bp: 7_600,
        };
        let lines = [line("aave", 56_667_000_000, 533, 410), line("rhea", 0, 1_591, 1_032)];
        let expected = json!([
            { "lender": "aave", "debt": "56667000000", "rate_bp": 533, "supply_bp": 410 },
            { "lender": "rhea", "debt": "0", "rate_bp": 1591, "supply_bp": 1032 },
        ]);
        assert_eq!(serde_json::to_value(lender_report(&lines)).unwrap(), expected);
        assert!(lender_report(&[]).is_empty());
    }

    #[test]
    fn the_pools_settle_answer_is_read_for_its_fee_and_subsidy() {
        let read = |answer: serde_json::Value| serde_json::from_value::<Settled>(answer).unwrap();
        let skipped = read(json!({ "skipped": "too soon" }));
        assert_eq!(skipped, Settled { skipped: Some("too soon".into()), fee: None, subsidy: None });
        let fee = read(json!({ "fee": "680000000", "subsidy": "0", "credit": "0", "period_ns": "3600000000000" }));
        assert_eq!((fee.skipped, fee.fee, fee.subsidy), (None, Some(U128(680_000_000)), Some(U128(0))));
        // Fields the account doesn't know are left alone, and a number where a string belongs is not an answer.
        assert_eq!(read(json!({ "subsidy": "457506", "parts": [1, 2] })).subsidy, Some(U128(457_506)));
        assert!(serde_json::from_value::<Settled>(json!({ "fee": 5 })).is_err());
    }
}
