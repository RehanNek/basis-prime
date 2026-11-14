//! Drill config, testnet only (PLAN.md 5.1; INTERFACES.md 5 and 21): the nBTC/BTC ratio π that `pb-risk` reads on
//! testnet in place of its two price readings, so the owner can simulate a bridge depeg. 10,000 bp means 1.0, and the
//! ratio is capped at 1.0 like the real reading.
//!
//! - **The shared ratio**, for every account: `set_ratio` and `get_ratio`.
//! - **Per-account ratios** (INTERFACES.md 21), so one person's drill can't shock every account on a shared demo:
//!   `set_ratio_for` and `clear_ratio_for`. `get_ratio_for` returns the account's own ratio if it has one, else the
//!   shared one.
//!
//! **Upgrading `drill.pbf-ops.testnet`** (its 7 Nov code holds only the owner and the shared ratio): deploy this code,
//! then call `migrate()` as the owner, or as the init call of the deploy itself. It keeps the owner and the shared
//! ratio, and starts with no per-account ratios.
use near_sdk::json_types::U64;
use near_sdk::store::LookupMap;
use near_sdk::{env, log, near, require, AccountId, BorshStorageKey, PanicOnDefault};

/// 1.0 in basis points.
const PAR_BP: u32 = 10_000;

/// The ratio and when it was last set (block timestamp, ns).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Ratio {
    pub bp: u32,
    pub set_at: U64,
}

/// One account's own ratio, as stored.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct OwnRatio {
    pub bp: u32,
    pub set_at: u64,
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    PerAccount,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Drill {
    owner: AccountId,
    bp: u32,
    set_at: u64,
    /// The accounts with their own ratio.
    per_account: LookupMap<AccountId, OwnRatio>,
}

/// The state of the 7 Nov code, which `drill.pbf-ops.testnet` holds until `migrate`.
#[near(serializers = [borsh])]
struct DrillV1 {
    owner: AccountId,
    bp: u32,
    set_at: u64,
}

#[near]
impl Drill {
    /// Starts at par (10,000 bp).
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self { owner, bp: PAR_BP, set_at: env::block_timestamp(), per_account: LookupMap::new(StorageKey::PerAccount) }
    }

    /// Moves the 7 Nov state to this one: the owner and the shared ratio stay as they were, and no account has its own
    /// ratio yet. The owner only, or the drill account itself, so it can be the deploy's init call (whoever holds the
    /// drill account's key can replace its code anyway). It refuses any other state, so it can't run twice.
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: DrillV1 = env::state_read().unwrap_or_else(|| env::panic_str("no drill state to migrate"));
        let caller = env::predecessor_account_id();
        require!(caller == old.owner || caller == env::current_account_id(), "only the owner can migrate the drill");
        log!("drill migrated: the shared ratio stays {} bp, and no account has its own yet", old.bp);
        Self { owner: old.owner, bp: old.bp, set_at: old.set_at, per_account: LookupMap::new(StorageKey::PerAccount) }
    }

    /// Sets the shared nBTC/BTC ratio, from 0 to 10,000 bp. The owner only.
    pub fn set_ratio(&mut self, bp: u32) {
        self.assert_owner_may_set(bp);
        self.bp = bp;
        self.set_at = env::block_timestamp();
        log!("nBTC/BTC ratio set to {bp} bp");
    }

    /// Gives `account_id` its own nBTC/BTC ratio, from 0 to 10,000 bp, in place of the shared one. The owner only.
    pub fn set_ratio_for(&mut self, account_id: AccountId, bp: u32) {
        self.assert_owner_may_set(bp);
        self.per_account.insert(account_id.clone(), OwnRatio { bp, set_at: env::block_timestamp() });
        log!("nBTC/BTC ratio for {account_id} set to {bp} bp");
    }

    /// Takes `account_id`'s own ratio away, so it reads the shared one again. The owner only. Returns whether the
    /// account had one.
    pub fn clear_ratio_for(&mut self, account_id: AccountId) -> bool {
        self.assert_owner();
        let had = self.per_account.remove(&account_id).is_some();
        if had {
            log!("nBTC/BTC ratio for {account_id} cleared: it reads the shared ratio again");
        } else {
            log!("{account_id} has no ratio of its own: nothing to clear");
        }
        had
    }

    pub fn get_ratio(&self) -> Ratio {
        Ratio { bp: self.bp, set_at: U64(self.set_at) }
    }

    /// `account_id`'s own ratio if it has one, otherwise the shared one.
    pub fn get_ratio_for(&self, account_id: AccountId) -> Ratio {
        match self.per_account.get(&account_id) {
            Some(own) => Ratio { bp: own.bp, set_at: U64(own.set_at) },
            None => self.get_ratio(),
        }
    }

    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }
}

