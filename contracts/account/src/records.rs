//! The records each accepted verdict updates, which the engine reads back on the next check (PLAN.md 5.1):
//! - the margin-call clock (RISK_ENGINE.md 8.1);
//! - the two-check rule for DELEVERAGE plans (8.1);
//! - the hourly hedge record (6).
//!
//! Times are block timestamps in nanoseconds, taken when the verdict arrives. Every list is bounded, and nothing
//! here panics, because `on_verdict` calls it.
use near_sdk::json_types::U64;
use near_sdk::near;

pub const MINUTE_NS: u64 = 60 * 1_000_000_000;
pub const HOUR_NS: u64 = 60 * MINUTE_NS;
pub const DAY_NS: u64 = 24 * HOUR_NS;
/// The margin-call clock keeps at most this many intervals.
pub const MAX_INTERVALS: usize = 48;
/// A second DELEVERAGE verdict confirms the plan if it arrives 2 to 5 minutes after the first.
pub const CONFIRM_AFTER_NS: u64 = 2 * MINUTE_NS;
pub const CONFIRM_WITHIN_NS: u64 = 5 * MINUTE_NS;
/// From this Hyperliquid margin ratio (80%) a DELEVERAGE plan is confirmed at once.
pub const CONFIRM_AT_ONCE_BP: u64 = 8_000;
/// The hourly record keeps 7 days.
pub const KEEP_HOURS: u64 = 7 * 24;

/// The margin-call clock: the time spent below the buffer over the last 24 hours, so dipping in and out doesn't
/// reset it.
/// - `since`: when the current margin call started, as the latest verdict says (0 if none).
/// - `below`: whether the latest verdict was below the buffer. While it is, the last interval is still open, and the
///   time since its end counts as below too.
/// - `intervals`: [start, end] times below the buffer, oldest first, clipped to the last 24 hours.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MarginCall {
    pub since: U64,
    pub below: bool,
    pub intervals: Vec<(U64, U64)>,
}

impl MarginCall {
    /// Adds a verdict that arrived at `now`, saying whether equity is below the buffer.
    pub fn record(&mut self, now: u64, below: bool, since: u64) {
        // Between two verdicts, the time counts as below if the earlier one said so.
        if self.below {
            if let Some(last) = self.intervals.last_mut() {
                last.1 = U64(now.max(last.1 .0));
            }
        }
        if below && !self.below {
            self.intervals.push((U64(now), U64(now)));
        }
        self.below = below;
        self.since = U64(since);
        let cutoff = now.saturating_sub(DAY_NS);
        self.intervals.retain_mut(|(start, end)| {
            start.0 = start.0.max(cutoff);
            end.0 >= cutoff
        });
        if self.intervals.len() > MAX_INTERVALS {
            merge_closest(&mut self.intervals);
        }
    }

    /// The time below the buffer in the 24 hours up to `now`, counting an open interval up to `now`.
    pub fn total(&self, now: u64) -> u64 {
        let cutoff = now.saturating_sub(DAY_NS);
        let n = self.intervals.len();
        self.intervals
            .iter()
            .enumerate()
            .map(|(i, (start, end))| {
                let end = if self.below && i + 1 == n { now } else { end.0 };
                end.saturating_sub(start.0.max(cutoff))
            })
            .fold(0, u64::saturating_add)
    }
}

/// Merges the two neighbouring intervals with the smallest gap. Counting that gap as time below overstates the
/// clock a little, which errs on the pool's side.
fn merge_closest(intervals: &mut Vec<(U64, U64)>) {
    let gap = |i: usize| intervals[i + 1].0 .0.saturating_sub(intervals[i].1 .0);
    let Some(i) = (0..intervals.len().saturating_sub(1)).min_by_key(|&i| gap(i)) else { return };
    intervals[i].1 = intervals[i + 1].1;
    intervals.remove(i + 1);
}

