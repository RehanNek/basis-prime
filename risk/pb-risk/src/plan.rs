//! INTERFACES.md 13: the verdict's plan. risk-core sizes the steps (`deleverage_steps`, `rebalance_steps`); this
//! module writes them as the step objects the account stores and the gateway places:
//! - a DELEVERAGE plan starts with `cancel` when the account has resting orders that add risk (8.4 step 1);
//! - a perp trade is a reduce-only IOC order: its size cut to the coin's size decimals, and its price half the coin's
//!   band past the reference price, rounded toward it, so it stays inside the band (P2). The band is the coin's, or
//!   the floor the run's network put under it when that is larger: 3% on testnet (INTERFACES.md 42);
//! - a sale, a move to Hyperliquid and a move home each need a 1Click quote: its deposit address and expiry;
//! - a pair is both of its legs or neither;
//! - at most 4 steps. The next verdict re-plans the rest (Appendix A);
//! - a lender's top-up (`l_add`, `l_repay`: FUNDING.md 6.5) goes before every other step;
//! - with lenders in the book, a sale, a move to Hyperliquid and a repayment spend only what is on NEAR itself.
//!
//! A step that can't be written is left out, and so is every later one, which assumed it ran; a `top` line says
//! why. The one exception is a perp trade under Hyperliquid's $10 minimum, which changes almost nothing.
use crate::verdict::MAX_PLAN_STEPS;
use pb_read::near::Config;
use pb_read::steps::{wire_price, wire_size, wire_value, PlanStep};
use pb_read::util::{micro_down, micro_exact, pow10, u64_of};
use risk_core::plan::{risky_orders, Plan, PlanEnd, Step, Trade, TradeKind};
use risk_core::pretrade::p2_band;
use risk_core::py::usd;
use risk_core::{Account, Action, Engine, Market};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Hyperliquid's minimum order, in USD of notional.
pub const MIN_ORDER_USD: f64 = 10.0;

/// A 1Click quote for one step: the deposit address, its expiry (unix ms), and the least it pays (micro-USDC).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Quote {
    pub dep: String,
    pub exp: u64,
    pub min: u64,
}

/// What a step asks 1Click to quote. Amounts as the step carries them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ask {
    /// `amt` units of token `tok`, for USDC paid to the account.
    Sell { tok: String, amt: String },
    /// `amt` micro-USDC from the NEAR account to its Hyperliquid address.
    ToHl { amt: u64 },
    /// `amt` micro-USDC of perp USDC to the NEAR account.
    Home { amt: u64 },
}

/// Where quotes come from. A run that can't reach 1Click answers why.
pub trait Quotes {
    fn quote(&mut self, ask: &Ask) -> Result<Quote, String>;
}

/// The quotes of a run that can't reach 1Click: on testnet, the stand-in runs where OutLayer can't call it.
pub struct NoQuotes;

impl Quotes for NoQuotes {
    fn quote(&mut self, _: &Ask) -> Result<Quote, String> {
        Err("1Click can't be reached from a testnet run".into())
    }
}

/// What the plan needs to know besides the engine's steps.
pub struct Ctx<'a> {
    pub engine: &'a Engine,
    pub market: &'a Market,
    /// The account before the plan.
    pub account: &'a Account,
    pub conf: &'a Config,
    /// Hyperliquid's market per coin, as the run read it (`HlReads::assets`): the size decimals.
    pub assets: &'a BTreeMap<String, Value>,
    /// Coins whose reference price is uncertain: their band is measured from Hyperliquid's mark (P10).
    pub uncertain: &'a BTreeSet<String>,
    /// The floor under P2's price band that the run's network gave (`Inputs::band_floor`, INTERFACES.md 42), so a
    /// perp step is priced inside the band the gateway will check it against. `None`: the parameter file's band.
    pub band_floor: Option<f64>,
}

/// The plan as step objects, how many objects each engine step became (to drop whole steps), and the `top` lines.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Wired {
    pub steps: Vec<PlanStep>,
    pub sizes: Vec<usize>,
    pub notes: Vec<String>,
}

impl Wired {
    /// Drops the last whole step (both legs of a pair). False if there was none.
    pub fn drop_last(&mut self) -> bool {
        match self.sizes.pop() {
            Some(n) => {
                let keep = self.steps.len().saturating_sub(n);
                self.steps.truncate(keep);
                true
            }
            None => false,
        }
    }

    fn push(&mut self, steps: Vec<PlanStep>) {
        self.sizes.push(steps.len());
        self.steps.extend(steps);
    }

