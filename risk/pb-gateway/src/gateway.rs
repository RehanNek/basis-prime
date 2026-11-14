//! The modes (INTERFACES.md 9 and 16): `agent_address`, `order`, `cancel`, `set_leverage`, and in Phase 4
//! `deleverage` and `cancel_risky`. Every answer is JSON with exit code 0; a refusal is
//! `{"ok":false,"code":<code>,"reason":<words>}`.
//!
//! Codes: `P0`–`P10` as in RISK_ENGINE.md 9; `AUTH` for a bad signature, the wrong signer or caller, an expired
//! message or a reused nonce; `HL` when Hyperliquid refused or didn't answer; `INPUT` for a malformed or unrounded
//! request; and `READ` when a read the checks need failed, so nothing was checked or sent.
//!
//! An order runs in this sequence: the message and its signature; the chain's view of the signer (the owner, a
//! full-access key, the expiry); the nonce, used once; the account's lock (P0); the reads pb-risk makes, through
//! pb-read, plus the account's recent fills; the book as pb-risk builds it, with the gateway's own unshown orders,
//! any unused allowance and what a stored funding plan still means to borrow counted; the pre-trade checks; the
//! signature; the post; the ledger; and the lock again.
use crate::hlsign::{self, OrderAction, OrderType, OrderWire};
use crate::keys;
use crate::msg::{self, CancelMessage, OrderFields, OrderMessage};
use crate::nep413::{self, Auth};
use crate::store::{self, Ledger, LockError, Sent, Store};
use pb_read::book::{self, Book};
use pb_read::hl as hlr;
use pb_read::inputs::Inputs;
use pb_read::near;
use pb_read::read::{self, Net};
use pb_read::request::{self, Intent, Mode, Request, TESTNET};
use pb_read::steps::{self as plan_steps, PlanStep};
use pb_read::util::{bp, micro_down, micro_exact, micro_up, pow10, sha256_hex, u128_of, u64_of};
use risk_core::plan::risky_orders;
use risk_core::pretrade::{p2_band, worst_fill};
use risk_core::py::sgn;
use risk_core::{Account, Engine, Market, Order};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// The keeper: the payment-key owner, and the only HTTPS caller.
pub const KEEPER: &str = "pbf-keeper.testnet";
/// Hyperliquid testnet's exchange endpoint (INTERFACES.md 1).
pub const HL_EXCHANGE: &str = "https://api.hyperliquid-testnet.xyz/exchange";
/// A signed message may expire at most this far after the final block, on every network but testnet.
pub const MAX_AHEAD_MS: u64 = 120_000;
/// The same on testnet: 4 minutes (INTERFACES.md 50.4, the user's decision of 13 Nov). OutLayer's testnet took 94
/// to 186 s for a run in several spells that day (the slowest answers were 176 and 186 s), and an order signed to
/// live 110 s reached the gateway expired. The pages sign for 230 s.
pub const TESTNET_MAX_AHEAD_MS: u64 = 240_000;
/// A verdict backs an action for this many blocks (INTERFACES.md 4).
pub const VERDICT_LIFE_BLOCKS: u64 = 120;
/// Fills this far back are read to see which of the gateway's own orders Hyperliquid shows.
pub const FILLS_WINDOW_MS: u64 = 60_000;
/// Mainnet Hyperliquid's info endpoint: on testnet, P10's volume limit takes each coin's daily volume from here,
/// because testnet's own volume is an artifact (about $2M a day for BTC). Read only.
pub const MAINNET_HL_INFO: &str = "https://api.hyperliquid.xyz/info";

/// A refusal: the code and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub reason: String,
}

fn refuse<T>(code: &'static str, reason: impl Into<String>) -> Result<T, Refusal> {
    Err(Refusal {
        code,
        reason: reason.into(),
    })
}

fn input_err(reason: impl Into<String>) -> Refusal {
    Refusal {
        code: "INPUT",
        reason: reason.into(),
    }
}

/// Where the gateway runs: the transport, OutLayer's storage, the run's environment, and the reads.
pub trait Host {
    type N: Net;
    type S: Store;
    fn net(&mut self) -> &mut Self::N;
    fn store(&mut self) -> &mut Self::S;
    /// An environment variable; None when missing or empty (HTTPS runs set the on-chain ones to "").
    fn env(&self, name: &str) -> Option<String>;
    /// The reads pb-risk makes (INTERFACES.md 6), plus the coins in `extra` and those of resting orders.
    fn read_book(&mut self, req: &Request, extra: &BTreeSet<String>) -> Inputs {
        read::read_all_with(self.net(), req, extra, true)
    }
}

/// The request on stdin.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub mode: String,
    pub account: String,
    pub network: String,
    #[serde(default)]
    pub auth: Option<Auth>,
}

#[derive(Serialize)]
struct RefusalOut<'a> {
    ok: bool,
    code: &'a str,
    reason: &'a str,
}

/// `{"ok":false,"code":..,"reason":..}`.
pub fn refusal_json(r: &Refusal) -> String {
    serde_json::to_string(&RefusalOut {
        ok: false,
        code: r.code,
        reason: &r.reason,
    })
    .expect("a refusal serialises")
}

/// How far after the final block a signed message may expire, for the network the request names.
pub fn max_ahead_ms(network: &str) -> u64 {
    if network == TESTNET.name {
        TESTNET_MAX_AHEAD_MS
    } else {
        MAX_AHEAD_MS
    }
}

/// A signed message's life against the final block's time: it must expire after the block, and at most
/// [`max_ahead_ms`] after it. The refusal names the figure of the network the request ran for.
pub fn check_life(network: &str, expires_ms: u64, block_ms: u64) -> Result<(), Refusal> {
    if expires_ms <= block_ms {
        return refuse("AUTH", "the message has expired: sign it again");
    }
    let ahead_ms = max_ahead_ms(network);
    if expires_ms > block_ms + ahead_ms {
        let s = ahead_ms / 1_000;
        return refuse(
            "AUTH",
            format!("the message expires more than {s} s ahead: the gateway takes at most {s} s"),
        );
    }
    Ok(())
}

/// One run: the request on stdin to what goes on stdout.
pub fn run(raw: &str, host: &mut impl Host) -> String {
    match dispatch(raw, host) {
        Ok(out) => out,
        Err(r) => refusal_json(&r),
    }
}

fn dispatch(raw: &str, host: &mut impl Host) -> Result<String, Refusal> {
    let input: Input = serde_json::from_str(raw)
        .map_err(|e| input_err(format!("the input is not a gateway request: {e}")))?;
    if input.network != TESTNET.name {
        return refuse(
            "INPUT",
            format!("network {:?} is not served: testnet only", input.network),
        );
    }
    request::check_client_account(&input.account, &TESTNET).map_err(input_err)?;
    match input.mode.as_str() {
        "agent_address" => agent_address(&input, host).map(|o| to_json(&o)),
        "order" => order(&input, host).map(|o| to_json(&o)),
        "cancel" => cancel(&input, host).map(|o| to_json(&o)),
        "set_leverage" => set_leverage(&input, host).map(|o| to_json(&o)),
        "deleverage" => deleverage(&input, host).map(|o| to_json(&o)),
        "cancel_risky" => cancel_risky(&input, host).map(|o| to_json(&o)),
        other => refuse(
            "INPUT",
            format!("unknown mode {other:?}: use agent_address, order, cancel, set_leverage, deleverage or cancel_risky"),
        ),
    }
}

fn to_json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("an output serialises")
}

// ------------------------------------------------------------------------------------------- callers

/// Order, cancel and leverage runs come only over HTTPS from the keeper (our backend), so they all share the
/// keeper's storage space, where the locks are.
fn require_keeper_https(host: &impl Host) -> Result<(), Refusal> {
    let exec = host.env("OUTLAYER_EXECUTION_TYPE").unwrap_or_default();
    let sender = host.env("NEAR_SENDER_ID").unwrap_or_default();
    if exec != "HTTPS" || sender != KEEPER {
        return refuse(
            "AUTH",
            format!("this mode runs only over HTTPS for {KEEPER}, not a {exec} run for {sender:?}"),
        );
    }
    Ok(())
}

fn seed(host: &impl Host) -> Result<[u8; 32], Refusal> {
    let hex = host.env(keys::SEED_VAR).ok_or(Refusal {
        code: "READ",
        reason: format!("the agent seed ({}) is not in this run", keys::SEED_VAR),
    })?;
    keys::parse_seed(&hex).map_err(|e| Refusal {
        code: "READ",
        reason: e,
    })
}

