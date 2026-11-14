//! INTERFACES.md 51: test ETH (`meth.pbf-ops.testnet`, 18 decimals, the engine's `ETH.b`) as collateral at our
//! copy of Rhea beside test bitcoin, and moved to the account's address on Aave's chain, where it is WETH. End to
//! end through the program (`pb_risk::run`) against the pretend world, with no change to the engine's source.
//!
//! Rhea's answers are mainnet's recorded views (`pb-read/tests/fixtures/mainnet`, read 9 Nov) under the test
//! tokens' ids: USDC's ratio 9500, bitcoin's 8000 with 10 extra decimals, ETH's 7500 with none. ETH is collateral
//! only, as the copy lists it. Each token has a fixed `default_price` in the copy's form: the price in cents, with
//! the token's decimals and two more (bitcoin: 10; ETH: 20).
mod common;

use common::*;
use pb_risk::inputs::RheaReads;
use pb_risk::steps::PlanStep;
use pb_risk::Verdict;
use serde_json::{json, Value};

const USD: u128 = 1_000_000;
const RHEA_ID: &str = "rhea.pbf-ops.testnet";
const ADDRESS: &str = "0x00000000000000000000000000000000000000aa";
const CHECK: &str = r#"{"check":{}}"#;
/// The pretend world's ETH price at the exchanges, which the copy's fixed price follows.
const ETH_USD: u64 = 2_247;
/// 0.5118 test ETH: $1,150.01 at $2,247.
const HELD: u128 = 511_800_000_000_000_000;
const SHORT: f64 = 0.5118;

fn rhea_view(name: &str) -> Value {
    let path = format!("{}/../pb-read/tests/fixtures/mainnet/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(path)
        .unwrap()
        .replace("nbtc.bridge.near", MNBTC)
        .replace("eth.bridge.near", METH)
        .replace("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", MUSDC);
    serde_json::from_str::<Value>(&text).unwrap()["value"].clone()
}

/// Our copy of Rhea with ETH listed: bitcoin fixed at `btc_usd` and ETH at `eth_usd` dollars, and the account's
/// position there: `sats` of mNBTC and `wei` of test ETH posted against `owed` micro-USDC.
fn copy(btc_usd: u64, eth_usd: u64, sats: u128, wei: u128, owed: u128) -> RheaReads {
    let mut assets: Vec<Value> = rhea_view("rhea_get_assets")
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| [MUSDC, MNBTC, METH].contains(&a["token_id"].as_str().unwrap()))
        .cloned()
        .collect();
    let eth = assets.iter_mut().find(|a| a["token_id"] == METH).unwrap();
    assert_eq!((eth["config"]["volatility_ratio"].as_u64(), eth["config"]["extra_decimals"].as_u64()), (Some(7_500), Some(0)));
    eth["config"]["can_borrow"] = json!(false);
    let fixed = |name: &str, decimals: u32, cents: u64, price_decimals: u32| {
        let mut info = rhea_view(name);
        info["decimals"] = json!(decimals);
        info["default_price"] = json!({"multiplier": cents.to_string(), "decimals": price_decimals});
        info
    };
    let entry = |token: &str, inner: u128| {
        json!({"token_id": token, "balance": inner.to_string(), "shares": inner.to_string(), "apr": "0.0"})
    };
    let mut collateral = Vec::new();
    if sats > 0 {
        collateral.push(entry(MNBTC, sats * 10u128.pow(10)));
    }
    if wei > 0 {
        collateral.push(entry(METH, wei));
    }
    let account = if collateral.is_empty() && owed == 0 {
        Value::Null
    } else {
        json!({"account_id": ACCOUNT, "supplied": [], "collateral": collateral,
            "borrowed": if owed > 0 { json!([entry(MUSDC, owed * 10u128.pow(12))]) } else { json!([]) },
            "farms": [], "has_non_farmed_assets": false, "booster_staking": null, "booster_stakings": {}})
    };
    RheaReads {
        contract_id: RHEA_ID.into(),
        account,
        assets: Value::Array(assets),
        prices: [
            (MUSDC.to_string(), fixed("rhea_get_token_pyth_info_usdc", 6, 100, 8)),
            (MNBTC.to_string(), fixed("rhea_get_token_pyth_info_nbtc", 8, btc_usd * 100, 10)),
            (METH.to_string(), fixed("rhea_get_token_pyth_info_nbtc", 18, eth_usd * 100, 20)),
        ]
        .into_iter()
        .collect(),
    }
}

