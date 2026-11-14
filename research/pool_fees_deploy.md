# The pool's three fixes on testnet: the deploy sitting (written 12 Nov, before it; not run yet)

NEAR testnet only. Nothing touches a mainnet. Two steps ask the user's keychain: the pool's new code with its
migration, and the factory's redeploy. The engine and the gateway don't change: nothing is published on OutLayer and
the factory's settings stay.

What is being deployed: the rules of INTERFACES.md 45, for the audit's P3, P5 and P4. The pool's part reaches every
account at once. The account's part (it tells the pool the debt before and after a lender borrow) reaches accounts
made after the factory's redeploy.

## 0. Before the sitting (no approvals). Done on 12 Nov

1. Suites on the joined code, by the main session's own runs: contracts 682 (was 666), with the migration over the
   live pool's code and state as fetched at 19:50 UTC (`upgrade_pool_fees.rs`, `contracts/target/live-pool-fees/`)
   and the account's two-ended settlement against the new pool and the old one (`p4_closes.rs`); JavaScript 649
   (keeper 202, backend 156, stand-in 54, its client 12, app 225); `pnpm -r build` and the app's lint clean. The
   engine wasn't touched (329).
2. `contracts/build.sh --sizes`: the pool, the account and the factory changed.
3. The pool's changes were read line by line against a copy of the source from before: the new storage key is the
   last, and no stored record changes shape.

**To deploy:**

| What | Size | sha256 |
|---|---|---|
| Pool (with `migrate` as its init call) | 478,954 B | `ca21d5336508de33b0e2c9ff068877bbf85d9b561ed1eb8d61c7f64a6963ab4c` |
| Account | 515,363 B | `b8acf77b236f0559c5bbf51ee1f7cf5134bf0933999a595b8c5776608e3b1269` |
| Factory (a plain redeploy, no init call) | 748,243 B | `2cb452a5dd667eeab46688212fa0496fd6219965447dfda26484373acbb92609` |

The pinned programs stay `pb-risk` `fb2cee3b…` and `pb-gateway` `fba556c2…`. If any contract source file changes
before the sitting, build again and replace these.

**NEAR:** the pool account holds 6.77 and the new code locks 0.147 more: 1.92 stays free. The factory has 2.55 free
and locks about 0.006 more. No top-up.

## 1. The pool (`pool.pbf.testnet`). Keychain

