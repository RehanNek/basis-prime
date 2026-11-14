//! The request on stdin (INTERFACES.md 6), checked and put in one canonical form:
//!
//! ```json
//! {"mode": "check" | "preview", "account": "alice.pbf.testnet",
//!  "intent": {"check": {}} | {"borrow": {"amount": "<mUSDC units>"}} | {"withdraw": {"token": "<id>", "amount": "<units>"}},
//!  "network": "testnet", "snapshot": false}
//! ```
//!
//! Phase 6 (INTERFACES.md 25) adds three intents: `{"fund": {"amount": "<micro-USD>"}}`,
//! `{"lender_withdraw": {"lender": "aave" | "rhea", "token": "<NEAR id or 0x address>", "amount": "<units>"}}` and
//! `{"evm_withdraw": {"token": "0x…", "amount": "<units>"}}`. A 0x address is written back in lower case.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Where the program runs and what it reads (INTERFACES.md 1). Version 0 serves testnet only.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Network {
    pub name: &'static str,
    /// Client accounts are `<name>.<factory>`.
    pub factory: &'static str,
    pub pool: &'static str,
    /// The drill's nBTC/BTC ratio stands in for π on testnet (PLAN.md 5.1).
    pub drill: &'static str,
    pub near_rpc: &'static str,
    pub hl_info: &'static str,
    /// Whether a run can get 1Click quotes for plan steps. On testnet the stand-in plays 1Click where OutLayer can't
    /// call it, so plans leave out what needs a quote (INTERFACES.md 13).
    pub one_click_quotes: bool,
    /// A floor under P2's price band (INTERFACES.md 42): the band for a coin is the parameter file's or this,
    /// whichever is larger. 0 leaves the file's band as it is, which is what a mainnet network carries.
    pub price_band_floor: f64,
}

pub const TESTNET: Network = Network {
    name: "testnet",
    factory: "pbf.testnet",
    pool: "pool.pbf.testnet",
    drill: "drill.pbf-ops.testnet",
    // Plain JSON-RPC over HTTPS: OutLayer's RPC helper is capped at 100 calls a run.
    near_rpc: "https://test.rpc.fastnear.com",
    hl_info: "https://api.hyperliquid-testnet.xyz/info",
    one_click_quotes: false,
    // The user's decision of 12 Nov, for testnet only: Hyperliquid testnet's BTC mark kept standing away from its
    // own oracle price (0.77% over it on 11 Nov, 1.69% and 1.96% on 12 Nov), and an order must be priced near the
    // mark to fill.
    price_band_floor: 0.03,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// On-chain, called by the account (`request_check`).
    Check,
    /// Over HTTPS, a what-if for the UI.
    #[default]
    Preview,
}

/// What the verdict must answer. Amounts are in the token's own units, as U128 strings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    Check {},
    Borrow { amount: String },
    Withdraw { token: String, amount: String },
    /// "I want this much in total (micro-USD). Pick the sources." (FUNDING.md 4.3)
    Fund { amount: String },
    /// Taking collateral back from a lender: `token` is a NEAR token id for Rhea, a 0x address for Aave.
    LenderWithdraw { lender: String, token: String, amount: String },
    /// Sending a token away from the account's Ethereum address (`evm_withdraw`).
    EvmWithdraw { token: String, amount: String },
}

impl Default for Intent {
    fn default() -> Self {
        Intent::Check {}
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Request {
    pub mode: Mode,
    pub account: String,
    pub intent: Intent,
    pub network: String,
}

impl Request {
    /// The network the request names (only testnet is known).
    pub fn net(&self) -> Network {
        TESTNET
    }
}

/// A checked request, and whether the caller wants the inputs back (preview only).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Parsed {
    pub request: Request,
    pub snapshot: bool,
}

/// Checks the request on stdin. Every refusal says what to fix.
pub fn parse(raw: &str) -> Result<Parsed, String> {
    let v: Value = serde_json::from_str(raw).map_err(|e| format!("the input is not JSON: {e}"))?;
    let obj = v.as_object().ok_or("the input must be a JSON object")?;
    let mode = match obj.get("mode").and_then(Value::as_str) {
        Some("check") => Mode::Check,
        Some("preview") => Mode::Preview,
        Some(other) => return Err(format!("unknown mode {other:?}: use check or preview")),
        None => return Err("mode is missing: use check or preview".into()),
    };
    let network = obj.get("network").and_then(Value::as_str).unwrap_or("");
    if network != TESTNET.name {
        return Err(format!(
            "network {network:?} is not served: this version runs on testnet only"
        ));
    }
    let account = obj
        .get("account")
        .and_then(Value::as_str)
        .ok_or("account is missing")?;
    check_client_account(account, &TESTNET)?;
    let intent = parse_intent(obj.get("intent").ok_or("intent is missing")?)?;
    let snapshot = match obj.get("snapshot") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("snapshot must be true or false".into()),
    };
    if snapshot && mode != Mode::Preview {
        return Err("snapshot is for preview only".into());
    }
    Ok(Parsed {
        request: Request {
            mode,
            account: account.to_string(),
            intent,
            network: network.to_string(),
        },
        snapshot,
    })
}

