//! The 27 property checks of `tests()` in `research/scripts/risk_engine_examples.py`, ported one for one, on
//! the same books: the 24 of RISK_ENGINE.md 14.2 (T13 and T16 in their stronger form, which test the engine
//! itself) and T18–T20, for the hedged-pair step, the allowance π and money in transit.
use risk_core::pretrade::worst_fill;
use risk_core::*;

fn map(pairs: &[(&str, f64)]) -> OrderedMap<f64> {
    pairs.iter().map(|&(k, v)| (k, v)).collect()
}

/// The tests' shared book: 13.1's hedged BTC carry, 1.2774 nBTC against a 1.2774 BTC short with $35k of
/// Hyperliquid margin, on 13's calm market.
struct Book {
    eng: Engine,
    m: Market,
    p: f64,
    q: f64,
    a: Account,
}

impl Book {
    fn new() -> Book {
        let eng = Engine::v0();
        let m = eng.calm_market();
        let p = m.price("BTC");
        let q = 100_000.0 / p;
        let a = Account {
            near: map(&[("nBTC", q)]),
            hl_cash: 35_000.0,
            perps: map(&[("BTC", -q)]),
            entry: map(&[("BTC", p)]),
            ..Account::default()
        };
        Book { eng, m, p, q, a }
    }

    fn req(&self, a: &Account) -> Requirement {
        self.eng.requirement(a, &self.m)
    }

    fn mr(&self, a: &Account) -> f64 {
        self.req(a).mr
    }

    /// The Standard credit line of the hedged book.
    fn allow(&self) -> f64 {
        let req = self.req(&self.a);
        self.eng
            .borrow_allowance(&self.a, &self.m, Some(&req), 0, None)
            .w
    }

    /// The hedged book with that line drawn and taken out.
    fn loaded(&self) -> Account {
        Account {
            debt: self.allow(),
            ..self.a.clone()
        }
    }

    fn with_wrap(&self, ratio: f64) -> Market {
        let mut m = self.m.clone();
        m.wrap.insert("nBTC".to_string(), ratio);
        m
    }
}

/// 13.4's directional book with $200k of Hyperliquid margin.
fn directional(m: &Market) -> Account {
    let coins = [
        ("SOL", 150_000.0),
        ("ETH", -100_000.0),
        ("HYPE", 60_000.0),
        ("kPEPE", 30_000.0),
    ];
    Account {
        near: map(&[("USDC", 100_000.0)]),
        hl_cash: 200_000.0,
        perps: coins
            .iter()
            .map(|&(c, usd)| (c, usd / m.price(c)))
            .collect(),
        entry: coins.iter().map(|&(c, _)| (c, m.price(c))).collect(),
        ..Account::default()
    }
}

#[test]
fn t1_at_the_credit_line_equity_covers_im() {
    let s = Book::new();
    let b = s.loaded();
    assert!(s.eng.equity_allow(&b, &s.m) >= s.req(&b).im - 1.0);
}

#[test]
fn t1_at_the_credit_line_no_pool_loss_on_normal_adl_or_replay_days() {
    let s = Book::new();
    let rb = s.req(&s.loaded());
    assert!(rb
        .rows
        .iter()
        .filter(|r| r.kind != Kind::Extreme)
        .all(|r| r.e_after >= -1e-6));
}

#[test]
fn t1_at_the_credit_line_extreme_pool_loss_within_5_percent() {
    let s = Book::new();
    let allow = s.allow();
    let rb = s.req(&s.loaded());
    assert!(rb
        .rows
        .iter()
        .filter(|r| r.kind == Kind::Extreme)
        .all(|r| -r.e_after <= 0.05 * allow + 1.0));
}

#[test]
fn t2_more_debt_never_raises_the_allowance() {
    let s = Book::new();
    let allow = s.allow();
    let b2 = Account {
        debt: allow + 1000.0,
        ..s.a.clone()
    };
    let allow2 = s.eng.borrow_allowance(&b2, &s.m, None, 0, None).w;
    assert!(
        allow2 <= (allow - 1000.0).max(0.0) + 1.0,
        "{allow2} vs {allow}"
    );
}

