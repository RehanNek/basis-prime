//! Golden tests: risk-core against the Python reference engine on every case in
//! `research/data/reference_cases.json`, written by `research/scripts/export_reference_cases.py`. A case is one
//! engine call made by the worked examples of RISK_ENGINE.md 13 or the property checks of 14.2 (or one of the
//! extras), with its inputs and the reference's result.
//!
//! Dollar amounts must agree within $1. States, actions, tiers, binding limits, scenario names, reasons and
//! plan steps must agree exactly. Other numbers (rates, ratios, shocks, hours, units, band moves) within 1e-9.
//! Run with `--nocapture` to see the summary, including how many numbers matched to the last bit.
use risk_core::states::band;
use risk_core::*;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Debug;

const CASES: &str = include_str!("../../../research/data/reference_cases.json");

fn num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().expect("a number"),
        Value::String(s) if s == "inf" => f64::INFINITY,
        Value::String(s) if s == "-inf" => f64::NEG_INFINITY,
        Value::String(s) if s == "nan" => f64::NAN,
        _ => panic!("not a number: {v}"),
    }
}

fn text(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

/// What one comparison run found.
#[derive(Default)]
struct Tally {
    failures: Vec<String>,
    numbers: usize,
    bit_exact: usize,
    max_dollar_diff: f64,
    max_other_diff: f64,
    exact: usize,
}

impl Tally {
    fn dollars(&mut self, ctx: &str, what: &str, got: f64, want: &Value) {
        self.number(ctx, what, got, num(want), true);
    }

    fn other(&mut self, ctx: &str, what: &str, got: f64, want: &Value) {
        self.number(ctx, what, got, num(want), false);
    }

    fn number(&mut self, ctx: &str, what: &str, got: f64, want: f64, dollars: bool) {
        self.numbers += 1;
        if got.to_bits() == want.to_bits() || got == want || (got.is_nan() && want.is_nan()) {
            self.bit_exact += 1;
            return;
        }
        let diff = (got - want).abs();
        let ok = if dollars {
            diff <= 1.0
        } else {
            diff <= 1e-9 * want.abs().max(1.0)
        };
        if dollars {
            self.max_dollar_diff = self.max_dollar_diff.max(diff);
        } else {
            self.max_other_diff = self.max_other_diff.max(diff);
        }
        if !ok {
            self.failures
                .push(format!("{ctx}: {what}: got {got}, reference {want}"));
        }
    }

    fn same<T: PartialEq + Debug>(&mut self, ctx: &str, what: &str, got: T, want: T) {
        self.exact += 1;
        if got != want {
            self.failures
                .push(format!("{ctx}: {what}: got {got:?}, reference {want:?}"));
        }
    }
}

fn account(v: &Value) -> Account {
    serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("bad account {v}: {e}"))
}