fn agent_key(host: &impl Host, account: &str) -> Result<k256::ecdsa::SigningKey, Refusal> {
    keys::agent_key(&seed(host)?, account).map_err(|e| Refusal {
        code: "READ",
        reason: e,
    })
}

// ------------------------------------------------------------------------------------- agent_address

#[derive(Serialize)]
pub struct AgentOut {
    pub ok: bool,
    pub acct: String,
    pub agent: String,
}

/// Mode 1. On chain the account must be the caller (`NEAR_PREDECESSOR_ID`), so its own `request_agent` gets its own
/// agent. Over HTTPS only the keeper may ask, for any client account: an agent's address is public anyway once
/// approved, and the backend can show it before.
pub fn agent_address(input: &Input, host: &mut impl Host) -> Result<AgentOut, Refusal> {
    if input.auth.is_some() {
        return refuse("INPUT", "agent_address takes no auth");
    }
    let exec = host.env("OUTLAYER_EXECUTION_TYPE").unwrap_or_default();
    match exec.as_str() {
        "NEAR" => {
            let pred = host.env("NEAR_PREDECESSOR_ID").unwrap_or_default();
            if pred != input.account {
                return refuse(
                    "AUTH",
                    format!(
                        "on chain, only {} itself may ask for its agent, not {pred:?}",
                        input.account
                    ),
                );
            }
        }
        "HTTPS" => require_keeper_https(host)?,
        other => return refuse("AUTH", format!("unknown execution type {other:?}")),
    }
    let key = agent_key(host, &input.account)?;
    Ok(AgentOut {
        ok: true,
        acct: input.account.clone(),
        agent: hlsign::address(&key),
    })
}

// --------------------------------------------------------------------------------------------- auth

/// What the chain said about the signer, at one final block.
pub struct ChainAuth {
    pub height: u64,
    pub block_ms: u64,
    pub state: Value,
}

/// Checks the signer against the chain: `owner` is the account's owner, `public_key` is one of the owner's
/// full-access keys (at the final block), and the message expires in the future but within the network's limit of
/// that block ([`check_life`]: 240 s on testnet).
fn chain_auth(
    host: &mut impl Host,
    network: &str,
    account: &str,
    auth: &Auth,
    expires_ms: u64,
) -> Result<ChainAuth, Refusal> {
    let url = TESTNET.near_rpc;
    let read_err = |what: &str, e: read::ViewError| Refusal {
        code: "READ",
        reason: format!("cannot read {what}: {e:?}"),
    };
    let block = read::rpc(host.net(), url, "block", json!({"finality": "final"}))
        .map_err(|e| read_err("the final NEAR block", e))?;
    let header = block.get("header").unwrap_or(&Value::Null);
    let height = header.get("height").and_then(u64_of).ok_or(Refusal {
        code: "READ",
        reason: "the NEAR block has no height".into(),
    })?;
    let ts_ns = header
        .get("timestamp_nanosec")
        .or_else(|| header.get("timestamp"))
        .and_then(u64_of)
        .ok_or(Refusal {
            code: "READ",
            reason: "the NEAR block has no timestamp".into(),
        })?;
    let block_ms = ts_ns / 1_000_000;
    let state = match read::view(host.net(), url, height, account, "get_state", &json!({})) {
        Ok(v) => v,
        Err(read::ViewError::UnknownAccount) => {
            return refuse(
                "INPUT",
                format!("account {account} does not exist on testnet"),
            )
        }
        Err(e) => return Err(read_err("the account's state", e)),
    };
    let owner = state.get("owner").and_then(Value::as_str).unwrap_or("");
    if owner != auth.owner {
        return refuse(
            "AUTH",
            format!("{} signed, but {account}'s owner is {owner}", auth.owner),
        );
    }
    let key = read::rpc(
        host.net(),
        url,
        "query",
        json!({"request_type": "view_access_key", "block_id": height, "account_id": auth.owner,
               "public_key": auth.public_key}),
    );
    match key {
        Ok(k) if k.get("permission") == Some(&json!("FullAccess")) => {}
        Ok(_) => {
            return refuse(
                "AUTH",
                format!(
                    "{} is not a full-access key of {}",
                    auth.public_key, auth.owner
                ),
            )
        }
        Err(read::ViewError::Other(text)) if text.contains("UNKNOWN_ACCESS_KEY") => {
            return refuse(
                "AUTH",
                format!("{} is not a key of {}", auth.public_key, auth.owner),
            )
        }
        Err(read::ViewError::UnknownAccount) => {
            return refuse("AUTH", format!("the signer {} does not exist", auth.owner))
        }
        Err(e) => return Err(read_err("the signer's key", e)),
    }
    check_life(network, expires_ms, block_ms)?;
    Ok(ChainAuth {
        height,
        block_ms,
        state,
    })
}

/// The signed message's nonce, used once.
fn use_nonce(host: &mut impl Host, auth: &Auth, now_ms: u64) -> Result<(), Refusal> {
    match store::use_nonce(host.store(), &auth.nonce, now_ms) {
        Ok(true) => Ok(()),
        Ok(false) => refuse(
            "AUTH",
            "this signed message was used before: sign a new one",
        ),
        Err(e) => refuse("READ", format!("storage: {e}")),
    }
}

/// Runs `f` holding the account's lock (P0), and always releases it.
fn with_lock<H: Host, T>(
    host: &mut H,
    account: &str,
    f: impl FnOnce(&mut H) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    let holder = host
        .env("OUTLAYER_CALL_ID")
        .unwrap_or_else(|| format!("run-{}", host.net().now_ms()));
    let now = host.net().now_ms();
    let held = match store::take_lock(host.store(), account, &holder, now) {
        Ok(h) => h,
        Err(LockError::Busy { age_ms }) => {
            return refuse(
                "P0",
                format!("another order for this account is in flight (for {age_ms} ms): try again in a moment"),
            )
        }
        Err(LockError::Storage(e)) => return refuse("READ", format!("storage: {e}")),
    };
    let out = f(host);
    // A failed release leaves the lock to go stale (60 s); the answer stands.
    let _ = store::release_lock(host.store(), account, &held);
    out
}

// -------------------------------------------------------------------------------------------- order

/// What a successful order answers (INTERFACES.md 9).
#[derive(Serialize)]
pub struct OrderOut {
    pub ok: bool,
    pub acct: String,
    pub status: String,
    pub oid: Option<u64>,
    pub filled_sz: String,
    pub avg_px: Option<String>,
    pub sent: OrderFields,
    pub hl: Value,
    pub after: After,
}

/// The engine's view of the book as if the order filled at its worst price (P4).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct After {
    pub state: String,
    pub eq: i64,
    pub im: i64,
    pub line: u128,
    pub hl_margin_ratio_bp: u64,
}

/// Mode 2.
pub fn order(input: &Input, host: &mut impl Host) -> Result<OrderOut, Refusal> {
    require_keeper_https(host)?;
    let auth = input
        .auth
        .as_ref()
        .ok_or_else(|| input_err("an order needs auth: the owner's signed message"))?;
    let m: OrderMessage = msg::parse_exact(&auth.message).map_err(input_err)?;
    if m.pb != "order" {
        return refuse(
            "INPUT",
            format!("the signed message is a {:?}, not an order", m.pb),
        );
    }
    if m.account != input.account {
        return refuse(
            "AUTH",
            format!(
                "the signed message is for {}, not {}",
                m.account, input.account
            ),
        );
    }
    msg::check_tif(&m.order.tif).map_err(input_err)?;
    msg::decimal(&m.order.sz, "sz").map_err(input_err)?;
    msg::decimal(&m.order.limit_px, "limit_px").map_err(input_err)?;
    let nonce = nep413::verify(auth).map_err(|e| Refusal {
        code: "AUTH",
        reason: e,
    })?;
    // P1, the part that needs no reads: a coin outside the allow-list.
    if !book::on_allow_list(&m.order.coin) {
        return refuse("P1", format!("{} is not on the allow-list", m.order.coin));
    }
    let chain = chain_auth(host, &input.network, &input.account, auth, m.expires_ms)?;
    let now = host.net().now_ms();
    use_nonce(host, auth, now)?;
    let account = input.account.clone();
    with_lock(host, &account, |h| {
        place_order(h, &account, &m.order, &nonce, &chain)
    })
}

/// A client order id from the signed message's nonce, so each message has its own.
pub fn cloid_for(nonce: &[u8; 32]) -> String {
    let mut seed = b"pb-gateway cloid:".to_vec();
    seed.extend_from_slice(nonce);
    format!("0x{}", &sha256_hex(&seed)[..32])
}

