"""Worked example for the plan: how much USDC each risk option lets a hedged client borrow.

Client: $100k of nBTC posted as Rhea collateral, plus a $100k BTC short on Hyperliquid
with $35k USDC margin (2.9x). The question: how much USDC can the client borrow from Rhea
and take out, and how much collateral must the broker post so Rhea stays safe?

Usage: python3 -I worked_example.py <data_dir>   (data_dir holds bn_BTCUSDT_1h.json)
"""
import json
import os
import sys

import numpy as np

D = sys.argv[1]

# Market and venue parameters (research, 2026-11-03).
P0 = 77_371.0                 # BTC price
VOL_NBTC, VOL_USDC = 0.80, 0.95   # Rhea volatility ratios
MMR = 0.0125                  # Hyperliquid BTC maintenance margin (40x max)
BORROW_APR = 0.1738           # Rhea USDC borrow APY today
BORROW_APR_STRESS = 0.50      # Rhea stablecoin APY at 100% utilisation
FUND_APR = 0.058              # BTC funding, last-365-day mean
FUND_APR_STRESS = -0.247      # worst 7-day average since 2023
IM_MULT = 1.25                # initial = 1.25 x maintenance requirement

SPOT = 100_000.0
Q = SPOT / P0                 # BTC units, spot and short
MARGIN = 35_000.0
EQUITY0 = SPOT + MARGIN


def rhea_hf(spot_value, broker_usdc, debt):
    if debt <= 0:
        return float("inf")
    return (spot_value * VOL_NBTC + broker_usdc * VOL_USDC) / (debt / VOL_USDC)


def broker_for_hf(w, spot_value, hf):
    """USDC the broker must post so Rhea's health factor equals hf."""
    return max(0.0, (hf * w / VOL_USDC - spot_value * VOL_NBTC) / VOL_USDC)


def solve(feasible, lo=0.0, hi=EQUITY0):
    for _ in range(60):
        mid = (lo + hi) / 2
        if feasible(mid):
            lo = mid
        else:
            hi = mid
    return lo


def carry_reserve(w, days=7):
    return max(0.0, w * BORROW_APR - SPOT * FUND_APR) * days / 365


# ---------------- Rhea alone ----------------
rhea_max = SPOT * VOL_NBTC * VOL_USDC
rhea_safe = rhea_max / 1.2

# ---------------- Option A: hedge-aware haircuts ----------------
H_DIR, H_HEDGED, HL_VENUE = 0.25, 0.10, 0.05


def mr_a(w):
    hedged = min(SPOT, Q * P0)
    net = abs(SPOT - Q * P0)
    return H_HEDGED * hedged + H_DIR * net + HL_VENUE * MARGIN + carry_reserve(w)


w_a = solve(lambda w: EQUITY0 - w >= IM_MULT * mr_a(w))
u_a = broker_for_hf(w_a, SPOT, 1.2)


# ---------------- Option B: stress grid with venue simulation ----------------
def scenario_loss(w, u, move, basis=0.0, depeg=0.0, adl_second_leg=None, rate_stress=False, days=7):
    """Client equity loss and broker loss in one scenario, before any rebalance."""
    p = P0 * (1 + move)
    spot_v = Q * p * (1 + depeg)
    loss_extra = 0.0
    hedge_alive = True
    # Hyperliquid leg: the short loses when price rises; basis moves the perp against us.
    hl_eq = MARGIN + Q * (P0 - p * (1 + basis))
    mm = MMR * Q * p
    if adl_second_leg is not None:
        # ADL closes the short at this price (profit kept), then price moves again unhedged.
        hedge_alive = False
        p2 = p * (1 + adl_second_leg)
        spot_v = Q * p2 * (1 + depeg)
    elif hl_eq < mm:
        hedge_alive = False
        if hl_eq < (2 / 3) * mm:
            loss_extra += max(hl_eq, 0.0)       # backstop keeps what is left
            hl_eq = 0.0
        else:
            loss_extra += 0.002 * Q * p          # book liquidation slippage
    # Rhea leg.
    hf = rhea_hf(spot_v, u, w)
    if hf < 1:
        loss_extra += (1 - hf) / 2 * w          # liquidation discount, upper-bound estimate
    apr = BORROW_APR_STRESS if rate_stress else BORROW_APR
    fund = FUND_APR_STRESS if rate_stress else FUND_APR
    carry = w * apr * days / 365 - (SPOT * fund * days / 365 if hedge_alive else 0.0)
    eq = spot_v + max(hl_eq, 0.0) - w - loss_extra - carry
    client_loss = (EQUITY0 - w) - eq
    broker_loss = max(0.0, -eq)
    return client_loss, broker_loss, hf, hl_eq >= mm


CORE = [dict(move=m, basis=b, depeg=d, rate_stress=r)
        for m in (-0.12, -0.08, -0.04, 0.0, 0.04, 0.08, 0.12)
        for b in (-0.003, 0.0, 0.003) for d in (0.0, -0.02) for r in (False, True)]
CORE += [dict(move=-0.08, adl_second_leg=-0.08), dict(move=-0.12, adl_second_leg=-0.06)]
EXTREME = [dict(move=-0.24), dict(move=0.24), dict(move=0.0, depeg=-0.20),
           dict(move=-0.24, depeg=-0.05)]


