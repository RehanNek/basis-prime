//! RISK_ENGINE.md 13's worked examples, computed by risk-core and printed line for line as
//! `research/scripts/risk_engine_examples.py` prints them (`ex1` ... `ex6` there), so the two printouts can be
//! compared exactly.
use risk_core::py::{fixed2, pct0, usd};
use risk_core::states::{band, BAND_STEP};
use risk_core::*;

fn map(pairs: &[(&str, f64)]) -> OrderedMap<f64> {
    pairs.iter().map(|&(k, v)| (k, v)).collect()
}

/// `f"{x:.1%}"`, `f"{x:.2%}"`, `f"{x:+.1%}"`.
fn pct1(x: f64) -> String {
    format!("{:.1}%", x * 100.0)
}

fn pct2(x: f64) -> String {
    format!("{:.2}%", x * 100.0)
}

fn signed_pct1(x: f64) -> String {
    format!("{:+.1}%", x * 100.0)
}

/// Python's `str(bool)`.
fn py_bool(b: bool) -> &'static str {
    if b {
        "True"
    } else {
        "False"
    }
}

/// `s[:n]`.
fn head(s: &str, n: usize) -> &str {
    &s[..s.len().min(n)]
}

fn with_tier(a: &Account, tier: ClientTier) -> Account {
    Account { tier, ..a.clone() }
}

/// The printout, one line per `print` (a leading "\n" in the reference is an empty line).
struct Out(Vec<String>);

impl Out {
    fn line(&mut self, s: String) {
        self.0.extend(s.split('\n').map(str::to_string));
    }
}

fn show_req(o: &mut Out, eng: &Engine, a: &Account, m: &Market, title: &str) -> (Requirement, f64) {
    let req = eng.requirement(a, m);
    let al = eng.borrow_allowance(a, m, Some(&req), 0, None);
    let st = eng.state(a, m, &req, 0.0, None);
    o.line(format!("\n### {title}"));
    o.line(format!(
        "equity {} | allowance equity {} | MR {} | IM {} | state {} / action {} | HL margin ratio {}",
        usd(req.e),
        usd(eng.equity_allow(a, m)),
        usd(req.mr),
        usd(req.im),
        st.state.as_str(),
        st.action.as_str(),
        pct1(st.hl_ratio)
    ));
    o.line(format!(
        "worst normal {} | worst extreme {} (half: {}) | worst replay {}",
        usd(req.normal),
        usd(req.extreme),
        usd(0.5 * req.extreme),
        usd(req.replay)
    ));
    for (name, loss) in eng.top_risks(&req, 5) {
        o.line(format!("   top risk: {:>10}  {name}", usd(loss)));
    }
    o.line(format!(
        "borrow allowance {} (binding: {})",
        usd(al.w),
        al.key
    ));
    (req, al.w)
}

