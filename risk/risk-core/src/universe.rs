//! The compiled-in data (RISK_ENGINE.md 5.5: the parameter file is built into the program, so its hash pins
//! it): the coin universe with its calibrated parameters and Hyperliquid margin tables
//! (`research/data/universe_v0.json`), and the ten crash-replay windows (`research/data/replays_v0.json`).
use crate::hl;
use crate::ordered::OrderedMap;
use crate::Engine;
use serde::Deserialize;
use std::collections::BTreeMap;

/// `research/data/universe_v0.json`, byte for byte.
pub const UNIVERSE_V0: &str = include_str!("../../../research/data/universe_v0.json");
/// `research/data/replays_v0.json`, byte for byte.
pub const REPLAYS_V0: &str = include_str!("../../../research/data/replays_v0.json");

/// One coin of the universe: what the engine reads of `universe_v0.json`.
#[derive(Clone, Debug, PartialEq)]
pub struct Coin {
    pub name: String,
    /// On the allow-list (5.1). The next-in-line coins are in the file but not allowed.
    pub allowed: bool,
    pub tier: u8,
    pub hl_max_leverage: u32,
    pub hl_margin_table: u32,
    /// Hyperliquid units per token (`kPEPE` = 1,000 PEPE).
    pub unit_mult: f64,
    /// The snapshot price the calibration ran on (4 Nov 2026), in Hyperliquid units.
    pub price: f64,
    pub oi_usd: f64,
    /// 30-day average daily Hyperliquid volume.
    pub adv30_usd: f64,
    pub spot24h_usd: f64,
    /// Hyperliquid's bid-ask spread in basis points; missing means 2 bp (4.6).
    pub spread_bp: Option<f64>,
    /// Trailing 30-day average funding, annualised: the "normal" funding of 4.7.
    pub funding_30d_apr: f64,
    pub params: CoinParams,
    /// The coin's Hyperliquid margin tiers, sorted by lower bound. A coin whose table is not in the file
    /// has one tier at its max leverage, as in the reference.
    pub margin_tiers: Vec<hl::Tier>,
}

/// The calibrated parameters of 5.2–5.3.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct CoinParams {
    /// Normal shock size S.
    #[serde(rename = "S")]
    pub s: f64,
    /// Perp-vs-index gap.
    pub basis: f64,
    /// All-history annualised volatility.
    pub vol_ref: f64,
    pub funding_stress_short_apr: f64,
    pub funding_stress_long_apr: f64,
    pub client_cap_usd: f64,
    pub book_cap_usd: f64,
    pub price_band: f64,
}

/// One crash-replay window: each coin's 240 one-minute closes, as moves from the window's start.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ReplayWindow {
    pub name: String,
    pub paths: BTreeMap<String, Vec<f64>>,
    /// For coins with no minute data that window: the multiple of BTC's path they follow.
    #[serde(default)]
    pub scale: BTreeMap<String, f64>,
    /// The fallback scale, for coins missing from `scale`.
    #[serde(default)]
    pub p75_ratio: Option<f64>,
}

#[derive(Deserialize)]
struct RawUniverse {
    coins: OrderedMap<RawCoin>,
    margin_tables: OrderedMap<RawTable>,
}

#[derive(Deserialize)]
struct RawCoin {
    allowed: bool,
    tier: u8,
    hl_max_leverage: u32,
    hl_margin_table: u32,
    unit_mult: f64,
    price: f64,
    oi_usd: f64,
    adv30_usd: f64,
    spot24h_usd: f64,
    book: RawBook,
    funding: RawFunding,
    params: CoinParams,
}

#[derive(Deserialize)]
struct RawBook {
    spread_bp: Option<f64>,
}

#[derive(Deserialize)]
struct RawFunding {
    mean_30d_apr: f64,
}

#[derive(Deserialize)]
struct RawTable {
    #[serde(rename = "marginTiers")]
    margin_tiers: Vec<RawTier>,
}

#[derive(Deserialize)]
struct RawTier {
    #[serde(rename = "lowerBound")]
    lower_bound: String,
    #[serde(rename = "maxLeverage")]
    max_leverage: u32,
}

#[derive(Deserialize)]
struct RawReplays {
    windows: Vec<ReplayWindow>,
}

impl Engine {
    /// The version 0 engine, on the compiled-in parameter and replay files.
    pub fn v0() -> Engine {
        Engine::from_json(UNIVERSE_V0, REPLAYS_V0)
            .expect("the compiled-in data files parse (tested)")
    }

    /// An engine on other parameter and replay files (same formats).
    pub fn from_json(universe: &str, replays: &str) -> Result<Engine, String> {
        let u: RawUniverse =
            serde_json::from_str(universe).map_err(|e| format!("universe file: {e}"))?;
        let r: RawReplays =
            serde_json::from_str(replays).map_err(|e| format!("replay file: {e}"))?;
        let mut tables = OrderedMap::new();
        for (id, table) in u.margin_tables.iter() {
            let mut tiers = Vec::new();
            for t in &table.margin_tiers {
                let lower_bound = t
                    .lower_bound
                    .parse::<f64>()
                    .map_err(|e| format!("margin table {id}: {e}"))?;
                tiers.push(hl::Tier {
                    lower_bound,
                    max_leverage: t.max_leverage,
                });
            }
            // The reference sorts (lower bound, max leverage) pairs.
            tiers.sort_by(|a, b| {
                a.lower_bound
                    .total_cmp(&b.lower_bound)
                    .then(a.max_leverage.cmp(&b.max_leverage))
            });
            tables.insert(id, tiers);
        }
        let mut coins = Vec::new();
        for (name, c) in u.coins.iter() {
            let margin_tiers = tables
                .get(&c.hl_margin_table.to_string())
                .cloned()
                .unwrap_or_else(|| {
                    vec![hl::Tier {
                        lower_bound: 0.0,
                        max_leverage: c.hl_max_leverage,
                    }]
                });
            let coin = Coin {
                name: name.to_string(),
                allowed: c.allowed,
                tier: c.tier,
                hl_max_leverage: c.hl_max_leverage,
                hl_margin_table: c.hl_margin_table,
                unit_mult: c.unit_mult,
                price: c.price,
                oi_usd: c.oi_usd,
                adv30_usd: c.adv30_usd,
                spot24h_usd: c.spot24h_usd,
                spread_bp: c.book.spread_bp,
                funding_30d_apr: c.funding.mean_30d_apr,
                params: c.params.clone(),
                margin_tiers,
            };
            coins.push(coin);
        }
        if r.windows.iter().any(|w| !w.paths.contains_key("BTC")) {
            return Err("replay file: every window needs a BTC path".to_string());
        }
        Ok(Engine::new(coins, tables, r.windows))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_universe_loads_in_file_order() {
        let eng = Engine::v0();
        let names: Vec<&str> = eng.coins.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names.len(), 25);
        assert_eq!(&names[..3], ["BTC", "ETH", "ZEC"]);
        assert_eq!(names.iter().filter(|c| eng.coin(c).allowed).count(), 23);
        assert_eq!(eng.coin("BTC").params.s, 0.12);
        assert_eq!(eng.coin("BTC").margin_tiers.len(), 2);
        // TAO's table (5) is not in the file: one tier at its max leverage.
        assert_eq!(
            eng.coin("TAO").margin_tiers,
            vec![hl::Tier {
                lower_bound: 0.0,
                max_leverage: 5
            }]
        );
        assert_eq!(eng.replays.len(), 10);
        assert!(eng.replays.iter().all(|w| w.paths["BTC"].len() == 240));
    }
}
