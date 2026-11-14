//! Rhea's own contract file (Burrow 0.15.7, `vendor/burrowland/burrowland_release.wasm`) in the sandbox, set up the
//! way our testnet copy will be (FUNDING.md 9; research/rhea.md, "Our copy in the sandbox"):
//! - test USDC and test nBTC listed with mainnet's settings: ratios 9500 and 8000, mainnet's rate curves, and 18
//!   inner decimals for both. Three caps are lifted, because our faucet tokens are free to anyone (`NO_CAP`);
//! - a fixed price for each token inside the contract (the token pyth info's `default_price`), so no oracle account
//!   exists and none is called;
//! - USDC supplied by the owner, for clients to borrow. `charge_mainnets_rate` then has the owner borrow most of
//!   it back, so that the copy charges what mainnet charges. Tests that don't call it borrow at about 0%.
//!
//! Every call here is the call a client, the keeper or `scripts/rhea-setup.sh` makes. Method names, argument shapes
//! and deposits are Rhea's: github.com/ref-finance/burrowland at a479b83, `contracts/contract/src`.
//!
//! ```ignore
//! let rhea = Rhea::stand_up(&chain, &operator, &musdc, &mnbtc, 75_000, usd(1_000_000)).await;
//! rhea.charge_mainnets_rate(&chain).await; // optional: 15.91% to borrow, $148,500 left to lend
//! rhea.register(&chain, &client).await; // the client holds nBTC and is registered on mUSDC already
//! assert_ok(&rhea.post_collateral(&chain, &client, NBTC).await, "collateral");
//! assert_ok(&rhea.borrow(&chain, &client, usd(30_000)).await, "borrow");
//! let _ = rhea.set_btc_price(&chain, 50_000).await;
//! assert!(rhea.health_bp(&chain, &client).await.unwrap() < 13_500);
//! ```
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::types::{CryptoHash, Reference, TxExecutionStatus};
use near_api::{Account, AccountId, Contract, NearGas, NearToken};
use serde_json::{json, Value};

use super::{assert_ok, one_yocto, str_u128, Chain};

/// The file's sha256, in hex, and the same hash the way NEAR shows a deployed contract's code (INTERFACES.md 30).
pub const RHEA_SHA256: &str = "bdd286fece512c3def8119f58063e9d42571069cfa221ee32ec488d0fe395055";
pub const RHEA_CODE_HASH: &str = "DmzFHbCP7jCobFjPYx7GRvc1iHTpqyLJxvcrEawFaF4g";

/// One test nBTC, in the token's own units (8 decimals).
pub const NBTC: u128 = 100_000_000;
/// Rhea counts both tokens with 18 decimals inside its actions: 10^12 inner units for each of USDC's units, and
/// 10^10 for each of nBTC's. `ft_transfer_call` amounts stay in the token's own units.
pub const USDC_INNER: u128 = 1_000_000_000_000;
pub const NBTC_INNER: u128 = 10_000_000_000;

/// The largest cap Rhea can hold (u128's maximum), which its own source uses for "no limit". Mainnet caps USDC at
/// 60M supplied and 25M borrowed, and nBTC at 20 supplied. A stranger with faucet tokens could fill those and lock
/// our clients out, so the copy lifts them.
pub const NO_CAP: &str = "340282366920938463463374607431768211455";

/// The share of its USDC that mainnet had lent out on 10 Nov, in basis points (research/rhea.md 11). At that share
/// the curve charges 15.91%.
pub const MAINNET_LENT_OUT_BP: u128 = 8515;

/// What Rhea charges to register an account: 0.1 NEAR (10,000 bytes of storage).
pub const RHEA_STORAGE: NearToken = NearToken::from_millinear(100);
/// What our test token charges to register an account: 0.00125 NEAR.
const TOKEN_STORAGE: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);

/// Pyth's feed ids for USDC/USD and BTC/USD, as mainnet's `get_token_pyth_info` gives them. Rhea wants one per
/// token, but never asks for a feed while the token has a `default_price`.
const USDC_FEED: &str = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";
const BTC_FEED: &str = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

