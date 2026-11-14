# Privacy level 1, "hide who": the implementation plan (13 Nov, 11:10 UTC; the user said "Build it" at 11:14 UTC; rules in INTERFACES.md 48)

Level 1 hides **who** an account belongs to. It does not hide what is in the account: that is level 2
(PLAN.md 14). We, the broker, still see every account in full.

No contract changes. Nothing is deployed. The engine and the gateway don't change. The changes are in the backend
(`services/api`), the web app (`web`), one small change in the keeper's gate scripts, and the docs.

## 1. What is true today (read from the code on 13 Nov)

- **Our backend answers anyone about any account.** `GET /api/account/<id>`, `/api/hl/<id>`, `/api/keeper/<id>`,
  `/api/activity/<id>`, `/api/lender/<id>`, `/api/markets?account=`, `/api/drill?account=`, and `POST /api/preview`
  (a fresh run of the risk engine for any account) ask for no proof of who is asking (`services/api/src/server.ts`).
- **The Risk and Activity pages show any account with no wallet.** Type a name, or open `/risk?account=<name>`
  (`web/src/app/risk/risk-view.tsx`, `ByName`; the same in `activity-view.tsx`).
- **With a wallet, the picker opens anyone's account.** It says "belongs to X, not you: you can look and ask for
  checks" (`web/src/components/account-picker.tsx`).
- **The Book page lists clients by account** with each one's price, fees and lender debt, with no wallet
  (`/api/pricing`, the "By account" table in `web/src/app/book/book-view.tsx`).
- **The app suggests the account's name from the wallet's name:** `alice.testnet` gives `alice.pbf.testnet`
  (`suggestName` in `web/src/lib/names.ts`).
- **The app remembers a wallet's account name only in that browser** (`use-prime-account.ts`): the factory has no
  "accounts of this owner" view, only `list_accounts`.
- Sign-in by a signed message exists already, for orders only: the wallet signs a NEP-413 message and the backend
  checks it (`services/api/src/nep413.ts`, `hl-handlers.ts`). It worked with the Meteor wallet in the Phase 3
  click-through.

## 2. What level 1 changes

### 2.1 The backend asks who you are

**Sign-in, once per 12 hours.**
- New route `POST /api/session`. The wallet signs one message (free, no transaction):
  `Sign in to Prime Broker` + the wallet's id + a time 10 minutes ahead. The recipient is a new constant,
  `pb-app-session`, so this signature can never pass as an order, and an order's can never pass as a sign-in.
- The backend checks, in this order: the message's shape, that it names the wallet, that its time hasn't passed,
  that the nonce is new (kept in memory for 10 minutes), the signature against the public key
  (`verifyNep413`, as for orders), and **that the public key is a full-access key of that wallet on NEAR** (new
  read in `services/api/src/rpc.ts`: the RPC's `view_access_key`; its exact shape to be confirmed in NEAR's RPC
  docs before building). Without that last check anyone could sign as anyone.
- It answers a token: the wallet's id and an expiry 12 hours ahead, with an HMAC over both. The HMAC's secret is
  32 random bytes made when the backend starts, held in memory only. A backend restart signs everyone out.
- The browser keeps the token in `localStorage` per wallet and sends it as `Authorization: Bearer` on every call.

**Who may see an account.** One function, `mayView(who, account)`, used by every route below. It answers yes for:
1. the wallet that is the account's `owner` (from `get_state`, cached 60 s);
2. us: the operator's wallet (`OPERATOR_ACCOUNT_ID`) and the keeper's (`KEEPER_ACCOUNT_ID`), signed in the same way;
3. our own services on the same machine (the keeper and the gate scripts), by a service token: the backend writes
   32 random bytes to `services/api/logs/service-token` (mode 600, git-ignored) at start, and they read it;
