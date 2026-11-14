//! Account: one per client (PLAN.md 5.1; INTERFACES.md 4). It holds the client's NEAR-side tokens and borrows from
//! the pool. While a loan is open, money leaves only with a fresh verdict from the pinned `pb-risk` program.
//!
//! How a verdict is used:
//! 1. Anyone calls `request_check(intent)` with 0.01 NEAR. The account asks OutLayer to run the pinned `pb-risk`
//!    version on `{mode: "check", account, intent, …}`.
//! 2. OutLayer's answer comes back to `on_verdict`, which keeps it only if it passes every check (`verdict.rs`).
//!    Only the account's own `request_execution` call can answer, and that call pins the project and the version.
//! 3. `borrow` and `withdraw` use the verdict within 120 blocks of the block it read, and bump the counter. Every
//!    verdict must carry the counter, so each one backs a single action. They bump it again when the loan has
//!    arrived or the tokens have gone, so a verdict read while money was on its way, which may not show it, backs
//!    nothing (research/audit.md, A1).
//!
//! Each accepted verdict also updates the margin-call clock, the two-check record for DELEVERAGE plans and the
//! hourly hedge record (`records.rs`). The engine reads them back on the next check.
//!
//! The Hyperliquid side (Phase 3; INTERFACES.md 8). The account controls its own Hyperliquid account, the
//! "master", through Chain Signatures:
//! 1. `hl_init` asks the MPC signer for the key at path `hyperliquid-1` and stores its address.
//! 2. `request_agent` asks the pinned `pb-gateway` for this account's agent, the key that places its orders.
//! 3. `hl_approve_agent` and `hl_withdraw` build Hyperliquid's `approveAgent` and `sendAsset` (`eip712.rs`), and
//!    the MPC signer signs their digests. `on_hl_signed` keeps each signed action in `hl.signed`, and the backend
//!    posts it to Hyperliquid.
//!
//! Guard rails (Phase 4; INTERFACES.md 13 and 14). The account protects the pool by itself:
//! - **The plan.** A confirmed DELEVERAGE plan, or a REBALANCE or REBALANCE_NOW plan, is stored with its steps
//!   (`plan.rs`). Anyone may run its steps with `execute_step`: `repay` at once, and `sell`, `to_hl` and `home` after
//!   the pool's `check_step`. The gateway places `cancel` and `perp`.
//! - **Transfers.** Each 1Click transfer, for a step or for the owner's own move, is recorded until its delivery or
//!   refund arrives with its msg, or a verdict lists it as arrived. While one is overdue, nothing that adds risk runs.
//!   None is recorded for a quote that expires more than 24 hours ahead. One that leaves NEAR for good (`to_hl`,
//!   `to_evm`) is settled by a verdict, or by its refund: the token it sent, 80% of the amount or more
//!   (research/audit.md, A7 and A12).
//! - **DEFAULT.** Two DEFAULT verdicts 2 to 5 minutes apart, the DELEVERAGE rule, block the account and have the pool
//!   write off its debt; one changes nothing. `lift_block` lifts the block once the pool has lifted its own and the
//!   account owes nothing (research/audit.md, A2). Repaying never stops.
//! - **Outages.** Anyone may repay once the held verdict says MARGIN_CALL or worse and is over 30 minutes old.
//!
//! Funding from lenders (Phase 6; FUNDING.md 4; INTERFACES.md 25). A loan may come partly from an outside lender (Aave
//! or Rhea) and partly from our pool:
//! - **The permission.** The owner signs it when the account is opened (`new`), and may replace or cancel it
//!   (`set_permission`). It names the lenders the engine may borrow from, and the terms. Changing it leaves the
//!   counter alone, and the account keeps the block it changed in (`permission_blk`): `fund` and the lender steps
//!   that borrow or post collateral take only a check read after that block (research/audit.md, A8). A top-up's
//!   repayment still runs.
//! - **The funding plan.** `fund(amount)`, with a verdict that answers that `fund`, stores the verdict's funding steps
//!   (`funding.rs`). Anyone runs them in order with `execute_step`, inside 30 minutes. Each step that adds debt needs
//!   a fresh verdict when it runs, so no money is lent on an old reading.
//! - **Our pool's step,** `p_borrow`, runs through `borrow`'s own path.
//! - **Rhea** (stage 2; `lender.rs`). `l_supply` posts collateral there and `l_borrow` borrows, after the pool has
//!   settled what the client pays. A top-up plan's `l_add` and `l_repay` run through `execute_step` too. The owner
//!   leaves with `lender_repay` and `lender_withdraw`. Rhea doesn't report failure, so the account books no Rhea
//!   loan: it lists a borrow or a withdrawal as under way for 20 blocks, and nothing else that adds risk runs until
//!   then. The engine reads the real position.
//! - **Pricing.** `settle` hands the held verdict's lender report to the pool, which books a fee or a subsidy on the
//!   account's debt to it. `claim_credit` collects a subsidy that outgrew the debt.
//! - **Aave** (stage 3; `evm.rs`). The same four steps and the same two calls for leaving, on Aave's chain: the
//!   account signs an Ethereum transaction for each through Chain Signatures, keeps it in `evm.signed`, and the
//!   backend sends it. `evm_approve` lets Aave's Pool take a token, `evm_withdraw` sends one away from the address,
//!   and `evm_bump` signs a kept transaction again with higher fees. A signed transaction never expires, so a signed
//!   borrow, collateral withdrawal or transfer is listed as under way until a verdict shows the chain has used its
//!   nonce, and nothing else that adds risk runs until then.
//! - **The moves between chains** (stage 4; INTERFACES.md 36). The owner starts each one, through 1Click:
//!   `withdraw` with a `to_evm` transfer sends a token to the account's own address on Aave's chain, and
//!   `evm_withdraw` with `exp` brings one home (`e_home`). Each is recorded as a transfer until it settles. A
//!   funding plan's own `to_evm` and `e_home` steps are the mainnet path, where the engine plans a move with 1Click's
//!   quote: they are read and checked, but not built, and `execute_step` answers that the account can't run them yet.
//!
//! Units: token amounts in the token's own units; USD amounts in micro-USD, which is one unit of the pool's token.
use std::collections::BTreeMap;

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, Value};
use near_sdk::{
    assert_one_yocto, env, ext_contract, log, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

pub use pb_types::{
    AaveLender, Config, Gateway, LenderReport, Lenders, Moves, Permission, Program, RheaLender, SecretsRef,
    TokenConfig, AAVE, RHEA,
};

mod eip712;
mod evm;
mod funding;
mod hl;
mod lender;
mod plan;
mod records;
mod verdict;

#[cfg(test)]
mod tests;

pub use eip712::{ApproveAgent, SendAsset};
pub use evm::*;
pub use funding::*;
pub use hl::*;
pub use lender::*;
pub use plan::*;
pub use records::*;
pub use verdict::*;

/// `request_check` needs at least this, all of which goes to OutLayer; OutLayer refunds the unused part to the caller.
const MIN_CHECK_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// A verdict can back an action until its `blk` is this many blocks old (about 70 s).
pub const FRESH_BLOCKS: u64 = 120;
/// `pb-risk`'s limits per run (PLAN.md 5.6).
const MAX_INSTRUCTIONS: u64 = 2_000_000_000;
const MAX_MEMORY_MB: u32 = 256;
const MAX_EXECUTION_SECONDS: u32 = 20;
/// OutLayer keeps 50 TGas for its own callback; 200 TGas worked in Phase 0 (research/day1.md 1).
const GAS_FOR_OUTLAYER: Gas = Gas::from_tgas(200);
/// Receiving and recording a 2 KB verdict took 1.6 TGas on testnet; this leaves room for the records.
const GAS_FOR_ON_VERDICT: Gas = Gas::from_tgas(30);
/// The pool needs at least 110 TGas to lend (PLAN.md 5.1, "As built").
const GAS_FOR_POOL_BORROW: Gas = Gas::from_tgas(130);
const GAS_FOR_REPAY: Gas = Gas::from_tgas(60);
const GAS_FOR_FT: Gas = Gas::from_tgas(10);
const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(10);
/// What a NEP-145 token charges to register an account. The token refunds it if the receiver is already registered.
const STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Anyone but the owner bumps a kept Ethereum transaction no sooner than this after it was signed: 60 seconds.
const BUMP_WAIT_NS: u64 = 60_000_000_000;
/// The NEAR the account keeps free of its storage for its own use, before the owner's `withdraw` pays a new
/// receiver's token registration from it: 0.3 NEAR (research/audit.md, A16). It must cover the storage of the
/// largest verdict and a full `pending` list. A verdict is at most 4,096 bytes of JSON, kept as read and in
/// fields: under 9 KB. A full list is 8 transfers of about 220 bytes, 8 Aave listings of about 100 and a borrow:
/// under 3 KB. Together that is 12 KB, which locks 0.12 NEAR, so the floor of 0.3 NEAR decides.
const NEAR_RESERVE: NearToken = NearToken::from_millinear(300);
const REPAY_MSG: &str = r#"{"pool":"repay"}"#;
/// A `home` transfer's token: Hyperliquid's USDC.
const HOME_TOKEN: &str = "USDC";
/// The MPC signer's `derived_public_key`, called from `hl_init`. Not yet measured on testnet: measure it there.
const GAS_FOR_DERIVED_KEY: Gas = Gas::from_tgas(50);
const GAS_FOR_ON_HL_KEY: Gas = Gas::from_tgas(10);
/// The MPC signer's `sign`: at least 15 TGas; the Phase 0 probe sent 50 and used about 12 (research/day1.md 3).
const GAS_FOR_SIGN: Gas = Gas::from_tgas(50);
const GAS_FOR_ON_HL_SIGNED: Gas = Gas::from_tgas(15);
/// The gateway's answer is smaller than a verdict; it gets what `on_verdict` gets.
const GAS_FOR_ON_AGENT: Gas = GAS_FOR_ON_VERDICT;
/// `execute_step`: the pool's `check_step`, or reading the account's USDC for a repay, then `on_step_ready`, which
/// repays (60 + 10), signs (50 + 15) or transfers (10 + 10, and 10 for `on_sent`).
const GAS_FOR_CHECK_STEP: Gas = Gas::from_tgas(15);
const GAS_FOR_BALANCE: Gas = Gas::from_tgas(5);
const GAS_FOR_ON_STEP: Gas = Gas::from_tgas(90);
const GAS_FOR_ON_SENT: Gas = Gas::from_tgas(10);
/// The pool's `write_off`, called from `on_verdict` for a confirmed DEFAULT.
const GAS_FOR_WRITE_OFF: Gas = Gas::from_tgas(15);
/// The pool's `get_borrower` for `lift_block`, and its callback.
const GAS_FOR_GET_BORROWER: Gas = Gas::from_tgas(10);
const GAS_FOR_ON_UNBLOCK: Gas = Gas::from_tgas(10);
/// The pool's `get_borrower` answers with well under 2 KB.
const MAX_BORROWER_BYTES: usize = 4_096;
/// Anyone may repay once the held verdict says MARGIN_CALL or worse and is older than this: 30 minutes.
const OUTAGE_NS: u64 = 30 * MINUTE_NS;
/// `derived_public_key` answers with about 100 bytes, and `sign` with about 230.
const MAX_KEY_BYTES: usize = 256;
const MAX_SIGNATURE_BYTES: usize = 512;
/// Rhea's `execute_with_pyth` and `execute`, for a borrow or a withdrawal: 150 TGas (FUNDING.md 4.4). A borrow with
/// its withdrawal burnt 43 to 64 TGas on mainnet (research/rhea.md 8). On our copy, whose prices are fixed, it burnt
/// 12, and 30 was the least that worked: Rhea keeps 20 back for the token's transfer and its own callback
/// (research/rhea.md 12).
const GAS_FOR_RHEA_ACTIONS: Gas = Gas::from_tgas(150);
/// A token's `ft_transfer_call` to Rhea, for collateral or a repayment. The token keeps 5 TGas for its own
/// `ft_resolve_transfer` and hands the rest to Rhea's `ft_on_transfer`. On our copy the whole call burnt 9.6 TGas, 5
/// of it at Rhea (research/rhea.md 12); mainnet's Rhea also updates its farms there, which is not measured.
const GAS_FOR_RHEA_FT: Gas = Gas::from_tgas(100);
/// Rhea's `storage_deposit`: the whole call burnt 3.8 TGas on our copy (research/rhea.md 12).
const GAS_FOR_RHEA_REGISTER: Gas = Gas::from_tgas(10);
/// What Rhea keeps to register an account: 0.1 NEAR, its `MIN_STORAGE_BALANCE` of 10,000 bytes. With
/// `registration_only` it sends back the rest, and all of it if the account is registered already.
const RHEA_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(100);
/// The pool's `settle`: it accrues interest, prices one period and stores the report. It burns about 2.5 TGas in
/// the pool's sandbox tests.
const GAS_FOR_SETTLE: Gas = Gas::from_tgas(30);
const GAS_FOR_ON_SETTLED: Gas = Gas::from_tgas(10);
/// `on_step_settled`, which sends Rhea its borrow (150 + 10 for `on_lender_sent`).
const GAS_FOR_ON_STEP_SETTLED: Gas = Gas::from_tgas(180);
/// `on_repay_ready`, which repays Rhea (100 + 10 for `on_lender_repaid`).
const GAS_FOR_ON_REPAY_READY: Gas = Gas::from_tgas(145);
/// `on_repay_checked`: Rhea's `ft_transfer_call` (100 TGas), `on_lender_repaid` (10) and itself.
const GAS_FOR_ON_REPAY_CHECKED: Gas = Gas::from_tgas(120);
/// `on_add_ready`: Rhea's registration (10 TGas), the `ft_transfer_call` (100), `on_supplied` (10) and itself.
const GAS_FOR_ON_ADD_READY: Gas = Gas::from_tgas(130);
/// How the pool's `settle` starts its answer while it is paused ("the pool is paused: settlements wait").
const POOL_PAUSED: &str = "the pool is paused";
/// The pool's `claim_credit`, which pays in USDC with a plain `ft_transfer`. It burns about 7 TGas in the pool's
/// sandbox tests.
const GAS_FOR_CLAIM_CREDIT: Gas = Gas::from_tgas(40);
/// The pool's `settle` answers with well under 1 KB.
const MAX_SETTLED_BYTES: usize = 4_096;
/// The pool's lending token has 6 decimals: `Config::assert_valid` holds every config to it.
const USDC_DECIMALS: u8 = 6;
/// `on_evm_signed`, which keeps a signed Ethereum transaction: at most 20 of them, each under 400 bytes.
const GAS_FOR_ON_EVM_SIGNED: Gas = Gas::from_tgas(20);

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> U128;
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}

#[ext_contract(ext_pool)]
#[allow(dead_code)]
trait LendingPool {
    fn borrow(&mut self, amount: U128, verdict: BorrowVerdict);
    fn check_step(&mut self, plan_id: String, step: u32, token: AccountId, amount: U128);
    fn write_off(&mut self, account_id: AccountId);
    fn get_borrower(&self, account_id: AccountId);
    fn settle(&mut self, report: Vec<LenderReport>);
    fn claim_credit(&mut self);
}

/// The pool's `settle` as an `l_borrow` step calls it, with both ends of the period (research/audit.md, P4;
/// INTERFACES.md 45): `closes` is the lender report as it stood just before the borrow, which ends the period up to
/// now, and `report` has the borrow added, which starts the next. Every other settlement calls `settle(report)`
/// above, and its JSON carries no `closes`.
#[ext_contract(ext_pool_at_borrow)]
#[allow(dead_code)]
trait LendingPoolAtBorrow {
    fn settle(&mut self, report: Vec<LenderReport>, closes: Vec<LenderReport>);
}

/// The account's record of its loan from our pool. `principal` is what was borrowed less what was repaid, plus the
/// fees and less the subsidies of the pool's settlements; the pool's `debt_of` is the authority and adds interest.
/// `open` stays true until a repayment comes back partly unused, which shows that the pool's debt, interest
/// included, is cleared.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Loan {
    pub principal: U128,
    pub open: bool,
}

impl Loan {
    /// Books one settlement of the pool's (FUNDING.md 5.2). A fee is new debt to the pool, so the loan is open from
    /// then on, even if nothing was ever borrowed there. A subsidy comes off the debt, and the record never goes
    /// below zero: once it is zero, a repayment that comes back unused closes the loan.
    pub fn book_settlement(&mut self, fee: u128, subsidy: u128) {
        if fee > 0 {
            self.principal = U128(self.principal.0.saturating_add(fee));
            self.open = true;
        }
        self.principal = U128(self.principal.0.saturating_sub(subsidy));
    }

    /// Books a repayment: `sent` went to the pool, which used `used`. The pool sends back only what is above the whole
    /// debt, so a repayment that partly came back clears the loan. If the pool used nothing while principal was still
    /// owed, it refused the repayment, and nothing changes.
    pub fn book_repayment(&mut self, sent: u128, used: u128) {
        self.principal = U128(self.principal.0.saturating_sub(used));
        if used < sent && (used > 0 || self.principal.0 == 0) {
            self.principal = U128(0);
            self.open = false;
        }
    }
}

/// An operation under way, which `pb-risk` can see.
/// - A borrow: while one is under way, nothing else that adds risk starts.
/// - A 1Click transfer (Phase 4), until it arrives, comes back or a verdict says it arrived (`plan.rs`).
/// - A lender action (Phase 6): a borrow or a withdrawal sent to Rhea, for 20 blocks (`lender.rs`). At most one is
///   listed, because nothing that adds risk starts while it is.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Debug, PartialEq)]
pub enum Pending {
    Borrow { amount: U128 },
    Transfer(Transfer),
    Lender(LenderAction),
}

/// The verdict the account holds: the intent it answers, the block and time it arrived, the fields the contract
/// reads, and the JSON as OutLayer returned it.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Held {
    pub intent: Intent,
    pub received_block: u64,
    pub received_at: u64,
    pub verdict: Verdict,
    pub json: String,
}

/// What the pool's `borrow` reads from the verdict (contracts/pool/src/types.rs, `BorrowVerdict`).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct BorrowVerdict {
    pub tier: Tier,
    pub allow_borrow: U128,
    pub shares_bp: BTreeMap<String, u32>,
    pub hold: BTreeMap<String, U128>,
    pub hl_eq: U128,
}

impl From<&Verdict> for BorrowVerdict {
    fn from(v: &Verdict) -> Self {
        Self {
            tier: v.tier,
            allow_borrow: U128(v.allow.borrow),
            shares_bp: v.pool.shares_bp.clone(),
            hold: v.pool.hold.iter().map(|(token, held)| (token.clone(), U128(*held))).collect(),
            // The pool takes Hyperliquid equity as 0 when it is negative.
            hl_eq: U128(u128::try_from(v.pool.hl_eq).unwrap_or(0)),
        }
    }
}

/// What `on_verdict` returns: whether the verdict was kept, and if not, which check failed.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CheckOutcome {
    pub accepted: bool,
    pub reason: Option<String>,
}