/// 13.1–13.3: the hedged BTC carry. Returns the account, the account with the Standard loan drawn, and
/// the market.
fn ex1(o: &mut Out, eng: &Engine) -> (Account, Account, Market) {
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
    o.line(format!(
        "\n## Example 1: hedged BTC carry. BTC {}; {q:.4} nBTC + {q:.4} BTC short, $35k margin",
        usd(p)
    ));
    let (req, allow) = show_req(o, eng, &a, &m, "Standard tier, no loan yet");
    for r in eng.ranked(&req).into_iter().take(8) {
        let liq = r.det.and_then(|d| d.liq).map_or("-", |l| l.kind.as_str());
        o.line(format!(
            "   {:8} {:45} loss {:>9} weighted {:>9} liq={liq}",
            r.kind.as_str(),
            r.name,
            usd(r.loss),
            usd(eng.weight(r.kind) * r.loss)
        ));
    }
    let bounds = eng.borrow_allowance(&a, &m, Some(&req), 0, None).bounds;
    let stress = bounds
        .iter()
        .filter(|(k, _)| ["C0", "C1", "C2", "C3"].iter().any(|c| k.starts_with(c)))
        .map(|(_, &v)| v)
        .reduce(py::min)
        .unwrap();
    o.line(format!(
        "stress capacity (before tier/limit caps) {}; Standard cap {}; Preferred cap {}",
        usd(stress),
        usd(bounds["C4 tier cap"]),
        usd(0.85 * 135_000.0)
    ));
    let pref = eng.borrow_allowance(&with_tier(&a, ClientTier::Preferred), &m, None, 0, None);
    let base = eng.params.base_rate(m.util);
    o.line(format!(
        "Preferred: {} ({}); rates now: Standard {}, Preferred {}",
        usd(pref.w),
        pref.key,
        pct2(base + 0.02),
        pct2(base + 0.01)
    ));
    o.line(
        "\n### Same hedge, more margin parked on Hyperliquid (extra USDC deposited)".to_string(),
    );
    for hl in [35_000.0, 40_000.0, 45_000.0, 50_000.0, 60_000.0] {
        let a2 = Account {
            hl_cash: hl,
            ..a.clone()
        };
        let r2 = eng.requirement(&a2, &m);
        let w2 = eng.borrow_allowance(&a2, &m, Some(&r2), 0, None);
        let w3 = eng.borrow_allowance(&with_tier(&a2, ClientTier::Preferred), &m, None, 0, None);
        o.line(format!(
            "   Hyperliquid margin {:>8}: equity {}, MR {:>8} (top: {}), Standard line {} ({}), Preferred line {} ({})",
            usd(hl),
            usd(r2.e),
            usd(r2.mr),
            head(&eng.top_risks(&r2, 1)[0].0, 40),
            usd(w2.w),
            head(&w2.key, 14),
            usd(w3.w),
            head(&w3.key, 14)
        ));
    }
    let hr = eng.hedge_ratio(&a, &m);
    let clean = ScoreInputs {
        kyb: true,
        linked_months: 8,
        linked_fills: 200,
        linked_volume: 5e6,
        ..ScoreInputs::new(hr, hr)
    };
    o.line(format!(
        "hedge ratio {}; score new client {}; with KYB + clean linked HL {}",
        fixed2(hr),
        rating::score(&ScoreInputs::new(hr, hr)),
        rating::score(&clean)
    ));
    let b = Account {
        debt: allow,
        ..a.clone()
    };
    let tu = eng.topup(&b, &m);
    let rt = eng.requirement(
        &Account {
            hl_cash: b.hl_cash + tu,
            ..b.clone()
        },
        &m,
    );
    o.line(format!(
        "\nloan drawn: smallest Hyperliquid top-up that takes the liquidation out of the top risks {} (MR after: {})",
        usd(tu),
        usd(rt.mr)
    ));
    o.line(format!(
        "\n### Loan of {} drawn and withdrawn; nBTC/BTC depeg drill",
        usd(allow)
    ));
    let with_wrap = |ratio: f64| {
        let mut mm = m.clone();
        mm.wrap.insert("nBTC".to_string(), ratio);
        mm
    };
    let mut first_dl = None;
    for ratio in [1.0, 0.98, 0.95, 0.90, 0.85, 0.80, 0.75, 0.70] {
        let mm = with_wrap(ratio);
        let r = eng.requirement(&b, &mm);
        let st = eng.state(&b, &mm, &r, 0.0, None);
        if st.state == State::Deleverage && first_dl.is_none() {
            first_dl = Some(ratio);
        }
        o.line(format!(
            "   nBTC/BTC {}: equity {:>8}  MR {:>8}  IM {:>8}  {:11} {}",
            fixed2(ratio),
            usd(r.e),
            usd(r.mr),
            usd(r.im),
            st.state.as_str(),
            st.action.as_str()
        ));
    }
    if let Some(ratio) = first_dl {
        let mm = with_wrap(ratio);
        let (steps, after) = eng.deleverage_plan(&b, &mm, 40);
        let r = eng.requirement(&after, &mm);
        o.line(format!(
            "\n### Deleverage plan at nBTC/BTC {}",
            fixed2(ratio)
        ));
        for s in steps {
            o.line(format!("   - {s}"));
        }
        o.line(format!(
            "   after: equity {}, MR {}, IM {}, debt {}, nBTC {:.4}, BTC perp {:.4}, state {}",
            usd(r.e),
            usd(r.mr),
            usd(r.im),
            usd(after.debt),
            after.near.get_or("nBTC", 0.0),
            after.perps.get_or("BTC", 0.0),
            eng.state(&after, &mm, &r, 0.0, None).state.as_str()
        ));
    }
    // Bands: everything re-evaluated at each trial point.
    let f_hl = |x: f64| {
        let mut m2 = m.clone();
        m2.mark
            .insert("BTC".to_string(), m.mark_price("BTC") * (1.0 + x));
        eng.hl_ratio(&b, &m2, None)
    };
    let up50 = band(f_hl, 0.5, 0.0, 3.0, BAND_STEP).unwrap();
    let up100 = band(f_hl, 1.0, 0.0, 3.0, BAND_STEP).unwrap();
    let wrap_band = |k: f64| {
        let f = |x: f64| {
            let r2 = eng.requirement(&b, &with_wrap(1.0 + x));
            r2.e - k * r2.mr
        };
        1.0 + band(f, 0.0, -0.99, 0.0, BAND_STEP).unwrap()
    };
    let (w_im, w_mr, w_dl) = (wrap_band(1.25), wrap_band(1.0), wrap_band(0.8));
    o.line(format!(
        "bands: BTC price where Hyperliquid margin ratio hits 50%: {} ({}); 100% (liquidation): {} ({})",
        usd(p * (1.0 + up50)),
        signed_pct1(up50),
        usd(p * (1.0 + up100)),
        signed_pct1(up100)
    ));
    o.line(format!(
        "       nBTC/BTC where equity hits IM {w_im:.4}, MR {w_mr:.4}, 0.8 x MR {w_dl:.4}"
    ));
    (a, b, m)
}

