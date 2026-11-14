//! Sandbox stand-in for the Chain Signatures signer (`v1.signer-prod.testnet`), in the style of near-sdk-rs
//! `examples/mpc-contract`, for the account contract's tests (PLAN.md 5.1, "Testnet helpers"). The sandbox has no
//! MPC network (research/near.md 4).
//!
//! - `derived_public_key({path, predecessor, domain_id})` answers like the real signer, `"secp256k1:<base58 of
//!   x‖y>"`, but always with the same key: the real derived key of `client1.pb.testnet` at `hyperliquid-1`, whose
//!   address is `0xd7f35513286b7a0c2a7d8648c72588751ce0dd7c` (PLAN.md 5.2).
//! - `sign(request)` takes the real signer's arguments,
//!   `{"request":{"path":"hyperliquid-1","payload_v2":{"Ecdsa":"<64 hex>"},"domain_id":0}}`, with at least
//!   1 yoctoNEAR attached. Like the real signer, it yields until a signature arrives.
//! - `respond(signer_id, request, response)` is the test hook. It resumes every pending `sign` that `signer_id` made
//!   with exactly this request, and each caller receives `response` in the real signer's format (research/day1.md 3):
//!   `{"scheme":"Secp256k1","big_r":{"affine_point":"02…"},"s":{"scalar":"…"},"recovery_id":0}`. `scheme` may be
//!   left out of the response; the caller still gets it.
//! - `pending_requests()` lists the waiting requests, so a test can find the digest a contract asked for.
//! - With no response within 200 blocks the yield times out and `sign` fails with "Request has timed out", like
//!   the real signer, so callers can test their failure path.
//!
//! It signs nothing and anyone can respond: sandbox and testnet tests only.
use near_sdk::serde_json::{self, json};
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, Gas, GasWeight, NearToken, Promise, PromiseError, YieldId};

/// Gas kept for the callback that hands the signature back.
const GAS_FOR_RESPONSE: Gas = Gas::from_tgas(10);
/// The key `derived_public_key` always answers with.
pub const DERIVED_KEY: &str =
    "secp256k1:5CDPH1jf7MkUQ45W6WDKeK8fUT8XtyeVMDQ1bYX88yWxwpeyT3i4bMdAKg3CQzkRtYejctYykFyrgtnXAm8HCG4r";
/// `pending_requests` lists at most this many.
const MAX_LISTED: usize = 100;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Payload {
    Ecdsa(String),
    Eddsa(String),
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Scalar {
    pub scalar: String,
}

/// The real signer's answer for domain 0. It puts `scheme` first, as the real one does.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SignatureResponse {
    #[serde(default = "secp256k1")]
    pub scheme: String,
    pub big_r: AffinePoint,
    pub s: Scalar,
    pub recovery_id: u8,
}

fn secp256k1() -> String {
    "Secp256k1".to_string()
}

/// A waiting request: who asked, what, and how many identical copies wait.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingSign {
    pub signer_id: AccountId,
    pub request: SignRequest,
    pub count: u32,
}

/// Who asked, and for what: identical requests from one caller wait together.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct RequestKey {
    signer_id: AccountId,
    request: SignRequest,
}

#[near(contract_state)]
pub struct MpcMock {
    /// The pending yields for each request. After a timeout an entry can linger until the next `respond`, which
    /// skips yields that have already ended.
    pending: IterableMap<RequestKey, Vec<YieldId>>,
}

impl Default for MpcMock {
    fn default() -> Self {
        Self { pending: IterableMap::new(b"p") }
    }
}