    /// A plan that starts with these steps, each one whole by itself, and these `top` lines: a lender's top-up
    /// (FUNDING.md 6.5), which goes before every other step.
    pub fn starting_with(steps: Vec<PlanStep>, notes: Vec<String>) -> Wired {
        let mut w = Wired {
            notes,
            ..Wired::default()
        };
        for s in steps.into_iter().take(MAX_PLAN_STEPS) {
            w.push(vec![s]);
        }
        w
    }
}

/// What the account holds on NEAR itself, per engine token, in units (FUNDING.md 6.2). The book also counts what is
/// posted at a lender or sits at the account's Ethereum address, and no `sell`, `to_hl` or `repay` step may spend
/// that from NEAR.
pub type OnNear = BTreeMap<String, f64>;

/// The engine's step, cut to what is on NEAR, and whether it was cut. `None` when nothing of it is left, or when it
/// is a pair whose sale can't run whole. A sale's proceeds and money brought home count as on NEAR for later steps.
fn on_near(step: &Step, free: &mut OnNear) -> (Option<Step>, bool) {
    // A cent of slack: the engine's amounts are floats.
    const SLACK: f64 = 1e-6;
    let mut take = |token: &str, want: f64| -> f64 {
        let have = free.get(token).copied().unwrap_or(0.0).max(0.0);
        let got = if want <= have + SLACK { want } else { have };
        free.insert(token.to_string(), (have - got).max(0.0));
        got
    };
    match step {
        Step::Repay { usd: x } => {
            let got = take("USDC", *x);
            ((got > 0.0).then_some(Step::Repay { usd: got }), got < *x)
        }
        Step::ToHl { usd: x } => {
            let got = take("USDC", *x);
            ((got > 0.0).then_some(Step::ToHl { usd: got }), got < *x)
        }
        Step::Home { usd: x } => {
            *free.entry("USDC".to_string()).or_insert(0.0) += *x;
            (Some(step.clone()), false)
        }
        Step::Swap {
            token,
            units,
            usd: x,
        } => {
            let got = take(token, *units);
            if got <= 0.0 {
                return (None, true);
            }
            let paid = x * got / units;
            *free.entry("USDC".to_string()).or_insert(0.0) += paid;
            (
                Some(Step::Swap {
                    token: token.clone(),
                    units: got,
                    usd: paid,
                }),
                got < *units,
            )
        }
        Step::Trade(t) => {
            let Some(token) = t.token.as_deref().filter(|_| t.kind != TradeKind::Perp) else {
                return (Some(step.clone()), false);
            };
            let got = take(token, t.units);
            if got < t.units && (t.kind == TradeKind::Pair || got <= 0.0) {
                return (None, true);
            }
            let share = if t.units > 0.0 { got / t.units } else { 0.0 };
            *free.entry("USDC".to_string()).or_insert(0.0) += (t.traded - t.cost) * share;
            if got < t.units {
                let cut = Trade {
                    units: got,
                    traded: t.traded * share,
                    cost: t.cost * share,
                    ..t.clone()
                };
                (Some(Step::Trade(cut)), true)
            } else {
                (Some(step.clone()), false)
            }
        }
    }
}

/// The `top` line when a step would have spent what isn't on NEAR.
pub const NOT_ON_NEAR: &str =
    "plan: the next steps were cut: the rest of what they would spend is at a lender or on Ethereum, not on NEAR";

/// Why a step was left out.
enum Out {
    /// The step and every later one.
    Stop(String),
    /// Only this step (a perp trade under the minimum).
    Skip(String),
}

/// The perp leg of a trade: a reduce-only IOC order of `dq` (positive buys) on a position of `q`. A perp trade under
/// $10 is raised to Hyperliquid's minimum when the position allows (`raise`); a pair's leg never is, since its sale
/// would then not match it.
fn perp_leg(ctx: &Ctx, coin: &str, dq: f64, q: f64, raise: bool) -> Result<PlanStep, Out> {
    let m = ctx.market;
    let not_listed = || {
        Out::Stop(format!(
            "plan: a {coin} trade was left out: Hyperliquid's market has no size decimals for it"
        ))
    };
    let sz_decimals = ctx
        .assets
        .get(coin)
        .and_then(|a| a.pointer("/meta/szDecimals"))
        .and_then(u64_of)
        .ok_or_else(not_listed)? as u32;
    let buy = dq > 0.0;
    // P2's band is around the reference price, or Hyperliquid's mark while the reference is uncertain (P10).
    let reference = if ctx.uncertain.contains(coin) {
        m.mark.get(coin).copied()
    } else {
        m.px.get(coin).copied()
    }
    .ok_or_else(not_listed)?;
    let band = p2_band(ctx.engine.coin(coin).params.price_band, ctx.band_floor);
    let raw = if buy {
        reference * (1.0 + band / 2.0)
    } else {
        reference * (1.0 - band / 2.0)
    };
    let px = wire_price(raw, sz_decimals, buy).ok_or_else(not_listed)?;
    let px_value = wire_value(&px).unwrap_or(raw);
    let dust = || {
        Out::Skip(format!(
            "plan: a {coin} trade under Hyperliquid's $10 minimum was left out"
        ))
    };
    let mut units = (dq.abs() * pow10(sz_decimals) * (1.0 + 1e-12)).floor();
    let held = (q.abs() * pow10(sz_decimals) * (1.0 + 1e-12)).floor();
    if units * px_value / pow10(sz_decimals) < MIN_ORDER_USD {
        // The smallest order Hyperliquid takes, if the position is that big.
        units = (MIN_ORDER_USD / px_value * pow10(sz_decimals)).ceil();
        if !raise || units > held {
            return Err(dust());
        }
    }
    let sz = wire_size(units / pow10(sz_decimals), sz_decimals).ok_or_else(dust)?;
    Ok(PlanStep::Perp {
        coin: coin.to_string(),
        buy,
        sz,
        px,
    })
}

