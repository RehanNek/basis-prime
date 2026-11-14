//! The pool's public events (NEP-297 logs, standard `pb-pool`), so the keeper, the web app and anyone else can follow
//! every loan, repayment, write-off, freeze and setting change. Each log reads
//! `EVENT_JSON:{"standard":"pb-pool","version":"1.0.0","event":"borrow","data":{...}}`.
use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

use crate::pricing::{FundingSettings, PartView, Pricing, PricingFrom, PricingLimits, PricingTarget};
use crate::types::*;

#[near(event_json(standard = "pb-pool"))]
pub enum Event<'a> {
    #[event_version("1.0.0")]
    Fund { amount: U128 },
    #[event_version("1.0.0")]
    Defund { amount: U128 },
    #[event_version("1.0.0")]
    DefundFailed { amount: U128 },
    #[event_version("1.0.0")]
    Register { account_id: &'a AccountId },
    #[event_version("1.0.0")]
    Borrow { account_id: &'a AccountId, amount: U128, tier: Tier, debt: U128 },
    /// The account didn't take (part of) a loan, so the pool undid it.
    #[event_version("1.0.0")]
    LoanReturned { account_id: &'a AccountId, amount: U128 },
    #[event_version("1.0.0")]
    Repay { account_id: &'a AccountId, amount: U128 },
    #[event_version("1.0.0")]
    Link { account_id: &'a AccountId, hl_address: &'a str },
    #[event_version("1.0.0")]
    Step { account_id: &'a AccountId, plan_id: &'a str, step: u32, value: U128, total_24h: U128 },
    #[event_version("1.0.0")]
    WriteOff { account_id: &'a AccountId, amount: U128 },
    #[event_version("1.0.0")]
    SetRates { rates: &'a Rates },
    #[event_version("1.0.0")]
    SetCaps { caps: &'a Caps },
    #[event_version("1.0.0")]
    SetDailyBudget { in_force_bp: u32, pending: &'a Option<PendingBudget> },
    #[event_version("1.0.0")]
    SetKyb { account_id: &'a AccountId, entity: &'a Option<String> },
    #[event_version("1.0.0")]
    SetTierOverride { account_id: &'a AccountId, tier_override: &'a Option<TierOverride> },
    #[event_version("1.0.0")]
    Cosign { request: &'a CosignRequest },
    #[event_version("1.0.0")]
    RevokeCosign { request: &'a CosignRequest },
    #[event_version("1.0.0")]
    SetStepPrice { token: &'a AccountId, price: &'a StepPrice },
    #[event_version("1.0.0")]
    SetCoinStatus { coin: &'a str, state: &'a CoinState },
    #[event_version("1.0.0")]
    PublishVersion { program: &'a str, version: &'a ProgramVersion },
    #[event_version("1.0.0")]
    SetPaused { paused: bool },
    #[event_version("1.0.0")]
    Unblock { account_id: &'a AccountId },
    /// A pricing policy set for an account or a tier (`pricing` null: cleared).
    #[event_version("1.0.0")]
    SetPricing { target: &'a PricingTarget, pricing: &'a Option<Pricing> },
    #[event_version("1.0.0")]
    SetPricingLimits { limits: &'a PricingLimits },
    #[event_version("1.0.0")]
    SetFunding { funding: &'a FundingSettings },
    /// One settlement: the fee added to the account's debt or the subsidy given to it (after the budgets' `cut`, of
    /// the fee or of the subsidy), the account's credit and debt afterwards, and each source's part.
    #[event_version("1.0.0")]
    Settle {
        account_id: &'a AccountId,
        pricing: &'a Pricing,
        from: PricingFrom,
        period_ns: U64,
        fee: U128,
        subsidy: U128,
        cut: U128,
        credit: U128,
        debt: U128,
        parts: &'a [PartView],
    },
    /// The pool paid an account its credit, or took the payment back because the transfer failed.
    #[event_version("1.0.0")]
    ClaimCredit { account_id: &'a AccountId, amount: U128 },
    #[event_version("1.0.0")]
    ClaimCreditFailed { account_id: &'a AccountId, amount: U128 },
    /// The operator took a fee back off an account's debt: the amount, and the debt afterwards.
    #[event_version("1.0.0")]
    ReverseFee { account_id: &'a AccountId, amount: U128, debt: U128 },
}
