//! The outside lenders in the verdict (FUNDING.md 6.2 to 6.6, INTERFACES.md 27): what each lender position looks
//! like (`ext`), how much more the book can carry at all (the risk room), how much more each lender may lend (its
//! room), how a `fund` request splits between one lender and our pool, and the top-up when a lender's cushion gets
//! thin.
//!
//! Everything here reads `Book::lenders`, which pb-read fills. An account whose config names no lender has an empty
//! lender book, and nothing here adds a byte to its verdict.
use pb_read::lenders::{Holding, LenderBook, LenderPos, RHEA};
use pb_read::steps::PlanStep;
use pb_read::util::{micro_down, pow10};
use risk_core::lender::{self, Order, Source, ACT_HF_BP, NOW_HF_BP, TARGET_HF_BP};
use risk_core::params::find_token;
use risk_core::py::usd;
use risk_core::{Account, Action, Engine, Market};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A funding plan has at most this many steps (INTERFACES.md 25). The account refuses a verdict with more.
pub const MAX_FUND_STEPS: usize = 6;
/// The stress test charges our pool's rate on the whole debt. A lender that charges more gets this many days of
/// the difference added to the debt before the risk room is worked out (FUNDING.md 6.2).
pub const RATE_GAP_DAYS: f64 = 7.0;
/// The bounds of `borrow_allowance` that are our pool's own limits: how much of the pool this client may have (C5),
/// and how full the pool may get (C6). The risk room reads past them; the pool room keeps them.
pub const POOL_BOUNDS: [&str; 3] = ["C5 client limit", "C6 pool utilisation", "C6 pool share"];

/// One lender position in the verdict's `ext` (INTERFACES.md 25). Amounts are micro-USD.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ext {
    /// `aave` or `rhea`.
    pub l: String,
    /// The collateral posted there, as the lender values it.
    pub c: u128,
    /// The USDC owed there, with interest.
    pub d: u128,
    /// The cushion (health factor) in bp; 0 with no debt.
    pub hf_bp: u32,
    /// The lender's borrow and deposit rates now, in bp a year.
    pub r_bp: u32,
    pub s_bp: u32,
    /// How much more this lender may lend the account now.
    pub room: u128,
    /// The lender liquidates when the debt passes this share of the collateral.
    pub liq_bp: u32,
}

/// The verdict's `evm`: the account's Ethereum nonce, so it can clear transactions that were mined.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Evm {
    pub nonce: u64,
}

/// The cushion new lender borrowing stops at: 1.5, or the permission's if that is higher.
pub fn target_bp(lb: &LenderBook) -> u32 {
    TARGET_HF_BP.max(lb.min_hf_bp.unwrap_or(0))
}

/// A position's cushion in bp, or `None` when nothing is owed there. It is the smaller of the lender's own figure
/// and ours, which also counts what is on its way: borrows as owed, and withdrawals as collateral already gone.
pub fn cushion_bp(pos: &LenderPos) -> Option<u32> {
    let owed = pos.owed_micro();
    if owed == 0 {
        return None;
    }
    let counted = lender::hf_bp(pos.posted_micro, pos.liq_bp, owed);
    match (pos.hf_bp, counted) {
        (Some(theirs), Some(ours)) => Some(theirs.min(ours)),
        (theirs, ours) => theirs.or(ours),
    }
}

/// The cushion as the lender shows it now, with nothing that is on its way counted, or `None` when it shows no
/// debt. With nothing on its way this is [`cushion_bp`].
///
/// A top-up goes by this figure. An action under way is listed until its block has passed, and for part of that
/// time the lender shows it too, so [`cushion_bp`] counts it twice: a loan that has just landed looks like twice the
/// loan. That is right for new risk, and wrong for a top-up, which would repay the loan the account has just taken.
pub fn shown_cushion_bp(pos: &LenderPos) -> Option<u32> {
    let counted = lender::hf_bp(pos.shown_micro(), pos.liq_bp, pos.debt_micro);
    match (pos.hf_bp, counted) {
        (Some(theirs), Some(ours)) => Some(theirs.min(ours)),
        // With no debt shown there is nothing to top up, whatever the lender's figure said.
        (_, None) => None,
        (None, ours) => ours,
    }
}

/// Whether the account has anything at this lender.
fn holds(pos: &LenderPos) -> bool {
    pos.posted_micro > 0 || pos.owed_micro() > 0 || pos.posted.iter().any(|h| h.raw > 0)
}

/// A cushion as people say it: 12000 is "1.20".
fn times(bp: u32) -> String {
    format!("{}.{:02}", bp / 10_000, bp % 10_000 / 100)
}

/// A rate as people say it: 533 is "5.33%".
fn percent(bp: u32) -> String {
    format!("{}.{:02}%", bp / 100, bp % 100)
}

