//! The pool's fixed-point math, as pure functions so they are easy to test (PLAN.md 10, "Pool math").
//!
//! - Amounts are integers in the lending token's smallest unit (micro-USDC).
//! - Rates and borrow indices use `WAD` = 10^18 as 1.0. A rate is a fraction per year.
//! - Every function rounds in the pool's favour: debt and interest round up, repayments round down.
//! - Functions return `None` on overflow. The contract turns that into a refusal, or, in a callback that must not
//!   panic, into a safe fallback.

/// 1.0 in fixed point.
pub const WAD: u128 = 1_000_000_000_000_000_000;
/// 100% in basis points.
pub const BP: u128 = 10_000;
/// One year (365 days) in nanoseconds, the unit of NEAR block timestamps.
pub const YEAR_NS: u128 = 365 * 24 * 60 * 60 * 1_000_000_000;

/// a × b / d, rounded down.
pub fn mul_div_floor(a: u128, b: u128, d: u128) -> Option<u128> {
    a.checked_mul(b)?.checked_div(d)
}

/// a × b / d, rounded up.
pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> Option<u128> {
    let product = a.checked_mul(b)?;
    let quotient = product.checked_div(d)?;
    Some(quotient + u128::from(product % d != 0))
}

/// Basis points as a WAD fraction (100 bp = 1% = 0.01 × WAD).
pub fn bp_to_wad(bp: u32) -> u128 {
    u128::from(bp) * (WAD / BP)
}

/// The debt that `scaled` units represent at `index`, rounded up.
pub fn debt(scaled: u128, index: u128) -> Option<u128> {
    mul_div_ceil(scaled, index, WAD)
}

/// Scaled units for a new loan of `amount`, rounded up, so the borrower owes at least `amount`.
pub fn scaled_for_loan(amount: u128, index: u128) -> Option<u128> {
    mul_div_ceil(amount, WAD, index)
}

/// Scaled units that a repayment of `amount` clears, rounded down.
pub fn scaled_for_repayment(amount: u128, index: u128) -> Option<u128> {
    mul_div_floor(amount, WAD, index)
}

/// Utilisation, loans ÷ capital, as a WAD fraction rounded up. A pool with no capital has none.
pub fn utilisation(loans: u128, capital: u128) -> Option<u128> {
    if capital == 0 {
        return Some(0);
    }
    Some(mul_div_ceil(loans, WAD, capital)?.min(WAD))
}

/// The base rate at utilisation `u` (both WAD fractions), rounded up (RISK_ENGINE.md 7.1). It rises in a straight
/// line from 0 to `at_kink` as `u` goes from 0 to `kink`, then in a steeper line to `at_full` at 100%.
/// Needs 0 < kink < WAD and at_kink ≤ at_full.
pub fn base_rate(u: u128, kink: u128, at_kink: u128, at_full: u128) -> Option<u128> {
    if u <= kink {
        mul_div_ceil(at_kink, u, kink)
    } else {
        let steep = mul_div_ceil(at_full.checked_sub(at_kink)?, u - kink, WAD.checked_sub(kink)?)?;
        at_kink.checked_add(steep)
    }
}

