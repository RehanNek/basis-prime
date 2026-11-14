# The testnet price band on testnet: the deploy sitting (written and run on 12 Nov; the live order proof is still to do)

NEAR testnet only. Nothing touches a mainnet, the pool, or the factory's code: the account contract doesn't change.
Two steps ask the user's keychain: the seed's rule, and the factory's settings. A third, test NEAR for the keeper,
is needed only for the live proof with the hedge (section 4).

What is being deployed: the rule of INTERFACES.md 42. On testnet the gateway's P2 band is the parameter file's band
or 3%, whichever is larger. It reaches accounts made after the new programs are pinned; older ones keep 1%.

## 0. Before the sitting (no approvals). Done on 12 Nov

1. Suites on the joined code, by the main session's own runs: engine 329; JavaScript: keeper 185, backend 155,
   stand-in 54, its client 12, app 222 (628 in all); `pnpm -r build` and the app's lint are clean. The contracts weren't touched: their sources are older than the
   deployed build.
2. The enclave builds, from `risk/`, with `RUSTFLAGS="--remap-path-prefix=$HOME=~"` and `--locked`.

**To deploy:**

| What | Size | sha256 |
|---|---|---|
| `pb-risk` | 1,643,228 B | `fb2cee3bb0b9dd8215b8c667a27dc6c565868487ccdf2e402f0327d516b2aee6` |
| `pb-gateway` | 1,566,030 B | `fba556c2b9e64cf216fb3c805c998a1a210d5ef257960091853e3a8e0303ceb6` |

Pin the two together: the new engine prices a plan's perp step 1.5% from the reference, which an older gateway's 1%
band refuses.

## 1. The engine builds (OutLayer, signed by `pbf-keeper.testnet` with the CLI's own key)

For each: `outlayer upload <wasm>`, then **fetch the FastFS URL back and check size and sha256** (on 12 Nov one
upload printed "Upload complete" and never reached the chain), then
`outlayer deploy <name> <url> --hash <sha256> --no-activate`.

**Keychain.** `update_access` on `outlayer.testnet`, signed by `pbf-keeper.testnet`, 30 TGas, 0.01 NEAR, with the
arguments in `research/data/band_update_access.json` (the six hashes of before and `fba556c2…` as a seventh).

Check: the new gateway answers `agent_address` for `demo1.pbf.testnet` with
`0x68643293a2b557f696b7d485b4e1ddaac4a2d46a`, and the new `pb-risk` runs.

## 2. The factory's settings. Keychain

As the operator, `set_config` with the config just read and only `risk.version_key` and `gateway.version_key`
replaced. Snapshot before and after: nothing else may change. The factory's code and `account_code_hash`
(`0809d45c…`) stay.

## 3. Services, and what reads only

1. `pnpm -r build`, then start `shim`, `api`, `keeper` from `.claude/launch.json`. The backend must be this build.
2. `GET /api/markets` (no account) must say `band_floor_bp: 300` and BTC's `band_bp: 300`; with
   `?account=fund-rhea-11121251.pbf.testnet` (made before the pin) it must say 100.
3. `pnpm --filter @pb/keeper funding:demo -- --lender rhea --dry-run` must print a "found:" line that names the
   gateway's band as 3% and the hedge's two prices. If it says 1%, the factory doesn't pin the new gateway yet.

## 4. The live proof: the Rhea gate with its hedge

It needs a new account (one made before the pin keeps 1%), and so about 6.7 test NEAR in the keeper. On 12 Nov the
keeper holds 2.44 and `pbf-ops.testnet` 3.18: together 5.6, not enough.

1. **Test NEAR first:** about 5 more to `pbf-ops.testnet` or straight to `pbf-keeper.testnet`, from the user's own
   wallet. If it goes to the operator, one more keychain prompt moves it on.
2. `pnpm --filter @pb/keeper funding:demo -- --lender rhea`, with no `--name` and no `--from`. About 20 minutes.
3. **What would still stop the hedge:** the mark more than about 2.9% from the oracle; or the gap widening between
   the open and the close, in which case `close_short` stops in words, the short stays open, and
   `--name <name> --from close_short` goes on once the mark is back.

Without the test NEAR, the proof is the user's own click-through on a new account.

## 5. After

- Stop the three services.
- Record it: INTERFACES.md ("the testnet band live"), the README's list of what differs on testnet (one line: the
  3% is a testnet allowance, and why), the memory notes.

## If something fails

- **Rolling back:** `set_config` with the two `version_key`s of before (`1a102c17…`, `9a2e035c…`). Accounts made in
  between keep what they pinned.

## As run on 12 Nov (14:32 to 14:36 UTC)

Sections 1 to 3 went as written. The transactions are in INTERFACES.md 43.

1. Both uploads came back from FastFS at the first try.
2. Two keychain approvals: the seed's rule, then the factory's settings.
3. The backend answered 300 for a new account and 100 for one made before the pin, and the Rhea gate's dry run
   named the 3% band and the hedge's two prices (mark 2.11% over the oracle at the time).
4. **Section 4 was not run:** the keeper holds 2.41 test NEAR and `pbf-ops.testnet` 3.18, and a new account takes 6
   and about 0.6 more. The services were stopped.

**To finish the proof:** about 5 test NEAR to `pbf-keeper.testnet`, start the three services, then
`pnpm --filter @pb/keeper funding:demo -- --lender rhea`.

## The live proof, as run on 12 Nov (15:07 to 16:01 UTC)

The user sent the keeper 9.9 test NEAR from a faucet account (`pbf-fund7.testnet`). Then
`pnpm --filter @pb/keeper funding:demo -- --lender rhea` on a new account, `fund-rhea-11121507.pbf.testnet`.

1. **The hedge opened under the 3% band:** a sell 1.71% over the oracle, taken by the new gateway and filled.
2. **`top_up` failed:** the keeper never asked for the check after the price drop (a timing gap in its cushion watch,
   INTERFACES.md 43). The run went on.
3. **`close_short` stopped:** Hyperliquid itself refused a buy 2.8% over its oracle ("Price too far from oracle").
4. A script watched the gap, reading only, and at 15:59, with the mark 2.03% over the oracle, ran
   `--name fund-rhea-11121507 --size small --from close_short`: the close filled, the USDC came home, both tokens
   were withdrawn.

Not a pass (`top_up`). The record is `research/data/phase6_funding_rhea.band-2026-11-12.json`.