fn dollars(micro: u128) -> String {
    usd(micro as f64 / 1e6)
}

fn amount_u64(micro: u128) -> u64 {
    u64::try_from(micro).unwrap_or(u64::MAX)
}

/// What to say when a lender's pool has no room for tokens the account holds on its chain (Aave's supply cap,
/// INTERFACES.md 33), so no step posts them: "Aave's pool for WBTC is full, so the WBTC at the account's Ethereum
/// address can't be posted now". `None` when the position holds no such token.
pub fn full_note(pos: &LenderPos) -> Option<String> {
    if pos.full.is_empty() {
        return None;
    }
    let mut name = pos.lender.clone();
    if let Some(first) = name.get_mut(..1) {
        first.make_ascii_uppercase();
    }
    let tokens = pos.full.join(" and ");
    Some(format!(
        "{name}'s pool for {tokens} is full, so the {tokens} at the account's Ethereum address can't be posted now"
    ))
}

/// The pool's `get_params().funding.order`: which source a funding request fills first. A pool that doesn't say
/// (or says something this version doesn't know) gets `cheapest`.
pub fn funding_order(params: &Value) -> Order {
    params
        .pointer("/funding/order")
        .and_then(Value::as_str)
        .and_then(Order::parse)
        .unwrap_or_default()
}

/// A week of each lender's rate above our pool's rate (`pool_rate`, a fraction a year), on what is owed there, in
/// USDC.
pub fn rate_gap_usd(lb: &LenderBook, pool_rate: f64) -> f64 {
    lb.positions
        .iter()
        .map(|p| {
            let gap = f64::from(p.rate_bp) / 1e4 - pool_rate;
            if gap > 0.0 {
                p.owed_micro() as f64 / 1e6 * gap * RATE_GAP_DAYS / 365.0
            } else {
                0.0
            }
        })
        .sum()
}

/// The risk room: how much more the book can carry at all, in micro-USD, and the code of the bound that sets it.
///
/// It is `borrow_allowance` on the whole debt (`a.debt`, which the book has already set to our pool's and the
/// lenders' together) plus [`rate_gap_usd`], read without the pool's own bounds ([`POOL_BOUNDS`]): the smallest of
/// the others, rounded down. The checked maths isn't touched; only its list of bounds is read differently.
pub fn risk_room(
    eng: &Engine,
    a: &Account,
    m: &Market,
    score: i64,
    lb: &LenderBook,
    pool_rate: f64,
) -> (u128, String) {
    let whole = Account {
        debt: a.debt + rate_gap_usd(lb, pool_rate),
        ..a.clone()
    };
    let allowance = eng.borrow_allowance(&whole, m, None, 0, Some(score));
    // The first of the smallest, as the engine picks its binding bound.
    let mut low: Option<(&str, f64)> = None;
    for (name, &x) in allowance.bounds.iter() {
        if POOL_BOUNDS.contains(&name) {
            continue;
        }
        if low.is_none_or(|(_, least)| x < least) {
            low = Some((name, x));
        }
    }
    let (name, x) = low.unwrap_or(("C0 equity", 0.0));
    let code = name.split(' ').next().unwrap_or("").to_string();
    (micro_down(x).max(0) as u128, code)
}

/// How much more each lender may lend the account now, one figure per position (INTERFACES.md 27): what its
/// posted and spare collateral allow at the target cushion, less what is owed, cut to what the lender has free and
/// to the risk room. `open` is false when the state isn't HEALTHY or a held price is uncertain: then no lender
/// lends. Nor does one the permission doesn't name, or one whose rate is above the permission's ceiling.
pub fn rooms(lb: &LenderBook, risk_room_micro: u128, open: bool) -> Vec<u128> {
    let target = target_bp(lb);
    lb.positions
        .iter()
        .map(|p| {
            let too_dear = lb.max_rate_bp.is_some_and(|max| p.rate_bp > max);
            if !open || !p.permitted || too_dear {
                return 0;
            }
            let collateral = p.posted_micro.saturating_add(p.spare_micro);
            lender::room_micro(collateral, p.liq_bp, target, p.owed_micro())
                .min(p.free_micro)
                .min(risk_room_micro)
        })
        .collect()
}

/// The verdict's `ext`: one entry per lender position that is permitted or holds anything.
///
/// `room` here is what the lender may lend against the collateral **already posted**, because the account's
/// `l_borrow` step borrows up to it. [`rooms`] also counts spare collateral, which a funding plan posts first with
/// an `l_supply` step; once that has run, the next verdict's `room` shows it. So a borrow can never lean on
/// collateral that didn't arrive.
pub fn ext(lb: &LenderBook, rooms: &[u128]) -> Vec<Ext> {
    let target = target_bp(lb);
    lb.positions
        .iter()
        .zip(rooms)
        .filter(|(p, _)| p.permitted || holds(p))
        .map(|(p, &planned)| {
            let posted = lender::room_micro(p.posted_micro, p.liq_bp, target, p.owed_micro());
            (p, planned.min(posted))
        })
        .map(|(p, room)| Ext {
            l: p.lender.clone(),
            c: p.posted_micro,
            d: p.debt_micro,
            hf_bp: if p.debt_micro == 0 {
                0
            } else {
                cushion_bp(p).unwrap_or(0)
            },
            r_bp: p.rate_bp,
            s_bp: p.supply_bp,
            room,
            liq_bp: p.liq_bp,
        })
        .collect()
}

