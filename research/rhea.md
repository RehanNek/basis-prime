# Rhea lending (Burrow) facts (subagent report, mainnet block ~222,895,478, 2026-11-03 16:31 UTC; saved by the main session)

1. contract.main.burrow.near, get_version "0.16.2", code hash 6Nek1MZ8cwJJ2xMQAUWup9V5AToYS9rkTxJfwo6BCpFa, owner burrow.sputnik-dao.near. Official repo github.com/ref-finance/burrowland (contracts/contract, HEAD 2110c70) is v0.15.7; 0.16.2 source only in unofficial github.com/shawn10359/burrowland (7f48c2a; release wasm hash matches mainnet). HF and liquidation code identical in 0.15.7 and 0.16.2. 0.16.x: maintenance mode, delist list, margin closed, LP (shadow) positions closed to new deposits/borrows.
   Oracles: enable_pyth_oracle true, enable_price_oracle false; pyth_oracle_account_id aggregate-oracle.near (Rhea agg-oracle v0.4.1; sources pyth_pro (required for BTC, NEAR, USDC, USDt), atlas, outlayer, binance, coingecko, smartrouter, pancake; stale 60 s; max deviation 100 bps BTC/NEAR, 50 bps USDC/USDt; BTC accepted $10k-$200k); pyth_price_valid_duration_sec 60; priceoracle.near oracle_call disabled ("Price oracle disabled").
2. Amounts in actions use inner decimals = token decimals + extra_decimals (USDC, USDt, NBTC, WBTC -> 18; wNEAR 24); ft_transfer_call amount in token decimals. execute*/simple_withdraw need 1 yocto.
   - Register: storage_deposit({"account_id","registration_only":true}) >= 0.1 NEAR (third party may pay); client also needs FT storage per token.
   - Deposit: <token>.ft_transfer_call({"receiver_id":"contract.main.burrow.near","amount","msg":""}); msg "\"OnlyIncreaseCollateral\"" deposits straight to collateral; {"Execute":{"actions":[{"IncreaseCollateral":{"token_id","max_amount"}}]}}; "\"OnlyRepay\"" repays (excess to supplied); {"ExecuteWithPyth":{"actions":[...]}}.
   - No prices: execute({"actions":[...]}) with IncreaseCollateral {token_id, amount?|max_amount?}, Repay {token_id} (from supplied), Withdraw {token_id, max_amount} (non-collateral supply only).
   - Prices: execute_with_pyth({"actions":[...]}) for Borrow {token_id, amount(inner)} (usually + Withdraw), DecreaseCollateral (with debt), Liquidate {account_id, in_assets[{token_id,amount}], out_assets[...]} (position defaults to "REGULAR"; min_token_amounts null), ForceClose {account_id}.
   - simple_withdraw({token_id, amount_with_inner_decimal, recipient_id?}) -> Promise<bool>.
   - DETACHED CALLBACK: execute_with_pyth does not return its promise; the tx shows SuccessValue even when callback_execute_with_pyth panics (e.g. mainnet tx B1aqwTtWhPEotH5nodJF8JpaCQixpUPzxpv44wejvkqc). A calling contract must re-read state (get_account_all_positions) or parse EVENT_JSON logs.
   - Position id "REGULAR". Borrow fails while any LP position exists or with delisted collateral (delist list currently []).
