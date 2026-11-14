//! Stage 2's testnet account, end to end through the program (`pb_risk::run`): its config names our own copy of
//! Rhea (`rhea.pbf-ops.testnet`) and no Aave (INTERFACES.md 24). A request goes in, the pretend world answers every
//! read, Rhea's among them, and the verdict comes out.
//!
//! The copy prices each token with a fixed `default_price` in `get_token_pyth_info`, not a live feed, so the
//! operator can lower bitcoin's price there and watch the cushion fall. Rhea's answers here are of two kinds:
//! - **The copy's own,** as it answered in a local sandbox with bitcoin fixed at $75,000 and then at $50,000
//!   (`pb-read/tests/fixtures/sandbox/rhea_copy_views.json`; pb-read's `tests/lenders.rs` says where it is from).
//! - **Mainnet's recorded views** (`pb-read/tests/fixtures/mainnet`, burrowland 0.16.2) with the test tokens' ids,
//!   the position written over, and a `default_price` set in the shape the copy answered: a decimal-string
//!   `multiplier` and a number of `decimals`. They carry mainnet's USDC rate, 16.05%, which is dearer than our
//!   pool; the sandbox copy's, 0.29%, is cheaper.
mod common;

use common::*;
use pb_risk::inputs::RheaReads;
use pb_risk::steps::PlanStep;
use pb_risk::Verdict;
use serde_json::{json, Value};

const USD: u128 = 1_000_000;
const RHEA_ID: &str = "rhea.pbf-ops.testnet";
/// The pretend world's bitcoin price, and $100,000 of bitcoin at it, in satoshis.
const BTC: f64 = 76_000.0;
const SATS: u128 = 131_578_947;

const CHECK: &str = r#"{"check":{}}"#;
const FUND: &str = r#"{"fund":{"amount":"94500000000"}}"#;

