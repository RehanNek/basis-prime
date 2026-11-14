//! `backtest lender`: each lender's cushion over the ten crash windows (FUNDING.md 6.8, INTERFACES.md 27).
//!
//!     cargo run -p backtest --release -- lender [--json <file>]
//!
//! The question: how big must the cushion at an outside lender be? The book is the worked example: $100,000 of
//! bitcoin posted at the lender, a $100,000 BTC short on Hyperliquid, and a lender loan sized so the health factor
//! starts at the cushion being tested (1.2, 1.3, 1.5, 1.75 and 2.0). Each of the ten crash-replay windows is stepped
//! minute by minute on BTC's recorded path:
//!
//! - with nobody acting: the lowest health factor and its minute, and the first minute under 1.35, 1.2 and 1.0;
//! - with the lender liquidating and no top-up;
//! - with top-ups that land 2, 15 or 60 minutes after they are ordered: whether the lender liquidated first, how
//!   much collateral it sold, what its discount or bonus cost, and how much of the short is left uncovered.
//!
//! It prints the README's table (for each lender and cushion, the worst of the ten windows), then a second table
//! that doesn't depend on where a window starts (BTC's worst fall while a top-up is on its way, and the slowest
//! top-up each of the engine's levels survives), then every case that liquidated. It writes every case to
//! `research/data/backtest_lender_v0.json` (or `--json <file>`). Same inputs, same bytes: no clock, no randomness.
//! It runs beside `backtest crash` and shares nothing with it but the windows.
//!
//! The cushion levels themselves (`risk_core::lender`: 1.5, 1.35, 1.2) are read, never changed here.
use pb_risk::util::sha256_hex;
use risk_core::lender::{hf_bp, limit_micro, repay_to_target_micro, ACT_HF_BP, NOW_HF_BP, TARGET_HF_BP};
use risk_core::py::usd;
use risk_core::universe::REPLAYS_V0;
use risk_core::Engine;
use serde::Serialize;
use std::process::ExitCode;

const USD: u128 = 1_000_000;
const BP: u128 = 10_000;
/// A price is kept as parts per billion of the window's starting price.
const PPB: u128 = 1_000_000_000;
/// The lender liquidates under this health factor.
const LIQUIDATION_HF_BP: u32 = 10_000;

/// The worked example's bitcoin, and its short: $100,000 each at the window's start.
pub const BOOK_MICRO: u128 = 100_000 * USD;
/// The cushions tested, as starting health factors in bp (FUNDING.md 6.8).
pub const CUSHIONS_BP: [u32; 5] = [12_000, 13_000, 15_000, 17_500, 20_000];
/// How long a top-up takes to land, in minutes.
pub const DELAYS_MIN: [usize; 3] = [2, 15, 60];

// ---------------------------------------------------------------------------------------------------------------
// The lenders and what their liquidators do
// ---------------------------------------------------------------------------------------------------------------

/// How a lender's liquidators act once the health factor is under 1.0.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rule {
    /// Rhea: small slices at a discount, just enough to bring the health factor back to 1.0.
    HoldAtOne { discount_bp: u32 },
    /// Aave: one liquidator repays the most allowed, half the debt or all of it once the health factor is at or
    /// under `all_at_hf_bp`, and takes collateral worth that plus a bonus.
    CloseFactor { bonus_bp: u32, all_at_hf_bp: u32 },
}

/// One outside lender, as the backtest sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Lender {
    pub id: &'static str,
    pub name: &'static str,
    /// The lender liquidates when the debt passes this share of the collateral's value.
    pub liq_bp: u32,
    pub rule: Rule,
    /// Where each number came from.
    pub source: &'static str,
}

/// Rhea with nBTC against USDC, and Aave v3 on Ethereum with WBTC against USDC.
pub const LENDERS: [Lender; 2] = [
    Lender {
        id: "rhea",
        name: "Rhea",
        liq_bp: 7_600,
        rule: Rule::HoldAtOne { discount_bp: 30 },
        source: "Liquidation line 76%: nBTC's volatility ratio 8000 times USDC's 9500, in Rhea's health factor \
                 sum(c*p*vol)/sum(b*p/vol) (research/rhea.md items 3 and 4 and section 11, read on mainnet 10 Nov \
                 2026; FUNDING.md 6.3). Discount 0.3%: the figure research/scripts/rhea_warehouse.py uses in the \
                 last block of report(). Rhea's own rule is (1 - HF)/2, with no close factor, and the slices seen \
                 on chain were $150-250 at 0.24-0.28% (research/rhea.md items 3 and 9).",
    },
    Lender {
        id: "aave",
        name: "Aave (Ethereum)",
        liq_bp: 8_500,
        rule: Rule::CloseFactor { bonus_bp: 500, all_at_hf_bp: 9_500 },
        source: "WBTC on Aave v3 Ethereum (core): liquidation threshold 0.85 and liquidation bonus 0.05, from \
                 Aave's own API as saved in research/data/aave_live_2026-11-10.json (research/aave.md, 'Bitcoin as \
                 collateral'). Close factor: up to 50% of the whole debt, or all of it once the health factor is \
                 0.95 or lower; the collateral taken is the debt covered times the bonus (research/aave.md, 'Facts \
                 for the build').",
    },
];

/// One liquidation: the debt the liquidators repaid and the collateral value they took for it, in micro-USD at that
/// minute's price. The difference is what the discount or bonus cost the client.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Liquidated {
    pub repaid: u128,
    pub taken: u128,
}

impl Liquidated {
    pub fn cost(&self) -> u128 {
        self.taken.saturating_sub(self.repaid)
    }
}

/// Rhea's liquidators: with the health factor under 1.0 they repay just enough to bring it back to 1.0, taking
/// collateral worth the repayment ÷ (1 − discount). It is `rhea_warehouse.py`'s formula:
/// taken = (debt − liq × collateral) ÷ (1 − discount − liq), in whole micro-USD, rounded up so the health
/// factor ends at 1.0 or a hair over. If the collateral can't bring it back, all of it goes and debt is left.
pub fn hold_at_one(collateral: u128, liq_bp: u32, discount_bp: u32, owed: u128) -> Option<Liquidated> {
    let liq = u128::from(liq_bp);
    let short = (owed * BP).checked_sub(collateral * liq).filter(|&x| x > 0)?;
    if collateral == 0 {
        return None;
    }
    let keep = BP - u128::from(discount_bp).min(BP); // of each dollar taken, what repays debt, in bp
    let taken = match keep.checked_sub(liq).filter(|&d| d > 0) {
        Some(d) => short.div_ceil(d),
        None => collateral,
    };
    if taken >= collateral {
        return Some(Liquidated { repaid: (collateral * keep / BP).min(owed), taken: collateral });
    }
    Some(Liquidated { repaid: (taken * keep).div_ceil(BP).min(owed), taken })
}

/// Aave's liquidator: with the health factor under 1.0 it repays the most allowed, half the debt, or all of it once
/// the health factor is at or under `all_at_hf_bp` (0.95), and takes collateral worth that plus the bonus. If the
/// collateral can't cover it, all of it goes and debt is left.
pub fn close_factor(
    collateral: u128,
    liq_bp: u32,
    bonus_bp: u32,
    all_at_hf_bp: u32,
    owed: u128,
) -> Option<Liquidated> {
    let weighted = collateral * u128::from(liq_bp);
    if owed == 0 || collateral == 0 || weighted >= owed * BP {
        return None;
    }
    let most = if weighted <= owed * u128::from(all_at_hf_bp) { owed } else { owed / 2 };
    let with_bonus = BP + u128::from(bonus_bp);
    let taken = (most * with_bonus).div_ceil(BP);
    if taken > collateral {
        return Some(Liquidated { repaid: collateral * BP / with_bonus, taken: collateral });
    }
    Some(Liquidated { repaid: most, taken })
}

impl Lender {
    /// What this lender's liquidators do to a position this minute. `None` at a health factor of 1.0 or more.
    pub fn liquidation(&self, collateral: u128, owed: u128) -> Option<Liquidated> {
        match self.rule {
            Rule::HoldAtOne { discount_bp } => hold_at_one(collateral, self.liq_bp, discount_bp, owed),
            Rule::CloseFactor { bonus_bp, all_at_hf_bp } => {
                close_factor(collateral, self.liq_bp, bonus_bp, all_at_hf_bp, owed)
            }
        }
    }

