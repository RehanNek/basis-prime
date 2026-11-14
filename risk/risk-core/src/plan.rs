//! RISK_ENGINE.md 8.2 and 8.4: the top-up the verdict suggests, the deleveraging plan and the rebalance plan.
//! Ports `topup` and `deleverage_plan`. The rebalance plan is new: the reference has none.
//!
//! A plan is a list of [`Step`]s, each sized by the engine. [`Step::text`] writes a step in the reference's words,
//! so [`Engine::deleverage_plan`] still prints exactly what the reference prints. pb-risk turns the steps into the
//! verdict's step objects (INTERFACES.md 13).
use crate::costs::cost_1c;
use crate::params::token;
use crate::py::{self, sgn, usd};
use crate::snapshot::{Account, Market};
use crate::valuation::token_value;
use crate::Engine;
use std::collections::{BTreeMap, BTreeSet};

/// 1Click's flat fee on a transfer between NEAR and Hyperliquid (research/hyperliquid.md 11), in USDC.
pub const ONE_CLICK_FEE: f64 = 0.2;
/// A rebalance moves at least this much USDC (smaller amounts are mostly the fee).
pub const MIN_MOVE_USD: f64 = 1.0;
/// Less than a cent still missing on Hyperliquid is rounding, not a need.
const NEED_EPS_USD: f64 = 0.01;

/// The routes a plan may use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Routes {
    /// 1Click: selling NEAR tokens, moving USDC to Hyperliquid and bringing it home. Without it a plan uses only
    /// repayments and Hyperliquid orders.
    pub one_click: bool,
}

impl Routes {
    /// Every route, as the reference plans.
    pub const ALL: Routes = Routes { one_click: true };
    /// No 1Click: on testnet, pb-risk can't reach a 1Click quote from inside OutLayer.
    pub const NO_ONE_CLICK: Routes = Routes { one_click: false };
}

/// The kinds of trade 8.4 chooses from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TradeKind {
    /// Both legs of a hedged pair: buy back part of the short and sell the same amount of the NEAR token.
    Pair,
    /// Part of a perp: the unhedged excess of a partly hedged group, or an unhedged perp.
    Perp,
    /// Part of a NEAR token, through 1Click.
    Near,
}

impl TradeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TradeKind::Pair => "pair",
            TradeKind::Perp => "perp",
            TradeKind::Near => "near",
        }
    }
}

/// One trade: what changes, and what the engine saw.
#[derive(Clone, Debug, PartialEq)]
pub struct Trade {
    pub kind: TradeKind,
    /// The coin (group) traded.
    pub group: String,
    /// The perp's change in Hyperliquid units: positive buys. 0 for a NEAR-only sale.
    pub dq: f64,
    /// The NEAR token sold, and how many units (pair and near trades).
    pub token: Option<String>,
    pub units: f64,
    /// Dollars traded and what trading them costs.
    pub traded: f64,
    pub cost: f64,
    /// MR before and after the step (deleverage trades; rebalance trades are sized on the margin ratio instead).
    pub mr: Option<(f64, f64)>,
}

/// One step of a plan.
#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    /// Repay the loan from USDC in the NEAR account.
    Repay {
        usd: f64,
    },
    /// No perps left: bring Hyperliquid's cash home through 1Click.
    Home {
        usd: f64,
    },
    /// Move USDC from the NEAR account to Hyperliquid margin, through 1Click (8.2).
    ToHl {
        usd: f64,
    },
    /// Sell a NEAR token that wraps no coin (USDT) for USDC, through 1Click (8.2). `usd` is what it should pay.
    Swap {
        token: String,
        units: f64,
        usd: f64,
    },
    Trade(Trade),
}

