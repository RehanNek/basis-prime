//! The book stress test (INTERFACES.md 19) end to end, natively, against the pretend testnet of tests/common:
//! the factory lists the accounts, the pool knows their loans, and each is read as `check` reads it.
mod common;

use common::*;
use pb_risk::stress::{self, BookResult};
use serde_json::Value;

const BOOK: &str = r#"{"mode":"book","network":"testnet"}"#;

fn book(world: World) -> (String, MockNet) {
    let mut net = MockNet::new(world);
    let out = pb_risk::run(BOOK, &mut net);
    (out, net)
}

fn result(out: &str) -> BookResult {
    serde_json::from_str(out).unwrap_or_else(|e| panic!("not a book result ({e}): {out}"))
}

fn reason(out: &str) -> String {
    let v: Value = serde_json::from_str(out).unwrap();
    assert_eq!(v["ok"], false, "{out}");
    v["reason"].as_str().unwrap().to_string()
}

#[test]
fn with_no_loan_the_book_passes_and_has_no_worst_day() {
    let (out, net) = book(World::deposits());
    let r = result(&out);
    assert!(
        r.ok && r.pass && r.worst.is_none() && r.top.is_empty(),
        "{out}"
    );
    assert!(r.accounts.is_empty());
    assert_eq!(
        (r.capital, r.loans, r.limit),
        (200_000_000_000, 0, 5_000_000_000)
    );
    // The block, the factory's list and count, the pool's three views, and the pool's record of the one account.
    assert_eq!(net.calls.len(), 7, "{:?}", net.calls);
}

