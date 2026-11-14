//! Hyperliquid's user-signed actions (INTERFACES.md 8): `approveAgent` and `sendAsset`, as the backend posts them to
//! `/exchange`, and their EIP-712 digests, which the MPC signer signs.
//!
//! Each action is one struct, used both for its JSON and for its digest, so the posted fields are the signed ones.
//! - The type strings are written out by hand, because their names contain `:`.
//! - Hashes use `env::keccak256`.
//! - Encoding: a string is the keccak256 of its UTF-8 bytes, an address is left-padded to 32 bytes, and a uint is a
//!   32-byte big-endian word.
//!
//! The domain is name `HyperliquidSignTransaction`, version `1`, the action's `signatureChainId`, and the zero
//! address as verifying contract.
use near_sdk::env;
use near_sdk::serde::Serialize;

pub const DOMAIN_TYPE: &str = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
pub const APPROVE_AGENT_TYPE: &str =
    "HyperliquidTransaction:ApproveAgent(string hyperliquidChain,address agentAddress,string agentName,uint64 nonce)";
pub const SEND_ASSET_TYPE: &str = "HyperliquidTransaction:SendAsset(string hyperliquidChain,string destination,\
    string sourceDex,string destinationDex,string token,string amount,string fromSubAccount,uint64 nonce)";
const DOMAIN_NAME: &str = "HyperliquidSignTransaction";
const DOMAIN_VERSION: &str = "1";

/// `approveAgent`, with its fields in the posted order. `agent_address` is `0x` and 40 hex digits.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde", rename_all = "camelCase")]
pub struct ApproveAgent<'a> {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub hyperliquid_chain: &'a str,
    pub signature_chain_id: &'a str,
    pub agent_address: &'a str,
    pub agent_name: &'a str,
    pub nonce: u64,
}

/// `sendAsset`, with its fields in the posted order. `amount` is a decimal string, and the posted action must carry
/// the identical string.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde", rename_all = "camelCase")]
pub struct SendAsset<'a> {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub hyperliquid_chain: &'a str,
    pub signature_chain_id: &'a str,
    pub destination: &'a str,
    pub source_dex: &'a str,
    pub destination_dex: &'a str,
    pub token: &'a str,
    pub amount: &'a str,
    pub from_sub_account: &'a str,
    pub nonce: u64,
}

impl ApproveAgent<'_> {
    pub const KIND: &'static str = "approveAgent";

    /// The digest to sign, or `None` if the agent address or the chain id isn't hex.
    pub fn digest(&self) -> Option<[u8; 32]> {
        let agent = address_word(self.agent_address)?;
        let hash = hash_words(&[
            text(APPROVE_AGENT_TYPE),
            text(self.hyperliquid_chain),
            agent,
            text(self.agent_name),
            word(self.nonce),
        ]);
        Some(digest(chain_id(self.signature_chain_id)?, &hash))
    }
}

impl SendAsset<'_> {
    pub const KIND: &'static str = "sendAsset";

    /// The digest to sign, or `None` if the chain id isn't hex. `destination` is a string here, not an address.
    pub fn digest(&self) -> Option<[u8; 32]> {
        let hash = hash_words(&[
            text(SEND_ASSET_TYPE),
            text(self.hyperliquid_chain),
            text(self.destination),
            text(self.source_dex),
            text(self.destination_dex),
            text(self.token),
            text(self.amount),
            text(self.from_sub_account),
            word(self.nonce),
        ]);
        Some(digest(chain_id(self.signature_chain_id)?, &hash))
    }
}

/// The domain separator for `chain_id`.
pub fn domain_separator(chain_id: u64) -> [u8; 32] {
    hash_words(&[text(DOMAIN_TYPE), text(DOMAIN_NAME), text(DOMAIN_VERSION), word(chain_id), [0; 32]])
}

