//! `backtest drill`: the depeg drill on the testnet demo book (PLAN.md 2, RISK_ENGINE.md 13.2), from risk-core.
//!
//! The book is 0.015 nBTC and a 0.015 BTC short entered at the price, with Hyperliquid margin and a loan taken out,
//! on a calm market, with Hyperliquid testnet's BTC margin table (40x under $10k, 25x under $50k, then 10x). It
//! prints the state at each nBTC/BTC ratio, the ratios where the states change (the bands, searched as the reference
//! searches them), and the plan at one ratio, in words and as the verdict's step objects (INTERFACES.md 13).
use pb_risk::plan::{self, NoQuotes};
use risk_core::hl::Tier;
use risk_core::plan::Routes;
use risk_core::states::{band, BAND_STEP};
use risk_core::*;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

/// The book: BTC price, the short's entry price (the price when 0), margin on Hyperliquid, the loan, and USDC left
/// on NEAR (all USD).
pub struct Book {
    pub px: f64,
    pub entry: f64,
    pub hl: f64,
    pub debt: f64,
    pub usdc: f64,
}

impl Default for Book {
    /// `research/data/phase3_hedge_small.json`: 428.60 USDC of margin after Hyperliquid's 1 USDC fee, a $1,096.805
    /// loan, 10 mUSDC left, BTC near $75,800.
    fn default() -> Book {
        Book {
            px: 75_800.0,
            entry: 0.0,
            hl: 428.6,
            debt: 1_096.805,
            usdc: 10.0,
        }
    }
}

pub fn engine_and_market(book: &Book) -> (Engine, Account, Market) {
    let mut eng = Engine::v0();
    for c in eng.coins.iter_mut().filter(|c| c.name == "BTC") {
        c.margin_tiers = [(0.0, 40), (10_000.0, 25), (50_000.0, 10)]
            .iter()
            .map(|&(lower_bound, max_leverage)| Tier {
                lower_bound,
                max_leverage,
            })
            .collect();
    }
    let mut m = eng.calm_market();
    for map in [&mut m.px, &mut m.mark, &mut m.twap] {
        map.insert("BTC".into(), book.px);
    }
    // The testnet pool: $10M of capital, and only this loan out.
    m.pool_capital = 10_000_000.0;
    m.pool_loans = book.debt;
    m.util = book.debt / m.pool_capital;
    let mut near = OrderedMap::new();
    if book.usdc > 0.0 {
        near.insert("USDC", book.usdc);
    }
    near.insert("nBTC", 0.015);
    let a = Account {
        near,
        hl_cash: book.hl,
        perps: [("BTC", -0.015)].into_iter().collect(),
        entry: [(
            "BTC",
            if book.entry > 0.0 {
                book.entry
            } else {
                book.px
            },
        )]
        .into_iter()
        .collect(),
        debt: book.debt,
        ..Account::default()
    };
    (eng, a, m)
}

fn at(m: &Market, ratio: f64) -> Market {
    let mut m = m.clone();
    m.wrap.insert("nBTC".into(), ratio);
    m
}

/// The printout.
pub fn printout(book: &Book, plan_at: f64) -> Vec<String> {
    let (eng, a, m) = engine_and_market(book);
    let mut out = vec![format!(
        "book: 0.015 nBTC, a 0.015 BTC short entered at ${:.0} with BTC at ${:.0}, ${:.2} of Hyperliquid margin, ${:.2} on \
         NEAR, a ${:.3} loan taken out",
        a.entry["BTC"], book.px, book.hl, book.usdc, book.debt
    )];
    for ratio in [
        1.0, 0.90, 0.85, 0.84, 0.83, 0.82, 0.80, 0.79, 0.78, 0.77, 0.76, 0.75, 0.70,
    ] {
        let mm = at(&m, ratio);
        let r = eng.requirement(&a, &mm);
        let st = eng.state(&a, &mm, &r, 0.0, None);
        out.push(format!(
            "  nBTC/BTC {ratio:.2}: equity ${:>7.2}  MR ${:>7.2}  IM ${:>7.2}  {} {}",
            r.e,
            r.mr,
            r.im,
            st.state.as_str(),
            st.action.as_str()
        ));
    }
    let wrap_band = |k: f64| {
        let f = |x: f64| {
            let r = eng.requirement(&a, &at(&m, 1.0 + x));
            r.e - k * r.mr
        };
        band(f, 0.0, -0.99, 0.0, BAND_STEP).map(|x| 1.0 + x)
    };
    let (watch, call, dl) = (wrap_band(1.25), wrap_band(1.0), wrap_band(0.8));
    let show = |x: Option<f64>| x.map_or("none".to_string(), |x| format!("{x:.4}"));
    out.push(format!(
        "bands: WATCH below {} (equity = IM), MARGIN_CALL below {} (= MR), DELEVERAGE below {} (= 0.8 x MR)",
        show(watch),
        show(call),
        show(dl)
    ));
    if let (Some(w), Some(c), Some(d)) = (watch, call, dl) {
        // The first two stops half-way between two bands, the last at least half a cent of ratio under the lowest,
        // so that small changes in the live book (the price, the margin, the loan) don't move a stop across a band.
        out.push(format!(
            "slide: {:.2},{:.2},{:.2} lands in each state with room either side",
            ((w + c) / 2.0 * 100.0).round() / 100.0,
            ((c + d) / 2.0 * 100.0).round() / 100.0,
            ((d - 0.005) * 100.0).floor() / 100.0
        ));
    }
    out.push(format!("topup: ${}", eng.topup(&a, &m)));
    let mm = at(&m, plan_at);
    let p = eng.deleverage_steps(&a, &mm, 4, Routes::NO_ONE_CLICK);
    out.push(format!("plan at {plan_at:.2} ({:?}):", p.end));
    for s in &p.steps {
        out.push(format!("  - {}", s.text()));
    }
    let r = eng.requirement(&p.after, &mm);
    let st = eng.state(&p.after, &mm, &r, 0.0, Some(State::Deleverage));
    out.push(format!(
        "  after: equity ${:.2}, MR ${:.2}, IM ${:.2}, BTC perp {:.5}, debt ${:.3}, {}",
        r.e,
        r.mr,
        r.im,
        p.after.perps.get_or("BTC", 0.0),
        p.after.debt,
        st.state.as_str()
    ));
    let conf = pb_risk::near::config(&json!({"pool_id": "pool.pbf.testnet", "tokens": [
        {"id": "musdc.pbf-ops.testnet", "symbol": "USDC", "decimals": 6},
        {"id": "mnbtc.pbf-ops.testnet", "symbol": "nBTC", "decimals": 8}]}))
    .expect("the testnet config parses");
    let assets: BTreeMap<String, serde_json::Value> = [(
        "BTC".to_string(),
        json!({"meta": {"szDecimals": 5}, "index": 3}),
    )]
    .into();
    let ctx = plan::Ctx {
        engine: &eng,
        market: &mm,
        account: &a,
        conf: &conf,
        assets: &assets,
        uncertain: &BTreeSet::new(),
        // The parameter file's band, as the reference has it: testnet's own floor is the programs' (pb-read).
        band_floor: None,
    };
    let wired = plan::wire(&ctx, &mut NoQuotes, Action::Deleverage, &p);
    out.push(format!(
        "  as the verdict's plan: {}",
        serde_json::to_string(&wired.steps).expect("steps serialise")
    ));
    for n in wired.notes {
        out.push(format!("  top: {n}"));
    }
    out
}
