//! The verdict (RISK_ENGINE.md Appendix A) from the inputs. This is a pure function of `Inputs`, so `backtest
//! verdict` gets the same bytes natively as the enclave did.
//!
//! The order of work: the NEAR side and the Hyperliquid side become the engine's `Account`; the readings become its
//! `Market`; the rating picks the tier, capped by the pool's tier rule; then the engine runs once for the
//! requirement, the state and the allowances, and the searches add the top-up, the bands and the plan.
//!
//! Building the book (the account, the market and the rating) lives in `pb_read::book`, which pb-gateway shares.
//!
//! With outside lenders in the book (FUNDING.md 6, INTERFACES.md 27), the engine's state and requirement run on the
//! whole debt, the borrow allowance is asked twice (what the book can carry at all, and what our pool's own limits
//! allow), and [`crate::lenders`] adds each lender's cushion and room (`ext`), the answer to a `fund` intent and the
//! top-up of a thin cushion. An account with no lender gets the verdict it always got, to the byte.
use crate::bands;
use crate::lenders::{self, Evm, Ext};
use crate::plan::{self, NoQuotes, Wired};
use pb_read::book::{self, Book};
use pb_read::inputs::Inputs;
use pb_read::lenders::AAVE;
use pb_read::near::pool_name;
use pb_read::request::Intent;
use pb_read::steps::PlanStep;
use pb_read::util::{bp, micro_down, micro_exact, micro_up, pow10, sha256_hex, u64_of};
use risk_core::params::find_token;
use risk_core::universe::UNIVERSE_V0;
use risk_core::valuation::{token_value, token_value_at};
use risk_core::{Account, Action, Routes, State, Withdrawal};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub use pb_read::book::{coins_to_read, held_coins};

pub const MODEL: &str = "B-0.2";
pub const VERDICT_V: u32 = 1;
/// Appendix A: under 2 KB. The farthest bands, then the last plan steps, are dropped if a verdict would pass this.
pub const MAX_VERDICT_BYTES: usize = 2000;
/// At most this many `top` lines about overdue transfers; one more line counts the rest.
pub const MAX_OVERDUE_LINES: usize = 2;
/// A verdict carries at most this many plan steps and band entries; the next verdict re-plans the rest.
pub const MAX_PLAN_STEPS: usize = 4;
pub const MAX_BAND_ENTRIES: usize = 3;
/// π when a wrapped token has no reading (3.3: the extreme depeg, and the token is reduce-only).
pub const PI_NO_READING: f64 = risk_core::prices::PI_NO_READING;

