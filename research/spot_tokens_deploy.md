# Three more test tokens for the Spot page: the deploy sitting (written 13 Nov, 19:30 UTC; NOT RUN)

NEAR testnet only. Nothing touches a mainnet. No contract code changes, no engine build, nothing published on
OutLayer. What is sent: three new token accounts under `pbf-ops.testnet` running the file `musdc` and `mnbtc`
already run, three operator calls on the pool, and one `set_config` on the factory. It reaches accounts made after
the `set_config`; accounts made before keep their two tokens.

## Read this first

**Does a check fail for an account that merely lists the three new tokens and holds none of them? No.** Read in
the engine and the pool, not run. One condition, and it decides the order of this sitting:

- **Every token id in the settings must be a deployed token before `set_config`.** The engine reads
  `ft_balance_of` on every listed token on every check, and a read that fails ends the run with no verdict
  (`risk/pb-read/src/read.rs:518`: "cannot read the ETH balance…"). So: tokens first (steps 1 to 3), `set_config`
  last (step 5), and never delete a token account while any account lists it.

With zero balances nothing else changes in a check: three more NEAR views, no extra price read, the same verdict
(`risk/pb-read/src/book.rs:26` prices only coins held; `risk/pb-risk/src/verdict.rs:560` skips empty tokens).

**What an account sees once it holds them** (limits, not failures; details in section 6):

| Token | Counts at | Why |
|---|---|---|
| wNEAR | 100% of NEAR's price | Not a bridged token for the engine: no ratio is read |
| ETH | Aave's test price for WETH over the engine's ETH price, at most 100% | The live settings list WETH at Aave, so that reading exists. Without it: 80% |
| USDT | **80%**, and listed as reduce-only | Its ratio has no source on testnet (`book.rs:413`) |

**Not proved before the sitting:** `create_account` with five tokens has only its unit test for the gas
(`on_created` gets 100 TGas with five; both callers attach 300). The sandbox tests create accounts with two. The
first account made after step 5 is the proof; section 8 says how to go back.

## 0. Before (no approvals). Read on 13 Nov, 19:09 to 19:29 UTC

1. **The three names are free.** `meth.pbf-ops.testnet`, `mwnear.pbf-ops.testnet`, `musdt.pbf-ops.testnet`: the RPC
   answers `UNKNOWN_ACCOUNT` for each (block 277,553,061). Check again:
   `near account view-account-summary meth.pbf-ops.testnet network-config testnet now` (and the other two): each
   must say the account doesn't exist.
2. **The file is the one `musdc` runs.**
   `shasum -a 256 contracts/target/near/pb_testnet_token/pb_testnet_token.wasm` must print
   `f17e208da721c9d1740288997f3d9f057152d5ac212d32d376d80def1f57a714` (161,209 bytes, built 7 Nov).
   The code on chain, read with `view_code` at block 277,551,279: `musdc.pbf-ops.testnet` and
   `mnbtc.pbf-ops.testnet` both hold 161,209 bytes with that sha256. To read it again:
   `curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_code","finality":"final","account_id":"musdc.pbf-ops.testnet"}}' | python3 -c 'import sys,json,base64,hashlib; b=base64.b64decode(json.load(sys.stdin)["result"]["code_base64"]); print(len(b), hashlib.sha256(b).hexdigest())'`
   **If the built file's hash is anything else** (`contracts/build.sh` builds it again, and the build isn't
   reproducible), don't deploy it. Save the code `musdc` runs and deploy that file in step 2:
   `near contract download-wasm regular musdc.pbf-ops.testnet save-to-file /tmp/pb_testnet_token.live.wasm network-config testnet now`
3. **NEAR.** A token account locks its code and state: 161,209 bytes of code, 182 for the account and its key,
   about 130 for the token's state, so about 161,520 bytes, **1.615 NEAR** each (a byte locks 10^19 yoctoNEAR).
   Each account is made with **1.8 NEAR**, which leaves it 0.185 for the gas of its own deploy (about 0.002) and
   room to spare. A new holder's 125 bytes are paid by the holder's own 0.00125 NEAR, so a token's balance never
   has to grow. Live for comparison: `musdc` holds 1.991 NEAR with 167,687 bytes, `mnbtc` 1.956 with 164,235.
   - Needed from `pbf-ops.testnet`: 3 × 1.8 = **5.4 NEAR**, plus 3 × 0.00125 for the float's registrations, plus gas
     for ten calls (under 0.01): about **5.42 NEAR**.
   - It holds **12.05 NEAR** (block 277,553,060; it held 2.15 at 19:09 and was topped up since). After the
     sitting about 6.6 stays.