impl Step {
    /// The step in words: the reference's words for its kinds of step.
    pub fn text(&self) -> String {
        match self {
            Step::Repay { usd: x } => format!("repay {} from USDC in the NEAR account", usd(*x)),
            Step::Home { usd: x } => format!(
                "no perps left: bring {} home from Hyperliquid (1Click, 0.2 USDC fee)",
                usd(*x)
            ),
            Step::ToHl { usd: x } => format!(
                "move {} of USDC to Hyperliquid (1Click, 0.2 USDC fee)",
                usd(*x)
            ),
            Step::Swap { token, usd: x, .. } => {
                format!("sell {token} for {} of USDC (1Click)", usd(*x))
            }
            Step::Trade(t) => {
                let head = format!(
                    "{} {}: trade {}, cost {}",
                    t.kind.as_str(),
                    t.group,
                    usd(t.traded),
                    usd(t.cost)
                );
                match t.mr {
                    Some((before, after)) => {
                        format!("{head}, MR {} -> {}", usd(before), usd(after))
                    }
                    None => head,
                }
            }
        }
    }

    /// Whether the step needs 1Click.
    pub fn needs_one_click(&self) -> bool {
        match self {
            Step::Repay { .. } => false,
            Step::Home { .. } | Step::ToHl { .. } | Step::Swap { .. } => true,
            Step::Trade(t) => t.kind != TradeKind::Perp,
        }
    }
}

/// Why a plan stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanEnd {
    /// The goal is met: E ≥ 1.02 × IM (deleverage), or the margin-ratio targets (rebalance).
    Done,
    /// The step limit was reached: the next verdict plans the rest from the new state (Appendix A).
    MaxSteps,
    /// Nothing is left that a step could sell, close or move.
    NothingLeft,
    /// What is left needs 1Click, which the routes leave out.
    NeedsOneClick,
}

/// A plan: its steps, the account as the engine expects it after them, and why it stopped.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub steps: Vec<Step>,
    pub after: Account,
    pub end: PlanEnd,
    /// For a rebalance: USDC still to add to Hyperliquid once the steps have run, and whose sale proceeds a later
    /// plan moves; 0 for a deleverage plan.
    pub short_usd: f64,
}

/// RISK_ENGINE.md 8.4 step 1 and 9: the account's resting orders that add risk, by index into `a.orders`. A
/// reduce-only order never adds risk: Hyperliquid fills it only against the position. Any other order adds risk
/// unless it is on the other side of a position and, with every other such order on that coin, can't close more
/// than the position (if they could, all of them count, since together they could flip it).
pub fn risky_orders(a: &Account) -> Vec<usize> {
    let mut against: BTreeMap<&str, f64> = BTreeMap::new();
    for o in a.orders.iter().filter(|o| !o.reduce_only) {
        let q = a.perps.get_or(&o.coin, 0.0);
        if q != 0.0 && sgn(o.size) == -sgn(q) {
            *against.entry(o.coin.as_str()).or_insert(0.0) += o.size.abs();
        }
    }
    a.orders
        .iter()
        .enumerate()
        .filter(|(_, o)| !o.reduce_only && o.size != 0.0)
        .filter(|(_, o)| {
            let q = a.perps.get_or(&o.coin, 0.0);
            let closes = q != 0.0 && sgn(o.size) == -sgn(q);
            !closes || against.get(o.coin.as_str()).copied().unwrap_or(0.0) > q.abs() + 1e-12
        })
        .map(|(i, _)| i)
        .collect()
}

