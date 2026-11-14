# NEAR DEX pools as π's second reading for nBTC and bridged ETH (subagent report, 2026-11-05 19:06–19:37 UTC; saved by the main session)

Read-only: public view calls and APIs only, no keys. Evidence is in `research/data/near_dex/`.

## Verdict: no usable pool for either token

| | nBTC (`nbtc.bridge.near`) | Bridged ETH (`eth.bridge.near`) |
|---|---|---|
| Pool against USDC or a peer | None. Selling takes two hops: → wNEAR → USDC | None. Same two hops |
| Best pool | `v2.ref-finance.near` pool 5949: DEGEN (ALMM), nBTC/wNEAR, 0.30% fee. Holds 0.0770 nBTC + 1,533.7 wNEAR; TVL about $11.5k; 24h volume $392 | Pool 6354: DEGEN (ALMM), ETH/wNEAR, 0.30% fee. Holds 2.13 ETH + 1,210.7 wNEAR; TVL about $9.2k; 24h volume $1,529 |
| $10k / $50k / $100k sale, vs Coinbase | −45% / −89% / −94%. No sale gets more than about $5.6k | −56% / −91% / −96%. No sale gets more than about $4.4k |
| Largest sale within about 1% of the pool's own price | About $1k | About $500 |
| Usable as π's second reading? | **No, at any size** | **No, at any size** |

**Why not:**
1. **The pools can't see a depeg.** DEGEN pools are Rhea's ALMM pools, which "use external oracle price feeds for the prices of the tokens traded in the pool" (Rhea guide).
   - The exchange prices `nbtc.bridge.near` from Pyth's `Crypto.BTC/USD` (feed `e62df6c8…`) through `aggregate-oracle.near`, and ETH from `Crypto.ETH/USD`.
   - So the pool quotes nBTC as BTC, less the fee and an imbalance term: 0.48% below the oracle for nBTC, 0.66% for ETH.
   - It would keep reading π ≈ 0.995 while the bridge fails, until its $5.6k of wNEAR were drained.
   - It is also built from the same exchange and Pyth prices behind P_BTC, so it is not independent.
2. **They are too thin.** A $2–5k trade would move a 15-minute average by several percent.
3. **No other NEAR exchange has a pool** of either token against a peer.
4. **The liquidity is in NEAR Intents.** `intents.near` holds 158.78 nBTC, 90.8% of the supply. All Rhea contracts together hold about 0.37 nBTC. That is why 1Click sells $10k at −0.17% while Rhea's pools give −45%.

## Contracts and sources

| Item | Value | Source |
|---|---|---|
| Classic, stable, rated and DEGEN pools | `v2.ref-finance.near` (v1.9.21) | Rhea guide `developers/contracts.md`; rhea-sdk `constant.ts`; ref-ui `config.ts`; DefiLlama adapter |
| Concentrated liquidity (DCL) | `dclv2.ref-labs.near` (v2.4.2); `dcl.ref-labs.near` is obsolete | Same |
| Testnet | `ref-finance-101.testnet`, `dclv2.ref-dev.testnet` | Rhea guide, rhea-sdk |
| Views | `get_pools`, `get_pool`, `get_degen_pool`, `get_return` (prices DEGEN pools too), `list_pool_twap_info_view`; DCL `list_pools`, `get_pool`, `quote` | ref-ui and rhea-sdk sources, checked against each contract's exported functions (`wasm_exports.txt`) |
| Rhea's oracle | `aggregate-oracle.near` v0.4.1; source repo private | `list_degen_oracle_configs` |
| Rhea APIs | `api.ref.finance` (`/list-token-price`, `/list-pools-by-tokens`), smart router `smartrouter.ref.finance/findPath`, multi-exchange router `smartx.rhea.finance/swapMultiDexPath` | ref-ui sources, rhea-sdk-docs |

At block 223207588, `v2.ref-finance.near` had 9,006 pools and `dclv2.ref-labs.near` 6,436.

## Pools

