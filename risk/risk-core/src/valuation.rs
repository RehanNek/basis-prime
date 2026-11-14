//! RISK_ENGINE.md 3.3–3.4: what the account is worth. Mark equity decides states; allowance equity decides new
//! credit and withdrawals, so it leaves out money in flight, the last hour's gains (the TWAP rule), any
//! premium at Hyperliquid's mark (the mark rule) and frozen tokens, and values wrappers at π_allow (the lowest π
//! of the last hour). Ports the reference's valuation methods.
use crate::params::token;
use crate::py;
use crate::snapshot::{Account, Market};
use crate::Engine;
use std::collections::BTreeSet;

/// The USDC value of `units` of token `tok`, after a price move `mv` of its coin and a depeg `depeg`, at the
/// mark π (`m.wrap`).
pub fn token_value(tok: &str, units: f64, m: &Market, mv: f64, depeg: f64) -> f64 {
    token_value_at(tok, units, m, mv, depeg, m.wrap_ratio(tok))
}

/// The same at a given π (the reference's `token_value(..., pi=...)`).
pub fn token_value_at(tok: &str, units: f64, m: &Market, mv: f64, depeg: f64, pi: f64) -> f64 {
    match token(tok).group {
        None => units * pi * (1.0 - depeg),
        Some(g) => units * m.price(g) * (1.0 + mv) * pi * (1.0 - depeg),
    }
}

impl Engine {
    /// 4.1: the groups (coins) the account holds, by name: each nonzero perp, and each coin a nonzero NEAR
    /// token wraps.
    pub fn groups(&self, a: &Account) -> Vec<String> {
        let mut gs: BTreeSet<String> = a
            .perps
            .iter()
            .filter(|(_, &q)| q != 0.0)
            .map(|(c, _)| c.to_string())
            .collect();
        for (t, _) in a.near.iter().filter(|(_, &u)| u != 0.0) {
            if let Some(g) = token(t).group {
                gs.insert(g.to_string());
            }
        }
        gs.into_iter().collect()
    }

    /// n_g: net units of coin `g`, NEAR tokens (at π) plus the perp, leaving out the tokens in `skip`.
    pub fn net_units(
        &self,
        a: &Account,
        m: &Market,
        g: &str,
        skip: Option<&BTreeSet<String>>,
    ) -> f64 {
        let n = py::sum(
            a.near
                .iter()
                .filter(|(t, _)| token(t).group == Some(g) && !skip.is_some_and(|s| s.contains(*t)))
                .map(|(t, &u)| u * m.wrap_ratio(t)),
        );
        n + a.perps.get_or(g, 0.0)
    }

    /// Φ: money in flight that isn't overdue, at 98%, for the state; nothing for allowances.
    pub fn inflight_value(&self, a: &Account, m: &Market, for_state: bool) -> f64 {
        if !for_state {
            return 0.0;
        }
        py::sum(a.inflight.iter().filter(|f| !f.overdue).map(|f| {
            self.params.inflight_state_value * token_value(&f.token, f.units, m, 0.0, 0.0)
        }))
    }

    /// E: mark equity.
    pub fn equity_mark(&self, a: &Account, m: &Market) -> f64 {
        let near = py::sum(a.near.iter().map(|(t, &u)| token_value(t, u, m, 0.0, 0.0)));
        near + self.hl_equity_now(a, m) + self.inflight_value(a, m, true) - a.debt
    }

    /// A: recent gains on net exposure don't count toward new credit. Frozen tokens are already out of
    /// allowance equity, so their units are left out here too.
    pub fn twap_adjustment(&self, a: &Account, m: &Market) -> f64 {
        py::sum(self.groups(a).iter().map(|g| {
            py::max(
                0.0,
                self.net_units(a, m, g, Some(&m.frozen)) * (m.price(g) - m.twap_of(g)),
            )
        }))
    }

    /// M: for new credit, a perp counts at the less favourable of mark and reference price.
    pub fn mark_adjustment(&self, a: &Account, m: &Market) -> f64 {
        py::sum(
            a.perps
                .iter()
                .map(|(c, &q)| py::max(0.0, q * (m.mark_price(c) - m.price(c)))),
        )
    }

    /// 3.3: a frozen token counts as zero toward new credit (π_allow = 0). It keeps its market value in mark
    /// equity, so the freeze alone never moves an account to a worse state.
    pub fn frozen_value(&self, a: &Account, m: &Market) -> f64 {
        py::sum(
            a.near
                .iter()
                .filter(|(t, _)| m.frozen.contains(*t))
                .map(|(t, &u)| token_value(t, u, m, 0.0, 0.0)),
        )
    }

    /// 3.3: for new credit, a wrapper counts at π_allow, not at the mark π. Only allowance equity uses it, so a
    /// low π_allow lowers credit but never moves the state. Frozen tokens are already out (`frozen_value`).
    pub fn wrap_adjustment(&self, a: &Account, m: &Market) -> f64 {
        py::sum(
            a.near
                .iter()
                .filter(|(t, _)| m.wrap_allow.contains_key(*t) && !m.frozen.contains(*t))
                .map(|(t, &u)| {
                    token_value(t, u, m, 0.0, 0.0)
                        - token_value_at(t, u, m, 0.0, 0.0, m.pi_allow(t))
                }),
        )
    }

    /// E_A: allowance equity.
    pub fn equity_allow(&self, a: &Account, m: &Market) -> f64 {
        self.equity_mark(a, m)
            - self.inflight_value(a, m, true)
            - self.twap_adjustment(a, m)
            - self.mark_adjustment(a, m)
            - self.frozen_value(a, m)
            - self.wrap_adjustment(a, m)
    }

    /// 8.3: mark equity after coin `g` (its reference price and its mark) moves by `x`.
    pub fn equity_at(&self, a: &Account, m: &Market, g: &str, x: f64) -> f64 {
        self.equity_mark(a, &self.moved_market(m, g, x))
    }

    /// Market `m` with coin `g`'s reference price and mark moved by `x`.
    pub fn moved_market(&self, m: &Market, g: &str, x: f64) -> Market {
        let mut m2 = m.clone();
        m2.px.insert(g.to_string(), m.price(g) * (1.0 + x));
        if m.mark.contains_key(g) {
            m2.mark.insert(g.to_string(), m.mark_price(g) * (1.0 + x));
        }
        m2
    }
}
