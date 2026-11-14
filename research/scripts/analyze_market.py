"""Turn the downloaded market data into calibration numbers for the risk engine.

Usage: python3 -I analyze_market.py <data_dir>
Prints tables and writes calibration.json into <data_dir>.
"""
import glob
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view as swv

D = sys.argv[1]
out = {}


def load(name):
    p = os.path.join(D, name)
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return json.load(f)


def day(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


def bn_arrays(rows):
    t = np.array([r[0] for r in rows], dtype=np.int64)
    o, h, l, c = (np.array([float(r[i]) for r in rows]) for i in (1, 2, 3, 4))
    return t, o, h, l, c


def excursions(t, o, h, l, n):
    """Worst move from a window's open to the extreme low/high within n candles."""
    if len(o) < n:
        return None
    lo = swv(l, n).min(axis=1)
    hi = swv(h, n).max(axis=1)
    op = o[: len(lo)]
    down = lo / op - 1
    up = hi / op - 1
    i_d, i_u = int(down.argmin()), int(up.argmax())
    return {
        "windows": int(len(down)),
        "worst_down": float(down[i_d]), "worst_down_at": day(t[i_d]),
        "worst_up": float(up[i_u]), "worst_up_at": day(t[i_u]),
        "q999_down": float(np.quantile(down, 0.001)), "q99_down": float(np.quantile(down, 0.01)),
        "q999_up": float(np.quantile(up, 0.999)), "q99_up": float(np.quantile(up, 0.99)),
        "_down": down, "_up": up,
    }


def pct(x):
    return f"{x * 100:+.1f}%"


# A. Long-history tails from Binance hourly candles.
print("\n=== A. Tail moves, Binance 1h candles (open -> extreme within horizon) ===")
out["tails_1h"] = {}
for sym in ["BTCUSDT", "ETHUSDT", "NEARUSDT"]:
    rows = load(f"bn_{sym}_1h.json")
    if not rows:
        continue
    t, o, h, l, c = bn_arrays(rows)
    print(f"\n{sym}: {day(t[0])} .. {day(t[-1])}, {len(t)} hourly candles")
    print(f"{'horizon':>8} {'worst down':>11} {'at':>17} {'99.9% dn':>9} {'99% dn':>8} {'worst up':>9} {'at':>17} {'99.9% up':>9} {'99% up':>8}")
    out["tails_1h"][sym] = {"from": day(t[0]), "to": day(t[-1])}
    for hrs in [1, 4, 12, 24, 72, 168]:
        e = excursions(t, o, h, l, hrs)
        print(f"{hrs:>6}h {pct(e['worst_down']):>11} {e['worst_down_at']:>17} {pct(e['q999_down']):>9} {pct(e['q99_down']):>8} "
              f"{pct(e['worst_up']):>9} {e['worst_up_at']:>17} {pct(e['q999_up']):>9} {pct(e['q99_up']):>8}")
        # Breach frequency: share of windows whose adverse move exceeds a buffer.
        breach = {f"{int(b * 100)}%": {"down": float((e["_down"] <= -b).mean()), "up": float((e["_up"] >= b).mean())}
                  for b in [0.03, 0.05, 0.08, 0.10, 0.15, 0.20, 0.30]}
        out["tails_1h"][sym][f"{hrs}h"] = {k: v for k, v in e.items() if not k.startswith("_")} | {"breach": breach}
    # Breach table for the most common rebalance windows.
    for hrs in [1, 4, 24]:
        b = out["tails_1h"][sym][f"{hrs}h"]["breach"]
        cells = "  ".join(f"{k}: dn {v['down'] * 100:.3f}% up {v['up'] * 100:.3f}%" for k, v in b.items())
        print(f"  share of {hrs}h windows breaching a buffer -> {cells}")

# Realised volatility and correlations from the last 365 days of hourly closes.
print("\n=== Realised volatility (annualised, hourly log returns) and correlation ===")
rets = {}
for sym in ["BTCUSDT", "ETHUSDT", "NEARUSDT"]:
    rows = load(f"bn_{sym}_1h.json")
    if not rows:
        continue
    t, o, h, l, c = bn_arrays(rows)
    r = np.diff(np.log(c))
    rets[sym] = (t[1:], r)
    v_all = r.std() * np.sqrt(24 * 365)
    v_1y = r[-24 * 365:].std() * np.sqrt(24 * 365)
    v_30 = r[-24 * 30:].std() * np.sqrt(24 * 365)
    print(f"{sym}: full-history {v_all * 100:.0f}%  last 1y {v_1y * 100:.0f}%  last 30d {v_30 * 100:.0f}%")
    out.setdefault("vol", {})[sym] = {"all": float(v_all), "1y": float(v_1y), "30d": float(v_30)}
if "BTCUSDT" in rets:
    tb, rb = rets["BTCUSDT"]
    for sym in ["ETHUSDT", "NEARUSDT"]:
        if sym not in rets:
            continue
        ts, rs = rets[sym]
        common, ib, is_ = np.intersect1d(tb, ts, return_indices=True)
        x, y = rb[ib][-24 * 365:], rs[is_][-24 * 365:]
        corr = float(np.corrcoef(x, y)[0, 1])
        beta = float(np.cov(x, y)[0, 1] / x.var())
        print(f"BTC vs {sym} (last 1y hourly): corr {corr:.2f}, beta {beta:.2f}")
        out.setdefault("corr_btc", {})[sym] = {"corr": corr, "beta": beta}

# B. Minute-level moves on crash days.
print("\n=== B. Crash windows, Binance 1m candles ===")
out["crashes"] = {}
for path in sorted(glob.glob(os.path.join(D, "bn_*_1m_*.json"))):
    name = os.path.basename(path)[3:-5]
    rows = load(os.path.basename(path))
    if not rows:
        continue
    t, o, h, l, c = bn_arrays(rows)
    line = []
    res = {}
    for mins in [1, 5, 15, 60, 240]:
        e = excursions(t, o, h, l, mins)
        if e is None:
            continue
        res[f"{mins}m"] = {"worst_down": e["worst_down"], "at": e["worst_down_at"], "worst_up": e["worst_up"]}
        line.append(f"{mins}m dn {pct(e['worst_down'])} up {pct(e['worst_up'])}")
    whole = float(l.min() / o[0] - 1)
    res["whole_window_low_vs_open"] = whole
    out["crashes"][name] = res
    print(f"{name:<28} " + " | ".join(line) + f" | window low vs open {pct(whole)}")

# C/D. Hyperliquid funding and premium.
print("\n=== C. Hyperliquid hourly funding (positive = longs pay shorts) and premium ===")
out["funding"] = {}
for coin in ["BTC", "ETH", "NEAR"]:
    rows = load(f"hl_{coin}_funding.json")
    if not rows:
        continue
    t = np.array([r["time"] for r in rows], dtype=np.int64)
    f = np.array([float(r["fundingRate"]) for r in rows])
    p = np.array([float(r["premium"]) for r in rows])
    ann = f * 24 * 365
    res = {"from": day(t[0]), "to": day(t[-1]), "hours": int(len(f))}

    def roll(x, n):
        return swv(x, n).mean(axis=1) if len(x) >= n else np.array([np.nan])

    for label, sl in [("all", slice(None)), ("last_365d", slice(-24 * 365, None))]:
        fa = ann[sl]
        r7, r30 = roll(fa, 24 * 7), roll(fa, 24 * 30)
        res[label] = {
            "mean_apr": float(fa.mean()), "median_apr": float(np.median(fa)),
            "share_hours_negative": float((fa < 0).mean()),
            "worst_hour_apr": float(fa.min()), "best_hour_apr": float(fa.max()),
            "min_7d_avg_apr": float(np.nanmin(r7)), "share_7d_windows_negative": float((r7 < 0).mean()),
            "min_30d_avg_apr": float(np.nanmin(r30)), "max_30d_avg_apr": float(np.nanmax(r30)),
            "share_30d_windows_negative": float((r30 < 0).mean()),
        }
    ap = np.abs(p)
    res["premium_abs"] = {"p50": float(np.quantile(ap, 0.5)), "p99": float(np.quantile(ap, 0.99)),
                          "p999": float(np.quantile(ap, 0.999)), "max": float(ap.max()),
                          "max_at": day(t[int(ap.argmax())]), "min_signed": float(p.min()), "max_signed": float(p.max())}
    out["funding"][coin] = res
    a, y = res["all"], res["last_365d"]
    print(f"{coin}: {res['from']} .. {res['to']} ({res['hours']} h)")
    print(f"  all:  mean {a['mean_apr'] * 100:.1f}% APR, median {a['median_apr'] * 100:.1f}%, hours negative {a['share_hours_negative'] * 100:.1f}%, "
          f"worst 7d avg {a['min_7d_avg_apr'] * 100:.1f}%, 7d windows negative {a['share_7d_windows_negative'] * 100:.1f}%, "
          f"worst 30d avg {a['min_30d_avg_apr'] * 100:.1f}%, best 30d avg {a['max_30d_avg_apr'] * 100:.1f}%")
    print(f"  1y:   mean {y['mean_apr'] * 100:.1f}% APR, median {y['median_apr'] * 100:.1f}%, hours negative {y['share_hours_negative'] * 100:.1f}%, "
          f"worst 7d avg {y['min_7d_avg_apr'] * 100:.1f}%, worst 30d avg {y['min_30d_avg_apr'] * 100:.1f}%")
    pa = res["premium_abs"]
    print(f"  |premium| p50 {pa['p50'] * 1e4:.1f} bp, p99 {pa['p99'] * 1e4:.1f} bp, p99.9 {pa['p999'] * 1e4:.1f} bp, "
          f"max {pa['max'] * 1e4:.0f} bp at {pa['max_at']} (range {pa['min_signed'] * 1e4:.0f}..{pa['max_signed'] * 1e4:.0f} bp)")

# E. Recent short-horizon moves on Hyperliquid itself (5m candles, ~17 days).
print("\n=== E. Hyperliquid 5m candles (recent ~17 days) ===")
for coin in ["BTC", "ETH", "NEAR"]:
    rows = load(f"hl_{coin}_5m.json")
    if not rows:
        continue
    t = np.array([r["t"] for r in rows], dtype=np.int64)
    o, h, l = (np.array([float(r[k]) for r in rows]) for k in ("o", "h", "l"))
    cells = []
    for n, lab in [(1, "5m"), (3, "15m"), (12, "1h")]:
        e = excursions(t, o, h, l, n)
        cells.append(f"{lab} dn {pct(e['worst_down'])} up {pct(e['worst_up'])}")
    print(f"{coin}: {day(t[0])} .. {day(t[-1])}: " + " | ".join(cells))

with open(os.path.join(D, "calibration.json"), "w") as fh:
    json.dump(out, fh, indent=1)
print("\nwrote calibration.json")