/// Each holding's share of `total_micro`, the value the lender puts on all of them together. One holding has all
/// of it; several share it by their size at the engine's prices.
fn values(holdings: &[Holding], total_micro: u128, m: &Market) -> Vec<u128> {
    if holdings.len() == 1 {
        return vec![total_micro];
    }
    let weights: Vec<f64> = holdings
        .iter()
        .map(|h| {
            let price = find_token(&h.engine)
                .and_then(|t| t.group)
                .and_then(|g| m.px.get(g).copied())
                .unwrap_or(1.0);
            h.raw as f64 / pow10(h.decimals) * price
        })
        .collect();
    let sum: f64 = weights.iter().sum();
    weights
        .iter()
        .map(|w| {
            if sum > 0.0 {
                (total_micro as f64 * w / sum).floor() as u128
            } else {
                0
            }
        })
        .collect()
}

/// Just enough of `holdings`, in their order, to be worth `need_micro`: each holding's place in the list and how
/// many of its units, rounded up. `total_micro` is what all of them are worth.
fn units_worth(
    holdings: &[Holding],
    total_micro: u128,
    need_micro: u128,
    m: &Market,
) -> Vec<(usize, u128)> {
    let worth = values(holdings, total_micro, m);
    let mut left = need_micro;
    let mut out = Vec::new();
    for (i, h) in holdings.iter().enumerate() {
        if left == 0 {
            break;
        }
        if worth[i] == 0 || h.raw == 0 {
            continue;
        }
        let take = left.min(worth[i]);
        let raw = h.raw.saturating_mul(take).div_ceil(worth[i]).min(h.raw);
        out.push((i, raw));
        left -= take;
    }
    out
}

/// The answer to a `fund` intent: the steps, what they borrow in all, and a line in words.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Funded {
    pub steps: Vec<PlanStep>,
    pub total_micro: u128,
    pub note: String,
}

/// FUNDING.md 6.4: splits a request of `ask_micro` between at most one lender and our pool, and writes the steps in
/// the order they run: an `l_supply` of just enough spare collateral if the lender's part needs it, the `l_borrow`,
/// then the `p_borrow`. `rooms` is [`rooms`]' answer; `pool_room_micro` is what our pool's own limits allow.
#[allow(clippy::too_many_arguments)]
pub fn fund(
    lb: &LenderBook,
    m: &Market,
    ask_micro: u128,
    risk_room_micro: u128,
    pool_room_micro: u128,
    pool_rate_bp: u32,
    rooms: &[u128],
    order: Order,
) -> Funded {
    let sources: Vec<Source> = lb
        .positions
        .iter()
        .zip(rooms)
        .map(|(p, &room)| Source {
            lender: p.lender.clone(),
            room_micro: room,
            rate_bp: p.rate_bp,
        })
        .collect();
    let split = lender::split(
        ask_micro,
        risk_room_micro,
        pool_room_micro,
        pool_rate_bp,
        &sources,
        order,
    );
    let mut out = Funded::default();
    let mut said: Vec<String> = Vec::new();
    if let Some((name, part)) = &split.lender {
        if let Some(pos) = lb.get(name) {
            // What must be posted for the cushion to stand at the target once this part is borrowed.
            let short = lender::add_to_target_micro(
                pos.posted_micro,
                pos.liq_bp,
                target_bp(lb),
                pos.owed_micro().saturating_add(*part),
            );
            for (i, raw) in units_worth(&pos.spare, pos.spare_micro, short, m) {
                out.steps.push(PlanStep::LSupply {
                    l: name.clone(),
                    tok: pos.spare[i].id.clone(),
                    amt: raw.to_string(),
                });
            }
            out.steps.push(PlanStep::LBorrow {
                l: name.clone(),
                amt: amount_u64(*part),
            });
            out.total_micro += part;
            let why = match order {
                Order::LenderFirst => "the operator puts lenders first".to_string(),
                Order::Cheapest if pos.rate_bp < pool_rate_bp => {
                    format!("cheaper than our pool's {}", percent(pool_rate_bp))
                }
                // Our pool went first and stopped at its own limits.
                _ => "what our pool's own limits leave".to_string(),
            };
            said.push(format!(
                "{name} lends {} at {} ({why})",
                dollars(*part),
                percent(pos.rate_bp)
            ));
        }
    }
    if split.pool_micro > 0 {
        out.steps.push(PlanStep::PBorrow {
            amt: amount_u64(split.pool_micro),
        });
        out.total_micro += split.pool_micro;
        said.push(format!(
            "our pool lends {} at {}",
            dollars(split.pool_micro),
            percent(pool_rate_bp)
        ));
    }
    if out.steps.len() > MAX_FUND_STEPS {
        return Funded {
            note: format!(
                "funding: the plan would need {} steps and an account takes {MAX_FUND_STEPS}: post the collateral at the lender first",
                out.steps.len()
            ),
            ..Funded::default()
        };
    }
    out.note = if out.steps.is_empty() {
        "funding: nothing can be lent now: the book can carry no more, or no source has room"
            .to_string()
    } else if out.total_micro < ask_micro {
        format!(
            "funding: {}; that is {} of the {} asked",
            said.join("; "),
            dollars(out.total_micro),
            dollars(ask_micro)
        )
    } else {
        format!("funding: {}", said.join("; "))
    };
    // A lender the account may use, with collateral there that its pool has no room for: say so.
    for full in lb.positions.iter().filter(|p| p.permitted).filter_map(full_note) {
        out.note = format!("{}; {full}", out.note);
    }
    out
}

