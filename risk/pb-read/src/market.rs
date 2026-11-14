//! RISK_ENGINE.md 3.2 and 4.4 from the readings: each coin's reference price (the median of the fresh sources), its
//! 1-hour TWAP, and its 30-day hourly volatility. Missing market data never makes the state worse: it marks the
//! coin uncertain, which stops new credit, and leaves the price where the remaining sources put it.
use crate::inputs::CoinReads;
use risk_core::prices::{self, PriceStatus, Reading, RefPrice};
use std::collections::BTreeMap;

const MINUTE_MS: u64 = 60_000;
const HOUR_MS: u64 = 3_600_000;
/// The TWAP needs at least half of the last hour's minutes.
pub const MIN_TWAP_MINUTES: usize = 30;
/// 4.4: 720 hourly returns, so 721 closes; at least 25 (24 returns seed the variance, then one update).
pub const VOL_CLOSES: u64 = 721;
pub const MIN_VOL_CLOSES: usize = 25;
/// The exchanges whose candles make the TWAP and the volatility (not Hyperliquid's own trades, which can be printed).
pub const CANDLE_SOURCES: [&str; 3] = ["binance", "okx", "bybit"];

/// One coin's market inputs for the engine.
#[derive(Clone, Debug, PartialEq)]
pub struct CoinPrice {
    /// The median of the valid sources, in Hyperliquid units.
    pub reference: RefPrice,
    /// 3.2's TWAP, if at least half the last hour had closes.
    pub twap: Option<f64>,
    /// 4.4's annualised EWMA volatility, if there were enough hourly closes.
    pub sigma: Option<f64>,
}

impl CoinPrice {
    /// No new risk in the coin: too few sources, two outliers, or no TWAP or volatility to check it with.
    pub fn uncertain(&self) -> bool {
        self.reference.status != PriceStatus::Fresh || self.twap.is_none() || self.sigma.is_none()
    }
}

/// The readings for one coin: each exchange's mid, and Hyperliquid's oracle (already in its own units), with ages.
pub fn readings(
    reads: &CoinReads,
    unit_mult: f64,
    oracle: Option<(f64, u64)>,
    now_ms: u64,
) -> Vec<Reading> {
    let age = |at_ms: u64| now_ms.saturating_sub(at_ms) as f64 / 1000.0;
    let mut out: Vec<Reading> = reads
        .tickers
        .values()
        .filter(|t| t.bid > 0.0 && t.ask >= t.bid)
        .map(|t| Reading {
            price: (t.bid + t.ask) / 2.0 * unit_mult,
            age_s: age(t.at_ms),
            conf: None,
        })
        .collect();
    if let Some((price, at_ms)) = oracle {
        out.push(Reading {
            price,
            age_s: age(at_ms),
            conf: None,
        });
    }
    out
}

/// Each period's closes from every source, keyed by the period's open time: only whole periods inside
/// `[end − count·len, end)`, where `end` is the start of the current period.
fn by_period(
    reads: &BTreeMap<String, Vec<(u64, f64)>>,
    now_ms: u64,
    len: u64,
    count: u64,
    unit_mult: f64,
) -> BTreeMap<u64, Vec<f64>> {
    let end = now_ms / len * len;
    let start = end.saturating_sub(count * len);
    let mut out: BTreeMap<u64, Vec<f64>> = BTreeMap::new();
    for src in CANDLE_SOURCES {
        for &(open, close) in reads.get(src).map_or(&[][..], Vec::as_slice) {
            if open >= start && open < end && open % len == 0 && close > 0.0 {
                out.entry(open).or_default().push(close * unit_mult);
            }
        }
    }
    out
}

/// 3.2: P̄, the average over the last 60 whole minutes of the per-minute median of the exchanges' closes.
pub fn twap(reads: &CoinReads, unit_mult: f64, now_ms: u64) -> Option<f64> {
    let minutes = by_period(&reads.minutes, now_ms, MINUTE_MS, 60, unit_mult);
    if minutes.len() < MIN_TWAP_MINUTES {
        return None;
    }
    prices::twap(&minutes.into_values().collect::<Vec<_>>())
}

/// 4.4: σ from the last 721 hourly closes (each the median of the exchanges' closes for that hour).
pub fn sigma(reads: &CoinReads, now_ms: u64) -> Option<f64> {
    // Volatility is unitless, so the unit multiplier doesn't matter here.
    let closes: Vec<f64> = by_period(&reads.hours, now_ms, HOUR_MS, VOL_CLOSES, 1.0)
        .into_values()
        .filter_map(|c| prices::median(&c))
        .collect();
    ewma_sigma(&closes)
}

