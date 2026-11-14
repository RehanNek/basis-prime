//! INTERFACES.md 50.6: a token with 24 decimals (wNEAR; the factory takes up to 24) is read at its true size.
//! Until 14 Nov the engine divided by at most 10^22, so 346.1 wNEAR counted as 34,610.
//!
//! The reads are the pretend world's, with wNEAR written into the account's config and balances, and NEAR priced
//! at $3.3225 by every source (Hyperliquid testnet's oracle price on 14 Nov, with its listing of that day).
mod common;

use common::*;
use pb_risk::inputs::CoinReads;
use pb_risk::plan::{self, Ask, Ctx, Quote, Quotes};
use pb_risk::request::Intent;
use pb_risk::steps::PlanStep;
use pb_risk::{Inputs, Verdict};
use risk_core::plan::{Plan, PlanEnd, Step, Trade, TradeKind};
use risk_core::{Account, Action, Engine, OrderedMap};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const WNEAR: &str = "mwnear.pbf-ops.testnet";
const NEAR_USD: f64 = 3.3225;
/// 346.1 wNEAR, in the token's own 24 decimals.
const HELD_24: u128 = 346_100_000_000_000_000_000_000_000;

fn ten_to(d: u32) -> u128 {
    10u128.pow(d)
}

fn scaled(r: &CoinReads, k: f64) -> CoinReads {
    let mut out = r.clone();
    for t in out.tickers.values_mut() {
        t.bid *= k;
        t.ask *= k;
    }
    for list in out.minutes.values_mut().chain(out.hours.values_mut()) {
        for c in list.iter_mut() {
            c.1 *= k;
        }
    }
    out
}