/// What the lenders' cushions ask for (FUNDING.md 6.5).
#[derive(Clone, Debug, PartialEq)]
pub struct TopUps {
    /// REBALANCE when a cushion is under 1.35, REBALANCE_NOW under 1.2, else NONE.
    pub action: Action,
    /// The `l_add` and `l_repay` steps, the thinnest cushion first. They go before any other plan step.
    pub steps: Vec<PlanStep>,
    /// One `top` line per thin cushion, in words.
    pub notes: Vec<String>,
    /// What the steps take from the account's NEAR balances (Rhea's are on NEAR): engine token and units.
    pub near_spent: Vec<(String, f64)>,
}

impl Default for TopUps {
    fn default() -> Self {
        TopUps {
            action: Action::None,
            steps: Vec::new(),
            notes: Vec::new(),
            near_spent: Vec::new(),
        }
    }
}

/// The top-up for every position whose cushion is under the act level, whether or not the permission still names
/// the lender: a top-up only lowers risk, so a client can't switch it off. Each brings the cushion back to the
/// target: first by adding spare collateral, which takes seconds, and if that isn't enough by repaying from the
/// USDC the account holds on the lender's chain. At most `max_steps` steps; the next verdict plans the rest.
/// With `hold` (the account is being unwound), the lines are written but no step is: the unwind comes first.
///
/// The cushion, the collateral and the debt here are what the lender shows now ([`shown_cushion_bp`]). A borrow or
/// a withdrawal still on its way is left out, and the first verdict after its block has passed tops up for it if
/// it must.
pub fn top_ups(lb: &LenderBook, m: &Market, max_steps: usize, hold: bool) -> TopUps {
    let target = target_bp(lb);
    let mut thin: Vec<(u32, &LenderPos)> = lb
        .positions
        .iter()
        .filter_map(|p| shown_cushion_bp(p).filter(|&c| c < ACT_HF_BP).map(|c| (c, p)))
        .collect();
    thin.sort_by_key(|(c, _)| *c);
    let mut out = TopUps::default();
    for (cushion, pos) in thin {
        let now = cushion < NOW_HF_BP;
        if now {
            out.action = Action::RebalanceNow;
        } else if out.action == Action::None {
            out.action = Action::Rebalance;
        }
        let name = &pos.lender;
        let (owed, posted) = (pos.debt_micro, pos.shown_micro());
        let head = format!(
            "{name}: cushion {} is under {}",
            times(cushion),
            times(if now { NOW_HF_BP } else { ACT_HF_BP })
        );
        // The lender's own figure may be lower than ours; the top-up is sized on the collateral that explains it.
        let counted = match pos.hf_bp {
            Some(theirs) if theirs > 0 => {
                posted.min(owed.saturating_mul(u128::from(theirs)) / u128::from(pos.liq_bp.max(1)))
            }
            _ => posted,
        };
        let short = lender::add_to_target_micro(counted, pos.liq_bp, target, owed);
        let add = short.min(pos.spare_micro);
        let after =
            lender::repay_to_target_micro(counted.saturating_add(add), pos.liq_bp, target, owed);
        let repay = after.min(pos.cash_micro);
        let left = after - repay;
        if hold {
            out.notes
                .push(format!("{head}; its top-up waits for the unwind"));
            continue;
        }
        let mut steps: Vec<PlanStep> = Vec::new();
        let mut spent: Vec<(String, f64)> = Vec::new();
        for (i, raw) in units_worth(&pos.spare, pos.spare_micro, add, m) {
            let h = &pos.spare[i];
            steps.push(PlanStep::LAdd {
                l: name.clone(),
                tok: h.id.clone(),
                amt: raw.to_string(),
            });
            spent.push((h.engine.clone(), raw as f64 / pow10(h.decimals)));
        }
        if repay > 0 {
            steps.push(PlanStep::LRepay {
                l: name.clone(),
                amt: amount_u64(repay),
            });
            spent.push(("USDC".to_string(), repay as f64 / 1e6));
        }
        let room = max_steps.saturating_sub(out.steps.len());
        let cut = steps.len() > room;
        steps.truncate(room);
        let mut does: Vec<String> = Vec::new();
        if steps.iter().any(|s| matches!(s, PlanStep::LAdd { .. })) {
            does.push(format!("adding {} of collateral", dollars(add)));
        }
        if steps.iter().any(|s| matches!(s, PlanStep::LRepay { .. })) {
            does.push(format!("repaying {}", dollars(repay)));
        }
        // Collateral that could have topped it up, if the lender's pool had room for it.
        let full = full_note(pos).map_or(String::new(), |f| format!("; {f}"));
        out.notes.push(if does.is_empty() {
            format!(
                "{head}, and the account has no collateral or USDC there to top it up: it needs {} repaid{full}",
                dollars(after)
            )
        } else if left > 0 {
            format!(
                "{head}; {} helps, and {} more must be repaid to reach {}{full}",
                does.join(" and "),
                dollars(left),
                times(target)
            )
        } else if cut {
            // More steps than one plan holds.
            format!(
                "{head}; {} starts it, and the next check plans the rest",
                does.join(" and ")
            )
        } else {
            format!("{head}; {} brings it back to {}", does.join(" and "), times(target))
        });
        if name == RHEA {
            out.near_spent.extend(spent.into_iter().take(steps.len()));
        }
        out.steps.extend(steps);
    }
    out
}

