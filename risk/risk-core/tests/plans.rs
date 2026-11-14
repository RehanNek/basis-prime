//! Phase 4's plans (RISK_ENGINE.md 8.2 and 8.4, INTERFACES.md 13): the testnet demo book's drill against the
//! Python reference, the plan without 1Click, the rebalance plan and the resting orders that add risk.
//!
//! The drill's expected values come from `risk_engine_ref.py` on the same book (run on 8 Nov: BTC at $75,800 with
//! testnet's margin table, 428.6 USDC of margin, a $1,096.805 loan), so these tests are plan parity with the
//! reference for the book the live drill uses.
use risk_core::hl::Tier;
use risk_core::plan::{risky_orders, PlanEnd, Routes, Step, TradeKind, ONE_CLICK_FEE};
use risk_core::states::{band, BAND_STEP};
use risk_core::*;

fn map(pairs: &[(&str, f64)]) -> OrderedMap<f64> {
    pairs.iter().map(|&(k, v)| (k, v)).collect()
}

/// The testnet demo book (PLAN.md 2) on a calm market at $75,800, with testnet's BTC margin table.
fn small_book() -> (Engine, Account, Market) {
    let mut eng = Engine::v0();
    for c in eng.coins.iter_mut().filter(|c| c.name == "BTC") {
        c.margin_tiers = vec![
            Tier {
                lower_bound: 0.0,
                max_leverage: 40,
            },
            Tier {
                lower_bound: 10_000.0,
                max_leverage: 25,
            },
            Tier {
                lower_bound: 50_000.0,
                max_leverage: 10,
            },
        ];
    }
    let px = 75_800.0;
    let debt = 1_096.805;
    let mut m = eng.calm_market();
    m.px.insert("BTC".into(), px);
    m.mark.insert("BTC".into(), px);
    m.twap.insert("BTC".into(), px);
    m.pool_capital = 10_000_000.0;
    m.pool_loans = debt;
    m.util = debt / 10_000_000.0;
    let a = Account {
        near: map(&[("USDC", 10.0), ("nBTC", 0.015)]),
        hl_cash: 428.6,
        perps: map(&[("BTC", -0.015)]),
        entry: map(&[("BTC", px)]),
        debt,
        ..Account::default()
    };
    (eng, a, m)
}

fn at(m: &Market, ratio: f64) -> Market {
    let mut m = m.clone();
    m.wrap.insert("nBTC".into(), ratio);
    m
}

#[test]
fn the_drill_book_walks_down_the_states_as_the_reference_does() {
    let (eng, a, m) = small_book();
    // (ratio, E, MR, IM, state), from the reference.
    let rows = [
        (
            1.0,
            478.79499999999985,
            201.93173299239157,
            252.41466624048945,
            State::Healthy,
        ),
        (
            0.83,
            285.5049999999999,
            240.4897294585681,
            300.6121618232101,
            State::Watch,
        ),
        (
            0.78,
            228.65499999999997,
            251.83314423214944,
            314.7914302901868,
            State::MarginCall,
        ),
        (
            0.75,
            194.54499999999985,
            258.6398412818551,
            323.2998016023189,
            State::Deleverage,
        ),
    ];
    for (ratio, e, mr, im, state) in rows {
        let mm = at(&m, ratio);
        let r = eng.requirement(&a, &mm);
        assert_eq!((r.e, r.mr, r.im), (e, mr, im), "{ratio}");
        assert_eq!(eng.state(&a, &mm, &r, 0.0, None).state, state, "{ratio}");
    }
    // The bands: the ratios where equity reaches IM, MR and 0.8 × MR, with MR re-evaluated at every point.
    let wrap_band = |k: f64| {
        let f = |x: f64| {
            let r = eng.requirement(&a, &at(&m, 1.0 + x));
            r.e - k * r.mr
        };
        1.0 + band(f, 0.0, -0.99, 0.0, BAND_STEP).unwrap()
    };
    assert_eq!(wrap_band(1.25), 0.8406346128594364);
    assert_eq!(wrap_band(1.0), 0.796994305331203);
    assert_eq!(wrap_band(0.8), 0.7593793847469279);
    // Margin that removes the 13 Mar 2020 rebound's liquidation from the top risks.
    assert_eq!(eng.topup(&a, &m), 98.0);
}

