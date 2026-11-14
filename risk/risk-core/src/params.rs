//! RISK_ENGINE.md 10: the global parameters (the reference's `G`), the client tiers (`TIERS`), the NEAR-side
//! tokens (`TOKENS`, 5.4) and the pool's rate curve (7.1). Values and arithmetic are the reference's.
use crate::py;
use serde::{Deserialize, Serialize};

/// The global parameters, version 0 defaults ([`Params::V0`]).
#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    /// Price-shock horizon: time to notice, decide and unwind (hours).
    pub h_hours: f64,
    /// Carry reserve horizon (days); [`Params::tau`] turns it into a fraction of a year.
    pub carry_days: f64,
    pub k_normal: [f64; 3],
    pub k_extreme: f64,
    /// A price can't fall more than 90% in one invented scenario.
    pub extreme_down_cap: f64,
    pub adl_pairs: [(f64, f64); 2],
    /// Squeeze a perp into liquidation, then reverse.
    pub reversal_pairs: [(f64, f64); 3],
    /// One order at most 1% of the coin's daily Hyperliquid volume.
    pub max_order_adv: f64,
    /// Extreme scenarios count at half.
    pub ext_weight: f64,
    /// Replays count in full (PLAN.md 6.9); RISK_ENGINE.md 13.1 lists the options.
    pub replay_weight: f64,
    /// Option: clip every replay move at the coin's extreme size.
    pub replay_cap_2s: bool,
    /// Initial requirement = 1.25 x maintenance requirement.
    pub im_mult: f64,
    /// Extreme scenarios may cost the pool at most 5% of the loan.
    pub pool_loss_budget: f64,
    pub vol_cap: f64,
    /// We take at most 10% of stressed Hyperliquid volume per hour.
    pub participation: f64,
    /// In stress, assume half the normal volume.
    pub stressed_volume: f64,
    /// Square-root impact coefficient.
    pub impact_y: f64,
    pub hl_taker_fee: f64,
    /// Hyperliquid book-liquidation slippage, at least 0.2%.
    pub liq_slip_floor: f64,
    /// Below 2/3 of maintenance, the backstop takes what is left.
    pub backstop_frac: f64,
    /// Deleverage below 0.8 x MR.
    pub deleverage_frac: f64,
    pub margin_call_hours: f64,
    /// Hyperliquid margin ratio allowed after a risk-adding trade.
    pub hl_ratio_pretrade: f64,
    pub hl_ratio_rebalance: f64,
    pub hl_ratio_target: f64,
    pub hl_ratio_emergency: f64,
    /// Money in flight counts at 98% for the state, 0 for allowances.
    pub inflight_state_value: f64,
    pub util_cap: f64,
    pub client_pool_share: f64,
    pub unwind_hours_max: f64,
    pub min_equity_for_credit: f64,
    pub hysteresis: f64,
    pub rate_kink_u: f64,
    pub rate_kink: f64,
    pub rate_max: f64,
}

impl Params {
    pub const V0: Params = Params {
        h_hours: 4.0,
        carry_days: 7.0,
        k_normal: [1.0 / 3.0, 2.0 / 3.0, 1.0],
        k_extreme: 2.0,
        extreme_down_cap: 0.90,
        adl_pairs: [(2.0 / 3.0, 2.0 / 3.0), (1.0, 0.5)],
        reversal_pairs: [(2.0 / 3.0, 2.0 / 3.0), (1.0, 0.5), (1.0, 1.0)],
        max_order_adv: 0.01,
        ext_weight: 0.5,
        replay_weight: 1.0,
        replay_cap_2s: false,
        im_mult: 1.25,
        pool_loss_budget: 0.05,
        vol_cap: 2.5,
        participation: 0.10,
        stressed_volume: 0.5,
        impact_y: 1.0,
        hl_taker_fee: 0.00045,
        liq_slip_floor: 0.002,
        backstop_frac: 2.0 / 3.0,
        deleverage_frac: 0.8,
        margin_call_hours: 4.0,
        hl_ratio_pretrade: 0.50,
        hl_ratio_rebalance: 0.60,
        hl_ratio_target: 0.30,
        hl_ratio_emergency: 0.80,
        inflight_state_value: 0.98,
        util_cap: 0.90,
        client_pool_share: 0.25,
        unwind_hours_max: 24.0,
        min_equity_for_credit: 1_000.0,
        hysteresis: 0.02,
        rate_kink_u: 0.80,
        rate_kink: 0.06,
        rate_max: 0.50,
    };

    /// 7.1: the pool's base rate at utilisation `u` (PLAN.md 5.1).
    pub fn base_rate(&self, u: f64) -> f64 {
        let u = py::min(py::max(u, 0.0), 1.0);
        if u <= self.rate_kink_u {
            return self.rate_kink * u / self.rate_kink_u;
        }
        self.rate_kink
            + (self.rate_max - self.rate_kink) * (u - self.rate_kink_u) / (1.0 - self.rate_kink_u)
    }

