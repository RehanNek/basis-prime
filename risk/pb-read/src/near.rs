//! What the NEAR reads say (INTERFACES.md 3–5): the account's state and config, its balances, the pool's view of
//! it, the coin-status list and the drill. Each function reads one view result and refuses a shape it doesn't know.
use crate::lenders::StoredFunding;
use crate::steps::PlanStep;
use crate::util::{u128_of, u64_of};
use risk_core::{ClientTier, State};
use serde_json::Value;
use std::collections::BTreeMap;

/// Token names: the pool's (INTERFACES.md 2) and the engine's. WBTC (FUNDING.md 6.2) is the bitcoin an account
/// holds on Aave's chain.
pub const TOKEN_NAMES: [(&str, &str); 6] = [
    ("USDC", "USDC"),
    ("nBTC", "nBTC"),
    ("ETH", "ETH.b"),
    ("USDT", "USDT"),
    ("wNEAR", "wNEAR"),
    ("WBTC", "WBTC"),
];

/// The engine's name for a pool token name.
pub fn engine_name(pool_name: &str) -> Option<&'static str> {
    TOKEN_NAMES
        .iter()
        .find(|(p, _)| *p == pool_name)
        .map(|(_, e)| *e)
}

/// The pool's name for an engine token name.
pub fn pool_name(engine: &str) -> &'static str {
    TOKEN_NAMES
        .iter()
        .find(|(_, e)| *e == engine)
        .map_or("?", |(p, _)| *p)
}

const HOUR_NS: u64 = 3_600_000_000_000;
const DAY_NS: u64 = 24 * HOUR_NS;

/// One token the account is configured for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenConf {
    /// The token contract.
    pub id: String,
    /// The pool's name (USDC, nBTC, ...) and the engine's (USDC, nBTC, ETH.b, ...).
    pub name: &'static str,
    pub engine: &'static str,
    pub decimals: u32,
}

/// The account's `get_config` (INTERFACES.md 3), the parts the verdict uses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub tokens: Vec<TokenConf>,
    pub pool_id: String,
    /// The outside lenders the account may use (INTERFACES.md 24). None of them on accounts made before Phase 6.
    pub lenders: LenderConf,
}

/// `get_config().lenders`: left out or null, it names no lender.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LenderConf {
    pub aave: Option<AaveConf>,
    pub rhea: Option<RheaConf>,
}

impl LenderConf {
    pub fn is_empty(&self) -> bool {
        self.aave.is_none() && self.rhea.is_none()
    }
}

/// Rhea: its contract, and the NEAR tokens the account may post there. Each is one of the account's own tokens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RheaConf {
    pub contract_id: String,
    pub collateral: Vec<String>,
}

/// A token on Aave's chain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmToken {
    pub symbol: String,
    /// The engine's name for it: `WBTC`, `USDC`.
    pub engine: &'static str,
    /// `0x` and 40 hex digits, lower case.
    pub address: String,
    pub decimals: u32,
}

/// Aave: the chain, the Pool, its USDC and the tokens the account may post there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AaveConf {
    pub chain_id: u64,
    pub pool: String,
    pub usdc: EvmToken,
    pub collateral: Vec<EvmToken>,
}

/// The engine's name for a token on Aave's chain, by its symbol. Version 0 prices WBTC, wrapped ether (the
/// engine's ETH token) and USDC there.
fn evm_engine_name(symbol: &str) -> Option<&'static str> {
    match symbol {
        "WBTC" => Some("WBTC"),
        "WETH" => Some("ETH.b"),
        "USDC" => Some("USDC"),
        _ => None,
    }
}

fn evm_token(v: Option<&Value>, what: &str) -> Result<EvmToken, String> {
    let v = v.ok_or_else(|| format!("the account's Aave settings have no {what}"))?;
    let symbol = v.get("symbol").and_then(Value::as_str);
    let address = v
        .get("address")
        .and_then(Value::as_str)
        .filter(|a| is_evm_address(a));
    let decimals = v.get("decimals").and_then(u64_of).filter(|d| *d <= 24);
    let (Some(symbol), Some(address), Some(decimals)) = (symbol, address, decimals) else {
        return Err(format!(
            "the account's Aave {what} lacks its symbol, 0x address or decimals"
        ));
    };
    let engine = evm_engine_name(symbol).ok_or_else(|| {
        format!("the account's Aave settings list token {symbol:?}, which version 0 doesn't price")
    })?;
    Ok(EvmToken {
        symbol: symbol.to_string(),
        engine,
        address: address.to_ascii_lowercase(),
        decimals: decimals as u32,
    })
}

/// `get_config().lenders` (INTERFACES.md 24). `tokens` are the account's own NEAR tokens: Rhea's collateral must be
/// among them, since that is where it comes from and how it is priced.
pub fn lender_conf(v: Option<&Value>, tokens: &[TokenConf]) -> Result<LenderConf, String> {
    let Some(v) = v.filter(|v| !v.is_null()) else {
        return Ok(LenderConf::default());
    };
    let mut out = LenderConf::default();
    if let Some(r) = v.get("rhea").filter(|r| !r.is_null()) {
        let contract_id = r
            .get("contract_id")
            .and_then(Value::as_str)
            .filter(|c| crate::request::is_account_id(c))
            .ok_or("the account's Rhea settings have no contract_id")?;
        let mut collateral = Vec::new();
        for c in r
            .get("collateral")
            .and_then(Value::as_array)
            .ok_or("the account's Rhea settings have no collateral list")?
        {
            let id = c
                .as_str()
                .ok_or("a Rhea collateral token in the account's config is not a token id")?;
            match tokens.iter().find(|t| t.id == id) {
                Some(t) if t.name != "USDC" && !collateral.iter().any(|x| x == id) => {
                    collateral.push(id.to_string())
                }
                _ => {
                    return Err(format!(
                        "the account's Rhea collateral {id} is listed twice, or is not one of its own tokens"
                    ))
                }
            }
        }
        out.rhea = Some(RheaConf {
            contract_id: contract_id.to_string(),
            collateral,
        });
    }
    if let Some(a) = v.get("aave").filter(|a| !a.is_null()) {
        let chain_id = a
            .get("chain_id")
            .and_then(u64_of)
            .ok_or("the account's Aave settings have no chain_id")?;
        let pool = a
            .get("pool")
            .and_then(Value::as_str)
            .filter(|p| is_evm_address(p))
            .ok_or("the account's Aave settings have no pool address")?;
        let usdc = evm_token(a.get("usdc"), "usdc")?;
        if usdc.engine != "USDC" {
            return Err("the account's Aave usdc is not USDC".into());
        }
        let mut collateral: Vec<EvmToken> = Vec::new();
        for c in a
            .get("collateral")
            .and_then(Value::as_array)
            .ok_or("the account's Aave settings have no collateral list")?
        {
            let t = evm_token(Some(c), "collateral token")?;
            // One token per engine name: the book and the lender's prices are kept by that name.
            let twice = collateral.iter().any(|x| x.address == t.address || x.engine == t.engine);
            if t.engine == "USDC" || t.address == usdc.address || twice {
                return Err(format!(
                    "the account's Aave collateral {} is listed twice, or is its USDC",
                    t.symbol
                ));
            }
            collateral.push(t);
        }
        out.aave = Some(AaveConf {
            chain_id,
            pool: pool.to_ascii_lowercase(),
            usdc,
            collateral,
        });
    }
    Ok(out)
}

