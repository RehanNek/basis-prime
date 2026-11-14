# A wallet nobody connects to you: the client's own part of privacy level 1 (13 Nov; written down, NOT built, NOT run)

Privacy level 1 (INTERFACES.md 48) stops our app from showing an account to anyone but its owner and us, and gives
new accounts a random name. One link is left: **the factory records which wallet owns each account**, and anyone
can read that on NEAR. If the world knows a wallet is yours, the random name hides nothing.

So the last step is the client's: open the account from a wallet that has no public history tying it to them. This
note says how. We have not run it. It needs mainnet: testnet has no 1Click and no confidential swaps (our testnet
demo uses a stand-in for 1Click, PLAN.md 5.4).

## The steps (mainnet)

1. **Make a new NEAR wallet.** A new account id that says nothing about you. Don't fund it from a wallet or an
   exchange account that is known to be yours with a plain transfer: a plain transfer is a public line from the
   old wallet to the new one.
2. **Fund it through a confidential swap.** NEAR Intents' 1Click API takes a `confidentiality` field on a quote
   request (`basic` or `advanced`; source: docs.near-intents.org, "Confidential swaps", as kept in
   `.claude/skills/near-intents/rules/api-confidential-swaps.md`). With it, the deposit on the origin chain and the
   payout on the destination chain can't be matched to each other on chain. 1Click's changelog of 27 Oct 2026 says
   its swaps settle on NEAR's private shard (`research/intents.md`). So: swap from where your funds are now (any
   chain 1Click supports) to NEAR, with the **new** wallet as the recipient.
3. **Send in amounts and at times that don't give you away.** A swap of exactly $1,234,567 in and the same out a
   minute later can be matched by size and time even when the path can't. Round amounts, more than one swap, and
   some time between help.
4. **Open the prime brokerage account from the new wallet.** The app gives it a random name. Keep the company's
   details off the chain: our KYB record of who you are stays with us, not in the account.
5. **Fund the account the same way.** Collateral that comes straight from a known wallet ties the account back to
   it. Send it from the new wallet, or through another confidential swap with the account as the recipient.

## What this still leaves open

- **We know who you are.** That is the point of a broker: the privacy is from outsiders, not from us.
- **The account's contents are readable** by anyone who has its address: balances, the loan, the stored check
  result. That is level 2 (PLAN.md 14).
- **Hyperliquid shows the account's trading address and its positions.** Funding that address from a known
  Hyperliquid account ties the two together. That is level 3.
- **Timing and size** can still point at you, as in step 3.

## What we would build for this later

A "start privately" path in the app: it makes the 1Click quote with `confidentiality` set and the new wallet as
recipient, and warns when a deposit would come straight from a wallet that has been used with us before.
