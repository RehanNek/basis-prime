//! The risk and credit engine (RISK_ENGINE.md), as a pure library: no I/O, no clock, deterministic.
//!
//! It is a port of the Python reference engine, `research/scripts/risk_engine_ref.py`. Each module ports the
//! same part of it, with the same floating-point operations in the same order, so the two agree on every
//! worked example of RISK_ENGINE.md 13 and on the 24 property checks of 14.2 (the tests in `tests/`).
//!
//! Python habits it keeps on purpose, because they change results:
//! - dicts keep insertion order, which sets the order of sums and of scenarios: account holdings are
//!   [`OrderedMap`]s;
//! - `max` and `min` keep the first of equal values, and `sum` adds left to right ([`py`]);
//! - money is `f64`, rounded only where the reference rounds (allowances down to micro-USDC, the top-up up
//!   to whole dollars) and printed like Python in plan steps and reasons.
//!
//! [`Engine`] holds the compiled-in data and the parameters; its methods are spread over the modules below,
//! one per part of the engine (PLAN.md 6.9, build notes).

pub mod book;
pub mod costs;
pub mod credit;
pub mod factors;
pub mod hl;
pub mod lender;
pub mod ordered;
pub mod params;
pub mod plan;
pub mod pretrade;
pub mod prices;
pub mod py;
pub mod rating;
pub mod replay;
pub mod scenarios;
pub mod sim;
pub mod snapshot;
pub mod states;
pub mod stress;
pub mod universe;
pub mod valuation;

pub use credit::{Allowance, Withdrawal};
pub use ordered::OrderedMap;
pub use params::{ClientTier, Params};
pub use plan::{Plan, PlanEnd, Routes, Step, Trade, TradeKind};
pub use pretrade::{Check, PreTrade};
pub use rating::ScoreInputs;
pub use scenarios::{Kind, Scenario, ScenarioSet};
pub use snapshot::{Account, InFlight, Market, Order};
pub use states::{Action, State, Status};
pub use stress::{Detail, LiqKind, Liquidation, Requirement, Row};
pub use universe::{Coin, ReplayWindow};

use std::collections::BTreeMap;

/// The engine: the coin universe, its margin tables and the crash replays, plus the global parameters.
/// The reference's `Engine` class; build it with [`Engine::v0`].
#[derive(Clone, Debug)]
pub struct Engine {
    /// The coins, in the parameter file's order (the examples iterate it).
    pub coins: Vec<Coin>,
    /// Hyperliquid margin tables by id, in file order, each sorted by lower bound.
    pub tables: OrderedMap<Vec<hl::Tier>>,
    pub replays: Vec<ReplayWindow>,
    /// The reference's `G`. Tests change it to try the options of RISK_ENGINE.md 13.1.
    pub params: Params,
    index: BTreeMap<String, usize>,
}

impl Engine {
    fn new(
        coins: Vec<Coin>,
        tables: OrderedMap<Vec<hl::Tier>>,
        replays: Vec<ReplayWindow>,
    ) -> Engine {
        let index = coins
            .iter()
            .enumerate()
            .map(|(i, c)| (c.name.clone(), i))
            .collect();
        Engine {
            coins,
            tables,
            replays,
            params: Params::V0,
            index,
        }
    }

    /// The coin called `name`, if the universe has it.
    pub fn find_coin(&self, name: &str) -> Option<&Coin> {
        self.index.get(name).map(|&i| &self.coins[i])
    }

    /// The coin called `name` (`self.c[name]` in the reference, which raises if it is missing).
    pub fn coin(&self, name: &str) -> &Coin {
        self.find_coin(name)
            .unwrap_or_else(|| panic!("{name:?} is not in the universe"))
    }
}