/// 13.4: the directional four-coin book.
fn ex2(o: &mut Out, eng: &Engine, hl_margin: f64) {
    let m = eng.calm_market();
    let coins = [
        ("SOL", 150_000.0),
        ("ETH", -100_000.0),
        ("HYPE", 60_000.0),
        ("kPEPE", 30_000.0),
    ];
    let a = Account {
        near: map(&[("USDC", 100_000.0)]),
        hl_cash: hl_margin,
        perps: coins.iter().map(|&(c, x)| (c, x / m.price(c))).collect(),
        entry: coins.iter().map(|&(c, _)| (c, m.price(c))).collect(),
        tier: ClientTier::Standard,
        ..Account::default()
    };
    let hr = eng.hedge_ratio(&a, &m);
    let kyb = rating::score(&ScoreInputs {
        kyb: true,
        ..ScoreInputs::new(hr, hr)
    });
    let plain = rating::score(&ScoreInputs::new(hr, hr));
    o.line(format!(
        "   hedge ratio {}; a KYB'd client scores {kyb} -> {} (without KYB {plain} -> {}, starting limit $50,000)",
        fixed2(hr),
        rating::tier_of(kyb, true).as_str(),
        rating::tier_of(plain, false).as_str()
    ));
    o.line(format!(
        "\n## Example 2: directional multi-coin book ($100k USDC on NEAR; Hyperliquid {} margin, long $150k SOL, \
         short $100k ETH, long $60k HYPE, long $30k kPEPE)",
        usd(hl_margin)
    ));
    for g in eng.groups(&a) {
        let s = eng.shock(&a, &m, &g);
        let c = eng.coin(&g);
        o.line(format!(
            "   {g:6} S {} x f {:.2} x liquidity {:.3} = {}; unwind {:.2} h; client cap {}",
            pct0(c.params.s),
            s.f,
            s.ell,
            pct1(s.s_star),
            eng.unwind_hours(&a, &m, &g),
            usd(c.params.client_cap_usd)
        ));
    }
    show_req(o, eng, &a, &m, "Standard tier");
}