/// 4.4: r_t = ln(P_t / P_t−1); σ² seeded with the (population) variance of the first 24 returns, then
/// σ² ← 0.99·σ² + 0.01·r² for each later return; σ = sqrt(σ² · 8760). `libm`'s log gives the same bits in WASM
/// and natively, so a replay matches the enclave exactly.
pub fn ewma_sigma(closes: &[f64]) -> Option<f64> {
    if closes.len() < MIN_VOL_CLOSES {
        return None;
    }
    let r: Vec<f64> = closes.windows(2).map(|w| libm::log(w[1] / w[0])).collect();
    let seed = &r[..24];
    let mean = seed.iter().fold(0.0, |a, x| a + x) / 24.0;
    let mut var = seed.iter().fold(0.0, |a, x| a + (x - mean) * (x - mean)) / 24.0;
    for x in &r[24..] {
        var = 0.99 * var + 0.01 * x * x;
    }
    let s = (var * 8760.0).sqrt();
    s.is_finite().then_some(s)
}

/// A coin's reference price, TWAP and volatility.
pub fn coin_price(
    reads: &CoinReads,
    tier: u8,
    unit_mult: f64,
    oracle: Option<(f64, u64)>,
    now_ms: u64,
) -> CoinPrice {
    // This run keeps no history, so a coin is never PRICE_STALE here: with no valid source it has no price.
    let reference = prices::reference_price(&readings(reads, unit_mult, oracle, now_ms), tier, 0.0);
    CoinPrice {
        reference,
        twap: twap(reads, unit_mult, now_ms),
        sigma: sigma(reads, now_ms),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inputs::Ticker;

    fn reads_with(prices: &[(&str, f64, f64)], at_ms: u64) -> CoinReads {
        let mut r = CoinReads::default();
        for &(src, bid, ask) in prices {
            r.tickers.insert(src.into(), Ticker { bid, ask, at_ms });
        }
        r
    }

    #[test]
    fn the_reference_is_the_median_of_fresh_mids() {
        let now = 1_000_000;
        let r = reads_with(
            &[
                ("binance", 99.0, 101.0),
                ("okx", 100.0, 102.0),
                ("bybit", 0.0, 1.0),
            ],
            now - 2_000,
        );
        let rs = readings(&r, 1.0, Some((100.5, now - 1_000)), now);
        assert_eq!(rs.len(), 3); // bybit's book is empty
        let p = prices::reference_price(&rs, 1, 0.0);
        assert_eq!((p.price, p.status), (Some(100.5), PriceStatus::Fresh));
        // Older than 10 s: not valid, so two sources are too few.
        let stale = readings(&r, 1.0, Some((100.5, now - 11_000)), now);
        assert_eq!(
            prices::reference_price(&stale, 1, 0.0).status,
            PriceStatus::Uncertain
        );
        // kPEPE: an exchange's PEPE price times 1,000.
        assert_eq!(
            readings(
                &reads_with(&[("okx", 0.0000049, 0.0000049)], now),
                1000.0,
                None,
                now
            )[0]
            .price,
            0.0049
        );
    }

    #[test]
    fn the_twap_uses_whole_minutes_of_the_last_hour() {
        let now = 10 * HOUR_MS + 30_000; // half a minute into a new minute
        let mut r = CoinReads::default();
        let mut add = |src: &str, open: u64, close: f64| {
            r.minutes.entry(src.into()).or_default().push((open, close))
        };
        for i in 0..60 {
            let open = 10 * HOUR_MS - (60 - i) * MINUTE_MS;
            add("binance", open, 100.0);
            add("okx", open, 102.0);
            add("bybit", open, 200.0);
        }
        add("binance", 10 * HOUR_MS, 999.0); // the current minute isn't whole yet
        add("binance", 10 * HOUR_MS - 61 * MINUTE_MS, 999.0); // older than the hour
        assert_eq!(twap(&r, 1.0, now), Some(102.0));
        r.minutes.clear();
        assert_eq!(twap(&r, 1.0, now), None);
    }

    #[test]
    fn ewma_volatility_follows_4_4() {
        // Alternating ±1% returns: r² = (ln 1.01)² every hour, so σ = |ln 1.01| · sqrt(8760) after any seed of them.
        let mut closes = vec![100.0];
        for i in 0..100 {
            let last = *closes.last().unwrap();
            closes.push(if i % 2 == 0 { last * 1.01 } else { last / 1.01 });
        }
        let s = ewma_sigma(&closes).unwrap();
        let want = libm::log(1.01) * 8760f64.sqrt();
        assert!((s / want - 1.0).abs() < 1e-9, "{s} vs {want}");
        assert_eq!(ewma_sigma(&closes[..24]), None);
        // The same formula in Python on a fixed series:
        //   s = [100.0 + float(i*37 % 11) - 5.0 for i in range(40)]; r = [log(s[i+1]/s[i]) ...]
        //   var = pvariance(r[:24]); for x in r[24:]: var = 0.99*var + 0.01*x*x;  sqrt(var*8760)
        let series: Vec<f64> = (0..40)
            .map(|i| 100.0 + ((i * 37 % 11) as f64) - 5.0)
            .collect();
        assert!((ewma_sigma(&series).unwrap() - 4.887516984797232).abs() < 1e-12);
    }
}
