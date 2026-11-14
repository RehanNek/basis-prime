"""Phase 0 check: Hyperliquid testnet prices and coins (PLAN.md section 13, last row).

Usage: python3 -I day1_hl_testnet.py <universe_v0.json> <out.json> [samples] [interval_seconds]

Reads public data only:
- Hyperliquid info API, testnet and mainnet: metaAndAssetCtxs, spotMeta, l2Book (BTC)
- Binance (data-api.binance.vision), OKX, Bybit and Coinbase spot tickers

For each of the 23 allow-listed coins it records:
- whether testnet lists it, and at which asset index (the gateway needs this: indices differ by network);
- its max leverage and margin tiers on both networks;
- over several samples, how far testnet's mark and oracle prices sit from the exchanges' median mid.

For BTC it also measures the order book for the demo's trades, and the funding rate.
"""
import json
import statistics
import sys
import time
import urllib.error
import urllib.request

UNI, OUT = sys.argv[1], sys.argv[2]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 6
DT = float(sys.argv[4]) if len(sys.argv) > 4 else 30.0
HL = {"testnet": "https://api.hyperliquid-testnet.xyz/info", "mainnet": "https://api.hyperliquid.xyz/info"}
HDR = {"User-Agent": "pb-research/0.1", "Content-Type": "application/json", "Accept": "application/json"}
DEMO_TRADES = {"open the demo short": ("sell", 25_000), "drill buy-back": ("buy", 6_250),
               "close the demo short": ("buy", 25_000)}


def fetch(url, body=None, retries=4):
    err = "retries exhausted"
    for i in range(retries):
        try:
            req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=HDR)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            err = f"HTTP {e.code}"
            if e.code == 429:
                time.sleep(3 * (i + 1))
                continue
            return {"_error": err}
        except Exception as e:  # network hiccup: retry
            err = repr(e)
            time.sleep(2)
    return {"_error": err}


uni = json.load(open(UNI))
coins = {c: p for c, p in uni["coins"].items() if p["allowed"]}
base = {c: p["binance_symbol"][:-4] for c, p in coins.items()}      # BTCUSDT -> BTC, PEPEUSDT -> PEPE
mult = {c: p["unit_mult"] for c, p in coins.items()}                # kPEPE = 1,000 PEPE


def tiers(meta, idx):
    """Margin tiers of the coin at universe position idx: [(lower bound $, max leverage)]."""
    u = meta["universe"][idx]
    tables = {str(t[0]): t[1] for t in meta.get("marginTables", [])}
    tid = str(u.get("marginTableId"))
    if tid in tables:
        return sorted((float(t["lowerBound"]), int(t["maxLeverage"])) for t in tables[tid]["marginTiers"])
    return [(0.0, int(u["maxLeverage"]))]


def mm(tier_list, notional):
    """Hyperliquid's tiered maintenance margin (same rule as risk_engine_ref.Engine.mm)."""
    rate, ded, prev, ded_at = None, 0.0, None, 0.0
    for i, (lb, lev) in enumerate(tier_list):
        r = 1 / (2 * lev)
        if i > 0:
            ded += lb * (r - prev)
        if notional >= lb:
            rate, ded_at = r, ded
        prev = r
    return max(0.0, notional * rate - ded_at)


def book_stats(book):
    """Depth near the mid, and the average fill of each demo trade if sent as a market order."""
    if "_error" in book or not book.get("levels"):
        return {"error": book.get("_error", "no levels")}
    bids = [(float(x["px"]), float(x["sz"])) for x in book["levels"][0]]
    asks = [(float(x["px"]), float(x["sz"])) for x in book["levels"][1]]
    mid = (bids[0][0] + asks[0][0]) / 2
    out = {"mid": mid, "spread_bp": (asks[0][0] - bids[0][0]) / mid * 1e4, "levels": [len(bids), len(asks)]}
    for pct in (0.005, 0.01, 0.02):
        out[f"bid_usd_within_{pct:.1%}"] = sum(p * s for p, s in bids if p >= mid * (1 - pct))
        out[f"ask_usd_within_{pct:.1%}"] = sum(p * s for p, s in asks if p <= mid * (1 + pct))
    for name, (side, usd) in DEMO_TRADES.items():
        levels = bids if side == "sell" else asks
        left, got_sz, paid = usd, 0.0, 0.0
        for p, s in levels:
            take = min(s, left / p)
            got_sz += take
            paid += take * p
            left -= take * p
            if left <= 1e-6:
                break
        out[name] = ({"filled": True, "avg_px": paid / got_sz, "slip_bp": abs(paid / got_sz / mid - 1) * 1e4,
                      "worst_px": p}
                     if left <= 1e-6 else {"filled": False, "usd_unfilled": left, "usd_in_book": usd - left})
    return out


