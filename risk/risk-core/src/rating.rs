//! RISK_ENGINE.md 6: the client rating. Everyone starts at 650; points come from how hedged the book is, months
//! in good standing with a loan, a proven Hyperliquid track record, and KYB. The score picks the tier. Ports
//! `hedge_ratio`, `score` and `tier_of`.
use crate::params::{token, ClientTier};
use crate::py;
use crate::snapshot::{Account, Market};
use crate::Engine;

/// What the score is computed from (the reference's keyword arguments). The account contract keeps the
/// counters and the hourly record; the averages come from that record.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScoreInputs {
    pub hr_now: f64,
    /// 7-day average of the hedge ratio.
    pub hr_avg7d: f64,
    /// Months in good standing, counted only with a loan outstanding.
    pub good_months: i64,
    pub forced_unwinds_12m: i64,
    pub forced_unwinds_older: i64,
    pub defaults: i64,
    /// Age of the linked Hyperliquid address, in months.
    pub linked_months: i64,
    pub linked_liqs_12m: i64,
    pub linked_fills: i64,
    pub linked_volume: f64,
    pub kyb: bool,
    /// Gross coin exposure / equity, 7-day average: hedge points need a real book.
    pub exposure_share: f64,
}

impl ScoreInputs {
    /// A new client with this hedge ratio now and over the week, and nothing else on record.
    pub fn new(hr_now: f64, hr_avg7d: f64) -> ScoreInputs {
        ScoreInputs {
            hr_now,
            hr_avg7d,
            good_months: 0,
            forced_unwinds_12m: 0,
            forced_unwinds_older: 0,
            defaults: 0,
            linked_months: 0,
            linked_liqs_12m: 0,
            linked_fills: 0,
            linked_volume: 0.0,
            kyb: false,
            exposure_share: 1.0,
        }
    }
}

/// The score, from 300 to 1000; 300 after any default.
pub fn score(i: &ScoreInputs) -> i64 {
    if i.defaults != 0 {
        return 300;
    }
    let hr = py::min(i.hr_now, i.hr_avg7d);
    let mut s = 650;
    if i.exposure_share >= 0.25 {
        s += if hr >= 0.8 {
            50
        } else if hr < 0.3 {
            -100
        } else {
            0
        };
    }
    s += (10 * i.good_months).min(100);
    s -= 75 * i.forced_unwinds_12m + 35 * i.forced_unwinds_older;
    if i.linked_months >= 6
        && i.linked_liqs_12m == 0
        && i.linked_fills >= 50
        && i.linked_volume >= 1e6
    {
        s += 100;
    }
    s -= (50 * i.linked_liqs_12m).min(150);
    if i.kyb {
        s += 100;
    }
    s.clamp(300, 1000)
}

/// The tier for a score. Preferred needs a KYB record as well as the score.
pub fn tier_of(score: i64, kyb: bool) -> ClientTier {
    if score >= 800 && kyb {
        ClientTier::Preferred
    } else if score >= 600 {
        ClientTier::Standard
    } else {
        ClientTier::Watch
    }
}

impl Engine {
    /// 1 − Σ_g |Σ legs of g| / Σ_g Σ |legs of g|, legs in USDC; 1 if the account holds no coins.
    pub fn hedge_ratio(&self, a: &Account, m: &Market) -> f64 {
        let (mut gross, mut net) = (0.0, 0.0);
        for g in self.groups(a) {
            let mut legs: Vec<f64> = a
                .near
                .iter()
                .filter(|(t, _)| token(t).group == Some(g.as_str()))
                .map(|(t, &u)| u * m.wrap_ratio(t) * m.price(&g))
                .collect();
            let q = a.perps.get_or(&g, 0.0);
            if q != 0.0 {
                legs.push(q * m.mark_price(&g));
            }
            gross += py::sum(legs.iter().map(|x| x.abs()));
            net += py::sum(legs.iter().copied()).abs();
        }
        if gross == 0.0 {
            1.0
        } else {
            1.0 - net / gross
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scores_of_section_13_8() {
        let hedged = ScoreInputs::new(1.0, 1.0);
        assert_eq!(score(&hedged), 700);
        assert_eq!(
            score(&ScoreInputs {
                kyb: true,
                ..hedged
            }),
            800
        );
        assert_eq!(
            score(&ScoreInputs {
                defaults: 1,
                kyb: true,
                ..hedged
            }),
            300
        );
        assert_eq!(tier_of(800, false), ClientTier::Standard);
        assert_eq!(tier_of(800, true), ClientTier::Preferred);
        assert_eq!(tier_of(550, true), ClientTier::Watch);
    }
}
