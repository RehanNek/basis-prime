# Web app (PLAN.md 5.8)

Generated on 6 Nov 2026 with `create-near-app` 10.0.0 (`--frontend next-app`): Next.js with the App Router,
`@hot-labs/near-connect` for wallets and `near-api-js`. It needs Node 24.15 or later (see `.nvmrc` at the repo root).

## The redesign (9 Nov): layout D in the Institutional style

The user picked layout D, the hybrid, in the Institutional style, from three options. PLAN.md 11.6.1 has the details.

- **The look:** light, navy and calm. Source Serif 4 is used for headings and numbers, and Inter for text. Both load
  from Google Fonts in the browser, with Georgia and the system font standing in until they arrive.
  - There is a dark mode. It follows the system, and the moon or sun button saves a choice. An inline script in
    `app/layout.tsx` applies it before the first paint.
  - Bootstrap 5.3 stays underneath. `app/globals.css` re-points its variables and its few compiled-in colours, so
    every page picks up the look.
  - It works on a phone.
- **The navigation:** Home, Credit check and Book are tabs. Everything else is under More, each page with a plain
  one-line description (`lib/pages.ts`).
- **Home, signed out:** what this is in plain words, the worked example's numbers ($94,172 from us against $63,089
  from Rhea), and two ways in: sign in, or try a credit check with no wallet.
- **Home, signed in:** the cockpit (`components/home/`).
  - **The setup checklist:** five steps, open your account, add collateral, hedge on Hyperliquid, borrow. It sits on
    top until all are done. Each step is read from the chain and from Hyperliquid, so it stays right after a reload.
  - **"Set up the demo for me" (testnet):** runs every step before the borrow, one after another, and stops there.
    The wallet still approves each one. Those steps are:
    - test collateral, minted straight into the account;
    - the Hyperliquid address;
    - margin moved through 1Click;
    - the trading agent and its approval;
    - an immediate-or-cancel BTC short the size of the nBTC.
  - **The numbers:** what you can borrow now, what you owe and at what rate, and your net worth.
  - **A health bar:** Safe, Watch, Margin call or Unwind, with what it means in words. For example: "nBTC could fall
    53% against BTC before a margin call". The engine's figures sit behind "Why?".
  - **Where your money is:** on NEAR, on Hyperliquid, and the loan.
  - **The latest activity**, with links.
  - **The actions, each in a side panel:** borrow, repay, add funds, withdraw, and move USDC to or from Hyperliquid.
  - **In a margin call,** a warning appears and Repay becomes the main button.
  - **A card per lender** (Phase 6, stage 1; FUNDING.md 8), under the health bar and "Where your money is", for an
    account with a position at Aave or Rhea: what is posted there, what is owed, the rate, and a cushion bar with
    three states, Safe, Thin and Act. For example: "Bitcoin could fall 33% before Aave would sell". An account with
    no lender position shows no card.
  - **"Where it comes from"** in the borrow panel, under the amount, for an account that can use lenders: each
    source of the loan, its amount and its rate, then the whole loan's rate. The page asks the engine a moment after
    the typing stops (`POST /api/funding-plan`). For today's accounts the panel is as it was, and if the engine
    refuses it shows nothing.
