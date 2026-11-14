//! The reads (INTERFACES.md 6, research/day1.md "11. Calls per run"): the NEAR views at one final block, the
//! Hyperliquid account and market, and the exchanges' prices and candles. Written against a transport trait, so
//! tests replay canned answers natively; the program plugs in WASI HTTP.
//!
//! For one coin held (the demo's BTC), a run makes 23 calls: 10 to NEAR, 1 to Hyperliquid (5 for an account with
//! a Hyperliquid address: its clearinghouse state, open orders, account mode and spot balances; 6 while a move to
//! Hyperliquid is pending, for its ledger), and 12 to the exchanges (4 tickers, 3 minute-candle and 5 hour-candle
//! requests, since OKX pages 300 hours at a time). Each further coin adds 12. An account holding nothing needs only
//! the 10.
//!
//! While the account has a transfer out of Hyperliquid open (`get_state().hl.open_sends`, INTERFACES.md 50.2),
//! pb-risk's run makes one more call to Hyperliquid, and makes it first: the ledger, to see which of them went
//! through, before the balances. pb-gateway's read ([`read_all_with`]) doesn't make it.
//!
//! Phase 6 (FUNDING.md 6.1) adds the lenders the account's config names, and nothing for an account that names
//! none: for Rhea, 2 views and one more per token (USDC and each collateral token) at the same block, right after
//! the account's own views; for Aave, 12 Ethereum calls for one collateral token (6 more per further token: 18 for
//! testnet's WBTC and WETH), made as the last thing a run reads, in two requests: the chain's block number, then
//! one batch of them all pinned to that block (`read_aave`). An endpoint that refuses batches gets them one by
//! one. A lender that can't be read is fatal.
use crate::book::{coins_to_read, held_coins};
use crate::evm;
use crate::hl;
use crate::inputs::{AaveReads, CoinReads, Inputs, RheaReads, Ticker};
use crate::near;
use crate::request::Request;
use crate::util::{base64, clip, f64_of, u64_of};
use serde_json::{json, Value};
use std::collections::BTreeSet;

/// An HTTP answer.
pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
}

/// What the reads need from the outside: HTTPS and a clock.
pub trait Net {
    fn get(&mut self, url: &str) -> Result<Reply, String>;
    fn post(&mut self, url: &str, body: &str) -> Result<Reply, String>;
    /// Unix time in ms.
    fn now_ms(&mut self) -> u64;
    /// Waits before a retry.
    fn pause(&mut self, _ms: u64) {}
    /// Several GETs, answered in the order asked. By default one after another; the WASI transport sends them
    /// together. Only the Phase 5 modes (`credit_check`, `book`) use it, so `check` and `preview` read as before.
    fn get_all(&mut self, urls: &[String]) -> Vec<Result<Reply, String>> {
        urls.iter().map(|u| self.get(u)).collect()
    }
    /// Several POSTs (url, body), as [`Net::get_all`].
    fn post_all(&mut self, reqs: &[(String, String)]) -> Vec<Result<Reply, String>> {
        reqs.iter().map(|(u, b)| self.post(u, b)).collect()
    }
}

/// A transport behind a reference is a transport, so callers can lend theirs.
impl<T: Net + ?Sized> Net for &mut T {
    fn get(&mut self, url: &str) -> Result<Reply, String> {
        (**self).get(url)
    }
    fn post(&mut self, url: &str, body: &str) -> Result<Reply, String> {
        (**self).post(url, body)
    }
    fn now_ms(&mut self) -> u64 {
        (**self).now_ms()
    }
    fn pause(&mut self, ms: u64) {
        (**self).pause(ms)
    }
    fn get_all(&mut self, urls: &[String]) -> Vec<Result<Reply, String>> {
        (**self).get_all(urls)
    }
    fn post_all(&mut self, reqs: &[(String, String)]) -> Vec<Result<Reply, String>> {
        (**self).post_all(reqs)
    }
}

/// The wait before retrying a NEAR RPC call that was rate-limited or failed.
pub const RETRY_PAUSE_MS: u64 = 500;

/// Optional reads stop once this much of the run has passed (a check may run 20 s).
pub const READ_BUDGET_MS: u64 = 13_000;

/// How far before the oldest open send its ledger read starts. Hyperliquid stamps a transfer after the nonce it
/// was signed with (13 seconds after, on 13 Nov), and takes no nonce more than a day ahead of its own clock.
pub const SENT_LOOKBACK_MS: u64 = 3_600_000;

/// Reads everything the verdict needs for `req`. A read the verdict can't do without (the block, the account, the
/// pool, a balance) ends the run with `fatal` set; a missing price source is only listed in `errors`.
///
/// This is pb-risk's read, so it also looks for the account's open sends in Hyperliquid's ledger (INTERFACES.md
/// 50.2), which only a verdict can name.
pub fn read_all(net: &mut impl Net, req: &Request) -> Inputs {
    read_inputs(net, req, &BTreeSet::new(), false, true)
}

