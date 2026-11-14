//! A pretend world for pb-risk's reads: canned NEAR views (shaped as INTERFACES.md 4 and `contracts/pool`'s views
//! return them), Hyperliquid testnet, and the four exchanges, whose candles follow a fixed pseudo-random walk.
//! The clock moves 150 ms per call, as a run on OutLayer roughly does.
#![allow(dead_code)]
use pb_risk::read::{Net, Reply};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// 7 Nov 2026, 11:00:30 UTC.
pub const T0_MS: u64 = 1_794_049_230_000;
pub const HEIGHT: u64 = 276_621_922;
pub const ACCOUNT: &str = "alice.pbf.testnet";
pub const MUSDC: &str = "musdc.pbf-ops.testnet";
pub const MNBTC: &str = "mnbtc.pbf-ops.testnet";
/// Test ETH on NEAR, 18 decimals: the engine's `ETH.b` (INTERFACES.md 51).
pub const METH: &str = "meth.pbf-ops.testnet";
/// The pretend Hyperliquid's mark for ETH (its `metaAndAssetCtxs` answer below).
pub const ETH_MARK: f64 = 2_257.4;
const HOUR_MS: u64 = 3_600_000;
const MINUTE_MS: u64 = 60_000;

/// What the world holds.
#[derive(Clone, Debug)]
pub struct World {
    /// None: the account doesn't exist.
    pub account: Option<String>,
    pub pool_deployed: bool,
    pub drill_bp: Option<u64>,
    /// The drill as deployed before Phase 5, without `get_ratio_for` (INTERFACES.md 21).
    pub drill_old: bool,
    /// This account's own drill ratio (`set_ratio_for`); None: the shared one.
    pub drill_own_bp: Option<u64>,
    /// Other client accounts of the factory that hold exactly what this one does (the book stress test).
    pub copies: Vec<&'static str>,
    /// mUSDC and mNBTC, in token units.
    pub usdc: u128,
    pub nbtc: u128,
    /// The pool's debt for the account (micro-USDC), and the pool's capital and loans.
    pub debt: u128,
    pub capital: u128,
    pub loans: u128,
    pub counter: u64,
    pub prev_state: Option<&'static str>,
    pub coin_statuses: Value,
    pub hourly: Value,
    /// Which exchanges answer.
    pub down: Vec<&'static str>,
    /// A Hyperliquid account: its address, and a BTC position (size, entry) on top of `hl_cash` of USDC.
    pub hl: Option<(&'static str, f64, f64)>,
    pub hl_cash: f64,
    /// Its `userAbstraction`: "default" keeps the USDC in perps, "unifiedAccount" in spot (research/hyperliquid.md).
    pub hl_mode: &'static str,
    /// Phase 3 and 4 fields of `get_state`, added only when set, so the older worlds read as before: the margin-call
    /// record with `below`, pending entries, and resting orders on Hyperliquid.
    pub margin_call: Option<Value>,
    pub pending: Option<Value>,
    pub hl_orders: Value,
    /// `userNonFundingLedgerUpdates` for the Hyperliquid address.
    pub ledger: Value,
    /// Phase 6 (INTERFACES.md 24 and 25), added only when set, so the older worlds read as before. Our copy of Rhea:
    /// with it, the account's config names it as its only lender, with mNBTC as collateral, and the contract answers
    /// `get_account`, `get_assets` and `get_token_pyth_info` with these.
    pub rhea: Option<pb_risk::inputs::RheaReads>,
    /// `get_state().permission`.
    pub permission: Option<Value>,
    /// The pool's `get_params().funding`.
    pub funding: Option<Value>,
    /// Aave's test market on Base Sepolia (INTERFACES.md 24 and 33), as the account's Ethereum address stands
    /// there. With it, the account's config names Aave, and the chain's RPC answers the engine's calls. The
    /// address is the account's Hyperliquid address (`hl`).
    pub aave: Option<Aave>,
    /// `get_state().evm`: the account's own nonce counter and what it signed.
    pub evm: Option<Value>,
    /// `get_state().hl.open_sends` (INTERFACES.md 50.2), added only when set: an account made before 14 Nov
    /// doesn't show it.
    pub open_sends: Option<Value>,
    /// Hyperliquid answers `userNonFundingLedgerUpdates` with HTTP 500.
    pub ledger_down: bool,
    /// Test ETH on NEAR, in wei (INTERFACES.md 51). With it, even 0, the account's config lists ETH as the factory's
    /// does since 13 Nov, and our copy of Rhea, when the config names it, takes ETH as collateral after mNBTC.
    /// None: the config of before, so the older worlds read as before.
    pub eth: Option<u128>,
    /// The coin of the Hyperliquid position in `hl`: "BTC", or "ETH" at the pretend mark of $2,257.40.
    pub hl_coin: &'static str,
}

/// What Base Sepolia holds for the account's address, and Aave's terms there.
#[derive(Clone, Debug)]
pub struct Aave {
    /// WBTC posted at Aave, and WBTC at the address, in satoshis.
    pub posted: u128,
    pub spare: u128,
    /// Wrapped ether posted at Aave, and at the address, in wei.
    pub weth_posted: u128,
    pub weth_spare: u128,
    /// Whether WBTC's supply cap is reached, as it was on 11 Nov (175 of 175). Otherwise 100 of 175 are supplied.
    pub wbtc_full: bool,
    /// Aave's oracle price for wrapped ether, in whole dollars.
    pub weth_usd: u128,
    /// USDC owed to Aave, and USDC at the address, in micro-USDC.
    pub debt: u128,
    pub cash: u128,
    /// Aave's oracle price for WBTC, in whole dollars.
    pub wbtc_usd: u128,
    /// USDC's borrow and deposit rates in bp a year, and the USDC Aave has free (micro-USDC).
    pub rate_bp: u32,
    pub supply_bp: u32,
    pub free: u128,
    /// The chain's count of the address's transactions (`eth_getTransactionCount`).
    pub nonce: u64,
    /// How many requests the public RPC rate-limits (HTTP 429) before it answers.
    pub limited: u32,
    /// Whether the RPC answers a JSON-RPC batch as one. Some endpoints refuse them.
    pub batches: bool,
}

/// The pretend Base Sepolia's latest block.
pub const EVM_BLOCK: u64 = 57_472_001;

pub const AAVE_POOL: &str = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
/// The test market's WBTC and USDC, in lower case (research/aave.md).
pub const WBTC: &str = "0x54114591963cf60ef3aa63befd6ec263d98145a4";
pub const EVM_USDC: &str = "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f";
pub const WETH: &str = "0x4200000000000000000000000000000000000006";
pub const BASE_SEPOLIA_RPC: &str = "https://sepolia.base.org";

impl Aave {
    /// The test market as recorded on 10 and 11 Nov (pb-read's `fixtures/base_sepolia`): USDC at 0.74% to borrow
    /// and 0.09% to deposit, $44.7M of it free; WBTC lent against to 81.5% and liquidated at 83%; wrapped ether to
    /// 83.5% and 85%, with room under its cap. WBTC at $76,000 and ether at $2,240, WBTC's pool not full, and
    /// nothing of the account's there yet.
    pub fn market() -> Aave {
        Aave {
            posted: 0,
            spare: 0,
            weth_posted: 0,
            weth_spare: 0,
            wbtc_full: false,
            weth_usd: 2_240,
            debt: 0,
            cash: 0,
            wbtc_usd: 76_000,
            rate_bp: 74,
            supply_bp: 9,
            free: 44_744_942_212_774,
            nonce: 0,
            limited: 0,
            batches: true,
        }
    }

