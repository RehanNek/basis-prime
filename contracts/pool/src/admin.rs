//! The operator's settings (PLAN.md 5.1, "Admin"). Every method here is operator-only, and each one logs a public
//! event, so every freeze, cap change and co-signature is visible on-chain.
use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, AccountId};

use crate::pricing::PricingTarget;
use crate::*;

/// Longest reason for a manual tier override.
const MAX_REASON: usize = 256;
/// Longest program hash or parameter-file hash.
const MAX_HASH: usize = 128;
/// At most this many entries in the coin-status list (23 coins and 5 NEAR tokens today).
const MAX_COINS: u32 = 64;

#[near]
impl Pool {
    /// Sets the rate curve and the tier spreads. Interest up to now accrues at the old rates first.
    pub fn set_rates(&mut self, rates: Rates) {
        self.assert_operator();
        rates.assert_valid();
        self.accrue();
        self.rates = rates.clone();
        Event::SetRates { rates: &rates }.emit();
    }

    /// Sets the caps: everything except the daily lending budget, which has its own timelocked setter.
    pub fn set_caps(&mut self, caps: Caps) {
        self.assert_operator();
        caps.assert_valid();
        self.caps = caps.clone();
        Event::SetCaps { caps: &caps }.emit();
    }

    /// Sets the daily lending budget in bp of capital. Lowering it applies at once. Raising it applies only after
    /// 48 hours, and replaces any raise already waiting.
    pub fn set_daily_budget(&mut self, bp: u32) {
        self.assert_operator();
        require!(u128::from(bp) <= BP, "the budget is at most 10,000 bp");
        let now = env::block_timestamp();
        self.apply_pending_budget(now);
        if bp <= self.budget_bp {
            self.budget_bp = bp;
            self.pending_budget = None;
        } else {
            let from = now.saturating_add(self.periods.budget_delay_ns.0);
            self.pending_budget = Some(PendingBudget { bp, from: U64(from) });
        }
        Event::SetDailyBudget { in_force_bp: self.budget_bp, pending: &self.pending_budget }.emit();
    }

    /// Records the KYB flag with an entity id, or clears it with `None`. Accounts with the same entity id count as one
    /// client. Clearing it takes a Preferred account down to Standard at once.
    pub fn set_kyb(&mut self, account_id: AccountId, entity: Option<String>) {
        self.assert_operator();
        if let Some(e) = &entity {
            require!(!e.is_empty() && e.len() <= MAX_NAME, "the entity id must be 1 to 64 bytes");
        }
        self.update_borrower(&account_id, |b| {
            if entity.is_none() && b.tier == Some(Tier::Preferred) {
                b.tier = Some(Tier::Standard);
            }
            b.kyb_entity = entity.clone();
        });
        Event::SetKyb { account_id: &account_id, entity: &entity }.emit();
    }

    /// Fixes an account's tier by hand until `expires_at`, with a reason. It applies at once, and the account's
    /// verdicts can't claim a better tier while it lasts. Preferred still needs the KYB flag.
    pub fn set_tier_override(&mut self, account_id: AccountId, tier: Tier, reason: String, expires_at: U64) {
        self.assert_operator();
        require!(!reason.is_empty() && reason.len() <= MAX_REASON, "give a reason of 1 to 256 bytes");
        require!(expires_at.0 > env::block_timestamp(), "the override must expire in the future");
        let o = TierOverride { tier, reason, expires_at };
        self.update_borrower(&account_id, |b| {
            require!(
                tier != Tier::Preferred || b.kyb_entity.is_some(),
                "a Preferred tier needs the operator's KYB flag"
            );
            b.tier_override = Some(o.clone());
        });
        Event::SetTierOverride { account_id: &account_id, tier_override: &Some(o) }.emit();
    }

    pub fn clear_tier_override(&mut self, account_id: AccountId) {
        self.assert_operator();
        self.update_borrower(&account_id, |b| b.tier_override = None);
        Event::SetTierOverride { account_id: &account_id, tier_override: &None }.emit();
    }

    /// Co-signs one borrow above $250k, or one plan step past an account's $50k a day. It is used once.
    pub fn cosign(&mut self, request: CosignRequest) {
        self.assert_operator();
        if let CosignRequest::Step { plan_id, .. } = &request {
            require!(plan_id.len() <= MAX_NAME, "plan_id is too long");
        }
        self.cosigns.insert(request.clone());
        Event::Cosign { request: &request }.emit();
    }