/// [`read_all`], also pricing the coins in `extra` (pb-gateway: the coin of an order the account doesn't hold yet)
/// and, with `resting`, the coins of the account's resting orders. It doesn't look for open sends: the gateway
/// names none, and reads what it always read.
pub fn read_all_with(
    net: &mut impl Net,
    req: &Request,
    extra: &BTreeSet<String>,
    resting: bool,
) -> Inputs {
    read_inputs(net, req, extra, resting, false)
}

fn read_inputs(
    net: &mut impl Net,
    req: &Request,
    extra: &BTreeSet<String>,
    resting: bool,
    sends: bool,
) -> Inputs {
    let mut inp = Inputs::new(req.clone());
    inp.band_floor = req.net().price_band_floor;
    let start = net.now_ms();
    if let Err(reason) = read_near(net, &mut inp) {
        inp.fatal = Some(reason);
        return inp;
    }
    // A lender the config names that can't be read stops the run (FUNDING.md 6.1): no verdict, never a guess.
    if let Err(reason) = read_rhea(net, &mut inp) {
        inp.fatal = Some(reason);
        return inp;
    }
    if let Err(reason) = read_hl_account(net, &mut inp, sends) {
        inp.fatal = Some(reason);
        return inp;
    }
    // If the account's config or balances don't parse, the verdict says so; nothing more to read.
    if let Ok(mut held) = held_coins(&inp) {
        held.extend(extra.iter().cloned());
        if resting {
            if let Ok(hla) = hl::account_of(&inp.hl) {
                // Only coins of the universe can be priced; the gateway never places any other.
                let universe: Value =
                    serde_json::from_str(risk_core::universe::UNIVERSE_V0).unwrap_or_default();
                held.extend(
                    hla.orders
                        .iter()
                        .filter(|o| universe.pointer(&format!("/coins/{}", o.coin)).is_some())
                        .map(|o| o.coin.clone()),
                );
            }
        }
        let coins = coins_to_read(&held);
        if !coins.is_empty() {
            read_markets(net, &mut inp, &coins, start);
        }
    }
    // Aave last, its calls sent together, so the position is as fresh as the prices.
    if let Err(reason) = read_aave(net, &mut inp) {
        inp.fatal = Some(reason);
    }
    inp.now_ms = net.now_ms();
    inp
}

// ---------------------------------------------------------------------------------------------- lenders

/// Both lender reads for the account in `inp`, whose state and config are read already: Rhea at the inputs' block,
/// then Aave. The book stress test reads each account's lenders with it. Nothing is asked for an account whose
/// config names no lender.
pub fn read_lenders(net: &mut impl Net, inp: &mut Inputs) -> Result<(), String> {
    read_rhea(net, inp)?;
    read_aave(net, inp)
}

/// The Rhea position, at the run's block (INTERFACES.md 27): `get_account`, `get_assets` for USDC and the
/// collateral tokens, and each token's price setting (`get_token_pyth_info`, which carries a `default_price` if the
/// token has one). The view names are burrowland's (`account.rs`, `asset.rs`, `lib.rs`). Nothing is read for an
/// account whose config doesn't name Rhea.
fn read_rhea(net: &mut impl Net, inp: &mut Inputs) -> Result<(), String> {
    let Ok(conf) = near::config(&inp.near.config) else {
        return Ok(()); // the verdict refuses the config itself
    };
    let Some(rhea) = conf.lenders.rhea else {
        return Ok(());
    };
    let n = inp.request.net();
    let h = inp.block.height;
    let usdc = conf
        .tokens
        .iter()
        .find(|t| t.name == "USDC")
        .ok_or("the account's config names Rhea but lists no USDC token")?;
    let mut ids = vec![usdc.id.clone()];
    ids.extend(rhea.collateral.iter().cloned());
    let c = rhea.contract_id.as_str();
    let mut ask = |method: &str, args: Value| {
        view(net, n.near_rpc, h, c, method, &args)
            .map_err(|e| format!("cannot read the Rhea position: {}", e.reason(c, method)))
    };
    let account = ask("get_account", json!({"account_id": inp.request.account}))?;
    let assets = ask("get_assets", json!({ "token_ids": ids }))?;
    let mut prices = std::collections::BTreeMap::new();
    for id in &ids {
        prices.insert(id.clone(), ask("get_token_pyth_info", json!({ "token_id": id }))?);
    }
    inp.lenders.rhea = Some(RheaReads {
        contract_id: rhea.contract_id.clone(),
        account,
        assets,
        prices,
    });
    Ok(())
}

