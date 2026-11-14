//! The credit check (INTERFACES.md 18): what our pool would lend a new client with this book, next to what Rhea
//! would lend against the NEAR-side spot alone. It is a pure function of [`CreditInputs`] (the reads are
//! `pb_read::credit`), so `backtest credit <file>` recomputes a run's result, as `backtest verdict` does a verdict.
//!
//! The book is valued as for a new account: no loan, no history, no KYB (RISK_ENGINE.md 6-7). Prices follow
//! RISK_ENGINE.md 3 as `check` does, with Hyperliquid mainnet's oracle as one source, and π for the bridged tokens
//! and USDT from a dry 1Click quote without our key (3.3).
use crate::bands;
use crate::verdict::{params_hash, refusal, Coins, Credit, Venues, MODEL};
use pb_read::credit::{self as cr, Spot, Universe, WhatIf};
use pb_read::hl;
use pb_read::inputs::CoinReads;
use pb_read::market;
use pb_read::near::{self, pool_name, PoolState};
use pb_read::read::Net;
use pb_read::util::{bp, f64_of, micro_down, micro_exact, micro_up, pow10, u128_of, u64_of};
use risk_core::lender;
use risk_core::prices::{self, PI_NO_READING};
use risk_core::rating::{self, ScoreInputs};
use risk_core::valuation::token_value;
use risk_core::{Account, ClientTier, Engine, Market, Order, OrderedMap};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// The inputs a credit check reads (`pb_read::credit`), for `backtest credit`.
pub use pb_read::credit::CreditInputs;

pub const CREDIT_V: u32 = 1;
/// The result stays under this many bytes (INTERFACES.md 18).
pub const MAX_RESULT_BYTES: usize = 8000;
/// At most this many unlisted coins are named; `unlisted_more` counts the rest.
pub const MAX_UNLISTED: usize = 40;
/// At most this many `ignored` lines; one more line counts the rest.
pub const MAX_IGNORED: usize = 10;
/// The utilisation the plan quotes its rates at (RISK_ENGINE.md 13).
pub const REFERENCE_UTIL: f64 = 0.6;
/// How long a loan is expected to last, in days, when the pool's `get_params().funding.loan_days` doesn't say
/// (FUNDING.md 6.4): a move of bitcoin to a lender's chain must pay for itself within it.
pub const LOAN_DAYS: u32 = 90;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreditResult {
    pub ok: bool,
    pub v: u32,
    pub mode: String,
    pub model: String,
    pub params: String,
    pub network: String,
    pub hl_address: Option<String>,
    pub book: Option<WhatIf>,
    pub spot: Vec<Spot>,
    /// When the prices were read (the enclave's clock, unix ms).
    pub at_ms: u64,
    /// The testnet block our pool's terms were read at.
    pub near_blk: u64,
    pub verdict: CreditVerdict,
    pub limits: Limits,
    pub unlisted: Vec<String>,
    /// How many more unlisted coins there are than `unlisted` names. Left out when 0.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub unlisted_more: u64,
    pub without_unlisted: Option<WithoutUnlisted>,
    pub ignored: Vec<Ignored>,
    /// The reference price of each coin priced, micro-USD per Hyperliquid unit.
    pub prices: BTreeMap<String, i64>,
    pub pi: BTreeMap<String, PiUsed>,
    pub rhea: RheaTerms,
    pub pool: PoolTerms,
    /// How the line would be funded (INTERFACES.md 27). Left out when the inputs hold no lender reads: a run
    /// from before them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub funding: Option<Funding>,
    #[serde(rename = "in")]
    pub inputs: String,
}

/// How the line would be funded (INTERFACES.md 27; FUNDING.md 6.3 and 6.4): what each outside lender would lend
/// against the book's bitcoin, with our pool lending the rest of the line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Funding {
    /// The credit line being funded (`verdict.credit.line`).
    pub line: u128,
    /// Our pool's rate for this tier at 60% lent (`verdict.rate_bp_at_60`).
    pub pool_rate_bp: u64,
    /// The cushion a lender's part keeps: a health factor in bp.
    pub target_hf_bp: u32,
    /// The loan's expected life, in days.
    pub loan_days: u32,
    /// `aave` before `rhea`. A lender whose terms couldn't be read is left out.
    pub lenders: Vec<FundingLender>,
    /// The lender the 6.4 rule would use, or `pool`.
    pub choice: String,
}

/// One lender's part of the line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FundingLender {
    pub l: String,
    pub chain: String,
    /// The bitcoin token the lender takes.
    pub collateral: String,
    /// The lender's USDC borrow and deposit rates now, in bp a year.
    pub rate_bp: u32,
    pub supply_bp: u32,
    /// The lender liquidates when the debt passes this share of the bitcoin's value, and lends up to `ltv_bp` of
    /// it; `penalty_bp` is what a liquidation costs the borrower.
    pub liq_bp: u32,
    pub ltv_bp: u32,
    pub penalty_bp: u32,
    /// The USDC the lender has free to lend now.
    pub free: u128,
    /// What the lender would lend against the book's bitcoin at the target cushion, cut to the line and to what
    /// it has free; `pool` is the rest of the line.
    pub lends: u128,
    pub pool: u128,
    /// How far bitcoin can fall before the lender sells, in bp of its price now. 0 when it lends nothing.
    pub fall_bp: u32,
    /// The whole loan's yearly cost with pass-through pricing: the lender's rate on its part, our pool's on ours.
    pub blended_bp: u32,
    /// The cost of getting the bitcoin to the lender's chain. `None` for a lender on NEAR, and when 1Click gave
    /// no quote.
    #[serde(rename = "move")]
    pub move_cost: Option<MoveCost>,
    /// Whether the 6.4 rule would use this lender.
    pub used: bool,
    /// The same, in words.
    pub why: String,
}

