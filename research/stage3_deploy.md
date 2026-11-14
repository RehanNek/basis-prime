# Stage 3 on testnet: the deploy sitting (written 11 Nov before it; run that evening, 20:42 to 21:17 UTC)

Everything here is NEAR testnet and Base Sepolia. Nothing touches a mainnet. The NEAR steps ask the user's keychain.
`research/stage2_deploy.md` has the same steps for stage 2, with what went wrong there: an RPC error on a large
deploy (send it again after checking that nothing landed), and a file storage that needed a moment after an upload.

## 0. Before the sitting (no approvals)

1. Every suite passes on the final code: engine, contracts with the sandbox tests (`--test aave`, `--test lender`,
   `--test upgrade` and the test that redeploys over the live stage 2 factory), JavaScript.
2. `contracts/build.sh --sizes`: the account and the factory changed; the pool did not.
3. The enclave builds, from `risk/`, one at a time, with their sha256 and size:
   `RUSTFLAGS="--remap-path-prefix=$HOME=~" cargo build -p pb-risk --target wasm32-wasip2 --release`, then `pb-gateway`.
4. A snapshot of the live pool and factory (the session's `snapshot.py`), to compare afterwards.

**Section 0 was done on 11 Nov, about 19:30 UTC:**
- Engine 313, contracts 625, JavaScript 569, all passing. `upgrade_stage3` passes over the live stage 2 factory saved in
  `contracts/target/live-stage2/`.
- To deploy: account 511,105 B `fae0d5bd…6836`; factory 743,483 B `317efd5a…54c7`; `pb-risk` 1,632,648 B
  `53cb13ba91403a0c72bf72fdfe76cccccad078f64a6d1e9d49a85361d6535767`; `pb-gateway` 1,555,171 B
  `6bdc21f66476c14dfda7e94d9257b7ccc53e4621d4c518b763dba1d98226455b`. The pool is unchanged.

## 1. Test NEAR, from `pbf-ops.testnet` (25.18 NEAR on 11 Nov)

| To | NEAR | Why |
|---|---|---|
| `pbf.testnet` | 2 | The factory's code grows by about 39,000 bytes; it has 0.97 NEAR free, and the redeploy alone would leave about 0.55 |
| `pbf-keeper.testnet` | 6 | It holds 6.85; the gate's fresh account takes 6, and its checks and gas about 0.6 |

## 2. The engine builds (OutLayer, signed by `pbf-keeper.testnet`)

As in stage 2, for each of `pb-risk` and `pb-gateway`: `outlayer upload <wasm>`, fetch the FastFS URL back and check
size and sha256, then `outlayer deploy <name> <url> --hash <sha256> --no-activate`.

Then let the new gateway open the agents' seed without locking the older ones out: `update_access` on
`outlayer.testnet`, signed by `pbf-keeper.testnet`, 30 TGas, 0.01 NEAR, with stage 2's arguments
(`research/stage2_deploy.md`, section 4) and the new hash added as a fourth `WasmHash`:
`fcae6052…`, `6746393a…`, `e5d4b324…` (stage 2) and the stage 3 build. Check that the new build answers
`agent_address` for `demo1.pbf.testnet` with `0x68643293a2b557f696b7d485b4e1ddaac4a2d46a`. OutLayer's waiting calls
can time out when its queue is long: submit with `async: true` and poll `/calls/<id>`.

## 3. The factory (`pbf.testnet`)

1. Its stored state doesn't change shape in stage 3, so it is a plain redeploy, with **no init call**. Calling
   `migrate` again would be refused.
   `near contract deploy pbf.testnet use-file contracts/target/near/pb_factory/pb_factory.wasm without-init-call network-config testnet sign-with-keychain send`
2. Check: `account_code_hash` is the new account build's; the config and the list of accounts are what they were.
3. As the operator, `set_config` with the config just read and these replaced or added:
   - `risk.version_key` and `gateway.version_key`: the stage 3 builds;
   - `lenders.aave`:

```json
{"chain_id": 84532, "pool": "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
 "usdc": {"symbol": "USDC", "address": "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", "decimals": 6},
 "collateral": [{"symbol": "WBTC", "address": "0x54114591963CF60EF3aA63bEfD6eC263D98145a4", "decimals": 8},
                {"symbol": "WETH", "address": "0x4200000000000000000000000000000000000006", "decimals": 18}],
 "max_fee_per_gas": "1000000000"}
```

   `lenders.rhea` stays. Accounts made before this keep their code and config, and can't use Aave.

## 4. Services

`.env` needs nothing new: `EVM_GAS_PRIVATE_KEY` and `RHEA_ACCOUNT_ID` are there, and `EVM_RPC_URL`, `EVM_CHAIN_ID` and
`OUTLAYER_WAIT_MS` have defaults. Start the backend and the keeper from `.claude/launch.json` (the Aave gate has no
hedge, so the 1Click stand-in isn't needed). The backend's first lines must say chain 84532; `GET /api/evm/gas` must
say `on: true` with the gas wallet's balance; `GET /api/lenders` must show `collateral_room` for WBTC and WETH.

## 5. The gate

1. `pnpm --filter @pb/keeper funding:demo -- --lender aave --dry-run`: it must list nothing in the way.
2. `pnpm --filter @pb/keeper funding:demo -- --lender aave`. It writes `research/data/phase6_funding_aave.json` after
   every step, and `--from <step>` picks it up again.
3. Gate 3 passes when: the account borrowed on Aave's test market through Chain Signatures; the engine's verdict
   showed the position; it repaid and withdrew. The record says which collateral was used (WBTC when Aave's pool had
   room, wrapped test ETH otherwise) and whether our pool lent a part too.

## If something fails

- **The factory's redeploy:** the stage 2 code is saved in `contracts/target/live-stage2/factory.wasm`.
- **A signed Ethereum transaction that reverts or never lands:** its nonce must still be used before the account
  drops the listing. Send it anyway, or let the keeper bump it once; the engine reads the real position.
- **The gate:** fix, then `--from <the failed step>`.

## As run on 11 Nov (20:42 to 21:17 UTC)

Sections 1 to 4 went as written; the transactions are in INTERFACES.md 35. The gate needed three fixes to its own
script, none to a contract or the engine:

1. **The first run stopped at `fund`:** the engine lends nothing to an account worth under $1,000, and the gate's book
   was $481.61. The gate now deposits $1,200 of test USDC. Resumed with `--name fund-aave-11112049 --from fund`.
2. **The resume was refused by the dry-run checks:** they asked the gas wallet for a second wrap. Fixed; resumed again.
3. **The settlement step looped:** it read the account's `settle()` answer (`true`), not the pool's record. Stopped by
   hand, fixed, resumed with `--from settle`. Gate 3 passed at 21:17:35.

Afterwards the gas wallet unwrapped the 0.02 WETH it got back: `node scripts/aave-spike.mjs --unwrap --send`. It
holds 0.048 test ETH, enough for one more run on the wrapped path. Before a second one, send it test ETH on Base
Sepolia.