- **Funding from lenders, stage 2** (FUNDING.md 8; INTERFACES.md 25, 26 and 29). It is for an account whose own
  config has lenders (`config_lenders` in `GET /api/lender/:account`). Every other account works as before.
  - **Opening an account** shows the lender permission and its four terms in plain words: which lenders, the smallest
    cushion (1.5), the highest rate (25% a year), and whether a loan may move between lenders. One approval opens the
    account and signs it: `create_account({name, owner, permission})` with 6 NEAR, of which about 4.7 NEAR stays as
    the account's storage. Unticking it opens the account without one. The terms come from the factory's config: the
    lenders it names, on the app's default terms.
  - **The Account page** has a "Lender permission" card: the terms now, a form to change them, and a way to cancel
    (`set_permission`, 1 yoctoNEAR). It says what cancelling does and doesn't stop.
    - After the audit fix (INTERFACES.md 40), a change leaves the account's counter alone and the account records
      its block (`permission_blk`). A check read at or before that block can't back a new loan: the app says so and
      asks for a new one (`verdictUse` in `lib/verdict.ts`).
  - **Borrow** takes one amount. The button runs a check with the `fund` intent, then `fund(amount)`, then shows the
    loan's steps going from waiting to done as the keeper runs them, read from `funding.steps` in
    `GET /api/lender/:account` (every 4 seconds while steps are left).
    - If the check would lend less than was asked, the page stops and offers the smaller loan on the same check.
    - A plan that runs out of its 30 minutes with steps left says so, and "Drop the plan" sends `cancel_funding`.
      "Stop here" does the same while it runs.
    - With the pool's pricing policy for the account, each source's rate is what the client pays, and the row says
      how that differs from the lender's own rate.
  - **Home** shows one loan total, our pool plus each lender, with the rate on the whole loan. The steps of a loan on
    its way have a card of their own.
    - **Repay** pays the dearest source first and says which and why. It sends `lender_repay(lender, amount)` for a
      lender and today's `repay` for our pool, one approval each.
    - **Paying a lender off** uses "All" (with one lender picked, "All of Rhea"). It sends the debt plus a little
      extra, the debt + 0.002% + 100 micro-USD as the keeper's gate does, because interest grows between the read and
      the transaction. A part payment is sent as it is typed.
    - **USDC sitting at Rhea:** Rhea keeps what is above the debt as the account's deposit. When
      `GET /api/lender/:account` shows a `deposit` above 0, Home and the Repay panel say "$X of yours is sitting at
      Rhea" with a button that brings it back: `lender_withdraw` of the USDC token. Anyone may press it, and it needs
      no check.
    - **Take collateral back**, on a lender's card: a check with the `lender_withdraw` intent, then
      `lender_withdraw(lender, token, amount)`. With nothing owed to our pool it needs no check. The most that can be
      asked for is what the lender's own record holds (`held`); without that reading the panel offers nothing.
    - **A credit** the pool owes the account shows on top with a Claim button (`claim_credit`).
  - **The Book page** has "Funding from lenders", read from `GET /api/pricing`: the source order and the loan life,
    the fees earned, the subsidies paid, what is left of today's subsidy budget, what is lent through each lender
    (the sum of each account's `lender_debt`, its held verdict's figure), and what each tier and each account pays. The operator's panel sets a policy for one account or a tier
    (`set_pricing`; Clear sends `null`) and the source order with the loan life (`set_funding`), each with a dollar
    example. The section shows nothing for a pool from before stage 2, which answers nulls and empty lists.
    - **What a settlement's fee can be at most** (INTERFACES.md 45): under the limits it showed before, the section
      has one line each for the pool's three limits on fees, with a dollar figure: a lender's reported debt counts at
      no more than $1,000,000, one account is charged at most $1,000 of fees in 24 hours, and the whole pool books
      at most 0.5% of its capital in fees in 24 hours. A pool from before these limits shows none of the three.
    - The operator's panel says what a settlement covers: all the time since the last one for a fee, and at most 48
      hours of it for a subsidy.
