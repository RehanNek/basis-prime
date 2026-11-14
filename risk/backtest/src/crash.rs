//! `backtest crash`: the backtest with rebalancing delays (PLAN.md 6.9 step 9, INTERFACES.md 20).
//!
//!     cargo run -p backtest --release -- crash [--delays 2,15,60] [--json <file>] [--cosign]
//!
//! Each book draws its full Standard line at the start of each of the ten crash-replay windows, and is then stepped
//! minute by minute with `risk_core::sim`: one check a minute, the keeper running the plans, money between NEAR and
//! Hyperliquid taking the delay, and Hyperliquid's replica liquidating when it says so. The books are RISK_ENGINE.md
//! 13.1's hedged book at full size and 13.4's directional book, with each of the two margins 13.4 gives it.
//!
//! For each book, window and delay it reports the lowest equity (its minute, and its ratio to IM and to the debt),
//! the states reached, Hyperliquid's liquidations, the plan steps run, and the pool's loss at the end and at its
//! worst. It prints the README's table (for each book and delay, the worst over the ten windows) and the cases that
//! liquidated or cost the pool money. `--json` writes every case, with the hashes of the two data files and the
//! command. Same inputs, same bytes. `--cosign` has the operator co-sign every plan step at once, where by default
//! no co-signature comes during the window.
use pb_risk::util::sha256_hex;
use risk_core::py::usd;
use risk_core::sim::{self, minute_of, Keeper, Outcome, World};
use risk_core::stress::LiqKind;
use risk_core::universe::{REPLAYS_V0, UNIVERSE_V0};
use risk_core::{Account, ClientTier, Engine, Market, OrderedMap, State};
use serde::Serialize;
use std::collections::BTreeMap;
use std::process::ExitCode;
use std::time::Instant;

/// One test account, before its loan.
pub struct Book {
    pub id: &'static str,
    pub name: &'static str,
    pub account: Account,
}

fn map(pairs: &[(&str, f64)]) -> OrderedMap<f64> {
    pairs.iter().map(|&(k, v)| (k, v)).collect()
}

/// RISK_ENGINE.md 13.1's hedged book at full size, and 13.4's directional book with each of its two margins, as
/// `examples.rs` builds them, Standard tier.
pub fn books(m: &Market) -> Vec<Book> {
    let p = m.price("BTC");
    let q = 100_000.0 / p;
    let hedged = Account {
        near: map(&[("nBTC", q)]),
        hl_cash: 35_000.0,
        perps: map(&[("BTC", -q)]),
        entry: map(&[("BTC", p)]),
        tier: ClientTier::Standard,
        ..Account::default()
    };
    let coins = [
        ("SOL", 150_000.0),
        ("ETH", -100_000.0),
        ("HYPE", 60_000.0),
        ("kPEPE", 30_000.0),
    ];
    let directional = |hl: f64| Account {
        near: map(&[("USDC", 100_000.0)]),
        hl_cash: hl,
        perps: coins.iter().map(|&(c, x)| (c, x / m.price(c))).collect(),
        entry: coins.iter().map(|&(c, _)| (c, m.price(c))).collect(),
        tier: ClientTier::Standard,
        ..Account::default()
    };
    vec![
        Book {
            id: "hedged",
            name: "13.1 hedged",
            account: hedged,
        },
        Book {
            id: "directional-80k",
            name: "13.4 directional, $80k margin",
            account: directional(80_000.0),
        },
        Book {
            id: "directional-200k",
            name: "13.4 directional, $200k margin",
            account: directional(200_000.0),
        },
    ]
}