def exchange_mids():
    """Spot mid per coin, per exchange, in USD (USDT pairs taken at par) per Hyperliquid unit."""
    mids = {c: {} for c in coins}
    bn = fetch("https://data-api.binance.vision/api/v3/ticker/24hr")
    bn = {t["symbol"]: t for t in bn} if isinstance(bn, list) else {}
    okx = fetch("https://www.okx.com/api/v5/market/tickers?instType=SPOT")
    okx = {t["instId"]: t for t in okx.get("data", [])} if isinstance(okx, dict) else {}
    byb = fetch("https://api.bybit.com/v5/market/tickers?category=spot")
    byb = {t["symbol"]: t for t in (byb.get("result") or {}).get("list", [])} if isinstance(byb, dict) else {}
    for c in coins:
        b, k = base[c], mult[c]
        t = bn.get(f"{b}USDT")
        if t and float(t.get("bidPrice") or 0) > 0:
            mids[c]["binance"] = k * (float(t["bidPrice"]) + float(t["askPrice"])) / 2
        t = okx.get(f"{b}-USDT")
        if t and float(t.get("bidPx") or 0) > 0:
            mids[c]["okx"] = k * (float(t["bidPx"]) + float(t["askPx"])) / 2
        t = byb.get(f"{b}USDT")
        if t and float(t.get("bid1Price") or 0) > 0:
            mids[c]["bybit"] = k * (float(t["bid1Price"]) + float(t["ask1Price"])) / 2
        if b in CB:
            t = fetch(f"https://api.exchange.coinbase.com/products/{b}-USD/ticker")
            if isinstance(t, dict) and float(t.get("bid") or 0) > 0:
                mids[c]["coinbase"] = k * (float(t["bid"]) + float(t["ask"])) / 2
            time.sleep(0.15)
    return mids


cb = fetch("https://api.exchange.coinbase.com/products")
CB = {p["base_currency"] for p in cb if p.get("quote_currency") == "USD" and p.get("status") == "online"} \
    if isinstance(cb, list) else set()

result = {"generated_utc": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()), "samples": N, "interval_s": DT,
          "coins": {}, "btc_book": {}, "spot_usdc": {}, "series": []}

# Static facts: listing, asset index, leverage, margin tiers, USDC token id.
meta = {}
for net, url in HL.items():
    mc = fetch(url, {"type": "metaAndAssetCtxs"})
    meta[net] = mc[0]
    sm = fetch(url, {"type": "spotMeta"})
    usdc = [t for t in sm.get("tokens", []) if t.get("name") == "USDC"] if isinstance(sm, dict) else []
    result["spot_usdc"][net] = f"USDC:{usdc[0]['tokenId']}" if usdc else None
idx = {net: {u["name"]: i for i, u in enumerate(m["universe"])} for net, m in meta.items()}
for c in coins:
    row = {}
    for net in HL:
        i = idx[net].get(c)
        if i is None:
            row[net] = None
            continue
        u = meta[net]["universe"][i]
        row[net] = {"asset": i, "maxLeverage": u["maxLeverage"], "szDecimals": u["szDecimals"],
                    "delisted": bool(u.get("isDelisted")), "onlyIsolated": bool(u.get("onlyIsolated")),
                    "marginTableId": u.get("marginTableId"), "tiers": tiers(meta[net], i)}
    result["coins"][c] = row

