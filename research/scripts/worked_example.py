"""Worked example for the plan: how much USDC our own pool can lend a hedged client.

Client: $100k of nBTC held in their credit account, plus a $100k BTC short on Hyperliquid
with $35k USDC margin (2.9x). The pool lends USDC; the client takes it out of the account.
The question: how much can the pool lend under each risk option, and what does the pool
lose in the scenarios that hurt it?

Usage: python3 -I worked_example.py <data_dir>   (data_dir holds bn_BTCUSDT_1h.json)
"""
import json
import os
import sys

import numpy as np

D = sys.argv[1]

# Market and venue parameters (research, 2026-11-03).
P0 = 77_371.0                 # BTC price
MMR = 0.0125                  # Hyperliquid BTC maintenance margin (40x max)
FUND_APR = 0.058              # BTC funding, last-365-day mean
FUND_APR_STRESS = -0.247      # worst 7-day average since 2023
POOL_APR = 0.065              # our pool, Standard tier at 60% utilisation (see the rate model)
POOL_APR_STRESS = 0.50        # our pool at 100% utilisation
UNWIND_COST = 0.005 + 0.00045 # sell nBTC through 1Click (~0.5% at $100k) + Hyperliquid taker fee
IM_MULT = 1.25                # initial = 1.25 x maintenance requirement
EXTREME_POOL_LOSS = 0.05      # pool may lose at most 5% of the loan in extreme scenarios

SPOT = 100_000.0
Q = SPOT / P0                 # BTC units, spot and short
MARGIN = 35_000.0
EQUITY0 = SPOT + MARGIN
COLLATERAL = SPOT + MARGIN    # what tier caps apply to


def solve(feasible, lo=0.0, hi=EQUITY0):
    for _ in range(60):
        mid = (lo + hi) / 2
        if feasible(mid):
            lo = mid
        else:
            hi = mid
    return lo


def carry_reserve(w, days=7):
    return max(0.0, w * POOL_APR - SPOT * FUND_APR) * days / 365


# ---------------- Rhea alone, for comparison ----------------
rhea_max = SPOT * 0.80 * 0.95
rhea_safe = rhea_max / 1.2

# ---------------- Option A: hedge-aware haircuts ----------------
H_DIR, H_HEDGED, HL_VENUE = 0.25, 0.10, 0.05


def mr_a(w):
    hedged = min(SPOT, Q * P0)
    net = abs(SPOT - Q * P0)
    return H_DIR * net + H_HEDGED * hedged + HL_VENUE * MARGIN + carry_reserve(w)


w_a = solve(lambda w: EQUITY0 - w >= IM_MULT * mr_a(w))


# ---------------- Option B: stress grid with venue simulation ----------------
def scenario(w, move, basis=0.0, depeg=0.0, adl_second_leg=None, rate_stress=False, days=7):
    """Client equity loss and pool loss in one scenario, before any rebalance."""
    p = P0 * (1 + move)
    spot_v = Q * p * (1 + depeg)
    loss_extra = 0.0
    hedge_alive = True
    hl_eq = MARGIN + Q * (P0 - p * (1 + basis))
    mm = MMR * Q * p
    if adl_second_leg is not None:
        hedge_alive = False                      # ADL closes the short; price keeps moving
        spot_v = Q * p * (1 + adl_second_leg) * (1 + depeg)
    elif hl_eq < mm:
        hedge_alive = False
        if hl_eq < (2 / 3) * mm:
            loss_extra += max(hl_eq, 0.0)       # backstop keeps what is left
            hl_eq = 0.0
        else:
            loss_extra += 0.002 * Q * p          # book liquidation slippage
    apr = POOL_APR_STRESS if rate_stress else POOL_APR
    fund = FUND_APR_STRESS if rate_stress else FUND_APR
    carry = w * apr * days / 365 - (SPOT * fund * days / 365 if hedge_alive else 0.0)
    unwind = UNWIND_COST * spot_v
    eq = spot_v + max(hl_eq, 0.0) - w - loss_extra - carry - unwind
    client_loss = (EQUITY0 - w) - eq
    pool_loss = max(0.0, -eq)
    return client_loss, pool_loss


CORE = [dict(move=m, basis=b, depeg=d, rate_stress=r)
        for m in (-0.12, -0.08, -0.04, 0.0, 0.04, 0.08, 0.12)
        for b in (-0.003, 0.0, 0.003) for d in (0.0, -0.02) for r in (False, True)]
CORE += [dict(move=-0.08, adl_second_leg=-0.08), dict(move=-0.12, adl_second_leg=-0.06)]
EXTREME = [dict(move=-0.24), dict(move=0.24), dict(move=0.0, depeg=-0.20),
           dict(move=-0.24, depeg=-0.05)]