fn requirement_matches(t: &mut Tally, ctx: &str, eng: &Engine, req: &Requirement, want: &Value) {
    t.dollars(ctx, "E", req.e, &want["E"]);
    t.dollars(ctx, "MR", req.mr, &want["MR"]);
    t.dollars(ctx, "IM", req.im, &want["IM"]);
    t.dollars(ctx, "worst normal", req.normal, &want["normal"]);
    t.dollars(ctx, "worst extreme", req.extreme, &want["extreme"]);
    t.dollars(ctx, "worst replay", req.replay, &want["replay"]);
    let rows = want["rows"].as_array().expect("rows");
    t.same(ctx, "number of scenarios", req.rows.len(), rows.len());
    for (r, w) in req.rows.iter().zip(rows) {
        let c = format!("{ctx} / {}", text(&w["name"]));
        t.same(&c, "name", r.name.as_str(), text(&w["name"]));
        t.same(&c, "kind", r.kind.as_str(), text(&w["kind"]));
        t.dollars(&c, "loss", r.loss, &w["loss"]);
        t.other(&c, "rate", r.rate, &w["rate"]);
        t.dollars(&c, "equity after", r.e_after, &w["e_after"]);
        let (Some(d), Some(wd)) = (r.det, w["det"].as_object()) else {
            t.same(&c, "detail present", r.det.is_some(), !w["det"].is_null());
            continue;
        };
        for (what, got) in [
            ("near", d.near),
            ("near_cost", d.near_cost),
            ("inflight", d.inflight),
            ("hl_eq", d.hl_eq),
            ("hl_cost", d.hl_cost),
            ("interest", d.interest),
            ("funding", d.funding),
        ] {
            t.dollars(&c, what, got, &wd[what]);
        }
        t.same(
            &c,
            "worst stage",
            d.stage as u64,
            wd["stage"].as_u64().unwrap(),
        );
        match (d.liq, wd["liq"].as_array()) {
            (Some(l), Some(wl)) => {
                t.same(&c, "liquidation", l.kind.as_str(), text(&wl[0]));
                t.dollars(&c, "liquidation equity", l.eq, &wl[1]);
                t.dollars(&c, "liquidation margin", l.mmv, &wl[2]);
                t.dollars(&c, "liquidation amount", l.amount, &wl[3]);
            }
            (got, _) => t.same(&c, "liquidation", got.map(|l| l.kind.as_str()), None),
        }
    }
    let top = eng.top_risks(req, 5);
    let want_top = want["top"].as_array().expect("top");
    t.same(ctx, "number of top risks", top.len(), want_top.len());
    for (i, ((name, loss), w)) in top.iter().zip(want_top).enumerate() {
        t.same(ctx, &format!("top risk {i}"), name.as_str(), text(&w[0]));
        t.dollars(ctx, &format!("top risk {i} loss"), *loss, &w[1]);
    }
}

fn account_matches(t: &mut Tally, ctx: &str, got: &Account, want: &Value) {
    let w = account(want);
    for (what, g, wm) in [
        ("near", &got.near, &w.near),
        ("perps", &got.perps, &w.perps),
        ("entry", &got.entry, &w.entry),
    ] {
        t.same(
            ctx,
            &format!("{what} keys"),
            g.keys().collect::<Vec<_>>(),
            wm.keys().collect::<Vec<_>>(),
        );
        for ((k, &x), (_, &y)) in g.iter().zip(wm.iter()) {
            t.number(ctx, &format!("{what} {k}"), x, y, false);
        }
    }
    t.number(ctx, "hl_cash", got.hl_cash, w.hl_cash, true);
    t.number(ctx, "debt", got.debt, w.debt, true);
    t.same(ctx, "tier", got.tier, w.tier);
}

/// One band's function, rebuilt from the description the exporter wrote.
fn band_fn<'a>(
    eng: &'a Engine,
    markets: &'a [Market],
    f: &'a Value,
) -> Box<dyn FnMut(f64) -> f64 + 'a> {
    let b = account(&f["account"]);
    let m = &markets[f["market"].as_u64().unwrap() as usize];
    match text(&f["fn"]) {
        "hl_ratio_mark_move" => {
            let coin = text(&f["coin"]).to_string();
            Box::new(move |x| {
                let mut m2 = m.clone();
                m2.mark
                    .insert(coin.clone(), m.mark_price(&coin) * (1.0 + x));
                eng.hl_ratio(&b, &m2, None)
            })
        }
        "equity_minus_k_mr_wrap" => {
            let (tok, k) = (text(&f["token"]).to_string(), num(&f["k"]));
            Box::new(move |x| {
                let mut m2 = m.clone();
                m2.wrap.insert(tok.clone(), 1.0 + x);
                let r2 = eng.requirement(&b, &m2);
                r2.e - k * r2.mr
            })
        }
        "equity_minus_k_mr_coin" => {
            let (coin, k) = (text(&f["coin"]).to_string(), num(&f["k"]));
            Box::new(move |x| {
                let m2 = eng.moved_market(m, &coin, x);
                eng.equity_at(&b, m, &coin, x) - k * eng.requirement(&b, &m2).mr
            })
        }
        other => panic!("unknown band function {other}"),
    }
}

