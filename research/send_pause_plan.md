# Lifting the 2-day borrowing pause early: the plan (written 13 Nov, 21:05 UTC; the user's go at 21:12 UTC; rules in INTERFACES.md 50.2)

## What changes for the client

Today: after an account signs a transfer of USDC out of Hyperliquid, it lends nothing new for 2 days and 1 hour.
"Close everything" on the Basis trade tab does this, so the same account can't open a trade again for 2 days.

After: the pause ends at the next check that sees the transfer in Hyperliquid's own history. In practice that is
the check the Borrow button already runs, one to two minutes after the transfer went through. A transfer that was
signed and never sent keeps the pause for the full 2 days and 1 hour, as today.

It reaches accounts made after the deploy. Accounts made before keep today's rule.

## Why the idea holds (checked, not guessed)

1. **Hyperliquid's history carries the number of each transfer.** Read live on testnet, 13 Nov, 20:57 UTC, for the
   address of `npme2jlqx2.pbf.testnet` (`0x303d6ecc…`): `userNonFundingLedgerUpdates` lists the transfer home of 13
   Nov as `{"type":"send","user":"0x303d6ecc…","destination":"0xfc9d786b…","token":"USDC","amount":"442.0",
   …,"nonce":1794584202071}`. The account's own record of what it signed (`get_state().hl.signed[1]`) says
   `kind: sendAsset, nonce: 1794584202071`. The two numbers are the same.
2. **A number that was used can't be used again.** Hyperliquid's docs ("Nonces and API wallets", read 13 Nov): "the
   100 highest nonces are stored per address", "Every new transaction must have nonce larger than the smallest nonce
   in this set and also never have been used before", "Nonces must be within (T - 2 days, T + 1 day)", "Nonces are
   tracked per signer, which is the user address if signed with private key of the address". The account signs with
   its own address, and gives every action its own number (`Hl::take_nonce`).
3. So: if Hyperliquid's history shows a `send` from the account's address with the number of a signed transfer, that
   signature is spent. Nobody can post it later.

Not checked: a transfer from the spot balance (`sourceDex: "spot"`). If its history row looks different, the engine
finds no match and the pause stays for 2 days, which is the safe side.

## The rule, exactly

**Account contract** (`contracts/account/src/hl.rs`, `lib.rs`)
- `Hl` gets `open_sends`: the numbers of the transfers the account asked the signer to sign and that no check has
  shown as sent. At most 8. It shows in `get_state().hl.open_sends`.
- `note_send(nonce)` (called when the signature is asked for, as today): adds the number, drops numbers older than
  2 days and 1 hour, and still sets `send_open_until_ms` as today. If 8 are already open, the oldest moves into a
  floor, `send_floor_until_ms`: the pause can't end before it, whatever a check says.
- The engine's result gets one new field, `sent`: a list of numbers. When the account **accepts** a result
  (`accept`, next to where it settles `arrived` today), it removes from `open_sends` every number that `sent`
  names, drops the expired ones, and sets `send_open_until_ms` to the latest of: the floor, and the newest number
  still open plus 2 days and 1 hour. With none open and no floor it becomes 0: the pause is over.
- Nothing else moves: `assert_no_send_open` and its eight callers stay as they are. A result that isn't accepted
  (old counter, wrong model, too large) lifts nothing. The pause can only get shorter through `sent`, never longer.
- A transfer signed between the engine's read and the result's arrival bumps the account's counter, so that result
  is refused whole. A number the engine never named stays open.

**Risk engine** (`risk/pb-read`, `risk/pb-risk`)
- Reads `hl.open_sends` from the account's state.
- When there are open numbers, it reads Hyperliquid's history for the address from one hour before the oldest of
  them, **before** it reads the balances. The order matters: every transfer the history shows is then already out
  of the balances the same result counts. (Today's history read for arriving money stays after the balances, where
  it is safe for that purpose. So this is one more request, only while a transfer is open.)
- `sent` = the open numbers that the history shows as a `send` whose `user` is the account's address. Left out of
  the result when empty.
- The history read is saved in the run's inputs as an optional field, so runs saved before today replay unchanged.
- The parameter file, its hash and the model name don't change. `pb-gateway` isn't rebuilt or published.

**Keeper and gate** (`services/keeper`)
- The gate's `assertNoSendOpen` and the keeper's state type learn `open_sends`.
- Gate 2 gets three steps between `home` and `withdraw`: `pause_lifted` (a check; then `send_open_until_ms` must be
  0 and `open_sends` empty), `borrow_again` (a small loan from our pool, minutes after the transfer home),
  `repay_again`.

**Backend and app** (`services/api`, `web`)
- The pages stop holding back the check while the account is paused, for accounts that show `open_sends`: the Borrow
  page, Home's borrow box and the Basis trade's loan step ask for the check, and the check lifts the pause.
- The banner changes for those accounts: "Your transfer out of Hyperliquid went through. The next check confirms it
  and borrowing opens again." with a "Check now" button; and if a check has run and the pause is still on: "A
  transfer out of Hyperliquid was signed and not sent. Borrowing opens again on <date>."
- Accounts made before the deploy keep today's banner, plus one line: "A new account can borrow today."

## Tests that must exist before anything is deployed

