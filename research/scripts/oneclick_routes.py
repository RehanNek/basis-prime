"""1Click's routes between NEAR and Aave's chains (research/aave.md).

Usage: python3 -I oneclick_routes.py

Reads public data only, from 1Click (https://1click.chaindefuser.com): the token list, then dry quotes, which move
nothing, for the routes an Aave loan needs: nBTC to wrapped bitcoin on Ethereum and Base and back, USDC between those
chains and NEAR, and a little ETH for gas. It sends no key, so the prices include 1Click's extra 0.25% fee.
"""
import json, sys, urllib.request, datetime

API = "https://1click.chaindefuser.com"

def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "pb-research"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

status, tokens = call("GET", "/v0/tokens")
print("tokens:", status, len(tokens))
want = [t for t in tokens if t.get("symbol", "").upper() in ("WBTC", "CBBTC", "NBTC", "BTC", "XBTC") or (t.get("symbol", "").upper() == "USDC" and t.get("blockchain") in ("eth", "arb", "base", "near")) or (t.get("symbol","").upper()=="ETH" and t.get("blockchain") in ("eth","arb","base"))]
for t in sorted(want, key=lambda t: (t["symbol"], t["blockchain"])):
    print(f"  {t['symbol']:6} {t['blockchain']:6} dec {t['decimals']:2}  {t['assetId']}  px {t.get('price')}")
ids = {(t["symbol"].upper(), t["blockchain"]): t for t in want}
deadline = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
EVM = "0xce4bd513b9457d3cfa29b804fba54b11193a2f4d"   # the address our 5 Nov dry quotes used; a dry quote moves nothing
NEAR = "aurora"                                       # likewise
def quote(label, a, b, human, recipient, refund):
    if a not in ids or b not in ids:
        print(f"{label}: route tokens not listed ({a in ids}, {b in ids})"); return
    A, B = ids[a], ids[b]
    amount = str(int(human * 10 ** A["decimals"]))
    status, q = call("POST", "/v0/quote", {"dry": True, "swapType": "EXACT_INPUT", "slippageTolerance": 100, "originAsset": A["assetId"], "depositType": "ORIGIN_CHAIN",
                                          "destinationAsset": B["assetId"], "amount": amount, "recipient": recipient, "recipientType": "DESTINATION_CHAIN",
                                          "refundTo": refund, "refundType": "ORIGIN_CHAIN", "deadline": deadline})
    if status != 201 and status != 200 or "quote" not in q:
        print(f"{label}: HTTP {status} {json.dumps(q)[:160]}"); return
    qq = q["quote"]
    cost = (1 - float(qq["amountOutUsd"]) / float(qq["amountInUsd"])) * 100 if qq.get("amountInUsd") and qq.get("amountOutUsd") else float("nan")
    print(f"{label}: in {qq['amountInFormatted']} (${float(qq.get('amountInUsd',0)):,.0f}) -> out {qq['amountOutFormatted']} (${float(qq.get('amountOutUsd',0)):,.0f}); cost {cost:.2f}%; about {qq.get('timeEstimate')} s")
NB = ("BTC", "near")
btc_px = float(ids[NB]["price"])
for size in (10_000, 100_000, 500_000):
    quote(f"nBTC (NEAR) -> WBTC (Ethereum), ${size:,}", NB, ("WBTC","eth"), size / btc_px, EVM, NEAR)
for size in (10_000, 100_000, 500_000):
    quote(f"nBTC (NEAR) -> cbBTC (Base), ${size:,}", NB, ("CBBTC","base"), size / btc_px, EVM, NEAR)
quote("nBTC (NEAR) -> cbBTC (Ethereum), $100,000", NB, ("CBBTC","eth"), 100_000 / btc_px, EVM, NEAR)
quote("WBTC (Ethereum) -> nBTC (NEAR), $100,000", ("WBTC","eth"), NB, 100_000 / btc_px, NEAR, EVM)
quote("cbBTC (Base) -> nBTC (NEAR), $100,000", ("CBBTC","base"), NB, 100_000 / btc_px, NEAR, EVM)
quote("USDC (NEAR) -> WBTC (Ethereum), $100,000", ("USDC","near"), ("WBTC","eth"), 100_000, EVM, NEAR)
quote("USDC (NEAR) -> cbBTC (Base), $100,000", ("USDC","near"), ("CBBTC","base"), 100_000, EVM, NEAR)
quote("USDC (Ethereum) -> USDC (NEAR), $50,000", ("USDC","eth"), ("USDC","near"), 50_000, NEAR, EVM)
quote("USDC (Base) -> USDC (NEAR), $50,000", ("USDC","base"), ("USDC","near"), 50_000, NEAR, EVM)
quote("USDC (NEAR) -> USDC (Base), $20,000", ("USDC","near"), ("USDC","base"), 20_000, EVM, NEAR)
