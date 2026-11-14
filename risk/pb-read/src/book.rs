//! The book the engine runs on, built from one run's inputs: the engine's `Account` (the NEAR side, the Hyperliquid
//! side and the loan), its `Market` (prices, marks and live margin tiers), and the client's rating and tier.
//!
//! pb-risk builds its verdict on this, and pb-gateway runs its pre-trade checks on it, so both see the book the same
//! way (INTERFACES.md 9). The code is pb-risk's, moved here unchanged, so pb-risk's verdicts keep their bytes. Phase 4
//! adds the money in transit: the account's pending 1Click transfers, and which of them Hyperliquid shows arrived.
//! Phase 6 adds the outside lenders (FUNDING.md 6.2; `lenders`' header says how they count): the whole debt, the
//! collateral posted there, what sits at the account's Ethereum address, and WBTC as a sixth token. An account
//! whose config names no lender gets the book it got before.
use crate::hl;
use crate::inputs::{HlReads, Inputs};
use crate::lenders::{self, LenderBook, ReadPos};
use crate::market;
use crate::near::{self, pool_name, Transfer, TransferKind};
use crate::util::{bp, pow10, u128_of};
use risk_core::params::find_token;
use risk_core::rating::{self, ScoreInputs};
use risk_core::{Account, ClientTier, Engine, InFlight, Market, OrderedMap};
use std::collections::{BTreeMap, BTreeSet};

/// π when a wrapped token has no reading (3.3: the extreme depeg, and the token is reduce-only).
pub const PI_NO_READING: f64 = risk_core::prices::PI_NO_READING;

/// The coins the account holds: each nonzero perp, and the coin each nonzero NEAR token wraps. The readers use
/// it to decide which prices to fetch.
pub fn held_coins(inp: &Inputs) -> Result<BTreeSet<String>, String> {
    let conf = near::config(&inp.near.config)?;
    let mut out = BTreeSet::new();
    for t in &conf.tokens {
        if near::balance(inp.near.balances.get(&t.id))? > 0 {
            if let Some(g) = find_token(t.engine).and_then(|tok| tok.group) {
                out.insert(g.to_string());
            }
        }
    }
    // Phase 6: a coin held only at a lender is priced too. Rhea's position is read before the prices, so its posted
    // tokens are known here. Aave is read last: until it is, the coins its collateral wraps are all priced; once it
    // is, a coin counts as held only if its token is posted there or sits at the account's Ethereum address. So a
    // config that lists wrapped ether doesn't tie an account that holds none to ether's price.
    if let (Some(rhea), Some(reads)) = (&conf.lenders.rhea, &inp.lenders.rhea) {
        let posted = reads.account.get("collateral").and_then(serde_json::Value::as_array);
        for e in posted.map_or(&[][..], Vec::as_slice) {
            let id = e.get("token_id").and_then(serde_json::Value::as_str).unwrap_or("");
            let held = e.get("balance").and_then(u128_of).is_some_and(|b| b > 0);
            let token = conf
                .tokens
                .iter()
                .find(|t| t.id == id && held && rhea.collateral.iter().any(|c| c == id));
            if let Some(g) = token.and_then(|t| find_token(t.engine)).and_then(|tok| tok.group) {
                out.insert(g.to_string());
            }
        }
    }
    if let Some(aave) = &conf.lenders.aave {
        for t in &aave.collateral {
            let held = match &inp.lenders.aave {
                None => true,
                Some(reads) => reads.address.is_some() && {
                    let units = |key: String, posted: bool| match reads.calls.get(&key) {
                        Some(hex) if posted => crate::evm::user_reserve(hex).map(|r| r.posted).ok(),
                        Some(hex) => crate::evm::single(hex, "balanceOf").ok(),
                        None => None,
                    };
                    // An answer that doesn't read counts as held: the book refuses it by name.
                    units(format!("posted:{}", t.address), true) != Some(0)
                        || units(format!("balance:{}", t.address), false) != Some(0)
                },
            };
            if let Some(g) = find_token(t.engine).and_then(|tok| tok.group).filter(|_| held) {
                out.insert(g.to_string());
            }
        }
    }
    let hla = hl::account_of(&inp.hl)?;
    for (c, &q) in hla.perps.iter() {
        if q != 0.0 {
            out.insert(c.to_string());
        }
    }
    // A token in transit is valued like the token held, so its coin is priced too: a NEAR token by its id, and
    // a collateral token coming home from Aave's chain by its address there.
    if let Ok(client) = near::state(&inp.near.state) {
        for t in &client.transfers {
            let near_token = conf.tokens.iter().find(|c| c.id == t.token).map(|c| c.engine);
            let evm_token = conf
                .lenders
                .aave
                .iter()
                .flat_map(|a| a.collateral.iter())
                .find(|c| t.kind == TransferKind::EHome && c.address.eq_ignore_ascii_case(&t.token))
                .map(|c| c.engine);
            if let Some(g) = near_token.or(evm_token).and_then(find_token).and_then(|tok| tok.group) {
                out.insert(g.to_string());
            }
        }
    }
    Ok(out)
}

