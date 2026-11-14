//! RISK_ENGINE.md 4.5: the list of bad days, built from the groups the account holds. Port of
//! `Engine.scenarios`, in the same order: the normal grid, ADL (the force-close days), squeeze-then-revert,
//! the extreme grid, the crash with bridge slip, one wrapper failing at a time, and the crash replays
//! (`replay.rs`). "Adverse" is against the net position; for an exact hedge, against the perp. Money in transit
//! that isn't overdue takes the same moves and depegs as the token held (4.8), so its coin and its depeg day are
//! in the list even if the account holds nothing else of it.
use crate::params::{token, Params};
use crate::py::{self, fixed2, pct0, sgn, tuple_repr};
use crate::snapshot::{Account, Market};
use crate::Engine;
use std::collections::BTreeSet;

/// Scenario family. Normal, ADL and squeeze count in full, extremes at half, replays at `replay_weight`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Normal,
    Adl,
    Reversal,
    Extreme,
    Replay,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Normal => "normal",
            Kind::Adl => "adl",
            Kind::Reversal => "reversal",
            Kind::Extreme => "extreme",
            Kind::Replay => "replay",
        }
    }
}

/// Which funding and interest a scenario charges (4.7).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Carry {
    /// Stress: the pool's rate at 100% utilisation, and each perp's worst week of funding.
    Stress,
    /// Normal: today's rate, and each coin's trailing 30-day funding.
    Normal,
}

/// One bad day. Its path is a list of stages; each stage is a list of alternatives; each alternative is the
/// move of every group from now, in the order of [`ScenarioSet::groups`].
#[derive(Clone, Debug, PartialEq)]
pub struct Scenario {
    pub name: String,
    pub kind: Kind,
    pub path: Vec<Vec<Vec<f64>>>,
    /// An adverse perp-vs-index gap on every perp.
    pub basis: bool,
    /// Which depeg every NEAR token takes: 0 normal, 1 crash, 2 extreme; none for `None`.
    pub depeg: Option<usize>,
    /// Extreme depeg scenarios hit one token at a time.
    pub depeg_only: Option<String>,
    pub carry: Carry,
    /// Hyperliquid closes this perp at the end of stage 1 (ADL).
    pub adl_coin: Option<String>,
}

impl Scenario {
    /// A scenario with the reference's defaults: the gap, the normal depeg and stress carry.
    pub fn new(name: String, kind: Kind, path: Vec<Vec<Vec<f64>>>) -> Scenario {
        Scenario {
            name,
            kind,
            path,
            basis: true,
            depeg: Some(0),
            depeg_only: None,
            carry: Carry::Stress,
            adl_coin: None,
        }
    }

    /// The same scenario without the gap or any depeg, at normal carry (the extreme grid).
    fn extreme(name: String, path: Vec<Vec<Vec<f64>>>, depeg: Option<usize>) -> Scenario {
        Scenario {
            basis: false,
            depeg,
            carry: Carry::Normal,
            ..Scenario::new(name, Kind::Extreme, path)
        }
    }
}

/// The scenarios for one account, and the groups their moves refer to (sorted by name, as in the reference).
#[derive(Clone, Debug, PartialEq)]
pub struct ScenarioSet {
    pub groups: Vec<String>,
    pub list: Vec<Scenario>,
}

/// `alt.get(g, 0.0)`: the move of group `g` in one alternative.
pub fn move_of(groups: &[String], alt: &[f64], g: &str) -> f64 {
    groups.iter().position(|h| h == g).map_or(0.0, |i| alt[i])
}

/// `itertools.product((-1, 1), repeat=n)`, in its order (the last sign changes fastest).
fn sign_products(n: usize) -> Vec<Vec<i32>> {
    (0..1usize << n)
        .map(|i| {
            (0..n)
                .map(|j| if i >> (n - 1 - j) & 1 == 1 { 1 } else { -1 })
                .collect()
        })
        .collect()
}

/// Every group down, every group up, then the conflict groups' sign combinations with everything else
/// adverse, each once, at k × S*. Returns (signs, moves) pairs.
fn combos(
    p: &Params,
    k: f64,
    s: &[f64],
    adverse: &[i32],
    conflict: &[usize],
) -> Vec<(Vec<i32>, Vec<f64>)> {
    let n = s.len();
    let cap = -p.extreme_down_cap;
    let mut vecs = vec![vec![-1; n], vec![1; n]];
    for signs in sign_products(conflict.len()) {
        let mut v = adverse.to_vec();
        for (&i, &sg) in conflict.iter().zip(&signs) {
            v[i] = sg;
        }
        vecs.push(v);
    }
    let mut seen: Vec<Vec<i32>> = Vec::new();
    let mut out = Vec::new();
    for v in vecs {
        if seen.contains(&v) {
            continue;
        }
        seen.push(v.clone());
        let mv = (0..n)
            .map(|i| py::max(f64::from(v[i]) * k * s[i], cap))
            .collect();
        out.push((v, mv));
    }
    out
}

impl Engine {
    /// 4.8: the NEAR tokens the stress test values: those held, then those in transit and not overdue.
    pub fn stress_tokens(&self, a: &Account) -> Vec<String> {
        let mut toks: Vec<String> = a
            .near
            .iter()
            .filter(|(_, &u)| u != 0.0)
            .map(|(t, _)| t.to_string())
            .collect();
        for f in &a.inflight {
            if f.units != 0.0 && !f.overdue && !toks.contains(&f.token) {
                toks.push(f.token.clone());
            }
        }
        toks
    }

