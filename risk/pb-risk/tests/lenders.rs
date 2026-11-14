//! pb-risk deciding with lenders in the book (FUNDING.md 6.2 to 6.6, INTERFACES.md 27).
//!
//! The reads of the lenders are pb-read's. Here the book is built from the pretend world as always, and what it
//! holds at the lenders is set by hand, the way pb-read's header says the book counts it: the whole debt in
//! `account.debt`, lender collateral in `account.near`, our pool's debt alone in `debt_micro`.
//!
//! The numbers are FUNDING.md's worked example: $100,000 of bitcoin, a $100,000 short on Hyperliquid with $35,000
//! of margin, and a Standard line of 70% of the $135,000: $94,500.
mod common;

use common::*;
use pb_read::lenders::{Holding, LenderBook, LenderPos};
use pb_risk::book::{self, Book};
use pb_risk::lenders::MAX_FUND_STEPS;
use pb_risk::steps::PlanStep;
use pb_risk::verdict::{compute_book, MAX_VERDICT_BYTES};
use pb_risk::{Inputs, Verdict};
use serde_json::{json, Value};

const USD: u128 = 1_000_000;
const MNBTC: &str = "mnbtc.pbf-ops.testnet";
const WBTC: &str = "0x54114591963cf60ef3aa63befd6ec263d98145a4";
const EVM_USDC: &str = "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f";
/// The pretend world's bitcoin price, and $100,000 of bitcoin in satoshis.
const BTC: f64 = 76_000.0;
const SATS: u128 = 131_578_947;

/// The worked example before any loan, in a pool big enough that its own limits don't bind, and 60% lent, so a
/// Standard client pays 6.50%.
fn example() -> World {
    let q = SATS as f64 / 1e8;
    World {
        usdc: 0,
        nbtc: SATS,
        debt: 0,
        loans: 6_000_000 * USD,
        capital: 10_000_000 * USD,
        counter: 3,
        hl: Some(("0x00000000000000000000000000000000000000aa", -q, BTC)),
        hl_cash: 35_000.0,
        hourly: json!([{"hour": T0_MS / 3_600_000 - 1, "hr_bp_min": 10_000, "exp_bp_max": 20_000}]),
        ..World::deposits()
    }
}

/// A world's snapshot inputs, asked with `intent`.
fn inputs_of(world: World, intent: &str) -> Inputs {
    let (out, _) = run(world, intent, true);
    let v: Value = serde_json::from_str(&out).unwrap();
    serde_json::from_value(v["inputs"].clone()).unwrap()
}

/// The inputs with the pool's funding order set (`get_params().funding`).
fn with_order(mut inp: Inputs, order: &str) -> Inputs {
    inp.near.params["funding"] = json!({"order": order, "loan_days": 90});
    inp
}

fn sats(raw: u128, engine: &str, id: &str) -> Holding {
    Holding {
        engine: engine.into(),
        id: id.into(),
        decimals: 8,
        raw,
    }
}

/// Rhea, permitted, nothing there yet: the account's bitcoin on NEAR is spare collateral for it.
fn rhea() -> LenderPos {
    LenderPos {
        lender: "rhea".into(),
        permitted: true,
        spare: vec![sats(SATS, "nBTC", MNBTC)],
        spare_micro: 100_000 * USD,
        liq_bp: 7_600,
        rate_bp: 1_591,
        supply_bp: 1_032,
        free_micro: 2_000_000 * USD,
        ..LenderPos::default()
    }
}

/// Aave, permitted, nothing there yet: the same bitcoin, as WBTC at the account's Ethereum address.
fn aave() -> LenderPos {
    LenderPos {
        lender: "aave".into(),
        permitted: true,
        spare: vec![sats(SATS, "WBTC", WBTC)],
        spare_micro: 100_000 * USD,
        liq_bp: 8_500,
        rate_bp: 533,
        supply_bp: 410,
        free_micro: 150_000_000 * USD,
        ..LenderPos::default()
    }
}

