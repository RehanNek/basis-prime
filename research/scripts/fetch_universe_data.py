"""Fetch calibration data for every coin on the v0 allow-list (plus the next two in line).

Usage: python3 -I fetch_universe_data.py <out_dir> [<existing_data_dir>]

Per coin, all public and read-only:
- Binance spot 1h klines since 1 Jan 2019 or listing (tails, volatility, beta)
- Binance spot 1m klines for the five crash windows (crash replays)
- Hyperliquid 4h candles (most recent 5000) as a cross-check and fallback
- Hyperliquid hourly funding with premium, last 365 days (funding stress, perp-spot gap)
- Hyperliquid L2 book snapshot (spread and visible depth)
Resumable: existing files are skipped. Files already fetched for BTC/ETH/NEAR in
<existing_data_dir> are copied instead of downloaded again.
"""
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

OUT = sys.argv[1]
OLD = sys.argv[2] if len(sys.argv) > 2 else None
os.makedirs(OUT, exist_ok=True)
HL = "https://api.hyperliquid.xyz/info"
BN = "https://data-api.binance.vision/api/v3/klines"
HDR = {"User-Agent": "pb-research/0.1", "Content-Type": "application/json"}
NOW_MS = int(time.time() * 1000)
HOUR = 3_600_000

COINS = ["BTC", "ETH", "ZEC", "SOL", "NEAR", "HYPE", "XRP", "ENA", "PUMP", "WLD", "kPEPE", "UNI", "BNB",
         "SUI", "ONDO", "AAVE", "DOGE", "ARB", "LINK", "AVAX", "ADA", "TRX", "LTC", "TAO", "GRAM"]


def ms(y, m, d, h=0):
    return int(datetime(y, m, d, h, tzinfo=timezone.utc).timestamp() * 1000)


CRASHES = {
    "2020-03-12": (ms(2020, 3, 12), ms(2020, 3, 13, 12)),
    "2021-05-19": (ms(2021, 5, 19), ms(2021, 5, 20)),
    "2022-11-08": (ms(2022, 11, 8), ms(2022, 11, 10)),
    "2024-08-05": (ms(2024, 8, 4, 12), ms(2024, 8, 5, 18)),
    "2025-10-10": (ms(2025, 10, 10, 12), ms(2025, 10, 11, 12)),
}


def call(url, body=None):
    for i in range(10):
        try:
            r = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                       headers=HDR)
            with urllib.request.urlopen(r, timeout=60) as f:
                return json.load(f)
        except urllib.error.HTTPError as e:
            if e.code in (429, 418, 500, 502, 503):
                time.sleep(5 * (i + 1))
                continue
            if e.code == 400:
                return None  # unknown symbol or bad range
            raise
        except Exception:
            time.sleep(3)
    raise RuntimeError("too many retries: " + url)


def have(name):
    return os.path.exists(os.path.join(OUT, name))


def save(name, data):
    with open(os.path.join(OUT, name), "w") as f:
        json.dump(data, f)
    print(f"saved {name}: {len(data)} rows", flush=True)


def base_of(hl):
    return hl[1:] if hl.startswith("k") and hl[1:].isupper() else hl


def bn_symbol(base):
    for q in ("USDT", "USDC", "FDUSD"):
        r = call(f"{BN}?symbol={base}{q}&interval=1d&startTime=0&limit=1")
        if r:
            return base + q, r[0][0]
    return None, None


meta = {}
for coin in COINS:
    base = base_of(coin)
    sym, first = bn_symbol(base)
    meta[coin] = {"base": base, "binance_symbol": sym, "binance_first_ms": first}
    print(coin, sym, first and datetime.fromtimestamp(first / 1000, timezone.utc).date(), flush=True)

    # Binance 1h since 2019 or listing.
    if sym and not have(f"bn_{sym}_1h.json"):
        if OLD and os.path.exists(os.path.join(OLD, f"bn_{sym}_1h.json")):
            rows = json.load(open(os.path.join(OLD, f"bn_{sym}_1h.json")))
            save(f"bn_{sym}_1h.json", [r[:6] + [r[7]] for r in rows])
        else:
            start, allrows = max(ms(2019, 1, 1), first), []
            while start < NOW_MS:
                rows = call(f"{BN}?symbol={sym}&interval=1h&startTime={start}&limit=1000")
                if not rows:
                    break
                allrows.extend(r[:6] + [r[7]] for r in rows)   # t, o, h, l, c, base vol, quote vol
                start = rows[-1][0] + HOUR
                time.sleep(0.15)
            save(f"bn_{sym}_1h.json", allrows)

    # Binance 1m on crash windows, where the coin was listed.
    for label, (a, b) in CRASHES.items():
        name = f"bn_{sym}_1m_{label}.json"
        if not sym or first > a or have(name):
            continue
        if OLD and os.path.exists(os.path.join(OLD, name)):
            shutil.copy(os.path.join(OLD, name), os.path.join(OUT, name))
            continue
        allrows, start = [], a
        while start < b:
            rows = call(f"{BN}?symbol={sym}&interval=1m&startTime={start}&endTime={b}&limit=1000")
            if not rows:
                break
            allrows.extend(rows)
            start = rows[-1][0] + 60_000
            time.sleep(0.15)
        save(name, allrows)

    # Hyperliquid 4h candles (most recent 5000).
    if not have(f"hl_{coin}_4h.json"):
        rows = call(HL, {"type": "candleSnapshot", "req": {"coin": coin, "interval": "4h",
                                                          "startTime": NOW_MS - 5000 * 4 * HOUR,
                                                          "endTime": NOW_MS}})
        save(f"hl_{coin}_4h.json", rows or [])
        time.sleep(0.5)

    # Hyperliquid funding with premium, last 365 days.
    if not have(f"hl_{coin}_funding_1y.json"):
        start, allrows = NOW_MS - 365 * 24 * HOUR, []
        while start < NOW_MS:
            rows = call(HL, {"type": "fundingHistory", "coin": coin, "startTime": start, "endTime": NOW_MS})
            if not rows:
                break
            allrows.extend([r["time"], float(r["fundingRate"]), float(r["premium"])] for r in rows)
            if rows[-1]["time"] + 1 <= start:
                break
            start = rows[-1]["time"] + 1
            time.sleep(1.2)
        save(f"hl_{coin}_funding_1y.json", allrows)

    # Hyperliquid L2 book snapshot.
    if not have(f"hl_{coin}_l2.json"):
        save(f"hl_{coin}_l2.json", call(HL, {"type": "l2Book", "coin": coin}) or {})
        time.sleep(0.3)

with open(os.path.join(OUT, "coins_meta.json"), "w") as f:
    json.dump(meta, f, indent=1)
print("done", flush=True)