#[test]
fn the_drill_plan_buys_back_a_quarter_of_the_short() {
    let (eng, a, m) = small_book();
    let mm = at(&m, 0.75);
    let (text, after) = eng.deleverage_plan(&a, &mm, 40);
    assert_eq!(
        text,
        [
            "repay $10 from USDC in the NEAR account",
            "perp BTC: trade $284, cost $0, MR $259 -> $91"
        ]
    );
    assert_eq!(after.perps["BTC"], -0.01125);
    assert_eq!(after.hl_cash, 428.46579610467234);
    assert_eq!(after.debt, 1086.805);
    let r = eng.requirement(&after, &mm);
    assert_eq!(
        eng.state(&after, &mm, &r, 0.0, Some(State::Deleverage))
            .state,
        State::Healthy
    );
    // The steps the verdict is written from: the same plan, with its sizes.
    let plan = eng.deleverage_steps(&a, &mm, 4, Routes::ALL);
    assert_eq!(plan.after, after);
    assert_eq!(plan.end, PlanEnd::Done);
    assert_eq!(plan.steps[0], Step::Repay { usd: 10.0 });
    let Step::Trade(t) = &plan.steps[1] else {
        panic!("{:?}", plan.steps)
    };
    assert_eq!(
        (t.kind, t.group.as_str(), t.dq),
        (TradeKind::Perp, "BTC", 0.00375)
    );
    assert!(!plan.steps[1].needs_one_click());
    // Without 1Click the plan is the same: it needs no quote.
    assert_eq!(eng.deleverage_steps(&a, &mm, 4, Routes::NO_ONE_CLICK), plan);
}

#[test]
fn without_one_click_a_deleverage_plan_never_sells() {
    // An exact ETH hedge that must deleverage: the reference unwinds the pair (RISK_ENGINE.md 14.2, T18). Without
    // 1Click no pair can be sold, the perp has no excess to buy back, so the plan stops and says why.
    let eng = Engine::v0();
    let m = eng.calm_market();
    let eth_px = m.price("ETH");
    let eth = Account {
        near: map(&[("ETH.b", 200.0)]),
        hl_cash: 120_000.0,
        perps: map(&[("ETH", -200.0)]),
        entry: map(&[("ETH", eth_px)]),
        debt: 450_000.0,
        ..Account::default()
    };
    let full = eng.deleverage_steps(&eth, &m, 1, Routes::ALL);
    assert!(matches!(&full.steps[0], Step::Trade(t) if t.kind == TradeKind::Pair));
    assert!(full.steps[0].needs_one_click());
    let none = eng.deleverage_steps(&eth, &m, 4, Routes::NO_ONE_CLICK);
    assert!(none.steps.is_empty());
    assert_eq!(none.end, PlanEnd::NeedsOneClick);
    // With USDC on NEAR it still repays.
    let mut with_usdc = eth.clone();
    with_usdc.near.insert("USDC", 5_000.0);
    let p = eng.deleverage_steps(&with_usdc, &m, 4, Routes::NO_ONE_CLICK);
    assert_eq!(p.steps, [Step::Repay { usd: 5_000.0 }]);
    assert_eq!(p.end, PlanEnd::NeedsOneClick);
    // Cash left on Hyperliquid with no perps: bringing it home needs 1Click.
    let cash = Account {
        hl_cash: 8_000.0,
        debt: 30_000.0,
        ..Account::default()
    };
    assert_eq!(
        eng.deleverage_steps(&cash, &m, 4, Routes::NO_ONE_CLICK).end,
        PlanEnd::NeedsOneClick
    );
    assert!(matches!(
        eng.deleverage_steps(&cash, &m, 1, Routes::ALL).steps[0],
        Step::Home { usd } if usd == 8_000.0
    ));
}