- **Aave on Base Sepolia, stage 3** (FUNDING.md 4.5 and 8; INTERFACES.md 33). The account has its own address on
  Aave's chain, the same as its Hyperliquid address, and signs Ethereum transactions for it through Chain Signatures.
  The helpers are in `lib/evm.ts`, with their tests beside them.
  - **Nothing assumes bitcoin or 8 decimals.** What is posted with Aave (`held`) and what sits at the address
    (`evm.wallet`) can be WBTC or WETH: each is read by its own `symbol` and `decimals`, and the card and the step
    list name the token ("Your 0.02 WETH", "Post 0.02 WETH with Aave").
  - **Home** has Aave's card like Rhea's, and "Your address on Base Sepolia" (`components/home/evm-card.tsx`): the
    address with a link to `sepolia.basescan.org`, the USDC and collateral there, its gas, and the newest five
    transactions the account signed, each as signed, sent, mined, failed or replaced. One that was signed and never
    sent has "Send it now". If the backend couldn't read the chain (`evm.chain_error`), the card says so.
  - **"Get test collateral for Aave"** is a setup step on testnet. It calls `POST /api/evm/gas` with `mint` for test
    WBTC from Aave's faucet when Aave's pool has room for it, and with `wrap` for test WETH when it doesn't, and says
    why. Room comes from `collateral_room` on Aave's testnet row of `GET /api/lenders`. It says that a faucet stands in
    for the bitcoin's move, which is a later stage. It can be skipped, and then the loan comes without Aave. The step,
    and "Get test gas" on the address card, show only while the backend's gas helper is on (`on` in
    `GET /api/evm/gas`).
  - **Borrow:** each Aave step of the plan goes from waiting to signing, signed, sent and mined, read from
    `evm.signed[].status`, with a link to the explorer. The step is matched to its transaction by nonce, through the
    account's own `get_state().evm.signed`. A borrow that is signed and not mined says so, and says the loan already
    counts. The step after it waits for the mining.
  - **Repay** has three sources and two purses: Aave is repaid from the USDC at the address, our pool and Rhea from
    the USDC on NEAR. `lender_repay("aave", amount)` only has the account sign; the page then sends the transaction
    (`POST /api/evm/submit`) and waits for it to be mined (`hooks/use-evm-send.ts`). Before it, the page asks once for
    `evm_approve` of the USDC, unless the account's own list says it is signed (`get_state().evm.approved`). An
    account contract from before that list falls back to a mined approval among the signed transactions.
    - **Paying Aave off** takes a little more USDC at the address than was borrowed, because interest grows every
      second. On testnet, when the address is short of that and the gas helper is on, the panel offers "Get 1 test
      USDC for the interest": `POST /api/evm/gas` with a `mint` of 1 USDC from Aave's faucet.
  - **Take collateral back** from Aave is `lender_withdraw("aave", token, amount)`, with its check while our pool is
    owed. It comes back to the address on Base Sepolia, not to NEAR, and the panel says so.
  - **Send a token out**, on the address card: `evm_withdraw(token, amount, to)`, with a check for the same token and
    amount while our pool is owed.
  - **The credit check** counts the bitcoin's trip there and back (`move.back`, `move.total`): "Moving the bitcoin
    there costs $490 and bringing it back $130. Aave's lower rate saves $207 over 90 days, which doesn't cover the
    $620." When no quote came for the way back it says so. An older engine's answer shows as before.
