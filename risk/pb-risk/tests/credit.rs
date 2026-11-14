//! The credit check (INTERFACES.md 18) end to end, natively, against a pretend mainnet: Hyperliquid mainnet,
//! Rhea and our testnet pool answer with the responses recorded live on 9 Nov (pb-read/tests/fixtures/mainnet),
//! 1Click quotes at a chosen π, and the exchanges quote each coin at one flat price, so the worked example's
//! numbers come out exact.
//!
//! The lender reads of INTERFACES.md 27 answer only in `Mainnet::with_lenders()`: Aave's API with the answer
//! recorded on 10 Nov, and 1Click's quotes for moving bitcoin to Ethereum and back, each at a chosen cost. In
//! `Mainnet::new()` Aave can't be reached, as for a run from before those reads.
use pb_risk::credit::{self, CreditResult};
use pb_risk::read::{Net, Reply};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const T0_MS: u64 = 1_794_187_200_000; // 9 Nov 2026, 01:20 UTC
const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../pb-read/tests/fixtures/mainnet"
);

fn fixture(name: &str) -> Value {
    let text = std::fs::read_to_string(format!("{FIXTURES}/{name}.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

/// The pretend world.
struct Mainnet {
    clock_ms: u64,
    calls: Vec<String>,
    /// Coin -> the one price every source quotes (exchanges per token; Hyperliquid per its unit).
    prices: BTreeMap<String, f64>,
    /// What 1Click pays, as a share of fair value at those prices; None: "No liquidity available".
    pi: Option<f64>,
    /// The Hyperliquid account's answers, by info type.
    account: BTreeMap<&'static str, Value>,
    meta: Value,
    /// What Aave's API answers; None: it can't be reached.
    aave: Option<Value>,
    /// What a move of bitcoin to Ethereum loses on the way, in bp; None: "No liquidity available".
    move_bp: Option<u128>,
    /// The same for the way back to NEAR; None: "Quoting for this pair is not available", as 1Click answered on
    /// 11 Nov for every route that starts on Ethereum (research/aave.md).
    back_bp: Option<u128>,
    /// Rhea's USDC borrow APR, when not the recorded 16.70%.
    rhea_borrow_apr: Option<&'static str>,
}

const AAVE_API: &str = "https://api.v3.aave.com/graphql";
const WBTC_ON_ETHEREUM: &str = "nep141:eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near";

impl Mainnet {
    fn new() -> Mainnet {
        let mut prices = BTreeMap::new();
        prices.insert("BTC".to_string(), 80_000.0);
        prices.insert("ETH".to_string(), 2_000.0);
        prices.insert("NEAR".to_string(), 4.0);
        let mut account = BTreeMap::new();
        account.insert("clearinghouseState", fixture("hl_fresh_clearinghouseState"));
        account.insert("userAbstraction", fixture("hl_fresh_userAbstraction"));
        account.insert("spotClearinghouseState", json!({"balances": []}));
        account.insert("frontendOpenOrders", json!([]));
        account.insert("userVaultEquities", json!([]));
        account.insert(
            "delegatorSummary",
            json!({"delegated": "0.0", "undelegated": "0.0", "totalPendingWithdrawal": "0.0", "nPendingWithdrawals": 0}),
        );
        Mainnet {
            clock_ms: T0_MS,
            calls: Vec::new(),
            prices,
            pi: Some(1.0),
            account,
            meta: fixture("hl_metaAndAssetCtxs"),
            aave: None,
            move_bp: Some(56),
            back_bp: Some(13),
            rhea_borrow_apr: None,
        }
    }

    /// The same world with Aave answering as it did on 10 Nov: USDC at 5.08%, WBTC liquidated at 85%. A move of
    /// bitcoin to Ethereum costs 0.56% and the way back 0.13%, as research/aave.md found that day.
    fn with_lenders() -> Mainnet {
        Mainnet {
            aave: Some(fixture("aave_reserves")["response"].clone()),
            ..Mainnet::new()
        }
    }

    /// The account of HLP's strategy vault `0x0104…703a`, as read on 9 Nov.
    fn vault(mut self) -> Mainnet {
        for kind in [
            "clearinghouseState",
            "frontendOpenOrders",
            "userAbstraction",
            "spotClearinghouseState",
            "userVaultEquities",
            "delegatorSummary",
        ] {
            self.account
                .insert(kind, fixture(&format!("hl_vault_{kind}")));
        }
        self
    }

    fn tick(&mut self, what: String) {
        self.clock_ms += 150;
        self.calls.push(what);
    }

    fn count(&self, prefix: &str) -> usize {
        self.calls.iter().filter(|c| c.starts_with(prefix)).count()
    }

    /// The coin an exchange URL asks about, and its price there (per token: kPEPE trades as PEPE).
    fn exchange_price(&self, url: &str) -> Option<f64> {
        self.prices.iter().find_map(|(coin, &p)| {
            let (base, mult) = match coin.strip_prefix('k') {
                Some(rest) if rest.starts_with(|c: char| c.is_ascii_uppercase()) => (rest, 1000.0),
                _ => (coin.as_str(), 1.0),
            };
            let hit = url.contains(&format!("={base}USDT"))
                || url.contains(&format!("={base}-USDT"))
                || url.contains(&format!("/{base}-USD/"));
            hit.then_some(p / mult)
        })
    }

    fn exchange(&self, url: &str) -> Option<Value> {
        let p = self.exchange_price(url)?;
        let f = |x: f64| format!("{x}");
        let now = self.clock_ms;
        if url.contains("ticker") {
            return Some(if url.contains("binance") {
                json!({"symbol": "X", "bidPrice": f(p), "askPrice": f(p)})
            } else if url.contains("okx") {
                json!({"code": "0", "data": [{"bidPx": f(p), "askPx": f(p)}], "msg": ""})
            } else if url.contains("bybit") {
                json!({"retCode": 0, "result": {"list": [{"bid1Price": f(p), "ask1Price": f(p)}]}})
            } else {
                json!({"bid": f(p), "ask": f(p)})
            });
        }
        let hour = url.contains("1h") || url.contains("1H") || url.contains("interval=60");
        let (len, count) = if hour { (3_600_000, 722) } else { (60_000, 62) };
        let end = now / len * len;
        let mut rows: Vec<(u64, f64)> = (0..count).rev().map(|i| (end - i * len, p)).collect();
        if url.contains("okx") && hour {
            let after: u64 = url
                .split("after=")
                .nth(1)
                .map_or(u64::MAX, |a| a.parse().unwrap());
            rows.retain(|r| r.0 < after);
            let skip = rows.len().saturating_sub(300);
            rows = rows[skip..].to_vec();
        }
        let row = |t: u64, c: f64| json!([t.to_string(), f(c), f(c), f(c), f(c), "1", "1"]);
        Some(if url.contains("binance") {
            Value::Array(
                rows.iter()
                    .map(|&(t, c)| json!([t, f(c), f(c), f(c), f(c), "1", t + len - 1]))
                    .collect(),
            )
        } else if url.contains("okx") {
            json!({"code": "0", "data": rows.iter().rev().map(|&(t, c)| row(t, c)).collect::<Vec<_>>()})
        } else {
            json!({"retCode": 0, "result": {"list": rows.iter().rev().map(|&(t, c)| row(t, c)).collect::<Vec<_>>()}})
        })
    }

    fn hyperliquid(&mut self, body: &Value) -> Value {
        let kind = body["type"].as_str().unwrap().to_string();
        self.tick(format!("hyperliquid {kind}"));
        if kind == "metaAndAssetCtxs" {
            // The recorded market, with each priced coin's oracle and mark at the pretend price.
            let mut meta = self.meta.clone();
            let names: Vec<String> = meta[0]["universe"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a["name"].as_str().unwrap().to_string())
                .collect();
            for (i, name) in names.iter().enumerate() {
                if let Some(&p) = self.prices.get(name) {
                    meta[1][i]["oraclePx"] = json!(format!("{p}"));
                    meta[1][i]["markPx"] = json!(format!("{p}"));
                }
            }
            return meta;
        }
        assert!(body["user"].as_str().unwrap().starts_with("0x"));
        self.account
            .get(kind.as_str())
            .cloned()
            .unwrap_or(Value::Null)
    }

    fn near(&mut self, url: &str, body: &Value) -> Value {
        let mainnet = url.contains("free.rpc");
        let net = if mainnet { "mainnet" } else { "testnet" };
        let height: u64 = if mainnet { 223_672_573 } else { 276_829_715 };
        if body["method"] == "block" {
            self.tick(format!("near {net} block"));
            let ts = (T0_MS - 1_000) * 1_000_000;
            return json!({"jsonrpc": "2.0", "id": "pb", "result": {"header": {"height": height,
                "timestamp_nanosec": ts.to_string(), "hash": "11111111111111111111111111111111"}}});
        }
        let p = &body["params"];
        assert_eq!(
            p["block_id"],
            json!(height),
            "every view reads at the block read"
        );
        let (account, method) = (
            p["account_id"].as_str().unwrap(),
            p["method_name"].as_str().unwrap(),
        );
        self.tick(format!("near {net} {account}.{method}"));
        let args: Value =
            serde_json::from_slice(&decode_b64(p["args_base64"].as_str().unwrap())).unwrap();
        let value = match (account, method) {
            ("pool.pbf.testnet", "get_pool") => fixture("pool_get_pool")["value"].clone(),
            ("pool.pbf.testnet", "get_params") => fixture("pool_get_params")["value"].clone(),
            ("contract.main.burrow.near", "get_assets") => {
                // As the contract does: the assets asked for that exist, in the order asked.
                let mut all = fixture("rhea_get_assets")["value"].clone();
                if let Some(apr) = self.rhea_borrow_apr {
                    assert_eq!(all[0]["token_id"], args["token_ids"][0], "USDC is first");
                    all[0]["borrow_apr"] = json!(apr);
                }
                let ids: Vec<&str> = args["token_ids"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_str().unwrap())
                    .collect();
                Value::Array(
                    ids.iter()
                        .filter_map(|id| {
                            all.as_array()
                                .unwrap()
                                .iter()
                                .find(|a| a["token_id"] == *id)
                                .cloned()
                        })
                        .collect(),
                )
            }
            _ => panic!("unexpected view {account}.{method}"),
        };
        let bytes: Vec<Value> = value.to_string().bytes().map(Value::from).collect();
        json!({"jsonrpc": "2.0", "id": "pb", "result": {"result": bytes, "logs": [], "block_height": height}})
    }

    fn one_click(&mut self, body: &Value) -> (u16, Value) {
        assert_eq!(body["dry"], true, "only dry quotes");
        if body["originAsset"] == WBTC_ON_ETHEREUM {
            // The way back: WBTC in from an Ethereum address, nBTC out to a NEAR account.
            self.tick("1click back quote".into());
            assert_eq!(body["destinationAsset"], "nep141:nbtc.bridge.near");
            assert!(body["refundTo"].as_str().unwrap().starts_with("0x"));
            assert!(!body["recipient"].as_str().unwrap().starts_with("0x"));
            let Some(cost) = self.back_bp else {
                let mut refused = fixture("oneclick_dry_no_liquidity")["response"].clone();
                refused["message"] = json!("Quoting for this pair is not available");
                return (400, refused);
            };
            let amount: u128 = body["amount"].as_str().unwrap().parse().unwrap();
            let mut answer = fixture("oneclick_dry_nbtc_wbtc")["response"].clone();
            answer["quote"]["amountIn"] = json!(body["amount"]);
            answer["quote"]["amountOut"] = json!((amount * (10_000 - cost) / 10_000).to_string());
            return (201, answer);
        }
        if body["destinationAsset"] == WBTC_ON_ETHEREUM {
            // The move to Ethereum: nBTC in, WBTC out to an Ethereum address, less what the move costs.
            self.tick("1click move quote".into());
            assert_eq!(body["originAsset"], "nep141:nbtc.bridge.near");
            assert!(body["recipient"].as_str().unwrap().starts_with("0x"));
            let Some(cost) = self.move_bp else {
                return (
                    400,
                    fixture("oneclick_dry_no_liquidity")["response"].clone(),
                );
            };
            let amount: u128 = body["amount"].as_str().unwrap().parse().unwrap();
            let mut answer = fixture("oneclick_dry_nbtc_wbtc")["response"].clone();
            answer["quote"]["amountIn"] = json!(body["amount"]);
            answer["quote"]["amountOut"] = json!((amount * (10_000 - cost) / 10_000).to_string());
            return (201, answer);
        }
        self.tick("1click quote".into());
        let Some(pi) = self.pi else {
            return (
                400,
                fixture("oneclick_dry_no_liquidity")["response"].clone(),
            );
        };
        let (coin, decimals) = match body["originAsset"].as_str().unwrap() {
            "nep141:nbtc.bridge.near" => (Some("BTC"), 8),
            "nep141:eth.bridge.near" => (Some("ETH"), 18),
            "nep141:usdt.tether-token.near" => (None, 6),
            other => panic!("unexpected asset {other}"),
        };
        let amount: f64 = body["amount"].as_str().unwrap().parse().unwrap();
        let price = coin.map_or(1.0, |c| self.prices[c]);
        let out = (amount / 10f64.powi(decimals) * price * pi * 1e6).floor();
        let mut answer = fixture("oneclick_dry_nbtc")["response"].clone();
        answer["quote"]["amountIn"] = json!(body["amount"]);
        answer["quote"]["amountOut"] = json!(format!("{}", out as u128));
        (201, answer)
    }
}

fn decode_b64(s: &str) -> Vec<u8> {
    const ABC: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let (mut bits, mut n, mut out) = (0u32, 0, Vec::new());
    for c in s.chars().filter(|&c| c != '=') {
        bits = (bits << 6) | ABC.find(c).unwrap() as u32;
        n += 6;
        if n >= 8 {
            n -= 8;
            out.push((bits >> n) as u8);
            bits &= (1 << n) - 1;
        }
    }
    out
}

impl Net for Mainnet {
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
                body: b"{}".to_vec(),
            },
        })
    }

    fn post(&mut self, url: &str, body: &str) -> Result<Reply, String> {
        let req: Value = serde_json::from_str(body).unwrap();
        let (status, v) = if url == "https://api.hyperliquid.xyz/info" {
            (200, self.hyperliquid(&req))
        } else if url.contains("rpc.fastnear.com") {
            (200, self.near(url, &req))
        } else if url == "https://1click.chaindefuser.com/v0/quote" {
            self.one_click(&req)
        } else if url == AAVE_API && self.aave.is_some() {
            self.tick("aave reserves".into());
            let query = req["query"].as_str().unwrap();
            assert!(
                query.contains("usdc: reserve(request:")
                    && query.contains("wbtc: reserve(request:")
            );
            (200, self.aave.clone().unwrap())
        } else {
            return Err(format!("unexpected POST to {url}"));
        };
        Ok(Reply {
            status,
            body: v.to_string().into_bytes(),
        })
    }

    fn now_ms(&mut self) -> u64 {
        self.clock_ms
    }
}

