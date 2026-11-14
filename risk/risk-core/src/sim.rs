//! The backtest with rebalancing delays (PLAN.md 6.9 step 9, INTERFACES.md 20). One account is stepped through one
//! crash-replay window minute by minute: the engine checks it once a minute, and the keeper acts on what the check
//! says, as they do live.
//!
//! **The market** ([`World`]) is the replay family's own (RISK_ENGINE.md 4.5): each coin's one-minute closes (or BTC's
//! path times the window's scale), the adverse perp-vs-index gap on every perp, and the normal depeg (bridged tokens
//! −2%, USDT −1%), applied to the starting market. With nobody acting, the account follows the engine's own replay
//! scenario for that window (tested below).
//!
//! **Each minute** ([`simulate`]):
//! 1. the price moves, and a minute of interest and funding accrues;
//! 2. Hyperliquid's replica (4.3) checks the account at the new marks, before anything else happens;
//! 3. money due this minute lands;
//! 4. the engine checks the account: requirement, state and action, with the margin-call clock and hysteresis (8.1);
//! 5. the keeper acts on the verdict:
//!    - REBALANCE and REBALANCE_NOW: the plan runs at once (8.2);
//!    - DELEVERAGE: the plan runs when the check 3 minutes after the first DELEVERAGE verdict still says so, or at
//!      once from an 80% Hyperliquid margin ratio (the two-check rule, PLAN.md 5.1);
//!    - perp steps fill this minute at the mark and pay the engine's unwind cost (4.6); a sale through 1Click is
//!      priced now and pays its USDC after the delay; moves between NEAR and Hyperliquid land after the delay;
//! 6. Hyperliquid checks again after our trades, and money sent with no delay lands.
//!
//! [`Keeper`] holds the choices the specs leave open, and [`ASSUMPTIONS`] says each one in words.
use crate::costs::cost_1c;
use crate::ordered::OrderedMap;
use crate::params::{token, TOKENS};
use crate::plan::{Routes, Step, TradeKind, ONE_CLICK_FEE};
use crate::py::{self, sgn};
use crate::scenarios::move_of;
use crate::snapshot::{Account, InFlight, Market};
use crate::states::{Action, State};
use crate::stress::LiqKind;
use crate::valuation::token_value;
use crate::Engine;
use std::collections::BTreeMap;

/// A verdict carries at most this many step objects (INTERFACES.md 13; pb-risk's `MAX_PLAN_STEPS`).
pub const MAX_PLAN_STEPS: usize = 4;
/// The pool's 24-hour limit on plan steps other than repayments, past which the operator must co-sign (PLAN.md 5.1).
pub const COSIGN_ABOVE_USD: f64 = 50_000.0;
/// The account contract's limit on transfers under way (`contracts/account`, `MAX_TRANSFERS`).
pub const MAX_TRANSFERS: usize = 8;
/// The check that confirms a DELEVERAGE plan comes this many minutes after the first (PLAN.md 5.1 allows 2 to 5).
pub const CONFIRM_AFTER_MIN: usize = 3;
const MINUTES_PER_YEAR: f64 = 365.0 * 24.0 * 60.0;
const CENT: f64 = 0.01;

/// The simulation's reading of what the specs leave open, in the order of a minute.
pub const ASSUMPTIONS: &[&str] = &[
    "Prices: each minute is the engine's own replay path (RISK_ENGINE.md 4.5): recorded one-minute closes, or BTC's \
     path times the window's scale, with the adverse perp gap on every perp and the normal depeg (bridged tokens -2%, \
     USDT -1%) from minute 0 on. The volatility factor stays at the starting market's (1): the replay file holds only \
     the window, not the 720 hours before it. The 1-hour TWAP is the price itself, which only matters for new credit.",
    "Order within a minute: the price moves and a minute of carry accrues; Hyperliquid's replica checks the account \
     first, before money due that minute lands and before we act; then arrivals; then the engine's check; then the \
     keeper's steps; then Hyperliquid checks again at the same marks; money sent with no delay lands at the end of the \
     minute.",
    "Checks: one a minute. A DELEVERAGE plan is confirmed by the check 3 minutes after the first DELEVERAGE verdict, \
     if every check in between also said DELEVERAGE (the contract would take 2 minutes; any other verdict starts the \
     pair again); at once when Hyperliquid's margin ratio is 80% or more. Each confirmation opens the next pair, so a \
     running unwind gets a new plan every 3 minutes. REBALANCE and REBALANCE_NOW plans run at the check that asks.",
    "Plans: the engine's own (deleverage_steps, rebalance_steps), with 1Click's routes, written as at most 4 step \
     objects, whole steps only (a pair is a perp and a sale), as pb-risk writes them. Quotes are always there. Perp \
     sizes are not rounded to Hyperliquid's size decimals, and its $10 minimum is not applied.",
    "Fills: a perp step fills in the minute it runs, at that minute's mark (gap included). Every trade pays the \
     engine's unwind-cost formula (4.6) at the size traded so far in that coin or token during the window, as a \
     marginal cost C(done + this) - C(done), so ten small trades never cost less than one big one.",
    "1Click: a sale is priced at its quote, in the minute it runs, less the engine's 1Click cost; its USDC lands on \
     NEAR after the delay. to_hl and home move USDC after the delay, less 1Click's 0.2 USDC fee. Nothing is refunded, \
     and a transfer is never overdue (its quoted time is the delay).",
    "Money in flight: the engine sees each transfer as the token sent, at 98%, marked with where it goes (pb-read's \
     rule). A REBALANCE takes 98% of the USDC already on its way to Hyperliquid off what it asks for (rebalance_need, \
     since 9 Nov), so while a top-up is in transit a check asks only for what it doesn't cover; the account allows 8 \
     transfers under way. A repay after a sale waits for that sale to land (as built); a newer stored plan replaces \
     the old one, and a plan older than the latest verdict runs no more steps once a verdict says NONE.",
    "The pool's 24-hour limit: sales and transfers past $50k of plan steps in 24 hours need the operator's \
     co-signature (PLAN.md 5.1). By default none comes during the window, so those steps are refused; a pair's perp \
     leg still runs, because the gateway places perp steps on its own (as built). `--cosign` runs with the operator \
     co-signing at once.",
    "Carry: interest accrues each minute on the debt at the tier's normal rate, and funding on each perp at its \
     trailing 30-day rate.",
    "Hyperliquid's replica (RISK_ENGINE.md 4.3) at each minute's marks: below maintenance margin, a book liquidation \
     closes every perp and pays the replica's slippage; below 2/3 of it, the backstop keeps everything. No ADL.",
    "Pool loss: max(0, debt - what the account is worth closed out that minute): NEAR tokens and perps sold at that \
     minute's prices with the costs above, Hyperliquid's side floored at 0 (non-recourse), money in flight at 98% of \
     what it will deliver; never more than the debt.",
    "Equity: the engine's mark equity at each minute's check, before that minute's steps, with that check's IM. The \
     margin-call clock adds each minute that follows a check below MR. The client does nothing during the window.",
];