/// The app's default permission over these positions.
fn permitted(positions: Vec<LenderPos>) -> LenderBook {
    LenderBook {
        positions,
        min_hf_bp: Some(15_000),
        max_rate_bp: Some(2_500),
        ..LenderBook::default()
    }
}

/// `pos` after its bitcoin was posted and `debt_micro` borrowed against it.
fn drawn(pos: LenderPos, debt_micro: u128) -> LenderPos {
    LenderPos {
        posted: pos.spare.clone(),
        posted_micro: pos.spare_micro,
        spare: Vec::new(),
        spare_micro: 0,
        debt_micro,
        ..pos
    }
}

/// The book of `inp` with `lenders` at the lenders, `pool_debt_micro` owed to our pool, and the whole debt in
/// the engine's account.
fn book_with(inp: &Inputs, lenders: LenderBook, pool_debt_micro: u128) -> Book {
    let mut b = book::build(inp).unwrap();
    b.debt_micro = pool_debt_micro;
    b.account.debt = (pool_debt_micro + lenders.owed_micro()) as f64 / 1e6;
    b.lenders = lenders;
    b
}

/// The same book with its bitcoin at the account's Ethereum address as WBTC, not on NEAR.
fn on_ethereum(inp: &mut Inputs, mut b: Book) -> Book {
    inp.near.balances.insert(MNBTC.to_string(), json!("0"));
    b.account.near.insert("nBTC", 0.0);
    b.account.near.insert("WBTC", SATS as f64 / 1e8);
    b.lenders.locked.insert("WBTC".into(), SATS);
    b
}

fn decide(inp: &Inputs, lenders: LenderBook, pool_debt_micro: u128) -> Verdict {
    compute_book(book_with(inp, lenders, pool_debt_micro), inp).unwrap()
}

fn json_of(v: &Verdict) -> String {
    serde_json::to_string(v).unwrap()
}

const CHECK: &str = r#"{"check":{}}"#;
const FUND: &str = r#"{"fund":{"amount":"94500000000"}}"#;

#[test]
fn an_account_with_no_lenders_gets_todays_verdict_to_the_byte() {
    for world in [
        World::deposits(),
        World::loan(),
        World::hedged(),
        World::drill(7_500),
        example(),
    ] {
        let inp = inputs_of(world, CHECK);
        let today = pb_risk::output(&inp);
        let split = json_of(&compute_book(book::build(&inp).unwrap(), &inp).unwrap());
        assert_eq!(split, today);
        for field in ["\"ext\"", "\"fund\"", "\"evm\""] {
            assert!(!today.contains(field), "{field} in {today}");
        }
    }
}

#[test]
fn the_worked_example_has_a_94_500_line() {
    let inp = inputs_of(example(), CHECK);
    let v = pb_risk::compute(&inp).unwrap();
    assert_eq!((v.state.as_str(), v.tier.as_str()), ("HEALTHY", "STANDARD"));
    assert_eq!(v.credit.binding, "C4");
    // 70% of $100,000 of bitcoin and $35,000 of margin, to within the short's few dollars of profit or loss.
    assert!(
        v.allow.borrow.abs_diff(94_500 * USD) < 200 * USD,
        "{}",
        v.allow.borrow
    );
    assert_eq!(v.credit.line, v.allow.borrow);
    assert_eq!(v.rate_bp, 650);
}

