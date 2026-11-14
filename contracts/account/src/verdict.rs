//! Verdicts (RISK_ENGINE.md Appendix A): what a check asks `pb-risk`, the fields of the answer the contract reads,
//! and the checks an answer must pass before the account keeps it (INTERFACES.md 4, "Accepting a verdict").
use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, Value};
use near_sdk::{near, AccountId};

use pb_types::{Config, AAVE, RHEA};

use crate::funding::{MAX_EXT, MAX_FUND_STEPS};
use crate::plan::MAX_STEPS;

/// An answer longer than this is refused unread: twice the 2 KB a verdict may use (PLAN.md 5.6).
pub const MAX_VERDICT_BYTES: usize = 4_096;

/// What a check asks the engine. In JSON: `{"check":{}}`, `{"borrow":{"amount":"…"}}` or
/// `{"withdraw":{"token":"…","amount":"…"}}`, with amounts in the token's own units.
///
/// Phase 6 (INTERFACES.md 25) adds three, after `Withdraw`:
/// - `{"fund":{"amount":"<micro-USD>"}}`: this much in all, from whichever sources the engine picks;
/// - `{"lender_withdraw":{"lender":"rhea","token":"<NEAR id or 0x address>","amount":"<units>"}}`: collateral back
///   from a lender;
/// - `{"evm_withdraw":{"token":"0x…","amount":"<units>"}}`: a token out of the account's address on Aave's chain.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Debug, PartialEq)]
pub enum Intent {
    Check {},
    Borrow { amount: U128 },
    Withdraw { token: AccountId, amount: U128 },
    Fund { amount: U128 },
    LenderWithdraw { lender: String, token: String, amount: U128 },
    EvmWithdraw { token: String, amount: U128 },
}

/// The account's state (RISK_ENGINE.md 8.1).
#[near(serializers = [borsh, json])]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Healthy,
    Watch,
    MarginCall,
    Deleverage,
    Default,
}

/// What the engine asks for (RISK_ENGINE.md 8.2).
#[near(serializers = [borsh, json])]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    None,
    Rebalance,
    RebalanceNow,
    Deleverage,
}

/// A rating tier (RISK_ENGINE.md 6), named as the pool names it.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    Preferred,
    Standard,
    Watch,
}

/// `allow`. `borrow` is how much more the account may borrow now (W*), in micro-USD. `withdraw` is the most USDC it
/// may withdraw now (micro-USD); but in the answer to a withdraw intent it is the intent's amount, in the token's
/// units, if the engine allows that withdrawal, and 0 if it doesn't.
#[near(serializers = [borsh])]
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct Allow {
    pub withdraw: u128,
    pub borrow: u128,
    /// What the verdict's `fund` steps borrow in all, in micro-USD (Phase 6). Left out, it is 0.
    #[serde(default)]
    pub fund: u128,
}

/// One lender's line in `ext` (INTERFACES.md 25): the account's position there as the engine read it.
/// - `l`: the lender, `"aave"` or `"rhea"`.
/// - `c` and `d`: the collateral posted and the debt, in micro-USD.
/// - `hf_bp`: the cushion (health factor) in bp, 0 with no debt. `liq_bp`: the lender's liquidation threshold.
/// - `r_bp` and `s_bp`: the lender's USDC borrow and deposit rates now, in bp a year.
/// - `room`: how much more the account may borrow there now, in micro-USD.
#[near(serializers = [borsh])]
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct Ext {
    pub l: String,
    #[serde(default)]
    pub c: u128,
    pub d: u128,
    #[serde(default)]
    pub hf_bp: u64,
    pub r_bp: u32,
    pub s_bp: u32,
    pub room: u128,
    #[serde(default)]
    pub liq_bp: u32,
}

/// `evm`: the next nonce of the account's address on Aave's chain, as the engine read it.
#[near(serializers = [borsh])]
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct EvmSeen {
    pub nonce: u64,
}

/// `pool`: what the pool's own limits read. Each bridged token's share of collateral (bp), the NEAR-side holdings
/// (micro-USD) and the Hyperliquid equity (micro-USD, which can be negative).
#[near(serializers = [borsh])]
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct PoolTerms {
    pub shares_bp: BTreeMap<String, u32>,
    pub hold: BTreeMap<String, u128>,
    pub hl_eq: i128,
}

#[near(serializers = [borsh])]
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct Venues {
    #[serde(default)]
    pub hl_margin_ratio_bp: u64,
}