    /// `lenders.aave` of the account's config (INTERFACES.md 24, with section 33's fee ceiling).
    pub fn config() -> Value {
        json!({"chain_id": 84532, "pool": AAVE_POOL,
            "usdc": {"symbol": "USDC", "address": "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", "decimals": 6},
            "collateral": [{"symbol": "WBTC", "address": "0x54114591963CF60EF3aA63bEfD6eC263D98145a4", "decimals": 8},
                           {"symbol": "WETH", "address": "0x4200000000000000000000000000000000000006", "decimals": 18}],
            "max_fee_per_gas": "1000000000"})
    }

    /// One recorded answer of the test market, by the recorder's name: `aave_position` (10 Nov), or `aave_caps`
    /// (11 Nov) for the caps, what is supplied, and wrapped ether's settings.
    fn recorded(call: &str) -> String {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../pb-read/tests/fixtures/base_sepolia");
        for file in ["aave_position", "aave_caps"] {
            let rec: Value = serde_json::from_str(&std::fs::read_to_string(format!("{dir}/{file}.json")).unwrap()).unwrap();
            if let Some(hex) = rec["calls"][call]["reply"]["result"].as_str() {
                return hex.to_string();
            }
        }
        panic!("no recorded answer named {call}")
    }

    /// The chain's answer to the call the engine names `name` (`AaveReads::calls`), in Aave's own layouts
    /// (`IPool.sol` and `IPoolDataProvider.sol` in `aave-dao/aave-v3-origin`; the recorded answers have them).
    fn answer(&self, name: &str) -> String {
        const MAX: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        let words = |w: &[u128]| format!("0x{}", w.iter().map(|x| format!("{x:064x}")).collect::<String>());
        // The recorded answer with some of its words written over.
        let over = |call: &str, changes: &[(usize, u128)]| {
            let hex = Self::recorded(call);
            let mut w: Vec<String> = (0..(hex.len() - 2) / 64).map(|i| hex[2 + 64 * i..66 + 64 * i].to_string()).collect();
            for (i, x) in changes {
                w[*i] = format!("{x:064x}");
            }
            format!("0x{}", w.concat())
        };
        let ray = |bp: u32| u128::from(bp) * 100_000_000_000_000_000_000_000;
        match name {
            "reserve" => over("getReserveData_usdc", &[(5, ray(self.supply_bp)), (6, ray(self.rate_bp))]),
            "free" => words(&[self.free]),
            "account" => {
                // Dollars with 8 decimals: each token at the oracle's price, USDC at $1. The threshold and the LTV
                // are the posted tokens', weighted by value (WBTC 83% and 81.5%, wrapped ether 85% and 83.5%),
                // and the health factor is scaled by 1e18.
                let (btc, eth) = (self.posted * self.wbtc_usd, self.weth_posted * self.weth_usd / 10_000_000_000);
                let collateral = btc + eth;
                let debt = self.debt * 100;
                let weighted = |b: u128, e: u128| (btc * b + eth * e).checked_div(collateral).unwrap_or(0);
                let (threshold, ltv) = (weighted(8_300, 8_500), weighted(8_150, 8_350));
                let room = (collateral * ltv / 10_000).saturating_sub(debt);
                let head = words(&[collateral, debt, room, threshold, ltv]);
                if debt == 0 {
                    format!("{head}{MAX}")
                } else {
                    let hf = collateral * threshold / 10_000 * 1_000_000_000_000 / debt * 1_000_000;
                    format!("{head}{hf:064x}")
                }
            }
            "debt" => words(&[0, 0, self.debt, 0, self.debt, 0, 0, 0, 0]),
            "nonce" => format!("0x{:x}", self.nonce),
            _ => match name.split_once(':') {
                Some(("config", WBTC)) => Self::recorded("getReserveConfigurationData_wbtc"),
                Some(("price", WBTC)) => words(&[self.wbtc_usd * 100_000_000]),
                Some(("posted", WBTC)) => words(&[self.posted, 0, 0, 0, 0, 0, 0, 0, u128::from(self.posted > 0)]),
                Some(("balance", WBTC)) => words(&[self.spare]),
                Some(("caps", WBTC)) => Self::recorded("getReserveCaps_wbtc"),
                Some(("supplied", WBTC)) if self.wbtc_full => Self::recorded("getATokenTotalSupply_wbtc"),
                Some(("supplied", WBTC)) => words(&[10_000_000_000]),
                Some(("config", WETH)) => Self::recorded("getReserveConfigurationData_weth"),
                Some(("price", WETH)) => words(&[self.weth_usd * 100_000_000]),
                Some(("posted", WETH)) => {
                    words(&[self.weth_posted, 0, 0, 0, 0, 0, 0, 0, u128::from(self.weth_posted > 0)])
                }
                Some(("balance", WETH)) => words(&[self.weth_spare]),
                Some(("caps", WETH)) => Self::recorded("getReserveCaps_weth"),
                Some(("supplied", WETH)) => Self::recorded("getATokenTotalSupply_weth"),
                Some(("balance", EVM_USDC)) => words(&[self.cash]),
                _ => panic!("the pretend chain has no answer named {name}"),
            },
        }
    }
}

impl World {
    /// A new account, nothing deposited, in a pool with $200k and nothing lent.
    pub fn fresh() -> World {
        World {
            account: Some(ACCOUNT.into()),
            pool_deployed: true,
            drill_bp: Some(10_000),
            drill_old: false,
            drill_own_bp: None,
            copies: Vec::new(),
            usdc: 0,
            nbtc: 0,
            debt: 0,
            capital: 200_000_000_000,
            loans: 0,
            counter: 0,
            prev_state: None,
            coin_statuses: testnet_statuses(),
            hourly: json!([]),
            down: Vec::new(),
            hl: None,
            hl_cash: 0.0,
            hl_mode: "default",
            margin_call: None,
            pending: None,
            hl_orders: json!([]),
            ledger: json!([]),
            rhea: None,
            permission: None,
            funding: None,
            aave: None,
            evm: None,
            open_sends: None,
            ledger_down: false,
            eth: None,
            hl_coin: "BTC",
        }
    }