pub fn config(v: &Value) -> Result<Config, String> {
    let tokens = v
        .get("tokens")
        .and_then(Value::as_array)
        .ok_or("the account's config has no token list")?;
    let mut out: Vec<TokenConf> = Vec::new();
    for t in tokens {
        let id = t.get("id").and_then(Value::as_str);
        let symbol = t.get("symbol").and_then(Value::as_str);
        let decimals = t.get("decimals").and_then(u64_of);
        let (Some(id), Some(symbol), Some(decimals)) = (id, symbol, decimals) else {
            return Err("a token in the account's config lacks its id, symbol or decimals".into());
        };
        let name = TOKEN_NAMES
            .iter()
            .find(|(p, _)| *p == symbol)
            .ok_or_else(|| {
                format!(
                    "the account's config lists token {symbol:?}, which version 0 doesn't price"
                )
            })?;
        if decimals > 24 || out.iter().any(|o| o.id == id || o.name == name.0) {
            return Err(format!(
                "the account's config lists {symbol} twice or with {decimals} decimals"
            ));
        }
        out.push(TokenConf {
            id: id.to_string(),
            name: name.0,
            engine: name.1,
            decimals: decimals as u32,
        });
    }
    let pool_id = v
        .get("pool_id")
        .and_then(Value::as_str)
        .ok_or("the account's config has no pool_id")?;
    let lenders = lender_conf(v.get("lenders"), &out)?;
    Ok(Config {
        tokens: out,
        pool_id: pool_id.to_string(),
        lenders,
    })
}

/// One hour of the account's record (the lowest hedge ratio and the highest exposure share seen that hour).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HourRecord {
    pub hour: u64,
    pub hr_bp_min: u64,
    pub exp_bp_max: u64,
}

/// The account's `get_state` (INTERFACES.md 4), the parts the verdict uses.
#[derive(Clone, Debug, PartialEq)]
pub struct ClientState {
    pub counter: u64,
    pub blocked: bool,
    /// The state of the verdict the account holds, for hysteresis.
    pub prev_state: Option<State>,
    /// The margin-call clock: when the current call started (0 if none), and the periods below MR.
    pub mc_since_ns: u64,
    pub mc_intervals: Vec<(u64, u64)>,
    /// Whether the latest verdict was below MR (`margin_call.below`, Phase 3 accounts on). While it is, the last
    /// interval is still open. None for an account that doesn't keep it.
    pub mc_below: Option<bool>,
    pub hourly: Vec<HourRecord>,
    pub hl_address: Option<String>,
    /// The nonces (unix ms) of the transfers out of Hyperliquid that the account asked its signer to sign and that
    /// no accepted verdict has named as sent (`hl.open_sends`, INTERFACES.md 50.2). Empty on an account made
    /// before 14 Nov, which doesn't keep the list.
    pub open_sends: Vec<u64>,
    /// 1Click transfers under way (`pending`, INTERFACES.md 14).
    pub transfers: Vec<Transfer>,
    /// Phase 6 (INTERFACES.md 25), all absent on accounts made before it. The owner's permission for lenders.
    pub permission: Option<Permission>,
    /// The funding plan as the account stores it, finished and expired ones included ([`live_funding`] filters).
    pub funding: Option<StoredFunding>,
    /// The account's Ethereum transactions: its own nonce counter and what it signed lately.
    pub evm: Option<EvmState>,
    /// Lender actions under way (`pending`'s `lender` entries).
    pub lender_pending: Vec<LenderPending>,
}

/// `get_state().permission`: which lenders the owner allows, and on what terms.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Permission {
    pub lenders: Vec<String>,
    pub min_hf_bp: u32,
    pub max_rate_bp: u32,
    /// `off`, `lower_cost_only` or `any`.
    pub moves: String,
}

fn permission(v: Option<&Value>) -> Result<Option<Permission>, String> {
    let Some(v) = v.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let bad = |k: &str| format!("the permission in the account's state has no valid {k}");
    let mut lenders = Vec::new();
    for l in v
        .get("lenders")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("lenders"))?
    {
        match l.as_str() {
            Some(l) if l == crate::lenders::AAVE || l == crate::lenders::RHEA => lenders.push(l.to_string()),
            _ => return Err(bad("lenders")),
        }
    }
    let small = |k: &str| {
        v.get(k)
            .and_then(u64_of)
            .and_then(|x| u32::try_from(x).ok())
            .ok_or_else(|| bad(k))
    };
    let moves = match v.get("moves").and_then(Value::as_str) {
        Some(m @ ("off" | "lower_cost_only" | "any")) => m.to_string(),
        _ => return Err(bad("moves")),
    };
    Ok(Some(Permission {
        lenders,
        min_hf_bp: small("min_hf_bp")?,
        max_rate_bp: small("max_rate_bp")?,
        moves,
    }))
}

fn funding(v: Option<&Value>) -> Result<Option<StoredFunding>, String> {
    let Some(v) = v.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let bad = |k: &str| format!("the funding plan in the account's state has no valid {k}");
    let pid = v
        .get("pid")
        .and_then(Value::as_str)
        .filter(|p| p.starts_with('f') && p.len() > 1)
        .ok_or_else(|| bad("pid"))?;
    let mut steps = Vec::new();
    for st in v
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("steps"))?
    {
        let step: PlanStep = serde_json::from_value(st.clone()).map_err(|_| bad("step"))?;
        let done = st.get("done").and_then(Value::as_bool).unwrap_or(false);
        steps.push((step, done));
    }
    Ok(Some(StoredFunding {
        pid: pid.to_string(),
        amount_micro: v
            .get("amount")
            .and_then(u128_of)
            .ok_or_else(|| bad("amount"))?,
        expires_ns: v
            .get("expires_at")
            .and_then(u64_of)
            .ok_or_else(|| bad("expires_at"))?,
        steps,
    }))
}

/// The funding plan the account holds, only while it has unfinished steps and hasn't expired at `now_ns`.
pub fn live_funding(client: &ClientState, now_ns: u64) -> Option<StoredFunding> {
    client
        .funding
        .clone()
        .filter(|f| now_ns < f.expires_ns && f.steps.iter().any(|(_, done)| !done))
}

/// One Ethereum transaction the account signed (`get_state().evm.signed`), the parts the book uses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedTx {
    pub nonce: u64,
    /// `approve`, `supply`, `borrow`, `repay`, `withdraw` or `transfer`.
    pub kind: String,
    /// The token's 0x address, lower case.
    pub token: String,
    /// In the token's own units.
    pub amount: u128,
}

/// `get_state().evm`: the nonce the account's next Ethereum transaction will carry, and the newest it signed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EvmState {
    pub nonce: u64,
    pub signed: Vec<SignedTx>,
}