/// A credit on Hyperliquid matches a pending `to_hl` transfer if it is at least this share of the USDC sent: 1Click
/// keeps its fee and slippage (the stand-in delivered 429.60 of 430 on 8 Nov, and 24.68 of 25 in a dry quote).
pub const ARRIVAL_MIN_SHARE: f64 = 0.95;
/// How far before a transfer's deadline its credit may be: the deadline is the quote's expiry plus 30 minutes, and a
/// quote may live up to a day.
pub const ARRIVAL_LOOKBACK_MS: u64 = 24 * 3_600_000 + 30 * 60_000;

/// The ledger read's start for the pending `to_hl` transfers (unix ms), or None when there are none.
pub fn ledger_start_ms(transfers: &[Transfer]) -> Option<u64> {
    transfers
        .iter()
        .filter(|t| t.kind == TransferKind::ToHl)
        .map(|t| (t.deadline_ns / 1_000_000).saturating_sub(ARRIVAL_LOOKBACK_MS))
        .min()
}

/// A `to_evm` transfer has arrived when the account's address on Aave's chain holds at least this share of the
/// dollar value sent (INTERFACES.md 36). It is lower than Hyperliquid's: on testnet the bitcoin may arrive as
/// wrapped ether, and the stand-in doesn't quote at the engine's prices.
pub const EVM_ARRIVAL_MIN_SHARE: f64 = 0.8;

/// Whether a pending transfer is the owner's own move (`move:<n>`), not a plan step's (`<pid>:<i>`).
///
/// The account records a move as the owner states it: the amount, the receiver and the expiry are theirs, and the
/// contract can't see whether the money ever left (research/audit.md, A7). So a move counts nothing while it is
/// pending ([`transit`]). A plan step's transfer is one the engine planned, with a quote it made.
pub fn owners_move(id: &str) -> bool {
    id.starts_with("move:")
}

/// Money in transit, from the account's pending transfers (INTERFACES.md 14, 36 and 40.3).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Transit {
    /// For the engine: each plan step's transfer still in transit, as the token sent. It counts at 98% for the
    /// state and 0 for credit (RISK_ENGINE.md 3.4), and nothing once overdue. A `to_hl` transfer is marked as
    /// going to Hyperliquid, so a REBALANCE doesn't ask for it again. The owner's own moves ([`owners_move`]) are
    /// not in it: they count nothing toward the state, toward credit, or as margin on its way.
    pub inflight: Vec<InFlight>,
    /// The transfer each entry of `inflight` stands for, in the same order.
    pub ids: Vec<String>,
    /// Pending `to_hl` transfers that Hyperliquid's ledger shows delivered: the verdict's `arrived`. They are on
    /// Hyperliquid already, so they don't count in transit too.
    pub arrived: Vec<String>,
    /// Transfers past their deadline.
    pub overdue: Vec<Transfer>,
}