#[test]
fn t2_more_debt_never_lowers_the_requirement() {
    let s = Book::new();
    let allow = s.allow();
    let b2 = Account {
        debt: allow + 1000.0,
        ..s.a.clone()
    };
    assert!(s.mr(&b2) >= s.mr(&s.loaded()) - 1e-6);
}

#[test]
fn t3_moving_usdc_to_hyperliquid_lowers_the_requirement_when_it_stops_the_liquidation() {
    let s = Book::new();
    let thin = Account {
        near: map(&[("nBTC", s.q), ("USDC", 25_000.0)]),
        hl_cash: 35_000.0,
        ..s.a.clone()
    };
    let thick = Account {
        near: map(&[("nBTC", s.q), ("USDC", 0.0)]),
        hl_cash: 60_000.0,
        ..s.a.clone()
    };
    assert!(s.mr(&thick) < s.mr(&thin));
}

#[test]
fn t3b_with_no_loan_withdrawals_and_trades_are_not_limited_by_the_requirement() {
    let s = Book::new();
    let req = s.req(&s.a);
    let no_loan = Account {
        debt: 0.0,
        ..s.a.clone()
    };
    let mut with_usdc = no_loan.clone();
    with_usdc.near.insert("USDC", 5_000.0);
    assert_eq!(s.eng.withdraw_allowance(&with_usdc, &s.m, None).0, 5_000.0);
    assert_eq!(
        s.eng.state(&no_loan, &s.m, &req, 0.0, None).state,
        State::Healthy
    );
}

#[test]
fn t4_a_20x_bigger_book_needs_at_least_20x_the_requirement() {
    let s = Book::new();
    let big = Account {
        near: map(&[("nBTC", 20.0 * s.q)]),
        hl_cash: 20.0 * 35_000.0,
        perps: map(&[("BTC", -20.0 * s.q)]),
        ..s.a.clone()
    };
    assert!(s.mr(&big) >= 20.0 * s.mr(&s.a) - 1e-6);
}

/// Hyperliquid maintenance margin on `coin` is continuous at each of `lower_bounds` but the first.
fn continuous(eng: &Engine, coin: &str, lower_bounds: &[f64]) -> bool {
    lower_bounds[1..]
        .iter()
        .all(|&lb| (eng.mm(coin, lb - 1e-3) - eng.mm(coin, lb + 1e-3)).abs() < 1.0)
}

#[test]
fn t5_hyperliquid_maintenance_margin_is_continuous_at_tier_edges() {
    let s = Book::new();
    let lbs: Vec<f64> = s
        .eng
        .coin("BTC")
        .margin_tiers
        .iter()
        .map(|t| t.lower_bound)
        .collect();
    assert_eq!(lbs, [0.0, 150_000_000.0]);
    assert!(continuous(&s.eng, "BTC", &lbs));
}

#[test]
fn t6_the_hedge_lowers_the_requirement_versus_spot_alone() {
    let s = Book::new();
    let spot_only = Account {
        perps: OrderedMap::new(),
        hl_cash: 0.0,
        ..s.a.clone()
    };
    assert!(s.mr(&s.a) < s.mr(&spot_only));
}

#[test]
fn t7_im_is_1_25_x_mr() {
    let s = Book::new();
    let req = s.req(&s.a);
    assert!((req.im - 1.25 * req.mr).abs() < 1e-9);
}

#[test]
fn t8_the_twap_rule_never_raises_allowance_equity() {
    let s = Book::new();
    let mut pump = s.m.clone();
    pump.px.insert("BTC".to_string(), s.p * 1.05);
    pump.mark.insert("BTC".to_string(), s.p * 1.05);
    let long_only = Account {
        perps: OrderedMap::new(),
        hl_cash: 35_000.0,
        ..s.a.clone()
    };
    assert!(s.eng.equity_allow(&long_only, &pump) <= s.eng.equity_mark(&long_only, &pump));
}

#[test]
fn t9_calm_markets_never_shrink_shocks() {
    let s = Book::new();
    let mut calm = s.m.clone();
    calm.volf.values_mut().for_each(|f| *f = 0.5);
    assert!((s.eng.requirement(&s.a, &calm).mr - s.mr(&s.a)).abs() < 1e-6);
}