/// One replay window as a market, minute by minute.
#[derive(Clone, Debug, PartialEq)]
pub struct World {
    /// The window's name in the replay file.
    pub window: String,
    /// The market at the window's start, before its first close.
    pub start: Market,
    /// The groups the moves refer to: the starting book's, sorted, as the engine's replay builds them.
    groups: Vec<String>,
    /// `moves[i][j]`: group j's move from the start at minute i.
    moves: Vec<Vec<f64>>,
    /// The adverse gap on each perp of the starting book: -sign(q) × β.
    gaps: OrderedMap<f64>,
}

impl World {
    /// Window `window` of the engine's replays, for `book`, from the market `start`.
    pub fn new(eng: &Engine, start: &Market, book: &Account, window: usize) -> World {
        let groups = eng.scenarios(book, start).groups;
        let replay = eng.replay_scenarios(&groups).swap_remove(window);
        let moves = replay
            .path
            .into_iter()
            .map(|mut stage| stage.swap_remove(0))
            .collect();
        let gaps = book
            .perps
            .iter()
            .filter(|(_, &q)| q != 0.0)
            .map(|(c, &q)| (c, f64::from(-sgn(q)) * eng.coin(c).params.basis))
            .collect();
        World {
            window: eng.replays[window].name.clone(),
            start: start.clone(),
            groups,
            moves,
            gaps,
        }
    }

    /// The window's length in minutes.
    pub fn minutes(&self) -> usize {
        self.moves.len()
    }

    /// Keeps only the window's first `minutes` minutes (for tests that don't need all of it).
    pub fn truncate(&mut self, minutes: usize) {
        self.moves.truncate(minutes);
    }

    pub fn groups(&self) -> &[String] {
        &self.groups
    }

    /// Coin `g`'s move from the start at minute `i`.
    pub fn move_at(&self, i: usize, g: &str) -> f64 {
        move_of(&self.groups, &self.moves[i], g)
    }

    /// The market at minute `i`: each group's reference price moved, its mark moved with the gap, and the normal
    /// depeg on every NEAR token, as the replay scenario values them.
    pub fn market_at(&self, i: usize) -> Market {
        let mut m = self.start.clone();
        for (g, &x) in self.groups.iter().zip(&self.moves[i]) {
            let px = self.start.price(g) * (1.0 + x);
            m.px.insert(g.clone(), px);
            m.twap.insert(g.clone(), px);
            if let Some(&mark) = self.start.mark.get(g) {
                let gap = self.gaps.get_or(g, 0.0);
                m.mark.insert(g.clone(), mark * (1.0 + x) * (1.0 + gap));
            }
        }
        for t in TOKENS.iter().filter(|t| t.depeg[0] != 0.0) {
            let pi = self.start.wrap_ratio(t.name) * (1.0 - t.depeg[0]);
            m.wrap.insert(t.name.to_string(), pi);
        }
        m
    }

    /// The market at tick `tick`: the start for tick 0, minute `tick - 1` after it.
    pub fn market_at_tick(&self, tick: usize) -> Market {
        match tick {
            0 => self.start.clone(),
            t => self.market_at(t - 1),
        }
    }
}

/// The window's minute at tick `tick`: tick 0 is the start (the loan is drawn then), tick i + 1 is minute i, the
/// window's (i + 1)-th one-minute close, as RISK_ENGINE.md 13.1 counts them.
pub fn minute_of(tick: usize) -> Option<usize> {
    tick.checked_sub(1)
}

/// How the keeper and the venues behave: the choices of [`ASSUMPTIONS`].
#[derive(Clone, Debug, PartialEq)]
pub struct Keeper {
    /// Minutes money takes between NEAR and Hyperliquid through 1Click.
    pub delay: usize,
    /// Whether the engine checks the account each minute.
    pub watch: bool,
    /// Whether the keeper runs the plans the checks ask for.
    pub act: bool,
    /// Whether interest and funding accrue.
    pub carry: bool,
    /// The pool's 24-hour limit on plan steps; None when the operator co-signs at once.
    pub cosign_above: Option<f64>,
    pub max_transfers: usize,
    pub confirm_after: usize,
}

impl Keeper {
    /// The live system, with money taking `delay` minutes and no co-signature during the window.
    pub fn live(delay: usize) -> Keeper {
        Keeper {
            delay,
            watch: true,
            act: true,
            carry: true,
            cosign_above: Some(COSIGN_ABOVE_USD),
            max_transfers: MAX_TRANSFERS,
            confirm_after: CONFIRM_AFTER_MIN,
        }
    }

    /// Nobody acts and nothing accrues: the account as the engine's own replay scenario sees it.
    pub fn passive() -> Keeper {
        Keeper {
            watch: false,
            act: false,
            carry: false,
            ..Keeper::live(0)
        }
    }
}

/// One check: the engine's verdict on the account at that minute.
#[derive(Clone, Debug, PartialEq)]
pub struct Check {
    /// Mark equity E.
    pub e: f64,
    pub mr: f64,
    pub im: f64,
    /// The debt the check read.
    pub debt: f64,
    pub state: State,
    pub action: Action,
    /// Hyperliquid's margin ratio (infinite once its equity is gone).
    pub hl_ratio: f64,
    /// The margin-call clock the check read, in hours.
    pub clock_h: f64,
}