    /// $5,000 of mUSDC and 0.3 mNBTC deposited, no loan, one verdict so far.
    pub fn deposits() -> World {
        World {
            usdc: 5_000_000_000,
            nbtc: 30_000_000,
            counter: 1,
            prev_state: Some("HEALTHY"),
            hourly: json!([{"hour": T0_MS / HOUR_MS - 1, "hr_bp_min": 0, "exp_bp_max": 8193}]),
            ..World::fresh()
        }
    }

    /// The deposits, after a $13,000 loan that the client took out of the account (with a little interest since),
    /// at counter 2.
    pub fn loan() -> World {
        World {
            debt: 13_000_012_345,
            loans: 13_000_012_345,
            counter: 2,
            hourly: json!([{"hour": T0_MS / HOUR_MS - 2, "hr_bp_min": 0, "exp_bp_max": 8193},
                           {"hour": T0_MS / HOUR_MS - 1, "hr_bp_min": 0, "exp_bp_max": 18300}]),
            ..World::deposits()
        }
    }

    /// The testnet demo's hedged carry (research/day1.md, check 12): $25k of nBTC, a $25k BTC short and $9,500 of
    /// margin on Hyperliquid, and a $24,000 Standard loan drawn and taken out, at counter 3.
    pub fn hedged() -> World {
        let q = 25_000.0 / 76_000.0;
        World {
            usdc: 0,
            nbtc: (q * 1e8_f64).round() as u128,
            debt: 24_000_004_567,
            loans: 24_000_004_567,
            counter: 3,
            hl: Some(("0x00000000000000000000000000000000000000aa", -q, 76_000.0)),
            hl_cash: 9_500.0,
            hourly: json!([{"hour": T0_MS / HOUR_MS - 1, "hr_bp_min": 10_000, "exp_bp_max": 47_600}]),
            ..World::deposits()
        }
    }
}

impl World {
    /// The testnet demo book (PLAN.md 2, `phase3_hedge_small.json`): 0.015 nBTC, a 0.015 BTC short entered at 75,787
    /// with 428.60 USDC of margin left after Hyperliquid's 1 USDC fee, 10 mUSDC on NEAR, and the $1,096.81 loan
    /// taken out, at counter 3. `drill_bp` is the nBTC/BTC ratio the drill has set.
    pub fn drill(drill_bp: u64) -> World {
        World {
            usdc: 10_000_000,
            nbtc: 1_500_000,
            debt: 1_096_805_083,
            loans: 1_096_805_083,
            capital: 10_000_000_000_000,
            counter: 3,
            drill_bp: Some(drill_bp),
            hl: Some((
                "0x00000000000000000000000000000000000000aa",
                -0.015,
                75_787.0,
            )),
            hl_cash: 428.602143,
            hourly: json!([{"hour": T0_MS / HOUR_MS - 1, "hr_bp_min": 9_900, "exp_bp_max": 47_600}]),
            margin_call: Some(json!({"since": "0", "below": false, "intervals": []})),
            pending: Some(json!([])),
            ..World::deposits()
        }
    }
}

/// On testnet the pool's list keeps the coins Hyperliquid testnet lacks, or prices wrongly, removed.
pub fn testnet_statuses() -> Value {
    let since = "1794000000000000000";
    Value::Array(
        ["ENA", "HYPE", "LINK", "LTC", "TRX", "UNI", "XRP", "ZEC"]
            .iter()
            .map(|c| json!([c, {"status": "removed", "since": since, "emergency": false}]))
            .collect(),
    )
}

pub struct MockNet {
    pub world: World,
    pub clock_ms: u64,
    pub calls: Vec<String>,
    /// Every request to Hyperliquid, in the order it was asked.
    pub hl_asked: Vec<Value>,
    /// Whether `get_all` and `post_all` overlap their requests as the WASI transport does: each group of 8 costs
    /// one call's time. Off, they take one call's time each, as a host that can't overlap them would.
    pub overlap: bool,
}

impl MockNet {
    pub fn new(world: World) -> MockNet {
        MockNet {
            world,
            clock_ms: T0_MS,
            calls: Vec::new(),
            hl_asked: Vec::new(),
            overlap: true,
        }
    }