#[test]
fn a_cheaper_lender_fills_first_and_our_pool_lends_the_rest() {
    // Aave at 5.33% is cheaper than our pool, so it lends all it can at a cushion of 1.5: $56,667.
    let inp = inputs_of(example(), FUND);
    let line = pb_risk::compute(&inp).unwrap().allow.borrow;
    let v = decide(&inp, permitted(vec![aave()]), 0);
    let lends = 56_666_666_666;
    let ask = (94_500 * USD).min(line);
    assert_eq!(
        v.fund,
        vec![
            PlanStep::LSupply {
                l: "aave".into(),
                tok: WBTC.into(),
                amt: SATS.to_string()
            },
            PlanStep::LBorrow {
                l: "aave".into(),
                amt: lends
            },
            PlanStep::PBorrow {
                amt: (ask - u128::from(lends)) as u64
            },
        ]
    );
    assert_eq!(v.allow.fund, Some(ask));
    assert_eq!(v.ext.len(), 1);
    assert_eq!(
        (v.ext[0].l.as_str(), v.ext[0].room, v.ext[0].hf_bp),
        // Nothing is posted there yet, so `room` is still 0: the plan posts first, and the check the keeper asks for
        // before the borrow step shows the room.
        ("aave", 0, 0)
    );
    let said = v.top.last().unwrap();
    assert!(
        said.starts_with("funding: aave lends $56,667 at 5.33% (cheaper than our pool's "),
        "{said}"
    );
    assert!(said.contains("; our pool lends $"), "{said}");
    // The pool trusts `allow.borrow`: it is still the whole line while nothing is drawn.
    assert_eq!(v.allow.borrow, line);
    assert!(v.plan.is_empty() && v.action == "NONE");
}

