//! The outside lenders' arithmetic (FUNDING.md 6.3 to 6.5; INTERFACES.md 26): health factors, how much a lender can
//! lend at a cushion, what a top-up needs, and how a funding request splits between one lender and our pool.
//!
//! Pure integer functions on micro-USD and basis points, used by pb-risk's cushion rule and split and by
//! `backtest lender`. Nothing here is part of the reference-checked maths (`risk_engine_ref.py`).

/// The cushion levels, as health factors in bp (FUNDING.md 6.3). New lender borrowing stops at the target; under the
/// act level the engine plans a top-up (REBALANCE); under the now level the top-up is REBALANCE_NOW.
pub const TARGET_HF_BP: u32 = 15_000;
/// The act and now levels were 1.3 and 1.15 until 11 Nov. `backtest lender` showed that 1.15 leaves about four
/// minutes before a lender sells and that 1.3 doesn't cover a top-up that takes an hour, so the user chose these.
pub const ACT_HF_BP: u32 = 13_500;
pub const NOW_HF_BP: u32 = 12_000;
/// A lender part under $1 isn't worth a step: the split leaves it out.
pub const MIN_LENDER_MICRO: u128 = 1_000_000;

const BP: u128 = 10_000;

/// The health factor in bp: the collateral's value times the liquidation ratio, over the debt. `None` with no debt.
/// The lender liquidates under 10000. Capped at `u32::MAX`.
pub fn hf_bp(collateral_micro: u128, liq_bp: u32, owed_micro: u128) -> Option<u32> {
    if owed_micro == 0 {
        return None;
    }
    let hf = collateral_micro.saturating_mul(u128::from(liq_bp)) / owed_micro;
    Some(u32::try_from(hf).unwrap_or(u32::MAX))
}

/// The most the lender may be owed with this collateral at a cushion of `target_bp`, rounded down.
pub fn limit_micro(collateral_micro: u128, liq_bp: u32, target_bp: u32) -> u128 {
    if target_bp == 0 {
        return 0;
    }
    collateral_micro.saturating_mul(u128::from(liq_bp)) / u128::from(target_bp)
}

/// How much more the lender may lend with this collateral before the cushion falls under `target_bp`.
pub fn room_micro(collateral_micro: u128, liq_bp: u32, target_bp: u32, owed_micro: u128) -> u128 {
    limit_micro(collateral_micro, liq_bp, target_bp).saturating_sub(owed_micro)
}

/// A top-up by repaying: how much debt to repay to bring the cushion back to `target_bp`, rounded up. 0 if it is there.
pub fn repay_to_target_micro(collateral_micro: u128, liq_bp: u32, target_bp: u32, owed_micro: u128) -> u128 {
    owed_micro.saturating_sub(limit_micro(collateral_micro, liq_bp, target_bp))
}

/// A top-up by adding collateral: how much more collateral value brings the cushion back to `target_bp`, rounded up.
/// 0 if it is there, or if `liq_bp` is 0.
pub fn add_to_target_micro(collateral_micro: u128, liq_bp: u32, target_bp: u32, owed_micro: u128) -> u128 {
    if liq_bp == 0 {
        return 0;
    }
    let needed = owed_micro.saturating_mul(u128::from(target_bp)).div_ceil(u128::from(liq_bp));
    needed.saturating_sub(collateral_micro)
}

/// How far the collateral's price can fall, in bp of its price now, before the lender liquidates. `None` with no
/// debt; 0 if it already can.
pub fn fall_to_liquidation_bp(collateral_micro: u128, liq_bp: u32, owed_micro: u128) -> Option<u32> {
    let hf = u128::from(hf_bp(collateral_micro, liq_bp, owed_micro)?);
    if hf <= BP {
        return Some(0);
    }
    // The price may fall to 1/hf of itself: a fall of 1 - 10000/hf.
    Some((BP - BP * BP / hf) as u32)
}

/// Which source a funding request fills first (FUNDING.md 6.4). The operator sets it; `Cheapest` is the default.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Order {
    /// The lender first while its rate is under our pool's rate for the client's tier, our pool first otherwise.
    #[default]
    Cheapest,
    PoolFirst,
    LenderFirst,
}

impl Order {
    /// `"cheapest"`, `"pool_first"` or `"lender_first"`, as the pool's `get_params().funding.order` writes it.
    pub fn parse(s: &str) -> Option<Order> {
        match s {
            "cheapest" => Some(Order::Cheapest),
            "pool_first" => Some(Order::PoolFirst),
            "lender_first" => Some(Order::LenderFirst),
            _ => None,
        }
    }
}

