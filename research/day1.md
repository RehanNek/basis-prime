# Day-1 checks (Phase 0)

Started Thu 5 Nov 2026. This file answers each unknown in PLAN.md section 13, and says which fallback we chose wherever a check failed. Phase 0 ends when every row has a result (PLAN.md 11.1).

**Status, 7 Nov:** every check has a result except 7 (mainnet, Phase 6). None of the checks needed its fallback.

Raw data: `research/data/day1_*.json`. Scripts: `research/scripts/day1_*.py`.

## Where each check stands

| # | Unknown (PLAN.md 13) | State | Result | Fallback chosen |
|---|---|---|---|---|
| 1 | OutLayer testnet executors restart often | **Done** (7 Nov) | **20 of 20 on-chain runs** from a contract came back, each in 10–12 blocks (about 10–11 s end to end), and **20 of 20 over HTTPS** (about 2 s). One more on-chain attempt never reached the chain: the CLI's transaction expired before sending, so it was re-run. The callback with a 2 KB verdict used 1.6 TGas, and verdicts up to 4 KB arrived whole. About 0.0011 NEAR per on-chain run and $0.001 per HTTPS run. See "1. OutLayer on-chain and over HTTPS" below | None needed: on-chain verdicts work as planned. Attach 10 TGas for the callback, not 30 |
| 2 | Funding a fresh Hyperliquid testnet address | **Done** (7 Nov) | **It works.** You sent 800 test USDC from your faucet-funded testnet account to the float (`0xfc9D…009d`) with the Hyperliquid app's Send button. It lands in spot, so `pnpm --filter @pb/oneclick-shim float:to-perps` moves it to perps; a never-used address pays 1 USDC to activate. The float then delivered to a fresh address in the shim's live test, and held 790.6 USDC afterwards. Hyperliquid's faucet page gives 1,000 mock USDC to an address that has deposited on mainnet, at app.hyperliquid-testnet.xyz/drip, and doesn't say how often an address can claim. The demo needs about $11,000 on testnet: $9,500 of margin, plus about $1,500 for the float's side of the trades. That is about 10 more claims before Phase 3. The USDC comes back to the float at close-out, so it is reused | None needed yet. If we can't gather about $11k: more teammates claim, or we ask Hyperliquid for a builder top-up, or the testnet demo book shrinks |
| 3 | MPC latency and timeouts on testnet | **Done** (7 Nov) | **10 of 10** Hyperliquid `ApproveAgent` digests signed from a contract, and each one recovers to the derived address. Seven took 7–9 blocks (about 8–9 s end to end), three took 25–29 blocks (about 19–20 s); none came near the 200-block timeout. About 12.3 TGas and 0.0011 NEAR per signature. See "3. Chain Signatures from a contract" below | None needed: even the slowest signature is far inside the 5 minutes a plan step's quote must have left (PLAN.md 5.1, `execute_step`). Take v from `recovery_id`, never from `big_r`'s prefix |
| 4 | 1Click capacity from Hyperliquid to NEAR, and minimums | **Done** (7 Nov, with our key) | **NEAR → Hyperliquid:** quotes from $2 to $50k, at 0.02% plus about $0.32 flat, so moves under about $10 lose over 3%. **Hyperliquid → NEAR:** refused at every size on 5 Nov, open again on 7 Nov: every size from $2 to $50k quotes, at 0.02% plus about $0.20 flat. See "4–5. 1Click" below | None needed now. If the route closes again: Hyperliquid's own `withdraw3` to a 1Click deposit address on Arbitrum, then Arbitrum → NEAR, which quoted 0.02% for $100k (PLAN.md 5.4) |
| 5 | Cost of selling nBTC at size | **Done**, with public quotes (5 Nov) and our key (7 Nov) | **5 Nov:** nBTC 0.17–0.21% at $10k and about 0.33% from $50k to $500k; ETH 0.19–0.40% up to $100k. **7 Nov, keyed:** nBTC 0.15–0.18% up to $500k, ETH 0.17–0.18% up to $100k; the sizes refused are the same (nBTC at $1M, ETH from $250k). USDT at most 0.02%, wNEAR 0.2–0.6%. Real quotes match dry ones with our key, so these are the costs we would pay | **Costs:** the engine's formula stays. It is at or above every measurement, except ETH at small sizes, where our lower fee should close the gap. **Capacities:** ETH lowered from $500k to $50k per hour, USDT from $1M to $500k (`RISK_ENGINE.md` 5.4). All the engine's checks still pass |
| 6 | Does a plain `ft_transfer` to a 1Click deposit address need storage registration? | **Done** (7 Nov) | **Yes.** NEAR-side deposit addresses are fresh implicit accounts (64 hex), and none was registered on nBTC, USDT or NEAR USDC (`storage_balance_of` returned null), so a plain `ft_transfer` would fail. `eth.bridge.near` needs no registration | Batch `storage_deposit` (0.00125 NEAR) for the deposit address before every `ft_transfer`, as planned. It is required, not a precaution |
| 7 | Does 1Click activate a new Hyperliquid account, and who pays the 1 USDC? | **Phase 6**, mainnet, needs your yes | — | Make the first deposit at least $10 |
| 8 | A second price reading for nBTC (π needs two) | **Done** | **No NEAR pool can give one, for nBTC or for bridged ETH.** The only pools with depth are two Rhea pools of about $10k each. They price nBTC from Pyth's BTC/USD, so they can't see a depeg. 91% of all nBTC sits in NEAR Intents, which 1Click quotes from (`research/near_dex.md`) | **Decided 6 Nov:** price nBTC and ETH from the 1Click quote alone, keep the original caps, and add a freeze switch. A frozen token counts as zero toward new loans, while existing loans carry on under the normal rules (`RISK_ENGINE.md` 3.3) |
| 9 | OutLayer storage as the gateway's one-order lock | **Done** (7 Nov) | **It works.** In 3 rounds, 5 calls at once raced for one lock key, first with `set_if_absent`, then, after a release, with `set_if_equals`: exactly one won every time. The lock persists to the next run, a loser can't release it, the winner can. Testnet runs only 2 jobs at once, so the true contention was two-way. Storage is per caller: HTTPS runs (our backend) and on-chain runs (a contract) don't see each other's keys. Rollback protection is still untested | Take with `set_if_absent` (`set_if_equals` refuses a missing key), release with `set_if_equals` back to "free". The gateway's orders all arrive over HTTPS, so they share one lock space |
| 10 | Can OutLayer reach every price source? | **Done** (7 Nov) | From inside OutLayer, in 3 of 3 runs: Binance, OKX, Bybit, Coinbase, 1Click and Hyperliquid (mainnet and testnet) all answered HTTP 200, in 22–281 ms (medians). Hermes answered 401 without a key, as expected. Nothing is region-blocked. A run that fetched all of them took about 2.4 s and cost $0.001 | Without the Pyth key, five sources instead of six |
| 11 | OutLayer's per-run limit on calls out | **Done** (7 Nov) | **No limit on web calls.** Runs made 10, 30, 60, 100, 150, 200, 500 and 1,000 outbound calls, and every call succeeded; 1,000 took 28 s and cost $0.0011. The 100-call cap in our notes applies only to OutLayer's NEAR RPC helpers. The real bounds are the run's time limit (60 s by default) and an abort after 2 timed-out requests. A 23-coin book needs about 160 calls ("Calls per run" below) | None needed. Keep NEAR state reads within 100 RPC helper calls, or read state over HTTP |
| 12 | Hyperliquid testnet prices and coins | **Done** | See below. 16 of the 23 coins trade on testnet. BTC's testnet oracle stays within 3 bp of the exchanges, but its mark sits 11–16 bp above. The margin rules differ, and so does the demo's unwind plan | Prices: none needed. The engine uses the same price rule on testnet, with testnet's oracle as one source. Coins: on testnet, the coin-status list keeps the 7 missing or broken coins removed. Demo: $9,500 of Hyperliquid margin, not $8,750 |