    pub fn revoke_cosign(&mut self, request: CosignRequest) {
        self.assert_operator();
        require!(self.cosigns.remove(&request), "no such co-signature");
        Event::RevokeCosign { request: &request }.emit();
    }

    /// Sets the price that plan steps in `token` count at toward the $50k a day: micro-USDC per whole token (a token
    /// with `decimals` decimals), kept above market so the count doesn't rely on the enclave.
    pub fn set_step_price(&mut self, token: AccountId, decimals: u8, price: U128) {
        self.assert_operator();
        require!(price.0 > 0 && decimals <= 30, "the price must be positive, with at most 30 decimals");
        let entry = StepPrice { decimals, price };
        self.step_prices.insert(token.clone(), entry.clone());
        Event::SetStepPrice { token: &token, price: &entry }.emit();
    }

    /// Sets a coin's status (allowed, reduce-only or removed) or a bridged token's (allowed or frozen), stamped with
    /// the time of the change. Every program version reads this list, so a change needs no new version
    /// (RISK_ENGINE.md 5.5). A freeze applies at once: no new loan may rest on the token (3.3). `emergency` marks an
    /// emergency removal, whose notice is 24 hours instead of 7 days.
    pub fn set_coin_status(&mut self, coin: String, status: CoinStatus, emergency: Option<bool>) {
        self.assert_operator();
        require!(!coin.is_empty() && coin.len() <= MAX_NAME, "the coin name must be 1 to 64 bytes");
        let bridged = self.caps.wrapper_cap_bp.contains_key(&coin);
        match status {
            CoinStatus::Frozen => require!(bridged, "only a bridged token (nBTC, ETH or USDT) can be frozen"),
            CoinStatus::ReduceOnly | CoinStatus::Removed => {
                require!(!bridged, "a bridged token is either allowed or frozen")
            }
            CoinStatus::Allowed => {}
        }
        require!(self.coins.contains_key(&coin) || self.coins.len() < MAX_COINS, "the status list is full");
        let emergency = emergency.unwrap_or(false) && status == CoinStatus::ReduceOnly;
        let state = CoinState { status, since: U64(env::block_timestamp()), emergency };
        self.coins.insert(coin.clone(), state.clone());
        Event::SetCoinStatus { coin: &coin, state: &state }.emit();
    }

    /// Publishes a new version of an OutLayer program (`pb-risk` or `pb-gateway`) with its parameter file's hash.
    /// Accounts move to it when their owner accepts it, or 30 days after this publish time (the account contract's
    /// rule, PLAN.md 5.1).
    pub fn publish_version(&mut self, program: String, hash: String, params: String) {
        self.assert_operator();
        require!(!program.is_empty() && program.len() <= MAX_NAME, "the program name must be 1 to 64 bytes");
        require!(
            [&hash, &params].iter().all(|h| !h.is_empty() && h.len() <= MAX_HASH),
            "hashes must be 1 to 128 bytes"
        );
        let mut list = self.versions.get(&program).cloned().unwrap_or_default();
        require!(list.iter().all(|v| v.hash != hash), "this version is already published");
        let version = ProgramVersion { hash, params, published_at: U64(env::block_timestamp()) };
        list.push(version.clone());
        self.versions.insert(program.clone(), list);
        Event::PublishVersion { program: &program, version: &version }.emit();
    }

