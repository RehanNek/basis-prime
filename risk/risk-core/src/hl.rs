//! The Hyperliquid replica (RISK_ENGINE.md 4.3 and 8.2): tiered maintenance margin, account value, the margin
//! ratio, and what must stay on Hyperliquid after a transfer out. Ports `Engine.mm`, `hl_equity_now`,
//! `hl_ratio` and `hl_keep` of `risk_engine_ref.py`. The liquidation rule itself runs inside each scenario
//! (`stress.rs`).
use crate::py;
use crate::snapshot::{Account, Market};
use crate::Engine;
use std::collections::BTreeMap;

/// One row of a Hyperliquid margin table: from `lower_bound` dollars of notional, `max_leverage`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tier {
    pub lower_bound: f64,
    pub max_leverage: u32,
}

/// Maintenance margin with Hyperliquid's tiers: N × rate_n − deduction_n, where rate_n = 1 / (2 × maxLev_n)
/// and the deductions keep the margin continuous at each tier's lower bound. `tiers` must be sorted by
/// lower bound and start at 0. Margin tables are read live from `metaAndAssetCtxs`, never hard-coded,
/// because they differ between networks (`research/day1.md`).
pub fn maintenance_margin(tiers: &[Tier], notional: f64) -> f64 {
    if notional <= 0.0 {
        return 0.0;
    }
    let (mut rate, mut ded, mut prev, mut ded_at) = (0.0, 0.0, 0.0, 0.0);
    for (i, t) in tiers.iter().enumerate() {
        let r = 1.0 / (2.0 * f64::from(t.max_leverage));
        if i > 0 {
            ded += t.lower_bound * (r - prev);
        }
        if notional >= t.lower_bound {
            rate = r;
            ded_at = ded;
        }
        prev = r;
    }
    (notional * rate - ded_at).max(0.0)
}

impl Engine {
    /// `mm(coin, notional)`: the coin's maintenance margin on `notional` dollars of position.
    pub fn mm(&self, coin: &str, notional: f64) -> f64 {
        maintenance_margin(&self.coin(coin).margin_tiers, notional)
    }

    /// Hyperliquid account value: cash plus open PnL at the marks.
    pub fn hl_equity_now(&self, a: &Account, m: &Market) -> f64 {
        a.hl_cash
            + py::sum(
                a.perps
                    .iter()
                    .map(|(c, &q)| q * (m.mark_price(c) - a.entry.get_or(c, m.mark_price(c)))),
            )
    }

    /// Hyperliquid's margin ratio (maintenance margin / account value), after optional moves of the marks.
    /// 0 with no position; infinite once the account value is gone.
    pub fn hl_ratio(&self, a: &Account, m: &Market, moves: Option<&BTreeMap<String, f64>>) -> f64 {
        let mut eq = self.hl_equity_now(a, m);
        let mut mmv = 0.0;
        for (c, &q) in a.perps.iter() {
            let x = moves.and_then(|mv| mv.get(c)).copied().unwrap_or(0.0);
            let mk = m.mark_price(c) * (1.0 + x);
            eq += q * (mk - m.mark_price(c));
            mmv += self.mm(c, q.abs() * mk);
        }
        if mmv == 0.0 {
            return 0.0;
        }
        if eq <= 0.0 {
            f64::INFINITY
        } else {
            mmv / eq
        }
    }

    /// 8.2: Hyperliquid equity that must stay after any transfer out: our 30% margin-ratio target, and
    /// Hyperliquid's own rule, max(initial margin, 10% of total position value).
    pub fn hl_keep(&self, a: &Account, m: &Market) -> f64 {
        let notional: Vec<(&str, f64)> = a
            .perps
            .iter()
            .filter(|(_, &q)| q != 0.0)
            .map(|(c, &q)| (c, q.abs() * m.mark_price(c)))
            .collect();
        if notional.is_empty() {
            return 0.0;
        }
        let mmv = py::sum(notional.iter().map(|&(c, n)| self.mm(c, n)));
        let im = py::sum(
            notional
                .iter()
                .map(|&(c, n)| n / f64::from(self.coin(c).hl_max_leverage)),
        );
        let total = py::sum(notional.iter().map(|&(_, n)| n));
        py::max3(mmv / self.params.hl_ratio_target, im, 0.10 * total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn tier(lower_bound: f64, max_leverage: u32) -> Tier {
        Tier {
            lower_bound,
            max_leverage,
        }
    }

    // Read on 5 Nov 2026 (research/data/day1_hl_testnet.json).
    const MAINNET_BTC: [Tier; 2] = [tier(0.0, 40), tier(150_000_000.0, 20)];
    const TESTNET_BTC: [Tier; 3] = [tier(0.0, 40), tier(10_000.0, 25), tier(50_000.0, 10)];

    #[test]
    fn matches_the_python_reference() {
        let cases = [
            (&MAINNET_BTC[..], 25_000.0, 312.5),
            (&MAINNET_BTC[..], 100_000.0, 1_250.0),
            (&TESTNET_BTC[..], 25_000.0, 425.0),
            (&TESTNET_BTC[..], 100_000.0, 3_425.0),
        ];
        for (tiers, notional, want) in cases {
            let got = maintenance_margin(tiers, notional);
            assert!(
                (got - want).abs() < 1e-9,
                "{notional}: got {got}, want {want}"
            );
        }
    }

    #[test]
    fn continuous_at_every_tier_bound() {
        for t in &TESTNET_BTC[1..] {
            let below = maintenance_margin(&TESTNET_BTC, t.lower_bound - 1e-6);
            let at = maintenance_margin(&TESTNET_BTC, t.lower_bound);
            assert!((below - at).abs() < 1e-6, "jump at {}", t.lower_bound);
        }
    }

    #[test]
    fn zero_for_no_position() {
        assert_eq!(maintenance_margin(&MAINNET_BTC, 0.0), 0.0);
    }
}
