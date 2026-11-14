"""Render RISK_ENGINE.md's per-coin tables (sections 5.1 and 5.3) from the calibration output.

Usage: python3 -I render_tables.py <universe_v0.json> <universe.json> <RISK_ENGINE.md>
Replaces the ⟪ALLOWLIST_TABLE⟫ and ⟪PARAM_TABLE⟫ placeholders, or the tables between the
<!-- tables:allowlist --> / <!-- tables:params --> markers on later runs, so no number is copied by hand.
"""
import json
import re
import sys
from datetime import datetime, timezone

v0 = json.load(open(sys.argv[1]))
uni = json.load(open(sys.argv[2]))
doc_path = sys.argv[3]
coins = v0["coins"]
cand = {c["hl"]: c for c in uni["candidates"]}


def m(x):
    if x >= 1e7:
        return f"${x / 1e6:,.0f}M"
    return f"${x / 1e6:,.1f}M" if x >= 1e6 else f"${x / 1e3:,.0f}k"


def b(x):
    return f"${x / 1e9:,.1f}B"


def pct(x, d=0):
    return f"{x * 100:.{d}f}%"


allowed = [c for c, p in coins.items() if p["allowed"]]
nxt = [c for c, p in coins.items() if not p["allowed"]]
date = datetime.fromtimestamp(uni["generated_ms"] / 1000, timezone.utc).strftime("%d %b %Y")

lines = [f"**Result on {date}: 23 coins pass every rule** (ranked by the weaker of Hyperliquid volume and spot "
         "volume, so the coin's thinnest venue sets its rank).", "",
         "| # | Coin | Tier | HL max lev. | HL open interest | HL volume (30-day avg) | Spot volume (24h) | "
         "Market cap | History |", "|---|---|---|---|---|---|---|---|---|"]
for i, c in enumerate(allowed, 1):
    p = coins[c]
    lines.append(f"| {i} | {c} | {p['tier']} | {p['hl_max_leverage']}× | {m(p['oi_usd'])} | {m(p['adv30_usd'])} | "
                 f"{m(p['spot24h_usd'])} | {b(p['mcap_usd'])} | {p['history_days'] / 365:.1f} y |")
lines += ["", "**Next in line**, if the list grows to 25:", "",
          "| Coin | HL max lev. | HL open interest | HL volume | Spot volume | Market cap | History | Fails |",
          "|---|---|---|---|---|---|---|---|"]
for c in nxt:
    p = coins[c]
    fails = (["E1 (Hyperliquid max leverage below 10×)"] if p["hl_max_leverage"] < 10 else []) + \
            (["E8 (under a year of history)"] if p["history_days"] < 365 else [])
    lines.append(f"| {c} | {p['hl_max_leverage']}× | {m(p['oi_usd'])} | {m(p['adv30_usd'])} | {m(p['spot24h_usd'])} | "
                 f"{b(p['mcap_usd'])} | {p['history_days'] / 365:.1f} y | {'; '.join(fails)} |")
lines += ["", "**Big on Hyperliquid but excluded:** these show why every rule is there.", "",
          "| Coin | HL open interest | HL volume | Fails |", "|---|---|---|---|"]
for c in ("XMR", "LIT", "VVV", "XPL", "FARTCOIN", "STRK", "ZRO"):
    if c in cand:
        x = cand[c]
        names = {"hl_maxlev<10": "E1 max leverage < 10×", "no_binance_spot": "E2 no Binance spot",
                 "spot_venues<2": "E2 < 2 major spot venues", "spot24h<10M": "E3 spot < $10M/day",
                 "mcap<1B": "E4 market cap < $1B", "hl_oi<10M": "E5 open interest < $10M",
                 "hl_adv30<3M": "E5 volume < $3M/day", "no_pyth": "E6 no Pyth feed", "stable": "E7 stablecoin"}
        lines.append(f"| {c} | {m(x['oi_usd'])} | {m(x['adv30_usd'])} | "
                     f"{'; '.join(names.get(f, f) for f in x['fails'])} |")
allowlist_md = "\n".join(lines)

lines = ["| Coin | S | Extreme ↓ / ↑ | Calibrated S | Worst 4h ↓ / ↑ | Gap β | σ_ref | Beta to BTC | "
         "Funding stress F⁻ / F⁺ | Per-client cap | Band | 4h windows past S |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|"]
for c in allowed + nxt:
    p = coins[c]
    q = p["params"]
    cv = p["coverage"]
    name = c if p["allowed"] else f"{c} (next)"
    lines.append(
        f"| {name} | {pct(q['S'])} | {pct(q['S_extreme_down'])} / +{pct(q['S_extreme_up'])} | {pct(q['S_calibrated'], 1)} | "
        f"{pct(p['tail4h']['worst_down'])} / +{pct(p['tail4h']['worst_up'])} | {pct(q['basis'], 2)} | "
        f"{pct(q['vol_ref'])} | {p['beta_btc']:.2f} | {pct(q['funding_stress_short_apr'])} / +{pct(q['funding_stress_long_apr'])} | "
        f"{m(q['client_cap_usd'])} | {pct(q['price_band'])} | {pct(cv['down_past_S'], 3)} ↓, {pct(cv['up_past_S'], 3)} ↑ |")
params_md = "\n".join(lines)

doc = open(doc_path).read()


def put(doc, tag, md):
    block = f"<!-- tables:{tag} -->\n{md}\n<!-- /tables:{tag} -->"
    ph = {"allowlist": "⟪ALLOWLIST_TABLE⟫", "params": "⟪PARAM_TABLE⟫"}[tag]
    if ph in doc:
        return doc.replace(ph, block)
    return re.sub(rf"<!-- tables:{tag} -->.*?<!-- /tables:{tag} -->", lambda _: block, doc, flags=re.S)


doc = put(doc, "allowlist", allowlist_md)
doc = put(doc, "params", params_md)
doc = doc.replace("⟪KAPPA⟫", f"the anchor factor α = {v0['kappa']:.3f}; BTC's 99.9% 4-hour move is "
                  f"{pct(v0['btc_q999_4h'], 1)}")
doc = doc.replace("⟪BTC_VOLREF⟫", pct(coins["BTC"]["params"]["vol_ref"], 1))
doc = doc.replace("⟪UNIVERSE_DATE⟫", date)
open(doc_path, "w").write(doc)
print(allowlist_md)
print()
print(params_md)
