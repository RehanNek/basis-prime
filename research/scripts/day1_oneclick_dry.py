"""Phase 0 check: 1Click capacity, minimums and sale costs, from DRY quotes only (PLAN.md section 13).

Usage: python3 -I day1_oneclick_dry.py <out.json>

Every request has "dry": true, so no deposit address is created and nothing can be sent. If the environment has
ONECLICK_JWT (our partner key, from .env), it is sent as X-API-Key and the quotes use our fee schedule; without
it they are public quotes, which carry a higher fee on non-stablecoin routes (research/intents.md).

Recipients are placeholders, because a dry quote moves nothing: the NEAR account `aurora` (used in the 3 Nov
quotes) and a random address made fresh for each run as the Hyperliquid address. 1Click refuses the burn address
0x...dEaD ("recipient is not valid").

Stops at the first 403 or 429 rather than retrying: the API's protection is not something to work around.
"""
import datetime
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request

OUT = sys.argv[1]
API = "https://1click.chaindefuser.com/v0"
UA = "pb-research/0.1"
KEY = os.environ.get("ONECLICK_JWT", "").strip()
HL_USDC = "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054"   # 8 decimals
NEAR_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"   # 6 decimals
NBTC, ETHB, USDT = "nep141:nbtc.bridge.near", "nep141:eth.bridge.near", "nep141:usdt.tether-token.near"
WNEAR = "nep141:wrap.near"
NEAR_ACCT, HL_ADDR = "aurora", "0x" + secrets.token_hex(20)


def call(url, body=None):
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if KEY:
        headers["X-API-Key"] = KEY
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=headers)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            status, raw = r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read().decode(errors="replace")
    try:
        data = json.loads(raw)
    except ValueError:
        data = raw[:300]
    return status, data, round(time.time() - t0, 2)


def mid(url, bid, ask):
    s, d, _ = call(url)
    return (float(d[bid]) + float(d[ask])) / 2 if s == 200 else None


status, tokens, _ = call(f"{API}/tokens")
if status != 200:
    raise SystemExit(f"/v0/tokens answered HTTP {status}: {tokens}")
tok = {t["assetId"]: t for t in tokens}
dec = {a: tok[a]["decimals"] for a in (HL_USDC, NEAR_USDC, NBTC, ETHB, USDT, WNEAR)}
px = {a: float(tok[a]["price"]) for a in (NBTC, ETHB, USDT, WNEAR)}
market = {"BTC": mid("https://api.exchange.coinbase.com/products/BTC-USD/ticker", "bid", "ask"),
          "ETH": mid("https://api.exchange.coinbase.com/products/ETH-USD/ticker", "bid", "ask"),
          "NEAR": mid("https://api.exchange.coinbase.com/products/NEAR-USD/ticker", "bid", "ask")}
s, k, _ = call("https://api.kraken.com/0/public/Ticker?pair=USDTUSD")
kr = next(iter(k["result"].values())) if s == 200 and isinstance(k, dict) and k.get("result") else None
market["USDT"] = (float(kr["a"][0]) + float(kr["b"][0])) / 2 if kr else None   # USDT is valued at its market price


def units(asset, usd):
    """Token units for a USD amount, at 1Click's own token price (stablecoins at par)."""
    p = px.get(asset, 1.0)
    return str(int(round(usd / p * 10 ** dec[asset])))


def body(origin, dest, usd, recipient, refund):
    deadline = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=10))
    b = {"dry": True, "originAsset": origin, "destinationAsset": dest, "amount": units(origin, usd),
         "recipient": recipient, "refundTo": refund, "deadline": deadline.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
         "slippageTolerance": 100, "swapType": "EXACT_INPUT", "depositType": "ORIGIN_CHAIN",
         "recipientType": "DESTINATION_CHAIN", "refundType": "ORIGIN_CHAIN"}
    assert b["dry"] is True
    return b


ROUTES = (
    [("Hyperliquid USDC -> NEAR USDC", HL_USDC, NEAR_USDC, usd, NEAR_ACCT, HL_ADDR)
     for usd in (2, 5, 10, 1_000, 5_000, 10_000, 25_000, 50_000)]
    + [("NEAR USDC -> Hyperliquid USDC", NEAR_USDC, HL_USDC, usd, HL_ADDR, NEAR_ACCT)
       for usd in (2, 5, 10, 25_000, 50_000)]
    + [("nBTC -> NEAR USDC", NBTC, NEAR_USDC, usd, NEAR_ACCT, NEAR_ACCT)
       for usd in (10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000)]
    + [("ETH (bridged) -> NEAR USDC", ETHB, NEAR_USDC, usd, NEAR_ACCT, NEAR_ACCT)
       for usd in (10_000, 50_000, 100_000, 250_000, 500_000)]
    + [("USDT -> NEAR USDC", USDT, NEAR_USDC, usd, NEAR_ACCT, NEAR_ACCT) for usd in (10_000, 100_000, 500_000, 1_000_000)]
    + [("wNEAR -> NEAR USDC", WNEAR, NEAR_USDC, usd, NEAR_ACCT, NEAR_ACCT) for usd in (10_000, 50_000, 100_000, 250_000, 500_000)]
)

out = {"generated_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
       "keyed": bool(KEY), "token_prices": {k: tok[k]["price"] for k in px}, "market_mid": market, "quotes": []}
print(f"keyed: {bool(KEY)} | 1Click prices nBTC {px[NBTC]:,.2f} ETH {px[ETHB]:,.2f} USDT {px[USDT]:.5f} | "
      f"market BTC {market['BTC']:,.2f} ETH {market['ETH']:,.2f} USDT {market['USDT']:.5f} (Coinbase, Kraken)")
for name, origin, dest, usd, rcpt, refund in ROUTES:
    b = body(origin, dest, usd, rcpt, refund)
    s, d, dt = call(f"{API}/quote", b)
    row = {"route": name, "usd": usd, "http": s, "seconds": dt, "request": b}
    q = d.get("quote") if isinstance(d, dict) else None
    if q:
        out_units = int(q["amountOut"]) / 10 ** dec[dest]
        row.update({k: q.get(k) for k in ("amountIn", "amountOut", "minAmountOut", "amountInUsd", "amountOutUsd",
                                          "timeEstimate", "refundFee", "withdrawFee")})
        group = {NBTC: "BTC", ETHB: "ETH", USDT: "USDT", WNEAR: "NEAR"}.get(origin)
        fair = (int(b["amount"]) / 10 ** dec[origin]) * (market[group] if group else 1.0)
        row["cost_vs_market"] = 1 - out_units / fair
        msg = f"out {out_units:,.2f}, cost {row['cost_vs_market']:+.3%} vs market, ~{q.get('timeEstimate')} s"
    else:
        row["error"] = d
        msg = f"no quote: {json.dumps(d)[:160]}"
    out["quotes"].append(row)
    print(f"{name:32} ${usd:>9,}: HTTP {s} {msg}", flush=True)
    if s in (403, 429):
        print("stopping: the API refused us; not retrying")
        break
    time.sleep(1.5)
json.dump(out, open(OUT, "w"), indent=1)
