//! Settling and credit (FUNDING.md 5.2 and 5.3; INTERFACES.md 26).
//!
//! An account contract calls `settle` with its fresh verdict's lender report: at every lender borrow, at a lender
//! repayment when it holds a fresh verdict, and whenever anyone asks it to (the keeper does, each hour). The pool
//! works out what the operator's policy says the client should have paid since the last settlement against what each
//! source really cost (`pricing::settlement`), and books the difference on the client's debt here.
//!
//! - **A fee** adds to the debt, as interest does. The pool's exposure records follow it. It stays out of the daily
//!   lending window, which counts money lent. It is cut to what is left of the account's and the pool's 24-hour fee
//!   budgets, and what is cut isn't owed later (INTERFACES.md 45.1).
//! - **A subsidy** comes off the debt. It isn't a repayment, so it opens no room in that window. It is cut to what
//!   is left of the account's and the pool's 24-hour budgets, and what is cut isn't owed later. Past a debt of zero
//!   it becomes credit.
//! - **Credit** is money the pool owes the account. Capital subtracts it, and neither a loan nor a defund can take
//!   the cash behind it. `claim_credit` pays it in USDC.
//! - **`settle` never panics for a registered account with a well-formed report.** When it is too soon, or there is
//!   nothing to do, it answers `{"skipped":"<why>"}` and changes nothing. A report that shows a new borrow at a
//!   lender is never too soon.
//! - **A period has two ends.** A settlement at a borrow passes both: `closes`, the lenders' debts just before the
//!   borrow, which close the period, and `report`, the debts with the borrow, from which the next period starts.
//!   Every other settlement passes `report` alone, and it does both.
use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, AccountId, Gas, Promise, PromiseError};
use pb_types::LenderReport;

use crate::pricing::{
    apply, borrowed_since, cut_fee, cut_subsidy, policy_for, report_problem, settlement, AccountFees, Adjustment,
    PartView, Period, SettleAnswer, Settled, Settlement,
};
use crate::views::bp;
use crate::*;

/// The account contract attaches 40 TGas to `claim_credit`. The token's `ft_transfer` and `on_credit_paid` get 25 of
/// it, which leaves 15 for `claim_credit` itself (it burns about 3).
const GAS_FOR_CREDIT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_ON_CREDIT_PAID: Gas = Gas::from_tgas(10);
/// More than a settlement can add to the pool's storage: a full pricing record with its key is about 1.3 KB, and a
/// full fees record with its key about 0.7 KB.
const RECORD_ROOM_BYTES: u64 = 3_000;

/// One settlement worked out, before anything is booked.
struct Worked {
    /// The borrower's record afterwards: its debt on the tier that applies now, with the fee or less the subsidy.
    borrower: Borrower,
    settlement: Settlement,
    /// What is booked: the settlement's total, a fee or a subsidy, cut to its budgets.
    booked: Adjustment,
    cut: u128,
    /// The account's credit afterwards.
    credit: u128,
}