/// 13.6: a Mango-style attempt on the thinnest allowed coin.
fn ex3(o: &mut Out, eng: &Engine) {
    let thin = eng
        .coins
        .iter()
        .filter(|c| c.allowed)
        .reduce(|a, b| if b.adv30_usd < a.adv30_usd { b } else { a })
        .unwrap();
    let name = thin.name.as_str();
    let m = eng.calm_market();
    let px = m.price(name);
    let cap = thin.params.client_cap_usd;
    o.line(format!(
        "\n## Example 3: Mango-style attempt on {name} (thinnest allowed: Hyperliquid volume {}/day, OI {}, spot {}/day)",
        usd(thin.adv30_usd),
        usd(thin.oi_usd),
        usd(thin.spot24h_usd)
    ));
    o.line(format!(
        "   per-client cap {}; price band {}",
        usd(cap),
        pct0(thin.params.price_band)
    ));
    let a = Account {
        near: map(&[("USDC", 1_000_000.0)]),
        hl_cash: 0.0,
        tier: ClientTier::Watch,
        ..Account::default()
    };
    let order = Order {
        coin: name.to_string(),
        size: 2.0 * cap / px,
        limit_px: px * 1.001,
        reduce_only: false,
    };
    let (ok, why) = eng.pretrade(&a, &m, &order, None);
    o.line(format!("   order for 2x the cap: {} ({why})", py_bool(ok)));
    let pos = 0.5 * cap;
    let a = Account {
        near: map(&[("USDC", 700_000.0)]),
        hl_cash: 300_000.0,
        perps: map(&[(name, pos / px)]),
        entry: map(&[(name, px)]),
        tier: ClientTier::Watch,
        ..Account::default()
    };
    let req = eng.requirement(&a, &m);
    let s = eng.shock(&a, &m, name);
    let w0 = eng.borrow_allowance(&a, &m, Some(&req), 0, None);
    let grid = py::max(req.normal, 0.5 * req.extreme);
    o.line(format!(
        "   long {} {name} (half the cap) with $1M equity: shock {} (liquidity factor {:.2}); grid loss {}; MR {} = {} \
         of the position, set by {}; borrow allowance {} ({})",
        usd(pos),
        pct0(s.s_star),
        s.ell,
        usd(grid),
        usd(req.mr),
        pct0(req.mr / pos),
        eng.top_risks(&req, 1)[0].0,
        usd(w0.w),
        head(&w0.key, 28)
    ));
    for pump in [0.10, 0.30, 0.50] {
        let mut m2 = m.clone();
        m2.px.insert(name.to_string(), px * (1.0 + pump));
        m2.mark
            .insert(name.to_string(), m.mark_price(name) * (1.0 + pump));
        let e_mark = eng.equity_mark(&a, &m2);
        let e_allow = eng.equity_allow(&a, &m2);
        let al = eng.borrow_allowance(&a, &m2, None, 0, None);
        o.line(format!(
            "   price pushed +{} on every source for <1h: paper gain {}; equity {}, equity for new credit {} (TWAP rule \
             removes {}); borrow allowance {} ({}) vs {} before the pump",
            pct0(pump),
            usd(pos * pump),
            usd(e_mark),
            usd(e_allow),
            usd(e_mark - e_allow),
            usd(al.w),
            head(&al.key, 28),
            usd(w0.w)
        ));
    }
    let sig_day = thin.params.vol_ref / 365f64.sqrt();
    for pump in [0.10, 0.30] {
        let need = thin.spot24h_usd * (pump / sig_day) * (pump / sig_day);
        o.line(format!(
            "   square-root rule: pushing spot +{} takes about {} of buying ({:.0} days of spot volume)",
            pct0(pump),
            usd(need),
            need / thin.spot24h_usd
        ));
    }
}

