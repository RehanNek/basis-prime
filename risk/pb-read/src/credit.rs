//! The credit check (INTERFACES.md 18): its request, the reads, and the parsers for what it reads. It reads
//! mainnet (Hyperliquid's info API, Rhea through NEAR mainnet's RPC, 1Click's public dry quotes, the exchanges)
//! and our testnet pool's terms. It signs nothing and pays nothing anywhere.
//!
//! Every endpoint, view and field here was checked with a live read on 9 Nov (INTERFACES.md 18, "As built").
//! The lender reads of INTERFACES.md 27 (Aave's API and the dry quote for moving bitcoin to Ethereum) were checked
//! live on 10 Nov, and their answers are saved beside the others (`tests/fixtures/mainnet`).
use crate::hl;
use crate::inputs::{Block, CoinReads, HlReads, Ticker};
use crate::market;
use crate::near::is_evm_address;
use crate::read::{self, base, candle_url, parse_candles, parse_ticker, ticker_url, Net, Reply};
use crate::request::TESTNET;
use crate::util::{bp, f64_of, pow10, sha256_hex, u128_of, u64_of};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// Hyperliquid mainnet's info endpoint (Hyperliquid's API docs, "Info endpoint").
pub const HL_MAINNET_INFO: &str = "https://api.hyperliquid.xyz/info";
/// NEAR mainnet RPC, for Rhea's views.
pub const NEAR_MAINNET_RPC: &str = "https://free.rpc.fastnear.com";
/// Rhea Lending (Burrow) on mainnet (research/rhea.md).
pub const RHEA: &str = "contract.main.burrow.near";
/// 1Click's quote endpoint (its OpenAPI spec, `POST /v0/quote`). Called without a key.
pub const ONECLICK_QUOTE: &str = "https://1click.chaindefuser.com/v0/quote";
/// The NEAR account a dry quote names as recipient and refund address. A dry quote moves nothing and makes no
/// deposit address; day 1's dry quotes used the same account (research/scripts/day1_oneclick_dry.py).
pub const DRY_QUOTE_ACCOUNT: &str = "aurora";
/// How long a dry quote's deadline lies ahead.
pub const QUOTE_DEADLINE_MS: u64 = 10 * 60_000;

/// Aave's own API, a GraphQL endpoint (research/aave.md; research/scripts/aave_live.py reads it the same way).
pub const AAVE_API: &str = "https://api.v3.aave.com/graphql";
/// Aave v3's core market on Ethereum: its Pool, which the API's `markets(request: {chainIds: [1]})` lists as
/// `AaveV3Ethereum` (read 10 Nov), and the chain's id.
pub const AAVE_ETHEREUM_POOL: &str = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
pub const AAVE_ETHEREUM_CHAIN: u64 = 1;
/// USDC and WBTC on Ethereum, as that market's reserves name them (research/data/aave_live_2026-11-10.json).
pub const AAVE_USDC: &str = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
pub const AAVE_WBTC: &str = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
/// 1Click's asset id for WBTC on Ethereum, and its decimals, from 1Click's token list (`GET /v0/tokens`, read
/// 10 Nov; research/scripts/oneclick_routes.py takes them from the same list).
pub const ONECLICK_WBTC_ETH: &str =
    "nep141:eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near";
pub const WBTC_DECIMALS: u32 = 8;
/// The Ethereum address a dry quote to Ethereum names as recipient. A dry quote moves nothing; it is the address
/// research/scripts/oneclick_routes.py used for the same quotes.
pub const DRY_QUOTE_EVM: &str = "0xce4bd513b9457d3cfa29b804fba54b11193a2f4d";
/// The quote for moving bitcoin to Ethereum asks about the book's bitcoin, and at most this much of it: 1Click
/// quoted nothing at $500,000 (research/aave.md).
pub const MOVE_QUOTE_USD: f64 = 100_000.0;

/// The format of [`CreditInputs`].
pub const CREDIT_INPUTS_V: u32 = 1;
/// `spot` holds at most this many rows, one per token.
pub const MAX_SPOT: usize = 5;
/// A what-if `book` holds at most this many positions.
pub const MAX_BOOK_POSITIONS: usize = 20;
/// One run prices at most this many coins, BTC included: each costs 12 exchange calls (INTERFACES.md 18).
pub const MAX_COINS: usize = 6;
/// The reads stop starting new work once this much of the run has passed (a run may take 20 s).
pub const READ_BUDGET_MS: u64 = 13_000;
/// Amounts in a what-if book: at most $1 trillion each, in micro-USD.
pub const MAX_BOOK_MICRO: i128 = 1_000_000_000_000_000_000;

const HOUR_MS: u64 = 3_600_000;

/// A NEAR-side token of RISK_ENGINE.md 5.4, as it is on mainnet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MainnetToken {
    /// The pool's name (INTERFACES.md 2), which the request uses.
    pub name: &'static str,
    /// The engine's name.
    pub engine: &'static str,
    /// The token contract on NEAR mainnet; 1Click's asset id is `nep141:<id>`.
    pub id: &'static str,
    /// From the contract's `ft_metadata` (read 9 Nov).
    pub decimals: u32,
}

pub const MAINNET_TOKENS: [MainnetToken; 5] = [
    MainnetToken {
        name: "USDC",
        engine: "USDC",
        id: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        decimals: 6,
    },
    MainnetToken {
        name: "nBTC",
        engine: "nBTC",
        id: "nbtc.bridge.near",
        decimals: 8,
    },
    MainnetToken {
        name: "ETH",
        engine: "ETH.b",
        id: "eth.bridge.near",
        decimals: 18,
    },
    MainnetToken {
        name: "USDT",
        engine: "USDT",
        id: "usdt.tether-token.near",
        decimals: 6,
    },
    MainnetToken {
        name: "wNEAR",
        engine: "wNEAR",
        id: "wrap.near",
        decimals: 24,
    },
];

/// The mainnet token the request calls `name`.
pub fn token(name: &str) -> Option<&'static MainnetToken> {
    MAINNET_TOKENS.iter().find(|t| t.name == name)
}

/// The tokens whose π comes from a dry 1Click quote (3.3): the bridged ones, and USDT.
pub const QUOTED: [&str; 3] = ["nBTC", "ETH", "USDT"];

// ------------------------------------------------------------------------------------------------ request

/// A what-if Hyperliquid account: USDC margin and positions entered at the mark, in micro-USD.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WhatIf {
    pub usdc: String,
    pub positions: Vec<WhatIfPosition>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WhatIfPosition {
    pub coin: String,
    /// Negative for a short.
    pub usd: String,
}

/// One row of NEAR-side spot: a token by the pool's name and an amount in the mainnet token's units.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Spot {
    pub token: String,
    pub amount: String,
}

/// The request, checked and in one canonical form.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreditRequest {
    pub mode: String,
    pub network: String,
    pub hl_address: Option<String>,
    pub book: Option<WhatIf>,
    pub spot: Vec<Spot>,
}