/// The index after `dt_ns` nanoseconds at `rate` a year, rounded up. Interest is simple within one period and
/// compounds at each update, as every pool interaction updates the index.
pub fn grow_index(index: u128, rate: u128, dt_ns: u128) -> Option<u128> {
    let growth = mul_div_ceil(rate, dt_ns, YEAR_NS)?;
    index.checked_add(mul_div_ceil(index, growth, WAD)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KINK: u128 = 8 * WAD / 10;
    const AT_KINK: u128 = 6 * WAD / 100;
    const AT_FULL: u128 = WAD / 2;

    fn pct(p: u128) -> u128 {
        p * WAD / 100
    }

    /// A small deterministic generator, so the property tests need no extra crate.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u128) -> u128 {
            (u128::from(self.next()) << 64 | u128::from(self.next())) % n
        }
    }

    #[test]
    fn the_rate_curve_matches_risk_engine_7_1() {
        let base = |u| base_rate(u, KINK, AT_KINK, AT_FULL).unwrap();
        assert_eq!(base(0), 0);
        assert_eq!(base(pct(40)), pct(3));
        assert_eq!(base(pct(60)), 45 * WAD / 1000); // 4.5%, RISK_ENGINE.md 13's 60% pool
        assert_eq!(base(KINK), pct(6));
        assert_eq!(base(pct(90)), pct(28));
        assert_eq!(base(WAD), pct(50));
    }

    #[test]
    fn rounding_favours_the_pool() {
        assert_eq!(mul_div_ceil(10, 1, 3), Some(4));
        assert_eq!(mul_div_floor(10, 1, 3), Some(3));
        // At an index of 1.5, a loan of 1 unit is 1 scaled unit (0.67 rounded up), which owes 2 units (1.5 up).
        let index = 3 * WAD / 2;
        assert_eq!(scaled_for_loan(1, index), Some(1));
        assert_eq!(debt(1, index), Some(2));
        assert_eq!(scaled_for_repayment(1, index), Some(0));
        assert_eq!(utilisation(1, 3), Some(WAD / 3 + 1));
        assert_eq!(utilisation(5, 0), Some(0));
    }

    #[test]
    fn overflow_is_reported_not_wrapped() {
        assert_eq!(mul_div_ceil(u128::MAX, 2, 3), None);
        assert_eq!(mul_div_floor(1, 1, 0), None);
        assert_eq!(debt(u128::MAX, 2 * WAD), None);
    }

    #[test]
    fn a_year_at_ten_percent_grows_the_index_ten_percent() {
        let index = grow_index(WAD, pct(10), YEAR_NS).unwrap();
        assert_eq!(index, WAD + pct(10));
        assert_eq!(grow_index(WAD, pct(10), 0), Some(WAD));
        assert_eq!(grow_index(WAD, 0, YEAR_NS), Some(WAD));
    }

    #[test]
    fn property_the_curve_is_continuous_and_never_falls() {
        let mut rng = Rng(7);
        for _ in 0..5_000 {
            let a = rng.below(WAD + 1);
            let b = rng.below(WAD + 1);
            let (lo, hi) = (a.min(b), a.max(b));
            let (r_lo, r_hi) =
                (base_rate(lo, KINK, AT_KINK, AT_FULL).unwrap(), base_rate(hi, KINK, AT_KINK, AT_FULL).unwrap());
            assert!(r_lo <= r_hi, "rate fell from {lo} to {hi}");
            assert!(r_hi <= AT_FULL);
        }
        // Continuous at the kink: one unit either side moves the rate by about the steep slope (2.2 units per unit of
        // utilisation) plus rounding, not by a jump.
        let below = base_rate(KINK - 1, KINK, AT_KINK, AT_FULL).unwrap();
        let above = base_rate(KINK + 1, KINK, AT_KINK, AT_FULL).unwrap();
        assert!(above - below <= 5);
    }

    #[test]
    fn property_a_loan_owes_at_least_what_was_lent_and_a_full_repayment_clears_it() {
        let mut rng = Rng(11);
        for _ in 0..5_000 {
            let index = WAD + rng.below(9 * WAD); // 1.0 to 10.0
            let amount = 1 + rng.below(10u128.pow(17)); // up to $100 billion
            let scaled = scaled_for_loan(amount, index).unwrap();
            let owed = debt(scaled, index).unwrap();
            assert!(owed >= amount);
            assert!(owed - amount <= index / WAD + 1, "rounding cost more than one scaled unit");
            assert!(scaled_for_repayment(owed, index).unwrap() <= scaled + 1);
            assert!(scaled_for_repayment(amount, index).unwrap() <= scaled);
        }
    }

    #[test]
    fn property_partial_repayments_never_clear_more_than_they_pay() {
        let mut rng = Rng(13);
        for _ in 0..5_000 {
            let index = WAD + rng.below(4 * WAD);
            let mut scaled = scaled_for_loan(1 + rng.below(10u128.pow(13)), index).unwrap();
            let mut paid = 0;
            let start = debt(scaled, index).unwrap();
            for _ in 0..5 {
                let owed = debt(scaled, index).unwrap();
                if owed <= 1 {
                    break;
                }
                let pay = 1 + rng.below(owed - 1);
                scaled -= scaled_for_repayment(pay, index).unwrap();
                paid += pay;
            }
            // What is still owed plus what was paid never drops below the original debt.
            assert!(debt(scaled, index).unwrap() + paid >= start);
        }
    }

    #[test]
    fn property_more_frequent_updates_never_earn_less_interest() {
        let mut rng = Rng(17);
        for _ in 0..500 {
            let rate = rng.below(pct(55) + 1);
            let dt = 1 + rng.below(YEAR_NS);
            let once = grow_index(WAD, rate, dt).unwrap();
            let steps = 1 + rng.below(20);
            let mut index = WAD;
            for _ in 0..steps {
                index = grow_index(index, rate, dt / steps).unwrap();
            }
            index = grow_index(index, rate, dt % steps).unwrap();
            assert!(index + 1 >= once, "splitting {dt} ns into {steps} updates earned less");
        }
    }

    #[test]
    fn property_tier_indices_keep_their_order() {
        // Preferred, Standard and Watch pay base + 1%, 2% and 5%; their indices must stay in that order.
        let mut rng = Rng(19);
        let mut idx = [WAD; 3];
        for _ in 0..1_000 {
            let base = base_rate(rng.below(WAD + 1), KINK, AT_KINK, AT_FULL).unwrap();
            let dt = rng.below(30 * 24 * 3_600 * 1_000_000_000);
            for (i, spread) in [pct(1), pct(2), pct(5)].into_iter().enumerate() {
                idx[i] = grow_index(idx[i], base + spread, dt).unwrap();
            }
            assert!(idx[0] <= idx[1] && idx[1] <= idx[2]);
        }
    }

    #[test]
    fn property_utilisation_stays_between_zero_and_one() {
        let mut rng = Rng(23);
        for _ in 0..5_000 {
            let capital = rng.below(10u128.pow(18));
            let loans = if capital == 0 { 0 } else { rng.below(capital + 1) };
            let u = utilisation(loans, capital).unwrap();
            assert!(u <= WAD);
            assert!(capital == 0 || u * capital >= loans * WAD, "utilisation rounded down");
        }
    }
}