3. HF = sum(c*p*vol/10000) / sum(b*p*10000/vol) (collateral rounds down, debt rounds up). mul_ratio (x*r+5000)/10000; div_ratio (x*10000+5000)/r. Pyth price rejected if publish_time + 60 s < now. After any batch with Borrow or DecreaseCollateral the position must end at HF >= 1.0 exactly: NO buffer between borrow limit and liquidation line. Discount = (borrowed_sum - collateral_sum)/borrowed_sum/2 = (1-HF)/2. Liquidation: any account except the victim; liquidator repays from its own supplied balance, receives collateral; requires HF < 1, collateral_taken_usd*(1-discount) <= repaid_usd (raw prices), HF must stay < 1 after and must improve; no close factor; slices; dust can get stuck. ForceClose (force_closing_enabled true) when raw debt > raw collateral: all collateral to reserve, debt paid from reserve. RunningWithoutPublicLiquidation / Maintenance: only whitelisted liquidators.
4. Live assets (all collateral and borrowable): USDC vol 9500, supplied 12.68M, borrowed 11.06M, available 1.82M, util 85.9%, borrow 17.38% / supply 11.37%, caps 60M/25M; USDt 9500, 12.15%/7.71%; USDC.e 9500; USDT.e 9500; wNEAR 7500, 2.55%/0.34%; NBTC (nbtc.bridge.near) 8000, supplied 5.0648, borrowed 1.6631, avail 3.40, caps 20 supply / 4 borrow (14.9 NBTC headroom), 2.02%/0.50%; WBTC 7500, caps 15/5. max_num_assets 20 per account. 1 NBTC at $77,450 supports ~58,880 USDC borrow (76% = 0.80*0.95). Reserves USDC ~200k, USDt ~200k.
5. Cannot post collateral into another account's position (ft_on_transfer credits sender; execute acts on predecessor). Broker must transfer to the client contract, which deposits with "\"OnlyIncreaseCollateral\"". Burrow can't tell broker vs client collateral; liquidators may seize either; the public bot takes the collateral with the highest volatility ratio first (stables before NBTC).
6. Testnet: no maintained lending deployment (contract.1638481328.burrow.testnet 0.8.0 stale oracle; contract.1689937928.burrow.testnet 0.11.0 pyth feeds stale since 2026-06-06; contract.burrow.testnet 0.11.0 null prices). Deploy own: Rust 1.79.0 (rust-toolchain), cargo build -p contract --target wasm32-unknown-unknown --release + wasm-opt -Oz (or make release in Docker, or releases/burrowland_release.wasm); avoid --features=test. Init new({"config":{21 fields}}) per tests/workspace_env/setup.rs (dcl_id set; enable_pyth_oracle = !enable_price_oracle). add_asset(token_id, asset_config) then add_token_pyth_info; register Burrow on tokens; seed liquidity (deposit or "\"DepositToReserve\""). Companions: contracts/mock-pyth (anyone set_price; Burrow still needs publish_time within 60 s), contracts/test-oracle, contracts/mock-ft (public mint). Alternative: default_price in token info, changed via update_token_pyth_info to simulate a crash. wbtc.fakes.testnet / usdc.fakes.testnet export mint (public? UNVERIFIED).
7. SDK/API: @rhea-finance/cross-chain-sdk 0.1.22 (lending actions, batchViews, HF helpers; multica.near creates one contract per user); @ref-finance/ref-sdk 1.5.0 DEX only; Lending API https://lendingsdk.rhea.finance/health_factor/{account}; data API https://apidata.rhea.finance/burrow/get_burrow_liquidate_records/{account}, https://api.rhea.finance/get-burrow-records?account_id=. On-chain views: get_account_all_positions, list_accounts_all_positions, get_accounts_paged (72,953 accounts), batch_views. No HF view.
8. Gas: execute_with_pyth Borrow+Withdraw 43-64 TGas measured (~3 TGas per oracle call, callback 16-26 TGas); liquidation 55.5 TGas; attach 150-300 TGas.
9. Liquidations: Rhea's whitelisted bots (burrow-liquidation-bot-01..04.ref-labs.near, bm-resolver01/02.ref-dev-team.near) plus third parties (collector1.near, dustclear.near) using Borrow+Liquidate+Withdraw batches; discounts 0.24-0.28% (HF ~0.995) on $150-250 slices: liquidation starts almost immediately below HF 1. Public bot NearDeFi/burrowland-liquidation-bot uses disabled oracle_call. Bad debt: 2026-04-16 margin-trading slippage exploit ~$18.4M, ~$0.4M short after recoveries, margin trading discontinued (figures UNVERIFIED on chain); get_all_protocol_debts {} today.
10. Interest: u = borrowed/(supplied+reserved+prot_fee); kinked per-ms rate; target 80%: stables 6% at 80%, 50% at 100%; wNEAR 12%/250%; NBTC, WBTC 5%/250%. reserve_ratio 2500 (25% of interest; to pf.rhealab.near for most assets). Debt compounds per ms. USDC borrow 17.4% now, above the ~11% funding carry.

