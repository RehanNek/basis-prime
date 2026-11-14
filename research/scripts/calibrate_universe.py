"""Calibrate per-coin risk parameters for the v0 allow-list (RISK_ENGINE.md section 5).

Usage: python3 -I calibrate_universe.py <udata_dir> <universe_json> <out_json> [<old_data_dir>]

<old_data_dir> holds the longer Hyperliquid funding files fetched for PLAN.md (BTC, ETH, NEAR since May 2023);
when present, funding stress uses the longest history available.

Inputs come from fetch_universe_data.py (udata_dir) and universe.py (universe_json).
For every coin it measures, from public data only:
- 4h tail move: from each hourly open to the worst low / best high inside the next 4 hours
  (Binance spot 1h since 2019 or listing), quantiles 99% / 99.9% and the worst case. A coin with under a year
  on Binance (HYPE was listed there on 24 Sep 2026) uses Hyperliquid's own 4h candles instead: each candle is
  one 4-hour window, open to low / high
- long-run and last-year volatility, beta and correlation to BTC (hourly log returns)
- Hyperliquid funding: 1y mean, worst 7-day averages both ways (annualised); perp premium tails
- Hyperliquid liquidity: 30-day average daily volume, open interest, spread and visible depth
and turns them into the engine's parameters with the rules in RISK_ENGINE.md section 5.2.
"""
import json
import math
import os
import sys
from datetime import datetime, timezone

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view as swv

UD, UNI, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
OLD = sys.argv[4] if len(sys.argv) > 4 else None
SKIP_LISTING_H = 48              # listing-day prints on Binance are not market moves
uni = json.load(open(UNI))
cand = {c["hl"]: c for c in uni["candidates"]}
tables = {int(k): v for k, v in uni["margin_tables"].items()} if uni.get("margin_tables") else {}
meta = json.load(open(os.path.join(UD, "coins_meta.json")))

ALLOW = ["BTC", "ETH", "ZEC", "SOL", "NEAR", "HYPE", "XRP", "ENA", "PUMP", "WLD", "kPEPE", "UNI", "BNB",
         "SUI", "ONDO", "AAVE", "DOGE", "ARB", "LINK", "AVAX", "ADA", "TRX", "LTC"]
NEXT = ["TAO", "GRAM"]

# ---- rules (RISK_ENGINE.md section 5.2) ----
BTC_S = 0.12                     # BTC normal shock, kept from PLAN.md 6.9
TIER_FLOOR = {1: 0.18, 2: 0.18, 3: 0.25}   # BTC itself is fixed at 12% (the anchor)
YOUNG_DAYS = 730                 # less than 2 years of history -> young-asset floor
YOUNG_FLOOR = 0.30
BASIS_FLOOR = 0.003
HOURS_YEAR = 24 * 365


def tier_of(c):
    if c["hl"] in ("BTC", "ETH"):
        return 1
    return 2 if c["adv30_usd"] >= 100e6 else 3


def arr(rows, i):
    return np.array([float(r[i]) for r in rows])


def excursions(o, h, l, n):
    lo = swv(l, n).min(axis=1)
    hi = swv(h, n).max(axis=1)
    m = len(lo)
    return lo / o[:m] - 1, hi / o[:m] - 1


def roll_mean(x, n):
    c = np.cumsum(np.insert(x, 0, 0.0))
    return (c[n:] - c[:-n]) / n


btc_rows = json.load(open(os.path.join(UD, f"bn_{meta['BTC']['binance_symbol']}_1h.json")))
btc_t = np.array([int(r[0]) for r in btc_rows])
btc_c = arr(btc_rows, 4)
btc_ret = dict(zip(btc_t[1:], np.diff(np.log(btc_c))))
hl_btc = json.load(open(os.path.join(UD, "hl_BTC_4h.json")))
hl_btc_ret = dict(zip([int(r["t"]) for r in hl_btc[1:]], np.diff(np.log([float(r["c"]) for r in hl_btc]))))


def hl_series(coin):
    rows = json.load(open(os.path.join(UD, f"hl_{coin}_4h.json")))
    rows = [r for r in rows if int(r["T"]) < rows[-1]["T"]] or rows      # drop the unfinished candle
    t = np.array([int(r["t"]) for r in rows])
    return t, *(np.array([float(r[k]) for r in rows]) for k in ("o", "h", "l", "c"))