    /// The loan that starts the health factor at `cushion_bp` on the worked example's bitcoin.
    pub fn loan(&self, cushion_bp: u32) -> u128 {
        limit_micro(BOOK_MICRO, self.liq_bp, cushion_bp)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The windows
// ---------------------------------------------------------------------------------------------------------------

/// One crash window: BTC's price at each minute, as parts per billion of the price at the window's start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Window {
    pub name: String,
    pub px: Vec<u128>,
}

/// The ten windows, on BTC's path in the engine's own replay (`risk_core::replay`): the recorded one-minute closes.
pub fn windows(eng: &Engine) -> Vec<Window> {
    let replays = eng.replay_scenarios(&["BTC".to_string()]);
    eng.replays
        .iter()
        .zip(replays)
        .map(|(w, sc)| Window {
            name: w.name.clone(),
            px: sc.path.iter().map(|stage| ((1.0 + stage[0][0]) * 1e9).round().max(0.0) as u128).collect(),
        })
        .collect()
}

/// What `units` of bitcoin (micro-USD at the window's start) are worth at price `px`.
fn value(units: u128, px: u128) -> u128 {
    units * px / PPB
}

// ---------------------------------------------------------------------------------------------------------------
// One position through one window
// ---------------------------------------------------------------------------------------------------------------

/// The position left alone, by the lender too: the health factor at each minute's price.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Path {
    pub lowest_hf_bp: u32,
    pub lowest_minute: usize,
    /// The first minute under the act level (1.35), the act-now level (1.2) and 1.0.
    pub under_act: Option<usize>,
    pub under_now: Option<usize>,
    pub under_one: Option<usize>,
}

pub fn path(l: &Lender, cushion_bp: u32, w: &Window) -> Path {
    let owed = l.loan(cushion_bp);
    let hf = |&px: &u128| hf_bp(value(BOOK_MICRO, px), l.liq_bp, owed).unwrap_or(u32::MAX);
    let hfs: Vec<u32> = w.px.iter().map(hf).collect();
    let (lowest_minute, lowest_hf_bp) =
        hfs.iter().copied().enumerate().min_by_key(|&(i, hf)| (hf, i)).expect("a window has minutes");
    let under = |level: u32| hfs.iter().position(|&hf| hf < level);
    Path {
        lowest_hf_bp,
        lowest_minute,
        under_act: under(ACT_HF_BP),
        under_now: under(NOW_HF_BP),
        under_one: under(LIQUIDATION_HF_BP),
    }
}

/// One minute's liquidation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiqEvent {
    pub minute: usize,
    /// The health factor the lender saw.
    pub hf_bp: u32,
    pub liq: Liquidated,
    /// The bitcoin taken, in micro-USD at the window's start.
    pub units: u128,
    /// The health factor after it; `None` with no debt left.
    pub hf_after_bp: Option<u32>,
}

/// One top-up: a repayment ordered at one minute's check that lands `delay` minutes later.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TopUp {
    pub ordered: usize,
    pub lands: usize,
    /// The health factor that ordered it.
    pub hf_bp: u32,
    /// What was ordered: enough to bring the health factor back to the target at the ordering minute's price.
    pub amount: u128,
    /// What it repaid when it landed (never more than was still owed). `None` if the window ended first.
    pub repaid: Option<u128>,
}

/// One position through one window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub loan: u128,
    /// The lowest health factor the lender saw, before it or we acted that minute, and the minute.
    pub lowest: Option<(u32, usize)>,
    pub liquidations: Vec<LiqEvent>,
    pub top_ups: Vec<TopUp>,
    /// At the window's last minute: the bitcoin left (micro-USD at the start), its value then, and the debt.
    pub units: u128,
    pub collateral: u128,
    pub owed: u128,
    pub last_px: u128,
}

impl Outcome {
    pub fn repaid(&self) -> u128 {
        self.liquidations.iter().map(|e| e.liq.repaid).sum()
    }
    /// The collateral the lender's liquidators took, each slice at the price of its minute.
    pub fn sold(&self) -> u128 {
        self.liquidations.iter().map(|e| e.liq.taken).sum()
    }
    /// What the discount or bonus cost.
    pub fn cost(&self) -> u128 {
        self.liquidations.iter().map(|e| e.liq.cost()).sum()
    }
    /// The bitcoin sold, in micro-USD at the window's start: the share of the hedge left without bitcoin behind it.
    pub fn units_sold(&self) -> u128 {
        self.liquidations.iter().map(|e| e.units).sum()
    }
    /// The short left uncovered: the bitcoin sold, at the window's last price.
    pub fn uncovered(&self) -> u128 {
        value(self.units_sold(), self.last_px)
    }
    /// Whether the first liquidation came before any top-up had landed. `None` if nothing was liquidated.
    pub fn liquidated_first(&self) -> Option<bool> {
        let first = self.liquidations.first()?.minute;
        // The lender acts before a top-up due the same minute lands.
        Some(!self.top_ups.iter().any(|t| t.repaid.is_some() && t.lands < first))
    }
}

/// Steps one position through one window. `delay` is how long a top-up takes; `None` orders none.
///
/// Each minute, in order: the price moves; the lender liquidates if the health factor is under 1.0; a top-up due
/// this minute lands; our check orders a top-up if the health factor is under the act level and none is on its way.
pub fn simulate(l: &Lender, cushion_bp: u32, w: &Window, delay: Option<usize>) -> Outcome {
    let loan = l.loan(cushion_bp);
    let (mut units, mut owed) = (BOOK_MICRO, loan);
    let mut lowest: Option<(u32, usize)> = None;
    let mut liquidations = Vec::new();
    let mut top_ups: Vec<TopUp> = Vec::new();
    let mut on_its_way = false;
    for (i, &px) in w.px.iter().enumerate() {
        // The lender.
        let collateral = value(units, px);
        if let Some(hf) = hf_bp(collateral, l.liq_bp, owed) {
            if lowest.is_none_or(|(low, _)| hf < low) {
                lowest = Some((hf, i));
            }
            if let Some(liq) = l.liquidation(collateral, owed) {
                // The bitcoin that value is, rounded down, so what is left is worth no less than the lender counts.
                let taken = if liq.taken >= collateral || px == 0 { units } else { (liq.taken * PPB / px).min(units) };
                units -= taken;
                owed -= liq.repaid;
                liquidations.push(LiqEvent {
                    minute: i,
                    hf_bp: hf,
                    liq,
                    units: taken,
                    hf_after_bp: hf_bp(value(units, px), l.liq_bp, owed),
                });
            }
        }
        // A top-up due this minute lands.
        if on_its_way {
            let t = top_ups.last_mut().expect("the top-up on its way");
            if t.lands == i {
                let repaid = t.amount.min(owed);
                owed -= repaid;
                t.repaid = Some(repaid);
                on_its_way = false;
            }
        }
        // Our check.
        if let (Some(delay), false) = (delay, on_its_way) {
            let collateral = value(units, px);
            if let Some(hf) = hf_bp(collateral, l.liq_bp, owed).filter(|&hf| hf < ACT_HF_BP) {
                let amount = repay_to_target_micro(collateral, l.liq_bp, TARGET_HF_BP, owed);
                if amount > 0 {
                    top_ups.push(TopUp { ordered: i, lands: i + delay, hf_bp: hf, amount, repaid: None });
                    on_its_way = true;
                }
            }
        }
    }
    let last_px = w.px.last().copied().unwrap_or(PPB);
    Outcome { loan, lowest, liquidations, top_ups, units, collateral: value(units, last_px), owed, last_px }
}

// ---------------------------------------------------------------------------------------------------------------
// The worst fall while a top-up is on its way
// ---------------------------------------------------------------------------------------------------------------

/// BTC's worst fall over some number of closes, anywhere in the ten windows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fall {
    pub window: usize,
    /// The minute it fell from; `None` is the window's start.
    pub from: Option<usize>,
    pub to: usize,
    pub from_px: u128,
    pub to_px: u128,
}