1. The keeper, the backend and the stand-in are stopped.
2. Save every view first: `get_params`, `get_pool`, and `get_borrower`, `debt_of` and `get_pricing` for each
   account (the session's `snapshot.py`, plus the pricing views).
3. Deploy with the migration in one transaction, signed by the pool account's own key:
   `near contract deploy pool.pbf.testnet use-file contracts/target/near/pb_pool/pb_pool.wasm with-init-call migrate json-args '{}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send`
   A `migrate` that fails fails the whole transaction: the pool keeps its code and its state.
4. Check: the code on chain is the built file's (`ca21d533…`). Every saved view answers the same, with these
   differences only: `pricing_limits` gains `max_lender_debt` "1000000000000", `account_fee_day` "1000000000" and
   `pool_fee_day_bp` 50; `get_pool` and each `get_pricing` gain `fees_reversed` "0". `min_period_ns` stays 2 minutes
   and the funding order stays `lender_first`. A second `migrate` is refused.

## 2. The factory (`pbf.testnet`). Keychain

1. `near contract deploy pbf.testnet use-file contracts/target/near/pb_factory/pb_factory.wasm without-init-call network-config testnet sign-with-keychain send`
2. Check: the code on chain is the built file's; `account_code_hash` is `b8acf77b…`; the config and the accounts
   are what they were.

## 3. Services

1. `pnpm -r build`, then start `shim`, `api` and `keeper-one` from `.claude/launch.json`. `keeper-one` now follows
   the factory's newest account (`--newest 1`), which keeps the keeper's reads under FastNEAR's free limit.
2. **OutLayer must answer from this machine.** On 12 Nov a VPN exit in the Netherlands could not reach it. Check
   before a gate: `curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://testnet-api.outlayer.ai/health`.

## 4. The gates, on the new code, one at a time

1. **Gate 2:** `pnpm --filter @pb/keeper funding:demo -- --lender rhea --dry-run`. It must name the pool's three fee
   limits and the hedge's two prices, with nothing in the way. Then without `--dry-run`. In the record,
   `settle_fee` shows a fee near 200 micro-USD with `cut` "0", and `settle_subsidy` a subsidy with `cut` "0".
2. Wait until gate 2 has ended. Then **gate 4:**
   `pnpm --filter @pb/keeper funding:demo -- --lender aave --moves --dry-run`, then without.
3. The keeper holds 20.9 test NEAR; each run takes about 6.7. Gate 4 uses 0.002 test ETH; the float holds 0.044.
4. What can hold a run up, none of it this change: Hyperliquid testnet's own limit on a price's distance from its
   oracle (the hedge waits); 1Click with no quote for a pair for a minute or two (go on with `--from <step>`).
5. **Before any `--from`:** the record must hold every step before the one named, or the runner runs them.

## 5. After

- Stop the three services.
- Record it: `research/audit.md` (P3, P5 and P4 marked, with their tests and the deploy), INTERFACES.md ("the pool's
  fixes live"), FUNDING.md 11, the README, the memory notes.

## If something fails

- **The pool's deploy:** it is one transaction; a failure changes nothing. Read why before trying again.
- **After a good migration,** the old code can't read the new state. The way back is forward: a fix in the new
  code. That is why the migration was run first over the live state in the sandbox.
- **The factory's redeploy:** the code of before is `contracts/target/live-pool-fees/factory.wasm` (`638f17b1…`).

## As run (12 Nov, 21:40 to the end of the sitting; all times UTC)

**The deploy.**

| When | What | Result |
|---|---|---|
| 21:39 | OutLayer answered again from this machine (the VPN was off). Every pool view saved for all 13 accounts | |
| 21:40 | The pool: new code with `migrate`, one transaction, signed by `pool.pbf.testnet` | tx `3kspWJHLMCUK3uHfe1YcayYLx7viS96nYinJvAC31NxG`. Code on chain: `ca21d533…` (code hash `Ec3H4Mxd…`) |
| 21:41 | Every view read again and compared | The only differences: the three new limits ($1,000,000, $1,000, 50 bp), `fees_reversed` "0" in `get_pool` and each `get_pricing`, the code hash and the storage (+14,675 B). `min_period_ns` 2 minutes, order `lender_first` |
| 21:42 | The factory: plain redeploy | tx `HUpN4TDEdvWSu2e4kg14tMfkKAJJRnjFQ5wZuUCej2J`. Code on chain: `2cb452a5…`; `account_code_hash` `b8acf77b…`; config and accounts unchanged |
| 21:43 | `shim`, `api`, `keeper-one` started. Gate 2's dry run named the pool's three fee limits; nothing in the way | |

**Gate 2 (the Rhea gate), three starts.**

1. **`fund-rhea-11122143.pbf.testnet`, 21:43: stopped at `to_hl`.** Hyperliquid testnet's API answered 502 from
   21:44:50 to 21:46:20. Nothing moved on Hyperliquid. The account still lists `move:0`, and the $430 of test mUSDC
   it sent stays with the stand-in. Record: `research/data/phase6_funding_rhea.stopped-hl-outage-2026-11-12.json`.
2. **`fund-rhea-11122148.pbf.testnet`, 21:48: stopped at `approve`.** Hyperliquid answered the agent's approval
   "duplicate nonce", and a second approval "Extra agent already used": it had taken the first one. The gate's
   `approve` step now reads Hyperliquid's list of agents first and signs nothing when the agent is there
   (`services/keeper/src/hedge-steps.ts`, `stepApprove`; a test script's change, not the product's).
3. **The same account from `approve`, 21:53 to 22:07: every step passed up to the hedge's close.** On the migrated
   pool and the new account code:
   - `fund`: $1,052.37, $544.17 from Rhea and $508.21 from our pool, in one client signature.
   - `settle_fee`: a fee of 206 micro-dollars for 238 s, `cut` "0". `settle_subsidy`: a subsidy of 174 for 175 s,
     `cut` "0". The pool's own record for the account says the same (`get_pricing`: `fees_charged` "206",
     `fees_reversed` "0", `subsidy_paid` "174").
   - `top_up`: the keeper alone repaid Rhea after the test price fell, 65 s.
   - `repay_rhea`, `repay`, `credit`, `rhea_withdraw`: passed. The pool is owed nothing and its last report shows
     Rhea's debt as 0.
   - **`close_short` stopped.** Hyperliquid refused six of the eight close orders with its own "Price too far
     from oracle" (its testnet mark stood 2.4% over its oracle; our gateway let each order through). 0.00073 BTC
     closed and 0.01427 stayed open. The step then failed on something else: the stand-in's float held 0.00011 BTC
     from an earlier run, worth $8, under Hyperliquid's $10 minimum, and couldn't be flattened. The step now writes
     that down and doesn't fail on it (`stepCloseShort`).

**Gate 4 (the moves), `fund-move-11122212.pbf.testnet`: passed at 22:36 on its third start.**

1. **22:12, stopped at `loan_home` (22:18):** "the verdict was already used: ask for a new check". The backend's
   quote had named no check: it reads the account's `loan` record, and the pool's part of the plan had landed one
   hop earlier. The gate's `runMove` now asks the quote again in that case. Nothing had moved.
2. **22:20, from `loan_home`: stopped again at 22:31.** The first try had left a committed quote open at the
   stand-in for the same amount. The stand-in matched the deposit to that one and delivered the $21.70 at 22:22;
   the script waited on the second quote for 10 minutes. On chain the account held the money and listed no move.
3. **22:32, from `loan_home`: passed, 22:36.** `loan_home` took the delivery as done; `usdc_out`, `usdc_arrived`,
   `repay_aave`, `repay`, `aave_withdraw`, `btc_home`, `withdraw`, `float` each passed. The float used 0.002 test
   ETH. Record: `research/data/phase6_funding_moves.pool-fixes-2026-11-12.json`; the two stopped records are
   beside it (`…stopped-loan-home-2026-11-12.json`, `…stopped-loan-home-2-2026-11-12.json`).
4. Checked apart from the script on both chains: no loan, nothing owed to the pool or to Aave, both tokens out.

**Gate 2, the last three steps: passed at 23:12.** Hyperliquid testnet's mark came back to 1.48% over its oracle at
about 23:08. From `close_short`: the whole short closed in one fill (0.01427 BTC at $72,693.40), $440.26 came home
from Hyperliquid, both tokens were withdrawn. **Gate 2 passed in full: all 26 steps**
(`research/data/phase6_funding_rhea.pool-fixes-2026-11-12.json`). Checked apart from the script: the account is
flat on Hyperliquid, has no loan, holds no token, and owes neither our pool nor Rhea. The resume needs the keeper
running: the gate's own pre-check asks for a tick in the last 4 minutes (`keeper-hedge` in `.claude/launch.json`
watches that one account).

**Both gates have passed on the pool's new code. The three services are stopped (23:13).**