/// One lender the request may use: how much it can lend this account now (after the cushion, the permission's rate
/// ceiling and what the lender has free), and its rate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    pub lender: String,
    pub room_micro: u128,
    pub rate_bp: u32,
}

/// A funding request's split: at most one lender, and our pool.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Split {
    /// The lender and its part (micro-USD), if it has one.
    pub lender: Option<(String, u128)>,
    pub pool_micro: u128,
}

impl Split {
    pub fn total_micro(&self) -> u128 {
        self.pool_micro + self.lender.as_ref().map_or(0, |(_, x)| *x)
    }
}

/// FUNDING.md 6.4: splits a request of `ask_micro`.
/// - The whole can't pass `risk_room_micro`, what the book can carry at all.
/// - Our pool's part can't pass `pool_room_micro`, what our pool's own caps allow.
/// - One lender at most: the cheapest with room, the first of `sources` on a tie.
/// - `order` says which fills first; `Cheapest` compares the lender's rate with `pool_rate_bp`.
/// - A lender part under [`MIN_LENDER_MICRO`] is left out.
pub fn split(
    ask_micro: u128,
    risk_room_micro: u128,
    pool_room_micro: u128,
    pool_rate_bp: u32,
    sources: &[Source],
    order: Order,
) -> Split {
    let total = ask_micro.min(risk_room_micro);
    let best = sources
        .iter()
        .filter(|s| s.room_micro >= MIN_LENDER_MICRO)
        .fold(None::<&Source>, |best, s| match best {
            Some(b) if b.rate_bp <= s.rate_bp => Some(b),
            _ => Some(s),
        });
    let Some(best) = best else {
        return Split { lender: None, pool_micro: total.min(pool_room_micro) };
    };
    let lender_first = match order {
        Order::LenderFirst => true,
        Order::PoolFirst => false,
        Order::Cheapest => best.rate_bp < pool_rate_bp,
    };
    let (from_lender, from_pool) = if lender_first {
        let l = total.min(best.room_micro);
        (l, (total - l).min(pool_room_micro))
    } else {
        let p = total.min(pool_room_micro);
        ((total - p).min(best.room_micro), p)
    };
    if from_lender < MIN_LENDER_MICRO {
        // Too small for a lender step. Our pool takes what it can of the whole.
        return Split { lender: None, pool_micro: total.min(pool_room_micro) };
    }
    Split { lender: Some((best.lender.clone(), from_lender)), pool_micro: from_pool }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USD: u128 = 1_000_000;

    fn source(lender: &str, room: u128, rate_bp: u32) -> Source {
        Source { lender: lender.into(), room_micro: room, rate_bp }
    }

    #[test]
    fn the_worked_examples_cushions() {
        // $100,000 of bitcoin. Rhea liquidates at 76% of it, Aave's test market at 83%, Aave on Ethereum at 85%.
        let c = 100_000 * USD;
        assert_eq!(limit_micro(c, 7_600, 15_000), 50_666_666_666);
        assert_eq!(limit_micro(c, 8_500, 15_000), 56_666_666_666);
        assert_eq!(room_micro(c, 7_600, 15_000, 20_000 * USD), 30_666_666_666);
        assert_eq!(room_micro(c, 7_600, 15_000, 60_000 * USD), 0);
        assert_eq!(hf_bp(c, 7_600, 50_666_666_666), Some(15_000));
        assert_eq!(hf_bp(c, 7_600, 76_000 * USD), Some(10_000));
        assert_eq!(hf_bp(c, 7_600, 0), None);
        // At a cushion of 1.5, bitcoin must fall by a third before the lender sells.
        assert_eq!(fall_to_liquidation_bp(c, 7_600, 50_666_666_666), Some(3_334));
        assert_eq!(fall_to_liquidation_bp(c, 7_600, 80_000 * USD), Some(0));
        assert_eq!(fall_to_liquidation_bp(c, 7_600, 0), None);
    }

    #[test]
    fn a_top_up_brings_the_cushion_back_to_the_target() {
        // Bitcoin fell 20%: $80,000 of collateral against $50,667 owed at Rhea is a cushion of 1.2.
        let (c, d) = (80_000 * USD, 50_667 * USD);
        assert_eq!(hf_bp(c, 7_600, d), Some(11_999));
        let repay = repay_to_target_micro(c, 7_600, 15_000, d);
        assert_eq!(repay, 10_133_666_667);
        assert!(hf_bp(c, 7_600, d - repay).unwrap() >= 15_000);
        let add = add_to_target_micro(c, 7_600, 15_000, d);
        assert_eq!(add, 20_000_657_895);
        assert!(hf_bp(c + add, 7_600, d).unwrap() >= 15_000);
        assert_eq!(hf_bp(c + add - USD, 7_600, d), Some(14_999));
        // Already at the target: nothing to do.
        assert_eq!(repay_to_target_micro(100_000 * USD, 7_600, 15_000, d - USD), 0);
        assert_eq!(add_to_target_micro(100_000 * USD, 7_600, 15_000, d - USD), 0);
        assert_eq!(add_to_target_micro(c, 0, 15_000, d), 0);
    }

    #[test]
    fn the_cheaper_source_fills_first_and_our_pool_takes_the_rest() {
        // The worked example: a $94,500 line. Aave at 5.33% is cheaper than our 6.5%; Rhea at 15.91% is dearer.
        let (ask, line) = (94_500 * USD, 94_500 * USD);
        let aave = source("aave", 56_667 * USD, 533);
        let rhea = source("rhea", 50_667 * USD, 1_591);
        let s = split(ask, line, line, 650, &[aave.clone()], Order::Cheapest);
        assert_eq!(s, Split { lender: Some(("aave".into(), 56_667 * USD)), pool_micro: 37_833 * USD });
        assert_eq!(s.total_micro(), ask);
        // Rhea is dearer than our pool, so our pool fills first and Rhea isn't needed.
        let s = split(ask, line, line, 650, &[rhea.clone()], Order::Cheapest);
        assert_eq!(s, Split { lender: None, pool_micro: ask });
        // If our pool's own caps stop it at $40,000, Rhea takes the rest.
        let s = split(ask, line, 40_000 * USD, 650, &[rhea.clone()], Order::Cheapest);
        assert_eq!(s, Split { lender: Some(("rhea".into(), 50_667 * USD)), pool_micro: 40_000 * USD });
        assert_eq!(s.total_micro(), 90_667 * USD);
        // The operator can put the lender first whatever it costs.
        let s = split(ask, line, line, 650, &[rhea.clone()], Order::LenderFirst);
        assert_eq!(s, Split { lender: Some(("rhea".into(), 50_667 * USD)), pool_micro: 43_833 * USD });
        // Or our pool first, even when the lender is cheaper.
        let s = split(ask, line, 60_000 * USD, 650, &[aave.clone()], Order::PoolFirst);
        assert_eq!(s, Split { lender: Some(("aave".into(), 34_500 * USD)), pool_micro: 60_000 * USD });
        // With both, the cheaper lender is the one used.
        let s = split(ask, line, line, 650, &[rhea, aave], Order::LenderFirst);
        assert_eq!(s.lender, Some(("aave".into(), 56_667 * USD)));
    }

    #[test]
    fn the_whole_never_passes_what_the_book_can_carry() {
        let aave = source("aave", 56_667 * USD, 533);
        let s = split(94_500 * USD, 30_000 * USD, 94_500 * USD, 650, &[aave.clone()], Order::Cheapest);
        assert_eq!(s, Split { lender: Some(("aave".into(), 30_000 * USD)), pool_micro: 0 });
        let s = split(94_500 * USD, 0, 94_500 * USD, 650, &[aave], Order::Cheapest);
        assert_eq!(s, Split::default());
    }

    #[test]
    fn a_lender_with_no_room_or_a_part_under_a_dollar_is_left_out() {
        let none = source("aave", 0, 533);
        let s = split(1_000 * USD, 1_000 * USD, 1_000 * USD, 650, &[none], Order::LenderFirst);
        assert_eq!(s, Split { lender: None, pool_micro: 1_000 * USD });
        // Our pool fills $999.50 first; the 50 cents left isn't worth a lender step, so our pool takes it too.
        let rhea = source("rhea", 500 * USD, 1_591);
        let s = split(1_000 * USD, 1_000 * USD, 1_000 * USD - 500_000, 650, &[rhea.clone()], Order::PoolFirst);
        assert_eq!(s, Split { lender: None, pool_micro: 1_000 * USD - 500_000 });
        // A tie on rate goes to the first source listed.
        let aave = source("aave", 500 * USD, 1_591);
        let s = split(400 * USD, 400 * USD, 0, 650, &[aave, rhea], Order::LenderFirst);
        assert_eq!(s.lender, Some(("aave".into(), 400 * USD)));
        assert_eq!(Order::parse("lender_first"), Some(Order::LenderFirst));
        assert_eq!(Order::parse("cheapest"), Some(Order::Cheapest));
        assert_eq!(Order::parse("pool_first"), Some(Order::PoolFirst));
        assert_eq!(Order::parse("fastest"), None);
    }
}