4. **The factory's operator and the pool's are `pbf-ops.testnet`** (the first field of each contract's stored
   state, read at block 277,552,968). The factory has 21 accounts and isn't paused.
5. **The stand-in's suite on this code:** 65 tests (54 before, unchanged), and its client's 12.

## 1. Three token accounts. Keychain, three times (`pbf-ops.testnet`'s key)

Each new account's key goes to the keychain, as `shim.pbf-ops.testnet`'s and `rhea.pbf-ops.testnet`'s did.

1. `near account create-account fund-myself meth.pbf-ops.testnet '1.8 NEAR' autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain sign-as pbf-ops.testnet network-config testnet sign-with-keychain send`
2. `near account create-account fund-myself mwnear.pbf-ops.testnet '1.8 NEAR' autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain sign-as pbf-ops.testnet network-config testnet sign-with-keychain send`
3. `near account create-account fund-myself musdt.pbf-ops.testnet '1.8 NEAR' autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain sign-as pbf-ops.testnet network-config testnet sign-with-keychain send`

Check: each account exists with 1.8 NEAR and no code.

## 2. The token file and its `new`, in one transaction each. Keychain, three times (each new account's own key)

`new(name, symbol, decimals)` can be called by anyone on code that has no state yet, so the deploy and the call go
together. The symbols are the ones section 49.6 names. `musdc` and `mnbtc` say `mUSDC` and `mNBTC` on chain; if the
wallet should show the same style here, write `mETH`, `mwNEAR`, `mUSDT` in these three calls instead. Nothing reads
this symbol: the engine, the pool and the stand-in go by the factory's settings and the token's id.

1. `near contract deploy meth.pbf-ops.testnet use-file contracts/target/near/pb_testnet_token/pb_testnet_token.wasm with-init-call new json-args '{"name":"Mock ETH","symbol":"ETH","decimals":18}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send`
2. `near contract deploy mwnear.pbf-ops.testnet use-file contracts/target/near/pb_testnet_token/pb_testnet_token.wasm with-init-call new json-args '{"name":"Mock wNEAR","symbol":"wNEAR","decimals":24}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send`
3. `near contract deploy musdt.pbf-ops.testnet use-file contracts/target/near/pb_testnet_token/pb_testnet_token.wasm with-init-call new json-args '{"name":"Mock USDT","symbol":"USDT","decimals":6}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send`

Check, for each of the three:
- `near contract call-function as-read-only meth.pbf-ops.testnet ft_metadata json-args '{}' network-config testnet now`
  answers the name, the symbol and **the decimals: 18, 24, 6**. The stand-in refuses a token whose decimals aren't
  these, and the factory's settings must say the same.
- The code on chain is `f17e208d…` (the `view_code` line of step 0.2, with the new id).

## 3. The float: registered, and given its stock. Keychain, three times (`pbf-ops.testnet`'s key)

`mint` is open to anyone. With 0.00125 NEAR attached it registers an account that isn't registered yet, then mints
(`contracts/testnet/token/src/lib.rs:54`), so one call does both.

1. 500 test ETH: `near contract call-function as-transaction meth.pbf-ops.testnet mint json-args '{"account_id":"shim.pbf-ops.testnet","amount":"500000000000000000000"}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as pbf-ops.testnet network-config testnet sign-with-keychain send`
2. 250,000 test wNEAR: `near contract call-function as-transaction mwnear.pbf-ops.testnet mint json-args '{"account_id":"shim.pbf-ops.testnet","amount":"250000000000000000000000000000"}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as pbf-ops.testnet network-config testnet sign-with-keychain send`
3. 1,000,000 test USDT: `near contract call-function as-transaction musdt.pbf-ops.testnet mint json-args '{"account_id":"shim.pbf-ops.testnet","amount":"1000000000000"}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as pbf-ops.testnet network-config testnet sign-with-keychain send`

That is about $970,000, $880,000 and $1,000,000 at the prices of 13 Nov, like the float's 995,000 mUSDC and 10 mNBTC.