/// The Aave calls for one account at `block` (`latest`, or a block number as `evm::block_tag` writes it), as
/// (name, JSON-RPC request): the names are [`AaveReads::calls`]' keys, and the requests' ids run from 1 in this
/// order. Without an Ethereum address only the market is read.
pub fn aave_requests(
    aave: &near::AaveConf,
    chain: &evm::Chain,
    address: Option<&str>,
    block: &str,
) -> Vec<(String, Value)> {
    let usdc = aave.usdc.address.as_str();
    let mut out: Vec<(String, Value)> = Vec::new();
    let mut call = |name: String, to: &str, selector: &str, args: &[&str]| {
        let id = out.len() as u64 + 1;
        out.push((name, evm::eth_call_at(to, &evm::call_data(selector, args), block, id)));
    };
    call("reserve".to_string(), chain.data_provider, evm::GET_RESERVE_DATA, &[usdc]);
    call("free".to_string(), chain.data_provider, evm::GET_VIRTUAL_UNDERLYING_BALANCE, &[usdc]);
    for t in &aave.collateral {
        let token = t.address.as_str();
        call(format!("config:{token}"), chain.data_provider, evm::GET_RESERVE_CONFIGURATION_DATA, &[token]);
        call(format!("price:{token}"), chain.oracle, evm::GET_ASSET_PRICE, &[token]);
        // Whether the pool still takes the token: its supply cap, and what is supplied.
        call(format!("caps:{token}"), chain.data_provider, evm::GET_RESERVE_CAPS, &[token]);
        call(format!("supplied:{token}"), chain.data_provider, evm::GET_ATOKEN_TOTAL_SUPPLY, &[token]);
    }
    if let Some(user) = address {
        call("account".to_string(), &aave.pool, evm::GET_USER_ACCOUNT_DATA, &[user]);
        call("debt".to_string(), chain.data_provider, evm::GET_USER_RESERVE_DATA, &[usdc, user]);
        for t in &aave.collateral {
            let token = t.address.as_str();
            call(format!("posted:{token}"), chain.data_provider, evm::GET_USER_RESERVE_DATA, &[token, user]);
            call(format!("balance:{token}"), token, evm::BALANCE_OF, &[user]);
        }
        call(format!("balance:{usdc}"), usdc, evm::BALANCE_OF, &[user]);
        let id = out.len() as u64 + 1;
        out.push(("nonce".to_string(), evm::eth_nonce_at(user, block, id)));
    }
    out
}

/// [`aave_requests`] at the latest block, each as a request of its own (id 1), as (name, JSON-RPC body).
pub fn aave_asks(aave: &near::AaveConf, chain: &evm::Chain, address: Option<&str>) -> Vec<(String, String)> {
    aave_requests(aave, chain, address, "latest")
        .into_iter()
        .map(|(name, mut request)| {
            request["id"] = json!(1);
            (name, request.to_string())
        })
        .collect()
}

/// One Ethereum JSON-RPC answer's hex result.
fn evm_answer(reply: Result<Reply, String>) -> Result<String, String> {
    let r = reply?;
    if r.status != 200 {
        return Err(format!("HTTP {}", r.status));
    }
    let v: Value = serde_json::from_slice(&r.body).map_err(|_| "not JSON".to_string())?;
    evm::result_hex(&v)
}

/// The chain's latest block number: asked once, and once more after a pause. `None` if neither try answers.
fn evm_block(net: &mut impl Net, rpc: &str) -> Option<u64> {
    let ask = |net: &mut dyn Net| {
        evm_answer(net.post(rpc, &evm::eth_block_number())).ok().and_then(|hex| evm::quantity(&hex))
    };
    if let Some(block) = ask(net) {
        return Some(block);
    }
    net.pause(RETRY_PAUSE_MS);
    ask(net)
}

/// The Aave position and market (INTERFACES.md 27 and 33), from the chain's RPC, in two requests: the chain's
/// block number, then one JSON-RPC batch holding every call, each pinned to that block. So the position, the
/// balances, the caps and the nonce are all of one block, and the public RPC sees two requests, not eighteen.
///
/// Some endpoints refuse batches. If the batch isn't answered with a list of the same length, each call is sent
/// as a request of its own, together, as before (still pinned to the block; at `latest` if the block number got
/// no answer). Either way, a call left without an answer is asked once more after a pause, and if it still has
/// none the run stops: a lender that can't be read is no verdict.
///
/// The account's Ethereum address is its Hyperliquid address. Nothing is read for an account whose config doesn't
/// name Aave.
fn read_aave(net: &mut impl Net, inp: &mut Inputs) -> Result<(), String> {
    let Ok(conf) = near::config(&inp.near.config) else {
        return Ok(());
    };
    let Some(aave) = conf.lenders.aave else {
        return Ok(());
    };
    let chain = evm::chain(aave.chain_id).ok_or_else(|| {
        format!(
            "the account's config names Aave on chain {}, which this program can't read",
            aave.chain_id
        )
    })?;
    let address = near::state(&inp.near.state).ok().and_then(|s| s.hl_address);
    let block = evm_block(net, chain.rpc);
    let tag = block.map_or("latest".to_string(), evm::block_tag);
    let requests = aave_requests(&aave, chain, address.as_deref(), &tag);
    // One batch, when the block is known and the endpoint answers it as a batch.
    let batch = block.and_then(|_| {
        let body = Value::Array(requests.iter().map(|(_, r)| r.clone()).collect()).to_string();
        let reply = net.post(chain.rpc, &body).ok().filter(|r| r.status == 200)?;
        evm::batch_results(&serde_json::from_slice(&reply.body).ok()?, requests.len())
    });
    let answers: Vec<Option<String>> = match batch {
        Some(answers) => answers,
        None => {
            let singles: Vec<(String, String)> = requests
                .iter()
                .map(|(_, r)| (chain.rpc.to_string(), r.to_string()))
                .collect();
            net.post_all(&singles).into_iter().map(|r| evm_answer(r).ok()).collect()
        }
    };
    let mut calls = std::collections::BTreeMap::new();
    let mut paused = false;
    for ((name, request), answer) in requests.iter().zip(answers) {
        let hex = match answer {
            Some(hex) => hex,
            None => {
                if !paused {
                    net.pause(RETRY_PAUSE_MS);
                    paused = true;
                }
                evm_answer(net.post(chain.rpc, &request.to_string())).map_err(|e| {
                    format!(
                        "cannot read the Aave position on chain {}: {name}: {}",
                        aave.chain_id,
                        clip(&e, 160)
                    )
                })?
            }
        };
        calls.insert(name.clone(), hex);
    }
    inp.lenders.aave = Some(AaveReads {
        chain_id: aave.chain_id,
        address,
        block,
        calls,
    });
    Ok(())
}