/// Checks the request on stdin. Every refusal says what to fix. Returns the request and whether a snapshot is
/// wanted.
pub fn parse(raw: &str) -> Result<(CreditRequest, bool), String> {
    let v: Value = serde_json::from_str(raw).map_err(|e| format!("the input is not JSON: {e}"))?;
    let obj = v.as_object().ok_or("the input must be a JSON object")?;
    if obj.get("mode").and_then(Value::as_str) != Some("credit_check") {
        return Err("mode must be credit_check".into());
    }
    let network = obj.get("network").and_then(Value::as_str).unwrap_or("");
    if network != "mainnet" {
        return Err(format!(
            "network {network:?} is not served: the credit check reads mainnet"
        ));
    }
    let present = |k: &str| obj.get(k).is_some_and(|x| !x.is_null());
    let hl_address = match (present("hl_address"), present("book")) {
        (true, true) => return Err("give hl_address or book, not both".into()),
        (false, false) => return Err("give an hl_address or a what-if book".into()),
        (true, false) => {
            let a = obj["hl_address"]
                .as_str()
                .filter(|a| is_evm_address(a))
                .ok_or("hl_address must be 0x and 40 hex digits")?;
            Some(a.to_ascii_lowercase())
        }
        (false, true) => None,
    };
    let book = if present("book") {
        Some(parse_book(&obj["book"])?)
    } else {
        None
    };
    let spot = match obj.get("spot") {
        None | Some(Value::Null) => Vec::new(),
        Some(s) => parse_spot(s)?,
    };
    let snapshot = match obj.get("snapshot") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("snapshot must be true or false".into()),
    };
    Ok((
        CreditRequest {
            mode: "credit_check".into(),
            network: network.into(),
            hl_address,
            book,
            spot,
        },
        snapshot,
    ))
}

/// A whole number written as a string, without leading zeros, with an optional minus sign.
fn integer(s: &str, signed: bool) -> Option<i128> {
    let digits = if signed {
        s.strip_prefix('-').unwrap_or(s)
    } else {
        s
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// A Hyperliquid coin name: letters and digits (`kPEPE`), or a builder DEX's `dex:COIN`.
pub fn is_coin_name(c: &str) -> bool {
    (1..=24).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b':')
}

fn parse_book(v: &Value) -> Result<WhatIf, String> {
    let obj = v
        .as_object()
        .ok_or("book must be {\"usdc\": ..., \"positions\": [...]}")?;
    let usdc = obj
        .get("usdc")
        .and_then(Value::as_str)
        .and_then(|s| integer(s, false))
        .filter(|&x| x <= MAX_BOOK_MICRO)
        .ok_or("book.usdc must be the USDC margin in micro-USD, as a string of digits")?;
    let positions = match obj.get("positions") {
        None | Some(Value::Null) => Vec::new(),
        Some(p) => p.as_array().ok_or("book.positions must be a list")?.clone(),
    };
    if positions.len() > MAX_BOOK_POSITIONS {
        return Err(format!(
            "book has {} positions: at most {MAX_BOOK_POSITIONS}",
            positions.len()
        ));
    }
    let mut out: Vec<WhatIfPosition> = Vec::new();
    for p in &positions {
        let coin = p
            .get("coin")
            .and_then(Value::as_str)
            .filter(|c| is_coin_name(c))
            .ok_or("each position needs a coin, as Hyperliquid names it (BTC, kPEPE)")?;
        let usd = p
            .get("usd")
            .and_then(Value::as_str)
            .and_then(|s| integer(s, true))
            .filter(|&x| x != 0 && x.abs() <= MAX_BOOK_MICRO)
            .ok_or_else(|| {
                format!("position {coin} needs usd: its size in micro-USD at the mark, negative for a short")
            })?;
        if out.iter().any(|o| o.coin == coin) {
            return Err(format!("book lists {coin} twice"));
        }
        out.push(WhatIfPosition {
            coin: coin.to_string(),
            usd: usd.to_string(),
        });
    }
    Ok(WhatIf {
        usdc: usdc.to_string(),
        positions: out,
    })
}

fn parse_spot(v: &Value) -> Result<Vec<Spot>, String> {
    let rows = v.as_array().ok_or("spot must be a list")?;
    if rows.len() > MAX_SPOT {
        return Err(format!("spot has {} rows: at most {MAX_SPOT}", rows.len()));
    }
    let mut out: Vec<Spot> = Vec::new();
    for r in rows {
        let name = r.get("token").and_then(Value::as_str).unwrap_or("");
        let t = token(name).ok_or_else(|| {
            format!("spot token {name:?} is not one of USDC, nBTC, ETH, USDT and wNEAR")
        })?;
        let amount = r
            .get("amount")
            .and_then(Value::as_str)
            .and_then(|s| integer(s, false))
            .ok_or_else(|| {
                format!("spot {name} needs an amount, as a string of the token's smallest units")
            })?;
        if out.iter().any(|o| o.token == t.name) {
            return Err(format!("spot lists {name} twice"));
        }
        out.push(Spot {
            token: t.name.to_string(),
            amount: amount.to_string(),
        });
    }
    Ok(out)
}

// ------------------------------------------------------------------------------------------------- inputs

/// NEAR views read at one block.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NearRead {
    pub block: Block,
    /// Results by view name, as the contract returned them.
    pub views: BTreeMap<String, Value>,
}

/// One dry 1Click quote: the amount asked to sell (token units), and the answer as 1Click gave it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct QuoteRead {
    pub amount: String,
    /// HTTP status; 0 if the request failed before any answer.
    pub status: u16,
    pub answer: Value,
}

/// One answer from Aave's API: the HTTP status (0 if the request failed before any answer) and the body.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AaveRead {
    pub status: u16,
    pub answer: Value,
}

/// What a credit check read about the outside lenders (INTERFACES.md 27), beyond Rhea's `get_assets`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LenderReads {
    /// Aave's core market on Ethereum: its USDC and WBTC reserves.
    pub aave: AaveRead,
    /// The dry 1Click quote for moving the book's bitcoin from NEAR to WBTC on Ethereum. `None` when it wasn't
    /// asked: the book holds no bitcoin, bitcoin has no price, or Aave's terms weren't read.
    #[serde(rename = "move")]
    pub move_quote: Option<QuoteRead>,
    /// The dry 1Click quote for the way back: the same amount of WBTC on Ethereum to nBTC on NEAR (the user's
    /// decision of 11 Nov: the move rule counts the trip there and back). Asked whenever `move` is. Left out by a
    /// run from before it, whose result then prices the way there alone, so a saved run replays to the byte.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub move_back: Option<QuoteRead>,
}

/// Everything one credit check read. Its canonical JSON is hashed into the result's `in`, and
/// `backtest credit` recomputes the result from it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CreditInputs {
    pub v: u32,
    pub request: CreditRequest,
    /// Hyperliquid mainnet: the address's state, open orders, mode and spot balances (for an `hl_address`), and
    /// the market of each coin priced.
    pub hl: HlReads,
    /// `userVaultEquities` and `delegatorSummary` for the address: left out of the book, but listed.
    pub hl_vaults: Value,
    pub hl_staking: Value,
    /// Exchange readings per coin priced.
    pub coins: BTreeMap<String, CoinReads>,
    /// Our pool on testnet: `get_pool` and `get_params`.
    pub pool: NearRead,
    /// Rhea on mainnet: `get_assets` for USDC and the spot tokens.
    pub rhea: NearRead,
    /// Dry 1Click quotes, by token.
    pub quotes: BTreeMap<String, QuoteRead>,
    /// The outside lenders' terms. Left out by a run from before the lender reads, whose result then has no
    /// `funding`, so a saved run replays to the byte.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lenders: Option<LenderReads>,
    /// The enclave's clock (unix ms) after the last price was read.
    pub now_ms: u64,
    pub errors: Vec<String>,
    pub fatal: Option<String>,
}