fn file(path: &str) -> String {
    let full = format!("{}/{path}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&full).unwrap_or_else(|e| panic!("{full}: {e}"))
}

/// A Rhea view recorded on mainnet (pb-read's fixtures), with mainnet's token ids renamed to the test account's.
fn rhea_view(name: &str) -> Value {
    let text = file(&format!("../pb-read/tests/fixtures/mainnet/{name}.json"))
        .replace("nbtc.bridge.near", MNBTC)
        .replace("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", MUSDC);
    serde_json::from_str::<Value>(&text).unwrap()["value"].clone()
}

/// Our copy of Rhea's answers in the sandbox, `before` or `after` its bitcoin price was lowered: 1 nBTC posted
/// against 40,000 USDC. The sandbox account was `demo.pbf.testnet`; nothing the engine reads depends on the name.
fn sandbox(when: &str) -> RheaReads {
    let text = file("../pb-read/tests/fixtures/sandbox/rhea_copy_views.json");
    let saved: Value = serde_json::from_str(&text).unwrap();
    let views = &saved[when]["views"];
    RheaReads {
        contract_id: saved["contract_id"].as_str().unwrap().to_string(),
        account: views["get_account"].clone(),
        assets: views["get_assets"].clone(),
        prices: [MUSDC, MNBTC]
            .into_iter()
            .map(|id| (id.to_string(), views["get_token_pyth_info"][id].clone()))
            .collect(),
    }
}

/// An account with half a bitcoin and $3,000 on NEAR, whose position at Rhea is the sandbox's.
fn sandbox_account(when: &str) -> World {
    World {
        usdc: 3_000 * USD,
        nbtc: 50_000_000,
        counter: 3,
        rhea: Some(sandbox(when)),
        permission: Some(permission()),
        ..World::deposits()
    }
}

/// What a copy of Rhea would answer, built by hand: USDC fixed at $1, bitcoin fixed at `btc_usd` dollars (or priced by Rhea's feed,
/// as on mainnet, with `None`), and the account's position: `posted` satoshis of mNBTC against `owed` micro-USDC.
/// Rhea keeps both amounts with 18 decimals.
fn copy(btc_usd: Option<u64>, posted: u128, owed: u128) -> RheaReads {
    let fixed = |name: &str, price: Option<Value>| {
        let mut info = rhea_view(name);
        info["default_price"] = price.unwrap_or(Value::Null);
        info
    };
    // Bitcoin has 8 decimals and its price 2 more: $76,000 is multiplier 7,600,000 at 10 decimals.
    let btc = btc_usd.map(|usd| json!({"multiplier": (usd * 100).to_string(), "decimals": 10}));
    let usdc = Some(json!({"multiplier": "10000", "decimals": 10}));
    let entry = |token: &str, inner: u128| {
        json!({"token_id": token, "balance": inner.to_string(), "shares": inner.to_string(), "apr": "0.0"})
    };
    let account = if posted == 0 && owed == 0 {
        Value::Null // never used Rhea
    } else {
        json!({"account_id": ACCOUNT, "supplied": [],
            "collateral": if posted > 0 { json!([entry(MNBTC, posted * 10u128.pow(10))]) } else { json!([]) },
            "borrowed": if owed > 0 { json!([entry(MUSDC, owed * 10u128.pow(12))]) } else { json!([]) },
            "farms": [], "has_non_farmed_assets": false, "booster_staking": null, "booster_stakings": {}})
    };
    RheaReads {
        contract_id: RHEA_ID.into(),
        account,
        assets: rhea_view("rhea_get_assets_usdc_nbtc"),
        prices: [
            (MUSDC.to_string(), fixed("rhea_get_token_pyth_info_usdc", usdc)),
            (MNBTC.to_string(), fixed("rhea_get_token_pyth_info_nbtc", btc)),
        ]
        .into_iter()
        .collect(),
    }
}

fn permission() -> Value {
    json!({"lenders": ["rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "off"})
}

fn order(order: &str) -> Option<Value> {
    Some(json!({"order": order, "loan_days": 90}))
}

/// FUNDING.md's worked example before any loan: $100,000 of bitcoin on NEAR, a $100,000 short on Hyperliquid with
/// $35,000 of margin, in a pool that is 60% lent, so a Standard client pays 6.50%. The account may use Rhea.
fn example(rhea: RheaReads) -> World {
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
        rhea: Some(rhea),
        permission: Some(permission()),
        ..World::deposits()
    }
}

/// An account with half a bitcoin posted at Rhea against `owed`, and no other loan. On NEAR it holds `nbtc`
/// satoshis more and `usdc` micro-USDC.
fn at_rhea(btc_usd: Option<u64>, owed: u128, nbtc: u128, usdc: u128) -> World {
    World {
        usdc,
        nbtc,
        counter: 3,
        rhea: Some(copy(btc_usd, 50_000_000, owed)),
        permission: Some(permission()),
        ..World::deposits()
    }
}

/// The same with half a bitcoin and $3,000 on NEAR, and $19,000 owed at Rhea.
fn half_posted(btc_usd: Option<u64>) -> World {
    at_rhea(btc_usd, 19_000 * USD, 50_000_000, 3_000 * USD)
}

/// `world` with one lender action under way in its state's `pending` (the stage 2 shape).
fn with_pending(world: World, kind: &str, amount: u128, until_block: u64) -> World {
    World {
        pending: Some(json!([{"lender": {"lender": "rhea", "kind": kind, "amount": amount.to_string(),
                                         "until_block": until_block}}])),
        ..world
    }
}

fn verdict_of(world: World, intent: &str) -> (Verdict, MockNet) {
    let (out, net) = run(world, intent, false);
    let v: Verdict = serde_json::from_str(&out).unwrap_or_else(|e| panic!("{e}: {out}"));
    (v, net)
}

fn checked(world: World) -> Verdict {
    verdict_of(world, CHECK).0
}

fn l_add(sats: u128) -> PlanStep {
    PlanStep::LAdd {
        l: "rhea".into(),
        tok: MNBTC.into(),
        amt: sats.to_string(),
    }
}

#[test]
fn the_account_reads_our_copy_of_rhea_and_nothing_on_ethereum() {
    let (v, net) = verdict_of(example(copy(Some(76_000), 0, 0)), CHECK);
    // Rhea's four views come right after the account's own, at the same block (the pretend world checks the block).
    let near: Vec<&str> = net
        .calls
        .iter()
        .filter_map(|c| c.strip_prefix("near "))
        .collect();
    assert_eq!(
        near[near.len() - 5..],
        [
            "pool.pbf.testnet.get_borrower",
            "rhea.pbf-ops.testnet.get_account",
            "rhea.pbf-ops.testnet.get_assets",
            "rhea.pbf-ops.testnet.get_token_pyth_info",
            "rhea.pbf-ops.testnet.get_token_pyth_info"
        ]
    );
    // No Aave in the config: nothing is asked of Ethereum (the pretend world refuses any such request, and a
    // lender that can't be read is no verdict), and the verdict carries no Ethereum nonce.
    assert!(!net.calls.iter().any(|c| c.contains("sepolia") || c.contains("eth_")), "{:?}", net.calls);
    assert_eq!(v.evm, None);
    // The same account without a lender makes four calls fewer and gets today's verdict.
    let plain = World {
        rhea: None,
        permission: None,
        ..example(copy(None, 0, 0))
    };
    let (old, old_net) = verdict_of(plain, CHECK);
    assert_eq!(net.calls.len(), old_net.calls.len() + 4);
    assert!(old.ext.is_empty());
    // Permitted and unused: Rhea is listed with its terms, nothing there, and the book is what it was.
    let ext = serde_json::to_string(&v.ext).unwrap();
    assert_eq!(
        ext,
        r#"[{"l":"rhea","c":0,"d":0,"hf_bp":0,"r_bp":1605,"s_bp":1042,"room":0,"liq_bp":7600}]"#
    );
    assert_eq!((v.state.as_str(), v.action.as_str()), ("HEALTHY", "NONE"));
    assert_eq!((v.eq, v.allow.borrow, &v.credit), (old.eq, old.allow.borrow, &old.credit));
    assert_eq!(v.rate_bp, 650);
}

#[test]
fn with_lenders_first_a_funding_request_posts_bitcoin_at_rhea_borrows_there_and_takes_the_rest_from_our_pool() {
    let world = World {
        funding: order("lender_first"),
        ..example(copy(Some(76_000), 0, 0))
    };
    let (v, _) = verdict_of(world, FUND);
    // The book can carry $94,399 (70% of its $134,856); that is what the request gets of its $94,500.
    let line = v.allow.borrow;
    assert_eq!((line, v.credit.binding.as_str()), (94_399_195_158, "C4"));
    // Rhea values the bitcoin at its own fixed $76,000: $99,999.99972. At a cushion of 1.5 it lends 76% of that
    // over 1.5, after the account posts the bitcoin. Our pool lends the rest.
    let at_rhea = SATS * 7_600_000 / 10u128.pow(4);
    assert_eq!(at_rhea, 99_999_999_720);
    let lends = at_rhea * 7_600 / 15_000;
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
                amt: lends as u64
            },
            PlanStep::PBorrow {
                amt: (line - lends) as u64
            },
        ]
    );
    assert_eq!((lends, line - lends), (50_666_666_524, 43_732_528_634));
    assert_eq!(v.allow.fund, Some(line));
    assert_eq!(
        v.top.last().unwrap(),
        "funding: rhea lends $50,667 at 16.05% (the operator puts lenders first); our pool lends $43,733 at 6.50%; that is $94,399 of the $94,500 asked"
    );
    // Nothing is posted yet, so the lender's step has no room yet: the check after the posting shows it.
    assert_eq!((v.ext[0].room, v.ext[0].c), (0, 0));
    assert_eq!((v.state.as_str(), v.action.as_str()), ("HEALTHY", "NONE"));
    assert!(v.plan.is_empty());
    // A smaller request posts only the bitcoin it needs, and needs nothing from our pool.
    let world = World {
        funding: order("lender_first"),
        ..example(copy(Some(76_000), 0, 0))
    };
    let (v, _) = verdict_of(world, r#"{"fund":{"amount":"10000000000"}}"#);
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
fn with_the_cheapest_first_our_pool_lends_it_all_while_rhea_is_dearer() {
    // Rhea charges 16.05% and our pool 6.50%. A pool that names no order means the cheapest first, too.
    for funding in [order("cheapest"), None] {
        let world = World {
            funding,
            ..example(copy(Some(76_000), 0, 0))
        };
        let (v, _) = verdict_of(world, FUND);
        assert_eq!((v.ext[0].r_bp, v.rate_bp), (1_605, 650));
        assert_eq!(v.fund, vec![PlanStep::PBorrow { amt: 94_399_195_158 }]);
        assert_eq!(v.allow.fund, Some(94_399_195_158));
        assert_eq!(
            v.top.last().unwrap(),
            "funding: our pool lends $94,399 at 6.50%; that is $94,399 of the $94,500 asked"
        );
    }
    // In a pool whose own limits stop at $25,000, Rhea lends what our pool can't, dearer or not.
    let small_pool = World {
        capital: 100_000 * USD,
        loans: 0,
        ..example(copy(Some(76_000), 0, 0))
    };
    let (v, _) = verdict_of(small_pool, FUND);
    assert_eq!((v.allow.borrow, v.credit.binding.as_str()), (25_000 * USD, "C6"));
    let kinds: Vec<&str> = v.fund.iter().map(PlanStep::kind).collect();
    assert_eq!(kinds, ["l_supply", "l_borrow", "p_borrow"]);
    assert_eq!(v.fund[2], PlanStep::PBorrow { amt: 25_000_000_000 });
}

#[test]
fn when_the_copys_bitcoin_price_is_lowered_the_cushion_falls_and_the_verdict_plans_a_top_up() {
    // The copy as the sandbox answered, with bitcoin fixed at $75,000: 1 nBTC posted is $75,000 against $40,000,
    // a cushion of 75,000 x 0.76 / 40,000 = 1.4249. Over 1.35: nothing to do. Under 1.5: no room to borrow more.
    let before = checked(sandbox_account("before"));
    assert_eq!(
        serde_json::to_string(&before.ext).unwrap(),
        r#"[{"l":"rhea","c":75000000000,"d":40000000002,"hf_bp":14249,"r_bp":29,"s_bp":1,"room":0,"liq_bp":7600}]"#
    );
    assert_eq!((before.state.as_str(), before.action.as_str()), ("HEALTHY", "NONE"));
    assert!(before.plan.is_empty());
    // The operator lowers it to $50,000: the same bitcoin is $50,000, and the cushion 0.9499. Rhea could sell.
    let after = checked(sandbox_account("after"));
    assert_eq!(
        serde_json::to_string(&after.ext).unwrap(),
        r#"[{"l":"rhea","c":50000000000,"d":40000000019,"hf_bp":9499,"r_bp":29,"s_bp":1,"room":0,"liq_bp":7600}]"#
    );
    // The verdict plans the top-up, to act on at once: all the spare half bitcoin ($25,000 at Rhea's price), then
    // $2,002.67 of the account's USDC, which together bring the cushion back to 1.5.
    assert_eq!((after.state.as_str(), after.action.as_str()), ("HEALTHY", "REBALANCE_NOW"));
    assert_eq!(
        after.plan,
        vec![
            l_add(50_000_000),
            PlanStep::LRepay {
                l: "rhea".into(),
                amt: 2_002_666_675
            }
        ]
    );
    assert_eq!(
        after.top.last().unwrap(),
        "rhea: cushion 0.94 is under 1.20; adding $25,000 of collateral and repaying $2,003 brings it back to 1.50"
    );
    // Worked by hand: (50,000 + 25,000) x 0.76 / (40,000 - 2,002.67) = 1.5001. It is sized on Rhea's own figure,
    // which the interest puts a hair under ours, so it lands a hair over the target.
    assert_eq!(risk_core::lender::hf_bp(75_000_000_000, 7_600, 40_000_000_019 - 2_002_666_675), Some(15_001));
    // Only the copy's price moved. The engine prices the book itself, so the account's state and credit stand:
    // equity differs by the 17 millionths of a dollar of interest between the two reads.
    assert!((0..=17).contains(&(before.eq - after.eq)), "{} {}", before.eq, after.eq);
    assert_eq!((after.im, &after.credit.binding), (before.im, &before.credit.binding));
    // The copy's USDC costs 0.29%, less than our pool. So with the cheapest first, which is the default, a funding
    // request goes to Rhea: here $10,000 more, after posting $23,684 of the spare bitcoin to keep the cushion at 1.5.
    assert!(u64::from(before.ext[0].r_bp) < before.rate_bp);
    let (v, _) = verdict_of(sandbox_account("before"), r#"{"fund":{"amount":"10000000000"}}"#);
    assert_eq!(
        v.fund,
        vec![
            PlanStep::LSupply {
                l: "rhea".into(),
                tok: MNBTC.into(),
                amt: "31578948".into()
            },
            PlanStep::LBorrow {
                l: "rhea".into(),
                amt: 10_000_000_000
            },
        ]
    );
    assert_eq!(
        v.top.last().unwrap(),
        "funding: rhea lends $10,000 at 0.29% (cheaper than our pool's 5.00%)"
    );
}

#[test]
fn rheas_own_fixed_price_values_its_collateral_and_the_engines_price_does_when_none_is_set() {
    // Half a bitcoin posted against $19,000. The pretend exchanges price bitcoin at $75,999.995.
    let own = checked(half_posted(Some(76_000)));
    let none = checked(half_posted(None));
    // Fixed at $76,000 on the copy: $38,000.00, and a cushion of 38,000 x 0.76 / 19,000 = 1.52.
    assert_eq!((own.ext[0].c, own.ext[0].hf_bp), (38_000_000_000, 15_200));
    // No fixed price (Rhea's feed prices it, as on mainnet): the engine's own price, $37,999.9975 and 1.5199.
    assert_eq!((none.ext[0].c, none.ext[0].hf_bp), (37_999_997_500, 15_199));
    // The room to borrow more there follows: 76% of the collateral over 1.5, less the $19,000.
    assert_eq!((own.ext[0].room, none.ext[0].room), (253_333_333, 253_332_066));
    // Rhea's price is only how Rhea counts its collateral. The book is valued at the engine's prices either way.
    assert_eq!((own.eq, own.allow.borrow, &own.credit), (none.eq, none.allow.borrow, &none.credit));
}

#[test]
fn lowering_bitcoins_price_on_the_copy_thins_the_cushion_and_the_verdict_plans_a_top_up() {
    // At $76,000 the cushion is 1.52: nothing to do.
    let calm = checked(half_posted(Some(76_000)));
    assert_eq!((calm.ext[0].hf_bp, calm.action.as_str()), (15_200, "NONE"));
    assert!(calm.plan.is_empty());
    // The operator lowers the copy's price to $66,000: $33,000 posted, a cushion of 1.32, under 1.35. The verdict
    // adds $4,500 of the account's spare bitcoin, at Rhea's price: 0.06818182 of a bitcoin.
    let low = checked(half_posted(Some(66_000)));
    assert_eq!((low.ext[0].c, low.ext[0].hf_bp), (33_000_000_000, 13_200));
    assert_eq!((low.state.as_str(), low.action.as_str()), ("HEALTHY", "REBALANCE"));
    assert_eq!(low.plan, vec![l_add(6_818_182)]);
    assert_eq!(
        low.top.last().unwrap(),
        "rhea: cushion 1.32 is under 1.35; adding $4,500 of collateral brings it back to 1.50"
    );
    // At $58,000 the cushion is 1.16, under 1.2: the same plan, to act on at once.
    let lower = checked(half_posted(Some(58_000)));
    assert_eq!((lower.ext[0].c, lower.ext[0].hf_bp), (29_000_000_000, 11_600));
    assert_eq!(lower.action, "REBALANCE_NOW");
    assert_eq!(lower.plan, vec![l_add(14_655_173)]);
    assert_eq!(
        lower.top.last().unwrap(),
        "rhea: cushion 1.16 is under 1.20; adding $8,500 of collateral brings it back to 1.50"
    );
    // The step is enough: with it posted, the cushion is back at 1.5.
    let after = checked(World {
        nbtc: 50_000_000 - 14_655_173,
        rhea: Some(copy(Some(58_000), 50_000_000 + 14_655_173, 19_000 * USD)),
        ..half_posted(Some(58_000))
    });
    assert_eq!((after.ext[0].hf_bp, after.action.as_str()), (15_000, "NONE"));
    // With no spare bitcoin on NEAR, the top-up repays from the account's USDC there: $2,280 of its $3,000.
    let cash = checked(at_rhea(Some(66_000), 19_000 * USD, 0, 3_000 * USD));
    assert_eq!(cash.action, "REBALANCE");
    assert_eq!(
        cash.plan,
        vec![PlanStep::LRepay {
            l: "rhea".into(),
            amt: 2_280_000_000
        }]
    );
    // Only Rhea's price moved. The engine's own prices didn't, so the account's state and credit are unchanged.
    assert_eq!((low.eq, low.allow.borrow, &low.credit), (calm.eq, calm.allow.borrow, &calm.credit));
    // A room of 0 while the cushion is under the target: nothing more is borrowed there.
    assert_eq!((calm.ext[0].room, low.ext[0].room, lower.ext[0].room), (253_333_333, 0, 0));
}

#[test]
fn a_borrow_under_way_reads_as_it_will_once_it_lands_and_is_never_topped_up_as_twice_the_loan() {
    // The account borrows $9,000 more at Rhea, on top of $10,000. The account lists the borrow for 20 blocks.
    let (before, after) = (10_000 * USD, 19_000 * USD);
    let bitcoin = 50_000_000;
    // 1. Sent, and Rhea doesn't show it yet: $10,000 owed there, the $9,000 not yet on NEAR.
    let sent = checked(with_pending(
        at_rhea(Some(76_000), before, bitcoin, 3_000 * USD),
        "borrow",
        9_000 * USD,
        HEIGHT + 20,
    ));
    // 2. Landed, and no longer listed: $19,000 owed there, and $12,000 on NEAR.
    let landed = checked(at_rhea(Some(76_000), after, bitcoin, 12_000 * USD));
    // The verdict of 1 is the verdict of 2 in everything that decides: equity, state, credit and the cushion.
    assert_eq!((sent.eq, sent.eq_allow, sent.im, sent.mm), (landed.eq, landed.eq_allow, landed.im, landed.mm));
    assert_eq!((&sent.state, &sent.action, &sent.credit), (&landed.state, &landed.action, &landed.credit));
    assert_eq!(sent.allow.borrow, landed.allow.borrow);
    assert_eq!((sent.ext[0].hf_bp, sent.ext[0].room), (15_200, 253_333_333));
    assert_eq!((landed.ext[0].hf_bp, landed.ext[0].room), (15_200, 253_333_333));
    // `d` is what Rhea shows, which the pool settles on. The USDC on its way can't be withdrawn: it isn't here.
    assert_eq!((sent.ext[0].d, landed.ext[0].d), (before, after));
    assert_eq!((sent.allow.withdraw, landed.allow.withdraw), (3_000 * USD, 12_000 * USD));
    // 3. Landed and still listed: Rhea shows the $19,000 and the entry adds $9,000 again. The loan counts twice
    // for new risk: no room, less to borrow, and a cushion that reads 1.03.
    let both = checked(with_pending(
        at_rhea(Some(76_000), after, bitcoin, 12_000 * USD),
        "borrow",
        9_000 * USD,
        HEIGHT + 20,
    ));
    assert_eq!((both.ext[0].d, both.ext[0].hf_bp, both.ext[0].room), (after, 10_314, 0));
    assert!(both.allow.borrow < landed.allow.borrow);
    assert_eq!(both.credit.line, after + 9_000 * USD + both.allow.borrow);
    // But equity is right, the state stands, and nothing is topped up: Rhea itself shows a cushion of 1.52.
    assert_eq!((both.eq, both.state.as_str(), both.action.as_str()), (landed.eq, "HEALTHY", "NONE"));
    assert!(both.plan.is_empty());
    assert!(!both.top.iter().any(|t| t.starts_with("rhea:")), "{:?}", both.top);
    // 4. Once the entry's block has passed it counts for nothing, listed or not.
    let past = checked(with_pending(
        at_rhea(Some(76_000), after, bitcoin, 12_000 * USD),
        "borrow",
        9_000 * USD,
        HEIGHT - 1,
    ));
    assert_eq!(
        (past.ext[0].hf_bp, past.ext[0].room, past.allow.borrow, &past.credit),
        (15_200, 253_333_333, landed.allow.borrow, &landed.credit)
    );
    // A cushion that Rhea itself shows as thin is topped up all the same, sized on what Rhea shows.
    let thin = checked(with_pending(
        at_rhea(Some(66_000), after, bitcoin, 12_000 * USD),
        "borrow",
        9_000 * USD,
        HEIGHT + 20,
    ));
    assert_eq!(thin.action, "REBALANCE");
    assert_eq!(thin.plan, vec![l_add(6_818_182)]);
    assert_eq!(
        thin.top.last().unwrap(),
        "rhea: cushion 1.32 is under 1.35; adding $4,500 of collateral brings it back to 1.50"
    );
}

#[test]
fn a_withdrawal_under_way_is_gone_from_the_cushion_and_is_never_topped_up_for() {
    // Half a bitcoin posted against $19,000. The account asked a tenth of a bitcoin back, and lists that.
    let quiet = checked(half_posted(Some(76_000)));
    let leaving = checked(with_pending(half_posted(Some(76_000)), "withdraw", 10_000_000, HEIGHT + 20));
    // Rhea's collateral counts without it: $30,400, a cushion of 1.216, and no room to borrow there.
    assert_eq!((quiet.ext[0].c, quiet.ext[0].hf_bp, quiet.ext[0].room), (38_000_000_000, 15_200, 253_333_333));
    assert_eq!((leaving.ext[0].c, leaving.ext[0].hf_bp, leaving.ext[0].room), (30_400_000_000, 12_160, 0));
    // The bitcoin is still the account's, so the book is what it was, and nothing is topped up: Rhea shows 1.52,
    // or it has let the bitcoin go already and the entry takes it off a second time.
    assert_eq!((leaving.eq, &leaving.credit, leaving.allow.borrow), (quiet.eq, &quiet.credit, quiet.allow.borrow));
    assert_eq!((leaving.state.as_str(), leaving.action.as_str()), ("HEALTHY", "NONE"));
    assert!(leaving.plan.is_empty());
    // Once its block has passed, the entry counts for nothing.
    let past = checked(with_pending(half_posted(Some(76_000)), "withdraw", 10_000_000, HEIGHT - 1));
    assert_eq!(serde_json::to_string(&past.ext).unwrap(), serde_json::to_string(&quiet.ext).unwrap());
    // A funding request made meanwhile leans on what stays. With lenders first, Rhea lends against the $30,400
    // and the account's spare bitcoin, not against the tenth that is leaving.
    let fund = r#"{"fund":{"amount":"30000000000"}}"#;
    let lender_first = |world: World| World {
        funding: order("lender_first"),
        ..world
    };
    let borrows = |v: &Verdict| -> u64 {
        v.fund
            .iter()
            .map(|s| match s {
                PlanStep::LBorrow { amt, .. } => *amt,
                _ => 0,
            })
            .sum()
    };
    let (calm, _) = verdict_of(lender_first(half_posted(Some(76_000))), fund);
    let (meanwhile, _) = verdict_of(
        lender_first(with_pending(half_posted(Some(76_000)), "withdraw", 10_000_000, HEIGHT + 20)),
        fund,
    );
    // $76,000 of bitcoin in all gives 76,000 x 0.76 / 1.5 less the $19,000 owed: $19,506.67. $68,400 gives $15,656.
    assert_eq!(borrows(&calm), 19_506_666_666);
    assert_eq!(borrows(&meanwhile), 15_656_000_000);
}
