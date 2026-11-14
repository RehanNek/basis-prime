# The account's Low fixes on testnet: the deploy sitting (written in the night of 12 to 13 Nov; RUN on 13 Nov, 09:52 to 10:56 UTC: both gates passed)

NEAR testnet only. Nothing touches a mainnet. Two steps ask the user's keychain: the factory's redeploy, and one
operator call on the pool. The pool's code, the engine and the gateway don't change: no pool deploy, nothing
published on OutLayer, no `set_config`.

What is being deployed: the rules of INTERFACES.md 47, for the audit's A10, A12 (the rest), A13, A15, A16 and A17
(items 3 and 4). All of it is in the account contract, so it reaches accounts made after the factory's redeploy.
A11 is not in it (`research/audit.md`, "The account's Low findings", says why).

## 0. Before the sitting (no approvals). Done in the night of 12 to 13 Nov

1. Suites on the joined code, by the main session's own runs (12 Nov, 23:14 to 23:45 UTC): contracts 696 (was
   682), with the factory's redeploy over the live factory's code and state as fetched at 22:55 UTC
   (`upgrade_low.rs`, `contracts/target/live-low/`) and the Rhea top-up against the real pool (`lender.rs`);
   JavaScript 655 (keeper 205, backend 157, stand-in 54, its client 12, app 227); `pnpm -r build` and the app's
   lint clean. The engine wasn't touched (329).
2. `contracts/build.sh --sizes`: the account and the factory changed; the pool is byte for byte the live one.
3. Every changed line of `contracts/account/src/lib.rs` and `plan.rs` was read against a copy of the source from
   before (scratchpad, `before_fixes/src_before_low_2026-11-12.tar`).

**To deploy:**

| What | Size | sha256 |
|---|---|---|
| Account | 535,378 B | `79827e65a44d0edb1c640ea4401c3fcdf53e22aed10e7339b7e40a98f6470ea4` |
| Factory (a plain redeploy, no init call) | 768,255 B | `66cb907098640365ae9c52762e90ae548d9f35958b8a81d893201d9f449c3a95` |

The pool stays `ca21d533…`, and the pinned programs stay `pb-risk` `fb2cee3b…` and `pb-gateway` `fba556c2…`. If any
contract source file changes before the sitting, build again and replace these.

**NEAR:** the factory holds about 10 and locks about 0.2 more for the larger account code; in the sandbox, over
the live factory's code and state, 2.3 stays free. No top-up. A new account still opens with 6 NEAR, which now
leaves it 0.61 free (0.81 before).

## 1. The factory (`pbf.testnet`). Keychain

1. The keeper, the backend and the stand-in are stopped.
2. `near contract deploy pbf.testnet use-file contracts/target/near/pb_factory/pb_factory.wasm without-init-call network-config testnet sign-with-keychain send`
3. Check: the code on chain is the built file's; `account_code_hash` is the new account's; `get_config`,
   `list_accounts`, `accounts_count` and `is_paused` answer what they answered before.

## 2. A step price for the test bitcoin (`pool.pbf.testnet`, signed by `pbf-ops.testnet`). Keychain

A top-up at Rhea now asks the pool's `check_step` first (47.7). The pool counts a step in a token other than USDC
at the operator's step price, and refuses a token that has none. The live pool has none for the test bitcoin
(read from its state on 12 Nov at 22:55 UTC). Gate 2's top-up repays in USDC and needs none, but a top-up that
posts more bitcoin at Rhea (`l_add`) would be refused without it.

`near contract call-function as-transaction pool.pbf.testnet set_step_price json-args '{"token":"mnbtc.pbf-ops.testnet","decimals":8,"price":"80000000000"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as pbf-ops.testnet network-config testnet sign-with-keychain send`

That is $80,000 a coin, in micro-dollars: above the market on purpose, as the pool's own note on the method says.
It moves no money and changes no loan. Check: the transaction's `set_step_price` event.

## 3. Services

`pnpm -r build`, then `shim`, `api` and `keeper-one` from `.claude/launch.json`. OutLayer must answer from this
machine (no VPN exit that blocks it): `curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://testnet-api.outlayer.ai/health`.

## 4. The gates, on the new code, one at a time

1. **Test NEAR first.** The keeper holds about 2.4; each gate's new account takes 6 and about 0.7 more. About 11
   more is needed: two faucet accounts of 10 (`pbf-fund10.testnet` and `pbf-fund11.testnet` were free names on
   12 Nov), each sending 9.9 to `pbf-keeper.testnet`.
2. **Gate 2:** `pnpm --filter @pb/keeper funding:demo -- --lender rhea --dry-run`, then without `--dry-run`. Its
   `top_up` step is the changed path: the keeper's step now goes account, pool (`check_step`), account, Rhea.
3. Wait until gate 2 has ended. Then **gate 4:** `pnpm --filter @pb/keeper funding:demo -- --lender aave --moves --dry-run`,
   then without. Its two moves home now carry `expect`.