/// The sale of `units` of engine token `token`, with its quote.
fn sell_leg(ctx: &Ctx, quotes: &mut dyn Quotes, token: &str, units: f64) -> Result<PlanStep, Out> {
    let t = ctx.conf.tokens.iter().find(|t| t.engine == token).ok_or_else(|| {
        Out::Stop(format!("plan: selling {token} was left out: the account doesn't hold it as a configured token"))
    })?;
    let raw = (units * pow10(t.decimals) * (1.0 + 1e-12)).floor();
    if raw < 1.0 {
        return Err(Out::Skip(format!(
            "plan: selling dust of {} was left out",
            t.name
        )));
    }
    let amt = format!("{}", raw as u128);
    let ask = Ask::Sell {
        tok: t.id.clone(),
        amt: amt.clone(),
    };
    let q = quotes
        .quote(&ask)
        .map_err(|why| Out::Stop(format!("plan: selling {} was left out: {why}", t.name)))?;
    Ok(PlanStep::Sell {
        tok: t.id.clone(),
        amt,
        min: q.min,
        dep: q.dep,
        exp: q.exp,
    })
}

/// One engine step as step objects.
fn wire_step(
    ctx: &Ctx,
    quotes: &mut dyn Quotes,
    step: &Step,
    positions: &mut BTreeMap<String, f64>,
) -> Result<Vec<PlanStep>, Out> {
    let moved = |what: &str, why: String| Out::Stop(format!("plan: {what} was left out: {why}"));
    match step {
        Step::Repay { usd: x } => {
            let amt = micro_exact(*x).max(0) as u64;
            Ok(if amt > 0 {
                vec![PlanStep::Repay { amt }]
            } else {
                Vec::new()
            })
        }
        Step::ToHl { usd: x } => {
            let amt = micro_down(*x).max(0) as u64;
            let q = quotes
                .quote(&Ask::ToHl { amt })
                .map_err(|why| moved(&format!("moving {} to Hyperliquid", usd(*x)), why))?;
            Ok(vec![PlanStep::ToHl {
                amt,
                dep: q.dep,
                exp: q.exp,
            }])
        }
        Step::Home { usd: x } => {
            let amt = micro_down(*x).max(0) as u64;
            let q = quotes
                .quote(&Ask::Home { amt })
                .map_err(|why| moved(&format!("bringing {} home", usd(*x)), why))?;
            Ok(vec![PlanStep::Home {
                amt,
                dep: q.dep,
                exp: q.exp,
            }])
        }
        Step::Swap { token, units, .. } => Ok(vec![sell_leg(ctx, quotes, token, *units)?]),
        Step::Trade(t) => trade(ctx, quotes, t, positions),
    }
}

fn trade(
    ctx: &Ctx,
    quotes: &mut dyn Quotes,
    t: &Trade,
    positions: &mut BTreeMap<String, f64>,
) -> Result<Vec<PlanStep>, Out> {
    let q = positions.get(&t.group).copied().unwrap_or(0.0);
    let mut out = Vec::new();
    if t.kind != TradeKind::Near {
        match perp_leg(ctx, &t.group, t.dq, q, t.kind == TradeKind::Perp) {
            Ok(leg) => out.push(leg),
            // A pair goes with both legs or not at all.
            Err(Out::Skip(why)) if t.kind == TradeKind::Pair => return Err(Out::Stop(why)),
            Err(e) => return Err(e),
        }
    }
    if t.kind != TradeKind::Perp {
        let token = t.token.as_deref().unwrap_or("");
        match sell_leg(ctx, quotes, token, t.units) {
            Ok(leg) => out.push(leg),
            Err(Out::Skip(why)) | Err(Out::Stop(why)) if t.kind == TradeKind::Pair => {
                return Err(Out::Stop(why))
            }
            Err(e) => return Err(e),
        }
    }
    positions.insert(t.group.clone(), q + t.dq);
    Ok(out)
}