- **The moves between NEAR and Aave's chain, stage 4** (FUNDING.md 6.4 and 9; INTERFACES.md 36). Testnet only: our
  stand-in plays 1Click, and the client starts each move. The words and the plain data are in `lib/moves.ts`, the
  panel in `components/home/moves.tsx`, and the list in `components/pending-moves.tsx`.
  - **Four moves**, each a panel on Home:
    - "Move bitcoin to Aave's chain" (`to_evm`, nBTC), from the address card and from the setup step.
    - "Bring the loan home" (`e_home`, the USDC at the address), from the address card.
    - "Send USDC to Aave's chain" (`to_evm`, USDC), from the Repay panel when Aave is owed more USDC than the address
      holds.
    - "Bring the bitcoin home" (`e_home`, WBTC or WETH at the address), from the address card and from "Take collateral
      back" once it is back.
  - **Each runs the same way:** `POST /api/quote` with `{dry: true, move, account, token, amount}` for a price, the
    same with `dry: false` for 1Click's address, then the account's call from `move.next`: `withdraw` with
    `transfer: {"kind":"to_evm","exp"}`, or `evm_withdraw` with `exp`. When `move.needs_check` names a check, one
    click runs the check and the call. A move home is a transfer the account signs for Base Sepolia, which the page
    sends and follows as signed, sent and mined.
  - **The price in words:** what leaves, what arrives and where (`move.delivers`), how long it takes
    (`quote.timeEstimate`) and what it costs (`quote.amountInUsd` less `quote.amountOutUsd`). When bitcoin arrives as
    wrapped test ETH, the panel says Aave's test pool for bitcoin is full.
  - **The size limit** is said where the bitcoin amount is typed: one move brings at most 0.02 wrapped test ETH,
    with the dollars and the nBTC that is at today's prices.
  - **"Money on its way"**, on Home, lists every transfer the account records as under way, the two new kinds beside
    `to_hl` and `home`, each in words with where it stands: waiting for the deposit, on its way, arrived, sent back,
    failed or overdue. That comes from 1Click's status (`GET /api/status`) and the account's deadline.
    - A move that leaves NEAR has its own deposit address, so the account's record is enough to ask. One that leaves
      Aave's chain (or Hyperliquid) needs a memo the account doesn't keep: the browser that started it remembers it
      (`pb:moves` in local storage), and another browser says so.
    - A move to Aave's chain that has arrived stays listed until a check sees it: the row has "Check now".
    - An overdue one has "Drop this move" (`forget_transfer`, the owner, 1 yoctoNEAR).
    - The Risk page's "Money in transit" table shows the same words and stage.
  - **A quote that expires more than 24 hours ahead isn't sent** (INTERFACES.md 40): the account would refuse it. The
    builders in `lib/tx.ts` refuse to build such a move, for these four and for the two to and from Hyperliquid, and
    the page says so in place of the send button. The app's own quotes expire minutes ahead.
- **Privacy level 1, "hide who"** (INTERFACES.md 48). The app shows a client account only to its owner and to the
  broker, and a new account gets a random name. It follows the backend: `GET /api/config` says `privacy.mode`, and
  with `off`, or a backend that doesn't say, there is no card and no token and every page is as it was.
  - **Confirming the wallet** (`providers/session-provider.tsx`, `lib/session.ts`). With a wallet connected and no
    token, every page that shows an account shows one card in its place: "Confirm this wallet is yours: one free
    signature, no transaction." The wallet signs a three-line message (NEP-413, recipient `pb-app-session`),
    `POST /api/session` answers a token good for 12 hours, and every backend call then carries it. Nothing about an
    account is read before that.
  - **The token** is kept per wallet in this browser (`pb:session`). It is dropped when it runs out, when the
    backend answers 401 `sign_in`, and when the wallet signs out.
  - **No wallet:** Risk and Activity say "Connect your wallet to see your account" and list the accounts the backend
    names as open, as links. The name field for visitors is gone; `?account=<an open account>` still opens one.
  - **Another wallet's account:** the picker says "This name belongs to another wallet" and the page shows nothing
    else about it. The operator's wallet still opens any name, and the line says it is looking as the operator.
  - **Names** (`lib/names.ts`): `randomName()` gives 10 characters from a to z and 2 to 7. A wallet's account is the
    name this browser remembers, else the newest of `GET /api/accounts/mine`, else a random name made once and
    remembered. With more than one account of its own, the picker offers them to choose from.
  - **The Book page** shows "By account" only when the backend sends the list; otherwise "The per-client lines show
    only to the operator."
  - **What it doesn't do:** NEAR itself stays readable, the factory still lists each account with its owner, and
    Hyperliquid positions stay public.
- **One click for a check and its action** (`hooks/use-check-then-act.ts`, `components/check-flow.tsx`).
  - Borrowing, and withdrawing with a loan out, used to take two buttons and a race against a one-minute verdict. Now
    one button sends the check, waits for the verdict to land, and sends the action at once.
  - The wallet still approves both. If the second approval doesn't open by itself, a Confirm button shows how long
    the check stays good.
  - If the check allows less than was asked, "Borrow $X instead" uses the same check.
  - Every step shows its progress, from waiting to done, with its transaction link.