# Samples: prices on both networks against the exchanges, and the BTC book.
for s in range(N):
    t0 = time.time()
    ctx = {net: fetch(url, {"type": "metaAndAssetCtxs"}) for net, url in HL.items()}
    mids = exchange_mids()
    snap = {"t": time.strftime("%H:%M:%S", time.gmtime()), "coins": {}}
    for c in coins:
        ex = mids[c]
        ref = statistics.median(ex.values()) if ex else None
        row = {"exchanges": ex, "ref": ref}
        for net in HL:
            i = idx[net].get(c)
            if i is None or not isinstance(ctx[net], list):
                continue
            x = ctx[net][1][i]
            mark, orc = float(x.get("markPx") or 0), float(x.get("oraclePx") or 0)
            mid = float(x["midPx"]) if x.get("midPx") else None
            row[net] = {"mark": mark, "oracle": orc, "mid": mid, "funding_h": float(x.get("funding") or 0),
                        "oi": float(x.get("openInterest") or 0), "vol24": float(x.get("dayNtlVlm") or 0)}
            if ref:
                row[net]["mark_bp"] = (mark / ref - 1) * 1e4
                row[net]["oracle_bp"] = (orc / ref - 1) * 1e4
                if mid:
                    row[net]["mid_bp"] = (mid / ref - 1) * 1e4
        snap["coins"][c] = row
    for net, url in HL.items():
        snap.setdefault("btc_book", {})[net] = book_stats(fetch(url, {"type": "l2Book", "coin": "BTC"}))
    result["series"].append(snap)
    b = snap["coins"]["BTC"]
    print(f"sample {s + 1}/{N} {snap['t']}: BTC ref {b['ref']:,.1f} | testnet mark {b['testnet']['mark']:,.1f} "
          f"({b['testnet']['mark_bp']:+.1f} bp), oracle {b['testnet']['oracle_bp']:+.1f} bp | "
          f"mainnet mark {b['mainnet']['mark_bp']:+.1f} bp", flush=True)
    if s < N - 1:
        time.sleep(max(0.0, DT - (time.time() - t0)))

# Summary per coin over the samples.
summary = {}
for c in coins:
    rows = [x["coins"][c] for x in result["series"]]
    summ = {"testnet_listed": result["coins"][c]["testnet"] is not None,
            "sources": sorted({k for r in rows for k in r["exchanges"]})}
    for net in HL:
        for key in ("mark_bp", "oracle_bp", "mid_bp"):
            v = [r[net][key] for r in rows if net in r and key in r[net]]
            if v:
                summ[f"{net}_{key}_median"] = statistics.median(v)
                summ[f"{net}_{key}_maxabs"] = max(abs(x) for x in v)
        f = [r[net]["funding_h"] for r in rows if net in r]
        if f:
            summ[f"{net}_funding_h_last"] = f[-1]
    summary[c] = summ
result["summary"] = summary

# Maintenance margin of the demo short on each network's BTC tiers.
for net in HL:
    t = result["coins"]["BTC"][net]["tiers"] if result["coins"]["BTC"][net] else None
    if t:
        result.setdefault("demo_short_mm", {})[net] = {"tiers": t, "mm_on_25k": mm(t, 25_000),
                                                      "mm_on_100k": mm(t, 100_000)}
json.dump(result, open(OUT, "w"), indent=1)

print("\nCoin   testnet: asset lev tiers | mainnet: asset lev | testnet mark/oracle vs exchanges (median, max) bp")
for c in coins:
    r, s = result["coins"][c], summary[c]
    if r["testnet"] is None:
        print(f"{c:6} NOT ON TESTNET | mainnet asset {r['mainnet']['asset']} lev {r['mainnet']['maxLeverage']}")
        continue
    tn, mn = r["testnet"], r["mainnet"]
    print(f"{c:6} {tn['asset']:5} {tn['maxLeverage']:3}x {tn['tiers']} | {mn['asset']:4} {mn['maxLeverage']:3}x | "
          f"mark {s.get('testnet_mark_bp_median', float('nan')):+8.1f} ({s.get('testnet_mark_bp_maxabs', float('nan')):7.1f}) "
          f"oracle {s.get('testnet_oracle_bp_median', float('nan')):+8.1f} ({s.get('testnet_oracle_bp_maxabs', float('nan')):7.1f}) "
          f"{'D' if tn['delisted'] else ''}{'I' if tn['onlyIsolated'] else ''} src={','.join(s['sources'])}")
print("\nBTC book (last sample):")
for net in HL:
    print(f"  {net}: {json.dumps(result['series'][-1]['btc_book'][net])}")
print("Demo short maintenance margin:", json.dumps(result.get("demo_short_mm")))
print("USDC spot token:", result["spot_usdc"])