impl Fall {
    /// The fall, in bp of the price it fell from, to the nearest.
    pub fn fall_bp(&self) -> u128 {
        ((self.from_px - self.to_px.min(self.from_px)) * BP + self.from_px / 2) / self.from_px
    }
    /// The lowest health factor that is still 1.0 or more after this fall, in bp, rounded up.
    pub fn level_needed_bp(&self) -> u128 {
        if self.to_px == 0 {
            return u128::MAX;
        }
        (self.from_px * BP).div_ceil(self.to_px)
    }
    /// Whether a position at `hf_bp` before the fall is still at 1.0 or more after it.
    pub fn survived_from(&self, hf_bp: u32) -> bool {
        u128::from(hf_bp) * self.to_px >= BP * self.from_px
    }
    fn worse_than(&self, other: &Fall) -> bool {
        self.to_px * other.from_px < other.to_px * self.from_px
    }
}

/// `falls[k - 1]` is BTC's worst fall over any `k` closes or fewer, from the start or any minute of any window
/// (the first found of equals). A top-up that takes `d` minutes is exposed to `d + 1` closes: the position was
/// last seen at or over the act level one close before the check that orders it, and the lender sees every close
/// up to the minute it lands, before it lands.
pub fn worst_falls(ws: &[Window]) -> Vec<Fall> {
    let longest = ws.iter().map(|w| w.px.len()).max().unwrap_or(0);
    let mut falls: Vec<Option<Fall>> = vec![None; longest];
    for (wi, w) in ws.iter().enumerate() {
        // Tick 0 is the start, tick t + 1 is minute t.
        let px: Vec<u128> = std::iter::once(PPB).chain(w.px.iter().copied()).collect();
        for from in 0..px.len() {
            for to in from + 1..px.len() {
                let f = Fall { window: wi, from: from.checked_sub(1), to: to - 1, from_px: px[from], to_px: px[to] };
                let slot = &mut falls[to - from - 1];
                if slot.is_none_or(|best| f.worse_than(&best)) {
                    *slot = Some(f);
                }
            }
        }
    }
    // Over k closes or fewer: the worst of the spans up to k.
    let mut out: Vec<Fall> = Vec::with_capacity(longest);
    for f in falls.into_iter().flatten() {
        match out.last() {
            Some(best) if !f.worse_than(best) => out.push(*best),
            _ => out.push(f),
        }
    }
    out
}

/// The longest whole-minute top-up delay a position at `hf_bp` survives wherever in the windows it starts.
/// `None` if not even a top-up that lands the minute it is ordered is in time.
pub fn longest_delay(falls: &[Fall], hf_bp: u32) -> Option<usize> {
    falls.iter().take_while(|f| f.survived_from(hf_bp)).count().checked_sub(1)
}

/// One case: a lender, a cushion, a window, and how late top-ups are (`None`: there are none).
pub struct Case {
    pub lender: usize,
    pub cushion_bp: u32,
    pub window: usize,
    pub delay: Option<usize>,
    pub out: Outcome,
}

pub struct Backtest {
    pub windows: Vec<Window>,
    pub cases: Vec<Case>,
}

/// The modes of a position, in the table's order: no top-up, then each delay.
fn modes() -> Vec<Option<usize>> {
    std::iter::once(None).chain(DELAYS_MIN.iter().copied().map(Some)).collect()
}

/// Every case: lender by lender, cushion by cushion, window by window, mode by mode.
pub fn run(eng: &Engine) -> Backtest {
    let windows = windows(eng);
    let mut cases = Vec::new();
    for (li, l) in LENDERS.iter().enumerate() {
        for cushion_bp in CUSHIONS_BP {
            for (wi, w) in windows.iter().enumerate() {
                for delay in modes() {
                    let out = simulate(l, cushion_bp, w, delay);
                    cases.push(Case { lender: li, cushion_bp, window: wi, delay, out });
                }
            }
        }
    }
    Backtest { windows, cases }
}

// ---------------------------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------------------------

/// The simulation's choices, in words.
pub const ASSUMPTIONS: &[&str] = &[
    "The book: the worked example (FUNDING.md 2). $100,000 of bitcoin posted at the lender and a $100,000 BTC short \
     on Hyperliquid, both at the window's starting price, before its first one-minute close (as `backtest crash` \
     draws its loans). The lender's loan is the most that keeps the health factor at the cushion being tested \
     (risk_core::lender::limit_micro, rounded down), so the first minute's price already moves it. Our own pool's \
     part of the loan, Hyperliquid's margin and the short's own liquidation are not modelled here: `backtest crash` \
     covers them.",
    "Prices: BTC's path in the engine's own replay of each window (RISK_ENGINE.md 4.5): the recorded one-minute \
     closes, 240 a window, kept as parts per billion of the starting price. Both lenders are taken to price the \
     bitcoin as BTC: Rhea reads Pyth's BTC/USD for nBTC (research/rhea.md 11); for Aave's WBTC it is our reading. So \
     the replay's 2% bridge depeg and its perp gap are not applied. A lender sees each minute's close and nothing \
     inside the minute; its price feed is never late or wrong.",
    "Health factor: the collateral's value times the lender's liquidation ratio, over the debt, in basis points \
     rounded down (risk_core::lender::hf_bp). The lender liquidates under 10000. No interest accrues over the four \
     hours (at Rhea's 15.91% it is under $4 on $50,667), and gas is left out.",
    "Order within a minute: the price moves; the lender liquidates at the new price if the health factor is under \
     1.0; then a top-up due that minute lands; then our check runs and may order the next top-up. So a top-up that \
     lands in the minute the lender liquidates comes second, and counts as late.",
    "Top-ups: our check runs once a minute. When the health factor is under 1.35 (risk_core::lender::ACT_HF_BP) and \
     no top-up is on its way, one is ordered: a repayment sized to bring the health factor back to 1.5 \
     (TARGET_HF_BP) at that minute's price (repay_to_target_micro). It lands 2, 15 or 60 minutes later with the \
     amount ordered, whatever the price did meanwhile, never more than is still owed; the next can be ordered at \
     that same minute's check. A cushion that starts under 1.35 orders its top-up at minute 0. The 1.2 level \
     (NOW_HF_BP) changes nothing here: it is the same plan with the same delay. A top-up due after the window's \
     last minute does not land.",
    "The top-up's money is taken to be there. The backtest does not check that Hyperliquid has it to send: in a \
     fall the short's winnings are about twice what a top-up from 1.35 to 1.5 needs, but a top-up ordered at minute \
     0 (cushions 1.2 and 1.3) has no winnings behind it and must come from the client's own USDC.",
    "Rhea's liquidators: in every minute the health factor is under 1.0 they repay just enough debt to bring it \
     back to 1.0 at that minute's price, and take collateral worth the repayment / (1 - 0.3%): the formula of \
     research/scripts/rhea_warehouse.py, taken = (debt - 0.76 x collateral) / (1 - 0.003 - 0.76). A minute's slices \
     are added into one. Rhea's own rule is a discount of (1 - HF)/2 and a health factor left just under 1.0 \
     (research/rhea.md 3); the flat 0.3% understates the cost in a minute that gaps far under 1.0 (each case's \
     `lowest_liquidation_hf_bp` shows how far it went).",
    "Aave's liquidator: in a minute the health factor is under 1.0, one liquidator repays the most allowed, half \
     the debt, or all of it when the health factor is 0.95 or lower, and takes collateral worth that plus the 5% \
     bonus (WBTC on Ethereum). Taking the most allowed is our reading: a liquidator is paid by size. If the \
     collateral cannot cover it, all of it is taken and debt is left. Which Aave version runs on Ethereum is not \
     confirmed (research/aave.md), and newer versions' special rules for small positions are not modelled.",
    "The hedge: the liquidators keep the bitcoin they take and nobody trims the short during the window. \
     `collateral_sold` is the bitcoin taken, each slice at the price of its minute. `penalty` is that less the debt \
     it repaid. `short_uncovered` is the bitcoin sold at the window's last price: the part of the short with no \
     bitcoin behind it then. `btc_sold_bp` is the share of the bitcoin, which is also the share of the short.",
    "The second table does not depend on where a window happens to start. `worst_falls` is BTC's worst fall over \
     the closes a top-up is exposed to, from the start or any minute of any window: its delay plus one, because the \
     position was last seen at or over the act level one close before the check that orders the top-up, and the \
     lender sees every close up to the minute it lands, before it lands. A top-up ordered from a health factor \
     under `level_needed_bp` could come too late. `levels_hold` is the longest whole-minute delay each of the \
     engine's levels survives that way. Both are the same for every lender: a fall moves every health factor by \
     the same share. Falls that run past a window's 240 minutes are not seen.",
    "The table's worst case, for each lender, cushion and mode, is the window where the lender sold the most \
     collateral (the first of equals). Its lowest health factor column is the position left alone by everyone, \
     the lender too.",
];