/// Whether taking `raw` units of the posted holding at place `i` back from the lender leaves its cushion at the
/// target (INTERFACES.md 27). With nothing owed there, any amount it holds may go.
pub fn cushion_holds_after(
    lb: &LenderBook,
    pos: &LenderPos,
    i: usize,
    raw: u128,
    m: &Market,
) -> bool {
    let Some(h) = pos.posted.get(i) else {
        return false;
    };
    if raw > h.raw {
        return false;
    }
    let owed = pos.owed_micro();
    if owed == 0 {
        return true;
    }
    if cushion_bp(pos).is_some_and(|c| c < target_bp(lb)) {
        return false;
    }
    // What these units are worth at the lender, from what it shows for the whole holding.
    let worth = values(&pos.posted, pos.shown_micro(), m)[i];
    let out = if h.raw == 0 {
        0
    } else {
        worth.saturating_mul(raw).div_ceil(h.raw)
    };
    lender::hf_bp(pos.posted_micro.saturating_sub(out), pos.liq_bp, owed)
        .is_some_and(|after| after >= target_bp(lb))
}

#[cfg(test)]
mod tests {
    use super::*;

    const USD: u128 = 1_000_000;

    fn nbtc(raw: u128) -> Holding {
        Holding {
            engine: "nBTC".into(),
            id: "mnbtc.pbf-ops.testnet".into(),
            decimals: 8,
            raw,
        }
    }

    /// The worked example's Rhea position: $100,000 of bitcoin posted, $50,667 owed, a cushion of 1.5.
    fn rhea() -> LenderPos {
        LenderPos {
            lender: "rhea".into(),
            permitted: true,
            posted: vec![nbtc(131_578_947)],
            posted_micro: 100_000 * USD,
            debt_micro: 50_666_666_666,
            liq_bp: 7_600,
            rate_bp: 1_591,
            supply_bp: 1_032,
            free_micro: 1_000_000 * USD,
            ..LenderPos::default()
        }
    }

    fn book(positions: Vec<LenderPos>) -> LenderBook {
        LenderBook {
            positions,
            min_hf_bp: Some(15_000),
            max_rate_bp: Some(2_500),
            ..LenderBook::default()
        }
    }

    fn market() -> Market {
        Engine::v0().calm_market()
    }

