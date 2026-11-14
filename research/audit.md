# Contract audit (Phase 5, 9 Nov 2026)

INTERFACES.md 23 asks for this: every contract we deploy, checked against the `near-contract-audit` skill's list
(`.claude/skills/near-contract-audit`) and PLAN.md 5.1's, plus the threats in PLAN.md 7 and the limits in
RISK_ENGINE.md 12.2.

**Scope.** The factory (`contracts/factory`), the account (`contracts/account`), the pool (`contracts/pool`), the shared
types (`contracts/types`), the testnet drill (`contracts/testnet/drill`) and the test tokens
(`contracts/testnet/token`). The sandbox mocks (`outlayer-mock`, `mpc-mock`, `borrower`) never leave the sandbox. The
Phase 0 probe holds no client money and only its listed owners can run it; it was read, not audited.

**The code audited is the code deployed.** Read-only RPC (`view_account`, `view_code`, 9 Nov): `pbf.testnet` runs
`f7efc538…`, `pool.pbf.testnet` `f9c3b708…`, `drill.pbf-ops.testnet` `d3fd4308…`, both test tokens `f17e208d…`, and
`drill1.pbf.testnet` (the account code new accounts get) `1a293b2a…`. Each is the hash of the wasm built from this
tree before the audit. Older client accounts run older account code: `hedge1` the Phase 3 build (`f90746a0…`),
`demo1` the Phase 2 one (`98c2ca6c…`).

**How.** Every line of the six crates was read. Clippy ran on the wasm target with `arithmetic_side_effects` and
`indexing_slicing` on: every hit was checked by hand, and none can panic in a callback. Access keys were listed
read-only: `pbf-ops.testnet`, `pbf.testnet`, `pool.pbf.testnet` and `drill.pbf-ops.testnet` each hold one full-access
key; client accounts hold none.

## Findings

| Id | Severity | Contract | Where | Finding | Status |
|---|---|---|---|---|---|
| A1 | High | account | `account/src/lib.rs:417`, `:444`, `:501`, `:847`, `:1222` | A verdict read while a loan or a withdrawal was on its way carries the new counter, so it still backs an action after the money moves. Worst case: a check read before the pool lent sees no loan and lets the loan straight out | **Fixed** for new accounts |
| A2 | Medium | account | `account/src/lib.rs:1185`, `:863`, `:876`; `account/src/records.rs:108` | One DEFAULT verdict blocked the account for good and wrote off its debt, with no second check and no way out | **Fixed** for new accounts |
| A3 | Low | pool, factory, drill | `pool/src/admin.rs:18–164`, `pool/src/lib.rs:480`, `factory/src/lib.rs:283`, `:291`, `testnet/drill/src/lib.rs:81` | Admin methods take no 1 yoctoNEAR, so a function-call key of the operator could call them without a wallet prompt | Open: change with the web app |
| A4 | Low | account | `account/src/lib.rs:372`, `:1156` | Anyone may ask for a check, and each accepted verdict replaces the held one, so a stranger can keep spoiling the owner's borrow verdict | Open (documented, INTERFACES.md 4) |
| A5 | Info | account | `account/src/lib.rs:144`, `:471` | `loan.open` is closed by a repayment that comes back partly unused; that reasoning rests on receipt order | No fix |
| A6 | Info | account, pool | whole contracts | Client accounts can never take new code, and the pool can't stop lending to one account | Open |
| P1 | Info | pool | `pool/src/admin.rs:149` | `publish_version` scans every published version | No fix |
| P2 | Info | pool | `pool/src/lib.rs:396` | `on_lent` trusts the shape of its own token's answer | No fix |
| F1 | Info | factory | `factory/src/lib.rs:222` | An account whose pool registration failed can't be registered again | Open |
| D1 | Info | drill | `testnet/drill/src/lib.rs` | INTERFACES.md 21 changes the stored layout | **Done**: `migrate`, tested from the live code |
| T1 | Info | token | `testnet/token/src/lib.rs:54` | Anyone can mint any amount | By design, testnet only |
| X1 | Info | account | `account/src/verdict.rs:111` | The verdict's `since` (ns) is a JSON number above 2^53 | No fix |

No Critical finding. Severity is how much the pool or a client could lose, and how hard it is to get there.

### A1 (High, fixed): verdicts read while money is on its way

**What.** `borrow`, `withdraw`, and the `sell` and `to_hl` plan steps bump the counter as they start, but the money
moves a block or more later. `pb-risk` reads "the latest final block" when OutLayer runs it
(`risk/pb-read/src/read.rs:241`). A check whose read lands in between carries the new counter, passes
`nonce == counter`, but doesn't show the money that is moving. Nothing made it unusable afterwards.