/// Micro-USD as dollars to the cent.
fn money(micro: u128) -> f64 {
    ((micro + 5_000) / 10_000) as f64 / 100.0
}

/// Micro-USD as the README writes dollars: "$1,234".
fn dollars(micro: u128) -> String {
    usd(micro as f64 / 1e6)
}

/// A health factor in bp as "1.2345".
fn hf_text(bp: u32) -> String {
    format!("{}.{:04}", bp / 10_000, bp % 10_000)
}

/// A cushion in bp as "1.2", "1.75", "2.0".
fn cushion_text(bp: u32) -> String {
    let s = format!("{}.{:02}", bp / 10_000, bp % 10_000 / 100);
    s.strip_suffix('0').map_or(s.clone(), str::to_string)
}

/// A share in bp as "35.6%".
fn pct_text(bp: u128) -> String {
    format!("{}.{}%", bp / 100, bp % 100 / 10)
}

/// A share in bp as "23.63%".
fn pct_text2(bp: u128) -> String {
    format!("{}.{:02}%", bp / 100, bp % 100)
}

/// "2020-03-12 down" from "2020-03-12 down (from 2020-03-12 22:25 UTC)".
fn short(window: &str) -> &str {
    window.split(" (").next().unwrap_or(window)
}

fn mode_text(delay: Option<usize>) -> String {
    delay.map_or("no top-up".to_string(), |d| format!("top-up in {d} min"))
}

/// A share of the worked example's bitcoin, in bp, to the nearest.
fn share_bp(units: u128) -> u128 {
    (units * BP + BOOK_MICRO / 2) / BOOK_MICRO
}

#[derive(Serialize)]
struct LenderOut {
    id: &'static str,
    name: &'static str,
    liq_bp: u32,
    /// Rhea's discount, or Aave's bonus.
    penalty_bp: u32,
    /// Aave only: the liquidator may repay all the debt at or under this health factor, half of it above.
    #[serde(skip_serializing_if = "Option::is_none")]
    all_at_hf_bp: Option<u32>,
    rule: &'static str,
    source: &'static str,
}

#[derive(Serialize)]
struct PathOut {
    lender: &'static str,
    cushion_bp: u32,
    window: String,
    loan: f64,
    lowest_hf_bp: u32,
    lowest_minute: usize,
    first_minute_under_act: Option<usize>,
    first_minute_under_now: Option<usize>,
    first_minute_under_10000: Option<usize>,
}

#[derive(Serialize)]
struct LiqOut {
    minute: usize,
    hf_bp: u32,
    repaid: f64,
    collateral_sold: f64,
    penalty: f64,
    hf_after_bp: Option<u32>,
}

#[derive(Serialize)]
struct TopUpOut {
    ordered_minute: usize,
    lands_minute: usize,
    hf_bp: u32,
    ordered: f64,
    /// What it repaid; null if the window ended before it landed.
    repaid: Option<f64>,
}

#[derive(Serialize)]
struct EndOut {
    hf_bp: Option<u32>,
    debt: f64,
    collateral: f64,
    btc_left_bp: u128,
}

#[derive(Serialize)]
struct CaseOut {
    lender: &'static str,
    cushion_bp: u32,
    window: String,
    /// null: no top-ups.
    top_up_delay_min: Option<usize>,
    loan: f64,
    lowest_hf_bp: Option<u32>,
    lowest_minute: Option<usize>,
    liquidated: bool,
    first_liquidation_minute: Option<usize>,
    /// Whether the first liquidation came before any top-up had landed; null if nothing was liquidated.
    liquidated_before_a_top_up_landed: Option<bool>,
    liquidation_minutes: usize,
    lowest_liquidation_hf_bp: Option<u32>,
    repaid_by_liquidators: f64,
    collateral_sold: f64,
    penalty: f64,
    btc_sold_bp: u128,
    short_uncovered: f64,
    top_up_ordered_at_minute_0: bool,
    top_ups_landed: usize,
    top_ups_repaid: f64,
    top_ups: Vec<TopUpOut>,
    liquidations: Vec<LiqOut>,
    end: EndOut,
}

fn case_out(bt: &Backtest, c: &Case) -> CaseOut {
    let (l, o) = (&LENDERS[c.lender], &c.out);
    CaseOut {
        lender: l.id,
        cushion_bp: c.cushion_bp,
        window: bt.windows[c.window].name.clone(),
        top_up_delay_min: c.delay,
        loan: money(o.loan),
        lowest_hf_bp: o.lowest.map(|(hf, _)| hf),
        lowest_minute: o.lowest.map(|(_, i)| i),
        liquidated: !o.liquidations.is_empty(),
        first_liquidation_minute: o.liquidations.first().map(|e| e.minute),
        liquidated_before_a_top_up_landed: o.liquidated_first(),
        liquidation_minutes: o.liquidations.len(),
        lowest_liquidation_hf_bp: o.liquidations.iter().map(|e| e.hf_bp).min(),
        repaid_by_liquidators: money(o.repaid()),
        collateral_sold: money(o.sold()),
        penalty: money(o.cost()),
        btc_sold_bp: share_bp(o.units_sold()),
        short_uncovered: money(o.uncovered()),
        top_up_ordered_at_minute_0: o.top_ups.first().is_some_and(|t| t.ordered == 0),
        top_ups_landed: o.top_ups.iter().filter(|t| t.repaid.is_some()).count(),
        top_ups_repaid: money(o.top_ups.iter().filter_map(|t| t.repaid).sum()),
        top_ups: o
            .top_ups
            .iter()
            .map(|t| TopUpOut {
                ordered_minute: t.ordered,
                lands_minute: t.lands,
                hf_bp: t.hf_bp,
                ordered: money(t.amount),
                repaid: t.repaid.map(money),
            })
            .collect(),
        liquidations: o
            .liquidations
            .iter()
            .map(|e| LiqOut {
                minute: e.minute,
                hf_bp: e.hf_bp,
                repaid: money(e.liq.repaid),
                collateral_sold: money(e.liq.taken),
                penalty: money(e.liq.cost()),
                hf_after_bp: e.hf_after_bp,
            })
            .collect(),
        end: EndOut {
            hf_bp: hf_bp(o.collateral, l.liq_bp, o.owed),
            debt: money(o.owed),
            collateral: money(o.collateral),
            btc_left_bp: share_bp(o.units),
        },
    }
}

/// One cell of the README's table: a lender and cushion in one mode, the worst of the windows.
#[derive(Serialize)]
struct CellOut {
    /// null: no top-ups.
    top_up_delay_min: Option<usize>,
    windows: usize,
    windows_liquidated: usize,
    /// The lowest health factor the lender saw in any window.
    lowest_hf_bp: Option<u32>,
    /// The window where the lender sold the most, and what it sold there. Null and zeros if none liquidated.
    worst_window: Option<String>,
    first_liquidation_minute: Option<usize>,
    liquidated_before_a_top_up_landed: Option<bool>,
    collateral_sold: f64,
    penalty: f64,
    btc_sold_bp: u128,
    short_uncovered: f64,
}

#[derive(Serialize)]
struct RowOut {
    lender: &'static str,
    name: &'static str,
    cushion_bp: u32,
    loan: f64,
    /// Left alone by everyone: the lowest health factor of the ten windows.
    lowest_hf_bp: u32,
    lowest_window: String,
    lowest_minute: usize,
    /// In that window: the first minute under 1.0.
    first_minute_under_10000: Option<usize>,
    windows_under_10000: usize,
    windows_with_a_top_up_ordered_at_minute_0: usize,
    cells: Vec<CellOut>,
}

