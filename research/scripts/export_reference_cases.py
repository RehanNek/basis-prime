"""Write every worked example (RISK_ENGINE.md 13) and every property-check case (14.2) of the reference
engine, inputs and outputs, to JSON, for the Rust port's golden tests (risk/risk-core/tests).

    /opt/anaconda3/bin/python3 -I research/scripts/export_reference_cases.py research/data/universe_v0.json \
        research/data/replays_v0.json research/data/reference_cases.json

Run it with Python 3.11 (the build Mac's /opt/anaconda3/bin/python3 is 3.11.7). Python 3.12 changed sum() of
floats to a compensated sum, which changes last bits, and the Rust port adds left to right as 3.11 does. On
any other version the script warns, and the golden tests then match within $1 but not to the bit.

It does not change the reference's logic:
- It loads the engine with risk_engine_ref.load and wraps the engine's public methods on that one
  instance. A wrapper records a call only when the examples or the tests make it, not when the engine
  calls itself, with its inputs (encoded before the call) and its result.
- It then runs risk_engine_examples.py exactly as `risk_engine_ref.py ... examples` and `... tests` do,
  with their printout discarded, and stops if any of the property checks fails.
- A few extra cases, marked "extra", reach paths the examples don't: money in flight (moving with its
  token, or overdue), the rest of the book, USDT, ETH and wNEAR, TWAP gains, an allowance pi below the mark
  one, a busy pool, hysteresis, the margin-call clock, reduce-only orders, a coin outside the universe,
  and the deleveraging plan's other steps (its hedged-pair steps are checked to keep both legs equal).

Format notes:
- Account maps keep their dict order, which sets the order of sums and of scenarios, so they are written
  as lists of [key, value] pairs. So are the credit bounds, whose order breaks ties.
- JSON has no infinity: inf and nan are written as the strings "inf", "-inf" and "nan".
- Markets are stored once, in "markets", and cases refer to them by index.
- "params" lists the global parameters (risk_engine_ref.G) that differ from their defaults for that case.
- "printout" is what `risk_engine_ref.py ... examples` prints, line by line (risk/backtest prints the same
  from Rust and compares).
"""
import contextlib
import inspect
import io
import json
import math
import os
import sys
from dataclasses import replace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # our own scripts only
import risk_engine_ref as R          # noqa: E402  (the same module instance the examples use)
import risk_engine_examples as ex    # noqa: E402

HERE = os.path.abspath(__file__)
EXAMPLES = os.path.abspath(ex.__file__)
DEFAULT_G = dict(R.G)

# The part of RISK_ENGINE.md that each function of risk_engine_examples.py produces.
SECTIONS = {"ex1": "13.1-13.3", "ex2": "13.4", "ex7": "13.5", "ex3": "13.6", "ex_options": "13.1 (options)",
            "ex5": "13.7", "ex6": "13.8", "tests": "14.2", "extra": "extra (not in RISK_ENGINE.md)"}

# Engine methods whose calls are recorded.
METHODS = ["requirement", "borrow_allowance", "withdraw_allowance", "credit_failures", "withdraw_intent",
           "state", "topup", "deleverage_plan", "band", "pretrade", "hedge_ratio", "score", "tier_of",
           "shock", "unwind_hours", "groups", "equity_mark", "equity_allow", "equity_at", "hl_ratio",
           "hl_keep", "mm", "credit_limit", "post_trade", "worst_fill", "net_units"]


def num(x):
    """A number as JSON can hold it: infinity and nan become strings."""
    if isinstance(x, float) and not math.isfinite(x):
        return "nan" if x != x else ("inf" if x > 0 else "-inf")
    return x


def pairs(d):
    return [[k, num(v)] for k, v in d.items()]


def obj(d):
    return {k: num(v) for k, v in d.items()}


def acct(a):
    return {"near": pairs(a.near), "hl_cash": num(a.hl_cash), "perps": pairs(a.perps), "entry": pairs(a.entry),
            "debt": num(a.debt), "tier": a.tier,
            "inflight": [[t, num(u), bool(late)] for t, u, late in a.inflight],
            "orders": [[c, num(s), num(p)] for c, s, p in a.orders]}