/// The account's master address and its agent, from `get_state().hl`, checked against the gateway's agent.
fn master_and_agent(
    host: &impl Host,
    account: &str,
    state: &Value,
) -> Result<(String, k256::ecdsa::SigningKey), Refusal> {
    let master = state
        .pointer("/hl/address")
        .and_then(Value::as_str)
        .filter(|a| near::is_evm_address(a))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| {
            input_err(format!(
                "{account} has no Hyperliquid address yet: call hl_init"
            ))
        })?;
    let key = agent_key(host, account)?;
    let agent = hlsign::address(&key);
    let stored = state
        .pointer("/hl/agent/address")
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase);
    if stored.as_deref() != Some(agent.as_str()) {
        return refuse(
            "INPUT",
            format!("{account}'s agent is not the gateway's ({agent}): call request_agent, then hl_approve_agent"),
        );
    }
    Ok((master, key))
}

/// The request pb-risk's reads take: a preview check of the account.
fn book_request(account: &str) -> Request {
    Request {
        mode: Mode::Preview,
        account: account.to_string(),
        intent: Intent::Check {},
        network: TESTNET.name.to_string(),
    }
}

/// The account's fills of the last minute. Read before the book, so any fill they show is in the state read after.
fn recent_fills(host: &mut impl Host, master: &str, now_ms: u64) -> Value {
    read::hl_info(
        host.net(),
        TESTNET.hl_info,
        json!({"type": "userFillsByTime", "user": master,
               "startTime": now_ms.saturating_sub(FILLS_WINDOW_MS)}),
    )
    .unwrap_or(Value::Null)
}

/// Whether Hyperliquid shows a sent order: in the fills read before the state, or among the open orders.
fn shown(sent: &Sent, fills: &Value, orders: &Value) -> bool {
    let matches = |v: &Value| {
        let oid = v.get("oid").and_then(u64_of);
        let cloid = v.get("cloid").and_then(Value::as_str);
        (sent.oid.is_some() && oid == sent.oid) || cloid == Some(sent.cloid.as_str())
    };
    let any = |list: &Value| list.as_array().is_some_and(|a| a.iter().any(matches));
    any(fills) || any(orders)
}

/// What a stored funding plan still means to borrow (FUNDING.md 6.7), in micro-USD: from our pool (its unfinished
/// `p_borrow` steps) and from lenders (its unfinished `l_borrow` steps). The book holds the plan only while it has
/// an unfinished step and hasn't expired at the block's time (`near::live_funding`), so a finished, cancelled or
/// expired plan counts for nothing. A step the account has started is no longer the plan's to count: a lender borrow
/// under way is in the book's debt already (`pending`'s lender entry), and a pool borrow is in the pool's own figure
/// once the pool has run it, a block or two after the account sent it. For those blocks nothing counts it, as
/// nothing counts a plain `borrow` under way.
fn funding_to_come(b: &Book) -> (u128, u128) {
    let (mut pool, mut lenders) = (0u128, 0u128);
    let steps = b.lenders.funding.as_ref().map_or(&[][..], |f| f.steps.as_slice());
    for (step, done) in steps {
        match step {
            PlanStep::PBorrow { amt } if !done => pool = pool.saturating_add(u128::from(*amt)),
            PlanStep::LBorrow { amt, .. } if !done => lenders = lenders.saturating_add(u128::from(*amt)),
            _ => {}
        }
    }
    (pool, lenders)
}

/// P0: money the account can still take on what it already holds counts as taken.
/// - **A live verdict's unused allowance.** A borrow allowance adds its amount to the debt and to the USDC on NEAR;
///   a withdraw allowance takes its amount out of the token.
/// - **A stored funding plan's unfinished debt steps** ([`funding_to_come`]) add their amounts to the debt and to
///   the USDC, each in full, whether or not a verdict is live: the plan runs on verdicts still to come, and an order
///   placed now must still be sound once its loans arrive.
///
/// A `p_borrow` step draws on the same allowance a borrow verdict carries (`allow.borrow`), so of those two the
/// larger counts, not their sum. A lender's loan is other money, and is added.
fn spend_live_allowance(b: &mut Book, state: &Value, height: u64) {
    let (plan_pool, plan_lenders) = funding_to_come(b);
    let held = state.get("verdict").filter(|v| !v.is_null());
    let v = held.and_then(|h| h.get("verdict")).unwrap_or(&Value::Null);
    let live = held.is_some()
        && v.get("ok") == Some(&json!(true))
        && v.get("nonce").and_then(u64_of) == Some(b.client.counter)
        && v.get("blk")
            .and_then(u64_of)
            .is_some_and(|blk| height <= blk + VERDICT_LIFE_BLOCKS);
    let intent = held
        .filter(|_| live)
        .and_then(|h| h.get("intent"))
        .unwrap_or(&Value::Null);
    let allowed = if intent.get("borrow").is_some() {
        v.pointer("/allow/borrow").and_then(u128_of).unwrap_or(0)
    } else {
        0
    };
    let w = allowed.max(plan_pool).saturating_add(plan_lenders);
    if w > 0 {
        let usd = w as f64 / 1e6;
        b.account.debt += usd;
        let usdc = b.account.near.get_or("USDC", 0.0);
        b.account.near.insert("USDC", usdc + usd);
    }
    if let Some(w) = intent.get("withdraw") {
        let units = v.pointer("/allow/withdraw").and_then(u128_of).unwrap_or(0);
        let token = w.get("token").and_then(Value::as_str).unwrap_or("");
        if let Some(t) = b.conf.tokens.iter().find(|t| t.id == token) {
            if units > 0 {
                let have = b.account.near.get_or(t.engine, 0.0);
                b.account
                    .near
                    .insert(t.engine, (have - units as f64 / pow10(t.decimals)).max(0.0));
            }
        }
    }
}

/// Whether `size` of `coin` only shrinks the position, without flipping it (as risk-core decides it).
fn shrinks(a: &Account, coin: &str, size: f64) -> bool {
    let q0 = a.perps.get_or(coin, 0.0);
    let q1 = q0 + size;
    q1.abs() < q0.abs() && (sgn(q1) == 0 || sgn(q1) == sgn(q0))
}

/// The account with `orders` filled at their limit, but never better than the mark (P4).
fn fill_all(eng: &Engine, a: &Account, m: &Market, orders: &[Order]) -> Account {
    let mut out = a.clone();
    for o in orders {
        if !m.mark.contains_key(&o.coin) || !m.px.contains_key(&o.coin) || o.size == 0.0 {
            continue;
        }
        let fill = worst_fill(o.size, o.limit_px, m.mark_price(&o.coin));
        out = eng.post_trade(&out, m, &o.coin, o.size, fill).0;
    }
    out
}

/// The books the checks must pass on (RISK_ENGINE.md 9, resting orders): none of the resting orders fills, or, for
/// each coin, all its resting buys fill, or all its sells.
fn resting_variants(eng: &Engine, a: &Account, m: &Market) -> Vec<(String, Account)> {
    let mut out = vec![("".to_string(), a.clone())];
    let coins: BTreeSet<&str> = a.orders.iter().map(|o| o.coin.as_str()).collect();
    for c in coins {
        for (side, buys) in [("buys", true), ("sells", false)] {
            let these: Vec<Order> = a
                .orders
                .iter()
                .filter(|o| o.coin == c && (o.size > 0.0) == buys)
                .cloned()
                .collect();
            if !these.is_empty() {
                out.push((
                    format!(" (if the resting {c} {side} fill)"),
                    fill_all(eng, a, m, &these),
                ));
            }
        }
    }
    out
}

/// The checks on a built book for one order. Returns the book the order was checked on.
pub struct Checked {
    pub book: Book,
    pub base: Account,
    pub order: Order,
    pub market: Market,
}

/// The coin's daily volume on mainnet Hyperliquid (`metaAndAssetCtxs` `dayNtlVlm`, by coin name), if it answers.
pub fn mainnet_day_volume(host: &mut impl Host, coin: &str) -> Option<f64> {
    let v = read::hl_info(
        host.net(),
        MAINNET_HL_INFO,
        json!({"type": "metaAndAssetCtxs"}),
    )
    .ok()?;
    let i = v
        .get(0)?
        .get("universe")?
        .as_array()?
        .iter()
        .position(|a| a.get("name").and_then(Value::as_str) == Some(coin))?;
    v.get(1)?
        .get(i)?
        .get("dayNtlVlm")
        .and_then(pb_read::util::f64_of)
        .filter(|x| *x > 0.0)
}