/// Rhea's contract file. Its hash is checked, so a changed file can't pass for Rhea's.
pub fn rhea_wasm() -> Vec<u8> {
    let path = format!("{}/../../vendor/burrowland/burrowland_release.wasm", env!("CARGO_MANIFEST_DIR"));
    let wasm = std::fs::read(&path).unwrap_or_else(|_| panic!("{path} is missing"));
    assert_eq!(super::sha256_hex(&wasm), RHEA_SHA256, "{path} isn't Rhea's 0.15.7 release file");
    assert_eq!(CryptoHash::hash(&wasm).to_string(), RHEA_CODE_HASH);
    wasm
}

/// The config `new` takes: mainnet's values (`contract.main.burrow.near.get_config`, 11 Nov) where they mean
/// something here. The five accounts it names besides the owner don't exist: they are names under the copy itself,
/// which only the copy's own key could ever create. 0.15.7 has 19 fields; mainnet's 0.16.2 added `contract_mode` and
/// `pause_operator_id`.
pub fn rhea_config(rhea: &AccountId, owner: &AccountId) -> Value {
    json!({
        "oracle_account_id": format!("no-price-oracle.{rhea}"),
        "pyth_oracle_account_id": format!("no-pyth-oracle.{rhea}"),
        "ref_exchange_id": format!("no-ref-exchange.{rhea}"),
        "owner_id": owner,
        "booster_token_id": format!("no-booster.{rhea}"),
        "booster_decimals": 18,
        "max_num_assets": 20,
        "maximum_recency_duration_sec": 90,
        "maximum_staleness_duration_sec": 90,
        "lp_tokens_info_valid_duration_sec": 600,
        "pyth_price_valid_duration_sec": 60,
        "minimum_staking_duration_sec": 2_592_000,
        "maximum_staking_duration_sec": 7_776_000,
        "x_booster_multiplier_at_maximum_staking_duration": 30_000,
        "force_closing_enabled": true,
        "enable_price_oracle": false,
        "enable_pyth_oracle": true,
        "boost_suppress_factor": 1000,
        "dcl_id": format!("no-dcl.{rhea}"),
    })
}

/// USDC's settings on mainnet (`get_assets`, 11 Nov): 6% a year at 80% lent out and 50% at 100%, ratio 9500. Two
/// things differ: no fee beneficiary (`pf.rhealab.near`), and no caps (`NO_CAP`; mainnet has 60M supplied and 25M
/// borrowed).
pub fn usdc_asset_config() -> Value {
    json!({
        "reserve_ratio": 2500,
        "beneficiaries": {},
        "target_utilization": 8000,
        "target_utilization_rate": "1000000000001847694955734069",
        "max_utilization_rate": "1000000000012857214234867166",
        "holding_position_fee_rate": "1000000000000000000000000000",
        "volatility_ratio": 9500,
        "extra_decimals": 12,
        "can_deposit": true,
        "can_withdraw": true,
        "can_use_as_collateral": true,
        "can_borrow": true,
        "net_tvl_multiplier": 10000,
        "max_change_rate": null,
        "supplied_limit": NO_CAP,
        "borrowed_limit": NO_CAP,
        "min_borrowed_amount": "1000000000",
    })
}

/// nBTC's settings on mainnet: 5% a year at 80% lent out and 250% at 100%, ratio 8000. Three things differ:
/// - no fee beneficiary;
/// - no cap on what is supplied (`NO_CAP`; mainnet has 20 nBTC), which is the cap on collateral;
/// - nBTC can't be borrowed (`can_borrow` is false). No client of ours borrows it, and on mainnet's setting a
///   stranger with faucet USDC could borrow the clients' collateral away, so that their withdrawals fail until it
///   comes back.
pub fn nbtc_asset_config() -> Value {
    json!({
        "reserve_ratio": 2500,
        "beneficiaries": {},
        "target_utilization": 8000,
        "target_utilization_rate": "1000000000001547125956667610",
        "max_utilization_rate": "1000000000039724853136740579",
        "holding_position_fee_rate": "1000000000000000000000000000",
        "volatility_ratio": 8000,
        "extra_decimals": 10,
        "can_deposit": true,
        "can_withdraw": true,
        "can_use_as_collateral": true,
        "can_borrow": false,
        "net_tvl_multiplier": 0,
        "max_change_rate": null,
        "supplied_limit": NO_CAP,
        "borrowed_limit": "4000000000000000000",
        "min_borrowed_amount": "1000000000",
    })
}

/// USDC's price setting: fixed at $1.0000. One whole USDC is worth `multiplier / 10^(decimals - 6)` dollars.
pub fn usdc_price_info() -> Value {
    json!({
        "decimals": 6,
        "fraction_digits": 4,
        "price_identifier": USDC_FEED,
        "extra_call": null,
        "default_price": { "multiplier": "10000", "decimals": 10 },
    })
}