/// A BTC carry trade whose Hyperliquid margin has run low: $25k of nBTC against a $25k short, `hl` USDC on
/// Hyperliquid, `usdc` and `usdt` on NEAR, and a loan.
fn thin_margin(hl: f64, usdc: f64, usdt: f64) -> (Engine, Account, Market) {
    let eng = Engine::v0();
    let m = eng.calm_market();
    let p = m.price("BTC");
    let q = 25_000.0 / p;
    let mut near = map(&[("nBTC", q)]);
    if usdc > 0.0 {
        near.insert("USDC", usdc);
    }
    if usdt > 0.0 {
        near.insert("USDT", usdt);
    }
    let a = Account {
        near,
        hl_cash: hl,
        perps: map(&[("BTC", -q)]),
        entry: map(&[("BTC", p)]),
        debt: 10_000.0,
        ..Account::default()
    };
    (eng, a, m)
}

/// The margin ratio, and the ratio after ½·S* against every perp, of an account.
fn ratios(eng: &Engine, a: &Account, m: &Market) -> (f64, f64) {
    let moves = a
        .perps
        .iter()
        .map(|(c, &q)| (c.to_string(), -q.signum() * 0.5 * eng.shock(a, m, c).s_star))
        .collect();
    (eng.hl_ratio(a, m, None), eng.hl_ratio(a, m, Some(&moves)))
}

#[test]
fn a_rebalance_moves_usdc_first() {
    // $500 of margin for a $25k short: the ratio is about 63%, so REBALANCE.
    let (eng, a, m) = thin_margin(500.0, 5_000.0, 0.0);
    let r = eng.requirement(&a, &m);
    assert_eq!(eng.state(&a, &m, &r, 0.0, None).action, Action::Rebalance);
    let need = eng.rebalance_need(&a, &m);
    assert!(need > 0.0);
    let plan = eng.rebalance_steps(&a, &m, 4, Routes::ALL);
    assert_eq!(
        plan.steps,
        [Step::ToHl {
            usd: need + ONE_CLICK_FEE
        }]
    );
    assert_eq!(plan.end, PlanEnd::Done);
    // Afterwards neither trigger fires: the ratio is at most 30%, and at most 1 / 1.02 after ½·S*.
    let (now, projected) = ratios(&eng, &plan.after, &m);
    assert!(
        now <= 0.30 + 1e-12 && projected <= 1.0 / 1.02 + 1e-12,
        "{now} {projected}"
    );
    assert!(eng.rebalance_need(&plan.after, &m) < 1e-9);
    // Without 1Click nothing can move.
    let none = eng.rebalance_steps(&a, &m, 4, Routes::NO_ONE_CLICK);
    assert!(none.steps.is_empty());
    assert_eq!((none.end, none.short_usd), (PlanEnd::NeedsOneClick, need));
}

