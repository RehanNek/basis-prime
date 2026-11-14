"""Fetch public market data for calibrating the risk engine.

Usage: python3 -I fetch_market.py <data_dir>

Read-only public endpoints:
- Hyperliquid info API (candles, funding history with premium)
- Binance public market-data mirror (long hourly history, 1m on crash days)
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
HL = "https://api.hyperliquid.xyz/info"
BN = "https://data-api.binance.vision/api/v3/klines"
NOW_MS = int(time.time() * 1000)


def _open(req):
    for attempt in range(8):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("rate limited too many times")


def post(body):
    req = urllib.request.Request(
        HL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    return _open(req)


def get(url):
    return _open(url)


def have(name):
    return os.path.exists(os.path.join(OUT, name))


def ms(y, m, d, h=0):
    return int(datetime(y, m, d, h, tzinfo=timezone.utc).timestamp() * 1000)


def save(name, data):
    with open(os.path.join(OUT, name), "w") as f:
        json.dump(data, f)
    print(f"saved {name}: {len(data)} rows", flush=True)


# Hyperliquid candles: most recent 5000 per interval are available.
for coin in ["BTC", "ETH", "NEAR"]:
    for interval, span_ms in [("5m", 5000 * 300_000), ("1h", 5000 * 3_600_000), ("1d", 4000 * 86_400_000)]:
        if have(f"hl_{coin}_{interval}.json"):
            continue
        rows = post({
            "type": "candleSnapshot",
            "req": {"coin": coin, "interval": interval, "startTime": NOW_MS - span_ms, "endTime": NOW_MS},
        })
        save(f"hl_{coin}_{interval}.json", rows)
        time.sleep(0.5)

# Hyperliquid hourly funding (with premium), paginated from 2023-05-01.
for coin in ["BTC", "ETH", "NEAR"]:
    if have(f"hl_{coin}_funding.json"):
        continue
    start = ms(2023, 5, 1)
    allrows = []
    while start < NOW_MS:
        rows = post({"type": "fundingHistory", "coin": coin, "startTime": start, "endTime": NOW_MS})
        if not rows:
            break
        allrows.extend(rows)
        last = rows[-1]["time"]
        if last + 1 <= start:
            break
        start = last + 1
        time.sleep(1.5)
    save(f"hl_{coin}_funding.json", allrows)

# Binance hourly klines since 2019 for long-horizon tails.
for sym in ["BTCUSDT", "ETHUSDT", "NEARUSDT"]:
    if have(f"bn_{sym}_1h.json"):
        continue
    start = ms(2019, 1, 1) if sym != "NEARUSDT" else ms(2020, 10, 14)
    allrows = []
    while start < NOW_MS:
        rows = get(f"{BN}?symbol={sym}&interval=1h&startTime={start}&limit=1000")
        if not rows:
            break
        allrows.extend(rows)
        start = rows[-1][0] + 3_600_000
        time.sleep(0.2)
    save(f"bn_{sym}_1h.json", allrows)

# Binance 1m klines around crash windows (UTC).
CRASHES = {
    "2020-03-12": (ms(2020, 3, 12), ms(2020, 3, 13, 12)),
    "2021-05-19": (ms(2021, 5, 19), ms(2021, 5, 20)),
    "2022-11-08": (ms(2022, 11, 8), ms(2022, 11, 10)),
    "2024-08-05": (ms(2024, 8, 4, 12), ms(2024, 8, 5, 18)),
    "2025-10-10": (ms(2025, 10, 10, 12), ms(2025, 10, 11, 12)),
}
for sym in ["BTCUSDT", "ETHUSDT"]:
    for label, (a, b) in CRASHES.items():
        if have(f"bn_{sym}_1m_{label}.json"):
            continue
        allrows = []
        start = a
        while start < b:
            rows = get(f"{BN}?symbol={sym}&interval=1m&startTime={start}&endTime={b}&limit=1000")
            if not rows:
                break
            allrows.extend(rows)
            start = rows[-1][0] + 60_000
            time.sleep(0.2)
        save(f"bn_{sym}_1m_{label}.json", allrows)