/// What one pending transfer sends, as the engine's token and whole units of it:
/// - a `sell`, `to_hl` or `to_evm`: the account's own NEAR token, by its id;
/// - a `home`: Hyperliquid's USDC;
/// - an `e_home`: `USDC` for Aave's USDC, or a collateral token of the account's Aave settings by its address
///   there (WBTC counts as bitcoin, wrapped ether as ether).
///
/// A token the account isn't configured for is refused: the account only sends its own tokens.
fn sent_by(t: &Transfer, conf: &near::Config) -> Result<(&'static str, f64), String> {
    if t.kind == TransferKind::EHome {
        let unlisted = || {
            format!(
                "pending transfer {} is of {}, a token the account's Aave settings don't list",
                t.id, t.token
            )
        };
        let aave = conf.lenders.aave.as_ref().ok_or_else(unlisted)?;
        if t.token == "USDC" || aave.usdc.address.eq_ignore_ascii_case(&t.token) {
            return Ok(("USDC", t.amount as f64 / pow10(aave.usdc.decimals)));
        }
        let c = aave
            .collateral
            .iter()
            .find(|c| c.address.eq_ignore_ascii_case(&t.token))
            .ok_or_else(unlisted)?;
        return Ok((c.engine, t.amount as f64 / pow10(c.decimals)));
    }
    if t.token == "USDC" {
        return Ok(("USDC", t.amount as f64 / 1e6));
    }
    let c = conf.tokens.iter().find(|c| c.id == t.token).ok_or_else(|| {
        format!(
            "pending transfer {} is of {}, a token the account isn't configured for",
            t.id, t.token
        )
    })?;
    Ok((c.engine, t.amount as f64 / pow10(c.decimals)))
}

/// The pending `to_evm` transfers that have arrived at the account's address on Aave's chain (INTERFACES.md 36).
/// The account can't see that chain, so the verdict's `arrived` says so.
///
/// One has arrived when the address holds at least [`EVM_ARRIVAL_MIN_SHARE`] of the dollar value sent, at the
/// engine's prices (`price` gives one whole engine token's reference price, with no depeg ratio):
/// - **a collateral transfer** (any token but USDC) counts the Aave settings' collateral tokens, in the wallet and
///   posted at Aave, whichever of them came: on testnet bitcoin may arrive as wrapped ether;
/// - **a USDC transfer** counts the USDC in the wallet.
///
/// Each dollar at the address answers for one transfer, earliest deadline first: a transfer takes its whole value
/// off what is left, arrived or not. `aave` is the position as read; with none (the config names no Aave, or the
/// account has no address) nothing has arrived.
///
/// A wrong "arrived" is safe: the transfer stops counting in transit and the tokens count only where they are.
pub fn to_evm_arrivals(
    client: &near::ClientState,
    conf: &near::Config,
    aave: Option<&crate::lenders::LenderPos>,
    price: &dyn Fn(&str) -> f64,
) -> Vec<String> {
    let Some(pos) = aave else {
        return Vec::new();
    };
    let at_address = pos.posted.iter().chain(pos.spare.iter()).chain(pos.stuck.iter());
    let mut collateral: f64 = at_address
        .map(|h| h.raw as f64 / pow10(h.decimals) * price(&h.engine))
        .sum();
    let mut usdc = pos.cash_micro as f64 / 1e6;
    let mut moves: Vec<&Transfer> = client
        .transfers
        .iter()
        .filter(|t| t.kind == TransferKind::ToEvm)
        .collect();
    moves.sort_by(|x, y| x.deadline_ns.cmp(&y.deadline_ns).then(x.id.cmp(&y.id)));
    let mut arrived = Vec::new();
    for t in moves {
        let Ok((token, units)) = sent_by(t, conf) else {
            continue;
        };
        let sent = units * price(token);
        let there = if token == "USDC" { &mut usdc } else { &mut collateral };
        if sent > 0.0 && *there + 1e-9 >= EVM_ARRIVAL_MIN_SHARE * sent {
            arrived.push(t.id.clone());
        }
        *there = (*there - sent).max(0.0);
    }
    arrived
}