/// The worked example (PLAN.md 6.9, RISK_ENGINE.md 13.1): $35k of USDC margin and a $100k BTC short, with $100k
/// of nBTC on NEAR: 1.25 nBTC at $80,000.
const WORKED: &str = r#"{"mode":"credit_check","network":"mainnet","hl_address":null,
    "book":{"usdc":"35000000000","positions":[{"coin":"BTC","usd":"-100000000000"}]},
    "spot":[{"token":"nBTC","amount":"125000000"}],"snapshot":false}"#;

fn run(world: Mainnet, req: &str) -> (String, Mainnet) {
    let mut net = world;
    let out = pb_risk::run(req, &mut net);
    (out, net)
}

fn result(out: &str) -> CreditResult {
    serde_json::from_str(out).unwrap_or_else(|e| panic!("not a credit result ({e}): {out}"))
}

fn reason(out: &str) -> String {
    let v: Value = serde_json::from_str(out).unwrap();
    assert_eq!(v["ok"], false, "{out}");
    v["reason"].as_str().unwrap().to_string()
}

#[test]
fn the_worked_example_gets_the_standard_line() {
    let (out, net) = run(Mainnet::new(), WORKED);
    let r = result(&out);
    let v = &r.verdict;
    // RISK_ENGINE.md 13.1: equity $135,000; a new client's Standard line is $94,500, set by the 70% tier cap.
    assert_eq!(
        (v.eq, v.eq_allow),
        (135_000_000_000, 135_000_000_000),
        "{out}"
    );
    assert_eq!(v.credit.line, 94_500_000_000, "{out}");
    assert_eq!(v.credit.binding, "C4");
    assert_eq!((v.score, v.tier.as_str()), (700, "STANDARD"));
    assert_eq!((v.hr_bp, v.hr7_bp), (10_000, 10_000));
    // 13.1's buffer comes from the 13 Mar 2020 rebound, which takes the short through Hyperliquid's backstop.
    assert!(v.mm > 14_000_000_000 && v.mm < 17_000_000_000, "{out}");
    assert_eq!(v.im, (v.mm as f64 * 1.25).ceil() as i64);
    assert!(v.top[0].starts_with("replay 2020-03-12"), "{out}");
    assert!(v.topup > 0);
    // Nothing lent from our testnet pool: base rate 0 plus Standard's 2%; 6.5% at the plan's 60%.
    assert_eq!((v.rate_bp, v.rate_bp_at_60), (200, 650));
    assert_eq!(r.limits.first_week, 25_000_000_000);
    assert_eq!(r.limits.ceiling, 1_000_000_000_000);
    assert_eq!(r.pi["nBTC"].bp, 10_000);
    assert_eq!(r.pi["nBTC"].source, "1Click dry quote, no key");
    assert_eq!(r.prices["BTC"], 80_000_000_000);
    assert!(r.unlisted.is_empty() && r.without_unlisted.is_none() && r.ignored.is_empty());
    assert_eq!(
        (r.pool.id.as_str(), r.pool.util_bp),
        ("pool.pbf.testnet", 0)
    );
    assert_eq!((r.near_blk, r.rhea.blk), (276_829_715, 223_672_573));
    assert!(out.len() < 8_000, "{} bytes", out.len());
    // The reads: our pool on testnet (3), Rhea on mainnet (2), Hyperliquid's market (1), BTC's 12 exchange
    // calls, and one dry quote.
    assert_eq!(net.count("near testnet"), 3);
    assert_eq!(net.count("near mainnet"), 2);
    assert_eq!(net.count("hyperliquid"), 1);
    assert_eq!(net.count("get "), 12);
    assert_eq!(net.count("1click"), 1);
    assert_eq!(net.calls.len(), 19);
}