/// The account at the end of one tick, after everything that happened in it.
#[derive(Clone, Debug, PartialEq)]
pub struct Tick {
    /// None when the keeper doesn't watch.
    pub check: Option<Check>,
    pub debt: f64,
    /// NEAR tokens at this minute's prices, and what selling them would cost now.
    pub near: f64,
    pub near_cost: f64,
    /// Hyperliquid account value, and what closing its perps would cost now.
    pub hl_eq: f64,
    pub hl_cost: f64,
    /// Money in flight: 98% of what it will deliver.
    pub inflight: f64,
    /// What closing the account out now would leave: each venue floored at 0, plus money in flight.
    pub closeout: f64,
    /// max(0, debt − closeout), at most the debt.
    pub pool_loss: f64,
}

/// A Hyperliquid liquidation by the replica.
#[derive(Clone, Debug, PartialEq)]
pub struct Liquidation {
    pub tick: usize,
    pub kind: LiqKind,
    /// Hyperliquid equity at the end of the minute before.
    pub hl_eq_before: f64,
    /// Hyperliquid equity and maintenance margin at the trigger.
    pub hl_eq: f64,
    pub mm: f64,
    /// The slippage paid (book) or the equity the backstop kept.
    pub lost: f64,
}

/// The kinds of plan step (INTERFACES.md 13), as the simulation runs them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum StepKind {
    Perp,
    Repay,
    Sell,
    ToHl,
    Home,
}

impl StepKind {
    pub fn as_str(self) -> &'static str {
        match self {
            StepKind::Perp => "perp",
            StepKind::Repay => "repay",
            StepKind::Sell => "sell",
            StepKind::ToHl => "to_hl",
            StepKind::Home => "home",
        }
    }

    pub const ALL: [StepKind; 5] = [
        StepKind::Perp,
        StepKind::Repay,
        StepKind::Sell,
        StepKind::ToHl,
        StepKind::Home,
    ];
}

/// A plan step the keeper ran, or tried to.
#[derive(Clone, Debug, PartialEq)]
pub struct StepRun {
    pub tick: usize,
    /// The tick of the verdict whose plan it is.
    pub plan: usize,
    pub action: Action,
    pub kind: StepKind,
    /// The coin or token.
    pub what: String,
    /// Dollars traded, repaid or sent.
    pub usd: f64,
    /// What it cost: the unwind cost, or 1Click's fee.
    pub cost: f64,
    /// Why it didn't run, if it didn't.
    pub refused: Option<String>,
}

/// Money sent through 1Click.
#[derive(Clone, Debug, PartialEq)]
pub struct Transfer {
    pub kind: StepKind,
    /// What the engine sees in transit: the token sent and its units.
    pub token: String,
    pub units: f64,
    /// The USDC it delivers, and where.
    pub usdc: f64,
    pub to_hl: bool,
    pub sent: usize,
    pub arrives: usize,
    plan: usize,
    step: usize,
}

/// Everything that happened in one window.
#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    pub window: String,
    /// Tick 0 is the start, after the loan; tick i + 1 is minute i ([`minute_of`]).
    pub ticks: Vec<Tick>,
    pub liquidations: Vec<Liquidation>,
    pub steps: Vec<StepRun>,
    /// Every transfer sent, in the order sent.
    pub transfers: Vec<Transfer>,
    /// Ticks at which a DELEVERAGE plan was confirmed.
    pub confirmed: Vec<usize>,
    /// The first tick at which everything was sold and debt was left (DEFAULT, RISK_ENGINE.md 8.5).
    pub default_at: Option<usize>,
}

/// A step object of a stored plan.
#[derive(Clone, Debug, PartialEq)]
enum Obj {
    Perp { coin: String, dq: f64 },
    Repay { usd: f64 },
    Sell { token: String, units: f64 },
    ToHl { usd: f64 },
    Home { usd: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Status {
    Pending,
    Done,
    /// A transfer under way; it becomes Landed when its money arrives.
    Sent,
    Landed,
    Refused,
}

/// The plan the account stores, and how far it got.
#[derive(Clone, Debug)]
struct Stored {
    tick: usize,
    action: Action,
    objs: Vec<Obj>,
    status: Vec<Status>,
}

/// The engine's steps as step objects: at most [`MAX_PLAN_STEPS`], whole steps only, a pair as its perp then its sale.
fn wire(steps: &[Step]) -> Vec<Obj> {
    let mut out = Vec::new();
    for step in steps {
        let objs = match step {
            Step::Repay { usd } if (usd * 1e6).round() >= 1.0 => vec![Obj::Repay { usd: *usd }],
            Step::Repay { .. } => Vec::new(),
            Step::Home { usd } => vec![Obj::Home { usd: *usd }],
            Step::ToHl { usd } => vec![Obj::ToHl { usd: *usd }],
            Step::Swap { token, units, .. } => vec![Obj::Sell {
                token: token.clone(),
                units: *units,
            }],
            Step::Trade(t) => {
                let mut v = Vec::new();
                if t.kind != TradeKind::Near {
                    v.push(Obj::Perp {
                        coin: t.group.clone(),
                        dq: t.dq,
                    });
                }
                if t.kind != TradeKind::Perp {
                    v.push(Obj::Sell {
                        token: t.token.clone().unwrap_or_default(),
                        units: t.units,
                    });
                }
                v
            }
        };
        if objs.is_empty() {
            continue;
        }
        if out.len() + objs.len() > MAX_PLAN_STEPS {
            break;
        }
        out.extend(objs);
    }
    out
}

/// The cost of trading `n` more dollars after `done` dollars this window: C(done + n) − C(done), C(N) = c(N) × N.
fn marginal(c: impl Fn(f64) -> f64, done: f64, n: f64) -> f64 {
    let total = done + n;
    c(total) * total - c(done) * done
}

struct Run<'a> {
    eng: &'a Engine,
    k: &'a Keeper,
    /// The account, without its transfers (kept in `flight`).
    acct: Account,
    flight: Vec<Transfer>,
    stored: Option<Stored>,
    /// The latest verdict's action and tick.
    held: Option<(Action, usize)>,
    /// The tick of the first DELEVERAGE verdict of the current pair.
    first_at: Option<usize>,
    prev: Option<State>,
    /// Minutes counted below MR (the margin-call clock).
    below_min: usize,
    /// Dollars traded this window, per Hyperliquid coin and per NEAR token.
    traded_hl: BTreeMap<String, f64>,
    traded_1c: BTreeMap<String, f64>,
    /// Plan steps the pool counted toward its 24-hour limit.
    steps_24h: f64,
    out: Outcome,
}

/// Steps `book` (with its loan drawn) through `world`, minute by minute, with the keeper `k`.
pub fn simulate(eng: &Engine, world: &World, book: &Account, k: &Keeper) -> Outcome {
    assert!(
        book.inflight.is_empty(),
        "the backtest starts with nothing in flight"
    );
    let mut r = Run {
        eng,
        k,
        acct: book.clone(),
        flight: Vec::new(),
        stored: None,
        held: None,
        first_at: None,
        prev: None,
        below_min: 0,
        traded_hl: BTreeMap::new(),
        traded_1c: BTreeMap::new(),
        steps_24h: 0.0,
        out: Outcome {
            window: world.window.clone(),
            ticks: Vec::with_capacity(world.minutes() + 1),
            liquidations: Vec::new(),
            steps: Vec::new(),
            transfers: Vec::new(),
            confirmed: Vec::new(),
            default_at: None,
        },
    };
    for tick in 0..=world.minutes() {
        let m = world.market_at_tick(tick);
        if tick > 0 && k.carry {
            r.accrue(&m);
        }
        r.hyperliquid(&m, tick);
        r.settle(&m, tick);
        let check = if k.watch {
            Some(r.check(&m, tick))
        } else {
            None
        };
        r.hyperliquid(&m, tick);
        r.settle(&m, tick);
        r.record(&m, tick, check);
    }
    r.out
}

impl Run<'_> {
    /// A minute of interest on the debt and funding on the perps (positive funding: longs pay).
    fn accrue(&mut self, m: &Market) {
        let rate = self.eng.params.base_rate(m.util) + self.acct.tier.spec().spread;
        self.acct.debt += self.acct.debt * rate / MINUTES_PER_YEAR;
        let funding = py::sum(
            self.acct
                .perps
                .iter()
                .filter(|(_, &q)| q != 0.0)
                .map(|(c, &q)| q * m.mark_price(c) * m.funding_of(c) / MINUTES_PER_YEAR),
        );
        self.acct.hl_cash -= funding;
    }

