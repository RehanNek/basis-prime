//! Factory: creates one account contract per client and registers it with the pool (PLAN.md 5.1; INTERFACES.md 3).
//!
//! `create_account(name, owner, permission)` makes `<name>.<factory>` in one transaction:
//! 1. creates the account, funds it with the caller's deposit, deploys the account code the factory carries
//!    (`include_bytes!`) and calls `new({owner, config, permission})`. `permission` is the owner's funding
//!    permission (FUNDING.md 4.2), so opening and permitting are one signature; left out or null, there is none;
//! 2. then registers the account's storage on every configured token, and registers it with the pool, which starts
//!    its first week;
//! 3. refunds the caller if a step fails: all of the deposit if the account couldn't be created, and the deposit of
//!    any registration that failed.
//!
//! Once the account exists, the factory adds it to its list, which the keeper and the web app page through with
//! `list_accounts` (an account whose registration failed is listed too, because it exists and can hold funds).
//!
//! Only the factory can create `*.<factory>` names, so the pool can trust that every account it registers runs this
//! code. Build the account first (`contracts/build.sh`), because the factory embeds its wasm.
//!
//! Upgrading from Phase 5 (the code on testnet since 9 Nov): deploy this code with the init call `migrate({})` or
//! `migrate({lenders})`, in one transaction. It keeps the operator, the config, the pause flag and the list, and adds
//! the config's Phase 6 field, `lenders` (FUNDING.md 4.1).
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::Vector;
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};

pub use pb_types::{Config, Gateway, Lenders, Permission, Program, SecretsRef, TokenConfig};

/// The account contract's wasm. Unit tests don't need it, so they compile without it.
#[cfg(not(test))]
const ACCOUNT_WASM: &[u8] = include_bytes!("../../target/near/pb_account/pb_account.wasm");
#[cfg(test)]
const ACCOUNT_WASM: &[u8] = b"";

/// `create_account` needs at least 6 NEAR: about 5.16 for the account's code and state (the code that runs Rhea's
/// steps, signs Aave's transactions and makes the moves to Aave's chain is 515 KB, and a byte locks 10^19
/// yoctoNEAR), the registrations, and the rest, 0.82 NEAR, for the account's own use: 0.1 NEAR to register with
/// Rhea, and room for its state to grow. It was 4 NEAR up to Phase 5 and 5 NEAR for the first Phase 6 code (433 KB),
/// which no longer covers this code.
const MIN_DEPOSIT: NearToken = NearToken::from_near(6);
/// What a NEP-145 token charges to register an account.
const TOKEN_STORAGE: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
/// The pool charges about 0.014 NEAR for an account's record and refunds the rest to the factory.
const POOL_STORAGE: NearToken = NearToken::from_millinear(20);
/// The factory's own record of each account (at most about 190 bytes).
const RECORD_STORAGE: NearToken = NearToken::from_millinear(2);
/// `list_accounts` returns at most this many accounts per call.
const MAX_PAGE: u32 = 100;
const GAS_FOR_NEW: Gas = Gas::from_tgas(20);
const GAS_FOR_REGISTER: Gas = Gas::from_tgas(10);
const GAS_FOR_ON_REGISTERED: Gas = Gas::from_tgas(10);
/// What `create_account` needs above `on_created`'s gas, for itself and for making the account with its code.
const GAS_ABOVE_ON_CREATED: Gas = Gas::from_tgas(110);

/// The static gas `on_created` gets: 30 TGas for itself, and 10 for each call it makes: the pool's `register`, one
/// `storage_deposit` per token, and `on_registered`. That is 70 TGas with 2 tokens and 130 with 8. A fixed 70 didn't
/// cover the calls from 5 tokens up (research/audit.md, F2).
fn gas_for_on_created(tokens: usize) -> Gas {
    Gas::from_tgas(30).saturating_add(GAS_FOR_REGISTER.saturating_mul(tokens as u64 + 2))
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Accounts,
}

/// One account the factory created: its id, its owner, and when it was created (block timestamp, ns).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AccountRecord {
    pub account_id: AccountId,
    pub owner: AccountId,
    pub created_at: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    operator: AccountId,
    config: Config,
    paused: bool,
    /// Every account created, oldest first.
    accounts: Vector<AccountRecord>,
}

/// The factory's state in Phases 3 to 5, which `pbf.testnet` holds until the Phase 6 upgrade. Its config has no
/// `lenders` yet.
#[near(serializers = [borsh])]
struct FactoryV5 {
    operator: AccountId,
    config: ConfigV5,
    paused: bool,
    accounts: Vector<AccountRecord>,
}

/// Phase 5's config: the fields of `Config` up to `hl_usdc_token`, in the same order.
#[near(serializers = [borsh])]
struct ConfigV5 {
    tokens: Vec<TokenConfig>,
    pool_id: AccountId,
    mpc_id: AccountId,
    outlayer_id: AccountId,
    risk: Program,
    hl_chain: String,
    signature_chain_id: String,
    usdc_token: AccountId,
    params_hash: String,
    model: String,
    drill_id: AccountId,
    gateway: Gateway,
    hl_usdc_token: String,
}