/// P1, P2–P10 for `order` on the book `inp` describes, with the gateway's own recent orders, any unused allowance
/// and a stored funding plan's unfinished borrow steps counted (P0). `day_volume` is the coin's daily volume for P10's size limit (mainnet's, on testnet);
/// None falls back to the parameter file's 30-day average. Pure, so recorded inputs test it.
pub fn check_order(
    inp: &Inputs,
    fields: &OrderFields,
    ledger: &Ledger,
    fills: &Value,
    now_ms: u64,
    day_volume: Option<f64>,
) -> Result<Checked, Refusal> {
    let coin = fields.coin.as_str();
    let read_err = |e: String| Refusal {
        code: "READ",
        reason: e,
    };
    let sz = msg::decimal(&fields.sz, "sz").map_err(input_err)?.value;
    let signed_raw = if fields.is_buy { sz } else { -sz };
    // The gateway's own orders of the last 10 s that Hyperliquid doesn't show yet (P0) count as filled.
    let unshown: Vec<Order> = ledger
        .sent
        .iter()
        .filter(|s| now_ms.saturating_sub(s.at_ms) < store::RECENT_FILL_MS)
        .filter(|s| !shown(s, fills, &inp.hl.orders))
        .map(|s| Order {
            coin: s.coin.clone(),
            size: s.size,
            limit_px: s.limit_px,
            reduce_only: s.reduce_only,
        })
        .collect();
    // P1, the coin's status, before anything is priced: a coin the pool has removed or made reduce-only, or one
    // Hyperliquid testnet doesn't list for cross margin, takes only orders that shrink the position.
    if !inp.hl.meta_read {
        return refuse("READ", "Hyperliquid's market wasn't read");
    }
    let statuses = near::statuses(&inp.near.coin_statuses).map_err(read_err)?;
    let removed = matches!(
        statuses.get(coin).map(String::as_str),
        Some("reduce_only" | "removed")
    );
    let off_hl = match inp.hl.assets.get(coin) {
        None => true,
        Some(e) => hlr::asset(e).map_or(true, |a| a.unusable),
    };
    let hla = hlr::account_of(&inp.hl).map_err(read_err)?;
    let q0 = hla.perps.get_or(coin, 0.0)
        + unshown
            .iter()
            .filter(|o| o.coin == coin)
            .map(|o| o.size)
            .sum::<f64>();
    let q1 = q0 + signed_raw;
    let shrinking_now = q1.abs() < q0.abs() && (sgn(q1) == 0 || sgn(q1) == sgn(q0));
    if (removed || off_hl) && !shrinking_now {
        let why = if off_hl {
            "is not listed on Hyperliquid testnet for cross margin"
        } else {
            "is being removed"
        };
        return refuse(
            "P1",
            format!("{coin} {why}: only orders that shrink the position"),
        );
    }
    // Hyperliquid's rounding rules for the coin (INPUT).
    let asset = inp.hl.assets.get(coin).ok_or_else(|| Refusal {
        code: "P1",
        reason: format!("{coin} is not listed on Hyperliquid testnet"),
    })?;
    let sz_decimals = asset
        .pointer("/meta/szDecimals")
        .and_then(u64_of)
        .ok_or_else(|| Refusal {
            code: "READ",
            reason: format!("Hyperliquid's market has no szDecimals for {coin}"),
        })? as u32;
    let (size, price) =
        msg::check_rounding(&fields.sz, &fields.limit_px, sz_decimals).map_err(input_err)?;
    // The book as pb-risk builds it, priced also for the order's coin, the gateway's recent orders and resting
    // orders the reads priced.
    let mut extra: BTreeSet<String> = BTreeSet::new();
    extra.insert(coin.to_string());
    for o in unshown.iter().chain(hla.orders.iter()) {
        if inp.hl.assets.contains_key(&o.coin) || inp.coins.contains_key(&o.coin) {
            extra.insert(o.coin.clone());
        }
    }
    let mut b = book::build_with(inp, &extra).map_err(|e| {
        if e.starts_with("no valid price") {
            Refusal {
                code: "P10",
                reason: format!("prices are not fresh: {e}"),
            }
        } else {
            read_err(e)
        }
    })?;
    let signed_size = if fields.is_buy {
        size.value
    } else {
        -size.value
    };
    spend_live_allowance(&mut b, &inp.near.state, inp.block.height);
    let m = b.built.market.clone();
    let base = fill_all(&b.engine, &b.account, &m, &unshown);
    let order = Order {
        coin: coin.to_string(),
        size: signed_size,
        limit_px: price.value,
        reduce_only: fields.reduce_only,
    };
    let shrinking = shrinks(&base, coin, signed_size);
    // P10: prices fresh. With an uncertain price, an order that only shrinks a position still passes, its band
    // measured from Hyperliquid's mark.
    let mut market = m.clone();
    let book_coins: BTreeSet<&str> = base
        .perps
        .iter()
        .filter(|(_, &q)| q != 0.0)
        .map(|(c, _)| c)
        .chain(b.groups.iter().map(String::as_str))
        .collect();
    let uncertain: Vec<&str> = b
        .built
        .uncertain
        .iter()
        .map(String::as_str)
        .filter(|c| book_coins.contains(c))
        .collect();
    if !uncertain.is_empty() {
        if !shrinking {
            return refuse(
                "P10",
                format!(
                    "prices are uncertain for {}: only orders that shrink a position",
                    uncertain.join(", ")
                ),
            );
        }
        if let Some(&mark) = market.mark.get(coin) {
            market.px.insert(coin.to_string(), mark);
        }
    }
    if !market.mark.contains_key(coin) {
        return refuse("READ", format!("no Hyperliquid mark price for {coin}"));
    }
    // P2–P9, and P10's size limit, on every book the resting orders could make. P2's band is the coin's, or
    // testnet's floor when that is larger (INTERFACES.md 42).
    let band_floor = Some(TESTNET.price_band_floor);
    for (when, a) in resting_variants(&b.engine, &base, &market) {
        let r = b
            .engine
            .pretrade_check_with(&a, &market, &order, None, day_volume, band_floor);
        if !r.ok {
            return refuse(r.check.code(), format!("{}{when}", r.reason));
        }
    }
    Ok(Checked {
        book: b,
        base,
        order,
        market,
    })
}

/// The `after` summary: the book as if the order filled at its worst price.
pub fn after(c: &Checked) -> After {
    let eng = &c.book.engine;
    let m = &c.market;
    let fill = worst_fill(c.order.size, c.order.limit_px, m.mark_price(&c.order.coin));
    let (a2, _) = eng.post_trade(&c.base, m, &c.order.coin, c.order.size, fill);
    let rq = eng.requirement(&a2, m);
    let age_h = c.book.client.margin_call_age_h(c.book.now_ns);
    let st = eng.state(&a2, m, &rq, age_h, c.book.client.prev_state);
    let w = if c.book.built.uncertain.is_empty() {
        eng.borrow_allowance(&a2, m, Some(&rq), 0, Some(c.book.score))
            .w
    } else {
        0.0
    };
    After {
        state: st.state.as_str().to_string(),
        eq: micro_down(rq.e),
        im: micro_up(rq.im),
        line: (micro_exact(a2.debt).max(0) as u128).saturating_add(micro_exact(w).max(0) as u128),
        hl_margin_ratio_bp: bp(st.hl_ratio),
    }
}

/// Sends an L1 action to Hyperliquid; the answer, or why there was none.
fn post_action<T: Serialize>(
    host: &mut impl Host,
    key: &k256::ecdsa::SigningKey,
    action: &T,
    nonce: u64,
) -> Result<Result<Value, String>, Refusal> {
    let sig = hlsign::sign_l1(key, action, nonce, false).map_err(input_err)?;
    let body = hlsign::exchange_body(action, nonce, &sig);
    Ok(match host.net().post(HL_EXCHANGE, &body) {
        Err(e) => Err(format!("Hyperliquid didn't answer: {e}")),
        Ok(r) => {
            let text = String::from_utf8_lossy(&r.body).to_string();
            match serde_json::from_slice::<Value>(&r.body) {
                Ok(v) if r.status == 200 => Ok(v),
                _ => Err(format!(
                    "Hyperliquid answered HTTP {}: {}",
                    r.status,
                    pb_read::util::clip(&text, 200)
                )),
            }
        }
    })
}