def mr_b(w):
    core = max(scenario(w, **s)[0] for s in CORE)
    ext = max(scenario(w, **s)[0] for s in EXTREME)
    return max(core, 0.5 * ext)


def b_ok(w):
    if EQUITY0 - w < IM_MULT * mr_b(w):
        return False
    if any(scenario(w, **s)[1] > 0 for s in CORE):
        return False
    if any(scenario(w, **s)[1] > EXTREME_POOL_LOSS * w for s in EXTREME):
        return False
    return True


w_b = solve(b_ok)
worst_b = sorted(((scenario(w_b, **s)[0] * (0.5 if s in EXTREME else 1.0), s)
                  for s in CORE + EXTREME), key=lambda x: -x[0])[:3]
pool_loss_b = max(scenario(w_b, **s)[1] for s in EXTREME)

# ---------------- Option C: filtered historical simulation + credit score ----------------
rows = json.load(open(os.path.join(D, "bn_BTCUSDT_1h.json")))
o = np.array([float(r[1]) for r in rows])
h = np.array([float(r[2]) for r in rows])
l = np.array([float(r[3]) for r in rows])
c = np.array([float(r[4]) for r in rows])
ret = np.diff(np.log(c), prepend=np.log(o[0]))
lam = 0.99
var = np.empty_like(ret)
var[0] = ret[:500].var()
for i in range(1, len(ret)):
    var[i] = lam * var[i - 1] + (1 - lam) * ret[i - 1] ** 2
sig = np.sqrt(var)
scale = np.clip(sig[-1] / sig, 0.25, 4.0)


def window_losses(w, hours=4, filtered=True):
    n = len(o) - hours
    lo = np.lib.stride_tricks.sliding_window_view(l, hours).min(axis=1)[:n]
    hi = np.lib.stride_tricks.sliding_window_view(h, hours).max(axis=1)[:n]
    down = lo / o[:n] - 1
    up = hi / o[:n] - 1
    if filtered:
        down, up = down * scale[:n], up * scale[:n]
    return np.array([max(scenario(w, float(down[i]))[0], scenario(w, float(up[i]))[0]) for i in range(n)])


def es(x, q):
    cut = np.quantile(x, q)
    return float(x[x >= cut].mean())


def mr_c(w):
    fhs = window_losses(w, filtered=True)
    raw = window_losses(w, filtered=False)
    hypothetical = 0.5 * max(scenario(w, **s)[0] for s in EXTREME)
    return max(es(fhs, 0.99), es(raw, 0.999), hypothetical)


grid = np.linspace(80_000, EQUITY0, 28)
c_ok = [w for w in grid if EQUITY0 - w >= IM_MULT * mr_c(w)]
w_c_capacity = max(c_ok) if c_ok else 0.0
SCORE_MULT_NEW_CLIENT = 0.8
w_c = SCORE_MULT_NEW_CLIENT * w_c_capacity

# ---------------- Tier caps (credit policy, any option) ----------------
TIERS = {"Standard": 0.70, "Preferred": 0.85}

print(f"BTC ${P0:,.0f}; client: ${SPOT:,.0f} nBTC in the account + ${SPOT:,.0f} BTC short on HL with "
      f"${MARGIN:,.0f} margin ({SPOT / MARGIN:.1f}x); equity ${EQUITY0:,.0f}")
print(f"For comparison, Rhea alone: ${rhea_max:,.0f} at HF 1.0, ${rhea_safe:,.0f} at HF 1.2")
print(f"Option A: pool can lend ${w_a:,.0f}; requirement ${mr_a(w_a):,.0f}")
print(f"Option B: pool can lend ${w_b:,.0f}; requirement ${mr_b(w_b):,.0f}; worst extreme pool loss "
      f"${pool_loss_b:,.0f} (budget {EXTREME_POOL_LOSS:.0%} of the loan, covered by the first-loss reserve)")
for loss, s in worst_b:
    print(f"   driver: loss ${loss:,.0f} in {s}")
print(f"Option C: capacity ${w_c_capacity:,.0f}; new-client multiplier {SCORE_MULT_NEW_CLIENT} -> ${w_c:,.0f}")
for name, cap in TIERS.items():
    print(f"Tier cap {name}: {cap:.0%} of collateral (${COLLATERAL:,.0f}) = ${cap * COLLATERAL:,.0f}")
print(f"Interest on a ${0.70 * COLLATERAL:,.0f} loan at {POOL_APR:.1%}: ${0.70 * COLLATERAL * POOL_APR:,.0f} a year "
      f"(Rhea's USDC would cost {0.1738:.1%}: ${0.70 * COLLATERAL * 0.1738:,.0f})")