## 11. Warehouse numbers (main session, 10 Nov 2026, mainnet block 223,821,294)

Read with `python3 -I research/scripts/rhea_warehouse.py <out.json>`. The saved read is `research/data/rhea_warehouse_2026-11-10.json`; `--replay` prints the same numbers from it. Read-only: nothing was signed.

**Live terms:**
- **USDC:** $12.60M supplied, $10.90M borrowed, $1.90M free, 85.15% lent out. Borrow 15.91%, supply 10.32%.
- **USDT:** borrow 12.00%, $2.08M free.
- **nBTC:** 5.09 supplied of a 20 cap, so room for 14.9 more: about $1.12M at BTC $74,887. Volatility ratio 8000; USDC's is 9500.
- **Mode:** `Running`. Prices must be at most 60 s old.

**New facts:**
- **Rhea values nBTC as BTC.** `get_token_pyth_info` for `nbtc.bridge.near` gives Pyth's BTC/USD id (`e62df6c8…415b43`). So a fall of nBTC against BTC does not move Rhea's health factor, and Rhea carries the bridge risk on what it lends.
- **The rate curve is exact.** Its per-millisecond rates (6% at 80% lent out, 50% at 100%) reproduce the live borrow and supply APRs to two decimals. The supply APR is the borrow APR × borrowed ÷ supplied × 0.75.

**What our own flows would do to USDC's rate:**

| We borrow | Lent out | Borrow rate |
|---|---|---|
| $50,667 (one worked-example client) | 85.54% | 16.71% |
| $100,000 | 85.93% | 17.49% |
| $250,000 | 87.10% | 19.91% |
| $500,000 | 89.05% | 24.04% |
| $1,000,000 | 92.96% | 32.74% |

| We supply | Borrow rate | Supply rate |
|---|---|---|
| $50,000 | 15.24% | 9.85% |
| $100,000 | 14.59% | 9.39% |
| $300,000 | 12.05% | 7.64% |
| $1,000,000 | 5.92% | 3.56% |

**Capacity:** all the nBTC room, borrowed against at a 1.5 health factor, is about $566k of USDC: 11 worked-example clients. Rhea's rate would then be about 25%.

**The worked example split** ($100k of nBTC, our line $94,500, the pool at 6.5%, Rhea at 15.91%):

| Rhea's health factor | From Rhea | From the pool | Overall rate | BTC fall before Rhea liquidates |
|---|---|---|---|---|
| 1.2 | $63,333 | $31,167 | 12.81% | 16.7% |
| 1.5 | $50,667 | $43,833 | 11.54% | 33.3% |
| 1.75 | $43,429 | $51,071 | 10.82% | 42.9% |
| 2.0 | $38,000 | $56,500 | 10.28% | 50.0% |

The pool alone charges $6,142 a year on $94,500. Rhea alone lends $63,333 at a 1.2 health factor, for $10,076 a year.

