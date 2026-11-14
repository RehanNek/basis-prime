//! RISK_ENGINE.md 4.3, 4.7 and 4.8: play each bad day out and take the worst. Inside a scenario no money moves
//! between venues. Hyperliquid checks its margin at every point of the path: below maintenance it liquidates
//! (book liquidation keeps what slippage leaves; below 2/3 of maintenance the backstop keeps everything), and
//! ADL closes the winning perp after stage 1. At every point the engine then sells everything, pays a week of
//! interest and funding, and records the equity left. Money in transit moves like the token held, at 98%.
//! Ports `Engine.run`, `scenario_value`, `requirement` and `top_risks`.
use crate::costs::cost_1c;
use crate::ordered::OrderedMap;
use crate::params::token;
use crate::py::{self, sgn};
use crate::scenarios::{move_of, Carry, Kind, Scenario};
use crate::snapshot::{Account, Market};
use crate::valuation::token_value;
use crate::Engine;
use std::cmp::Ordering;

/// How Hyperliquid liquidated, in a scenario.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiqKind {
    /// At or above 2/3 of maintenance: all perps closed into the book.
    Book,
    /// Below 2/3 of maintenance: the liquidator vault keeps everything.
    Backstop,
}

impl LiqKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LiqKind::Book => "book",
            LiqKind::Backstop => "backstop",
        }
    }
}

/// A liquidation: Hyperliquid equity and maintenance margin at the trigger, and the slippage paid (book) or
/// the equity lost (backstop).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Liquidation {
    pub kind: LiqKind,
    pub eq: f64,
    pub mmv: f64,
    pub amount: f64,
}

/// The parts of a scenario's worst point.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Detail {
    pub near: f64,
    pub near_cost: f64,
    /// Φ(x): money in transit, at 98% and the scenario's prices.
    pub inflight: f64,
    pub hl_eq: f64,
    pub hl_cost: f64,
    pub interest: f64,
    pub funding: f64,
    /// The liquidation, if one had happened by the worst point.
    pub liq: Option<Liquidation>,
    pub stage: usize,
}

/// One scenario's result.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub name: String,
    pub kind: Kind,
    /// L = E − E(x), at the worst point of the path.
    pub loss: f64,
    /// The yearly rate the scenario charged on the loan.
    pub rate: f64,
    /// E(x) at the worst point: what would be left after selling everything.
    pub e_after: f64,
    pub det: Option<Detail>,
}

/// 4.8: the requirement and what set it.
#[derive(Clone, Debug, PartialEq)]
pub struct Requirement {
    /// E, mark equity now.
    pub e: f64,
    /// MR, the maintenance requirement (the safety buffer).
    pub mr: f64,
    /// IM = 1.25 × MR.
    pub im: f64,
    /// The worst loss among the normal, ADL and squeeze days.
    pub normal: f64,
    /// The worst extreme loss, before its weight of ½.
    pub extreme: f64,
    /// The worst replay loss.
    pub replay: f64,
    /// Every scenario, in the order they were built.
    pub rows: Vec<Row>,
}

impl Requirement {
    /// Only the three numbers the state needs (E, MR and IM).
    pub fn levels(e: f64, mr: f64, im: f64) -> Requirement {
        Requirement {
            e,
            mr,
            im,
            normal: 0.0,
            extreme: 0.0,
            replay: 0.0,
            rows: Vec::new(),
        }
    }
}

/// V_j(x) (4.8): a token's value at one point of a scenario, after its coin's move and the family's depeg.
pub fn scenario_value(
    sc: &Scenario,
    groups: &[String],
    alt: &[f64],
    tok: &str,
    units: f64,
    m: &Market,
) -> f64 {
    let t = token(tok);
    let mut d = 0.0;
    if let Some(level) = sc.depeg {
        if sc.depeg_only.as_deref().is_none_or(|only| only == tok) {
            d = t.depeg[level];
        }
    }
    let mv = t.group.map_or(0.0, |g| move_of(groups, alt, g));
    token_value(tok, units, m, mv, d)
}

