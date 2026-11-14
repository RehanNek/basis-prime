//! RISK_ENGINE.md 7: the loan decision. The credit line is the smallest of a list of bounds (C0–C9), each
//! linear in the new loan, so the minimum is exact for a fixed rate; it is solved once more at the utilisation
//! the loan would cause. Withdrawals and other outflows are checked as intents: the engine runs on the book as
//! it would be afterwards. Ports `credit_limit`, `borrow_allowance`, `withdraw_allowance`, `credit_failures`
//! and `withdraw_intent`.
use crate::ordered::OrderedMap;
use crate::params::ClientTier;
use crate::py::{self, usd};
use crate::scenarios::Kind;
use crate::snapshot::{Account, Market};
use crate::stress::Requirement;
use crate::Engine;

/// The borrow allowance W*: how much more the account may borrow now, the bound that set it, and every bound.
#[derive(Clone, Debug, PartialEq)]
pub struct Allowance {
    /// W*, in USDC, rounded down to micro-USDC.
    pub w: f64,
    /// The name of the bound that binds (the first of equal ones).
    pub key: String,
    /// Every bound, in the order the reference builds them.
    pub bounds: OrderedMap<f64>,
}

/// An outflow to check (`withdraw_intent`'s arguments): `units` of a NEAR `token`, `hl_cash` from Hyperliquid,
/// or `to_hl` USDC moved from NEAR to Hyperliquid.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Withdrawal {
    pub token: Option<String>,
    pub units: f64,
    pub hl_cash: f64,
    pub to_hl: f64,
}

/// `min(bounds, key=bounds.get)`: the first key with the smallest value.
fn binding(bounds: &OrderedMap<f64>) -> &str {
    let mut it = bounds.iter();
    let (mut key, mut low) = it.next().expect("at least one bound");
    for (k, v) in it {
        if v < low {
            key = k;
            low = v;
        }
    }
    key
}

/// Rounded down to micro-USDC, and never below 0.
fn micro_floor(x: f64) -> f64 {
    py::max(0.0, (x * 1e6).floor() / 1e6)
}

impl Engine {
    /// 6: the client's limit, starting limit × 1.1^good_months, up to the tier's maximum.
    /// The power is repeated multiplication, not `powf`, so native and WASM builds get the same bits.
    pub fn credit_limit(&self, tier: ClientTier, good_months: i64) -> f64 {
        let t = tier.spec();
        let mut growth = 1.0;
        for _ in 0..good_months {
            growth *= 1.1;
        }
        py::min(t.limit_max, t.limit0 * growth)
    }

    /// 7.2: W*. Solved with today's rate, then once more at the utilisation the loan would cause. `req` is
    /// this account's own requirement, if already computed.
    pub fn borrow_allowance(
        &self,
        a: &Account,
        m: &Market,
        req: Option<&Requirement>,
        good_months: i64,
        score: Option<i64>,
    ) -> Allowance {
        self.borrow_pass(a, m, req, good_months, score, false)
    }

    fn borrow_pass(
        &self,
        a: &Account,
        m: &Market,
        req: Option<&Requirement>,
        good_months: i64,
        score: Option<i64>,
        second_pass: bool,
    ) -> Allowance {
        let own;
        let req = match req {
            Some(r) => r,
            None => {
                own = self.requirement(a, m);
                &own
            }
        };
        let p = &self.params;
        let e_allow = self.equity_allow(a, m);
        let d = a.debt;
        let (b, im) = (p.pool_loss_budget, p.im_mult);
        let horizon = p.tau();
        let mut bounds = OrderedMap::new();
        bounds.insert(
            "C0 equity",
            if e_allow >= p.min_equity_for_credit {
                e_allow
            } else {
                0.0
            },
        );
        for r in &req.rows {
            let w = self.weight(r.kind);
            let l0 = r.loss;
            let rt = r.rate * horizon;
            if w == 0.0 {
                continue; // an option that drops replays
            }
            // C1: equity after the loan covers 1.25 x the weighted loss, with interest on the new loan.
            bounds.insert(
                &format!("C1 {}", r.name),
                (e_allow - im * w * l0) / (1.0 + im * w * rt),
            );
            if r.kind == Kind::Extreme || w < 1.0 {
                // C3: the pool loses at most 5% of the total loan (extremes, or replays counted below full).
                bounds.insert(
                    &format!("C3 {}", r.name),
                    (e_allow - l0 + b * d) / (1.0 - b + rt),
                );
            } else {
                // C2: the pool loses nothing.
                bounds.insert(&format!("C2 {}", r.name), (e_allow - l0) / (1.0 + rt));
            }
        }
        let t = a.tier.spec();
        bounds.insert("C4 tier cap", t.cap * (e_allow + d) - d);
        bounds.insert(
            "C5 client limit",
            self.credit_limit(a.tier, good_months) - d,
        );
        bounds.insert(
            "C6 pool utilisation",
            p.util_cap * m.pool_capital - m.pool_loans,
        );
        bounds.insert("C6 pool share", p.client_pool_share * m.pool_capital - d);
        let hours = py::max_all(
            self.groups(a)
                .iter()
                .map(|g| self.unwind_hours(a, m, g))
                .chain([0.0]),
        );
        if hours > p.unwind_hours_max {
            bounds.insert("C8 unwind time", 0.0);
        }
        if score.is_some_and(|s| s < 450) {
            bounds.insert("C9 rating below 450", 0.0);
        }
        let key = binding(&bounds).to_string();
        let w = micro_floor(bounds[key.as_str()]);
        let u2 = (m.pool_loans + w) / m.pool_capital;
        if !second_pass && w > 0.0 && u2 > m.util + 1e-12 {
            let m2 = Market {
                util: u2,
                ..m.clone()
            };
            return self.borrow_pass(a, &m2, None, good_months, score, true);
        }
        Allowance { w, key, bounds }
    }