fn rows(bt: &Backtest) -> Vec<RowOut> {
    let mut out = Vec::new();
    for (li, l) in LENDERS.iter().enumerate() {
        for cushion_bp in CUSHIONS_BP {
            let paths: Vec<Path> = bt.windows.iter().map(|w| path(l, cushion_bp, w)).collect();
            let (low_w, low) =
                paths.iter().enumerate().min_by_key(|(i, p)| (p.lowest_hf_bp, *i)).expect("there are windows");
            let mine = |delay: Option<usize>| {
                bt.cases.iter().filter(move |c| c.lender == li && c.cushion_bp == cushion_bp && c.delay == delay)
            };
            let cells = modes()
                .into_iter()
                .map(|delay| {
                    let worst = mine(delay)
                        .filter(|c| !c.out.liquidations.is_empty())
                        .fold(None::<&Case>, |best, c| match best {
                            Some(b) if b.out.sold() >= c.out.sold() => Some(b),
                            _ => Some(c),
                        });
                    CellOut {
                        top_up_delay_min: delay,
                        windows: mine(delay).count(),
                        windows_liquidated: mine(delay).filter(|c| !c.out.liquidations.is_empty()).count(),
                        lowest_hf_bp: mine(delay).filter_map(|c| c.out.lowest.map(|(hf, _)| hf)).min(),
                        worst_window: worst.map(|c| short(&bt.windows[c.window].name).to_string()),
                        first_liquidation_minute: worst.and_then(|c| c.out.liquidations.first().map(|e| e.minute)),
                        liquidated_before_a_top_up_landed: worst.and_then(|c| c.out.liquidated_first()),
                        collateral_sold: worst.map_or(0.0, |c| money(c.out.sold())),
                        penalty: worst.map_or(0.0, |c| money(c.out.cost())),
                        btc_sold_bp: worst.map_or(0, |c| share_bp(c.out.units_sold())),
                        short_uncovered: worst.map_or(0.0, |c| money(c.out.uncovered())),
                    }
                })
                .collect();
            out.push(RowOut {
                lender: l.id,
                name: l.name,
                cushion_bp,
                loan: money(l.loan(cushion_bp)),
                lowest_hf_bp: low.lowest_hf_bp,
                lowest_window: short(&bt.windows[low_w].name).to_string(),
                lowest_minute: low.lowest_minute,
                first_minute_under_10000: low.under_one,
                windows_under_10000: paths.iter().filter(|p| p.under_one.is_some()).count(),
                windows_with_a_top_up_ordered_at_minute_0: mine(Some(DELAYS_MIN[0]))
                    .filter(|c| c.out.top_ups.first().is_some_and(|t| t.ordered == 0))
                    .count(),
                cells,
            });
        }
    }
    out
}

/// The README's table, in markdown.
fn markdown(rows: &[RowOut]) -> Vec<String> {
    let mut head =
        "| Lender | Cushion | Loan | Lowest health factor, left alone (window, minute) | Under 1.0 from |".to_string();
    let mut rule = "|---|---:|---:|---|---|".to_string();
    for delay in modes() {
        let name = match delay {
            None => "No top-up".to_string(),
            Some(d) => format!("Top-up lands in {d} min"),
        };
        head.push_str(&format!(" {name} |"));
        rule.push_str("---|");
    }
    head.push_str(" Top-up ordered at minute 0 |");
    rule.push_str("---|");
    let mut lines = vec![head, rule];
    for r in rows {
        let under = match r.first_minute_under_10000 {
            Some(m) => format!("min {m} ({} of 10 windows)", r.windows_under_10000),
            None if r.windows_under_10000 > 0 => format!("{} of 10 windows", r.windows_under_10000),
            None => "never".to_string(),
        };
        let mut line = format!(
            "| {} | {} | {} | {} ({}, min {}) | {} |",
            r.name,
            cushion_text(r.cushion_bp),
            usd(r.loan),
            hf_text(r.lowest_hf_bp),
            r.lowest_window,
            r.lowest_minute,
            under
        );
        for c in &r.cells {
            let cell = match &c.worst_window {
                Some(_) => format!(
                    "{} sold ({}), {} cost, {} uncovered; {} of {}",
                    usd(c.collateral_sold),
                    pct_text(c.btc_sold_bp),
                    usd(c.penalty),
                    usd(c.short_uncovered),
                    c.windows_liquidated,
                    c.windows
                ),
                None => format!("none (lowest {})", c.lowest_hf_bp.map_or("n/a".to_string(), hf_text)),
            };
            line.push_str(&format!(" {cell} |"));
        }
        let at_0 = match r.windows_with_a_top_up_ordered_at_minute_0 {
            0 => "no".to_string(),
            n => format!("yes, in {n} of 10 windows"),
        };
        line.push_str(&format!(" {at_0} |"));
        lines.push(line);
    }
    lines
}

/// How to read the table.
pub const NOTES: &[&str] = &[
    "Each mode's cell is the worst of the ten windows: the collateral the lender's liquidators sold (and its share \
     of the bitcoin), what the discount or bonus cost, and the short left uncovered (the bitcoin sold, at the \
     window's last price); then how many windows liquidated. \"none (lowest x)\" is no liquidation, and the lowest \
     health factor the lender saw.",
    "A top-up is ordered when the health factor is under 1.35 and repays enough to bring it back to 1.5 at that \
     minute's price. A cushion that starts under 1.35 (1.2 and 1.3 here) orders it at minute 0.",
];

/// What the second table is.
pub const FALLS_NOTE: &str = "The table above starts every position at a window's start. Wherever in a window a \
                              position crosses the act level, this is what a top-up must outrun (the same for both \
                              lenders; the lender sees one more close than the delay):";

/// Every case that liquidated, in words.
fn findings(bt: &Backtest) -> Vec<String> {
    let mut lines = Vec::new();
    for c in bt.cases.iter().filter(|c| !c.out.liquidations.is_empty()) {
        let (l, o) = (&LENDERS[c.lender], &c.out);
        let first = &o.liquidations[0];
        let low = o.liquidations.iter().map(|e| e.hf_bp).min().unwrap_or(first.hf_bp);
        let when = match (c.delay, o.liquidated_first()) {
            (None, _) => String::new(),
            (_, Some(false)) => ", after a top-up had landed".to_string(),
            _ => ", before any top-up landed".to_string(),
        };
        let penalty = match l.rule {
            Rule::HoldAtOne { .. } => "the discount",
            Rule::CloseFactor { .. } => "the bonus",
        };
        let tops = if o.top_ups.is_empty() {
            String::new()
        } else {
            let shown: Vec<String> = o
                .top_ups
                .iter()
                .take(3)
                .map(|t| match t.repaid {
                    Some(r) => format!(
                        "{} ordered at minute {}, {} repaid at {}",
                        dollars(t.amount),
                        t.ordered,
                        dollars(r),
                        t.lands
                    ),
                    None => format!("{} ordered at minute {}, not landed by the end", dollars(t.amount), t.ordered),
                })
                .collect();
            let more = o.top_ups.len().saturating_sub(3);
            let tail = if more > 0 { format!("; {more} more") } else { String::new() };
            format!(" Top-ups: {}{tail}.", shown.join("; "))
        };
        let end = match hf_bp(o.collateral, l.liq_bp, o.owed) {
            Some(hf) => format!("ends at {} with {} owed", hf_text(hf), dollars(o.owed)),
            None => "ends with nothing owed".to_string(),
        };
        lines.push(format!(
            "- {}, cushion {}, {}, {}: liquidated in {} minute{} from minute {} (health factor {}, lowest {}){when}; \
             liquidators repaid {} and took {} of bitcoin ({} of it); {penalty} cost {}; short left uncovered {}; \
             {end}.{tops}",
            l.name,
            cushion_text(c.cushion_bp),
            mode_text(c.delay),
            short(&bt.windows[c.window].name),
            o.liquidations.len(),
            if o.liquidations.len() == 1 { "" } else { "s" },
            first.minute,
            hf_text(first.hf_bp),
            hf_text(low),
            dollars(o.repaid()),
            dollars(o.sold()),
            pct_text(share_bp(o.units_sold())),
            dollars(o.cost()),
            dollars(o.uncovered()),
        ));
    }
    lines
}