fn evm_state(v: Option<&Value>) -> Result<Option<EvmState>, String> {
    let Some(v) = v.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let bad = |k: &str| format!("the Ethereum record in the account's state has no valid {k}");
    let mut signed = Vec::new();
    for t in v
        .get("signed")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
    {
        signed.push(SignedTx {
            nonce: t
                .get("nonce")
                .and_then(u64_of)
                .ok_or_else(|| bad("signed nonce"))?,
            kind: t
                .get("kind")
                .and_then(Value::as_str)
                .ok_or_else(|| bad("signed kind"))?
                .to_string(),
            token: t
                .get("token")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase(),
            amount: t
                .get("amount")
                .and_then(u128_of)
                .ok_or_else(|| bad("signed amount"))?,
        });
    }
    Ok(Some(EvmState {
        nonce: v.get("nonce").and_then(u64_of).ok_or_else(|| bad("nonce"))?,
        signed,
    }))
}

/// A lender action under way, an entry of `pending`. The account can't see the lender finish it, so it lists it for
/// a while, and for that while the lender may or may not show it yet. The engine counts it as done
/// (`lenders::pending_borrows`, `lenders::leaving`, `lenders::evm_under_way`); after that it counts for nothing.
/// - **Rhea's** (INTERFACES.md 25): `{"lender": {"lender": "rhea", "kind", "amount", "until_block"}}`, and a
///   withdrawal's `token`.
/// - **Aave's** (INTERFACES.md 33): `{"lender": {"lender": "aave", "kind", "amount", "token", "evm_nonce"}}`, the
///   Ethereum nonce of the transaction the account signed for it. Its `kind` may also be `transfer`: a token sent
///   away from the account's Ethereum address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LenderPending {
    pub lender: String,
    /// `borrow`, `withdraw`, or for Aave `transfer`. Any other kind is read and counts for nothing.
    pub kind: String,
    /// Micro-USD for a borrow at Rhea; otherwise the token's own units.
    pub amount: u128,
    /// The token, if the entry names it: a NEAR id, or a 0x address in lower case.
    pub token: Option<String>,
    pub until: Wait,
}

/// How long a lender action counts as under way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wait {
    /// Up to and including this NEAR block (`until_block`).
    Block(u64),
    /// While the chain's count of the account's Ethereum transactions is at most this nonce (`evm_nonce`): the
    /// chain hasn't used the nonce yet. Once it has, mined or reverted, the chain's own reading is the truth.
    EvmNonce(u64),
}

impl LenderPending {
    /// Whether a wait by block is still on at NEAR block `height`. False for a wait by nonce.
    pub fn waits_at_block(&self, height: u64) -> bool {
        matches!(self.until, Wait::Block(until) if height <= until)
    }
}

fn lender_pending(v: &Value) -> Result<LenderPending, String> {
    let text = |k: &str| v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
    let bad = |k: &str| format!("a pending lender action in the account's state has no valid {k}");
    let lender = text("lender")
        .filter(|l| *l == crate::lenders::AAVE || *l == crate::lenders::RHEA)
        .ok_or_else(|| bad("lender"))?;
    Ok(LenderPending {
        lender: lender.to_string(),
        kind: text("kind").ok_or_else(|| bad("kind"))?.to_string(),
        amount: v
            .get("amount")
            .and_then(u128_of)
            .ok_or_else(|| bad("amount"))?,
        token: match v.get("token") {
            None | Some(Value::Null) => None,
            Some(_) => Some(text("token").ok_or_else(|| bad("token"))?.to_ascii_lowercase()),
        },
        // Aave's entry carries the nonce of its signed transaction; Rhea's, and an older Aave entry, a block.
        until: match (lender, v.get("evm_nonce").and_then(u64_of), v.get("until_block").and_then(u64_of)) {
            (crate::lenders::AAVE, Some(nonce), _) => Wait::EvmNonce(nonce),
            (_, _, Some(block)) => Wait::Block(block),
            (crate::lenders::AAVE, None, None) => return Err(bad("evm_nonce")),
            _ => return Err(bad("until_block")),
        },
    })
}

impl ClientState {
    /// RISK_ENGINE.md 8.1: the margin-call clock now, in hours below MR over the last 24, counted as the account
    /// counts it ([`margin_clock_hours`]), or for an account that doesn't keep `below`, by [`margin_call_hours`].
    pub fn margin_call_age_h(&self, now_ns: u64) -> f64 {
        match self.mc_below {
            Some(below) => margin_clock_hours(&self.mc_intervals, below, now_ns),
            None => margin_call_hours(self.mc_since_ns, &self.mc_intervals, now_ns),
        }
    }
}

/// What a pending 1Click transfer carries (INTERFACES.md 14).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransferKind {
    /// A plan's sale of a NEAR token; 1Click pays USDC back.
    Sell,
    /// USDC from NEAR to the account's Hyperliquid address.
    ToHl,
    /// Perp USDC from Hyperliquid back to NEAR.
    Home,
    /// A NEAR token (nBTC, or USDC) to the account's own address on Aave's chain (INTERFACES.md 36).
    ToEvm,
    /// USDC or a collateral token from that address back to the account on NEAR.
    EHome,
}

impl TransferKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TransferKind::Sell => "sell",
            TransferKind::ToHl => "to_hl",
            TransferKind::Home => "home",
            TransferKind::ToEvm => "to_evm",
            TransferKind::EHome => "e_home",
        }
    }
}

/// One pending 1Click transfer: `{"transfer": {"id", "kind", "token", "amount", "dep", "deadline"}}`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transfer {
    /// `<pid>:<i>` for a plan step, `move:<n>` for the owner's own move.
    pub id: String,
    pub kind: TransferKind,
    /// The token contract sent, or `USDC` for Hyperliquid's USDC (a `home` transfer). For an `e_home` transfer:
    /// `USDC` for Aave's USDC, or a collateral token's 0x address on Aave's chain.
    pub token: String,
    /// In the token's units; for `USDC`, micro-USDC, as `hl_withdraw` takes it.
    pub amount: u128,
    pub dep: String,
    /// The quote's expiry plus 30 minutes (block time, ns). Past it the transfer is overdue.
    pub deadline_ns: u64,
}

fn transfer(v: &Value) -> Result<Transfer, String> {
    let text = |k: &str| v.get(k).and_then(Value::as_str);
    let bad = |k: &str| format!("a pending transfer in the account's state has no valid {k}");
    let kind = match text("kind") {
        Some("sell") => TransferKind::Sell,
        Some("to_hl") => TransferKind::ToHl,
        Some("home") => TransferKind::Home,
        Some("to_evm") => TransferKind::ToEvm,
        Some("e_home") => TransferKind::EHome,
        _ => return Err(bad("kind")),
    };
    Ok(Transfer {
        id: text("id")
            .filter(|s| !s.is_empty())
            .ok_or_else(|| bad("id"))?
            .to_string(),
        kind,
        token: text("token")
            .filter(|s| !s.is_empty())
            .ok_or_else(|| bad("token"))?
            .to_string(),
        amount: v
            .get("amount")
            .and_then(u128_of)
            .ok_or_else(|| bad("amount"))?,
        dep: text("dep").unwrap_or("").to_string(),
        deadline_ns: v
            .get("deadline")
            .and_then(u64_of)
            .ok_or_else(|| bad("deadline"))?,
    })
}