- **Plain words:** "check" for verdict, "the risk engine" for pb-risk, "a sealed computer (OutLayer)" for the enclave,
  and the binding limits in words.

`/dev/home?state=new|setup|ready|loan|call` shows the cockpit in each state from sample data. Its wallet simulates a
check and a borrow, and sends nothing. It exists in development only: a production build answers it with "This page
could not be found".

Phase 6 adds five states, with the page's fetch stand-in answering `GET /api/lenders`, `GET /api/lender/:account` and
`POST /api/funding-plan` from sample data (`app/dev/home/samples.ts`):

- `state=lenders`: a safe position at Aave. Open Borrow to see "Where it comes from".
- `state=lender-thin`: a thin cushion at Aave next to a safe one at Rhea.
- `state=lender-act`: a cushion at Aave that needs action now.
- `state=funding`: a credit check's answer with "How this loan would be funded", where the engine would use Aave.
- `state=funding-pool`: the same, where the engine would use our pool alone.

Stage 2 adds ten more. Their wallet also simulates `create_account`, `fund`, `cancel_funding`, `set_permission`,
`lender_repay`, `lender_withdraw`, `claim_credit`, `set_pricing` and `set_funding`, and a stand-in keeper runs one step
of a stored plan every 5 seconds. Nothing is sent.

- `state=new`: the checklist's "Open your account" now shows the lender permission. Opening it creates the sample
  account with the permission signed.
- `state=fund`: an account that can borrow from Rhea, hedged and ready. Borrow runs the check, `fund`, and the steps.
- `state=plan`: a loan on its way, at step 2 of 3. `state=plan-expired`: one that ran out of time with steps left.
- `state=sources`: one loan from our pool and from Rhea. Open Repay, or "Take collateral back" on Rhea's card.
- `state=credit`: a loan from Rhea alone under a policy that caps Rhea's rate, with a credit to claim.
- `state=leave`: leaving Rhea. A loan from Rhea alone and $0.37 sitting there. "Repay Rhea" on its card, then "All of
  Rhea", pays it off; "Bring back" fetches what is left at Rhea.
- `state=permission`: the Account page of that account, to change or cancel the permission.
- `state=account-new`: the Account page's "Create account", with the permission.
- `state=book`: the Book page with "Funding from lenders". `state=book-operator`: the same with the operator's
  wallet signed in, so the pricing controls show.

Stage 3 adds five more (`app/dev/home/aave-samples.ts`). A stand-in for Aave's chain (`app/dev/home/aave-standin.ts`)
plays the account's signing, `POST /api/evm/submit`, `POST /api/evm/gas` and the mining a few seconds later. The
wallet also simulates `evm_approve` and `evm_withdraw`. Nothing is signed or sent.

- `state=aave`: hedged and ready, with nothing at the address. Aave's test pool for bitcoin is full, so the step
  offers test ether and says why. Then Borrow runs the Aave steps from signing to mined.
- `state=aave-bitcoin`: the same, where the pool has room, so the step offers test WBTC.
- `state=aave-plan`: a loan on its way. The collateral is posted and mined, the borrow is signed and not yet sent,
  and our pool's step waits.
- `state=three`: one loan from our pool, Rhea and Aave. Open Repay, "Take collateral back" on Aave's card, or "Send
  a token out" on the address card.
- `state=funding-noback`: a credit check where no quote came for bringing the bitcoin back.

Stage 4 adds five more, and a stand-in for the moves (`app/dev/home/moves-standin.ts`): it answers `POST /api/quote`
for `to_evm` and `e_home` at the sample's prices, plays 1Click's status, and delivers a few seconds after the
deposit. The wallet also simulates `withdraw` with a `to_evm` transfer, `evm_withdraw` with `exp`, and
`forget_transfer`. Nothing is quoted by 1Click, and nothing moves.