def market(m):
    return {"px": obj(m.px), "mark": obj(m.mark), "twap": obj(m.twap), "wrap": obj(m.wrap), "volf": obj(m.volf),
            "funding": obj(m.funding), "util": num(m.util), "pool_capital": num(m.pool_capital),
            "pool_loans": num(m.pool_loans), "book": obj(m.book), "frozen": sorted(m.frozen),
            "wrap_allow": obj(m.wrap_allow)}


def detail(d):
    if d is None:
        return None
    liq = d["liq"]
    return {"near": num(d["near"]), "near_cost": num(d["near_cost"]), "inflight": num(d["inflight"]),
            "hl_eq": num(d["hl_eq"]),
            "hl_cost": num(d["hl_cost"]), "interest": num(d["interest"]), "funding": num(d["funding"]),
            "stage": d["stage"], "liq": None if not liq else [liq[0]] + [num(x) for x in liq[1:]]}


def requirement_out(eng, req):
    return {"E": num(req["E"]), "MR": num(req["MR"]), "IM": num(req["IM"]), "normal": num(req["normal"]),
            "extreme": num(req["extreme"]), "replay": num(req["replay"]),
            "top": [[name, num(x)] for name, x in eng.top_risks(req, 5)],
            "rows": [{"name": r["sc"].name, "kind": r["sc"].kind, "loss": num(r["loss"]), "rate": num(r["rate"]),
                      "e_after": num(r["e_after"]), "det": detail(r["det"])} for r in req["rows"]]}


def same_requirement(r1, r2):
    """True if two requirement results agree exactly (so the Rust side can recompute the one passed in)."""
    keys = ("E", "MR", "IM", "normal", "extreme", "replay")
    return all(r1[k] == r2[k] for k in keys) and [(r["sc"].name, r["loss"], r["rate"]) for r in r1["rows"]] == \
        [(r["sc"].name, r["loss"], r["rate"]) for r in r2["rows"]]


