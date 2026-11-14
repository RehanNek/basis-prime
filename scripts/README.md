# Scripts

Ready:

| Script | What it does |
|---|---|
| `set-env.sh NAME` | Saves one value into `.env` without showing it. Paste the value when asked, or pipe a command's output in. For a NEAR private key it picks the `ed25519:...` part out of the export line |
| `new-hl-float.py` | Makes the testnet-only Hyperliquid float wallet and saves it in `.env` without showing the key (`python3 -I scripts/new-hl-float.py`). It refuses to replace a saved float unless given `--force`. With `--gas` it makes the Base Sepolia gas wallet for Aave's test market instead (`EVM_GAS_PRIVATE_KEY`, `EVM_GAS_ADDRESS`; FUNDING.md 9) |
| `aave-spike.mjs [--weth] [--unwrap] [--send]` | A live round trip on Aave's test market on Base Sepolia with the gas wallet standing in for a client: supply, borrow, repay, withdraw, with each call's gas. `--weth` posts wrapped test ETH (Aave's WBTC pool has been full). `--unwrap` only turns the wallet's WETH back into test ETH, which an Aave gate on the wrapped path needs afterwards. Without `--send` it only reads. Testnet only |
| `bridge-gas.mjs <eth> [--send]` | Moves test ETH from the gas wallet on Sepolia (Ethereum's test network) to the same address on Base Sepolia, through Base's own bridge (`node scripts/bridge-gas.mjs 0.002`, with Node 24). Without `--send` it only simulates. It reads the key from `.env` and never prints it, and refuses any chain but Sepolia and any destination but Base's bridge. A deposit took about 5 minutes on 11 Nov |
| `rhea-setup.sh [--go]` | Sets up our copy of Rhea at `rhea.pbf-ops.testnet`: creates the account with 11 NEAR, deploys Rhea's own file (`vendor/burrowland/`) and checks its code hash, lists mUSDC and mNBTC with fixed prices, supplies 1,000,000 mUSDC, and has the operator borrow part of it back so the copy charges about mainnet's rate. Without `--go` it only reads testnet and shows what is left. Each step is skipped once done. The first pricing of nBTC needs `BTC_USD=<whole dollars>`. Sandbox-tested (`contracts/tests/tests/rhea.rs`); not yet run on testnet |
| `shim-setup.sh` | Sets up the 1Click shim's NEAR testnet float: creates `shim.pbf-ops.testnet` with 1 NEAR from `pbf-ops.testnet`, saves `SHIM_NEAR_ACCOUNT_ID`, `SHIM_NEAR_PRIVATE_KEY` and a random `SHIM_ADMIN_TOKEN` in `.env`, and registers the float on mUSDC and mNBTC and mints test tokens into it. Skips what is done already, so running it again just tops up the tokens |

The shim's live tests are package scripts: `pnpm --filter @pb/oneclick-shim live:near` (delivery and the three
faults on NEAR testnet) and `live:hl` (delivery on Hyperliquid testnet, which needs the Hyperliquid float).

Planned, by phase (PLAN.md 11):

| Script | Phase | What it does |
|---|---|---|
| `testnet-setup` | 1–2 | Deploys the contracts, mints test tokens, funds the pool. The testnet accounts themselves were made by hand in Phase 0 |
| `fund-hl` | 0 | Sends test USDC from the Hyperliquid testnet float account to an account's derived address |
| `demo` | 2–4 | The end-to-end testnet run: fund the pool → create account → deposit → hedge → borrow → depeg drill → deleverage → repay → withdraw. The README's steps are this script |
| `build-reproducible` | 6 | Builds the contracts and the OutLayer programs reproducibly, so anyone can match the hashes |

The Phase 0 checks that need no keys live with the other research scripts in `research/scripts/`
(for example `day1_hl_testnet.py`).
