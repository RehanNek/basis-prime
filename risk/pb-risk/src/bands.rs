//! The searches the verdict runs on top of the engine: the Hyperliquid top-up (RISK_ENGINE.md 8.2) and the bands
//! (8.3). Both re-run the stress test many times, and one stress test of a hedged book costs about 27M WASM
//! instructions on OutLayer, so they are written to fit the 2B-instruction limit of a run:
//! - the top-up is risk-core's own search, but each probe replays only the scenarios it asks about;
//! - the equity bands scan in 5% steps instead of 0.5%, narrow each crossing with 6 bisections (to 0.08%),
//!   and share a budget of full re-evaluations. A band the scan or the budget doesn't reach is left out, as
//!   Appendix A allows. The reported level is the end of the last bisection step nearer today, so a keeper's
//!   trigger fires early rather than late.
use risk_core::py::{self, sgn};
use risk_core::states::{band, BAND_STEP};
use risk_core::{Account, Engine, Market, Requirement, Scenario};
use std::collections::BTreeSet;

/// Equity bands: scan step, bisections per band, and how far the scan goes.
pub const SCAN_STEP: f64 = 0.05;
pub const BISECTIONS: usize = 6;
pub const COIN_RANGE: f64 = 0.5;
pub const PI_RANGE: f64 = 0.5;
/// Full re-evaluations the bands may spend on a book of two legs (a hedged pair: about 27M instructions each).
/// A bigger book costs more per evaluation, so it gets proportionally fewer ([`eval_budget`]).
pub const EVAL_BUDGET_2_LEGS: usize = 44;

/// The bands' budget for a book with `legs` coin legs (NEAR tokens that wrap a coin, and perps).
pub fn eval_budget(legs: usize) -> usize {
    EVAL_BUDGET_2_LEGS * 2 / legs.max(2)
}