/// The plan for `action` as step objects, with the `top` lines for what was left out.
pub fn wire(ctx: &Ctx, quotes: &mut dyn Quotes, action: Action, plan: &Plan) -> Wired {
    wire_with(ctx, quotes, action, plan, Wired::default(), None)
}

/// [`wire`], after the steps `first` already holds (a lender's top-up), and with every `sell`, `to_hl` and `repay`
/// cut to what the account holds on NEAR itself when `on_near_only` says what that is. A step that had to be cut
/// is the plan's last: the later ones assumed it ran whole.
pub fn wire_with(
    ctx: &Ctx,
    quotes: &mut dyn Quotes,
    action: Action,
    plan: &Plan,
    first: Wired,
    mut on_near_only: Option<OnNear>,
) -> Wired {
    let mut w = first;
    if action == Action::Deleverage && !risky_orders(ctx.account).is_empty() {
        w.push(vec![PlanStep::Cancel {}]);
    }
    let mut positions: BTreeMap<String, f64> = ctx
        .account
        .perps
        .iter()
        .map(|(c, &q)| (c.to_string(), q))
        .collect();
    let mut stopped = false;
    for step in &plan.steps {
        let mut cut = false;
        let kept;
        let step = match on_near_only.as_mut() {
            Some(free) => {
                let (left, was_cut) = on_near(step, free);
                cut = was_cut;
                match left {
                    Some(s) => {
                        kept = s;
                        &kept
                    }
                    None => {
                        w.notes.push(NOT_ON_NEAR.to_string());
                        stopped = true;
                        break;
                    }
                }
            }
            None => step,
        };
        if cut {
            w.notes.push(NOT_ON_NEAR.to_string());
        }
        match wire_step(ctx, quotes, step, &mut positions) {
            Ok(objs) if cut => {
                if !objs.is_empty() && w.steps.len() + objs.len() <= MAX_PLAN_STEPS {
                    w.push(objs);
                }
                stopped = true;
                break;
            }
            Ok(objs) if objs.is_empty() => {}
            Ok(objs) => {
                if w.steps.len() + objs.len() > MAX_PLAN_STEPS {
                    stopped = true;
                    break;
                }
                w.push(objs);
            }
            Err(Out::Skip(why)) => {
                w.notes.push(why);
                if cut {
                    stopped = true;
                    break;
                }
            }
            Err(Out::Stop(why)) => {
                w.notes.push(why);
                stopped = true;
                break;
            }
        }
    }
    if !stopped && plan.end == PlanEnd::NeedsOneClick {
        w.notes.push(match action {
            Action::Rebalance | Action::RebalanceNow => format!(
                "plan: moving {} to Hyperliquid needs 1Click, which a testnet run can't reach",
                usd(plan.short_usd)
            ),
            _ => "plan: the next steps need 1Click, which a testnet run can't reach".to_string(),
        });
    }
    if !stopped
        && plan.end == PlanEnd::NothingLeft
        && matches!(action, Action::Rebalance | Action::RebalanceNow)
        && plan.short_usd > 0.0
    {
        w.notes.push(format!(
            "plan: Hyperliquid still needs {} that nothing in the account can cover",
            usd(plan.short_usd)
        ));
    }
    w
}

#[cfg(test)]
mod tests {
    use super::*;
    use risk_core::plan::Routes;
    use risk_core::OrderedMap;
    use serde_json::json;

    /// Quotes as 1Click would give them, numbered, or a refusal for asks that match `refuse`.
    struct Fake {
        asked: Vec<Ask>,
        refuse: fn(&Ask) -> bool,
    }

    impl Quotes for Fake {
        fn quote(&mut self, ask: &Ask) -> Result<Quote, String> {
            self.asked.push(ask.clone());
            if (self.refuse)(ask) {
                return Err("1Click has no route".into());
            }
            Ok(Quote {
                dep: format!("dep{}", self.asked.len()),
                exp: 1_794_000_000_000,
                min: 1_000_000,
            })
        }
    }

    fn fake() -> Fake {
        Fake {
            asked: Vec::new(),
            refuse: |_| false,
        }
    }

    fn conf() -> Config {
        pb_read::near::config(&json!({"pool_id": "pool.pbf.testnet", "tokens": [
            {"id": "musdc.pbf-ops.testnet", "symbol": "USDC", "decimals": 6},
            {"id": "mnbtc.pbf-ops.testnet", "symbol": "nBTC", "decimals": 8},
            {"id": "eth.bridge.testnet", "symbol": "ETH", "decimals": 18}]}))
        .unwrap()
    }