class Recorder:
    def __init__(self, eng):
        self.eng = eng
        self.cases = []
        self.markets = []
        self.market_ids = {}
        self.depth = 0
        for name in METHODS:
            self.wrap(name)

    def market_id(self, m):
        enc = market(m)
        key = json.dumps(enc, sort_keys=True)
        if key not in self.market_ids:
            self.market_ids[key] = len(self.markets)
            self.markets.append(enc)
        return self.market_ids[key]

    @staticmethod
    def source():
        """(section function, line): the example or test function that made the call, and the line in the
        examples file (or in this file, for the extras) closest to the call."""
        f, func, line = sys._getframe(2), None, None
        while f is not None:
            path = os.path.abspath(f.f_code.co_filename)
            if path == EXAMPLES:
                line = line or f.f_lineno
                if f.f_code.co_name in SECTIONS:
                    func = f.f_code.co_name
            elif path == HERE and f.f_code.co_name.startswith("extra"):
                return "extra", line or f.f_lineno
            f = f.f_back
        if func is None:
            raise RuntimeError("a recorded call came from outside the examples, the tests and the extras")
        return func, line

    def band_fn(self, f):
        """Describe a band's function by what it computes. Only the shapes used by the examples and the
        extras are known; anything else stops the export."""
        cells = dict(zip(f.__code__.co_freevars, (c.cell_contents for c in f.__closure__ or ())))
        consts = f.__code__.co_consts
        if f.__qualname__ == "ex1.<locals>.<lambda>" and "BTC" in consts:
            return {"fn": "hl_ratio_mark_move", "coin": "BTC", "account": acct(cells["b"]),
                    "market": self.market_id(cells["m"])}
        if f.__qualname__ == "ex1.<locals>.f_wrap.<locals>.f" and "nBTC" in consts:
            return {"fn": "equity_minus_k_mr_wrap", "token": "nBTC", "k": num(cells["k"]), "account": acct(cells["b"]),
                    "market": self.market_id(cells["m"])}
        if f.__qualname__ == "band_hl_ratio.<locals>.f":
            return {"fn": "hl_ratio_mark_move", "coin": cells["coin"], "account": acct(cells["b"]),
                    "market": self.market_id(cells["m"])}
        if f.__qualname__ == "band_equity_coin.<locals>.f":
            return {"fn": "equity_minus_k_mr_coin", "coin": cells["coin"], "k": num(cells["k"]),
                    "account": acct(cells["b"]), "market": self.market_id(cells["m"])}
        raise ValueError(f"unknown band function {f.__qualname__}")

    def encode_args(self, fn, args, kwargs):
        bound = inspect.signature(fn).bind(*args, **kwargs)
        bound.apply_defaults()
        out = {}
        for k, v in bound.arguments.items():
            if isinstance(v, R.Engine):          # hedge_ratio(eng, a, m) is a static method
                continue
            if isinstance(v, R.Account):
                out[k] = acct(v)
            elif isinstance(v, R.Market):
                out[k] = self.market_id(v)
            elif k == "req":
                out[k] = None if v is None else {"E": num(v["E"]), "MR": num(v["MR"]), "IM": num(v["IM"])}
            elif k == "f":
                out[k] = self.band_fn(v)
            elif k == "moves":
                out[k] = None if v is None else obj(v)
            elif isinstance(v, (frozenset, set)):
                out[k] = sorted(v)               # sets have no order of their own
            elif isinstance(v, (list, tuple)):
                out[k] = [num(x) for x in v]
            else:
                out[k] = num(v)
        return out, bound.arguments

    def encode_out(self, name, out):
        if name == "requirement":
            return requirement_out(self.eng, out)
        if name == "borrow_allowance":
            w, key, bounds = out
            return {"w": num(w), "key": key, "bounds": pairs(bounds)}
        if name in ("withdraw_allowance", "withdraw_intent", "pretrade"):
            return [num(out[0]), out[1]]
        if name == "state":
            st, action, ratio, breach = out
            return [st, action, num(ratio), breach]
        if name == "deleverage_plan":
            steps, after = out
            return {"steps": steps, "after": acct(after)}
        if name == "post_trade":
            after, fee = out
            return [acct(after), num(fee)]
        if name == "shock":
            return [num(x) for x in out]
        if name in ("credit_failures", "groups"):
            return list(out)
        return num(out)

    def wrap(self, name):
        orig = getattr(self.eng, name)
        rec = self

        def wrapper(*args, **kwargs):
            if rec.depth:                      # the engine calling itself: not a case
                return orig(*args, **kwargs)
            func, line = rec.source()
            params = {k: num(v) for k, v in R.G.items() if DEFAULT_G[k] != v}
            enc_args, bound = rec.encode_args(orig, args, kwargs)
            rec.depth += 1
            try:
                out = orig(*args, **kwargs)
                req = bound.get("req")
                if req is not None:            # was the requirement passed in this account's own?
                    own = same_requirement(req, rec.eng.requirement(bound["a"], bound["m"]))
                    enc_args["req"]["own"] = own
                    if not own and name != "state":
                        raise RuntimeError(f"{name} at {func}:{line} got another account's requirement")
                enc_out = rec.encode_out(name, out)
            finally:
                rec.depth -= 1
            rec.cases.append({"id": len(rec.cases), "src": func, "section": SECTIONS[func], "line": line,
                              "method": name, "params": params, "args": enc_args, "out": enc_out})
            return out

        setattr(self.eng, name, wrapper)

    def add(self, func, method, args, out):
        """A case that is not an engine call (the rate curve; the square-root rule of 13.6)."""
        self.cases.append({"id": len(self.cases), "src": func, "section": SECTIONS[func], "line": None,
                           "method": method, "params": {}, "args": args, "out": num(out)})


# ---------------- extras: paths the worked examples and the 24 checks don't reach ----------------
def band_hl_ratio(eng, b, m, coin):
    def f(x):
        return eng.hl_ratio(b, replace(m, mark={**m.mark, coin: m.mark[coin] * (1 + x)}))
    return f


def band_equity_coin(eng, b, m, coin, k):
    """Mark equity minus k x MR as one coin's price moves (the bands of RISK_ENGINE.md 8.3 and Appendix A)."""
    def f(x):
        m2 = replace(m, px={**m.px, coin: m.px[coin] * (1 + x)},
                     mark={**m.mark, **({coin: m.mark[coin] * (1 + x)} if coin in m.mark else {})})
        return eng.equity_at(b, m, coin, x) - k * eng.requirement(b, m2)["MR"]
    return f