    /// 7.3: the most USDC the account may withdraw from NEAR now, and the bound that sets it. With no loan,
    /// nothing binds: all of its free USDC.
    pub fn withdraw_allowance(
        &self,
        a: &Account,
        m: &Market,
        req: Option<&Requirement>,
    ) -> (f64, String) {
        if a.debt <= 0.0 {
            return (a.near.get_or("USDC", 0.0), "no loan: free USDC".to_string());
        }
        let own;
        let req = match req {
            Some(r) => r,
            None => {
                own = self.requirement(a, m);
                &own
            }
        };
        let e_allow = self.equity_allow(a, m);
        let d = a.debt;
        let mut bounds = OrderedMap::new();
        bounds.insert("C1 initial requirement", e_allow - req.im);
        let cap_room = if d != 0.0 { d / a.tier.spec().cap } else { 0.0 };
        bounds.insert("C4 tier cap", e_allow + d - cap_room);
        bounds.insert("free USDC on NEAR", a.near.get_or("USDC", 0.0));
        for r in req.rows.iter().filter(|r| r.kind == Kind::Extreme) {
            bounds.insert(
                &format!("C3 {}", r.name),
                e_allow - r.loss + self.params.pool_loss_budget * d,
            );
        }
        let key = binding(&bounds).to_string();
        (micro_floor(bounds[key.as_str()]), key)
    }

    /// 7.3: the three credit conditions every risk-adding action must leave true while there is a loan:
    /// E_A ≥ IM, D ≤ cap × C, and extreme-day pool loss ≤ 5% of D. Empty means all hold.
    pub fn credit_failures(
        &self,
        a: &Account,
        m: &Market,
        req: Option<&Requirement>,
    ) -> Vec<String> {
        if a.debt <= 0.0 {
            return Vec::new();
        }
        let own;
        let req = match req {
            Some(r) => r,
            None => {
                own = self.requirement(a, m);
                &own
            }
        };
        let p = &self.params;
        let e_allow = self.equity_allow(a, m);
        let mut fails = Vec::new();
        if e_allow < req.im - 1e-6 {
            fails.push(format!(
                "equity {} below the initial requirement {}",
                usd(e_allow),
                usd(req.im)
            ));
        }
        if a.debt > a.tier.spec().cap * (e_allow + a.debt) + 1e-6 {
            fails.push("loan above the tier cap on collateral".to_string());
        }
        let worst = py::max_all(
            req.rows
                .iter()
                .filter(|r| r.kind == Kind::Extreme)
                .map(|r| r.loss)
                .chain([0.0]),
        );
        if worst - e_allow > p.pool_loss_budget * a.debt + 1e-6 {
            fails.push("extreme-day pool loss above 5% of the loan".to_string());
        }
        fails
    }

    /// 7.3: any outflow (a NEAR token, or Hyperliquid cash), and any move of USDC from NEAR to Hyperliquid
    /// (margin there can be lost in a backstop), runs on the book as it would be after. Returns whether it
    /// may go ahead and why.
    pub fn withdraw_intent(&self, a: &Account, m: &Market, w: &Withdrawal) -> (bool, String) {
        let mut near = a.near.clone();
        if w.to_hl > 0.0 {
            if w.to_hl > near.get_or("USDC", 0.0) + 1e-9 {
                return (false, "more USDC than the NEAR account holds".to_string());
            }
            near.insert("USDC", near.get_or("USDC", 0.0) - w.to_hl);
            let a3 = Account {
                near,
                hl_cash: a.hl_cash + w.to_hl,
                ..a.clone()
            };
            return verdict(self.credit_failures(&a3, m, None));
        }
        if let Some(t) = w.token.as_deref().filter(|t| !t.is_empty()) {
            if w.units > near.get_or(t, 0.0) + 1e-12 {
                return (false, "more than the account holds".to_string());
            }
            near.insert(t, near.get_or(t, 0.0) - w.units);
        }
        if w.hl_cash > 0.0 && self.hl_equity_now(a, m) - w.hl_cash < self.hl_keep(a, m) - 1e-6 {
            return (
                false,
                "would leave less on Hyperliquid than its transfer rule and our 30% target need"
                    .to_string(),
            );
        }
        let a2 = Account {
            near,
            hl_cash: a.hl_cash - w.hl_cash,
            ..a.clone()
        };
        verdict(self.credit_failures(&a2, m, None))
    }
}

fn verdict(fails: Vec<String>) -> (bool, String) {
    if fails.is_empty() {
        (true, "ok".to_string())
    } else {
        (false, fails.join("; "))
    }
}