/// The fields of a verdict the contract checks or acts on. The rest stays in the kept JSON, unread. Amounts are
/// integer micro-USD; a float or a missing field makes the verdict malformed, and it is refused.
#[near(serializers = [borsh])]
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct Verdict {
    pub ok: bool,
    pub model: String,
    pub params: String,
    pub acct: String,
    /// The block height the engine read, and the account's counter it read.
    pub blk: u64,
    pub nonce: u64,
    /// Mark equity (it can be negative) and the buffer, MR.
    pub eq: i64,
    pub mm: i64,
    pub state: State,
    pub action: Action,
    /// When the current margin call started (ns), or 0.
    #[serde(default)]
    pub since: u64,
    pub tier: Tier,
    pub allow: Allow,
    pub pool: PoolTerms,
    /// The hedge ratio now, and the coins' gross exposure as a share of equity, for the hourly record.
    pub hr_bp: u32,
    pub exp_bp: u64,
    #[serde(default)]
    pub venues: Venues,
    /// The plan's step objects (INTERFACES.md 13), at most 4. The account stores them for REBALANCE and
    /// REBALANCE_NOW, and for DELEVERAGE once the two-check rule confirms it.
    #[serde(default)]
    #[borsh(skip)]
    pub plan: Vec<Value>,
    /// The ids of 1Click transfers `pb-risk` saw arrive, such as a `to_hl` delivery on Hyperliquid (INTERFACES.md 14).
    #[serde(default)]
    #[borsh(skip)]
    pub arrived: Vec<String>,
    /// The nonces of the account's open `sendAsset`s that Hyperliquid's history shows as sent (INTERFACES.md 50.2).
    /// Left out, there are none.
    #[serde(default)]
    #[borsh(skip)]
    pub sent: Vec<u64>,
    /// The lenders' lines (Phase 6), at most 2. Left out, there are none.
    #[serde(default)]
    pub ext: Vec<Ext>,
    /// The funding steps that answer a `fund` intent (`funding.rs`), at most 6. `fund` reads them from the kept JSON.
    #[serde(default)]
    #[borsh(skip)]
    pub fund: Vec<Value>,
    /// The engine's reading of Aave's chain, if it read it.
    #[serde(default)]
    pub evm: Option<EvmSeen>,
}

/// The `fund` steps of a kept verdict's JSON. `Verdict` doesn't store them, so `fund` reads them again from there.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct FundSteps {
    #[serde(default)]
    fund: Vec<Value>,
}

/// The funding steps in a kept verdict's JSON: none if it has no `fund`.
pub fn fund_steps(json: &str) -> Vec<Value> {
    serde_json::from_slice::<FundSteps>(json.as_bytes()).map(|v| v.fund).unwrap_or_default()
}

impl Verdict {
    /// Whether equity is under the buffer while there is a loan. An account with no loan is always HEALTHY, so its
    /// time never counts (RISK_ENGINE.md 8.1).
    pub fn below_buffer(&self) -> bool {
        self.state != State::Healthy && i128::from(self.eq) < i128::from(self.mm)
    }
}

/// What the account expects of a verdict.
pub struct Expected<'a> {
    pub account: &'a str,
    pub counter: u64,
    pub config: &'a Config,
    /// The current block height: a verdict can't have read a later block.
    pub height: u64,
    /// The `blk` of the verdict the account already holds, if any: a later answer must not go back in time.
    pub held_blk: Option<u64>,
}

/// An `{"ok":false,"reason":…}` answer, or the first field of a verdict.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Header {
    ok: bool,
    #[serde(default)]
    reason: Option<String>,
}

/// Checks OutLayer's answer, in the order INTERFACES.md 4 lists, and returns the verdict if it passes. The error says
/// which check failed. The answer can only be the one to the account's own `request_execution`, which pins the
/// project and its version, so a verdict from another program can't arrive; `params` and `model` pin the parameter
/// file and the model on top.
pub fn check(bytes: &[u8], e: &Expected) -> Result<Verdict, String> {
    if bytes.trim_ascii().is_empty() || bytes.trim_ascii() == b"null" {
        return Err("OutLayer returned no verdict: the run failed or timed out".into());
    }
    if bytes.len() > MAX_VERDICT_BYTES {
        return Err(format!("the verdict is {} bytes, above the {MAX_VERDICT_BYTES}-byte limit", bytes.len()));
    }
    let header: Header =
        serde_json::from_slice(bytes).map_err(|_| "the answer is not a verdict: it has no ok field".to_string())?;
    if !header.ok {
        return Err(format!("ok is false: {}", header.reason.unwrap_or_default()));
    }
    let v: Verdict = serde_json::from_slice(bytes).map_err(|err| format!("the verdict is malformed: {err}"))?;
    if v.acct != e.account {
        return Err(format!("acct {} is not this account", v.acct));
    }
    if v.nonce != e.counter {
        return Err(format!("nonce {} is not the counter {}", v.nonce, e.counter));
    }
    if !v.params.eq_ignore_ascii_case(&e.config.params_hash) {
        return Err(format!("params {} is not this account's parameter file", v.params));
    }
    if v.model != e.config.model {
        return Err(format!("model {} is not this account's model {}", v.model, e.config.model));
    }
    if v.blk > e.height {
        return Err(format!("blk {} is after the current block {}", v.blk, e.height));
    }
    if let Some(held) = e.held_blk.filter(|held| v.blk < *held) {
        return Err(format!("blk {} is older than the held verdict's {held}", v.blk));
    }
    if v.plan.len() > MAX_STEPS {
        return Err(format!("the plan has {} steps, above the {MAX_STEPS} allowed", v.plan.len()));
    }
    if v.fund.len() > MAX_FUND_STEPS {
        return Err(format!("fund has {} steps, above the {MAX_FUND_STEPS} allowed", v.fund.len()));
    }
    if v.ext.len() > MAX_EXT {
        return Err(format!("ext has {} lenders, above the {MAX_EXT} allowed", v.ext.len()));
    }
    for (i, line) in v.ext.iter().enumerate() {
        if line.l != RHEA && line.l != AAVE {
            return Err(format!(r#"ext names {:?}: the lenders are "aave" and "rhea""#, line.l));
        }
        if v.ext[..i].iter().any(|earlier| earlier.l == line.l) {
            return Err(format!("ext names {} twice", line.l));
        }
    }
    Ok(v)
}
