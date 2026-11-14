//! RISK_ENGINE.md 3.2–3.3: the market inputs from raw readings: a coin's reference price (the median of up to
//! six fresh sources), its 1-hour TWAP, and π for wrapped tokens and USDT.
//!
//! The Python reference takes these as given (its `Market`), so this module follows the spec's text, and its
//! tests come from it. Where the text leaves a choice, the choice is noted. The caller (pb-risk) fetches the
//! readings, keeps their history, and builds the [`crate::Market`] from what these functions return.

/// A source is valid while its reading is at most this old (seconds).
pub const MAX_AGE_S: f64 = 10.0;
/// Pyth's confidence interval may be at most this share of its price.
pub const MAX_PYTH_CONF: f64 = 0.005;
/// A reference price needs at least this many valid sources.
pub const MIN_SOURCES: usize = 3;
/// With no valid source for this long (seconds), the coin is PRICE_STALE.
pub const STALE_AFTER_S: f64 = 60.0;
/// π when a wrapper has had no reading for 60 s: the extreme depeg (and the token goes reduce-only).
pub const PI_NO_READING: f64 = 0.80;

/// One source's latest price for a coin.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Reading {
    pub price: f64,
    pub age_s: f64,
    /// Pyth's confidence interval, in price units; `None` for exchanges.
    pub conf: Option<f64>,
}

impl Reading {
    /// valid(source) = age ≤ 10 s, and for Pyth confidence ≤ 0.5% of price.
    pub fn is_valid(&self) -> bool {
        self.price > 0.0
            && self.age_s <= MAX_AGE_S
            && self.conf.is_none_or(|c| c <= MAX_PYTH_CONF * self.price)
    }
}

/// What 3.2 says the engine may do with a coin's price.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PriceStatus {
    /// At least 3 valid sources and at most one outlier.
    Fresh,
    /// Fewer than 3 valid sources, or more than one outlier: no new risk in the coin, and allowance equity
    /// values longs at `low` and shorts at `high`.
    Uncertain,
    /// No valid source for 60 s: accounts holding the coin are frozen to risk-reducing actions.
    Stale,
}

/// A coin's reference price.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RefPrice {
    /// The median of the valid sources, if any is valid.
    pub price: Option<f64>,
    pub status: PriceStatus,
    /// The lowest and highest valid sources.
    pub low: Option<f64>,
    pub high: Option<f64>,
    pub valid: usize,
    pub outliers: usize,
}

/// The middle value; for an even count, the mean of the two middle values (the spec doesn't say; this is
/// the usual median, as Python's `statistics.median`). `None` for no values.
pub fn median(values: &[f64]) -> Option<f64> {
    let mut v: Vec<f64> = values.iter().copied().filter(|x| !x.is_nan()).collect();
    if v.is_empty() {
        return None;
    }
    v.sort_by(f64::total_cmp);
    let n = v.len();
    Some(if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    })
}

/// δ: the distance from the median past which a source is an outlier, by coin tier (5.2).
pub fn outlier_distance(tier: u8) -> f64 {
    match tier {
        1 => 0.01,
        2 => 0.02,
        _ => 0.03,
    }
}

/// 3.2: P_g from the latest reading of each source. `secs_without_valid` is how long the coin has had no
/// valid source (0 if it has one now); the caller keeps that clock, since the engine has none.
pub fn reference_price(readings: &[Reading], tier: u8, secs_without_valid: f64) -> RefPrice {
    let valid: Vec<f64> = readings
        .iter()
        .filter(|r| r.is_valid())
        .map(|r| r.price)
        .collect();
    let price = median(&valid);
    let delta = outlier_distance(tier);
    let outliers = price.map_or(0, |p| {
        valid
            .iter()
            .filter(|&&s| (s / p - 1.0).abs() > delta)
            .count()
    });
    let status = if valid.is_empty() && secs_without_valid >= STALE_AFTER_S {
        PriceStatus::Stale
    } else if valid.len() < MIN_SOURCES || outliers > 1 {
        PriceStatus::Uncertain
    } else {
        PriceStatus::Fresh
    };
    let low = valid.iter().copied().reduce(f64::min);
    let high = valid.iter().copied().reduce(f64::max);
    RefPrice {
        price,
        status,
        low,
        high,
        valid: valid.len(),
        outliers,
    }
}