// ------------------------------------------------------------------------------------------------- NEAR

/// Why a view call failed.
#[derive(Debug, PartialEq, Eq)]
pub enum ViewError {
    UnknownAccount,
    NoContract,
    NoMethod,
    Other(String),
}

impl ViewError {
    /// The refusal for a failed read of `what` on `account`.
    pub fn reason(&self, account: &str, what: &str) -> String {
        match self {
            ViewError::UnknownAccount => format!("account {account} does not exist on testnet"),
            ViewError::NoContract => format!("account {account} has no contract deployed"),
            ViewError::NoMethod => format!("account {account} has no {what} method"),
            ViewError::Other(m) => format!("cannot read {account}.{what}: {m}"),
        }
    }
}

/// One JSON-RPC call to NEAR, its `result`.
pub fn rpc(net: &mut impl Net, url: &str, method: &str, params: Value) -> Result<Value, ViewError> {
    let body =
        json!({"jsonrpc": "2.0", "id": "pb", "method": method, "params": params}).to_string();
    // One retry, after a pause, for a transport failure, a server error or a rate limit (HTTP 429); a contract's
    // own error comes back at once.
    let mut last = String::new();
    for attempt in 0..2 {
        if attempt > 0 {
            net.pause(RETRY_PAUSE_MS);
        }
        match net.post(url, &body) {
            Ok(r) if r.status < 500 && r.status != 429 => {
                let v: Value = serde_json::from_slice(&r.body).map_err(|_| {
                    ViewError::Other(format!("RPC answered HTTP {} without JSON", r.status))
                })?;
                return rpc_result(v);
            }
            Ok(r) => last = format!("RPC answered HTTP {}", r.status),
            Err(e) => last = e,
        }
    }
    Err(ViewError::Other(clip(&last, 160)))
}

/// A JSON-RPC answer's result, or why it failed. Contract errors come either as `result.error` (older nodes) or as
/// a JSON-RPC error whose text names the problem.
pub(crate) fn rpc_result(v: Value) -> Result<Value, ViewError> {
    let classify = |text: &str| {
        if text.contains("CodeDoesNotExist") || text.contains("NO_CONTRACT_CODE") {
            ViewError::NoContract
        } else if text.contains("MethodNotFound") || text.contains("MethodResolveError") {
            ViewError::NoMethod
        } else {
            ViewError::Other(clip(text, 160))
        }
    };
    if let Some(e) = v.get("error") {
        if e.pointer("/cause/name").and_then(Value::as_str) == Some("UNKNOWN_ACCOUNT") {
            return Err(ViewError::UnknownAccount);
        }
        return Err(classify(&e.to_string()));
    }
    let result = v
        .get("result")
        .ok_or_else(|| ViewError::Other("RPC answer has no result".into()))?;
    if let Some(e) = result.get("error").and_then(Value::as_str) {
        return Err(classify(e));
    }
    Ok(result.clone())
}

/// A view call at block `height`, its JSON result parsed.
pub fn view(
    net: &mut impl Net,
    rpc_url: &str,
    height: u64,
    account: &str,
    method: &str,
    args: &Value,
) -> Result<Value, ViewError> {
    let params = json!({"request_type": "call_function", "block_id": height, "account_id": account,
                        "method_name": method, "args_base64": base64(args.to_string().as_bytes())});
    let result = rpc(net, rpc_url, "query", params)?;
    let bytes: Vec<u8> = result
        .get("result")
        .and_then(Value::as_array)
        .ok_or_else(|| ViewError::Other("the view returned no bytes".into()))?
        .iter()
        .map(|b| b.as_u64().and_then(|b| u8::try_from(b).ok()))
        .collect::<Option<_>>()
        .ok_or_else(|| ViewError::Other("the view's bytes are not bytes".into()))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| ViewError::Other(format!("{method} did not return JSON")))
}

