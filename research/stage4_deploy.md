# Stage 4 on testnet: the deploy sitting (written 11 Nov; run on 12 Nov, gate 4 passed)

Everything here is NEAR testnet and Base Sepolia. Nothing touches a mainnet. Four steps ask the user's keychain:
the test NEAR, the seed's rule, the factory's redeploy, and its settings. `research/stage3_deploy.md` has the same
steps for stage 3, with what went wrong there.

## 0. Before the sitting (no approvals). Done on 11 Nov, about 22:50 UTC

1. Every suite passes on the joined code: engine 319, contracts 642 (with `moves.rs` and `upgrade_stage4.rs`, the
   redeploy over the live stage 3 factory saved in `contracts/target/live-stage3/`), JavaScript 610.
2. `contracts/build.sh --sizes`: the account and the factory changed; the pool did not.
3. The enclave builds, from `risk/`, with `RUSTFLAGS="--remap-path-prefix=$HOME=~"` and `--locked`.
4. A snapshot of the live pool and factory (the session's `snapshot.py`, `before_stage4.json`).
5. A live check that reads only: the stage 4 stand-in and backend, started against testnet, gave dry quotes for all
   four moves (INTERFACES.md 37).

**To deploy:**

| What | Size | sha256 |
|---|---|---|
| Account | 512,616 B | `94ceb936a349f9eb587d10214a152097ff2fefc33752a5a51c7e902ebc92e59d` |
| Factory | 744,992 B | `ce6fcd5ac83087c6a5ccd4560ba8920f265ba12c11e4afba215ab5e8c43024b5` |
| `pb-risk` | 1,642,985 B | `0de5d85d151109a0eeca188ab9d2d3acaf014c7d0dab366ba7a7d2ce808f3c17` |
| `pb-gateway` | 1,565,895 B | `06dc7787e8fc5db00747588e21c6e704c13e5055dc14f2fb2c20c5dd4db426c1` |

The pool is unchanged. If any source file changes before the sitting, build again and replace these.

## 1. Test NEAR, from `pbf-ops.testnet` (17.18 NEAR on 11 Nov). Keychain

| To | NEAR | Why |
|---|---|---|
| `pbf-keeper.testnet` | 6 | It holds 6.74. The gate's fresh account takes 6, and its checks and gas about 0.4 |

The factory needs none: it has 2.58 NEAR free and the redeploy locks about 0.015 more.

`near tokens pbf-ops.testnet send-near pbf-keeper.testnet '6 NEAR' network-config testnet sign-with-keychain send`

## 2. The engine builds (OutLayer, signed by `pbf-keeper.testnet` with the CLI's own key)

For each of `pb-risk` and `pb-gateway`: `outlayer upload <wasm>`, fetch the FastFS URL back and check size and
sha256 (it can answer 404 for a few seconds), then `outlayer deploy <name> <url> --hash <sha256> --no-activate`.

Then let the new gateway open the agents' seed beside the older ones. **Keychain.** `update_access` on
`outlayer.testnet`, signed by `pbf-keeper.testnet`, 30 TGas, 0.01 NEAR, with stage 3's arguments and the new hash added as a fifth `WasmHash`
(ready in `research/data/stage4_update_access.json`):
`fcae6052…`, `6746393a…`, `e5d4b324…`, `6bdc21f6…` and `06dc7787…`.

Check: the new gateway, called by its `version_key`, answers `agent_address` for `demo1.pbf.testnet` with
`0x68643293a2b557f696b7d485b4e1ddaac4a2d46a`. Submit with `async: true` and poll: OutLayer's queue took 2 minutes
on 11 Nov.

## 3. The factory (`pbf.testnet`). Keychain, twice

1. A plain redeploy with **no init call**: its stored state doesn't change shape.
   `near contract deploy pbf.testnet use-file contracts/target/near/pb_factory/pb_factory.wasm without-init-call network-config testnet sign-with-keychain send`
   If the RPC answers an error, check whether it landed before sending again.
2. Check: the code on chain is the built file's; `account_code_hash` is `94ceb936…`; the config and the 8 accounts
   are what they were (snapshot, then diff).
3. As the operator, `set_config` with the config just read and only `risk.version_key` and `gateway.version_key`
   replaced by the stage 4 builds. `lenders.rhea` and `lenders.aave` stay as they are.

Accounts made before this keep their code. An account from stage 3 can borrow at Aave and can't make a move.

## 4. Services

1. `pnpm -r build` (the backend's start line doesn't build the 1Click client package).
2. Start the stand-in, the backend and the keeper from `.claude/launch.json` (`shim`, `api`, `keeper`). `.env` needs
   nothing new.
3. The stand-in's first lines must name its Base Sepolia float (the gas wallet) and the tokens USDC, WBTC, WETH.
4. The backend's `GET /api/evm/gas` says `on: true`. The keeper's first tick lists the accounts.

## 5. The gate

1. `pnpm --filter @pb/keeper funding:demo -- --lender aave --moves --dry-run`: it must list nothing in the way. It
   also checks that the factory's account code and pinned programs are the ones built here.
2. `pnpm --filter @pb/keeper funding:demo -- --lender aave --moves`. It writes
   `research/data/phase6_funding_moves.json` after every step; `--name <label> --from <step>` goes on with the same
   account.
3. **Gate 4 passes at the step `loan_home`:** an account holding only test nBTC moved a part of it to Base Sepolia
   through the stand-in, borrowed on Aave against what arrived, and the borrowed USDC arrived in the account on
   NEAR. The steps after it leave the way a client would, and the record's `pass` says whether they all went
   through too.
4. Expect 20 to 30 minutes: 18 steps, about eight checks (each waits in OutLayer's queue), and four moves.

**Test ETH:** the float holds 0.048 and a run needs 0.0252 in it. 0.0196 is wrapped at `btc_out` and comes back at
`btc_home`; the 0.002 sent to the account's address for gas stays there. So each full run costs about 0.002.

## 6. After the gate

- Stop the three services.
- If a run stopped between `btc_out` and `btc_home`, the float may still hold WETH:
  `node scripts/aave-spike.mjs --unwrap --send` turns it back into test ETH.
- Record it: INTERFACES.md (a "stage 4 live" section), FUNDING.md 11, the memory notes.

## If something fails

- **The factory's redeploy:** the stage 3 code is saved in `contracts/target/live-stage3/factory.wasm`.
- **A move that never arrives:** its transfer goes overdue 30 minutes after the quote's expiry, and the owner drops
  it with `forget_transfer`. Until then the account refuses to borrow. The stand-in's status
  (`GET /api/status`) says where the money is.
- **A signed Ethereum transaction that reverts or never lands:** its nonce must still be used. Send it anyway, or
  let the keeper bump it once; the engine reads the real position.
- **A check that brings no verdict** (Aave's chain unreadable, or OutLayer's queue): the gate asks again by itself,
  three times.
- **The gate:** fix, then `--name <label> --from <the failed step>`. A resumed run asks again for nothing its
  account already has.

## As run on 12 Nov (08:30 to 08:46 UTC)

Every section went as written, with no fix to any script. The transactions are in INTERFACES.md 38.

1. **Before:** the four built files had the hashes in the table above, and a fresh snapshot matched the one taken on
   11 Nov.
2. **Test NEAR, the seed's rule, the factory's redeploy, its settings:** four keychain approvals, 08:31 to 08:35.
   OutLayer's queue was short: the new gateway and the new engine both answered inside a minute.
3. **Services** started at 08:35. The gate's dry run found nothing in the way.
4. **The gate** ran from 08:36:06 to 08:46:21, about 10 minutes, not the 20 to 30 expected. Every step passed at
   its first try. Pass point `loan_home` at 08:42:27; `pass: true` for the whole run.
5. **After:** the three services stopped. The float unwrapped its WETH by itself at `btc_home`, so
   `scripts/aave-spike.mjs --unwrap` wasn't needed.

**For the next run or the click-through:**
- The float holds 0.04599 test ETH: enough for one run at a time (0.0252 in it), each costing 0.002.
- The float holds $0.005 of test USDC, so the next USDC move to Base Sepolia mints from Aave's faucet. The node
  ran that mint without sending it and it would go through. The faucet gives one address one token once an hour.
- `pbf-keeper.testnet` holds 6.63 NEAR. Another gate run needs 6 more from `pbf-ops.testnet` (11.18) first.

