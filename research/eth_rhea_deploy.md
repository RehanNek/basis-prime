# Test ETH on our Rhea copy: the deploy sitting (written 14 Nov; RUN 14 Nov, 09:58 to 10:16 UTC, see "As run" at the end)

NEAR testnet only. Nothing touches a mainnet. No contract code changes and nothing is published. What is sent:
one registration on the test ETH token, two owner's calls on our Rhea copy (`rhea.pbf-ops.testnet`), and one
`set_config` on the factory. Four keychain approvals, all with `pbf-ops.testnet`'s key. It reaches accounts made
after the `set_config`; accounts made before keep bitcoin as their only Rhea collateral.

## Read this first

- **The order matters: the copy first (steps 1 to 3), the factory last (step 5).** The engine reads Rhea's listing
  and price setting for every token in an account's Rhea collateral list on every check (`get_assets` and
  `get_token_pyth_info`, `risk/pb-read/src/read.rs:197` to `:200`), and a lender that can't be read is no verdict. If
  the factory named test ETH before the copy lists and prices it, every check on a new account would fail.
- **The keeper must be the build that keeps ETH's price in step before step 5** (step 4). The copy's price is a
  fixed number. The keeper of before sets bitcoin's only, so ETH's would stay where step 3 puts it while the market
  moves, and the engine's cushion for every ETH loan at Rhea would be measured at a stale price.
- **The price in step 3 is ETH's of that minute**, not the example's. One line below reads it and prints the
  number to send.

**For you to decide:**
1. **The cap on ETH supplied is lifted,** as bitcoin's was: mainnet caps ETH at 200, and anyone can mint test ETH
   and fill that. If you would rather keep mainnet's cap, send `"supplied_limit":"200000000000000000000"` in step 2.
2. **Step 5 waits for the engine's proof (51.1) and for the keeper's build.** If either isn't there, steps 1 to 3
   can still run: a listing no account names does nothing.

## 0. Before (no approvals). Read on 14 Nov, 09:53 to 09:57 UTC

1. **Our copy:** `rhea.pbf-ops.testnet` answers version `0.15.7`; its owner is `pbf-ops.testnet` (`get_config`,
   block 277,641,006); it lists two assets, `musdc.pbf-ops.testnet` and `mnbtc.pbf-ops.testnet`, of the 20 its
   config allows (`get_assets_paged`). It holds 12.09 NEAR with 1,025,923 bytes of storage, so 1.83 is free: a
   third asset's record fits.
2. **Test ETH isn't there yet:** on the copy, `get_asset` and `get_token_pyth_info` for `meth.pbf-ops.testnet`
   answer null; on the token, `storage_balance_of` for the copy answers null. Check again:
   `near contract call-function as-read-only rhea.pbf-ops.testnet get_asset json-args '{"token_id":"meth.pbf-ops.testnet"}' network-config testnet now`
3. **The token:** `meth.pbf-ops.testnet` answers `ft_metadata` with 18 decimals, and its registration costs
   0.00125 NEAR (`storage_balance_bounds`).
4. **The pattern, our copy's bitcoin** (`get_asset` and `get_token_pyth_info` for `mnbtc.pbf-ops.testnet`, block
   277,641,007). It is real Rhea's bitcoin (`contract.main.burrow.near`, `nbtc.bridge.near`, read the same minute)
   with exactly three things changed: no fee beneficiary (`{}` for `pf.rhealab.near`), `can_borrow` false, and
   `supplied_limit` lifted from 20 bitcoin to the largest number Rhea holds. Its price setting:
   `{"decimals":8,"fraction_digits":2,"price_identifier":"e62df6c8…415b43","extra_call":null,"default_price":{"multiplier":"6746900","decimals":10}}`:
   $67,469.00, against Hyperliquid testnet's oracle price of $67,452.00 at 09:54 (0.03% apart: the keeper's work).
