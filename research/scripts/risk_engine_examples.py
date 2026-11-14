"""Worked examples and property tests for risk_engine_ref.py (RISK_ENGINE.md section 13 and 14).

Run through risk_engine_ref.py:  python3 -I risk_engine_ref.py <universe> <replays> examples|tests
"""
import math
from dataclasses import replace

from risk_engine_ref import G, TIERS, TOKENS, Account, Market, base_rate  # noqa: F401


def market(eng, **over):
    px = {c: p["price"] for c, p in eng.c.items()}
    m = Market(px=dict(px), mark=dict(px), twap=dict(px), wrap={"nBTC": 1.0, "ETH.b": 1.0, "USDT": 1.0},
               volf={c: 1.0 for c in px},
               funding={c: p["funding"]["mean_30d_apr"] for c, p in eng.c.items()})
    for k, v in over.items():
        setattr(m, k, v)
    return m


def usd(x):
    return f"${x:,.0f}"


def show_req(eng, a, m, title):
    req = eng.requirement(a, m)
    allow, key, _ = eng.borrow_allowance(a, m, req)
    st, action, ratio, breach = eng.state(a, m, req)
    print(f"\n### {title}")
    print(f"equity {usd(req['E'])} | allowance equity {usd(eng.equity_allow(a, m))} | MR {usd(req['MR'])} | "
          f"IM {usd(req['IM'])} | state {st} / action {action} | HL margin ratio {ratio:.1%}")
    print(f"worst normal {usd(req['normal'])} | worst extreme {usd(req['extreme'])} (half: "
          f"{usd(0.5 * req['extreme'])}) | worst replay {usd(req['replay'])}")
    for name, loss in eng.top_risks(req, 5):
        print(f"   top risk: {usd(loss):>10}  {name}")
    print(f"borrow allowance {usd(allow)} (binding: {key})")
    return req, allow


