//! INTERFACES.md 13 and 14: the verdict's plan steps, as pb-risk writes them, the account stores them and the
//! gateway places them, and Hyperliquid's wire form for the sizes and prices of perp steps.
//!
//! Amounts are micro-USD integers; token amounts are unit strings; Hyperliquid sizes and prices are wire strings,
//! already rounded to Hyperliquid's rules (research/hyperliquid.md, "Numbers on the wire").
use crate::util::{pow10, u64_of};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// A whole number written as a JSON integer or as a string of digits. pb-risk writes integers; the account accepts
/// both in a stored plan (INTERFACES.md 14), so the gateway reads both back.
fn whole<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let v = Value::deserialize(d)?;
    u64_of(&v).ok_or_else(|| serde::de::Error::custom(format!("{v} is not a whole number")))
}

/// One plan step. The account adds `done` when it stores the plan; that field is ignored here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "snake_case")]
pub enum PlanStep {
    /// Cancel the account's resting orders that add risk. The gateway's `deleverage` mode runs it.
    Cancel {},
    /// Repay the pool from the account's NEAR USDC. `execute_step` runs it.
    Repay {
        #[serde(deserialize_with = "whole")]
        amt: u64,
    },
    /// A reduce-only IOC order of `sz` at `px`, inside the coin's band. The gateway's `deleverage` mode runs it.
    Perp {
        coin: String,
        buy: bool,
        sz: String,
        px: String,
    },
    /// Send `amt` units of token `tok` to the 1Click deposit address `dep`. The quote pays at least `min` micro-USDC
    /// back to the account, and expires at `exp` (unix ms). `execute_step` runs it.
    Sell {
        tok: String,
        amt: String,
        #[serde(deserialize_with = "whole")]
        min: u64,
        dep: String,
        #[serde(deserialize_with = "whole")]
        exp: u64,
    },
    /// USDC from NEAR to the account's Hyperliquid address, through 1Click. `execute_step` runs it.
    ToHl {
        #[serde(deserialize_with = "whole")]
        amt: u64,
        dep: String,
        #[serde(deserialize_with = "whole")]
        exp: u64,
    },
    /// An MPC-signed `sendAsset` of perp USDC to the 1Click deposit address `dep` (0x). `execute_step` runs it.
    Home {
        #[serde(deserialize_with = "whole")]
        amt: u64,
        dep: String,
        #[serde(deserialize_with = "whole")]
        exp: u64,
    },
    /// Funding (FUNDING.md 4.3). Borrow `amt` micro-USDC from our pool. It comes last in a funding plan.
    PBorrow {
        #[serde(deserialize_with = "whole")]
        amt: u64,
    },
    /// Post `amt` units of `tok` as collateral at lender `l` (`rhea`: a NEAR token id; `aave`: a 0x address).
    LSupply { l: String, tok: String, amt: String },
    /// Borrow `amt` micro-USDC from lender `l`.
    LBorrow {
        l: String,
        #[serde(deserialize_with = "whole")]
        amt: u64,
    },
    /// Send `amt` units of NEAR token `tok` to the 1Click deposit address `dep`, which delivers at least `min` units
    /// of the wrapped token to the account's Ethereum address.
    ToEvm {
        tok: String,
        amt: String,
        min: String,
        dep: String,
        #[serde(deserialize_with = "whole")]
        exp: u64,
    },
    /// Sign a USDC transfer of `amt` micro-USDC on Aave's chain to the 1Click deposit address `dep` (0x), which
    /// delivers USDC to the account on NEAR.
    EHome {
        #[serde(deserialize_with = "whole")]
        amt: u64,
        dep: String,
        #[serde(deserialize_with = "whole")]
        exp: u64,
    },
    /// A top-up (FUNDING.md 6.5): repay `amt` micro-USDC to lender `l` from the USDC the account holds on its chain.
    LRepay {
        l: String,
        #[serde(deserialize_with = "whole")]
        amt: u64,
    },
    /// A top-up: post `amt` more units of `tok` at lender `l`.
    LAdd { l: String, tok: String, amt: String },
}