/// The state view (INTERFACES.md 4).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct StateView {
    pub owner: AccountId,
    pub counter: u64,
    pub blocked: bool,
    pub loan: Loan,
    pub verdict: Option<HeldView>,
    pub margin_call: MarginCall,
    pub deleverage: DeleverageView,
    /// When the first DEFAULT verdict of the current pair arrived, or 0: a second one 2 to 5 minutes later confirms it.
    #[serde(rename = "default")]
    pub default_check: DeleverageView,
    pub plan: Option<PlanView>,
    pub hourly: Vec<HourRecord>,
    pub pending: Vec<Pending>,
    /// The owner's next move gets the transfer id `move:<next_move>`.
    pub next_move: u64,
    pub hl: Hl,
    /// The owner's funding permission, or null: the account then borrows from our pool only (Phase 6).
    pub permission: Option<Permission>,
    /// The block height at which the permission last changed, or 0 if none was ever set. `fund` and the lender steps
    /// that borrow or post collateral take only a check read after it.
    pub permission_blk: u64,
    /// The funding plan `fund` stored, or null.
    pub funding: Option<FundingView>,
    /// The account's side on Aave's chain: its next nonce there and the newest transactions it signed (stage 3).
    pub evm: EvmView,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct HeldView {
    pub intent: Intent,
    pub received_block: u64,
    pub received_at: U64,
    pub verdict: Value,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct DeleverageView {
    pub first_at: U64,
}

/// What `lift_block` reads of the pool's `get_borrower` answer (`contracts/pool/src/types.rs`, `BorrowerView`).
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct PoolBorrower {
    blocked: bool,
    debt: U128,
}

/// `{"pb":{"deposit":{}}}`, `{"pb":{"loan":{}}}` or `{"pb":{"transfer":"<id>"}}`.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct TransferMsg {
    pb: Msg,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
enum Msg {
    Deposit {},
    Loan {},
    Transfer(String),
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Account {
    owner: AccountId,
    config: Config,
    /// Every verdict must carry it, and every borrow and withdrawal bumps it.
    counter: u64,
    /// Set by the default path (Phase 4).
    blocked: bool,
    loan: Loan,
    verdict: Option<Held>,
    margin_call: MarginCall,
    deleverage: Deleverage,
    hourly: Vec<HourRecord>,
    pending: Vec<Pending>,
    hl: Hl,
    /// The plan `execute_step` runs (Phase 4).
    plan: Option<Plan>,
    /// The number of the owner's next 1Click move.
    next_move: u64,
    /// DEFAULT's two-check record (research/audit.md, A2).
    default_check: Deleverage,
    /// The owner's funding permission (Phase 6): the lenders the engine may borrow from, and on what terms.
    permission: Option<Permission>,
    /// The funding plan `execute_step` runs for a `pid` that starts with `f`. A verdict never clears it.
    funding: Option<Funding>,
    /// The `blk` of the verdict the last funding plan came from, so no two plans share a `pid`.
    funded_blk: u64,
    /// Whether Rhea has taken collateral from this account, which shows it is registered there. Until then each
    /// posting pays Rhea's registration first.
    rhea_registered: bool,
    /// The account's Ethereum transactions for Aave's chain (stage 3): its next nonce, the newest it signed, and the
    /// one the signer is signing now.
    evm: Evm,
    /// The block height of the last `set_permission`, or of `new` when a permission came with it; 0 if none was ever
    /// set. A check read at or before it was made under another permission, and backs nothing at a lender
    /// (research/audit.md, A8).
    permission_blk: u64,
    /// How often the loan record has grown: a loan from the pool and a settlement's fee each move it on. A repayment
    /// remembers it when it is sent, so `on_repaid` can tell whether new debt was booked meanwhile (research/audit.md,
    /// A13). Private: no view shows it.
    loan_seq: u64,
}

#[near]
impl Account {
    /// The factory calls this when it creates the account. The counter starts at 0. `permission` is the owner's
    /// funding permission (FUNDING.md 4.2): it may be left out or null, and the account then borrows from our pool
    /// only. One that names a lender the config doesn't have, or has terms out of range, is refused.
    #[init]
    pub fn new(owner: AccountId, config: Config, permission: Option<Permission>) -> Self {
        config.assert_valid();
        assert_permission(permission.as_ref(), &config);
        let permission_blk = if permission.is_some() { env::block_height() } else { 0 };
        Self {
            owner,
            config,
            counter: 0,
            blocked: false,
            loan: Loan::default(),
            verdict: None,
            margin_call: MarginCall::default(),
            deleverage: Deleverage::default(),
            hourly: Vec::new(),
            pending: Vec::new(),
            hl: Hl::new(),
            plan: None,
            next_move: 0,
            default_check: Deleverage::default(),
            permission,
            funding: None,
            funded_blk: 0,
            rhea_registered: false,
            evm: Evm::default(),
            permission_blk,
            loan_seq: 0,
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Tokens in
    // ---------------------------------------------------------------------------------------------------------

    /// Receives an allow-listed token. `msg` `""` or `{"pb":{"deposit":{}}}` is a deposit, kept. `{"pb":{"loan":{}}}`
    /// from the pool, in its lending token, is a loan, booked. `{"pb":{"transfer":"<id>"}}` is a 1Click delivery or
    /// refund, kept: it settles the transfer under way with that id, "refunded" if it is the token sent and "arrived"
    /// if not. With no such transfer it is kept as a deposit, so a late delivery is never sent back. Anything else, and
    /// any other token, is returned in full.
    ///
    /// A `to_hl` or `to_evm` transfer leaves NEAR for good: it is never delivered here, and a verdict's `arrived`
    /// settles it. So a deposit with its msg settles it only as a refund: the token it sent, and at least 80% of its
    /// amount. Anything else with its msg is kept as a plain deposit, and the record stays (research/audit.md, A12).
    ///
    /// A `sell`, a `home` or an `e_home` whose record has `expect` (what its quote says will arrive) is settled as
    /// arrived only by that token and at least 80% of that amount, and as refunded only by the token it sent and at
    /// least 80% of what it sent. Anything else with its msg is kept as a plain deposit too. Without `expect` any
    /// deposit with the msg settles it, as before.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        if self.config.token(&token).is_none() {
            log!("returned {} of {token}: not an allow-listed token", amount.0);
            return PromiseOrValue::Value(amount);
        }
        let kind = if msg.is_empty() { Some(Msg::Deposit {}) } else { parse_msg(&msg) };
        match kind {
            Some(Msg::Deposit {}) => {
                log!("deposit of {} {token} from {sender_id}", amount.0);
                PromiseOrValue::Value(U128(0))
            }
            Some(Msg::Loan {}) if token == self.config.usdc_token && sender_id == self.config.pool_id => {
                self.loan.principal = U128(self.loan.principal.0.saturating_add(amount.0));
                self.loan.open = true;
                self.loan_seq = self.loan_seq.saturating_add(1);
                log!("loan of {} from the pool", amount.0);
                PromiseOrValue::Value(U128(0))
            }
            Some(Msg::Loan {}) => {
                log!("returned {} of {token}: only the pool sends loans, in its lending token", amount.0);
                PromiseOrValue::Value(amount)
            }
            Some(Msg::Transfer(id)) => {
                log!("{} {token} from {sender_id} for transfer {id}", amount.0);
                let how = self.transfers().find(|t| t.id == id).map(|t| {
                    let same_token = t.token == token.as_str();
                    // 80% of a figure, or more.
                    let most_of = |figure: u128| amount.0.saturating_mul(5) >= figure.saturating_mul(4);
                    let refund = same_token && most_of(t.amount.0);
                    if matches!(t.kind, TransferKind::ToHl | TransferKind::ToEvm) {
                        return refund.then_some("refunded").ok_or("a refund");
                    }
                    match &t.expect {
                        // The record holds no figure for what arrives: as before.
                        None => Ok(if same_token { "refunded" } else { "arrived" }),
                        Some(expect) if token == expect.token && most_of(expect.amount.0) => Ok("arrived"),
                        Some(_) => refund.then_some("refunded").ok_or("the delivery or the refund"),
                    }
                });
                match how {
                    Some(Ok(how)) => drop(self.settle_transfer(&id, |_| how)),
                    Some(Err(what)) => log!("kept as a deposit: not {what} of transfer {id}"),
                    None => log!("no transfer {id} is under way: kept as a deposit"),
                }
                PromiseOrValue::Value(U128(0))
            }
            None => {
                log!(
                    r#"returned {} of {token}: msg must be "", {{"pb":{{"deposit":{{}}}}}}, a loan or a transfer"#,
                    amount.0
                );
                PromiseOrValue::Value(amount)
            }
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Checks
    // ---------------------------------------------------------------------------------------------------------

    /// Asks OutLayer to run the pinned `pb-risk` on this account and `intent` (INTERFACES.md 6). Anyone can ask (the
    /// keeper does, hourly). Attach at least 0.01 NEAR, which goes to OutLayer and comes back to the caller less the
    /// run's cost, and 300 TGas. The answer arrives in `on_verdict`.
    #[payable]
    pub fn request_check(&mut self, intent: Intent) -> Promise {
        self.end_lender_wait();
        let deposit = env::attached_deposit();
        require!(deposit >= MIN_CHECK_DEPOSIT, "attach at least 0.01 NEAR for OutLayer");
        let risk = &self.config.risk;
        require!(!risk.version_key.is_empty(), "no pb-risk version is pinned in this account's config");
        self.assert_intent(&intent);
        let account = env::current_account_id();
        let network = network(&account);
        let input = RunInput { mode: "check", account: &account, intent: &intent, network, snapshot: false };
        self.run(&risk.project_id, &risk.version_key, None, &input, deposit)
            .then(Self::ext(account).with_static_gas(GAS_FOR_ON_VERDICT).on_verdict(intent))
    }

    /// OutLayer's answer. Keeps the verdict if it passes every check and updates the records from it; otherwise keeps
    /// nothing and logs which check failed. Never panics.
    #[private]
    pub fn on_verdict(&mut self, intent: Intent) -> CheckOutcome {
        self.end_lender_wait();
        let outcome = match env::promise_result_checked(0, MAX_VERDICT_BYTES) {
            Ok(bytes) => self.accept(intent, &bytes),
            Err(PromiseError::TooLong(len)) => {
                Err(format!("the verdict is {len} bytes, above the {MAX_VERDICT_BYTES}-byte limit"))
            }
            Err(_) => Err("OutLayer's call failed".to_string()),
        };
        match outcome {
            Ok(()) => CheckOutcome { accepted: true, reason: None },
            Err(reason) => {
                log!("verdict refused: {reason}");
                CheckOutcome { accepted: false, reason: Some(reason) }
            }
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Borrowing and repaying
    // ---------------------------------------------------------------------------------------------------------

    /// Borrows `amount` (micro-USDC) from the pool with the held verdict. The owner only, with 1 yoctoNEAR and
    /// 300 TGas. The verdict must be fresh, answer a borrow, show the account HEALTHY and allow at least `amount`.
    /// The pool then applies its own limits, and the loan arrives through `ft_on_transfer`.
    ///
    /// Refused while a signed `sendAsset` could still be posted (`hl.send_open_until_ms`): the verdict may count USDC
    /// that is about to leave Hyperliquid. Also refused while a 1Click transfer is overdue, and once the account is
    /// blocked after a default.
    #[payable]
    pub fn borrow(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        self.end_lender_wait();
        self.assert_owner();
        self.assert_not_blocked();
        require!(amount.0 > 0, "amount must be positive");
        require!(!self.borrowing(), "a borrow is already under way");
        self.assert_no_send_open("borrow");
        self.assert_none_overdue("borrow");
        self.assert_no_lender_wait("borrow");
        let held = self.usable_verdict();
        require!(matches!(held.intent, Intent::Borrow { .. }), "the verdict doesn't answer a borrow");
        let v = &held.verdict;
        require!(v.state == State::Healthy, "the verdict's state isn't HEALTHY");
        require!(v.allow.borrow >= amount.0, "amount is above the verdict's borrow allowance");
        let terms = BorrowVerdict::from(v);
        self.counter += 1;
        self.pending.push(Pending::Borrow { amount });
        ext_pool::ext(self.config.pool_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_POOL_BORROW)
            .borrow(amount, terms)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_CALLBACK).on_borrowed(amount))
    }

    /// Ends the borrow under way, and returns whether the whole loan arrived. The pool returns how much of it the
    /// account took; `ft_on_transfer` has already booked that. It bumps the counter again: a verdict read while the
    /// borrow was under way may show no loan, and must not back a later withdrawal. Never panics.
    #[private]
    pub fn on_borrowed(&mut self, amount: U128) -> bool {
        self.end_borrow(amount) == Some(amount.0)
    }

    // ---------------------------------------------------------------------------------------------------------
    // Funding from lenders (INTERFACES.md 25)
    // ---------------------------------------------------------------------------------------------------------

    /// Replaces the owner's funding permission, or cancels it with null. The owner only, with 1 yoctoNEAR. One that
    /// names a lender the config doesn't have, or has terms out of range, is refused. It logs `permission_set`.
    ///
    /// It records the block it ran in (`get_state().permission_blk`). A check read at or before that block was made
    /// under the old permission, so `fund` and the lender steps that borrow or post collateral refuse it and ask
    /// for a new one. A top-up's repayment still runs on it, and only skips its settlement. It leaves the counter
    /// alone: a check that is on its way still arrives, so an owner can't use this call to keep a margin call or
    /// an unwind from reaching the account (research/audit.md, A8).
    ///
    /// After a cancel, no new lender loan starts: a stored funding plan's lender steps are refused when they run.
    /// What is already borrowed stays until it is repaid, and top-ups still run.
    #[payable]
    pub fn set_permission(&mut self, permission: Option<Permission>) {
        assert_one_yocto();
        self.end_lender_wait();
        self.assert_owner();
        assert_permission(permission.as_ref(), &self.config);
        Event::PermissionSet { permission: permission.as_ref() }.emit();
        self.permission = permission;
        self.permission_blk = env::block_height();
    }

    /// Stores the held verdict's funding steps as the funding plan, for a loan of `amount` (micro-USD) in all, and
    /// returns it as `get_state().funding` shows it. The owner only, with 1 yoctoNEAR. It needs all of:
    /// - a held verdict that is fresh, carries the current counter, shows the account HEALTHY and answers `fund` for
    ///   this same amount, read at a later block than the last funding plan's verdict and than the last change of
    ///   the permission;
    /// - an account that isn't blocked and has no overdue transfer, and no funding plan with steps still to run
    ///   inside its 30 minutes;
    /// - at least one step, each of them a funding step with valid fields, whose `p_borrow` and `l_borrow` amounts
    ///   add up to at most `amount`;
    /// - for every lender step, a lender the config has and the permission names.
    ///
    /// The plan's id is `f` and the verdict's `blk`, and it expires 30 minutes from now. It moves no money: anyone
    /// runs the steps with `execute_step`, and each step that adds debt needs a fresh verdict of its own. It bumps the
    /// counter, so this verdict backs nothing else, and logs `funding_stored`.
    #[payable]
    pub fn fund(&mut self, amount: U128) -> FundingView {
        assert_one_yocto();
        self.end_lender_wait();
        self.assert_owner();
        self.assert_not_blocked();
        require!(amount.0 > 0, "amount must be positive");
        self.assert_none_overdue("funding");
        let now = env::block_timestamp();
        if let Some(running) = self.funding.as_ref().filter(|f| f.unfinished() && !f.expired(now)) {
            env::panic_str(&format!(
                "funding plan {} still has steps to run: wait for them, or drop it with cancel_funding",
                running.pid
            ));
        }
        let held = self.usable_verdict();
        require!(held.intent == Intent::Fund { amount }, "the verdict doesn't answer fund for this amount");
        let v = &held.verdict;
        self.assert_read_since_permission(v.blk);
        require!(v.state == State::Healthy, "the verdict's state isn't HEALTHY");
        require!(
            v.blk > self.funded_blk,
            format!("a funding plan was already stored from block {}: ask for a new check", self.funded_blk)
        );
        let steps = steps_from(&fund_steps(&held.json));
        require!(!steps.is_empty(), "the verdict has no funding steps: the engine found nothing to lend");
        require!(steps.len() <= MAX_FUND_STEPS, "the verdict has more than 6 funding steps");
        let mut total: u128 = 0;
        let mut kinds = Vec::with_capacity(steps.len());
        for (i, step) in steps.iter().enumerate() {
            let read = self.checked_step(&step.json).unwrap_or_else(|why| env::panic_str(&format!("step {i} {why}")));
            require!(
                read.makes_a_loan(),
                format!("step {i} is a {} step, which only a top-up plan holds", read.kind())
            );
            total = total.saturating_add(read.borrows());
            kinds.push(read.kind());
        }
        require!(
            total <= amount.0,
            format!("the funding steps borrow {total} in all, above the {} asked for", amount.0)
        );
        let funding = Funding::new(v.blk, amount.0, now, steps);
        Event::FundingStored { pid: &funding.pid, amount, steps: kinds }.emit();
        let view = funding.view();
        self.funded_blk = v.blk;
        self.counter += 1;
        self.funding = Some(funding);
        view
    }

    /// Drops the funding plan. The owner only, with 1 yoctoNEAR. Steps that have started stay as they are: a loan
    /// that is on its way still arrives. It logs `funding_cancelled`.
    #[payable]
    pub fn cancel_funding(&mut self) {
        assert_one_yocto();
        self.assert_owner();
        let dropped = self.funding.take().unwrap_or_else(|| env::panic_str("no funding plan is stored"));
        Event::FundingCancelled { pid: &dropped.pid }.emit();
    }

    /// Ends the pool borrow of funding step `i` of plan `pid`, as `on_borrowed` ends the owner's own: the borrow under
    /// way is over and the counter moves on again. Returns whether the whole of `amount` arrived. If the pool lent
    /// nothing, the step may run again, unless the plan was dropped or replaced meanwhile. Never panics.
    #[private]
    pub fn on_step_borrowed(&mut self, pid: String, i: u32, amount: U128) -> bool {
        let lent = self.end_borrow(amount);
        if lent.unwrap_or(0) == 0 {
            let step = self.funding.as_mut().filter(|f| f.pid == pid).and_then(|f| f.steps.get_mut(i as usize));
            if let Some(step) = step {
                step.done = false;
                log!("step {i} of plan {pid} didn't go out: nothing was lent, and it may run again");
            }
        }
        lent == Some(amount.0)
    }

    /// The end of a collateral posting at Rhea, for step `i` of plan `pid` (an `l_supply` or an `l_add`): returns how
    /// much Rhea took, which the token answers. Rhea takes all of it or none. It bumps the counter again, so a
    /// verdict read while the tokens were on their way, which may still count them as free, backs nothing. If Rhea
    /// took none, the step may run again, unless its plan was dropped or replaced meanwhile. Never panics.
    #[private]
    pub fn on_supplied(&mut self, pid: String, i: u32, amount: U128) -> U128 {
        self.counter = self.counter.saturating_add(1);
        let used = result_u128().map_or(0, |used| used.min(amount.0));
        if used > 0 {
            self.rhea_registered = true;
            log!("posted {used} at Rhea as collateral");
        } else {
            self.reopen_step(&pid, i);
            log!("step {i} of plan {pid} didn't go out: Rhea took no collateral, and it may run again");
        }
        U128(used)
    }

    /// The pool's `settle` has answered for `l_borrow` step `i` of plan `pid` at `lender`. If the pool settled (an
    /// answer that says it skipped the settlement counts, unless it skipped because the pool is paused), the account
    /// books the fee or the subsidy, and then:
    /// - at Rhea, borrows `amount` micro-USD and has it sent to itself, in one call with 1 yoctoNEAR, and the 20
    ///   blocks of the listed borrow start again from here;
    /// - at Aave, has the signer sign the borrow it built when the step started (`on_evm_signed` keeps it).
    ///
    /// If the pool's call failed, the pool is paused, or the account was blocked meanwhile, nothing is borrowed or
    /// signed: the listed borrow is dropped, the counter moves on and the step may run again. Never panics.
    #[private]
    pub fn on_step_settled(&mut self, pid: String, i: u32, lender: String, amount: U128) -> PromiseOrValue<bool> {
        // A paused pool lends nothing and settles nothing: no new debt starts at a lender either (research/audit.md,
        // A17).
        let (answered, paused) = self.read_settlement();
        let settled = answered && !paused;
        let why = match (answered, paused) {
            (_, true) => "the pool is paused",
            (true, _) => "the account can't borrow now",
            _ => "the pool's settlement failed",
        };
        if lender == AAVE {
            let waiting = self.evm.signing.as_ref().is_some_and(|s| s.kind == EvmKind::Borrow && !s.bump);
            if settled && !self.blocked && waiting {
                return PromiseOrValue::Promise(self.sign_evm());
            }
            if let Some(signing) = self.evm.signing.take() {
                self.undo_evm(signing, why, false);
            }
            return PromiseOrValue::Value(false);
        }
        let rhea = self.config.lenders.rhea.as_ref().map(|rhea| rhea.contract_id.clone());
        let inner = rhea_inner(amount.0, USDC_DECIMALS);
        let (rhea, inner) = match (rhea, inner) {
            (Some(rhea), Some(inner)) if settled && !self.blocked => (rhea, inner),
            _ => {
                self.drop_lender_actions(|action| action.lender == RHEA);
                self.reopen_step(&pid, i);
                log!("step {i} of plan {pid} didn't go out, as {why}: nothing was borrowed, and it may run again");
                return PromiseOrValue::Value(false);
            }
        };
        // The wait counts from the block the borrow goes out.
        self.pending.retain(|p| !matches!(p, Pending::Lender(action) if action.lender == RHEA));
        self.list_lender_action(RHEA.to_string(), LenderKind::Borrow, amount, None);
        let args = to_bytes(&borrow_actions(&self.config.usdc_token, inner));
        let sent = Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_CALLBACK).on_lender_sent(Some(pid), i);
        PromiseOrValue::Promise(
            Promise::new(rhea).function_call("execute_with_pyth", args, ONE_YOCTO, GAS_FOR_RHEA_ACTIONS).then(sent),
        )
    }

    /// Rhea's `execute_with_pyth` has returned, for a borrow (step `i` of funding plan `pid`) or for the owner's
    /// withdrawal (no `pid`). Returns whether Rhea took the call.
    /// - It took it: the action stays listed for its 20 blocks. Rhea may still finish it a block or two later, or
    ///   fail without saying so, and the engine reads which.
    /// - It refused the call itself, so nothing moved there: the listing is dropped, the counter moves on, and a
    ///   borrow's step may run again.
    ///
    /// Never panics.
    #[private]
    pub fn on_lender_sent(&mut self, pid: Option<String>, i: u32) -> bool {
        if succeeded() {
            return true;
        }
        self.drop_lender_actions(|action| action.lender == RHEA);
        match pid {
            Some(pid) => {
                self.reopen_step(&pid, i);
                let why = "Rhea refused it";
                log!("step {i} of plan {pid} didn't go out, as {why}: nothing was borrowed, and it may run again");
            }
            None => log!("Rhea refused the withdrawal: nothing was taken back"),
        }
        false
    }

    // ---------------------------------------------------------------------------------------------------------
    // Leaving a lender, and pricing (INTERFACES.md 25; FUNDING.md 4.3 and 4.7)
    // ---------------------------------------------------------------------------------------------------------

    /// Repays `lender` (`"rhea"` or `"aave"`) up to `amount` micro-USD from the account's USDC on that lender's
    /// chain. The owner, with 1 yoctoNEAR, at any time; and anyone under the rule that opens `repay` to everyone.
    /// Repaying is never held back: not by a block after a default, an overdue transfer, a lender action under way
    /// or a signed `sendAsset`. At Aave it waits only while the signer is signing another Ethereum transaction.
    ///
    /// - If the account holds a fresh verdict with the current counter, the pool settles the client's price first
    ///   with that verdict's lender report (FUNDING.md 5.2). Without one, the next hourly settlement covers it. The
    ///   repayment goes out either way.
    /// - **Rhea:** an `ft_transfer_call` on NEAR with Rhea's `"OnlyRepay"`. Rhea takes at most the debt and keeps the
    ///   rest as the account's plain deposit there, which `lender_withdraw` of the USDC token brings back. With no
    ///   debt at Rhea, the whole amount comes back at once.
    /// - **Aave:** the account signs `repay` on Aave's Pool, which takes the USDC from the account's Ethereum address
    ///   (`evm_approve` first, once). An amount at or above the debt the held verdict shows there is sent as "all of
    ///   it", so the interest since leaves no dust; a smaller one is sent exactly.
    /// - Anyone but the owner repays at most the debt the held verdict shows at the lender (`ext[lender].d`), and
    ///   nothing if it shows none: a stranger can't leave the account's USDC lying at a lender.
    /// - At Aave, anyone but the owner repays that whole debt or nothing, and not while a kept signed repayment
    ///   isn't shown mined: each repayment holds the one signing slot and takes a nonce (research/audit.md, A9).
    /// - It leaves the counter alone: a repayment only lowers risk.
    #[payable]
    pub fn lender_repay(&mut self, lender: String, amount: U128) -> Promise {
        assert_one_yocto();
        self.end_lender_wait();
        self.assert_may_repay();
        require!(amount.0 > 0, "amount must be positive");
        let lender = self.named_lender(&lender);
        let held = self.verdict.as_ref().and_then(|held| held.verdict.ext.iter().find(|line| line.l == lender));
        let owed = held.map_or(0, |line| line.d);
        let amount = if env::predecessor_account_id() == self.owner {
            amount
        } else {
            require!(owed > 0, format!("the verdict shows no debt at {lender}: only the owner can send it more"));
            if lender == AAVE {
                self.assert_stranger_may_repay_aave(amount.0, owed);
            }
            U128(amount.0.min(owed))
        };
        if lender == AAVE {
            let signed = self.repay_at_aave(amount.0, owed > 0 && amount.0 >= owed, None);
            self.settle_if_fresh();
            return signed;
        }
        self.settle_if_fresh();
        self.repay_rhea(self.rhea_for(RHEA).contract_id.clone(), amount)
    }

    /// Logs what Rhea used of a repayment, which the token returns. The account books nothing: the engine reads the
    /// debt at Rhea. Never panics.
    #[private]
    pub fn on_lender_repaid(&mut self, amount: U128) -> U128 {
        match result_u128().map(|used| used.min(amount.0)) {
            Some(0) => {
                log!("Rhea took nothing of the {} sent, and it came back", amount.0);
                U128(0)
            }
            Some(used) => {
                log!("repaid {used} at Rhea");
                U128(used)
            }
            None => {
                log!("the repayment of {} at Rhea failed", amount.0);
                U128(0)
            }
        }
    }

    /// Takes `amount` of `token` back from `lender` (`"rhea"` or `"aave"`) to the account itself, with 1 yoctoNEAR.
    /// `amount` is in the token's own units.
    ///
    /// **A collateral token** (one of the config's for that lender), the owner only. Rhea takes it out of the
    /// collateral and sends it, in one `execute_with_pyth` call with 1 yoctoNEAR. For Aave the account signs
    /// `withdraw(asset, amount, self)` on Aave's Pool, which pays the account's own Ethereum address.
    /// - With no loan from our pool and no borrow from it under way, no verdict is needed: the pool can't lose
    ///   anything, and the lender applies its own limit. Rhea's 20 blocks still hold it back; an Aave transaction
    ///   that waits for a verdict doesn't, so the owner can leave without one.
    /// - While the account owes our pool, the held verdict must be fresh, carry the current counter, answer a
    ///   `lender_withdraw` of this lender, token and amount, show the account HEALTHY and allow it (`allow.withdraw`
    ///   is then the amount, else 0). It also waits for a signed `sendAsset`, an overdue transfer and every lender
    ///   action under way, as `withdraw` does.
    /// - Never on a blocked account or while a borrow from our pool is under way.
    /// - It bumps the counter and lists the withdrawal as under way, with its token: for 20 blocks at Rhea, and at
    ///   Aave until a verdict shows the chain has used the transaction's nonce. If Rhea refuses the call itself, or
    ///   the signer gives no signature, the listing is dropped at once.
    ///
    /// **The USDC token:** up to `amount` of what a repayment above the debt left at Rhea as a plain deposit, by
    /// Rhea's `execute` with `Withdraw`. It backs no loan there and it comes to the account itself, where the pool's
    /// steps can use it. So anyone may call this, at any time, and it needs no verdict, lists nothing and leaves the
    /// counter alone.
    #[payable]
    pub fn lender_withdraw(&mut self, lender: String, token: String, amount: U128) -> Promise {
        assert_one_yocto();
        self.end_lender_wait();
        require!(amount.0 > 0, "amount must be positive");
        if self.named_lender(&lender) == AAVE {
            let asset = self.aave_token(&token, false);
            let (pool, _, me) = self.aave_addresses();
            self.assert_may_take_collateral(&lender, token, amount);
            self.assert_room_for_listing();
            let data = withdraw_data(&asset, Some(amount.0), &me);
            let nonce = self.start_evm(EvmKind::Withdraw, asset, amount.0, pool, data, None);
            self.counter += 1;
            self.list_aave_action(LenderKind::Withdraw, amount, &asset, nonce);
            return self.sign_evm();
        }
        let rhea = self.rhea_for(RHEA).clone();
        let listed = token.parse::<AccountId>().ok().filter(|id| self.config.token(id).is_some());
        let id = match listed {
            Some(id) if id == self.config.usdc_token || rhea.collateral.contains(&id) => id,
            _ => env::panic_str(&format!("{token} is not USDC or one of {lender}'s collateral tokens")),
        };
        let decimals = self.config.token(&id).map_or(0, |t| t.decimals);
        let inner =
            rhea_inner(amount.0, decimals).unwrap_or_else(|| env::panic_str("amount is too large for Rhea to take"));
        let call = |method: &str, args: Vec<u8>| {
            Promise::new(rhea.contract_id.clone()).function_call(method, args, ONE_YOCTO, GAS_FOR_RHEA_ACTIONS)
        };
        if id == self.config.usdc_token {
            // A plain deposit needs no prices, so it goes through `execute`.
            return call("execute", to_bytes(&deposit_out_actions(&id, inner)));
        }
        self.assert_may_take_collateral(&lender, token, amount);
        self.counter += 1;
        self.list_lender_action(lender, LenderKind::Withdraw, amount, Some(id.to_string()));
        let sent = Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_CALLBACK).on_lender_sent(None, 0);
        call("execute_with_pyth", to_bytes(&collateral_out_actions(&id, inner))).then(sent)
    }

    /// Has the pool settle what this account pays for its loans (FUNDING.md 4.7 and 5.2): calls the pool's `settle`
    /// with the held verdict's `ext` lines as its lender report. Anyone can call it (the keeper does, hourly), with
    /// 100 TGas. The verdict must be fresh and carry the current counter, so the report is the account's position
    /// as it is now. It leaves the counter alone. `on_settled` books the pool's answer.
    pub fn settle(&mut self) -> Promise {
        self.end_lender_wait();
        let report = lender_report(&self.usable_verdict().verdict.ext);
        self.settle_pool(report)
    }

    /// The pool's `settle` answer. A fee was added to the account's debt to the pool, so the account counts its loan
    /// there as open from then on; a subsidy came off that debt. Returns whether the pool's call succeeded. Never
    /// panics.
    #[private]
    pub fn on_settled(&mut self) -> bool {
        self.book_settlement()
    }

    /// Collects the account's credit at the pool: what subsidies left over once its debt there reached zero. The
    /// owner only, with 100 TGas. The pool pays it to the account in USDC, and the account books nothing.
    pub fn claim_credit(&mut self) -> Promise {
        self.end_lender_wait();
        self.assert_owner();
        ext_pool::ext(self.config.pool_id.clone()).with_static_gas(GAS_FOR_CLAIM_CREDIT).claim_credit()
    }

    // ---------------------------------------------------------------------------------------------------------
    // Ethereum transactions for Aave's chain (INTERFACES.md 33; FUNDING.md 4.5)
    // ---------------------------------------------------------------------------------------------------------

    /// Signs `approve(pool, the largest amount)` on `token`, so that Aave's Pool can take that token from the
    /// account's Ethereum address when the account supplies or repays. `token` is the Aave settings' USDC or one of
    /// their collateral tokens, as a `0x` address. Anyone can call it, with 100 TGas, once per token; the owner may
    /// have it signed again.
    ///
    /// It needs no verdict and lists nothing: the Pool only ever takes a token from whoever calls it, and only the
    /// account's own signed transactions call it from this address.
    pub fn evm_approve(&mut self, token: String) -> Promise {
        let asset = self.aave_token(&token, true);
        let (pool, _, _) = self.aave_addresses();
        if self.evm.approved.contains(&asset) {
            let again = "is signed already: only the owner can have it signed again";
            require!(env::predecessor_account_id() == self.owner, format!("the approval of {token} {again}"));
        }
        self.start_evm(EvmKind::Approve, asset, 0, asset, approve_data(&pool), None);
        self.sign_evm()
    }

    /// Signs `transfer(to, amount)` of `token` from the account's Ethereum address: the way out of Aave's chain.
    /// The owner only, with 1 yoctoNEAR and 100 TGas. `token` is the Aave settings' USDC or one of their collateral
    /// tokens, `amount` is in the token's own units, and `to` is a `0x` address.
    /// - With no loan from our pool and no borrow from it under way, no verdict is needed.
    /// - While the account owes our pool, the held verdict must be fresh, carry the current counter, answer an
    ///   `evm_withdraw` of this token and amount, show the account HEALTHY and allow it (`allow.withdraw` is then
    ///   the amount, else 0). It also waits for a signed `sendAsset`, an overdue transfer and a lender action under
    ///   way, as `withdraw` does.
    /// - Never on a blocked account or while a borrow from our pool is under way.
    /// - It bumps the counter and lists the transfer as under way, whether or not the pool is owed: a signed
    ///   transfer can be sent at any time, so until a verdict shows the chain has used its nonce, nothing that adds
    ///   risk runs. A loan can't be taken on tokens that a kept signature is about to send away.
    ///
    /// `exp` (optional) is the expiry (unix ms) of the 1Click quote whose deposit address is `to`: the move that
    /// brings the token home to NEAR. It is then also recorded as transfer `move:<n>` (`get_state().next_move`) of
    /// kind `e_home`, with `to` in lower case as its `dep`. Its `token` is `USDC` for the Aave settings' USDC, and a
    /// collateral token's address in lower case. The delivery on NEAR settles it, with the transfer's msg. It is
    /// dropped again if nothing is signed. Without `exp` nothing is recorded.
    ///
    /// `expect` (optional, with `exp`) is what that quote says will arrive on NEAR, `{"token", "amount"}`: the
    /// delivery then settles the transfer only when it is that token and 80% of that amount or more.
    #[payable]
    pub fn evm_withdraw(
        &mut self,
        token: String,
        amount: U128,
        to: String,
        exp: Option<u64>,
        expect: Option<Expect>,
    ) -> Promise {
        assert_one_yocto();
        self.end_lender_wait();
        self.assert_owner();
        self.assert_not_blocked();
        require!(amount.0 > 0, "amount must be positive");
        let asset = self.aave_token(&token, true);
        let (_, usdc, _) = self.aave_addresses();
        let to = parse_evm_address(&to).unwrap_or_else(|| env::panic_str("to must be 0x and 40 hex digits"));
        require!(!self.borrowing(), "a borrow is under way: wait for it to finish");
        if self.loan.open {
            let what = "Ethereum withdrawal with a loan open";
            self.assert_no_send_open(what);
            self.assert_none_overdue(what);
            self.assert_no_lender_wait(what);
            let held = self.usable_verdict();
            // An address is the same token in any case.
            let asked = matches!(&held.intent, Intent::EvmWithdraw { token: t, amount: a }
                if t.eq_ignore_ascii_case(&token) && *a == amount);
            require!(asked, "with a loan open, an Ethereum withdrawal needs a verdict for this token and amount");
            let v = &held.verdict;
            require!(v.state == State::Healthy, "the verdict's state isn't HEALTHY");
            require!(v.allow.withdraw >= amount.0, "the verdict doesn't allow this withdrawal");
        }
        self.assert_room_for_listing();
        self.assert_evm_free();
        require!(expect.is_none() || exp.is_some(), "expect needs exp: only a recorded move expects a delivery");
        let expect = self.checked_expect(expect);
        let record = exp.map(|exp| {
            let sent = if asset == usdc { HOME_TOKEN.to_string() } else { address_text(&asset) };
            self.new_move(TransferKind::EHome, &sent, amount.0, &address_text(&to), exp).expecting(expect)
        });
        let nonce = self.start_evm(EvmKind::Transfer, asset, amount.0, asset, transfer_data(&to, amount.0), None);
        self.counter += 1;
        self.list_aave_action(LenderKind::Transfer, amount, &asset, nonce);
        let id = record.map(|t| self.record_transfer(t));
        if let Some(signing) = self.evm.signing.as_mut() {
            signing.transfer = id;
        }
        self.sign_evm()
    }

    /// Signs the kept transaction with this `nonce` again with higher fees, for one that a node won't take or mine
    /// at the fees it has. Anyone can call it, with 100 TGas. `max_fee` and `tip` are in wei a gas.
    /// - Each is at least a tenth above the kept transaction's: a node takes a replacement only then.
    /// - `max_fee` is at most an eighth above the kept one, so each bump uses one of the seven steps of room up to
    ///   the limit and no more.
    /// - Anyone but the owner waits 60 seconds from the block time the kept transaction was signed. The owner bumps
    ///   at once.
    /// - `max_fee` is never above the account's own limit (`lenders.aave.max_fee_per_gas`), and `tip` never above
    ///   `max_fee`. A first try offers half that limit, so there is room for seven bumps of a tenth.
    /// - A transaction the held verdict shows as mined already is refused.
    ///
    /// It is the same call with the same nonce, so only one of the two can ever be mined. It replaces the kept one
    /// in `evm.signed`, uses no new nonce, and changes nothing else.
    pub fn evm_bump(&mut self, nonce: u64, max_fee: U128, tip: U128) -> Promise {
        let limit = self.aave().max_fee_per_gas.0;
        let kept = self.evm.signed.iter().find(|kept| kept.tx.nonce == nonce);
        let kept = kept.unwrap_or_else(|| env::panic_str(&format!("no signed transaction with nonce {nonce} is kept")));
        let mined = self.verdict.as_ref().and_then(|held| held.verdict.evm.as_ref()).is_some_and(|e| e.nonce > nonce);
        require!(!mined, format!("the transaction with nonce {nonce} is mined already"));
        require!(max_fee.0 <= limit, format!("max_fee is above this account's limit of {limit} wei a gas"));
        require!(tip.0 <= max_fee.0, "tip can't be above max_fee");
        // What Ethereum's nodes ask of a replacement: both higher, and both by a tenth (go-ethereum's price bump).
        let raised = |new: u128, old: u128| new > old && new >= old.saturating_add(old / 10);
        require!(
            raised(max_fee.0, kept.tx.max_fee) && raised(tip.0, kept.tx.tip),
            "a bump raises both the fee and the tip by at least a tenth"
        );
        // One bump uses one step of the room up to the limit and no more, whoever calls (research/audit.md, A10):
        // an eighth above the kept fee, rounded down, and never under the tenth a node asks for, rounded up.
        let old = kept.tx.max_fee;
        let most = old.saturating_add(old / 8).max(old.saturating_add(old.div_ceil(10)).max(old.saturating_add(1)));
        require!(max_fee.0 <= most, format!("a bump raises the fee by an eighth at most: {most} wei a gas"));
        // Anyone but the owner gives the first try a minute.
        if env::predecessor_account_id() != self.owner {
            let ready = kept.signed_at.saturating_add(BUMP_WAIT_NS);
            let left = ready.saturating_sub(env::block_timestamp());
            require!(
                left == 0,
                format!(
                    "anyone but the owner bumps a transaction once it is 60 seconds old: wait {} s",
                    left.div_ceil(1_000_000_000)
                )
            );
        }
        let tx = EvmTx { max_fee: max_fee.0, tip: tip.0, ..kept.tx.clone() };
        let (kind, token, amount, step) = (kept.kind, kept.token, kept.amount, kept.step.clone());
        self.assert_evm_free();
        let until_block = env::block_height().saturating_add(SIGNING_BLOCKS);
        let transfer = None;
        self.evm.signing = Some(EvmSigning { tx, kind, token, amount, step, transfer, bump: true, until_block });
        self.sign_evm()
    }

    /// The signer's answer for the Ethereum transaction whose signing hash is `digest`. Keeps the signed transaction
    /// in `evm.signed` (the newest 20), logs `evm_signed` with its nonce, kind and hash, and returns the entry as
    /// `get_state().evm` shows it. A new transaction takes the account's next nonce only now; a bumped one replaces
    /// the kept one. An answer for a transaction that is no longer the one under way changes nothing.
    ///
    /// With no signature, nothing is kept, no nonce is used, null is returned and a plan step may run again.
    /// - The signer's call failed or timed out, so no signature exists: a listed borrow, withdrawal or transfer is
    ///   dropped, which moves the counter on.
    /// - The signer answered something the account can't read: a signature may exist all the same, so the listing
    ///   stays until a verdict shows the chain has used that nonce.
    ///
    /// A posting of collateral moves the counter on again either way, as Rhea's does. Never panics.
    #[private]
    pub fn on_evm_signed(&mut self, digest: String) -> Option<EvmSignedView> {
        let asked = |signing: &mut EvmSigning| hex(&signing.tx.signing_hash()) == digest;
        let Some(signing) = self.evm.signing.take_if(asked) else {
            log!("no Ethereum transaction was waiting for this signature");
            return None;
        };
        let answer = env::promise_result_checked(0, MAX_SIGNATURE_BYTES);
        if signing.kind == EvmKind::Supply && !signing.bump {
            self.counter = self.counter.saturating_add(1);
        }
        let read = match answer {
            Ok(bytes) => hl_signature(&bytes).and_then(|signature| {
                EvmSignature::from_signer(&signature).ok_or_else(|| "the signature is not r, s and v".to_string())
            }),
            Err(PromiseError::TooLong(len)) => Err(format!("the answer is {len} bytes, above {MAX_SIGNATURE_BYTES}")),
            // The signer's call itself failed: no answer, so no signature, exists.
            Err(_) => {
                self.undo_evm(signing, "the MPC signer failed or timed out", false);
                return None;
            }
        };
        match read {
            Ok(signature) => {
                let entry = self.evm.record(signing, signature, env::block_timestamp()).view();
                Event::EvmSigned { nonce: entry.nonce, kind: entry.kind, hash: &entry.hash }.emit();
                Some(entry)
            }
            Err(reason) => {
                self.undo_evm(signing, &reason, true);
                None
            }
        }
    }

    /// Repays the pool from the account's USDC, by `ft_transfer_call` with `{"pool":"repay"}`. The pool takes at most
    /// the debt and sends back the rest. The owner, with 1 yoctoNEAR. Anyone may too, because repaying only lowers
    /// risk, when the held verdict's action is DELEVERAGE, or when it says MARGIN_CALL or worse and arrived more than
    /// 30 minutes ago by block time (OutLayer may be down).
    #[payable]
    pub fn repay(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        self.end_lender_wait();
        self.assert_may_repay();
        require!(amount.0 > 0, "amount must be positive");
        self.repay_pool(amount)
    }

    /// Books what the pool used of a repayment, which the token returns. `seq` is the loan record's count when the
    /// repayment was sent. If it hasn't moved, a repayment that came back partly unused closes the loan, as before.
    /// If it has, a loan or a settlement's fee was booked while the repayment was on its way: the pool worked out
    /// what to send back before that debt, so the principal comes down by what the pool used and the loan stays
    /// open, whatever came back. The next repayment that comes back unused closes it (research/audit.md, A13).
    /// Never panics.
    #[private]
    pub fn on_repaid(&mut self, amount: U128, seq: u64) -> U128 {
        match result_u128().map(|used| used.min(amount.0)) {
            Some(used) if seq == self.loan_seq => {
                self.loan.book_repayment(amount.0, used);
                log!("repaid {used}");
                U128(used)
            }
            Some(used) => {
                self.loan.principal = U128(self.loan.principal.0.saturating_sub(used));
                log!("repaid {used}: new debt to the pool was booked meanwhile, so the loan stays open");
                U128(used)
            }
            None => {
                log!("the repayment of {} failed", amount.0);
                U128(0)
            }
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Withdrawing
    // ---------------------------------------------------------------------------------------------------------

    /// Sends `amount` of an allow-listed `token` to `receiver`. The owner only, with 1 yoctoNEAR.
    /// - With no loan open and no borrow under way, no verdict is needed: the pool can't lose anything.
    /// - With a loan open, the held verdict must be fresh, answer a withdrawal of this token and amount, show the
    ///   account HEALTHY, and allow it: `allow.withdraw` is then the amount if the engine allows it, else 0. It also
    ///   waits while a signed `sendAsset` could still be posted, as `borrow` does, and while a transfer is overdue.
    /// - `transfer` (optional), `{"kind": "to_hl" | "sell" | "to_evm", "exp": <ms>}`, says `receiver` is a 1Click
    ///   deposit address and `exp` its quote's expiry. The move is recorded as transfer `move:<n>`
    ///   (`get_state().next_move`) with the token's id, and dropped again if the tokens don't go out. `to_hl` sends
    ///   USDC, and `sell` another token. A `sell` may add `expect`, `{"token", "amount"}`: what its quote says will
    ///   arrive. Its delivery then settles the transfer only when it is that token and 80% of that amount or more.
    /// - `to_evm` sends any allow-listed token, USDC included, on its way to the account's own address on Aave's
    ///   chain. It needs Aave in the account's config and the address (`hl_init`). The account can't see that chain:
    ///   a verdict that lists the transfer in `arrived` settles it, or its refund on NEAR does.
    ///
    /// It bumps the counter, then registers `receiver` on the token if needed and transfers, in one batch, and `on_sent`
    /// bumps the counter again once the tokens have gone. Refused once the account is blocked after a default.
    ///
    /// The registration costs 0.00125 NEAR of the account's own. It is paid only while the account keeps
    /// `NEAR_RESERVE` (0.3 NEAR) free of its storage after it. Below that the transfer goes out alone: it reaches a
    /// receiver the token knows already, and fails for a new one, which `on_sent` undoes (research/audit.md, A16).
    #[payable]
    pub fn withdraw(&mut self, token: AccountId, amount: U128, receiver: AccountId, transfer: Option<Move>) -> Promise {
        assert_one_yocto();
        self.end_lender_wait();
        self.assert_owner();
        self.assert_not_blocked();
        require!(amount.0 > 0, "amount must be positive");
        require!(self.config.token(&token).is_some(), "not an allow-listed token");
        require!(!self.borrowing(), "a borrow is under way: wait for it to finish");
        let record = transfer.map(|m| {
            let usdc = token == self.config.usdc_token;
            match m.kind {
                TransferKind::ToHl => require!(usdc, "a to_hl move sends the USDC token"),
                TransferKind::Sell => require!(!usdc, "a sell move sends a token other than USDC"),
                TransferKind::Home => env::panic_str("a home move is hl_withdraw's"),
                // The token goes to the account's own address on Aave's chain, which it must have.
                TransferKind::ToEvm => drop(self.aave_addresses()),
                TransferKind::EHome => env::panic_str("an e_home move is evm_withdraw's"),
            }
            // Only a sale brings another token back to NEAR, so only a sale says what to expect.
            require!(m.expect.is_none() || m.kind == TransferKind::Sell, "only a sell move takes expect");
            let expect = self.checked_expect(m.expect);
            self.new_move(m.kind, token.as_str(), amount.0, receiver.as_str(), m.exp).expecting(expect)
        });
        if self.loan.open {
            self.assert_no_send_open("withdrawal with a loan open");
            self.assert_none_overdue("withdrawal with a loan open");
            self.assert_no_lender_wait("withdrawal with a loan open");
            let held = self.usable_verdict();
            require!(
                held.intent == Intent::Withdraw { token: token.clone(), amount },
                "with a loan open, a withdrawal needs a verdict for this token and amount"
            );
            let v = &held.verdict;
            require!(v.state == State::Healthy, "the verdict's state isn't HEALTHY");
            require!(v.allow.withdraw >= amount.0, "the verdict doesn't allow this withdrawal");
        }
        self.counter += 1;
        let id = record.map(|t| self.record_transfer(t));
        send_token(token, &receiver, amount, id, keeps_near_reserve(STORAGE_DEPOSIT))
    }

    /// Drops 1Click transfer `id` once it is overdue. A transfer that failed returns nothing and sends no msg, so
    /// without this it would hold back borrowing for good. The owner only, with 1 yoctoNEAR. It logs `transfer_done`
    /// with `how: "forgotten"`.
    ///
    /// This is safe for the pool: money in transit already counts as 0 for credit. If the money arrives later anyway,
    /// its msg names no transfer under way, so `ft_on_transfer` keeps it as a deposit.
    #[payable]
    pub fn forget_transfer(&mut self, id: String) {
        assert_one_yocto();
        self.assert_owner();
        let deadline = self.transfers().find(|t| t.id == id).map(|t| t.deadline.0);
        let deadline = deadline.unwrap_or_else(|| env::panic_str(&format!("no transfer {id} is under way")));
        if env::block_timestamp() <= deadline {
            let at = utc(deadline / 1_000_000);
            env::panic_str(&format!("transfer {id} isn't overdue yet: its deadline is {at}"));
        }
        self.settle_transfer(&id, |_| "forgotten");
    }

    // ---------------------------------------------------------------------------------------------------------
    // Hyperliquid (INTERFACES.md 8)
    // ---------------------------------------------------------------------------------------------------------

    /// Derives the account's Hyperliquid address. Anyone can call it, with 100 TGas. If `hl.address` isn't set, it
    /// asks the MPC signer for the key at path `hyperliquid-1` with this account as predecessor, and `on_hl_key`
    /// stores the address. If it is set, it does nothing and returns it.
    pub fn hl_init(&mut self) -> PromiseOrValue<Option<String>> {
        if let Some(address) = &self.hl.address {
            return PromiseOrValue::Value(Some(address.clone()));
        }
        let account = env::current_account_id();
        let args = DerivedKeyArgs { path: HL_PATH, predecessor: &account, domain_id: 0 };
        let no_deposit = NearToken::from_yoctonear(0);
        let ask = Promise::new(self.config.mpc_id.clone()).function_call(
            "derived_public_key",
            to_bytes(&args),
            no_deposit,
            GAS_FOR_DERIVED_KEY,
        );
        PromiseOrValue::Promise(ask.then(Self::ext(account).with_static_gas(GAS_FOR_ON_HL_KEY).on_hl_key()))
    }

    /// The MPC signer's `derived_public_key` answer, `"secp256k1:<base58 of x‖y>"`. Stores the address `0x` and the
    /// last 20 bytes of keccak256(x‖y), and returns it. On a failure it stores nothing, logs why and returns null.
    /// Never panics.
    #[private]
    pub fn on_hl_key(&mut self) -> Option<String> {
        let address = match env::promise_result_checked(0, MAX_KEY_BYTES) {
            Ok(bytes) => serde_json::from_slice::<String>(&bytes)
                .map_err(|_| "the answer is not a key".to_string())
                .and_then(|key| key_address(&key)),
            Err(PromiseError::TooLong(len)) => Err(format!("the answer is {len} bytes, above {MAX_KEY_BYTES}")),
            Err(_) => Err("the MPC signer's derived_public_key failed".to_string()),
        };
        match address {
            // Two hl_init calls can both be under way; both get the same key, and the first one sets it.
            Ok(_) if self.hl.address.is_some() => self.hl.address.clone(),
            Ok(address) => {
                log!("Hyperliquid address {address}");
                self.hl.address = Some(address.clone());
                Some(address)
            }
            Err(reason) => {
                log!("no Hyperliquid address: {reason}");
                None
            }
        }
    }

    /// Asks the pinned `pb-gateway` for this account's Hyperliquid agent (mode `agent_address`, INTERFACES.md 9).
    /// The owner only. Attach at least 0.01 NEAR, which goes to OutLayer and comes back to the caller less the
    /// run's cost, and 300 TGas. `on_agent` stores the agent. Only the account's own call can answer, and that call
    /// pins the gateway's project and version, so nobody can hand the account another agent.
    ///
    /// `config.gateway.secrets_ref` goes to `request_execution` as it is, null if the config has none.
    #[payable]
    pub fn request_agent(&mut self) -> Promise {
        self.assert_owner();
        let deposit = env::attached_deposit();
        require!(deposit >= MIN_CHECK_DEPOSIT, "attach at least 0.01 NEAR for OutLayer");
        let gateway = &self.config.gateway;
        require!(!gateway.version_key.is_empty(), "no pb-gateway version is pinned in this account's config");
        let account = env::current_account_id();
        let input = AgentInput { mode: "agent_address", account: &account, network: network(&account) };
        self.run(&gateway.project_id, &gateway.version_key, gateway.secrets_ref.as_ref(), &input, deposit)
            .then(Self::ext(account).with_static_gas(GAS_FOR_ON_AGENT).on_agent())
    }

    /// The gateway's answer. Keeps the agent if the answer is `{"ok":true,"acct":<this account>,"agent":"0x…"}`;
    /// otherwise keeps nothing and logs which check failed. Never panics.
    #[private]
    pub fn on_agent(&mut self) -> CheckOutcome {
        let account = env::current_account_id();
        let agent = match env::promise_result_checked(0, MAX_VERDICT_BYTES) {
            Ok(bytes) => agent_from_answer(&bytes, account.as_str()),
            Err(PromiseError::TooLong(len)) => {
                Err(format!("the answer is {len} bytes, above the {MAX_VERDICT_BYTES}-byte limit"))
            }
            Err(_) => Err("OutLayer's call failed".to_string()),
        };
        match agent {
            Ok(address) => {
                log!("agent {address} accepted");
                self.hl.agent = Some(Agent { address, received_block: env::block_height() });
                CheckOutcome { accepted: true, reason: None }
            }
            Err(reason) => {
                log!("agent refused: {reason}");
                CheckOutcome { accepted: false, reason: Some(reason) }
            }
        }
    }

    /// Has the MPC signer sign Hyperliquid's `approveAgent` for the gateway's agent, named
    /// `pb valid_until <ms>` with ms 180 days from now. The owner only, with 1 yoctoNEAR and 300 TGas. It needs
    /// `hl.address` and `hl.agent`. A loan doesn't stop it: an agent only binds the client tighter, because every
    /// order then goes through the gateway's checks. The signed action arrives in `on_hl_signed`.
    #[payable]
    pub fn hl_approve_agent(&mut self) -> Promise {
        assert_one_yocto();
        self.assert_owner();
        require!(self.hl.address.is_some(), "no Hyperliquid address yet: call hl_init first");
        let agent = self.hl.agent.clone().unwrap_or_else(|| env::panic_str("no agent yet: call request_agent first"));
        let now_ms = env::block_timestamp_ms();
        let nonce = self.hl.take_nonce(now_ms);
        let name = format!("pb valid_until {}", now_ms.saturating_add(AGENT_VALID_MS));
        let action = ApproveAgent {
            kind: ApproveAgent::KIND,
            hyperliquid_chain: &self.config.hl_chain,
            signature_chain_id: &self.config.signature_chain_id,
            agent_address: &agent.address,
            agent_name: &name,
            nonce,
        };
        let digest = action.digest().unwrap_or_else(|| env::panic_str("the agent address or the chain id isn't hex"));
        self.sign_hl(ActionKind::ApproveAgent, to_string(&action), nonce, &digest, None)
    }

    /// Has the MPC signer sign Hyperliquid's `sendAsset` of `amount` micro-USDC to `destination`, such as the 1Click
    /// deposit address that brings it home. The owner only, with 1 yoctoNEAR and 300 TGas.
    /// - `destination` is `0x` and 40 hex digits, stored lowercase.
    /// - `source_dex` is `""` (the default: the perp balance) or `"spot"`. The USDC lands in the destination's perp
    ///   balance (`destinationDex` is `""`).
    ///
    /// Refused while a loan is open or a borrow is under way: the test `withdraw` uses for a loan. A later phase adds
    /// the `from_hl` verdict. Like `withdraw`, it bumps the counter, so no verdict read before it can back a later
    /// borrow. It also opens `hl.send_open_until_ms`, which holds back actions that need a verdict until the signed
    /// action can no longer be posted. The signed action arrives in `on_hl_signed`.
    ///
    /// `exp` (optional) is the expiry (unix ms) of the 1Click quote whose deposit address is `destination`. The move
    /// is recorded as transfer `move:<n>` (`get_state().next_move`), and dropped again if the signature fails.
    /// `expect` (optional, with `exp`) is what that quote says will arrive on NEAR, `{"token", "amount"}`: the
    /// delivery then settles the transfer only when it is that token and 80% of that amount or more.
    #[payable]
    pub fn hl_withdraw(
        &mut self,
        amount: U128,
        destination: String,
        source_dex: Option<String>,
        exp: Option<u64>,
        expect: Option<Expect>,
    ) -> Promise {
        assert_one_yocto();
        self.end_lender_wait();
        self.assert_owner();
        self.assert_not_blocked();
        require!(amount.0 > 0, "amount must be positive");
        require!(!self.borrowing(), "a borrow is under way: wait for it to finish");
        require!(!self.loan.open, "no Hyperliquid withdrawal while a loan is open");
        require!(self.hl.address.is_some(), "no Hyperliquid address yet: call hl_init first");
        let destination =
            parse_address(&destination).unwrap_or_else(|| env::panic_str("destination must be 0x and 40 hex digits"));
        let source_dex = source_dex.unwrap_or_default();
        require!(source_dex.is_empty() || source_dex == "spot", r#"source_dex must be "" (perps) or "spot""#);
        require!(expect.is_none() || exp.is_some(), "expect needs exp: only a recorded move expects a delivery");
        let expect = self.checked_expect(expect);
        let record =
            exp.map(|exp| self.new_move(TransferKind::Home, HOME_TOKEN, amount.0, &destination, exp).expecting(expect));
        self.counter += 1;
        let id = record.map(|t| self.record_transfer(t));
        self.sign_send(amount.0, &destination, &source_dex, id)
    }

    /// The MPC signer's answer for an action. Turns it into Hyperliquid's `{r, s, v}`, appends the action to
    /// `hl.signed` (which keeps the newest 20), logs an `hl_signed` event and returns the entry. A failed or timed-out
    /// signature stores nothing, logs why and returns null; a `sendAsset` that brings USDC home through 1Click then
    /// also drops its `transfer`, recorded when it was asked for. Never panics.
    #[private]
    pub fn on_hl_signed(
        &mut self,
        kind: ActionKind,
        action: String,
        nonce: u64,
        transfer: Option<String>,
    ) -> Option<SignedAction> {
        let signature = match env::promise_result_checked(0, MAX_SIGNATURE_BYTES) {
            Ok(bytes) => hl_signature(&bytes),
            Err(PromiseError::TooLong(len)) => Err(format!("the answer is {len} bytes, above {MAX_SIGNATURE_BYTES}")),
            Err(_) => Err("the MPC signer failed or timed out".to_string()),
        };
        let signature = match signature {
            Ok(signature) => signature,
            Err(reason) => {
                log!("nothing signed: {reason}");
                if let Some(id) = transfer {
                    self.drop_transfer(&id);
                }
                return None;
            }
        };
        let entry = self.hl.record(kind, action, nonce, signature);
        let account = env::current_account_id();
        Event::HlSigned(&[HlSigned { account: &account, index: entry.index, kind, nonce }]).emit();
        Some(entry)
    }

    // ---------------------------------------------------------------------------------------------------------
    // The plan (INTERFACES.md 14)
    // ---------------------------------------------------------------------------------------------------------

    /// Runs step `i` of the stored plan `pid`. Anyone can call it, with 300 TGas. It refuses a `pid` that isn't the
    /// stored plan's, a step that has started, and the steps the gateway places (`cancel`, `perp`) or the account
    /// doesn't know. Otherwise, by kind:
    /// - `repay`: repays the smaller of `amt`, the account's USDC and its debt (the pool sends back what is above the
    ///   debt). It needs no `check_step`, so repaying always runs, even on a blocked account.
    /// - `sell`, `to_hl`, `home`: each needs 5 minutes of its quote left and a quote that expires at most 24 hours
    ///   ahead, and asks the pool's `check_step` first. Then
    ///   `sell` and `to_hl` send the token to `dep`, and `home` has the MPC signer sign a `sendAsset` of perp USDC to
    ///   `dep`, which opens the send window. The transfer is recorded as `<pid>:<i>` as it goes out, and dropped
    ///   again if the tokens don't go out or the signature fails. Like a withdrawal, these bump the counter, and `sell`
    ///   and `to_hl` bump it again once their tokens have gone.
    ///
    /// The step is marked done when it starts, so it runs once, and `step_run` is logged. If the pool refuses it, or
    /// a repay finds no USDC or can't read it, nothing moves and the step may run again.
    ///
    /// **A top-up plan's lender steps** (FUNDING.md 6.5) are checked against the config and run whatever the owner's
    /// permission says. At Rhea they run as below. At Aave each is an Ethereum transaction the account signs, under
    /// the same rules (`execute_top_up_step`).
    /// - `l_repay`: repays Rhea the smaller of `amt` and the account's USDC, by `ft_transfer_call` with `"OnlyRepay"`.
    ///   It needs no verdict and leaves the counter alone, so it runs even on a blocked account. It asks the pool's
    ///   `check_step` first, for the USDC it sends: a paused pool, or a day's steps past the pool's limit, holds it
    ///   back. With a fresh verdict held, the pool settles the client's price first. If the account holds no USDC,
    ///   the step may run again.
    /// - `l_add`: posts `amt` of `tok` at Rhea as collateral, by `ft_transfer_call` with `"OnlyIncreaseCollateral"`,
    ///   once the pool's `check_step` has taken the step.
    ///   Never on a blocked account or while a borrow from our pool is under way. It runs only while the held
    ///   verdict is the one that ordered it: its `blk` is the plan's id. While the account owes our pool that
    ///   verdict must also be fresh and carry the current counter, in any state. It bumps the counter as the tokens
    ///   go and again once they have gone. If Rhea takes none, the step may run again.
    ///
    /// **A `pid` that starts with `f` is the funding plan** (INTERFACES.md 25). Its steps run strictly in order: step
    /// `i` only once every step before it has started. It also needs the plan inside its 30 minutes, an account that
    /// isn't blocked, no overdue transfer and no lender action under way. Each step is checked again against the
    /// config and the permission, so a lender the owner has stopped permitting since is not used.
    /// - `p_borrow`: borrows the smaller of `amt` and the held verdict's `allow.borrow` from the pool, on `borrow`'s
    ///   own path: the verdict must be fresh, carry the current counter and show the account HEALTHY (any intent
    ///   will do), no borrow may be under way and no signed `sendAsset` still open, and the counter moves on as the
    ///   borrow starts and again as it ends. An allowance of 0 is refused. If the pool lends nothing, the step may
    ///   run again.
    /// - `l_supply` at Rhea: posts `amt` of `tok` as collateral, as `l_add` does, and pays Rhea's registration
    ///   (0.1 NEAR of the account's own) until Rhea has taken collateral once. While the account owes our pool it
    ///   needs a fresh HEALTHY verdict with the current counter and no signed `sendAsset` still open.
    /// - `l_borrow` at Rhea: borrows the smaller of `amt` and the held verdict's `ext[rhea].room`, on a fresh HEALTHY
    ///   verdict with the current counter; a room of 0 is refused. It bumps the counter and lists the borrow as
    ///   under way for 20 blocks. The pool's `settle` runs first with the verdict's lender report, in which Rhea's
    ///   debt counts what this step borrows, and only if it succeeds does the account call Rhea's
    ///   `execute_with_pyth` with `Borrow` then `Withdraw`. The account books no Rhea loan: Rhea doesn't report
    ///   failure, and the engine reads the real position. If the pool's settlement fails, or Rhea refuses the call
    ///   itself, the step may run again.
    /// - `l_supply` and `l_borrow` at Aave: the same rules, each as an Ethereum transaction the account signs
    ///   (`supply_at_aave`, `lender_borrow_for_step`). A signed borrow is listed until a verdict shows the chain has
    ///   used its nonce.
    /// - `to_evm` and `e_home`: the mainnet path, where the engine plans a move with 1Click's own quote. That is not
    ///   built, and these answer that the account can't run them yet. The owner starts those moves: `withdraw` with
    ///   a `to_evm` transfer, and `evm_withdraw` with `exp`.
    pub fn execute_step(&mut self, pid: String, i: u32) -> Promise {
        self.end_lender_wait();
        if pid.starts_with('f') {
            return self.execute_funding_step(pid, i);
        }
        let plan = self.plan.as_ref().unwrap_or_else(|| env::panic_str("no plan is stored"));
        require!(plan.pid.to_string() == pid, format!("plan {pid} is not the stored plan, {}", plan.pid));
        let step = plan.steps.get(i as usize).unwrap_or_else(|| env::panic_str(&format!("plan {pid} has no step {i}")));
        require!(!step.done, format!("step {i} of plan {pid} has already run"));
        if matches!(kind_of(&step.json).as_str(), "l_repay" | "l_add") {
            let json = step.json.clone();
            return self.execute_top_up_step(pid, i, &json);
        }
        let run = parse_step(&step.json).unwrap_or_else(|why| env::panic_str(&format!("step {i} {why}")));
        let me = env::current_account_id();
        let ready = Self::ext(me.clone()).with_static_gas(GAS_FOR_ON_STEP).on_step_ready(pid.clone(), i);
        let (token, amount) = match &run {
            Run::Repay { .. } => {
                self.start_step(i);
                let usdc = ext_ft::ext(self.config.usdc_token.clone()).with_static_gas(GAS_FOR_BALANCE);
                return usdc.ft_balance_of(me).then(ready);
            }
            Run::Sell { tok, amt, .. } => (tok.clone(), *amt),
            Run::ToHl { amt, .. } | Run::Home { amt, .. } => (self.config.usdc_token.clone(), *amt),
        };
        self.assert_not_blocked();
        let left = run.exp().unwrap_or_default().saturating_sub(env::block_timestamp_ms());
        require!(
            left >= QUOTE_LEFT_MS,
            format!("step {i}'s quote has {} s left: a step needs 5 minutes", left / 1_000)
        );
        // The engine never plans one. If it is wrong, no transfer is recorded for longer than a quote can live.
        require!(left <= MAX_QUOTE_LIFE_MS, "the step's quote expires more than 24 hours ahead");
        require!(self.config.token(&token).is_some(), "the step's token is not an allow-listed token");
        if let Run::Home { .. } = run {
            require!(self.hl.address.is_some(), "no Hyperliquid address yet: call hl_init first");
        }
        self.assert_room_for_transfer();
        self.counter += 1;
        self.start_step(i);
        ext_pool::ext(self.config.pool_id.clone())
            .with_static_gas(GAS_FOR_CHECK_STEP)
            .check_step(pid, i, token, U128(amount))
            .then(ready)
    }

    /// The pool's `check_step`, or the account's USDC for a repay, has answered for step `i` of plan `pid`. Sends the
    /// step: repays, transfers, or has the signer sign. If the pool refused it, or a repay finds no USDC or can't read
    /// it, nothing moves and the step may run again. If a newer plan replaced this one meanwhile, nothing moves. Never
    /// panics.
    #[private]
    pub fn on_step_ready(&mut self, pid: String, i: u32) -> PromiseOrValue<bool> {
        let step = self.plan.as_ref().filter(|p| p.pid.to_string() == pid).and_then(|p| p.steps.get(i as usize));
        let Some(Ok(run)) = step.map(|s| parse_step(&s.json)) else {
            log!("plan {pid} was replaced before step {i} went out: nothing was sent");
            return PromiseOrValue::Value(false);
        };
        let id = format!("{pid}:{i}");
        let sent = match run {
            Run::Repay { amt } => match result_u128() {
                Some(0) => Err("the account holds no USDC yet"),
                Some(usdc) => Ok(self.repay_pool(U128(amt.min(usdc)))),
                None => Err("the account's USDC couldn't be read"),
            },
            _ if !succeeded() => Err("the pool refused it"),
            Run::Sell { tok, amt, dep, exp } => {
                let id =
                    self.record_transfer(Transfer::new(id, TransferKind::Sell, tok.as_str(), amt, dep.as_str(), exp));
                Ok(send_token(tok, &dep, U128(amt), Some(id), true))
            }
            Run::ToHl { amt, dep, exp } => {
                let usdc = self.config.usdc_token.clone();
                let id =
                    self.record_transfer(Transfer::new(id, TransferKind::ToHl, usdc.as_str(), amt, dep.as_str(), exp));
                Ok(send_token(usdc, &dep, U128(amt), Some(id), true))
            }
            Run::Home { amt, dep, exp } => {
                let id = self.record_transfer(Transfer::new(id, TransferKind::Home, HOME_TOKEN, amt, &dep, exp));
                Ok(self.sign_send(amt, &dep, "", Some(id)))
            }
        };
        match sent {
            Ok(promise) => PromiseOrValue::Promise(promise),
            Err(why) => {
                if let Some(step) = self.plan.as_mut().and_then(|p| p.steps.get_mut(i as usize)) {
                    step.done = false;
                }
                log!("step {i} of plan {pid} didn't go out, as {why}: nothing was sent, and it may run again");
                PromiseOrValue::Value(false)
            }
        }
    }

    /// The account's USDC has been read for `l_repay` step `i` of plan `pid`. What goes to Rhea is the smaller of the
    /// step's amount and that USDC: the pool's `check_step` is asked for it first, and `on_repay_checked` repays. If
    /// the account holds no USDC yet, or it can't be read, nothing moves and the step may run again. If a newer plan
    /// replaced this one meanwhile, nothing moves. Never panics.
    #[private]
    pub fn on_repay_ready(&mut self, pid: String, i: u32) -> PromiseOrValue<bool> {
        let step = self.plan.as_ref().filter(|p| p.pid.to_string() == pid).and_then(|p| p.steps.get(i as usize));
        let rhea = self.config.lenders.rhea.as_ref().map(|rhea| rhea.contract_id.clone());
        let (Some(Ok(FundStep::LRepay { amt, .. })), Some(rhea)) = (step.map(|s| parse_fund_step(&s.json)), rhea)
        else {
            log!("plan {pid} was replaced before step {i} went out: nothing was sent");
            return PromiseOrValue::Value(false);
        };
        let why = match result_u128() {
            Some(0) => "the account holds no USDC yet",
            Some(usdc) => {
                // The USDC leaves for the lender, so the pool's pause and its day's limit for plan steps hold for
                // it as for a transfer step (research/audit.md, A17). The pool is asked for what will be sent.
                let amount = U128(amt.min(usdc));
                let me = env::current_account_id();
                let checked =
                    Self::ext(me).with_static_gas(GAS_FOR_ON_REPAY_CHECKED).on_repay_checked(pid.clone(), i, amount);
                let _ = rhea;
                return PromiseOrValue::Promise(
                    ext_pool::ext(self.config.pool_id.clone())
                        .with_static_gas(GAS_FOR_CHECK_STEP)
                        .check_step(pid, i, self.config.usdc_token.clone(), amount)
                        .then(checked),
                );
            }
            None => "the account's USDC couldn't be read",
        };
        self.reopen_step(&pid, i);
        log!("step {i} of plan {pid} didn't go out, as {why}: nothing was sent, and it may run again");
        PromiseOrValue::Value(false)
    }

    /// The pool's `check_step` has answered for `l_repay` step `i` of plan `pid` at Rhea, which is about to send
    /// `amount` of the account's USDC. If the pool took the step, the repayment goes to Rhea. If it refused it (the
    /// pool is paused, or the account's steps of the last 24 hours would pass the pool's limit), nothing moves and
    /// the step may run again. Never panics.
    #[private]
    pub fn on_repay_checked(&mut self, pid: String, i: u32, amount: U128) -> PromiseOrValue<bool> {
        let rhea = self.config.lenders.rhea.as_ref().map(|rhea| rhea.contract_id.clone());
        match rhea {
            Some(rhea) if succeeded() => PromiseOrValue::Promise(self.repay_rhea(rhea, amount)),
            _ => {
                self.reopen_step(&pid, i);
                log!("step {i} of plan {pid} didn't go out, as the pool refused it: nothing was sent, and it may run again");
                PromiseOrValue::Value(false)
            }
        }
    }

    /// The pool's `check_step` has answered for `l_add` step `i` of plan `pid` at Rhea, which is about to post
    /// `amount` of `token` there. If the pool took the step, the collateral goes to Rhea, and `on_supplied` ends
    /// it. If it refused it, nothing moves and the step may run again. Never panics.
    #[private]
    pub fn on_add_ready(&mut self, pid: String, i: u32, token: AccountId, amount: U128) -> PromiseOrValue<U128> {
        if succeeded() && self.config.lenders.rhea.is_some() {
            return PromiseOrValue::Promise(self.send_collateral(pid, i, token, amount.0));
        }
        self.reopen_step(&pid, i);
        log!("step {i} of plan {pid} didn't go out, as the pool refused it: nothing was sent, and it may run again");
        PromiseOrValue::Value(U128(0))
    }

    /// The end of a token send (a withdrawal, or a `sell` or `to_hl` step): returns whether the tokens went out. It
    /// bumps the counter, so a verdict read while they were on their way, which may still count them, backs nothing.
    /// If they didn't go out, it drops 1Click transfer `id`, if there is one. Never panics.
    #[private]
    pub fn on_sent(&mut self, id: Option<String>) -> bool {
        self.counter = self.counter.saturating_add(1);
        let sent = succeeded();
        if let (false, Some(id)) = (sent, id) {
            self.drop_transfer(&id);
        }
        sent
    }

    // ---------------------------------------------------------------------------------------------------------
    // After a DEFAULT (research/audit.md, A2)
    // ---------------------------------------------------------------------------------------------------------

    /// Lifts the block a confirmed DEFAULT put on this account, once the operator has reviewed it: the pool's
    /// `get_borrower` must say `blocked: false` and a debt of 0. Anyone may ask, with 50 TGas: it only reads the pool,
    /// whose answer decides. The answer arrives in `on_unblock`.
    pub fn lift_block(&mut self) -> Promise {
        require!(self.blocked, "this account is not blocked");
        let me = env::current_account_id();
        ext_pool::ext(self.config.pool_id.clone())
            .with_static_gas(GAS_FOR_GET_BORROWER)
            .get_borrower(me.clone())
            .then(Self::ext(me).with_static_gas(GAS_FOR_ON_UNBLOCK).on_unblock())
    }

    /// The pool's `get_borrower` answer for `lift_block`. If the pool has lifted its own block and the account owes it
    /// nothing, it lifts the block, closes the loan record (the pool's debt is the authority) and starts DEFAULT's
    /// record again. Otherwise it keeps the block and logs why. Returns whether it lifted the block. Never panics.
    #[private]
    pub fn on_unblock(&mut self) -> bool {
        if !self.blocked {
            log!("the account isn't blocked");
            return false;
        }
        let answer = match env::promise_result_checked(0, MAX_BORROWER_BYTES) {
            Ok(bytes) => serde_json::from_slice::<Option<PoolBorrower>>(&bytes)
                .map_err(|_| "the pool's answer is not a borrower".to_string()),
            Err(PromiseError::TooLong(len)) => {
                Err(format!("the pool's answer is {len} bytes, above {MAX_BORROWER_BYTES}"))
            }
            Err(_) => Err("the pool's get_borrower failed".to_string()),
        };
        let kept = match answer {
            Ok(Some(PoolBorrower { blocked: true, .. })) => Some("the pool still blocks it".to_string()),
            Ok(Some(PoolBorrower { debt, .. })) if debt.0 > 0 => Some(format!("it still owes the pool {}", debt.0)),
            Ok(Some(_)) => None,
            Ok(None) => Some("the pool doesn't know this account".to_string()),
            Err(why) => Some(why),
        };
        if let Some(why) = kept {
            log!("the block stays: {why}");
            return false;
        }
        self.blocked = false;
        self.loan = Loan::default();
        self.default_check = Deleverage::default();
        log!("block lifted: the pool has lifted its own, and the account owes it nothing");
        true
    }

    // ---------------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------------

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_state(&self) -> StateView {
        StateView {
            owner: self.owner.clone(),
            counter: self.counter,
            blocked: self.blocked,
            loan: self.loan.clone(),
            verdict: self.verdict.as_ref().map(|h| HeldView {
                intent: h.intent.clone(),
                received_block: h.received_block,
                received_at: U64(h.received_at),
                verdict: serde_json::from_slice(h.json.as_bytes()).unwrap_or(Value::Null),
            }),
            margin_call: self.margin_call.clone(),
            deleverage: DeleverageView { first_at: U64(self.deleverage.first_at) },
            default_check: DeleverageView { first_at: U64(self.default_check.first_at) },
            plan: self.plan.as_ref().map(Plan::view),
            hourly: self.hourly.clone(),
            pending: self.pending.clone(),
            next_move: self.next_move,
            hl: self.hl.clone(),
            permission: self.permission.clone(),
            permission_blk: self.permission_blk,
            funding: self.funding.as_ref().map(Funding::view),
            evm: self.evm.view(),
        }
    }
}

impl Account {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can do this");
    }

    fn borrowing(&self) -> bool {
        self.pending.iter().any(|p| matches!(p, Pending::Borrow { .. }))
    }

    /// Ends the borrow under way and bumps the counter again (research/audit.md, A1). Returns what the pool says the
    /// account took of `amount`, or `None` if its call failed.
    fn end_borrow(&mut self, amount: U128) -> Option<u128> {
        self.pending.retain(|p| !matches!(p, Pending::Borrow { .. }));
        self.counter = self.counter.saturating_add(1);
        let lent = result_u128();
        if lent != Some(amount.0) {
            log!("the pool refused the borrow of {}", amount.0);
        }
        lent
    }

    /// Reads a funding or lender step and checks it against the config and the permission (`funding.rs`). The error
    /// ends the sentence "step <i> …".
    fn checked_step(&self, json: &str) -> Result<FundStep, String> {
        let step = parse_fund_step(json)?;
        step.check(&self.config, self.permission.as_ref())?;
        Ok(step)
    }

    /// `execute_step` for the funding plan: the checks every funding step shares, then the step itself.
    fn execute_funding_step(&mut self, pid: String, i: u32) -> Promise {
        let funding = self.funding.as_ref().unwrap_or_else(|| env::panic_str("no funding plan is stored"));
        require!(funding.pid == pid, format!("plan {pid} is not the stored funding plan, {}", funding.pid));
        let index = i as usize;
        let step = funding.steps.get(index).unwrap_or_else(|| env::panic_str(&format!("plan {pid} has no step {i}")));
        require!(!step.done, format!("step {i} of plan {pid} has already run"));
        if let Some(earlier) = funding.steps[..index].iter().position(|s| !s.done) {
            env::panic_str(&format!("step {i} of plan {pid} must wait: step {earlier} hasn't run yet"));
        }
        if funding.expired(env::block_timestamp()) {
            let at = utc(funding.expires_at / 1_000_000);
            env::panic_str(&format!("plan {pid} expired at {at}: call fund again for a new one"));
        }
        self.assert_not_blocked();
        self.assert_none_overdue("funding step");
        self.assert_no_lender_wait("funding step");
        let run = self.checked_step(&step.json).unwrap_or_else(|why| env::panic_str(&format!("step {i} {why}")));
        match run {
            FundStep::PBorrow { amt } => self.borrow_for_step(pid, i, amt),
            FundStep::LSupply { l: AAVE, tok, amt } => {
                self.assert_can_post(true);
                let signed = self.supply_at_aave(&pid, i, &tok, amt);
                self.start_funding_step(&pid, i, "l_supply");
                signed
            }
            FundStep::LSupply { tok, amt, .. } => {
                self.assert_can_post(true);
                self.start_funding_step(&pid, i, "l_supply");
                self.post_collateral(pid, i, &tok, amt)
            }
            FundStep::LBorrow { l, amt } => self.lender_borrow_for_step(pid, i, l, amt),
            other => env::panic_str(&format!("step {i} {}", other.not_yet())),
        }
    }

    /// A `p_borrow` step: borrows the smaller of `amt` and the held verdict's allowance from the pool, as `borrow`
    /// does, and `on_step_borrowed` ends it.
    fn borrow_for_step(&mut self, pid: String, i: u32, amt: u128) -> Promise {
        require!(!self.borrowing(), "a borrow is already under way");
        self.assert_no_send_open("borrow");
        let v = &self.usable_verdict().verdict;
        require!(v.state == State::Healthy, "the verdict's state isn't HEALTHY");
        let amount = U128(amt.min(v.allow.borrow));
        require!(amount.0 > 0, "the verdict allows no borrowing now");
        let terms = BorrowVerdict::from(v);
        self.counter += 1;
        self.pending.push(Pending::Borrow { amount });
        self.start_funding_step(&pid, i, "p_borrow");
        let done =
            Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_CALLBACK).on_step_borrowed(pid, i, amount);
        ext_pool::ext(self.config.pool_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_POOL_BORROW)
            .borrow(amount, terms)
            .then(done)
    }

    /// An `l_borrow` step at the lender `l` the step names, Rhea or Aave: borrows the smaller of `amt` and the room
    /// the held verdict gives that lender (`ext[l].room`), in micro-USD. Like `p_borrow`, it needs a fresh HEALTHY
    /// verdict with the current counter, no borrow from our pool under way and no signed `sendAsset` still open; a
    /// room of 0 is refused.
    ///
    /// It bumps the counter and lists the borrow as under way at once, so nothing else that adds risk runs from here
    /// on. Then the pool settles the client's price up to now with the verdict's lender report (FUNDING.md 5.2), and
    /// only once it has does `on_step_settled` send Rhea the borrow, or have the signer sign Aave's. For Aave the
    /// transaction is built here, with the account's next Ethereum nonce, and the signer is kept for it meanwhile.
    ///
    /// The pool gets both ends of the period (research/audit.md, P4). `closes` is the verdict's lender lines as they
    /// are: the period up to now ends on the debts as they stood. `report` is the same lines with what this step
    /// borrows added at its lender: the next period starts there. With one figure for both ends, the pool charged or
    /// paid for debt that wasn't there before this borrow. A loan taken here and repaid before the next settlement
    /// still pays its margin, because the next period starts with it.
    fn lender_borrow_for_step(&mut self, pid: String, i: u32, l: &str, amt: u128) -> Promise {
        require!(!self.borrowing(), "a borrow is already under way");
        self.assert_no_send_open("borrow");
        let v = &self.usable_verdict().verdict;
        self.assert_read_since_permission(v.blk);
        require!(v.state == State::Healthy, "the verdict's state isn't HEALTHY");
        let line = v.ext.iter().find(|line| line.l == l);
        let room = line.map_or(0, |line| line.room);
        let amount = U128(amt.min(room));
        let name = if l == AAVE { "Aave" } else { "Rhea" };
        require!(amount.0 > 0, format!("the verdict leaves no room to borrow at {name} now"));
        // The owner's terms hold on chain too, whatever the engine planned (research/audit.md, A17): the lender's
        // rate now, and the cushion there once something is owed.
        if let (Some(line), Some(terms)) = (line, self.permission.as_ref()) {
            let (rate, max) = (line.r_bp, terms.max_rate_bp);
            require!(rate <= max, format!("{name}'s rate ({rate} bp) is above the {max} bp the permission allows"));
            let (cushion, min) = (line.hf_bp, u64::from(terms.min_hf_bp));
            require!(
                line.d == 0 || cushion >= min,
                format!("the cushion at {name} ({cushion} bp) is under the {min} bp the permission asks for")
            );
        }
        // The debts as the verdict shows them close the period up to now. The next starts with this borrow added.
        let closes = lender_report(&v.ext);
        let mut report = closes.clone();
        if let Some(line) = report.iter_mut().find(|line| line.lender == l) {
            line.debt = U128(line.debt.0.saturating_add(amount.0));
        }
        if l == AAVE {
            self.assert_room_for_listing();
            let (pool, usdc, me) = self.aave_addresses();
            let (data, step) = (borrow_data(&usdc, amount.0, &me), Some(format!("{pid}:{i}")));
            let nonce = self.start_evm(EvmKind::Borrow, usdc, amount.0, pool, data, step);
            self.counter += 1;
            self.list_aave_action(LenderKind::Borrow, amount, &usdc, nonce);
        } else {
            self.counter += 1;
            self.list_lender_action(l.to_string(), LenderKind::Borrow, amount, None);
        }
        self.start_funding_step(&pid, i, "l_borrow");
        let settled = Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_ON_STEP_SETTLED).on_step_settled(
            pid,
            i,
            l.to_string(),
            amount,
        );
        ext_pool_at_borrow::ext(self.config.pool_id.clone())
            .with_static_gas(GAS_FOR_SETTLE)
            .settle(report, closes)
            .then(settled)
    }

    /// `execute_step` for a top-up plan's lender steps, at Rhea or at Aave (FUNDING.md 6.5). They run whatever the
    /// permission says, because they only keep the lender from selling.
    /// - `l_repay`: repays the lender. At Rhea, the smaller of `amt` and the account's USDC on NEAR. At Aave, `amt`
    ///   from the USDC at the account's Ethereum address, which the account can't read: the engine sizes the step
    ///   from it. Like `repay`, it needs no check and leaves the counter alone, so it always runs, even on a blocked
    ///   account. With a fresh verdict held, the pool settles the client's price first. On a verdict read at or
    ///   before the block the permission last changed (`permission_blk`) it still repays, and only that settlement
    ///   is skipped.
    /// - At Rhea both ask the pool's `check_step` first, for the NEAR token and the amount they send, as a transfer
    ///   step does: a paused pool, or a day's total past the pool's limit for plan steps, refuses it, nothing moves
    ///   and the step may run again (research/audit.md, A17). At Aave they spend what is already at the account's
    ///   address there, and ask nothing.
    /// - `l_add`: posts `amt` of spare collateral at the lender. Never on a blocked account, and only while the held
    ///   verdict is the one the plan came from (its `blk` is the plan's id) or the newest one that ordered the same
    ///   steps while the plan was kept, so a top-up that a later check no longer orders doesn't run. It bumps the
    ///   counter, and while the account owes our pool that verdict must also be fresh and carry the current
    ///   counter, in any state. It refuses a verdict read at or before `permission_blk`: the next check orders the
    ///   top-up again.
    fn execute_top_up_step(&mut self, pid: String, i: u32, json: &str) -> Promise {
        let run = self.checked_step(json).unwrap_or_else(|why| env::panic_str(&format!("step {i} {why}")));
        match run {
            FundStep::LRepay { l: AAVE, amt } => {
                let signed = self.repay_at_aave(amt, false, Some(format!("{pid}:{i}")));
                self.start_step(i);
                self.settle_since_permission();
                signed
            }
            FundStep::LRepay { .. } => {
                self.start_step(i);
                self.settle_since_permission();
                let me = env::current_account_id();
                let ready = Self::ext(me.clone()).with_static_gas(GAS_FOR_ON_REPAY_READY).on_repay_ready(pid, i);
                ext_ft::ext(self.config.usdc_token.clone())
                    .with_static_gas(GAS_FOR_BALANCE)
                    .ft_balance_of(me)
                    .then(ready)
            }
            FundStep::LAdd { l, tok, amt } => {
                self.assert_not_blocked();
                // Only a reading that ordered the top-up backs it: a later check may no longer want it. That is the
                // check the plan came from, or the newest one that ordered the same steps while the plan was kept.
                let held = self.verdict.as_ref().map_or(0, |held| held.verdict.blk);
                let confirmed = self.plan.as_ref().map(|plan| plan.confirmed);
                require!(
                    held.to_string() == pid || Some(held) == confirmed,
                    format!(
                        "step {i} of plan {pid} can't run: the latest check, read at block {held}, is not the one \
                         that ordered it"
                    )
                );
                self.assert_read_since_permission(held);
                self.assert_can_post(false);
                if l == AAVE {
                    let signed = self.supply_at_aave(&pid, i, &tok, amt);
                    self.start_step(i);
                    signed
                } else {
                    // The collateral leaves for the lender, so the pool's pause and its day's limit for plan steps
                    // hold for it as for a transfer step (research/audit.md, A17). Like one, it bumps the counter
                    // as it starts.
                    let token: AccountId =
                        tok.parse().unwrap_or_else(|_| env::panic_str("the step's token is not valid"));
                    self.start_step(i);
                    self.counter += 1;
                    let me = env::current_account_id();
                    let ready = Self::ext(me).with_static_gas(GAS_FOR_ON_ADD_READY).on_add_ready(
                        pid.clone(),
                        i,
                        token.clone(),
                        U128(amt),
                    );
                    ext_pool::ext(self.config.pool_id.clone())
                        .with_static_gas(GAS_FOR_CHECK_STEP)
                        .check_step(pid, i, token, U128(amt))
                        .then(ready)
                }
            }
            other => env::panic_str(&format!("step {i} {}", other.not_yet())),
        }
    }

    /// Signs `supply` of `amt` of `tok` on Aave's Pool, for step `i` of plan `pid` (an `l_supply` or an `l_add`):
    /// the token goes from the account's Ethereum address into its own collateral there. Like Rhea's posting, it
    /// bumps the counter, and `on_evm_signed` bumps it again. The step has been checked: `tok` is one of the
    /// config's collateral tokens for Aave.
    fn supply_at_aave(&mut self, pid: &str, i: u32, tok: &str, amt: u128) -> Promise {
        let asset = self.aave_token(tok, false);
        let (pool, _, me) = self.aave_addresses();
        let (data, step) = (supply_data(&asset, amt, &me), Some(format!("{pid}:{i}")));
        self.start_evm(EvmKind::Supply, asset, amt, pool, data, step);
        self.counter += 1;
        self.sign_evm()
    }

    /// Signs `repay` of `amount` micro-USD on Aave's Pool, from the USDC at the account's Ethereum address. With
    /// `whole`, the call says "all of it": Aave then takes the debt as it stands when the transaction runs, so no
    /// dust is left. `step` is `<pid>:<i>` for a top-up plan's `l_repay`.
    fn repay_at_aave(&mut self, amount: u128, whole: bool, step: Option<String>) -> Promise {
        let (pool, usdc, me) = self.aave_addresses();
        let data = repay_data(&usdc, (!whole).then_some(amount), &me);
        self.start_evm(EvmKind::Repay, usdc, amount, pool, data, step);
        self.sign_evm()
    }

    /// The account's Aave settings.
    fn aave(&self) -> &AaveLender {
        let aave = self.config.lenders.aave.as_ref();
        aave.unwrap_or_else(|| env::panic_str("this account has no settings for aave"))
    }

    /// Aave's Pool, its USDC and the account's own Ethereum address, which is its Hyperliquid address: the same key
    /// and path.
    fn aave_addresses(&self) -> (Address, Address, Address) {
        let aave = self.aave();
        let me = self.hl.address.as_deref().and_then(parse_evm_address);
        let me = me.unwrap_or_else(|| env::panic_str("no Ethereum address yet: call hl_init first"));
        // A valid config's addresses are 0x and 40 hex digits.
        let of = |address: &str| parse_evm_address(address).unwrap_or_default();
        (of(&aave.pool), of(&aave.usdc.address), me)
    }

    /// One of the Aave settings' tokens, named by its address in any case: a collateral token, or with `usdc` their
    /// USDC as well.
    fn aave_token(&self, token: &str, usdc: bool) -> Address {
        let aave = self.aave();
        let is = |listed: &pb_types::EvmToken| listed.address.eq_ignore_ascii_case(token);
        let listed = aave.collateral.iter().any(is) || (usdc && is(&aave.usdc));
        let address = parse_evm_address(token).filter(|_| listed);
        address.unwrap_or_else(|| {
            let which =
                if usdc { "USDC or one of aave's collateral tokens" } else { "one of aave's collateral tokens" };
            env::panic_str(&format!("{token} is not {which}"))
        })
    }

    /// One Ethereum transaction is signed at a time, so each takes its own nonce. A signature asked for more than
    /// 250 blocks ago has failed without its answer reaching the account, and no longer holds up the next.
    fn assert_evm_free(&self) {
        let height = env::block_height();
        if let Some(signing) = self.evm.signing.as_ref().filter(|signing| height <= signing.until_block) {
            let nonce = signing.tx.nonce;
            env::panic_str(&format!("Ethereum transaction {nonce} is being signed: wait for the signer's answer"));
        }
    }

    /// Builds the account's next Ethereum transaction and keeps the signer for it: `data` sent to `to`, with the
    /// account's next nonce, the gas limit of its `kind`, half the config's `max_fee_per_gas`, and a tip of
    /// 1,000,000 wei or that fee if it is lower. Half, because a node takes a replacement only at fees a tenth
    /// higher: a first try at the limit could never be bumped. Returns the nonce. `sign_evm` then asks the signer.
    fn start_evm(
        &mut self,
        kind: EvmKind,
        token: Address,
        amount: u128,
        to: Address,
        data: Vec<u8>,
        step: Option<String>,
    ) -> u64 {
        self.assert_evm_free();
        let aave = self.aave();
        let (chain_id, max_fee, nonce) = (aave.chain_id, (aave.max_fee_per_gas.0 / 2).max(1), self.evm.nonce);
        let tx = EvmTx { chain_id, nonce, tip: TIP_WEI.min(max_fee), max_fee, gas_limit: kind.gas_limit(), to, data };
        let until_block = env::block_height().saturating_add(SIGNING_BLOCKS);
        let transfer = None;
        self.evm.signing = Some(EvmSigning { tx, kind, token, amount, step, transfer, bump: false, until_block });
        nonce
    }

    /// Asks the MPC signer to sign the Ethereum transaction under way with the account's key, as `sign_hl` does for
    /// a Hyperliquid action: the same path, and 1 yoctoNEAR from the account's balance. `on_evm_signed` gets the
    /// answer, with the hash it was asked to sign: an answer that comes after the account has moved on to another
    /// transaction is then never taken for that one's.
    fn sign_evm(&self) -> Promise {
        let digest = self.evm.signing.as_ref().map(|signing| signing.tx.signing_hash()).unwrap_or_default();
        let digest = hex(&digest);
        let request = SignRequest { path: HL_PATH, payload_v2: Payload { ecdsa: digest.clone() }, domain_id: 0 };
        Promise::new(self.config.mpc_id.clone())
            .function_call("sign", to_bytes(&SignArgs { request }), ONE_YOCTO, GAS_FOR_SIGN)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_ON_EVM_SIGNED).on_evm_signed(digest))
    }

    /// An Ethereum transaction the account keeps no signature for, because of `why`: its nonce stays free, a plan
    /// step may run again, and the 1Click transfer it was to start (an `e_home` move) is dropped. Its listing as a
    /// borrow, a withdrawal or a transfer under way is dropped, which moves the counter on. But not if the signer
    /// `answered`: a signature may then exist although the account couldn't read it, so the listing stays until a
    /// verdict shows the chain has used the nonce.
    fn undo_evm(&mut self, signing: EvmSigning, why: &str, answered: bool) {
        let nonce = signing.tx.nonce;
        log!("no Ethereum transaction signed, as {why}");
        if signing.bump {
            return;
        }
        // The move home that this transfer was to start never left the address.
        if let Some(id) = &signing.transfer {
            self.drop_transfer(id);
        }
        // Its own listing is the newest with this nonce: an older one is of a transaction that may be signed.
        let is_listed = matches!(signing.kind, EvmKind::Borrow | EvmKind::Withdraw | EvmKind::Transfer);
        let own = |p: &Pending| matches!(p, Pending::Lender(action) if action.evm_nonce == Some(nonce));
        match self.pending.iter().rposition(own).filter(|_| is_listed) {
            Some(_) if answered => {
                log!("the signer did answer, so transaction {nonce} still counts until a check shows its nonce used");
            }
            Some(at) => {
                self.pending.remove(at);
                self.counter = self.counter.saturating_add(1);
            }
            None => {}
        }
        if let Some((pid, i)) = signing.step.as_deref().and_then(|step| step.rsplit_once(':')) {
            self.reopen_step(pid, i.parse().unwrap_or(u32::MAX));
            log!("step {i} of plan {pid} didn't go out: nothing was signed, and it may run again");
        }
    }

    /// A ninth borrow, withdrawal or transfer on Aave's chain waits until a check drops one of the eight listed
    /// (research/audit.md, A14): with no loan from our pool nothing else bounded them.
    fn assert_room_for_listing(&self) {
        let listed = self.lender_actions().filter(|action| action.evm_nonce.is_some()).count();
        require!(
            listed < MAX_AAVE_LISTINGS,
            format!("{MAX_AAVE_LISTINGS} Ethereum transactions are listed already: send them, then ask for a check")
        );
    }

    /// Lists a signed borrow, withdrawal or transfer on Aave's chain as under way, with the nonce of its
    /// transaction, until a verdict shows that the chain has used that nonce.
    fn list_aave_action(&mut self, kind: LenderKind, amount: U128, token: &Address, nonce: u64) {
        log!("{} of {} at aave under way: Ethereum transaction {nonce}", kind.word(), amount.0);
        let (lender, token) = (AAVE.to_string(), Some(address_text(token)));
        let action = LenderAction { lender, kind, amount, token, until_block: None, evm_nonce: Some(nonce) };
        self.pending.push(Pending::Lender(action));
    }

    /// What a repayment at Aave from anyone but the owner needs (research/audit.md, A9). Each one holds the one
    /// signing slot and takes an Ethereum nonce, so a stranger sending dust could keep the keeper's own top-up
    /// waiting.
    /// - `amount` is at least `owed`, the debt the held verdict shows: the call then says "all of it".
    /// - No kept signed repayment has a nonce the held verdict hasn't seen used: its `evm.nonce` is at or below that
    ///   nonce, or it has no `evm`.
    fn assert_stranger_may_repay_aave(&self, amount: u128, owed: u128) {
        require!(amount >= owed, format!("anyone but the owner repays all of Aave's debt ({owed}) or nothing"));
        let seen = self.verdict.as_ref().and_then(|held| held.verdict.evm.as_ref()).map_or(0, |evm| evm.nonce);
        let waits = |kept: &&EvmSigned| kept.kind == EvmKind::Repay && kept.tx.nonce >= seen;
        if let Some(kept) = self.evm.signed.iter().find(waits) {
            env::panic_str(&format!(
                "a repayment at Aave is signed and not mined yet (nonce {}): send it, then ask for a check",
                kept.tx.nonce
            ));
        }
    }

    /// The lender a direct call names, which the account's config must have.
    fn named_lender(&self, lender: &str) -> &'static str {
        let (name, has) = match lender {
            RHEA => (RHEA, self.config.lenders.rhea.is_some()),
            AAVE => (AAVE, self.config.lenders.aave.is_some()),
            _ => env::panic_str(r#"lender must be "rhea" or "aave""#),
        };
        require!(has, format!("this account has no settings for {name}"));
        name
    }

    /// What taking collateral back from a lender needs (`lender_withdraw`): the owner, an account that isn't blocked
    /// and has no borrow from our pool under way, and while the account owes our pool, a fresh HEALTHY verdict that
    /// answers exactly this withdrawal and allows it.
    fn assert_may_take_collateral(&self, lender: &str, token: String, amount: U128) {
        self.assert_owner();
        self.assert_not_blocked();
        require!(!self.borrowing(), "a borrow is under way: wait for it to finish");
        if !self.loan.open {
            return self.assert_no_timed_wait("lender withdrawal");
        }
        self.assert_no_lender_wait("lender withdrawal");
        self.assert_no_send_open("lender withdrawal with a loan open");
        self.assert_none_overdue("lender withdrawal with a loan open");
        let held = self.usable_verdict();
        // An Aave token is an address, which is the same token in any case.
        let asked = matches!(&held.intent, Intent::LenderWithdraw { lender: l, token: t, amount: a }
            if l == lender && t.eq_ignore_ascii_case(&token) && *a == amount);
        require!(asked, "with a loan open, taking collateral back needs a verdict for this lender, token and amount");
        let v = &held.verdict;
        require!(v.state == State::Healthy, "the verdict's state isn't HEALTHY");
        require!(v.allow.withdraw >= amount.0, "the verdict doesn't allow this withdrawal");
    }

    /// Posting collateral at a lender puts it where our pool's unwind can't reach it. So it never starts while a
    /// borrow from our pool is under way, and while the account owes our pool it needs a fresh verdict with the
    /// current counter (INTERFACES.md 24, point 8): otherwise a client could borrow or withdraw on a verdict that
    /// counts that bitcoin as free, then lock it at the lender. For a new loan (`l_supply`) that verdict must also
    /// show the account HEALTHY, with no signed `sendAsset` still open. A top-up (`l_add`) runs in any state.
    fn assert_can_post(&self, new_loan: bool) {
        require!(!self.borrowing(), "a borrow is under way: wait for it to finish");
        if !self.loan.open {
            return;
        }
        if new_loan {
            self.assert_no_send_open("collateral posting");
        }
        let v = &self.usable_verdict().verdict;
        self.assert_read_since_permission(v.blk);
        require!(!new_loan || v.state == State::Healthy, "the verdict's state isn't HEALTHY");
    }

    /// A check read at or before the block the permission last changed was made under another permission. `fund`,
    /// `l_borrow`, `l_add`, and `l_supply` where it reads a check refuse it (research/audit.md, A8). A top-up's
    /// `l_repay` doesn't: it only skips its settlement (`settle_since_permission`). `blk` is the held verdict's.
    fn assert_read_since_permission(&self, blk: u64) {
        require!(
            blk > self.permission_blk,
            format!(
                "the check was read before the permission last changed (block {}): ask for a new check",
                self.permission_blk
            )
        );
    }

    /// The settlement beside a top-up's repayment, as `settle_if_fresh`, but never on a check read at or before the
    /// block the permission last changed: that check backs nothing at a lender (research/audit.md, A8). The
    /// repayment itself goes out either way: repaying never stops.
    fn settle_since_permission(&self) {
        if self.verdict.as_ref().is_some_and(|held| held.verdict.blk > self.permission_blk) {
            self.settle_if_fresh();
        }
    }

    /// Sends `amt` of `tok` to Rhea as collateral for step `i` of plan `pid`, paying Rhea's registration first until
    /// Rhea has taken collateral once. Like a withdrawal, it bumps the counter, and `on_supplied` bumps it again once
    /// the tokens have gone. The step has been checked: `tok` is one of the config's collateral tokens for Rhea.
    fn post_collateral(&mut self, pid: String, i: u32, tok: &str, amt: u128) -> Promise {
        let token: AccountId = tok.parse().unwrap_or_else(|_| env::panic_str("the step's token is not valid"));
        self.counter += 1;
        self.send_collateral(pid, i, token, amt)
    }

    /// The sending part of `post_collateral`, which leaves the counter alone: Rhea's registration first until Rhea
    /// has taken collateral once, the tokens, then `on_supplied`. The account's config has Rhea.
    fn send_collateral(&self, pid: String, i: u32, token: AccountId, amt: u128) -> Promise {
        let rhea = self.rhea_for(RHEA).contract_id.clone();
        let me = env::current_account_id();
        let send = ext_ft::ext(token)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_RHEA_FT)
            .ft_transfer_call(rhea.clone(), U128(amt), None, SUPPLY_MSG.to_string());
        let supplied = Self::ext(me.clone()).with_static_gas(GAS_FOR_CALLBACK).on_supplied(pid, i, U128(amt));
        if self.rhea_registered {
            return send.then(supplied);
        }
        let register = StorageDeposit { account_id: &me, registration_only: true };
        Promise::new(rhea)
            .function_call("storage_deposit", to_bytes(&register), RHEA_STORAGE_DEPOSIT, GAS_FOR_RHEA_REGISTER)
            .then(send)
            .then(supplied)
    }

    /// Repays Rhea `amount` micro-USD of the account's USDC, and `on_lender_repaid` logs what Rhea used.
    fn repay_rhea(&self, rhea: AccountId, amount: U128) -> Promise {
        ext_ft::ext(self.config.usdc_token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_RHEA_FT)
            .ft_transfer_call(rhea, amount, None, LENDER_REPAY_MSG.to_string())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_CALLBACK).on_lender_repaid(amount))
    }

    /// The account's Rhea settings. `_lender` is always Rhea: a call that names a lender goes through
    /// `named_lender` first.
    fn rhea_for(&self, _lender: &str) -> &RheaLender {
        let rhea = self.config.lenders.rhea.as_ref();
        rhea.unwrap_or_else(|| env::panic_str("this account has no settings for rhea"))
    }

    /// The lender actions under way.
    fn lender_actions(&self) -> impl Iterator<Item = &LenderAction> {
        self.pending.iter().filter_map(|p| match p {
            Pending::Lender(action) => Some(action),
            _ => None,
        })
    }

    /// Lists a borrow or a withdrawal sent to Rhea as under way for the next 20 blocks. `token` is the collateral
    /// token a withdrawal takes; a borrow has none.
    fn list_lender_action(&mut self, lender: String, kind: LenderKind, amount: U128, token: Option<String>) {
        let until = env::block_height().saturating_add(LENDER_WAIT_BLOCKS);
        log!("{} of {} at {lender} under way until block {until}", kind.word(), amount.0);
        let action = LenderAction { lender, kind, amount, token, until_block: Some(until), evm_nonce: None };
        self.pending.push(Pending::Lender(action));
    }

    /// Drops the lender actions under way that `which` picks. If there were any it bumps the counter, so no verdict
    /// read while they were listed backs anything. Returns whether there were.
    fn drop_lender_actions(&mut self, which: impl Fn(&LenderAction) -> bool) -> bool {
        let before = self.pending.len();
        self.pending.retain(|p| !matches!(p, Pending::Lender(action) if which(action)));
        let dropped = self.pending.len() < before;
        if dropped {
            self.counter = self.counter.saturating_add(1);
        }
        dropped
    }

    /// Ends the wait after a lender action at Rhea: once its last block has passed, drops it and bumps the counter.
    /// A verdict read while it was listed may not show what the lender did, so it backs nothing (FUNDING.md 4.4).
    /// `on_verdict` and every call that reads a verdict or the counter start with this, so the first of them after
    /// that block does it. An action at Aave has no last block: a verdict ends its wait (`accept`).
    fn end_lender_wait(&mut self) {
        let height = env::block_height();
        if self.drop_lender_actions(|action| !action.waiting(height)) {
            log!("the lender action's 20 blocks are over: the counter moves on");
        }
    }

    /// While a lender action is under way, refuses `what`, an action that adds risk: the lender may not show the
    /// action yet, so a verdict may not either. Repaying and top-ups never call this.
    fn assert_no_lender_wait(&self, what: &str) {
        let height = env::block_height();
        let Some(action) = self.lender_actions().find(|action| action.waiting(height)) else { return };
        let (kind, lender) = (action.kind.word(), &action.lender);
        let until = match (action.until_block, action.evm_nonce) {
            (Some(block), _) => format!("block {block} has passed"),
            (None, nonce) => format!("a check shows Ethereum transaction {} mined", nonce.unwrap_or_default()),
        };
        env::panic_str(&format!("no {what} until {until}: a {kind} at {lender} is still under way"));
    }

    /// As `assert_no_lender_wait`, for Rhea's 20 blocks only. An account that owes our pool nothing may take its
    /// collateral back while an Aave transaction still waits for a verdict: it must never need one to leave.
    fn assert_no_timed_wait(&self, what: &str) {
        let height = env::block_height();
        let timed = |action: &&LenderAction| action.until_block.is_some() && action.waiting(height);
        if let Some(action) = self.lender_actions().find(timed) {
            let (kind, lender, until) = (action.kind.word(), &action.lender, action.until_block.unwrap_or_default());
            env::panic_str(&format!(
                "no {what} until block {until} has passed: a {kind} at {lender} is still under way"
            ));
        }
    }

    /// Marks step `i` of the funding plan as started, and logs `step_run`.
    fn start_funding_step(&mut self, pid: &str, i: u32, k: &str) {
        if let Some(step) = self.funding.as_mut().and_then(|f| f.steps.get_mut(i as usize)) {
            step.done = true;
            Event::StepRun { pid, i, k }.emit();
        }
    }

    /// Lets step `i` of plan `pid` run again, if that plan is still the stored one: the funding plan for an `f` id,
    /// else the top-up plan.
    fn reopen_step(&mut self, pid: &str, i: u32) {
        let step = if pid.starts_with('f') {
            self.funding.as_mut().filter(|f| f.pid == pid).and_then(|f| f.steps.get_mut(i as usize))
        } else {
            self.plan.as_mut().filter(|p| p.pid.to_string() == pid).and_then(|p| p.steps.get_mut(i as usize))
        };
        if let Some(step) = step {
            step.done = false;
        }
    }

    /// The held verdict's lender report, if the verdict is fresh and carries the current counter.
    fn fresh_report(&self) -> Option<Vec<LenderReport>> {
        let v = &self.verdict.as_ref()?.verdict;
        let fresh = v.nonce == self.counter && env::block_height().saturating_sub(v.blk) <= FRESH_BLOCKS;
        fresh.then(|| lender_report(&v.ext))
    }

    /// A settlement at a lender repayment (INTERFACES.md 24, point 5): runs only when the account holds a fresh
    /// verdict, and beside the repayment, which never waits for it.
    fn settle_if_fresh(&self) {
        if let Some(report) = self.fresh_report() {
            self.settle_pool(report).detach();
        }
    }

    /// Calls the pool's `settle` with `report`, and `on_settled` books its answer.
    fn settle_pool(&self, report: Vec<LenderReport>) -> Promise {
        ext_pool::ext(self.config.pool_id.clone())
            .with_static_gas(GAS_FOR_SETTLE)
            .settle(report)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_ON_SETTLED).on_settled())
    }

    /// Reads the pool's `settle` answer in its callback and books it on the loan record (`Loan::book_settlement`).
    /// Returns whether the pool's call succeeded; an answer that says it skipped the settlement counts.
    fn book_settlement(&mut self) -> bool {
        self.read_settlement().0
    }

    /// As `book_settlement`, and also returns whether the pool skipped the settlement because it is paused.
    fn read_settlement(&mut self) -> (bool, bool) {
        let answer = match env::promise_result_checked(0, MAX_SETTLED_BYTES) {
            Ok(bytes) => serde_json::from_slice::<Settled>(&bytes).ok(),
            Err(PromiseError::TooLong(_)) => None,
            Err(_) => {
                log!("the pool's settlement failed");
                return (false, false);
            }
        };
        let mut paused = false;
        match answer {
            Some(Settled { skipped: Some(why), .. }) => {
                paused = why.starts_with(POOL_PAUSED);
                log!("the pool settled nothing: {why}");
            }
            Some(Settled { fee, subsidy, .. }) => {
                let (fee, subsidy) = (fee.map_or(0, |f| f.0), subsidy.map_or(0, |s| s.0));
                self.loan.book_settlement(fee, subsidy);
                if fee > 0 {
                    self.loan_seq = self.loan_seq.saturating_add(1);
                }
                log!("the pool settled: a fee of {fee} and a subsidy of {subsidy}");
            }
            None => log!("the pool settled, but its answer couldn't be read: the loan record is unchanged"),
        }
        (true, paused)
    }

    fn assert_not_blocked(&self) {
        require!(!self.blocked, "this account is blocked after a default");
    }

    /// The 1Click transfers under way.
    fn transfers(&self) -> impl Iterator<Item = &Transfer> {
        self.pending.iter().filter_map(|p| match p {
            Pending::Transfer(t) => Some(t),
            Pending::Borrow { .. } | Pending::Lender(_) => None,
        })
    }

    fn assert_room_for_transfer(&self) {
        require!(
            self.transfers().count() < MAX_TRANSFERS,
            format!("{MAX_TRANSFERS} transfers are under way already: wait for one to settle")
        );
    }

    /// While a transfer is past its deadline, refuses `what`, an action that adds risk.
    fn assert_none_overdue(&self, what: &str) {
        let now = env::block_timestamp();
        if let Some(t) = self.transfers().find(|t| t.overdue(now)) {
            let deadline = utc(t.deadline.0 / 1_000_000);
            env::panic_str(&format!("no {what} while transfer {} is overdue: its deadline was {deadline}", t.id));
        }
    }

    /// The owner's next move, `move:<n>`, for a quote that expires at `exp` (unix ms): in the future, and at most 24
    /// hours ahead, so that no record stands for money "on its way" longer than a quote can live (research/audit.md,
    /// A7).
    fn new_move(&mut self, kind: TransferKind, token: &str, amount: u128, dep: &str, exp: u64) -> Transfer {
        let now = env::block_timestamp_ms();
        require!(exp > now, "exp must be the quote's expiry, in the future, in unix ms");
        require!(
            exp.saturating_sub(now) <= MAX_QUOTE_LIFE_MS,
            "exp is more than 24 hours ahead: a 1Click quote lives a day at most"
        );
        self.assert_room_for_transfer();
        let id = format!("move:{}", self.next_move);
        self.next_move += 1;
        Transfer::new(id, kind, token, amount, dep, exp)
    }

    /// What a move's quote says will arrive on NEAR, checked: a listed token and an amount above 0.
    fn checked_expect(&self, expect: Option<Expect>) -> Option<Expect> {
        if let Some(expect) = &expect {
            require!(self.config.token(&expect.token).is_some(), "expect names a token that isn't allow-listed");
            require!(expect.amount.0 > 0, "expect's amount must be positive");
        }
        expect
    }

    /// Records a transfer as it goes out, and returns its id.
    fn record_transfer(&mut self, transfer: Transfer) -> String {
        log!("transfer {} under way: {} {} to {}", transfer.id, transfer.amount.0, transfer.token, transfer.dep);
        let id = transfer.id.clone();
        self.pending.push(Pending::Transfer(transfer));
        id
    }

    /// Drops a transfer that didn't go out.
    fn drop_transfer(&mut self, id: &str) {
        self.pending.retain(|p| !matches!(p, Pending::Transfer(t) if t.id == id));
        log!("transfer {id} didn't go out: nothing was sent");
    }

    /// Settles the transfer under way with this id, if there is one: removes it and logs `transfer_done`, saying
    /// `how`. Returns whether there was one.
    fn settle_transfer(&mut self, id: &str, how: impl Fn(&Transfer) -> &'static str) -> bool {
        let Some(i) = self.pending.iter().position(|p| matches!(p, Pending::Transfer(t) if t.id == id)) else {
            return false;
        };
        if let Pending::Transfer(t) = self.pending.remove(i) {
            Event::TransferDone { id, how: how(&t) }.emit();
        }
        true
    }

    /// Whether anyone, not only the owner, may repay: the held verdict says DELEVERAGE, or it says MARGIN_CALL or
    /// worse and arrived more than 30 minutes ago.
    fn anyone_may_repay(&self) -> bool {
        let Some(held) = &self.verdict else { return false };
        let v = &held.verdict;
        let bad = matches!(v.state, State::MarginCall | State::Deleverage | State::Default);
        v.action == Action::Deleverage || (bad && env::block_timestamp().saturating_sub(held.received_at) > OUTAGE_NS)
    }

    /// Repaying is the owner's, and anyone's once `anyone_may_repay` says so.
    fn assert_may_repay(&self) {
        require!(
            env::predecessor_account_id() == self.owner || self.anyone_may_repay(),
            "only the owner can repay, unless the verdict says DELEVERAGE, or MARGIN_CALL or worse and is over 30 minutes old"
        );
    }

    fn repay_pool(&self, amount: U128) -> Promise {
        ext_ft::ext(self.config.usdc_token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_REPAY)
            .ft_transfer_call(self.config.pool_id.clone(), amount, None, REPAY_MSG.to_string())
            .then(
                Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_CALLBACK).on_repaid(amount, self.loan_seq),
            )
    }

    /// Marks step `i` of the stored plan as started, and logs `step_run`.
    fn start_step(&mut self, i: u32) {
        let Some(plan) = self.plan.as_mut() else { return };
        if let Some(step) = plan.steps.get_mut(i as usize) {
            step.done = true;
            Event::StepRun { pid: &plan.pid.to_string(), i, k: &kind_of(&step.json) }.emit();
        }
    }

    /// Stores the verdict's plan, unless the plan held came from a verdict of the same block. So each plan has its own
    /// `pid`, and a step's transfer id, `<pid>:<i>`, is never reused.
    ///
    /// The stored plan is also kept, and the verdict's dropped, when the stored one has a step that hasn't run, the
    /// verdict was read fewer than 100 blocks after the stored plan's own, and its plan has the same action and the
    /// same steps in the same order by kind, lender and token. The stored plan then remembers that verdict's block
    /// as the newest that ordered it.
    fn store_plan(&mut self, v: &Verdict, now: u64) {
        if let Some(held) = self.plan.as_ref().filter(|p| p.pid >= v.blk) {
            log!("plan {} kept: a plan read at block {} can't replace it", held.pid, v.blk);
            return;
        }
        // A plan that still has a step to run isn't replaced by a newer check that orders the same thing, for 100
        // blocks: otherwise checks that keep arriving, anyone's, would hold back a top-up or an unwind the keeper is
        // about to run (research/audit.md, A15). A more severe action, or another shape, replaces it at once.
        if let Some(stored) = self.plan.as_mut() {
            let in_time = v.blk < stored.pid.saturating_add(KEEP_PLAN_BLOCKS);
            if stored.unfinished() && in_time && stored.action == v.action && stored.same_shape(&v.plan) {
                stored.confirmed = v.blk;
                log!("plan {} kept: the check read at block {} orders the same steps", stored.pid, v.blk);
                return;
            }
        }
        let plan = Plan::new(v.blk, v.action, now, &v.plan);
        Event::PlanStored { pid: plan.pid.to_string(), action: plan.action, steps: plan.kinds() }.emit();
        self.plan = Some(plan);
    }

    /// Has the MPC signer sign a `sendAsset` of `amount` micro-USDC to `destination` from `source_dex`, and opens the
    /// send window. `transfer` is the id of the 1Click transfer it makes, if any. A valid config's chain id is always
    /// hex, so the digest can't fail.
    fn sign_send(&mut self, amount: u128, destination: &str, source_dex: &str, transfer: Option<String>) -> Promise {
        let now = env::block_timestamp_ms();
        let nonce = self.hl.take_nonce(now);
        self.hl.note_send(nonce, now);
        let amount = usdc_decimal(amount);
        let action = SendAsset {
            kind: SendAsset::KIND,
            hyperliquid_chain: &self.config.hl_chain,
            signature_chain_id: &self.config.signature_chain_id,
            destination,
            source_dex,
            destination_dex: "",
            token: &self.config.hl_usdc_token,
            amount: &amount,
            from_sub_account: "",
            nonce,
        };
        let digest = action.digest().unwrap_or_default();
        self.sign_hl(ActionKind::SendAsset, to_string(&action), nonce, &digest, transfer)
    }

    /// While a signed `sendAsset` could still be posted, refuses `what`, an action that needs a verdict. Repaying and
    /// deleveraging never call this: they only lower risk.
    fn assert_no_send_open(&self, what: &str) {
        let until = self.hl.send_open_until_ms.0;
        if env::block_timestamp_ms() < until {
            env::panic_str(&format!(
                "no {what} until {} ({until} ms): a signed Hyperliquid sendAsset can still be posted until then",
                utc(until)
            ));
        }
    }

    /// Asks OutLayer to run the project's pinned version on `input`, with `pb-risk`'s limits and a JSON answer.
    /// `secrets_ref` goes as it is. OutLayer refunds the unused part of `deposit` to the caller.
    fn run(
        &self,
        project_id: &str,
        version_key: &str,
        secrets_ref: Option<&SecretsRef>,
        input: &impl Serialize,
        deposit: NearToken,
    ) -> Promise {
        let args = RequestExecution {
            source: Source { project: ProjectSource { project_id, version_key } },
            resource_limits: Limits {
                max_instructions: MAX_INSTRUCTIONS,
                max_memory_mb: MAX_MEMORY_MB,
                max_execution_seconds: MAX_EXECUTION_SECONDS,
            },
            input_data: to_string(input),
            secrets_ref,
            response_format: "Json",
            payer_account_id: env::predecessor_account_id(),
        };
        Promise::new(self.config.outlayer_id.clone()).function_call(
            "request_execution",
            to_bytes(&args),
            deposit,
            GAS_FOR_OUTLAYER,
        )
    }

    /// Asks the MPC signer to sign `digest` with the master key, paying its 1 yoctoNEAR from the account's balance.
    /// `on_hl_signed` gets the answer, with the action, its nonce and the id of its 1Click transfer, if any.
    fn sign_hl(
        &self,
        kind: ActionKind,
        action: String,
        nonce: u64,
        digest: &[u8; 32],
        transfer: Option<String>,
    ) -> Promise {
        let request = SignRequest { path: HL_PATH, payload_v2: Payload { ecdsa: hex(digest) }, domain_id: 0 };
        Promise::new(self.config.mpc_id.clone())
            .function_call("sign", to_bytes(&SignArgs { request }), ONE_YOCTO, GAS_FOR_SIGN)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_HL_SIGNED)
                    .on_hl_signed(kind, action, nonce, transfer),
            )
    }

    fn assert_intent(&self, intent: &Intent) {
        let lenders = &self.config.lenders;
        match intent {
            Intent::Check {} => {}
            Intent::Borrow { amount } => require!(amount.0 > 0, "a borrow intent needs a positive amount"),
            Intent::Withdraw { token, amount } => {
                require!(amount.0 > 0, "a withdraw intent needs a positive amount");
                require!(self.config.token(token).is_some(), "not an allow-listed token");
            }
            Intent::Fund { amount } => require!(amount.0 > 0, "a fund intent needs a positive amount"),
            // Taking collateral back needs no permission: the owner can always leave.
            Intent::LenderWithdraw { lender, token, amount } => {
                require!(amount.0 > 0, "a lender_withdraw intent needs a positive amount");
                let listed = match lender.as_str() {
                    RHEA => lenders
                        .rhea
                        .as_ref()
                        .map(|rhea| token.parse::<AccountId>().is_ok_and(|id| rhea.collateral.contains(&id))),
                    AAVE => lenders.aave.as_ref().map(|_| lenders.aave_collateral(token).is_some()),
                    _ => env::panic_str(r#"a lender_withdraw intent names "aave" or "rhea""#),
                };
                match listed {
                    Some(true) => {}
                    Some(false) => env::panic_str(&format!("{token} is not one of {lender}'s collateral tokens")),
                    None => env::panic_str(&format!("this account has no settings for {lender}")),
                }
            }
            Intent::EvmWithdraw { token, amount } => {
                require!(amount.0 > 0, "an evm_withdraw intent needs a positive amount");
                let aave =
                    lenders.aave.as_ref().unwrap_or_else(|| env::panic_str("this account has no settings for aave"));
                let is = |listed: &pb_types::EvmToken| listed.address.eq_ignore_ascii_case(token);
                require!(
                    is(&aave.usdc) || aave.collateral.iter().any(is),
                    "not a token of this account's Aave settings"
                );
            }
        }
    }

    /// The held verdict, if it can still back an action: unused (its nonce is still the counter) and at most
    /// 120 blocks old by `blk`.
    fn usable_verdict(&self) -> &Held {
        let held = self.verdict.as_ref().unwrap_or_else(|| env::panic_str("no verdict: ask for a check first"));
        require!(held.verdict.nonce == self.counter, "the verdict was already used: ask for a new check");
        let age = env::block_height().saturating_sub(held.verdict.blk);
        require!(age <= FRESH_BLOCKS, format!("the verdict is {age} blocks old, above the {FRESH_BLOCKS}-block limit"));
        held
    }

    /// Checks OutLayer's answer and, if it passes, keeps it and updates the records.
    fn accept(&mut self, intent: Intent, bytes: &[u8]) -> Result<(), String> {
        let account = env::current_account_id();
        let expected = Expected {
            account: account.as_str(),
            counter: self.counter,
            config: &self.config,
            height: env::block_height(),
            held_blk: self.verdict.as_ref().map(|h| h.verdict.blk),
        };
        let v = verdict::check(bytes, &expected)?;
        log!("verdict accepted: nonce {}", v.nonce);
        let now = env::block_timestamp();
        self.margin_call.record(now, v.below_buffer(), v.since);
        let confirmed = self.deleverage.record(now, v.action == Action::Deleverage, v.venues.hl_margin_ratio_bp);
        record_hour(&mut self.hourly, now, v.hr_bp, v.exp_bp);
        for id in &v.arrived {
            self.settle_transfer(id, |_| "verdict");
        }
        // A transfer out of Hyperliquid that this verdict names as sent can't be posted again, so it holds back
        // nothing more. Only an accepted verdict gets here.
        if self.hl.settle_sends(&v.sent, now / 1_000_000) {
            log!("Hyperliquid shows the signed transfer as sent: the pause on borrowing ends now");
        }
        match v.action {
            Action::Deleverage if confirmed => self.store_plan(&v, now),
            Action::Rebalance | Action::RebalanceNow => self.store_plan(&v, now),
            Action::None if v.state == State::Healthy => {
                if self.plan.take().is_some() {
                    log!("plan cleared: the account is HEALTHY");
                }
            }
            _ => {}
        }
        // DEFAULT has its own two checks, never confirmed at once: one verdict blocks nothing and writes nothing off.
        let defaulted = self.default_check.confirm(now, v.state == State::Default, false);
        if defaulted && !self.blocked {
            self.blocked = true;
            log!("DEFAULT confirmed: the account is blocked, and the pool writes off its debt");
            ext_pool::ext(self.config.pool_id.clone()).with_static_gas(GAS_FOR_WRITE_OFF).write_off(account).detach();
        } else if v.state == State::Default && !self.blocked {
            log!("DEFAULT: a first check. A second DEFAULT verdict 2 to 5 minutes later blocks the account");
        }
        let chain_nonce = v.evm.as_ref().map(|seen| seen.nonce);
        self.verdict = Some(Held {
            intent,
            received_block: env::block_height(),
            received_at: now,
            verdict: v,
            json: String::from_utf8_lossy(bytes).into_owned(),
        });
        // A reading of Aave's chain past a signed transaction's nonce shows it mined or reverted: the chain is the
        // truth from here on. Dropping the listing moves the counter on, so this verdict itself backs nothing. Its
        // reading of the position may be a block behind its reading of the nonce.
        if let Some(seen) = chain_nonce {
            if self.drop_lender_actions(|action| action.seen_mined(seen)) {
                log!("Aave's chain has used the signed transaction's nonce: the counter moves on");
            }
        }
        Ok(())
    }
}