/// nBTC's price setting: fixed at `cents` hundredths of a dollar for one whole nBTC. `decimals` is the token's 8
/// plus the 2 `fraction_digits`, as Rhea's own conversion of a Pyth price makes it (`pyth.rs`).
pub fn nbtc_price_info(cents: u128) -> Value {
    json!({
        "decimals": 8,
        "fraction_digits": 2,
        "price_identifier": BTC_FEED,
        "extra_call": null,
        "default_price": { "multiplier": cents.to_string(), "decimals": 10 },
    })
}

/// Our copy of Rhea in a sandbox.
pub struct Rhea {
    pub id: AccountId,
    /// The only account that can list tokens and change a price. On testnet it is `pbf-ops.testnet`, and the keeper
    /// signs price changes with the operator's key.
    pub owner: AccountId,
    pub usdc: AccountId,
    pub nbtc: AccountId,
}

impl Rhea {
    /// Stands the copy up at `rhea.<root>`: both tokens listed, BTC priced at `btc_usd` dollars, and `lend` units of
    /// USDC supplied by `owner`. `usdc` and `nbtc` are `pb_testnet_token` contracts that exist already.
    pub async fn stand_up(
        chain: &Chain,
        owner: &AccountId,
        usdc: &AccountId,
        nbtc: &AccountId,
        btc_usd: u128,
        lend: u128,
    ) -> Self {
        let id = chain.account("rhea", 11).await;
        Self::stand_up_at(chain, id, owner, usdc, nbtc, btc_usd, lend).await
    }

    /// As `stand_up`, on an account that exists already and holds at least 11 NEAR (the file locks 10.18 of them):
    /// for example one made under its testnet name with `Chain::named_account`.
    pub async fn stand_up_at(
        chain: &Chain,
        id: AccountId,
        owner: &AccountId,
        usdc: &AccountId,
        nbtc: &AccountId,
        btc_usd: u128,
        lend: u128,
    ) -> Self {
        let rhea = Rhea { id, owner: owner.clone(), usdc: usdc.clone(), nbtc: nbtc.clone() };
        let init = json!({ "config": rhea_config(&rhea.id, owner) });
        let deployed = deploy_with_init(chain, &rhea.id, rhea_wasm(), "new", init).await;
        assert_ok(&deployed, "deploying Rhea's file");
        println!("deploying Rhea's file and calling `new` burnt {:.1} TGas", tgas(&deployed));

        // The copy holds both tokens, so it needs storage on each. The owner registers with the copy to supply.
        for token in [usdc, nbtc] {
            let args = json!({ "account_id": rhea.id, "registration_only": true });
            chain.ok_with(owner, token, "storage_deposit", args, TOKEN_STORAGE).await;
        }
        rhea.register(chain, owner).await;

        // List each token, then give it its fixed price. All four calls are the owner's, with 1 yoctoNEAR.
        let listings = [
            (usdc, usdc_asset_config(), usdc_price_info()),
            (nbtc, nbtc_asset_config(), nbtc_price_info(btc_usd * 100)),
        ];
        for (token, config, price) in listings {
            rhea.owner_call(chain, "add_asset", json!({ "token_id": token, "asset_config": config })).await;
            let args = json!({ "token_id": token, "token_pyth_info": price });
            rhea.owner_call(chain, "add_token_pyth_info", args).await;
        }

        if lend > 0 {
            mint(chain, usdc, owner, lend).await;
            assert_ok(&rhea.supply(chain, owner, usdc, lend).await, "supplying USDC to lend");
        }
        rhea
    }

    /// A call only the owner can make, which must succeed. Each takes exactly 1 yoctoNEAR.
    pub async fn owner_call(&self, chain: &Chain, method: &str, args: Value) {
        chain.ok_with(&self.owner, &self.id, method, args, one_yocto()).await
    }

    /// Changes BTC's fixed price to `dollars`: the call the keeper makes with the owner's key. The whole setting is
    /// sent again, since `update_token_pyth_info` replaces it.
    pub async fn set_btc_price(&self, chain: &Chain, dollars: u128) -> ExecutionFinalResult {
        let args = json!({ "token_id": self.nbtc, "token_pyth_info": nbtc_price_info(dollars * 100) });
        let result = chain.call(&self.owner, &self.id, "update_token_pyth_info", args, one_yocto()).await;
        assert_ok(&result, "update_token_pyth_info");
        result
    }