## 12. Hyperliquid testnet prices and coins (done)

`research/scripts/day1_hl_testnet.py`, 10 samples 30 s apart, 19:08–19:13 UTC on 5 Nov. Output: `research/data/day1_hl_testnet.json`. Reference price: the median of Binance, OKX, Bybit and Coinbase mids, with USDT pairs taken at par.

**Coins.**
- **Missing from testnet:** XRP, ENA, UNI, LINK, TRX and LTC.
- **On testnet but unusable:**
  - ZEC is delisted there, with a stale price 89% below the market;
  - HYPE's testnet oracle is about 86 times the real price. It is a different market.
- **That leaves 16 coins** with real prices on testnet.
- **The demo needs only BTC.** On testnet, the pool's coin-status list marks the other 7 as removed, so the gateway refuses them.

**Prices, BTC.**
- **Testnet oracle:** within ±2.8 bp of the exchanges.
- **Testnet mark:** +11.5 to +16.1 bp above, median +14.4 bp.
- **Mainnet mark,** for comparison: 0 to +2.9 bp.

**Prices, other coins.**
- **Testnet oracles:** within 9 bp, except ZEC and HYPE.
- **Testnet marks:** wander further, for example PUMP +77 bp, ETH +45 bp and SOL +29 bp.

So the engine needs no special price source on testnet. Its median of sources includes testnet's oracle, and Hyperliquid's own margin uses testnet's mark, which the replica reads directly.