    #[test]
    fn a_lender_has_room_up_to_the_target_cushion_and_no_further() {
        // Nothing owed yet, the bitcoin still spare: Rhea can lend $50,667 against $100,000.
        let fresh = LenderPos {
            posted: Vec::new(),
            posted_micro: 0,
            debt_micro: 0,
            spare: vec![nbtc(131_578_947)],
            spare_micro: 100_000 * USD,
            ..rhea()
        };
        let lb = book(vec![fresh.clone()]);
        assert_eq!(rooms(&lb, 94_500 * USD, true), vec![50_666_666_666]);
        // The risk room and what the lender has free both cut it.
        assert_eq!(rooms(&lb, 30_000 * USD, true), vec![30_000 * USD]);
        let dry = book(vec![LenderPos {
            free_micro: 10_000 * USD,
            ..fresh.clone()
        }]);
        assert_eq!(rooms(&dry, 94_500 * USD, true), vec![10_000 * USD]);
        // Fully drawn at 1.5: no room. A permission that asks for 2.0 has none either.
        assert_eq!(rooms(&book(vec![rhea()]), 94_500 * USD, true), vec![0]);
        let strict = LenderBook {
            min_hf_bp: Some(20_000),
            ..lb.clone()
        };
        assert_eq!(rooms(&strict, 94_500 * USD, true), vec![38_000 * USD]);
        // Not permitted, too dear, or the book closed to new risk: none.
        let cancelled = book(vec![LenderPos {
            permitted: false,
            ..fresh.clone()
        }]);
        assert_eq!(rooms(&cancelled, 94_500 * USD, true), vec![0]);
        let dear = LenderBook {
            max_rate_bp: Some(1_500),
            ..lb.clone()
        };
        assert_eq!(rooms(&dear, 94_500 * USD, true), vec![0]);
        assert_eq!(rooms(&lb, 94_500 * USD, false), vec![0]);
    }

