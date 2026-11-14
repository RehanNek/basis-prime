//! RISK_ENGINE.md 8.1–8.3: the account's state and the action it asks for, and the bands keepers watch.
//! States bind only while the account owes the pool. Hysteresis only slows improvements: a better state needs
//! equity 2% above its threshold. A REBALANCE is asked for when Hyperliquid's margin ratio is high, or would
//! pass 100% after every perp moves ½·S* against itself. Ports `raw_state`, `state` and `band`.
use crate::py::{self, sgn};
use crate::snapshot::{Account, Market};
use crate::stress::Requirement;
use crate::Engine;
use std::collections::BTreeMap;

/// The account's state, from best to worst (the reference's `ORDER`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum State {
    Healthy,
    Watch,
    MarginCall,
    Deleverage,
}

impl State {
    pub const ORDER: [State; 4] = [
        State::Healthy,
        State::Watch,
        State::MarginCall,
        State::Deleverage,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            State::Healthy => "HEALTHY",
            State::Watch => "WATCH",
            State::MarginCall => "MARGIN_CALL",
            State::Deleverage => "DELEVERAGE",
        }
    }

    /// The state named `name` ("HEALTHY", ...), if any.
    pub fn parse(name: &str) -> Option<State> {
        State::ORDER.into_iter().find(|s| s.as_str() == name)
    }
}

/// What the engine asks the keeper to do (8.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    None,
    Rebalance,
    /// Hyperliquid is close to liquidating: act without the second check.
    RebalanceNow,
    Deleverage,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::None => "NONE",
            Action::Rebalance => "REBALANCE",
            Action::RebalanceNow => "REBALANCE_NOW",
            Action::Deleverage => "DELEVERAGE",
        }
    }
}

/// The state, the action, Hyperliquid's margin ratio, and whether ½·S* against every perp would breach it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Status {
    pub state: State,
    pub action: Action,
    pub hl_ratio: f64,
    pub venue_breach: bool,
}

impl Engine {
    /// The state from E, MR and IM alone, with every threshold raised by `h` (hysteresis).
    pub fn raw_state(&self, e: f64, mr: f64, im: f64, margin_call_age_h: f64, h: f64) -> State {
        let p = &self.params;
        if e >= im * (1.0 + h) {
            State::Healthy
        } else if e >= mr * (1.0 + h) {
            State::Watch
        } else if e >= p.deleverage_frac * mr * (1.0 + h) && margin_call_age_h < p.margin_call_hours
        {
            State::MarginCall
        } else {
            State::Deleverage
        }
    }

    /// 8.1: the state and action. Of `req` only E, MR and IM are used. `margin_call_age_h` is the margin
    /// call's clock; `prev` the last verdict's state, for hysteresis.
    pub fn state(
        &self,
        a: &Account,
        m: &Market,
        req: &Requirement,
        margin_call_age_h: f64,
        prev: Option<State>,
    ) -> Status {
        let p = &self.params;
        let (e, mr, im) = (req.e, req.mr, req.im);
        if a.debt <= 0.0 {
            // States bind only while the account owes the pool.
            return Status {
                state: State::Healthy,
                action: Action::None,
                hl_ratio: self.hl_ratio(a, m, None),
                venue_breach: false,
            };
        }
        let mut st = self.raw_state(e, mr, im, margin_call_age_h, 0.0);
        if let Some(prev) = prev {
            if st < prev {
                let up = self.raw_state(e, mr, im, margin_call_age_h, p.hysteresis);
                st = up.min(prev);
            }
        }
        let projected: BTreeMap<String, f64> = a
            .perps
            .iter()
            .filter(|(_, &q)| q != 0.0)
            .map(|(g, &q)| {
                (
                    g.to_string(),
                    f64::from(-sgn(q)) * 0.5 * self.shock(a, m, g).s_star,
                )
            })
            .collect();
        let venue_breach = !a.perps.is_empty() && self.hl_ratio(a, m, Some(&projected)) >= 1.0;
        let ratio = self.hl_ratio(a, m, None);
        let action = if st == State::Deleverage {
            Action::Deleverage
        } else if ratio >= p.hl_ratio_emergency {
            Action::RebalanceNow
        } else if venue_breach || ratio >= p.hl_ratio_rebalance {
            Action::Rebalance
        } else {
            Action::None
        };
        Status {
            state: st,
            action,
            hl_ratio: ratio,
            venue_breach,
        }
    }
}

/// 8.3: the nearest move from 0 toward the far end of [lo, hi] where `f(x)` crosses `target`: scan in steps
/// (0.5% in the reference), then bisect inside the first step that changes sign. `f` is re-evaluated in full at
/// every point. `None` if it never crosses.
pub fn band(
    mut f: impl FnMut(f64) -> f64,
    target: f64,
    lo: f64,
    hi: f64,
    step: f64,
) -> Option<f64> {
    let end = if hi.abs() > lo.abs() { hi } else { lo };
    let direction = if end > 0.0 { 1.0 } else { -1.0 };
    let (mut x0, mut f0) = (0.0, f(0.0) - target);
    let mut x: f64 = 0.0;
    while x.abs() < end.abs() - 1e-12 {
        let x1 = direction * py::min(x.abs() + step, end.abs());
        let f1 = f(x1) - target;
        if f0 == 0.0 {
            return Some(x0);
        }
        if (f0 > 0.0) != (f1 > 0.0) {
            let (mut a, mut b, mut fa) = (x0, x1, f0);
            for _ in 0..50 {
                let mid = (a + b) / 2.0;
                let fm = f(mid) - target;
                if (fm > 0.0) == (fa > 0.0) {
                    a = mid;
                    fa = fm;
                } else {
                    b = mid;
                }
            }
            return Some((a + b) / 2.0);
        }
        x0 = x1;
        f0 = f1;
        x = x1;
    }
    None
}

/// The step the reference's bands use: 0.5%.
pub const BAND_STEP: f64 = 0.005;