Check, for each: `storage_balance_of` for `shim.pbf-ops.testnet` answers `{"total":"1250000000000000000000","available":"0"}`,
and `ft_balance_of` answers the amount:
`near contract call-function as-read-only meth.pbf-ops.testnet ft_balance_of json-args '{"account_id":"shim.pbf-ops.testnet"}' network-config testnet now`

**Who else needs registering: nobody.**
- **The pool:** no. It holds USDC only. It isn't registered on `mnbtc` either (`storage_balance_of` answers null,
  read 13 Nov), and every gate passed.
- **The operator and the keeper:** no. Neither has to hold these tokens. To put a token straight into a client's
  account for a test, mint it there: the factory registers every new account on its five tokens, so that needs no
  deposit:
  `near contract call-function as-transaction meth.pbf-ops.testnet mint json-args '{"account_id":"<name>.pbf.testnet","amount":"<units>"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as pbf-keeper.testnet network-config testnet sign-with-keychain send`
- **Client accounts:** the factory does it when it makes one (step 5 on).
- If this step is left out, the float still works: when it is short of a token it is about to send, it mints the
  rest itself, with the 0.00125 NEAR attached (`services/oneclick-shim/src/near-float.ts`, `mint`).

## 4. A step price for each new token (`pool.pbf.testnet`). Keychain, three times (`pbf-ops.testnet`'s key)

Not needed to hold, swap, pass a check or borrow. Needed for one thing: a plan step in one of these tokens (a
`sell` of the unwind) asks the pool's `check_step`, which values the step at the operator's step price and refuses
a token that has none: "no step price is set for this token" (`contracts/pool/src/lib.rs:822`). The live pool has
one for `mnbtc` only ($80,000, about 16% above the market); `step_price` answers null for the three new ids.

Prices are micro-dollars for one whole token, above the market on purpose, as the pool's note on the method says
(`contracts/pool/src/admin.rs:107`). On 13 Nov 1Click's list said ETH $1,945.20, wNEAR $3.53, USDT $0.9993.

1. ETH at $2,300: `near contract call-function as-transaction pool.pbf.testnet set_step_price json-args '{"token":"meth.pbf-ops.testnet","decimals":18,"price":"2300000000"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as pbf-ops.testnet network-config testnet sign-with-keychain send`
2. wNEAR at $4.20: `near contract call-function as-transaction pool.pbf.testnet set_step_price json-args '{"token":"mwnear.pbf-ops.testnet","decimals":24,"price":"4200000"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as pbf-ops.testnet network-config testnet sign-with-keychain send`
3. USDT at $1.05: `near contract call-function as-transaction pool.pbf.testnet set_step_price json-args '{"token":"musdt.pbf-ops.testnet","decimals":6,"price":"1050000"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as pbf-ops.testnet network-config testnet sign-with-keychain send`

They move no money and change no loan. Check: each transaction's `set_step_price` event, and
`near contract call-function as-read-only pool.pbf.testnet step_price json-args '{"token":"meth.pbf-ops.testnet"}' network-config testnet now`.
If the market moves well above a price, set it again higher.

**Nothing else on the pool.** Read live on 13 Nov (`get_pool`, `coin_statuses`):
- **Caps:** it already has them for these names. Loans resting on a bridged token: ETH 15% of capital ($1.5M of
  its $10M), USDT 30% ($3M), nBTC 30%. NEAR-side holdings of accounts with a loan: ETH $12M, wNEAR $6M, USDT $24M,
  nBTC $12M. All at 0 used. No `set_caps`.
- **Coin statuses:** the list is empty, and an unlisted coin is allowed. No `set_coin_status`.

## 5. The factory's settings (`pbf.testnet`). Keychain, once (`pbf-ops.testnet`'s key)

Only after steps 1 and 2 are checked. `set_config` replaces the whole config, so it is sent whole, with one change.

1. Read the live config and compare it with "before" below:
   `near contract call-function as-read-only pbf.testnet get_config json-args '{}' network-config testnet now`
   **If anything but `tokens` differs from "before"** (a pinned version changed since 19:28 UTC), don't send the
   JSON below: take the config just read, and replace only its `tokens` with the "after" list.

**The `tokens` list, before:**

```json
[{"id":"musdc.pbf-ops.testnet","symbol":"USDC","decimals":6},
 {"id":"mnbtc.pbf-ops.testnet","symbol":"nBTC","decimals":8}]
```