    /// Hyperliquid's replica (RISK_ENGINE.md 4.3), as the scenarios run it: below maintenance margin every perp is
    /// closed, into the book (paying the slippage) or, below 2/3 of it, by the backstop, which keeps everything.
    fn hyperliquid(&mut self, m: &Market, tick: usize) {
        let eng = self.eng;
        let p = &eng.params;
        let live: Vec<(String, f64)> = self
            .acct
            .perps
            .iter()
            .filter(|(_, &q)| q != 0.0)
            .map(|(c, &q)| (c.to_string(), q))
            .collect();
        if live.is_empty() {
            return;
        }
        let eq = eng.hl_equity_now(&self.acct, m);
        let mmv = py::sum(
            live.iter()
                .map(|(c, q)| eng.mm(c, q.abs() * m.mark_price(c))),
        );
        if eq >= mmv {
            return;
        }
        let (kind, post, lost) = if eq >= p.backstop_frac * mmv {
            let slip = py::sum(live.iter().map(|(c, q)| {
                let n = q.abs() * m.mark_price(c);
                py::max(
                    p.liq_slip_floor,
                    2.0 * eng.cost_hl(c, n, eng.vol_factor(m, c)),
                ) * n
            }));
            (LiqKind::Book, py::max(eq - slip, 0.0), slip)
        } else {
            (LiqKind::Backstop, 0.0, py::max(eq, 0.0))
        };
        self.acct.hl_cash = post;
        self.acct.perps = OrderedMap::new();
        self.acct.entry = OrderedMap::new();
        let before = self.out.ticks.last().map_or(eq, |t| t.hl_eq);
        self.out.liquidations.push(Liquidation {
            tick,
            kind,
            hl_eq_before: before,
            hl_eq: eq,
            mm: mmv,
            lost,
        });
    }

    /// Money due by `tick` lands; then any repay that waited for it runs.
    fn settle(&mut self, m: &Market, tick: usize) {
        let mut landed = false;
        let mut i = 0;
        while i < self.flight.len() {
            if self.flight[i].arrives > tick {
                i += 1;
                continue;
            }
            let t = self.flight.remove(i);
            if t.to_hl {
                self.acct.hl_cash += t.usdc;
            } else {
                let usdc = self.acct.near.get_or("USDC", 0.0);
                self.acct.near.insert("USDC", usdc + t.usdc);
            }
            if let Some(s) = self.stored.as_mut().filter(|s| s.tick == t.plan) {
                s.status[t.step] = Status::Landed;
            }
            landed = true;
        }
        if landed && self.runnable() {
            self.run_stored(m, tick);
        }
    }

    /// The keeper runs the stored plan while it is the latest verdict's, or while the latest verdict's action isn't
    /// NONE (INTERFACES.md 13, the keeper's side).
    fn runnable(&self) -> bool {
        match (&self.stored, self.held) {
            (Some(s), Some((action, at))) => s.tick == at || action != Action::None,
            _ => false,
        }
    }

    /// What the engine reads: the account with its transfers in transit, as the token sent, each marked with where
    /// it goes (pb-read's rule: `to_hl` to Hyperliquid; a sale or a move home to NEAR).
    fn snapshot(&self) -> Account {
        let mut a = self.acct.clone();
        a.inflight = self
            .flight
            .iter()
            .map(|t| InFlight {
                token: t.token.clone(),
                units: t.units,
                overdue: false,
                to_hl: t.to_hl,
            })
            .collect();
        a
    }

    /// The engine's check, and what the keeper does with it.
    fn check(&mut self, m: &Market, tick: usize) -> Check {
        let eng = self.eng;
        let a = self.snapshot();
        let req = eng.requirement(&a, m);
        let clock_h = self.below_min as f64 / 60.0;
        let st = eng.state(&a, m, &req, clock_h, self.prev);
        // The time until the next check counts as below the buffer if this verdict is (PLAN.md 5.1).
        if st.state != State::Healthy && req.e < req.mr {
            self.below_min += 1;
        }
        self.prev = Some(st.state);
        self.held = Some((st.action, tick));
        if self.k.act {
            match st.action {
                Action::Deleverage => {
                    if self.confirms(tick, st.hl_ratio) {
                        self.out.confirmed.push(tick);
                        let plan = eng.deleverage_steps(&a, m, MAX_PLAN_STEPS, Routes::ALL);
                        self.store_and_run(m, tick, Action::Deleverage, &plan.steps);
                    } else if self.runnable() {
                        // An earlier plan's waiting steps go on while the verdict isn't NONE.
                        self.run_stored(m, tick);
                    }
                }
                Action::Rebalance | Action::RebalanceNow => {
                    self.first_at = None;
                    let plan = eng.rebalance_steps(&a, m, MAX_PLAN_STEPS, Routes::ALL);
                    self.store_and_run(m, tick, st.action, &plan.steps);
                }
                Action::None => self.first_at = None,
            }
        }
        Check {
            e: req.e,
            mr: req.mr,
            im: req.im,
            debt: a.debt,
            state: st.state,
            action: st.action,
            hl_ratio: st.hl_ratio,
            clock_h,
        }
    }

