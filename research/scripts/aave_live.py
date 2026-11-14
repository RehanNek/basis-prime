"""Aave v3's live terms for USDC and bitcoin collateral (research/aave.md).

Usage: python3 -I aave_live.py <out.json>

Reads public data only, from Aave's own API (https://api.v3.aave.com/graphql): the Ethereum, Arbitrum and Base markets.
For each of USDC, USDT and the bitcoin tokens it prints the borrow rate, what is free to borrow, the rate curve and
caps, and for collateral the most Aave lends (LTV), where it liquidates (threshold) and the liquidator's bonus.
"""
import json, sys, urllib.request

API = "https://api.v3.aave.com/graphql"
QUERY = """
query($chains: [ChainId!]!) {
  markets(request: { chainIds: $chains }) {
    name
    address
    chain { chainId name }
    reserves {
      underlyingToken { symbol address }
      usdExchangeRate
      isFrozen
      isPaused
      supplyInfo { apy { value } maxLTV { value } liquidationThreshold { value } liquidationBonus { value } canBeCollateral supplyCapReached supplyCap { amount { value } usd } total { value } }
      borrowInfo { apy { value } total { amount { value } usd } availableLiquidity { amount { value } usd } utilizationRate { value } optimalUsageRate { value } baseVariableBorrowRate { value } variableRateSlope1 { value } variableRateSlope2 { value } reserveFactor { value } borrowCap { amount { value } usd } borrowingState }
    }
  }
}
"""

def post(variables):
    req = urllib.request.Request(API, data=json.dumps({"query": QUERY, "variables": variables}).encode(), headers={"Content-Type": "application/json", "User-Agent": "pb-research"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.load(r)

out = post({"chains": [1, 42161, 8453]})
if "errors" in out:
    raise SystemExit(json.dumps(out["errors"])[:1500])
keep = {"USDC", "WBTC", "cbBTC", "tBTC", "LBTC", "USDT", "USD₮0", "USDt"}
saved = []
pct = lambda v: None if v is None else float(v["value"]) * 100
for m in out["data"]["markets"]:
    print(f"\n== {m['name']} (chain {m['chain']['chainId']} {m['chain']['name']}) {m['address']}")
    for r in m["reserves"]:
        sym = r["underlyingToken"]["symbol"]
        if sym not in keep:
            continue
        s, b = r["supplyInfo"], r["borrowInfo"]
        row = {"market": m["name"], "chain": m["chain"]["chainId"], "symbol": sym, "address": r["underlyingToken"]["address"], "usd": float(r["usdExchangeRate"]),
               "frozen": r["isFrozen"], "paused": r["isPaused"], "supply": s, "borrow": b}
        saved.append(row)
        line = f"  {sym:6} ${float(r['usdExchangeRate']):>10,.2f}  LTV {pct(s['maxLTV']):5.1f}%  liq.threshold {pct(s['liquidationThreshold']):5.1f}%  bonus {pct(s['liquidationBonus']):5.2f}%  collateral {s['canBeCollateral']}  supplied {float(s['total']['value']):>16,.2f}  cap {float(s['supplyCap']['amount']['value']):>14,.0f}"
        if b:
            line += f"\n         borrow APY {pct(b['apy']):5.2f}%  borrowed ${float(b['total']['usd']):>15,.0f}  free ${float(b['availableLiquidity']['usd']):>14,.0f}  used {pct(b['utilizationRate']):5.1f}%  kink {pct(b['optimalUsageRate']):4.0f}%  base {pct(b['baseVariableBorrowRate']):.2f}% slope1 {pct(b['variableRateSlope1']):.2f}% slope2 {pct(b['variableRateSlope2']):.1f}%  reserve {pct(b['reserveFactor']):.0f}%  cap {float(b['borrowCap']['amount']['value']):>14,.0f}  {b['borrowingState']}"
        print(line)
json.dump(saved, open(sys.argv[1], "w"), indent=1)
