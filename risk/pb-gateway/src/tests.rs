//! Every mode, natively, on recorded inputs: pb-risk's committed fixtures (`pb-risk/tests/fixtures`), which are the
//! reads of its pretend world, with the gateway's own NEAR and Hyperliquid answers canned around them.
use crate::gateway::{self, Host, KEEPER};
use crate::hlsign;
use crate::keys;
use crate::nep413::{self, Auth};
use crate::store::{self, Ledger, MemStore, Sent, Store};
use pb_read::inputs::Inputs;
use pb_read::read::{Net, Reply};
use pb_read::request::Request;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const ACCOUNT: &str = "alice.pbf.testnet";
/// nep413's test key belongs to this account.
const OWNER: &str = "round-toad.testnet";
const SEED: &str = "5ee05ee05ee05ee05ee05ee05ee05ee05ee05ee05ee05ee05ee05ee05ee05ee0";
const HEIGHT: u64 = 276_621_930;

/// A recorded fixture's inputs.
fn fixture(name: &str) -> Inputs {
    let path = format!(
        "{}/../pb-risk/tests/fixtures/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    serde_json::from_value(v["inputs"].clone()).unwrap()
}

fn agent_address() -> String {
    hlsign::address(&keys::agent_key(&keys::parse_seed(SEED).unwrap(), ACCOUNT).unwrap())
}

/// The hedged demo book, its owner our test key, its agent the gateway's, and BTC's asset number 3.
fn hedged() -> Inputs {
    let mut inp = fixture("hedged");
    prepare(&mut inp);
    inp
}

fn prepare(inp: &mut Inputs) {
    inp.near.state["owner"] = json!(OWNER);
    inp.near.state["hl"]["agent"] = json!({"address": agent_address(), "received_block": 1});
    for (_, a) in inp.hl.assets.iter_mut() {
        a["index"] = json!(3);
    }
}

/// What the world answers.
struct World {
    inputs: Inputs,
    key_permission: Value,
    /// Hyperliquid's answer to an order, or None for no answer.
    exchange: Option<Value>,
    /// Its answer to a cancel, when it differs from `exchange`.
    cancel_answer: Option<Value>,
    fills: Value,
    /// Mainnet's BTC volume (USD a day), behind P10's size limit.
    mainnet_btc_volume: f64,
    clock_ms: u64,
    block_ms: u64,
    posts: Vec<(String, String)>,
}

impl World {
    fn new(inputs: Inputs) -> World {
        let clock_ms = inputs.now_ms;
        World {
            inputs,
            key_permission: json!("FullAccess"),
            exchange: Some(
                json!({"status": "ok", "response": {"type": "order", "data": {"statuses": [
                {"filled": {"totalSz": "0.08223", "avgPx": "76150", "oid": 4242}}]}}}),
            ),
            cancel_answer: None,
            fills: json!([]),
            mainnet_btc_volume: 505_524_561.0,
            clock_ms,
            block_ms: clock_ms - 2_000,
            posts: Vec::new(),
        }
    }
}

impl Net for World {
    fn get(&mut self, url: &str) -> Result<Reply, String> {
        Err(format!("unexpected GET {url}"))
    }

    fn post(&mut self, url: &str, body: &str) -> Result<Reply, String> {
        self.clock_ms += 100;
        self.posts.push((url.to_string(), body.to_string()));
        let req: Value = serde_json::from_str(body).unwrap();
        let ok = |v: Value| {
            Ok(Reply {
                status: 200,
                body: v.to_string().into_bytes(),
            })
        };
        if url.contains("fastnear") {
            if req["method"] == "block" {
                return ok(json!({"result": {"header": {"height": HEIGHT,
                    "timestamp_nanosec": (self.block_ms * 1_000_000).to_string()}}}));
            }
            let p = &req["params"];
            if p["request_type"] == "view_access_key" {
                if self.key_permission.is_null() {
                    return ok(
                        json!({"error": {"name": "HANDLER_ERROR", "cause": {"name": "UNKNOWN_ACCESS_KEY"}}}),
                    );
                }
                return ok(json!({"result": {"nonce": 1, "permission": self.key_permission}}));
            }
            assert_eq!(p["method_name"], "get_state");
            let bytes: Vec<Value> = self
                .inputs
                .near
                .state
                .to_string()
                .bytes()
                .map(Value::from)
                .collect();
            return ok(json!({"result": {"result": bytes}}));
        }
        if url.ends_with("/info") {
            return match req["type"].as_str() {
                Some("userFillsByTime") => ok(self.fills.clone()),
                Some("meta") => ok(
                    json!({"universe": [{"name": "SOL"}, {"name": "APT"}, {"name": "ATOM"}, {"name": "BTC"}]}),
                ),
                Some("metaAndAssetCtxs") if url == gateway::MAINNET_HL_INFO => ok(json!([
                    {"universe": [{"name": "BTC"}, {"name": "ETH"}]},
                    [{"dayNtlVlm": self.mainnet_btc_volume.to_string()}, {"dayNtlVlm": "1.0"}]])),
                other => Err(format!("unexpected info {other:?}")),
            };
        }
        assert_eq!(url, gateway::HL_EXCHANGE);
        if req["action"]["type"] == "cancel" {
            if let Some(v) = &self.cancel_answer {
                return ok(v.clone());
            }
        }
        match &self.exchange {
            Some(v) => ok(v.clone()),
            None => Err("timed out".into()),
        }
    }

    fn now_ms(&mut self) -> u64 {
        self.clock_ms
    }
}

struct TestHost {
    world: World,
    store: MemStore,
    env: BTreeMap<String, String>,
}

impl TestHost {
    fn new(inputs: Inputs) -> TestHost {
        let mut env = BTreeMap::new();
        env.insert("OUTLAYER_EXECUTION_TYPE".to_string(), "HTTPS".to_string());
        env.insert("NEAR_SENDER_ID".to_string(), KEEPER.to_string());
        env.insert("OUTLAYER_CALL_ID".to_string(), "call-1".to_string());
        env.insert(keys::SEED_VAR.to_string(), SEED.to_string());
        TestHost {
            world: World::new(inputs),
            store: MemStore::default(),
            env,
        }
    }
}

impl Host for TestHost {
    type N = World;
    type S = MemStore;
    fn net(&mut self) -> &mut World {
        &mut self.world
    }
    fn store(&mut self) -> &mut MemStore {
        &mut self.store
    }
    fn env(&self, name: &str) -> Option<String> {
        self.env.get(name).cloned().filter(|v| !v.is_empty())
    }
    /// The recorded reads, as if made now.
    fn read_book(&mut self, req: &Request, _extra: &BTreeSet<String>) -> Inputs {
        assert_eq!(req.account, ACCOUNT);
        self.world.inputs.clone()
    }
}

/// An order message, signed by the test key with a fresh nonce.
fn order_auth(
    host: &TestHost,
    coin: &str,
    is_buy: bool,
    sz: &str,
    px: &str,
    reduce_only: bool,
    nonce: u8,
) -> Auth {
    let expires = host.world.block_ms + 60_000;
    let message = format!(
        r#"{{"pb":"order","account":"{ACCOUNT}","order":{{"coin":"{coin}","is_buy":{is_buy},"sz":"{sz}","limit_px":"{px}","reduce_only":{reduce_only},"tif":"Ioc"}},"expires_ms":{expires}}}"#
    );
    let mut a = nep413::tests::signed(&message, nep413::RECIPIENT, [nonce; 32]);
    a.owner = OWNER.into();
    a
}

fn request(mode: &str, auth: Option<&Auth>) -> String {
    let mut v = json!({"mode": mode, "account": ACCOUNT, "network": "testnet"});
    if let Some(a) = auth {
        v["auth"] = json!({"owner": a.owner, "public_key": a.public_key, "signature": a.signature,
                           "message": a.message, "nonce": a.nonce, "recipient": a.recipient});
    }
    v.to_string()
}

fn answer(out: &str) -> Value {
    serde_json::from_str(out).unwrap()
}

/// The code of a refusal, or "ok".
fn code(out: &str) -> String {
    let v = answer(out);
    if v["ok"] == json!(true) {
        "ok".into()
    } else {
        v["code"].as_str().unwrap().to_string()
    }
}

fn place(host: &mut TestHost, auth: &Auth) -> String {
    gateway::run(&request("order", Some(auth)), host)
}

// ------------------------------------------------------------------------------------- agent_address

#[test]
fn agent_address_is_the_hkdf_agent_and_is_stable() {
    let mut host = TestHost::new(hedged());
    host.env
        .insert("OUTLAYER_EXECUTION_TYPE".into(), "NEAR".into());
    host.env
        .insert("NEAR_PREDECESSOR_ID".into(), ACCOUNT.into());
    let out = gateway::run(&request("agent_address", None), &mut host);
    let v = answer(&out);
    assert_eq!(
        v,
        json!({"ok": true, "acct": ACCOUNT, "agent": agent_address()})
    );
    assert_eq!(
        gateway::run(&request("agent_address", None), &mut host),
        out
    );
    // On chain, only the account itself may ask.
    host.env
        .insert("NEAR_PREDECESSOR_ID".into(), "bob.pbf.testnet".into());
    assert_eq!(
        code(&gateway::run(&request("agent_address", None), &mut host)),
        "AUTH"
    );
    // Over HTTPS, the keeper may ask for any client account, and gets the same address.
    host.env
        .insert("OUTLAYER_EXECUTION_TYPE".into(), "HTTPS".into());
    assert_eq!(
        gateway::run(&request("agent_address", None), &mut host),
        out
    );
    host.env
        .insert("NEAR_SENDER_ID".into(), "someone.testnet".into());
    assert_eq!(
        code(&gateway::run(&request("agent_address", None), &mut host)),
        "AUTH"
    );
    // No seed in the run: nothing to answer with.
    host.env.insert("NEAR_SENDER_ID".into(), KEEPER.into());
    host.env.remove(keys::SEED_VAR);
    assert_eq!(
        code(&gateway::run(&request("agent_address", None), &mut host)),
        "READ"
    );
    // Not a client account, or not testnet.
    let other = r#"{"mode":"agent_address","account":"alice.testnet","network":"testnet"}"#;
    assert_eq!(code(&gateway::run(other, &mut host)), "INPUT");
    let mainnet = r#"{"mode":"agent_address","account":"alice.pbf.testnet","network":"mainnet"}"#;
    assert_eq!(code(&gateway::run(mainnet, &mut host)), "INPUT");
}

// -------------------------------------------------------------------------------------------- order

/// The address a posted L1 action's signature recovers to.
fn signer_of_post(body: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap();
    let action = &v["action"];
    // Rebuild the action as the gateway typed it, and check the JSON round-trips to the same bytes.
    let o = &action["orders"][0];
    let typed = hlsign::OrderAction::one(hlsign::OrderWire {
        a: o["a"].as_u64().unwrap() as u32,
        b: o["b"].as_bool().unwrap(),
        p: o["p"].as_str().unwrap().into(),
        s: o["s"].as_str().unwrap().into(),
        r: o["r"].as_bool().unwrap(),
        t: hlsign::OrderType {
            limit: hlsign::Limit {
                tif: o["t"]["limit"]["tif"].as_str().unwrap().into(),
            },
        },
        c: o["c"].as_str().map(String::from),
    });
    assert_eq!(serde_json::to_value(&typed).unwrap(), *action);
    let nonce = v["nonce"].as_u64().unwrap();
    let digest = hlsign::agent_digest(
        &hlsign::connection_id(&hlsign::msgpack(&typed).unwrap(), nonce),
        false,
    );
    let hex32 = |s: &str| -> Vec<u8> {
        let s = s.trim_start_matches("0x");
        (0..32)
            .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap())
            .collect()
    };
    let mut rs = hex32(v["signature"]["r"].as_str().unwrap());
    rs.extend(hex32(v["signature"]["s"].as_str().unwrap()));
    let sig = k256::ecdsa::Signature::from_slice(&rs).unwrap();
    let recid =
        k256::ecdsa::RecoveryId::from_byte(v["signature"]["v"].as_u64().unwrap() as u8 - 27)
            .unwrap();
    let key = k256::ecdsa::VerifyingKey::recover_from_prehash(&digest, &sig, recid).unwrap();
    let point = key.to_sec1_point(false);
    format!(
        "0x{}",
        hlsign::hex(&hlsign::keccak(&point.as_bytes()[1..])[12..])
    )
}

