//! FUNDING.md 6, end to end: one run's inputs with a lender's recorded answers in them, through pb-read's book and
//! pb-risk's decision, to the verdict's bytes. pb-read's own tests check the book and `tests/lenders.rs` checks the
//! decision on a book built by hand; this checks that the two meet.
use pb_read::inputs::{Inputs, RheaReads};
use serde_json::{json, Value};

const MUSDC: &str = "musdc.pbf-ops.testnet";
const MNBTC: &str = "mnbtc.pbf-ops.testnet";
const RHEA_ID: &str = "rhea.pbf-ops.testnet";

fn file(path: &str) -> String {
    let full = format!("{}/{path}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&full).unwrap_or_else(|e| panic!("{full}: {e}"))
}

/// One of the saved runs: its inputs.
fn saved(name: &str) -> Inputs {
    let v: Value = serde_json::from_str(&file(&format!("tests/fixtures/{name}.json"))).unwrap();
    serde_json::from_value(v["inputs"].clone()).unwrap()
}

/// A Rhea view recorded on mainnet (pb-read's fixtures), with mainnet's token ids renamed to the test account's.
fn rhea_view(name: &str) -> Value {
    let text = file(&format!("../pb-read/tests/fixtures/mainnet/{name}.json"))
        .replace("nbtc.bridge.near", MNBTC)
        .replace("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", MUSDC);
    serde_json::from_str::<Value>(&text).unwrap()["value"].clone()
}

/// The recorded Rhea position, without its USDT loan (the engine refuses a lender debt that isn't USDC).
fn rhea_reads() -> RheaReads {
    let mut account = rhea_view("rhea_get_account");
    if let Some(b) = account.get_mut("borrowed").and_then(Value::as_array_mut) {
        b.retain(|e| e["token_id"] == MUSDC);
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

/// The saved run `name`, as an account whose config names Rhea, with the permission and the recorded position.
fn with_rhea(name: &str, intent: Value) -> Inputs {
    let mut inp = saved(name);
    inp.near.config["lenders"] = json!({"rhea": {"contract_id": RHEA_ID, "collateral": [MNBTC]}});
    inp.near.state["permission"] =
        json!({"lenders": ["aave", "rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any"});
    inp.lenders.rhea = Some(rhea_reads());
    inp.request.intent = serde_json::from_value(intent).unwrap();
    inp
}

fn verdict_of(inp: &Inputs) -> Value {
    serde_json::from_str(&pb_risk::output(inp)).unwrap()
}

#[test]
fn a_thin_cushion_read_from_rheas_own_answers_becomes_a_top_up_in_the_verdict() {
    // The recorded position: 0.00496276 nBTC posted ($377.17 at the run's BTC price) against $288.72 of USDC. Rhea
    // liquidates at 76% of the collateral, so the cushion is 377.17 x 0.76 / 288.72 = 0.99: under the act-now level.
    for name in ["loan", "hedged", "deposits"] {
        let v = verdict_of(&with_rhea(name, json!({"check": {}})));
        assert_eq!(
            v["ext"],
            json!([{"l": "rhea", "c": 377_169_735, "d": 288_717_955, "hf_bp": 9_928, "r_bp": 1_605, "s_bp": 1_042,
                    "room": 0, "liq_bp": 7_600}]),
            "{name}"
        );
        // The top-up is the plan's first step: $193 of the account's spare nBTC, which brings the cushion to 1.5.
        assert_eq!(v["action"], "REBALANCE_NOW", "{name}");
        assert_eq!(
            v["plan"][0],
            json!({"k": "l_add", "l": "rhea", "tok": MNBTC, "amt": "253528"}),
            "{name}"
        );
        let top = v["top"].as_array().unwrap();
        assert_eq!(
            top.last().unwrap(),
            "rhea: cushion 0.99 is under 1.20; adding $193 of collateral brings it back to 1.50",
            "{name}"
        );
        // Rhea's loan is part of the whole debt, so the line counts it.
        let plain = verdict_of(&saved(name));
        assert!(v["allow"]["borrow"].as_u64().unwrap() < plain["allow"]["borrow"].as_u64().unwrap(), "{name}");
        assert!(plain.get("ext").is_none() && plain.get("fund").is_none(), "{name}");
    }
}

#[test]
fn a_funding_request_becomes_steps_the_account_can_run() {
    // The same position with nothing borrowed: $377.17 posted, and 0.3 nBTC spare on NEAR.
    let mut inp = with_rhea("deposits", json!({"fund": {"amount": "5000000000"}}));
    inp.lenders.rhea.as_mut().unwrap().account["borrowed"] = json!([]);
    // Rhea at 16.05% is dearer than our pool, so by default our pool lends the whole $5,000.
    let v = verdict_of(&inp);
    assert_eq!(v["fund"], json!([{"k": "p_borrow", "amt": 5_000_000_000u64}]));
    assert_eq!(v["allow"]["fund"], 5_000_000_000u64);
    // Against what is posted now, Rhea could lend $191.10 at a cushion of 1.5: 377.17 x 0.76 / 1.5.
    assert_eq!(v["ext"][0]["room"], 191_099_332);
    assert_eq!((&v["ext"][0]["d"], &v["ext"][0]["hf_bp"]), (&json!(0), &json!(0)));
    // The operator puts lenders first (the pool's `funding.order`): Rhea lends it, after the account posts just
    // enough more nBTC, about $9,491 of it.
    inp.near.params["funding"] = json!({"order": "lender_first", "loan_days": 90});
    let v = verdict_of(&inp);
    assert_eq!(
        v["fund"],
        json!([{"k": "l_supply", "l": "rhea", "tok": MNBTC, "amt": "12488490"},
               {"k": "l_borrow", "l": "rhea", "amt": 5_000_000_000u64}])
    );
    assert_eq!(v["allow"]["fund"], 5_000_000_000u64);
    assert_eq!(v["action"], "NONE");
    assert_eq!(
        v["top"].as_array().unwrap().last().unwrap(),
        "funding: rhea lends $5,000 at 16.05% (the operator puts lenders first)"
    );
}
