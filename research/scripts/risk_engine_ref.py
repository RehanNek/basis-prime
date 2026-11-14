"""Reference implementation of the v0 risk and credit engine described in RISK_ENGINE.md.

    python3 -I risk_engine_ref.py <universe_v0.json> <replays_v0.json> examples
    python3 -I risk_engine_ref.py <universe_v0.json> <replays_v0.json> tests

Every number in RISK_ENGINE.md's worked examples comes from this file. It is a specification aid,
not production code: plain floats, no I/O beyond loading the calibrated parameters. Section numbers
in comments refer to RISK_ENGINE.md.
"""
import itertools
import json
import math
import sys
from dataclasses import dataclass, field, replace

# ----------------------------------------------------------------------------------------------
# Section 10: global parameters (v0 defaults)
# ----------------------------------------------------------------------------------------------
G = {
    "H_hours": 4.0,                 # price-shock horizon (time to notice, decide and unwind)
    "carry_days": 7.0,              # carry reserve horizon
    "k_normal": (1 / 3, 2 / 3, 1.0),
    "k_extreme": 2.0,
    "extreme_down_cap": 0.90,       # a price can't fall more than 90% in one scenario
    "adl_pairs": ((2 / 3, 2 / 3), (1.0, 0.5)),
    "reversal_pairs": ((2 / 3, 2 / 3), (1.0, 0.5), (1.0, 1.0)),   # squeeze a perp into liquidation, then reverse
    "max_order_adv": 0.01,          # one order at most 1% of the coin's daily Hyperliquid volume
    "ext_weight": 0.5,              # extreme scenarios count at half
    "replay_weight": 1.0,           # replays count in full (PLAN.md 6.9); options in section 13.1
    "replay_cap_2S": False,         # option: clip every replay move at the coin's extreme size
    "im_mult": 1.25,                # initial requirement = 1.25 x maintenance requirement
    "pool_loss_budget": 0.05,       # extreme scenarios may cost the pool at most 5% of the loan
    "vol_cap": 2.5,
    "participation": 0.10,          # we take at most 10% of stressed Hyperliquid volume per hour
    "stressed_volume": 0.5,         # in stress, assume half the normal volume
    "impact_Y": 1.0,                # square-root impact coefficient
    "hl_taker_fee": 0.00045,
    "liq_slip_floor": 0.002,        # Hyperliquid book liquidation slippage, at least 0.2%
    "backstop_frac": 2 / 3,         # below 2/3 of maintenance, the backstop takes what is left
    "deleverage_frac": 0.8,         # deleverage below 0.8 x MR
    "margin_call_hours": 4.0,
    "hl_ratio_pretrade": 0.50,      # Hyperliquid margin ratio allowed after a risk-adding trade
    "hl_ratio_rebalance": 0.60,
    "hl_ratio_target": 0.30,
    "hl_ratio_emergency": 0.80,
    "inflight_state_value": 0.98,   # money in flight counts at 98% for the state, 0 for allowances
    "util_cap": 0.90,
    "client_pool_share": 0.25,
    "unwind_hours_max": 24.0,
    "min_equity_for_credit": 1_000.0,
    "hysteresis": 0.02,
    "rate_kink_u": 0.80, "rate_kink": 0.06, "rate_max": 0.50,
}
TIERS = {
    "PREFERRED": {"cap": 0.85, "spread": 0.01, "limit0": 1_000_000, "limit_max": 5_000_000},
    "STANDARD": {"cap": 0.70, "spread": 0.02, "limit0": 250_000, "limit_max": 1_000_000},
    "WATCH": {"cap": 0.50, "spread": 0.05, "limit0": 50_000, "limit_max": 100_000},
}
# NEAR-side tokens allowed in v0 (section 5.3). depeg = (normal, with-crash, extreme) slip below the
# underlying; 1Click unwind cost = (c0 + c1 * sqrt(value / $100k)) * vol factor; cap_h = $ per hour, lowered for
# USDT and ETH to the largest sale 1Click quoted every time on 5 Nov 2026 (research/day1.md).
TOKENS = {
    "USDC": {"group": None, "depeg": (0.0, 0.0, 0.0), "c0": 0.0, "c1": 0.0, "cap_h": math.inf},
    "USDT": {"group": None, "depeg": (0.01, 0.01, 0.13), "c0": 0.0005, "c1": 0.0005, "cap_h": 500_000},
    "nBTC": {"group": "BTC", "depeg": (0.02, 0.05, 0.20), "c0": 0.001, "c1": 0.004, "cap_h": 500_000},
    "ETH.b": {"group": "ETH", "depeg": (0.02, 0.05, 0.20), "c0": 0.001, "c1": 0.004, "cap_h": 50_000},
    "wNEAR": {"group": "NEAR", "depeg": (0.0, 0.0, 0.0), "c0": 0.001, "c1": 0.004, "cap_h": 250_000},
}
def tau():
    """Section 4.7: the carry horizon as a fraction of a year, read from G at each use."""
    return G["carry_days"] / 365


def base_rate(u):
    """Section 7.1: pool base rate by utilisation (PLAN.md 5.1)."""
    u = min(max(u, 0.0), 1.0)
    if u <= G["rate_kink_u"]:
        return G["rate_kink"] * u / G["rate_kink_u"]
    return G["rate_kink"] + (G["rate_max"] - G["rate_kink"]) * (u - G["rate_kink_u"]) / (1 - G["rate_kink_u"])


def sgn(x):
    return (x > 0) - (x < 0)


@dataclass
class Account:
    near: dict = field(default_factory=dict)       # token -> units (nBTC in BTC, USDC in USDC)
    hl_cash: float = 0.0                           # Hyperliquid collateral, realised (USDC)
    perps: dict = field(default_factory=dict)      # coin -> signed size in Hyperliquid units
    entry: dict = field(default_factory=dict)      # coin -> entry price
    debt: float = 0.0
    tier: str = "STANDARD"
    inflight: list = field(default_factory=list)   # (token, units, overdue)
    orders: list = field(default_factory=list)     # resting orders: (coin, signed size, limit price)