/// INTERFACES.md 21: the drill's ratio for `account`, `get_ratio_for({account_id})`, which is the account's own
/// ratio if the drill has one for it, else the shared one. A drill without that method (the code deployed before
/// Phase 5) is asked `get_ratio`, the shared ratio. Any other failure is the refusal's text, and π counts as unread.
pub fn drill_ratio(
    net: &mut impl Net,
    rpc_url: &str,
    height: u64,
    drill: &str,
    account: &str,
) -> Result<Value, String> {
    let who = json!({ "account_id": account });
    match view(net, rpc_url, height, drill, "get_ratio_for", &who) {
        Ok(v) => Ok(v),
        Err(ViewError::NoMethod) => view(net, rpc_url, height, drill, "get_ratio", &json!({}))
            .map_err(|e| e.reason(drill, "get_ratio")),
        Err(e) => Err(e.reason(drill, "get_ratio_for")),
    }
}

fn read_near(net: &mut impl Net, inp: &mut Inputs) -> Result<(), String> {
    let n = inp.request.net();
    let block = rpc(net, n.near_rpc, "block", json!({"finality": "final"}))
        .map_err(|e| format!("cannot read the latest final NEAR block: {e:?}"))?;
    let header = block.get("header").unwrap_or(&Value::Null);
    inp.block.height = header
        .get("height")
        .and_then(u64_of)
        .ok_or("the NEAR block has no height")?;
    inp.block.timestamp_ns = header
        .get("timestamp_nanosec")
        .or_else(|| header.get("timestamp"))
        .and_then(u64_of)
        .ok_or("the NEAR block has no timestamp")?
        .to_string();
    inp.block.hash = header
        .get("hash")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let h = inp.block.height;
    let account = inp.request.account.clone();
    let no_args = json!({});

    // The pool first: if the account turns out not to exist, a snapshot still shows that the pool was read.
    let mut pool_error = None;
    for (slot, method) in [
        ("pool", "get_pool"),
        ("params", "get_params"),
        ("coin_statuses", "coin_statuses"),
    ] {
        let v = match view(net, n.near_rpc, h, n.pool, method, &no_args) {
            Ok(v) => v,
            Err(e) => {
                let r = e.reason(n.pool, method);
                inp.errors.push(r.clone());
                pool_error.get_or_insert(r);
                Value::Null
            }
        };
        match slot {
            "pool" => inp.near.pool = v,
            "params" => inp.near.params = v,
            _ => inp.near.coin_statuses = v,
        }
    }
    // On testnet the drill stands in for nBTC's π: this account's own ratio, or the shared one (INTERFACES.md 21).
    // Without it, π is 0.80 and nBTC is reduce-only (3.3).
    match drill_ratio(net, n.near_rpc, h, n.drill, &account) {
        Ok(v) => inp.near.drill = v,
        Err(reason) => inp.errors.push(reason),
    }
    inp.near.state = view(net, n.near_rpc, h, &account, "get_state", &no_args)
        .map_err(|e| e.reason(&account, "get_state"))?;
    inp.near.config = view(net, n.near_rpc, h, &account, "get_config", &no_args)
        .map_err(|e| e.reason(&account, "get_config"))?;
    if let Some(r) = pool_error {
        return Err(format!("cannot read the pool: {r}"));
    }
    let conf = match near::config(&inp.near.config) {
        Ok(c) => c,
        Err(_) => return Ok(()), // the verdict refuses the config itself
    };
    let who = json!({"account_id": account});
    for t in &conf.tokens {
        let v = view(net, n.near_rpc, h, &t.id, "ft_balance_of", &who).map_err(|e| {
            format!(
                "cannot read the {} balance: {}",
                t.name,
                e.reason(&t.id, "ft_balance_of")
            )
        })?;
        inp.near.balances.insert(t.id.clone(), v);
    }
    inp.near.borrower = view(net, n.near_rpc, h, n.pool, "get_borrower", &who).map_err(|e| {
        format!(
            "cannot read the pool's record of the account: {}",
            e.reason(n.pool, "get_borrower")
        )
    })?;
    Ok(())
}

// ------------------------------------------------------------------------------------------- Hyperliquid

/// One Hyperliquid info request.
pub fn hl_info(net: &mut impl Net, url: &str, body: Value) -> Result<Value, String> {
    let r = net.post(url, &body.to_string())?;
    if r.status != 200 {
        return Err(format!("HTTP {}", r.status));
    }
    serde_json::from_slice(&r.body).map_err(|_| "not JSON".to_string())
}