    /// One batch: each request of a group of 8 starts at the group's start, as the WASI transport sends them.
    fn batch<T>(
        &mut self,
        items: &[T],
        mut one: impl FnMut(&mut MockNet, &T) -> Result<Reply, String>,
    ) -> Vec<Result<Reply, String>> {
        if !self.overlap {
            return items.iter().map(|x| one(self, x)).collect();
        }
        let mut out = Vec::new();
        for group in items.chunks(8) {
            let start = self.clock_ms;
            for x in group {
                self.clock_ms = start;
                out.push(one(self, x));
            }
            self.clock_ms = start + 150;
        }
        out
    }

    fn tick(&mut self, what: String) {
        self.clock_ms += 150;
        self.calls.push(what);
    }

    fn view_result(&self, account: &str, method: &str, args: &Value) -> Result<Value, Value> {
        let w = &self.world;
        let unknown = |a: &str| {
            json!({"name": "HANDLER_ERROR", "cause": {"name": "UNKNOWN_ACCOUNT", "info": {"requested_account_id": a}},
                   "code": -32000, "message": "Server error", "data": format!("account {a} does not exist while viewing")})
        };
        let no_code = |a: &str| {
            format!("wasm execution failed with error: CompilationError(CodeDoesNotExist {{ account_id: \"{a}\" }})")
        };
        let ns = |ms: u64| (ms * 1_000_000).to_string();
        match (account, method) {
            ("pool.pbf.testnet", _) if !w.pool_deployed => Err(json!({"legacy": no_code(account)})),
            ("pool.pbf.testnet", "get_pool") => Ok(json!({
                "cash": (w.capital - w.loans).to_string(), "loans": w.loans.to_string(), "capital": w.capital.to_string(),
                "utilisation_bp": (w.loans * 10_000 / w.capital) as u64,
                "rate_bp": {"preferred": 100, "standard": 200, "watch": 500},
                "interest_earned": "12345", "written_off": "0", "funded": w.capital.to_string(), "defunded": "0",
                "paused": false, "lent_24h": w.loans.to_string(), "daily_budget": (w.capital / 10).to_string(),
                "daily_budget_bp": 1000, "pending_budget": null,
                "wrappers": {"ETH": {"amount": "0", "cap": "30000000000"}, "USDT": {"amount": "0", "cap": "60000000000"},
                             "nBTC": {"amount": (w.loans * 3 / 10).to_string(), "cap": "60000000000"}},
                "hyperliquid": {"amount": "0", "cap": "100000000000"},
                "book": {"ETH": {"amount": "0", "cap": "12000000000000"}, "USDT": {"amount": "0", "cap": "24000000000000"},
                         "nBTC": {"amount": if w.debt > 0 { "22800000000" } else { "0" }, "cap": "12000000000000"},
                         "wNEAR": {"amount": "0", "cap": "6000000000000"}}})),
            ("pool.pbf.testnet", "get_params") => {
                let mut params = json!({
                "operator": "pbf-ops.testnet", "factory": "pbf.testnet", "token": MUSDC,
                "periods": {"new_account_ns": "604800000000000", "upgrade_ns": "2592000000000000",
                            "budget_delay_ns": "172800000000000", "window_ns": "86400000000000"},
                "rates": {"kink_bp": 8000, "at_kink_bp": 600, "at_full_bp": 5000,
                          "spread_bp": {"preferred": 100, "standard": 200, "watch": 500}},
                "caps": {"max_utilisation_bp": 9000, "client_share_bp": 2500, "new_account_limit": "25000000000"},
                "daily_budget_bp": 1000, "pending_budget": null});
                if let Some(f) = &w.funding {
                    params["funding"] = f.clone();
                }
                Ok(params)
            }
            ("pool.pbf.testnet", "coin_statuses") => Ok(w.coin_statuses.clone()),
            ("pbf.testnet", "list_accounts") => Ok(Value::Array(
                w.account
                    .iter()
                    .map(String::as_str)
                    .chain(w.copies.iter().copied())
                    .map(|a| json!({"account_id": a, "owner": "alice.testnet", "created_at": ns(T0_MS - 3 * HOUR_MS)}))
                    .collect(),
            )),
            ("pbf.testnet", "accounts_count") => {
                Ok(json!(w.account.iter().count() + w.copies.len()))
            }
            ("pool.pbf.testnet", "get_borrower") => {
                let mine = args["account_id"] == json!(ACCOUNT)
                    || w.copies.iter().any(|c| args["account_id"] == json!(c));
                if !mine || w.account.is_none() {
                    return Ok(Value::Null);
                }
                Ok(
                    json!({"created_at": ns(T0_MS - 3 * HOUR_MS), "first_week_until": ns(T0_MS + 165 * HOUR_MS),
                    "debt": w.debt.to_string(), "tier": "STANDARD",
                    "history_tier": if w.debt > 0 { json!("STANDARD") } else { Value::Null },
                    "last_upgrade_at": null, "kyb_entity": null, "tier_override": null, "blocked": false,
                    "hl_address": null, "steps_24h": "0",
                    "shares_bp": if w.debt > 0 { json!({"nBTC": 6107}) } else { json!({}) },
                    "hold": if w.debt > 0 { json!({"nBTC": "22800000000"}) } else { json!({}) },
                    "hl_eq": "0"}),
                )
            }
            ("drill.pbf-ops.testnet", "get_ratio") => match w.drill_bp {
                Some(bp) => Ok(json!({"bp": bp, "set_at": ns(T0_MS - 24 * HOUR_MS)})),
                None => Err(unknown(account)),
            },
            // As a node answers a view the deployed code lacks (read on testnet, 9 Nov).
            ("drill.pbf-ops.testnet", "get_ratio_for") if w.drill_old && w.drill_bp.is_some() => Err(
                json!({"legacy": "wasm execution failed with error: MethodResolveError(MethodNotFound)"}),
            ),
            ("drill.pbf-ops.testnet", "get_ratio_for") => match w.drill_bp {
                Some(bp) => {
                    let own = w.drill_own_bp.filter(|_| args["account_id"] == json!(ACCOUNT));
                    Ok(json!({"bp": own.unwrap_or(bp), "set_at": ns(T0_MS - 24 * HOUR_MS)}))
                }
                None => Err(unknown(account)),
            },
            (MUSDC | MNBTC | METH, "ft_balance_of") => {
                let units = match account {
                    MUSDC => w.usdc,
                    MNBTC => w.nbtc,
                    _ => w.eth.unwrap_or(0),
                };
                let holder = args["account_id"] == json!(ACCOUNT)
                    || w.copies.iter().any(|c| args["account_id"] == json!(c));
                Ok(Value::String(if holder {
                    units.to_string()
                } else {
                    "0".into()
                }))
            }
            // Our copy of Rhea: its three views, as burrowland names them.
            (a, m) if w.rhea.as_ref().is_some_and(|r| r.contract_id == a) => {
                let r = w.rhea.as_ref().expect("checked above");
                match m {
                    "get_account" if args["account_id"] == json!(ACCOUNT) => Ok(r.account.clone()),
                    "get_account" => Ok(Value::Null),
                    "get_assets" => Ok(r.assets.clone()),
                    "get_token_pyth_info" => {
                        let id = args["token_id"].as_str().unwrap_or("");
                        Ok(r.prices.get(id).cloned().unwrap_or(Value::Null))
                    }
                    _ => Err(json!({"legacy": "wasm execution failed with error: MethodResolveError(MethodNotFound)"})),
                }
            }
            (a, _) if Some(a) != w.account.as_deref() && !w.copies.contains(&a) => {
                Err(unknown(a))
            }
            (_, "get_state") => {
                let mut st = json!({
                "owner": "alice.testnet", "counter": w.counter, "blocked": false,
                "loan": {"principal": if w.debt > 0 { "13000000000" } else { "0" }},
                "verdict": w.prev_state.map(|s| json!({"intent": {"check": {}}, "received_block": HEIGHT - 50,
                    "verdict": {"ok": true, "state": s, "nonce": w.counter - 1}})),
                "margin_call": {"since": "0", "intervals": []},
                "deleverage": {"first_at": "0", "confirmed_plan": null},
                "hourly": w.hourly, "pending": [], "hl": {"path": "hyperliquid-1", "address": w.hl.map(|h| h.0)}});
                if let Some(mc) = &w.margin_call {
                    st["margin_call"] = mc.clone();
                }
                if let Some(p) = &w.pending {
                    st["pending"] = p.clone();
                }
                if let Some(p) = &w.permission {
                    st["permission"] = p.clone();
                    // An account made since 12 Nov also says when its permission last changed (INTERFACES.md
                    // 40.1). The engine reads past it.
                    st["permission_blk"] = json!(HEIGHT - 500);
                }
                if let Some(e) = &w.evm {
                    st["evm"] = e.clone();
                }
                if let Some(o) = &w.open_sends {
                    // As an account made since 14 Nov shows them, next to the pause's floor.
                    st["hl"]["open_sends"] = o.clone();
                    st["hl"]["send_floor_until_ms"] = json!("0");
                }
                Ok(st)
            }
            (_, "get_config") => {
                let mut conf = json!({
                "tokens": [{"id": MUSDC, "symbol": "USDC", "decimals": 6}, {"id": MNBTC, "symbol": "nBTC", "decimals": 8}],
                "pool_id": "pool.pbf.testnet", "mpc_id": "v1.signer-prod.testnet", "outlayer_id": "outlayer.testnet",
                "risk": {"project_id": "pbf-keeper.testnet/pb-risk", "version_key": "<sha256 of the wasm>"},
                "hl_chain": "Testnet", "signature_chain_id": "0x66eee", "usdc_token": MUSDC,
                "params_hash": "3d362b434adaad0e0c909605bd792232acf964b9143a95ccb2541a0f65c4c263",
                "model": "B-0.2", "drill_id": "drill.pbf-ops.testnet"});
                if w.eth.is_some() {
                    conf["tokens"].as_array_mut().unwrap().push(json!({"id": METH, "symbol": "ETH", "decimals": 18}));
                }
                if let Some(r) = &w.rhea {
                    let collateral = if w.eth.is_some() { json!([MNBTC, METH]) } else { json!([MNBTC]) };
                    conf["lenders"] = json!({"rhea": {"contract_id": r.contract_id, "collateral": collateral}});
                }
                if w.aave.is_some() {
                    conf["lenders"]["aave"] = Aave::config();
                }
                Ok(conf)
            }
            _ => Err(
                json!({"legacy": "wasm execution failed with error: MethodResolveError(MethodNotFound)"}),
            ),
        }
    }