**After:**

```json
[{"id":"musdc.pbf-ops.testnet","symbol":"USDC","decimals":6},
 {"id":"mnbtc.pbf-ops.testnet","symbol":"nBTC","decimals":8},
 {"id":"meth.pbf-ops.testnet","symbol":"ETH","decimals":18},
 {"id":"mwnear.pbf-ops.testnet","symbol":"wNEAR","decimals":24},
 {"id":"musdt.pbf-ops.testnet","symbol":"USDT","decimals":6}]
```

The symbols are the pool's names, and the engine knows a token by them (`risk/pb-read/src/near.rs:12`): exactly
`ETH`, `wNEAR`, `USDT`. Any other spelling makes every check on a new account answer "the account's config lists
token …, which version 0 doesn't price".

2. Send it (the live config of 13 Nov, 19:28 UTC, with the list above; one line):

`near contract call-function as-transaction pbf.testnet set_config json-args '{"config":{"tokens":[{"id":"musdc.pbf-ops.testnet","symbol":"USDC","decimals":6},{"id":"mnbtc.pbf-ops.testnet","symbol":"nBTC","decimals":8},{"id":"meth.pbf-ops.testnet","symbol":"ETH","decimals":18},{"id":"mwnear.pbf-ops.testnet","symbol":"wNEAR","decimals":24},{"id":"musdt.pbf-ops.testnet","symbol":"USDT","decimals":6}],"pool_id":"pool.pbf.testnet","mpc_id":"v1.signer-prod.testnet","outlayer_id":"outlayer.testnet","risk":{"project_id":"pbf-keeper.testnet/pb-risk","version_key":"fb2cee3bb0b9dd8215b8c667a27dc6c565868487ccdf2e402f0327d516b2aee6"},"hl_chain":"Testnet","signature_chain_id":"0x66eee","usdc_token":"musdc.pbf-ops.testnet","params_hash":"3d362b434adaad0e0c909605bd792232acf964b9143a95ccb2541a0f65c4c263","model":"B-0.2","drill_id":"drill.pbf-ops.testnet","gateway":{"project_id":"pbf-keeper.testnet/pb-gateway","version_key":"fba556c2b9e64cf216fb3c805c998a1a210d5ef257960091853e3a8e0303ceb6","secrets_ref":null},"hl_usdc_token":"USDC:0xeb62eee3685fc4c43992febcd9e75443","lenders":{"rhea":{"contract_id":"rhea.pbf-ops.testnet","collateral":["mnbtc.pbf-ops.testnet"]},"aave":{"chain_id":84532,"pool":"0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27","usdc":{"symbol":"USDC","address":"0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f","decimals":6},"collateral":[{"symbol":"WBTC","address":"0x54114591963CF60EF3aA63bEfD6eC263D98145a4","decimals":8},{"symbol":"WETH","address":"0x4200000000000000000000000000000000000006","decimals":18}],"max_fee_per_gas":"1000000000"}}}}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as pbf-ops.testnet network-config testnet sign-with-keychain send`

3. Check: `get_config` answers the five tokens and nothing else changed; `account_code_hash` (`79827e65…`),
   `accounts_count` (21), `is_paused` (false) and `list_accounts` answer what they answered before.

The factory's own rules pass this config (`contracts/types/src/lib.rs:216`): 1 to 8 tokens, decimals at most 24,
no id twice, `usdc_token` listed with 6 decimals. Rhea's collateral stays `mnbtc` alone (a token posted there may
have at most 18 decimals, so wNEAR could never be added to it).

## 6. What holding the three means for a check and a loan (read in the code, not run)

**Prices of the coins.** ETH and NEAR are priced as BTC is: the median of Binance, OKX, Bybit and Coinbase tickers
and Hyperliquid testnet's oracle price, with the exchanges' candles for the hourly average and the volatility
(`risk/pb-read/src/read.rs:753`, `market.rs:16`). No source of these is testnet's own except Hyperliquid, which
lists both (read 13 Nov: ETH oracle $1,949.48, NEAR $3.536, neither delisted). A coin Hyperliquid testnet didn't
list would count as removed and reduce-only (`book.rs:372`); that isn't the case. Both coins are in the universe
(`research/data/universe_v0.json`: ETH tier 1, NEAR tier 2, both allowed).