#[derive(Serialize)]
struct FallOut {
    top_up_delay_min: usize,
    /// The closes the lender sees before the top-up lands: the delay plus one.
    closes: usize,
    window: String,
    /// null: the window's start.
    from_minute: Option<usize>,
    to_minute: usize,
    fall_bp: u128,
    /// A top-up ordered from a health factor under this could come too late.
    level_needed_bp: u128,
}

#[derive(Serialize)]
struct LevelOut {
    level: &'static str,
    hf_bp: u32,
    /// The longest top-up delay this level survives from any minute of any window. null: none at all.
    longest_delay_min: Option<usize>,
    /// The fall that beats it one minute later.
    beaten_by: Option<FallOut>,
}

#[derive(Serialize)]
struct BookOut {
    bitcoin_at_the_lender: f64,
    btc_short_on_hyperliquid: f64,
}

#[derive(Serialize)]
struct LevelsOut {
    target_hf_bp: u32,
    act_hf_bp: u32,
    now_hf_bp: u32,
}

#[derive(Serialize)]
struct FileOut {
    v: u32,
    what: &'static str,
    command: String,
    /// sha256 of research/data/replays_v0.json.
    replays: String,
    book: BookOut,
    /// The engine's cushion levels (risk_core::lender), as the top-ups here use them.
    levels: LevelsOut,
    cushions_bp: Vec<u32>,
    delays_min: Vec<usize>,
    lenders: Vec<LenderOut>,
    assumptions: Vec<&'static str>,
    notes: Vec<&'static str>,
    table: Vec<RowOut>,
    /// For each delay: BTC's worst fall while a top-up is on its way, anywhere in the windows.
    worst_falls: Vec<FallOut>,
    /// For each of the engine's levels: the longest delay it survives, anywhere in the windows.
    levels_hold: Vec<LevelOut>,
    /// Each lender, cushion and window with nobody acting, the lender neither.
    paths: Vec<PathOut>,
    cases: Vec<CaseOut>,
}

const WHAT: &str = "FUNDING.md 6.8: each lender's cushion over the ten crash windows. Money in USD. Health factors and \
                    shares in basis points (10000 is a health factor of 1.0). A minute counts the window's one-minute \
                    closes from 0. `table` is the README's: for each lender and cushion, the worst of the ten windows \
                    with no top-up and with top-ups that land 2, 15 and 60 minutes after they are ordered.";

/// The report: the README's table, how to read it, the cases that liquidated, and the file's JSON for `command`.
pub struct Report {
    pub table: Vec<String>,
    /// The second table: the worst fall while a top-up is on its way, and how long each level holds.
    pub falls: Vec<String>,
    pub findings: Vec<String>,
    pub json: String,
}

/// A fall over the closes a top-up of `delay` minutes is exposed to.
fn fall_out(bt: &Backtest, delay: usize, f: &Fall) -> FallOut {
    FallOut {
        top_up_delay_min: delay,
        closes: delay + 1,
        window: short(&bt.windows[f.window].name).to_string(),
        from_minute: f.from,
        to_minute: f.to,
        fall_bp: f.fall_bp(),
        level_needed_bp: f.level_needed_bp(),
    }
}

fn fall_where(f: &FallOut) -> String {
    let from = f.from_minute.map_or("the start".to_string(), |m| format!("min {m}"));
    format!("{}, {from} to min {}", f.window, f.to_minute)
}

/// The second table, in markdown: the worst fall for each delay, then how long each level holds.
fn falls_markdown(falls: &[FallOut], levels: &[LevelOut]) -> Vec<String> {
    let mut lines = vec![
        "| Top-up lands in | BTC's worst fall before it lands (window, minutes) | Ordered under this health factor, \
         it could come too late |"
            .to_string(),
        "|---:|---|---:|".to_string(),
    ];
    for f in falls {
        lines.push(format!(
            "| {} min | {} ({}) | {} |",
            f.top_up_delay_min,
            pct_text2(f.fall_bp),
            fall_where(f),
            hf_text(u32::try_from(f.level_needed_bp).unwrap_or(u32::MAX))
        ));
    }
    lines.push(String::new());
    lines.push(
        "| Level | Health factor | The slowest top-up that is still in time, from any minute of any window | What \
         beats it a minute later |"
            .to_string(),
    );
    lines.push("|---|---:|---:|---|".to_string());
    for l in levels {
        let longest = match l.longest_delay_min {
            Some(d) if l.beaten_by.is_none() => format!("{d} min (a whole window)"),
            Some(d) => format!("{d} min"),
            None => "none".to_string(),
        };
        let beaten = l.beaten_by.as_ref().map_or("nothing in the windows".to_string(), |f| {
            format!("a fall of {} ({})", pct_text2(f.fall_bp), fall_where(f))
        });
        lines.push(format!("| {} | {} | {longest} | {beaten} |", l.level, hf_text(l.hf_bp)));
    }
    lines
}

pub fn report(bt: &Backtest, command: &str) -> Report {
    let table = rows(bt);
    let lines = markdown(&table);
    let all_falls = worst_falls(&bt.windows);
    let worst: Vec<FallOut> =
        DELAYS_MIN.iter().filter_map(|&d| all_falls.get(d).map(|f| fall_out(bt, d, f))).collect();
    let levels: Vec<LevelOut> = [("Target", TARGET_HF_BP), ("Act", ACT_HF_BP), ("Act now", NOW_HF_BP)]
        .into_iter()
        .map(|(level, hf)| {
            let longest = longest_delay(&all_falls, hf);
            let next = longest.map_or(0, |d| d + 1);
            LevelOut {
                level,
                hf_bp: hf,
                longest_delay_min: longest,
                beaten_by: all_falls.get(next).map(|f| fall_out(bt, next, f)),
            }
        })
        .collect();
    let falls_lines = falls_markdown(&worst, &levels);
    let mut paths = Vec::new();
    for l in &LENDERS {
        for cushion_bp in CUSHIONS_BP {
            for w in &bt.windows {
                let p = path(l, cushion_bp, w);
                paths.push(PathOut {
                    lender: l.id,
                    cushion_bp,
                    window: w.name.clone(),
                    loan: money(l.loan(cushion_bp)),
                    lowest_hf_bp: p.lowest_hf_bp,
                    lowest_minute: p.lowest_minute,
                    first_minute_under_act: p.under_act,
                    first_minute_under_now: p.under_now,
                    first_minute_under_10000: p.under_one,
                });
            }
        }
    }
    let file = FileOut {
        v: 1,
        what: WHAT,
        command: command.to_string(),
        replays: sha256_hex(REPLAYS_V0.as_bytes()),
        book: BookOut { bitcoin_at_the_lender: money(BOOK_MICRO), btc_short_on_hyperliquid: money(BOOK_MICRO) },
        levels: LevelsOut { target_hf_bp: TARGET_HF_BP, act_hf_bp: ACT_HF_BP, now_hf_bp: NOW_HF_BP },
        cushions_bp: CUSHIONS_BP.to_vec(),
        delays_min: DELAYS_MIN.to_vec(),
        lenders: LENDERS
            .iter()
            .map(|l| {
                let (penalty_bp, all_at_hf_bp, rule) = match l.rule {
                    Rule::HoldAtOne { discount_bp } => (discount_bp, None, "hold_at_one"),
                    Rule::CloseFactor { bonus_bp, all_at_hf_bp } => (bonus_bp, Some(all_at_hf_bp), "close_factor"),
                };
                LenderOut { id: l.id, name: l.name, liq_bp: l.liq_bp, penalty_bp, all_at_hf_bp, rule, source: l.source }
            })
            .collect(),
        assumptions: ASSUMPTIONS.to_vec(),
        notes: NOTES.to_vec(),
        table,
        worst_falls: worst,
        levels_hold: levels,
        paths,
        cases: bt.cases.iter().map(|c| case_out(bt, c)).collect(),
    };
    let json = serde_json::to_string_pretty(&file).expect("the report serialises") + "\n";
    Report { table: lines, falls: falls_lines, findings: findings(bt), json }
}

