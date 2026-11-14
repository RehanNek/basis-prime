//! The book stress test's reads (INTERFACES.md 19): the factory's accounts, the pool's record of each, then every
//! account with a loan read as `check` reads it (its state, config, balances, the pool's record, its drill ratio and
//! its Hyperliquid account), all at one final block, with the prices read once for all of them.
//!
//! Requests that don't depend on each other go out together ([`Net::get_all`], [`Net::post_all`]): the NEAR views
//! of a step, the Hyperliquid accounts, and the price reads (`credit::read_prices`).
use crate::credit::{read_prices, reply_json};
use crate::inputs::{Block, CoinReads, HlReads, Inputs, NearReads};
use crate::near;
use crate::read::{self, Net, ViewError};
use crate::request::{Intent, Mode, Request, TESTNET};
use crate::util::{base64, sha256_hex, u128_of, u64_of};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// The format of [`BookInputs`].
pub const BOOK_INPUTS_V: u32 = 1;
/// Version 0 reads at most this many accounts with loans (INTERFACES.md 19).
pub const MAX_LOANS: usize = 10;
/// And at most this many accounts of the factory, one page of `list_accounts`: each costs one view to filter.
pub const MAX_LISTED: u64 = 100;
/// The reads give up past this much of the run: a stress test that left an account out would say too little.
pub const READ_BUDGET_MS: u64 = 14_000;

/// The request: `{"mode": "book", "network": "testnet"}`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BookRequest {
    pub mode: String,
    pub network: String,
}

/// Checks the request; returns it and whether a snapshot is wanted.
pub fn parse(raw: &str) -> Result<(BookRequest, bool), String> {
    let v: Value = serde_json::from_str(raw).map_err(|e| format!("the input is not JSON: {e}"))?;
    let obj = v.as_object().ok_or("the input must be a JSON object")?;
    if obj.get("mode").and_then(Value::as_str) != Some("book") {
        return Err("mode must be book".into());
    }
    let network = obj.get("network").and_then(Value::as_str).unwrap_or("");
    if network != TESTNET.name {
        return Err(format!(
            "network {network:?} is not served: our pool is on testnet only"
        ));
    }
    let snapshot = match obj.get("snapshot") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("snapshot must be true or false".into()),
    };
    Ok((
        BookRequest {
            mode: "book".into(),
            network: network.into(),
        },
        snapshot,
    ))
}

/// One account with a loan, as `check` reads it, less what all accounts share.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AccountReads {
    pub account: String,
    pub state: Value,
    pub config: Value,
    pub balances: BTreeMap<String, Value>,
    pub borrower: Value,
    pub drill: Value,
    /// Its Hyperliquid account; the market is in [`BookInputs`].
    pub hl: HlReads,
    /// Its lender positions (FUNDING.md 6.1), as `check` reads them. Empty and left out for an account whose
    /// config names no lender, so inputs read before Phase 6 replay unchanged.
    #[serde(default, skip_serializing_if = "crate::inputs::LenderReads::is_empty")]
    pub lenders: crate::inputs::LenderReads,
    pub errors: Vec<String>,
}

/// Everything one book stress test read. Its canonical JSON is hashed into the result's `in`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BookInputs {
    pub v: u32,
    pub request: BookRequest,
    /// The final testnet block every view read at.
    pub block: Block,
    /// The factory's `list_accounts` and `accounts_count`.
    pub listed: Value,
    pub count: Value,
    /// The pool's `get_borrower` for each listed account.
    pub borrowers: BTreeMap<String, Value>,
    /// The pool's `get_pool`, `get_params` and `coin_statuses`.
    pub pool: Value,
    pub params: Value,
    pub coin_statuses: Value,
    /// The accounts with a loan, in the factory's order.
    pub accounts: Vec<AccountReads>,
    /// The prices, read once: exchange readings per coin, and Hyperliquid testnet's market.
    pub coins: BTreeMap<String, CoinReads>,
    pub hl_assets: BTreeMap<String, Value>,
    pub hl_meta_read: bool,
    pub hl_at_ms: u64,
    pub now_ms: u64,
    pub errors: Vec<String>,
    pub fatal: Option<String>,
}

impl BookInputs {
    pub fn canonical(&self) -> String {
        serde_json::to_string(self).expect("inputs serialise")
    }

    pub fn hash(&self) -> String {
        sha256_hex(self.canonical().as_bytes())
    }