#[test]
fn a_risk_reducing_order_is_signed_by_the_agent_and_posted() {
    let mut host = TestHost::new(hedged());
    // Buy back a quarter of the short, inside BTC's own 1% band.
    let auth = order_auth(&host, "BTC", true, "0.08223", "76200", false, 1);
    let out = place(&mut host, &auth);
    let v = answer(&out);
    assert_eq!(v["ok"], json!(true), "{out}");
    assert_eq!(
        (
            v["status"].as_str(),
            v["oid"].as_u64(),
            v["filled_sz"].as_str(),
            v["avg_px"].as_str()
        ),
        (Some("filled"), Some(4242), Some("0.08223"), Some("76150"))
    );
    assert_eq!(
        v["sent"],
        json!({"coin": "BTC", "is_buy": true, "sz": "0.08223", "limit_px": "76200",
                                 "reduce_only": false, "tif": "Ioc"})
    );
    let after = &v["after"];
    assert_eq!(after["state"], "HEALTHY");
    assert!(after["eq"].as_i64().unwrap() > 9_000_000_000, "{out}");
    assert!(after["im"].as_i64().unwrap() > 0 && after["hl_margin_ratio_bp"].as_u64().unwrap() > 0);
    assert!(after["line"].as_u64().unwrap() >= 24_000_004_567, "{out}");
    // The post: the SDK's body, signed by the account's agent.
    let (url, body) = host.world.posts.last().unwrap().clone();
    assert_eq!(url, "https://api.hyperliquid-testnet.xyz/exchange");
    let posted: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(posted["action"]["orders"][0]["a"], 3);
    assert_eq!(posted["vaultAddress"], Value::Null);
    assert_eq!(signer_of_post(&body), agent_address());
    // The ledger has it, and the lock is free again.
    let ledger = Ledger::load(&mut host.store, ACCOUNT).unwrap();
    assert_eq!(ledger.sent.len(), 1);
    assert_eq!(
        (ledger.sent[0].oid, ledger.sent[0].size),
        (Some(4242), 0.08223)
    );
    assert_eq!(host.store.map["lock:alice.pbf.testnet"], store::FREE);
    // The same signed message again: the nonce is used.
    assert_eq!(code(&place(&mut host, &auth)), "AUTH");
}

#[test]
fn each_check_refuses_with_its_code() {
    let cases: Vec<(&str, &str, bool, &str, &str, bool, &str)> = vec![
        // RISK_ENGINE.md 13.7: buying back the whole short leaves equity below IM and the loan above the cap.
        (
            "P8",
            "BTC",
            true,
            "0.32895",
            "76200",
            false,
            "whole buy-back",
        ),
        // A limit 5% below the reference (BTC's band is 1%, and 3% on testnet).
        (
            "P2",
            "BTC",
            false,
            "0.01",
            "72000",
            false,
            "outside the band",
        ),
        // Reduce-only, but it grows the short.
        (
            "P3",
            "BTC",
            false,
            "0.01",
            "76000",
            true,
            "reduce-only that adds",
        ),
        // TAO is next in line, not on the list.
        ("P1", "TAO", true, "1", "400", false, "off the list"),
        // Too small, or not rounded to BTC's 5 size decimals and whole-dollar prices.
        ("INPUT", "BTC", true, "0.0001", "76000", false, "under $10"),
        (
            "INPUT",
            "BTC",
            true,
            "0.000011",
            "76000",
            false,
            "6 size decimals",
        ),
        (
            "INPUT",
            "BTC",
            true,
            "0.01",
            "76000.5",
            false,
            "6 significant figures",
        ),
    ];
    for (i, (want, coin, buy, sz, px, ro, what)) in cases.into_iter().enumerate() {
        let mut host = TestHost::new(hedged());
        let auth = order_auth(&host, coin, buy, sz, px, ro, i as u8 + 10);
        let out = place(&mut host, &auth);
        assert_eq!(code(&out), want, "{what}: {out}");
        // A refusal posts nothing, and leaves the lock free.
        assert!(
            !host
                .world
                .posts
                .iter()
                .any(|(u, _)| u.ends_with("/exchange")),
            "{what}"
        );
        if host.store.map.contains_key("lock:alice.pbf.testnet") {
            assert_eq!(
                host.store.map["lock:alice.pbf.testnet"],
                store::FREE,
                "{what}"
            );
        }
    }
}

#[test]
fn on_testnet_an_order_2_percent_from_the_reference_is_placed_and_one_3_and_a_half_away_is_refused() {
    // INTERFACES.md 42: Hyperliquid testnet's mark stood up to 1.96% over its own oracle price, and an order must be
    // priced near the mark to fill, so on testnet P2's band is 3% for every coin. The reference here is $75,999.99:
    // $77,520 is 2% over it, which BTC's own 1% band refused.
    let mut host = TestHost::new(hedged());
    let auth = order_auth(&host, "BTC", true, "0.01", "77520", false, 1);
    let out = place(&mut host, &auth);
    let v = answer(&out);
    assert_eq!(v["ok"], json!(true), "{out}");
    assert_eq!(v["sent"]["limit_px"], json!("77520"), "{out}");
    let posts = exchange_posts(&host);
    assert_eq!(posts.len(), 1);
    assert_eq!(posts[0]["action"]["orders"][0]["p"], json!("77520"));
    // $78,660 is 3.5% over it: refused, in words that name the band used, and nothing is posted.
    for (px, nonce) in [("78660", 2), ("73340", 3)] {
        let mut host = TestHost::new(hedged());
        let auth = order_auth(&host, "BTC", true, "0.01", px, false, nonce);
        let out = place(&mut host, &auth);
        let v = answer(&out);
        assert_eq!(
            (v["ok"].clone(), v["code"].clone(), v["reason"].clone()),
            (
                json!(false),
                json!("P2"),
                json!("limit price more than 3% from the reference price")
            ),
            "{px}: {out}"
        );
        assert!(exchange_posts(&host).is_empty(), "{px}");
    }
}

#[test]
fn p0_one_order_at_a_time() {
    let mut host = TestHost::new(hedged());
    store::take_lock(&mut host.store, ACCOUNT, "call-0", host.world.clock_ms).unwrap();
    let auth = order_auth(&host, "BTC", true, "0.08223", "76200", false, 2);
    assert_eq!(code(&place(&mut host, &auth)), "P0");
}

#[test]
fn p0_counts_unshown_orders_as_filled() {
    // The gateway bought back most of the short a moment ago, and Hyperliquid doesn't show it yet. Counted as filled,
    // the book is nearly unhedged (WATCH), and buying back more is no longer risk-reducing.
    let mut host = TestHost::new(hedged());
    let now = host.world.clock_ms;
    let mut ledger = Ledger::default();
    ledger.sent.push(Sent {
        at_ms: now - 3_000,
        coin: "BTC".into(),
        size: 0.30,
        limit_px: 76_200.0,
        cloid: "0x0000000000000000000000000000abcd".into(),
        oid: Some(99),
        status: "filled".into(),
        reduce_only: false,
    });
    ledger.save(&mut host.store, ACCOUNT).unwrap();
    let auth = order_auth(&host, "BTC", true, "0.08223", "76200", false, 3);
    let refused = place(&mut host, &auth);
    assert_eq!(code(&refused), "P6", "{refused}");
    assert!(refused.contains("WATCH"), "{refused}");
    // Once Hyperliquid shows that fill, the order is checked on the book as read.
    let mut host = TestHost::new(hedged());
    ledger.save(&mut host.store, ACCOUNT).unwrap();
    host.world.fills = json!([{"coin": "BTC", "oid": 99, "sz": "0.30"}]);
    let auth = order_auth(&host, "BTC", true, "0.08223", "76200", false, 4);
    assert_eq!(code(&place(&mut host, &auth)), "ok");
}

#[test]
fn p0_counts_an_unused_borrow_allowance_as_spent() {
    // The account holds a live borrow verdict with $30k unused. Counted as borrowed (debt and NEAR USDC both up), the
    // loan would be above the tier cap, so a small buy-back that passes on the book as read is refused.
    let base = hedged();
    let mut with_allowance = hedged();
    with_allowance.near.state["verdict"] = json!({"intent": {"borrow": {"amount": "30000000000"}},
        "received_block": base.block.height,
        "verdict": {"ok": true, "nonce": 3, "blk": base.block.height, "state": "HEALTHY",
                    "allow": {"borrow": 30_000_000_000u64, "withdraw": 0}}});
    let fields = crate::msg::OrderFields {
        coin: "BTC".into(),
        is_buy: true,
        sz: "0.01".into(),
        limit_px: "76200".into(),
        reduce_only: false,
        tif: "Ioc".into(),
    };
    let none = json!([]);
    let without =
        gateway::check_order(&base, &fields, &Ledger::default(), &none, base.now_ms, None);
    assert!(without.is_ok());
    let with = gateway::check_order(
        &with_allowance,
        &fields,
        &Ledger::default(),
        &none,
        base.now_ms,
        None,
    );
    let r = with.err().expect("refused");
    assert_eq!(
        (r.code, r.reason.as_str()),
        ("P8", "loan above the tier cap on collateral")
    );
    // A verdict already used (its nonce behind the counter), or too old, counts for nothing.
    let mut used = with_allowance.clone();
    used.near.state["verdict"]["verdict"]["nonce"] = json!(2);
    assert!(
        gateway::check_order(&used, &fields, &Ledger::default(), &none, base.now_ms, None).is_ok()
    );
    let mut old = with_allowance;
    old.block.height += 121;
    assert!(
        gateway::check_order(&old, &fields, &Ledger::default(), &none, base.now_ms, None).is_ok()
    );
}

const USD: u64 = 1_000_000;