**nBTC: 31 pools, none useful.**
- The two largest by TVL (6425, 6426) pair nBTC with meme tokens and had no volume.
- After those comes pool 5949 above.
- The peer links are dust:
  - DCL `WBTC|nBTC|0.2%` holds 0.018 nBTC, with no liquidity at the current price;
  - pool 6495 holds 2 sats on each side.
- No pool pairs nBTC with USDC, USDT or USDC.e.
- `btc.omft.near`, BTC inside NEAR Intents, has no Rhea pool.

**Bridged ETH: 8 pools.** Only 6354 has any depth. `eth.bridge.near`'s supply is 2,130 ETH, of which the Aurora engine holds 1,434.

**`aurora` (Rainbow "nETH") is not a usable peer.** The Aurora engine names `eth.bridge.near` as its ETH connector, and the balances suggest the two share one ledger. But the `aurora` pools 1207 and 2734 imply ETH at $3,893–3,917, about 73% above the market, and nobody arbitrages them.

## Depth

Measured at block 223208308 (19:17:18 UTC). Each sale goes through pool 5949 or 6354, then the best wNEAR → USDC pool.

| Sale | nBTC: USDC out | vs Coinbase | ETH: USDC out | vs Coinbase |
|---|---|---|---|---|
| $10k | 5,493.60 | −45.06% | 4,381.87 | −56.18% |
| $50k | 5,615.30 | −88.77% | 4,437.23 | −91.13% |
| $100k | 5,618.15 | −94.38% | 4,438.71 | −95.56% |

Small sizes, at block 223208481:

| Sale | nBTC vs Coinbase | ETH vs Coinbase |
|---|---|---|
| $100 | −0.59% | −0.75% |
| $500 | −0.95% | −1.20% |
| $1k | −1.41% | −1.80% |
| $2k | −2.48% | −3.32% |
| $5k | −10.17% | −19.68% |

Rhea's smart router chose the same routes and got the same amounts, within $10. Its multi-exchange router found no venue other than Rhea.

## A 15-minute average

- **No pool keeps price history.**
  - `v2.ref-finance.near` has a TWAP facility, but it is registered only for stable pool 4179. It averages one LP share's token mix, for Burrow's LP collateral; it is not a price.
  - DCL has no observation or TWAP method.
- **It could be built by sampling** `get_return` or `get_degen_pool` every 15–20 s, about 6–8 calls a minute. Or it could be rebuilt on demand from past blocks: FastNEAR and drpc both served state from 90,000 blocks back (about 14 hours).
- **It would be worthless:** it would average the oracle's price less the fee. The pool's oracle prices refreshed about every 20 s.

## Existing price feeds

**`aggregate-oracle.near` publishes no exchange-derived nBTC price.**
- Its nBTC sources are `pyth_pro` (required), Binance BTCUSDT, CoinGecko `bitcoin`, atlas and outlayer.
- Its `smartrouter` (pool) source is configured only for FRAX, AURORA, ZEC, RHEA and QTC.
- So it is a BTC/USD price, blind to the nBTC peg.
- Its secondary readings were stale: CoinGecko 10.7 hours old and 6% high, Binance 64 minutes old.

**Rhea's `list-token-price`** is undocumented. It matched neither the pool nor the oracle at the same block.

## Other venues, and testnet

- **Other NEAR exchanges:**
  - Jumbo (`v1.jumbo_exchange.near`, 385 pools) has no nBTC or ETH pool.
  - DeltaTrade's grid bots hold about $700 of nBTC; that is not a pool.
  - Veax (TVL $9.4k) and Orderly were not checked.
- **Testnet:** `nbtc.n-bridge.testnet` has no pool on `ref-finance-101.testnet` or `dclv2.ref-dev.testnet`.

## Not verified

- Who may register a pool for the TWAP facility (`register_pool_twap_record`).
- The exact formula for DEGEN-pool swaps; only the contract's own quotes were used.
- Why the `aurora` pools stay unarbitraged.
- How `list-token-price`, and the oracle's atlas and outlayer sources, are computed.
- FastNEAR's free-tier rate limit: about 450 calls at up to 3 a second gave no errors.
- Veax and Orderly.