def extras_markets(eng):
    m0 = ex.market(eng)
    busy = replace(
        m0, px={**m0.px, "ETH": 2_338.6}, mark={**m0.mark, "ETH": 2_352.5, "NEAR": 3.956, "SOL": 93.2},
        twap={**m0.twap, "ETH": 2_291.0, "NEAR": 3.90, "SOL": 91.5},
        wrap={**m0.wrap, "ETH.b": 0.985, "USDT": 0.998}, volf={**m0.volf, "ETH": 1.6, "SOL": 0.7, "NEAR": 3.1},
        funding={**m0.funding, "SOL": -0.4}, util=0.86, pool_capital=3_000_000.0, pool_loans=2_580_000.0,
        book={"ETH": 4e7, "ETH.b": 1.5e5, "NEAR": 2e6, "wNEAR": 5e5, "SOL": 3e6})
    return m0, busy


def extra_mixed_book(eng):
    """Both venues, three coins, money in flight, a slipped ETH and USDT, a busy pool, a Watch-tier loan."""
    m0, busy = extras_markets(eng)
    a = R.Account(near={"USDC": 20_000.0, "USDT": 30_000.0, "ETH.b": 12.0, "wNEAR": 9_000.0}, hl_cash=60_000.0,
                  perps={"ETH": -15.0, "NEAR": -6_000.0, "SOL": 400.0, "BTC": 0.0},
                  entry={"ETH": 2_250.0, "NEAR": 4.1, "SOL": 95.0}, debt=25_000.0, tier="WATCH",
                  inflight=[("USDC", 5_000.0, False), ("nBTC", 0.01, True), ("USDT", 1_000.0, False)])
    low = {"ETH.b": 0.95, "USDT": 0.99}           # pi_allow below the mark pi (3.3)
    for m in (busy, replace(busy, frozen=frozenset({"ETH.b"})), replace(busy, wrap_allow=low),
              replace(busy, frozen=frozenset({"ETH.b"}), wrap_allow=low)):
        req = eng.requirement(a, m)
        eng.equity_mark(a, m)
        eng.equity_allow(a, m)
        eng.groups(a)
        for g in eng.groups(a):
            eng.shock(a, m, g)
            eng.unwind_hours(a, m, g)
        eng.hedge_ratio(eng, a, m)
        eng.hl_ratio(a, m)
        eng.hl_ratio(a, m, {"SOL": -0.2, "ETH": 0.1})
        eng.hl_keep(a, m)
        eng.borrow_allowance(a, m, req, good_months=3, score=520)
        eng.borrow_allowance(a, m, score=440)
        eng.withdraw_allowance(a, m)
        eng.credit_failures(a, m)
        eng.state(a, m, req)
        eng.state(a, m, req, margin_call_age_h=5.0, prev="WATCH")
    m = busy
    eng.withdraw_intent(a, m, token="USDT", units=10_000.0)
    eng.withdraw_intent(a, m, token="wNEAR", units=1e9)
    eng.withdraw_intent(a, m, to_hl=5_000.0)
    eng.withdraw_intent(a, m, to_hl=50_000.0)
    eng.withdraw_intent(a, m, hl_cash=10_000.0)
    eng.withdraw_intent(a, m, hl_cash=55_000.0)
    eng.pretrade(a, m, "SOL", -100.0, 92.0, reduce_only=True)
    eng.pretrade(a, m, "SOL", -900.0, 92.0, reduce_only=True)
    eng.pretrade(a, m, "ETH", 5.0, 2_350.0)
    eng.pretrade(a, m, "ETH", -40.0, 2_330.0)
    eng.pretrade(a, m, "NEAR", 1_000.0, 4.5)
    eng.pretrade(a, m, "BTC", 0.05, 78_500.0)
    eng.pretrade(a, m, "DOGE", 9e6, 0.0747)
    eng.pretrade(a, m, "LTC", 5_000.0, 54.6)
    eng.pretrade(replace(a, debt=0.0), m, "SOL", 1_000.0, 93.0)
    eng.pretrade(a, m, "XMR", 1.0, 1.0)            # not in the universe at all
    eng.topup(a, m)
    eng.band(band_hl_ratio(eng, a, m, "SOL"), 0.6, -0.9, 0.0)
    eng.band(band_hl_ratio(eng, a, m, "SOL"), 5.0, 0.0, 0.05)
    stressed = replace(a, debt=140_000.0)
    rs = eng.requirement(stressed, m)
    eng.state(stressed, m, rs)
    eng.deleverage_plan(stressed, m)