    /// 4.5: every scenario for this account.
    pub fn scenarios(&self, a: &Account, m: &Market) -> ScenarioSet {
        let p = &self.params;
        // Money in transit moves with its coin too (4.8).
        let mut gs: BTreeSet<String> = self.groups(a).into_iter().collect();
        gs.extend(
            self.stress_tokens(a)
                .iter()
                .filter_map(|t| token(t).group)
                .map(str::to_string),
        );
        let gs: Vec<String> = gs.into_iter().collect();
        let n = gs.len();
        let s: Vec<f64> = gs.iter().map(|g| self.shock(a, m, g).s_star).collect();
        let perp = |g: &str| a.perps.get_or(g, 0.0);
        let conflict: Vec<usize> = (0..n)
            .filter(|&i| {
                perp(&gs[i]) != 0.0
                    && a.near
                        .iter()
                        .any(|(t, &u)| u != 0.0 && token(t).group == Some(gs[i].as_str()))
            })
            .collect();
        let adverse: Vec<i32> = gs
            .iter()
            .map(|g| {
                let net = self.net_units(a, m, g, None);
                let gross = perp(g).abs()
                    + py::sum(
                        a.near
                            .iter()
                            .filter(|(t, _)| token(t).group == Some(g.as_str()))
                            .map(|(_, u)| u.abs()),
                    );
                if net.abs() > 1e-9 * gross {
                    -sgn(net) // against the net position
                } else {
                    match -sgn(perp(g)) {
                        0 => -1,
                        s => s, // exact hedge: against the perp (it hurts Hyperliquid)
                    }
                }
            })
            .collect();
        let cap = -p.extreme_down_cap; // a price can't fall more than 90% in any invented scenario
        let mut out = Vec::new();

        for &k in &p.k_normal {
            for (key, mv) in combos(p, k, &s, &adverse, &conflict) {
                out.push(Scenario::new(
                    format!("{}S {}", fixed2(k), tuple_repr(&key)),
                    Kind::Normal,
                    vec![vec![mv]],
                ));
            }
        }
        // ADL closes the winning side: a short in a fall, a long in a rise. The rest moves on, compounding.
        for g in &gs {
            let q = perp(g);
            if q == 0.0 {
                continue;
            }
            let sg = f64::from(sgn(q));
            for &(k1, k2) in &p.adl_pairs {
                let x1: Vec<f64> = (0..n).map(|h| py::max(sg * k1 * s[h], cap)).collect();
                let x2 = (0..n)
                    .map(|h| {
                        py::max(
                            (1.0 + x1[h]) * (1.0 + py::max(sg * k2 * s[h], cap)) - 1.0,
                            cap,
                        )
                    })
                    .collect();
                let name = format!("ADL {g} {}S then {}S", fixed2(k1), fixed2(k2));
                out.push(Scenario {
                    adl_coin: Some(g.clone()),
                    ..Scenario::new(name, Kind::Adl, vec![vec![x1], vec![x2]])
                });
            }
        }
        // Squeeze the perp into liquidation, then the price reverses (JELLY, POPCAT, 13 Mar 2020).
        for g in &gs {
            let q = perp(g);
            if q == 0.0 {
                continue;
            }
            let sg = -sgn(q);
            for &(k1, k2) in &p.reversal_pairs {
                let x1: Vec<f64> = (0..n)
                    .map(|h| py::max(f64::from(sg) * k1 * s[h], cap))
                    .collect();
                let x2 = (0..n)
                    .map(|h| {
                        py::max(
                            (1.0 + x1[h]) * (1.0 + py::max(f64::from(-sg) * k2 * s[h], cap)) - 1.0,
                            cap,
                        )
                    })
                    .collect();
                let name = format!("squeeze {g} {}S then back {}S", fixed2(k1), fixed2(k2));
                out.push(Scenario::new(
                    name,
                    Kind::Reversal,
                    vec![vec![x1], vec![x2]],
                ));
            }
        }
        for (key, mv) in combos(p, p.k_extreme, &s, &adverse, &conflict) {
            out.push(Scenario::extreme(
                format!("2S {}", tuple_repr(&key)),
                vec![vec![mv]],
                None,
            ));
        }
        let crash = (0..n).map(|i| py::max(-p.k_extreme * s[i], cap)).collect();
        out.push(Scenario::extreme(
            "2S all down + bridge slip".to_string(),
            vec![vec![crash]],
            Some(1),
        ));
        for t in self.stress_tokens(a) {
            if token(&t).depeg[2] > 0.0 {
                let name = format!("{t} depeg {}", pct0(token(&t).depeg[2]));
                let sc = Scenario::extreme(name, vec![vec![vec![0.0; n]]], Some(2));
                out.push(Scenario {
                    depeg_only: Some(t),
                    ..sc
                });
            }
        }
        out.extend(self.replay_scenarios(&gs));
        ScenarioSet {
            groups: gs,
            list: out,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_products_follow_itertools() {
        assert_eq!(sign_products(0), vec![Vec::<i32>::new()]);
        assert_eq!(
            sign_products(2),
            vec![vec![-1, -1], vec![-1, 1], vec![1, -1], vec![1, 1]]
        );
    }
}