**Asset numbers differ by network.** The gateway must read them from `meta` per network, never hard-code them:

| Coin | Testnet | Mainnet |
|---|---|---|
| BTC | 3 | 0 |
| ETH | 4 | 1 |
| SOL | 0 | 5 |

The rest are in the JSON.

**Leverage and margin tables differ.**
- **Maximum leverage:** SOL 10× on testnet against 20× on mainnet; NEAR 20× against 10×.
- **BTC's margin tiers:**

  | Network | Tiers |
  |---|---|
  | Testnet | 40× up to $10k, 25× to $50k, then 10× |
  | Mainnet | 40× up to $150M |

- **What that does to the demo short:**

  | Network | Maintenance margin on a $25k short | On $100k |
  |---|---|---|
  | Testnet | $425 | $3,425 |
  | Mainnet | $312.50 | $1,250 |

The engine reads margin tables live (`RISK_ENGINE.md` 3.1), so it adapts by itself. The demo's numbers do not, as the next part shows.

**What this changes in the demo.** Checked with the reference engine, with testnet's BTC tiers swapped in.

The quarter-size book ($25k nBTC, $25k short, $8,750 margin) keeps its line ($23,625) and its drill thresholds. But the unwind plan at nBTC/BTC 0.75 changes:
- **On mainnet's tiers:** one step, buying back $6,250 of the short for about $3.
- **On testnet's tiers:** three steps:
  1. buy back $6,250;
  2. unwind a $9,375 pair, which sells nBTC at the depegged price;
  3. repay $4,679.

The reason: after the first buy-back, the 13 Mar 2020 rebound replay still liquidates the smaller short under testnet's 2% maintenance rate.

**Fix:** $9,500 of margin. The numbers are then identical under both networks' rules:

| | $8,750 (testnet tiers) | $9,500 (both networks) |
|---|---|---|
| Standard line | $23,625 | $24,150 (70% of $34,500) |
| Preferred line (KYB demo) | $28,688 | $28,763 |
| Watch, margin call, deleverage below | 0.829, 0.790, 0.756 | 0.852, 0.807, 0.769 |
| Plan at 0.75 | 3 steps, sells nBTC | Buy back $6,250 for about $3, then HEALTHY |

The new line is still under the $25k first-week limit. PLAN.md section 2 and the Phase 3 gate now use these numbers.

**Order book.** Hyperliquid testnet's BTC book is thin. Its 20 visible levels held $7k–$32k of bids and $5k–$29k of asks. Here is how the demo's market orders would have fared:

| Order | Filled | Worst slippage when filled |
|---|---|---|
| Open the $25k short | 8 of 10 samples (twice, about $18k was left over) | 1.5 bp |
| $6,250 drill buy-back | 9 of 10 | 28 bp |
| $25k close | 8 of 10 | 3 bp |

So:
- the gateway sends limit orders inside the price band and resubmits what doesn't fill;
- for the recording, our float account can post the other side.

Mainnet's book holds millions within 0.5%.

**Funding.** Testnet BTC funding was about 0.0041% an hour (about 36% a year), against mainnet's 0.00125% (11%). The carry the demo shows on testnet will look better than mainnet's. The demo should say so, or show mainnet's rate next to it.