- To run a move: `state=aave` ("Move bitcoin to Aave's chain", in the setup step or on the address card) and
  `state=three` ("Bring the loan home" and "Bring the bitcoin home" on the address card; "Send USDC to Aave's chain"
  from Repay on Aave's card, once the loan has gone home).
- `state=move-waiting`: the loan on its way home, its transfer signed and not yet mined. "Send it now" on the
  address card sends it, and the move goes on to arrive.
- `state=move-way`: bitcoin on its way to Aave's chain. It arrives about 20 seconds later.
- `state=move-arrived`: bitcoin that has arrived, still listed. "Check now" settles it.
- `state=move-refunded`: collateral on its way home that 1Click sent back to the address.
- `state=move-overdue`: USDC for Aave's chain that failed, past its deadline. "Drop this move" clears it.

## The pages

- **Home:** above.
- **Credit check:** paste any Hyperliquid address, or try the worked example. It shows what our pool would lend
  against the whole hedged book, next to what Rhea would lend against the spot alone. It reads mainnet and needs no
  wallet.
  - **"How this loan would be funded"** (Phase 6, stage 1): for Aave and for Rhea, what the lender would lend against
    the bitcoin and what our pool would add, each with its rate; the whole loan's cost; how far bitcoin can fall
    before that lender would sell; and for Aave the cost of moving the bitcoin there and back (stage 3) against the
    interest it saves.
    The lender the engine would use is marked, with the engine's reason. A result with no `funding`, from an older
    engine, shows nothing.
- **Book:** the pool's views, funding from lenders and what clients pay for it, the operator's controls (shown to the
  operator's wallet only), and the daily stress test.
- **Under More:**
  - **Borrow and repay:** every limit in detail, one-click borrowing, repaying, and how we compare with Rhea, with the
    carry. An account that can use lenders borrows and repays here as on Home.
  - **Add funds:** test tokens, deposits from your wallet, and deposits through 1Click.
  - **Trade:** orders through `pb-gateway`, rounded to Hyperliquid's rules and signed by the wallet (NEP-413). The
    answer comes back in words.
    - **The price band is the account's own** (INTERFACES.md 42). The page asks `GET /api/markets?account=<id>`, so
      the band it shows and checks is the one that account's pinned gateway enforces: on testnet 3% at least for a
      gateway built since 12 Nov, the parameter file's band (1% for BTC) for an older one. When the 3% floor set the
      band, the page says it is a testnet allowance: Hyperliquid testnet's price often stands away from its oracle.
      Mainnet keeps the parameter file's band. The setup checklist's hedge prices its order from the same figure.
  - **Activity:** everything that moved money, with links.
  - **Risk:** health, the margin-call clock, the bands, the stored plan, money in transit and the keeper's actions.
    No wallet is needed: `/risk?account=<name>`.
  - **Account details:** everything about the account, the lender permission, the Hyperliquid setup card, and moving
    USDC.
  - **Drill (testnet):** the nBTC/BTC ratio, the 1Click stand-in's fault switch, and the commands for the drill.

The wallet signs every transaction (`src/lib/tx.ts` builds them). Views and previews come from the backend
(`services/api`). The browser calls `/api/...` on its own origin, and `next.config.js` proxies it to `API_URL`
(default `http://localhost:8788`). Ids come from `NEXT_PUBLIC_*` values (see `.env.example`), each defaulting to its
testnet id in INTERFACES.md 1. Until a contract is live, its page says "not deployed yet".

```bash
pnpm install                  # from the repo root
pnpm --filter @pb/api start   # the backend, on http://localhost:8788
pnpm --filter @pb/web dev     # http://localhost:3000
pnpm --filter @pb/web build   # next build, with the type check
pnpm --filter @pb/web lint
pnpm --filter @pb/web test    # the page list, the Home numbers and checklist, funding from lenders (the permission, the plan's steps, one loan, pricing), and the helpers for transactions, orders and words
```
