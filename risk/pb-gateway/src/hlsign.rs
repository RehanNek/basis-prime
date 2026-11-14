//! Hyperliquid L1 actions and their signatures, as the official Python SDK makes them (research/hyperliquid.md,
//! "L1 signing"; `hyperliquid/utils/signing.py` at tag 0.24.0):
//!
//! 1. msgpack the action, keys in the SDK's order (struct field order here; absent optional fields left out);
//! 2. `connectionId = keccak256(msgpack ‖ nonce as 8 bytes big-endian ‖ 0x00)`, the 0x00 meaning no vault;
//! 3. sign the EIP-712 struct `Agent(string source,bytes32 connectionId)`, domain `Exchange`, version `1`, chainId
//!    1337, verifyingContract 0x0, with `source` `"a"` on mainnet and `"b"` on testnet;
//! 4. post `{"action","nonce","signature":{"r","s","v"},"vaultAddress":null,"expiresAfter":null}` to `/exchange`.
//!
//! The same struct is msgpacked for the hash and written as JSON for the post, so the two can't disagree.
use k256::ecdsa::SigningKey;
use serde::Serialize;
use sha3::{Digest, Keccak256};

/// keccak256 of `bytes`.
pub fn keccak(bytes: &[u8]) -> [u8; 32] {
    Keccak256::digest(bytes).into()
}

/// Lowercase hex, no prefix.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The order's type: a limit order with its time in force (`Gtc`, `Ioc` or `Alo`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OrderType {
    pub limit: Limit,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Limit {
    pub tif: String,
}

/// One order on the wire (`OrderWire` in the SDK): asset, is buy, price, size, reduce only, type, client order id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OrderWire {
    pub a: u32,
    pub b: bool,
    pub p: String,
    pub s: String,
    pub r: bool,
    pub t: OrderType,
    /// `0x` and 32 hex digits. The SDK leaves the key out when there is none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub c: Option<String>,
}

/// `{"type":"order","orders":[...],"grouping":"na"}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OrderAction {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub orders: Vec<OrderWire>,
    pub grouping: &'static str,
}

impl OrderAction {
    pub fn one(order: OrderWire) -> OrderAction {
        OrderAction {
            kind: "order",
            orders: vec![order],
            grouping: "na",
        }
    }
}

/// One cancel: asset and order id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CancelWire {
    pub a: u32,
    pub o: u64,
}

/// `{"type":"cancel","cancels":[{"a":..,"o":..}]}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CancelAction {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub cancels: Vec<CancelWire>,
}

impl CancelAction {
    pub fn one(asset: u32, oid: u64) -> CancelAction {
        CancelAction {
            kind: "cancel",
            cancels: vec![CancelWire { a: asset, o: oid }],
        }
    }
}

/// `{"type":"updateLeverage","asset":..,"isCross":..,"leverage":..}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UpdateLeverageAction {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub asset: u32,
    #[serde(rename = "isCross")]
    pub is_cross: bool,
    pub leverage: u32,
}

impl UpdateLeverageAction {
    pub fn cross(asset: u32, leverage: u32) -> UpdateLeverageAction {
        UpdateLeverageAction {
            kind: "updateLeverage",
            asset,
            is_cross: true,
            leverage,
        }
    }
}

/// msgpack of an action, maps keyed by field name in field order (as Python's `msgpack.packb` writes a dict).
pub fn msgpack<T: Serialize>(action: &T) -> Result<Vec<u8>, String> {
    rmp_serde::to_vec_named(action).map_err(|e| format!("cannot msgpack the action: {e}"))
}

/// `action_hash` with no vault and no expiry: keccak256(msgpack ‖ nonce big-endian ‖ 0x00).
pub fn connection_id(packed: &[u8], nonce: u64) -> [u8; 32] {
    let mut data = Vec::with_capacity(packed.len() + 9);
    data.extend_from_slice(packed);
    data.extend_from_slice(&nonce.to_be_bytes());
    data.push(0);
    keccak(&data)
}

/// A 32-byte big-endian word holding `x`.
fn word(x: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&x.to_be_bytes());
    w
}

/// The `Exchange` domain's separator: name "Exchange", version "1", chainId 1337, verifyingContract 0x0.
pub fn exchange_domain() -> [u8; 32] {
    let type_hash = keccak(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    );
    let mut enc = Vec::with_capacity(5 * 32);
    enc.extend_from_slice(&type_hash);
    enc.extend_from_slice(&keccak(b"Exchange"));
    enc.extend_from_slice(&keccak(b"1"));
    enc.extend_from_slice(&word(1337));
    enc.extend_from_slice(&[0u8; 32]); // address(0), left-padded
    keccak(&enc)
}

