"""Rank Hyperliquid perps for the v0 allow-list from public market data.

Usage: python3 -I universe.py <raw_dir> <out_json>

Sources (all public, read-only):
- Hyperliquid info API: metaAndAssetCtxs (open interest, 24h volume, max leverage, margin tables),
  candleSnapshot 1d (30-day average volume)
- Binance spot 24h tickers (data-api.binance.vision), OKX and Bybit spot tickers, Coinbase product list
- CoinGecko top 250 by market cap
- Pyth Hermes price-feed list
- 1Click token list (which assets exist on NEAR)
"""
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request

RAW, OUT = sys.argv[1], sys.argv[2]
os.makedirs(RAW, exist_ok=True)
HL = "https://api.hyperliquid.xyz/info"
HDR = {"User-Agent": "pb-research/0.1", "Content-Type": "application/json", "Accept": "application/json"}
NOW_MS = int(time.time() * 1000)
DAY = 86_400_000
STABLES = {"USDC", "USDT", "USDE", "DAI", "FDUSD", "TUSD", "USDD", "PYUSD", "USD1", "USDS", "RLUSD", "USDP"}


def fetch(url, body=None, name=None, retries=6):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                         headers=HDR)
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.load(r)
            if name:
                with open(os.path.join(RAW, name), "w") as f:
                    json.dump(data, f)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(4 * (i + 1))
                continue
            print(f"  HTTP {e.code} for {url}", flush=True)
            return None
        except Exception as e:  # network hiccup: retry
            print(f"  error {e!r} for {url}", flush=True)
            time.sleep(2)
    return None


def base_of(hl_name):
    """Hyperliquid prefixes 1000x contracts with 'k' (kPEPE = 1000 PEPE)."""
    if hl_name.startswith("k") and hl_name[1:].isupper():
        return hl_name[1:], 1000
    return hl_name, 1


# ---------- Hyperliquid ----------
meta, ctxs = fetch(HL, {"type": "metaAndAssetCtxs"}, "hl_meta_ctxs.json")
tables = {t[0]: t[1] for t in meta.get("marginTables", [])}
coins = []
for u, c in zip(meta["universe"], ctxs):
    if u.get("isDelisted"):
        continue
    mark = float(c.get("markPx") or 0)
    coins.append({
        "hl": u["name"], "base": base_of(u["name"])[0], "mult": base_of(u["name"])[1],
        "szDecimals": u["szDecimals"], "maxLev": u["maxLeverage"], "onlyIsolated": bool(u.get("onlyIsolated")),
        "marginMode": u.get("marginMode"), "marginTableId": u.get("marginTableId"),
        "mark": mark, "oracle": float(c.get("oraclePx") or 0),
        "oi_usd": float(c.get("openInterest") or 0) * mark,
        "vol24_usd": float(c.get("dayNtlVlm") or 0),
        "impactPxs": c.get("impactPxs"), "funding_h": float(c.get("funding") or 0),
    })
print(f"Hyperliquid perps listed: {len(coins)}", flush=True)

cands = [x for x in coins if x["oi_usd"] >= 5e6 or x["vol24_usd"] >= 5e6]
for x in cands:
    rows = fetch(HL, {"type": "candleSnapshot", "req": {"coin": x["hl"], "interval": "1d",
                                                        "startTime": NOW_MS - 40 * DAY, "endTime": NOW_MS}})
    time.sleep(0.4)
    full = [r for r in (rows or []) if r["T"] < NOW_MS][-30:]
    vols = [float(r["v"]) * (float(r["h"]) + float(r["l"]) + float(r["c"])) / 3 for r in full]
    x["adv30_usd"] = statistics.mean(vols) if vols else 0.0
    x["adv30_days"] = len(vols)

# ---------- Spot venues ----------
spot = {}


def add_spot(base, venue, usd):
    d = spot.setdefault(base.upper(), {})
    d[venue] = d.get(venue, 0.0) + usd


bn = fetch("https://data-api.binance.vision/api/v3/ticker/24hr", name="binance_24hr.json") or []
for t in bn:
    for q in ("USDT", "USDC", "FDUSD"):
        if t["symbol"].endswith(q):
            add_spot(t["symbol"][:-len(q)], "binance", float(t["quoteVolume"]))
okx = fetch("https://www.okx.com/api/v5/market/tickers?instType=SPOT", name="okx_spot.json") or {}
for t in okx.get("data", []):
    b, q = t["instId"].split("-")[:2]
    if q in ("USDT", "USDC"):
        add_spot(b, "okx", float(t.get("volCcy24h") or 0))