4. an account named in `OPEN_ACCOUNTS` (a list in `.env`, not secret): demo accounts anyone may look at;
5. an account that doesn't exist yet, for any signed-in wallet (there is nothing to hide, and the wallet is about
   to create it).

Otherwise: HTTP 401 `sign_in` with no token, or 403 `not_yours` for another wallet's account. The 403 does not name
the owner.

**Routes that ask `mayView`:**

| Route | Today | After |
|---|---|---|
| `GET /api/account/<id>`, `/api/hl/<id>`, `/api/keeper/<id>`, `/api/activity/<id>`, `/api/lender/<id>` | open | owner, us, or an open account |
| `GET /api/markets?account=`, `/api/drill?account=` | open | the same; without `account` they stay open |
| `POST /api/preview`, `/api/funding-plan`, `/api/quote` (they name an account) | open | the same |
| `GET /api/pricing` | lists every client | the pool-level part stays open; the per-account list only for us (`accounts_hidden: true` otherwise) |
| new `GET /api/accounts/mine` | | the signed-in wallet's own accounts, from the factory's `list_accounts` filtered by owner |
| `POST /api/order`, `/api/cancel` | signed by the owner already | unchanged |
| `POST /api/hl/submit`, `/api/evm/submit` | open; they post what the chain already holds | unchanged |
| `/api/config`, `/api/pool`, `/api/lenders`, `/api/rhea`, `/api/book-stress`, `/api/credit-check` | open | unchanged: none names a client (the book stress result gives a count of accounts, not their names) |

`/api/config` gains `privacy: "owner" | "off"` and `open_accounts: [...]`, so the app knows what to show.

**The switch.** `ACCOUNT_PRIVACY=off` in `.env` puts every route back to today's behaviour. Default: `owner`.

### 2.2 The web app

- **Sign-in card.** With a wallet connected and no token, pages that show an account show one card: "Confirm this
  wallet is yours: one free signature, no transaction" and a button. It has to be a click: wallets open a window
  for a signature. After it, everything works as today for 12 hours. A 401 from the backend drops the token and
  shows the card again.
- **No wallet.** Risk and Activity no longer take a typed name. They say "Connect your wallet to see your
  account", and list the open demo accounts (from `/api/config`) as links anyone can open, read-only.
  `/risk?account=<an open account>` keeps working, so a link to the demo account can still be shared.
- **Another wallet's account.** The picker says "This name belongs to another wallet" and the page shows nothing
  else: no owner id, no balances, no "ask for a check" button.
- **Us.** The operator's wallet signs in the same way and opens any account by name, as today. The Book page's
  "By account" table shows only to the operator; everyone else sees the pool's totals, rates and stress test.
- **Random names.** `suggestName` is replaced by `randomName`: 10 characters from `a-z` and `2-7`, from the
  browser's `crypto.getRandomValues`, for example `k7x2m9qa4t.pbf.testnet`. About 50 bits: a clash is not a
  practical worry, and the factory refuses a taken name anyway. The client can still type a name of their own.
- **Finding your account again.** With a random name, a cleared browser would lose the name. So the picker asks
  `GET /api/accounts/mine` and offers "your accounts" to choose from, plus "New account". Accounts made before
  today keep their names and show up in that list.
- **The test page** `/dev/home` (canned answers, no backend) gets a canned session so it still renders.

### 2.3 The keeper and the gate scripts

One change, in the place the gates build their backend client (`services/keeper/src/gate-world.ts`): read the
service token file if it is there and send it. With privacy off or no file, nothing is sent and everything works
as today. The keeper's own loop reads NEAR directly and needs nothing.

### 2.4 Docs

- INTERFACES.md, a new section 48 with these rules, written before building.
- README: a short "Privacy" section: what an outsider can see today, what level 1 changes, what it doesn't, and
  levels 2 to 5 as the road ahead.