/// Places the order, under the lock.
fn place_order(
    host: &mut impl Host,
    account: &str,
    fields: &OrderFields,
    nonce: &[u8; 32],
    chain: &ChainAuth,
) -> Result<OrderOut, Refusal> {
    let now = host.net().now_ms();
    let mut ledger = Ledger::load(host.store(), account).map_err(|e| Refusal {
        code: "READ",
        reason: format!("storage: {e}"),
    })?;
    ledger.prune(now);
    // P10: at most 60 orders a minute.
    if ledger.in_last_minute(now) >= store::MAX_ORDERS_PER_MINUTE {
        return refuse(
            "P10",
            "more than 60 orders in the last minute: wait a little",
        );
    }
    let (master, key) = master_and_agent(host, account, &chain.state)?;
    let fills = recent_fills(host, &master, now);
    let mut extra = BTreeSet::new();
    extra.insert(fields.coin.clone());
    for s in &ledger.sent {
        extra.insert(s.coin.clone());
    }
    let inp = host.read_book(&book_request(account), &extra);
    if let Some(reason) = &inp.fatal {
        return refuse("READ", reason.clone());
    }
    // Everything about the account itself is testnet's; only the volume behind P10's limit is mainnet's.
    let day_volume = mainnet_day_volume(host, &fields.coin);
    let checked = check_order(&inp, fields, &ledger, &fills, now, day_volume)?;
    let summary = after(&checked);
    let asset = inp
        .hl
        .assets
        .get(&fields.coin)
        .and_then(|a| a.get("index"))
        .and_then(u64_of)
        .ok_or_else(|| Refusal {
            code: "READ",
            reason: format!(
                "Hyperliquid's market has no asset number for {}",
                fields.coin
            ),
        })? as u32;
    let cloid = cloid_for(nonce);
    let action = OrderAction::one(OrderWire {
        a: asset,
        b: fields.is_buy,
        p: fields.limit_px.clone(),
        s: fields.sz.clone(),
        r: fields.reduce_only,
        t: OrderType {
            limit: hlsign::Limit {
                tif: fields.tif.clone(),
            },
        },
        c: Some(cloid.clone()),
    });
    let hl_nonce = ledger.next_nonce(now);
    ledger.last_nonce = hl_nonce;
    let answer = post_action(host, &key, &action, hl_nonce)?;
    let mut sent = Sent {
        at_ms: hl_nonce,
        coin: fields.coin.clone(),
        size: checked.order.size,
        limit_px: checked.order.limit_px,
        cloid,
        oid: None,
        status: "unknown".into(),
        reduce_only: fields.reduce_only,
    };
    let reply = match answer {
        Err(why) => {
            // It may have been placed: count it as filled for 10 s.
            ledger.sent.push(sent);
            let _ = ledger.save(host.store(), account);
            return refuse("HL", why);
        }
        Ok(v) => v,
    };
    let status = reply.pointer("/response/data/statuses/0");
    let refused = |why: String| Refusal {
        code: "HL",
        reason: why,
    };
    let (out_status, oid, filled_sz, avg_px) = match status {
        Some(s) if s.get("resting").is_some() => {
            let oid = s.pointer("/resting/oid").and_then(u64_of);
            ("resting", oid, "0".to_string(), None)
        }
        Some(s) if s.get("filled").is_some() => {
            let f = &s["filled"];
            let total = f
                .get("totalSz")
                .and_then(Value::as_str)
                .unwrap_or("0")
                .to_string();
            let filled: f64 = total.parse().unwrap_or(0.0);
            let full = (filled - checked.order.size.abs()).abs() < 1e-12;
            sent.size = if fields.is_buy { filled } else { -filled };
            (
                if full { "filled" } else { "partial" },
                f.get("oid").and_then(u64_of),
                total,
                f.get("avgPx").and_then(Value::as_str).map(String::from),
            )
        }
        Some(s) if s.get("error").is_some() => {
            let _ = ledger.save(host.store(), account);
            return Err(refused(format!(
                "Hyperliquid refused the order: {}",
                s["error"].as_str().unwrap_or("no reason given")
            )));
        }
        _ => {
            let _ = ledger.save(host.store(), account);
            return Err(refused(format!(
                "Hyperliquid refused the order: {}",
                pb_read::util::clip(&reply.to_string(), 200)
            )));
        }
    };
    sent.oid = oid;
    sent.status = out_status.to_string();
    ledger.sent.push(sent);
    let _ = ledger.save(host.store(), account);
    Ok(OrderOut {
        ok: true,
        acct: account.to_string(),
        status: out_status.to_string(),
        oid,
        filled_sz,
        avg_px,
        sent: fields.clone(),
        hl: reply,
        after: summary,
    })
}

// ------------------------------------------------------------------------------------------- cancel

#[derive(Serialize)]
pub struct CancelOut {
    pub ok: bool,
    pub acct: String,
    pub hl: Value,
}

/// Mode 3. Cancels go through the gateway too, so its ledger stays right. A cancel never adds risk (a resting order
/// counts only against credit), so beyond the signature, the nonce and the lock nothing is checked.
pub fn cancel(input: &Input, host: &mut impl Host) -> Result<CancelOut, Refusal> {
    require_keeper_https(host)?;
    let auth = input
        .auth
        .as_ref()
        .ok_or_else(|| input_err("a cancel needs auth: the owner's signed message"))?;
    let m: CancelMessage = msg::parse_exact(&auth.message).map_err(input_err)?;
    if m.pb != "cancel" {
        return refuse(
            "INPUT",
            format!("the signed message is a {:?}, not a cancel", m.pb),
        );
    }
    if m.account != input.account {
        return refuse(
            "AUTH",
            format!(
                "the signed message is for {}, not {}",
                m.account, input.account
            ),
        );
    }
    nep413::verify(auth).map_err(|e| Refusal {
        code: "AUTH",
        reason: e,
    })?;
    let chain = chain_auth(host, &input.network, &input.account, auth, m.expires_ms)?;
    let now = host.net().now_ms();
    use_nonce(host, auth, now)?;
    let account = input.account.clone();
    with_lock(host, &account, |host| {
        let (_, key) = master_and_agent(host, &account, &chain.state)?;
        let asset = asset_number(host, &m.cancel.coin)?;
        let mut ledger = Ledger::load(host.store(), &account).unwrap_or_default();
        ledger.prune(now);
        let hl_nonce = ledger.next_nonce(now);
        ledger.last_nonce = hl_nonce;
        let action = hlsign::CancelAction::one(asset, m.cancel.oid);
        let answer = post_action(host, &key, &action, hl_nonce)?;
        let _ = ledger.save(host.store(), &account);
        let reply = answer.map_err(|why| Refusal {
            code: "HL",
            reason: why,
        })?;
        match reply.pointer("/response/data/statuses/0") {
            Some(Value::String(s)) if s == "success" => {
                ledger.sent.retain(|x| x.oid != Some(m.cancel.oid));
                let _ = ledger.save(host.store(), &account);
                Ok(CancelOut {
                    ok: true,
                    acct: account.clone(),
                    hl: reply,
                })
            }
            Some(s) if s.get("error").is_some() => refuse(
                "HL",
                format!(
                    "Hyperliquid refused the cancel: {}",
                    s["error"].as_str().unwrap_or("no reason given")
                ),
            ),
            _ => refuse(
                "HL",
                format!(
                    "Hyperliquid refused the cancel: {}",
                    pb_read::util::clip(&reply.to_string(), 200)
                ),
            ),
        }
    })
}

/// A coin's asset number on Hyperliquid testnet, from `meta` (it differs between networks).
fn asset_number(host: &mut impl Host, coin: &str) -> Result<u32, Refusal> {
    let meta =
        read::hl_info(host.net(), TESTNET.hl_info, json!({"type": "meta"})).map_err(|e| {
            Refusal {
                code: "READ",
                reason: format!("cannot read Hyperliquid's market: {e}"),
            }
        })?;
    meta.get("universe")
        .and_then(Value::as_array)
        .and_then(|u| {
            u.iter()
                .position(|a| a.get("name").and_then(Value::as_str) == Some(coin))
        })
        .map(|i| i as u32)
        .ok_or_else(|| input_err(format!("{coin} is not listed on Hyperliquid testnet")))
}

// ------------------------------------------------------------------------------------- set_leverage

#[derive(Serialize)]
pub struct LeverageOut {
    pub ok: bool,
    pub acct: String,
    pub set: std::collections::BTreeMap<String, u32>,
    pub hl: std::collections::BTreeMap<String, Value>,
}