/// A new account's reads, then: wNEAR in its config with `decimals`, `raw` of it held and nothing else but
/// `usdc` micro-USDC, and `debt` micro-USDC owed to our pool (borrowed and taken out).
fn with_wnear(decimals: u32, raw: u128, usdc: u128, debt: u128) -> Inputs {
    let world = World {
        usdc: 1_000_000,
        nbtc: 100_000,
        counter: 1,
        prev_state: Some("HEALTHY"),
        ..World::fresh()
    };
    let (out, _) = run(world, r#"{"check":{}}"#, true);
    let v: Value = serde_json::from_str(&out).unwrap();
    let mut inp: Inputs = serde_json::from_value(v["inputs"].clone()).unwrap();
    // NEAR's prices: the pretend walk, moved to $3.3225. Hyperliquid's listing as read on testnet on 14 Nov.
    let btc = inp.coins["BTC"].clone();
    let mid = (btc.tickers["binance"].bid + btc.tickers["binance"].ask) / 2.0;
    inp.coins.insert("NEAR".into(), scaled(&btc, NEAR_USD / mid));
    inp.hl.assets.insert(
        "NEAR".into(),
        json!({"meta": {"szDecimals": 1, "name": "NEAR", "maxLeverage": 20, "marginTableId": 20},
            "ctx": {"funding": "0.0000125", "oraclePx": "3.3225", "markPx": "3.3199"}, "tiers": null, "index": 54}),
    );
    inp.near.config["tokens"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": WNEAR, "symbol": "wNEAR", "decimals": decimals}));
    inp.near.balances.insert(MUSDC.into(), json!(usdc.to_string()));
    inp.near.balances.insert(MNBTC.into(), json!("0"));
    inp.near.balances.insert(WNEAR.into(), json!(raw.to_string()));
    inp.near.borrower["debt"] = json!(debt.to_string());
    inp.near.pool["loans"] = json!(debt.to_string());
    inp.near.state["loan"] = json!({"principal": debt.to_string()});
    inp
}

fn verdict(inp: &Inputs) -> Verdict {
    let out = pb_risk::output(inp);
    serde_json::from_str(&out).unwrap_or_else(|e| panic!("not a verdict ({e}): {out}"))
}

#[test]
fn a_holding_of_346_1_units_of_a_24_decimals_token_is_valued_as_346_1_units_in_the_book_and_in_the_equity() {
    let inp = with_wnear(24, HELD_24, 450_000_000, 0);
    // The book: 346.1 wNEAR, not 34,610.
    let b = pb_risk::book::build(&inp).unwrap();
    let held = b.account.near.get_or("wNEAR", 0.0);
    assert!((held - 346.1).abs() < 1e-9, "{held}");
    let px = b.built.market.price("NEAR");
    assert!((px - NEAR_USD).abs() < 0.005, "{px}");
    // The verdict's equity: the wNEAR at its price and the $450, about $1,600. It was $115,442.
    let v = verdict(&inp);
    let want = 346.1 * px + 450.0;
    assert!((v.eq as f64 / 1e6 - want).abs() < 0.001, "{} vs {want}", v.eq);
    assert!(v.eq > 1_590_000_000 && v.eq < 1_610_000_000, "{}", v.eq);
    assert!(v.eq_allow > 1_590_000_000 && v.eq_allow <= v.eq, "{}", v.eq_allow);
    // And so is what it may borrow: under the holding's own value, where it was $46,745.
    assert!(v.allow.borrow < 1_150_000_000, "{}", v.allow.borrow);
    // The same holding written with 18 decimals (as ETH is) or with 22 (the most the old reading took rightly)
    // is the same book: the decimals only say where the point is.
    for (decimals, raw) in [(18, 3_461 * ten_to(17)), (22, 3_461 * ten_to(21)), (6, 346_100_000)] {
        let same = verdict(&with_wnear(decimals, raw, 450_000_000, 0));
        assert!((same.eq - v.eq).abs() <= 1, "{decimals}: {} vs {}", same.eq, v.eq);
        assert!(same.allow.borrow.abs_diff(v.allow.borrow) <= 1, "{decimals}");
        assert_eq!((same.state.as_str(), same.tier.as_str(), same.score), (v.state.as_str(), v.tier.as_str(), v.score));
    }
    // One unit more or less shows: the equity follows the holding one for one.
    let more = verdict(&with_wnear(24, HELD_24 + ten_to(24), 450_000_000, 0));
    assert!(((more.eq - v.eq) as f64 / 1e6 - px).abs() < 0.001, "{} {}", more.eq, v.eq);
}

#[test]
fn a_withdraw_intent_of_a_24_decimals_token_is_weighed_at_its_true_size() {
    // 346.1 wNEAR ($1,150) and $50 against a $100 loan that was taken out.
    let asked = |units: u128| -> (u128, Verdict) {
        let amount = units * ten_to(24);
        let mut inp = with_wnear(24, HELD_24, 50_000_000, 100_000_000);
        inp.request.intent = Intent::Withdraw { token: WNEAR.into(), amount: amount.to_string() };
        (amount, verdict(&inp))
    };
    // 10 wNEAR ($33) may leave.
    let (amount, v) = asked(10);
    assert_eq!(v.state, "HEALTHY");
    assert_eq!(v.allow.withdraw, amount, "{:?}", v.top);
    // 330 wNEAR ($1,096) may not: $104 would be left behind a $100 loan. Read 100 times too large, the account
    // seemed to keep $5,400 and the withdrawal was allowed.
    let (_, v) = asked(330);
    assert_eq!(v.allow.withdraw, 0);
    // More than the account holds is refused, to the last unit.
    let mut inp = with_wnear(24, HELD_24, 50_000_000, 0);
    inp.request.intent = Intent::Withdraw { token: WNEAR.into(), amount: (HELD_24 + 1).to_string() };
    assert_eq!(verdict(&inp).allow.withdraw, 0);
    inp.request.intent = Intent::Withdraw { token: WNEAR.into(), amount: HELD_24.to_string() };
    assert_eq!(verdict(&inp).allow.withdraw, HELD_24);
}

/// 1Click, answering every quote.
struct Quoting;

impl Quotes for Quoting {
    fn quote(&mut self, _: &Ask) -> Result<Quote, String> {
        Ok(Quote { dep: "dep1".into(), exp: 1_794_000_000_000, min: 1_000_000 })
    }
}

#[test]
fn a_plans_sale_of_a_24_decimals_token_is_written_in_its_true_units() {
    let eng = Engine::v0();
    let m = eng.calm_market();
    let mut near = OrderedMap::new();
    near.insert("wNEAR", 346.1);
    let a = Account { near, debt: 500.0, ..Account::default() };
    let sale = |decimals: u32| -> u128 {
        let conf = pb_risk::near::config(&json!({"tokens": [{"id": MUSDC, "symbol": "USDC", "decimals": 6},
            {"id": WNEAR, "symbol": "wNEAR", "decimals": decimals}], "pool_id": "pool.pbf.testnet"}))
        .unwrap();
        // A quarter of the holding sold through 1Click, as the engine sizes a step.
        let plan = Plan {
            steps: vec![Step::Trade(Trade {
                kind: TradeKind::Near,
                group: "NEAR".into(),
                dq: 0.0,
                token: Some("wNEAR".into()),
                units: 86.525,
                traded: 0.0,
                cost: 0.0,
                mr: None,
            })],
            after: a.clone(),
            end: PlanEnd::Done,
            short_usd: 0.0,
        };
        let (assets, none) = (BTreeMap::new(), BTreeSet::new());
        let ctx = Ctx { engine: &eng, market: &m, account: &a, conf: &conf, assets: &assets, uncertain: &none, band_floor: None };
        let w = plan::wire(&ctx, &mut Quoting, Action::Deleverage, &plan);
        let [PlanStep::Sell { tok, amt, .. }] = &w.steps[..] else {
            panic!("{w:?}")
        };
        assert_eq!(tok, WNEAR);
        amt.parse().unwrap()
    };
    // 86.525 wNEAR is 86,525 and 21 zeros of the token's units. It was written 100 times too small.
    let raw = sale(24);
    let want = 86_525 * ten_to(21);
    assert!(raw.abs_diff(want) <= want / ten_to(11), "{raw} vs {want}");
    // The same sale of a token with 18 or 22 decimals is the same amount, with the point elsewhere.
    for decimals in [18u32, 22] {
        let other = sale(decimals) * ten_to(24 - decimals);
        assert!(other.abs_diff(raw) <= want / ten_to(11), "{decimals}: {other} vs {raw}");
    }
}