/// 8.2 and Appendix A: the smallest Hyperliquid top-up (whole dollars, rounded up) after which none of the
/// liquidations among today's top three risks happens; 0 if there is none, infinite past $1T.
///
/// The same search as `Engine::topup`, with the same answer: the scenario list doesn't depend on Hyperliquid cash,
/// so each probe runs only the named scenarios instead of the whole requirement.
pub fn topup(eng: &Engine, a: &Account, m: &Market, req: &Requirement) -> f64 {
    let names: BTreeSet<&str> = eng
        .ranked(req)
        .into_iter()
        .take(3)
        .filter(|r| r.det.is_some_and(|d| d.liq.is_some()))
        .map(|r| r.name.as_str())
        .collect();
    if names.is_empty() {
        return 0.0;
    }
    let set = eng.scenarios(a, m);
    let named: Vec<&Scenario> = set
        .list
        .iter()
        .filter(|s| names.contains(s.name.as_str()))
        .collect();
    let still = |extra: f64| {
        let b = Account {
            hl_cash: a.hl_cash + extra,
            ..a.clone()
        };
        named.iter().any(|sc| {
            eng.run(&b, m, sc, &set.groups, 0.0)
                .2
                .is_some_and(|d| d.liq.is_some())
        })
    };
    let mut hi = py::max(
        1_000.0,
        py::sum(a.perps.iter().map(|(c, &q)| q.abs() * m.mark_price(c))),
    );
    while still(hi) {
        hi *= 2.0;
        if hi > 1e12 {
            return f64::INFINITY;
        }
    }
    let mut lo = 0.0;
    while hi - lo > 0.01 {
        let mid = (lo + hi) / 2.0;
        if still(mid) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    hi.ceil()
}

/// 4.5's "adverse" for coin `g`: against the net position, or against the perp for an exact hedge.
pub fn adverse(eng: &Engine, a: &Account, m: &Market, g: &str) -> f64 {
    let perp = a.perps.get_or(g, 0.0);
    let net = eng.net_units(a, m, g, None);
    let gross = perp.abs()
        + py::sum(
            a.near
                .iter()
                .filter(|(t, _)| risk_core::params::token(t).group == Some(g))
                .map(|(_, u)| u.abs()),
        );
    let s = if net.abs() > 1e-9 * gross {
        -sgn(net)
    } else {
        match -sgn(perp) {
            0 => -1,
            s => s,
        }
    };
    f64::from(s)
}

/// The moves of coin `g`'s mark where Hyperliquid's margin ratio reaches 50% and 100%, searching against its perp
/// (risk-core's band search, as RISK_ENGINE.md 13.3 runs it: cheap, since only the ratio is recomputed).
pub fn hl_bands(eng: &Engine, a: &Account, m: &Market, g: &str) -> (Option<f64>, Option<f64>) {
    let q = a.perps.get_or(g, 0.0);
    if q == 0.0 {
        return (None, None);
    }
    let f = |x: f64| {
        let mut m2 = m.clone();
        m2.mark.insert(g.to_string(), m.mark_price(g) * (1.0 + x));
        eng.hl_ratio(a, &m2, None)
    };
    let (lo, hi) = if q < 0.0 { (0.0, 3.0) } else { (-0.99, 0.0) };
    (
        band(f, 0.5, lo, hi, BAND_STEP),
        band(f, 1.0, lo, hi, BAND_STEP),
    )
}

/// For each multiple k of MR, the nearest move x from 0 toward `end` where E(x) − k·MR(x) changes sign. `eval(x)`
/// returns (E, MR) after the move, with MR re-evaluated in full; `at0` is today's. Each call of `eval` spends one
/// unit of `budget`. A crossing is found in steps of `SCAN_STEP`, then narrowed by `BISECTIONS`; the result is the
/// narrowed bracket's end nearer today.
pub fn crossings(
    mut eval: impl FnMut(f64) -> (f64, f64),
    at0: (f64, f64),
    ks: &[f64],
    end: f64,
    budget: &mut usize,
) -> Vec<Option<f64>> {
    let f = |v: (f64, f64), k: f64| v.0 - k * v.1;
    // Per target: the bracket (near end, far end, value at the near end), once found.
    let mut brackets: Vec<Option<(f64, f64, f64)>> = vec![None; ks.len()];
    let mut exact: Vec<bool> = vec![false; ks.len()];
    let dir = if end > 0.0 { 1.0 } else { -1.0 };
    let (mut x0, mut v0) = (0.0_f64, at0);
    let mut i = 0usize;
    while x0.abs() < end.abs() - 1e-12 && brackets.iter().any(Option::is_none) && *budget > 0 {
        i += 1;
        let x1 = dir * py::min(SCAN_STEP * i as f64, end.abs());
        *budget -= 1;
        let v1 = eval(x1);
        for (j, &k) in ks.iter().enumerate() {
            if brackets[j].is_some() {
                continue;
            }
            let (a, b) = (f(v0, k), f(v1, k));
            if a == 0.0 {
                brackets[j] = Some((x0, x0, a));
                exact[j] = true;
            } else if (a > 0.0) != (b > 0.0) {
                brackets[j] = Some((x0, x1, a));
            }
        }
        x0 = x1;
        v0 = v1;
    }
    brackets
        .iter()
        .zip(ks)
        .zip(exact)
        .map(|((br, &k), exact)| {
            let (mut near, mut far, mut f_near) = (*br)?;
            if !exact {
                for _ in 0..BISECTIONS {
                    if *budget == 0 {
                        break;
                    }
                    *budget -= 1;
                    let mid = (near + far) / 2.0;
                    let fm = f(eval(mid), k);
                    if (fm > 0.0) == (f_near > 0.0) {
                        near = mid;
                        f_near = fm;
                    } else {
                        far = mid;
                    }
                }
            }
            Some(near)
        })
        .collect()
}

/// Coin `g`'s equity bands: the moves of its price (reference and mark together) where E reaches IM and MR,
/// searching in the adverse direction.
pub fn coin_equity_bands(
    eng: &Engine,
    a: &Account,
    m: &Market,
    req: &Requirement,
    g: &str,
    budget: &mut usize,
) -> (Option<f64>, Option<f64>) {
    let end = adverse(eng, a, m, g) * COIN_RANGE;
    let eval = |x: f64| {
        let r = eng.requirement(a, &eng.moved_market(m, g, x));
        (r.e, r.mr)
    };
    let im = eng.params.im_mult;
    let found = crossings(eval, (req.e, req.mr), &[im, 1.0], end, budget);
    (found[0], found[1])
}

/// Token `t`'s bands: the moves of its π (relative to today's) where E reaches IM, MR and 0.8 × MR.
pub fn token_bands(
    eng: &Engine,
    a: &Account,
    m: &Market,
    req: &Requirement,
    t: &str,
    budget: &mut usize,
) -> [Option<f64>; 3] {
    let pi = m.wrap_ratio(t);
    let eval = |x: f64| {
        let mut m2 = m.clone();
        m2.wrap.insert(t.to_string(), pi * (1.0 + x));
        let r = eng.requirement(a, &m2);
        (r.e, r.mr)
    };
    let p = &eng.params;
    let found = crossings(
        eval,
        (req.e, req.mr),
        &[p.im_mult, 1.0, p.deleverage_frac],
        -PI_RANGE,
        budget,
    );
    [found[0], found[1], found[2]]
}

#[cfg(test)]
mod tests {
    use super::*;
    use risk_core::OrderedMap;

    fn hedged(debt: f64) -> (Engine, Account, Market) {
        let eng = Engine::v0();
        let m = eng.calm_market();
        let p = m.price("BTC");
        let q = 100_000.0 / p;
        let one = |k: &str, v: f64| -> OrderedMap<f64> { [(k, v)].into_iter().collect() };
        let a = Account {
            near: one("nBTC", q),
            hl_cash: 35_000.0,
            perps: one("BTC", -q),
            entry: one("BTC", p),
            debt,
            ..Account::default()
        };
        (eng, a, m)
    }

    #[test]
    fn the_fast_topup_is_risk_cores() {
        let (eng, a, m) = hedged(94_500.0);
        let req = eng.requirement(&a, &m);
        assert_eq!(topup(&eng, &a, &m, &req), eng.topup(&a, &m));
        assert_eq!(topup(&eng, &a, &m, &req), 11_251.0); // RISK_ENGINE.md 13.1
        let (eng, a, m) = hedged(0.0);
        let a = Account {
            hl_cash: 60_000.0,
            ..a
        };
        let req = eng.requirement(&a, &m);
        assert_eq!(topup(&eng, &a, &m, &req), eng.topup(&a, &m));
    }

    #[test]
    fn bands_land_near_section_13_3() {
        let (eng, a, m) = hedged(94_500.0);
        let req = eng.requirement(&a, &m);
        let (hl50, hl100) = hl_bands(&eng, &a, &m, "BTC");
        let p = m.price("BTC");
        // RISK_ENGINE.md 13.3: $103,110 and $104,383.
        assert_eq!((p * (1.0 + hl50.unwrap())).round(), 103_110.0);
        assert_eq!((p * (1.0 + hl100.unwrap())).round(), 104_383.0);
        let mut budget = 100;
        let (im, mr) = coin_equity_bands(&eng, &a, &m, &req, "BTC", &mut budget);
        // Appendix A: IM at $104,195 and MR at $104,213, just below the liquidation price. The coarse search
        // reports the bisection's near end, at most 0.08% (about $80) before the exact crossing.
        let (im, mr) = (p * (1.0 + im.unwrap()), p * (1.0 + mr.unwrap()));
        assert!(im <= 104_195.0 + 1.0 && im > 104_195.0 - 90.0, "{im}");
        assert!(mr <= 104_213.0 + 1.0 && mr > 104_213.0 - 90.0, "{mr}");
        let mut budget = 100;
        let [w_im, w_mr, w_dl] = token_bands(&eng, &a, &m, &req, "nBTC", &mut budget);
        // 13.3: nBTC/BTC 0.8309, 0.7914 and 0.7574; π bands sit above the crossing (the near end).
        for (got, want) in [(w_im, 0.8309), (w_mr, 0.7914), (w_dl, 0.7574)] {
            let pi = 1.0 + got.unwrap();
            assert!(pi >= want - 0.0001 && pi < want + 0.0009, "{pi} vs {want}");
        }
    }

    #[test]
    fn the_budget_caps_the_work() {
        let (eng, a, m) = hedged(94_500.0);
        let req = eng.requirement(&a, &m);
        let mut budget = 3;
        let (im, mr) = coin_equity_bands(&eng, &a, &m, &req, "BTC", &mut budget);
        assert_eq!((im, mr, budget), (None, None, 0));
    }
}