#[test]
fn t10_wild_markets_raise_the_requirement() {
    let s = Book::new();
    let mut wild = s.m.clone();
    wild.volf.values_mut().for_each(|f| *f = 2.0);
    assert!(s.eng.requirement(&s.a, &wild).mr > s.mr(&s.a));
}

#[test]
fn t11_states_only_worsen_as_nbtc_slips() {
    let s = Book::new();
    let b = s.loaded();
    let states: Vec<State> = [1.0, 0.95, 0.9, 0.85, 0.8, 0.7]
        .iter()
        .map(|&r| {
            let m = s.with_wrap(r);
            s.eng
                .state(&b, &m, &s.eng.requirement(&b, &m), 0.0, None)
                .state
        })
        .collect();
    assert!(states.windows(2).all(|w| w[0] <= w[1]), "{states:?}");
    // The reference's run: HEALTHY x4, WATCH, DELEVERAGE.
    assert_eq!(states[4], State::Watch);
    assert_eq!(states[5], State::Deleverage);
}

/// T1b by brute force: at the line (and the utilisation it causes), every condition holds, and $500 more
/// of loan breaks one.
fn line_holds_and_500_more_breaks(s: &Book, acct: &Account) -> (f64, String, bool) {
    let al = s.eng.borrow_allowance(acct, &s.m, None, 0, None);
    let mut m2 = s.m.clone();
    m2.util = (s.m.pool_loans + al.w) / s.m.pool_capital;
    let loaded = Account {
        debt: al.w,
        ..acct.clone()
    };
    let r = s.eng.requirement(&loaded, &m2);
    let ok_im = s.eng.equity_allow(&loaded, &m2) >= r.im - 1.0;
    let ok_c2 = r
        .rows
        .iter()
        .filter(|x| x.kind != Kind::Extreme)
        .all(|x| x.e_after >= -1e-6);
    let ok_c3 = r
        .rows
        .iter()
        .filter(|x| x.kind == Kind::Extreme)
        .all(|x| -x.e_after <= 0.05 * al.w + 1.0);
    let over = Account {
        debt: al.w + 500.0,
        ..acct.clone()
    };
    let breaks = !s.eng.credit_failures(&over, &m2, None).is_empty();
    (al.w, al.key, ok_im && ok_c2 && ok_c3 && breaks)
}

#[test]
fn t1b_13_1_preferred_line_holds_every_condition_and_500_more_breaks_one() {
    let s = Book::new();
    let (w, key, ok) = line_holds_and_500_more_breaks(
        &s,
        &Account {
            tier: ClientTier::Preferred,
            ..s.a.clone()
        },
    );
    assert!(ok);
    assert_eq!((w.round(), key.as_str()), (114_750.0, "C4 tier cap"));
}

#[test]
fn t1b_13_4_200k_line_holds_every_condition_and_500_more_breaks_one() {
    let s = Book::new();
    let (w, key, ok) = line_holds_and_500_more_breaks(&s, &directional(&s.m));
    assert!(ok);
    assert_eq!((w.round(), &key[..6]), (140_620.0, "C3 2S "));
}

#[test]
fn t5b_every_margin_table_in_use_is_continuous_at_its_tier_edges() {
    let s = Book::new();
    for (id, tiers) in s.eng.tables.iter() {
        let lbs: Vec<f64> = tiers.iter().map(|t| t.lower_bound).collect();
        if let Some(coin) = s
            .eng
            .coins
            .iter()
            .find(|c| c.hl_margin_table.to_string() == id)
        {
            assert!(continuous(&s.eng, &coin.name, &lbs), "table {id}");
        }
    }
}

#[test]
fn t15_a_score_below_450_gives_no_credit() {
    let s = Book::new();
    assert_eq!(
        s.eng.borrow_allowance(&s.a, &s.m, None, 0, Some(440)).w,
        0.0
    );
}

