//! pb-risk end to end, natively: the reads against a pretend world (tests/common), the verdict, the snapshot
//! form, and the replay of the committed fixture snapshots to the byte.
//!
//! The fixtures in tests/fixtures are this pretend world's runs. To write them again after a deliberate change:
//!   PB_RISK_WRITE_FIXTURES=1 cargo test -p pb-risk --test pipeline
mod common;

use common::*;
use pb_risk::steps::{wire_size, PlanStep};
use pb_risk::{verdict::params_hash, Inputs, Verdict};
use risk_core::plan::{Routes, Step};
use risk_core::states::{band, BAND_STEP};
use serde_json::{json, Value};

fn verdict(out: &str) -> Verdict {
    serde_json::from_str(out).unwrap_or_else(|e| panic!("not a verdict ({e}): {out}"))
}

fn reason(out: &str) -> String {
    let v: Value = serde_json::from_str(out).unwrap();
    assert_eq!(v["ok"], false, "{out}");
    v["reason"].as_str().unwrap().to_string()
}

/// The snapshot form, split: the verdict's exact bytes and the inputs.
fn split(out: &str) -> (String, Inputs) {
    let v: Value = serde_json::from_str(out).unwrap();
    let inputs: Inputs = serde_json::from_value(v["inputs"].clone()).unwrap();
    // The verdict is the first member, printed as pb-risk prints it.
    let start = out.find(r#"{"verdict":"#).unwrap() + r#"{"verdict":"#.len();
    let end = out.find(r#","inputs":"#).unwrap();
    (out[start..end].to_string(), inputs)
}

#[test]
fn a_fresh_account_has_nothing_to_lend_against() {
    let (out, net) = run(World::fresh(), r#"{"check":{}}"#, false);
    let v = verdict(&out);
    assert!(v.ok && v.v == 1 && v.model == "B-0.2");
    assert_eq!(v.params, params_hash());
    assert_eq!(
        v.params,
        "3d362b434adaad0e0c909605bd792232acf964b9143a95ccb2541a0f65c4c263"
    );
    assert_eq!((v.acct.as_str(), v.blk, v.nonce), (ACCOUNT, HEIGHT, 0));
    assert_eq!((v.eq, v.mm, v.im), (0, 0, 0));
    assert_eq!(
        (v.state.as_str(), v.action.as_str(), v.tier.as_str()),
        ("HEALTHY", "NONE", "STANDARD")
    );
    assert_eq!((v.allow.borrow, v.allow.withdraw, v.credit.line), (0, 0, 0));
    assert_eq!(v.credit.binding, "C0");
    assert!(v.bands.is_empty() && v.plan.is_empty() && v.top.is_empty());
    // Nothing held: no prices needed, so 10 NEAR calls and nothing else.
    assert_eq!(call_counts(&net).get("near"), Some(&10));
    assert_eq!(net.calls.len(), 10);
}

#[test]
fn deposits_give_a_standard_line() {
    let (out, net) = run(World::deposits(), r#"{"check":{}}"#, false);
    let v = verdict(&out);
    // An unhedged book (hedge ratio 0, coins over 25% of equity) scores 650 - 100 = 550: Watch (RISK_ENGINE.md 6).
    assert_eq!(
        (v.state.as_str(), v.tier.as_str(), v.score, v.nonce),
        ("HEALTHY", "WATCH", 550, 1)
    );
    assert_eq!((v.hr_bp, v.hr7_bp, v.credit.binding.as_str()), (0, 0, "C4"));
    // $5,000 of USDC and 0.3 BTC at about $76k: about $27.8k of equity.
    assert!(v.eq > 27_000_000_000 && v.eq < 29_000_000_000, "{}", v.eq);
    assert!(v.allow.borrow > 10_000_000_000, "{out}");
    assert_eq!(v.credit.line, v.allow.borrow);
    // No loan: free USDC is withdrawable, and no bands.
    assert_eq!(v.allow.withdraw, 5_000_000_000);
    assert!(v.bands.is_empty());
    // nBTC's share of collateral and its value for the pool's limits.
    assert!(
        v.pool.shares_bp["nBTC"] > 7_000 && v.pool.shares_bp["nBTC"] < 9_000,
        "{out}"
    );
    assert!(v.pool.hold["nBTC"] > 20_000_000_000);
    assert!(!v.pool.hold.contains_key("USDC"));
    assert_eq!(v.rate_bp, 500); // nothing lent: base rate 0, Watch +5%
    assert!(v.coins.uncertain.is_empty(), "{out}");
    assert_eq!(v.top.len(), 3);
    assert!(out.len() < 2_000, "{} bytes", out.len());
    // One coin held: NEAR, Hyperliquid's market and 12 exchange calls (OKX pages hourly candles).
    let counts = call_counts(&net);
    assert_eq!(
        (counts["near"], counts["hyperliquid"], counts["get"]),
        (10, 1, 12)
    );
}

#[test]
fn a_loan_gets_bands_and_counts_its_debt() {
    let (out, _) = run(World::loan(), r#"{"check":{}}"#, false);
    let v = verdict(&out);
    assert_eq!(v.nonce, 2);
    assert_eq!(v.credit.line, 13_000_012_345 + v.allow.borrow);
    // Base rate at 6.5% utilisation, plus Watch's 5%.
    assert_eq!(v.rate_bp, 549);
    assert!(
        v.allow.withdraw > 0 && v.allow.withdraw < 5_000_000_000,
        "{out}"
    );
    // A net long in BTC: the equity bands are below today's price (no perp, so no margin-ratio bands), and π's
    // below 1. Moving BTC or π moves nBTC's value alike, so the two agree; 0.8 × MR is past π = 0.5, so left out.
    let btc = &v.bands["BTC"];
    assert!(btc.hl50.is_none() && btc.hl100.is_none(), "{out}");
    let (im, mr) = (btc.im.unwrap() as f64 / 1e6, btc.mr.unwrap() as f64 / 1e6);
    let today = btc_price(T0_MS);
    assert!(mr < im && im < today, "{out}");
    let nbtc = &v.bands["nBTC"];
    let (im_bp, mr_bp) = (nbtc.im_bp.unwrap(), nbtc.mr_bp.unwrap());
    assert!(
        mr_bp < im_bp && im_bp < 10_000 && nbtc.dl_bp.is_none(),
        "{out}"
    );
    assert!(((im / today) * 1e4 - im_bp as f64).abs() < 20.0, "{out}");
    assert!(out.len() < 2_000, "{} bytes: {out}", out.len());
}

#[test]
fn intents_are_answered() {
    // A withdrawal within the allowance is allowed in full; one past it gets 0.
    let ok = r#"{"withdraw":{"token":"musdc.pbf-ops.testnet","amount":"1000000000"}}"#;
    let (out, _) = run(World::loan(), ok, false);
    assert_eq!(verdict(&out).allow.withdraw, 1_000_000_000);
    let too_much = r#"{"withdraw":{"token":"musdc.pbf-ops.testnet","amount":"5000000000"}}"#;
    let (out, _) = run(World::loan(), too_much, false);
    assert_eq!(verdict(&out).allow.withdraw, 0);
    let nbtc = r#"{"withdraw":{"token":"mnbtc.pbf-ops.testnet","amount":"1000000"}}"#;
    assert_eq!(
        verdict(&run(World::loan(), nbtc, false).0).allow.withdraw,
        1_000_000
    );
    // With no loan, anything held may go.
    let all = r#"{"withdraw":{"token":"mnbtc.pbf-ops.testnet","amount":"30000000"}}"#;
    assert_eq!(
        verdict(&run(World::deposits(), all, false).0)
            .allow
            .withdraw,
        30_000_000
    );
    let more = r#"{"withdraw":{"token":"mnbtc.pbf-ops.testnet","amount":"30000001"}}"#;
    assert_eq!(
        verdict(&run(World::deposits(), more, false).0)
            .allow
            .withdraw,
        0
    );
    let other = r#"{"withdraw":{"token":"usdt.tether-token.near","amount":"1"}}"#;
    assert!(reason(&run(World::deposits(), other, false).0).contains("isn't configured"));
    // A borrow intent carries W*, which the account compares with the amount.
    let (out, _) = run(
        World::deposits(),
        r#"{"borrow":{"amount":"5000000000"}}"#,
        false,
    );
    let check = verdict(&run(World::deposits(), r#"{"check":{}}"#, false).0);
    assert_eq!(verdict(&out).allow.borrow, check.allow.borrow);
}

#[test]
fn missing_things_are_refused_with_a_reason() {
    let gone = World {
        account: None,
        ..World::fresh()
    };
    let (out, net) = run(gone, r#"{"check":{}}"#, false);
    assert_eq!(
        reason(&out),
        "account alice.pbf.testnet does not exist on testnet"
    );
    // The pool was read before the account turned out to be missing.
    assert!(net
        .calls
        .iter()
        .any(|c| c.contains("pool.pbf.testnet.get_pool")));
    let no_pool = World {
        pool_deployed: false,
        ..World::deposits()
    };
    assert_eq!(
        reason(&run(no_pool, r#"{"check":{}}"#, false).0),
        "cannot read the pool: account pool.pbf.testnet has no contract deployed"
    );
    assert!(reason(&pb_risk::run("{}", &mut MockNet::new(World::fresh()))).contains("mode"));
}

#[test]
fn degraded_data_stops_new_credit_but_not_the_state() {
    // Two exchanges down: three sources left (with Hyperliquid's oracle), still a price.
    let some_down = World {
        down: vec!["okx", "coinbase"],
        ..World::deposits()
    };
    let v = verdict(&run(some_down, r#"{"check":{}}"#, false).0);
    assert!(v.coins.uncertain.is_empty(), "{:?}", v.coins);
    // Three down: two sources, PRICE_UNCERTAIN, so no new credit.
    let most_down = World {
        down: vec!["okx", "coinbase", "bybit"],
        ..World::deposits()
    };
    let v = verdict(&run(most_down, r#"{"check":{}}"#, false).0);
    assert_eq!(v.coins.uncertain, ["BTC"]);
    assert_eq!(
        (v.allow.borrow, v.credit.binding.as_str(), v.state.as_str()),
        (0, "PRICE", "HEALTHY")
    );
    // No drill: nBTC's π is 0.80 and it is reduce-only.
    let no_drill = World {
        drill_bp: None,
        ..World::deposits()
    };
    let v = verdict(&run(no_drill, r#"{"check":{}}"#, false).0);
    assert_eq!(v.coins.reduce_only, ["nBTC"]);
    // A drill at 0.9: nBTC counts at 90%.
    let drill = World {
        drill_bp: Some(9_000),
        ..World::deposits()
    };
    let at_par = verdict(&run(World::deposits(), r#"{"check":{}}"#, false).0);
    let low = verdict(&run(drill, r#"{"check":{}}"#, false).0);
    let nbtc_value = at_par.pool.hold["nBTC"] as f64;
    assert!(((at_par.eq - low.eq) as f64 - 0.1 * nbtc_value).abs() < 1e6);
    // A frozen nBTC counts zero toward credit (share 0), keeps its value for the state.
    let mut frozen = World::deposits();
    frozen
        .coin_statuses
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!(["nBTC", {"status": "frozen", "since": "1", "emergency": false}]));
    let v = verdict(&run(frozen, r#"{"check":{}}"#, false).0);
    assert_eq!((v.pool.shares_bp["nBTC"], v.eq), (0, at_par.eq));
    assert!(v.allow.borrow < at_par.allow.borrow / 2);
    assert_eq!(v.coins.reduce_only, ["nBTC"]);
}

#[test]
fn a_snapshot_replays_to_the_byte() {
    for world in [
        World::fresh(),
        World::deposits(),
        World::loan(),
        World::hedged(),
    ] {
        let (out, _) = run(world.clone(), r#"{"check":{}}"#, true);
        let (bytes, inputs) = split(&out);
        // The same run without a snapshot prints the same verdict.
        let (plain, _) = run(world, r#"{"check":{}}"#, false);
        assert_eq!(plain, bytes);
        // `in` is the hash of the inputs; recomputing from them gives the same bytes.
        assert_eq!(verdict(&bytes).inputs, inputs.hash());
        assert_eq!(pb_risk::output(&inputs), bytes);
        // And through a pretty-printed copy, as a person might save it.
        let pretty: Inputs =
            serde_json::from_str(&serde_json::to_string_pretty(&inputs).unwrap()).unwrap();
        assert_eq!(pb_risk::output(&pretty), bytes);
    }
    // A refusal's snapshot replays too.
    let (out, _) = run(
        World {
            account: None,
            ..World::fresh()
        },
        r#"{"check":{}}"#,
        true,
    );
    let (bytes, inputs) = split(&out);
    assert_eq!(pb_risk::output(&inputs), bytes);
}

#[test]
fn the_committed_fixtures_replay() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
    let cases = [
        ("fresh", World::fresh()),
        ("deposits", World::deposits()),
        ("loan", World::loan()),
        ("hedged", World::hedged()),
        ("drill", World::drill(7_500)),
    ];
    if std::env::var("PB_RISK_WRITE_FIXTURES").is_ok() {
        std::fs::create_dir_all(dir).unwrap();
        for (name, world) in cases.clone() {
            let (out, _) = run(world, r#"{"check":{}}"#, true);
            std::fs::write(format!("{dir}/{name}.json"), out + "\n").unwrap();
        }
    }
    for (name, _) in cases {
        let text = std::fs::read_to_string(format!("{dir}/{name}.json")).unwrap();
        let (bytes, inputs) = split(text.trim_end());
        assert_eq!(pb_risk::output(&inputs), bytes, "{name}");
    }
}

/// Not a check: prints each pretend account's verdict, for reading.
///   cargo test -p pb-risk --test pipeline print_verdicts -- --ignored --nocapture
#[test]
#[ignore]
fn print_verdicts() {
    for (name, world) in [
        ("fresh", World::fresh()),
        ("deposits", World::deposits()),
        ("loan", World::loan()),
        ("hedged", World::hedged()),
    ] {
        let (out, net) = run(world, r#"{"check":{}}"#, false);
        println!(
            "{name} ({} bytes, {} calls): {out}",
            out.len(),
            net.calls.len()
        );
    }
    let (out, _) = run(World::loan(), r#"{"check":{}}"#, true);
    println!("snapshot bytes {}", out.len());
}

#[test]
fn the_hedged_demo_book_is_standard_with_every_band() {
    let (out, net) = run(World::hedged(), r#"{"check":{}}"#, false);
    let v = verdict(&out);
    // Hedged (the short is valued at Hyperliquid's mark, 14 bp above the index, so not quite 1) with coins over
    // 25% of equity: 650 + 50 = 700, Standard (RISK_ENGINE.md 6).
    assert_eq!((v.score, v.tier.as_str(), v.nonce), (700, "STANDARD", 3));
    assert!(v.hr_bp > 9_900 && v.hr_bp <= 10_000, "{out}");
    // The Standard line is about the demo's $24,150 (research/day1.md), nearly all drawn.
    assert!(
        v.credit.line > 24_000_000_000 && v.credit.line < 24_300_000_000,
        "{out}"
    );
    assert_eq!(v.credit.binding, "C4");
    // The Hyperliquid account was read: its equity is about $9,500, and its margin ratio shows.
    assert!(
        v.pool.hl_eq > 9_000_000_000 && v.pool.hl_eq < 10_000_000_000,
        "{out}"
    );
    assert!(v.venues.hl_margin_ratio_bp > 0, "{out}");
    // Hyperliquid: the account's state, open orders, mode and spot balances, and the market.
    let counts = call_counts(&net);
    assert_eq!(
        (counts["near"], counts["hyperliquid"], counts["get"]),
        (10, 5, 12)
    );
    // The short sets the bands above today's price: margin ratio 50% before 100%, IM before MR.
    let btc = &v.bands["BTC"];
    let (h50, h100) = (btc.hl50.unwrap(), btc.hl100.unwrap());
    assert!(h50 < h100, "{out}");
    assert!(btc.im.unwrap() <= btc.mr.unwrap(), "{out}");
    let nbtc = &v.bands["nBTC"];
    assert!(nbtc.im_bp.unwrap() > nbtc.mr_bp.unwrap(), "{out}");
    assert!(out.len() < 2_000, "{} bytes", out.len());
}

#[test]
fn a_unified_account_is_valued_from_its_spot_usdc() {
    // The same book, but the USDC sits in spot and clearinghouseState shows only the margin in use. Read the
    // standard way, its equity would be about $800 instead of $9,500.
    let unified = World {
        hl_mode: "unifiedAccount",
        ..World::hedged()
    };
    let (u, _) = run(unified, r#"{"check":{}}"#, false);
    let (s, _) = run(World::hedged(), r#"{"check":{}}"#, false);
    let (mut u, s) = (verdict(&u), verdict(&s));
    assert!(u.pool.hl_eq > 9_000_000_000, "{u:?}");
    // Everything but `in`, the hash of what was read, is the same.
    assert_ne!(u.inputs, s.inputs);
    u.inputs = s.inputs.clone();
    assert_eq!(u, s);
    // Modes version 0 can't value are refused, with the reason.
    let pm = World {
        hl_mode: "portfolioMargin",
        ..World::hedged()
    };
    assert!(reason(&run(pm, r#"{"check":{}}"#, false).0).contains("portfolioMargin"));
}

/// Not a check: the drill book's verdicts along the slide, for reading.
///   cargo test -p pb-risk --test pipeline print_drill -- --ignored --nocapture
#[test]
#[ignore]
fn print_drill() {
    for bp in [
        10_000, 8_400, 8_300, 8_000, 7_900, 7_800, 7_600, 7_500, 7_000,
    ] {
        let (out, net) = run(World::drill(bp), r#"{"check":{}}"#, false);
        println!(
            "{bp} ({} bytes, {} calls): {out}\n",
            out.len(),
            net.calls.len()
        );
    }
}

/// A world's snapshot inputs.
fn inputs_of(world: World) -> Inputs {
    split(&run(world, r#"{"check":{}}"#, true).0).1
}

#[test]
fn the_drill_book_walks_down_the_states() {
    // PLAN.md 2's testnet book as the drill slides nBTC/BTC down. The bands at par say where each state starts.
    let par = verdict(&run(World::drill(10_000), r#"{"check":{}}"#, false).0);
    assert_eq!(
        (par.state.as_str(), par.score, par.tier.as_str()),
        ("HEALTHY", 700, "STANDARD")
    );
    let nbtc = &par.bands["nBTC"];
    let (im_bp, mr_bp, dl_bp) = (
        nbtc.im_bp.unwrap(),
        nbtc.mr_bp.unwrap(),
        nbtc.dl_bp.unwrap(),
    );
    // The exact crossings on the same inputs (0.5% steps, then bisection, as the reference searches): the verdict's
    // coarser search reports a level at most 0.09% above each, so the keeper's trigger fires early.
    let inp = inputs_of(World::drill(10_000));
    let b = pb_risk::book::build(&inp).unwrap();
    let (eng, a, m) = (&b.engine, &b.account, &b.built.market);
    let exact = |k: f64| {
        let f = |x: f64| {
            let mut m2 = m.clone();
            m2.wrap.insert("nBTC".into(), 1.0 + x);
            let r = eng.requirement(a, &m2);
            r.e - k * r.mr
        };
        1.0 + band(f, 0.0, -0.99, 0.0, BAND_STEP).unwrap()
    };
    for (got, k) in [(im_bp, 1.25), (mr_bp, 1.0), (dl_bp, 0.8)] {
        let want = exact(k) * 1e4;
        assert!(
            got as f64 >= want && (got as f64) < want + 9.0,
            "{got} vs {want}"
        );
    }
    assert!(
        im_bp > 8_300 && mr_bp > 7_800 && mr_bp < 8_000 && dl_bp > 7_500,
        "{im_bp} {mr_bp} {dl_bp}"
    );
    for (bp, state) in [
        (8_300, "WATCH"),
        (7_800, "MARGIN_CALL"),
        (7_500, "DELEVERAGE"),
    ] {
        let v = verdict(&run(World::drill(bp), r#"{"check":{}}"#, false).0);
        assert_eq!(v.state, state, "{bp}");
    }
    // At 0.75 the plan repays the 10 mUSDC on NEAR, then buys back a quarter of the 0.015 BTC short through the
    // gateway: a reduce-only IOC half BTC's band above the reference price, rounded down to a whole dollar. On
    // testnet the band is 3% (INTERFACES.md 42), so that is 1.5% over the reference.
    let (out, _) = run(World::drill(7_500), r#"{"check":{}}"#, false);
    let v = verdict(&out);
    assert_eq!(
        (v.state.as_str(), v.action.as_str()),
        ("DELEVERAGE", "DELEVERAGE")
    );
    assert_eq!(v.plan[0], PlanStep::Repay { amt: 10_000_000 });
    let PlanStep::Perp { coin, buy, sz, px } = &v.plan[1] else {
        panic!("{out}")
    };
    assert_eq!((coin.as_str(), *buy, sz.as_str()), ("BTC", true, "0.00375"));
    let inp = inputs_of(World::drill(7_500));
    let b = pb_risk::book::build(&inp).unwrap();
    let reference = b.built.market.price("BTC");
    assert_eq!(
        px.parse::<f64>().unwrap(),
        (reference * 1.015).floor(),
        "{out}"
    );
    assert_eq!(v.plan.len(), 2);
    assert!(
        v.bands.is_empty() && v.top.len() <= 3 && v.arrived.is_empty(),
        "{out}"
    );
    assert!(out.len() < 2_000, "{} bytes", out.len());
    // The plan's text form (the reference's words) has the same two steps, at the same sizes.
    let (eng, a, m) = (&b.engine, &b.account, &b.built.market);
    let (text, after) = eng.deleverage_plan(a, m, 40);
    assert_eq!(text.len(), 2, "{text:?}");
    assert!(
        text[0].starts_with("repay $10 ") && text[1].starts_with("perp BTC: trade $28"),
        "{text:?}"
    );
    let plan = eng.deleverage_steps(a, m, 4, Routes::NO_ONE_CLICK);
    let Step::Trade(t) = &plan.steps[1] else {
        panic!("{:?}", plan.steps)
    };
    assert_eq!(wire_size(t.dq, 5).as_deref(), Some(sz.as_str()));
    assert_eq!(after.perps["BTC"], a.perps["BTC"] + t.dq);
    // After the plan the account is HEALTHY again, with the loan in place.
    let r = eng.requirement(&after, m);
    let st = eng.state(&after, m, &r, 0.0, Some(risk_core::State::Deleverage));
    assert_eq!(st.state, risk_core::State::Healthy);
    assert!(after.debt > 1_000.0);
}

#[test]
fn on_testnet_a_perp_step_is_priced_1_5_percent_from_the_reference_and_a_run_from_before_replays_at_half_a_percent() {
    // INTERFACES.md 42. The reader writes the floor its network gave into the inputs, and the plan prices from it.
    let inp = inputs_of(World::drill(7_500));
    assert_eq!(inp.band_floor, 0.03);
    assert!(inp.canonical().contains(r#""band_floor":0.03,"#));
    let reference = pb_risk::book::build(&inp).unwrap().built.market.price("BTC");
    let buy_back = |inp: &Inputs| -> (String, f64) {
        let v = verdict(&pb_risk::output(inp));
        let PlanStep::Perp { coin, buy, sz, px } = &v.plan[1] else {
            panic!("{:?}", v.plan)
        };
        assert_eq!((coin.as_str(), *buy), ("BTC", true));
        (sz.clone(), px.parse().unwrap())
    };
    let (sz, px) = buy_back(&inp);
    assert_eq!((sz.as_str(), px), ("0.00375", (reference * 1.015).floor()));
    // 1.5% over the reference, inside the 3% the gateway checks the step against.
    assert!(px / reference > 1.0149 && px / reference <= 1.015, "{px} {reference}");
    // A run saved before the floor has none in its inputs: its plan replays at half BTC's own 1%, and its inputs
    // hash as they did. Only the price differs: the size never depended on it.
    let mut before = inp.clone();
    before.band_floor = 0.0;
    assert!(!before.canonical().contains("band_floor"));
    assert_eq!(buy_back(&before), (sz, (reference * 1.005).floor()));
    // The committed drill fixture is such a run.
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/drill.json")).unwrap();
    assert!(text.contains(r#""px":"76379""#) && !text.contains("band_floor"));
    let (bytes, inputs) = split(text.trim_end());
    assert_eq!(pb_risk::output(&inputs), bytes);
}

#[test]
fn hysteresis_and_the_clock_come_from_the_account() {
    // Just above 0.8 × MR, but under the 2% hysteresis: after a DELEVERAGE verdict the account stays there.
    let v = |w: World| verdict(&run(w, r#"{"check":{}}"#, false).0);
    assert_eq!(v(World::drill(7_600)).state, "MARGIN_CALL");
    let after_dl = World {
        prev_state: Some("DELEVERAGE"),
        ..World::drill(7_600)
    };
    assert_eq!(v(after_dl).state, "DELEVERAGE");
    // The margin-call clock, as the account keeps it: over 4 hours below MR in the last 24 is DELEVERAGE.
    let now_ns = (T0_MS - 1_500) * 1_000_000;
    let hour = 3_600_000_000_000u64;
    let clock = |below: bool, hours: u64| World {
        prev_state: Some("MARGIN_CALL"),
        margin_call: Some(
            json!({"since": (now_ns - hours * hour).to_string(), "below": below,
            "intervals": [[(now_ns - hours * hour).to_string(), (now_ns - hour / 60).to_string()]]}),
        ),
        ..World::drill(7_800)
    };
    assert_eq!(v(clock(true, 3)).state, "MARGIN_CALL");
    let late = v(clock(true, 5));
    assert_eq!(
        (late.state.as_str(), late.action.as_str()),
        ("DELEVERAGE", "DELEVERAGE")
    );
    assert_eq!(late.since, now_ns - 5 * hour);
    // Time back above MR doesn't count: 5 hours since the call started, but only the last minute below.
    let dipped = World {
        prev_state: Some("MARGIN_CALL"),
        margin_call: Some(
            json!({"since": (now_ns - 5 * hour).to_string(), "below": true,
            "intervals": [[(now_ns - hour / 60).to_string(), (now_ns - hour / 60).to_string()]]}),
        ),
        ..World::drill(7_800)
    };
    assert_eq!(v(dipped).state, "MARGIN_CALL");
}

/// The drill book with `sent` of its nBTC sent to 1Click and still in transit, deadline `deadline_ms`.
fn selling(sent: u128, deadline_ms: u64) -> World {
    let mut w = World::drill(10_000);
    w.nbtc -= sent;
    w.pending = Some(
        json!([{"transfer": {"id": "276800123:1", "kind": "sell", "token": MNBTC,
        "amount": sent.to_string(), "dep": "ab", "deadline": (deadline_ms * 1_000_000).to_string()}}]),
    );
    w
}

#[test]
fn money_in_transit_counts_for_the_state_but_not_for_credit() {
    let v = |w: World| verdict(&run(w, r#"{"check":{}}"#, false).0);
    let held = v(World::drill(10_000));
    let moving = v(selling(500_000, T0_MS + 3_600_000));
    // A third of the nBTC is on its way to 1Click: the state counts it at 98%, credit at nothing.
    let third = held.pool.hold["nBTC"] as f64 / 3.0;
    assert!(
        ((held.eq - moving.eq) as f64 - 0.02 * third).abs() < 1e5,
        "{} {}",
        held.eq,
        moving.eq
    );
    assert!(((held.eq_allow - moving.eq_allow) as f64 - third).abs() < 1e6);
    assert!(
        moving.allow.borrow <= held.allow.borrow && moving.allow.withdraw < held.allow.withdraw
    );
    assert!(
        moving.top.iter().all(|t| !t.starts_with("overdue")),
        "{:?}",
        moving.top
    );
    // Past its deadline it counts as nothing, and `top` says so.
    let late = v(selling(500_000, T0_MS - 60_000));
    assert!(((held.eq - late.eq) as f64 - third).abs() < 1e6);
    assert!(
        late.top
            .contains(&"overdue: sell transfer 276800123:1".to_string()),
        "{:?}",
        late.top
    );
    // A transfer of a token the account doesn't hold is refused.
    let mut odd = World::drill(10_000);
    odd.pending = Some(
        json!([{"transfer": {"id": "move:1", "kind": "sell", "token": "usdt.tether-token.near",
        "amount": "1", "dep": "ab", "deadline": "1"}}]),
    );
    assert!(reason(&run(odd, r#"{"check":{}}"#, false).0).contains("isn't configured"));
}

#[test]
fn a_move_seen_on_hyperliquid_is_arrived() {
    // The owner moved 430 mUSDC to Hyperliquid; the stand-in delivered 429.60 (as on 8 Nov), so the margin there is
    // already counted. The verdict lists the move in `arrived`, and doesn't count it in transit too.
    let addr = "0x00000000000000000000000000000000000000aa";
    let to_hl = |id: &str, delivered: Option<&str>| {
        let mut w = World::drill(10_000);
        w.pending = Some(
            json!([{"transfer": {"id": id, "kind": "to_hl", "token": MUSDC,
            "amount": "430000000", "dep": "cd", "deadline": ((T0_MS + 1_800_000) * 1_000_000).to_string()}}]),
        );
        if let Some(usdc) = delivered {
            w.ledger = json!([{"time": T0_MS - 120_000, "hash": "0x1", "delta": {"type": "internalTransfer",
                "usdc": usdc, "user": "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d", "destination": addr, "fee": "0.0"}}]);
        }
        w
    };
    let move_to_hl = |delivered: Option<&str>| to_hl("move:1", delivered);
    let base = verdict(&run(World::drill(10_000), r#"{"check":{}}"#, false).0);
    let (out, net) = run(move_to_hl(Some("429.602143")), r#"{"check":{}}"#, false);
    let seen = verdict(&out);
    assert_eq!(seen.arrived, ["move:1"]);
    assert!(out.contains(r#""arrived":["move:1"]"#));
    assert_eq!((seen.eq, seen.eq_allow), (base.eq, base.eq_allow));
    // The ledger is read only while a move to Hyperliquid is pending: one more Hyperliquid call.
    assert_eq!(call_counts(&net)["hyperliquid"], 6);
    // A credit that is too small to be this move (or none at all): not arrived. The owner's own move counts
    // nothing while it travels (INTERFACES.md 40.3): the account records it as the owner states it. A plan step's
    // transfer, whose quote the engine made, counts at 98% for the state, as before.
    for delivered in [Some("100"), None] {
        let v = verdict(&run(move_to_hl(delivered), r#"{"check":{}}"#, false).0);
        assert!(v.arrived.is_empty());
        assert_eq!((v.eq, v.eq_allow), (base.eq, base.eq_allow));
        let planned = verdict(&run(to_hl("276800123:1", delivered), r#"{"check":{}}"#, false).0);
        assert!(planned.arrived.is_empty());
        assert!(
            ((planned.eq - base.eq) as f64 - 0.98 * 430e6).abs() < 1e3,
            "{} {}",
            planned.eq,
            base.eq
        );
        assert_eq!(planned.eq_allow, base.eq_allow);
    }
    // A plan step's transfer that Hyperliquid shows delivered is arrived the same way.
    let seen = verdict(&run(to_hl("276800123:1", Some("429.602143")), r#"{"check":{}}"#, false).0);
    assert_eq!((seen.arrived, seen.eq), (vec!["276800123:1".to_string()], base.eq));
}

#[test]
fn a_rebalance_on_testnet_says_what_it_would_move() {
    // $450 of margin under a $25k short: Hyperliquid's margin ratio is over 80%, so REBALANCE_NOW, though the account
    // is HEALTHY. Moving USDC needs a 1Click quote, which a run on testnet can't get: no step, and `top` says so.
    let w = World {
        hl_cash: 450.0,
        debt: 10_000_000_000,
        loans: 10_000_000_000,
        ..World::hedged()
    };
    let (out, _) = run(w, r#"{"check":{}}"#, false);
    let v = verdict(&out);
    assert_eq!(
        (v.state.as_str(), v.action.as_str()),
        ("HEALTHY", "REBALANCE_NOW")
    );
    assert!(v.venues.hl_margin_ratio_bp >= 8_000, "{out}");
    assert!(v.plan.is_empty());
    let note = v.top.last().unwrap();
    assert!(
        note.starts_with("plan: moving $")
            && note.ends_with("to Hyperliquid needs 1Click, which a testnet run can't reach"),
        "{out}"
    );
    assert!(!v.bands.is_empty() && out.len() < 2_000, "{out}");
}

/// The REBALANCE_NOW book above ($450 of margin under a $25k short), with one transfer `id` pending.
fn rebalance_world(id: &str, pending: Option<(&str, &str, u64)>) -> World {
    let mut w = World {
        hl_cash: 450.0,
        debt: 10_000_000_000,
        loans: 10_000_000_000,
        ..World::hedged()
    };
    if let Some((kind, token, amount)) = pending {
        w.pending = Some(
            json!([{"transfer": {"id": id, "kind": kind, "token": token,
            "amount": amount.to_string(), "dep": "cd",
            "deadline": ((T0_MS + 1_800_000) * 1_000_000).to_string()}}]),
        );
    }
    w
}

/// The action, and the dollars the `top` line says the plan would move.
fn asks(w: World) -> (String, Option<f64>) {
    let v = verdict(&run(w, r#"{"check":{}}"#, false).0);
    let usd = v.top.iter().find_map(|t| {
        let rest = t.strip_prefix("plan: moving $")?;
        rest.split(' ').next()?.replace(',', "").parse::<f64>().ok()
    });
    (v.action, usd)
}

#[test]
fn a_rebalance_counts_a_move_to_hyperliquid_already_under_way() {
    // The REBALANCE_NOW book above, with one transfer of a plan step pending. pb-read marks a `to_hl` transfer as
    // going to Hyperliquid, and the engine takes 98% of it off what it would move (since 9 Nov), so a check while a
    // top-up is in transit doesn't ask for it again. The trigger stays. A move home, or a sale, lands on NEAR: it
    // doesn't count.
    let world = |pending| rebalance_world("276800123:1", pending);
    let (action, base) = asks(world(None));
    assert_eq!(action, "REBALANCE_NOW");
    let base = base.expect("the plan says what it would move");
    let (action, less) = asks(world(Some(("to_hl", MUSDC, 300_000_000))));
    assert_eq!(action, "REBALANCE_NOW");
    let less = less.expect("still short");
    assert!((base - less - 294.0).abs() <= 1.0, "{base} {less}");
    let enough = ((base + 10.0) / 0.98 * 1e6) as u64;
    assert_eq!(
        asks(world(Some(("to_hl", MUSDC, enough)))),
        ("REBALANCE_NOW".to_string(), None)
    );
    for (kind, token, amount) in [("home", MUSDC, 300_000_000), ("sell", MNBTC, 1_000)] {
        assert_eq!(
            asks(world(Some((kind, token, amount)))),
            ("REBALANCE_NOW".to_string(), Some(base)),
            "{kind}"
        );
    }
}

#[test]
fn a_rebalance_does_not_count_an_owners_own_move_as_margin_on_its_way() {
    // The same book. The owner's own move to Hyperliquid (`move:<n>`) is a record the account keeps as the owner
    // states it: it may never have left (research/audit.md, A7). So it is no margin on its way: the plan asks for
    // the whole amount, whatever the move says it is bringing.
    let base = asks(rebalance_world("move:1", None));
    assert_eq!(base.0, "REBALANCE_NOW");
    let whole = base.1.expect("the plan says what it would move");
    assert_eq!(asks(rebalance_world("move:1", Some(("to_hl", MUSDC, 300_000_000)))), base);
    let all_of_it = ((whole + 10.0) / 0.98 * 1e6) as u64;
    assert_eq!(asks(rebalance_world("move:1", Some(("to_hl", MUSDC, all_of_it)))), base);
    // A plan step's transfer of the same size is counted, as before: nothing more is asked for.
    assert_eq!(
        asks(rebalance_world("276800123:1", Some(("to_hl", MUSDC, all_of_it)))),
        ("REBALANCE_NOW".to_string(), None)
    );
}

#[test]
fn an_owners_own_move_props_up_nothing_and_a_plan_steps_transfer_counts_as_before() {
    // research/audit.md, A7. 0.3 nBTC ($22,800) against a $21,000 loan: about $1,800 of equity under a maintenance
    // margin of several thousand dollars. The account is not healthy.
    let book = |pending: Option<Value>| World {
        usdc: 0,
        debt: 21_000_000_000,
        loans: 21_000_000_000,
        counter: 2,
        pending,
        ..World::deposits()
    };
    let v = |w: World| verdict(&run(w, r#"{"check":{}}"#, false).0);
    let real = v(book(None));
    assert!(real.eq < real.mm && real.eq > 0, "{} {}", real.eq, real.mm);
    assert_ne!(real.state, "HEALTHY");
    // The owner records a move of $1,000,000 "on its way home" that was never there: `move:0`, not overdue (the
    // contract checks only its expiry). Before 12 Nov every verdict added $980,000 to mark equity, and the account
    // read as healthy. Now the owner's own move counts nothing: the verdict is the real book's, figure for figure.
    let transfer = |id: &str| {
        Some(json!([{"transfer": {"id": id, "kind": "home", "token": "USDC", "amount": "1000000000000",
            "dep": "0xcd", "deadline": ((T0_MS + 1_800_000) * 1_000_000).to_string()}}]))
    };
    let propped = v(book(transfer("move:0")));
    assert_ne!(propped.state, "HEALTHY");
    assert_eq!(
        (propped.eq, propped.eq_allow, propped.mm, &propped.state, &propped.action, &propped.allow),
        (real.eq, real.eq_allow, real.mm, &real.state, &real.action, &real.allow)
    );
    // It isn't overdue, so `top` doesn't name it. Past its deadline it is named, as any transfer is.
    assert!(propped.top.iter().all(|t| !t.starts_with("overdue")), "{:?}", propped.top);
    let mut late = book(transfer("move:0"));
    late.pending.as_mut().unwrap()[0]["transfer"]["deadline"] = json!(((T0_MS - 60_000) * 1_000_000).to_string());
    assert!(v(late).top.contains(&"overdue: home transfer move:0".to_string()));
    // The same amount as a plan step's transfer, whose quote the engine made, counts as before: 98% of it toward
    // the state, nothing toward credit. Both kinds of plan id.
    for id in ["276800123:0", "f123:0"] {
        let planned = v(book(transfer(id)));
        assert_eq!(planned.state, "HEALTHY", "{id}");
        assert!((planned.eq - real.eq - 980_000_000_000).abs() <= 1, "{id}: {} {}", planned.eq, real.eq);
        assert!((planned.eq_allow - real.eq_allow).abs() <= 1, "{id}: {} {}", planned.eq_allow, real.eq_allow);
    }
}

#[test]
fn the_drill_ratio_is_the_accounts_own_with_a_fallback_for_the_old_drill() {
    // INTERFACES.md 21. The new drill answers get_ratio_for: one NEAR call, as before.
    let (new, net) = run(World::deposits(), r#"{"check":{}}"#, false);
    assert!(net
        .calls
        .iter()
        .any(|c| c.ends_with("drill.pbf-ops.testnet.get_ratio_for")));
    assert_eq!(call_counts(&net)["near"], 10);
    // The drill deployed before Phase 5 has no get_ratio_for: pb-risk asks get_ratio instead, one call more, and
    // the verdict is the same.
    let old = World {
        drill_old: true,
        ..World::deposits()
    };
    let (out, net) = run(old, r#"{"check":{}}"#, false);
    assert!(net
        .calls
        .iter()
        .any(|c| c.ends_with("drill.pbf-ops.testnet.get_ratio")));
    assert_eq!(call_counts(&net)["near"], 11);
    let (a, b) = (verdict(&new), verdict(&out));
    assert_eq!((a.eq, a.mm, a.credit.line), (b.eq, b.mm, b.credit.line));
    assert!(b.coins.reduce_only.is_empty(), "{out}");
    // The account's own ratio wins over the shared one: 0.9 for this account only.
    let own = World {
        drill_own_bp: Some(9_000),
        ..World::deposits()
    };
    let low = verdict(&run(own, r#"{"check":{}}"#, false).0);
    let nbtc_value = a.pool.hold["nBTC"] as f64;
    assert!(((a.eq - low.eq) as f64 - 0.1 * nbtc_value).abs() < 1e6);
    // A drill that can't be read at all still leaves π unread: 0.80 and reduce-only.
    let none = World {
        drill_bp: None,
        ..World::deposits()
    };
    let (out, _) = run(none, r#"{"check":{}}"#, true);
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["verdict"]["coins"]["reduce_only"], json!(["nBTC"]));
    assert_eq!(
        v["inputs"]["errors"],
        json!(["account drill.pbf-ops.testnet does not exist on testnet"])
    );
}