/// The two-check rule: a DELEVERAGE plan is confirmed only by a second DELEVERAGE verdict 2 to 5 minutes after the
/// first, so one bad price can't start an unwind. When Hyperliquid's margin ratio is 80% or more, the plan is
/// confirmed at once. Any other action clears the record. The account stores the confirming verdict's plan
/// (`plan.rs`), and only a stored plan runs.
///
/// DEFAULT keeps a record of its own with the same rule (`confirm`), never at once: only a second DEFAULT verdict 2 to
/// 5 minutes after the first blocks the account and has the pool write off its debt (research/audit.md, A2).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Deleverage {
    /// When the first verdict of the current pair arrived, or 0.
    pub first_at: u64,
}

impl Deleverage {
    /// Adds a verdict that arrived at `now`, and returns whether it confirms its DELEVERAGE plan.
    pub fn record(&mut self, now: u64, deleverage: bool, hl_ratio_bp: u64) -> bool {
        self.confirm(now, deleverage, hl_ratio_bp >= CONFIRM_AT_ONCE_BP)
    }

    /// The rule itself: adds a verdict that arrived at `now` and says what the record counts (`seen`), and returns
    /// whether it confirms the first one, or confirms `at_once`. A verdict that doesn't say it clears the record.
    pub fn confirm(&mut self, now: u64, seen: bool, at_once: bool) -> bool {
        if !seen {
            *self = Self::default();
            return false;
        }
        let waited = now.saturating_sub(self.first_at);
        let second = self.first_at != 0 && (CONFIRM_AFTER_NS..=CONFIRM_WITHIN_NS).contains(&waited);
        if at_once || second {
            // This verdict also opens the next pair, so each new plan of a running unwind is confirmed in turn.
            self.first_at = now;
            return true;
        }
        if self.first_at == 0 || waited > CONFIRM_WITHIN_NS {
            // The first check of a pair, or a new start after a first check that has gone stale.
            self.first_at = now;
        }
        // Otherwise it is too soon after the first check: wait for a later one.
        false
    }
}

/// One hour of the hedge record (RISK_ENGINE.md 6): the lowest hedge ratio and the highest share of equity in coins
/// seen that hour. `hour` counts hours since 1970.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct HourRecord {
    pub hour: u64,
    pub hr_bp_min: u32,
    pub exp_bp_max: u64,
}