/// A small buy-back on the hedged book. As read, the book has room for about $400 more debt after it.
fn small_buy_back() -> crate::msg::OrderFields {
    crate::msg::OrderFields {
        coin: "BTC".into(),
        is_buy: true,
        sz: "0.01".into(),
        limit_px: "76200".into(),
        reduce_only: false,
        tif: "Ioc".into(),
    }
}

/// `inp` with a funding plan stored at its block (INTERFACES.md 25): 30 minutes to run, and these steps.
fn with_plan(inp: &Inputs, steps: Value) -> Inputs {
    let stored: u64 = inp.block.timestamp_ns.parse().unwrap();
    let mut out = inp.clone();
    out.near.state["funding"] = json!({"pid": format!("f{}", inp.block.height), "amount": "600000000",
        "stored_at": stored.to_string(), "expires_at": (stored + 1_800_000_000_000).to_string(), "steps": steps});
    out
}

fn l_borrow(usd: u64, done: bool) -> Value {
    json!({"k": "l_borrow", "l": "rhea", "amt": usd * USD, "done": done})
}

fn p_borrow(usd: u64, done: bool) -> Value {
    json!({"k": "p_borrow", "amt": usd * USD, "done": done})
}

/// The small buy-back's check on `inp`: "ok", or the refusal's code and words.
fn buy_back_on(inp: &Inputs) -> String {
    let r = gateway::check_order(
        inp,
        &small_buy_back(),
        &Ledger::default(),
        &json!([]),
        inp.now_ms,
        None,
    );
    match r {
        Ok(_) => "ok".into(),
        Err(r) => format!("{}: {}", r.code, r.reason),
    }
}

const OVER_THE_CAP: &str = "P8: loan above the tier cap on collateral";

#[test]
fn p0_counts_a_funding_plans_unfinished_borrow_steps_as_debt_about_to_arrive() {
    let base = hedged();
    assert_eq!(buy_back_on(&base), "ok");
    // A stored plan that still means to borrow $300 from our pool: counted as borrowed, the order still fits.
    assert_eq!(buy_back_on(&with_plan(&base, json!([p_borrow(300, false)]))), "ok");
    // $500 doesn't: the loan would be above the tier cap once it arrives, so the order is refused now.
    assert_eq!(buy_back_on(&with_plan(&base, json!([p_borrow(500, false)]))), OVER_THE_CAP);
    // A lender's step counts the same way, and the two add up: $300 from Rhea and $300 from our pool is $600.
    assert_eq!(buy_back_on(&with_plan(&base, json!([l_borrow(300, false)]))), "ok");
    assert_eq!(buy_back_on(&with_plan(&base, json!([l_borrow(500, false)]))), OVER_THE_CAP);
    let both = json!([
        {"k": "l_supply", "l": "rhea", "tok": "mnbtc.pbf-ops.testnet", "amt": "1000000", "done": true},
        l_borrow(300, false),
        p_borrow(300, false)
    ]);
    assert_eq!(buy_back_on(&with_plan(&base, both)), OVER_THE_CAP);
    // A step the account has started is no longer the plan's to count: only the pool's $300 is still to come.
    let started = json!([l_borrow(300, true), p_borrow(300, false)]);
    assert_eq!(buy_back_on(&with_plan(&base, started)), "ok");
    // Posting collateral is not debt.
    let posting = json!([
        {"k": "l_supply", "l": "rhea", "tok": "mnbtc.pbf-ops.testnet", "amt": "900000000", "done": false}
    ]);
    assert_eq!(buy_back_on(&with_plan(&base, posting)), "ok");
    // A finished plan counts for nothing.
    let finished = json!([l_borrow(500, true), p_borrow(500, true)]);
    assert_eq!(buy_back_on(&with_plan(&base, finished)), "ok");
    // Nor does one that has expired by the block's time. One nanosecond before, it still counts.
    let mut expired = with_plan(&base, json!([p_borrow(500, false)]));
    let now: u64 = base.block.timestamp_ns.parse().unwrap();
    expired.near.state["funding"]["expires_at"] = json!(now.to_string());
    assert_eq!(buy_back_on(&expired), "ok");
    expired.near.state["funding"]["expires_at"] = json!((now + 1).to_string());
    assert_eq!(buy_back_on(&expired), OVER_THE_CAP);
    // A plan the gateway can't read stops the order: nothing is checked on a guess.
    let mut odd = with_plan(&base, json!([{"k": "fly", "amt": 1}]));
    assert!(buy_back_on(&odd).starts_with("READ: the funding plan in the account's state"), "{}", buy_back_on(&odd));
    odd.near.state["funding"] = Value::Null;
    assert_eq!(buy_back_on(&odd), "ok");
}

#[test]
fn p0_counts_the_larger_of_a_borrow_allowance_and_the_plans_pool_step_and_adds_a_lenders() {
    // A live borrow verdict with `borrow` unused.
    let base = hedged();
    let live = |inp: &Inputs, intent: Value, borrow: u64| -> Inputs {
        let mut out = inp.clone();
        out.near.state["verdict"] = json!({"intent": intent, "received_block": base.block.height,
            "verdict": {"ok": true, "nonce": 3, "blk": base.block.height, "state": "HEALTHY",
                        "allow": {"borrow": borrow * USD, "withdraw": 0}}});
        out
    };
    let borrow = json!({"borrow": {"amount": "300000000"}});
    assert_eq!(buy_back_on(&live(&base, borrow.clone(), 300)), "ok");
    assert_eq!(buy_back_on(&live(&base, borrow.clone(), 500)), OVER_THE_CAP);
    // The plan's `p_borrow` draws on that same allowance, so $300 and $300 are $300, not $600.
    let pool_step = with_plan(&base, json!([p_borrow(300, false)]));
    assert_eq!(buy_back_on(&live(&pool_step, borrow.clone(), 300)), "ok");
    // Whichever is larger counts.
    assert_eq!(buy_back_on(&live(&pool_step, borrow.clone(), 500)), OVER_THE_CAP);
    let big_step = with_plan(&base, json!([p_borrow(500, false)]));
    assert_eq!(buy_back_on(&live(&big_step, borrow.clone(), 300)), OVER_THE_CAP);
    // A lender's loan is other money: $300 allowed by the verdict and $300 from Rhea are $600.
    let lender_step = with_plan(&base, json!([l_borrow(300, false)]));
    assert_eq!(buy_back_on(&live(&lender_step, borrow, 300)), OVER_THE_CAP);
    // A verdict that answers a check or a `fund` request is no allowance to spend: only the plan counts.
    for intent in [json!({"check": {}}), json!({"fund": {"amount": "600000000"}})] {
        assert_eq!(buy_back_on(&live(&pool_step, intent.clone(), 500)), "ok");
        assert_eq!(buy_back_on(&live(&big_step, intent, 0)), OVER_THE_CAP);
    }
}

#[test]
fn an_order_is_refused_while_the_plan_would_take_the_loan_over_the_cap_and_nothing_is_posted() {
    let mut host = TestHost::new(with_plan(&hedged(), json!([l_borrow(300, false), p_borrow(300, false)])));
    let auth = order_auth(&host, "BTC", true, "0.01", "76200", false, 40);
    let out = place(&mut host, &auth);
    assert_eq!(code(&out), "P8", "{out}");
    assert!(!host.world.posts.iter().any(|(u, _)| u.ends_with("/exchange")));
    assert_eq!(host.store.map["lock:alice.pbf.testnet"], store::FREE);
    // With the lender's step run and only the pool's $300 to come, the same order goes through.
    let mut host = TestHost::new(with_plan(&hedged(), json!([l_borrow(300, true), p_borrow(300, false)])));
    host.world.exchange = Some(json!({"status": "ok", "response": {"type": "order", "data": {"statuses": [
        {"filled": {"totalSz": "0.01", "avgPx": "76150", "oid": 4243}}]}}}));
    let auth = order_auth(&host, "BTC", true, "0.01", "76200", false, 41);
    let out = place(&mut host, &auth);
    assert_eq!(code(&out), "ok", "{out}");
}

#[test]
fn p6_only_risk_reducing_orders_outside_healthy() {
    // nBTC at 0.80 of BTC: the book is in a margin call. Small trades either way pass as risk-reducing (the book is
    // over-hedged, and a Hyperliquid liquidation dominates its requirement), but selling 0.2 BTC more adds risk.
    let mut inp = hedged();
    inp.near.drill = json!({"bp": 8000, "set_at": "1"});
    let fields = crate::msg::OrderFields {
        coin: "BTC".into(),
        is_buy: false,
        sz: "0.2".into(),
        limit_px: "76000".into(),
        reduce_only: false,
        tif: "Ioc".into(),
    };
    let r = gateway::check_order(
        &inp,
        &fields,
        &Ledger::default(),
        &json!([]),
        inp.now_ms,
        None,
    );
    let r = r.err().expect("refused");
    assert_eq!(r.code, "P6", "{r:?}");
    assert!(
        r.reason.contains("MARGIN_CALL: only risk-reducing"),
        "{r:?}"
    );
    // A small buy-back still passes, as risk-reducing.
    let small = crate::msg::OrderFields {
        is_buy: true,
        sz: "0.1".into(),
        limit_px: "76200".into(),
        ..fields
    };
    assert!(gateway::check_order(
        &inp,
        &small,
        &Ledger::default(),
        &json!([]),
        inp.now_ms,
        None
    )
    .is_ok());
}

/// The loan fixture with a Hyperliquid account of `hl_value` USDC and `usdc` of USDC on NEAR, and no nBTC.
fn cash_book(hl_value: f64, usdc: u128) -> Inputs {
    let mut inp = fixture("loan");
    let hedged = hedged();
    inp.near.state["hl"] =
        json!({"path": "hyperliquid-1", "address": "0x00000000000000000000000000000000000000bb"});
    inp.hl = hedged.hl.clone();
    inp.hl.address = Some("0x00000000000000000000000000000000000000bb".into());
    inp.hl.state =
        json!({"marginSummary": {"accountValue": hl_value.to_string()}, "assetPositions": []});
    inp.near
        .balances
        .insert("musdc.pbf-ops.testnet".into(), json!(usdc.to_string()));
    inp.near
        .balances
        .insert("mnbtc.pbf-ops.testnet".into(), json!("0"));
    prepare(&mut inp);
    inp
}

#[test]
fn p9_the_venue_ratio_bites_when_credit_does_not() {
    // $1M of USDC on NEAR and $1,000 on Hyperliquid: a $30k short is fine for credit, but its maintenance margin is
    // over half of the Hyperliquid equity.
    let inp = cash_book(1_000.0, 1_000_000_000_000);
    let fields = crate::msg::OrderFields {
        coin: "BTC".into(),
        is_buy: false,
        sz: "0.4".into(),
        limit_px: "76000".into(),
        reduce_only: false,
        tif: "Ioc".into(),
    };
    let r = gateway::check_order(
        &inp,
        &fields,
        &Ledger::default(),
        &json!([]),
        inp.now_ms,
        None,
    );
    assert_eq!(r.err().map(|r| r.code), Some("P9"));
}

