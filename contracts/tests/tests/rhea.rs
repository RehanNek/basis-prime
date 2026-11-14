//! Rhea's own contract file in the sandbox (FUNDING.md 4.4 and 9; research/rhea.md, "Our copy in the sandbox"): the
//! release file of Burrow 0.15.7, deployed and set up the way `scripts/rhea-setup.sh` will set up
//! `rhea.pbf-ops.testnet`, with our test tokens and a fixed price for each. No oracle account exists in any test.
//!
//! - the file deploys, lists both tokens with mainnet's settings, and only its owner can change them;
//! - one loan from start to finish: supply, register, collateral, borrow, repay, withdraw, with the gas each call
//!   burns and the blocks the borrowed USDC takes to arrive;
//! - the gas a borrow needs attached;
//! - a borrow that asks for too much, a price callback that fails, a transfer that can't land, and what a caller
//!   sees each time;
//! - a falling BTC price, the health factor in the views, and a stranger's liquidation. This test runs under the
//!   testnet names and, when `RHEA_VIEWS_OUT` names a file, saves the views the engine reads into it: at two BTC
//!   prices, and once more with the copy charging mainnet's rate;
//! - the rates the copy charges once the operator has borrowed as much of its USDC as mainnet has lent out;
//! - the draft `scripts/rhea-setup.sh` carries the same JSON as these tests (it is read, never run).
//!
//! Run with `--nocapture` to see the measured gas and blocks, and what each call returned.
mod common;

use common::rhea::*;
use common::*;
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::{AccountId, NearToken};
use serde_json::{json, Value};

/// BTC's fixed price at the start of every test, in dollars.
const BTC_USD: u128 = 75_000;

/// A sandbox with mUSDC, mNBTC and our copy of Rhea, which the operator owns and has lent $1,000,000 of mUSDC. The
/// operator hasn't borrowed any of it back (`Rhea::charge_mainnets_rate`), so loans here cost about 0%.
struct World {
    chain: Chain,
    musdc: AccountId,
    mnbtc: AccountId,
    operator: AccountId,
    rhea: Rhea,
}

impl World {
    /// Under sandbox names: `rhea.sandbox`, `musdc.sandbox`, `mnbtc.sandbox`, `operator.sandbox`.
    async fn new() -> Self {
        let chain = Chain::start().await;
        let token = wasm("pb_testnet_token");
        let musdc = chain.contract("musdc", 10, token.clone(), Some(("new", musdc_init()))).await;
        let mnbtc = chain.contract("mnbtc", 10, token, Some(("new", mnbtc_init()))).await;
        let operator = chain.account("operator", 50).await;
        let rhea = Rhea::stand_up(&chain, &operator, &musdc, &mnbtc, BTC_USD, usd(1_000_000)).await;
        World { chain, musdc, mnbtc, operator, rhea }
    }

    /// Under the names the copy will have on testnet, so the saved views name the tokens the engine is set up for.
    async fn as_on_testnet() -> Self {
        let chain = Chain::start().await;
        let operator = chain.named_account("pbf-ops.testnet", 50).await;
        let musdc = chain.named_account("musdc.pbf-ops.testnet", 10).await;
        let mnbtc = chain.named_account("mnbtc.pbf-ops.testnet", 10).await;
        let token = wasm("pb_testnet_token");
        assert_ok(&deploy_with_init(&chain, &musdc, token.clone(), "new", musdc_init()).await, "mUSDC");
        assert_ok(&deploy_with_init(&chain, &mnbtc, token, "new", mnbtc_init()).await, "mNBTC");
        let id = chain.named_account("rhea.pbf-ops.testnet", 11).await;
        let rhea = Rhea::stand_up_at(&chain, id, &operator, &musdc, &mnbtc, BTC_USD, usd(1_000_000)).await;
        World { chain, musdc, mnbtc, operator, rhea }
    }

    /// A client that is registered with Rhea and on mUSDC, and has posted `sats` of nBTC as collateral.
    async fn borrower(&self, name: &str, sats: u128) -> AccountId {
        let id = self.chain.account(name, 10).await;
        self.set_up_borrower(&id, sats).await;
        id
    }

    async fn set_up_borrower(&self, id: &AccountId, sats: u128) {
        mint(&self.chain, &self.mnbtc, id, sats).await;
        self.register_on_usdc(id).await;
        self.rhea.register(&self.chain, id).await;
        assert_ok(&self.rhea.post_collateral(&self.chain, id, sats).await, "posting collateral");
    }

    /// Registers `account` on mUSDC, so it can be sent USDC: 0.00125 NEAR.
    async fn register_on_usdc(&self, account: &AccountId) {
        self.register_on(&self.musdc, account).await
    }

    async fn register_on(&self, token: &AccountId, account: &AccountId) {
        let args = json!({ "account_id": account, "registration_only": true });
        self.chain.ok_with(account, token, "storage_deposit", args, NearToken::from_micronear(1250)).await;
    }

    async fn usdc_of(&self, account: &AccountId) -> u128 {
        token_balance(&self.chain, &self.musdc, account).await
    }

    async fn nbtc_of(&self, account: &AccountId) -> u128 {
        token_balance(&self.chain, &self.mnbtc, account).await
    }

    /// What Rhea has lent out of its USDC, in inner units.
    async fn usdc_lent(&self) -> u128 {
        str_u128(&self.rhea.assets(&self.chain).await[0]["borrowed"]["balance"])
    }
}

