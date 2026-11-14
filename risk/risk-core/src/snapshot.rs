//! RISK_ENGINE.md 3.1: the snapshot the engine runs on, as the reference's `Account` and `Market` dataclasses.
//! The engine never reads anything else, so a verdict depends only on these two and the compiled-in data.
use crate::ordered::OrderedMap;
use crate::params::{find_token, ClientTier};
use crate::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// One client account: the NEAR side, the Hyperliquid side and the loan.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Account {
    /// Token -> units (nBTC in BTC, USDC in USDC), in the order the holdings were added.
    pub near: OrderedMap<f64>,
    /// Hyperliquid collateral, realised (USDC).
    pub hl_cash: f64,
    /// Coin -> signed size in Hyperliquid units (+ long).
    pub perps: OrderedMap<f64>,
    /// Coin -> entry price.
    pub entry: OrderedMap<f64>,
    /// The loan, with interest accrued to the snapshot.
    pub debt: f64,
    pub tier: ClientTier,
    /// Money in transit through 1Click.
    pub inflight: Vec<InFlight>,
    /// Resting Hyperliquid orders. Carried in the snapshot; version 0's engine doesn't use them (the gateway
    /// applies the resting-order rule of RISK_ENGINE.md 9).
    pub orders: Vec<Order>,
}

/// A transfer in flight: `[token, units, overdue]`, or `[token, units, overdue, to_hl]`. Overdue money counts as
/// nothing.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InFlight {
    pub token: String,
    pub units: f64,
    pub overdue: bool,
    /// On its way to the account's Hyperliquid address (a `to_hl` step); false for money coming to NEAR (a sale, a
    /// transfer home, a deposit). Missing in older snapshots and the reference's cases, so it reads as false there,
    /// and it is only written when true, so those read and print as before.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub to_hl: bool,
}

/// A Hyperliquid order: `[coin, signed size, limit price]`, plus the reduce-only flag for new orders.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Order {
    pub coin: String,
    pub size: f64,
    pub limit_px: f64,
    #[serde(default)]
    pub reduce_only: bool,
}

/// Prices and the pool, at one moment. Maps are keyed by coin (group) or token, and only looked up.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Market {
    /// Group -> reference price (median of sources, 3.2), in Hyperliquid units.
    pub px: BTreeMap<String, f64>,
    /// Coin -> Hyperliquid mark price.
    pub mark: BTreeMap<String, f64>,
    /// Group -> 1-hour TWAP of the reference price.
    pub twap: BTreeMap<String, f64>,
    /// Token -> price ratio to its underlying (π, e.g. nBTC/BTC), or its USDC price for stablecoins; 1 if absent.
    pub wrap: BTreeMap<String, f64>,
    /// Group -> volatility factor f (4.4); 1 if absent.
    pub volf: BTreeMap<String, f64>,
    /// Coin -> normal funding, annualised (positive: longs pay shorts); 0 if absent.
    pub funding: BTreeMap<String, f64>,
    /// Pool utilisation now.
    #[serde(default = "default_util")]
    pub util: f64,
    #[serde(default = "default_pool_capital")]
    pub pool_capital: f64,
    #[serde(default = "default_pool_loans")]
    pub pool_loans: f64,
    /// What the rest of the book holds: Hyperliquid notional per coin, NEAR value per token (4.2).
    #[serde(default)]
    pub book: BTreeMap<String, f64>,
    /// Bridged tokens the operator has frozen (3.3).
    #[serde(default)]
    pub frozen: BTreeSet<String>,
    /// Token -> π for allowance equity only (3.3: the lowest π of the last hour). A token not in it uses
    /// its `wrap`, so states never depend on it.
    #[serde(default)]
    pub wrap_allow: BTreeMap<String, f64>,
}

fn default_util() -> f64 {
    0.6
}

fn default_pool_capital() -> f64 {
    2_000_000.0
}

fn default_pool_loans() -> f64 {
    1_200_000.0
}

impl Market {
    /// `m.px[g]`.
    pub fn price(&self, g: &str) -> f64 {
        *self
            .px
            .get(g)
            .unwrap_or_else(|| panic!("no reference price for {g:?}"))
    }

    /// `m.mark[c]`.
    pub fn mark_price(&self, c: &str) -> f64 {
        *self
            .mark
            .get(c)
            .unwrap_or_else(|| panic!("no mark price for {c:?}"))
    }

    /// `m.wrap.get(t, 1.0)`.
    pub fn wrap_ratio(&self, t: &str) -> f64 {
        self.wrap.get(t).copied().unwrap_or(1.0)
    }

