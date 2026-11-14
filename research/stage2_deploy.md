# Stage 2 on testnet: the deploy sitting (written 11 Nov, before it; not run yet)

Everything here is NEAR testnet. Nothing touches mainnet. Each signed command asks the user's keychain, so the user
must be at the laptop. Run one step, check it on chain, then the next. Wait about 20 seconds between two
transactions from the same key (`research/outlayer.md`: a second one sent at once can fail with `InvalidNonce`).

## 0. Before the sitting (no approvals)

1. Every suite passes on the final code: engine, contracts with the sandbox tests (including `--test lender` and
   `--test upgrade`), JavaScript.
2. `contracts/build.sh --sizes`: note the sizes and hashes of `pb_account`, `pb_factory` and `pb_pool`.
3. Refresh the saved live state and run the upgrade tests on it once more:
   `python3 -I contracts/tests/fetch_live.py`, then `cargo test -p pb-sandbox-tests --test upgrade --locked`.
4. The enclave builds, from `risk/`, one at a time, and their sha256 and size:
   `RUSTFLAGS="--remap-path-prefix=$HOME=~" cargo build -p pb-risk --target wasm32-wasip2 --release`, then the same
   for `pb-gateway`. Check the engine's `params_hash` and `model` against the factory's config (below): if stage 1's
   new token (WBTC) or anything else changed the hash, the new config must carry the new one.