/// A NEAR account id: 2 to 64 characters of lowercase letters, digits and `-_.`, with no empty part.
pub fn is_account_id(s: &str) -> bool {
    (2..=64).contains(&s.len())
        && s.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        })
}

/// Client accounts are made by the factory, so they are `<name>.<factory>` with a one-part name.
pub fn check_client_account(account: &str, net: &Network) -> Result<(), String> {
    let name = account
        .strip_suffix(net.factory)
        .and_then(|rest| rest.strip_suffix('.'));
    match name {
        Some(n) if is_account_id(account) && !n.is_empty() && !n.contains('.') => Ok(()),
        _ => Err(format!(
            "account {account:?} is not a client account: those are <name>.{}",
            net.factory
        )),
    }
}

fn parse_intent(v: &Value) -> Result<Intent, String> {
    let obj = v
        .as_object()
        .filter(|o| o.len() == 1)
        .ok_or(
            "intent must be one of {\"check\":{}}, {\"borrow\":{...}}, {\"withdraw\":{...}}, {\"fund\":{...}}, \
             {\"lender_withdraw\":{...}} or {\"evm_withdraw\":{...}}",
        )?;
    let (kind, body) = obj.iter().next().expect("one key");
    match kind.as_str() {
        "check" => Ok(Intent::Check {}),
        "borrow" => Ok(Intent::Borrow {
            amount: amount(body)?,
        }),
        "withdraw" => {
            let token = body
                .get("token")
                .and_then(Value::as_str)
                .filter(|t| is_account_id(t))
                .ok_or("withdraw needs a token: the token contract's account id")?;
            Ok(Intent::Withdraw {
                token: token.to_string(),
                amount: amount(body)?,
            })
        }
        "fund" => Ok(Intent::Fund {
            amount: amount(body)?,
        }),
        "lender_withdraw" => {
            let lender = body.get("lender").and_then(Value::as_str);
            let token = body.get("token").and_then(Value::as_str).unwrap_or("");
            let token = match lender {
                Some(crate::lenders::RHEA) => Some(token)
                    .filter(|t| is_account_id(t))
                    .map(str::to_string)
                    .ok_or("lender_withdraw from rhea needs a token: the token contract's account id")?,
                Some(crate::lenders::AAVE) => evm_token(token)
                    .ok_or("lender_withdraw from aave needs a token: 0x and 40 hex digits")?,
                _ => return Err("lender_withdraw needs a lender: aave or rhea".into()),
            };
            Ok(Intent::LenderWithdraw {
                lender: lender.unwrap_or_default().to_string(),
                token,
                amount: amount(body)?,
            })
        }
        "evm_withdraw" => {
            let token = body
                .get("token")
                .and_then(Value::as_str)
                .and_then(evm_token)
                .ok_or("evm_withdraw needs a token: 0x and 40 hex digits")?;
            Ok(Intent::EvmWithdraw {
                token,
                amount: amount(body)?,
            })
        }
        other => Err(format!(
            "unknown intent {other:?}: use check, borrow, withdraw, fund, lender_withdraw or evm_withdraw"
        )),
    }
}

/// A token on Aave's chain: `0x` and 40 hex digits, written back in lower case so each token has one form.
fn evm_token(t: &str) -> Option<String> {
    crate::evm::address(t)
}