#[near]
impl Pool {
    /// Settles the calling account's pricing since its last settlement (FUNDING.md 5.2). `report` is the account's
    /// fresh verdict's lender report: for "aave" and "rhea", once each at most, the debt there in micro-USD and the
    /// lender's borrow and deposit rates in bp a year. Only an account the factory registered can call it, with no
    /// deposit; the account contract attaches 30 TGas, and it burns about 3.
    ///
    /// `closes` may be left out. At a borrow the account passes it: the lender report as it stood just before the
    /// borrow. The settlement then closes the period on `closes` and stores `report`, which shows the debt with the
    /// borrow, as the start of the next. So a lender repaid and borrowed from again is not counted as owed in
    /// between. Left out, `report` does both. `closes` is checked as `report` is.
    ///
    /// It answers `{"fee","subsidy","credit","period_ns","cut","debt","pricing","from","parts"}`: the fee added to
    /// the account's debt or the subsidy given to it, its credit and debt afterwards, and each source's part. The
    /// account contract books `fee` and `subsidy` on its own loan record, so they are exactly what was booked here:
    /// `fee` went onto the debt as a loan of that amount would (on an account that owed nothing, it opens one), and
    /// `subsidy` came off the debt down to zero, the rest going to `credit`. `cut` is what the 24-hour budgets took
    /// off the fee or the subsidy before that; it isn't owed later. The first settlement only stores its report.
    ///
    /// It answers `{"skipped":"<why>"}` and changes nothing when the last settlement was under `min_period_ns` ago
    /// and the report shows no new borrow at a lender (no more debt there than interest could have added), when the
    /// account has no lender debt and no policy, while the pool is paused, for an account blocked after a write-off,
    /// when the report's amounts are too large to work out, and when the pool account is short of NEAR for the
    /// record's storage. A report that names a lender twice, or one that isn't "aave" or "rhea", is refused.
    pub fn settle(&mut self, report: Vec<LenderReport>, closes: Option<Vec<LenderReport>>) -> SettleAnswer {
        let account_id = env::predecessor_account_id();
        let b = self.borrower(&account_id);
        if let Some(problem) = report_problem(&report).or_else(|| closes.as_deref().and_then(report_problem)) {
            env::panic_str(&problem);
        }
        // The report that closes this period: the debts just before a borrow when the account passes them.
        let closing = closes.as_deref().unwrap_or(&report);
        let now = env::block_timestamp();
        let skipped = |why: String| SettleAnswer::Skipped { skipped: why };
        if self.paused {
            return skipped("the pool is paused: settlements wait".into());
        }
        if b.blocked {
            return skipped("this account is blocked after a write-off".into());
        }
        let stored = self.pricing.get(&account_id).cloned();
        let tier = b.tier_now(now);
        let own = stored.as_ref().and_then(|record| record.pricing.as_ref());
        let (pricing, from) = policy_for(own, self.tier_pricing[tier.index()].as_ref());
        let no_debt = report.iter().chain(closing).all(|line| line.debt.0 == 0);
        if stored.is_none() && pricing == Pricing::PassThrough && no_debt {
            return skipped("nothing to settle: no lender debt and no pricing policy".into());
        }
        let mut record = stored.unwrap_or_default();
        // Anyone may ask an account to settle, so two settlements keep a minimum distance (INTERFACES.md 30, point 4).
        // A report that shows a new borrow at a lender is settled all the same: the account's `l_borrow` step reports
        // the lender's debt with what it is about to borrow, and skipping that would leave a loan the pool never
        // sees if the client repaid it before the next settlement.
        let (since, least) = (record.elapsed_ns(now), self.pricing_limits.min_period_ns);
        let too_soon = record.settled_at != 0 && since < least;
        if too_soon && !borrowed_since(&record.last, &report, since, self.pricing_limits.max_rate_bp) {
            return skipped(format!(
                "too soon: this account settled {} ago, and two settlements are at least {} apart",
                in_words(since),
                in_words(least)
            ));
        }
        // The pool account pays for the record's storage. Short of NEAR, the call would fail once the work was done,
        // and a failed settlement stops the account's step at the lender: this one waits instead.
        if !can_store_a_record() {
            return skipped("the pool account is short of NEAR for storage: the operator must top it up".into());
        }
        self.accrue();
        let mut fees = self.fees.get(&account_id).cloned().unwrap_or_default();
        let Some(worked) = self.work_out(&b, (&record, &fees), &pricing, closing, tier, now) else {
            return skipped("the amounts are too large to settle".into());
        };
        let Worked { borrower: mut after, settlement, booked, cut, credit } = worked;

        // The debt. The exposure records follow it through `detach` and `attach`; the daily lending window doesn't
        // move, since no money was lent or repaid (INTERFACES.md 30, point 2).
        self.detach(&b);
        self.attach(&mut after);
        let debt = after.debt(&self.index);
        self.borrowers.insert(account_id.clone(), after);

        // The totals, the budgets and the credit.
        let (fee, subsidy) = (booked.fee(), booked.subsidy());
        let bucket = self.periods.bucket_ns();
        if subsidy > 0 {
            record.subsidy_24h.add(now, bucket, to_i128(subsidy));
            self.subsidy_24h.add(now, bucket, to_i128(subsidy));
        }
        if fee > 0 {
            fees.fee_24h.add(now, bucket, to_i128(fee));
            self.fee_24h.add(now, bucket, to_i128(fee));
            self.fees.insert(account_id.clone(), fees);
        }
        self.fees_charged = self.fees_charged.saturating_add(fee);
        self.subsidy_paid = self.subsidy_paid.saturating_add(subsidy);
        self.credit = self.credit.saturating_add(credit.saturating_sub(record.credit));
        record.fees_charged = record.fees_charged.saturating_add(fee);
        record.subsidy_paid = record.subsidy_paid.saturating_add(subsidy);
        record.credit = credit;

        // The next period starts here, from this report.
        record.note_rates(now, &report, self.pricing_limits.max_rate_bp);
        record.last = report;
        record.settled_at = now;
        record.pool.restart(now, debt);
        self.pricing.insert(account_id.clone(), record);

        let parts: Vec<PartView> = settlement.parts.iter().map(PartView::from).collect();
        let period_ns = U64(settlement.covered_ns());
        let (fee, subsidy, cut, credit, debt) = (U128(fee), U128(subsidy), U128(cut), U128(credit), U128(debt));
        Event::Settle {
            account_id: &account_id,
            pricing: &pricing,
            from,
            period_ns,
            fee,
            subsidy,
            cut,
            credit,
            debt,
            parts: &parts,
        }
        .emit();
        SettleAnswer::Settled(Settled { fee, subsidy, credit, period_ns, cut, debt, pricing, from, parts })
    }