/// The parameter file's hash: the verdict's `params`, which the account checks against its config.
pub fn params_hash() -> String {
    sha256_hex(UNIVERSE_V0.as_bytes())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Verdict {
    pub ok: bool,
    pub v: u32,
    pub model: String,
    pub params: String,
    pub acct: String,
    pub blk: u64,
    pub nonce: u64,
    pub eq: i64,
    pub eq_allow: i64,
    pub mm: i64,
    pub im: i64,
    pub state: String,
    pub action: String,
    /// When the current margin call started (block time, ns), 0 if none.
    pub since: u64,
    pub score: i64,
    pub tier: String,
    pub rate_bp: u64,
    pub allow: Allow,
    pub credit: Credit,
    pub volf_bp: u64,
    pub top: Vec<String>,
    pub topup: i64,
    pub venues: Venues,
    pub pool: PoolPart,
    pub hr_bp: u64,
    pub hr7_bp: u64,
    pub exp_bp: u64,
    pub bands: BTreeMap<String, Band>,
    pub coins: Coins,
    /// INTERFACES.md 13: at most 4 steps, for DELEVERAGE, REBALANCE and REBALANCE_NOW.
    pub plan: Vec<PlanStep>,
    /// Pending `to_hl` transfers that Hyperliquid shows delivered (INTERFACES.md 14). Left out when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub arrived: Vec<String>,
    /// The account's open sends (`get_state().hl.open_sends`) that Hyperliquid's ledger shows as sent, as their
    /// nonces (INTERFACES.md 50.2). The account ends its borrowing pause for each when it accepts the verdict.
    /// Left out when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sent: Vec<u64>,
    /// FUNDING.md 6.6: each lender position, at most 2. Left out when the account has none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ext: Vec<Ext>,
    /// The funding steps that answer a `fund` intent, at most 6 (INTERFACES.md 25). Left out when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fund: Vec<PlanStep>,
    /// The account's Ethereum nonce, when Aave was read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evm: Option<Evm>,
    #[serde(rename = "in")]
    pub inputs: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Allow {
    /// Micro-USDC. For a `withdraw`, `lender_withdraw` or `evm_withdraw` intent: the intent's amount, in the token's
    /// units, if allowed, else 0.
    pub withdraw: u128,
    /// W*, micro-USDC: how much more the account may borrow from our pool now. With lenders it is the smaller of
    /// what the book can carry at all and what our pool's own limits allow.
    pub borrow: u128,
    /// For a `fund` intent: what the `fund` steps borrow in all, micro-USDC; 0 when nothing can be lent. Left out
    /// for every other intent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fund: Option<u128>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credit {
    pub line: u128,
    pub binding: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Venues {
    pub hl_margin_ratio_bp: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PoolPart {
    pub shares_bp: BTreeMap<String, u64>,
    pub hold: BTreeMap<String, u128>,
    pub hl_eq: u128,
}

/// One coin's or wrapped token's trigger levels. Coin levels are prices in micro-USD per Hyperliquid unit (the
/// margin-ratio bands at Hyperliquid's mark, the equity bands at the reference price); token levels are π in bp.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Band {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hl50: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hl100: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub im: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mr: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub im_bp: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mr_bp: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dl_bp: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Coins {
    pub uncertain: Vec<String>,
    pub stale: Vec<String>,
    pub reduce_only: Vec<String>,
}

#[derive(Serialize)]
struct Refusal<'a> {
    ok: bool,
    reason: &'a str,
}

/// `{"ok":false,"reason":...}`.
pub fn refusal(reason: &str) -> String {
    serde_json::to_string(&Refusal { ok: false, reason }).expect("a refusal serialises")
}

/// What pb-risk prints for these inputs: the verdict, or a refusal.
pub fn output(inputs: &Inputs) -> String {
    match compute(inputs) {
        Ok(v) => serde_json::to_string(&v).expect("a verdict serialises"),
        Err(reason) => refusal(&reason),
    }
}

/// A coin band as an integer price, rounded toward today's price so the trigger fires early.
fn band_price(price: f64, x: f64) -> i64 {
    let micro = price * (1.0 + x) * 1e6;
    let r = if x > 0.0 { micro.floor() } else { micro.ceil() };
    r.clamp(0.0, pb_read::util::MICRO_CAP) as i64
}

pub fn compute(inp: &Inputs) -> Result<Verdict, String> {
    compute_book(book::build(inp)?, inp)
}

/// The verdict for a book already built from `inp`. The decision is split from the build here so a test, or the
/// backtest, can set what the book holds at the lenders by hand.
pub fn compute_book(book: Book, inp: &Inputs) -> Result<Verdict, String> {
    let Book {
        now_ns,
        client,
        conf,
        pool: _,
        borrower: _,
        statuses: _,
        raw_balance,
        debt_micro,
        engine: eng,
        account: a,
        groups,
        built,
        hr_bp,
        exp_bp,
        hr7,
        score,
        tier,
        arrived,
        overdue,
        // FUNDING.md 6: the cushion rule, the split and the top-up plan read this (INTERFACES.md 27).
        lenders: lb,
    } = book;
    let req = &inp.request;
    let m = &built.market;

    // The engine. The margin-call clock and the state hysteresis starts from are the account's own records.
    let rq = eng.requirement(&a, m);
    let age_h = client.margin_call_age_h(now_ns);
    let st = eng.state(&a, m, &rq, age_h, client.prev_state);
    let e_allow = eng.equity_allow(&a, m);
    let rate = eng.params.base_rate(m.util) + tier.spec().spread;
    // FUNDING.md 6.2: the checked maths treats all debt as our pool's, so with lenders it is asked twice.
    // The pool room: our pool's debt alone, against every bound, our pool's own limits included. With no lender
    // this is the one call there always was.
    let allowance = if lb.is_empty() {
        eng.borrow_allowance(&a, m, Some(&rq), 0, Some(score))
    } else {
        let ours = Account {
            debt: debt_micro as f64 / 1e6,
            ..a.clone()
        };
        eng.borrow_allowance(&ours, m, None, 0, Some(score))
    };
    let pool_room = micro_exact(allowance.w).max(0) as u128;
    let pool_code = allowance.key.split(' ').next().unwrap_or("").to_string();
    // The risk room: the whole debt, with our pool's own limits out of the way.
    let (risk_room, risk_code) = if lb.is_empty() {
        (pool_room, pool_code.clone())
    } else {
        lenders::risk_room(&eng, &a, m, score, &lb, rate)
    };
    // 3.2: no new risk while a held coin's price is uncertain.
    let no_new_risk = !built.uncertain.is_empty();
    let (borrow_micro, risk_room, binding) = if no_new_risk {
        (0, 0, "PRICE".to_string())
    } else if risk_room < pool_room {
        (risk_room, risk_room, risk_code)
    } else {
        (pool_room, risk_room, pool_code)
    };
    // The whole debt: our pool's and every lender's.
    let whole_debt_micro = debt_micro.saturating_add(lb.owed_micro());
    let healthy = st.state == State::Healthy;
    let rooms = lenders::rooms(&lb, risk_room, healthy && !no_new_risk);
    let has_loan = a.debt > 0.0;
    let (usdc_out, _) = eng.withdraw_allowance(&a, m, Some(&rq));
    // With lenders, the book also counts what isn't on NEAR; a withdrawal from NEAR can only take what is.
    let near_usdc_micro = || -> u128 {
        conf.tokens
            .iter()
            .filter(|t| t.engine == "USDC")
            .map(|t| {
                let raw = raw_balance.get(t.id.as_str()).copied().unwrap_or(0);
                (raw as f64 / pow10(t.decimals) * 1e6).floor() as u128
            })
            .sum()
    };
    let amount_of = |amount: &str, what: &str| -> Result<u128, String> {
        amount
            .parse()
            .map_err(|_| format!("the {what} amount isn't a U128"))
    };
    let allow_withdraw = match &req.intent {
        // 7.3: the intent runs on the book as it would be afterwards.
        Intent::Withdraw { token, amount } => {
            let t = conf
                .tokens
                .iter()
                .find(|t| &t.id == token)
                .ok_or_else(|| format!("the account isn't configured for token {token}"))?;
            let raw: u128 = amount
                .parse()
                .map_err(|_| "the withdraw amount isn't a U128")?;
            let ok = if !has_loan {
                raw <= raw_balance[t.id.as_str()]
            } else if !lb.is_empty() && raw > raw_balance[t.id.as_str()] {
                // The rest of this token is at a lender or on Ethereum, not here.
                false
            } else if no_new_risk {
                false
            } else {
                let units = raw as f64 / pow10(t.decimals);
                let wd = Withdrawal {
                    token: Some(t.engine.to_string()),
                    units,
                    ..Withdrawal::default()
                };
                eng.withdraw_intent(&a, m, &wd).0
            };
            if ok {
                raw
            } else {
                0
            }
        }
        // INTERFACES.md 27: collateral comes back from a lender only when the book is inside every rule and the
        // lender's cushion stays at the target. The token stays in the account, so the book itself doesn't change.
        Intent::LenderWithdraw {
            lender,
            token,
            amount,
        } => {
            let raw = amount_of(amount, "lender_withdraw")?;
            let pos = lb
                .get(lender)
                .ok_or_else(|| format!("the account's config names no lender {lender}"))?;
            let i = pos
                .posted
                .iter()
                .position(|h| h.id.eq_ignore_ascii_case(token))
                .ok_or_else(|| format!("the account has no {token} posted at {lender}"))?;
            let inside =
                !has_loan || (!no_new_risk && eng.credit_failures(&a, m, Some(&rq)).is_empty());
            if inside && lenders::cushion_holds_after(&lb, pos, i, raw, m) {
                raw
            } else {
                0
            }
        }
        // A token sent away from the account's Ethereum address leaves the book, so it is answered as a withdrawal
        // is: on the book as it would be afterwards.
        Intent::EvmWithdraw { token, amount } => {
            let raw = amount_of(amount, "evm_withdraw")?;
            let aave = lb.get(AAVE).ok_or(
                "the account's config names no lender on Ethereum, so it has nothing there to withdraw",
            )?;
            let usdc = inp.near.config.pointer("/lenders/aave/usdc");
            let is_usdc = usdc
                .and_then(|u| u.get("address"))
                .and_then(serde_json::Value::as_str)
                .is_some_and(|a| a.eq_ignore_ascii_case(token));
            let (engine, units, held) = if is_usdc {
                let decimals = usdc
                    .and_then(|u| u.get("decimals"))
                    .and_then(u64_of)
                    .unwrap_or(6) as u32;
                let units = raw as f64 / pow10(decimals);
                (
                    "USDC".to_string(),
                    units,
                    units * 1e6 <= aave.cash_micro as f64,
                )
            } else {
                // What sits at the address: what a step could post, and what Aave's pool has no room for.
                let mut at_address = aave
                    .spare
                    .iter()
                    .chain(aave.stuck.iter())
                    .filter(|h| h.id.eq_ignore_ascii_case(token));
                let h = at_address.next().ok_or_else(|| {
                    format!("the account's Ethereum address holds no {token} that its config names")
                })?;
                let there = at_address.fold(h.raw, |sum, more| sum.saturating_add(more.raw));
                (
                    h.engine.clone(),
                    raw as f64 / pow10(h.decimals),
                    raw <= there,
                )
            };
            let ok = held
                && (!has_loan
                    || (!no_new_risk && {
                        let wd = Withdrawal {
                            token: Some(engine),
                            units,
                            ..Withdrawal::default()
                        };
                        eng.withdraw_intent(&a, m, &wd).0
                    }));
            if ok {
                raw
            } else {
                0
            }
        }
        _ if has_loan && no_new_risk => 0,
        _ if lb.is_empty() => micro_exact(usdc_out).max(0) as u128,
        _ => (micro_exact(usdc_out).max(0) as u128).min(near_usdc_micro()),
    };
    // FUNDING.md 6.4: a `fund` intent is split between at most one lender and our pool.
    let funded = match &req.intent {
        Intent::Fund { amount } => {
            let ask = amount_of(amount, "fund")?;
            Some(if no_new_risk {
                lenders::Funded {
                    note: "funding: nothing is lent while a held coin's price is uncertain".into(),
                    ..lenders::Funded::default()
                }
            } else if !healthy {
                lenders::Funded {
                    note: format!(
                        "funding: nothing is lent while the account is {}",
                        st.state.as_str()
                    ),
                    ..lenders::Funded::default()
                }
            } else {
                lenders::fund(
                    &lb,
                    m,
                    ask,
                    risk_room,
                    borrow_micro,
                    bp(rate) as u32,
                    &rooms,
                    lenders::funding_order(&inp.near.params),
                )
            })
        }
        _ => None,
    };
    // FUNDING.md 6.5: a thin cushion at a lender asks for a top-up, whatever the permission says. An unwind comes
    // first: its plan is the account's whole plan.
    let tops = lenders::top_ups(&lb, m, MAX_PLAN_STEPS, st.action == Action::Deleverage);
    let action = match (st.action, tops.action) {
        (Action::Deleverage, _) => Action::Deleverage,
        (Action::RebalanceNow, _) | (_, Action::RebalanceNow) => Action::RebalanceNow,
        (Action::Rebalance, _) | (_, Action::Rebalance) => Action::Rebalance,
        _ => Action::None,
    };

    let topup = bands::topup(&eng, &a, m, &rq);
    // INTERFACES.md 13. A run that can't reach 1Click plans only what needs no quote: repayments and perp trades.
    let routes = if req.net().one_click_quotes {
        Routes::ALL
    } else {
        Routes::NO_ONE_CLICK
    };
    let engine_plan = match st.action {
        Action::Deleverage => Some(eng.deleverage_steps(&a, m, MAX_PLAN_STEPS, routes)),
        Action::Rebalance | Action::RebalanceNow => {
            Some(eng.rebalance_steps(&a, m, MAX_PLAN_STEPS, routes))
        }
        Action::None => None,
    };
    // What is on NEAR itself, after the top-up's own steps: no other step may spend more (FUNDING.md 6.2).
    let on_near_only = (!lb.is_empty()).then(|| {
        let mut free = plan::OnNear::new();
        for t in &conf.tokens {
            let raw = raw_balance.get(t.id.as_str()).copied().unwrap_or(0);
            *free.entry(t.engine.to_string()).or_insert(0.0) += raw as f64 / pow10(t.decimals);
        }
        for (token, units) in &tops.near_spent {
            let left = free.entry(token.clone()).or_insert(0.0);
            *left = (*left - units).max(0.0);
        }
        free
    });
    let first = Wired::starting_with(tops.steps, tops.notes);
    let mut wired = match &engine_plan {
        Some(p) => {
            let ctx = plan::Ctx {
                engine: &eng,
                market: m,
                account: &a,
                conf: &conf,
                assets: &inp.hl.assets,
                uncertain: &built.uncertain,
                // What the run's network gave when it read (0, in a run from before 12 Nov: no floor).
                band_floor: Some(inp.band_floor).filter(|f| *f > 0.0),
            };
            plan::wire_with(&ctx, &mut NoQuotes, st.action, p, first, on_near_only)
        }
        None => first,
    };

    // 8.3: bands are trigger levels for the states, which bind only with a loan; in DELEVERAGE the plan runs instead.
    let mut band_list: Vec<(f64, String, Band)> = Vec::new();
    if has_loan && st.action != Action::Deleverage {
        let legs = a
            .near
            .iter()
            .filter(|(t, &u)| u != 0.0 && find_token(t).is_some_and(|x| x.group.is_some()))
            .count()
            + a.perps.values().filter(|&&q| q != 0.0).count();
        let mut budget = bands::eval_budget(legs);
        for g in &groups {
            let (h50, h100) = bands::hl_bands(&eng, &a, m, g);
            let (im, mr) = bands::coin_equity_bands(&eng, &a, m, &rq, g, &mut budget);
            let mark = m.mark.get(g).copied().unwrap_or_else(|| m.price(g));
            let p = m.price(g);
            let b = Band {
                hl50: h50.map(|x| band_price(mark, x)),
                hl100: h100.map(|x| band_price(mark, x)),
                im: im.map(|x| band_price(p, x)),
                mr: mr.map(|x| band_price(p, x)),
                ..Band::default()
            };
            let near = [h50, h100, im, mr]
                .into_iter()
                .flatten()
                .map(f64::abs)
                .fold(f64::INFINITY, f64::min);
            if near.is_finite() {
                band_list.push((near, g.clone(), b));
            }
        }
        let tokens: Vec<&str> = a
            .near
            .iter()
            .filter(|(t, &u)| u != 0.0 && matches!(*t, "nBTC" | "WBTC" | "ETH.b" | "USDT"))
            .map(|(t, _)| t)
            .collect();
        for t in tokens {
            let found = bands::token_bands(&eng, &a, m, &rq, t, &mut budget);
            let pi = m.wrap_ratio(t);
            // π bands sit below today's π, so rounding up fires the trigger early.
            let pi_bp = |x: f64| (pi * (1.0 + x) * 1e4).ceil().max(0.0) as u64;
            let near = found
                .iter()
                .flatten()
                .map(|x| x.abs())
                .fold(f64::INFINITY, f64::min);
            if !near.is_finite() {
                continue;
            }
            let name = pool_name(t).to_string();
            // Coin ETH and token ETH share a key; their fields don't overlap.
            match band_list.iter_mut().find(|(_, n, _)| *n == name) {
                Some((d, _, b)) => {
                    *d = d.min(near);
                    b.im_bp = found[0].map(pi_bp);
                    b.mr_bp = found[1].map(pi_bp);
                    b.dl_bp = found[2].map(pi_bp);
                }
                None => band_list.push((
                    near,
                    name,
                    Band {
                        im_bp: found[0].map(pi_bp),
                        mr_bp: found[1].map(pi_bp),
                        dl_bp: found[2].map(pi_bp),
                        ..Band::default()
                    },
                )),
            }
        }
        // At most three entries: those nearest a band.
        band_list.sort_by(|x, y| x.0.total_cmp(&y.0).then(x.1.cmp(&y.1)));
        band_list.truncate(MAX_BAND_ENTRIES);
    }

    // What the pool's own limits read (12): bridged tokens' shares of collateral (frozen ones count 0), NEAR-side
    // holdings at market value, and the Hyperliquid equity.
    let collateral = e_allow + a.debt;
    let mut shares_bp = BTreeMap::new();
    let mut hold = BTreeMap::new();
    for (t, &u) in a.near.iter() {
        if u == 0.0 {
            continue;
        }
        if matches!(t, "nBTC" | "WBTC" | "ETH.b" | "USDT") {
            let v = if m.frozen.contains(t) {
                0.0
            } else {
                token_value_at(t, u, m, 0.0, 0.0, m.pi_allow(t))
            };
            let share = if collateral > 0.0 {
                bp(v / collateral).min(10_000)
            } else if v > 0.0 {
                10_000
            } else {
                0
            };
            shares_bp.insert(pool_name(t).to_string(), share);
        }
        if t != "USDC" {
            hold.insert(
                pool_name(t).to_string(),
                micro_down(token_value(t, u, m, 0.0, 0.0)).max(0) as u128,
            );
        }
    }
    let hl_eq = micro_down(eng.hl_equity_now(&a, m)).max(0) as u128;

    let since = match st.state {
        State::MarginCall | State::Deleverage if client.mc_since_ns > 0 => client.mc_since_ns,
        State::MarginCall | State::Deleverage => now_ns,
        State::Watch => client.mc_since_ns,
        State::Healthy => 0,
    };
    let volf = groups
        .iter()
        .map(|g| eng.vol_factor(m, g))
        .fold(1.0, f64::max);
    // The three biggest risks, then what the plan left out, then overdue transfers (INTERFACES.md 13 and 15).
    let mut top: Vec<String> = eng
        .top_risks(&rq, 3)
        .into_iter()
        .filter(|(_, loss)| *loss > 0.0)
        .map(|(name, _)| name)
        .collect();
    top.append(&mut wired.notes);
    if let Some(f) = &funded {
        top.push(f.note.clone());
    }
    for t in overdue.iter().take(MAX_OVERDUE_LINES) {
        top.push(format!("overdue: {} transfer {}", t.kind.as_str(), t.id));
    }
    if overdue.len() > MAX_OVERDUE_LINES {
        top.push(format!(
            "overdue: {} more transfers",
            overdue.len() - MAX_OVERDUE_LINES
        ));
    }
    // INTERFACES.md 50.2: an open send is named only when the ledger, read before the balances, shows a `send`
    // from the account's own address with its nonce. A ledger that wasn't read, or failed, names nothing.
    let sent = client.hl_address.as_deref().map_or_else(Vec::new, |address| {
        pb_read::hl::sent(&inp.hl.sent_ledger, address, &client.open_sends)
    });
    let mut verdict = Verdict {
        ok: true,
        v: VERDICT_V,
        model: MODEL.to_string(),
        params: params_hash(),
        acct: req.account.clone(),
        blk: inp.block.height,
        nonce: client.counter,
        eq: micro_down(rq.e),
        eq_allow: micro_down(e_allow),
        mm: micro_up(rq.mr),
        im: micro_up(rq.im),
        state: st.state.as_str().to_string(),
        action: action.as_str().to_string(),
        since,
        score,
        tier: tier.as_str().to_string(),
        rate_bp: bp(rate),
        allow: Allow {
            withdraw: allow_withdraw,
            borrow: borrow_micro,
            fund: funded.as_ref().map(|f| f.total_micro),
        },
        credit: Credit {
            line: whole_debt_micro.saturating_add(borrow_micro),
            binding,
        },
        volf_bp: bp(volf),
        top,
        topup: micro_up(topup),
        venues: Venues {
            hl_margin_ratio_bp: bp(st.hl_ratio),
        },
        pool: PoolPart {
            shares_bp,
            hold,
            hl_eq,
        },
        hr_bp,
        hr7_bp: hr7.round() as u64,
        exp_bp,
        bands: BTreeMap::new(),
        coins: Coins {
            uncertain: built.uncertain.into_iter().collect(),
            stale: Vec::new(),
            reduce_only: built.reduce_only.into_iter().collect(),
        },
        plan: wired.steps.clone(),
        arrived,
        sent,
        ext: lenders::ext(&lb, &rooms),
        fund: funded.map(|f| f.steps).unwrap_or_default(),
        evm: lb.evm_nonce.map(|nonce| Evm { nonce }),
        inputs: inp.hash(),
    };
    // If the verdict would pass its size, the farthest bands go first, then the last plan steps (a pair whole): a
    // band only saves the keeper a check, while a step is what the account acts on.
    let mut nearest_first: Vec<String> = Vec::new();
    for (_, name, b) in band_list {
        nearest_first.push(name.clone());
        verdict.bands.insert(name, b);
    }
    let size = |v: &Verdict| serde_json::to_string(v).map_or(usize::MAX, |s| s.len());
    while size(&verdict) > MAX_VERDICT_BYTES {
        match nearest_first.pop() {
            Some(farthest) => verdict.bands.remove(&farthest),
            None => break,
        };
    }
    // With lender fields, lines of words go next, the last first: `ext` and `fund` are what the account acts on, and
    // a top-up step matters more than the sentence about it.
    let has_lender_fields = !verdict.ext.is_empty() || !verdict.fund.is_empty();
    while has_lender_fields && size(&verdict) > MAX_VERDICT_BYTES && verdict.top.pop().is_some() {}
    while size(&verdict) > MAX_VERDICT_BYTES && wired.drop_last() {
        verdict.plan = wired.steps.clone();
    }
    Ok(verdict)
}