/// Replays one case and compares it with the reference's result.
fn run_case(t: &mut Tally, eng: &Engine, markets: &[Market], case: &Value) {
    let args = &case["args"];
    let out = &case["out"];
    let method = text(&case["method"]);
    let ctx = format!(
        "case {} ({} line {}, {method})",
        case["id"],
        text(&case["src"]),
        case["line"]
    );
    let ctx = ctx.as_str();
    let a = || account(&args["a"]);
    let m = || &markets[args["m"].as_u64().expect("a market index") as usize];
    // A requirement passed in is always the account's own (the exporter checks), so recompute it.
    let own_req = |a: &Account, m: &Market| (!args["req"].is_null()).then(|| eng.requirement(a, m));
    match method {
        "requirement" => {
            let req = eng.requirement(&a(), m());
            requirement_matches(t, ctx, eng, &req, out);
        }
        "borrow_allowance" => {
            let (a, m) = (a(), m());
            assert_eq!(args["second_pass"], Value::Bool(false));
            let req = own_req(&a, m);
            let al = eng.borrow_allowance(
                &a,
                m,
                req.as_ref(),
                args["good_months"].as_i64().unwrap(),
                args["score"].as_i64(),
            );
            t.dollars(ctx, "allowance", al.w, &out["w"]);
            t.same(ctx, "binding bound", al.key.as_str(), text(&out["key"]));
            let bounds = out["bounds"].as_array().unwrap();
            t.same(
                ctx,
                "bound names",
                al.bounds.keys().collect::<Vec<_>>(),
                bounds.iter().map(|b| text(&b[0])).collect(),
            );
            for ((k, &v), w) in al.bounds.iter().zip(bounds) {
                t.dollars(ctx, k, v, &w[1]);
            }
        }
        "withdraw_allowance" => {
            let (a, m) = (a(), m());
            let (w, key) = eng.withdraw_allowance(&a, m, own_req(&a, m).as_ref());
            t.dollars(ctx, "withdrawal", w, &out[0]);
            t.same(ctx, "binding bound", key.as_str(), text(&out[1]));
        }
        "credit_failures" => {
            let (a, m) = (a(), m());
            let fails = eng.credit_failures(&a, m, own_req(&a, m).as_ref());
            let want: Vec<&str> = out.as_array().unwrap().iter().map(text).collect();
            t.same(
                ctx,
                "failures",
                fails.iter().map(String::as_str).collect::<Vec<_>>(),
                want,
            );
        }
        "withdraw_intent" => {
            let w = Withdrawal {
                token: args["token"].as_str().map(str::to_string),
                units: num(&args["units"]),
                hl_cash: num(&args["hl_cash"]),
                to_hl: num(&args["to_hl"]),
            };
            let (ok, why) = eng.withdraw_intent(&a(), m(), &w);
            t.same(ctx, "allowed", ok, out[0].as_bool().unwrap());
            t.same(ctx, "reason", why.as_str(), text(&out[1]));
        }
        "state" => {
            let r = &args["req"];
            let levels = Requirement::levels(num(&r["E"]), num(&r["MR"]), num(&r["IM"]));
            let prev = args["prev"]
                .as_str()
                .map(|s| State::parse(s).expect("a state"));
            let st = eng.state(&a(), m(), &levels, num(&args["margin_call_age_h"]), prev);
            t.same(ctx, "state", st.state.as_str(), text(&out[0]));
            t.same(ctx, "action", st.action.as_str(), text(&out[1]));
            t.other(ctx, "margin ratio", st.hl_ratio, &out[2]);
            t.same(
                ctx,
                "projected breach",
                st.venue_breach,
                out[3].as_bool().unwrap(),
            );
        }
        "topup" => t.dollars(ctx, "top-up", eng.topup(&a(), m()), out),
        "deleverage_plan" => {
            let (steps, after) =
                eng.deleverage_plan(&a(), m(), args["max_steps"].as_u64().unwrap() as usize);
            let want: Vec<&str> = out["steps"].as_array().unwrap().iter().map(text).collect();
            t.same(
                ctx,
                "plan",
                steps.iter().map(String::as_str).collect::<Vec<_>>(),
                want,
            );
            account_matches(t, ctx, &after, &out["after"]);
        }
        "band" => {
            let f = band_fn(eng, markets, &args["f"]);
            let x = band(
                f,
                num(&args["target"]),
                num(&args["lo"]),
                num(&args["hi"]),
                num(&args["step"]),
            );
            match (x, out.is_null()) {
                (Some(x), false) => t.other(ctx, "band", x, out),
                (x, none) => t.same(ctx, "band found", x.is_some(), !none),
            }
        }
        "pretrade" => {
            let order = Order {
                coin: text(&args["coin"]).to_string(),
                size: num(&args["size"]),
                limit_px: num(&args["limit_px"]),
                reduce_only: args["reduce_only"].as_bool().unwrap(),
            };
            let (a, m) = (a(), m());
            let (ok, why) = eng.pretrade(&a, m, &order, own_req(&a, m).as_ref());
            t.same(ctx, "allowed", ok, out[0].as_bool().unwrap());
            t.same(ctx, "reason", why.as_str(), text(&out[1]));
        }
        "hedge_ratio" => t.other(ctx, "hedge ratio", eng.hedge_ratio(&a(), m()), out),
        "score" => {
            let i = |k: &str| args[k].as_i64().unwrap_or_else(|| panic!("{k}"));
            let inputs = ScoreInputs {
                hr_now: num(&args["hr_now"]),
                hr_avg7d: num(&args["hr_avg7d"]),
                good_months: i("good_months"),
                forced_unwinds_12m: i("forced_unwinds_12m"),
                forced_unwinds_older: i("forced_unwinds_older"),
                defaults: i("defaults"),
                linked_months: i("linked_months"),
                linked_liqs_12m: i("linked_liqs_12m"),
                linked_fills: i("linked_fills"),
                linked_volume: num(&args["linked_volume"]),
                kyb: args["kyb"].as_bool().unwrap(),
                exposure_share: num(&args["exposure_share"]),
            };
            t.same(ctx, "score", rating::score(&inputs), out.as_i64().unwrap());
        }
        "tier_of" => {
            let tier = rating::tier_of(
                args["score"].as_i64().unwrap(),
                args["kyb"].as_bool().unwrap(),
            );
            t.same(ctx, "tier", tier.as_str(), text(out));
        }
        "shock" => {
            let s = eng.shock(&a(), m(), text(&args["g"]));
            t.other(ctx, "S*", s.s_star, &out[0]);
            t.other(ctx, "volatility factor", s.f, &out[1]);
            t.other(ctx, "liquidity factor", s.ell, &out[2]);
        }
        "unwind_hours" => t.other(
            ctx,
            "hours",
            eng.unwind_hours(&a(), m(), text(&args["g"])),
            out,
        ),
        "groups" => {
            let want: Vec<&str> = out.as_array().unwrap().iter().map(text).collect();
            t.same(
                ctx,
                "groups",
                eng.groups(&a()),
                want.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            );
        }
        "equity_mark" => t.dollars(ctx, "equity", eng.equity_mark(&a(), m()), out),
        "equity_allow" => t.dollars(ctx, "allowance equity", eng.equity_allow(&a(), m()), out),
        "post_trade" => {
            let (after, fee) = eng.post_trade(
                &a(),
                m(),
                text(&args["coin"]),
                num(&args["size"]),
                num(&args["fill"]),
            );
            account_matches(t, ctx, &after, &out[0]);
            t.dollars(ctx, "fee", fee, &out[1]);
        }
        "worst_fill" => {
            let fill = pretrade::worst_fill(
                num(&args["size"]),
                num(&args["limit_px"]),
                num(&args["mark"]),
            );
            t.other(ctx, "fill", fill, out);
        }
        "net_units" => {
            let skip: BTreeSet<String> = args["skip"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| text(s).to_string())
                .collect();
            let n = eng.net_units(&a(), m(), text(&args["g"]), Some(&skip));
            t.other(ctx, "net units", n, out);
        }
        "equity_at" => {
            let e = eng.equity_at(&a(), m(), text(&args["g"]), num(&args["x"]));
            t.dollars(ctx, "equity", e, out);
        }
        "hl_ratio" => {
            let moves: Option<BTreeMap<String, f64>> = args["moves"]
                .as_object()
                .map(|o| o.iter().map(|(k, v)| (k.clone(), num(v))).collect());
            t.other(
                ctx,
                "margin ratio",
                eng.hl_ratio(&a(), m(), moves.as_ref()),
                out,
            );
        }
        "hl_keep" => t.dollars(ctx, "keep", eng.hl_keep(&a(), m()), out),
        "mm" => t.dollars(
            ctx,
            "maintenance margin",
            eng.mm(text(&args["coin"]), num(&args["notional"])),
            out,
        ),
        "credit_limit" => {
            let tier: ClientTier = serde_json::from_value(args["tier"].clone()).unwrap();
            t.dollars(
                ctx,
                "limit",
                eng.credit_limit(tier, args["good_months"].as_i64().unwrap()),
                out,
            );
        }
        "base_rate" => t.other(ctx, "base rate", eng.params.base_rate(num(&args["u"])), out),
        "thinnest_allowed" => {
            // 13.6: the allowed coin with the least Hyperliquid volume (the first, if two tie).
            let thin = eng.coins.iter().filter(|c| c.allowed).reduce(|a, b| {
                if b.adv30_usd < a.adv30_usd {
                    b
                } else {
                    a
                }
            });
            t.same(ctx, "thinnest coin", thin.unwrap().name.as_str(), text(out));
        }
        "push_cost" => {
            // 13.6: the buying needed to push spot by `pump`, by the square-root rule.
            let c = eng.coin(text(&args["coin"]));
            let sig_day = c.params.vol_ref / 365f64.sqrt();
            let pump = num(&args["pump"]);
            t.dollars(
                ctx,
                "buying needed",
                c.spot24h_usd * (pump / sig_day) * (pump / sig_day),
                out,
            );
        }
        other => panic!("{ctx}: no comparison for method {other}"),
    }
}

