//! Sandbox stand-in for the account contract in the pool's tests (contracts/tests). The pool sends each loan with
//! `ft_transfer_call`, so a borrower needs `ft_on_transfer`; this one takes every transfer, or, after
//! `set_refuse(true)`, hands it all back so the tests can check that the pool undoes the loan. The tests sign the
//! borrower's own `borrow`, `check_step`, `link` and repayment calls with its key. Sandbox and testnet tests only.
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId};

#[near(contract_state)]
#[derive(Default)]
pub struct Borrower {
    refuse: bool,
}

#[near]
impl Borrower {
    /// Returns the part of the transfer it doesn't keep: nothing, or everything when refusing.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let _ = (sender_id, msg);
        if self.refuse {
            amount
        } else {
            U128(0)
        }
    }

    pub fn set_refuse(&mut self, refuse: bool) {
        require!(env::predecessor_account_id() == env::current_account_id(), "only the account itself");
        self.refuse = refuse;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    #[test]
    fn takes_loans_unless_told_to_refuse() {
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(0))
            .build());
        let mut b = Borrower::default();
        assert_eq!(b.ft_on_transfer(accounts(1), U128(5), String::new()).0, 0);
        b.set_refuse(true);
        assert_eq!(b.ft_on_transfer(accounts(1), U128(5), String::new()).0, 5);
    }

    #[test]
    #[should_panic(expected = "only the account itself")]
    fn only_the_account_sets_refuse() {
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(1))
            .build());
        Borrower::default().set_refuse(true);
    }
}