#[near]
impl MpcMock {
    /// The same key for every path, caller and domain (see the module notes).
    pub fn derived_public_key(&self, path: String, predecessor: Option<AccountId>, domain_id: Option<u64>) -> String {
        let _ = (path, predecessor, domain_id);
        DERIVED_KEY.to_string()
    }

    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> Promise {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach at least 1 yoctoNEAR");
        if let Payload::Ecdsa(hex) = &request.payload_v2 {
            require!(
                hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()),
                "an Ecdsa payload is 32 bytes as 64 hex characters"
            );
        }
        let signer_id = env::predecessor_account_id();
        let args = json!({ "signer_id": signer_id, "request": request });
        let (promise, yield_id) =
            Promise::new_yield("on_response", serde_json::to_vec(&args).unwrap(), GAS_FOR_RESPONSE, GasWeight(1));
        let key = RequestKey { signer_id, request };
        let mut ids = self.pending.get(&key).cloned().unwrap_or_default();
        ids.push(yield_id);
        self.pending.insert(key, ids);
        promise
    }

    /// Test hook: answers every pending `sign` that `signer_id` made with exactly `request`.
    pub fn respond(&mut self, signer_id: AccountId, request: SignRequest, response: SignatureResponse) {
        let key = RequestKey { signer_id, request };
        let ids = self.pending.remove(&key).unwrap_or_else(|| env::panic_str("no pending request like this"));
        let data = serde_json::to_vec(&response).unwrap();
        let resumed = ids.into_iter().filter(|id| id.resume(&data).is_ok()).count();
        require!(resumed > 0, "every pending copy of this request has already timed out");
    }

    /// Hands the signature to the caller, or fails like the real signer after a timeout.
    #[private]
    pub fn on_response(
        &mut self,
        signer_id: AccountId,
        request: SignRequest,
        #[callback_result] response: Result<SignatureResponse, PromiseError>,
    ) -> SignatureResponse {
        let _ = (signer_id, request);
        response.unwrap_or_else(|_| env::panic_str("Request has timed out"))
    }

    /// How many `sign` calls from `signer_id` with this request are waiting (tests poll it before responding).
    pub fn pending_count(&self, signer_id: AccountId, request: SignRequest) -> u32 {
        let key = RequestKey { signer_id, request };
        self.pending.get(&key).map_or(0, |ids| ids.len() as u32)
    }

    /// The requests waiting for an answer (at most 100). A request that timed out stays listed until it is answered.
    pub fn pending_requests(&self) -> Vec<PendingSign> {
        self.pending
            .iter()
            .take(MAX_LISTED)
            .map(|(key, ids)| PendingSign {
                signer_id: key.signer_id.clone(),
                request: key.request.clone(),
                count: ids.len() as u32,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn request() -> SignRequest {
        SignRequest { path: "hyperliquid-1".into(), payload_v2: Payload::Ecdsa("ab".repeat(32)), domain_id: 0 }
    }

    fn call(deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build());
    }

    #[test]
    fn a_request_waits_until_answered_and_is_listed() {
        call(1);
        let mut mpc = MpcMock::default();
        mpc.sign(request()).detach();
        mpc.sign(request()).detach();
        assert_eq!(mpc.pending_count(accounts(1), request()), 2);
        assert_eq!(mpc.pending_count(accounts(2), request()), 0);
        let listed = mpc.pending_requests();
        assert_eq!(listed, vec![PendingSign { signer_id: accounts(1), request: request(), count: 2 }]);
    }

    #[test]
    fn the_derived_key_is_the_real_one_of_client1() {
        let key = MpcMock::default().derived_public_key("hyperliquid-1".into(), Some(accounts(1)), Some(0));
        assert_eq!(key, DERIVED_KEY);
        let raw = near_sdk::bs58::decode(key.strip_prefix("secp256k1:").unwrap()).into_vec().unwrap();
        assert_eq!(raw.len(), 64);
        let address: String = env::keccak256_array(&raw)[12..].iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(address, "d7f35513286b7a0c2a7d8648c72588751ce0dd7c");
    }

    #[test]
    fn a_response_without_scheme_is_answered_with_it_like_the_real_signer() {
        let bare = r#"{"big_r":{"affine_point":"02aa"},"s":{"scalar":"bb"},"recovery_id":1}"#;
        let response: SignatureResponse = serde_json::from_str(bare).unwrap();
        let answer = serde_json::to_string(&response).unwrap();
        assert_eq!(
            answer,
            r#"{"scheme":"Secp256k1","big_r":{"affine_point":"02aa"},"s":{"scalar":"bb"},"recovery_id":1}"#
        );
    }

    #[test]
    #[should_panic(expected = "attach at least 1 yoctoNEAR")]
    fn sign_needs_a_deposit() {
        call(0);
        MpcMock::default().sign(request()).detach();
    }

    #[test]
    #[should_panic(expected = "64 hex characters")]
    fn an_ecdsa_payload_is_32_bytes() {
        call(1);
        let bad = SignRequest { payload_v2: Payload::Ecdsa("ab".into()), ..request() };
        MpcMock::default().sign(bad).detach();
    }

    #[test]
    #[should_panic(expected = "no pending request like this")]
    fn respond_needs_a_pending_request() {
        call(0);
        let response = SignatureResponse {
            scheme: "Secp256k1".into(),
            big_r: AffinePoint { affine_point: "02".into() },
            s: Scalar { scalar: "01".into() },
            recovery_id: 0,
        };
        MpcMock::default().respond(accounts(1), request(), response);
    }

    #[test]
    #[should_panic(expected = "Request has timed out")]
    fn a_timeout_fails_like_the_real_signer() {
        call(0);
        MpcMock::default().on_response(accounts(1), request(), Err(PromiseError::Failed));
    }
}
