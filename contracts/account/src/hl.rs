//! The account's Hyperliquid master (PLAN.md 5.2; INTERFACES.md 8): its state, the `hl_signed` event, and the
//! helpers that turn the MPC signer's and the gateway's answers into Hyperliquid's formats.
//!
//! Nothing here panics, because the callbacks use it.
use near_sdk::json_types::U64;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json;
use near_sdk::{bs58, env, near, AccountId};

use crate::verdict::Action;

/// The Chain Signatures path of the master address (PLAN.md 5.2).
pub const HL_PATH: &str = "hyperliquid-1";
/// `hl.signed` keeps the newest entries, at most this many.
pub const MAX_SIGNED: usize = 20;
/// An agent is named valid for this long: 180 days, Hyperliquid's longest (PLAN.md 5.2).
pub const AGENT_VALID_MS: u64 = 180 * 24 * 60 * 60 * 1_000;
/// How long a signed `sendAsset` can still reach Hyperliquid after its nonce: Hyperliquid takes nonces down to its
/// own time less 2 days. One more hour covers the gap between its clock and NEAR's.
pub const SEND_OPEN_MS: u64 = 2 * 24 * 60 * 60 * 1_000 + 60 * 60 * 1_000;
/// `hl.open_sends` keeps at most this many nonces. One more moves the oldest into `hl.send_floor_until_ms`.
pub const MAX_OPEN_SENDS: usize = 8;

/// The master's state, as `get_state().hl` shows it.
/// - `address`: the derived address, set once by `hl_init`.
/// - `agent`: the gateway's agent for this account, set by `request_agent`.
/// - `next_nonce_ms`: no signed action takes a nonce below it.
/// - `send_open_until_ms`: until then, a signed `sendAsset` could still be posted, so no action that needs a verdict
///   runs (0 if none is open). It is its own field, so it outlasts the 20 entries `signed` keeps. It is always the
///   later of `send_floor_until_ms` and the newest of `open_sends` plus `SEND_OPEN_MS`.
/// - `open_sends`: the nonces of the `sendAsset`s the signer was asked to sign that no accepted verdict has named as
///   sent, oldest first, at most 8 (INTERFACES.md 50.2). One that is `SEND_OPEN_MS` old leaves at the next transfer
///   or accepted verdict.
/// - `send_floor_until_ms`: a ninth open transfer moves the oldest out of the list and into this time. No verdict
///   ends the pause before it (0 if unused or passed).
/// - `signed`: the newest signed actions, oldest first. Their `index` counts up from 0 and is never reused.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Hl {
    pub path: String,
    pub address: Option<String>,
    pub agent: Option<Agent>,
    pub next_nonce_ms: U64,
    pub send_open_until_ms: U64,
    pub open_sends: Vec<U64>,
    pub send_floor_until_ms: U64,
    /// The index the next signed action gets. The view leaves it out; it is one more than the last entry's.
    #[serde(skip)]
    pub next_index: u64,
    pub signed: Vec<SignedAction>,
}

impl Hl {
    pub fn new() -> Self {
        Self {
            path: HL_PATH.to_string(),
            address: None,
            agent: None,
            next_nonce_ms: U64(0),
            send_open_until_ms: U64(0),
            open_sends: Vec::new(),
            send_floor_until_ms: U64(0),
            next_index: 0,
            signed: Vec::new(),
        }
    }

    /// The nonce for the next action at `now_ms`: `max(now_ms, next_nonce_ms)`. `next_nonce_ms` becomes one more, so
    /// nonces are unique and close to Hyperliquid's clock.
    pub fn take_nonce(&mut self, now_ms: u64) -> u64 {
        let nonce = now_ms.max(self.next_nonce_ms.0);
        self.next_nonce_ms = U64(nonce.saturating_add(1));
        nonce
    }

    /// Notes a `sendAsset` with this nonce that the signer was asked to sign at `now_ms`. It counts from the moment
    /// it is asked for: the signer's answer is public on-chain even if it never reaches the account.
    pub fn note_send(&mut self, nonce: u64, now_ms: u64) {
        self.open_sends.push(U64(nonce));
        self.set_send_open(now_ms);
    }

    /// An accepted verdict's `sent`: the nonces Hyperliquid's own history shows as sent. A nonce that was used can't
    /// be used again, so those transfers hold nothing back any more (INTERFACES.md 50.2). A nonce that isn't in the
    /// list changes nothing. Returns whether this ended the pause before its time.
    pub fn settle_sends(&mut self, sent: &[u64], now_ms: u64) -> bool {
        let paused = now_ms < self.send_open_until_ms.0;
        self.open_sends.retain(|nonce| !sent.contains(&nonce.0));
        self.set_send_open(now_ms);
        paused && self.send_open_until_ms.0 <= now_ms
    }