impl ConfigV5 {
    fn with_phase_6(self, lenders: Lenders) -> Config {
        Config {
            tokens: self.tokens,
            pool_id: self.pool_id,
            mpc_id: self.mpc_id,
            outlayer_id: self.outlayer_id,
            risk: self.risk,
            hl_chain: self.hl_chain,
            signature_chain_id: self.signature_chain_id,
            usdc_token: self.usdc_token,
            params_hash: self.params_hash,
            model: self.model,
            drill_id: self.drill_id,
            gateway: self.gateway,
            hl_usdc_token: self.hl_usdc_token,
            lenders,
        }
    }
}

#[near]
impl Factory {
    /// `operator` can change the config for new accounts and pause creation.
    #[init]
    pub fn new(operator: AccountId, config: Config) -> Self {
        config.assert_valid();
        Self { operator, config, paused: false, accounts: Vector::new(StorageKey::Accounts) }
    }

    /// Moves the Phase 5 state to this one. The config gains `lenders`: the ones given, or none when `lenders` is left
    /// out or null (`set_config` can add them later). Everything else, the list of accounts included, stays as it
    /// was. The factory account only, in the same transaction as the code upgrade. It refuses any other state, so it
    /// can't run twice. Accounts created before keep their config and code.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(lenders: Option<Lenders>) -> Self {
        let old: FactoryV5 = env::state_read().unwrap_or_else(|| env::panic_str("no Phase 5 state to migrate"));
        let config = old.config.with_phase_6(lenders.unwrap_or_default());
        config.assert_valid();
        log!("migrated the factory: its config now has a place for the lenders new accounts may use");
        Self { operator: old.operator, config, paused: old.paused, accounts: old.accounts }
    }

    /// Creates `<name>.<factory>` for `owner`. Attach at least 6 NEAR, which goes to the new account less its
    /// registrations, and 300 TGas. Returns whether every step succeeded; any failure is logged and refunded.
    ///
    /// It refuses less gas than its callback's calls need: 110 TGas more than `on_created` gets, which is 180 TGas
    /// with 2 tokens in the config and 240 with 8. The refusal says the figure.
    ///
    /// `permission` is the owner's funding permission, which goes to the account's `new` as it is. It may be left out
    /// or null: the account then borrows from our pool only. One that doesn't fit the config's lenders is refused
    /// here, before anything is created, with what to fix.
    #[payable]
    pub fn create_account(&mut self, name: String, owner: AccountId, permission: Option<Permission>) -> Promise {
        require!(!self.paused, "the factory is paused");
        if let Some(problem) = permission.as_ref().and_then(|p| p.problem(&self.config.lenders)) {
            env::panic_str(&problem);
        }
        let account_id = self.account_for(name);
        let deposit = env::attached_deposit();
        require!(deposit >= MIN_DEPOSIT, "attach at least 6 NEAR");
        let tokens: Vec<AccountId> = self.config.tokens.iter().map(|t| t.id.clone()).collect();
        let for_on_created = gas_for_on_created(tokens.len());
        let least = for_on_created.saturating_add(GAS_ABOVE_ON_CREATED);
        require!(
            env::prepaid_gas() >= least,
            format!("attach at least {} TGas: 300 TGas is the safe amount", least.as_tgas())
        );
        let kept = registration_cost(tokens.len()).saturating_add(RECORD_STORAGE);
        let init = json!({ "owner": owner, "config": self.config, "permission": permission });
        Promise::new(account_id.clone())
            .create_account()
            .transfer(deposit.saturating_sub(kept))
            .deploy_contract(ACCOUNT_WASM)
            .function_call("new", to_bytes(&init), NearToken::from_yoctonear(0), GAS_FOR_NEW)
            .then(Self::ext(env::current_account_id()).with_static_gas(for_on_created).on_created(
                account_id,
                owner,
                env::predecessor_account_id(),
                U128(deposit.as_yoctonear()),
                tokens,
            ))
    }

    /// After the account is made: adds it to the list, then registers it on each token and with the pool. If the
    /// account couldn't be made, refunds the whole deposit instead and lists nothing. Never panics.
    #[private]
    pub fn on_created(
        &mut self,
        account_id: AccountId,
        owner: AccountId,
        caller: AccountId,
        deposit: U128,
        tokens: Vec<AccountId>,
    ) -> PromiseOrValue<bool> {
        if !succeeded(0) {
            // The failed batch's deposit came back to the factory before this callback ran.
            log!("could not create {account_id}; refunding {} yoctoNEAR to {caller}", deposit.0);
            Promise::new(caller).transfer(NearToken::from_yoctonear(deposit.0)).detach();
            return PromiseOrValue::Value(false);
        }
        let record = AccountRecord { account_id: account_id.clone(), owner, created_at: U64(env::block_timestamp()) };
        self.accounts.push(record);
        let register = json!({ "account_id": account_id });
        let mut all = Promise::new(self.config.pool_id.clone()).function_call(
            "register",
            to_bytes(&register),
            POOL_STORAGE,
            GAS_FOR_REGISTER,
        );
        let storage = json!({ "account_id": account_id, "registration_only": true });
        for token in &tokens {
            let one = Promise::new(token.clone()).function_call(
                "storage_deposit",
                to_bytes(&storage),
                TOKEN_STORAGE,
                GAS_FOR_REGISTER,
            );
            all = all.and(one);
        }
        PromiseOrValue::Promise(
            all.then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_REGISTERED)
                    .on_registered(account_id, caller, tokens),
            ),
        )
    }

    /// Logs any registration that failed and refunds its deposit to the caller. Never panics.
    #[private]
    pub fn on_registered(&mut self, account_id: AccountId, caller: AccountId, tokens: Vec<AccountId>) -> bool {
        let pool = self.config.pool_id.clone();
        let mut refund = NearToken::from_yoctonear(0);
        // Result 0 is the pool's `register`, then one per token, in order.
        let names = std::iter::once(&pool).chain(tokens.iter());
        for (i, name) in (0..env::promise_results_count()).zip(names) {
            if !succeeded(i) {
                log!("could not register {account_id} with {name}");
                refund = refund.saturating_add(if i == 0 { POOL_STORAGE } else { TOKEN_STORAGE });
            }
        }
        if refund.is_zero() {
            log!("created {account_id}");
            return true;
        }
        Promise::new(caller).transfer(refund).detach();
        false
    }

    // ---------------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------------

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    /// The account id `create_account` would make for `name`: `<name>.<factory>`. `name` must be a single label of
    /// lower-case letters, digits, `-` and `_`.
    pub fn account_for(&self, name: String) -> AccountId {
        require!(!name.is_empty() && !name.contains('.'), "name must be one label, without dots");
        format!("{name}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("name must use only a-z, 0-9, - and _, and fit a 64-byte account id"))
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// The accounts created, oldest first: up to `limit` (at most 100, the default) from `from_index` (default 0).
    pub fn list_accounts(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<AccountRecord> {
        let from = from_index.unwrap_or(0);
        let to = from.saturating_add(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE)).min(self.accounts.len());
        (from..to).filter_map(|i| self.accounts.get(i).cloned()).collect()
    }

    pub fn accounts_count(&self) -> u32 {
        self.accounts.len()
    }

    /// The sha256 (hex) of the account code the factory deploys, so anyone can match it to a build.
    pub fn account_code_hash(&self) -> String {
        env::sha256(ACCOUNT_WASM).iter().map(|b| format!("{b:02x}")).collect()
    }

    // ---------------------------------------------------------------------------------------------------------
    // Admin (the operator only)
    // ---------------------------------------------------------------------------------------------------------

    /// Replaces the config. It applies to accounts created from now on; existing accounts keep theirs.
    pub fn set_config(&mut self, config: Config) {
        self.assert_operator();
        config.assert_valid();
        self.config = config;
        log!("config updated for new accounts");
    }

    /// Pauses or resumes account creation.
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_operator();
        self.paused = paused;
        log!("account creation {}", if paused { "paused" } else { "resumed" });
    }
}