/// The EIP-712 digest of the phantom agent `Agent{source, connectionId}`.
pub fn agent_digest(connection: &[u8; 32], mainnet: bool) -> [u8; 32] {
    let type_hash = keccak(b"Agent(string source,bytes32 connectionId)");
    let source: &[u8] = if mainnet { b"a" } else { b"b" };
    let mut enc = Vec::with_capacity(3 * 32);
    enc.extend_from_slice(&type_hash);
    enc.extend_from_slice(&keccak(source));
    enc.extend_from_slice(connection);
    let struct_hash = keccak(&enc);
    let mut msg = Vec::with_capacity(66);
    msg.extend_from_slice(&[0x19, 0x01]);
    msg.extend_from_slice(&exchange_domain());
    msg.extend_from_slice(&struct_hash);
    keccak(&msg)
}

/// A signature as Hyperliquid takes it: `r` and `s` as `0x` and 64 hex digits, `v` 27 or 28.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Sig {
    pub r: String,
    pub s: String,
    pub v: u8,
}

/// Signs a 32-byte digest: RFC 6979 nonce, low s (the recovery id flips with it), v = 27 + recovery id.
pub fn sign_digest(key: &SigningKey, digest: &[u8; 32]) -> Sig {
    let (sig, recid) = key.sign_prehash_recoverable(digest);
    let (r, s) = sig.split_bytes();
    Sig {
        r: format!("0x{}", hex(&r)),
        s: format!("0x{}", hex(&s)),
        v: 27 + u8::from(recid),
    }
}

/// Signs an L1 action for `nonce` (ms): msgpack, connection id, then the agent digest.
pub fn sign_l1<T: Serialize>(
    key: &SigningKey,
    action: &T,
    nonce: u64,
    mainnet: bool,
) -> Result<Sig, String> {
    let packed = msgpack(action)?;
    Ok(sign_digest(
        key,
        &agent_digest(&connection_id(&packed, nonce), mainnet),
    ))
}

/// The body posted to `/exchange`, as the SDK's `_post_action` writes it.
#[derive(Serialize)]
pub struct ExchangeBody<'a, T: Serialize> {
    pub action: &'a T,
    pub nonce: u64,
    pub signature: &'a Sig,
    #[serde(rename = "vaultAddress")]
    pub vault_address: Option<String>,
    #[serde(rename = "expiresAfter")]
    pub expires_after: Option<u64>,
}

/// The JSON body for an action signed with `sig` at `nonce`.
pub fn exchange_body<T: Serialize>(action: &T, nonce: u64, sig: &Sig) -> String {
    serde_json::to_string(&ExchangeBody {
        action,
        nonce,
        signature: sig,
        vault_address: None,
        expires_after: None,
    })
    .expect("an exchange body serialises")
}

/// The Ethereum address of a key: `0x` and the last 20 bytes of keccak256 of the 64-byte x‖y public key.
pub fn address(key: &SigningKey) -> String {
    let point = key.verifying_key().to_sec1_point(false);
    let bytes = point.as_bytes();
    // An uncompressed SEC1 point is 0x04 ‖ x ‖ y.
    format!("0x{}", hex(&keccak(&bytes[1..])[12..]))
}

#[cfg(test)]
mod tests {
    //! The vectors are the Python SDK's own tests (`tests/signing_test.py` at tag 0.24.0, commit 2fdb18f9). Its
    //! `to_hex` drops leading zeros, so r and s are compared as numbers, not strings.
    use super::*;

    const SDK_KEY: &str = "0123456789012345678901234567890123456789012345678901234567890123";

    fn key() -> SigningKey {
        let bytes: Vec<u8> = (0..32)
            .map(|i| u8::from_str_radix(&SDK_KEY[2 * i..2 * i + 2], 16).unwrap())
            .collect();
        SigningKey::from_slice(&bytes).unwrap()
    }

    /// `0x` hex with or without leading zeros, as 64 digits.
    fn padded(h: &str) -> String {
        format!("0x{:0>64}", h.trim_start_matches("0x"))
    }

    fn check(sig: &Sig, r: &str, s: &str, v: u8) {
        assert_eq!(
            (sig.r.as_str(), sig.s.as_str(), sig.v),
            (padded(r).as_str(), padded(s).as_str(), v)
        );
    }