pub fn state(v: &Value) -> Result<ClientState, String> {
    let counter = v
        .get("counter")
        .and_then(u64_of)
        .ok_or("the account's state has no counter")?;
    let prev_state = v
        .pointer("/verdict/verdict/state")
        .and_then(Value::as_str)
        .and_then(State::parse);
    let mc = v.get("margin_call");
    let mc_since_ns = mc
        .and_then(|m| m.get("since"))
        .and_then(u64_of)
        .unwrap_or(0);
    let mut mc_intervals = Vec::new();
    for i in mc
        .and_then(|m| m.get("intervals"))
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
    {
        match (i.get(0).and_then(u64_of), i.get(1).and_then(u64_of)) {
            (Some(s), Some(e)) => mc_intervals.push((s, e)),
            _ => {
                return Err(
                    "a margin-call interval in the account's state is not [start, end]".into(),
                )
            }
        }
    }
    let mut hourly = Vec::new();
    for h in v
        .get("hourly")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
    {
        let field = |k: &str| h.get(k).and_then(u64_of);
        match (field("hour"), field("hr_bp_min"), field("exp_bp_max")) {
            (Some(hour), Some(hr_bp_min), Some(exp_bp_max)) => hourly.push(HourRecord {
                hour,
                hr_bp_min,
                exp_bp_max,
            }),
            _ => {
                return Err(
                    "an hourly record in the account's state lacks hour, hr_bp_min or exp_bp_max"
                        .into(),
                )
            }
        }
    }
    let hl_address = match v.pointer("/hl/address") {
        None | Some(Value::Null) => None,
        Some(Value::String(a)) if is_evm_address(a) => Some(a.to_ascii_lowercase()),
        Some(_) => return Err("the account's Hyperliquid address is not a 0x address".into()),
    };
    // INTERFACES.md 50.2. The account writes each nonce as a string; a number reads the same. An entry that is
    // neither is left out, and so is a list that isn't one: the engine then never names that transfer as sent, and
    // the account's pause runs its full time, which is the safe side.
    let open_sends = v
        .pointer("/hl/open_sends")
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |list| list.iter().filter_map(u64_of).collect());
    // Other kinds of pending entry (a borrow from our pool under way) are not money in transit. `pending` is a
    // list, one entry per action: any other shape is refused, so an action under way is never read as none.
    let pending = match v.get("pending") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(list)) => list.as_slice(),
        Some(_) => return Err("the pending actions in the account's state are not a list".into()),
    };
    let mut transfers = Vec::new();
    let mut lender_actions = Vec::new();
    for p in pending {
        if let Some(t) = p.get("transfer") {
            transfers.push(transfer(t)?);
        }
        if let Some(l) = p.get("lender") {
            lender_actions.push(lender_pending(l)?);
        }
    }
    Ok(ClientState {
        counter,
        blocked: v.get("blocked").and_then(Value::as_bool).unwrap_or(false),
        prev_state,
        mc_since_ns,
        mc_intervals,
        mc_below: mc.and_then(|m| m.get("below")).and_then(Value::as_bool),
        hourly,
        hl_address,
        open_sends,
        transfers,
        permission: permission(v.get("permission"))?,
        funding: funding(v.get("funding"))?,
        evm: evm_state(v.get("evm"))?,
        lender_pending: lender_actions,
    })
}

/// `0x` and 40 hex digits.
pub fn is_evm_address(a: &str) -> bool {
    a.len() == 42 && a.starts_with("0x") && a[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// An `ft_balance_of` result.
pub fn balance(v: Option<&Value>) -> Result<u128, String> {
    v.and_then(u128_of)
        .ok_or_else(|| "a token balance is missing or not a U128".to_string())
}

/// The pool's `get_pool`, the parts the engine uses: capital and loans (micro-USDC), the pause, and the NEAR-side
/// holdings of accounts with a loan, per token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolState {
    pub capital: u128,
    pub loans: u128,
    pub paused: bool,
    pub book: BTreeMap<String, u128>,
}

pub fn pool(v: &Value) -> Result<PoolState, String> {
    let amount = |k: &str| {
        v.get(k)
            .and_then(u128_of)
            .ok_or_else(|| format!("the pool's get_pool has no {k}"))
    };
    let mut book = BTreeMap::new();
    if let Some(b) = v.get("book").and_then(Value::as_object) {
        for (token, e) in b {
            if let Some(a) = e.get("amount").and_then(u128_of) {
                book.insert(token.clone(), a);
            }
        }
    }
    Ok(PoolState {
        capital: amount("capital")?,
        loans: amount("loans")?,
        paused: v.get("paused").and_then(Value::as_bool).unwrap_or(false),
        book,
    })
}

/// The pool's minimum time between tier upgrades (`get_params().periods.upgrade_ns`), 30 days if not given.
pub fn upgrade_ns(params: &Value) -> u64 {
    params
        .pointer("/periods/upgrade_ns")
        .and_then(u64_of)
        .unwrap_or(30 * DAY_NS)
}

/// The pool's `get_borrower(account)`: the debt with interest, and what limits the verdict's tier.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Borrower {
    pub debt: u128,
    /// The tier from the last verdict the pool accepted (none before the first borrow).
    pub history_tier: Option<ClientTier>,
    pub last_upgrade_at: Option<u64>,
    pub kyb: bool,
    /// The operator's override and when it expires (ns).
    pub override_tier: Option<(ClientTier, u64)>,
    pub blocked: bool,
    /// The holdings the account's last borrow verdict reported (micro-USDC per token).
    pub hold: BTreeMap<String, u128>,
}

/// `None` when the account isn't registered with the pool.
pub fn borrower(v: &Value) -> Result<Option<Borrower>, String> {
    if v.is_null() {
        return Ok(None);
    }
    let tier = |x: Option<&Value>| -> Result<Option<ClientTier>, String> {
        match x {
            None | Some(Value::Null) => Ok(None),
            Some(t) => serde_json::from_value(t.clone())
                .map(Some)
                .map_err(|_| format!("the pool's get_borrower has an unknown tier {t}")),
        }
    };
    let override_tier = match v.get("tier_override") {
        None | Some(Value::Null) => None,
        Some(o) => {
            let t = tier(o.get("tier"))?.ok_or("the pool's tier override has no tier")?;
            let exp = o
                .get("expires_at")
                .and_then(u64_of)
                .ok_or("the pool's tier override has no expiry")?;
            Some((t, exp))
        }
    };
    let mut hold = BTreeMap::new();
    if let Some(h) = v.get("hold").and_then(Value::as_object) {
        for (token, a) in h {
            if let Some(a) = u128_of(a) {
                hold.insert(token.clone(), a);
            }
        }
    }
    Ok(Some(Borrower {
        debt: v
            .get("debt")
            .and_then(u128_of)
            .ok_or("the pool's get_borrower has no debt")?,
        history_tier: tier(v.get("history_tier"))?,
        last_upgrade_at: v.get("last_upgrade_at").and_then(u64_of),
        kyb: v.get("kyb_entity").is_some_and(|k| !k.is_null()),
        override_tier,
        blocked: v.get("blocked").and_then(Value::as_bool).unwrap_or(false),
        hold,
    }))
}

