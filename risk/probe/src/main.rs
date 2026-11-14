//! pb-ol-probe: the Phase 0 OutLayer probe (PLAN.md 13). Testnet only; it holds no secrets.
//!
//! Reads one JSON object from stdin and writes one JSON object to stdout, and always exits 0:
//! OutLayer counts a non-zero exit as a failed run, so errors come back as {"ok":false,"reason":...}.
//! `input.mode` picks what it does:
//!
//! - `hello`: the run's context from the environment (execution type, sender, block, limits).
//!   `env_names: true` adds the names (never the values) of every environment variable.
//! - `prices`: fetches BTC tickers from Binance, OKX, Bybit, Coinbase, Pyth Hermes (no key, so 401 is
//!   expected), 1Click's token list and Hyperliquid (mainnet and testnet). Per source: HTTP status, ms,
//!   body size and the BTC price where the body has one. `sources: [...]` picks a subset.
//! - `calls`: `n` GET requests in a row to `url` (default Cloudflare's tiny trace page). Counts what
//!   succeeded and keeps the first error, to find the per-run limit on calls out.
//! - `lock`: one storage operation on `key`, which must start with `pbtest:`. `op` is `take` (default,
//!   set_if_absent), `take_eq` (set_if_equals from `expected`, default "free"), `release` (set_if_equals
//!   from `holder` back to "free"), `reset` (set to "free"), `peek`, `delete` or `cleanup` (deletes every
//!   key under `prefix`, which must start with `pbtest:`). `holder` defaults to the call or request id.
//!   `start_at_ms` (unix ms) makes the run wait, up to 10 s, before the operation, so that runs sent
//!   together line up.
//! - `big`: a fake verdict padded so the output is exactly `bytes` long (default 2048, from about 45
//!   bytes up; small sizes get a shorter verdict or none), for testing how big an output survives each
//!   path. The padding is "0123456789abcdefghijklmnopqrstuvwxyz" repeated.
//!
//! Build (the published hash comes from exactly this, run in risk/):
//!   RUSTFLAGS="--remap-path-prefix=$HOME=~" cargo build -p pb-ol-probe --target wasm32-wasip2 --release
//! The remap keeps the builder's home directory out of the panic paths that the binary embeds.
use serde_json::{json, Map, Value};
use std::io::{Read, Write};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use wasi_http_client::{Client, Method};

const PROBE: &str = concat!("pb-ol-probe ", env!("CARGO_PKG_VERSION"));
const UA: &str = concat!("pb-ol-probe/", env!("CARGO_PKG_VERSION"));
const CALLS_URL: &str = "https://www.cloudflare.com/cdn-cgi/trace";
const PAD: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
const NBTC: &str = "nep141:nbtc.bridge.near";
const PYTH_BTC_USD: &str = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

fn main() {
    let out = match read_input() {
        Ok(input) => run(&input),
        Err(reason) => fail(reason),
    };
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(out.to_string().as_bytes());
    let _ = stdout.flush();
}