    /// Makes the copy charge what mainnet charged on 10 Nov, as `scripts/rhea-setup.sh` does on testnet. The owner
    /// turns its whole USDC deposit into collateral, which stays lendable, and borrows 85.15% of it: $851,500 of
    /// $1,000,000. Borrowing then costs 15.91% a year, a deposit earns 10.16%, and the other 14.85% is left for
    /// clients. Both sides of the owner's loan are USDC, so no BTC price moves it. Returns what the owner borrowed,
    /// in USDC's own units.
    pub async fn charge_mainnets_rate(&self, chain: &Chain) -> u128 {
        let deposit = balance_of(&self.account(chain, &self.owner).await["supplied"], &self.usdc) / USDC_INNER;
        let actions = json!([{ "IncreaseCollateral": { "token_id": self.usdc } }]);
        chain.ok_with(&self.owner, &self.id, "execute", json!({ "actions": actions }), one_yocto()).await;
        let loan = deposit * MAINNET_LENT_OUT_BP / 10_000;
        assert_ok(&self.borrow(chain, &self.owner, loan).await, "the owner's own loan");
        loan
    }

    /// Registers `account` with the copy, paid by the account itself: 0.1 NEAR, once.
    pub async fn register(&self, chain: &Chain, account: &AccountId) {
        let args = json!({ "account_id": account, "registration_only": true });
        chain.ok_with(account, &self.id, "storage_deposit", args, RHEA_STORAGE).await;
    }

    /// Supplies `amount` of `token` (in the token's own units) for others to borrow. It earns interest and is not
    /// collateral.
    pub async fn supply(
        &self,
        chain: &Chain,
        from: &AccountId,
        token: &AccountId,
        amount: u128,
    ) -> ExecutionFinalResult {
        self.transfer_in(chain, from, token, amount, "").await
    }

    /// Posts `sats` of nBTC straight into `from`'s collateral.
    pub async fn post_collateral(&self, chain: &Chain, from: &AccountId, sats: u128) -> ExecutionFinalResult {
        self.transfer_in(chain, from, &self.nbtc, sats, "\"OnlyIncreaseCollateral\"").await
    }

    /// Repays up to `amount` of `from`'s USDC debt. Anything beyond the debt stays in `from`'s supplied balance.
    pub async fn repay(&self, chain: &Chain, from: &AccountId, amount: u128) -> ExecutionFinalResult {
        self.transfer_in(chain, from, &self.usdc, amount, "\"OnlyRepay\"").await
    }

    async fn transfer_in(
        &self,
        chain: &Chain,
        from: &AccountId,
        token: &AccountId,
        amount: u128,
        msg: &str,
    ) -> ExecutionFinalResult {
        let args = json!({ "receiver_id": self.id, "amount": amount.to_string(), "msg": msg });
        chain.call(from, token, "ft_transfer_call", args, one_yocto()).await
    }

    /// Borrows `amount` of USDC (in the token's own units) and sends it to the borrower's own token balance, in one
    /// call.
    pub async fn borrow(&self, chain: &Chain, account: &AccountId, amount: u128) -> ExecutionFinalResult {
        self.execute_with_pyth(chain, account, borrow_actions(&self.usdc, amount)).await
    }

    /// Takes `sats` of nBTC out of the collateral and sends it to the account's own token balance, in one call.
    pub async fn withdraw_collateral(&self, chain: &Chain, account: &AccountId, sats: u128) -> ExecutionFinalResult {
        let amount = (sats * NBTC_INNER).to_string();
        let actions = json!([
            { "DecreaseCollateral": { "token_id": self.nbtc, "amount": amount } },
            { "Withdraw": { "token_id": self.nbtc, "max_amount": amount } },
        ]);
        self.execute_with_pyth(chain, account, actions).await
    }

    /// `execute_with_pyth`, the entry for every action that needs prices, with 1 yoctoNEAR and 300 TGas.
    pub async fn execute_with_pyth(&self, chain: &Chain, account: &AccountId, actions: Value) -> ExecutionFinalResult {
        chain.call(account, &self.id, "execute_with_pyth", json!({ "actions": actions }), one_yocto()).await
    }