/// Adds a verdict that arrived at `now` to the hourly record, which keeps the last 7 days (at most 168 hours).
pub fn record_hour(hourly: &mut Vec<HourRecord>, now: u64, hr_bp: u32, exp_bp: u64) {
    let hour = now / HOUR_NS;
    match hourly.last_mut() {
        Some(h) if h.hour == hour => {
            h.hr_bp_min = h.hr_bp_min.min(hr_bp);
            h.exp_bp_max = h.exp_bp_max.max(exp_bp);
        }
        _ => hourly.push(HourRecord { hour, hr_bp_min: hr_bp, exp_bp_max: exp_bp }),
    }
    hourly.retain(|h| h.hour + KEEP_HOURS > hour);
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_000 * DAY_NS;

    fn spans(m: &MarginCall) -> Vec<(u64, u64)> {
        m.intervals.iter().map(|(s, e)| (s.0, e.0)).collect()
    }

    #[test]
    fn the_clock_counts_time_below_the_buffer_between_verdicts() {
        let mut m = MarginCall::default();
        m.record(T0, false, 0);
        assert!(m.intervals.is_empty());
        // Below at T0+1h: the hour before counts as above, because the earlier verdict said so.
        m.record(T0 + HOUR_NS, true, T0 + HOUR_NS);
        assert_eq!(spans(&m), vec![(T0 + HOUR_NS, T0 + HOUR_NS)]);
        assert_eq!(m.since.0, T0 + HOUR_NS);
        // Still below an hour later: the interval grows.
        m.record(T0 + 2 * HOUR_NS, true, T0 + HOUR_NS);
        // Back above after 30 minutes more: those 30 minutes count as below, then the interval closes.
        m.record(T0 + 2 * HOUR_NS + 30 * MINUTE_NS, false, T0 + HOUR_NS);
        assert_eq!(spans(&m), vec![(T0 + HOUR_NS, T0 + 2 * HOUR_NS + 30 * MINUTE_NS)]);
        assert!(!m.below);
        assert_eq!(m.total(T0 + 5 * HOUR_NS), HOUR_NS + 30 * MINUTE_NS);
    }

    #[test]
    fn dipping_in_and_out_adds_up_instead_of_resetting() {
        let mut m = MarginCall::default();
        for i in 0..4 {
            let t = T0 + i * HOUR_NS;
            m.record(t, true, T0);
            m.record(t + 30 * MINUTE_NS, false, T0);
        }
        assert_eq!(m.intervals.len(), 4);
        assert_eq!(m.total(T0 + 5 * HOUR_NS), 2 * HOUR_NS);
    }

    #[test]
    fn an_open_interval_counts_up_to_now() {
        let mut m = MarginCall::default();
        m.record(T0, true, T0);
        assert_eq!(m.total(T0 + 3 * HOUR_NS), 3 * HOUR_NS);
    }

    #[test]
    fn the_clock_keeps_only_the_last_24_hours() {
        let mut m = MarginCall::default();
        m.record(T0, true, T0);
        m.record(T0 + HOUR_NS, false, 0);
        // A day and a half later, the old interval is gone.
        m.record(T0 + DAY_NS + 12 * HOUR_NS, true, T0 + DAY_NS + 12 * HOUR_NS);
        assert_eq!(spans(&m), vec![(T0 + DAY_NS + 12 * HOUR_NS, T0 + DAY_NS + 12 * HOUR_NS)]);
        // An interval that started more than 24 hours ago is clipped to the window.
        let mut m = MarginCall::default();
        m.record(T0, true, T0);
        m.record(T0 + 30 * HOUR_NS, true, T0);
        assert_eq!(spans(&m), vec![(T0 + 6 * HOUR_NS, T0 + 30 * HOUR_NS)]);
        assert_eq!(m.total(T0 + 30 * HOUR_NS), DAY_NS);
    }

    #[test]
    fn too_many_dips_merge_the_closest_pair() {
        let mut m = MarginCall::default();
        for i in 0..=MAX_INTERVALS as u64 {
            // Each dip lasts a minute; the gap after dip 5 is the shortest.
            let t = T0 + i * 10 * MINUTE_NS - if i > 5 { 5 * MINUTE_NS } else { 0 };
            m.record(t, true, T0);
            m.record(t + MINUTE_NS, false, T0);
        }
        assert_eq!(m.intervals.len(), MAX_INTERVALS);
        // Dips 5 and 6 became one interval, from dip 5's start to dip 6's end.
        let start5 = T0 + 50 * MINUTE_NS;
        let end6 = T0 + 60 * MINUTE_NS - 5 * MINUTE_NS + MINUTE_NS;
        assert_eq!(spans(&m)[5], (start5, end6));
    }

    #[test]
    fn a_deleverage_plan_needs_a_second_verdict_2_to_5_minutes_later() {
        let mut d = Deleverage::default();
        assert!(!d.record(T0, true, 0));
        assert_eq!(d.first_at, T0);
        // A minute later is too soon: still waiting, and the first check stands.
        assert!(!d.record(T0 + MINUTE_NS, true, 0));
        assert_eq!(d.first_at, T0);
        // Three minutes after the first: confirmed, and this verdict opens the next pair.
        assert!(d.record(T0 + 3 * MINUTE_NS, true, 0));
        assert_eq!(d.first_at, T0 + 3 * MINUTE_NS);
        // Exactly 2 and exactly 5 minutes count.
        let mut d = Deleverage::default();
        d.record(T0, true, 0);
        assert!(d.record(T0 + CONFIRM_AFTER_NS, true, 0));
        assert!(d.record(T0 + CONFIRM_AFTER_NS + CONFIRM_WITHIN_NS, true, 0));
    }

    #[test]
    fn a_first_check_older_than_5_minutes_starts_again() {
        let mut d = Deleverage::default();
        d.record(T0, true, 0);
        assert!(!d.record(T0 + 6 * MINUTE_NS, true, 0));
        assert_eq!(d.first_at, T0 + 6 * MINUTE_NS);
    }

    #[test]
    fn at_an_80_percent_hyperliquid_margin_ratio_the_plan_is_confirmed_at_once() {
        let mut d = Deleverage::default();
        assert!(!d.record(T0, true, 7_999));
        let mut d = Deleverage::default();
        assert!(d.record(T0, true, 8_000));
        assert_eq!(d.first_at, T0);
    }

    #[test]
    fn the_same_rule_without_at_once_needs_two_verdicts_2_to_5_minutes_apart() {
        // DEFAULT's record: never confirmed by one verdict, whatever else it says.
        let mut d = Deleverage::default();
        assert!(!d.confirm(T0, true, false));
        assert!(!d.confirm(T0 + MINUTE_NS, true, false), "a minute later is too soon");
        assert!(d.confirm(T0 + CONFIRM_AFTER_NS, true, false), "2 minutes after the first confirms");
        let mut d = Deleverage::default();
        d.confirm(T0, true, false);
        assert!(d.confirm(T0 + CONFIRM_WITHIN_NS, true, false), "5 minutes after the first confirms");
        let mut d = Deleverage::default();
        d.confirm(T0, true, false);
        assert!(!d.confirm(T0 + CONFIRM_WITHIN_NS + 1, true, false), "past 5 minutes, it starts a new pair");
        assert_eq!(d.first_at, T0 + CONFIRM_WITHIN_NS + 1);
        // Anything else in between starts again.
        let mut d = Deleverage::default();
        d.confirm(T0, true, false);
        assert!(!d.confirm(T0 + MINUTE_NS, false, false));
        assert!(!d.confirm(T0 + 3 * MINUTE_NS, true, false));
    }

    #[test]
    fn any_other_action_clears_the_record() {
        let mut d = Deleverage::default();
        d.record(T0, true, 0);
        assert!(!d.record(T0 + 3 * MINUTE_NS, false, 9_000));
        assert_eq!(d, Deleverage::default());
    }

    #[test]
    fn the_hourly_record_keeps_the_worst_values_of_each_hour_for_7_days() {
        let mut h = Vec::new();
        record_hour(&mut h, T0, 9_000, 40_000);
        record_hour(&mut h, T0 + 10 * MINUTE_NS, 8_000, 30_000);
        record_hour(&mut h, T0 + 20 * MINUTE_NS, 9_500, 50_000);
        let hour = T0 / HOUR_NS;
        assert_eq!(h, vec![HourRecord { hour, hr_bp_min: 8_000, exp_bp_max: 50_000 }]);
        record_hour(&mut h, T0 + HOUR_NS, 10_000, 0);
        assert_eq!(h.len(), 2);
        // A week later only the hours of the last 7 days remain.
        record_hour(&mut h, T0 + KEEP_HOURS * HOUR_NS, 10_000, 0);
        assert_eq!(h.iter().map(|r| r.hour).collect::<Vec<_>>(), vec![hour + 1, hour + KEEP_HOURS]);
        // A check every hour for a long time still keeps at most 168 hours.
        for i in KEEP_HOURS..KEEP_HOURS * 3 {
            record_hour(&mut h, T0 + i * HOUR_NS, 10_000, 0);
        }
        assert_eq!(h.len(), KEEP_HOURS as usize);
    }
}