#[test]
fn one_hedged_account_is_valued_as_check_values_it() {
    let (out, net) = book(World::hedged());
    let r = result(&out);
    let v: Value = serde_json::from_str(&run(World::hedged(), r#"{"check":{}}"#, false).0).unwrap();
    assert_eq!(r.accounts.len(), 1);
    let a = &r.accounts[0];
    assert_eq!((a.acct.as_str(), a.debt), (ACCOUNT, 24_000_004_567));
    assert_eq!(a.eq, v["eq"].as_i64().unwrap());
    // The demo book inside its line: no day of the 25 costs the pool anything, so there is no worst day.
    assert_eq!(r.days, 25, "{out}");
    assert!(r.pass && r.worst.is_none() && r.top.is_empty(), "{out}");
    assert!(out.len() < 2_000, "{} bytes", out.len());
    // One account: 19 calls past the filter (5 NEAR, 4 Hyperliquid), and the prices once (12 + 1).
    assert_eq!(call_counts(&net)["near"], 1 + 5 + 1 + 3 + 2);
    assert_eq!(call_counts(&net)["hyperliquid"], 4 + 1);
    assert_eq!(call_counts(&net)["get"], 12);
}

/// A loan past the line: $24,000 against $5,000 of mUSDC and 0.3 nBTC, unhedged.
fn over_lent() -> World {
    World {
        debt: 24_000_000_000,
        loans: 24_000_000_000,
        ..World::deposits()
    }
}

#[test]
fn accounts_that_sell_together_cost_more_than_alone() {
    let (out, _) = book(over_lent());
    let alone = result(&out);
    // The 12 Mar 2020 crash, replayed, leaves less than is owed.
    let w1 = alone.worst.clone().unwrap();
    assert!(w1.scenario.starts_with("replay 2020-03-12 down"), "{out}");
    assert!(w1.pool_loss > 1_000_000_000, "{out}");
    let (out, net) = book(World {
        copies: vec!["bob.pbf.testnet"],
        ..over_lent()
    });
    let two = result(&out);
    assert_eq!(two.accounts.len(), 2);
    assert_eq!(two.accounts[1].acct, "bob.pbf.testnet");
    // Each pays the cost of the whole book's sale, after a bigger shock: more than twice one alone.
    let w2 = two.worst.unwrap();
    assert!(
        w2.pool_loss > 2 * w1.pool_loss,
        "{} vs {}",
        w2.pool_loss,
        w1.pool_loss
    );
    assert!(two.top.len() <= 5 && two.top.iter().all(|d| d.pool_loss > 0));
    assert_eq!(two.top[0], w2);
    // 2.5% of $200k is $5,000.
    assert_eq!(two.pass, w2.pool_loss <= 5_000_000_000);
    // The prices were read once for both.
    assert_eq!(call_counts(&net)["get"], 12);
    assert_eq!(call_counts(&net)["near"], 1 + 5 + 2 + 2 * 3 + 2 * 2);
}

#[test]
fn past_ten_accounts_with_loans_it_says_so() {
    let copies: Vec<&'static str> = vec![
        "a1.pbf.testnet",
        "a2.pbf.testnet",
        "a3.pbf.testnet",
        "a4.pbf.testnet",
        "a5.pbf.testnet",
        "a6.pbf.testnet",
        "a7.pbf.testnet",
        "a8.pbf.testnet",
        "a9.pbf.testnet",
        "a10.pbf.testnet",
    ];
    let (out, _) = book(World {
        copies: copies.clone(),
        ..World::hedged()
    });
    assert_eq!(
        reason(&out),
        "11 accounts have a loan; version 0's book stress test reads at most 10"
    );
    // Ten fit: nine copies and the account itself.
    let (out, net) = book(World {
        copies: copies[..9].to_vec(),
        ..World::hedged()
    });
    assert_eq!(result(&out).accounts.len(), 10);
    // 119 calls for ten hedged accounts and one coin (INTERFACES.md 19, "As built"), sent 8 at a time: about 3 s
    // of reads at 150 ms a call.
    assert_eq!(net.calls.len(), 119, "{:?}", call_counts(&net));
    assert!(net.clock_ms - T0_MS < 4_000, "{} ms", net.clock_ms - T0_MS);
    // One at a time they take 18 s: past the reads' budget, so the run says so rather than leave accounts out.
    let mut one_by_one = MockNet::new(World {
        copies: copies[..9].to_vec(),
        ..World::hedged()
    });
    one_by_one.overlap = false;
    let out = pb_risk::run(BOOK, &mut one_by_one);
    assert!(
        reason(&out).starts_with("out of time after reading 10 accounts"),
        "{out}"
    );
}

#[test]
fn the_old_drill_is_read_once_for_every_account() {
    let (out, net) = book(World {
        drill_old: true,
        copies: vec!["bob.pbf.testnet"],
        ..World::hedged()
    });
    assert_eq!(result(&out).accounts.len(), 2);
    let shared = net
        .calls
        .iter()
        .filter(|c| c.ends_with("drill.pbf-ops.testnet.get_ratio"))
        .count();
    assert_eq!(shared, 1);
}

#[test]
fn the_snapshot_replays_and_mainnet_is_refused() {
    let mut net = MockNet::new(World::hedged());
    let out = pb_risk::run(
        r#"{"mode":"book","network":"testnet","snapshot":true}"#,
        &mut net,
    );
    let v: Value = serde_json::from_str(&out).unwrap();
    let inputs: pb_read::stress::BookInputs = serde_json::from_value(v["inputs"].clone()).unwrap();
    assert_eq!(stress::snapshot(&inputs), out);
    let printed = stress::output(&inputs);
    assert_eq!(result(&printed).inputs, inputs.hash());
    assert_eq!(printed, book(World::hedged()).0);
    let mut net = MockNet::new(World::hedged());
    assert!(reason(&pb_risk::run(
        r#"{"mode":"book","network":"mainnet"}"#,
        &mut net
    ))
    .contains("testnet only"));
    assert!(net.calls.is_empty());
    assert!(reason(&pb_risk::run_for(BOOK, &mut net, true)).contains("HTTPS API only"));
}

/// Not a check: how long the decide step takes natively for ten accounts (hedged, and over-lent), and the result.
///   cargo test --release -p pb-risk --test book time_ten_accounts -- --ignored --nocapture
#[test]
#[ignore]
fn time_ten_accounts() {
    let copies = vec![
        "a1.pbf.testnet",
        "a2.pbf.testnet",
        "a3.pbf.testnet",
        "a4.pbf.testnet",
        "a5.pbf.testnet",
        "a6.pbf.testnet",
        "a7.pbf.testnet",
        "a8.pbf.testnet",
        "a9.pbf.testnet",
    ];
    for world in [World::hedged(), over_lent()] {
        let mut net = MockNet::new(World {
            copies: copies.clone(),
            ..world
        });
        let out = pb_risk::run(
            r#"{"mode":"book","network":"testnet","snapshot":true}"#,
            &mut net,
        );
        let v: Value = serde_json::from_str(&out).unwrap();
        let inputs: pb_read::stress::BookInputs =
            serde_json::from_value(v["inputs"].clone()).unwrap();
        let t = std::time::Instant::now();
        let printed = stress::output(&inputs);
        println!(
            "{} calls; decide {:?}; inputs {} B; result {} B; {printed}",
            net.calls.len(),
            t.elapsed(),
            inputs.canonical().len(),
            printed.len()
        );
    }
}