/// What is in transit. A `to_hl` transfer has arrived when the ledger shows a USDC credit to the account's
/// Hyperliquid address of at least [`ARRIVAL_MIN_SHARE`] of what was sent and no more, within
/// [`ARRIVAL_LOOKBACK_MS`] before its deadline. Each credit matches one transfer, earliest deadline first. A
/// `to_evm` transfer's arrival needs the lender reads and the prices, so [`build_with`] takes those out afterwards
/// ([`to_evm_arrivals`]). An `e_home` transfer needs none: its delivery on NEAR settles it at the account.
///
/// The owner's own moves ([`owners_move`]) are matched for arrival, checked for their token and listed as overdue
/// like any transfer, but they are not put in flight.
pub fn transit(
    client: &near::ClientState,
    conf: &near::Config,
    hl_reads: &HlReads,
    now_ns: u64,
) -> Result<Transit, String> {
    let credits = client
        .hl_address
        .as_deref()
        .map_or_else(Vec::new, |a| hl::credits(&hl_reads.ledger, a));
    let mut used = vec![false; credits.len()];
    let mut out = Transit::default();
    let mut to_hl: Vec<&Transfer> = client
        .transfers
        .iter()
        .filter(|t| t.kind == TransferKind::ToHl)
        .collect();
    to_hl.sort_by(|x, y| x.deadline_ns.cmp(&y.deadline_ns).then(x.id.cmp(&y.id)));
    let units = |t: &Transfer| sent_by(t, conf);
    for t in to_hl {
        let (_, sent) = units(t)?;
        let from = (t.deadline_ns / 1_000_000).saturating_sub(ARRIVAL_LOOKBACK_MS);
        let hit = (0..credits.len()).find(|&j| {
            let (at, usdc) = credits[j];
            !used[j] && at >= from && usdc <= sent + 1e-6 && usdc >= ARRIVAL_MIN_SHARE * sent
        });
        if let Some(j) = hit {
            used[j] = true;
            out.arrived.push(t.id.clone());
        }
    }
    for t in &client.transfers {
        if out.arrived.contains(&t.id) {
            continue;
        }
        let (token, amount) = units(t)?;
        let overdue = now_ns > t.deadline_ns;
        if overdue {
            out.overdue.push(t.clone());
        }
        // INTERFACES.md 40.3: the owner's own move counts nothing while it is pending.
        if owners_move(&t.id) {
            continue;
        }
        out.inflight.push(InFlight {
            token: token.to_string(),
            units: amount,
            overdue,
            // A REBALANCE counts what is already on its way to Hyperliquid; sales and moves home land on NEAR,
            // and a move to Aave's chain lands at the account's address there.
            to_hl: t.kind == TransferKind::ToHl,
        });
        out.ids.push(t.id.clone());
    }
    Ok(out)
}