/// For one coin: the largest whole leverage at which a position using all of the account's Hyperliquid equity, in
/// either direction, still keeps P8 and P9 true (RISK_ENGINE.md 9, P0's second lock). Hyperliquid caps a position at
/// leverage × equity, so its own margin check then refuses anything bigger. None when even 1× fails, or with no loan
/// (P8 and P9 protect the loan).
pub fn leverage_for(eng: &Engine, a: &Account, m: &Market, coin: &str) -> Option<u32> {
    if a.debt <= 0.0 || !m.mark.contains_key(coin) {
        return None;
    }
    let max = eng.find_coin(coin)?.hl_max_leverage.max(1);
    let mark = m.mark_price(coin);
    let equity = eng.hl_equity_now(a, m);
    if equity <= 0.0 {
        return None;
    }
    let holds = |lev: u32| {
        [1.0, -1.0].iter().all(|dir| {
            // The position at full use: leverage × equity of notional in this direction.
            let target = dir * f64::from(lev) * equity / mark;
            let size = target - a.perps.get_or(coin, 0.0);
            let fill = worst_fill(size, mark, mark);
            let (a2, _) = eng.post_trade(a, m, coin, size, fill);
            let rq = eng.requirement(&a2, m);
            eng.credit_failures(&a2, m, Some(&rq)).is_empty()
                && eng.hl_ratio(&a2, m, None) <= eng.params.hl_ratio_pretrade
        })
    };
    if !holds(1) {
        return None;
    }
    // The largest that holds: more leverage only allows a bigger position, so the search can halve.
    let (mut lo, mut hi) = (1u32, max);
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        if holds(mid) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    Some(lo)
}

/// Mode 4. Needs no owner signature: the gateway picks the numbers. For each allow-listed coin the account has a
/// position in, it sets cross leverage (`updateLeverage`, signed by the agent) to [`leverage_for`]'s answer, or 1×
/// when even that fails. With no loan it sets nothing.
pub fn set_leverage(input: &Input, host: &mut impl Host) -> Result<LeverageOut, Refusal> {
    require_keeper_https(host)?;
    if input.auth.is_some() {
        return refuse("INPUT", "set_leverage takes no auth");
    }
    let account = input.account.clone();
    with_lock(host, &account, |host| {
        let inp = host.read_book(&book_request(&account), &BTreeSet::new());
        if let Some(reason) = &inp.fatal {
            return refuse("READ", reason.clone());
        }
        let (_, key) = master_and_agent(host, &account, &inp.near.state)?;
        let b = book::build(&inp).map_err(|e| Refusal {
            code: "READ",
            reason: e,
        })?;
        let mut set = std::collections::BTreeMap::new();
        let mut answers = std::collections::BTreeMap::new();
        if b.account.debt <= 0.0 {
            return Ok(LeverageOut {
                ok: true,
                acct: account.clone(),
                set,
                hl: answers,
            });
        }
        let now = host.net().now_ms();
        let mut ledger = Ledger::load(host.store(), &account).unwrap_or_default();
        ledger.prune(now);
        let coins: Vec<String> = b
            .account
            .perps
            .iter()
            .filter(|(c, &q)| q != 0.0 && b.engine.find_coin(c).is_some_and(|x| x.allowed))
            .map(|(c, _)| c.to_string())
            .collect();
        for coin in coins {
            let lev = leverage_for(&b.engine, &b.account, &b.built.market, &coin).unwrap_or(1);
            let Some(asset) = inp
                .hl
                .assets
                .get(&coin)
                .and_then(|a| a.get("index"))
                .and_then(u64_of)
            else {
                continue;
            };
            let hl_nonce = ledger.next_nonce(host.net().now_ms());
            ledger.last_nonce = hl_nonce;
            let action = hlsign::UpdateLeverageAction::cross(asset as u32, lev);
            let reply = post_action(host, &key, &action, hl_nonce)?;
            match reply {
                Ok(v) if v.get("status") == Some(&json!("ok")) => {
                    set.insert(coin.clone(), lev);
                    answers.insert(coin, v);
                }
                Ok(v) => {
                    answers.insert(coin, v);
                }
                Err(why) => {
                    answers.insert(coin, json!({"error": why}));
                }
            }
        }
        let _ = ledger.save(host.store(), &account);
        Ok(LeverageOut {
            ok: true,
            acct: account.clone(),
            set,
            hl: answers,
        })
    })
}

// ------------------------------------------------------------------------------- deleverage, cancel_risky

/// A stored plan older than this (block time) isn't placed: its sizes and prices are from another market. The keeper
/// asks for a new check instead.
pub const PLAN_MAX_AGE_NS: u64 = 30 * 60 * 1_000_000_000;
/// A step record still `sending` after this long belongs to a run that stopped mid-way: its order may have gone.
pub const SENDING_STALE_MS: u64 = 60_000;

/// `step:<A>:<pid>:<i>`: one plan step's record, so each runs once.
pub fn step_key(account: &str, pid: &str, i: usize) -> String {
    format!("step:{account}:{pid}:{i}")
}

/// What the gateway keeps for a plan step it ran. `status` is `sending` while the run posts it; then `filled`,
/// `partial` or `resting` for an order, `done` for a cancel, `unknown` when Hyperliquid didn't answer, or `refused`
/// when nothing was placed. Only a `refused` step may be tried again.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct StepRecord {
    pub status: String,
    pub at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oid: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filled_sz: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avg_px: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<Vec<u64>>,
}

/// A step the run placed (or cancelled for).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Placed {
    pub i: usize,
    pub k: &'static str,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oid: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filled_sz: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<Vec<u64>>,
}

/// A step the run left alone, and why.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Skipped {
    pub i: usize,
    pub k: &'static str,
    pub why: String,
}

/// A step the run tried and refused, with its code: `P2` when `px` has left the band, `P3` when the position no
/// longer lets it only reduce, `P10` at 60 orders a minute, `INPUT` for a step not in Hyperliquid's form, `HL` when
/// Hyperliquid refused it. Nothing was placed, so a later run may try again.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StepRefused {
    pub i: usize,
    pub k: &'static str,
    pub code: &'static str,
    pub reason: String,
}

/// What `deleverage` answers (INTERFACES.md 16).
#[derive(Serialize)]
pub struct DeleverageOut {
    pub ok: bool,
    pub acct: String,
    pub pid: String,
    pub placed: Vec<Placed>,
    pub skipped: Vec<Skipped>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub refused: Vec<StepRefused>,
}

/// A plan step's record, as stored, with its bytes, which a retry swaps from.
fn load_record(host: &mut impl Host, key: &str) -> Result<Option<(Vec<u8>, StepRecord)>, Refusal> {
    let raw = host.store().get(key).map_err(|e| Refusal {
        code: "READ",
        reason: format!("storage: {e}"),
    })?;
    Ok(raw.map(|b| {
        // A record that doesn't parse counts as placed: it only ever adds caution.
        let r = serde_json::from_slice(&b).unwrap_or_else(|_| StepRecord {
            status: "unknown".into(),
            ..StepRecord::default()
        });
        (b, r)
    }))
}

/// Takes a step for this run: from absent, or from a `refused` record. False if another run has it, or it ran.
fn claim_step(
    host: &mut impl Host,
    key: &str,
    old: Option<&[u8]>,
    now_ms: u64,
) -> Result<bool, Refusal> {
    let sending = serde_json::to_vec(&StepRecord {
        status: "sending".into(),
        at_ms: now_ms,
        ..StepRecord::default()
    })
    .expect("a record serialises");
    let r = match old {
        None => host.store().set_if_absent(key, &sending),
        Some(old) => host
            .store()
            .set_if_equals(key, old, &sending)
            .map(|(won, _)| won),
    };
    r.map_err(|e| Refusal {
        code: "READ",
        reason: format!("storage: {e}"),
    })
}

fn save_record(host: &mut impl Host, key: &str, r: &StepRecord) {
    // A failed write leaves `sending`, which counts as placed: the step can't run twice.
    if let Ok(bytes) = serde_json::to_vec(r) {
        let _ = host.store().set(key, &bytes);
    }
}

/// A cloid for plan step `i` of plan `pid`, so its fills can be found: `0x` and the first 16 bytes of
/// sha256("pb-gateway plan:" ‖ account ‖ ":" ‖ pid ‖ ":" ‖ i).
pub fn plan_cloid(account: &str, pid: &str, i: usize) -> String {
    format!(
        "0x{}",
        &sha256_hex(format!("pb-gateway plan:{account}:{pid}:{i}").as_bytes())[..32]
    )
}

/// The account's resting orders that add risk now (RISK_ENGINE.md 9, risk-core's `risky_orders`), with their ids:
/// from Hyperliquid's open orders, against the positions as read.
pub fn risky_open_orders(positions: &Account, orders: &Value) -> Vec<hlr::OpenOrder> {
    let open = hlr::open_orders(orders);
    let a = Account {
        perps: positions.perps.clone(),
        orders: open
            .iter()
            .map(|o| Order {
                coin: o.coin.clone(),
                size: o.size,
                limit_px: o.limit_px,
                reduce_only: o.reduce_only,
            })
            .collect(),
        ..Account::default()
    };
    risky_orders(&a)
        .into_iter()
        .map(|i| open[i].clone())
        .collect()
}