#[test]
fn a_rebalance_counts_usdc_already_on_its_way_to_hyperliquid() {
    // The book of `a_rebalance_moves_usdc_first`, with one transfer in flight.
    let (eng, a, m) = thin_margin(500.0, 5_000.0, 0.0);
    let need = eng.rebalance_need(&a, &m);
    let with = |token: &str, units: f64, overdue: bool, to_hl: bool| Account {
        inflight: vec![InFlight {
            token: token.to_string(),
            units,
            overdue,
            to_hl,
        }],
        ..a.clone()
    };
    let close = |got: f64, want: f64| assert!((got - want).abs() < 1e-9, "{got} vs {want}");
    // X on its way to Hyperliquid takes 98% of X off the need, as the state counts money in flight.
    let x = 0.5 * need;
    close(
        eng.rebalance_need(&with("USDC", x, false, true), &m),
        need - 0.98 * x,
    );
    // Once that transfer is overdue it counts as nothing, so the next check sends again.
    close(eng.rebalance_need(&with("USDC", x, true, true), &m), need);
    // A transfer home and a sale land on NEAR: they don't count.
    close(eng.rebalance_need(&with("USDC", x, false, false), &m), need);
    close(
        eng.rebalance_need(&with("nBTC", 0.05, false, false), &m),
        need,
    );
    // With the whole need on its way the trigger still fires, but the plan moves nothing more.
    let covered = with("USDC", need / 0.98 + 1.0, false, true);
    let r = eng.requirement(&covered, &m);
    assert_eq!(
        eng.state(&covered, &m, &r, 0.0, None).action,
        Action::Rebalance
    );
    assert_eq!(eng.rebalance_need(&covered, &m), 0.0);
    let plan = eng.rebalance_steps(&covered, &m, 4, Routes::ALL);
    assert!(
        plan.steps.is_empty() && plan.end == PlanEnd::Done,
        "{:?}",
        plan.steps
    );
    // Old snapshots and the reference's cases carry no direction: they read as money coming to NEAR.
    let old: InFlight = serde_json::from_str(r#"["USDC", 5000.0, false]"#).unwrap();
    assert!(!old.to_hl);
    assert_eq!(
        serde_json::to_string(&old).unwrap(),
        r#"{"token":"USDC","units":5000.0,"overdue":false}"#
    );
}

#[test]
fn a_rebalance_sells_usdt_then_hedged_pairs_both_legs() {
    // $20 of USDC is all there is: it goes; then USDT is sold for the rest, which a later plan moves.
    let (eng, a, m) = thin_margin(500.0, 20.0, 50_000.0);
    let plan = eng.rebalance_steps(&a, &m, 4, Routes::ALL);
    assert!(
        matches!(plan.steps[0], Step::ToHl { usd } if usd == 20.0),
        "{:?}",
        plan.steps
    );
    let Step::Swap {
        token, usd: got, ..
    } = &plan.steps[1]
    else {
        panic!("{:?}", plan.steps)
    };
    assert_eq!(token, "USDT");
    assert!(plan.steps.len() == 2 && plan.end == PlanEnd::Done && plan.short_usd == 0.0);
    // What the USDT pays covers what Hyperliquid still needs after the USDC, and the fee of moving it.
    let after_usdc = {
        let mut b = a.clone();
        b.near.insert("USDC", 0.0);
        b.hl_cash += 20.0 - ONE_CLICK_FEE;
        b
    };
    assert!(got - ONE_CLICK_FEE >= eng.rebalance_need(&after_usdc, &m) - 0.01);
    // Nothing to move: the hedged pair is sold, both legs together, so the hedge is kept.
    let (eng, a, m) = thin_margin(500.0, 0.0, 0.0);
    let plan = eng.rebalance_steps(&a, &m, 4, Routes::ALL);
    assert!(!plan.steps.is_empty());
    for s in &plan.steps {
        let Step::Trade(t) = s else {
            panic!("{:?}", plan.steps)
        };
        assert_eq!(
            (t.kind, t.token.as_deref()),
            (TradeKind::Pair, Some("nBTC"))
        );
        assert!(t.dq > 0.0 && (t.dq - t.units).abs() < 1e-12, "{t:?}");
        assert!(s.text().starts_with("pair BTC: trade $") && !s.text().contains("MR"));
    }
    let net = |x: &Account| eng.net_units(x, &m, "BTC", None);
    assert!((net(&plan.after) - net(&a)).abs() < 1e-12);
    // Each pair cuts the margin ratio; its sale's USDC waits on NEAR for the next plan.
    let (before, _) = ratios(&eng, &a, &m);
    let (after, _) = ratios(&eng, &plan.after, &m);
    assert!(after < before, "{before} {after}");
    assert!(plan.after.near.get_or("USDC", 0.0) > 0.0);
    // A healthy margin needs nothing.
    let (eng, a, m) = thin_margin(10_000.0, 5_000.0, 0.0);
    let plan = eng.rebalance_steps(&a, &m, 4, Routes::ALL);
    assert!(plan.steps.is_empty() && plan.end == PlanEnd::Done);
}

#[test]
fn only_orders_that_add_risk_are_cancelled() {
    let order = |coin: &str, size: f64, reduce_only: bool| Order {
        coin: coin.into(),
        size,
        limit_px: 1.0,
        reduce_only,
    };
    let mut a = Account {
        perps: map(&[("BTC", -0.3)]),
        ..Account::default()
    };
    a.orders = vec![
        order("BTC", 0.1, false),  // closes part of the short
        order("BTC", -0.1, false), // adds to the short
        order("ETH", 1.0, false),  // no ETH position: opens one
        order("BTC", 0.5, true),   // reduce-only never adds
    ];
    assert_eq!(risky_orders(&a), [1, 2]);
    // Two closing orders that together could flip the short both count.
    a.orders = vec![order("BTC", 0.2, false), order("BTC", 0.2, false)];
    assert_eq!(risky_orders(&a), [0, 1]);
    a.orders = vec![order("BTC", 0.2, false), order("BTC", 0.1, false)];
    assert!(risky_orders(&a).is_empty());
}