@dataclass
class Market:
    px: dict                 # group -> reference price (median of sources), Hyperliquid units
    mark: dict               # coin -> Hyperliquid mark price
    twap: dict               # group -> 1-hour TWAP of the reference price
    wrap: dict               # token -> pi: price ratio to its underlying (nBTC/BTC), or USDC price for stables
    volf: dict               # group -> volatility factor f (section 4.4)
    funding: dict            # coin -> normal funding, annualised (positive: longs pay shorts)
    util: float = 0.6        # pool utilisation now
    pool_capital: float = 2_000_000.0
    pool_loans: float = 1_200_000.0
    book: dict = field(default_factory=dict)   # other accounts' Hyperliquid notional per coin / NEAR value per token
    frozen: frozenset = frozenset()           # bridged tokens the operator has frozen (section 3.3)
    wrap_allow: dict = field(default_factory=dict)   # token -> pi for allowance equity only (3.3: the lowest pi of
    #                                                  the last hour); a token not in it uses its `wrap`


@dataclass
class Scenario:
    name: str
    kind: str                # "normal", "adl", "extreme", "replay"
    path: list               # stages; each stage = list of alternative {group: move from now}
    basis: bool = True       # adverse perp-vs-index gap on every perp
    depeg: int = 0           # index into TOKENS[*]["depeg"]: 0 normal, 1 crash, 2 extreme; -1 none
    depeg_only: str = ""     # extreme depeg scenarios hit one token at a time
    carry: str = "stress"    # "stress" or "normal"
    adl_coin: str = ""       # Hyperliquid closes this perp at the end of stage 1