def b_broker_needed(w):
    """Smallest broker USDC that keeps Rhea above 1.0 in every core scenario."""
    worst_spot = min(Q * P0 * (1 + s["move"]) * (1 + s.get("depeg", 0.0)) *
                     (1 + (s.get("adl_second_leg") or 0.0)) for s in CORE)
    return broker_for_hf(w, worst_spot, 1.0)


def mr_b(w):
    u = b_broker_needed(w)
    core = max(scenario_loss(w, u, **s)[0] for s in CORE)
    ext = max(scenario_loss(w, u, **s)[0] for s in EXTREME)
    liquidity = 0.00045 * Q * P0 + 0.0001 * MARGIN + 0.2
    return max(core, 0.5 * ext) + liquidity, u


def b_ok(w, broker_budget_frac=0.0):
    mr, u = mr_b(w)
    if EQUITY0 - w < IM_MULT * mr:
        return False
    if any(scenario_loss(w, u, **s)[1] > 0 for s in CORE):
        return False
    if any(scenario_loss(w, u, **s)[1] > broker_budget_frac * u for s in EXTREME):
        return False
    return True


w_b = solve(lambda w: b_ok(w, 0.10))
mr_b_val, u_b = mr_b(w_b)
worst_b = sorted(((scenario_loss(w_b, u_b, **s)[0] * (0.5 if s in EXTREME else 1.0), s)
                  for s in CORE + EXTREME), key=lambda x: -x[0])[:3]

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
scale = np.clip(sig[-1] / sig, 0.25, 4.0)      # filter: today's vol over the vol of the day


def window_losses(w, u, hours=4, filtered=True):
    n = len(o) - hours
    lo = np.lib.stride_tricks.sliding_window_view(l, hours).min(axis=1)[:n]
    hi = np.lib.stride_tricks.sliding_window_view(h, hours).max(axis=1)[:n]
    down = lo / o[:n] - 1
    up = hi / o[:n] - 1
    if filtered:
        down, up = down * scale[:n], up * scale[:n]
    losses = np.empty(n)
    for i in range(n):
        a = scenario_loss(w, u, float(down[i]))[0]
        b = scenario_loss(w, u, float(up[i]))[0]
        losses[i] = max(a, b)
    return losses


def es(x, q):
    cut = np.quantile(x, q)
    return float(x[x >= cut].mean())


def mr_c(w):
    u = b_broker_needed(w)
    fhs = window_losses(w, u, hours=4, filtered=True)
    raw = window_losses(w, u, hours=4, filtered=False)
    stressed = es(raw, 0.999)                       # stressed ES from raw history, 99.9% tail
    hypothetical = 0.5 * max(scenario_loss(w, u, **s)[0] for s in EXTREME)
    return max(es(fhs, 0.99), stressed, hypothetical) + 0.00045 * Q * P0, u


grid = np.linspace(40_000, EQUITY0, 24)
c_ok = [w for w in grid if EQUITY0 - w >= IM_MULT * mr_c(w)[0]]
w_c_capacity = max(c_ok) if c_ok else 0.0
_, u_c = mr_c(w_c_capacity)
SCORE_MULT_NEW_CLIENT = 0.8                       # score ~600 of 1000: no history yet
w_c = SCORE_MULT_NEW_CLIENT * w_c_capacity
u_c_new = b_broker_needed(w_c)

# ---------------- Skin-in-the-game cap (credit policy, any option) ----------------
w_skin = solve(lambda w: broker_for_hf(w, SPOT, 1.2) <= EQUITY0 - w)

print(f"BTC ${P0:,.0f}; client: ${SPOT:,.0f} nBTC on Rhea + ${SPOT:,.0f} BTC short on HL with ${MARGIN:,.0f} margin "
      f"({SPOT / MARGIN:.1f}x); equity ${EQUITY0:,.0f}")
print(f"Rhea alone: max borrow ${rhea_max:,.0f} at HF 1.0 (its liquidation line), ${rhea_safe:,.0f} at HF 1.2")
print(f"Option A: borrow ${w_a:,.0f}; requirement ${mr_a(w_a):,.0f}; broker posts ${u_a:,.0f} to hold HF 1.2")
print(f"Option B: borrow ${w_b:,.0f}; requirement ${mr_b_val:,.0f}; broker posts ${u_b:,.0f} "
      f"(HF now {rhea_hf(SPOT, u_b, w_b):.2f}, stays >=1.0 at -12% and -2% depeg)")
for loss, s in worst_b:
    print(f"   driver: loss ${loss:,.0f} in {s}")
print(f"Option C: capacity ${w_c_capacity:,.0f} (broker ${u_c:,.0f}); new-client score multiplier "
      f"{SCORE_MULT_NEW_CLIENT} -> borrow ${w_c:,.0f}, broker ${u_c_new:,.0f}")
print(f"Skin-in-the-game rule (broker collateral <= client equity left in the account, HF 1.2): "
      f"borrow <= ${w_skin:,.0f}, broker ${broker_for_hf(w_skin, SPOT, 1.2):,.0f}")
print(f"Carry at today's rates: borrow cost {BORROW_APR:.1%} vs funding {FUND_APR:.1%} on the short")