    /// 3.3: π for allowance equity, `min(m.wrap_allow.get(t, mark), mark)`. Never above the mark π: the hour's
    /// lowest includes now, so a higher value can only be a bad input.
    pub fn pi_allow(&self, t: &str) -> f64 {
        let mark = self.wrap_ratio(t);
        let allow = self.wrap_allow.get(t).copied().unwrap_or(mark);
        // Python's min(allow, mark) keeps `allow` unless `mark` is smaller.
        if mark < allow {
            mark
        } else {
            allow
        }
    }

    /// `m.twap.get(g, m.px[g])`.
    pub fn twap_of(&self, g: &str) -> f64 {
        self.twap.get(g).copied().unwrap_or_else(|| self.price(g))
    }

    /// `m.volf.get(g, 1.0)`.
    pub fn volf_of(&self, g: &str) -> f64 {
        self.volf.get(g).copied().unwrap_or(1.0)
    }

    /// `m.funding.get(c, 0.0)`.
    pub fn funding_of(&self, c: &str) -> f64 {
        self.funding.get(c).copied().unwrap_or(0.0)
    }

    /// `m.book.get(k, 0.0)`.
    pub fn book_of(&self, k: &str) -> f64 {
        self.book.get(k).copied().unwrap_or(0.0)
    }
}

impl Engine {
    /// The market of RISK_ENGINE.md 13 (the reference examples' `market()`): every price at the universe
    /// snapshot (4 Nov 2026), marks and TWAPs equal to it, wrappers at par, calm markets (f = 1), each coin's
    /// trailing 30-day funding, and a $2M pool with $1.2M lent.
    pub fn calm_market(&self) -> Market {
        let px: BTreeMap<String, f64> = self
            .coins
            .iter()
            .map(|c| (c.name.clone(), c.price))
            .collect();
        Market {
            mark: px.clone(),
            twap: px.clone(),
            wrap: ["nBTC", "ETH.b", "USDT"]
                .iter()
                .map(|t| (t.to_string(), 1.0))
                .collect(),
            volf: px.keys().map(|c| (c.clone(), 1.0)).collect(),
            funding: self
                .coins
                .iter()
                .map(|c| (c.name.clone(), c.funding_30d_apr))
                .collect(),
            px,
            util: default_util(),
            pool_capital: default_pool_capital(),
            pool_loans: default_pool_loans(),
            book: BTreeMap::new(),
            frozen: BTreeSet::new(),
            wrap_allow: BTreeMap::new(),
        }
    }

    /// Checks that the engine can run on this snapshot: every token is one of version 0's, every perp is a
    /// coin of the universe with a mark and a reference price, and every held group has a reference price.
    /// The engine itself assumes this (the reference raises a KeyError instead).
    pub fn check_snapshot(&self, a: &Account, m: &Market) -> Result<(), String> {
        for t in a
            .near
            .keys()
            .chain(a.inflight.iter().map(|f| f.token.as_str()))
        {
            let tok = find_token(t).ok_or_else(|| format!("unknown NEAR token {t}"))?;
            if let Some(g) = tok.group {
                if !m.px.contains_key(g) {
                    return Err(format!("no reference price for {g}"));
                }
            }
        }
        for c in a.perps.keys() {
            if self.find_coin(c).is_none() {
                return Err(format!("{c} is not in the universe"));
            }
            if !m.mark.contains_key(c) || !m.px.contains_key(c) {
                return Err(format!("no mark or reference price for {c}"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_snapshot_names_what_the_engine_cannot_price() {
        let eng = Engine::v0();
        let m = eng.calm_market();
        let mut a = Account::default();
        a.near.insert("nBTC", 1.0);
        a.perps.insert("BTC", -1.0);
        assert_eq!(eng.check_snapshot(&a, &m), Ok(()));
        a.near.insert("wBTC", 1.0);
        assert_eq!(
            eng.check_snapshot(&a, &m),
            Err("unknown NEAR token wBTC".to_string())
        );
        a.near.remove("wBTC");
        a.perps.insert("XMR", 1.0);
        assert_eq!(
            eng.check_snapshot(&a, &m),
            Err("XMR is not in the universe".to_string())
        );
    }

    #[test]
    fn calm_market_is_section_13s() {
        let eng = Engine::v0();
        let m = eng.calm_market();
        assert_eq!(m.price("BTC"), 78_287.0);
        assert_eq!(m.mark_price("BTC"), m.twap_of("BTC"));
        assert_eq!((m.wrap_ratio("nBTC"), m.wrap_ratio("wNEAR")), (1.0, 1.0));
        assert_eq!(m.funding_of("BTC"), eng.coin("BTC").funding_30d_apr);
        assert_eq!(
            (m.util, m.pool_capital, m.pool_loans),
            (0.6, 2_000_000.0, 1_200_000.0)
        );
    }
}