impl PlanStep {
    /// The step's `k`.
    pub fn kind(&self) -> &'static str {
        match self {
            PlanStep::Cancel {} => "cancel",
            PlanStep::Repay { .. } => "repay",
            PlanStep::Perp { .. } => "perp",
            PlanStep::Sell { .. } => "sell",
            PlanStep::ToHl { .. } => "to_hl",
            PlanStep::Home { .. } => "home",
            PlanStep::PBorrow { .. } => "p_borrow",
            PlanStep::LSupply { .. } => "l_supply",
            PlanStep::LBorrow { .. } => "l_borrow",
            PlanStep::ToEvm { .. } => "to_evm",
            PlanStep::EHome { .. } => "e_home",
            PlanStep::LRepay { .. } => "l_repay",
            PlanStep::LAdd { .. } => "l_add",
        }
    }

    /// Whether the gateway places it (`cancel`, `perp`); the account's `execute_step` runs the rest.
    pub fn for_gateway(&self) -> bool {
        matches!(self, PlanStep::Cancel {} | PlanStep::Perp { .. })
    }
}

/// The plan the account stores (`get_state().plan`, INTERFACES.md 14).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredPlan {
    /// The `blk` of the verdict whose plan the account stored, as a decimal string.
    pub pid: String,
    /// DELEVERAGE, REBALANCE or REBALANCE_NOW.
    pub action: String,
    /// When the account stored it (block time, ns).
    pub stored_at_ns: u64,
    /// Each step, and whether the account has marked it done.
    pub steps: Vec<(PlanStep, bool)>,
}

/// `get_state().plan`: None when the account holds no plan. A plan whose shape is unknown is refused.
pub fn stored_plan(state: &Value) -> Result<Option<StoredPlan>, String> {
    let v = match state.get("plan") {
        None | Some(Value::Null) => return Ok(None),
        Some(v) => v,
    };
    let bad = |what: &str| format!("the account's stored plan has no valid {what}");
    let pid = v
        .get("pid")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        .ok_or_else(|| bad("pid"))?;
    let action = v
        .get("action")
        .and_then(Value::as_str)
        .filter(|a| matches!(*a, "DELEVERAGE" | "REBALANCE" | "REBALANCE_NOW"))
        .ok_or_else(|| bad("action"))?;
    let stored_at_ns = v
        .get("stored_at")
        .and_then(u64_of)
        .ok_or_else(|| bad("stored_at"))?;
    let mut steps = Vec::new();
    for (i, s) in v
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("steps"))?
        .iter()
        .enumerate()
    {
        let step: PlanStep = serde_json::from_value(s.clone())
            .map_err(|e| format!("step {i} of the account's stored plan: {e}"))?;
        let done = s.get("done").and_then(Value::as_bool).unwrap_or(false);
        steps.push((step, done));
    }
    Ok(Some(StoredPlan {
        pid: pid.to_string(),
        action: action.to_string(),
        stored_at_ns,
        steps,
    }))
}

/// A whole number of units, `n`, as a decimal with `d` places, in wire form: no trailing zeros after the point, and
/// no point when nothing follows it.
fn decimal_of(n: u128, d: u32) -> String {
    let digits = n.to_string();
    let d = d as usize;
    let (int, frac) = if digits.len() > d {
        digits.split_at(digits.len() - d)
    } else {
        ("0", digits.as_str())
    };
    let frac = format!("{frac:0>d$}");
    let frac = frac.trim_end_matches('0');
    if frac.is_empty() {
        int.to_string()
    } else {
        format!("{int}.{frac}")
    }
}

/// Floating error a scaled value may carry before it is cut to a whole number (relative).
const NUDGE: f64 = 1e-12;