/// A positive U128 amount, written back without leading zeros so each amount has one form.
fn amount(body: &Value) -> Result<String, String> {
    let s = body
        .get("amount")
        .and_then(Value::as_str)
        .ok_or("the intent needs an amount, as a string of token units")?;
    match s.parse::<u128>() {
        Ok(n) if n > 0 && s.bytes().all(|b| b.is_ascii_digit()) => Ok(n.to_string()),
        _ => Err(format!(
            "amount {s:?} must be a positive whole number of token units"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_borrow_preview_parses() {
        let p = parse(
            r#"{"mode":"preview","account":"alice.pbf.testnet","intent":{"borrow":{"amount":"0050000000"}},
                "network":"testnet","snapshot":true}"#,
        )
        .unwrap();
        assert!(p.snapshot);
        assert_eq!(p.request.mode, Mode::Preview);
        assert_eq!(
            p.request.intent,
            Intent::Borrow {
                amount: "50000000".into()
            }
        );
        let json = serde_json::to_string(&p.request).unwrap();
        assert_eq!(
            json,
            r#"{"mode":"preview","account":"alice.pbf.testnet","intent":{"borrow":{"amount":"50000000"}},"network":"testnet"}"#
        );
        let check = parse(r#"{"mode":"check","account":"a1.pbf.testnet","intent":{"check":{}},"network":"testnet"}"#)
            .unwrap();
        assert_eq!(
            serde_json::to_string(&check.request.intent).unwrap(),
            r#"{"check":{}}"#
        );
    }

    #[test]
    fn the_funding_intents_parse_into_one_form() {
        let intent = |body: &str| {
            parse(&format!(
                r#"{{"mode":"check","account":"alice.pbf.testnet","intent":{body},"network":"testnet"}}"#
            ))
            .map(|p| p.request.intent)
        };
        assert_eq!(
            intent(r#"{"fund":{"amount":"094500000000"}}"#),
            Ok(Intent::Fund {
                amount: "94500000000".into()
            })
        );
        assert_eq!(
            intent(r#"{"lender_withdraw":{"lender":"rhea","token":"mnbtc.pbf-ops.testnet","amount":"0131"}}"#),
            Ok(Intent::LenderWithdraw {
                lender: "rhea".into(),
                token: "mnbtc.pbf-ops.testnet".into(),
                amount: "131".into()
            })
        );
        let aave = intent(
            r#"{"lender_withdraw":{"lender":"aave","token":"0x54114591963CF60EF3aA63bEfD6eC263D98145a4","amount":"7"}}"#,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_string(&aave).unwrap(),
            r#"{"lender_withdraw":{"lender":"aave","token":"0x54114591963cf60ef3aa63befd6ec263d98145a4","amount":"7"}}"#
        );
        assert_eq!(
            intent(r#"{"evm_withdraw":{"token":"0xBA50Cd2A20f6DA35D788639E581bca8d0B5d4D5f","amount":"1000000"}}"#),
            Ok(Intent::EvmWithdraw {
                token: "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f".into(),
                amount: "1000000".into()
            })
        );
        let bad = |body: &str| intent(body).unwrap_err();
        assert!(bad(r#"{"fund":{}}"#).contains("amount"));
        assert!(bad(r#"{"fund":{"amount":"0"}}"#).contains("positive"));
        assert!(bad(r#"{"lender_withdraw":{"lender":"compound","token":"x.near","amount":"1"}}"#)
            .contains("aave or rhea"));
        assert!(bad(r#"{"lender_withdraw":{"token":"x.near","amount":"1"}}"#).contains("aave or rhea"));
        // Each lender takes its own kind of token id.
        assert!(bad(
            r#"{"lender_withdraw":{"lender":"rhea","token":"0x54114591963CF60EF3aA63bEfD6eC263D98145a4","amount":"1"}}"#
        )
        .contains("account id"));
        assert!(bad(r#"{"lender_withdraw":{"lender":"aave","token":"mnbtc.pbf-ops.testnet","amount":"1"}}"#)
            .contains("40 hex digits"));
        assert!(bad(r#"{"lender_withdraw":{"lender":"aave","token":"0x54114591963CF60EF3aA63bEfD6eC263D98145a4"}}"#)
            .contains("amount"));
        assert!(bad(r#"{"evm_withdraw":{"token":"0x5411","amount":"1"}}"#).contains("40 hex digits"));
        assert!(bad(r#"{"evm_withdraw":{"token":"0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f","amount":"1.5"}}"#)
            .contains("positive"));
    }

    #[test]
    fn bad_requests_say_what_is_wrong() {
        let bad = |s: &str| parse(s).unwrap_err();
        assert!(bad("[]").contains("JSON object"));
        assert!(bad(r#"{"mode":"credit_check"}"#).contains("check or preview"));
        assert!(bad(r#"{"mode":"check","network":"mainnet"}"#).contains("testnet only"));
        let base = |account: &str, intent: &str, extra: &str| {
            format!(
                r#"{{"mode":"check","network":"testnet","account":"{account}","intent":{intent}{extra}}}"#
            )
        };
        assert!(bad(&base("alice.testnet", r#"{"check":{}}"#, "")).contains("not a client account"));
        assert!(
            bad(&base("a.b.pbf.testnet", r#"{"check":{}}"#, "")).contains("not a client account")
        );
        assert!(bad(&base("pbf.testnet", r#"{"check":{}}"#, "")).contains("not a client account"));
        assert!(bad(&base(
            "alice.pbf.testnet",
            r#"{"borrow":{"amount":"0"}}"#,
            ""
        ))
        .contains("positive"));
        assert!(bad(&base(
            "alice.pbf.testnet",
            r#"{"borrow":{"amount":"-5"}}"#,
            ""
        ))
        .contains("positive"));
        assert!(
            bad(&base("alice.pbf.testnet", r#"{"borrow":{"amount":7}}"#, "")).contains("string")
        );
        assert!(bad(&base(
            "alice.pbf.testnet",
            r#"{"withdraw":{"amount":"7"}}"#,
            ""
        ))
        .contains("token"));
        assert!(bad(&base("alice.pbf.testnet", r#"{"swap":{}}"#, "")).contains("unknown intent"));
        assert!(bad(&base(
            "alice.pbf.testnet",
            r#"{"check":{},"borrow":{}}"#,
            ""
        ))
        .contains("intent must be"));
        assert!(bad(&base(
            "alice.pbf.testnet",
            r#"{"check":{}}"#,
            r#","snapshot":true"#
        ))
        .contains("preview only"));
    }
}