    /// Account `i` as `check` would have read it: what `book::build` takes.
    pub fn inputs_for(&self, i: usize) -> Inputs {
        let a = &self.accounts[i];
        let mut hl = a.hl.clone();
        hl.meta_read = self.hl_meta_read;
        hl.at_ms = self.hl_at_ms;
        hl.assets = self.hl_assets.clone();
        Inputs {
            request: Request {
                mode: Mode::Check,
                account: a.account.clone(),
                intent: Intent::Check {},
                network: TESTNET.name.to_string(),
            },
            block: self.block.clone(),
            near: NearReads {
                state: a.state.clone(),
                config: a.config.clone(),
                balances: a.balances.clone(),
                pool: self.pool.clone(),
                params: self.params.clone(),
                borrower: a.borrower.clone(),
                coin_statuses: self.coin_statuses.clone(),
                drill: a.drill.clone(),
            },
            hl,
            lenders: a.lenders.clone(),
            coins: self.coins.clone(),
            now_ms: self.now_ms,
            ..Inputs::new(Request::default())
        }
    }
}

/// One view of a batch: account, method, args.
pub type ViewCall = (String, String, Value);

/// Several views at `height`, sent together. A call the RPC didn't answer (rate-limited, a server error, no
/// answer) is made again on its own with [`read::view`], which tries once more after a pause.
pub fn views_all(
    net: &mut impl Net,
    rpc_url: &str,
    height: u64,
    calls: &[ViewCall],
) -> Vec<Result<Value, ViewError>> {
    let reqs: Vec<(String, String)> = calls
        .iter()
        .map(|(account, method, args)| {
            let params = json!({"request_type": "call_function", "block_id": height, "account_id": account,
                                "method_name": method, "args_base64": base64(args.to_string().as_bytes())});
            let body = json!({"jsonrpc": "2.0", "id": "pb", "method": "query", "params": params});
            (rpc_url.to_string(), body.to_string())
        })
        .collect();
    let replies = net.post_all(&reqs);
    calls
        .iter()
        .zip(replies)
        .map(|((account, method, args), reply)| {
            let answered = reply.ok().filter(|r| r.status < 500 && r.status != 429);
            match answered.and_then(|r| serde_json::from_slice::<Value>(&r.body).ok()) {
                Some(v) => read::rpc_result(v).and_then(|res| view_value(&res, method)),
                None => read::view(net, rpc_url, height, account, method, args),
            }
        })
        .collect()
}