/// 13.5: the requirement for a plain $100k perp on each allowed coin.
fn ex7(o: &mut Out, eng: &Engine) {
    let m = eng.calm_market();
    o.line("\n## Example 7: requirement for a plain $100k perp, $100k of Hyperliquid margin, a loan outstanding".to_string());
    o.line(format!(
        "   {:6} {:>4} | {:>10} {:>12} {:34} | {:>11} {:>12} {:34}",
        "coin",
        "S",
        "long: grid",
        "with replays",
        "driver",
        "short: grid",
        "with replays",
        "driver"
    ));
    for c in eng.coins.iter().filter(|c| c.allowed) {
        let name = c.name.as_str();
        let cells: Vec<(f64, f64, String)> = [1.0, -1.0]
            .iter()
            .map(|side| {
                let a = Account {
                    hl_cash: 100_000.0,
                    perps: map(&[(name, side * 100_000.0 / m.price(name))]),
                    entry: map(&[(name, m.price(name))]),
                    debt: 1.0,
                    ..Account::default()
                };
                let req = eng.requirement(&a, &m);
                let driver = eng.top_risks(&req, 1)[0].0.clone();
                (py::max(req.normal, 0.5 * req.extreme), req.mr, driver)
            })
            .collect();
        o.line(format!(
            "   {name:6} {:>4} | {:>10} {:>12} {:34} | {:>11} {:>12} {:34}",
            pct0(c.params.s),
            usd(cells[0].0),
            usd(cells[0].1),
            head(&cells[0].2, 34),
            usd(cells[1].0),
            usd(cells[1].1),
            head(&cells[1].2, 34)
        ));
    }
}

/// 13.1's table of the options for the replays.
fn ex_options(o: &mut Out, eng: &Engine) {
    let m = eng.calm_market();
    let p = m.price("BTC");
    let q = 100_000.0 / p;
    let hedged = Account {
        near: map(&[("nBTC", q)]),
        hl_cash: 35_000.0,
        perps: map(&[("BTC", -q)]),
        entry: map(&[("BTC", p)]),
        ..Account::default()
    };
    let plain = |coin: &str, size: f64| Account {
        hl_cash: 100_000.0,
        perps: map(&[(coin, size)]),
        entry: map(&[(coin, m.price(coin))]),
        debt: 1.0,
        ..Account::default()
    };
    let btc_long = plain("BTC", q);
    let sol_long = plain("SOL", 100_000.0 / m.price("SOL"));
    let sui_short = plain("SUI", -100_000.0 / m.price("SUI"));
    o.line("\n## Options for the replays (section 13.1)".to_string());
    o.line(format!(
        "   {:32} {:>10} {:>9} {:>10} {:>12} {:>12} {:>13}",
        "option",
        "hedged MR",
        "Std line",
        "Pref line",
        "BTC long MR",
        "SOL long MR",
        "SUI short MR"
    ));
    // (option, replay weight, replay moves capped at 2S)
    let options = [
        ("as specified: replays in full", 1.0, false),
        ("replays at half weight", 0.5, false),
        ("replay moves capped at 2S", 1.0, true),
        ("no replays (grid only)", 0.0, false),
    ];
    for (name, weight, cap_2s) in options {
        let mut e = eng.clone();
        e.params.replay_weight = weight;
        e.params.replay_cap_2s = cap_2s;
        let rh = e.requirement(&hedged, &m);
        let std = e.borrow_allowance(&hedged, &m, Some(&rh), 0, None).w;
        let pref = e
            .borrow_allowance(
                &with_tier(&hedged, ClientTier::Preferred),
                &m,
                None,
                0,
                None,
            )
            .w;
        o.line(format!(
            "   {name:32} {:>10} {:>9} {:>10} {:>12} {:>12} {:>13}",
            usd(rh.mr),
            usd(std),
            usd(pref),
            usd(e.requirement(&btc_long, &m).mr),
            usd(e.requirement(&sol_long, &m).mr),
            usd(e.requirement(&sui_short, &m).mr)
        ));
    }
}

