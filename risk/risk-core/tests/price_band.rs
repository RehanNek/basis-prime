//! P2's price band, and the floor a network can put under it (INTERFACES.md 42). The floor is an argument that
//! defaults to none: the reference's cases, the examples and the backtest never pass one, so they keep the
//! parameter file's band. On testnet the programs pass 3%.
use risk_core::pretrade::p2_band;
use risk_core::*;

fn map(pairs: &[(&str, f64)]) -> OrderedMap<f64> {
    pairs.iter().map(|&(k, v)| (k, v)).collect()
}

/// RISK_ENGINE.md 13.1's hedged BTC carry on the calm market, buying back a tenth of its short at a limit `away`
/// above the reference price, with `floor` under the band.
fn buy_back(away: f64, floor: Option<f64>) -> PreTrade {
    let eng = Engine::v0();
    let m = eng.calm_market();
    let p = m.price("BTC");
    let q = 100_000.0 / p;
    let a = Account {
        near: map(&[("nBTC", q)]),
        hl_cash: 35_000.0,
        perps: map(&[("BTC", -q)]),
        entry: map(&[("BTC", p)]),
        ..Account::default()
    };
    let order = Order {
        coin: "BTC".to_string(),
        size: q / 10.0,
        limit_px: p * (1.0 + away),
        reduce_only: false,
    };
    eng.pretrade_check_with(&a, &m, &order, None, None, floor)
}

const ONE: &str = "limit price more than 1% from the reference price";
const THREE: &str = "limit price more than 3% from the reference price";

#[test]
fn with_no_floor_the_band_is_the_parameter_files() {
    assert_eq!(Engine::v0().coin("BTC").params.price_band, 0.01);
    let r = buy_back(0.015, None);
    assert_eq!((r.ok, r.check, r.reason.as_str()), (false, Check::P2, ONE));
    // The default check passes no floor.
    let eng = Engine::v0();
    let m = eng.calm_market();
    let order = Order {
        coin: "BTC".to_string(),
        size: 0.1,
        limit_px: m.price("BTC") * 1.015,
        reduce_only: false,
    };
    let (ok, why) = eng.pretrade(&Account::default(), &m, &order, None);
    assert_eq!((ok, why.as_str()), (false, ONE));
    // Inside the file's band the order goes on to the other checks, as before.
    assert!(buy_back(0.009, None).ok);
}

#[test]
fn a_floor_of_3_percent_accepts_2_percent_away_and_refuses_3_and_a_half_with_the_3_percent_words() {
    let floor = Some(0.03);
    // 1.5% and 2% away were refused by the file's 1% band; with the floor they pass P2 and every later check.
    for away in [0.015, 0.02, -0.02] {
        assert_eq!(buy_back(away, None).check, Check::P2, "{away}");
        let r = buy_back(away, floor);
        assert!(r.ok, "{away}: {}", r.reason);
    }
    for away in [0.035, -0.035] {
        let r = buy_back(away, floor);
        assert_eq!((r.ok, r.check, r.reason.as_str()), (false, Check::P2, THREE), "{away}");
    }
}

#[test]
fn the_band_is_the_larger_of_the_coins_and_the_floor() {
    assert_eq!(p2_band(0.01, None), 0.01);
    assert_eq!(p2_band(0.01, Some(0.03)), 0.03);
    assert_eq!(p2_band(0.02, Some(0.03)), 0.03);
    // A floor at or under the coin's band changes nothing, and neither does one that isn't a number.
    assert_eq!(p2_band(0.03, Some(0.03)), 0.03);
    assert_eq!(p2_band(0.03, Some(0.01)), 0.03);
    assert_eq!(p2_band(0.01, Some(0.0)), 0.01);
    assert_eq!(p2_band(0.01, Some(f64::NAN)), 0.01);
    assert_eq!(p2_band(0.01, Some(f64::INFINITY)), 0.01);
    let r = buy_back(0.015, Some(0.005));
    assert_eq!((r.check, r.reason.as_str()), (Check::P2, ONE));
}