    /// 4.7: τ, the carry horizon as a fraction of a year (7 / 365), read at each use.
    pub fn tau(&self) -> f64 {
        self.carry_days / 365.0
    }
}

impl Default for Params {
    fn default() -> Self {
        Self::V0
    }
}

/// A client tier (RISK_ENGINE.md 6).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ClientTier {
    Preferred,
    #[default]
    Standard,
    Watch,
}

/// What a tier sets: the loan cap on collateral, the rate markup, and the client's limit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TierSpec {
    pub cap: f64,
    pub spread: f64,
    pub limit0: f64,
    pub limit_max: f64,
}

impl ClientTier {
    pub fn spec(self) -> TierSpec {
        match self {
            ClientTier::Preferred => TierSpec {
                cap: 0.85,
                spread: 0.01,
                limit0: 1_000_000.0,
                limit_max: 5_000_000.0,
            },
            ClientTier::Standard => TierSpec {
                cap: 0.70,
                spread: 0.02,
                limit0: 250_000.0,
                limit_max: 1_000_000.0,
            },
            ClientTier::Watch => TierSpec {
                cap: 0.50,
                spread: 0.05,
                limit0: 50_000.0,
                limit_max: 100_000.0,
            },
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ClientTier::Preferred => "PREFERRED",
            ClientTier::Standard => "STANDARD",
            ClientTier::Watch => "WATCH",
        }
    }
}

/// A NEAR-side token allowed in version 0 (RISK_ENGINE.md 5.4).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Token {
    pub name: &'static str,
    /// The coin it wraps; stablecoins have none.
    pub group: Option<&'static str>,
    /// Slip below the underlying in the (normal, crash, extreme) depeg scenarios.
    pub depeg: [f64; 3],
    /// 1Click unwind cost = (c0 + c1 * sqrt(value / $100k)) * volatility factor.
    pub c0: f64,
    pub c1: f64,
    /// 1Click capacity, dollars per hour.
    pub cap_h: f64,
}

/// USDT and ETH capacities are the largest sales 1Click quoted every time on 5 Nov 2026 (research/day1.md).
/// WBTC (FUNDING.md 6.2) is the bitcoin an account holds on Aave's chain: it wraps BTC as nBTC does, with nBTC's
/// settings. It is not in `universe_v0.json` or the reference cases, which hold no WBTC.
pub const TOKENS: [Token; 6] = [
    Token {
        name: "USDC",
        group: None,
        depeg: [0.0, 0.0, 0.0],
        c0: 0.0,
        c1: 0.0,
        cap_h: f64::INFINITY,
    },
    Token {
        name: "USDT",
        group: None,
        depeg: [0.01, 0.01, 0.13],
        c0: 0.0005,
        c1: 0.0005,
        cap_h: 500_000.0,
    },
    Token {
        name: "nBTC",
        group: Some("BTC"),
        depeg: [0.02, 0.05, 0.20],
        c0: 0.001,
        c1: 0.004,
        cap_h: 500_000.0,
    },
    Token {
        name: "ETH.b",
        group: Some("ETH"),
        depeg: [0.02, 0.05, 0.20],
        c0: 0.001,
        c1: 0.004,
        cap_h: 50_000.0,
    },
    Token {
        name: "wNEAR",
        group: Some("NEAR"),
        depeg: [0.0, 0.0, 0.0],
        c0: 0.001,
        c1: 0.004,
        cap_h: 250_000.0,
    },
    Token {
        name: "WBTC",
        group: Some("BTC"),
        depeg: [0.02, 0.05, 0.20],
        c0: 0.001,
        c1: 0.004,
        cap_h: 500_000.0,
    },
];

/// The token called `name`, if version 0 allows it.
pub fn find_token(name: &str) -> Option<&'static Token> {
    TOKENS.iter().find(|t| t.name == name)
}

/// The token called `name`. Snapshots are checked first ([`crate::Engine::check_snapshot`]), so an unknown
/// token here is a bug, as the reference's KeyError would be.
pub fn token(name: &str) -> &'static Token {
    find_token(name).unwrap_or_else(|| panic!("unknown NEAR token {name:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wbtc_is_a_sixth_token_with_nbtcs_settings() {
        let (w, n) = (token("WBTC"), token("nBTC"));
        assert_eq!(
            (w.group, w.depeg, w.c0, w.c1, w.cap_h),
            (n.group, n.depeg, n.c0, n.c1, n.cap_h)
        );
        assert_eq!(TOKENS.len(), 6);
    }

    #[test]
    fn rate_curve_kinks_at_80_percent() {
        let p = Params::V0;
        assert_eq!(p.base_rate(0.6), 0.06 * 0.6 / 0.8);
        assert!((p.base_rate(0.8) - 0.06).abs() < 1e-15);
        assert!((p.base_rate(1.0) - 0.50).abs() < 1e-15);
        assert_eq!(p.base_rate(1.5), p.base_rate(1.0));
        assert_eq!(p.base_rate(-1.0), 0.0);
    }
}