impl Factory {
    fn assert_operator(&self) {
        require!(env::predecessor_account_id() == self.operator, "only the operator can do this");
    }
}

/// What the factory keeps from the deposit to pay for the registrations: the pool's record and each token's.
fn registration_cost(tokens: usize) -> NearToken {
    TOKEN_STORAGE.saturating_mul(tokens as u128).saturating_add(POOL_STORAGE)
}

/// Whether promise result `i` succeeded. Its value isn't read (a result too long to read still succeeded).
fn succeeded(i: u64) -> bool {
    !matches!(env::promise_result_checked(i, 0), Err(PromiseError::Failed))
}

fn to_bytes(value: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

    const FACTORY: &str = "pbf.testnet";
    const OPERATOR: &str = "ops.testnet";

    fn id(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn config() -> Config {
        Config {
            tokens: vec![
                TokenConfig { id: id("musdc.testnet"), symbol: "USDC".into(), decimals: 6 },
                TokenConfig { id: id("mnbtc.testnet"), symbol: "nBTC".into(), decimals: 8 },
            ],
            pool_id: id("pool.pbf.testnet"),
            mpc_id: id("v1.signer-prod.testnet"),
            outlayer_id: id("outlayer.testnet"),
            risk: Program { project_id: "keeper.testnet/pb-risk".into(), version_key: String::new() },
            hl_chain: "Testnet".into(),
            signature_chain_id: "0x66eee".into(),
            usdc_token: id("musdc.testnet"),
            params_hash: "cd".repeat(32),
            model: "B-0.2".into(),
            drill_id: id("drill.testnet"),
            gateway: gateway(),
            hl_usdc_token: HL_USDC.into(),
            lenders: Default::default(),
        }
    }

    const HL_USDC: &str = "USDC:0xeb62eee3685fc4c43992febcd9e75443";

    fn gateway() -> Gateway {
        Gateway { project_id: "pbf-keeper.testnet/pb-gateway".into(), version_key: String::new(), secrets_ref: None }
    }

    fn call(caller: &str, deposit: NearToken, results: Vec<PromiseResult>) {
        let context = VMContextBuilder::new()
            .current_account_id(id(FACTORY))
            .predecessor_account_id(id(caller))
            .attached_deposit(deposit)
            .prepaid_gas(Gas::from_tgas(300))
            .build();
        testing_env!(context, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
    }

    /// The NEAR transferred by the receipt's Transfer action, if it has one.
    fn transferred(actions: &[MockAction]) -> Option<NearToken> {
        actions.iter().find_map(|a| match a {
            MockAction::Transfer { deposit, .. } => Some(*deposit),
            _ => None,
        })
    }

    fn factory() -> Factory {
        call(OPERATOR, NearToken::from_yoctonear(0), vec![]);
        Factory::new(id(OPERATOR), config())
    }

    #[test]
    fn names_become_sub_accounts_of_the_factory() {
        let f = factory();
        assert_eq!(f.account_for("alice".into()), id("alice.pbf.testnet"));
        assert_eq!(f.account_for("desk-7_b".into()), id("desk-7_b.pbf.testnet"));
    }

    #[test]
    #[should_panic(expected = "name must be one label, without dots")]
    fn a_name_with_a_dot_is_refused() {
        factory().account_for("a.b".into());
    }

    #[test]
    #[should_panic(expected = "name must use only a-z")]
    fn a_name_with_capitals_is_refused() {
        factory().account_for("Alice".into());
    }

    #[test]
    fn create_account_funds_and_deploys_the_new_account() {
        let mut f = factory();
        call("client.testnet", NearToken::from_near(6), vec![]);
        f.create_account("alice".into(), id("client.testnet"), None).detach();
        let receipts = get_created_receipts();
        assert_eq!(receipts[0].receiver_id, id("alice.pbf.testnet"));
        // Create, fund with the deposit less 0.0225 NEAR for the registrations, deploy, then `new`.
        let actions = &receipts[0].actions;
        assert!(matches!(actions[0], MockAction::CreateAccount { .. }));
        assert_eq!(registration_cost(2), NearToken::from_yoctonear(22_500_000_000_000_000_000_000));
        let kept = registration_cost(2).saturating_add(RECORD_STORAGE);
        assert_eq!(transferred(actions), Some(NearToken::from_near(6).saturating_sub(kept)));
        assert!(matches!(actions[2], MockAction::DeployContract { .. }));
        let MockAction::FunctionCallWeight { method_name, args, .. } = &actions[3] else { panic!("no call to new") };
        assert_eq!(method_name.as_slice(), b"new");
        let args: serde_json::Value = serde_json::from_slice(args).unwrap();
        assert_eq!(args["owner"], "client.testnet");
        assert_eq!(args["config"], serde_json::to_value(config()).unwrap());
    }

    #[test]
    #[should_panic(expected = "attach at least 6 NEAR")]
    fn create_account_needs_6_near() {
        let mut f = factory();
        call("client.testnet", NearToken::from_millinear(5_999), vec![]);
        f.create_account("alice".into(), id("client.testnet"), None).detach();
    }

    #[test]
    #[should_panic(expected = "the factory is paused")]
    fn a_paused_factory_creates_nothing() {
        let mut f = factory();
        f.set_paused(true);
        assert!(f.is_paused());
        call("client.testnet", NearToken::from_near(6), vec![]);
        f.create_account("alice".into(), id("client.testnet"), None).detach();
    }

    #[test]
    fn a_failed_creation_refunds_the_whole_deposit() {
        let mut f = factory();
        call(FACTORY, NearToken::from_yoctonear(0), vec![PromiseResult::Failed]);
        let tokens = vec![id("musdc.testnet"), id("mnbtc.testnet")];
        let done = f.on_created(id("alice.pbf.testnet"), id("owner.testnet"), id("client.testnet"), U128(5), tokens);
        assert!(matches!(done, PromiseOrValue::Value(false)));
        let receipts = get_created_receipts();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].receiver_id, id("client.testnet"));
        assert_eq!(transferred(&receipts[0].actions), Some(NearToken::from_yoctonear(5)));
    }

    #[test]
    fn a_created_account_is_registered_with_the_pool_and_each_token() {
        let mut f = factory();
        call(FACTORY, NearToken::from_yoctonear(0), vec![PromiseResult::Successful(vec![])]);
        let tokens = vec![id("musdc.testnet"), id("mnbtc.testnet")];
        let done = f.on_created(id("alice.pbf.testnet"), id("owner.testnet"), id("client.testnet"), U128(5), tokens);
        assert!(matches!(done, PromiseOrValue::Promise(_)));
        drop(done); // A promise is scheduled when it is dropped.
        let receivers: Vec<_> = get_created_receipts().into_iter().map(|r| r.receiver_id).collect();
        for expected in ["pool.pbf.testnet", "musdc.testnet", "mnbtc.testnet", FACTORY] {
            assert!(receivers.contains(&id(expected)), "no receipt to {expected}: {receivers:?}");
        }
    }

    #[test]
    fn a_failed_creation_is_not_listed() {
        let mut f = factory();
        call(FACTORY, NearToken::from_yoctonear(0), vec![PromiseResult::Failed]);
        drop(f.on_created(id("alice.pbf.testnet"), id("owner.testnet"), id("client.testnet"), U128(5), vec![]));
        assert_eq!(f.accounts_count(), 0);
        assert!(f.list_accounts(None, None).is_empty());
    }

    #[test]
    fn a_created_account_is_listed_with_its_owner_and_time() {
        let mut f = factory();
        let context = VMContextBuilder::new()
            .current_account_id(id(FACTORY))
            .predecessor_account_id(id(FACTORY))
            .block_timestamp(77)
            .build();
        let results = vec![PromiseResult::Successful(vec![])];
        testing_env!(context, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
        drop(f.on_created(id("alice.pbf.testnet"), id("owner.testnet"), id("client.testnet"), U128(5), vec![]));
        let listed =
            AccountRecord { account_id: id("alice.pbf.testnet"), owner: id("owner.testnet"), created_at: U64(77) };
        assert_eq!((f.accounts_count(), f.list_accounts(None, None)), (1, vec![listed]));
    }

    #[test]
    fn the_list_comes_in_pages_of_at_most_100() {
        let mut f = factory();
        for i in 0..150 {
            let account_id = id(&format!("a{i}.pbf.testnet"));
            f.accounts.push(AccountRecord { account_id, owner: id("owner.testnet"), created_at: U64(i) });
        }
        assert_eq!(f.accounts_count(), 150);
        assert_eq!(f.list_accounts(None, None).len(), 100);
        assert_eq!(f.list_accounts(None, Some(1_000)).len(), 100);
        let page = f.list_accounts(Some(140), Some(5));
        assert_eq!(page.iter().map(|r| r.created_at.0).collect::<Vec<_>>(), vec![140, 141, 142, 143, 144]);
        assert_eq!(f.list_accounts(Some(100), None).len(), 50);
        assert!(f.list_accounts(Some(150), None).is_empty());
        assert!(f.list_accounts(Some(u32::MAX), Some(u32::MAX)).is_empty());
    }

    /// `pbf.testnet`'s state on 9 Nov (block 276,830,850), as `tests/fetch_live.py` read it with the RPC's
    /// `view_state` into `target/live/factory.state.json`: the `STATE` value, then the six account records of its
    /// list (keys 0x00 and the index as 4 bytes, little-endian). Its code was the Phase 4 build, whose layout Phase 5
    /// kept.
    const TESTNET_STATE: &str = "0f0000007062662d6f70732e746573746e657402000000150000006d757364632e7062662d6f70732e746573746e6574040000005553444306150000006d6e6274632e7062662d6f70732e746573746e6574040000006e4254430810000000706f6f6c2e7062662e746573746e65741600000076312e7369676e65722d70726f642e746573746e6574100000006f75746c617965722e746573746e65741a0000007062662d6b65657065722e746573746e65742f70622d7269736b400000003561326132613230363232303766303935396564363363663362386232363633623730613435306137336265383339633663343234306433393233633438663407000000546573746e65740700000030783636656565150000006d757364632e7062662d6f70732e746573746e6574400000003364333632623433346164616164306530633930393630356264373932323332616366393634623931343361393563636232353431613066363563346332363305000000422d302e32150000006472696c6c2e7062662d6f70732e746573746e65741d0000007062662d6b65657065722e746573746e65742f70622d6761746577617940000000363734363339336138323864613965396633636233303266316531613537643163353064313034326436366333623761363539663538363532613734376566620027000000555344433a3078656236326565653336383566633463343339393266656263643965373534343300060000000100000000";
    const TESTNET_RECORDS: [&str; 6] = [
        "1100000064656d6f312e7062662e746573746e6574120000007062662d6b65657065722e746573746e65741650214885c1e518",
        "19000000717569657468617265363030312e7062662e746573746e657415000000717569657468617265363030312e746573746e6574f1e8ff1705e3e518",
        "120000006865646765312e7062662e746573746e6574120000007062662d6b65657065722e746573746e6574e054577ddf0ce618",
        "1b0000007175696574686172652d68656467652e7062662e746573746e657415000000717569657468617265363030312e746573746e6574d66f63d4aa0ee618",
        "120000006472696c6c312e7062662e746573746e6574120000007062662d6b65657065722e746573746e65744f07c1aaa415e618",
        "130000006661756c7473312e7062662e746573746e6574120000007062662d6b65657065722e746573746e65746f6d8fb49e16e618",
    ];

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// Puts `pbf.testnet`'s Phase 5 state into the test's storage.
    fn testnet_state() {
        call(FACTORY, NearToken::from_yoctonear(0), vec![]);
        env::storage_write(b"STATE", &unhex(TESTNET_STATE));
        for (i, record) in TESTNET_RECORDS.iter().enumerate() {
            let key = [&[0u8][..], &(i as u32).to_le_bytes()].concat();
            env::storage_write(&key, &unhex(record));
        }
    }

    /// Lenders that fit the testnet config: Rhea taking the test nBTC, and Aave on Base Sepolia (INTERFACES.md 24).
    fn lenders() -> Lenders {
        serde_json::from_value(json!({
            "rhea": { "contract_id": "rhea.pbf-ops.testnet", "collateral": ["mnbtc.pbf-ops.testnet"] },
            "aave": {
                "chain_id": 84532, "pool": "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
                "usdc": { "symbol": "USDC", "address": "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", "decimals": 6 },
                "collateral": [
                    { "symbol": "WBTC", "address": "0x54114591963CF60EF3aA63bEfD6eC263D98145a4", "decimals": 8 },
                ],
                "max_fee_per_gas": "5000000000",
            },
        }))
        .unwrap()
    }

    fn permission() -> Permission {
        let terms = json!({ "lenders": ["aave", "rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any" });
        serde_json::from_value(terms).unwrap()
    }

    #[test]
    fn migrate_upgrades_the_testnet_factorys_phase_5_state() {
        testnet_state();
        let f = Factory::migrate(None);
        let c = f.get_config();
        assert_eq!((f.operator.as_str(), f.is_paused()), ("pbf-ops.testnet", false));
        // Every Phase 5 field is as `get_config` showed it on testnet.
        let tokens: Vec<&str> = c.tokens.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(tokens, vec!["musdc.pbf-ops.testnet", "mnbtc.pbf-ops.testnet"]);
        assert_eq!((c.pool_id.as_str(), c.mpc_id.as_str()), ("pool.pbf.testnet", "v1.signer-prod.testnet"));
        assert_eq!(c.outlayer_id.as_str(), "outlayer.testnet");
        assert_eq!(c.risk.project_id, "pbf-keeper.testnet/pb-risk");
        assert_eq!(c.risk.version_key, "5a2a2a2062207f0959ed63cf3b8b2663b70a450a73be839c6c4240d3923c48f4");
        assert_eq!((c.hl_chain.as_str(), c.signature_chain_id.as_str()), ("Testnet", "0x66eee"));
        assert_eq!(c.usdc_token.as_str(), "musdc.pbf-ops.testnet");
        assert_eq!(c.params_hash, "3d362b434adaad0e0c909605bd792232acf964b9143a95ccb2541a0f65c4c263");
        assert_eq!((c.model.as_str(), c.drill_id.as_str()), ("B-0.2", "drill.pbf-ops.testnet"));
        let gateway = Gateway {
            project_id: "pbf-keeper.testnet/pb-gateway".into(),
            version_key: "6746393a828da9e9f3cb302f1e1a57d1c50d1042d66c3b7a659f58652a747efb".into(),
            secrets_ref: None,
        };
        assert_eq!((c.gateway, c.hl_usdc_token.as_str()), (gateway, HL_USDC));
        // The new field starts empty: no lenders until the operator sets some.
        assert!(c.lenders.is_empty());
        // The list is kept.
        assert_eq!(f.accounts_count(), 6);
        let listed: Vec<(String, String, u64)> = f
            .list_accounts(None, Some(2))
            .into_iter()
            .map(|r| (r.account_id.to_string(), r.owner.to_string(), r.created_at.0))
            .collect();
        let expected = vec![
            ("demo1.pbf.testnet".to_string(), "pbf-keeper.testnet".to_string(), 1_794_052_804_761_964_566),
            ("quiethare6001.pbf.testnet".to_string(), "quiethare6001.testnet".to_string(), 1_794_089_637_593_999_601),
        ];
        assert_eq!(listed, expected);
        let last = f.list_accounts(Some(5), None);
        assert_eq!(
            (last[0].account_id.as_str(), last[0].owner.as_str()),
            ("faults1.pbf.testnet", "pbf-keeper.testnet")
        );
    }

    #[test]
    fn migrate_can_set_the_lenders_in_the_same_call() {
        testnet_state();
        let f = Factory::migrate(Some(lenders()));
        assert_eq!(f.get_config().lenders, lenders());
        assert_eq!(f.accounts_count(), 6);
        // The config now backs a permission that names both lenders.
        assert_eq!(permission().problem(&f.get_config().lenders), None);
    }

    #[test]
    fn the_migrated_factory_can_still_create_and_list_accounts() {
        testnet_state();
        let mut f = Factory::migrate(None);
        call(FACTORY, NearToken::from_yoctonear(0), vec![PromiseResult::Successful(vec![])]);
        drop(f.on_created(id("alice.pbf.testnet"), id("owner.testnet"), id("client.testnet"), U128(5), vec![]));
        assert_eq!(f.accounts_count(), 7);
        assert_eq!(f.list_accounts(Some(6), None)[0].account_id, id("alice.pbf.testnet"));
    }

    #[test]
    #[should_panic(expected = "lenders.rhea.collateral must be listed tokens other than usdc_token")]
    fn migrate_refuses_lenders_that_do_not_fit_the_config() {
        testnet_state();
        let mut bad = lenders();
        bad.rhea.as_mut().unwrap().collateral = vec![id("musdc.pbf-ops.testnet")];
        Factory::migrate(Some(bad));
    }

    #[test]
    #[should_panic(expected = "Cannot deserialize the contract state")]
    fn migrate_refuses_a_state_that_is_already_migrated() {
        testnet_state();
        let f = Factory::migrate(None);
        call(FACTORY, NearToken::from_yoctonear(0), vec![]);
        env::state_write(&f);
        Factory::migrate(None);
    }

    #[test]
    #[should_panic(expected = "Cannot deserialize the contract state")]
    fn migrate_refuses_a_migrated_state_that_has_lenders_too() {
        testnet_state();
        let f = Factory::migrate(Some(lenders()));
        call(FACTORY, NearToken::from_yoctonear(0), vec![]);
        env::state_write(&f);
        Factory::migrate(Some(lenders()));
    }

    #[test]
    #[should_panic(expected = "no Phase 5 state to migrate")]
    fn migrate_needs_a_state() {
        call(FACTORY, NearToken::from_yoctonear(0), vec![]);
        Factory::migrate(None);
    }

    /// A config with `n` tokens: the two test tokens, then more.
    fn config_with_tokens(n: usize) -> Config {
        let mut c = config();
        for i in 2..n {
            c.tokens.push(TokenConfig { id: id(&format!("token{i}.testnet")), symbol: format!("T{i}"), decimals: 8 });
        }
        c
    }

    /// As `call`, with `tgas` attached.
    fn call_with_gas(caller: &str, deposit: NearToken, tgas: u64) {
        let context = VMContextBuilder::new()
            .current_account_id(id(FACTORY))
            .predecessor_account_id(id(caller))
            .attached_deposit(deposit)
            .prepaid_gas(Gas::from_tgas(tgas))
            .build();
        testing_env!(context, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![]);
    }

    /// The static gas `create_account` gives `on_created`, with a config of `n` tokens.
    fn gas_for_on_created(n: usize) -> Gas {
        let mut f = factory();
        f.set_config(config_with_tokens(n));
        call("client.testnet", NearToken::from_near(6), vec![]);
        f.create_account("alice".into(), id("client.testnet"), None).detach();
        let receipts = get_created_receipts();
        let created = receipts.iter().find(|r| r.receiver_id == id(FACTORY)).expect("no receipt for on_created");
        let MockAction::FunctionCallWeight { method_name, prepaid_gas, .. } = &created.actions[0] else {
            panic!("on_created is not a function call")
        };
        assert_eq!(method_name.as_slice(), b"on_created");
        *prepaid_gas
    }

    #[test]
    fn on_created_gets_gas_for_every_call_it_makes() {
        // 30 TGas, and 10 for each call: the pool's register, one storage_deposit per token, and on_registered
        // (research/audit.md, F2). With 5 tokens or more, the old 70 TGas didn't cover them.
        assert_eq!(gas_for_on_created(2), Gas::from_tgas(70));
        assert_eq!(gas_for_on_created(5), Gas::from_tgas(100));
        assert_eq!(gas_for_on_created(8), Gas::from_tgas(130));
    }

    #[test]
    fn create_account_refuses_less_gas_than_its_callback_needs_and_says_how_much() {
        let refused_with = |tokens: usize, tgas: u64| {
            let mut f = factory();
            f.set_config(config_with_tokens(tokens));
            call_with_gas("client.testnet", NearToken::from_near(6), tgas);
            let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                f.create_account("alice".into(), id("client.testnet"), None).detach();
            }));
            refused.err().map(|words| words.downcast_ref::<String>().cloned().unwrap_or_default())
        };
        // 110 TGas more than on_created gets: 180 with today's 2 tokens, 240 with 8.
        assert_eq!(refused_with(2, 179).as_deref(), Some("attach at least 180 TGas: 300 TGas is the safe amount"));
        assert_eq!(refused_with(2, 180), None);
        assert_eq!(refused_with(8, 239).as_deref(), Some("attach at least 240 TGas: 300 TGas is the safe amount"));
        assert_eq!(refused_with(8, 240), None);
        assert_eq!(refused_with(8, 300), None);
    }

    #[test]
    fn create_account_passes_the_owners_permission_to_the_new_account() {
        let mut f = factory();
        let mut c = config();
        c.tokens[1].id = id("mnbtc.pbf-ops.testnet");
        c.lenders = lenders();
        f.set_config(c);
        call("client.testnet", NearToken::from_near(6), vec![]);
        f.create_account("alice".into(), id("client.testnet"), Some(permission())).detach();
        let receipts = get_created_receipts();
        let MockAction::FunctionCallWeight { method_name, args, .. } = &receipts[0].actions[3] else {
            panic!("no call to new")
        };
        assert_eq!(method_name.as_slice(), b"new");
        let args: serde_json::Value = serde_json::from_slice(args).unwrap();
        let terms = json!({ "lenders": ["aave", "rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any" });
        assert_eq!(args["permission"], terms);
        assert_eq!(args["config"]["lenders"]["rhea"]["contract_id"], "rhea.pbf-ops.testnet");
    }

    #[test]
    fn an_account_created_without_a_permission_gets_none() {
        let mut f = factory();
        call("client.testnet", NearToken::from_near(6), vec![]);
        f.create_account("alice".into(), id("client.testnet"), None).detach();
        let receipts = get_created_receipts();
        let MockAction::FunctionCallWeight { args, .. } = &receipts[0].actions[3] else { panic!("no call to new") };
        let args: serde_json::Value = serde_json::from_slice(args).unwrap();
        assert_eq!(args["permission"], serde_json::Value::Null);
        assert_eq!(args.as_object().unwrap().len(), 3);
    }

    #[test]
    #[should_panic(expected = "the permission names aave, which this account has no settings for")]
    fn a_permission_the_config_cannot_back_is_refused_before_anything_is_created() {
        // This factory's config has no lenders.
        let mut f = factory();
        call("client.testnet", NearToken::from_near(6), vec![]);
        f.create_account("alice".into(), id("client.testnet"), Some(permission())).detach();
    }

    #[test]
    #[should_panic(expected = "the permission's min_hf_bp must be 12000 to 50000")]
    fn a_permission_with_terms_out_of_range_is_refused() {
        let mut f = factory();
        let mut thin = permission();
        thin.lenders.clear();
        thin.min_hf_bp = 10_000;
        call("client.testnet", NearToken::from_near(6), vec![]);
        f.create_account("alice".into(), id("client.testnet"), Some(thin)).detach();
    }

    #[test]
    fn a_failed_registration_is_logged_and_its_deposit_refunded() {
        let mut f = factory();
        let ok = || PromiseResult::Successful(vec![]);
        call(FACTORY, NearToken::from_yoctonear(0), vec![ok(), PromiseResult::Failed, ok()]);
        let tokens = vec![id("musdc.testnet"), id("mnbtc.testnet")];
        assert!(!f.on_registered(id("alice.pbf.testnet"), id("client.testnet"), tokens));
        assert_eq!(get_logs(), vec!["could not register alice.pbf.testnet with musdc.testnet"]);
        let refund = get_created_receipts();
        assert_eq!(refund[0].receiver_id, id("client.testnet"));
        assert_eq!(transferred(&refund[0].actions), Some(TOKEN_STORAGE));
    }

    #[test]
    fn all_registrations_passing_is_a_success() {
        let mut f = factory();
        let ok = || PromiseResult::Successful(vec![]);
        call(FACTORY, NearToken::from_yoctonear(0), vec![ok(), ok(), ok()]);
        let tokens = vec![id("musdc.testnet"), id("mnbtc.testnet")];
        assert!(f.on_registered(id("alice.pbf.testnet"), id("client.testnet"), tokens));
        assert!(get_created_receipts().is_empty());
    }

    #[test]
    fn the_operator_changes_the_config_for_new_accounts() {
        let mut f = factory();
        let mut c = config();
        c.risk.version_key = "ab".repeat(32);
        c.gateway.version_key = "ef".repeat(32);
        c.gateway.secrets_ref = Some(SecretsRef { profile: "pb-gateway".into(), account_id: id("pbf-keeper.testnet") });
        f.set_config(c.clone());
        assert_eq!(f.get_config(), c);
        // The Phase 3 fields are in the JSON the factory passes to each new account's `new`.
        call("client.testnet", NearToken::from_near(6), vec![]);
        f.create_account("alice".into(), id("client.testnet"), None).detach();
        let receipts = get_created_receipts();
        let MockAction::FunctionCallWeight { args, .. } = &receipts[0].actions[3] else { panic!("no call to new") };
        let args: serde_json::Value = serde_json::from_slice(args).unwrap();
        let gateway = json!({
            "project_id": "pbf-keeper.testnet/pb-gateway", "version_key": "ef".repeat(32),
            "secrets_ref": { "profile": "pb-gateway", "account_id": "pbf-keeper.testnet" },
        });
        assert_eq!(args["config"]["gateway"], gateway);
        assert_eq!(args["config"]["hl_usdc_token"], HL_USDC);
    }

    #[test]
    #[should_panic(expected = "gateway.project_id must be 1 to 128 bytes")]
    fn a_config_without_a_gateway_project_is_refused() {
        let mut f = factory();
        let mut c = config();
        c.gateway.project_id = String::new();
        f.set_config(c);
    }

    #[test]
    #[should_panic(expected = "only the operator can do this")]
    fn only_the_operator_changes_the_config() {
        let mut f = factory();
        call("stranger.testnet", NearToken::from_yoctonear(0), vec![]);
        f.set_config(config());
    }

    #[test]
    #[should_panic(expected = "only the operator can do this")]
    fn only_the_operator_pauses() {
        let mut f = factory();
        call("stranger.testnet", NearToken::from_yoctonear(0), vec![]);
        f.set_paused(true);
    }

    #[test]
    #[should_panic(expected = "params_hash must be 64 hex characters")]
    fn a_bad_config_is_refused() {
        let mut f = factory();
        let mut c = config();
        c.params_hash = "x".into();
        f.set_config(c);
    }
}