**The ratio of each bridged token** (`risk/pb-read/src/book.rs:413` to `:439`; a token with a zero balance is
skipped):
- **wNEAR: none.** It isn't in the engine's list of bridged tokens, so it counts at NEAR's price in full.
- **ETH:** Aave's oracle price for WETH on Base Sepolia over the engine's ETH price, at most 1. That reading
  exists for every account whose settings list WETH at Aave, as the live settings do. If Aave's test price for
  WETH is under the market, test ETH on NEAR counts for that much less. With no Aave settings it would be 0.80 and
  reduce-only.
- **USDT: 0.80, and reduce-only, always on testnet.** Nothing on testnet gives its ratio (on mainnet it comes
  from 1Click quotes). $1,000 of test USDT counts as $800 for the state and for credit, and the verdict lists USDT
  under `reduce_only`. Nothing refuses a deposit or a swap because of that list.
- nBTC keeps the drill's ratio, as today.

**Borrowing against them** works as against nBTC: the engine lends nothing under $1,000 of equity
(`params.rs`, `min_equity_for_credit`), and nothing while a held coin's price is uncertain (`verdict.rs:245`,
binding `PRICE`).

**Time, for an account that holds wNEAR.** Each coin held adds 12 exchange requests to a check. A new account's
checks already read BTC and ETH (its Aave settings list WBTC and WETH: `book.rs:54`); holding wNEAR adds NEAR as a
third coin. Optional reads stop 13 s into a run (`read.rs:78`). If NEAR's candles are cut off, NEAR is
"uncertain" and the verdict lends nothing new until a check completes them; if not even three tickers came, there
is no verdict ("no valid price for NEAR"). Not measured. The first check on an account that holds test wNEAR
shows it: look for "skipped … out of time" in the run's errors.

**The pool** (`contracts/pool/src/lib.rs:787`): a loan resting on ETH or USDT counts toward that token's share of
capital; holdings of ETH, wNEAR and USDT count toward the NEAR-side caps. All far from their limits (step 4).

**The account's own NEAR.** `create_account` keeps 0.00125 NEAR for each token's registration
(`contracts/factory/src/lib.rs:186`, `:332`): 0.02825 NEAR with five tokens, 0.0245 with two. The account also
stores three more token entries, about 100 bytes. So 6 NEAR leaves a new account about **0.605 NEAR free**, where
it is 0.61 today. The account stops paying a new receiver's registration under 0.3 NEAR free
(`contracts/account/src/lib.rs:133`), and every swap sends to a fresh deposit address (0.00125 NEAR each): about
240 swaps before an account needs more NEAR. That was true before; only the count is new.

**Gas.** `create_account` now needs at least 210 TGas (180 with two tokens: `factory/src/lib.rs:60`, `:181`). The
app and the gate scripts attach 300.