    /// The two-check rule for a DELEVERAGE verdict at `tick`: whether it confirms the plan.
    fn confirms(&mut self, tick: usize, hl_ratio: f64) -> bool {
        let at_once = hl_ratio >= self.eng.params.hl_ratio_emergency;
        let second = self
            .first_at
            .is_some_and(|f| tick - f == self.k.confirm_after);
        if at_once || second {
            // This verdict also opens the next pair.
            self.first_at = Some(tick);
            return true;
        }
        let stale = self
            .first_at
            .is_none_or(|f| tick - f > self.k.confirm_after);
        if stale {
            self.first_at = Some(tick);
        }
        false
    }

    fn store_and_run(&mut self, m: &Market, tick: usize, action: Action, steps: &[Step]) {
        let objs = wire(steps);
        let status = vec![Status::Pending; objs.len()];
        self.stored = Some(Stored {
            tick,
            action,
            objs,
            status,
        });
        self.run_stored(m, tick);
    }

    /// Runs every step of the stored plan that can run now. A repay waits while a sale before it in the plan hasn't
    /// landed (INTERFACES.md 13: the account repays only what it holds).
    fn run_stored(&mut self, m: &Market, tick: usize) {
        let Some(mut plan) = self.stored.take() else {
            return;
        };
        for i in 0..plan.objs.len() {
            if plan.status[i] != Status::Pending {
                continue;
            }
            if matches!(plan.objs[i], Obj::Repay { .. }) {
                let waiting = (0..i).any(|j| {
                    matches!(plan.objs[j], Obj::Sell { .. }) && plan.status[j] != Status::Landed
                });
                if waiting {
                    continue;
                }
            }
            let obj = plan.objs[i].clone();
            plan.status[i] = self.run_step(m, tick, &plan, i, &obj);
        }
        self.stored = Some(plan);
    }

    fn log(&mut self, tick: usize, plan: &Stored, kind: StepKind, what: &str, usd: f64, cost: f64) {
        self.out.steps.push(StepRun {
            tick,
            plan: plan.tick,
            action: plan.action,
            kind,
            what: what.to_string(),
            usd,
            cost,
            refused: None,
        });
    }

    fn refuse(
        &mut self,
        tick: usize,
        plan: &Stored,
        kind: StepKind,
        what: &str,
        usd: f64,
        why: String,
    ) -> Status {
        self.out.steps.push(StepRun {
            tick,
            plan: plan.tick,
            action: plan.action,
            kind,
            what: what.to_string(),
            usd,
            cost: 0.0,
            refused: Some(why),
        });
        Status::Refused
    }

    /// Whether the account and the pool let a sale or transfer of `value` dollars go now.
    fn may_send(&mut self, value: f64) -> Result<(), String> {
        if self.flight.len() >= self.k.max_transfers {
            return Err(format!(
                "{} transfers are under way already",
                self.k.max_transfers
            ));
        }
        if let Some(cap) = self.k.cosign_above {
            if self.steps_24h + value > cap {
                return Err(format!(
                    "past the pool's {} of plan steps in 24 hours, and no co-signature",
                    py::usd(cap)
                ));
            }
        }
        self.steps_24h += value;
        Ok(())
    }

    /// Money leaves now and arrives after the delay: `kind` sends `units` of `token` and delivers `usdc` USDC.
    fn send(
        &mut self,
        tick: usize,
        plan: &Stored,
        i: usize,
        kind: StepKind,
        sent: (&str, f64),
        usdc: f64,
    ) {
        let t = Transfer {
            kind,
            token: sent.0.to_string(),
            units: sent.1,
            usdc,
            to_hl: kind == StepKind::ToHl,
            sent: tick,
            arrives: tick + self.k.delay,
            plan: plan.tick,
            step: i,
        };
        self.out.transfers.push(t.clone());
        self.flight.push(t);
    }

