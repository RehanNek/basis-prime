//! The lender reads and the book with lenders (FUNDING.md 6.1 and 6.2; INTERFACES.md 27), from recorded answers:
//! - `fixtures/mainnet/rhea_*.json`: Rhea's views on `contract.main.burrow.near` (0.16.2) at block 223,978,375,
//!   read on 10 Nov 2026 through `https://free.rpc.fastnear.com`. The account is `rhea000655.multica.near`, which
//!   has nBTC posted and owes USDC (and USDT).
//! - `fixtures/base_sepolia/aave_*.json`: Aave's test market on Base Sepolia at block 57,136,642, read the same day
//!   through `https://sepolia.base.org`: an address with a position (USDC posted, USDC owed) and one with none.
//!
//! - `fixtures/sandbox/rhea_copy_views.json`: the views of our own copy of Rhea (Rhea's release file, 0.15.7,
//!   sha256 `bdd286fe…`) in a local sandbox, under its testnet names, as `contracts/tests/tests/rhea.rs` saved them
//!   on 11 Nov 2026 (a copy of `research/data/rhea_copy_views.json`, sha256 `bdf93f09…`). One position, 1 nBTC
//!   posted against 40,000 USDC, read twice: with the copy's bitcoin price fixed at $75,000, and lowered to $50,000.
//!
//! The book tests start from pb-risk's saved runs (`pb-risk/tests/fixtures`), which carry prices, and add the
//! lender settings and answers to them.
use pb_read::book::{self, Book};
use pb_read::evm;
use pb_read::inputs::{AaveReads, Inputs, RheaReads};
use pb_read::lenders::{self, Holding, LenderBook, LenderPrice};
use pb_read::near;
use pb_read::read::{self, Net, Reply};
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};
use std::collections::BTreeMap;

const MUSDC: &str = "musdc.pbf-ops.testnet";
const MNBTC: &str = "mnbtc.pbf-ops.testnet";
const RHEA_ID: &str = "rhea.pbf-ops.testnet";
const POOL: &str = "0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27";
const WBTC: &str = "0x54114591963cf60ef3aa63befd6ec263d98145a4";
const USDC: &str = "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f";

