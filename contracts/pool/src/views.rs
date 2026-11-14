//! Views (PLAN.md 5.1). They read the live state, with interest up to the current block, and change nothing.
use near_sdk::json_types::{I128, U128, U64};
use near_sdk::{env, near, AccountId};

use crate::pricing::{budget_left, PricingView};
use crate::*;

#[near]
impl Pool {
    /// Cash, loans, capital, utilisation, the rate per tier, interest earned, write-offs, the last 24 hours' lending
    /// against its budget, the exposures against their caps, whether the pool is paused, and the pricing totals:
    /// fees charged and reversed, subsidies, what is left of the 24-hour subsidy budget, and the credit owed to
    /// accounts.
    pub fn get_pool(&self) -> PoolView {
        let now = env::block_timestamp();
        let index = self.indices_at(now);
        let loans = self.loans(&index);
        let capital = self.capital_with(loans);
        let share = |bp: u32| U128(math::mul_div_floor(capital, bp.into(), BP).unwrap_or(0));
        let rates = self.rates_wad(&index);
        let book = self.book(&index);
        let budget_bp = self.budget_bp_at(now);
        let invested = self.funded.saturating_sub(self.defunded);
        PoolView {
            cash: U128(self.cash),
            loans: U128(loans),
            capital: U128(capital),
            utilisation_bp: bp(math::utilisation(loans, capital).unwrap_or(0)),
            rate_bp: PerTier::from_fn(|t| bp(rates[t.index()])),
            interest_earned: U128((capital + self.written_off).saturating_sub(invested)),
            written_off: U128(self.written_off),
            funded: U128(self.funded),
            defunded: U128(self.defunded),
            paused: self.paused,
            lent_24h: I128(self.lent.total(now, self.periods.bucket_ns())),
            daily_budget: share(budget_bp),
            daily_budget_bp: budget_bp,
            pending_budget: self.pending_budget.clone().filter(|p| now < p.from.0),
            wrappers: self
                .caps
                .wrapper_cap_bp
                .iter()
                .map(|(token, cap)| {
                    (token.clone(), Exposure { amount: U128(amount_of(&book.wrappers, token)), cap: share(*cap) })
                })
                .collect(),
            hyperliquid: Exposure { amount: U128(book.hl), cap: share(self.caps.hl_cap_bp) },
            book: self
                .caps
                .book_cap
                .iter()
                .map(|(token, cap)| (token.clone(), Exposure { amount: U128(amount_of(&book.hold, token)), cap: *cap }))
                .collect(),
            fees_charged: U128(self.fees_charged),
            fees_reversed: U128(self.fees_reversed),
            subsidy_paid: U128(self.subsidy_paid),
            subsidy_left_24h: U128(budget_left(
                self.pricing_limits.pool_subsidy_day(capital),
                self.subsidy_24h_at(now),
            )),
            credit_owed: U128(self.credit),
        }
    }

    /// The pool's settings, with the funding settings, the pricing limits and each tier's pricing policy.
    pub fn get_params(&self) -> ParamsView {
        let now = env::block_timestamp();
        ParamsView {
            operator: self.operator.clone(),
            factory: self.factory.clone(),
            token: self.token.clone(),
            periods: self.periods.clone(),
            rates: self.rates.clone(),
            caps: self.caps.clone(),
            daily_budget_bp: self.budget_bp_at(now),
            pending_budget: self.pending_budget.clone().filter(|p| now < p.from.0),
            funding: self.funding.clone(),
            pricing_limits: self.pricing_limits.clone(),
            tier_pricing: Tier::ALL
                .into_iter()
                .filter_map(|t| Some((t.name().to_string(), self.tier_pricing[t.index()].clone()?)))
                .collect(),
        }
    }