    /// Pauses (or resumes) new loans and plan steps at once. Repaying is never paused.
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_operator();
        self.paused = paused;
        Event::SetPaused { paused }.emit();
    }

    /// Lifts the block a write-off put on an account, after the operator's review.
    pub fn unblock(&mut self, account_id: AccountId) {
        self.assert_operator();
        self.update_borrower(&account_id, |b| b.blocked = false);
        Event::Unblock { account_id: &account_id }.emit();
    }

    /// Sets what a client pays on a lender's part of a loan (FUNDING.md 5.1), for one account or for a whole tier:
    /// `target` is `{"account":"<id>"}` or `{"tier":"STANDARD"}`. An account's policy is its own, else its tier's,
    /// else pass-through, so `pricing` null clears it. A change counts from the account's next settlement, for the
    /// whole time that settlement covers.
    pub fn set_pricing(&mut self, target: PricingTarget, pricing: Option<Pricing>) {
        self.assert_operator();
        if let Some(policy) = &pricing {
            policy.assert_valid();
        }
        match &target {
            PricingTarget::Account(account_id) => {
                require!(self.borrowers.contains_key(account_id), "not a registered account");
                let mut record = self.pricing.get(account_id).cloned().unwrap_or_default();
                record.pricing = pricing.clone();
                self.pricing.insert(account_id.clone(), record);
            }
            PricingTarget::Tier(tier) => self.tier_pricing[tier.index()] = pricing.clone(),
        }
        Event::SetPricing { target: &target, pricing: &pricing }.emit();
    }

    /// Sets the limits on what a settlement can cost the pool or a client (FUNDING.md 5.3): the most a lender's
    /// rate and its debt count at, the longest time a subsidy covers and the shortest time between two settlements,
    /// and the 24-hour budgets for subsidies and for fees. They apply from the next settlement.
    pub fn set_pricing_limits(&mut self, limits: PricingLimits) {
        self.assert_operator();
        limits.assert_valid();
        self.pricing_limits = limits.clone();
        Event::SetPricingLimits { limits: &limits }.emit();
    }

    /// Sets the order the engine fills a loan's sources in ("cheapest", "pool_first" or "lender_first") and how
    /// many days a loan is expected to last. The engine reads both from `get_params().funding`.
    pub fn set_funding(&mut self, funding: FundingSettings) {
        self.assert_operator();
        funding.assert_valid();
        self.funding = funding.clone();
        Event::SetFunding { funding: &funding }.emit();
    }

    /// Takes a fee back that a settlement booked wrongly (INTERFACES.md 45.1): `amount` comes off the account's debt
    /// to the pool. It is never more than that debt, and never more than the fees charged to the account less those
    /// already reversed; a larger amount is refused. No cash moves, and it opens no room in the daily lending
    /// window, since it is not a repayment. The account contract's own loan record isn't told: the pool's debt is
    /// the authority, and that record clears at the account's next full repayment.
    pub fn reverse_fee(&mut self, account_id: AccountId, amount: U128) {
        self.assert_operator();
        require!(amount.0 > 0, "amount must be positive");
        let mut b = self.borrower(&account_id);
        let charged = self.pricing.get(&account_id).map_or(0, |record| record.fees_charged);
        let mut fees = self.fees.get(&account_id).cloned().unwrap_or_default();
        require!(
            amount.0 <= charged.saturating_sub(fees.fees_reversed),
            "that is more than the fees charged to this account, less those already reversed"
        );
        self.accrue();
        self.detach(&b);
        let tier = b.tier_now(env::block_timestamp());
        self.move_debt(&mut b, tier);
        let debt = b.debt(&self.index);
        require!(amount.0 <= debt, "that is more than the account owes the pool");
        if amount.0 == debt {
            b.scaled = 0;
        } else {
            b.scaled -= ok(math::scaled_for_repayment(amount.0, self.index[tier.index()]));
        }
        self.attach(&mut b);
        let debt_after = b.debt(&self.index);
        self.borrowers.insert(account_id.clone(), b);
        self.note_pool_debt(&account_id, debt, debt_after);
        fees.fees_reversed = fees.fees_reversed.saturating_add(amount.0);
        self.fees.insert(account_id.clone(), fees);
        self.fees_reversed = self.fees_reversed.saturating_add(amount.0);
        Event::ReverseFee { account_id: &account_id, amount, debt: U128(debt_after) }.emit();
    }
}

impl Pool {
    /// Changes one account's record, keeping the pool's totals right and moving its debt to the tier that now applies.
    fn update_borrower(&mut self, account_id: &AccountId, change: impl FnOnce(&mut Borrower)) {
        let mut b = self.borrower(account_id);
        self.accrue();
        self.detach(&b);
        change(&mut b);
        let tier = b.tier_now(env::block_timestamp());
        self.move_debt(&mut b, tier);
        self.attach(&mut b);
        self.borrowers.insert(account_id.clone(), b);
    }
}