#[test]
fn t16_moving_usdc_to_hyperliquid_is_checked_like_an_outflow_and_refused_when_it_raises_mr_past_equity(
) {
    // 13.1: margin that can't survive the 2020 rebound is lost with the backstop, so $10k more on Hyperliquid
    // raises MR ($35k -> $45k of margin: $15.5k -> $24.1k). With a Preferred loan of $120k the account meets every
    // condition before the move and is below IM after it, though its equity and collateral don't change.
    let s = Book::new();
    let a = Account {
        near: map(&[("nBTC", s.q), ("USDC", 10_000.0)]),
        debt: 120_000.0,
        tier: ClientTier::Preferred,
        ..s.a.clone()
    };
    assert!(s.eng.credit_failures(&a, &s.m, None).is_empty());
    let to_hl = Withdrawal {
        to_hl: 10_000.0,
        ..Withdrawal::default()
    };
    let (ok, why) = s.eng.withdraw_intent(&a, &s.m, &to_hl);
    assert!(!ok);
    assert!(
        why.starts_with("equity $25,000 below the initial requirement"),
        "{why}"
    );
}

#[test]
fn t12_squeeze_then_revert_at_the_credit_line_the_pool_loses_nothing() {
    let s = Book::new();
    let near_px = s.m.price("NEAR");
    let nq = 1_000_000.0 / near_px;
    let sq = Account {
        near: map(&[("wNEAR", nq)]),
        hl_cash: 250_000.0,
        perps: map(&[("NEAR", -nq)]),
        entry: map(&[("NEAR", near_px)]),
        tier: ClientTier::Preferred,
        ..Account::default()
    };
    let w = s.eng.borrow_allowance(&sq, &s.m, None, 0, None).w;
    let rows = s.req(&Account { debt: w, ..sq }).rows;
    let worst = rows
        .iter()
        .filter(|r| r.kind == Kind::Reversal)
        .map(|r| r.e_after)
        .fold(f64::INFINITY, f64::min);
    assert!(worst >= -1e-6, "{worst}");
}

#[test]
fn t13_a_generous_limit_price_is_booked_at_the_mark_and_creates_no_equity() {
    // A sell with its limit 0.9% above the mark is booked at the mark and only pays the fee; a buy with its limit
    // below the mark is booked at the mark too.
    let s = Book::new();
    let a = Account {
        debt: 1.0,
        ..s.a.clone()
    };
    let mark = s.m.mark_price("BTC");
    let fill = worst_fill(-0.01, s.p * 1.009, mark);
    let (after, fee) = s.eng.post_trade(&a, &s.m, "BTC", -0.01, fill);
    assert_eq!(fill, mark);
    assert!(fee > 0.0);
    assert!((s.eng.equity_mark(&after, &s.m) - (s.eng.equity_mark(&a, &s.m) - fee)).abs() < 1e-6);
    assert_eq!(worst_fill(0.01, s.p * 0.991, mark), mark);
}

#[test]
fn t14_a_25k_hyperliquid_withdrawal_after_the_full_standard_loan_is_refused() {
    let s = Book::new();
    let (ok, why) = s.eng.withdraw_intent(
        &s.loaded(),
        &s.m,
        &Withdrawal {
            hl_cash: 25_000.0,
            ..Withdrawal::default()
        },
    );
    assert!(!ok);
    assert!(
        why.starts_with("equity $15,500 below the initial requirement $18,625"),
        "{why}"
    );
}

#[test]
fn t17_a_frozen_nbtc_adds_no_credit_moves_no_state_and_leaves_only_when_the_rest_carries_the_loan()
{
    let s = Book::new();
    let b = s.loaded();
    let mut frozen = s.m.clone();
    frozen.frozen.insert("nBTC".to_string());
    let rb = s.req(&b);
    let rb_fz = s.eng.requirement(&b, &frozen);
    let before = s.eng.state(&b, &s.m, &rb, 0.0, None);
    let after = s.eng.state(&b, &frozen, &rb_fz, 0.0, None);
    assert_eq!((after.state, after.action), (before.state, before.action));
    assert_eq!(
        s.eng.borrow_allowance(&b, &frozen, Some(&rb_fz), 0, None).w,
        0.0
    );
    let all_nbtc = Withdrawal {
        token: Some("nBTC".to_string()),
        units: s.q,
        ..Withdrawal::default()
    };
    assert!(!s.eng.withdraw_intent(&b, &frozen, &all_nbtc).0);
    let small = Account {
        near: map(&[("USDC", 100_000.0), ("nBTC", 10_000.0 / s.p)]),
        debt: 20_000.0,
        ..Account::default()
    };
    let small_out = Withdrawal {
        token: Some("nBTC".to_string()),
        units: 10_000.0 / s.p,
        ..Withdrawal::default()
    };
    assert!(s.eng.withdraw_intent(&small, &frozen, &small_out).0);
}