5. **Real Rhea's ETH** (`contract.main.burrow.near`, mainnet block 224,497,604):
   - `get_asset {"token_id":"eth.bridge.near"}`, its `config`: `reserve_ratio` 2500, `beneficiaries`
     `{"pf.rhealab.near":10000}`, `target_utilization` 8000, `target_utilization_rate`
     `1000000000001547125956667610`, `max_utilization_rate` `1000000000039724853136740579`,
     `holding_position_fee_rate` `1000000000000000000000000000`, **`volatility_ratio` 7500**,
     **`extra_decimals` 0**, `can_deposit`, `can_withdraw`, `can_use_as_collateral` and `can_borrow` all true,
     `net_tvl_multiplier` 0, `max_change_rate` null, `supplied_limit` `200000000000000000000` (200 ETH),
     `borrowed_limit` `40000000000000000000` (40 ETH), `min_borrowed_amount` `1000000000`.
   - `get_token_pyth_info {"token_id":"eth.bridge.near"}`:
     `{"decimals":18,"fraction_digits":2,"price_identifier":"ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace","extra_call":null,"default_price":null}`.
     That id is also ETH's `pyth_id` in `research/data/universe_v0.json`.
6. **NEAR:** `pbf-ops.testnet` holds 2.60 (block 277,641,176). The sitting takes 0.00125 and the gas of four
   calls, under 0.01 in all.
7. **The factory** has 27 accounts; its config is the "before" of step 5.

## 1. Register the copy on test ETH (`meth.pbf-ops.testnet`). Keychain

Without it the token refuses to send ETH to the copy. The form is `scripts/rhea-setup.sh`'s step 3.

`near contract call-function as-transaction meth.pbf-ops.testnet storage_deposit json-args '{"account_id":"rhea.pbf-ops.testnet","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as pbf-ops.testnet network-config testnet sign-with-keychain send`

Check: `near contract call-function as-read-only meth.pbf-ops.testnet storage_balance_of json-args '{"account_id":"rhea.pbf-ops.testnet"}' network-config testnet now`
answers `{"total":"1250000000000000000000","available":"0"}`.

## 2. List test ETH (`add_asset`, the owner's, 1 yoctoNEAR). Keychain

Real Rhea's ETH settings of step 0.5, with the same three changes bitcoin got and nothing else:

| Field | Real Rhea | Our copy | Why |
|---|---|---|---|
| `beneficiaries` | `{"pf.rhealab.near":10000}` | `{}` | That account isn't on testnet |
| `can_borrow` | true | **false** | No client of ours borrows ETH, and a stranger with faucet USDC could otherwise borrow the clients' collateral away and block their withdrawals |
| `supplied_limit` | 200 ETH | lifted (`340282366920938463463374607431768211455`) | Anyone can mint test ETH and fill the cap. What is supplied is the cap on collateral |

`borrowed_limit` stays mainnet's 40 ETH, as bitcoin kept its 4; with `can_borrow` false it is never reached.
`volatility_ratio` 7500 is the 75% the engine reads. **`extra_decimals` must be 0:** the account contract writes
Rhea's amounts as the token's units times 10^(18 − its decimals) (`contracts/account/src/lender.rs:112`), which
for 18 decimals is the units themselves.

`near contract call-function as-transaction rhea.pbf-ops.testnet add_asset json-args '{"token_id":"meth.pbf-ops.testnet","asset_config":{"reserve_ratio":2500,"beneficiaries":{},"target_utilization":8000,"target_utilization_rate":"1000000000001547125956667610","max_utilization_rate":"1000000000039724853136740579","holding_position_fee_rate":"1000000000000000000000000000","volatility_ratio":7500,"extra_decimals":0,"can_deposit":true,"can_withdraw":true,"can_use_as_collateral":true,"can_borrow":false,"net_tvl_multiplier":0,"max_change_rate":null,"supplied_limit":"340282366920938463463374607431768211455","borrowed_limit":"40000000000000000000","min_borrowed_amount":"1000000000"}}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as pbf-ops.testnet network-config testnet sign-with-keychain send`