#[test]
fn a_dearer_lender_waits_behind_our_pool_unless_the_operator_puts_it_first() {
    let inp = inputs_of(example(), FUND);
    let line = pb_risk::compute(&inp).unwrap().allow.borrow;
    let ask = (94_500 * USD).min(line);
    // Rhea at 15.91% is dearer than our pool, which can lend it all.
    let v = decide(&inp, permitted(vec![rhea()]), 0);
    assert_eq!(v.fund, vec![PlanStep::PBorrow { amt: ask as u64 }]);
    assert_eq!(v.allow.fund, Some(ask));
    assert_eq!(v.ext[0].room, 0);
    // `lender_first`: Rhea lends $50,667 at a cushion of 1.5, against just enough of the bitcoin.
    let first = with_order(inp.clone(), "lender_first");
    let v = decide(&first, permitted(vec![rhea()]), 0);
    assert_eq!(
        v.fund,
        vec![
            PlanStep::LSupply {
                l: "rhea".into(),
                tok: MNBTC.into(),
                amt: SATS.to_string()
            },
            PlanStep::LBorrow {
                l: "rhea".into(),
                amt: 50_666_666_666
            },
            PlanStep::PBorrow {
                amt: (ask - 50_666_666_666) as u64
            },
        ]
    );
    assert!(v
        .top
        .last()
        .unwrap()
        .contains("rhea lends $50,667 at 15.91% (the operator puts lenders first)"));
    // With both permitted, the cheaper one is the one used.
    let v = decide(&first, permitted(vec![aave(), rhea()]), 0);
    assert!(matches!(&v.fund[1], PlanStep::LBorrow { l, amt: 56_666_666_666 } if l == "aave"));
    assert_eq!(v.ext.len(), 2);
    // A smaller request posts only the collateral it needs: $10,000 at 1.5 needs $19,736.85 of bitcoin.
    let small = with_order(
        inputs_of(example(), r#"{"fund":{"amount":"10000000000"}}"#),
        "lender_first",
    );
    let v = decide(&small, permitted(vec![rhea()]), 0);
    assert_eq!(
        v.fund,
        vec![
            PlanStep::LSupply {
                l: "rhea".into(),
                tok: MNBTC.into(),
                amt: "25969530".into()
            },
            PlanStep::LBorrow {
                l: "rhea".into(),
                amt: 10_000_000_000
            },
        ]
    );
    assert_eq!(v.allow.fund, Some(10_000 * USD));
}

#[test]
fn the_two_calls_keep_our_pools_limits_off_the_lenders_money() {
    // The same book in a $100,000 pool: one client may have a quarter of it, so our pool's room is $25,000.
    let small_pool = World {
        capital: 100_000 * USD,
        loans: 0,
        ..example()
    };
    let inp = inputs_of(small_pool, FUND);
    let alone = pb_risk::compute(&inp).unwrap();
    assert_eq!(
        (alone.allow.borrow, alone.credit.binding.as_str()),
        (25_000 * USD, "C6")
    );
    // The book can still carry the whole line, so Rhea lends what our pool can't.
    let v = decide(&inp, permitted(vec![rhea()]), 0);
    assert_eq!(
        (v.allow.borrow, v.credit.binding.as_str()),
        (25_000 * USD, "C6")
    );
    assert_eq!(v.ext[0].room, 0);
    assert_eq!(
        v.fund[1..],
        [
            PlanStep::LBorrow {
                l: "rhea".into(),
                amt: 50_666_666_666
            },
            PlanStep::PBorrow {
                amt: 25_000_000_000
            }
        ]
    );
    assert_eq!(v.allow.fund, Some(75_666_666_666));
    assert!(
        v.top
            .last()
            .unwrap()
            .contains("(what our pool's own limits leave)"),
        "{:?}",
        v.top
    );
    // Once Rhea has lent, the whole debt counts against the book, but only our pool's against its limits.
    let after = decide(&inp, permitted(vec![drawn(rhea(), 50_666_666_666)]), 0);
    assert_eq!(
        (after.allow.borrow, after.credit.binding.as_str()),
        (25_000 * USD, "C6")
    );
    assert_eq!(after.credit.line, 75_666_666_666);
    assert_eq!(
        (after.ext[0].d, after.ext[0].hf_bp, after.ext[0].room),
        (50_666_666_666, 15_000, 0)
    );
}

#[test]
fn once_the_bitcoin_is_posted_the_verdict_shows_what_the_lender_may_lend_against_it() {
    // The funding plan's `l_supply` has run: the bitcoin is posted at Aave and nothing is borrowed yet. The check
    // before the `l_borrow` step shows $56,667 of room, and the account's step borrows at most that.
    let inp = inputs_of(example(), CHECK);
    let v = decide(&inp, permitted(vec![drawn(aave(), 0)]), 0);
    assert_eq!((v.ext[0].room, v.ext[0].c, v.ext[0].d), (56_666_666_666, 100_000 * USD, 0));
    // With $40,000 already borrowed there, $16,667 is left.
    let v = decide(&inp, permitted(vec![drawn(aave(), 40_000 * USD)]), 0);
    assert_eq!(v.ext[0].room, 16_666_666_666);
    // At the target cushion, nothing.
    let v = decide(&inp, permitted(vec![drawn(aave(), 56_666_666_666)]), 0);
    assert_eq!((v.ext[0].room, v.ext[0].hf_bp), (0, 15_000));
}

#[test]
fn the_whole_debt_counts_against_the_book() {
    let inp = inputs_of(example(), CHECK);
    let line = pb_risk::compute(&inp).unwrap().allow.borrow;
    // Aave lent $56,667. Our pool is owed nothing, yet only the rest of the line is left.
    let lent = 56_666_666_666;
    let v = decide(&inp, permitted(vec![drawn(aave(), lent)]), 0);
    assert_eq!(v.credit.binding, "C4");
    assert!(
        v.allow.borrow.abs_diff(line - lent) < 30 * USD,
        "{} of {line}",
        v.allow.borrow
    );
    assert_eq!(v.credit.line, lent + v.allow.borrow);
    // With $20,000 from our pool too, the whole debt is $76,667.
    let both = decide(&inp, permitted(vec![drawn(aave(), lent)]), 20_000 * USD);
    assert_eq!(both.credit.line, lent + 20_000 * USD + both.allow.borrow);
    assert!(both.allow.borrow < v.allow.borrow);
    // A lender dearer than our pool costs a week of the difference: the same debt at Rhea's rate leaves less.
    let dear = LenderPos {
        rate_bp: 1_591,
        ..drawn(aave(), lent)
    };
    let d = decide(&inp, permitted(vec![dear]), 0);
    let less = v.allow.borrow - d.allow.borrow;
    assert!(less > 50 * USD && less < 200 * USD, "{less}");
}

#[test]
fn nothing_is_lent_when_the_account_is_not_healthy_or_a_price_is_uncertain() {
    // One exchange answering: the price is uncertain, so there is no new risk.
    let blind = World {
        down: vec!["okx", "bybit", "coinbase", "kraken"],
        ..example()
    };
    let inp = inputs_of(blind, FUND);
    let v = decide(&inp, permitted(vec![aave()]), 0);
    if v.coins.uncertain.is_empty() {
        panic!(
            "the pretend world's price should be uncertain: {}",
            json_of(&v)
        );
    }
    assert!(v.fund.is_empty());
    assert_eq!(v.allow.fund, Some(0));
    assert_eq!((v.allow.borrow, v.ext[0].room), (0, 0));
    assert_eq!(
        v.top.last().unwrap(),
        "funding: nothing is lent while a held coin's price is uncertain"
    );
    // Over the line: the account isn't HEALTHY, so no lender has room and nothing is funded.
    let inp = inputs_of(example(), FUND);
    let v = decide(&inp, permitted(vec![rhea()]), 128_000 * USD);
    assert_ne!(v.state, "HEALTHY");
    assert!(v.fund.is_empty());
    assert_eq!((v.allow.fund, v.ext[0].room), (Some(0), 0));
    assert!(v
        .top
        .last()
        .unwrap()
        .starts_with("funding: nothing is lent while the account is "));
    // A check, not a fund request: no `fund` in `allow`.
    let v = decide(&inputs_of(example(), CHECK), permitted(vec![rhea()]), 0);
    assert_eq!(v.allow.fund, None);
    assert!(!json_of(&v).contains("\"fund\""));
}

#[test]
fn a_thin_cushion_adds_a_rebalance_with_the_top_up_first() {
    let inp = inputs_of(example(), CHECK);
    // Bitcoin's value at Rhea fell to $85,000 against $50,667: a cushion of 1.27, under 1.35.
    let thin = LenderPos {
        posted_micro: 85_000 * USD,
        cash_micro: 20_000 * USD,
        ..drawn(rhea(), 50_667 * USD)
    };
    let v = decide(&inp, permitted(vec![thin.clone()]), 0);
    assert_eq!(
        (v.state.as_str(), v.action.as_str()),
        ("HEALTHY", "REBALANCE")
    );
    assert_eq!(
        v.plan,
        vec![PlanStep::LRepay {
            l: "rhea".into(),
            amt: 7_600_333_334
        }]
    );
    assert!(
        v.top
            .iter()
            .any(|t| t
                == "rhea: cushion 1.27 is under 1.35; repaying $7,600 brings it back to 1.50"),
        "{:?}",
        v.top
    );
    assert_eq!(v.ext[0].hf_bp, 12_749);
    // Under 1.2 it is REBALANCE_NOW, and a cancelled permission doesn't stop it.
    let thinner = LenderPos {
        posted_micro: 75_000 * USD,
        permitted: false,
        ..thin
    };
    let lb = LenderBook {
        positions: vec![thinner],
        ..LenderBook::default()
    };
    let v = decide(&inp, lb, 0);
    assert_eq!(v.action, "REBALANCE_NOW");
    assert_eq!(
        v.plan,
        vec![PlanStep::LRepay {
            l: "rhea".into(),
            amt: 12_667_000_000
        }]
    );
    assert_eq!(v.ext[0].room, 0);
    assert!(v.plan.len() <= 4);
}

#[test]
fn usdc_leaves_the_ethereum_address_only_up_to_what_is_there() {
    // $5,000 of USDC sits at the Ethereum address, where a lender's loan lands; our pool is owed $20,000.
    let answer = |units: u128| -> Verdict {
        let intent = format!(r#"{{"evm_withdraw":{{"token":"{EVM_USDC}","amount":"{units}"}}}}"#);
        let mut inp = inputs_of(example(), &intent);
        let lb = permitted(vec![LenderPos {
            cash_micro: 5_000 * USD,
            ..aave()
        }]);
        let mut b = book_with(&inp, lb, 20_000 * USD);
        b.account.near.insert("USDC", 5_000.0);
        b.lenders.locked.insert("USDC".into(), 5_000 * USD);
        // The config names Aave's USDC (INTERFACES.md 24), in the mixed case its address is written in.
        inp.near.config["lenders"] = json!({"aave": {"chain_id": 84532,
            "usdc": {"symbol": "USDC", "address": "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", "decimals": 6}}});
        compute_book(b, &inp).unwrap()
    };
    assert_eq!(answer(1_000 * USD).allow.withdraw, 1_000 * USD);
    assert_eq!(answer(5_000 * USD).allow.withdraw, 5_000 * USD);
    assert_eq!(answer(5_000 * USD + 1).allow.withdraw, 0);
    // A plain check never offers that USDC as a withdrawal from NEAR: it isn't there.
    let v = answer(1);
    assert_eq!(v.state, "HEALTHY");
}

#[test]
fn collateral_leaves_a_lender_only_while_every_rule_still_holds() {
    let ask = |units: u128| {
        format!(r#"{{"lender_withdraw":{{"lender":"rhea","token":"{MNBTC}","amount":"{units}"}}}}"#)
    };
    // $40,000 owed against $100,000 at Rhea: the target cushion needs $78,947 posted, so about $21,000 may go.
    let lb = || permitted(vec![drawn(rhea(), 40_000 * USD)]);
    let some = SATS * 21 / 100;
    let v = decide(&inputs_of(example(), &ask(some)), lb(), 0);
    assert_eq!(v.allow.withdraw, some);
    let more = SATS * 22 / 100;
    let v = decide(&inputs_of(example(), &ask(more)), lb(), 0);
    assert_eq!(v.allow.withdraw, 0);
    // A lender or a token the account doesn't have there is refused with what to fix.
    let inp = inputs_of(example(), &ask(some));
    let none = compute_book(book_with(&inp, permitted(vec![aave()]), 0), &inp).unwrap_err();
    assert_eq!(none, "the account's config names no lender rhea");
    let empty = compute_book(book_with(&inp, permitted(vec![rhea()]), 0), &inp).unwrap_err();
    assert_eq!(empty, format!("the account has no {MNBTC} posted at rhea"));
}

#[test]
fn a_token_leaves_the_ethereum_address_only_while_every_rule_still_holds() {
    let ask = |token: &str, units: u128| {
        format!(r#"{{"evm_withdraw":{{"token":"{token}","amount":"{units}"}}}}"#)
    };
    let answer = |intent: &str, lb: LenderBook, pool_debt: u128| -> Result<Verdict, String> {
        let mut inp = inputs_of(example(), intent);
        let b = book_with(&inp, lb, pool_debt);
        let b = on_ethereum(&mut inp, b);
        compute_book(b, &inp)
    };
    // The bitcoin sits at the Ethereum address as WBTC, unposted, and our pool is owed $20,000 against the book.
    // A hundredth of it may go. All of it may not: that would leave the short with nothing against it.
    let lb = || permitted(vec![aave()]);
    let v = answer(&ask(WBTC, SATS / 100), lb(), 20_000 * USD).unwrap();
    assert_eq!(v.allow.withdraw, SATS / 100);
    let v = answer(&ask(WBTC, SATS), lb(), 20_000 * USD).unwrap();
    assert_eq!(v.allow.withdraw, 0);
    // More than is there: no. With no loan anywhere, all of it may go.
    let v = answer(&ask(WBTC, SATS + 1), lb(), 0).unwrap();
    assert_eq!(v.allow.withdraw, 0);
    let v = answer(&ask(WBTC, SATS), lb(), 0).unwrap();
    assert_eq!(v.allow.withdraw, SATS);
    // A token the config doesn't name is refused, and so is an account with no lender on Ethereum.
    let err = answer(&ask(EVM_USDC, 5), lb(), 0).unwrap_err();
    assert_eq!(
        err,
        format!("the account's Ethereum address holds no {EVM_USDC} that its config names")
    );
    let err = answer(&ask(EVM_USDC, 5), permitted(vec![rhea()]), 0).unwrap_err();
    assert!(
        err.starts_with("the account's config names no lender on Ethereum"),
        "{err}"
    );
    // A withdrawal from NEAR can't take the bitcoin either: none of it is there.
    let near = format!(r#"{{"withdraw":{{"token":"{MNBTC}","amount":"1000"}}}}"#);
    let v = answer(&near, lb(), 20_000 * USD).unwrap();
    assert_eq!((v.allow.withdraw, v.state.as_str()), (0, "HEALTHY"));
    // The pool's own figures count WBTC as they count nBTC.
    assert!(
        v.pool.hold.values().any(|&x| x > 99_000 * USD),
        "{:?}",
        v.pool.hold
    );
}

#[test]
fn a_withdrawal_from_near_cant_take_what_is_posted_at_a_lender() {
    // All the bitcoin is posted at Rhea, with a loan from our pool: none of it can leave NEAR, because none is there.
    let ask = format!(r#"{{"withdraw":{{"token":"{MNBTC}","amount":"1000"}}}}"#);
    let mut inp = inputs_of(example(), &ask);
    inp.near.balances.insert(MNBTC.to_string(), json!("0"));
    let mut b = book_with(&inp, permitted(vec![drawn(rhea(), 0)]), 10_000 * USD);
    // The book still counts the posted bitcoin, and says it is locked.
    b.account.near.insert("nBTC", SATS as f64 / 1e8);
    b.lenders.locked.insert("nBTC".into(), SATS);
    let v = compute_book(b, &inp).unwrap();
    assert_eq!(v.allow.withdraw, 0);
    assert_eq!(v.state, "HEALTHY");
}

#[test]
fn the_verdict_carries_the_ethereum_nonce_when_aave_was_read() {
    let inp = inputs_of(example(), CHECK);
    let lb = LenderBook {
        evm_nonce: Some(7),
        ..permitted(vec![aave()])
    };
    let v = decide(&inp, lb, 0);
    assert!(json_of(&v).contains(r#""evm":{"nonce":7}"#));
    let v = decide(&inp, permitted(vec![rhea()]), 0);
    assert!(!json_of(&v).contains("\"evm\""));
}

#[test]
fn a_verdict_with_two_lenders_and_six_funding_steps_stays_under_its_size() {
    let inp = with_order(inputs_of(example(), FUND), "lender_first");
    // Aave, with the bitcoin at the Ethereum address in four tokens: four `l_supply` steps, the `l_borrow` and the
    // `p_borrow` are the six steps an account takes. Rhea's cushion is thin at the same time, so the verdict also
    // carries a top-up step and its line.
    let four: Vec<Holding> = (1..=4u8)
        .map(|n| sats(SATS / 4, "WBTC", &format!("0x{}", n.to_string().repeat(40))))
        .collect();
    let thin = LenderPos {
        posted: vec![sats(10_000_000, "nBTC", MNBTC)],
        posted_micro: 8_000 * USD,
        spare: Vec::new(),
        spare_micro: 0,
        debt_micro: 5_000 * USD,
        cash_micro: 3_000 * USD,
        ..rhea()
    };
    let lb = LenderBook {
        evm_nonce: Some(1_234_567),
        ..permitted(vec![
            LenderPos {
                spare: four,
                ..aave()
            },
            thin,
        ])
    };
    let v = decide(&inp, lb, 12_345_678_901);
    assert_eq!(v.ext.len(), 2);
    assert_eq!(v.fund.len(), MAX_FUND_STEPS);
    assert_eq!(v.fund.iter().filter(|s| s.kind() == "l_supply").count(), 4);
    assert_eq!(
        (v.fund[4].kind(), v.fund[5].kind()),
        ("l_borrow", "p_borrow")
    );
    assert_eq!(v.action, "REBALANCE");
    assert_eq!(v.plan.len(), 1);
    assert_eq!(v.evm.as_ref().map(|e| e.nonce), Some(1_234_567));
    let size = json_of(&v).len();
    assert!(size <= MAX_VERDICT_BYTES, "{size} bytes: {}", json_of(&v));
    // And it reads back as it was written.
    let back: Verdict = serde_json::from_str(&json_of(&v)).unwrap();
    assert_eq!(back, v);
}

#[test]
fn a_top_up_goes_before_the_engines_own_rebalance_and_keeps_the_more_urgent_action() {
    // Hyperliquid is close to liquidating the short (REBALANCE_NOW), and Rhea's cushion is 1.21 (REBALANCE).
    let w = World {
        hl_cash: 450.0,
        debt: 10_000_000_000,
        loans: 10_000_000_000,
        usdc: 2_000_000_000,
        ..World::hedged()
    };
    let inp = inputs_of(w, CHECK);
    let alone = pb_risk::compute(&inp).unwrap();
    assert_eq!(alone.action, "REBALANCE_NOW");
    let thin = LenderPos {
        posted: vec![sats(1_000_000, "nBTC", MNBTC)],
        posted_micro: 800 * USD,
        spare: Vec::new(),
        spare_micro: 0,
        debt_micro: 500 * USD,
        cash_micro: 2_000 * USD,
        ..rhea()
    };
    let v = decide(&inp, permitted(vec![thin]), 10_000 * USD);
    assert_eq!(v.action, "REBALANCE_NOW");
    // The top-up is the first step; whatever the engine plans for Hyperliquid comes after it.
    assert_eq!(
        v.plan[0],
        PlanStep::LRepay {
            l: "rhea".into(),
            amt: 94_666_667
        }
    );
    assert!(v.plan.len() <= 4);
    assert!(
        v.top
            .iter()
            .any(|t| t.starts_with("rhea: cushion 1.21 is under 1.35; repaying $95")),
        "{:?}",
        v.top
    );
    // No later step repays our pool with the USDC the top-up already spent.
    let repaid: u64 = v
        .plan
        .iter()
        .map(|s| match s {
            PlanStep::Repay { amt } | PlanStep::ToHl { amt, .. } | PlanStep::LRepay { amt, .. } => {
                *amt
            }
            _ => 0,
        })
        .sum();
    assert!(repaid <= 2_000_000_000, "{:?}", v.plan);
}

#[test]
fn during_an_unwind_the_top_up_waits_and_the_plan_is_the_unwinds() {
    // The drill's depeg walks the demo book down to DELEVERAGE.
    let inp = [7_500u64, 7_000, 6_500, 6_000, 5_000]
        .into_iter()
        .map(|bp| inputs_of(World::drill(bp), CHECK))
        .find(|inp| pb_risk::compute(inp).unwrap().action == "DELEVERAGE")
        .expect("a depeg deep enough to deleverage");
    let alone = pb_risk::compute(&inp).unwrap();
    let pool_debt = 1_096_805_083;
    let thin = LenderPos {
        posted: vec![sats(10_000, "nBTC", MNBTC)],
        posted_micro: 8 * USD,
        spare: Vec::new(),
        spare_micro: 0,
        debt_micro: 5 * USD,
        cash_micro: 10 * USD,
        ..rhea()
    };
    let v = decide(&inp, permitted(vec![thin]), pool_debt);
    assert_eq!(v.action, "DELEVERAGE");
    assert!(
        v.plan
            .iter()
            .all(|s| !matches!(s, PlanStep::LRepay { .. } | PlanStep::LAdd { .. })),
        "{:?}",
        v.plan
    );
    assert_eq!(v.plan.len(), alone.plan.len());
    assert!(
        v.top
            .iter()
            .any(|t| t == "rhea: cushion 1.21 is under 1.35; its top-up waits for the unwind"),
        "{:?}",
        v.top
    );
}