def ex1(eng):
    m = market(eng)
    P = m.px["BTC"]
    q = 100_000 / P
    a = Account(near={"nBTC": q}, hl_cash=35_000, perps={"BTC": -q}, entry={"BTC": P})
    print(f"\n## Example 1: hedged BTC carry. BTC {usd(P)}; {q:.4f} nBTC + {q:.4f} BTC short, $35k margin")
    req, allow = show_req(eng, a, m, "Standard tier, no loan yet")
    for r in sorted(req["rows"], key=lambda r: -eng.weight(r["sc"].kind) * r["loss"])[:8]:
        d = r["det"]
        print(f"   {r['sc'].kind:8} {r['sc'].name:45} loss {usd(r['loss']):>9} weighted "
              f"{usd(eng.weight(r['sc'].kind) * r['loss']):>9} liq={d['liq'][0] if d['liq'] else '-'}")
    _, _, bounds = eng.borrow_allowance(a, m, req)
    cap_stress = min(v for k, v in bounds.items() if k.startswith(("C0", "C1", "C2", "C3")))
    print(f"stress capacity (before tier/limit caps) {usd(cap_stress)}; Standard cap "
          f"{usd(bounds['C4 tier cap'])}; Preferred cap {usd(0.85 * 135_000)}")
    ap = replace(a, tier="PREFERRED")
    allow_p, key_p, _ = eng.borrow_allowance(ap, m)
    print(f"Preferred: {usd(allow_p)} ({key_p}); rates now: Standard "
          f"{base_rate(m.util) + 0.02:.2%}, Preferred {base_rate(m.util) + 0.01:.2%}")
    print("\n### Same hedge, more margin parked on Hyperliquid (extra USDC deposited)")
    for hl in (35_000, 40_000, 45_000, 50_000, 60_000):
        a2 = replace(a, hl_cash=hl)
        r2 = eng.requirement(a2, m)
        w2, k2, _ = eng.borrow_allowance(a2, m, r2)
        w3, k3, _ = eng.borrow_allowance(replace(a2, tier="PREFERRED"), m)
        print(f"   Hyperliquid margin {usd(hl):>8}: equity {usd(r2['E'])}, MR {usd(r2['MR']):>8} "
              f"(top: {eng.top_risks(r2, 1)[0][0][:40]}), Standard line {usd(w2)} ({k2[:14]}), "
              f"Preferred line {usd(w3)} ({k3[:14]})")
    hr = eng.hedge_ratio(eng, a, m)
    print(f"hedge ratio {hr:.2f}; score new client {eng.score(hr, hr)}; with KYB + clean linked HL "
          f"{eng.score(hr, hr, kyb=True, linked_months=8, linked_fills=200, linked_volume=5e6)}")
    # Draw the Standard loan, withdraw it, then run the depeg drill.
    b = replace(a, debt=allow)
    tu = eng.topup(b, m)
    rt = eng.requirement(replace(b, hl_cash=b.hl_cash + tu), m)
    print(f"\nloan drawn: smallest Hyperliquid top-up that takes the liquidation out of the top risks {usd(tu)} "
          f"(MR after: {usd(rt['MR'])})")
    print(f"\n### Loan of {usd(allow)} drawn and withdrawn; nBTC/BTC depeg drill")
    first_dl = None
    for ratio in (1.0, 0.98, 0.95, 0.90, 0.85, 0.80, 0.75, 0.70):
        mm = replace(m, wrap={**m.wrap, "nBTC": ratio})
        r = eng.requirement(b, mm)
        st, action, hlr, _ = eng.state(b, mm, r)
        if st == "DELEVERAGE" and first_dl is None:
            first_dl = ratio
        print(f"   nBTC/BTC {ratio:.2f}: equity {usd(r['E']):>8}  MR {usd(r['MR']):>8}  IM {usd(r['IM']):>8}  "
              f"{st:11} {action}")
    if first_dl:
        mm = replace(m, wrap={**m.wrap, "nBTC": first_dl})
        steps, after = eng.deleverage_plan(b, mm)
        r = eng.requirement(after, mm)
        print(f"\n### Deleverage plan at nBTC/BTC {first_dl:.2f}")
        for s in steps:
            print("   -", s)
        print(f"   after: equity {usd(r['E'])}, MR {usd(r['MR'])}, IM {usd(r['IM'])}, debt {usd(after.debt)}, "
              f"nBTC {after.near.get('nBTC', 0):.4f}, BTC perp {after.perps.get('BTC', 0):.4f}, "
              f"state {eng.state(after, mm, r)[0]}")
    # bands: everything re-evaluated at each trial point
    f_hl = lambda x: eng.hl_ratio(b, replace(m, mark={**m.mark, "BTC": m.mark["BTC"] * (1 + x)}))  # noqa: E731
    up50 = eng.band(f_hl, 0.5, 0.0, 3.0)
    up100 = eng.band(f_hl, 1.0, 0.0, 3.0)

    def f_wrap(k):
        def f(x):
            mm2 = replace(m, wrap={**m.wrap, "nBTC": 1 + x})
            r2 = eng.requirement(b, mm2)
            return r2["E"] - k * r2["MR"]
        return f
    w_im, w_mr, w_dl = (1 + eng.band(f_wrap(k), 0.0, -0.99, 0.0) for k in (1.25, 1.0, 0.8))
    print(f"bands: BTC price where Hyperliquid margin ratio hits 50%: {usd(P * (1 + up50))} ({up50:+.1%}); "
          f"100% (liquidation): {usd(P * (1 + up100))} ({up100:+.1%})")
    print(f"       nBTC/BTC where equity hits IM {w_im:.4f}, MR {w_mr:.4f}, 0.8 x MR {w_dl:.4f}")
    return a, b, m