fn read_input() -> Result<Value, String> {
    let mut raw = String::new();
    std::io::stdin()
        .read_to_string(&mut raw)
        .map_err(|e| format!("cannot read stdin: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    match serde_json::from_str::<Value>(&raw) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(_) => Err("input must be a JSON object".into()),
        Err(e) => Err(format!("input is not JSON: {e}")),
    }
}

fn run(input: &Value) -> Value {
    match input.get("mode").and_then(Value::as_str).unwrap_or("hello") {
        "hello" => hello(input),
        "prices" => prices(input),
        "calls" => calls(input),
        "lock" => lock(input).unwrap_or_else(fail),
        "big" => big(input),
        other => fail(format!(
            "unknown mode {other:?}: use hello, prices, calls, lock or big"
        )),
    }
}

fn fail(reason: String) -> Value {
    json!({"ok": false, "reason": reason})
}

/// An environment variable, or None when it is missing or empty (HTTPS runs set the on-chain ones to "").
fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn ms_since(t: Instant) -> u64 {
    t.elapsed().as_millis() as u64
}

/// At most `max` characters, for error text and body snippets.
fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

// ---------------------------------------------------------------------------------------------- hello

fn hello(input: &Value) -> Value {
    let mut out = json!({
        "ok": true,
        "mode": "hello",
        "probe": PROBE,
        "exec": env("OUTLAYER_EXECUTION_TYPE"),
        "network": env("NEAR_NETWORK_ID"),
        "sender": env("NEAR_SENDER_ID"),
        "predecessor": env("NEAR_PREDECESSOR_ID"),
        "block_height": env("NEAR_BLOCK_HEIGHT"),
        "block_ts": env("NEAR_BLOCK_TIMESTAMP"),
        "request_id": env("NEAR_REQUEST_ID"),
        "call_id": env("OUTLAYER_CALL_ID"),
        "project": env("OUTLAYER_PROJECT_ID"),
        "max_instructions": env("NEAR_MAX_INSTRUCTIONS"),
        "max_memory_mb": env("NEAR_MAX_MEMORY_MB"),
        "max_seconds": env("NEAR_MAX_EXECUTION_SECONDS"),
        "rpc_proxy": env("NEAR_RPC_PROXY_AVAILABLE"),
        "now_ms": now_ms(),
    });
    if let Some(echo) = input.get("echo").and_then(Value::as_str) {
        out["echo"] = json!(clip(echo, 200));
    }
    if input.get("env_names").and_then(Value::as_bool) == Some(true) {
        let mut names: Vec<String> = std::env::vars().map(|(k, _)| k).collect();
        names.sort();
        out["env_names"] = json!(names);
    }
    out
}

// --------------------------------------------------------------------------------------------- http

struct Fetched {
    status: u16,
    body: Vec<u8>,
}

fn fetch(method: Method, url: &str, body: Option<&str>) -> Result<Fetched, String> {
    let client = Client::new();
    let mut req = client
        .request(method, url)
        .header("User-Agent", UA)
        .header("Accept", "application/json")
        .connect_timeout(Duration::from_secs(10));
    if let Some(b) = body {
        req = req
            .header("Content-Type", "application/json")
            .body(b.as_bytes());
    }
    let resp = req.send().map_err(|e| clip(&format!("{e:#}"), 200))?;
    let status = resp.status();
    let body = resp
        .body()
        .map_err(|e| clip(&format!("body: {e:#}"), 200))?;
    Ok(Fetched { status, body })
}

// ------------------------------------------------------------------------------------------- prices

struct Source {
    name: &'static str,
    method: Method,
    url: String,
    body: Option<&'static str>,
    price: fn(&Value) -> Option<String>,
}

fn sources() -> Vec<Source> {
    vec![
        Source {
            name: "binance",
            method: Method::Get,
            url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT".into(),
            body: None,
            price: |v| v.get("price").and_then(|p| p.as_str().map(String::from)),
        },
        Source {
            name: "okx",
            method: Method::Get,
            url: "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT".into(),
            body: None,
            price: |v| v.pointer("/data/0/last").and_then(|p| p.as_str().map(String::from)),
        },
        Source {
            name: "bybit",
            method: Method::Get,
            url: "https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT".into(),
            body: None,
            price: |v| v.pointer("/result/list/0/lastPrice").and_then(|p| p.as_str().map(String::from)),
        },
        Source {
            name: "coinbase",
            method: Method::Get,
            url: "https://api.exchange.coinbase.com/products/BTC-USD/ticker".into(),
            body: None,
            price: |v| v.get("price").and_then(|p| p.as_str().map(String::from)),
        },
        Source {
            name: "hermes",
            method: Method::Get,
            url: format!("https://hermes.pyth.network/v2/updates/price/latest?ids[]={PYTH_BTC_USD}&parsed=true"),
            body: None,
            price: |v| {
                let p = v.pointer("/parsed/0/price")?;
                let price = p.get("price")?.as_str()?;
                let expo = p.get("expo")?.as_i64()?;
                Some(format!("{price}e{expo}"))
            },
        },
        Source {
            name: "oneclick",
            method: Method::Get,
            url: "https://1click.chaindefuser.com/v0/tokens".into(),
            body: None,
            price: |v| {
                let t = v.as_array()?.iter().find(|t| t.get("assetId").and_then(Value::as_str) == Some(NBTC))?;
                t.get("price").map(|p| match p {
                    Value::String(x) => x.clone(),
                    other => other.to_string(),
                })
            },
        },
        Source {
            name: "hyperliquid",
            method: Method::Post,
            url: "https://api.hyperliquid.xyz/info".into(),
            body: Some(r#"{"type":"allMids"}"#),
            price: |v| v.get("BTC").and_then(|p| p.as_str().map(String::from)),
        },
        Source {
            name: "hyperliquid_testnet",
            method: Method::Post,
            url: "https://api.hyperliquid-testnet.xyz/info".into(),
            body: Some(r#"{"type":"allMids"}"#),
            price: |v| v.get("BTC").and_then(|p| p.as_str().map(String::from)),
        },
    ]
}

fn prices(input: &Value) -> Value {
    let wanted: Option<Vec<&str>> = input
        .get("sources")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect());
    let t_all = Instant::now();
    let mut results = Vec::new();
    for src in sources() {
        if let Some(w) = &wanted {
            if !w.contains(&src.name) {
                continue;
            }
        }
        let t = Instant::now();
        let r = fetch(src.method, &src.url, src.body);
        let ms = ms_since(t);
        let mut row = Map::new();
        row.insert("src".into(), json!(src.name));
        match r {
            Ok(f) => {
                row.insert("status".into(), json!(f.status));
                row.insert("ms".into(), json!(ms));
                row.insert("bytes".into(), json!(f.body.len()));
                if f.status == 200 {
                    let px = serde_json::from_slice::<Value>(&f.body)
                        .ok()
                        .and_then(|v| (src.price)(&v));
                    row.insert("px".into(), json!(px));
                } else {
                    row.insert(
                        "snip".into(),
                        json!(clip(&String::from_utf8_lossy(&f.body), 60)),
                    );
                }
            }
            Err(e) => {
                row.insert("status".into(), json!(0));
                row.insert("ms".into(), json!(ms));
                row.insert("err".into(), json!(e));
            }
        }
        results.push(Value::Object(row));
    }
    json!({"ok": true, "mode": "prices", "ms_total": ms_since(t_all), "now_ms": now_ms(), "sources": results})
}

// -------------------------------------------------------------------------------------------- calls

fn calls(input: &Value) -> Value {
    let n = input
        .get("n")
        .and_then(Value::as_u64)
        .unwrap_or(10)
        .min(1000);
    let url = input
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or(CALLS_URL)
        .to_string();
    let max_consecutive = input
        .get("max_consecutive_errors")
        .and_then(Value::as_u64)
        .unwrap_or(5)
        .max(1);
    let t_all = Instant::now();
    let (mut made, mut succeeded, mut http_errors, mut transport_errors, mut consecutive) =
        (0u64, 0u64, 0u64, 0u64, 0u64);
    let (mut ms_min, mut ms_max) = (u64::MAX, 0u64);
    let mut first_error: Option<String> = None;
    let mut first_error_at: Option<u64> = None;
    let mut statuses: Map<String, Value> = Map::new();
    let mut stopped_early = false;
    for i in 0..n {
        let t = Instant::now();
        let r = fetch(Method::Get, &url, None);
        let ms = ms_since(t);
        made += 1;
        ms_min = ms_min.min(ms);
        ms_max = ms_max.max(ms);
        let error = match r {
            Ok(f) => {
                let key = f.status.to_string();
                let count = statuses.get(&key).and_then(Value::as_u64).unwrap_or(0) + 1;
                statuses.insert(key, json!(count));
                if (200..300).contains(&f.status) {
                    succeeded += 1;
                    None
                } else {
                    http_errors += 1;
                    Some(format!(
                        "HTTP {}: {}",
                        f.status,
                        clip(&String::from_utf8_lossy(&f.body), 80)
                    ))
                }
            }
            Err(e) => {
                transport_errors += 1;
                Some(e)
            }
        };
        match error {
            None => consecutive = 0,
            Some(e) => {
                consecutive += 1;
                if first_error.is_none() {
                    first_error = Some(e);
                    first_error_at = Some(i);
                }
                if consecutive >= max_consecutive {
                    stopped_early = i + 1 < n;
                    break;
                }
            }
        }
    }
    json!({
        "ok": true,
        "mode": "calls",
        "url": url,
        "n": n,
        "made": made,
        "succeeded": succeeded,
        "http_errors": http_errors,
        "transport_errors": transport_errors,
        "statuses": statuses,
        "first_error": first_error,
        "first_error_at": first_error_at,
        "stopped_early": stopped_early,
        "ms_total": ms_since(t_all),
        "ms_min": if made > 0 { ms_min } else { 0 },
        "ms_max": ms_max,
    })
}

// --------------------------------------------------------------------------------------------- lock

fn storage_err(op: &str, e: outlayer::storage::StorageError) -> String {
    clip(&format!("storage {op}: {}", e.0), 300)
}

fn text(bytes: Option<Vec<u8>>) -> Value {
    match bytes {
        Some(b) => json!(String::from_utf8_lossy(&b)),
        None => Value::Null,
    }
}

fn lock(input: &Value) -> Result<Value, String> {
    use outlayer::storage;
    let t_start = now_ms();
    let key = input.get("key").and_then(Value::as_str).unwrap_or("");
    let op = input.get("op").and_then(Value::as_str).unwrap_or("take");
    if !key.starts_with("pbtest:") || key.len() > 128 {
        return Err(
            "lock needs a key that starts with \"pbtest:\" and is at most 128 bytes".into(),
        );
    }
    let holder = input
        .get("holder")
        .and_then(Value::as_str)
        .map(String::from)
        .or_else(|| env("OUTLAYER_CALL_ID"))
        .or_else(|| env("NEAR_REQUEST_ID").map(|r| format!("req:{r}")))
        .unwrap_or_else(|| format!("t:{t_start}"));
    if let Some(at) = input.get("start_at_ms").and_then(Value::as_u64) {
        let wait = at.saturating_sub(now_ms()).min(10_000);
        if wait > 0 {
            std::thread::sleep(Duration::from_millis(wait));
        }
    }
    let t_op = now_ms();
    let t = Instant::now();
    let mut out = json!({"ok": true, "mode": "lock", "op": op, "key": key, "holder": holder});
    match op {
        "take" => {
            let won = storage::set_if_absent(key, holder.as_bytes())
                .map_err(|e| storage_err("set_if_absent", e))?;
            out["won"] = json!(won);
        }
        "take_eq" => {
            let expected = input
                .get("expected")
                .and_then(Value::as_str)
                .unwrap_or("free");
            let (won, current) =
                storage::set_if_equals(key, expected.as_bytes(), holder.as_bytes())
                    .map_err(|e| storage_err("set_if_equals", e))?;
            out["won"] = json!(won);
            out["seen"] = text(current);
        }
        "release" => {
            let (released, current) = storage::set_if_equals(key, holder.as_bytes(), b"free")
                .map_err(|e| storage_err("set_if_equals", e))?;
            out["released"] = json!(released);
            out["seen"] = text(current);
        }
        "reset" => {
            storage::set(key, b"free").map_err(|e| storage_err("set", e))?;
        }
        "peek" => {}
        "delete" => {
            let deleted = storage::delete(key).map_err(|e| storage_err("delete", e))?;
            out["deleted"] = json!(deleted);
        }
        "cleanup" => {
            let prefix = input
                .get("prefix")
                .and_then(Value::as_str)
                .unwrap_or("pbtest:");
            if !prefix.starts_with("pbtest:") {
                return Err("cleanup needs a prefix that starts with \"pbtest:\"".into());
            }
            let keys = storage::list_keys(prefix).map_err(|e| storage_err("list_keys", e))?;
            let mut deleted = 0u64;
            for k in keys.iter().take(100) {
                if storage::delete(k).map_err(|e| storage_err("delete", e))? {
                    deleted += 1;
                }
            }
            out["listed"] = json!(keys.len());
            out["deleted"] = json!(deleted);
        }
        other => return Err(format!("unknown lock op {other:?}")),
    }
    let op_ms = ms_since(t);
    if op != "cleanup" {
        // Read the key back, so a result shows who holds it after this run's operation.
        let now = storage::get(key).map_err(|e| storage_err("get", e))?;
        out["value_after"] = text(now);
    }
    out["t_start_ms"] = json!(t_start);
    out["t_op_ms"] = json!(t_op);
    out["op_ms"] = json!(op_ms);
    out["t_end_ms"] = json!(now_ms());
    Ok(out)
}

// ---------------------------------------------------------------------------------------------- big

fn big(input: &Value) -> Value {
    let want = input
        .get("bytes")
        .and_then(Value::as_u64)
        .unwrap_or(2048)
        .min(1 << 20) as usize;
    let full = json!({
        "account": "probe-client.pbf-keeper.testnet",
        "state": "HEALTHY",
        "equity_usd": "9500.00",
        "im_usd": "3100.00",
        "mm_usd": "1550.00",
        "loan_usd": "5000.00",
        "tier_cap_usd": "6000.00",
        "extreme_day_loss_usd": "180.00",
        "hl_margin_ratio": "0.31",
        "block_height": env("NEAR_BLOCK_HEIGHT"),
        "issued_ms": now_ms(),
    });
    let short = json!({"state": "HEALTHY", "loan_usd": "5000.00"});
    let envelope = |verdict: Option<&Value>| {
        let mut out = json!({"ok": true, "mode": "big", "bytes": want, "pad": ""});
        if let Some(v) = verdict {
            out["verdict"] = v.clone();
        }
        out
    };
    // The biggest verdict that fits, so small sizes (256 B) come out exact too. Below about
    // 45 bytes even the bare envelope is longer than asked, and that is what comes back.
    let mut out = [Some(&full), Some(&short)]
        .into_iter()
        .map(envelope)
        .find(|o| o.to_string().len() <= want)
        .unwrap_or_else(|| envelope(None));
    let base = out.to_string().len();
    if want > base {
        out["pad"] = json!((0..want - base)
            .map(|i| PAD[i % PAD.len()] as char)
            .collect::<String>());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn big_is_exactly_the_size_asked_for() {
        for size in [
            46, 64, 100, 256, 329, 330, 900, 1023, 1024, 1025, 2048, 4096, 65536,
        ] {
            let out = big(&json!({"bytes": size})).to_string();
            assert_eq!(out.len(), size, "size {size}: {out}");
        }
    }

    #[test]
    fn big_keeps_the_full_verdict_when_it_fits() {
        let out = big(&json!({"bytes": 900}));
        assert_eq!(out["verdict"]["account"], "probe-client.pbf-keeper.testnet");
        assert!(big(&json!({"bytes": 256}))["verdict"]["state"] == "HEALTHY");
        assert!(big(&json!({"bytes": 50})).get("verdict").is_none());
    }

    #[test]
    fn errors_come_back_as_json() {
        assert_eq!(run(&json!({"mode": "nope"}))["ok"], false);
        assert_eq!(run(&json!({"mode": "lock", "key": "other:x"}))["ok"], false);
    }
}