fn file(path: &str) -> String {
    let full = format!("{}/{path}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&full).unwrap_or_else(|e| panic!("{full}: {e}"))
}

/// One of pb-risk's saved runs: its inputs.
fn saved(name: &str) -> Inputs {
    let v: Value = serde_json::from_str(&file(&format!("../pb-risk/tests/fixtures/{name}.json"))).unwrap();
    serde_json::from_value(v["inputs"].clone()).unwrap()
}

/// A recorded Rhea view, with mainnet's token ids renamed to the test account's (nothing else is changed).
fn rhea_view(name: &str) -> Value {
    let text = file(&format!("tests/fixtures/mainnet/{name}.json"))
        .replace("nbtc.bridge.near", MNBTC)
        .replace("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", MUSDC);
    serde_json::from_str::<Value>(&text).unwrap()["value"].clone()
}

/// The recorded Rhea answers. `only_usdc_debt` drops the account's USDT loan, which the engine refuses to count.
fn rhea_reads(account: &str, only_usdc_debt: bool) -> RheaReads {
    let mut account = rhea_view(account);
    if only_usdc_debt {
        if let Some(b) = account.get_mut("borrowed").and_then(Value::as_array_mut) {
            b.retain(|e| e["token_id"] == MUSDC);
        }
    }
    RheaReads {
        contract_id: RHEA_ID.into(),
        account,
        assets: rhea_view("rhea_get_assets_usdc_nbtc"),
        prices: [
            (MUSDC.to_string(), rhea_view("rhea_get_token_pyth_info_usdc")),
            (MNBTC.to_string(), rhea_view("rhea_get_token_pyth_info_nbtc")),
        ]
        .into_iter()
        .collect(),
    }
}

/// Our copy of Rhea's answers in the sandbox, `before` or `after` its bitcoin price was lowered.
fn copy_reads(when: &str) -> RheaReads {
    let saved: Value = serde_json::from_str(&file("tests/fixtures/sandbox/rhea_copy_views.json")).unwrap();
    assert_eq!((&saved["contract_id"], &saved["version"]), (&json!(RHEA_ID), &json!("0.15.7")));
    assert_eq!((&saved["usdc"], &saved["nbtc"]), (&json!(MUSDC), &json!(MNBTC)));
    let views = &saved[when]["views"];
    RheaReads {
        contract_id: RHEA_ID.into(),
        account: views["get_account"].clone(),
        assets: views["get_assets"].clone(),
        prices: [MUSDC, MNBTC]
            .into_iter()
            .map(|id| (id.to_string(), views["get_token_pyth_info"][id].clone()))
            .collect(),
    }
}

/// A recorded Aave read: each call's request data and answer, by the recorder's name.
fn aave_record(name: &str) -> Value {
    serde_json::from_str(&file(&format!("tests/fixtures/base_sepolia/{name}.json"))).unwrap()
}

fn recorded_hex(rec: &Value, call: &str) -> String {
    rec["calls"][call]["reply"]["result"].as_str().unwrap().to_string()
}

/// The recorded answers under the names `AaveReads::calls` uses.
fn aave_reads(name: &str, address: Option<&str>) -> AaveReads {
    let rec = aave_record(name);
    let mut calls: BTreeMap<String, String> = [
        ("reserve", "getReserveData_usdc"),
        ("free", "getVirtualUnderlyingBalance_usdc"),
    ]
    .into_iter()
    .map(|(k, r)| (k.to_string(), recorded_hex(&rec, r)))
    .collect();
    calls.insert(format!("config:{WBTC}"), recorded_hex(&rec, "getReserveConfigurationData_wbtc"));
    calls.insert(format!("price:{WBTC}"), recorded_hex(&rec, "getAssetPrice_wbtc"));
    // WBTC's supply cap as it was before the pool filled up: 175 WBTC, with 100 supplied. `aave_caps` has the
    // full pool as recorded on 11 Nov.
    calls.insert(format!("caps:{WBTC}"), format!("0x{}{}", word(50), word(175)));
    calls.insert(format!("supplied:{WBTC}"), format!("0x{}", word(10_000_000_000)));
    if address.is_some() {
        calls.insert("account".into(), recorded_hex(&rec, "getUserAccountData"));
        calls.insert("debt".into(), recorded_hex(&rec, "getUserReserveData_usdc"));
        calls.insert(format!("posted:{WBTC}"), recorded_hex(&rec, "getUserReserveData_wbtc"));
        calls.insert(format!("balance:{WBTC}"), recorded_hex(&rec, "balanceOf_wbtc"));
        calls.insert(format!("balance:{USDC}"), recorded_hex(&rec, "balanceOf_usdc"));
        calls.insert("nonce".into(), recorded_hex(&rec, "eth_getTransactionCount"));
    }
    AaveReads {
        chain_id: 84532,
        address: address.map(str::to_string),
        block: None,
        calls,
    }
}

fn lender_settings(rhea: bool, aave: bool) -> Value {
    let mut l = serde_json::Map::new();
    if rhea {
        l.insert("rhea".into(), json!({"contract_id": RHEA_ID, "collateral": [MNBTC]}));
    }
    if aave {
        l.insert(
            "aave".into(),
            json!({"chain_id": 84532, "pool": "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
                "usdc": {"symbol": "USDC", "address": "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", "decimals": 6},
                "collateral": [{"symbol": "WBTC", "address": "0x54114591963CF60EF3aA63bEfD6eC263D98145a4", "decimals": 8}],
                "max_fee_per_gas": "5000000000"}),
        );
    }
    Value::Object(l)
}

fn permission() -> Value {
    json!({"lenders": ["aave", "rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any"})
}

/// A saved run whose account has the lender settings and the permission.
fn with_lenders(name: &str, rhea: bool, aave: bool) -> Inputs {
    let mut inp = saved(name);
    inp.near.config["lenders"] = lender_settings(rhea, aave);
    inp.near.state["permission"] = permission();
    inp
}

fn px(b: &Book, coin: &str) -> f64 {
    b.built.market.px[coin]
}

fn word(x: u128) -> String {
    format!("{x:064x}")
}

// ------------------------------------------------------------------------------------------ selectors, decoder

#[test]
fn every_selector_is_the_keccak_of_its_signature_and_matches_what_the_chain_answered() {
    let selector = |sig: &str| -> String {
        Keccak256::digest(sig.as_bytes())[..4].iter().map(|b| format!("{b:02x}")).collect()
    };
    for (sel, sig) in evm::SELECTORS {
        assert_eq!(selector(sig), sel, "{sig}");
    }
    // research/aave.md's five Pool selectors, recomputed.
    assert_eq!(selector("supply(address,uint256,address,uint16)"), "617ba037");
    assert_eq!(selector("borrow(address,uint256,uint256,uint16,address)"), "a415bcad");
    assert_eq!(selector("repay(address,uint256,uint256,address)"), "573ade81");
    assert_eq!(selector("withdraw(address,uint256,address)"), "69328dec");
    assert_eq!(selector("getUserAccountData(address)"), "bf92857c");
    // The requests the program builds are the ones Base Sepolia answered when the fixtures were recorded.
    let rec = aave_record("aave_position");
    let user = rec["address"].as_str().unwrap();
    let conf = near::config(&json!({"tokens": [], "pool_id": "p", "lenders": lender_settings(false, true)})).unwrap();
    let chain = evm::chain(84532).unwrap();
    let asks: BTreeMap<String, Value> = read::aave_asks(conf.lenders.aave.as_ref().unwrap(), chain, Some(user))
        .into_iter()
        .map(|(k, body)| (k, serde_json::from_str(&body).unwrap()))
        .collect();
    assert_eq!(asks.len(), 12);
    for (key, recorded, to) in [
        ("account", "getUserAccountData", POOL),
        ("debt", "getUserReserveData_usdc", chain.data_provider),
        (&*format!("posted:{WBTC}"), "getUserReserveData_wbtc", chain.data_provider),
        (&*format!("config:{WBTC}"), "getReserveConfigurationData_wbtc", chain.data_provider),
        ("reserve", "getReserveData_usdc", chain.data_provider),
        ("free", "getVirtualUnderlyingBalance_usdc", chain.data_provider),
        (&*format!("balance:{WBTC}"), "balanceOf_wbtc", WBTC),
        (&*format!("balance:{USDC}"), "balanceOf_usdc", USDC),
        (&*format!("price:{WBTC}"), "getAssetPrice_wbtc", chain.oracle),
    ] {
        let ask = &asks[key];
        assert_eq!(ask["method"], "eth_call", "{key}");
        assert_eq!(ask["params"][0]["to"], to, "{key}");
        assert_eq!(ask["params"][0]["to"], rec["calls"][recorded]["to"], "{key}");
        assert_eq!(ask["params"][0]["data"], rec["calls"][recorded]["data"], "{key}");
    }
    assert_eq!(asks["nonce"]["method"], "eth_getTransactionCount");
    assert_eq!(asks["nonce"]["params"], json!([user, "latest"]));
    // Without an address only the market is asked for.
    let market = read::aave_asks(conf.lenders.aave.as_ref().unwrap(), chain, None);
    let names: Vec<&str> = market.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        names,
        ["reserve", "free", &*format!("config:{WBTC}"), &*format!("price:{WBTC}"), &*format!("caps:{WBTC}"),
         &*format!("supplied:{WBTC}")]
    );
    // The two cap reads are the requests Base Sepolia answered on 11 Nov (`aave_caps`).
    let caps = aave_record("aave_caps");
    for (key, recorded) in [(format!("caps:{WBTC}"), "getReserveCaps_wbtc"), (format!("supplied:{WBTC}"), "getATokenTotalSupply_wbtc")] {
        assert_eq!(asks[&key]["params"][0]["to"], caps["calls"][recorded]["to"], "{key}");
        assert_eq!(asks[&key]["params"][0]["data"], caps["calls"][recorded]["data"], "{key}");
    }
}

#[test]
fn the_decoder_reads_base_sepolias_answers() {
    let rec = aave_record("aave_position");
    let a = evm::user_account_data(&recorded_hex(&rec, "getUserAccountData")).unwrap();
    // $73.32 posted and $27.00 owed, a threshold of 86% and a health factor of 2.335.
    assert_eq!((a.collateral_base, a.debt_base), (7_331_687_042, 2_699_880_162));
    assert_eq!((a.liq_threshold_bp, a.ltv_bp), (8_600, 8_250));
    assert_eq!(a.health_factor, Some(2_335_381_749_480_775_658));
    assert_eq!(a.hf_bp(), Some(23_353));
    let debt = evm::user_reserve(&recorded_hex(&rec, "getUserReserveData_usdc")).unwrap();
    assert_eq!((debt.posted, debt.debt, debt.is_collateral), (73_335_359, 27_005_610, true));
    let wbtc = evm::user_reserve(&recorded_hex(&rec, "getUserReserveData_wbtc")).unwrap();
    assert_eq!((wbtc.posted, wbtc.debt, wbtc.is_collateral), (0, 0, false));
    // WBTC on the test market: 8 decimals, lends 81.5%, liquidates at 83% (research/aave.md).
    let c = evm::reserve_config(&recorded_hex(&rec, "getReserveConfigurationData_wbtc")).unwrap();
    assert_eq!((c.decimals, c.ltv_bp, c.liq_threshold_bp), (8, 8_150, 8_300));
    assert!(c.is_collateral && c.active && !c.frozen);
    // USDC: borrowers pay 0.74% and depositors earn 0.09%; $44.7M is free.
    let r = evm::reserve_rates(&recorded_hex(&rec, "getReserveData_usdc")).unwrap();
    assert_eq!((r.borrow_bp, r.supply_bp), (74, 9));
    assert_eq!(
        evm::single(&recorded_hex(&rec, "getVirtualUnderlyingBalance_usdc"), "free"),
        Ok(44_744_942_212_774)
    );
    assert_eq!(evm::single(&recorded_hex(&rec, "getAssetPrice_wbtc"), "price"), Ok(7_379_889_359_984));
    assert_eq!(evm::single(&recorded_hex(&rec, "balanceOf_usdc"), "balance"), Ok(1_000_000));
    assert_eq!(evm::quantity(&recorded_hex(&rec, "eth_getTransactionCount")), Some(169));
    // An address with nothing: no debt, so no health factor (Aave answers the largest uint256).
    let none = aave_record("aave_empty");
    let a = evm::user_account_data(&recorded_hex(&none, "getUserAccountData")).unwrap();
    assert_eq!((a.collateral_base, a.debt_base, a.health_factor, a.hf_bp()), (0, 0, None, None));
    assert_eq!(evm::quantity(&recorded_hex(&none, "eth_getTransactionCount")), Some(0));
    // A short or odd answer is refused, in words.
    assert!(evm::user_account_data("0x").unwrap_err().contains("getUserAccountData"));
    assert!(evm::reserve_rates(&format!("0x{}", word(1))).unwrap_err().contains("12"));
}

// ---------------------------------------------------------------------------------------------- the parsers

fn client(state: Value) -> near::ClientState {
    near::state(&state).unwrap()
}

fn config(rhea: bool, aave: bool) -> near::Config {
    near::config(&json!({"pool_id": "pool.pbf.testnet", "lenders": lender_settings(rhea, aave), "tokens": [
        {"id": MUSDC, "symbol": "USDC", "decimals": 6}, {"id": MNBTC, "symbol": "nBTC", "decimals": 8}]}))
    .unwrap()
}

#[test]
fn rheas_recorded_position_parses() {
    let conf = config(true, false);
    let rhea = conf.lenders.rhea.as_ref().unwrap();
    let who = client(json!({"counter": 1, "permission": permission()}));
    let balances: BTreeMap<String, u128> =
        [(MUSDC.to_string(), 250_000_000), (MNBTC.to_string(), 30_000_000)].into_iter().collect();
    // As recorded, the account also owes USDT there: a loan the engine can't count, so it refuses.
    let e = lenders::rhea_position(&rhea_reads("rhea_get_account", false), rhea, &conf, &who, &balances, 100).unwrap_err();
    assert!(e.contains("usdt.tether-token.near") && e.contains("repay it first"), "{e}");
    let read = lenders::rhea_position(&rhea_reads("rhea_get_account", true), rhea, &conf, &who, &balances, 100).unwrap();
    let nbtc = |raw| Holding { engine: "nBTC".into(), id: MNBTC.into(), decimals: 8, raw };
    // 0.00496276 nBTC posted (its wNEAR and ZEC aren't the account's Rhea collateral, so they don't count), and
    // $288.717955 of USDC owed, rounded up.
    assert_eq!(read.pos.posted, vec![nbtc(496_276)]);
    assert_eq!(read.pos.spare, vec![nbtc(30_000_000)]);
    assert_eq!((read.pos.debt_micro, read.pos.cash_micro, read.pos.pending_micro), (288_717_955, 250_000_000, 0));
    assert!(read.pos.permitted);
    // nBTC's ratio is 0.80 and USDC's 0.95; Rhea prices nBTC from Pyth, so it has no price of its own to read.
    assert_eq!((read.ratios["nBTC"], read.usdc_ratio_bp), (8_000, 9_500));
    assert_eq!(read.prices["nBTC"], LenderPrice::Engine);
    // USDC at Rhea on 10 Nov: 16.05% to borrow, 10.46% to deposit, $1.87M free.
    let assets = rhea_view("rhea_get_assets_usdc_nbtc");
    let apr = |k: &str| (assets[0][k].as_str().unwrap().parse::<f64>().unwrap() * 1e4).round() as u32;
    assert_eq!((read.pos.rate_bp, read.pos.supply_bp), (apr("borrow_apr"), apr("supply_apr")));
    assert!((1_000..3_000).contains(&read.pos.rate_bp) && read.pos.supply_bp < read.pos.rate_bp);
    let n = |path: &str| assets[0].pointer(path).unwrap().as_str().unwrap().parse::<u128>().unwrap();
    let free = (n("/supplied/balance") + n("/reserved") + n("/prot_fee") - n("/borrowed/balance")) / 10u128.pow(12);
    assert_eq!(read.pos.free_micro, free);
    assert!((1_000_000_000_000..3_000_000_000_000).contains(&free), "{free}");

    // Priced at a reference of $75,000: the lender's way, and the cushion its way.
    let pos = read.clone().priced(&|_| 75_000.0);
    assert_eq!(pos.posted_micro, 372_207_000);
    assert_eq!(pos.spare_micro, 22_500_000_000);
    assert_eq!(pos.liq_bp, 7_600);
    // 372.207 x 0.80 over 288.717955 / 0.95.
    let owed = (288_717_955u128 * 10_000).div_ceil(9_500);
    assert_eq!(pos.hf_bp, Some((372_207_000u128 * 8_000 / 10_000 * 10_000 / owed) as u32));
    assert_eq!(pos.hf_bp, Some(9_797));
    assert_eq!(pos.hf_bp, risk_core::lender::hf_bp(pos.posted_micro, pos.liq_bp, pos.debt_micro));

    // A default price on the token is Rhea's own: $70,000 a bitcoin here (multiplier 7,000,000 at 10 decimals).
    let mut own = rhea_reads("rhea_get_account", true);
    own.prices.get_mut(MNBTC).unwrap()["default_price"] = json!({"multiplier": "7000000", "decimals": 10});
    let read = lenders::rhea_position(&own, rhea, &conf, &who, &balances, 100).unwrap();
    assert_eq!(read.prices["nBTC"], LenderPrice::Rhea { multiplier: 7_000_000, decimals: 10 });
    assert_eq!(read.priced(&|_| 75_000.0).posted_micro, 347_393_200);

    // An account that never used Rhea: nothing posted or owed, and the cushion is what nBTC would give.
    let fresh = lenders::rhea_position(&rhea_reads("rhea_get_account_none", false), rhea, &conf, &who, &balances, 100)
        .unwrap()
        .priced(&|_| 75_000.0);
    assert_eq!((fresh.posted.len(), fresh.debt_micro, fresh.hf_bp, fresh.liq_bp), (0, 0, None, 7_600));
    // A missing piece is a refusal, never a guess.
    let mut gone = rhea_reads("rhea_get_account", true);
    gone.prices.remove(MNBTC);
    assert!(lenders::rhea_position(&gone, rhea, &conf, &who, &balances, 100).unwrap_err().contains("price setting"));
    let mut gone = rhea_reads("rhea_get_account", true);
    gone.assets = json!([]);
    assert!(lenders::rhea_position(&gone, rhea, &conf, &who, &balances, 100).unwrap_err().contains("get_assets"));
}

#[test]
fn our_copy_of_rhea_reads_as_the_sandbox_answered_and_its_fixed_price_values_the_collateral() {
    let conf = config(true, false);
    let rhea = conf.lenders.rhea.as_ref().unwrap();
    let who = client(json!({"counter": 1, "permission": permission()}));
    let balances: BTreeMap<String, u128> =
        [(MUSDC.to_string(), 3_000_000_000), (MNBTC.to_string(), 50_000_000)].into_iter().collect();
    let nbtc = |raw| Holding { engine: "nBTC".into(), id: MNBTC.into(), decimals: 8, raw };
    let saved: Value = serde_json::from_str(&file("tests/fixtures/sandbox/rhea_copy_views.json")).unwrap();

    // Bitcoin fixed at $75,000 on the copy.
    let read = lenders::rhea_position(&copy_reads("before"), rhea, &conf, &who, &balances, 100).unwrap();
    // 1 nBTC posted. Rhea keeps it with 18 decimals; the token has 8.
    assert_eq!(read.pos.posted, vec![nbtc(100_000_000)]);
    assert_eq!(read.pos.spare, vec![nbtc(50_000_000)]);
    // 40,000 USDC owed, and a sliver of interest, rounded up to the next millionth of a dollar.
    assert_eq!((read.pos.debt_micro, read.pos.cash_micro, read.pos.pending_micro), (40_000_000_002, 3_000_000_000, 0));
    // The copy's own settings: the same ratios as mainnet, so it liquidates at 76%.
    assert_eq!((read.ratios["nBTC"], read.usdc_ratio_bp), (8_000, 9_500));
    // Its USDC rates, 0.29% to borrow and 0.01% to deposit, and the $960,000 it has free to lend.
    assert_eq!((read.pos.rate_bp, read.pos.supply_bp), (29, 1));
    assert_eq!(read.pos.free_micro, 960_000_000_000);
    // The price is the copy's own: `default_price` of 7,500,000 at 10 decimals is $75,000 for 10^8 units.
    assert_eq!(read.prices["nBTC"], LenderPrice::Rhea { multiplier: 7_500_000, decimals: 10 });
    // So the engine's reference price doesn't matter: at $76,000 or $99,999 the collateral is Rhea's $75,000, the
    // spare half a bitcoin its $37,500, and the cushion Rhea's way is 75,000 x 0.80 over 40,000 / 0.95.
    for engine_px in [76_000.0, 99_999.0] {
        let pos = read.clone().priced(&|_| engine_px);
        assert_eq!((pos.posted_micro, pos.spare_micro, pos.liq_bp), (75_000_000_000, 37_500_000_000, 7_600));
        assert_eq!(pos.hf_bp, Some(14_249));
    }
    // The sandbox test worked the same figure out from these answers its own way: with the sliver of interest the
    // cushion is just under 1.425.
    assert_eq!(saved["before"]["health_bp"], 14_249);

    // Lowered to $50,000: the same position, a few more millionths of interest, and a cushion under 1.
    let read = lenders::rhea_position(&copy_reads("after"), rhea, &conf, &who, &balances, 100).unwrap();
    assert_eq!(read.prices["nBTC"], LenderPrice::Rhea { multiplier: 5_000_000, decimals: 10 });
    assert_eq!((read.pos.posted.clone(), read.pos.debt_micro), (vec![nbtc(100_000_000)], 40_000_000_019));
    let pos = read.priced(&|_| 76_000.0);
    assert_eq!((pos.posted_micro, pos.spare_micro), (50_000_000_000, 25_000_000_000));
    assert_eq!(pos.hf_bp, Some(9_499));
    assert_eq!(saved["after"]["health_bp"], 9_499);
    assert_eq!(pos.hf_bp, risk_core::lender::hf_bp(pos.posted_micro, pos.liq_bp, pos.debt_micro));

    // With the fixed price taken off (Rhea's feed prices the token, as on mainnet), the engine's price is used.
    let mut feed = copy_reads("after");
    feed.prices.get_mut(MNBTC).unwrap()["default_price"] = Value::Null;
    let read = lenders::rhea_position(&feed, rhea, &conf, &who, &balances, 100).unwrap();
    assert_eq!(read.prices["nBTC"], LenderPrice::Engine);
    assert_eq!(read.priced(&|_| 76_000.0).posted_micro, 76_000_000_000);
    // A fixed price that isn't one is refused.
    let mut odd = copy_reads("after");
    odd.prices.get_mut(MNBTC).unwrap()["default_price"] = json!({"multiplier": "0", "decimals": 10});
    assert!(lenders::rhea_position(&odd, rhea, &conf, &who, &balances, 100).unwrap_err().contains("is not a price"));
}

#[test]
fn aaves_recorded_position_parses() {
    let conf = config(false, true);
    let aave = conf.lenders.aave.as_ref().unwrap();
    let who = client(json!({"counter": 1, "permission": {"lenders": ["rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500,
        "moves": "off"}}));
    let (read, nonce) = lenders::aave_position(&aave_reads("aave_position", Some("0xaa")), aave, &who, 100).unwrap();
    let pos = read.priced(&|_| 75_000.0);
    // The recorded address posted USDC, not WBTC: nothing of ours is posted, and all it owes is counted.
    assert_eq!(nonce, Some(169));
    assert!(pos.posted.is_empty() && pos.spare.is_empty() && !pos.permitted);
    assert_eq!((pos.debt_micro, pos.cash_micro, pos.pending_micro), (27_005_610, 1_000_000, 0));
    assert_eq!((pos.hf_bp, pos.liq_bp), (Some(23_353), 8_600));
    assert_eq!((pos.rate_bp, pos.supply_bp, pos.free_micro), (74, 9, 44_744_942_212_774));
    // No position: the cushion is WBTC's own threshold, and there is no health factor.
    let (read, nonce) = lenders::aave_position(&aave_reads("aave_empty", Some("0xaa")), aave, &who, 100).unwrap();
    let pos = read.priced(&|_| 75_000.0);
    assert_eq!((nonce, pos.hf_bp, pos.liq_bp, pos.debt_micro), (Some(0), None, 8_300, 0));
    // No Ethereum address yet: only the market is there.
    let (read, nonce) = lenders::aave_position(&aave_reads("aave_empty", None), aave, &who, 100).unwrap();
    assert_eq!((nonce, read.pos.liq_bp, read.pos.rate_bp), (None, 8_300, 74));
    // A missing call, or another chain's answers, is a refusal.
    let mut gone = aave_reads("aave_position", Some("0xaa"));
    gone.calls.remove("debt");
    assert!(lenders::aave_position(&gone, aave, &who, 100).unwrap_err().contains("debt wasn't read"));
    let mut other = aave_reads("aave_position", Some("0xaa"));
    other.chain_id = 1;
    assert!(lenders::aave_position(&other, aave, &who, 100).unwrap_err().contains("chain 1"));
}

// ------------------------------------------------------------------------------------------------- the book

#[test]
fn an_account_with_no_lenders_reads_and_books_as_before() {
    for name in ["fresh", "deposits", "loan", "hedged", "drill"] {
        let v: Value = serde_json::from_str(&file(&format!("../pb-risk/tests/fixtures/{name}.json"))).unwrap();
        let inp = saved(name);
        // The canonical form is the saved one, to the byte: no new field appears, and its hash is the one the
        // saved verdict carries.
        assert_eq!(serde_json::from_str::<Value>(&inp.canonical()).unwrap(), v["inputs"], "{name}");
        assert_eq!(v["verdict"]["in"], inp.hash(), "{name}");
        assert!(!inp.canonical().contains("lenders"));
        let b = book::build(&inp).unwrap();
        assert_eq!(b.lenders, LenderBook::default(), "{name}");
        assert!(b.conf.lenders.is_empty());
        assert_eq!(b.account.debt, b.debt_micro as f64 / 1e6, "{name}");
        assert!(b.account.near.get("WBTC").is_none());
    }
}

#[test]
fn a_rhea_position_counts_in_the_book() {
    let plain = book::build(&saved("loan")).unwrap();
    let mut inp = with_lenders("loan", true, false);
    inp.lenders.rhea = Some(rhea_reads("rhea_get_account", true));
    let b = book::build(&inp).unwrap();
    assert_eq!(b.lenders.positions.len(), 1);
    let p = b.lenders.get("rhea").unwrap();
    let btc = px(&b, "BTC");
    // Posted nBTC is valued at the engine's reference price, with no depeg ratio: Rhea reads nBTC as BTC.
    assert_eq!(p.posted_micro, (496_276.0 / 1e8 * btc * 1e6).floor() as u128);
    assert_eq!(p.spare_micro, (0.3 * btc * 1e6).floor() as u128);
    assert_eq!((p.debt_micro, p.pending_micro, p.liq_bp, p.permitted), (288_717_955, 0, 7_600, true));
    assert_eq!(p.cash_micro, 5_000_000_000);
    assert_eq!(p.hf_bp, risk_core::lender::hf_bp(p.posted_micro, 7_600, p.debt_micro));
    assert_eq!((b.lenders.min_hf_bp, b.lenders.max_rate_bp, b.lenders.evm_nonce), (Some(15_000), Some(2_500), None));
    // The whole debt is the pool's and Rhea's; the pool's own figure stays.
    assert_eq!(b.debt_micro, plain.debt_micro);
    assert_eq!(b.account.debt, (plain.debt_micro + 288_717_955) as f64 / 1e6);
    // The posted nBTC is in the book under nBTC, and marked as not on NEAR.
    assert_eq!(b.account.near.get_or("nBTC", 0.0), 0.3 + 496_276.0 / 1e8);
    assert_eq!(b.account.near.get_or("USDC", 0.0), plain.account.near.get_or("USDC", 0.0));
    assert_eq!(b.lenders.locked, [("nBTC".to_string(), 496_276u128)].into_iter().collect());
    assert_eq!(b.raw_balance, plain.raw_balance);
}

#[test]
fn a_coin_held_only_at_a_lender_is_priced() {
    // The saved "fresh" account holds nothing, so no coin is priced for it.
    assert!(book::held_coins(&saved("fresh")).unwrap().is_empty());
    let mut inp = with_lenders("fresh", true, false);
    inp.lenders.rhea = Some(rhea_reads("rhea_get_account_none", false));
    assert!(book::held_coins(&inp).unwrap().is_empty());
    // nBTC posted at Rhea and nowhere else: BTC is priced.
    inp.lenders.rhea = Some(rhea_reads("rhea_get_account", true));
    assert_eq!(book::held_coins(&inp).unwrap().into_iter().collect::<Vec<_>>(), ["BTC"]);
    // Aave is read after the prices, so its collateral's coin is priced whenever the config names Aave.
    let inp = with_lenders("fresh", false, true);
    assert_eq!(book::held_coins(&inp).unwrap().into_iter().collect::<Vec<_>>(), ["BTC"]);
}

/// The recorded Aave position with 1.31 WBTC posted and 0.2 WBTC spare written over the recorded zeros (the test
/// market had no address with WBTC posted and USDC owed in the 40,000 blocks searched).
fn aave_with_wbtc(address: &str) -> AaveReads {
    let mut reads = aave_reads("aave_position", Some(address));
    let posted = format!("0x{}{}", word(131_000_000), word(0).repeat(7)) + &word(1);
    reads.calls.insert(format!("posted:{WBTC}"), posted);
    reads.calls.insert(format!("balance:{WBTC}"), format!("0x{}", word(20_000_000)));
    reads
}

#[test]
fn an_aave_position_counts_in_the_book_and_wbtc_is_a_sixth_token() {
    let plain = book::build(&saved("hedged")).unwrap();
    let mut inp = with_lenders("hedged", false, true);
    let address = inp.hl.address.clone().unwrap();
    inp.lenders.aave = Some(aave_with_wbtc(&address));
    let b = book::build(&inp).unwrap();
    let p = b.lenders.get("aave").unwrap();
    let wbtc = |raw| Holding { engine: "WBTC".into(), id: WBTC.into(), decimals: 8, raw };
    assert_eq!((&p.posted, &p.spare), (&vec![wbtc(131_000_000)], &vec![wbtc(20_000_000)]));
    // Valued at Aave's own oracle price, $73,798.89359984.
    assert_eq!((p.posted_micro, p.spare_micro), (96_676_550_615, 14_759_778_719));
    assert_eq!((p.debt_micro, p.cash_micro, p.hf_bp, p.liq_bp), (27_005_610, 1_000_000, Some(23_353), 8_600));
    assert_eq!((p.rate_bp, p.supply_bp, p.free_micro), (74, 9, 44_744_942_212_774));
    assert_eq!(b.lenders.evm_nonce, Some(169));
    // The book: WBTC posted and spare, and the USDC at the Ethereum address, all marked as not on NEAR.
    assert_eq!(b.account.near.get_or("WBTC", 0.0), 1.51);
    assert_eq!(b.account.near.get_or("USDC", 0.0), plain.account.near.get_or("USDC", 0.0) + 1.0);
    assert_eq!(b.account.near.get_or("nBTC", 0.0), plain.account.near.get_or("nBTC", 0.0));
    assert_eq!(
        b.lenders.locked,
        [("USDC".to_string(), 1_000_000u128), ("WBTC".to_string(), 151_000_000)].into_iter().collect()
    );
    assert_eq!(b.account.debt, (plain.debt_micro + 27_005_610) as f64 / 1e6);
    assert_eq!(b.debt_micro, plain.debt_micro);
    // WBTC's depeg ratio is Aave's oracle price over the engine's BTC price, at most 1.
    let ratio = (73_798.893_599_84 / px(&b, "BTC")).min(1.0);
    assert_eq!(b.built.market.wrap["WBTC"], ratio);
    assert!(ratio > 0.9 && ratio <= 1.0, "{ratio}");
    assert!(!b.built.reduce_only.contains("WBTC"));
    assert_eq!(book::aave_oracle_usd(&inp, "WBTC"), Some(73_798.893_599_84));
    // The engine values it like nBTC: the same coin, the same depeg sizes.
    let e_mark = b.engine.equity_mark(&b.account, &b.built.market);
    let before = plain.engine.equity_mark(&plain.account, &plain.built.market);
    let added = 1.51 * ratio * px(&b, "BTC") + 1.0 - 27.005_61;
    assert!((e_mark - before - added).abs() < 1e-6, "{e_mark} {before} {added}");
}

#[test]
fn both_lenders_come_aave_first_and_borrows_under_way_count_as_debt() {
    let plain = book::build(&saved("hedged")).unwrap();
    let mut inp = with_lenders("hedged", true, true);
    let address = inp.hl.address.clone().unwrap();
    let height = inp.block.height;
    inp.lenders.aave = Some(aave_with_wbtc(&address));
    inp.lenders.rhea = Some(rhea_reads("rhea_get_account", true));
    // A Rhea borrow whose block hasn't passed, one whose block has, a signed Aave borrow the chain hasn't mined
    // (nonce 169, the chain's count) and one it has (168). A signed supply is not debt.
    inp.near.state["pending"] = json!([
        {"lender": {"lender": "rhea", "kind": "borrow", "amount": "40000000", "until_block": height}},
        {"lender": {"lender": "rhea", "kind": "borrow", "amount": "7000000", "until_block": height - 1}},
        {"lender": {"lender": "rhea", "kind": "supply", "amount": "1000", "until_block": height + 5}}]);
    inp.near.state["evm"] = json!({"nonce": 171, "signed": [
        {"nonce": 168, "kind": "borrow", "token": USDC, "amount": "9000000", "to": POOL, "raw": "0x02", "hash": "0x01",
         "step": "f1:1", "signed_at": "1"},
        {"nonce": 169, "kind": "borrow", "token": "0xBA50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", "amount": "5000000",
         "to": POOL, "raw": "0x02", "hash": "0x02", "step": "f1:2", "signed_at": "2"},
        {"nonce": 170, "kind": "supply", "token": WBTC, "amount": "100", "to": POOL, "raw": "0x02", "hash": "0x03",
         "step": "f1:3", "signed_at": "3"}]});
    inp.near.state["funding"] = json!({"pid": format!("f{height}"), "amount": "45000000",
        "stored_at": inp.block.timestamp_ns, "expires_at": "9999999999999999999",
        "steps": [{"k": "l_borrow", "l": "rhea", "amt": 40000000, "done": true}, {"k": "p_borrow", "amt": 5000000, "done": false}]});
    let b = book::build(&inp).unwrap();
    let names: Vec<&str> = b.lenders.positions.iter().map(|p| p.lender.as_str()).collect();
    assert_eq!(names, ["aave", "rhea"]);
    let (aave, rhea) = (b.lenders.get("aave").unwrap(), b.lenders.get("rhea").unwrap());
    assert_eq!((aave.pending_micro, rhea.pending_micro), (5_000_000, 40_000_000));
    assert_eq!((aave.owed_micro(), rhea.owed_micro()), (32_005_610, 328_717_955));
    assert_eq!(b.lenders.owed_micro(), 360_723_565);
    assert_eq!(b.account.debt, (plain.debt_micro + 360_723_565) as f64 / 1e6);
    // The health factors are the lenders' own view: what they show now, without the borrows under way.
    assert_eq!(aave.hf_bp, Some(23_353));
    assert_eq!(rhea.hf_bp, risk_core::lender::hf_bp(rhea.posted_micro, 7_600, rhea.debt_micro));
    // Both kinds of bitcoin are in the book, each under its own name.
    assert_eq!(b.account.near.get_or("WBTC", 0.0), 1.51);
    assert_eq!(b.account.near.get_or("nBTC", 0.0), plain.account.near.get_or("nBTC", 0.0) + 496_276.0 / 1e8);
    assert_eq!(b.lenders.locked["nBTC"], 496_276);
    // The funding plan is held while a step is unfinished and it hasn't expired.
    let f = b.lenders.funding.as_ref().unwrap();
    assert_eq!((f.pid.as_str(), f.amount_micro, f.steps.len()), (format!("f{height}").as_str(), 45_000_000, 2));
    inp.near.state["funding"]["expires_at"] = json!(inp.block.timestamp_ns);
    assert!(book::build(&inp).unwrap().lenders.funding.is_none());
}

/// The "loan" run as an account with the recorded Rhea position, and `pending` as its state's pending list.
fn rhea_with_pending(pending: Value) -> Inputs {
    let mut inp = with_lenders("loan", true, false);
    inp.lenders.rhea = Some(rhea_reads("rhea_get_account", true));
    inp.near.state["pending"] = pending;
    inp
}

#[test]
fn a_pending_borrow_counts_as_debt_at_that_lender_until_its_block_has_passed() {
    let quiet = book::build(&rhea_with_pending(json!([]))).unwrap();
    let height = saved("loan").block.height;
    // The account sent a $100 borrow to Rhea, and lists it until block `height + 20` (the stage 2 shape).
    let entry = |until: u64| json!([{"lender": {"lender": "rhea", "kind": "borrow", "amount": "100000000", "until_block": until}}]);
    let b = book::build(&rhea_with_pending(entry(height + 20))).unwrap();
    let (p, q) = (b.lenders.get("rhea").unwrap(), quiet.lenders.get("rhea").unwrap());
    // It is owed there already: $288.72 that Rhea shows and the $100 on its way.
    assert_eq!((p.debt_micro, p.pending_micro, p.owed_micro()), (288_717_955, 100_000_000, 388_717_955));
    assert_eq!(b.account.debt, quiet.account.debt + 100.0);
    assert_eq!(b.debt_micro, quiet.debt_micro, "our pool's own figure stays");
    // Its USDC is on its way too, and marked as not on NEAR. So equity is what it will be once the loan lands.
    assert_eq!(b.account.near.get_or("USDC", 0.0), quiet.account.near.get_or("USDC", 0.0) + 100.0);
    assert_eq!(b.lenders.locked["USDC"], 100_000_000);
    assert_eq!(b.raw_balance, quiet.raw_balance);
    let equity = |b: &Book| b.engine.equity_mark(&b.account, &b.built.market);
    assert!((equity(&b) - equity(&quiet)).abs() < 1e-6);
    // What Rhea itself shows hasn't changed: its collateral, its debt and its own health factor.
    assert_eq!((p.posted_micro, p.leaving_micro, p.hf_bp), (q.posted_micro, 0, q.hf_bp));
    // At the entry's own block it still counts. One block later it counts for nothing, listed or not.
    let at = book::build(&rhea_with_pending(entry(height))).unwrap();
    assert_eq!(at.lenders.get("rhea").unwrap().pending_micro, 100_000_000);
    let past = book::build(&rhea_with_pending(entry(height - 1))).unwrap();
    assert_eq!(past.lenders, quiet.lenders);
    assert_eq!(past.account.debt, quiet.account.debt);
    assert_eq!(past.account.near.get_or("USDC", 0.0), quiet.account.near.get_or("USDC", 0.0));
    // Two borrows add up. Another lender's entry, or another kind of action, is not debt here.
    let more = json!([
        {"lender": {"lender": "rhea", "kind": "borrow", "amount": "100000000", "until_block": height + 20}},
        {"lender": {"lender": "rhea", "kind": "borrow", "amount": "50000000", "until_block": height + 21}},
        {"lender": {"lender": "aave", "kind": "borrow", "amount": "7000000", "until_block": height + 20}},
        {"lender": {"lender": "rhea", "kind": "repay", "amount": "9000000", "until_block": height + 20}},
        {"borrow": {"amount": "5"}}]);
    let b = book::build(&rhea_with_pending(more)).unwrap();
    assert_eq!(b.lenders.get("rhea").unwrap().pending_micro, 150_000_000);
    assert_eq!(b.account.debt, quiet.account.debt + 150.0);
}

#[test]
fn a_pending_withdrawal_counts_as_collateral_already_gone_from_the_lender_until_its_block_has_passed() {
    let quiet = book::build(&rhea_with_pending(json!([]))).unwrap();
    let height = saved("loan").block.height;
    let q = quiet.lenders.get("rhea").unwrap().clone();
    let btc = px(&quiet, "BTC");
    let worth = |units: u128| (units as f64 / 1e8 * btc * 1e6).floor() as u128;
    // 0.00496276 nBTC is posted. The account asked 0.002 of it back, and lists that until block `height + 20`.
    let entry = |units: u128, until: u64| {
        json!([{"lender": {"lender": "rhea", "kind": "withdraw", "amount": units.to_string(), "until_block": until}}])
    };
    let b = book::build(&rhea_with_pending(entry(200_000, height + 20))).unwrap();
    let p = b.lenders.get("rhea").unwrap();
    // The lender's collateral counts without it: $377.17 less $152.00.
    assert_eq!((q.posted_micro, q.leaving_micro), (worth(496_276), 0));
    assert_eq!((p.leaving_micro, p.posted_micro), (worth(200_000), worth(496_276) - worth(200_000)));
    assert_eq!(p.shown_micro(), q.posted_micro);
    // So the cushion on what stays is lower than the one Rhea shows, which hasn't changed.
    assert_eq!(p.hf_bp, q.hf_bp);
    let stays = risk_core::lender::hf_bp(p.posted_micro, p.liq_bp, p.owed_micro()).unwrap();
    assert_eq!(u128::from(stays), (worth(496_276) - worth(200_000)) * 7_600 / 288_717_955);
    assert!(stays < q.hf_bp.unwrap() * 2 / 3, "{stays} against {:?}", q.hf_bp);
    assert_eq!((p.liq_bp, p.debt_micro, p.pending_micro), (7_600, q.debt_micro, 0));
    // The bitcoin is still the account's own, on its way to its NEAR balance: the book holds what it held.
    assert_eq!(p.posted, q.posted);
    assert_eq!(b.account.near.get_or("nBTC", 0.0), quiet.account.near.get_or("nBTC", 0.0));
    assert_eq!((&b.lenders.locked, b.account.debt), (&quiet.lenders.locked, quiet.account.debt));
    // More than is posted takes all of it, and no more.
    let all = book::build(&rhea_with_pending(entry(900_000, height))).unwrap();
    let p = all.lenders.get("rhea").unwrap();
    assert_eq!((p.posted_micro, p.leaving_micro), (0, q.posted_micro));
    // One block after the entry's block it counts for nothing.
    let past = book::build(&rhea_with_pending(entry(200_000, height - 1))).unwrap();
    assert_eq!(past.lenders, quiet.lenders);
    // An entry may name its token. One that names a token that isn't posted there takes nothing.
    let named = |token: &str| {
        json!([{"lender": {"lender": "rhea", "kind": "withdraw", "amount": "200000", "token": token,
                           "until_block": height + 20}}])
    };
    let b = book::build(&rhea_with_pending(named(MNBTC))).unwrap();
    assert_eq!(b.lenders.get("rhea").unwrap().leaving_micro, worth(200_000));
    let b = book::build(&rhea_with_pending(named(MUSDC))).unwrap();
    assert_eq!(b.lenders, quiet.lenders);
    // A borrow and a withdrawal together: more owed, against less.
    let both = json!([
        {"lender": {"lender": "rhea", "kind": "withdraw", "amount": "200000", "until_block": height + 20}},
        {"lender": {"lender": "rhea", "kind": "borrow", "amount": "100000000", "until_block": height + 20}}]);
    let b = book::build(&rhea_with_pending(both)).unwrap();
    let p = b.lenders.get("rhea").unwrap();
    assert_eq!((p.leaving_micro, p.pending_micro), (worth(200_000), 100_000_000));
}

#[test]
fn a_withdrawal_under_way_at_aave_comes_off_the_token_it_names() {
    // 1.31 WBTC posted at Aave, valued at Aave's own price. 0.31 of it is on its way back.
    let mut inp = with_lenders("hedged", false, true);
    let address = inp.hl.address.clone().unwrap();
    let height = inp.block.height;
    inp.lenders.aave = Some(aave_with_wbtc(&address));
    let quiet = book::build(&inp).unwrap();
    inp.near.state["pending"] = json!([{"lender": {"lender": "aave", "kind": "withdraw", "amount": "31000000",
        "token": "0x54114591963CF60EF3aA63bEfD6eC263D98145a4", "until_block": height + 3}}]);
    let b = book::build(&inp).unwrap();
    let (p, q) = (b.lenders.get("aave").unwrap(), quiet.lenders.get("aave").unwrap());
    assert_eq!(q.posted_micro, 96_676_550_615);
    assert_eq!(p.leaving_micro, 22_877_657_015);
    assert_eq!(p.posted_micro + p.leaving_micro, q.posted_micro);
    // Aave's own health factor is what Aave shows; the book's holdings are what they were.
    assert_eq!(p.hf_bp, Some(23_353));
    assert_eq!(b.account.near.get_or("WBTC", 0.0), 1.51);
}

/// The "hedged" run as an account with Aave alone: 1.31 WBTC posted, 0.2 WBTC and 1 USDC at its Ethereum address,
/// $27.01 owed, and the chain's count of its transactions at 169. `pending` and `signed` are what its state lists.
fn aave_with_actions(pending: Value, signed: Value) -> Inputs {
    let mut inp = with_lenders("hedged", false, true);
    let address = inp.hl.address.clone().unwrap();
    inp.lenders.aave = Some(aave_with_wbtc(&address));
    inp.near.state["pending"] = pending;
    inp.near.state["evm"] = json!({"nonce": 173, "signed": signed});
    inp
}

/// One signed transaction as `get_state().evm.signed` lists it (INTERFACES.md 33).
fn signed_tx(nonce: u64, kind: &str, token: &str, amount: u128) -> Value {
    json!({"nonce": nonce, "kind": kind, "token": token, "amount": amount.to_string(), "to": POOL, "raw": "0x02",
           "hash": format!("0x{nonce:064x}"), "step": null, "signed_at": "1"})
}

/// One Aave entry of `pending` (INTERFACES.md 33).
fn aave_entry(kind: &str, token: &str, amount: u128, evm_nonce: u64) -> Value {
    json!({"lender": {"lender": "aave", "kind": kind, "amount": amount.to_string(), "token": token,
                      "evm_nonce": evm_nonce}})
}

#[test]
fn a_signed_aave_borrow_counts_while_the_chain_has_not_used_its_nonce() {
    let quiet = book::build(&aave_with_actions(json!([]), json!([]))).unwrap();
    let q = quiet.lenders.get("aave").unwrap().clone();
    assert_eq!((quiet.lenders.evm_nonce, q.debt_micro, q.pending_micro, q.cash_micro), (Some(169), 27_005_610, 0, 1_000_000));
    // The account signed a $500 borrow with nonce 169 and lists it. The chain's count is 169: not used yet.
    let listed = json!([aave_entry("borrow", USDC, 500_000_000, 169)]);
    let b = book::build(&aave_with_actions(listed.clone(), json!([]))).unwrap();
    let p = b.lenders.get("aave").unwrap();
    // It is owed at Aave already, and its USDC is on its way to the address: equity is what it will be.
    assert_eq!((p.debt_micro, p.pending_micro, p.owed_micro()), (27_005_610, 500_000_000, 527_005_610));
    assert_eq!(b.account.debt, quiet.account.debt + 500.0);
    assert_eq!(b.account.near.get_or("USDC", 0.0), quiet.account.near.get_or("USDC", 0.0) + 500.0);
    assert_eq!(b.lenders.locked["USDC"], 501_000_000);
    assert_eq!((p.cash_micro, p.hf_bp, p.posted_micro), (1_000_000, q.hf_bp, q.posted_micro));
    // The same transaction shows in `evm.signed` too. It is one borrow, not two.
    let signed = json!([signed_tx(169, "borrow", USDC, 500_000_000)]);
    let both = book::build(&aave_with_actions(listed.clone(), signed.clone())).unwrap();
    assert_eq!(both.lenders.get("aave").unwrap().pending_micro, 500_000_000);
    // Signed again with a higher fee (the same nonce): still one.
    let bumped = json!([signed_tx(169, "borrow", USDC, 500_000_000), signed_tx(169, "borrow", USDC, 500_000_000)]);
    let again = book::build(&aave_with_actions(listed.clone(), bumped)).unwrap();
    assert_eq!(again.lenders.get("aave").unwrap().pending_micro, 500_000_000);
    // Signed and not listed: it counts all the same, because anyone can send it.
    let unlisted = book::build(&aave_with_actions(json!([]), signed)).unwrap();
    assert_eq!(unlisted.lenders.get("aave").unwrap().pending_micro, 500_000_000);
    // Once the chain has used the nonce (its count is past it), mined or reverted, Aave's own figures are the
    // truth, listed or not.
    let used = json!([aave_entry("borrow", USDC, 500_000_000, 168)]);
    let after = book::build(&aave_with_actions(used, json!([signed_tx(168, "borrow", USDC, 500_000_000)]))).unwrap();
    assert_eq!(after.lenders, quiet.lenders);
    assert_eq!(after.account.debt, quiet.account.debt);
    // Two borrows with two nonces add up. What adds no risk (a supply, a repayment, an approval) counts for nothing.
    let two = json!([aave_entry("borrow", USDC, 500_000_000, 169), aave_entry("borrow", USDC, 250_000_000, 170)]);
    let harmless = json!([signed_tx(171, "supply", WBTC, 5), signed_tx(172, "repay", USDC, 9), signed_tx(173, "approve", USDC, 1)]);
    let b = book::build(&aave_with_actions(two, harmless)).unwrap();
    assert_eq!(b.lenders.get("aave").unwrap().pending_micro, 750_000_000);
    // Rhea's entries keep their block, and an Aave entry with a block still reads as one.
    let by_block = json!([{"lender": {"lender": "aave", "kind": "borrow", "amount": "7000000",
                                      "until_block": saved("hedged").block.height}}]);
    let b = book::build(&aave_with_actions(by_block, json!([]))).unwrap();
    assert_eq!(b.lenders.get("aave").unwrap().pending_micro, 7_000_000);
}

#[test]
fn a_signed_aave_withdrawal_or_transfer_counts_as_gone_while_the_chain_has_not_used_its_nonce() {
    let quiet = book::build(&aave_with_actions(json!([]), json!([]))).unwrap();
    let q = quiet.lenders.get("aave").unwrap().clone();
    let wbtc = |raw| Holding { engine: "WBTC".into(), id: WBTC.into(), decimals: 8, raw };
    assert_eq!((q.posted.clone(), q.spare.clone()), (vec![wbtc(131_000_000)], vec![wbtc(20_000_000)]));
    assert_eq!((q.posted_micro, q.spare_micro, q.leaving_micro), (96_676_550_615, 14_759_778_719, 0));
    // Aave's `withdraw` of 0.31 WBTC, signed with nonce 170 and listed: collateral gone from Aave's cushion. It is
    // on its way to the account's own address, so the book holds what it held.
    let listed = json!([aave_entry("withdraw", WBTC, 31_000_000, 170)]);
    let signed = json!([signed_tx(170, "withdraw", WBTC, 31_000_000)]);
    let b = book::build(&aave_with_actions(listed.clone(), signed.clone())).unwrap();
    let p = b.lenders.get("aave").unwrap();
    assert_eq!((p.leaving_micro, p.posted_micro), (22_877_657_015, 96_676_550_615 - 22_877_657_015));
    assert_eq!((p.spare.clone(), p.spare_micro, p.hf_bp), (q.spare.clone(), q.spare_micro, q.hf_bp));
    assert_eq!(b.account.near.get_or("WBTC", 0.0), 1.51);
    // Signed and not listed counts the same.
    let unlisted = book::build(&aave_with_actions(json!([]), signed)).unwrap();
    assert_eq!(unlisted.lenders.get("aave").unwrap().leaving_micro, 22_877_657_015);
    // A `transfer` of 0.05 WBTC away from the address (the owner's `evm_withdraw`): it leaves the book. What is
    // posted at Aave is untouched. The account lists it in `pending`, always, and shows it among the newest 20
    // it signed. Either place is enough by itself, and both together are one transfer, not two.
    let moved = json!([signed_tx(171, "transfer", WBTC, 5_000_000)]);
    let listed_move = json!([aave_entry("transfer", WBTC, 5_000_000, 171)]);
    for (pending, signed) in [
        (listed_move.clone(), json!([])),
        (json!([]), moved.clone()),
        (listed_move.clone(), moved.clone()),
    ] {
        let b = book::build(&aave_with_actions(pending, signed)).unwrap();
        let p = b.lenders.get("aave").unwrap();
        assert_eq!((p.spare.clone(), p.leaving_micro, p.posted_micro), (vec![wbtc(15_000_000)], 0, q.posted_micro));
        assert_eq!(b.account.near.get_or("WBTC", 0.0), 1.46);
        assert_eq!(b.lenders.locked["WBTC"], 146_000_000);
    }
    // The listing has pushed out of the newest 20 signed (here by 20 approvals): it still counts, once.
    let crowd: Vec<Value> = (172..192).map(|n| signed_tx(n, "approve", WBTC, 1)).collect();
    let b = book::build(&aave_with_actions(listed_move, Value::Array(crowd))).unwrap();
    assert_eq!(b.lenders.get("aave").unwrap().spare, vec![wbtc(15_000_000)]);
    // A `transfer` of USDC: the cash at the address counts without it, and never under nothing. Listed or signed.
    let cash = |units: u128, listed: bool| {
        let (pending, signed) = if listed {
            (json!([aave_entry("transfer", USDC, units, 172)]), json!([]))
        } else {
            (json!([]), json!([signed_tx(172, "transfer", USDC, units)]))
        };
        let b = book::build(&aave_with_actions(pending, signed)).unwrap();
        (b.lenders.get("aave").unwrap().cash_micro, b.account.near.get_or("USDC", 0.0))
    };
    let usdc_before = quiet.account.near.get_or("USDC", 0.0);
    for listed in [true, false] {
        assert_eq!(cash(400_000, listed), (600_000, usdc_before - 0.4));
        assert_eq!(cash(5_000_000, listed), (0, usdc_before - 1.0));
    }
    // A listed transfer the chain has used counts for nothing.
    let b = book::build(&aave_with_actions(json!([aave_entry("transfer", WBTC, 5_000_000, 168)]), json!([]))).unwrap();
    assert_eq!(b.lenders, quiet.lenders);
    // A listed withdrawal the state no longer shows among what it signed is Aave's `withdraw`, as its kind says:
    // gone from Aave's cushion, and still the account's.
    let b = book::build(&aave_with_actions(listed, json!([]))).unwrap();
    let p = b.lenders.get("aave").unwrap();
    assert_eq!((p.leaving_micro, p.spare.clone()), (22_877_657_015, q.spare.clone()));
    assert_eq!(b.account.near.get_or("WBTC", 0.0), 1.51);
    // Once the chain's count has passed the nonce, nothing of it counts.
    let old = json!([aave_entry("withdraw", WBTC, 31_000_000, 168)]);
    let b = book::build(&aave_with_actions(old, json!([signed_tx(168, "transfer", WBTC, 31_000_000)]))).unwrap();
    assert_eq!(b.lenders, quiet.lenders);
}

const WETH: &str = "0x4200000000000000000000000000000000000006";

#[test]
fn aaves_supply_caps_decide_what_can_be_posted_and_wrapped_ether_is_the_engines_eth() {
    // Base Sepolia on 11 Nov (`aave_caps`): WBTC's cap is 175 and exactly 175 are supplied, so the pool is full.
    // Wrapped ether's cap is 2,500 with 1,735.93 supplied: room for 764.07 more.
    let caps = aave_record("aave_caps");
    let hex = |call: &str| recorded_hex(&caps, call);
    let room = |t: &str, decimals| {
        evm::supply_room(&hex(&format!("getReserveCaps_{t}")), &hex(&format!("getATokenTotalSupply_{t}")), decimals)
    };
    assert_eq!(room("wbtc", 8), Ok(Some(0)));
    assert_eq!(room("weth", 18), Ok(Some(764_071_166_804_090_397_926)));
    // No cap at all is written as 0.
    assert_eq!(evm::supply_room(&format!("0x{}{}", word(0), word(0)), &format!("0x{}", word(5)), 8), Ok(None));
    let c = evm::reserve_config(&hex("getReserveConfigurationData_weth")).unwrap();
    assert_eq!((c.decimals, c.ltv_bp, c.liq_threshold_bp), (18, 8_350, 8_500));

    // Testnet's config lists both tokens (INTERFACES.md 33). Wrapped ether is the engine's ETH token.
    let mut settings = lender_settings(false, true);
    settings["aave"]["collateral"]
        .as_array_mut()
        .unwrap()
        .push(json!({"symbol": "WETH", "address": "0x4200000000000000000000000000000000000006", "decimals": 18}));
    let conf = near::config(&json!({"pool_id": "pool.pbf.testnet", "lenders": settings, "tokens": [
        {"id": MUSDC, "symbol": "USDC", "decimals": 6}, {"id": MNBTC, "symbol": "nBTC", "decimals": 8}]}))
    .unwrap();
    let aave = conf.lenders.aave.as_ref().unwrap();
    let engines: Vec<&str> = aave.collateral.iter().map(|t| t.engine).collect();
    assert_eq!(engines, ["WBTC", "ETH.b"]);
    // 18 calls for the two tokens, the market's and the address's.
    assert_eq!(read::aave_asks(aave, evm::chain(84532).unwrap(), Some("0xaa")).len(), 18);

    // The address after the live round trip's borrow (`research/data/aave_spike_weth.json`): 0.01 WETH posted,
    // counted by Aave as $20.77, 10 USDC owed, a health factor of 1.7656. It also holds 0.005 WETH and 0.01 WBTC.
    let mut reads = aave_reads("aave_empty", Some("0xaa"));
    for (key, call) in [("caps", "getReserveCaps"), ("supplied", "getATokenTotalSupply"),
        ("config", "getReserveConfigurationData"), ("price", "getAssetPrice")] {
        reads.calls.insert(format!("{key}:{WETH}"), hex(&format!("{call}_weth")));
        reads.calls.insert(format!("{key}:{WBTC}"), hex(&format!("{call}_wbtc")));
    }
    let reserve = |posted: u128| format!("0x{}{}{}", word(posted), word(0).repeat(7), word(1));
    reads.calls.insert(format!("posted:{WETH}"), reserve(10_000_000_000_000_000));
    reads.calls.insert(format!("balance:{WETH}"), format!("0x{}", word(5_000_000_000_000_000)));
    reads.calls.insert(format!("balance:{WBTC}"), format!("0x{}", word(1_000_000)));
    reads.calls.insert(
        "account".into(),
        format!("0x{}", [2_076_633_672u128, 999_714_730, 734_274_386, 8_500, 8_350, 1_765_642_305_980_627_200]
            .map(word)
            .concat()),
    );
    reads.calls.insert("debt".into(), format!("0x{}{}{}", word(0).repeat(2), word(10_000_000), word(0).repeat(6)));
    let who = client(json!({"counter": 1, "permission": permission()}));
    let (read, _) = lenders::aave_position(&reads, aave, &who, 100).unwrap();
    let weth = |raw| Holding { engine: "ETH.b".into(), id: WETH.into(), decimals: 18, raw };
    assert_eq!(read.pos.posted, vec![weth(10_000_000_000_000_000)]);
    // The spare ether can be posted. The WBTC can't: its pool is full, so it is held and not spare.
    assert_eq!(read.pos.spare, vec![weth(5_000_000_000_000_000)]);
    assert_eq!(read.pos.stuck, vec![Holding { engine: "WBTC".into(), id: WBTC.into(), decimals: 8, raw: 1_000_000 }]);
    assert_eq!(read.pos.full, ["WBTC"]);
    let pos = read.priced(&|_| 0.0);
    // At Aave's price of $2,073.06 a wrapped ether: $20.73 posted and $10.37 spare. Its own figures stand.
    assert_eq!((pos.posted_micro, pos.spare_micro), (20_730_595, 10_365_297));
    assert_eq!((pos.debt_micro, pos.hf_bp, pos.liq_bp), (10_000_000, Some(17_656), 8_500));

    // Which coins count as held follows what is really there, once Aave has been read: with nothing of ours in
    // the saved run, bitcoin for the WBTC and ether for the WETH.
    let mut inp = with_lenders("fresh", false, true);
    inp.near.config["lenders"] = settings;
    inp.near.state["hl"]["address"] = json!("0x00000000000000000000000000000000000000aa");
    let held = |inp: &Inputs| book::held_coins(inp).unwrap().into_iter().collect::<Vec<_>>();
    assert_eq!(held(&inp), ["BTC", "ETH"], "before Aave is read, every coin its collateral wraps is priced");
    inp.lenders.aave = Some(reads.clone());
    assert_eq!(held(&inp), ["BTC", "ETH"]);
    // An account with no wrapped ether isn't tied to ether's price.
    let mut none = reads.clone();
    none.calls.insert(format!("posted:{WETH}"), reserve(0));
    none.calls.insert(format!("balance:{WETH}"), format!("0x{}", word(0)));
    inp.lenders.aave = Some(none);
    assert_eq!(held(&inp), ["BTC"]);
    // Two tokens the engine would call by one name are refused.
    let mut twice = lender_settings(false, true);
    twice["aave"]["collateral"].as_array_mut().unwrap().push(
        json!({"symbol": "WBTC", "address": "0x4200000000000000000000000000000000000006", "decimals": 8}));
    assert!(near::config(&json!({"pool_id": "p", "tokens": [], "lenders": twice})).unwrap_err().contains("listed twice"));
}

// ------------------------------------------------------------- the moves to Aave's chain and back (stage 4)

/// One hour after the saved runs' block, and one hour before it, in ns: a deadline still ahead, and one passed.
const AHEAD_NS: u64 = 1_794_049_228_500_000_000 + 3_600_000_000_000;
const PASSED_NS: u64 = 1_794_049_228_500_000_000 - 3_600_000_000_000;

/// A pending 1Click transfer as `get_state().pending` lists it (INTERFACES.md 14 and 36).
fn move_entry(id: &str, kind: &str, token: &str, amount: u128, deadline_ns: u64) -> Value {
    let dep = if kind == "e_home" { "0x2031181d63507368232579af4c64a1c3428407ff" } else { "f00d" };
    json!({"transfer": {"id": id, "kind": kind, "token": token, "amount": amount.to_string(), "dep": dep,
                        "deadline": deadline_ns.to_string()}})
}

/// The "hedged" run as an account with Aave alone, whose Ethereum address has `posted` satoshis of WBTC at Aave,
/// `wallet` satoshis of WBTC and `usdc` micro-USDC in the wallet, the chain's count at `chain_nonce`, and
/// `pending` in its state.
fn at_address(posted: u128, wallet: u128, usdc: u128, chain_nonce: u64, pending: Value) -> Inputs {
    let mut inp = aave_with_actions(pending, json!([]));
    let calls = &mut inp.lenders.aave.as_mut().unwrap().calls;
    calls.insert(format!("posted:{WBTC}"), format!("0x{}{}{}", word(posted), word(0).repeat(7), word(u128::from(posted > 0))));
    calls.insert(format!("balance:{WBTC}"), format!("0x{}", word(wallet)));
    calls.insert(format!("balance:{USDC}"), format!("0x{}", word(usdc)));
    calls.insert("nonce".into(), format!("0x{chain_nonce:x}"));
    inp
}

fn flights(b: &Book) -> Vec<(String, f64, bool)> {
    b.account.inflight.iter().map(|f| (f.token.clone(), f.units, f.overdue)).collect()
}

#[test]
fn a_move_to_aaves_chain_is_arrived_when_the_address_holds_most_of_its_value() {
    // Half a bitcoin of nBTC sent to the account's own address on Base Sepolia: the owner's own move (`move:5`),
    // or a plan step's transfer (the funding plan's `to_evm` step, when it is built).
    let half = |id: &str, deadline| json!([move_entry(id, "to_evm", MNBTC, 50_000_000, deadline)]);
    for (id, counts) in [("move:5", false), ("f276621922:0", true)] {
        // Nothing is there yet. A plan step's transfer counts in transit as the token sent, and isn't money on
        // its way to Hyperliquid. The owner's own move counts nothing while it is pending (INTERFACES.md 40.3).
        let in_flight = |overdue: bool| if counts { vec![("nBTC".to_string(), 0.5, overdue)] } else { vec![] };
        let b = book::build(&at_address(0, 0, 0, 169, half(id, AHEAD_NS))).unwrap();
        assert_eq!(flights(&b), in_flight(false), "{id}");
        assert!(b.account.inflight.iter().all(|f| !f.to_hl));
        assert!(b.arrived.is_empty() && b.overdue.is_empty());
        // Arrived: the address holds at least 80% of the dollar value sent, at the engine's prices. 0.39 WBTC is
        // 78%: not yet. 0.40 is 80%: arrived, and not in transit. The WBTC counts where it is, at the address.
        let b = book::build(&at_address(0, 39_000_000, 0, 169, half(id, AHEAD_NS))).unwrap();
        assert_eq!((b.arrived.len(), flights(&b)), (0, in_flight(false)), "{id}");
        let b = book::build(&at_address(0, 40_000_000, 0, 169, half(id, AHEAD_NS))).unwrap();
        assert_eq!((b.arrived.clone(), flights(&b).len()), (vec![id.to_string()], 0));
        assert_eq!(b.account.near.get_or("WBTC", 0.0), 0.4);
        // Collateral posted at Aave counts as much as collateral in the wallet: the client may have posted it.
        let b = book::build(&at_address(45_000_000, 0, 0, 169, half(id, AHEAD_NS))).unwrap();
        assert_eq!(b.arrived, [id]);
        // USDC in the wallet doesn't answer for bitcoin.
        let b = book::build(&at_address(0, 0, 60_000_000_000, 169, half(id, AHEAD_NS))).unwrap();
        assert!(b.arrived.is_empty());
        // Past its deadline and not there: it counts for nothing and is listed as overdue. Past its deadline and
        // there: arrived all the same.
        let b = book::build(&at_address(0, 0, 0, 169, half(id, PASSED_NS))).unwrap();
        assert_eq!(flights(&b), in_flight(true), "{id}");
        assert_eq!(b.overdue.iter().map(|t| (t.id.as_str(), t.kind.as_str())).collect::<Vec<_>>(), [(id, "to_evm")]);
        let b = book::build(&at_address(0, 50_000_000, 0, 169, half(id, PASSED_NS))).unwrap();
        assert_eq!((b.arrived.clone(), b.overdue.len(), flights(&b).len()), (vec![id.to_string()], 0, 0));
    }
}

#[test]
fn each_dollar_at_the_address_answers_for_one_transfer_the_earliest_deadline_first() {
    // Two transfers of half a bitcoin each, here a plan's, so that what is still in transit shows. 0.6 WBTC is at
    // the address: enough for one.
    let two = |first: u64, second: u64| {
        json!([move_entry("f9:5", "to_evm", MNBTC, 50_000_000, first),
               move_entry("f9:6", "to_evm", MNBTC, 50_000_000, second)])
    };
    let b = book::build(&at_address(0, 60_000_000, 0, 169, two(AHEAD_NS, AHEAD_NS + 1))).unwrap();
    assert_eq!(b.arrived, ["f9:5"]);
    assert_eq!(flights(&b), [("nBTC".to_string(), 0.5, false)]);
    // The one whose deadline comes first is the one settled.
    let b = book::build(&at_address(0, 60_000_000, 0, 169, two(AHEAD_NS + 1, AHEAD_NS))).unwrap();
    assert_eq!(b.arrived, ["f9:6"]);
    // 0.9 WBTC answers for both: half a bitcoin for the first, and 0.4, which is 80%, for the second.
    let b = book::build(&at_address(30_000_000, 60_000_000, 0, 169, two(AHEAD_NS, AHEAD_NS + 1))).unwrap();
    assert_eq!((b.arrived.clone(), flights(&b).len()), (vec!["f9:5".to_string(), "f9:6".to_string()], 0));
    // A USDC move counts the USDC in the wallet, and only that: $500 sent, $1 there, with bitcoin beside it.
    let usdc = json!([move_entry("f9:7", "to_evm", MUSDC, 500_000_000, AHEAD_NS)]);
    let b = book::build(&at_address(0, 60_000_000, 1_000_000, 169, usdc.clone())).unwrap();
    assert_eq!((b.arrived.len(), flights(&b)), (0, vec![("USDC".to_string(), 500.0, false)]));
    let b = book::build(&at_address(0, 0, 400_000_000, 169, usdc.clone())).unwrap();
    assert_eq!(b.arrived, ["f9:7"]);
    // Bitcoin and USDC on their way together: each is settled by its own kind.
    let both = json!([move_entry("f9:5", "to_evm", MNBTC, 50_000_000, AHEAD_NS),
                      move_entry("f9:7", "to_evm", MUSDC, 500_000_000, AHEAD_NS)]);
    let b = book::build(&at_address(0, 0, 400_000_000, 169, both)).unwrap();
    assert_eq!((b.arrived.clone(), flights(&b)), (vec!["f9:7".to_string()], vec![("nBTC".to_string(), 0.5, false)]));
    // The owner's own moves are settled by the same rule, and none of them is in transit meanwhile.
    let own = json!([move_entry("move:5", "to_evm", MNBTC, 50_000_000, AHEAD_NS),
                     move_entry("move:6", "to_evm", MNBTC, 50_000_000, AHEAD_NS + 1)]);
    let b = book::build(&at_address(0, 60_000_000, 0, 169, own)).unwrap();
    assert_eq!((b.arrived.clone(), flights(&b).len()), (vec!["move:5".to_string()], 0));
    // An account whose config names no Aave has no address to look at: nothing arrives.
    let mut bare = with_lenders("hedged", false, false);
    bare.near.state["pending"] = usdc;
    let b = book::build(&bare).unwrap();
    assert_eq!((b.arrived.len(), flights(&b).len()), (0, 1));
}

#[test]
fn a_move_home_from_aaves_chain_counts_the_same_money_once_at_each_moment() {
    // $600 of USDC and 0.2 WBTC are at the address. The owner sends $500 of the USDC home: `evm_withdraw` with a
    // quote's expiry. The account lists the signed transfer (nonce 169) and the 1Click transfer `move:7`.
    let listed = json!({"lender": {"lender": "aave", "kind": "transfer", "amount": "500000000", "token": USDC,
                                   "evm_nonce": 169}});
    let going = move_entry("move:7", "e_home", "USDC", 500_000_000, AHEAD_NS);
    let usdc_of = |b: &Book| (b.lenders.get("aave").unwrap().cash_micro, b.account.near.get_or("USDC", 0.0), flights(b));
    // It is the owner's own move, so it counts nothing while it travels (INTERFACES.md 40.3): $100 at the address,
    // and nothing in transit.
    let in_transit = (100_000_000, 100.0, vec![]);
    // 1. Signed and not mined (the chain's count is 169, the wallet still shows $600): the listed transfer takes
    //    the $500 off the address.
    let signed = book::build(&at_address(0, 20_000_000, 600_000_000, 169, json!([listed.clone(), going.clone()]))).unwrap();
    assert_eq!(usdc_of(&signed), in_transit);
    // 2. Mined and not delivered (the count is 170, the wallet shows $100): the listed transfer counts for nothing
    //    now, and the chain's own reading has the $500 gone. The book is the same.
    let mined = book::build(&at_address(0, 20_000_000, 100_000_000, 170, json!([listed.clone(), going.clone()]))).unwrap();
    assert_eq!(usdc_of(&mined), in_transit);
    assert_eq!(mined.account.debt, signed.account.debt);
    // 3. Delivered: the USDC came to the account on NEAR with the transfer's msg, which settled it there. Nothing
    //    is in transit, and no `arrived` is needed from the engine at any of the three moments.
    let mut home = at_address(0, 20_000_000, 100_000_000, 170, json!([listed.clone()]));
    home.near.balances.insert(MUSDC.into(), json!("499000000"));
    let delivered = book::build(&home).unwrap();
    assert_eq!(usdc_of(&delivered), (100_000_000, 599.0, vec![]));
    assert!(signed.arrived.is_empty() && mined.arrived.is_empty() && delivered.arrived.is_empty());
    // A plan step's transfer of the same kind (the funding plan's `e_home` step, when it is built) does count in
    // transit: USDC as USDC, and collateral as its coin: 0.1 WBTC, as bitcoin.
    let planned = json!([listed.clone(), move_entry("f9:7", "e_home", "USDC", 500_000_000, AHEAD_NS)]);
    let b = book::build(&at_address(0, 20_000_000, 600_000_000, 169, planned)).unwrap();
    assert_eq!(usdc_of(&b), (100_000_000, 100.0, vec![("USDC".to_string(), 500.0, false)]));
    let wbtc_home = json!([move_entry("f9:8", "e_home", WBTC, 10_000_000, AHEAD_NS)]);
    let b = book::build(&at_address(0, 10_000_000, 0, 170, wbtc_home)).unwrap();
    assert_eq!(flights(&b), [("WBTC".to_string(), 0.1, false)]);
    assert_eq!(b.account.near.get_or("WBTC", 0.0), 0.1);
    // Past its deadline it counts for nothing, and is listed as overdue under its kind.
    let late = json!([move_entry("move:7", "e_home", "USDC", 500_000_000, PASSED_NS)]);
    let b = book::build(&at_address(0, 0, 0, 170, late)).unwrap();
    assert_eq!((flights(&b), b.overdue[0].kind.as_str()), (vec![], "e_home"));
    // A token the account's Aave settings don't list is refused in words, with or without settings.
    let odd = json!([move_entry("move:9", "e_home", "0x00000000000000000000000000000000000000ff", 5, AHEAD_NS)]);
    let e = book::build(&at_address(0, 0, 0, 170, odd.clone())).err().unwrap();
    assert_eq!(e, "pending transfer move:9 is of 0x00000000000000000000000000000000000000ff, a token the account's Aave settings don't list");
    let mut bare = with_lenders("hedged", false, false);
    bare.near.state["pending"] = odd;
    assert!(book::build(&bare).err().unwrap().contains("Aave settings don't list"));
    // And a `to_evm` of a NEAR token the account isn't configured for, as for any other transfer.
    let stray = json!([move_entry("move:9", "to_evm", "wbtc.fakes.testnet", 5, AHEAD_NS)]);
    let e = book::build(&at_address(0, 0, 0, 170, stray)).err().unwrap();
    assert!(e.contains("a token the account isn't configured for"), "{e}");
}

#[test]
fn a_lender_in_the_config_that_was_not_read_stops_the_book() {
    let inp = with_lenders("loan", true, false);
    assert!(book::build(&inp).err().unwrap().contains("Rhea wasn't read"));
    let inp = with_lenders("hedged", false, true);
    assert!(book::build(&inp).err().unwrap().contains("Aave wasn't read"));
    // A config with lenders but no permission still reads: the position is there, just not permitted.
    let mut inp = with_lenders("loan", true, false);
    inp.near.state.as_object_mut().unwrap().remove("permission");
    inp.lenders.rhea = Some(rhea_reads("rhea_get_account", true));
    let b = book::build(&inp).unwrap();
    assert!(!b.lenders.get("rhea").unwrap().permitted);
    assert_eq!((b.lenders.min_hf_bp, b.lenders.max_rate_bp), (None, None));
}

#[test]
fn the_book_stress_test_carries_each_accounts_lender_reads() {
    use pb_read::stress::{AccountReads, BookInputs};
    let mut bi = BookInputs::default();
    bi.accounts.push(AccountReads { account: "alice.pbf.testnet".into(), ..AccountReads::default() });
    // Nothing read for an account with no lender: the canonical form has no such field, as before Phase 6.
    assert!(!bi.canonical().contains("lenders"));
    assert!(bi.inputs_for(0).lenders.is_empty());
    bi.accounts[0].lenders.rhea = Some(rhea_reads("rhea_get_account", true));
    assert_eq!(bi.inputs_for(0).lenders.rhea, bi.accounts[0].lenders.rhea);
    let back: BookInputs = serde_json::from_str(&bi.canonical()).unwrap();
    assert_eq!(back, bi);
}

// ------------------------------------------------------------------------------------------------ the reads

/// The pretend Base Sepolia's latest block.
const EVM_BLOCK: u64 = 57_472_001;

/// How the pretend RPC treats a JSON-RPC batch.
#[derive(Clone, Copy, PartialEq)]
enum Batches {
    Answered,
    Refused,
    OneShort,
    OneFailed,
}

/// A pretend network built from a saved run: its NEAR views, its Hyperliquid account, Rhea's recorded views and
/// Base Sepolia's recorded answers. The exchanges are down, which a run survives.
struct Canned {
    base: Inputs,
    rhea: Option<RheaReads>,
    /// Base Sepolia's answer to each call, by its method and what it asks (`eth_call {"data":…,"to":…}`), at any
    /// block.
    aave: BTreeMap<String, String>,
    /// How many Ethereum requests the RPC refuses (HTTP 429) before it answers, and whether Rhea's contract is
    /// missing.
    evm_failures: u32,
    rhea_missing: bool,
    /// How the RPC answers a batch: in full, with a refusal (an endpoint that takes no batches), or with its
    /// first answer left out.
    batches: Batches,
    /// The block parameter of every Ethereum call asked.
    blocks: Vec<String>,
    /// Every request: `near <account>.<method>`, `hl <type>`, `evm <method>`, `get <url>`.
    log: Vec<String>,
}

impl Canned {
    fn new(base: Inputs, rhea: Option<RheaReads>, aave: Option<(&AaveReads, &near::Config)>) -> Canned {
        let mut answers = BTreeMap::new();
        if let Some((reads, conf)) = aave {
            let asks = read::aave_asks(
                conf.lenders.aave.as_ref().unwrap(),
                evm::chain(84532).unwrap(),
                reads.address.as_deref(),
            );
            for (name, body) in asks {
                answers.insert(Self::asked(&serde_json::from_str(&body).unwrap()), reads.calls[&name].clone());
            }
        }
        Canned {
            base,
            rhea,
            aave: answers,
            evm_failures: 0,
            rhea_missing: false,
            batches: Batches::Answered,
            blocks: Vec::new(),
            log: Vec::new(),
        }
    }

    /// What one Ethereum request asks, whatever its id and its block.
    fn asked(request: &Value) -> String {
        format!("{} {}", request["method"].as_str().unwrap(), request["params"][0])
    }

    /// Base Sepolia's answer to one request, alone or in a batch. Its latest block is [`EVM_BLOCK`].
    fn evm(&mut self, request: &Value) -> Value {
        let id = request["id"].clone();
        if request["method"] == "eth_blockNumber" {
            return json!({"jsonrpc": "2.0", "id": id, "result": format!("0x{EVM_BLOCK:x}")});
        }
        self.blocks.push(request["params"][1].as_str().unwrap().to_string());
        match self.aave.get(&Self::asked(request)) {
            Some(hex) => json!({"jsonrpc": "2.0", "id": id, "result": hex}),
            None => json!({"jsonrpc": "2.0", "id": id, "error": {"code": 3, "message": "execution reverted"}}),
        }
    }

    fn ok(v: Value) -> Result<Reply, String> {
        Ok(Reply { status: 200, body: v.to_string().into_bytes() })
    }

    fn near(&mut self, body: &Value) -> Result<Reply, String> {
        if body["method"] == "block" {
            self.log.push("near block".into());
            return Self::ok(json!({"result": {"header": {"height": self.base.block.height,
                "timestamp_nanosec": self.base.block.timestamp_ns, "hash": self.base.block.hash}}}));
        }
        let account = body["params"]["account_id"].as_str().unwrap().to_string();
        let method = body["params"]["method_name"].as_str().unwrap().to_string();
        self.log.push(format!("near {account}.{method}"));
        let n = &self.base.near;
        let token_arg = |rhea: &RheaReads| -> Option<Value> {
            // get_token_pyth_info: answer for the token whose id is in the base64 arguments.
            let raw = body["params"]["args_base64"].as_str()?;
            rhea.prices
                .iter()
                .find(|(id, _)| raw == pb_read::util::base64(json!({ "token_id": id }).to_string().as_bytes()))
                .map(|(_, v)| v.clone())
        };
        let value = match (account.as_str(), method.as_str()) {
            (_, "get_pool") => n.pool.clone(),
            (_, "get_params") => n.params.clone(),
            (_, "coin_statuses") => n.coin_statuses.clone(),
            (_, "get_ratio_for") => n.drill.clone(),
            (_, "get_state") => n.state.clone(),
            (_, "get_config") => n.config.clone(),
            (token, "ft_balance_of") => n.balances[token].clone(),
            (_, "get_borrower") => n.borrower.clone(),
            (RHEA_ID, m) if !self.rhea_missing => {
                let rhea = self.rhea.as_ref().expect("Rhea is only read when the config names it");
                match m {
                    "get_account" => rhea.account.clone(),
                    "get_assets" => rhea.assets.clone(),
                    "get_token_pyth_info" => token_arg(rhea).expect("a known token"),
                    other => panic!("unexpected Rhea view {other}"),
                }
            }
            _ => {
                return Self::ok(json!({"error": {"name": "HANDLER_ERROR", "cause": {"name": "UNKNOWN_ACCOUNT"},
                    "data": "account does not exist while viewing"}}))
            }
        };
        let bytes: Vec<u8> = value.to_string().into_bytes();
        Self::ok(json!({"result": {"result": bytes, "logs": []}}))
    }
}

impl Net for Canned {
    fn get(&mut self, url: &str) -> Result<Reply, String> {
        self.log.push(format!("get {}", url.split('?').next().unwrap_or(url)));
        Err("the exchange is down".into())
    }

    fn post(&mut self, url: &str, body: &str) -> Result<Reply, String> {
        let v: Value = serde_json::from_str(body).unwrap();
        let net = self.base.request.net();
        if url == net.near_rpc {
            return self.near(&v);
        }
        if url == net.hl_info {
            let kind = v["type"].as_str().unwrap().to_string();
            self.log.push(format!("hl {kind}"));
            let h = &self.base.hl;
            return match kind.as_str() {
                "clearinghouseState" => Self::ok(h.state.clone()),
                "frontendOpenOrders" => Self::ok(h.orders.clone()),
                "userAbstraction" => Self::ok(h.abstraction.clone()),
                "spotClearinghouseState" => Self::ok(h.spot.clone()),
                _ => Ok(Reply { status: 500, body: Vec::new() }),
            };
        }
        assert_eq!(url, "https://sepolia.base.org", "an unexpected request to {url}");
        let batch = v.as_array().cloned();
        self.log.push(match &batch {
            Some(list) => format!("evm batch of {}", list.len()),
            None => format!("evm {}", v["method"].as_str().unwrap()),
        });
        if self.evm_failures > 0 {
            self.evm_failures -= 1;
            return Ok(Reply { status: 429, body: b"rate limited".to_vec() });
        }
        let Some(list) = batch else {
            let answer = self.evm(&v);
            return Self::ok(answer);
        };
        let mut answers: Vec<Value> = list.iter().map(|request| self.evm(request)).collect();
        match self.batches {
            Batches::Answered => {
                // A node may answer a batch in any order.
                answers.reverse();
                Self::ok(Value::Array(answers))
            }
            Batches::Refused => Self::ok(
                json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32600, "message": "batch requests are not supported"}}),
            ),
            Batches::OneShort => Self::ok(Value::Array(answers.split_off(1))),
            Batches::OneFailed => {
                answers[0] = json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -32005, "message": "rate limit exceeded"}});
                Self::ok(Value::Array(answers))
            }
        }
    }

    fn now_ms(&mut self) -> u64 {
        self.base.now_ms
    }
}

