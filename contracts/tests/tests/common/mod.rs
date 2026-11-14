//! Shared helpers for the sandbox tests: a local sandbox node (near-sandbox 0.4.0), accounts that all use the
//! sandbox's genesis key, and short ways to deploy, call and view (near-api 0.8.7).
#![allow(dead_code)]

pub mod rhea;

use std::sync::Arc;

use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::types::TxExecutionStatus;
use near_api::{Account, AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_sandbox::config::{DEFAULT_GENESIS_ACCOUNT, DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY};
use serde_json::{json, Value};

pub const USDC: u128 = 1_000_000;
pub const SECOND_NS: u64 = 1_000_000_000;
pub const DAY_NS: u64 = 86_400 * SECOND_NS;

pub fn usd(dollars: u128) -> u128 {
    dollars * USDC
}

/// A contract's wasm, built with `cargo near build non-reproducible-wasm` into `contracts/target/near/`.
pub fn wasm(name: &str) -> Vec<u8> {
    let path = format!("{}/../target/near/{name}/{name}.wasm", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|_| {
        panic!("{path} is missing: build it first with `cargo near build non-reproducible-wasm --locked` in its crate")
    })
}

/// A deployed contract's code and state, as `tests/fetch_live.py` saved them from testnet into `contracts/target/live/`
/// (read-only RPC `view_code` and `view_state`), for the upgrade tests.
pub struct Live {
    pub account_id: AccountId,
    pub wasm: Vec<u8>,
    /// The sha256 of `wasm`, in hex.
    pub sha256: String,
    /// Every storage key with its value, base64, as the RPC gave them.
    pub values: Vec<(String, String)>,
}

impl Live {
    /// Loads `contracts/target/live/<name>.wasm` and `<name>.state.json`.
    pub fn load(name: &str) -> Self {
        Self::load_from("live", name)
    }

    /// As `load`, from another folder of `contracts/target/`, which `fetch_live.py --out` filled: a later day's
    /// copy of testnet, kept apart from the one the older upgrade tests read.
    pub fn load_from(folder: &str, name: &str) -> Self {
        let dir = format!("{}/../target/{folder}", env!("CARGO_MANIFEST_DIR"));
        let out = if folder == "live" { String::new() } else { format!("--out contracts/target/{folder} ") };
        let read = |path: String| {
            std::fs::read(&path).unwrap_or_else(|_| {
                panic!("{path} is missing: fetch it first with `python3 -I contracts/tests/fetch_live.py {out}{name}`")
            })
        };
        let wasm = read(format!("{dir}/{name}.wasm"));
        let state: Value = serde_json::from_slice(&read(format!("{dir}/{name}.state.json"))).unwrap();
        let sha256 = sha256_hex(&wasm);
        assert_eq!(state["code_sha256"], sha256, "{name}.wasm isn't the code {name}.state.json was read with");
        let text = |v: &Value| v.as_str().unwrap().to_string();
        let values = state["values"].as_array().unwrap().iter().map(|v| (text(&v["key"]), text(&v["value"]))).collect();
        Self { account_id: text(&state["account_id"]).parse().unwrap(), wasm, sha256, values }
    }
}

/// The sha256 of `bytes`, in hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    near_api::types::CryptoHash::hash(bytes).0.iter().map(|b| format!("{b:02x}")).collect()
}

/// One running sandbox node. Every account the tests create uses the genesis key, so one signer signs for all.
pub struct Chain {
    _node: near_sandbox::Sandbox,
    pub network: NetworkConfig,
    pub signer: Arc<Signer>,
    pub root: AccountId,
}

impl Chain {
    pub async fn start() -> Self {
        let node = near_sandbox::Sandbox::start_sandbox().await.expect("the sandbox node didn't start");
        Self::on(node)
    }

    /// As `start`, on a node whose fast-forward covers more time per block: about 10 s instead of 0.3 s. A
    /// fast-forwarded block moves the clock by the node's average block delay, (min + max) / 2, and this node's
    /// max is 20 s. It still makes blocks as fast as the default node, since it has chunks for each one.
    pub async fn start_with_slow_clock() -> Self {
        let mut config = near_sandbox::SandboxConfig::default();
        let delay = serde_json::json!({ "consensus": { "max_block_production_delay": { "secs": 20, "nanos": 0 } } });
        config.additional_config = Some(delay);
        let node =
            near_sandbox::Sandbox::start_sandbox_with_config(config).await.expect("the sandbox node didn't start");
        Self::on(node)
    }

    fn on(node: near_sandbox::Sandbox) -> Self {
        let network = NetworkConfig::from_rpc_url("sandbox", node.rpc_addr.parse().unwrap());
        let signer = Signer::from_secret_key(DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse().unwrap()).unwrap();
        Self { _node: node, network, signer, root: DEFAULT_GENESIS_ACCOUNT.as_str().parse().unwrap() }
    }