#[test]
fn rhea_alone_lends_against_the_spot_at_a_health_factor_of_one() {
    let r = result(&run(Mainnet::new(), WORKED).0);
    // $100k of nBTC at Rhea's 80% volatility ratio, borrowing USDC at 95%: $76,000 at a health factor of 1.0,
    // and $63,333 at 1.2.
    assert_eq!((r.rhea.max, r.rhea.safe), (76_000_000_000, 63_333_333_333));
    assert_eq!(
        (r.rhea.usdc_volatility_bp, r.rhea.usdc_borrow_apr_bp),
        (9_500, 1_670)
    );
    assert_eq!(r.rhea.tokens.len(), 1);
    let t = &r.rhea.tokens[0];
    assert_eq!(
        (t.token.as_str(), t.value, t.volatility_bp, t.collateral),
        ("nBTC", 100_000_000_000, 8_000, true)
    );
    assert_eq!(r.rhea.contract, "contract.main.burrow.near");
    assert!(r.rhea.error.is_none());
    // Our line is 24% above Rhea's maximum, and 49% above what Rhea would lend safely.
    assert!(r.verdict.credit.line > r.rhea.max);
}

#[test]
fn a_book_with_no_spot_gets_nothing_from_rhea() {
    let req = WORKED.replace(
        r#""spot":[{"token":"nBTC","amount":"125000000"}]"#,
        r#""spot":[]"#,
    );
    let (out, net) = run(Mainnet::new(), &req);
    let r = result(&out);
    assert_eq!((r.rhea.max, r.rhea.safe), (0, 0));
    assert!(r.rhea.tokens.is_empty() && r.pi.is_empty());
    assert_eq!(net.count("1click"), 0);
    // A naked $100k short on $35k: Watch (hedge ratio 0), and a much smaller line.
    assert_eq!(r.verdict.tier, "WATCH");
    assert!(r.verdict.credit.line < 30_000_000_000, "{out}");
}

#[test]
fn an_unlisted_coin_zeroes_the_line() {
    // A DYDX position: not on the allow-list.
    let req = WORKED.replace(
        r#"{"coin":"BTC","usd":"-100000000000"}"#,
        r#"{"coin":"BTC","usd":"-100000000000"},{"coin":"DYDX","usd":"5000000000"}"#,
    );
    let (out, _) = run(Mainnet::new(), &req);
    let r = result(&out);
    assert_eq!(
        (r.verdict.credit.line, r.verdict.credit.binding.as_str()),
        (0, "UNLISTED"),
        "{out}"
    );
    assert_eq!(r.unlisted, ["DYDX"]);
    // Without it (entered at the mark, so no PnL to leave out), the worked example's line.
    let w = r.without_unlisted.unwrap();
    assert_eq!(
        (
            w.line,
            w.binding.as_str(),
            w.score,
            w.tier.as_str(),
            w.rate_bp
        ),
        (94_500_000_000, "C4", 700, "STANDARD", 200)
    );
}