**USDC token ids** match our notes: testnet `USDC:0xeb62eee3685fc4c43992febcd9e75443`, mainnet `USDC:0x6d1e7cde53ba9467b783cb7c530ce054`.

## 4–5. 1Click dry quotes (public, no key)

`research/scripts/day1_oneclick_dry.py`, run twice on 5 Nov around 19:27 UTC. Output: `research/data/day1_oneclick_dry_keyless.json` and `…_run1.json`. Every request has `"dry": true`, so no deposit address is made and nothing can be sent. Costs are measured against the market: Coinbase for BTC, ETH and NEAR, and Kraken for USDT.

| Sale for NEAR USDC | $10k | $50k | $100k | $250k | $500k | $1M |
|---|---|---|---|---|---|---|
| nBTC | 0.17–0.21% | 0.32–0.35% | 0.32–0.35% | 0.32–0.35% | 0.33–0.35% | no liquidity |
| ETH (`eth.bridge.near`) | 0.19–0.27% | 0.33–0.40% | 0.34–0.39%, refused 1 in 4 | no liquidity | no liquidity | — |
| USDT | about 0% | — | 0.01–0.04% | — | 0.01–0.10% | no liquidity |
| wNEAR | 0.10% | 0.18% | 0.42% | 0.44% | 0.47% | — |

| Move | $2 | $5 | $10 | $1k–$50k |
|---|---|---|---|---|
| NEAR USDC → Hyperliquid | 1.68 arrives | 4.68 | 9.68 | 0.02% |
| Hyperliquid → NEAR USDC | refused | refused | refused | refused: "Quoting for this pair is not available" |

Notes:
- **The flat fee.** About $0.32 per move to Hyperliquid. That includes the 0.2 USDC deposit fee in 1Click's Hyperliquid guide.
- **What 1Click refuses as a recipient.** The burn address `0x…dEaD` ("recipient is not valid"). A fresh random address is accepted. The refusal from Hyperliquid to NEAR is not about the address: the address that worked on 3 Nov was refused too. 1Click's changelog and Hyperliquid guide say nothing about it.
- **The fallback route works.** Arbitrum USDC → NEAR USDC quoted $1k, $25k and $100k at 0.02%, taking about 25 s.
- **Public quotes carry a higher fee than ours will** (`research/intents.md`). So with our key, costs should only go down. Capacity is liquidity, and shouldn't change.

## 1. OutLayer on-chain and over HTTPS (7 Nov)

**The program.** `pb-ol-probe` (`risk/probe`) was built by a helper agent and published as the OutLayer project `pbf-keeper.testnet/pb-probe`. Its version `3f89e644…e466` is a 531 KB wasm on FastFS; we downloaded it back and the hash matches. Its modes: `hello`, `prices`, `calls`, `lock` and `big`, which returns a reply of a chosen size. On-chain it must be called as a Project source, because the worker gives OutLayer storage only to project runs. Corrections to our notes are in `research/outlayer.md`, under "Measured on testnet, 7 Nov".

**On-chain, from a contract** (`research/scripts/day1_outlayer_onchain.py`, `research/data/day1_outlayer_onchain*.json`). The probe contract calls `outlayer.testnet.request_execution` with 200 TGas, limits of 1B instructions, 128 MB and 30 s, and a 0.01 NEAR deposit. Its callback parses the verdict, hashes it and stores the hash, the way the account contract will.