4. What can hold a run up, none of it this change: Hyperliquid testnet's own limit of about 2.5% from its oracle
   price (the hedge waits; INTERFACES.md 46); 1Click with no quote for a pair for a minute or two.
5. **Before any `--from`:** the record must hold every step before the one named, and the keeper must be running
   (the gate asks for a tick in the last 4 minutes). For an account that isn't the factory's newest, `keeper-hedge`
   in `.claude/launch.json` shows how to watch one by name.

## 5. After

- Stop the three services.
- Record it: `research/audit.md` (the findings marked live), INTERFACES.md ("the Low fixes live"), FUNDING.md 11,
  the README's audit line, the memory notes.

## If something fails

- **The factory's redeploy:** a plain redeploy changes no state. The code of before is
  `contracts/target/live-low/factory.wasm` (`2cb452a5…`): deploy that file the same way to go back. Accounts made
  in between keep the code they were made with.
- **A gate fails on the new account code:** older accounts are untouched, and so is the pool. Going back is the
  factory's old file, as above.

## As run (13 Nov, UTC)

**09:52, before.** The built files are the table's (`66cb9070…`, `79827e65…`, pool `ca21d533…`); the only file
newer than them is a test (`contracts/tests/tests/lender.rs`). OutLayer answers 200. No service is running. On
chain: the factory is `2cb452a5…` with 10.08 NEAR and 16 accounts, not paused; the pool's `step_price` for the test
bitcoin answers `null`; the keeper holds 2.73 NEAR; `pbf-fund10.testnet` and `pbf-fund11.testnet` don't exist.

**09:53:31, step 1, the factory.** Transaction `5bcvE6vsaieHAjXvFFPeCSpZRmaTU4bzmAstoZ8sZtV7`. Checked after:
the code on chain is `66cb907098640365ae9c52762e90ae548d9f35958b8a81d893201d9f449c3a95`; `account_code_hash`
answers `79827e65a44d0edb1c640ea4401c3fcdf53e22aed10e7339b7e40a98f6470ea4`; `get_config`, `accounts_count` (16),
`is_paused` (false) and `list_accounts` answer byte for byte what they answered before (saved in the scratchpad,
`low_deploy/`). Storage 751 KB to 771 KB; 10.079 NEAR held.

**09:53:56, step 2, the step price.** Transaction `4rByENy1LMCqV4EpFNUoBDMakj8AkPqJPZQcjBxYAExf`, with the pool's
`set_step_price` event. `step_price` now answers `{"decimals": 8, "price": "80000000000"}`.

**09:54, step 3, services.** `pnpm -r build` clean; `shim`, `api`, `keeper-one` up. The keeper set our Rhea
copy's price back to the oracle's on its second tick (it had drifted 3.51% overnight; transaction
`JBG9n5Mebsno7UEQQvwkqptizDJZnfpRm5sZjMudkuFE`).

**09:54:36, gate 2's dry run.** One thing left in the way: the keeper's 2.73 NEAR. Hyperliquid's mark was 0.13%
over its oracle, so its own limit isn't near.

**10:08, waiting.** The user was given the four faucet commands at 09:53; by 10:08 neither account existed. The
three services were stopped. **To go on:** the keeper needs about 6.7 NEAR for each gate; then step 3 again and
step 4.

**10:09, the test NEAR.** The user made `pbf-fund10.testnet` and `pbf-fund11.testnet` and sent 9.9 from each:
the keeper held 22.53 NEAR.

**10:10, services again; 10:11:14, gate 2's dry run:** nothing in the way. Hyperliquid's mark 0.05% over its
oracle; our Rhea copy's price 0.04% from it.

**10:11:28 to 10:30:56, GATE 2 PASSED in one run.** `fund-rhea-11131011.pbf.testnet`, 26 steps. The top-up
(`top_up`, 60 s): cushion 1.30, the keeper's `l_repay` of $70.76 (transaction
`5HXw3BKGzf1Cs9bPTqwBWPAUUw6pjaS9SpUWMTHgPAqX`, through the pool's `check_step`), cushion 1.50. The close of the
short filled at its first try, at $69,323.70. Record copied to `research/data/phase6_funding_rhea.low-fixes-2026-11-13.json`.

**10:31:43, gate 4's dry run:** nothing in the way. **10:32:00 to 10:55:52, GATE 4 PASSED in one run.**
`fund-move-11131031.pbf.testnet`, 18 steps. One refusal inside `loan_home`, put right by the step (the keeper's
own check had replaced the gate's verdict: the audit's A4). The float used 0.002001 test ETH. Record copied to
`research/data/phase6_funding_moves.low-fixes-2026-11-13.json`.

**10:56, after.** The three services stopped. Checked by the main session on chain: both accounts run
`79827e65…`; the pool is owed 0 by each; neither holds a token; nothing owed at Rhea or at Aave; no position on
Hyperliquid. The keeper holds 10.35 NEAR. Details: INTERFACES.md 47.11.