**Worst case.** The owner calls `borrow`, and a check reads the account before the pool has lent: no loan, so the
engine allows any withdrawal (with no loan the pool can't lose). `pb-risk` doesn't treat a pending borrow as debt
(`risk/pb-read/src/near.rs:257`). Once the loan has arrived, `withdraw` with that verdict passes every check, and the
loan leaves with the client's own USDC. The pool keeps the debt. The same gap lets a second withdrawal through on a
verdict that still counts the first one's tokens.

**How likely.** The read has to land in a window of about one block, which depends on how fast OutLayer picks up
the request. The owner can try again for the price of a check. The loss is bounded by the pool's own limits
($25k in an account's first week, 10% of capital a day).

**Fix** (`contracts/account/src/lib.rs`): the counter moves on again once the money has moved.
- `on_borrowed` bumps it when the borrow ends, lent or not.
- Every token send now ends with `on_sent`, which bumps it. Before, only a 1Click move had that callback. It still
  drops a 1Click transfer whose tokens didn't go out.
- A verdict read in between carries the old counter, so it is refused when it arrives ("nonce 1 is not the counter
  2"), or spent if it arrived first ("the verdict was already used").
- A1 alone changed no stored layout: a new callback argument and two increments. `hl_withdraw` and `home` steps need
  nothing: the send window already holds back every verdict-backed action for 2 days.

**Tests.**
- Unit (`account/src/tests.rs`): `a_verdict_read_while_a_borrow_was_under_way_backs_no_withdrawal`,
  `a_verdict_read_while_a_withdrawals_tokens_were_on_their_way_backs_nothing`,
  `a_verdict_read_after_the_money_moved_backs_the_next_action`,
  `a_send_that_failed_still_moves_the_counter_on_and_drops_only_a_named_transfer`, and the counter checks in the
  borrow, withdraw and step tests.
- Sandbox (`tests/tests/account.rs`): `verdicts_read_while_a_loan_or_a_withdrawal_was_on_its_way_back_nothing`, with
  the real pool and token.
- Sandbox (`tests/tests/upgrade.rs`): `the_upgraded_live_factory_makes_working_accounts_with_the_new_code` puts the
  live factory, pool and tokens (code and state) in the sandbox. It deploys the new factory over the live one, and a
  new account made through it runs the fixed code with the live config, registered by the live pool and tokens.

**What it changes for the other parts.** A borrow, a withdrawal, and a `sell` or `to_hl` step now move the counter
on by 2. The keeper, the backend and the web app compare a verdict's nonce with the counter and ask again when it has
moved (`services/keeper/src/decide.ts`, `web/src/components/verdict-card.tsx`); none assumes steps of 1. A withdrawal
burns about 1.7 TGas more, for the callback.

**What it doesn't reach.** Accounts made before the factory carries the fix keep the old code (A6). For them, only
operational steps help: stop lending to them, or make fresh accounts for the demo.

### A2 (Medium, fixed): one DEFAULT verdict blocked the account for good

**What it was.** The first accepted DEFAULT verdict set `blocked` and had the pool write off the debt. A blocked
account could only repay, and nothing unblocked it: the pool's `unblock` cleared only the pool's flag. There was no
two-check rule as there is for DELEVERAGE.

**Why it mattered.** A wrong or compromised engine could freeze any client's funds for good with one verdict. The
pool booked a loss while the collateral stayed locked in the account, where the pool couldn't reach it either. A
compromised enclave is in PLAN.md 7's threat list.

**Fix** (`contracts/account/src/lib.rs`, `records.rs`):
1. **Two checks.** DEFAULT has its own two-check record, using DELEVERAGE's rule (`Deleverage::confirm`), but never
   confirmed at once.
   - A first DEFAULT verdict blocks nothing and writes nothing off: it logs and records when it arrived
     (`get_state().default.first_at`).
   - Only a second one 2 to 5 minutes later blocks the account and calls the pool's `write_off`.
   - Any other verdict in between, or a DEFAULT more than 5 minutes after the first, starts the pair again.
2. **A way out after review.** `lift_block()` (anyone, no deposit) asks the pool's `get_borrower(self)`.
   - Its callback `on_unblock` is `#[private]`, reads the answer with a 4 KB cap, and never panics.
   - It lifts the block only if the pool says `blocked: false` and a debt of 0. It then closes the loan record (the
     pool's debt is the authority) and clears DEFAULT's record. Otherwise it keeps the block and logs why.
   - So the operator's `unblock` in the pool, after review, lets the account go. So does a debt the client repaid
     in full if the write-off never ran.
3. **Repaying keeps working.** `repay`, the 30-minute outage repay and `repay` steps never check the block.

**What is left open.** After a write-off the pool is owed nothing, so it sends a repayment back, and money that turns
up later can't pay the pool. To count it, the pool must record each account's write-off and accept repayments
against it: a pool change, with a `migrate` and a redeploy. Not made: the pool was to change only if truly needed.

**Stored layout.** The account's state gains DEFAULT's record (one `u64`), and `get_state()` gains
`"default": {"first_at"}`. No `migrate`: client accounts never take new code. The new code refuses an old account's
state outright rather than misreading it (tested).

**Tests.**
- Unit (`account/src/tests.rs`): `a_single_default_verdict_blocks_nothing_and_writes_nothing_off`,
  `a_second_default_verdict_2_to_5_minutes_later_blocks_and_writes_off`,
  `a_second_default_too_soon_waits_for_a_later_one_and_one_too_late_starts_again`,
  `any_other_verdict_between_two_defaults_starts_the_pair_again`, `a_default_is_never_confirmed_at_once`,
  `lift_block_asks_the_pool_and_lifts_the_block_once_the_pool_has_and_nothing_is_owed`,
  `the_block_stays_while_the_pool_blocks_it_or_a_debt_is_left`, `lift_block_needs_a_blocked_account`,
  `after_the_write_off_a_repayment_still_runs_and_books_what_the_pool_takes`, and the `a_blocked_account_*` tests.
- Unit (`account/src/records.rs`): `the_same_rule_without_at_once_needs_two_verdicts_2_to_5_minutes_apart`.
- Sandbox (`tests/tests/account.rs`), with the real pool and token: `a_default_needs_two_checks_and_its_block_lifts_after_the_pools_review`.
  It runs one DEFAULT that changes nothing, the confirming one 2.5 minutes later, a repayment after the write-off,
  `lift_block` refused while the pool blocks, then lifted after the operator's `unblock`, and a withdrawal with no
  verdict. `refunds_late_arrivals_and_a_default_keep_the_records_right` also confirms its DEFAULT with two checks now.
- Sandbox (`tests/tests/upgrade.rs`): `an_old_accounts_state_needs_its_own_code_and_the_new_code_refuses_it`.

**Left for the keeper:** a second check 2 to 5 minutes after a first DEFAULT, from `default.first_at`, as it does for
DELEVERAGE (`services/keeper/src/decide.ts`).

### A3 (Low, open): admin methods take no 1 yoctoNEAR

**What.** These operator methods accept a call with no deposit:
- pool: `set_rates`, `set_caps`, `set_daily_budget`, `set_kyb`, `set_tier_override`, `clear_tier_override`, `cosign`,
  `revoke_cosign`, `set_step_price`, `set_coin_status`, `publish_version`, `set_paused`, `unblock`, and `write_off`
  when the operator calls it;
- factory: `set_config`, `set_paused`;
- drill: `set_ratio`.

So a function-call key of the operator's account for one of these contracts could, say, raise every cap or co-sign
a borrow with no wallet prompt.

**Why it is Low today.** `pbf-ops.testnet` holds one full-access key and no function-call key (read 9 Nov), and the web
app asks the wallet for no function-call key (`web/src/providers/near-provider.tsx`). On mainnet the operator is a
multisig.

**Not fixed** because the callers send no deposit: the web app's operator controls (`web/src/lib/tx.ts`: `set_kyb`,
`cosign`, `set_paused`, `set_coin_status`, `set_ratio`) and the keeper's drill scripts
(`services/keeper/src/drill-kit.ts`). Requiring 1 yocto alone would break them. **Recommendation:** add
`assert_one_yocto` to these methods and 1 yocto to those calls, in one change, before mainnet.

`set_ratio_for` and `clear_ratio_for` stay without it on purpose: INTERFACES.md 21 has the hosted backend call them
with a function-call key, which can't attach a deposit. They move no funds, and the key may call only those two.

### A4 (Low, open): anyone's check replaces the owner's verdict

**What.** `request_check` is open to anyone who pays OutLayer, and any accepted verdict replaces the held one. A
stranger can keep answering the owner's borrow or withdrawal check with a `check` of their own, so the owner's
verdict never survives long enough to use.

**Why Low.** It moves no money. It costs the stranger about $0.001 and 0.01 NEAR (mostly refunded) a time, and only
holds back borrowing and withdrawals with a loan. Repaying, deposits and withdrawals with no loan never need a verdict.
INTERFACES.md 4 already says a keeper's check can land in between.

**Recommendation** (a behaviour change): keep an unused verdict for the owner's own intent when someone else's `check`
verdict arrives within its 120 blocks, or let only the owner and the keeper ask.

### A5 (Info, no fix): how `loan.open` closes

**What.** `loan.open` turns false when a repayment comes back partly unused, which shows the pool's whole debt was
paid when the pool handled it. If a new loan were booked after the pool handled the repayment but before the
account's `on_repaid`, the close would wipe it.

**Why it can't happen.** Both paths run pool → token → account, and NEAR handles receipts from one shard to another
in the order they were sent. So a loan the pool made after the repayment reaches the account after `on_repaid`.

**One more edge.** With no principal left, a repayment the pool failed on would also close the loan, with interest
still owed: the account can't tell "nothing owed" from "the pool failed". The pool's handler gets about 50 TGas and
uses about 5, so it doesn't fail in practice.

**If the account is touched again:** pass the counter to `on_repaid` and close only if it hasn't moved. After A1, that
covers every borrow.

### A6 (Info, open): old accounts keep old code

**What.** Client accounts hold no keys and have no upgrade method, so their code is never replaced. Each also pins
its `pb-risk` and `pb-gateway` versions for good (`accept_version` was cut). So a fix in the account, A1 and A2
included, or in `pb-risk`, reaches only accounts made after it is pinned.

**And the pool can't single one out.** It can't tell old accounts from new ones, and has no switch to stop lending to
one account: its `blocked` flag also stops plan steps, and only a write-off sets it.

**Recommendation:** a pool setting that refuses new loans to accounts created before a given time (or one by one,
without stopping their plan steps). It needs a pool redeploy and a stored-layout change, so a `migrate` too: your call.
Until then, keep demo accounts fresh.

### P1, P2, F1, D1, T1, X1 (Info)

- **P1.** `publish_version` keeps every version of a program in one list and scans it on each publish. Only the
  operator adds to it, so it grows only with our own releases.
- **P2.** `on_lent`'s `#[callback_result]` panics if the token's answer isn't a `U128`. The token is the pool's own,
  fixed at `new`, and near-contract-standards always answers a `U128`.
- **F1.** If the pool's `register` fails during `create_account`, the caller gets that deposit back, but nothing can
  register the account later, so it can never borrow. **Recommendation:** an operator-only `register_again` in the
  factory, if it ever happens.
- **D1.** INTERFACES.md 21's per-account ratios add a map to the drill's state. The drill gained `migrate()`, tested
  from the deployed code (`tests/tests/upgrade.rs`). Each account with its own ratio costs the drill about 0.001 NEAR
  of storage, from its own balance.
- **T1.** `mint` is the faucet: anyone, any amount, by design. So the testnet pool's capital is play money. Nothing on
  mainnet uses this contract.
- **X1.** `since` is in nanoseconds, above JSON's safe 2^53. The contract parses it exactly (serde `u64`).
  JavaScript readers of `get_state().verdict` lose a few hundred nanoseconds. Every other number the contracts send
  above 2^53 is a `U128` or `U64` string.

## What was checked, per contract

Each line is one checklist item: the skill's detectors, then PLAN.md 5.1's list.

### Account (`contracts/account`)

- **Callbacks `#[private]`, and never panic:** `on_verdict`, `on_borrowed`, `on_repaid`, `on_hl_key`, `on_agent`,
  `on_hl_signed`, `on_step_ready`, `on_sent`, `on_unblock`. Each reads its result with `promise_result_checked` and a
  size cap, and uses saturating or checked math. Their static gas covers the calls they make.
- **Reentrancy:** state changes before every call out: the counter, `pending`, the step's `done` flag, the transfer
  record, the nonce and the send window. Callbacks undo what didn't happen (A1 adds the second bump).
- **Types in JSON:** amounts are `U128`, times in ns `U64`. Block heights, counters, step indexes and ms times are
  native, all far below 2^53 (X1 is the one exception).
- **Unsaved changes:** no `near_sdk::store` collections; every list is a bounded `Vec` in the root state, written
  when a `&mut self` method returns.
- **Owner checks:** `borrow`, `withdraw`, `forget_transfer`, `request_agent`, `hl_approve_agent`, `hl_withdraw`.
  `repay` is the owner's, or anyone's under the DELEVERAGE or 30-minute outage rule. `request_check`, `hl_init`,
  `execute_step` and `lift_block` are open on purpose (INTERFACES.md 4, 8, 14): `lift_block` only reads the pool, whose
  answer decides.
- **1 yoctoNEAR on what moves funds:** `borrow`, `repay`, `withdraw`, `forget_transfer`, `hl_approve_agent`,
  `hl_withdraw`. `request_check` and `request_agent` need at least 0.01 NEAR, so a full-access key too.
  `execute_step` takes no deposit: anyone may run it, and it runs only the stored plan.
- **Storage keys:** no collections, so no prefixes.
- **`#[init]`:** `new`, and `PanicOnDefault` on the state.
- **Unbounded loops:** none. `pending` holds at most 8 transfers and a borrow, `hl.signed` 20 entries, `hourly` 168
  hours, the margin-call clock 48 intervals, a plan 4 steps, and a verdict 4 KB, which bounds its `arrived` list.
- **Randomness:** none used.
- **Prepaid gas:** every cross-contract call has static gas. With too little attached, the call fails before any
  state changes.
- **Storage cost:** the account pays for its own bounded state from the NEAR its owner put in (about 0.38 NEAR spare,
  INTERFACES.md 14). Nobody else can grow it, beyond a 4 KB verdict that replaces the last one.
- **Math:** `overflow-checks = true` in release (`contracts/Cargo.toml`); callbacks use saturating math.
- **No floats.**
- **`ft_on_transfer`:** listed tokens only, any other is sent back in full. A loan msg only from the pool, in its
  token.

### Pool (`contracts/pool`)

- **Callbacks `#[private]`, and never panic:** `on_defunded`, `on_lent`. Both use saturating math and `unwrap_or`
  fallbacks (P2 is the one panic a malformed answer could cause).
- **Reentrancy:** `borrow` books the loan and checks every limit before the transfer, and `on_lent` undoes any part
  sent back. `defund` takes the cash first, and `on_defunded` puts it back if the transfer failed.
- **Types in JSON:** `U128`, `U64` and `I128` throughout; bp and counts as `u32`.
- **Unsaved changes:** every changed `Borrower` is put back with `insert`, and so are `entities`, `cosigns`, `coins`,
  `versions` and `step_prices`.
- **Owner checks:** every admin method calls `assert_operator` (`pool/src/tests.rs`
  `every_admin_call_is_refused_from_a_non_operator`). `register` is the factory's only. `fund` comes only from the
  operator, through the lending token. `write_off` is the account's own or the operator's.
- **1 yoctoNEAR:** `defund` and `borrow`; A3 for the admin methods.
- **Storage keys:** one `BorshStorageKey` enum of 7 distinct variants.
- **`#[init]`:** `new`.
- **Unbounded loops:** every loop runs over at most 8 tokens, 3 tiers, 25 hourly buckets or 64 coins (P1 aside).
- **Prepaid gas:** the loan sends 75 TGas and the callback 15. The account sends `borrow` 130.
- **Storage cost:** `register` and `link` charge the caller for what they add, `register` with headroom for the
  record to grow; the rest is the operator's own.
- **Math:** checked math everywhere that matters (`ok()`), rounding in the pool's favour, `overflow-checks` on.
- **No floats:** WAD fixed point.
- **`ft_on_transfer`:** only the lending token; only `{"pool":"fund"}` from the operator or `{"pool":"repay"}` from a
  registered account; anything else is refused, and the token sends it back.

### Factory (`contracts/factory`)

- **Callbacks `#[private]`, and never panic:** `on_created`, `on_registered`. They read results with a 0-byte cap,
  so only success or failure.
- **Reentrancy:** an account is listed only once it exists, and refunds go to the caller.
- **Types in JSON:** `created_at` and the deposit are `U64` and `U128`; page arguments are `u32`.
- **Owner checks:** `set_config`, `set_paused` (operator); `migrate` is `#[private]`.
- **1 yoctoNEAR:** `create_account` needs 4 NEAR anyway; A3 for the admin methods.
- **Storage keys:** one enum, one variant.
- **`#[init]`:** `new`; `migrate` is `#[init(ignore_state)]` and refuses any state but Phase 2's, so it can't
  overwrite today's (tested on the live state, `tests/tests/upgrade.rs`).
- **Unbounded loops:** at most 8 tokens; `list_accounts` pages by 100.
- **Prepaid gas:** at least 150 TGas is required, with 20, 10 and 70 TGas set for the calls.
- **Storage cost:** keeps 0.002 NEAR of each deposit for the account's record (at most about 190 bytes).
- **Math:** saturating `NearToken` math.
- **No floats.**
- **`ft_on_transfer`:** none (the factory holds no tokens).

### Shared types (`contracts/types`)

- `Config::assert_valid` bounds every field: 1 to 8 tokens, no token twice, symbols 1 to 16 bytes, USDC listed with
  6 decimals, 128-byte ids and keys, a 64-hex parameter hash, a hex chain id, a well-formed Hyperliquid token.
- Both the factory (`new`, `set_config`, `migrate`) and the account (`new`) run it.
- Borsh and JSON only; no floats; no state of its own.

### Drill (`contracts/testnet/drill`)

- **Owner checks:** `set_ratio`, `set_ratio_for` and `clear_ratio_for` are the owner's only, with the same 10,000 bp
  cap. `migrate` is the owner's, or the drill account's own, so it can be the deploy's init call (whoever holds that
  key can replace the code anyway).
- **1 yoctoNEAR:** none on purpose (A3): the drill moves no funds, and INTERFACES.md 21 needs a function-call key.
- **Storage keys:** one enum; the map's keys start with byte 0, never the root `STATE` key.
- **`#[init]`:** `new`; `migrate` is `#[init(ignore_state)]` and refuses a state already migrated.
- **Unbounded loops:** none (a `LookupMap`, never iterated).
- **Types in JSON:** `bp` is `u32` and `set_at` `U64`.
- **Storage cost:** about 100 bytes an account, paid by the drill (D1).
- **No floats.** No callbacks.

### Test tokens (`contracts/testnet/token`)

The token is near-contract-standards' `FungibleToken`, with storage management and metadata, as in its example.
Only our additions were audited:
- **`mint`:** anyone may call it (T1). It registers an unregistered receiver only if the deposit covers
  `storage_balance_bounds().min`, refunds the rest to the caller, and logs a standard `ft_mint` event. Overflow is
  refused by the standard's checked `internal_deposit`.
- **`ft_resolve_transfer`:** stays `#[private]`, and only adds a log line when refunded tokens are burned.
- **The standard methods** are delegated unchanged. `ft_transfer`, `ft_transfer_call`, `storage_withdraw` and
  `storage_unregister` keep the standard's 1 yoctoNEAR checks.
- **Storage keys:** one enum, one variant. **`#[init]`:** `new`. No floats.

## PLAN.md 7: the threats and what the contracts do

| Threat | Held by the contracts | Tested by |
|---|---|---|
| Keeper redirects funds | `execute_step` runs only the stored plan's steps, each once, with 5 minutes of quote left. Every step but a repay passes the pool's `check_step` | `execute_step_*` unit tests; `a_rebalance_runs_end_to_end_…` |
| Stale or replayed verdict | 120 blocks, the pinned program and parameter file, and the counter: one verdict, one action. A1 closes the gap while money moves | `old_reused_foreign_and_wrong_program_verdicts_are_refused`; A1's tests |
| OutLayer outage | Repaying and depositing need no verdict; withdrawals with no loan neither; after 30 minutes anyone may repay | `anyone_may_repay_once_a_margin_call_verdict_is_over_30_minutes_old` |
| MPC timeout | `on_hl_signed` stores nothing and drops the transfer; the nonce is never reused; the send window stays open | `a_failed_send_signature_keeps_the_window_open`; `the_mpc_mock_signs_when_answered_and_times_out_otherwise` |
| 1Click refund or failure | Transfers are recorded until delivered, refunded or listed as arrived; overdue ones hold back risk; `forget_transfer` | `refunds_late_arrivals_and_a_default_keep_the_records_right`; `a_failed_transfer_is_forgotten_…` |
| Bad debt, the pool running dry | The pool's caps, ceilings, 90% utilisation and daily budget | `tests/tests/pool.rs` (all six tests) |
| nBTC bridge failure | 30% cap on loans resting on nBTC; a frozen token refuses new loans | `no_new_loan_rests_on_a_frozen_token`; `loans_resting_on_each_bridged_token_stay_within_its_cap` |
| A bad program version | Each account pins its program and parameter hashes | `a_check_runs_the_pinned_program_with_the_right_input_and_limits` |
| A compromised enclave | The pool's own limits (next table). DEFAULT needs two verdicts 2 to 5 minutes apart, and the block lifts after review (A2) | `tests/tests/pool.rs`; A2's tests |
| Farming the rating | Preferred needs KYB; one upgrade per 30 days; an address links to one account | `tier_ceilings_the_kyb_flag_and_upgrades`; `a_hyperliquid_address_links_to_one_account_only` |
| One bad price forcing an unwind | Two DELEVERAGE verdicts 2 to 5 minutes apart | `a_deleverage_plan_needs_a_second_verdict_2_to_5_minutes_later` |
| Dipping above the line | The margin-call clock adds up 24 hours | `dipping_in_and_out_adds_up_instead_of_resetting` |
| Interest accounting bugs | Per-tier indices; rounding favours the pool | `pool/src/math.rs` property tests; `interest_per_tier_write_offs_and_loans_that_go_back` |
| Contract bugs | This audit; every callback's failure path has a test | the `*_failed_*`, `*_refused_*` and `*_times_out_*` tests |

## RISK_ENGINE.md 12.2: the limits the contracts hold whatever a verdict says

| Limit | Where | Test |
|---|---|---|
| Net new lending ≤ 10% of capital a day; raising it waits 48 hours | `pool/src/lib.rs` `check_own_limits`, `admin.rs` `set_daily_budget` | `the_daily_budget_the_pause_and_the_cosignature` |
| $25k in an account's first 7 days | `check_own_limits` | `a_new_account_owes_at_most_25k_in_its_first_week` |
| Tier history: one upgrade per 30 days, Preferred only with KYB; a better tier than allowed is refused | `apply_verdict_tier` | `tier_ceilings_the_kyb_flag_and_upgrades`; `a_forged_preferred_tier_without_kyb_is_refused` |
| Per-account ceiling (with its KYB entity) | `check_own_limits` | `each_tier_has_a_ceiling` |
| Co-signature above $250k, and for steps past $50k a day, valued at the operator's prices | `check_own_limits`, `check_step`, `step_value` | `plan_steps_past_50k_a_day_need_the_cosignature`; `steps_in_other_tokens_count_at_the_operators_price` |
| Plan-step destinations within the $50k a day | `check_step` before every step but a repay | `a_rebalance_runs_end_to_end_…` |
| Utilisation ≤ 90% | `check_own_limits` | `utilisation_one_client_and_the_book_limits` |
| Verdicts pinned, at most 120 blocks old, one action each | `account/src/verdict.rs` `check`, `usable_verdict` | `old_reused_foreign_and_wrong_program_verdicts_are_refused` |
| Pause stops new loans and plan steps, never repaying | `borrow`, `check_step`, `repay` | `no_loans_while_paused_but_repaying_still_works`; `no_plan_steps_while_paused_or_from_strangers` |

## Deploying the fixes (for the main session)

| Contract | Changed | New wasm (bytes, sha256) | Deploy |
|---|---|---|---|
| Account | A1, A2 | 363,288, `496b93521b9b3489c369961c0f6eae36162a69e4073239139689f9d0815a4e06` | Not deployed by itself: the factory carries it. A new account locks about 3.64 NEAR, leaving about 0.33 NEAR free |
| Factory | carries the new account code; nothing else | 557,904, `2064eae1b81bb641db59ff490bc8b1881194507e26becd4480e618c0413845fa` | Deploy over `pbf.testnet` with **no init call**: the stored layout is the same (`the_live_factory_takes_the_new_account_code_with_no_migration`, `the_upgraded_live_factory_makes_working_accounts_with_the_new_code`). It locks 4,809 bytes more; `pbf.testnet` keeps about 0.44 NEAR spare |
| Drill | INTERFACES.md 21 | 114,484, `61b1e9a79483d95b19da8a11bd6a63416f23d3acf0a7c354206ecf2cd5416636` | **Needs `migrate`**. First send `drill.pbf-ops.testnet` 0.3 NEAR: it holds 0.998 and the new code needs about 1.15. Then deploy with the init call `migrate({})`, signed by the drill account, or deploy and then call `migrate` as `pbf-ops.testnet` (in between, its views can't read the state). Tested both ways from the live code |
| Pool, types, token | nothing | unchanged | none |

The upgrade tests load the live code from `contracts/target/live/`. `python3 -I contracts/tests/fetch_live.py`
fetches it again, read-only. Once the new code is deployed, the tests' pinned hashes no longer match a fresh fetch;
they record the 9 Nov upgrade.

---

# Second pass: the Phase 6 code (12 Nov 2026)

FUNDING.md 10 asks for this: the `near-contract-audit` checklist over the contract code written since 9 Nov. That is
the funding plan and the permission, the Rhea and Aave calls, the Ethereum transaction encoder, the moves between
NEAR and Aave's chain, the pool's pricing and settlement, and the factory's lender settings.

**Status, 12 Nov 13:10 UTC.** The user asked for the two High findings and the cheap ones to be fixed the same day.
A7, A8, A9, A14, X2 and F2 are fixed, and A12 and P4 in part; the fixes are live on testnet for accounts made after
12:36 UTC ("What was fixed" at the end has the tests and the deploy). The pool wasn't touched, so P3, P5 and the
account's part of P4 are open. The first pass's open findings (A3 to A6, P1, P2, F1, X1) stand as they were. The
findings below are written as they were found, before any fix.

**Status, 12 Nov 22:00 UTC.** The user then asked for the pool's three as well. P3, P5 and the account's part of P4
are fixed: the pool was migrated on testnet at 21:40 UTC, which reaches every account, and the factory was redeployed
at 21:42, so accounts made after that carry the account's part of P4 ("The pool's three, fixed the same evening" at
the end).

**Status, 12 Nov 23:45 UTC.** Both gates passed again on that code (gate 4 at 22:36, gate 2 in full at 23:12). The
user then asked for the account's seven Low findings. Six are fixed in the code, with A17's two items that needed
a change; A11 is not, because its fix needs the engine too. **None of that is deployed:** it waits for the factory's
redeploy and both gates again ("The account's Low findings" at the end).

**Status, 13 Nov 11:00 UTC.** That is deployed now. The factory was redeployed at 09:53 UTC, so accounts made
since run the Low fixes; both gates passed on such accounts, each in one run (gate 2 at 10:30, gate 4 at 10:55).
Open in the account: A11, A3, A4 and A6, as listed at the end.

**Scope.** `contracts/account` (5,965 lines without tests), `contracts/pool` (3,871), `contracts/factory` (804),
`contracts/types` (572). The drill and the test tokens haven't changed since the first pass.

**The code audited is the code deployed.** Read-only RPC (`view_code`, 12 Nov, after the stage 4 deploy):
`pool.pbf.testnet` runs `c4641c0e…`, `pbf.testnet` `ce6fcd5a…`, and `fund-move-11120836.pbf.testnet` (the account code
new accounts get) `94ceb936…`. Each is the sha256 of the wasm built from this tree. Older accounts run older code:
`fund-aave-11112049` stage 3's (`fae0d5bd…`), `gate2a` stage 2's (`38261f9d…`), `demo1` Phase 2's (`98c2ca6c…`).

**How.**
- **Three readers, each on their own,** read every line of their part and answered a fixed list of questions:
  one on what the account can be made to sign and send, one on the funding plan, verdicts and transfers, one on the
  pool, the factory and the types. Two of them found A7 separately.
- **Every finding was then checked against the code** by the main session, line by line. A7 and A8 were traced on
  both sides, the contract and the engine. None was run as a test: each says "read" or "plausible" below.
- **Clippy** on the wasm target with `arithmetic_side_effects` and `indexing_slicing`: 122 hits. Those in the new
  code were checked by hand: each is guarded by a comparison, a length check or `overflow-checks`, and none can panic
  in a callback.
- **Access keys,** read-only: `pbf-ops`, `pbf-keeper`, `pbf`, `pool.pbf`, the Rhea copy, the drill, the stand-in's
  float and both test tokens each hold one full-access key and no function-call key. Client accounts hold none.
- **Secrets:** a script compared every secret value in `.env` with every other file of the tree (645 files),
  printing names and paths only. No file holds one. `.env.example` holds comments only. The one private key in the
  source (`services/oneclick-shim/src/evm.test.ts`) is Hardhat's public test key.
- **Not run:** `cargo audit` (it would download the advisory list first).

## Findings

| Id | Severity | Contract | Where | Finding | Status |
|---|---|---|---|---|---|
| A7 | **High** | account, engine | `account/src/lib.rs:2214`, `:1125`, `:975`, `:1326`; `plan.rs:215`; `risk/pb-read/src/book.rs:260`; `risk/risk-core/src/valuation.rs:61` | The owner can record money "on its way" that isn't, with any expiry. The engine counts it at 98% when it works out the state, so the account stays HEALTHY whatever its collateral does: no margin call, no unwind | **Fixed** for new accounts: contract and engine |
| A8 | **High** | account | `account/src/lib.rs:573`; `verdict.rs:246` | `set_permission` moves the counter with no verdict, at any time. An owner who calls it while a check is on its way makes that check arrive stale, so they can stop every verdict, the unwind's included | **Fixed** for new accounts |
| A9 | Medium | account | `account/src/lib.rs:780`, `:1836` | While repaying is open to anyone, anyone can have the account sign 1-micro-USD repayments at Aave without limit. Each holds the one signing slot and takes an Ethereum nonce, so the keeper's own top-up waits | **Fixed** for new accounts |
| P3 | Medium | pool | `pool/src/pricing.rs:609`, `pool/src/settle.rs:258`, `pool/src/lib.rs:723`, `:801` | A settlement's fee has no upper bound and counts as capital at once. One wrong report widens the daily lending budget and the subsidy budget, and at the extreme stops every pool method | **Fixed**, live for every account since 21:40 UTC on 12 Nov |
| P4 | Medium | pool, account | `pool/src/pricing.rs:669`; `account/src/lib.rs:1742`, `:2140`; `services/keeper/src/decide.ts:663` | Nothing reports a lender debt of zero, and a new borrow reports one figure for both ends of the period. So the pool can pay a subsidy, or charge a fee, on lender debt that wasn't there | **Fixed**: the keeper reports a repaid lender as zero; accounts made after 21:42 UTC on 12 Nov tell the pool the debt before and after a borrow. Older accounts pass one figure |
| A10 | Low | account | `account/src/lib.rs:998` | `evm_bump` lets anyone choose the fees: one call can use up the whole fee room with a tip that stays tiny, or make the account pay its full fee limit | **Fixed** (night of 12 to 13 Nov), live for accounts made since 13 Nov, 09:53 UTC |
| A11 | Low | account | `account/src/lib.rs:1050` | A signer call that failed or timed out is taken as proof that no signature exists, and the listing is dropped. A signature that shows up late could then send tokens that a later loan counted | Open. The fix needs the engine too (see the last section) |
| A12 | Low | account | `account/src/lib.rs:457` | One unit of a listed token with a transfer's msg, from anyone, settles that transfer. Old code; the two new move kinds inherit it | **Part fixed** for accounts made since 12 Nov: `to_hl` and `to_evm`. The rest (`sell`, `home`, `e_home`): fixed (night of 12 to 13 Nov), live for accounts made since 13 Nov, 09:53 UTC, where the caller says what to expect |
| A13 | Low | account | `account/src/lib.rs:214`, `:225`, `:897` | A5 can now happen: a settlement's fee reaches the account one hop sooner than a repayment's result, so `on_repaid` can close a loan the fee just reopened | **Fixed** (night of 12 to 13 Nov), live for accounts made since 13 Nov, 09:53 UTC |
| A14 | Low | account | `account/src/lib.rs:1955`, `:950`, `:846` | With no pool loan, the owner can add Aave listings to `pending` without limit. Past about 100 KB of state (an estimate) the 10-TGas callbacks would fail | **Fixed** for new accounts |
| A15 | Low | account | `account/src/lib.rs:2284`, `:1797` | A4 is worse: each accepted REBALANCE verdict replaces the stored plan, so a stranger's checks can hold back a top-up at a lender | **Fixed** (night of 12 to 13 Nov), live for accounts made since 13 Nov, 09:53 UTC |
| A16 | Low | account | `account/src/lib.rs:2512`, `:1117` | `withdraw` pays each new receiver's token registration (0.00125 NEAR) from the account's own NEAR. With no loan an owner can spend it all, and a later verdict that needs more storage then fails. Old code | **Fixed** (night of 12 to 13 Nov), live for accounts made since 13 Nov, 09:53 UTC |
| P5 | Low | pool | `pool/src/pricing.rs:660` | The 48-hour cut applies to fees too, so a fee lapses for any time past 48 hours without a settlement | **Fixed**, live for every account since 21:40 UTC on 12 Nov |
| F2 | Low | factory | `factory/src/lib.rs:55`, `:171`, `:209` | `on_created` gets 70 TGas whatever the number of tokens. From 5 tokens up that doesn't cover its calls. Today's config has 2 | **Fixed** |
| X2 | Low | types, account | `types/src/lib.rs:246`; `account/src/lender.rs:109` | A Rhea collateral token with more than 18 decimals passes `assert_valid`, can be posted, and can never be taken back. Today's config lists only the 8-decimal test nBTC | **Fixed** |
| A17 | Info | account | `account/src/lib.rs:786`; `verdict.rs:77`; `funding.rs:152`; `lib.rs:2174` | Four small things: see below | Items 3 and 4: fixed (night of 12 to 13 Nov), live for accounts made since 13 Nov, 09:53 UTC. Items 1 and 2: no change needed |
| P6 | Info | pool | `pool/src/lib.rs:490`, `:675` | `lent_24h` below zero is by design, but the day's bound is the budget plus that day's repayments | No fix |
| P7 | Info | pool | `pool/src/admin.rs:175`; `pricing.rs:157`; `settle.rs:167` | Small things: see below | Open |
| K1 | Info | services | `.gitignore` | The stand-in's `state/shim-state.json` isn't ignored. It holds no secret | **Done** |
| K2 | Info | services | `services/api/src/evm-handlers.ts:337`; `services/oneclick-shim/src/engine.ts:433` | The gas helper and the stand-in's float pay out test ETH to any factory account. Fine on this laptop; not before hosting | Open: before hosting |

No Critical finding. Nobody but the owner can make the account sign a transfer, or an approval to a spender the
config doesn't fix, and nobody but the owner can send its money anywhere but along a stored plan. A7 and A8 don't
make a loan larger: they weaken the margin call and the unwind that protect it.

### A7 (High): money "on its way" that isn't

**What.** A move is a transfer the owner starts through 1Click: `withdraw` with `transfer`, `hl_withdraw` with `exp`,
and since stage 4 `evm_withdraw` with `exp`. The account records it as the owner states it.
- `new_move` checks only that `exp` is in the future. The deadline is `exp` plus 30 minutes.
- The receiver, the destination and the amount are the owner's. The contract can't see the Hyperliquid balance or
  the Ethereum address, so an `e_home` or a `home` can name an amount that was never there.
- With no pool loan none of these needs a verdict.
- The engine counts every recorded transfer that isn't past its deadline at 98% in mark equity, and mark equity
  decides the state. It counts 0 toward credit, so the loan is sized properly.

**Worst case.** With no loan, the owner calls `evm_withdraw` for $1,000,000 of USDC to any address with an expiry in
2100, and sends the signed transfer, which fails on Aave's chain. The record stays. They deposit real collateral,
borrow what the credit line gives, and withdraw what a verdict allows. From then on every verdict adds $980,000 to
mark equity. If the collateral falls below the loan, nothing calls margin and nothing unwinds: the pool loses the
loan less what the collateral is still worth, up to its own per-account limits ($25k in the first week, the tier's
ceiling).

**A second way, with real tokens:** `withdraw` to the owner's own wallet labelled as a move, then deposit the same
tokens back, up to 8 times.

**How likely.** Any owner can do it on purpose, for gas, with no race. It needs a market fall to become a loss. The
app never sends such an expiry. It shows in `get_state().pending`.

**Old or new.** The `to_hl`, `sell` and `home` moves have had it since Phase 4, and the first pass missed it. Stage 4
adds two more kinds on the same path.

**Fix.**
1. **Contract:** `new_move` refuses an `exp` more than 24 hours ahead, which is the longest quote the engine
   already assumes. That bounds a made-up record to a day.
2. **Engine:** an owner's own move (`move:<n>`) counts 0 toward the state, as it does toward credit. With a loan
   open the withdrawal behind it already needed a verdict that allowed the money to leave for good, so the account
   was already judged safe without it. Plan steps (`<pid>:<i>`) keep 98%: the engine made their quotes. Without this, the same real
   tokens sent out and brought back can still prop the state up for a day at a time.
3. **Today, by hand:** anyone can clear such a record on any account with one unit of a listed token and its msg
   (A12). The keeper could flag any move whose deadline is more than a day away.

**Checked.** Read on both sides, by two readers and the main session. Not run. Tests: `a_move_needs_a_quote_expiry_in_the_future`
covers only the lower bound.

### A8 (High): the owner can make every check arrive stale

**What.** A verdict is accepted only if its `nonce` is the account's counter (`verdict.rs:246`). `set_permission`
adds 1 to the counter, takes 1 yoctoNEAR, and needs no verdict, even with a loan open. It doesn't have to change the
permission.

**Worst case.** An owner whose account is going bad sends `set_permission` every block or two, or once after each
`request_check` they see. Each check was read at the old counter, so the account refuses it. No MARGIN_CALL verdict
is held, the 24-hour clock never starts, no DELEVERAGE plan is confirmed, DEFAULT is never confirmed, and `repay`
never opens to anyone. The pool is left with the loan and no way to unwind it, up to its per-account limits.

**How likely.** It costs gas (by estimate, 1 to 2 NEAR an hour at one call a second) and a small script. Before Phase 6 an owner
with a loan had no free way to move the counter: every other call that moves it needs a verdict then.

**Fix.** `set_permission` leaves the counter alone and records the block it ran in. `fund` and the lender steps then
ask for a verdict read at a later block. That keeps what the bump was for (a check made under the old permission
backs no new plan) without the side door. A new stored field, so new accounts only.

**Checked.** Read by the main session; the pool's reader raised it in passing. Not run.

### A9 (Medium): dust repayments at Aave hold the signing slot

**What.** `lender_repay("aave", …)` from anyone is allowed once the held verdict says DELEVERAGE, or MARGIN_CALL or
worse for 30 minutes. A stranger's amount is capped at the debt but has no floor. Each call signs a new `repay` with
a new nonce, and the account signs one Ethereum transaction at a time.

**Worst case.** While the account needs a top-up at Aave, a stranger keeps calling it with 1 micro-USD. The keeper's
own `l_repay` and `l_add` steps are refused meanwhile, each dust repayment must be mined in order, and after 20 of
them older kept transactions fall out of reach of `evm_bump`. A liquidator at Aave gains 5% to 7.5% of the collateral
if the top-up comes too late.

**Fix.** From anyone but the owner, at Aave: only a repayment of the whole debt the verdict shows, and none while a
kept `repay` has a nonce the held verdict hasn't seen used.

**Checked.** Read. `anyone_but_the_owner_repays_aave_only_when_repay_is_open_…` covers one call, not a second.

### P3 (Medium): a fee has no upper bound

**What.** A settlement's fee is the reported lender debt times the rate difference times the time. A subsidy is cut
to two daily budgets; a fee is cut to nothing. The pool adds it to the account's debt, and debt is part of capital.

**Worst case.** It needs a wrong or compromised engine and a policy that can make a fee (the demo's 1.2-point margin
does). A verdict that shows $17.5 trillion owed at Aave makes a fee of about $4M on a $1M pool ten minutes later.
Capital then reads $5M: the daily lending budget and the pool's subsidy budget are five times larger, and every
honest borrower's rate rises. About 315 such fees overflow `utilisation`, and then `accrue` panics in every pool
method until a redeploy. Nothing takes a wrong fee back except `write_off`, which forgives the real loan too.

**Fix.** Count a lender's reported debt up to a limit (the tier's ceiling), cap fees per account per day as
subsidies are, and add an operator method that takes a booked fee back. The pause already stops settlements.

**Checked.** Read end to end; the arithmetic by hand.

### P4 (Medium): a subsidy or a fee on lender debt that wasn't there

**What.** The pool takes the smaller of two reported debts for a subsidy and the larger for a fee. But a repayment
at a lender settles only with a fresh verdict, the keeper settles hourly only where a lender is owed, and a new
borrow reports "the verdict's debt plus this borrow" as one figure. So a debt of zero in between is never seen.

**Worst case.** Under a policy that subsidises: borrow $50,000 at Rhea, repay it two blocks later, borrow again up to
48 hours later. Both ends show $50,000, and the pool pays the subsidy for the whole gap: $15.75 at the demo's
figures, with no interest paid to Rhea. It is bounded by $100 a day per account and 5 bp of capital a day for the
pool. The reverse harms an honest client: one who repaid a lender last week and borrows again is charged the margin
for 48 hours in which they owed nothing ($3.29 on $50,000).

**Fix.** The keeper settles once when the pool's last report shows lender debt and the verdict shows none: that
mends the honest case for every account today. For new accounts, a borrow passes both figures: the debt that closes
the period and the debt that opens the next.

**Checked.** Read: the account's step, the repayment, the keeper's rule and `settlement`.

### The Low findings

- **A10.** `evm_bump` takes any `max_fee` up to the limit and any `tip` up to it, from anyone. A bump to the limit
  with a tip a tenth higher leaves no room for a later bump. No effect on Base Sepolia, where every first try was
  mined. **Fix:** the contract sets a bump's fees itself, or only the owner bumps in the first minutes.
- **A11.** The Hyperliquid path assumes the signer's answer is public even if it never reaches the account
  (`hl.rs:64`); the Ethereum path assumes the opposite. The signer's side isn't in this repository, so that half is
  plausible, not traced. **Fix:** keep the listing on a failed call too, until a verdict shows the nonce used.
- **A12.** It only ever removes value from the engine's view, so it can't be used to borrow twice. A stranger can
  make a client's money on its way vanish for the transfer's own time (42 to 83 s at gate 4), which could read as a
  margin call on an account near its buffer. **Fix:** settle on a msg only when the amount is credible (80% of what
  was sent). Fix A7 first: today this is also A7's only quick remedy.
- **A13.** Worth one period's fee (cents). The record reads "no loan" while the pool is owed the fee, until the next
  settlement with a fee reopens it. **Fix:** A5's, with a sequence number on the loan record that a fee moves on.
- **A14.** Only the owner can do it, to their own account. `pending` had a stated bound of 8 transfers and a borrow;
  Aave listings have none. **Fix:** at most 8 Aave listings, and 20 to 30 TGas for the small callbacks.
- **A15.** A stranger who lands a check every block or two keeps replacing the plan the keeper is about to run.
  **Fix:** A4's (only the owner and the keeper ask for checks), or keep a plan whose steps haven't changed.
- **A16.** Anyone can mend it by sending the account NEAR. The runtime's part (a receipt that grows the state fails
  for lack of balance) is from knowledge, not tested. **Fix:** `withdraw` takes the registration from the caller.
  Until then the keeper can watch each account's free NEAR.