impl Engine {
    /// 8.2 and Appendix A: the smallest Hyperliquid top-up (whole dollars, rounded up) after which none of the
    /// liquidations among today's top three risks happens; 0 if there is none, infinite if no top-up below
    /// $1T does it. More margin can raise MR (13.1), so the search follows those scenarios, not MR.
    pub fn topup(&self, a: &Account, m: &Market) -> f64 {
        let req = self.requirement(a, m);
        let names: BTreeSet<&str> = self
            .ranked(&req)
            .into_iter()
            .take(3)
            .filter(|r| r.det.is_some_and(|d| d.liq.is_some()))
            .map(|r| r.name.as_str())
            .collect();
        if names.is_empty() {
            return 0.0;
        }
        let still = |extra: f64| {
            let b = Account {
                hl_cash: a.hl_cash + extra,
                ..a.clone()
            };
            let r2 = self.requirement(&b, m);
            r2.rows
                .iter()
                .any(|r| names.contains(r.name.as_str()) && r.det.is_some_and(|d| d.liq.is_some()))
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

    /// 8.4: a greedy unwind back to 1.02 × IM, re-running the engine after each step. Returns the steps, in the
    /// reference's words, and the account after them. The reference allows 40 steps; a verdict carries at most 4.
    pub fn deleverage_plan(
        &self,
        a: &Account,
        m: &Market,
        max_steps: usize,
    ) -> (Vec<String>, Account) {
        let plan = self.deleverage_steps(a, m, max_steps, Routes::ALL);
        (plan.steps.iter().map(Step::text).collect(), plan.after)
    }

    /// 8.4: the deleveraging plan, step by step. With every route this is the reference's `deleverage_plan`,
    /// operation for operation. Without 1Click it considers only repayments and perp trades: a pair or a NEAR sale
    /// is never planned, and bringing Hyperliquid's cash home is left for a run that can reach 1Click.
    pub fn deleverage_steps(
        &self,
        a: &Account,
        m: &Market,
        max_steps: usize,
        routes: Routes,
    ) -> Plan {
        let p = &self.params;
        let mut a = a.clone();
        let mut steps = Vec::new();
        let mut end = PlanEnd::MaxSteps;
        for _ in 0..max_steps {
            // Step 2: repay from USDC in the NEAR account.
            let usdc = a.near.get_or("USDC", 0.0);
            if usdc > 0.01 && a.debt > 0.01 {
                let x = py::min(usdc, a.debt);
                a.near.insert("USDC", usdc - x);
                a.debt -= x;
                steps.push(Step::Repay { usd: x });
                continue;
            }
            // No perps left: bring the cash home (1Click's flat 0.2 USDC fee).
            let any_perps = a.perps.values().any(|&q| q != 0.0);
            let cash_on_hl = !any_perps && self.hl_equity_now(&a, m) > 1.0 && a.debt > 0.01;
            if cash_on_hl && routes.one_click {
                let x = self.hl_equity_now(&a, m);
                let usdc = a.near.get_or("USDC", 0.0);
                a.near.insert("USDC", usdc + x - ONE_CLICK_FEE);
                a.hl_cash = 0.0;
                a.perps = Default::default();
                steps.push(Step::Home { usd: x });
                continue;
            }
            let req = self.requirement(&a, m);
            let other_tokens = a.near.iter().any(|(t, &u)| t != "USDC" && u != 0.0);
            if req.e >= req.im * (1.0 + p.hysteresis) {
                end = PlanEnd::Done;
                break;
            }
            if !any_perps && !other_tokens {
                end = if cash_on_hl {
                    PlanEnd::NeedsOneClick
                } else {
                    PlanEnd::NothingLeft
                };
                break;
            }
            // Step 4: the candidates, each at most 25% of a position and an hour of the venue's capacity.
            let mut best: Option<(f64, Account, Trade)> = None;
            let mut left_out = false;
            for g in self.groups(&a) {
                let q = a.perps.get_or(&g, 0.0);
                let toks: Vec<String> = a
                    .near
                    .iter()
                    .filter(|(t, &u)| u != 0.0 && token(t).group == Some(g.as_str()))
                    .map(|(t, _)| t.to_string())
                    .collect();
                let hedged = q < 0.0 && !toks.is_empty();
                let f = self.vol_factor(m, &g);
                for kind in [TradeKind::Pair, TradeKind::Perp, TradeKind::Near] {
                    if kind == TradeKind::Pair && !hedged {
                        continue;
                    }
                    let near_units = py::sum(
                        a.near
                            .iter()
                            .filter(|(t, _)| toks.iter().any(|x| x == t))
                            .map(|(t, &u)| u * m.wrap_ratio(t)),
                    );
                    // In a partly hedged group, the unhedged excess goes first.
                    let excess = if hedged {
                        q.abs() - near_units
                    } else {
                        q.abs()
                    };
                    if kind == TradeKind::Perp && (q == 0.0 || excess <= 1e-12) {
                        continue;
                    }
                    let near_excess = if hedged {
                        near_units - q.abs()
                    } else {
                        near_units
                    };
                    if kind == TradeKind::Near && (toks.is_empty() || near_excess <= 1e-12) {
                        continue;
                    }
                    if kind != TradeKind::Perp && !routes.one_click {
                        left_out = true;
                        continue;
                    }
                    let mut b = a.clone();
                    let (mut traded, mut cost) = (0.0, 0.0);
                    let hour_hl =
                        p.participation * p.stressed_volume * self.coin(&g).adv30_usd / 24.0;
                    // The step's size: dq on the perp, `units` of the token.
                    let (mut dq, mut units) = (0.0, 0.0);
                    if kind == TradeKind::Pair {
                        // Both legs together, sized once, in coin units: 25% of the hedged position, at most an
                        // hour of Hyperliquid's volume and an hour of 1Click's capacity. The token sold matches
                        // the perp bought back, so the hedge is kept.
                        let t = toks[0].as_str();
                        let w = m.wrap_ratio(t);
                        let x = py::min3(
                            py::min(q.abs(), b.near[t] * w) * 0.25,
                            hour_hl / m.mark_price(&g),
                            token(t).cap_h / m.price(&g),
                        );
                        dq = f64::from(-sgn(q)) * x;
                        units = x / w;
                    } else if kind == TradeKind::Perp {
                        dq = f64::from(-sgn(q)) * py::min(q.abs() * 0.25, excess);
                        dq = f64::from(sgn(dq)) * py::min(dq.abs(), hour_hl / m.mark_price(&g));
                    } else {
                        let t = toks[0].as_str();
                        units = py::min(b.near[t] * 0.25, near_excess / m.wrap_ratio(t));
                        units = py::min3(
                            units,
                            token(t).cap_h / (m.price(&g) * m.wrap_ratio(t)),
                            b.near[t],
                        );
                    }
                    if kind != TradeKind::Near {
                        let mark = m.mark_price(&g);
                        let n = dq.abs() * mark;
                        let c = self.cost_hl(&g, n, f) * n;
                        b.hl_cash += q * (mark - b.entry.get_or(&g, mark)) - c;
                        b.entry.insert(&g, mark);
                        b.perps.insert(&g, q + dq);
                        traded += n;
                        cost += c;
                    }
                    if kind != TradeKind::Perp {
                        let t = toks[0].as_str();
                        let v = token_value(t, units, m, 0.0, 0.0);
                        let c = cost_1c(t, v, f) * v;
                        let left = b.near[t] - units;
                        b.near.insert(t, left);
                        let usdc = b.near.get_or("USDC", 0.0);
                        b.near.insert("USDC", usdc + v - c);
                        traded += v;
                        cost += c;
                    }
                    // The most risk removed for the least market impact: (1.25 × fall in MR − cost) per dollar.
                    let r2 = self.requirement(&b, m);
                    let score = (p.im_mult * (req.mr - r2.mr) - cost) / py::max(traded, 1e-9);
                    if best.as_ref().is_none_or(|(s, _, _)| score > *s) {
                        let trade = Trade {
                            kind,
                            group: g.clone(),
                            dq,
                            token: (kind != TradeKind::Perp).then(|| toks[0].clone()),
                            units,
                            traded,
                            cost,
                            mr: Some((req.mr, r2.mr)),
                        };
                        best = Some((score, b, trade));
                    }
                }
            }
            match best {
                Some((_, b, trade)) => {
                    a = b;
                    steps.push(Step::Trade(trade));
                }
                None => {
                    end = if left_out {
                        PlanEnd::NeedsOneClick
                    } else {
                        PlanEnd::NothingLeft
                    };
                    break;
                }
            }
        }
        Plan {
            steps,
            after: a,
            end,
            short_usd: 0.0,
        }
    }

    /// USDC on its way to the account's Hyperliquid address, counted as the state counts money in flight (3.4,
    /// T20): 98% until its deadline, nothing once overdue. A sale or a transfer home lands on NEAR, so it doesn't
    /// count.
    pub fn inflight_to_hl(&self, a: &Account, m: &Market) -> f64 {
        py::sum(
            a.inflight
                .iter()
                .filter(|f| f.to_hl && !f.overdue)
                .map(|f| {
                    self.params.inflight_state_value * token_value(&f.token, f.units, m, 0.0, 0.0)
                }),
        )
    }

    /// 8.2: how much USDC Hyperliquid needs so that neither rebalance trigger fires: the margin ratio back at the
    /// 30% target, and the ratio after every perp moves ½·S* against itself at most 1 / 1.02 (under 100% by the 2%
    /// hysteresis the states use). 0 with no perp, or when both already hold.
    ///
    /// Money already on its way to Hyperliquid ([`Engine::inflight_to_hl`]) is taken off, never below 0: while a
    /// top-up is in transit, a check asks only for what it doesn't cover. Once the transfer is overdue it counts as
    /// nothing, so the next check after its deadline sends again. The triggers themselves (`state`) don't change.
    pub fn rebalance_need(&self, a: &Account, m: &Market) -> f64 {
        let p = &self.params;
        let perps: Vec<(&str, f64)> = a
            .perps
            .iter()
            .filter(|(_, &q)| q != 0.0)
            .map(|(c, &q)| (c, q))
            .collect();
        if perps.is_empty() {
            return 0.0;
        }
        let eq = self.hl_equity_now(a, m);
        let mmv = py::sum(
            perps
                .iter()
                .map(|&(c, q)| self.mm(c, q.abs() * m.mark_price(c))),
        );
        let now = mmv / p.hl_ratio_target - eq;
        let (mut eq_p, mut mm_p) = (eq, 0.0);
        for &(c, q) in &perps {
            let x = f64::from(-sgn(q)) * 0.5 * self.shock(a, m, c).s_star;
            let mk = m.mark_price(c) * (1.0 + x);
            eq_p += q * (mk - m.mark_price(c));
            mm_p += self.mm(c, q.abs() * mk);
        }
        let projected = mm_p * (1.0 + p.hysteresis) - eq_p;
        // With nothing in flight this subtracts 0.0, so the result is the same, bit for bit.
        py::max(
            0.0,
            py::max3(0.0, now, projected) - self.inflight_to_hl(a, m),
        )
    }

    /// 8.2: the rebalance plan. It only adds margin to Hyperliquid, never takes it away, and uses in order:
    /// 1. USDC in the NEAR account, moved at once;
    /// 2. USDT, sold for USDC;
    /// 3. hedged pairs, both legs together, each at most 25% of the hedged position and an hour of either venue's
    ///    capacity, as 8.4 sizes a pair.
    ///
    /// Proceeds of a sale land in the NEAR account; the next verdict's plan moves them, since a step can only spend
    /// what is there when it runs. A pair also cuts Hyperliquid's maintenance margin at once. Every step needs
    /// 1Click, except the perp leg of a pair, which never goes without its sale, so without 1Click the plan is
    /// empty.
    pub fn rebalance_steps(
        &self,
        a: &Account,
        m: &Market,
        max_steps: usize,
        routes: Routes,
    ) -> Plan {
        let p = &self.params;
        let mut a = a.clone();
        let mut steps = Vec::new();
        let need = self.rebalance_need(&a, m);
        let plan = |steps, after, end, short_usd| Plan {
            steps,
            after,
            end,
            short_usd,
        };
        if need <= NEED_EPS_USD {
            return plan(steps, a, PlanEnd::Done, 0.0);
        }
        if !routes.one_click {
            return plan(steps, a, PlanEnd::NeedsOneClick, need);
        }
        // Proceeds of sales in this plan, which a later plan moves to Hyperliquid (less the fee).
        let mut coming = 0.0;
        let short = |eng: &Engine, a: &Account, coming: f64| eng.rebalance_need(a, m) - coming;
        // 1. USDC on NEAR.
        let usdc = a.near.get_or("USDC", 0.0);
        if usdc >= MIN_MOVE_USD && steps.len() < max_steps {
            let x = py::min(need + ONE_CLICK_FEE, usdc);
            a.near.insert("USDC", usdc - x);
            a.hl_cash += x - ONE_CLICK_FEE;
            steps.push(Step::ToHl { usd: x });
        }
        // 2. USDT, sold for USDC.
        let left = short(self, &a, coming);
        let usdt = a.near.get_or("USDT", 0.0);
        if left > NEED_EPS_USD && usdt > 0.0 && steps.len() < max_steps {
            let pi = m.wrap_ratio("USDT");
            let target = left + ONE_CLICK_FEE;
            // The cost curve rises with the amount sold, so size it twice: at the target's cost, then at the cost of
            // that first size. Then cap it at what is held.
            let first = target / (1.0 - cost_1c("USDT", target, 1.0));
            let units = py::min(usdt, target / (pi * (1.0 - cost_1c("USDT", first, 1.0))));
            let v = token_value("USDT", units, m, 0.0, 0.0);
            let got = v - cost_1c("USDT", v, 1.0) * v;
            if got >= MIN_MOVE_USD {
                a.near.insert("USDT", usdt - units);
                let usdc = a.near.get_or("USDC", 0.0);
                a.near.insert("USDC", usdc + got);
                coming += got - ONE_CLICK_FEE;
                steps.push(Step::Swap {
                    token: "USDT".to_string(),
                    units,
                    usd: got,
                });
            }
        }
        // 3. Hedged pairs, the one with the most maintenance margin first.
        let mut end = PlanEnd::Done;
        while short(self, &a, coming) > NEED_EPS_USD {
            if steps.len() >= max_steps {
                end = PlanEnd::MaxSteps;
                break;
            }
            let pair = self
                .groups(&a)
                .into_iter()
                .filter_map(|g| {
                    let q = a.perps.get_or(&g, 0.0);
                    let t = a
                        .near
                        .iter()
                        .find(|(t, &u)| u != 0.0 && token(t).group == Some(g.as_str()))
                        .map(|(t, _)| t.to_string())?;
                    (q < 0.0).then(|| (self.mm(&g, q.abs() * m.mark_price(&g)), g, t))
                })
                .fold(None, |best: Option<(f64, String, String)>, c| match best {
                    Some(b) if b.0 >= c.0 => Some(b),
                    _ => Some(c),
                });
            let Some((_, g, t)) = pair else {
                end = PlanEnd::NothingLeft;
                break;
            };
            let q = a.perps.get_or(&g, 0.0);
            let w = m.wrap_ratio(&t);
            let hour_hl = p.participation * p.stressed_volume * self.coin(&g).adv30_usd / 24.0;
            let x = py::min3(
                py::min(q.abs(), a.near[t.as_str()] * w) * 0.25,
                hour_hl / m.mark_price(&g),
                token(&t).cap_h / m.price(&g),
            );
            let (dq, units) = (f64::from(-sgn(q)) * x, x / w);
            let mark = m.mark_price(&g);
            if x * mark < MIN_MOVE_USD {
                end = PlanEnd::NothingLeft;
                break;
            }
            let f = self.vol_factor(m, &g);
            let n = dq.abs() * mark;
            let c_hl = self.cost_hl(&g, n, f) * n;
            a.hl_cash += q * (mark - a.entry.get_or(&g, mark)) - c_hl;
            a.entry.insert(&g, mark);
            a.perps.insert(&g, q + dq);
            let v = token_value(&t, units, m, 0.0, 0.0);
            let c_1c = cost_1c(&t, v, f) * v;
            let held = a.near[t.as_str()];
            a.near.insert(&t, held - units);
            let usdc = a.near.get_or("USDC", 0.0);
            a.near.insert("USDC", usdc + v - c_1c);
            coming += v - c_1c - ONE_CLICK_FEE;
            steps.push(Step::Trade(Trade {
                kind: TradeKind::Pair,
                group: g,
                dq,
                token: Some(t),
                units,
                traded: n + v,
                cost: c_hl + c_1c,
                mr: None,
            }));
        }
        let left = short(self, &a, coming);
        let short_usd = if left > NEED_EPS_USD { left } else { 0.0 };
        plan(steps, a, end, short_usd)
    }
}