impl CreditInputs {
    pub fn canonical(&self) -> String {
        serde_json::to_string(self).expect("inputs serialise")
    }

    pub fn hash(&self) -> String {
        sha256_hex(self.canonical().as_bytes())
    }
}

// ----------------------------------------------------------------------------------------------- parsers

/// One position of a `clearinghouseState` answer.
#[derive(Clone, Debug, PartialEq)]
pub struct HlPosition {
    pub coin: String,
    pub szi: f64,
    pub entry: f64,
    pub upnl: f64,
    /// Isolated margin: left out of the book, and its margin with it.
    pub isolated: bool,
    pub margin_used: f64,
}

/// The nonzero positions of a `clearinghouseState` answer.
pub fn positions(state: &Value) -> Result<Vec<HlPosition>, String> {
    let mut out = Vec::new();
    for p in state
        .get("assetPositions")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
    {
        let pos = p.get("position").unwrap_or(&Value::Null);
        let coin = pos.get("coin").and_then(Value::as_str);
        let (szi, entry, upnl) = (
            pos.get("szi").and_then(f64_of),
            pos.get("entryPx").and_then(f64_of),
            pos.get("unrealizedPnl").and_then(f64_of),
        );
        let (Some(coin), Some(szi), Some(entry), Some(upnl)) = (coin, szi, entry, upnl) else {
            return Err("a Hyperliquid position lacks its coin, size, entry or PnL".into());
        };
        if szi == 0.0 {
            continue;
        }
        out.push(HlPosition {
            coin: coin.to_string(),
            szi,
            entry,
            upnl,
            isolated: pos.pointer("/leverage/type").and_then(Value::as_str) == Some("isolated"),
            margin_used: pos.get("marginUsed").and_then(f64_of).unwrap_or(0.0),
        });
    }
    Ok(out)
}

/// The cross account's value of a standard account: `crossMarginSummary.accountValue`, which leaves isolated
/// positions and their margin out (the whole account's `marginSummary` if an answer lacks it).
pub fn cross_value(state: &Value) -> Result<f64, String> {
    state
        .pointer("/crossMarginSummary/accountValue")
        .or_else(|| state.pointer("/marginSummary/accountValue"))
        .and_then(f64_of)
        .ok_or_else(|| "Hyperliquid's clearinghouseState has no account value".to_string())
}

/// A spot pair or spot token in `frontendOpenOrders` (`PURR/USDC`, `@107`), not a perp.
pub fn is_spot_coin(coin: &str) -> bool {
    coin.contains('/') || coin.starts_with('@')
}

/// The coins on version 0's allow-list (RISK_ENGINE.md 5), from the compiled-in parameter file, and each coin's
/// price tier and unit multiplier.
pub struct Universe {
    pub allowed: BTreeSet<String>,
    pub tier: BTreeMap<String, u8>,
    pub unit_mult: BTreeMap<String, f64>,
}

pub fn universe() -> Universe {
    let u: Value = serde_json::from_str(risk_core::universe::UNIVERSE_V0).unwrap_or_default();
    let mut out = Universe {
        allowed: BTreeSet::new(),
        tier: BTreeMap::new(),
        unit_mult: BTreeMap::new(),
    };
    for (name, c) in u
        .get("coins")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        if c.get("allowed").and_then(Value::as_bool) == Some(true) {
            out.allowed.insert(name.clone());
        }
        out.tier.insert(
            name.clone(),
            c.get("tier").and_then(u64_of).unwrap_or(3) as u8,
        );
        out.unit_mult.insert(
            name.clone(),
            c.get("unit_mult").and_then(f64_of).unwrap_or(1.0),
        );
    }
    out
}

/// The coin a spot token wraps (nBTC: BTC), if any.
pub fn group_of(engine_token: &str) -> Option<&'static str> {
    risk_core::params::find_token(engine_token).and_then(|t| t.group)
}

/// The coins one check prices: each allow-listed perp the book holds (cross margin only), the coin of each spot
/// token held, and BTC for the market-wide volatility term (RISK_ENGINE.md 4.4).
pub fn coins_to_price(ci: &CreditInputs, u: &Universe) -> Result<BTreeSet<String>, String> {
    let mut out = BTreeSet::new();
    if ci.request.hl_address.is_some() {
        for p in positions(&ci.hl.state)? {
            if !p.isolated && u.allowed.contains(&p.coin) {
                out.insert(p.coin);
            }
        }
    }
    if let Some(b) = &ci.request.book {
        for p in &b.positions {
            if u.allowed.contains(&p.coin) {
                out.insert(p.coin.clone());
            }
        }
    }
    for s in &ci.request.spot {
        let held = s.amount != "0";
        if let Some(g) = token(&s.token).and_then(|t| group_of(t.engine)) {
            if held {
                out.insert(g.to_string());
            }
        }
    }
    if !out.is_empty() {
        out.insert("BTC".to_string());
    }
    Ok(out)
}

/// A reply as JSON, if its status is one of `ok`.
pub fn reply_json(r: Result<Reply, String>, ok: &[u16]) -> Result<Value, String> {
    let r = r?;
    if !ok.contains(&r.status) {
        return Err(format!("HTTP {}", r.status));
    }
    serde_json::from_slice(&r.body).map_err(|_| "not JSON".to_string())
}

/// A dry quote's USDC out, in USDC units, if 1Click quoted.
pub fn quote_out(q: &QuoteRead) -> Option<u128> {
    if !matches!(q.status, 200 | 201) {
        return None;
    }
    q.answer.pointer("/quote/amountOut").and_then(u128_of)
}

/// Why a dry quote gave no price, in words (1Click's own message when it sent one).
pub fn quote_error(q: &QuoteRead) -> String {
    match q.answer.get("message").and_then(Value::as_str) {
        Some(m) => crate::util::clip(m, 80),
        None if q.status == 0 => "no answer".into(),
        None => format!("HTTP {}", q.status),
    }
}

/// Aave's terms on Ethereum for a USDC loan against WBTC, from one answer of its API. The field names are the
/// API's own (`ReserveSupplyInfo`, `ReserveBorrowInfo`; its schema was read on 10 Nov).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AaveTerms {
    /// USDC's borrow and deposit rates in bp a year (the API's `apy`, which compounds).
    pub rate_bp: u32,
    pub supply_bp: u32,
    /// The USDC free to borrow (`availableLiquidity.usd`), in micro-USD.
    pub free_micro: u128,
    /// WBTC as collateral: the most Aave lends against it, where it liquidates, and the liquidator's bonus.
    pub ltv_bp: u32,
    pub liq_bp: u32,
    pub penalty_bp: u32,
    /// Whether Aave lends USDC against new WBTC now: WBTC can be collateral and is under its supply cap, USDC can
    /// be borrowed and is under its borrow cap, and neither reserve is frozen or paused.
    pub open: bool,
}

