"""The Rhea warehouse in numbers (PLAN.md 5.10; research/rhea.md 11).

Usage:
  python3 -I rhea_warehouse.py <out.json>            read Rhea on mainnet now, save it, print the numbers
  python3 -I rhea_warehouse.py --replay <saved.json> print the numbers from a saved read

Reads public data only, and signs nothing:
- NEAR mainnet RPC (free.rpc.fastnear.com): contract.main.burrow.near's get_assets, get_token_pyth_info and get_config;
- Hyperliquid's info API (mainnet): BTC's oracle price.

It prints:
- Rhea's USDC rate now, and after we borrow or supply more (its own curve, checked against the live APRs);
- how the worked example's loan (PLAN.md 6.9) would split between Rhea and our pool at each safety cushion;
- how much Rhea could lend against nBTC before its nBTC cap fills;
- what a failed bridge would cost the pool, with and without Rhea ahead of it;
- what Rhea's liquidators would take if BTC fell with no top-up.
"""
import base64
import json
import math
import sys
import urllib.request

RPC = "https://free.rpc.fastnear.com"
BURROW = "contract.main.burrow.near"
HL_INFO = "https://api.hyperliquid.xyz/info"
TOKENS = {
    "USDC": ("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", 6),
    "nBTC": ("nbtc.bridge.near", 8),
    "USDT": ("usdt.tether-token.near", 6),
}
MS_YEAR = 31_536_000_000
# The worked example (PLAN.md 6.9): $100k of nBTC, a $100k BTC short, $35k of margin; our line; the pool's Standard rate at 60%.
C, MARGIN, LINE, POOL_RATE = 100_000, 35_000, 94_500, 0.065


def view(method, args):
    body = {"jsonrpc": "2.0", "id": 1, "method": "query", "params": {
        "request_type": "call_function", "finality": "final", "account_id": BURROW, "method_name": method,
        "args_base64": base64.b64encode(json.dumps(args).encode()).decode()}}
    req = urllib.request.Request(RPC, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "User-Agent": "pb-research"})
    with urllib.request.urlopen(req, timeout=20) as r:
        out = json.load(r)
    res = out.get("result", {})
    if "error" in out or "error" in res:
        raise SystemExit(f"{method}: {json.dumps(out)[:400]}")
    return json.loads(bytes(res["result"]).decode()), res["block_height"]