    /// Pays the calling account all of its credit in USDC. If the transfer fails, the credit is put back. Only an
    /// account the factory registered can call it, with no arguments and no deposit; the account contract attaches
    /// 40 TGas. It is refused while the pool is paused, for an account blocked after a write-off, with no credit, and
    /// while the pool's cash doesn't cover it. It answers what was paid.
    ///
    /// The payment is a plain `ft_transfer`, never `ft_transfer_call`: the account contract books whatever arrives
    /// with the pool's loan message as a new loan, and credit is not a loan.
    #[payable]
    pub fn claim_credit(&mut self) -> Promise {
        let account_id = env::predecessor_account_id();
        let b = self.borrower(&account_id);
        require!(!self.paused, "the pool is paused: credit waits");
        require!(!b.blocked, "this account is blocked after a write-off");
        let amount = self.pricing.get(&account_id).map_or(0, |record| record.credit);
        require!(amount > 0, "no credit to claim");
        require!(amount <= self.cash, "the pool is short of cash right now: claim again after a repayment");
        self.accrue();
        self.take_credit(&account_id, amount);
        self.cash -= amount;
        let amount = U128(amount);
        Event::ClaimCredit { account_id: &account_id, amount }.emit();
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_CREDIT_TRANSFER)
            .ft_transfer(account_id.clone(), amount, Some("credit".to_string()))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_CREDIT_PAID)
                    .on_credit_paid(account_id, amount),
            )
    }

    /// Puts the credit and the cash back if the transfer to the account failed. Never panics.
    #[private]
    pub fn on_credit_paid(
        &mut self,
        account_id: AccountId,
        amount: U128,
        #[callback_result] sent: Result<(), PromiseError>,
    ) -> U128 {
        if sent.is_ok() {
            return amount;
        }
        self.cash = self.cash.saturating_add(amount.0);
        self.credit = self.credit.saturating_add(amount.0);
        let mut record = self.pricing.get(&account_id).cloned().unwrap_or_default();
        record.credit = record.credit.saturating_add(amount.0);
        self.pricing.insert(account_id.clone(), record);
        Event::ClaimCreditFailed { account_id: &account_id, amount }.emit();
        U128(0)
    }
}