/// What `crash` adds to `sim::ASSUMPTIONS`: the books and their loans.
pub const BOOK_ASSUMPTIONS: &[&str] = &[
    "Books: RISK_ENGINE.md 13.1's hedged book at full size (1.2774 nBTC, the same BTC short, $35k of margin), and \
     13.4's directional book ($100k of USDC on NEAR; long $150k SOL, short $100k ETH, long $60k HYPE and $30k kPEPE) \
     with each of the two margins 13.4 gives it, $80k and $200k. All Standard tier, on section 13's market: 4 Nov 2026 \
     prices, a $2M pool with $1.2M lent, so the Standard rate is 6.5%.",
    "The loan: each book draws its full Standard line, worked out by the engine at the window's start, and the money \
     leaves the account (RISK_ENGINE.md 7.2). The pool's $25k first-week limit is left out, as 13.1 does for an \
     account a week old.",
];

/// What to run.
pub struct Options {
    pub delays: Vec<usize>,
    /// The operator co-signs every plan step at once (no 24-hour limit on plan steps).
    pub cosign: bool,
    /// Only these books (by id) and windows (by index); all of them when None.
    pub books: Option<Vec<&'static str>>,
    pub windows: Option<Vec<usize>>,
    /// Only each window's first minutes (tests).
    pub minutes: Option<usize>,
}

impl Options {
    pub fn all(delays: Vec<usize>, cosign: bool) -> Options {
        Options {
            delays,
            cosign,
            books: None,
            windows: None,
            minutes: None,
        }
    }

    fn keeper(&self, delay: usize) -> Keeper {
        let mut k = Keeper::live(delay);
        if self.cosign {
            k.cosign_above = None;
        }
        k
    }
}

/// A book with its loan drawn, and the engine's check on it then.
pub struct Loaned {
    pub book: Book,
    pub loan: f64,
    /// The bound that sets the line (RISK_ENGINE.md 7.2).
    pub binding: String,
    pub e: f64,
    pub mr: f64,
    pub im: f64,
    pub state: State,
}

/// One book through one window with one delay.
pub struct Case {
    pub book: usize,
    pub delay: usize,
    pub out: Outcome,
}

pub struct Backtest {
    pub books: Vec<Loaned>,
    pub cases: Vec<Case>,
    pub options: Options,
}