    #[test]
    fn ext_lists_a_position_that_is_permitted_or_holds_something() {
        let lb = book(vec![rhea()]);
        let e = ext(&lb, &[0]);
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"[{"l":"rhea","c":100000000000,"d":50666666666,"hf_bp":15000,"r_bp":1591,"s_bp":1032,"room":0,"liq_bp":7600}]"#
        );
        // A cancelled permission with a loan still out is listed; one with nothing there isn't.
        let cancelled = book(vec![LenderPos {
            permitted: false,
            ..rhea()
        }]);
        assert_eq!(ext(&cancelled, &[0]).len(), 1);
        let gone = book(vec![LenderPos {
            permitted: false,
            ..LenderPos::default()
        }]);
        assert!(ext(&gone, &[0]).is_empty());
        // Permitted and empty: listed, with a cushion of 0.
        let open = book(vec![LenderPos {
            lender: "aave".into(),
            permitted: true,
            liq_bp: 8_500,
            ..LenderPos::default()
        }]);
        assert_eq!(ext(&open, &[7])[0].hf_bp, 0);
        // Nothing is posted there yet, so nothing can be borrowed there yet, whatever the spare collateral allows.
        assert_eq!(ext(&open, &[7])[0].room, 0);
        // With $100,000 posted and $20,000 owed, Rhea can lend $30,666.67 more at a cushion of 1.5. `room` is that,
        // or the planning figure when it is smaller (the risk room, say).
        let part = book(vec![LenderPos {
            debt_micro: 20_000 * USD,
            ..rhea()
        }]);
        assert_eq!(ext(&part, &[90_000 * USD])[0].room, 30_666_666_666);
        assert_eq!(ext(&part, &[5_000 * USD])[0].room, 5_000 * USD);
    }

    #[test]
    fn the_cushion_is_the_smaller_of_the_lenders_figure_and_ours() {
        assert_eq!(cushion_bp(&rhea()), Some(15_000));
        assert_eq!(
            cushion_bp(&LenderPos {
                hf_bp: Some(14_200),
                ..rhea()
            }),
            Some(14_200)
        );
        // A borrow on its way counts as owed.
        let sent = LenderPos {
            pending_micro: 10_000 * USD,
            hf_bp: Some(15_000),
            ..rhea()
        };
        assert_eq!(cushion_bp(&sent), Some(12_527));
        assert_eq!(
            cushion_bp(&LenderPos {
                debt_micro: 0,
                ..rhea()
            }),
            None
        );
    }

    #[test]
    fn a_dearer_lender_adds_a_week_of_the_difference_to_the_debt() {
        // Rhea at 15.91% against our 6.50%: 9.41% a year on $50,667 for 7 days is $91.44.
        let gap = rate_gap_usd(&book(vec![rhea()]), 0.065);
        assert!((gap - 91.436).abs() < 0.01, "{gap}");
        // A cheaper lender adds nothing.
        assert_eq!(
            rate_gap_usd(
                &book(vec![LenderPos {
                    rate_bp: 533,
                    ..rhea()
                }]),
                0.065
            ),
            0.0
        );
    }

    #[test]
    fn a_thin_cushion_is_topped_up_with_spare_collateral_first() {
        // Bitcoin fell 15%: $85,000 posted against $50,667 is a cushion of 1.27.
        let fell = LenderPos {
            posted_micro: 85_000 * USD,
            debt_micro: 50_667 * USD,
            ..rhea()
        };
        // With $30,000 of spare bitcoin on NEAR, adding $15,000.66 of it is enough.
        let spare = LenderPos {
            spare: vec![nbtc(49_342_105)],
            spare_micro: 30_000 * USD,
            ..fell.clone()
        };
        let t = top_ups(&book(vec![spare]), &market(), 4, false);
        assert_eq!(t.action, Action::Rebalance);
        assert_eq!(
            t.steps,
            vec![PlanStep::LAdd {
                l: "rhea".into(),
                tok: "mnbtc.pbf-ops.testnet".into(),
                amt: "24672135".into()
            }]
        );
        assert_eq!(
            t.notes,
            vec!["rhea: cushion 1.27 is under 1.35; adding $15,001 of collateral brings it back to 1.50"]
        );
        assert_eq!(t.near_spent, vec![("nBTC".to_string(), 0.24672135)]);
        // With no spare collateral, it repays from the account's USDC there.
        let cash = LenderPos {
            cash_micro: 20_000 * USD,
            ..fell.clone()
        };
        let t = top_ups(&book(vec![cash]), &market(), 4, false);
        assert_eq!(
            t.steps,
            vec![PlanStep::LRepay {
                l: "rhea".into(),
                amt: 7_600_333_334
            }]
        );
        assert_eq!(
            t.notes,
            vec!["rhea: cushion 1.27 is under 1.35; repaying $7,600 brings it back to 1.50"]
        );
        // A little of each: all the spare collateral, then USDC for the rest.
        let both = LenderPos {
            spare: vec![nbtc(13_157_894)],
            spare_micro: 10_000 * USD,
            cash_micro: 20_000 * USD,
            ..fell.clone()
        };
        let t = top_ups(&book(vec![both]), &market(), 4, false);
        assert_eq!(t.steps.len(), 2);
        assert_eq!(
            t.steps[0],
            PlanStep::LAdd {
                l: "rhea".into(),
                tok: "mnbtc.pbf-ops.testnet".into(),
                amt: "13157894".into()
            }
        );
        assert_eq!(
            t.steps[1],
            PlanStep::LRepay {
                l: "rhea".into(),
                amt: 2_533_666_667
            }
        );
        // Spare collateral that isn't enough, and no USDC: it is added, and the line says what is still owed.
        let short = LenderPos {
            spare: vec![nbtc(13_157_894)],
            spare_micro: 10_000 * USD,
            ..fell.clone()
        };
        let t = top_ups(&book(vec![short]), &market(), 4, false);
        assert_eq!(t.steps.len(), 1);
        assert_eq!(
            t.notes,
            vec!["rhea: cushion 1.27 is under 1.35; adding $10,000 of collateral helps, and $2,534 more must be repaid to reach 1.50"]
        );
        // Nothing to top up with: the line says what it needs.
        let t = top_ups(&book(vec![fell.clone()]), &market(), 4, false);
        assert!(t.steps.is_empty());
        assert_eq!(t.action, Action::Rebalance);
        assert_eq!(
            t.notes,
            vec!["rhea: cushion 1.27 is under 1.35, and the account has no collateral or USDC there to top it up: it needs $7,600 repaid"]
        );
    }

    #[test]
    fn a_top_up_runs_without_a_permission_and_is_urgent_under_1_2() {
        let thin = LenderPos {
            permitted: false,
            posted_micro: 75_000 * USD,
            debt_micro: 50_667 * USD,
            cash_micro: 50_000 * USD,
            ..rhea()
        };
        let lb = LenderBook {
            positions: vec![thin.clone()],
            ..LenderBook::default()
        };
        let t = top_ups(&lb, &market(), 4, false);
        assert_eq!(t.action, Action::RebalanceNow);
        assert_eq!(
            t.steps,
            vec![PlanStep::LRepay {
                l: "rhea".into(),
                amt: 12_667_000_000
            }]
        );
        assert!(
            t.notes[0].starts_with("rhea: cushion 1.12 is under 1.20; repaying $12,667"),
            "{:?}",
            t.notes
        );
        // At 1.35 or above nothing happens.
        let fine = LenderPos {
            posted_micro: 91_000 * USD,
            ..thin.clone()
        };
        assert_eq!(
            top_ups(&book(vec![fine]), &market(), 4, false),
            TopUps::default()
        );
        // During an unwind the line is written and the steps wait.
        let t = top_ups(&lb, &market(), 4, true);
        assert!(t.steps.is_empty());
        assert_eq!(
            t.notes,
            vec!["rhea: cushion 1.12 is under 1.20; its top-up waits for the unwind"]
        );
        // The lender's own, lower figure sizes the top-up.
        let theirs = LenderPos {
            hf_bp: Some(11_000),
            ..thin
        };
        let t = top_ups(
            &LenderBook {
                positions: vec![theirs],
                ..LenderBook::default()
            },
            &market(),
            4,
            false,
        );
        assert_eq!(
            t.steps,
            vec![PlanStep::LRepay {
                l: "rhea".into(),
                amt: 13_511_200_001
            }]
        );
    }

    #[test]
    fn a_top_up_goes_by_what_the_lender_shows_and_new_risk_by_what_is_on_its_way_too() {
        // The $50,667 loan has just landed, and the account still lists the borrow: for new risk it counts twice.
        let listed = LenderPos {
            pending_micro: 50_666_666_666,
            hf_bp: Some(15_000),
            ..rhea()
        };
        assert_eq!(cushion_bp(&listed), Some(7_500));
        assert_eq!(shown_cushion_bp(&listed), Some(15_000));
        let lb = book(vec![listed.clone()]);
        assert_eq!(ext(&lb, &rooms(&lb, 94_500 * USD, true))[0].hf_bp, 7_500);
        // Nothing is topped up: Rhea itself shows 1.5. Topping up 0.75 would repay the loan just taken.
        let with_cash = LenderPos {
            cash_micro: 60_000 * USD,
            ..listed.clone()
        };
        assert_eq!(top_ups(&book(vec![with_cash]), &market(), 4, false), TopUps::default());
        // The same for collateral on its way back: $40,000 of the $100,000 is leaving, so $60,000 counts for new
        // risk (a cushion of 0.9), while Rhea shows, or showed a moment ago, all of it.
        let leaving = LenderPos {
            posted_micro: 60_000 * USD,
            leaving_micro: 40_000 * USD,
            spare: vec![nbtc(52_631_578)],
            spare_micro: 40_000 * USD,
            hf_bp: Some(15_000),
            ..rhea()
        };
        assert_eq!((cushion_bp(&leaving), shown_cushion_bp(&leaving)), (Some(9_000), Some(15_000)));
        assert_eq!(top_ups(&book(vec![leaving.clone()]), &market(), 4, false), TopUps::default());
        // New borrowing there leans only on what stays: nothing, even with the spare bitcoin.
        let lb = book(vec![leaving]);
        assert_eq!(rooms(&lb, 94_500 * USD, true), vec![0]);
        // A cushion the lender itself shows as thin is topped up, and sized on what it shows: $85,000 against
        // $50,667, as in the test above, whatever else is on its way.
        let thin = LenderPos {
            posted_micro: 85_000 * USD,
            debt_micro: 50_667 * USD,
            pending_micro: 5_000 * USD,
            cash_micro: 20_000 * USD,
            ..rhea()
        };
        let t = top_ups(&book(vec![thin]), &market(), 4, false);
        assert_eq!(t.action, Action::Rebalance);
        assert_eq!(
            t.steps,
            vec![PlanStep::LRepay {
                l: "rhea".into(),
                amt: 7_600_333_334
            }]
        );
        // A borrow on its way to a lender that shows no debt yet is nothing to top up.
        let first = LenderPos {
            debt_micro: 0,
            pending_micro: 90_000 * USD,
            ..rhea()
        };
        assert_eq!((cushion_bp(&first), shown_cushion_bp(&first)), (Some(8_444), None));
        assert_eq!(top_ups(&book(vec![first]), &market(), 4, false), TopUps::default());
    }

    #[test]
    fn collateral_comes_back_only_while_the_cushion_stays_at_the_target() {
        // $100,000 posted against $40,000: the target needs $78,947.37, so $21,000 may go and $21,100 may not.
        let pos = LenderPos {
            debt_micro: 40_000 * USD,
            ..rhea()
        };
        let lb = book(vec![pos.clone()]);
        let m = market();
        let units = |usd: u128| 131_578_947 * usd / 100_000;
        assert!(cushion_holds_after(&lb, &pos, 0, units(21_000), &m));
        assert!(!cushion_holds_after(&lb, &pos, 0, units(21_100), &m));
        // More than is posted, or a holding that isn't there: no.
        assert!(!cushion_holds_after(&lb, &pos, 0, 131_578_948, &m));
        assert!(!cushion_holds_after(&lb, &pos, 1, 1, &m));
        // Nothing owed: all of it.
        let clear = LenderPos {
            debt_micro: 0,
            ..rhea()
        };
        assert!(cushion_holds_after(&lb, &clear, 0, 131_578_947, &m));
    }

    #[test]
    fn the_order_comes_from_the_pool_and_defaults_to_cheapest() {
        use serde_json::json;
        assert_eq!(
            funding_order(&json!({"funding": {"order": "lender_first", "loan_days": 90}})),
            Order::LenderFirst
        );
        assert_eq!(
            funding_order(&json!({"funding": {"order": "pool_first"}})),
            Order::PoolFirst
        );
        assert_eq!(funding_order(&json!({"caps": {}})), Order::Cheapest);
        assert_eq!(
            funding_order(&json!({"funding": {"order": "fastest"}})),
            Order::Cheapest
        );
    }
}
