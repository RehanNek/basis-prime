# Risk and credit engine, version 0: the exact mechanism

Written 4 Nov 2026. This is the companion to PLAN.md section 6.9. That section records the decision: the stress test (option B), plus three parts of option C (a client rating, real crash replays, and bigger bad days when markets are wild). PLAN.md says *what* we build. This file says *exactly how it computes*: every formula, parameter and edge case. The Rust code (`risk-core`), the reference script and any reviewer should all get the same numbers from it.

**Version 0 is an intermediate step.** It is the full engine, but run on a limited universe with conservative settings:
- 23 coins;
- two venues;
- USDC loans only.

Section 16 lists what the full version adds.

**How to read it.**
- Each section opens with a plain-words summary, and the formulas follow.
- Section 13 walks through examples with real numbers.
- Section 14 says how all of this was checked.
- Section 15 lists where this file refines or corrects PLAN.md.

**Every number here can be reproduced** from public data with the scripts in `research/scripts/`:

```
python3 -I research/scripts/universe.py <raw_dir> <universe.json>                 # rank coins (section 5)
python3 -I research/scripts/fetch_universe_data.py <udata_dir> [<old_data_dir>]   # prices, funding, books
python3 -I research/scripts/calibrate_universe.py <udata_dir> <universe.json> research/data/universe_v0.json
python3 -I research/scripts/build_replays.py <udata_dir> research/data/replays_v0.json
python3 -I research/scripts/risk_engine_ref.py research/data/universe_v0.json research/data/replays_v0.json examples
python3 -I research/scripts/risk_engine_ref.py research/data/universe_v0.json research/data/replays_v0.json tests
```

`risk_engine_ref.py` is the reference implementation of this document. Where the two disagree, that is a bug in one of them; section 14 says how they were cross-checked.

---

## Contents

0. The whole engine on one page
1. Scope of version 0
2. Units and notation
3. Inputs and prices
4. The safety buffer (maintenance requirement)
5. The allow-list: which coins, and their parameters
6. The client rating
7. The credit line and the interest rate
8. States, actions and bands
9. Pre-trade checks on every order
10. All parameters in one table
11. Edge cases and attacks
12. Limits on the whole book, and defence in depth
13. Worked examples
14. How this was checked
15. Differences from PLAN.md 6.9
16. What the full version adds
- Appendix A: the signed verdict
- Appendix B: formula sheet

---

## 0. The whole engine on one page

> **In simple words.** For each client the engine answers two questions. *How much could this account lose before we can react?* And *given that, how much will we lend, and at what rate?* OutLayer runs it and signs the answers, and the contracts act only on signed answers.

1. **Snapshot.** Read what the account holds right now:
   - tokens in the NEAR account;
   - the Hyperliquid account (cash, positions, resting orders);
   - the loan;
   - money in transit through 1Click.
2. **Prices.** Price each coin from at least three independent sources and take the middle one. Wrapped tokens (nBTC) and stablecoins (USDT) are priced from their own markets.
3. **Stress test.** Imagine a fixed list of bad days. For each one, play out what Hyperliquid's own rules would do (liquidate, auto-deleverage) and what selling everything would cost. The list:
   - every coin moving a calibrated amount, up or down;
   - Hyperliquid force-closing a hedge and the price running on;
   - nBTC slipping below BTC;
   - funding turning against the client for a week;
   - five real crash days replayed.

   The largest loss, with extreme days counted at half, is the **maintenance requirement (MR)**, also called the safety buffer. The **initial requirement (IM)** is 1.25 × MR.
4. **Rating.** A score from 300 to 1000 puts the client in a tier: Preferred, Standard or Watch. The tier sets the loan cap (85%, 70% or 50% of collateral) and the rate markup (+1%, +2% or +5%).
5. **Credit line.** This is the largest loan that keeps all of these true:
   - equity after the loan is at least IM;
   - the pool loses nothing on any normal bad day or crash replay;
   - the pool loses at most 5% of the loan on extreme days;
   - the loan is within the tier cap, the client's limit and the pool's limits.
6. **Watching.**

   | State | Condition |
   |---|---|
   | HEALTHY | equity ≥ IM |
   | WATCH | MR ≤ equity < IM |
   | MARGIN_CALL | 0.8 × MR ≤ equity < MR |
   | DELEVERAGE | equity < 0.8 × MR, or the margin call's clock has reached 4 hours |
   | DEFAULT | debt left after a full unwind |

   Keepers get price **bands** so they know when to ask for a new check.
7. **Gate.** Every Hyperliquid order runs through the same math before it is sent. While there is a loan, an order that adds risk must leave equity at or above IM.

**The five numbers on every signed answer:** equity, MR, IM, credit line and state.

**The limits bind only while the client owes the pool.** With no loan, the pool cannot lose anything: Hyperliquid can't take more than the Hyperliquid account holds, and NEAR tokens can't fall below zero. So a client without a loan may withdraw anything and trade any allow-listed coin within the caps and price bands. The engine still shows MR and the credit line, as information. All of sections 7–9 applies from the moment a loan exists or is requested.

---

## 1. Scope of version 0

> **In simple words.** Version 0 does everything the plan promises, but on purpose it trades only a short list of liquid coins, on two venues, with loans in USDC. That keeps the attack surface small (see Mango Markets, section 11) while the engine proves itself.

| | Version 0 | Later (section 16) |
|---|---|---|
| Venues | The client's NEAR account and Hyperliquid perps (cross margin) | Hyperliquid spot and sub-accounts, Lighter, others |
| Perps | 23 allow-listed coins (section 5) | Larger list, re-ranked automatically |
| Tokens on NEAR | USDC, USDT, nBTC (`nbtc.bridge.near`), ETH (`eth.bridge.near`), wNEAR (`wrap.near`) | More wrapped coins once their unwind costs are measured |
| Loans | USDC from our broker-funded pool | Other assets; Rhea wholesale as a funding source |
| Hedge credit | Only within one coin (nBTC against a BTC short) | Across related coins (ETH against BTC), with tested offsets |
| Orders | Limit orders within a price band; for credit, resting orders count as the worse of filling and not filling | Native TWAP orders, algorithmic execution |
| Isolated margin, options, HL spot | Not allowed | Possible |

The engine is one pure function: snapshot in, verdict out. It runs:
- inside OutLayer for the contracts (signed, `check` mode);
- in the keeper for cheap pre-checks;
- in the browser for what-if sliders.

Only OutLayer's signed output moves money (PLAN.md 5.6).

---

## 2. Units and notation

- **Unit of account: USDC.** All money is in USDC. Prices of coins are in USD from USD and USDT markets, and 1 USD = 1 USDT = 1 USDC is assumed for coin prices. Stablecoin risk is handled separately, through the depeg scenarios on USDT holdings. A fall in USDC itself cannot create a loss for a USDC lender whose loans are repaid in USDC (section 15). Hyperliquid does the same: most of its oracles are quoted against USDT, and its perps settle in USDC with no conversion.
- **Fixed point.** Verdicts carry integer micro-USDC (10⁻⁶ USDC), as in PLAN.md 5.6. Inside the engine, math is IEEE-754 double precision, which is deterministic in WASM. Results are rounded against the client:
  - requirements round up;
  - equity and allowances round down.
- **Hyperliquid units.** Positions are in Hyperliquid's own units. Coins named with a `k` are 1,000 units of the token: `kPEPE` = 1,000 PEPE, so its price is 1,000 × the PEPE price. Every coin carries a unit multiplier (`unit_mult` in `universe_v0.json`). External prices are multiplied by it before they are compared.

| Symbol | Meaning |
|---|---|
| g | a coin (group), e.g. BTC. A group holds the coin's perp and any NEAR token wrapping it (nBTC belongs to BTC). |
| j | a NEAR token. γ(j) is its group; stablecoins have none. |
| u_j, π_j | units held of token j, and its price ratio to its coin (nBTC/BTC); for stablecoins, π_j is its USDC price |
| q_g, e_g, m_g | Hyperliquid position (signed, + long), entry price, mark price |
| P_g, P̄_g | reference price (section 3.2) and its 1-hour TWAP |
| D | the loan, including interest accrued to the snapshot block |
| E, E_A | mark equity and allowance equity (section 3.4) |
| S_g | the coin's normal shock size (section 5.3); S*_g after scaling (section 4.2) |
| MR, IM | maintenance requirement and initial requirement = 1.25 × MR |
| τ | carry horizon: 7 days, i.e. 7/365 years |

---

## 3. Inputs and prices

### 3.1 The snapshot

Every input is public or on-chain, and is read by the program itself (PLAN.md 5.6).

| Input | Source | Rule |
|---|---|---|
| NEAR balances, loan, pending transfers, rating counters and the hourly record | NEAR RPC, at one block height *h* | The verdict carries *h*. The contract rejects it once it is more than 120 blocks old (PLAN.md 5.1). |
| Hyperliquid account | `clearinghouseState` for the account's derived address: cash, positions, entry prices; `frontendOpenOrders`: resting orders | Must be fetched within 10 s of the run |
| Hyperliquid market data | `metaAndAssetCtxs`: marks, oracle prices, funding, open interest, margin tables; `candleSnapshot` 1h (30 days) and 1d (30 days) | Margin tables are read live, never hard-coded |
| Prices | Section 3.2 | |
| nBTC/BTC, ETH/ETH and USDT/USDC | Mainnet: the rules of section 3.3 (wrappers: a committed 1Click quote for one hour of capacity; USDT: its market price). Testnet: the drill ratio (PLAN.md 5.1), used at once for both π_state and π_allow, so the drill doesn't wait for the 15-minute median | |
| Pool state | Pool contract views: capital, loans, utilisation, per-tier rates, the budgets and exposure caps, and the coin-status list | |
| Related accounts | For an account with a KYB entity id: the other accounts of that entity, their loans (pool) and their Hyperliquid positions (public) | Used for the shared caps: P7, C5 and C6 count the entity as one client |

### 3.2 Reference prices

> **In simple words.** One exchange printing a silly price must not move our number. So we ask up to six places and take the middle answer, and we refuse to act on a coin when fewer than three of them are fresh.

For each allow-listed coin g, the candidate sources are:
1. **Hyperliquid's oracle price.** It is itself a weighted median of spot mids: Binance 3, OKX 2, Bybit 2, and Kraken, KuCoin, Gate, MEXC and Hyperliquid spot 1 each. For HYPE, Hyperliquid leaves out outside venues until they are liquid enough.
2. **Binance** spot mid.
3. **OKX** spot mid.
4. **Bybit** spot mid.
5. **Coinbase** spot mid.
6. **Pyth**, through the Hermes API (feed ids in `universe_v0.json`).
   - Since 26 Aug 2026, Hermes needs an API key.
   - Pyth no longer updates its NEAR contract: `pyth-oracle.near`'s last BTC update was 25 Aug 2026.
   - So the enclave either reads Pyth off-chain, with the key kept in OutLayer secrets, or leaves it out.

```
valid(source) = age ≤ 10 s  and (for Pyth) confidence ≤ 0.5% of price
P_g           = median of valid sources                                  (needs ≥ 3 valid, of up to 6)
outlier       = |source / P_g − 1| > δ_tier      δ = 1% (tier 1), 2% (tier 2), 3% (tier 3)
```

**When sources fail:**
- **Fewer than 3 valid sources, or more than one outlier.** The coin is **PRICE_UNCERTAIN**. No new risk is allowed in that coin. Allowance equity values its longs at the lowest valid source and its shorts at the highest.
- **No valid source for 60 s.** The coin is **PRICE_STALE**. Every account holding it is frozen to risk-reducing actions. The state keeps using the last good price, and no unwind starts from stale data alone, unless Hyperliquid's own margin ratio, read directly, passes 80%. Staleness is often our own outage, and must not force-unwind honest clients.

**TWAP.** P̄_g is the time-weighted average, over the last 60 minutes, of the per-minute **median** of the 1-minute closes on Binance, OKX and Bybit. Hyperliquid's own last trades are left out, because a trader can print them. It is used only in section 3.4.

### 3.3 Wrapped tokens and stablecoins

| Token | Group | Price used | Why |
|---|---|---|---|
| USDC | — | 1 | Unit of account |
| USDT | — | π_USDT: the USDT/USDC market price (median of Binance, Kraken, a 1Click dry quote) | A real depeg must show |
| nBTC | BTC | P_BTC × π_nBTC (rule below) | A bridge in trouble shows up as π < 1 before anything else |
| ETH (`eth.bridge.near`) | ETH | P_ETH × π_ETH (rule below) | Same |
| wNEAR | NEAR | P_NEAR (π = 1: `wrap.near` is a 1:1 wrapper of native NEAR) | No bridge |

**The rule for π.** For nBTC and ETH, 1Click is the only real market. 91% of all nBTC sits in NEAR Intents, where 1Click's market makers trade. No NEAR pool can give a second reading: the only pools with any depth hold about $10k each, and they take their price from Pyth's BTC/USD, so they can't see a depeg (`research/near_dex.md`, checked 5 Nov). So π has one source, and the rules around it do the protecting:

```
π_j     = min(1, committed 1Click quote for selling one hour of capacity (κ_j, section 5.4))
π_state = 15-minute median of π_j                  used for mark equity and states
π_allow = lowest π_j of the last hour, ≤ π_state   used for allowance equity and new credit
no reading for 60 s → π = 0.80 (the extreme depeg) and the token is reduce-only
frozen by the operator → π_allow = 0; π_state unchanged (below)
```

π is capped at 1, because a wrapper is never worth more to us than what it wraps. It is sized at one hour of capacity, because that is what we would actually have to sell. The "lowest of the last hour" for allowances is the TWAP rule of section 3.4, applied to wrappers.

**Why one source is acceptable here.**
- No quote can raise the value of collateral, because π is capped at 1.
- A low quote only matters if it lasts. States use the 15-minute median, an unwind needs two checks 2–5 minutes apart (8.1), and for an over-hedged book the plan buys back the short rather than selling the token (8.4).
- What no price rule can catch is a bridge that fails outright. The per-wrapper caps bound that loss (12.1, B1), and the freeze stops new credit at once.

**The freeze.** If a bridge looks unsafe (a hack, a halt, or withdrawals not going through), the operator freezes the token in the pool's coin-status list (5.5). Aave does the same with a frozen reserve.
- At once, the token counts as zero toward new loans and withdrawals (π_allow = 0), and while there is a loan nothing can be swapped into it. No new risk rests on it.
- It keeps its market value (π_state) for loans already out. So the freeze alone never forces anyone to sell, and never moves an account to a worse state.
- Clients are told. They can repay, add money or swap out of the token at any time. The frozen token itself can be withdrawn only once the rest of the account carries the loan, because withdrawals are checked as intents (7.3).
- If the token's price really falls, the normal rules apply: a warning, then a margin call, whose clock allows 4 hours below the requirement in any 24 (8.1), and an unwind only as the last step.
- The operator lifts a freeze the same way. Every freeze and lift is public.

### 3.4 Three kinds of equity

> **In simple words.** We keep three versions of "how much the client is worth".
> - **Mark equity** decides whether to warn or unwind, so it uses today's prices.
> - **Allowance equity** decides new loans and withdrawals, so it ignores two things we can't yet trust: money still in transit, and any gain from the last hour's price move.
> - **Collateral** is allowance equity plus the loan; tier caps apply to it.

```
V_j      = u_j · P_γ(j) · π_j            (crypto tokens)        V_j = u_j · π_j      (stablecoins)
E_HL     = cash_HL + Σ_g q_g · (m_g − e_g)                      Hyperliquid account value
Φ        = 0.98 · Σ (money in transit that is not overdue)       overdue: past its quote's expected time + 30 min
                                                                 only a plan step's transfers; the owner's own moves count 0
E        = Σ_j V_j + E_HL + Φ − D                                mark equity
n_g      = Σ_{j: γ(j)=g} u_j · π_j + q_g                         net units of coin g
A        = Σ_g max(0, n_g · (P_g − P̄_g))                         gains from the last hour's move
M        = Σ_g max(0, q_g · (m_g − P_g))                         perp gains that exist only at Hyperliquid's mark
E_A      = E − Φ − A − M                                         allowance equity (wrappers at π_allow)
C        = E_A + D                                               collateral, for tier caps
```

**The TWAP rule (A)** is the main defence against pump-and-borrow (section 11). Suppose a client's net position gained from the last hour's move. That gain counts toward the state immediately, but toward new credit only once the 1-hour average has caught up. A loss counts at once in both.

**The mark rule (M).** For new credit, a perp counts at the less favourable of Hyperliquid's mark and our reference price. Hyperliquid's premium over spot can't be borrowed against.

**Money in transit (Φ)** counts at 98% for the state, so a rebalance in flight doesn't trigger an unwind. It counts at 0 for allowances, so nobody borrows against money that hasn't arrived. Once overdue, it counts at 0 everywhere, and nothing that adds risk is allowed (PLAN.md 5.1).

**Only a plan step's transfers count as money in transit** (since 12 Nov; `research/audit.md`, A7). There are two kinds of transfer:

- **A plan step's transfer** (`<plan id>:<step>`) is one the engine planned, with a quote it made. It counts as above: 98% for the state, 0 for allowances.
- **The owner's own move** (`move:<n>`: USDC to Hyperliquid or back, a token to Aave's chain or back) counts **0 for the state and 0 for allowances** while it is pending, and nothing as margin already on its way to Hyperliquid when a REBALANCE is sized (8.2).
  - **Why:** the account records a move as the owner states it. It can't see Hyperliquid or Aave's chain, so a record can name money that never left, or was never there. Counted at 98%, a made-up record of $1,000,000 kept an account HEALTHY whatever its collateral did.
  - **What it costs an honest owner:** nothing they were promised. With a loan open, the withdrawal behind a move already needed a verdict that allowed the money to leave for good. With no loan, the state isn't used.
  - **Everything else about a move stays:** the verdict still says when it has arrived (the credit on Hyperliquid, the balance on Aave's chain), and still names it once it is overdue. The money counts again where it lands, when it lands.

---

## 4. The safety buffer (maintenance requirement)

> **In simple words.** The safety buffer is the most the account could lose if a bad day hit before we could react, after paying to sell everything. "Before we could react" means within 4 hours, with no money moving between venues. "Bad days" are a fixed list:
> - prices jumping;
> - Hyperliquid liquidating or auto-deleveraging;
> - nBTC slipping;
> - funding turning against the client for a week;
> - five real crashes replayed.
>
> Extreme days count at half, like OKX and CME do.

### 4.1 Groups and net position

Each coin is a **group**. A group contains the coin's Hyperliquid perp, if any, and any NEAR token that wraps it; nBTC belongs to BTC. Within a group, the perp and the token offset each other, which is how a hedged carry trade gets credit. Across groups there is no offset in version 0: a long SOL perp and a short ETH perp each carry their full risk. Section 16 explains why.

**Conflict groups** are groups with legs on both venues (a NEAR token and a perp). There the worst case may come from either direction, so both are tested. Only BTC, ETH and NEAR can be conflict groups in version 0, because those are the only coins with NEAR-side tokens. That means there are at most 2³ = 8 direction combinations.

### 4.2 Shock size per coin

```
S*_g  = S_g · f_g · ℓ_g
f_g   = min(2.5, max(1, σ_g / σ_g^ref, σ_BTC / σ_BTC^ref))                    volatility factor, section 4.4
ℓ_g   = sqrt(1 + T_g / H)                                                     liquidity factor, H = 4 hours
T_g   = max( (|q_g| · m_g + B_g) / κ_g ,  Σ_{j∈g} (V_j + B_j) / κ_j )          hours to unwind the group
B_g, B_j = what the rest of the book holds in the same coin / token (the routes are shared in a stress)
κ_g   = 0.10 · 0.5 · ADV_g / 24                                               Hyperliquid: 10% of half the usual volume, per hour
κ_j   = 1Click capacity per hour for token j (section 5.4)
```

- **S_g** is the coin's calibrated normal shock: about the largest move seen in 99.9% of 4-hour windows. Section 5.3 shows how it is set.
- **The volatility factor f_g** makes bad days bigger when markets are wild, but never smaller (PLAN.md 6.9 step 4). A BTC storm widens every coin's shocks.
- **The liquidity factor ℓ_g** is the concentration charge (PLAN.md 6.9 step 5).
  - A position that takes T hours to sell at 10% of half the coin's usual Hyperliquid volume is exposed for H + T hours, not H. On a random walk, moves grow with the square root of time.
  - Where the 5%-of-volume term sets the per-client cap, T is 24 hours at the cap, so ℓ = √7 ≈ 2.65. Where open interest sets it, as for BTC, T is shorter: 15.75 hours for BTC, so ℓ = 2.22.
  - Big positions in thin coins therefore need almost full margin, by design.

### 4.3 The Hyperliquid replica

The engine replays Hyperliquid's own rules inside every scenario.

**Maintenance margin, using the coin's live margin table.** Each table has tiers t with a lower bound N_t and a max leverage L_t:

```
rate_t      = 1 / (2 · L_t)
deduction_0 = 0;   deduction_t = deduction_{t−1} + N_t · (rate_t − rate_{t−1})
MM_g(N)     = N · rate_t − deduction_t        for the tier t with N_t ≤ N
MM_HL       = Σ_g MM_g(|q_g| · m_g)
ratio_HL    = MM_HL / E_HL                    (Hyperliquid's "margin ratio"; liquidation at 100%)
```

**Liquidation.** Within a scenario, Hyperliquid liquidates if E_HL(x) < MM_HL(x) at any point of the path.

| Hyperliquid equity at the trigger | What the engine assumes happens |
|---|---|
| E_HL ≥ ⅔ · MM_HL | Book liquidation: all perps are closed. The account pays slippage of max(0.2%, 2 × the unwind cost of section 4.6) on each perp's notional and keeps the rest |
| E_HL < ⅔ · MM_HL | Backstop: all perps are closed and Hyperliquid's liquidator keeps whatever equity is left. The Hyperliquid side ends at 0 |

Hyperliquid's documentation, checked on 4 Nov 2026, says:
- Liquidation is checked at the mark price.
- Book liquidation sends market orders. Above $100k, it sends 20% of the position at a time, with a 30-second cooldown.
- There is no liquidation fee.
- Below ⅔ of maintenance margin, the liquidator vault takes over all cross positions and the cross margin, leaving the trader with zero.
- ADL ranks opposite-side accounts by (mark ÷ entry) × (notional ÷ account value) and closes them at the previous mark price.

Closing everything, rather than part of a position, is conservative: the hedge is assumed lost. A client can never owe Hyperliquid more than its Hyperliquid equity. Anything below zero is Hyperliquid's loss, not ours.

**Auto-deleveraging (ADL).** In the ADL scenarios, Hyperliquid closes the profitable perp at the stage-1 mark price, including the family's adverse gap, with no other cost. That position's PnL is credited to Hyperliquid cash. The rest of the book then takes the stage-2 move unhedged.

### 4.4 The volatility factor

```
r_t      = ln(P_t / P_{t−1}),  hourly, last 720 hours; P_t = median of the Binance, OKX and Bybit hourly closes (not Hyperliquid's last trades, which can be printed)
σ²_t     = 0.99 · σ²_{t−1} + 0.01 · r_t²        (EWMA, λ = 0.99; seeded with the variance of the first 24 returns)
σ_g      = sqrt(σ²_now · 8760)                   annualised
σ_g^ref  = the coin's all-history annualised volatility (section 5.3; BTC 61.4%)
f_g      = min(2.5, max(1, σ_g / σ_g^ref, σ_BTC / σ_BTC^ref))
```

### 4.5 The scenario list

For every account, the engine builds the list below from the groups the account holds. "Adverse" means against the client's net position in that coin. For an exact hedge, adverse means against the Hyperliquid perp, the direction that drains Hyperliquid margin.

| Family | Moves | Shocks combined | Carry | Weight |
|---|---|---|---|---|
| **Normal** | For k = ⅓, ⅔ and 1, three kinds of move: every coin down k·S*; every coin up k·S*; and, for each of the up to 8 sign combinations of the conflict groups, those groups moving ±k·S* while every other coin moves adversely by k·S* | Adverse perp-vs-index gap of β_g on every perp; normal depeg: bridged tokens −2%, USDT −1% | Stress | 1 |
| **ADL** | For each coin g with a perp, two paths: the market moves in g's favour by k₁·S* (every coin, same direction); Hyperliquid closes g's perp; every coin then moves another k₂·S*, compounding: the total is (1 + x₁)(1 + x₂) − 1. (k₁, k₂) = (⅔, ⅔) and (1, ½) | Gap and normal depeg as above | Stress | 1 |
| **Squeeze, then revert** | For each coin g with a perp, three paths: the market moves *against* g's perp by k₁·S* (every coin, same direction); Hyperliquid's rules run, and may liquidate; then every coin moves back by k₂·S*. (k₁, k₂) = (⅔, ⅔), (1, ½) and (1, 1). This is the JELLY / POPCAT pattern, and the 13 Mar 2020 one | Gap and normal depeg | Stress | 1 |
| **Extreme** | For k = 2, the same three kinds of move as Normal | None | Normal | ½ |
| **Extreme: crash and bridge slip** | Every coin down 2·S* (capped at −90%) | Bridged tokens −5%, USDT −1% | Normal | ½ |
| **Extreme: one wrapper fails** | No price move | One token at a time: bridged −20%, USDT −13% | Normal | ½ |
| **Replay** | 10 real 4-hour windows: the worst fall and the worst rise of BTC on 12 Mar 2020, 19 May 2021, 8 Nov 2022, 5 Aug 2024 and 10 Oct 2025. Each is the 240 one-minute closes, in time order; a liquidation affects only what comes after it. Closes are used rather than one exchange's wicks, because Hyperliquid's mark is a median across venues. Each coin follows its own recorded path. A coin with no minute data that window follows BTC's path × a scale stored with the window. If the coin traded on Hyperliquid then, the scale is its own move ÷ BTC's over those hours (from Hyperliquid's 4-hour candles). Otherwise it is the 75th percentile of that ratio among coins that did trade, and at least 1. An invented path never goes past the coin's own extreme size (±2·S). Hyperliquid's rules are checked at every minute | Gap and normal depeg | Normal | 1 |

**Every invented move can fall at most 90%.** Without this cap, a big position in a thin coin (ℓ_g large) could be given a fall of more than 100%. Two-stage paths apply the cap to each stage and to the total. Recorded replay closes are used as recorded: PUMP's 10 Oct 2025 path reaches −90.8%, and that was real.

**Why these choices.**
- **The ladder and its sizes.** The ⅓ / ⅔ / 1 ladder, extremes at 2× counted at half, and BTC's 4%, 8%, 12% and 24% all come from OKX's portfolio-margin grid (PLAN.md 6.4).
- **Rate stress on the normal grid only.** Stress carry applies to the normal grid, as in PLAN.md. Extreme days use normal carry, so that two rare events are not stacked.
- **Replays count in full.** Replays are history, not imagination, so they count at full weight (PLAN.md 6.9 step 5).
- **No money moves inside any scenario.** This is the "1Click down: each venue must survive on its own" rule of PLAN.md 6.4, applied everywhere.

### 4.6 Unwind costs

Every scenario ends by selling everything at the scenario's prices.

```
Hyperliquid perps:  c_g(N) = 0.045% (taker fee) + spread_g/2 + 1.0 · σ_g^day · f_g · sqrt(N / (0.5 · ADV_g))
                    σ_g^day = σ_g^ref / sqrt(365)
1Click (NEAR side): c_j(V) = (c0_j + c1_j · sqrt(V / $100k)) · f_γ(j)
cost                = Σ_g c_g(N_g) · N_g + Σ_j c_j(V_j) · V_j
```

The Hyperliquid formula is the standard square-root market-impact rule. The cost of selling N in a day is about one day's volatility × √(N / daily volume). The 1Click numbers in section 5.4 are placeholders until the day-1 dry quotes (PLAN.md 13).

### 4.7 Carry

```
interest  = D · r · τ                         r = base(U) + spread_tier (normal) or base(100%) + spread_tier (stress)
funding   = Σ_g q_g · m_g(x) · F_g · τ        positive F: longs pay shorts
            F_g = normal: the coin's trailing 30-day average;  stress: F_g⁺ (worst 7-day average for longs) if q_g > 0,
                                                          F_g⁻ (worst 7-day average for shorts) if q_g < 0
```

A perp that Hyperliquid has closed in the scenario pays no funding.

### 4.8 The requirement

For a scenario with moves x (one stage; two for ADL and squeeze; 240 one-minute closes for a replay):

```
m_g(x)     = m_g · (1 + x_g) · (1 − sign(q_g) · β_g)         adverse gap on every perp (if the family has it)
E_HL(x)    = E_HL + Σ_g q_g · (m_g(x) − m_g)                then the replica's liquidation rule (section 4.3)
V_j(x)     = u_j · P_γ(j) · (1 + x_γ(j)) · π_j · (1 − d_j)  d_j = the family's depeg for token j
Φ(x)       = 0.98 · Σ_k V_k(x) over money in transit that isn't overdue, valued like the same token held; 0 if overdue
             (money in transit as in 3.4: a plan step's transfers, never the owner's own moves)
E(x)       = Σ_j V_j(x) − cost_NEAR + E_HL,after(x) − cost_HL + Φ(x) − D − interest − funding
L(x)       = E − E(x)
```

Money in transit takes each scenario's moves like the same token held: its coin's move and its depeg (changed on 7 Nov, 14.5). It pays no unwind cost and doesn't count toward the liquidity factor or the adverse direction, because it can't be sold until it arrives.

For paths, L is the worst value over the path. Then:

```
MR = max( max_{Normal, ADL, Squeeze} L ,  ½ · max_{Extreme} L ,  max_{Replay} L ,  0 )
IM = 1.25 · MR
```

The verdict names the **top three risks**: the scenarios with the largest weighted loss, in words. Examples are "nBTC depeg 20%" and "ADL BTC ⅔S then ⅔S".

---

## 5. The allow-list: which coins, and their parameters

> **In simple words.** Mango Markets lost over $110M in October 2022 to one trader. The trader pushed up the price of a thin coin (MNGO) and borrowed everything against the paper profit. The defence starts with which coins we accept at all. We take only coins that are big, traded on several large exchanges, liquid on Hyperliquid itself, and covered by an independent oracle. Then we size each coin's bad days from its own history.

### 5.1 Selection rules

A coin is allowed if it passes **all** of these. They are measured by `universe.py` from public APIs, and the run here was on 04 Nov 2026.

| # | Rule | Why |
|---|---|---|
| E1 | Hyperliquid perp, cross margin allowed, Hyperliquid max leverage ≥ 10× | Hyperliquid's own view of the coin's liquidity |
| E2 | Spot traded on Binance and on at least one of OKX, Bybit, Coinbase | At least three independent price sources besides Hyperliquid |
| E3 | Spot volume ≥ $10M a day across those venues | Pushing the reference price must be expensive |
| E4 | Market cap ≥ $1B (CoinGecko) | Same; also rules out tiny floats |
| E5 | Hyperliquid open interest ≥ $10M and 30-day average volume ≥ $3M a day | We must be able to unwind on Hyperliquid |
| E6 | A Pyth feed exists | Institutional oracle coverage, and one more price source. It is read through Hermes, because Pyth's NEAR contract stopped updating in Aug 2026 |
| E7 | Not a stablecoin or a liquid-staking token | Different risk; handled as tokens, not perps |
| E8 | At least one year of price history | Calibration needs it; younger coins get the young-asset floor (section 5.3) |

<!-- tables:allowlist -->
**Result on 04 Nov 2026: 23 coins pass every rule** (ranked by the weaker of Hyperliquid volume and spot volume, so the coin's thinnest venue sets its rank).

| # | Coin | Tier | HL max lev. | HL open interest | HL volume (30-day avg) | Spot volume (24h) | Market cap | History |
|---|---|---|---|---|---|---|---|---|
| 1 | BTC | 1 | 40× | $3,108M | $2,368M | $3,553M | $1,572.6B | 7.8 y |
| 2 | ETH | 1 | 25× | $2,376M | $1,007M | $1,292M | $282.8B | 7.8 y |
| 3 | ZEC | 2 | 10× | $646M | $335M | $314M | $21.8B | 7.6 y |
| 4 | SOL | 2 | 20× | $532M | $212M | $453M | $54.7B | 6.2 y |
| 5 | NEAR | 2 | 10× | $179M | $197M | $169M | $5.2B | 6.1 y |
| 6 | HYPE | 2 | 10× | $1,849M | $505M | $140M | $20.2B | 1.9 y |
| 7 | XRP | 3 | 20× | $213M | $66M | $453M | $81.1B | 7.8 y |
| 8 | ENA | 3 | 10× | $82M | $47M | $64M | $2.4B | 2.6 y |
| 9 | PUMP | 3 | 10× | $102M | $94M | $39M | $2.0B | 1.1 y |
| 10 | WLD | 3 | 10× | $63M | $36M | $42M | $1.4B | 3.3 y |
| 11 | kPEPE | 3 | 10× | $58M | $31M | $96M | $2.1B | 3.5 y |
| 12 | UNI | 3 | 10× | $75M | $22M | $90M | $4.4B | 6.1 y |
| 13 | BNB | 3 | 10× | $48M | $19M | $136M | $92.0B | 7.8 y |
| 14 | SUI | 3 | 10× | $30M | $19M | $57M | $3.7B | 3.5 y |
| 15 | ONDO | 3 | 10× | $19M | $12M | $18M | $1.9B | 1.6 y |
| 16 | AAVE | 3 | 10× | $58M | $11M | $47M | $2.0B | 6.1 y |
| 17 | DOGE | 3 | 10× | $75M | $11M | $67M | $11.7B | 7.3 y |
| 18 | ARB | 3 | 10× | $15M | $10M | $14M | $1.1B | 3.6 y |
| 19 | LINK | 3 | 10× | $57M | $9.1M | $54M | $8.5B | 7.8 y |
| 20 | AVAX | 3 | 10× | $17M | $7.3M | $26M | $3.8B | 6.1 y |
| 21 | ADA | 3 | 10× | $26M | $6.9M | $24M | $7.1B | 7.8 y |
| 22 | TRX | 3 | 10× | $14M | $4.8M | $53M | $30.3B | 7.8 y |
| 23 | LTC | 3 | 10× | $20M | $4.8M | $20M | $4.2B | 7.8 y |

**Next in line**, if the list grows to 25:

| Coin | HL max lev. | HL open interest | HL volume | Spot volume | Market cap | History | Fails |
|---|---|---|---|---|---|---|---|
| TAO | 5× | $31M | $10M | $14M | $2.7B | 2.6 y | E1 (Hyperliquid max leverage below 10×) |
| GRAM | 5× | $22M | $3.6M | $14M | $3.3B | 0.3 y | E1 (Hyperliquid max leverage below 10×); E8 (under a year of history) |

**Big on Hyperliquid but excluded:** these show why every rule is there.

| Coin | HL open interest | HL volume | Fails |
|---|---|---|---|
| XMR | $150M | $39M | E1 max leverage < 10×; E2 no Binance spot; E2 < 2 major spot venues; E3 spot < $10M/day |
| LIT | $132M | $29M | E1 max leverage < 10×; E2 no Binance spot; E4 market cap < $1B |
| VVV | $65M | $16M | E1 max leverage < 10×; E2 no Binance spot; E3 spot < $10M/day |
| XPL | $52M | $16M | E4 market cap < $1B |
| FARTCOIN | $20M | $8.1M | E2 no Binance spot; E2 < 2 major spot venues; E3 spot < $10M/day; E4 market cap < $1B |
| STRK | $27M | $28M | E1 max leverage < 10×; E4 market cap < $1B |
| ZRO | $64M | $21M | E1 max leverage < 10×; E4 market cap < $1B |
<!-- /tables:allowlist -->

### 5.2 Calibration rules

All figures come from `calibrate_universe.py`.

| Parameter | Rule | Source |
|---|---|---|
| Normal shock S_g | max(tier floor, α × the coin's 99.9% 4-hour move, rounded up to 1%), where α = 12% ÷ BTC's 99.9% 4-hour move (the anchor factor α = 1.082; BTC's 99.9% 4-hour move is 11.1%), so BTC stays at 12% (PLAN.md 6.9). Tier floors: BTC fixed at 12%; ETH and tier 2 at 18%, so ETH keeps PLAN.md's 18%; tier 3 at 25%; coins with under 2 years of history at 30%. Tier 1 is BTC and ETH, tier 2 has ≥ $100M a day on Hyperliquid, tier 3 is the rest | Binance spot 1h since 2019 or listing, skipping the first 48 hours after listing. A "4-hour move" runs from an hour's open to the worst low or best high within the next 4 hours. Coins with under a year on Binance (HYPE, listed there 24 Sep 2026) use Hyperliquid's 4-hour candles instead, one window per candle |
| Extreme size | 2 × S_g up; 2 × S_g down, capped at 90% | |
| Perp-vs-index gap β_g | max(0.3%, the 99.9th percentile of Hyperliquid's hourly premium over the oracle, last year) | Hyperliquid `fundingHistory` |
| Reference volatility σ^ref | All-history annualised volatility of hourly returns | Binance 1h |
| Funding stress F⁺, F⁻ | Worst 7-day average funding against longs and against shorts, annualised, over all the history fetched: since May 2023 for BTC and ETH, Nov 2023 for NEAR, the last year for the rest | Hyperliquid `fundingHistory` |
| Per-client cap | min(5% × 30-day average Hyperliquid volume, 2.5% × open interest) per coin | Hyperliquid |
| Whole-book cap | 3 × the per-client cap | |
| Order price band | 1% (tier 1), 2% (tier 2), 3% (tier 3) from the reference price. On testnet only, 3% for every coin (section 9, "The testnet price band") | |

### 5.3 Parameters per coin

<!-- tables:params -->
| Coin | S | Extreme ↓ / ↑ | Calibrated S | Worst 4h ↓ / ↑ | Gap β | σ_ref | Beta to BTC | Funding stress F⁻ / F⁺ | Per-client cap | Band | 4h windows past S |
|---|---|---|---|---|---|---|---|---|---|---|---|
| BTC | 12% | -24% / +24% | 12.0% | -35% / +34% | 0.30% | 61% | 1.00 | -25% / +122% | $78M | 1% | 0.080% ↓, 0.055% ↑ |
| ETH | 18% | -36% / +36% | 16.0% | -37% / +43% | 0.30% | 78% | 1.22 | -21% / +76% | $50M | 1% | 0.051% ↓, 0.010% ↑ |
| ZEC | 25% | -50% / +50% | 24.3% | -54% / +61% | 0.39% | 118% | 1.37 | -69% / +43% | $16M | 2% | 0.075% ↓, 0.034% ↑ |
| SOL | 24% | -48% / +48% | 23.8% | -46% / +60% | 0.30% | 118% | 1.35 | -35% / +14% | $11M | 2% | 0.042% ↓, 0.071% ↑ |
| NEAR | 21% | -42% / +42% | 20.5% | -48% / +96% | 0.30% | 126% | 1.49 | -10% / +175% | $4.5M | 2% | 0.066% ↓, 0.075% ↑ |
| HYPE | 30% | -60% / +60% | 15.7% | -26% / +35% | 0.30% | 112% | 1.47 | -2% / +24% | $25M | 2% | 0.000% ↓, 0.024% ↑ |
| XRP | 25% | -50% / +50% | 22.4% | -54% / +98% | 0.30% | 97% | 1.31 | -19% / +20% | $3.3M | 3% | 0.055% ↓, 0.051% ↑ |
| ENA | 25% | -50% / +50% | 20.5% | -75% / +24% | 0.30% | 132% | 1.66 | -40% / +34% | $2.0M | 3% | 0.018% ↓, 0.000% ↑ |
| PUMP | 30% | -60% / +60% | 17.2% | -92% / +18% | 0.30% | 130% | 1.72 | -4% / +39% | $2.6M | 3% | 0.040% ↓, 0.000% ↑ |
| WLD | 26% | -52% / +52% | 25.8% | -77% / +44% | 0.30% | 130% | 1.57 | -74% / +36% | $1.6M | 3% | 0.056% ↓, 0.084% ↑ |
| kPEPE | 29% | -58% / +58% | 28.4% | -68% / +52% | 0.30% | 134% | 1.69 | -42% / +39% | $1.5M | 3% | 0.016% ↓, 0.072% ↑ |
| UNI | 25% | -50% / +50% | 20.5% | -74% / +77% | 0.30% | 113% | 1.47 | -7% / +32% | $1.1M | 3% | 0.026% ↓, 0.032% ↑ |
| BNB | 25% | -50% / +50% | 17.2% | -44% / +34% | 0.30% | 80% | 0.82 | -6% / +27% | $947k | 3% | 0.026% ↓, 0.012% ↑ |
| SUI | 25% | -50% / +50% | 19.4% | -83% / +24% | 0.30% | 106% | 1.58 | -9% / +28% | $759k | 3% | 0.042% ↓, 0.000% ↑ |
| ONDO | 30% | -60% / +60% | 16.7% | -70% / +35% | 0.30% | 94% | 1.59 | -6% / +36% | $480k | 3% | 0.037% ↓, 0.007% ↑ |
| AAVE | 25% | -50% / +50% | 20.3% | -70% / +38% | 0.30% | 114% | 1.46 | -1% / +39% | $567k | 3% | 0.034% ↓, 0.015% ↑ |
| DOGE | 40% | -80% / +80% | 40.0% | -60% / +137% | 0.30% | 120% | 1.48 | -14% / +25% | $551k | 3% | 0.017% ↓, 0.083% ↑ |
| ARB | 25% | -50% / +50% | 18.0% | -74% / +29% | 0.30% | 98% | 1.51 | -13% / +21% | $375k | 3% | 0.025% ↓, 0.016% ↑ |
| LINK | 25% | -50% / +50% | 21.2% | -100% / +75% | 0.30% | 111% | 1.46 | 0% / +34% | $455k | 3% | 0.050% ↓, 0.026% ↑ |
| AVAX | 25% | -50% / +50% | 21.4% | -68% / +40% | 0.30% | 118% | 1.40 | -16% / +19% | $363k | 3% | 0.043% ↓, 0.043% ↑ |
| ADA | 25% | -50% / +50% | 19.9% | -65% / +77% | 0.30% | 100% | 1.53 | -29% / +18% | $343k | 3% | 0.026% ↓, 0.015% ↑ |
| TRX | 25% | -50% / +50% | 17.0% | -39% / +47% | 0.35% | 80% | 0.38 | -68% / +22% | $240k | 3% | 0.019% ↓, 0.022% ↑ |
| LTC | 25% | -50% / +50% | 18.4% | -59% / +39% | 0.30% | 92% | 1.16 | -8% / +25% | $240k | 3% | 0.028% ↓, 0.009% ↑ |
| TAO (next) | 25% | -50% / +50% | 19.6% | -63% / +25% | 0.30% | 111% | 1.52 | -22% / +38% | $511k | 3% | 0.058% ↓, 0.004% ↑ |
| GRAM (next) | 30% | -60% / +60% | 11.0% | -11% / +10% | 0.32% | 57% | 0.85 | -15% / +53% | $178k | 3% | 0.000% ↓, 0.000% ↑ |
<!-- /tables:params -->

**Notes on the table:**
- **Worst 4-hour falls include single-exchange wicks on Binance.** LINK printed $0.0001 on 12 Mar 2020, and PUMP and SUI wicked −91% and −82% on 10 Oct 2025. They barely move the 99.9% quantile that sets S, and replays use closes rather than wicks.
- **HYPE is calibrated from Hyperliquid's own 4-hour candles** (section 5.2), so its window count is smaller.
- **Funding stress F⁻ / F⁺** is the worst 7-day average paid by shorts / longs, annualised.

### 5.4 NEAR-side tokens

| Token | Contract | Normal / crash / extreme depeg | 1Click cost c0 + c1·√(V/$100k) | 1Click capacity |
|---|---|---|---|---|
| USDC | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | 0 / 0 / 0 | 0 | n/a |
| USDT | `usdt.tether-token.near` | 1% / 1% / 13% | 0.05% + 0.05% | $500k per hour |
| nBTC | `nbtc.bridge.near` | 2% / 5% / 20% | 0.10% + 0.40% | $500k per hour |
| ETH | `eth.bridge.near` | 2% / 5% / 20% | 0.10% + 0.40% | $50k per hour |
| wNEAR | `wrap.near` | 0 / 0 / 0 | 0.10% + 0.40% | $250k per hour |

- **Depegs.** The 2% and 20% bridged depegs are PLAN.md's policy choice; renBTC and Multichain's BTC went to zero. The 13% USDT extreme mirrors USDC's fall in March 2023.
- **Costs.** The formula gives 0.23% for $10k and 0.5% for $100k, PLAN.md's assumption. Public dry quotes on 5 Nov (`research/day1.md`) came in at or below it at every size for nBTC, wNEAR and USDT. For example, nBTC cost 0.17–0.21% at $10k and about 0.33% from $50k to $500k. ETH came in slightly above it at small sizes: 0.19–0.27% at $10k and 0.33–0.40% at $50k. On 7 Nov, with our partner key, every route came in lower: nBTC 0.15–0.18% from $10k to $500k, ETH 0.17–0.18% up to $100k, and real quotes matched dry ones to within 0.2 bp. The day's market, not the key, made the difference. The formula stays: it is above every measurement made with our key.
- **Capacities.** On 5 Nov each capacity was set to the largest single sale 1Click quoted every time, or kept where it was already lower. We lower a capacity on public quotes but never raise one.

  | Token | Before | Now | Why |
  |---|---|---|---|
  | USDT | $1M | $500k | $1M had no liquidity |
  | ETH | $500k | $50k | $100k failed once in four tries; $250k always failed |
  | nBTC | $500k | $500k | Confirmed: $500k quoted every time, $1M never |
  | wNEAR | $250k | $250k | It quoted up to $500k, but never raised on public quotes |

  The π rule's quote is sized at this capacity (3.3), so it has to be a size that quotes every time.
- **Excluded tokens.** Other NEAR tokens 1Click supports (ZEC via `zec.omft.near`, wBTC, stNEAR, SOL via a `miden-…omft.near` token) are out of version 0 until their unwind costs are measured.

### 5.5 Reviewing the list

- **Monthly.** Re-run `universe.py` and `calibrate_universe.py`. The parameter file is compiled into the OutLayer program, so its hash pins it (PLAN.md 5.6). Each recalibration is a new program version. It reaches an account when its owner accepts it, or 30 days after it is published (11.9, S2).
- **Adding a coin.** It must pass all of E1–E8 on two monthly runs in a row.
- **Removing a coin.**
  - The coin becomes reduce-only at once: no new risk.
  - For 7 days its shock is multiplied by 1.5.
  - After that, positions in it are unwound by the deleveraging plan.
- **Emergency removal by the operator.** This applies when Hyperliquid announces a delisting, a coin's oracle sources fail, or a manipulation is detected. The coin becomes reduce-only immediately, and its shock is ×1.5 at once. The full extreme shock applies after 24 hours, or immediately if Hyperliquid has actually halted the market. Clients get the 24 hours to reduce, so a sudden rule change doesn't force-unwind honest books.
- **Where coin status lives.** The operator sets each coin's status (allowed, reduce-only or removed, with the time of the change) in a list in the pool. Every program version reads it, so removing a coin needs no new version. Orders that only shrink a position pass in either status. Once a removal's notice runs out (7 days, or 24 hours in an emergency), the status is *removed*: an account with a loan gets a plan that closes its positions in the coin, whatever its state, run like a DELEVERAGE plan. An account without a loan is left alone, because the pool has no exposure to it. The list also holds the bridged tokens (nBTC, ETH and USDT). Their only other status is *frozen* (3.3): no new credit rests on the token, and nothing is forced on anyone.

---

## 6. The client rating

> **In simple words.** Everyone starts at 650 (Standard). Points come from four things:
> - how hedged the book is;
> - how long the client has been in good standing with us;
> - their record on Hyperliquid, if they prove an address is theirs;
> - a KYB check.
>
> The score picks the tier, and the tier sets the loan cap and the rate markup. A new client's limit also starts small and grows with good months, so nobody can build trust cheaply and then borrow big and vanish.

```
score = clamp(300, 1000,
          650
        + (+50 if HR ≥ 0.8;  −100 if HR < 0.3;  else 0)          portfolio, only if coins ≥ 25% of equity (7-day avg)
        + min(100, 10 · good_months)                               history with us
        − 75 · forced_unwinds_last_12m − 35 · forced_unwinds_older
        + (+100 if a linked Hyperliquid address is ≥ 6 months old, has ≥ 50 fills and ≥ $1M of volume,
                and no liquidation in 12 months; one link per address, across all accounts)
        − min(150, 50 · linked_liquidations_last_12m)              outside track record
        + (+100 if KYB recorded) )                                 verification
score = 300 after any default (write-off); the account is blocked until a manual review.

HR   = min(hedge ratio now, its 7-day average)
hedge ratio = 1 − Σ_g |Σ legs of g| / Σ_g Σ |legs of g|            (legs in USDC; 1 if the account holds no coins)
```

| Score | Tier | Loan cap (share of collateral C) | Rate markup | Starting limit | Limit grows to |
|---|---|---|---|---|---|
| 800 and above, **and KYB recorded** | Preferred | 85% | +1% | $1,000,000 | $5,000,000 |
| 600–799 | Standard | 70% | +2% | $250,000 | $1,000,000 |
| Below 600 | Watch | 50% | +5% | $50,000 | $100,000 |
| Below 450 | Watch, and no new credit | — | +5% | — | — |

**Rules around the score:**
- **Good months.** A good month is 30 days in which a loan was outstanding on at least 20 days, no margin call ran its clock out (8.1), and there was no forced unwind. Dormant accounts earn nothing. The client's limit is starting limit × 1.1^good_months, up to the tier's maximum.
- **Only the client's own failures count.** A forced unwind costs points only when it followed a margin call the client let run out. Unwinds caused by a data or venue event (PRICE_STALE, an emergency coin removal) cost nothing.
- **Where the averages come from.** Each verdict adds the account's hedge ratio and its coins' share of equity to an hourly record in the account contract, which keeps the lowest hedge ratio and the highest share seen in each hour. The 7-day averages come from that record. The keeper asks for a check at least once an hour, at a random minute, for every account with a loan, so the client can't choose when samples are taken. For an account younger than 7 days, the 7-day averages (the hedge ratio, and the coins' share of equity) run over its life so far.
- **Tier changes.** A downgrade applies at once. An upgrade applies at most once every 30 days. A higher score can't be manufactured for one borrow.
- **Where the inputs live.** The account contract keeps the counters and the hourly record, updated by each verdict. The pool keeps the KYB flag and any manual override, with a reason and an expiry (PLAN.md 6.9).
- **Linking a Hyperliquid address.** The owner signs a message with the address. The engine reads that address's public `portfolio` and `userFillsByTime` data when it is linked, and again monthly.

**What changed from PLAN.md:** see section 15. The plan gave +10 for each margin call fixed within 4 hours, which also rewards getting margin calls; this version rewards months in good standing instead.

---

## 7. The credit line and the interest rate

> **In simple words.** We lend the largest amount that still leaves the client above the initial requirement after the money has left the account. The pool must lose nothing on any normal bad day or replay, and at most 5% of the loan on extreme days. The loan must also fit the tier cap, the client's limit and the pool's limits. Because each bad day's loss grows in a straight line with the loan (only through interest), the answer is a simple minimum. No search is needed.

### 7.1 The rate

```
base(U) = 6% · U / 0.8                      for U ≤ 80%       (U = pool utilisation)
        = 6% + 44% · (U − 0.8) / 0.2        for U > 80%       (50% at U = 100%)
rate    = base(U) + spread_tier            Preferred +1%, Standard +2%, Watch +5%
```

This is unchanged from PLAN.md 5.1. A market-based alternative was discussed on 4 Nov and not adopted. If it is adopted later, it replaces `base(U)` only.

### 7.2 The credit line

A loan W is assumed to leave the account; that is the client's purpose. So W lowers equity by W, and each scenario's loss rises by the interest on W:

```
L_k(W) = L_k + W · r_k · τ           r_k = the rate used by scenario k (stress for Normal/ADL, normal otherwise)
```

W*, the most the account may borrow now, is the minimum of these bounds, and never below 0. With no loan, W* is the credit line; with a loan D, the line is D + W* (below).

| Bound | Formula | Meaning |
|---|---|---|
| C0 | E_A, or 0 if E_A < $1,000 | Can't lend more than the client is worth; no credit for dust accounts |
| C1, each scenario k | (E_A − 1.25·ω_k·L_k) / (1 + 1.25·ω_k·r_k·τ), with ω_k = ½ for extremes and 1 otherwise | Equity after the loan ≥ IM |
| C2, each non-extreme k | (E_A − L_k) / (1 + r_k·τ) | The pool loses nothing (always implied by C1; kept as a check) |
| C3, each extreme k | (E_A − L_k + 5%·D) / (0.95 + r_k·τ) | The pool loses at most 5% of the total loan D + W |
| C4 | cap_tier · C − D | Tier cap on collateral |
| C5 | limit_tier(good_months) − D | The client's limit (section 6) |
| C6 | min(90% · capital − loans, 25% · capital − D) | Pool utilisation ≤ 90%; one client ≤ 25% of the pool |
| C7 | (pool contract) the per-wrapper exposure cap of section 12 | No more than the allowed share of the pool backed by one bridge |
| C8 | 0 if any group needs more than 24 hours to unwind (T_g of section 4.2) | We must be able to get out within a day |
| C9 | 0 if the score is below 450 | Section 6 |

**Derivation of C1.** Equity after the loan is E_A − W. IM after the loan is 1.25 × max_k ω_k·(L_k + W·r_k·τ). Requiring E_A − W ≥ 1.25·ω_k·(L_k + W·r_k·τ) for every k, and solving for W, gives C1.

**Derivation of C3.** Pool loss is max(0, L_k(W) − (E_A − W)), and it must be ≤ 5%·(D + W). Solving for W gives C3.

For a fixed rate, all the constraints are linear in W, so the minimum is exact. Section 14 also checks it by brute force, where C1, C3 and C4 each bind. C2 is implied by C1 only at full weight (ω = 1) and when L_k ≥ −E_A·r_k·τ. Otherwise C0 binds first.

**The utilisation feedback.** A loan raises utilisation, and with it the normal rate r_k. The engine solves once with today's rate, recomputes the rate at the new utilisation, and solves again. A higher rate only lowers W, so the second answer W₂ is safe (W₂ ≤ the true W*), though not exact. Over a 7-day horizon the difference is a few dollars: $11 in example 13.1.

**The line and the pool's own limits.** W* is how much more the account may borrow now. The verdict's `line` is D + W*, the most the account may owe; with no loan, the two are equal. The pool's own limits (12) can stop a borrow below W*: the first-week limit, the daily lending budget, the Hyperliquid-exposure cap and the NEAR-side book caps. They are not bounds in the table above, because they depend on time and on other accounts. The UI shows the smaller of W* and the pool's headroom, and names whichever binds.

### 7.3 Withdrawals

With no loan, there is no limit: the client can withdraw anything. With a loan, a USDC withdrawal of X from the NEAR account changes no position, so:

```
X ≤ min( E_A − IM ,                           stay above IM
         C − D / cap_tier ,                    stay within the tier cap
         E_A − L_k + 5%·D  for every extreme k ,
         free USDC in the NEAR account )
```

Withdrawing any other token, or anything from Hyperliquid, changes the book. So does moving USDC from NEAR to Hyperliquid: margin there can be lost whole in a backstop (13.1). Each such request is checked as an intent: the engine runs on the book as it would be afterwards, and requires **every credit condition** there.

**The credit conditions.** While there is a loan, every risk-adding action must leave three things true afterwards:
- E_A ≥ IM;
- D ≤ cap_tier · C (the tier cap);
- extreme-day pool loss ≤ 5% · D.

Risk-adding actions are a borrow, any withdrawal, and any order (P8). So no outflow, and no trading loss, can leave the loan above its tier cap.

---

## 8. States, actions and bands

> **In simple words.**
> - **HEALTHY:** above the initial requirement. The client can borrow and withdraw.
> - **WATCH:** between the buffer and the initial requirement. No new risk.
> - **MARGIN_CALL:** below the buffer. The client gets 4 hours to fix it.
> - **DELEVERAGE:** well below the buffer, or 4 hours have passed. Anyone can run our signed unwind plan.
> - **DEFAULT:** debt is left after everything is sold. We write it off from our own capital.
>
> Separately from the state, the engine asks for a **rebalance** when the Hyperliquid side runs low on margin, even if the account as a whole is fine.

### 8.1 States

| State | Condition (E = mark equity) | Allowed | Engine action |
|---|---|---|---|
| HEALTHY | E ≥ IM | Everything within allowances | None, or REBALANCE |
| WATCH | MR ≤ E < IM | Only risk-reducing actions | Email and banner; REBALANCE if needed |
| MARGIN_CALL | 0.8·MR ≤ E < MR, and the call's clock is under 4 h | Only risk-reducing actions | Email; REBALANCE if needed |
| DELEVERAGE | E < 0.8·MR, or a margin call whose clock has reached 4 hours | Only risk-reducing actions | DELEVERAGE plan (section 8.4) |
| DEFAULT | Everything sold and D > 0 | Nothing | `write_off` (PLAN.md 5.1) |

**States apply only while there is a loan.** An account with no loan is always HEALTHY; its MR and IM are shown as information only.

**The margin-call clock.**
- It counts the total time with E < MR over a rolling 24 hours, so dipping in and out doesn't reset it.
- Between two verdicts, the time counts as below MR if the earlier verdict said so. During a margin call, the keeper asks for a check at least every 5 minutes, so the clock stays close to the truth.
- A call ends only when E ≥ IM. Or, after the client acts (deposits, repays or reduces), when E stays ≥ 1.02·MR for one unbroken hour.
- The contract stores the clock.

**Precedence.**
- DEFAULT (nothing left, debt remains) beats everything.
- A margin-call clock that has reached 4 hours means DELEVERAGE, whatever hysteresis says.
- The unwind plan aims for 1.02 × IM, so the account really ends HEALTHY.

**DELEVERAGE must show twice.** The condition must hold on two checks 2–5 minutes apart, so one bad print can't start an unwind. The one exception is ratio_HL ≥ 80% (Hyperliquid about to liquidate), which acts at once.

**Hysteresis.** Moving to a better state needs equity 2% above that state's threshold. This stops the state flickering around a line. Moving to a worse state happens at once.

### 8.2 Rebalancing

When ratio_HL ≥ 80%, Hyperliquid is close to liquidating. The action is REBALANCE_NOW, which needs no second check (8.1).

Otherwise, a REBALANCE action is added, whatever the state, when either of these holds:
- ratio_HL ≥ 60%; or
- a **projected breach**: ratio_HL ≥ 100% after every perp moves against itself by ½·S*. That is roughly a 1-hour 99.9% move, the "stress rebalance window" in PLAN.md 6.1.

The rebalance plan restores ratio_HL to 30%, using in order:
1. free USDC in the NEAR account;
2. USDT, swapped to USDC;
3. selling part of the NEAR-side coin of a hedged group, while reducing the matching perp by the same amount, so the hedge is kept.

**Rebalancing only ever adds margin to Hyperliquid; it never takes it away.** Section 13.1 shows why: Hyperliquid margin is what keeps a hedge alive through a violent rebound, so pulling "excess" home would raise the buffer, not lower it. A client can still move Hyperliquid cash home with a withdrawal intent (section 7.3). That runs the engine on the book as it would be afterwards and needs E_A ≥ IM there. It must also leave on Hyperliquid at least the largest of:
- Hyperliquid's initial margin;
- 10% of total position value, Hyperliquid's own rule for any transfer out of cross margin (in force since 2025, after a whale withdrew unrealised profit and left Hyperliquid's vault a $4M loss on 12 Mar 2025);
- a 30% margin ratio (MM_HL ÷ 0.3).

The 30% target covers the next hour's moves (the projected-breach test). Surviving a replay-sized move is a different question, and MR answers it. When a Hyperliquid liquidation is among the top risks, the verdict also states the smallest top-up that removes it. Making that top-up is the client's choice, because margin short of that amount is lost with the liquidation (13.1).

Every transfer runs through PLAN.md 5.4's 1Click flows and carries its own expiry. A REBALANCE plan needs only its own verdict, not the two checks of DELEVERAGE: it only moves the client's money to Hyperliquid margin, or unwinds a little of a hedged pair, both legs together.

If rebalancing is impossible (1Click down, no assets to move), a projected breach escalates to DELEVERAGE of the Hyperliquid side.

### 8.3 Bands

Bands are prices at which the keeper should ask for a fresh check, so OutLayer isn't called every 15 seconds (PLAN.md 5.7). For each group the account holds, the engine finds the move x, holding everything else fixed, where:
- ratio_HL reaches 50%, 80% and 100%;
- mark equity reaches IM, MR and 0.8·MR.

MR is re-evaluated at every trial point: as nBTC slips, MR rises, and freezing it made the bands fire late (14.4). The engine reports the bands as prices. For each wrapped token it reports the π (e.g. nBTC/BTC) at which equity reaches IM, MR and 0.8·MR. The search steps outward from today in 0.5% steps, then bisects inside the first step that crosses, so each band is the *nearest* crossing.

### 8.4 The deleveraging plan

The goal is to bring equity back to IM: the client ends HEALTHY again, rather than one tick above the line. The plan is built greedily, re-running the engine after each step:

1. Cancel all resting orders that add risk.
2. Repay the loan from free USDC in the NEAR account. This doesn't change equity, but it stops interest and shrinks the pool's exposure.
3. Leave Hyperliquid margin where it is while perps remain there (section 8.2).
4. Pick the next step from these candidates, each sized at most 25% of a position and at most one hour of the venue's capacity (κ of section 4.2):
   - in a partly hedged group, the unhedged excess first: buy back the excess short, or sell the excess NEAR token. After a depeg, the right step is to buy back the excess short, not to dump nBTC (13.2);
   - close part of an unhedged perp (a reduce-only limit order inside the price band);
   - sell part of an unhedged NEAR token (1Click);
   - unwind part of a hedged pair, both legs together. The step is sized once, in coin units, at the smallest of 25% of the hedged position, one hour of Hyperliquid's volume and one hour of 1Click's capacity, and both legs trade that size, so the pair stays hedged.

   Take the step with the largest **(1.25 × fall in MR − cost) per dollar traded**: the most risk removed for the least market impact.
5. If 1Click is down, a NEAR-side coin can be neutralised instead by opening an equal Hyperliquid short, if Hyperliquid margin allows. It is sold later.
6. Repeat until E ≥ 1.02 × IM or nothing is left. Repay with every proceed. Once no perps are left on Hyperliquid, bring its cash home (1Click's flat 0.2 USDC fee) and repay.

Each step is an attested plan step (PLAN.md 5.5): it runs once, expires, and carries its own 1Click quote. A verdict carries at most 4 steps; the next verdict re-plans the rest from the new state (Appendix A).

### 8.5 Default and write-off

If debt remains after every asset is sold, the verdict says DEFAULT and the pool's `write_off` moves the shortfall to the broker's capital, publicly on-chain. The score is set to 300 and the account is blocked.

---

## 9. Pre-trade checks on every order

> **In simple words.** Every order goes through our gateway, which re-runs the engine as if the order had filled at its worst price. If that would leave the client below the initial requirement, the order is refused. An order that lowers risk is always let through, even during a margin call.

**With no loan, only P0–P3, P7 and P10 apply.** The rest (P4–P6, P8, P9) protect the pool's loan, and Hyperliquid's own rules govern the client's margin.

**P0: one order at a time.** The gateway handles one order per account at a time, in arrival order:
- Its own orders from the last 10 seconds that Hyperliquid hasn't yet shown count as filled.
- An unused borrow or withdraw allowance from a live verdict counts as already spent.
- A second lock that doesn't depend on the gateway: for every coin, the account's Hyperliquid leverage is set (`updateLeverage`, signed by the agent) so that Hyperliquid's own sequential margin check refuses any notional beyond what P8 and P9 allow.

Without P0, forty orders sent at once would each pass against the same snapshot.

For an order of `size` (signed, Hyperliquid units) on coin g at limit price p:

| # | Check | Rule |
|---|---|---|
| P1 | Allow-list | g is on the allow-list, or is being removed (reduce-only or removed, 5.5) and the order only shrinks the position. Every other coin is rejected |
| P2 | Price band | \|p / P_g − 1\| ≤ band_g (1%, 2% or 3%; on testnet only, 3% for every coin: see "The testnet price band" below); this also stops fat fingers and self-trades at silly prices. Resting orders are re-checked on every verdict, and one outside the band is cancelled |
| P3 | Reduce-only flag | If set, the order must shrink the position and not flip it |
| P4 | Worst-case fill | Build the post-trade book assuming the whole order fills at p, but **never better than the mark**: a buy at max(p, m_g), a sell at min(p, m_g). Hyperliquid equity changes by −size·(fill − m_g) − fee, which is never a gain, and the coin's open PnL is folded into cash at the mark |
| P5 | Risk-reducing? | Accept if all of these hold:<br>- MR after ≤ MR before;<br>- the excess E_A − IM does not fall by more than the order's fee;<br>- ratio_HL after ≤ max(before, 50%);<br>- P7's caps hold (unless the order only shrinks a position);<br>- P10's size limit holds.<br>This applies in every state except DEFAULT. The excess test stops a "hedge" at the edge of the price band that costs more equity than it saves |
| P6 | State | Otherwise the account must be HEALTHY |
| P7 | Caps | Position notional after ≤ the per-client cap. The client's group (related accounts) total ≤ the per-client cap. The whole book across clients ≤ the book cap. An order that only shrinks a position skips P7 |
| P8 | Credit conditions | All three after the trade (7.3): E_A ≥ IM, D ≤ cap·C, extreme pool loss ≤ 5%·D |
| P9 | Venue | ratio_HL after ≤ 50% |
| P10 | Hygiene | Prices fresh (section 3.2). Under PRICE_STALE, an order that only shrinks a position still passes, with its P2 band measured from Hyperliquid's mark. Order notional ≤ 1% of the coin's daily Hyperliquid volume; at most 60 orders a minute per client; size and price rounded to Hyperliquid's rules (PLAN.md 5.3) |

**The testnet price band (12 Nov): 3%.** On testnet only, P2's band for a coin is the coin's own band or 3%, whichever is larger. So on testnet every coin's band is 3%. Mainnet keeps the parameter file's band: 1%, 2% or 3% by tier.

- **Why:** Hyperliquid testnet's BTC mark keeps standing away from its own oracle price, which our reference price follows. We saw it 0.77% over the oracle on 11 Nov, then 1.69% and 1.96% over it on 12 Nov. An order has to be priced near the mark to fill.
  - **In dollars:** with the reference at $76,000 and the mark 1.96% over it, the offers start near $77,490. BTC's own 1% band refuses any buy above $76,760. So every order that could fill was refused, and the client's hedge couldn't be placed.
  - Mainnet's mark doesn't stand 2% from its oracle. Testnet's book is thin, and its mark is its own.
- **It is a network setting, not a parameter:** one figure, `price_band_floor` = 0.03, in the testnet network's settings (`risk/pb-read/src/request.rs`). A mainnet network carries 0. The parameter file and its hash don't change, and the reference model, its examples and the backtest use the file's band.
- **It applies wherever the band is used:**
  1. an owner's order through the gateway;
  2. a plan's order when the gateway runs it;
  3. the price the engine gives a plan's order. That price is half the band from the reference: 1.5% on testnet, where BTC's own band gives 0.5%.
- **The refusal names the band it used:** "limit price more than 3% from the reference price".
- **Nothing else changes.** The reference price, every valuation and P3 to P10 are as before. P4 still books an order at its limit price and never better than the mark, so a wider band can't make a bad fill look good to the credit checks.
- **What it doesn't fix:** a plan's own buy is priced 1.5% over the reference, so it fills only while the offers are within 1.5% of the reference. On a day like 12 Nov (1.69% and 1.96%) the gateway accepts the step but nothing fills, and the next verdict plans it again. An owner's own order can be priced up to 3% away.

**Resting orders.** A resting order may fill later, or never. The book used for allowances (7.2, 7.3, P8) is the worse of:
- no resting order fills;
- for each coin, all its resting buys fill, or all its sells (each no better than the mark).

So a resting order can only lower credit, never raise it. An order that would be a hedge if it filled earns nothing until it fills.

Cancels go through the gateway too, so its ledger stays right. When the account leaves HEALTHY, the keeper cancels resting orders that add risk.

---

## 10. All parameters in one table

Version 0 defaults. They are the `G`, `TIERS` and `TOKENS` tables in `risk_engine_ref.py`. Changing one means a new parameter file and a new program hash (section 12).

| Area | Parameter | Value | Why / source |
|---|---|---|---|
| Scope | Limits bind | Only while the account has a loan, or asks for one | Section 0 |
| Horizon | Price-shock horizon H | 4 hours | BTC's 12% shock covers 99.9% of 4-hour windows (PLAN.md 6.2) |
| | Carry horizon τ | 7 days | PLAN.md 6.4 |
| Scenarios | Normal ladder k | ⅓, ⅔, 1 × S* | OKX grid (PLAN.md 6.4) |
| | Extreme size | 2 × S* | OKX |
| | Largest fall in any scenario | −90% | A price can't fall below zero, and S* can exceed 50% for big positions in thin coins |
| | Extreme weight | ½ | OKX, PLAN.md 6.9 |
| | ADL paths (k₁, k₂) | (⅔, ⅔), (1, ½) | PLAN.md's −8%/−8% and −12%/−6% for BTC |
| | Squeeze-then-revert paths (k₁, k₂) | (⅔, ⅔), (1, ½), (1, 1) | Red-team review (M8) |
| | Replay windows | 10: worst 4-hour fall and rise on 5 crash days | PLAN.md 6.9 step 3 |
| | Replay weight | 1 | PLAN.md 6.9 step 5 (options in 13.1) |
| | Coins without data in a replay window | BTC's path × their Hyperliquid-candle ratio, or the window's 75th-percentile ratio (≥ 1), never past ±2·S | Section 4.5 |
| Requirement | IM / MR | 1.25 | Between Deribit's 1.2 and OKX's 1.3 (PLAN.md 6.1) |
| Volatility | EWMA λ, cap | 0.99 hourly; factor in [1, 2.5] | PLAN.md 6.9 step 4 |
| Liquidity | Participation per hour | 10% of half the usual Hyperliquid volume | Conservative: assumes volume halves in stress |
| | Impact coefficient Y | 1.0 | Square-root impact; studies find 0.5–1 |
| | Max time to unwind for new credit | 24 hours | Section 7.2, C8 |
| Hyperliquid | Taker fee | 0.045% | Hyperliquid's base fee tier |
| | Book-liquidation slippage | max(0.2%, 2 × unwind cost) | PLAN.md worked example used 0.2% |
| | Backstop threshold | ⅔ of maintenance | Hyperliquid docs |
| | Margin ratio after a risk-adding trade | ≤ 50% | PLAN.md 5.6 bands |
| | Rebalance trigger / target / emergency (REBALANCE_NOW) | 60% / 30% / 80% | Section 8.2 |
| States | Deleverage threshold | 0.8 × MR | PLAN.md 6.1 |
| | Margin-call cure time | 4 hours | PLAN.md 6.1 |
| | Hysteresis | 2% | Section 8.1 |
| | Money in transit (a plan step's transfer) | 98% for state, 0 for allowances | Section 3.4 |
| | The owner's own move, while pending | 0 for state, 0 for allowances | Section 3.4 |
| Pool | Rate curve | 6% at 80% utilisation, 50% at 100% | PLAN.md 5.1 (proposal, unconfirmed) |
| | Tier markups | +1% / +2% / +5% | PLAN.md 5.1 |
| | Max utilisation for new loans | 90% | PLAN.md 5.1 |
| | One client's share of the pool | ≤ 25% of capital | New in this file |
| Credit | Tier caps | 85% / 70% / 50% of collateral | PLAN.md 6.9 |
| | Pool-loss budget in extremes | 5% of the loan | PLAN.md 6.9 |
| | Starting limits (grow 10% per good month) | $1M / $250k / $50k, up to $5M / $1M / $100k | New in this file (section 6) |
| | Minimum equity for any credit | $1,000 | New in this file (G6) |
| Prices | Sources needed | ≥ 3 of up to 6, fresh within 10 s | Section 3.2 |
| | Outlier distance | 1% / 2% / 3% by tier | Section 3.2 |
| | TWAP window | 1 hour | Section 3.4 |
| Orders | Price band | 1% / 2% / 3% by tier. On testnet only, 3% for every coin: a network setting, not a parameter | Section 9 |
| | Max order size | 1% of the coin's daily Hyperliquid volume | Section 9 |
| | Orders in flight per account | One at a time; recent orders count as filled | Section 9, P0 |
| Wrappers | π source, cap, windows | One committed 1Click quote, ≤ 1; state 15-min median, credit 1-hour low; 0.80 if none for 60 s; frozen: 0 for new credit | Section 3.3 |
| Contracts | Net new lending | ≤ 10% of capital per 24 h (48 h timelock to raise) | Section 12.2 |
| | New accounts | ≤ $25k of credit for 7 days | Section 12.2 |
| | Co-signature threshold | Borrow > $250k; off-pool plan steps past $50k per account per 24 h | Section 12.2 |
| Verdicts | Freshness | 120 blocks (about 70 s) | PLAN.md 5.1 |
| | Plan steps per verdict | At most 4; the next verdict re-plans the rest | Appendix A |

---

## 11. Edge cases and attacks

> **In simple words.** Each row is something that has gone wrong somewhere, or could, and the exact rule that handles it here. Where a real incident shaped a rule, it is named.

### 11.1 Market manipulation

| # | What could happen | Rule that handles it |
|---|---|---|
| M1 | **Pump and borrow.** A trader pushes up the price of a thin coin they are long, then borrows everything against the paper gain. This is how Mango Markets lost over $110M on 11 Oct 2022: MNGO's oracle price was pushed up more than 13-fold in about 30 minutes ([CFTC](https://www.cftc.gov/PressRoom/PressReleases/8647-23)) | Several rules together, any one of which breaks the attack (Example 3 puts numbers on it):<br>- Only allow-listed coins: market cap ≥ $1B, ≥ $10M a day of spot on Binance plus another major venue (section 5.1)<br>- The price is a median of ≥ 3 sources (3.2)<br>- The TWAP rule: the last hour's gains don't count toward new credit (3.4)<br>- Per-client caps of 5% of daily Hyperliquid volume (5.2)<br>- The liquidity factor, which makes a big position in a thin coin need almost full margin (4.2)<br>- The pool's own limits: net new lending ≤ 10% of capital per 24 hours, and $25k in an account's first week (12.2) |
| M2 | **Push down to trigger us.** Someone pushes the price down so that our deleveraging sells into a thin book, then buys cheap | Deleveraging uses limit orders inside the price band, in slices of at most one hour of capacity (8.4). Moving the median of Binance, OKX, Coinbase and Hyperliquid for a ≥ $1B coin is expensive |
| M3 | **Two related accounts trade against each other.** One wins and withdraws; the other is left with debt | KYB entity: related accounts share caps and one client limit (12.1). The price band stops trades at off-market prices. Neither side can lose more than its buffer within calibrated moves |
| M4 | **A squeeze on Hyperliquid's own book.** The perp diverges from spot, and Hyperliquid liquidates at its own mark. On 26 Mar 2025, a trader self-traded a $4M JELLY short at 0.0095, then pushed the price up more than 4×, which landed the short on Hyperliquid's liquidator ([Hyperliquid](https://x.com/HyperliquidX/status/1905319339991204263)) | The replica liquidates at Hyperliquid's mark, plus an adverse perp-vs-index gap β_g in normal scenarios. Coins with thin Hyperliquid books fail E5. Extreme scenarios cover settlement far from spot |
| M5 | **Fake depth.** Spoofed order books make a coin look liquid | Liquidity comes from 30-day traded volume and the square-root rule, not visible depth. The book snapshot is only a sanity check |
| M6 | **Wash volume.** Fake volume on Hyperliquid makes a coin look liquid | E3 and E4 also require real spot volume on major exchanges and a market cap |
| M7 | **Self-liquidation into the venue's backstop.** A trader builds a big position in a thin coin and lets it be liquidated, so the venue's vault eats the loss:<br>- JELLY, Mar 2025<br>- POPCAT, Nov 2025: $3M spread over 19 wallets for $20–30M of longs, then a $20M buy wall pulled; $4.9M of bad debt to Hyperliquid's vault<br>- FARTCOIN, Apr 2026<br>- XPL, Nov 2026 | These hurt Hyperliquid's vault, not our pool directly. But they bring violent prices and venue interventions (delisting, settlement at a chosen price). Every one of these coins fails our allow-list today:<br>- POPCAT: max leverage 3×, open interest $1.3M, not in the top 250 by market cap<br>- FARTCOIN: no Binance spot, $0.12B market cap<br>- XPL: $0.30B market cap<br>- JELLY: delisted |
| M8 | **Squeeze, then revert.** The price is pushed against a hedge's perp until Hyperliquid liquidates it, then falls back, leaving the spot leg unhedged on the way down. Example: $1M wNEAR, $1M NEAR short, $250k on Hyperliquid. Up 29.7%, then back down, loses about $350k | The Squeeze family (4.5) plays exactly this for every coin with a perp, at three sizes up to (1·S*, 1·S*). At the credit line, the pool loses nothing in it (test T12) |

### 11.2 Prices and oracles

| # | What could happen | Rule that handles it |
|---|---|---|
| O1 | **One exchange prints a silly price.** Examples:<br>- On 26 Nov 2020, DAI printed $1.30 on Coinbase, Compound's main price reporter, and about 85M DAI of loans were liquidated ([Compound proposal 47](https://www.tally.xyz/gov/compound/proposal/47))<br>- On 10 Oct 2025, Binance's collateral prices leaned on its own books. USDe was priced at about $0.65, and wBETH at about $430 with ETH above $3,800; Binance paid about $283M in compensation | The median of ≥ 3 sources, and the outlier rule (3.2). Wrapped tokens are priced by the π rule (1Click's quote, capped at 1, with a 15-minute median for states and the hour's lowest for credit), with depeg scenarios (3.3) |
| O2 | **A source goes stale or down** | 10 s freshness. Under 3 sources: PRICE_UNCERTAIN, no new risk in the coin, worst-of pricing for allowances. No source for 60 s: PRICE_STALE. Accounts holding the coin are frozen to risk-reducing actions, the state keeps the last good price, and no unwind starts from stale data alone (3.2) |
| O3 | **Pyth reports a wide confidence interval** | The source is dropped when confidence > 0.5% of price |
| O4 | **Units: kPEPE is 1,000 PEPE** | Every coin carries a unit multiplier (section 2). A unit test compares Hyperliquid and exchange prices for each `k` coin |
| O5 | **USDT and USDC diverge** | USDT is valued at its USDC market price, with −1% and −13% depeg scenarios. USDC is the unit of account (section 2) |
| O6 | **nBTC's bridge is in trouble while BTC is fine** | nBTC is priced from its own markets by the π rule (3.3), not by BTC. Depeg scenarios of −2%, −5% with a crash, and −20%. Book cap on nBTC-backed loans (12.1) |
| O7 | **One quote sets the value of nBTC.** Whoever wins a single 1Click quote decides π. π 1.05 adds about $120k of credit on a 50-BTC book; π 0.92 forces an unwind on a full Preferred loan | π is capped at 1, so no quote can add credit. States use the 15-minute median, an unwind needs two checks, and new credit uses the lowest of the last hour. No reading for 60 s: π = 0.80 and the token is reduce-only. A second, independent reading would be better, but no NEAR pool can give one (3.3) |

### 11.3 Hyperliquid itself

| # | What could happen | Rule that handles it |
|---|---|---|
| V1 | **Hyperliquid liquidates the hedge leg while the spot sits on NEAR** | The replica of margin tiers and liquidation runs in every scenario (4.3). The margin ratio may be at most 50% after any trade; a rebalance triggers at 60% or on a projected breach (8.2) |
| V2 | **ADL closes the profitable hedge in a crash.** About $2.1B was closed by ADL on Hyperliquid on 10 Oct 2025 (PLAN.md research) | Two-stage ADL scenarios for every coin with a perp (4.5) |
| V3 | **The backstop keeps the remaining margin** | Modelled: the Hyperliquid side goes to 0 (4.3) |
| V4 | **Hyperliquid halts, or deposits and withdrawals pause.** Its Arbitrum bridge was briefly paused during the POPCAT attack (12 Nov 2025) | No money moves inside any scenario: each venue must survive alone. Book limit on lending that rests on Hyperliquid balances (12.1) |
| V5 | **Hyperliquid changes margin tables or max leverage** | Margin tables are read live in every run (3.1). A change to max leverage is re-checked against E1 at once |
| V6 | **Hyperliquid delists a coin or settles it at a chosen price.** Validators settled JELLY at 0.0095, the attacker's entry price, not the documented 1-hour TWAP | Emergency removal: reduce-only and the shock ×1.5 at once; the extreme shock after 24 hours, or at once when Hyperliquid has halted the market, as here (5.5). Settlement far from spot sits inside the extreme scenarios |
| V7 | **Funding spikes** | Funding stress at each coin's worst 7-day average, in every normal scenario (4.7). The history used includes the period when Hyperliquid's cap was 4% an hour; its docs show 0.5% an hour since about 1 Nov 2026 |
| V8 | **Hyperliquid's open-interest cap is hit, so no new positions** | Closing still works. If a hedge can't be added, the deleveraging plan sells the NEAR-side coin instead (8.4) |
| V9 | **Orders are rejected** (tick size, price rules) | The gateway rounds to Hyperliquid's rules (PLAN.md 5.3) and retries within the band |

### 11.4 Bridges and stablecoins

| # | What could happen | Rule that handles it |
|---|---|---|
| B1 | **The nBTC or ETH bridge fails outright**, as renBTC and Multichain's BTC did | No margin can cover a jump to zero, so caps do: nBTC-backed lending ≤ 30% of pool capital and ETH-backed ≤ 15% (12.1). There is also the −20% extreme scenario, and the operator can freeze the token at once, so no new credit rests on it (3.3). The README discloses it |
| B2 | **USDT depegs** | −1% in normal scenarios, −13% in extreme ones; USDT-backed lending ≤ 30% of the pool (12.1) |

### 11.5 Liquidity and unwinding

| # | What could happen | Rule that handles it |
|---|---|---|
| L1 | **The position is too big to sell quickly** | Liquidity factor ℓ (4.2), the square-root unwind cost (4.6), the per-client cap (5.2), and no new credit if anything needs more than 24 hours to unwind (C8) |
| L2 | **All our clients unwind the same coin at once** | Book cap of 3 × the per-client cap. The daily book stress test prices unwinds at the book's total size (12.1) |
| L3 | **1Click is down, or has no liquidity for the size** | No scenario assumes money moves. Deleveraging falls back to neutralising NEAR-side coins with a Hyperliquid short (8.4). The account stays in DELEVERAGE and the operator is alerted |
| L4 | **A 1Click transfer is refunded or stuck** | Money in transit counts 0 for allowances. Once overdue it counts 0 for the state as well, and blocks new risk (3.4). The owner's own move counts 0 for both from the start |
| L5 | **Capacity is shared.** Ten accounts each see 4 hours to unwind $1M of wNEAR, but together they need 40 hours through one $250k-an-hour route | The time to unwind counts the rest of the book's holdings in the same coin or token (B_g, 4.2). NEAR-side tokens have book caps too (12.1) |

### 11.6 Timing and liveness

| # | What could happen | Rule that handles it |
|---|---|---|
| T1 | **OutLayer is down or returns `null`** | Contracts block risk-adding actions; risk-reducing ones need no verdict. Hyperliquid orders stop too, because the agent key lives in the enclave; Hyperliquid's own rules are the backstop for that side. Keepers keep using the last verdict's bands. A plan is a list of actions, not prices: each step is priced when it runs, with a fresh 1Click quote and a limit inside the band at that moment, so an old plan never sells at stale prices. After 30 minutes without a verdict for an account in MARGIN_CALL or worse, anyone can repay the pool from the account's idle USDC. Nothing else moves without the enclave. A fallback signer that could send collateral to a 1Click address would break the promise that only the client's own venues, the client and the pool receive its funds (PLAN.md 1) |
| T2 | **A stale or replayed verdict** | A verdict lasts 120 blocks and is bound to the account, the block height and a nonce (Appendix A) |
| T3 | **Two risk-adding actions race on one verdict** | The nonce: one verdict, one action |
| T4 | **The keeper is offline** | Anyone can trigger checks and run plan steps (PLAN.md 5.7) |
| T5 | **Chain Signatures is slow** | The same as 1Click being down for Hyperliquid transfers: covered by no money moving in scenarios |
| T6 | **The NEAR RPC returns old state** | The verdict carries the block height it read; the contract rejects verdicts more than 120 blocks old |
| T7 | **A fleeting print, or our own outage, forces an honest unwind** | DELEVERAGE must show on two checks 2–5 minutes apart (8.1). Stale prices freeze instead of unwinding (3.2). σ comes from median exchange closes, not Hyperliquid's last trades (4.4). Emergency removals give 24 hours' notice (5.5). Unwinds the client didn't cause cost no score (6) |

### 11.7 Client behaviour and gaming

| # | What could happen | Rule that handles it |
|---|---|---|
| G1 | **Strip the hedge after borrowing** | Every order goes through the pre-trade check (section 9). Example 5 shows the attempt being refused |
| G2 | **Window dressing**: hedged on rating day, directional the rest of the week | The score uses the lower of the hedge ratio now and its 7-day average (6) |
| G3 | **Bust-out**: behave for a while, then borrow big and vanish | Starting limits grow 10% per good month. KYB. Upgrades at most once every 30 days (6) |
| G4 | **Deposit junk tokens** | Only allow-listed tokens are accepted (PLAN.md 5.1); anything else is rejected |
| G5 | **Resting orders that add risk once filled** | Allowances use the worse of no fills and each side filling. The keeper cancels them outside HEALTHY (9) |
| G6 | **Dust accounts** | Credit only from $1,000 of equity. Hyperliquid's $10 minimum order |
| G7 | **Many small borrows** | Every borrow needs a fresh verdict and consumes it; the pool's daily net lending budget (12.2) |
| G8 | **Orders race.** Forty orders sent at once each pass against the same snapshot: a $13M long on $1M of equity | P0: one order at a time per account, recent orders counted as filled, unused allowances counted as spent, and Hyperliquid's own per-coin leverage set as a second lock (9) |
| G9 | **A resting order fakes a hedge.** A sell that never fills makes 10 nBTC look hedged, and adds about $233k of credit | Allowances use the worse of no fills and each side filling, never better than the mark (9) |
| G10 | **Margin-call clock games.** Bounce above MR for a moment to restart the 4 hours | The clock counts cumulative time over 24 hours, and a call ends only at IM, or after an unbroken hour at or above 1.02 × MR following a client action (8.1) |
| G11 | **Rating farming.** An all-USDC account plus an old idle Hyperliquid address scores 800, Preferred on day 1 with no KYB | Hedge points only with real coin exposure; the linked-address bonus needs activity and one link per address; Preferred needs KYB; good months only with a loan (6). The farming attempt now scores 650 (13.8) |

### 11.8 Credit and the pool

| # | What could happen | Rule that handles it |
|---|---|---|
| P1 | **The pool runs dry** | No new loans above 90% utilisation; the rate rises to 50% at 100% (7.1) |
| P2 | **One client is too big for the pool** | ≤ 25% of pool capital per client (C6) |
| P3 | **A default** | `write_off` from broker capital, the score set to 300, the account blocked (8.5) |
| P4 | **A wholesale lender fails** (for Rhea wholesale, PLAN.md 5.10). Rhea lost about $18.4M on 16 Apr 2026 to a bug in its margin-trading slippage check | Out of scope for version 0, which has no outside funding. Wholesale funding will need its own counterparty limit, and the client's loan terms must not depend on Rhea staying solvent |
| P5 | **Griefing the pool's budgets.** Borrow-repay loops use up the daily lending budget; plan steps are run just before their quote expires, so they refund | The budget counts *net* new lending (12.2). A plan step can only be started with at least 5 minutes of quote validity left |

### 11.9 Security and operations

| # | What could happen | Rule that handles it |
|---|---|---|
| S1 | **The enclave or the program is compromised** | Contract caps hold whatever the verdict says (12.2) |
| S2 | **Parameters are tightened suddenly**, pushing existing accounts into DELEVERAGE | A new program version, including each monthly parameter file, reaches an account when its owner accepts it, or 30 days after it is published, whichever comes first. An owner who disagrees has a month to repay and leave. Coin status is a list in the pool that every version reads, so a removal reaches every account at once, with 24 hours' notice before the extreme shock (5.5) |
| S3 | **The operator key** | Testnet: one key, disclosed. Later: multisig plus timelock (16) |

### 11.10 Numbers

| # | What could happen | Rule that handles it |
|---|---|---|
| N1 | **Rounding** | Against the client: requirements up, equity and allowances down, to integer micro-USDC (section 2) |
| N2 | **Floating-point determinism** | IEEE-754 doubles in WASM, no fused multiply-add, libm compiled in. The contract only compares integers |
| N3 | **Division by zero** | No perps: margin ratio 0. Hyperliquid equity ≤ 0: ratio ∞. No coins held: hedge ratio 1 |

---

## 12. Limits on the whole book, and defence in depth

> **In simple words.** Everything above is about one client. Two more layers protect the pool. **Book limits** stop all our clients piling into the same trade. **Contract caps** hold even if the engine itself is wrong or compromised.

### 12.1 Book limits (across all clients)

| Limit | Rule | Enforced by |
|---|---|---|
| Per-coin book cap | Across all clients, total notional in a coin ≤ 3 × the per-client cap. That is at most 15% of the coin's daily Hyperliquid volume and 7.5% of its open interest | Gateway (P7), using the operator's book view |
| Related accounts | Accounts of one KYB entity share the per-client caps and one client limit | Gateway and pool, from the entity id the operator records with the KYB flag |
| Per-wrapper exposure | Loans resting on a bridged token, Σ_accounts D_i × (share of i's collateral in token j), must stay ≤ cap_j × pool capital. Caps: nBTC 30%, ETH 15%, USDT 30%. Each verdict carries the account's shares | Pool contract (C7) |
| NEAR-side book caps | Across all clients with a loan, holdings of each NEAR token ≤ 24 hours of its 1Click capacity: nBTC and ETH $12M, wNEAR $6M, USDT $24M | Pool contract, at each borrow, from the holdings each verdict reports; for swaps, the swap's verdict. Deposits are never refused: a refused 1Click delivery could strand the funds |
| Venue exposure | Σ_accounts min(D_i, E_HL,i) ≤ 50% of pool capital: how much of our lending rests on Hyperliquid balances | Pool contract |
| Book stress test | Daily, the operator job runs every account's scenarios together. Unwind costs use the book's total size per coin, since our clients would be selling together. Total pool loss on extreme days must stay ≤ 2.5% of pool capital; if not, the operator raises shock sizes or cuts caps. The result is published | Operator job |

PLAN.md 6.1 already said "limits, not margin, cover jumps to zero". These are those limits.

### 12.2 Defence in depth: what still holds if the engine is wrong or compromised

> **In simple words.** The engine and the gateway run in the same enclave, which also holds every client's Hyperliquid agent key. So a compromised enclave is serious. These limits rely on nothing the enclave says. They turn "everything" into "at most a day's budget, and the operator can pause".

| Limit, enforced by the contracts whatever a verdict says | Value | What it bounds |
|---|---|---|
| Rolling net new lending | ≤ 10% of pool capital per 24 hours. Raising it needs a 48-hour timelock | False "lend" verdicts before the operator pauses |
| New accounts | ≤ $25k of credit in the 7 days after creation | Sybil accounts from the permissionless factory |
| Tier history | Kept by the pool: one upgrade per 30 days; Preferred only with the operator's KYB flag | A forged verdict jumping an account to Preferred |
| Per-account ceiling | The tier maximum: $5M, $1M or $100k | One account |
| Large actions | A borrow above $250k needs the operator multisig's co-signature. So does any plan step to anywhere but the pool that would take the account's total for the last 24 hours past $50k; the total is cumulative, so splitting a move doesn't avoid it. Steps in other tokens are valued at prices the operator sets in the pool and keeps above market, so the count relies on nothing the enclave says | Forged plan steps moving collateral out |
| Plan-step destinations | The pool, or a 1Click deposit address; even a top-up of the account's own Hyperliquid margin goes through 1Click. The contract can't check where 1Click delivers, so a 1Click address is trusted from the enclave, within the $50k-a-day allowance above. In version 0, a larger urgent rebalance waits for our co-signature (16) | Collateral leaving to an attacker |
| Utilisation | ≤ 90% | The pool's cash |
| Verdicts | Pinned program and parameter hashes, ≤ 120 blocks old, one action each (nonce) | Replays and old programs |
| Pause | The operator can pause new lending and plan steps at once (repaying is never paused) | Time to react |

**Worst case with a compromised enclave, before the operator pauses:**
- 10% of capital in false loans per day;
- plus up to $50k per account per day, moved by plan steps without the co-signature.

Without these limits, it was up to 90% of capital in about 4.5 hours.

**Honest bugs.** The same limits apply. The per-wrapper caps (12.1) bound a bridge failure: with nBTC at 30%, one nBTC bridge failure costs at most 30% of capital, down from 50%.

**Hyperliquid agent keys.** A compromised enclave could also trade clients' Hyperliquid accounts. Agents can't withdraw (PLAN.md 5.3), but they can trade at bad prices against an attacker. Hyperliquid's per-coin leverage setting (P0) bounds the size. The rest is a known residual risk, disclosed in the README.

**What the contracts in PLAN.md 5.1 need for this:** the rolling budget, account age, tier history, the co-signature threshold and the pause (section 15, D21). PLAN.md 5.1 includes them since 5 Nov.

---

## 13. Worked examples

All numbers below come from `risk_engine_ref.py … examples`, run on 4 Nov 2026 data (BTC $78,287). Unless stated otherwise:
- the pool has $2M of capital with $1.2M lent out (60%), so the base rate is 4.5% and the Standard rate 6.5%;
- markets are calm (f = 1);
- prices are fresh;
- normal funding is each coin's trailing 30-day average.

### 13.1 The plan's hedged BTC carry trade

> **In simple words.** This is PLAN.md's example. The buffer comes out at $15.5k rather than $10.2k, because of one real night. At 02:39 UTC on 13 Mar 2020, BTC jumped from +30% to +37% within a minute. At 2.9× leverage, the short went straight to Hyperliquid's backstop and all $35k of margin was gone. BTC then fell back to +22.6%, and the nBTC, now unhedged, fell with it. The credit lines don't change: a new client gets the full $94.5k once the account is a week old, and a Preferred client the full $114.75k, because the tier caps bind first. In an account's first 7 days, the pool lends at most $25k (12.2).

**The client:**
- 1.2774 nBTC ($100k) in the NEAR account;
- a 1.2774 BTC short on Hyperliquid, with $35k of USDC margin (2.9×);
- equity $135,000;
- Hyperliquid margin ratio 3.6%.

| Scenario | Family | Loss | Counted |
|---|---|---|---|
| Replay: 13 Mar 2020 rebound, from 02:16 UTC | Replay | $15,498 | $15,498 |
| nBTC slips 20% (bridge trouble), price unchanged | Extreme | $20,270 | $10,135 |
| ADL closes the short after a ⅔·S* fall (−8.2%); BTC falls another ⅔·S* | ADL | $9,869 | $9,869 |
| ADL after a 1·S* fall (−12.3%); then another ½·S* | ADL | $7,672 | $7,672 |
| Replay: 19 May 2021 rebound | Replay | $6,457 | $6,457 |
| BTC +12.3% (1·S*, with ℓ = 1.025), with the perp gap, 2% nBTC slip and a week of stress carry | Normal | $3,776 | $3,776 |
| Squeeze the short +12.3%, then back | Squeeze | $3,776 | $3,776 |

**Result:**

| | Value |
|---|---|
| MR | **$15,498** |
| IM | $19,372 |
| Largest loan the stress bounds (C0–C3) allow, at the Standard rate | $115,438 |
| Standard credit line | **$94,500**, set by the 70% tier cap (C4) |
| Preferred credit line | **$114,750**, set by the 85% tier cap (C4) |
| Rates | Standard 6.50%, Preferred 5.50% |

**What happened in that replay, minute by minute.**
1. At minute 22 of the window, BTC was 30.0% above the start.
2. At minute 23, it was 37.0% above. In that one minute, the short's Hyperliquid equity went from positive to −$2,446. That is below ⅔ of its maintenance margin of $1,718, which is $1,145. So the backstop took the account and all $35k.
3. By minute 39, BTC had fallen back to +22.6%.
4. The nBTC, unhedged from step 2, was then worth $120,149 after the normal 2% slip, against $135k of equity at the start.

**The client's lever: margin on Hyperliquid.**

| Hyperliquid margin | Equity | MR | Main risk | Standard line | Preferred line |
|---|---|---|---|---|---|
| $35,000 (2.9×) | $135,000 | $15,498 | 2020 rebound replay | $94,500 | $114,750 |
| $40,000 | $140,000 | $19,116 | 2020 rebound replay | $98,000 | $115,940 |
| $45,000 | $145,000 | $24,116 | 2020 rebound replay | $101,500 | $114,692 |
| $50,000 (2×) | $150,000 | $10,135 | nBTC slips 20% | $105,000 | $127,500 |
| $60,000 | $160,000 | $10,135 | nBTC slips 20% | $112,000 | $136,000 |

**Read the $40k and $45k rows carefully.** Margin that is not enough to survive the liquidation is lost with it: the backstop keeps everything. So $45k is *worse* than $35k. The advice the engine gives is either enough to survive (here $50k), or keep the extra on NEAR. The verdict states the smallest top-up that removes a liquidation from the top risks (8.2). Moving USDC to Hyperliquid while there is a loan is a checked intent (7.3), because it can raise MR.

**The open choice: how much the replays count.** PLAN.md 6.9 says replays count in full, and this file keeps that. Here is what the alternatives would do:

| Replays | Hedged MR | Standard line | Preferred line | $100k BTC long, MR | $100k SOL long, MR | $100k SUI short, MR |
|---|---|---|---|---|---|---|
| **In full (as specified)** | $15,498 | $94,500 | $114,750 | $35,884 | $39,829 | $100,000 |
| At half weight, like extremes | $10,135 | $94,500 | $114,750 | $17,942 | $25,248 | $50,000 |
| Moves capped at the coin's extreme size (±2·S) | $10,135 | $94,500 | $114,750 | $24,412 | $39,829 | $51,350 |
| None (grid only) | $10,135 | $94,500 | $114,750 | $14,409 | $25,248 | $33,540 |

Under the "half weight" option, replays are also held to C3 like extremes (the pool may lose 5% of the loan), not C2.

My recommendation is to keep "in full" for version 0, for three reasons:
- **The product's target is barely affected.** The hedged book gets the same credit lines in every row.
- **The choice only bites on unhedged books, and that bite is earned.** On 10 Oct 2025, alts really did fall 57–82% within hours on Hyperliquid itself (section 14.3).
- **The backtest will settle it.** The backtest with 2-, 15- and 60-minute rebalancing (PLAN.md 6.9 step 9) will show how often a keeper would have saved the hedge. That is the evidence for relaxing to "half weight" later.

### 13.2 nBTC slips: the depeg drill

The client draws the full Standard loan of $94,500 and takes it out. Then nBTC slips against BTC:

| nBTC/BTC | Equity | MR | IM | State |
|---|---|---|---|---|
| 1.00 | $40,500 | $15,616 | $19,520 | HEALTHY |
| 0.98 | $38,500 | $16,001 | $20,001 | HEALTHY |
| 0.95 | $35,500 | $16,578 | $20,723 | HEALTHY |
| 0.90 | $30,500 | $17,542 | $21,927 | HEALTHY |
| 0.85 | $25,500 | $18,506 | $23,133 | HEALTHY |
| 0.80 | $20,500 | $19,472 | $24,340 | WATCH |
| 0.75 | $15,500 | $20,438 | $25,548 | DELEVERAGE |
| 0.70 | $10,500 | $21,406 | $26,758 | DELEVERAGE |

**Bands the keeper watches** (MR re-evaluated at each point, 8.3): nBTC/BTC of 0.8309 (equity = IM), 0.7914 (= MR) and 0.7574 (= 0.8 × MR). Equity falls as nBTC slips, and MR *rises*. A slipping nBTC hedges less BTC, so the book becomes net short, which is the rebound replay's weak spot.

**The unwind plan at 0.75 has one step.** Buy back 0.3194 BTC of the short ($25,000 at the mark, cost $15).

At a ratio of 0.75, the 1.2774 nBTC only carries 0.958 BTC of exposure, so the account is 0.32 BTC *over-hedged*. Removing the excess short cuts MR from $20,438 to $8,285. Equity of $15,485 is then above 1.02 × IM ($10,357 × 1.02), so the account is HEALTHY again. No nBTC is dumped at the depegged price, and the loan stays in place. Selling nBTC would have been the expensive wrong move.

### 13.3 Bands for the keeper

These are for the same account with the loan drawn. The BTC price at which the Hyperliquid margin ratio reaches:
- 50%: $103,110 (+31.7%);
- 100%, where Hyperliquid liquidates: $104,383 (+33.3%).

The two are close because the ratio is MM ÷ equity, which explodes as equity nears zero. That is why the rebalance trigger sits at 60%, and why the projected-breach test (8.2) looks one move ahead rather than waiting for the ratio.

### 13.4 A directional book across four coins

**The client:**
- $100k USDC in the NEAR account;
- on Hyperliquid: long $150k SOL, short $100k ETH, long $60k HYPE, long $30k kPEPE.

| Coin | S | × liquidity factor ℓ | = S* | Hours to unwind | Per-client cap |
|---|---|---|---|---|---|
| ETH | 18% | 1.006 | 18.1% | 0.05 | $50.3M |
| HYPE | 30% | 1.007 | 30.2% | 0.06 | $25.2M |
| SOL | 24% | 1.042 | 25.0% | 0.34 | $10.6M |
| kPEPE | 29% | 1.057 | 30.6% | 0.47 | $1.45M |

The book has no hedges (hedge ratio 0), so a new client scores 550, which is Watch, with a $50,000 starting limit that would bind. With a KYB record the score is 650, which is Standard. The numbers below assume that KYB'd, Standard client.

**With $80k of Hyperliquid margin:**
- MR = **$80,000**, exactly the Hyperliquid equity. An adverse 1·S day (SOL, HYPE and kPEPE down, ETH up) wipes Hyperliquid out, and Hyperliquid can't take more than it holds.
- IM is $100,000, so the credit line is **$79,015** (C1). Credit effectively rests on the $100k of USDC on NEAR.

**With $200k of Hyperliquid margin:**
- MR = **$85,436**, the same adverse 1·S day.
- The worst replay is $61,371.
- The credit line is **$140,620**. It is set by C3: on the 2·S extreme day the pool may lose at most 5% of the loan.

### 13.5 What each coin costs in buffer

This is a plain $100k perp, with $100k of Hyperliquid margin and a loan outstanding (with no loan, nothing binds: section 0). The loan in the table is $1. A real loan D adds about D × 52% × 7/365 of stress interest to each MR. "Grid" is MR without replays: the OKX-style number. "With replays" is the specified MR.

| Coin | S | Long: grid | Long: with replays | Short: grid | Short: with replays | What sets it |
|---|---|---|---|---|---|---|
| BTC | 12% | $14,409 | $35,884 | $12,986 | $44,315 | 12 Mar 2020 fall / 13 Mar rebound |
| ETH | 18% | $19,630 | $36,174 | $19,060 | $56,982 | 19 May 2021 / 13 Mar 2020 |
| ZEC | 25% | $26,477 | $51,990 | $27,867 | $70,454 | 19 May 2021 |
| SOL | 24% | $25,248 | $39,829 | $26,218 | $50,803 | 2020 (scaled) / 2021 |
| NEAR | 21% | $24,680 | $47,906 | $22,583 | $55,668 | 10 Oct 2025 |
| HYPE | 30% | $30,990 | $44,941 | $31,032 | $52,108 | 2021 (scaled) / 2020 (scaled) |
| XRP | 25% | $27,864 | $49,059 | $28,482 | $44,532 | 10 Oct 2025 / 2021 |
| ENA | 25% | $29,030 | $69,749 | $30,137 | $100,000 | 10 Oct 2025 |
| PUMP | 30% | $32,786 | $91,122 | $32,921 | $80,857 | 10 Oct 2025 |
| WLD | 26% | $31,070 | $77,500 | $33,116 | $96,452 | 10 Oct 2025 |
| kPEPE | 29% | $35,185 | $66,493 | $36,594 | $100,000 | 10 Oct 2025 |
| UNI | 25% | $31,960 | $69,362 | $32,475 | $75,183 | 10 Oct 2025 |
| BNB | 25% | $32,775 | $45,564 | $33,230 | $52,753 | 2020 |
| SUI | 25% | $32,898 | $79,087 | $33,540 | $100,000 | 10 Oct 2025 |
| ONDO | 30% | $42,883 | $69,658 | $43,724 | $100,000 | 10 Oct 2025 |
| AAVE | 25% | $36,982 | $67,560 | $37,633 | $95,206 | 10 Oct 2025 |
| DOGE | 40% | $58,380 | $58,380 | $60,462 | $76,908 | 1·S / 10 Oct 2025 |
| ARB | 25% | $37,621 | $73,071 | $38,773 | $100,000 | 10 Oct 2025 |
| LINK | 25% | $39,106 | $58,292 | $39,956 | $69,883 | 10 Oct 2025 / 2020 |
| AVAX | 25% | $41,586 | $67,932 | $43,336 | $100,000 | 10 Oct 2025 |
| ADA | 25% | $42,271 | $63,344 | $44,272 | $96,875 | 10 Oct 2025 |
| TRX | 25% | $47,522 | $47,522 | $50,785 | $50,785 | 1·S (thin book: ℓ ≈ 1.9) |
| LTC | 25% | $47,616 | $57,554 | $50,000 | $51,715 | 10 Oct 2025 / 2021 |

**What this shows.** Financing an *unhedged* position needs a large buffer:
- BTC: about 36%;
- ETH: 36–57%;
- most alts: 45–100%. On 10 Oct 2025 most of these coins fell 57–82% within hours on Hyperliquid itself, then rebounded by a median of about 77% (up to 240%) from those lows.

A *hedged* position needs about 10–19% (13.1). This is the prime broker's point: the engine lends on hedges, not on directional bets. The thin coins (TRX, LTC: about $5M a day on Hyperliquid) also pay for size through ℓ, even on the grid.

### 13.6 A Mango-style attempt on the thinnest coin

LTC is the thinnest allowed coin:
- about $4.8M a day on Hyperliquid;
- $20M of open interest;
- $20M a day of spot.

The attacker has $1M of equity.

| Step | What the engine does |
|---|---|
| Order for twice the per-client cap ($479,606) | **Refused**. One order may be at most 1% of daily Hyperliquid volume ($48k), and the position cap is $239,803 (5% of daily volume) |
| Long $119,902 (half the cap) | Shock 25% × ℓ 2.0 = 50% gives a grid loss of $60,914. The 10 Oct 2025 replay sets MR at **$69,039**, 58% of the position |
| Price pushed +10% on every source, just now | Paper gain $11,990. Mark equity rises to $1,011,990, but **allowance equity stays $1,000,000**: the TWAP rule removes the gain. The borrow allowance is unchanged at $50,000: a new, unverified, directional account is Watch (score 550), and the contract allows any account at most $25k in its first week (12.2). If the push is *held*, the 1-hour average catches up over the hour: after 30 minutes, about half the gain counts (about $1,006,000) |
| Pushed +30% or +50%, just now | The same: gains of $35,971 and $59,951 are removed. Not a dollar more of credit |
| What pushing costs | By the square-root rule, +10% across the spot venues takes about **$87M** of buying (4 days of spot volume), and +30% about **$786M** (39 days). This must hold for over an hour to move the TWAP |

To gain one dollar of credit, the attacker must hold a manipulated price across Binance, OKX, Bybit, Coinbase and Hyperliquid for more than an hour. Even then, the most they could extract is bounded:
- the gain on a $240k position;
- the pool's 10%-per-day lending budget, and $25k in the account's first week;
- their own client limit.

Mango's MNGO had none of these protections: one thin oracle, no TWAP, unrealised PnL counted at once, and no caps.

### 13.7 Pre-trade checks

| Order | Result |
|---|---|
| 13.1's client, with the loan, buys back the whole short at a limit 0.2% above the mark | **Refused**. Equity after the trade would be $40,255, below the initial requirement of $46,509 for the unhedged nBTC, and the loan would be above the tier cap |
| A sell limit 0.9% above the mark | Booked at the mark (P4): a generous limit price can't create equity |
| … buys back a quarter of it | **Accepted**: it lowers the requirement, so it is risk-reducing |
| Limit price 5% below the reference (BTC band 1%) | **Refused**: outside the price band |
| TAO (next in line, not allowed) | **Refused**: not on the allow-list |

### 13.8 Ratings

| Client | Score | Tier |
|---|---|---|
| New, hedged book | 700 | Standard |
| + KYB | 800 | Preferred |
| + KYB + 8 months of clean, active linked Hyperliquid history | 900 | Preferred |
| Hedged + clean linked history, but no KYB | 800 | **Standard**: Preferred needs KYB |
| Farming try: all USDC + an old, idle linked address | 650 | Standard: no hedge points without coins, no bonus for an idle address |
| New, directional book | 550 | Watch |
| Directional, 6 good months, KYB | 710 | Standard |
| Hedged, KYB, one forced unwind this year | 725 | Standard |
| Window-dressed: hedged today, directional all week | 550 | Watch |
| Anyone after a default | 300 | Watch, blocked |

---

## 14. How this was checked

> **In simple words.** Every number here comes from code, not by hand. The code was tested against properties that must always hold. The coin parameters were checked against history. Then two separate reviewers, who had not seen how the file was written, tried to break it: one re-did the math from this text alone, the other attacked the design. What they found, and what changed, is below.

### 14.1 One source for every number

- `risk_engine_ref.py` implements sections 3, 4 and 6–9. It produces every number in section 13.
- `render_tables.py` writes the tables in sections 5.1 and 5.3 straight from `universe_v0.json`, so nothing is copied by hand.
- **Speed.** In plain Python, the hedged example runs 22 scenarios in about 5 ms. A book holding all 23 coins plus three NEAR tokens runs 99 scenarios in about 80 ms, and its credit line takes about 80 ms more. OutLayer allows 20 s per run (PLAN.md 5.6).

### 14.2 Properties that must always hold

`risk_engine_ref.py … tests` checks:

| # | Property | Result |
|---|---|---|
| T1 | At the computed credit line, by brute force: equity ≥ IM; no pool loss in any normal, ADL or replay scenario; extreme pool loss ≤ 5% of the loan | pass |
| T2 | More debt never raises the allowance and never lowers the requirement | pass |
| T3 | Moving USDC to Hyperliquid lowers the requirement when it stops a liquidation. (The naive version, "more Hyperliquid margin never hurts", is false: see the $45k row in 13.1) | pass |
| T3b | With no loan, withdrawals and trades are not limited by the requirement | pass |
| T4 | A book 20 times bigger needs at least 20 times the requirement (size is never free) | pass |
| T5 | Hyperliquid maintenance margin is continuous at tier edges | pass |
| T6 | The hedge lowers the requirement versus holding the spot alone | pass |
| T7 | IM = 1.25 × MR | pass |
| T8 | The TWAP rule never raises allowance equity | pass |
| T9 | Calm markets never shrink shocks or costs (factor floored at 1) | pass |
| T10 | Wild markets raise the requirement | pass |
| T11 | As nBTC slips, states only get worse: HEALTHY → WATCH → MARGIN_CALL → DELEVERAGE | pass |
| T12 | Squeeze-then-revert (the red-team's NEAR book): at the credit line, the pool loses nothing in that family | pass |
| T13 | A generous limit price is booked at the mark and creates no equity, checked on the engine's own post-trade book | pass |
| T14 | After the full Standard loan, pulling $25k of Hyperliquid cash is refused (tier cap and IM) | pass |
| T1b | Brute force where C4 binds (13.1 Preferred) and where C3 binds (13.4 with $200k): the line meets every condition, and $500 more breaks one | pass |
| T5b | Every margin table in use is continuous at its tier edges | pass |
| T15 | A score below 450 gives no credit (C9) | pass |
| T16 | Moving USDC from NEAR to Hyperliquid with a loan is checked like an outflow, and refused when it raises MR past equity | pass |
| T17 | A frozen nBTC adds no new credit and moves no state; it can be withdrawn only when the rest of the account carries the loan | pass |
| T18 | A hedged pair is unwound both legs together, so the group stays hedged | pass |
| T19 | A lower π_allow lowers the credit line but moves neither MR nor the state; a higher one adds nothing | pass |
| T20 | nBTC in transit falls with the scenario (at 98%), and counts as nothing once overdue | pass |

All 27 checks pass, in the Python reference and in the Rust engine (`risk/risk-core/tests/properties.rs`). T13 and T16 were strengthened, and T18–T20 added, on 7 Nov, after the Rust port found the bugs listed in 14.5. Two of them failed on first run and found real problems (14.5): T9, because unwind costs ignored the floor; and T3, whose naive form turned out to be false. T12–T14 were added for the red-team's findings, and T1b, T5b, T15 and T16 for the math review's.

### 14.3 The coin parameters against history

The last column of section 5.3 is the share of all 4-hour windows since 2019, or since listing, in which the coin moved past its normal shock S. The 99.9% target is 0.1%. Every coin is at or below it, because of the BTC anchor (α > 1) and the floors.

### 14.3b The Hyperliquid replica against live accounts

On 4 Nov 2026, the maintenance-margin formula of section 4.3 was run on every position of 54 public Hyperliquid accounts, all taken from Hyperliquid's public leaderboard and all holding only cross positions. The result was compared with the `crossMaintenanceMarginUsed` that Hyperliquid itself reports.

| Result | Accounts |
|---|---|
| Within 0.01% | 51, including 22 with positions above the first margin tier, one with 174 positions, and one with $478M of notional |
| Within 0.05% | 1 more, at 0.046% (probably prices moving between fields) |
| Different | 2: both are sub-accounts of Hyperliquid's own HLP vault. They are charged exactly 1% of notional, a special rule that does not apply to client accounts |

What is still to check against live data during the build: the liquidation price, and behaviour at the backstop threshold (14.6).

### 14.4 Independent review

Two reviewers checked this file. Each was a separate agent that had not seen how the file was written, and each was told to assume the author could be wrong anywhere.

**Red team: design and attacks.** It tried to break every rule in section 11 and found 13 problems, one of them critical. All are fixed in this file and in the reference code:

| # | Finding | Severity | Fix | Where |
|---|---|---|---|---|
| 1 | Orders were not serialised. Forty orders sent at once each pass the check alone: a $13M long on $1M of equity, and a pool loss of $0.7–0.85M near −6.5% | Critical | P0: one order at a time per account, recent orders count as filled, unused allowances count as spent; Hyperliquid's per-coin leverage as a second lock | 9 |
| 2 | Resting orders counted as filled created phantom hedges: about $233k more credit, and a $160k pool loss in the 2020 replay | High | The worse of no fill and each side filling; fills never better than the mark; the band re-checked; cancels through the gateway | 9 |
| 3 | π (nBTC, ETH) came from one 1Click quote | High | The π rule: capped at 1, hour-sized, the 15-minute median for states, credit at the 1-hour low. The planned second reading, a NEAR pool's average, proved impossible on 5 Nov (no usable pool), so π has one source again; the per-wrapper caps and the freeze cover what it can't | 3.3 |
| 4 | 12.2 did not bound a compromised enclave: up to 90% of the pool in about 4.5 hours | High | Limits that rely on no verdict: a 10%-per-day budget, new-account limit, tier history, co-signatures, a pause | 12.2 |
| 5 | The tier cap and C3 applied only to USDC withdrawals | Medium | All three credit conditions after every outflow and every trade | 7.3, P8 |
| 6 | No squeeze-then-revert path: the pool lost $66k at a Preferred line | Medium | A new scenario family | 4.5 |
| 7 | The 4-hour margin-call clock could be reset | Medium | A cumulative clock, with strict ends | 8.1 |
| 8 | The rating could be farmed to Preferred on day 1 | Medium | Exposure, activity, one link per address, KYB for Preferred, good months only with a loan | 6 |
| 9 | A fleeting print or our own outage could force an honest unwind | Medium | Two checks before DELEVERAGE; stale prices freeze; σ from exchange medians; 24 hours' notice; plans priced when they run; repaying allowed after 30 minutes without a verdict (an operator fallback signer was dropped on 5 Nov, 14.5) | 3.2, 4.4, 5.5, 8.1, 11.6 |
| 10 | Risk-reducing orders skipped the caps and the size limit | Low | P5 now needs P7 and P10 | 9 |
| 11 | Unwind capacity was counted per account | Low | The book's holdings count in T_g; NEAR-side book caps | 4.2, 12.1 |
| 12 | TWAP gaps: Hyperliquid's premium counted at once, and its last trades can be printed | Low | TWAP of exchange medians; the mark rule M | 3.2, 3.4 |
| 13 | Griefing: budget loops, steps run just before their quotes expire, partly hedged groups | Low | A net budget; 5 minutes of quote validity; the planner sells excess legs | 12.2, 11.8, 8.4 |

It also confirmed:
- C2 is implied by C1, once C0 is counted.
- Losses are affine in W while W leaves the account, so the closed-form credit line is exact.
- The non-recourse effect (MR capped near Hyperliquid equity) is not a hole by itself.
- A Mango-style pump on perps is held off by the caps.

**Math: an independent re-derivation.** The reviewer wrote its own implementation from this text alone, before opening the reference code. It reproduced 91 of the 92 cells of table 13.5 to the dollar, and confirmed:
- the algebra of C1 and C3;
- when C2 is implied by C1: at full weight, and when L_k ≥ −E_A·r·τ;
- that losses are exactly linear in W for a fixed rate (largest deviation over 30 scenarios: 10⁻¹¹);
- that all six margin tables are continuous;
- ℓ = √7 where the volume term sets the cap;
- the withdrawal bounds.

It found these, all now fixed:

| # | Finding | Effect | Fix |
|---|---|---|---|
| 1 | The text never said in what order a replay bar's low, high and close happen. The code applied a liquidation at a bar's high to the same bar's low, which came earlier. 13.1's story ("fell back to +19.1%") described a low from *before* the spike | The hedged MR was $18,869. In true time order it is $15,498, and the Preferred line is the full $114,750 | Replays are now the 240 one-minute closes in time order, and 13.1's story is rewritten from the minute data |
| 2 | ADL closed the perp without the price gap the text specifies | ADL losses about 3% low ($9,594 against $9,869) | The gap applies at the ADL close |
| 3 | The −90% cap was described as covering every family, but recorded paths weren't capped | PUMP's long $1,060 off from what the text implied | The text now says invented moves; recorded history is used as recorded |
| 4 | Bands froze MR, so they fired late | The nBTC bands were about 0.03 too low | MR is re-evaluated at each point, and the nearest crossing is found (8.3) |
| 5 | Examples 13.4 and 13.6 used tiers the rating rules wouldn't give | Credit lines overstated: $79k, $141k and $250k, against a Watch limit of $50k | The tier is stated: 13.4 assumes a KYB'd client (Standard); 13.6's attacker is Watch |
| 6 | The pool size behind the utilisation feedback wasn't stated, and "exact" overstated the second pass | $11 | Pool size stated in 13; 7.2 now says the second pass is safe, not exact |
| 7 | Smaller items | Wording, plus one edge case where an expired margin call could stay MARGIN_CALL | All corrected (4.2, 4.3, 4.5, 8.1, 8.2, 10, 13, Appendix B) |

The smaller items:
- ⅔ of maintenance margin was mislabelled;
- 1·S was written where 1·S* was meant;
- 13.6 gave the wrong MR driver;
- the TWAP claim didn't cover a push that is held;
- √7 holds only where the volume term sets the cap;
- 13.7 didn't state its limit price, and 13.5 didn't state its loan size;
- κ and F each meant two things;
- the 80% emergency level was undefined;
- one place said "≥ 3 of 5" sources, another "of up to 6";
- hysteresis could hold an expired margin call;
- HYPE's rebound scale used the fallback although HYPE traded on Hyperliquid that day.

**Two further changes from this review:**
- **P5 is stricter.** It now also needs the excess over IM not to fall by more than the fee.
- **14.6 lists what the reference code doesn't cover.**

### 14.5 Bugs found while building, and fixed

Writing the reference code against this text found these. Each is fixed in both.

| What was wrong | Effect if missed |
|---|---|
| ADL scenarios moved the price against the hedge. ADL closes the *winning* side, so a short is closed in a fall | The ADL risk for hedged books was understated (about $3.8k instead of about $9.6k in the smoke run) |
| A position's shock could exceed 100% (big position, thin coin) | Negative prices; the engine crashed |
| Hysteresis could push an account into a *worse* state | Spurious margin calls just above the line |
| Rebalancing pulled "excess" Hyperliquid margin home | It raised the very risk that dominates hedged books (D1) |
| The pre-trade check booked an existing position's open PnL at the wrong entry price | The post-trade equity was wrong by q × (mark − entry) |
| Replays used single-exchange wicks | Losses Hyperliquid's median-based mark would not see |
| HYPE has only 41 days of Binance spot history | Tails calibrated from 41 days; now from Hyperliquid candles since its launch |
| Unwind costs used the raw volatility factor, which could fall below 1 (caught by T9) | Calm markets would have shrunk costs below normal |
| "More Hyperliquid margin never raises the requirement" was taken as a law (T3) | It is false: the backstop keeps all margin, so margin that can't prevent a liquidation adds to the loss (13.1) |
| Coins without replay data followed BTC × their volatility ratio (about 2×) | A $100k SOL long needed $69k of buffer, from a 2020 window when SOL didn't trade; alts that did trade moved about 1.1× BTC that night |
| The 75th-percentile rule alone, after the 10 Oct 2025 crash, scaled BTC's +10% rebound by 13.7× | A made-up +141% move for HYPE; invented paths are now capped at ±2·S |
| After a depeg, the unwind plan could only unwind hedged pairs | It would have sold nBTC at the discount, instead of buying back the excess short (13.2) |
| Binance listing-day prints were included (UNI +4,900% in 4 hours) | The "worst move" columns were nonsense; the quantiles were unaffected |
| Funding stress used one year of history | BTC's worst week was −7% a year, not PLAN.md's −24.7% since 2023; now the longest history is used |
| ETH's floor was 12% | ETH would have dropped below PLAN.md's 18% |

**Fixed on 5 Nov, while bringing PLAN.md in line with this file.**
- Eight lines still showed an earlier draft: the hourly lending limit (now 10% of capital per 24 hours), 5-minute replay bars (now 1-minute closes), resting orders counting as filled, and nBTC priced from one dry quote.
- The NEAR-side book caps (12.1) are now checked by the pool at each borrow, not by the account at deposit. A refused 1Click delivery could strand the funds, and a plain `ft_transfer` can't be refused at all.

**Found on 5 Nov by an independent cross-check of PLAN.md against this file, and fixed:**
- **Orders that only shrink a position** were refused in three cases: in a reduce-only coin (P1), above a lowered cap (P7), and under PRICE_STALE (P10). That broke the 24 hours that coin removals give clients to reduce (5.5). They now pass all three.
- **The $50k co-signature** applied per plan step, so splitting a move avoided it. It is now cumulative: $50k per account per 24 hours (12.2). The exemption for the account's own Hyperliquid address was dropped, because every top-up goes through 1Click.
- **The verdict** lacked what the pool's own limits read. It now carries the collateral shares, the NEAR-side holdings, the Hyperliquid equity, the hedge ratio's averages and the smallest top-up. Appendix A now defines every field, with real values.
- **New program versions.** Monthly recalibration and emergency removals had no mechanism that works when accounts pin their program version. Coin status is now a list in the pool that every version reads (5.5, 11.9 S2).
- **Smaller fixes:**
  - a "new client gets $94.5k" ignored the $25k first week (13.1);
  - the averages for accounts younger than 7 days were undefined (6);
  - the testnet drill would have waited for π's 15-minute median (3.1);
  - the margin-call clock between verdicts was undefined (8.1).
- **Section 11 rows** O1, O2, O6, V6, B1, B2, G5, G7, G10 and T1 still showed an earlier draft.
- **14.3b miscounted the live accounts:** 1 more within 0.05%, not 2, and no "sixty".

**A second pass of the same check, on those fixes, found and fixed:**
- the $50k co-signature count was checked before a step, so one large step passed. It is now checked with the step, and other tokens are valued at the operator's prices, not the enclave's;
- an operator fallback signer (11.6, T1) could send collateral to a 1Click address. It is gone: after 30 minutes without a verdict, only repaying runs;
- a removed coin's positions couldn't be closed or unwound (5.5, P1);
- an owner who never accepted a new version kept old rules forever. New versions now apply after 30 days;
- the hedge ratio's record lived in the gateway's storage, which `pb-risk` can't read, and missed changes on the NEAR side. It is now an hourly record in the account contract, fed by every verdict;
- a verdict's plan had no size limit (now 4 steps), a REBALANCE plan had no confirmation rule (one verdict), and the inputs lacked the coin-status list and the related accounts (3.1).

**Changed on 6 Nov, after the day-1 checks:**
- **π has one source again.** No NEAR pool can give nBTC or ETH a second reading (`research/near_dex.md`). So π is the 1Click quote alone, with the same cap, windows and 60-second rule (3.3).
- **The freeze is new.** The operator can stop new credit against a bridged token at once, without forcing anyone to sell (3.3, 5.5). The reference engine models it (`Market.frozen`), and T17 checks it.
- **1Click capacities** for ETH and USDT were lowered to the measured levels (5.4).

**Found on 7 Nov by the Rust port (`risk-core`), and fixed in both:**
- **A pair step wasn't a pair.** Each leg was capped by its own venue, so with ETH.b's $50k-an-hour 1Click capacity one step bought back 48.5 ETH of the short but sold only 22.3 ETH.b, leaving the group net long. The step is now sized once and both legs use it (8.4, T18).
- **T13 and T16 checked too little.** T13 worked out the booking inside the test; T16 only checked that a yes or no came back. Both now check the engine's own answer.
- **One π for everything.** The reference valued wrappers at the mark π for allowance equity too. Allowance equity now uses π_allow, never above π_state (3.3, T19).
- **Money in transit wasn't stressed.** Φ didn't move in the scenarios, so nBTC on its way in carried no price risk. It now moves like the same token held (4.8, T20).
- **Smaller ones:** τ is worked out from `carry_days` when used, not once at start; an order for a coin outside the list is refused instead of crashing; the credit limit's 1.1^n is repeated multiplication, so every platform gets the same bits.
- **Doc fixes:** 13.1's IM is $19,372 (exactly $19,372.45; it had been worked out from the rounded MR).

The Rust engine now matches the reference to the last bit on 559 recorded cases, including every number in section 13, which none of these fixes changed.

### 14.6 Not yet checked (needs the build or day-1 data)

- **1Click.** Costs and capacities were measured with public dry quotes on 5 Nov and re-checked with our partner key on 7 Nov (5.4). Costs were lower on 7 Nov and capacities the same. The route from Hyperliquid to NEAR, refused at every size on 5 Nov, was open again on 7 Nov (`research/day1.md`).
- **The rest of the Hyperliquid replica.** Maintenance margin matches live accounts (14.3b). The liquidation price and the margin ratio still need checking against accounts we control on testnet, including tier edges (PLAN.md 10).
- **The backtest with rebalancing delays.** Done 9 Nov (`backtest crash`, README step 10, `research/data/backtest_v0.json`). Across the ten windows at 2-, 15- and 60-minute delays, the pool lost nothing on 13.1's hedged book or on 13.4's directional book at either margin. The hedged short is backstop-liquidated in the 13 Mar 2020 rebound at every delay, as 13.1 expects. The run found one bug, now fixed: a rebalance ignored money already on its way to Hyperliquid. So far the results give no reason to count the replays at less than full weight.
- **OutLayer determinism.** The same inputs must give the same verdict on two runs, and the program hash must match the reproducible build.
- **The book stress test and contract caps (12).** The contract caps are built and tested (Phases 1–4). The book stress test is built too (9 Nov): `pb-risk`'s `book` mode, run daily by the keeper and shown on the Book page. For one account, its days match the engine's own to the bit. It has run live only with no loans out.
- **Rules not in the reference code:**
  - P0 serialisation, P7's related-account and book caps, and the resting-order rule (the gateway);
  - C7's per-wrapper cap and the contract limits of 12.2 (the pool);
  - the DEFAULT state, which follows a finished unwind;
  - the margin-call clock and the two-check rule (the contract and the keeper).

---

## 15. Differences from PLAN.md 6.9

This file implements PLAN.md 6.9 and keeps its decisions: B as the base, three parts of C, the tier caps and markups, the pool's rate curve, and the 5% loss budget. Where working out the details changed a number or a rule, it is listed here. On 5 Nov, PLAN.md was updated to match, so this table now records what changed from the plan of 3–4 Nov.

| # | PLAN.md 6.9 said | This file | Why |
|---|---|---|---|
| D1 | Example: buffer about $10.2k | Buffer **$15,498**, set by the 13 Mar 2020 rebound replay. The credit lines are unchanged: Standard $94.5k, Preferred $114.75k (tier caps bind) | PLAN.md's figure came from the grid alone, without replays. In that replay, BTC jumped from +30% to +37% within a minute, sending the 2.9× short to Hyperliquid's backstop with all $35k of margin. The nBTC then fell back with BTC to +22.6%, unhedged. With $50k of margin (2×), the buffer is back to $10.1k (13.1) |
| D2 | Grid for BTC, ETH and NEAR only | A calibrated shock for each of 23 coins: the BTC-anchored 99.9% 4-hour move, with tier and young-coin floors (5.2) | The allow-list |
| D3 | "Concentration charge" (no formula) | Liquidity factor ℓ = √(1 + T/4 h), plus square-root unwind costs (4.2, 4.6) | Needed a formula; this is the standard liquidity-horizon scaling |
| D4 | BTC price: Hyperliquid's oracle | Median of ≥ 3 of up to 6 sources; the TWAP rule; rules for money in transit (3.2–3.4) | Manipulation (M1, O1) |
| D5 | Stress pool rate 50% | base(100%) + the tier's markup (52% for Standard) | Exact: that is the rate the client would pay |
| D6 | "USDC slips below $1, 13%" | USDT depeg scenarios; USDC is the unit of account | A USDC fall can't hurt a USDC lender (section 2) |
| D7 | Rating: +10 for each margin call fixed within 4 hours | +10 per good month; older forced unwinds count −35; the hedge ratio uses its 7-day average; score < 450 blocks credit; upgrades at most once per 30 days; starting limits grow 10% a month | The old rule also rewarded getting margin calls. The other changes close G2 and G3 |
| D8 | Deleverage when "a venue is projected to breach" | That triggers REBALANCE (top up Hyperliquid); DELEVERAGE only if rebalancing is impossible (8.2) | Moving margin is cheaper than selling |
| D9 | — | Rebalancing never drains Hyperliquid margin automatically; transfers out respect Hyperliquid's rule of 10% of notional (8.2) | D1: margin on Hyperliquid is what keeps hedges alive |
| D10 | — | No scenario lets a price fall more than 90% | Big positions in thin coins can otherwise get shocks above 100% |
| D11 | Replays: "minute by minute" | Kept: the 240 one-minute closes of each window, in time order. A coin with no data that window follows BTC × a measured scale: its own ratio from Hyperliquid candles, or the window's 75th-percentile ratio, never past ±2·S | Hyperliquid's mark ignores one exchange's wick. A first try that used each coin's volatility ratio (about 2×) overstated 2020, when alts moved about 1.1× BTC |
| D12 | — | One client ≤ 25% of the pool; net new lending ≤ 10% of capital per 24 hours; caps per wrapper and per venue (12) | Defence in depth |
| D13 | Pyth as a price source on NEAR | Pyth only off-chain through Hermes, with an API key | Pyth stopped updating its NEAR contract in Aug 2026 (3.2) |
| D14 | The client can "withdraw down to the margin requirement" (PLAN.md 4) | The requirement binds only while there is a loan. With no loan: free withdrawals, and orders checked only for the list, band, caps and hygiene (sections 0, 7.3, 8.1, 9) | With no loan the pool cannot lose anything. Hyperliquid's own rules govern the client's margin |
| D15 | ETH 18%, NEAR 25% (OKX defaults) | ETH 18% (floor); NEAR 21% (calibrated, tier 2) | NEAR now trades about $200M a day on Hyperliquid; its 4-hour tail supports 21% (0.07% of windows past it) |
| D16 | A pre-trade check per order | P0: one order at a time per account; recent orders count as filled; unused allowances count as spent; Hyperliquid's per-coin leverage as a second lock | Red-team G8: concurrent orders |
| D17 | Resting orders count as filled, largest side | The worse of no fill and each side; fills never better than the mark | Red-team G9: phantom hedges |
| D18 | nBTC priced from a 1Click dry quote | The π rule: a committed 1Click quote sized at an hour of capacity, capped at 1, credit at the 1-hour low, plus the freeze (3.3). A second reading from a NEAR pool was planned, but no usable pool exists | Red-team O7; day-1 check (`research/near_dex.md`) |
| D19 | ADL paths only | Plus squeeze-then-revert paths (4.5) | Red-team M8 |
| D20 | The rating of 6.9 | Hedge points need real exposure; the linked-address bonus needs activity and one link per address; Preferred needs KYB; good months only with a loan; only client-caused unwinds count | Red-team G11: farming |
| D21 | Contract checks (PLAN.md 5.1): tier caps, utilisation, per-collateral caps | Add a rolling 10%-per-24-hour net lending budget (timelocked), $25k for new accounts' first week, tier history in the pool, co-signature for borrows over $250k and for more than $50k a day of off-pool plan steps per account, and a pause. Wrapper caps cut to nBTC 30%, ETH 15%, USDT 30% (12.2) | Red-team: a compromised enclave could otherwise lend 90% of the pool in about 4.5 hours |
| D22 | Withdrawals of other tokens checked against IM only | All three credit conditions after any outflow and any trade (7.3) | Red-team: tier cap skipped through Hyperliquid withdrawals |
| D23 | A margin call "unresolved after 4 hours" | A cumulative clock over 24 hours; DELEVERAGE confirmed on two checks; stale prices freeze rather than unwind; 24 hours' notice for emergency coin removals (3.2, 5.5, 8.1) | Red-team G10, T7 |

**Not changed:**
- IM = 1.25 × MR.
- Extremes count at ½; replays count in full.
- The deleverage threshold of 0.8 × MR and the 4-hour margin-call clock.
- Tier caps of 85%, 70% and 50%, and markups of +1%, +2% and +5%.
- The rate curve, and the 5% pool-loss budget.

**Open choices for you.** D1 is the main one. Section 13.1 lists three options.

---

## 16. What the full version adds

Version 0 is deliberately narrow. Each item below is a known limit, and what replaces it later:

| Version 0 | Full version |
|---|---|
| No credit across coins: a long SOL perp and a short ETH perp each carry full risk | Offsets between related coins, like SPAN's inter-commodity credits. Each offset is backed by tested correlation and a stressed "decorrelation" scenario. Correlations break in crashes, which is why version 0 gives none |
| 23 coins chosen by fixed thresholds | Automatic monthly ranking, more coins with tighter caps, and a live liquidity score |
| Liquidity from 30-day volume and a square-root rule | Live order-book depth and 1Click capacity probes; aggregate impact when several clients unwind together |
| 1Click costs and capacities are placeholders | Measured routes, refreshed daily |
| Fixed shock ladders plus replays | Filtered historical simulation for every coin (option C in full), expected shortfall, and replays for more days |
| No money moves inside a scenario | A keeper model inside the replays: rebalance after 2, 15 or 60 minutes, which is the backtest of PLAN.md 6.9 step 9 |
| One venue for perps | Lighter and others, each with its own replica and a venue-failure limit |
| Rating from four simple inputs | More data sources, such as on-chain history across chains and attested bank or exchange statements; the score's weights fitted to repayment data once there is some |
| Book-level checks run daily by the operator | Continuous, with automatic tightening |
| Floating-rate USDC loans only | Other borrowed assets, fixed terms, and Rhea wholesale as a funding source behind the same credit decision (PLAN.md 5.10) |
| One key for the operator on testnet | Multisig with a timelock for parameter changes |
| Co-signatures by hand once an account's plan steps pass $50k a day, so a large urgent rebalance waits for us | An automatic co-signer outside the enclave. It checks each 1Click deposit address's recipient through 1Click's API, and signs at once when the money stays in the account's own venues |
| If OutLayer is down, no Hyperliquid orders can be placed, because the agent key lives there | The account contract signs reduce-only orders itself, through Chain Signatures |
| nBTC and ETH are priced from 1Click alone, because no NEAR pool can give a second reading | A second, independent reading from the bridge itself: the BTC it holds against nBTC's supply, and whether withdrawals go through |
| The freeze is set by hand | Set automatically by that bridge check |

---

## Appendix A: the signed verdict

This extends PLAN.md 5.6's verdict. Amounts are integer micro-USDC; ratios are basis points.

```json
{"ok":true,"v":1,"model":"B-0.2","params":"<sha256 of universe_v0.json>","acct":"acme.pbf.testnet",
 "blk":123456789,"nonce":42,
 "eq":40500000000,"eq_allow":40500000000,"mm":15616000000,"im":19520000000,
 "state":"HEALTHY","action":"NONE","since":0,
 "score":700,"tier":"STANDARD","rate_bp":650,
 "allow":{"withdraw":0,"borrow":0},"credit":{"line":94500000000,"binding":"C4"},
 "volf_bp":10000,"top":["replay 13 Mar 2020 rebound","ADL BTC 2/3S then 2/3S","nBTC depeg 20%"],
 "topup":11251000000,
 "venues":{"hl_margin_ratio_bp":357},
 "pool":{"shares_bp":{"nBTC":7407},"hold":{"nBTC":100000000000},"hl_eq":35000000000},
 "hr_bp":10000,"hr7_bp":10000,"exp_bp":49383,
 "bands":{"BTC":{"hl50":103110,"hl100":104383,"im":104195,"mr":104213},"nBTC":{"im_bp":8309,"mr_bp":7914,"dl_bp":7574}},
 "coins":{"uncertain":[],"stale":[],"reduce_only":[]},
 "plan":[],
 "in":"<sha256 of every input read>"}
```

**The example** is 13.1's account just after it drew the full $94.5k Standard loan and took the money out (13.1–13.3). Every value comes from `risk_engine_ref.py` (the top-up from its `topup` search), except `exp_bp`, which is simply the gross exposure ($200k) over equity ($40.5k).

**Every field:**
- `ok`, `v`, `model`: success, format version, model version.
- `params`: the hash of the parameter file.
- `acct`, `blk`, `nonce`: the account, the block height read, and the account's counter. One verdict backs one action.
- `eq`, `eq_allow`: mark equity and allowance equity (3.4).
- `mm`, `im`: MR and IM.
- `state`, `action`, `since`: the state (8.1); NONE, REBALANCE, REBALANCE_NOW or DELEVERAGE (8.2); and when the current margin call started (0 if none).
- `score`, `tier`, `rate_bp`: the rating (6) and the rate (7.1).
- `allow.borrow`: W*, how much more the account may borrow now (7.2). `allow.withdraw`: the most USDC it may withdraw now (7.3); with no loan, nothing limits withdrawals and the field is unused.
- `credit.line`: D + W*, the most the account may owe. `credit.binding`: the bound that set W*.
- `volf_bp`: the volatility factor (4.4).
- `top`: the three biggest risks, in words.
- `topup`: the smallest Hyperliquid top-up that removes a liquidation from the top risks, or 0 (8.2). Here, $11,251 takes the short through the 13 Mar 2020 rebound, and MR falls to $10,812.
- `venues.hl_margin_ratio_bp`: Hyperliquid's margin ratio.
- `pool`: what the pool's own limits read (12): each bridged token's share of the account's collateral, the NEAR-side holdings, and the Hyperliquid equity.
- `hr_bp`, `hr7_bp`, `exp_bp`: the hedge ratio now, its 7-day average, and the coins' gross exposure as a share of equity. The account contract adds `hr_bp` and `exp_bp` to its hourly record for the rating (6).
- `bands`: for each coin, the prices where Hyperliquid's margin ratio reaches 50% and 100% and equity reaches IM and MR; for each wrapped token, the π where equity reaches IM, MR and 0.8 × MR (8.3). Bands the search doesn't reach are left out. Here, BTC moves don't hurt the hedged book until the short nears liquidation, so BTC's IM and MR bands sit just below its liquidation price.
- `coins`: coins whose prices are uncertain or stale, and coins and tokens that are reduce-only. A frozen bridged token is listed as reduce-only.
- `plan`: the steps, for REBALANCE or DELEVERAGE (8.4).
- `in`: the hash of every input read.

**Size.** The example is about 0.9 KB with full 64-character hashes. Each extra coin's bands add about 55 bytes, and each plan step about 200. A verdict carries bands for at most three coins (those nearest a band) and at most 4 plan steps, so it stays under 2 KB. The next verdict re-plans the rest (8.4).

## Appendix B: formula sheet

```
PRICES      P_g = median(valid sources) (≥ 3);  P̄_g = 1-hour TWAP of per-minute exchange medians;  π = min(1, 1Click quote); π_allow = lowest π of the hour, ≤ π_state; frozen → π_allow = 0
EQUITY      E   = Σ_j u_j·P_γ(j)·π_j + E_HL + 0.98·inflight − D          (inflight: a plan step's transfers; the owner's own moves count 0)
            E_A = E − 0.98·inflight − Σ_g max(0, n_g·(P_g − P̄_g)) − Σ_g max(0, q_g·(m_g − P_g));   C = E_A + D
SHOCK       S*_g = S_g · min(2.5, max(1, σ_g/σ_g^ref, σ_BTC/σ_BTC^ref)) · sqrt(1 + T_g/4h)
HL MARGIN   MM_g(N) = N/(2·L_t) − deduction_t;  liquidation if E_HL < Σ MM_g;  backstop if E_HL < ⅔·Σ MM_g
SCENARIO    E(x) = Σ V_j(x) − cost_NEAR + E_HL,after(x) − cost_HL + 0.98·inflight(x) − D − D·r·τ − Σ q·m(x)·F·τ   (inflight valued like the token held)
LOSS        L(x) = E − E(x)   (worst over the path for ADL and replays)
REQUIREMENT MR = max(max_Normal∪ADL∪Squeeze L, ½·max_Extreme L, max_Replay L, 0);  IM = 1.25·MR
CREDIT      W* = max(0, min(C0, C1_k, C2_k, C3_k, C4, C5, C6, C7, C8, C9));  C0 = E_A, or 0 if E_A < $1,000
            C1_k = (E_A − 1.25·ω_k·L_k)/(1 + 1.25·ω_k·r_k·τ)    C3_k = (E_A − L_k + 0.05·D)/(0.95 + r_k·τ)
            C4 = cap_tier·C − D
RATE        base(U) = 6%·U/0.8 (U ≤ 0.8), 6% + 44%·(U − 0.8)/0.2 (U > 0.8);  rate = base + {1%, 2%, 5%}
STATE       HEALTHY E ≥ IM | WATCH MR ≤ E < IM | MARGIN_CALL 0.8·MR ≤ E < MR (< 4 h) | DELEVERAGE otherwise
SCORE       650 ± portfolio ± history ± outside record + KYB, in [300, 1000]; tiers at 800 / 600 / 450
```
