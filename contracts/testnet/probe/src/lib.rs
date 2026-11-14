//! Phase 0 probe, testnet only (PLAN.md 11.1, research/day1.md). It measures the two cross-contract calls the
//! account contract depends on, the way the account contract will make them:
//! - `sign_probe`: one Chain Signatures request to the MPC signer for a 32-byte digest, such as a Hyperliquid
//!   `ApproveAgent` EIP-712 digest. The callback returns the signature with the start and end block heights.
//! - `outlayer_probe`: one OutLayer `request_execution`. The callback does what the account contract will do with a
//!   verdict (parse it, hash it, store the hash) and reports the bytes received and the gas it used.
//!
//! Only the listed owners can start a probe, because the contract pays OutLayer's deposit from its own balance.
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

/// research/near.md 4: `sign` needs at least 15 TGas under the live config; 30-50 suggested.
const SIGN_GAS: Gas = Gas::from_tgas(50);
const SIGN_CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// OutLayer reserves 50 TGas for its own callback; its example attaches 200 TGas (research/outlayer.md 1).
const OUTLAYER_GAS: Gas = Gas::from_tgas(200);
const OUTLAYER_CALLBACK_GAS: Gas = Gas::from_tgas(30);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Probe {
    owners: Vec<AccountId>,
    signer_id: AccountId,
    outlayer_id: AccountId,
    verdicts: u64,
    last_verdict_hash: Vec<u8>,
}

#[near]
impl Probe {
    #[init]
    pub fn new(owners: Vec<AccountId>, signer_id: AccountId, outlayer_id: AccountId) -> Self {
        Self { owners, signer_id, outlayer_id, verdicts: 0, last_verdict_hash: Vec::new() }
    }

    /// Asks the MPC signer to sign `payload_hex` (32 bytes as 64 hex characters) under `path`, with key domain 0
    /// (secp256k1). The signer refunds any deposit above its fee; 1 yoctoNEAR is the minimum.
    pub fn sign_probe(&mut self, payload_hex: String, path: String) -> Promise {
        self.assert_owner();
        require!(
            payload_hex.len() == 64 && payload_hex.bytes().all(|b| b.is_ascii_hexdigit()),
            "payload_hex must be 32 bytes as 64 hex characters"
        );
        let args = json!({"request": {"path": path, "payload_v2": {"Ecdsa": payload_hex}, "domain_id": 0}});
        Promise::new(self.signer_id.clone())
            .function_call("sign".to_string(), to_bytes(&args), NearToken::from_yoctonear(1), SIGN_GAS)
            .then(
                Self::ext(env::current_account_id()).with_static_gas(SIGN_CALLBACK_GAS).on_signed(env::block_height()),
            )
    }

    #[private]
    pub fn on_signed(&self, start_height: u64, #[callback_result] result: Result<Value, PromiseError>) -> Value {
        let end_height = env::block_height();
        match result {
            Ok(signature) => {
                json!({"ok": true, "signature": signature, "start_height": start_height, "end_height": end_height})
            }
            Err(_) => {
                json!({"ok": false, "reason": "the signer failed or timed out", "start_height": start_height, "end_height": end_height})
            }
        }
    }

    /// One OutLayer run. `source` and `resource_limits` go to OutLayer as given. `deposit` (yoctoNEAR) comes from this
    /// contract's balance, and OutLayer refunds what the run doesn't use to this contract.
    pub fn outlayer_probe(&mut self, source: Value, resource_limits: Value, input: String, deposit: U128) -> Promise {
        self.assert_owner();
        let args = json!({
            "source": source,
            "resource_limits": resource_limits,
            "input_data": input,
            "secrets_ref": null,
            "response_format": "Json",
            "payer_account_id": env::current_account_id(),
        });
        Promise::new(self.outlayer_id.clone())
            .function_call(
                "request_execution".to_string(),
                to_bytes(&args),
                NearToken::from_yoctonear(deposit.0),
                OUTLAYER_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(OUTLAYER_CALLBACK_GAS)
                    .on_verdict(env::block_height()),
            )
    }

    /// Parses the verdict, hashes it and stores the hash, then reports the gas this receipt used so far.
    #[private]
    pub fn on_verdict(
        &mut self,
        start_height: u64,
        #[callback_result] result: Result<Option<Value>, PromiseError>,
    ) -> Value {
        let end_height = env::block_height();
        let mut out = match result {
            Ok(Some(verdict)) => {
                let bytes = to_bytes(&verdict);
                self.last_verdict_hash = env::sha256(&bytes);
                self.verdicts += 1;
                json!({"ok": true, "bytes": bytes.len(), "verdict_ok": verdict.get("ok").cloned().unwrap_or(Value::Null)})
            }
            Ok(None) => json!({"ok": false, "reason": "null result: the run failed, timed out or did not return JSON"}),
            Err(_) => json!({"ok": false, "reason": "the OutLayer promise failed"}),
        };
        out["start_height"] = json!(start_height);
        out["end_height"] = json!(end_height);
        out["callback_gas_used"] = json!(env::used_gas().as_gas());
        out
    }

    pub fn stats(&self) -> Value {
        json!({
            "owners": self.owners,
            "signer_id": self.signer_id,
            "outlayer_id": self.outlayer_id,
            "verdicts": self.verdicts,
            "last_verdict_hash": Base64VecU8::from(self.last_verdict_hash.clone()),
        })
    }
}

impl Probe {
    fn assert_owner(&self) {
        require!(self.owners.contains(&env::predecessor_account_id()), "only an owner can start a probe");
    }
}

fn to_bytes(v: &Value) -> Vec<u8> {
    serde_json::to_vec(v).unwrap_or_else(|_| env::panic_str("JSON encoding failed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn probe() -> Probe {
        Probe::new(vec![accounts(0)], "v1.signer-prod.testnet".parse().unwrap(), "outlayer.testnet".parse().unwrap())
    }

    #[test]
    #[should_panic(expected = "only an owner can start a probe")]
    fn strangers_cannot_start_a_probe() {
        testing_env!(VMContextBuilder::new().predecessor_account_id(accounts(1)).build());
        let _ = probe().sign_probe("00".repeat(32), "hl-1".into());
    }

    #[test]
    #[should_panic(expected = "payload_hex must be 32 bytes")]
    fn payload_must_be_32_bytes() {
        testing_env!(VMContextBuilder::new().predecessor_account_id(accounts(0)).build());
        let _ = probe().sign_probe("abcd".into(), "hl-1".into());
    }

    #[test]
    fn an_owner_can_ask_for_a_signature() {
        testing_env!(VMContextBuilder::new().predecessor_account_id(accounts(0)).build());
        let _ = probe().sign_probe("ab".repeat(32), "hl-1".into());
    }
}