#[test]
fn the_reads_record_each_lenders_answers_and_only_for_an_account_that_names_it() {
    // No lenders in the config: the same NEAR and Hyperliquid reads as before, nothing asked of Rhea or Ethereum.
    let base = saved("hedged");
    let mut net = Canned::new(base.clone(), None, None);
    let inp = read::read_all(&mut net, &base.request);
    assert_eq!(inp.fatal, None);
    assert_eq!((&inp.near, &inp.block), (&base.near, &base.block));
    assert!(inp.lenders.is_empty() && !inp.canonical().contains("lenders"));
    assert!(!net.log.iter().any(|l| l.starts_with("evm") || l.contains(RHEA_ID)), "{:?}", net.log);
    let before: Vec<String> = net.log.iter().filter(|l| l.starts_with("near") || l.starts_with("hl")).cloned().collect();

    // Both lenders: Rhea's three views at the run's block, then, after everything else, Aave's calls together.
    let with = with_lenders("hedged", true, true);
    let conf = near::config(&with.near.config).unwrap();
    let address = with.hl.address.clone().unwrap();
    let (rhea, aave) = (rhea_reads("rhea_get_account", true), aave_with_wbtc(&address));
    let mut net = Canned::new(with.clone(), Some(rhea.clone()), Some((&aave, &conf)));
    let inp = read::read_all(&mut net, &with.request);
    assert_eq!(inp.fatal, None);
    assert_eq!(inp.lenders.rhea.as_ref(), Some(&rhea));
    // Aave's answers are the recorded ones, all read at the chain's one block, which the inputs keep.
    let pinned = AaveReads { block: Some(EVM_BLOCK), ..aave.clone() };
    assert_eq!(inp.lenders.aave.as_ref(), Some(&pinned));
    let rhea_calls: Vec<&str> = net.log.iter().filter(|l| l.contains(RHEA_ID)).map(String::as_str).collect();
    assert_eq!(
        rhea_calls,
        [
            "near rhea.pbf-ops.testnet.get_account",
            "near rhea.pbf-ops.testnet.get_assets",
            "near rhea.pbf-ops.testnet.get_token_pyth_info",
            "near rhea.pbf-ops.testnet.get_token_pyth_info"
        ]
    );
    // Two requests to Base Sepolia, the last thing the run reads: the block number, then one batch of the 12
    // calls, each pinned to that block.
    assert_eq!(net.log[net.log.len() - 2..], ["evm eth_blockNumber", "evm batch of 12"], "Aave is read last");
    assert_eq!(net.log.iter().filter(|l| l.starts_with("evm")).count(), 2);
    assert_eq!(net.blocks, vec![format!("0x{EVM_BLOCK:x}"); 12]);
    let others: Vec<String> = net
        .log
        .iter()
        .filter(|l| (l.starts_with("near") || l.starts_with("hl")) && !l.contains(RHEA_ID))
        .cloned()
        .collect();
    assert_eq!(others, before, "the other reads are the same");
    // The inputs replay: the canonical form survives a round trip, and the lender reads are in it.
    let text = inp.canonical();
    let back: Inputs = serde_json::from_str(&text).unwrap();
    assert_eq!((back.canonical(), back.lenders.is_empty()), (text, false));
}