    fn assets() -> BTreeMap<String, Value> {
        [
            (
                "BTC".to_string(),
                json!({"meta": {"szDecimals": 5}, "index": 3}),
            ),
            (
                "ETH".to_string(),
                json!({"meta": {"szDecimals": 4}, "index": 4}),
            ),
        ]
        .into()
    }

    fn map(pairs: &[(&str, f64)]) -> OrderedMap<f64> {
        pairs.iter().map(|&(k, v)| (k, v)).collect()
    }

    /// RISK_ENGINE.md 14.2's exact ETH hedge that must deleverage: the reference unwinds the pair.
    fn eth_hedge() -> (Engine, Account, Market) {
        let eng = Engine::v0();
        let m = eng.calm_market();
        let px = m.price("ETH");
        let a = Account {
            near: map(&[("ETH.b", 200.0)]),
            hl_cash: 120_000.0,
            perps: map(&[("ETH", -200.0)]),
            entry: map(&[("ETH", px)]),
            debt: 450_000.0,
            ..Account::default()
        };
        (eng, a, m)
    }

    fn wired(
        eng: &Engine,
        a: &Account,
        m: &Market,
        quotes: &mut dyn Quotes,
        action: Action,
        plan: &Plan,
    ) -> Wired {
        let (conf, assets, none) = (conf(), assets(), BTreeSet::new());
        let ctx = Ctx {
            engine: eng,
            market: m,
            account: a,
            conf: &conf,
            assets: &assets,
            uncertain: &none,
            band_floor: None,
        };
        wire(&ctx, quotes, action, plan)
    }

    #[test]
    fn a_pair_is_a_perp_and_a_sale_with_its_quote() {
        let (eng, a, m) = eth_hedge();
        let plan = eng.deleverage_steps(&a, &m, 4, Routes::ALL);
        let mut q = fake();
        let w = wired(&eng, &a, &m, &mut q, Action::Deleverage, &plan);
        // The first pair: buy back 21.59 ETH and sell 21.59 ETH.b, then repay with what it pays, then the next pair
        // would make 5 steps, so it waits for the next verdict.
        let PlanStep::Perp { coin, buy, sz, px } = &w.steps[0] else {
            panic!("{w:?}")
        };
        assert_eq!((coin.as_str(), *buy), ("ETH", true));
        let Step::Trade(t) = &plan.steps[0] else {
            panic!()
        };
        assert_eq!(sz, &pb_read::steps::wire_size(t.dq, 4).unwrap());
        let reference = m.price("ETH");
        assert_eq!(
            px.parse::<f64>().unwrap(),
            (reference * 1.005 * 10.0).floor() / 10.0
        );
        assert_eq!(
            w.steps[1],
            PlanStep::Sell {
                tok: "eth.bridge.testnet".into(),
                amt: format!("{}", (t.units * 1e18 * (1.0 + 1e-12)).floor() as u128),
                min: 1_000_000,
                dep: "dep1".into(),
                exp: 1_794_000_000_000
            }
        );
        assert!(matches!(w.steps[2], PlanStep::Repay { .. }));
        assert_eq!((w.steps.len(), w.sizes.clone()), (3, vec![2, 1]));
        assert!(w.notes.is_empty());
        // Every step under 200 bytes.
        for s in &w.steps {
            assert!(serde_json::to_string(s).unwrap().len() < 200, "{s:?}");
        }
        // Dropping the last whole step never splits the pair.
        let mut d = w.clone();
        assert!(d.drop_last() && d.drop_last());
        assert!(d.steps.is_empty() && !d.drop_last());
    }

    #[test]
    fn without_a_quote_the_pair_is_left_out_and_top_says_why() {
        let (eng, a, m) = eth_hedge();
        let plan = eng.deleverage_steps(&a, &m, 4, Routes::ALL);
        let mut q = Fake {
            asked: Vec::new(),
            refuse: |a| matches!(a, Ask::Sell { .. }),
        };
        let w = wired(&eng, &a, &m, &mut q, Action::Deleverage, &plan);
        assert!(w.steps.is_empty(), "{w:?}");
        assert_eq!(
            w.notes,
            ["plan: selling ETH was left out: 1Click has no route"]
        );
        // On testnet nothing is asked: the engine plans no sale, and the plan says the rest needs 1Click.
        let plan = eng.deleverage_steps(&a, &m, 4, Routes::NO_ONE_CLICK);
        let w = wired(&eng, &a, &m, &mut NoQuotes, Action::Deleverage, &plan);
        assert!(w.steps.is_empty());
        assert_eq!(
            w.notes,
            ["plan: the next steps need 1Click, which a testnet run can't reach"]
        );
    }