/// PLAN.md 5.1, the pool's tier rule, so the verdict never claims a tier the pool would refuse. An unexpired
/// override sets the tier. Otherwise the score's tier stands, but no better than the tier history while the
/// 30 days since the last upgrade run. Preferred needs the KYB flag in every case.
pub fn verdict_tier(
    score_tier: ClientTier,
    b: Option<&Borrower>,
    now_ns: u64,
    upgrade_ns: u64,
) -> ClientTier {
    let Some(b) = b else {
        return score_tier.max(ClientTier::Standard);
    };
    let tier = match b.override_tier {
        Some((t, expires)) if now_ns < expires => t,
        _ => {
            let cap = match (b.history_tier, b.last_upgrade_at) {
                (Some(h), Some(at)) if now_ns < at.saturating_add(upgrade_ns) => h,
                _ => ClientTier::Preferred,
            };
            // ClientTier orders Preferred < Standard < Watch: the worse of the two is the larger.
            score_tier.max(cap)
        }
    };
    if tier == ClientTier::Preferred && !b.kyb {
        ClientTier::Standard
    } else {
        tier
    }
}

/// The pool's `coin_statuses`: `[[name, {"status": ..., "since": ..., "emergency": ...}], ...]` as name → status
/// (allowed, reduce_only, removed or frozen).
pub fn statuses(v: &Value) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    for e in v
        .as_array()
        .ok_or("the pool's coin_statuses is not a list")?
    {
        let name = e.get(0).and_then(Value::as_str);
        let status = e
            .get(1)
            .and_then(|s| s.get("status"))
            .and_then(Value::as_str);
        match (name, status) {
            (Some(n), Some(s)) => {
                out.insert(n.to_string(), s.to_string());
            }
            _ => return Err("an entry of the pool's coin_statuses is not [name, {status}]".into()),
        }
    }
    Ok(out)
}

/// The drill's `get_ratio`, in basis points (10,000 = 1.0), if it was read.
pub fn drill_bp(v: &Value) -> Option<u64> {
    v.get("bp").and_then(u64_of)
}

/// RISK_ENGINE.md 8.1: hours below MR over the last 24, as the account counts them (`MarginCall::total` in
/// `contracts/account/src/records.rs`): each interval from its start, or 24 hours ago, to its end; while the latest
/// verdict was below (`below`), the last interval runs to now. Between two verdicts the time counts as below if the
/// earlier one said so, so a dip back into WATCH within a call doesn't count.
pub fn margin_clock_hours(intervals: &[(u64, u64)], below: bool, now_ns: u64) -> f64 {
    let cutoff = now_ns.saturating_sub(DAY_NS);
    let n = intervals.len();
    let total = intervals
        .iter()
        .enumerate()
        .map(|(i, &(start, end))| {
            let end = if below && i + 1 == n {
                now_ns
            } else {
                end.min(now_ns)
            };
            end.saturating_sub(start.max(cutoff))
        })
        .fold(0u64, u64::saturating_add);
    total as f64 / HOUR_NS as f64
}

/// RISK_ENGINE.md 8.1, for accounts that don't keep `below`: hours below MR over the last 24, from the contract's
/// closed intervals and the open call (`since` > 0, running up to now). Overlaps are merged, so no moment counts
/// twice.
pub fn margin_call_hours(since_ns: u64, intervals: &[(u64, u64)], now_ns: u64) -> f64 {
    let start = now_ns.saturating_sub(DAY_NS);
    let mut spans: Vec<(u64, u64)> = intervals
        .iter()
        .copied()
        .chain((since_ns > 0).then_some((since_ns, now_ns)))
        .map(|(s, e)| (s.max(start), e.min(now_ns)))
        .filter(|(s, e)| s < e)
        .collect();
    spans.sort_unstable();
    let (mut total, mut reach) = (0u64, 0u64);
    for (s, e) in spans {
        let s = s.max(reach);
        if e > s {
            total += e - s;
            reach = e;
        }
    }
    total as f64 / HOUR_NS as f64
}

/// The hour index the account's record uses: block time in whole hours since 1970.
pub fn hour_of(ns: u64) -> u64 {
    ns / HOUR_NS
}