fn read_hl_account(net: &mut impl Net, inp: &mut Inputs, sends: bool) -> Result<(), String> {
    let Some(address) = near::state(&inp.near.state).ok().and_then(|s| s.hl_address) else {
        return Ok(());
    };
    let url = inp.request.net().hl_info;
    inp.hl.address = Some(address.clone());
    // INTERFACES.md 50.2: transfers out that the account signed and no verdict has named as sent. Their ledger is
    // read first, before any balance: every transfer it shows is then already out of the balances this run counts,
    // so a verdict never names a transfer as sent while still counting its money on Hyperliquid. If the read
    // fails, nothing is named and the run goes on. With no open send there is no request.
    let open = near::state(&inp.near.state)
        .map(|s| s.open_sends)
        .unwrap_or_default();
    if let Some(oldest) = open.iter().min().filter(|_| sends) {
        let from = oldest.saturating_sub(SENT_LOOKBACK_MS);
        let body =
            json!({"type": "userNonFundingLedgerUpdates", "user": address, "startTime": from});
        match hl_info(net, url, body) {
            Ok(v) => {
                inp.hl.sent_ledger = v;
                inp.hl.sent_from_ms = from;
            }
            Err(e) => inp
                .errors
                .push(format!("Hyperliquid ledger for sent transfers: {e}")),
        }
    }
    inp.hl.state = hl_info(
        net,
        url,
        json!({"type": "clearinghouseState", "user": address}),
    )
    .map_err(|e| format!("cannot read the Hyperliquid account {address}: {e}"))?;
    match hl_info(
        net,
        url,
        json!({"type": "frontendOpenOrders", "user": address}),
    ) {
        Ok(v) => inp.hl.orders = v,
        Err(e) => inp.errors.push(format!("Hyperliquid open orders: {e}")),
    }
    // Where the account's USDC sits depends on its mode (research/hyperliquid.md, "Account modes"): a unified account
    // keeps it in spot, and clearinghouseState then shows only the margin in use. Both reads are needed to value it.
    inp.hl.abstraction = hl_info(
        net,
        url,
        json!({"type": "userAbstraction", "user": address}),
    )
    .map_err(|e| format!("cannot read the Hyperliquid account mode of {address}: {e}"))?;
    inp.hl.spot = hl_info(
        net,
        url,
        json!({"type": "spotClearinghouseState", "user": address}),
    )
    .map_err(|e| format!("cannot read the Hyperliquid spot balances of {address}: {e}"))?;
    // A pending move to Hyperliquid: its ledger shows whether the USDC arrived (INTERFACES.md 14, `arrived`).
    // Without the read, the move counts as in transit.
    let pending = near::state(&inp.near.state)
        .map(|s| s.transfers)
        .unwrap_or_default();
    if let Some(from) = crate::book::ledger_start_ms(&pending) {
        let body =
            json!({"type": "userNonFundingLedgerUpdates", "user": address, "startTime": from});
        match hl_info(net, url, body) {
            Ok(v) => {
                inp.hl.ledger = v;
                inp.hl.ledger_from_ms = from;
            }
            Err(e) => inp.errors.push(format!("Hyperliquid ledger: {e}")),
        }
    }
    Ok(())
}

// --------------------------------------------------------------------------------------------- markets

/// The exchanges' ticker for a Hyperliquid coin: `kPEPE` trades as `PEPE`.
pub fn base(coin: &str) -> &str {
    match coin.strip_prefix('k') {
        Some(rest) if rest.starts_with(|c: char| c.is_ascii_uppercase()) => rest,
        _ => coin,
    }
}

pub fn ticker_url(src: &str, b: &str) -> String {
    match src {
        "binance" => format!("https://api.binance.com/api/v3/ticker/bookTicker?symbol={b}USDT"),
        "okx" => format!("https://www.okx.com/api/v5/market/ticker?instId={b}-USDT"),
        "bybit" => format!("https://api.bybit.com/v5/market/tickers?category=spot&symbol={b}USDT"),
        _ => format!("https://api.exchange.coinbase.com/products/{b}-USD/ticker"),
    }
}

/// Candle requests: one-minute (`hour = false`, the last 62) or one-hour (the last 722; OKX pages from `after`).
pub fn candle_url(src: &str, b: &str, hour: bool, after: Option<u64>) -> String {
    match (src, hour) {
        ("binance", false) => format!("https://api.binance.com/api/v3/klines?symbol={b}USDT&interval=1m&limit=62"),
        ("binance", true) => format!("https://api.binance.com/api/v3/klines?symbol={b}USDT&interval=1h&limit=722"),
        ("okx", false) => format!("https://www.okx.com/api/v5/market/candles?instId={b}-USDT&bar=1m&limit=62"),
        ("okx", true) => {
            let page = after.map_or(String::new(), |a| format!("&after={a}"));
            format!("https://www.okx.com/api/v5/market/candles?instId={b}-USDT&bar=1H&limit=300{page}")
        }
        (_, false) => format!("https://api.bybit.com/v5/market/kline?category=spot&symbol={b}USDT&interval=1&limit=62"),
        (_, true) => format!("https://api.bybit.com/v5/market/kline?category=spot&symbol={b}USDT&interval=60&limit=722"),
    }
}

pub fn get_json(net: &mut impl Net, url: &str) -> Result<Value, String> {
    let r = net.get(url)?;
    if r.status != 200 {
        return Err(format!("HTTP {}", r.status));
    }
    serde_json::from_slice(&r.body).map_err(|_| "not JSON".to_string())
}