Check: `near contract call-function as-read-only rhea.pbf-ops.testnet get_asset json-args '{"token_id":"meth.pbf-ops.testnet"}' network-config testnet now`
answers a `config` with every field as sent (`volatility_ratio` 7500, `extra_decimals` 0, `can_borrow` false), and
`supplied` and `borrowed` at 0.

## 3. ETH's fixed price (`add_token_pyth_info`, the owner's, 1 yoctoNEAR). Keychain

**The form is bitcoin's, for 18 decimals.** Rhea's price says what one of the token's smallest units is worth:
`multiplier / 10^decimals` dollars. Real Rhea builds it from the feed as the dollar price times
10^`fraction_digits`, with `decimals` = the token's decimals + `fraction_digits`. So with `fraction_digits` 2 the
multiplier is the price of one whole token in cents (`research/rhea.md`, "The fixed prices"):

| | Token's decimals | `fraction_digits` | `default_price.decimals` | `multiplier` |
|---|---|---|---|---|
| Bitcoin, live | 8 | 2 | 8 + 2 = **10** | 6746900, which is $67,469.00 |
| ETH | 18 | 2 | 18 + 2 = **20** | the price in cents |

**The arithmetic with the price of 14 Nov, 09:54 UTC.** Hyperliquid testnet's oracle said ETH $1,915.26 (1Click's
list said $1,912.02 the same minute). The keeper keeps the copy at Hyperliquid's oracle, which is what the engine
counts the coin at, so that is the price to start from:

- multiplier = 1,915.26 × 100 = **191526**;
- one wei is worth 191526 / 10^20 dollars;
- one whole ETH, 10^18 wei, is worth 191526 × 10^18 / 10^20 = 191526 / 100 = **$1,915.26**.

**Read the price of the minute and print the multiplier** (a public read; nothing signed):

`curl -s https://api.hyperliquid-testnet.xyz/info -H 'Content-Type: application/json' -d '{"type":"metaAndAssetCtxs"}' | python3 -c 'import sys,json; m,c=json.load(sys.stdin); px=[x["oraclePx"] for u,x in zip(m["universe"],c) if u["name"]=="ETH"][0]; print("ETH oracle", px, "-> multiplier", round(float(px)*100))'`

Then send it, with that number in place of `191526`:

`near contract call-function as-transaction rhea.pbf-ops.testnet add_token_pyth_info json-args '{"token_id":"meth.pbf-ops.testnet","token_pyth_info":{"decimals":18,"fraction_digits":2,"price_identifier":"ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace","extra_call":null,"default_price":{"multiplier":"191526","decimals":20}}}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as pbf-ops.testnet network-config testnet sign-with-keychain send`

`price_identifier` is real Rhea's Pyth id for ETH (step 0.5). Rhea wants one, and never asks the feed while
`default_price` is set.

Check: `near contract call-function as-read-only rhea.pbf-ops.testnet get_token_pyth_info json-args '{"token_id":"meth.pbf-ops.testnet"}' network-config testnet now`
answers the five fields as sent: `decimals` 18, `fraction_digits` 2, the id, `extra_call` null, and
`default_price` with `decimals` 20 and the multiplier. Divide the multiplier by 100: it must be ETH's dollar price.

If the number sent was wrong, or the market has moved before the keeper takes over, set it again. This is the
keeper's own call (`services/keeper/src/rhea-price.ts`, `rheaPriceCall`); it replaces the whole setting, so all five
fields go every time:

`near contract call-function as-transaction rhea.pbf-ops.testnet update_token_pyth_info json-args '{"token_id":"meth.pbf-ops.testnet","token_pyth_info":{"decimals":18,"fraction_digits":2,"price_identifier":"ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace","extra_call":null,"default_price":{"multiplier":"191526","decimals":20}}}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as pbf-ops.testnet network-config testnet sign-with-keychain send`