def extra_small_books(eng):
    """Books with nothing at risk, a wrapper with no hedge, unhedged perps, a thin coin, and the states'
    hysteresis and margin-call clock."""
    m0, busy = extras_markets(eng)
    P = m0.px["BTC"]
    cash = R.Account(near={"USDC": 50_000.0}, debt=10_000.0)
    rc = eng.requirement(cash, m0)
    eng.state(cash, m0, rc)
    eng.borrow_allowance(cash, m0, rc)
    eng.withdraw_allowance(cash, m0)
    eng.deleverage_plan(cash, m0)
    eng.topup(cash, m0)
    slipped = replace(m0, wrap={**m0.wrap, "nBTC": 0.7})
    wrapped = R.Account(near={"nBTC": 0.5}, hl_cash=8_000.0, debt=30_000.0)
    rw = eng.requirement(wrapped, slipped)
    eng.state(wrapped, slipped, rw)
    eng.deleverage_plan(wrapped, slipped)
    crash = replace(m0, px={**m0.px, "BTC": P * 0.93, "DOGE": 0.0661}, mark={**m0.mark, "BTC": P * 0.93, "DOGE": 0.0665},
                    volf={**m0.volf, "BTC": 1.8, "DOGE": 2.2})
    perps = R.Account(near={"USDC": 0.0}, hl_cash=60_000.0, perps={"BTC": 1.5, "DOGE": -400_000.0},
                      entry={"BTC": 80_000.0, "DOGE": 0.07}, debt=40_000.0, tier="PREFERRED")
    rp = eng.requirement(perps, crash)
    eng.state(perps, crash, rp)
    eng.topup(perps, crash)
    eng.deleverage_plan(perps, crash)
    # A hedged ETH carry after ETH.b slips 3%. Its hedged-pair steps meet 1Click's hourly capacity ($50k of ETH),
    # and each must still sell as much ETH as it buys back (8.4), so ETH's net units never move. Before the fix, the
    # first step bought back 48.5 ETH of the short and sold 22.3 ETH.b.
    eth = R.Account(near={"ETH.b": 200.0}, hl_cash=120_000.0, perps={"ETH": -200.0}, entry={"ETH": m0.px["ETH"]},
                    debt=380_000.0)
    m97 = replace(m0, wrap={**m0.wrap, "ETH.b": 0.97})
    before, pairs_seen = eth, 0
    for k in (1, 2, 3):
        steps, after = eng.deleverage_plan(eth, m97, max_steps=k)
        if len(steps) < k:
            break
        if steps[-1].startswith("pair "):
            pairs_seen += 1
            moved = eng.net_units(after, m97, "ETH") - eng.net_units(before, m97, "ETH")
            if abs(moved) > 1e-9:
                raise SystemExit(f"plan step {k} ({steps[-1]}) moved ETH's net units by {moved}")
        before = after
    if not pairs_seen:
        raise SystemExit("the ETH.b case no longer has a hedged-pair step to check")
    thin = R.Account(near={"USDC": 3_000_000.0}, hl_cash=500_000.0, perps={"LTC": 2_000_000.0 / m0.px["LTC"]},
                     entry={"LTC": m0.px["LTC"]}, debt=1.0)
    rt = eng.requirement(thin, m0)
    eng.shock(thin, m0, "LTC")
    eng.borrow_allowance(thin, m0, rt)
    q = 100_000 / P
    b = R.Account(near={"nBTC": q}, hl_cash=35_000, perps={"BTC": -q}, entry={"BTC": P}, debt=94_500.0)
    # 0.8357, 0.7955 and 0.7609 put equity 2.5% above IM, MR and 0.8 x MR: inside the 2% hysteresis band
    for ratio in (0.8357, 0.80, 0.7955, 0.79, 0.7609, 0.74):
        m = replace(m0, wrap={**m0.wrap, "nBTC": ratio})
        r = eng.requirement(b, m)
        for prev in (None, "HEALTHY", "WATCH", "MARGIN_CALL", "DELEVERAGE"):
            for age in (0.0, 3.9, 4.0):
                eng.state(b, m, r, margin_call_age_h=age, prev=prev)
    eng.band(band_equity_coin(eng, b, m0, "BTC", 1.25), 0.0, 0.0, 3.0)
    eng.band(band_equity_coin(eng, b, m0, "BTC", 1.0), 0.0, 0.0, 3.0)
    eng.equity_at(b, m0, "BTC", 0.1)
    eng.equity_at(b, m0, "BTC", -0.25)
    for tier in ("PREFERRED", "STANDARD", "WATCH"):
        for months in (0, 1, 6, 30):
            eng.credit_limit(tier, months)
    for kw in (dict(hr_now=0.5, hr_avg7d=0.9, exposure_share=0.3, good_months=14, forced_unwinds_12m=1,
                    forced_unwinds_older=2, linked_liqs_12m=4),
               dict(hr_now=0.85, hr_avg7d=0.8, exposure_share=0.25, linked_months=6, linked_fills=50,
                    linked_volume=1e6, kyb=True),
               dict(hr_now=0.29, hr_avg7d=0.95, exposure_share=0.1, good_months=3)):
        s = eng.score(**kw)
        eng.tier_of(s, kw.get("kyb", False))
        eng.tier_of(s, True)