    fn near(&mut self, body: &str) -> Value {
        let req: Value = serde_json::from_str(body).expect("RPC body is JSON");
        let p = &req["params"];
        if req["method"] == "block" {
            self.tick("near block".into());
            let ts = (T0_MS - 1_500) * 1_000_000;
            return json!({"jsonrpc": "2.0", "id": "pb", "result": {"header": {"height": HEIGHT, "timestamp": ts,
                "timestamp_nanosec": ts.to_string(), "hash": "5Pwxp3pmzWVEo9GugqnywbRotsLtG4n3rXZbUPwXJijR"}}});
        }
        assert_eq!(
            p["block_id"],
            json!(HEIGHT),
            "every view reads at the final block"
        );
        let account = p["account_id"].as_str().unwrap().to_string();
        let method = p["method_name"].as_str().unwrap().to_string();
        let args = decode_args(p["args_base64"].as_str().unwrap());
        self.tick(format!("near {account}.{method}"));
        match self.view_result(&account, &method, &args) {
            Ok(v) => {
                let bytes: Vec<Value> = v.to_string().bytes().map(Value::from).collect();
                json!({"jsonrpc": "2.0", "id": "pb", "result": {"result": bytes, "logs": [], "block_height": HEIGHT}})
            }
            Err(e) if e.get("legacy").is_some() => {
                json!({"jsonrpc": "2.0", "id": "pb", "result": {"error": e["legacy"], "logs": [], "block_height": HEIGHT}})
            }
            Err(e) => json!({"jsonrpc": "2.0", "id": "pb", "error": e}),
        }
    }
}

impl MockNet {
    /// Base Sepolia's RPC: `eth_blockNumber`, and the engine's `eth_call`s and its `eth_getTransactionCount`, alone
    /// or in one JSON-RPC batch, answered from the world's [`Aave`] whatever block they name. Any other call is
    /// refused as a node refuses one that reverts.
    fn evm(&mut self, body: &str) -> Reply {
        let req: Value = serde_json::from_str(body).expect("RPC body is JSON");
        self.tick(match req.as_array() {
            Some(list) => format!("evm batch of {}", list.len()),
            None => format!("evm {}", req["method"].as_str().unwrap_or("?")),
        });
        let aave = self.world.aave.as_mut().expect("Ethereum is only asked when the config names Aave");
        if aave.limited > 0 {
            aave.limited -= 1;
            return Reply { status: 429, body: b"rate limited".to_vec() };
        }
        let conf = pb_risk::near::config(&json!({"tokens": [], "pool_id": "p", "lenders": {"aave": Aave::config()}}))
            .expect("the pretend config parses");
        let chain = pb_read::evm::chain(84532).expect("Base Sepolia is in the engine's table");
        let address = self.world.hl.map(|h| h.0);
        // Each call by what it asks, whatever its id and its block.
        let asked = |request: &Value| format!("{} {}", request["method"], request["params"][0]);
        let asks: Vec<(String, String)> = pb_risk::read::aave_asks(conf.lenders.aave.as_ref().unwrap(), chain, address)
            .into_iter()
            .map(|(name, ask)| (name, asked(&serde_json::from_str(&ask).unwrap())))
            .collect();
        let aave = self.world.aave.as_ref().unwrap();
        let one = |request: &Value| {
            let id = request["id"].clone();
            if request["method"] == "eth_blockNumber" {
                return json!({"jsonrpc": "2.0", "id": id, "result": format!("0x{EVM_BLOCK:x}")});
            }
            match asks.iter().find(|(_, ask)| *ask == asked(request)) {
                Some((name, _)) => json!({"jsonrpc": "2.0", "id": id, "result": aave.answer(name)}),
                None => json!({"jsonrpc": "2.0", "id": id, "error": {"code": 3, "message": "execution reverted"}}),
            }
        };
        let v = match req.as_array() {
            Some(_) if !aave.batches => {
                json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32600, "message": "batch requests are not supported"}})
            }
            Some(list) => Value::Array(list.iter().map(one).collect()),
            None => one(&req),
        };
        Reply { status: 200, body: v.to_string().into_bytes() }
    }
}