    #[test]
    fn moves_carry_their_quotes() {
        // Cash on Hyperliquid and no perps: it comes home, then repays.
        let eng = Engine::v0();
        let m = eng.calm_market();
        let cash = Account {
            hl_cash: 8_000.0,
            debt: 30_000.0,
            ..Account::default()
        };
        let plan = eng.deleverage_steps(&cash, &m, 4, Routes::ALL);
        let mut q = fake();
        let w = wired(&eng, &cash, &m, &mut q, Action::Deleverage, &plan);
        assert_eq!(
            w.steps[..2],
            [
                PlanStep::Home {
                    amt: 8_000_000_000,
                    dep: "dep1".into(),
                    exp: 1_794_000_000_000
                },
                PlanStep::Repay { amt: 7_999_800_000 }
            ]
        );
        assert_eq!(q.asked[0], Ask::Home { amt: 8_000_000_000 });
        // A rebalance moves USDC to Hyperliquid.
        let p = m.price("BTC");
        let q0 = 25_000.0 / p;
        let thin = Account {
            near: map(&[("nBTC", q0), ("USDC", 5_000.0)]),
            hl_cash: 500.0,
            perps: map(&[("BTC", -q0)]),
            entry: map(&[("BTC", p)]),
            debt: 10_000.0,
            ..Account::default()
        };
        let plan = eng.rebalance_steps(&thin, &m, 4, Routes::ALL);
        let mut q = fake();
        let w = wired(&eng, &thin, &m, &mut q, Action::Rebalance, &plan);
        let Step::ToHl { usd } = plan.steps[0] else {
            panic!()
        };
        assert_eq!(
            w.steps,
            [PlanStep::ToHl {
                amt: micro_down(usd) as u64,
                dep: "dep1".into(),
                exp: 1_794_000_000_000
            }]
        );
        // On testnet the same rebalance has no step, and says how much it would move.
        let plan = eng.rebalance_steps(&thin, &m, 4, Routes::NO_ONE_CLICK);
        let w = wired(&eng, &thin, &m, &mut NoQuotes, Action::Rebalance, &plan);
        assert!(w.steps.is_empty());
        assert!(w.notes[0].starts_with("plan: moving $"), "{:?}", w.notes);
    }

    #[test]
    fn small_perp_trades_meet_hyperliquids_minimum_or_are_left_out() {
        let eng = Engine::v0();
        let m = eng.calm_market();
        let p = m.price("BTC");
        let trade = |dq: f64| {
            Step::Trade(Trade {
                kind: TradeKind::Perp,
                group: "BTC".into(),
                dq,
                token: None,
                units: 0.0,
                traded: dq.abs() * p,
                cost: 0.0,
                mr: Some((1.0, 0.5)),
            })
        };
        let plan_of = |steps: Vec<Step>, a: &Account| Plan {
            steps,
            after: a.clone(),
            end: PlanEnd::Done,
            short_usd: 0.0,
        };
        // $5 of a $40 short is raised to the $10 minimum (0.00013 BTC at about $78.7k).
        let small = Account {
            perps: map(&[("BTC", -0.0005)]),
            ..Account::default()
        };
        let w = wired(
            &eng,
            &small,
            &m,
            &mut NoQuotes,
            Action::Deleverage,
            &plan_of(vec![trade(5.0 / p)], &small),
        );
        let PlanStep::Perp { sz, px, .. } = &w.steps[0] else {
            panic!("{w:?}")
        };
        assert!(
            sz.parse::<f64>().unwrap() * px.parse::<f64>().unwrap() >= 10.0,
            "{sz} {px}"
        );
        assert_eq!(sz, "0.00013");
        // A position under $10 can't be traded at all: left out, with a line, and the plan goes on.
        let dust = Account {
            perps: map(&[("BTC", -0.0001)]),
            ..Account::default()
        };
        let plan = plan_of(vec![trade(0.00005), Step::Repay { usd: 3.0 }], &dust);
        let w = wired(&eng, &dust, &m, &mut NoQuotes, Action::Deleverage, &plan);
        assert_eq!(w.steps, [PlanStep::Repay { amt: 3_000_000 }]);
        assert_eq!(
            w.notes,
            ["plan: a BTC trade under Hyperliquid's $10 minimum was left out"]
        );
        // A resting order that adds risk puts a cancel first.
        let mut risky = small.clone();
        risky.orders.push(risk_core::Order {
            coin: "BTC".into(),
            size: -0.001,
            limit_px: p * 1.01,
            reduce_only: false,
        });
        let w = wired(
            &eng,
            &risky,
            &m,
            &mut NoQuotes,
            Action::Deleverage,
            &plan_of(vec![trade(5.0 / p)], &risky),
        );
        assert_eq!(w.steps[0], PlanStep::Cancel {});
        // At most 4 steps: the fifth waits for the next verdict.
        let many = plan_of(
            vec![trade(0.0001); 6],
            &Account {
                perps: map(&[("BTC", -1.0)]),
                ..Account::default()
            },
        );
        let w = wired(
            &eng,
            &many.after,
            &m,
            &mut NoQuotes,
            Action::Deleverage,
            &many,
        );
        assert_eq!(w.steps.len(), 4);
    }