/// A view's JSON from its `result` bytes, as `read::view` reads it.
fn view_value(result: &Value, method: &str) -> Result<Value, ViewError> {
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

fn call(account: &str, method: &str, args: Value) -> ViewCall {
    (account.to_string(), method.to_string(), args)
}

/// Reads the book. Any account it can't read in full ends the run with `fatal`: a stress test that left one out
/// would understate the pool's loss.
pub fn read(net: &mut impl Net, req: &BookRequest) -> BookInputs {
    let mut bi = BookInputs {
        v: BOOK_INPUTS_V,
        request: req.clone(),
        ..BookInputs::default()
    };
    if let Err(reason) = read_all(net, &mut bi) {
        bi.fatal = Some(reason);
    }
    bi
}

fn read_all(net: &mut impl Net, bi: &mut BookInputs) -> Result<(), String> {
    let n = TESTNET;
    let start = net.now_ms();
    let block = read::rpc(net, n.near_rpc, "block", json!({"finality": "final"}))
        .map_err(|e| format!("cannot read the latest final NEAR block: {e:?}"))?;
    let header = block.get("header").unwrap_or(&Value::Null);
    bi.block = Block {
        height: header
            .get("height")
            .and_then(u64_of)
            .ok_or("the NEAR block has no height")?,
        timestamp_ns: header
            .get("timestamp_nanosec")
            .or_else(|| header.get("timestamp"))
            .and_then(u64_of)
            .ok_or("the NEAR block has no timestamp")?
            .to_string(),
        hash: header
            .get("hash")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    };
    let h = bi.block.height;
    let none = json!({});
    let first = views_all(
        net,
        n.near_rpc,
        h,
        &[
            call(
                n.factory,
                "list_accounts",
                json!({"from_index": 0, "limit": MAX_LISTED}),
            ),
            call(n.factory, "accounts_count", none.clone()),
            call(n.pool, "get_pool", none.clone()),
            call(n.pool, "get_params", none.clone()),
            call(n.pool, "coin_statuses", none.clone()),
        ],
    );
    let names = [
        "list_accounts",
        "accounts_count",
        "get_pool",
        "get_params",
        "coin_statuses",
    ];
    let mut got = Vec::new();
    for (r, name) in first.into_iter().zip(names) {
        let account = if name.starts_with("get_") || name == "coin_statuses" {
            n.pool
        } else {
            n.factory
        };
        got.push(r.map_err(|e| format!("cannot read the book: {}", e.reason(account, name)))?);
    }
    let [listed, count, pool, params, statuses]: [Value; 5] = got.try_into().expect("five views");
    let total = u64_of(&count).ok_or("the factory's accounts_count is not a number")?;
    if total > MAX_LISTED {
        return Err(format!(
            "the factory lists {total} accounts; version 0 reads at most {MAX_LISTED}"
        ));
    }
    let ids: Vec<String> = listed
        .as_array()
        .ok_or("the factory's list_accounts is not a list")?
        .iter()
        .filter_map(|r| {
            r.get("account_id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    (bi.listed, bi.count, bi.pool, bi.params, bi.coin_statuses) =
        (listed, count, pool, params, statuses);

    // Which accounts have a loan: the pool's record of each.
    let calls: Vec<ViewCall> = ids
        .iter()
        .map(|a| call(n.pool, "get_borrower", json!({"account_id": a})))
        .collect();
    let mut loans = Vec::new();
    for (a, r) in ids.iter().zip(views_all(net, n.near_rpc, h, &calls)) {
        let v = r.map_err(|e| {
            format!(
                "cannot read the pool's record of {a}: {}",
                e.reason(n.pool, "get_borrower")
            )
        })?;
        let debt = v.get("debt").and_then(u128_of).unwrap_or(0);
        bi.borrowers.insert(a.clone(), v.clone());
        if debt > 0 {
            loans.push((a.clone(), v));
        }
    }
    if loans.len() > MAX_LOANS {
        return Err(format!(
            "{} accounts have a loan; version 0's book stress test reads at most {MAX_LOANS}",
            loans.len()
        ));
    }
    if loans.is_empty() {
        return Ok(());
    }

    // Each account's state, config and drill ratio (INTERFACES.md 21: its own, or the shared one).
    let mut calls = Vec::new();
    for (a, _) in &loans {
        calls.push(call(a, "get_state", none.clone()));
        calls.push(call(a, "get_config", none.clone()));
        calls.push(call(n.drill, "get_ratio_for", json!({"account_id": a})));
    }
    let mut answers = views_all(net, n.near_rpc, h, &calls).into_iter();
    let mut shared_ratio: Option<Result<Value, String>> = None;
    for (a, borrower) in &loans {
        let mut ar = AccountReads {
            account: a.clone(),
            borrower: borrower.clone(),
            ..AccountReads::default()
        };
        let (st, conf, drill) = (answers.next(), answers.next(), answers.next());
        ar.state = st
            .expect("answered")
            .map_err(|e| e.reason(a, "get_state"))?;
        ar.config = conf
            .expect("answered")
            .map_err(|e| e.reason(a, "get_config"))?;
        match drill.expect("answered") {
            Ok(v) => ar.drill = v,
            Err(ViewError::NoMethod) => {
                // The drill deployed before Phase 5: the shared ratio, read once for all.
                let r = shared_ratio.get_or_insert_with(|| {
                    read::view(net, n.near_rpc, h, n.drill, "get_ratio", &json!({}))
                        .map_err(|e| e.reason(n.drill, "get_ratio"))
                });
                match r {
                    Ok(v) => ar.drill = v.clone(),
                    Err(e) => ar.errors.push(e.clone()),
                }
            }
            Err(e) => ar.errors.push(e.reason(n.drill, "get_ratio_for")),
        }
        bi.accounts.push(ar);
    }
    if net.now_ms() > start + READ_BUDGET_MS {
        return Err(out_of_time(bi));
    }

    // Balances: each configured token of each account.
    let mut calls = Vec::new();
    let mut slots = Vec::new();
    for (i, ar) in bi.accounts.iter().enumerate() {
        let conf = near::config(&ar.config).map_err(|e| format!("{}: {e}", ar.account))?;
        for t in conf.tokens {
            calls.push(call(
                &t.id,
                "ft_balance_of",
                json!({"account_id": ar.account}),
            ));
            slots.push((i, t.id));
        }
    }
    for ((i, id), r) in slots.into_iter().zip(views_all(net, n.near_rpc, h, &calls)) {
        let account = bi.accounts[i].account.clone();
        let v = r.map_err(|e| {
            format!(
                "cannot read {account}'s balance of {id}: {}",
                e.reason(&id, "ft_balance_of")
            )
        })?;
        bi.accounts[i].balances.insert(id, v);
    }

    // Each Hyperliquid account, as `check` reads it (read.rs), sent together.
    let mut reqs = Vec::new();
    let mut slots = Vec::new();
    for (i, ar) in bi.accounts.iter_mut().enumerate() {
        let client = near::state(&ar.state).map_err(|e| format!("{}: {e}", ar.account))?;
        let Some(address) = client.hl_address else {
            continue;
        };
        ar.hl.address = Some(address.clone());
        let mut kinds = vec![
            json!({"type": "clearinghouseState", "user": address}),
            json!({"type": "frontendOpenOrders", "user": address}),
            json!({"type": "userAbstraction", "user": address}),
            json!({"type": "spotClearinghouseState", "user": address}),
        ];
        if let Some(from) = crate::book::ledger_start_ms(&client.transfers) {
            kinds.push(
                json!({"type": "userNonFundingLedgerUpdates", "user": address, "startTime": from}),
            );
            ar.hl.ledger_from_ms = from;
        }
        for k in kinds {
            slots.push((i, k["type"].as_str().unwrap_or("").to_string()));
            reqs.push((n.hl_info.to_string(), k.to_string()));
        }
    }
    for ((i, kind), reply) in slots.into_iter().zip(net.post_all(&reqs)) {
        let ar = &mut bi.accounts[i];
        let address = ar.hl.address.clone().unwrap_or_default();
        let v = reply_json(reply, &[200]);
        match kind.as_str() {
            "clearinghouseState" => {
                ar.hl.state =
                    v.map_err(|e| format!("cannot read the Hyperliquid account {address}: {e}"))?
            }
            "userAbstraction" => {
                ar.hl.abstraction = v.map_err(|e| {
                    format!("cannot read the Hyperliquid account mode of {address}: {e}")
                })?
            }
            "spotClearinghouseState" => {
                ar.hl.spot = v.map_err(|e| {
                    format!("cannot read the Hyperliquid spot balances of {address}: {e}")
                })?
            }
            "frontendOpenOrders" => match v {
                Ok(v) => ar.hl.orders = v,
                Err(e) => ar.errors.push(format!("Hyperliquid open orders: {e}")),
            },
            _ => match v {
                Ok(v) => ar.hl.ledger = v,
                Err(e) => {
                    ar.hl.ledger_from_ms = 0;
                    ar.errors.push(format!("Hyperliquid ledger: {e}"))
                }
            },
        }
    }
    if net.now_ms() > start + READ_BUDGET_MS {
        return Err(out_of_time(bi));
    }

    // Phase 6: each account's lender positions, as `check` reads them (read.rs). Nothing is asked for an account
    // whose config names no lender; a lender that can't be read stops the test, as it stops a check.
    for i in 0..bi.accounts.len() {
        let mut inp = bi.inputs_for(i);
        read::read_lenders(net, &mut inp).map_err(|e| format!("{}: {e}", bi.accounts[i].account))?;
        bi.accounts[i].lenders = inp.lenders;
    }

    // The prices, once, for every coin any account holds.
    let mut coins = BTreeSet::new();
    for i in 0..bi.accounts.len() {
        let held = crate::book::held_coins(&bi.inputs_for(i))
            .map_err(|e| format!("{}: {e}", bi.accounts[i].account))?;
        coins.extend(held);
    }
    let coins = crate::book::coins_to_read(&coins);
    if !coins.is_empty() {
        let p = read_prices(net, &coins, start, READ_BUDGET_MS, n.hl_info);
        bi.coins = p.coins;
        bi.hl_assets = p.assets;
        bi.hl_meta_read = p.meta_read;
        bi.hl_at_ms = p.at_ms;
        bi.errors.extend(p.errors);
    }
    bi.now_ms = net.now_ms();
    Ok(())
}

fn out_of_time(bi: &BookInputs) -> String {
    format!(
        "out of time after reading {} accounts with loans; the run has 20 seconds",
        bi.accounts.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_parse() {
        let (r, snap) = parse(r#"{"mode":"book","network":"testnet"}"#).unwrap();
        assert_eq!(
            (r.mode.as_str(), r.network.as_str(), snap),
            ("book", "testnet", false)
        );
        assert!(parse(r#"{"mode":"book","network":"mainnet"}"#)
            .unwrap_err()
            .contains("testnet only"));
        assert!(parse(r#"{"mode":"book","network":"testnet","snapshot":1}"#).is_err());
    }
}