#[test]
fn t18_a_hedged_pair_is_unwound_both_legs_together() {
    // 8.4: on an exact ETH hedge that must deleverage, the first step buys back as much of the short as it sells
    // ETH, and at most 1Click's hour ($50k).
    let s = Book::new();
    let eth_px = s.m.price("ETH");
    let eth = Account {
        near: map(&[("ETH.b", 200.0)]),
        hl_cash: 120_000.0,
        perps: map(&[("ETH", -200.0)]),
        entry: map(&[("ETH", eth_px)]),
        debt: 450_000.0,
        ..Account::default()
    };
    let (steps, after) = s.eng.deleverage_plan(&eth, &s.m, 1);
    assert!(
        steps.first().is_some_and(|st| st.starts_with("pair ETH")),
        "{steps:?}"
    );
    let sold = (eth.near["ETH.b"] - after.near["ETH.b"]) * eth_px;
    assert!(sold <= 50_000.0 + 1e-6, "{sold}");
    let moved =
        s.eng.net_units(&after, &s.m, "ETH", None) - s.eng.net_units(&eth, &s.m, "ETH", None);
    assert!(moved.abs() < 1e-9, "{moved}");
}

#[test]
fn t19_a_lower_pi_allow_lowers_the_credit_line_but_moves_neither_mr_nor_the_state() {
    // 3.3: for new credit a wrapper counts at π_allow, the lowest π of the last hour.
    let s = Book::new();
    let b = s.loaded();
    let rb = s.req(&b);
    let mut low = s.m.clone();
    low.wrap_allow.insert("nBTC".to_string(), 0.95);
    let rb_low = s.eng.requirement(&b, &low);
    assert!(s.eng.borrow_allowance(&s.a, &low, None, 0, None).w < s.allow());
    assert_eq!(rb_low.mr, rb.mr);
    let before = s.eng.state(&b, &s.m, &rb, 0.0, None);
    let after = s.eng.state(&b, &low, &rb_low, 0.0, None);
    assert_eq!((after.state, after.action), (before.state, before.action));
    // A π_allow above the mark π adds nothing: it is capped at the mark.
    let mut high = s.m.clone();
    high.wrap_allow.insert("nBTC".to_string(), 1.05);
    assert_eq!(
        s.eng.borrow_allowance(&s.a, &high, None, 0, None).w,
        s.allow()
    );
}

#[test]
fn t20_nbtc_in_transit_falls_with_the_scenario_and_counts_nothing_once_overdue() {
    // 4.8: money in transit takes each scenario's moves like the same token held, at 98%. $50k of nBTC on its way
    // in, with nothing else in BTC, falls with BTC.
    let s = Book::new();
    let q20 = 50_000.0 / s.p;
    let transfer = InFlight {
        token: "nBTC".to_string(),
        units: q20,
        overdue: false,
        to_hl: false,
    };
    let a20 = Account {
        near: map(&[("USDC", 60_000.0)]),
        inflight: vec![transfer.clone()],
        debt: 10_000.0,
        ..Account::default()
    };
    let req = s.req(&a20);
    let down = req
        .rows
        .iter()
        .find(|r| r.name == "1.00S (-1,)")
        .expect("the transfer brings BTC's scenarios");
    let s_star = s.eng.shock(&a20, &s.m, "BTC").s_star;
    let fall = 0.98 * valuation::token_value("nBTC", q20, &s.m, 0.0, 0.0) * s_star;
    assert!(down.loss >= fall, "{} vs {fall}", down.loss);
    let late = Account {
        inflight: vec![InFlight {
            overdue: true,
            ..transfer
        }],
        ..a20.clone()
    };
    let none = Account {
        inflight: Vec::new(),
        ..a20
    };
    assert_eq!(s.mr(&late), s.mr(&none));
}