/// Reads [`AaveTerms`] from an answer, or says what it lacks.
pub fn aave_terms(r: &AaveRead) -> Result<AaveTerms, String> {
    if r.status != 200 {
        return Err(if r.status == 0 {
            "no answer".into()
        } else {
            format!("HTTP {}", r.status)
        });
    }
    if let Some(m) = r
        .answer
        .pointer("/errors/0/message")
        .and_then(Value::as_str)
    {
        return Err(crate::util::clip(m, 80));
    }
    let (usdc, wbtc) = (
        r.answer.pointer("/data/usdc").filter(|x| x.is_object()),
        r.answer.pointer("/data/wbtc").filter(|x| x.is_object()),
    );
    let (Some(usdc), Some(wbtc)) = (usdc, wbtc) else {
        return Err("the answer lacks the USDC or the WBTC reserve".into());
    };
    let ratio = |v: &Value, path: &str| {
        v.pointer(path)
            .and_then(f64_of)
            .filter(|x| (0.0..=10.0).contains(x))
            .map(|x| bp(x) as u32)
            .ok_or_else(|| format!("the answer lacks {}", path.trim_start_matches('/')))
    };
    let flag = |v: &Value, path: &str| v.pointer(path).and_then(Value::as_bool);
    let free = usdc
        .pointer("/borrowInfo/availableLiquidity/usd")
        .and_then(f64_of)
        .filter(|x| *x >= 0.0)
        .ok_or("the answer lacks USDC's available liquidity")?;
    let open = flag(wbtc, "/supplyInfo/canBeCollateral") == Some(true)
        && flag(wbtc, "/supplyInfo/supplyCapReached") == Some(false)
        && flag(usdc, "/borrowInfo/borrowCapReached") == Some(false)
        && usdc
            .pointer("/borrowInfo/borrowingState")
            .and_then(Value::as_str)
            == Some("ENABLED")
        && [usdc, wbtc]
            .iter()
            .all(|x| flag(x, "/isFrozen") == Some(false) && flag(x, "/isPaused") == Some(false));
    Ok(AaveTerms {
        rate_bp: ratio(usdc, "/borrowInfo/apy/value")?,
        supply_bp: ratio(usdc, "/supplyInfo/apy/value")?,
        free_micro: crate::util::micro_down(free).max(0) as u128,
        ltv_bp: ratio(wbtc, "/supplyInfo/maxLTV/value")?,
        liq_bp: ratio(wbtc, "/supplyInfo/liquidationThreshold/value")?,
        penalty_bp: ratio(wbtc, "/supplyInfo/liquidationBonus/value")?,
        open,
    })
}

/// The one request to Aave's API: the USDC and WBTC reserves of the core market on Ethereum, with only the
/// fields [`aave_terms`] reads.
pub fn aave_query() -> String {
    let reserve = |token: &str| {
        format!(
            r#"reserve(request: {{market: "{AAVE_ETHEREUM_POOL}", underlyingToken: "{token}", chainId: {AAVE_ETHEREUM_CHAIN}}})"#
        )
    };
    let query = format!(
        "{{ usdc: {} {{ underlyingToken {{ symbol address }} isFrozen isPaused supplyInfo {{ apy {{ value }} }} \
         borrowInfo {{ apy {{ value }} availableLiquidity {{ usd }} borrowingState borrowCapReached }} }} \
         wbtc: {} {{ underlyingToken {{ symbol address }} isFrozen isPaused \
         supplyInfo {{ maxLTV {{ value }} liquidationThreshold {{ value }} liquidationBonus {{ value }} \
         canBeCollateral supplyCapReached }} }} }}",
        reserve(AAVE_USDC),
        reserve(AAVE_WBTC)
    );
    json!({ "query": query }).to_string()
}

/// The USDC a Rhea asset has free to lend, in micro-USD, from its `get_assets` entry: what is supplied, reserved
/// and held as protocol fees, less what is borrowed (research/scripts/rhea_warehouse.py). Rhea keeps balances with
/// `config.extra_decimals` more digits than the token.
pub fn rhea_free_micro(asset: &Value) -> Option<u128> {
    let amount = |path: &str| asset.pointer(path).and_then(u128_of);
    let pool = amount("/supplied/balance")?
        .checked_add(amount("/reserved").unwrap_or(0))?
        .checked_add(amount("/prot_fee").unwrap_or(0))?;
    let free = pool.saturating_sub(amount("/borrowed/balance")?);
    let extra = asset.pointer("/config/extra_decimals").and_then(u64_of)?;
    Some(free / 10u128.checked_pow(u32::try_from(extra).ok()?)?)
}

/// What a move quote says the move costs, in bp of the bitcoin sent, rounded up: nBTC in and WBTC out have the
/// same decimals, and both count as bitcoin. `None` if 1Click didn't quote.
pub fn move_cost_bp(q: &QuoteRead) -> Option<u32> {
    let sent = q.amount.parse::<u128>().ok().filter(|x| *x > 0)?;
    let got = quote_out(q)?;
    let lost = sent.saturating_sub(got);
    u32::try_from(lost.saturating_mul(10_000).div_ceil(sent)).ok()
}

/// Unix ms as ISO 8601 UTC with milliseconds (1Click's `deadline`), from the civil-date algorithm.
pub fn iso_utc(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Howard Hinnant's days-to-civil, for days since 1970-01-01.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        ms % 1000
    )
}

// --------------------------------------------------------------------------------------------------- reads

/// Reads everything a credit check needs. A read it can't do without (the Hyperliquid account, our pool's terms)
/// sets `fatal`; a missing price source, quote or Rhea read is listed in `errors`.
pub fn read(net: &mut impl Net, req: &CreditRequest) -> CreditInputs {
    let mut ci = CreditInputs {
        v: CREDIT_INPUTS_V,
        request: req.clone(),
        ..CreditInputs::default()
    };
    let start = net.now_ms();
    if let Some(address) = req.hl_address.clone() {
        if let Err(reason) = read_hl_account(net, &mut ci, &address) {
            ci.fatal = Some(reason);
            return ci;
        }
    }
    if let Err(reason) = read_pool(net, &mut ci) {
        ci.fatal = Some(reason);
        return ci;
    }
    read_rhea(net, &mut ci);
    read_aave(net, &mut ci);
    let u = universe();
    let coins = match coins_to_price(&ci, &u) {
        Ok(c) => c,
        Err(reason) => {
            ci.fatal = Some(reason);
            return ci;
        }
    };
    if coins.len() > MAX_COINS {
        ci.fatal = Some(format!(
            "this book holds {} coins on our list, counting BTC; one check prices at most {MAX_COINS} \
             within OutLayer's 20 seconds",
            coins.len()
        ));
        return ci;
    }
    if !coins.is_empty() {
        read_markets(net, &mut ci, &coins, start);
    }
    ci.now_ms = net.now_ms();
    read_quotes(net, &mut ci, &u);
    ci
}