/// Whether `coin` is on version 0's allow-list (RISK_ENGINE.md 5), from the compiled-in parameter file. Cheaper
/// than building the engine, for a check before any read.
pub fn on_allow_list(coin: &str) -> bool {
    let u: serde_json::Value =
        serde_json::from_str(risk_core::universe::UNIVERSE_V0).unwrap_or_default();
    u.get("coins")
        .and_then(|c| c.get(coin))
        .and_then(|c| c.get("allowed"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

/// The coins whose prices a run reads: those held, plus BTC for the market-wide volatility term (4.4).
pub fn coins_to_read(held: &BTreeSet<String>) -> BTreeSet<String> {
    let mut out = held.clone();
    if !out.is_empty() {
        out.insert("BTC".to_string());
    }
    out
}

/// The market the engine runs on, and what the readings said about each coin and token.
pub struct Built {
    pub market: Market,
    /// Coins with no new risk: too few or disagreeing sources, or no TWAP or volatility.
    pub uncertain: BTreeSet<String>,
    /// Coins the pool (or Hyperliquid testnet) has made reduce-only or removed, and held tokens that are frozen
    /// or have no π reading.
    pub reduce_only: BTreeSet<String>,
}

/// The market for the coins in `groups`. Coin parameters the readings set (live margin tiers, maximum leverage) are
/// written into `eng`.
pub fn build_market(
    eng: &mut Engine,
    inp: &Inputs,
    a: &Account,
    groups: &BTreeSet<String>,
    pool: &near::PoolState,
    borrower: Option<&near::Borrower>,
    statuses: &BTreeMap<String, String>,
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
    let no_reads = Default::default();
    // 4.4's market-wide term: BTC's volatility against its own reference.
    let btc_ratio = market::sigma(inp.coins.get("BTC").unwrap_or(&no_reads), inp.now_ms)
        .map(|s| s / eng.coin("BTC").params.vol_ref);
    for g in groups {
        let coin = eng
            .find_coin(g)
            .ok_or_else(|| format!("{g} is not in the universe"))?
            .clone();
        let asset = inp.hl.assets.get(g).map(hl::asset).transpose()?;
        // Version 0 trades cross margin only, and on testnet a coin Hyperliquid doesn't list (or has delisted)
        // counts as removed (research/day1.md, check 12).
        let off_hl = inp.hl.meta_read && asset.as_ref().is_none_or(|x| x.unusable);
        let oracle = asset
            .as_ref()
            .filter(|_| !off_hl)
            .and_then(|x| x.oracle)
            .map(|p| (p, inp.hl.at_ms));
        let reads = inp.coins.get(g).unwrap_or(&no_reads);
        let cp = market::coin_price(reads, coin.tier, coin.unit_mult, oracle, inp.now_ms);
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
            // 3.1: margin tables are read live; they differ between networks.
            if let Some(c) = eng.coins.iter_mut().find(|c| &c.name == g) {
                c.margin_tiers = x.tiers.clone();
                c.hl_max_leverage = x.max_leverage;
            }
        }
        let status = statuses.get(g).map(String::as_str);
        if off_hl || matches!(status, Some("reduce_only" | "removed")) {
            reduce_only.insert(g.clone());
        }
        // A perp needs Hyperliquid's mark; without one the account can't be valued.
        if a.perps.get_or(g, 0.0) != 0.0 && !m.mark.contains_key(g) {
            return Err(format!(
                "no Hyperliquid mark price for {g}, where the account has a position"
            ));
        }
    }
    // 3.3: wrapped tokens and USDT. On testnet nBTC's π is the drill ratio, used at once for both the state and new
    // credit; the other wrappers have no testnet market, so they count as unread: π = 0.80 and reduce-only.
    // A token on Aave's chain (FUNDING.md 6.2; INTERFACES.md 33): WBTC, and wrapped ether, which is the engine's
    // ETH token. On testnet its π is Aave's oracle price for it over the engine's price of its coin, at most 1.
    // Without that reading it counts as unread, like the others.
    let drill = near::drill_bp(&inp.near.drill);
    let on_aave = |t: &str| {
        let px = find_token(t).and_then(|tok| tok.group).and_then(|g| m.px.get(g).copied());
        aave_oracle_usd(inp, t)
            .zip(px)
            .filter(|(oracle, px)| *oracle > 0.0 && *px > 0.0)
            .map(|(oracle, px)| (oracle / px).min(1.0))
    };
    for (t, &u) in a.near.iter() {
        if u == 0.0 || !matches!(t, "nBTC" | "ETH.b" | "USDT" | "WBTC") {
            continue;
        }
        let pi = match (t, drill, on_aave(t)) {
            ("nBTC", Some(b), _) => (b as f64 / 1e4).min(1.0),
            ("WBTC" | "ETH.b", _, Some(ratio)) => ratio,
            _ => {
                reduce_only.insert(pool_name(t).to_string());
                PI_NO_READING
            }
        };
        m.wrap.insert(t.to_string(), pi);
    }
    for (name, status) in statuses {
        if status == "frozen" {
            if let Some(t) = near::engine_name(name) {
                m.frozen.insert(t.to_string());
                if a.near.get_or(t, 0.0) != 0.0 {
                    reduce_only.insert(name.clone());
                }
            }
        }
    }
    // 4.2: what the rest of the book holds on the NEAR side, from the pool's totals less this account's own.
    for (name, &amount) in &pool.book {
        if let Some(t) = near::engine_name(name) {
            let own = borrower
                .and_then(|b| b.hold.get(name))
                .copied()
                .unwrap_or(0);
            m.book
                .insert(t.to_string(), amount.saturating_sub(own) as f64 / 1e6);
        }
    }
    Ok(Built {
        market: m,
        uncertain,
        reduce_only,
    })
}

/// Aave's oracle price, in dollars, for the Aave collateral token the engine calls `engine`, if it was read.
pub fn aave_oracle_usd(inp: &Inputs, engine: &str) -> Option<f64> {
    let reads = inp.lenders.aave.as_ref()?;
    let conf = near::config(&inp.near.config).ok()?;
    let token = conf.lenders.aave?.collateral.into_iter().find(|t| t.engine == engine)?;
    let hex = reads.calls.get(&format!("price:{}", token.address))?;
    let base = crate::evm::single(hex, "getAssetPrice").ok()?;
    Some(base as f64 / pow10(crate::evm::BASE_DECIMALS))
}

/// Σ_g Σ |legs of g| in USDC: the gross exposure the rating's exposure share uses (as `hedge_ratio` counts it).
pub fn gross_exposure(eng: &Engine, a: &Account, m: &Market) -> f64 {
    let mut gross = 0.0;
    for g in eng.groups(a) {
        for (t, &u) in a.near.iter() {
            if find_token(t).and_then(|x| x.group) == Some(g.as_str()) {
                gross += (u * m.wrap_ratio(t) * m.price(&g)).abs();
            }
        }
        let q = a.perps.get_or(&g, 0.0);
        if q != 0.0 {
            gross += (q * m.mark_price(&g)).abs();
        }
    }
    gross
}

/// The book one run's inputs describe, with the client's rating and the tier the pool would grant.
pub struct Book {
    /// The final block's time (ns): "now" for the margin-call clock and the tier rule.
    pub now_ns: u64,
    pub client: near::ClientState,
    pub conf: near::Config,
    pub pool: near::PoolState,
    pub borrower: Option<near::Borrower>,
    pub statuses: BTreeMap<String, String>,
    /// `ft_balance_of` per configured token id, in token units.
    pub raw_balance: BTreeMap<String, u128>,
    /// The pool's debt for the account, with interest (micro-USDC). With lenders, `account.debt` is the whole debt.
    pub debt_micro: u128,
    /// What the account has at the outside lenders (FUNDING.md 6.2); empty when its config names none.
    pub lenders: crate::lenders::LenderBook,
    /// The engine, with the live margin tiers of the coins read.
    pub engine: Engine,
    /// The engine's account, its tier set.
    pub account: Account,
    /// The coins held, plus any the caller asked to price.
    pub groups: BTreeSet<String>,
    pub built: Built,
    /// The rating's inputs and result (RISK_ENGINE.md 6).
    pub hr_bp: u64,
    pub exp_bp: u64,
    pub hr7: f64,
    pub score: i64,
    pub tier: ClientTier,
    /// Pending transfers: those Hyperliquid shows delivered, and those overdue. The rest are in `account.inflight`.
    pub arrived: Vec<String>,
    pub overdue: Vec<Transfer>,
}

/// The book, priced for the coins it holds.
pub fn build(inp: &Inputs) -> Result<Book, String> {
    build_with(inp, &BTreeSet::new())
}

/// The book, priced for the coins it holds and for `extra` (an order's coin the account doesn't hold yet).
pub fn build_with(inp: &Inputs, extra: &BTreeSet<String>) -> Result<Book, String> {
    if let Some(reason) = &inp.fatal {
        return Err(reason.clone());
    }
    let net = inp.request.net();
    let now_ns: u64 = inp
        .block
        .timestamp_ns
        .parse()
        .map_err(|_| "the inputs have no block time")?;
    let client = near::state(&inp.near.state)?;
    let conf = near::config(&inp.near.config)?;
    if conf.pool_id != net.pool {
        return Err(format!(
            "the account's pool is {}, but this program serves {}",
            conf.pool_id, net.pool
        ));
    }
    let pool = near::pool(&inp.near.pool)?;
    let borrower = near::borrower(&inp.near.borrower)?;
    let statuses = near::statuses(&inp.near.coin_statuses)?;
    let upgrade_ns = near::upgrade_ns(&inp.near.params);

    // The NEAR side, in the config's token order (sums follow insertion order, as in the reference).
    let mut holdings = OrderedMap::new();
    let mut raw_balance: BTreeMap<String, u128> = BTreeMap::new();
    for t in &conf.tokens {
        let raw = near::balance(inp.near.balances.get(&t.id))?;
        raw_balance.insert(t.id.clone(), raw);
        if raw > 0 {
            holdings.insert(t.engine, raw as f64 / pow10(t.decimals));
        }
    }
    if client.hl_address.is_some() && inp.hl.state.is_null() {
        return Err("the account's Hyperliquid account wasn't read".into());
    }
    let hla = hl::account_of(&inp.hl)?;
    let debt_micro = borrower.as_ref().map_or(0, |b| b.debt);
    let mut transit = transit(&client, &conf, &inp.hl, now_ns)?;

    // Phase 6 (FUNDING.md 6.2; `lenders`' header): each lender in the config, `aave` before `rhea`. A lender that
    // wasn't read, or whose answer doesn't parse, stops the run: no verdict, never a guess.
    let mut read_pos: Vec<ReadPos> = Vec::new();
    let mut evm_nonce = None;
    if let Some(aave) = &conf.lenders.aave {
        let reads = inp
            .lenders
            .aave
            .as_ref()
            .ok_or("the account's config names Aave, but Aave wasn't read")?;
        let (pos, nonce) = lenders::aave_position(reads, aave, &client, inp.block.height)?;
        evm_nonce = nonce;
        read_pos.push(pos);
    }
    if let Some(rhea) = &conf.lenders.rhea {
        let reads = inp
            .lenders
            .rhea
            .as_ref()
            .ok_or("the account's config names Rhea, but Rhea wasn't read")?;
        read_pos.push(lenders::rhea_position(
            reads,
            rhea,
            &conf,
            &client,
            &raw_balance,
            inp.block.height,
        )?);
    }
    // What sits at a lender or at the Ethereum address counts in the book under its engine name, and is marked as
    // not on NEAR. Rhea's spare collateral is the NEAR balance itself, already counted. Collateral on its way back
    // from a lender is still the account's, so it stays in: either the lender shows it, or the balance does.
    let mut locked: BTreeMap<String, u128> = BTreeMap::new();
    let mut lender_owed = 0u128;
    for p in &read_pos {
        let on_evm = p.pos.lender == lenders::AAVE;
        // At the Ethereum address: what a step can post, and what Aave's pool has no room for now.
        let at_address = p.pos.spare.iter().chain(p.pos.stuck.iter()).filter(|_| on_evm);
        for h in p.pos.posted.iter().chain(at_address) {
            let held = holdings.get_or(&h.engine, 0.0);
            holdings.insert(&h.engine, held + h.raw as f64 / pow10(h.decimals));
            let l = locked.entry(h.engine.clone()).or_default();
            *l = l.saturating_add(h.raw);
        }
        if on_evm && p.pos.cash_micro > 0 {
            let held = holdings.get_or("USDC", 0.0);
            holdings.insert("USDC", held + p.pos.cash_micro as f64 / 1e6);
            let l = locked.entry("USDC".to_string()).or_default();
            *l = l.saturating_add(p.pos.cash_micro);
        }
        // A lender borrow under way counts as landed: its debt (below) and its USDC, which is on its way and so
        // not on NEAR. With the debt alone, equity would look lower than it is by the whole loan until it lands.
        if p.pos.pending_micro > 0 {
            let held = holdings.get_or("USDC", 0.0);
            holdings.insert("USDC", held + p.pos.pending_micro as f64 / 1e6);
            let l = locked.entry("USDC".to_string()).or_default();
            *l = l.saturating_add(p.pos.pending_micro);
        }
        lender_owed = lender_owed.saturating_add(p.pos.owed_micro());
    }
    let mut a = Account {
        near: holdings,
        hl_cash: hla.cash,
        perps: hla.perps,
        entry: hla.entry,
        // The whole debt: our pool's, each lender's, and lender borrows under way.
        debt: debt_micro.saturating_add(lender_owed) as f64 / 1e6,
        tier: ClientTier::Standard,
        inflight: transit.inflight.clone(),
        orders: hla.orders,
    };

    let mut eng = Engine::v0();
    let mut groups = held_coins(inp)?;
    groups.extend(extra.iter().cloned());
    let built = build_market(
        &mut eng,
        inp,
        &a,
        &groups,
        &pool,
        borrower.as_ref(),
        &statuses,
    )?;
    let m = &built.market;
    eng.check_snapshot(&a, m)?;

    // The lender positions, valued as each lender counts collateral: its own price where it publishes one, else
    // the engine's reference price, with no depeg ratio.
    let reference = |engine: &str| match find_token(engine).and_then(|t| t.group) {
        Some(g) => m.px.get(g).copied().unwrap_or(0.0),
        None => 1.0,
    };
    let lender_book = LenderBook {
        positions: read_pos.into_iter().map(|p| p.priced(&reference)).collect(),
        min_hf_bp: client.permission.as_ref().map(|p| p.min_hf_bp),
        max_rate_bp: client.permission.as_ref().map(|p| p.max_rate_bp),
        evm_nonce,
        funding: near::live_funding(&client, now_ns),
        locked,
    };

    // INTERFACES.md 36: a move to Aave's chain that the address shows arrived is no longer in transit, and the
    // verdict says so.
    let landed = to_evm_arrivals(&client, &conf, lender_book.get(lenders::AAVE), &reference);
    if !landed.is_empty() {
        let still = |id: &String| !landed.contains(id);
        a.inflight = transit
            .inflight
            .iter()
            .zip(&transit.ids)
            .filter(|(_, id)| still(id))
            .map(|(flight, _)| flight.clone())
            .collect();
        transit.overdue.retain(|t| still(&t.id));
        transit.arrived.extend(landed);
    }

    // The rating (6): hedge ratio and exposure share now and over the week, history from the pool.
    let hr_now = eng.hedge_ratio(&a, m);
    let e_mark = eng.equity_mark(&a, m);
    let gross = gross_exposure(&eng, &a, m);
    let exp_now = if e_mark > 0.0 {
        gross / e_mark
    } else if gross > 0.0 {
        f64::INFINITY
    } else {
        0.0
    };
    let (hr_bp, exp_bp) = (bp(hr_now), bp(exp_now));
    let (hr7, exp7) = near::week_averages(&client.hourly, near::hour_of(now_ns), hr_bp, exp_bp);
    let kyb = borrower.as_ref().is_some_and(|b| b.kyb);
    let defaulted = client.blocked || borrower.as_ref().is_some_and(|b| b.blocked);
    // Good months, forced unwinds and a linked Hyperliquid record aren't kept by the Phase 2 account: none count yet.
    let score = rating::score(&ScoreInputs {
        defaults: i64::from(defaulted),
        kyb,
        exposure_share: exp7 / 1e4,
        ..ScoreInputs::new(hr_now, hr7 / 1e4)
    });
    let tier = near::verdict_tier(
        rating::tier_of(score, kyb),
        borrower.as_ref(),
        now_ns,
        upgrade_ns,
    );
    a.tier = tier;
    Ok(Book {
        now_ns,
        client,
        conf,
        pool,
        borrower,
        statuses,
        raw_balance,
        debt_micro,
        lenders: lender_book,
        engine: eng,
        account: a,
        groups,
        built,
        hr_bp,
        exp_bp,
        hr7,
        score,
        tier,
        arrived: transit.arrived,
        overdue: transit.overdue,
    })
}