/// Best bid and ask from one exchange's ticker answer.
pub fn parse_ticker(src: &str, v: &Value) -> Result<(f64, f64), String> {
    let (bid, ask) = match src {
        "binance" => (v.get("bidPrice"), v.get("askPrice")),
        "okx" => (v.pointer("/data/0/bidPx"), v.pointer("/data/0/askPx")),
        "bybit" => (
            v.pointer("/result/list/0/bid1Price"),
            v.pointer("/result/list/0/ask1Price"),
        ),
        _ => (v.get("bid"), v.get("ask")),
    };
    match (bid.and_then(f64_of), ask.and_then(f64_of)) {
        (Some(b), Some(a)) if b > 0.0 && a >= b => Ok((b, a)),
        _ => Err("no usable bid and ask".into()),
    }
}

/// `[open ms, close]` pairs from one exchange's candle answer, oldest first.
pub fn parse_candles(src: &str, v: &Value) -> Result<Vec<(u64, f64)>, String> {
    let rows = match src {
        "binance" => v.as_array(),
        "okx" => v.get("data").and_then(Value::as_array),
        _ => v.pointer("/result/list").and_then(Value::as_array),
    }
    .ok_or("no candles")?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let open = row.get(0).and_then(u64_of);
        let close = row.get(4).and_then(f64_of);
        match (open, close) {
            (Some(o), Some(c)) if c > 0.0 => out.push((o, c)),
            _ => return Err("a candle lacks its open time or close".into()),
        }
    }
    out.sort_by_key(|c| c.0);
    out.dedup_by_key(|c| c.0);
    Ok(out)
}

/// Whether the run has used its time for reads; if so, `what` is skipped and listed.
fn out_of_time(net: &mut impl Net, inp: &mut Inputs, start: u64, what: &str) -> bool {
    let late = net.now_ms() > start + READ_BUDGET_MS;
    if late {
        inp.errors
            .push(format!("skipped {what}: the run is out of time"));
    }
    late
}