## 4. The keeper, before the factory

The keeper that keeps every Rhea collateral token's price in step (section 51.1; helper K's build) is built and
started from `.claude/launch.json`. Its log must show a price line for test ETH within its first ticks, and
`get_token_pyth_info` for `meth.pbf-ops.testnet` must then stay within 0.25% of Hyperliquid's ETH oracle price.
It finds what to keep in step from the factory's Rhea collateral list, so ask helper K whether it prices ETH
before step 5 names it; if it only starts after step 5, do step 3 and step 5 close together and watch the first
price line.

## 5. The factory's settings (`pbf.testnet`). Keychain

Only after steps 1 to 3 are checked. `set_config` replaces the whole config, so it is sent whole, with one change.

1. Read the live config and compare it with "before" below:
   `near contract call-function as-read-only pbf.testnet get_config json-args '{}' network-config testnet now`
   **If anything but `lenders.rhea.collateral` differs from "before"** (a pinned version changed since 09:53 UTC,
   as it would if the engine is published again), don't send the line below: take the config just read and
   replace only that list.

**`lenders.rhea.collateral`, before:** `["mnbtc.pbf-ops.testnet"]`

**After:** `["mnbtc.pbf-ops.testnet","meth.pbf-ops.testnet"]`

The factory's own rules pass it (`contracts/types/src/lib.rs:246`): 1 to 4 tokens, each a listed token other than
USDC, none twice, at most 18 decimals. Test ETH is listed, with 18.

2. Send it (the live config of 14 Nov, 09:53 UTC, block 277,641,012, with the list above; one line):

`near contract call-function as-transaction pbf.testnet set_config json-args '{"config":{"tokens":[{"id":"musdc.pbf-ops.testnet","symbol":"USDC","decimals":6},{"id":"mnbtc.pbf-ops.testnet","symbol":"nBTC","decimals":8},{"id":"meth.pbf-ops.testnet","symbol":"ETH","decimals":18},{"id":"mwnear.pbf-ops.testnet","symbol":"wNEAR","decimals":24},{"id":"musdt.pbf-ops.testnet","symbol":"USDT","decimals":6}],"pool_id":"pool.pbf.testnet","mpc_id":"v1.signer-prod.testnet","outlayer_id":"outlayer.testnet","risk":{"project_id":"pbf-keeper.testnet/pb-risk","version_key":"9149e09b785f4fdea40b01110120a2eca49e907ad11b70d7e144abdd423e0d45"},"hl_chain":"Testnet","signature_chain_id":"0x66eee","usdc_token":"musdc.pbf-ops.testnet","params_hash":"3d362b434adaad0e0c909605bd792232acf964b9143a95ccb2541a0f65c4c263","model":"B-0.2","drill_id":"drill.pbf-ops.testnet","gateway":{"project_id":"pbf-keeper.testnet/pb-gateway","version_key":"e3b3ce6f02797301d299d18df6353b065a56581a2362286204cc2b135a933638","secrets_ref":null},"hl_usdc_token":"USDC:0xeb62eee3685fc4c43992febcd9e75443","lenders":{"rhea":{"contract_id":"rhea.pbf-ops.testnet","collateral":["mnbtc.pbf-ops.testnet","meth.pbf-ops.testnet"]},"aave":{"chain_id":84532,"pool":"0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27","usdc":{"symbol":"USDC","address":"0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f","decimals":6},"collateral":[{"symbol":"WBTC","address":"0x54114591963CF60EF3aA63bEfD6eC263D98145a4","decimals":8},{"symbol":"WETH","address":"0x4200000000000000000000000000000000000006","decimals":18}],"max_fee_per_gas":"1000000000"}}}}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as pbf-ops.testnet network-config testnet sign-with-keychain send`