    #[test]
    fn an_uncertain_reference_price_sets_the_band_from_the_mark() {
        let eng = Engine::v0();
        let mut m = eng.calm_market();
        m.mark.insert("BTC".into(), 70_000.0);
        let a = Account {
            perps: map(&[("BTC", -0.1)]),
            ..Account::default()
        };
        let plan = Plan {
            steps: vec![Step::Trade(Trade {
                kind: TradeKind::Perp,
                group: "BTC".into(),
                dq: 0.025,
                token: None,
                units: 0.0,
                traded: 0.0,
                cost: 0.0,
                mr: None,
            })],
            after: a.clone(),
            end: PlanEnd::Done,
            short_usd: 0.0,
        };
        let (conf, assets) = (conf(), assets());
        let uncertain: BTreeSet<String> = ["BTC".to_string()].into();
        let ctx = Ctx {
            engine: &eng,
            market: &m,
            account: &a,
            conf: &conf,
            assets: &assets,
            uncertain: &uncertain,
            band_floor: None,
        };
        let w = wire(&ctx, &mut NoQuotes, Action::Deleverage, &plan);
        assert_eq!(
            w.steps,
            [PlanStep::Perp {
                coin: "BTC".into(),
                buy: true,
                sz: "0.025".into(),
                px: "70350".into()
            }]
        );
    }

    #[test]
    fn a_floor_under_the_band_prices_a_perp_step_half_the_larger_band_from_the_reference() {
        // INTERFACES.md 42: on testnet the band is 3% for every coin, so a step is priced 1.5% from the reference
        // (or from the mark while the reference is uncertain), still rounded toward it.
        let eng = Engine::v0();
        let mut m = eng.calm_market();
        m.mark.insert("BTC".into(), 70_000.0);
        let reference = m.price("BTC");
        let (conf, assets) = (conf(), assets());
        let px_of = |q: f64, dq: f64, uncertain: bool, band_floor: Option<f64>| {
            let a = Account {
                perps: map(&[("BTC", q)]),
                ..Account::default()
            };
            let plan = Plan {
                steps: vec![Step::Trade(Trade {
                    kind: TradeKind::Perp,
                    group: "BTC".into(),
                    dq,
                    token: None,
                    units: 0.0,
                    traded: 0.0,
                    cost: 0.0,
                    mr: None,
                })],
                after: a.clone(),
                end: PlanEnd::Done,
                short_usd: 0.0,
            };
            let uncertain: BTreeSet<String> = if uncertain {
                ["BTC".to_string()].into()
            } else {
                BTreeSet::new()
            };
            let ctx = Ctx {
                engine: &eng,
                market: &m,
                account: &a,
                conf: &conf,
                assets: &assets,
                uncertain: &uncertain,
                band_floor,
            };
            let w = wire(&ctx, &mut NoQuotes, Action::Deleverage, &plan);
            let [PlanStep::Perp { buy, px, .. }] = &w.steps[..] else {
                panic!("{w:?}")
            };
            assert_eq!(*buy, dq > 0.0);
            px.parse::<f64>().unwrap()
        };
        // No floor: half BTC's own 1%, as before.
        assert_eq!(px_of(-0.1, 0.025, false, None), (reference * 1.005).floor());
        assert_eq!(px_of(0.1, -0.025, false, None), (reference * 0.995).ceil());
        // Testnet's 3%: 1.5% over the reference for a buy and 1.5% under it for a sale.
        let testnet = Some(pb_read::request::TESTNET.price_band_floor);
        assert_eq!(testnet, Some(0.03));
        assert_eq!(px_of(-0.1, 0.025, false, testnet), (reference * 1.015).floor());
        assert_eq!(px_of(0.1, -0.025, false, testnet), (reference * 0.985).ceil());
        // From the mark while the reference is uncertain: $70,000 and 1.5%.
        assert_eq!(px_of(-0.1, 0.025, true, testnet), 71_050.0);
        // A floor under the coin's own band changes nothing.
        assert_eq!(px_of(-0.1, 0.025, false, Some(0.005)), (reference * 1.005).floor());
    }

