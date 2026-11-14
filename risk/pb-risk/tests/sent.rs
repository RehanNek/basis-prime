//! INTERFACES.md 50.2: the verdict names the transfers out of Hyperliquid that went through (`sent`), so the account
//! can end its 2-day borrowing pause early. An open send is named only when Hyperliquid's ledger, read before the
//! balances, shows a `send` from the account's own address with its nonce.
//!
//! The ledger here is the live one of `npme2jlqx2.pbf.testnet`'s address, read on Hyperliquid testnet on 13 and 14
//! Nov (`pb-read/tests/fixtures/testnet/hl_ledger_send.json`): the stand-in's delivery, then the account's own
//! transfer home, which the account had signed with nonce 1794584202071.
mod common;

use common::*;
use pb_risk::{Inputs, Verdict};
use serde_json::{json, Value};
use std::collections::BTreeSet;

const ADDRESS: &str = "0x303d6eccb884202707872ae95bf36049cd5099aa";
const NONCE: u64 = 1_794_584_202_071;
const CHECK: &str = r#"{"check":{}}"#;

fn live_ledger() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../pb-read/tests/fixtures/testnet/hl_ledger_send.json"
    );
    let f: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!((f["address"].as_str(), f["nonce"].as_u64()), (Some(ADDRESS), Some(NONCE)));
    f["ledger"].clone()
}

/// The hedged demo book at the live address, with these open sends and this ledger.
fn world(open: Option<Value>, ledger: Value) -> World {
    let (_, q, entry) = World::hedged().hl.unwrap();
    World {
        hl: Some((ADDRESS, q, entry)),
        open_sends: open,
        ledger,
        ..World::hedged()
    }
}

/// The live case: the one transfer home is open, and the ledger shows it.
fn sent_world() -> World {
    world(Some(json!([NONCE.to_string()])), live_ledger())
}

fn verdict(out: &str) -> Verdict {
    serde_json::from_str(out).unwrap_or_else(|e| panic!("not a verdict ({e}): {out}"))
}

