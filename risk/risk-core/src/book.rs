//! RISK_ENGINE.md 12.1, last row: the book stress test. Every account's scenarios run together:
//! - **One list of bad days for the whole book.** Markets move together, so the list is built once, from the book
//!   as one account (4.5), with each coin's shock sized for the book's total holding of it (4.2: our clients
//!   would be selling together).
//! - **Each account plays every day out on its own.** Each Hyperliquid account is liquidated on its own (4.3),
//!   and one client's surplus doesn't cover another's shortfall.
//! - **Unwind costs at the book's size.** Each account pays the cost rate of selling the whole book's holding of
//!   that coin on that venue (4.6), on its own part of it.
//! - **ADL closes only the winning side.** The book can hold both sides of a coin, so the ADL and squeeze days are
//!   built for each side some account holds, and an ADL day closes only the perps on the side it targets.
//!
//! The pool's loss on a day is the sum, over accounts, of what is still owed after selling everything at that
//! account's worst point: max(0, debt + the week's interest − what is left), never more than is owed. It is not
//! weighted: the limit is on the actual loss.
//!
//! For a book of one account the costs, the list and every account's result are the engine's own (`stress.rs`):
//! the tests check that, bit for bit.
use crate::costs::cost_1c;
use crate::ordered::OrderedMap;
use crate::params::token;
use crate::py::{self, sgn};
use crate::scenarios::{move_of, Carry, Kind, Scenario};
use crate::snapshot::{Account, Market};
use crate::stress::scenario_value;
use crate::Engine;
use std::collections::BTreeMap;

/// One day of the book's list, and what it costs the pool.
#[derive(Clone, Debug, PartialEq)]
pub struct BookRow {
    pub name: String,
    pub kind: Kind,
    /// Σ over accounts of what is still owed after selling everything (USDC).
    pub pool_loss: f64,
    /// Each account's part of it, in the order the accounts were given.
    pub shortfalls: Vec<f64>,
}

/// A bad day of the book, and for an ADL day the side it closes (+1 longs, −1 shorts; 0 otherwise).
#[derive(Clone, Debug, PartialEq)]
pub struct BookScenario {
    pub scenario: Scenario,
    pub adl_side: i32,
}

/// What the book holds in total, for the unwind costs: gross perp units per coin, units per NEAR token.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BookSize {
    pub perp_units: BTreeMap<String, f64>,
    pub token_units: BTreeMap<String, f64>,
}

impl BookSize {
    pub fn of(accounts: &[&Account]) -> BookSize {
        let mut s = BookSize::default();
        for a in accounts {
            for (c, &q) in a.perps.iter() {
                *s.perp_units.entry(c.to_string()).or_insert(0.0) += q.abs();
            }
            for (t, &u) in a.near.iter() {
                *s.token_units.entry(t.to_string()).or_insert(0.0) += u.abs();
            }
        }
        s
    }
}

/// The book as one account, for building the list of days: NEAR tokens and money in transit added up, and each
/// coin's perps as their gross size, signed like the net position (long if it nets to zero). Gross, because the
/// accounts unwind separately, so their sizes add up for the liquidity factor whichever side they are on.
pub fn aggregate(accounts: &[&Account]) -> Account {
    let mut agg = Account::default();
    let mut net: OrderedMap<f64> = OrderedMap::new();
    let mut gross: OrderedMap<f64> = OrderedMap::new();
    for a in accounts {
        for (t, &u) in a.near.iter() {
            agg.near.insert(t, agg.near.get_or(t, 0.0) + u);
        }
        for (c, &q) in a.perps.iter() {
            if q != 0.0 {
                net.insert(c, net.get_or(c, 0.0) + q);
                gross.insert(c, gross.get_or(c, 0.0) + q.abs());
            }
        }
        agg.inflight.extend(a.inflight.iter().cloned());
        agg.debt += a.debt;
        agg.hl_cash += a.hl_cash;
    }
    for (c, &g) in gross.iter() {
        let sign = if net.get_or(c, 0.0) < 0.0 { -1.0 } else { 1.0 };
        agg.perps.insert(c, sign * g);
    }
    agg
}