fn read_hl_account(net: &mut impl Net, ci: &mut CreditInputs, address: &str) -> Result<(), String> {
    const KINDS: [&str; 6] = [
        "clearinghouseState",
        "frontendOpenOrders",
        "userAbstraction",
        "spotClearinghouseState",
        "userVaultEquities",
        "delegatorSummary",
    ];
    let reqs: Vec<(String, String)> = KINDS
        .iter()
        .map(|k| {
            (
                HL_MAINNET_INFO.to_string(),
                json!({"type": k, "user": address}).to_string(),
            )
        })
        .collect();
    ci.hl.address = Some(address.to_string());
    for (kind, reply) in KINDS.iter().zip(net.post_all(&reqs)) {
        let v = reply_json(reply, &[200]);
        match *kind {
            "clearinghouseState" => {
                ci.hl.state =
                    v.map_err(|e| format!("cannot read the Hyperliquid account {address}: {e}"))?
            }
            "userAbstraction" => {
                ci.hl.abstraction = v.map_err(|e| {
                    format!("cannot read the Hyperliquid account mode of {address}: {e}")
                })?
            }
            "spotClearinghouseState" => {
                ci.hl.spot = v.map_err(|e| {
                    format!("cannot read the Hyperliquid spot balances of {address}: {e}")
                })?
            }
            "frontendOpenOrders" => match v {
                Ok(v) => ci.hl.orders = v,
                Err(e) => ci.errors.push(format!("Hyperliquid open orders: {e}")),
            },
            "userVaultEquities" => match v {
                Ok(v) => ci.hl_vaults = v,
                Err(e) => ci.errors.push(format!("Hyperliquid vault deposits: {e}")),
            },
            _ => match v {
                Ok(v) => ci.hl_staking = v,
                Err(e) => ci.errors.push(format!("Hyperliquid staking: {e}")),
            },
        }
    }
    Ok(())
}