def read_live():
    assets, block = view("get_assets", {"token_ids": [t for t, _ in TOKENS.values()]})
    by = {a["token_id"]: a for a in assets}
    out = {"block": block, "contract": BURROW, "assets": {}, "pyth": {}}
    for name, (tid, dec) in TOKENS.items():
        a, cfg = by[tid], by[tid]["config"]
        inner = dec + cfg.get("extra_decimals", 0)
        f = lambda x: int(x) / 10 ** inner  # noqa: E731
        supplied, borrowed = f(a["supplied"]["balance"]), f(a["borrowed"]["balance"])
        pool = supplied + f(a.get("reserved", "0")) + f(a.get("prot_fee", "0"))
        out["assets"][name] = {
            "supplied": supplied, "borrowed": borrowed, "available": pool - borrowed,
            "borrow_apr": float(a["borrow_apr"]), "supply_apr": float(a["supply_apr"]),
            "volatility_ratio": cfg["volatility_ratio"], "reserve_ratio": cfg["reserve_ratio"],
            "target_utilization": cfg["target_utilization"],
            # Per-millisecond rates, as 27-decimal fixed point: kept as text so nothing is lost.
            "target_utilization_rate": cfg["target_utilization_rate"], "max_utilization_rate": cfg["max_utilization_rate"],
            "supplied_limit": f(cfg["supplied_limit"]), "borrowed_limit": f(cfg["borrowed_limit"]),
        }
        out["pyth"][name] = view("get_token_pyth_info", {"token_id": tid})[0]
    cfg, _ = view("get_config", {})
    out["config"] = {k: cfg[k] for k in ("contract_mode", "pyth_oracle_account_id", "pyth_price_valid_duration_sec", "force_closing_enabled")}
    req = urllib.request.Request(HL_INFO, data=json.dumps({"type": "metaAndAssetCtxs"}).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        meta, ctxs = json.load(r)
    i = next(k for k, u in enumerate(meta["universe"]) if u["name"] == "BTC")
    out["btc"] = {"oracle_px": float(ctxs[i]["oraclePx"]), "funding_hourly": float(ctxs[i]["funding"])}
    return out


def report(live):
    U, N, T = (live["assets"][k] for k in ("USDC", "nBTC", "USDT"))
    btc = live["btc"]["oracle_px"]
    ltv = N["volatility_ratio"] * U["volatility_ratio"] / 1e8
    target = U["target_utilization"] / 10_000
    reserve = U["reserve_ratio"] / 10_000
    over = lambda text: (int(text) - 10 ** 27) / 1e27  # noqa: E731  the per-ms rate above 1
    et, emax = over(U["target_utilization_rate"]), over(U["max_utilization_rate"])

    def borrow_apr(util):
        e = et * util / target if util <= target else et + (emax - et) * (util - target) / (1 - target)
        return math.expm1(e * MS_YEAR)

    B, sup, den = U["borrowed"], U["supplied"], U["borrowed"] + U["available"]

    def after(borrow=0.0, supply=0.0):
        util = (B + borrow) / (den + supply)
        b = borrow_apr(util)
        return util, b, b * (B + borrow) / (sup + supply) * (1 - reserve)

    u0, b0, s0 = after()
    print(f"Rhea at block {live['block']:,} ({live['config']['contract_mode']}); BTC ${btc:,.0f}; funding {live['btc']['funding_hourly']*24*365*100:.2f}% a year")
    print(f"USDC now: {u0*100:.2f}% lent out, ${U['available']:,.0f} free; borrow {U['borrow_apr']*100:.2f}% (curve {b0*100:.2f}%), supply {U['supply_apr']*100:.2f}% (curve {s0*100:.2f}%)")
    print(f"USDT now: borrow {T['borrow_apr']*100:.2f}%, ${T['available']:,.0f} free")
    print(f"nBTC is priced by Pyth id {live['pyth']['nBTC']['price_identifier'][:8]}… (BTC/USD is e62df6c8…): Rhea values nBTC as BTC")

    print("\nIf we borrow more USDC from Rhea:")
    for x in (50_667, 100_000, 250_000, 500_000, 1_000_000):
        util, b, _ = after(borrow=x)
        print(f"  +${x:>9,}: {util*100:5.2f}% lent out, borrow {b*100:5.2f}%")
    print("If we supply idle USDC to Rhea:")
    for x in (50_000, 100_000, 300_000, 1_000_000):
        util, b, s = after(supply=x)
        print(f"  +${x:>9,}: {util*100:5.2f}% lent out, borrow {b*100:5.2f}%, supply {s*100:5.2f}%")

    rhea = U["borrow_apr"]
    print(f"\nThe worked example: Rhea's most is ${C*ltv:,.0f} ({ltv*100:.0f}%), our line ${LINE:,}")
    print("  cushion  Rhea     pool     overall  interest/yr  BTC fall before Rhea sells  hedge must earn")
    for hf in (1.2, 1.5, 1.75, 2.0, 2.5):
        r = C * ltv / hf
        interest = r * rhea + (LINE - r) * POOL_RATE
        print(f"  {hf:<7}  {r:>7,.0f}  {LINE-r:>7,.0f}  {interest/LINE*100:6.2f}%  {interest:>10,.0f}  {(1-1/hf)*100:10.1f}%               {interest/C*100:5.2f}%")
    print(f"  pool alone: ${LINE:,} at {POOL_RATE*100:.1f}% = ${LINE*POOL_RATE:,.0f} a year; the hedge must earn {LINE*POOL_RATE/C*100:.2f}%")
    print(f"  Rhea alone at a 1.2 cushion: ${C*ltv/1.2:,.0f} at {rhea*100:.2f}% = ${C*ltv/1.2*rhea:,.0f} a year")

    room = N["supplied_limit"] - N["supplied"]
    print(f"\nRhea's nBTC cap: {N['supplied_limit']:.0f}, of which {N['supplied']:.4f} used: room for {room:.3f} nBTC = ${room*btc:,.0f}")
    for hf in (1.2, 1.5, 2.0):
        debt = room * btc * ltv / hf
        print(f"  all of it at a {hf} cushion: ${debt:,.0f} of USDC, {debt/(C*ltv/hf):.1f} worked-example clients; Rhea's rate would be {after(borrow=debt)[1]*100:.1f}%")

    r15 = C * ltv / 1.5
    print(f"\nIf nBTC failed outright: the pool alone loses ${LINE-MARGIN:,} of ${LINE:,}; behind Rhea (1.5) it loses ${max(0, LINE-r15-MARGIN):,.0f} of ${LINE-r15:,.0f}, and Rhea loses ${r15:,.0f}")
    alone = LINE * C / (C + MARGIN)
    behind = (LINE - r15) * (C - r15) / (C - r15 + MARGIN)
    print(f"Loans resting on nBTC (RISK_ENGINE.md 12.1): ${alone:,.0f} a client alone; ${behind:,.0f} counting only the pool's part behind Rhea: {alone/behind:.2f}x")
    k = 1_000_000
    n0, n1 = 0.30 * k / alone, min(0.30 * k / behind, room * btc / C)
    print(f"A $1M pool under the 30% nBTC cap: alone {n0:.1f} clients, ${n0*LINE:,.0f} lent. With Rhea: {n1:.1f} clients (Rhea's own cap binds first), ${n1*LINE:,.0f} lent, ${n1*(LINE-r15):,.0f} of it ours")

    lo, hi = 0.0, 1.0
    pool_rate = lambda u: 0.02 + (0.06 * u / 0.8 if u <= 0.8 else 0.06 + 0.44 * (u - 0.8) / 0.2)  # noqa: E731  Standard tier
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if pool_rate(mid) < rhea else (lo, mid)
    print(f"\nOur pool's Standard rate reaches Rhea's {rhea*100:.2f}% when the pool is {lo*100:.1f}% lent out")

    print("\nBTC falls and nothing is topped up (liquidators hold Rhea's health at 1.0, taking 0.3% off):")
    for hf, x in ((1.5, 0.40), (1.75, 0.50), (2.0, 0.40)):
        debt, left, d = C * ltv / hf, C * (1 - x), 0.003
        repaid = max(0.0, (debt - ltv * left) / (1 - ltv / (1 - d)))
        taken = repaid / (1 - d)
        print(f"  cushion {hf}, BTC -{x*100:.0f}%: ${repaid:,.0f} repaid ({repaid/debt*100:.0f}% of Rhea's loan), ${taken:,.0f} of nBTC taken ({taken/left*100:.0f}% of it); the discount costs ${taken-repaid:,.0f}; a 20% bounce on the short left uncovered costs ${taken*0.20:,.0f}")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--replay":
        report(json.load(open(sys.argv[2])))
    elif len(sys.argv) == 2:
        data = read_live()
        json.dump(data, open(sys.argv[1], "w"), indent=1)
        report(data)
    else:
        raise SystemExit(__doc__)