/// `x` coin units cut toward zero to `sz_decimals` decimals, in wire form; None if nothing is left.
pub fn wire_size(x: f64, sz_decimals: u32) -> Option<String> {
    let scaled = (x.abs() * pow10(sz_decimals) * (1.0 + NUDGE)).floor();
    if !scaled.is_finite() || !(1.0..=1e30).contains(&scaled) {
        return None;
    }
    Some(decimal_of(scaled as u128, sz_decimals))
}

/// The decimals a price may have on Hyperliquid (tick-and-lot-size): at most 5 significant figures and at most
/// 6 − szDecimals decimals. A whole number is always allowed, so a price of 100,000 or more has none.
pub fn price_decimals(p: f64, sz_decimals: u32) -> u32 {
    let most = 6u32.saturating_sub(sz_decimals);
    let by_figures = if p >= 1.0 {
        // Digits before the point, counted against exact powers of ten.
        let mut k = 1u32;
        while k < 22 && p >= pow10(k) {
            k += 1;
        }
        5u32.saturating_sub(k)
    } else {
        // Zeros between the point and the first significant digit.
        let mut z = 0u32;
        while z < 20 && p * pow10(z + 1) < 1.0 {
            z += 1;
        }
        z + 5
    };
    by_figures.min(most)
}

/// A price of `p` rounded to Hyperliquid's rules for a coin of `sz_decimals`, down when `down`, else up, in wire
/// form; None for a price that rounds to 0 or isn't finite.
pub fn wire_price(p: f64, sz_decimals: u32, down: bool) -> Option<String> {
    if !(p.is_finite() && p > 0.0) {
        return None;
    }
    let d = price_decimals(p, sz_decimals);
    let scaled = p * pow10(d);
    let whole = if down {
        (scaled * (1.0 + NUDGE)).floor()
    } else {
        (scaled * (1.0 - NUDGE)).ceil()
    };
    if !(1.0..=1e30).contains(&whole) {
        return None;
    }
    Some(decimal_of(whole as u128, d))
}