fn decode_args(b64: &str) -> Value {
    const ABC: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bits = 0u32;
    let mut n = 0;
    let mut out = Vec::new();
    for c in b64.chars().filter(|&c| c != '=') {
        bits = (bits << 6) | ABC.find(c).unwrap() as u32;
        n += 6;
        if n >= 8 {
            n -= 8;
            out.push((bits >> n) as u8);
            bits &= (1 << n) - 1;
        }
    }
    serde_json::from_slice(&out).unwrap()
}

/// BTC's price at a time: a fixed pseudo-random walk around $76k with about 45% annual volatility.
pub fn btc_price(ms: u64) -> f64 {
    let hours = (ms / HOUR_MS) as i64 - (T0_MS / HOUR_MS) as i64;
    let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut x = 0.0;
    // Walk back from now hour by hour, so the price now is fixed whatever the window.
    for _ in hours..0 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let u = (seed >> 11) as f64 / (1u64 << 53) as f64 - 0.5;
        x += u * 0.0166;
    }
    let minute = ((ms % HOUR_MS) / MINUTE_MS) as f64;
    76_000.0 * (1.0 - x) * (1.0 + 0.0004 * (minute / 7.0).sin())
}

/// Ether's price at a time: bitcoin's walk, around $2,247, where the pretend Hyperliquid's oracle has it.
pub fn eth_price(ms: u64) -> f64 {
    btc_price(ms) / 76_000.0 * 2_247.0
}

