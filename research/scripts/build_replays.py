"""Build the crash-replay windows embedded in the engine (RISK_ENGINE.md section 4.5, replays).

Usage: python3 -I build_replays.py <udata_dir> <out_json>

For each crash day, find BTC's worst 4-hour fall and worst 4-hour rise in Binance 1-minute data.
For every coin with 1-minute data that day, store its path over the same 4 hours as the 240 one-minute
closes, in time order, relative to the coin's close in the minute before the window. Closes, not wicks:
Hyperliquid's mark is a median across venues and does not follow one exchange's wick. Time order matters:
a liquidation can only affect what comes after it (the math review found that 5-minute bar summaries hid
the order of a bar's low and high).

Coins without minute data that day follow BTC's path times a scale, stored per window:
- the coin's own ratio to BTC over the same hours, from Hyperliquid 4h candles, if it traded there then:
  for falls, (low / open - 1) against BTC's; for rises, the candle range (high / low - 1) against BTC's,
  because rises in these windows are rebounds from a low inside the same candle;
- otherwise the 75th percentile of that ratio across the coins that did trade in the window (at least 1).
"""
import json
import os
import sys
from datetime import datetime, timezone

UD, OUT = sys.argv[1], sys.argv[2]
meta = json.load(open(os.path.join(UD, "coins_meta.json")))
DAYS = ["2020-03-12", "2021-05-19", "2022-11-08", "2024-08-05", "2025-10-10"]
WIN, BAR = 240, 5


def load(sym, day):
    p = os.path.join(UD, f"bn_{sym}_1m_{day}.json")
    if not os.path.exists(p):
        return None
    rows = json.load(open(p))
    return {int(r[0]): (float(r[1]), float(r[2]), float(r[3]), float(r[4])) for r in rows}


def hl4h(coin):
    p = os.path.join(UD, f"hl_{coin}_4h.json")
    if not os.path.exists(p):
        return {}
    return {int(r["t"]): (float(r["o"]), float(r["h"]), float(r["l"]), float(r["c"])) for r in json.load(open(p))}


def excursion(candles, t0, down):
    """Falls: open of the 4h candle holding t0 to the worst low over the candles covering the window.
    Rises: the range of those candles (best high / worst low - 1), as these rises are rebounds."""
    start = t0 - t0 % (4 * 3_600_000)
    keys = [k for k in (start, start + 4 * 3_600_000) if k in candles and k < t0 + 4 * 3_600_000]
    if not keys or start not in candles:
        return None
    lo = min(candles[k][2] for k in keys)
    if down:
        return lo / candles[start][0] - 1
    return max(candles[k][1] for k in keys) / lo - 1


HL4H = {coin: hl4h(coin) for coin in meta}
windows = []
for day in DAYS:
    btc = load(meta["BTC"]["binance_symbol"], day)
    ts = sorted(btc)
    best = {"down": (0.0, None), "up": (0.0, None)}
    for i in range(1, len(ts) - WIN + 1):
        o = btc[ts[i - 1]][3]
        lo = min(btc[t][3] for t in ts[i:i + WIN])
        hi = max(btc[t][3] for t in ts[i:i + WIN])
        if lo / o - 1 < best["down"][0]:
            best["down"] = (lo / o - 1, ts[i])
        if hi / o - 1 > best["up"][0]:
            best["up"] = (hi / o - 1, ts[i])
    for direction, (move, t0) in best.items():
        span = [t0 + 60_000 * k for k in range(WIN)]
        paths = {}
        for coin, mm in meta.items():
            data = btc if coin == "BTC" else (load(mm["binance_symbol"], day) if mm["binance_symbol"] else None)
            if not data or any(t not in data for t in span) or (t0 - 60_000) not in data:
                continue
            o0 = data[t0 - 60_000][3]           # close of the minute before the window
            paths[coin] = [round(data[t][3] / o0 - 1, 5) for t in span]
        down = direction == "down"
        b_ext = min(paths["BTC"]) if down else max(paths["BTC"])
        ratios = sorted((min(pth) if down else max(pth)) / b_ext for c, pth in paths.items() if c != "BTC")
        p75 = max(1.0, ratios[int(0.75 * (len(ratios) - 1) + 0.5)]) if ratios else 1.0
        scale, source = {}, {}
        b_hl = excursion(HL4H.get("BTC", {}), t0, down)
        for coin in meta:
            if coin in paths:
                continue
            c_hl = excursion(HL4H.get(coin, {}), t0, down)
            if c_hl is not None and b_hl and abs(b_hl) > 0.005:
                scale[coin], source[coin] = round(max(0.0, c_hl / b_hl), 3), "hyperliquid 4h"
            else:
                scale[coin], source[coin] = round(p75, 3), "window p75"
        start = datetime.fromtimestamp(t0 / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M")
        windows.append({"name": f"{day} {direction} (from {start} UTC)", "btc_move": round(move, 4),
                        "paths": paths, "p75_ratio": round(p75, 3), "scale": scale, "scale_source": source})
        print(f"{day} {direction:4}: start {start}, BTC {move:+.1%}, coins with data: {len(paths)}; p75 ratio "
              f"{p75:.2f}; scaled: " + ", ".join(f"{c} {scale[c]:.2f} ({source[c][:2]})" for c in sorted(scale)))

with open(OUT, "w") as f:
    json.dump({"bar_minutes": 1, "window_minutes": WIN, "windows": windows}, f)
print(f"wrote {OUT}: {os.path.getsize(OUT) / 1e3:.0f} kB")