- **P5.** A client under a fixed rate above the pool's own, with no lender debt, is never settled by the keeper and
  pays the pool's curve. **Fix:** cut only subsidies to 48 hours; the keeper settles every account whose policy
  isn't pass-through.
- **F2.** With 5 or more tokens and little spare gas, `on_created` could run out after the account exists: unlisted,
  registered nowhere, holding the caller's NEAR (F1). **Fix:** a floor of 300 TGas, or gas worked out from the token
  count.
- **X2.** **Fix:** in `assert_valid`, a Rhea collateral token has at most 18 decimals.

### The Info findings

- **A17.**
  1. A stranger's repayment at Aave says "all of it" by comparing with the held verdict however old it is.
  2. `allow.withdraw` for an 18-decimal token is a JSON number above 2^53 (X1's class). The contract reads it exactly.
  3. The permission's `min_hf_bp`, `max_rate_bp` and `moves` are stored and never read on chain: only the lender
     names are enforced there. FUNDING.md 4.6 says so. It protects the client, not the pool.
  4. The pool's pause and its $50k-a-day step limit don't reach lender steps: a skipped settlement counts as settled,
     and `l_add` and `l_repay` never ask `check_step`. RISK_ENGINE.md 12.2 says the pause stops plan steps.
- **P6.** A repayment comes off the 24-hour window whole, interest and fees included, so the figure drifts below zero
  by the interest paid (-682 micro-USD on 12 Nov). The day's real bound is 10% of capital plus what was repaid in
  the window. If a strict bound is wanted, take off a repayment only up to what that account borrowed inside it.
- **P7.** `set_pricing`, `set_pricing_limits` and `set_funding` join A3's list (no 1 yoctoNEAR). `max_period_ns` and
  `min_period_ns` are plain `u64` in JSON and may be set above 2^53. `claim_credit` is `#[payable]` with no use for a
  deposit. A pricing record's storage (about 1.3 KB) is paid by the pool. The rate the pool charged is rounded to the
  nearest bp, the one rounding not in the pool's favour.
- **K1.** Add `services/oneclick-shim/state/` to `.gitignore` before the repository goes public.
- **K2.** The gas helper serves only factory accounts with Aave settings, with daily limits and a reserve, and all
  three services listen on this machine only. But a factory account costs 6 test NEAR and test nBTC is free to mint,
  so a hosted copy could be drained to its reserve. The stand-in's fault switch needs its admin token.

## What was checked and found sound, per contract

### Account (`contracts/account`), the code since 9 Nov

- **Callbacks `#[private]`, and never panic:** `on_step_borrowed`, `on_supplied`, `on_step_settled`,
  `on_lender_sent`, `on_lender_repaid`, `on_settled`, `on_repay_ready`, `on_evm_signed`. Each reads its result with
  `promise_result_checked` and a size cap, and nothing in them indexes, unwraps or adds unchecked.
- **Reentrancy:** state changes before every call out (the signing slot, the counter, the listing, the transfer
  record, a step's `done`), and callbacks undo what didn't happen. One Ethereum transaction is signed at a time, and
  `on_evm_signed` takes an answer only for the hash it asked for.
- **What can be signed:** six call shapes and no other (approve, supply, borrow, repay, withdraw, transfer). `to` is
  the config's Pool or a config token, value 0, the chain id from the config, `onBehalfOf` and a withdrawal's
  receiver the account's own address. Only the owner can have a transfer or a collateral withdrawal signed.
- **The encoding:** RLP lengths on both sides of 55 bytes, numbers with no leading zeros, an empty access list,
  `y_parity`, minimal `r` and `s`, the hash as keccak256(0x02 ‖ rlp). The unit tests compare it byte for byte with
  transactions built in Node. No input reaches an unchecked index or add.
- **Types in JSON:** amounts and fees `U128`, times in ns `U64`; nonces, step indexes and `exp` (ms) are native and
  far below 2^53 (A17 point 2 aside).
- **Owner checks:** `set_permission`, `fund`, `cancel_funding`, `claim_credit`, `evm_withdraw`, collateral out of a
  lender. `lender_repay` is the owner's, or anyone's under `repay`'s rule. Open on purpose: `execute_step`, `settle`,
  `evm_approve` (once per token), `evm_bump`, and USDC back from Rhea.
- **1 yoctoNEAR:** `set_permission`, `fund`, `cancel_funding`, `evm_withdraw`, `lender_repay`, `lender_withdraw`.
- **The funding plan:** stored only from the held verdict's own steps, for the exact amount asked, HEALTHY, read at a
  later block than the last plan's. A step can't run twice, out of order, after the 30 minutes or after
  `cancel_funding`, and each borrow takes the smaller of the plan's amount and a fresh verdict's figure.
- **One verdict, one action (A1):** every new path that moves money moves the counter on when it starts and again
  when the money has moved, or holds a listing that blocks every risk-adding call until it has. No window was found.
- **Unbounded lists:** a funding plan 6 steps, `ext` 2 lines, kept Ethereum transactions 20, approvals 5, transfers 8
  (A14 is the exception).
- **Prepaid gas:** static everywhere; too little attached fails before any state changes.
- **Verdict parsing:** the 4 KB cap is enforced twice, numbers are read exactly, and no input was found that panics
  in `on_verdict`.
- **No floats. `overflow-checks` on; callbacks saturate.**

### Pool (`contracts/pool`), the code since 9 Nov

- **Callbacks `#[private]`, and never panic:** `on_credit_paid`; `on_lent` and `on_defunded` as before.
- **Reentrancy:** `claim_credit` takes the credit and the cash before the transfer and puts both back on failure.
  `settle` makes no call out.
- **Caller checks:** `settle` and `claim_credit` act only on the caller's own record, and the caller must be
  registered. `set_pricing`, `set_pricing_limits`, `set_funding` are the operator's.
- **Storage keys:** `Pricing` is the eighth and last variant, so no live prefix moved.
- **`migrate`:** `#[private]`, `#[init(ignore_state)]`, reads only the Phase 5 layout, and a second run fails, so it
  can reset nothing. Tested on the live state.
- **The books:** a fee raises loans and capital by the fee; a subsidy lowers loans or raises credit by the same;
  capital and free cash subtract credit; a write-off nets credit against the loss.
- **Rounding:** a fee rounds up twice and a subsidy down twice (P7 has the one exception).
- **Limits in `borrow`:** the first-week $25k, the ceiling, the co-signature, the daily budget and utilisation all
  still run on every loan, a funding plan's pool step included.
- **Unbounded loops:** a report counts at most 2 lines; rate history 2 lenders by 8 days; windows 25 buckets.
- **Types in JSON:** `U128`, `U64`, `I128` (P7 for two period fields). **No floats.**

### Factory and shared types

- **`create_account`:** a permission that doesn't fit the config's lenders is refused before anything is created.
  The whole deposit comes back if the account wasn't made, and the account is listed only once it exists.
- **`set_config`:** the operator's only, `assert_valid` on the whole config, new accounts only.
- **`account_code_hash`:** the sha256 of the bytes `deploy_contract` sends.
- **`lenders.aave`:** a chain id above 0, addresses of `0x` and 40 hex digits, USDC with 6 decimals, 1 to 4
  collateral tokens of at most 18 decimals, none twice, a fee limit above 0. The account parses addresses with the
  same rule, so it never falls back to the zero address.
- **`lenders.rhea`:** 1 to 4 listed collateral tokens, not USDC, none twice (X2 for decimals).

## If the engine is wrong: what the contracts still hold, and what they don't

| Held | Not held |
|---|---|
| New lender debt only inside a plan the owner stored with `fund`, at most the amount asked, each step once, inside 30 minutes | The cushion and the rate the permission names (A17) |
| Only lenders in both the config and the permission, only their listed collateral, loans paid to the account itself | The pool's pause and step limit for lender steps (A17) |
| The six Ethereum call shapes, the config's addresses, the fee limit | The size of a settlement's fee (P3). **Since 21:40 UTC on 12 Nov it is held:** see the row below |
| The pool's own limits on its part of a loan (RISK_ENGINE.md 12.2) | The size of a withdrawal a verdict allows, as before |
| A subsidy cut to $100 a day per account and 5 bp of capital a day | |
| Since 21:40 UTC on 12 Nov: a fee cut to $1,000 a day per account and 50 bp of capital a day, on a lender debt counted at no more than $1,000,000 | |

## What was fixed on 12 Nov, and what is left

The user's decision on 12 Nov: fix both High findings now, with A9 and the cheap ones in the same redeploy, and leave
the pool alone. The rules were written first (INTERFACES.md 40), then built by four helpers, each fix with a test
that failed on the code as it was. The main session read every changed line against a copy of the morning's source,
rebuilt, and ran every suite: engine 321, contracts 666, JavaScript 619.

| Id | The fix | Proved by |
|---|---|---|
| A7 | **Contract:** no transfer is recorded with an `exp` more than 24 hours ahead (`new_move`, and a plan step's transfer). **Engine:** an owner's own move (`move:<n>`) isn't put in flight, so it counts nothing toward the state, credit, or margin on its way; a plan step's transfer counts as before (`risk/pb-read/src/book.rs`, `transit`) | `no_move_is_recorded_with_an_expiry_more_than_24_hours_ahead`; `a_plan_step_whose_quote_expires_more_than_24_hours_ahead_sends_nothing`; engine `an_owners_own_move_props_up_nothing_and_a_plan_steps_transfer_counts_as_before` (a $1,000,000 move used to turn DELEVERAGE into HEALTHY); `a_rebalance_does_not_count_an_owners_own_move_as_margin_on_its_way` |
| A8 | `set_permission` leaves the counter alone and records its block (`permission_blk`, a new last stored field, shown by `get_state`). `fund`, `l_borrow`, `l_add` and the collateral step that reads a check refuse one read at or before that block. A top-up's `l_repay` still repays and skips only its settlement | `set_permission_leaves_the_counter_alone_so_a_check_on_its_way_still_arrives`; `fund_refuses_a_check_read_at_or_before_the_block_the_permission_last_changed`; `a_top_ups_l_repay_step_still_repays_on_a_check_read_before_the_permission_changed_and_skips_its_settlement`; sandbox `audit_fixes.rs` |
| A9 | At Aave, anyone but the owner repays the whole debt the verdict shows or nothing, and not while a kept signed repayment isn't shown mined | `anyone_but_the_owner_repays_all_of_aaves_debt_or_nothing`; `anyone_but_the_owner_waits_until_a_check_shows_the_signed_repayment_mined` |
| A12, in part | A `to_hl` or `to_evm` transfer is settled by a deposit with its msg only as a refund: the token it sent, 80% of the amount or more | `a_deposit_with_the_msg_of_a_move_that_left_near_settles_it_only_as_a_refund` |
| A14 | At most 8 Aave listings in `pending` | `at_most_8_ethereum_transactions_are_listed_at_once` |
| X2 | `assert_valid`: a Rhea collateral token has at most 18 decimals | `a_rhea_collateral_token_has_at_most_18_decimals` |
| F2 | `on_created` gets 30 TGas and 10 for each call it makes; `create_account` refuses less than 110 TGas more (180 with today's 2 tokens) | `on_created_gets_gas_for_every_call_it_makes`; `create_account_refuses_less_gas_than_its_callback_needs_and_says_how_much` |
| P4, the keeper's part | After a check that shows a lender repaid while the pool's last report still shows debt there, the keeper settles once, so the pool holds a zero | keeper `loop.test.ts`, the two "the audit's P4" tests. Seen live: after the Rhea run the pool's last report for the account shows Rhea's debt as 0 |
| K1 | `.gitignore` lists `services/oneclick-shim/state/` | |

**Deployed on 12 Nov, 12:31 to 12:38 UTC** (`research/audit_fixes_deploy.md`; INTERFACES.md 41): the account
`0809d45c…` in the factory `638f17b1…`, `pb-risk` `1a102c17…` and `pb-gateway` `9a2e035c…` pinned. The pool is still
`c4641c0e…`. The redeploy was tested first over the live factory's saved code and state (`upgrade_audit.rs`).

**On the new code, live:** gate 4 passed again on its first run (12:39 to 12:50, `fund-move-11121239.pbf.testnet`).
The Rhea gate's own steps passed at 13:07 on a second account, without its hedge: testnet's mark stood 2% over its
oracle and the gateway refused the order (INTERFACES.md 41). After the testnet price band (INTERFACES.md 42 and 43)
and a fix to the keeper's price watch (44), **gate 2 passed in full at 19:38**, with its hedge, on
`fund-rhea-watch1.pbf.testnet` (INTERFACES.md 44.3).

**What the fixes don't reach:**
- **Accounts made before 12:36 UTC on 12 Nov** keep their code and their pinned engine (A6). The keeper logs
  `move_far` for any of them that records a transfer with a deadline more than 24.5 hours ahead.
- **A7's day:** a plan step's transfer still counts at 98% until its deadline. Only the engine makes those.
- **P4:** when the pool answers a settlement "too soon", the zero lands at the account's next check. That closes the
  subsidy, but an honest client can still be charged the margin for the gap. (Since the evening's fix the keeper
  tries again; see the next section.)

### The pool's three, fixed the same evening

The user's second decision on 12 Nov ("Pool too"): fix P3, P5 and the account's part of P4 with a live migration of
the pool. The rules were written first (INTERFACES.md 45), then built by four helpers; the main session read the
pool's changes against a copy of the source from before and ran every suite: engine 329, contracts 682, JavaScript
649. No stored record changes shape: the new per-account fee window is a new map under a new last storage key.

| Id | The fix | Proved by |
|---|---|---|
| P3 | Three new limits in the pool: a lender's reported debt counts at no more than $1,000,000 (`max_lender_debt`); one account is charged at most $1,000 of fees in 24 hours (`account_fee_day`); the whole pool books at most 0.5% of its capital in fees in 24 hours (`pool_fee_day_bp`). A fee above a budget is cut, as a subsidy is. The operator can take a booked fee back (`reverse_fee`) | `the_audits_p3_case_a_report_of_17_5_trillion_dollars_at_a_lender_books_23_cents_and_stops_nothing` (it booked $3,995,433.79 on the code as it was); `an_accounts_fees_stop_at_1000_dollars_in_24_hours`; `the_pools_fees_stop_at_50_bp_of_its_capital_in_24_hours`; `the_operator_takes_a_wrong_fee_back_within_the_fees_charged_and_the_debt`; sandbox `pool_pricing.rs` |
| P5 | A subsidy still covers at most 48 hours. A fee covers all the time since the account's last settlement. The keeper settles hourly every account with a loan whose policy isn't pass-through | `a_subsidy_covers_at_most_48_hours_and_a_fee_all_the_time_since_the_last_settlement` (48 hours of fee, not 30 days, on the code as it was); keeper `decide.test.ts` and `loop.test.ts`, "item 9" |
| P4, the account's part | At a lender borrow the account tells the pool two things: the lender debts as they stood (`closes`, which ends the period) and the debts with the borrow in (`report`, which starts the next). When the pool answers the keeper's zero report "too soon", the keeper tries again, twice at most | `the_audits_p4_case_a_lender_repaid_and_borrowed_from_again_earns_no_subsidy_for_the_gap` ($21.50 without `closes`, nothing with it); account `a_borrow_step_tells_the_pool_the_debts_as_they_stood_and_no_other_settlement_does`; sandbox `p4_closes.rs` (against the new pool and the old one); keeper "item 10" |

**Deployed on 12 Nov, 21:40 to 21:43 UTC** (`research/pool_fees_deploy.md`; INTERFACES.md 46): the pool
`ca21d533…` with `migrate` in one transaction, then the factory `2cb452a5…` carrying the account `b8acf77b…`. The
migration was run first in the sandbox over the live pool's code and state, fetched at 19:50 (`upgrade_pool_fees.rs`).
On chain, every pool view of all 13 accounts was saved before and compared after: the only differences are the
three new limits, `fees_reversed` "0", the code hash and the storage.

**On the new code, live** (INTERFACES.md 46 and 46.1):
- **Gate 4 passed at 22:36 UTC** on `fund-move-11122212.pbf.testnet`, an account with the new code: its Aave borrow
  step settled with `closes` against the migrated pool.
- **Gate 2's lending steps passed at 22:03** on `fund-rhea-11122148.pbf.testnet`: one `fund` across Rhea and our
  pool, a fee of 206 micro-dollars and a subsidy of 174 with `cut` "0" each, the keeper's top-up, both repayments
  and the credit. The pool's own record for the account says the same, with `fees_reversed` "0" and Rhea's debt 0
  in its last report.
- **Gate 2 then passed in full at 23:12 UTC** (all 26 steps): its test hedge's close, the dollars home from
  Hyperliquid and the final withdrawal waited an hour for Hyperliquid testnet's own price limit (INTERFACES.md 46.2).
- **Not exercised live:** a fee cut by a budget, and `reverse_fee`. The gates' sums are far under the limits; both
  are covered in the sandbox over the live pool's state (`upgrade_pool_fees.rs`).

**What these fixes leave** (INTERFACES.md 45.5 has the full list):
- **P3:** a wrong report can still add up to $1,000 a day to one client's debt, and 0.5% of capital a day in all,
  until the operator takes it back. Nothing raises an alarm: a `cut` above zero in a `settle` event is the sign.
  The operator can lift all three limits.
- **P5 with P4:** an honest client whose "repaid" report never reached the pool is now charged the margin for the
  whole gap, not 48 hours of it, up to $1,000 a day. The keeper's retry makes that rare.
- **P4:** accounts made before 21:42 UTC on 12 Nov pass one figure at a borrow, as before.
- An account with no loan isn't settled hourly, so a fixed-rate loan's last part-hour waits for its next settlement.

### The account's Low findings, built in the night of 12 to 13 Nov (on testnet for new accounts since 13 Nov, 09:53 UTC)

**13 Nov, 09:53 UTC:** the factory was redeployed with this code (`66cb9070…`, carrying account `79827e65…`) and
the pool was given a step price for the test bitcoin; accounts made from then on run it. **Both gates passed on
it the same morning, each in one run** (`research/low_fixes_deploy.md`, "As run"; INTERFACES.md 47.11):

- **Gate 2** (Rhea), 10:11 to 10:30 UTC, `fund-rhea-11131011.pbf.testnet`, 26 steps. Record:
  `research/data/phase6_funding_rhea.low-fixes-2026-11-13.json`.
- **Gate 4** (the moves to Aave's chain), 10:32 to 10:55 UTC, `fund-move-11131031.pbf.testnet`, 18 steps. Record:
  `research/data/phase6_funding_moves.low-fixes-2026-11-13.json`.

**What the live runs showed of each fix, and what only the tests show:**

| Fix | Seen live | Only in the tests |
|---|---|---|
| A17.4, the pool is asked before a top-up at Rhea | Gate 2's top-up, transaction `5HXw3BKGzf1Cs9bPTqwBWPAUUw6pjaS9SpUWMTHgPAqX`: `execute_step`, `on_repay_ready`, the pool's `check_step`, `on_repay_checked`, then the $70.76 to Rhea | A top-up that posts more bitcoin (`l_add`); the pool's refusal; a paused pool stopping `l_borrow` |
| A12, `expect` | The three calls that bring money home carried it and their arrivals settled: `hl_withdraw` (gate 2, $428.04 expected), `evm_withdraw` twice (gate 4, $21.06 and 54,808 units of test bitcoin) | The refusal of an arrival under 80% of it |
| A17.3, the permission's rate and cushion at `l_borrow` | Both gates' borrows at a lender passed it | The refusals |
| A13, the loan's count | Both gates' last repayment closed the loan | A fee landing between a repayment and its result |
| A16, the NEAR reserve | Both gates' last withdrawals went out; the accounts hold 5.87 and 5.97 NEAR | The refusal when the reserve would be touched |
| A15, a plan kept against a newer verdict | Not met | All of it |
| A10, the limits on a fee bump | Not met: no transaction needed a bump | All of it |

**Seen in gate 4 and left:** the gate's first `evm_withdraw` for the loan's way home was refused ("needs a verdict
for this token and amount"). The keeper's own check, asked when the funding plan ended, landed between the gate's
check and its call and replaced the verdict. That is A4, open since the first pass; the gate asked again and went
through (402 s for the step). A client who brings the loan home in the first minute after funding can meet the same
refusal once.

The paragraph below is how it stood before the deploy.

The user's third decision, in the night of 12 to 13 Nov: fix the seven left in the account. The rules were written
first (INTERFACES.md 47), then built by three helpers, each fix with a test that failed on the code as it was. The
main session read every changed line of the contract against a copy of the source from before, rebuilt, and ran
every suite. **Nothing of this is on testnet yet:** it needs the factory's redeploy and both gates again
(`research/low_fixes_deploy.md`). The pool, the engine and the gateway don't change.

| Id | The fix | Proved by |
|---|---|---|
| A10 | A bump's fee limit is at most an eighth above the kept one, whoever calls, so each bump uses one of the seven steps of room. Anyone but the owner waits 60 seconds from the block time the kept transaction was signed. The keeper sends the kept fee and a tenth | `a_bump_raises_the_fee_by_an_eighth_at_most_and_anyone_but_the_owner_waits_a_minute`; keeper `decide.test.ts`, "47.1 (A10)" |
| A12, the rest | `hl_withdraw`, `evm_withdraw` and a `sell` move take an optional `expect`, what the quote says will arrive on NEAR. A deposit with the transfer's msg then settles it only as that token and 80% of that amount, or as a refund of 80% of what was sent. The backend and the app send it for a move home | `a_move_that_says_what_to_expect_is_settled_only_by_a_credible_delivery_or_refund`; sandbox `audit_fixes.rs` (`a12_…`); backend "47.3 (A12)"; app `tx.test.ts`, `moves.test.ts` |
| A13 | The account counts its loan record's changes. A repayment that comes back after a loan or a fee was booked in between brings the principal down and leaves the loan open | `a_fee_booked_while_a_repayment_is_on_its_way_keeps_the_loan_open` |
| A15 | A stored plan with a step still to run is kept for 100 blocks against a newer check that orders the same steps (same action; same steps by kind, lender and token). A more severe action, another shape or a HEALTHY check still replaces or clears it at once. A kept plan's `l_add` runs only under the newest check that ordered it | `a_newer_check_that_orders_the_same_steps_keeps_the_stored_plan_for_100_blocks`; `a_plan_with_no_step_left_is_replaced_at_once_and_a_healthy_check_still_clears_a_kept_one`; `a_kept_plans_l_add_runs_under_the_newer_check_that_orders_it_and_under_no_other`; sandbox `lender.rs` |
| A16 | The owner's `withdraw` pays a new receiver's token registration only while the account keeps 0.3 NEAR free of its storage. Below that the transfer goes out alone | `a_withdrawal_pays_a_new_receivers_registration_only_while_the_account_keeps_its_near_reserve` |
| A17, item 3 | An `l_borrow` step is refused when the lender's rate in the held verdict is above the permission's `max_rate_bp`, or when the lender is owed already and its cushion is under `min_hf_bp` | `a_borrow_step_holds_the_lender_to_the_permissions_rate_and_cushion` |
| A17, item 4 | A paused pool stops an `l_borrow` step. A top-up at Rhea (`l_repay`, `l_add`) asks the pool's `check_step` first, so the pause and the day's step limit hold for it | `a_paused_pool_stops_a_borrow_step_at_either_lender`; `a_top_up_at_rhea_asks_the_pools_check_step_first`; sandbox `lender.rs`, with the real pool |

**Not built, and why:**
- **A11.** Keeping the listing after a failed signer call makes the engine count a borrow that was never signed as
  debt, and a withdrawal as collateral gone. The check for the second try then gives no room, and a signer
  time-out would stall a funding plan until another transaction used that nonce. The fix needs the engine to know
  such a listing, and the engine doesn't change this round. It stays open, for before mainnet.
- **A17, items 1 and 2: no change needed.** A stranger's repayment at Aave on an old verdict is bounded already:
  once one is signed, the next waits until a verdict shows it mined (A9's second rule). `allow.withdraw` as a JSON
  number is the engine's format, and the contract reads it exactly.

**What these fixes bring with them:**
- **A new account has less NEAR to spare.** The account's code grew by 20 KB, so the 6 NEAR at opening leaves 0.61
  free (0.81 before), and 0.50 after Rhea's registration. With the 0.3 reserve, an account stops paying new
  receivers' registrations after about 160 of them, until someone sends it NEAR. Opening with 7 NEAR would mend
  it; that is the factory's `MIN_DEPOSIT` and every caller's, and wasn't changed.
- **A top-up that posts collateral at Rhea needs the operator's step price for that token** on the pool, or the
  pool refuses it. The live pool has none for the test bitcoin: the deploy notes set one.
- **A top-up at Rhea counts toward the pool's $50,000 a day for plan steps,** and above it waits for the
  operator's co-signature. A top-up at Aave doesn't: it spends what is already on Aave's chain.
- **An account the pool blocked after a write-off gets no top-up at Rhea.**
- **A10:** a caller who bumps once a minute with small tips can still use up the seven steps in seven minutes.
- **A15:** a kept plan keeps its own amounts and quotes for up to 100 blocks.
- **The keeper** waits three minutes, not two, before it asks for a new plan after a top-up that didn't go out in
  three tries.

**Still open, in the order I would take them:**

| Round | What | Needs |
|---|---|---|
| The account, later | A11 (with the engine) | Before mainnet; it reaches new accounts only |
| ~~The deploy of the Low fixes~~ | Done on 13 Nov, 09:53 UTC; both gates passed on it | Nothing |
| Operator methods | A3, with the three new pricing methods (P7) | With the web app's operator controls |
| Hosting | K2 | Before the backend or the stand-in is reachable from outside |

# After the second pass: one rule loosened on 13 Nov (not audited)

The account held back every action that needs a verdict for 2 days and 1 hour after it asked for a signed transfer
out of Hyperliquid (`SEND_OPEN_MS`, the fix for the first pass's finding about a signature that is signed and posted
later). Since the deploy of 13 Nov, 22:20 UTC, an account made from then on ends that pause early when an accepted
verdict names the transfer's nonce in `sent`, which the engine does only when Hyperliquid's own ledger shows a `send`
from the account's address with that nonce, read before the balances (INTERFACES.md 50.2, `research/send_pause_plan.md`).

What still holds: a transfer that was signed and not sent keeps the pause for the full time; a verdict that is refused
lifts nothing; more than eight open transfers leave a floor no verdict can shorten. What this adds to the trust in the
engine: the account now takes the engine's word that a signature is spent, where before it took nobody's.

This change had no audit pass. It has unit and sandbox tests (contracts 710, of which 14 are new), a replay test in
the engine, and one live run (the pause gate, 13 Nov 22:24 UTC).