out = {}
raw_q999 = {}
exc = {}
for coin in ALLOW + NEXT:
    m, c = meta[coin], cand[coin]
    rows = json.load(open(os.path.join(UD, f"bn_{m['binance_symbol']}_1h.json")))
    t = np.array([int(r[0]) for r in rows])
    source = "binance 1h"
    if (t[-1] - t[0]) / 86_400_000 >= 365:
        rows, t = rows[SKIP_LISTING_H:], t[SKIP_LISTING_H:]
        o, h, l, cl = arr(rows, 1), arr(rows, 2), arr(rows, 3), arr(rows, 4)
        d4, u4 = excursions(o, h, l, 4)
        d24, u24 = excursions(o, h, l, 24)
        per_year, ref_ret = HOURS_YEAR, btc_ret
    else:                       # too short on Binance: Hyperliquid 4h candles, one window per candle
        source = "hyperliquid 4h"
        t, o, h, l, cl = hl_series(coin)
        t, o, h, l, cl = (x[SKIP_LISTING_H // 4:] for x in (t, o, h, l, cl))
        d4, u4 = l / o - 1, h / o - 1
        d24, u24 = excursions(o, h, l, 6)
        per_year, ref_ret = 6 * 365, hl_btc_ret
    days = (t[-1] - t[0]) / 86_400_000
    q999 = max(-np.quantile(d4, 0.001), np.quantile(u4, 0.999))
    raw_q999[coin] = q999
    exc[coin] = (d4, u4)
    lr = np.diff(np.log(cl))
    vol_all = float(lr.std() * math.sqrt(per_year))
    last_year = t[1:] >= t[-1] - 365 * 86_400_000
    vol_1y = float(lr[last_year].std() * math.sqrt(per_year))
    # beta / correlation to BTC on common bars of the last 2 years
    two_y = t[1:] >= t[-1] - 730 * 86_400_000
    pairs = [(ref_ret[tt], rr) for tt, rr in zip(t[1:][two_y], lr[two_y]) if tt in ref_ret]
    if coin != "BTC" and len(pairs) > 500:
        bx, ax = np.array(pairs).T
        corr = float(np.corrcoef(bx, ax)[0, 1])
        beta = float(np.cov(bx, ax)[0, 1] / bx.var())
    else:
        corr, beta = 1.0, 1.0
    # Hyperliquid funding (hourly rate) and premium
    f = {int(x[0]): (x[1], x[2]) for x in json.load(open(os.path.join(UD, f"hl_{coin}_funding_1y.json")))}
    fund_from = "last year"
    if OLD and os.path.exists(os.path.join(OLD, f"hl_{coin}_funding.json")):
        for r in json.load(open(os.path.join(OLD, f"hl_{coin}_funding.json"))):
            f.setdefault(int(r["time"]), (float(r["fundingRate"]), float(r["premium"])))
        fund_from = "since " + datetime.fromtimestamp(min(f) / 1000, timezone.utc).strftime("%b %Y")
    keys = sorted(f)
    fr = np.array([f[k][0] for k in keys]) * HOURS_YEAR
    prem_1y = np.abs(np.array([f[k][1] for k in keys if k >= keys[-1] - 365 * 86_400_000]))
    prem = prem_1y
    r7 = roll_mean(fr, 24 * 7) if len(fr) >= 24 * 7 else fr
    # L2 book: spread and visible depth
    l2 = json.load(open(os.path.join(UD, f"hl_{coin}_l2.json")))
    bids, asks = (l2.get("levels") or [[], []])
    if bids and asks:
        bb, ba = float(bids[0]["px"]), float(asks[0]["px"])
        mid = (bb + ba) / 2
        spread_bp = (ba - bb) / mid * 1e4

        def depth(side, pct):
            return sum(float(x["px"]) * float(x["sz"]) for x in side
                       if abs(float(x["px"]) / mid - 1) <= pct)
        depth_1pct = min(depth(bids, 0.01), depth(asks, 0.01))
        depth_vis = min(depth(bids, 1.0), depth(asks, 1.0))
        vis_range = max(abs(float(bids[-1]["px"]) / mid - 1), abs(float(asks[-1]["px"]) / mid - 1))
    else:
        spread_bp = depth_1pct = depth_vis = vis_range = float("nan")
    tier = tier_of(c)
    out[coin] = {
        "allowed": coin in ALLOW, "tier": tier, "binance_symbol": m["binance_symbol"], "history_source": source,
        "history_days": round(days), "hl_max_leverage": c["maxLev"], "hl_margin_table": c["marginTableId"],
        "hl_sz_decimals": c["szDecimals"], "unit_mult": c["mult"],
        "price": c["mark"], "oi_usd": c["oi_usd"], "adv30_usd": c["adv30_usd"], "spot24h_usd": c["spot_usd"],
        "mcap_usd": c["mcap"], "pyth_id": c["pyth_id"],
        "tail4h": {"q99_down": float(np.quantile(d4, 0.01)), "q999_down": float(np.quantile(d4, 0.001)),
                   "worst_down": float(d4.min()), "q99_up": float(np.quantile(u4, 0.99)),
                   "q999_up": float(np.quantile(u4, 0.999)), "worst_up": float(u4.max())},
        "tail24h": {"q999_down": float(np.quantile(d24, 0.001)), "q999_up": float(np.quantile(u24, 0.999)),
                    "worst_down": float(d24.min()), "worst_up": float(u24.max())},
        "vol_all": vol_all, "vol_1y": vol_1y, "beta_btc": beta, "corr_btc": corr,
        "funding": {"mean_1y_apr": float(fr[-24 * 365:].mean()), "mean_30d_apr": float(fr[-24 * 30:].mean()),
                    "min_7d_apr": float(r7.min()), "max_7d_apr": float(r7.max()), "hours": int(len(fr)),
                    "history": fund_from},
        "premium": {"q99": float(np.quantile(prem, 0.99)), "q999": float(np.quantile(prem, 0.999)),
                    "max": float(prem.max())},
        "book": {"spread_bp": spread_bp, "depth_1pct_usd": depth_1pct, "depth_visible_usd": depth_vis,
                 "visible_range": vis_range},
    }

# ---- parameters from the rules ----
kappa = BTC_S / raw_q999["BTC"]
for coin, p in out.items():
    s_cal = kappa * raw_q999[coin]
    floor = TIER_FLOOR[p["tier"]]
    if p["history_days"] < YOUNG_DAYS:
        floor = max(floor, YOUNG_FLOOR)
    s = max(floor, math.ceil(s_cal * 100 - 1e-9) / 100)
    if coin == "BTC":
        s = BTC_S
    p["params"] = {
        "S": s, "S_calibrated": s_cal, "S_floor": floor,
        "S_extreme_down": -min(2 * s, 0.90), "S_extreme_up": 2 * s,
        "basis": max(BASIS_FLOOR, math.ceil(p["premium"]["q999"] * 1e4) / 1e4),
        "vol_ref": p["vol_all"],
        "funding_stress_short_apr": min(0.0, p["funding"]["min_7d_apr"]),
        "funding_stress_long_apr": max(0.0, p["funding"]["max_7d_apr"]),
        "client_cap_usd": min(0.05 * p["adv30_usd"], 0.025 * p["oi_usd"]),
        "book_cap_usd": 3 * min(0.05 * p["adv30_usd"], 0.025 * p["oi_usd"]),
        "price_band": {1: 0.01, 2: 0.02, 3: 0.03}[p["tier"]],
    }
    d4, u4 = exc[coin]
    ext_dn = p["params"]["S_extreme_down"]
    p["coverage"] = {   # share of 4h windows (hourly starts) whose move went past the shock size
        "windows": int(len(d4)),
        "down_past_S": float((d4 < -s).mean()), "up_past_S": float((u4 > s).mean()),
        "down_past_extreme": float((d4 < ext_dn).mean()), "up_past_extreme": float((u4 > 2 * s).mean()),
    }

with open(OUT, "w") as fh:
    json.dump({"kappa": kappa, "btc_q999_4h": raw_q999["BTC"], "coins": out, "margin_tables": tables}, fh,
              indent=1)

print(f"kappa (BTC anchor) = {kappa:.4f}; BTC 4h 99.9% move = {raw_q999['BTC']:.4f}")
print("coverage: share of 4h windows past S (down/up) and past the extreme size (down/up)")
for coin in ALLOW + NEXT:
    cv = out[coin]["coverage"]
    print(f"   {coin:6} S {out[coin]['params']['S']:.2f}: {cv['down_past_S']:.4%} / {cv['up_past_S']:.4%}   "
          f"extreme: {cv['down_past_extreme']:.4%} / {cv['up_past_extreme']:.4%}   ({cv['windows']} windows)")
print(f"{'coin':6} {'T':>1} {'yrs':>4} {'q99.9 4h':>8} {'S cal':>6} {'S':>5} {'ext':>5} {'worst4h dn/up':>15} "
      f"{'vol':>5} {'beta':>5} {'basis':>6} {'fund7d min/max':>15} {'ADV $M':>7} {'OI $M':>6} "
      f"{'cap $k':>7} {'sprd bp':>7} {'dep1% $k':>8}")
for coin in ALLOW + NEXT:
    p = out[coin]
    q = p["params"]
    print(f"{coin:6} {p['tier']:>1} {p['history_days'] / 365:>4.1f} {raw_q999[coin]:>8.3f} {q['S_calibrated']:>6.3f} "
          f"{q['S']:>5.2f} {q['S_extreme_up']:>5.2f} {p['tail4h']['worst_down']:>7.2f}/{p['tail4h']['worst_up']:<7.2f}"
          f"{p['vol_all']:>5.2f} {p['beta_btc']:>5.2f} {q['basis']:>6.4f} "
          f"{p['funding']['min_7d_apr']:>7.2f}/{p['funding']['max_7d_apr']:<7.2f}"
          f"{p['adv30_usd'] / 1e6:>7.0f} {p['oi_usd'] / 1e6:>6.0f} {q['client_cap_usd'] / 1e3:>7.0f} "
          f"{p['book']['spread_bp']:>7.2f} {p['book']['depth_1pct_usd'] / 1e3:>8.0f}"
          + ("" if p["allowed"] else "   (next in line)"))