def ex2(eng, hl_margin=80_000):
    m = market(eng)
    a = Account(near={"USDC": 100_000}, hl_cash=hl_margin,
                perps={"SOL": 150_000 / m.px["SOL"], "ETH": -100_000 / m.px["ETH"],
                       "HYPE": 60_000 / m.px["HYPE"], "kPEPE": 30_000 / m.px["kPEPE"]},
                entry={c: m.px[c] for c in ("SOL", "ETH", "HYPE", "kPEPE")}, tier="STANDARD")
    hr = eng.hedge_ratio(eng, a, m)
    sc = eng.score(hr, hr, kyb=True)
    print(f"   hedge ratio {hr:.2f}; a KYB'd client scores {sc} -> {eng.tier_of(sc, True)} "
          f"(without KYB {eng.score(hr, hr)} -> {eng.tier_of(eng.score(hr, hr))}, starting limit $50,000)")
    print(f"\n## Example 2: directional multi-coin book ($100k USDC on NEAR; Hyperliquid {usd(hl_margin)} margin, "
          "long $150k SOL, short $100k ETH, long $60k HYPE, long $30k kPEPE)")
    for g in eng.groups(a):
        s, f, ell = eng.shock(a, m, g)
        print(f"   {g:6} S {eng.c[g]['params']['S']:.0%} x f {f:.2f} x liquidity {ell:.3f} = {s:.1%}; "
              f"unwind {eng.unwind_hours(a, m, g):.2f} h; client cap {usd(eng.c[g]['params']['client_cap_usd'])}")
    req, allow = show_req(eng, a, m, "Standard tier")
    return a, m


def ex3(eng):
    """Mango-style attempt on the thinnest allow-listed coin."""
    coins = [c for c, p in eng.c.items() if p["allowed"]]
    thin = min(coins, key=lambda c: eng.c[c]["adv30_usd"])
    p = eng.c[thin]
    m = market(eng)
    cap = p["params"]["client_cap_usd"]
    print(f"\n## Example 3: Mango-style attempt on {thin} (thinnest allowed: Hyperliquid volume "
          f"{usd(p['adv30_usd'])}/day, OI {usd(p['oi_usd'])}, spot {usd(p['spot24h_usd'])}/day)")
    print(f"   per-client cap {usd(cap)}; price band {p['params']['price_band']:.0%}")
    a = Account(near={"USDC": 1_000_000}, hl_cash=0, tier="WATCH")
    ok, why = eng.pretrade(a, m, thin, 2 * cap / m.px[thin], m.px[thin] * 1.001)
    print(f"   order for 2x the cap: {ok} ({why})")
    pos = 0.5 * cap
    a = Account(near={"USDC": 700_000}, hl_cash=300_000, perps={thin: pos / m.px[thin]}, entry={thin: m.px[thin]},
                tier="WATCH")    # a new, unverified, directional account scores 550: Watch
    req = eng.requirement(a, m)
    s, f, ell = eng.shock(a, m, thin)
    w0, k0, _ = eng.borrow_allowance(a, m, req)
    grid = max(req["normal"], 0.5 * req["extreme"])
    print(f"   long {usd(pos)} {thin} (half the cap) with $1M equity: shock {s:.0%} (liquidity factor {ell:.2f}); "
          f"grid loss {usd(grid)}; MR {usd(req['MR'])} = {req['MR'] / pos:.0%} of the position, set by "
          f"{eng.top_risks(req, 1)[0][0]}; borrow allowance {usd(w0)} ({k0[:28]})")
    for pump in (0.10, 0.30, 0.50):
        m2 = replace(m, px={**m.px, thin: m.px[thin] * (1 + pump)}, mark={**m.mark, thin: m.mark[thin] * (1 + pump)})
        e_mark = eng.equity_mark(a, m2)
        e_allow = eng.equity_allow(a, m2)
        allow, key, _ = eng.borrow_allowance(a, m2)
        print(f"   price pushed +{pump:.0%} on every source for <1h: paper gain {usd(pos * pump)}; equity "
              f"{usd(e_mark)}, equity for new credit {usd(e_allow)} (TWAP rule removes {usd(e_mark - e_allow)}); "
              f"borrow allowance {usd(allow)} ({key[:28]}) vs {usd(w0)} before the pump")
    sig_day = p["params"]["vol_ref"] / math.sqrt(365)
    for pump in (0.10, 0.30):
        need = p["spot24h_usd"] * (pump / sig_day) ** 2
        print(f"   square-root rule: pushing spot +{pump:.0%} takes about {usd(need)} of buying "
              f"({need / p['spot24h_usd']:.0f} days of spot volume)")


