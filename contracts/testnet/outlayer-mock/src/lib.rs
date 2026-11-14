//! Sandbox stand-in for OutLayer (`outlayer.testnet`), for the account contract's tests (PLAN.md 5.1, "Testnet
//! helpers").
//!
//! - `request_execution(...)` takes OutLayer's arguments (`source`, `resource_limits`, `input_data`, `secrets_ref`,
//!   `response_format`, `payer_account_id`, `params`) and, like OutLayer, yields until the run finishes. It keeps the
//!   source, the input and the secrets reference for the tests to read, and runs nothing; request ids count up from 0.
//! - `resolve_execution(request_id, output)` is the test hook. The caller's callback then receives `output`: a canned
//!   verdict, or `null` for a failed run (OutLayer's callback carries no error text, research/outlayer.md 1). Any
//!   JSON goes through as it is, so a Phase 4 verdict carries its `plan` step objects and `arrived` ids
//!   (INTERFACES.md 13 and 14).
//! - `resolve_agent(request_id, agent)` answers a `pb-gateway` run in mode `agent_address` the way the gateway does
//!   (INTERFACES.md 9): `{"ok":true,"acct":<the account that asked>,"agent":<agent>}`.
//! - With no answer within 200 blocks the caller receives `null`, as from OutLayer after a timeout.
//!
//! The output is kept in state and the yield resumed with an empty payload, the way OutLayer handles large outputs,
//! so a verdict of any size (2 KB and more) gets through. The mock keeps the deposit, runs nothing, and anyone can
//! resolve a request: sandbox and testnet tests only.
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::IterableMap;
use near_sdk::{env, near, AccountId, Gas, GasWeight, NearToken, Promise, PromiseError, YieldId};

/// Gas kept for the callback that hands the output back.
const GAS_FOR_RESPONSE: Gas = Gas::from_tgas(20);

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
struct Request {
    caller: AccountId,
    payer_account_id: Option<AccountId>,
    source: String,
    input_data: Option<String>,
    /// The `secrets_ref` the caller passed, as JSON, or `None` for null.
    secrets_ref: Option<String>,
    deposit: NearToken,
    yield_id: YieldId,
    /// The canned output once the test resolves the request: `Some(json)` for a verdict, `Some("null")` for a
    /// failed run.
    output: Option<String>,
}

/// A pending request as the tests see it. `source` is the JSON the caller passed.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RequestView {
    pub request_id: u64,
    pub caller: AccountId,
    pub payer_account_id: Option<AccountId>,
    pub source: Value,
    pub input_data: Option<String>,
    pub secrets_ref: Option<Value>,
    pub deposit: NearToken,
}

#[near(contract_state)]
pub struct OutlayerMock {
    next_id: u64,
    requests: IterableMap<u64, Request>,
}

impl Default for OutlayerMock {
    fn default() -> Self {
        Self { next_id: 0, requests: IterableMap::new(b"r") }
    }
}