#[test]
fn a_lender_that_cannot_be_read_is_fatal_and_a_rate_limited_call_is_tried_again() {
    let with = with_lenders("hedged", true, true);
    let conf = near::config(&with.near.config).unwrap();
    let address = with.hl.address.clone().unwrap();
    let (rhea, aave) = (rhea_reads("rhea_get_account", true), aave_with_wbtc(&address));
    let evm_log = |net: &Canned| -> Vec<String> { net.log.iter().filter(|l| l.starts_with("evm")).cloned().collect() };
    let pinned = AaveReads { block: Some(EVM_BLOCK), ..aave.clone() };
    let tag = format!("0x{EVM_BLOCK:x}");
    // An endpoint that takes no batches answers one with a refusal, not a list: each call then goes as a request
    // of its own, still pinned to the block, and the read is whole.
    let mut net = Canned::new(with.clone(), Some(rhea.clone()), Some((&aave, &conf)));
    net.batches = Batches::Refused;
    let inp = read::read_all(&mut net, &with.request);
    assert_eq!((inp.fatal.clone(), inp.lenders.aave.as_ref()), (None, Some(&pinned)));
    let log = evm_log(&net);
    assert_eq!((log.len(), &log[..2]), (14, &["evm eth_blockNumber".to_string(), "evm batch of 12".to_string()][..]));
    assert!(log[2..].iter().all(|l| l == "evm eth_call" || l == "evm eth_getTransactionCount"), "{log:?}");
    assert!(net.blocks.iter().all(|b| *b == tag));
    // A list one answer short is no batch answer either.
    let mut net = Canned::new(with.clone(), Some(rhea.clone()), Some((&aave, &conf)));
    net.batches = Batches::OneShort;
    let inp = read::read_all(&mut net, &with.request);
    assert_eq!((inp.fatal.clone(), inp.lenders.aave.as_ref()), (None, Some(&pinned)));
    assert_eq!(evm_log(&net).len(), 14);
    // A whole list with one call refused in it: that call alone is asked again, at the same block.
    let mut net = Canned::new(with.clone(), Some(rhea.clone()), Some((&aave, &conf)));
    net.batches = Batches::OneFailed;
    let inp = read::read_all(&mut net, &with.request);
    assert_eq!((inp.fatal.clone(), inp.lenders.aave.as_ref()), (None, Some(&pinned)));
    assert_eq!(evm_log(&net), ["evm eth_blockNumber", "evm batch of 12", "evm eth_call"]);
    // The block number itself is refused once: asked again, then the batch as usual.
    let mut net = Canned::new(with.clone(), Some(rhea.clone()), Some((&aave, &conf)));
    net.evm_failures = 1;
    let inp = read::read_all(&mut net, &with.request);
    assert_eq!((inp.fatal.clone(), inp.lenders.aave.as_ref()), (None, Some(&pinned)));
    assert_eq!(evm_log(&net), ["evm eth_blockNumber", "evm eth_blockNumber", "evm batch of 12"]);
    // Refused twice: no block to pin to, so the calls go one by one at the latest block, as they did before, and
    // the inputs name no block. They are the inputs a run from before the batch saved.
    let mut net = Canned::new(with.clone(), Some(rhea.clone()), Some((&aave, &conf)));
    net.evm_failures = 2;
    let inp = read::read_all(&mut net, &with.request);
    assert_eq!(inp.fatal, None);
    assert_eq!(inp.lenders.aave.as_ref(), Some(&aave));
    assert_eq!(net.log.iter().filter(|l| l.starts_with("evm")).count(), 14);
    assert!(net.blocks.iter().all(|b| b == "latest"));
    assert!(!inp.canonical().contains("\"block\":5"));
    // Still failing on the second try: no verdict.
    let mut net = Canned::new(with.clone(), Some(rhea.clone()), Some((&aave, &conf)));
    net.evm_failures = 30;
    let inp = read::read_all(&mut net, &with.request);
    let fatal = inp.fatal.clone().unwrap();
    assert!(fatal.contains("cannot read the Aave position on chain 84532") && fatal.contains("HTTP 429"), "{fatal}");
    assert!(inp.lenders.aave.is_none());
    assert_eq!(book::build(&inp).err(), Some(fatal));
    // A call the chain refuses (here: an address the canned chain has no answer for) is fatal too.
    let mut other = aave.clone();
    other.address = Some("0x00000000000000000000000000000000000000bb".into());
    let mut net = Canned::new(with.clone(), Some(rhea.clone()), Some((&other, &conf)));
    let fatal = read::read_all(&mut net, &with.request).fatal.unwrap();
    assert!(fatal.contains("execution reverted"), "{fatal}");
    // Rhea's contract missing: fatal, before anything else is read.
    let mut net = Canned::new(with.clone(), Some(rhea), Some((&aave, &conf)));
    net.rhea_missing = true;
    let inp = read::read_all(&mut net, &with.request);
    let fatal = inp.fatal.unwrap();
    assert!(fatal.contains("cannot read the Rhea position") && fatal.contains(RHEA_ID), "{fatal}");
    assert!(!net.log.iter().any(|l| l.starts_with("hl") || l.starts_with("evm")));
    // A chain the program has no RPC for is refused by name.
    let mut odd = with.clone();
    odd.near.config["lenders"]["aave"]["chain_id"] = json!(1);
    let mut net = Canned::new(odd.clone(), Some(rhea_reads("rhea_get_account", true)), None);
    let fatal = read::read_all(&mut net, &odd.request).fatal.unwrap();
    assert!(fatal.contains("chain 1, which this program can't read"), "{fatal}");
}