    fn eth_order(cloid: Option<&str>, tif: &str, sz: &str, px: &str, asset: u32) -> OrderAction {
        OrderAction::one(OrderWire {
            a: asset,
            b: true,
            p: px.into(),
            s: sz.into(),
            r: false,
            t: OrderType {
                limit: Limit { tif: tif.into() },
            },
            c: cloid.map(String::from),
        })
    }

    #[derive(Serialize)]
    struct Dummy {
        #[serde(rename = "type")]
        kind: &'static str,
        num: u64,
    }

    #[test]
    fn the_phantom_agent_matches_production() {
        // test_phantom_agent_creation_matches_production: ETH (asset 4), buy 0.0147 at 1670.1, Ioc.
        let action = eth_order(None, "Ioc", "0.0147", "1670.1", 4);
        let id = connection_id(&msgpack(&action).unwrap(), 1677777606040);
        assert_eq!(
            hex(&id),
            "0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908"
        );
    }

    #[test]
    fn l1_signing_matches_the_sdk() {
        let k = key();
        // test_l1_action_signing_matches: {"type": "dummy", "num": float_to_int_for_hashing(1000)}, nonce 0.
        let dummy = Dummy {
            kind: "dummy",
            num: 100_000_000_000,
        };
        check(
            &sign_l1(&k, &dummy, 0, true).unwrap(),
            "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298",
            "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8",
            27,
        );
        check(
            &sign_l1(&k, &dummy, 0, false).unwrap(),
            "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510",
            "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613",
            28,
        );
        // test_l1_action_signing_order_matches: ETH (asset 1), buy 100 at 100, Gtc, nonce 0.
        let order = eth_order(None, "Gtc", "100", "100", 1);
        check(
            &sign_l1(&k, &order, 0, true).unwrap(),
            "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e",
            "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e",
            28,
        );
        check(
            &sign_l1(&k, &order, 0, false).unwrap(),
            "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54",
            "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5",
            27,
        );
        // test_l1_action_signing_order_with_cloid_matches: the same order with cloid 0x...01.
        let with_cloid = eth_order(
            Some("0x00000000000000000000000000000001"),
            "Gtc",
            "100",
            "100",
            1,
        );
        check(
            &sign_l1(&k, &with_cloid, 0, true).unwrap(),
            "0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3",
            "0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da",
            27,
        );
        check(
            &sign_l1(&k, &with_cloid, 0, false).unwrap(),
            "0xeba0664bed2676fc4e5a743bf89e5c7501aa6d870bdb9446e122c9466c5cd16d",
            "0x7f3e74825c9114bc59086f1eebea2928c190fdfbfde144827cb02b85bbe90988",
            28,
        );
    }

    #[test]
    fn wire_formats_are_the_sdks() {
        let order = eth_order(
            Some("0x00000000000000000000000000000001"),
            "Ioc",
            "0.33",
            "74500",
            3,
        );
        assert_eq!(
            serde_json::to_string(&order).unwrap(),
            r#"{"type":"order","orders":[{"a":3,"b":true,"p":"74500","s":"0.33","r":false,"t":{"limit":{"tif":"Ioc"}},"c":"0x00000000000000000000000000000001"}],"grouping":"na"}"#
        );
        // msgpack: a fixmap of 3, then "type" "order" ...: the SDK's dict order.
        let packed = msgpack(&order).unwrap();
        assert_eq!(&packed[..13], b"\x83\xa4type\xa5order\xa6");
        assert_eq!(
            serde_json::to_string(&CancelAction::one(3, 123)).unwrap(),
            r#"{"type":"cancel","cancels":[{"a":3,"o":123}]}"#
        );
        assert_eq!(
            serde_json::to_string(&UpdateLeverageAction::cross(3, 5)).unwrap(),
            r#"{"type":"updateLeverage","asset":3,"isCross":true,"leverage":5}"#
        );
        let sig = Sig {
            r: "0x01".into(),
            s: "0x02".into(),
            v: 27,
        };
        assert_eq!(
            exchange_body(&CancelAction::one(3, 1), 5, &sig),
            r#"{"action":{"type":"cancel","cancels":[{"a":3,"o":1}]},"nonce":5,"signature":{"r":"0x01","s":"0x02","v":27},"vaultAddress":null,"expiresAfter":null}"#
        );
    }

    #[test]
    fn the_sdk_key_has_its_address() {
        // eth_account's address for the SDK's test key.
        assert_eq!(
            address(&key()),
            "0x14791697260e4c9a71f18484c9f997b308e59325"
        );
    }
}