byb = fetch("https://api.bybit.com/v5/market/tickers?category=spot", name="bybit_spot.json") or {}
for t in (byb.get("result") or {}).get("list", []):
    for q in ("USDT", "USDC"):
        if t["symbol"].endswith(q):
            add_spot(t["symbol"][:-len(q)], "bybit", float(t.get("turnover24h") or 0))
cb = fetch("https://api.exchange.coinbase.com/products", name="coinbase_products.json") or []
cb_bases = {p["base_currency"].upper() for p in cb
            if p.get("quote_currency") in ("USD", "USDC", "USDT") and p.get("status") == "online"
            and not p.get("trading_disabled")}

# ---------- Market cap, oracle, NEAR availability ----------
cg = fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc"
           "&per_page=250&page=1", name="coingecko_top250.json") or []
mcap = {}
for c in cg:
    s = c["symbol"].upper()
    if s not in mcap or (c.get("market_cap") or 0) > mcap[s]["mcap"]:
        mcap[s] = {"mcap": c.get("market_cap") or 0, "fdv": c.get("fully_diluted_valuation") or 0,
                   "id": c["id"]}
py = fetch("https://hermes.pyth.network/v2/price_feeds?asset_type=crypto", name="pyth_feeds.json") or []
pyth = {}
for f in py:
    a = f.get("attributes", {})
    sym = a.get("symbol", "")                      # e.g. "Crypto.BTC/USD"
    if a.get("quote_currency") == "USD" and sym.startswith("Crypto.") and "/" in sym:
        pyth.setdefault(sym[len("Crypto."):].split("/")[0].upper(), f["id"])
oc = fetch("https://1click.chaindefuser.com/v0/tokens", name="oneclick_tokens.json") or []
near_syms = sorted({t["symbol"].upper() for t in oc if t.get("blockchain") == "near"})
oc_syms = {t["symbol"].upper() for t in oc}

# ---------- Criteria ----------
for x in cands:
    b = x["base"]
    sv = spot.get(b, {})
    x["spot_usd"] = sum(sv.values())
    x["spot_venues"] = sorted(k for k, v in sv.items() if v >= 1e6) + (["coinbase"] if b in cb_bases else [])
    x["binance"] = sv.get("binance", 0) >= 1e6
    x["mcap"] = mcap.get(b, {}).get("mcap", 0)
    x["fdv"] = mcap.get(b, {}).get("fdv", 0)
    x["pyth"] = b in pyth
    x["pyth_id"] = pyth.get(b)
    x["on_near_1click"] = b in near_syms
    x["on_1click"] = b in oc_syms
    x["weakest_liq"] = min(x["adv30_usd"], x["spot_usd"])
    x["fails"] = [name for name, ok in (
        ("stable", b not in STABLES),
        ("hl_maxlev<10", x["maxLev"] >= 10 and not x["onlyIsolated"]),
        ("hl_oi<10M", x["oi_usd"] >= 10e6),
        ("hl_adv30<3M", x["adv30_usd"] >= 3e6),
        ("no_binance_spot", x["binance"]),
        ("spot_venues<2", len(set(x["spot_venues"])) >= 2),
        ("spot24h<10M", x["spot_usd"] >= 10e6),
        ("mcap<1B", x["mcap"] >= 1e9),
        ("no_pyth", x["pyth"]),
    ) if not ok]

cands.sort(key=lambda x: -x["weakest_liq"])
print(f"\n{'coin':8} {'maxLev':>6} {'OI $M':>8} {'HLadv $M':>9} {'spot $M':>8} {'mcap $B':>8} "
      f"{'venues':28} pyth near  fails")
for x in cands[:90]:
    print(f"{x['hl']:8} {x['maxLev']:>6} {x['oi_usd'] / 1e6:>8.0f} {x['adv30_usd'] / 1e6:>9.0f} "
          f"{x['spot_usd'] / 1e6:>8.0f} {x['mcap'] / 1e9:>8.1f} {','.join(x['spot_venues']):28} "
          f"{'y' if x['pyth'] else '-':>4} {'y' if x['on_near_1click'] else '-':>4}  {','.join(x['fails'])}")
passing = [x for x in cands if not x["fails"]]
print(f"\npassing all criteria: {len(passing)}: " + ", ".join(x["hl"] for x in passing))
near_only = [x["hl"] for x in cands if x["fails"] and set(x["fails"]) <= {"hl_maxlev<10"}]
print("fail only on max leverage:", ", ".join(near_only))
print("NEAR-chain symbols in 1Click:", ", ".join(near_syms))
with open(OUT, "w") as f:
    json.dump({"generated_ms": NOW_MS, "candidates": cands, "margin_tables": tables,
               "near_1click_symbols": near_syms}, f, indent=1)