impl Engine {
    /// A perp's mark in one alternative: the move, then the adverse gap if the family has one.
    fn marks(
        &self,
        m: &Market,
        perps: &OrderedMap<f64>,
        groups: &[String],
        alt: &[f64],
        basis: bool,
    ) -> Vec<f64> {
        perps
            .iter()
            .map(|(c, &q)| {
                let b = if basis {
                    f64::from(-sgn(q)) * self.coin(c).params.basis
                } else {
                    0.0
                };
                m.mark_price(c) * (1.0 + move_of(groups, alt, c)) * (1.0 + b)
            })
            .collect()
    }

    /// Plays scenario `sc` out (its moves refer to `groups`). Returns the worst equity left over the path,
    /// the rate charged, and the parts of that worst point.
    pub fn run(
        &self,
        a: &Account,
        m: &Market,
        sc: &Scenario,
        groups: &[String],
        extra_debt: f64,
    ) -> (f64, f64, Option<Detail>) {
        let p = &self.params;
        let spread = a.tier.spec().spread;
        let rate_n = p.base_rate(m.util) + spread;
        let rate_s = p.base_rate(1.0) + spread;
        let rate = if sc.carry == Carry::Stress {
            rate_s
        } else {
            rate_n
        };
        let debt = a.debt + extra_debt;
        let mut perps: OrderedMap<f64> = a
            .perps
            .iter()
            .filter(|(_, &q)| q != 0.0)
            .map(|(c, &q)| (c, q))
            .collect();
        let mut hl_base = self.hl_equity_now(a, m); // equity with entries reset to today's marks
        let horizon = p.tau();
        let mut liquidated: Option<Liquidation> = None;
        let mut worst = f64::INFINITY;
        let mut worst_detail = None;
        for (si, stage) in sc.path.iter().enumerate() {
            if let Some(g) = sc.adl_coin.as_deref() {
                if si == 1 && perps.contains_key(g) {
                    // Closed at the stage-1 mark, gap included (4.3).
                    let q = perps[g];
                    let b = if sc.basis {
                        f64::from(-sgn(q)) * self.coin(g).params.basis
                    } else {
                        0.0
                    };
                    let m1 =
                        m.mark_price(g) * (1.0 + move_of(groups, &sc.path[0][0], g)) * (1.0 + b);
                    hl_base += q * (m1 - m.mark_price(g));
                    perps.remove(g);
                }
            }
            if !perps.is_empty() && liquidated.is_none() {
                // Hyperliquid checks continuously: any alternative of the stage can trigger it.
                for alt in stage {
                    let mk = self.marks(m, &perps, groups, alt, sc.basis);
                    let eq = hl_base
                        + py::sum(
                            perps
                                .iter()
                                .zip(&mk)
                                .map(|((c, &q), &x)| q * (x - m.mark_price(c))),
                        );
                    let mmv = py::sum(
                        perps
                            .iter()
                            .zip(&mk)
                            .map(|((c, &q), &x)| self.mm(c, q.abs() * x)),
                    );
                    if eq < mmv {
                        let notional: Vec<f64> = perps
                            .values()
                            .zip(&mk)
                            .map(|(&q, &x)| q.abs() * x)
                            .collect();
                        let post;
                        if eq >= p.backstop_frac * mmv {
                            let slip = py::sum(perps.keys().zip(&notional).map(|(c, &n)| {
                                py::max(
                                    p.liq_slip_floor,
                                    2.0 * self.cost_hl(c, n, self.vol_factor(m, c)),
                                ) * n
                            }));
                            post = py::max(eq - slip, 0.0);
                            liquidated = Some(Liquidation {
                                kind: LiqKind::Book,
                                eq,
                                mmv,
                                amount: slip,
                            });
                        } else {
                            post = 0.0;
                            liquidated = Some(Liquidation {
                                kind: LiqKind::Backstop,
                                eq,
                                mmv,
                                amount: py::max(eq, 0.0),
                            });
                        }
                        hl_base = post;
                        perps = OrderedMap::new();
                        break;
                    }
                }
            }
            for alt in stage {
                let mk = self.marks(m, &perps, groups, alt, sc.basis);
                let hl_eq = hl_base
                    + py::sum(
                        perps
                            .iter()
                            .zip(&mk)
                            .map(|((c, &q), &x)| q * (x - m.mark_price(c))),
                    );
                let (mut near_val, mut near_cost) = (0.0, 0.0);
                for (t, &u) in a.near.iter() {
                    if u == 0.0 {
                        continue;
                    }
                    let v = scenario_value(sc, groups, alt, t, u, m);
                    let f = token(t).group.map_or(1.0, |g| self.vol_factor(m, g));
                    near_val += v;
                    near_cost += cost_1c(t, v, f) * v;
                }
                // Money in transit moves like the same token held, at 98%, and counts nothing once overdue.
                let infl = py::sum(a.inflight.iter().filter(|f| !f.overdue).map(|f| {
                    p.inflight_state_value * scenario_value(sc, groups, alt, &f.token, f.units, m)
                }));
                let hl_cost = py::sum(perps.iter().zip(&mk).map(|((c, &q), &x)| {
                    self.cost_hl(c, q.abs() * x, self.vol_factor(m, c)) * q.abs() * x
                }));
                let mut funding = 0.0;
                for ((c, &q), &x) in perps.iter().zip(&mk) {
                    let f = match sc.carry {
                        Carry::Stress if q > 0.0 => self.coin(c).params.funding_stress_long_apr,
                        Carry::Stress => self.coin(c).params.funding_stress_short_apr,
                        Carry::Normal => m.funding_of(c),
                    };
                    funding += q * x * f * horizon;
                }
                let interest = debt * rate * horizon;
                let eq = near_val - near_cost + hl_eq - hl_cost + infl - debt - interest - funding;
                if eq < worst {
                    worst = eq;
                    worst_detail = Some(Detail {
                        near: near_val,
                        near_cost,
                        inflight: infl,
                        hl_eq,
                        hl_cost,
                        interest,
                        funding,
                        liq: liquidated,
                        stage: si,
                    });
                }
            }
        }
        (worst, rate, worst_detail)
    }