/// Everything `backtest lender` prints to stdout, line by line.
pub fn printout(r: &Report) -> Vec<String> {
    let mut lines = r.table.clone();
    lines.push(String::new());
    lines.extend(NOTES.iter().map(|n| format!("- {n}")));
    lines.push(String::new());
    lines.push(FALLS_NOTE.to_string());
    lines.push(String::new());
    lines.extend(r.falls.iter().cloned());
    lines.push(String::new());
    if r.findings.is_empty() {
        lines.push("No lender liquidated in any case.".to_string());
    } else {
        lines.push(format!("Cases where the lender liquidated ({}):", r.findings.len()));
        lines.extend(r.findings.iter().cloned());
    }
    lines
}

// ---------------------------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------------------------

const USAGE: &str = "usage: backtest lender [--json <file>]";

/// `research/data/backtest_lender_v0.json` in this repo, wherever the command is run from.
fn default_json() -> String {
    let data = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../research/data");
    let data = data.canonicalize().unwrap_or(data);
    data.join("backtest_lender_v0.json").to_string_lossy().into_owned()
}

/// `lender [--json <file>]`.
pub fn main(args: &[String]) -> ExitCode {
    let mut json: Option<String> = None;
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--json" => match it.next() {
                Some(path) => json = Some(path.clone()),
                None => {
                    eprintln!("--json needs a file\n{USAGE}");
                    return ExitCode::FAILURE;
                }
            },
            other => {
                eprintln!("unknown flag {other}\n{USAGE}");
                return ExitCode::FAILURE;
            }
        }
    }
    let eng = Engine::v0();
    let bt = run(&eng);
    let command = ["cargo run -p backtest --release -- lender"]
        .into_iter()
        .chain(args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    let r = report(&bt, &command);
    for line in printout(&r) {
        println!("{line}");
    }
    let path = json.unwrap_or_else(default_json);
    if let Err(e) = std::fs::write(&path, &r.json) {
        eprintln!("cannot write {path}: {e}");
        return ExitCode::FAILURE;
    }
    eprintln!("wrote {} cases to {path}", bt.cases.len());
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    const RHEA: Lender = LENDERS[0];
    const AAVE: Lender = LENDERS[1];

    fn window(eng: &Engine, name: &str) -> Window {
        windows(eng).into_iter().find(|w| w.name.starts_with(name)).expect("the window is in the file")
    }

    #[test]
    fn the_loans_are_the_worked_example_s() {
        // $100,000 of bitcoin at a cushion of 1.5: $50,667 from Rhea (76%), $56,667 from Aave (85%).
        assert_eq!(RHEA.loan(15_000), 50_666_666_666);
        assert_eq!(AAVE.loan(15_000), 56_666_666_666);
        assert_eq!(hf_bp(BOOK_MICRO, RHEA.liq_bp, RHEA.loan(12_000)), Some(12_000));
        assert_eq!(hf_bp(BOOK_MICRO, AAVE.liq_bp, AAVE.loan(17_500)), Some(17_500));
    }

    #[test]
    fn rhea_s_liquidators_hold_the_health_factor_at_one() {
        // $100,000 of bitcoin against $78,370 owed: 76% of it is $76,000, so $2,370 short. Each dollar of bitcoin
        // taken repays 99.7 cents and frees 76: $2,370 / 0.237 = $10,000 taken, $9,970 repaid, $30 of discount.
        let x = RHEA.liquidation(100_000 * USD, 78_370 * USD).unwrap();
        assert_eq!(x, Liquidated { repaid: 9_970 * USD, taken: 10_000 * USD });
        assert_eq!(x.cost(), 30 * USD);
        assert_eq!(hf_bp(90_000 * USD, 7_600, 68_400 * USD), Some(10_000));
        // At 1.0 or better nothing is taken.
        assert_eq!(RHEA.liquidation(100_000 * USD, 76_000 * USD), None);
        assert_eq!(RHEA.liquidation(100_000 * USD, 50_000 * USD), None);
        assert_eq!(RHEA.liquidation(100_000 * USD, 0), None);
        // research/rhea.md 11: from a cushion of 1.5, a 40% fall has liquidators repay about $21k (42% of the
        // loan) and take about 36% of the bitcoin, at a discount worth about $64.
        let debt = RHEA.loan(15_000);
        let x = RHEA.liquidation(60_000 * USD, debt).unwrap();
        assert_eq!((x.repaid / USD, x.taken / USD, x.cost() / USD), (21_314, 21_378, 64));
        assert_eq!(x.repaid * 100 / debt, 42);
        assert_eq!(x.taken * 100 / (60_000 * USD), 35);
        // Whatever the rounding, it ends at 1.0 or a hair over, so the next minute at the same price takes nothing.
        let (c, d) = (60_000 * USD - x.taken, debt - x.repaid);
        assert_eq!(hf_bp(c, 7_600, d), Some(10_000));
        assert_eq!(RHEA.liquidation(c, d), None);
        // Collateral that can't bring it back: all of it goes, at the discount, and debt is left.
        let x = RHEA.liquidation(1_000 * USD, 2_000 * USD).unwrap();
        assert_eq!(x, Liquidated { repaid: 997 * USD, taken: 1_000 * USD });
    }

    #[test]
    fn aave_s_liquidator_repays_half_or_all_and_takes_the_bonus() {
        // $100,000 of bitcoin, 85% of it is $85,000. At $85,000 owed nothing happens.
        assert_eq!(AAVE.liquidation(100_000 * USD, 85_000 * USD), None);
        // $86,000 owed is a health factor of 0.988: half is repaid, and that plus 5% taken.
        let x = AAVE.liquidation(100_000 * USD, 86_000 * USD).unwrap();
        assert_eq!(x, Liquidated { repaid: 43_000 * USD, taken: 45_150 * USD });
        assert_eq!(x.cost(), 2_150 * USD);
        assert_eq!(hf_bp(54_850 * USD, 8_500, 43_000 * USD), Some(10_842));
        // $90,000 owed is 0.944, under 0.95: all of it is repaid, and $5,500 of bitcoin is left.
        let x = AAVE.liquidation(100_000 * USD, 90_000 * USD).unwrap();
        assert_eq!(x, Liquidated { repaid: 90_000 * USD, taken: 94_500 * USD });
        // Exactly 0.95 counts as under: $95,000 of bitcoin against $85,000 owed.
        let x = AAVE.liquidation(95_000 * USD, 85_000 * USD).unwrap();
        assert_eq!(x.repaid, 85_000 * USD);
        // $100,000 owed: the bitcoin can't cover debt plus bonus, so all of it goes and $4,762 stays owed.
        let x = AAVE.liquidation(100_000 * USD, 100_000 * USD).unwrap();
        assert_eq!(x, Liquidated { repaid: 95_238_095_238, taken: 100_000 * USD });
        // research/aave.md: borrowing the maximum, $81,000, a liquidation costs about $2,025 and about $42,500
        // of bitcoin leaves the hedge.
        let x = AAVE.liquidation(95_000 * USD, 81_000 * USD).unwrap();
        assert_eq!((x.cost(), x.taken), (2_025 * USD, 42_525 * USD));
    }

    #[test]
    fn the_price_path_is_btc_s_recorded_closes() {
        let eng = Engine::v0();
        let ws = windows(&eng);
        assert_eq!(ws.len(), 10);
        for (w, raw) in ws.iter().zip(&eng.replays) {
            assert_eq!(w.px.len(), 240);
            for (px, mv) in w.px.iter().zip(&raw.paths["BTC"]) {
                assert_eq!(*px, ((1.0 + mv) * 1e9).round() as u128);
            }
        }
    }

    #[test]
    fn the_2020_fall_end_to_end_at_rhea_from_a_cushion_of_1_5() {
        let eng = Engine::v0();
        let w = window(&eng, "2020-03-12 down");
        let low_px = *w.px.iter().min().unwrap();
        // Left alone: the health factor is the cushion times the price, so it bottoms with BTC, 35.5% down.
        let p = path(&RHEA, 15_000, &w);
        assert_eq!(w.px[p.lowest_minute], low_px);
        assert_eq!(p.lowest_hf_bp, hf_bp(value(BOOK_MICRO, low_px), 7_600, RHEA.loan(15_000)).unwrap());
        assert!((9_600..9_700).contains(&p.lowest_hf_bp), "{}", p.lowest_hf_bp);
        // It passes 1.35, 1.2 and 1.0 in that order, and 1.0 at the first close more than a third down.
        let under_one = p.under_one.unwrap();
        assert!(p.under_act.unwrap() < p.under_now.unwrap() && p.under_now.unwrap() < under_one);
        assert_eq!(w.px.iter().position(|&px| px * 3 < PPB * 2), Some(under_one));

        // No top-up: Rhea's liquidators start at that minute and hold the health factor at 1.0.
        let o = simulate(&RHEA, 15_000, &w, None);
        assert!(o.top_ups.is_empty());
        assert_eq!(o.liquidations[0].minute, under_one);
        assert!(o.liquidations.iter().all(|e| e.hf_bp < 10_000 && e.hf_after_bp == Some(10_000)));
        assert_eq!(o.liquidated_first(), Some(true));
        // The books balance: debt and bitcoin left are what was there less what the liquidators moved.
        assert_eq!(o.owed, o.loan - o.repaid());
        assert_eq!(o.units, BOOK_MICRO - o.units_sold());
        assert_eq!(o.cost(), o.sold() - o.repaid());
        // The discount is 0.3% of what was taken, to the micro-dollar a slice.
        let want = o.sold() * 30 / 10_000;
        assert!(o.cost().abs_diff(want) <= o.liquidations.len() as u128, "{} {want}", o.cost());

        // Top-ups: the first is ordered at the first minute under 1.35, sized for 1.5 at that minute's price, and
        // lands as ordered; none is ordered while one is on its way.
        for delay in DELAYS_MIN {
            let o = simulate(&RHEA, 15_000, &w, Some(delay));
            let t = &o.top_ups[0];
            assert_eq!((t.ordered, t.lands), (p.under_act.unwrap(), p.under_act.unwrap() + delay));
            let c = value(BOOK_MICRO, w.px[t.ordered]);
            assert_eq!(t.amount, repay_to_target_micro(c, 7_600, 15_000, o.loan));
            assert!(hf_bp(c, 7_600, o.loan - t.amount).unwrap() >= 15_000);
            for pair in o.top_ups.windows(2) {
                assert!(pair[1].ordered >= pair[0].lands, "{pair:?}");
            }
            let topped: u128 = o.top_ups.iter().filter_map(|t| t.repaid).sum();
            assert_eq!(o.owed, o.loan - o.repaid() - topped);
            assert!(o.sold() <= simulate(&RHEA, 15_000, &w, None).sold());
        }
        // A top-up that lands in 2 minutes keeps Rhea's liquidators out of this window altogether.
        assert!(simulate(&RHEA, 15_000, &w, Some(2)).liquidations.is_empty());
    }

    #[test]
    fn a_cushion_that_starts_under_the_act_level_orders_its_top_up_at_minute_0() {
        let eng = Engine::v0();
        for w in windows(&eng) {
            for l in &LENDERS {
                let o = simulate(l, 12_000, &w, Some(15));
                assert_eq!(o.top_ups[0].ordered, 0, "{}", w.name);
                // A cushion of 2.0 never needs one before it is under the act level: bitcoin 32.5% down.
                let o = simulate(l, 20_000, &w, Some(15));
                assert!(o.top_ups.iter().all(|t| w.px[t.ordered] * 20_000 < PPB * u128::from(ACT_HF_BP)), "{}", w.name);
            }
        }
    }

    #[test]
    fn a_rising_window_touches_no_cushion_of_1_5() {
        let eng = Engine::v0();
        let w = window(&eng, "2020-03-12 up");
        for l in &LENDERS {
            let o = simulate(l, 15_000, &w, Some(60));
            assert!(o.liquidations.is_empty() && o.top_ups.is_empty());
            assert_eq!((o.units, o.owed), (BOOK_MICRO, o.loan));
            assert!(o.lowest.unwrap().0 >= 15_000);
        }
    }

    #[test]
    fn the_worst_falls_are_what_a_late_top_up_meets() {
        let eng = Engine::v0();
        let ws = windows(&eng);
        let falls = worst_falls(&ws);
        assert_eq!(falls.len(), 240);
        // A longer wait never meets a smaller fall, and each fall is a real pair of closes in its window.
        for pair in falls.windows(2) {
            assert!(!pair[0].worse_than(&pair[1]));
        }
        for (k, f) in falls.iter().enumerate() {
            let w = &ws[f.window];
            assert_eq!(f.from.map_or(PPB, |m| w.px[m]), f.from_px);
            assert_eq!(w.px[f.to], f.to_px);
            assert!(f.to < f.from.map_or(0, |m| m + 1) + k + 1, "{f:?}");
        }
        // A round fall: from 1.0 to 0.8 is 20%, and needs a health factor of 1.25.
        let f = Fall { window: 0, from: None, to: 5, from_px: PPB, to_px: PPB * 4 / 5 };
        assert_eq!((f.fall_bp(), f.level_needed_bp()), (2_000, 12_500));
        assert!(f.survived_from(12_500) && !f.survived_from(12_499));
        assert_eq!(longest_delay(&[f], 12_500), Some(0));
        assert_eq!(longest_delay(&[f], 12_000), None);

        // As found: over the 61 closes a 60-minute top-up is exposed to, BTC fell 23.63% in the 2020 fall, which
        // needs a health factor of 1.3095 (rounded up); over 16 closes 14.66% (1.1718); over 3 closes 9.01% (1.0991).
        let found: Vec<(u128, u128)> =
            DELAYS_MIN.iter().map(|&d| (falls[d].fall_bp(), falls[d].level_needed_bp())).collect();
        assert_eq!(found, [(901, 10_991), (1_466, 11_718), (2_363, 13_095)]);

        // The simulator agrees. A Rhea position that opens at 1.3 at the close that fall starts from orders its
        // top-up at the next close, and Rhea liquidates before it lands 60 minutes later.
        let f = falls[60];
        let w = &ws[f.window];
        let after = f.from.map_or(0, |m| m + 1);
        let rest = Window { name: w.name.clone(), px: w.px[after..].iter().map(|&px| px * PPB / f.from_px).collect() };
        let o = simulate(&RHEA, 13_000, &rest, Some(60));
        assert_eq!((o.top_ups[0].ordered, o.top_ups[0].lands), (0, 60));
        let first = o.liquidations.first().expect("the lender liquidates").minute;
        assert!(first <= f.to - after && first < 60, "{first}");
        assert_eq!(o.liquidated_first(), Some(true));
        // With 15 minutes it is in time, and so is 60 from the health factor the fall needs.
        assert!(simulate(&RHEA, 13_000, &rest, Some(15)).liquidations.is_empty());
        let needed = u32::try_from(f.level_needed_bp()).unwrap() + 1;
        let o = simulate(&RHEA, needed, &rest, None);
        assert!(o.liquidations.iter().all(|e| e.minute > f.to - after), "{:?}", o.liquidations.first());
    }

    #[test]
    fn two_runs_print_the_same_bytes() {
        let eng = Engine::v0();
        let a = report(&run(&eng), "lender test");
        let b = report(&run(&eng), "lender test");
        assert_eq!(a.json, b.json);
        assert_eq!(printout(&a), printout(&b));
        // One row per lender and cushion under the two header lines; every case and path in the file.
        assert_eq!(a.table.len(), 2 + LENDERS.len() * CUSHIONS_BP.len());
        let v: serde_json::Value = serde_json::from_str(&a.json).unwrap();
        assert_eq!(v["cases"].as_array().unwrap().len(), 2 * 5 * 10 * 4);
        assert_eq!(v["paths"].as_array().unwrap().len(), 2 * 5 * 10);
        assert_eq!(v["command"], "lender test");
        assert_eq!(v["replays"], sha256_hex(REPLAYS_V0.as_bytes()));
        assert_eq!(v["assumptions"].as_array().unwrap().len(), ASSUMPTIONS.len());
        // The levels are the engine's, read and not changed.
        assert_eq!(v["levels"]["target_hf_bp"], 15_000);
        assert_eq!(v["levels"]["act_hf_bp"], 13_500);
        assert_eq!(v["levels"]["now_hf_bp"], 12_000);
        // The findings list is exactly the cases the file marks as liquidated.
        let liquidated = v["cases"].as_array().unwrap().iter().filter(|c| c["liquidated"] == true).count();
        assert_eq!(a.findings.len(), liquidated);
    }
}