/// The reference's `G` with a case's overrides (only the replay options of 13.1 are ever changed).
fn engine_for(base: &Engine, params: &Value) -> Engine {
    let mut eng = base.clone();
    for (k, v) in params.as_object().unwrap() {
        match k.as_str() {
            "replay_weight" => eng.params.replay_weight = num(v),
            "replay_cap_2S" => eng.params.replay_cap_2s = v.as_bool().unwrap(),
            "ext_weight" => eng.params.ext_weight = num(v),
            other => panic!("no override for parameter {other}"),
        }
    }
    eng
}

#[test]
fn every_reference_case_matches() {
    let file: Value = serde_json::from_str(CASES).expect("reference_cases.json parses");
    let markets: Vec<Market> = file["markets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| serde_json::from_value(m.clone()).unwrap())
        .collect();
    let base = Engine::v0();
    let mut by_section: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut all = Tally::default();
    for case in file["cases"].as_array().unwrap() {
        let params = &case["params"];
        let eng = if params.as_object().unwrap().is_empty() {
            None
        } else {
            Some(engine_for(&base, params))
        };
        let before = all.failures.len();
        run_case(&mut all, eng.as_ref().unwrap_or(&base), &markets, case);
        let entry = by_section
            .entry(text(&case["section"]).to_string())
            .or_default();
        entry.0 += 1;
        entry.1 += usize::from(all.failures.len() > before);
    }
    println!("reference cases from Python {}:", text(&file["python"]));
    for (section, (n, bad)) in &by_section {
        println!("  {section:32} {n:4} cases, {bad} not matching");
    }
    println!(
        "  {} numbers compared, {} identical to the last bit; largest difference ${:.2e} on dollar amounts, {:.2e} on \
         other numbers; {} exact comparisons (names, states, keys, reasons, steps)",
        all.numbers, all.bit_exact, all.max_dollar_diff, all.max_other_diff, all.exact
    );
    if !all.failures.is_empty() {
        let shown: Vec<&str> = all.failures.iter().take(40).map(String::as_str).collect();
        panic!(
            "{} mismatches with the reference, first {}:\n{}",
            all.failures.len(),
            shown.len(),
            shown.join("\n")
        );
    }
}