/// Moving the bitcoin a lender's part needs to that lender's chain and back, against what the lender's lower rate
/// saves. Each quote is for the book's bitcoin up to $100,000 of it; a larger move is priced at the same rate.
///
/// The way back and the total are left out by a run from before the way back was asked (11 Nov), which priced the
/// way there alone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoveCost {
    /// The way there: the bitcoin lost on the way, in bp of what is sent, and in micro-USD.
    pub cost_bp: u32,
    pub cost: u128,
    /// The way back to NEAR, the same way. When 1Click gave no quote for it, it counts the same as the way there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub back_bp: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub back: Option<u128>,
    /// Whether 1Click quoted the way back. False: `back` is the way there counted again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub back_quoted: Option<bool>,
    /// Both ways together: what the lender's lower rate must beat for the lender to be used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u128>,
    /// The interest the lender's lower rate saves over `loan_days`. 0 when its rate isn't lower.
    pub saves: u128,
    pub source: String,
}

impl MoveCost {
    /// What the move costs in all: there and back, or the way there alone in a run from before the way back.
    pub fn in_all(&self) -> u128 {
        self.total.unwrap_or(self.cost)
    }
}

fn is_zero(x: &u64) -> bool {
    *x == 0
}

/// The Appendix A fields that make sense without an account, plus `rate_bp_at_60` and `volf_bp`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreditVerdict {
    pub eq: i64,
    pub eq_allow: i64,
    pub mm: i64,
    pub im: i64,
    pub score: i64,
    pub tier: String,
    pub rate_bp: u64,
    pub rate_bp_at_60: u64,
    pub credit: Credit,
    pub top: Vec<String>,
    pub topup: i64,
    pub venues: Venues,
    pub coins: Coins,
    pub hr_bp: u64,
    pub hr7_bp: u64,
    pub exp_bp: u64,
    pub volf_bp: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Limits {
    /// The pool's limit in an account's first week (`get_params().caps.new_account_limit`).
    pub first_week: u128,
    /// The tier's ceiling (`get_params().caps.ceiling`).
    pub ceiling: u128,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WithoutUnlisted {
    pub line: u128,
    pub binding: String,
    pub score: i64,
    pub tier: String,
    pub rate_bp: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ignored {
    pub what: String,
    pub why: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PiUsed {
    pub bp: u64,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RheaTerms {
    pub contract: String,
    pub blk: u64,
    pub max: u128,
    pub safe: u128,
    pub usdc_borrow_apr_bp: u64,
    pub usdc_volatility_bp: u64,
    pub tokens: Vec<RheaToken>,
    /// Why Rhea's terms are missing, if they are. Left out when they were read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RheaToken {
    pub token: String,
    pub value: u128,
    pub volatility_bp: u64,
    pub collateral: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PoolTerms {
    pub id: String,
    pub util_bp: u64,
}

const SOURCE_QUOTE: &str = "1Click dry quote, no key";
/// The move's `source` when 1Click quoted both ways.
const SOURCE_BOTH_WAYS: &str = "1Click dry quotes, no key, there and back";
const DAYS_A_YEAR: u128 = 365;

/// The Hyperliquid side as the engine will hold it, and what was left out.
struct HlSide {
    perps: OrderedMap<f64>,
    entry: OrderedMap<f64>,
    orders: Vec<Order>,
    /// Realised collateral with the unlisted positions' open PnL kept in, and with it left out.
    cash: f64,
    cash_without: f64,
    unlisted: BTreeSet<String>,
    ignored: Vec<Ignored>,
}

/// Dollars, whole, with thousands separators: what the `ignored` lines say.
fn dollars(x: f64) -> String {
    risk_core::py::commas0(x)
}

fn hl_side(ci: &CreditInputs, u: &Universe) -> Result<HlSide, String> {
    let mut side = HlSide {
        perps: OrderedMap::new(),
        entry: OrderedMap::new(),
        orders: Vec::new(),
        cash: 0.0,
        cash_without: 0.0,
        unlisted: BTreeSet::new(),
        ignored: Vec::new(),
    };
    if let Some(b) = &ci.request.book {
        // A what-if account: each position entered at Hyperliquid mainnet's mark, so no open PnL.
        let cash = b
            .usdc
            .parse::<i128>()
            .map_err(|_| "book.usdc is not a number")? as f64
            / 1e6;
        side.cash = cash;
        side.cash_without = cash;
        for p in &b.positions {
            if !u.allowed.contains(&p.coin) {
                side.unlisted.insert(p.coin.clone());
                continue;
            }
            let mark = ci
                .hl
                .assets
                .get(&p.coin)
                .and_then(|a| hl::asset(a).ok())
                .and_then(|a| a.mark)
                .ok_or_else(|| {
                    format!(
                        "no Hyperliquid mainnet mark for {}, so its position can't be entered",
                        p.coin
                    )
                })?;
            let usd = p
                .usd
                .parse::<i128>()
                .map_err(|_| "a book position is not a number")? as f64
                / 1e6;
            side.perps.insert(&p.coin, usd / mark);
            side.entry.insert(&p.coin, mark);
        }
        return Ok(side);
    }
    if ci.request.hl_address.is_none() {
        return Ok(side);
    }
    let positions = cr::positions(&ci.hl.state)?;
    let isolated_margin: f64 = positions
        .iter()
        .filter(|p| p.isolated)
        .map(|p| p.margin_used)
        .sum();
    let value = match hl::mode(&ci.hl.abstraction)? {
        hl::Mode::Standard => cr::cross_value(&ci.hl.state)?,
        // The docs' unified margin ratio: cross maintenance margin over (spot total − isolated margin).
        hl::Mode::Unified => hl::spot_usdc(&ci.hl.spot)? - isolated_margin,
    };
    let (mut listed_pnl, mut unlisted_pnl) = (0.0, 0.0);
    let mut isolated = Vec::new();
    for p in &positions {
        if p.isolated {
            isolated.push(p.coin.clone());
        } else if u.allowed.contains(&p.coin) {
            side.perps.insert(&p.coin, p.szi);
            side.entry.insert(&p.coin, p.entry);
            listed_pnl += p.upnl;
        } else {
            side.unlisted.insert(p.coin.clone());
            unlisted_pnl += p.upnl;
        }
    }
    side.cash = value - listed_pnl;
    side.cash_without = side.cash - unlisted_pnl;
    if !isolated.is_empty() {
        side.ignored.push(Ignored {
            what: format!("isolated {}", isolated.join(", ")),
            why: format!(
                "isolated positions and their ${} of margin aren't counted",
                dollars(isolated_margin)
            ),
        });
    }
    let mut spot_orders = 0;
    for o in ci.hl.orders.as_array().map_or(&[][..], Vec::as_slice) {
        let Some(coin) = o.get("coin").and_then(Value::as_str) else {
            continue;
        };
        if cr::is_spot_coin(coin) {
            spot_orders += 1;
        } else if !u.allowed.contains(coin) {
            side.unlisted.insert(coin.to_string());
        } else if let (Some(side_s), Some(px), Some(sz)) = (
            o.get("side").and_then(Value::as_str),
            o.get("limitPx").and_then(f64_of),
            o.get("sz").and_then(f64_of),
        ) {
            side.orders.push(Order {
                coin: coin.to_string(),
                size: if side_s == "B" { sz } else { -sz },
                limit_px: px,
                reduce_only: o
                    .get("reduceOnly")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            });
        }
    }
    if spot_orders > 0 {
        side.ignored.push(Ignored {
            what: format!(
                "{spot_orders} spot order{}",
                if spot_orders == 1 { "" } else { "s" }
            ),
            why: "Hyperliquid spot isn't part of version 0".into(),
        });
    }
    let unified = hl::mode(&ci.hl.abstraction)? == hl::Mode::Unified;
    for b in ci
        .hl
        .spot
        .get("balances")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
    {
        let coin = b.get("coin").and_then(Value::as_str).unwrap_or("?");
        let total = b.get("total").and_then(f64_of).unwrap_or(0.0);
        if total <= 0.0 || (coin == "USDC" && unified) {
            continue;
        }
        side.ignored.push(Ignored {
            what: format!("spot {coin} {}", trim_number(total)),
            why: if coin == "USDC" {
                "spot USDC of a standard account isn't margin for its perps".into()
            } else {
                "Hyperliquid spot tokens other than USDC aren't counted".into()
            },
        });
    }
    let vaults: Vec<f64> = ci
        .hl_vaults
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|v| v.get("equity").and_then(f64_of))
        .filter(|e| *e > 0.0)
        .collect();
    if !vaults.is_empty() {
        side.ignored.push(Ignored {
            what: format!(
                "{} vault deposits, ${}",
                vaults.len(),
                dollars(vaults.iter().sum())
            ),
            why: "vault deposits aren't counted".into(),
        });
    }
    let staked: f64 = ["delegated", "undelegated", "totalPendingWithdrawal"]
        .iter()
        .filter_map(|k| ci.hl_staking.get(*k).and_then(f64_of))
        .sum();
    if staked > 0.0 {
        side.ignored.push(Ignored {
            what: format!("staked HYPE {}", trim_number(staked)),
            why: "staking isn't counted".into(),
        });
    }
    Ok(side)
}

/// A token amount as people write it: at most 4 decimals, no trailing zeros.
fn trim_number(x: f64) -> String {
    let s = format!("{x:.4}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    s.to_string()
}

/// What [`build_market`] gives: the market, the coins with no new risk, the reduce-only ones, and the π used.
type Built = (
    Market,
    BTreeSet<String>,
    BTreeSet<String>,
    BTreeMap<String, PiUsed>,
);

/// The market for the coins in `groups`, as `check` builds it (pb_read::book::build_market), but on Hyperliquid
/// mainnet and with π from the dry quotes. No coin statuses apply: the testnet pool's list reflects testnet's
/// gaps. Returns the market, the coins with no new risk, the reduce-only ones, and the π used.
fn build_market(
    eng: &mut Engine,
    ci: &CreditInputs,
    a: &Account,
    groups: &BTreeSet<String>,
    pool: &PoolState,
) -> Result<Built, String> {
    let mut m = Market {
        px: BTreeMap::new(),
        mark: BTreeMap::new(),
        twap: BTreeMap::new(),
        wrap: BTreeMap::new(),
        volf: BTreeMap::new(),
        funding: BTreeMap::new(),
        util: 0.0,
        pool_capital: pool.capital as f64 / 1e6,
        pool_loans: pool.loans as f64 / 1e6,
        book: BTreeMap::new(),
        frozen: BTreeSet::new(),
        wrap_allow: BTreeMap::new(),
    };
    if pool.capital > 0 {
        m.util = pool.loans as f64 / pool.capital as f64;
    }
    let mut uncertain = BTreeSet::new();
    let mut reduce_only = BTreeSet::new();
    let no_reads = CoinReads::default();
    let btc_ratio = market::sigma(ci.coins.get("BTC").unwrap_or(&no_reads), ci.now_ms)
        .map(|s| s / eng.coin("BTC").params.vol_ref);
    for g in groups {
        let coin = eng
            .find_coin(g)
            .ok_or_else(|| format!("{g} is not in the universe"))?
            .clone();
        let asset = ci.hl.assets.get(g).map(hl::asset).transpose()?;
        let off_hl = ci.hl.meta_read && asset.as_ref().is_none_or(|x| x.unusable);
        let oracle = asset
            .as_ref()
            .filter(|_| !off_hl)
            .and_then(|x| x.oracle)
            .map(|p| (p, ci.hl.at_ms));
        let reads = ci.coins.get(g).unwrap_or(&no_reads);
        let cp = market::coin_price(reads, coin.tier, coin.unit_mult, oracle, ci.now_ms);
        let px = cp.reference.price.ok_or_else(|| {
            format!("no valid price for {g}: none of its sources answered within 10 s")
        })?;
        if cp.uncertain() || btc_ratio.is_none() {
            uncertain.insert(g.clone());
        }
        let own_ratio = cp.sigma.map_or(1.0, |s| s / coin.params.vol_ref);
        m.volf
            .insert(g.clone(), own_ratio.max(btc_ratio.unwrap_or(1.0)));
        m.px.insert(g.clone(), px);
        m.twap.insert(g.clone(), cp.twap.unwrap_or(px));
        m.funding.insert(g.clone(), coin.funding_30d_apr);
        if let Some(x) = asset.as_ref().filter(|_| !off_hl) {
            if let Some(mark) = x.mark {
                m.mark.insert(g.clone(), mark);
            }
            // 3.1: margin tables are read live, here mainnet's.
            if let Some(c) = eng.coins.iter_mut().find(|c| &c.name == g) {
                c.margin_tiers = x.tiers.clone();
                c.hl_max_leverage = x.max_leverage;
            }
        }
        if off_hl {
            reduce_only.insert(g.clone());
        }
        if a.perps.get_or(g, 0.0) != 0.0 && !m.mark.contains_key(g) {
            return Err(format!(
                "no Hyperliquid mark price for {g}, where the book has a position"
            ));
        }
    }
    // 3.3: π from one dry quote for an hour of capacity, at once for the state and new credit; no quote is the
    // extreme depeg, 0.80, and the token is reduce-only.
    let mut pis = BTreeMap::new();
    for (t, &units) in a.near.iter() {
        if units == 0.0 || !matches!(t, "nBTC" | "ETH.b" | "USDT") {
            continue;
        }
        let name = pool_name(t);
        let tok = cr::token(name).expect("a mainnet token");
        let price = match cr::group_of(t) {
            Some(g) => m.px.get(g).copied(),
            None => Some(1.0),
        };
        let quoted = ci.quotes.get(name).and_then(|q| {
            let out = cr::quote_out(q)? as f64 / 1e6;
            let sold = q.amount.parse::<u128>().ok()? as f64 / pow10(tok.decimals);
            let ratio = out / (sold * price?);
            (ratio.is_finite() && ratio > 0.0).then(|| prices::pi(ratio))
        });
        let (pi, source) = match quoted {
            Some(pi) => (pi, SOURCE_QUOTE.to_string()),
            None => {
                reduce_only.insert(name.to_string());
                let why = ci
                    .quotes
                    .get(name)
                    .map_or("not asked".to_string(), cr::quote_error);
                (
                    PI_NO_READING,
                    format!("no 1Click quote ({why}): 0.80, and reduce-only"),
                )
            }
        };
        m.wrap.insert(t.to_string(), pi);
        pis.insert(name.to_string(), PiUsed { bp: bp(pi), source });
    }
    // 4.2: what the rest of our book holds on the NEAR side. A new account holds none of it.
    for (name, &amount) in &pool.book {
        if let Some(t) = near::engine_name(name) {
            m.book.insert(t.to_string(), amount as f64 / 1e6);
        }
    }
    Ok((m, uncertain, reduce_only, pis))
}

/// The rating of a new account with this book (RISK_ENGINE.md 6): hedge points only, no history, no KYB, and the
/// tier the pool gives an account it doesn't know yet (Standard at best).
fn rate(
    eng: &Engine,
    a: &Account,
    m: &Market,
    now_ns: u64,
    upgrade_ns: u64,
) -> (u64, u64, f64, i64, ClientTier) {
    let hr_now = eng.hedge_ratio(a, m);
    let e_mark = eng.equity_mark(a, m);
    let gross = pb_read::book::gross_exposure(eng, a, m);
    let exp_now = if e_mark > 0.0 {
        gross / e_mark
    } else if gross > 0.0 {
        f64::INFINITY
    } else {
        0.0
    };
    let (hr_bp, exp_bp) = (bp(hr_now), bp(exp_now));
    let (hr7, exp7) = near::week_averages(&[], near::hour_of(now_ns), hr_bp, exp_bp);
    let score = rating::score(&ScoreInputs {
        exposure_share: exp7 / 1e4,
        ..ScoreInputs::new(hr_now, hr7 / 1e4)
    });
    let tier = near::verdict_tier(rating::tier_of(score, false), None, now_ns, upgrade_ns);
    (hr_bp, exp_bp, hr7, score, tier)
}

/// One evaluation of the book: the requirement and the credit line.
struct Eval {
    rq: risk_core::Requirement,
    e_allow: f64,
    w: f64,
    binding: String,
    score: i64,
    tier: ClientTier,
    hr_bp: u64,
    exp_bp: u64,
    hr7: f64,
}

fn evaluate(
    eng: &Engine,
    a: &mut Account,
    m: &Market,
    now_ns: u64,
    upgrade_ns: u64,
    no_new_risk: bool,
) -> Eval {
    let (hr_bp, exp_bp, hr7, score, tier) = rate(eng, a, m, now_ns, upgrade_ns);
    a.tier = tier;
    let rq = eng.requirement(a, m);
    let e_allow = eng.equity_allow(a, m);
    let allowance = eng.borrow_allowance(a, m, Some(&rq), 0, Some(score));
    let (w, binding) = if no_new_risk {
        (0.0, "PRICE".to_string())
    } else {
        let code = allowance.key.split(' ').next().unwrap_or("").to_string();
        (allowance.w, code)
    };
    Eval {
        rq,
        e_allow,
        w,
        binding,
        score,
        tier,
        hr_bp,
        exp_bp,
        hr7,
    }
}

fn rate_bp(eng: &Engine, util: f64, tier: ClientTier) -> u64 {
    bp(eng.params.base_rate(util) + tier.spec().spread)
}

/// Rhea alone: what it would lend in USDC against the spot, valued at our prices. `max` is a health factor of
/// 1.0 (each token's value × its volatility ratio × USDC's), `safe` one of 1.2.
fn rhea_terms(ci: &CreditInputs, a: &Account, m: &Market) -> RheaTerms {
    let mut out = RheaTerms {
        contract: cr::RHEA.to_string(),
        blk: ci.rhea.block.height,
        max: 0,
        safe: 0,
        usdc_borrow_apr_bp: 0,
        usdc_volatility_bp: 0,
        tokens: Vec::new(),
        error: None,
    };
    let assets = ci.rhea.views.get("get_assets").and_then(Value::as_array);
    if assets.is_none() {
        out.error = Some("Rhea's terms couldn't be read".into());
    }
    let find = |id: &str| {
        assets.and_then(|list| {
            list.iter()
                .find(|x| x.get("token_id").and_then(Value::as_str) == Some(id))
        })
    };
    let config_u64 = |x: &Value, k: &str| {
        x.pointer(&format!("/config/{k}"))
            .and_then(pb_read::util::u64_of)
    };
    let flag = |x: &Value, k: &str| {
        x.pointer(&format!("/config/{k}"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    let usdc = find(cr::MAINNET_TOKENS[0].id);
    let usdc_borrowable = usdc.is_some_and(|x| flag(x, "can_borrow"));
    if let Some(x) = usdc {
        out.usdc_volatility_bp = config_u64(x, "volatility_ratio").unwrap_or(0);
        out.usdc_borrow_apr_bp = x.get("borrow_apr").and_then(f64_of).map_or(0, bp);
    }
    let mut max: u128 = 0;
    for s in &ci.request.spot {
        let t = cr::token(&s.token).expect("checked token");
        let units = a.near.get_or(t.engine, 0.0);
        let value = if units > 0.0 {
            micro_down(token_value(t.engine, units, m, 0.0, 0.0)).max(0) as u128
        } else {
            0
        };
        let asset = find(t.id);
        let vol = asset
            .and_then(|x| config_u64(x, "volatility_ratio"))
            .unwrap_or(0);
        // Collateral a new depositor can use now: Rhea takes it as collateral and takes deposits of it.
        let collateral =
            asset.is_some_and(|x| flag(x, "can_use_as_collateral") && flag(x, "can_deposit"));
        if collateral && usdc_borrowable {
            max += value * u128::from(vol) * u128::from(out.usdc_volatility_bp) / 100_000_000;
        }
        out.tokens.push(RheaToken {
            token: t.name.to_string(),
            value,
            volatility_bp: vol,
            collateral,
        });
    }
    out.max = max;
    out.safe = max * 5 / 6;
    out
}

/// One lender's terms for a USDC loan against bitcoin, as read.
struct LenderTerms {
    l: &'static str,
    /// The lender's name in a sentence.
    name: &'static str,
    chain: &'static str,
    collateral: &'static str,
    rate_bp: u32,
    supply_bp: u32,
    liq_bp: u32,
    ltv_bp: u32,
    penalty_bp: u32,
    free: u128,
    /// Whether it lends USDC against new bitcoin now.
    open: bool,
    /// Whether the book's bitcoin, which is nBTC on NEAR, must move to another chain first.
    moves: bool,
}

/// Aave's core market on Ethereum, from its API's answer. `None` if that wasn't read.
fn aave_lender(reads: &cr::LenderReads) -> Option<LenderTerms> {
    let t = cr::aave_terms(&reads.aave).ok()?;
    Some(LenderTerms {
        l: pb_read::lenders::AAVE,
        name: "Aave",
        chain: "Ethereum",
        collateral: "WBTC",
        rate_bp: t.rate_bp,
        supply_bp: t.supply_bp,
        liq_bp: t.liq_bp,
        ltv_bp: t.ltv_bp,
        penalty_bp: t.penalty_bp,
        free: t.free_micro,
        open: t.open,
        moves: true,
    })
}

/// Rhea on NEAR, from the `get_assets` answer. `None` if it wasn't read or lacks USDC or nBTC.
///
/// Rhea lends up to its liquidation line, nBTC's volatility ratio times USDC's, so `ltv_bp` equals `liq_bp`. Its
/// liquidation discount isn't a fixed share: it is half of how far the position is under the line, nothing at the
/// line itself (research/rhea.md 3), so `penalty_bp` is 0.
fn rhea_lender(ci: &CreditInputs) -> Option<LenderTerms> {
    let assets = ci.rhea.views.get("get_assets")?.as_array()?;
    let find = |id: &str| {
        assets
            .iter()
            .find(|x| x.get("token_id").and_then(Value::as_str) == Some(id))
    };
    let (usdc, nbtc) = (
        find(cr::MAINNET_TOKENS[0].id)?,
        find(cr::MAINNET_TOKENS[1].id)?,
    );
    let ratio = |x: &Value| x.pointer("/config/volatility_ratio").and_then(u64_of);
    let flag = |x: &Value, k: &str| {
        x.pointer(&format!("/config/{k}"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    let apr = |k: &str| usdc.get(k).and_then(f64_of).map(|x| bp(x) as u32);
    let liq_bp = ratio(nbtc)?.checked_mul(ratio(usdc)?)? / 10_000;
    let liq_bp = u32::try_from(liq_bp).ok().filter(|x| *x <= 10_000)?;
    Some(LenderTerms {
        l: pb_read::lenders::RHEA,
        name: "Rhea",
        chain: "NEAR",
        collateral: "nBTC",
        rate_bp: apr("borrow_apr")?,
        supply_bp: apr("supply_apr")?,
        liq_bp,
        ltv_bp: liq_bp,
        penalty_bp: 0,
        free: cr::rhea_free_micro(usdc)?,
        open: flag(nbtc, "can_use_as_collateral")
            && flag(nbtc, "can_deposit")
            && flag(usdc, "can_borrow"),
        moves: false,
    })
}

/// A rate in bp as people write it: `5.08%`.
fn percent(bp: u64) -> String {
    format!("{}.{:02}%", bp / 100, bp % 100)
}

/// Micro-USD as whole dollars: `$56,667`.
fn usd(micro: u128) -> String {
    format!("${}", dollars(micro as f64 / 1e6))
}

/// The yearly cost in bp of a loan that is part lender, part pool, each at its own rate, to the nearest bp.
fn blended_bp(lends: u128, rate_bp: u32, pool: u128, pool_rate_bp: u64) -> u32 {
    let whole = lends + pool;
    if whole == 0 {
        return pool_rate_bp as u32;
    }
    let cost = lends * u128::from(rate_bp) + pool * u128::from(pool_rate_bp);
    ((cost + whole / 2) / whole) as u32
}

/// The interest a part of `lends` saves over `days` at the lender's rate instead of our pool's, rounded down.
/// 0 when the lender's rate isn't lower.
fn saved_micro(lends: u128, rate_bp: u32, pool_rate_bp: u64, days: u32) -> u128 {
    let gap = u128::from(pool_rate_bp).saturating_sub(u128::from(rate_bp));
    lends * gap * u128::from(days) / (10_000 * DAYS_A_YEAR)
}

/// INTERFACES.md 27: how the line would be funded. For each lender read, what it lends against the book's
/// bitcoin at the target cushion, our pool's part, and whether FUNDING.md 6.4 would use it: a lender is used when
/// its rate is under our pool's and, if the bitcoin must move to its chain, the interest saved over the loan's
/// expected life beats the cost of the move. `None` when the inputs hold no lender reads.
///
/// A lender looks at the bitcoin alone. It is counted as the lender counts it, at bitcoin's reference price with
/// no depeg ratio (Rhea prices nBTC as BTC), and only as much of it is posted as the lender's part needs.
fn funding(
    ci: &CreditInputs,
    a: &Account,
    m: &Market,
    line: u128,
    pool_rate_bp: u64,
    params: &Value,
) -> Option<Funding> {
    let reads = ci.lenders.as_ref()?;
    let loan_days = params
        .pointer("/funding/loan_days")
        .and_then(u64_of)
        .filter(|d| (1..=3_650).contains(d))
        .map_or(LOAN_DAYS, |d| d as u32);
    let target = lender::TARGET_HF_BP;
    let bitcoin = m.px.get("BTC").map_or(0, |p| {
        micro_down(a.near.get_or("nBTC", 0.0) * p).max(0) as u128
    });
    let mut lenders = Vec::new();
    // The lender used: the one that saves the most after its move, the first listed on a tie.
    let mut choice: Option<(&str, u128)> = None;
    for t in [aave_lender(reads), rhea_lender(ci)].into_iter().flatten() {
        let limit = if t.open {
            lender::limit_micro(bitcoin, t.liq_bp, target)
        } else {
            0
        };
        let uncut = limit.min(line);
        let mut lends = uncut.min(t.free);
        if lends < lender::MIN_LENDER_MICRO {
            lends = 0;
        }
        let pool = line - lends;
        // Just enough bitcoin for the lender's part to sit at the target cushion.
        let posted = lender::add_to_target_micro(0, t.liq_bp, target, lends).min(bitcoin);
        let fall_bp = lender::fall_to_liquidation_bp(posted, t.liq_bp, lends).unwrap_or(0);
        let saves = saved_micro(lends, t.rate_bp, pool_rate_bp, loan_days);
        let quote = reads.move_quote.as_ref().filter(|_| t.moves);
        let priced = |bp: u32| (posted * u128::from(bp)).div_ceil(10_000);
        let move_cost = quote.and_then(cr::move_cost_bp).map(|cost_bp| {
            let cost = priced(cost_bp);
            match &reads.move_back {
                // A run from before the way back was asked: the way there alone, as it was.
                None => MoveCost {
                    cost_bp,
                    cost,
                    back_bp: None,
                    back: None,
                    back_quoted: None,
                    total: None,
                    saves,
                    source: SOURCE_QUOTE.to_string(),
                },
                // There and back. With no quote for the way back, it counts the same as the way there.
                Some(back) => {
                    let quoted = cr::move_cost_bp(back);
                    let back_bp = quoted.unwrap_or(cost_bp);
                    MoveCost {
                        cost_bp,
                        cost,
                        back_bp: Some(back_bp),
                        back: Some(priced(back_bp)),
                        back_quoted: Some(quoted.is_some()),
                        total: Some(cost + priced(back_bp)),
                        saves,
                        source: match quoted {
                            Some(_) => SOURCE_BOTH_WAYS.to_string(),
                            None => format!(
                                "{SOURCE_QUOTE}, for the way there; no quote for the way back ({}), so it counts \
                                 the same again",
                                cr::quote_error(back)
                            ),
                        },
                    }
                }
            }
        });
        let cheaper = u64::from(t.rate_bp) < pool_rate_bp;
        let used = lends > 0
            && cheaper
            && (!t.moves || move_cost.as_ref().is_some_and(|mv| saves > mv.in_all()));
        if used {
            let net = saves - move_cost.as_ref().map_or(0, MoveCost::in_all);
            if choice.is_none_or(|(_, best)| net > best) {
                choice = Some((t.l, net));
            }
        }
        let whole = format!("our pool lends the whole {}", usd(line));
        let why = if line == 0 {
            format!(
                "This book gets no line, so there is nothing for {} to fund.",
                t.name
            )
        } else if bitcoin == 0 {
            format!(
                "{} lends against bitcoin alone, and this book holds none on NEAR, so {whole}.",
                t.name
            )
        } else if !t.open {
            format!(
                "{} isn't lending USDC against {} now, so {whole}.",
                t.name, t.collateral
            )
        } else if lends == 0 && t.free < lender::MIN_LENDER_MICRO {
            format!("{} has no USDC free to lend now, so {whole}.", t.name)
        } else if lends == 0 {
            format!(
                "{} would lend under $1 against this bitcoin, too little to be worth a step, so {whole}.",
                t.name
            )
        } else {
            let all_free = if lends < uncut {
                ", all the USDC it has free"
            } else {
                ""
            };
            let rest = if pool > 0 {
                format!(
                    "Our pool lends the other {} at {}.",
                    usd(pool),
                    percent(pool_rate_bp)
                )
            } else {
                "That is the whole line.".to_string()
            };
            let saved = format!(
                "{}'s lower rate saves {} over {loan_days} days",
                t.name,
                usd(saves)
            );
            let decision = if !cheaper {
                format!(
                    "{} costs {} our pool, so it isn't used: {whole}.",
                    t.name,
                    if u64::from(t.rate_bp) > pool_rate_bp {
                        "more than"
                    } else {
                        "the same as"
                    }
                )
            } else if !t.moves {
                format!(
                    "The bitcoin is already on {}, and {saved}, so it is used.",
                    t.chain
                )
            } else {
                match &move_cost {
                    None => format!(
                        "That bitcoin would have to move to {}, and 1Click gave no quote for it ({}), so {} \
                         isn't used: {whole}.",
                        t.chain,
                        reads
                            .move_quote
                            .as_ref()
                            .map_or("not asked".to_string(), cr::quote_error),
                        t.name
                    ),
                    Some(mv) => {
                        // "to Ethereum costs $560", or both ways: "to Ethereum and back costs $690 ($560 there,
                        // $130 back)".
                        let costs = match (mv.total, mv.back, mv.back_quoted) {
                            (Some(total), Some(back), Some(true)) => format!(
                                "to {} and back costs {} ({} there, {} back)",
                                t.chain,
                                usd(total),
                                usd(mv.cost),
                                usd(back)
                            ),
                            (Some(total), _, _) => format!(
                                "to {} and back costs {} ({} there, and the same again for the way back, which \
                                 1Click didn't quote: {})",
                                t.chain,
                                usd(total),
                                usd(mv.cost),
                                reads.move_back.as_ref().map_or("not asked".to_string(), cr::quote_error)
                            ),
                            _ => format!("to {} costs {}", t.chain, usd(mv.cost)),
                        };
                        if used {
                            format!("Moving that bitcoin {costs}, and {saved}, so it is used.")
                        } else {
                            format!(
                                "Moving that bitcoin {costs}, and {saved}, which doesn't cover it, so {} isn't \
                                 used: {whole}.",
                                t.name
                            )
                        }
                    }
                }
            };
            format!(
                "{} looks at the bitcoin alone, not the hedge: against {} of it, it lends {} at {} a year{all_free}, \
                 and sells if bitcoin falls {:.1}%. {rest} {decision}",
                t.name,
                usd(posted),
                usd(lends),
                percent(u64::from(t.rate_bp)),
                f64::from(fall_bp) / 100.0
            )
        };
        lenders.push(FundingLender {
            l: t.l.to_string(),
            chain: t.chain.to_string(),
            collateral: t.collateral.to_string(),
            rate_bp: t.rate_bp,
            supply_bp: t.supply_bp,
            liq_bp: t.liq_bp,
            ltv_bp: t.ltv_bp,
            penalty_bp: t.penalty_bp,
            free: t.free,
            lends,
            pool,
            fall_bp,
            blended_bp: blended_bp(lends, t.rate_bp, pool, pool_rate_bp),
            move_cost,
            used,
            why,
        });
    }
    Some(Funding {
        line,
        pool_rate_bp,
        target_hf_bp: target,
        loan_days,
        lenders,
        choice: choice.map_or("pool", |(l, _)| l).to_string(),
    })
}

pub fn compute(ci: &CreditInputs) -> Result<CreditResult, String> {
    if let Some(reason) = &ci.fatal {
        return Err(reason.clone());
    }
    let req = &ci.request;
    let u = cr::universe();
    let pool = near::pool(ci.pool.views.get("get_pool").unwrap_or(&Value::Null))?;
    let params = ci
        .pool
        .views
        .get("get_params")
        .cloned()
        .unwrap_or(Value::Null);
    let upgrade_ns = near::upgrade_ns(&params);
    let now_ns: u64 = ci
        .pool
        .block
        .timestamp_ns
        .parse()
        .map_err(|_| "the inputs have no testnet block time")?;
    let side = hl_side(ci, &u)?;
    let mut holdings = OrderedMap::new();
    for s in &req.spot {
        let t = cr::token(&s.token).ok_or("an unknown spot token")?;
        let raw: u128 = s
            .amount
            .parse()
            .map_err(|_| "a spot amount is not a number")?;
        if raw > 0 {
            holdings.insert(t.engine, raw as f64 / pow10(t.decimals));
        }
    }
    let mut a = Account {
        near: holdings,
        hl_cash: side.cash,
        perps: side.perps.clone(),
        entry: side.entry.clone(),
        debt: 0.0,
        tier: ClientTier::Standard,
        inflight: Vec::new(),
        orders: side.orders.clone(),
    };
    let groups = cr::coins_to_price(ci, &u)?;
    let mut eng = Engine::v0();
    let (m, uncertain, reduce_only, pis) = build_market(&mut eng, ci, &a, &groups, &pool)?;
    eng.check_snapshot(&a, &m)?;
    let no_new_risk = !uncertain.is_empty();
    let main = evaluate(&eng, &mut a, &m, now_ns, upgrade_ns, no_new_risk);

    // Coins outside the allow-list: no line until they are closed, and what closing them would bring.
    let unlisted: Vec<String> = side.unlisted.iter().cloned().collect();
    let without_unlisted = if unlisted.is_empty() {
        None
    } else {
        // With no open PnL in them (a what-if book), leaving them out changes nothing the engine sees.
        let other;
        let w = if side.cash_without == side.cash {
            &main
        } else {
            let mut b = Account {
                hl_cash: side.cash_without,
                ..a.clone()
            };
            other = evaluate(&eng, &mut b, &m, now_ns, upgrade_ns, no_new_risk);
            &other
        };
        Some(WithoutUnlisted {
            line: micro_exact(w.w).max(0) as u128,
            binding: w.binding.clone(),
            score: w.score,
            tier: w.tier.as_str().to_string(),
            rate_bp: rate_bp(&eng, m.util, w.tier),
        })
    };
    let (line, binding) = if unlisted.is_empty() {
        (micro_exact(main.w).max(0) as u128, main.binding.clone())
    } else {
        (0, "UNLISTED".to_string())
    };
    let rq = &main.rq;
    let topup = bands::topup(&eng, &a, &m, rq);
    let volf = groups
        .iter()
        .map(|g| eng.vol_factor(&m, g))
        .fold(1.0, f64::max);
    let top: Vec<String> = eng
        .top_risks(rq, 3)
        .into_iter()
        .filter(|(_, loss)| *loss > 0.0)
        .map(|(name, _)| name)
        .collect();
    let caps = params.get("caps").unwrap_or(&Value::Null);
    let limits = Limits {
        first_week: caps.get("new_account_limit").and_then(u128_of).unwrap_or(0),
        ceiling: caps
            .pointer(&format!(
                "/ceiling/{}",
                main.tier.as_str().to_ascii_lowercase()
            ))
            .and_then(u128_of)
            .unwrap_or(0),
    };
    let mut ignored = side.ignored.clone();
    if ignored.len() > MAX_IGNORED {
        let more = ignored.len() - (MAX_IGNORED - 1);
        ignored.truncate(MAX_IGNORED - 1);
        ignored.push(Ignored {
            what: format!("{more} more"),
            why: "left out as the lines above".into(),
        });
    }
    let unlisted_more = unlisted.len().saturating_sub(MAX_UNLISTED) as u64;
    let rate_at_60 = rate_bp(&eng, REFERENCE_UTIL, main.tier);
    let funding = funding(ci, &a, &m, line, rate_at_60, &params);
    let result = CreditResult {
        ok: true,
        v: CREDIT_V,
        mode: "credit_check".into(),
        model: MODEL.to_string(),
        params: params_hash(),
        network: req.network.clone(),
        hl_address: req.hl_address.clone(),
        book: req.book.clone(),
        spot: req.spot.clone(),
        at_ms: ci.now_ms,
        near_blk: ci.pool.block.height,
        verdict: CreditVerdict {
            eq: micro_down(rq.e),
            eq_allow: micro_down(main.e_allow),
            mm: micro_up(rq.mr),
            im: micro_up(rq.im),
            score: main.score,
            tier: main.tier.as_str().to_string(),
            rate_bp: rate_bp(&eng, m.util, main.tier),
            rate_bp_at_60: rate_at_60,
            credit: Credit { line, binding },
            top,
            topup: micro_up(topup),
            venues: Venues {
                hl_margin_ratio_bp: bp(eng.hl_ratio(&a, &m, None)),
            },
            coins: Coins {
                uncertain: uncertain.into_iter().collect(),
                stale: Vec::new(),
                reduce_only: reduce_only.into_iter().collect(),
            },
            hr_bp: main.hr_bp,
            hr7_bp: main.hr7.round() as u64,
            exp_bp: main.exp_bp,
            volf_bp: bp(volf),
        },
        limits,
        unlisted: unlisted.into_iter().take(MAX_UNLISTED).collect(),
        unlisted_more,
        without_unlisted,
        ignored,
        prices: m
            .px
            .iter()
            .map(|(g, p)| (g.clone(), micro_exact(*p)))
            .collect(),
        pi: pis,
        rhea: rhea_terms(ci, &a, &m),
        pool: PoolTerms {
            id: pb_read::request::TESTNET.pool.to_string(),
            util_bp: bp(m.util),
        },
        funding,
        inputs: ci.hash(),
    };
    Ok(result)
}

/// What pb-risk prints for these inputs: the result, or a refusal.
pub fn output(ci: &CreditInputs) -> String {
    match compute(ci) {
        Ok(r) => serde_json::to_string(&r).expect("a result serialises"),
        Err(reason) => refusal(&reason),
    }
}

/// The snapshot form: `{"result": ..., "inputs": ...}`.
pub fn snapshot(ci: &CreditInputs) -> String {
    format!(r#"{{"result":{},"inputs":{}}}"#, output(ci), ci.canonical())
}

/// One run of the `credit_check` mode.
pub fn run(raw: &str, net: &mut impl Net) -> String {
    let (req, snap) = match cr::parse(raw) {
        Ok(p) => p,
        Err(reason) => return refusal(&reason),
    };
    let ci = cr::read(net, &req);
    if snap {
        snapshot(&ci)
    } else {
        output(&ci)
    }
}