#[test]
fn p7_the_client_cap() {
    // A short already near BTC's per-client cap ($77.7M): adding $1.5M passes P10's size limit but not the cap.
    let mut inp = cash_book(10_000_000.0, 1_000_000_000_000);
    inp.hl.state = json!({"marginSummary": {"accountValue": "10000000"}, "assetPositions": [{"type": "oneWay",
        "position": {"coin": "BTC", "szi": "-1015", "entryPx": "76109.44", "unrealizedPnl": "0"}}]});
    let fields = crate::msg::OrderFields {
        coin: "BTC".into(),
        is_buy: false,
        sz: "20".into(),
        limit_px: "76000".into(),
        reduce_only: false,
        tif: "Ioc".into(),
    };
    let r = gateway::check_order(
        &inp,
        &fields,
        &Ledger::default(),
        &json!([]),
        inp.now_ms,
        None,
    );
    assert_eq!(r.err().map(|r| r.code), Some("P7"));
    // And an order over 1% of BTC's daily volume ($23.7M) is P10's.
    let big = crate::msg::OrderFields {
        sz: "400".into(),
        ..fields
    };
    let r = gateway::check_order(&inp, &big, &Ledger::default(), &json!([]), inp.now_ms, None);
    assert_eq!(r.err().map(|r| r.code), Some("P10"));
}

#[test]
fn p10_rate_and_stale_prices() {
    // 60 orders in the last minute.
    let mut host = TestHost::new(hedged());
    let now = host.world.clock_ms;
    let mut ledger = Ledger::default();
    for i in 0..60 {
        ledger.sent.push(Sent {
            at_ms: now - 50_000 + i,
            coin: "BTC".into(),
            size: 0.0,
            limit_px: 76_000.0,
            cloid: format!("0x{i:032x}"),
            oid: Some(i),
            status: "resting".into(),
            reduce_only: false,
        });
    }
    ledger.save(&mut host.store, ACCOUNT).unwrap();
    let auth = order_auth(&host, "BTC", true, "0.08223", "76200", false, 5);
    assert_eq!(code(&place(&mut host, &auth)), "P10");
    // Two of the four exchanges silent: BTC's price is uncertain, so only orders that shrink the short pass.
    let mut inp = hedged();
    let btc = inp.coins.get_mut("BTC").unwrap();
    btc.tickers.remove("okx");
    btc.tickers.remove("bybit");
    btc.tickers.remove("coinbase");
    let sell = crate::msg::OrderFields {
        coin: "BTC".into(),
        is_buy: false,
        sz: "0.01".into(),
        limit_px: "76000".into(),
        reduce_only: false,
        tif: "Ioc".into(),
    };
    let r = gateway::check_order(
        &inp,
        &sell,
        &Ledger::default(),
        &json!([]),
        inp.now_ms,
        None,
    );
    assert_eq!(r.err().map(|r| r.code), Some("P10"));
    let buy = crate::msg::OrderFields {
        is_buy: true,
        sz: "0.08223".into(),
        limit_px: "76200".into(),
        ..sell
    };
    assert!(
        gateway::check_order(&inp, &buy, &Ledger::default(), &json!([]), inp.now_ms, None).is_ok()
    );
}

#[test]
fn p1_a_removed_coin_only_shrinks() {
    // On testnet the pool lists XRP as removed; with no XRP position, any XRP order is refused.
    let mut host = TestHost::new(hedged());
    let auth = order_auth(&host, "XRP", true, "10", "2.5", false, 6);
    let out = place(&mut host, &auth);
    assert_eq!(code(&out), "P1", "{out}");
}

#[test]
fn auth_refuses_the_wrong_signer_key_expiry_and_caller() {
    let fresh = || TestHost::new(hedged());
    // A changed message.
    let mut host = fresh();
    let mut auth = order_auth(&host, "BTC", true, "0.08223", "76200", false, 7);
    auth.message = auth.message.replace("0.08223", "0.08224");
    assert_eq!(code(&place(&mut host, &auth)), "AUTH");
    // Signed by someone who isn't the owner.
    let mut host = fresh();
    host.world.inputs.near.state["owner"] = json!("mallory.testnet");
    let auth = order_auth(&host, "BTC", true, "0.08223", "76200", false, 8);
    assert_eq!(code(&place(&mut host, &auth)), "AUTH");
    // A function-call key, or a key the owner doesn't have.
    let mut host = fresh();
    host.world.key_permission = json!({"FunctionCall": {"receiver_id": "x", "method_names": []}});
    let auth = order_auth(&host, "BTC", true, "0.08223", "76200", false, 9);
    assert_eq!(code(&place(&mut host, &auth)), "AUTH");
    let mut host = fresh();
    host.world.key_permission = Value::Null;
    assert_eq!(code(&place(&mut host, &auth)), "AUTH");
    // Expired, or more than testnet's 240 s ahead (INTERFACES.md 50.4): signed for 60 s, read 61 s later, or
    // 181 s earlier.
    let mut host = fresh();
    let auth = order_auth(&host, "BTC", true, "0.08223", "76200", false, 11);
    host.world.block_ms += 61_000;
    assert_eq!(code(&place(&mut host, &auth)), "AUTH");
    let mut host = fresh();
    let auth = order_auth(&host, "BTC", true, "0.08223", "76200", false, 12);
    host.world.block_ms -= 181_000;
    assert_eq!(code(&place(&mut host, &auth)), "AUTH");
    // An order run on chain instead of over HTTPS from the keeper.
    let mut host = fresh();
    host.env
        .insert("OUTLAYER_EXECUTION_TYPE".into(), "NEAR".into());
    let auth = order_auth(&host, "BTC", true, "0.08223", "76200", false, 13);
    assert_eq!(code(&place(&mut host, &auth)), "AUTH");
    // A message for another account.
    let mut host = fresh();
    let mut auth = order_auth(&host, "BTC", true, "0.08223", "76200", false, 14);
    auth.message = auth.message.replace(ACCOUNT, "bob.pbf.testnet");
    let auth = nep413::tests::signed(&auth.message, nep413::RECIPIENT, [14; 32]);
    let auth = Auth {
        owner: OWNER.into(),
        ..auth
    };
    assert_eq!(code(&place(&mut host, &auth)), "AUTH");
}

// ------------------------------------------------------------------------------------ a token's decimals