#[test]
fn an_address_with_an_unlisted_position_shows_what_closing_it_brings() {
    // A standard account: a $100k BTC short entered at $80,000 and a DYDX long $2,000 in profit, $37,000 of account
    // value; nBTC on NEAR. Spot HYPE, an isolated ETH position, a vault deposit and staked HYPE are listed, not
    // counted.
    let mut world = Mainnet::new();
    world.account.insert("clearinghouseState", json!({
        "marginSummary": {"accountValue": "37500.0"}, "crossMarginSummary": {"accountValue": "37000.0"},
        "assetPositions": [
            {"type": "oneWay", "position": {"coin": "BTC", "szi": "-1.25", "entryPx": "80000", "unrealizedPnl": "0.0",
                "leverage": {"type": "cross", "value": 20}, "marginUsed": "5000"}},
            {"type": "oneWay", "position": {"coin": "DYDX", "szi": "100000", "entryPx": "0.08", "unrealizedPnl": "2000.0",
                "leverage": {"type": "cross", "value": 5}, "marginUsed": "2000"}},
            {"type": "oneWay", "position": {"coin": "ETH", "szi": "0.5", "entryPx": "2000", "unrealizedPnl": "0.0",
                "leverage": {"type": "isolated", "value": 2, "rawUsd": "-500"}, "marginUsed": "500"}}]}));
    world.account.insert(
        "spotClearinghouseState",
        json!({"balances": [
        {"coin": "USDC", "token": 0, "hold": "0.0", "total": "12.5", "entryNtl": "0.0"},
        {"coin": "HYPE", "token": 150, "hold": "0.0", "total": "10.25", "entryNtl": "400.0"}]}),
    );
    world
        .account
        .insert("userVaultEquities", fixture("hl_hlp_userVaultEquities"));
    world.account.insert("delegatorSummary", json!({"delegated": "100.0", "undelegated": "0.0", "totalPendingWithdrawal": "0.0", "nPendingWithdrawals": 0}));
    world.account.insert("frontendOpenOrders", json!([
        {"coin": "@107", "side": "B", "limitPx": "30", "sz": "1", "oid": 1, "reduceOnly": false},
        {"coin": "BTC", "side": "B", "limitPx": "70000", "sz": "0.1", "oid": 2, "reduceOnly": true}]));
    let req = r#"{"mode":"credit_check","network":"mainnet","hl_address":"0x00000000000000000000000000000000000000AA",
        "spot":[{"token":"nBTC","amount":"125000000"}]}"#;
    let (out, net) = run(world, req);
    let r = result(&out);
    assert_eq!(
        r.hl_address.as_deref(),
        Some("0x00000000000000000000000000000000000000aa")
    );
    assert_eq!(
        (r.verdict.credit.line, r.verdict.credit.binding.as_str()),
        (0, "UNLISTED"),
        "{out}"
    );
    assert_eq!(r.unlisted, ["DYDX"]);
    // The cross account is worth $37,000 with DYDX's $2,000 of profit; equity counts it while DYDX is held.
    assert_eq!(r.verdict.eq, 137_000_000_000, "{out}");
    // Closed, its profit is left out too: $35,000 of margin, the worked example's line.
    let w = r.without_unlisted.unwrap();
    assert_eq!(
        (w.line, w.binding.as_str()),
        (94_500_000_000, "C4"),
        "{out}"
    );
    let what: Vec<&str> = r.ignored.iter().map(|i| i.what.as_str()).collect();
    assert_eq!(
        what,
        [
            "isolated ETH",
            "1 spot order",
            "spot USDC 12.5",
            "spot HYPE 10.25",
            "7 vault deposits, $139,894,699",
            "staked HYPE 100"
        ],
        "{out}"
    );
    assert!(r.ignored.iter().all(|i| !i.why.is_empty()));
    // Six Hyperliquid account reads, then the market.
    assert_eq!(net.count("hyperliquid"), 7);
}

#[test]
fn pi_comes_from_the_quote_and_is_capped_at_one() {
    // 1Click pays 0.6% under fair value (its fee without a key is in this): π 0.994.
    let low = Mainnet {
        pi: Some(0.994),
        ..Mainnet::new()
    };
    let r = result(&run(low, WORKED).0);
    assert_eq!(r.pi["nBTC"].bp, 9_940);
    assert!(r.verdict.coins.reduce_only.is_empty());
    // 0.6% less nBTC value: $600 less equity, and 70% of that less line.
    assert_eq!(r.verdict.eq, 134_400_000_000);
    assert_eq!(r.verdict.credit.line, 94_080_000_000);
    // A quote above fair value counts as 1: a wrapper is never worth more to us than what it wraps.
    let high = Mainnet {
        pi: Some(1.01),
        ..Mainnet::new()
    };
    assert_eq!(result(&run(high, WORKED).0).pi["nBTC"].bp, 10_000);
    // No quote: the extreme depeg, 0.80, and nBTC is reduce-only.
    let none = Mainnet {
        pi: None,
        ..Mainnet::new()
    };
    let r = result(&run(none, WORKED).0);
    assert_eq!(r.pi["nBTC"].bp, 8_000);
    assert_eq!(
        r.pi["nBTC"].source,
        "no 1Click quote (No liquidity available): 0.80, and reduce-only"
    );
    assert_eq!(r.verdict.coins.reduce_only, ["nBTC"]);
}