impl Engine {
    /// The book's list of days (4.5 for the book as one account), with the ADL and squeeze days added for the
    /// other side of any coin where some account holds the side the book as a whole doesn't. The groups the
    /// moves refer to come first.
    pub fn book_scenarios(
        &self,
        accounts: &[&Account],
        m: &Market,
    ) -> (Vec<String>, Vec<BookScenario>) {
        let agg = aggregate(accounts);
        let set = self.scenarios(&agg, m);
        let side_of = |c: &str| sgn(agg.perps.get_or(c, 0.0));
        let tag = |side: i32| if side < 0 { " (shorts)" } else { " (longs)" };
        let mut out = Vec::new();
        for sc in set.list {
            let side = match sc.kind {
                Kind::Adl => side_of(sc.adl_coin.as_deref().unwrap_or("")),
                Kind::Reversal => perp_of(&sc.name).map_or(0, side_of),
                _ => 0,
            };
            let mut sc = sc;
            if matches!(sc.kind, Kind::Adl | Kind::Reversal) {
                sc.name.push_str(tag(side));
            }
            out.push(BookScenario {
                adl_side: if sc.kind == Kind::Adl { side } else { 0 },
                scenario: sc,
            });
        }
        // The other side's days, where some account holds it: the same moves the other way.
        for (c, &q) in agg.perps.clone().iter() {
            let theirs = -sgn(q);
            let held = accounts
                .iter()
                .any(|a| sgn(a.perps.get_or(c, 0.0)) == theirs);
            if !held {
                continue;
            }
            let mut flipped = agg.clone();
            flipped.perps.insert(c, -q);
            let other = self.scenarios(&flipped, m);
            debug_assert_eq!(other.groups, set.groups);
            for mut sc in other.list {
                let ours = match sc.kind {
                    Kind::Adl => sc.adl_coin.as_deref() == Some(c),
                    Kind::Reversal => perp_of(&sc.name) == Some(c),
                    _ => false,
                };
                if ours {
                    sc.name.push_str(tag(theirs));
                    out.push(BookScenario {
                        adl_side: if sc.kind == Kind::Adl { theirs } else { 0 },
                        scenario: sc,
                    });
                }
            }
        }
        (set.groups, out)
    }

    /// 12.1: every account through every day of the book's list. `accounts` are each account and the market it
    /// is valued in (π can differ by account); the list is built on `m`, the market for the book as a whole.
    pub fn book_stress(&self, accounts: &[(&Account, &Market)], m: &Market) -> Vec<BookRow> {
        let only: Vec<&Account> = accounts.iter().map(|(a, _)| *a).collect();
        let size = BookSize::of(&only);
        let (groups, list) = self.book_scenarios(&only, m);
        list.iter()
            .map(|bs| {
                let shortfalls: Vec<f64> = accounts
                    .iter()
                    .map(|(a, ma)| {
                        let (worst, rate) =
                            self.run_in_book(a, ma, &bs.scenario, &groups, bs.adl_side, &size);
                        let owed = a.debt + a.debt * rate * self.params.tau();
                        if a.debt <= 0.0 {
                            0.0
                        } else {
                            py::min(py::max(0.0, -worst), owed)
                        }
                    })
                    .collect();
                BookRow {
                    name: bs.scenario.name.clone(),
                    kind: bs.scenario.kind,
                    pool_loss: py::sum(shortfalls.iter().copied()),
                    shortfalls,
                }
            })
            .collect()
    }