#[near]
impl OutlayerMock {
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<Value>,
        payer_account_id: Option<AccountId>,
        params: Option<Value>,
    ) -> Promise {
        let _ = (resource_limits, response_format, params);
        let request_id = self.next_id;
        self.next_id += 1;
        let args = serde_json::to_vec(&json!({ "request_id": request_id })).unwrap();
        let (promise, yield_id) = Promise::new_yield("on_execution_response", args, GAS_FOR_RESPONSE, GasWeight(1));
        let request = Request {
            caller: env::predecessor_account_id(),
            payer_account_id,
            source: source.to_string(),
            input_data,
            secrets_ref: secrets_ref.map(|v| v.to_string()),
            deposit: env::attached_deposit(),
            yield_id,
            output: None,
        };
        self.requests.insert(request_id, request);
        promise
    }

    /// Test hook: finishes the run with `output`, a canned verdict or `null` for a failed run.
    pub fn resolve_execution(&mut self, request_id: u64, output: Option<Value>) {
        let request =
            self.requests.get_mut(&request_id).unwrap_or_else(|| env::panic_str("no pending request with this id"));
        if request.output.is_some() {
            env::panic_str("this request is already resolved");
        }
        request.output = Some(output.map_or_else(|| "null".to_string(), |v| v.to_string()));
        if request.yield_id.resume([]).is_err() {
            env::panic_str("this request has already timed out");
        }
    }

    /// Test hook: finishes a `pb-gateway` run in mode `agent_address` as the gateway does, naming `agent` for the
    /// account that asked: `{"ok":true,"acct":<caller>,"agent":<agent>}`.
    pub fn resolve_agent(&mut self, request_id: u64, agent: String) {
        let request =
            self.requests.get(&request_id).unwrap_or_else(|| env::panic_str("no pending request with this id"));
        let input: Value = request.input_data.as_deref().and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default();
        if input["mode"] != "agent_address" {
            env::panic_str("this request is not a pb-gateway agent_address run");
        }
        let output = json!({ "ok": true, "acct": request.caller, "agent": agent });
        self.resolve_execution(request_id, Some(output));
    }

    /// Hands the output to the caller: the canned one, or `null` after a timeout.
    #[private]
    pub fn on_execution_response(
        &mut self,
        request_id: u64,
        #[callback_result] resumed: Result<(), PromiseError>,
    ) -> Option<Value> {
        let request = self.requests.remove(&request_id)?;
        match (resumed, request.output) {
            (Ok(()), Some(output)) => serde_json::from_str(&output).unwrap_or(None),
            _ => None,
        }
    }

    /// The requests still waiting for a result, oldest first (at most 100).
    pub fn pending_requests(&self) -> Vec<RequestView> {
        self.requests
            .iter()
            .filter(|(_, r)| r.output.is_none())
            .take(100)
            .map(|(id, r)| RequestView {
                request_id: *id,
                caller: r.caller.clone(),
                payer_account_id: r.payer_account_id.clone(),
                source: serde_json::from_str(&r.source).unwrap_or(Value::Null),
                input_data: r.input_data.clone(),
                secrets_ref: r.secrets_ref.as_deref().and_then(|s| serde_json::from_str(s).ok()),
                deposit: r.deposit,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn request(mock: &mut OutlayerMock) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_millinear(7))
            .build());
        let source = json!({ "Project": { "project_id": "pbf.testnet/pb-risk", "version_key": null } });
        mock.request_execution(source, Some(json!({})), Some("{\"intent\":\"check\"}".into()), None, None, None, None)
            .detach();
    }

    #[test]
    fn requests_wait_with_their_input_until_resolved() {
        let mut mock = OutlayerMock::default();
        request(&mut mock);
        request(&mut mock);
        let pending = mock.pending_requests();
        assert_eq!(pending.iter().map(|r| r.request_id).collect::<Vec<_>>(), vec![0, 1]);
        assert_eq!(pending[0].input_data.as_deref(), Some("{\"intent\":\"check\"}"));
        assert_eq!(pending[0].source["Project"]["project_id"], "pbf.testnet/pb-risk");
        assert_eq!(pending[0].deposit, NearToken::from_millinear(7));
    }

    #[test]
    fn the_callback_returns_the_canned_output_or_null() {
        let mut mock = OutlayerMock::default();
        request(&mut mock);
        request(&mut mock);
        mock.requests.get_mut(&0).unwrap().output = Some(r#"{"ok":true,"state":"HEALTHY"}"#.into());
        let verdict = mock.on_execution_response(0, Ok(())).unwrap();
        assert_eq!(verdict["state"], "HEALTHY");
        // A timeout, or a request that is gone, gives null.
        assert_eq!(mock.on_execution_response(1, Err(PromiseError::Failed)), None);
        assert_eq!(mock.on_execution_response(1, Ok(())), None);
        assert!(mock.pending_requests().is_empty());
    }

    /// A Phase 4 verdict: a DELEVERAGE plan of step objects, and the transfers seen to arrive.
    #[test]
    fn a_verdict_with_plan_objects_comes_back_as_it_was_given() {
        let mut mock = OutlayerMock::default();
        request(&mut mock);
        let verdict = json!({
            "ok": true, "state": "DELEVERAGE", "action": "DELEVERAGE", "blk": 276_800_123u64,
            "plan": [
                { "k": "perp", "coin": "BTC", "buy": true, "sz": "0.00375", "px": "76190" },
                { "k": "repay", "amt": 250_000_000u64 },
                { "k": "home", "amt": 5_000_000u64, "dep": "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d", "exp": 1_794_000_600_000u64 },
            ],
            "arrived": ["276800000:1", "move:4"],
        });
        mock.resolve_execution(0, Some(verdict.clone()));
        assert_eq!(mock.on_execution_response(0, Ok(())), Some(verdict));
    }

    #[test]
    #[should_panic(expected = "no pending request with this id")]
    fn resolving_an_unknown_request_is_refused() {
        OutlayerMock::default().resolve_execution(9, None);
    }

    fn agent_request(mock: &mut OutlayerMock, input: &str) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_millinear(10))
            .build());
        let source =
            json!({ "Project": { "project_id": "pbf-keeper.testnet/pb-gateway", "version_key": "ab".repeat(32) } });
        let secrets = json!({ "profile": "pb-gateway", "account_id": "pbf-keeper.testnet" });
        mock.request_execution(source, Some(json!({})), Some(input.into()), Some(secrets), None, None, None).detach();
    }

    #[test]
    fn an_agent_address_run_is_answered_as_the_gateway_answers_it() {
        let mut mock = OutlayerMock::default();
        agent_request(&mut mock, r#"{"mode":"agent_address","account":"bob","network":"testnet"}"#);
        // The secrets reference is kept for the tests to read.
        let secrets = json!({ "profile": "pb-gateway", "account_id": "pbf-keeper.testnet" });
        assert_eq!(mock.pending_requests()[0].secrets_ref, Some(secrets));
        let agent = "0x6ecdc34d53c1dc5ab647718a2e0f949643b2017c";
        mock.resolve_agent(0, agent.into());
        let output = json!({ "ok": true, "acct": accounts(1), "agent": agent });
        assert_eq!(mock.on_execution_response(0, Ok(())), Some(output));
    }

    #[test]
    #[should_panic(expected = "this request is not a pb-gateway agent_address run")]
    fn resolve_agent_answers_only_agent_address_runs() {
        let mut mock = OutlayerMock::default();
        agent_request(&mut mock, r#"{"mode":"check"}"#);
        mock.resolve_agent(0, "0x6ecdc34d53c1dc5ab647718a2e0f949643b2017c".into());
    }
}