/// The final block of a NEAR network.
fn final_block(net: &mut impl Net, rpc_url: &str) -> Result<Block, String> {
    let b = read::rpc(net, rpc_url, "block", json!({"finality": "final"}))
        .map_err(|e| format!("{e:?}"))?;
    let header = b.get("header").unwrap_or(&Value::Null);
    Ok(Block {
        height: header
            .get("height")
            .and_then(u64_of)
            .ok_or("the block has no height")?,
        timestamp_ns: header
            .get("timestamp_nanosec")
            .or_else(|| header.get("timestamp"))
            .and_then(u64_of)
            .ok_or("the block has no timestamp")?
            .to_string(),
        hash: header
            .get("hash")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

/// Our pool's terms: the only pool that exists is on testnet (INTERFACES.md 18).
fn read_pool(net: &mut impl Net, ci: &mut CreditInputs) -> Result<(), String> {
    let n = TESTNET;
    ci.pool.block = final_block(net, n.near_rpc)
        .map_err(|e| format!("cannot read the latest final testnet block: {e}"))?;
    for method in ["get_pool", "get_params"] {
        let v = read::view(
            net,
            n.near_rpc,
            ci.pool.block.height,
            n.pool,
            method,
            &json!({}),
        )
        .map_err(|e| format!("cannot read our pool's terms: {}", e.reason(n.pool, method)))?;
        ci.pool.views.insert(method.to_string(), v);
    }
    Ok(())
}

/// Rhea's terms for USDC and the spot tokens. A failure is listed, and the result says Rhea wasn't read.
fn read_rhea(net: &mut impl Net, ci: &mut CreditInputs) {
    let block = match final_block(net, NEAR_MAINNET_RPC) {
        Ok(b) => b,
        Err(e) => {
            ci.errors
                .push(format!("cannot read the latest final mainnet block: {e}"));
            return;
        }
    };
    let mut ids = vec![MAINNET_TOKENS[0].id.to_string()];
    for s in &ci.request.spot {
        if let Some(t) = token(&s.token).filter(|t| t.name != "USDC") {
            ids.push(t.id.to_string());
        }
    }
    // nBTC's terms are read even when the book holds none: the funding section shows them (INTERFACES.md 27).
    let nbtc = MAINNET_TOKENS[1].id.to_string();
    if !ids.contains(&nbtc) {
        ids.push(nbtc);
    }
    match read::view(
        net,
        NEAR_MAINNET_RPC,
        block.height,
        RHEA,
        "get_assets",
        &json!({ "token_ids": ids }),
    ) {
        Ok(v) => {
            ci.rhea.views.insert("get_assets".into(), v);
            ci.rhea.block = block;
        }
        Err(e) => ci.errors.push(e.reason(RHEA, "get_assets")),
    }
}

/// Aave's terms for USDC and WBTC on Ethereum, in one request. A failure is listed, and the result's `funding`
/// then leaves Aave out.
fn read_aave(net: &mut impl Net, ci: &mut CreditInputs) {
    let reply = net
        .post_all(&[(AAVE_API.to_string(), aave_query())])
        .pop()
        .unwrap_or(Err("no answer".into()));
    let aave = match reply {
        Ok(r) => AaveRead {
            status: r.status,
            answer: serde_json::from_slice(&r.body).unwrap_or(Value::Null),
        },
        Err(e) => {
            ci.errors
                .push(format!("Aave's terms: {}", crate::util::clip(&e, 80)));
            AaveRead::default()
        }
    };
    ci.lenders = Some(LenderReads {
        aave,
        move_quote: None,
        move_back: None,
    });
}

/// What the price reads found: each coin's exchange readings and Hyperliquid's market for it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PriceReads {
    pub coins: BTreeMap<String, CoinReads>,
    /// `hl::asset_entry` per coin Hyperliquid lists.
    pub assets: BTreeMap<String, Value>,
    pub meta_read: bool,
    /// When `metaAndAssetCtxs` came back (unix ms).
    pub at_ms: u64,
    pub errors: Vec<String>,
}

/// One request of the price reads: which coin and source it is for.
struct Ask {
    coin: String,
    src: &'static str,
    url: String,
}

/// The reads `check` makes for prices (read.rs), in four batches sent together, freshest last: hourly candles,
/// minute candles, Hyperliquid's market (from `hl_info`), then the tickers. OKX's three pages of hourly candles are
/// asked for at once, each starting where the one before ends, rather than one after another. Past
/// `start + budget_ms` the candles and the market are skipped and listed; the tickers, which prices need most, are
/// read even late, as the last thing before `now`.
pub fn read_prices(
    net: &mut impl Net,
    coins: &BTreeSet<String>,
    start: u64,
    budget_ms: u64,
    hl_info: &str,
) -> PriceReads {
    let mut out = PriceReads::default();
    // Whether the reads have used their time; if so, `what` is skipped and listed.
    let late = |now: u64, errors: &mut Vec<String>, what: &str| {
        let late = now > start + budget_ms;
        if late {
            errors.push(format!("skipped {what}: the run is out of time"));
        }
        late
    };
    for hour in [true, false] {
        let what = if hour {
            "hourly candles"
        } else {
            "minute candles"
        };
        if late(net.now_ms(), &mut out.errors, what) {
            continue;
        }
        let h0 = net.now_ms() / HOUR_MS * HOUR_MS;
        let mut asks = Vec::new();
        for c in coins {
            for src in market::CANDLE_SOURCES {
                let pages: &[Option<u64>] = if hour && src == "okx" {
                    &[None, Some(h0 - 299 * HOUR_MS), Some(h0 - 599 * HOUR_MS)]
                } else {
                    &[None]
                };
                for &after in pages {
                    asks.push(Ask {
                        coin: c.clone(),
                        src,
                        url: candle_url(src, base(c), hour, after),
                    });
                }
            }
        }
        let urls: Vec<String> = asks.iter().map(|a| a.url.clone()).collect();
        let mut rows: BTreeMap<(String, &str), Vec<(u64, f64)>> = BTreeMap::new();
        let mut failed: BTreeSet<(String, &str)> = BTreeSet::new();
        for (ask, reply) in asks.iter().zip(net.get_all(&urls)) {
            let key = (ask.coin.clone(), ask.src);
            match reply_json(reply, &[200]).and_then(|v| parse_candles(ask.src, &v)) {
                Ok(page) => rows.entry(key).or_default().extend(page),
                Err(e) => {
                    if failed.insert(key) {
                        out.errors
                            .push(format!("{} {what} for {}: {e}", ask.src, ask.coin));
                    }
                }
            }
        }
        for ((coin, src), mut r) in rows {
            r.sort_by_key(|x| x.0);
            r.dedup_by_key(|x| x.0);
            if r.is_empty() {
                continue;
            }
            let reads = out.coins.entry(coin).or_default();
            let slot = if hour {
                &mut reads.hours
            } else {
                &mut reads.minutes
            };
            slot.insert(src.to_string(), r);
        }
    }
    if !late(net.now_ms(), &mut out.errors, "Hyperliquid's market") {
        let body = json!({"type": "metaAndAssetCtxs"}).to_string();
        let reply = net
            .post_all(&[(hl_info.to_string(), body)])
            .pop()
            .unwrap_or(Err("no answer".into()));
        match reply_json(reply, &[200]) {
            Ok(v) => {
                out.at_ms = net.now_ms();
                out.meta_read = true;
                for c in coins {
                    if let Some(entry) = hl::asset_entry(&v, c) {
                        out.assets.insert(c.clone(), entry);
                    }
                }
            }
            Err(e) => out.errors.push(format!("Hyperliquid's market: {e}")),
        }
    }
    let mut asks = Vec::new();
    for c in coins {
        for src in ["binance", "okx", "bybit", "coinbase"] {
            asks.push(Ask {
                coin: c.clone(),
                src,
                url: ticker_url(src, base(c)),
            });
        }
    }
    let urls: Vec<String> = asks.iter().map(|a| a.url.clone()).collect();
    let replies = net.get_all(&urls);
    let at_ms = net.now_ms();
    for (ask, reply) in asks.iter().zip(replies) {
        match reply_json(reply, &[200]).and_then(|v| parse_ticker(ask.src, &v)) {
            Ok((bid, ask_px)) => {
                out.coins
                    .entry(ask.coin.clone())
                    .or_default()
                    .tickers
                    .insert(
                        ask.src.to_string(),
                        Ticker {
                            bid,
                            ask: ask_px,
                            at_ms,
                        },
                    );
            }
            Err(e) => out
                .errors
                .push(format!("{} ticker for {}: {e}", ask.src, ask.coin)),
        }
    }
    out
}

/// The credit check's prices: Hyperliquid mainnet's market.
fn read_markets(net: &mut impl Net, ci: &mut CreditInputs, coins: &BTreeSet<String>, start: u64) {
    let p = read_prices(net, coins, start, READ_BUDGET_MS, HL_MAINNET_INFO);
    ci.coins = p.coins;
    ci.hl.assets = p.assets;
    ci.hl.meta_read = p.meta_read;
    ci.hl.at_ms = p.at_ms;
    ci.errors.extend(p.errors);
}

/// The reference price of `coin` from what was read, as the result computes it (RISK_ENGINE.md 3.2).
pub fn reference_price(ci: &CreditInputs, u: &Universe, coin: &str) -> Option<f64> {
    let asset = ci.hl.assets.get(coin).and_then(|a| hl::asset(a).ok());
    let off_hl = ci.hl.meta_read && asset.as_ref().is_none_or(|x| x.unusable);
    let oracle = asset
        .as_ref()
        .filter(|_| !off_hl)
        .and_then(|x| x.oracle)
        .map(|p| (p, ci.hl.at_ms));
    let no_reads = CoinReads::default();
    let reads = ci.coins.get(coin).unwrap_or(&no_reads);
    market::coin_price(
        reads,
        *u.tier.get(coin).unwrap_or(&3),
        *u.unit_mult.get(coin).unwrap_or(&1.0),
        oracle,
        ci.now_ms,
    )
    .reference
    .price
}

/// The bitcoin a move quote asks about, in nBTC's units: what the book holds on NEAR, and at most
/// [`MOVE_QUOTE_USD`] of it at the reference price. `None` when there is nothing to ask: Aave's terms weren't
/// read, the book holds no bitcoin, or bitcoin has no price.
pub fn move_ask(ci: &CreditInputs, u: &Universe) -> Option<String> {
    let aave = &ci.lenders.as_ref()?.aave;
    aave_terms(aave).ok()?;
    let nbtc = &MAINNET_TOKENS[1];
    let held: u128 = ci
        .request
        .spot
        .iter()
        .find(|s| s.token == nbtc.name)
        .and_then(|s| s.amount.parse().ok())
        .filter(|x| *x > 0)?;
    let price = reference_price(ci, u, group_of(nbtc.engine)?).filter(|p| *p > 0.0)?;
    let cap = (MOVE_QUOTE_USD / price * pow10(nbtc.decimals)).floor();
    if !(1.0..1e36).contains(&cap) {
        return None;
    }
    Some(held.min(cap as u128).to_string())
}

/// 3.3: a dry quote, without our key, to sell one hour of each held wrapper's (and USDT's) 1Click capacity for
/// USDC on NEAR. It is sized at the reference price the result uses, so the result can tell π from it.
fn read_quotes(net: &mut impl Net, ci: &mut CreditInputs, u: &Universe) {
    let mut asks: Vec<(&'static MainnetToken, String)> = Vec::new();
    for s in &ci.request.spot {
        let Some(t) = token(&s.token).filter(|t| QUOTED.contains(&t.name)) else {
            continue;
        };
        if s.amount == "0" {
            continue;
        }
        let price = match group_of(t.engine) {
            Some(g) => reference_price(ci, u, g),
            None => Some(1.0),
        };
        let Some(price) = price.filter(|p| *p > 0.0) else {
            ci.errors.push(format!(
                "no 1Click quote for {}: its coin has no price",
                t.name
            ));
            continue;
        };
        let cap_h = risk_core::params::find_token(t.engine).map_or(0.0, |x| x.cap_h);
        let units = (cap_h / price * pow10(t.decimals)).floor();
        if !(1.0..1e36).contains(&units) {
            continue;
        }
        asks.push((t, format!("{}", units as u128)));
    }
    let moved = move_ask(ci, u);
    if asks.is_empty() && moved.is_none() {
        return;
    }
    let deadline = iso_utc(ci.now_ms + QUOTE_DEADLINE_MS);
    let mut reqs: Vec<(String, String)> = asks
        .iter()
        .map(|(t, amount)| {
            let body = json!({
                "dry": true, "swapType": "EXACT_INPUT", "slippageTolerance": 100,
                "originAsset": format!("nep141:{}", t.id), "depositType": "ORIGIN_CHAIN",
                "destinationAsset": format!("nep141:{}", MAINNET_TOKENS[0].id), "amount": amount,
                "refundTo": DRY_QUOTE_ACCOUNT, "refundType": "ORIGIN_CHAIN",
                "recipient": DRY_QUOTE_ACCOUNT, "recipientType": "DESTINATION_CHAIN", "deadline": deadline,
            });
            (ONECLICK_QUOTE.to_string(), body.to_string())
        })
        .collect();
    // The move to Ethereum, asked with the others: the same nBTC, paid out as WBTC to an Ethereum address.
    if let Some(amount) = &moved {
        let body = json!({
            "dry": true, "swapType": "EXACT_INPUT", "slippageTolerance": 100,
            "originAsset": format!("nep141:{}", MAINNET_TOKENS[1].id), "depositType": "ORIGIN_CHAIN",
            "destinationAsset": ONECLICK_WBTC_ETH, "amount": amount,
            "refundTo": DRY_QUOTE_ACCOUNT, "refundType": "ORIGIN_CHAIN",
            "recipient": DRY_QUOTE_EVM, "recipientType": "DESTINATION_CHAIN", "deadline": deadline,
        });
        reqs.push((ONECLICK_QUOTE.to_string(), body.to_string()));
        // And the way back: the same amount of WBTC on Ethereum, paid out as nBTC on NEAR (the route
        // research/scripts/oneclick_routes.py asks the same way).
        let back = json!({
            "dry": true, "swapType": "EXACT_INPUT", "slippageTolerance": 100,
            "originAsset": ONECLICK_WBTC_ETH, "depositType": "ORIGIN_CHAIN",
            "destinationAsset": format!("nep141:{}", MAINNET_TOKENS[1].id), "amount": amount,
            "refundTo": DRY_QUOTE_EVM, "refundType": "ORIGIN_CHAIN",
            "recipient": DRY_QUOTE_ACCOUNT, "recipientType": "DESTINATION_CHAIN", "deadline": deadline,
        });
        reqs.push((ONECLICK_QUOTE.to_string(), back.to_string()));
    }
    let mut replies = net.post_all(&reqs);
    if let Some(amount) = moved {
        // The last two answers: the way back, then the way there.
        let mut quote = |way: &str| match replies.pop().unwrap_or(Err("no answer".into())) {
            Ok(r) => QuoteRead {
                amount: amount.clone(),
                status: r.status,
                answer: serde_json::from_slice(&r.body).unwrap_or(Value::Null),
            },
            Err(e) => {
                ci.errors.push(format!(
                    "1Click quote for moving bitcoin {way}: {}",
                    crate::util::clip(&e, 80)
                ));
                QuoteRead {
                    amount: amount.clone(),
                    status: 0,
                    answer: Value::Null,
                }
            }
        };
        let (back, there) = (quote("back to NEAR"), quote("to Ethereum"));
        if let Some(l) = ci.lenders.as_mut() {
            l.move_quote = Some(there);
            l.move_back = Some(back);
        }
    }
    for ((t, amount), reply) in asks.iter().zip(replies) {
        let q = match reply {
            Ok(r) => QuoteRead {
                amount: amount.clone(),
                status: r.status,
                answer: serde_json::from_slice(&r.body).unwrap_or(Value::Null),
            },
            Err(e) => {
                ci.errors.push(format!(
                    "1Click quote for {}: {}",
                    t.name,
                    crate::util::clip(&e, 80)
                ));
                QuoteRead {
                    amount: amount.clone(),
                    status: 0,
                    answer: Value::Null,
                }
            }
        };
        ci.quotes.insert(t.name.to_string(), q);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bad(s: &str) -> String {
        parse(s).unwrap_err()
    }

    #[test]
    fn requests_parse_into_one_form() {
        let (r, snap) = parse(
            r#"{"mode":"credit_check","network":"mainnet","hl_address":"0x00000000000000000000000000000000000000AA",
                "book":null,"spot":[{"token":"nBTC","amount":"125000000"}],"snapshot":true}"#,
        )
        .unwrap();
        assert!(snap);
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            r#"{"mode":"credit_check","network":"mainnet","hl_address":"0x00000000000000000000000000000000000000aa","book":null,"spot":[{"token":"nBTC","amount":"125000000"}]}"#
        );
        let (b, _) = parse(
            r#"{"mode":"credit_check","network":"mainnet","book":{"usdc":"35000000000",
                "positions":[{"coin":"BTC","usd":"-100000000000"}]}}"#,
        )
        .unwrap();
        assert_eq!(b.hl_address, None);
        assert_eq!(b.book.unwrap().positions[0].usd, "-100000000000");
        assert!(b.spot.is_empty());
    }

    #[test]
    fn bad_requests_say_what_to_fix() {
        let base = |rest: &str| format!(r#"{{"mode":"credit_check","network":"mainnet",{rest}}}"#);
        assert!(bad("[]").contains("JSON object"));
        assert!(bad(r#"{"mode":"credit_check","network":"testnet","hl_address":"0x00000000000000000000000000000000000000aa"}"#)
            .contains("reads mainnet"));
        // A malformed address is refused.
        for a in [
            "0x1234",
            "00000000000000000000000000000000000000000aa",
            "0xZZ000000000000000000000000000000000000aa",
            "alice.near",
        ] {
            assert!(
                bad(&base(&format!(r#""hl_address":"{a}""#))).contains("40 hex"),
                "{a}"
            );
        }
        assert!(bad(&base(r#""hl_address":5"#)).contains("40 hex"));
        assert!(bad(&base(r#""spot":[]"#)).contains("hl_address or a what-if book"));
        assert!(bad(&base(
            r#""hl_address":"0x00000000000000000000000000000000000000aa","book":{"usdc":"0","positions":[]}"#
        ))
        .contains("not both"));
        let book = |b: &str| bad(&base(&format!(r#""book":{b}"#)));
        assert!(book(r#"{"usdc":"-5","positions":[]}"#).contains("book.usdc"));
        assert!(book(r#"{"usdc":"5","positions":[{"coin":"BTC","usd":"0"}]}"#).contains("usd"));
        assert!(book(r#"{"usdc":"5","positions":[{"coin":"BTC","usd":"1.5"}]}"#).contains("usd"));
        assert!(book(r#"{"usdc":"5","positions":[{"coin":"<b>","usd":"1"}]}"#).contains("coin"));
        assert!(book(
            r#"{"usdc":"5","positions":[{"coin":"BTC","usd":"1"},{"coin":"BTC","usd":"2"}]}"#
        )
        .contains("twice"));
        let spot = |s: &str| {
            bad(&base(&format!(
                r#""hl_address":"0x00000000000000000000000000000000000000aa","spot":{s}"#
            )))
        };
        assert!(spot(r#"[{"token":"DOGE","amount":"1"}]"#).contains("not one of"));
        assert!(spot(r#"[{"token":"nBTC","amount":"-1"}]"#).contains("amount"));
        assert!(
            spot(r#"[{"token":"nBTC","amount":"1"},{"token":"nBTC","amount":"2"}]"#)
                .contains("twice")
        );
        assert!(spot(r#"[{"token":"USDC","amount":"1"},{"token":"nBTC","amount":"1"},{"token":"ETH","amount":"1"},
            {"token":"USDT","amount":"1"},{"token":"wNEAR","amount":"1"},{"token":"USDC","amount":"2"}]"#)
            .contains("at most 5"));
    }

    #[test]
    fn deadlines_are_iso_utc() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
        // 9 Nov 2026, 01:21:48.123 UTC.
        assert_eq!(iso_utc(1_794_187_308_123), "2026-11-09T01:21:48.123Z");
        assert_eq!(iso_utc(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn positions_and_spot_coins() {
        let state = json!({"marginSummary": {"accountValue": "100.0"}, "crossMarginSummary": {"accountValue": "90.0"},
            "assetPositions": [
                {"type": "oneWay", "position": {"coin": "BTC", "szi": "-0.5", "entryPx": "75000", "unrealizedPnl": "10",
                 "leverage": {"type": "cross", "value": 20}, "marginUsed": "50"}},
                {"type": "oneWay", "position": {"coin": "DYDX", "szi": "100", "entryPx": "0.1", "unrealizedPnl": "-1",
                 "leverage": {"type": "isolated", "value": 3, "rawUsd": "-5"}, "marginUsed": "4"}},
                {"type": "oneWay", "position": {"coin": "ETH", "szi": "0.0", "entryPx": "2000", "unrealizedPnl": "0",
                 "leverage": {"type": "cross", "value": 20}}}]});
        let p = positions(&state).unwrap();
        assert_eq!(p.len(), 2);
        assert!(!p[0].isolated && p[1].isolated);
        assert_eq!(p[1].margin_used, 4.0);
        assert_eq!(cross_value(&state), Ok(90.0));
        assert_eq!(
            cross_value(&json!({"marginSummary": {"accountValue": "7"}})),
            Ok(7.0)
        );
        assert!(is_spot_coin("PURR/USDC") && is_spot_coin("@107") && !is_spot_coin("kPEPE"));
        let u = universe();
        assert_eq!(u.allowed.len(), 23);
        assert!(u.allowed.contains("kPEPE") && !u.allowed.contains("TAO"));
        assert_eq!(u.unit_mult["kPEPE"], 1000.0);
    }

    #[test]
    fn quotes_read_their_amount_or_why_not() {
        let ok = QuoteRead {
            amount: "659831000".into(),
            status: 201,
            answer: json!({"quote": {"amountIn": "659831000", "amountOut": "497145853215"}}),
        };
        assert_eq!(quote_out(&ok), Some(497_145_853_215));
        let none = QuoteRead {
            amount: "100000000000".into(),
            status: 400,
            answer: json!({"message": "No liquidity available", "correlationId": "x"}),
        };
        assert_eq!(quote_out(&none), None);
        assert_eq!(quote_error(&none), "No liquidity available");
    }

    fn fixture(name: &str) -> Value {
        let path = format!(
            "{}/tests/fixtures/mainnet/{name}.json",
            env!("CARGO_MANIFEST_DIR")
        );
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn aaves_recorded_answer_gives_its_terms() {
        // The answer Aave's API gave on 10 Nov to the request this file sends.
        let recorded = fixture("aave_reserves");
        assert_eq!(
            json!({ "query": recorded["request"]["query"] }).to_string(),
            aave_query()
        );
        let read = AaveRead {
            status: 200,
            answer: recorded["response"].clone(),
        };
        let t = aave_terms(&read).unwrap();
        // USDC: borrow 5.08%, deposit 4.30%, $163.2M free. WBTC: lends to 81%, liquidates at 85%, bonus 5%.
        assert_eq!((t.rate_bp, t.supply_bp), (508, 430));
        assert_eq!(t.free_micro, 163_198_398_228_281);
        assert_eq!((t.ltv_bp, t.liq_bp, t.penalty_bp), (8_100, 8_500, 500));
        assert!(t.open);
        // A paused reserve, or a full cap, lends nothing new.
        let mut paused = read.clone();
        paused.answer["data"]["wbtc"]["isPaused"] = json!(true);
        assert!(!aave_terms(&paused).unwrap().open);
        let mut full = read.clone();
        full.answer["data"]["usdc"]["borrowInfo"]["borrowCapReached"] = json!(true);
        assert!(!aave_terms(&full).unwrap().open);
        // What can't be read says why.
        let mut gone = read.clone();
        gone.answer["data"]["wbtc"] = Value::Null;
        assert!(aave_terms(&gone).unwrap_err().contains("WBTC reserve"));
        let failed = AaveRead {
            status: 200,
            answer: json!({"errors": [{"message": "Unknown field \"apr\""}]}),
        };
        assert_eq!(aave_terms(&failed).unwrap_err(), "Unknown field \"apr\"");
        assert_eq!(aave_terms(&AaveRead::default()).unwrap_err(), "no answer");
        let down = AaveRead {
            status: 503,
            answer: Value::Null,
        };
        assert_eq!(aave_terms(&down).unwrap_err(), "HTTP 503");
    }

    #[test]
    fn rheas_free_usdc_is_what_is_supplied_less_what_is_borrowed() {
        // The 9 Nov read: $12,565,110 supplied, $200,003 reserved, $673 of fees, $10,919,663 borrowed.
        let assets = fixture("rhea_get_assets");
        let usdc = &assets["value"][0];
        assert_eq!(usdc["token_id"], MAINNET_TOKENS[0].id);
        assert_eq!(rhea_free_micro(usdc), Some(1_846_122_352_728));
        assert_eq!(rhea_free_micro(&json!({})), None);
        // More borrowed than there is: nothing free, not a negative.
        let over = json!({"supplied": {"balance": "5"}, "borrowed": {"balance": "9"}, "config": {"extra_decimals": 0}});
        assert_eq!(rhea_free_micro(&over), Some(0));
    }

    #[test]
    fn a_move_quote_costs_the_bitcoin_it_loses() {
        // The dry quote of 10 Nov: 1.35435 nBTC on NEAR for 1.34778697 WBTC on Ethereum, 0.485% less bitcoin.
        let recorded = fixture("oneclick_dry_nbtc_wbtc");
        assert_eq!(recorded["request"]["destinationAsset"], ONECLICK_WBTC_ETH);
        assert_eq!(recorded["request"]["recipient"], DRY_QUOTE_EVM);
        let q = QuoteRead {
            amount: recorded["request"]["amount"].as_str().unwrap().into(),
            status: 201,
            answer: recorded["response"].clone(),
        };
        assert_eq!(move_cost_bp(&q), Some(49));
        let none = QuoteRead {
            amount: "135435000".into(),
            status: 400,
            answer: json!({"message": "No liquidity available"}),
        };
        assert_eq!(move_cost_bp(&none), None);
        // More out than in costs nothing.
        let free = QuoteRead {
            amount: "100".into(),
            status: 201,
            answer: json!({"quote": {"amountOut": "101"}}),
        };
        assert_eq!(move_cost_bp(&free), Some(0));
    }

    #[test]
    fn inputs_without_lender_reads_serialise_as_before() {
        let old = CreditInputs::default();
        assert!(!old.canonical().contains("lenders"));
        let new = CreditInputs {
            lenders: Some(LenderReads::default()),
            ..CreditInputs::default()
        };
        assert!(new
            .canonical()
            .contains(r#""lenders":{"aave":{"status":0,"answer":null},"move":null}"#));
        let back: CreditInputs = serde_json::from_str(&new.canonical()).unwrap();
        assert_eq!(back, new);
    }
}
