//! Sandbox tests (PLAN.md 10), with near-sandbox 0.4.0 and near-api 0.8.7 (near-workspaces 0.24.0 needs Rust 1.95).
//! They run each contract's real wasm on a local sandbox node, which near-sandbox downloads on first use (nearcore
//! 2.14.0, darwin-arm64 or linux).
//!
//! - `tests/pool.rs`: every pool limit, tried and refused, plus repaying while paused, interest per tier,
//!   write-offs and loans that go back. A dev account plays the factory; borrowers run `pb-testnet-borrower`.
//! - `tests/account.rs`: the factory and the account contract with the real pool, tokens and the OutLayer mock:
//!   the full flow (create, deposit, check, borrow, repay, withdraw), every verdict refusal, withdrawals with no
//!   loan, tokens that bounce, refunds of failed creations and the factory's list of accounts. Phase 4 adds the stored
//!   plan and `execute_step`: the drill's path, a rebalance end to end, refunds, late arrivals, DEFAULT and a `home`
//!   step. The test that waits out a 30-minute deadline runs on a node whose fast-forward covers 10 s a block.
//! - `tests/mocks.rs`: the MPC and OutLayer mocks, answered and timed out.
//! - `tests/upgrade.rs`: upgrades from the code deployed on testnet (INTERFACES.md 21 and 23). Each test puts a
//!   contract's live code and state in the sandbox under its testnet name, then deploys the new build over it.
//! - `tests/rhea.rs`: Rhea's own release file (`vendor/burrowland/`) with our test tokens and fixed prices: one loan
//!   start to finish, refusals, a falling BTC price and a liquidation. `common/rhea.rs` stands the copy up for other
//!   tests.
//!
//! Build the wasm first (the account before the factory, which embeds it), fetch the live code and state once
//! (read-only RPC, into `contracts/target/live/`), then run the tests, from `contracts/`:
//!
//! ```text
//! ./build.sh
//! python3 -I tests/fetch_live.py
//! cargo test -p pb-sandbox-tests --locked
//! ```