- Contract, unit: a number named in `sent` ends the pause; a number not named keeps it; two open, one named, keeps
  it until the other's 2 days and 1 hour; a ninth transfer moves the oldest into the floor and the floor holds; a
  refused result lifts nothing; `sent` naming a number the account never noted changes nothing; expired numbers
  drop by themselves; `borrow` right after a lifting check goes through and one before it is refused.
- Contract, sandbox: the factory's redeploy over the live factory's code and state (as `upgrade_low.rs` did), then
  a new account: transfer signed, check with `sent`, borrow.
- Engine: `sent` from the live history row of point 1 (saved as a fixture); a `send` to the account (money coming
  in) is not a match; another address's `send` is not a match; the history is asked for before the balances (the
  order of requests is asserted); no open numbers means no extra request and no `sent`; a run saved before today
  replays to the same result.
- All suites green by my own runs: contracts (696 now), engine (329 now), JavaScript (959 now).

## The deploy sitting (testnet only; about 30 minutes; your keychain twice)

1. Before, no approvals: the suites; `contracts/build.sh --sizes` (account and factory change, the pool must be
   byte for byte the live one); the engine build from `risk/` with the flags of `research/band_deploy.md`; a copy
   of the live factory's code saved first, for the way back.
2. Publish the new `pb-risk` on OutLayer (`outlayer upload`, fetch it back and compare size and sha256,
   `outlayer deploy pb-risk … --no-activate`), as on 12 Nov. No `update_access`: the gateway doesn't change.
3. **Keychain 1:** the factory's redeploy (`near contract deploy pbf.testnet … without-init-call`), as on 13 Nov
   morning. Check `account_code_hash` is the new account's and everything else reads as before.
4. **Keychain 2:** the factory's `set_config` with only `risk.version_key` replaced.
5. Restart the stand-in, the backend and the keeper.
6. Test NEAR: two gate accounts take about 13.4; the keeper holds 11.84. One faucet account (`pbf-fund17.testnet`,
   9.9 NEAR to `pbf-keeper.testnet`) covers it.

## The proof

- Gate 2 on a new account, with the three new steps: a loan, the way out, the transfer home, then a check that
  lifts the pause and a second loan minutes later.
- Gate 4 on a new account, because the account's code changed.
- Not proved live: the refusal side (a transfer signed and never sent). Sending one on purpose would leave a usable
  signature lying around; the unit and sandbox tests cover it.

## Time, from your go

| Part | Time |
|---|---|
| The rule written into INTERFACES.md, and the helpers briefed | 20 min |
| Build, four helpers side by side (engine, contract, keeper and gate, backend and app) | 60 to 90 min |
| I read every changed line and run all suites | 45 to 60 min |
| The deploy sitting | 30 min |
| Gate 2 and gate 4 (each needed two or three starts today, for OutLayer) | 1 to 3 hours |
| **All** | **about 4.5 to 6.5 hours** |

Your click-through of the new pages doesn't wait for this: it can go on while the helpers build. Services stop for
a few minutes at the deploy.

## What can go wrong

- **It loosens a safety rule in the contract after the audit.** The new code is small (one list, one function, one
  line in `accept`), and the old time rule stays underneath it as the fallback. It still gets no outside review.
- **OutLayer's testnet** can stretch the gates by hours, as it did three times on 13 Nov.
- **If a gate fails for a reason that is ours**, the way back is: `set_config` with the old `risk.version_key`
  (`fb2cee3b…`) and the factory's redeploy from the saved copy (`66cb9070…`, account `79827e65…`). Accounts made in
  between keep the new code and keep working while the new `pb-risk` stays published.
- **It takes the same hours as** the fixes from your click-through, the README, the hosted demo, the video and the
  form. The deadline is 14 Nov, 23:59 UTC.

## What doesn't change

The pool. `pb-gateway`. The parameter file and its hash. The five tokens. Accounts made before the deploy. The 2
days and 1 hour for a transfer that was signed and not sent.

## As run (13 Nov, 21:19 to 22:25 UTC)

Built by four helpers side by side from 21:19; the last report (the account) came at 22:08. I read every changed line
of the engine, the account and the gate, and ran the suites myself: contracts 710 in one whole run, engine 345,
keeper 256, backend 239, app 422 at that point.

1. `pb-risk` `d7dd9cc4…` uploaded at 21:48, fetched back and compared, added with `--no-activate`, and run once by its
   version key (186 s in OutLayer's queue, a normal verdict).
2. The factory's redeploy at 22:19:48 (`7SMgLiLd…`) and `set_config` at 22:20:15 (`5MnZ6J2n…`), each read back: only
   the account's code and `risk.version_key` changed.
3. The gates: the keeper helper added a short gate for the fix alone (`pause:demo`: an account, USDC to Hyperliquid
   and straight home, a check, a loan, the way out), because Hyperliquid testnet took no BTC order that evening and
   gate 2 couldn't open its hedge. **It passed at 22:24:53 on its first run:** one check lifted the pause, and a $50
   loan arrived 84 s after the USDC came home. Gate 4's pass point passed at 23:09:41. Gate 2 was still waiting for
   Hyperliquid when this was written.
4. Time: 66 minutes from the go to the gate's pass, against the 4.5 to 6.5 hours estimated. The gates took minutes,
   not hours, because the short gate needs one check and no order.

Details and transactions: INTERFACES.md 50.5.