    /// One account as the pool sees it, or `None` if it isn't registered. The engine reads its `tier` and
    /// `last_upgrade_at`, so a verdict never claims a tier the pool would refuse.
    pub fn get_borrower(&self, account_id: AccountId) -> Option<BorrowerView> {
        let b = self.borrowers.get(&account_id)?;
        let now = env::block_timestamp();
        let index = self.indices_at(now);
        let pricing = self.pricing_view(&account_id, b.tier_now(now));
        Some(BorrowerView {
            created_at: U64(b.created_at),
            first_week_until: U64(b.created_at.saturating_add(self.periods.new_account_ns.0)),
            debt: U128(b.debt(&index)),
            tier: b.tier_now(now),
            history_tier: b.tier,
            last_upgrade_at: b.last_upgrade_at.map(U64),
            kyb_entity: b.kyb_entity.clone(),
            tier_override: b.tier_override.clone(),
            blocked: b.blocked,
            hl_address: b.hl_address.clone(),
            steps_24h: U128(u128::try_from(b.steps.total(now, self.periods.bucket_ns())).unwrap_or(0)),
            shares_bp: b.shares_bp.iter().cloned().collect(),
            hold: b.hold.iter().map(|(token, held)| (token.clone(), U128(*held))).collect(),
            hl_eq: U128(b.hl_eq),
            pricing: pricing.pricing,
            fees_charged: pricing.fees_charged,
            subsidy_paid: pricing.subsidy_paid,
            credit: pricing.credit,
        })
    }

    /// An account's pricing (INTERFACES.md 26), or `None` if it isn't registered: the policy that applies now, where
    /// it came from ("account", "tier" or "default"), the fees added to its debt, those the operator took back and
    /// the subsidies given to it since the start, the credit it can claim, when it last settled (0: never) and the
    /// report that settlement stored.
    pub fn get_pricing(&self, account_id: AccountId) -> Option<PricingView> {
        let b = self.borrowers.get(&account_id)?;
        Some(self.pricing_view(&account_id, b.tier_now(env::block_timestamp())))
    }

    /// An account's debt with interest up to now (0 if it isn't registered).
    pub fn debt_of(&self, account_id: AccountId) -> U128 {
        let index = self.indices_at(env::block_timestamp());
        U128(self.borrowers.get(&account_id).map_or(0, |b| b.debt(&index)))
    }

    /// The debt of all accounts with this KYB entity id, together.
    pub fn entity_debt(&self, entity: String) -> U128 {
        let index = self.indices_at(env::block_timestamp());
        let scaled = self.entities.get(&entity).copied().unwrap_or_default();
        U128((0..3).map(|t| math::debt(scaled[t], index[t]).unwrap_or(u128::MAX)).fold(0, u128::saturating_add))
    }

    /// The account that linked this Hyperliquid address, if any.
    pub fn hl_link_owner(&self, hl_address: String) -> Option<AccountId> {
        self.hl_links.get(&hl_address.to_ascii_lowercase()).cloned()
    }

    pub fn is_cosigned(&self, request: CosignRequest) -> bool {
        self.cosigns.contains(&request)
    }

    pub fn step_price(&self, token: AccountId) -> Option<StepPrice> {
        self.step_prices.get(&token).cloned()
    }

    /// The coin-status list (at most 64 entries).
    pub fn coin_statuses(&self) -> Vec<(String, CoinState)> {
        self.coins.iter().map(|(coin, state)| (coin.clone(), state.clone())).collect()
    }

    pub fn coin_status(&self, coin: String) -> Option<CoinState> {
        self.coins.get(&coin).cloned()
    }

    /// Every published version of a program, oldest first.
    pub fn versions(&self, program: String) -> Vec<ProgramVersion> {
        self.versions.get(&program).cloned().unwrap_or_default()
    }

    pub fn latest_version(&self, program: String) -> Option<ProgramVersion> {
        self.versions.get(&program).and_then(|list| list.last().cloned())
    }
}

impl Pool {
    /// A registered account's pricing as `get_pricing` shows it, given the tier that applies to it now.
    fn pricing_view(&self, account_id: &AccountId, tier: Tier) -> PricingView {
        let tier_policy = self.tier_pricing[tier.index()].as_ref();
        let fees_reversed = self.fees.get(account_id).map_or(0, |fees| fees.fees_reversed);
        match self.pricing.get(account_id) {
            Some(record) => record.view(tier_policy, fees_reversed),
            None => AccountPricing::default().view(tier_policy, fees_reversed),
        }
    }

    /// The pool's subsidies over the 24 hours ending at `now`.
    pub(crate) fn subsidy_24h_at(&self, now: u64) -> u128 {
        u128::try_from(self.subsidy_24h.total(now, self.periods.bucket_ns())).unwrap_or(0)
    }
}

/// A WAD fraction in whole basis points, rounded to the nearest (for display, and for the rate a settlement shows; the
/// pool computes its interest in WAD).
pub(crate) fn bp(wad: u128) -> u32 {
    let unit = WAD / BP;
    u32::try_from(wad.saturating_add(unit / 2) / unit).unwrap_or(u32::MAX)
}