**What it means for the design:**
- **The pool is the junior lender.** Rhea has first claim on the nBTC it holds, and no claim on anything else. The pool's part rests on what is left of the nBTC plus the Hyperliquid equity.
- **A failed bridge costs the pool far less.** With nBTC at zero, the pool alone loses $59,500 of $94,500. Behind Rhea at 1.5, it loses $8,833 of $43,833, and Rhea loses $50,667.
- **The 30% nBTC cap is what binds first.** A $1M pool alone can lend about $405k to such clients (4.3 of them). Counting only the pool's part behind Rhea, the same cap covers 2.7 times as many.
- **Price never favours Rhea today.** Our Standard rate reaches Rhea's 15.91% only when the pool is 83.6% lent out. So Rhea is for what our caps refuse, not for cheaper money.
- **Losing the race is cheap in fees and costly in hedge.** From a 1.5 health factor, a 40% fall in BTC with no top-up has liquidators repay about $21k (42% of Rhea's loan) and take about 36% of the nBTC, at a discount worth about $64. The short is then too big: a 20% bounce costs about $4,300 before the keeper trims it. At 2.0, nothing is liquidated.
- **The carry:** the hedge must earn 6.1% a year to cover the pool alone, and 10.9% with Rhea at 1.5. BTC funding averaged 5.8% over the past year and was 10.95% on 10 Nov.

## 12. Our copy in the sandbox (11 Nov)

**What ran.** Rhea's release file (`vendor/burrowland/burrowland_release.wasm`, version 0.15.7, sha256 `bdd286fe…5055`) on a local sandbox node (near-sandbox 0.4.0, nearcore 2.14.0). The tests are `contracts/tests/tests/rhea.rs` (7, all pass); the reusable setup is `contracts/tests/tests/common/rhea.rs`. Nothing was sent to testnet or mainnet. Shapes come from Rhea's source at commit `a479b83` (`contracts/contract/src`), and mainnet's settings from `contract.main.burrow.near` views on 11 Nov.

**The result.** One USDC loan goes through Rhea's own file, unchanged, with no oracle deployed. When every token a call touches has a `default_price` in its token pyth info, `execute_with_pyth` never calls the oracle account (`actions_pyth.rs`, `internal_execute_with_pyth`): it prices from the fixed prices and does the whole job in its own receipt. No way round anything was needed. In the tests the five accounts the config names (two oracles, the exchange, the booster token, the DCL) don't exist, and every step of a loan ran on Rhea, the token or the borrower.

### Setting it up

All by the owner unless said. Run in this order.

| Call | Arguments | Deposit | Notes |
|---|---|---|---|
| Deploy the file with `new` | `{"config": {…}}`, below | none | Signed by the copy's own account, 100 TGas for `new`. Burnt 75.7 TGas in all. Returns nothing |
| `<token>.storage_deposit`, for each token | `{"account_id": "<copy>", "registration_only": true}` | 0.00125 NEAR | Anyone can pay. The copy must be registered on a token to hold it |
| `storage_deposit` on the copy | `{"account_id": "<owner>", "registration_only": true}` | 0.1 NEAR | The owner registers like any user, so that it can supply |
| `add_asset`, for each token | `{"token_id": "<token>", "asset_config": {…}}`, below | 1 yoctoNEAR | Owner only |
| `add_token_pyth_info`, for each token | `{"token_id": "<token>", "token_pyth_info": {…}}`, below | 1 yoctoNEAR | Owner only. The source's comment says guardians too; the code checks the owner |
| `<usdc>.ft_transfer_call` | `{"receiver_id": "<copy>", "amount": "<units>", "msg": ""}` | 1 yoctoNEAR | Supplies USDC to lend |
| `execute` | `{"actions": [{"IncreaseCollateral": {"token_id": "<usdc>"}}]}` | 1 yoctoNEAR | The owner turns its whole USDC deposit into collateral. It stays lendable. No prices needed |
| `execute_with_pyth` | `{"actions": [{"Borrow": {"token_id": "<usdc>", "amount": "851500000000000000000000"}}, {"Withdraw": {"token_id": "<usdc>", "max_amount": "851500000000000000000000"}}]}` | 1 yoctoNEAR | The owner borrows 85.15% of its own 1,000,000 USDC, so that the copy charges mainnet's rate ("Rates" below) |

**The config** (`new`). 0.15.7 takes these 19 fields. Mainnet's 0.16.2 answers with two more, `contract_mode` and `pause_operator_id`, which our copy doesn't have. Values are mainnet's where they mean something here; the five account names are made up, under the copy's own name, so that only the copy's key could ever create them.

```json
{"config": {
  "oracle_account_id": "no-price-oracle.<copy>", "pyth_oracle_account_id": "no-pyth-oracle.<copy>",
  "ref_exchange_id": "no-ref-exchange.<copy>", "owner_id": "<owner>",
  "booster_token_id": "no-booster.<copy>", "booster_decimals": 18, "max_num_assets": 20,
  "maximum_recency_duration_sec": 90, "maximum_staleness_duration_sec": 90,
  "lp_tokens_info_valid_duration_sec": 600, "pyth_price_valid_duration_sec": 60,
  "minimum_staking_duration_sec": 2592000, "maximum_staking_duration_sec": 7776000,
  "x_booster_multiplier_at_maximum_staking_duration": 30000, "force_closing_enabled": true,
  "enable_price_oracle": false, "enable_pyth_oracle": true, "boost_suppress_factor": 1000,
  "dcl_id": "no-dcl.<copy>"
}}
```

**The asset settings** are mainnet's ratios and rate curves. `extra_decimals` makes both tokens 18 decimals inside Rhea. These fields are not mainnet's (decided 11 Nov):

| Field | Mainnet | Our copy | Why |
|---|---|---|---|
| USDC `supplied_limit` | `"60000000000000000000000000"` (60M) | `"340282366920938463463374607431768211455"` | Anyone can mint our test tokens. Once the supplied total is over this cap, USDC can't be turned into collateral, which the rate step needs |
| USDC `borrowed_limit` | `"25000000000000000000000000"` (25M) | `"340282366920938463463374607431768211455"` | A stranger who supplied and borrowed 25M would stop every client's borrow |
| nBTC `supplied_limit` | `"20000000000000000000"` (20) | `"340282366920938463463374607431768211455"` | This is the cap on collateral. One stranger could fill 20 nBTC and lock our clients out. 25 nBTC went in, in the sandbox |
| nBTC `can_borrow` | `true` | `false` | No client of ours borrows nBTC. With it on, a stranger with faucet USDC could borrow the clients' collateral away, and their withdrawals would fail until it came back. Run: a stranger with $200,000 of USDC posted asks for 1 nBTC and gets `Thi asset can't be used borrowed` (Rhea's own spelling), and the client then takes all its nBTC out |
| both, `beneficiaries` | `{"pf.rhealab.near": 10000}` | `{}` | The reserve share of interest stays in `reserved` |

The new figure is the largest Rhea can hold (u128's maximum), which Rhea's own source and tests use for "no limit". The reasons are read from the source (`actions.rs`, `actions_only.rs`); what ran is the listing itself, the 25 nBTC and the refused nBTC borrow. nBTC's `borrowed_limit` stays at mainnet's 4; it no longer matters, since nBTC can't be borrowed.

| Field | USDC (6 decimals) | nBTC (8 decimals) |
|---|---|---|
| `volatility_ratio` | 9500 | 8000 |
| `extra_decimals` | 12 | 10 |
| `target_utilization_rate` | `"1000000000001847694955734069"` | `"1000000000001547125956667610"` |
| `max_utilization_rate` | `"1000000000012857214234867166"` | `"1000000000039724853136740579"` |
| `net_tvl_multiplier` | 10000 | 0 |
| `supplied_limit`, `borrowed_limit` | the table above | the table above; `borrowed_limit` is `"4000000000000000000"` (4) |
| `can_borrow` | `true` | `false` |
| Both | `"reserve_ratio": 2500, "beneficiaries": {}, "target_utilization": 8000, "holding_position_fee_rate": "1000000000000000000000000000", "can_deposit": true, "can_withdraw": true, "can_use_as_collateral": true, "max_change_rate": null, "min_borrowed_amount": "1000000000"` | |

**The fixed prices.** `price_identifier` is mainnet's Pyth feed id; Rhea wants one but never asks for it while `default_price` is set. One whole token is worth `multiplier / 10^(decimals − token decimals)` dollars, so nBTC's multiplier is its price in cents.

```json
{"token_id": "<usdc>", "token_pyth_info": {"decimals": 6, "fraction_digits": 4,
  "price_identifier": "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  "extra_call": null, "default_price": {"multiplier": "10000", "decimals": 10}}}
{"token_id": "<nbtc>", "token_pyth_info": {"decimals": 8, "fraction_digits": 2,
  "price_identifier": "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "extra_call": null, "default_price": {"multiplier": "7500000", "decimals": 10}}}
```

**Changing BTC's price** (the keeper's call, signed with the owner's key): `update_token_pyth_info` with the same shape as the nBTC line above and the new multiplier, 1 yoctoNEAR. It replaces the whole setting, so all five fields go every time. It burnt 2.7 TGas and returns nothing. The next view already shows the new price. Anyone else gets `Not an owner`; without the yoctoNEAR, `Requires attached deposit of exactly 1 yoctoNEAR`.

### A client's calls

Amounts in `ft_transfer_call` are in the token's own units. Amounts inside actions are inner units: USDC units × 10^12, nBTC units × 10^10. Gas is what the whole call burnt with 300 TGas attached; "at Rhea" is Rhea's own receipt.

| Step | Call | Deposit | Returns | Gas burnt |
|---|---|---|---|---|
| Register, once | `storage_deposit({"account_id": "<who>", "registration_only": true})` | 0.1 NEAR | `{"total":"100000000000000000000000","available":"0"}` | 3.8 TGas |
| Supply to lend | `<usdc>.ft_transfer_call({"receiver_id": "<copy>", "amount": "200000000000", "msg": ""})` | 1 yoctoNEAR | `"200000000000"` (all of it was taken) | 9.0–9.2 TGas, 4.5–4.7 at Rhea |
| Post collateral | `<nbtc>.ft_transfer_call({"receiver_id": "<copy>", "amount": "100000000", "msg": "\"OnlyIncreaseCollateral\""})` | 1 yoctoNEAR | `"100000000"` | 9.3–9.4 TGas, 4.8–4.9 at Rhea |
| Borrow and take it out | `execute_with_pyth({"actions": [{"Borrow": {"token_id": "<usdc>", "amount": "<inner>"}}, {"Withdraw": {"token_id": "<usdc>", "max_amount": "<inner>"}}]})` | 1 yoctoNEAR | nothing | 11.9–12.1 TGas: 7.0–7.2 at Rhea, 1.7 the token's transfer, 2.4 Rhea's `after_ft_transfer` |
| Repay | `<usdc>.ft_transfer_call({"receiver_id": "<copy>", "amount": "<units>", "msg": "\"OnlyRepay\""})` | 1 yoctoNEAR | the amount sent | 9.5–9.6 TGas, 5.0–5.1 at Rhea |
| Take some collateral back | `execute_with_pyth({"actions": [{"DecreaseCollateral": {"token_id": "<nbtc>", "amount": "<inner>"}}, {"Withdraw": {"token_id": "<nbtc>", "max_amount": "<inner>"}}]})` | 1 yoctoNEAR | nothing | 11.6 TGas, 6.8 at Rhea |
| Leave with everything | `execute_with_pyth({"actions": [{"DecreaseCollateral": {"token_id": "<nbtc>"}}, {"Withdraw": {"token_id": "<nbtc>"}}, {"Withdraw": {"token_id": "<usdc>"}}]})` | 1 yoctoNEAR | nothing | 17.2–17.3 TGas, 8.0–8.1 at Rhea |
| Take a plain deposit out | `execute({"actions": [{"Withdraw": {"token_id": "<token>"}}]})` | 1 yoctoNEAR | nothing | 10.3–10.4 TGas |
| Liquidate | `execute_with_pyth({"actions": [{"Liquidate": {"account_id": "<borrower>", "in_assets": [{"token_id": "<usdc>", "amount": "<inner>"}], "out_assets": [{"token_id": "<nbtc>", "amount": "<inner>"}]}}]})` | 1 yoctoNEAR | nothing | 7.9–8.0 TGas, one receipt |

- **An action with no `amount` and no `max_amount` takes everything** of that token.
- **A repayment beyond the debt** clears the debt and leaves the rest as the payer's deposit (`supplied`). The debt grows every millisecond, so to clear it send a little more and take the rest out with the last call.
- **The borrower must be registered on USDC** before it borrows (0.00125 NEAR on our token), and the liquidator on nBTC before it withdraws.
- **Gas to attach to a borrow:** 30 TGas was enough and 25 was not. Rhea reserves 10 TGas for the token's transfer and 10 for its own callback on top of the 7 it burns. With too little, Rhea's receipt fails with `Exceeded the prepaid gas` and nothing changes. FUNDING.md's 150 TGas is plenty.
- **Blocks.** With the transaction in block N: Rhea runs in N+1, the USDC is in the borrower's token balance in N+2, and Rhea's own callback runs in N+3. A call from our account contract adds one block in front (not run here). Collateral and repayments go token (N+1), Rhea (N+2), the token's closing step (N+3); Rhea's views show them from N+2.
- **Events.** Rhea logs `EVENT_JSON:{"data":[{"account_id":"…","amount":"<inner>","position":"REGULAR","token_id":"…"}],"event":"borrow","standard":"burrow","version":"1.0.0"}`. Seen: `deposit`, `increase_collateral`, `decrease_collateral`, `borrow`, `repay`, `withdraw_started`, `withdraw_succeeded`, `withdraw_failed`, `liquidate`, `fee_detail`.

### The views, and the health factor

- `get_config({})`: the 19 fields above.
- `get_assets({"token_ids": [...]})`: for each token `supplied` and `borrowed` (`{"shares", "balance"}`, inner units), `reserved`, `config`, `borrow_apr`, `supply_apr`, `last_update_timestamp`.
- `get_token_pyth_info({"token_id"})`: the price setting above. `default_price.multiplier` is the price.
- `get_account({"account_id"})`: `supplied`, `collateral` and `borrowed`, each a list of `{"token_id", "balance", "shares", "apr"}` in inner units. It answers `null` for an account that never registered.
- **There is no health-factor view.** The tests work it out from those three views (`health_bp_of` in the helper): each collateral's dollar value × its ratio ÷ 10000, over each debt's dollar value × 10000 ÷ its ratio. A value is `balance × multiplier ÷ 10^(price decimals + extra_decimals)`.
- **Measured:** 1 nBTC against $40,000 gives 1.4250 at $75,000 (1.4249 once a few seconds of interest are in), 1.1399 at $60,000 and 0.9499 at $50,000.
- **Saved for the engine's reader:** `research/data/rhea_copy_views.json` holds the raw answers of all four views, each set read at one block, under the testnet names (`rhea.pbf-ops.testnet`, `musdc.pbf-ops.testnet`, `mnbtc.pbf-ops.testnet`, borrower `demo.pbf.testnet`, owner `pbf-ops.testnet`). It has three sets:
  - `before`: 1 nBTC against $40,000 at BTC $75,000, health 14249, at about 0.3% a year;
  - `after`: the same at BTC $50,000, health 9499;
  - `with_mainnets_rate`: after the rate step, with 0.8975 nBTC against about $100 at BTC $75,000. 85.16% is lent out; `borrow_apr` is `0.1593…` and `supply_apr` `0.1017…`.
  - Remake it with `RHEA_VIEWS_OUT=<file> cargo test -p pb-sandbox-tests --test rhea`.

### What a caller sees when a loan can't go through

| Case | The call reports | Receipts that fail | Rhea's views afterwards |
|---|---|---|---|
| Asks for too much ($57,001 on 1 nBTC at $75,000), fixed prices | **Failure**, 7 TGas burnt | Rhea's only receipt: `assertion failed: self.compute_max_discount(&position, account, &prices) == BigDecimal::zero()` | No debt, nothing lent, collateral untouched |
| Same, but a token has no fixed price (mainnet's path) | **Success** | The oracle call (`AccountDoesNotExist` here), then Rhea's callback: `<feed id> cross call failed!` | No debt, nothing lent |
| The borrower isn't registered on USDC | **Success** | The token's transfer: `The account <id> is not registered` | A debt, and the same amount as the borrower's deposit (`supplied`). Rhea logged `withdraw_failed`. `execute` with `Withdraw` sends it out later |
| `Withdraw` with an exact `amount` after interest has accrued | **Failure** | Rhea's only receipt: `Not enough asset balance` | Nothing changed |
| More than Rhea has free | **Failure** | `Borrow error: Exceeded available amount` | Nothing changed |

So on our copy a refused borrow fails the call itself, and a calling contract's callback gets a failed result. That is kinder than mainnet. The rule for the account contract stays the same: only the views and the token balance say what happened. `get_account(...).borrowed` is the debt, and `<usdc>.ft_balance_of` says whether the money arrived.

### What differs from the notes above

- **Item 2, "detached callback".** True on mainnet, and on our copy only if a token involved has no `default_price`. With fixed prices there is no oracle call and no callback. The transfer after a `Withdraw` is still a separate step that the call doesn't wait for.
- **Item 2, `Withdraw`.** Use `max_amount`, as written there. With `amount`, a borrow-and-withdraw fails once the token has earned any interest, because the withdrawal then needs one share more than the borrow added. With `max_amount` the borrower can receive one millionth of a dollar less than it borrowed: a $1,000 borrow delivered 999,999,999 units.
- **Item 6, `new`.** 0.15.7 takes 19 config fields, not 21.
- **Item 6, the fixed price.** Confirmed: `default_price`, changed with `update_token_pyth_info`, moves the health factor at once. Only the owner can call it.
- **Item 8, gas.** A borrow with a withdrawal burns 12 TGas here, against 43–64 on mainnet, since there are no oracle calls and no price callback.
- **Item 3, no buffer.** Confirmed: $57,000 against 1 nBTC at $75,000 is lent (75,000 × 0.80 × 0.95), and the health factor reads 0.9999 a block later.
- **`min_borrowed_amount`** is stored but never checked in this version's source (read, not run).

### Rates

The copy has mainnet's curve, so its rate follows how much of its USDC is lent out. With $1,000,000 supplied and nothing borrowed, `borrow_apr` is `"0.0"`, and a small demo loan would pay close to nothing. So the setup ends with the rate step (decided 11 Nov): the owner turns its deposit into collateral, which stays lendable, and borrows $851,500 of it. That puts 85.15% out on loan, the share mainnet had on 10 Nov.

Measured afterwards:

| | |
|---|---|
| Borrow rate | 15.91% a year (mainnet's figure on 10 Nov) |
| Deposit rate | 10.16% a year: 15.91% × 0.8515 × 0.75, since Rhea keeps a quarter of the interest in reserve |
| Left for clients | $148,500 of the $1,000,000. Asking for more gets `Borrow error: Exceeded available amount` |
| A client's $10,000 on top (86.15% lent out) | 17.94%, from the loan's first second |
| The owner's own loan | Health factor 1.06 (950,000 ÷ 896,316). Both sides are USDC, so no BTC price moves it |

- **Clients move the rate.** Above 80% lent out the curve is steep: a client's $10,000 added two points. At demo size ($500) that is about a tenth of a point (worked out; with $100 on top the reading was 15.93%).
- **The owner's loan drifts.** Its debt grows at 15.91% and its collateral at 10.16%, so its health factor falls to about 1.01 after a year (worked out from the rates, not run). Repaying a little resets it.
- **The owner holds the $851,500 it borrowed** in its own token balance.
- In the sandbox this step is `Rhea::charge_mainnets_rate`. `Rhea::stand_up` alone leaves the copy at about 0%, as before.

### Liquidation

With the borrower at 0.9499, a stranger holding a USDC deposit at Rhea repaid $5,000 and took 0.1025 nBTC ($5,125 at $50,000) in one call. The discount is half the shortfall: (1 − 0.95) ÷ 2 = 2.5%. Afterwards the borrower owed $5,000 less, had 0.8975 nBTC and stood at 0.974; the nBTC sat in the liquidator's `supplied` until it withdrew it with `execute`. Refusals, word for word:

- a healthy loan: `The liquidation account is not at risk`;
- taking more than the discount allows (0.103 nBTC for $5,000): `Not enough balances repaid`;
- repaying so much that the loan would be healthy again ($10,000): `The liquidation amount is too large`;
- the borrower itself: `Can't liquidate yourself`.

### On testnet

`scripts/rhea-setup.sh` is a draft of the same setup with the near CLI, for `rhea.pbf-ops.testnet`. It has not been run. A test checks that its JSON is the JSON above.

- **NEAR:** the copy's account needs 11 NEAR. The file locks 10.18 of them (1,017,727 bytes after setup, at 10^19 yoctoNEAR a byte), the deploy burns under 0.01, and the sandbox copy held 11.09 after setup. Each user's 0.1 NEAR pays for its own storage. The operator spends about 11.15 NEAR in all.
- **The owner is `pbf-ops.testnet`** and stays so (decided 11 Nov). The keeper will change BTC's price with the operator's key. `set_owner_id({"owner_id"})` exists and worked in an earlier sandbox run, with the new owner registered first; the setup doesn't use it.
- **What a stranger can still do with faucet tokens** (read from the source, not run):
  - supply a great deal of USDC, which pushes the rate down;
  - borrow the USDC that is free, against faucet nBTC, which pushes the rate up and leaves none for clients;
  - It can no longer borrow the clients' nBTC: `can_borrow` is false for nBTC (this one was run; see the table of fields above).
  - No cap is truly out of reach while the faucet has none: the figure above is only the largest Rhea can hold.