    /// Creates `<name>.sandbox` holding `near` NEAR, with the shared key.
    pub async fn account(&self, name: &str, near: u128) -> AccountId {
        let id: AccountId = format!("{name}.{}", self.root).parse().unwrap();
        Account::create_account(id.clone())
            .fund_myself(self.root.clone(), NearToken::from_near(near))
            .with_public_key(self.signer.get_public_key().await.unwrap())
            .with_signer(self.signer.clone())
            .send_to(&self.network)
            .await
            .unwrap()
            .assert_success();
        id
    }

    /// Creates an account and deploys `wasm` to it, calling `init` (a method and its arguments) if given.
    pub async fn contract(&self, name: &str, near: u128, wasm: Vec<u8>, init: Option<(&str, Value)>) -> AccountId {
        let id = self.account(name, near).await;
        let deploy = Contract::deploy(id.clone()).use_code(wasm);
        let result = match init {
            Some((method, args)) => {
                deploy
                    .with_init_call(method, args)
                    .unwrap()
                    .gas(NearGas::from_tgas(100))
                    .with_signer(self.signer.clone())
                    .send_to(&self.network)
                    .await
            }
            None => deploy.without_init_call().with_signer(self.signer.clone()).send_to(&self.network).await,
        };
        result.unwrap().assert_success();
        id
    }

    /// Creates `id` under exactly that name, such as a testnet name, holding `near` NEAR, with the shared key. It patches
    /// the sandbox's state, so the name needs no parent account here.
    pub async fn named_account(&self, id: &str, near: u128) -> AccountId {
        let creation = self._node.create_account(id.parse().unwrap()).initial_balance(NearToken::from_near(near));
        creation.send().await.unwrap_or_else(|e| panic!("couldn't create {id}: {e:?}"));
        id.parse().unwrap()
    }

    /// Puts a deployed contract into the sandbox under its testnet name: the account, its live code (deployed, so the
    /// sandbox compiles it) and its live state, key for key.
    pub async fn deploy_live(&self, live: &Live, near: u128) -> AccountId {
        let id = self.named_account(live.account_id.as_str(), near).await;
        self.deploy(&id, live.wasm.clone()).await;
        let patch = self._node.patch_state(id.as_str().parse().unwrap()).storage_entries(live.values.clone());
        patch.send().await.unwrap_or_else(|e| panic!("couldn't write {id}'s state: {e:?}"));
        id
    }

    /// Deploys `wasm` to `account`, signed by the account itself, with no init call: an upgrade.
    pub async fn deploy(&self, account: &AccountId, wasm: Vec<u8>) {
        let deploy = Contract::deploy(account.clone()).use_code(wasm).without_init_call();
        deploy.with_signer(self.signer.clone()).send_to(&self.network).await.unwrap().assert_success();
    }

    /// As `deploy`, with `method` as the deploy's init call, signed by the account itself. Returns the outcome.
    pub async fn deploy_with_init(&self, account: &AccountId, wasm: Vec<u8>, method: &str) -> ExecutionFinalResult {
        let deploy = Contract::deploy(account.clone()).use_code(wasm).with_init_call(method, json!({})).unwrap();
        let sent = deploy.gas(NearGas::from_tgas(100)).with_signer(self.signer.clone()).send_to(&self.network).await;
        sent.unwrap().into_full().expect("the outcome is complete")
    }

    /// The sha256 of the code deployed on `account`, in hex.
    pub async fn code_sha256(&self, account: &AccountId) -> String {
        let view = Account(account.clone()).view().fetch_from(&self.network).await.expect("no account view");
        match view.data.contract_state {
            near_api::types::account::ContractState::LocalHash(hash) => {
                hash.0.iter().map(|b| format!("{b:02x}")).collect()
            }
            other => panic!("{account} has no code of its own: {other:?}"),
        }
    }

    /// The bytes of storage `account` pays for: its code, its state and its keys. Each byte locks 10^19 yoctoNEAR.
    pub async fn storage_usage(&self, account: &AccountId) -> u64 {
        let view = Account(account.clone()).view().fetch_from(&self.network).await.expect("no account view");
        view.data.storage_usage
    }