    /// [`wired`], with a lender's top-up first and only `free` on NEAR.
    fn wired_on_near(
        eng: &Engine,
        a: &Account,
        m: &Market,
        quotes: &mut dyn Quotes,
        plan: &Plan,
        first: Wired,
        free: &[(&str, f64)],
    ) -> Wired {
        let (conf, assets, none) = (conf(), assets(), BTreeSet::new());
        let ctx = Ctx {
            engine: eng,
            market: m,
            account: a,
            conf: &conf,
            assets: &assets,
            uncertain: &none,
            band_floor: None,
        };
        let free: OnNear = free.iter().map(|&(t, u)| (t.to_string(), u)).collect();
        wire_with(&ctx, quotes, Action::Deleverage, plan, first, Some(free))
    }

    #[test]
    fn steps_never_spend_what_is_at_a_lender_or_on_ethereum() {
        let (eng, a, m) = eth_hedge();
        let plan = eng.deleverage_steps(&a, &m, 4, Routes::ALL);
        let whole = wired(&eng, &a, &m, &mut fake(), Action::Deleverage, &plan);
        // Everything on NEAR: the plan is what it always was. The repayment spends what the sale pays.
        let same = wired_on_near(
            &eng,
            &a,
            &m,
            &mut fake(),
            &plan,
            Wired::default(),
            &[("ETH.b", 200.0)],
        );
        assert_eq!(same, whole);
        // Only 5 of the 200 ETH.b are on NEAR, the rest posted at a lender: the pair can't run whole, so it is
        // left out with everything after it, and `top` says why.
        let mut q = fake();
        let cut = wired_on_near(
            &eng,
            &a,
            &m,
            &mut q,
            &plan,
            Wired::default(),
            &[("ETH.b", 5.0)],
        );
        assert!(cut.steps.is_empty(), "{cut:?}");
        assert_eq!(cut.notes, [NOT_ON_NEAR]);
        assert!(q.asked.is_empty());
        // A repayment is cut to the USDC on NEAR: $400 of the $1,000 the book counts, the rest on Ethereum.
        let cash = Account {
            near: map(&[("USDC", 1_000.0)]),
            debt: 30_000.0,
            ..Account::default()
        };
        let plan = eng.deleverage_steps(&cash, &m, 4, Routes::ALL);
        let all = wired(&eng, &cash, &m, &mut fake(), Action::Deleverage, &plan);
        assert_eq!(all.steps, [PlanStep::Repay { amt: 1_000_000_000 }]);
        let some = wired_on_near(
            &eng,
            &cash,
            &m,
            &mut fake(),
            &plan,
            Wired::default(),
            &[("USDC", 400.0)],
        );
        assert_eq!(some.steps, [PlanStep::Repay { amt: 400_000_000 }]);
        assert_eq!(some.notes, [NOT_ON_NEAR]);
        let none = wired_on_near(&eng, &cash, &m, &mut fake(), &plan, Wired::default(), &[]);
        assert!(none.steps.is_empty());
        assert_eq!(none.notes, [NOT_ON_NEAR]);
    }

    #[test]
    fn a_lenders_top_up_goes_first_and_the_plan_still_has_four_steps() {
        let (eng, a, m) = eth_hedge();
        let plan = eng.deleverage_steps(&a, &m, 4, Routes::ALL);
        let top_up = vec![
            PlanStep::LAdd {
                l: "rhea".into(),
                tok: "mnbtc.pbf-ops.testnet".into(),
                amt: "1000".into(),
            },
            PlanStep::LRepay {
                l: "rhea".into(),
                amt: 5_000_000,
            },
        ];
        let first = Wired::starting_with(
            top_up.clone(),
            vec!["rhea: cushion 1.27 is under 1.35".into()],
        );
        let w = wired_on_near(&eng, &a, &m, &mut fake(), &plan, first, &[("ETH.b", 200.0)]);
        // The two top-up steps, then the pair (2 steps). The repayment would be a fifth, so it waits.
        assert_eq!(w.steps[..2], top_up[..]);
        assert_eq!((w.steps.len(), w.sizes.clone()), (4, vec![1, 1, 2]));
        assert_eq!(w.notes[0], "rhea: cushion 1.27 is under 1.35");
        // More top-up steps than a plan holds are cut to four.
        let many = vec![
            PlanStep::LRepay {
                l: "aave".into(),
                amt: 1
            };
            6
        ];
        assert_eq!(
            Wired::starting_with(many, Vec::new()).steps.len(),
            MAX_PLAN_STEPS
        );
    }
}