/// Refuses a permission that doesn't fit the account's settings, with `Permission::problem`'s words.
fn assert_permission(permission: Option<&Permission>, config: &Config) {
    if let Some(problem) = permission.and_then(|p| p.problem(&config.lenders)) {
        env::panic_str(&problem);
    }
}

/// The callback's promise result as a `U128` (a token's or the pool's answer), or `None` if it failed.
fn result_u128() -> Option<u128> {
    let bytes = env::promise_result_checked(0, 64).ok()?;
    serde_json::from_slice::<U128>(&bytes).ok().map(|value| value.0)
}

/// Whether the callback's promise succeeded. Its value isn't read.
fn succeeded() -> bool {
    !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed))
}

fn parse_msg(msg: &str) -> Option<Msg> {
    serde_json::from_slice::<TransferMsg>(msg.as_bytes()).ok().map(|m| m.pb)
}

/// Registers `receiver` on `token` if needed (with `register`) and transfers `amount`, in one batch, then `on_sent`,
/// which bumps the counter. `transfer` is the id of the 1Click transfer it makes, if any, which `on_sent` drops if
/// the tokens don't go out. Without `register` only the transfer goes, and fails for a receiver the token doesn't
/// know.
fn send_token(
    token: AccountId,
    receiver: &AccountId,
    amount: U128,
    transfer: Option<String>,
    register: bool,
) -> Promise {
    let send = FtTransfer { receiver_id: receiver, amount };
    let mut batch = Promise::new(token);
    if register {
        let register = StorageDeposit { account_id: receiver, registration_only: true };
        batch = batch.function_call("storage_deposit", to_bytes(&register), STORAGE_DEPOSIT, GAS_FOR_FT);
    }
    batch
        .function_call("ft_transfer", to_bytes(&send), ONE_YOCTO, GAS_FOR_FT)
        .then(Account::ext(env::current_account_id()).with_static_gas(GAS_FOR_ON_SENT).on_sent(transfer))
}

