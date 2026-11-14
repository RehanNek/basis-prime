//! Stage 3 (INTERFACES.md 33), end to end through the program (`pb_risk::run`): an account whose config names
//! Aave's test market on Base Sepolia, alone or beside our copy of Rhea. The pretend world answers the engine's
//! Ethereum calls in Aave's own layouts, from the answers recorded on Base Sepolia on 10 and 11 Nov (pb-read's
//! `fixtures/base_sepolia`) with the account's own figures written in.
//!
//! The account's Ethereum address is its Hyperliquid address. What sits there counts: WBTC and wrapped ether as
//! collateral a step can post (while Aave's supply cap has room), USDC as cash a top-up can repay with.
mod common;

use common::*;
use pb_risk::inputs::RheaReads;
use pb_risk::steps::PlanStep;
use pb_risk::Verdict;
use serde_json::{json, Value};

const USD: u128 = 1_000_000;
const SATS: u128 = 131_578_947;
const ADDRESS: &str = "0x00000000000000000000000000000000000000aa";
const CHECK: &str = r#"{"check":{}}"#;
const FUND: &str = r#"{"fund":{"amount":"94500000000"}}"#;

fn permission() -> Value {
    json!({"lenders": ["aave", "rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "off"})
}

fn example(aave: Aave) -> World {
    let q = SATS as f64 / 1e8;
    World {
        usdc: 0,
        nbtc: 0,
        loans: 6_000_000 * USD,
        capital: 10_000_000 * USD,
        counter: 3,
        hl: Some((ADDRESS, -q, 76_000.0)),
        hl_cash: 35_000.0,
        hourly: json!([{"hour": T0_MS / 3_600_000 - 1, "hr_bp_min": 10_000, "exp_bp_max": 20_000}]),
        aave: Some(aave),
        permission: Some(permission()),
        ..World::deposits()
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

fn ext_of(v: &Verdict) -> String {
    serde_json::to_string(&v.ext).unwrap()
}

fn l_supply(l: &str, tok: &str, amt: u128) -> PlanStep {
    PlanStep::LSupply { l: l.into(), tok: tok.into(), amt: amt.to_string() }
}

fn l_borrow(l: &str, amt: u64) -> PlanStep {
    PlanStep::LBorrow { l: l.into(), amt }
}

/// Our copy of Rhea with nothing of the account's there: mainnet's recorded views under the test tokens' ids
/// (16.05% to borrow), bitcoin fixed at $76,000.
fn rhea() -> RheaReads {
    let view = |name: &str| -> Value {
        let path = format!("{}/../pb-read/tests/fixtures/mainnet/{name}.json", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(path)
            .unwrap()
            .replace("nbtc.bridge.near", MNBTC)
            .replace("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", MUSDC);
        serde_json::from_str::<Value>(&text).unwrap()["value"].clone()
    };
    let fixed = |name: &str, multiplier: &str| {
        let mut info = view(name);
        info["default_price"] = json!({"multiplier": multiplier, "decimals": 10});
        info
    };
    RheaReads {
        contract_id: "rhea.pbf-ops.testnet".into(),
        account: Value::Null,
        assets: view("rhea_get_assets_usdc_nbtc"),
        prices: [
            (MUSDC.to_string(), fixed("rhea_get_token_pyth_info_usdc", "10000")),
            (MNBTC.to_string(), fixed("rhea_get_token_pyth_info_nbtc", "7600000")),
        ]
        .into_iter()
        .collect(),
    }
}

#[test]
fn an_account_with_aave_alone_reads_base_sepolia_last_and_counts_what_sits_at_its_address() {
    // $100,000 of WBTC and $5,000 of USDC at the account's Ethereum address, nothing on NEAR, the short on
    // Hyperliquid.
    let world = || example(Aave { spare: SATS, cash: 5_000 * USD, nonce: 7, ..Aave::market() });
    let (v, net) = verdict_of(world(), CHECK);
    // Two requests to Base Sepolia, the last thing the run reads: its block number, then one batch of the 18 calls
    // for the two collateral tokens, all pinned to that block. Nothing is asked of Rhea. Bitcoin and ether are
    // both priced: Aave is read after the prices, and its tokens wrap both. 41 requests in all.
    let counts = call_counts(&net);
    assert_eq!((counts["evm"], counts["near"], counts["hyperliquid"], counts["get"]), (2, 10, 5, 24));
    assert_eq!(net.calls[net.calls.len() - 2..], ["evm eth_blockNumber", "evm batch of 18"]);
    assert_eq!(net.calls.len(), 41);
    assert!(!net.calls.iter().any(|c| c.contains("rhea")));
    // The WBTC is the book's bitcoin: the same line as the worked example, plus 70% of the USDC.
    assert_eq!((v.state.as_str(), v.action.as_str()), ("HEALTHY", "NONE"));
    assert_eq!(v.pool.hold["WBTC"], 99_999_993_141);
    let bare = checked(example(Aave { spare: SATS, ..Aave::market() }));
    assert_eq!((v.eq - bare.eq, v.allow.borrow - bare.allow.borrow), (5_000_000_000, 3_500_000_000));
    assert_eq!((bare.allow.borrow, bare.credit.binding.as_str()), (94_399_195_158, "C4"));
    // That USDC isn't on NEAR, so it can't be withdrawn from there. Nothing is at Aave yet.
    assert_eq!(v.allow.withdraw, 0);
    assert_eq!(ext_of(&v), r#"[{"l":"aave","c":0,"d":0,"hf_bp":0,"r_bp":74,"s_bp":9,"room":0,"liq_bp":8300}]"#);
    assert_eq!(v.evm.as_ref().map(|e| e.nonce), Some(7));
    assert!(v.coins.reduce_only.is_empty() && v.coins.uncertain.is_empty());
    // What a verdict decides on: the same whichever way Aave was read.
    let figures = |x: &Verdict| (x.eq, x.allow.clone(), x.credit.clone(), ext_of(x), x.evm.clone(), x.pool.clone());
    // An endpoint that refuses batches gets the 18 calls one by one, at the same block, with the same answers.
    let (single, net) = verdict_of(example(Aave { batches: false, ..world().aave.unwrap() }), CHECK);
    assert_eq!(call_counts(&net)["evm"], 20);
    assert_eq!(figures(&single), figures(&v));
    // The public RPC limits requests. The block number refused once is asked again, then the batch as usual.
    let (again, net) = verdict_of(example(Aave { limited: 1, ..world().aave.unwrap() }), CHECK);
    assert_eq!((call_counts(&net)["evm"], figures(&again)), (3, figures(&v)));
    // Refused twice, there is no block to pin to: the calls go one by one at the latest block, as before, and one
    // of those refused is asked again. The verdict's figures are the same.
    let (again, net) = verdict_of(example(Aave { limited: 3, ..world().aave.unwrap() }), CHECK);
    assert_eq!((call_counts(&net)["evm"], figures(&again)), (21, figures(&v)));
    // An RPC that keeps refusing is no verdict: a lender that can't be read is never guessed.
    let (out, _) = run(example(Aave { limited: 100, ..world().aave.unwrap() }), CHECK, false);
    assert!(out.contains(r#""ok":false"#) && out.contains("cannot read the Aave position on chain 84532"), "{out}");
}

#[test]
fn a_funding_request_posts_the_wbtc_borrows_at_aave_and_takes_the_rest_from_our_pool() {
    // Aave's 0.74% is cheaper than our pool's 6.50%, so with the cheapest first it lends all it can at a cushion
    // of 1.5: 83% of the $100,000 over 1.5.
    let (v, _) = verdict_of(example(Aave { spare: SATS, ..Aave::market() }), FUND);
    let line = v.allow.borrow;
    assert_eq!(line, 94_399_195_158);
    assert_eq!(
        v.fund,
        vec![l_supply("aave", WBTC, SATS), l_borrow("aave", 55_333_333_178), PlanStep::PBorrow { amt: 39_065_861_980 }]
    );
    assert_eq!(v.allow.fund, Some(line));
    assert_eq!(
        v.top.last().unwrap(),
        "funding: aave lends $55,333 at 0.74% (cheaper than our pool's 6.50%); our pool lends $39,066 at 6.50%; that is $94,399 of the $94,500 asked"
    );
    // Once the WBTC is posted, the next check shows the room the borrow step may take.
    let posted = checked(example(Aave { posted: SATS, nonce: 2, ..Aave::market() }));
    assert_eq!(
        ext_of(&posted),
        r#"[{"l":"aave","c":99999999720,"d":0,"hf_bp":0,"r_bp":74,"s_bp":9,"room":55333333178,"liq_bp":8300}]"#
    );
    // Borrowed: the USDC sits at the address, the cushion is 1.5, and our pool's part is what is left of the line.
    let drawn = Aave { posted: SATS, debt: 55_333_333_178, cash: 55_333_333_178, nonce: 3, ..Aave::market() };
    let after = checked(example(drawn));
    assert_eq!((after.ext[0].d, after.ext[0].hf_bp, after.ext[0].room), (55_333_333_178, 15_000, 0));
    assert_eq!(after.credit.line, 55_333_333_178 + after.allow.borrow);
    assert!(after.allow.borrow > 39_065_861_980, "the borrowed USDC is collateral too: {}", after.allow.borrow);
    assert_eq!((after.state.as_str(), after.action.as_str()), ("HEALTHY", "NONE"));
}

#[test]
fn a_thin_cushion_at_aave_is_topped_up_from_what_sits_at_the_address() {
    // $50,000 owed against 1.31578947 WBTC. Aave's oracle has bitcoin at $60,000: $78,947 posted, a cushion of 1.31.
    let thin = |spare: u128, cash: u128| Aave {
        posted: SATS,
        spare,
        debt: 50_000 * USD,
        cash,
        wbtc_usd: 60_000,
        nonce: 4,
        ..Aave::market()
    };
    // With WBTC at the address, the top-up posts $11,416 of it: 0.19026105 WBTC at Aave's price.
    let v = checked(example(thin(20_000_000, 50_000 * USD)));
    assert_eq!((v.ext[0].c, v.ext[0].hf_bp, v.action.as_str()), (78_947_368_200, 13_105, "REBALANCE"));
    assert_eq!(v.plan, vec![PlanStep::LAdd { l: "aave".into(), tok: WBTC.into(), amt: "19026105".into() }]);
    assert_eq!(
        v.top.last().unwrap(),
        "aave: cushion 1.31 is under 1.35; adding $11,416 of collateral brings it back to 1.50"
    );
    // With none, it repays from the USDC at the address: $6,316.67 brings the cushion back to 1.5, sized on
    // Aave's own health factor.
    let v = checked(example(thin(0, 50_000 * USD)));
    assert_eq!(v.plan, vec![PlanStep::LRepay { l: "aave".into(), amt: 6_316_666_667 }]);
    // WBTC at the address that Aave's pool has no room for can't be added: the top-up repays, and says why.
    let v = checked(example(Aave { wbtc_full: true, ..thin(20_000_000, 3_000 * USD) }));
    assert_eq!(v.plan, vec![PlanStep::LRepay { l: "aave".into(), amt: 3_000_000_000 }]);
    assert_eq!(
        v.top.last().unwrap(),
        "aave: cushion 1.31 is under 1.35; repaying $3,000 helps, and $3,317 more must be repaid to reach 1.50; Aave's pool for WBTC is full, so the WBTC at the account's Ethereum address can't be posted now"
    );
    // At Aave's own $76,000 the same position has a cushion of 1.66: nothing to do.
    let calm = checked(example(Aave { wbtc_usd: 76_000, ..thin(0, 0) }));
    assert_eq!((calm.ext[0].hf_bp, calm.action.as_str()), (16_599, "NONE"));
}

#[test]
fn collateral_leaves_aave_and_tokens_leave_the_address_only_while_every_rule_holds() {
    // $20,000 owed against the $100,000 of WBTC at Aave; 0.2 WBTC and $20,000 of USDC at the address.
    let world = || example(Aave {
        posted: SATS,
        spare: 20_000_000,
        debt: 20_000 * USD,
        cash: 20_000 * USD,
        nonce: 5,
        ..Aave::market()
    });
    let allowed = |intent: String| verdict_of(world(), &intent).0.allow.withdraw;
    let back = |sats: u128| format!(r#"{{"lender_withdraw":{{"lender":"aave","token":"{WBTC}","amount":"{sats}"}}}}"#);
    // The cushion of 1.5 needs $36,145 posted, so 0.8 WBTC may come back and 0.9 may not.
    assert_eq!(allowed(back(80_000_000)), 80_000_000);
    assert_eq!(allowed(back(90_000_000)), 0);
    // From the address: the unposted WBTC and the USDC may go, up to what is there. The config writes its
    // addresses in mixed case; either case names the token.
    let away = |token: &str, units: u128| format!(r#"{{"evm_withdraw":{{"token":"{token}","amount":"{units}"}}}}"#);
    assert_eq!(allowed(away(WBTC, 20_000_000)), 20_000_000);
    assert_eq!(allowed(away(WBTC, 20_000_001)), 0);
    assert_eq!(allowed(away("0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", 20_000 * USD)), 20_000 * USD);
    assert_eq!(allowed(away(EVM_USDC, 20_000 * USD + 1)), 0);
    // WBTC that Aave's pool has no room for is still the account's to send away.
    let full = World { aave: Some(Aave { wbtc_full: true, ..world().aave.unwrap() }), ..world() };
    assert_eq!(verdict_of(full, &away(WBTC, 20_000_000)).0.allow.withdraw, 20_000_000);
    // A token the config doesn't name is refused in words.
    let (out, _) = run(world(), &away("0x00000000000000000000000000000000000000ff", 1), false);
    assert!(out.contains("holds no 0x00000000000000000000000000000000000000ff that its config names"), "{out}");
}

#[test]
fn with_both_lenders_a_funding_request_only_ever_posts_collateral_where_that_lender_takes_it() {
    // Half the bitcoin is nBTC on NEAR, which Rhea takes; half is WBTC on Base Sepolia, which Aave takes.
    let both = |nbtc: u128, wbtc: u128, order: Option<&str>| World {
        nbtc,
        rhea: Some(rhea()),
        funding: order.map(|o| json!({"order": o, "loan_days": 90})),
        ..example(Aave { spare: wbtc, ..Aave::market() })
    };
    let half = SATS / 2;
    let kinds = |v: &Verdict| v.fund.iter().map(PlanStep::kind).collect::<Vec<_>>().join(" ");
    // Every step posts a lender's own kind of token: a 0x address for Aave, a NEAR id for Rhea. Nothing moves
    // bitcoin between chains: that is stage 4.
    let sound = |v: &Verdict| {
        for step in &v.fund {
            match step {
                PlanStep::LSupply { l, tok, .. } if l == "aave" => assert!(tok.starts_with("0x"), "{step:?}"),
                PlanStep::LSupply { l, tok, .. } => assert_eq!((l.as_str(), tok.as_str()), ("rhea", MNBTC)),
                PlanStep::LBorrow { .. } | PlanStep::PBorrow { .. } => {}
                other => panic!("a funding plan can't hold {other:?}"),
            }
        }
    };
    // One lender at most per request: the cheaper one with room. Aave at 0.74% lends against its WBTC alone
    // ($50,000 of it gives $27,667), and our pool lends the rest. Rhea's nBTC stays where it is.
    for order in [None, Some("cheapest"), Some("lender_first")] {
        let (v, net) = verdict_of(both(half, half, order), FUND);
        sound(&v);
        assert_eq!(v.fund[..2], [l_supply("aave", WBTC, half), l_borrow("aave", 27_666_666_378)], "{order:?}");
        assert_eq!(kinds(&v), "l_supply l_borrow p_borrow");
        assert_eq!(v.ext.iter().map(|e| e.l.as_str()).collect::<Vec<_>>(), ["aave", "rhea"]);
        // Rhea's four views at the NEAR block, Aave's two requests last: 45 in all.
        let counts = call_counts(&net);
        assert_eq!((counts["near"], counts["evm"], net.calls.len()), (14, 2, 45));
    }
    // Our pool first: Aave only takes what our pool's own limits leave, which here is nothing.
    let (v, _) = verdict_of(both(half, half, Some("pool_first")), FUND);
    assert_eq!(kinds(&v), "p_borrow");
    // All the bitcoin on NEAR: Aave has nothing to lend against, so it is never planned. Rhea is dearer than our
    // pool, so by default our pool lends it all; with lenders first Rhea lends against the nBTC.
    let (v, _) = verdict_of(both(SATS, 0, None), FUND);
    assert_eq!(kinds(&v), "p_borrow");
    let (v, _) = verdict_of(both(SATS, 0, Some("lender_first")), FUND);
    sound(&v);
    assert_eq!(v.fund[..2], [l_supply("rhea", MNBTC, SATS), l_borrow("rhea", 50_666_666_524)]);
    // All of it on Base Sepolia: Rhea has nothing to lend against, and Aave lends against the WBTC.
    let (v, _) = verdict_of(both(0, SATS, Some("lender_first")), FUND);
    sound(&v);
    assert_eq!(v.fund[..2], [l_supply("aave", WBTC, SATS), l_borrow("aave", 55_333_333_178)]);
    // Aave's rate above the permission's ceiling: it isn't used, and with lenders first Rhea is.
    let dear = World {
        aave: Some(Aave { spare: half, rate_bp: 2_600, ..Aave::market() }),
        ..both(half, half, Some("lender_first"))
    };
    let (v, _) = verdict_of(dear, FUND);
    sound(&v);
    assert_eq!(v.fund[..2], [l_supply("rhea", MNBTC, half), l_borrow("rhea", 25_333_333_069)]);
}

#[test]
fn a_token_whose_pool_at_aave_is_full_is_never_planned_and_the_other_token_is_used() {
    // WBTC's supply cap is reached, as on 11 Nov. The WBTC at the address still counts in the book, but no step
    // posts it: our pool lends the whole request, and the verdict says why.
    let full = |weth: u128| example(Aave { spare: SATS, weth_spare: weth, wbtc_full: true, ..Aave::market() });
    let (v, _) = verdict_of(full(0), FUND);
    assert_eq!(v.fund, vec![PlanStep::PBorrow { amt: 94_399_195_158 }]);
    assert_eq!(v.pool.hold["WBTC"], 99_999_993_141);
    assert_eq!(
        v.top.last().unwrap(),
        "funding: our pool lends $94,399 at 6.50%; that is $94,399 of the $94,500 asked; Aave's pool for WBTC is full, so the WBTC at the account's Ethereum address can't be posted now"
    );
    // With 10 wrapped ether at the address too ($22,400 at Aave's price), Aave lends against the ether: the one
    // that can be posted. Until something is posted the cushion counts the lower of the two tokens' thresholds.
    let (v, _) = verdict_of(full(10_000_000_000_000_000_000), FUND);
    assert_eq!(
        v.fund,
        vec![
            l_supply("aave", WETH, 9_999_999_999_553_571_429),
            l_borrow("aave", 12_394_666_666),
            PlanStep::PBorrow { amt: 82_105_333_334 }
        ]
    );
    assert!(v.top.last().unwrap().ends_with("Aave's pool for WBTC is full, so the WBTC at the account's Ethereum address can't be posted now"));
    // With room for WBTC again, both are spare collateral, and the plan posts what the part needs of each.
    let open = example(Aave { spare: SATS, weth_spare: 10_000_000_000_000_000_000, ..Aave::market() });
    let (v, _) = verdict_of(open, FUND);
    let supplied: Vec<&str> = v
        .fund
        .iter()
        .filter_map(|s| match s {
            PlanStep::LSupply { tok, .. } => Some(tok.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(supplied, [WBTC, WETH]);
    assert!(!v.top.last().unwrap().contains("is full"));
}

#[test]
fn a_hedged_bitcoin_book_on_near_with_a_little_wrapped_ether_at_its_address_reads_and_decides() {
    // The demo's hedged book before any loan: $25,000 of nBTC on NEAR against a $25,000 short. At its Ethereum
    // address it holds 0.01 wrapped ether, which nothing hedges.
    let book = |weth_spare: u128, weth_posted: u128, debt: u128| World {
        aave: Some(Aave { weth_spare, weth_posted, debt, cash: debt, ..Aave::market() }),
        permission: Some(permission()),
        debt: 0,
        loans: 0,
        ..World::hedged()
    };
    let cent = 10_000_000_000_000_000;
    let plain = checked(World { debt: 0, loans: 0, ..World::hedged() });
    let v = checked(book(cent, 0, 0));
    // The ether counts as ETH held, at Aave's price of $2,240: $22.40 more in the book, and no trouble with it.
    assert_eq!((v.state.as_str(), v.action.as_str()), ("HEALTHY", "NONE"));
    assert_eq!(v.pool.hold["ETH"], 22_400_000);
    assert_eq!(v.pool.hold["nBTC"], plain.pool.hold["nBTC"]);
    assert!(v.coins.reduce_only.is_empty() && v.coins.uncertain.is_empty(), "{:?}", v.coins);
    assert!((v.eq - plain.eq - 22_400_000).abs() < 100_000, "{} {}", v.eq, plain.eq);
    // A funding request: Aave's part comes from the ether alone ($22.40 x 0.83 / 1.5), our pool's from the rest.
    let (f, _) = verdict_of(book(cent, 0, 0), r#"{"fund":{"amount":"20000000000"}}"#);
    assert_eq!(
        f.fund,
        vec![
            l_supply("aave", WETH, 9_999_999_553_571_429),
            l_borrow("aave", 12_394_666),
            PlanStep::PBorrow { amt: 19_987_605_334 }
        ]
    );
    assert_eq!(f.allow.fund, Some(20_000 * USD));
    // Posted, and $12.39 borrowed: Aave counts its ether at 85%, so the cushion is 22.40 x 0.85 / 12.39 = 1.53.
    let after = checked(book(0, cent, 12_394_666));
    assert_eq!(
        ext_of(&after),
        r#"[{"l":"aave","c":22400000,"d":12394666,"hf_bp":15361,"r_bp":74,"s_bp":9,"room":298667,"liq_bp":8500}]"#
    );
    assert_eq!((after.state.as_str(), after.action.as_str()), ("HEALTHY", "NONE"));
    // Without any wrapped ether, ether isn't one of the account's coins: the verdict is the plain book's, plus
    // Aave's empty line.
    let none = checked(book(0, 0, 0));
    assert_eq!((none.eq, none.allow.borrow, &none.pool.hold), (plain.eq, plain.allow.borrow, &plain.pool.hold));
}

#[test]
fn a_signed_aave_borrow_reads_as_it_will_once_mined_and_is_never_topped_up_as_twice_the_loan() {
    // $20,000 owed against the $100,000 of WBTC at Aave. The account signs a borrow of $30,000 more with nonce 6
    // and lists it; the chain's count is 6.
    let at = |debt: u128, cash: u128, nonce: u64| Aave { posted: SATS, debt, cash, nonce, ..Aave::market() };
    let signed = |world: World| World {
        pending: Some(json!([{"lender": {"lender": "aave", "kind": "borrow", "amount": "30000000000",
                                         "token": EVM_USDC, "evm_nonce": 6}}])),
        evm: Some(json!({"nonce": 7, "signed": [{"nonce": 6, "kind": "borrow", "token": EVM_USDC,
            "amount": "30000000000", "to": AAVE_POOL, "raw": "0x02", "hash": "0xab", "step": "f1:1", "signed_at": "1"}]})),
        ..world
    };
    // Signed, not mined: the verdict is what it will be once the loan is there, in everything that decides.
    let sent = checked(signed(example(at(20_000 * USD, 0, 6))));
    let mined = checked(example(at(50_000 * USD, 30_000 * USD, 7)));
    assert_eq!((sent.eq, sent.im, sent.mm), (mined.eq, mined.im, mined.mm));
    assert_eq!((&sent.state, &sent.action, &sent.credit, sent.allow.borrow), (&mined.state, &mined.action, &mined.credit, mined.allow.borrow));
    assert_eq!((sent.ext[0].d, sent.ext[0].hf_bp, sent.ext[0].room), (20_000 * USD, 16_599, 5_333_333_178));
    assert_eq!((mined.ext[0].d, mined.ext[0].hf_bp, mined.ext[0].room), (50_000 * USD, 16_599, 5_333_333_178));
    assert_eq!((sent.evm.as_ref().unwrap().nonce, mined.evm.as_ref().unwrap().nonce), (6, 7));
    // Mined, and the account still lists it (it drops the entry when a verdict shows the chain's count above 6):
    // the chain's count is 7, so the entry counts for nothing and Aave's own figures are the truth.
    let listed = checked(signed(example(at(50_000 * USD, 30_000 * USD, 7))));
    assert_eq!((ext_of(&listed), listed.allow.borrow, listed.eq), (ext_of(&mined), mined.allow.borrow, mined.eq));
    // A signed withdrawal of half the WBTC, not mined: gone from Aave's cushion, which then reads 0.83, and no
    // top-up is planned for it: Aave itself still shows 4.15.
    let leaving = World {
        pending: Some(json!([{"lender": {"lender": "aave", "kind": "withdraw", "amount": "105263158",
                                         "token": WBTC, "evm_nonce": 6}}])),
        ..example(at(20_000 * USD, 0, 6))
    };
    let v = checked(leaving);
    assert_eq!((v.ext[0].c, v.ext[0].hf_bp, v.ext[0].room, v.action.as_str()), (19_999_999_640, 8_299, 0, "NONE"));
    assert!(v.plan.is_empty());
}

// ------------------------------------------------------------- the moves to Aave's chain and back (stage 4)

/// A deadline an hour ahead of the pretend world's block, and one an hour behind it, in ns.
const AHEAD_NS: u64 = (T0_MS + 3_600_000) * 1_000_000;
const PASSED_NS: u64 = (T0_MS - 3_600_000) * 1_000_000;

/// A pending 1Click transfer as `get_state().pending` lists it (INTERFACES.md 36).
fn move_entry(id: &str, kind: &str, token: &str, amount: u128, deadline_ns: u64) -> Value {
    let dep = if kind == "e_home" { "0x2031181d63507368232579af4c64a1c3428407ff" } else { "f00d" };
    json!({"transfer": {"id": id, "kind": kind, "token": token, "amount": amount.to_string(), "dep": dep,
                        "deadline": deadline_ns.to_string()}})
}

/// The gate's kind of account: `nbtc` satoshis of test nBTC and `usdc` micro-USDC on NEAR, an Ethereum address
/// with no position on Hyperliquid, both lenders' permission, and `aave` at its address on Base Sepolia.
fn mover(nbtc: u128, usdc: u128, aave: Aave, pending: Value) -> World {
    World {
        usdc,
        nbtc,
        counter: 3,
        hl: Some((ADDRESS, 0.0, 76_000.0)),
        hl_cash: 0.0,
        aave: Some(aave),
        permission: Some(permission()),
        pending: Some(pending),
        ..World::deposits()
    }
}

/// 0.02 wrapped ether, in wei: the most one move brings on testnet (INTERFACES.md 36).
const WETH_002: u128 = 20_000_000_000_000_000;

#[test]
fn a_move_to_aaves_chain_counts_nothing_on_its_way_and_is_arrived_also_when_the_bitcoin_comes_as_wrapped_ether() {
    // The gate's account: 0.02 test nBTC on NEAR ($1,520), nothing else. It sends 0.00055 nBTC ($41.80) to its own
    // address on Base Sepolia through 1Click: `move:1`.
    let moving = |deadline| json!([move_entry("move:1", "to_evm", MNBTC, 55_000, deadline)]);
    let before = checked(mover(2_000_000, 0, Aave::market(), json!([])));
    assert_eq!((before.eq, before.eq_allow, before.allow.borrow), (1_519_999_900, 1_511_034_546, 755_517_273));
    // On its way: it is the owner's own move, so it counts nothing for the state and nothing for credit
    // (INTERFACES.md 40.3), and there is no `arrived` yet. No request is added: 41, as before.
    let (v, net) = verdict_of(mover(1_945_000, 0, Aave::market(), moving(AHEAD_NS)), CHECK);
    assert_eq!((v.state.as_str(), v.action.as_str()), ("HEALTHY", "NONE"));
    assert_eq!((v.eq, v.eq_allow, v.allow.borrow), (1_478_199_902, 1_469_481_096, 734_740_548));
    assert!(v.arrived.is_empty());
    // A plan step's transfer of the same bitcoin (the funding plan's `to_evm` step, when it is built) counts at
    // 98% for the state: what stayed on NEAR, and 98% of the $41.80.
    let step = json!([move_entry("f276621922:0", "to_evm", MNBTC, 55_000, AHEAD_NS)]);
    let planned = checked(mover(1_945_000, 0, Aave::market(), step));
    assert_eq!((planned.eq, planned.eq_allow), (1_478_199_902 + 40_963_998, 1_469_481_096));
    assert!(!serde_json::to_string(&v).unwrap().contains("arrived"));
    assert_eq!(net.calls.len(), 41);
    // Aave's WBTC pool is full, so the stand-in delivers wrapped ether of the same value: 0.02 WETH, $44.94 at
    // the engine's price of ether. That is over 80% of the $41.80 sent, so the verdict says it arrived. It counts
    // where it is, as ETH held at the address, and nothing is in transit.
    let (v, _) = verdict_of(mover(1_945_000, 0, Aave { weth_spare: WETH_002, ..Aave::market() }, moving(AHEAD_NS)), CHECK);
    assert_eq!(v.arrived, ["move:1"]);
    assert!(serde_json::to_string(&v).unwrap().contains(r#""arrived":["move:1"]"#));
    assert_eq!((v.eq, v.pool.hold["ETH"]), (1_522_999_902, 44_800_000));
    assert!(v.allow.borrow > before.allow.borrow);
    // Posted at Aave already counts the same.
    let posted = checked(mover(1_945_000, 0, Aave { weth_posted: WETH_002, ..Aave::market() }, moving(AHEAD_NS)));
    assert_eq!(posted.arrived, ["move:1"]);
    // 0.0148 WETH is $33.26, under 80% of $41.80 ($33.44): not arrived yet. 0.015 WETH, $33.70, is.
    let short = checked(mover(1_945_000, 0, Aave { weth_spare: 14_800_000_000_000_000, ..Aave::market() }, moving(AHEAD_NS)));
    assert!(short.arrived.is_empty());
    let enough = checked(mover(1_945_000, 0, Aave { weth_spare: 15_000_000_000_000_000, ..Aave::market() }, moving(AHEAD_NS)));
    assert_eq!(enough.arrived, ["move:1"]);
    // Past its deadline and not there: it counts for nothing, and `top` names it.
    let late = checked(mover(1_945_000, 0, Aave::market(), moving(PASSED_NS)));
    assert_eq!((late.eq, late.arrived.len()), (1_478_199_902, 0));
    assert_eq!(late.top.last().unwrap(), "overdue: to_evm transfer move:1");
    // Aave's chain can't be read: no verdict at all, so nothing is marked arrived, and the refusal says why.
    let (out, _) = run(mover(1_945_000, 0, Aave { limited: 100, ..Aave::market() }, moving(AHEAD_NS)), CHECK, false);
    assert_eq!(out, r#"{"ok":false,"reason":"cannot read the Aave position on chain 84532: reserve: HTTP 429"}"#);
    // USDC sent the same way (to repay Aave) is settled by the USDC in the wallet there.
    let usdc = json!([move_entry("move:2", "to_evm", MUSDC, 23_000_000, AHEAD_NS)]);
    let owed = |cash: u128| Aave { weth_posted: WETH_002, debt: 23_000_000, cash, nonce: 5, ..Aave::market() };
    let sent = checked(mover(1_945_000, 0, owed(0), usdc.clone()));
    assert!(sent.arrived.is_empty());
    let there = checked(mover(1_945_000, 0, owed(22_900_000), usdc));
    assert_eq!(there.arrived, ["move:2"]);
}

#[test]
fn a_loan_coming_home_from_aaves_chain_counts_once_signed_mined_or_delivered() {
    // 0.02 WETH posted at Aave, $23 borrowed, and the $23 of USDC at the address.
    let loan = 23_000_000u128;
    let pos = |cash: u128, nonce: u64| Aave { weth_posted: WETH_002, debt: loan, cash, nonce, ..Aave::market() };
    let resting = checked(mover(1_945_000, 0, pos(loan, 4), json!([])));
    assert_eq!((resting.eq, resting.eq_allow), (1_522_999_902, 1_514_016_948));
    // The owner brings it home: `evm_withdraw` with a 1Click quote's expiry. The account lists the signed
    // transfer (nonce 4) and the 1Click transfer `move:2`.
    let listed = json!({"lender": {"lender": "aave", "kind": "transfer", "amount": loan.to_string(),
                                   "token": EVM_USDC, "evm_nonce": 4}});
    let going = move_entry("move:2", "e_home", "USDC", loan, AHEAD_NS);
    // 1. Signed and not mined: the chain's count is 4 and the wallet still shows the $23. The listed transfer
    //    takes it off the address, and the owner's own move counts nothing while it travels (INTERFACES.md 40.3):
    //    the $23 is out of the state and out of credit until it lands.
    let signed = checked(mover(1_945_000, 0, pos(loan, 4), json!([listed.clone(), going.clone()])));
    assert_eq!((signed.eq, signed.eq_allow), (resting.eq - 23_000_000, resting.eq_allow - 23_000_000));
    // 2. Mined and not delivered: the count is 5 and the wallet is empty. The listed transfer counts for nothing
    //    now, the chain's own reading has the USDC gone, and the verdict is the same in every figure.
    let mined = checked(mover(1_945_000, 0, pos(0, 5), json!([listed.clone(), going])));
    let figures = |v: &Verdict| (v.eq, v.eq_allow, v.im, v.allow.clone(), v.credit.clone(), ext_of(v), v.state.clone());
    assert_eq!(figures(&mined), figures(&signed));
    // 3. Delivered: $22.90 came to the account on NEAR, and the delivery settled the transfer there. It counts
    //    in full again, and can be withdrawn.
    let home = checked(mover(1_945_000, 22_900_000, pos(0, 5), json!([listed])));
    assert_eq!((home.eq, home.eq_allow, home.allow.withdraw), (1_522_899_902, 1_513_916_948, 22_900_000));
    // The engine marks no arrival for a move home, at any of the three moments.
    assert!(signed.arrived.is_empty() && mined.arrived.is_empty() && home.arrived.is_empty());
    // The loan itself is Aave's figure throughout.
    for v in [&resting, &signed, &mined, &home] {
        assert_eq!((v.ext[0].d, v.ext[0].hf_bp, v.state.as_str(), v.action.as_str()), (loan, 16_556, "HEALTHY", "NONE"));
    }
    // Collateral coming home, as the owner's own move: nothing while it travels. As a plan step's transfer (the
    // funding plan's `e_home` step, when it is built) it counts as its coin: 98% of $44.94 of ether.
    let weth_home = |id: &str| json!([move_entry(id, "e_home", WETH, WETH_002, AHEAD_NS)]);
    let v = checked(mover(1_945_000, 0, Aave { nonce: 5, ..Aave::market() }, weth_home("move:3")));
    assert_eq!(v.eq, 1_478_199_902);
    assert!(v.arrived.is_empty() && v.coins.uncertain.is_empty());
    let v = checked(mover(1_945_000, 0, Aave { nonce: 5, ..Aave::market() }, weth_home("f1:0")));
    assert!((v.eq - 1_478_199_902 - 44_041_000).abs() < 5_000, "{}", v.eq);
    // research/audit.md, A7: a move home of $1,000,000 that was never at the address, recorded and not overdue.
    // It adds nothing: the verdict's figures are those of the same account with no such record.
    let fake = json!([move_entry("move:9", "e_home", "USDC", 1_000_000_000_000, AHEAD_NS)]);
    let propped = checked(mover(1_945_000, 0, pos(0, 5), fake));
    let plain = checked(mover(1_945_000, 0, pos(0, 5), json!([])));
    assert_eq!(figures(&propped), figures(&plain));
    // A token the account's Aave settings don't list is refused in words.
    let odd = json!([move_entry("move:9", "e_home", "0x00000000000000000000000000000000000000ff", 5, AHEAD_NS)]);
    let (out, _) = run(mover(1_945_000, 0, Aave::market(), odd), CHECK, false);
    assert_eq!(
        out,
        r#"{"ok":false,"reason":"pending transfer move:9 is of 0x00000000000000000000000000000000000000ff, a token the account's Aave settings don't list"}"#
    );
}

#[test]
fn a_move_is_allowed_like_any_withdrawal_only_while_the_book_stands_without_the_money() {
    // The two intents that start a move are the ones they were: the token counts as leaving. That is how a move
    // counts for credit while it travels, so it is the right question; but it means an account drawn close to its
    // line can neither bring the Aave loan home nor send USDC back to repay Aave while it owes our pool.
    let loan = 23_000_000u128;
    let pos = |cash: u128| Aave { weth_posted: WETH_002, debt: loan, cash, nonce: 5, ..Aave::market() };
    let owing = |pool: u128, usdc: u128, cash: u128| World {
        debt: pool,
        loans: pool,
        ..mover(1_945_000, usdc, pos(cash), json!([]))
    };
    let home = format!(r#"{{"evm_withdraw":{{"token":"{EVM_USDC}","amount":"{loan}"}}}}"#);
    let back = format!(r#"{{"withdraw":{{"token":"{MUSDC}","amount":"22900000"}}}}"#);
    // Our pool is owed $100 or $700 of a line of about $768: both moves are allowed.
    for pool in [100_000_000, 700_000_000] {
        assert_eq!(verdict_of(owing(pool, 0, loan), &home).0.allow.withdraw, loan, "{pool}");
        assert_eq!(verdict_of(owing(pool, 22_900_000, 0), &back).0.allow.withdraw, 22_900_000, "{pool}");
    }
    // Owed $740, with $5 of the line left: neither is. The USDC going back would repay Aave and lower the debt,
    // but the verdict can't know what the client will do with it once it is there.
    assert_eq!(verdict_of(owing(740_000_000, 0, loan), &home).0.allow.withdraw, 0);
    assert_eq!(verdict_of(owing(740_000_000, 22_900_000, 0), &back).0.allow.withdraw, 0);
}
