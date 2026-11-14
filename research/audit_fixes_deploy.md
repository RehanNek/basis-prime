# The audit fixes on testnet: the deploy sitting (written and run on 12 Nov; gate 4 passed again)

Everything here is NEAR testnet and Base Sepolia. Nothing touches a mainnet. The pool is not touched. Four steps ask
the user's keychain: the test NEAR, the seed's rule, the factory's redeploy, and its settings. The steps are the same
as `research/stage4_deploy.md`'s, which ran on 12 Nov with no trouble.

What is being deployed: the fixes of `research/audit.md`'s second pass (A7, A8, A9, A12 in part, A14, X2, F2), as
INTERFACES.md 40 has them. Fixes in the account reach accounts made after the redeploy only.

## 0. Before the sitting (no approvals). Done on 12 Nov

1. Every suite passes on the joined code, by the main session's own runs: engine 321, contracts 666 (with
   `audit_fixes.rs` and `upgrade_audit.rs`, the redeploy over the live stage 4 factory saved in
   `contracts/target/live-stage4/`), JavaScript 619 (keeper 180, backend 154, stand-in 54, its client 12, app 219).
   `pnpm -r build` and the app's lint are clean.
2. `contracts/build.sh --sizes`: the account and the factory changed; the pool did not.
3. The enclave builds, from `risk/`, with `RUSTFLAGS="--remap-path-prefix=$HOME=~"` and `--locked`.
4. The records of the gates that passed are kept under their own names, because a new run writes the same file:
   `research/data/phase6_funding_moves.gate4-2026-11-12.json` and `phase6_funding_rhea.gate2-2026-11-11.json`.

**To deploy:**

| What | Size | sha256 |
|---|---|---|
| Account | 514,749 B | `0809d45c060e78925b4276d25e8b7d3735ffb42edb9f5582fa17094b95ba60cb` |
| Factory (a plain redeploy, no init call) | 747,633 B | `638f17b1b2a40c8559629847be58ebc9d2f9876915addee37f8631ed3a26e860` |
| `pb-risk` | 1,643,043 B | `1a102c17046c2c07ac484b603b4ffb4b32b9950b208f4fc2d1f9eaed1440ca6f` |
| `pb-gateway` | 1,565,937 B | `9a2e035c2f62906d8e390db28c5be23b0753ca20b7d842908ac35916b09643e8` |

The pool stays `c4641c0e…`. If any contract or engine source file changes before the sitting, build again and replace
these: a comment that moves a line changes a hash.

## 1. Test NEAR, from `pbf-ops.testnet` (11.18 NEAR on 12 Nov). Keychain

| To | NEAR | Why |
|---|---|---|
| `pbf-keeper.testnet` | 8 | It holds 6.63. Each gate run opens an account with 6 and spends about 0.7 on checks and gas; two runs need about 13.4 |

The factory needs none: it has 2.57 NEAR free and the redeploy locks about 0.026 more.

`near tokens pbf-ops.testnet send-near pbf-keeper.testnet '8 NEAR' network-config testnet sign-with-keychain send`

## 2. The engine builds (OutLayer, signed by `pbf-keeper.testnet` with the CLI's own key)

For each of `pb-risk` and `pb-gateway`: `outlayer upload <wasm>`, fetch the FastFS URL back and check size and
sha256, then `outlayer deploy <name> <url> --hash <sha256> --no-activate`.

Then let the new gateway open the agents' seed beside the older ones. **Keychain.** `update_access` on
`outlayer.testnet`, signed by `pbf-keeper.testnet`, 30 TGas, 0.01 NEAR, with stage 4's arguments and the new hash
added as a sixth `WasmHash` (ready in `research/data/audit_fixes_update_access.json`).

Check: the new gateway, called by its `version_key`, answers `agent_address` for `demo1.pbf.testnet` with
`0x68643293a2b557f696b7d485b4e1ddaac4a2d46a`, and the new `pb-risk` runs.