def extra_in_transit(eng):
    """Money in transit (4.8) takes each scenario's moves and depegs like the same token held, at 98%; overdue, it
    counts as nothing. A transfer of a coin the account doesn't otherwise hold brings that coin's scenarios."""
    m0, busy = extras_markets(eng)
    P = m0.px["BTC"]
    q = 100_000 / P
    only = R.Account(near={"USDC": 60_000.0}, inflight=[("nBTC", 50_000 / P, False)], debt=10_000.0)
    hedge = R.Account(near={"nBTC": 0.5 * q}, hl_cash=35_000.0, perps={"BTC": -q}, entry={"BTC": P}, debt=60_000.0,
                      inflight=[("nBTC", 0.5 * q, False), ("wNEAR", 5_000.0, False), ("ETH.b", 3.0, True),
                                ("nBTC", 0.01, False)])
    for a in (only, hedge):
        for m in (m0, busy):
            req = eng.requirement(a, m)
            eng.equity_mark(a, m)
            eng.equity_allow(a, m)
            eng.borrow_allowance(a, m, req)
            eng.state(a, m, req)
    eng.deleverage_plan(hedge, replace(m0, wrap={**m0.wrap, "nBTC": 0.8}), max_steps=6)
    eng.topup(hedge, m0)


def main(univ_path, replay_path, out_path):
    if sys.version_info[:2] != (3, 11):
        print(f"warning: Python {sys.version.split()[0]}, not 3.11: sums differ in the last bits (see the header)",
              file=sys.stderr)
    eng = R.load(univ_path, replay_path)
    rec = Recorder(eng)
    printout = io.StringIO()
    with contextlib.redirect_stdout(printout):
        ex.main(eng, "examples")
    with contextlib.redirect_stdout(io.StringIO()):
        fails = ex.tests(eng)
    if fails:
        raise SystemExit(f"{fails} of the reference's property checks failed; nothing written")
    extra_mixed_book(eng)
    extra_small_books(eng)
    extra_in_transit(eng)
    for u in (0.0, 0.3, 0.6, 0.8, 0.85, 0.9, 1.0, 1.2, -0.1):
        rec.add("extra", "base_rate", {"u": u}, R.base_rate(u))
    m = ex.market(eng)
    thin = min((c for c, p in eng.c.items() if p["allowed"]), key=lambda c: eng.c[c]["adv30_usd"])
    rec.add("ex3", "thinnest_allowed", {}, thin)
    rec.add("ex1", "base_rate", {"u": m.util}, R.base_rate(m.util))
    p = eng.c[thin]
    sig_day = p["params"]["vol_ref"] / math.sqrt(365)
    for pump in (0.10, 0.30):        # 13.6: the buying needed to push spot by `pump`, by the square-root rule
        rec.add("ex3", "push_cost", {"coin": thin, "pump": pump}, p["spot24h_usd"] * (pump / sig_day) ** 2)
    out = {"about": "Inputs and outputs of risk_engine_ref.py on every worked example (RISK_ENGINE.md 13), every "
                    "property check (14.2) and a few extras; written by export_reference_cases.py",
           "python": sys.version.split()[0], "universe": os.path.basename(univ_path),
           "replays": os.path.basename(replay_path), "sections": SECTIONS,
           "markets": rec.markets, "cases": rec.cases,
           "printout": printout.getvalue().split("\n")}
    with open(out_path, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
        fh.write("\n")
    counts = {}
    for c in rec.cases:
        counts[c["src"]] = counts.get(c["src"], 0) + 1
    print(f"wrote {len(rec.cases)} cases and {len(rec.markets)} markets to {out_path}: {counts}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2], sys.argv[3])