impl Drill {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can set the ratio");
    }

    fn assert_owner_may_set(&self, bp: u32) {
        self.assert_owner();
        require!(bp <= PAR_BP, "the ratio is at most 10,000 bp (1.0)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    const DRILL: &str = "drill.pbf-ops.testnet";
    /// `drill.pbf-ops.testnet`'s state on 9 Nov, read with the RPC's `view_state` (its only key, `STATE`): the owner
    /// `pbf-ops.testnet`, 10,000 bp, set at 1794146231236560701 ns. Its code was the 7 Nov build, `d3fd4308…`.
    const TESTNET_STATE: &str = "0f0000007062662d6f70732e746573746e6574102700003d07f6d37d16e618";

    fn at(caller: usize, now: u64) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(accounts(caller)).block_timestamp(now).build());
    }

    fn id(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    /// Calls the drill as `caller` at `now`.
    fn as_on_testnet(caller: &str, now: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(id(DRILL))
            .predecessor_account_id(id(caller))
            .block_timestamp(now)
            .build());
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// Puts `drill.pbf-ops.testnet`'s 9 Nov state into the test's storage, with `caller` calling.
    fn testnet_state(caller: &str) {
        as_on_testnet(caller, 1_794_200_000_000_000_000);
        env::storage_write(b"STATE", &unhex(TESTNET_STATE));
    }

    #[test]
    fn starts_at_par_and_keeps_its_owner() {
        at(0, 5);
        let drill = Drill::new(accounts(0));
        assert_eq!(drill.get_ratio(), Ratio { bp: 10_000, set_at: U64(5) });
        assert_eq!(drill.owner(), accounts(0));
    }

    #[test]
    fn the_owner_sets_the_ratio_with_its_time() {
        at(0, 5);
        let mut drill = Drill::new(accounts(0));
        at(0, 9);
        drill.set_ratio(8_000);
        assert_eq!(drill.get_ratio(), Ratio { bp: 8_000, set_at: U64(9) });
        drill.set_ratio(0);
        assert_eq!(drill.get_ratio().bp, 0);
    }

    #[test]
    #[should_panic(expected = "only the owner can set the ratio")]
    fn only_the_owner_sets_the_ratio() {
        at(0, 5);
        let mut drill = Drill::new(accounts(0));
        at(1, 6);
        drill.set_ratio(9_000);
    }

    #[test]
    #[should_panic(expected = "the ratio is at most 10,000 bp")]
    fn the_ratio_is_capped_at_par() {
        at(0, 5);
        Drill::new(accounts(0)).set_ratio(10_001);
    }

    #[test]
    fn an_accounts_own_ratio_replaces_the_shared_one_for_it_alone() {
        at(0, 5);
        let mut drill = Drill::new(accounts(0));
        at(0, 9);
        drill.set_ratio_for(accounts(2), 7_500);
        assert_eq!(get_logs(), vec![format!("nBTC/BTC ratio for {} set to 7500 bp", accounts(2))]);
        assert_eq!(drill.get_ratio_for(accounts(2)), Ratio { bp: 7_500, set_at: U64(9) });
        // Every other account, and the shared view, still read par.
        assert_eq!(drill.get_ratio_for(accounts(3)), Ratio { bp: 10_000, set_at: U64(5) });
        assert_eq!(drill.get_ratio(), Ratio { bp: 10_000, set_at: U64(5) });
        // A new shared ratio reaches the accounts without their own, and not the account with one.
        at(0, 12);
        drill.set_ratio(9_000);
        assert_eq!(drill.get_ratio_for(accounts(3)), Ratio { bp: 9_000, set_at: U64(12) });
        assert_eq!(drill.get_ratio_for(accounts(2)), Ratio { bp: 7_500, set_at: U64(9) });
        // Setting it again replaces it; 0 is allowed, as for the shared ratio.
        drill.set_ratio_for(accounts(2), 0);
        assert_eq!(drill.get_ratio_for(accounts(2)), Ratio { bp: 0, set_at: U64(12) });
    }

    #[test]
    fn clearing_an_accounts_ratio_brings_back_the_shared_one() {
        at(0, 5);
        let mut drill = Drill::new(accounts(0));
        drill.set_ratio_for(accounts(2), 7_500);
        assert!(drill.clear_ratio_for(accounts(2)));
        assert_eq!(drill.get_ratio_for(accounts(2)), drill.get_ratio());
        // Clearing an account with no ratio of its own changes nothing.
        assert!(!drill.clear_ratio_for(accounts(2)));
        assert_eq!(get_logs().last().unwrap(), &format!("{} has no ratio of its own: nothing to clear", accounts(2)));
    }

    #[test]
    #[should_panic(expected = "only the owner can set the ratio")]
    fn only_the_owner_sets_an_accounts_ratio() {
        at(0, 5);
        let mut drill = Drill::new(accounts(0));
        at(1, 6);
        drill.set_ratio_for(accounts(2), 9_000);
    }

    #[test]
    #[should_panic(expected = "only the owner can set the ratio")]
    fn only_the_owner_clears_an_accounts_ratio() {
        at(0, 5);
        let mut drill = Drill::new(accounts(0));
        drill.set_ratio_for(accounts(2), 9_000);
        at(1, 6);
        drill.clear_ratio_for(accounts(2));
    }

    #[test]
    #[should_panic(expected = "the ratio is at most 10,000 bp")]
    fn an_accounts_ratio_is_capped_at_par() {
        at(0, 5);
        Drill::new(accounts(0)).set_ratio_for(accounts(2), 10_001);
    }

    #[test]
    fn migrate_keeps_the_testnet_drills_owner_and_ratio() {
        testnet_state("pbf-ops.testnet");
        let mut drill = Drill::migrate();
        assert_eq!(drill.owner(), id("pbf-ops.testnet"));
        let shared = Ratio { bp: 10_000, set_at: U64(1_794_146_231_236_560_701) };
        assert_eq!(drill.get_ratio(), shared);
        // No account has its own ratio yet, so every account reads the shared one.
        assert_eq!(drill.get_ratio_for(id("drill1.pbf.testnet")), shared);
        // The migrated drill works as a new one does.
        drill.set_ratio_for(id("drill1.pbf.testnet"), 7_500);
        assert_eq!(drill.get_ratio_for(id("drill1.pbf.testnet")).bp, 7_500);
        assert_eq!(drill.get_ratio(), shared);
    }

    #[test]
    fn the_drill_account_itself_may_migrate_in_its_deploy() {
        testnet_state(DRILL);
        assert_eq!(Drill::migrate().owner(), id("pbf-ops.testnet"));
    }

    #[test]
    #[should_panic(expected = "only the owner can migrate the drill")]
    fn only_the_owner_migrates() {
        testnet_state("stranger.testnet");
        Drill::migrate();
    }

    #[test]
    #[should_panic(expected = "Cannot deserialize the contract state")]
    fn migrate_cannot_run_twice() {
        testnet_state("pbf-ops.testnet");
        let drill = Drill::migrate();
        env::state_write(&drill);
        Drill::migrate();
    }
}
