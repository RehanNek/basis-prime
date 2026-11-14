//! RISK_ENGINE.md 4.2 and 4.4: how big a coin's bad day is. The calibrated shock S grows with the volatility
//! factor f (wild markets, never below 1) and the liquidity factor ℓ = sqrt(1 + T / 4 h), where T is the hours
//! it takes to sell the group at our share of stressed volume, counting what the rest of the book holds.
use crate::params::token;
use crate::py;
use crate::snapshot::{Account, Market};
use crate::valuation::token_value;
use crate::Engine;

/// A coin's shock: S* = S × f × ℓ.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shock {
    /// S*, the move a normal 1·S* scenario applies.
    pub s_star: f64,
    /// The volatility factor f.
    pub f: f64,
    /// The liquidity factor ℓ.
    pub ell: f64,
}

impl Engine {
    /// T_g: hours to unwind group `g`, on Hyperliquid or through 1Click, whichever is slower.
    pub fn unwind_hours(&self, a: &Account, m: &Market, g: &str) -> f64 {
        let p = &self.params;
        let mut hl_h = 0.0;
        let q = a.perps.get_or(g, 0.0);
        if q != 0.0 {
            let cap = p.participation * p.stressed_volume * self.coin(g).adv30_usd / 24.0;
            hl_h = (q.abs() * m.mark_price(g) + m.book_of(g)) / cap;
        }
        let near_h = py::sum(
            a.near
                .iter()
                .filter(|(t, &u)| token(t).group == Some(g) && u != 0.0)
                .map(|(t, &u)| (token_value(t, u, m, 0.0, 0.0) + m.book_of(t)) / token(t).cap_h),
        );
        py::max(hl_h, near_h)
    }

    /// f_g: the volatility factor, between 1 and 2.5 (calm markets don't shrink anything).
    pub fn vol_factor(&self, m: &Market, g: &str) -> f64 {
        py::min(self.params.vol_cap, py::max(1.0, m.volf_of(g)))
    }

    /// S*_g for this account.
    pub fn shock(&self, a: &Account, m: &Market, g: &str) -> Shock {
        let f = self.vol_factor(m, g);
        let ell = (1.0 + self.unwind_hours(a, m, g) / self.params.h_hours).sqrt();
        Shock {
            s_star: self.coin(g).params.s * f * ell,
            f,
            ell,
        }
    }
}