/// Cancels `orders` in one signed action. Returns the ids Hyperliquid cancelled, or no longer holds (already
/// cancelled or filled), and its answer; an order it refused for another reason stays, and is reported.
fn cancel_orders(
    host: &mut impl Host,
    key: &k256::ecdsa::SigningKey,
    ledger: &mut Ledger,
    inp: &Inputs,
    orders: &[hlr::OpenOrder],
    now_ms: u64,
) -> Result<(Vec<u64>, Value), Refusal> {
    if orders.is_empty() {
        return Ok((Vec::new(), Value::Null));
    }
    let mut assets: BTreeMap<String, u32> = BTreeMap::new();
    for o in orders {
        let known = inp
            .hl
            .assets
            .get(&o.coin)
            .and_then(|a| a.get("index"))
            .and_then(u64_of)
            .map(|x| x as u32);
        let a = match known {
            Some(a) => a,
            None => asset_number(host, &o.coin)?,
        };
        assets.insert(o.coin.clone(), a);
    }
    let action = hlsign::CancelAction {
        kind: "cancel",
        cancels: orders
            .iter()
            .map(|o| hlsign::CancelWire {
                a: assets[&o.coin],
                o: o.oid,
            })
            .collect(),
    };
    let hl_nonce = ledger.next_nonce(now_ms);
    ledger.last_nonce = hl_nonce;
    let reply = post_action(host, key, &action, hl_nonce)?.map_err(|why| Refusal {
        code: "HL",
        reason: why,
    })?;
    let statuses = reply
        .pointer("/response/data/statuses")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut gone = Vec::new();
    for (o, st) in orders.iter().zip(&statuses) {
        let ok = st == "success"
            || st
                .get("error")
                .and_then(Value::as_str)
                .is_some_and(|e| e.contains("already canceled") || e.contains("filled"));
        if ok {
            gone.push(o.oid);
        }
    }
    ledger
        .sent
        .retain(|x| x.oid.is_none_or(|oid| !gone.contains(&oid)));
    if gone.len() < orders.len() {
        return refuse(
            "HL",
            format!(
                "Hyperliquid cancelled {} of {} resting orders: {}",
                gone.len(),
                orders.len(),
                pb_read::util::clip(&reply.to_string(), 200)
            ),
        );
    }
    Ok((gone, reply))
}

/// Places plan step `i`, a perp step, as a reduce-only IOC order at its `px`, after the checks that can still fail
/// since the verdict: Hyperliquid's form (INPUT), the band around today's reference price (P2), that the position
/// still lets it only reduce (P3), and 60 orders a minute (P10).
#[allow(clippy::too_many_arguments)]
fn place_step(
    host: &mut impl Host,
    key: &k256::ecdsa::SigningKey,
    ledger: &mut Ledger,
    inp: &Inputs,
    b: &Book,
    fills: &Value,
    account: &str,
    pid: &str,
    i: usize,
    step: &PlanStep,
) -> Result<Placed, StepRefused> {
    let PlanStep::Perp { coin, buy, sz, px } = step else {
        unreachable!("only perp steps are placed");
    };
    let no = |code: &'static str, reason: String| StepRefused {
        i,
        k: "perp",
        code,
        reason,
    };
    let now = host.net().now_ms();
    if ledger.in_last_minute(now) >= store::MAX_ORDERS_PER_MINUTE {
        return Err(no(
            "P10",
            "more than 60 orders in the last minute: wait a little".into(),
        ));
    }
    let asset = inp.hl.assets.get(coin.as_str());
    let (Some(index), Some(sz_decimals)) = (
        asset.and_then(|a| a.get("index")).and_then(u64_of),
        asset
            .and_then(|a| a.pointer("/meta/szDecimals"))
            .and_then(u64_of),
    ) else {
        return Err(no(
            "INPUT",
            format!("Hyperliquid's market has no asset number or size decimals for {coin}"),
        ));
    };
    let (size, price) =
        msg::check_rounding(sz, px, sz_decimals as u32).map_err(|e| no("INPUT", e))?;
    // P2, against the reference price now, or Hyperliquid's mark while it is uncertain (P10).
    let m = &b.built.market;
    let reference = if b.built.uncertain.contains(coin.as_str()) {
        m.mark.get(coin.as_str())
    } else {
        m.px.get(coin.as_str())
    };
    let Some(&reference) = reference else {
        return Err(no(
            "P10",
            format!("no reference price for {coin}: ask for a new verdict"),
        ));
    };
    // The coin's band, or testnet's floor when that is larger (INTERFACES.md 42), as for an owner's order.
    let band = p2_band(
        b.engine.coin(coin).params.price_band,
        Some(TESTNET.price_band_floor),
    );
    if (price.value / reference - 1.0).abs() > band + 1e-9 {
        return Err(no(
            "P2",
            format!(
                "px {px} has left {coin}'s {:.0}% band around {reference:.2}: ask for a new verdict",
                band * 100.0
            ),
        ));
    }
    // P3: the order must only reduce the position, counting the gateway's own orders Hyperliquid doesn't show yet.
    let signed = if *buy { size.value } else { -size.value };
    let unshown: f64 = ledger
        .sent
        .iter()
        .filter(|s| s.coin == *coin && now.saturating_sub(s.at_ms) < store::RECENT_FILL_MS)
        .filter(|s| !shown(s, fills, &inp.hl.orders))
        .map(|s| s.size)
        .sum();
    let q0 = b.account.perps.get_or(coin, 0.0) + unshown;
    let q1 = q0 + signed;
    if !(q1.abs() < q0.abs() && (sgn(q1) == 0 || sgn(q1) == sgn(q0))) {
        return Err(no(
            "P3",
            format!("the {coin} position is {q0}: this step would not only reduce it, so ask for a new verdict"),
        ));
    }
    // Claimed in storage before it is sent, so it can't go twice.
    let key_name = step_key(account, pid, i);
    let old = load_record(host, &key_name).map_err(|r| no(r.code, r.reason))?;
    let old_bytes = old.as_ref().map(|(bytes, _)| bytes.clone());
    if !claim_step(host, &key_name, old_bytes.as_deref(), now).map_err(|r| no(r.code, r.reason))? {
        return Err(no("P0", "another run has just taken this step".into()));
    }
    let cloid = plan_cloid(account, pid, i);
    let action = OrderAction::one(OrderWire {
        a: index as u32,
        b: *buy,
        p: px.clone(),
        s: sz.clone(),
        r: true,
        t: OrderType {
            limit: hlsign::Limit { tif: "Ioc".into() },
        },
        c: Some(cloid.clone()),
    });
    let hl_nonce = ledger.next_nonce(now);
    ledger.last_nonce = hl_nonce;
    let mut sent = Sent {
        at_ms: hl_nonce,
        coin: coin.clone(),
        size: signed,
        limit_px: price.value,
        cloid,
        oid: None,
        status: "unknown".into(),
        reduce_only: true,
    };
    let mut record = StepRecord {
        status: "unknown".into(),
        at_ms: now,
        ..StepRecord::default()
    };
    let answer = match post_action(host, key, &action, hl_nonce) {
        Ok(a) => a,
        Err(r) => {
            // Nothing was sent: the step may be tried again.
            record.status = "refused".into();
            save_record(host, &key_name, &record);
            return Err(no(r.code, r.reason));
        }
    };
    let reply = match answer {
        Err(_) => {
            // It may have been placed: it counts as filled for 10 s, and never goes again.
            ledger.sent.push(sent);
            save_record(host, &key_name, &record);
            return Ok(Placed {
                i,
                k: "perp",
                status: "unknown".into(),
                oid: None,
                filled_sz: None,
                avg_px: None,
                cancelled: None,
            });
        }
        Ok(v) => v,
    };
    let status = reply.pointer("/response/data/statuses/0");
    let refused_by_hl = |why: String| StepRefused {
        i,
        k: "perp",
        code: "HL",
        reason: why,
    };
    match status {
        Some(st) if st.get("filled").is_some() => {
            let f = &st["filled"];
            let total = f
                .get("totalSz")
                .and_then(Value::as_str)
                .unwrap_or("0")
                .to_string();
            let filled: f64 = total.parse().unwrap_or(0.0);
            record.status = if (filled - size.value).abs() < 1e-12 {
                "filled"
            } else {
                "partial"
            }
            .into();
            record.oid = f.get("oid").and_then(u64_of);
            record.filled_sz = Some(total);
            record.avg_px = f.get("avgPx").and_then(Value::as_str).map(String::from);
            sent.size = if *buy { filled } else { -filled };
        }
        Some(st) if st.get("resting").is_some() => {
            record.status = "resting".into();
            record.oid = st.pointer("/resting/oid").and_then(u64_of);
            record.filled_sz = Some("0".into());
        }
        other => {
            // Nothing was placed: the step may be tried again.
            record.status = "refused".into();
            save_record(host, &key_name, &record);
            let why = other
                .and_then(|s| s.get("error"))
                .and_then(Value::as_str)
                .map_or_else(
                    || pb_read::util::clip(&reply.to_string(), 200),
                    String::from,
                );
            return Err(refused_by_hl(format!(
                "Hyperliquid refused the order: {why}"
            )));
        }
    }
    sent.oid = record.oid;
    sent.status = record.status.clone();
    ledger.sent.push(sent);
    save_record(host, &key_name, &record);
    Ok(Placed {
        i,
        k: "perp",
        status: record.status,
        oid: record.oid,
        filled_sz: record.filled_sz,
        avg_px: record.avg_px,
        cancelled: None,
    })
}