def ex7(eng):
    """Per-coin margin for a plain $100k long or short perp, backed by $100k on Hyperliquid."""
    m = market(eng)
    print("\n## Example 7: requirement for a plain $100k perp, $100k of Hyperliquid margin, a loan outstanding")
    print(f"   {'coin':6} {'S':>4} | {'long: grid':>10} {'with replays':>12} {'driver':34} | "
          f"{'short: grid':>11} {'with replays':>12} {'driver':34}")
    for c, p in eng.c.items():
        if not p["allowed"]:
            continue
        cells = []
        for side in (1, -1):
            a = Account(hl_cash=100_000, perps={c: side * 100_000 / m.px[c]}, entry={c: m.px[c]}, debt=1.0)
            req = eng.requirement(a, m)
            grid = max(req["normal"], 0.5 * req["extreme"])
            cells.append((grid, req["MR"], eng.top_risks(req, 1)[0][0]))
        print(f"   {c:6} {p['params']['S']:>4.0%} | {usd(cells[0][0]):>10} {usd(cells[0][1]):>12} {cells[0][2][:34]:34} | "
              f"{usd(cells[1][0]):>11} {usd(cells[1][1]):>12} {cells[1][2][:34]:34}")


def ex_options(eng):
    """Section 13.1: what the replay choices do to the key numbers."""
    import risk_engine_ref as R
    m = market(eng)
    P = m.px["BTC"]
    q = 100_000 / P
    hedged = Account(near={"nBTC": q}, hl_cash=35_000, perps={"BTC": -q}, entry={"BTC": P})
    btc_long = Account(hl_cash=100_000, perps={"BTC": q}, entry={"BTC": P}, debt=1.0)
    sol_long = Account(hl_cash=100_000, perps={"SOL": 100_000 / m.px["SOL"]}, entry={"SOL": m.px["SOL"]}, debt=1.0)
    sui_short = Account(hl_cash=100_000, perps={"SUI": -100_000 / m.px["SUI"]}, entry={"SUI": m.px["SUI"]}, debt=1.0)
    opts = [("as specified: replays in full", {}),
            ("replays at half weight", {"replay_weight": 0.5}),
            ("replay moves capped at 2S", {"replay_cap_2S": True}),
            ("no replays (grid only)", {"replay_weight": 0.0})]
    print("\n## Options for the replays (section 13.1)")
    print(f"   {'option':32} {'hedged MR':>10} {'Std line':>9} {'Pref line':>10} {'BTC long MR':>12} "
          f"{'SOL long MR':>12} {'SUI short MR':>13}")
    saved = dict(R.G)
    for name, over in opts:
        R.G.update(saved)
        R.G.update(over)
        rh = eng.requirement(hedged, m)
        std = eng.borrow_allowance(hedged, m, rh)[0]
        pref = eng.borrow_allowance(replace(hedged, tier="PREFERRED"), m)[0]
        print(f"   {name:32} {usd(rh['MR']):>10} {usd(std):>9} {usd(pref):>10} "
              f"{usd(eng.requirement(btc_long, m)['MR']):>12} {usd(eng.requirement(sol_long, m)['MR']):>12} "
              f"{usd(eng.requirement(sui_short, m)['MR']):>13}")
    R.G.clear()
    R.G.update(saved)