fn fmt(x: f64) -> String {
    format!("{x:.2}")
}

impl MockNet {
    fn exchange(&mut self, url: &str) -> Option<Value> {
        let src = ["binance", "okx", "bybit", "coinbase"]
            .into_iter()
            .find(|s| url.contains(s))?;
        // Bitcoin, and ether for an account that holds wrapped ether (INTERFACES.md 33).
        let coin = ["BTC", "ETH"].into_iter().find(|c| url.contains(c))?;
        if self.world.down.contains(&src) {
            return None;
        }
        let price_at = |ms: u64| if coin == "BTC" { btc_price(ms) } else { eth_price(ms) };
        // Each exchange quotes a little differently.
        let skew = match src {
            "binance" => 1.0,
            "okx" => 0.99995,
            "bybit" => 1.00004,
            _ => 0.9987, // Coinbase quotes USD, not USDT
        };
        let now = self.clock_ms;
        let candles = |len: u64, count: u64| -> Vec<(u64, f64)> {
            let end = now / len * len;
            (0..count)
                .rev()
                .map(|i| end - i * len)
                .map(|t| (t, price_at(t + len - 1) * skew))
                .collect()
        };
        let mid = price_at(now) * skew;
        let v = if url.contains("ticker") {
            match src {
                "binance" => {
                    json!({"symbol": format!("{coin}USDT"), "bidPrice": fmt(mid - 0.01), "askPrice": fmt(mid), "bidQty": "1", "askQty": "1"})
                }
                "okx" => {
                    json!({"code": "0", "data": [{"instId": format!("{coin}-USDT"), "bidPx": fmt(mid - 0.1), "askPx": fmt(mid), "ts": now.to_string()}], "msg": ""})
                }
                "bybit" => {
                    json!({"retCode": 0, "retMsg": "OK", "result": {"category": "spot", "list": [{"symbol": format!("{coin}USDT"), "bid1Price": fmt(mid - 0.1), "ask1Price": fmt(mid)}]}, "time": now})
                }
                _ => {
                    json!({"ask": fmt(mid), "bid": fmt(mid - 0.01), "price": fmt(mid), "time": "2026-11-07T11:00:31Z"})
                }
            }
        } else {
            let hour = url.contains("1h") || url.contains("1H") || url.contains("interval=60");
            let (len, count) = if hour {
                (HOUR_MS, 722)
            } else {
                (MINUTE_MS, 62)
            };
            let mut rows = candles(len, count);
            if src == "okx" && hour {
                // OKX pages 300 at a time, newest first, earlier than `after`.
                let after: u64 = url
                    .split("after=")
                    .nth(1)
                    .map_or(u64::MAX, |a| a.parse().unwrap());
                rows.retain(|r| r.0 < after);
                let skip = rows.len().saturating_sub(300);
                rows = rows[skip..].to_vec();
            }
            match src {
                "binance" => Value::Array(
                    rows.iter()
                        .map(|&(t, c)| {
                            json!([
                                t,
                                fmt(c),
                                fmt(c),
                                fmt(c),
                                fmt(c),
                                "1.0",
                                t + len - 1,
                                "1",
                                1,
                                "1",
                                "1",
                                "0"
                            ])
                        })
                        .collect(),
                ),
                "okx" => {
                    json!({"code": "0", "msg": "", "data": rows.iter().rev().map(|&(t, c)| json!([t.to_string(), fmt(c), fmt(c), fmt(c), fmt(c), "1", "1", "1", "1"])).collect::<Vec<_>>()})
                }
                _ => {
                    json!({"retCode": 0, "retMsg": "OK", "result": {"category": "spot", "symbol": format!("{coin}USDT"),
                    "list": rows.iter().rev().map(|&(t, c)| json!([t.to_string(), fmt(c), fmt(c), fmt(c), fmt(c), "1", "1"])).collect::<Vec<_>>()}})
                }
            }
        };
        Some(v)
    }