    /// One account through one of the book's days, as `Engine::run` plays it, but paying unwind costs at the
    /// book's size and, on an ADL day, losing its perp only if it is on the side the day closes. Returns the worst
    /// equity left over the path and the yearly rate charged on the loan.
    pub fn run_in_book(
        &self,
        a: &Account,
        m: &Market,
        sc: &Scenario,
        groups: &[String],
        adl_side: i32,
        size: &BookSize,
    ) -> (f64, f64) {
        let p = &self.params;
        let spread = a.tier.spec().spread;
        let rate = if sc.carry == Carry::Stress {
            p.base_rate(1.0) + spread
        } else {
            p.base_rate(m.util) + spread
        };
        let debt = a.debt;
        let mut perps: OrderedMap<f64> = a
            .perps
            .iter()
            .filter(|(_, &q)| q != 0.0)
            .map(|(c, &q)| (c, q))
            .collect();
        let mut hl_base = self.hl_equity_now(a, m);
        let horizon = p.tau();
        let mut liquidated = false;
        let mut worst = f64::INFINITY;
        // The book's notional of coin `c` at an account's mark `x`, and its value of token `t` from this account's.
        let book_units = |c: &str, own: f64| size.perp_units.get(c).copied().unwrap_or(own);
        let book_share = |t: &str, own: f64| match size.token_units.get(t) {
            Some(&total) if own != 0.0 && total != own.abs() => total / own.abs(),
            _ => 1.0,
        };
        for (si, stage) in sc.path.iter().enumerate() {
            if let Some(g) = sc.adl_coin.as_deref() {
                if si == 1 && perps.get(g).is_some_and(|&q| sgn(q) == adl_side) {
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
            if !perps.is_empty() && !liquidated {
                for alt in stage {
                    let mk = self.book_marks(m, &perps, groups, alt, sc.basis);
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
                        let post = if eq >= p.backstop_frac * mmv {
                            let slip = py::sum(perps.iter().zip(&mk).map(|((c, &q), &x)| {
                                let n = q.abs() * x;
                                let book_n = book_units(c, q.abs()) * x;
                                py::max(
                                    p.liq_slip_floor,
                                    2.0 * self.cost_hl(c, book_n, self.vol_factor(m, c)),
                                ) * n
                            }));
                            py::max(eq - slip, 0.0)
                        } else {
                            0.0
                        };
                        hl_base = post;
                        perps = OrderedMap::new();
                        liquidated = true;
                        break;
                    }
                }
            }
            for alt in stage {
                let mk = self.book_marks(m, &perps, groups, alt, sc.basis);
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
                    near_cost += cost_1c(t, v * book_share(t, u), f) * v;
                }
                let infl = py::sum(a.inflight.iter().filter(|f| !f.overdue).map(|f| {
                    p.inflight_state_value * scenario_value(sc, groups, alt, &f.token, f.units, m)
                }));
                let hl_cost = py::sum(perps.iter().zip(&mk).map(|((c, &q), &x)| {
                    let book_n = book_units(c, q.abs()) * x;
                    self.cost_hl(c, book_n, self.vol_factor(m, c)) * q.abs() * x
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
                }
            }
        }
        (worst, rate)
    }

    /// Each perp's mark in one alternative: the move, then the adverse gap if the family has one (as `stress.rs`).
    fn book_marks(
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
}

/// The perp a squeeze day is about, from its name (`squeeze BTC 1.00S then back 0.50S`).
fn perp_of(name: &str) -> Option<&str> {
    name.strip_prefix("squeeze ")?.split(' ').next()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 13.1's hedged book with a loan drawn and taken out: 1.2774 nBTC, a 1.2774 BTC short with $35k of margin,
    /// and `debt` owed.
    fn hedged(debt: f64) -> Account {
        let mut a = Account::default();
        a.near.insert("nBTC", 1.2774);
        a.perps.insert("BTC", -1.2774);
        a.entry.insert("BTC", 78_287.0);
        a.hl_cash = 35_000.0;
        a.debt = debt;
        a
    }

    #[test]
    fn a_book_of_one_account_is_the_engines_own_stress_test() {
        let eng = Engine::v0();
        let m = eng.calm_market();
        let a = hedged(94_500.0);
        let own = eng.scenarios(&a, &m);
        let (groups, list) = eng.book_scenarios(&[&a], &m);
        assert_eq!(groups, own.groups);
        assert_eq!(list.len(), own.list.len());
        let size = BookSize::of(&[&a]);
        for (bs, sc) in list.iter().zip(&own.list) {
            assert_eq!(bs.scenario.path, sc.path, "{}", sc.name);
            assert!(bs.scenario.name.starts_with(&sc.name));
            let (worst, rate) = eng.run_in_book(&a, &m, &bs.scenario, &groups, bs.adl_side, &size);
            let (theirs, their_rate, _) = eng.run(&a, &m, sc, &own.groups, 0.0);
            assert_eq!(
                (worst.to_bits(), rate),
                (theirs.to_bits(), their_rate),
                "{}",
                sc.name
            );
        }
        // The pool's loss is what is still owed: none on most days for a book inside its line.
        let rows = eng.book_stress(&[(&a, &m)], &m);
        assert_eq!(rows.len(), own.list.len());
        for r in &rows {
            assert_eq!(r.shortfalls.len(), 1);
            assert!(
                r.pool_loss >= 0.0 && r.pool_loss <= 94_500.0 * 1.01,
                "{}: {}",
                r.name,
                r.pool_loss
            );
        }
        assert!(rows
            .iter()
            .any(|r| r.kind == Kind::Adl && r.name.ends_with("(shorts)")));
    }

    #[test]
    fn selling_together_costs_more_than_selling_alone() {
        let eng = Engine::v0();
        let m = eng.calm_market();
        // A book of ten copies of a big unhedged nBTC holding: each pays the cost of the whole book's sale.
        let mut a = Account::default();
        a.near.insert("nBTC", 30.0);
        a.debt = 1_600_000.0;
        let alone = eng.book_stress(&[(&a, &m)], &m);
        let ten: Vec<(&Account, &Market)> = (0..10).map(|_| (&a, &m)).collect();
        let together = eng.book_stress(&ten, &m);
        let crash = |rows: &[BookRow]| {
            rows.iter()
                .find(|r| r.name == "2S all down + bridge slip")
                .unwrap()
                .clone()
        };
        let (one, all) = (crash(&alone), crash(&together));
        assert!(one.pool_loss > 0.0);
        // Bigger shocks (the liquidity factor) and bigger costs: more than ten times one account's loss.
        assert!(
            all.pool_loss > 10.0 * one.pool_loss,
            "{} vs {}",
            all.pool_loss,
            one.pool_loss
        );
        assert!(all.shortfalls.iter().all(|&s| s == all.shortfalls[0]));
        // No account with no loan costs the pool anything.
        let mut no_loan = a.clone();
        no_loan.debt = 0.0;
        assert!(eng
            .book_stress(&[(&no_loan, &m)], &m)
            .iter()
            .all(|r| r.pool_loss == 0.0));
        assert!(eng.book_stress(&[], &m).iter().all(|r| r.pool_loss == 0.0));
    }

    #[test]
    fn both_sides_of_a_coin_get_their_adl_days() {
        let eng = Engine::v0();
        let m = eng.calm_market();
        // One client short BTC against nBTC, another long BTC perps alone.
        let short = hedged(50_000.0);
        let mut long = Account::default();
        long.perps.insert("BTC", 0.5);
        long.entry.insert("BTC", 78_287.0);
        long.hl_cash = 20_000.0;
        long.debt = 10_000.0;
        let (_, list) = eng.book_scenarios(&[&short, &long], &m);
        let adl: Vec<&BookScenario> = list
            .iter()
            .filter(|b| b.scenario.kind == Kind::Adl)
            .collect();
        assert_eq!(adl.iter().filter(|b| b.adl_side == -1).count(), 2);
        assert_eq!(adl.iter().filter(|b| b.adl_side == 1).count(), 2);
        let squeezes = list
            .iter()
            .filter(|b| b.scenario.kind == Kind::Reversal)
            .count();
        assert_eq!(squeezes, 6);
        // On a day that closes the shorts, the long keeps its perp: it is the losing side of that move.
        let day = adl.iter().find(|b| b.adl_side == -1).unwrap();
        let size = BookSize::of(&[&short, &long]);
        let groups = vec!["BTC".to_string()];
        let (kept, _) = eng.run_in_book(&long, &m, &day.scenario, &groups, day.adl_side, &size);
        let (closed, _) = eng.run_in_book(&long, &m, &day.scenario, &groups, 1, &size);
        assert_ne!(kept, closed);
    }

    #[test]
    fn squeeze_names_give_their_perp() {
        assert_eq!(
            perp_of("squeeze kPEPE 1.00S then back 0.50S"),
            Some("kPEPE")
        );
        assert_eq!(perp_of("ADL BTC 0.67S then 0.67S"), None);
    }
}