/// keccak256(0x19 0x01 ‖ domain separator ‖ struct hash).
fn digest(chain_id: u64, struct_hash: &[u8; 32]) -> [u8; 32] {
    let mut bytes = Vec::with_capacity(66);
    bytes.extend_from_slice(b"\x19\x01");
    bytes.extend_from_slice(&domain_separator(chain_id));
    bytes.extend_from_slice(struct_hash);
    env::keccak256_array(&bytes)
}

fn hash_words(words: &[[u8; 32]]) -> [u8; 32] {
    env::keccak256_array(words.concat())
}

/// A string field: the keccak256 of its UTF-8 bytes.
fn text(s: &str) -> [u8; 32] {
    env::keccak256_array(s.as_bytes())
}

/// A uint field: a 32-byte big-endian word.
fn word(n: u64) -> [u8; 32] {
    let mut w = [0; 32];
    w[24..].copy_from_slice(&n.to_be_bytes());
    w
}

/// An address field: its 20 bytes, left-padded to 32. `None` unless it is `0x` and 40 hex digits.
fn address_word(address: &str) -> Option<[u8; 32]> {
    let digits = address.strip_prefix("0x").filter(|d| d.len() == 40)?;
    let mut w = [0; 32];
    for (i, pair) in digits.as_bytes().chunks(2).enumerate() {
        w[12 + i] = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    Some(w)
}

fn nibble(c: u8) -> Option<u8> {
    char::from(c).to_digit(16).map(|d| d as u8)
}

/// `0x66eee` as a number.
fn chain_id(hex: &str) -> Option<u64> {
    u64::from_str_radix(hex.strip_prefix("0x")?, 16).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn approve<'a>(agent: &'a str, name: &'a str, nonce: u64) -> ApproveAgent<'a> {
        ApproveAgent {
            kind: ApproveAgent::KIND,
            hyperliquid_chain: "Testnet",
            signature_chain_id: "0x66eee",
            agent_address: agent,
            agent_name: name,
            nonce,
        }
    }

    fn send<'a>(destination: &'a str, amount: &'a str, nonce: u64) -> SendAsset<'a> {
        SendAsset {
            kind: SendAsset::KIND,
            hyperliquid_chain: "Testnet",
            signature_chain_id: "0x66eee",
            destination,
            source_dex: "",
            destination_dex: "",
            token: "USDC:0xeb62eee3685fc4c43992febcd9e75443",
            amount,
            from_sub_account: "",
            nonce,
        }
    }

    #[test]
    fn the_type_hashes_and_the_domain_separator_match_interfaces_8() {
        assert_eq!(hex(&text(APPROVE_AGENT_TYPE)), "4464abf6148f115d79362d98320081aa2ae8a5c840083cb65820bffc21394378");
        assert_eq!(hex(&text(SEND_ASSET_TYPE)), "5f7cf397b977b076f0fbb993badfc7dd11bd71461a3d076c0940eff5f91ac849");
        assert_eq!(hex(&domain_separator(0x66eee)), "feb1393ca4412a4ca577bd51d04f0a77033514c602f4d0a11490fb95f7428df6");
    }

    #[test]
    fn the_approve_agent_test_vector() {
        let a =
            approve("0x1111111111111111111111111111111111111111", "pb valid_until 1794700000000", 1_794_000_000_000);
        assert_eq!(hex(&a.digest().unwrap()), "d9a9d7d012959997623f8a5cbc8d7ccbe167212aeaaab25146a57d22cb4ea101");
    }

    #[test]
    fn the_send_asset_test_vector() {
        let s = send("0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d", "9500", 1_794_000_000_001);
        assert_eq!(hex(&s.digest().unwrap()), "cdc6e02faacd7851890b6f7bf8e41c50330d66ab4546849c39bdaa5b892214ae");
    }

    /// The same send from the spot balance. The expected digest comes from the helpers in
    /// `research/scripts/day1_mpc_probe.py` (8 Nov).
    #[test]
    fn the_send_asset_vector_from_spot() {
        let s = SendAsset {
            source_dex: "spot",
            ..send("0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d", "9500", 1_794_000_000_001)
        };
        assert_eq!(hex(&s.digest().unwrap()), "aa992608cfeced07facdcb8120044886378713e2afd8cc6540e30fdbba6b53a1");
    }

    /// Phase 0 had the MPC signer sign these `approveAgent` digests on testnet, and each signature recovered to the
    /// derived address (research/day1.md 3; research/data/day1_mpc_probe.json runs 1, 5 and 10).
    #[test]
    fn the_digests_the_signer_signed_in_phase_0() {
        let runs = [
            (
                "0x6ecdc34d53c1dc5ab647718a2e0f949643b2017c",
                1_794_005_479_421,
                "00ab21582be5f893acc4290f56201ddbb167997a5b60e37ae8ac4372b95b6066",
            ),
            (
                "0xb2ba7b401e5cbf06c1b39ecc6940a8eca2b1bcf9",
                1_794_005_523_934,
                "c84861e03775a4b93ab0413bd0c5fc9a0dee2d7bbaa49d54062d899283535225",
            ),
            (
                "0x7cd313da4023ddfee25e0be8c11151abbf597345",
                1_794_005_589_346,
                "0eb2e399eaa68614a997b6140dd74f4f479c2705527b25cd2cb5696544a46fae",
            ),
        ];
        for (agent, nonce, expected) in runs {
            assert_eq!(hex(&approve(agent, "pb probe", nonce).digest().unwrap()), expected);
        }
    }

    #[test]
    fn an_address_in_either_case_hashes_the_same() {
        let lower = approve("0xb2ba7b401e5cbf06c1b39ecc6940a8eca2b1bcf9", "pb", 1).digest();
        let mixed = approve("0xB2BA7b401e5cbf06c1b39ecc6940a8eca2b1bcf9", "pb", 1).digest();
        assert_eq!(lower, mixed);
    }

    #[test]
    fn every_field_changes_the_digest() {
        let base = send("0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d", "9500", 1);
        let changed = [
            SendAsset { hyperliquid_chain: "Mainnet", ..base.clone() },
            SendAsset { signature_chain_id: "0xa4b1", ..base.clone() },
            SendAsset { destination: "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009e", ..base.clone() },
            SendAsset { source_dex: "spot", ..base.clone() },
            SendAsset { destination_dex: "spot", ..base.clone() },
            SendAsset { token: "USDT0:0x00000000000000000000000000000000", ..base.clone() },
            SendAsset { amount: "9500.0", ..base.clone() },
            SendAsset { from_sub_account: "0x0000000000000000000000000000000000000001", ..base.clone() },
            SendAsset { nonce: 2, ..base.clone() },
        ];
        for other in changed {
            assert_ne!(other.digest(), base.digest(), "{other:?}");
        }
    }

    #[test]
    fn a_bad_address_or_chain_id_gives_no_digest() {
        assert_eq!(approve("0x11", "pb", 1).digest(), None);
        assert_eq!(approve(&format!("0x{}", "g".repeat(40)), "pb", 1).digest(), None);
        assert_eq!(approve(&"1".repeat(42), "pb", 1).digest(), None);
        let s = SendAsset { signature_chain_id: "66eee", ..send("0x00", "1", 1) };
        assert_eq!(s.digest(), None);
    }

    #[test]
    fn the_actions_serialize_as_interfaces_8_posts_them() {
        let a =
            approve("0x1111111111111111111111111111111111111111", "pb valid_until 1794700000000", 1_794_000_000_000);
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            r#"{"type":"approveAgent","hyperliquidChain":"Testnet","signatureChainId":"0x66eee","agentAddress":"0x1111111111111111111111111111111111111111","agentName":"pb valid_until 1794700000000","nonce":1794000000000}"#
        );
        let s = send("0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d", "9500", 1_794_000_000_001);
        assert_eq!(
            serde_json::to_string(&s).unwrap(),
            r#"{"type":"sendAsset","hyperliquidChain":"Testnet","signatureChainId":"0x66eee","destination":"0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d","sourceDex":"","destinationDex":"","token":"USDC:0xeb62eee3685fc4c43992febcd9e75443","amount":"9500","fromSubAccount":"","nonce":1794000000001}"#
        );
    }
}