/// 3.2: P̄_g, the time-weighted average over the last 60 minutes of the per-minute median of the 1-minute
/// closes on Binance, OKX and Bybit. `minutes` holds each minute's closes (any that exist); with equal
/// 1-minute bars the time weights are equal. Minutes with no close are skipped. `None` if there are none.
pub fn twap(minutes: &[Vec<f64>]) -> Option<f64> {
    let medians: Vec<f64> = minutes.iter().filter_map(|closes| median(closes)).collect();
    if medians.is_empty() {
        return None;
    }
    Some(crate::py::sum(medians.iter().copied()) / medians.len() as f64)
}

/// 3.3: π_j from one committed 1Click quote for selling an hour of capacity: never above 1, because a wrapper
/// is never worth more to us than what it wraps.
pub fn pi(quote_ratio: f64) -> f64 {
    quote_ratio.min(1.0)
}

/// 3.3: π_state, the 15-minute median of π (states and mark equity). `last_15_min` are the readings of the
/// last 15 minutes; `secs_since_reading` is the age of the newest. No reading for 60 s gives 0.80.
pub fn pi_state(last_15_min: &[f64], secs_since_reading: f64) -> f64 {
    if secs_since_reading >= STALE_AFTER_S {
        return PI_NO_READING;
    }
    median(&last_15_min.iter().map(|&q| pi(q)).collect::<Vec<_>>()).unwrap_or(PI_NO_READING)
}

/// 3.3: π_allow, the lowest π of the last hour (allowances and new credit); 0 while the operator has frozen
/// the token; 0.80 with no reading for 60 s.
pub fn pi_allow(last_hour: &[f64], secs_since_reading: f64, frozen: bool) -> f64 {
    if frozen {
        return 0.0;
    }
    if secs_since_reading >= STALE_AFTER_S {
        return PI_NO_READING;
    }
    last_hour
        .iter()
        .map(|&q| pi(q))
        .reduce(f64::min)
        .unwrap_or(PI_NO_READING)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh(price: f64) -> Reading {
        Reading {
            price,
            age_s: 2.0,
            conf: None,
        }
    }

    #[test]
    fn the_median_of_fresh_sources_ignores_one_silly_print() {
        let r = reference_price(
            &[
                fresh(100.0),
                fresh(100.2),
                fresh(99.9),
                fresh(150.0),
                fresh(100.1),
            ],
            1,
            0.0,
        );
        assert_eq!(r.price, Some(100.1));
        assert_eq!(r.status, PriceStatus::Fresh);
        assert_eq!(r.outliers, 1);
    }

    #[test]
    fn too_few_sources_or_two_outliers_make_the_price_uncertain() {
        let old = Reading {
            price: 100.0,
            age_s: 11.0,
            conf: None,
        };
        let wide_pyth = Reading {
            price: 100.0,
            age_s: 1.0,
            conf: Some(0.6),
        };
        let r = reference_price(&[fresh(100.0), fresh(100.1), old, wide_pyth], 1, 0.0);
        assert_eq!((r.valid, r.status), (2, PriceStatus::Uncertain));
        let r = reference_price(
            &[
                fresh(100.0),
                fresh(100.1),
                fresh(100.2),
                fresh(90.0),
                fresh(110.0),
            ],
            2,
            0.0,
        );
        assert_eq!((r.outliers, r.status), (2, PriceStatus::Uncertain));
        assert_eq!((r.low, r.high), (Some(90.0), Some(110.0)));
    }

    #[test]
    fn no_valid_source_for_a_minute_is_stale() {
        let old = Reading {
            price: 100.0,
            age_s: 75.0,
            conf: None,
        };
        assert_eq!(
            reference_price(&[old], 1, 59.0).status,
            PriceStatus::Uncertain
        );
        assert_eq!(reference_price(&[old], 1, 60.0).status, PriceStatus::Stale);
    }

    #[test]
    fn twap_averages_the_per_minute_medians() {
        let minutes = vec![
            vec![100.0, 101.0, 130.0],
            vec![102.0, 102.0],
            vec![],
            vec![99.0],
        ];
        // medians 101, 102, (skipped), 99
        assert_eq!(twap(&minutes), Some(302.0 / 3.0));
        assert_eq!(twap(&[]), None);
    }

    #[test]
    fn pi_is_capped_at_one_and_credit_takes_the_hour_low() {
        assert_eq!(pi(1.003), 1.0);
        assert_eq!(pi_state(&[0.99, 1.02, 0.97], 5.0), 0.99);
        assert_eq!(pi_allow(&[0.99, 1.02, 0.97], 5.0, false), 0.97);
        assert_eq!(pi_allow(&[0.99], 5.0, true), 0.0);
        assert_eq!(pi_state(&[0.99], 60.0), PI_NO_READING);
    }
}