class Engine:
    def __init__(self, coins, tables, replays):
        self.c = coins
        self.tables = tables
        self.replays = replays

    # ---------------- Section 4.3: Hyperliquid replica ----------------
    def mm(self, coin, notional):
        """Maintenance margin with Hyperliquid's tiers: N x rate_n - deduction_n, rate_n = 1/(2 x maxLev_n)."""
        if notional <= 0:
            return 0.0
        tid = str(self.c[coin]["hl_margin_table"])
        tiers = sorted((float(t["lowerBound"]), int(t["maxLeverage"]))
                       for t in self.tables[tid]["marginTiers"]) if tid in self.tables \
            else [(0.0, int(self.c[coin]["hl_max_leverage"]))]
        rate, ded, prev, ded_at = None, 0.0, None, 0.0
        for i, (lb, lev) in enumerate(tiers):
            r = 1 / (2 * lev)
            if i > 0:
                ded += lb * (r - prev)
            if notional >= lb:
                rate, ded_at = r, ded
            prev = r
        return max(0.0, notional * rate - ded_at)

    def hl_keep(self, a, m):
        """Section 8.2: Hyperliquid equity that must stay after any transfer out: our 30% margin-ratio
        target, and Hyperliquid's own rule max(initial margin, 10% of total position value)."""
        notional = {c: abs(q) * m.mark[c] for c, q in a.perps.items() if q}
        if not notional:
            return 0.0
        mmv = sum(self.mm(c, n) for c, n in notional.items())
        im = sum(n / self.c[c]["hl_max_leverage"] for c, n in notional.items())
        return max(mmv / G["hl_ratio_target"], im, 0.10 * sum(notional.values()))

    def hl_equity_now(self, a, m):
        return a.hl_cash + sum(q * (m.mark[c] - a.entry.get(c, m.mark[c])) for c, q in a.perps.items())

    # ---------------- Section 4.6: unwind costs ----------------
    def cost_hl(self, coin, notional, f):
        p = self.c[coin]
        spread = p["book"]["spread_bp"]
        spread = 2.0 if spread is None or spread != spread else spread
        sig_day = p["params"]["vol_ref"] / math.sqrt(365) * f
        adv = p["adv30_usd"] * G["stressed_volume"]
        return G["hl_taker_fee"] + spread / 2e4 + G["impact_Y"] * sig_day * math.sqrt(max(notional, 0) / adv)

    @staticmethod
    def cost_1c(token, value, f):
        t = TOKENS[token]
        return (t["c0"] + t["c1"] * math.sqrt(max(value, 0) / 1e5)) * f

    # ---------------- Section 3: valuation ----------------
    @staticmethod
    def token_value(tok, units, m, move=0.0, depeg=0.0, pi=None):
        """V_j after a move of its coin and a depeg, at ratio `pi` (by default the mark one, m.wrap)."""
        g = TOKENS[tok]["group"]
        pi = m.wrap.get(tok, 1.0) if pi is None else pi
        if g is None:
            return units * pi * (1 - depeg)
        return units * m.px[g] * (1 + move) * pi * (1 - depeg)

    @staticmethod
    def pi_allow(m, tok):
        """Section 3.3: the ratio allowance equity uses (the lowest of the last hour); the mark one if none given.
        Never above the mark ratio: the hour's lowest includes now, so a higher value can only be a bad input."""
        return min(m.wrap_allow.get(tok, m.wrap.get(tok, 1.0)), m.wrap.get(tok, 1.0))

    def groups(self, a):
        gs = {c for c, q in a.perps.items() if q}
        gs |= {TOKENS[t]["group"] for t, u in a.near.items() if u and TOKENS[t]["group"]}
        return sorted(gs)

    @staticmethod
    def stress_tokens(a):
        """Section 4.8: the NEAR tokens the stress test values: those held, then those in transit and not overdue,
        which take the same moves and depegs as the token held."""
        toks = [t for t, u in a.near.items() if u]
        for t, u, overdue in a.inflight:
            if u and not overdue and t not in toks:
                toks.append(t)
        return toks

    def net_units(self, a, m, g, skip=()):
        n = sum(u * m.wrap.get(t, 1.0) for t, u in a.near.items() if TOKENS[t]["group"] == g and t not in skip)
        return n + a.perps.get(g, 0.0)

    def inflight_value(self, a, m, for_state):
        if not for_state:
            return 0.0
        return sum(G["inflight_state_value"] * self.token_value(t, u, m)
                   for t, u, overdue in a.inflight if not overdue)

    def equity_mark(self, a, m):
        near = sum(self.token_value(t, u, m) for t, u in a.near.items())
        return near + self.hl_equity_now(a, m) + self.inflight_value(a, m, True) - a.debt

    def twap_adjustment(self, a, m):
        """Section 3.4: recent gains on net exposure don't count toward new credit. Frozen tokens are already out
        of allowance equity (frozen_value), so their units are left out here too."""
        return sum(max(0.0, self.net_units(a, m, g, skip=m.frozen) * (m.px[g] - m.twap.get(g, m.px[g])))
                   for g in self.groups(a))

    def mark_adjustment(self, a, m):
        """Section 3.4: for new credit, a perp counts at the less favourable of mark and reference price."""
        return sum(max(0.0, q * (m.mark[c] - m.px[c])) for c, q in a.perps.items())

    def frozen_value(self, a, m):
        """Section 3.3: a token the operator has frozen counts as zero toward new credit (pi_allow = 0). It keeps
        its market value in mark equity, so the freeze alone never moves an account to a worse state."""
        return sum(self.token_value(t, u, m) for t, u in a.near.items() if t in m.frozen)

    def wrap_adjustment(self, a, m):
        """Section 3.3: for new credit, a wrapper counts at pi_allow, not at the mark ratio. Only allowance equity
        uses it, so a low pi_allow lowers credit but never moves the state. Frozen tokens are already out."""
        return sum(self.token_value(t, u, m) - self.token_value(t, u, m, pi=self.pi_allow(m, t))
                   for t, u in a.near.items() if t in m.wrap_allow and t not in m.frozen)

    def equity_allow(self, a, m):
        return (self.equity_mark(a, m) - self.inflight_value(a, m, True) - self.twap_adjustment(a, m)
                - self.mark_adjustment(a, m) - self.frozen_value(a, m) - self.wrap_adjustment(a, m))

    # ---------------- Section 4.1 / 4.2: shock sizes ----------------
    def unwind_hours(self, a, m, g):
        """Section 4.2: in a stress everyone sells through the same routes, so the time to unwind
        counts the rest of the book's holdings (m.book) as well as this account's."""
        hl_h = 0.0
        if a.perps.get(g):
            cap = G["participation"] * G["stressed_volume"] * self.c[g]["adv30_usd"] / 24
            hl_h = (abs(a.perps[g]) * m.mark[g] + m.book.get(g, 0.0)) / cap
        near_h = sum((self.token_value(t, u, m) + m.book.get(t, 0.0)) / TOKENS[t]["cap_h"]
                     for t, u in a.near.items() if TOKENS[t]["group"] == g and u)
        return max(hl_h, near_h)

    @staticmethod
    def f(m, g):
        """Section 4.4: the volatility factor never goes below 1 (calm markets don't shrink anything)."""
        return min(G["vol_cap"], max(1.0, m.volf.get(g, 1.0)))

    def shock(self, a, m, g):
        p = self.c[g]["params"]
        f = self.f(m, g)
        ell = math.sqrt(1 + self.unwind_hours(a, m, g) / G["H_hours"])
        return p["S"] * f * ell, f, ell

    # ---------------- Section 4.5: scenario set ----------------
    def scenarios(self, a, m):
        moving = {TOKENS[t]["group"] for t in self.stress_tokens(a) if TOKENS[t]["group"]}
        gs = sorted(set(self.groups(a)) | moving)         # money in transit moves with its coin too (4.8)
        S = {g: self.shock(a, m, g)[0] for g in gs}
        conflict = [g for g in gs if a.perps.get(g) and any(
            u and TOKENS[t]["group"] == g for t, u in a.near.items())]
        adverse = {}
        for g in gs:
            n = self.net_units(a, m, g)
            gross = abs(a.perps.get(g, 0.0)) + sum(abs(u) for t, u in a.near.items() if TOKENS[t]["group"] == g)
            if abs(n) > 1e-9 * gross:
                adverse[g] = -sgn(n)                       # against the net position
            else:                                          # exact hedge: against the perp (hurts Hyperliquid)
                adverse[g] = -sgn(a.perps.get(g, 0.0)) or -1
        out = []

        cap = -G["extreme_down_cap"]           # a price can't fall more than 90% in any scenario

        def combos(k):
            seen = []
            vecs = [{g: -1 for g in gs}, {g: +1 for g in gs}]
            for signs in itertools.product((-1, 1), repeat=len(conflict)):
                v = dict(adverse)
                v.update(zip(conflict, signs))
                vecs.append(v)
            res = []
            for v in vecs:
                key = tuple(v[g] for g in gs)
                if key in seen:
                    continue
                seen.append(key)
                mv = {}
                for g in gs:
                    mv[g] = max(v[g] * k * S[g], cap)
                res.append((key, mv))
            return res

        for k in G["k_normal"]:
            for key, mv in combos(k):
                out.append(Scenario(f"{k:.2f}S {key}", "normal", [[mv]]))
        for g in gs:
            q = a.perps.get(g, 0.0)
            if not q:
                continue
            s = sgn(q)          # ADL closes the winning side: a short in a fall, a long in a rise
            for k1, k2 in G["adl_pairs"]:
                x1 = {h: max(s * k1 * S[h], cap) for h in gs}
                x2 = {h: max((1 + x1[h]) * (1 + max(s * k2 * S[h], cap)) - 1, cap) for h in gs}
                out.append(Scenario(f"ADL {g} {k1:.2f}S then {k2:.2f}S", "adl", [[x1], [x2]], adl_coin=g))
        for g in gs:            # squeeze the perp into liquidation, then the price reverses (JELLY, POPCAT, 2020)
            q = a.perps.get(g, 0.0)
            if not q:
                continue
            s = -sgn(q)
            for k1, k2 in G["reversal_pairs"]:
                x1 = {h: max(s * k1 * S[h], cap) for h in gs}
                x2 = {h: max((1 + x1[h]) * (1 + max(-s * k2 * S[h], cap)) - 1, cap) for h in gs}
                out.append(Scenario(f"squeeze {g} {k1:.2f}S then back {k2:.2f}S", "reversal", [[x1], [x2]]))
        for key, mv in combos(G["k_extreme"]):
            out.append(Scenario(f"2S {key}", "extreme", [[mv]], basis=False, depeg=-1, carry="normal"))
        crash = {g: max(-G["k_extreme"] * S[g], cap) for g in gs}
        out.append(Scenario("2S all down + bridge slip", "extreme", [[crash]], basis=False, depeg=1,
                            carry="normal"))
        for t in self.stress_tokens(a):
            if TOKENS[t]["depeg"][2] > 0:
                out.append(Scenario(f"{t} depeg {TOKENS[t]['depeg'][2]:.0%}", "extreme", [[{g: 0.0 for g in gs}]],
                                    basis=False, depeg=2, depeg_only=t, carry="normal"))
        for w in self.replays["windows"]:
            path = []
            for i in range(len(w["paths"]["BTC"])):     # one point per minute, in time order
                alt = {}
                for g in gs:
                    if g in w["paths"]:                  # recorded closes, used as recorded
                        alt[g] = w["paths"][g][i]
                    else:                                # no data that day: BTC's path x the window's scale,
                        sc = w.get("scale", {}).get(g, w.get("p75_ratio", 1.0))   # never past 2S or -90%
                        two_s = 2 * self.c[g]["params"]["S"]
                        alt[g] = min(max(w["paths"]["BTC"][i] * sc, -two_s, cap), two_s)
                    if G["replay_cap_2S"]:
                        two_s = 2 * self.c[g]["params"]["S"]
                        alt[g] = min(max(alt[g], -two_s, cap), two_s)
                path.append([alt])
            out.append(Scenario(f"replay {w['name']}", "replay", path, carry="normal"))
        return out

    # ---------------- Section 4.3 / 4.7: play one scenario out ----------------
    def scenario_value(self, sc, alt, tok, units, m):
        """V_j(x) (4.8): a token's value at one point of a scenario, after its coin's move and the family's depeg."""
        g = TOKENS[tok]["group"]
        d = 0.0
        if sc.depeg >= 0 and (not sc.depeg_only or sc.depeg_only == tok):
            d = TOKENS[tok]["depeg"][sc.depeg]
        return self.token_value(tok, units, m, alt.get(g, 0.0) if g else 0.0, d)

    def run(self, a, m, sc, extra_debt=0.0):
        rate_n = base_rate(m.util) + TIERS[a.tier]["spread"]
        rate_s = base_rate(1.0) + TIERS[a.tier]["spread"]
        rate = rate_s if sc.carry == "stress" else rate_n
        horizon = tau()
        debt = a.debt + extra_debt
        perps = {c: q for c, q in a.perps.items() if q}
        hl_base = self.hl_equity_now(a, m)          # equity with entries reset to today's marks
        liquidated = None
        worst = math.inf
        worst_detail = None
        for si, stage in enumerate(sc.path):
            if sc.adl_coin and si == 1 and sc.adl_coin in perps:
                g = sc.adl_coin                  # closed at the stage-1 mark, gap included (4.3)
                b = -sgn(perps[g]) * self.c[g]["params"]["basis"] if sc.basis else 0.0
                m1 = m.mark[g] * (1 + sc.path[0][0][g]) * (1 + b)
                hl_base += perps[g] * (m1 - m.mark[g])
                del perps[g]

            def marks(alt):
                out = {}
                for c, q in perps.items():
                    b = -sgn(q) * self.c[c]["params"]["basis"] if sc.basis else 0.0
                    out[c] = m.mark[c] * (1 + alt.get(c, 0.0)) * (1 + b)
                return out

            if perps and liquidated is None:        # Hyperliquid checks continuously: any alternative
                for alt in stage:
                    mk = marks(alt)
                    eq = hl_base + sum(q * (mk[c] - m.mark[c]) for c, q in perps.items())
                    mmv = sum(self.mm(c, abs(q) * mk[c]) for c, q in perps.items())
                    if eq < mmv:
                        notional = {c: abs(q) * mk[c] for c, q in perps.items()}
                        if eq >= G["backstop_frac"] * mmv:
                            slip = sum(max(G["liq_slip_floor"], 2 * self.cost_hl(
                                c, n, self.f(m, c))) * n for c, n in notional.items())
                            post = max(eq - slip, 0.0)
                            liquidated = ("book", eq, mmv, slip)
                        else:
                            post = 0.0
                            liquidated = ("backstop", eq, mmv, max(eq, 0.0))
                        hl_base, perps = post, {}
                        break
            for alt in stage:
                mk = marks(alt)
                hl_eq = hl_base + sum(q * (mk[c] - m.mark[c]) for c, q in perps.items())
                near_val, near_cost = 0.0, 0.0
                for t, u in a.near.items():
                    if not u:
                        continue
                    g = TOKENS[t]["group"]
                    v = self.scenario_value(sc, alt, t, u, m)
                    near_val += v
                    near_cost += self.cost_1c(t, v, self.f(m, g) if g else 1.0) * v
                # Money in transit moves like the same token held, at 98%, and counts nothing once overdue (4.8).
                infl = sum(G["inflight_state_value"] * self.scenario_value(sc, alt, t, u, m)
                           for t, u, overdue in a.inflight if not overdue)
                hl_cost = sum(self.cost_hl(c, abs(q) * mk[c], self.f(m, c)) * abs(q) * mk[c]
                              for c, q in perps.items())
                funding = 0.0
                for c, q in perps.items():
                    if sc.carry == "stress":
                        f = self.c[c]["params"]["funding_stress_long_apr"] if q > 0 else \
                            self.c[c]["params"]["funding_stress_short_apr"]
                    else:
                        f = m.funding.get(c, 0.0)
                    funding += q * mk[c] * f * horizon
                eq = near_val - near_cost + hl_eq - hl_cost + infl - debt - debt * rate * horizon - funding
                if eq < worst:
                    worst = eq
                    worst_detail = {"near": near_val, "near_cost": near_cost, "inflight": infl, "hl_eq": hl_eq,
                                    "hl_cost": hl_cost, "interest": debt * rate * horizon, "funding": funding,
                                    "liq": liquidated, "stage": si}
        return worst, rate, worst_detail

    # ---------------- Section 4.8: requirement ----------------
    def requirement(self, a, m):
        e_now = self.equity_mark(a, m)
        rows = []
        for sc in self.scenarios(a, m):
            e_after, rate, det = self.run(a, m, sc)
            rows.append({"sc": sc, "loss": e_now - e_after, "rate": rate, "e_after": e_after, "det": det})
        normal = max([r["loss"] for r in rows if r["sc"].kind in ("normal", "adl", "reversal")] + [0.0])
        replay = max([r["loss"] for r in rows if r["sc"].kind == "replay"] + [0.0])
        ext = max([r["loss"] for r in rows if r["sc"].kind == "extreme"] + [0.0])
        mr = max(normal, G["ext_weight"] * ext, G["replay_weight"] * replay, 0.0)
        return {"MR": mr, "IM": G["im_mult"] * mr, "normal": normal, "extreme": ext, "replay": replay,
                "rows": rows, "E": e_now}

    @staticmethod
    def weight(kind):
        return G["ext_weight"] if kind == "extreme" else (G["replay_weight"] if kind == "replay" else 1.0)

    def top_risks(self, req, n=3):
        rows = sorted(req["rows"], key=lambda r: -self.weight(r["sc"].kind) * r["loss"])
        return [(r["sc"].name, self.weight(r["sc"].kind) * r["loss"]) for r in rows[:n]]

    def topup(self, a, m):
        """Section 8.2 and Appendix A: the smallest Hyperliquid top-up (whole dollars, rounded up) after which none of
        the liquidations among today's top three risks happens. 0 if there is none. More margin can raise MR (13.1),
        so the search follows those scenarios, not MR."""
        req = self.requirement(a, m)
        top = sorted(req["rows"], key=lambda r: -self.weight(r["sc"].kind) * r["loss"])[:3]
        names = {r["sc"].name for r in top if r["det"]["liq"]}
        if not names:
            return 0.0

        def still(extra):
            r2 = self.requirement(replace(a, hl_cash=a.hl_cash + extra), m)
            return any(r["det"]["liq"] for r in r2["rows"] if r["sc"].name in names)
        hi = max(1_000.0, sum(abs(q) * m.mark[c] for c, q in a.perps.items()))
        while still(hi):
            hi *= 2
            if hi > 1e12:
                return math.inf
        lo = 0.0
        while hi - lo > 0.01:
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if still(mid) else (lo, mid)
        return float(math.ceil(hi))

    # ---------------- Section 7: credit line ----------------
    def credit_limit(self, tier, good_months):
        """Section 6: the starting limit x 1.1^good_months, up to the tier's maximum. The power is repeated
        multiplication, not pow(), so every platform (native or WASM) gets the same bits."""
        t = TIERS[tier]
        growth = 1.0
        for _ in range(good_months):
            growth *= 1.1
        return min(t["limit_max"], t["limit0"] * growth)

    def deleverage_plan(self, a, m, max_steps=40):
        """Section 8.4: greedy unwind back to IM. Returns (steps, account after)."""
        steps = []
        for _ in range(max_steps):
            usdc = a.near.get("USDC", 0.0)
            if usdc > 0.01 and a.debt > 0.01:                       # step 2: repay from NEAR USDC
                x = min(usdc, a.debt)
                a = replace(a, near={**a.near, "USDC": usdc - x}, debt=a.debt - x)
                steps.append(f"repay ${x:,.0f} from USDC in the NEAR account")
                continue
            if not any(a.perps.values()) and self.hl_equity_now(a, m) > 1 and a.debt > 0.01:
                x = self.hl_equity_now(a, m)                        # no perps left: bring the cash home
                a = replace(a, hl_cash=0.0, perps={}, near={**a.near, "USDC": a.near.get("USDC", 0.0) + x - 0.2})
                steps.append(f"no perps left: bring ${x:,.0f} home from Hyperliquid (1Click, 0.2 USDC fee)")
                continue
            req = self.requirement(a, m)
            if req["E"] >= req["IM"] * (1 + G["hysteresis"]) or (not any(a.perps.values()) and not any(
                    u for t, u in a.near.items() if t != "USDC")):
                break
            best = None
            for g in self.groups(a):                                # step 4: candidates
                q = a.perps.get(g, 0.0)
                toks = [t for t, u in a.near.items() if u and TOKENS[t]["group"] == g]
                f = self.f(m, g)
                for kind in ("pair", "perp", "near"):
                    if kind == "pair" and not (q < 0 and toks):
                        continue
                    near_units = sum(b0 * m.wrap.get(t, 1.0) for t, b0 in a.near.items() if t in toks)
                    excess = abs(q) - near_units if (q < 0 and toks) else abs(q)
                    if kind == "perp" and (not q or excess <= 1e-12):
                        continue
                    near_excess = (near_units - abs(q)) if (q < 0 and toks) else near_units
                    if kind == "near" and (not toks or near_excess <= 1e-12):
                        continue
                    b = replace(a, near=dict(a.near), perps=dict(a.perps), entry=dict(a.entry))
                    traded = cost = 0.0
                    hour_hl = G["participation"] * G["stressed_volume"] * self.c[g]["adv30_usd"] / 24
                    if kind == "pair":
                        # Both legs together, sized once, in coin units (8.4): 25% of the hedged position, at most an
                        # hour of Hyperliquid's volume and an hour of 1Click's capacity. The token sold matches the
                        # perp bought back, so the hedge is kept.
                        t = toks[0]
                        w = m.wrap.get(t, 1.0)
                        x = min(min(abs(q), b.near[t] * w) * 0.25, hour_hl / m.mark[g], TOKENS[t]["cap_h"] / m.px[g])
                        dq, units = -sgn(q) * x, x / w
                    elif kind == "perp":
                        dq = -sgn(q) * min(abs(q) * 0.25, excess)
                        dq = sgn(dq) * min(abs(dq), hour_hl / m.mark[g])
                    else:
                        t = toks[0]
                        units = min(b.near[t] * 0.25, near_excess / m.wrap.get(t, 1.0))
                        units = min(units, TOKENS[t]["cap_h"] / (m.px[g] * m.wrap.get(t, 1.0)), b.near[t])
                    if kind in ("pair", "perp"):
                        n = abs(dq) * m.mark[g]
                        c = self.cost_hl(g, n, f) * n
                        b.hl_cash += q * (m.mark[g] - b.entry.get(g, m.mark[g])) - c
                        b.entry[g] = m.mark[g]
                        b.perps[g] = q + dq
                        traded += n
                        cost += c
                    if kind in ("pair", "near"):
                        v = self.token_value(t, units, m)
                        c = self.cost_1c(t, v, f) * v
                        b.near[t] -= units
                        b.near["USDC"] = b.near.get("USDC", 0.0) + v - c
                        traded += v
                        cost += c
                    r2 = self.requirement(b, m)
                    score = (G["im_mult"] * (req["MR"] - r2["MR"]) - cost) / max(traded, 1e-9)
                    if best is None or score > best[0]:
                        best = (score, b, f"{kind} {g}: trade ${traded:,.0f}, cost ${cost:,.0f}, "
                                          f"MR ${req['MR']:,.0f} -> ${r2['MR']:,.0f}")
            if best is None:
                break
            a = best[1]
            steps.append(best[2])
        return steps, a

    def borrow_allowance(self, a, m, req=None, good_months=0, score=None, second_pass=False):
        """Section 7.2. Solve with today's rate; then once more at the utilisation the loan would cause."""
        req = req or self.requirement(a, m)
        e_allow = self.equity_allow(a, m)
        d = a.debt
        b, im = G["pool_loss_budget"], G["im_mult"]
        horizon = tau()
        bounds = {"C0 equity": e_allow if e_allow >= G["min_equity_for_credit"] else 0.0}
        for r in req["rows"]:
            kind, w = r["sc"].kind, self.weight(r["sc"].kind)
            l0 = r["loss"]
            rt = r["rate"] * horizon
            nm = r["sc"].name
            if w == 0:              # an option that drops replays
                continue
            # C1: equity after the loan covers 1.25 x the weighted loss (with interest on the new loan)
            bounds[f"C1 {nm}"] = (e_allow - im * w * l0) / (1 + im * w * rt)
            if kind == "extreme" or w < 1:   # C3: pool loss within 5% of the total loan (extremes, or
                bounds[f"C3 {nm}"] = (e_allow - l0 + b * d) / (1 - b + rt)   # replays counted below full)
            else:                   # C2: the pool loses nothing
                bounds[f"C2 {nm}"] = (e_allow - l0) / (1 + rt)
        t = TIERS[a.tier]
        bounds["C4 tier cap"] = t["cap"] * (e_allow + d) - d
        bounds["C5 client limit"] = self.credit_limit(a.tier, good_months) - d
        bounds["C6 pool utilisation"] = G["util_cap"] * m.pool_capital - m.pool_loans
        bounds["C6 pool share"] = G["client_pool_share"] * m.pool_capital - d
        hours = max([self.unwind_hours(a, m, g) for g in self.groups(a)] + [0.0])
        if hours > G["unwind_hours_max"]:
            bounds["C8 unwind time"] = 0.0
        if score is not None and score < 450:
            bounds["C9 rating below 450"] = 0.0
        key = min(bounds, key=bounds.get)
        w = max(0.0, math.floor(bounds[key] * 1e6) / 1e6)        # micro-USDC, rounded down
        u2 = (m.pool_loans + w) / m.pool_capital
        if not second_pass and w > 0 and u2 > m.util + 1e-12:
            return self.borrow_allowance(a, replace(m, util=u2), None, good_months, score, second_pass=True)
        return w, key, bounds

    def withdraw_allowance(self, a, m, req=None):
        if a.debt <= 0:          # section 7.3: with no loan the pool can't lose, so nothing binds
            return a.near.get("USDC", 0.0), "no loan: free USDC"
        req = req or self.requirement(a, m)
        e_allow = self.equity_allow(a, m)
        d = a.debt
        bounds = {"C1 initial requirement": e_allow - req["IM"],
                  "C4 tier cap": e_allow + d - (d / TIERS[a.tier]["cap"] if d else 0.0),
                  "free USDC on NEAR": a.near.get("USDC", 0.0)}
        for r in req["rows"]:
            if r["sc"].kind == "extreme":
                bounds[f"C3 {r['sc'].name}"] = e_allow - r["loss"] + G["pool_loss_budget"] * d
        key = min(bounds, key=bounds.get)
        return max(0.0, math.floor(bounds[key] * 1e6) / 1e6), key

    # ---------------- Section 8: states ----------------
    def hl_ratio(self, a, m, moves=None):
        moves = moves or {}
        eq = self.hl_equity_now(a, m)
        mmv = 0.0
        for c, q in a.perps.items():
            mk = m.mark[c] * (1 + moves.get(c, 0.0))
            eq += q * (mk - m.mark[c])
            mmv += self.mm(c, abs(q) * mk)
        if mmv == 0:
            return 0.0
        return math.inf if eq <= 0 else mmv / eq

    ORDER = ("HEALTHY", "WATCH", "MARGIN_CALL", "DELEVERAGE")

    def raw_state(self, e, mr, im, margin_call_age_h, h=0.0):
        if e >= im * (1 + h):
            return "HEALTHY"
        if e >= mr * (1 + h):
            return "WATCH"
        if e >= G["deleverage_frac"] * mr * (1 + h) and margin_call_age_h < G["margin_call_hours"]:
            return "MARGIN_CALL"
        return "DELEVERAGE"

    def state(self, a, m, req, margin_call_age_h=0.0, prev=None):
        """Section 8.1. Hysteresis only slows improvements: a better state needs 2% above its threshold."""
        e, mr, im = req["E"], req["MR"], req["IM"]
        if a.debt <= 0:          # section 8.1: states only bind while the account owes the pool
            return "HEALTHY", "NONE", self.hl_ratio(a, m), False
        st = self.raw_state(e, mr, im, margin_call_age_h)
        if prev in self.ORDER and self.ORDER.index(st) < self.ORDER.index(prev):
            up = self.raw_state(e, mr, im, margin_call_age_h, G["hysteresis"])
            st = self.ORDER[min(self.ORDER.index(up), self.ORDER.index(prev))]
        projected = {g: -sgn(a.perps[g]) * 0.5 * self.shock(a, m, g)[0] for g in a.perps if a.perps[g]}
        venue_breach = bool(a.perps) and self.hl_ratio(a, m, projected) >= 1.0
        ratio = self.hl_ratio(a, m)
        action = "NONE"
        if st == "DELEVERAGE":
            action = "DELEVERAGE"
        elif ratio >= G["hl_ratio_emergency"]:
            action = "REBALANCE_NOW"         # Hyperliquid close to liquidating: act without a second check
        elif venue_breach or ratio >= G["hl_ratio_rebalance"]:
            action = "REBALANCE"
        return st, action, ratio, venue_breach

    # ---------------- Section 8.3: bands for keepers ----------------
    def band(self, f, target, lo, hi, step=0.005):
        """Nearest move from 0 toward the end of [lo, hi] where f(x) crosses target: scan in 0.5% steps, then
        bisect inside the first step that changes sign. f is re-evaluated in full at every point (math
        review: freezing MR made the bands fire late)."""
        end = hi if abs(hi) > abs(lo) else lo
        direction = 1 if end > 0 else -1
        x0, f0 = 0.0, f(0.0) - target
        x = 0.0
        while abs(x) < abs(end) - 1e-12:
            x1 = direction * min(abs(x) + step, abs(end))
            f1 = f(x1) - target
            if f0 == 0:
                return x0
            if (f0 > 0) != (f1 > 0):
                a_, b_, fa = x0, x1, f0
                for _ in range(50):
                    mid = (a_ + b_) / 2
                    fm = f(mid) - target
                    if (fm > 0) == (fa > 0):
                        a_, fa = mid, fm
                    else:
                        b_ = mid
                return (a_ + b_) / 2
            x0, f0, x = x1, f1, x1
        return None

    def equity_at(self, a, m, g, x):
        m2 = replace(m, px={**m.px, g: m.px[g] * (1 + x)},
                     mark={**m.mark, **({g: m.mark[g] * (1 + x)} if g in m.mark else {})})
        return self.equity_mark(a, m2)

    # ---------------- Section 6: rating ----------------
    @staticmethod
    def hedge_ratio(eng, a, m):
        gross = net = 0.0
        for g in eng.groups(a):
            legs = [u * m.wrap.get(t, 1.0) * m.px[g] for t, u in a.near.items() if TOKENS[t]["group"] == g]
            if a.perps.get(g):
                legs.append(a.perps[g] * m.mark[g])
            gross += sum(abs(x) for x in legs)
            net += abs(sum(legs))
        return 1.0 if gross == 0 else 1 - net / gross

    @staticmethod
    def score(hr_now, hr_avg7d, good_months=0, forced_unwinds_12m=0, forced_unwinds_older=0, defaults=0,
              linked_months=0, linked_liqs_12m=0, linked_fills=0, linked_volume=0.0, kyb=False,
              exposure_share=1.0):
        """Section 6. exposure_share = gross coin exposure / equity, 7-day average: hedge points need a real book.
        good_months count only months with a loan outstanding (the caller counts them that way)."""
        if defaults:
            return 300
        hr = min(hr_now, hr_avg7d)
        s = 650
        if exposure_share >= 0.25:
            s += 50 if hr >= 0.8 else (-100 if hr < 0.3 else 0)
        s += min(100, 10 * good_months)
        s -= 75 * forced_unwinds_12m + 35 * forced_unwinds_older
        if linked_months >= 6 and linked_liqs_12m == 0 and linked_fills >= 50 and linked_volume >= 1e6:
            s += 100
        s -= min(150, 50 * linked_liqs_12m)
        s += 100 if kyb else 0
        return max(300, min(1000, s))

    @staticmethod
    def tier_of(score, kyb=False):
        """Preferred needs a KYB record as well as the score."""
        if score >= 800 and kyb:
            return "PREFERRED"
        return "STANDARD" if score >= 600 else "WATCH"

    # ---------------- Section 7.3: conditions every risk-adding action must leave true ----------------
    def credit_failures(self, a, m, req=None):
        """With a loan: E_A >= IM, D <= cap x C, and extreme-day pool loss <= 5% of D. Empty list = fine."""
        if a.debt <= 0:
            return []
        req = req or self.requirement(a, m)
        e_allow = self.equity_allow(a, m)
        fails = []
        if e_allow < req["IM"] - 1e-6:
            fails.append(f"equity ${e_allow:,.0f} below the initial requirement ${req['IM']:,.0f}")
        if a.debt > TIERS[a.tier]["cap"] * (e_allow + a.debt) + 1e-6:
            fails.append("loan above the tier cap on collateral")
        worst = max([r["loss"] for r in req["rows"] if r["sc"].kind == "extreme"] + [0.0])
        if worst - e_allow > G["pool_loss_budget"] * a.debt + 1e-6:
            fails.append("extreme-day pool loss above 5% of the loan")
        return fails

    def withdraw_intent(self, a, m, token=None, units=0.0, hl_cash=0.0, to_hl=0.0):
        """Section 7.3: any outflow (a NEAR token, or Hyperliquid cash), and any move of USDC from NEAR to
        Hyperliquid (margin there can be lost in a backstop), runs on the book as it would be after."""
        near = dict(a.near)
        if to_hl > 0:
            if to_hl > near.get("USDC", 0.0) + 1e-9:
                return False, "more USDC than the NEAR account holds"
            a3 = replace(a, near={**near, "USDC": near.get("USDC", 0.0) - to_hl}, hl_cash=a.hl_cash + to_hl)
            fails = self.credit_failures(a3, m)
            return (not fails), ("ok" if not fails else "; ".join(fails))
        if token:
            if units > near.get(token, 0.0) + 1e-12:
                return False, "more than the account holds"
            near[token] = near.get(token, 0.0) - units
        if hl_cash > 0 and self.hl_equity_now(a, m) - hl_cash < self.hl_keep(a, m) - 1e-6:
            return False, "would leave less on Hyperliquid than its transfer rule and our 30% target need"
        a2 = replace(a, near=near, hl_cash=a.hl_cash - hl_cash)
        fails = self.credit_failures(a2, m)
        return (not fails), ("ok" if not fails else "; ".join(fails))

    # ---------------- Section 9: pre-trade check ----------------
    @staticmethod
    def worst_fill(size, limit_px, mark):
        """P4: an order is booked at its limit price, but never better than the mark: a buy at no less, a sell at
        no more."""
        return max(limit_px, mark) if size > 0 else min(limit_px, mark)

    def post_trade(self, a, m, coin, size, fill):
        """P4: the book after `size` of `coin` fills at `fill`, the coin's open PnL folded into cash at the mark.
        Hyperliquid equity changes by -size x (fill - mark) - fee, never a gain. Returns the book and the fee."""
        q0 = a.perps.get(coin, 0.0)
        fee = G["hl_taker_fee"] * abs(size) * fill
        slip = size * (fill - m.mark[coin])            # >= 0: the worst fill costs, it never pays
        upnl = q0 * (m.mark[coin] - a.entry.get(coin, m.mark[coin]))
        return replace(a, perps={**a.perps, coin: q0 + size}, hl_cash=a.hl_cash + upnl - fee - slip,
                       entry={**a.entry, coin: m.mark[coin]}), fee

    def pretrade(self, a, m, coin, size, limit_px, reduce_only=False, req=None):
        """One order, checked as if it fills completely at its limit price but never better than the mark.
        The gateway runs these one at a time per account (P0), with its own recent orders counted as filled."""
        p = self.c.get(coin)
        if p is None or not p["allowed"]:              # a coin outside the universe is not on the list either
            return False, "coin not on the allow-list"
        band = p["params"]["price_band"]
        if abs(limit_px / m.px[coin] - 1) > band:
            return False, f"limit price more than {band:.0%} from the reference price"
        q0 = a.perps.get(coin, 0.0)
        q1 = q0 + size
        shrinking = abs(q1) < abs(q0) and sgn(q1) in (0, sgn(q0))
        if reduce_only and not shrinking:
            return False, "reduce-only order would increase or flip the position"
        fill = self.worst_fill(size, limit_px, m.mark[coin])
        if abs(size) * fill > G["max_order_adv"] * p["adv30_usd"]:
            return False, "order above 1% of the coin's daily Hyperliquid volume: slice it"
        if not shrinking and abs(q1) * m.mark[coin] > p["params"]["client_cap_usd"]:
            return False, "position above the per-client cap for this coin"
        a2, fee = self.post_trade(a, m, coin, size, fill)
        if a.debt <= 0:          # no loan: margin is Hyperliquid's business
            return True, "ok (no loan)"
        req = req or self.requirement(a, m)
        req2 = self.requirement(a2, m)
        excess_before = self.equity_allow(a, m) - req["IM"]
        excess_after = self.equity_allow(a2, m) - req2["IM"]
        if (req2["MR"] <= req["MR"] + 1e-9 and excess_after >= excess_before - fee - 1e-6
                and self.hl_ratio(a2, m) <= max(self.hl_ratio(a, m), G["hl_ratio_pretrade"])):
            return True, "risk-reducing (requirement does not rise, excess over IM does not fall)"
        st, _, _, _ = self.state(a, m, req)
        if st != "HEALTHY":
            return False, f"account is {st}: only risk-reducing orders"
        fails = self.credit_failures(a2, m, req2)
        if fails:
            return False, "; ".join(fails)
        if self.hl_ratio(a2, m) > G["hl_ratio_pretrade"]:
            return False, "Hyperliquid margin ratio after the trade above 50%"
        return True, "ok"


def load(univ_path, replay_path):
    u = json.load(open(univ_path))
    return Engine(u["coins"], u["margin_tables"], json.load(open(replay_path)))


if __name__ == "__main__":
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # our own scripts only
    import risk_engine_ref as R          # noqa: E402  (one module instance for the examples too)
    import risk_engine_examples as ex    # noqa: E402  (kept separate so this file stays the spec)
    ex.main(R.load(sys.argv[1], sys.argv[2]), sys.argv[3] if len(sys.argv) > 3 else "examples")