def ex5(eng, a1, b1, m):
    print("\n## Example 5: pre-trade checks")
    P = m.px["BTC"]
    q = -a1.perps["BTC"]
    ok, why = eng.pretrade(b1, m, "BTC", q, P * 1.002)
    print(f"   Example 1 client with the loan buys back the whole short: {ok} ({why})")
    ok, why = eng.pretrade(b1, m, "BTC", q * 0.25, P * 1.002)
    print(f"   ... buys back a quarter of it: {ok} ({why})")
    ok, why = eng.pretrade(a1, m, "BTC", -0.1 * q, P * 0.95)
    print(f"   limit price 5% below the reference: {ok} ({why})")
    ok, why = eng.pretrade(a1, m, "XMR" if "XMR" in eng.c else "TAO", 1.0, 1.0)
    print(f"   coin outside the allow-list: {ok} ({why})")


def ex6(eng):
    print("\n## Example 6: rating")
    clean = dict(linked_months=8, linked_fills=200, linked_volume=5e6)
    cases = [
        ("new client, hedged book", dict(hr_now=1.0, hr_avg7d=1.0)),
        ("+ KYB", dict(hr_now=1.0, hr_avg7d=1.0, kyb=True)),
        ("+ KYB + 8 months of clean, active linked Hyperliquid history", dict(hr_now=1.0, hr_avg7d=1.0, kyb=True,
                                                                             **clean)),
        ("hedged + clean linked history, no KYB", dict(hr_now=1.0, hr_avg7d=1.0, **clean)),
        ("farming try: all USDC + an old, idle linked address", dict(hr_now=1.0, hr_avg7d=1.0, exposure_share=0.0,
                                                                     linked_months=24)),
        ("new client, directional book", dict(hr_now=0.1, hr_avg7d=0.1)),
        ("directional, 6 good months, KYB", dict(hr_now=0.1, hr_avg7d=0.1, good_months=6, kyb=True)),
        ("hedged, KYB, one forced unwind this year", dict(hr_now=1.0, hr_avg7d=1.0, kyb=True,
                                                          forced_unwinds_12m=1)),
        ("window-dressed: hedged today, directional all week", dict(hr_now=1.0, hr_avg7d=0.2)),
        ("any client after a default", dict(hr_now=1.0, hr_avg7d=1.0, kyb=True, defaults=1)),
    ]
    for name, kw in cases:
        s = eng.score(**kw)
        print(f"   {name:60} score {s:4}  tier {eng.tier_of(s, kw.get('kyb', False))}")