3. Check: `get_config` answers the two tokens under `lenders.rhea.collateral` and nothing else changed;
   `account_code_hash`, `accounts_count` (27), `is_paused` and `list_accounts` answer what they answered before.

## 6. What an account or the pool needs besides: nothing new

- **The pool.** ETH's step price is set: `step_price` for `meth.pbf-ops.testnet` answers
  `{"decimals":18,"price":"2300000000"}` ($2,300, above today's $1,915; block 277,641,012). A top-up that posts more
  ETH at Rhea asks the pool's `check_step` first, which counts it at that price. Its caps for ETH are there since
  the first deploy (`research/spot_tokens_deploy.md`, step 4). If ETH rises toward $2,300, set the step price
  higher.
- **An account** made after step 5 needs nothing per token. It registers with the copy once, with 0.1 NEAR, in
  its own first Rhea step, whatever it posts. The factory has registered it on test ETH already.
- **Accounts made before step 5** keep `["mnbtc.pbf-ops.testnet"]`: they can't post ETH at Rhea.
- **Every new account's check reads ETH at Rhea** from step 5 on, whether it holds ETH or not: one more token in
  `get_assets` and one more `get_token_pyth_info`. So the copy's ETH listing must stay as long as any account
  names it.
- **The engine and the keeper** are the other helpers': the engine's proof that its Rhea side handles ETH (51.1),
  and the keeper's price sync (step 4).

## 7. After, and the proof

- Read only: the copy's `get_asset` and `get_token_pyth_info` for test ETH (steps 2 and 3), the factory's
  `get_config` (step 5), and `GET /api/lenders` on the backend, which should show Rhea taking ETH at 75%.
- The proof is gate 2 with `--coin ETH` on a new account (section 51.1).

## 8. If something fails, and going back

- **Steps 1 to 3 change nothing an account sees.** Until step 5 no account names test ETH at Rhea. A wrong price
  is set again with `update_token_pyth_info` (step 3). Rhea's file carries an "Already exist" refusal for a price
  setting added twice; a second `add_asset` wasn't tried. If a step's check doesn't show what was sent, stop and
  read the chain before sending anything again.
- **Step 5, going back:** `set_config` with the config of before, below. The copy's ETH listing can stay: with no
  account naming it, nothing reads it. Accounts made in between keep ETH in their list, and keep working as long
  as the listing and its price stay.

`near contract call-function as-transaction pbf.testnet set_config json-args '{"config":{"tokens":[{"id":"musdc.pbf-ops.testnet","symbol":"USDC","decimals":6},{"id":"mnbtc.pbf-ops.testnet","symbol":"nBTC","decimals":8},{"id":"meth.pbf-ops.testnet","symbol":"ETH","decimals":18},{"id":"mwnear.pbf-ops.testnet","symbol":"wNEAR","decimals":24},{"id":"musdt.pbf-ops.testnet","symbol":"USDT","decimals":6}],"pool_id":"pool.pbf.testnet","mpc_id":"v1.signer-prod.testnet","outlayer_id":"outlayer.testnet","risk":{"project_id":"pbf-keeper.testnet/pb-risk","version_key":"9149e09b785f4fdea40b01110120a2eca49e907ad11b70d7e144abdd423e0d45"},"hl_chain":"Testnet","signature_chain_id":"0x66eee","usdc_token":"musdc.pbf-ops.testnet","params_hash":"3d362b434adaad0e0c909605bd792232acf964b9143a95ccb2541a0f65c4c263","model":"B-0.2","drill_id":"drill.pbf-ops.testnet","gateway":{"project_id":"pbf-keeper.testnet/pb-gateway","version_key":"e3b3ce6f02797301d299d18df6353b065a56581a2362286204cc2b135a933638","secrets_ref":null},"hl_usdc_token":"USDC:0xeb62eee3685fc4c43992febcd9e75443","lenders":{"rhea":{"contract_id":"rhea.pbf-ops.testnet","collateral":["mnbtc.pbf-ops.testnet"]},"aave":{"chain_id":84532,"pool":"0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27","usdc":{"symbol":"USDC","address":"0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f","decimals":6},"collateral":[{"symbol":"WBTC","address":"0x54114591963CF60EF3aA63bEfD6eC263D98145a4","decimals":8},{"symbol":"WETH","address":"0x4200000000000000000000000000000000000006","decimals":18}],"max_fee_per_gas":"1000000000"}}}}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as pbf-ops.testnet network-config testnet sign-with-keychain send`

## 9. How this was checked

- The call forms are `scripts/rhea-setup.sh`'s (`storage_deposit` on a token for the copy, `add_asset`,
  `add_token_pyth_info`, each owner's call with 1 yoctoNEAR and 30 TGas), which listed bitcoin on this copy.
  `update_token_pyth_info` is the keeper's call, proved in the sandbox (`research/rhea.md`, "Changing BTC's price").
- The `add_asset` body was made by a script from real Rhea's ETH config as read, with the three changes; the
  script checked that those three are also the only differences between our copy's bitcoin and real Rhea's.
- Both `set_config` lines were made by a script from the config read at 09:53 UTC, which checked that
  `lenders.rhea.collateral` is the only thing that differs between them.
- **Not checked by a run:** `add_asset` with `extra_decimals` 0. Bitcoin and USDC went in with 10 and 12. Real
  Rhea (version 0.16.2; our copy is its 0.15.7) runs ETH with 0, so the setting is one the code knows; the check
  after step 2 shows it took.
- Nothing in this file was run. Every figure marked "read" came from a view of NEAR testnet's or mainnet's public
  RPC, Hyperliquid testnet's public `info`, or 1Click's public token list.

## 10. As run (the main session, 14 Nov)

All on NEAR testnet, signed by `pbf-ops.testnet` from the keychain.

- **Steps 1 to 3, 09:58 to 09:59 UTC.** The registration (`EmuivVV1…`), `add_asset` (`CzuU9ocZ…`) and
  `add_token_pyth_info` (`D1F45Ku7…`, multiplier 191311: $1,913.11, decimals 20). Read back at 10:15: the listing
  shows `volatility_ratio` 7500, `extra_decimals` 0, collateral yes, borrow no, nothing supplied; the price setting
  as sent.
- **Step 4, 10:14:46 UTC.** The keeper started on the build that keeps every Rhea collateral token's price
  (keeper suite 270 passed, my own run). With the factory still listing bitcoin alone it kept bitcoin as before:
  it set $67,250.00 at 10:15:08 (`Gbc2ugMJDLH84DYmPWySdTVyJbJ4HMUFLeD3vtZ69KFF`).
- **Step 5, 10:15:45 to 10:15:50 UTC.** The live config was read first (block 277,643,251) and was the "before" of
  step 5 to the letter; the args sent were that config with the one list changed, and equal to step 5's line.
  `set_config`: `86SxTFnVLpRtZ5vUz8gLMQg2BpX9CBX7x5R94nL3RSSz`. Read back at block 277,643,322:
  `lenders.rhea.collateral` is `["mnbtc.pbf-ops.testnet","meth.pbf-ops.testnet"]`, nothing else changed;
  `account_code_hash` `48497d26…`, 27 accounts, not paused.
- **The keeper again, 10:16:08 UTC,** so that it read the new list at once. Its first ETH line, 10:16:13: "set our
  Rhea copy's ETH price to $1,908.30: it was $1,913.11, 0.25% from Hyperliquid's oracle price"
  (`39vCRHBK144jhpJ6QRsDCt5kWm2MHqXP4f9Zz9mTUr1V`). From then on each tick's line carries `eth_oracle` and
  `rhea_eth` beside bitcoin's.
- **So:** accounts made from 14 Nov, 10:15:50 UTC can post test ETH at Rhea. Older accounts can't.
- **The way back** is section 8's line (the config of before).

