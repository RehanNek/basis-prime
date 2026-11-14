//! Test tokens for testnet only (PLAN.md 5.1): `mUSDC` (6 decimals) and `mNBTC` (8 decimals). One contract,
//! deployed once per token. It is a standard fungible token (NEP-141, with NEP-145 storage and NEP-148 metadata)
//! plus a public faucet.
//!
//! **The faucet.** `mint(account_id, amount)` creates `amount` new tokens (in the token's smallest unit) for
//! `account_id`. Anyone can call it, and there is no cap, because the tokens are worthless test money.
//! - If `account_id` is already registered, no deposit is needed.
//! - If it isn't, attach at least `storage_balance_bounds().min` (0.00125 NEAR on testnet) and `mint` registers it
//!   first, exactly as `storage_deposit` would.
//! - Any deposit beyond the registration cost goes back to the caller.
use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Accounts,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TestToken {
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
}

#[near]
impl TestToken {
    #[init]
    pub fn new(name: String, symbol: String, decimals: u8) -> Self {
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name,
            symbol,
            icon: None,
            reference: None,
            reference_hash: None,
            decimals,
        };
        metadata.assert_valid();
        Self { token: FungibleToken::new(StorageKey::Accounts), metadata }
    }

    /// The faucet: mints `amount` to `account_id`, registering it first if needed (see the module docs).
    #[payable]
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(amount.0 > 0, "amount must be positive");
        let mut refund = env::attached_deposit();
        if !self.token.accounts.contains_key(&account_id) {
            let cost = self.token.storage_balance_bounds().min;
            require!(
                refund >= cost,
                format!("{account_id} is not registered: attach at least {cost} so mint can register it")
            );
            self.token.internal_register_account(&account_id);
            refund = refund.saturating_sub(cost);
        }
        self.token.internal_deposit(&account_id, amount.0);
        FtMint { owner_id: &account_id, amount, memo: Some("faucet") }.emit();
        if !refund.is_zero() {
            Promise::new(env::predecessor_account_id()).transfer(refund).detach();
        }
    }
}

// The standard methods, delegated to near-contract-standards.

#[near]
impl FungibleTokenCore for TestToken {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for TestToken {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            log!("{sender_id} had unregistered, so {burned} refunded tokens were burned");
        }
        used.into()
    }
}

#[near]
impl StorageManagement for TestToken {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for TestToken {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn musdc() -> TestToken {
        testing_env!(VMContextBuilder::new().build());
        TestToken::new("Mock USDC".into(), "mUSDC".into(), 6)
    }

    /// Calls as `caller` with `deposit` attached.
    fn as_caller(caller: usize, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(caller))
            .attached_deposit(deposit)
            .build());
    }

    #[test]
    fn keeps_its_metadata() {
        let token = musdc();
        let meta = token.ft_metadata();
        assert_eq!((meta.name.as_str(), meta.symbol.as_str(), meta.decimals), ("Mock USDC", "mUSDC", 6));
        assert_eq!(meta.spec, FT_METADATA_SPEC);
    }

    #[test]
    fn mint_registers_a_new_account_when_the_deposit_covers_it() {
        let mut token = musdc();
        let cost = token.storage_balance_bounds().min;
        as_caller(0, cost.saturating_mul(2));
        token.mint(accounts(1), U128(5_000_000));
        assert_eq!(token.ft_balance_of(accounts(1)).0, 5_000_000);
        assert!(token.storage_balance_of(accounts(1)).is_some());
        assert_eq!(token.ft_total_supply().0, 5_000_000);
    }

    #[test]
    #[should_panic(expected = "is not registered: attach at least")]
    fn mint_refuses_an_unregistered_account_without_a_deposit() {
        let mut token = musdc();
        as_caller(0, NearToken::from_yoctonear(0));
        token.mint(accounts(1), U128(1));
    }

    #[test]
    fn mint_to_a_registered_account_needs_no_deposit_and_has_no_cap() {
        let mut token = musdc();
        as_caller(0, token.storage_balance_bounds().min);
        token.mint(accounts(1), U128(1));
        as_caller(2, NearToken::from_yoctonear(0));
        token.mint(accounts(1), U128(u128::MAX / 2));
        assert_eq!(token.ft_balance_of(accounts(1)).0, u128::MAX / 2 + 1);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn mint_refuses_zero() {
        let mut token = musdc();
        as_caller(0, token.storage_balance_bounds().min);
        token.mint(accounts(1), U128(0));
    }

    #[test]
    fn minted_tokens_transfer_like_any_nep141_token() {
        let mut token = musdc();
        let cost = token.storage_balance_bounds().min;
        as_caller(0, cost);
        token.mint(accounts(1), U128(100));
        as_caller(2, cost);
        token.storage_deposit(Some(accounts(2)), Some(true));
        as_caller(1, NearToken::from_yoctonear(1));
        token.ft_transfer(accounts(2), U128(40), None);
        assert_eq!((token.ft_balance_of(accounts(1)).0, token.ft_balance_of(accounts(2)).0), (60, 40));
    }
}