/// RISK_ENGINE.md 6: the 7-day averages of the hourly record, in basis points, with this reading in the current
/// hour (the lowest hedge ratio and the highest share, as the contract keeps them). An account younger than a week
/// averages its life so far; one with no record has only this reading.
pub fn week_averages(
    hourly: &[HourRecord],
    hour_now: u64,
    hr_now_bp: u64,
    exp_now_bp: u64,
) -> (f64, f64) {
    let first = hour_now.saturating_sub(167);
    let mut by_hour: BTreeMap<u64, (u64, u64)> = BTreeMap::new();
    for r in hourly
        .iter()
        .filter(|r| r.hour >= first && r.hour <= hour_now)
    {
        let e = by_hour.entry(r.hour).or_insert((r.hr_bp_min, r.exp_bp_max));
        *e = (e.0.min(r.hr_bp_min), e.1.max(r.exp_bp_max));
    }
    let now = by_hour.entry(hour_now).or_insert((hr_now_bp, exp_now_bp));
    *now = (now.0.min(hr_now_bp), now.1.max(exp_now_bp));
    let n = by_hour.len() as f64;
    let hr: u64 = by_hour.values().map(|v| v.0).sum();
    let exp: u64 = by_hour.values().map(|v| v.1).sum();
    (hr as f64 / n, exp as f64 / n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn borrower_with(v: Value) -> Borrower {
        borrower(&v).unwrap().unwrap()
    }

    #[test]
    fn tiers_follow_the_pools_rule() {
        let (now, month) = (100 * DAY_NS, 30 * DAY_NS);
        let fresh = borrower_with(json!({"debt": "0", "tier": "STANDARD", "history_tier": null}));
        assert_eq!(
            verdict_tier(ClientTier::Standard, Some(&fresh), now, month),
            ClientTier::Standard
        );
        // Preferred needs the KYB flag.
        assert_eq!(
            verdict_tier(ClientTier::Preferred, Some(&fresh), now, month),
            ClientTier::Standard
        );
        let kyb =
            borrower_with(json!({"debt": "0", "kyb_entity": "acme", "history_tier": "STANDARD"}));
        assert_eq!(
            verdict_tier(ClientTier::Preferred, Some(&kyb), now, month),
            ClientTier::Preferred
        );
        // An upgrade 10 days ago: no other upgrade for 30 days, but a downgrade at once.
        let recent = borrower_with(
            json!({"debt": "5", "kyb_entity": "acme", "history_tier": "STANDARD",
                                          "last_upgrade_at": (now - 10 * DAY_NS).to_string()}),
        );
        assert_eq!(
            verdict_tier(ClientTier::Preferred, Some(&recent), now, month),
            ClientTier::Standard
        );
        assert_eq!(
            verdict_tier(ClientTier::Watch, Some(&recent), now, month),
            ClientTier::Watch
        );
        let old = borrower_with(
            json!({"debt": "5", "kyb_entity": "acme", "history_tier": "WATCH",
                                       "last_upgrade_at": (now - 31 * DAY_NS).to_string()}),
        );
        assert_eq!(
            verdict_tier(ClientTier::Preferred, Some(&old), now, month),
            ClientTier::Preferred
        );
        // An unexpired override sets the tier; an expired one is ignored.
        let ov = |exp: u64| {
            borrower_with(json!({"debt": "0", "tier_override":
            {"tier": "WATCH", "reason": "review", "expires_at": exp.to_string()}}))
        };
        assert_eq!(
            verdict_tier(ClientTier::Standard, Some(&ov(now + 1)), now, month),
            ClientTier::Watch
        );
        assert_eq!(
            verdict_tier(ClientTier::Standard, Some(&ov(now)), now, month),
            ClientTier::Standard
        );
        // Not registered: Standard at best.
        assert_eq!(
            verdict_tier(ClientTier::Standard, None, now, month),
            ClientTier::Standard
        );
    }

    #[test]
    fn the_margin_clock_counts_each_moment_once_within_a_day() {
        let h = HOUR_NS;
        let now = 100 * h;
        assert_eq!(margin_call_hours(0, &[], now), 0.0);
        // Closed: 2 h, one of them older than a day.
        assert_eq!(margin_call_hours(0, &[(75 * h, 77 * h)], now), 1.0);
        // An open call for 1.5 h, overlapping a recorded interval.
        let open = now - 3 * h / 2;
        assert_eq!(margin_call_hours(open, &[(now - h, now - h / 2)], now), 1.5);
        assert_eq!(margin_call_hours(open, &[(80 * h, 81 * h)], now), 2.5);
    }

    #[test]
    fn the_clock_counts_as_the_account_does() {
        let h = HOUR_NS;
        let now = 100 * h;
        // Below 1 h, back in WATCH for 1 h (the call still open), then below again since 30 minutes: 1.5 h, not the
        // 2.5 h since the call started.
        let intervals = [
            (now - 5 * h / 2, now - 3 * h / 2),
            (now - h / 2, now - h / 2),
        ];
        assert_eq!(margin_clock_hours(&intervals, true, now), 1.5);
        // Back above MR at the last verdict: the last interval is closed where it ended.
        assert_eq!(margin_clock_hours(&intervals, false, now), 1.0);
        // Only the last 24 hours count.
        assert_eq!(margin_clock_hours(&[(70 * h, 80 * h)], false, now), 4.0);
        assert_eq!(margin_clock_hours(&[], false, now), 0.0);
        let st = state(&json!({"counter": 1, "margin_call": {"since": (now - 5 * h / 2).to_string(), "below": true,
            "intervals": [[(now - 5 * h / 2).to_string(), (now - 3 * h / 2).to_string()],
                          [(now - h / 2).to_string(), (now - h / 2).to_string()]]}})).unwrap();
        assert_eq!(st.margin_call_age_h(now), 1.5);
        // An account that doesn't keep `below` counts from `since`.
        let old = state(&json!({"counter": 1, "margin_call": {"since": (now - h).to_string(), "intervals": []}})).unwrap();
        assert_eq!((old.mc_below, old.margin_call_age_h(now)), (None, 1.0));
    }

    #[test]
    fn pending_transfers_parse() {
        let st = state(&json!({"counter": 1, "pending": [{"borrow": {"amount": "5"}},
            {"transfer": {"id": "276800123:1", "kind": "sell", "token": "mnbtc.pbf-ops.testnet", "amount": "375000",
                          "dep": "ab", "deadline": "1794000000000000000"}},
            {"transfer": {"id": "move:4", "kind": "to_hl", "token": "musdc.pbf-ops.testnet", "amount": "430000000",
                          "dep": "cd", "deadline": "1794000000000000001"}}]})).unwrap();
        assert_eq!(st.transfers.len(), 2);
        // Stage 4's two kinds (INTERFACES.md 36): a NEAR token to the account's address on Aave's chain, and USDC
        // or a collateral token back from there.
        let moves = state(&json!({"counter": 1, "pending": [
            {"transfer": {"id": "move:5", "kind": "to_evm", "token": "mnbtc.pbf-ops.testnet", "amount": "55000",
                          "dep": "f00d", "deadline": "1794000000000000002"}},
            {"transfer": {"id": "move:6", "kind": "e_home", "token": "USDC", "amount": "23033364",
                          "dep": "0x2031181d63507368232579af4c64a1c3428407ff", "deadline": "1794000000000000003"}},
            {"transfer": {"id": "move:7", "kind": "e_home", "token": "0x4200000000000000000000000000000000000006",
                          "amount": "20000000000000000", "dep": "0x2031181d63507368232579af4c64a1c3428407ff",
                          "deadline": "1794000000000000004"}}]})).unwrap();
        let kinds: Vec<&str> = moves.transfers.iter().map(|t| t.kind.as_str()).collect();
        assert_eq!(kinds, ["to_evm", "e_home", "e_home"]);
        assert_eq!((moves.transfers[1].token.as_str(), moves.transfers[2].amount), ("USDC", 20_000_000_000_000_000));
        assert_eq!(
            (
                st.transfers[0].kind,
                st.transfers[0].amount,
                st.transfers[1].id.as_str()
            ),
            (TransferKind::Sell, 375_000, "move:4")
        );
        assert!(state(
            &json!({"counter": 1, "pending": [{"transfer": {"id": "x", "kind": "fly", "token": "t",
            "amount": "1", "deadline": "1"}}]})
        )
        .unwrap_err()
        .contains("kind"));
    }

    fn lender_config() -> Value {
        json!({"tokens": [{"id": "musdc.pbf-ops.testnet", "symbol": "USDC", "decimals": 6},
                {"id": "mnbtc.pbf-ops.testnet", "symbol": "nBTC", "decimals": 8}], "pool_id": "pool.pbf.testnet",
            "lenders": {"rhea": {"contract_id": "rhea.pbf-ops.testnet", "collateral": ["mnbtc.pbf-ops.testnet"]},
                "aave": {"chain_id": 84532, "pool": "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
                    "usdc": {"symbol": "USDC", "address": "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", "decimals": 6},
                    "collateral": [{"symbol": "WBTC", "address": "0x54114591963CF60EF3aA63bEfD6eC263D98145a4",
                                    "decimals": 8}],
                    "max_fee_per_gas": "5000000000"}}})
    }

    #[test]
    fn the_lender_settings_parse_and_an_old_config_has_none() {
        let old = config(&json!({"tokens": [], "pool_id": "pool.pbf.testnet"})).unwrap();
        assert!(old.lenders.is_empty());
        let null = config(&json!({"tokens": [], "pool_id": "p", "lenders": null})).unwrap();
        assert!(null.lenders.is_empty());
        let conf = config(&lender_config()).unwrap();
        let rhea = conf.lenders.rhea.as_ref().unwrap();
        assert_eq!(rhea.contract_id, "rhea.pbf-ops.testnet");
        assert_eq!(rhea.collateral, ["mnbtc.pbf-ops.testnet"]);
        let aave = conf.lenders.aave.as_ref().unwrap();
        assert_eq!((aave.chain_id, aave.pool.as_str()), (84532, "0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27"));
        assert_eq!(
            (aave.usdc.engine, aave.usdc.address.as_str(), aave.usdc.decimals),
            ("USDC", "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f", 6)
        );
        assert_eq!(
            (aave.collateral[0].engine, aave.collateral[0].address.as_str(), aave.collateral[0].decimals),
            ("WBTC", "0x54114591963cf60ef3aa63befd6ec263d98145a4", 8)
        );
        // One lender alone is fine.
        let mut only = lender_config();
        only["lenders"].as_object_mut().unwrap().remove("aave");
        let conf = config(&only).unwrap();
        assert!(conf.lenders.aave.is_none() && conf.lenders.rhea.is_some());
        // Refusals say what to fix.
        let bad = |path: &str, v: Value| {
            let mut c = lender_config();
            *c.pointer_mut(path).unwrap() = v;
            config(&c).unwrap_err()
        };
        assert!(bad("/lenders/rhea/collateral", json!(["wbtc.fakes.testnet"])).contains("not one of its own tokens"));
        assert!(bad("/lenders/rhea/collateral", json!(["musdc.pbf-ops.testnet"])).contains("not one of its own tokens"));
        assert!(bad("/lenders/rhea/contract_id", json!(7)).contains("contract_id"));
        assert!(bad("/lenders/aave/pool", json!("0x8bAB")).contains("pool address"));
        assert!(bad("/lenders/aave/chain_id", json!("base")).contains("chain_id"));
        assert!(bad("/lenders/aave/collateral/0/symbol", json!("cbBTC")).contains("doesn't price"));
        assert!(bad("/lenders/aave/collateral/0/address", json!("wbtc.near")).contains("0x address"));
        assert!(bad("/lenders/aave/usdc/symbol", json!("WBTC")).contains("not USDC"));
    }

    #[test]
    fn open_sends_are_read_as_strings_or_numbers_and_an_older_account_has_none() {
        // INTERFACES.md 50.2: `get_state().hl.open_sends`, oldest first. The account writes strings.
        let with = |hl: Value| state(&json!({"counter": 1, "hl": hl})).unwrap().open_sends;
        let address = "0x303d6eccb884202707872ae95bf36049cd5099aa";
        assert_eq!(
            with(json!({"address": address, "open_sends": ["1794584202071", "1794584999000"]})),
            [1_794_584_202_071, 1_794_584_999_000]
        );
        assert_eq!(
            with(json!({"address": address, "open_sends": [1_794_584_202_071u64, "1794584999000"]})),
            [1_794_584_202_071, 1_794_584_999_000]
        );
        // An account made before the rule doesn't show the list; one with nothing open shows it empty.
        assert!(with(json!({"address": address})).is_empty());
        assert!(with(json!({"address": address, "open_sends": []})).is_empty());
        assert!(with(json!({"address": address, "open_sends": null})).is_empty());
        assert!(state(&json!({"counter": 1})).unwrap().open_sends.is_empty());
        // What isn't a nonce is left out, never guessed at, and the rest of the state still reads.
        assert_eq!(
            with(json!({"address": address, "open_sends": ["x", null, -5, 1.5, "1794584202071", {"n": 1}]})),
            [1_794_584_202_071]
        );
        assert!(with(json!({"address": address, "open_sends": "1794584202071"})).is_empty());
    }

    #[test]
    fn the_phase_6_state_parses_and_an_old_state_has_none_of_it() {
        let old = state(&json!({"counter": 1, "pending": [{"borrow": {"amount": "5"}}]})).unwrap();
        assert_eq!(
            (&old.permission, &old.funding, &old.evm, old.lender_pending.len()),
            (&None, &None, &None, 0)
        );
        let null = state(&json!({"counter": 1, "permission": null, "funding": null, "evm": null})).unwrap();
        assert_eq!(null, old);
        // `permission_blk` (INTERFACES.md 40.1: the block of the last `set_permission`) is the account's own
        // business: the reader takes a state that carries it, and reads the same from it.
        let with_blk = |blk: Value| state(&json!({"counter": 1, "pending": [{"borrow": {"amount": "5"}}],
            "permission_blk": blk})).unwrap();
        assert_eq!(with_blk(json!(277_339_134u64)), old);
        assert_eq!(with_blk(json!(0)), old);
        let st = state(&json!({"counter": 4,
            "permission": {"lenders": ["aave", "rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any"},
            "funding": {"pid": "f276800123", "amount": "94500000000", "stored_at": "1794000000000000000",
                "expires_at": "1794001800000000000",
                "steps": [{"k": "l_supply", "l": "rhea", "tok": "mnbtc.pbf-ops.testnet", "amt": "131000000", "done": true},
                          {"k": "l_borrow", "l": "rhea", "amt": 50667000000u64, "done": false},
                          {"k": "p_borrow", "amt": 43833000000u64, "done": false}]},
            "evm": {"nonce": 3, "approved": ["0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f"], "signed": [{"nonce": 2, "kind": "borrow",
                "token": "0xBA50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", "amount": "56667000000",
                "to": "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27", "raw": "0x02", "hash": "0xab",
                "step": "f276800123:1", "signed_at": "1794000000000000000"}]},
            "pending": [{"lender": {"lender": "rhea", "kind": "borrow", "amount": "50667000000", "until_block": 123}}]}))
        .unwrap();
        let p = st.permission.as_ref().unwrap();
        assert_eq!((p.lenders.len(), p.min_hf_bp, p.max_rate_bp, p.moves.as_str()), (2, 15000, 2500, "any"));
        let f = st.funding.as_ref().unwrap();
        assert_eq!((f.pid.as_str(), f.amount_micro, f.expires_ns), ("f276800123", 94_500_000_000, 1_794_001_800_000_000_000));
        assert_eq!(f.steps.len(), 3);
        assert_eq!(f.steps[0], (PlanStep::LSupply { l: "rhea".into(), tok: "mnbtc.pbf-ops.testnet".into(), amt: "131000000".into() }, true));
        assert_eq!(f.steps[2], (PlanStep::PBorrow { amt: 43_833_000_000 }, false));
        // The plan counts while a step is unfinished and it hasn't expired.
        assert!(live_funding(&st, 1_794_001_799_999_999_999).is_some());
        assert!(live_funding(&st, 1_794_001_800_000_000_000).is_none());
        let mut finished = st.clone();
        for s in &mut finished.funding.as_mut().unwrap().steps {
            s.1 = true;
        }
        assert!(live_funding(&finished, 1_794_000_000_000_000_000).is_none());
        let e = st.evm.as_ref().unwrap();
        assert_eq!((e.nonce, e.signed.len(), e.signed[0].nonce, e.signed[0].amount), (3, 1, 2, 56_667_000_000));
        assert_eq!(e.signed[0].token, "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f");
        assert_eq!(
            st.lender_pending,
            vec![LenderPending { lender: "rhea".into(), kind: "borrow".into(), amount: 50_667_000_000, token: None, until: Wait::Block(123) }]
        );
        // A withdrawal under way, in the token's own units. It may name its token; a 0x address is read in lower case.
        let out = state(&json!({"counter": 4, "pending": [
            {"lender": {"lender": "rhea", "kind": "withdraw", "amount": "131000000", "until_block": 200}},
            {"transfer": {"id": "move:4", "kind": "to_hl", "token": "musdc.pbf-ops.testnet", "amount": "1", "dep": "cd",
                          "deadline": "1"}},
            {"lender": {"lender": "aave", "kind": "withdraw", "amount": "5", "until_block": 201,
                        "token": "0x54114591963CF60EF3aA63bEfD6eC263D98145a4"}}]}))
        .unwrap();
        assert_eq!(out.transfers.len(), 1);
        assert_eq!(
            out.lender_pending,
            vec![
                LenderPending { lender: "rhea".into(), kind: "withdraw".into(), amount: 131_000_000, token: None, until: Wait::Block(200) },
                LenderPending { lender: "aave".into(), kind: "withdraw".into(), amount: 5,
                    token: Some("0x54114591963cf60ef3aa63befd6ec263d98145a4".into()), until: Wait::Block(201) },
            ]
        );
        // Aave's entries (INTERFACES.md 33) carry the nonce of the transaction the account signed, and no block.
        let aave = state(&json!({"counter": 4, "pending": [
            {"lender": {"lender": "aave", "kind": "borrow", "amount": "56667000000",
                        "token": "0xBA50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", "evm_nonce": 2}},
            {"lender": {"lender": "aave", "kind": "withdraw", "amount": "31000000",
                        "token": "0x54114591963CF60EF3aA63bEfD6eC263D98145a4", "evm_nonce": 3}}]}))
        .unwrap();
        assert_eq!(
            aave.lender_pending,
            vec![
                LenderPending { lender: "aave".into(), kind: "borrow".into(), amount: 56_667_000_000,
                    token: Some("0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f".into()), until: Wait::EvmNonce(2) },
                LenderPending { lender: "aave".into(), kind: "withdraw".into(), amount: 31_000_000,
                    token: Some("0x54114591963cf60ef3aa63befd6ec263d98145a4".into()), until: Wait::EvmNonce(3) },
            ]
        );
        assert!(!aave.lender_pending[0].waits_at_block(0));
        assert!(out.lender_pending[0].waits_at_block(200) && !out.lender_pending[0].waits_at_block(201));
        // Shapes it doesn't know are refused, in words.
        let bad = |v: Value| state(&v).unwrap_err();
        assert!(bad(json!({"counter": 1, "permission": {"lenders": ["compound"], "min_hf_bp": 1, "max_rate_bp": 1,
            "moves": "any"}})).contains("lenders"));
        assert!(bad(json!({"counter": 1, "permission": {"lenders": [], "min_hf_bp": 1, "max_rate_bp": 1,
            "moves": "sometimes"}})).contains("moves"));
        assert!(bad(json!({"counter": 1, "funding": {"pid": "276800123", "amount": "1", "expires_at": "1",
            "steps": []}})).contains("pid"));
        assert!(bad(json!({"counter": 1, "funding": {"pid": "f1", "amount": "1", "expires_at": "1",
            "steps": [{"k": "fly"}]}})).contains("step"));
        assert!(bad(json!({"counter": 1, "evm": {"signed": []}})).contains("nonce"));
        assert!(bad(json!({"counter": 1, "pending": [{"lender": {"lender": "rhea", "kind": "borrow",
            "amount": "1"}}]})).contains("until_block"));
        assert!(bad(json!({"counter": 1, "pending": [{"lender": {"lender": "compound", "kind": "borrow",
            "amount": "1", "until_block": 5}}]})).contains("lender"));
        // An Aave entry with neither a nonce nor a block, and a Rhea entry with only a nonce, are refused.
        assert!(bad(json!({"counter": 1, "pending": [{"lender": {"lender": "aave", "kind": "borrow",
            "amount": "1"}}]})).contains("evm_nonce"));
        assert!(bad(json!({"counter": 1, "pending": [{"lender": {"lender": "rhea", "kind": "borrow",
            "amount": "1", "evm_nonce": 2}}]})).contains("until_block"));
        assert!(bad(json!({"counter": 1, "pending": [{"lender": {"lender": "rhea", "kind": "withdraw",
            "amount": "1", "token": 7, "until_block": 5}}]})).contains("token"));
        // `pending` is a list. Any other shape is refused, so an action under way is never read as none.
        assert!(bad(json!({"counter": 1, "pending": {"lender": {"lender": "rhea", "kind": "borrow",
            "amount": "1", "until_block": 5}}})).contains("not a list"));
        assert!(state(&json!({"counter": 1, "pending": null})).unwrap().lender_pending.is_empty());
    }

    #[test]
    fn week_averages_merge_the_hour_and_use_the_record() {
        let rec = |hour, hr, exp| HourRecord {
            hour,
            hr_bp_min: hr,
            exp_bp_max: exp,
        };
        assert_eq!(week_averages(&[], 500, 8000, 2000), (8000.0, 2000.0));
        let hourly = [
            rec(100, 0, 0),
            rec(498, 10000, 1000),
            rec(499, 9000, 3000),
            rec(500, 7000, 9000),
        ];
        // Hour 100 is older than a week; the current hour keeps the lower hr and the higher share.
        assert_eq!(
            week_averages(&hourly, 500, 8000, 2000),
            (26000.0 / 3.0, 13000.0 / 3.0)
        );
    }

    #[test]
    fn views_parse() {
        let st = state(&json!({"owner": "alice.testnet", "counter": 3, "blocked": false,
            "loan": {"principal": "50000000000"},
            "verdict": {"intent": {"check": {}}, "received_block": 1, "verdict": {"state": "WATCH"}},
            "margin_call": {"since": "5", "intervals": [["1", "2"]]},
            "hourly": [{"hour": 493600, "hr_bp_min": 10000, "exp_bp_max": 49383}],
            "pending": [], "hl": {"path": "hyperliquid-1", "address": null}})).unwrap();
        assert_eq!(
            (st.counter, st.prev_state, st.mc_since_ns),
            (3, Some(State::Watch), 5)
        );
        assert_eq!(st.mc_intervals, vec![(1, 2)]);
        assert!(state(&json!({"hl": {}})).is_err());
        let conf = config(&json!({"tokens": [{"id": "musdc.pbf-ops.testnet", "symbol": "USDC", "decimals": 6},
            {"id": "mnbtc.pbf-ops.testnet", "symbol": "nBTC", "decimals": 8}], "pool_id": "pool.pbf.testnet"})).unwrap();
        assert_eq!(conf.tokens[1].engine, "nBTC");
        assert!(config(
            &json!({"tokens": [{"id": "x", "symbol": "DOGE", "decimals": 8}], "pool_id": "p"})
        )
        .is_err());
        let s =
            statuses(&json!([["XRP", {"status": "removed", "since": "1", "emergency": false}]]))
                .unwrap();
        assert_eq!(s["XRP"], "removed");
        assert_eq!(engine_name("ETH"), Some("ETH.b"));
        assert_eq!(pool_name("ETH.b"), "ETH");
    }
}