- PLAN.md 14: level 1 marked built.
- `.env.example`: `ACCOUNT_PRIVACY`, `OPEN_ACCOUNTS`.
- `research/privacy_fresh_wallet.md`: the client's own part, written down and not built: a new wallet, funded
  through a confidential swap, on mainnet only. Written after reading NEAR Intents' docs on it, not from memory.

## 3. What level 1 does not do

- **NEAR itself stays readable.** Anyone who knows an account's address can read its balances, loan and stored
  check result with a block explorer. Our app stops being the easy way in; it is not a wall.
- **The factory still lists every account with its owner's wallet.** That is why the client needs a wallet nobody
  connects to them, which is their own step and works on mainnet only.
- **Hyperliquid positions stay public** for any address, and each account's Hyperliquid address is in its state.
- **Old accounts keep their old names.**
- **The backend still runs on this machine only.** Hosting it is a separate, open item (the audit's K2).

## 4. Tests

- **Backend** (now 157): sign-in with a good signature; a wrong key; a key that isn't the wallet's; a key that is
  only a function-call key; a passed time; a nonce used twice; a changed token; an expired token. `mayView` for
  each of the five yes cases and the two no cases. Every route in the table: 401, 403 and 200. `/api/pricing`
  with and without the per-account list. `ACCOUNT_PRIVACY=off` answers as today.
- **Web app** (now 227): `randomName` always passes `nameProblem`; the token is stored, sent, dropped on a 401
  and on expiry; the picker's four states (yours, new, another wallet's, the operator looking); Risk and Activity
  with no wallet; the Book page with and without the operator.
- **Keeper** (now 205): the gates' backend client sends the token when the file is there and nothing when it isn't.
- `pnpm -r build` and the app's lint clean. The contracts and the engine aren't touched, so their suites don't
  move (696 and 329).

## 5. Live checks (no deploy, testnet reads only)

1. Start `shim`, `api`, `web`. With no token: `GET /api/account/fund-rhea-11131011.pbf.testnet` answers 401;
   an account in `OPEN_ACCOUNTS` answers 200; `/api/pool` answers 200.
2. With the service token from the file: the same first call answers 200.
3. In the browser, no wallet: Risk shows "Connect your wallet" and the demo list; the demo link opens.
4. **Gate 2 once, through the guarded backend** (about 20 minutes, 6.7 of the keeper's 10.35 test NEAR): proof that
   the gates still pass with the service token.
5. **The user's click-through** covers what only a real wallet can show: connect, the one sign-in signature, a new
   account with a random name, and the flows as before. This is why level 1 goes before the click-through: the
   user tests the final app once.

## 6. Order of work and time

| Step | Who | Time |
|---|---|---|
| Rules into INTERFACES.md 48; a copy of the source as it is now | main session | 20 min |
| Backend and the gates' client | helper K | 60 to 90 min, in parallel with the next |
| Web app | helper W | 60 to 90 min |
| Read every changed line, all suites, build, lint | main session | 45 min |
| Live checks 1 to 3 | main session | 15 min |
| Gate 2 once | main session | 25 min |
| Docs | main session | 30 min |
| **Total** | | **3.5 to 4 hours**, none of the user's |

Earlier I said 2 to 3 hours for an app-only change. The extra hour is the backend's own check (without it the
pages hide accounts but the backend would still answer anyone) and the one gate run.

## 7. The risk, and the way back

The sign-in sits in front of every account read, so a mistake in it makes the whole app look broken. The way back
is one line: `ACCOUNT_PRIVACY=off`. A copy of the source from before the build is kept as for the Low fixes.

## 8. Choices, with my defaults

1. **The backend checks, not just the pages.** Default: yes (this plan). Pages only would take about 2 hours and
   hide less.
2. **Open demo accounts.** Default: today's two gate accounts, `fund-rhea-11131011.pbf.testnet` and
   `fund-move-11131031.pbf.testnet`, so a reader with no wallet still has something to look at.
3. **A sign-in lasts 12 hours.**
4. **The Book page's per-client table is for the operator only.**