**An account made before step 5** can't receive the new tokens: it isn't registered on them, and its
`ft_on_transfer` hands back a token that isn't in its own settings (`contracts/account/src/lib.rs:491`). A swap
that delivers one to it ends FAILED in the stand-in, and a FAILED swap gives nothing back. The app must offer a
token only to accounts whose own settings list it (49.3's `swaps_here`).

## 7. Services, and the proof

1. `pnpm -r build`, then `shim`, `api` and the keeper from `.claude/launch.json`. The stand-in needs no new
   setting: the three ids default to the names above (`METH_TOKEN_ID`, `MWNEAR_TOKEN_ID`, `MUSDT_TOKEN_ID` change
   them). It may be started before the tokens exist: it asks the chain when a quote names one, and starts quoting
   it within 15 s of its deploy, with no restart. Its first lines say which of the three are deployed.
2. Read only:
   - `curl -s http://localhost:8787/v0/tokens` lists `ETH`, `wNEAR` and `USDT` after the stand-in's first three,
     each with 1Click's price.
   - A dry quote, 10 USDC to ETH:
     `curl -s -X POST http://localhost:8787/v0/quote -H 'Content-Type: application/json' -d '{"dry":true,"swapType":"EXACT_INPUT","slippageTolerance":100,"originAsset":"nep141:musdc.pbf-ops.testnet","depositType":"ORIGIN_CHAIN","destinationAsset":"nep141:meth.pbf-ops.testnet","amount":"10000000","refundTo":"pbf-keeper.testnet","refundType":"ORIGIN_CHAIN","recipient":"pbf-keeper.testnet","recipientType":"DESTINATION_CHAIN"}'`
     answers a quote with `amountOut` in wei (about 0.0051 ETH at $1,945).
3. **The gate on a new account** (section 49.6): make one after step 5. Then:
   - `storage_balance_of` for it on each of the five tokens isn't null;
   - its first check brings a verdict (five balances read, all zero);
   - one swap of USDC into each new token and one back, through the app or the backend's `POST /api/quote` with
     `swap`; each ends SUCCESS in the stand-in, and the account's `ft_balance_of` shows it;
   - a check with the tokens held: ETH and NEAR priced, USDT at 0.80 and under `reduce_only`.

## 8. If something fails, and going back

- **Steps 1 to 4 change nothing that exists.** Until step 5 no account lists the new tokens. A token account that
  came out wrong (decimals, a failed `new`) can be deleted and made again:
  `near account delete-account meth.pbf-ops.testnet beneficiary pbf-ops.testnet network-config testnet sign-with-keychain send`
  (its NEAR comes back to the operator). A step price can only be set again, not removed; one for a token nobody
  holds does nothing.
- **Step 5, going back:** `set_config` with the config of before. Accounts made in between keep five tokens, and
  keep working as long as the three token contracts exist: **don't delete a token account once any account lists
  it** (its checks would bring no verdict).

`near contract call-function as-transaction pbf.testnet set_config json-args '{"config":{"tokens":[{"id":"musdc.pbf-ops.testnet","symbol":"USDC","decimals":6},{"id":"mnbtc.pbf-ops.testnet","symbol":"nBTC","decimals":8}],"pool_id":"pool.pbf.testnet","mpc_id":"v1.signer-prod.testnet","outlayer_id":"outlayer.testnet","risk":{"project_id":"pbf-keeper.testnet/pb-risk","version_key":"fb2cee3bb0b9dd8215b8c667a27dc6c565868487ccdf2e402f0327d516b2aee6"},"hl_chain":"Testnet","signature_chain_id":"0x66eee","usdc_token":"musdc.pbf-ops.testnet","params_hash":"3d362b434adaad0e0c909605bd792232acf964b9143a95ccb2541a0f65c4c263","model":"B-0.2","drill_id":"drill.pbf-ops.testnet","gateway":{"project_id":"pbf-keeper.testnet/pb-gateway","version_key":"fba556c2b9e64cf216fb3c805c998a1a210d5ef257960091853e3a8e0303ceb6","secrets_ref":null},"hl_usdc_token":"USDC:0xeb62eee3685fc4c43992febcd9e75443","lenders":{"rhea":{"contract_id":"rhea.pbf-ops.testnet","collateral":["mnbtc.pbf-ops.testnet"]},"aave":{"chain_id":84532,"pool":"0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27","usdc":{"symbol":"USDC","address":"0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f","decimals":6},"collateral":[{"symbol":"WBTC","address":"0x54114591963CF60EF3aA63bEfD6eC263D98145a4","decimals":8},{"symbol":"WETH","address":"0x4200000000000000000000000000000000000006","decimals":18}],"max_fee_per_gas":"1000000000"}}}}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as pbf-ops.testnet network-config testnet sign-with-keychain send`

- **The first `create_account` fails after step 5** (the one thing not proved in the sandbox): the factory refunds
  the caller, and the old config above puts it back as it was.

## 9. How the commands here were checked

- The forms are the ones this project has sent before: `create-account fund-myself … save-to-keychain` and
  `contract deploy … with-init-call` from `scripts/rhea-setup.sh` and `scripts/shim-setup.sh`;
  `call-function as-transaction … sign-with-keychain send` from `research/low_fixes_deploy.md`. The read-only,
  `download-wasm regular` and `delete-account` forms were checked against near-cli-rs 0.30.1's own `--help`.
- Both `set_config` lines were made by a script from the config read at 19:28 UTC, which also checked that
  `tokens` is the only key that differs between them.
- Thirteen signed transactions, each a keychain approval: 3 accounts, 3 deploys (each with its own new key), 3
  mints, 3 step prices, 1 `set_config`.
- Nothing in this file was run. Every figure marked "read" came from a view of testnet's public RPC, 1Click's
  public API or Hyperliquid testnet's public `info`.