    fn run_step(&mut self, m: &Market, tick: usize, plan: &Stored, i: usize, obj: &Obj) -> Status {
        let eng = self.eng;
        match obj {
            Obj::Perp { coin, dq } => {
                // A reduce-only order: it can only shrink the position.
                let q = self.acct.perps.get_or(coin, 0.0);
                if q == 0.0 || sgn(*dq) != -sgn(q) {
                    return self.refuse(
                        tick,
                        plan,
                        StepKind::Perp,
                        coin,
                        0.0,
                        "the position is gone".into(),
                    );
                }
                let dq = f64::from(sgn(*dq)) * py::min(dq.abs(), q.abs());
                let mark = m.mark_price(coin);
                let n = dq.abs() * mark;
                let f = eng.vol_factor(m, coin);
                let done = self.traded_hl.get(coin).copied().unwrap_or(0.0);
                let cost = marginal(|x| eng.cost_hl(coin, x, f), done, n);
                self.acct.hl_cash += q * (mark - self.acct.entry.get_or(coin, mark)) - cost;
                self.acct.entry.insert(coin, mark);
                self.acct.perps.insert(coin, q + dq);
                self.traded_hl.insert(coin.clone(), done + n);
                self.log(tick, plan, StepKind::Perp, coin, n, cost);
                Status::Done
            }
            Obj::Repay { usd } => {
                let usdc = self.acct.near.get_or("USDC", 0.0);
                let x = py::min3(*usd, usdc, self.acct.debt);
                if x <= 0.0 {
                    return self.refuse(
                        tick,
                        plan,
                        StepKind::Repay,
                        "USDC",
                        0.0,
                        "no USDC to repay with".into(),
                    );
                }
                self.acct.near.insert("USDC", usdc - x);
                self.acct.debt -= x;
                self.log(tick, plan, StepKind::Repay, "USDC", x, 0.0);
                Status::Done
            }
            Obj::Sell { token: tok, units } => {
                let held = self.acct.near.get_or(tok, 0.0);
                let units = py::min(*units, held);
                if units <= 0.0 {
                    return self.refuse(
                        tick,
                        plan,
                        StepKind::Sell,
                        tok,
                        0.0,
                        "nothing left to sell".into(),
                    );
                }
                let v = token_value(tok, units, m, 0.0, 0.0);
                if let Err(why) = self.may_send(v) {
                    return self.refuse(tick, plan, StepKind::Sell, tok, v, why);
                }
                let f = token(tok).group.map_or(1.0, |g| eng.vol_factor(m, g));
                let done = self.traded_1c.get(tok.as_str()).copied().unwrap_or(0.0);
                let cost = marginal(|x| cost_1c(tok, x, f), done, v);
                self.traded_1c.insert(tok.clone(), done + v);
                self.acct.near.insert(tok, held - units);
                self.send(tick, plan, i, StepKind::Sell, (tok, units), v - cost);
                self.log(tick, plan, StepKind::Sell, tok, v, cost);
                Status::Sent
            }
            Obj::ToHl { usd } => {
                let usdc = self.acct.near.get_or("USDC", 0.0);
                let x = py::min(*usd, usdc);
                if x <= ONE_CLICK_FEE {
                    return self.refuse(
                        tick,
                        plan,
                        StepKind::ToHl,
                        "USDC",
                        0.0,
                        "no USDC to move".into(),
                    );
                }
                if let Err(why) = self.may_send(x) {
                    return self.refuse(tick, plan, StepKind::ToHl, "USDC", x, why);
                }
                self.acct.near.insert("USDC", usdc - x);
                self.send(
                    tick,
                    plan,
                    i,
                    StepKind::ToHl,
                    ("USDC", x),
                    x - ONE_CLICK_FEE,
                );
                self.log(tick, plan, StepKind::ToHl, "USDC", x, ONE_CLICK_FEE);
                Status::Sent
            }
            Obj::Home { usd } => {
                let x = py::min(*usd, self.acct.hl_cash);
                if x <= ONE_CLICK_FEE || self.acct.perps.values().any(|&q| q != 0.0) {
                    return self.refuse(
                        tick,
                        plan,
                        StepKind::Home,
                        "USDC",
                        0.0,
                        "nothing to bring home".into(),
                    );
                }
                if let Err(why) = self.may_send(x) {
                    return self.refuse(tick, plan, StepKind::Home, "USDC", x, why);
                }
                self.acct.hl_cash -= x;
                self.send(
                    tick,
                    plan,
                    i,
                    StepKind::Home,
                    ("USDC", x),
                    x - ONE_CLICK_FEE,
                );
                self.log(tick, plan, StepKind::Home, "USDC", x, ONE_CLICK_FEE);
                Status::Sent
            }
        }
    }