/// The snapshot form, split: the verdict's exact bytes and the inputs.
fn split(out: &str) -> (String, Inputs) {
    let v: Value = serde_json::from_str(out).unwrap();
    let inputs: Inputs = serde_json::from_value(v["inputs"].clone()).unwrap();
    let start = out.find(r#"{"verdict":"#).unwrap() + r#"{"verdict":"#.len();
    let end = out.find(r#","inputs":"#).unwrap();
    (out[start..end].to_string(), inputs)
}

/// The kinds of request Hyperliquid was asked, in order.
fn asked(net: &MockNet) -> Vec<&str> {
    net.hl_asked
        .iter()
        .map(|r| r["type"].as_str().unwrap())
        .collect()
}

fn place(kinds: &[&str], kind: &str) -> usize {
    kinds
        .iter()
        .position(|k| *k == kind)
        .unwrap_or_else(|| panic!("{kind} wasn't asked for: {kinds:?}"))
}

#[test]
fn the_verdict_names_the_nonce_of_the_transfer_hyperliquids_ledger_shows_as_sent() {
    let (out, _) = run(sent_world(), CHECK, false);
    let v = verdict(&out);
    assert!(v.ok, "{out}");
    assert_eq!(v.sent, [NONCE]);
    // A list of JSON numbers.
    assert!(out.contains(r#""sent":[1794584202071]"#), "{out}");
    // The same in check mode, which is the run the account accepts.
    let check = format!(
        r#"{{"mode":"check","account":"{ACCOUNT}","intent":{CHECK},"network":"testnet"}}"#
    );
    let out = pb_risk::run(&check, &mut MockNet::new(sent_world()));
    assert_eq!(verdict(&out).sent, [NONCE]);
    // And with a borrow asked for, as the Borrow button's check asks.
    let (out, _) = run(sent_world(), r#"{"borrow":{"amount":"1000000"}}"#, false);
    assert_eq!(verdict(&out).sent, [NONCE]);
    // The account writes the nonce as a string; a number reads the same.
    let (out, _) = run(world(Some(json!([NONCE])), live_ledger()), CHECK, false);
    assert_eq!(verdict(&out).sent, [NONCE]);
    // The case of the address's letters doesn't matter: as the account shows it, or as the ledger writes it.
    let upper = World {
        hl: Some(("0x303D6ECCB884202707872AE95BF36049CD5099AA", -0.3, 76_000.0)),
        ..sent_world()
    };
    assert_eq!(verdict(&run(upper, CHECK, false).0).sent, [NONCE]);
    let mut ledger = live_ledger();
    ledger[1]["delta"]["user"] = json!("0x303D6ECCB884202707872AE95BF36049CD5099AA");
    let w = world(Some(json!([NONCE.to_string()])), ledger);
    assert_eq!(verdict(&run(w, CHECK, false).0).sent, [NONCE]);
    // Two open, one sent: only that one is named.
    let two = world(
        Some(json!([NONCE.to_string(), "1794584999000"])),
        live_ledger(),
    );
    assert_eq!(verdict(&run(two, CHECK, false).0).sent, [NONCE]);
}

#[test]
fn money_coming_in_another_address_s_send_and_another_nonce_name_nothing() {
    let open = || Some(json!([NONCE.to_string()]));
    let nothing = |w: World, what: &str| {
        let (out, _) = run(w, CHECK, false);
        let v = verdict(&out);
        assert!(v.ok && v.sent.is_empty(), "{what}: {out}");
        // Left out when empty.
        assert!(!out.contains("sent"), "{what}: {out}");
    };
    let live = live_ledger();
    // The money-in row alone: the stand-in's delivery to the account.
    nothing(world(open(), json!([live[0].clone()])), "the delivery");
    // The same row carrying the account as its user and the open nonce is still not a `send`.
    let mut odd = json!([live[0].clone()]);
    odd[0]["delta"]["user"] = json!(ADDRESS);
    odd[0]["delta"]["nonce"] = json!(NONCE);
    nothing(world(open(), odd), "an internalTransfer with the nonce");
    // A `send` to the account with the same number: money coming in.
    let mut inbound = json!([live[1].clone()]);
    inbound[0]["delta"]["user"] = json!("0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d");
    inbound[0]["delta"]["destination"] = json!(ADDRESS);
    nothing(world(open(), inbound), "a send to the account");
    // Another address's `send`.
    let mut other = live.clone();
    other[1]["delta"]["user"] = json!("0x1b242c24f5e67e93d7b58c3dad77ccc90dacd7d0");
    nothing(world(open(), other), "another address's send");
    // The account's own `send`, with another nonce than the one that is open.
    nothing(
        world(Some(json!([(NONCE + 1).to_string()])), live.clone()),
        "another nonce",
    );
    // An empty ledger.
    nothing(world(open(), json!([])), "an empty ledger");
}

#[test]
fn with_an_open_send_the_ledger_is_asked_for_before_the_balances() {
    let two = world(
        Some(json!(["1794584999000", NONCE.to_string()])),
        live_ledger(),
    );
    let (out, net) = run(two, CHECK, false);
    assert_eq!(verdict(&out).sent, [NONCE]);
    let kinds = asked(&net);
    // First of all that Hyperliquid is asked, and so before both balances.
    assert_eq!(
        kinds,
        [
            "userNonFundingLedgerUpdates",
            "clearinghouseState",
            "frontendOpenOrders",
            "userAbstraction",
            "spotClearinghouseState",
            "metaAndAssetCtxs"
        ]
    );
    let ledger = place(&kinds, "userNonFundingLedgerUpdates");
    assert!(ledger < place(&kinds, "clearinghouseState"));
    assert!(ledger < place(&kinds, "spotClearinghouseState"));
    // From one hour before the oldest open nonce, for the account's own address.
    assert_eq!(
        net.hl_asked[0],
        json!({"type": "userNonFundingLedgerUpdates", "user": ADDRESS, "startTime": NONCE - 3_600_000})
    );
    // One more request than the same book with nothing open.
    assert_eq!(call_counts(&net)["hyperliquid"], 6);
}

#[test]
fn with_no_open_send_there_is_no_ledger_request_and_no_sent_in_the_verdict() {
    // An account made before the rule (no list), and one with nothing open (an empty list). The ledger holds the
    // transfer, but nobody asks.
    let before = run(world(None, live_ledger()), CHECK, false);
    let empty = run(world(Some(json!([])), live_ledger()), CHECK, false);
    for (out, net) in [&before, &empty] {
        let kinds = asked(net);
        assert!(!kinds.contains(&"userNonFundingLedgerUpdates"), "{kinds:?}");
        assert_eq!(
            kinds,
            [
                "clearinghouseState",
                "frontendOpenOrders",
                "userAbstraction",
                "spotClearinghouseState",
                "metaAndAssetCtxs"
            ]
        );
        assert_eq!(call_counts(net)["hyperliquid"], 5);
        let v = verdict(out);
        assert!(v.ok && v.sent.is_empty());
        assert!(!out.contains("sent"), "{out}");
    }
    // The two runs are the same run: the same requests, the same verdict but for the hash of the state read.
    assert_eq!(before.1.calls, empty.1.calls);
    let (a, b) = (verdict(&before.0), verdict(&empty.0));
    assert_eq!(
        Verdict { inputs: String::new(), ..a },
        Verdict { inputs: String::new(), ..b }
    );
}

#[test]
fn the_ledger_read_for_arrivals_stays_after_the_balances() {
    // A move to Hyperliquid is pending and a transfer out is open: two ledger reads, each where it is safe. The
    // one for `sent` comes first; the one for `arrived` comes after the balances, as it always did.
    let mut w = sent_world();
    let deadline_ms = T0_MS + 1_800_000;
    w.pending = Some(json!([{"transfer": {"id": "move:1", "kind": "to_hl", "token": MUSDC,
        "amount": "430000000", "dep": "cd", "deadline": (deadline_ms * 1_000_000).to_string()}}]));
    let (out, net) = run(w, CHECK, true);
    let (bytes, inputs) = split(&out);
    assert_eq!(verdict(&bytes).sent, [NONCE]);
    let kinds = asked(&net);
    assert_eq!(
        kinds,
        [
            "userNonFundingLedgerUpdates",
            "clearinghouseState",
            "frontendOpenOrders",
            "userAbstraction",
            "spotClearinghouseState",
            "userNonFundingLedgerUpdates",
            "metaAndAssetCtxs"
        ]
    );
    assert_eq!(net.hl_asked[0]["startTime"], json!(NONCE - 3_600_000));
    // The arrival read starts where it always did: a day and a half hour before the move's deadline.
    let arrival_from = deadline_ms - pb_risk::book::ARRIVAL_LOOKBACK_MS;
    assert_eq!(net.hl_asked[5]["startTime"], json!(arrival_from));
    // Each read is saved in its own place.
    assert_eq!(
        (inputs.hl.sent_from_ms, inputs.hl.ledger_from_ms),
        (NONCE - 3_600_000, arrival_from)
    );
    assert_eq!((&inputs.hl.sent_ledger, &inputs.hl.ledger), (&live_ledger(), &live_ledger()));
}

#[test]
fn a_ledger_read_that_fails_names_nothing_and_the_run_still_brings_its_verdict() {
    let down = World {
        ledger_down: true,
        ..sent_world()
    };
    let (out, net) = run(down, CHECK, true);
    let (bytes, inputs) = split(&out);
    let v = verdict(&bytes);
    assert!(v.ok, "{bytes}");
    assert!(v.sent.is_empty() && !bytes.contains("sent"), "{bytes}");
    // The failure is listed, nothing is saved as read, and the balances were read after it all the same.
    assert_eq!(
        inputs.errors,
        ["Hyperliquid ledger for sent transfers: HTTP 500"]
    );
    assert_eq!((&inputs.hl.sent_ledger, inputs.hl.sent_from_ms), (&Value::Null, 0));
    assert!(inputs.fatal.is_none());
    let kinds = asked(&net);
    assert_eq!(kinds[0], "userNonFundingLedgerUpdates");
    assert!(kinds.contains(&"clearinghouseState") && kinds.contains(&"spotClearinghouseState"));
    // The verdict is the one the same book gets with the read working, but for `sent` and the hash of the inputs.
    let (good, _) = run(sent_world(), CHECK, false);
    let good = verdict(&good);
    assert_eq!(good.sent, [NONCE]);
    assert_eq!(
        Verdict { sent: Vec::new(), inputs: String::new(), ..good },
        Verdict { inputs: String::new(), ..v }
    );
    // An answer that isn't a list names nothing either.
    let odd = verdict(&run(world(Some(json!([NONCE.to_string()])), json!({"error": "busy"})), CHECK, false).0);
    assert!(odd.ok && odd.sent.is_empty());
}

#[test]
fn a_refused_run_names_nothing() {
    // The same inputs that name the transfer, with a read that stops the run: `{"ok":false,...}` and no `sent`.
    let (out, _) = run(sent_world(), CHECK, true);
    let (bytes, mut inputs) = split(&out);
    assert_eq!(verdict(&bytes).sent, [NONCE]);
    inputs.fatal = Some("cannot read the pool".into());
    let refused = pb_risk::output(&inputs);
    assert_eq!(refused, r#"{"ok":false,"reason":"cannot read the pool"}"#);
    // And a run that is refused before Hyperliquid is asked anything.
    let no_pool = World {
        pool_deployed: false,
        ..sent_world()
    };
    let (out, net) = run(no_pool, CHECK, false);
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["ok"], json!(false), "{out}");
    assert!(v.get("sent").is_none() && net.hl_asked.is_empty(), "{out}");
}

#[test]
fn a_run_that_names_a_transfer_replays_from_its_saved_inputs() {
    let (out, _) = run(sent_world(), CHECK, true);
    let (bytes, inputs) = split(&out);
    // The ledger that was read, and where the read started, are in the inputs, and `in` covers them.
    assert_eq!(inputs.hl.sent_ledger, live_ledger());
    assert_eq!(inputs.hl.sent_from_ms, NONCE - 3_600_000);
    let canonical = inputs.canonical();
    assert!(canonical.contains(r#""sent_ledger":[{"#) && canonical.contains(r#""sent_from_ms":1794580602071"#));
    assert_eq!(verdict(&bytes).inputs, inputs.hash());
    assert_eq!(pb_risk::output(&inputs), bytes);
    // Without the saved ledger the same inputs name nothing: `sent` comes from the inputs alone.
    let mut without = inputs.clone();
    without.hl.sent_ledger = Value::Null;
    without.hl.sent_from_ms = 0;
    let v = verdict(&pb_risk::output(&without));
    assert!(v.sent.is_empty());
}

#[test]
fn a_run_saved_before_the_rule_reads_back_and_replays_to_the_same_verdict() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
    for name in ["fresh", "deposits", "loan", "hedged", "drill"] {
        let text = std::fs::read_to_string(format!("{dir}/{name}.json")).unwrap();
        assert!(!text.contains("sent"), "{name}");
        let (bytes, inputs) = split(text.trim_end());
        // Nothing was read for `sent`, and the inputs' own form is the one that was saved, to the byte.
        assert_eq!((&inputs.hl.sent_ledger, inputs.hl.sent_from_ms), (&Value::Null, 0), "{name}");
        let text = text.trim_end();
        let saved = &text[text.find(r#","inputs":"#).unwrap() + r#","inputs":"#.len()..text.len() - 1];
        assert_eq!(inputs.canonical(), saved, "{name}");
        // The same verdict, byte for byte, with the same `in`.
        assert_eq!(pb_risk::output(&inputs), bytes, "{name}");
        let v: Value = serde_json::from_str(&bytes).unwrap();
        assert!(v.get("sent").is_none(), "{name}");
        if v["ok"] == json!(true) {
            assert_eq!(v["in"], json!(inputs.hash()), "{name}");
        }
    }
}

#[test]
fn the_gateways_read_asks_for_no_such_ledger() {
    // pb-gateway reads through `read_all_with`. It names nothing, so it asks what it always asked, in the same
    // order, though a transfer is open.
    let req = pb_risk::request::parse(&request(CHECK, false)).unwrap().request;
    let mut net = MockNet::new(sent_world());
    let inp = pb_risk::read::read_all_with(&mut net, &req, &BTreeSet::new(), true);
    let kinds = asked(&net);
    assert_eq!(
        kinds,
        [
            "clearinghouseState",
            "frontendOpenOrders",
            "userAbstraction",
            "spotClearinghouseState",
            "metaAndAssetCtxs"
        ]
    );
    assert_eq!((&inp.hl.sent_ledger, inp.hl.sent_from_ms), (&Value::Null, 0));
    assert!(inp.fatal.is_none() && inp.errors.is_empty());
    let mut same = MockNet::new(world(None, live_ledger()));
    pb_risk::read::read_all_with(&mut same, &req, &BTreeSet::new(), true);
    assert_eq!(net.calls, same.calls);
}