    /// `get_account`: what `account` has supplied, posted and borrowed. Null if it never registered.
    pub async fn account(&self, chain: &Chain, account: &AccountId) -> Value {
        chain.view(&self.id, "get_account", json!({ "account_id": account })).await
    }

    /// `get_assets` for USDC and nBTC, in that order.
    pub async fn assets(&self, chain: &Chain) -> Value {
        chain.view(&self.id, "get_assets", json!({ "token_ids": [self.usdc, self.nbtc] })).await
    }

    /// `get_token_pyth_info` for one token: its price setting.
    pub async fn price_info(&self, chain: &Chain, token: &AccountId) -> Value {
        chain.view(&self.id, "get_token_pyth_info", json!({ "token_id": token })).await
    }

    /// The account's USDC debt, in inner units (18 decimals). It grows every millisecond.
    pub async fn debt_inner(&self, chain: &Chain, account: &AccountId) -> u128 {
        balance_of(&self.account(chain, account).await["borrowed"], &self.usdc)
    }

    /// The account's nBTC collateral, in inner units (18 decimals).
    pub async fn collateral_inner(&self, chain: &Chain, account: &AccountId) -> u128 {
        balance_of(&self.account(chain, account).await["collateral"], &self.nbtc)
    }

    /// The account's health factor in basis points (10000 is the liquidation line), or `None` with no debt. Rhea
    /// has no view for it, so this reads the three views the engine reads and works it out (`health_bp_of`).
    pub async fn health_bp(&self, chain: &Chain, account: &AccountId) -> Option<u128> {
        let views = self.views_at(chain, account, chain.height().await).await;
        health_bp_of(&views)
    }

    /// The raw answers of the views the engine reads, all at one block: `get_config`, `get_assets` for USDC and
    /// nBTC, `get_token_pyth_info` for each (keyed by token), and `get_account` for `account`.
    pub async fn views_at(&self, chain: &Chain, account: &AccountId, height: u64) -> Value {
        let ask = |method: &'static str, args: Value| view_at(chain, &self.id, method, args, height);
        let mut prices = serde_json::Map::new();
        for token in [&self.usdc, &self.nbtc] {
            prices.insert(token.to_string(), ask("get_token_pyth_info", json!({ "token_id": token })).await);
        }
        json!({
            "block_height": height,
            "get_config": ask("get_config", json!({})).await,
            "get_assets": ask("get_assets", json!({ "token_ids": [self.usdc, self.nbtc] })).await,
            "get_token_pyth_info": prices,
            "get_account": ask("get_account", json!({ "account_id": account })).await,
        })
    }
}

/// A health factor in basis points from `Rhea::views_at`'s answers, the way Rhea's code works it out
/// (research/rhea.md 3): each collateral's value times its ratio, over each debt's value divided by its ratio.
/// Values are kept in millionths of a dollar here, so the last digit can differ from Rhea's own 27-digit sums.
/// `None` with no debt.
pub fn health_bp_of(views: &Value) -> Option<u128> {
    let mut sums = [0u128; 2];
    for (sum, side) in sums.iter_mut().zip(["collateral", "borrowed"]) {
        for held in views["get_account"][side].as_array().expect("a list of assets") {
            let token = held["token_id"].as_str().unwrap();
            let listed = views["get_assets"].as_array().unwrap().iter().find(|a| a["token_id"] == token);
            let config = &listed.unwrap_or_else(|| panic!("{token} isn't one of the two tokens"))["config"];
            let price = &views["get_token_pyth_info"][token]["default_price"];
            let scale = price["decimals"].as_u64().unwrap() + config["extra_decimals"].as_u64().unwrap() - 6;
            let value = str_u128(&held["balance"]) * str_u128(&price["multiplier"]) / 10u128.pow(scale as u32);
            let ratio = config["volatility_ratio"].as_u64().unwrap() as u128;
            *sum += if side == "collateral" { value * ratio / 10_000 } else { value * 10_000 / ratio };
        }
    }
    (sums[1] > 0).then(|| sums[0] * 10_000 / sums[1])
}

/// As `Chain::view`, at the block of that height, so several views can describe one moment.
pub async fn view_at(chain: &Chain, contract: &AccountId, method: &str, args: Value, height: u64) -> Value {
    let call = Contract(contract.clone()).call_function(method, args).read_only().at(Reference::AtBlock(height));
    call.fetch_from(&chain.network)
        .await
        .unwrap_or_else(|e| panic!("view {method} at block {height} failed: {e:?}"))
        .data
}