    /// Drops the nonces that are `SEND_OPEN_MS` old and a floor that has passed, keeps the newest `MAX_OPEN_SENDS`
    /// (an older one moves into the floor), and sets `send_open_until_ms` from what is left.
    fn set_send_open(&mut self, now_ms: u64) {
        let until = |nonce: &U64| nonce.0.saturating_add(SEND_OPEN_MS);
        self.open_sends.retain(|nonce| now_ms < until(nonce));
        let mut floor = self.send_floor_until_ms.0;
        if floor <= now_ms {
            floor = 0;
        }
        let excess = self.open_sends.len().saturating_sub(MAX_OPEN_SENDS);
        for nonce in self.open_sends.drain(..excess) {
            floor = floor.max(until(&nonce));
        }
        self.send_floor_until_ms = U64(floor);
        let newest = self.open_sends.iter().map(until).max().unwrap_or(0);
        self.send_open_until_ms = U64(newest.max(floor));
    }

    /// Appends a signed action with the next index, keeping the newest `MAX_SIGNED`. Returns the entry.
    pub fn record(&mut self, kind: ActionKind, action: String, nonce: u64, signature: HlSignature) -> SignedAction {
        let entry =
            SignedAction { index: self.next_index, kind, action, nonce, signature, signed_block: env::block_height() };
        self.next_index += 1;
        self.signed.push(entry.clone());
        let excess = self.signed.len().saturating_sub(MAX_SIGNED);
        self.signed.drain(..excess);
        entry
    }
}

impl Default for Hl {
    fn default() -> Self {
        Self::new()
    }
}

/// The gateway's agent for this account, and the block its answer arrived in.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Agent {
    pub address: String,
    pub received_block: u64,
}

/// What a signed action is: `"approveAgent"` or `"sendAsset"`.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionKind {
    ApproveAgent,
    SendAsset,
}

/// A signature as Hyperliquid takes it: `r` and `s` as `0x` and 64 hex digits, and `v` = 27 or 28.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct HlSignature {
    pub r: String,
    pub s: String,
    pub v: u8,
}

/// One signed action. The backend posts `{"action": <action, parsed>, "nonce", "signature"}` to `/exchange`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SignedAction {
    pub index: u64,
    pub kind: ActionKind,
    /// The action as compact JSON, exactly as signed.
    pub action: String,
    pub nonce: u64,
    pub signature: HlSignature,
    pub signed_block: u64,
}