impl Pool {
    /// Works one settlement out without changing anything: `closing` is the report that closes the period. None
    /// means an absurd amount overflowed.
    fn work_out(
        &self,
        b: &Borrower,
        (record, fees): (&AccountPricing, &AccountFees),
        pricing: &Pricing,
        closing: &[LenderReport],
        tier: Tier,
        now: u64,
    ) -> Option<Worked> {
        let mut borrower = b.clone();
        self.move_debt(&mut borrower, tier);
        let index = self.index[tier.index()];
        let debt = math::debt(borrower.scaled, index)?;
        let elapsed_ns = record.elapsed_ns(now);

        // Our pool's own part, which only a fixed rate adjusts: what the account owed on average over the period,
        // and the rate the pool really charged on it. Neither can be moved just before a settlement (INTERFACES.md
        // 30, point 1).
        let mut pool_part = record.pool.clone();
        pool_part.see(now, debt);
        let fixed_bp = match pricing {
            Pricing::Fixed { rate_bp } => Some(*rate_bp),
            _ => None,
        };
        let rate_now_bp = bp(self.rates_wad(&self.index)[tier.index()]);
        let (pool_debt, tier_rate_bp) = pool_part.figures(elapsed_ns, fixed_bp, rate_now_bp);

        let period = Period { elapsed_ns, previous: &record.last, new: closing, pool_debt, tier_rate_bp };
        let settlement = settlement(pricing, &self.pricing_limits, &period, |lender| record.average_bp(lender, now))?;

        // A subsidy is cut to what is left of the account's and the pool's 24-hour budgets, and a fee to what is
        // left of its own two.
        let bucket = self.periods.bucket_ns();
        let in_24h = |window: &Window| u128::try_from(window.total(now, bucket)).unwrap_or(0);
        let (booked, cut) = match settlement.total {
            Adjustment::Subsidy(full) => {
                let capital = self.capital(&self.index);
                let (account_paid, pool_paid) = (in_24h(&record.subsidy_24h), in_24h(&self.subsidy_24h));
                let kept = cut_subsidy(&self.pricing_limits, full, account_paid, pool_paid, capital);
                (if kept == 0 { Adjustment::Nothing } else { Adjustment::Subsidy(kept) }, full - kept)
            }
            Adjustment::Fee(full) => {
                let capital = self.capital(&self.index);
                let (account_charged, pool_charged) = (in_24h(&fees.fee_24h), in_24h(&self.fee_24h));
                let kept = cut_fee(&self.pricing_limits, full, account_charged, pool_charged, capital);
                (if kept == 0 { Adjustment::Nothing } else { Adjustment::Fee(kept) }, full - kept)
            }
            Adjustment::Nothing => (Adjustment::Nothing, 0),
        };

        // A fee rounds the scaled debt up and a subsidy rounds it down, as a loan and a repayment do.
        let (debt_after, credit) = apply(booked, debt, record.credit)?;
        borrower.scaled = match booked {
            Adjustment::Nothing => borrower.scaled,
            Adjustment::Fee(fee) => borrower.scaled.checked_add(math::scaled_for_loan(fee, index)?)?,
            Adjustment::Subsidy(_) if debt_after == 0 => 0,
            Adjustment::Subsidy(_) => {
                borrower.scaled.saturating_sub(math::scaled_for_repayment(debt - debt_after, index)?)
            }
        };
        math::debt(borrower.scaled, index)?;
        Some(Worked { borrower, settlement, booked, cut, credit })
    }
}

/// Whether the pool account's NEAR covers its storage with one more pricing record (a byte locks 10^19 yoctoNEAR).
fn can_store_a_record() -> bool {
    let bytes = env::storage_usage().saturating_add(RECORD_ROOM_BYTES);
    env::account_balance() >= env::storage_byte_cost().saturating_mul(bytes.into())
}

/// A time span in plain words, for a skipped settlement's answer: whole minutes from two minutes up, else seconds.
fn in_words(ns: u64) -> String {
    let seconds = ns / 1_000_000_000;
    if seconds >= 120 {
        format!("{} minutes", seconds / 60)
    } else if seconds == 1 {
        "1 second".to_string()
    } else {
        format!("{seconds} seconds")
    }
}