    /// Calls `method` on `contract` as `caller`, and returns the outcome whether it succeeded or not.
    pub async fn call(
        &self,
        caller: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> ExecutionFinalResult {
        send(&self.network, &self.signer, caller, contract, method, args, deposit).await
    }

    /// As `call`, but runs in the background, for calls that wait on a yield until the test resumes them.
    pub fn call_in_background(
        &self,
        caller: &AccountId,
        contract: &AccountId,
        method: &'static str,
        args: Value,
        deposit: NearToken,
    ) -> tokio::task::JoinHandle<ExecutionFinalResult> {
        let (network, signer, caller, contract) =
            (self.network.clone(), self.signer.clone(), caller.clone(), contract.clone());
        tokio::spawn(async move { send(&network, &signer, &caller, &contract, method, args, deposit).await })
    }

    /// `call` with no deposit, which must succeed.
    pub async fn ok(&self, caller: &AccountId, contract: &AccountId, method: &str, args: Value) {
        self.ok_with(caller, contract, method, args, NearToken::from_yoctonear(0)).await
    }

    /// `call` with a deposit, which must succeed.
    pub async fn ok_with(
        &self,
        caller: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) {
        let result = self.call(caller, contract, method, args, deposit).await;
        assert_ok(&result, method);
    }

    pub async fn view<T: serde::de::DeserializeOwned + Send + Sync>(
        &self,
        contract: &AccountId,
        method: &str,
        args: Value,
    ) -> T {
        Contract(contract.clone())
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.network)
            .await
            .unwrap_or_else(|e| panic!("view {method} failed: {e:?}"))
            .data
    }

    /// As `view`, but returns the error, as text, instead of panicking.
    pub async fn try_view<T: serde::de::DeserializeOwned + Send + Sync>(
        &self,
        contract: &AccountId,
        method: &str,
        args: Value,
    ) -> Result<T, String> {
        let call = Contract(contract.clone()).call_function(method, args).read_only();
        call.fetch_from(&self.network).await.map(|r| r.data).map_err(|e| format!("{e:?}"))
    }

    pub async fn fast_forward(&self, blocks: u64) {
        self._node.fast_forward(blocks).await.expect("fast-forward failed");
    }

    /// The latest block height.
    pub async fn height(&self) -> u64 {
        near_api::Chain::block_number().fetch_from(&self.network).await.expect("no block height")
    }

    /// An account's NEAR balance, in yoctoNEAR.
    pub async fn balance(&self, account: &AccountId) -> u128 {
        let balance = near_api::Tokens::account(account.clone()).near_balance().fetch_from(&self.network).await;
        balance.expect("no balance").total.as_yoctonear()
    }
}

async fn send(
    network: &NetworkConfig,
    signer: &Arc<Signer>,
    caller: &AccountId,
    contract: &AccountId,
    method: &str,
    args: Value,
    deposit: NearToken,
) -> ExecutionFinalResult {
    Contract(contract.clone())
        .call_function(method, args)
        .transaction()
        .gas(NearGas::from_tgas(300))
        .deposit(deposit)
        .with_signer(caller.clone(), signer.clone())
        .wait_until(TxExecutionStatus::ExecutedOptimistic)
        .send_to(network)
        .await
        .unwrap_or_else(|e| panic!("{method} could not be sent: {e:?}"))
        .into_full()
        .expect("the outcome is complete")
}

/// Asserts that a call and all its receipts succeeded.
pub fn assert_ok(result: &ExecutionFinalResult, what: &str) {
    assert!(result.clone().into_result().is_ok(), "{what} failed: {result:?}");
    assert!(result.receipt_failures().is_empty(), "{what} had a failing receipt: {result:?}");
}

/// Whether the call logged a `pb-pool` event with this name.
pub fn has_event(result: &ExecutionFinalResult, event: &str) -> bool {
    let needle = format!(r#""event":"{event}""#);
    result.logs().iter().any(|log| log.starts_with("EVENT_JSON:") && log.contains(&needle))
}

/// Asserts that a call was refused somewhere in its receipts with a message containing `expected`.
pub fn assert_refused(result: &ExecutionFinalResult, expected: &str) {
    let text = format!("{result:?}");
    let failed = result.clone().into_result().is_err() || !result.receipt_failures().is_empty();
    assert!(failed && text.contains(expected), "expected a refusal with {expected:?}, got {text}");
}

pub fn one_yocto() -> NearToken {
    NearToken::from_yoctonear(1)
}

pub fn yocto(amount: u128) -> NearToken {
    NearToken::from_yoctonear(amount)
}

pub fn str_u128(value: &Value) -> u128 {
    value.as_str().unwrap_or_else(|| panic!("{value} is not a U128 string")).parse().unwrap()
}

/// A verdict for the pool's `borrow` (contracts/pool/src/types.rs `BorrowVerdict`).
pub fn verdict(tier: &str, allow: u128) -> Value {
    json!({ "tier": tier, "allow_borrow": allow.to_string(), "shares_bp": {}, "hold": {}, "hl_eq": "0" })
}