/// The actions of one loan: borrow `amount` of USDC (in the token's own units), then send it out. `Withdraw` takes
/// `max_amount` (research/rhea.md 2): with `amount`, the withdrawal fails by one share once the token has earned
/// interest. The borrower can then get one unit less than it asked for.
pub fn borrow_actions(usdc: &AccountId, amount: u128) -> Value {
    let inner = (amount * USDC_INNER).to_string();
    json!([
        { "Borrow": { "token_id": usdc, "amount": inner } },
        { "Withdraw": { "token_id": usdc, "max_amount": inner } },
    ])
}

/// The balance of `token` in one of `get_account`'s lists (`supplied`, `collateral` or `borrowed`), in inner units.
pub fn balance_of(list: &Value, token: &AccountId) -> u128 {
    let held = list.as_array().expect("a list of assets").iter().find(|a| a["token_id"] == token.as_str());
    held.map_or(0, |a| str_u128(&a["balance"]))
}

/// The token's public faucet: mints `amount` to `to`, registering it if needed.
pub async fn mint(chain: &Chain, token: &AccountId, to: &AccountId, amount: u128) {
    let args = json!({ "account_id": to, "amount": amount.to_string() });
    chain.ok_with(to, token, "mint", args, TOKEN_STORAGE).await;
}

/// An account's balance of `token`, in the token's own units.
pub async fn token_balance(chain: &Chain, token: &AccountId, of: &AccountId) -> u128 {
    str_u128(&chain.view::<Value>(token, "ft_balance_of", json!({ "account_id": of })).await)
}

/// Whether an account exists on the chain.
pub async fn exists(chain: &Chain, account: &str) -> bool {
    Account(account.parse().unwrap()).view().fetch_from(&chain.network).await.is_ok()
}

/// Deploys `wasm` to an account that exists, signed by the account itself, with `method(args)` as the init call.
pub async fn deploy_with_init(
    chain: &Chain,
    account: &AccountId,
    wasm: Vec<u8>,
    method: &str,
    args: Value,
) -> ExecutionFinalResult {
    let deploy = Contract::deploy(account.clone()).use_code(wasm).with_init_call(method, args).unwrap();
    let sent = deploy.gas(NearGas::from_tgas(100)).with_signer(chain.signer.clone()).send_to(&chain.network).await;
    sent.unwrap().into_full().expect("the outcome is complete")
}

/// As `Chain::call`, with `tgas` attached instead of 300 TGas.
pub async fn call_with_gas(
    chain: &Chain,
    caller: &AccountId,
    contract: &AccountId,
    method: &str,
    args: Value,
    deposit: NearToken,
    tgas: u64,
) -> ExecutionFinalResult {
    Contract(contract.clone())
        .call_function(method, args)
        .transaction()
        .gas(NearGas::from_tgas(tgas))
        .deposit(deposit)
        .with_signer(caller.clone(), chain.signer.clone())
        .wait_until(TxExecutionStatus::ExecutedOptimistic)
        .send_to(&chain.network)
        .await
        .unwrap_or_else(|e| panic!("{method} could not be sent: {e:?}"))
        .into_full()
        .expect("the outcome is complete")
}

/// One step of a call: the transaction itself, or one of its receipts.
#[derive(Debug, Clone)]
pub struct Step {
    /// The account the step ran on.
    pub on: AccountId,
    /// The height of the block it ran in.
    pub block: u64,
    pub gas: NearGas,
}

/// Where and when each step of a call ran, and the gas it burnt. The first step is the transaction turning into
/// a receipt, on the signer's account, and the second is that receipt. The rest come as the node lists them, which
/// isn't always block by block.
pub async fn steps(chain: &Chain, result: &ExecutionFinalResult) -> Vec<Step> {
    let mut steps = Vec::new();
    for outcome in result.outcomes() {
        let at = Reference::AtBlockHash(outcome.block_hash);
        let block = near_api::Chain::block_number().at(at).fetch_from(&chain.network).await.expect("no such block");
        steps.push(Step { on: outcome.executor_id.clone(), block, gas: outcome.gas_burnt });
    }
    steps
}

/// A call's whole cost in TGas, to one decimal.
pub fn tgas(result: &ExecutionFinalResult) -> f64 {
    (result.total_gas_burnt.as_gas() / 100_000_000_000) as f64 / 10.0
}