/// 13.7: pre-trade checks.
fn ex5(o: &mut Out, eng: &Engine, a1: &Account, b1: &Account, m: &Market) {
    o.line("\n## Example 5: pre-trade checks".to_string());
    let p = m.price("BTC");
    let q = -a1.perps["BTC"];
    let order = |coin: &str, size: f64, limit_px: f64| Order {
        coin: coin.to_string(),
        size,
        limit_px,
        reduce_only: false,
    };
    let cases = [
        (
            "   Example 1 client with the loan buys back the whole short",
            b1,
            order("BTC", q, p * 1.002),
        ),
        (
            "   ... buys back a quarter of it",
            b1,
            order("BTC", q * 0.25, p * 1.002),
        ),
        (
            "   limit price 5% below the reference",
            a1,
            order("BTC", -0.1 * q, p * 0.95),
        ),
        (
            "   coin outside the allow-list",
            a1,
            order(
                if eng.find_coin("XMR").is_some() {
                    "XMR"
                } else {
                    "TAO"
                },
                1.0,
                1.0,
            ),
        ),
    ];
    for (what, a, ord) in cases {
        let (ok, why) = eng.pretrade(a, m, &ord, None);
        o.line(format!("{what}: {} ({why})", py_bool(ok)));
    }
}

/// 13.8: ratings.
fn ex6(o: &mut Out) {
    o.line("\n## Example 6: rating".to_string());
    let hedged = ScoreInputs::new(1.0, 1.0);
    let clean = ScoreInputs {
        linked_months: 8,
        linked_fills: 200,
        linked_volume: 5e6,
        ..hedged
    };
    let cases = [
        ("new client, hedged book", hedged),
        (
            "+ KYB",
            ScoreInputs {
                kyb: true,
                ..hedged
            },
        ),
        (
            "+ KYB + 8 months of clean, active linked Hyperliquid history",
            ScoreInputs { kyb: true, ..clean },
        ),
        ("hedged + clean linked history, no KYB", clean),
        (
            "farming try: all USDC + an old, idle linked address",
            ScoreInputs {
                exposure_share: 0.0,
                linked_months: 24,
                ..hedged
            },
        ),
        ("new client, directional book", ScoreInputs::new(0.1, 0.1)),
        (
            "directional, 6 good months, KYB",
            ScoreInputs {
                good_months: 6,
                kyb: true,
                ..ScoreInputs::new(0.1, 0.1)
            },
        ),
        (
            "hedged, KYB, one forced unwind this year",
            ScoreInputs {
                kyb: true,
                forced_unwinds_12m: 1,
                ..hedged
            },
        ),
        (
            "window-dressed: hedged today, directional all week",
            ScoreInputs::new(1.0, 0.2),
        ),
        (
            "any client after a default",
            ScoreInputs {
                kyb: true,
                defaults: 1,
                ..hedged
            },
        ),
    ];
    for (name, inputs) in cases {
        let s = rating::score(&inputs);
        o.line(format!(
            "   {name:60} score {s:4}  tier {}",
            rating::tier_of(s, inputs.kyb).as_str()
        ));
    }
}

/// Every worked example, in the order `risk_engine_ref.py ... examples` prints them.
pub fn printout(eng: &Engine) -> Vec<String> {
    let mut o = Out(Vec::new());
    let (a1, b1, m) = ex1(&mut o, eng);
    ex2(&mut o, eng, 80_000.0);
    ex2(&mut o, eng, 200_000.0);
    ex3(&mut o, eng);
    ex7(&mut o, eng);
    ex_options(&mut o, eng);
    ex5(&mut o, eng, &a1, &b1, &m);
    ex6(&mut o);
    o.0.push(String::new()); // the final newline
    o.0
}