/// The account's public events: NEP-297 logs with the same standard and version as the pool's,
/// `EVENT_JSON:{"standard":"pb-pool","version":"1.0.0","event":"hl_signed","data":[{...}]}`.
/// - `hl_signed`'s data is a list of one entry (INTERFACES.md 8).
/// - The Phase 4 events' data is one object, as in the pool's events (INTERFACES.md 14): `plan_stored` (`steps` lists
///   the steps' kinds), `step_run` and `transfer_done` (`how` is `arrived`, `refunded` or `verdict`).
/// - The Phase 6 events' data is one object too (INTERFACES.md 25 and 33): `permission_set`, `funding_stored`,
///   `funding_cancelled` and `evm_signed`. A funding step logs `step_run` with its plan's `f…` id.
#[near(event_json(standard = "pb-pool"))]
pub enum Event<'a> {
    #[event_version("1.0.0")]
    HlSigned(&'a [HlSigned<'a>]),
    #[event_version("1.0.0")]
    PlanStored { pid: String, action: Action, steps: Vec<String> },
    #[event_version("1.0.0")]
    StepRun { pid: &'a str, i: u32, k: &'a str },
    #[event_version("1.0.0")]
    TransferDone { id: &'a str, how: &'a str },
    /// Phase 6 (INTERFACES.md 25): the owner's new permission, or null when it was cancelled.
    #[event_version("1.0.0")]
    PermissionSet { permission: Option<&'a pb_types::Permission> },
    /// `steps` lists the funding steps' kinds, as `plan_stored` does.
    #[event_version("1.0.0")]
    FundingStored { pid: &'a str, amount: near_sdk::json_types::U128, steps: Vec<&'a str> },
    #[event_version("1.0.0")]
    FundingCancelled { pid: &'a str },
    /// Stage 3 (INTERFACES.md 33): an Ethereum transaction for Aave's chain was signed. `hash` is the transaction's.
    #[event_version("1.0.0")]
    EvmSigned { nonce: u64, kind: crate::evm::EvmKind, hash: &'a str },
}

/// `hl_signed`'s data: which action of which account was signed.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct HlSigned<'a> {
    pub account: &'a AccountId,
    pub index: u64,
    pub kind: ActionKind,
    pub nonce: u64,
}

/// `ms` since 1970 as `YYYY-MM-DD HH:MM:SS UTC`, for messages. The date comes from Howard Hinnant's
/// `civil_from_days`, in whole numbers only.
pub fn utc(ms: u64) -> String {
    let secs = ms / 1_000;
    let (days, time) = (secs / 86_400, secs % 86_400);
    // Days since 0000-03-01, split into 400-year eras of 146,097 days.
    let z = days + 719_468;
    let (era, doe) = (z / 146_097, z % 146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = era * 400 + yoe + u64::from(month <= 2);
    let (hour, minute, second) = (time / 3_600, time % 3_600 / 60, time % 60);
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02} UTC")
}

/// `micro` micro-USDC as Hyperliquid's decimal string, with no trailing zeros: 9,500,000,000 is `"9500"` and
/// 1,234,500 is `"1.2345"`.
pub fn usdc_decimal(micro: u128) -> String {
    let (whole, fraction) = (micro / 1_000_000, micro % 1_000_000);
    if fraction == 0 {
        return whole.to_string();
    }
    let digits = format!("{fraction:06}");
    format!("{whole}.{}", digits.trim_end_matches('0'))
}

/// The address of a `secp256k1:<base58 of the 64-byte x‖y>` key: `0x` and the last 20 bytes of keccak256(x‖y),
/// lowercase.
pub fn key_address(key: &str) -> Result<String, String> {
    let encoded = key.strip_prefix("secp256k1:").ok_or_else(|| format!("the key {key} is not secp256k1"))?;
    let raw = bs58::decode(encoded).into_vec().map_err(|_| "the key is not base58".to_string())?;
    if raw.len() != 64 {
        return Err(format!("the key is {} bytes, not the 64 of x and y", raw.len()));
    }
    Ok(format!("0x{}", hex(&env::keccak256_array(&raw)[12..])))
}

/// `address` lowercased, if it is `0x` and 40 hex digits.
pub fn parse_address(address: &str) -> Option<String> {
    let digits = address.strip_prefix("0x")?;
    is_hex(digits, 40).then(|| format!("0x{}", digits.to_ascii_lowercase()))
}

/// The MPC signer's answer to `sign` (research/day1.md 3):
/// `{"scheme":"Secp256k1","big_r":{"affine_point":"02…"},"s":{"scalar":"…"},"recovery_id":0}`.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct SignerAnswer {
    #[serde(default)]
    scheme: Option<String>,
    big_r: AffinePoint,
    s: Scalar,
    recovery_id: u8,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct AffinePoint {
    affine_point: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Scalar {
    scalar: String,
}

/// Turns the signer's answer into Hyperliquid's signature:
/// - `r` is `0x` and the x part of `big_r`, its 33 bytes less the first (02 or 03);
/// - `s` is `0x` and the scalar;
/// - `v` is `recovery_id + 27`.
///
/// v never comes from `big_r`'s prefix: the signer flips s to the low form, so the prefix can disagree with
/// `recovery_id` (research/day1.md 3).
pub fn hl_signature(answer: &[u8]) -> Result<HlSignature, String> {
    let a: SignerAnswer =
        serde_json::from_slice(answer).map_err(|err| format!("the signer's answer is malformed: {err}"))?;
    if let Some(scheme) = a.scheme.filter(|s| s != "Secp256k1") {
        return Err(format!("the signature's scheme is {scheme}, not Secp256k1"));
    }
    let big_r = a.big_r.affine_point;
    let x = big_r
        .strip_prefix("02")
        .or_else(|| big_r.strip_prefix("03"))
        .filter(|x| is_hex(x, 64))
        .ok_or_else(|| format!("big_r {big_r} is not 02 or 03 and 64 hex digits"))?;
    let s = a.s.scalar;
    if !is_hex(&s, 64) {
        return Err(format!("s {s} is not 64 hex digits"));
    }
    if a.recovery_id > 1 {
        return Err(format!("recovery_id {} is not 0 or 1", a.recovery_id));
    }
    Ok(HlSignature {
        r: format!("0x{}", x.to_ascii_lowercase()),
        s: format!("0x{}", s.to_ascii_lowercase()),
        v: a.recovery_id + 27,
    })
}

/// The gateway's answer in mode `agent_address` (INTERFACES.md 9): `{"ok":true,"acct":A,"agent":"0x…"}`, or
/// `{"ok":false,"code":…,"reason":…}`.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct AgentAnswer {
    ok: bool,
    #[serde(default)]
    acct: Option<String>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

/// The agent address in the gateway's answer, lowercase, if the answer is ok and for `account`. The error says which
/// check failed.
pub fn agent_from_answer(bytes: &[u8], account: &str) -> Result<String, String> {
    if bytes.trim_ascii().is_empty() || bytes.trim_ascii() == b"null" {
        return Err("OutLayer returned no answer: the run failed or timed out".into());
    }
    let a: AgentAnswer =
        serde_json::from_slice(bytes).map_err(|_| "the answer is not the gateway's: it has no ok field".to_string())?;
    if !a.ok {
        let why: Vec<String> = [a.code, a.reason].into_iter().flatten().filter(|w| !w.is_empty()).collect();
        return Err(format!("ok is false: {}", why.join(" ")).trim_end().to_string());
    }
    let acct = a.acct.unwrap_or_default();
    if acct != account {
        return Err(format!("acct {acct} is not this account"));
    }
    let agent = a.agent.unwrap_or_default();
    parse_address(&agent).ok_or_else(|| format!("agent {agent} is not 0x and 40 hex digits"))
}

/// Lowercase hex, without `0x`.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `client1.pb.testnet` with path `hyperliquid-1`, from `v1.signer-prod.testnet`'s `derived_public_key` (8 Nov),
    /// and the address PLAN.md 5.2 gives for it.
    const CLIENT1_KEY: &str =
        "secp256k1:5CDPH1jf7MkUQ45W6WDKeK8fUT8XtyeVMDQ1bYX88yWxwpeyT3i4bMdAKg3CQzkRtYejctYykFyrgtnXAm8HCG4r";
    const CLIENT1_ADDRESS: &str = "0xd7f35513286b7a0c2a7d8648c72588751ce0dd7c";
    /// `probe.pbf-ops.testnet` with path `hyperliquid-1`: the key that signed the Phase 0 digests.
    const PROBE_KEY: &str =
        "secp256k1:KMvbJB2SU3nHsuttGzkHjJydvkWF18bnJXqJjoW3AwdYnCb28QLd4jLdkCZYyEiU1i29fRWqJN2opfVCT7BPvfz";
    const PROBE_ADDRESS: &str = "0xca86d7b16905cb3035976fe532a11b1f4dd835fb";

    /// Three of the signer's real answers from Phase 0 (research/data/day1_mpc_probe.json runs 1, 5 and 10, read
    /// back from their transactions), with the digests they signed. In runs 5 and 10, big_r's prefix disagrees with
    /// recovery_id.
    const REAL: [(&str, &str, &str, u8); 3] = [
        (
            "00ab21582be5f893acc4290f56201ddbb167997a5b60e37ae8ac4372b95b6066",
            "02497d915c47613e320433866351cc116dae342ffed072e1279b3bbd9d166a43f4",
            "53e2fbae414fb9197b3a3f64bad6393e1f793bf5533a68712570321b8d9afdcb",
            0,
        ),
        (
            "c84861e03775a4b93ab0413bd0c5fc9a0dee2d7bbaa49d54062d899283535225",
            "03c108d226eef8ea52e8c49dd4ffe260add49c1478f8305122e2cee5f755b6df22",
            "680ca8be54a7349ca45980f38c0c76ef37406385b782c1d895e8ac5e257a0785",
            0,
        ),
        (
            "0eb2e399eaa68614a997b6140dd74f4f479c2705527b25cd2cb5696544a46fae",
            "02808c355953d28d9a7cad50e58eaa331fcd4ea75fe176d78535d1548513b75c38",
            "2e1c6182bb7a1d0a6213cb7c2a14f023bcb8b1c22409597e5b07721be2b5927d",
            1,
        ),
    ];

    fn answer(big_r: &str, s: &str, recovery_id: u8) -> Vec<u8> {
        let a = serde_json::json!({
            "scheme": "Secp256k1", "big_r": { "affine_point": big_r }, "s": { "scalar": s }, "recovery_id": recovery_id,
        });
        serde_json::to_vec(&a).unwrap()
    }

    fn unhex(s: &str) -> Vec<u8> {
        let s = s.strip_prefix("0x").unwrap_or(s);
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn micro_usdc_becomes_a_decimal_string_with_no_trailing_zeros() {
        let cases = [
            (9_500_000_000, "9500"),
            (1_234_500, "1.2345"),
            (1, "0.000001"),
            (500_000, "0.5"),
            (10_000_000, "10"),
            (10_000_010, "10.00001"),
            (0, "0"),
        ];
        for (micro, expected) in cases {
            assert_eq!(usdc_decimal(micro), expected, "{micro}");
        }
        assert_eq!(usdc_decimal(u128::MAX), "340282366920938463463374607431768.211455");
    }

    #[test]
    fn the_real_derived_key_of_client1_gives_the_plan_5_2_address() {
        assert_eq!(key_address(CLIENT1_KEY).unwrap(), CLIENT1_ADDRESS);
        assert_eq!(key_address(PROBE_KEY).unwrap(), PROBE_ADDRESS);
    }

    #[test]
    fn a_key_that_is_not_a_64_byte_secp256k1_key_is_refused() {
        let ed = "ed25519:5CDPH1jf7MkUQ45W6WDKeK8fUT8XtyeVMDQ1bYX88yWxwpeyT3i4bMdAKg3CQzkRtYejctYykFyrgtnXAm8HCG4r";
        assert!(key_address(ed).unwrap_err().contains("is not secp256k1"));
        assert_eq!(key_address("secp256k1:0OIl").unwrap_err(), "the key is not base58");
        let short = format!("secp256k1:{}", bs58::encode([7u8; 33]).into_string());
        assert_eq!(key_address(&short).unwrap_err(), "the key is 33 bytes, not the 64 of x and y");
    }

    #[test]
    fn addresses_are_0x_and_40_hex_digits_and_come_out_lowercase() {
        let mixed = "0xFC9D786B69b900ec51dfe8ebbf19ed47be59009d";
        assert_eq!(parse_address(mixed).unwrap(), "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d");
        for bad in
            ["fc9d786b69b900ec51dfe8ebbf19ed47be59009d", "0xfc9d", "0x", "0Xfc9d786b69b900ec51dfe8ebbf19ed47be59009d"]
        {
            assert_eq!(parse_address(bad), None, "{bad}");
        }
        assert_eq!(parse_address(&format!("0x{}", "z".repeat(40))), None);
        assert_eq!(parse_address(&format!("0x{}", "a".repeat(41))), None);
    }

    #[test]
    fn the_signers_answer_becomes_r_s_and_v_from_recovery_id() {
        let (_, big_r, s, _) = REAL[1];
        // big_r starts with 03, but recovery_id is 0: v is 27.
        let sig = hl_signature(&answer(big_r, s, 0)).unwrap();
        assert_eq!(sig.r, format!("0x{}", &big_r[2..]));
        assert_eq!(sig.s, format!("0x{s}"));
        assert_eq!(sig.v, 27);
        assert_eq!(hl_signature(&answer(big_r, s, 1)).unwrap().v, 28);
        // Upper-case hex comes out lowercase, and an answer without `scheme` is read the same.
        let upper = hl_signature(&answer(&big_r.to_uppercase(), &s.to_uppercase(), 0)).unwrap();
        assert_eq!(upper, sig);
        let bare = serde_json::json!({ "big_r": { "affine_point": big_r }, "s": { "scalar": s }, "recovery_id": 0 });
        assert_eq!(hl_signature(&serde_json::to_vec(&bare).unwrap()).unwrap(), sig);
    }

    /// The real signatures recover to the probe's derived address with v = recovery_id + 27, the way Hyperliquid
    /// recovers them. With v from big_r's prefix, runs 5 and 10 recover to another address.
    #[test]
    fn the_real_signatures_recover_to_the_derived_address() {
        let probe = bs58::decode(PROBE_KEY.strip_prefix("secp256k1:").unwrap()).into_vec().unwrap();
        for (digest, big_r, s, recovery_id) in REAL {
            let sig = hl_signature(&answer(big_r, s, recovery_id)).unwrap();
            let rs = [unhex(&sig.r), unhex(&sig.s)].concat();
            let key = env::ecrecover(&unhex(digest), &rs, sig.v - 27, true).expect("no key recovered");
            assert_eq!(key.to_vec(), probe, "run with digest {digest}");
            assert_eq!(format!("0x{}", hex(&env::keccak256_array(key)[12..])), PROBE_ADDRESS);
            let prefix_v = unhex(big_r)[0] - 2;
            let from_prefix = env::ecrecover(&unhex(digest), &rs, prefix_v, true);
            assert_eq!(from_prefix.map(|k| k.to_vec()) == Some(probe.clone()), prefix_v == recovery_id);
        }
    }

    #[test]
    fn a_malformed_signature_is_refused() {
        let (_, big_r, s, _) = REAL[0];
        let x = &big_r[2..];
        assert!(hl_signature(&answer(&format!("04{x}"), s, 0)).unwrap_err().contains("is not 02 or 03"));
        assert!(hl_signature(&answer(&big_r[..64], s, 0)).unwrap_err().contains("is not 02 or 03"));
        assert!(hl_signature(&answer(big_r, &s[..62], 0)).unwrap_err().contains("is not 64 hex digits"));
        assert!(hl_signature(&answer(big_r, &"zz".repeat(32), 0)).unwrap_err().contains("is not 64 hex digits"));
        assert_eq!(hl_signature(&answer(big_r, s, 2)).unwrap_err(), "recovery_id 2 is not 0 or 1");
        let ed = serde_json::json!({ "scheme": "Ed25519", "big_r": { "affine_point": big_r }, "s": { "scalar": s }, "recovery_id": 0 });
        assert!(hl_signature(&serde_json::to_vec(&ed).unwrap()).unwrap_err().contains("scheme is Ed25519"));
        assert!(hl_signature(b"null").unwrap_err().contains("malformed"));
        assert!(hl_signature(br#"{"signature":[1,2]}"#).unwrap_err().contains("malformed"));
    }

    #[test]
    fn the_gateways_answer_gives_the_agent_for_this_account_only() {
        let me = "alice.pbf.testnet";
        let good = br#"{"ok":true,"acct":"alice.pbf.testnet","agent":"0xAbCdEf0123456789abcdef0123456789ABCDEF01"}"#;
        assert_eq!(agent_from_answer(good, me).unwrap(), "0xabcdef0123456789abcdef0123456789abcdef01");
        let bob = br#"{"ok":true,"acct":"bob.pbf.testnet","agent":"0xabcdef0123456789abcdef0123456789abcdef01"}"#;
        assert_eq!(agent_from_answer(bob, me).unwrap_err(), "acct bob.pbf.testnet is not this account");
        let refused = br#"{"ok":false,"code":"AUTH","reason":"the caller is not the account"}"#;
        assert_eq!(agent_from_answer(refused, me).unwrap_err(), "ok is false: AUTH the caller is not the account");
        let short = br#"{"ok":true,"acct":"alice.pbf.testnet","agent":"0xabc"}"#;
        assert_eq!(agent_from_answer(short, me).unwrap_err(), "agent 0xabc is not 0x and 40 hex digits");
        let none = br#"{"ok":true,"acct":"alice.pbf.testnet"}"#;
        assert!(agent_from_answer(none, me).unwrap_err().contains("is not 0x and 40 hex digits"));
        assert!(agent_from_answer(b"null", me).unwrap_err().contains("returned no answer"));
        assert!(agent_from_answer(b"", me).unwrap_err().contains("returned no answer"));
        assert!(agent_from_answer(br#"{"agent":"0x"}"#, me).unwrap_err().contains("has no ok field"));
        assert!(agent_from_answer(b"[1]", me).unwrap_err().contains("has no ok field"));
    }

    #[test]
    fn a_send_keeps_the_window_open_for_2_days_and_an_hour_after_its_nonce() {
        let mut hl = Hl::new();
        assert_eq!(hl.send_open_until_ms, U64(0));
        hl.note_send(1_000, 1_000);
        assert_eq!(hl.send_open_until_ms, U64(1_000 + 176_400_000));
        // A later send moves it on; an earlier nonce never pulls it back.
        hl.note_send(5_000, 5_000);
        assert_eq!(hl.send_open_until_ms, U64(5_000 + 176_400_000));
        hl.note_send(2_000, 5_000);
        assert_eq!(hl.send_open_until_ms, U64(5_000 + 176_400_000));
        assert_eq!(SEND_OPEN_MS, 2 * 86_400_000 + 3_600_000);
    }

    fn open(hl: &Hl) -> Vec<u64> {
        hl.open_sends.iter().map(|nonce| nonce.0).collect()
    }

    #[test]
    fn a_ninth_open_send_moves_the_oldest_into_the_floor_and_the_floor_holds_whatever_is_named_as_sent() {
        let mut hl = Hl::new();
        for i in 0..8 {
            hl.note_send(1_000 + i, 1_000 + i);
        }
        assert_eq!((open(&hl), hl.send_floor_until_ms), ((1_000..1_008).collect(), U64(0)));
        hl.note_send(1_008, 1_008);
        assert_eq!(open(&hl), (1_001..1_009).collect::<Vec<_>>());
        assert_eq!(hl.send_floor_until_ms, U64(1_000 + SEND_OPEN_MS));
        assert_eq!(hl.send_open_until_ms, U64(1_008 + SEND_OPEN_MS));
        // A tenth moves the floor on to the next oldest's time: the later of the two.
        hl.note_send(1_009, 1_009);
        assert_eq!((open(&hl).len(), hl.send_floor_until_ms), (MAX_OPEN_SENDS, U64(1_001 + SEND_OPEN_MS)));
        // All ten named as sent: the eight leave the list, and the pause holds until the floor.
        assert!(!hl.settle_sends(&(1_000..1_010).collect::<Vec<_>>(), 2_000));
        assert_eq!((open(&hl), hl.send_open_until_ms), (vec![], U64(1_001 + SEND_OPEN_MS)));
        assert_eq!(hl.send_floor_until_ms, U64(1_001 + SEND_OPEN_MS));
        // A floor that has passed is unused again.
        assert!(!hl.settle_sends(&[], 1_001 + SEND_OPEN_MS));
        assert_eq!((hl.send_floor_until_ms, hl.send_open_until_ms), (U64(0), U64(0)));
    }

    #[test]
    fn a_send_that_is_2_days_and_an_hour_old_leaves_the_list_when_the_next_is_noted() {
        let mut hl = Hl::new();
        hl.note_send(1_000, 1_000);
        hl.note_send(2_000, 2_000);
        // 1 ms before the first one's time is up it is still listed; at its time it has gone.
        let last_ms = 1_000 + SEND_OPEN_MS - 1;
        hl.note_send(last_ms, last_ms);
        assert_eq!(open(&hl), vec![1_000, 2_000, last_ms]);
        hl.note_send(last_ms + 1, last_ms + 1);
        assert_eq!(open(&hl), vec![2_000, last_ms, last_ms + 1]);
        // Sends that old never reach the floor: a week later the list has the new one only.
        let later = last_ms + 7 * 86_400_000;
        hl.note_send(later, later);
        assert_eq!((open(&hl), hl.send_floor_until_ms), (vec![later], U64(0)));
        assert_eq!(hl.send_open_until_ms, U64(later + SEND_OPEN_MS));
    }

    #[test]
    fn naming_a_send_ends_the_pause_only_when_no_other_is_open() {
        let mut hl = Hl::new();
        hl.note_send(1_000, 1_000);
        hl.note_send(2_000, 2_000);
        // A nonce that isn't in the list changes nothing; neither does naming none.
        let before = hl.clone();
        assert!(!hl.settle_sends(&[999, 1_001, 3_000], 5_000));
        assert!(!hl.settle_sends(&[], 5_000));
        assert_eq!(hl, before);
        // One of two named: the pause now ends with the other.
        assert!(!hl.settle_sends(&[2_000], 5_000));
        assert_eq!((open(&hl), hl.send_open_until_ms), (vec![1_000], U64(1_000 + SEND_OPEN_MS)));
        // The last one named: the pause ends before its time, and only this says so.
        assert!(hl.settle_sends(&[1_000], 5_000));
        assert_eq!((open(&hl), hl.send_open_until_ms), (vec![], U64(0)));
        assert!(!hl.settle_sends(&[1_000], 5_000));
    }

    /// The rule of before: the latest nonce noted, plus 2 days and an hour.
    #[test]
    fn with_nothing_named_as_sent_the_pause_is_never_shorter_than_the_rule_of_before_made_it() {
        let (mut hl, mut before, mut now, mut seed) = (Hl::new(), 0u64, 1_700_000_000_000u64, 7u64);
        let mut floors = 0;
        for round in 0..600 {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            // Mostly under an hour apart, so more than eight are open at once; now and then three days apart.
            now += if seed >> 60 == 0 { 3 * 86_400_000 } else { (seed >> 40) % 3_600_000 };
            if round % 3 == 2 {
                assert!(!hl.settle_sends(&[], now), "round {round}");
            } else {
                let nonce = hl.take_nonce(now);
                hl.note_send(nonce, now);
                before = before.max(nonce + SEND_OPEN_MS);
            }
            // The same end as before. Once that has passed, there is no pause either way.
            let expected = if now < before { before } else { 0 };
            assert_eq!(hl.send_open_until_ms.0, expected, "round {round}");
            assert!(hl.open_sends.len() <= MAX_OPEN_SENDS, "round {round}");
            floors += u32::from(hl.send_floor_until_ms.0 > 0);
        }
        assert!(floors > 100, "the floor was in use in {floors} rounds only");
    }

    /// The expected strings are Python's `datetime` for the same instants.
    #[test]
    fn utc_names_the_time_like_python_does() {
        let cases = [
            (0, "1970-01-01 00:00:00 UTC"),
            (1_700_000_000_000, "2023-11-14 22:13:20 UTC"),
            (1_700_176_400_000, "2023-11-16 23:13:20 UTC"),
            (1_794_176_400_001, "2026-11-08 22:20:00 UTC"),
            (951_825_600_000, "2000-02-29 12:00:00 UTC"),
            (1_709_208_000_000, "2024-02-29 12:00:00 UTC"),
            (4_102_444_799_999, "2099-12-31 23:59:59 UTC"),
            (253_402_300_799_000, "9999-12-31 23:59:59 UTC"),
        ];
        for (ms, expected) in cases {
            assert_eq!(utc(ms), expected, "{ms}");
        }
        // The largest time doesn't overflow.
        assert!(utc(u64::MAX).ends_with(" UTC"));
    }

    #[test]
    fn nonces_follow_the_block_clock_and_never_repeat() {
        let mut hl = Hl::new();
        assert_eq!(hl.take_nonce(1_000), 1_000);
        // Two actions in the same millisecond.
        assert_eq!(hl.take_nonce(1_000), 1_001);
        assert_eq!(hl.next_nonce_ms, U64(1_002));
        // Later blocks take their own time.
        assert_eq!(hl.take_nonce(5_000), 5_000);
        // A clock behind the last nonce still moves on.
        assert_eq!(hl.take_nonce(4_000), 5_001);
    }

    fn signature() -> HlSignature {
        HlSignature { r: format!("0x{}", "11".repeat(32)), s: format!("0x{}", "22".repeat(32)), v: 27 }
    }

    #[test]
    fn the_signed_list_keeps_the_newest_20_and_never_reuses_an_index() {
        let mut hl = Hl::new();
        for i in 0..25 {
            let entry = hl.record(ActionKind::SendAsset, format!("{{\"n\":{i}}}"), 1_000 + i, signature());
            assert_eq!(entry.index, i);
        }
        assert_eq!(hl.signed.len(), MAX_SIGNED);
        assert_eq!(hl.signed.iter().map(|e| e.index).collect::<Vec<_>>(), (5..25).collect::<Vec<_>>());
        assert_eq!(hl.signed[0].action, r#"{"n":5}"#);
        assert_eq!(hl.next_index, 25);
    }

    #[test]
    fn the_hl_view_has_the_interfaces_shape() {
        let mut hl = Hl::new();
        hl.address = Some(CLIENT1_ADDRESS.into());
        hl.agent = Some(Agent { address: PROBE_ADDRESS.into(), received_block: 123 });
        hl.next_nonce_ms = U64(1_794_000_000_000);
        let nonce = hl.take_nonce(0);
        hl.record(ActionKind::ApproveAgent, r#"{"type":"approveAgent"}"#.into(), nonce, signature());
        hl.note_send(1_794_000_000_000, 1_794_000_000_000);
        let view = serde_json::to_value(&hl).unwrap();
        let expected = serde_json::json!({
            "path": "hyperliquid-1",
            "address": CLIENT1_ADDRESS,
            "agent": { "address": PROBE_ADDRESS, "received_block": 123 },
            "next_nonce_ms": "1794000000001",
            "send_open_until_ms": "1794176400000",
            "open_sends": ["1794000000000"],
            "send_floor_until_ms": "0",
            "signed": [{
                "index": 0, "kind": "approveAgent", "action": r#"{"type":"approveAgent"}"#, "nonce": 1_794_000_000_000u64,
                "signature": { "r": format!("0x{}", "11".repeat(32)), "s": format!("0x{}", "22".repeat(32)), "v": 27 },
                "signed_block": 0,
            }],
        });
        assert_eq!(view, expected);
    }

    #[test]
    fn the_event_is_nep_297_with_the_pools_standard_and_version() {
        let account: AccountId = "alice.pbf.testnet".parse().unwrap();
        let data = [HlSigned { account: &account, index: 3, kind: ActionKind::SendAsset, nonce: 1_794_000_000_001 }];
        Event::HlSigned(&data).emit();
        let logs = near_sdk::test_utils::get_logs();
        assert_eq!(
            logs,
            vec![
                r#"EVENT_JSON:{"standard":"pb-pool","version":"1.0.0","event":"hl_signed","data":[{"account":"alice.pbf.testnet","index":3,"kind":"sendAsset","nonce":1794000000001}]}"#
            ]
        );
    }
}