def tests(eng):
    m = market(eng)
    P = m.px["BTC"]
    q = 100_000 / P
    a = Account(near={"nBTC": q}, hl_cash=35_000, perps={"BTC": -q}, entry={"BTC": P})
    fails = 0

    def check(name, cond):
        nonlocal fails
        fails += not cond
        print(f"   [{'ok' if cond else 'FAIL'}] {name}")

    req = eng.requirement(a, m)
    allow, key, _ = eng.borrow_allowance(a, m, req)
    # T1: closed form vs brute force: borrow exactly `allow` and check every constraint directly.
    b = replace(a, debt=allow)
    rb = eng.requirement(b, m)
    e_after = eng.equity_allow(b, m)
    check("T1 at the credit line, equity >= IM (within $1)", e_after >= rb["IM"] - 1)
    check("T1 at the credit line, no pool loss in normal/ADL/replay scenarios",
          all(r["e_after"] >= -1e-6 for r in rb["rows"] if r["sc"].kind != "extreme"))
    check("T1 at the credit line, extreme pool loss <= 5% of the loan",
          all(-r["e_after"] <= 0.05 * allow + 1 for r in rb["rows"] if r["sc"].kind == "extreme"))
    b2 = replace(a, debt=allow + 1000)
    allow2 = eng.borrow_allowance(b2, m)[0]
    check("T2 more debt never raises the allowance", allow2 <= max(0.0, allow - 1000) + 1)
    check("T2 more debt never lowers the requirement", eng.requirement(b2, m)["MR"] >= rb["MR"] - 1e-6)
    thin = replace(a, near={"nBTC": q, "USDC": 25_000}, hl_cash=35_000)
    thick = replace(a, near={"nBTC": q, "USDC": 0}, hl_cash=60_000)
    check("T3 moving USDC to Hyperliquid lowers the requirement when it stops the liquidation",
          eng.requirement(thick, m)["MR"] < eng.requirement(thin, m)["MR"])
    no_loan = replace(a, debt=0.0)
    check("T3b with no loan, withdrawals and trades are not limited by the requirement",
          eng.withdraw_allowance(replace(no_loan, near={**no_loan.near, "USDC": 5_000}), m)[0] == 5_000
          and eng.state(no_loan, m, req)[0] == "HEALTHY")
    big = replace(a, near={"nBTC": 20 * q}, hl_cash=20 * 35_000, perps={"BTC": -20 * q})
    check("T4 a 20x bigger book needs at least 20x the requirement",
          eng.requirement(big, m)["MR"] >= 20 * req["MR"] - 1e-6)
    tid = str(eng.c["BTC"]["hl_margin_table"])
    tiers = sorted(float(t["lowerBound"]) for t in eng.tables.get(tid, {"marginTiers": []})["marginTiers"])
    cont = all(abs(eng.mm("BTC", lb - 1e-3) - eng.mm("BTC", lb + 1e-3)) < 1 for lb in tiers[1:])
    check(f"T5 Hyperliquid maintenance margin is continuous at tier edges {tiers}", cont)
    spot_only = replace(a, perps={}, hl_cash=0)
    check("T6 the hedge lowers the requirement versus spot alone",
          req["MR"] < eng.requirement(spot_only, m)["MR"])
    check("T7 IM = 1.25 x MR", abs(req["IM"] - 1.25 * req["MR"]) < 1e-9)
    m_pump = replace(m, px={**m.px, "BTC": P * 1.05}, mark={**m.mark, "BTC": P * 1.05})
    long_only = replace(a, perps={}, hl_cash=35_000)
    check("T8 the TWAP rule never raises allowance equity",
          eng.equity_allow(long_only, m_pump) <= eng.equity_mark(long_only, m_pump))
    m_calm = replace(m, volf={c: 0.5 for c in m.volf})
    check("T9 calm markets never shrink shocks (factor floored at 1)",
          abs(eng.requirement(a, m_calm)["MR"] - req["MR"]) < 1e-6)
    m_wild = replace(m, volf={c: 2.0 for c in m.volf})
    check("T10 wild markets raise the requirement", eng.requirement(a, m_wild)["MR"] > req["MR"])
    st = [eng.state(b, replace(m, wrap={**m.wrap, "nBTC": r}), eng.requirement(
        b, replace(m, wrap={**m.wrap, "nBTC": r})))[0] for r in (1.0, 0.95, 0.9, 0.85, 0.8, 0.7)]
    order = ["HEALTHY", "WATCH", "MARGIN_CALL", "DELEVERAGE"]
    check(f"T11 states only worsen as nBTC slips: {st}", all(order.index(x) <= order.index(y)
                                                            for x, y in zip(st, st[1:])))
    # T1b: brute force where the tier cap C4 binds (13.1 Preferred) and where C3 binds (13.4 with $200k)
    for name, acct in (("13.1 Preferred", replace(a, tier="PREFERRED")),
                       ("13.4 $200k", Account(near={"USDC": 100_000}, hl_cash=200_000,
                                              perps={"SOL": 150_000 / m.px["SOL"], "ETH": -100_000 / m.px["ETH"],
                                                     "HYPE": 60_000 / m.px["HYPE"], "kPEPE": 30_000 / m.px["kPEPE"]},
                                              entry={c: m.px[c] for c in ("SOL", "ETH", "HYPE", "kPEPE")}))):
        w_, key_, _ = eng.borrow_allowance(acct, m)
        u2 = (m.pool_loans + w_) / m.pool_capital
        m2 = replace(m, util=u2)
        loaded = replace(acct, debt=w_)
        r_ = eng.requirement(loaded, m2)
        ok_im = eng.equity_allow(loaded, m2) >= r_["IM"] - 1
        ok_c2 = all(x["e_after"] >= -1e-6 for x in r_["rows"] if x["sc"].kind != "extreme")
        ok_c3 = all(-x["e_after"] <= 0.05 * w_ + 1 for x in r_["rows"] if x["sc"].kind == "extreme")
        over = replace(acct, debt=w_ + 500)       # the same assets with $500 more of loan taken out
        breaks = bool(eng.credit_failures(replace(over, near={**over.near}), m2))
        check(f"T1b {name}: line ${w_:,.0f} ({key_[:6]}) holds every condition, and $500 more breaks one",
              ok_im and ok_c2 and ok_c3 and breaks)
    cont_all = True
    for tid, tbl in eng.tables.items():
        lbs = sorted(float(t["lowerBound"]) for t in tbl["marginTiers"])
        coin = next((c for c, pp in eng.c.items() if str(pp["hl_margin_table"]) == tid), None)
        if coin:
            cont_all &= all(abs(eng.mm(coin, lb - 1e-3) - eng.mm(coin, lb + 1e-3)) < 1 for lb in lbs[1:])
    check("T5b every margin table in use is continuous at its tier edges", cont_all)
    check("T15 a score below 450 gives no credit (C9)", eng.borrow_allowance(a, m, score=440)[0] == 0)
    # T16: moving USDC from NEAR to Hyperliquid is checked like an outflow, because it can raise MR (13.1): margin that
    # can't survive the 2020 rebound is lost with the backstop. With a $120k Preferred loan the account meets every
    # condition; $10k more on Hyperliquid ($35k -> $45k of margin) leaves it below IM, though its equity is unchanged.
    a16 = replace(a, near={"nBTC": q, "USDC": 10_000}, debt=120_000.0, tier="PREFERRED")
    ok16, why16 = eng.withdraw_intent(a16, m, to_hl=10_000)
    check(f"T16 moving USDC to Hyperliquid is checked like an outflow, and refused when it raises MR past equity "
          f"({why16.split(';')[0]})", not eng.credit_failures(a16, m) and not ok16
          and why16.startswith("equity $25,000 below the initial requirement"))
    # T12: the red-team's squeeze-then-revert book (wNEAR long, NEAR perp short, thin Hyperliquid margin)
    nq = 1_000_000 / m.px["NEAR"]
    sq = Account(near={"wNEAR": nq}, hl_cash=250_000, perps={"NEAR": -nq}, entry={"NEAR": m.px["NEAR"]},
                 tier="PREFERRED")
    w_sq = eng.borrow_allowance(sq, m)[0]
    sq_loaned = replace(sq, debt=w_sq)
    rows = eng.requirement(sq_loaned, m)["rows"]
    worst_rev = min(r["e_after"] for r in rows if r["sc"].kind == "reversal")
    check(f"T12 squeeze-then-revert: at the credit line (${w_sq:,.0f}) the pool loses nothing "
          f"(worst equity after ${worst_rev:,.0f})", worst_rev >= -1e-6)
    # T13: a fill is never booked better than the mark, so a generous limit price creates no equity: a sell with its
    # limit 0.9% above the mark is booked at the mark and only pays the fee; a buy with its limit below, at the mark too
    a13 = replace(a, debt=1.0)
    mark = m.mark["BTC"]
    fill = eng.worst_fill(-0.01, P * 1.009, mark)
    after13, fee13 = eng.post_trade(a13, m, "BTC", -0.01, fill)
    check("T13 a generous limit price is booked at the mark and creates no equity",
          fill == mark and fee13 > 0 and abs(eng.equity_mark(after13, m) - (eng.equity_mark(a13, m) - fee13)) < 1e-6
          and eng.worst_fill(0.01, P * 0.991, mark) == mark)
    # T14: withdrawing Hyperliquid cash must keep the tier cap, not just IM
    b14 = replace(a, debt=allow)
    ok14, why14 = eng.withdraw_intent(b14, m, hl_cash=25_000)
    check(f"T14 a $25k Hyperliquid withdrawal after the full Standard loan is refused ({why14[:60]})", not ok14)
    # T17: freezing a bridged token (3.3) stops new credit against it without moving the account's state, and
    # the token can leave only if the rest of the account carries the loan by itself
    m_fz = replace(m, frozen=frozenset({"nBTC"}))
    rb_fz = eng.requirement(b, m_fz)
    same_state = eng.state(b, m_fz, rb_fz)[:2] == eng.state(b, m, rb)[:2]
    no_new = eng.borrow_allowance(b, m_fz, rb_fz)[0] == 0
    out_hedged, _ = eng.withdraw_intent(b, m_fz, token="nBTC", units=q)
    small = Account(near={"USDC": 100_000, "nBTC": 10_000 / P}, debt=20_000)
    out_small, _ = eng.withdraw_intent(small, m_fz, token="nBTC", units=10_000 / P)
    check("T17 a frozen nBTC adds no new credit and moves no state; it can leave only when the rest of the "
          "account carries the loan", same_state and no_new and not out_hedged and out_small)
    # T18: a hedged pair is unwound with both legs together (8.4), sized once. On an exact ETH hedge that must
    # deleverage, the first step buys back as much of the short as it sells ETH, at most 1Click's hour ($50k).
    eth = Account(near={"ETH.b": 200.0}, hl_cash=120_000.0, perps={"ETH": -200.0}, entry={"ETH": m.px["ETH"]},
                  debt=450_000.0)
    steps18, after18 = eng.deleverage_plan(eth, m, max_steps=1)
    sold18 = (eth.near["ETH.b"] - after18.near["ETH.b"]) * m.px["ETH"]
    check(f"T18 a hedged pair is unwound both legs together ({steps18[0][:38] if steps18 else 'no step'})",
          bool(steps18) and steps18[0].startswith("pair ETH") and sold18 <= 50_000 + 1e-6
          and abs(eng.net_units(after18, m, "ETH") - eng.net_units(eth, m, "ETH")) < 1e-9)
    # T19: for new credit a wrapper counts at pi_allow, the lowest pi of the last hour (3.3). A lower one lowers the
    # credit line, but moves neither the requirement nor the state.
    m19 = replace(m, wrap_allow={"nBTC": 0.95})
    m19_high = replace(m, wrap_allow={"nBTC": 1.05})
    rb19 = eng.requirement(b, m19)
    check("T19 a lower pi_allow lowers the credit line but moves neither MR nor the state; a higher one adds nothing",
          eng.borrow_allowance(a, m19)[0] < allow and rb19["MR"] == rb["MR"]
          and eng.state(b, m19, rb19)[:2] == eng.state(b, m, rb)[:2]
          and eng.borrow_allowance(a, m19_high)[0] == allow)
    # T20: money in transit takes each scenario's moves like the same token held, at 98% (4.8): $50k of nBTC on its
    # way in falls with BTC. Once overdue, it counts as nothing.
    q20 = 50_000 / P
    a20 = Account(near={"USDC": 60_000}, inflight=[("nBTC", q20, False)], debt=10_000)
    down = next((r for r in eng.requirement(a20, m)["rows"] if r["sc"].name == "1.00S (-1,)"), None)
    late = replace(a20, inflight=[("nBTC", q20, True)])
    check("T20 nBTC in transit falls with the scenario (at 98%); once overdue it counts as nothing",
          down is not None and down["loss"] >= 0.98 * eng.token_value("nBTC", q20, m) * eng.shock(a20, m, "BTC")[0]
          and eng.requirement(late, m)["MR"] == eng.requirement(replace(a20, inflight=[]), m)["MR"])
    print(f"   {fails} failures")
    return fails


def main(eng, mode):
    if mode == "tests":
        raise SystemExit(tests(eng))
    a1, b1, m = ex1(eng)
    ex2(eng)
    ex2(eng, hl_margin=200_000)
    ex3(eng)
    ex7(eng)
    ex_options(eng)
    ex5(eng, a1, b1, m)
    ex6(eng)