/// The prices of `coins`, freshest last: hourly candles, then minute candles, then Hyperliquid's market, then the
/// tickers, whose ages count.
fn read_markets(net: &mut impl Net, inp: &mut Inputs, coins: &BTreeSet<String>, start: u64) {
    for hour in [true, false] {
        for c in coins {
            for src in crate::market::CANDLE_SOURCES {
                let what = format!(
                    "{src} {} candles for {c}",
                    if hour { "hourly" } else { "minute" }
                );
                if out_of_time(net, inp, start, &what) {
                    continue;
                }
                let pages = if hour && src == "okx" { 3 } else { 1 };
                let mut rows: Vec<(u64, f64)> = Vec::new();
                let mut after = None;
                for _ in 0..pages {
                    match get_json(net, &candle_url(src, base(c), hour, after))
                        .and_then(|v| parse_candles(src, &v))
                    {
                        Ok(page) if !page.is_empty() => {
                            after = page.first().map(|p| p.0);
                            rows.extend(page);
                        }
                        Ok(_) => break,
                        Err(e) => {
                            inp.errors.push(format!("{what}: {e}"));
                            break;
                        }
                    }
                }
                rows.sort_by_key(|r| r.0);
                rows.dedup_by_key(|r| r.0);
                if !rows.is_empty() {
                    let reads = inp.coins.entry(c.clone()).or_default();
                    let slot = if hour {
                        &mut reads.hours
                    } else {
                        &mut reads.minutes
                    };
                    slot.insert(src.to_string(), rows);
                }
            }
        }
    }
    let url = inp.request.net().hl_info;
    if !out_of_time(net, inp, start, "Hyperliquid's market") {
        match hl_info(net, url, json!({"type": "metaAndAssetCtxs"})) {
            Ok(v) => {
                inp.hl.at_ms = net.now_ms();
                inp.hl.meta_read = true;
                for c in coins {
                    if let Some(entry) = hl::asset_entry(&v, c) {
                        inp.hl.assets.insert(c.clone(), entry);
                    }
                }
            }
            Err(e) => inp.errors.push(format!("Hyperliquid's market: {e}")),
        }
    }
    for c in coins {
        for src in ["binance", "okx", "bybit", "coinbase"] {
            let what = format!("{src} ticker for {c}");
            if out_of_time(net, inp, start, &what) {
                continue;
            }
            match get_json(net, &ticker_url(src, base(c))).and_then(|v| parse_ticker(src, &v)) {
                Ok((bid, ask)) => {
                    let at_ms = net.now_ms();
                    let reads: &mut CoinReads = inp.coins.entry(c.clone()).or_default();
                    reads
                        .tickers
                        .insert(src.to_string(), Ticker { bid, ask, at_ms });
                }
                Err(e) => inp.errors.push(format!("{what}: {e}")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exchange_answers_parse() {
        let b: Value = serde_json::from_str(
            r#"{"symbol":"BTCUSDT","bidPrice":"75988.93000000","bidQty":"1.8","askPrice":"75988.94000000","askQty":"6"}"#,
        )
        .unwrap();
        assert_eq!(parse_ticker("binance", &b), Ok((75988.93, 75988.94)));
        let o: Value = serde_json::from_str(r#"{"code":"0","data":[{"instType":"SPOT","instId":"BTC-USDT","last":"75982.8","askPx":"75982.8","bidPx":"75982.7","ts":"1794049225164"}],"msg":""}"#).unwrap();
        assert_eq!(parse_ticker("okx", &o), Ok((75982.7, 75982.8)));
        let y: Value = serde_json::from_str(r#"{"retCode":0,"retMsg":"OK","result":{"category":"spot","list":[{"symbol":"BTCUSDT","bid1Price":"75982.8","ask1Price":"75982.9"}]},"time":1794049226214}"#).unwrap();
        assert_eq!(parse_ticker("bybit", &y), Ok((75982.8, 75982.9)));
        let c: Value = serde_json::from_str(r#"{"ask":"75886.15","bid":"75886.14","volume":"6787.0","price":"75886.15","time":"2026-11-07T11:00:24.088481008Z"}"#).unwrap();
        assert_eq!(parse_ticker("coinbase", &c), Ok((75886.14, 75886.15)));
        let missing: Value = serde_json::from_str(
            r#"{"code":"51001","data":[],"msg":"Instrument ID doesn't exist."}"#,
        )
        .unwrap();
        assert!(parse_ticker("okx", &missing).is_err());

        let bk: Value = serde_json::from_str(r#"[[1794049140000,"75984.85","75996.0","75984.84","75996.00000000","2.05",1794049199999,"156225.5",569,"1.97","150197.7","0"],
            [1794049080000,"75963.57","75984.85","75963.56","75984.84000000","2.17",1794049139999,"165586.6",592,"2.04","155614.8","0"]]"#).unwrap();
        assert_eq!(
            parse_candles("binance", &bk),
            Ok(vec![(1794049080000, 75984.84), (1794049140000, 75996.0)])
        );
        let ok: Value = serde_json::from_str(r#"{"code":"0","data":[["1794049200000","76000.5","76001.7","75982.8","75982.8","0.37","28120.8","28120.8","0"],["1794049140000","75987.5","76003.8","75987.4","76000.4","1.56","118959.0","118959.0","1"]],"msg":""}"#).unwrap();
        assert_eq!(
            parse_candles("okx", &ok),
            Ok(vec![(1794049140000, 76000.4), (1794049200000, 75982.8)])
        );
        let by: Value = serde_json::from_str(r#"{"retCode":0,"retMsg":"OK","result":{"category":"spot","symbol":"BTCUSDT","list":[["1794049200000","75993","75993","75982.9","75982.9","2.4","184109.2"],["1794049140000","75981.7","75993","75981.6","75993","2.0","157510.0"]]},"time":1794049227305}"#).unwrap();
        assert_eq!(
            parse_candles("bybit", &by),
            Ok(vec![(1794049140000, 75993.0), (1794049200000, 75982.9)])
        );
    }

    #[test]
    fn every_coin_maps_to_its_exchange_symbol() {
        let u: Value = serde_json::from_str(risk_core::universe::UNIVERSE_V0).unwrap();
        for (name, c) in u["coins"].as_object().unwrap() {
            let sym = c["binance_symbol"].as_str().unwrap();
            assert_eq!(format!("{}USDT", base(name)), sym, "{name}");
        }
    }

    /// Answers a rate limit first, then the real answer.
    struct Limited(u32);

    impl Net for Limited {
        fn get(&mut self, _: &str) -> Result<Reply, String> {
            Err("no GETs".into())
        }
        fn post(&mut self, _: &str, _: &str) -> Result<Reply, String> {
            self.0 += 1;
            let (status, body) = if self.0 == 1 {
                (429, "Too Many Requests")
            } else {
                (200, r#"{"result":{"ok":1}}"#)
            };
            Ok(Reply {
                status,
                body: body.as_bytes().to_vec(),
            })
        }
        fn now_ms(&mut self) -> u64 {
            0
        }
    }

    #[test]
    fn a_rate_limited_call_is_tried_again() {
        let mut net = Limited(0);
        assert_eq!(
            rpc(&mut net, "https://x", "block", json!({})),
            Ok(json!({"ok": 1}))
        );
        assert_eq!(net.0, 2);
    }

    #[test]
    fn rpc_errors_name_the_problem() {
        let unknown = json!({"jsonrpc": "2.0", "error": {"name": "HANDLER_ERROR", "cause": {"name": "UNKNOWN_ACCOUNT"},
            "data": "account nobody.pbf.testnet does not exist while viewing"}, "id": "pb"});
        assert_eq!(rpc_result(unknown), Err(ViewError::UnknownAccount));
        let no_code = json!({"result": {"error": "wasm execution failed with error: CompilationError(CodeDoesNotExist { account_id: \"pool.pbf.testnet\" })", "logs": []}});
        assert_eq!(rpc_result(no_code), Err(ViewError::NoContract));
        let no_method = json!({"error": {"name": "HANDLER_ERROR", "cause": {"name": "CONTRACT_EXECUTION_ERROR"},
            "data": "wasm execution failed with error: MethodResolveError(MethodNotFound)"}});
        assert_eq!(rpc_result(no_method), Err(ViewError::NoMethod));
        assert_eq!(
            ViewError::UnknownAccount.reason("nobody.pbf.testnet", "get_state"),
            "account nobody.pbf.testnet does not exist on testnet"
        );
    }
}