| | Result |
|---|---|
| Hello runs | 20 of 20 came back with a verdict. A 21st attempt failed in the CLI before reaching the chain ("Transaction has expired") and was re-run |
| Blocks from our call to our callback | 10 to 12, median 11 |
| End to end | 9.7 to 11.4 s, median 10.9 s |
| Cost | About 12.5 TGas over all receipts; about 0.0011 NEAR net to the contract per run (OutLayer's charge, less the refund) |

| Verdict size | 256 B | 404 B (hello) | 900 B | 1 KB | 2 KB | 4 KB |
|---|---|---|---|---|---|---|
| Arrived whole | yes | yes | yes | yes | yes (twice) | yes |
| Gas our callback used | 0.39 TGas | 0.46 | 0.50 | 0.51 | 0.60 | 0.78 |
| The callback receipt's total gas | 1.42 TGas | 1.50 | 1.53 | 1.54 | 1.63 | 1.82 |

So a verdict's size isn't a problem. Above about 850 B of output, the worker stores the output in OutLayer's contract instead of resuming with it, and the callback still gets all of it. A 2 KB verdict costs 1.6 TGas to receive, parse and record. 10 TGas for the callback is plenty, and our verdicts (at most 2 KB, PLAN.md 5.6) fit with room to spare.

**Over HTTPS, with our payment key** (`research/scripts/day1_outlayer_checks.py`):
- **Hello:** 20 of 20, with no 408, 500 or 503. 1.7–2.2 s wall (median 2.1 s), about 0.75 s inside the enclave, $0.001 each. The first call to a new version took 4.9 s, and its compile wasn't charged.
- **Big replies:** 256 B to 4 KB, all byte-exact.
- **The lock, the price sources and the calls per run:** checks 9, 10 and 11 in the table above.
- **What all of 7 Nov's testnet checks cost:** $0.09 of the payment key's $20 of test USDC, and about 0.11 test NEAR in fees across the operator, the keeper and the probe. The probe account `probe.pbf-ops.testnet` also holds 2.97 NEAR, 1.47 of it locked for its contract's storage, which comes back if the account is deleted.

## 3. Chain Signatures from a contract (7 Nov)

The probe contract `probe.pbf-ops.testnet` (`contracts/testnet/probe`) calls `v1.signer-prod.testnet` (MPC 3.18.0) the way the account contract will: `sign` with `payload_v2.Ecdsa`, path `hyperliquid-1`, domain 0, 1 yoctoNEAR and 50 TGas, and a callback that returns the signature with the block heights of the call and the callback. `research/scripts/day1_mpc_probe.py` signed 10 real Hyperliquid testnet `ApproveAgent` digests, each for a random agent address, so nothing was ever approved. Raw results: `research/data/day1_mpc_probe.json`.

**Before the runs, the script tested its own pieces:**
- Keccak-256 against known vectors and against Python's SHA3, which uses the same permutation;
- the EIP-712 encoder against the spec's "Ether Mail" example;
- key derivation, three ways: our formula, the signer's `derived_public_key` view, and PLAN.md's test vector (`client1.pb.testnet`, `hyperliquid-1` → `0xd7f3…dd7c`).

All of them pass.

| | Result |
|---|---|
| Signatures that recover to the derived address `0xca86…35fb` | 10 of 10 (ecrecover with v = `recovery_id` + 27, as Hyperliquid does) |
| Blocks from our call to our callback | 7 to 29, median 9. Seven runs took 7–9 blocks, three took 25–29 |
| End to end, from sending the transaction to its final result | 7.8 to 20.4 s, median 8.8 s |
| Gas and cost per signature | About 12.3 TGas over all receipts; 0.0011 NEAR burnt on testnet |
| Timeouts (200 blocks) | None |

Notes for the account contract:
- **Use `recovery_id` for v, never `big_r`'s prefix.** In 5 of 10 runs `big_r`'s prefix (02/03) disagreed with `recovery_id`, because the signer returns R from before it flips s to its low form. r is the x coordinate either way. With v = `recovery_id` + 27, all 10 recover correctly.
- **s is always low-s**, as Hyperliquid requires.
- **Plan for about 30 s per signature.** A plan step that needs a signature (sending USDC home with `sendAsset`) adds 8–20 s. A step can only start with at least 5 minutes of its 1Click quote left (PLAN.md 5.1, `execute_step`), which covers that easily.

## 4–6. 1Click with our key (7 Nov)

`research/scripts/day1_oneclick_dry.py` again, now with our key: `research/data/day1_oneclick_dry_keyed.json`. Then `research/scripts/day1_oneclick_real.py` (`research/data/day1_oneclick_real.json`) asked three quotes per route back to back: dry with our key, real with our key, and real without a key. A real quote only creates a deposit address that expires in minutes; we never deposited.

| Sale for NEAR USDC, keyed | $10k | $50k | $100k | $250k | $500k | $1M |
|---|---|---|---|---|---|---|
| nBTC | 0.15% | 0.17% | 0.16% | 0.18% | 0.18% | no liquidity |
| ETH (`eth.bridge.near`) | 0.17% | 0.18% | 0.18% | no liquidity | no liquidity | — |
| USDT | about 0% | — | 0.02% | — | 0.02% | no liquidity |
| wNEAR | 0.20% | 0.23% | 0.32% | 0.46% | 0.61% | — |

| Move, keyed | $2 | $5 | $10 | $1k | $5k–$50k |
|---|---|---|---|---|---|
| NEAR USDC → Hyperliquid | 1.68 arrives | 4.68 | 9.68 | — | 0.02% ($25k and $50k) |
| Hyperliquid → NEAR USDC | 1.80 arrives | 4.80 | 9.80 | 0.04% | 0.02% |

What we learned:
- **The key works.** 1Click answers a made-up key with HTTP 401 ("Invalid token") and accepted ours. It is valid until 3 Nov 2027.
- **Dry quotes are what we'd pay.** With our key, real quotes came within 0.2 bp of dry ones on all six routes. Without a key, real quotes were up to 10 bp worse on nBTC and ETH, and the same on stable routes. Dry quotes are identical with or without a key, so they don't show the keyless fee.
- **Costs are lower than on 5 Nov, and the key isn't why:** keyless dry quotes on 7 Nov match the keyed ones. It's the market on the day. The engine's cost formula stays, since it is above both days. Capacities are unchanged: the same sizes are refused.
- **Hyperliquid → NEAR is open again**, at every size from $2 to $50k, with a flat fee of about $0.20 (0.2 USDC, as 1Click's Hyperliquid guide says). The fallback through Arbitrum stays in PLAN.md 5.4 in case it closes again.
- **Deposit addresses need storage** (check 6, in the table above). A NEAR-side deposit address is a fresh implicit account with no storage on the token, except on `eth.bridge.near`, which needs none.

## 8. A second price reading for nBTC

Full report: `research/near_dex.md`. Evidence: `research/data/near_dex/`. Measured at block 223208308, 19:17 UTC on 5 Nov.

**What exists.**
- **Neither token has a pool against USDC or a peer.** A sale goes through wNEAR.
- **The best pools are Rhea's pool 5949 (nBTC/wNEAR, about $11.5k) and pool 6354 (ETH/wNEAR, about $9.2k).** Both are oracle-priced "DEGEN" pools.
  - They take Pyth's BTC/USD and ETH/USD from `aggregate-oracle.near` and quote the token as if it were BTC or ETH, less the fee.
  - So they would show π ≈ 0.995 while the bridge failed.
  - They are built from the same prices as P_BTC.
- **Depth.** A $10k sale gets 45% (nBTC) or 56% (ETH) below the market. No sale gets more than about $5.6k.
- **No usable TWAP.** No pool keeps price history; Rhea's TWAP facility covers one stable pool and isn't a price.
- **Rhea's oracle offers no extra reading.** It publishes no pool-derived nBTC price.
- **No other NEAR exchange has a pool.**
- **Where nBTC actually trades.** `intents.near` holds 158.78 nBTC, 91% of all of it. That is where 1Click's solvers quote from, and why 1Click sells $10k at −0.17%.
- **Testnet.** No pool for `nbtc.n-bridge.testnet` either. The testnet demo uses the drill ratio anyway.

**Options for π on mainnet** (your call, because each changes `RISK_ENGINE.md` 3.3):

| Option | What it means | Assessment |
|---|---|---|
| 1. The planned fallback | One reading, the committed 1Click quote, still capped at 1, with the same 15-minute median for states and the same lowest-of-the-hour for credit. On top: a 2% haircut on nBTC and ETH, and half their book caps (nBTC 30% → 15%, ETH 15% → 7.5%), disclosed in the README | Recommended for v0. The cap at 1 stops anyone pushing π up. Pushing it down takes low quotes held for more than 7 minutes, two checks agreeing, and then a plan that buys back the short instead of selling nBTC. The cost: the full-size example's Standard line falls from $94.5k to about $93.1k |
| 2. Two 1Click routes (to USDC, and to native BTC) | Two readings, both from 1Click's solvers | Not independent. Not recommended |
| 3. A bridge-health reading | Compare nBTC's supply with the BTC the bridge holds on Bitcoin, and check that withdrawals are going through | Truly independent and sees a failing bridge directly. About a day of work (a Bitcoin API, plus the connector's views), so a candidate only if we get ahead, or for after the hackathon |

**Decided on 6 Nov:** option 1 without the haircut or the halved caps, plus a freeze switch. If a bridge looks unsafe, the operator freezes the token: it counts as zero toward new loans, existing loans carry on under the normal rules, and nothing is forced on anyone. Option 3 is on the list for after the hackathon (`RISK_ENGINE.md` 3.3, 16).

## 11. Calls per run

These are the calls `pb-risk` makes for one account holding k coins, from the inputs in `RISK_ENGINE.md` 3.1–3.3. It uses all-coin ticker endpoints where the exchange has one.

| Input | Calls |
|---|---|
| NEAR state at one block: account, token balances, pool, coin status (drill ratio on testnet) | about 10 |
| Hyperliquid account: `clearinghouseState`, `frontendOpenOrders` | 2 |
| Hyperliquid market: `metaAndAssetCtxs` | 1 |
| Volatility: `candleSnapshot` 1h and 1d per coin | 2k |
| Prices: Binance, OKX and Bybit all-coin tickers; Pyth for all ids at once | 4 |
| Prices: Coinbase, one product at a time | k |
| 1-hour average: one-minute closes on Binance, OKX and Bybit, per coin | 3k |
| π for nBTC and ETH (1Click quote, DEX reading) and USDT/USDC | up to 7 |
| **Total** | **about 24 + 6k**: 30 for the demo (k = 1), 84 for k = 10, 162 for all 23 |

**As built (7 Nov, `pb-risk`):** 10 NEAR reads for an empty account, 23 calls for one coin held, and 12 more for each other coin. It uses all-coin tickers, plus one-minute candles for the 1-hour average and 721 hourly closes for volatility, from Binance, OKX and Bybit.

Our notes list a limit of 100 "RPC host calls" per run (`research/outlayer.md` 4). **Measured on 7 Nov:** it covers only OutLayer's NEAR RPC helpers, not web calls; a run made 1,000 web calls without a failure (check 11). So a full 23-coin book fits in one run, and no caching is needed for the call count. Caching candles in OutLayer storage is still an option if runs get slow.

## Other Phase 0 items

| Item | State |
|---|---|
| Repo skeleton (PLAN.md 9) | **Done**: `contracts/`, `risk/`, `services/`, `web/` (placeholder), `scripts/`, `.env.example`, `.gitignore`, `LICENSE` |
| `risk/` builds | **Done** on the pinned Rust 1.93.0 (6 Nov). `risk-core`'s 3 tests pass, clippy is clean with warnings as errors, and `pb-risk` and `pb-gateway` build for `wasm32-wasip2` (about 76 KB each) |
| `contracts/` and `services/` build | **Done** (6 Nov).
- **Contracts:** on Rust 1.93.0 with near-sdk 5.29.1, the 5 unit tests pass, clippy is clean, and all 5 contracts build for `wasm32-unknown-unknown` (about 141 KB each before cargo-near optimises them). The first build failed: without a lockfile, cargo picked `near-sdk-env` 0.1.9 and `near-sys` 0.4.1, which need Rust 1.95. Both workspaces now declare `rust-version = "1.93"` and use cargo's resolver 3, which picks `near-sdk-env` 0.1.6 and `near-sys` 0.2.14.
- **Services:** the three build with TypeScript 7.0.2 and `@types/node` 22.20.5, pinned exactly |
| `web/` | **Done** (6 Nov).
- **Generated** with `create-near-app` 10.0.0 (`--frontend next-app`) on Node 24.22.2, installed with nvm for this project (`.nvmrc`). Homebrew's 24.3.0 is still the Mac's default.
- **Packages** pinned exactly: Next.js 16.4.5, React 19.3.1, near-api-js 7.4.0, near-connect 0.11.4, TypeScript 6.0.3, `@types/node` 24.19.2.
- **near-connect** stays on 0.11.4, not the planned 0.12.0. The template's `function-call-key-plugin` 2.2.0, the latest, supports only ^0.11.1. 0.12.0 compiled, but pnpm flagged the mismatch.
- **Checks:** `next build` passes, including the type check. `next start` served `/` and `/hello-near` with HTTP 200. The `hello-near` page is the template's example, and Phases 2–3 replace it |
| Testnet accounts and keys | **Done** (7 Nov), made by you.
- **Accounts:** `pbf.testnet` (factory, 5.99 NEAR), `pool.pbf.testnet` (4 NEAR), `pbf-ops.testnet` (operator, and co-signer on testnet, 10 NEAR) and `pbf-keeper.testnet` (keeper, 10 NEAR and 100 test USDC). Each key is in the Mac's keychain; the operator's and the keeper's are also in `.env`, and each matches its account's one full-access key.
- **OutLayer:** payment key 1, owned by the keeper, holds $20 of test USDC (`usdc.fakes.testnet`, minted free). It is in `.env` and in the OutLayer CLI's own store.
- **1Click:** the partner key is in `.env` and valid until 3 Nov 2027. 1Click answers a made-up key with HTTP 401 and accepted ours. On three routes its dry quotes matched the keyless ones exactly.
- **How:** `scripts/set-env.sh` saves each value without showing it. The OutLayer key came from the CLI (`outlayer login testnet`, `keys create`, `keys topup 1 --usd 20`) |
| README v0 | **Done** |
| Toolchains at pinned versions | **Installed 6 Nov, with your yes.**
- Rust 1.93.0 with clippy, rustfmt and the `wasm32-unknown-unknown` and `wasm32-wasip2` targets. rustup also updated itself, from 1.29.0 to 1.29.3.
- near-cli-rs 0.30.1 (`near`) and the OutLayer CLI v0.2.1 (`outlayer`, git tag, commit `25d4e544`), both built from source with `cargo install --locked`.
- **cargo-near 0.22.0:** installed. The first build failed, because this Mac's C++ compiler can't find its standard headers; the second, with the workaround below, worked. All 5 contracts build with `cargo near build non-reproducible-wasm --locked`: about 87 KB each after optimisation, each with its ABI.
- Node 24.22.2 with nvm (its checksum matched), for this project only (`.nvmrc`). Homebrew's 24.3.0 stays the Mac's default, and nvm's default is still 23.3.0.
- Not installed: Docker, needed only for reproducible contract builds in Phase 6 |
| Measured 1Click costs into `RISK_ENGINE.md` 5.4 and the reference engine's `TOKENS` | **Done with public quotes.** ETH's capacity went from $500k to $50k per hour, and USDT's from $1M to $500k. The cost formula stays, because it is at or above what we measured. All the engine's checks still pass, and the worked examples are unchanged. **Re-checked with our key on 7 Nov:** costs were lower, the refused sizes the same, and real quotes matched dry ones, so the formula and capacities stand ("4–6. 1Click with our key") |
| Pinned versions re-checked (PLAN.md 9) | **Done**, 5 Nov, against crates.io and npm. Still current: cargo-near 0.22.0, near-sandbox 0.4.0, near-api 0.8.7, near-workspaces 0.24.0, outlayer 0.2.1, wasi-http-client 0.2.1, k256 0.14.0, rmp-serde 1.3.1, near-api-js 7.4.0, @hot-labs/near-connect 0.12.0, create-near-app 10.0.0, @nktkas/hyperliquid 0.33.3, chainsig.js 1.1.16. Newer, released today: near-sdk 5.30.1 and near-cli-rs 0.31.0. We keep near-sdk 5.29.1, because 5.30 needs protocol 88 and mainnet is still on 87 (testnet is on 88). We keep near-cli-rs 0.30.1 until 0.31.0 has had a few days |

## C++ headers on this Mac

cargo-near bundles Binaryen's `wasm-opt`, which is C++, so installing it compiles C++. On the build Mac (macOS 15.7.7, Command Line Tools 16.4), `clang++` can't build even `#include <memory>`:
- it searches `/Library/Developer/CommandLineTools/usr/include/c++/v1` first;
- that folder is a leftover from an older install, holding 11 headers;
- the SDK has the full set, at `$(xcrun --show-sdk-path)/usr/include/c++/v1`.

**Workaround, with no system change:** put the SDK's headers first for the one build:

```bash
CXXFLAGS="-isystem $(xcrun --show-sdk-path)/usr/include/c++/v1" cargo install cargo-near --version 0.22.0 --locked
```

**Permanent fix, for you to decide, since it needs an administrator:** remove the stale folder, or reinstall the Command Line Tools.