    /// 4.8: MR = max(worst normal/ADL/squeeze loss, ½ × worst extreme, worst replay, 0); IM = 1.25 × MR.
    pub fn requirement(&self, a: &Account, m: &Market) -> Requirement {
        let p = &self.params;
        let e_now = self.equity_mark(a, m);
        let set = self.scenarios(a, m);
        let rows: Vec<Row> = set
            .list
            .iter()
            .map(|sc| {
                let (e_after, rate, det) = self.run(a, m, sc, &set.groups, 0.0);
                Row {
                    name: sc.name.clone(),
                    kind: sc.kind,
                    loss: e_now - e_after,
                    rate,
                    e_after,
                    det,
                }
            })
            .collect();
        let worst = |kinds: &[Kind]| {
            py::max_all(
                rows.iter()
                    .filter(|r| kinds.contains(&r.kind))
                    .map(|r| r.loss)
                    .chain([0.0]),
            )
        };
        let normal = worst(&[Kind::Normal, Kind::Adl, Kind::Reversal]);
        let replay = worst(&[Kind::Replay]);
        let extreme = worst(&[Kind::Extreme]);
        let mr = py::max_all([
            normal,
            p.ext_weight * extreme,
            p.replay_weight * replay,
            0.0,
        ]);
        Requirement {
            e: e_now,
            mr,
            im: p.im_mult * mr,
            normal,
            extreme,
            replay,
            rows,
        }
    }

    /// The weight of a scenario family in MR.
    pub fn weight(&self, kind: Kind) -> f64 {
        match kind {
            Kind::Extreme => self.params.ext_weight,
            Kind::Replay => self.params.replay_weight,
            _ => 1.0,
        }
    }

    /// The rows by weighted loss, largest first; equal losses keep their order (Python's sort is stable).
    pub fn ranked<'a>(&self, req: &'a Requirement) -> Vec<&'a Row> {
        let key = |r: &Row| -self.weight(r.kind) * r.loss;
        let mut rows: Vec<&Row> = req.rows.iter().collect();
        rows.sort_by(|x, y| key(x).partial_cmp(&key(y)).unwrap_or(Ordering::Equal));
        rows
    }

    /// The `n` biggest risks, in words, with their weighted losses (the verdict's `top`).
    pub fn top_risks(&self, req: &Requirement, n: usize) -> Vec<(String, f64)> {
        self.ranked(req)
            .into_iter()
            .take(n)
            .map(|r| (r.name.clone(), self.weight(r.kind) * r.loss))
            .collect()
    }
}