5. `bash scripts/rhea-setup.sh` with no argument: it only reads testnet and lists what is left.
6. Today's BTC price in whole dollars, for the copy's first price (Hyperliquid's oracle).

**Section 0 was done on 11 Nov, about 16:00 UTC:**
- Engine 298, contracts 578, JavaScript 475, all passing. The upgrade tests pass on the live code and state fetched
  that afternoon (pool `f9c3b708…`, factory `2064eae1…`). The 9 Nov save is kept in `contracts/target/live-2026-11-09/`.
- To deploy: account 471,865 B `38261f9d…4f41`; factory 704,244 B `3fef6b1a…9c00`; pool 464,340 B `c4641c0e…24a2`;
  `pb-risk` 1,605,707 B `8f60fa0c92e106dec8793b9eb2ef25ed2b65409d934b679715a756216eb79027`; `pb-gateway` 1,537,731 B
  `e5d4b32459d5acf5dbd163e787705e952decfbcf8c0815301fff0ff1e9418b50`. `params_hash` and `model` are unchanged.
- The setup script's read-only run lists 12 steps to do, none done.
- A new account costs 6 NEAR, so the keeper needs about 6.6 NEAR for the gate's account.
- For the copy's first BTC price, use Hyperliquid **testnet's** oracle price, which is what the keeper compares with.

## 1. Test NEAR, from `pbf-ops.testnet` (30.5 NEAR on 11 Nov)

| To | NEAR | Why |
|---|---|---|
| `rhea.pbf-ops.testnet` | 11 | Made by the setup script: Rhea's file locks 10.18 |
| `pool.pbf.testnet` | 2 | The new pool code is 464,340 bytes; the account would be left with 0.01 NEAR free |
| `pbf.testnet` | 2 | The factory carries the account's code, which grew to about 472,000 bytes |
| `pbf-keeper.testnet` | 10 | It opens the gate's account (about 6 NEAR each, with its checks and gas) and a second one for stage 3 |

`near tokens pbf-ops.testnet send-near <to> '<n> NEAR' network-config testnet sign-with-keychain send`

That leaves `pbf-ops.testnet` about 5 NEAR for the setup script's small costs and for gas.

## 2. Our copy of Rhea

`BTC_USD=<price> bash scripts/rhea-setup.sh --go` (reviewed on 11 Nov). It creates `rhea.pbf-ops.testnet`, deploys
`vendor/burrowland/burrowland_release.wasm` with `new`, checks code hash
`DmzFHbCP7jCobFjPYx7GRvc1iHTpqyLJxvcrEawFaF4g` and version 0.15.7, registers and lists mUSDC and mNBTC with fixed
prices, supplies 1,000,000 mUSDC, and borrows 851,500 of it back so the copy charges about 15.9%.
Then run it once more with no argument: it must say every step is done.

## 3. The pool (`pool.pbf.testnet`)

1. Deploy with its migration, signed by the pool's own key:
   `near contract deploy pool.pbf.testnet use-file contracts/target/near/pb_pool/pb_pool.wasm with-init-call migrate json-args '{}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send`
2. Check: `get_params` shows `funding`, `pricing_limits` and `tier_pricing`; `get_pool` shows `fees_charged`,
   `subsidy_paid`, `subsidy_left_24h` and `credit_owed`; every old borrower's debt is what it was.
3. For the demo, as the operator: read `get_params().pricing_limits`, then `set_pricing_limits` with the same values
   and `min_period_ns` of 120000000000 (two minutes between two settlements of one account, not ten).
4. The gate script sets the order to `lender_first` for its own `fund` and puts it back. For the click-through and
   the video the order must stay `lender_first`: `set_funding({"funding":{"order":"lender_first","loan_days":90}})`
   after the gate. Our copy charges more than our pool, as Rhea does on mainnet, so `cheapest` would never use it.

## 4. The engine builds (OutLayer, signed by `pbf-keeper.testnet`)

For `pb-risk` (project `pbf-keeper.testnet/pb-risk`, no secrets):
1. `outlayer upload risk/target/wasm32-wasip2/release/pb-risk.wasm`: note the FastFS URL.
2. Fetch that URL: it must answer 200 with the right size and sha256. FastFS can lose an upload without saying so.
3. `outlayer deploy pb-risk <url> --hash <sha256> --no-activate`.

For `pb-gateway` (project `pbf-keeper.testnet/pb-gateway`, which holds the agents' seed):
1. Upload, fetch and check, as above.
2. `outlayer deploy pb-gateway <url> --hash <sha256> --no-activate`.
3. Let the new build open the seed, without locking the old builds out. Not `outlayer secrets access`: that keeps
   only one build. Send `update_access` on `outlayer.testnet`, signed by `pbf-keeper.testnet`, 30 TGas, 0.01 NEAR,
   with the arguments of 8 Nov's transaction `CWTn7jpxPDP3PSugDofVdL1P3xTNLncfSTj5MxMPuwJK` and the new hash added:

```json
{"accessor":{"Project":{"project_id":"pbf-keeper.testnet/pb-gateway"}},
 "new_access":{"Logic":{"conditions":[
   {"Predecessor":{"condition":{"Logic":{"conditions":[
     {"AccountPattern":{"pattern":"[a-z0-9_-]+\\.pbf\\.testnet"}},
     {"Whitelist":{"accounts":["pbf-keeper.testnet"]}}],"operator":"Or"}}}},
   {"Logic":{"conditions":[
     {"WasmHash":{"hash":"fcae6052c4cde41d4dcb50460f4788df848e648839ce392fb6f15dc1581223d5"}},
     {"WasmHash":{"hash":"6746393a828da9e9f3cb302f1e1a57d1c50d1042d66c3b7a659f58652a747efb"}},
     {"WasmHash":{"hash":"<the new pb-gateway sha256>"}}],"operator":"Or"}}],"operator":"And"}},
 "profile":"gateway"}
```

4. Check over HTTPS that the new build, called by its `version_key`, answers `agent_address` for an old account with
   the agent it had before.

## 5. The factory (`pbf.testnet`)

1. Deploy with its migration, signed by the factory's own key:
   `near contract deploy pbf.testnet use-file contracts/target/near/pb_factory/pb_factory.wasm with-init-call migrate json-args '{"lenders":{"rhea":{"contract_id":"rhea.pbf-ops.testnet","collateral":["mnbtc.pbf-ops.testnet"]}}}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send`
2. Check: `get_config().lenders.rhea` is there, `account_code_hash` is the new account build's, the list of
   accounts is what it was.
3. Pin the new engine builds, as the operator: `set_config({"config": …})` with the config just read, and only
   `risk.version_key`, `gateway.version_key` (and `params_hash`, if it changed) replaced.
   On 11 Nov the live config pinned `pb-risk` `4e44327e…` and `pb-gateway` `6746393a…`, with `params_hash`
   `3d362b43…` and `model` `B-0.2`.
4. Stage 2's config has `lenders.rhea` only. `lenders.aave` comes with stage 3.

## 6. Settings and services

1. `.env`, through `scripts/set-env.sh` (it never shows a value): `RHEA_ACCOUNT_ID` (`rhea.pbf-ops.testnet`),
   `MNBTC_TOKEN_ID` (`mnbtc.pbf-ops.testnet`). `OPERATOR_ACCOUNT_ID`, `OPERATOR_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`
   and `OUTLAYER_PAYMENT_KEY` are there since the earlier phases.
2. Start the backend and the keeper again, so they read the new settings. The keeper's first ticks must show
   `rhea_btc` within 0.25% of `btc_oracle`.

## 7. The gate

1. `pnpm --filter @pb/keeper funding:demo -- --lender rhea --dry-run`: it must list nothing in the way.
2. `pnpm --filter @pb/keeper funding:demo -- --lender rhea`. It writes `research/data/phase6_funding_rhea.json`
   after every step, and `--from <step>` picks it up again.
3. Gate 2 passes when: the fresh account signed the permission and one `fund`; it ended with a Rhea loan and a
   pool loan; one settlement booked a fee and another a subsidy; the copy's BTC price was dropped and the keeper
   topped Rhea up; the client repaid everything and withdrew.

## If something fails

- **The pool's migration:** stop. The old code is in `contracts/target/live/pool.wasm`; nothing else has changed
  for old accounts. FUNDING.md's cut rule 3 is a fresh pool for new accounts.
- **The factory's migration:** the old code is in `contracts/target/live/factory.wasm`.
- **An engine upload:** upload again; a version already added points at the same URL.
- **The gate:** fix, then `--from <the failed step>`.