#[test]
fn bad_requests_and_on_chain_runs_are_refused_before_any_read() {
    let mut net = Mainnet::new();
    for (req, why) in [
        (
            r#"{"mode":"credit_check","network":"mainnet","hl_address":"0x1234"}"#,
            "40 hex",
        ),
        (
            r#"{"mode":"credit_check","network":"mainnet","hl_address":"alice.near"}"#,
            "40 hex",
        ),
        (
            r#"{"mode":"credit_check","network":"testnet","hl_address":"0x00000000000000000000000000000000000000aa"}"#,
            "mainnet",
        ),
        (
            r#"{"mode":"credit_check","network":"mainnet"}"#,
            "hl_address or a what-if book",
        ),
        (
            r#"{"mode":"credit_check","network":"mainnet","book":{"usdc":"1","positions":[]},"spot":[{"token":"wBTC","amount":"1"}]}"#,
            "not one of",
        ),
        (r#"{"mode":"swap"}"#, "unknown mode"),
    ] {
        assert!(reason(&pb_risk::run(req, &mut net)).contains(why), "{req}");
    }
    let on_chain = pb_risk::run_for(WORKED, &mut net, true);
    assert!(reason(&on_chain).contains("HTTPS API only"));
    assert!(net.calls.is_empty(), "{:?}", net.calls);
}

#[test]
fn a_fresh_address_has_nothing_to_lend_against() {
    let req = r#"{"mode":"credit_check","network":"mainnet","hl_address":"0x00000000000000000000000000000000000000aa"}"#;
    let (out, net) = run(Mainnet::new(), req);
    let r = result(&out);
    assert_eq!(
        (
            r.verdict.eq,
            r.verdict.credit.line,
            r.verdict.credit.binding.as_str()
        ),
        (0, 0, "C0"),
        "{out}"
    );
    assert!(r.prices.is_empty() && r.rhea.tokens.is_empty());
    // Nothing to price: no exchange call and no market read.
    assert_eq!((net.count("get "), net.count("hyperliquid")), (0, 6));
}

#[test]
fn a_book_past_the_coin_limit_is_refused_by_name() {
    // HLP's strategy vault, as read on 9 Nov: 177 positions, all 23 allow-listed coins among them.
    let req = r#"{"mode":"credit_check","network":"mainnet","hl_address":"0x010461c14e146ac35fe42271bdc1134ee31c703a"}"#;
    let (out, net) = run(Mainnet::new().vault(), req);
    let why = reason(&out);
    assert!(
        why.contains("23 coins on our list") && why.contains("at most 6"),
        "{why}"
    );
    assert_eq!(net.count("get "), 0);
}

#[test]
fn the_snapshot_replays_to_the_byte() {
    let req = WORKED.replace(r#""snapshot":false"#, r#""snapshot":true"#);
    let (out, _) = run(
        Mainnet {
            pi: Some(0.9937),
            ..Mainnet::new()
        },
        &req,
    );
    let v: Value = serde_json::from_str(&out).unwrap();
    let inputs: pb_read::credit::CreditInputs =
        serde_json::from_value(v["inputs"].clone()).unwrap();
    let start = out.find(r#"{"result":"#).unwrap() + r#"{"result":"#.len();
    let end = out.find(r#","inputs":"#).unwrap();
    let printed = &out[start..end];
    assert_eq!(credit::output(&inputs), printed);
    assert_eq!(credit::snapshot(&inputs), out);
    // `in` is the hash of the inputs, and a pretty-printed copy gives the same result.
    assert_eq!(result(printed).inputs, inputs.hash());
    let pretty: pb_read::credit::CreditInputs =
        serde_json::from_str(&serde_json::to_string_pretty(&inputs).unwrap()).unwrap();
    assert_eq!(credit::output(&pretty), printed);
    // The same run without a snapshot prints the same result.
    let (plain, _) = run(
        Mainnet {
            pi: Some(0.9937),
            ..Mainnet::new()
        },
        WORKED,
    );
    assert_eq!(plain, printed);
}

#[test]
fn many_unlisted_coins_keep_the_result_small() {
    let positions: Vec<String> = (0..19)
        .map(|i| format!(r#"{{"coin":"ZZ{i}COIN","usd":"1000000"}}"#))
        .chain([r#"{"coin":"BTC","usd":"-100000000000"}"#.to_string()])
        .collect();
    let req = format!(
        r#"{{"mode":"credit_check","network":"mainnet","book":{{"usdc":"35000000000","positions":[{}]}},
        "spot":[{{"token":"nBTC","amount":"125000000"}},{{"token":"USDC","amount":"1000000"}},{{"token":"ETH","amount":"1000000000000000000"}},
                {{"token":"USDT","amount":"1000000"}},{{"token":"wNEAR","amount":"1000000000000000000000000"}}]}}"#,
        positions.join(",")
    );
    let (out, _) = run(Mainnet::new(), &req);
    let r = result(&out);
    assert_eq!(r.unlisted.len(), 19);
    assert!(out.len() < 8_000, "{} bytes", out.len());
    // Every spot token is valued and has Rhea's terms.
    assert_eq!(r.rhea.tokens.len(), 5);
    assert!(
        r.rhea.tokens.iter().all(|t| t.value > 0 && t.collateral),
        "{out}"
    );
    assert_eq!(r.pi.keys().collect::<Vec<_>>(), ["ETH", "USDT", "nBTC"]);
}

#[test]
fn the_credit_check_values_a_24_decimals_token_at_its_true_size() {
    // 346.1 wNEAR at the pretend $4 and nothing else but $1 on Hyperliquid: $1,385.40, not $138,441 (INTERFACES.md
    // 50.6: the engine divided by at most 10^22).
    let asked = |amount: &str| {
        let req = format!(
            r#"{{"mode":"credit_check","network":"mainnet","hl_address":null,"book":{{"usdc":"1000000","positions":[]}},
            "spot":[{{"token":"wNEAR","amount":"{amount}"}}],"snapshot":false}}"#
        );
        result(&run(Mainnet::new(), &req).0)
    };
    let r = asked("346100000000000000000000000");
    assert!((r.verdict.eq as f64 / 1e6 - (346.1 * 4.0 + 1.0)).abs() < 0.001, "{}", r.verdict.eq);
    let wnear = r.rhea.tokens.iter().find(|t| t.token == "wNEAR").unwrap();
    assert!((wnear.value as f64 / 1e6 - 346.1 * 4.0).abs() < 0.001, "{}", wnear.value);
    // The line is under the holding's value. Read 100 times too large it came to tens of thousands of dollars.
    assert!(r.verdict.credit.line < 1_384_400_000, "{:?}", r.verdict.credit);
    // One wNEAR more is $4 more.
    let more = asked("347100000000000000000000000");
    assert!(((more.verdict.eq - r.verdict.eq) as f64 / 1e6 - 4.0).abs() < 0.001);
}

/// The worked example's snapshot, committed; `backtest credit` replays it too. To write it again after a
/// deliberate change: PB_RISK_WRITE_FIXTURES=1 cargo test -p pb-risk --test credit
#[test]
fn the_committed_snapshot_replays() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/credit_worked.json"
    );
    if std::env::var("PB_RISK_WRITE_FIXTURES").is_ok() {
        let req = WORKED.replace(r#""snapshot":false"#, r#""snapshot":true"#);
        let (out, _) = run(
            Mainnet {
                pi: Some(0.9937),
                ..Mainnet::new()
            },
            &req,
        );
        std::fs::write(path, out + "\n").unwrap();
    }
    let text = std::fs::read_to_string(path).unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    let inputs: pb_read::credit::CreditInputs =
        serde_json::from_value(v["inputs"].clone()).unwrap();
    assert_eq!(credit::snapshot(&inputs), text.trim_end());
    assert_eq!(
        v["result"]["verdict"]["credit"],
        json!({"line": 94_059_000_000u64, "binding": "C4"})
    );
}

/// Not a check: prints the worked example's result, for reading.
///   cargo test -p pb-risk --test credit print_worked_example -- --ignored --nocapture
#[test]
#[ignore]
fn print_worked_example() {
    let (out, net) = run(
        Mainnet {
            pi: Some(0.9937),
            ..Mainnet::new()
        },
        WORKED,
    );
    println!("{} bytes, {} calls: {out}", out.len(), net.calls.len());
}

// ------------------------------------------------------------------------------- funding (INTERFACES.md 27)

fn funding(out: &str) -> credit::Funding {
    result(out)
        .funding
        .unwrap_or_else(|| panic!("no funding section: {out}"))
}

#[test]
fn the_worked_example_is_part_lender_and_part_pool() {
    let (out, net) = run(Mainnet::with_lenders(), WORKED);
    let f = funding(&out);
    assert_eq!(
        (f.line, f.pool_rate_bp, f.target_hf_bp, f.loan_days),
        (94_500_000_000, 650, 15_000, 90),
        "{out}"
    );
    assert_eq!(f.lenders.len(), 2);
    // Aave liquidates WBTC at 85%: against $100,000 of bitcoin at a cushion of 1.5 it lends $56,667, and our pool
    // lends the other $37,833. Bitcoin must fall by a third before Aave sells.
    let aave = &f.lenders[0];
    assert_eq!(
        (
            aave.l.as_str(),
            aave.chain.as_str(),
            aave.collateral.as_str()
        ),
        ("aave", "Ethereum", "WBTC")
    );
    assert_eq!(
        (
            aave.rate_bp,
            aave.supply_bp,
            aave.liq_bp,
            aave.ltv_bp,
            aave.penalty_bp
        ),
        (508, 430, 8_500, 8_100, 500)
    );
    assert_eq!(aave.free, 163_198_398_228_281);
    assert_eq!((aave.lends, aave.pool), (56_666_666_666, 37_833_333_334));
    assert_eq!(aave.fall_bp, 3_334);
    // 5.08% on Aave's part and 6.50% on ours is 5.65% on the whole.
    assert_eq!(aave.blended_bp, 565);
    // Moving $100,000 of bitcoin to Ethereum at 0.56% costs $560, and bringing it back at 0.13% costs $130: $690
    // both ways. Aave's rate is 1.42% a year under ours, which saves $198 on its part in 90 days: the move
    // doesn't pay.
    let mv = aave.move_cost.as_ref().expect("a move quote");
    assert_eq!(
        (mv.cost_bp, mv.cost, mv.saves),
        (56, 560_000_000, 198_410_958)
    );
    assert_eq!(
        (mv.back_bp, mv.back, mv.back_quoted, mv.total),
        (Some(13), Some(130_000_000), Some(true), Some(690_000_000))
    );
    assert_eq!(mv.source, "1Click dry quotes, no key, there and back");
    assert!(!aave.used);
    assert_eq!(
        aave.why,
        "Aave looks at the bitcoin alone, not the hedge: against $100,000 of it, it lends $56,667 at 5.08% a year, \
         and sells if bitcoin falls 33.3%. Our pool lends the other $37,833 at 6.50%. Moving that bitcoin to \
         Ethereum and back costs $690 ($560 there, $130 back), and Aave's lower rate saves $198 over 90 days, \
         which doesn't cover it, so Aave isn't used: our pool lends the whole $94,500."
    );
    // Rhea liquidates nBTC against USDC at 76%: it lends $50,667, at 16.70%, which is dearer than our 6.50%.
    let rhea = &f.lenders[1];
    assert_eq!(
        (
            rhea.l.as_str(),
            rhea.chain.as_str(),
            rhea.collateral.as_str()
        ),
        ("rhea", "NEAR", "nBTC")
    );
    assert_eq!(
        (
            rhea.rate_bp,
            rhea.supply_bp,
            rhea.liq_bp,
            rhea.ltv_bp,
            rhea.penalty_bp
        ),
        (1_670, 1_088, 7_600, 7_600, 0)
    );
    assert_eq!(rhea.free, 1_846_122_352_728);
    assert_eq!((rhea.lends, rhea.pool), (50_666_666_666, 43_833_333_334));
    assert_eq!((rhea.fall_bp, rhea.blended_bp), (3_334, 1_197));
    assert!(rhea.move_cost.is_none() && !rhea.used);
    assert_eq!(
        rhea.why,
        "Rhea looks at the bitcoin alone, not the hedge: against $100,000 of it, it lends $50,667 at 16.70% a year, \
         and sells if bitcoin falls 33.3%. Our pool lends the other $43,833 at 6.50%. Rhea costs more than our pool, \
         so it isn't used: our pool lends the whole $94,500."
    );
    assert_eq!(f.choice, "pool");
    // The shape, as INTERFACES.md 27 writes it.
    assert!(
        out.contains(
            r#""funding":{"line":94500000000,"pool_rate_bp":650,"target_hf_bp":15000,"loan_days":90,"lenders":[{"l":"aave","chain":"Ethereum","collateral":"WBTC","rate_bp":508,"supply_bp":430,"liq_bp":8500,"ltv_bp":8100,"penalty_bp":500,"free":163198398228281,"lends":56666666666,"pool":37833333334,"fall_bp":3334,"blended_bp":565,"move":{"cost_bp":56,"cost":560000000,"back_bp":13,"back":130000000,"back_quoted":true,"total":690000000,"saves":198410958,"source":"1Click dry quotes, no key, there and back"},"used":false,"why":"Aave "#
        ),
        "{out}"
    );
    assert!(out.contains(r#""blended_bp":1197,"move":null,"used":false,"why":"Rhea "#));
    assert!(out.contains(r#""choice":"pool"},"in":""#));
    for w in f.lenders.iter().map(|l| l.why.to_lowercase()) {
        assert!(!w.contains("slice"), "{w}");
    }
    // The rest of the result is the worked example's, and three reads are new: Aave, and the quotes for the move
    // there and back.
    let r = result(&out);
    assert_eq!(r.verdict.credit.line, 94_500_000_000);
    assert_eq!((r.rhea.max, r.rhea.safe), (76_000_000_000, 63_333_333_333));
    assert_eq!((net.count("aave"), net.count("1click move"), net.count("1click back")), (1, 1, 1));
    assert_eq!(net.count("1click"), 3);
    assert_eq!(net.calls.len(), 22);
    assert!(out.len() < 8_000, "{} bytes", out.len());
}

#[test]
fn a_lender_is_used_when_what_it_saves_beats_the_move() {
    // The move costs 0.10% there and 0.05% back, $150 in all, and Aave's lower rate saves $198 over 90 days: Aave
    // is used.
    let cheap_move = Mainnet {
        move_bp: Some(10),
        back_bp: Some(5),
        ..Mainnet::with_lenders()
    };
    let f = funding(&run(cheap_move, WORKED).0);
    let aave = &f.lenders[0];
    let mv = aave.move_cost.as_ref().unwrap();
    assert_eq!(
        (mv.cost_bp, mv.cost, mv.saves),
        (10, 100_000_000, 198_410_958)
    );
    assert_eq!((mv.back, mv.total, mv.in_all()), (Some(50_000_000), Some(150_000_000), 150_000_000));
    assert!(aave.used && !f.lenders[1].used);
    assert!(
        aave.why.ends_with(
            "Moving that bitcoin to Ethereum and back costs $150 ($100 there, $50 back), and Aave's lower rate \
             saves $198 over 90 days, so it is used."
        ),
        "{}",
        aave.why
    );
    assert_eq!(f.choice, "aave");
    // The way there alone would pay ($100 against $198). With the way back at 0.10% too, $200 both ways, it
    // doesn't: the lender is used by the total.
    let dear_back = Mainnet {
        move_bp: Some(10),
        back_bp: Some(10),
        ..Mainnet::with_lenders()
    };
    let f2 = funding(&run(dear_back, WORKED).0);
    assert!(!f2.lenders[0].used);
    assert_eq!(f2.choice, "pool");
    // With Rhea at 3% too: its bitcoin needn't move, and 3.5% a year less on $50,667 saves $437 in 90 days, more
    // than Aave's $198 less the $150 move. Both qualify, and Rhea saves more.
    let both = Mainnet {
        move_bp: Some(10),
        back_bp: Some(5),
        rhea_borrow_apr: Some("0.03"),
        ..Mainnet::with_lenders()
    };
    let f = funding(&run(both, WORKED).0);
    let rhea = &f.lenders[1];
    assert!(f.lenders[0].used && rhea.used);
    assert_eq!((rhea.rate_bp, rhea.blended_bp), (300, 462));
    assert!(
        rhea.why.ends_with(
            "The bitcoin is already on NEAR, and Rhea's lower rate saves $437 over 90 days, so it is used."
        ),
        "{}",
        rhea.why
    );
    assert_eq!(f.choice, "rhea");
    // A move that costs exactly what it saves isn't worth making.
    assert_eq!(
        (f.lenders[0].lends * 142 * 90 / 3_650_000, mv.saves),
        (198_410_958, 198_410_958)
    );
}

#[test]
fn with_no_quote_for_the_move_aave_is_not_used() {
    let no_route = Mainnet {
        move_bp: None,
        ..Mainnet::with_lenders()
    };
    let (out, net) = run(no_route, WORKED);
    let f = funding(&out);
    let aave = &f.lenders[0];
    assert!(aave.move_cost.is_none() && !aave.used);
    assert_eq!(aave.lends, 56_666_666_666);
    assert!(
        aave.why.ends_with(
            "That bitcoin would have to move to Ethereum, and 1Click gave no quote for it (No liquidity available), \
             so Aave isn't used: our pool lends the whole $94,500."
        ),
        "{}",
        aave.why
    );
    assert!(out.contains(r#""blended_bp":565,"move":null,"used":false"#));
    assert_eq!(f.choice, "pool");
    assert_eq!(net.count("1click move"), 1);
}

#[test]
fn with_no_quote_for_the_way_back_the_way_there_counts_twice() {
    // 1Click quotes the way to Ethereum at 0.09% and nothing for the way back, as on 11 Nov. The way back then
    // counts the same again: $90 and $90, under the $198 saved, so Aave is used.
    let world = |move_bp| Mainnet {
        move_bp: Some(move_bp),
        back_bp: None,
        ..Mainnet::with_lenders()
    };
    let (out, net) = run(world(9), WORKED);
    let f = funding(&out);
    let aave = &f.lenders[0];
    let mv = aave.move_cost.as_ref().unwrap();
    assert_eq!((mv.cost_bp, mv.cost), (9, 90_000_000));
    assert_eq!(
        (mv.back_bp, mv.back, mv.back_quoted, mv.total),
        (Some(9), Some(90_000_000), Some(false), Some(180_000_000))
    );
    assert_eq!(
        mv.source,
        "1Click dry quote, no key, for the way there; no quote for the way back (Quoting for this pair is not \
         available), so it counts the same again"
    );
    assert!(aave.used);
    assert!(
        aave.why.ends_with(
            "Moving that bitcoin to Ethereum and back costs $180 ($90 there, and the same again for the way back, \
             which 1Click didn't quote: Quoting for this pair is not available), and Aave's lower rate saves $198 \
             over 90 days, so it is used."
        ),
        "{}",
        aave.why
    );
    assert!(out.contains(
        r#""move":{"cost_bp":9,"cost":90000000,"back_bp":9,"back":90000000,"back_quoted":false,"total":180000000,"saves":198410958,"source":"1Click dry quote, no key, for the way there; no quote for the way back (Quoting for this pair is not available), so it counts the same again"},"used":true"#
    ), "{out}");
    assert_eq!((net.count("1click move"), net.count("1click back")), (1, 1));
    // At 0.10% each way the doubled move costs $200, more than the $198: not used, though the way there alone
    // would have paid.
    let f = funding(&run(world(10), WORKED).0);
    let aave = &f.lenders[0];
    assert_eq!(aave.move_cost.as_ref().unwrap().total, Some(200_000_000));
    assert!(!aave.used);
    assert!(aave.why.contains("which doesn't cover it, so Aave isn't used"), "{}", aave.why);
    assert_eq!(f.choice, "pool");
}

#[test]
fn a_book_with_no_bitcoin_is_funded_by_our_pool_alone() {
    // The worked example in ether: 50 ETH at $2,000 on NEAR, hedged by a $100k ETH short. The same line, and no
    // bitcoin for a lender to look at.
    let req = r#"{"mode":"credit_check","network":"mainnet",
        "book":{"usdc":"35000000000","positions":[{"coin":"ETH","usd":"-100000000000"}]},
        "spot":[{"token":"ETH","amount":"50000000000000000000"}]}"#;
    let (out, net) = run(Mainnet::with_lenders(), req);
    let r = result(&out);
    let f = funding(&out);
    assert_eq!(f.line, 94_500_000_000, "{out}");
    assert_eq!(f.line, r.verdict.credit.line);
    assert_eq!(f.pool_rate_bp, r.verdict.rate_bp_at_60);
    assert_eq!(f.lenders.len(), 2);
    for l in &f.lenders {
        assert_eq!((l.lends, l.pool, l.fall_bp), (0, f.line, 0), "{out}");
        assert_eq!(u64::from(l.blended_bp), f.pool_rate_bp);
        assert!(l.move_cost.is_none() && !l.used);
        assert!(
            l.why.ends_with(
                "lends against bitcoin alone, and this book holds none on NEAR, so our pool lends the whole $94,500."
            ),
            "{}",
            l.why
        );
    }
    // Each lender's terms still show, Rhea's for nBTC too.
    assert_eq!((f.lenders[0].liq_bp, f.lenders[1].liq_bp), (8_500, 7_600));
    assert_eq!(f.choice, "pool");
    // No bitcoin to move: no quote for a move is asked, only ether's for its π.
    assert_eq!((net.count("aave"), net.count("1click move")), (1, 0));
    assert_eq!(net.count("1click"), 1);
    // With no spot at all, the same: nothing lent by a lender, and no quote asked.
    let bare = r#"{"mode":"credit_check","network":"mainnet","book":{"usdc":"35000000000","positions":[]}}"#;
    let (out, net) = run(Mainnet::with_lenders(), bare);
    let f = funding(&out);
    assert!(f.lenders.iter().all(|l| l.lends == 0 && !l.used), "{out}");
    assert_eq!(f.choice, "pool");
    assert_eq!(net.count("1click"), 0);
    assert!(result(&out).rhea.tokens.is_empty());
}

#[test]
fn a_lender_never_lends_past_the_line_or_what_it_has_free() {
    // No line (an unlisted coin): nothing to fund, whatever the bitcoin.
    let req = WORKED.replace(
        r#"{"coin":"BTC","usd":"-100000000000"}"#,
        r#"{"coin":"BTC","usd":"-100000000000"},{"coin":"DYDX","usd":"5000000000"}"#,
    );
    let f = funding(&run(Mainnet::with_lenders(), &req).0);
    assert_eq!(f.line, 0);
    for l in &f.lenders {
        assert_eq!((l.lends, l.pool, l.used), (0, 0, false));
        assert!(l.why.starts_with("This book gets no line"), "{}", l.why);
    }
    assert_eq!(f.choice, "pool");
    // 50 nBTC, $4,000,000, hedged: the line is far under what the bitcoin would carry at either lender. Each
    // lender's part stops at the line, counts only the bitcoin that part needs, and our pool lends nothing.
    let big = r#"{"mode":"credit_check","network":"mainnet",
        "book":{"usdc":"1400000000000","positions":[{"coin":"BTC","usd":"-4000000000000"}]},
        "spot":[{"token":"nBTC","amount":"5000000000"}],"snapshot":true}"#;
    let (out, _) = run(Mainnet::with_lenders(), big);
    let v: Value = serde_json::from_str(&out).unwrap();
    let f: credit::Funding = serde_json::from_value(v["result"]["funding"].clone()).unwrap();
    assert_eq!(json!(f.line), v["result"]["verdict"]["credit"]["line"]);
    assert!(f.line > 1_000_000 && f.line < 2_000_000_000_000, "{out}");
    for l in &f.lenders {
        assert_eq!((l.lends, l.pool), (f.line, 0), "{out}");
        assert_eq!(l.fall_bp, 3_334);
        assert_eq!(l.blended_bp, l.rate_bp);
        assert!(l.why.contains("That is the whole line."), "{}", l.why);
    }
    // The move is priced on the bitcoin Aave's part needs, the line × 1.5 ÷ 0.85, and the lender is used only if
    // the saving beats it.
    let aave = &f.lenders[0];
    let mv = aave.move_cost.as_ref().unwrap();
    assert_eq!(
        mv.cost,
        ((f.line * 15_000).div_ceil(8_500) * 56).div_ceil(10_000)
    );
    assert_eq!(mv.saves, f.line * 142 * 90 / 3_650_000);
    assert_eq!(mv.total, Some(mv.cost + ((f.line * 15_000).div_ceil(8_500) * 13).div_ceil(10_000)));
    assert_eq!(aave.used, mv.saves > mv.in_all());
    assert_eq!(f.choice, if aave.used { "aave" } else { "pool" });
    // The quotes for the move ask about $100,000 of the bitcoin, 1.25 nBTC, not all 50: the same amount each way.
    assert_eq!(v["inputs"]["lenders"]["move"]["amount"], "125000000");
    assert_eq!(v["inputs"]["lenders"]["move_back"]["amount"], "125000000");
    // Aave with $30,000.25 of USDC free lends that, and our pool the rest of the worked example's line.
    let mut dry = Mainnet::with_lenders();
    dry.aave.as_mut().unwrap()["data"]["usdc"]["borrowInfo"]["availableLiquidity"]["usd"] =
        json!("30000.25");
    let f = funding(&run(dry, WORKED).0);
    let aave = &f.lenders[0];
    assert_eq!(
        (aave.free, aave.lends, aave.pool),
        (30_000_250_000, 30_000_250_000, 64_499_750_000)
    );
    assert!(
        aave.why
            .contains("it lends $30,000 at 5.08% a year, all the USDC it has free,"),
        "{}",
        aave.why
    );
    // A lender at our pool's own rate saves nothing, so it isn't used.
    let same = Mainnet {
        rhea_borrow_apr: Some("0.065"),
        ..Mainnet::with_lenders()
    };
    let f = funding(&run(same, WORKED).0);
    assert!(!f.lenders[1].used);
    assert!(
        f.lenders[1]
            .why
            .contains("Rhea costs the same as our pool, so it isn't used"),
        "{}",
        f.lenders[1].why
    );
    // A lender that has stopped taking the bitcoin lends nothing.
    let mut shut = Mainnet::with_lenders();
    shut.aave.as_mut().unwrap()["data"]["wbtc"]["supplyInfo"]["supplyCapReached"] = json!(true);
    let f = funding(&run(shut, WORKED).0);
    assert_eq!((f.lenders[0].lends, f.lenders[0].pool), (0, 94_500_000_000));
    assert_eq!(
        f.lenders[0].why,
        "Aave isn't lending USDC against WBTC now, so our pool lends the whole $94,500."
    );
}

#[test]
fn a_lender_that_cant_be_read_is_left_out() {
    // Aave's API doesn't answer: the section holds Rhea alone, and no quote for a move is asked.
    let req = WORKED.replace(r#""snapshot":false"#, r#""snapshot":true"#);
    let (out, net) = run(Mainnet::new(), &req);
    let v: Value = serde_json::from_str(&out).unwrap();
    let f: credit::Funding = serde_json::from_value(v["result"]["funding"].clone()).unwrap();
    assert_eq!(
        f.lenders.iter().map(|l| l.l.as_str()).collect::<Vec<_>>(),
        ["rhea"]
    );
    assert_eq!(f.choice, "pool");
    assert_eq!(
        v["inputs"]["lenders"],
        json!({"aave": {"status": 0, "answer": null}, "move": null})
    );
    assert!(v["inputs"]["errors"][0]
        .as_str()
        .unwrap()
        .starts_with("Aave's terms:"));
    assert_eq!(net.count("1click"), 1);
    // An answer that isn't the two reserves counts as unread too.
    let broken = Mainnet {
        aave: Some(json!({"errors": [{"message": "Unknown field"}]})),
        ..Mainnet::new()
    };
    let f = funding(&run(broken, WORKED).0);
    assert_eq!(f.lenders.len(), 1);
}

#[test]
fn a_run_from_before_the_lender_reads_has_no_funding_section() {
    // The snapshot committed on 9 Nov: its inputs hold no lender reads, so its result is what it was.
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/credit_worked.json"
    );
    let text = std::fs::read_to_string(path).unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    assert!(v["inputs"].get("lenders").is_none());
    let inputs: pb_read::credit::CreditInputs =
        serde_json::from_value(v["inputs"].clone()).unwrap();
    assert!(inputs.lenders.is_none());
    let r = credit::compute(&inputs).unwrap();
    assert!(r.funding.is_none());
    assert!(!credit::output(&inputs).contains("funding"));
}

/// The worked example's snapshot with the lender reads, committed; `backtest credit` replays it too. To write it
/// again after a deliberate change: PB_RISK_WRITE_FUNDING_FIXTURE=1 cargo test -p pb-risk --test credit
///
/// `credit_funding_round.json` is the run as it is now, with the quotes for the move there and back.
/// `credit_funding.json` is the run saved on 11 Nov, before the way back was asked: its inputs hold the way there
/// alone, and they still give the result they gave, to the byte.
#[test]
fn the_committed_funding_snapshot_replays() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
    let path = format!("{dir}/credit_funding_round.json");
    let req = WORKED.replace(r#""snapshot":false"#, r#""snapshot":true"#);
    let (out, _) = run(Mainnet::with_lenders(), &req);
    if std::env::var("PB_RISK_WRITE_FUNDING_FIXTURE").is_ok() {
        std::fs::write(&path, out.clone() + "\n").unwrap();
    }
    let text = std::fs::read_to_string(&path).unwrap();
    // The pretend world gives the same run every time, and the saved inputs give the same result.
    assert_eq!(text.trim_end(), out);
    let v: Value = serde_json::from_str(&text).unwrap();
    let inputs: pb_read::credit::CreditInputs =
        serde_json::from_value(v["inputs"].clone()).unwrap();
    assert_eq!(credit::snapshot(&inputs), text.trim_end());
    assert_eq!(v["inputs"]["lenders"]["move_back"]["status"], 201);
    assert_eq!(v["result"]["funding"]["lenders"][0]["move"]["total"], json!(690_000_000u64));
    // The run from before the way back: the same world's reads without that quote, and the result as it was.
    let old_text = std::fs::read_to_string(format!("{dir}/credit_funding.json")).unwrap();
    let old: Value = serde_json::from_str(&old_text).unwrap();
    assert!(old["inputs"]["lenders"].get("move_back").is_none());
    let old_inputs: pb_read::credit::CreditInputs =
        serde_json::from_value(old["inputs"].clone()).unwrap();
    assert_eq!(credit::snapshot(&old_inputs), old_text.trim_end());
    assert_eq!(
        old["result"]["funding"]["lenders"][0]["move"],
        json!({"cost_bp": 56, "cost": 560_000_000u64, "saves": 198_410_958u64, "source": "1Click dry quote, no key"})
    );
    let mut without_back = inputs.clone();
    without_back.lenders.as_mut().unwrap().move_back = None;
    assert_eq!(without_back.lenders, old_inputs.lenders);
    assert_eq!(v["inputs"]["lenders"]["aave"]["status"], 200);
    assert_eq!(v["inputs"]["lenders"]["move"]["status"], 201);
    assert_eq!(
        v["result"]["funding"]["lenders"][0]["lends"],
        json!(56_666_666_666u64)
    );
    assert_eq!(v["result"]["funding"]["choice"], "pool");
    // `in` covers the lender reads: without them the hash differs.
    let mut without = inputs.clone();
    without.lenders = None;
    assert_ne!(without.hash(), inputs.hash());
}

/// A live run of 11 Nov, about 17:15 UTC (`backtest live`, read only: 22 public requests), committed: the worked
/// example against mainnet, with 1Click's real quotes for the bitcoin's way to Ethereum (0.43%) and back (0.22%).
#[test]
fn a_live_round_trip_snapshot_replays() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/credit_funding_live.json");
    let text = std::fs::read_to_string(path).unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    let inputs: pb_read::credit::CreditInputs = serde_json::from_value(v["inputs"].clone()).unwrap();
    assert_eq!(credit::snapshot(&inputs), text.trim_end());
    // Both quotes are 1Click's own answers, for the same 1.34778155 bitcoin each way.
    let lenders = &v["inputs"]["lenders"];
    assert_eq!((&lenders["move"]["status"], &lenders["move_back"]["status"]), (&json!(201), &json!(201)));
    assert_eq!(lenders["move"]["amount"], lenders["move_back"]["amount"]);
    assert_eq!(lenders["move_back"]["answer"]["quoteRequest"]["destinationAsset"], "nep141:nbtc.bridge.near");
    // $432 there and $221 back is $654, against $215 saved over 90 days: Aave isn't used.
    assert_eq!(
        v["result"]["funding"]["lenders"][0]["move"],
        json!({"cost_bp": 43, "cost": 432_480_964u64, "back_bp": 22, "back": 221_269_331u64, "back_quoted": true,
               "total": 653_750_295u64, "saves": 215_014_269u64, "source": "1Click dry quotes, no key, there and back"})
    );
    assert_eq!(v["result"]["funding"]["choice"], "pool");
}
