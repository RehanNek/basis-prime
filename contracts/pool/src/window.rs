//! A rolling 24-hour total, kept as hourly buckets (for the daily lending budget and each account's plan steps).
//!
//! It keeps the current bucket and the 24 before it, so an amount stays counted for at least the whole window: between
//! 24 and 25 hours. That errs on the safe side for loans and plan steps, which is what the limits care about.
use near_sdk::near;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Window {
    /// (bucket number, total in that bucket), oldest first; at most `KEEP` entries.
    buckets: Vec<(u64, i128)>,
}

impl Window {
    /// The current bucket plus the 24 before it.
    const KEEP: u64 = 25;

    /// Adds `amount` (negative to subtract) at time `now`, with buckets of `bucket_ns`.
    pub fn add(&mut self, now: u64, bucket_ns: u64, amount: i128) {
        let current = now / bucket_ns;
        self.buckets.retain(|(b, _)| b + Self::KEEP > current);
        match self.buckets.last_mut() {
            Some((b, sum)) if *b == current => *sum = sum.saturating_add(amount),
            _ => self.buckets.push((current, amount)),
        }
    }

    /// Takes `amount` back out of the bucket that time `at` fell in, if that bucket is still kept.
    pub fn undo(&mut self, at: u64, bucket_ns: u64, amount: i128) {
        let target = at / bucket_ns;
        if let Some((_, sum)) = self.buckets.iter_mut().find(|(b, _)| *b == target) {
            *sum = sum.saturating_sub(amount);
        }
    }

    /// The total over the window ending at `now`.
    pub fn total(&self, now: u64, bucket_ns: u64) -> i128 {
        let current = now / bucket_ns;
        self.buckets.iter().filter(|(b, _)| b + Self::KEEP > current).fold(0, |acc, (_, sum)| acc.saturating_add(*sum))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: u64 = 3_600;

    #[test]
    fn adds_up_within_the_window() {
        let mut w = Window::default();
        w.add(0, HOUR, 10);
        w.add(HOUR / 2, HOUR, 5);
        w.add(3 * HOUR, HOUR, -3);
        assert_eq!(w.total(3 * HOUR, HOUR), 12);
    }

    #[test]
    fn an_amount_counts_for_at_least_24_hours_then_drops_out() {
        let mut w = Window::default();
        w.add(HOUR - 1, HOUR, 7); // the last moment of bucket 0
        assert_eq!(w.total(24 * HOUR + HOUR - 1, HOUR), 7, "dropped before 24 hours had passed");
        assert_eq!(w.total(25 * HOUR, HOUR), 0, "kept past 25 hours");
    }

    #[test]
    fn never_keeps_more_than_25_buckets() {
        let mut w = Window::default();
        for h in 0..100 {
            w.add(h * HOUR, HOUR, 1);
        }
        assert_eq!(w.buckets.len(), 25);
        assert_eq!(w.total(99 * HOUR, HOUR), 25);
    }

    #[test]
    fn undo_takes_an_amount_back_from_its_own_bucket() {
        let mut w = Window::default();
        w.add(0, HOUR, 10);
        w.add(2 * HOUR, HOUR, 4);
        w.undo(0, HOUR, 10);
        assert_eq!(w.total(2 * HOUR, HOUR), 4);
        w.undo(50 * HOUR, HOUR, 4); // a bucket that doesn't exist: nothing changes
        assert_eq!(w.total(2 * HOUR, HOUR), 4);
    }
}