/// Mode `deleverage` (INTERFACES.md 16). Over HTTPS from the keeper, with no owner signature: it only places the
/// account's stored, attested plan (`get_state().plan`). Under the account's lock (P0), for each `cancel` and `perp`
/// step not yet run, in order, it cancels the resting orders that add risk, or places the perp step as a reduce-only
/// IOC at its `px`. Each is recorded under `step:<A>:<pid>:<i>`, so it runs once. The other steps are the account's
/// `execute_step`, and are listed as skipped.
pub fn deleverage(input: &Input, host: &mut impl Host) -> Result<DeleverageOut, Refusal> {
    require_keeper_https(host)?;
    if input.auth.is_some() {
        return refuse(
            "INPUT",
            "deleverage takes no auth: it places the account's stored plan",
        );
    }
    let account = input.account.clone();
    with_lock(host, &account, |host| {
        // A perp step reduces a position the account holds, so the book's own reads price its coin.
        let inp = host.read_book(&book_request(&account), &BTreeSet::new());
        if let Some(reason) = &inp.fatal {
            return refuse("READ", reason.clone());
        }
        // The plan read with the book, at its block, is the one placed.
        let plan = plan_steps::stored_plan(&inp.near.state)
            .map_err(input_err)?
            .ok_or_else(|| input_err(format!("{account} holds no plan to run")))?;
        let now_ns: u64 = inp.block.timestamp_ns.parse().unwrap_or(0);
        if now_ns.saturating_sub(plan.stored_at_ns) > PLAN_MAX_AGE_NS {
            return refuse(
                "INPUT",
                format!(
                    "plan {} is more than 30 minutes old: ask for a new check",
                    plan.pid
                ),
            );
        }
        let (master, key) = master_and_agent(host, &account, &inp.near.state)?;
        let b = book::build(&inp).map_err(|e| Refusal {
            code: "READ",
            reason: e,
        })?;
        let now = host.net().now_ms();
        let fills = recent_fills(host, &master, now);
        let mut ledger = Ledger::load(host.store(), &account).map_err(|e| Refusal {
            code: "READ",
            reason: format!("storage: {e}"),
        })?;
        ledger.prune(now);
        let mut out = DeleverageOut {
            ok: true,
            acct: account.clone(),
            pid: plan.pid.clone(),
            placed: Vec::new(),
            skipped: Vec::new(),
            refused: Vec::new(),
        };
        for (i, (step, done)) in plan.steps.iter().enumerate() {
            let k = step.kind();
            if !step.for_gateway() || *done {
                let why = if *done {
                    "done"
                } else {
                    "execute_step runs it"
                };
                out.skipped.push(Skipped {
                    i,
                    k,
                    why: why.into(),
                });
                continue;
            }
            let key_name = step_key(&account, &plan.pid, i);
            if let Some((_, r)) = load_record(host, &key_name)? {
                let stale = r.status == "sending" && now.saturating_sub(r.at_ms) > SENDING_STALE_MS;
                if r.status != "refused" {
                    let why = if stale {
                        "a run stopped while sending it: it may have gone, so it isn't sent again"
                            .to_string()
                    } else {
                        format!("ran before: {}", r.status)
                    };
                    out.skipped.push(Skipped { i, k, why });
                    continue;
                }
            }
            match step {
                PlanStep::Cancel {} => {
                    let old = load_record(host, &key_name)?.map(|(bytes, _)| bytes);
                    if !claim_step(host, &key_name, old.as_deref(), now)? {
                        out.skipped.push(Skipped {
                            i,
                            k,
                            why: "another run has just taken it".into(),
                        });
                        continue;
                    }
                    let risky = risky_open_orders(&b.account, &inp.hl.orders);
                    match cancel_orders(host, &key, &mut ledger, &inp, &risky, now) {
                        Ok((gone, _)) => {
                            let record = StepRecord {
                                status: "done".into(),
                                at_ms: now,
                                cancelled: Some(gone.clone()),
                                ..StepRecord::default()
                            };
                            save_record(host, &key_name, &record);
                            out.placed.push(Placed {
                                i,
                                k,
                                status: "done".into(),
                                oid: None,
                                filled_sz: None,
                                avg_px: None,
                                cancelled: Some(gone),
                            });
                        }
                        Err(r) => {
                            // A cancel can always be tried again.
                            save_record(
                                host,
                                &key_name,
                                &StepRecord {
                                    status: "refused".into(),
                                    at_ms: now,
                                    ..StepRecord::default()
                                },
                            );
                            out.refused.push(StepRefused {
                                i,
                                k,
                                code: r.code,
                                reason: r.reason,
                            });
                        }
                    }
                }
                PlanStep::Perp { .. } => {
                    match place_step(
                        host,
                        &key,
                        &mut ledger,
                        &inp,
                        &b,
                        &fills,
                        &account,
                        &plan.pid,
                        i,
                        step,
                    ) {
                        Ok(p) => out.placed.push(p),
                        Err(r) => out.refused.push(r),
                    }
                }
                _ => unreachable!("for_gateway() is cancel and perp"),
            }
        }
        let _ = ledger.save(host.store(), &account);
        Ok(out)
    })
}

/// What `cancel_risky` answers.
#[derive(Serialize)]
pub struct CancelRiskyOut {
    pub ok: bool,
    pub acct: String,
    pub cancelled: Vec<CancelledOrder>,
    pub hl: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CancelledOrder {
    pub coin: String,
    pub oid: u64,
}

/// Mode `cancel_risky` (INTERFACES.md 16). Over HTTPS from the keeper, with no owner signature, when the account has
/// left HEALTHY: it cancels the resting orders that add risk (RISK_ENGINE.md 9), under the account's lock. The held
/// verdict must say so: an account whose verdict is HEALTHY keeps its orders.
pub fn cancel_risky(input: &Input, host: &mut impl Host) -> Result<CancelRiskyOut, Refusal> {
    require_keeper_https(host)?;
    if input.auth.is_some() {
        return refuse("INPUT", "cancel_risky takes no auth");
    }
    let account = input.account.clone();
    with_lock(host, &account, |host| {
        let inp = host.read_book(&book_request(&account), &BTreeSet::new());
        if let Some(reason) = &inp.fatal {
            return refuse("READ", reason.clone());
        }
        let held = inp
            .near
            .state
            .pointer("/verdict/verdict/state")
            .and_then(Value::as_str)
            .unwrap_or("");
        if held.is_empty() || held == "HEALTHY" {
            return refuse(
                "INPUT",
                format!(
                    "{account}'s verdict is {}: its resting orders stay",
                    if held.is_empty() { "missing" } else { held }
                ),
            );
        }
        let (_, key) = master_and_agent(host, &account, &inp.near.state)?;
        let b = book::build(&inp).map_err(|e| Refusal {
            code: "READ",
            reason: e,
        })?;
        let risky = risky_open_orders(&b.account, &inp.hl.orders);
        let now = host.net().now_ms();
        let mut ledger = Ledger::load(host.store(), &account).unwrap_or_default();
        ledger.prune(now);
        let result = cancel_orders(host, &key, &mut ledger, &inp, &risky, now);
        let _ = ledger.save(host.store(), &account);
        let (gone, reply) = result?;
        Ok(CancelRiskyOut {
            ok: true,
            acct: account.clone(),
            cancelled: risky
                .iter()
                .filter(|o| gone.contains(&o.oid))
                .map(|o| CancelledOrder {
                    coin: o.coin.clone(),
                    oid: o.oid,
                })
                .collect(),
            hl: reply,
        })
    })
}