/// Runs every case, book by book, window by window, delay by delay. Cases run on all the machine's cores; each is
/// independent, and they are put back in order, so the result doesn't depend on how many cores there are.
pub fn run(eng: &Engine, options: Options) -> Backtest {
    let m = eng.calm_market();
    let mut loaned = Vec::new();
    // (book, the account with its loan, window, delay)
    let mut jobs: Vec<(usize, Account, usize, usize)> = Vec::new();
    for book in books(&m) {
        if options
            .books
            .as_ref()
            .is_some_and(|ids| !ids.contains(&book.id))
        {
            continue;
        }
        let line = eng.borrow_allowance(&book.account, &m, None, 0, None);
        let a = Account {
            debt: line.w,
            ..book.account.clone()
        };
        let req = eng.requirement(&a, &m);
        let st = eng.state(&a, &m, &req, 0.0, None);
        let bi = loaned.len();
        loaned.push(Loaned {
            book,
            loan: line.w,
            binding: line.key,
            e: req.e,
            mr: req.mr,
            im: req.im,
            state: st.state,
        });
        for w in 0..eng.replays.len() {
            if options.windows.as_ref().is_some_and(|ws| !ws.contains(&w)) {
                continue;
            }
            for &delay in &options.delays {
                jobs.push((bi, a.clone(), w, delay));
            }
        }
    }
    let threads = std::thread::available_parallelism()
        .map_or(1, |n| n.get())
        .clamp(1, jobs.len().max(1));
    let one = |(bi, a, w, delay): &(usize, Account, usize, usize)| {
        let mut world = World::new(eng, &m, a, *w);
        if let Some(n) = options.minutes {
            world.truncate(n);
        }
        Case {
            book: *bi,
            delay: *delay,
            out: sim::simulate(eng, &world, a, &options.keeper(*delay)),
        }
    };
    let mut done: Vec<(usize, Case)> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..threads)
            .map(|t| {
                let (jobs, one) = (&jobs, &one);
                s.spawn(move || {
                    jobs.iter()
                        .enumerate()
                        .filter(|(i, _)| i % threads == t)
                        .map(|(i, job)| (i, one(job)))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().expect("a case panicked"))
            .collect()
    });
    done.sort_by_key(|(i, _)| *i);
    Backtest {
        books: loaned,
        cases: done.into_iter().map(|(_, c)| c).collect(),
        options,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// One case, summed up
// ---------------------------------------------------------------------------------------------------------------

/// Cents, without a negative zero.
fn cents(x: f64) -> f64 {
    let r = (x * 100.0).round() / 100.0;
    if r == 0.0 {
        0.0
    } else {
        r
    }
}

/// A ratio to 4 decimals, or None when it isn't a number.
fn ratio(x: f64) -> Option<f64> {
    x.is_finite().then(|| {
        let r = (x * 1e4).round() / 1e4;
        if r == 0.0 {
            0.0
        } else {
            r
        }
    })
}

/// "2020-03-12 up" from "2020-03-12 up (from 2020-03-13 02:16 UTC)".
fn short(window: &str) -> &str {
    window.split(" (").next().unwrap_or(window)
}

/// States from best to worst, DEFAULT last.
const STATES: [&str; 5] = ["HEALTHY", "WATCH", "MARGIN_CALL", "DELEVERAGE", "DEFAULT"];

fn rank(state: &str) -> usize {
    STATES.iter().position(|s| *s == state).unwrap_or(0)
}

#[derive(Serialize)]
struct LowOut {
    usd: f64,
    minute: Option<usize>,
    to_im: Option<f64>,
    to_debt: Option<f64>,
}

#[derive(Serialize)]
struct StateOut {
    state: &'static str,
    first_minute: Option<usize>,
}

#[derive(Serialize)]
struct LiqOut {
    minute: Option<usize>,
    kind: &'static str,
    /// Hyperliquid equity at the end of the minute before.
    hl_equity_before: f64,
    /// Hyperliquid equity and maintenance margin at the trigger.
    hl_equity: f64,
    mm: f64,
    lost: f64,
}

#[derive(Serialize, Default)]
struct KindOut {
    run: usize,
    refused: usize,
    usd: f64,
}

#[derive(Serialize)]
struct StepOut {
    minute: Option<usize>,
    plan_minute: Option<usize>,
    action: &'static str,
    k: &'static str,
    what: String,
    usd: f64,
    cost: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    refused: Option<String>,
}

#[derive(Serialize)]
struct StepsOut {
    run: usize,
    refused: usize,
    by_kind: BTreeMap<&'static str, KindOut>,
    list: Vec<StepOut>,
}

#[derive(Serialize)]
struct PoolOut {
    end: f64,
    worst: f64,
    worst_minute: Option<usize>,
}

#[derive(Serialize)]
struct EndOut {
    equity: f64,
    debt: f64,
    state: &'static str,
    closeout: f64,
}

#[derive(Serialize)]
struct CaseOut {
    book: &'static str,
    window: String,
    delay_min: usize,
    loan: f64,
    lowest_equity: LowOut,
    states: Vec<StateOut>,
    liquidations: Vec<LiqOut>,
    deleverage_confirmed: Vec<Option<usize>>,
    steps: StepsOut,
    pool_loss: PoolOut,
    end: EndOut,
}

fn liq_kind(k: LiqKind) -> &'static str {
    k.as_str()
}

/// The lowest equity of the window's minutes (the first, if two are equal): its tick and the check.
fn lowest(out: &Outcome) -> Option<(usize, &sim::Check)> {
    let mut best: Option<(usize, &sim::Check)> = None;
    for (t, tick) in out.ticks.iter().enumerate().skip(1) {
        if let Some(c) = &tick.check {
            if best.is_none_or(|(_, b)| c.e < b.e) {
                best = Some((t, c));
            }
        }
    }
    best
}

/// The states the window's minutes reached, each with its first minute, best to worst; DEFAULT if it came.
fn states(out: &Outcome) -> Vec<StateOut> {
    let mut first: BTreeMap<usize, usize> = BTreeMap::new();
    for (t, tick) in out.ticks.iter().enumerate().skip(1) {
        if let Some(c) = &tick.check {
            first.entry(rank(c.state.as_str())).or_insert(t);
        }
    }
    if let Some(t) = out.default_at {
        first.entry(rank("DEFAULT")).or_insert(t);
    }
    first
        .into_iter()
        .map(|(r, t)| StateOut {
            state: STATES[r],
            first_minute: minute_of(t),
        })
        .collect()
}

/// The worst pool loss over the window and its first minute (None when there was none).
fn worst_loss(out: &Outcome) -> (f64, Option<usize>) {
    let mut worst = (0.0, None);
    for (t, tick) in out.ticks.iter().enumerate() {
        if tick.pool_loss > worst.0 {
            worst = (tick.pool_loss, Some(t));
        }
    }
    worst
}

fn case_out(bt: &Backtest, c: &Case) -> CaseOut {
    let out = &c.out;
    let lo = lowest(out);
    let mut by_kind: BTreeMap<&'static str, KindOut> = BTreeMap::new();
    for s in &out.steps {
        let k = by_kind.entry(s.kind.as_str()).or_default();
        if s.refused.is_some() {
            k.refused += 1;
        } else {
            k.run += 1;
            k.usd += s.usd;
        }
    }
    for k in by_kind.values_mut() {
        k.usd = cents(k.usd);
    }
    let run = out.steps.iter().filter(|s| s.refused.is_none()).count();
    let (worst, worst_tick) = worst_loss(out);
    let last = out.ticks.last().expect("a window has minutes");
    let last_check = out
        .ticks
        .iter()
        .rev()
        .find_map(|t| t.check.as_ref())
        .expect("the keeper checks");
    CaseOut {
        book: bt.books[c.book].book.id,
        window: out.window.clone(),
        delay_min: c.delay,
        loan: cents(bt.books[c.book].loan),
        lowest_equity: LowOut {
            usd: lo.map_or(0.0, |(_, ch)| cents(ch.e)),
            minute: lo.and_then(|(t, _)| minute_of(t)),
            to_im: lo.and_then(|(_, ch)| ratio(ch.e / ch.im)),
            to_debt: lo
                .filter(|(_, ch)| ch.debt > 0.0)
                .and_then(|(_, ch)| ratio(ch.e / ch.debt)),
        },
        states: states(out),
        liquidations: out
            .liquidations
            .iter()
            .map(|l| LiqOut {
                minute: minute_of(l.tick),
                kind: liq_kind(l.kind),
                hl_equity_before: cents(l.hl_eq_before),
                hl_equity: cents(l.hl_eq),
                mm: cents(l.mm),
                lost: cents(l.lost),
            })
            .collect(),
        deleverage_confirmed: out.confirmed.iter().map(|&t| minute_of(t)).collect(),
        steps: StepsOut {
            run,
            refused: out.steps.len() - run,
            by_kind,
            list: out
                .steps
                .iter()
                .map(|s| StepOut {
                    minute: minute_of(s.tick),
                    plan_minute: minute_of(s.plan),
                    action: s.action.as_str(),
                    k: s.kind.as_str(),
                    what: s.what.clone(),
                    usd: cents(s.usd),
                    cost: cents(s.cost),
                    refused: s.refused.clone(),
                })
                .collect(),
        },
        pool_loss: PoolOut {
            end: cents(last.pool_loss),
            worst: cents(worst),
            worst_minute: worst_tick.and_then(minute_of),
        },
        end: EndOut {
            equity: cents(last_check.e),
            debt: cents(last.debt),
            state: if out.default_at.is_some() {
                "DEFAULT"
            } else {
                last_check.state.as_str()
            },
            closeout: cents(last.closeout),
        },
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The README table: for each book and delay, the worst over the windows
// ---------------------------------------------------------------------------------------------------------------

#[derive(Serialize)]
struct LiqWhere {
    window: String,
    minute: Option<usize>,
    kind: &'static str,
}

#[derive(Serialize)]
struct RowOut {
    book: &'static str,
    name: &'static str,
    loan: f64,
    delay_min: usize,
    windows: usize,
    lowest_equity: f64,
    lowest_window: String,
    lowest_minute: Option<usize>,
    to_im: Option<f64>,
    to_debt: Option<f64>,
    worst_state: &'static str,
    windows_in_worst_state: usize,
    liquidations: Vec<LiqWhere>,
    steps_run: usize,
    steps_refused: usize,
    pool_loss_end: f64,
    pool_loss_end_window: Option<String>,
    pool_loss_worst: f64,
    pool_loss_worst_window: Option<String>,
    pool_loss_worst_minute: Option<usize>,
}

fn rows(bt: &Backtest, cases: &[CaseOut]) -> Vec<RowOut> {
    let mut out = Vec::new();
    for b in &bt.books {
        for &delay in &bt.options.delays {
            let mine: Vec<&CaseOut> = cases
                .iter()
                .filter(|c| c.book == b.book.id && c.delay_min == delay)
                .collect();
            let Some(first) = mine.first() else { continue };
            let low = mine.iter().fold(*first, |best, c| {
                if c.lowest_equity.usd < best.lowest_equity.usd {
                    c
                } else {
                    best
                }
            });
            let worst_rank = mine
                .iter()
                .flat_map(|c| c.states.iter().map(|s| rank(s.state)))
                .max()
                .unwrap_or(0);
            let in_worst = mine
                .iter()
                .filter(|c| c.states.iter().any(|s| rank(s.state) == worst_rank))
                .count();
            let liquidations = mine
                .iter()
                .flat_map(|c| {
                    c.liquidations.iter().map(|l| LiqWhere {
                        window: short(&c.window).to_string(),
                        minute: l.minute,
                        kind: l.kind,
                    })
                })
                .collect();
            let end = mine.iter().fold(None::<&CaseOut>, |best, c| match best {
                Some(b) if b.pool_loss.end >= c.pool_loss.end => Some(b),
                _ if c.pool_loss.end > 0.0 => Some(c),
                _ => best,
            });
            let worst = mine.iter().fold(None::<&CaseOut>, |best, c| match best {
                Some(b) if b.pool_loss.worst >= c.pool_loss.worst => Some(b),
                _ if c.pool_loss.worst > 0.0 => Some(c),
                _ => best,
            });
            out.push(RowOut {
                book: b.book.id,
                name: b.book.name,
                loan: cents(b.loan),
                delay_min: delay,
                windows: mine.len(),
                lowest_equity: low.lowest_equity.usd,
                lowest_window: short(&low.window).to_string(),
                lowest_minute: low.lowest_equity.minute,
                to_im: low.lowest_equity.to_im,
                to_debt: low.lowest_equity.to_debt,
                worst_state: STATES[worst_rank],
                windows_in_worst_state: in_worst,
                liquidations,
                steps_run: mine.iter().map(|c| c.steps.run).sum(),
                steps_refused: mine.iter().map(|c| c.steps.refused).sum(),
                pool_loss_end: end.map_or(0.0, |c| c.pool_loss.end),
                pool_loss_end_window: end.map(|c| short(&c.window).to_string()),
                pool_loss_worst: worst.map_or(0.0, |c| c.pool_loss.worst),
                pool_loss_worst_window: worst.map(|c| short(&c.window).to_string()),
                pool_loss_worst_minute: worst.and_then(|c| c.pool_loss.worst_minute),
            });
        }
    }
    out
}

/// Dollars as the README writes them: "$1,234", "-$1,234".
fn dollars(x: f64) -> String {
    if x < 0.0 {
        format!("-{}", usd(-x))
    } else {
        usd(x)
    }
}

fn opt_ratio(x: Option<f64>) -> String {
    x.map_or("n/a".to_string(), |r| format!("{r:.2}"))
}

fn at(window: &str, minute: Option<usize>) -> String {
    match minute {
        Some(m) => format!("{window}, min {m}"),
        None => format!("{window}, start"),
    }
}

/// The README's table, in markdown.
fn markdown(rows: &[RowOut]) -> Vec<String> {
    let mut lines = vec![
        "| Book | Loan | Delay | Lowest equity (window, minute) | ÷ IM | ÷ debt | Worst state (windows) | Hyperliquid liquidations | Plan steps run (refused) | Pool loss at end | Worst pool loss (window, minute) |".to_string(),
        "|---|---:|---:|---|---:|---:|---|---|---:|---:|---|".to_string(),
    ];
    for r in rows {
        let liqs = if r.liquidations.is_empty() {
            "none".to_string()
        } else {
            let shown: Vec<String> = r
                .liquidations
                .iter()
                .take(3)
                .map(|l| format!("{} ({})", at(&l.window, l.minute), l.kind))
                .collect();
            let more = r.liquidations.len().saturating_sub(3);
            let tail = if more > 0 {
                format!("; {more} more")
            } else {
                String::new()
            };
            format!("{}: {}{tail}", r.liquidations.len(), shown.join("; "))
        };
        let end = match &r.pool_loss_end_window {
            Some(w) => format!("{} ({w})", dollars(r.pool_loss_end)),
            None => "$0".to_string(),
        };
        let worst = match &r.pool_loss_worst_window {
            Some(w) => format!(
                "{} ({})",
                dollars(r.pool_loss_worst),
                at(w, r.pool_loss_worst_minute)
            ),
            None => "$0".to_string(),
        };
        lines.push(format!(
            "| {} | {} | {} min | {} ({}) | {} | {} | {} ({} of {}) | {} | {} ({}) | {} | {} |",
            r.name,
            dollars(r.loan),
            r.delay_min,
            dollars(r.lowest_equity),
            at(&r.lowest_window, r.lowest_minute),
            opt_ratio(r.to_im),
            opt_ratio(r.to_debt),
            r.worst_state,
            r.windows_in_worst_state,
            r.windows,
            liqs,
            r.steps_run,
            r.steps_refused,
            end,
            worst
        ));
    }
    lines
}

/// Every case that liquidated, defaulted or cost the pool money, in words.
fn findings(bt: &Backtest, cases: &[CaseOut]) -> Vec<String> {
    let mut lines = Vec::new();
    for c in cases {
        let name = bt
            .books
            .iter()
            .find(|b| b.book.id == c.book)
            .map_or(c.book, |b| b.book.name);
        let mut what = Vec::new();
        for l in &c.liquidations {
            let minute = l.minute.map_or("start".to_string(), |m| m.to_string());
            let paid = match l.kind {
                "book" => format!("{} of slippage", dollars(l.lost)),
                _ => format!("the backstop kept {}", dollars(l.lost)),
            };
            what.push(format!(
                "Hyperliquid {} liquidation at minute {minute}: Hyperliquid equity {} a minute before, {} at the \
                 trigger against {} of maintenance margin; every perp closed, {paid}",
                l.kind,
                dollars(l.hl_equity_before),
                dollars(l.hl_equity),
                dollars(l.mm)
            ));
        }
        if c.states.iter().any(|s| s.state == "DEFAULT") {
            what.push("DEFAULT: everything sold and debt left".to_string());
        }
        if c.pool_loss.worst > 0.0 {
            what.push(format!(
                "pool loss {} at minute {} ({} at the end)",
                dollars(c.pool_loss.worst),
                c.pool_loss
                    .worst_minute
                    .map_or("start".to_string(), |m| m.to_string()),
                dollars(c.pool_loss.end)
            ));
        }
        if !what.is_empty() {
            lines.push(format!(
                "- {name}, {} min, {}: {}.",
                c.delay_min,
                short(&c.window),
                what.join("; ")
            ));
        }
    }
    lines
}

// ---------------------------------------------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------------------------------------------

#[derive(Serialize)]
struct KeeperOut {
    delays_min: Vec<usize>,
    checks_per_minute: u32,
    confirm_after_min: usize,
    max_plan_steps: usize,
    max_transfers: usize,
    /// The pool's 24-hour limit on plan steps; null when the operator co-signs at once.
    cosign_above: Option<f64>,
}

#[derive(Serialize)]
struct BookOut {
    id: &'static str,
    name: &'static str,
    near: OrderedMap<f64>,
    hl_cash: f64,
    perps: OrderedMap<f64>,
    loan: f64,
    binding: String,
    equity_after_loan: f64,
    mr: f64,
    im: f64,
    state: &'static str,
}

#[derive(Serialize)]
struct FileOut {
    v: u32,
    what: &'static str,
    command: String,
    /// sha256 of research/data/universe_v0.json (the verdict's `params`).
    params: String,
    /// sha256 of research/data/replays_v0.json.
    replays: String,
    model: &'static str,
    keeper: KeeperOut,
    assumptions: Vec<&'static str>,
    books: Vec<BookOut>,
    table: Vec<RowOut>,
    cases: Vec<CaseOut>,
}

const WHAT: &str = "INTERFACES.md 20: the backtest with rebalancing delays (PLAN.md 6.9 step 9). Money in USD. A minute \
                    counts the window's one-minute closes from 0, as RISK_ENGINE.md 13.1 does; null is the window's \
                    start, when the loan is drawn. `table` is the README's: for each book and delay, the worst over \
                    the windows.";

/// The report: the README's table, the findings, and the file's JSON for `command`.
pub struct Report {
    pub table: Vec<String>,
    pub findings: Vec<String>,
    pub json: String,
}

pub fn report(bt: &Backtest, command: &str) -> Report {
    let cases: Vec<CaseOut> = bt.cases.iter().map(|c| case_out(bt, c)).collect();
    let table = rows(bt, &cases);
    let lines = markdown(&table);
    let found = findings(bt, &cases);
    let k = bt.options.keeper(0);
    let file = FileOut {
        v: 1,
        what: WHAT,
        command: command.to_string(),
        params: sha256_hex(UNIVERSE_V0.as_bytes()),
        replays: sha256_hex(REPLAYS_V0.as_bytes()),
        model: pb_risk::verdict::MODEL,
        keeper: KeeperOut {
            delays_min: bt.options.delays.clone(),
            checks_per_minute: 1,
            confirm_after_min: k.confirm_after,
            max_plan_steps: sim::MAX_PLAN_STEPS,
            max_transfers: k.max_transfers,
            cosign_above: k.cosign_above,
        },
        assumptions: BOOK_ASSUMPTIONS
            .iter()
            .chain(sim::ASSUMPTIONS)
            .copied()
            .collect(),
        books: bt
            .books
            .iter()
            .map(|b| BookOut {
                id: b.book.id,
                name: b.book.name,
                near: b.book.account.near.clone(),
                hl_cash: b.book.account.hl_cash,
                perps: b.book.account.perps.clone(),
                loan: cents(b.loan),
                binding: b.binding.clone(),
                equity_after_loan: cents(b.e),
                mr: cents(b.mr),
                im: cents(b.im),
                state: b.state.as_str(),
            })
            .collect(),
        table,
        cases,
    };
    let json = serde_json::to_string_pretty(&file).expect("the report serialises") + "\n";
    Report {
        table: lines,
        findings: found,
        json,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------------------------

const USAGE: &str = "usage: backtest crash [--delays 2,15,60] [--json <file>] [--cosign]";

/// `crash [--delays 2,15,60] [--json <file>] [--cosign]`.
pub fn main(args: &[String]) -> ExitCode {
    let mut delays = vec![2, 15, 60];
    let mut json: Option<String> = None;
    let mut cosign = false;
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--delays" => {
                let parsed = it.next().and_then(|v| {
                    v.split(',')
                        .map(|d| d.trim().parse::<usize>().ok().filter(|&d| d <= 240))
                        .collect::<Option<Vec<usize>>>()
                });
                match parsed {
                    Some(d) if !d.is_empty() => delays = d,
                    _ => {
                        eprintln!("--delays needs minutes from 0 to 240, like 2,15,60");
                        return ExitCode::FAILURE;
                    }
                }
            }
            "--json" => match it.next() {
                Some(path) => json = Some(path.clone()),
                None => {
                    eprintln!("--json needs a file");
                    return ExitCode::FAILURE;
                }
            },
            "--cosign" => cosign = true,
            other => {
                eprintln!("unknown flag {other}\n{USAGE}");
                return ExitCode::FAILURE;
            }
        }
    }
    let started = Instant::now();
    let eng = Engine::v0();
    let bt = run(&eng, Options::all(delays, cosign));
    let command = ["cargo run -p backtest --release -- crash"]
        .into_iter()
        .chain(args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    let r = report(&bt, &command);
    for line in &r.table {
        println!("{line}");
    }
    println!();
    if r.findings.is_empty() {
        println!("No case liquidated on Hyperliquid or cost the pool anything.");
    } else {
        println!("Cases that liquidated on Hyperliquid or cost the pool money:");
        for line in &r.findings {
            println!("{line}");
        }
    }
    if let Some(path) = json {
        if let Err(e) = std::fs::write(&path, &r.json) {
            eprintln!("cannot write {path}: {e}");
            return ExitCode::FAILURE;
        }
        eprintln!("wrote {} cases to {path}", bt.cases.len());
    }
    eprintln!(
        "{} cases in {:.1} s",
        bt.cases.len(),
        started.elapsed().as_secs_f64()
    );
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_books_draw_section_13s_lines() {
        let eng = Engine::v0();
        let m = eng.calm_market();
        let lines: Vec<(String, String)> = books(&m)
            .iter()
            .map(|b| {
                let al = eng.borrow_allowance(&b.account, &m, None, 0, None);
                (
                    usd(al.w),
                    al.key.split(' ').next().unwrap_or("").to_string(),
                )
            })
            .collect();
        // RISK_ENGINE.md 13.1 ($94,500, the tier cap) and 13.4 ($79,015 at $80k of margin, C1; $140,620 at $200k, C3).
        let want = [("$94,500", "C4"), ("$79,015", "C1"), ("$140,620", "C3")];
        for ((got, key), (amount, bound)) in lines.iter().zip(want) {
            assert_eq!((got.as_str(), key.as_str()), (amount, bound));
        }
    }

    #[test]
    fn plans_are_capped_as_pb_risk_caps_them() {
        assert_eq!(sim::MAX_PLAN_STEPS, pb_risk::verdict::MAX_PLAN_STEPS);
    }

    fn small() -> Options {
        Options {
            delays: vec![2, 60],
            cosign: false,
            books: Some(vec!["hedged"]),
            windows: Some(vec![1]),
            minutes: Some(40),
        }
    }

    #[test]
    fn the_same_inputs_give_the_same_bytes() {
        let eng = Engine::v0();
        let a = report(&run(&eng, small()), "crash test");
        let b = report(&run(&eng, small()), "crash test");
        assert_eq!(a.json, b.json);
        assert_eq!(a.table, b.table);
        assert_eq!(a.findings, b.findings);
        // One row per book and delay, and the hashes of both data files.
        assert_eq!(a.table.len(), 2 + 2);
        let v: serde_json::Value = serde_json::from_str(&a.json).unwrap();
        assert_eq!(v["params"], pb_risk::verdict::params_hash());
        assert_eq!(v["cases"].as_array().unwrap().len(), 2);
        assert_eq!(v["command"], "crash test");
        // The 2020 rebound: the replica's backstop at minute 23 shows in the case, the table and the findings.
        assert!(
            a.table[2].contains("2020-03-12 up, min 23"),
            "{}",
            a.table[2]
        );
    }
}