/// A wire decimal as a number.
pub fn wire_value(s: &str) -> Option<f64> {
    s.parse::<f64>().ok().filter(|x| x.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn steps_have_the_interface_shape() {
        let steps = vec![
            PlanStep::Cancel {},
            PlanStep::Repay { amt: 10_000_000 },
            PlanStep::Perp {
                coin: "BTC".into(),
                buy: true,
                sz: "0.00375".into(),
                px: "76179".into(),
            },
            PlanStep::Sell {
                tok: "mnbtc.pbf-ops.testnet".into(),
                amt: "375000".into(),
                min: 280_000_000,
                dep: "ab".repeat(32),
                exp: 1_794_000_000_000,
            },
            PlanStep::ToHl {
                amt: 50_000_000,
                dep: "cd".repeat(32),
                exp: 1_794_000_000_000,
            },
            PlanStep::Home {
                amt: 427_651_787,
                dep: "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d".into(),
                exp: 1_794_000_000_000,
            },
        ];
        let text = serde_json::to_string(&steps).unwrap();
        assert!(text.starts_with(
            r#"[{"k":"cancel"},{"k":"repay","amt":10000000},{"k":"perp","coin":"BTC","buy":true,"sz":"0.00375","px":"76179"},"#
        ));
        assert!(text.contains(r#"{"k":"to_hl","amt":50000000,"#));
        let back: Vec<PlanStep> = serde_json::from_str(&text).unwrap();
        assert_eq!(back, steps);
        // INTERFACES.md 13: each step under 200 bytes.
        for s in &steps {
            assert!(serde_json::to_string(s).unwrap().len() < 200, "{s:?}");
        }
        assert!(steps[0].for_gateway() && steps[2].for_gateway() && !steps[1].for_gateway());
        assert_eq!(
            steps.iter().map(PlanStep::kind).collect::<Vec<_>>(),
            ["cancel", "repay", "perp", "sell", "to_hl", "home"]
        );
    }

    #[test]
    fn the_stored_plan_parses_with_its_done_flags() {
        let state = json!({"plan": {"pid": "276800123", "action": "DELEVERAGE", "stored_at": "1794000000000000000",
            "steps": [{"k": "repay", "amt": 10000000, "done": true},
                      {"k": "perp", "coin": "BTC", "buy": true, "sz": "0.00375", "px": "76179", "done": false}]}});
        let p = stored_plan(&state).unwrap().unwrap();
        assert_eq!(
            (p.pid.as_str(), p.action.as_str(), p.stored_at_ns),
            ("276800123", "DELEVERAGE", 1_794_000_000_000_000_000)
        );
        assert_eq!(p.steps.len(), 2);
        assert!(p.steps[0].1 && !p.steps[1].1);
        // The account also accepts amounts as strings of digits (its own sandbox tests store them so).
        let strings = json!({"plan": {"pid": "1320", "action": "REBALANCE", "stored_at": "1",
            "steps": [{"k": "to_hl", "amt": "100000000", "dep": "ab", "exp": 1700000600000u64, "done": true}]}});
        assert_eq!(
            stored_plan(&strings).unwrap().unwrap().steps[0].0,
            PlanStep::ToHl {
                amt: 100_000_000,
                dep: "ab".into(),
                exp: 1_700_000_600_000
            }
        );
        let mut bad_amt = strings.clone();
        bad_amt["plan"]["steps"][0]["amt"] = json!("1e8");
        assert!(stored_plan(&bad_amt).is_err());
        assert_eq!(stored_plan(&json!({"plan": null})), Ok(None));
        assert_eq!(stored_plan(&json!({})), Ok(None));
        let mut bad = state.clone();
        bad["plan"]["steps"][1]["k"] = json!("fly");
        assert!(stored_plan(&bad).unwrap_err().contains("step 1"));
        bad = state.clone();
        bad["plan"]["pid"] = json!("12x");
        assert!(stored_plan(&bad).is_err());
    }

    #[test]
    fn sizes_and_prices_follow_hyperliquids_rules() {
        // BTC: 5 size decimals, so whole-dollar prices above $10k.
        assert_eq!(wire_size(0.015 * 0.25, 5).as_deref(), Some("0.00375"));
        assert_eq!(wire_size(0.0037499, 5).as_deref(), Some("0.00374"));
        assert_eq!(wire_size(-0.3, 1).as_deref(), Some("0.3"));
        assert_eq!(wire_size(2.0, 2).as_deref(), Some("2"));
        assert_eq!(wire_size(0.000004, 5), None);
        assert_eq!(wire_price(76_179.3, 5, true).as_deref(), Some("76179"));
        assert_eq!(wire_price(76_179.3, 5, false).as_deref(), Some("76180"));
        assert_eq!(wire_price(123_456.7, 5, true).as_deref(), Some("123456"));
        // 5 significant figures, then 6 - szDecimals decimals.
        assert_eq!(wire_price(1.234_567, 2, true).as_deref(), Some("1.2345"));
        assert_eq!(wire_price(1.234_567, 2, false).as_deref(), Some("1.2346"));
        assert_eq!(
            wire_price(0.001_234_5, 0, true).as_deref(),
            Some("0.001234")
        );
        assert_eq!(
            wire_price(0.012_345_6, 1, false).as_deref(),
            Some("0.01235")
        );
        assert_eq!(wire_price(2_315.55, 4, true).as_deref(), Some("2315.5"));
        assert_eq!(wire_price(9.999_99, 2, false).as_deref(), Some("10"));
        assert_eq!(wire_price(0.0, 5, true), None);
        assert_eq!(price_decimals(76_000.0, 5), 0);
        assert_eq!(price_decimals(10_000.0, 0), 0);
        assert_eq!(price_decimals(9_999.0, 0), 1);
    }
}
