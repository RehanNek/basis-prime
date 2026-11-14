//! RISK_ENGINE.md 4.6: what selling everything costs at the end of every scenario. Hyperliquid perps pay the
//! taker fee, half the spread and square-root market impact; NEAR tokens pay 1Click's cost curve. Both grow
//! with the volatility factor f.
use crate::params::token;
use crate::py;
use crate::Engine;

impl Engine {
    /// c_g(N): the cost of closing `notional` dollars of coin `coin` on Hyperliquid, as a fraction.
    pub fn cost_hl(&self, coin: &str, notional: f64, f: f64) -> f64 {
        let c = self.coin(coin);
        let p = &self.params;
        let spread = match c.spread_bp {
            Some(s) if !s.is_nan() => s,
            _ => 2.0,
        };
        let sig_day = c.params.vol_ref / 365f64.sqrt() * f;
        let adv = c.adv30_usd * p.stressed_volume;
        p.hl_taker_fee + spread / 2e4 + p.impact_y * sig_day * (py::max(notional, 0.0) / adv).sqrt()
    }
}

/// c_j(V): the cost of selling `value` dollars of token `tok` through 1Click, as a fraction.
pub fn cost_1c(tok: &str, value: f64, f: f64) -> f64 {
    let t = token(tok);
    (t.c0 + t.c1 * (py::max(value, 0.0) / 1e5).sqrt()) * f
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_click_curve_matches_section_5_4() {
        // 0.23% for $10k and 0.5% for $100k of nBTC, at f = 1.
        assert!((cost_1c("nBTC", 10_000.0, 1.0) - 0.002_264_911).abs() < 1e-9);
        assert!((cost_1c("nBTC", 100_000.0, 1.0) - 0.005).abs() < 1e-15);
        assert_eq!(cost_1c("USDC", 1e9, 1.0), 0.0);
    }
}