    fn hyperliquid(&mut self, body: &str) -> Value {
        let req: Value = serde_json::from_str(body).unwrap();
        self.tick(format!("hyperliquid {}", req["type"]));
        self.hl_asked.push(req.clone());
        let px = btc_price(self.clock_ms);
        match req["type"].as_str().unwrap() {
            "metaAndAssetCtxs" => json!([
                {"universe": [
                    {"szDecimals": 2, "name": "SOL", "maxLeverage": 10, "marginTableId": 10},
                    {"szDecimals": 5, "name": "BTC", "maxLeverage": 40, "marginTableId": 54},
                    {"szDecimals": 4, "name": "ETH", "maxLeverage": 25, "marginTableId": 53},
                    {"szDecimals": 2, "name": "HYPE", "maxLeverage": 10, "marginTableId": 10, "onlyIsolated": true}],
                 "marginTables": [[53, {"description": "tiered 25x", "marginTiers": [{"lowerBound": "0.0", "maxLeverage": 25},
                        {"lowerBound": "20000.0", "maxLeverage": 10}, {"lowerBound": "50000.0", "maxLeverage": 5}]}],
                    [54, {"description": "tiered 40x", "marginTiers": [{"lowerBound": "0.0", "maxLeverage": 40},
                        {"lowerBound": "10000.0", "maxLeverage": 25}, {"lowerBound": "50000.0", "maxLeverage": 10}]}]],
                 "collateralToken": 0},
                [{"funding": "0.0000125", "oraclePx": "90.0", "markPx": "90.02"},
                 {"funding": "0.0000041", "oraclePx": fmt(px * 1.00002), "markPx": fmt(px * 1.00144)},
                 {"funding": "0.00001", "oraclePx": "2247.19", "markPx": "2257.4"},
                 {"funding": "0.0", "oraclePx": "6232.85", "markPx": "78.392"}]]),
            "clearinghouseState" => {
                let (_, szi, entry) = self.world.hl.expect("an address was asked for");
                let mark: f64 = if self.world.hl_coin == "ETH" { ETH_MARK } else { fmt(px * 1.00144).parse().unwrap() };
                let pnl = szi * (mark - entry);
                // A unified account shows only the margin in use here (measured 8 Nov, research/hyperliquid.md).
                let value = if self.world.hl_mode == "unifiedAccount" {
                    szi.abs() * mark / 10.0
                } else {
                    self.world.hl_cash + pnl
                };
                json!({"marginSummary": {"accountValue": fmt(value), "totalNtlPos": fmt(szi.abs() * mark),
                        "totalRawUsd": fmt(value - szi * mark), "totalMarginUsed": "0"},
                    "crossMaintenanceMarginUsed": "0", "withdrawable": "0",
                    "assetPositions": [{"type": "oneWay", "position": {"coin": self.world.hl_coin, "szi": format!("{szi:.5}"),
                        "entryPx": fmt(entry), "unrealizedPnl": fmt(pnl), "leverage": {"type": "cross", "value": 10}}}],
                    "time": self.clock_ms})
            }
            "userAbstraction" => json!(self.world.hl_mode),
            "spotClearinghouseState" => {
                if self.world.hl_mode == "unifiedAccount" {
                    let (_, szi, entry) = self.world.hl.expect("an address was asked for");
                    let mark: f64 = if self.world.hl_coin == "ETH" { ETH_MARK } else { fmt(px * 1.00144).parse().unwrap() };
                    let total = self.world.hl_cash + szi * (mark - entry);
                    json!({"balances": [{"coin": "USDC", "token": 0, "total": fmt(total),
                        "hold": fmt(szi.abs() * mark / 10.0), "entryNtl": "0.0"}]})
                } else {
                    json!({"balances": []})
                }
            }
            "frontendOpenOrders" => self.world.hl_orders.clone(),
            "userNonFundingLedgerUpdates" => self.world.ledger.clone(),
            _ => Value::Null,
        }
    }
}

impl Net for MockNet {
    fn get(&mut self, url: &str) -> Result<Reply, String> {
        let answer = self.exchange(url);
        self.tick(format!("get {url}"));
        Ok(match answer {
            Some(v) => Reply {
                status: 200,
                body: v.to_string().into_bytes(),
            },
            None => Reply {
                status: 404,
                body: b"{\"error\":\"not found\"}".to_vec(),
            },
        })
    }

    fn post(&mut self, url: &str, body: &str) -> Result<Reply, String> {
        let v = if url.contains("fastnear") {
            self.near(body)
        } else if url.contains("hyperliquid") {
            let v = self.hyperliquid(body);
            if self.world.ledger_down && body.contains("userNonFundingLedgerUpdates") {
                return Ok(Reply {
                    status: 500,
                    body: b"{}".to_vec(),
                });
            }
            v
        } else if url == BASE_SEPOLIA_RPC && self.world.aave.is_some() {
            return Ok(self.evm(body));
        } else {
            return Err(format!("unexpected POST to {url}"));
        };
        Ok(Reply {
            status: 200,
            body: v.to_string().into_bytes(),
        })
    }

    fn now_ms(&mut self) -> u64 {
        self.clock_ms
    }

    fn get_all(&mut self, urls: &[String]) -> Vec<Result<Reply, String>> {
        self.batch(urls, |n, u| n.get(u))
    }

    fn post_all(&mut self, reqs: &[(String, String)]) -> Vec<Result<Reply, String>> {
        self.batch(reqs, |n, (u, b)| n.post(u, b))
    }
}

/// The request a test sends, as INTERFACES.md 6 writes it.
pub fn request(intent: &str, snapshot: bool) -> String {
    format!(
        r#"{{"mode":"preview","account":"{ACCOUNT}","intent":{intent},"network":"testnet","snapshot":{snapshot}}}"#
    )
}

/// Runs pb-risk against a world, returning the parsed answer.
pub fn run(world: World, intent: &str, snapshot: bool) -> (String, MockNet) {
    let mut net = MockNet::new(world);
    let out = pb_risk::run(&request(intent, snapshot), &mut net);
    (out, net)
}

/// Counts of calls by kind, for the report on calls per run.
pub fn call_counts(net: &MockNet) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    for c in &net.calls {
        let kind = c.split_whitespace().next().unwrap_or("").to_string();
        *out.entry(kind).or_insert(0) += 1;
    }
    out
}
