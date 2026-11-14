//! The book stress test (INTERFACES.md 19, RISK_ENGINE.md 12.1 last row), from what `pb_read::stress` read: each
//! account with a loan is built as `check` builds it, then every account's scenarios run together in risk-core
//! (`Engine::book_stress`), with unwind costs at the book's total size per coin. A pure function of the inputs, like
//! the verdict.
use crate::verdict::refusal;
use pb_read::book;
use pb_read::near;
use pb_read::read::Net;
use pb_read::stress::{self as sr, BookInputs};
use pb_read::util::{micro_down, micro_up};
use risk_core::{Account, Market};
use serde::{Deserialize, Serialize};

pub const BOOK_V: u32 = 1;
/// 12.1: on the book's worst day the pool may lose at most 2.5% of its capital.
pub const LIMIT_BP: u128 = 250;
/// `top` lists this many days.
pub const TOP: usize = 5;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BookResult {
    pub ok: bool,
    pub v: u32,
    pub mode: String,
    pub blk: u64,
    /// The pool's capital and loans (micro-USD).
    pub capital: u128,
    pub loans: u128,
    pub accounts: Vec<BookAccount>,
    /// The day that costs the pool most, of every family; null when none costs it anything (no loans, or a book
    /// that comes through every day).
    pub worst: Option<Day>,
    /// 2.5% of the pool's capital.
    pub limit: u128,
    /// Whether the worst day's loss stays within `limit`.
    pub pass: bool,
    /// The five days that cost the pool most (those that cost it anything).
    pub top: Vec<Day>,
    /// How many days were played out.
    pub days: u64,
    #[serde(rename = "in")]
    pub inputs: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BookAccount {
    pub acct: String,
    /// What it owes the pool, with interest (micro-USD).
    pub debt: u128,
    /// Its mark equity now (micro-USD).
    pub eq: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Day {
    pub scenario: String,
    /// What the pool would be owed after every account sold everything (micro-USD, rounded up).
    pub pool_loss: u128,
}

pub fn compute(bi: &BookInputs) -> Result<BookResult, String> {
    if let Some(reason) = &bi.fatal {
        return Err(reason.clone());
    }
    let pool = near::pool(&bi.pool)?;
    let limit = pool.capital * LIMIT_BP / 10_000;
    let mut books = Vec::new();
    for i in 0..bi.accounts.len() {
        let b = book::build(&bi.inputs_for(i))
            .map_err(|e| format!("cannot value {}: {e}", bi.accounts[i].account))?;
        books.push(b);
    }
    let accounts: Vec<BookAccount> = books
        .iter()
        .zip(&bi.accounts)
        .map(|(b, ar)| BookAccount {
            acct: ar.account.clone(),
            debt: b.debt_micro,
            eq: micro_down(b.engine.equity_mark(&b.account, &b.built.market)),
        })
        .collect();
    let mut result = BookResult {
        ok: true,
        v: BOOK_V,
        mode: "book".into(),
        blk: bi.block.height,
        capital: pool.capital,
        loans: pool.loans,
        accounts,
        worst: None,
        limit,
        pass: true,
        top: Vec::new(),
        days: 0,
        inputs: bi.hash(),
    };
    if books.is_empty() {
        return Ok(result);
    }
    // One engine with the live margin tiers of every coin held, and each account's market without the pool's
    // "rest of the book" (here the whole book is in the run). The days are built on all the prices together.
    let mut eng = books[0].engine.clone();
    for b in &books {
        for g in &b.groups {
            if let (Some(src), Some(dst)) = (
                b.engine.find_coin(g),
                eng.coins.iter_mut().find(|c| &c.name == g),
            ) {
                dst.margin_tiers = src.margin_tiers.clone();
                dst.hl_max_leverage = src.hl_max_leverage;
            }
        }
    }
    let markets: Vec<Market> = books
        .iter()
        .map(|b| {
            let mut m = b.built.market.clone();
            m.book.clear();
            m
        })
        .collect();
    let mut whole = markets[0].clone();
    for m in &markets[1..] {
        for (g, &p) in &m.px {
            whole.px.entry(g.clone()).or_insert(p);
        }
        for (g, &p) in &m.mark {
            whole.mark.entry(g.clone()).or_insert(p);
        }
        for (g, &p) in &m.twap {
            whole.twap.entry(g.clone()).or_insert(p);
        }
        for (g, &f) in &m.volf {
            whole.volf.entry(g.clone()).or_insert(f);
        }
        for (g, &f) in &m.funding {
            whole.funding.entry(g.clone()).or_insert(f);
        }
        for (t, &pi) in &m.wrap {
            whole.wrap.entry(t.clone()).or_insert(pi);
        }
    }
    let pairs: Vec<(&Account, &Market)> = books
        .iter()
        .zip(&markets)
        .map(|(b, m)| (&b.account, m))
        .collect();
    let rows = eng.book_stress(&pairs, &whole);
    // Largest loss first; equal losses keep the list's order.
    let mut order: Vec<usize> = (0..rows.len()).collect();
    order.sort_by(|&x, &y| {
        rows[y]
            .pool_loss
            .total_cmp(&rows[x].pool_loss)
            .then(x.cmp(&y))
    });
    let day = |i: usize| Day {
        scenario: rows[i].name.clone(),
        pool_loss: micro_up(rows[i].pool_loss).max(0) as u128,
    };
    // No worst day when none costs the pool anything.
    result.worst = order
        .first()
        .filter(|&&i| rows[i].pool_loss > 0.0)
        .map(|&i| day(i));
    result.top = order
        .iter()
        .filter(|&&i| rows[i].pool_loss > 0.0)
        .take(TOP)
        .map(|&i| day(i))
        .collect();
    result.pass = result.worst.as_ref().is_none_or(|w| w.pool_loss <= limit);
    result.days = rows.len() as u64;
    Ok(result)
}

/// What pb-risk prints for these inputs: the result, or a refusal.
pub fn output(bi: &BookInputs) -> String {
    match compute(bi) {
        Ok(r) => serde_json::to_string(&r).expect("a result serialises"),
        Err(reason) => refusal(&reason),
    }
}

/// The snapshot form: `{"result": ..., "inputs": ...}`.
pub fn snapshot(bi: &BookInputs) -> String {
    format!(r#"{{"result":{},"inputs":{}}}"#, output(bi), bi.canonical())
}

/// One run of the `book` mode.
pub fn run(raw: &str, net: &mut impl Net) -> String {
    let (req, snap) = match sr::parse(raw) {
        Ok(p) => p,
        Err(reason) => return refusal(&reason),
    };
    let bi = sr::read(net, &req);
    if snap {
        snapshot(&bi)
    } else {
        output(&bi)
    }
}