    /// The account at the end of the tick, closed out at this minute's prices.
    fn record(&mut self, m: &Market, tick: usize, check: Option<Check>) {
        let eng = self.eng;
        let (mut near, mut near_cost) = (0.0, 0.0);
        for (t, &u) in self.acct.near.iter() {
            if u == 0.0 {
                continue;
            }
            let v = token_value(t, u, m, 0.0, 0.0);
            let f = token(t).group.map_or(1.0, |g| eng.vol_factor(m, g));
            let done = self.traded_1c.get(t).copied().unwrap_or(0.0);
            near += v;
            near_cost += marginal(|x| cost_1c(t, x, f), done, v);
        }
        let hl_eq = eng.hl_equity_now(&self.acct, m);
        let hl_cost = py::sum(
            self.acct
                .perps
                .iter()
                .filter(|(_, &q)| q != 0.0)
                .map(|(c, &q)| {
                    let n = q.abs() * m.mark_price(c);
                    let done = self.traded_hl.get(c).copied().unwrap_or(0.0);
                    marginal(|x| eng.cost_hl(c, x, eng.vol_factor(m, c)), done, n)
                }),
        );
        let inflight =
            eng.params.inflight_state_value * py::sum(self.flight.iter().map(|t| t.usdc));
        let closeout = py::max(0.0, near - near_cost) + py::max(0.0, hl_eq - hl_cost) + inflight;
        let debt = self.acct.debt;
        let pool_loss = if debt > 0.0 {
            py::min(debt, py::max(0.0, debt - closeout))
        } else {
            0.0
        };
        // Everything sold (less than a dollar left anywhere) and debt still owed.
        let nothing_left = self.flight.is_empty()
            && self.acct.perps.values().all(|&q| q == 0.0)
            && hl_eq <= 1.0
            && near <= 1.0;
        if debt > CENT && nothing_left && self.out.default_at.is_none() {
            self.out.default_at = Some(tick);
        }
        self.out.ticks.push(Tick {
            check,
            debt,
            near,
            near_cost,
            hl_eq,
            hl_cost,
            inflight,
            closeout,
            pool_loss,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenarios::{Kind, Scenario};

    fn map(pairs: &[(&str, f64)]) -> OrderedMap<f64> {
        pairs.iter().map(|&(k, v)| (k, v)).collect()
    }

    /// RISK_ENGINE.md 13.1: 1.2774 nBTC and the same BTC short, $35k of margin.
    fn hedged(eng: &Engine, debt: f64) -> Account {
        let p = eng.calm_market().price("BTC");
        let q = 100_000.0 / p;
        Account {
            near: map(&[("nBTC", q)]),
            hl_cash: 35_000.0,
            perps: map(&[("BTC", -q)]),
            entry: map(&[("BTC", p)]),
            debt,
            ..Account::default()
        }
    }

    /// RISK_ENGINE.md 13.4: $100k of USDC on NEAR; long SOL, short ETH, long HYPE and kPEPE on Hyperliquid.
    fn directional(eng: &Engine, hl: f64, debt: f64) -> Account {
        let m = eng.calm_market();
        let coins = [
            ("SOL", 150_000.0),
            ("ETH", -100_000.0),
            ("HYPE", 60_000.0),
            ("kPEPE", 30_000.0),
        ];
        Account {
            near: map(&[("USDC", 100_000.0)]),
            hl_cash: hl,
            perps: coins.iter().map(|&(c, x)| (c, x / m.price(c))).collect(),
            entry: coins.iter().map(|&(c, _)| (c, m.price(c))).collect(),
            debt,
            ..Account::default()
        }
    }

    /// The world's first `n` minutes only, for tests that don't need the whole window.
    fn cut(mut w: World, n: usize) -> World {
        w.truncate(n);
        w
    }

    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() <= 1e-6 * (1.0 + a.abs().max(b.abs()))
    }

    /// E(x) as the engine's replay scenario computes it at one point: everything sold, a week of carry paid.
    fn scenario_equity(
        eng: &Engine,
        world: &World,
        book: &Account,
        tick: &Tick,
        minute: usize,
        liquidated: bool,
    ) -> f64 {
        let m = world.market_at(minute);
        let p = &eng.params;
        let horizon = p.tau();
        let rate = p.base_rate(world.start.util) + book.tier.spec().spread;
        let interest = book.debt * rate * horizon;
        let mut funding = 0.0;
        if !liquidated {
            for (c, &q) in book.perps.iter().filter(|(_, &q)| q != 0.0) {
                funding += q * m.mark_price(c) * world.start.funding_of(c) * horizon;
            }
        }
        tick.near - tick.near_cost + tick.hl_eq - tick.hl_cost + tick.inflight
            - book.debt
            - interest
            - funding
    }

    #[test]
    fn with_nobody_acting_the_account_follows_the_engines_own_replay() {
        // The simulator's market and replica against the engine's replay scenario, window by window: the worst point
        // of every prefix of the path, so every minute that sets a new low is pinned, and the liquidation with it.
        let eng = Engine::v0();
        let start = eng.calm_market();
        for book in [
            hedged(&eng, 94_500.0),
            directional(&eng, 80_000.0, 79_015.0),
        ] {
            let e_now = eng.equity_mark(&book, &start);
            for w in 0..eng.replays.len() {
                let world = World::new(&eng, &start, &book, w);
                let out = simulate(&eng, &world, &book, &Keeper::passive());
                assert!(out.steps.is_empty() && out.transfers.is_empty());
                let sc: Scenario = eng.replay_scenarios(world.groups()).swap_remove(w);
                assert_eq!(sc.kind, Kind::Replay);
                let liq_tick = out.liquidations.first().map(|l| l.tick);
                let mut low = f64::INFINITY;
                for i in 0..world.minutes() {
                    let tick = &out.ticks[i + 1];
                    let liquidated = liq_tick.is_some_and(|t| t <= i + 1);
                    low = low.min(scenario_equity(&eng, &world, &book, tick, i, liquidated));
                    let prefix = Scenario {
                        path: sc.path[..=i].to_vec(),
                        ..sc.clone()
                    };
                    let (worst, _, det) = eng.run(&book, &start, &prefix, world.groups(), 0.0);
                    assert!(
                        near(worst, low),
                        "{} minute {i}: engine {worst}, simulator {low}",
                        world.window
                    );
                    let det = det.unwrap();
                    assert_eq!(
                        det.liq.is_some(),
                        liq_tick.is_some_and(|t| t <= det.stage + 1),
                        "{} minute {i}",
                        world.window
                    );
                    if let (Some(l), Some(ours)) = (det.liq, out.liquidations.first()) {
                        assert_eq!(l.kind, ours.kind);
                        assert!(near(l.eq, ours.hl_eq) && near(l.mmv, ours.mm));
                    }
                }
                // The whole window: the engine's replay loss is the drop to the simulator's low.
                let row = eng
                    .requirement(&book, &start)
                    .rows
                    .into_iter()
                    .find(|r| r.name == sc.name)
                    .unwrap();
                assert!(near(row.loss, e_now - low), "{}", world.window);
            }
        }
    }

    #[test]
    fn the_2020_rebound_backstops_the_short_at_minute_23() {
        // RISK_ENGINE.md 13.1's story: at minute 23 the short's Hyperliquid equity went from positive to −$2,446, below
        // 2/3 of its $1,718 maintenance margin, and the backstop took the account. Before that minute the account is
        // untouched; from it on, Hyperliquid holds nothing.
        let eng = Engine::v0();
        let start = eng.calm_market();
        let book = hedged(&eng, 94_500.0);
        let world = World::new(&eng, &start, &book, 1);
        let out = simulate(&eng, &world, &book, &Keeper::passive());
        // Where the replica says, worked out here from the world's marks alone.
        let q = book.perps["BTC"];
        let first = (0..world.minutes())
            .find(|&i| {
                let mark = world.market_at(i).mark_price("BTC");
                let eq = book.hl_cash + q * (mark - book.entry["BTC"]);
                eq < eng.mm("BTC", q.abs() * mark)
            })
            .unwrap();
        assert_eq!(first, 23);
        assert_eq!(out.liquidations.len(), 1);
        let l = &out.liquidations[0];
        assert_eq!((minute_of(l.tick), l.kind), (Some(23), LiqKind::Backstop));
        assert_eq!((l.hl_eq.round(), l.mm.round()), (-2_446.0, 1_718.0));
        for i in 0..world.minutes() {
            let hl = out.ticks[i + 1].hl_eq;
            if i < 23 {
                let mark = world.market_at(i).mark_price("BTC");
                assert_eq!(
                    hl,
                    eng.hl_equity_now(&book, &world.market_at(i)),
                    "minute {i}"
                );
                assert!(hl > eng.mm("BTC", q.abs() * mark), "minute {i}");
            } else {
                assert_eq!(hl, 0.0, "minute {i}");
            }
        }
    }

    /// A book that asks for a REBALANCE at once: a $50k BTC short on $1,200 of margin, $20k of USDC on NEAR, a loan.
    fn thin_short(eng: &Engine) -> Account {
        let p = eng.calm_market().price("BTC");
        Account {
            near: map(&[("USDC", 20_000.0)]),
            hl_cash: 1_200.0,
            perps: map(&[("BTC", -50_000.0 / p)]),
            entry: map(&[("BTC", p)]),
            debt: 5_000.0,
            ..Account::default()
        }
    }

    #[test]
    fn a_rebalance_lands_after_the_delay() {
        let eng = Engine::v0();
        let start = eng.calm_market();
        let book = thin_short(&eng);
        // 2024-08-05's fall: the short gains, so nothing but the transfer moves its margin early on.
        let world = cut(World::new(&eng, &start, &book, 6), 65);
        for delay in [0, 60] {
            let out = simulate(&eng, &world, &book, &Keeper::live(delay));
            let first = &out.transfers[0];
            assert_eq!(
                (first.kind, first.to_hl, first.sent),
                (StepKind::ToHl, true, 0)
            );
            assert_eq!(first.arrives, delay);
            let step = &out.steps[0];
            assert_eq!((step.kind, step.tick), (StepKind::ToHl, 0));
            assert!(matches!(
                step.action,
                Action::Rebalance | Action::RebalanceNow
            ));
            let sent = first.units;
            if delay == 0 {
                // Delay 0: on Hyperliquid by the end of the same minute.
                let t0 = &out.ticks[0];
                assert!(near(
                    t0.hl_eq,
                    eng.hl_equity_now(&book, &start) + sent - ONE_CLICK_FEE
                ));
                assert_eq!(t0.inflight, 0.0);
            } else {
                // Delay 60: in flight for an hour, then on Hyperliquid.
                for t in 0..60 {
                    assert!(
                        out.ticks[t].inflight >= 0.98 * (sent - ONE_CLICK_FEE) - 1e-9,
                        "tick {t}"
                    );
                }
                let before = out.ticks[59].hl_eq;
                let after = out.ticks[60].hl_eq;
                assert!(
                    after - before > sent - ONE_CLICK_FEE - 1_000.0,
                    "{before} -> {after}"
                );
            }
        }
    }

    #[test]
    fn money_already_on_its_way_is_not_sent_again() {
        // The case that over-sent: 13.4's book with $80k of margin and its full line, through 12 Mar 2020's fall. Before
        // the REBALANCE counted USDC in flight, a 15-minute delay sent $40,257 to Hyperliquid where 2 minutes sent
        // $12,563, and the extra margin raised MR into DELEVERAGE at minute 231. Now each check asks only for what isn't
        // already coming, so the delay changes what is sent by little.
        let eng = Engine::v0();
        let start = eng.calm_market();
        let mut book = directional(&eng, 80_000.0, 0.0);
        book.debt = eng.borrow_allowance(&book, &start, None, 0, None).w;
        let world = World::new(&eng, &start, &book, 0);
        let sent = |out: &Outcome| {
            py::sum(
                out.steps
                    .iter()
                    .filter(|s| s.kind == StepKind::ToHl && s.refused.is_none())
                    .map(|s| s.usd),
            )
        };
        let (fast, slow) = std::thread::scope(|s| {
            let fast = s.spawn(|| simulate(&eng, &world, &book, &Keeper::live(2)));
            let slow = s.spawn(|| simulate(&eng, &world, &book, &Keeper::live(15)));
            (fast.join().unwrap(), slow.join().unwrap())
        });
        let (two, fifteen) = (sent(&fast), sent(&slow));
        assert!(two > 5_000.0, "{two}");
        assert!(
            fifteen <= 1.05 * two,
            "15 minutes sent {fifteen}, 2 minutes {two}"
        );
        assert!(slow.steps.iter().all(|s| s.refused.is_none()));
        assert!(slow
            .ticks
            .iter()
            .filter_map(|t| t.check.as_ref())
            .all(|c| c.state != State::Deleverage));
    }

    #[test]
    fn a_deleverage_plan_runs_three_minutes_after_the_first_check() {
        // The hedged book with far too much debt: DELEVERAGE from the start, its margin ratio far from 80%.
        let eng = Engine::v0();
        let start = eng.calm_market();
        let book = hedged(&eng, 125_000.0);
        let world = cut(World::new(&eng, &start, &book, 6), 8);
        let out = simulate(&eng, &world, &book, &Keeper::live(15));
        let c0 = out.ticks[0].check.as_ref().unwrap();
        assert_eq!(c0.action, Action::Deleverage);
        assert!(c0.hl_ratio < 0.8);
        assert_eq!(out.confirmed[0], 3);
        assert!(out.steps.iter().all(|s| s.tick >= 3));
        assert_eq!(out.steps[0].tick, 3);
    }

    #[test]
    fn a_book_with_no_loan_never_costs_the_pool_anything() {
        // States bind only while there is a loan: no plan, no step, and nothing for the pool to lose.
        let eng = Engine::v0();
        let start = eng.calm_market();
        for book in [hedged(&eng, 0.0), directional(&eng, 80_000.0, 0.0)] {
            // The 2020 rebound's spike (minute 23) and the first half hour of 10 Oct 2025's crash.
            for w in [1, 8] {
                let world = cut(World::new(&eng, &start, &book, w), 30);
                let out = simulate(&eng, &world, &book, &Keeper::live(60));
                assert!(out.steps.is_empty() && out.transfers.is_empty());
                for t in &out.ticks {
                    assert_eq!(t.pool_loss, 0.0);
                    assert!(t.closeout >= 0.0);
                    let c = t.check.as_ref().unwrap();
                    assert_eq!((c.state, c.action), (State::Healthy, Action::None));
                }
            }
        }
    }

    #[test]
    fn steps_are_whole_and_at_most_four() {
        let eng = Engine::v0();
        let m = eng.calm_market();
        let mut a = hedged(&eng, 125_000.0);
        a.near.insert("USDC", 10.0);
        // The engine plans repay, pair, repay, pair, ...: the second pair would make 5 objects, so it waits.
        let plan = eng.deleverage_steps(&a, &m, 40, Routes::ALL);
        let kinds: Vec<&str> = wire(&plan.steps)
            .iter()
            .map(|o| match o {
                Obj::Perp { .. } => "perp",
                Obj::Repay { .. } => "repay",
                Obj::Sell { .. } => "sell",
                Obj::ToHl { .. } => "to_hl",
                Obj::Home { .. } => "home",
            })
            .collect();
        assert_eq!(kinds, ["repay", "perp", "sell", "repay"]);
    }

    #[test]
    fn marginal_costs_add_up_to_one_trade() {
        let eng = Engine::v0();
        let c = |x: f64| eng.cost_hl("BTC", x, 1.0);
        let one = marginal(c, 0.0, 300_000.0);
        let three = marginal(c, 0.0, 100_000.0)
            + marginal(c, 100_000.0, 100_000.0)
            + marginal(c, 200_000.0, 100_000.0);
        assert!(near(one, three));
        assert!(three > 3.0 * marginal(c, 0.0, 100_000.0));
    }
}