/// The hedged book with `raw` units of wNEAR beside it, wNEAR written into the account's config with `decimals`,
/// and NEAR priced at $3.3225 by every source (Hyperliquid testnet's oracle price and listing on 14 Nov).
fn hedged_with_wnear(decimals: u32, raw: u128) -> Inputs {
    const WNEAR: &str = "mwnear.pbf-ops.testnet";
    let mut inp = hedged();
    let mut near = inp.coins["BTC"].clone();
    let mid = (near.tickers["binance"].bid + near.tickers["binance"].ask) / 2.0;
    let k = 3.3225 / mid;
    for t in near.tickers.values_mut() {
        t.bid *= k;
        t.ask *= k;
    }
    for list in near.minutes.values_mut().chain(near.hours.values_mut()) {
        for c in list.iter_mut() {
            c.1 *= k;
        }
    }
    inp.coins.insert("NEAR".into(), near);
    inp.hl.assets.insert(
        "NEAR".into(),
        json!({"meta": {"szDecimals": 1, "name": "NEAR", "maxLeverage": 20, "marginTableId": 20},
            "ctx": {"funding": "0.0000125", "oraclePx": "3.3225", "markPx": "3.3199"}, "tiers": null, "index": 54}),
    );
    inp.near.config["tokens"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": WNEAR, "symbol": "wNEAR", "decimals": decimals}));
    inp.near.balances.insert(WNEAR.into(), json!(raw.to_string()));
    inp
}

#[test]
fn an_order_is_checked_on_the_true_size_of_a_24_decimals_token() {
    // INTERFACES.md 50.6: the reader divided by at most 10^22, so 346.1 wNEAR counted as 34,610 in the book an
    // order is checked on. The quarter buy-back of the hedged book, with and without the wNEAR beside it.
    let equity_after = |inp: Inputs, nonce: u8| -> i64 {
        let mut host = TestHost::new(inp);
        let auth = order_auth(&host, "BTC", true, "0.08223", "76200", false, nonce);
        let out = place(&mut host, &auth);
        let v = answer(&out);
        assert_eq!(v["ok"], json!(true), "{out}");
        v["after"]["eq"].as_i64().unwrap()
    };
    let without = equity_after(hedged(), 60);
    let with = equity_after(hedged_with_wnear(24, 346_100_000_000_000_000_000_000_000), 61);
    // $1,150 more equity (346.1 wNEAR at $3.3225). It was $115,000 more.
    let more = (with - without) as f64 / 1e6;
    assert!((more - 346.1 * 3.3225).abs() < 2.0, "{more}");
    // The same holding written with 18 or 22 decimals is the same book.
    for (decimals, raw, nonce) in [(18u32, 346_100_000_000_000_000_000u128, 62u8), (22, 3_461_000_000_000_000_000_000_000, 63)] {
        let same = equity_after(hedged_with_wnear(decimals, raw), nonce);
        assert!((same - with).abs() <= 1, "{decimals}: {same} vs {with}");
    }
    // The check itself sees the true size: the book it builds holds 346.1 wNEAR.
    let inp = hedged_with_wnear(24, 346_100_000_000_000_000_000_000_000);
    let held = pb_read::book::build(&inp).unwrap().account.near.get_or("wNEAR", 0.0);
    assert!((held - 346.1).abs() < 1e-9, "{held}");
}

// ------------------------------------------------------------------------------- a signed message's life

/// The quarter buy-back of [`a_risk_reducing_order_is_signed_by_the_agent_and_posted`], signed to expire `life_ms`
/// after the block the gateway reads.
fn order_living(host: &TestHost, life_ms: u64, nonce: u8) -> Auth {
    let expires = host.world.block_ms + life_ms;
    let message = format!(
        r#"{{"pb":"order","account":"{ACCOUNT}","order":{{"coin":"BTC","is_buy":true,"sz":"0.08223","limit_px":"76200","reduce_only":false,"tif":"Ioc"}},"expires_ms":{expires}}}"#
    );
    Auth {
        owner: OWNER.into(),
        ..nep413::tests::signed(&message, nep413::RECIPIENT, [nonce; 32])
    }
}

/// A refusal's code and words.
fn refused(out: &str) -> (String, String) {
    let v = answer(out);
    assert_eq!(v["ok"], json!(false), "{out}");
    (
        v["code"].as_str().unwrap().to_string(),
        v["reason"].as_str().unwrap().to_string(),
    )
}

const TOO_FAR_ON_TESTNET: &str =
    "the message expires more than 240 s ahead: the gateway takes at most 240 s";
const TOO_FAR_BEFORE: &str =
    "the message expires more than 120 s ahead: the gateway takes at most 120 s";
const EXPIRED: &str = "the message has expired: sign it again";
const USED: &str = "this signed message was used before: sign a new one";

#[test]
fn on_testnet_a_message_signed_230_s_ahead_is_taken_and_one_signed_241_s_ahead_is_refused() {
    // INTERFACES.md 50.4: OutLayer's testnet took up to 186 s for a run, so on testnet a message may be signed up
    // to 4 minutes ahead. 230 s is what the pages sign for.
    for (life_ms, nonce) in [(230_000, 30), (240_000, 31), (121_000, 32)] {
        let mut host = TestHost::new(hedged());
        let auth = order_living(&host, life_ms, nonce);
        let out = place(&mut host, &auth);
        assert_eq!(answer(&out)["ok"], json!(true), "{life_ms}: {out}");
        assert_eq!(exchange_posts(&host).len(), 1, "{life_ms}");
    }
    for (life_ms, nonce) in [(241_000, 33), (240_001, 34), (3_600_000, 35)] {
        let mut host = TestHost::new(hedged());
        let auth = order_living(&host, life_ms, nonce);
        let out = place(&mut host, &auth);
        assert_eq!(refused(&out), ("AUTH".to_string(), TOO_FAR_ON_TESTNET.to_string()), "{life_ms}");
        // Nothing was posted, and the message's nonce wasn't used up by the refusal.
        assert!(exchange_posts(&host).is_empty(), "{life_ms}");
        assert!(!host.store.map.keys().any(|k| k.starts_with("nonce:")), "{life_ms}");
    }
    // A cancel is a signed message too, with the same life.
    let cancel_living = |host: &TestHost, life_ms: u64, nonce: u8| {
        let expires = host.world.block_ms + life_ms;
        let message = format!(
            r#"{{"pb":"cancel","account":"{ACCOUNT}","cancel":{{"coin":"BTC","oid":123}},"expires_ms":{expires}}}"#
        );
        Auth {
            owner: OWNER.into(),
            ..nep413::tests::signed(&message, nep413::RECIPIENT, [nonce; 32])
        }
    };
    let mut host = TestHost::new(hedged());
    host.world.exchange = Some(
        json!({"status": "ok", "response": {"type": "cancel", "data": {"statuses": ["success"]}}}),
    );
    let auth = cancel_living(&host, 230_000, 36);
    let out = gateway::run(&request("cancel", Some(&auth)), &mut host);
    assert_eq!(answer(&out)["ok"], json!(true), "{out}");
    let auth = cancel_living(&host, 241_000, 37);
    let out = gateway::run(&request("cancel", Some(&auth)), &mut host);
    assert_eq!(refused(&out), ("AUTH".to_string(), TOO_FAR_ON_TESTNET.to_string()));
    // The limit is the network's own figure.
    assert_eq!(gateway::max_ahead_ms("testnet"), 240_000);
    assert_eq!(gateway::TESTNET_MAX_AHEAD_MS, 240_000);
}

#[test]
fn on_mainnet_a_message_121_s_ahead_is_still_refused_with_the_words_of_before_and_119_s_is_taken() {
    // Only testnet has the 4 minutes. Every other network keeps the 120 s and its words.
    let block_ms = 1_794_049_228_000;
    for network in ["mainnet", "", "Testnet", "testnet2"] {
        assert_eq!(gateway::max_ahead_ms(network), 120_000, "{network}");
        assert_eq!(gateway::max_ahead_ms(network), gateway::MAX_AHEAD_MS);
        for life_ms in [1, 119_000, 120_000] {
            assert!(gateway::check_life(network, block_ms + life_ms, block_ms).is_ok(), "{network} {life_ms}");
        }
        for life_ms in [120_001, 121_000, 230_000, 240_000] {
            let r = gateway::check_life(network, block_ms + life_ms, block_ms).unwrap_err();
            assert_eq!((r.code, r.reason.as_str()), ("AUTH", TOO_FAR_BEFORE), "{network} {life_ms}");
        }
    }
    // The same two lives on testnet: both taken.
    for life_ms in [119_000, 121_000] {
        assert!(gateway::check_life("testnet", block_ms + life_ms, block_ms).is_ok());
    }
    // The gateway itself still serves testnet only: a request that names mainnet is refused before any of this.
    let mut host = TestHost::new(hedged());
    let auth = order_living(&host, 119_000, 38);
    let named = request("order", Some(&auth)).replace(r#""network":"testnet""#, r#""network":"mainnet""#);
    assert_eq!(
        refused(&gateway::run(&named, &mut host)),
        ("INPUT".to_string(), r#"network "mainnet" is not served: testnet only"#.to_string())
    );
    assert!(host.world.posts.is_empty());
}

#[test]
fn a_message_used_once_is_refused_the_second_time_whatever_its_life() {
    for (life_ms, nonce) in [(60_000, 40), (119_000, 41), (230_000, 42), (240_000, 43)] {
        let mut host = TestHost::new(hedged());
        let auth = order_living(&host, life_ms, nonce);
        let out = place(&mut host, &auth);
        assert_eq!(answer(&out)["ok"], json!(true), "{life_ms}: {out}");
        // At once, and again and again while it lives: its nonce is kept, with no time after which it is forgotten.
        assert_eq!(refused(&place(&mut host, &auth)), ("AUTH".to_string(), USED.to_string()), "{life_ms}");
        let step = (life_ms - 2_000) / 4;
        for _ in 0..4 {
            host.world.clock_ms += step;
            host.world.block_ms += step;
            assert_eq!(refused(&place(&mut host, &auth)), ("AUTH".to_string(), USED.to_string()), "{life_ms}");
        }
        // Once its life is over it is refused as expired, and it stays used.
        host.world.clock_ms += 3_000;
        host.world.block_ms += 3_000;
        assert_eq!(refused(&place(&mut host, &auth)), ("AUTH".to_string(), EXPIRED.to_string()), "{life_ms}");
        assert_eq!(host.store.map.keys().filter(|k| k.starts_with("nonce:")).count(), 1);
        // One order went to Hyperliquid, not two.
        assert_eq!(exchange_posts(&host).len(), 1, "{life_ms}");
    }
}

#[test]
fn an_expired_message_is_refused() {
    // Signed to expire at the block's own time, or before it.
    for (behind_ms, nonce) in [(0u64, 50), (1, 51), (60_000, 52)] {
        let mut host = TestHost::new(hedged());
        let auth = order_living(&host, 0, nonce);
        host.world.block_ms += behind_ms;
        let out = place(&mut host, &auth);
        assert_eq!(refused(&out), ("AUTH".to_string(), EXPIRED.to_string()), "{behind_ms}");
        assert!(exchange_posts(&host).is_empty());
        assert!(!host.store.map.keys().any(|k| k.starts_with("nonce:")));
    }
    // A message signed 230 s ahead that reaches the gateway 231 s later: expired, though never used.
    let mut host = TestHost::new(hedged());
    let auth = order_living(&host, 230_000, 53);
    host.world.clock_ms += 231_000;
    host.world.block_ms += 231_000;
    assert_eq!(refused(&place(&mut host, &auth)), ("AUTH".to_string(), EXPIRED.to_string()));
    assert!(exchange_posts(&host).is_empty());
    // One millisecond before its end it is still taken.
    let mut host = TestHost::new(hedged());
    let auth = order_living(&host, 230_000, 54);
    host.world.block_ms += 229_999;
    let out = place(&mut host, &auth);
    assert_eq!(answer(&out)["ok"], json!(true), "{out}");
    // On every network alike.
    for network in ["testnet", "mainnet"] {
        for expires_ms in [0, 999, 1_000] {
            let r = gateway::check_life(network, expires_ms, 1_000).unwrap_err();
            assert_eq!((r.code, r.reason.as_str()), ("AUTH", EXPIRED), "{network} {expires_ms}");
        }
        assert!(gateway::check_life(network, 1_001, 1_000).is_ok());
    }
}

#[test]
fn hl_refusals_and_silence() {
    // Hyperliquid refuses: HL, and nothing counts as placed.
    let mut host = TestHost::new(hedged());
    host.world.exchange = Some(
        json!({"status": "ok", "response": {"type": "order", "data": {"statuses": [
        {"error": "Order could not immediately match against any resting orders. asset=3"}]}}}),
    );
    let auth = order_auth(&host, "BTC", true, "0.08223", "76200", false, 15);
    let out = place(&mut host, &auth);
    assert_eq!(code(&out), "HL", "{out}");
    assert!(answer(&out)["reason"]
        .as_str()
        .unwrap()
        .contains("could not immediately match"));
    assert!(Ledger::load(&mut host.store, ACCOUNT)
        .unwrap()
        .sent
        .is_empty());
    assert_eq!(host.store.map["lock:alice.pbf.testnet"], store::FREE);
    // No answer: HL, and the order counts as possibly filled for 10 s.
    let mut host = TestHost::new(hedged());
    host.world.exchange = None;
    let auth = order_auth(&host, "BTC", true, "0.08223", "76200", false, 16);
    assert_eq!(code(&place(&mut host, &auth)), "HL");
    let ledger = Ledger::load(&mut host.store, ACCOUNT).unwrap();
    assert_eq!(ledger.sent.len(), 1);
    assert_eq!(ledger.sent[0].status, "unknown");
    assert_eq!(host.store.map["lock:alice.pbf.testnet"], store::FREE);
}

#[test]
fn malformed_requests_are_input() {
    let mut host = TestHost::new(hedged());
    for bad in [
        "not json",
        r#"{"mode":"order","account":"alice.pbf.testnet","network":"testnet"}"#,
        r#"{"mode":"fly","account":"alice.pbf.testnet","network":"testnet"}"#,
        r#"{"mode":"order","account":"alice.pbf.testnet","network":"testnet","extra":1}"#,
    ] {
        assert_eq!(code(&gateway::run(bad, &mut host)), "INPUT", "{bad}");
    }
    // A message that isn't the canonical compact JSON.
    let auth = order_auth(&host, "BTC", true, "0.08223", "76200", false, 17);
    let spaced = nep413::tests::signed(
        &auth.message.replace(",\"order\"", ", \"order\""),
        nep413::RECIPIENT,
        [17; 32],
    );
    let spaced = Auth {
        owner: OWNER.into(),
        ..spaced
    };
    assert_eq!(code(&place(&mut host, &spaced)), "INPUT");
}

// ------------------------------------------------------------------------------------------- cancel

fn cancel_auth(host: &TestHost, oid: u64, nonce: u8) -> Auth {
    let expires = host.world.block_ms + 60_000;
    let message = format!(
        r#"{{"pb":"cancel","account":"{ACCOUNT}","cancel":{{"coin":"BTC","oid":{oid}}},"expires_ms":{expires}}}"#
    );
    Auth {
        owner: OWNER.into(),
        ..nep413::tests::signed(&message, nep413::RECIPIENT, [nonce; 32])
    }
}

#[test]
fn a_cancel_is_signed_and_clears_the_ledger() {
    let mut host = TestHost::new(hedged());
    let mut ledger = Ledger::default();
    ledger.sent.push(Sent {
        at_ms: host.world.clock_ms - 1_000,
        coin: "BTC".into(),
        size: -0.01,
        limit_px: 76_500.0,
        cloid: "0x01".into(),
        oid: Some(123),
        status: "resting".into(),
        reduce_only: false,
    });
    ledger.save(&mut host.store, ACCOUNT).unwrap();
    host.world.exchange = Some(
        json!({"status": "ok", "response": {"type": "cancel", "data": {"statuses": ["success"]}}}),
    );
    let auth = cancel_auth(&host, 123, 20);
    let out = gateway::run(&request("cancel", Some(&auth)), &mut host);
    let v = answer(&out);
    assert_eq!(
        (v["ok"].clone(), v["acct"].clone()),
        (json!(true), json!(ACCOUNT)),
        "{out}"
    );
    let body = &host.world.posts.last().unwrap().1;
    let posted: Value = serde_json::from_str(body).unwrap();
    assert_eq!(
        posted["action"],
        json!({"type": "cancel", "cancels": [{"a": 3, "o": 123}]})
    );
    assert!(Ledger::load(&mut host.store, ACCOUNT)
        .unwrap()
        .sent
        .is_empty());
    // Hyperliquid's refusal is HL.
    host.world.exchange = Some(
        json!({"status": "ok", "response": {"type": "cancel", "data": {"statuses": [
        {"error": "Order was never placed, already canceled, or filled."}]}}}),
    );
    let auth = cancel_auth(&host, 124, 21);
    assert_eq!(
        code(&gateway::run(&request("cancel", Some(&auth)), &mut host)),
        "HL"
    );
}

// ------------------------------------------------------------------------------------- set_leverage

#[test]
fn set_leverage_keeps_p8_and_p9_at_full_use() {
    let inp = hedged();
    let b = pb_read::book::build(&inp).unwrap();
    let lev = gateway::leverage_for(&b.engine, &b.account, &b.built.market, "BTC");
    // The hedged book's $9.5k on Hyperliquid can't carry much more than its own hedge without breaking P8.
    let lev = lev.unwrap_or(1);
    assert!((1..=40).contains(&lev), "{lev}");
    let mut host = TestHost::new(inp);
    host.world.exchange = Some(json!({"status": "ok", "response": {"type": "default"}}));
    let out = gateway::run(&request("set_leverage", None), &mut host);
    let v = answer(&out);
    assert_eq!(v["set"]["BTC"], json!(lev), "{out}");
    let posted: Value = serde_json::from_str(&host.world.posts.last().unwrap().1).unwrap();
    assert_eq!(
        posted["action"],
        json!({"type": "updateLeverage", "asset": 3, "isCross": true, "leverage": lev})
    );
    // With no loan it sets nothing.
    let mut free = cash_book(1_000.0, 1_000_000);
    free.near.borrower["debt"] = json!("0");
    let mut host = TestHost::new(free);
    let out = gateway::run(&request("set_leverage", None), &mut host);
    assert_eq!(answer(&out)["set"], json!({}), "{out}");
}

#[test]
fn the_manifest_names_the_secret_row() {
    let m: Value = serde_json::from_str(crate::MANIFEST_JSON).unwrap();
    assert_eq!(
        m["author_secrets"],
        json!({"owner": KEEPER, "profile": "gateway"})
    );
    assert_eq!(m["callers"], json!({"direct": "deny"}));
}

#[test]
fn storage_is_used_as_the_interface_says() {
    // The keys the gateway writes: lock:<A>, nonce:<base64>, recent:<A>.
    let mut host = TestHost::new(hedged());
    let auth = order_auth(&host, "BTC", true, "0.08223", "76200", false, 30);
    assert_eq!(code(&place(&mut host, &auth)), "ok");
    let keys: Vec<&String> = host.store.map.keys().collect();
    assert_eq!(
        keys,
        vec![
            "lock:alice.pbf.testnet",
            &format!("nonce:{}", auth.nonce),
            "recent:alice.pbf.testnet"
        ]
    );
    assert!(host.store.get("nonce:x").unwrap().is_none());
}

#[test]
fn p10_takes_the_volume_from_mainnet_on_testnet() {
    // 1% of mainnet's daily volume: with $1M a day the limit is $10k, so a $15k buy-back is refused even though it
    // would pass on the parameter file's 30-day average.
    let inp = hedged();
    let fields = crate::msg::OrderFields {
        coin: "BTC".into(),
        is_buy: true,
        sz: "0.2".into(),
        limit_px: "76200".into(),
        reduce_only: false,
        tif: "Ioc".into(),
    };
    let none = json!([]);
    let thin = gateway::check_order(
        &inp,
        &fields,
        &Ledger::default(),
        &none,
        inp.now_ms,
        Some(1_000_000.0),
    );
    let r = thin.err().expect("refused");
    assert_eq!(
        (r.code, r.reason.contains("1% of the coin's daily")),
        ("P10", true)
    );
    assert!(
        gateway::check_order(&inp, &fields, &Ledger::default(), &none, inp.now_ms, None).is_ok()
    );
    // Through the whole order run: the volume read from mainnet decides.
    let mut host = TestHost::new(hedged());
    host.world.mainnet_btc_volume = 1_000_000.0;
    let auth = order_auth(&host, "BTC", true, "0.2", "76200", false, 40);
    assert_eq!(code(&place(&mut host, &auth)), "P10");
    assert!(host
        .world
        .posts
        .iter()
        .any(|(u, _)| u == gateway::MAINNET_HL_INFO));
    // At today's mainnet volume ($505M, a limit of $5M) the demo's $25k short is far inside it.
    let mut host = TestHost::new(hedged());
    let auth = order_auth(&host, "BTC", true, "0.08223", "76200", false, 41);
    assert_eq!(code(&place(&mut host, &auth)), "ok");
}

// --------------------------------------------------------------------------------- deleverage, cancel_risky

/// The testnet demo book at nBTC/BTC 0.75 (pb-risk's `drill` fixture), holding the plan its verdict made: repay the
/// 10 mUSDC, then buy back a quarter of the short. Stored when the verdict was read, as the account stores it.
fn drill() -> (Inputs, Value) {
    let path = format!(
        "{}/../pb-risk/tests/fixtures/drill.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let snap: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut inp: Inputs = serde_json::from_value(snap["inputs"].clone()).unwrap();
    prepare(&mut inp);
    let verdict = snap["verdict"].clone();
    let steps: Vec<Value> = verdict["plan"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let mut s = s.clone();
            s["done"] = json!(false);
            s
        })
        .collect();
    inp.near.state["plan"] = json!({"pid": verdict["blk"].to_string(), "action": "DELEVERAGE",
        "stored_at": inp.block.timestamp_ns, "steps": steps});
    (inp, verdict)
}

fn filled(sz: &str) -> Value {
    json!({"status": "ok", "response": {"type": "order", "data": {"statuses": [
        {"filled": {"totalSz": sz, "avgPx": "76190", "oid": 5151}}]}}})
}

fn exchange_posts(host: &TestHost) -> Vec<Value> {
    host.world
        .posts
        .iter()
        .filter(|(u, _)| u.ends_with("/exchange"))
        .map(|(_, b)| serde_json::from_str(b).unwrap())
        .collect()
}

#[test]
fn deleverage_places_the_stored_perp_step_once() {
    let (inp, verdict) = drill();
    let pid = verdict["blk"].to_string();
    let mut host = TestHost::new(inp);
    host.world.exchange = Some(filled("0.00375"));
    let out = gateway::run(&request("deleverage", None), &mut host);
    let v = answer(&out);
    assert_eq!(
        v,
        json!({"ok": true, "acct": ACCOUNT, "pid": pid,
            "placed": [{"i": 1, "k": "perp", "status": "filled", "oid": 5151, "filled_sz": "0.00375", "avg_px": "76190"}],
            "skipped": [{"i": 0, "k": "repay", "why": "execute_step runs it"}]}),
        "{out}"
    );
    // The order: reduce-only IOC at the plan's price, with the plan's cloid, signed by the account's agent.
    let posts = exchange_posts(&host);
    assert_eq!(posts.len(), 1);
    let o = &posts[0]["action"]["orders"][0];
    assert_eq!(
        (
            o["a"].clone(),
            o["b"].clone(),
            o["p"].clone(),
            o["s"].clone(),
            o["r"].clone()
        ),
        (
            json!(3),
            json!(true),
            verdict["plan"][1]["px"].clone(),
            json!("0.00375"),
            json!(true)
        )
    );
    assert_eq!(o["t"], json!({"limit": {"tif": "Ioc"}}));
    assert_eq!(o["c"], json!(gateway::plan_cloid(ACCOUNT, &pid, 1)));
    assert_eq!(
        signer_of_post(&host.world.posts.last().unwrap().1),
        agent_address()
    );
    // Recorded under step:<A>:<pid>:<i>; the lock is free; the ledger counts the order for P0 and P10.
    let key = gateway::step_key(ACCOUNT, &pid, 1);
    let rec: gateway::StepRecord = serde_json::from_slice(&host.store.map[&key]).unwrap();
    assert_eq!((rec.status.as_str(), rec.oid), ("filled", Some(5151)));
    assert_eq!(host.store.map["lock:alice.pbf.testnet"], store::FREE);
    assert_eq!(
        Ledger::load(&mut host.store, ACCOUNT).unwrap().sent[0].size,
        0.00375
    );
    // Run again: nothing is sent twice.
    let again = answer(&gateway::run(&request("deleverage", None), &mut host));
    assert_eq!(again["placed"], json!([]));
    assert_eq!(
        again["skipped"][1],
        json!({"i": 1, "k": "perp", "why": "ran before: filled"})
    );
    assert_eq!(exchange_posts(&host).len(), 1);
}

#[test]
fn deleverage_refuses_a_step_the_market_has_moved_past() {
    // P2: the plan's price has left BTC's band, which is 3% on testnet (INTERFACES.md 42). The words name the
    // band that was used. $78,660 is 3.5% over the reference.
    for px in ["80000", "78660"] {
        let (mut inp, _) = drill();
        inp.near.state["plan"]["steps"][1]["px"] = json!(px);
        let mut host = TestHost::new(inp);
        let v = answer(&gateway::run(&request("deleverage", None), &mut host));
        assert_eq!(
            (v["ok"].clone(), v["refused"][0]["code"].clone()),
            (json!(true), json!("P2")),
            "{v}"
        );
        assert_eq!(
            v["refused"][0],
            json!({"i": 1, "k": "perp", "code": "P2",
                "reason": format!("px {px} has left BTC's 3% band around 75999.99: ask for a new verdict")})
        );
        assert!(exchange_posts(&host).is_empty());
    }
    // P3: a step that would add to the short instead of buying it back.
    let (mut inp, _) = drill();
    inp.near.state["plan"]["steps"][1]["buy"] = json!(false);
    inp.near.state["plan"]["steps"][1]["px"] = json!("75700");
    let mut host = TestHost::new(inp);
    let v = answer(&gateway::run(&request("deleverage", None), &mut host));
    assert_eq!(v["refused"][0]["code"], json!("P3"), "{v}");
    assert!(exchange_posts(&host).is_empty());
    // A size not in Hyperliquid's form is INPUT.
    let (mut inp, _) = drill();
    inp.near.state["plan"]["steps"][1]["sz"] = json!("0.003751");
    let mut host = TestHost::new(inp);
    let v = answer(&gateway::run(&request("deleverage", None), &mut host));
    assert_eq!(v["refused"][0]["code"], json!("INPUT"), "{v}");
}

#[test]
fn on_testnet_deleverage_places_a_stored_perp_step_priced_2_percent_from_the_reference() {
    // The plan's buy-back at $77,520, 2% over the $75,999.99 reference: outside BTC's own 1% band, inside testnet's
    // 3% (INTERFACES.md 42). The engine prices its steps 1.5% from the reference on testnet, so the reference can
    // move 1.5% between the verdict and the gateway's run before the step is refused.
    let (mut inp, verdict) = drill();
    inp.near.state["plan"]["steps"][1]["px"] = json!("77520");
    let mut host = TestHost::new(inp);
    host.world.exchange = Some(filled("0.00375"));
    let v = answer(&gateway::run(&request("deleverage", None), &mut host));
    assert_eq!(
        v,
        json!({"ok": true, "acct": ACCOUNT, "pid": verdict["blk"].to_string(),
            "placed": [{"i": 1, "k": "perp", "status": "filled", "oid": 5151, "filled_sz": "0.00375", "avg_px": "76190"}],
            "skipped": [{"i": 0, "k": "repay", "why": "execute_step runs it"}]}),
        "{v}"
    );
    let posts = exchange_posts(&host);
    assert_eq!(posts.len(), 1);
    let o = &posts[0]["action"]["orders"][0];
    assert_eq!(
        (o["b"].clone(), o["p"].clone(), o["s"].clone(), o["r"].clone()),
        (json!(true), json!("77520"), json!("0.00375"), json!(true))
    );
}

#[test]
fn deleverage_tries_again_only_what_hyperliquid_refused() {
    let (inp, verdict) = drill();
    let pid = verdict["blk"].to_string();
    let mut host = TestHost::new(inp.clone());
    // No liquidity: Hyperliquid refuses the IOC. Nothing was placed, so a later run may try again.
    host.world.exchange = Some(
        json!({"status": "ok", "response": {"type": "order", "data": {"statuses": [
        {"error": "Order could not immediately match against any resting orders. asset=3"}]}}}),
    );
    let v = answer(&gateway::run(&request("deleverage", None), &mut host));
    assert_eq!(v["refused"][0]["code"], json!("HL"), "{v}");
    host.world.exchange = Some(filled("0.002"));
    let v = answer(&gateway::run(&request("deleverage", None), &mut host));
    assert_eq!(v["placed"][0]["status"], json!("partial"), "{v}");
    assert_eq!(exchange_posts(&host).len(), 2);
    // No answer at all: it may have gone, so it never goes again.
    let mut host = TestHost::new(inp);
    host.world.exchange = None;
    let v = answer(&gateway::run(&request("deleverage", None), &mut host));
    assert_eq!(v["placed"][0]["status"], json!("unknown"), "{v}");
    host.world.exchange = Some(filled("0.00375"));
    let v = answer(&gateway::run(&request("deleverage", None), &mut host));
    assert_eq!(v["skipped"][1]["why"], json!("ran before: unknown"), "{v}");
    assert_eq!(exchange_posts(&host).len(), 1);
    // A run that stopped while sending: never sent again either.
    let (inp, _) = drill();
    let mut host = TestHost::new(inp);
    let key = gateway::step_key(ACCOUNT, &pid, 1);
    let sending = json!({"status": "sending", "at_ms": host.world.clock_ms - 120_000});
    host.store
        .set(&key, sending.to_string().as_bytes())
        .unwrap();
    let v = answer(&gateway::run(&request("deleverage", None), &mut host));
    assert!(
        v["skipped"][1]["why"]
            .as_str()
            .unwrap()
            .contains("may have gone"),
        "{v}"
    );
}

#[test]
fn deleverage_needs_a_fresh_stored_plan_and_the_keeper() {
    let refused = |inp: Inputs| {
        code(&gateway::run(
            &request("deleverage", None),
            &mut TestHost::new(inp),
        ))
    };
    let (mut inp, _) = drill();
    inp.near.state["plan"] = Value::Null;
    assert_eq!(refused(inp), "INPUT");
    let (mut inp, _) = drill();
    let stored: u64 = inp.block.timestamp_ns.parse().unwrap();
    inp.near.state["plan"]["stored_at"] =
        json!((stored - gateway::PLAN_MAX_AGE_NS - 1).to_string());
    assert_eq!(refused(inp), "INPUT");
    let (inp, _) = drill();
    let mut host = TestHost::new(inp.clone());
    host.env
        .insert("NEAR_SENDER_ID".into(), "mallory.testnet".into());
    assert_eq!(
        code(&gateway::run(&request("deleverage", None), &mut host)),
        "AUTH"
    );
    let mut host = TestHost::new(inp.clone());
    store::take_lock(&mut host.store, ACCOUNT, "call-0", host.world.clock_ms).unwrap();
    assert_eq!(
        code(&gateway::run(&request("deleverage", None), &mut host)),
        "P0"
    );
    let mut host = TestHost::new(inp);
    let auth = order_auth(&host, "BTC", true, "0.00375", "76379", true, 50);
    assert_eq!(
        code(&gateway::run(
            &request("deleverage", Some(&auth)),
            &mut host
        )),
        "INPUT"
    );
}

/// Resting BTC orders on the drill book's 0.015 short: a sell that adds to it (11), a buy that closes part of it
/// (12) and a reduce-only buy (13).
fn resting() -> Value {
    json!([
        {"coin": "BTC", "side": "A", "limitPx": "80000", "sz": "0.002", "oid": 11, "reduceOnly": false},
        {"coin": "BTC", "side": "B", "limitPx": "70000", "sz": "0.002", "oid": 12, "reduceOnly": false},
        {"coin": "BTC", "side": "B", "limitPx": "71000", "sz": "0.01", "oid": 13, "reduceOnly": true}])
}

#[test]
fn deleverage_cancels_the_orders_that_add_risk_first() {
    let (mut inp, _) = drill();
    inp.hl.orders = resting();
    let mut steps = inp.near.state["plan"]["steps"].as_array().unwrap().clone();
    steps.insert(0, json!({"k": "cancel", "done": false}));
    inp.near.state["plan"]["steps"] = Value::Array(steps);
    let mut host = TestHost::new(inp);
    host.world.cancel_answer = Some(
        json!({"status": "ok", "response": {"type": "cancel", "data": {"statuses": ["success"]}}}),
    );
    host.world.exchange = Some(filled("0.00375"));
    let v = answer(&gateway::run(&request("deleverage", None), &mut host));
    assert_eq!(
        v["placed"][0],
        json!({"i": 0, "k": "cancel", "status": "done", "cancelled": [11]}),
        "{v}"
    );
    assert_eq!(v["placed"][1]["k"], json!("perp"));
    let posts = exchange_posts(&host);
    assert_eq!(
        posts[0]["action"],
        json!({"type": "cancel", "cancels": [{"a": 3, "o": 11}]})
    );
    assert_eq!(posts.len(), 2);
}

#[test]
fn cancel_risky_cancels_only_what_adds_risk_once_the_account_leaves_healthy() {
    let (mut inp, _) = drill();
    inp.hl.orders = resting();
    inp.near.state["plan"] = Value::Null;
    inp.near.state["verdict"] = json!({"intent": {"check": {}}, "received_block": 1,
        "verdict": {"ok": true, "state": "WATCH", "nonce": 2}});
    let mut host = TestHost::new(inp.clone());
    host.world.cancel_answer = Some(
        json!({"status": "ok", "response": {"type": "cancel", "data": {"statuses": ["success"]}}}),
    );
    let out = gateway::run(&request("cancel_risky", None), &mut host);
    let v = answer(&out);
    assert_eq!(v["cancelled"], json!([{"coin": "BTC", "oid": 11}]), "{out}");
    assert_eq!(
        exchange_posts(&host)[0]["action"],
        json!({"type": "cancel", "cancels": [{"a": 3, "o": 11}]})
    );
    assert_eq!(
        signer_of_cancel(&host.world.posts.last().unwrap().1),
        agent_address()
    );
    // A HEALTHY account keeps its orders.
    let mut healthy = inp;
    healthy.near.state["verdict"]["verdict"]["state"] = json!("HEALTHY");
    let mut host = TestHost::new(healthy);
    assert_eq!(
        code(&gateway::run(&request("cancel_risky", None), &mut host)),
        "INPUT"
    );
    assert!(exchange_posts(&host).is_empty());
}

/// The address a posted cancel's signature recovers to.
fn signer_of_cancel(body: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap();
    let cancels: Vec<hlsign::CancelWire> = v["action"]["cancels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| hlsign::CancelWire {
            a: c["a"].as_u64().unwrap() as u32,
            o: c["o"].as_u64().unwrap(),
        })
        .collect();
    let action = hlsign::CancelAction {
        kind: "cancel",
        cancels,
    };
    let digest = hlsign::agent_digest(
        &hlsign::connection_id(
            &hlsign::msgpack(&action).unwrap(),
            v["nonce"].as_u64().unwrap(),
        ),
        false,
    );
    let hex32 = |s: &str| -> Vec<u8> {
        let s = s.trim_start_matches("0x");
        (0..32)
            .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap())
            .collect()
    };
    let mut rs = hex32(v["signature"]["r"].as_str().unwrap());
    rs.extend(hex32(v["signature"]["s"].as_str().unwrap()));
    let sig = k256::ecdsa::Signature::from_slice(&rs).unwrap();
    let recid =
        k256::ecdsa::RecoveryId::from_byte(v["signature"]["v"].as_u64().unwrap() as u8 - 27)
            .unwrap();
    let key = k256::ecdsa::VerifyingKey::recover_from_prehash(&digest, &sig, recid).unwrap();
    let point = key.to_sec1_point(false);
    format!(
        "0x{}",
        hlsign::hex(&hlsign::keccak(&point.as_bytes()[1..])[12..])
    )
}

// ---------------------------------------------------------------------------------- an account with a lender

/// The hedged book as an account whose config names our copy of Rhea, with the position the copy showed in the
/// sandbox when its bitcoin price was $75,000 (pb-read's `fixtures/sandbox`): 1 nBTC posted, 40,000 USDC owed.
fn hedged_at_rhea() -> Inputs {
    let path = format!(
        "{}/../pb-read/tests/fixtures/sandbox/rhea_copy_views.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let views = &saved["before"]["views"];
    let mut inp = hedged();
    inp.near.config["lenders"] = json!({"rhea": {"contract_id": saved["contract_id"],
        "collateral": ["mnbtc.pbf-ops.testnet"]}});
    inp.near.state["permission"] =
        json!({"lenders": ["rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "off"});
    inp.lenders.rhea = Some(pb_read::inputs::RheaReads {
        contract_id: saved["contract_id"].as_str().unwrap().to_string(),
        account: views["get_account"].clone(),
        assets: views["get_assets"].clone(),
        prices: ["musdc.pbf-ops.testnet", "mnbtc.pbf-ops.testnet"]
            .into_iter()
            .map(|id| (id.to_string(), views["get_token_pyth_info"][id].clone()))
            .collect(),
    });
    inp
}

#[test]
fn an_order_is_checked_on_the_whole_debt_and_on_a_lender_borrow_from_the_plan_until_it_lands() {
    // The lender's loan is in the book the order is checked on: our pool's $24,000 and Rhea's $40,000.
    let base = hedged_at_rhea();
    let checked = gateway::check_order(
        &base,
        &small_buy_back(),
        &Ledger::default(),
        &json!([]),
        base.now_ms,
        None,
    );
    let book = checked.expect("the order fits").book;
    assert_eq!(book.debt_micro, 24_000_004_567);
    assert_eq!(book.account.debt, (24_000_004_567u128 + 40_000_000_002) as f64 / 1e6);
    // With a bitcoin posted at Rhea, the book could carry about $43,000 more before the small buy-back is refused.
    let planned = |usd: u64| with_plan(&base, json!([l_borrow(usd, false)]));
    assert_eq!(buy_back_on(&planned(40_000)), "ok");
    assert_eq!(buy_back_on(&planned(46_000)), OVER_THE_CAP);
    // The account starts the step: the plan no longer counts it, and the account lists the borrow for some blocks
    // (`pending`, INTERFACES.md 25). The book counts it from there, so the order is refused all the way through.
    let sent = |usd: u64, until: u64| {
        let mut out = with_plan(&base, json!([l_borrow(usd, true)]));
        out.near.state["pending"] = json!([{"lender": {"lender": "rhea", "kind": "borrow",
            "amount": (usd * USD).to_string(), "until_block": until}}]);
        out
    };
    let height = base.block.height;
    assert_eq!(buy_back_on(&sent(40_000, height + 20)), "ok");
    assert_eq!(buy_back_on(&sent(46_000, height + 20)), OVER_THE_CAP);
    assert_eq!(buy_back_on(&sent(46_000, height)), OVER_THE_CAP);
    // After the entry's block, Rhea's own figure is the one that counts (here it never grew: the order fits).
    assert_eq!(buy_back_on(&sent(46_000, height - 1)), "ok");
    // A borrow under way and another still planned add up.
    let mut two = with_plan(&base, json!([l_borrow(23_000, false)]));
    two.near.state["pending"] = json!([{"lender": {"lender": "rhea", "kind": "borrow",
        "amount": (23_000 * USD).to_string(), "until_block": height + 20}}]);
    assert_eq!(buy_back_on(&two), OVER_THE_CAP);
    two.near.state["funding"] = Value::Null;
    assert_eq!(buy_back_on(&two), "ok");
}

const EVM_USDC: &str = "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f";
const WBTC: &str = "0x54114591963cf60ef3aa63befd6ec263d98145a4";

/// The hedged book as an account whose config names Aave on Base Sepolia, with 1 WBTC posted there (Aave's oracle
/// has it at $76,000) against 40,000 USDC, and the chain's count of its transactions at `chain_nonce`. The market's
/// answers are the ones recorded on Base Sepolia (pb-read's `fixtures/base_sepolia`); the address's are written in
/// Aave's layouts.
fn hedged_at_aave(chain_nonce: u64) -> Inputs {
    let recorded = |file: &str, call: &str| -> String {
        let path = format!("{}/../pb-read/tests/fixtures/base_sepolia/{file}.json", env!("CARGO_MANIFEST_DIR"));
        let rec: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        rec["calls"][call]["reply"]["result"].as_str().unwrap().to_string()
    };
    let words = |w: &[u128]| format!("0x{}", w.iter().map(|x| format!("{x:064x}")).collect::<String>());
    let mut inp = hedged();
    let address = inp.hl.address.clone().expect("the hedged account has a Hyperliquid address");
    inp.near.config["lenders"] = json!({"aave": {"chain_id": 84532, "pool": "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
        "usdc": {"symbol": "USDC", "address": "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", "decimals": 6},
        "collateral": [{"symbol": "WBTC", "address": "0x54114591963CF60EF3aA63bEfD6eC263D98145a4", "decimals": 8}],
        "max_fee_per_gas": "1000000000"}});
    inp.near.state["permission"] =
        json!({"lenders": ["aave"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "off"});
    let calls = [
        ("reserve".to_string(), recorded("aave_position", "getReserveData_usdc")),
        ("free".to_string(), recorded("aave_position", "getVirtualUnderlyingBalance_usdc")),
        (format!("config:{WBTC}"), recorded("aave_position", "getReserveConfigurationData_wbtc")),
        (format!("price:{WBTC}"), words(&[7_600_000_000_000])),
        (format!("caps:{WBTC}"), recorded("aave_caps", "getReserveCaps_wbtc")),
        (format!("supplied:{WBTC}"), recorded("aave_caps", "getATokenTotalSupply_wbtc")),
        // $76,000 of collateral, $40,000 of debt, a threshold of 83% and a health factor of 1.577.
        ("account".to_string(), words(&[7_600_000_000_000, 4_000_000_000_000, 0, 8_300, 8_150, 1_577_000_000_000_000_000])),
        ("debt".to_string(), words(&[0, 0, 40_000_000_000, 0, 0, 0, 0, 0, 0])),
        (format!("posted:{WBTC}"), words(&[100_000_000, 0, 0, 0, 0, 0, 0, 0, 1])),
        (format!("balance:{WBTC}"), words(&[0])),
        (format!("balance:{EVM_USDC}"), words(&[0])),
        ("nonce".to_string(), format!("0x{chain_nonce:x}")),
    ];
    inp.lenders.aave = Some(pb_read::inputs::AaveReads {
        chain_id: 84532,
        address: Some(address),
        block: Some(57_472_001),
        calls: calls.into_iter().collect(),
    });
    inp
}

#[test]
fn a_signed_aave_borrow_counts_in_an_orders_check_until_the_chain_has_used_its_nonce() {
    // Aave's loan is in the book the order is checked on, and the book has room for about $43,000 more.
    let base = hedged_at_aave(6);
    assert_eq!(buy_back_on(&base), "ok");
    let listed = |usd: u64, nonce: u64| json!([{"lender": {"lender": "aave", "kind": "borrow",
        "amount": (usd * USD).to_string(), "token": EVM_USDC, "evm_nonce": nonce}}]);
    let signed = |usd: u64, nonce: u64| json!({"nonce": nonce + 1, "signed": [{"nonce": nonce, "kind": "borrow",
        "token": EVM_USDC, "amount": (usd * USD).to_string(), "to": "0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27",
        "raw": "0x02", "hash": "0xab", "step": "f1:1", "signed_at": "1"}]});
    let with = |pending: Value, evm: Value, chain_nonce: u64| {
        let mut out = hedged_at_aave(chain_nonce);
        out.near.state["pending"] = pending;
        out.near.state["evm"] = evm;
        out
    };
    // A borrow the account signed with nonce 6 and lists (INTERFACES.md 33): counted as borrowed while the
    // chain's count is 6, as a borrow sent to Rhea is for its blocks.
    assert_eq!(buy_back_on(&with(listed(40_000, 6), Value::Null, 6)), "ok");
    assert_eq!(buy_back_on(&with(listed(46_000, 6), Value::Null, 6)), OVER_THE_CAP);
    // Signed and not listed, it counts the same: anyone can send it.
    assert_eq!(buy_back_on(&with(json!([]), signed(46_000, 6), 6)), OVER_THE_CAP);
    // Listed and signed is one borrow, not two: $40,000 once still fits.
    assert_eq!(buy_back_on(&with(listed(40_000, 6), signed(40_000, 6), 6)), "ok");
    // Once the chain has used nonce 6, Aave's own figure is the truth (here it never grew: the order fits).
    assert_eq!(buy_back_on(&with(listed(46_000, 6), signed(46_000, 6), 7)), "ok");
    // The funding plan's unfinished Aave step counts before it is signed, and adds to one already signed.
    let planned = |usd: u64, inp: &Inputs| with_plan(inp, json!([{"k": "l_borrow", "l": "aave", "amt": usd * USD, "done": false}]));
    assert_eq!(buy_back_on(&planned(46_000, &base)), OVER_THE_CAP);
    assert_eq!(buy_back_on(&planned(23_000, &with(listed(23_000, 6), Value::Null, 6))), OVER_THE_CAP);
    assert_eq!(buy_back_on(&planned(20_000, &with(listed(20_000, 6), Value::Null, 6))), "ok");
    // A signed withdrawal of the WBTC from Aave leaves the book as it is (the WBTC comes to the account's own
    // address). A signed transfer of it away takes it out of the book: with 0.3 of a bitcoin less the account is
    // in WATCH, so an order that adds risk is refused until the chain shows what happened.
    let moved = |kind: &str| json!({"nonce": 7, "signed": [{"nonce": 6, "kind": kind, "token": WBTC,
        "amount": "30000000", "to": "0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27", "raw": "0x02", "hash": "0xcd",
        "step": null, "signed_at": "1"}]});
    let mut at_address = with(json!([]), moved("transfer"), 6);
    let reads = at_address.lenders.aave.as_mut().unwrap();
    reads.calls.insert(format!("posted:{WBTC}"), format!("0x{:064x}{}", 50_000_000, "0".repeat(64 * 8)));
    reads.calls.insert(format!("balance:{WBTC}"), format!("0x{:064x}", 50_000_000));
    assert_eq!(buy_back_on(&at_address), "P6: account is WATCH: only risk-reducing orders");
    at_address.near.state["evm"] = moved("supply");
    assert_eq!(buy_back_on(&at_address), "ok");
    // The account always lists a transfer in `pending`. Listed alone, with nothing among what it signed, it counts
    // the same; once the chain has used its nonce it doesn't.
    let listed_transfer = |nonce: u64| json!([{"lender": {"lender": "aave", "kind": "transfer",
        "amount": "30000000", "token": WBTC, "evm_nonce": nonce}}]);
    at_address.near.state["evm"] = Value::Null;
    at_address.near.state["pending"] = listed_transfer(6);
    assert_eq!(buy_back_on(&at_address), "P6: account is WATCH: only risk-reducing orders");
    at_address.near.state["pending"] = listed_transfer(5);
    assert_eq!(buy_back_on(&at_address), "ok");
    // Stage 4's two kinds of pending transfer are read like the others: an order is checked on the book with the
    // money in transit, not refused as unreadable. A transfer of a token the settings don't list is.
    let deadline = (base.block.timestamp_ns.parse::<u64>().unwrap() + 3_600_000_000_000).to_string();
    let moves = |token: &str| json!([
        {"transfer": {"id": "move:1", "kind": "to_evm", "token": "mnbtc.pbf-ops.testnet", "amount": "55000",
                      "dep": "f00d", "deadline": deadline}},
        {"transfer": {"id": "move:2", "kind": "e_home", "token": token, "amount": "23000000",
                      "dep": "0x2031181d63507368232579af4c64a1c3428407ff", "deadline": deadline}}]);
    assert_eq!(buy_back_on(&with(moves("USDC"), Value::Null, 6)), "ok");
    assert_eq!(
        buy_back_on(&with(moves("0x00000000000000000000000000000000000000ff"), Value::Null, 6)),
        "READ: pending transfer move:2 is of 0x00000000000000000000000000000000000000ff, a token the account's Aave settings don't list"
    );
    assert_eq!(buy_back_on(&with(json!([]), moved("withdraw"), 6)), "ok");
}