/// Whether the account still has `NEAR_RESERVE` free of what its storage locks once it has paid `cost`.
fn keeps_near_reserve(cost: NearToken) -> bool {
    let locked = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage()));
    let free = env::account_balance().saturating_sub(locked);
    free >= NEAR_RESERVE.saturating_add(cost)
}

/// The NEAR network an account lives on, for `pb-risk`'s input: mainnet for `.near` ids, testnet otherwise.
fn network(account: &AccountId) -> &'static str {
    if account.as_str().ends_with(".near") {
        "mainnet"
    } else {
        "testnet"
    }
}

fn to_bytes(value: &impl Serialize) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_default()
}

fn to_string(value: &impl Serialize) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

// The arguments of the calls the account makes, as JSON.

/// `pb-risk`'s input (INTERFACES.md 6).
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct RunInput<'a> {
    mode: &'static str,
    account: &'a AccountId,
    intent: &'a Intent,
    network: &'static str,
    snapshot: bool,
}

/// `pb-gateway`'s input in mode `agent_address` (INTERFACES.md 9).
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct AgentInput<'a> {
    mode: &'static str,
    account: &'a AccountId,
    network: &'static str,
}

/// `{"Project":{"project_id":…,"version_key":…}}`: the pinned program.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Source<'a> {
    #[serde(rename = "Project")]
    project: ProjectSource<'a>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct ProjectSource<'a> {
    project_id: &'a str,
    version_key: &'a str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Limits {
    max_instructions: u64,
    max_memory_mb: u32,
    max_execution_seconds: u32,
}

/// OutLayer's `request_execution` (research/outlayer.md 1). It refunds the unused deposit to `payer_account_id`.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct RequestExecution<'a> {
    source: Source<'a>,
    resource_limits: Limits,
    input_data: String,
    secrets_ref: Option<&'a SecretsRef>,
    response_format: &'static str,
    payer_account_id: AccountId,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct StorageDeposit<'a> {
    account_id: &'a AccountId,
    registration_only: bool,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct FtTransfer<'a> {
    receiver_id: &'a AccountId,
    amount: U128,
}

/// The MPC signer's `derived_public_key({"path","predecessor","domain_id"})`. Domain 0 is secp256k1.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct DerivedKeyArgs<'a> {
    path: &'a str,
    predecessor: &'a AccountId,
    domain_id: u64,
}

/// The MPC signer's `sign({"request":{"path","payload_v2":{"Ecdsa":"<64 hex>"},"domain_id":0}})`, as the Phase 0
/// probe called it (contracts/testnet/probe).
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct SignArgs<'a> {
    request: SignRequest<'a>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct SignRequest<'a> {
    path: &'a str,
    payload_v2: Payload,
    domain_id: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Payload {
    #[serde(rename = "Ecdsa")]
    ecdsa: String,
}