fn musdc_init() -> Value {
    json!({ "name": "Mock USDC", "symbol": "mUSDC", "decimals": 6 })
}

fn mnbtc_init() -> Value {
    json!({ "name": "Mock nBTC", "symbol": "mNBTC", "decimals": 8 })
}

/// Whether the call logged one of Rhea's own events (`"standard":"burrow"`) with this name.
fn has_rhea_event(result: &ExecutionFinalResult, event: &str) -> bool {
    let needle = format!(r#""event":"{event}""#);
    result.logs().iter().any(|log| log.contains(r#""standard":"burrow""#) && log.contains(&needle))
}

/// Whether the transaction itself reports success, which is all a caller is told. Receipts inside may have failed.
fn reports_success(result: &ExecutionFinalResult) -> bool {
    result.clone().into_result().is_ok()
}

/// The accounts whose receipts failed, in order.
fn failed_on(result: &ExecutionFinalResult) -> Vec<String> {
    result.receipt_failures().iter().map(|f| f.executor_id.to_string()).collect()
}

/// Prints one measured call: its whole gas, each step as `account@block gas`, what the call returned, and why any
/// receipt failed.
async fn report(chain: &Chain, what: &str, result: &ExecutionFinalResult) -> Vec<Step> {
    let steps = steps(chain, result).await;
    let detail: Vec<String> =
        steps.iter().map(|s| format!("{}@{} {:.1}", s.on, s.block, s.gas.as_gas() as f64 / 1e12)).collect();
    println!("{what}: {:.1} TGas in all [{}]", tgas(result), detail.join(", "));
    match result.clone().into_result() {
        Ok(done) => println!("    returned {}", done.json::<Value>().map_or("nothing".to_string(), |v| v.to_string())),
        Err(_) => println!("    the call failed"),
    }
    let text = format!("{result:?}");
    for (at, _) in text.match_indices("Smart contract panicked: ") {
        println!("    {}", text[at..].split("\"))").next().unwrap());
    }
    steps
}

#[tokio::test]
async fn rheas_file_deploys_and_lists_both_tokens_with_mainnets_settings() {
    let w = World::new().await;
    let (c, rhea) = (&w.chain, &w.rhea);

    // The deployed code is the release file, and it says which version it is.
    assert_eq!(c.code_sha256(&rhea.id).await, RHEA_SHA256);
    assert_eq!(c.view::<String>(&rhea.id, "get_version", json!({})).await, "0.15.7");

    // The config is what we sent, field for field. Prices come from the Pyth side of the code, and none of the
    // five accounts the config names exists.
    let config: Value = c.view(&rhea.id, "get_config", json!({})).await;
    assert_eq!(config, rhea_config(&rhea.id, &w.operator));
    assert_eq!((&config["enable_pyth_oracle"], &config["enable_price_oracle"]), (&json!(true), &json!(false)));
    for field in ["oracle_account_id", "pyth_oracle_account_id", "ref_exchange_id", "booster_token_id", "dcl_id"] {
        let named = config[field].as_str().unwrap();
        assert!(!exists(c, named).await, "{named} exists");
    }

    // Both tokens are listed with the settings we sent, at 18 inner decimals, and the operator's $1,000,000 is
    // there to lend.
    let assets = rhea.assets(c).await;
    assert_eq!((&assets[0]["token_id"], &assets[1]["token_id"]), (&json!(w.musdc), &json!(w.mnbtc)));
    assert_eq!(assets[0]["config"], usdc_asset_config());
    assert_eq!(assets[1]["config"], nbtc_asset_config());
    assert_eq!(str_u128(&assets[0]["supplied"]["balance"]), usd(1_000_000) * USDC_INNER);
    assert_eq!(str_u128(&assets[1]["supplied"]["balance"]), 0);
    assert_eq!(w.usdc_of(&rhea.id).await, usd(1_000_000));

    // The ratios, the reserve share and the rate curves are the ones read from mainnet on 10 Nov. The caps are not.
    let path = format!("{}/../../research/data/rhea_warehouse_2026-11-10.json", env!("CARGO_MANIFEST_DIR"));
    let mainnet: Value = serde_json::from_slice(&std::fs::read(&path).expect("the saved mainnet read")).unwrap();
    let fields =
        ["volatility_ratio", "reserve_ratio", "target_utilization", "target_utilization_rate", "max_utilization_rate"];
    for (asset, name) in [(&assets[0], "USDC"), (&assets[1], "nBTC")] {
        for field in fields {
            assert_eq!(asset["config"][field], mainnet["assets"][name][field], "{name}'s {field}");
        }
    }
    assert_eq!(assets[0]["config"]["volatility_ratio"], 9500);
    assert_eq!(assets[1]["config"]["volatility_ratio"], 8000);

    // Mainnet takes at most 20 nBTC as collateral, which one stranger with faucet tokens could fill. The copy has
    // no such cap (25 nBTC go in, at the end of this test). nBTC's cap on borrowing is mainnet's still, but nBTC
    // can't be borrowed at all here.
    for (asset, field) in [(0, "supplied_limit"), (0, "borrowed_limit"), (1, "supplied_limit")] {
        assert_eq!(assets[asset]["config"][field], NO_CAP);
    }
    assert_eq!(assets[1]["config"]["borrowed_limit"], "4000000000000000000");
    assert_eq!((&assets[0]["config"]["can_borrow"], &assets[1]["config"]["can_borrow"]), (&json!(true), &json!(false)));

    // Each token has a fixed price: $1 for USDC and $75,000 for one nBTC.
    assert_eq!(rhea.price_info(c, &w.musdc).await, usdc_price_info());
    let btc = rhea.price_info(c, &w.mnbtc).await;
    assert_eq!(btc, nbtc_price_info(BTC_USD * 100));
    assert_eq!(btc["default_price"], json!({ "multiplier": "7500000", "decimals": 10 }));

    // Only the owner lists tokens and changes prices, and each such call wants exactly 1 yoctoNEAR.
    let stranger = c.account("stranger", 10).await;
    let reprice = json!({ "token_id": w.mnbtc, "token_pyth_info": nbtc_price_info(100) });
    let refused = c.call(&stranger, &rhea.id, "update_token_pyth_info", reprice.clone(), one_yocto()).await;
    assert_refused(&refused, "Not an owner");
    let relist = json!({ "token_id": w.mnbtc, "asset_config": nbtc_asset_config() });
    assert_refused(&c.call(&stranger, &rhea.id, "update_asset", relist, one_yocto()).await, "Not an owner");
    let unpaid = c.call(&w.operator, &rhea.id, "update_token_pyth_info", reprice, yocto(0)).await;
    assert_refused(&unpaid, "Requires attached deposit of exactly 1 yoctoNEAR");
    assert_eq!(rhea.price_info(c, &w.mnbtc).await, btc);

    // The copy pays for its own storage: the file is 1,015,136 bytes, and each byte locks 10^19 yoctoNEAR. The 11
    // NEAR it was created with cover that and the deploy, with some to spare.
    let (bytes, held) = (c.storage_usage(&rhea.id).await, c.balance(&rhea.id).await as f64 / 1e24);
    let locked = bytes as f64 / 1e5;
    println!("the copy after setup: {bytes} bytes, {locked:.2} NEAR locked of the {held:.2} it holds");
    assert!((1_015_136..1_030_000).contains(&bytes), "{bytes} bytes");
    assert!(held - locked > 0.5, "{held} NEAR held, {locked} locked");

    // More collateral than mainnet's cap of 20 nBTC goes in.
    let whale = w.borrower("whale", 25 * NBTC).await;
    assert_eq!(rhea.collateral_inner(c, &whale).await, 25 * NBTC * NBTC_INNER);

    // A stranger with faucet USDC can't borrow that collateral away. It posts $200,000 of USDC, which would carry
    // 1 nBTC twice over, and Rhea still refuses, in its own words. So the client can take all its nBTC back.
    mint(c, &w.musdc, &stranger, usd(200_000)).await;
    rhea.register(c, &stranger).await;
    let post =
        json!({ "receiver_id": rhea.id, "amount": usd(200_000).to_string(), "msg": "\"OnlyIncreaseCollateral\"" });
    assert_ok(&c.call(&stranger, &w.musdc, "ft_transfer_call", post, one_yocto()).await, "the stranger's collateral");
    let one_nbtc = (NBTC * NBTC_INNER).to_string();
    let take = json!([
        { "Borrow": { "token_id": w.mnbtc, "amount": one_nbtc } },
        { "Withdraw": { "token_id": w.mnbtc, "max_amount": one_nbtc } },
    ]);
    let refused = rhea.execute_with_pyth(c, &stranger, take).await;
    assert_refused(&refused, "Thi asset can't be used borrowed");
    report(c, "a stranger's nBTC borrow", &refused).await;
    assert_eq!(rhea.assets(c).await[1]["borrowed"]["balance"], "0");
    assert_ok(&rhea.withdraw_collateral(c, &whale, 25 * NBTC).await, "the client's withdrawal");
    assert_eq!(w.nbtc_of(&whale).await, 25 * NBTC);
}

/// One of the JSON bodies in `scripts/rhea-setup.sh`: the text between `<name>() {`, `cat <<JSON` and `JSON`, with
/// the script's variables filled in.
fn script_json(script: &str, name: &str, vars: &[(&str, &str)]) -> Value {
    let opening = format!("\n{name}() {{\n  cat <<JSON\n");
    let from = script.find(&opening).unwrap_or_else(|| panic!("the script has no {name}")) + opening.len();
    let body = &script[from..];
    let mut text = body[..body.find("\nJSON\n").expect("the body's end")].to_string();
    for (var, value) in vars {
        text = text.replace(&format!("${{{var}}}"), value);
    }
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name} in the script isn't JSON: {e}"))
}

#[test]
fn the_testnet_setup_script_sends_what_these_tests_send() {
    let path = format!("{}/../../scripts/rhea-setup.sh", env!("CARGO_MANIFEST_DIR"));
    let script = std::fs::read_to_string(&path).expect("scripts/rhea-setup.sh");
    let (copy, parent): (AccountId, AccountId) =
        ("rhea.pbf-ops.testnet".parse().unwrap(), "pbf-ops.testnet".parse().unwrap());
    for (var, value) in [("COPY", copy.as_str()), ("PARENT", parent.as_str())] {
        assert!(script.contains(&format!("\n{var}={value}\n")), "the script's {var} isn't {value}");
    }
    assert!(script.contains(&format!("\nWASM_SHA256={RHEA_SHA256}\n")));
    assert!(script.contains(&format!("\nCODE_HASH={RHEA_CODE_HASH}\n")));

    let vars = [("COPY", copy.as_str()), ("PARENT", parent.as_str()), ("BTC_CENTS", "7500000")];
    assert_eq!(script_json(&script, "new_args", &vars), json!({ "config": rhea_config(&copy, &parent) }));
    assert_eq!(script_json(&script, "usdc_asset_config", &vars), usdc_asset_config());
    assert_eq!(script_json(&script, "nbtc_asset_config", &vars), nbtc_asset_config());
    assert_eq!(script_json(&script, "usdc_price_info", &vars), usdc_price_info());
    assert_eq!(script_json(&script, "nbtc_price_info", &vars), nbtc_price_info(BTC_USD * 100));
}

#[tokio::test]
async fn with_as_much_lent_out_as_on_mainnet_the_copy_charges_mainnets_rates() {
    let w = World::new().await;
    let (c, rhea) = (&w.chain, &w.rhea);

    // With nothing lent out, borrowing is free: the rate follows how much of the supplied USDC is out on loan.
    assert_eq!(rhea.assets(c).await[0]["borrow_apr"], "0.0");

    // On 10 Nov mainnet had 85.15% of its USDC lent out and charged 15.91% (research/rhea.md 11). The operator
    // puts the copy in the same state alone, as the setup script does: it turns its $1,000,000 deposit into
    // collateral, which stays lendable, and borrows $851,500 of it. Both sides are USDC, so no BTC price can touch
    // this loan: its health factor starts at 950,000 / 896,316 = 1.06.
    assert_eq!(rhea.charge_mainnets_rate(c).await, usd(851_500));
    assert_eq!(w.usdc_of(&w.operator).await, usd(851_500));
    let own = rhea.account(c, &w.operator).await;
    assert_eq!(own["supplied"], json!([]), "the whole deposit is collateral now");
    let posted = balance_of(&own["collateral"], &w.musdc);
    assert!(posted >= usd(1_000_000) * USDC_INNER && posted < usd(1_000_001) * USDC_INNER, "posted {posted}");
    let health = rhea.health_bp(c, &w.operator).await.unwrap();
    assert!((10_590..=10_600).contains(&health), "health {health}");

    let usdc = &rhea.assets(c).await[0];
    let apr = |field: &str| usdc[field].as_str().unwrap().parse::<f64>().unwrap();
    println!("at 85.15% lent out: borrow {:.2}%, supply {:.2}%", apr("borrow_apr") * 100.0, apr("supply_apr") * 100.0);
    assert!((0.1585..0.1595).contains(&apr("borrow_apr")), "borrow {}", apr("borrow_apr"));
    // Suppliers get the borrow rate on the part that is lent, less the quarter Rhea keeps in reserve:
    // 15.91% x 0.8515 x 0.75 = 10.16%. (Mainnet paid 10.32% that day, because it also lends out its reserve.)
    assert!((0.1010..0.1020).contains(&apr("supply_apr")), "supply {}", apr("supply_apr"));

    // $148,500 is left for clients, and a client's loan pays that rate from its first second.
    let client = w.borrower("client", NBTC).await;
    assert_ok(&rhea.borrow(c, &client, usd(10_000)).await, "a client's loan");
    let rate = rhea.account(c, &client).await["borrowed"][0]["apr"].as_str().unwrap().parse::<f64>().unwrap();
    println!("with a client's $10,000 on top (86.15% lent out): borrow {:.2}%", rate * 100.0);
    assert!((0.16..0.20).contains(&rate), "the client pays {rate}");
    let more = rhea.borrow(c, &client, usd(140_000)).await;
    assert_refused(&more, "Borrow error: Exceeded available amount");
}

#[tokio::test]
async fn a_loan_runs_from_start_to_finish_with_no_oracle() {
    let w = World::new().await;
    let (c, rhea) = (&w.chain, &w.rhea);

    // A lender registers with Rhea (0.1 NEAR) and supplies $200,000 by sending it with an empty message.
    let lender = c.account("lender", 10).await;
    mint(c, &w.musdc, &lender, usd(200_000)).await;
    rhea.register(c, &lender).await;
    let supplied = rhea.supply(c, &lender, &w.musdc, usd(200_000)).await;
    assert_ok(&supplied, "supply");
    assert!(has_rhea_event(&supplied, "deposit"));
    report(c, "supply 200,000 USDC", &supplied).await;
    assert_eq!(balance_of(&rhea.account(c, &lender).await["supplied"], &w.musdc), usd(200_000) * USDC_INNER);

    // A borrower registers, then posts 1 nBTC straight into collateral.
    let borrower = c.account("borrower", 10).await;
    mint(c, &w.mnbtc, &borrower, NBTC).await;
    w.register_on_usdc(&borrower).await;
    assert_eq!(rhea.account(c, &borrower).await, Value::Null, "not registered yet");
    let args = json!({ "account_id": borrower, "registration_only": true });
    let registered = c.call(&borrower, &rhea.id, "storage_deposit", args, RHEA_STORAGE).await;
    assert_ok(&registered, "storage_deposit");
    report(c, "register (storage_deposit)", &registered).await;
    let posted = rhea.post_collateral(c, &borrower, NBTC).await;
    assert_ok(&posted, "collateral");
    assert!(has_rhea_event(&posted, "increase_collateral"));
    report(c, "post 1 nBTC as collateral", &posted).await;
    assert_eq!(rhea.collateral_inner(c, &borrower).await, NBTC * NBTC_INNER);
    assert_eq!(w.nbtc_of(&borrower).await, 0);
    assert_eq!(rhea.health_bp(c, &borrower).await, None, "no debt, no health factor");

    // It borrows $30,000 and has it sent to itself, in one call. Nothing but Rhea, the token and the borrower runs.
    let borrowed = rhea.borrow(c, &borrower, usd(30_000)).await;
    assert_ok(&borrowed, "borrow");
    assert!(has_rhea_event(&borrowed, "borrow") && has_rhea_event(&borrowed, "withdraw_succeeded"));
    let ran = report(c, "borrow 30,000 USDC and withdraw it", &borrowed).await;
    for step in &ran {
        assert!([&borrower, &rhea.id, &w.musdc].contains(&&step.on), "a step ran on {}", step.on);
    }
    assert_eq!(w.usdc_of(&borrower).await, usd(30_000));
    let debt = rhea.debt_inner(c, &borrower).await;
    assert!(debt >= usd(30_000) * USDC_INNER && debt < usd(30_001) * USDC_INNER, "debt {debt}");
    // 1 nBTC at $75,000 counts for $60,000, and $30,000 of USDC weighs $31,579: a health factor of 1.9.
    let health = rhea.health_bp(c, &borrower).await.unwrap();
    assert!((18_990..=19_000).contains(&health), "health {health}");

    // The USDC is in the borrower's balance two blocks after the block that took the transaction: Rhea runs in
    // the next block, and the token's transfer in the one after. Rhea's own callback follows one block later.
    let (sent, at_rhea) = (ran[0].block, ran[1].block);
    let transfer = ran.iter().find(|s| s.on == w.musdc).expect("the token's transfer").block;
    let callback = ran.iter().rfind(|s| s.on == rhea.id).unwrap().block;
    println!(
        "borrow: sent in block {sent}, Rhea ran in {at_rhea}, the USDC arrived in {transfer}, callback {callback}"
    );
    assert_eq!((at_rhea - sent, transfer - sent, callback - sent), (1, 2, 3));

    // A second loan, now that interest has moved Rhea's books. `Withdraw` with an exact `amount` then asks for one
    // share more than the borrow added, so the whole call fails and nothing is lent. With `max_amount` it goes
    // through, and the borrower gets the $1,000 less at most one millionth of a dollar.
    let inner = (usd(1_000) * USDC_INNER).to_string();
    let exact = json!([
        { "Borrow": { "token_id": w.musdc, "amount": inner } },
        { "Withdraw": { "token_id": w.musdc, "amount": inner } },
    ]);
    assert_refused(&rhea.execute_with_pyth(c, &borrower, exact).await, "Not enough asset balance");
    assert!(rhea.debt_inner(c, &borrower).await < usd(30_001) * USDC_INNER);
    let again = rhea.borrow(c, &borrower, usd(1_000)).await;
    assert_ok(&again, "second borrow");
    report(c, "borrow 1,000 USDC more", &again).await;
    let got = w.usdc_of(&borrower).await - usd(30_000);
    println!("the second borrow of 1,000,000,000 units delivered {got}");
    assert!(got == usd(1_000) || got == usd(1_000) - 1, "got {got}");

    // With the loan still open it takes 0.2 nBTC back: what stays, 0.8 nBTC, counts for $48,000 against $32,632.
    let partly = rhea.withdraw_collateral(c, &borrower, NBTC / 5).await;
    assert_ok(&partly, "taking some collateral back");
    assert!(has_rhea_event(&partly, "decrease_collateral"));
    report(c, "take 0.2 nBTC of collateral back", &partly).await;
    assert_eq!(w.nbtc_of(&borrower).await, NBTC / 5);
    assert_eq!(rhea.collateral_inner(c, &borrower).await, NBTC / 5 * 4 * NBTC_INNER);

    // It repays with a plain transfer. A dollar more than the debt clears it, and the rest stays as a deposit.
    mint(c, &w.musdc, &borrower, usd(10)).await;
    let debt = rhea.debt_inner(c, &borrower).await;
    let repaid = rhea.repay(c, &borrower, debt / USDC_INNER + usd(1)).await;
    assert_ok(&repaid, "repay");
    assert!(has_rhea_event(&repaid, "repay"));
    report(c, "repay the whole debt", &repaid).await;
    let after = rhea.account(c, &borrower).await;
    assert_eq!(after["borrowed"], json!([]), "the debt is gone");
    let left = balance_of(&after["supplied"], &w.musdc);
    assert!(left > 0 && left <= usd(1) * USDC_INNER, "what is left of the extra dollar: {left}");
    assert_eq!(w.usdc_lent().await, 0);

    // It takes its collateral out of the position and withdraws it, with what was left of the dollar.
    let out = json!([
        { "DecreaseCollateral": { "token_id": w.mnbtc } },
        { "Withdraw": { "token_id": w.mnbtc } },
        { "Withdraw": { "token_id": w.musdc } },
    ]);
    let before = w.usdc_of(&borrower).await;
    let withdrawn = rhea.execute_with_pyth(c, &borrower, out).await;
    assert_ok(&withdrawn, "withdraw");
    report(c, "decrease the collateral and withdraw everything", &withdrawn).await;
    assert_eq!(w.nbtc_of(&borrower).await, NBTC);
    assert_eq!(w.usdc_of(&borrower).await - before, left / USDC_INNER);
    let empty = rhea.account(c, &borrower).await;
    assert_eq!((&empty["supplied"], &empty["collateral"], &empty["borrowed"]), (&json!([]), &json!([]), &json!([])));

    // The lender earned a little while the money was out.
    let lender_now = balance_of(&rhea.account(c, &lender).await["supplied"], &w.musdc);
    assert!(lender_now > usd(200_000) * USDC_INNER);
}

#[tokio::test]
async fn a_borrow_runs_on_40_tgas_and_changes_nothing_on_20() {
    let w = World::new().await;
    let (c, rhea) = (&w.chain, &w.rhea);
    let borrower = w.borrower("borrower", NBTC).await;
    let mut least = None;
    for gas in [20, 25, 30, 35, 40, 150] {
        let args = json!({ "actions": borrow_actions(&w.musdc, usd(1_000)) });
        let (held, owed) = (w.usdc_of(&borrower).await, rhea.debt_inner(c, &borrower).await);
        let result = call_with_gas(c, &borrower, &rhea.id, "execute_with_pyth", args, one_yocto(), gas).await;
        let worked = reports_success(&result) && result.receipt_failures().is_empty();
        println!("a borrow with {gas} TGas attached: worked {worked}, burnt {:.1} TGas", tgas(&result));
        if worked {
            least = least.or(Some(gas));
            assert!(w.usdc_of(&borrower).await >= held + usd(1_000) - 1);
        } else {
            // Rhea ran out of gas before it could send the transfer, so its whole receipt was undone.
            assert_refused(&result, "Exceeded the prepaid gas");
            assert_eq!(failed_on(&result), [rhea.id.as_str()]);
            assert_eq!((w.usdc_of(&borrower).await, rhea.debt_inner(c, &borrower).await), (held, owed));
        }
        assert!(worked == (gas >= 40) || (25..40).contains(&gas), "{gas} TGas: worked {worked}");
    }
    println!("the least gas that worked: {least:?} TGas");
}

#[tokio::test]
async fn a_borrow_that_cannot_go_through_lends_nothing_and_the_views_show_it() {
    let w = World::new().await;
    let (c, rhea) = (&w.chain, &w.rhea);
    let borrower = w.borrower("borrower", NBTC).await;

    // 1 nBTC at $75,000 carries at most 75,000 x 0.80 x 0.95 = $57,000. One dollar more is refused. With a fixed
    // price for every token Rhea does the whole job in one receipt, so the call itself fails and the caller sees it.
    let too_much = rhea.borrow(c, &borrower, usd(57_001)).await;
    assert!(!reports_success(&too_much));
    assert_refused(&too_much, "compute_max_discount");
    assert_eq!(failed_on(&too_much), [rhea.id.as_str()]);
    let ran = report(c, "a borrow that asks for too much", &too_much).await;
    assert!(ran.iter().all(|s| s.on != w.musdc), "the token never ran");
    // The views say the same: no debt, nothing lent, no USDC received, and the collateral untouched.
    let after = rhea.account(c, &borrower).await;
    assert_eq!((&after["borrowed"], &after["supplied"]), (&json!([]), &json!([])));
    assert_eq!((w.usdc_lent().await, w.usdc_of(&borrower).await), (0, 0));
    assert_eq!(rhea.collateral_inner(c, &borrower).await, NBTC * NBTC_INNER);

    // Exactly the most is lent: Rhea keeps no buffer. A moment's interest later the health factor is under 1.
    assert_ok(&rhea.borrow(c, &borrower, usd(57_000)).await, "borrowing the most");
    let health = rhea.health_bp(c, &borrower).await.unwrap();
    assert!((9_990..=10_000).contains(&health), "health {health}");
    // Taking collateral out is checked the same way.
    let taken = rhea.withdraw_collateral(c, &borrower, NBTC / 100).await;
    assert_refused(&taken, "compute_max_discount");
    assert_eq!(w.nbtc_of(&borrower).await, 0);

    // On mainnet the prices come from an oracle, and Rhea then borrows in a callback it doesn't hand back to the
    // caller. Take nBTC's fixed price away and our copy goes the same way: it calls the oracle account, which
    // doesn't exist, its callback fails, and the call still reports success. Only the views show nothing was lent.
    let mut live = nbtc_price_info(BTC_USD * 100);
    live["default_price"] = Value::Null;
    rhea.owner_call(c, "update_token_pyth_info", json!({ "token_id": w.mnbtc, "token_pyth_info": live })).await;
    let other = w.borrower("other", NBTC).await;
    let detached = rhea.borrow(c, &other, usd(1_000)).await;
    assert!(reports_success(&detached), "the caller is told it worked");
    report(c, "a borrow whose price callback fails", &detached).await;
    let oracle = format!("no-pyth-oracle.{}", rhea.id);
    assert_eq!(failed_on(&detached), [oracle.as_str(), rhea.id.as_str()]);
    assert_refused(&detached, "AccountDoesNotExist");
    assert_refused(&detached, "cross call failed!");
    assert!(!has_rhea_event(&detached, "borrow"));
    assert_eq!(rhea.account(c, &other).await["borrowed"], json!([]));
    assert_eq!(w.usdc_of(&other).await, 0);
    let _ = rhea.set_btc_price(c, BTC_USD).await;

    // The other half-way case: the borrow is booked, but the token can't pay the borrower, who isn't registered on
    // it. The call reports success again. Rhea's callback puts the money back as the borrower's deposit, so the
    // views show a debt and a deposit of the same size, and no USDC arrived.
    let unready = c.account("unready", 10).await;
    mint(c, &w.mnbtc, &unready, NBTC).await;
    rhea.register(c, &unready).await;
    assert_ok(&rhea.post_collateral(c, &unready, NBTC).await, "collateral");
    let stuck = rhea.borrow(c, &unready, usd(1_000)).await;
    assert!(reports_success(&stuck), "the caller is told it worked");
    report(c, "a borrow whose transfer fails", &stuck).await;
    assert_eq!(failed_on(&stuck), [w.musdc.as_str()]);
    assert_refused(&stuck, "is not registered");
    assert!(has_rhea_event(&stuck, "borrow") && has_rhea_event(&stuck, "withdraw_failed"));
    let held = rhea.account(c, &unready).await;
    let (owed, kept) = (balance_of(&held["borrowed"], &w.musdc), balance_of(&held["supplied"], &w.musdc));
    assert!(owed >= usd(1_000) * USDC_INNER && kept > usd(999) * USDC_INNER && kept <= usd(1_000) * USDC_INNER);
    // Once it is registered, a plain `execute` (no prices needed) sends the money out.
    w.register_on_usdc(&unready).await;
    let actions = json!([{ "Withdraw": { "token_id": w.musdc } }]);
    let sent = c.call(&unready, &rhea.id, "execute", json!({ "actions": actions }), one_yocto()).await;
    assert_ok(&sent, "execute");
    report(c, "withdraw a deposit with execute", &sent).await;
    assert!(w.usdc_of(&unready).await >= usd(1_000) - 1);
}

#[tokio::test]
async fn a_falling_btc_price_lowers_the_health_factor_until_a_stranger_can_liquidate() {
    let w = World::as_on_testnet().await;
    let (c, rhea) = (&w.chain, &w.rhea);

    // The operator owns the copy, as it will on testnet, where the keeper signs price changes with the operator's
    // key. The keeper's own account can't change a price.
    let keeper = c.named_account("pbf-keeper.testnet", 10).await;
    let reprice = json!({ "token_id": w.mnbtc, "token_pyth_info": nbtc_price_info(100) });
    let refused = c.call(&keeper, &rhea.id, "update_token_pyth_info", reprice, one_yocto()).await;
    assert_refused(&refused, "Not an owner");

    // A client posts 1 nBTC and borrows $40,000. At $75,000 its health factor is 60,000 / 42,105 = 1.425.
    let borrower = c.named_account("demo.pbf.testnet", 10).await;
    w.set_up_borrower(&borrower, NBTC).await;
    assert_ok(&rhea.borrow(c, &borrower, usd(40_000)).await, "borrow");
    let before = rhea.views_at(c, &borrower, c.height().await).await;
    let health_before = health_bp_of(&before).unwrap();
    assert!((14_240..=14_250).contains(&health_before), "health {health_before}");

    // A stranger with USDC deposited at Rhea can't touch a healthy loan.
    let liquidator = c.named_account("liquidator.testnet", 10).await;
    mint(c, &w.musdc, &liquidator, usd(10_000)).await;
    w.register_on(&w.mnbtc, &liquidator).await;
    rhea.register(c, &liquidator).await;
    assert_ok(&rhea.supply(c, &liquidator, &w.musdc, usd(10_000)).await, "the liquidator's deposit");
    let liquidate = |usdc: u128, sats: u128| {
        json!([{ "Liquidate": {
            "account_id": borrower,
            "in_assets": [{ "token_id": w.musdc, "amount": (usdc * USDC_INNER).to_string() }],
            "out_assets": [{ "token_id": w.mnbtc, "amount": (sats * NBTC_INNER).to_string() }],
        } }])
    };
    let early = rhea.execute_with_pyth(c, &liquidator, liquidate(usd(5_000), 10_250_000)).await;
    assert_refused(&early, "The liquidation account is not at risk");

    // The owner lowers BTC's fixed price: one call, with the whole price setting. The views follow at once.
    let lowered = rhea.set_btc_price(c, 60_000).await;
    report(c, "change BTC's fixed price", &lowered).await;
    assert_eq!(rhea.price_info(c, &w.mnbtc).await["default_price"]["multiplier"], "6000000");
    let health = rhea.health_bp(c, &borrower).await.unwrap();
    assert!((11_390..=11_400).contains(&health), "health at $60,000: {health}");
    let _ = rhea.set_btc_price(c, 50_000).await;
    let after = rhea.views_at(c, &borrower, c.height().await).await;
    let health_after = health_bp_of(&after).unwrap();
    assert!((9_490..=9_500).contains(&health_after), "health at $50,000: {health_after}");
    println!("health factor: {health_before} bp at $75,000, {health} bp at $60,000, {health_after} bp at $50,000");

    // Under 1.0 anyone but the borrower can liquidate, paying from its own deposit at Rhea. The discount is half
    // the shortfall, (1 - 0.95) / 2 = 2.5%, so $5,000 buys at most $5,128 of nBTC: 0.10256 nBTC at $50,000.
    let greedy = rhea.execute_with_pyth(c, &liquidator, liquidate(usd(5_000), 10_300_000)).await;
    assert_refused(&greedy, "Not enough balances repaid");
    // A liquidation may not lift the loan back over 1.0: repaying $10,000 would.
    let whole = rhea.execute_with_pyth(c, &liquidator, liquidate(usd(10_000), 20_500_000)).await;
    assert_refused(&whole, "The liquidation amount is too large");
    let own = rhea.execute_with_pyth(c, &borrower, liquidate(usd(5_000), 10_250_000)).await;
    assert_refused(&own, "Can't liquidate yourself");

    let debt = rhea.debt_inner(c, &borrower).await;
    let liquidated = rhea.execute_with_pyth(c, &liquidator, liquidate(usd(5_000), 10_250_000)).await;
    assert_ok(&liquidated, "liquidate");
    assert!(has_rhea_event(&liquidated, "liquidate"));
    report(c, "liquidate 5,000 USDC of debt", &liquidated).await;
    // The borrower owes $5,000 less and has 0.1025 nBTC less. The liquidator holds that nBTC as a deposit.
    let owed = rhea.debt_inner(c, &borrower).await;
    assert!(owed >= debt - usd(5_000) * USDC_INNER && owed < debt - usd(4_999) * USDC_INNER, "owed {owed}");
    assert_eq!(rhea.collateral_inner(c, &borrower).await, (NBTC - 10_250_000) * NBTC_INNER);
    let gained = rhea.account(c, &liquidator).await;
    assert_eq!(balance_of(&gained["supplied"], &w.mnbtc), 10_250_000 * NBTC_INNER);
    let cash = balance_of(&gained["supplied"], &w.musdc);
    assert!(cash >= usd(5_000) * USDC_INNER && cash < usd(5_001) * USDC_INNER, "cash {cash}");
    // The loan is healthier, and still under 1.0: (0.8975 x 50,000 x 0.8) / (35,000 / 0.95) = 0.974.
    let health = rhea.health_bp(c, &borrower).await.unwrap();
    assert!(health > health_after && (9_735..=9_745).contains(&health), "health after: {health}");
    // The liquidator takes the nBTC home, and the rest of its USDC, with a plain `execute`.
    let actions = json!([{ "Withdraw": { "token_id": w.mnbtc } }, { "Withdraw": { "token_id": w.musdc } }]);
    c.ok_with(&liquidator, &rhea.id, "execute", json!({ "actions": actions }), one_yocto()).await;
    assert_eq!(w.nbtc_of(&liquidator).await, 10_250_000);
    assert_eq!(rhea.account(c, &liquidator).await["supplied"], json!([]));

    // Later BTC is back at $75,000, the client has repaid all but $100, and the operator has borrowed $851,500 of
    // its own $1,000,000, as the setup script does. The client's loan now costs what mainnet charges.
    let _ = rhea.set_btc_price(c, BTC_USD).await;
    let owed = rhea.debt_inner(c, &borrower).await / USDC_INNER;
    assert_ok(&rhea.repay(c, &borrower, owed - usd(100)).await, "repaying most of the loan");
    let lent_to_itself = rhea.charge_mainnets_rate(c).await;
    assert!((usd(851_500)..usd(851_501)).contains(&lent_to_itself), "the operator borrowed {lent_to_itself}");
    let rated = rhea.views_at(c, &borrower, c.height().await).await;
    let health_rated = health_bp_of(&rated).unwrap();
    let apr = |v: &Value| v.as_str().unwrap().parse::<f64>().unwrap();
    let (borrow_apr, supply_apr) =
        (apr(&rated["get_assets"][0]["borrow_apr"]), apr(&rated["get_assets"][0]["supply_apr"]));
    println!("with the operator's own loan: borrow {:.2}%, supply {:.2}%", borrow_apr * 100.0, supply_apr * 100.0);
    assert!((0.158..0.161).contains(&borrow_apr), "borrow {borrow_apr}");
    assert_eq!(rated["get_account"]["borrowed"][0]["apr"], rated["get_assets"][0]["borrow_apr"]);
    assert!((0.101..0.103).contains(&supply_apr), "supply {supply_apr}");
    assert_eq!(rated["get_config"]["owner_id"], "pbf-ops.testnet");

    // The views the engine reads, for its reader's tests: before and after the fall, and at mainnet's rate.
    if let Ok(path) = std::env::var("RHEA_VIEWS_OUT") {
        let saved = json!({
            "about": "The raw answers of our Rhea copy's views in the local sandbox, under the names it will have on \
                      testnet. The contract is Rhea's own release file. Written by contracts/tests/tests/rhea.rs when \
                      RHEA_VIEWS_OUT names this file.",
            "contract_id": rhea.id,
            "version": c.view::<String>(&rhea.id, "get_version", json!({})).await,
            "code_sha256": RHEA_SHA256,
            "usdc": w.musdc,
            "nbtc": w.mnbtc,
            "account": borrower,
            "args": {
                "get_config": {},
                "get_assets": { "token_ids": [w.musdc, w.mnbtc] },
                "get_token_pyth_info": { "token_id": "<the token: one answer for each, keyed by token>" },
                "get_account": { "account_id": borrower },
            },
            "health_bp_note": "health_bp is worked out by the test from these answers, in millionths of a dollar: collateral value x \
                          ratio / 10000 over debt value x 10000 / ratio. Rhea has no view for it.",
            "before": {
                "position": "1 nBTC posted as collateral, 40,000 USDC borrowed, at about 0.3% a year",
                "btc_usd": BTC_USD as u64,
                "health_bp": health_before as u64,
                "views": before,
            },
            "after": {
                "position": "the same, after BTC's fixed price fell",
                "btc_usd": 50_000,
                "health_bp": health_after as u64,
                "views": after,
            },
            "with_mainnets_rate": {
                "position": "0.8975 nBTC posted as collateral, about 100 USDC borrowed, after the operator borrowed \
                             851,500 of its own 1,000,000 USDC: 85.16% is lent out, at about 15.9% a year",
                "btc_usd": BTC_USD as u64,
                "health_bp": health_rated as u64,
                "views": rated,
            },
        });
        std::fs::write(&path, serde_json::to_string_pretty(&saved).unwrap() + "\n").expect("can't write the views");
        println!("saved the views to {path}");
    }
}