fn permission() -> Value {
    json!({"lenders": ["rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "off"})
}

/// A new testnet account as the factory makes it since 14 Nov: ETH in its tokens, Rhea (bitcoin and ETH) and Aave
/// in its config, the pool as it stands live ($10M, nothing lent, lenders first). It holds `wei` of test ETH,
/// `sats` of test bitcoin and `usdc` micro-USDC on NEAR, and an ETH short of `short` with `margin` dollars.
fn account(rhea: RheaReads, wei: u128, sats: u128, usdc: u128, short: f64, margin: f64) -> World {
    World {
        usdc,
        nbtc: sats,
        eth: Some(wei),
        counter: 3,
        capital: 10_000_000 * USD,
        loans: 0,
        hl: Some((ADDRESS, -short, ETH_MARK)),
        hl_coin: "ETH",
        hl_cash: margin,
        hourly: json!([{"hour": T0_MS / 3_600_000 - 1, "hr_bp_min": 10_000, "exp_bp_max": 20_000}]),
        rhea: Some(rhea),
        aave: Some(Aave { weth_usd: ETH_USD as u128, ..Aave::market() }),
        permission: Some(permission()),
        funding: Some(json!({"order": "lender_first", "loan_days": 90})),
        ..World::deposits()
    }
}

fn verdict_of(world: World, intent: &str) -> Verdict {
    let (out, _) = run(world, intent, false);
    serde_json::from_str(&out).unwrap_or_else(|e| panic!("{e}: {out}"))
}

fn ext_of(v: &Verdict) -> String {
    serde_json::to_string(&v.ext).unwrap()
}

fn fund(usd: u128) -> String {
    format!(r#"{{"fund":{{"amount":"{}"}}}}"#, usd * USD)
}

fn take_back(wei: u128) -> String {
    format!(r#"{{"lender_withdraw":{{"lender":"rhea","token":"{METH}","amount":"{wei}"}}}}"#)
}

/// The ETH trade before any loan: $1,150 of test ETH on NEAR, a short of the same size with $290 of margin, no
/// bitcoin, nothing at Rhea yet.
fn eth_trade() -> World {
    account(copy(76_000, ETH_USD, 0, 0, 0), HELD, 0, 0, SHORT, 290.0)
}

/// The same trade with all its ETH posted at Rhea (priced there at `eth_usd`) against `owed`, and `spare` wei of
/// test ETH and `usdc` micro-USDC more on NEAR.
fn posted(eth_usd: u64, owed: u128, spare: u128, usdc: u128) -> World {
    account(copy(76_000, eth_usd, 0, HELD, owed), spare, 0, usdc, SHORT, 290.0)
}

// ------------------------------------------------------------------------------------------ part 1: Rhea

#[test]
fn a_fund_verdict_for_an_eth_trade_posts_the_eth_at_rhea_borrows_there_and_our_pool_lends_the_rest() {
    let v = verdict_of(eth_trade(), &fund(2_000));
    // The book can carry $1,008.01 (the tier's cap on its $1,440 of collateral); that is what $2,000 asked gets.
    assert_eq!((v.allow.borrow, v.credit.binding.as_str()), (1_008_008_428, "C4"));
    assert_eq!(v.allow.fund, Some(1_008_008_428));
    // Rhea values the 0.5118 ETH at its own fixed $2,247: $1,150.0146. It lends ETH's 75% times USDC's 95% of
    // that, over the cushion of 1.5: $546.26, after the account posts the ETH. Our pool lends the rest: $461.75.
    let at_rhea = HELD * 224_700 / 10u128.pow(14);
    assert_eq!(at_rhea, 1_150_014_600);
    let lends = at_rhea * 7_125 / 15_000;
    assert_eq!(
        v.fund,
        vec![
            PlanStep::LSupply { l: "rhea".into(), tok: METH.into(), amt: HELD.to_string() },
            PlanStep::LBorrow { l: "rhea".into(), amt: lends as u64 },
            PlanStep::PBorrow { amt: (1_008_008_428 - lends) as u64 },
        ]
    );
    assert_eq!((lends, 1_008_008_428 - lends), (546_256_935, 461_751_493));
    assert_eq!(
        v.top.last().unwrap(),
        "funding: rhea lends $546 at 16.70% (the operator puts lenders first); our pool lends $462 at 2.00%; that is $1,008 of the $2,000 asked"
    );
    // The account is as a bitcoin trade's: HEALTHY, nothing to do, ETH not held back.
    assert_eq!((v.state.as_str(), v.action.as_str()), ("HEALTHY", "NONE"));
    assert!(v.plan.is_empty() && v.coins.reduce_only.is_empty() && v.coins.uncertain.is_empty());
    // A smaller request posts only the ETH it needs and takes nothing from our pool: $200 needs $421.05 of ETH.
    let v = verdict_of(eth_trade(), &fund(200));
    let PlanStep::LSupply { tok, amt, .. } = &v.fund[0] else { panic!("{:?}", v.fund) };
    let wei: u128 = amt.parse().unwrap();
    assert_eq!(tok, METH);
    assert!(wei < HELD && (wei as f64 / 1e18 * 2_247.0 - 200.0 * 1.5 / 0.7125).abs() < 0.01, "{wei}");
    assert_eq!(v.fund[1..], [PlanStep::LBorrow { l: "rhea".into(), amt: 200_000_000 }]);
    assert_eq!(v.allow.fund, Some(200 * USD));
}

#[test]
fn rheas_liquidation_share_and_cushion_for_eth_use_eths_ratio() {
    // Nothing there yet: the share is ETH's 7500 times USDC's 9500, 71.25%. Bitcoin's is 76%.
    let v = verdict_of(eth_trade(), CHECK);
    assert_eq!(
        ext_of(&v),
        r#"[{"l":"rhea","c":0,"d":0,"hf_bp":0,"r_bp":1670,"s_bp":1088,"room":0,"liq_bp":7125}]"#
    );
    // All of it posted, $400 owed: $1,150.0146 x 0.7125 / 400 = 2.0484, rounded down as Rhea does. Up to the
    // cushion of 1.5 Rhea lends $146.26 more.
    let v = verdict_of(posted(ETH_USD, 400 * USD, 0, 0), CHECK);
    assert_eq!(
        ext_of(&v),
        r#"[{"l":"rhea","c":1150014600,"d":400000000,"hf_bp":20484,"r_bp":1670,"s_bp":1088,"room":146256935,"liq_bp":7125}]"#
    );
    assert_eq!(risk_core::lender::hf_bp(1_150_014_600, 7_125, 400_000_000), Some(20_484));
    assert_eq!(1_150_014_600u128 * 7_125 / 15_000 - 400_000_000, 146_256_935);
    // At $546 owed the cushion is 1.5007 and there is no room left.
    let v = verdict_of(posted(ETH_USD, 546 * USD, 0, 0), CHECK);
    assert_eq!((v.ext[0].hf_bp, v.ext[0].room, v.ext[0].liq_bp), (15_007, 0, 7_125));
    assert_eq!((v.state.as_str(), v.action.as_str()), ("HEALTHY", "NONE"));
    // Bitcoin and ETH posted together: the share is the two ratios weighted by value. 0.01 BTC ($760 at 80%) and
    // the ETH ($1,150.01 at 75%), times USDC's 95%.
    let both = verdict_of(account(copy(76_000, ETH_USD, 1_000_000, HELD, 400 * USD), 0, 0, 0, SHORT, 290.0), CHECK);
    let (btc, eth) = (760_000_000u128, 1_150_014_600u128);
    assert_eq!(both.ext[0].c, btc + eth);
    let weighted = (btc * 7_600 + eth * 7_125) / (btc + eth);
    assert!(both.ext[0].liq_bp.abs_diff(weighted as u32) <= 1, "{} vs {weighted}", both.ext[0].liq_bp);
    assert!(both.ext[0].liq_bp > 7_125 && both.ext[0].liq_bp < 7_600);
}

#[test]
fn when_eths_price_falls_at_rhea_the_top_up_adds_eth_or_repays_as_it_does_for_bitcoin() {
    // $546 owed against the ETH. Rhea's price for ETH falls from $2,247 to $1,950: the collateral is $998.01 and
    // the cushion 1.3023, under 1.35.
    let fallen = |spare: u128, usdc: u128| verdict_of(posted(1_950, 546 * USD, spare, usdc), CHECK);
    // With spare ETH on NEAR, the plan adds it: 0.0777 ETH, $151.50 at Rhea's price.
    let v = fallen(HELD / 4, 200 * USD);
    assert_eq!((v.ext[0].c, v.ext[0].hf_bp), (998_010_000, 13_023));
    assert_eq!((v.state.as_str(), v.action.as_str()), ("HEALTHY", "REBALANCE"));
    assert_eq!(v.plan, vec![PlanStep::LAdd { l: "rhea".into(), tok: METH.into(), amt: "77692632307692308".into() }]);
    assert_eq!(
        v.top.last().unwrap(),
        "rhea: cushion 1.30 is under 1.35; adding $152 of collateral brings it back to 1.50"
    );
    // Worked by hand: (998.01 + 0.0776926 x 1,950) x 0.7125 / 546 = 1.5000.
    assert_eq!(risk_core::lender::hf_bp(998_010_000 + 151_500_633, 7_125, 546_000_000), Some(15_000));
    // The same with no USDC: the ETH alone is enough.
    assert_eq!(fallen(HELD / 4, 0).plan, v.plan);
    // With no spare ETH, it repays from the account's USDC: $71.96.
    let v = fallen(0, 200 * USD);
    assert_eq!(v.plan, vec![PlanStep::LRepay { l: "rhea".into(), amt: 71_962_801 }]);
    assert_eq!(
        v.top.last().unwrap(),
        "rhea: cushion 1.30 is under 1.35; repaying $72 brings it back to 1.50"
    );
    // With neither, it says what is needed and plans no step.
    let v = fallen(0, 0);
    assert!(v.plan.is_empty());
    assert_eq!(
        v.top.last().unwrap(),
        "rhea: cushion 1.30 is under 1.35, and the account has no collateral or USDC there to top it up: it needs $72 repaid"
    );
    // A deeper fall, to $1,700 (cushion 1.1353, under 1.20): to act on at once, all the spare ETH and then USDC.
    let v = verdict_of(posted(1_700, 546 * USD, HELD / 4, 200 * USD), CHECK);
    assert_eq!((v.ext[0].hf_bp, v.action.as_str()), (11_353, "REBALANCE_NOW"));
    assert_eq!(
        v.plan,
        vec![
            PlanStep::LAdd { l: "rhea".into(), tok: METH.into(), amt: (HELD / 4).to_string() },
            PlanStep::LRepay { l: "rhea".into(), amt: 29_431_176 },
        ]
    );
    assert_eq!(
        v.top.last().unwrap(),
        "rhea: cushion 1.13 is under 1.20; adding $218 of collateral and repaying $29 brings it back to 1.50"
    );
}

#[test]
fn an_account_with_bitcoin_and_eth_posts_them_in_the_order_of_its_rhea_list_each_only_as_far_as_needed() {
    // The ETH trade with 0.01 test bitcoin ($760) beside it. The account's Rhea list is bitcoin, then ETH.
    let both = |usd: u128| verdict_of(account(copy(76_000, ETH_USD, 0, 0, 0), HELD, 1_000_000, 0, SHORT, 290.0), &fund(usd));
    // $300: part of the bitcoin is enough. 300 x 1.5 / 0.76 = $592.11 of it.
    let v = both(300);
    assert_eq!(
        v.fund,
        vec![
            PlanStep::LSupply { l: "rhea".into(), tok: MNBTC.into(), amt: "831024".into() },
            PlanStep::LBorrow { l: "rhea".into(), amt: 300_000_000 },
        ]
    );
    // $600: all the bitcoin (it backs $385.07), then as much ETH as the rest needs.
    let v = both(600);
    assert_eq!(
        v.fund,
        vec![
            PlanStep::LSupply { l: "rhea".into(), tok: MNBTC.into(), amt: "1000000".into() },
            PlanStep::LSupply { l: "rhea".into(), tok: METH.into(), amt: "223924049715095068".into() },
            PlanStep::LBorrow { l: "rhea".into(), amt: 600_000_000 },
        ]
    );
    // More than the book carries: both whole. Rhea lends $907.26 ($385.07 on the bitcoin, $546.26 on the ETH,
    // less a hair for the cushion on the two together); our pool the rest of the $1,536.87.
    let v = both(5_000);
    assert_eq!(
        v.fund,
        vec![
            PlanStep::LSupply { l: "rhea".into(), tok: MNBTC.into(), amt: "1000000".into() },
            PlanStep::LSupply { l: "rhea".into(), tok: METH.into(), amt: HELD.to_string() },
            PlanStep::LBorrow { l: "rhea".into(), amt: 907_256_935 },
            PlanStep::PBorrow { amt: 629_613_585 },
        ]
    );
    assert_eq!(v.allow.fund, Some(1_536_870_520));
}

#[test]
fn taking_the_eth_back_from_rhea_and_a_repayment_are_weighed_on_eths_ratio() {
    let ask = |owed: u128, wei: u128| verdict_of(posted(ETH_USD, owed, 0, 0), &take_back(wei)).allow.withdraw;
    // $400 owed against $1,150.01: the cushion of 1.5 needs 400 x 1.5 / 0.7125 = $842.11 to stay, so $307.91 may
    // go: 26.7% of it. A quarter may leave; three tenths may not; nor may all of it.
    assert_eq!(ask(400 * USD, HELD / 10), HELD / 10);
    assert_eq!(ask(400 * USD, HELD / 4), HELD / 4);
    assert_eq!(ask(400 * USD, HELD * 3 / 10), 0);
    assert_eq!(ask(400 * USD, HELD), 0);
    // To the unit: 0.13703 ETH leaves $842.11 behind; a thousandth of an ETH more doesn't.
    let most = 137_000_000_000_000_000;
    assert_eq!(ask(400 * USD, most), most);
    assert_eq!(ask(400 * USD, most + 1_000_000_000_000_000), 0);
    // After a repayment of $200, $421.05 must stay and 63% may go.
    assert_eq!(ask(200 * USD, HELD * 6 / 10), HELD * 6 / 10);
    assert_eq!(ask(200 * USD, HELD * 7 / 10), 0);
    // With the loan repaid in full, all of it may go.
    assert_eq!(ask(0, HELD), HELD);
    // More than is posted is refused, as for bitcoin.
    assert_eq!(ask(0, HELD + 1), 0);
}

#[test]
fn eth_on_near_counts_in_full_only_while_the_accounts_config_names_aave() {
    // On testnet the engine takes ETH's ratio to its coin from Aave's oracle price for WETH (INTERFACES.md 33).
    // The factory's config names Aave, so a new account has it. An account whose config names Rhea alone has no
    // reading: its ETH counts at 80% and is held to shrinking, and the line is smaller. Rhea's own entry is the same.
    let with = verdict_of(eth_trade(), CHECK);
    let without = verdict_of(World { aave: None, ..eth_trade() }, CHECK);
    assert!(with.coins.reduce_only.is_empty());
    assert_eq!(without.coins.reduce_only, ["ETH"]);
    assert!(without.eq < with.eq - 200_000_000, "{} {}", without.eq, with.eq);
    assert!(without.credit.line < with.credit.line);
    assert_eq!(without.ext[0].liq_bp, 7_125);
}

// ------------------------------------------------------------------------------------------ part 2: Aave

const AHEAD_NS: u64 = (T0_MS + 3_600_000) * 1_000_000;
/// 0.02 ETH, in wei: the most one move brings on testnet.
const MOVED: u128 = 20_000_000_000_000_000;

/// A pending 1Click transfer as `get_state().pending` lists it, with what its quote says will arrive when given.
fn move_entry(id: &str, kind: &str, token: &str, amount: u128, expect: Option<(&str, u128)>) -> Value {
    let dep = if kind == "e_home" { "0x2031181d63507368232579af4c64a1c3428407ff" } else { "f00d" };
    let mut t = json!({"id": id, "kind": kind, "token": token, "amount": amount.to_string(), "dep": dep,
                       "deadline": AHEAD_NS.to_string()});
    if let Some((token, amount)) = expect {
        t["expect"] = json!({"token": token, "amount": amount.to_string()});
    }
    json!({"transfer": t})
}

/// The gate's kind of account: `wei` of test ETH on NEAR, no position on Hyperliquid, Aave at its address.
fn mover(wei: u128, aave: Aave, pending: Value) -> World {
    World {
        usdc: 0,
        nbtc: 0,
        eth: Some(wei),
        counter: 3,
        hl: Some((ADDRESS, 0.0, ETH_MARK)),
        hl_coin: "ETH",
        hl_cash: 0.0,
        aave: Some(aave),
        permission: Some(json!({"lenders": ["aave", "rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "off"})),
        pending: Some(pending),
        ..World::deposits()
    }
}

fn market() -> Aave {
    Aave { weth_usd: ETH_USD as u128, ..Aave::market() }
}

#[test]
fn a_move_of_test_eth_to_aaves_chain_is_arrived_when_the_address_holds_weth_worth_80_percent_of_what_was_sent() {
    // 0.5118 ETH, of which 0.02 ($44.94) was sent to the account's own address on Base Sepolia: `move:1`.
    let moving = json!([move_entry("move:1", "to_evm", METH, MOVED, None)]);
    let at = |weth: u128| verdict_of(mover(HELD - MOVED, Aave { weth_spare: weth, ..market() }, moving.clone()), CHECK);
    let before = verdict_of(mover(HELD, market(), json!([])), CHECK);
    // On its way: not arrived, and the owner's own move counts nothing while it travels.
    let on_its_way = at(0);
    assert!(on_its_way.arrived.is_empty());
    assert!(((before.eq - on_its_way.eq) as f64 / 1e6 - 0.02 * 2_247.0).abs() < 0.2, "{} {}", before.eq, on_its_way.eq);
    // All of it there as WETH, or 85% of it (1Click keeps its cut): arrived, and it counts where it is.
    for weth in [MOVED, MOVED * 85 / 100, MOVED * 81 / 100] {
        let v = at(weth);
        assert_eq!(v.arrived, ["move:1"], "{weth}");
        let there = (v.eq - on_its_way.eq) as f64 / 1e6;
        assert!((there - weth as f64 / 1e18 * 2_247.0).abs() < 0.2, "{weth}: {there}");
    }
    // 75% of it isn't this move: not arrived. What is at the address still counts as what it is.
    for weth in [MOVED * 75 / 100, MOVED * 79 / 100, 1] {
        assert!(at(weth).arrived.is_empty(), "{weth}");
    }
    // A plan step's transfer of the same ETH counts at 98% for the state while it travels, and arrives the same way.
    let step = json!([move_entry("f276621922:0", "to_evm", METH, MOVED, None)]);
    let v = verdict_of(mover(HELD - MOVED, market(), step.clone()), CHECK);
    assert!(((v.eq - on_its_way.eq) as f64 / 1e6 - 0.98 * 0.02 * 2_247.0).abs() < 0.2, "{}", v.eq);
    let v = verdict_of(mover(HELD - MOVED, Aave { weth_spare: MOVED, ..market() }, step), CHECK);
    assert_eq!(v.arrived, ["f276621922:0"]);
}

#[test]
fn weth_that_came_from_the_accounts_own_eth_counts_at_the_address_and_at_aave_as_weth_always_did() {
    // The same 0.5118 ETH three ways: all on NEAR; 0.02 of it at the address as WETH; 0.02 of it posted at Aave.
    let on_near = verdict_of(mover(HELD, market(), json!([])), CHECK);
    let at_address = verdict_of(mover(HELD - MOVED, Aave { weth_spare: MOVED, ..market() }, json!([])), CHECK);
    let at_aave = verdict_of(mover(HELD - MOVED, Aave { weth_posted: MOVED, ..market() }, json!([])), CHECK);
    // One book: the same equity to the cent, the same requirement, the same line.
    for v in [&at_address, &at_aave] {
        assert!((v.eq - on_near.eq).abs() < 10_000, "{} vs {}", v.eq, on_near.eq);
        assert!((v.im - on_near.im).abs() < 10_000, "{} vs {}", v.im, on_near.im);
        assert_eq!((v.state.as_str(), v.action.as_str()), ("HEALTHY", "NONE"));
        assert!(v.coins.reduce_only.is_empty());
    }
    // Aave's own entry: nothing posted while it sits at the address; $44.94 posted, liquidated at WETH's 85%.
    let aave = |v: &Verdict| v.ext.iter().find(|e| e.l == "aave").unwrap().clone();
    assert_eq!((aave(&at_address).c, aave(&at_address).d), (0, 0));
    assert_eq!((aave(&at_aave).c, aave(&at_aave).liq_bp), (44_940_000, 8_500));
    // Posted WETH can't be withdrawn from NEAR; what is still on NEAR can.
    let take = |world: World, wei: u128| {
        verdict_of(world, &format!(r#"{{"withdraw":{{"token":"{METH}","amount":"{wei}"}}}}"#)).allow.withdraw
    };
    assert_eq!(take(mover(HELD - MOVED, Aave { weth_posted: MOVED, ..market() }, json!([])), HELD - MOVED), HELD - MOVED);
    assert_eq!(take(mover(HELD - MOVED, Aave { weth_posted: MOVED, ..market() }, json!([])), HELD), 0);
}

#[test]
fn a_move_home_of_weth_that_expects_test_eth_is_handled_as_one_that_expects_bitcoin() {
    // 0.02 WETH leaves the address for NEAR. The account's record says what its quote will bring: test ETH, test
    // bitcoin, or nothing (a record from before). The engine reads the token sent and the amount, nothing else.
    let home = |id: &str, expect: Option<(&str, u128)>| {
        let pending = json!([move_entry(id, "e_home", WETH, MOVED, expect)]);
        verdict_of(mover(HELD - MOVED, Aave { nonce: 5, ..market() }, pending), CHECK)
    };
    let figures = |v: &Verdict| (v.eq, v.eq_allow, v.im, v.mm, v.allow.clone(), v.credit.clone(), ext_of(v), v.state.clone(), v.action.clone(), v.arrived.clone(), v.top.clone());
    let as_eth = home("move:3", Some((METH, 19_900_000_000_000_000)));
    let as_btc = home("move:3", Some((MNBTC, 59_000)));
    let unsaid = home("move:3", None);
    assert_eq!(figures(&as_eth), figures(&as_btc));
    assert_eq!(figures(&as_eth), figures(&unsaid));
    // The owner's own move counts nothing while it travels; the engine marks no arrival for a move home.
    let none = verdict_of(mover(HELD - MOVED, Aave { nonce: 5, ..market() }, json!([])), CHECK);
    assert_eq!((as_eth.eq, as_eth.arrived.len()), (none.eq, 0));
    // A plan step's transfer of the same WETH counts as its coin, at 98%, whatever it expects.
    let step_eth = home("f1:0", Some((METH, 19_900_000_000_000_000)));
    let step_btc = home("f1:0", Some((MNBTC, 59_000)));
    assert_eq!(figures(&step_eth), figures(&step_btc));
    assert!(((step_eth.eq - none.eq) as f64 / 1e6 - 0.98 * 0.02 * 2_247.0).abs() < 0.2, "{}", step_eth.eq);
}