## 3. The factory (`pbf.testnet`). Keychain, twice

1. A plain redeploy with **no init call**: its stored state doesn't change shape.
   `near contract deploy pbf.testnet use-file contracts/target/near/pb_factory/pb_factory.wasm without-init-call network-config testnet sign-with-keychain send`
2. Check: the code on chain is the built file's; `account_code_hash` is `0809d45c…`; the config and the 9 accounts
   are what they were (snapshot, then diff).
3. As the operator, `set_config` with the config just read and only `risk.version_key` and `gateway.version_key`
   replaced.

## 4. Services

1. `pnpm -r build`, then start `shim`, `api`, `keeper` from `.claude/launch.json`. `.env` needs nothing new.
2. The backend's `GET /api/evm/gas` says `on: true`. The keeper's first tick lists the accounts.

## 5. The gates, on the new code

1. **Gate 4 again:** `pnpm --filter @pb/keeper funding:demo -- --lender aave --moves --dry-run` (nothing in the
   way), then without `--dry-run`. About 10 minutes. It costs 0.002 test ETH (the float holds 0.046).
   - Its `usdc_out` step will be the first time the stand-in mints test USDC from Aave's faucet: its float holds
     $0.005. That step comes after the pass point.
   - After it, check a new account's `get_state` shows `permission_blk`.
2. **Gate 2 again:** `pnpm --filter @pb/keeper funding:demo -- --lender rhea --dry-run`, then without. About 20
   minutes. If its way out stops at `rhea_withdraw` with a few cents owed to the pool (the audit's A13), go on with
   `--from repay`.
3. Gate 3 isn't run again: gate 4 covers its Aave steps on the new code.

## 6. After the gates

- Stop the three services.
- Record it: INTERFACES.md (a "the audit fixes live" section), `research/audit.md` (each fixed finding marked, with
  its test and the deploy), FUNDING.md 11, the memory notes.

## If something fails

- **The factory's redeploy:** the stage 4 code is saved in `contracts/target/live-stage4/factory.wasm`.
- **A gate:** fix, then `--name <label> --from <the failed step>`.
- **Rolling back:** today's source from before the fixes is in the session's scratch folder as a tar. The factory's
  old code and the old pinned programs can be put back with the same two steps of section 3.

## As run on 12 Nov (12:31 to 13:07 UTC)

Sections 1 to 4 went as written, but for one upload. The transactions are in INTERFACES.md 41.

1. **Four keychain approvals, 12:31 to 12:38:** the test NEAR, the seed's rule, the factory's redeploy, its settings.
2. **The gateway's first upload was lost.** `outlayer upload` printed two transaction ids and "Upload complete", but
   the chain knew neither transaction, and FastFS answered 404 for three minutes. A second upload worked. Always
   fetch the file back before `outlayer deploy`.
3. **Gate 4, 12:39:16 to 12:50:37:** passed at its first try, every step. The stand-in minted test USDC from Aave's
   faucet for the first time ($0.988372), at `usdc_out`.
4. **The Rhea gate, 12:51:49 to 13:07:29: not a pass.** It stopped at `short`: the gateway refused the hedge's order
   (P2), because Hyperliquid testnet's BTC mark stood 1.96% over its oracle. It went on with
   `--name fund-rhea-11121251 --size small --from keeper`, without the hedge, and every later step passed. Its record
   is `research/data/phase6_funding_rhea.fixes-2026-11-12.json`; `phase6_funding_rhea.json` is gate 2's own record of
   11 Nov again.
5. **After:** the three services stopped. `pbf-ops.testnet` 3.18 NEAR, the keeper 2.44, the factory 2.55 free; the
   float 0.04399 test ETH.

**For the click-through:** an account made from now on has the fixed code. A hedge on Hyperliquid goes through the
gateway only while testnet's mark is within 1% of its oracle; a loan against unhedged test nBTC works either way.
The keeper needs about 6.7 NEAR before another gate run.

