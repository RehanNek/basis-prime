# Interfaces between the parts (Phases 2 to 5)

How the contracts, the risk program (`pb-risk`), the order gateway (`pb-gateway`), the backend and the web app talk to each other. PLAN.md 5 says what each part does and why; this file fixes the exact names and shapes they share, so the parts can be built at the same time. `RISK_ENGINE.md` Appendix A defines the verdict. When code and this file disagree, fix one of them; don't leave both. Sections 1–7 are Phase 2, as built. Sections 8–12 are Phase 3, written on 8 Nov before building it.

## 1. Testnet ids

| What | Id |
|---|---|
| Factory, and parent of every client account | `pbf.testnet` (client accounts are `<name>.pbf.testnet`) |
| Pool | `pool.pbf.testnet` |
| Operator (admin, funds the pool, co-signs) | `pbf-ops.testnet` |
| Keeper | `pbf-keeper.testnet` |
| Test tokens | `musdc.pbf-ops.testnet` (mUSDC, 6 decimals, plays USDC), `mnbtc.pbf-ops.testnet` (mNBTC, 8 decimals, plays nBTC) |
| Drill config (testnet only) | `drill.pbf-ops.testnet` |
| MPC signer | `v1.signer-prod.testnet` |
| OutLayer | `outlayer.testnet`; `pb-risk` is the project `pbf-keeper.testnet/pb-risk` |
| 1Click stand-in | `SHIM_URL` (localhost for now); its NEAR float is `shim.pbf-ops.testnet` |
| `pb-gateway` (Phase 3) | the OutLayer project `pbf-keeper.testnet/pb-gateway` |
| Hyperliquid testnet | `https://api.hyperliquid-testnet.xyz` (`/info`, `/exchange`). USDC's token string is `USDC:0xeb62eee3685fc4c43992febcd9e75443` (`spotMeta`, 8 Nov) |
| The stand-in's Hyperliquid float | `0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d`. Every Hyperliquid deposit to the stand-in goes here, matched by sender and exact amount |

## 2. Conventions

- **Token amounts** are in the token's own units, as `U128` strings in contract JSON.
- **USD amounts** are integer micro-USD. mUSDC has 6 decimals, so 1 mUSDC unit = 1 micro-USD.
- **Times** are block timestamps in nanoseconds, as `U64` strings. Block heights are plain numbers.
- **Token names inside verdicts and the pool** are the pool's: `USDC`, `nBTC`, `ETH`, `USDT`, `wNEAR`. `pb-risk` maps the engine's names (for example `ETH.b`) to these.
- **Verdicts** are JSON as in `RISK_ENGINE.md` Appendix A, under 2 KB. Amounts are plain JSON integers in micro-USD (`eq` can be negative).

## 3. Factory (`pbf.testnet`)

- `create_account({name, owner})`, payable: at least 4 NEAR, and 300 TGas. It creates `<name>.pbf.testnet`, deploys the account code it carries, calls `new({owner, config})`, registers the account's storage on every configured token, and calls `pool.register`. If any step fails, it refunds the caller.
- `get_config()` → `Config`. `account_for({name})` → the account id.
- Admin (operator only): `set_config({config})`, which applies to new accounts only; `set_paused({paused})`.

```json
Config = {
  "tokens": [{"id": "musdc.pbf-ops.testnet", "symbol": "USDC", "decimals": 6},
             {"id": "mnbtc.pbf-ops.testnet", "symbol": "nBTC", "decimals": 8}],
  "pool_id": "pool.pbf.testnet",
  "mpc_id": "v1.signer-prod.testnet",
  "outlayer_id": "outlayer.testnet",
  "risk": {"project_id": "pbf-keeper.testnet/pb-risk", "version_key": "<sha256 of the wasm>"},
  "hl_chain": "Testnet",
  "signature_chain_id": "0x66eee",
  "usdc_token": "musdc.pbf-ops.testnet",
  "params_hash": "<sha256 of universe_v0.json>",
  "model": "B-0.2",
  "drill_id": "drill.pbf-ops.testnet",
  "gateway": {"project_id": "pbf-keeper.testnet/pb-gateway", "version_key": "<sha256 of the wasm>", "secrets_ref": null},
  "hl_usdc_token": "USDC:0xeb62eee3685fc4c43992febcd9e75443"
}
```

`gateway` and `hl_usdc_token` are new in Phase 3. Accounts made before keep their Phase 2 config and code. `gateway.secrets_ref` is null, or `{"profile": "...", "account_id": "..."}` if OutLayer needs one to give `pb-gateway` its seed. `request_agent` passes it to `request_execution` as it is, and a config that leaves it out gets null.

**As built (7 Nov):**
- `new({operator, config})`.
- Extra views: `list_accounts({from_index?, limit?})` (at most 100), returning `[{account_id, owner, created_at}]`; `accounts_count()`; `is_paused()`; `account_code_hash()`. An account is listed only once it exists.
- The factory keeps 0.0245 NEAR of each deposit: 0.02 for the pool's registration, 2 × 0.00125 for the tokens and 0.002 for the list.
- Each client account locks about 2.6 NEAR of storage.
- **Set `config.risk.version_key` before creating client accounts.** Each account copies the config, and `request_check` refuses while the key is empty.

## 4. Account contract (`<name>.pbf.testnet`)

**Methods:**

| Method | Caller | Phase 2 behaviour |
|---|---|---|
| `new({owner, config})` | factory | Stores both. The counter starts at 0. |
| `ft_on_transfer(sender_id, amount, msg)` | configured tokens only | `""` or `{"pb":{"deposit":{}}}`: a deposit, kept. `{"pb":{"loan":{}}}` from the pool's token: loan proceeds, booked. Any other token is returned in full. |
| `request_check({intent})`, payable | anyone | Attach at least 0.01 NEAR; it goes to OutLayer, and OutLayer refunds the unused part to the caller. It calls `outlayer.request_execution` with the source `{"Project":{"project_id":<config.risk.project_id>,"version_key":<config.risk.version_key>}}`, the limits `{"max_instructions":2000000000,"max_memory_mb":256,"max_execution_seconds":20}`, `response_format` `"Json"`, and the input below. Its callback `on_verdict` stores the verdict if it passes the checks below, and never panics. |
| `borrow({amount})` | owner, 1 yoctoNEAR | Needs the stored verdict to be fresh, to answer a `borrow` intent, and to have `allow.borrow ≥ amount`. Then it bumps the counter and calls `pool.borrow({amount, verdict: {tier, allow_borrow: allow.borrow, shares_bp: pool.shares_bp, hold: pool.hold, hl_eq: pool.hl_eq}})`. The loan arrives through `ft_on_transfer`. |
| `repay({amount})` | owner, 1 yoctoNEAR; anyone if the stored verdict's `action` is `DELEVERAGE` | `ft_transfer_call` of the pool's token to the pool, with msg `{"pool":"repay"}`. |
| `withdraw({token, amount, receiver})` | owner, 1 yoctoNEAR | With no loan (`pool.debt_of(self)` is 0, per the account's record), no verdict is needed. With a loan, it needs a fresh verdict answering `withdraw` for the same token and amount. It bumps the counter, then batches `storage_deposit(receiver, registration_only)` and `ft_transfer`. |

**Accepting a verdict** (`on_verdict`). Each failed check stores nothing and leaves a log line saying which check failed:
- `ok` is true;
- `acct` is this account;
- `nonce` equals the counter;
- `params` equals `config.params_hash`, and `model` equals `config.model`;
- the result came back from the account's own `request_execution` call, which pins the project and version. This is why a verdict from another program can't arrive.

**Using a verdict:** it must be at most 120 blocks old by `blk` when `borrow` or `withdraw` uses it. Using it bumps the counter, so each verdict backs one action. A verdict that arrives after a newer action fails the `nonce` check. Since 9 Nov, the counter moves on again once the loan has arrived or the tokens have gone, so a borrow or a withdrawal moves it on by 2. That way a verdict read while the money was still moving backs nothing (`research/audit.md`, A1).

**Views:**

`get_config()` → `Config`.

`get_state()` returns:

```json
{"owner": "alice.testnet", "counter": 3, "blocked": false,
 "loan": {"principal": "50000000000"},
 "verdict": null | {"intent": {"borrow": {"amount": "50000000000"}}, "received_block": 123456, "verdict": {...}},
 "margin_call": {"since": "0", "intervals": [["<start ns>", "<end ns>"]]},
 "deleverage": {"first_at": "0", "confirmed_plan": null},
 "hourly": [{"hour": 493600, "hr_bp_min": 10000, "exp_bp_max": 49383}],
 "pending": [],
 "hl": {"path": "hyperliquid-1", "address": null}}
```

`loan.principal` mirrors what was borrowed less what was repaid. The pool's `debt_of` is the authority, and includes interest.

**As built (7 Nov):**
- **Withdrawals with a loan:** `pb-risk` answers a `withdraw` intent with `allow.withdraw` equal to the amount, in token units, if allowed, else 0. The account requires `allow.withdraw ≥ amount` for every token.
- **Borrowing, or withdrawing with a loan,** also needs the state to be `HEALTHY`.
- **`on_verdict` also refuses:**
  - a `blk` after the current block;
  - a `blk` older than the held verdict's;
  - an answer over 4 KB, or one it can't parse.
- **Verdicts:**
  - `params` is compared ignoring case;
  - any accepted verdict replaces the one held, so a keeper's `check` that lands between an owner's borrow check and the borrow means the owner checks again;
  - `request_check` returns `{accepted, reason}`.
- **`get_state` also carries:**
  - `loan.open`: true until a repayment comes back partly unused;
  - `margin_call.below`;
  - `deleverage.confirmed_plan` as `{at, blk, steps}`;
  - `pending: [{"borrow":{amount}}]` while a borrow is under way. Risk-adding actions are refused meanwhile.
- **Loan proceeds:** the loan msg is accepted only from the pool, in its token.
- **Network:** an account id ending in `.near` means mainnet; anything else means testnet.
- **Gas burnt:** `create_account` 54 TGas, `borrow` 15, `repay` 11, `request_check` 9, `withdraw` 6. Attach 300 TGas.
- **Left out:** `swap` (cut 3). With no loan, a swap is a `withdraw` to the 1Click deposit address, and 1Click pays back by plain `ft_transfer`. Also left out: `accept_version` (cut 4).

## 5. Drill config (`drill.pbf-ops.testnet`, testnet only)

- `set_ratio({bp})` (owner only) sets the nBTC/BTC ratio, 10,000 meaning 1.0.
- `get_ratio()` → `{"bp": 10000, "set_at": "<ns>"}`.

## 6. `pb-risk` (OutLayer project `pbf-keeper.testnet/pb-risk`)

**Input** (stdin):

```json
{"mode": "check" | "preview", "account": "alice.pbf.testnet",
 "intent": {"check": {}} | {"borrow": {"amount": "<mUSDC units>"}} | {"withdraw": {"token": "<id>", "amount": "<units>"}},
 "network": "testnet", "snapshot": false}
```

**Reads.** It reads everything else itself:
- the account's `get_state` and `get_config`, at one final block, which becomes `blk`;
- `ft_balance_of(account)` on each configured token;
- the pool's `get_pool`, `get_params`, `get_borrower(account)` and `coin_statuses`;
- the drill's `get_ratio`, on testnet: π for nBTC;
- Hyperliquid info for the account's HL address, if it has one;
- the prices, as in `RISK_ENGINE.md` 3.

**Output** (stdout): the Appendix A verdict, with `nonce` = the counter read, and `tier` within what `get_borrower` allows. With `"snapshot": true` (preview only), it returns `{"verdict": {...}, "inputs": {...}}` instead. `backtest verdict <inputs.json>` recomputes the same verdict locally, to the byte.

**Errors** are `{"ok": false, "reason": "..."}`, with exit code 0.

**As built (7 Nov):** version `78de117a8997ef34c9c9f76b04b8185c427f09348891b294752838655a658971`, pinned in the factory.
- **Accounts:** only `<name>.pbf.testnet` accounts on testnet are read.
- **A refused snapshot** comes back as `{"verdict":{"ok":false,...},"inputs":...}`.
- **Formats:**
  - `allow.*` and `credit.line` are plain integers;
  - `since` is in nanoseconds;
  - `binding` is the bound's code (`C4`), or `PRICE` while prices are uncertain;
  - for a `withdraw` intent, `allow.withdraw` is the amount asked, in token units, or 0;
  - coin bands are micro-USD prices, and π bands are basis points.
- **Bands** come only with a loan and outside DELEVERAGE.
- **Missing data never worsens the state.** It marks the coin uncertain and sets `allow` to 0.
- **Left for later phases:**
  - money in transit counts as 0;
  - the rating counters are 0, though a blocked account scores 300;
  - REBALANCE plans aren't made yet.
- **Hashes:** OutLayer's HTTPS API returns the output with its keys sorted, and the attestation's `output_hash` is the SHA-256 of that sorted form. `backtest verdict` prints the same hash for a snapshot.
- **Cost:** 23 calls for an account holding one coin, 12 more for each other coin, 10 for an empty account. A run takes 5–6 s and about 120M–790M instructions, about $0.001.

## 7. Backend (`services/api`, Node)

It holds `OUTLAYER_PAYMENT_KEY` and `ONECLICK_JWT`, and never sends them to the browser. JSON over HTTP:

| Endpoint | What |
|---|---|
| `GET /api/config` | The ids in section 1, and the factory's `Config` |
| `GET /api/pool` | The pool's `get_pool` and `get_params` |
| `GET /api/account/:id` | `get_state`, token balances, `pool.debt_of`, `pool.get_borrower` |
| `POST /api/preview` | Body `{account, intent}`. `pb-risk` in `preview` mode over OutLayer's HTTPS API, so the UI can show a verdict before anyone pays for an on-chain check |
| `POST /api/quote`, `GET /api/status` | The 1Click client: the shim on testnet |

The browser signs every transaction itself with the wallet. The backend signs nothing.

**As built (7 Nov):**
- Replies carry `deployed` (or `not_deployed`, naming what isn't live yet) and the `block_height` read.
- `/api/preview` reports `preview_enabled`, and sends the §6 input to OutLayer as a JSON object, not a string, as the Phase 0 probe did. It runs the `pb-risk` version pinned in the account's `get_config`, refuses accounts outside `*.pbf.testnet`, and is capped at 20 previews a minute.
- The backend runs on port 8788. The web app forwards `/api/*` to it, so the browser never needs its address.
- The web app sends 300 TGas with `request_check`, `borrow`, `repay` and `withdraw`.

**As built (8 Nov), for Phase 3:**
- `GET /api/config` also answers `ids.gateway_project`, `ids.hl_float`, `ids.hl_usdc_token`, `ids.hl_usdc_asset`, `gateway_enabled` (true when the payment key is set) and `hl_api` (the host).
- The backend now also reads `HL_API_URL` and `HL_FLOAT_ADDRESS` (both already in `.env.example`). It refuses to start unless `HL_API_URL`'s host contains `testnet`. The float defaults to section 1's, lowercase.
- A Hyperliquid failure answers 502 with `{"error":"hyperliquid"}`.

---

# Phase 3: the hedge

The Phase 3 gate (PLAN.md 11.4) builds the demo book of PLAN.md 2 through the app. The account's Hyperliquid address gets USDC through the stand-in, the gateway's agent is approved through Chain Signatures, and a $25k BTC short opens through the gateway. The verdict then shows a Standard line near $24,150, and the pool lends it. With the loan out, closing the whole short, forty orders at once and a coin outside the list are refused as the checks say. Finally, USDC comes home through `sendAsset` and the stand-in.

## 8. Account contract: the Hyperliquid side

**State.** `get_state().hl` becomes:

```json
"hl": {"path": "hyperliquid-1",
       "address": null | "0x<40 hex, lowercase>",
       "agent": null | {"address": "0x<40 hex>", "received_block": 123},
       "next_nonce_ms": "1794000000001",
       "signed": [{"index": 0, "kind": "approveAgent" | "sendAsset", "action": "<compact JSON string>",
                   "nonce": 1794000000000, "signature": {"r": "0x<64 hex>", "s": "0x<64 hex>", "v": 27},
                   "signed_block": 123}]}
```

`signed` keeps the last 20 entries. `index` counts up from 0 and is never reused.

**Methods:**

| Method | Caller | What it does |
|---|---|---|
| `hl_init()` | anyone | If `hl.address` is null, calls `<mpc_id>.derived_public_key({"path":"hyperliquid-1","predecessor":<self>,"domain_id":0})`. The callback `on_hl_key` (private, never panics) stores `hl.address`: `0x` and the last 20 bytes of keccak256 of the 64-byte x‖y key, lowercase. The key comes back as `"secp256k1:<base58 of x‖y>"`. Does nothing if the address is set. Measure the gas on testnet; attach 100 TGas |
| `request_agent()`, payable | owner | Attach at least 0.01 NEAR, as for `request_check`. Calls `outlayer.request_execution` with the source `{"Project":{"project_id":<config.gateway.project_id>,"version_key":<config.gateway.version_key>}}`, the same limits and `"Json"` as `request_check`, and the input `{"mode":"agent_address","account":<self>,"network":"testnet"}`. The callback `on_agent` (private, never panics) stores `hl.agent` if the output is `{"ok":true,"acct":<self>,"agent":"0x<40 hex>"}`. Because the account's own call pins the gateway's project and version, nobody can hand it another agent |
| `hl_approve_agent()` | owner, 1 yoctoNEAR | Needs `hl.address` and `hl.agent`. Builds `ApproveAgent` with `agentName` = `"pb valid_until <ms>"`, where ms is now plus 180 days, and has the MPC signer sign its EIP-712 digest. Allowed with a loan: it only binds the client tighter |
| `hl_withdraw({amount, destination})` | owner, 1 yoctoNEAR | `amount` in micro-USDC (`U128`), `destination` a 0x address (stored lowercase). **Refused while a loan is open**; Phase 4 adds the `from_hl` verdict. Builds `SendAsset` from the perp balance: `sourceDex` and `destinationDex` are `""`, and `fromSubAccount` is `""`. Then has the MPC signer sign it |
| `on_hl_signed` | private callback | Turns the signer's answer into `{r, s, v}` (below), appends the entry to `hl.signed`, and logs the event below. A failed or timed-out signature stores nothing and logs why |

**MPC call.** `<mpc_id>.sign({"request":{"path":"hyperliquid-1","payload_v2":{"Ecdsa":"<64 hex of the digest>"},"domain_id":0}})` goes out with 1 yoctoNEAR and 50 TGas, and the callback gets 15 TGas. Attach 300 TGas to `hl_approve_agent` and `hl_withdraw`.

The answer is `{"big_r":{"affine_point":"<66 hex: 02|03 then x>"},"s":{"scalar":"<64 hex>"},"recovery_id":0|1}`. Hyperliquid's signature is:
- `r` = `0x` and the x part of `big_r` (drop its first byte);
- `s` = `0x` and the scalar;
- `v` = `recovery_id + 27`.

Never take v from `big_r`'s prefix. The signer flips s to the low form, so the prefix can disagree with `recovery_id` (`research/day1.md` 3).

**Nonces.** Each signed action's nonce is `max(block_timestamp_ms, hl.next_nonce_ms)`, and `next_nonce_ms` becomes that nonce plus 1. Hyperliquid wants nonces that are unique and close to its own clock.

**EIP-712.** These are Hyperliquid's user-signed actions, hashed with `env::keccak256`. Write the type hashes out by hand, because the type names contain `:`.
- **Domain:** name `HyperliquidSignTransaction`, version `1`, chainId `0x66eee` (`config.signature_chain_id`), verifyingContract `0x0000000000000000000000000000000000000000`. Domain separator: `feb1393ca4412a4ca577bd51d04f0a77033514c602f4d0a11490fb95f7428df6`.
- **`ApproveAgent`:** `HyperliquidTransaction:ApproveAgent(string hyperliquidChain,address agentAddress,string agentName,uint64 nonce)`, type hash `4464abf6148f115d79362d98320081aa2ae8a5c840083cb65820bffc21394378`.
- **`SendAsset`:** `HyperliquidTransaction:SendAsset(string hyperliquidChain,string destination,string sourceDex,string destinationDex,string token,string amount,string fromSubAccount,uint64 nonce)`, type hash `5f7cf397b977b076f0fbb993badfc7dd11bd71461a3d076c0940eff5f91ac849`. Check this type string against the Python SDK's `SEND_ASSET_SIGN_TYPES` before the first live post.
- **Encoding:**
  - a string is hashed (keccak256 of its UTF-8 bytes);
  - an address is left-padded to 32 bytes;
  - a uint64 is a 32-byte big-endian word.
- **`amount`** is a decimal string with no trailing zeros: 9,500,000,000 micro-USDC is `"9500"`, and 1,234,500 is `"1.2345"`. The posted action must carry the identical string.
- **Test vectors.** They come from the helpers in `research/scripts/day1_mpc_probe.py`; on testnet, that ApproveAgent hashing recovered to the derived address.
  - `ApproveAgent("Testnet", 0x1111111111111111111111111111111111111111, "pb valid_until 1794700000000", 1794000000000)` → `d9a9d7d012959997623f8a5cbc8d7ccbe167212aeaaab25146a57d22cb4ea101`
  - `SendAsset("Testnet", "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d", "", "", "USDC:0xeb62eee3685fc4c43992febcd9e75443", "9500", "", 1794000000001)` → `cdc6e02faacd7851890b6f7bf8e41c50330d66ab4546849c39bdaa5b892214ae`

**Actions, as stored in `action` and posted.** The backend posts `{"action": <it, parsed>, "nonce": <nonce>, "signature": {"r","s","v"}}` to `/exchange`:
- `{"type":"approveAgent","hyperliquidChain":"Testnet","signatureChainId":"0x66eee","agentAddress":"0x…","agentName":"pb valid_until <ms>","nonce":<ms>}`
- `{"type":"sendAsset","hyperliquidChain":"Testnet","signatureChainId":"0x66eee","destination":"0x…","sourceDex":"","destinationDex":"","token":"USDC:0xeb62eee3685fc4c43992febcd9e75443","amount":"9500","fromSubAccount":"","nonce":<ms>}`

If Hyperliquid refuses an agent name with `valid_until`, use `"pb"` and record it here.

**Event.** An NEP-297 log, with the same `standard` and `version` as the pool's events: `hl_signed` with data `[{"account":<self>,"index":0,"kind":"approveAgent","nonce":<ms>}]`.

**Moving USDC to Hyperliquid, with no loan.** This is a plain `withdraw({token: <mUSDC>, amount, receiver: <1Click deposit address>})`, with no verdict. The quote's recipient is `hl.address`, and its refund goes to the account. Hyperliquid creates the address on its first deposit, at least $10, and charges 1 USDC for it. Approve the agent after that. With a loan, moving USDC is a withdrawal like any other and needs its verdict, until Phase 4 adds `to_hl`.

**Bringing it home, with no loan.** Get a quote for Hyperliquid USDC → mUSDC with the account as recipient. Then call `hl_withdraw({amount: <the quote's exact amountIn>, destination: <its deposit address, the float>})`. The backend posts the signed `sendAsset`, and the stand-in delivers mUSDC to the account with `ft_transfer_call`.

**As built (8 Nov):**
- **What the methods return** (the transaction's result):
  - `hl_init()`: the address, or null if the signer's answer was refused. With the address set, it returns it and calls nothing.
  - `request_agent()`: `{accepted, reason}`, as `request_check` does.
  - `hl_approve_agent()` and `hl_withdraw({amount, destination, source_dex?})`: the new `hl.signed` entry, or null if the signature failed or timed out. The web app takes the `index` for `POST /api/hl/submit` from it.
- **Finding an entry:** match the entries' `index` field. Once more than 20 actions are signed, `index` is no longer the position in `hl.signed`.
- **`hl_withdraw`'s `source_dex`** is `""` (the default, the perp balance) or `"spot"`; anything else is refused. It goes into `sourceDex` and the stored action. `destinationDex` stays `""`.
- **The send window.** `get_state().hl` also carries `"send_open_until_ms": "<U64>"`, `"0"` until the first `sendAsset`.
  - It is the newest `sendAsset` nonce + 2 days + 1 hour. Hyperliquid takes nonces down to its own time less 2 days, and the hour covers the gap between its clock and NEAR's.
  - It is set when `hl_withdraw` asks for the signature, so a failed or timed-out signature counts too: the signer's answer may be public anyway. It is its own field, so the 20-entry cap on `signed` doesn't lose it.
  - Until then, `borrow`, and `withdraw` while a loan is open, are refused: `no borrow until 2026-11-10 13:00:00 UTC (1794315600000 ms): a signed Hyperliquid sendAsset can still be posted until then`.
  - Never held back: `repay`, `request_check`, a `withdraw` with no loan, `hl_withdraw`, `hl_approve_agent`, and (in Phase 4) a deleverage plan's steps.
- **The counter:**
  - `hl_withdraw` bumps it, as `withdraw` does, so no verdict read before it can back a later borrow.
  - `hl_approve_agent` leaves it alone.
- **Nonces** are taken when the action is built, so a failed signature still uses one, and a retry signs with a new nonce.
- **The agent's name** is `pb valid_until <block time in ms + 180 days>`, not yet tried on Hyperliquid. On the first approval, check `extraAgents`: if Hyperliquid splits `valid_until` off the name, a later approval replaces the `pb` agent; if not, each approval adds another named agent.
- **The signer's answer** on testnet starts with `"scheme":"Secp256k1"` (read back from a 7 Nov probe transaction). The account accepts it with or without `scheme`.
  - It checks the shape only: `big_r` is 02 or 03 and 64 hex digits, `s` is 64 hex digits, and `recovery_id` is 0 or 1. It doesn't run ecrecover on-chain.
  - The unit tests recover three real Phase 0 signatures to the derived address with v = `recovery_id + 27`. In two of them, `big_r`'s prefix disagrees with `recovery_id`.
- **The gateway's answer:**
  - `acct` must be the account, and the agent is stored lowercase.
  - An answer over 4 KB is refused unread, as for verdicts.
  - A new accepted answer replaces the agent.
  - The run's `network` comes from the account id, as for `request_check`.
  - `secrets_ref` is `config.gateway.secrets_ref`, passed as it is: null by default, so it works whether `PB_AGENT_SEED` reaches on-chain runs through `author_secrets` or needs a `secrets_ref`. `request_check` still sends null.
- **`SendAsset`'s type string** matches the Python SDK's `SEND_ASSET_SIGN_TYPES` (`hyperliquid/utils/signing.py`, checked 8 Nov). The SDK posts `destination` as given; we sign and post it lowercase, so the signed and posted strings always match. With `sourceDex` `"spot"`, the §8 `SendAsset` example's digest is `aa992608cfeced07facdcb8120044886378713e2afd8cc6540e30fdbba6b53a1` (from the same Python helpers).
- **Gas** (named constants in `contracts/account/src/lib.rs`):
  - `derived_public_key`: 50 TGas, not yet measured on testnet;
  - `on_hl_key`: 10;
  - `sign`: 50, plus 1 yoctoNEAR from the account's balance;
  - `on_hl_signed`: 15;
  - `request_agent`: 200 to OutLayer and 30 for `on_agent`, as `request_check` sends.

  In the sandbox, the account's own receipts burnt 2.2–2.7 TGas per method and 1.6–1.7 TGas per callback.
- **Config checks:**
  - `gateway.project_id` is 1 to 128 bytes, and `gateway.version_key` at most 128. The key may be empty until `pb-gateway` is published, and `request_agent` refuses while it is.
  - A `gateway.secrets_ref` needs a `profile` of 1 to 128 bytes and a valid `account_id`.
  - `hl_usdc_token` is a name of 1 to 16 letters and digits, then `:0x` and 32 hex digits.
- **Upgrading `pbf.testnet`:** it holds the Phase 2 state.
  - Deploy the new factory with the init call `migrate({gateway, hl_usdc_token})` in the same transaction. `gateway.secrets_ref` may be left out (null). It keeps the operator, the config, the pause flag and the list of accounts. The unit tests run it on the state read from testnet on 8 Nov.
  - Then call `set_config` to pin `gateway.version_key` once `pb-gateway` is published.
  - `pbf.testnet` holds 6.0 NEAR. The new code locks about 5.12 NEAR, which leaves about 0.89 NEAR.
- **Sizes:**
  - The account's wasm is 315,992 bytes (was 259,748), and the factory's 510,609 (was 438,621).
  - A new client account locks about 3.2 NEAR of storage instead of 2.6. The 4 NEAR `create_account` asks for still leaves about 0.8 NEAR.

**Live on testnet (8 Nov).** These ran on `hedge1.pbf.testnet`; the record is `research/data/phase3_hedge_small.json`.
- **The factory:**
  - code `8f066c27…`, migrated in the same transaction as its deploy;
  - it pins `pb-gateway` `fcae6052…`, with `secrets_ref` null, and `pb-risk` `d741714416b7a75c9228bda21d6b70fb92850344130235943179369763396b7e`.
- **`hl_init`:** the signer's `derived_public_key` burnt 5.4 TGas, against the 50 allowed; the whole transaction burnt 10.3 TGas.
- **The agent:**
  - the on-chain `request_agent` got its agent from `pb-gateway`;
  - Hyperliquid accepted the MPC-signed `approveAgent`, with v = recovery_id + 27;
  - `extraAgents` lists the agent with name `pb` and `validUntil` 180 days ahead. Hyperliquid reads the `valid_until <ms>` suffix out of the name.
- **`sendAsset`:** Hyperliquid accepted it (`{"status":"ok","response":{"type":"default"}}`), with the amount `"427.651787"` from perps to the float, and the stand-in delivered the mUSDC.

## 9. `pb-gateway` (OutLayer project `pbf-keeper.testnet/pb-gateway`)

**Secret.** `PB_AGENT_SEED`, 32 bytes as hex, generated inside OutLayer (`outlayer secrets set --generate`), so nobody ever sees it. It is readable only by this project's wasm, when the caller is a `*.pbf.testnet` account (on-chain) or `pbf-keeper.testnet` (HTTPS with our payment key). Check the exact CLI and access-condition syntax in OutLayer's docs, and write it into `research/outlayer.md`. OutLayer's built-in signing keys don't fit here: they differ per caller, and the same agent must sign over HTTPS and be named on-chain.

**Agent key.** For client account `A`, the key is `HKDF-SHA256(ikm = seed, salt = empty, info = "hl-agent-v1:" + A)`, 32 bytes, taken as a secp256k1 scalar (refuse 0 or ≥ n). The agent address is `0x` and the last 20 bytes of keccak256 of the 64-byte x‖y public key, lowercase.

**Modes.** Input is JSON on stdin and output is JSON on stdout, with exit code 0. Errors are `{"ok":false,"code":"<code>","reason":"<words>"}`.

1. **`agent_address`** (on-chain, from the account). Input `{"mode":"agent_address","account":A,"network":"testnet"}`. `A` must equal `NEAR_PREDECESSOR_ID`. Output `{"ok":true,"acct":A,"agent":"0x…"}`.
2. **`order`** (HTTPS, from the backend). Input `{"mode":"order","account":A,"network":"testnet","auth":Auth}`. The order exists only inside the signed message (below), never next to it. A success answers:
   ```json
   {"ok":true,"acct":A,"status":"filled"|"partial"|"resting","oid":123,"filled_sz":"0.1","avg_px":"75012",
    "sent":{"coin":"BTC","is_buy":false,"sz":"0.33","limit_px":"74500","reduce_only":false,"tif":"Ioc"},
    "hl":{...Hyperliquid's /exchange answer...},
    "after":{"state":"HEALTHY","eq":0,"im":0,"line":0,"hl_margin_ratio_bp":0}}
   ```
   `after` is the engine's view of the book as if the order filled at its worst price (P4). A refusal answers `{"ok":false,"code":"P8","reason":"..."}`.
3. **`cancel`** (HTTPS). Like `order`, with the message carrying `"cancel":{"coin":"BTC","oid":123}`. Output `{"ok":true,"acct":A,"hl":{...}}`.
4. **`set_leverage`** (HTTPS, from the backend or the keeper). Input `{"mode":"set_leverage","account":A,"network":"testnet"}`. It needs no owner signature, because the gateway picks the numbers. For each allow-listed coin the account holds, it sets cross leverage (`updateLeverage`, signed by the agent) to the largest whole number that keeps P8 and P9 true at full use. Output `{"ok":true,"acct":A,"set":{"BTC":5}}`. This comes after modes 1–3; the gate doesn't depend on it.

**Codes:**
- `P0`–`P10` as in `RISK_ENGINE.md` 9, where `P0` means another order for this account is in flight;
- `AUTH`: a bad signature, the wrong signer, an expired message or a reused nonce;
- `HL`: Hyperliquid refused the order or didn't answer, and the lock is released;
- `INPUT`: the request is malformed or not rounded to Hyperliquid's rules.

**Auth.** NEP-413, signed in the browser by the owner's wallet (`signMessage`):

```json
Auth = {"owner": "alice.testnet", "public_key": "ed25519:<base58>", "signature": "<base64 of 64 bytes>",
        "message": "<the exact string signed>", "nonce": "<base64 of 32 bytes>", "recipient": "pb-gateway"}
```

The signed `message` is compact JSON:
`{"pb":"order","account":A,"order":{"coin":"BTC","is_buy":false,"sz":"0.33","limit_px":"74500","reduce_only":false,"tif":"Ioc"},"expires_ms":<ms>}`.
For a cancel, `"pb"` is `"cancel"` and the message carries `"cancel":{...}` instead of `"order"`.

The gateway:
- verifies the ed25519 signature over sha256(borsh(u32 2^31+413) ‖ borsh(message, nonce[32], recipient, callbackUrl = None)), as NEP-413 defines;
- checks that `public_key` is a FullAccess key of `owner` (RPC `view_access_key` at `final`), and that `owner` is `A`'s `get_state().owner`;
- checks that `expires_ms` is in the future and at most 120 s ahead of the NEAR final block's timestamp;
- refuses any nonce it has seen before (storage key `nonce:<base64>`, set with `set_if_absent`).

**Order fields.**
- `coin` is Hyperliquid's name, such as `BTC`.
- `sz` and `limit_px` are decimal strings, already rounded to Hyperliquid's rules: a price has at most 5 significant figures and at most 6 − szDecimals decimals, and a size has at most szDecimals decimals.
- `tif` is `Gtc`, `Ioc` or `Alo`, and `reduce_only` is a boolean.
- The minimum is $10 of notional.

The gateway refuses an unrounded order (`INPUT`) rather than rounding it silently.

**One order at a time (P0).** The storage key is `lock:<A>`:
- the first time, take it with `set_if_absent` set to the call id; after that, take it with `set_if_equals` from `"free"` to the call id;
- release it with `set_if_equals` from the call id back to `"free"`;
- a run that can't take the lock answers `P0` at once, without waiting;
- a lock older than 60 s may be taken over (a run's limit is 20 s).

The gateway's own orders from the last 10 seconds that Hyperliquid doesn't show yet count as filled (storage key `recent:<A>`).

**Reads.** The gateway reads what `pb-risk` reads (§6), plus Hyperliquid's open orders and the account's recent fills. It shares that reading code with `pb-risk`, so both see the book the same way, and it runs `risk-core`'s `Engine::pretrade`.

**Hyperliquid signing.** This covers the L1 actions `order`, `cancel` and `updateLeverage`.
1. msgpack the action, with its keys in the SDK's order.
2. Take `connectionId = keccak256(msgpack ‖ nonce as 8 bytes big-endian ‖ 0x00)`, where the final 0x00 means no vault.
3. Sign the EIP-712 struct `Agent(string source,bytes32 connectionId)` with the agent key. The domain is name `Exchange`, version `1`, chainId `1337`, verifyingContract `0x0`. `source` is `"b"` on testnet and `"a"` on mainnet.
4. Post `{"action","nonce","signature":{"r","s","v"},"vaultAddress":null}` to `/exchange`.

Unit-test the signing against the Python SDK's test vectors.

**Accounts whose Hyperliquid USDC sits in spot.** On 8 Nov, Hyperliquid's `userAbstraction` info answered `"default"` both for our float and for a never-used address. But the Phase 1 live test found a fresh recipient's delivered USDC in its spot balance, not in perps. Before relying on either, find out what `default` means for margin and where delivered USDC lands. Then make `pb-risk` and the gateway read equity and margin correctly for it. Record the answer in `research/hyperliquid.md`.

**As built (8 Nov):** version `fcae6052c4cde41d4dcb50460f4788df848e648839ce392fb6f15dc1581223d5` (1,286,551 B), active in the project (uuid `p0000000000000122`). It is not yet in the factory's `config.gateway`. Build: `RUSTFLAGS="--remap-path-prefix=$HOME=~" cargo build -p pb-gateway --target wasm32-wasip2 --release` in `risk/`. The first version, `85f68aaa…`, stays in the project but can no longer open the seed (measured).
- **The answer to "default":**
  - **`default` is standard.** `userAbstraction` answers it for an account that never chose a mode, and such an account keeps its perp USDC in `clearinghouseState`. Fresh derived addresses are `default`, so the shim's `usdSend` lands in perps.
  - **The Phase 1 recipient wasn't fresh.** It was the teammate's own `unifiedAccount`, whose single USDC balance shows in spot.
  - **How the reads handle each mode.** `pb-risk` and the gateway take a unified account's equity from its spot USDC total, and refuse `portfolioMargin` and `dexAbstraction`. Details are in `research/hyperliquid.md`, "Account modes".
- **The secret:**
  - **Name.** It is `PROTECTED_PB_AGENT_SEED`: OutLayer requires the `PROTECTED_` prefix for generated secrets.
  - **The row.** It is the keeper's row under the accessor `Project(pbf-keeper.testnet/pb-gateway)`, profile `gateway`.
  - **How a run gets it.** The wasm's manifest (custom section `outlayer.manifest`) names that row in `author_secrets`, so every run gets it, on chain and over HTTPS, and no caller passes `secrets_ref`.
  - **So the factory's `gateway.secrets_ref` must be `null`.** Naming the same row there would define `PROTECTED_PB_AGENT_SEED` on both the author's and the caller's side, which OutLayer refuses.
  - **Who may read it:** `And[Predecessor{Or[AccountPattern "[a-z0-9_-]+\.pbf\.testnet", Whitelist[pbf-keeper.testnet]]}, WasmHash(<this build>)]`. The manifest also sets `"callers":{"direct":"deny"}`.
  - **Upgrades.** Deploy with `--no-activate`, then `outlayer secrets access --project pbf-keeper.testnet/pb-gateway --profile gateway --build <new hash>`, then activate (`research/outlayer.md`, "The gateway's seed").
- **Callers:**
  - **`order`, `cancel` and `set_leverage`** answer `AUTH` unless the run is over HTTPS for `pbf-keeper.testnet` (`OUTLAYER_EXECUTION_TYPE` and `NEAR_SENDER_ID`). That keeps every lock in the keeper's storage cell.
  - **`agent_address` over HTTPS** is allowed for the keeper, for any client account, because `NEAR_PREDECESSOR_ID` is `""` over HTTPS; an agent's address is public anyway. On chain, the account must be the predecessor, as specified. For example, `demo1.pbf.testnet` → `0x68643293a2b557f696b7d485b4e1ddaac4a2d46a`, the same on every run.
- **Codes:** there is also `READ`, for when a read the checks need failed (NEAR RPC, Hyperliquid info, storage, or the seed). Nothing was checked or sent.
- **The message:**
  - **Its exact form.** It must be exactly the compact JSON above, in that key order. The gateway re-serialises it and compares; anything else is `INPUT`.
  - **The numbers.** `sz` and `limit_px` must be in Hyperliquid's wire form: digits, no sign, no exponent, no leading zeros, and no trailing zeros after the point. They are signed as given.
- **The checks, in order:**
  1. the request and the message's syntax (`INPUT`);
  2. the signature (`AUTH`);
  3. the allow-list (`P1`);
  4. the owner, a full-access key at the final block, and the expiry (`AUTH`);
  5. the nonce (`AUTH`);
  6. the lock (`P0`);
  7. 60 orders a minute (`P10`);
  8. `hl.address` set and `hl.agent` equal to the gateway's agent (`INPUT`);
  9. the reads;
  10. the coin's status: the pool's removed or reduce-only, or not listed on Hyperliquid testnet for cross margin. Such a coin only shrinks (`P1`);
  11. rounding and the $10 minimum (`INPUT`);
  12. a held coin's price uncertain (`P10`), unless the order only shrinks the position, whose band is then measured from the mark;
  13. risk-core's `pretrade_check`, now returning its check: P2, P3, P10's 1% of volume, P7, P5 (accept), P6, P8, P9. It runs on every resting-order book: none fill, then per coin all buys or all sells.
- **P10's volume on testnet comes from mainnet.** The limit is 1% of the coin's daily volume as mainnet Hyperliquid reports it now (`metaAndAssetCtxs` `dayNtlVlm` at `https://api.hyperliquid.xyz/info`, read only, by coin name).
  - Testnet's own volume is an artifact: BTC traded $1.9M on 8 Nov, against $506M on mainnet.
  - If mainnet doesn't answer, the parameter file's mainnet 30-day average stands in (BTC $2.37B).
  - Only this limit uses mainnet. Everything about the account (positions, margin, marks, fills) is testnet's, and the requirement keeps the file's volume, so the book is the one `pb-risk` sees.
  - At 8 Nov's volume the BTC limit is about $5M, far above the demo's $25k short.
- **P0:**
  - **The lock value** is `"<call id> <unix ms>"`, so a stale lock can be told; release compares the whole value.
  - **`recent:<A>`** is `{"sent":[{at_ms, coin, size, limit_px, cloid, oid, status, reduce_only}],"last_nonce"}`, kept for a minute.
  - **Unshown orders.** An order of the last 10 s counts as filled unless it shows in the account's fills (read before the book) or its open orders. An order Hyperliquid didn't answer is kept as `unknown`.
  - **Live allowances.** A live verdict (`ok`, nonce = counter, at most 120 blocks old) counts as spent: a borrow intent adds `allow.borrow` to the debt and to USDC on NEAR, and a withdraw intent takes `allow.withdraw` of its token out. From Phase 6 stage 2, a stored funding plan that has an unfinished step and hasn't expired counts too, with or without a live verdict: each unfinished `l_borrow` and `p_borrow` step adds its whole `amt` to the debt and to USDC. Of a borrow verdict's allowance and the plan's `p_borrow` steps, the larger counts; `l_borrow` steps are added on top.
- **What is sent:**
  - **The cloid** is `0x` and the first 16 bytes of sha256(`"pb-gateway cloid:"` ‖ the NEP-413 nonce).
  - **The Hyperliquid nonce** is max(the enclave's ms, the last one + 1), per account.
  - **The post** also carries `"expiresAfter":null`, as the SDK's does.
- **Outputs:**
  - **`status`** is `filled` when `totalSz` equals `sz`, `partial` when it is less, or `resting`. A resting order has `filled_sz` `"0"` and `avg_px` null.
  - **`after.line`** is the debt (any counted allowance included) plus W* of the book after the trade, with W* 0 while a price is uncertain.
  - **`cancel`** reads Hyperliquid's `meta` for the asset number, checks nothing more, and drops the order from `recent` on `"success"`.
  - **`set_leverage`:** for each allow-listed perp held, it searches for the largest L up to the coin's maximum where a position of L × the Hyperliquid equity, in either direction, still passes P8 and P9. It uses 1× if none does, and sets nothing with no loan. Its output also carries `hl`, Hyperliquid's answer per coin.
- **Sending USDC home (`hl_withdraw`'s `source_dex`):** the demo's accounts use `""` (perps). Their derived addresses are `default`, which is standard, and the shim's `usdSend` credits perps. `"spot"` is only for an account whose `userAbstraction` is `unifiedAccount`, or for USDC someone sent to a standard account's spot balance; neither is on the demo's path.
- **Not done:**
  - **P7** checks only the per-client cap, as risk-core does; the group and whole-book caps are not read.
  - **No reference price at all** refuses even orders that only shrink a position (`P10`).
  - **Not yet run live:** the on-chain `agent_address` (it waits for `request_agent`) and any order or cancel. The modes are tested natively on recorded inputs, and the signing against the SDK's vectors.
- **Cost:** `agent_address` over HTTPS is 5.75M instructions, 1.5 s and $0.001. An order makes 3 NEAR calls for auth, 1 Hyperliquid fills read, `pb-risk`'s reads (27 for the hedged one-coin book), 1 mainnet volume read and 1 post.

## 10. `pb-risk` in Phase 3

- It reads `hl.address` from `get_state` (set by `hl_init`) and that address's Hyperliquid state, read correctly for where its USDC sits (§9).
- Its reading code is shared with the gateway.
- A new version is deployed and pinned in the factory for new accounts. Accounts made before keep the Phase 2 version.

**As built (8 Nov):** version `d741714416b7a75c9228bda21d6b70fb92850344130235943179369763396b7e` (1,084,621 B), built but not deployed or pinned yet.
- **The shared reading code** is the crate `risk/pb-read`: the reads, the views' parsers, the WASI transport, and `book`, which builds the engine's account, market and rating. `pb-risk` keeps `verdict` and `bands`, and re-exports the old module paths. The Phase 2 snapshot still replays to output hash `a2b074b4…c74a`.
- **For an account with `hl.address`,** it reads `clearinghouseState`, `frontendOpenOrders`, `userAbstraction` and `spotClearinghouseState`, and a failed mode or spot read ends the run.
  - `default` and `disabled` take the perp account value.
  - `unifiedAccount` takes the spot USDC `total`, which includes open PnL.
  - Other modes are refused.
  - Spot USDC of a standard account isn't counted.
- **Inputs** carry `hl.abstraction` and `hl.spot`, left out when null. So older snapshots replay unchanged, and they read as standard. Each `hl.assets` entry also carries `index`, the coin's asset number.
- **Calls:** 2 more for an account with a Hyperliquid address: 27 for the hedged one-coin book.

## 11. Backend in Phase 3 (`services/api`)

| Endpoint | What |
|---|---|
| `GET /api/hl/:account` | The account's `hl` from `get_state`. For `hl.address`, from Hyperliquid: `clearinghouseState`, spot USDC, `userAbstraction`, open orders (`frontendOpenOrders`), the last 50 fills and the approved agents (`extraAgents`) |
| `POST /api/order` | Body `{account, auth}`. Runs `pb-gateway` in mode `order` over OutLayer's HTTPS API with our payment key, and answers the gateway's output plus `call_id` and `attestation_url` |
| `POST /api/cancel` | Body `{account, auth}`, mode `cancel` |
| `POST /api/set-leverage` | Body `{account}`, mode `set_leverage` |
| `POST /api/hl/submit` | Body `{account, index}`. Reads `hl.signed[index]` from the chain itself, never from the browser, posts it to Hyperliquid's `/exchange`, and answers with Hyperliquid's reply. Posting twice is harmless, because Hyperliquid refuses a reused nonce |
| `POST /api/quote` | As before. **To Hyperliquid:** origin `nep141:<mUSDC>`, destination the stand-in's Hyperliquid USDC asset, recipient `hl.address`, refund the account. **Home:** origin Hyperliquid USDC, destination `nep141:<mUSDC>`, recipient the account, refund `hl.address`. The deposit address is then the float, and the stand-in matches the deposit by sender and exact amount |

Orders are capped at 60 a minute per account, the same as the gateway's own P10 limit, so the gateway's check is the one that bites. Everything stays testnet-only.

**As built (8 Nov):**
- **`GET /api/hl/:account`** answers:
  ```json
  {"account_id": "...", "owner": "...", "block_height": 1, "near_time_ms": 1794000000000,
   "hl": <get_state().hl> | null, "address": "0x..." | null,
   "gateway": {"project_id": "...", "version_key": "..." | null, "secrets_ref": null | {"profile", "account_id"}} | null,
   "hyperliquid": null | {"clearinghouse_state": {...} | null, "spot_usdc": {"total": "0.0", "hold": "0.0"} | null,
                          "abstraction": "default" | null, "open_orders": [...] | null, "fills": [...] | null,
                          "agents": [{"name", "address", "validUntil"}] | null, "errors": {"<type>": "<why>"}}}
  ```
  - `near_time_ms` is the final block's time. The trade page builds `expires_ms` from it.
  - `gateway` is the account's pin from `get_config`. It is null for an account made before Phase 3, which can't trade.
  - `gateway.secrets_ref` is the pin's `secrets_ref` as section 3 shapes it: null as built, since the wasm's manifest names the seed's row in `author_secrets` (section 9). A pin that leaves it out answers null. The backend's own gateway runs (`/api/order`, `/api/cancel`, `/api/set-leverage`) pass no `secrets_ref`, for the same reason. `GET /api/config`'s `factory_config` is the factory's `get_config` as it is, so it carries `gateway.secrets_ref` too.
  - Each Hyperliquid read stands alone: one that fails comes back null, with its reason in `errors`.
  - `fills` are the newest 50, newest first.
  - Reads are cached: 2 s for positions, spot and open orders, 4 s for fills, 10 s for agents and 30 s for the mode. `?fresh=1` re-reads the agents and the mode at once, after an approval.
  - The request types, each a POST to `/info` with `{"type", "user"}`: `clearinghouseState`, `spotClearinghouseState`, `userAbstraction`, `frontendOpenOrders` and `userFills` are in Hyperliquid's info-endpoint docs. `extraAgents` isn't; it is in both SDKs (Python `Info.extra_agents`, `@nktkas/hyperliquid` `extraAgents`). The Python SDK's recorded answer shows the name without its ` valid_until <ms>` suffix, which comes back as `validUntil`. All six were checked live, read-only, on 8 Nov.
- **`GET /api/markets`** (new). It answers every coin of `universe_v0.json` in the file's order:
  - `allowed`, `tier`, `band_bp` (from `params.price_band`), `universe_sz_decimals` and `client_cap_usd`;
  - `testnet`, null when testnet doesn't list the coin: `{asset, sz_decimals, max_leverage, delisted, mark_px, oracle_px, mid_px, day_ntl_vlm, funding}`, read by name from `metaAndAssetCtxs`;
  - `status`, the pool's `coin_statuses` entry or null.

  It also answers `params_hash` (the file's sha256) and whether it matches the factory's `params_hash`. On 8 Nov it does. Testnet listed 19 of the 25 coins; ZEC is delisted there, so 18 can be traded. Testnet's szDecimals can differ from the file's (ZEC: 0 against 2), so the page rounds with testnet's meta.
- **`POST /api/order` and `/api/cancel`** answer the gateway's output, with `call_id` and `attestation_url` added, and HTTP 200 for its refusals too.
  - **Before paying for a run,** the backend checks:
    - the message's shape: `pb`, `account`, the order or cancel fields, and `expires_ms`;
    - the NEP-413 signature, checked against a vector made with near-api-js 7.4.0's own signer;
    - that `auth.owner` is the account's owner (403 `not_owner` if not).
  - **The gateway checks all of it again,** plus the key, the expiry and the nonce.
  - **Which gateway runs:** the version pinned in the account's `get_config().gateway`. The answer is 409 `no_gateway` for an account made before Phase 3, and 409 `bad_config` for a pin to another project.
  - **When OutLayer answers 408 or 500, or doesn't answer at all,** the reply is 502 `outlayer_unknown`. It says the order may still have reached Hyperliquid.
- **Limits:**
  - orders: 60 a minute per account, counted before the run;
  - cancels: 60 a minute per account;
  - `set-leverage`: 6 a minute per account, since it needs no signature;
  - gateway runs: 240 a minute in all, to cap what the payment key can be made to spend;
  - `hl/submit`: 30 a minute in all.
- **`POST /api/hl/submit`** posts `{"action", "nonce", "signature"}` and nothing else, as section 8 says.
  - It refuses an entry (422) that isn't an `approveAgent` or a `sendAsset`, isn't for `Testnet`, was signed for another `signatureChainId` than the account's config says, or whose nonce or signature doesn't match.
  - It answers `{account, index, kind, nonce, ok, http_status, hl, posted}`.
- **`POST /api/quote` with a move:** the body is `{dry, move: "to_hl" | "home", account, amount, slippageTolerance?}`, with `amount` in micro-USDC either way.
  - The backend reads `hl.address` from the chain, so the browser can't name the recipient. There is 409 `no_hl_address` before `hl_init`.
  - **Home:** the backend sends the stand-in amount × 100, since its Hyperliquid USDC has 8 decimals, like 1Click's. It adds the deposit msg. It is refused while a loan is open (409 `loan_open`), since the account refuses `hl_withdraw` then.
  - **"A loan is open"** follows the account: Phase 3 code answers `loan: {principal, open}`, and `open` stays true until a repayment comes back partly unused. The backend uses `open` where it is there, and `principal != "0"` for older code. So `{"principal":"0","open":true}` still refuses the move home, and `{"principal":"5","open":false}` doesn't.
  - **The next call:** the answer adds `move: {kind, account, hl_address, next}`, where `next` is the account's next call for a committed quote:
    - `{"method":"withdraw","args":{"token","amount":<amountIn>,"receiver":<deposit address>}}`, or
    - `{"method":"hl_withdraw","args":{"amount":<amountIn / 100>,"destination":<the float>}}`.

    For home, the backend checks that the deposit address is the float, and that `amountIn` has at most 6 decimals.
  - **Checked against the stand-in,** with dry quotes only, on 8 Nov:
    - 25 mUSDC → 24.6799 USDC, in 30 s;
    - 25 USDC → 24.797261 mUSDC, in 35 s, with `amountIn` exactly the amount sent.

## 12. Web app and testnet tools in Phase 3

- **Account page, a "Hyperliquid" card:**
  1. **Set up:** `hl_init`, then show the derived address.
  2. **Get the gateway's agent:** `request_agent` (0.01 NEAR).
  3. **Approve the agent:** `hl_approve_agent`, then `POST /api/hl/submit` for the new signed action. It shows "approved" once Hyperliquid's `extraAgents` lists the agent.

  The card also shows Hyperliquid equity, positions and the margin ratio.
- **Moving money:**
  - **To Hyperliquid:** a quote, then `withdraw` to the deposit address, then the live status.
  - **Home from Hyperliquid:** a quote, then `hl_withdraw`, then `/api/hl/submit`, then the live status.
- **Trade page.** Pick a coin (the 23; those testnet lists can be selected), a side, a size, a limit price with the coin's band shown around the reference price, reduce-only, and the time in force. The browser rounds to Hyperliquid's rules, builds the §9 message, has the wallet sign it (`signMessage`, NEP-413, recipient `pb-gateway`) and posts `/api/order`. It shows the gateway's answer in words, including which check refused. The page also lists open orders with a cancel button, positions and recent fills.
- **Borrow page:** as now. If time allows, add what Rhea alone would lend and the carry (funding earned against interest paid).
- **Operator page,** signed by the operator's wallet: the pool's KYB flag, co-signing, pause and coin status. This comes after the gate items.
- **Testnet float tools** (`services/oneclick-shim`). Each refuses a non-testnet `HL_API_URL`.
  - `float:order` places a limit order from the float, to post the other side of a demo trade on testnet's thin book.
  - `float:cancel` cancels it.
  - `float:close` closes the float's position.
- **`.claude/launch.json`:** add `shim` on port 8787.

**As built (8 Nov):**
- **Signing an order.** near-connect 0.11.4 exposes `wallet.signMessage({message, recipient, nonce: Uint8Array, network?, signerId?})`, which answers `{accountId, publicKey, signature}` (`build/types/index.d.ts`). The wallet's own executor signs, in near-connect's sandbox. The template's access-key plugin doesn't touch `signMessage`, so the wallet's full-access key signs.
  - **Meteor Wallet** answers `publicKey` as `ed25519:<base58>` and `signature` as padded base64 of the 64 bytes (`meteor_wallet_sdk`, `packages/meteor-near-connect/src/meteor-near-connect/nearConnectExecutor.ts`: `base64.encode(signature)`). That is the Auth as section 9 wants it.
  - **Other wallets:** the page also accepts base58 (with or without `ed25519:`) and hex, and converts them.
  - **Before posting,** the page checks that the signer is the account's owner.
- **The order message** is built with section 9's key order, in `web/src/lib/gateway.ts`. `expires_ms` is `near_time_ms` plus the time since it was read, plus 90 s: inside the gateway's 120 s, with room for the wallet's popup. The nonce is 32 random bytes.
- **Rounding** (`web/src/lib/hl-rules.ts`) follows Hyperliquid's tick-and-lot-size page, with bigint decimals:
  - sizes are cut to szDecimals;
  - prices are rounded to 5 significant figures and 6 − szDecimals decimals; an integer price is left as it is;
  - a buy's price rounds down and a sell's up, so the rounded limit is never worse than the one typed;
  - an order under $10 can't be sent;
  - the page shows what rounding changed before signing.
- **The band** is shown around testnet's oracle price, standing in for the gateway's reference price, which is the engine's median of exchange prices. The page warns when a limit is outside the band (P2) or near its edge.
- **The coin list** holds the 23, plus TAO and GRAM marked "not on the list", so a P1 refusal can be shown. A coin can be picked only when testnet lists it and hasn't delisted it. The page warns when the pool marks a coin reduce-only or removed, and when testnet's mark and oracle differ by more than 10% (HYPE: 82 against about 2,000).
- **The answer in words:** a fill, a partial fill or a resting order, then the engine's `after`. A refusal names its check: P0–P10, `AUTH`, `HL` or `INPUT`, from RISK_ENGINE.md 9, with the gateway's own `reason`.
- **The rest of the trade page:**
  - open orders, each with a cancel signed like an order;
  - positions, each with a "Close…" button that fills the form with a reduce-only IOC order half the band past the reference;
  - the last 50 fills;
  - a button for `set-leverage`.
- **The Hyperliquid card** (account page) goes through four steps:
  1. **Address:** `hl_init`, 100 TGas, no deposit. Anyone may call it.
  2. **First deposit of at least $10:** Hyperliquid refuses actions from an address that has never had a deposit, so this comes before the approval.
  3. **Agent:** `request_agent`, 300 TGas and 0.01 NEAR.
  4. **Approval:** `hl_approve_agent`, 300 TGas and 1 yoctoNEAR.

  The card also shows:
  - **Equity:** the perps account value, plus spot USDC when the mode is `unifiedAccount` or `portfolioMargin`. In `default` mode, spot USDC is shown but left out, with a note, until section 9's question is answered.
  - **The margin ratio:** `crossMaintenanceMarginUsed` ÷ equity.
  - **Positions,** and every signed action, each with a "Post to Hyperliquid" button.
- **Finding a new signed action:** after `hl_approve_agent` or `hl_withdraw`, the page reads the new entry's index from the `hl_signed` event in the transaction's logs. If it isn't there, the page reads `get_state` every 2.5 s for up to 60 s for a newer entry of that kind. Then it calls `/api/hl/submit`.
- **Moving USDC** (account page, below the card):
  - **To Hyperliquid:** a first move of at least 10 USDC. With a loan, the `withdraw` goes through the usual withdraw check first.
  - **Home:** `hl_withdraw` with the quote's `next` arguments; it is off while a loan is open.
  - **Both:** the status is read every 5 s from the committed quote on, until it is final.
- **The operator's controls are on the Book page,** where PLAN.md 5.8 puts them, rather than on a page of their own. They show only when the signed-in wallet is `get_params().operator`:
  - pause or resume;
  - set or clear a KYB flag;
  - co-sign a borrow, as `{"borrow":{account_id, amount}}`;
  - set a coin's status, with `emergency` for reduce-only.

  The pool's admin methods aren't payable, so these attach no deposit, and 30 TGas.
- **The Borrow page compares:**
  - **Rhea alone:** 76% of the account's nBTC (0.80 × 0.95), at about 17.38% a year with no buffer, from `research/rhea.md`, read on mainnet on 3 Nov;
  - **our line:** the verdict's line and rate;
  - **the carry:** a year of funding on the Hyperliquid positions at each coin's current hourly rate (`/api/markets`), against the loan's interest at the verdict's rate. The page says testnet's funding runs about three times mainnet's.
- **Float tools.** Run each as `pnpm --filter @pb/oneclick-shim float:<tool> -- <flags>`:
  - `float:order -- --coin BTC --side buy|sell --size 0.0002 --price 75000 [--tif Gtc|Ioc|Alo] [--reduce-only] [--yes]`;
  - `float:cancel -- --coin BTC --oid <oid>`, or `-- --all [--coin BTC]`;
  - `float:close -- --coin BTC [--slippage-bp 50] [--price <p>]`: a reduce-only IOC order for the whole position, 50 bp past the mark by default.

  What each one does:
  - loads `.env` itself, and refuses an `HL_API_URL` whose host doesn't contain `testnet`;
  - checks that the key belongs to `HL_FLOAT_ADDRESS`, and never prints it;
  - reads coins by name from testnet's meta;
  - refuses an unrounded size or price, and says the rounded one;
  - refuses orders under $10, and asks for `--yes` above $100 (a close needs none).

  **Run live on 8 Nov:**
  1. a resting buy of 0.0002 BTC at 70,000, then its cancel;
  2. an IOC buy of 0.0002 BTC, filled at 75,795, closed by `float:close` at 75,787.

  The float went from 790.63262 to 790.617379 USDC (−0.0152, fees and spread). It has no position and no open order.
- **`.claude/launch.json`:** `shim` builds `@pb/oneclick-shim` and its workspace dependency first (`pnpm --filter '@pb/oneclick-shim...' build`), then starts it. It listens on port 8787, from `SHIM_URL`.
- **The keeper's backup** (`services/keeper/src/hl-post.ts`): each tick, it posts each account's signed entries from the last 10 minutes that it hasn't posted yet. These are testnet `approveAgent` and `sendAsset` entries only. If Hyperliquid doesn't answer, it tries again; it doesn't repost one Hyperliquid has answered. The keeper now also refuses an `HL_API_URL` whose host doesn't contain `testnet`.
- **Borrowing paused** (Account and Borrow pages, `web/src/components/send-window-notice.tsx`). While `get_state().hl.send_open_until_ms` is in the future, both pages say "Borrowing paused until <time>." and one sentence why: "The account signed a transfer of USDC out of Hyperliquid that can still be posted until then, so a check now could count money that is about to leave." The Borrow page's check and borrow buttons are off until then, since the account refuses `borrow` (section 8, the send window). The notice redraws every 30 s, so it goes away on its own. The pages read "a loan is open" as section 11 does: `loan.open` where the account has it.
- **The gate script** (`services/keeper/src/hedge-demo.ts`; the steps in `hedge-steps.ts`, the pure parts in `hedge-kit.ts`). It runs PLAN.md 11.4's gate from the command line, modelled on `scripts/first-loan.py`:

  ```
  pnpm --filter @pb/keeper hedge:demo -- --name <label> [--size small|full] [--from <step>] [--dry-run]
  ```

  - **What it needs:** the backend at `API_URL` (default `http://localhost:8788`) with `gateway_enabled`, and the stand-in on 8787. The client account is `<label>.pbf.testnet`, owned by the keeper (`KEEPER_ACCOUNT_ID`, default `pbf-keeper.testnet`). The keeper's key (`KEEPER_PRIVATE_KEY`) is loaded from `.env` inside the program and never printed. It signs the NEAR transactions, and the NEP-413 order messages for `pb-gateway`.
  - **Refuses to start** unless `NEAR_NETWORK` is testnet, `HL_API_URL`'s host contains `testnet`, the backend talks to Hyperliquid testnet, and the factory pins a gateway.
  - **The steps,** in order (`--from` takes these names):
    1. `create`: `create_account` with 4 NEAR, skipped if the account exists and the keeper owns it. It checks the account pins a gateway.
    2. `deposit`: mint and deposit mUSDC and mNBTC.
    3. `hl_init`: the Hyperliquid address. The record keeps the gas of the MPC signer's receipts (`derived_public_key`).
    4. `to_hl`: a move quote, `withdraw` to its deposit address, `/api/status` until `SUCCESS`, then the USDC on Hyperliquid.
    5. `agent`: `request_agent`, until `hl.agent` is set.
    6. `approve`: `hl_approve_agent`, `/api/hl/submit`, until `extraAgents` lists the agent.
    7. `short`: the float rests a bid 0.3% under the mark (`float:order`); the account's IOC sells at that price go through `/api/order` until the size is done; the float's leftover is cancelled.
    8. `borrow`: a preview, `request_check` for a borrow 0.5% under the line, then `borrow`. It stays under the pool's own limits too, and says so if one holds the loan more than 2% under the line.
    9. `take_out`: a preview for `allow.withdraw`, `request_check` with a withdraw intent for the loan, then `withdraw` of the loan's mUSDC to the keeper. This is PLAN.md 2's "the client takes the loan out", and 11.4's "with the loan out". The engine sizes a loan as if it leaves (RISK_ENGINE.md 7.2). With the loan still in the account, its USDC covers the unhedged nBTC, and closing the short goes through.
    10. `refuse_close`: a reduce-only IOC buy of the whole short. It must be refused with P5–P9.
    11. `burst`: the float bids for all 40; then 40 IOC sells of just over $10 each, signed at once with one expiry 110 s ahead, and posted together. The record tallies fills, rests and refusals by code. The step passes when a preview afterwards shows the account HEALTHY, with allowance equity at least IM and the loan within the tier cap (two of P8's three conditions; the extreme-day pool loss isn't in a verdict).
    12. `refuse_coin`: an IOC buy of TAO, outside the list. It must be refused with P1.
    13. `repay`: the keeper puts the loan back (minting from the test faucet only the interest it lacks), then `repay` of the debt plus 0.1% plus 1 USDC; the pool sends back the rest.
    14. `close_short`: the float rests an ask 0.3% over the mark; reduce-only IOC buys close the short. The float then closes whatever it holds.
    15. `home`: a move quote, `hl_withdraw` (with `source_dex: ""`), `/api/hl/submit`, then the status until `SUCCESS`.
    16. `withdraw`: both tokens to the keeper, with no verdict.
  - **The sizes.** `full` is PLAN.md 2's book: $25k of mNBTC at the live price, 9,600 mUSDC deposited and 9,500 moved to Hyperliquid, a $25k short. `small` is the same book at about 1/22 of the size: 0.015 mNBTC, 440 mUSDC deposited, 430 moved, a 0.015 BTC short. Each size has hard caps (the move, the short, the borrow, the float's side, the nBTC), checked before anything is sent.
  - **Why those proportions.** With the loan out, closing the short is refused when the equity left is under the unhedged nBTC's requirement (P8). The line is 70% of collateral (C4), so that holds when the USDC is under about half the nBTC. It was checked natively, with `pb-gateway`'s `check_order` and `pb-risk` on `pb-risk`'s `hedged` fixture (BTC at $76.1k), rescaled, with the loan 0.5% under the line:

    | Book | Line | Close the short, loan out | 40 orders | Close the short, loan in |
    |---|---|---|---|---|
    | `full` | $24,160 (C4) | P8: equity $10,316 against IM $11,576 | all pass | goes through |
    | `small` | $1,103 (C4) | P8: equity $471 against IM $527 | all pass | goes through |
    | 2,000 mUSDC, 0.01 mNBTC, a 0.0002 BTC short | $1,378 (C4, Watch) | goes through | — | goes through |

    With the loan only 0.01% under the line (the web app's margin), the `small` burst hit the tier cap after 19 orders, from their fees and booked slippage alone. Hence the 0.5% margin.
  - **The float.** The stand-in delivers the move to Hyperliquid from the float's perps USDC, and the float takes the other side of every trade. So before a run, the script checks the float holds the move plus a tenth of its largest side, and can still trade that side after the move. On 8 Nov the float held 790.62 USDC and could trade 0.2087 BTC: enough for `small` (it needs about 544), not for `full` (about 12,000). A `full` run stops before sending anything until the float is topped up.
  - **The record** goes to `research/data/phase3_hedge_<size>.json` after every step: every transaction hash, gateway answer (with `call_id` and `attestation_url`), preview, verdict and timing. A new run keeps the previous record under a timestamped name. `--from <step>` reloads the record and runs from that step. The run passes when every step ran and each step's `ok` equals `!expect_fail`, with each refusal's code one of those expected.
  - **When a step fails,** the run stops, except for the two refusal steps and the burst, which are recorded and the run goes on to the close-out. On a stop, it cancels resting orders (the account's through `/api/cancel`, the float's through `float:cancel`), lists any position with the command that closes it, and prints the `--from` command to resume. Every poll has a timeout.
  - **Prices and sizes.** The refused close is a buy 0.3% under the mark, so if the checks wrongly let it through, it can't fill and the hedge stays. The gateway books a buy at no less than the mark either way (P4), so the check is the same. A remainder under $10 when opening goes as a $10.50 order. When closing, it is left and reported as dust, since the gateway applies Hyperliquid's $10 minimum to reduce-only orders too.
  - **`--dry-run`** reads testnet's BTC mark, the float and whether the account exists, prints the plan and the float check, and sends nothing. On 8 Nov, BTC at 75,766: `small` prints 440 mUSDC, 0.015 mNBTC ($1,136.50), 430 USDC to Hyperliquid, a 0.015 BTC short and 40 orders of 0.00014 BTC ($10.61); `full` prints the float problem above. The script has not been run live.
- **Open questions:**
  - P10 limits an order to 1% of the coin's daily volume. Settled in section 9: the gateway measures it on mainnet's volume, so the $25k short goes as one order.
  - The equity for a `default`-mode account whose USDC sits in spot waits on section 9's answer.
  - Nothing in sections 8, 9 or 11 has been exercised end to end yet. The factory now pins `pb-gateway` `fcae6052…` and `pb-risk` `d741714…`, with `gateway.secrets_ref` null (read on 8 Nov), so a new account can; the gate script above does it.
  - The 40 orders: OutLayer runs only a few at a time, so most of the 40 should come back P0, and some may come back `outlayer_unknown` (502) or expired (`AUTH`). The tally records each.
  - A position left under $10 can't be closed through the gateway: its $10 minimum applies to reduce-only orders. The float's `float:close` can't close another address's position either.

---

# Phase 4: guard rails and the drill

The Phase 4 gate (PLAN.md 11.5) runs the depeg drill on testnet with nobody touching anything after the shock. The account goes WATCH, then MARGIN_CALL, then DELEVERAGE confirmed twice. The plan buys back part of the short through the gateway, and the account ends HEALTHY. After that, the close-out still works, the account's records stay right after each of the stand-in's three faults, and a rebalance runs end to end in the sandbox.

**Order of work.** Build the drill's path first: the plan steps, the stored plan, the gateway's `deleverage` mode and the keeper's loop. Then the 1Click transfers and the faults, then the rebalance. The testnet demo book is the small one (PLAN.md 2): 0.015 nBTC, a 0.015 BTC short and $430 on Hyperliquid. At an nBTC/BTC ratio of 0.75, its plan should be a `perp` buy-back of about a quarter of the short. Check that with `risk-core` on that book before building on it.

## 13. Plan steps in the verdict

`plan` becomes a list of at most 4 step objects, replacing Phase 2's strings. `pb-risk` makes them for DELEVERAGE (`RISK_ENGINE.md` 8.4), and for REBALANCE and REBALANCE_NOW (8.2). Amounts are micro-USD integers; token amounts are unit strings; Hyperliquid sizes and prices are wire strings, already rounded.

| `k` | Fields | Who runs it |
|---|---|---|
| `cancel` | none | The gateway's `deleverage` mode. It cancels the account's resting orders that add risk |
| `repay` | `amt` | `execute_step`. Repays the pool from the account's NEAR USDC |
| `perp` | `coin`, `buy` (bool), `sz`, `px` | The gateway's `deleverage` mode. A reduce-only IOC order at `px`, inside the band |
| `sell` | `tok` (token id), `amt`, `min` (micro-USDC), `dep`, `exp` (unix ms) | `execute_step`. It sends `amt` of `tok` to the 1Click deposit address `dep`. The quote pays USDC back to the account with msg `{"pb":{"transfer":"<pid>:<i>"}}` |
| `to_hl` | `amt`, `dep`, `exp` | `execute_step`. USDC from NEAR to the account's Hyperliquid address, through 1Click |
| `home` | `amt`, `dep` (0x), `exp` | `execute_step`. An MPC-signed `sendAsset` of perp USDC to `dep`. The quote pays the account, with the same msg as `sell` |

- **Quotes.** `pb-risk` gets the quotes (`dep`, `exp`) from 1Click inside the run. On testnet that is the stand-in, which OutLayer can't reach until it is hosted. So on testnet, steps that need a quote are left out, and a `top` line says so. The drill's plan needs no quote.
- **`pid`.** A plan's id is the `blk` of the verdict whose plan the account stores, as a decimal string. The pool's `check_step(plan_id, step, token, amount)` takes it as `plan_id`.
- **Size.** Each step is under 200 bytes, and the verdict stays under 2 KB.

**As built (8 Nov, Phase 4), the risk side:**
- **Who makes the steps.** risk-core sizes them: `deleverage_steps` (8.4: the reference's `deleverage_plan`, operation for operation) and `rebalance_steps` (8.2, new; the reference has none). pb-risk writes them as step objects (`pb-risk/src/plan.rs`). The type is shared as `pb_read::steps::PlanStep`, which the gateway reads back from `get_state().plan`.
- **The JSON**, keys in this order; every amount is a JSON integer:
  - `{"k":"cancel"}`
  - `{"k":"repay","amt":10000000}`
  - `{"k":"perp","coin":"BTC","buy":true,"sz":"0.00375","px":"76379"}`
  - `{"k":"sell","tok":"mnbtc.pbf-ops.testnet","amt":"375000","min":280000000,"dep":"<deposit address>","exp":1794000000000}`
  - `{"k":"to_hl","amt":50000000,"dep":"<deposit address>","exp":1794000000000}`
  - `{"k":"home","amt":427651787,"dep":"0x<40 hex>","exp":1794000000000}`
- **`cancel`** comes first in a DELEVERAGE plan when the account has a resting order that adds risk (`risk_core::plan::risky_orders`):
  - a reduce-only order never adds risk;
  - any other order does, unless it is on the other side of a position;
  - if the orders on the other side could together close more than the position, all of them count.
- **`perp`:**
  - **Size:** the engine's, cut toward zero to the coin's szDecimals, read from Hyperliquid's meta in the same run.
  - **Price:** half the coin's band past the reference price, above it for a buy and below it for a sell. It is rounded toward the reference, to 5 significant figures and 6 − szDecimals decimals, so it stays inside the band (P2). While the reference price is uncertain, it is measured from Hyperliquid's mark.
  - **Hyperliquid's $10 minimum:** a smaller perp trade is raised to it if the position is that big; otherwise it is left out, with a `top` line, and the plan goes on. A pair's perp leg is never raised.
- **`repay`** is the engine's amount, to the micro-USD. A `repay` after a `sell` in the same plan repays that sale's proceeds. Run before they arrive, the account repays only what it holds, so the keeper should run it after the sale's transfer resolves.
- **A pair** is its `perp` and then its `sell`, or neither.
- **At most 4 objects.** A step that would make a fifth waits for the next verdict, and a pair is never split.
- **What a testnet run leaves out.** pb-risk can't reach 1Click from inside OutLayer on testnet (`Network::one_click_quotes` is false). So the engine plans without 1Click (`Routes::NO_ONE_CLICK`): repayments and perp trades only. When the rest of the unwind needs 1Click, `top` says `plan: the next steps need 1Click, which a testnet run can't reach`. A REBALANCE says `plan: moving $1,563 to Hyperliquid needs 1Click, which a testnet run can't reach`. No quote is fetched yet. The quote path (`pb_risk::plan::Quotes`) is written and tested with fake quotes only.
- **Size.** Each kind of step is under 200 bytes (tested). If a verdict would pass 2 KB, the farthest bands go first, then the last whole steps. The drill's DELEVERAGE verdict is 979 bytes.
- **The drill's plan.** The testnet demo book at nBTC/BTC 0.75 gets `[{"k":"repay","amt":10000000},{"k":"perp","coin":"BTC","buy":true,"sz":"0.00375","px":"<reference × 1.005, rounded down>"}]`: the 10 mUSDC left on NEAR, then a quarter of the 0.015 BTC short. After it the account is HEALTHY again, with the loan in place. `cargo run -p backtest --release -- drill` prints the whole drill for any price, margin and loan.

**As built (8 Nov, Phase 4), the account's side** (`contracts/account/src/plan.rs`): the account reads only `k` and the fields of the kinds it runs. `amt` and `exp` may be integers or strings of digits, so `sell`'s unit string parses too. `pid` is the stored verdict's `blk` as a decimal string. A verdict with more than 4 steps is refused. §14's "As built" has the rest.

**As built (8 Nov, Phase 4), the keeper's side** (`services/keeper/src/decide.ts`):
- **Which plan runs.** The keeper runs the stored plan when its `pid` is the held verdict's `blk`, or while the held verdict's action isn't NONE. An older plan under a NONE verdict isn't run.
- **`cancel` and `perp`** go to the gateway's `deleverage` mode, one run per plan (§16's keeper side).
- **`repay`, `sell`, `to_hl` and `home`** go to `execute_step({pid, i})`, 300 TGas, no deposit, in the plan's order.
  - A step whose quote has under 5 minutes left isn't run; the keeper asks for a check, for a new plan.
  - A `repay` after a `sell` waits until the sale's transfer `<pid>:<i>` has left `pending`.
  - A step that moved nothing (`execute_step` returned `"0"`, `false` or null) is tried again 15 s later, at most 3 times in all.
  - After a `sell` or `to_hl` step, the keeper tells 1Click with `/v0/deposit/submit` (PLAN.md 5.7).
- **After the steps,** one check; then the checks of §17 until the account is HEALTHY.

## 14. Account contract in Phase 4

**The stored plan.** `get_state().plan` replaces `deleverage.confirmed_plan`. `deleverage.first_at` stays.

```json
"plan": null | {"pid": "276800123", "action": "DELEVERAGE" | "REBALANCE" | "REBALANCE_NOW",
                "stored_at": "<ns>", "steps": [{"k": "perp", "...": "...", "done": false}]}
```

- A DELEVERAGE plan is stored when a second DELEVERAGE verdict confirms it under the two-check rule, as now. That second verdict's plan is the one stored.
- A REBALANCE or REBALANCE_NOW plan is stored as soon as its verdict is accepted.
- A newer stored plan replaces the old one. A verdict saying NONE while the account is HEALTHY clears it.

**`execute_step({pid, i})`.** Anyone may call it; attach 300 TGas. It refuses:
- a `pid` that isn't the stored plan's;
- a step that is done;
- the gateway's kinds, `cancel` and `perp`.

Otherwise, by kind:
- **`repay`:** it repays the smaller of `amt`, the account's USDC and its debt, without `check_step`, so repaying always runs.
- **`sell`, `to_hl`, `home`:**
  1. It needs `exp − now ≥ 5 minutes`.
  2. It calls `pool.check_step(pid, i, token, amount)` first.
  3. It sends: `storage_deposit` plus `ft_transfer` to `dep` for `sell` and `to_hl`, or an MPC-signed `sendAsset` to `dep` for `home`, which also opens the send window (§8).
  4. It records the pending transfer.

It marks the step done when it starts, so each step runs once, and logs `step_run`.

**Pending 1Click transfers.** `pending` gains this kind of entry:

```json
{"transfer": {"id": "276800123:1" | "move:4", "kind": "sell" | "to_hl" | "home",
              "token": "<id or USDC>", "amount": "<units>", "dep": "...", "deadline": "<ns>"}}
```

- **Deadline:** the quote's `exp` plus 30 minutes.
- **The owner's own moves** (Phase 3's moves to and home from Hyperliquid) record one too, with id `move:<n>`. They use an optional argument: `withdraw({token, amount, receiver, transfer: {"kind": "to_hl", "exp": <ms>}})` and `hl_withdraw({amount, destination, source_dex?, exp?})`.
- **Resolved when:**
  - `ft_on_transfer` arrives with msg `{"pb":{"transfer":"<id>"}}`, which is a delivery, or a refund of the token sent; or
  - an accepted verdict lists the id in a new field, `arrived`. `pb-risk` sees a `to_hl` delivery on Hyperliquid, matched by amount after it was sent.
- **Overdue:** a transfer past its deadline. While any transfer is overdue, `borrow` and `withdraw` with a loan are refused.

**DEFAULT** (the rule since 9 Nov, `research/audit.md`, A2):
- **Two checks, as for DELEVERAGE.** A DEFAULT is confirmed only by a second DEFAULT verdict 2 to 5 minutes after the first, and never at once.
- **What the confirming one does:** the account calls `pool.write_off(self)` and sets `blocked`.
- **A single DEFAULT verdict changes nothing.**
- **Lifting the block:** `lift_block()` lifts it once the pool's `get_borrower` says `blocked: false` and a debt of 0.
- **Repaying never stops.**

**Repaying during outages.** Anyone may call `repay` when the stored verdict says MARGIN_CALL or worse and is more than 30 minutes old by block time. This is on top of the existing DELEVERAGE case.

**Events.** These use the same NEP-297 standard as the pool's events:
- `plan_stored` `{pid, action, steps}`;
- `step_run` `{pid, i, k}`;
- `transfer_done` `{id, how: "arrived" | "refunded" | "verdict"}`.

**As built (8 Nov, Phase 4):** `contracts/account` (`plan.rs`, and `lib.rs` under "The plan"). Nothing is deployed yet.
- **The view.** `get_state()` now carries:
  ```json
  "deleverage": {"first_at": "<ns>"},
  "plan": null | {"pid": "1320", "action": "REBALANCE", "stored_at": "<ns>",
                  "steps": [{"k": "to_hl", "amt": "100000000", "dep": "<deposit address>", "exp": 1700000600000, "done": true},
                            {"k": "perp", "coin": "BTC", "buy": true, "sz": "0.00375", "px": "76190", "done": false}]},
  "pending": [{"transfer": {"id": "1320:0", "kind": "to_hl", "token": "musdc.pbf-ops.testnet", "amount": "100000000",
                            "dep": "<deposit address>", "deadline": "<ns>"}}],
  "next_move": 0,
  "verdict": {"intent": {...}, "received_block": 123, "received_at": "<ns>", "verdict": {...}}
  ```
  - Each step is the verdict's object, in its key order, with `done` added. A `done` the verdict sent is overwritten.
  - `done` covers only the steps `execute_step` runs. A `cancel` or `perp` step stays `false`; the gateway's own `step:<A>:<pid>:<i>` record says whether it was placed.
  - `next_move` is the number of the owner's next move. The backend builds a home quote's msg, `{"pb":{"transfer":"move:<next_move>"}}`, from it before `hl_withdraw`.
  - `received_at` is the block time the held verdict arrived (ns). The outage rule below measures from it.
- **Storing plans:**
  - A plan replaces the stored one only if its verdict's `blk` is later than the stored `pid`. A plan read at the same block is ignored, and the log says `plan <pid> kept`. So `pid`s only grow, and no transfer id `<pid>:<i>` or gateway key `step:<A>:<pid>:<i>` is ever reused.
  - A verdict whose plan has more than 4 steps is refused, like a malformed one: `the plan has 5 steps, above the 4 allowed`.
  - An empty plan is stored too, and replaces the old one.
  - NONE clears the plan only in HEALTHY. A DELEVERAGE verdict that doesn't confirm, and NONE in any other state, keep the stored plan.
  - Unknown kinds are kept, and so is a step that isn't an object (Phase 3's text steps), as `{"step": <it>}`. `pb_read::steps::stored_plan` refuses a plan holding either, so the gateway runs nothing from such a plan.
- **Reading a step.** The account reads only `k` and the fields of the kinds it runs:
  - `amt` and `exp` may be JSON integers or strings of digits. So §13's integers and `sell`'s unit string both parse.
  - `tok` and `dep` are NEAR account ids for `sell` and `to_hl`. For `home`, `dep` is `0x` and 40 hex digits, signed lowercase.
  - `min` and the gateway's fields are kept but not read.
- **`execute_step({pid, i})`:**
  - **No deposit.** It returns what the last call returns: for `repay`, the amount the pool used (U128); for `sell` and `to_hl`, whether the tokens went out; for `home`, the new `hl.signed` entry, or null.
  - **Refusals, in this order:**
    1. `no plan is stored`;
    2. `plan <pid> is not the stored plan, <pid>`;
    3. `plan <pid> has no step <i>`;
    4. `step <i> of plan <pid> has already run`;
    5. `step <i> is a perp step: the gateway places this one` (and the same for `cancel`);
    6. `step <i> is a <k> step, which the account can't run`, or `step <i> has no kind, so the account can't run it`;
    7. `step <i> can't run: its <field> is missing or not valid`.

    Then, for `sell`, `to_hl` and `home` only:
    1. `this account is blocked after a default`;
    2. `step <i>'s quote has <s> s left: a step needs 5 minutes` (exactly 5 minutes runs);
    3. `the step's token is not an allow-listed token`;
    4. for `home`, `no Hyperliquid address yet: call hl_init first`;
    5. `8 transfers are under way already: wait for one to settle`.
  - **`repay`** reads `ft_balance_of(self)` on the USDC token, then sends the smaller of `amt` and that balance with `{"pool":"repay"}`. The pool keeps at most the debt and sends back the rest, so the repayment is the smallest of the three; the account doesn't read `debt_of`. A repay leaves the counter alone, and runs on a blocked account too.
  - **`check_step(plan_id, step, token, amount)`** gets `pid`, `i`, and:
    - for `sell`, the step's `tok` and `amt`. The pool values them at its step price, so **the operator must `set_step_price` for mNBTC before a `sell` can run** (the pool refuses with `no step price is set for this token`);
    - for `to_hl` and `home`, the USDC token and `amt`.
  - **The counter.** `sell`, `to_hl` and `home` bump it as they start, as a withdrawal does. So a check under way when one starts comes back refused (`nonce`), and the keeper should run these steps between checks.
    - Since 9 Nov, `sell` and `to_hl` bump it again once their tokens have gone (`on_sent`), so each moves it on by 2, as a borrow and a withdrawal do (§4).
    - `home` still bumps it once: its send window holds back verdict-backed actions anyway.
  - **When nothing moves, the step may run again.** That covers a refusal by the pool (paused, or past $50k a day with no co-signature: the operator can co-sign and the keeper retry), a balance that can't be read, and a repay that finds no USDC (run before a sale's USDC arrives). If a newer plan replaced the stored one meanwhile, nothing moves.
  - **`step_run`** is logged when the step starts, before the pool answers.
  - **`home`** takes its nonce and opens the send window once the pool says yes. It sends from perps (`sourceDex` `""`).
- **Transfers:**
  - A transfer is recorded as it goes out, and dropped again (`transfer <id> didn't go out: nothing was sent`) if the tokens didn't leave or the signature failed. So nothing is under way for money that never left. A signature that fails still leaves the send window open.
  - **`withdraw`'s `transfer.kind`** is `to_hl` (the token must be USDC) or `sell` (another token). `home` is refused there, since a move home is `hl_withdraw`'s.
  - **`exp`** is a JSON number of ms, and must be in the future, for both `withdraw` and `hl_withdraw`.
  - **At most 8 transfers** are under way. A step or a move past that is refused.
  - **`ft_on_transfer` with `{"pb":{"transfer":"<id>"}}`** always keeps the tokens. The transfer is `refunded` if the token is the one sent, else `arrived`. With no such transfer under way, the tokens are kept as a deposit and the log says so: a late delivery is never sent back. Any listed token from any sender settles it, since the record only holds back risk-adding actions, and `pb-risk` values the balances it reads.
  - **A verdict's `arrived`** settles each id under way (`how: "verdict"`). Ids that aren't under way are ignored.
  - **Overdue** means the block time is past `deadline`. Then `borrow` and a `withdraw` with a loan are refused: `no borrow while transfer <id> is overdue: its deadline was <UTC>` (and `no withdrawal with a loan open while …`). Never held back: `repay`, `execute_step`, `request_check`, a `withdraw` with no loan, and `hl_withdraw`.
  - **`forget_transfer({id})`** (owner only, 1 yoctoNEAR) drops a transfer once it is overdue, such as one 1Click failed: that returns nothing and sends no msg, so it would otherwise hold back borrowing for good.
    - It logs `transfer_done` with `how: "forgotten"`, and works for a step's transfer as well as a move.
    - It refuses `no transfer <id> is under way`, and `transfer <id> isn't overdue yet: its deadline is <UTC>` (at the deadline itself it is not overdue yet).
    - It is safe for the pool, since money in transit already counts as 0 for credit. If the money arrives later anyway, its msg names no transfer under way, so `ft_on_transfer` keeps it as a deposit.
- **DEFAULT.**
  - **The write-off, with two checks** (9 Nov).
    - **The first verdict.** A first accepted DEFAULT verdict blocks nothing and writes nothing off. It logs `DEFAULT: a first check…`, and `get_state().default.first_at` shows when it arrived (ns).
    - **The second verdict,** 2 to 5 minutes later, sets `blocked` and calls `pool.write_off({"account_id": <self>})` with 15 TGas and no callback.
    - **What starts the pair again:** any other verdict in between, or a DEFAULT more than 5 minutes after the first. No Hyperliquid margin ratio confirms a DEFAULT at once.
    - **Later DEFAULT verdicts** don't call again. If the write-off failed, the operator calls `write_off`, which the pool allows.
    - **Left for the keeper:** a second check 2 to 5 minutes after a first DEFAULT, from `default.first_at`, as it does for DELEVERAGE.
  - **What a blocked account refuses:** `borrow`, `withdraw` (with a loan or not), `hl_withdraw`, and the `sell`, `to_hl` and `home` steps. The message is `this account is blocked after a default`.
  - **What it still does:** it repays, runs `repay` steps and accepts verdicts. After a write-off the pool is owed nothing, so it sends a repayment back.
  - **Lifting the block** (9 Nov). `lift_block()` takes no deposit and 50 TGas, and anyone may call it: it only reads the pool.
    - It asks the pool's `get_borrower(self)`. Its callback `on_unblock` is private and never panics.
    - It lifts the block when the answer says `blocked: false` and `debt` `"0"`. That is after the operator's `unblock`, or when the write-off never happened and the debt was repaid.
    - It then closes the loan record and clears DEFAULT's record, and returns true.
    - Otherwise it logs `the block stays: <why>` and returns false. On an account that isn't blocked it is refused: `this account is not blocked`.
  - **The loan record** is left as it was until the block lifts. The pool's `debt_of`, 0 after the write-off, is the authority.
- **Repaying during outages.** Anyone may repay when the held verdict's action is DELEVERAGE, or when its state is MARGIN_CALL, DELEVERAGE or DEFAULT and more than 30 minutes have passed since `received_at` (exactly 30 isn't enough). The refusal reads `only the owner can repay, unless the verdict says DELEVERAGE, or MARGIN_CALL or worse and is over 30 minutes old`.
- **Events.** The data of the three new events is one object, as in the pool's events; `hl_signed`'s stays a list of one. `transfer_done`'s `how` can also be `forgotten` (`forget_transfer`). For example, `EVENT_JSON:{"standard":"pb-pool","version":"1.0.0","event":"plan_stored","data":{"pid":"1320","action":"DELEVERAGE","steps":["perp","repay"]}}`. `steps` lists the steps' kinds, with `""` for a step that has none.
- **Callbacks** (all private, never panic):
  - `on_step_ready({pid, i})`, after `check_step` or the balance read;
  - `on_sent({id})`, after a send. Since 9 Nov it ends every token send, with `id` null for a plain withdrawal, and bumps the counter;
  - `on_hl_signed` gains `transfer` (an id, or null);
  - `on_unblock()` (9 Nov), after `lift_block`'s `get_borrower`.
- **Gas.**
  - **Named constants:** `check_step` 15 TGas, `ft_balance_of` 5, `on_step_ready` 90, `on_sent` 10, `write_off` 15. Attach 300 TGas to `execute_step`. Since 9 Nov also `get_borrower` 10 and `on_unblock` 10, for `lift_block`.
  - **Burnt in the sandbox,** whole transactions, measured before `forget_transfer` was added: `execute_step` `repay` 15.4 TGas, `sell` 13.4, `to_hl` 13.4, `home` 14.3 (with the MPC mock); `request_check` storing a plan 9.8, or with DEFAULT and the write-off 12.0; `withdraw` with a move 8.0; a delivery with its msg 6.4. The account's own receipts burnt 1.6–2.9 TGas each.
- **Sizes and storage.**
  - **The wasm:** the account's is 358,479 bytes, sha256 `1a293b2aef45e41aee08f7ca2c6a745074390ed6af12cc971970024dd2ef1eda` (was 315,992). The factory's is 553,095 bytes, `f7efc53823fcd3ab780b0f83fd5eda7ad60a79401e7255292ba074c6c2183fe0` (was 510,609).
  - **`pbf.testnet`:** the new factory code locks 42,486 bytes, 0.425 NEAR, more. It holds 6.0167 NEAR with 0.8987 free (view, 8 Nov), so about 0.474 NEAR stays free.
  - **A new client account** locks about 359,240 bytes (3.592 NEAR: the code plus 758 bytes of state, measured in the sandbox) of the 3.9755 NEAR a 4 NEAR `create_account` leaves it, so about 0.38 NEAR is left (was 0.8). Its state can grow by about 0.2 NEAR (20 signed actions, a 4 KB verdict, a plan and 8 transfers), and each step or move to a fresh deposit address pays 0.00125 NEAR for its registration. Attach 4.5 NEAR for an account that will run many steps.
- **Upgrading `pbf.testnet`.** Deploy the new factory code with no init call: the factory's state is the Phase 3 layout, unchanged. `migrate` reads only Phase 2 state, and refuses this one. The pool's wasm is unchanged (`f9c3b708…`). Accounts made before keep their Phase 3 code.
- **Open:**
  - **Refunds on testnet.** The stand-in refunds with a plain `ft_transfer`, without the msg (`services/oneclick-shim/src/engine.ts`, `#sendBack`). So a refund doesn't settle its transfer: it stays under way and goes overdue. For the drill's refund fault to leave the records right, the stand-in should refund with `ft_transfer_call` and the quote's `customRecipientMsg`, or `pb-risk` should list the transfer in `arrived`.
  - **A transfer that fails** (FAILED: nothing comes back) stays under way and overdue until the owner calls `forget_transfer`, or a verdict lists it in `arrived`.

**As built (8 Nov, Phase 4), the services' side:**
- **Moves** (the backend's `POST /api/quote` with `move`, `services/api/src/hl-handlers.ts`). For an account whose `get_state` carries `next_move`, a committed quote names the move `move:<next_move>`:
  - **home:** `customRecipientMsg` is `{"pb":{"transfer":"move:<n>"}}` in place of the deposit msg, and `move.next.args` gains `exp`, the quote's deadline in ms;
  - **to Hyperliquid:** the quote carries the same msg, for the stand-in's refund, and `move.next.args` gains `transfer: {"kind":"to_hl","exp":<the deadline in ms>}`;
  - **the answer's `move`** gains `transfer_id` (null when nothing is named) and `exp_ms`.

  A dry quote names nothing. An account without `next_move` (made before Phase 4) gets Phase 3's quote and call. If another move goes between the quote and the call, n has moved on and the msg names an id the account doesn't hold; the account then keeps the tokens as a deposit (above), so nothing is lost, and the transfer it recorded goes overdue.
- **The web app and the gate scripts** pass `move.next.args` as they come: `withdrawTx`'s `transfer` and `hlWithdrawTx`'s `exp` (`web/src/lib/tx.ts`), and `hedge-steps.ts`. The page says which pending transfer the account will record.
- **The stand-in** (`services/oneclick-shim/src/engine.ts`):
  - **The field.** 1Click's quote takes a NEAR recipient's msg as `customRecipientMsg`: "Message to pass to `ft_transfer_call` when withdrawing assets to NEAR" (`openapi.yaml`, `QuoteRequest`, read 8 Nov). The stand-in delivers with it, as before.
  - **Refunds.** It now also refunds to a NEAR `refundTo` with `ft_transfer_call` and the same msg. That settles the "Refunds on testnet" item above. This half is the stand-in's own: 1Click's spec says nothing of a msg on refunds.
  - It takes `customRecipientMsg` when the recipient or the refund is on NEAR, so a move to Hyperliquid can carry it.
  - An excess over `amountIn` goes back with no msg: the transfer the msg names was delivered.
  - A refund the receiver hands back makes the swap FAILED, with the reason.
  - A refund on Hyperliquid (a move home) is a `usdSend`, with no msg: such a transfer stays under way until it is overdue.
- **FAILED.** 1Click's statuses give a FAILED swap no refund, so nothing can settle its transfer: it stays under way, goes overdue at its deadline, and the engine counts it as nothing and names it in `top` (§15). The fault runs show this end state (§17).

## 15. `pb-risk` in Phase 4

- **Plans:** the §13 `plan` for DELEVERAGE and for REBALANCE or REBALANCE_NOW, plus `topup`. Check the plans against the Python reference's `deleverage_plan` and `topup`; the Rust port already matches the reference's text plans.
- **States:** hysteresis and the margin-call clock, read from the account's `margin_call`.
- **Transfers:**
  - money in transit counts as 0 for credit;
  - pending `to_hl` transfers seen on Hyperliquid are listed in `arrived`;
  - overdue transfers are noted in `top`.
- **Testnet:**
  - π comes from the drill ratio at once, as now;
  - the 1Click quotes come from `ONECLICK_API_URL`;
  - steps that need a quote the run can't reach are left out (§13).

**As built (8 Nov, Phase 4):** version `5a2a2a2062207f0959ed63cf3b8b2663b70a450a73be839c6c4240d3923c48f4` (1,132,038 B), built, not deployed. Build it as §9 builds the gateway: `RUSTFLAGS="--remap-path-prefix=$HOME=~" cargo build -p pb-risk --target wasm32-wasip2 --release` in `risk/`.
- **Plans:** §13's, for DELEVERAGE, REBALANCE and REBALANCE_NOW. `topup` is as before.
- **Checked against the Python reference.** On the testnet demo book (BTC at $75,800, testnet's margin table, 428.6 USDC of margin, a $1,096.805 loan), `risk_engine_ref.py` and risk-core agree to the bit on E, MR and IM along the slide, on the three bands and on the plan at 0.75 (`risk-core/tests/plans.rs`). The 10 recorded `deleverage_plan` cases still match (`reference_cases.rs`).
- **The rebalance plan:**
  - **What it adds:** enough Hyperliquid margin that neither trigger fires: the margin ratio back at 30%, and the ratio after ½·S* against every perp at most 1 / 1.02.
  - **Where it comes from, in order:**
    1. USDC on NEAR, as one `to_hl`;
    2. USDT, sold for USDC;
    3. hedged pairs, both legs, each at most 25% of the hedged position and an hour of either venue, the pair with the most maintenance margin first.
  - **Proceeds of a sale** land on NEAR. The next verdict's plan moves them, since a step can only spend what is there when it runs.
  - **On testnet** every rebalance step needs 1Click, so the plan is empty and `top` says how much it would move.
- **States:**
  - Hysteresis starts from the held verdict's state, as before.
  - The margin-call clock now counts as the account does (`MarginCall::total` in `records.rs`, from `margin_call.below` and `intervals`): each interval within the last 24 hours, and the last one up to now while `below`. Time back above MR inside an open call no longer counts. An account without `below` keeps the Phase 2 rule, counted from `since`.
- **Money in transit:**
  - Each `pending` transfer is in flight for the engine: at 98% for the state, 0 for credit, and nothing once past its `deadline`.
  - Its token is the configured token whose id is `token`, in its decimals, or Hyperliquid USDC (6 decimals) for `"USDC"`. A transfer of a token the account isn't configured for refuses the run.
  - The coin of a token in transit is priced like a held one.
- **`arrived`:**
  - **The read.** While a `to_hl` transfer is pending, pb-risk reads `userNonFundingLedgerUpdates` for the Hyperliquid address. `startTime` is the earliest pending `to_hl` deadline less 24 h 30 min. That is one more call; there is none otherwise.
  - **The match.** A credit matches a transfer if it is a USDC `internalTransfer` or `send` to the address, at least 95% and at most 100% of the USDC sent, after that start. Each credit matches one transfer, earliest deadline first.
  - **The result.** A matched transfer isn't counted in transit, and its id is listed in `arrived`, which is left out when empty.
  - **Inputs** carry `hl.ledger` and `hl.ledger_from_ms`, left out when not read, so older snapshots replay unchanged.
- **Overdue transfers** are noted in `top`: `overdue: sell transfer 276800123:1`, at most two lines, then `overdue: N more transfers`.
- **`top`** is the three biggest risks, then the plan's lines, then the overdue lines.
- **The Phase 2 replay** still prints `a2b074b4524ce36680631bd7c010caab38aecefd2b83191b5b8fa59be415c74a`. New fields are left out when empty, so its verdict bytes are unchanged.
- **Not done:**
  - **DEFAULT** (8.5): pb-risk never says it. The condition, "everything sold and D > 0", triggers `write_off`, so it needs a guard against a bad read first.
  - **A projected breach that can't be rebalanced** doesn't escalate to DELEVERAGE (8.2's last paragraph). On testnet that would be every projected breach, since no rebalance step can be quoted.
  - **8.4 step 5** (hedge a NEAR coin with a new short while 1Click is down) isn't planned.
  - **Quotes from `ONECLICK_API_URL`** aren't fetched. No 1Click that a testnet run can reach exists until the stand-in is hosted, and then the quotes must go into the inputs, so a run still replays. Each quote request must carry the payout msg `{"pb":{"transfer":"<blk>:<i>"}}`.

## 16. `pb-gateway` in Phase 4

**Mode `deleverage`.** It runs over HTTPS from the keeper and needs no owner signature, because it only places the account's stored, attested plan. Input `{"mode":"deleverage","account":A,"network":"testnet"}`.
1. It reads `get_state().plan`.
2. For each `cancel` and `perp` step not yet placed, under the P0 lock:
   - it cancels resting orders that add risk;
   - it places the `perp` step as a reduce-only IOC at `px`, refusing (code P2) if `px` has left the band.
3. It records each placed step in storage under `step:<A>:<pid>:<i>`, so it runs once.

Output:

```json
{"ok": true, "acct": A, "pid": "276800123",
 "placed": [{"i": 0, "k": "perp", "status": "filled", "filled_sz": "0.00375", "avg_px": "76190"}],
 "skipped": [{"i": 1, "k": "repay", "why": "execute_step runs it"}]}
```

**Mode `cancel_risky`.** It runs over HTTPS from the keeper, with input `{"mode":"cancel_risky","account":A,"network":"testnet"}`. It cancels the resting orders that add risk; the keeper calls it when an account leaves HEALTHY.

**As built (8 Nov, Phase 4):** version `6746393a828da9e9f3cb302f1e1a57d1c50d1042d66c3b7a659f58652a747efb` (1,407,597 B), built, not deployed. Deploy it with the seed's upgrade steps (`research/outlayer.md`, "The gateway's seed"), or the new build can't open the seed.
- **Callers.** Both modes answer `AUTH` unless the run is over HTTPS for `pbf-keeper.testnet`, as `order` does, and `INPUT` if the input carries `auth`.
- **`deleverage`, step by step:**
  1. Under the account's lock (`P0`), it makes pb-risk's reads, and reads the plan from that block's `get_state().plan`. It also reads the account's fills of the last minute.
  2. It refuses the whole run (`INPUT`) when there is no plan, or the plan is more than 30 minutes old by block time: its prices are from another market, so the keeper asks for a new check.
  3. It skips, with a reason, each step that isn't `cancel` or `perp`, that the account marked done, or that has a record other than `refused`.
  4. **`cancel`** cancels the resting orders that add risk now (the rule of §13), in one signed `cancel` action, and records `done`. A cancel Hyperliquid doesn't complete is recorded `refused`, so it can be tried again.
  5. **`perp`** is checked again before it goes: 60 orders a minute (`P10`); Hyperliquid's form (`INPUT`); the band around today's reference price, or the mark while that is uncertain (`P2`); and that it only reduces the position, counting the gateway's own unshown orders (`P3`).
  6. Then it takes `step:<A>:<pid>:<i>` (`set_if_absent`, or `set_if_equals` from a `refused` record) and posts a reduce-only IOC at `px`. The cloid is `0x` and the first 16 bytes of sha256(`"pb-gateway plan:"` ‖ A ‖ `":"` ‖ pid ‖ `":"` ‖ i). The order goes into `recent:<A>` like any other.
- **What a step's record says:**
  - `filled`, `partial` or `resting`: from Hyperliquid's answer;
  - `unknown`: Hyperliquid didn't answer. It may have gone, so it never goes again;
  - `refused`: Hyperliquid refused it, so nothing was placed, and a later run may try again;
  - `sending`: a run that stopped mid-way. It never goes again.
- **Output.** As above, plus `refused`, left out when empty: each step that was tried and refused, with its code (`P2`, `P3`, `P10`, `INPUT` or `HL`). `ok` stays true. So a `P2` is `{"i":1,"k":"perp","code":"P2","reason":"px 80000 has left BTC's 1% band around 75999.99: ask for a new verdict"}`, and the keeper asks for a new check. A `cancel` in `placed` lists the ids it cancelled: `{"i":0,"k":"cancel","status":"done","cancelled":[11]}`. A second run answers `"skipped":[...,{"i":1,"k":"perp","why":"ran before: filled"}]`.
- **Any stored plan** is placed this way, a REBALANCE pair's perp leg included. Every order is reduce-only, so it can only shrink a position.
- **`cancel_risky`:**
  - It runs under the lock, and only while the held verdict says something other than HEALTHY (`INPUT` otherwise: "its resting orders stay").
  - It cancels the risky orders in one action.
  - It answers `{"ok":true,"acct":A,"cancelled":[{"coin":"BTC","oid":11}],"hl":<Hyperliquid's answer, or null when there was nothing to cancel>}`. A cancel Hyperliquid refuses is `HL`.
- **Cost.** `deleverage` makes pb-risk's reads (27 calls for the drill book), 1 fills read and 1 post per step placed. `cancel_risky` makes the reads and at most 1 post.
- **Not run live yet.** Both modes are tested natively on pb-risk's `drill` fixture, with the signatures recovered to the agent. They need the Phase 4 account's `get_state().plan`; until then, `deleverage` answers `INPUT` ("holds no plan to run").

**As built (8 Nov, Phase 4), the keeper's side** (`services/keeper/src/outlayer.ts`, `index.ts`):
- **How it calls.** The keeper runs both modes itself over OutLayer's HTTPS API with `OUTLAYER_PAYMENT_KEY`, so the runs execute as `pbf-keeper.testnet`. It runs the version the account pins (`get_config().gateway`, read every 10 minutes), and at most 30 gateway runs a minute. It doesn't go through the backend.
- **`deleverage`,** once per stored plan that has a `cancel` or `perp` step:
  - `ok` with nothing in `refused`: done;
  - `P0`, `READ`, `HL` or `P10`, as the answer's `code` or in `refused`: again 15 s later, at most 3 runs in all;
  - anything else (`P2`, `P3`, `INPUT`, a plan over 30 minutes old): a check, for a new plan.

  The gateway's step records stop a repeat from placing anything twice, so a restarted keeper's extra run costs one call.
- **`cancel_risky`:** when a verdict leaves HEALTHY, and when the keeper first sees an account that isn't HEALTHY. Its answer is logged and not retried.

## 17. Keeper, backend and web in Phase 4

**Keeper loop** (PLAN.md 5.7). It is a long-running process, `pnpm --filter @pb/keeper start`, signing with the keeper's key. It watches every client account that has a loan, using the factory's `list_accounts`.
- **Checks:**
  - every 15 s, it compares the marks, and π (the drill ratio on testnet), with the last verdict's bands, and calls `request_check` on a crossing or a state change;
  - during a MARGIN_CALL, it checks at least every 5 minutes;
  - every hour, it checks at a random minute.
- **On a DELEVERAGE verdict:**
  1. It asks for a second check 2–5 minutes later, aiming for about 2.5.
  2. Once the plan is stored, it calls the gateway's `deleverage` mode for `cancel` and `perp` steps, and `execute_step` for the rest. It polls 1Click for transfers.
  3. It checks again, and repeats until the account is HEALTHY.
- **REBALANCE:** it acts at once.
- **Leaving HEALTHY:** it calls `cancel_risky`.
- **The log:** it records every action, with transaction hashes and attestation URLs, as JSON lines.

**Drill tools.** `pnpm --filter @pb/keeper drill -- --ratio 0.75` sets `drill.set_ratio` with the operator's key. `--slide 0.82,0.78,0.75 --every <minutes>` walks it down by itself, so nobody touches anything after starting it. `--reset` sets it back to 1.0. (This line said 0.84, 0.80, 0.75, which skips MARGIN_CALL on the small book: the slide comes from the account's bands, as built below.)

**Backend:**
- `POST /api/drill/fault {fault}` sets the stand-in's fault switch, using `SHIM_ADMIN_TOKEN`, testnet only;
- `GET /api/drill` returns the drill ratio and the fault in force.

**Web:**
- **Risk page:**
  - the buffer and IM, the top risks in words, and the bands;
  - the margin-call clock;
  - the stored plan, with each step's status;
  - pending transfers, with overdue ones marked;
  - the verdict history, with attestation links.
- **Drill panel:** the current ratio and fault; the fault switch; the slide command to run.

**As built (8 Nov, Phase 4):** `services/keeper`, `services/api`, `services/oneclick-shim` and `web`. Nothing here has run live. The tests run it against fakes and a scripted chain, and the dry runs read testnet.

**The keeper** (`index.ts` wires it, `decide.ts` decides, `loop.ts` acts):
- **Run it:** `pnpm --filter @pb/keeper start`. It builds, then runs, and loads the repo's `.env`. Options go after `--`:
  - `--once`: one tick;
  - `--account <id>` (repeatable): these accounts instead of the factory's list;
  - `--dry-run`: it reads and decides, logs what it would do, and sends nothing (no transaction, no gateway run, no post to Hyperliquid).

  `.claude/launch.json` has a `keeper` entry.
- **Keys.** `KEEPER_PRIVATE_KEY` signs `request_check` (`{"check":{}}`, 0.01 NEAR, 300 TGas) and `execute_step` (no deposit, 300 TGas). `OUTLAYER_PAYMENT_KEY` runs pb-gateway (§16's keeper side). Neither is ever logged.
- **What it watches:** every account the factory lists (`list_accounts`, read once a minute). Each tick it reads each account's `get_state` and acts only while a loan is open (`loan.open`, or the principal on older code).
- **Each tick (15 s):** the final block, Hyperliquid's marks, the drill's ratio (π for nBTC, as pb-risk reads it on testnet) and the keeper's balance; then every account, side by side.
- **Checks.** One check carries every reason that is due:
  - **A band crossed.** Each level in the held verdict's `bands` is compared with the price now and at the last tick: coin levels with Hyperliquid's mark, token levels with π. A level whose side changed asks for a check. The IM, MR and 0.8 × MR levels are where the state changes, so this is also the "state change" test. A verdict the keeper asked for is measured from the prices when it asked, so a level crossed while the check ran shows at once.
  - **A big move** in a held asset the verdict has no band for: 2 points of ratio for a token, or 5% of the mark for a perp. Once per verdict.
  - **A used verdict.** When an action used the held verdict (its `nonce` is below the counter), its bands describe the book before the action, so one fresh check follows a minute with no change. After `take_out`, this brings the nBTC bands.
  - **MARGIN_CALL or DELEVERAGE:** at least every 5 minutes after the last check or verdict.
  - **Each hour,** at a random minute.
  - **Again:** a check that failed to send, or whose verdict the account didn't keep, at most 3 times.
- **DELEVERAGE.** The second check goes when `deleverage.first_at` is 150 s old by the final block's clock (the contract's clock), once per pair. If the plan isn't stored 40 s later, it goes again, until 270 s. After 5 minutes, a check starts a new pair.
- **The stored plan:** §13's and §16's keeper sides. Once its steps have run, one check. After a plan, WATCH gets a check every 5 minutes for up to an hour, until HEALTHY; MARGIN_CALL and DELEVERAGE have their own.
- **REBALANCE and REBALANCE_NOW:** the account stores the plan at once, so the keeper runs it at once. On testnet these plans are empty (§15).
- **Leaving HEALTHY:** `cancel_risky`, once per change.
- **Transfers.** Each pending transfer is logged when 1Click's status changes (polled every 30 s, NEAR deposit addresses only: a Hyperliquid deposit to the stand-in's float needs its memo, which the account doesn't keep), once when it goes overdue, and when it leaves `pending`.
- **Phase 3's backup** stays: it posts each new signed action, a `home` step's `sendAsset` included.
- **A restart** picks up where the last run stopped: the keeper takes its timing from the chain (the plan's `pid`, `first_at`, each step's `done`), and a repeat is refused by the account or skipped by the gateway.
- **The log:** JSON lines on stdout, appended to `KEEPER_LOG_FILE` (default `services/keeper/logs/keeper.jsonl`, gitignored). Each line has `t`, `event` and `msg`, a plain sentence, plus:
  - `start`, `stop`;
  - `tick`: `block`, `btc_mark`, `nbtc_ratio_bp`, `keeper_near`, `accounts`;
  - `account`, on any change: `loan`, `state`, `action`, `plan` with each step's `done`, `pending`;
  - `verdict`, each new one: `blk`, `eq`, `mm`, `im`, `bands`, `top`;
  - `decide`: each action and why;
  - `check`: `tx`, `attestation_url`, `accepted`, `reason`, `why`. The attestation is OutLayer's `/attestations/by-tx/<tx>`, which answered 200 for Phase 3's check `A9aRbkGN…` (read 8 Nov);
  - `gateway`: `mode`, `ok`, `code`, `placed`, `skipped`, `refused`, `cancelled`, `call_id`, `attestation_url`;
  - `step`: `pid`, `i`, `k`, `tx`, `failure`, and the account's events;
  - `transfer`, `hl_post`, `note`, `error`.
- **Status page:** `http://127.0.0.1:8789/` (`KEEPER_PORT`): the last tick, and for each account its state, last check, next hourly check, second check, the plans it ran and the transfers.
- **Tested** with a scripted chain: a fake account with the two-check rule and the stored plan, an engine scripted to answer each check from π, and a fake gateway. The slide 0.84 at 1 minute, 0.80 at 4 and 0.75 at 7 (the fake's bands at 0.85, 0.81 and 0.77) gives:
  1. a check at 60 s, then `cancel_risky` at 75 s (WATCH);
  2. checks at 240 s (MARGIN_CALL) and 420 s (the first DELEVERAGE, in at 430 s);
  3. the second check at 585 s, 155 s after the first arrived;
  4. the gateway's `deleverage` and `execute_step` for the repay at 600 s;
  5. a check at 615 s: HEALTHY.

  Each rule is also tested on its own.
- **A dry run** read testnet on 8 Nov: 4 accounts, none with a loan; BTC at 75,805; the ratio at 1.0.

**Drill tools** (`drill.ts`, `drill-kit.ts`):
- `pnpm --filter @pb/keeper drill -- --ratio 0.75`, `--slide 0.82,0.78,0.75 --every 2`, `--slide auto --account <name> [--below 150]`, `--reset`, `--show`; `--dry-run` on any of them.
- It loads `OPERATOR_PRIVATE_KEY` itself and never prints it, checks that the drill's `owner()` is the operator, sends `set_ratio({bp})` with 30 TGas and no deposit, and prints each transaction. Each level is held `--every` minutes (default 2).
- **The slide's values** depend on the book. On the small book at BTC $75,800 the states turn below 0.8406 (WATCH), 0.7970 (MARGIN_CALL) and 0.7594 (DELEVERAGE) (the risk side, 8 Nov), so the example above, 0.84, 0.80, 0.75, would skip MARGIN_CALL; 0.82, 0.78, 0.75 work there. `--slide auto` lands each step `--below` bp (default 150) past the bands of the account's held verdict.

**The gate script** (`drill-demo.ts`, `drill-watch.ts`): `pnpm --filter @pb/keeper drill:demo -- --name <label> [--slide auto | <ratios>] [--below 150] [--every 2] [--max-hold 6] [--timeout 40] [--from <step>] [--dry-run]`.
- **It needs** the backend, the stand-in and the keeper running, the keeper's key (it owns the account) and the operator's key (the drill).
- **The steps:**
  1. hedge-demo's own steps (`hedge-steps.ts`), from `create` to `take_out`: the small demo book with the loan taken out. `hedge:demo -- --until take_out` stops at the same place.
  2. `keeper`: the account's `get_state` has `plan` (Phase 4 code); the keeper's log shows a tick under a minute old, not a dry run, that lists the account, and the account seen with its loan (at most 3 minutes).
  3. `drill`: the slide, then only watching. With `--slide auto` (the default), the slide comes from a fresh preview's nBTC bands, each less `--below` bp (the held verdict's bands if the preview fails). Each level is held at least `--every` minutes, and until its state shows (WATCH, MARGIN_CALL, DELEVERAGE), at most `--max-hold` minutes. Every 5 s it records the verdicts, the changes of state, the stored plans, each step's `done`, pending transfers, the BTC position (from Hyperliquid's info API) and the keeper's log lines for the account. It ends once a HEALTHY verdict follows a DELEVERAGE plan, or at the timeout. It never acts for the keeper.
  4. `reset`: the ratio back to 1.0. A stop after the slide started resets it too.
  5. hedge-demo's close-out: `repay`, `close_short`, `home`, `withdraw`.
- **The drill passes** when, in this order, the account went WATCH, MARGIN_CALL and DELEVERAGE; two DELEVERAGE verdicts came and a DELEVERAGE plan was stored; the BTC short got smaller after the plan was stored; and a HEALTHY verdict followed.
- **The record:** `research/data/phase4_drill_small.json`, saved after every step and every 30 s during the drill. `--from <step>` resumes from it.
- **A dry run** prints the book, the float, the keeper's balance, the drill and whether the keeper is watching. On 8 Nov the keeper held 11.06 NEAR, the float 786.04 USDC, and the ratio was 1.0.

**Fault runs** (`fault-run.ts`, `fault-kit.ts`): `pnpm --filter @pb/keeper faults -- --name <label> [--amount 11] [--late-seconds 90] [--skip-overdue] [--from <step>] [--dry-run]`, on an account of their own, with no loan.
- **Setup:** hedge-demo's `create`, `deposit` (80 mUSDC), `hl_init` and `to_hl` (40 USDC, no fault).
- **`to_hl_arrived`:** one check. Its verdict lists the setup's move in `arrived` (pb-risk sees the USDC on Hyperliquid), which settles it. 40 USDC keeps the credit over pb-risk's 95% match after Hyperliquid's 1 USDC fee for a new address.
- **Each fault** is one 11 USDC move with the stand-in's switch set through `POST /api/drill/fault`, and set back to `none` after. It snapshots the account's pending transfers, its mUSDC and its Hyperliquid balance before, just after its call and once the fault has played out, with a preview just after the call and at the end (equity, `arrived`, `top`), 1Click's statuses, and the stand-in's refund or delivery transaction with the account's events in it.
  - **`fault_refund`** (to Hyperliquid): REFUNDED; the transfer recorded, then gone; the mUSDC back.
  - **`fault_fail`** (to Hyperliquid): FAILED; the transfer still under way; the mUSDC gone.
  - **`fault_late`** (home, 90 s late): SUCCESS, later than the delay; the transfer recorded, then gone; the mUSDC arrived.
  - **`fail_overdue`:** it waits for the failed transfer's deadline (about 35 minutes more), then checks that the transfer is still under way and that a preview's `top` names it overdue. `--skip-overdue` leaves this step out.
- **Then** `home` and `withdraw`. The switch applies to every swap whose deposit arrives while it is on, so run this while nothing else moves money through the stand-in.
- **So the run covers each way a transfer ends:** a verdict's `arrived`, a refund's msg, a late delivery's msg, and going overdue.
- **The record:** `research/data/phase4_faults.json`.

**Backend** (`services/api/src/drill.ts`):
- **`GET /api/drill`** answers `{network, drill_id, deployed, block_height, ratio: {bp, set_at} | null, owner, faults_enabled, fault: {mode, delaySeconds} | null, fault_error}`.
- **`POST /api/drill/fault`** takes `{fault: "none" | "refund" | "fail" | "late", delay_seconds?}` (1 to 86,400, default 600, used for `late`) and answers `{fault}`. It is 503 `faults_off` without `SHIM_URL` and `SHIM_ADMIN_TOKEN`, and at most 10 changes a minute in all. The token goes to the stand-in's `/admin/fault` as a bearer token and is never logged or answered. The backend runs on testnet only, as before.
- **`GET /api/keeper/:account`** (new) answers `{account, log_found, keeper: {last_tick_at, running, dry_run, watches, nbtc_ratio_bp}, events}`: the keeper's lines for the account, newest first, at most 200, read from the keeper's log file on the same machine (`KEEPER_LOG_FILE`). `running` means a tick in the last minute.
- **Moves:** §14's services side.
- **Checked** read-only on 8 Nov from a second backend on port 8798, against testnet and the running stand-in: the drill at 1.0000, owned by `pbf-ops.testnet`, and the fault switch at `none`.

**Web:**
- **The Risk page** (`web/src/app/risk/risk-view.tsx`, `web/src/lib/risk.ts`) shows:
  - the latest verdict in words, with the buffer, IM and the top risks in plain words;
  - the margin-call clock, counted as the contract counts it, out of 4 hours;
  - the bands, each with today's mark or ratio beside it;
  - the stored plan, each step's status: done and its transaction for `execute_step`'s steps, and the gateway's answer and attestation for `cancel` and `perp`, from the keeper's log;
  - money in transit, with overdue transfers marked;
  - what the keeper did, with each transaction and attestation;
  - the verdict history: the verdicts the keeper saw, each linked to the keeper's check and its attestation when the keeper asked for it.

  It needs no wallet: `/risk?account=<name>`, or a name field. With a wallet it takes the wallet's account, as the other pages do.
- **The Drill panel** (`web/src/app/drill/drill-view.tsx`):
  - the ratio, the drill's owner, and a set and reset for the owner's wallet;
  - the fault switch, with the late delay;
  - the slide command, with a suggestion from a named account's bands, and the commands for the keeper, the gate and the fault runs.
- **Moves** pass the transfer arguments (§14's services side).

**Tests:** `pnpm test` at the root passes 245 tests (it had 208): the keeper 68, the backend 69, the stand-in 44, the 1Click client 11, the web 53. `tsc` builds every service, and `pnpm --filter @pb/web build` and `lint` pass.

**Deviations from §13–17:**
- The keeper runs pb-gateway over OutLayer's HTTPS API itself, not through the backend.
- The keeper runs no risk-core of its own (PLAN.md 5.7 step 2). Its state test is the band crossing.
- Beyond §17's checks: big moves, a used verdict, `cancel_risky` on first seeing an account that isn't HEALTHY, and the 5-minute WATCH checks after a plan.
- §17's slide example skips MARGIN_CALL on the small book. The tools take the slide from the bands, and `--every` defaults to 2 minutes.
- New: `GET /api/keeper/:account`, which reads the keeper's log on the same machine. The verdict history is the verdicts the keeper saw; only those it asked for link to an attestation.
- The Risk page needs no wallet, and it has no scenario table (PLAN.md 5.8): the verdict doesn't carry the scenarios.
- The stand-in also refunds with the msg, which 1Click's spec doesn't say it does.
- The keeper doesn't poll 1Click for `home` transfers: the stand-in needs the deposit's memo.

**Open:**
- **A FAILED transfer never settles.** It stays under way, then overdue, and an overdue transfer refuses borrowing for good. The contracts and risk sides may want a way to close one: an operator's call, or pb-risk listing it as lost after its deadline.
- **A refunded move home** also stays under way: the stand-in refunds on Hyperliquid, with no msg. pb-risk could match the refund as it matches `arrived`.
- **The keeper and the gate scripts share the keeper's key.** near-api-js retries a used nonce, but a keeper check that lands between a gate's withdraw check and its withdraw makes `take_out` fail (resume with `--from take_out`). A second access key for the keeper process would avoid this.
- **The fault switch** on the Drill panel is open to anyone who can load the page. That is fine locally on testnet; the hosted demo needs it closed, for example behind the operator's signature.
- **Before the gate:**
  1. deploy W1's account and factory code, and pb-risk `5a2a2a20…` and pb-gateway `6746393a…`, then pin them;
  2. restart the backend and the stand-in, which run Phase 3 code on 8788 and 8787 now;
  3. start the keeper;
  4. run `drill:demo` with a new name, after the deploys.

---

# Phase 5: the rest of the product

The Phase 5 gate (PLAN.md 11.6):
- the credit-check page works for any mainnet Hyperliquid address, with no wallet, and shows Rhea's terms next to ours;
- the backtest table is in the README;
- the hosted demo runs PLAN.md 2's walkthrough;
- every contract has been through the audit checklist.

Written on 9 Nov, before building it. Everything in this part reads mainnet and never signs or pays on it. Hosting waits for the user's yes; §22 only makes the services ready for it.

## 18. `pb-risk` in Phase 5: the `credit_check` mode

**Input** (stdin; over OutLayer's HTTPS API only, so an on-chain `request_check` can never run it):

```json
{"mode": "credit_check", "network": "mainnet",
 "hl_address": "0x<40 hex>",
 "book": null,
 "spot": [{"token": "nBTC", "amount": "<token units>"}],
 "snapshot": false}
```

- **Exactly one of `hl_address` and `book`.** `book` is a what-if Hyperliquid account, `{"usdc": "<micro-USD>", "positions": [{"coin": "BTC", "usd": "<micro-USD, negative for a short>"}]}`, with each position entered at the mark. It lets the page show the worked example (PLAN.md 6.9: $100k of nBTC, a $100k BTC short and $35k of margin) without using anyone's address.
- **`spot`:** at most 5 entries, each a NEAR-side token of `RISK_ENGINE.md` 5.4 by the pool's name (`USDC`, `nBTC`, `ETH`, `USDT`, `wNEAR`), at most once each, in the mainnet token's own units. Empty is allowed.
- **Where it runs:** the existing testnet project `pbf-keeper.testnet/pb-risk`, paid with the testnet payment key. It reads mainnet over HTTPS, and nothing is signed or paid on mainnet.

**Reads.** Take every endpoint and view name from its docs or source, check it with one live read, and record it under "As built":
- **Hyperliquid mainnet** info: `clearinghouseState`, `spotClearinghouseState` (spot USDC counts for unified accounts, as on testnet), `frontendOpenOrders` and `metaAndAssetCtxs`. Use mainnet's asset ids and margin tables, never testnet's.
- **Prices** as `RISK_ENGINE.md` 3, with Hyperliquid mainnet's oracle as one source.
- **π for nBTC and ETH** (3.3): a dry 1Click quote on mainnet, without our key, to sell one hour of the token's capacity (5.4) for USDC; capped at 1. With no quote, π is 0.80 and the token is reduce-only, as the rule says. A quote without a key carries 1Click's extra 0.25% fee, so π comes out slightly low, which is the safe side. The output says where π came from.
- **Rhea on mainnet** (`contract.main.burrow.near`, research/rhea.md): for each spot token and for USDC, its volatility ratio and whether it can be collateral; and USDC's borrow APR now.
- **Our pool's terms:** `pool.pbf.testnet`'s `get_params` and `get_pool`, because it is the only pool that exists. Mainnet's comes in Phase 6, with the user's yes.

**Computes**, as for a new account: no loan, no history and no KYB (`RISK_ENGINE.md` 6–7).
- **The engine's answer:** the Appendix A fields that make sense without an account. These are `eq`, `eq_allow`, `mm`, `im`, `score`, `tier`, `credit` (line and binding), `top`, `topup`, `venues` and `coins`, and the rating inputs `hr_bp`, `hr7_bp` and `exp_bp`.
- **Rates:** `rate_bp` at the testnet pool's utilisation now, and `rate_bp_at_60`, the same tier at 60% utilisation, the plan's reference point.
- **`limits`:** the pool's own limits for a new account: the first-week limit ($25k) and the tier's ceiling, both from `get_params`.
- **Coins outside the allow-list.** A position or resting order in one sets `credit.line` to 0 with binding `UNLISTED`, and `unlisted` names the coins. `without_unlisted` then gives `{line, binding, score, tier, rate_bp}` for the same book with those positions and their unrealised profit or loss left out, so the page can say what closing them would bring.
- **Left out, and listed in `ignored` with why:** Hyperliquid spot tokens other than USDC, isolated positions, and vault or staking balances.
- **Rhea alone** (`rhea`): what Rhea would lend against the spot alone, valued at our reference prices.
  - `max` is the sum of each token's value × its volatility ratio × USDC's volatility ratio: a health factor of 1.0, liquidated on the first move against it.
  - `safe` is `max` / 1.2, a health factor of 1.2.
  - Tokens Rhea doesn't take as collateral count 0. Rhea can't see Hyperliquid, so a book with no spot gets 0.

**Output** (stdout, under 8 KB; amounts are integer micro-USD):

```json
{"ok": true, "v": 1, "mode": "credit_check", "model": "B-0.2", "params": "<sha256 of universe_v0.json>",
 "network": "mainnet", "hl_address": "0x…", "book": null, "spot": [{"token": "nBTC", "amount": "…"}],
 "at_ms": 0, "near_blk": 0,
 "verdict": {"eq": 0, "eq_allow": 0, "mm": 0, "im": 0, "score": 700, "tier": "STANDARD",
             "rate_bp": 0, "rate_bp_at_60": 0, "credit": {"line": 0, "binding": "C4"},
             "top": [], "topup": 0, "venues": {}, "coins": {"uncertain": [], "stale": [], "reduce_only": []},
             "hr_bp": 0, "hr7_bp": 0, "exp_bp": 0},
 "limits": {"first_week": 25000000000, "ceiling": 0},
 "unlisted": [], "without_unlisted": null,
 "ignored": [{"what": "spot HYPE", "why": "…"}],
 "prices": {"BTC": 0}, "pi": {"nBTC": {"bp": 9990, "source": "1Click dry quote, no key"}},
 "rhea": {"contract": "contract.main.burrow.near", "blk": 0, "max": 0, "safe": 0, "usdc_borrow_apr_bp": 0,
          "usdc_volatility_bp": 9500,
          "tokens": [{"token": "nBTC", "value": 0, "volatility_bp": 8000, "collateral": true}]},
 "pool": {"id": "pool.pbf.testnet", "util_bp": 0},
 "in": "<sha256 of every input read>"}
```

- **Errors** are `{"ok": false, "reason": "..."}` with exit code 0, as before.
- **Snapshot:** with `"snapshot": true`, the output is `{"result": {...}, "inputs": {...}}`. Then `backtest credit <file>` recomputes the same result locally and prints the hash of its sorted form, as `backtest verdict` does (§6).

**As built (9 Nov), `pb-risk`** (reads in `pb-read/src/credit.rs`, the result in `pb-risk/src/credit.rs`). Built, not deployed: the version with §19 and §21 is `fafcff9a0ceeaea5cc1891f793fa7fdbe0437316afc91bd8c69787bd148d594b` (1,352,273 B), from the build command of §15.
- **Checked live on 9 Nov, read only.** The answers are saved in `risk/pb-read/tests/fixtures/mainnet/`.
  - **Hyperliquid mainnet,** `POST https://api.hyperliquid.xyz/info` ([info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint), and its perpetuals and spot pages):
    - `metaAndAssetCtxs`: 235 perps. BTC is asset 0, margin table 56 (40× to $150M, then 20×), oracle 75,777, mark 75,764.
    - `clearinghouseState`: `marginSummary`, `crossMarginSummary`, and positions with `leverage.type` and `marginUsed`.
    - `frontendOpenOrders` lists spot orders too (`@107`, `PURR/USDC`). `userAbstraction` is `"default"` for a fresh address.
    - `spotClearinghouseState`; `userVaultEquities` (`[{vaultAddress, equity, lockedUntilTimestamp}]`); `delegatorSummary` (`{delegated, undelegated, totalPendingWithdrawal, nPendingWithdrawals}`, in HYPE).
    - Sample: HLP's strategy vault `0x0104…703a` holds 177 cross positions, all 23 listed coins among them; account value $3,078,089.
  - **Rhea,** `contract.main.burrow.near` through `https://free.rpc.fastnear.com`. `get_version` is `0.16.2`. `get_assets({token_ids})` returns `AssetDetailedView`s ([source](https://github.com/shawn10359/burrowland/blob/7f48c2a/contracts/contract/src/asset_view.rs), `asset.rs`): `config.volatility_ratio`, `can_use_as_collateral`, `can_deposit`, `can_borrow`, and `borrow_apr` as a decimal string. At block 223,672,573: USDC 9500, nBTC 8000, `eth.bridge.near` 7500, USDT 9500, wNEAR 7500, all collateral; USDC's borrow APR 16.70%.
  - **1Click,** `POST https://1click.chaindefuser.com/v0/quote` ([quote page](https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote.md), OpenAPI 0.1.10). No key: [+0.25%](https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication.md).
    - The body: `dry: true`, `EXACT_INPUT`, slippage 100, `ORIGIN_CHAIN` deposit and refund, `DESTINATION_CHAIN` recipient, recipient and refund `aurora` (as day 1's), a deadline 10 minutes ahead. It answers HTTP 201.
    - With the User-Agent `pb-risk/0.0.1`: 6.59831 nBTC ($500k at $75,777) → 496,500.88 USDC, so π 0.993; 22.45 ETH → 49,702.10; 500,000 USDT → 499,268.81. 1,000 nBTC → HTTP 400 "No liquidity available", after 3.4 s.
  - **Decimals,** from each mainnet token's `ft_metadata`: USDC 6, nBTC 8, ETH 18, USDT 6, wNEAR 24.
  - **Our pool:** `get_pool` ($10M of capital, nothing lent) and `get_params`, whose `caps` hold `new_account_limit` ($25k) and `ceiling` per tier ($5M, $1M, $100k).
  - **The exchanges** are `check`'s endpoints (`research/day1.md`).
- **Reads, in order:**
  1. the address's six Hyperliquid views, together;
  2. our pool, at a final testnet block;
  3. Rhea, at a final mainnet block;
  4. the prices, as `check` reads them, in batches sent together (hourly candles, minute candles, Hyperliquid mainnet's market, tickers);
  5. the dry quotes, sized at the reference price the result uses: an hour of capacity (nBTC $500k, ETH $50k, USDT $500k).
- **Computes** the book as `check` does (`pb_read::book`), for an account the pool doesn't know: hedge points only, and Standard at best.
- **Differs from the text above:**
  - **USDT's π** is a dry quote too. RISK_ENGINE.md 3.3 asks for the median of Binance, Kraken and a quote.
  - **No coin statuses:** the testnet pool's list reflects testnet's gaps. A coin Hyperliquid mainnet has delisted, or lists isolated-only, is reduce-only.
  - **Rhea's `collateral`** needs `can_use_as_collateral` and `can_deposit`, and `max` needs USDC to be borrowable. Tokens are valued as the engine values them: a wrapper at P × π.
  - **Isolated positions** are left out with their margin: a standard account counts `crossMarginSummary.accountValue`, a unified one its spot USDC less isolated margin.
  - **`ignored`** also lists a standard account's spot USDC and any spot orders. It has at most 10 lines.
  - **Added fields:** `verdict.volf_bp`; `unlisted_more` (left out when 0; `unlisted` names at most 40); `rhea.error` (left out when Rhea was read).
- **Limits:** a check prices at most 6 coins, BTC included; past that it refuses and says how many it found. The reads start nothing new after 13 s.
- **On chain:** with `OUTLAYER_EXECUTION_TYPE` `NEAR` it answers `mode credit_check runs over OutLayer's HTTPS API only`.
- **Overlapped requests, new and not yet run on OutLayer.** The WASI transport sends up to 8 requests before waiting for the first (`get_all`, `post_all`). `check` and `preview` don't use them. A request that fails other than by timing out is sent again on its own. If OutLayer runs them one at a time, a check of more than about 3 coins runs out of read time, and its later coins come back uncertain (binding `PRICE`).
- **Measured** (live reads from the build machine, and the decide step natively; not on OutLayer yet):
  - **The worked example** (a book and nBTC): 19 calls. 6.9 s one at a time, 4.0 s overlapped. The decide step takes 0.02 s natively; a `check` of the hedged book takes 0.05 s natively and 169M–556M instructions on OutLayer.
  - **An address with 6 coins:** 85 calls. 21.9 s one at a time, past the 20 s; 7.0 s overlapped.
  - The result is about 1.4 KB.
- **Tests:** `pb-risk/tests/credit.rs` (12), on a pretend mainnet made of the fixtures, with every source quoting one price: the worked example's $94,500 at π 1 (`C4`), Rhea alone $76,000 and $63,333, an unlisted coin, no spot, π from quotes, refusals, and the snapshot to the byte. `backtest credit pb-risk/tests/fixtures/credit_worked.json` prints output hash `32b6c03baa046ad2c4a9719d89b6491415cc5482cf7826ff68ec428f188a5c37`.

## 19. The book stress test (`RISK_ENGINE.md` 12.1, last row)

**`pb-risk` mode `book`** (HTTPS only).
- **Input:** `{"mode": "book", "network": "testnet"}`.
- **Reads:**
  - the factory's `list_accounts`, keeping the accounts with a loan (`pool.debt_of` > 0);
  - each of those accounts, as `check` reads it, with the prices read once and shared.
- **Computes:** every account's scenarios run together. The unwind costs use the book's total size per coin, because our clients would be selling together. It reports the pool's total loss per scenario.
- **Limits:** version 0 reads at most 10 accounts with loans. Past that, it answers `{"ok": false, "reason": "..."}`, naming the limit.

**Output:**

```json
{"ok": true, "v": 1, "mode": "book", "blk": 0, "capital": 0, "loans": 0,
 "accounts": [{"acct": "…", "debt": 0, "eq": 0}],
 "worst": {"scenario": "…", "pool_loss": 0}, "limit": 0, "pass": true,
 "top": [{"scenario": "…", "pool_loss": 0}], "in": "…"}
```

- `limit` is 2.5% of pool capital, and `pass` says whether the worst extreme-day loss stays within it.
- `top` lists the five worst scenarios.
- With no account holding a loan, `pass` is true and `worst` is null.

**Who uses it:**
- **The keeper** runs it once a day, and once at start when the last result is more than a day old. It appends each result, with its attestation link, to `logs/book-stress.jsonl`.
- **The backend** answers `GET /api/book-stress` with the latest result.
- **The Book page** shows a "Book stress test" card: when it ran, the accounts, the worst scenario's pool loss against the 2.5% limit, pass or fail, and the attestation link.

**As built (9 Nov)** (the math in `risk-core/src/book.rs`, reads in `pb-read/src/stress.rs`, the result in `pb-risk/src/stress.rs`). Built, not deployed: in the §18 version.
- **One list of days for the whole book:** 4.5's list for the book as one account, with each coin's shock sized for the book's gross holding (4.2). Where accounts hold both sides of a coin, its ADL and squeeze days come for each side, named `… (longs)` or `… (shorts)`, and an ADL day closes only the side it targets.
- **Each account plays each day out alone:** its own Hyperliquid liquidation and its own π, but the cost rate of the whole book's sale of that coin on that venue. Its shortfall is what it would still owe, with the week's interest, after selling everything at its worst point. The pool's loss is the sum, not weighted.
- **For one account,** the list and each day's result are the engine's own, bit for bit (a test).
- **Reads,** all at one final block: the factory's `list_accounts` (one page of 100) and `accounts_count`; the pool's `get_pool`, `get_params` and `coin_statuses`; `get_borrower` for each listed account, whose `debt` is `debt_of`'s; then, for each account with a loan, `get_state`, `get_config`, `get_ratio_for` (§21), its balances and its Hyperliquid account; and the prices once, for every coin held. Requests that don't depend on each other go out together, as in §18.
- **Differs from the text above:**
  - **`pass`** compares the worst day of every family with the limit, as the Book page shows it. 12.1 names extreme days; the other days should cost the pool nothing anyway, so this is the stricter reading.
  - **`worst`** is also null when no day costs the pool anything. `top` lists only days that cost something. `pool_loss` rounds up.
  - **Added:** `days`, how many days were played out; and `"snapshot": true`, which answers `{"result", "inputs"}` as §18 does.
  - **It refuses** past 100 listed accounts, and when its reads pass 14 s (`out of time after reading N accounts with loans`), rather than leave accounts out.
- **Does 10 fit in OutLayer's 20 s?** Only with overlapped requests. Ten hedged accounts make 119 calls: 19, then 10 for each account, with one coin.
  - Replayed live from the build machine: 33.6 s one at a time, 7.1 s 8 at a time. At OutLayer's 230 ms a call (§6), one at a time is about 27 s.
  - Testnet now (6 accounts, none with a loan): 12 calls, 4.3 s one at a time, 1.1 s overlapped.
  - The decide step for ten accounts takes 0.023 s natively, far inside 2B instructions.
  - So if OutLayer turns out to run the requests one at a time, about 4 accounts fit in the 14 s of reads, and the limit should come down to that.
- **Tests:** `risk-core` `book::tests` (4) and `pb-risk/tests/book.rs` (6): one account as `check` values it, two accounts selling together losing more than twice one alone, the limit of 10, the old drill read once, the snapshot.

## 20. The backtest with rebalancing delays (PLAN.md 6.9, step 9)

`cargo run -p backtest --release -- crash [--delays 2,15,60] [--json <file>]`

**Books and windows:**
- **Books:** 13.1's hedged book (full size) and 13.4's directional book. Each has drawn its full Standard line at the window's first minute.
- **Windows:** the ten replay windows of `replays_v0.json`, minute by minute, in time order.

**Each minute, the engine and the keeper act as they would live:**
- **Checks:** one a minute.
- **Deleveraging:** a DELEVERAGE plan runs after the second check, 3 minutes later, if it still agrees.
- **Hyperliquid trades** fill in the same minute, at that minute's price, with the engine's unwind costs.
- **Money moved between NEAR and Hyperliquid** arrives after the delay of 2, 15 or 60 minutes. That covers REBALANCE and REBALANCE_NOW, and plan steps `to_hl`, `home` and `sell` through 1Click.
- **Liquidations:** Hyperliquid liquidates in the minute its replica says (`RISK_ENGINE.md` 4.3).

**Reported for each book, window and delay:**
- the lowest equity, the minute it happened, and its ratio to IM and to the debt;
- the states reached;
- Hyperliquid liquidations, with their count and minute;
- the plan steps run;
- the pool's loss, max(0, debt − equity): at the window's end, and the worst during it.

**Output:**
- **The README table:** for each book and delay, the worst over the ten windows.
- **Every case** goes to `research/data/backtest_v0.json`.
- **Same inputs, same table.**

**If any case loses the pool money, report it as found.** Don't change the engine's parameters to make it pass: that is the user's call (PLAN.md 12, decision 2).

**As built (9 Nov), the backtest** (`risk-core/src/sim.rs`, `backtest/src/crash.rs`):
- **Run it** from `risk/`: `cargo run -p backtest --release -- crash --delays 2,15,60 --json ../research/data/backtest_v0.json`. 90 cases take about 15 s on 8 cores (about 70 s on one). It prints the README table, then every case that liquidated or cost the pool money. `--cosign` has the operator co-sign every plan step at once.
- **Books.** 13.4 gives its book two margins, so both run: three books. Lines: 13.1 hedged $94,500 (C4); 13.4 with $80k of margin $79,015 (C1); with $200k, $140,620 (C3). Each is drawn at the window's start on section 13's market, and the money leaves the account.
- **How it steps** (`risk_core::sim`). The market is the engine's own replay path, with its perp gap and normal depeg. Left alone, the account matches the engine's replay scenario at every minute of all ten windows (tested). Each minute: a minute of carry; Hyperliquid's replica; money due lands; the check (with the margin-call clock and hysteresis); the keeper's steps; the replica again.
- **Readings where the specs are open** (all in the file's `assumptions`):
  - Hyperliquid sees each minute's price before we act. Money due that minute lands after its check.
  - DELEVERAGE is confirmed by the check 3 minutes after the first (the contract would take 2), or at once from an 80% margin ratio.
  - Perp steps fill at the minute's mark. Every trade pays 4.6's cost at the size traded so far in the window (a marginal cost), so splitting never makes it cheaper.
  - A 1Click sale is priced at its quote when the step runs. Nothing is refunded or late beyond the delay.
  - The pool's $50k-a-day limit on plan steps applies, and no co-signature comes during the window.
  - Pool loss is max(0, debt − the account closed out that minute), with Hyperliquid floored at 0 and money in flight at 98%.
- **What differs from live:** a check every minute (live: on bands, and every 5 minutes in a margin call); the volatility factor stays 1, because the file has no 720 hours before each window; TWAP = price; no size rounding or $10 minimum; the client does nothing.
- **Found** (`research/data/backtest_v0.json`):
  - **No case cost the pool anything.** The lowest equity was 0.26 of the debt (hedged, 60 min).
  - **One liquidation, the same at every delay.** The hedged book's short is backstopped at minute 23 of the 13 Mar 2020 rebound (window from 02:16 UTC). The REBALANCE came at minute 22, at BTC +30% (the projected-breach test). With no USDC on NEAR it was a pair: a quarter of the short bought back, and $31.9k of nBTC sold. That USDC lands on NEAR and needs a second transfer to reach Hyperliquid, so no delay could have saved the hedge. 13.1's own fix is margin at 2× ($50k). So far the backtest gives no evidence for counting replays at less than full weight (PLAN.md 12, decision 2).
  - **Fixed later on 9 Nov: a REBALANCE now counts USDC already on its way to Hyperliquid.** The first run found `rebalance_need` reading only Hyperliquid's balance, so with 15 or 60 minutes each check asked again. The $80k directional book sent up to $48k where 2 minutes moved $11–19k. Its MR is about its Hyperliquid equity (13.4), so in the 2020 fall at 15 minutes the extra margin pushed it into DELEVERAGE at minute 231. The fix:
    - The engine's `InFlight` has a direction, `to_hl`. It is false when missing and written only when true, so old snapshots and the 559 cases read and print as before. pb-read sets it from the transfer's kind: `to_hl` → true; `home` and `sell` → false.
    - `rebalance_need` takes off 98% of the USDC on its way to Hyperliquid that isn't overdue, never below 0, as the state counts money in flight (T20). Once a transfer is overdue it counts as nothing, so the next check after its deadline sends again. The trigger is unchanged: a REBALANCE whose money is already coming plans no new move.
    - Now the $80k directional book sends $11–13k at every delay. Its worst state at 15 and 60 minutes is WATCH (was DELEVERAGE and MARGIN_CALL), and its refused steps fell from 16 and 47 to 0 and 6 (the 8-transfer limit, late in the 2020 fall at 60 minutes). The hedged book's moves in the 2021 rebound fell the same way ($16.2k to $5.1k at 15 minutes). Money in flight counts at 98%, so the next check can still top up the last 2% (one $15 move). Liquidations and pool losses are unchanged.
    - pb-risk rebuilt with `RUSTFLAGS="--remap-path-prefix=$HOME=~" cargo build -p pb-risk --target wasm32-wasip2 --release`: sha256 `4e44327ef90b0716edb91b0785c0bc1941b71c741da4f88e08f0068f39f94b0e` (1,352,493 B), the same after a clean rebuild. Not deployed.
  - **The $80k directional book starts exactly at IM** (C1 binds), so the replay's 0.3% perp gap alone puts it in WATCH at minute 0.
  - **The $50k co-signature limit** refused most of the hedged book's nBTC sales after the backstop (7 at 15 min, 31 at 60 min). Its nBTC stayed unhedged, but BTC stayed above the start, so the pool lost nothing. With `--cosign` only the hedged rows change: more steps run, and the lowest equity is about $1.2k lower at 15 and 60 min (more sold, counted at 98% in flight, with costs).
- **Left:** a volatility factor that rises during a crash; putting the table in the README.

## 21. Per-account drill ratios (testnet only)

So that one person's drill can't shock every account on a shared demo:

**Drill contract:**
- It keeps `set_ratio` and `get_ratio` for the shared ratio.
- **New:**
  - `set_ratio_for({account_id, bp})` and `clear_ratio_for({account_id})`, owner only, with the same rule as `set_ratio` (at most 10,000 bp);
  - `get_ratio_for({account_id}) -> Ratio`: the account's own ratio if it has one, otherwise the shared one.
- `migrate()`, owner only, carries over the deployed state.

**Who reads and sets it:**
- **`pb-risk`** reads `get_ratio_for({account_id: <account>})` for π on testnet. If the method isn't there (the old code), it falls back to `get_ratio`.
- **The keeper's scripts:** the drill sets its own account's ratio, and `clear_ratio_for` resets it.
- **The backend, for hosting:** `POST /api/drill/ratio` `{account, bp, auth}`.
  - `auth` is a NEP-413 signature by the account's owner, as the gateway checks (§9).
  - It sets that account's ratio with a function-call key of `pbf-ops.testnet` that may call only `set_ratio_for` and `clear_ratio_for` on the drill contract (`DRILL_SIGNER_ACCOUNT_ID`, `DRILL_SIGNER_PRIVATE_KEY`).
  - So no full-access key of ours sits on a hosted server.

**As built (9 Nov), the contract** (`contracts/testnet/drill`). Not deployed yet.
- **Methods** as above. Also:
  - `clear_ratio_for` returns whether the account had a ratio of its own;
  - each change logs a line, such as `nBTC/BTC ratio for drill1.pbf.testnet set to 7500 bp`;
  - refusals read `only the owner can set the ratio` and `the ratio is at most 10,000 bp (1.0)`, as `set_ratio`'s do.
- **No 1 yoctoNEAR** on `set_ratio_for` or `clear_ratio_for`: a function-call key can't attach one (research/audit.md, A3).
- **`migrate()`** keeps the owner and the shared ratio, and starts with no per-account ratios. It refuses a state
  already migrated.
  - **Differs:** the drill account itself may call it too, not only the owner, so it can be the deploy's init call.
    Whoever holds the drill account's key can replace its code anyway.
- **Deploying it:**
  1. **Top up first.** The new wasm is 114,484 bytes (was 93,433), sha256
     `61b1e9a79483d95b19da8a11bd6a63416f23d3acf0a7c354206ecf2cd5416636`. It needs about 1.15 NEAR of storage, and
     `drill.pbf-ops.testnet` holds 0.998 NEAR (9 Nov). Send it 0.3 NEAR.
  2. **Deploy** with the init call `migrate({})`, signed by `drill.pbf-ops.testnet`. Or deploy, then call `migrate` as
     `pbf-ops.testnet`; until then, the views can't read the state.
- **Storage:** each account with its own ratio adds about 100 bytes, 0.001 NEAR, paid from the drill's balance.
- **Tests:**
  - 13 unit tests, one on the state read from testnet;
  - `tests/tests/upgrade.rs`, two sandbox tests: they put the live code and state under `drill.pbf-ops.testnet` and
    upgrade it, both ways. `python3 -I contracts/tests/fetch_live.py` fetches the live files, read-only.
- **Left for the other parts:** `pb-risk`'s read of `get_ratio_for` with its fallback; the keeper's scripts; the
  backend's `POST /api/drill/ratio`; and the function-call key, which the user makes.

**As built (9 Nov), `pb-risk`'s read** (`drill_ratio` in `pb-read/src/read.rs`, so pb-gateway reads the same):
- It asks `get_ratio_for({account_id: <account>})`. If the drill answers `MethodNotFound`, it asks `get_ratio`. The deployed drill answers `wasm execution failed with error: MethodResolveError(MethodNotFound)` (read 9 Nov).
- Any other failure leaves π unread, as before: 0.80, and nBTC reduce-only.
- The answer goes in the inputs' `near.drill` as before, so older snapshots replay unchanged. A run makes 1 NEAR call for it with the new drill, 2 with the old.
- The book stress test (§19) asks the old drill's `get_ratio` once for all its accounts.
- Tests: `pipeline.rs`, `the_drill_ratio_is_the_accounts_own_with_a_fallback_for_the_old_drill`.

## 22. Backend and web in Phase 5

**Backend:**

| Endpoint | What |
|---|---|
| `POST /api/credit-check` | Body `{hl_address?, book?, spot?}`. It runs §18 over OutLayer's HTTPS API, with the `pb-risk` version the factory pins (`get_config`). It checks the input first. At most 6 runs a minute in all and 2 per client address; identical inputs share one result for 60 s. The answer is `{result, run: {call_id, attestation_url, time_ms, compute_cost}}` |
| `GET /api/rhea` | Rhea's terms now, for the Borrow page: the volatility ratios and USDC's borrow APR, read from mainnet RPC with §18's view names, kept for 5 minutes |
| `GET /api/activity/:account` | The account's history: deposits, loans, repayments, transfers to and from Hyperliquid, plan steps and withdrawals, each with its transaction hash, newest first. It comes from a testnet indexer whose API is in its docs (nearblocks or FastNEAR), checked live. If none works without a key, it comes from the account's and the pool's own records plus the keeper's log. Kept for 30 s |
| `GET /api/book-stress` | §19's latest result |

**Web:**
- **Credit check** (`/credit-check`, no wallet):
  - a Hyperliquid address field;
  - or a "worked example" button, which fills `book` with $35k of USDC and a $100k BTC short, and `spot` with $100k of nBTC at today's price;
  - optional spot rows (token, amount).

  It shows, side by side:
  - our line, tier, score and rate (now, and at 60% utilisation), and what sets the line, in words;
  - Rhea's safe and max amounts, and its USDC rate now;
  - the top risks in words;
  - unlisted and ignored items, with why;
  - the first-week $25k limit;
  - the prices and π used;
  - the attestation link, and how to check the result yourself.

  It must work at a phone's width.
- **Activity** (`/activity`): the history above for the signed-in account, newest first, with nearblocks links. Like Risk, any account can be looked at. The withdraw form appears here too, and stays on Account.
- **Book:** the stress-test card (§19).
- **Borrow:** "Compared with Rhea alone" uses `/api/rhea`'s terms when it answers, and the 3 Nov figures otherwise, and says which.

**Ready for hosting** (nothing is hosted until the user says yes):
- **One switch, `HOSTED=1`,** for the backend and the web app:
  - the Drill panel hides the fault switch, and `POST /api/drill/fault` answers 403;
  - the Book page hides the operator's controls;
  - the drill ratio can be set only per account, through `/api/drill/ratio`.
- **Every service starts from env vars alone,** and `pnpm build` and `next build` pass.
- **Host-specific files** wait for the user's choice of host.

**As built (9 Nov)** (`services/api`, `services/keeper`, `web`). The hosting part above was not built: no `HOSTED` switch, no `POST /api/drill/ratio`, no drill signer (the main session's call, 9 Nov). Nothing is deployed, signed or sent; pb-risk's §18–19 modes are tested against fakes of their output shapes.
- **Checked live on 9 Nov, read only:**
  - **Rhea:** `contract.main.burrow.near.get_assets({token_ids})` through `https://free.rpc.fastnear.com`. The view and its fields are burrowland's (`github.com/ref-finance/burrowland`, `contracts/contract/src/asset.rs`, `asset_view.rs`, `asset_config.rs`): `config.volatility_ratio`, `can_use_as_collateral`, `can_deposit`, `can_borrow`, and `borrow_apr` as a decimal string, a fraction a year. At block 223,671,598: USDC 9500, nBTC 8000, ETH 7500, USDT 9500, wNEAR 7500, all collateral; USDC's borrow APR 16.70% (15.88% at 223,738,912). Decimals from each token's `ft_metadata`: USDC 6, nBTC 8, ETH 18, USDT 6, wNEAR 24.
  - **The indexer: FastNEAR's transactions API,** `https://tx.test.fastnear.com` ([docs](https://docs.fastnear.com/tx): [`POST /v0/account`](https://docs.fastnear.com/tx/account) `{account_id, desc, limit ≤ 200}` → `account_txs`, `txs_count`, `resume_token`; [`POST /v0/transactions`](https://docs.fastnear.com/tx/transactions) `{tx_hashes ≤ 20}` → each transaction with every receipt, its logs and status). It answered without a key. The docs ([auth](https://docs.fastnear.com/auth)) say to send a key, and give no limit for calls without one; `FASTNEAR_API_KEY`, if set, goes as a bearer token.
  - **NearBlocks** also answers without a key, but only v3 now: `GET https://api-testnet.nearblocks.io/v1/...` answers 410 ("API v1 was retired on 2026-11-05"); `/v3/accounts/{account}/txns`, `/receipts` and `/ft-txns` answered 200 (OpenAPI at `/openapi.json`; each 25 rows count against a rate limit it doesn't state for keyless use). Its list rows carry method names but not logs, so FastNEAR was chosen. Explorer links still go to `testnet.nearblocks.io`.
  - **Hyperliquid mainnet** `info` `metaAndAssetCtxs`: BTC's `oraclePx` (75,711.6), for the worked example.
  - **`view_access_key`** and the drill's missing `get_ratio_for` (near-api-js 7.4.0 throws `ContractMethodNotFoundError`, "Contract method is not found at block height …").
- **`POST /api/credit-check`** (`credit.ts`). The answer is `{input, result, run, program, output_sha256, attestation, computed_at_ms, cached, age_s}`.
  - **The input** is checked and put in one order (positions by coin, spot in the pool's token order), so a reordered question shares the answer. `book.usdc` and each `usd` are micro-USD strings, at most $1B; at most 25 positions; coin names `[A-Za-z0-9]{1,16}`.
  - **The program** is the factory's `get_config().risk`, which must be our `pbf-keeper.testnet/pb-risk` (409 `bad_config` otherwise; 503 `not_deployed` without a factory). pb-risk's own refusals are answers, with HTTP 200, as in previews.
  - **Limits:** 6 new runs a minute in all and 2 per client address; a shared answer costs no limit. The client address is the socket's, or, for a request from this machine (the web app's proxy), the first `X-Forwarded-For` entry. A caller can write that header, so the per-client limit is a fair share only; the 6 a minute always holds. 429 `too_many_for_you` or `too_many_credit_checks`; 503 `credit_off` without the payment key.
  - **`output_sha256`** is the SHA-256 of the output in sorted form, read from OutLayer's own answer text with every number kept as written (`canonical.ts`). A parsed copy prints `82310.0` as `82310` and misses. Checked against the Phase 2 snapshot, whose sorted form hashes to its attested `a2b074b4…c74a`.
  - **`attestation`:** the backend reads the run's record (`/attestations/by-call/<id>`, OutLayer's host only) and compares its `wasm_hash` with the pinned version and its `output_hash` with `output_sha256`. Not yet seen on a real `credit_check` run.
  - **`GET /api/credit-check/example`** (new): the worked example as a body, `{book, spot, btc_usd, price_source, read_at_ms}`: $35k of USDC, a $100k BTC short, and $100k of nBTC at Hyperliquid mainnet's BTC oracle price, kept a minute.
- **`GET /api/rhea`** (`rhea.ts`): `{contract, view, rpc, block_height, read_at_ms, age_s, stale, usdc: {volatility_bp, borrow_apr_bp, supply_apr_bp}, tokens: [{token, token_id, listed, volatility_bp, collateral, can_borrow, borrow_apr_bp, supply_apr_bp, ltv_bp}]}`. `ltv_bp` is the token's ratio × USDC's (nBTC 7600). `collateral` needs `can_deposit` too, as pb-risk counts it. Kept 5 minutes; when mainnet fails it answers the last terms with `stale: true`, or 502 `rhea_unreachable`.
- **`GET /api/activity/:account`** (`activity.ts`): `{account, read_at_ms, indexer: {host, docs}, total, listed, detailed, more, keeper_log, items, cached}`, newest first.
  - It lists up to 200 transactions and reads the newest 100 in full, 20 at a time. A transaction older than two minutes is kept once read. Each account is read at most every 30 s, and at most 30 reads a minute in all (past that, the last answer, `stale`).
  - **An item** is `{at_ms, block, tx, ok, kind, by, moves, detail, source}`. `kind` is `create`, `deposit`, `borrow`, `repay`, `to_hl`, `home`, `arrived`, `refund`, `plan`, `plan_step`, `withdraw`, `setup`, `check`, `kyb` or `other`. `moves` are the account's net token moves, from each token's own NEP-141 `ft_transfer` events; `borrow` and `repay` take the pool's `pb-pool` events, `plan`, `plan_step` and `arrived` the account's (`plan_stored`, `step_run`, `transfer_done`). An event counts only from its own contract. Transfer ids come from the account's `transfer move:N under way` log.
  - **Plan steps the gateway placed** come from the keeper's log (`gateway`, mode `deleverage`, `placed`), with the run's attestation and no transaction.
  - Read for `drill1.pbf.testnet`: its 23 transactions, from `create_account` to the last withdrawal, plus the gateway's buy-back.
- **`GET /api/book-stress`** (`book-stress.ts`): `{log_found, latest, last_result, history}` from `BOOK_STRESS_LOG_FILE`, each line `{t, ok, result, error, call_id, attestation_url, time_ms, compute_cost, program}`.
- **`GET /api/drill?account=<id>`** also answers `account_ratio: {account, per_account, ratio, shared}`: the ratio pb-risk reads for the account. The Risk page shows it.
- **The keeper:**
  - **Book stress** (`book-stress.ts`): `{"mode":"book","network":"testnet"}` with the factory's pinned pb-risk, at start when the last result is more than a day old, then daily. A failed run is tried again after 15 minutes, a refusal after an hour, and a newly pinned version runs at once (the pin is read every 10 minutes). Each attempt is a line in `BOOK_STRESS_LOG_FILE` (default `services/keeper/logs/book-stress.jsonl`), and a `book_stress` line in the keeper's log. A dry run says what it would run. A live dry run on 9 Nov found pin `5a2a2a20…`, which has no `book` mode yet.
  - **Per-account π:** each tick, for an account with a loan, the keeper compares the bands with `get_ratio_for({account_id})`; while the drill has no such method it uses the shared ratio, and asks again after 10 minutes. The account's log line carries `nbtc_ratio_bp` when it has its own.
  - **Drill scripts** (`drill-kit.ts`): `DrillContract.setFor`, `clearFor`, `ratioFor` and `perAccount`. Without `get_ratio_for` they fall back to the shared `set_ratio` and say it moves every account. `drill -- --account <name>` acts on that account (`--reset` clears its ratio); without `--account`, the shared ratio as before. `drill:demo` slides and resets its own account's ratio, and records whether each change went to the shared one.
- **The web:**
  - **Credit check:** the address field (or `?address=`), the worked example button, up to 5 spot rows in each mainnet token's units. Ours and Rhea's side by side, then warnings, the top risks, what was left out and why, prices and π, and "Check it yourself": the attestation link, the version, the output hash and what the backend found in the attestation, and `backtest credit`. No overflow at 375 px.
  - **Activity:** no wallet needed (`?account=`), like Risk; with one, the wallet's account and the withdraw form (now `components/withdraw-form.tsx`, shared with Account). Money moves by default; checks and setup steps on request.
  - **Book:** the stress card: pass or fail, when, the accounts, the worst day's pool loss against the 2.5% limit, the worst days, the attestation.
  - **Borrow:** Rhea's live terms with a "Live" badge, or the 3 Nov figures with a "3 Nov figures" badge, and where they came from.
  - **Pages:** Activity needs no wallet now; summaries updated.
- **New env vars** (`.env.example`): `MAINNET_NEAR_RPC_URL`, `HL_MAINNET_API_URL`, `FASTNEAR_TX_URL`, `FASTNEAR_API_KEY` (optional), `BOOK_STRESS_LOG_FILE`.
- **Tests:** `pnpm test` at the root passes 280 (it had 245): the backend 90, the keeper 74, the web 61, the stand-in 44, the 1Click client 11. `pnpm -r build`, `pnpm --filter @pb/web build` and `lint` pass.
- **Differs from the text above:** `GET /api/credit-check/example` and `GET /api/drill?account=` are new; the credit-check answer carries more than `{result, run}`; the activity source is FastNEAR, not the account's records.

**As built (9 Nov, the web redesign; PLAN.md 11.6.1):** no endpoint or contract changed. The web app does three new
things with the existing ones.
- **Check, then act:** `request_check`, then the polled `GET /api/account/:id` until a verdict for the same intent is
  stored with a later `received_block`, then the action. It sends the action at once, within the verdict's 120 blocks.
- **Test collateral on testnet:** two `mint` calls straight into the client account, in one wallet approval when the
  wallet signs batches. The account's balances come from `ft_balance_of`, so minted tokens count as collateral like
  deposits.
- **"Set up the demo for me":** runs the existing calls in order. Those are `hl_init`, `POST /api/quote` with a
  `to_hl` move and the account's `withdraw`, `request_agent`, then `hl_approve_agent` with `POST /api/hl/submit`.
  Last comes an IOC short through `POST /api/order`, sized to the nBTC held, at half the price band below the
  reference.

## 23. Contract audit

- **Scope:** every contract we deploy: the factory, the account, the pool, the shared types, the testnet drill and the test tokens.
- **The checklist:** the `near-contract-audit` skill's (in `.claude/skills/near-contract-audit`), plus PLAN.md 5.1's list.
- **Each finding** goes in `research/audit.md`: its severity, where it is, the fix or why not, and the test that proves the fix.
- **Upgrades:** fixes must keep the deployed state readable. A stored layout changes only with a `migrate` and a sandbox test that upgrades from the deployed code.
- **Nothing is deployed by the audit.** The main session deploys after review.

**As built (9 Nov):** `research/audit.md`, with a "what was checked" list per contract. Nothing is deployed yet.
- **Findings:** one High (A1, fixed), one Medium (A2, fixed), two Low (A3, A4, open), and Info notes. No Critical.
- **A1, fixed in the account.** A verdict read while a loan or a withdrawal was on its way could still back an action
  after the money moved. The worst case lets a new loan straight out again.
  - **The fix:** the counter now moves on twice for a borrow, a withdrawal, and a `sell` or `to_hl` step: as it starts,
    and again once the money has moved (`on_borrowed`, `on_sent`).
  - **`on_sent` now ends every withdrawal,** with `{"id": null}` when no 1Click transfer is recorded. A withdrawal
    burns about 1.7 TGas more.
  - **This changes §4 and §14,** where the counter moved on once.
  - **Nothing else needs to change:** the keeper, the backend and the web app compare a verdict's `nonce` with the
    counter and ask again when it has moved.
- **A2, fixed in the account.**
  - **Two checks:** a DEFAULT is confirmed only by two DEFAULT verdicts 2 to 5 minutes apart, the DELEVERAGE rule
    (`Deleverage::confirm`), never at once. One alone changes nothing.
  - **A way out:** `lift_block()` lifts the block once the pool says `blocked: false` and no debt (§14).
  - **Repaying:** it keeps working, but a write-off leaves the pool owed nothing, so it sends a repayment back.
  - **Changes elsewhere:**
    - The account's state gains DEFAULT's record, and `get_state()` gains `"default": {"first_at"}`. New accounts
      only: client accounts never take new code, so this needs no `migrate`.
    - The keeper should make the second check (§14).
- **What to redeploy:**
  - **The factory**, which carries the account code. Its stored layout is the same, so deploy it with no init call.
    Its wasm is 557,904 bytes, sha256 `2064eae1b81bb641db59ff490bc8b1881194507e26becd4480e618c0413845fa`. The account
    code inside is 363,288 bytes, `496b93521b9b3489c369961c0f6eae36162a69e4073239139689f9d0815a4e06`.
  - **Storage:** `pbf.testnet` keeps about 0.44 NEAR spare. A new client account locks about 3.64 NEAR of the 3.9755 a
    4 NEAR `create_account` leaves it, so about 0.33 NEAR stays free.
  - **The drill**, with `migrate` (§21).
  - The pool, the types and the tokens are unchanged.
- **What it doesn't reach:**
  - Client accounts made before keep their code: they hold no keys, so nothing can replace it.
  - Each account also pins its `pb-risk` version. So for old accounts, A1 and A2 stay open.
  - On testnet, make fresh accounts for the demo (A6).
- **Open, your call:**
  - **Recoveries after a write-off:** to count a repayment then, the pool must record each account's write-off. That
    needs a pool `migrate`.
  - **A3:** admin methods take no 1 yoctoNEAR. Add it together with the web app's operator calls.
  - **A4:** anyone's check replaces the owner's verdict.
  - **A6:** a pool switch to stop lending to old accounts. This needs a pool `migrate`.
- **Upgrade tests** (`contracts/tests/tests/upgrade.rs`) run on the code and state read from testnet on 9 Nov,
  fetched with `contracts/tests/fetch_live.py`:
  - the drill upgrades with `migrate`, both ways;
  - the factory takes the new account code with no migration, and its views and `set_paused` work as before;
  - the upgraded factory, on its live state, makes a working account with the new code, which the live pool and
    tokens register;
  - an old account's state needs its own code: the new account code refuses it, because the layout gained DEFAULT's
    record. The old code still reads it.

## Phase 5: live on testnet (9 Nov, main session)

- **Deployed:**
  - drill `61b1e9a7…` with `migrate` (tx `EoqWC5BY…`), after a 0.3 NEAR storage top-up;
  - factory `2064eae1…`, carrying account code `496b9352…` (tx `G1vgfCwz…`, no init call). The old factory code is saved in `contracts/target/live/factory.wasm`;
  - `pb-risk` `4e44327e…`, added to the project without activating it, and pinned in the factory's config (tx `9X1HGdv9…`).
  - The pool (`f9c3b708…`) and `pb-gateway` (`6746393a…`) are unchanged.
- **The FastFS upload was checked before pinning:** HTTP 200, 1,352,493 bytes, the right sha256.
- **Live runs over HTTPS** (`research/data/phase5_live_runs.json`):
  - **the worked example:** 4.6 s, $0.0012. Our line is $94,172 (C4, Standard 700, 2.00% now and 6.50% at 60%); Rhea's is $63,089 safe and $75,707 max, at 16.00%. π for nBTC was 0.9961. `backtest credit ../research/data/phase5_credit_snapshot.json` prints the attested `output_hash` `6179ca70…`;
  - **a real three-coin mainnet address** (BTC, ETH, HYPE): 4.7 s. Equity $90,126, Watch 550, a line of $35,083 (C1); Rhea $0;
  - **`book`:** 2.9 s, with no loans out: `pass`, `worst` null.
- **Overlapped requests run in parallel on OutLayer.** A three-coin check reads about 50 times in 4.7 s, where one at a time would take about 11 s. So the 6-coin limit of §18 could rise.
- **The web app, live:**
  - **the credit-check page** ran the worked example ($94,170.84 against $63,065.03) and reported "the wasm hash matches and the output hash matches";
  - **the Book page** shows the keeper's stress test (pass, no loans);
  - **Activity** lists `quiethare-hedge.pbf.testnet`'s 12 money moves;
  - **`/api/rhea`** reads Rhea's mainnet terms.
- **Not yet tried live:** a new account from the new factory. Each needs about 4 test NEAR, and the keeper holds 3. The sandbox upgrade test makes one from the live state.

# Phase 6: funding from lenders (FUNDING.md)

Written on 10 Nov, before building it. FUNDING.md says what and why; this part fixes the shapes the parts share.
Where the two differ, this part wins, and the differences are listed in §24.

**Stage 1 ("the brain") builds and tests code only.** Nothing is deployed, signed, sent or downloaded, and no
contract on testnet changes. Each part's stage 1 scope is marked **[1]**. The rest is the shape later stages build to.

## 24. Names, settings and what differs from FUNDING.md

- **Lender names:** `"aave"` and `"rhea"`, always in that order in lists.
- **Amounts:** micro-USD integers for USDC, as everywhere. Token amounts are strings of the token's own units. Rates
  and health factors are in bp (`15000` is a cushion of 1.5; `533` is 5.33% a year).
- **Shared contract types [1, done]** (`contracts/types/src/lib.rs`): `Lenders`, `RheaLender`, `AaveLender`,
  `EvmToken`, `Permission`, `Moves`, `LenderReport`, and `Config.lenders` (left out of the JSON, it is none).
- **Config JSON** (`get_config().lenders`):

```json
{"rhea": {"contract_id": "rhea.pbf-ops.testnet", "collateral": ["mnbtc.pbf-ops.testnet"]},
 "aave": {"chain_id": 84532, "pool": "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
          "usdc": {"symbol": "USDC", "address": "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", "decimals": 6},
          "collateral": [{"symbol": "WBTC", "address": "0x54114591963CF60EF3aA63bEfD6eC263D98145a4", "decimals": 8}],
          "max_fee_per_gas": "5000000000"}}
```

- **Permission JSON:** `{"lenders": ["aave", "rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any"}`.
  `moves` is `off`, `lower_cost_only` or `any`. These are the app's default terms. `null` means no permission.
- **Testnet values** (research/aave.md has the sources): Base Sepolia, chain id 84532, RPC `https://sepolia.base.org`;
  Aave's data provider `0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b`, oracle
  `0x943b0dE18d4abf4eF02A85912F8fc07684C141dF`, faucet `0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc`. Our Rhea copy
  will be `rhea.pbf-ops.testnet` (stage 2; it doesn't exist yet).

**What differs from FUNDING.md:**
1. **Every step that adds debt needs a fresh verdict when it runs,** not only our pool's step. `l_borrow` borrows
   at most the fresh verdict's `ext[lender].room`, and `p_borrow` at most its `allow.borrow`. So the funding plan
   stores steps only, with no pool terms, and the engine doesn't count a plan's unfinished steps as debt.
2. **A funding plan's id is `f` and the verdict's `blk`** (`f276800123`), so it can't be mistaken for the unwind plan.
3. **`approve` isn't a plan step.** `evm_approve(token)` is a call of its own that anyone may make (stage 3).
4. **The operator's source order** (`cheapest`, `pool_first`, `lender_first`) lives in the pool: `get_params().funding`.
5. **A settlement at a lender repayment** runs only when the account holds a fresh verdict. Otherwise the next
   hourly one covers it, with the figure that favours the pool.
6. **`ext` also carries `s_bp` and `liq_bp`,** and `allow` gains `fund`.
7. **`ext[lender].room` counts only collateral already posted,** because a lender borrow step may take up to it.
   The split also counts spare collateral, which the plan posts first.
8. **Posting collateral needs a fresh verdict too, while the account owes our pool** (stage 2). Otherwise a client
   could borrow or withdraw on a verdict that still counts that bitcoin as free, then lock it at the lender.
9. **A new account needs 6 NEAR** (4 until Phase 5, 5 in stage 1). With Rhea's steps its code is 471,865 bytes, which
   locks 4.73 NEAR, and Rhea's registration takes 0.1 more. Measured in the sandbox with a 6 NEAR opening: 1.25 NEAR
   free after opening and 1.13 after the first Rhea loan. With 5 NEAR it would be 0.25 and 0.13.

## 25. Account contract and factory in Phase 6

**State** (new accounts only; old accounts keep their code): `permission: Option<Permission>`,
`funding: Option<Funding>`, and from stage 3 `evm`.

**Methods:**

| Method | Who | What | Stage |
|---|---|---|---|
| `new(owner, config, permission)` | The factory | `permission` may be left out or null. A permission that `Permission::problem` faults is refused | 1 |
| `set_permission(permission)` | Owner, 1 yocto | Replaces or cancels (null) the permission and bumps the counter. Logs `permission_set` | 1 |
| `fund(amount)` | Owner, 1 yocto | Stores the held verdict's `fund` steps as the funding plan (below) | 1 |
| `cancel_funding()` | Owner, 1 yocto | Drops the funding plan. Steps already started stay as they are | 1 |
| `execute_step(pid, i)` | Anyone | A `pid` that starts with `f` runs step `i` of the funding plan | `p_borrow` 1; Rhea 2; Aave 3; moves 4 |
| `lender_repay(lender, amount)` | Owner; anyone when `repay` is open to anyone; 1 yocto | Repays the lender from the account's USDC on that chain. A caller who isn't the owner repays at most the verdict's `ext[lender].d`. Never held back | 2, 3 |
| `lender_withdraw(lender, token, amount)` | Owner, 1 yocto | Takes collateral back. While the account owes our pool it needs a fresh verdict answering that `lender_withdraw` with `allow.withdraw` equal to the amount. With the USDC token instead: anyone, no verdict; it brings back what a repayment above the debt left at Rhea | 2, 3 |
| `settle()` | Anyone | Needs a fresh verdict. Calls the pool's `settle` with its `ext` as `LenderReport`s | 2 |
| `claim_credit()` | Owner | Calls the pool's `claim_credit`, which pays the account its credit | 2 |
| `evm_approve(token)`, `evm_bump(nonce, max_fee, tip)`, `evm_withdraw(token, amount, to)`, `evm_home(amount, dep, exp)` | See FUNDING.md 4.5 | Ethereum transactions through Chain Signatures | 3, 4 |

The factory's `create_account(name, owner, permission)` passes `permission` on (left out or null: none). Its stored
config gains `lenders`, so it needs `migrate()` again, with a sandbox test from the saved live state **[1]**.

**Intents [1]** (`request_check`): `{"fund":{"amount":"<micro-USD>"}}`,
`{"lender_withdraw":{"lender":"rhea","token":"<NEAR id or 0x address>","amount":"<units>"}}`,
`{"evm_withdraw":{"token":"0x…","amount":"<units>"}}`. They are new variants after `Withdraw`.

**Verdict fields the account reads [1]**, all optional:
- `ext`: `[{"l":"rhea","c":100000000000,"d":50667000000,"hf_bp":15000,"r_bp":1591,"s_bp":1032,"room":0,"liq_bp":7600}]`,
  at most 2 entries.
- `fund`: the funding steps, at most 6 (`MAX_FUND_STEPS`). A verdict with more is refused.
- `allow.fund`: what those steps borrow in all.
- `evm`: `{"nonce": 7}`.

**`fund(amount)` [1]** needs all of:
- the held verdict is fresh (`FRESH_BLOCKS`), carries the current counter, is HEALTHY, and answers
  `Fund { amount }` with this same amount;
- the account isn't blocked, and has no overdue transfer and no unfinished, unexpired funding plan;
- `fund` isn't empty, each step is a funding kind with valid fields, and the steps' `l_borrow` and `p_borrow` amounts
  add up to at most `amount`;
- every `l_*` step names a lender that the config has and the permission names.

It stores `Funding { pid: "f<blk>", amount, stored_at, expires_at: stored_at + 30 minutes, steps }`, bumps the counter
and logs `funding_stored`. It returns the view. Refusals say which rule failed.

**`get_state()` gains [1]:**

```json
{"permission": {"lenders": ["aave","rhea"], "min_hf_bp": 15000, "max_rate_bp": 2500, "moves": "any"},
 "funding": {"pid": "f276800123", "amount": "94500000000", "stored_at": "<ns>", "expires_at": "<ns>",
             "steps": [{"k": "l_supply", "l": "rhea", "tok": "mnbtc.pbf-ops.testnet", "amt": "131000000", "done": true},
                       {"k": "l_borrow", "l": "rhea", "amt": 50667000000, "done": false},
                       {"k": "p_borrow", "amt": 43833000000, "done": false}]}}
```

Both are `null` when absent. `done` means started, as in the unwind plan.

**Funding steps** (the `k` kinds; amounts as in FUNDING.md 4.3):

| Step | Fields | Runs when |
|---|---|---|
| `p_borrow` | `amt` | A fresh HEALTHY verdict with the current counter is held. Borrows `min(amt, allow.borrow)` through today's borrow path, counter bumps included; 0 is a refusal |
| `l_supply` | `l`, `tok`, `amt` | Any time inside the plan. While the account owes our pool: a fresh HEALTHY verdict, and the counter bumps twice. The first one registers the account at Rhea with 0.1 NEAR of its own |
| `l_borrow` | `l`, `amt` | As `p_borrow`, with `min(amt, ext[l].room)`. Calls the pool's `settle` first (stage 2) |
| `to_evm` | `tok`, `amt`, `min`, `dep`, `exp` | Stage 4. Like `sell`, through the pool's `check_step` |
| `e_home` | `amt`, `dep`, `exp` | Stage 4 |
| `l_repay` | `l`, `amt` | Only in a REBALANCE plan (the verdict's `plan`), run by today's `execute_step` |
| `l_add` | `l`, `tok`, `amt` | The same |

- **Order:** step `i` runs only when every step before it is done, the plan hasn't expired, the account isn't blocked
  and no transfer is overdue.
- **Stage 1 runs `p_borrow` only.** The other kinds answer "the account can't run … steps yet".
- **Pending lender actions** (stage 2): `pending` gains
  `{"lender":{"lender":"rhea","kind":"borrow","amount":"…","until_block":123}}`. While one is listed and its block
  hasn't passed, nothing that adds risk runs. The next call after that block drops it and bumps the counter.
  - **As built (stage 2):** `amount` is micro-USD for a borrow and the token's own units for a withdrawal. A
    withdrawal's entry also carries `token`, the collateral token's id; a borrow's leaves it out. At most one is
    listed. It is listed when the step starts, the 20 blocks restart when the borrow goes out, and it is dropped
    at once if the pool's settlement or Rhea's call itself fails.
  - **The engine** counts it as done up to and including `until_block`: a borrow as debt at the lender with its
    USDC on its way, a withdrawal as collateral gone from the lender's cushion.
  - **Refused while one is listed:** `borrow`, `withdraw` with a loan open, every funding-plan step, and
    `lender_withdraw` of collateral. **Not held back:** `fund`, `repay`, `lender_repay`, top-up and unwind steps,
    `settle`, and checks.
- **Signed Ethereum transactions** (stage 3): `get_state().evm` is
  `{"nonce": 3, "signed": [{"nonce": 2, "kind": "borrow", "token": "0x…", "amount": "…", "to": "0x…", "raw": "0x02…",
  "hash": "0x…", "step": "f276800123:1", "signed_at": "<ns>"}]}`, the newest 20, oldest first. `kind` is `approve`,
  `supply`, `borrow`, `repay`, `withdraw` or `transfer`.

## 26. The pool in Phase 6: pricing

**Stage 1 is `contracts/pool/src/pricing.rs` as plain functions with unit tests [1].** The pool's state, methods and
migration are stage 2.

```rust
pub enum Pricing { PassThrough, Lender { margin_bp: i32, cap_bp: Option<u32> }, Fixed { rate_bp: u32 } }
pub enum FundingOrder { Cheapest, PoolFirst, LenderFirst }          // JSON: snake_case
pub struct PricingLimits {
    pub max_rate_bp: u32,             // 6000: a lender's rate never counts above this
    pub avg_plus_bp: u32,             // 500: nor above its 7-day average plus this
    pub max_period_ns: u64,           // 48 hours
    pub account_subsidy_day: U128,    // $100 a day per account
    pub pool_subsidy_day_bp: u32,     // 5 bp of capital a day for the whole pool
}
```

JSON: `"pass_through"`, `{"lender":{"margin_bp":120,"cap_bp":null}}`, `{"fixed":{"rate_bp":650}}`.

**One settlement** covers the time since the last one, cut to `max_period_ns`. For each lender, with the previous
report's and the new report's debt, and the previous report's rates:
- **The counted rate** `r` is the lender's reported rate, cut to `max_rate_bp` and to the 7-day average plus
  `avg_plus_bp`. With no history yet, only `max_rate_bp` applies.
- **The client's rate on that part** `t`:
  - `PassThrough`: `r`.
  - `Lender`: `r + margin_bp`, then at most `cap_bp` if there is one.
  - `Fixed`: `rate_bp`.
  - **The floor:** when `t < r` (a subsidy), `t` is raised to the lender's deposit rate if that is higher, and never
    above `r`.
- **The part's adjustment** is `debt × (t − r) × time ÷ a year`. A fee (`t > r`) uses the larger of the two debts
  and rounds up. A subsidy uses the smaller and rounds down.

Under `Fixed`, our pool's own part adjusts too: `pool debt × (rate_bp − the tier's rate now) × time ÷ a year`.

The total is a **fee** (added to the account's pool debt) or a **subsidy** (taken off it; past zero it becomes
`credit`). A subsidy is cut to what is left of the account's and the pool's 24-hour budgets.

**Worked numbers for the tests** (one year, for round figures; real periods are an hour):
- Rhea part $50,667 at 15.91% with a deposit rate of 0, `Lender { margin_bp: 0, cap_bp: 800 }`: a subsidy of
  $4,007.76 a year, $0.4575 an hour. With Rhea's real deposit rate of 10.32%, the floor makes the client pay 10.32%,
  and the subsidy is $2,832.29 a year.
- Aave part $56,667 at 5.33%, `Lender { margin_bp: 120 }`: a fee of $680.00 a year.
- `Fixed { rate_bp: 650 }` on Aave $56,667 at 5.33% and our pool $37,833 at 6.50%: a fee of $663.00 a year on the
  Aave part and nothing on ours.

**Stage 2 shape** (for the other parts to code against):
- Methods: `set_pricing(target, pricing)` with target `{"account":"<id>"}` or `{"tier":"STANDARD"}` (`pricing` null
  clears it); `set_pricing_limits(limits)`; `set_funding(funding)` with `{"order":"lender_first","loan_days":90}`;
  `settle(report: Vec<LenderReport>)`, callable by a registered borrower account only; `claim_credit()`.
- An account's policy is its own, else its tier's, else `pass_through`.
- Views: `get_pricing(account_id)` →
  `{"pricing": …, "from": "account"|"tier"|"default", "fees_charged": "0", "subsidy_paid": "0", "credit": "0",
  "settled_at": "<ns>", "last": [LenderReport]}`; `get_params().funding` and `.pricing_limits`; `get_pool()` gains
  `fees_charged`, `subsidy_paid` and `subsidy_left_24h`.
- Events: `set_pricing`, `settle`.

## 27. The engine in Phase 6

**The seam [1, done as stubs]:** `pb_read::lenders` (`LenderBook`, `LenderPos`, `Holding`, `StoredFunding`),
`Book.lenders`, the new `Intent` and `PlanStep` variants, and `risk_core::lender` (the arithmetic, with tests).
pb-read fills `Book.lenders`. pb-risk and the backtest only read it.

**pb-read [1]:**
- **Requests:** the three new intents, checked like the old ones.
- **Reads,** into `Inputs` under a new field left out when empty, so every saved run replays to the byte:
  - **Rhea** (when `config.lenders.rhea` is set), at the run's block: `get_account`, `get_assets` and each token's
    price setting on `contract_id`. View names and fields come from Rhea's source (research/rhea.md).
  - **Aave** (when `config.lenders.aave` is set): JSON-RPC `eth_call`s and `eth_getTransactionCount` to the chain's
    RPC, from a table keyed by chain id that holds the RPC URL and the data provider. Sent together, last.
  - A lender in the config that can't be read is fatal: no verdict.
- **The book** (`book::build_with`), as `pb_read::lenders`' header says: the whole debt in `account.debt`; lender
  collateral and Ethereum-address balances added to `account.near`; `LenderBook.locked`; `held_coins` prices a coin
  held only at a lender.
- **WBTC** is a sixth token with nBTC's settings. `universe_v0.json` and the reference cases don't change.
- **An account with no `lenders` in its config reads and decides exactly as today.**

**pb-risk [1]:**
- **`ext`:** one entry per lender position that is permitted or holds anything. `c` is `posted_micro`, `d` is
  `debt_micro`, `hf_bp` is 0 with no debt, `room` is below.
- **Two calls to the checked maths** (FUNDING.md 6.2). The risk room uses the whole debt, plus a week of each
  lender's rate above our pool's, with our pool's own limits out of the way. The pool room uses our pool's debt
  and its real limits. `allow.borrow` is the smaller. `credit.line` is the whole debt plus it.
- **A lender's room for planning:** `risk_core::lender::room_micro` on posted plus spare collateral, at the target
  cushion (the larger of 15000 and the permission's `min_hf_bp`), less what is owed. It is cut to what the lender
  has free and to the risk room. It is 0 when the lender isn't permitted, when its rate is above `max_rate_bp`, when
  a held price is uncertain, or when the state isn't HEALTHY. The `fund` split uses this figure.
- **`ext[lender].room`** is the same on **posted** collateral alone: what an `l_borrow` step may take right now.
- **`fund` intent:** `risk_core::lender::split` with the pool's `funding.order`. Steps, in order: an `l_supply` of
  just enough spare collateral if the lender part needs it, the `l_borrow`, then the `p_borrow`. `allow.fund` is
  their total. Not HEALTHY, or nothing to lend: no steps and `allow.fund` 0.
- **Top-up:** a position under 13500 adds REBALANCE, under 12000 REBALANCE_NOW. Steps come before any others in
  `plan`: `l_add` from spare collateral, else `l_repay` from `cash_micro`, sized by `add_to_target_micro` and
  `repay_to_target_micro`. A `top` line says it in words. It runs whether or not the lender is permitted. It goes by what the lender shows now: an action still listed in
  `pending` is left out, so a loan the lender already shows is never repaid as if it were two.
- **`lender_withdraw` intent:** allowed when the book after it is still inside every rule and the lender's cushion
  stays at the target. `allow.withdraw` is then the amount, else 0.
- **Plan steps never spend what is locked:** `sell`, `to_hl` and `repay` are sized from NEAR balances.
- **`evm`:** `{"nonce": n}` when Aave was read.
- All new fields are left out when empty. The five saved fixtures must replay to the byte.

**The credit check's `funding` [1]** (mode `credit_check`, mainnet, read only): how the line would be funded.

```json
"funding": {"line": 94172000000, "pool_rate_bp": 650, "target_hf_bp": 15000, "loan_days": 90,
  "lenders": [{"l": "aave", "chain": "Ethereum", "collateral": "WBTC", "rate_bp": 533, "supply_bp": 410,
               "liq_bp": 8500, "ltv_bp": 8100, "penalty_bp": 500, "free": 158900000000000,
               "lends": 56503000000, "pool": 37669000000, "fall_bp": 3333, "blended_bp": 580,
               "move": {"cost_bp": 56, "cost": 560000000, "saves": 163000000, "source": "1Click dry quote, no key"},
               "used": false, "why": "…"}],
  "choice": "pool"}
```

- `lends` is what the lender would lend against the book's bitcoin at the target cushion, cut to the line; `pool`
  is the rest. `fall_bp` is how far bitcoin can fall before that lender sells. `blended_bp` is the whole loan's cost
  with pass-through pricing, using `pool_rate_bp` (the pool's rate at 60% lent).
- `move` is the cost of getting the bitcoin to that lender's chain (null for Rhea, and when no quote came), and
  `saves` is the interest saved over `loan_days`. `used` says whether the 6.4 rule would use this lender.
- `choice` is the lender used, or `"pool"`.
- Aave's mainnet terms come from Aave's own API, as `research/scripts/aave_live.py` reads them.

**The backtest [1]:** `backtest lender [--json <file>]`, as FUNDING.md 6.8. And `backtest live <request.json>`: runs
pb-risk natively on live reads through `curl`, read only, so a new build can be tried before it is published.

**pb-gateway [2]:** counts a stored funding plan in its pre-trade checks (section 9, Live allowances). A plan or a
`pending` it can't read is `READ`.

## 28. Keeper and backend in Phase 6

| Endpoint | Answer | Stage |
|---|---|---|
| `GET /api/lenders` | `{read_at_ms, lenders: [{l, network, chain, collateral, rate_bp, supply_bp, free, ltv_bp, liq_bp, penalty_bp, source, stale}]}`. Mainnet Aave (Ethereum) and Rhea always; testnet Aave (Base Sepolia); the testnet Rhea copy once `RHEA_ACCOUNT_ID` is set and answers. `free` is a micro-USD string. Kept 5 minutes | 1 |
| `GET /api/lender/:account` | `{account, read_at_ms, permission, funding, verdict_blk, lenders: [{l, posted, debt, hf_bp, liq_bp, rate_bp, supply_bp, room, status}], pricing}`. From `get_state()` and the held verdict's `ext`. `status` is `none`, `safe`, `thin` (under 13500) or `act` (under 12000). `pricing` is the pool's `get_pricing` answer, or null until the pool has it | 1 |
| `POST /api/funding-plan` | Body `{account, amount}`. A preview with the `fund` intent. `{asked, total, sources: [{source, amount, rate_bp}], steps, ext, blended_bp, verdict, run}`; pb-risk's refusals pass through with HTTP 200, as previews do | 1 |
| `POST /api/evm/submit`, `POST /api/evm/gas`, the two new `POST /api/quote` moves | FUNDING.md 7.2 | 3, 4 |

- `source` is `aave`, `rhea` or `pool`. The pool's `rate_bp` is the verdict's `rate_bp`.
- **Keeper [1]:** `plan.ts` knows the seven new kinds and who runs each, and says each in words. `Seen` carries the
  held verdict's `ext`. Running funding plans, settling and the Rhea price are stage 2.
- New settings, names only: `EVM_RPC_URL`, `EVM_CHAIN_ID`, `AAVE_POOL_ADDRESS`, `AAVE_DATA_PROVIDER_ADDRESS`,
  `AAVE_FAUCET_ADDRESS`, `EVM_GAS_PRIVATE_KEY`, `RHEA_ACCOUNT_ID`.

## 29. The web app in Phase 6

- **Credit check [1]:** "How this loan would be funded", from the result's `funding`: each lender's part, our
  pool's part, the cost of each, the whole loan's cost, how far bitcoin can fall before the lender sells, and the
  cost of moving the bitcoin. It shows nothing when the result has no `funding` (an older engine).
- **Borrow panel [1]:** under the amount, "Where it comes from", from `POST /api/funding-plan`. It shows only for an
  account whose config has lenders. Borrowing itself stays as it is until stage 2.
- **Home [1]:** a card per lender from `GET /api/lender/:account`, with a cushion bar: safe, thin, act.
- **Preview page [1]:** sample states for the cards and the funding view.
- **The permission at account opening, `fund`, the step list and the operator's pricing controls** are stage 2.

## 30. Stage 1 as built (10 Nov)

Nothing was deployed, signed, sent or downloaded. Every suite passes: the engine 281 (it had 199), the contracts
474 with the sandbox tests (they had 376), JavaScript 347 (it had 296). `contracts/build.sh` builds every contract.

**Gate 1, passed on 10 Nov at 22:50 UTC:**
- **A sample book, run live:** `backtest live` ran the new `credit_check` on the worked example against mainnet,
  read only (21 requests, 7.1 s). The answer is in `research/data/phase6_funding_sample.json`, and
  `backtest credit` recomputes it byte for byte (output hash `4680733b…`).
  - The line was **$80,443**, not about $94,000: 1Click quoted no liquidity for $500k of nBTC that hour, so the
    existing rule set nBTC's ratio to 0.80.
  - **Aave** (5.02%) would lend $56,663 and our pool $23,781; bitcoin could fall 33.3% before Aave sold. Moving
    the bitcoin there costs $490 and saves $207 over 90 days, so it isn't used.
  - **Rhea** (16.05%) would lend $50,663 and our pool $29,780. It is dearer than our pool, so it isn't used.
  - `choice` is `pool`.
- **`backtest lender`** prints its table; `research/data/backtest_lender_v0.json` (400 cases, sha256 `135bb5f5…`).
- **End to end** (`pb-risk/tests/lenders_pipeline.rs`): a Rhea position recorded on mainnet, read by pb-read,
  becomes `ext`, a REBALANCE_NOW with an `l_add` step, and for a `fund` intent an `l_supply` and an `l_borrow`.
- **The enclave builds,** not published: `pb-risk` 1,602,401 B (`4662a846…`), `pb-gateway` 1,534,415 B
  (`d29461bf…`), with section 15's build command.

**After the gate, 11 Nov** (before stage 2; nothing deployed):
- **The cushion levels moved** at the user's word: act 1.35 (`ACT_HF_BP` 13500) and act-now 1.2 (`NOW_HF_BP` 12000).
  The permission's lower bound follows (`MIN_HF_BP` 12000), and so do the backend's and the app's `thin` and `act`.
- **Every suite passes again:** the engine 281, the contracts 474, JavaScript 347; builds and lint are clean, and
  `backtest examples` still matches the reference on 144 of 144 lines.
- **`backtest lender` rerun:** with a top-up ordered under 1.35, no lender liquidates in any of the ten windows, for
  any starting cushion from 1.2 to 2.0 and a top-up that lands in 2, 15 or 60 minutes. The slowest top-up still in
  time is 157 minutes from 1.35 and 20 minutes from 1.2. The file's sha256 is now `de8286d1…`.
- **The builds above are of the old levels.** The enclave programs are rebuilt in stage 2 before they are published.
  The contracts were rebuilt: account 433,065 B (`2d69494a…`), factory 665,450 B (`52f9e72d…`), pool unchanged.
- **Gas and test NEAR are in place:** `pbf-ops.testnet` holds 30.51 NEAR, and the gas wallet holds 0.05 ETH on Base
  Sepolia, moved from Sepolia with `scripts/bridge-gas.mjs`.

**The engine:**
- **pb-read** (`lenders.rs`, `evm.rs`, `near.rs`, `read.rs`, `book.rs`, `inputs.rs`, `request.rs`):
  - **Rhea** is 4 views: `get_account`, `get_assets`, and `get_token_pyth_info` for USDC and the collateral token.
    Names and fields are from `ref-finance/burrowland` (0.15.7 source) and match mainnet's 0.16.2 answers.
  - **Aave** is 10 calls at `latest`, sent together and last. The chain table (84532) holds the RPC, the data
    provider and the oracle. Selectors are computed with keccak in the tests, and checked against
    `aave-dao/aave-v3-origin` and live answers from Base Sepolia.
  - **WBTC's ratio on testnet** is Aave's oracle price over the engine's BTC price, capped at 1.
  - **Refusals:** any Rhea debt that isn't USDC; a lender in the config that can't be read.
  - `debt_micro` at Aave is the larger of the USDC debt and Aave's own total. `free_micro` ignores borrow caps.
  - `locked` is in the token's smallest units.
- **pb-risk** (`lenders.rs`, `verdict.rs`, `plan.rs`):
  - **The pool room** is `borrow_allowance` on our pool's debt with every bound kept.
  - **The risk room** is the same function on the whole debt, plus 7 days of each lender's rate above ours, taking
    the smallest returned bound other than C5 (the client limit) and C6 (the pool's own).
  - `ext.hf_bp` is the smaller of the lender's own figure and ours, which counts borrows on their way.
  - A top-up adds spare collateral first, then repays from USDC on that chain. During an unwind it waits.
  - A `withdraw` on NEAR can't pass the NEAR balance.
  - An unknown `funding.order` counts as `cheapest`.
- **The credit check's `funding`** (`pb-read/src/credit.rs`, `pb-risk/src/credit.rs`):
  - Aave's mainnet terms come from `https://api.v3.aave.com/graphql` (`reserve(request: {market, underlyingToken,
    chainId})`), market `AaveV3Ethereum`. Its rates are APYs.
  - The move's cost is a dry 1Click quote from `nep141:nbtc.bridge.near` to
    `nep141:eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near`. It prices only the bitcoin the lender's part
    needs.
  - Rhea's `penalty_bp` is 0, because its discount isn't fixed. The app says so in words.
  - A lender that couldn't be read is left out. `funding` is left out when no lender was read, so
    `credit_worked.json` keeps its pinned hash.
  - Lenders count bitcoin at the reference price with no depeg ratio. The older `rhea` section still uses the
    ratio, so the two differ when it is under 1.
- **`backtest live <request.json>`** (`backtest/src/live.rs`): https only, through `curl`, 8 requests at a time.
- **`backtest lender`** (`backtest/src/lender.rs`) found, with the levels left as they are for the user to decide:
  - **1.5 as the target holds.** Left alone, a lender sells only in the March 2020 crash, at minute 229 (0.967).
  - **1.3 as the act level** is safe while a top-up lands within 45 minutes. An hour needs 1.31.
  - **1.15 as the act-now level** is safe only within about 4 minutes. 1.2 gives 20 minutes.
  - **So the levels moved on 11 Nov,** at the user's word: act 1.35 and act-now 1.2. The target stays 1.5.
  - **A miss costs far more at Aave:** at 1.5, Rhea takes 10.5% of the bitcoin for $21; Aave takes 45% for $1,417.
  - Rhea's discount is modelled as a flat 0.3%; its own rule can reach about 2% in a fast minute.

**The contracts:**
- **Pool** (`contracts/pool/src/pricing.rs`, 32 tests; the pool's tests went from 52 to 84): `Pricing`,
  `PricingTarget`, `FundingOrder`, `FundingSettings`, `PricingLimits`, `AccountPricing`, `RateHistory`,
  `PricingView`; `settlement`, `counted_rate`, `client_rate`, `policy_for`, `report_problem`, `cut_subsidy`,
  `apply`. The worked numbers match to the cent.
  - The 7-day average is the mean of daily means, so many calls in one spike can't swamp it.
  - A lender only in the new report is charged a fee on the new debt and gets no subsidy.
  - What the budgets cut from a subsidy is dropped.
- **Account** (`funding.rs`, `lib.rs`, `verdict.rs`, `plan.rs`; unit tests 222 to 276) and **factory** (23 to 29;
  sandbox 27 to 29): as section 25, plus:
  - `fund` needs a verdict read at a later block than the last funding plan's, so no two plans share an id.
  - Every funding step is checked against the config and the permission again when it runs.
  - `cancel_funding` logs `funding_cancelled` and doesn't bump the counter.
  - An `ext` line must have `l`, `d`, `r_bp`, `s_bp` and `room`. An unknown or repeated lender refuses the verdict.
  - The factory's `migrate(lenders?)` upgrades from the Phase 5 layout; the sandbox test runs it on the state saved
    from testnet.
  - **Sizes:** the account 433,065 B, the factory 665,450 B. A new account locks 4.34 NEAR, so `MIN_DEPOSIT` is
    5 NEAR. `pbf.testnet` needs about 1 NEAR more before its upgrade.

**Backend, keeper and app:**
- **`GET /api/lenders`:** each row also has `read_at_ms`. Read live: Aave on Ethereum 5.02%, $164M free; Rhea
  16.05%, $1.88M free; Aave on Base Sepolia 0.74%, $44.7M free, WBTC at 81.5% and 83%.
- **`GET /api/lender/:account`** also answers `config_lenders`, the lenders the account's own config names. The
  app shows the funding view only for those accounts.
- **Amounts:** `posted`, `debt`, `room`, `total` and `sources[].amount` are JSON numbers; `free` and `asked` are
  strings. `blended_bp`, a source's `rate_bp` and `verdict_blk` can be null.
- **`POST /api/funding-plan`** is tested against a fake verdict. The pinned engine doesn't know `fund` yet.
- **Keeper:** `FUNDING_KINDS`, each kind in words, `Seen.ext`. It runs none of them yet.
- **App:** the credit check's "How this loan would be funded", the borrow panel's "Where it comes from", and a card
  per lender on Home. Preview states: `lenders`, `lender-thin`, `lender-act`, `funding`, `funding-pool`.
- **The gas wallet for Base Sepolia** is `0x2031181d63507368232579AF4c64a1c3428407fF`
  (`python3 -I scripts/new-hl-float.py --gas`). It is empty.
- **Rhea's contract file** (downloaded 11 Nov with the user's yes; not deployed, not run) is
  `vendor/burrowland/burrowland_release.wasm`, alone in its folder.
  - Source: `https://raw.githubusercontent.com/ref-finance/burrowland/a479b839cae2756c472521187d6e6308dc34d0ae/releases/burrowland_release.wasm`
    (the last commit to touch the file, 15 Nov 2025). The repository's licence is the Unlicense.
  - 1,015,136 bytes; git blob `9355d96e13ed0833ef028e372644740401f000f1`, the same as GitHub lists;
    sha256 `bdd286fece512c3def8119f58063e9d42571069cfa221ee32ec488d0fe395055`;
    NEAR code hash `DmzFHbCP7jCobFjPYx7GRvc1iHTpqyLJxvcrEawFaF4g` (what `rhea.pbf-ops.testnet` must show
    after the deploy).
  - It carries the version string `0.15.7` and exports 131 methods, among them `new`, `get_version`,
    `get_config`, `get_account`, `get_assets`, `get_token_pyth_info`, `add_asset`, `update_asset`,
    `add_token_pyth_info`, `update_token_pyth_info`, `execute`, `execute_with_pyth`, `ft_on_transfer` and
    `storage_deposit`. There is no `liquidate` method: a liquidation is an action inside `execute_with_pyth`.

**For stage 2 to settle:**
1. **Under `Fixed`, our pool's own part uses one debt figure.** A client could borrow from the pool just before a
   settlement, or repay just before one. Settle at every pool borrow and repay, or track the period's smallest and
   largest pool debt.
2. **A fee adds debt:** the pool's exposure records must follow, and it must stay out of the daily lending window.
   A subsidy isn't a repayment, so it must not open room there.
3. **Credit is money the pool owes:** capital must subtract it.
4. **A minimum time between settlements,** since anyone may call `settle()`.
5. **`l_supply` needs a fresh verdict while the account owes our pool** (section 24, point 8).
6. ~~**The keeper's and the app's account opening** attach 4 NEAR; the new factory needs 5.~~ **Done in stage 2:** the
   factory's minimum is 6 NEAR, and the keeper, the app and `scripts/first-loan.py` attach 6.
7. **The gateway's rule** for a held funding plan, and a guard that refuses a mainnet `EVM_CHAIN_ID`.
8. ~~**The cushion levels**~~ **Decided 11 Nov:** act 1.35 and act-now 1.2 (they were 1.3 and 1.15); the target stays 1.5.
   Changed in `risk_core::lender`, and with it the permission's lower bound (`MIN_HF_BP`, now 12000), the backend's and
   the app's status levels, and the backtest's file (its `first_minute_under_act` and `_now` fields).
9. **The move rule counts the trip to the lender only** (one 1Click quote, nBTC to WBTC). The trip back costs about
   the same again. On the live sample ($490 one way, $839 a year saved) the break-even is 213 days one way and about
   14 months both ways. **Decided by the user on 11 Nov: count both trips.** Built in stage 3 (section 33).

## 31. Stage 2 as built (11 Nov), before the deploy

Code and local tests only: nothing is deployed, signed or sent yet. The deploy sitting is `research/stage2_deploy.md`.

**Every suite passes on the joined code:** the engine 298 (it had 281), the contracts 578 with the sandbox tests (474),
JavaScript 475 (347): keeper 136, backend 122, app 162, stand-in 44, its client 11. Builds and lint are clean, and
`backtest examples` matches the reference on 144 of 144 lines.

**What gets deployed:**

| Build | Bytes | sha256 |
|---|---|---|
| Account | 471,865 | `38261f9dff5426bcd461253058a483a042bc14fa12e48c2a6cea1d1d365c4f41` |
| Factory (carries the account) | 704,244 | `3fef6b1a63500a42d9dd52f5181010c5f2d670774e03b10701a67c6c65d19c00` |
| Pool | 464,340 | `c4641c0e8d61015fa6d608abf46f0b00d2fa1bcb882b4cd02738b878d64024a2` |
| `pb-risk` | 1,605,707 | `8f60fa0c92e106dec8793b9eb2ef25ed2b65409d934b679715a756216eb79027` |
| `pb-gateway` | 1,537,731 | `e5d4b32459d5acf5dbd163e787705e952decfbcf8c0815301fff0ff1e9418b50` |

`params_hash` (`3d362b43…`) and `model` (`B-0.2`) are unchanged: `universe_v0.json` didn't change.

**Rhea's own file in the sandbox** (`contracts/tests/tests/rhea.rs`, 7 tests; `common/rhea.rs`; `research/rhea.md` 12):
- **It works as it is, with no oracle.** When every token a call touches has a fixed `default_price`, `execute_with_pyth`
  does the whole job in its own receipt.
- **A borrow** burns 12 TGas and needs 30 attached. Its `Withdraw` must say `max_amount`. The USDC lands two blocks
  after the call, and the borrower can get one unit less. A repayment above the debt stays at Rhea as a deposit.
- **Our copy differs from mainnet in these settings only:** no fee beneficiary; the supply and borrow caps are at
  u128's maximum; nBTC can't be borrowed (`can_borrow` false), so a stranger can't borrow the clients' collateral;
  the operator owns it; and the operator borrows 851,500 of its own 1,000,000 mUSDC, so that 85.15% is lent out as on
  mainnet and the copy charges 15.91% to borrow and pays 10.16% on deposits. $148,500 is left for clients.
- **Changing BTC's price** is `update_token_pyth_info` with all five fields, by the owner, 1 yoctoNEAR.

**The account** (`contracts/account/src/lender.rs`, new; `lib.rs`):
- **Steps at Rhea:** `l_supply` and `l_borrow` in a funding plan, `l_add` and `l_repay` in a top-up plan. Aave's kinds
  and the two moves still answer that the account can't run them yet.
- **`l_borrow`** needs a fresh HEALTHY verdict, takes `min(amt, ext[l].room)`, lists the lender action, and calls the
  pool's `settle` with the lender's debt **plus the amount it is about to borrow**; only then Rhea. A failed settlement
  or a call Rhea refuses reopens the step and drops the listing.
- **`l_add`** runs only while the held verdict's `blk` is the plan's id. `l_repay` is never held back.
- **Direct calls:** `lender_repay(lender, amount)` (1 yocto; a stranger pays at most `ext[lender].d`),
  `lender_withdraw(lender, token, amount)` (1 yocto; with the USDC token anyone may call it, to bring back what a
  repayment left at Rhea), `settle()` and `claim_credit()` (no deposit).
- **The account's loan record follows a settlement:** a fee is added and opens the loan; a subsidy comes off, never
  below zero. It can differ from the pool's figure by 1 micro-USD, because the pool rounds a fee's debt up.
- **Measured in the sandbox** (`tests/lender.rs`, 4 tests on Rhea's file and the real pool): `l_borrow` burns 23 TGas,
  `l_repay` 24, `l_supply` with Rhea's registration 19, `settle` 8, `claim_credit` 9.5. `l_borrow` still reserves 210
  for its callbacks, so `execute_step` is sent with 300.
- **The factory's `MIN_DEPOSIT` is 6 NEAR** (section 24, point 9).

**The pool** (`contracts/pool/src/settle.rs`, new; 126 unit tests; `tests/pool_pricing.rs`; the live pool's `migrate` in
`tests/upgrade.rs`, rerun on the state fetched on 11 Nov):
- **`settle({"report": […]})`** answers `{fee, subsidy, credit, period_ns, cut, debt, pricing, from, parts}` or
  `{"skipped": "<why>"}`. It refuses only an unregistered caller and a report that names a lender twice or an unknown
  one. A real call burns about 2.5 TGas.
- **`PricingLimits` has `min_period_ns`** (10 minutes; optional on input). A report inside it is skipped, unless some
  lender's debt rose by more than interest could have added: that one is always settled. With the account's report of
  "debt plus the borrow", a client who borrows, holds and repays between two settlements still pays the margin.
- **Under `Fixed`,** our pool's own part uses the period's average debt and the rate the pool really charged, noted at
  every borrow, repayment, returned loan and write-off.
- **A fee** goes onto the debt the way a loan would, so every exposure record follows, and it stays out of the daily
  lending window. A subsidy opens no room there. **Credit** is taken off capital everywhere, and a loan or a defund
  can't take the cash behind it. `claim_credit()` pays with a plain `ft_transfer` and puts the credit back if it fails.
- **A policy change** counts from the account's next settlement.
- **Views:** `get_pricing(account_id)`; `get_params()` gains `funding`, `pricing_limits` and `tier_pricing`; `get_pool()`
  gains `fees_charged`, `subsidy_paid`, `subsidy_left_24h` and `credit_owed`; `get_borrower` gains `pricing`,
  `fees_charged`, `subsidy_paid` and `credit`. **Events:** `set_pricing`, `set_pricing_limits`, `set_funding`, `settle`,
  `claim_credit`, `claim_credit_failed`.
- **`pool.pbf.testnet` needs about 2 NEAR more** before the upgrade: the new code leaves it 0.01 NEAR free.

**The engine:**
- **The gateway** counts a stored, unexpired funding plan (section 9, Live allowances).
- **A pending lender borrow** counts as debt at the lender and as USDC on its way, so equity doesn't dip for the 20
  blocks. A pending withdrawal counts as collateral gone. A `pending` that isn't a list is refused.
- **Top-ups go by what the lender shows now** (section 27).
- **Rhea's price:** the reader uses Rhea's own fixed price when one is set (on R's real answers: cushion 14249 at
  $75,000 and 9499 at $50,000), and the engine's BTC price when none is.
- **A Rhea-only config** reads, decides and answers `fund` (`pb-risk/tests/rhea_only.rs`).

**The keeper** (`services/keeper`): runs a funding plan's steps as soon as `fund` stores it, asking for a `check` before
each step that needs a fresh verdict; sends no check and no risk-adding step while a lender action is listed; runs
`l_add` only under the verdict that ordered it; asks for a check when a cushion nears 1.35; calls `settle()` behind the
hourly check for each account with a lender loan; and keeps our copy's BTC price within 0.25% of Hyperliquid's oracle,
signing as the copy's owner. **The gate's price drop is a hold file** (`RHEA_PRICE_HOLD_FILE`) that the keeper itself
applies, so the price has one writer. New settings: `RHEA_ACCOUNT_ID`, `MNBTC_TOKEN_ID`, `RHEA_PRICE_HOLD_FILE`.
The gate is `pnpm --filter @pb/keeper funding:demo -- --lender rhea [--dry-run]`.

**The backend** (`services/api`): `GET /api/pricing` (every account with a lender loan, a policy of its own, or a fee,
subsidy or credit on record; `lender_debt` is the verdict's figure, `last` the pool's); `held` and `deposit` on the
lender entries of `GET /api/lender/:account`; `keeper.rhea` in `GET /api/keeper/:account`; and it starts only when
`EVM_CHAIN_ID` is a test chain (84532, 11155111, 421614 or 11155420).

**The app** (`web/`): the permission and its terms at account opening, in the same approval; borrowing through `fund`
with the plan's steps shown as they run; one loan total; repaying the source that costs the client most first, with
"All" sending a lender a little over its debt; taking collateral back up to what `held` shows; bringing back USDC left
at Rhea; claiming a credit; and the operator's pricing controls on the Book page. Preview states, each clicked through
with sample data: `/dev/home?state=new|fund|plan|plan-expired|sources|credit|leave|permission|account-new|book|book-operator`.

**Known gaps, none of them a loss to the pool:**
1. A borrow Rhea refuses leaves its "debt plus the borrow" report at the pool, so under a margin policy the next
   settlement charges the margin on a loan that never happened: about 8 cents on $60,000 for an hour.
2. The pool's rate history is per account, so a new account has only the 60% cap and the deposit-rate floor at first.
3. If the keeper stops settling hourly, the client chooses which moments get reported. The two daily budgets bound it.
4. The app can't show USDC left at Rhea when the verdict has no Rhea line (no debt, no collateral, no permission).
5. `/borrow` for a lender account and dark mode were not looked at in the browser. Nothing in the app has met a real
   backend, wallet or chain yet.
6. The move rule still counts the trip to a lender only (section 30, item 9).

## 32. Stage 2 live on testnet, and gate 2 (11 Nov)

**Gate 2 passed on 11 Nov at 15:55 UTC** (`research/data/phase6_funding_rhea.json`, account `gate2a.pbf.testnet`, 15:36 to
15:55). The deploy steps are `research/stage2_deploy.md`; the user approved each signed one.

**Deployed, each checked on chain:**
- **Test NEAR** from `pbf-ops.testnet`: 2 to the pool, 2 to the factory, 10 to the keeper.
- **Our Rhea copy, `rhea.pbf-ops.testnet`:** `scripts/rhea-setup.sh --go`, 12 steps in one run. Code hash
  `DmzFHbCP7jCobFjPYx7GRvc1iHTpqyLJxvcrEawFaF4g`, version 0.15.7, owner `pbf-ops.testnet`, 148,500 mUSDC free, borrowing
  at 15.91% a year.
- **The pool:** new code with `migrate` (tx `DCvTsJCwZ9FeYSKWT1NhYXYkndgdcweKkxaqNxF5RyAo`). A snapshot before and after
  shows every old field unchanged. Then `set_pricing_limits` with `min_period_ns` of 2 minutes for the demo
  (tx `FamKx3MB…`), and after the gate `set_funding` with `lender_first` (tx `52ABqaNn…`): our copy charges more than
  our pool, as Rhea does on mainnet, so `cheapest` would never use it.
- **`pb-risk` `8f60fa0c…` and `pb-gateway` `e5d4b324…`:** uploaded, fetched back from FastFS (200, right size and hash)
  and added with `--no-activate`. `update_access` (tx `8eBiSyqkAyGZ4S6c7tGAPFtDT6iKjNahURsmcLUhR9qP`) added the new
  gateway's hash to the seed's rule beside the two old ones. The new and the old gateway both answer
  `demo1.pbf.testnet`'s agent `0x68643293…d46a`.
- **The factory:** new code with `migrate({"lenders":{"rhea":…}})` (tx `AwDLea3dFjsPUdA9tFDHWTzdoDqCmV9j7ohvvMhSCNQr`).
  Its first send failed with an RPC error (HTTP 520) and nothing landed. `account_code_hash` is `38261f9d…`, and its 6
  accounts are kept. `set_config` pinned both new programs (tx `5L8nbpYY…`).

**What the gate showed, on a fresh account:**
- **Opening:** `create_account` with 6 NEAR and the permission in one signature. The account pinned the new programs.
- **The loan:** asked $2,000; the engine allowed $1,079.27 for the 0.015 nBTC hedged book. One `fund`, then the keeper
  ran the steps: `l_supply` of all 0.015 nBTC, a fresh check, `l_borrow` of $562.73 at Rhea (cushion 1.4999), the wait
  for Rhea's action, a fresh check, and `p_borrow` of $516.54 from our pool. Funded 142 s after the signature.
- **A fee:** with Rhea's rate plus 5 points, a settlement booked 234 micro-USD over about 4 minutes.
- **A subsidy:** with Rhea's rate capped at 0, the client's rate fell to Rhea's deposit rate (10.24% against 16.03%),
  and a settlement booked 179 micro-USD.
- **A top-up:** the copy's BTC price was held 13.2% under the oracle ($73,932 to $64,268). The keeper saw the cushion
  near 1.30 and asked for a check; the verdict was REBALANCE with `l_repay` of $74.32; the keeper ran it; the next
  verdict read 1.5000. From the price change to the restored cushion: 56 s.
- **Leaving:** `lender_repay` of the whole Rhea debt, the pool repaid ($516.5356 of debt, with the fee in it), the nBTC
  and the leftover USDC back from Rhea, the short closed, the USDC home, and both tokens withdrawn. The account ends
  holding neither.

**Found on the way, and what was done:**
- **OutLayer's testnet was slow that afternoon:** a 3-second run waited 30 to 100 s in its queue, and calls that wait
  for the answer got none in 110 s. Both JavaScript clients now submit with `async: true` and poll `/calls/<id>` every
  2 s for up to `OUTLAYER_WAIT_MS` (180 s). The keeper asks for one check at a time per account and gives a check
  150 s before asking again (three tries). The app's proxy and waits were lengthened to match (`web/next.config.js`,
  `use-check-then-act.ts`, `setup-actions.ts`, `gateway.ts`, `risk.ts`). Suites after it: keeper 151, backend 130,
  app 162; JavaScript 498 in all.
- **Two ceilings no client can lift:** the gateway accepts an order signed at most 120 s ahead, and OutLayer's yield
  window for an on-chain check is 200 blocks. A queue longer than that fails the order or the check.
- **Closing the short was refused once** (`P2 limit price more than 1% from the reference price`): testnet's BTC mark
  sat 0.77% over its oracle, and the gate priced its closing order 0.3% over the mark. The gate now keeps that price
  under the oracle plus 0.9% (`stepCloseShort` in `services/keeper/src/hedge-steps.ts`). The other gates' orders,
  which sell 0.3% under the mark, were not changed.
- **`GET /api/keeper/:account`'s `running`** now means a tick in the last 4 minutes, since a tick is held while a check
  or a gateway run waits at OutLayer.

**Left as it is on testnet:** the pool's order is `lender_first` and its settlements are 2 minutes apart, for the
click-through and the video. The backend, the keeper and the stand-in were stopped after the gate. While the keeper is
off, our copy's BTC price isn't kept up to date; the keeper sets it right again on its first tick.

## 33. Stage 3: Aave through Chain Signatures. The shapes, fixed on 11 Nov before building

Stage 3 lets an account borrow on Aave's test market on Base Sepolia. FUNDING.md 4.5 says what and why; this section
fixes what the parts share. Where they differ, this section wins. Stage 4's two moves (`to_evm`, `e_home`) are not
part of it: the demo's WBTC comes from Aave's faucet, and borrowed USDC stays at the account's address on Base Sepolia.

**Decided by the user on 11 Nov:** the move rule counts the bitcoin's trip to the lender **and back** (section 30,
item 9). It is built with this stage, in the engine and the credit check's page.

**Settings.** New accounts get both lenders. `lenders.aave` on testnet is section 24's, with `max_fee_per_gas`
`"1000000000"` (1 gwei). The account's Ethereum address is its Hyperliquid address (`get_state().hl.address`): the
same Chain Signatures key and path.

**One signed transaction** (Ethereum type 2), built by the account in `evm.rs`:
- `chain_id` from the config; `nonce` from the account's own counter; value 0; an empty access list;
- `max_fee_per_gas` is the config's; `max_priority_fee_per_gas` is the smaller of 1,000,000 wei and that;
- `gas_limit` is a constant per kind, at most 500,000. So an address needs `gas_limit × max_fee_per_gas` of ETH held
  (at most 0.0005 ETH on testnet), of which a transaction spends a tiny part;
- `to` is the token (approve, transfer) or Aave's Pool; `data` is one of FUNDING.md 4.5's calls, and nothing else;
- the hash to sign is `keccak256(0x02 || rlp([chain_id, nonce, max_priority_fee, max_fee, gas_limit, to, 0, data, []]))`;
  the signer's `recovery_id` is `y_parity`.

**Methods:**

| Method | Who | What |
|---|---|---|
| `evm_approve(token)` | Anyone | Signs `approve(pool, max)` for the config's USDC or a collateral token. Once per token |
| `execute_step(pid, i)` | Anyone | Aave's `l_supply` and `l_borrow` in a funding plan, `l_add` and `l_repay` in a top-up plan, under the rules of the Rhea steps |
| `lender_repay("aave", amount)` | As for Rhea | Signs `repay` from the USDC at the address |
| `lender_withdraw("aave", token, amount)` | As for Rhea | Signs `withdraw(asset, amount, self)` |
| `evm_withdraw(token, amount, to)` | Owner, 1 yocto | Signs `transfer(to, amount)` of a config token. While the account owes our pool: a fresh verdict answering `evm_withdraw` with `allow.withdraw` equal to the amount |
| `evm_bump(nonce, max_fee, tip)` | Anyone | Signs the stored transaction of that nonce again with higher fees, never above the config's |

**Signing** reuses the Hyperliquid path: the signer's `sign` with the digest, then a callback that stores the finished
transaction in `evm.signed` (the newest 20, oldest first) and logs `evm_signed` with `{nonce, kind, hash}`. If the
signer fails, nothing is stored, the nonce isn't used, and a plan step reopens.

**`get_state().evm`:** `{"nonce": <the next nonce>, "signed": [{"nonce", "kind", "token", "amount", "to", "raw", "hash",
"step", "signed_at"}]}`. `kind` is `approve`, `supply`, `borrow`, `repay`, `withdraw` or `transfer`. `step` is
`"<pid>:<i>"` or null.

**A pending Aave action** (the stale-signature rule). A signed transaction never expires and anyone can send it. So a
signed `borrow`, a signed collateral `withdraw`, and a signed `transfer` while the pool is owed are listed in `pending`
from the moment they are signed:

`{"lender": {"lender": "aave", "kind": "borrow"|"withdraw", "amount": "…", "token": "0x…", "evm_nonce": 2}}`

- There is no `until_block`. It counts until a held verdict's `evm.nonce` is above `evm_nonce`: the chain has then
  used that nonce, whether the transaction went through or reverted. The account drops the entry when such a verdict
  arrives and bumps the counter.
- While it is listed, the account refuses what it refuses during Rhea's 20 blocks.
- The engine counts a listed borrow as debt at Aave with its USDC on its way, and a listed withdrawal as collateral
  gone, while the chain's nonce is at most `evm_nonce`. After that the chain's own reading is the truth.

**The verdict's `evm`:** `{"nonce": n}`, from `eth_getTransactionCount(address, "latest")`.

**The engine's book for Aave:** the position from Aave's own contracts (stage 1), plus what sits at the address: WBTC
(spare collateral, which `l_supply` and `l_add` post) and USDC (cash, which `l_repay` uses, and which counts as the
account's USDC). A `fund` answer with Aave is `l_supply`, `l_borrow`, `p_borrow`.

**Backend:**

| Endpoint | What |
|---|---|
| `POST /api/evm/submit` | Body `{account, nonce}`. Reads that entry of `evm.signed`, checks that the raw transaction hashes to `hash`, is for `EVM_CHAIN_ID`, and goes to Aave's Pool or a config token, then sends it with `eth_sendRawTransaction`. Answers `{hash, status}` with `sent`, `known` or `mined`. A node saying it knows the transaction already isn't an error |
| `POST /api/evm/gas` | Testnet only. Body `{account, mint?: {token, amount}}`. The gas wallet tops the account's address up to 0.002 ETH, a few times a day per account at most. With `mint`, it calls Aave's faucet `mint(token, address, amount)` for a config token. Answers `{address, eth: {balance, sent, hash}, mint: {hash, amount} or null}` |
| `GET /api/lender/:account` | Gains `evm: {address, nonce, chain_nonce, eth, wallet: [{token, symbol, decimals, amount}], signed: [{nonce, kind, token, amount, hash, status}]}`. `status` is `signed`, `sent`, `mined` or `failed` (mined and reverted). Aave's entry gets `held` like Rhea's |

**Keeper:** before the first supply or repay of a token it calls `evm_approve`. After each Aave step it sends the signed
transaction (through the backend's route, and by itself as a backup), waits for its receipt, asks for a check, and
only then runs the next step. The gate is `pnpm --filter @pb/keeper funding:demo -- --lender aave`.

**Gate 3** (FUNDING.md 10): an account borrows on Aave's test market through Chain Signatures; the engine reads the
position and the app shows it; it repays and withdraws.

**Changed the same day, after a live try (`research/aave.md`, last section but one):** Aave's test market has no
room for WBTC (its supply cap of 175 WBTC is full), so a supply of WBTC reverts. Wrapped test ETH works end to end.
- **`lenders.aave.collateral` on testnet lists both:** WBTC (`0x54114591963CF60EF3aA63bEfD6eC263D98145a4`, 8 decimals)
  and WETH (`0x4200000000000000000000000000000000000006`, 18 decimals).
- **The engine** treats WETH as its ETH token, priced by Aave's oracle as WBTC is. It also reads each collateral
  token's supply cap and what is supplied, and plans no `l_supply` or `l_add` of a token whose cap is full.
- **`POST /api/evm/gas`** also takes `wrap: {amount}`: the gas wallet wraps that much of its own test ETH and sends the
  WETH to the account's address (at most 0.02 ETH a day per account).
- **The gate** uses WBTC when the cap has room and WETH otherwise, and sends the WETH back to the gas wallet at the end.
- **Gas limits** from the live try (gas used: approve 46,584; supply 185,866; borrow 259,935; repay 162,260; withdraw
  173,127): approve and transfer 100,000; supply, repay and withdraw 300,000; borrow 400,000.

## 34. Stage 3 as built (11 Nov), before the deploy

Code and local tests only, plus one live round trip on Aave's test market with the gas wallet (section 33). Nothing of
stage 3 is deployed yet. The deploy sitting is `research/stage3_deploy.md`.

**Every suite passes on the joined code:** the engine 313 (298 after stage 2), the contracts 625 with the sandbox tests
(578), JavaScript 569 (498): keeper 167, backend 148, app 199, stand-in 44, its client 11. Builds and lint are clean,
`backtest examples` matches on 144 of 144 lines, and every saved fixture replays byte for byte.

**What gets deployed:**

| Build | Bytes | sha256 |
|---|---|---|
| Account | 511,105 | `fae0d5bd894957296d3c781fcfd165e0da2d84cd436a915335c6dd0919cd6836` |
| Factory (carries the account) | 743,483 | `317efd5a950bfe0dcc981fe48be5bcbcb250e86e0369fdbd653ad09fc14154c7` |
| `pb-risk` | 1,632,648 | `53cb13ba91403a0c72bf72fdfe76cccccad078f64a6d1e9d49a85361d6535767` |
| `pb-gateway` | 1,555,171 | `6bdc21f66476c14dfda7e94d9257b7ccc53e4621d4c518b763dba1d98226455b` |

The pool doesn't change. The factory's stored state doesn't change shape, so its upgrade is a plain redeploy with no
init call; `contracts/tests/tests/upgrade_stage3.rs` runs it over the live stage 2 factory's code and state.

**The account** (`contracts/account/src/evm.rs`, new; `lib.rs`, `lender.rs`):
- **Methods** as section 33, with these shapes: `evm_approve({token})` and `evm_bump({nonce, max_fee, tip})` with no
  deposit (`nonce` a JSON number, fees strings of wei); `evm_withdraw({token, amount, to})`, `lender_repay` and
  `lender_withdraw` for `"aave"` with 1 yocto. Each answers the kept entry, or null if nothing was signed.
- **Fees:** a first try offers half the config's `max_fee_per_gas` and a tip of the smaller of 1,000,000 wei and that.
  `evm_bump` takes any fee up to the config's limit, with both the fee and the tip at least a tenth above the kept
  transaction's, which is what a node asks of a replacement.
- **Gas limits:** approve and transfer 100,000; supply, repay and withdraw 300,000; borrow 400,000.
- **A full repayment** (an amount at or above the verdict's debt at Aave) is sent as the largest uint256, so no dust is
  left. It reverts unless the address holds the whole debt with its latest interest.
- **`get_state().evm`** also has `approved`: the tokens with a signed approval for Aave's Pool.
- **A pending Aave action** has a third kind, `transfer` (the owner's `evm_withdraw`), and a transfer is always listed,
  also when the pool is owed nothing. A listing is made before the signer is asked, and is dropped only when a verdict
  shows the chain has used its nonce, or when the signer's call itself failed. **The verdict that drops a listing is
  itself spent,** so the next step needs a second check. A signed transaction can't be cancelled: its nonce must be
  used, even by a transaction that reverts.
- **Checked against outside sources:** the selectors are recomputed from the signatures; the call data equals what
  Aave's test market accepted in `research/data/aave_spike_weth.json`; the signing hash, the raw transaction and its
  hash equal 14 transactions built and signed in Node (`contracts/account/evm-vectors.mjs`), byte for byte; in the
  sandbox the deployed contract asks the signer for exactly those hashes (`contracts/tests/tests/aave.rs`).
- **`MIN_DEPOSIT` stays 6 NEAR:** 0.85 NEAR is free after opening, 0.74 after a first Rhea loan, 0.83 after an Aave
  loan with three kept transactions.

**The engine:**
- **A pending Aave action** counts while the chain's nonce is at most its `evm_nonce`: a borrow as debt with its USDC
  on its way, a withdrawal as collateral gone from the cushion, a transfer as the token gone from the address and the
  book. It counts once per nonce, whether it is in `pending`, in `evm.signed` or both.
- **Aave is read in two requests:** `eth_blockNumber`, then one JSON-RPC batch of 18 calls pinned to that block. An
  endpoint that doesn't answer the batch with a full list gets the calls one by one. A check makes 45 requests for an
  account with both lenders.
- **Supply caps:** what sits at the address is spare collateral only as far as Aave's pool has room for it. A token
  whose pool is full is counted in the book, never planned, and named in words.
- **WETH** is the engine's ETH token, priced by Aave's oracle. A config that lists it makes every check price ether.
- **With both lenders,** a `fund` uses one: the cheapest with at least $1 of room. Each lender's room comes only from
  collateral on its own chain.
- **The move rule counts both trips** (the user's decision). `funding.lenders[].move` is
  `{cost_bp, cost, back_bp, back, back_quoted, total, saves, source}`; `used` goes by `total`. With no quote for the way
  back, it counts the same as the way there and `source` says so. Live on 11 Nov: $432 there, $221 back, $215 saved
  over 90 days, so our pool lent the whole line.

**The backend** (`services/api/src/evm-tx.ts`, `evm-handlers.ts`): `POST /api/evm/submit` (it also checks that the
raw transaction's signer is the account's address); `POST /api/evm/gas` with `mint` and `wrap`, limited per account
and per day, and for our factory's accounts only; `GET /api/evm/gas` (reads only: `{on, chain_id, gas_wallet,
balance, …}`); `evm` in `GET /api/lender/:account`, with `posted`, `chain_error`, `step` on each signed transaction,
and a fifth status, `replaced`; `collateral_room` on the testnet Aave row of `GET /api/lenders`.

**The keeper** (`services/keeper/src/evm.ts`): `evm_approve` before a token's first supply or repayment; after an Aave
step it sends the signed transaction through the backend's route and by itself as a backup, waits for it to be mined,
and asks for a check, and a second one when the first dropped a listing; one `evm_bump` to the fee limit after 3
minutes unmined. The gate is `funding:demo -- --lender aave`: it mints 0.015 WBTC when Aave's pool has room and wraps
0.02 ETH otherwise, mints 1 test USDC before the full repayment, and sends the collateral back to the gas wallet. (Its
book and its settlement check changed at the gate: section 35.)

**The app:** Aave's card and a card for the account's address on Base Sepolia; "Get test collateral for Aave"; each
Aave step shown as waiting, signed, sent and mined, with a link to the explorer; repaying and taking back at Aave,
sending a token out, "Get 1 test USDC for the interest"; the credit check's trip there, trip back and total. Preview
states: `/dev/home?state=aave|aave-bitcoin|aave-plan|three|funding|funding-pool|funding-noback`.

**Known gaps:**
1. Nothing of stage 3 has met a live chain except my own round trip with the gas wallet. The account's signing through
   the real signer, the relay and the gas helper are first tried at the gate.
2. The contract doesn't check that a signature recovers to its own address; the backend's relay does.
3. A frozen or paused Aave reserve isn't checked by the engine, and a supply within a hair of the cap can still revert.
4. In one earlier sandbox run two old account tests failed or hung; they passed in every run after. The cause wasn't
   found, and it looked like the sandbox node.
5. The app's new screens weren't looked at in dark mode or at phone width, and `evm_bump` has no button.

## 35. Stage 3 live on testnet, and gate 3 (11 Nov)

**Gate 3 passed on 11 Nov at 21:17 UTC** (`research/data/phase6_funding_aave.json`, account
`fund-aave-11112049.pbf.testnet`, 20:49 to 21:17). The script stopped twice on its own checks and was resumed on the
same account; the first stop's record is `research/data/phase6_funding_aave.stopped-at-fund.json`. The deploy steps are
`research/stage3_deploy.md`; the user approved each signed one.

**Deployed, each checked on chain:**
- **Test NEAR** from `pbf-ops.testnet`: 2 to the factory (tx `AsABRBhhgaLZTgpxCVXdJgfNKejVZ7UjtQJ6kva3DDbv`), 6 to the
  keeper (tx `GK8XodSuqme8fqeMpauPqPyijttAex4r4LjDWojbNjWs`).
- **`pb-risk` `53cb13ba…` and `pb-gateway` `6bdc21f6…`:** uploaded, fetched back from FastFS (200, right size and
  hash; the gateway's file answered 404 once, then 200) and added with `--no-activate`. `update_access`
  (tx `GVU39taYXZu5LTuwXYuCnXvcDf6frFkbLpYEvvgDF3os`) added the new gateway's hash to the seed's rule as a fourth. The
  new gateway answers `demo1.pbf.testnet`'s agent `0x68643293…d46a`; that run waited about 2 minutes in OutLayer's queue.
- **The factory:** a plain redeploy with no init call (tx `63aFPtqUVWEZo8mmfvgAjJscGESHJ2PfB4V5aFekaiNm`). Its code hash
  on chain is `4LDHg8DWtSdYs4Re1rXfhiP5L6rFqhgSBkJgbYLtfwLa`, which is the built file's `317efd5a…`;
  `account_code_hash` is `fae0d5bd…`; a snapshot before and after shows the config and the 7 accounts unchanged.
  `set_config` (tx `EmMDZ6ZNgQegDuM2sFyGFz5K5jZgLkNEyBTWTKstv4sz`) pinned both new programs and added `lenders.aave`:
  chain 84532, WBTC and WETH as collateral, a fee limit of 1 gwei. `lenders.rhea` stayed. The pool wasn't touched.
- **Backend and keeper** started from `.claude/launch.json`: the gas helper on, `collateral_room` showing no room for
  WBTC and room for 764 WETH.

**What the gate showed, on a fresh account:**
- **Opening:** `create_account` with 6 NEAR and the permission for both lenders in one signature. `hl_init` gave the
  address `0x5ebf298b5e84faf68d644b1b3987867c99fca794`, the same on Base Sepolia.
- **Collateral:** Aave's WBTC pool was full, so the gas helper sent the address 0.002 test ETH for gas and 0.02 test
  ETH wrapped as WETH.
- **The loan:** asked $2,000. On a book of $1,200 of test USDC and $41.56 of WETH the engine could lend $869.11:
  $23.03 from Aave at 0.74% a year and $846.08 from our pool at 2%. The client asked for 0.5% less, $864.68, and signed
  one `fund`. The keeper ran the plan: `evm_approve`, `l_supply` of the 0.02 WETH, a check once it was mined,
  `l_borrow` of $23.03, a check, then a fresh check and `p_borrow` of $841.65. Funded 174 s after the signature.
- **Chain Signatures:** the account built and signed seven Ethereum transactions through `v1.signer-prod.testnet`;
  the backend's relay sent each, and each was mined on Base Sepolia: approve WETH `0x1ef538de…2e08`, supply
  `0xba1e9d4a…fbab`, borrow `0xace3a04f…f19f`, approve USDC (nonce 3), repay `0xbd9cdf26…c76c`, withdraw
  `0x7196785d…da7d`, transfer `0x8fbb1655…9cc3`. No bump was needed.
- **The engine's verdict** showed the position: `ext` for Aave with `c` $41.56, `d` $23.03 and `hf_bp` 15335 (a
  cushion of 1.53; Aave's threshold for WETH is 85%).
- **A settlement:** the pool settled on a report with $23.03 owed to Aave at 0.74%. The account is on pass-through
  pricing, so nothing was added or taken off.
- **Leaving:** 1 test USDC from Aave's faucet for the interest; `lender_repay` cleared Aave ($23.033370 owed); the
  pool was repaid ($841.6497); `lender_withdraw` took the WETH back; `evm_withdraw` sent it to the gas wallet; the
  USDC was withdrawn ($1,199.999557: the pool's interest was $0.000443).
- **Checked on both chains afterwards, apart from the script:** Aave's `getUserAccountData` for the address shows $0
  posted and $0 owed; the pool's `debt_of` is 0; the account's loan is closed and it holds no test USDC.

**Found on the way, and what was done:**
- **The gate's book was too small.** The engine lends nothing to an account worth under $1,000 (RISK_ENGINE.md, C0;
  `min_equity_for_credit`), and the gate's account held $481.61: the small plan's $440 and the WETH. The first run
  stopped at `fund` with nothing signed. The gate now deposits $1,200 (`AAVE_DEPOSIT_USDC_MICRO`); its deposit step
  adds only what the account is short of; a resumed run whose record deposited less runs that step again.
- **The gate's own pre-check stopped the resume:** it asked the gas wallet for enough to wrap a second 0.02 ETH
  (0.0321), and the wallet held 0.028. A run that goes on with its account now needs the wallet's reserve and a top-up
  (0.0121).
- **The gate's settlement step read the wrong answer.** The account's `settle()` answers `true` whatever the pool
  did. The step read that answer, saw no settlement in it, and tried four times while the pool settled each time. It
  now reads the pool's `get_pricing`: a later `settled_at`, on a report with Aave's loan in it (`aaveSettlement` in
  `services/keeper/src/aave-kit.ts`). The test's made-up account now answers `true` too.
- Suites after it: keeper 168 (one more), JavaScript 570 in all. No contract or engine code changed.

**Seen and left as it is:**
1. **Taking "all" back from Aave leaves dust.** The gate asked for the amount it had read, and the interest earned
   until the transaction was mined (0.00000000012 WETH) stayed at Aave. Sending the largest uint256, as the full
   repayment does, would clear it.
2. **The account still lists its last transfer** (nonce 6) until a verdict shows the chain's nonce at 7. That is the
   rule of section 33; the gate asked for no check after it.
3. **The app's Aave screens have met no live backend and no real wallet.** Gate 3's "the app shows it" rests on the
   backend's `GET /api/lender/:account`, which the app reads and the gate checked. The click-through is where the
   screens are first seen live.
4. **The pool's `lent_24h` reads below zero** (-647 micro-USD): repayments with interest come off it. For the
   security pass.
5. **At the gate's address** 0.999994 test USDC and 0.00199 test ETH remain, and its NEAR account keeps 5.98 NEAR.

**Left as it is on testnet:** the factory's config has both lenders, so every new account can use Rhea and Aave. The
pool is as stage 2 left it (`lender_first`, settlements 2 minutes apart). The backend and the keeper were stopped
after the gate. The gas wallet got its 0.02 WETH back and unwrapped it (`scripts/aave-spike.mjs --unwrap --send`,
`0xf9a80353…e453`): it holds 0.048 test ETH, enough for one more run on the wrapped path (0.0321), not two. After the
gate: `pbf-ops.testnet` 17.18 NEAR, the keeper 6.74, the factory 2.58 free.

## 36. Stage 4: the moves between NEAR and Aave's chain. The shapes, fixed on 11 Nov before building

FUNDING.md 6.4, 9 and 16 say how stage 4 runs on testnet: **the client starts each move,** the way they move USDC to
Hyperliquid today, because the engine can't reach our 1Click stand-in from inside the enclave. This section fixes what
the parts share. Where it differs from FUNDING.md, this section wins.

**What is and isn't built:**
- **Built:** four moves through the stand-in, each started by the owner's own call and recorded as a transfer
  `move:<n>`; the engine counting them in transit and saying when one has arrived; the gate.
- **Not built:** the funding plan's `to_evm` and `e_home` steps. `execute_step` keeps answering that the account
  can't run them yet. They are the mainnet path, where the engine plans a move with 1Click's own quote.

**The four moves:**

| Move | From | To | Started with | Lands |
|---|---|---|---|---|
| `to_evm`, collateral | nBTC in the account on NEAR | The account's own address on Aave's chain, as WBTC; as WETH of the same dollar value when Aave's WBTC pool has no room (testnet only) | `withdraw` with `transfer` | At the address. A verdict's `arrived` settles it |
| `to_evm`, USDC | USDC in the account on NEAR | The address, as USDC: the way to repay Aave once the loan has come home | `withdraw` with `transfer` | The same |
| `e_home`, the loan | USDC at the address | The account on NEAR, as USDC | `evm_withdraw` with `exp` | `ft_on_transfer` with the transfer's msg settles it, as for `home` |
| `e_home`, collateral | WBTC or WETH at the address | The account on NEAR, as nBTC | `evm_withdraw` with `exp` | The same |

**The account contract:**
- **`TransferKind` gains `to_evm` and `e_home`.**
- **`withdraw(token, amount, receiver, transfer)`** takes `transfer: {"kind": "to_evm", "exp": <ms>}`.
  - `token` is any allow-listed token of the account, USDC included.
  - It needs `lenders.aave` in the account's config and its address (`hl.address`): without either it is refused in
    words.
  - Everything else is `withdraw` as it is: no verdict without a loan from our pool; with one, a verdict for a
    withdrawal of this token and amount. The move is recorded as `move:<n>` with the token's id, and dropped if the
    tokens don't go out.
- **`evm_withdraw(token, amount, to, exp)`** gains `exp` (optional, unix ms): the expiry of the 1Click quote whose
  deposit address is `to`.
  - With `exp`, the move is recorded as `move:<n>`, kind `e_home`, `dep` the address in lowercase, and `token`
    `"USDC"` for the Aave settings' USDC (the name `home` already uses) or the token's `0x` address in lowercase for
    collateral. It is dropped again if the signature fails.
  - Its other rules don't change: the owner only, a verdict (`{"evm_withdraw": {token, amount}}`) while the account
    owes our pool, and the signed transfer listed as under way until a verdict shows the chain used its nonce.
  - Without `exp` it is today's call.
- **`ft_on_transfer`** already settles a transfer named in the msg `{"pb":{"transfer":"move:<n>"}}`: `refunded` when
  the token that comes is the one that was sent, `arrived` otherwise. Nothing changes there.
- **The factory** carries the new account code. Its config and its stored state don't change shape.
- **As built (11 Nov, contracts 642 tests):**
  - Refusals of a `to_evm`: "this account has no settings for aave", "no Ethereum address yet: call hl_init first".
    `withdraw` with `{"kind":"e_home"}` answers "an e_home move is evm_withdraw's".
  - The record is `{"transfer":{"id":"move:<n>","kind","token","amount","dep","deadline"}}` in `get_state().pending`,
    as for the other kinds.
  - An `e_home` whose transaction isn't signed drops its transfer, whether the signer failed or its answer couldn't
    be read (log: "transfer move:n didn't go out: nothing was sent"). In the second case the Aave `transfer` listing
    stays, as in stage 3. If the signer's callback never comes, the transfer stays, goes overdue, and the owner
    clears it with `forget_transfer`.
  - An `e_home` that 1Click refunds on Aave's chain sends nothing to NEAR, so nothing settles it: it goes overdue
    and is forgotten the same way. `evm_bump` leaves a transfer alone.
  - `TransferKind`'s first three kinds keep their stored values. Only accounts store transfers, so no live state
    holds an old layout.
  - Sizes: account 512,616 B (`94ceb936…`), factory 744,992 B (`ce6fcd5a…`), the pool unchanged. The factory is a
    plain redeploy with no init call, proved over the live stage 3 factory (`contracts/tests/tests/upgrade_stage4.rs`
    on `contracts/target/live-stage3/`): it locks about 0.015 NEAR more. 6 NEAR still opens an account, with 0.84
    free afterwards.

**The engine** (`pb-read`, and so both programs are built again):
- **In transit.** A pending `to_evm` counts as the token sent; a pending `e_home` as USDC, or as the collateral's
  coin (WBTC as BTC, WETH as ETH). Both follow today's rule for money in transit: 98% for the state, 0 for credit,
  nothing once overdue.
- **`arrived` for a `to_evm`.** The account can't see Aave's chain, so the verdict says so. A `to_evm` has arrived
  when the address holds enough of what it was to bring, at the engine's prices: at least 80% of the dollar value
  sent. Collateral counts in the wallet and posted at Aave; USDC counts in the wallet. Each dollar at the address
  answers for one transfer, earliest deadline first.
  - **Why 80% and not 95%:** on testnet the WBTC may arrive as WETH, and Aave's test oracle isn't the price the
    stand-in quoted at.
  - **A wrong "arrived" is safe:** the transfer stops counting in transit and the tokens count only where they are,
    which is less. A refund that comes later names no transfer under way, and the account keeps it as a deposit.
  - **USDC must be settled before it is spent:** USDC that arrives and repays Aave before any check never shows at
    the address. The transfer then goes overdue, and the owner drops it with `forget_transfer`. The keeper and the
    app ask for a check when the stand-in says the transfer is delivered.
- **An `e_home` needs no `arrived`:** the delivery on NEAR settles it. While its Ethereum transfer isn't mined, the
  listed `transfer` (section 33) takes the token off the address; the 1Click transfer puts it in transit. The two
  never count the same money twice.
- **Nothing else changes:** the `fund` split, the cushion rule and the verdict's fields are stage 3's.
- **As built (11 Nov, engine 319 tests):**
  - Both sides of the 80% test use the engine's reference prices, not Aave's oracle. A transfer takes its whole
    value off what is left at the address, arrived or not. What was at the address before the move counts too.
  - If Aave's chain can't be read there is no verdict at all (an unreadable lender was already fatal), so nothing
    is marked arrived.
  - A delivery under 80% of what was sent counts at the address, and the transfer still counts in transit, for the
    state only, until its deadline.
  - New words in `top`: `overdue: to_evm transfer move:1`, `overdue: e_home transfer move:2`. A new refusal:
    `pending transfer move:9 is of 0x…, a token the account's Aave settings don't list`.
  - **While our pool is owed, a move needs room on the credit line,** because money in transit counts 0 for credit.
    On the gate's book (a line of about $768, $23 owed at Aave) both moves are allowed with $700 owed to our pool
    and refused with $740. This holds for USDC going back to repay Aave too: the verdict can't know what it is for.
  - A check makes the same requests as in stage 3: 41 with Aave alone, 45 with both lenders.

**The stand-in** (`services/oneclick-shim`) gains a third chain, Base Sepolia:
- **Assets:** the test WBTC, WETH and USDC of the factory's Aave settings, beside mUSDC, mNBTC and Hyperliquid's
  USDC. Their ids and the mainnet assets they are priced as are looked up in 1Click's own token list, never guessed.
- **Its float there is the gas wallet** (`EVM_GAS_PRIVATE_KEY`; the user can't easily get more test ETH, so there is
  one wallet). The backend's gas helper uses the same key from another process: both read the pending nonce right
  before signing and try again when the node says the nonce is taken.
- **Deposits on Base Sepolia** all go to the float's address. A deposit is the oldest unused transfer of the quote's
  token from the quote's sender (its `refundTo`) for exactly `amountIn`, as on Hyperliquid.
- **Deliveries on Base Sepolia:** a token transfer from the float. WETH is wrapped from the float's test ETH as
  needed, and unwrapped when it comes back, so the test ETH goes round. Test USDC and WBTC come from Aave's faucet
  when the float is short.
- **Which token for bitcoin:** WBTC when Aave's supply cap has room for the amount, WETH of the same dollar value
  otherwise. The quote says which and why. The way home turns either back into mNBTC.
- **Sizes:** the float holds about 0.048 test ETH, so one move brings at most 0.02 WETH (about $40).
- **Deliveries on NEAR** carry the quote's `customRecipientMsg`, as for `home`.
- **As built (11 Nov, stand-in 54 tests):**
  - Asset ids are `1cs_v1:base-sepolia:erc20:<address>`. WBTC is priced as cbBTC on Base (1Click lists no WBTC
    there), WETH and USDC as themselves. WETH's dollar value comes from the prices in 1Click's token list, because
    1Click prices no nBTC/WETH route.
  - When the token is changed, the quote and the status carry `shim: {asked, delivers, symbol, why}`.
  - A quote the float can't fill is refused with HTTP 400 in words, dry or not: more than 0.02 WETH in one move
    (the words give the most nBTC that fits), or a float that couldn't wrap it and keep 0.003 ETH for gas.
  - Deposits on Base Sepolia carry `depositMemo` (the swap's id) and are found by reading logs from the quote's
    block, 200 blocks a call: the public RPC allows no more.
  - Every send reads the pending nonce right before signing and tries again, four times, when the node says the
    nonce is taken. The backend's gas helper does the same.
  - Aave's faucet gives at most 1 WBTC or 1,000,000 USDC a call.
  - It reads `EVM_RPC_URL`, `EVM_CHAIN_ID`, `EVM_GAS_PRIVATE_KEY`, `AAVE_FAUCET_ADDRESS`,
    `AAVE_DATA_PROVIDER_ADDRESS` and `FACTORY_ACCOUNT_ID`: no new setting name. It must start after the factory
    has Aave settings, or it knows no Base Sepolia token.

**The backend:** `POST /api/quote` takes `move: "to_evm" | "e_home"` beside `to_hl` and `home`, with the same body
and one more field, `token`:

```json
{"dry": false, "move": "to_evm", "account": "a.pbf.testnet", "token": "mnbtc.pbf-ops.testnet", "amount": "55000"}
{"dry": false, "move": "e_home", "account": "a.pbf.testnet", "token": "0xba50…4d5f", "amount": "23033364"}
```

- `token` is the token that leaves: a NEAR token id for `to_evm` (default the nBTC token), an address on Aave's chain
  for `e_home` (default Aave's USDC). `amount` is in that token's own units.
- The backend reads the account's address and its Aave settings from the chain, so the browser names neither.
- The answer is today's, with `move.next` the account's next call:
  - `{"method":"withdraw","args":{"token","amount","receiver":<deposit address>,"transfer":{"kind":"to_evm","exp":<ms>}}}`
  - `{"method":"evm_withdraw","args":{"token","amount","to":<deposit address>,"exp":<ms>}}`
- `move` also gains `delivers: {"token", "symbol", "chain", "amount"}` (what arrives and where), and
  `needs_check`: the intent to ask a check for first while the account owes our pool, or null.
- Refusals in words: no address yet (409 `no_hl_address`), no Aave settings (409 `no_aave`).
- **As built (11 Nov, backend 154 tests):** `delivers.chain` is `"Base Sepolia"` or `"NEAR"`, and `delivers` is
  read from the quote's own destination, so it says WETH when the stand-in changed the token. `next` is null on a
  dry quote. The answer keeps the stand-in's `shim` and the quote's `amountInUsd` and `amountOutUsd`. Also 400 for
  a token that isn't the account's, and 502 `bad_quote` for a deposit address that is no address on Base.
- **`GET /api/status` also takes `account` and `transfer`** (`move:<n>`) in place of `depositAddress`: the status
  of a move this backend gave the committed quote for, found in its own record of those quotes (in memory, the
  newest for each account and transfer id, at most 2,000). 404 `unknown_move` when it has none. This is how a move
  home, which only its memo tells apart, can be followed from another browser. The app doesn't use it yet.

**The keeper:** it sends a signed `e_home` transfer like any signed transaction; it logs a pending `to_evm` and
`e_home` as it logs the other transfers; it asks for a check when the stand-in says a `to_evm` is delivered. It runs
no move itself.

**The gate** is `pnpm --filter @pb/keeper funding:demo -- --lender aave --moves`, with its record in
`research/data/phase6_funding_moves.json`. It passes FUNDING.md 10's gate 4 when:
1. a fresh account holds only test nBTC (worth $1,000 or more: the engine lends nothing under that);
2. it moves a part of it to Base Sepolia through the stand-in, and a verdict settles the transfer;
3. one `fund` borrows on Aave against what arrived (and from our pool, if the engine gives a part);
4. the borrowed USDC arrives in the account on NEAR through the stand-in.

Then it leaves the way a client would: USDC back to Aave's chain, Aave repaid, our pool repaid, the collateral back
from Aave and home to NEAR as nBTC, and everything withdrawn.

**The gate as built (11 Nov, keeper 175 tests):**
- Steps: `create, deposit, hl_init, keeper, gas, btc_out, arrived, fund, funded, loan_home, usdc_out,
  usdc_arrived, repay_aave, repay, aave_withdraw, btc_home, withdraw, float`. The pass point is `loan_home`; the
  record has `pass_point` beside `pass`. Options: `--dry-run`, `--name`, `--from`, `--fund-wait`.
- The book is 0.02 test nBTC (about $1,500) and nothing else. The permission names Aave alone: with Rhea
  permitted, the engine could lend against the nBTC still on NEAR.
- `btc_out` sends the nBTC that brings 0.0195 WETH (about 0.00055 nBTC), or 0.015 nBTC as WBTC if Aave has room.
- `fund` asks for Aave's part and at most $100 of our pool's, so the moves that follow have room on the line.
- A check that brings no verdict is asked again a minute later, three times, with each reason in the record.
- `float` records what the float holds before and after, and fails if the run used more than 0.007 test ETH.
- The dry run also compares what was built here with what the factory has: its account code and the two
  programs it pins. A deploy that isn't finished stops a fresh run before it opens an account.

**The app:** on testnet, "Move bitcoin to Aave's chain", "Bring the loan home", "Send USDC to Aave's chain" (before
repaying Aave from NEAR) and "Bring the bitcoin home". Each shows the quote, what arrives and where, and the pending
transfer until it settles.

## 37. Stage 4 as built (11 Nov), before the deploy

Nothing of stage 4 is deployed. Section 36 has the shapes and each part's as-built notes; this is the join.

**Suites on the joined code:** engine 319, contracts 642, JavaScript 610 (keeper 175, backend 154, stand-in 54, its
client 12, app 215). `pnpm -r build` and the app's lint are clean. `backtest examples` says 144 of 144, and the
fixtures replay byte for byte.

**To deploy:**

| What | Size | sha256 |
|---|---|---|
| Account | 512,616 B | `94ceb936a349f9eb587d10214a152097ff2fefc33752a5a51c7e902ebc92e59d` |
| Factory (a plain redeploy, no init call) | 744,992 B | `ce6fcd5ac83087c6a5ccd4560ba8920f265ba12c11e4afba215ab5e8c43024b5` |
| `pb-risk` | 1,642,985 B | `0de5d85d151109a0eeca188ab9d2d3acaf014c7d0dab366ba7a7d2ce808f3c17` |
| `pb-gateway` | 1,565,895 B | `06dc7787e8fc5db00747588e21c6e704c13e5055dc14f2fb2c20c5dd4db426c1` |

The pool is unchanged (`c4641c0e…`). The factory's config keeps its shape: only the two pinned programs change.

**Checked live, reading only (11 Nov, 22:45 UTC),** with the stage 4 stand-in and backend started against testnet and
the stage 3 account `fund-aave-11112049.pbf.testnet`:

| Dry quote | Answer |
|---|---|
| 0.00055 nBTC to Aave's chain | 0.01974 WETH ($40.73 in, $40.65 out), with the reason: Aave's test market has room for 0 more WBTC |
| 0.001 nBTC | Refused: it would arrive as 0.0359 WETH, and one move brings at most 0.02; send at most 0.00055719 nBTC |
| $24 of USDC to Aave's chain | $23.99 |
| $23 of USDC home | $22.997 |
| 0.0195 WETH home | 0.00054082 nBTC |
| An account from before stage 3 | Refused, 409 `no_aave` |

The gate's dry run then listed what stood in its way, rightly: the keeper not running, and the factory still
carrying stage 3's account code and programs.

**Not built, or not proved:**
1. **The funding plan's own `to_evm` and `e_home` steps** aren't built. The client starts each move.
2. **Nothing of stage 4 has sent a transaction.** The float's sends, the deposits found on Base Sepolia, the faucet
   mints, the wrap and the unwrap are proved against made-up chains only. The gate's made-up account answers as the
   contract's source reads.
3. **USDC that arrives and is spent before a check** leaves its transfer to go overdue; the owner then drops it.
   The app says to check first and doesn't stop the client.
4. **An `e_home` that 1Click refunds on Aave's chain** is settled by nothing until it is overdue and dropped.
5. **A move home shows its status only in the browser that started it.** The backend's `GET /api/status` with
   `account` and `transfer` would fix that; the app doesn't call it yet.
6. **The gas wallet is also the stand-in's float,** used by two processes. Both try again when a nonce is taken.
7. **The app's new screens** have met no live backend, and weren't looked at in dark mode or at phone width.
8. **The gate leaves** about 1 test USDC and 0.002 test ETH at its account's address.

## 38. Stage 4 live on testnet, and gate 4 (12 Nov)

**Gate 4 passed on 12 Nov at 08:42 UTC** (`research/data/phase6_funding_moves.json`, account
`fund-move-11120836.pbf.testnet`, 08:36:06 to 08:46:21). It passed on its first run: no step failed and no check was
asked twice. The pass point, `loan_home`, ended at 08:42:27; the leaving steps after it all went through too, so the
record's `pass` is true. The deploy steps are `research/stage4_deploy.md`; the user approved each signed one.

**Deployed, each checked on chain:**
- **Test NEAR:** 6 from `pbf-ops.testnet` to the keeper (tx `Aadt9wHts2aQydj2JxHuaLJ1iZGUw2oSyJPk6jqFTR7M`).
- **`pb-risk` `0de5d85d…` and `pb-gateway` `06dc7787…`:** uploaded, fetched back from FastFS (200 at the first try,
  right size and hash) and added with `--no-activate`. `update_access`
  (tx `Hi13G4GaKjAQpFioaXvaWDHj2ukjR9MWfp1God5mkSDi`) added the new gateway's hash to the seed's rule as a fifth. The
  new gateway answers `demo1.pbf.testnet`'s agent `0x68643293…d46a`, and the new engine runs; OutLayer's queue was
  short (both answered in under a minute).
- **The factory:** a plain redeploy with no init call (tx `Ep5zL7iKSUgZiwakaEz7x6DAbS4QiZvPqX5Th47VtNzf`). Its code
  on chain is the built file byte for byte (`ce6fcd5a…`, code hash `Etqs7yQ7gQXzs7RUXJD2FqJC8NWmtJyQ6fkdVxAxW9Ki`);
  `account_code_hash` is `94ceb936…`; a snapshot before and after shows the config and the 8 accounts unchanged.
  `set_config` (tx `6yUhAcWxonNKxzydxJeypJFLFPpsRFcNYEjQR46WjMUN`) changed two fields only: `risk.version_key` and
  `gateway.version_key`. The pool wasn't touched.
- **Stand-in, backend and keeper** started from `.claude/launch.json`. The stand-in named its Base Sepolia float (the
  gas wallet) and USDC, WBTC, WETH; the gate's dry run found the factory's account code and both pinned programs to
  be the ones built here.

**What the gate showed, on a fresh account holding only 0.02 test nBTC** (about $1,496; the engine valued the book at
$1,470.67):

| Move | Sent | Arrived | Took |
|---|---|---|---|
| Bitcoin to Aave's chain (`to_evm`, `move:0`) | 0.00054436 nBTC | 0.019503177 WETH at the address | 42 s |
| The loan home (`e_home`, `move:1`) | $22.067140 USDC from the address | $22.062977 in the account on NEAR | 83 s, with its check |
| USDC to Aave's chain (`to_evm`, `move:2`) | $23.067142 from the account | $23.061973 at the address | 58 s, with its check |
| Bitcoin home (`e_home`, `move:3`) | 0.01950318 WETH from the address | 0.00054232 nBTC in the account | 58 s |

- **Opening:** `create_account` with 6 NEAR and the permission for Aave alone, in one signature. `hl_init` gave the
  address `0x59546a220f43f6d46ecd7a393fc15c2d5af683f2`. The gas helper sent it 0.002 test ETH.
- **Bitcoin out:** Aave's WBTC pool was still full, so the stand-in said so in its quote and delivered WETH of the same
  dollar value, wrapping its own test ETH (NEAR tx `2ALQNVTvc1y8gcn491gwW4TbWewnmkSJY3cYU2y2DyE2`, delivery
  `0x06c00f2d…accb`). The next check's verdict listed `arrived: ["move:0"]` and the account dropped the transfer.
- **The loan:** asked $2,000. The engine could lend $735.29: $22.07 from Aave at 0.74% a year and $713.23 from our
  pool at 5%. The gate took Aave's part and $99.38 of the pool's (a move needs room on the credit line while the pool
  is owed) and signed one `fund` of $121.44. The keeper ran the plan: `evm_approve`, `l_supply` of the WETH, a check,
  `l_borrow` of $22.07, a check, a fresh check and `p_borrow`. Funded 153 s after the signature. The verdict's `ext`
  for Aave: `c` $39.88, `d` $22.07, `hf_bp` 15361 (a cushion of 1.54).
- **The loan home (the pass point):** the quote named the check to ask first; its verdict allowed an `evm_withdraw`
  of $22.067140. The account signed the transfer with the quote's expiry (tx
  `9ziZcrBARf8w969E5dRGW1tRP9XNknXjeBwk5G8tow2C`, Ethereum `0xfb5b5da5…57e8`), the stand-in found the deposit in Base
  Sepolia's logs and delivered on NEAR (`46VAzu3P1rXMcen1zxKF9B2gTwcap8BhCnzkz2WdxFgA`), and the account's `ft_on_transfer`
  settled `move:1`. The account then held $121.44 of USDC on NEAR.
- **Leaving:** $23.07 went back to the address (Aave's debt and 1 USDC over); a check settled `move:2`;
  `lender_repay` cleared Aave (`0xc58adcbb…26d1`); the pool's $99.377551 was repaid, the client adding $2.10;
  `lender_withdraw` took the WETH back (`0xeb1b4053…68a5`); the WETH went home as nBTC (`0x5f4718ab…ebdb`, delivery
  `8gicYfmnZSrTwZ2dkqkrhqAiV5juZta5EDbn8cFN2sQs`); the float unwrapped what came back (`0x8184933f…c867`); both
  tokens were withdrawn with no verdict.
- **Chain Signatures:** eight Ethereum transactions signed by the account through `v1.signer-prod.testnet` (nonces 0
  to 7: approve, supply, borrow, approve USDC, transfer, repay, withdraw, transfer), each mined, no bump.
- **What the round trip cost the client:** 0.00000204 nBTC (about $0.15, 1Click's prices both ways) and $1.00 of
  USDC, of which $0.99 is the over-send still at the address and under $0.01 is fees and interest.
- **Test ETH:** the float held 0.047992 before and 0.045991 after: the run used 0.002001, nearly all of it the gas
  sent to the account's address. The 0.0195 wrapped at `btc_out` came back at `btc_home`.
- **Checked on both chains afterwards, apart from the script:** Aave's `getUserAccountData` for the address shows
  $0.00000023 posted and $0 owed; the pool's `debt_of` is 0; the account's loan is closed and it holds neither test
  token; the float holds no WETH.

**Seen and left as it is:**
1. **The stand-in's faucet mint has sent no transaction.** The float paid the USDC of `move:2` from what it held (its
   own 1 test USDC and the loan that had just come in). It now holds $0.005, so the next USDC move to Aave's chain
   will mint. The node ran that mint without sending it (12 Nov, 08:50): the faucet would give 1, 25 or 1,000 USDC.
   The same call was sent for real by `scripts/aave-spike.mjs` in stage 0 and by the backend's gas helper in stage 3.
2. **Aave's faucet gives one address one token once an hour.** Two USDC moves out inside an hour, each short, would
   see the second refused at its quote, in words.
3. **The account still lists its last Ethereum transfer** (nonce 7) until a verdict shows the chain's nonce at 8, as
   in section 35.
4. **Dust:** 0.000000000116 WETH stays posted at Aave; $0.994831 of test USDC and 0.00199 test ETH stay at the gate's
   address; its NEAR account keeps 5.97 NEAR.
5. **The app's move screens have still met no live backend and no real wallet.** The gate drove the backend's routes
   the app calls (`POST /api/quote` with `move`, `POST /api/evm/submit`, `GET /api/status`).
6. **The pool's `lent_24h`** reads -682 micro-USD now. For the security pass.

**Left as it is on testnet:** every new account has the stage 4 code and can make moves; accounts from before keep
theirs (an account from stage 3 can borrow at Aave and can't make a move). The backend, the keeper and the stand-in
were stopped after the gate. The float: 0.04599 test ETH (a run needs 0.0252 in it and uses 0.002), 0.01 test WBTC,
$0.005 test USDC. After the gate: `pbf-ops.testnet` 11.18 NEAR, the keeper 6.63, the factory 2.57 free.

## 39. The second audit pass (12 Nov)

`research/audit.md` has a second part, "Second pass: the Phase 6 code": the checklist over everything written since
9 Nov, by three readers working apart, with each finding then checked against the code. Nothing is fixed yet.

- **Two High, both in the account:** A7 (an owner can record money "on its way" that isn't, with any expiry, and the
  engine counts it at 98% toward the state) and A8 (`set_permission` moves the counter with no verdict, so an owner
  can make every check arrive stale). Neither makes a loan larger; both can switch off the margin call and the unwind.
- **Three Medium:** A9 (dust repayments at Aave hold the signing slot), P3 (a settlement's fee has no upper bound),
  P4 (a subsidy or a fee on lender debt that wasn't there).
- **Ten Low and five Info,** with what was checked and found sound per contract, and what fixing would take.
- Also checked: the code on chain is the code built here (pool, factory, a new account); access keys; no secret
  value from `.env` is in any other file.


## 40. The fixes after the second audit pass. The shapes, fixed on 12 Nov before building

The user said "Fix both now" on 12 Nov: the two High findings of `research/audit.md`'s second pass (A7, A8), A9, and
five small ones in the same redeploy (A12 in part, A14, X2, F2, and the keeper's part of P4). The pool isn't touched:
P3, P5 and the account's part of P4 stay open. Every fix lands with a test that fails on the code as deployed on
12 Nov. Account fixes reach new accounts only (A6).

### 40.1 Account (`contracts/account`)

1. **A7, the 24-hour limit.** `MAX_QUOTE_LIFE_MS` = 24 hours. A transfer is recorded only if its `exp` is at most
   that far after the block's time.
   - **The owner's moves** (`new_move`: `withdraw` with `transfer`, `hl_withdraw` with `exp`, `evm_withdraw` with
     `exp`) are refused with "exp is more than 24 hours ahead: a 1Click quote lives a day at most".
   - **A plan step's transfer** (`sell`, `to_hl`, `home`) is refused the same way before anything is sent: "the
     step's quote expires more than 24 hours ahead". The engine never makes one; this holds if it is wrong.
2. **A8, the permission and the counter.** `set_permission` no longer moves the counter.
   - **New stored field, the last:** `permission_blk: u64`, the block height of the last `set_permission`, or of
     `new` when a permission came with it; 0 if none was ever set.
   - **`fund`** refuses a held verdict whose `blk` is not above it: "the check was read before the permission last
     changed (block N): ask for a new check".
   - **Every step that adds to a lender position on the held verdict** (`l_borrow`, `l_add`, and `l_supply` where
     it reads one) refuses it the same way.
   - **A top-up plan's `l_repay` still repays** on such a verdict and skips only its settlement: repaying never
     stops (decided on 12 Nov, after the first build refused it).
   - **`get_state()`** gains `"permission_blk": <number>` (a block height, far below 2^53).
   - The `permission_set` event and every other rule of `set_permission` stay.
3. **A9, a stranger's repayment at Aave.** For a caller who isn't the owner, with lender `aave`:
   - the amount must be at least the debt the held verdict shows, and the call then says "all of it"; a smaller
     amount is refused: "anyone but the owner repays all of Aave's debt (N) or nothing";
   - it is refused while a kept signed `repay` has a nonce the held verdict hasn't seen used (the verdict's
     `evm.nonce` is at or below it, or the verdict has no `evm`): "a repayment at Aave is signed and not mined yet
     (nonce N): send it, then ask for a check".
   - The owner's own calls, Rhea, and the plan's `l_repay` step are unchanged.
4. **A12, in part: what settles a transfer that leaves NEAR for good.** A `to_hl` or `to_evm` transfer is never
   delivered to the account on NEAR: a verdict's `arrived` settles it. So a deposit with its msg settles it only as
   a refund: the token it sent, at least 80% of its amount. Anything else with its msg is kept as a plain deposit
   and the record stays ("kept as a deposit: not a refund of transfer <id>"). `sell`, `home` and `e_home` settle as
   before: their delivery arrives in another token, and the record holds no floor for it. That part of A12 stays
   open.
5. **A14, Aave listings.** `MAX_AAVE_LISTINGS` = 8. A ninth borrow, withdrawal or transfer on Aave's chain is refused
   until a check drops one: "8 Ethereum transactions are listed already: send them, then ask for a check". The
   callbacks' gas isn't changed.

### 40.2 Shared types and factory

6. **X2.** `Config::assert_valid`: each Rhea collateral token has at most 18 decimals ("lenders.rhea.collateral
   tokens have at most 18 decimals").
7. **F2.** `on_created`'s static gas is 30 TGas plus 10 TGas for each call it makes (the pool's `register`, one
   `storage_deposit` per token, `on_registered`): 70 with today's 2 tokens, as before, and 130 with 8.
   `create_account` refuses less than 110 TGas more than that (180 today), and its message says the figure. Callers
   attach 300 TGas, as they do now.

### 40.3 Engine (`risk/pb-read`)

8. **A7, the owner's own moves.** In `transit()`, a pending transfer whose id starts with `move:` isn't put in
   flight. It counts nothing toward the state, nothing toward credit (as before), and nothing as margin on its way
   to Hyperliquid for a REBALANCE.
   - Everything else about it stays: it is still matched for `arrived` (a `to_hl` credit, a `to_evm` arrival), still
     in the verdict's transfer ids, still reported overdue after its deadline.
   - A plan step's transfer (`<pid>:<i>`) counts at 98% toward the state, as before.
   - `risk-core` and its fixtures don't change. RISK_ENGINE.md 3.4 gains the rule.
   - **Why it costs an honest owner nothing they were promised:** with a loan open, the withdrawal behind a move
     needed a verdict that allowed the money to leave for good. With no loan, the state isn't used.
9. The reader accepts `get_state()`'s new `permission_blk` and ignores it.

### 40.4 Keeper, backend and gates (`services`)

10. **P4, the keeper's part.** After a check, when the pool's `get_pricing(account).last` shows a lender line with
    debt above 0 and the verdict's `ext` shows none owed at that lender, the keeper settles once. The pool then
    holds a report of zero, so it doesn't repeat.
11. **A8.** Nothing may wait for, or rely on, `set_permission` moving the counter. A step that changes the
    permission asks for a new check before `fund`. Types gain `permission_blk`.
12. **A7.** The keeper logs `move_far` for any transfer whose deadline is more than 24.5 hours ahead: an account
    made before this fix can still hold one.
13. The gates' own calls must pass the new rules: a quote's `exp` within a day, a stranger never repaying Aave in
    part.

### 40.5 Web app (`web`)

14. **A8.** A held verdict whose `blk` is not above `permission_blk` can't back `fund`: the app asks for a new check,
    as it does when the counter has moved. Types gain `permission_blk`.
15. **A7.** The app refuses to build a move whose `exp` is more than 24 hours ahead.

### 40.6 As built

(Each part adds its notes here.)

#### Web app

Items 14 and 15, built on 12 Nov. The app's suite went from 215 to 219, with lint and build clean. Nothing here was
run against the new account code: the rules are section 40.1's as written.

- **Item 14 (A8), `permission_blk`.**
  - `web/src/lib/types.ts`: `AccountState.permission_blk?: number`. Missing on an account from before the fix, and
    then no rule applies.
  - `web/src/lib/verdict.ts`: `verdictUse(stored, counter, height, use, permissionBlk?)`. For `fund`, a verdict whose
    `blk` is at or below `permissionBlk` (above 0) is refused: "It was run before your lender permission last
    changed: a check from before the change can't back a loan." `beforePermissionChange(blk, permissionBlk)` is the
    rule on its own.
  - `web/src/hooks/use-check-then-act.ts`: both places that decide whether the held verdict backs the action (right
    after the check lands, and before a second approval or a smaller loan on the same check) pass
    `state.permission_blk`. A refusal there ends the flow with the words above and "Run it again", as a used check
    does.
  - `web/src/components/verdict-card.tsx`: a stored `fund` verdict from before the change shows "From before the
    permission changed: a new loan needs a new check" where it would have said "Fresh". The Account page, the Risk
    page and the check flow pass `permission_blk`.
  - Nothing in the app waited for the counter to move after `set_permission`. The permission card's sentence now
    reads "A check you ran before the change can't back a new loan after it: run it again."
  - The app runs no funding step itself: the keeper does. A plain `borrow` from our pool and the withdrawals are
    backed as before.
- **Item 15 (A7), the 24-hour limit.**
  - `web/src/lib/tx.ts`: `MAX_QUOTE_LIFE_MS`, `moveExpiryProblem(exp, nowMs)`, and the three builders that record a
    move (`withdrawTx` with a `transfer`, `hlWithdrawTx` with `exp`, `evmWithdrawTx` with `exp`) throw `MoveRefused`
    when `exp` is more than 24 hours after `nowMs` (the browser's clock by default). Exactly 24 hours is built. A call
    without a transfer or an `exp` is not judged.
  - `buildMove(() => tx)` gives a page the transaction or the words: "This quote expires more than 24 hours from now.
    The account takes a move only when its quote ends within a day, so nothing was sent: ask for a new quote."
  - Shown in place of the send button by the Hyperliquid moves (`web/src/components/move-usdc.tsx`) and the four
    moves to and from Aave's chain (`web/src/lib/moves.ts`, `nextTx` and `nextRefusal`; `web/src/components/home/moves.tsx`).
    The setup checklist's move to Hyperliquid fails its step with the same words.
- **Section 40.1, items 3 to 5, as the app meets them.**
  - Item 3: the Repay panel lets anyone repay while the account is unwinding, and a typed amount can send Aave a
    part. The panel now says, to anyone but the owner, that Aave takes all of what it is owed or nothing. Nothing is
    blocked. "All" sends the pay-off amount, which is above the debt, when the address holds that much USDC; when it
    holds less, "All" is a part too and the line shows.
  - Item 4: no screen sends a deposit with a transfer's msg. Only 1Click, or the stand-in, does.
  - Item 5: taking collateral back from Aave, sending a token out, and the two moves home each list one transaction.
    Nine in a row with no check between would meet the refusal, which the page shows in the account's own words.
- **Tests:** `web/src/lib/verdict.test.ts` (two, for item 14), `web/src/lib/tx.test.ts` and `web/src/lib/moves.test.ts`
  (one each, for item 15). Each fails on the code as it was.

#### Engine

Items 8 and 9, built on 12 Nov. The engine's suite went from 319 to 321. Lint shows only the seven old warnings in
`risk-core`'s tests, `backtest examples` says 144 of 144, and the five verdict fixtures and the five credit replays
are identical byte for byte. `risk-core` and its fixtures are untouched. Nothing was deployed.

- **Item 8 (A7), the owner's own moves.**
  - `risk/pb-read/src/book.rs`: `owners_move(id)` (an id that starts with `move:`), and in `transit()` such a
    transfer is not put in `inflight`. One `if`, after the transfer's token is checked and after it is listed as
    overdue.
  - **What it no longer counts:** the state (it was 98%), credit (it was already 0), and margin on its way to
    Hyperliquid when a REBALANCE is sized.
  - **What stays:** a move of a token the account isn't configured for is still refused in words; a `to_hl` move is
    still matched against Hyperliquid's ledger and a `to_evm` move against the address on Aave's chain, and both go
    in `arrived`; a move past its deadline is still in `top` (`overdue: home transfer move:0`); its coin is still
    priced, because the arrival rule values what was sent.
  - **A plan step's transfer** (`<pid>:<i>`, a funding plan's `f<blk>:<i>` too) counts as before.
  - **Both programs change,** because both build their book in `pb-read`: `pb-risk` and `pb-gateway`.
  - **Every mode goes through `book::build`:** `check`, `preview`, the book stress test (`pb-risk/src/stress.rs`),
    and the gateway's order check, `set_leverage`, `deleverage` and `cancel_risky`. `credit_check` reads no account.
  - **What an owner sees while a move travels:** equity reads lower by the whole move, not by 2% of it. A check in
    those seconds that finds Hyperliquid short of margin plans the top-up in full, though the owner's own move may
    be bringing it. An order checked in those seconds is checked on the lower equity. A move home from Aave's chain
    reads the same signed or mined (the money is out of the book), and counts again once it is delivered on NEAR.
- **Item 9, `permission_blk`.** `near::state` reads the fields it needs by name and ignores the rest, so nothing
  changed. `the_phase_6_state_parses_and_an_old_state_has_none_of_it` now reads a state with `permission_blk` (a
  block height, and 0) and gets the same result, and the pretend account in `pb-risk/tests/common/mod.rs` answers
  it in every lender test. The inputs keep the state as the account returned it, so a verdict's `in` covers the
  field.
- **RISK_ENGINE.md:** 3.4 has the rule and why; the scenario formula in 4.8, the parameter table, row L4 and the
  appendix's equity line point to it.
- **Tests,** each failing on the code as it was (`pb-risk/tests/pipeline.rs`):
  - `an_owners_own_move_props_up_nothing_and_a_plan_steps_transfer_counts_as_before`: $1,800 of equity under a
    maintenance margin of $8,456 (DELEVERAGE). A pending `move:0` of $1,000,000, not overdue, used to make it
    HEALTHY; now the verdict is the real book's, figure for figure. The same amount as `276800123:0` or `f123:0`
    counts at 98%.
  - `a_rebalance_does_not_count_an_owners_own_move_as_margin_on_its_way`: the plan asked for $1,269 with a $300
    move pending; now it asks for the whole $1,563. A plan step's transfer of the same size is still taken off.
  - `a_move_seen_on_hyperliquid_is_arrived`: an owner's move that Hyperliquid doesn't show yet adds nothing; a
    plan step's adds 98%; both are `arrived` once the credit shows.
  - The stage 4 tests (`pb-read/tests/lenders.rs`, `pb-risk/tests/aave.rs`) now check both kinds of id.
- **Gate 4's run** (`research/data/phase6_funding_moves.json`): none of its recorded verdicts changes. Each was read
  before the move it allowed was recorded (`move:1`: `allow.withdraw` 22067140; `move:2`: 23067142), or was the
  verdict that marked a move arrived (`move:0`, `move:2`), where the move was already out of the in-flight list.
  `move:3` asked for no verdict. A check that had landed while a move travelled would have read equity $22 to $41
  lower, against $1,471 of equity and $543 of maintenance margin: HEALTHY either way.

#### Keeper, backend and gates

Items 10 to 13, built on 12 Nov. The keeper's suite went from 175 to 180. The backend's stays at 154 (two of its
tests now check the new field), the stand-in's at 54 and its client's at 12, and `pnpm -r build` is clean. Nothing
was started, sent or run for real. The account's and the factory's new rules were read from their source as it stood
that day, and the made-up accounts in the tests answer in those words.

- **Item 10 (P4), a repaid lender's line is settled once.**
  - `services/keeper/src/loop.ts`, `settleRepaidLender`, run on the tick a new verdict is first seen, before that
    tick's own actions (a step among them may borrow at the lender again).
  - **The rule:** for `aave` and `rhea`, where the verdict's `ext` shows nothing owed and the pool's
    `get_pricing(account).last` has that lender's line with debt above 0, the keeper calls the account's `settle()`.
    It is the hourly settlement's own action and log line. Its `decide` line reads "the pool's last report still
    shows debt at Rhea, and this check shows nothing owed there: one settlement, so the pool's record says so too".
  - **It doesn't repeat.** At most one settlement a verdict. After the next check one read shows the pool's zero,
    and then nothing is read until a verdict shows that lender owed again (`AccountMemory.lenderLineClear`).
  - **Cheap.** One new read, `readPricing(account)`: a view of the pool's `get_pricing` (`POOL_ACCOUNT_ID`, or
    `pool.<factory>`). An account with no record, or no line for a lender, costs one read per keeper run.
  - **Not on a verdict the account can't settle on:** one an action has used, one over 90 blocks old (the first a
    keeper sees after it starts may be days old), or one read while the account lists a lender action as under way,
    which may not show the debt yet. Nor on a tick that asks for a check or settles anyway. Each is looked at after
    the next check.
  - **When the pool takes nothing** ("too soon", paused) its record still shows the debt, and the keeper settles
    again after the next check.
  - **Left open:** the keeper asks for no check of its own for this. An account left with no loan at all gets no
    further check from the keeper, so a settlement the pool skipped as too soon is tried again only at the account's
    next check, whoever asks for it. That is likely when the client's own repayment settled a moment before (the
    account settles at a lender repayment when it holds a fresh verdict; the pool keeps two settlements 2 minutes
    apart on testnet, 10 by default). The zero then lands before the next borrow, which closes the subsidy; the
    honest client is still charged for the gap, up to 48 hours.
  - **Under a fixed price** the settlement can add a fee, which reopens a pool loan of cents on an account that had
    just repaid everything (the audit's A13; the hourly settlement can do the same). Pass-through pricing books
    nothing.
- **Item 11 (A8), nothing relies on `set_permission` moving the counter.**
  - **No caller found.** Nothing in the keeper, the backend, the stand-in, its client, the gates (`funding:demo`
    for rhea, aave and `--moves`, `hedge:demo`, `drill:demo`, `faults`) or `scripts/` calls `set_permission`, or
    waits for the counter after it. Every gate passes the permission with `create_account`, and each fund step asks
    for its own check right before `fund`, so that check is read after the account's making. No gate changed.
  - **What did rely on the counter:** the keeper's test of whether a held verdict can back a funding step
    (`checkProblem` in `services/keeper/src/decide.ts`). For a lender's step (`l_borrow`, and `l_supply` while our
    pool is owed) it now also asks that the verdict's `blk` is above `permission_blk`: "step 1 (l_borrow) of funding
    plan f5000 needs a fresh check first: the last one was read before the permission last changed (block 5045)".
    That check is asked for at once, as one for a moved counter is, three times at most. Before, the keeper would
    have sent the step three times to be refused, and stopped the plan.
  - **Top-up steps** (`l_add`, `l_repay`) needed no change: a step the account refuses already asks for a new
    plan, and the check behind it is read after the change.
  - **Types:** `AccountState.permission_blk?: number` (`services/keeper/src/state.ts`), `Seen.permissionBlk`
    (`decide.ts`), the backend's `StateView` and `LenderState`. Missing on an older account: no rule applies.
  - **Backend:** `GET /api/lender/:account` gains `permission_blk` (a number, or null on an older account) beside
    `verdict_blk`. `GET /api/account/:id` passes `get_state` through, so the field is there without a change.
- **Item 12 (A7), `move_far`.** `pollTransfers` in `services/keeper/src/loop.ts` logs one `move_far` line for any
  pending transfer whose deadline is more than 24.5 hours ahead (`MOVE_FAR_MS`), with its id, kind, token, amount,
  deposit address and `hours_ahead`: "transfer move:4 (e_home) is listed as on its way until
  2026-12-10T12:20:00.000Z, 720 hours from now. A 1Click quote lasts a day at most, so no real transfer has a
  deadline that far off. Only an account made before the fix of 12 Nov can record one". Once per transfer, for an
  owner's move and a plan step's alike.
- **Item 13, the gates' own calls against section 40.1.** No code changed.
  - **`exp`:** every move in every gate signs the backend's `move.next`, whose `exp` is the quote's `deadline`. The
    backend asks for 10 minutes and the stand-in answers with the deadline it was asked for, so `exp` is 10 minutes
    ahead. A dry quote from the real 1Click carries no deadline, and took a request for 3 days without complaint,
    so what a committed 1Click quote answers wasn't seen. The backend doesn't refuse a later one: the account does.
  - **Aave's repayment:** only `aave-steps.ts` calls `lender_repay("aave")`, as the owner (the keeper's key owns
    the gates' accounts), for the whole debt and 0.1%. The keeper itself never calls it.
  - **Deposits with a transfer's msg:** the gates deposit with an empty msg only. The stand-in refunds the whole
    deposit, in the token sent, with the msg, and sends an excess back without one.
  - **Listings:** the moves gate lists one Ethereum transaction at a time (its test counts them); the Aave gate two
    at most.
  - **`create_account`:** the gates' one call (`stepCreate` in `hedge-steps.ts`) attaches 300 TGas, and so does
    `scripts/first-loan.py`. The factory's floor is 180.
- **Tests,** each failing with its change undone:
  - `services/keeper/src/loop.test.ts`: "the audit's P4: after a check, a debt the pool's last report still
    shows..." and "...goes out before a step of the same tick borrows there again" (item 10); "the audit's A8, tick
    by tick..." (item 11); "the audit's A7: a transfer whose deadline is more than 24.5 hours ahead..." (item 12).
  - `services/keeper/src/decide.test.ts`: "the audit's A8: a lender's step waits for a check read after the
    permission last changed..." (item 11).
  - `services/api/src/lenders.test.ts`: the two `GET /api/lender/:account` tests (the new field).
  - The gates' made-up accounts (`moves-gate.test.ts`, `aave-gate.test.ts`, `funding-steps.test.ts`) and the
    keeper's (`loop.test.ts`) now hold to section 40.1: `permission_blk` in `get_state`, `fund` and `l_borrow`
    refusing an older check, the 24-hour limit on `exp`, 8 listings, and the factory's 180 TGas. The gates pass
    them unchanged.
- **Gate 4's code** (`moves-kit.ts`, `moves-steps.ts`, `moves-demo.ts`) is untouched. For a keeper beside it: no
  transfer of the gate's is far (40 minutes at most), `permission_blk` is the account's making, and the one new
  action is a `settle()` after the check that shows Aave repaid, which leaves the counter alone and books nothing
  under pass-through pricing.

#### Account, types and factory

Items 1 to 7, built on 12 Nov. The contracts' suite went from 642 to 666 (`cargo test --workspace --locked`). Nothing
was deployed.

- **Item 1 (A7), the 24-hour limit.** `MAX_QUOTE_LIFE_MS` (`contracts/account/src/plan.rs`).
  - `new_move` (`lib.rs`) refuses `exp` more than 24 hours after the block's time, for `withdraw` with a `transfer`,
    `hl_withdraw` with `exp` and `evm_withdraw` with `exp`: "exp is more than 24 hours ahead: a 1Click quote lives a
    day at most". Exactly 24 hours is taken.
  - `execute_step`, for a plan's `sell`, `to_hl` and `home`, refuses the same before the pool is asked and before
    the counter moves: "the step's quote expires more than 24 hours ahead".
- **Item 2 (A8), the permission.**
  - `set_permission` no longer moves the counter. It sets `permission_blk` to the block it ran in, a cancel
    included. `new` sets it to its own block when a permission came with it, and to 0 otherwise.
  - `permission_blk` is the last stored field of the account, and `get_state()` shows it as a number.
  - The refusal, everywhere: "the check was read before the permission last changed (block N): ask for a new check",
    for a held verdict whose `blk` is at or below `permission_blk`.
  - Where it is asked: `fund`; `l_borrow` at either lender; `l_supply` where it reads a verdict (while the account
    owes our pool); `l_add` always, since it reads the verdict that ordered it.
  - **`l_repay` is never refused for it** (decided on 12 Nov, after the first build): repaying never stops. A top-up
    plan's `l_repay`, at either lender, still repays on a held check read at or before `permission_blk`, and only
    skips the settlement that would go to the pool beside it (`settle_since_permission`). That is what the old
    counter bump did to it. After a `set_permission`, a stored top-up plan's `l_add` waits for the next check to
    order the top-up again; its `l_repay` doesn't.
  - Our pool's own `borrow` and `p_borrow`, `withdraw`, `settle` and the direct `lender_repay` / `lender_withdraw`
    don't ask it.
  - The engine reads a final block, so a check asked in the same second as `set_permission` may be read at or
    before `permission_blk`: ask again.
- **Item 3 (A9), a stranger at Aave.** `assert_stranger_may_repay_aave` (`lib.rs`), in `lender_repay` for a caller
  who isn't the owner, lender `aave`.
  - A part is refused: "anyone but the owner repays all of Aave's debt (N) or nothing", N in micro-USD.
  - While a kept signed `repay` has a nonce at or above the held verdict's `evm.nonce` (or the verdict has no `evm`):
    "a repayment at Aave is signed and not mined yet (nonce N): send it, then ask for a check". N is the lowest such
    nonce.
- **Item 4 (A12, in part).** `ft_on_transfer`: for a `to_hl` or `to_evm` transfer, a deposit with its msg settles it
  only as `refunded`: the token it sent, and at least 80% of its amount (`amount × 5 ≥ sent × 4`). Otherwise the log
  says "kept as a deposit: not a refund of transfer <id>" and the record stays. `sell`, `home` and `e_home` settle
  as before.
- **Item 5 (A14).** `MAX_AAVE_LISTINGS` = 8 (`lender.rs`). `evm_withdraw`, `lender_withdraw("aave")` and the Aave
  `l_borrow` step refuse a ninth listing: "8 Ethereum transactions are listed already: send them, then ask for a
  check". The callbacks' gas isn't changed.
- **Item 6 (X2).** `Config::assert_valid` (`contracts/types/src/lib.rs`): "lenders.rhea.collateral tokens have at
  most 18 decimals". The pool links this crate but not this function: its wasm is byte for byte what it was
  (`c4641c0e…`, 464,340 B).
- **Item 7 (F2).** `gas_for_on_created(tokens)` (`contracts/factory/src/lib.rs`): 30 TGas and 10 for each call. 70
  with 2 tokens, 130 with 8. `create_account` refuses less than 110 TGas above it: "attach at least 180 TGas: 300
  TGas is the safe amount" with 2 tokens, 240 with 8. On the live state in the sandbox it ran on exactly 180 and
  burnt 86.4.
- **Builds** (`contracts/build.sh --sizes`):
  - account 514,749 B, `0809d45c060e78925b4276d25e8b7d3735ffb42edb9f5582fa17094b95ba60cb`;
  - factory 747,633 B, `638f17b1b2a40c8559629847be58ebc9d2f9876915addee37f8631ed3a26e860`;
  - pool unchanged.
- **The factory's upgrade** is a plain redeploy with no init call: its stored state doesn't change shape, and
  `migrate` is refused. Its code grows by 2,641 B (0.026 NEAR). 6 NEAR leaves a new account 0.82 NEAR free.
- **Tests, each failing on the code as it was:**
  - Account (`contracts/account/src/tests.rs`), 14: A7 `no_move_is_recorded_with_an_expiry_more_than_24_hours_ahead`,
    `a_plan_step_whose_quote_expires_more_than_24_hours_ahead_sends_nothing`; A8
    `set_permission_leaves_the_counter_alone_so_a_check_on_its_way_still_arrives`,
    `get_state_shows_the_block_the_permission_last_changed`,
    `fund_refuses_a_check_read_at_or_before_the_block_the_permission_last_changed`, three for the steps that
    refuse, and
    `a_top_ups_l_repay_step_still_repays_on_a_check_read_before_the_permission_changed_and_skips_its_settlement`; A9
    `anyone_but_the_owner_repays_all_of_aaves_debt_or_nothing`,
    `anyone_but_the_owner_waits_until_a_check_shows_the_signed_repayment_mined`; A12
    `a_deposit_with_the_msg_of_a_move_that_left_near_settles_it_only_as_a_refund`,
    `a_plans_move_to_hyperliquid_is_settled_by_a_verdict_or_a_refund_and_by_nothing_else`; A14
    `at_most_8_ethereum_transactions_are_listed_at_once`. Two more guard what must not change (Rhea and the plan's
    `l_repay` under A9; `sell`, `home` and `e_home` under A12).
  - Types: `a_rhea_collateral_token_has_at_most_18_decimals`. Factory: `on_created_gets_gas_for_every_call_it_makes`,
    `create_account_refuses_less_gas_than_its_callback_needs_and_says_how_much`.
  - On the built contracts (`contracts/tests/tests/audit_fixes.rs`, 4): A7 with A12, A8, A9, X2 with F2.
  - The redeploy over today's live factory (`contracts/tests/tests/upgrade_audit.rs`, 1), from
    `contracts/target/live-stage4/`.
- **Older tests changed, because the rule changed:** eight in `tests.rs` used `set_permission` to move the counter
  or expected it to; a withdrawal moves it there now. `tests/account.rs` expected the counter at 5 after a cancel;
  it is 4.
- **Gate 4 against these rules** (`research/data/phase6_funding_moves.json`): its four quotes expired 10 minutes
  ahead; both `to_evm` moves were settled by a verdict and both `e_home` moves by their delivery, in another token;
  it never called `set_permission`, and its `fund` check was read about 110 seconds after the account was opened;
  the owner repaid Aave; at most one listing stood at a time. `contracts/tests/tests/moves.rs` passes unchanged.

## 41. The audit fixes live on testnet (12 Nov)

**Deployed on 12 Nov, 12:31 to 12:38 UTC, and gate 4 passed again on the new code at 12:46** (pass point; the whole
run ended 12:50:37). The steps are `research/audit_fixes_deploy.md`; the user approved each signed one. What was
fixed and how each fix is proved is in `research/audit.md`, "What was fixed on 12 Nov, and what is left".

**Deployed, each checked on chain:**
- **Test NEAR:** 8 from `pbf-ops.testnet` to the keeper (tx `49NTvDjpMQyfmRiFUgjCcKGHc4acTKmoym71yPr8vYDB`).
- **`pb-risk` `1a102c17…` and `pb-gateway` `9a2e035c…`:** uploaded, fetched back from FastFS (right size and hash)
  and added with `--no-activate`. The gateway's first upload printed two transaction ids and "Upload complete", but
  the chain never saw either transaction and FastFS answered 404 for three minutes; a second upload worked.
  `update_access` (tx `56ToWrFRjWX1z32JeVLv7xsjhcc75VPAdFxVZBCjyNbb`) added the new gateway's hash to the seed's rule as
  a sixth. The new gateway answers `demo1.pbf.testnet`'s agent `0x68643293…d46a`, and the new engine runs.
- **The factory:** a plain redeploy with no init call (tx `7jvptKazYJTdGTi4h4JdYKsDDVvpYxRWFLe9jKuJehWZ`). Its code
  on chain is the built file byte for byte (`638f17b1…`, code hash `7hdv1DyEkMTnsXrNTBnU4j3LwwUVmYKXtW68snRCjPpb`);
  `account_code_hash` is `0809d45c…`; a snapshot before and after shows the config and the 9 accounts unchanged.
  `set_config` (tx `GoTzzRUzeGvXe2hRcAjEjuyTUZPHypHJVYujGd2Yknb`) changed `risk.version_key` and
  `gateway.version_key` only. The pool wasn't touched.

**Gate 4 on the new code** (`research/data/phase6_funding_moves.json`, account `fund-move-11121239.pbf.testnet`,
12:39:16 to 12:50:37): every step passed at its first try, with no check asked twice.
- The same round trip as the morning's: 0.00054246 nBTC to Aave's chain as 0.019502754 WETH; one `fund` of $121.16
  ($21.78 from Aave at 0.74%, $99.38 from our pool); funded 166 s after the signature, cushion 1.54; the loan home
  ($21.781236 sent, $21.776835 arrived); then everything repaid, the collateral home as 0.00054005 nBTC, and both
  tokens withdrawn.
- **The new code is what ran:** the account's code on chain is the built `0809d45c…`, its `get_state` shows
  `permission_blk` (277363963, the block it was made in), and its verdicts came from the two new programs.
- **The stand-in's faucet mint, for the first time:** its float held $0.005 of test USDC, so for the USDC move to
  Aave's chain it minted the $0.988372 it was short of from Aave's faucet (`0x404a01d561…3a6d`) and then delivered.
  Section 38's item 1 is closed.
- **Checked on both chains afterwards, apart from the script:** Aave shows $0.00000023 posted and $0 owed; the
  pool's `debt_of` is 0; the account holds neither token. The float used 0.002001 test ETH and holds 0.04399.
- The morning's record is kept as `research/data/phase6_funding_moves.gate4-2026-11-12.json` (the gate also keeps
  one itself, under a number).

**The Rhea gate on the new code** (`research/data/phase6_funding_rhea.fixes-2026-11-12.json`, account
`fund-rhea-11121251.pbf.testnet`, 12:51:49 to 13:07:29). **It is not a pass: its hedge step didn't run.**
- **What stopped it:** `short`, the 0.015 BTC hedge on Hyperliquid, was refused by the gateway with P2, "limit price
  more than 1% from the reference price". Hyperliquid testnet's BTC mark stood at $74,421 against an oracle price of
  $72,987, 1.96% over it (0.77% on 11 Nov), and the gate prices its order 0.3% under the mark. The real book's asks
  all stood above the gateway's band, so a hedge opened inside the band could not have been closed through the
  gateway either. The order was not forced.
- **What ran instead:** the same account went on from the step after the hedge (`--from keeper`), on an unhedged
  book worth $1,533.72. Every later step passed:
  - asked $2,000; the engine could lend $766.45; one `fund` of $762.54: $554.66 from Rhea at 15.92% and $207.88 from
    our pool at 5%. The keeper ran `l_supply` and `l_borrow`; funded in 118 s; cushion at Rhea 1.50;
  - a fee of $0.000205 under a 5-point margin, then a subsidy of $0.000177 under a cap of 0;
  - bitcoin held down at our Rhea copy: cushion 1.30; the keeper's top-up plan repaid $73.84 at Rhea (`l_repay`), and
    the cushion was back at 1.50;
  - Rhea repaid, the pool repaid, the nBTC taken back, $428.35 of USDC home from Hyperliquid, both tokens withdrawn.
- **P4's fix seen live:** at 13:06:50 the keeper logged "the pool's last report still shows debt at Rhea, and this
  check shows nothing owed there: one settlement", and the pool's last report for the account now shows Rhea's
  debt as 0.
- **Checked afterwards:** our Rhea copy shows no collateral and nothing borrowed for the account (a deposit of
  under a millionth of a dollar is left there); the pool's `debt_of` is 0; the account holds neither token.
- `research/data/phase6_funding_rhea.json` is still gate 2's own record of 11 Nov, which passed with the hedge.

**Left as it is on testnet:** every new account has the fixed code and pins the two new programs. Accounts made
before 12:36 UTC keep theirs. The backend, the keeper and the stand-in were stopped after the runs. After them:
`pbf-ops.testnet` 3.18 NEAR, the keeper 2.44, the factory 2.55 free; the float 0.04399 test ETH, 0.01 test WBTC and
no test USDC (it mints what a move needs). Another gate run needs about 6.7 NEAR in the keeper first.

**Seen and left:**
1. **The hedge on Hyperliquid testnet can't be traded through the gateway while the mark is more than 1% from the
   oracle.** That is the gateway's rule working, and it would stop the same order in the click-through. It clears
   when testnet's mark comes back toward its oracle.
2. **`outlayer upload` doesn't notice a dropped transaction.** Fetch the file back before `outlayer deploy`, as the
   deploy notes say.
3. **The app's two changes** (`permission_blk`, the 24-hour guard) have met no real wallet.

## 42. The price band on testnet: 3%. The shapes, fixed on 12 Nov before building

**The user's decision, 12 Nov:** "lets modify the rule to let there be a 3% gap allowance. we can note it and say
that this is for testnet only as we observed this was the case with hyperliquid repeatedly".

**Why.** P2 (RISK_ENGINE.md 9) refuses an order whose limit price is more than the coin's band from the reference
price: 1% for BTC. Hyperliquid testnet's BTC mark keeps standing away from its own oracle price, which the reference
follows: 0.77% over it on 11 Nov, 1.69% and then 1.96% on 12 Nov. An order has to be priced near the mark to fill,
so on such a day the gateway refuses every order that could fill. That stopped the Rhea gate's hedge on 12 Nov
(section 41). Mainnet's mark doesn't stand 2% from its oracle; testnet's book is thin and its mark is its own.

**The rule.** On testnet, P2's band for a coin is the parameter file's band or 3%, whichever is larger.
- **One figure, in the network's settings:** `TESTNET.price_band_floor` = 0.03 (`risk/pb-read/src/request.rs`). A
  mainnet network would carry 0, which leaves the parameter file's band as it is.
- **The parameter file doesn't change,** so its hash, the pinned `params`, `risk-core`'s own default and every
  fixture stay as they are. `risk-core` takes the floor as an argument that defaults to none.
- **It applies in the three places the band is used,** so they agree:
  1. an owner's order through the gateway (P2 in `risk-core`'s pre-trade check, as `pb-gateway` calls it);
  2. a plan's perp step when the gateway runs it (P2 in `pb-gateway`);
  3. the limit price the engine gives a plan's perp step (`pb-risk`'s plan: half the band from the reference, so
     1.5% on testnet).
- **The refusal says the band it used:** "limit price more than 3% from the reference price".
- **Nothing else changes:** the reference price, the margin checks (P3 to P10), what counts as an uncertain price,
  and every valuation still use the reference as before.

**Who gets it.** Each account pins its gateway and engine when it is made. So the 3% band reaches accounts made
after the new programs are pinned; an older account keeps 1%.

**Services and the app.**
- The backend's `band_bp` (what the app shows as the band) must be the band the account's own pinned gateway
  uses: 300 for an account that pins the new gateway, 100 for an older one.
- The gates' own order prices must sit inside the band on a day like 12 Nov, both ways: a sell near the bids, and a
  buy (and the float's ask it meets) near the asks. No price may cross the real book.

**To say wherever the rule is described** (RISK_ENGINE.md 9, the README): the 3% is a testnet allowance, made because
Hyperliquid testnet's mark was seen 0.8% to 2.0% from its oracle on 11 and 12 Nov; mainnet keeps the parameter
file's band.

### 42.1 As built

(Each part adds its notes here.)

#### Keeper, backend and gates

Built on 12 Nov. The keeper's suite went from 180 to 185 and the backend's from 154 to 155; the stand-in's (54) and
its client's (12) didn't change, and `pnpm -r build` is clean. Nothing was started, sent or run for real. Hyperliquid
testnet's prices were read (its public info endpoint) to work the numbers through.

- **`band_bp` now follows the account's own pinned gateway.**
  - **Where it came from:** a constant. `GET /api/markets` gave each coin the parameter file's band (100 for BTC),
    whoever asked. The engine's preview has no part in it.
  - **Now** (`services/api/src/hl-handlers.ts`, `getMarkets` and `bandFloorBp`): `GET /api/markets?account=<client
    account>` gives the bands of that account's gateway: the file's band or 300, whichever is larger, when the
    account pins a gateway built since the rule; the file's band when it pins an older one. With no account, or one
    that isn't made yet, it is the band of the gateway the factory pins, which is what a new account gets.
  - **New fields:** `band_from` (`"account"`, `"factory"` or null), `gateway_version` (the pinned version key) and
    `band_floor_bp` (300 or 0). `coins[].band_bp` keeps its name.
  - **How it tells old from new, with no hash to wait for:** it knows the six gateway versions from before the
    rule (`GATEWAYS_BEFORE_THE_BAND_FLOOR`; the secret's access rule of 12 Nov lists every gateway that could run:
    `research/data/audit_fixes_update_access.json`). Any other pinned version carries the 3%. Before the deploy
    the factory pins `9a2e035c…`, so everyone reads 100; once `set_config` pins the new gateway, new accounts read
    300 and older ones keep 100. Testnet only: on another network the floor is 0.
  - **The app** must ask with the account (`/api/markets?account=<id>`) where it shows an account's band. Asked
    without one it shows the factory's band, which after the deploy is 3% even for an account that keeps 1%.
- **The gates' own order prices come from one place** (`services/keeper/src/hedge-kit.ts`, `gatePx` and `hedgeNow`;
  `services/keeper/src/hedge-steps.ts`, `priceFacts`). `hedge:demo`, `drill:demo` and the Rhea gate share them.
  - **The band** is the backend's, for the gate's own account (`gatewayBand`). No 1% figure is left in the steps.
  - **The price:** 0.3% through the mark: under it for the float's bid and the account's sells (`short`, `burst`),
    over it for the float's ask and the account's buys (`close_short`). It is held a tenth of a percent inside the
    band around Hyperliquid's oracle price, which the gateway's reference follows (testnet's oracle was within
    0.03% of mainnet's on 12 Nov).
  - **The real book** is read (`l2Book`): the float's bid must be under the best ask and its ask over the best
    bid, or it would trade with strangers and not wait for the account. When the band's edge is on the wrong side
    of the book, the step stops in words and posts nothing.
  - **A short that couldn't be closed isn't opened:** `short` needs both prices to exist.
  - **The orders that must be refused:** `refuse_close` is a buy at the same price as the bid: inside the band, so
    the refusal is a risk check's (P5 to P9) and not P2's, and under the asks, so it couldn't fill if let through.
    `refuse_coin` is refused by P1 before the price is looked at; it didn't change.
- **Worked through** (each line is a test):

  | Day | Mark, oracle, best bid, best ask | Band | `short` and `burst` | `refuse_close` | `close_short` |
  |---|---|---|---|---|---|
  | 12 Nov | $74,421, $72,987 (1.96% over), $74,421, $74,427 | 3% | bid and sells at $74,197, 1.66% over the oracle | buy at $74,197: P2 passes, a risk check refuses | ask and buys at $74,644, 2.27% over the oracle, over the bids |
  | 12 Nov | the same | 1% | not opened: no ask the gateway takes ($73,643 at most) is over the best bid | buy at $73,643, held to the band: refused by a risk check | stops in words; nothing posted |
  | 11 Nov | $76,585, $76,000 (0.77% over) | 3% | $76,355 | $76,355 | $76,814 |
  | 11 Nov | the same | 1% | $76,355 | $76,355 | $76,683, held to 0.9% over the oracle, as before |

- **How wide a gap the hedge stands** under 3%: the mark up to about 2.9% from the oracle, either way. Up to 2.6%
  both prices are 0.3% through the mark; from 2.6% to 2.9% the far one is held to the band's edge and still clears
  the book; past that the step stops in words. Under 1% the figures are 0.6% and 0.9%.
- **The gates say so before they start.** The Rhea gate's dry run and pre-check (`Found.hedge` in
  `funding-kit.ts`), `hedge:demo` and `drill:demo` print whether the hedge can be opened and closed now, with the
  two prices. The Rhea gate and `hedge:demo` make no account when it can't (a run with `--from` past the hedge
  isn't asked).
- **The keeper's own decisions** needed nothing. `decide.ts` prices no order: its "bands" are the verdict's
  state bands. A plan's perp step is priced by the engine and checked by the gateway, and the keeper acts on the
  gateway's code (P2: a check for a new plan), never on a figure. `faults` sends no order.
- **Tests,** each failing with its change undone:
  - `services/api/src/hl-handlers.test.ts`: "markets: the band is the one the account's own pinned gateway uses...".
  - `services/keeper/src/hedge-kit.test.ts`: "the gate's order prices under a 3% band...", "under the 1% band of an
    older gateway...", "how wide a gap the 3% band stands...".
  - `services/keeper/src/hedge-steps.test.ts`: "12 Nov's prices under the 3% band of a new gateway...", "12 Nov's
    prices under the 1% band of an older gateway...".
  - `services/keeper/src/funding-kit.test.ts`: the hedge line and problem in "each single thing out of place...".

#### Engine

Built on 12 Nov. The engine's suite went from 321 to 329. Lint shows only the seven old warnings in `risk-core`'s
tests, `backtest examples` says 144 of 144, and the five verdict fixtures and the five credit replays are identical
byte for byte. The parameter file and its hash didn't change. Nothing was deployed.

- **The figure:** `TESTNET.price_band_floor` = 0.03, a new field of `Network` (`risk/pb-read/src/request.rs`).
  `Network` no longer derives `Eq`, which a decimal figure can't have; nothing compared networks that way.
- **The rule, in one function:** `risk_core::pretrade::p2_band(band, floor)` gives the coin's band, or the floor
  when one is given and is larger. A floor of 0, or one that isn't a number, changes nothing.
- **The three places:**
  1. **An owner's order.** `Engine::pretrade_check_with` takes `band_floor: Option<f64>` as its last argument.
     `pretrade` and `pretrade_check` pass none, so the reference's cases, the examples and the backtest keep the
     file's band. `pb-gateway`'s `check_order` passes `Some(TESTNET.price_band_floor)`.
  2. **A plan's perp step at the gateway:** `place_step` in `risk/pb-gateway/src/gateway.rs`.
  3. **The engine's price for a plan's perp step:** `perp_leg` in `risk/pb-risk/src/plan.rs`, through the new
     `Ctx.band_floor`. Half the band from the reference: 1.5% on testnet.
- **One thing beyond the shapes above: the floor a run used is written in its inputs.** The reader sets
  `Inputs.band_floor` (`risk/pb-read/src/inputs.rs`) from the network's figure, and `pb-risk` prices a plan's perp
  step from it. It is left out of the inputs when 0.
  - **Why:** `pb-risk/tests/fixtures/drill.json` holds a planned price, `"px":"76379"`, 0.5% over its reference,
    and a verdict is worked out from its inputs alone. Had `pb-risk` taken the floor straight from the network's
    settings, that saved run would replay at 1.5% (`"77139"`) and no longer match byte for byte.
  - **So** a run saved before 12 Nov has no `band_floor` and replays exactly as saved. A run of the new program
    carries `"band_floor":0.03` between `lenders` and `coins`, and its `in` covers it.
  - **The other way** is to take the floor from the network's settings in `pb-risk` and write `drill.json` again:
    one line in `risk/pb-risk/src/verdict.rs`, if that is preferred.
  - The gateway needs no such record: it checks an order as it comes, with the network's figure.
- **The words.** An owner's refusal: "limit price more than 3% from the reference price". A plan step's:
  "px 80000 has left BTC's 3% band around 75999.99: ask for a new verdict". Sections 13 and 16 above still show
  the 1% forms ("half the coin's band", the example `P2` string).
- **Both programs change:** `pb-risk` (the plan's price and the new input) and `pb-gateway` (both checks).
  - **Pin them together.** The new engine's 1.5% step is refused by an older gateway's 1% band. An older engine's
    0.5% step passes a new gateway.
- **What else reads or states the band:**

  | Place | Does it follow? |
  |---|---|
  | `backtest examples` (`risk/backtest/src/examples.rs` prints a coin's band) | No: the reference's figures, the file's band |
  | `backtest drill` (`risk/backtest/src/drill.rs` wires a plan) | No: it passes no floor, and its pinned `"px":"76179"` stays |
  | The book stress test (`pb-risk/src/stress.rs`, `pb-read/src/stress.rs`) | Reads no band and plans nothing |
  | `credit_check` | Reads no band |
  | The engine's preview and verdict | Carry no band figure: a verdict's `bands` are the state bands. The only trace is a plan step's `px` |
  | The backend's `band_bp` | Not from the engine: the backend works it out itself (the notes above) |
  | Resting orders | Nothing in the engine checks a resting order against the band, so nothing to follow |

- **What it leaves,** on a $76,000 reference:
  - **A plan's own buy fills only while the offers are within 1.5% of the reference.** Its price is the reference
    plus 1.5%, rounded down to a whole dollar ($77,140), and the order fills at once or is cancelled. At 12 Nov's
    gaps (1.69%: offers from about $77,285; 1.96%: from about $77,490) the gateway accepts the step and nothing
    fills; the next verdict plans it again. At 11 Nov's 0.77% it fills. Before, the limit was 0.5%.
  - **A plan's sale** is priced 1.5% under the reference, so it fills while the mark is over the reference, or up
    to 1.5% under it.
  - **An owner's own order** can be priced up to 3% away, so it can fill up to a 3% gap.
  - **A plan's step can fill up to 1.5% worse than the reference** (it was 0.5%): on the drill's $285 buy-back,
    up to $4.28 where it was $1.43.
  - **A stored step lasts longer.** The gateway runs a stored buy until the reference has fallen about 1.46% or
    risen about 4.6% since the verdict. It was 0.5% and 1.5%.
  - **While a price is uncertain** (P10) the band is measured from Hyperliquid's mark, as before, and is 3% too.
- **Tests.** Each fails with the floor set back to 0, which is the code as it was. `risk-core`'s call the new
  argument, so they don't build on the old code.
  - `risk/risk-core/tests/price_band.rs` (new): "with no floor the band is the parameter file's" (1.5% away is
    refused with the 1% words), "a floor of 3 percent accepts 2 percent away and refuses 3 and a half with the 3
    percent words", "the band is the larger of the coin's and the floor".
  - `risk/pb-gateway/src/tests.rs`: "on testnet an order 2 percent from the reference is placed and one 3 and a
    half away is refused", "on testnet deleverage places a stored perp step priced 2 percent from the reference",
    and "deleverage refuses a step the market has moved past" now expects the 3% words.
  - `risk/pb-risk/tests/pipeline.rs`: "on testnet a perp step is priced 1.5 percent from the reference and a run
    from before replays at half a percent"; "the drill book walks down the states" now expects 1.5%.
  - `risk/pb-risk/src/plan.rs`: "a floor under the band prices a perp step half the larger band from the
    reference" (a buy, a sale, and from the mark while the price is uncertain).
  - `risk/pb-read/src/inputs.rs`: "the band floor is left out when there is none and survives a round trip".
- **RISK_ENGINE.md:** section 9 has "The testnet price band" under the table of checks, with why and what it
  doesn't fix; the P2 row, the per-coin parameter row (5.2) and section 10's row point to it.

#### Web app

Built on 12 Nov. The app's suite went from 219 to 222, with lint and build clean. Nothing was run against a live
backend: the route's shape is the one in the notes above and in `services/api/src/hl-handlers.ts` (`getMarkets`).

- **A page that has an account asks with it.** `web/src/lib/api.ts` has `marketsPath(account)`:
  `/api/markets?account=<id>` with an account, the plain `/api/markets` without one. It is used by:
  - the Trade page (`web/src/app/trade/trade-view.tsx`), whose band is shown, checked and used for the "fill a
    price" button;
  - the setup checklist's hedge (`web/src/components/home/setup-actions.ts`, `short`), which prices its sell half the
    band below the reference: with the factory's 3% and an account that keeps 1%, the gateway would have refused it;
  - Home, the Borrow page's comparison and the Risk page, which read prices from the same answer.
  - The operator's panel has no client account and keeps the plain path. The Trade and Risk pages use it too until
    an account exists.
- **The band is the figure in the answer, everywhere.** `priceBand` and `bandProblem` (`web/src/lib/hl-rules.ts`)
  took it from `coins[].band_bp` already; nothing was fixed at 1%. The words now print it as given
  (`bandPercent`: 300 is "3%", 250 is "2.5%"), where they used to round to a whole percent.
- **The testnet sentence.** Under the Trade page's "Price band" line, when `band_floor_bp` is above 0 and the coin's
  band is not wider than it: "This wider band is a testnet allowance, because Hyperliquid testnet's price often
  stands away from its oracle." (`bandFloorWords`.) An older account's answer has floor 0 and shows no sentence.
- **Types:** `MarketsAnswer` gains `band_from`, `gateway_version` and `band_floor_bp`, all optional.
- **Tests,** each failing on the code as it was:
  - `web/src/lib/api.test.ts` (new): "a page that has an account asks for the markets as that account's own
    gateway sees them".
  - `web/src/lib/hl-rules.test.ts`: "the band is the figure the markets answer gives, in the check and in the
    words…" (12 Nov's prices: a sell at $74,197 is inside 3% and outside 1%), and "a band the testnet floor widened
    says so in one sentence…".

## 43. The testnet price band live (12 Nov)

**Deployed on 12 Nov, 14:32 to 14:35 UTC.** The steps are `research/band_deploy.md`; the user approved each signed
one. The account contract and the factory's code didn't change, and the pool wasn't touched.

**Deployed, each checked:**
- **`pb-risk` `fb2cee3b…` and `pb-gateway` `fba556c2…`:** uploaded, each fetched back from FastFS with the right
  size and hash, and added with `--no-activate`. `update_access` (tx `DPwrQJUNKotR1cjmSQ3uRd761QTanXGo9aNtQLwxG75e`)
  added the new gateway's hash to the seed's rule as a seventh. The new gateway answers `demo1.pbf.testnet`'s agent
  `0x68643293…d46a`, and the new engine runs.
- **The factory's settings:** `set_config` (tx `3P1KAT4EuvvscUSo417N8L6RFcoCGffjdtBLr9qY1Un2`) changed
  `risk.version_key` and `gateway.version_key` only; a snapshot before and after shows nothing else moved.
  `account_code_hash` is still `0809d45c…`.

**Checked live, reading only (14:35 UTC),** with this build's backend and keeper started against testnet:

| Asked | Answer |
|---|---|
| `GET /api/markets`, no account (what a new account gets) | gateway `fba556c2…`, `band_floor_bp` 300, BTC's `band_bp` 300 |
| `GET /api/markets?account=fund-rhea-11121251.pbf.testnet` (made before the pin) | gateway `9a2e035c…`, floor 0, BTC's band 100 |
| The same for `demo1.pbf.testnet` | floor 0, BTC's band 100 |
| The Rhea gate's dry run | "Hyperliquid's BTC mark ($73,695) is 2.11% over its oracle price ($72,173), and the gateway's band is 3%: the hedge opens with sells at $73,473 and closes with buys at $73,916" |

**Not proved live: an order through the new gateway.** The proof is the Rhea gate with its hedge on a new account,
and the dry run's one thing in the way was test NEAR: the keeper holds 2.41 and a new account takes 6 and about 0.6
more. `pbf-ops.testnet` holds 3.18. With about 5 more test NEAR in the keeper,
`pnpm --filter @pb/keeper funding:demo -- --lender rhea` is the run. Until then the first live order under the 3%
band will be the user's own click-through on a new account.

**Left as it is on testnet:** every account made from 14:35 UTC on 12 Nov pins the two new programs and has the 3%
band; accounts made before keep 1%. The three services were stopped after the checks.

**Proved live later the same day (15:07 to 16:01 UTC), once the keeper had test NEAR** (9.9 from a faucet account,
`pbf-fund7.testnet`): the Rhea gate with its hedge, on a new account that pins the two new programs
(`research/data/phase6_funding_rhea.band-2026-11-12.json`, account `fund-rhea-11121507.pbf.testnet`). **It is not a
pass: one step, `top_up`, failed.** Every other step passed.

- **The hedge opened under the 3% band.** Mark $72,745, oracle $71,303 (2.02% over). The gateway (`fba556c2…`) took
  "sell 0.015 BTC at 72526 (IOC)", 1.71% over the oracle, and it filled at $72,685. The 1% band had refused the same
  kind of order at 12:53.
- **The loan on the hedged book:** asked $2,000; the engine could lend $1,055.47; one `fund` of $1,050.09: $541.98
  from Rhea at 15.92% and $508.11 from our pool at 2%. Funded in 110 s; cushion at Rhea 1.50. A fee of $0.000206,
  then a subsidy of $0.000171.
- **`top_up` failed: the keeper never asked for the check.** The gate drops our Rhea copy's BTC price to bring the
  cushion to 1.30, and the keeper is meant to see it, check, and run the top-up plan. The keeper measures a price
  move from the prices at the moment it first sees a verdict, unless it asked for that verdict itself
  (`decide.ts`, "Any other verdict is measured from now"). Here the newest verdict was the gate's own, read before
  the drop, and the keeper first saw it in the tick after it had set the dropped price. So it measured from the
  dropped price, saw no move, and asked for nothing for 25 minutes. At 13:04 the same step passed because the
  newest verdict was one the keeper had asked for. The keeper also skipped six ticks in that minute on FastNEAR's
  rate limit (429), with 12 accounts to read. Not caused by the band or the audit fixes; open.
- **Closing the hedge was first refused by Hyperliquid itself:** "Price too far from oracle", four times, for a buy
  at $73,430, 2.8% over the oracle, which the gateway had accepted. Hyperliquid's docs list the error and give no
  figure. Seen on 12 Nov: a sell 1.71% over the oracle and a buy 2.3% over it were taken; buys 2.8% over were
  refused. Testnet's whole book stood about 2.5% over the oracle at the time, so no buy that could fill was
  allowed. Our band can't change that.
- **The close went through 13 minutes later,** when the mark had come back to 2.03% over the oracle: "buy 0.015 BTC
  at 73290 (IOC)" filled at $73,226.60 (`--from close_short`). Then $421.61 of USDC came home from Hyperliquid and
  both tokens were withdrawn.
- **Checked afterwards, apart from the script:** the account's Hyperliquid address is flat; the stand-in's
  Hyperliquid float holds $772.31 again; our Rhea copy shows no collateral and nothing borrowed; the pool's
  `debt_of` is 0; the account holds neither token. The services were stopped.
- `research/data/phase6_funding_rhea.json` is gate 2's own record of 11 Nov again.

**What this leaves:**
1. **The keeper's cushion watch can miss a price move** that lands between a verdict's read and the keeper's first
   sight of it. The fix is in the keeper alone: measure from the verdict's own figures, or work the cushion out
   from the lender's price now.
2. **A hedge on Hyperliquid testnet can be opened or closed only while testnet's book is inside Hyperliquid's own
   limit from its oracle** (between 2.3% and 2.8% by what was seen). When it isn't, an open hedge has to wait.
3. **FastNEAR's free rate limit** is reached with 13 accounts, a gate and the backend reading at once.

## 44. The keeper's price watch: measured from the verdict's own block. The shapes, fixed on 12 Nov before building

**The user's decision, 12 Nov:** "Fix it now", for the timing gap that stopped `top_up` in section 43's run.

**The gap.** After each new verdict the keeper watches prices and asks for a check when they have moved enough: a
state band crossed, or a lender's cushion brought near 1.35 (`decide.ts`, `cushion.ts`). It measures the move from
reference prices (`refPrices`). For a verdict the keeper asked for itself, those are the prices of the moment it
asked. For any other verdict they are the prices of the moment the keeper first sees it ("measured from now"). That
is wrong when a price moved between the verdict's read and that first sight: the verdict doesn't have the move, and
the keeper measures from after it, so nobody acts until the hourly check. On 12 Nov the gate's own check was read at
block 277380343, the gate's hold then dropped our Rhea copy's BTC price by 13.6%, and the keeper first saw that
verdict one tick later: no check for 25 minutes, and no top-up.

**The rule.** For a verdict the keeper didn't ask for, the reference prices are the ones the keeper read at the
verdict's own block, not the ones of now.
- **The keeper keeps what it read:** each tick's prices with the block height it read them at, for the last 10
  minutes. No new read.
- **For a new verdict it didn't ask for:** the reference prices are those of the last kept tick at or before the
  verdict's `blk`. A move after that tick may already be in the verdict; counting it again can only bring a check
  sooner, which is the safe side.
- **When nothing that old is kept** (the keeper has just started, or the verdict is older than 10 minutes): as
  today, measured from now.
- **A verdict the keeper asked for:** as today, the prices of the moment it asked.
- **It holds for every watch that uses the reference prices:** the lenders' cushions, and the state bands.
- A tick an account skips on an error must not lose a check that was due: the next tick finds it still due.

**No deploy.** The keeper alone changes. The engine, the gateway, the contracts and the app stay as they are.

### 44.1 As built

#### The keeper

Built on 12 Nov, in the keeper alone (`services/keeper/src/decide.ts`, `loop.ts` and their tests). The keeper's
suite went from 185 to 191, and `pnpm -r build` is clean. No service was started and no gate was run; nothing here
is proved live yet.

- **The cause, checked first against the keeper's log and the code: it is the one section 43 gives.** The keeper's
  ticks began at blocks 277380294, 277380321 and 277380349 with our Rhea copy at $71,498.20. The gate's check
  (its `settle_subsidy` step's own) was read at block 277380343 and stored in block 277380363. The tick that began at
  block 277380377 first set the copy to $61,807.19 and then looked at the account: its first sight of that verdict.
  The keeper's own last check was 5.5 minutes old, past the 4 minutes in which a new verdict counts as the keeper's,
  so the verdict was measured from the price of that tick, the dropped one. In the gate, `settle_subsidy` ends with
  a check of its own and `price_drop` follows at once, so every run has such a verdict right before the drop;
  whether the keeper's tick sees it before or after the price is set is a matter of a few seconds.
- **What the keeper keeps** (`loop.ts`, `handle`; `AccountMemory.kept`). The prices each tick read for the account,
  with the final block's height when the tick began (the market read's `chainBlock`) and the keeper's clock, for 10
  minutes (`KEEP_PRICES_MS`). They are kept per account, because the prices an account is measured on carry its own
  drill ratio. No new read. It is written before the tick decides anything, so a tick that fails later still leaves
  it. Not kept: a tick whose market read gave no block, a tick whose read of the account's own ratio failed (it ran
  on the shared ratio, which isn't the account's), and a tick that couldn't read the account at all.
- **The reference** (`decide.ts`: `pricesAtBlock`, and one line in `decide`). A new verdict the keeper didn't ask for
  is measured from the kept prices for the verdict's `blk`; with none that old kept, from now, as before. A verdict
  the keeper asked for is measured from the moment it asked, as before, and "asked for" means what it meant: the
  keeper asked for a check in the last 4 minutes. The one reference (`refPrices`, and the sides taken from it) feeds
  the state bands, the big-move test and the lenders' cushions, so all three follow.
- **Are the two block numbers comparable? Both are final blocks, but they don't mean the same.** The engine reads
  the latest final block and makes every NEAR read at that one height (`risk/pb-read/src/read.rs`), so a verdict is
  the chain exactly at `blk`. The keeper reads the latest final block first (`near.ts`, `finalBlock`), but nothing
  it reads after is tied to it: its views go to the chain's newest block, a block or two past the final one
  (near-api-js 7.4.0 asks at "optimistic" unless told otherwise), and in a tick where it sets our Rhea copy's price
  it carries the price it has just set, which lands several blocks after the tick began. So a tick's prices can be
  newer than its number says: the unsafe side. On 12 Nov the tick that set the price began at block 277380377 and
  the price landed a few blocks later; a gate check read in between would have been matched with that tick, and so
  with the dropped price.
- **Handled on the safe side: the newest kept tick at or before `blk` is passed over, and the one before it is the
  reference.** All a tick read, it read before the next tick began, and that next tick began at or before `blk`. For
  the keeper's own price change this is exact: it waits until its transaction is final before the tick goes on. For
  the plain views it leans on the final block trailing the newest by a block or two, against the 13 seconds or so
  between a tick's reads and the next tick. When only one kept tick is that old, it is used: still earlier than now.
  The price paid: a move in the 15 to 30 seconds before `blk` can be counted though the verdict has it, which brings
  one check sooner.
- **A tick with no price for a lender is passed over too,** when another kept tick has one (the Rhea read failed, as
  in six ticks on 12 Nov). Otherwise that lender's cushion would be measured on Hyperliquid's mark at one end, and a
  move of the copy's own price wouldn't show.
- **A tick an account skips on an error. Could it lose a due check before? Yes, in this one way,** and the rule
  closes it: a new verdict was measured from the tick that first saw it, so every skipped tick moved the reference
  later, and a price that moved meanwhile was lost. Now the reference is the verdict's own block, whenever the
  keeper first sees it. Nothing else is lost by a skipped tick: the keeper's memory of an account is written only
  after the tick's actions have run, so a tick that fails leaves it as it was, and every other due check (the hourly
  one, the second DELEVERAGE check, a band crossed, a cushion, a check to send again) is found again from that
  memory on the next tick.
- **Tests, each failing on the code as it was:**
  - `loop.test.ts`, "INTERFACES.md 44, the 12 Nov sequence tick by tick…": the four ticks with their real block
    numbers and prices; the keeper's decision reads "Rhea's cushion was 1.50 at the last check, and bitcoin's price
    at Rhea has gone from $71,498.2 to $61,807.19 since: about 1.300 now, under 1.35, where it gets topped up", and
    the check goes out in the same tick. The verdict it brings is measured from the moment the keeper asked: no
    second check.
  - `loop.test.ts`, "…a tick the account skips on an error loses no check…": the same, with the first-sight tick
    failing on a rate limit; the check goes out on the next tick.
  - `loop.test.ts`, "…each tick's prices are kept with the final block the tick began at, for 10 minutes…": 41 ticks
    kept of 45, the account's own ratio in them, and the two kinds of tick that aren't kept.
  - `decide.test.ts`, "…a verdict the keeper didn't ask for is measured from what the keeper had read by the
    verdict's own block, for a lender's cushion, a band and a big move; one it asked for, from the moment it asked;
    with nothing that old kept, from now".
  - `decide.test.ts`, "…the newest is passed over and the one before it is the reference", and "…a tick that set
    Rhea's price itself is not the reference for a verdict read in the blocks just after it began": the safe side.
- **NEAR reads per tick: 4 for the tick, and 1 for each account,** all sent at once. The tick's: the final block, the
  drill's shared ratio, the keeper's balance, our Rhea copy's price (and the factory's list once a minute). An
  account's: `get_state`; one more for its own drill ratio while it has a loan. This change adds none. The P4 change
  of this morning added none per tick: the pool's `get_pricing` is read once on a tick where a new, unused, fresh
  verdict has landed, and not again once the pool's record shows no debt at the lenders the verdict doesn't owe.
  So an account with no lender line costs one read in all, not one a tick.
- **Seen and left:**
  - **Four old accounts are skipped on every tick, and cost 8 of the 20 reads a tick.** `demo1`, `quiethare6001`
    (since 9 Nov), `hedge1` and `quiethare-hedge` (since 11 Nov) hold verdicts from before the account stored when a
    verdict arrived, so the keeper asks the node for that block's time, and FastNEAR no longer has the block: "Block
    either has never been observed on the node or has been garbage collected", 3,415 times in the log so far. Each
    costs its `get_state` and that failed read every tick, and the keeper doesn't watch them at all. All four showed
    no loan when last read. Not changed: making the keeper handle them again is a change of behaviour for accounts
    it hasn't touched in days.
  - **The keeper can be started for named accounts only** (`--account <id>`, repeatable): for a live proof on one
    account that is 6 reads a tick instead of 21.
  - **A loan that starts under a verdict the keeper has already seen** is still measured from that tick's prices
    (`decide.ts`, "A loan that starts under a verdict already seen"). The rule names new verdicts only.
  - **A verdict someone else asked for, landing within 4 minutes of a check of the keeper's own,** is still taken
    for the keeper's and measured from when the keeper asked. If the keeper asked after the price moved, that
    reference is too late; the keeper's own verdict follows and has the move, unless that check fails.
  - **A tick whose market read fails goes on with no prices.** A check asked for on such a tick is remembered with
    no prices, and the verdict it brings then has nothing to measure from: its cushions and big moves aren't
    watched until the next verdict (the bands are, from the next tick). Section 44 keeps "as today" for a verdict
    the keeper asked for, so this stays.

### 44.2 Built and tested; not proved live (12 Nov, 17:33 to 18:11 UTC)

The keeper suite passes on the fix by the main session's own run: 191 (was 185), with the 12 Nov sequence replayed
tick by tick. **The live proof was tried and did not get as far as the top-up.** Nothing of the fix failed; the run
never reached it.

- **The plan was to reuse `fund-rhea-11121507.pbf.testnet`** without the hedge (`--from keeper`), so no new account
  was needed. `fund` stored a plan and the keeper posted the collateral at Rhea, but the account refused the
  borrow: "no borrow until 2026-11-14 17:00:19 UTC: a signed Hyperliquid sendAsset can still be posted until
  then". That account brought USDC home from Hyperliquid at 16:01, and for two days after that an account borrows
  nothing. The rule is the account's own and it is right; reusing the account was the mistake. `funded` timed out
  after 20 minutes.
- **FastNEAR's free rate limit then stopped the reads** of the keeper (13 accounts, four of them old ones it can't
  read and tries every tick), the gate and the backend together: three tries to go on were refused by the gate's
  own checks, with nothing sent. With all services stopped a read went through again.
- **Going on with `--from rhea_withdraw` ran earlier steps first,** because the record of the stopped run no longer
  held them: the runner runs any step the record lacks. It ran `fee_policy` (the operator set this test account's
  price to Rhea's rate plus 5 points) and four tries of `settle_fee` (a check and a `settle()` each, with nothing
  owed and so no fee) before it was stopped by hand. It did not reach `price_drop`.
- **The clean-up then ran from a record that held every earlier step:** the nBTC came back from Rhea and both
  tokens were withdrawn. Checked afterwards: nothing posted or owed at Rhea, the pool's `debt_of` 0, no tokens in
  the account. What stays on that test account: the price policy of Rhea's rate plus 5 points, and an expired
  funding plan.
- `.claude/launch.json` has a new entry, `keeper-one`: the keeper watching one named account (6 reads a tick, not
  21). The name in it is that test account's.

**For a live proof:** a new account (one that hasn't brought money home from Hyperliquid in the last two days), the
keeper started for that account alone, and the gate run without its hedge or with Hyperliquid testnet's book
inside its own limit. The keeper holds 6.22 test NEAR and a new account's run needs about 6.7.

**For any `--from` run:** check that the record holds every step before the one named, or the runner runs them.

### 44.3 Proved live, and gate 2 passed in full on the final code (12 Nov, 19:23 to 19:38 UTC)

On the user's "i want everything done now": the Rhea gate, whole, with its hedge, on a new account
(`fund-rhea-watch1.pbf.testnet`), with the keeper started for that account alone (`keeper-one`).
**Gate 2 passed** (`research/data/phase6_funding_rhea.json`, kept also as
`phase6_funding_rhea.final-2026-11-12.json`): every step passed. One step, `home`, needed a second try.

- **The code that ran:** the account `0809d45c…` (the audit fixes), `pb-risk` `fb2cee3b…` and `pb-gateway`
  `fba556c2…` (the 3% testnet band), and this build's keeper (sections 40.4 and 44).
- **The hedge:** mark $73,316.70, oracle $71,624.10 (2.36% over). "sell 0.015 BTC at 73096" filled at $73,247.90.
  The close, "buy 0.015 BTC at 73143", filled in two parts. Hyperliquid's own limit didn't refuse either.
- **The loan:** asked $2,000; the engine could lend $1,059.91; one `fund` of $1,054.50: $544.62 from Rhea at 15.93%
  and $509.89 from our pool at 2%. Funded in 110 s; cushion at Rhea 1.50. A fee of $0.000202, then a subsidy of
  $0.000176.
- **The keeper's top-up, by the rule of section 44.** The same order of events as the run that failed at 15:18:
  the keeper's own last check was 5 minutes 20 seconds old; it set our Rhea copy's price from $71,546 to $62,082.83
  at 19:33:47 and first saw the gate's own verdict, read before the drop, in that same tick. This time it said
  "Rhea's cushion was 1.50 at the last check, and bitcoin's price at Rhea has gone from $71,546 to $62,082.83
  since: about 1.300 now, under 1.35, where it gets topped up", asked for a check, got REBALANCE (cushion 1.2995),
  and ran `l_repay` of $72.80. The cushion was back at 1.50, and `top_up` passed in 60 s.
- **No tick was skipped:** with one account to watch, the keeper met no rate limit in the whole run.
- **`home` stopped once:** real 1Click answered the stand-in's price request with HTTP 400, "Quoting for this pair
  is not available". Two minutes later `--from home` went through: $429.04 home, both tokens withdrawn.
- **Checked afterwards, apart from the script:** the account's Hyperliquid address is flat; our Rhea copy shows no
  collateral and nothing borrowed; the pool's `debt_of` is 0 and its last report shows Rhea's debt as 0; the account
  holds neither token; its code on chain is the built file.

**Left by the run:**
1. **The stand-in's Hyperliquid float holds a short of 0.00011 BTC** (about $8). The float sold 0.01179 BTC to the
   account's closing buy and could buy back only what testnet's thin book offered under Hyperliquid's limit; twelve
   `float:close` tries took it from 0.00588 to 0.00011, with five refused "Price too far from oracle". What is left
   is under Hyperliquid's $10 order minimum. The float holds $770.48.
2. **Test NEAR:** the keeper 1.12, `pbf-ops.testnet` 2.17. A gate run needs about 6.7 in the keeper.
3. `.claude/launch.json`'s `keeper-one` names that test account; change the name to use it for another.

## 45. The pool's three findings (P3, P5, P4). The shapes, fixed on 12 Nov before building

**The user's decision, 12 Nov:** "Pool too", after I had recommended leaving the pool until after the hackathon.
The findings are in `research/audit.md`, second pass: P3 (a settlement's fee has no upper bound), P5 (a fee lapses
past 48 hours), P4 (a subsidy or a fee on lender debt that wasn't there). This changes the live pool, with a
migration, and the account, so the factory is redeployed too. The engine and the gateway don't change.

**The live pool on 12 Nov 19:50 UTC,** fetched read-only into `contracts/target/live-pool-fees/` for the migration
test: code `c4641c0e…`, 13 accounts, $10,000,000.003927 of test capital, fees charged 847 micro-USD, subsidies 703;
limits at their defaults but `min_period_ns` at 2 minutes; funding order `lender_first`; no tier policy.

### 45.1 Pool (`contracts/pool`)

1. **P3, what a settlement's fee can be at most.** Three new limits in `PricingLimits`, each with a default the JSON
   may leave out:

   | Field | Default | What it bounds |
   |---|---|---|
   | `max_lender_debt` (U128, micro-USD) | $1,000,000 | A lender's reported debt counts at no more than this in a settlement, at both ends of the period, for a fee and for a subsidy |
   | `account_fee_day` (U128, micro-USD) | $1,000 | The most fee one account is charged in 24 hours |
   | `pool_fee_day_bp` (u32) | 50 | The most fee the whole pool books in 24 hours, as a share of its capital (0.5%) |

   - A fee is cut to what is left of both 24-hour budgets, as a subsidy is cut to its own. What is cut isn't owed
     later. The answer's `cut` says how much, for a fee as for a subsidy.
   - The windows: one for the pool in the root state, one per account in **a map of its own** (a new last storage
     key), so no stored `AccountPricing` record and no stored `LenderReport` changes shape.
   - `problem()` bounds the new fields: `pool_fee_day_bp` at most 10,000; the two amounts any value.
2. **P3, taking a wrong fee back.** `reverse_fee(account_id, amount)`: the operator only. It takes `amount` off the
   account's debt, never more than the debt and never more than the fees charged to that account less what was
   reversed before. It moves no cash, opens no room in the lending window, emits `reverse_fee`, and the totals
   (`fees_reversed`, per account and for the pool) show in the views. The account's own loan record isn't told: the
   pool's debt is the authority, and the account's record clears at its next full repayment.
3. **P5, the period.** A subsidy still covers at most `max_period_ns` (48 hours). A fee covers all the time since
   the last settlement. That holds for each lender's part and for our pool's own part under `Fixed`. The fee budgets
   of point 1 bound what a long gap can charge.
4. **P4, the two ends of a period.** `settle(report, closes)`: `closes` is optional. When it is given, it is the
   lender report as it stood just before a change (the debts before a borrow): the settlement closes the period on
   `closes` and stores `report` as the start of the next. When it is left out, `report` does both, as today.
   `closes` is checked as `report` is (each lender once, "aave" or "rhea"). An account from before this calls
   `settle(report)` and behaves as before.
5. **`migrate`:** `#[private]`, `#[init(ignore_state)]`, from the layout live today to the new one. Everything the
   pool holds stays as it is (the limits it has, `min_period_ns` of 2 minutes included, every pricing record, every
   debt); the new limits take their defaults, the new windows and totals start empty. It refuses any other state,
   so it can't run twice. The old `migrate` from Phase 5 goes.
6. **Views and events:** `get_params().pricing_limits` shows the three new fields; `get_pool()` and `get_pricing()`
   show `fees_reversed`; `set_pricing_limits` takes the new fields.
7. FUNDING.md 5.2 and 5.3 say all of this in plain words.

### 45.2 Account (`contracts/account`) and factory

8. **P4, the account's part.** At an `l_borrow` step the account calls the pool's `settle` with `report` (the
   verdict's lender lines with this borrow added, as today) and `closes` (the verdict's lender lines as they are).
   Every other settlement passes no `closes`. Nothing else in the account changes. The factory carries the new
   account code: a plain redeploy with no init call.

### 45.3 Keeper, backend, gates (`services`) and the app (`web`)

9. **P5:** the hourly settlement goes out for every account whose pricing policy isn't pass-through, not only where
   a lender is owed.
10. **P4, "too soon":** when the settlement that reports a repaid lender as zero is skipped as too soon, the keeper
    asks for one more check with a settlement behind it once the pool's `min_period_ns` has passed, twice at most.
11. Types and views follow the pool's new fields. Gate 2's fee and subsidy steps must still pass, and its checks
    must read a fee's `cut`.
12. The app shows the three new limits wherever it shows the pricing limits, and nothing else changes.

### 45.4 The deploy, and what must pass again

- **Order:** the pool first (the new code with `migrate` as its init call, signed by the pool account), then the
  factory. A new account's `settle` with `closes` then meets a pool that knows it; an older account's call without
  it works on both.
- **Before the pool is touched:** the migration is run in the sandbox over the live code and state fetched above,
  and the pool's views are compared before and after.
- **Afterwards:** gate 2 and gate 4 again, each on a new account.

### 45.5 As built

(Each part adds its notes here.)

#### Web app

Item 12, built on 12 Nov. The app's suite went from 222 to 225, with lint and build clean. Nothing was run against
the new pool: the fields are section 45.1's as written.

- **Types** (`web/src/lib/api.ts`): `PricingLimits` gains `max_lender_debt`, `account_fee_day` and
  `pool_fee_day_bp`, each optional. `PricingView` and the pool's totals in `GET /api/pricing` gain an optional
  `fees_reversed`. The app reads no settlement's `cut`.
- **The three limits, one plain line each** (`web/src/lib/pricing.ts`, `feeLimitLines`), on the Book page under the
  limits it showed before (`web/src/app/book/book-view.tsx`):
  - "A lender's reported debt counts at no more than $1,000,000.00 in a settlement, for a fee and for a subsidy."
  - "One account is charged at most $1,000.00 of fees in 24 hours. A fee above that is cut, and isn't owed later."
  - "The whole pool books at most 0.50% of its capital in fees in 24 hours: $50,000.00 on its $10,000,000.00." The
    dollar figure is the pool's own capital from `GET /api/pool`; without it the line gives the share on $10,000.
  - A limit the answer doesn't carry gets no line, so a pool or a backend from before the fix renders as it did.
- **A settlement's period** (`periodWords`): the operator's panel said a change counts "for the whole time that
  settlement covers". It now adds: "A fee covers all the time since the account's last settlement. A subsidy covers
  at most 48 hours of it." The 48 hours are the answer's `max_period_ns`.
- **Left as it was, by item 12:** "Fees earned" on the Book page is still `fees_charged`. It doesn't take
  `fees_reversed` off, and no screen sends `reverse_fee` or `set_pricing_limits`.
- **Tests** in `web/src/lib/pricing.test.ts`, each failing on the code as it was: "the three limits on fees each
  read in one plain line with a dollar figure", "an answer from before the fee limits still renders…", "a
  settlement's period: a fee covers all the time since the last one, a subsidy at most 48 hours of it".

#### Account

Item 8, built on 12 Nov. The account's unit tests went from 397 to 398. Nothing was deployed, and no wasm was built:
the pool's helper was building in the same folder.

- **The change** (`contracts/account/src/lib.rs`):
  - `lender_borrow_for_step`, the `l_borrow` step at either lender, calls the pool's `settle` with two arguments.
    `closes` is the held verdict's lender lines as they are. `report` is the same lines with this step's borrow
    added at its lender, as before.
  - A second interface, `ext_pool_at_borrow`, holds the two-argument `settle`. The one-argument `settle` in
    `ext_pool` is untouched.
- **Every other settlement is byte for byte what it was:** `settle()`, the one beside `lender_repay`, and the one
  beside a top-up's `l_repay` send `{"report": [...]}` with no `closes` key. So the pool live today reads them as it
  does now, and so does the new one, where a missing `closes` means "`report` does both".
- **The other way round, a new account on the older pool:** the `l_borrow` step sends
  `{"report": [...], "closes": [...]}`. The older pool's `settle` has one argument and doesn't refuse an argument it
  doesn't know: near-sdk 5.29.1 refuses unknown arguments only on a method marked `#[deny_unknown_arguments]`, and
  no method of ours is. It settles on `report` for both ends, as today. This is read from the SDK's source, and the
  sandbox check below is written for it; it hasn't been run.
- **Nothing else in the account changes,** and the factory's source doesn't change: it carries the new account
  code, so its redeploy is plain, with no init call.
- **Test, failing on the code as it was** (`contracts/account/src/tests.rs`):
  `a_borrow_step_tells_the_pool_the_debts_as_they_stood_and_no_other_settlement_does`. At Rhea and at Aave the
  step's call carries `closes` with the verdict's own debts and `report` with the borrow added; `settle()`, the
  settlement beside `lender_repay` at each lender, and the one beside a top-up's `l_repay` at each lender carry
  `report` alone. Three older assertions of the step's call now expect `closes` too.
- **The sandbox check, written and compiled but not run** (`contracts/tests/tests/p4_closes.rs`, 2 tests): an Aave
  `l_borrow` step against the pool this tree builds, and the same step against the pool from before this change
  (`contracts/target/live-pool-fees/pool.wasm`, `c4641c0e…`). In both the pool's `settle` succeeds, the signer is
  asked, and `get_pricing().last` holds the debt with the borrow in it. It needs the account, factory and pool
  built first. What the pool charges on each end is the pool's own to test.

#### Pool

Items 1 to 7, built on 12 and 13 Nov. Nothing was deployed, signed or sent. The pool's unit tests went from 126 to
137, its sandbox tests from 3 to 5, and the upgrade was run in the sandbox over the live pool's code and state.

- **The wasm:** 478,954 bytes (it was 464,340), sha256
  `ca21d5336508de33b0e2c9ff068877bbf85d9b561ed1eb8d61c7f64a6963ab4c`, NEAR code hash
  `Ec3H4MxdZUE1c41SBaFJ41DPPW8LkA3h14AuJL1Zjp9H`. Built by `contracts/build.sh --sizes`.
- **Storage:** the pool account's storage grows by 14,675 bytes (14,614 of code, 61 of root state), which locks
  0.147 NEAR more. Read-only on 12 Nov: it holds 6.766 NEAR and uses 470,112 bytes, so afterwards 4.85 NEAR is
  locked and 1.92 is free. No top-up is needed. An account's fees record, written at its first fee or reversal,
  is at most about 0.7 KB.

**As built, item by item** (`contracts/pool/src`):
1. **The three limits** (`pricing.rs`, `PricingLimits`): `max_lender_debt`, `account_fee_day`, `pool_fee_day_bp`,
   in that order after `pool_subsidy_day_bp`, each with a serde default. `problem()` adds
   "pool_fee_day_bp is a share of capital, capped at 10,000 bp".
   - `settlement` counts each report's debt at no more than `max_lender_debt`, before it takes the larger or the
     smaller. The stored report keeps the figure as it came; the limit applies again when it is the period's start.
   - `cut_fee` and `settle.rs` cut the settlement's net fee to what is left of the account's `account_fee_day` and
     of `pool_fee_day_bp` of capital, with capital as it stands before the fee. The answer's and the event's `cut`
     carry it. A fee cut to nothing is still a settlement: the answer has `fee` "0" and the report is stored.
   - The pool's window is `fee_24h` in the root state. Each account's is in the new map `fees`
     (`AccountFees { fee_24h, fees_reversed }`), under the new last storage key `Fees` (byte 8). Both use the same
     hourly buckets as the subsidy windows.
2. **`reverse_fee(account_id, amount)`** (`admin.rs`), with no deposit, like the other operator methods.
   - An amount above either bound is refused, not cut down: "that is more than the fees charged to this account,
     less those already reversed" and "that is more than the account owes the pool". Also "amount must be
     positive", "not a registered account", "only the operator can do this".
   - It works while the pool is paused. It leaves the cash, the lending window and both fee windows alone.
   - Event `reverse_fee`: `{"account_id": "a.testnet", "amount": "50000000", "debt": "<the debt afterwards>"}`.
3. **The period** (`pricing.rs`, `settlement`): a fee part runs over the whole time since the last settlement, a
   subsidy part over at most `max_period_ns`, lender parts and our pool's own part alike. One settlement can hold
   both, each over its own time. **The answer's `period_ns`** is the whole time when the net total is a fee, and
   the cut time otherwise, so a reader's "debt × rate × period" still matches in both cases.
4. **`settle(report, closes)`** (`settle.rs`): `closes` is `Option<Vec<LenderReport>>`; left out or null, `report`
   closes the period as before. The "too soon" rule and the rate history read `report`. "Nothing to settle" needs
   no debt in either. A wrong `closes` is refused with the report's own words ("the report names rhea twice").
5. **`migrate`** (`lib.rs`): reads the stage 2 layout (`PoolStage2`, with its six limits as `LimitsStage2`) and
   nothing else. With no state: "no pool state to migrate". The Phase 5 `migrate` and `PoolV5` are gone.
6. **Views:** `get_params().pricing_limits` has nine fields; `get_pool()` and `get_pricing()` gain
   `fees_reversed`. `get_borrower` is unchanged. No view shows what is left of a fee budget.
7. **FUNDING.md 5.2 and 5.3** say it in plain words.

**Which test proves which fix.** The first two were written first and run on the code as it was: both failed
(a fee of $3,995,433.79 on the $17.5 trillion; 48 hours of fee, not 30 days). The others need the new arguments.

| Fix | Unit tests (`pool/src/tests.rs`, `pricing.rs`) | Sandbox |
|---|---|---|
| P3, the debt counted | `the_audits_p3_case_a_report_of_17_5_trillion_dollars_at_a_lender_books_23_cents_and_stops_nothing` (321 wrong reports add $73, and the pool lends and repays as before); `a_lenders_debt_counts_at_no_more_than_a_million_dollars_at_both_ends_of_the_period` | `pool_pricing.rs`: `a_wrong_report_books_a_fee_within_its_limits_and_the_operator_takes_it_back` |
| P3, the budgets | `an_accounts_fees_stop_at_1000_dollars_in_24_hours`; `the_pools_fees_stop_at_50_bp_of_its_capital_in_24_hours`; `the_budgets_hold_when_the_operator_lifts_the_limit_on_a_lenders_debt`; `a_fee_is_cut_to_what_is_left_of_…` | the same test: a fee cut to 100 micro-dollars, then to nothing |
| P3, `reverse_fee` | `the_operator_takes_a_wrong_fee_back_within_the_fees_charged_and_the_debt` | the same test |
| P5 | `a_subsidy_covers_at_most_48_hours_and_a_fee_all_the_time_since_the_last_settlement`; `a_subsidy_is_cut_at_48_hours_and_a_fee_covers_all_the_time_…` | |
| P4 | `the_audits_p4_case_a_lender_repaid_and_borrowed_from_again_earns_no_subsidy_for_the_gap` ($21.50 without `closes`, nothing with it); `a_borrow_that_reports_the_debt_before_it_is_charged_no_margin_…`; `closes_is_checked_as_the_report_is_…` | `a_borrow_that_passes_the_debt_before_it_earns_no_subsidy_for_a_lender_it_owed_nothing` |
| `migrate` | `migrate_keeps_everything_the_testnet_pool_holds_and_adds_the_limits_on_a_fee` (the 21 live values, in the source); `the_migrated_pool_settles_cuts_a_fee_to_its_budget_and_takes_one_back`; three refusals: a second run, the Phase 5 state, no state | `upgrade_pool_fees.rs` (new) |

**The upgrade in the sandbox** (`contracts/tests/tests/upgrade_pool_fees.rs`, on `contracts/target/live-pool-fees/`,
with the pool holding 6 NEAR): the new code alone can't read the state; `migrate` from the operator and from a
stranger is refused; the deploy with `migrate` as its init call succeeds and burnt 36.9 TGas in all. Afterwards
`get_params`, `get_pool`, `coin_statuses`, `versions` of both programs, and `get_borrower`, `debt_of` and
`get_pricing` of all 13 accounts answer what they answered, but for the three limits and `fees_reversed` "0". A
second `migrate` is refused. Then `gate2a` settles on from its record of 11 Nov and claims its credit from the live
token, `fund-rhea-11121507` borrows with `closes` and is charged nothing for the gap, its next fee is cut to a
budget of a tenth of a cent, and the operator takes 600 micro-dollars back.

**The stage 2 case is gone from `upgrade.rs`** (it has 6 cases, not 7): it migrated the Phase 5 pool, which this
code no longer reads.

**The deploy** (the pool first, signed by `pool.pbf.testnet`'s own key, as in stage 2):
`near contract deploy pool.pbf.testnet use-file contracts/target/near/pb_pool/pb_pool.wasm with-init-call migrate json-args '{}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send`
- **Before,** save `get_params`, `get_pool`, `coin_statuses`, `versions` for `pb-risk` and `pb-gateway`, and for
  each of the 13 accounts `get_borrower`, `debt_of` and `get_pricing`. Stop the keeper first, or a settlement in
  between changes an account's views.
- **After,** the code hash is `Ec3H4Mxd…` and every saved view answers the same, with these differences only:
  `pricing_limits` gains `"max_lender_debt":"1000000000000","account_fee_day":"1000000000","pool_fee_day_bp":50`;
  `get_pool` and each `get_pricing` gain `"fees_reversed":"0"`. `min_period_ns` is still 120000000000 and the
  funding order still `lender_first`. `lent_24h` and `subsidy_left_24h` move by themselves when an hour turns.
- **If `migrate` fails,** the transaction fails whole and the pool keeps its code and state.

**What the fix leaves:**
- **P3.** A wrong report can still add up to $1,000 a day to one client's debt, and 0.5% of capital a day in all,
  until the operator reverses it. Nothing raises an alarm; a `cut` above zero in a `settle` event is the sign.
  - A reversal doesn't give the day's budgets back, so honest fees can be cut for up to a day after one.
  - `reverse_fee` can't return a wrong fee the client has already repaid, nor the interest it carried.
  - Each limit can be set to any value, so an operator can lift all three.
  - A wrong report still earns a subsidy on up to $1,000,000 a lender, inside the subsidy budgets, as before.
- **P5.** The pool books a fee only when a settlement comes, so item 9 (the keeper settles every account that
  isn't pass-through) is what makes it timely. A long gap's fee is cut to the day's budgets, and the cut is lost.
- **P4.** `closes` ends the subsidy for the gap. An honest client can still be charged the margin for a gap, when
  the pool's last report still shows the old loan (item 10's case): a fee takes the larger of that and `closes`.
  **With P5 that charge now runs for the whole gap, not 48 hours,** up to $1,000 a day.
  - Accounts made before the new account code pass one figure, and are paid the gap's subsidy as before.
  - The pool doesn't check that `closes` shows less debt than `report`.

**For the main session:**
- `contracts/tests/tests/upgrade_audit.rs` line 56 asserts that the pool's built wasm is still `c4641c0e…`. It
  fails on the new wasm. Drop that line, or make it
  `assert_ne!(sha256_hex(&wasm("pb_pool")), LIVE_POOL_SHA256, "the pool's code is the new one");`.
- Not run by me: the account's, the factory's and the other sandbox suites (`account`, `lender`, `aave`, `moves`,
  `audit_fixes`, `rhea`, `upgrade`, `upgrade_stage3`, `upgrade_stage4`, `upgrade_audit`, `p4_closes`), and nothing
  outside `contracts/`.

#### Keeper, backend and gates

Items 9 to 11, built in the night of 12 to 13 Nov. The suites: keeper 191 to 202, backend 155 to 156, the stand-in
(54) and the client (12) as they were; `pnpm -r build` is clean. No service was started and no gate was run. Run
against testnet: two dry runs of gate 2 and one script of two view calls, all reads. The pool's and the account's
code was read as the other helpers left it; none of it was built or run from here.

- **Item 9 (P5): the hourly settlement, wherever the policy isn't pass-through** (`decide.ts`, the hourly check;
  `loop.ts`, `handle`). On the tick an account's hourly check is due, where the verdict shows no lender owed, the
  keeper reads the pool's `get_pricing` for it once. If the policy that applies (the account's own, else its
  tier's) is anything but `"pass_through"`, the settlement goes out behind that check, as it does where a lender
  is owed. A read that fails is logged, and that hour has no settlement.
  - **Reads added: one `get_pricing` an hour, for an account that has a loan and owes no lender.** None where a
    lender is owed (it settles anyway, so the policy isn't asked). None for an account with no loan.
  - **An account with no loan is not settled hourly.** The keeper asks no hourly check of it, and a settlement needs
    a fresh check: each would cost a check to book nothing, since no part has debt. Section 45.3 says "every
    account"; this is every account the hourly check goes to. Finished gate accounts keep the gate's policy
    (`fund-rhea-watch1` still shows the capped one), so the literal reading would send each of them a check an
    hour for good.
- **Item 10 (P4, "too soon"): one more check with the settlement behind it, twice at most** (`decide.ts`:
  `afterZeroSettle`, `Memory.zeroAgain`, both branches of `decide`; `loop.ts`: `settleRepaidLender`,
  `noteZeroSettle`).
  - **How the keeper learns the settlement was skipped: from that transaction's own logs, with no read.** The
    account's `settle()` answers only `true`, but the account logs the pool's answer: "the pool settled nothing:
    too soon: this account settled 88 seconds ago, and two settlements are at least 2 minutes apart". The pool's
    reason starts "too soon" for this case alone (`contracts/pool/src/settle.rs`).
  - **How it learns `min_period_ns`: the pool's `get_params().pricing_limits.min_period_ns`,** a plain number of
    nanoseconds (120000000000 on testnet today, read live). One view when the pool first skips, kept 10 minutes
    for all accounts, and the figure stays with the retry. If that read fails the keeper waits the pool's own
    default, 10 minutes, and says so.
  - **What happens.** The wait runs from the skipped try, which is never shorter than the pool needs. Until then
    nothing is sent, not even when another check lands. Then one check, with the settlement behind it; a lender
    repaid often leaves no loan, so this works with and without one. The pool takes it: over, and one read after
    the next check sees the zero. It skips it again: a second try, the same way. It skips that too: the keeper
    says so once and goes back to what it did before, a look after the account's next check. A check that fails
    keeps the try, which goes behind the check that is asked again.
  - A settlement the hourly rule sends is not tried again when it is skipped: only the one that reports a zero.
- **Item 11: types and views.**
  - **The keeper's `settle` line now says what the pool did** (`near-tx.ts`, `settlementIn`; `loop.ts`,
    `settleWords`). It used to log "settle() answered true" for every settlement. It reads the pool's own `settle`
    event from the logs (fee, subsidy, `cut`, credit, period), or the account's "the pool settled nothing: …". A
    `cut` above zero is said: "…; the pool's 24-hour fee limits took $0.000052 off it, which isn't owed later".
  - **Gate 2's two settlement steps read each try's own answer the same way** (`funding-steps.ts`, `stepSettle`;
    `funding-kit.ts`, `settleCheck`). The record keeps it per try (`pool`), and the step's detail has `cut` and
    `period_ns`. A settlement that booked the sum with a `cut` above 0 fails the step and names the limits to look
    at: the gate's sums are far too small to reach them. When the keeper's own settlement booked the sum first,
    the cut can't be read from the gate's try, and the step passes on the pool's record as before (`cut_unread`).
  - **The dry run says the pool's limits on a fee in one line** (`funding-kit.ts`, `feeLimits`), and stops on a
    lender debt counted at less than the account will owe, or a 24-hour fee budget of nothing. On the pool live
    tonight it reads "the pool has no limits on a settlement's fee: it is from before the pool's change of 12 Nov".
  - **The backend** (`services/api/src/pricing.ts`): `GET /api/pricing` has `fees_reversed` in `pool` and in each
    account's line, "0" where the pool has no such total. `limits` is the pool's `pricing_limits` as written, so
    the three new limits come through by themselves; so do `GET /api/pool` and the `pricing` of
    `GET /api/lender/:account`, which pass the pool's views on whole.
  - Types: `PricingView.fees_reversed` and `PricingLimitsView` (`funding-kit.ts`), `PoolPricing.fees_reversed`
    (`aave-kit.ts`).
- **Gate 2's fee and subsidy steps under the new rules, on its own figures of 12 Nov** (the run of 19:23,
  `research/data/phase6_funding_rhea.json`). Nothing changes in what the pool answers but the meaning of `cut`.
  - The borrow's own settlement is the account's first: it only stores its report, with `closes` or without.
  - `settle_fee`, try 1, 88 s later: "too soon", as before (2 minutes on testnet; the migration keeps that).
  - `settle_fee`, try 2: 5 points on $544.62 for 233 s is $0.000201, rounded up to **`fee` 202, `cut` 0**. The
    debt is far under `max_lender_debt` ($1,000,000), the fee far under `account_fee_day` ($1,000) and under the
    pool's day (0.5% of $10,000,000 is $50,000). A fee's period is now the whole time since the last settlement,
    which is those 233 s.
  - `settle_subsidy`: too soon, then **`subsidy` 176, `cut` 0** for 177 s; a subsidy's period and budgets are as
    they were.
- **The other gates' and scripts' reads of the pool: nothing to change.** Gate 3's settle step reads
  `get_pricing` for `settled_at`, `last` and the two totals, which stand. Gate 4 has no settle step and reads
  `debt_of` only. The hedge gate reads `get_pool`, `get_params().caps` and `get_borrower`, which stand. Nothing in the services calls the pool's `settle`: the
  keeper and the gates call the account's `settle()`, which takes no argument, and only the account's borrow step
  passes `closes`. The backend's activity feed reads the pool's `borrow` and `repay` events only, so a
  `reverse_fee` isn't shown there.
- **`keeper-one` needs no name any more** (`config.ts`, `accounts.ts`, `.claude/launch.json`). The keeper takes
  `--newest <n>`: watch only the n accounts the factory made last (it lists them oldest first, and the keeper reads
  the list once a minute). `keeper-one` now runs `--newest 1`, so it follows whichever account was made last: a
  gate's new one, then the next gate's, then the click-through's. For an older account, `--account <id>` stands;
  the two can't be given together. While a run is under way, a newer account made by anyone takes the keeper away
  from it; `--newest 2` keeps both.
- **Tests, each failing with its change undone:**
  - `decide.test.ts`, "…item 9: the hourly settlement goes out for an account whose policy isn't pass-through…",
    and `loop.test.ts`, "…item 9, tick by tick…": one read on the hour and one settlement behind the check; no
    read between hours; no settlement once the policy is gone or can't be read; no read where a lender is owed.
  - `decide.test.ts`, "…item 10: a zero settlement the pool skipped as too soon is tried again…", and
    `loop.test.ts`, "…item 10, tick by tick…" and "…a pool that keeps answering too soon is asked twice more and
    no further…": the skip read from the logs, one read of the pool's time, nothing for 120 s, then the check and
    the settlement; two tries at most; the 10-minute default.
  - `loop.test.ts`, "…item 11: the pool's answer to a settlement is read from the transaction's logs…", with the
    two real log lines of 12 Nov, and the words for a cut.
  - `funding-steps.test.ts`, "…item 11: gate 2's fee step, on its own figures of 12 Nov…", and
    `funding-kit.test.ts`, the two tests of `feeLimits` and `settleCheck`.
  - `state.test.ts`, the pool's two views as the keeper reads them; `loop.test.ts`, "--newest…".
  - `services/api/src/pricing.test.ts`, "…item 11: GET /api/pricing passes on the pool's three limits on a fee,
    and the fees the operator took back…".
- **Seen and left:**
  - **A fixed-rate loan repaid to our pool leaves its last part-hour unsettled** until the account's next
    settlement, since no hourly check goes to an account with no loan. Under the new period rule that fee no
    longer lapses; it waits. One last settlement when such a loan ends would close it, at the cost of a check.
  - **The four old accounts** (section 44.1) still cost the full keeper two reads a tick each and aren't watched.
    `keeper-one` doesn't read them.

## 46. The pool's fixes live on testnet (12 Nov, night)

**Deployed on 12 Nov, 21:40 to 21:43 UTC.** The steps and the log are `research/pool_fees_deploy.md`; the user
approved each signed one. The engine and the gateway didn't change: nothing was published on OutLayer and the
factory's settings stayed.

**Deployed, each checked:**
- **The pool** (`pool.pbf.testnet`): new code with `migrate` as its init call, one transaction
  (`3kspWJHLMCUK3uHfe1YcayYLx7viS96nYinJvAC31NxG`). The code on chain is the built file: sha256 `ca21d533…`, code
  hash `Ec3H4MxdZUE1c41SBaFJ41DPPW8LkA3h14AuJL1Zjp9H`. Every view of all 13 accounts was saved before and read
  again after. The only differences: `pricing_limits` gains `max_lender_debt` "1000000000000", `account_fee_day`
  "1000000000" and `pool_fee_day_bp` 50; `get_pool` and each `get_pricing` gain `fees_reversed` "0"; the code hash;
  the storage (+14,675 B). `min_period_ns` is still 2 minutes and the funding order `lender_first`.
- **The factory** (`pbf.testnet`): a plain redeploy (`HUpN4TDEdvWSu2e4kg14tMfkKAJJRnjFQ5wZuUCej2J`). Code on chain:
  sha256 `2cb452a5…`, code hash `41WRCFh8VJRCNwPVPVvWYiZBRvXPexBBZTJwLD6joq4k`; `account_code_hash` `b8acf77b…`;
  config and accounts unchanged.

**Which account has what, from here:**

| Made | Audit fixes (40) | Band | The account's part of P4 (`closes`) |
|---|---|---|---|
| Before 12:36 UTC on 12 Nov | no | 1% | no |
| 12:36 to 14:35 | yes | 1% | no |
| 14:35 to 21:42 | yes | 3% | no |
| From 21:42 | yes | 3% | yes |

The pool's limits on a fee, the fee's period and `reverse_fee` apply to every account.

**Four changes to the gates' own scripts, made during the sitting** (`services/keeper/src`; test scripts, not the
product; the keeper's suite went from 202 to 203):
1. **`stepApprove` reads Hyperliquid's list of agents first** and signs nothing when the agent is there. Hyperliquid
   takes an agent's approval once: a second is answered "Extra agent already used", and a retry of a post it had
   already taken "duplicate nonce".
2. **`stepCloseShort` doesn't fail on a float it can't flatten.** A leftover under Hyperliquid's $10 minimum (0.00011
   BTC, $8, from an earlier run) made `float-close` exit 2. The step is about the account's short; the float's
   leftover is written into the step's detail and named again at the end of the run.
3. **`gatePx` holds a price inside Hyperliquid testnet's own limit** where that is nearer than the gateway's band
   (`HL_TESTNET_REACH_BP` 240; `PriceFacts.venueBp`, set by `priceFacts`). Hyperliquid's docs name the refusal
   ("Price too far from oracle") and give no figure. Seen on 12 Nov: a buy matched asks 2.44% over the oracle and
   stopped before one 2.55% over; buys 2.7% and 2.8% over were refused whole; a buy 2.3% over was taken. So the
   limit looks like 2.5%, and the gates stay a tenth inside it. Under the 3% band the gates priced a close 0.3%
   over the mark, which is past that limit whenever the mark stands more than 2.2% over the oracle. With this the
   hedge can open and close while the best bid is under 2.4% over the oracle.
4. **`runMove` asks the quote again what check a move needs** when the account answers "the verdict was already
   used" and the first quote had named no check. The pool's part of a funding plan is in the pool's books one hop
   before the account's own `loan` record: a quote read in between says "no loan, no check".

**Seen and left:**
- **The backend's `needs_check` reads the account's `loan` record,** so for about a second after the pool's part of
  a plan lands, a quote for a move names no check. In the app a client would have to start a move inside that
  second; the account then answers "the verdict was already used: ask for a new check", and a second click works.
- **The stand-in matches a deposit on Aave's chain to the oldest open quote of the same token and amount.** Its
  quotes there share one deposit address (the float's). A run that takes a committed quote, fails before sending,
  and takes a second for the same amount is then delivered under the first quote's id. The real 1Click gives each
  quote its own address.

### 46.1 Gate 4 passed on the new code (12 Nov, 22:12 to 22:36 UTC)

`fund-move-11122212.pbf.testnet`, made after the factory's redeploy, with `keeper-one`. Record:
`research/data/phase6_funding_moves.pool-fixes-2026-11-12.json`. **It passed on its third start; the two stops were
in the gate's script and the stand-in (items 4 and the second "seen and left" above), not in a contract.**

- **The run:** 0.00055144 test nBTC moved to Aave's chain as 0.0195 wrapped test ETH (Aave's test WBTC pool is still
  full). One `fund`: $21.71 from Aave at 0.74% and $99.38 from our pool. The keeper ran the three steps. The Aave
  borrow step's settlement went to the new pool with `closes` (the pool's event shows a pass-through settlement,
  fee 0, `cut` 0). The loan came home to NEAR, went back, Aave and our pool were repaid, the collateral came home
  as nBTC, and both tokens were withdrawn. The float used 0.002 test ETH.
- **Stop 1, 22:18, `loan_home`:** "the verdict was already used: ask for a new check". The quote had named no check
  (item 4). Nothing had moved.
- **Stop 2, 22:31, `loan_home`:** the script waited 10 minutes for the second quote while the stand-in had
  delivered the $21.70 under the first one at 22:22. On chain the account held it and listed no move, so the third
  start took the step as done ("the loan is in the account") and ran the rest in 4 minutes.
- **Checked afterwards, apart from the script:** on NEAR the account has no loan, holds neither token, and the pool
  is owed 0. On Base Sepolia Aave shows no debt and dust of collateral; the address holds 0.995 USDC (the 1 USDC
  taken over what Aave was owed) and 0.002 ETH of gas; the float holds 0.04199 test ETH (0.04399 before).

### 46.2 Gate 2 passed in full on the new code (12 Nov, 21:48 to 23:12 UTC)

`fund-rhea-11122148.pbf.testnet`, made after the factory's redeploy, with `keeper-one`. Record:
`research/data/phase6_funding_rhea.pool-fixes-2026-11-12.json`: all 26 steps passed. The lending steps ran from
21:53 to 22:03; the last three waited an hour for Hyperliquid testnet and ran at 23:11.

| Step | Result on the migrated pool and the new account code |
|---|---|
| `fund` | $1,052.37 in one client signature: $544.17 from Rhea, $508.21 from our pool. The Rhea borrow step settled with `closes` |
| `settle_fee` | a fee of 206 micro-dollars for 238 s, `cut` "0" |
| `settle_subsidy` | a subsidy of 174 micro-dollars for 175 s, `cut` "0" |
| `top_up` | the keeper alone repaid Rhea after the test price fell, 65 s |
| `repay_rhea`, `repay`, `credit`, `rhea_withdraw` | passed. The pool's own record: `fees_charged` "206", `fees_reversed` "0", `subsidy_paid` "174", nothing owed, Rhea's debt 0 in its last report |
| `close_short` | first try, 22:03: **stopped.** Hyperliquid refused six of eight close orders, "Price too far from oracle" (its mark stood 2.4% over its oracle); 0.00073 BTC closed. Second try, 23:11, with the mark 1.48% over: "buy 0.01427 BTC at 72814 (IOC)" filled whole at $72,693.40, 26 s |
| `home` | $440.53 left Hyperliquid, $440.26 delivered on NEAR, 57 s |
| `withdraw` | both tokens out; the account holds neither |

**Checked afterwards, apart from the script:** the account's Hyperliquid address is flat (value $0.01); on NEAR it
has no loan, holds neither token, and the pool is owed 0; at our Rhea copy it has no collateral and no debt. The
stand-in's float holds $781.50 on Hyperliquid and a short of 0.00011 BTC, under Hyperliquid's $10 minimum. The
three services were stopped at 23:13.

**What the hour's wait was.** From about 21:45 to 22:50 Hyperliquid testnet's best bid stood 2.4 to 2.5% over its
oracle price, at its own limit (item 3 of section 46), so no buy that could fill was allowed. By 23:08 the mark
was 1.45% over. Our gateway's 3% band took every order both times.

**Also left:** `fund-rhea-11122143.pbf.testnet`, the first start, stopped at `to_hl` when Hyperliquid testnet's API
answered 502 for 90 seconds (21:44:50 to 21:46:20). It lists `move:0`, and its $430 of test mUSDC stays with the
stand-in.

## 47. The account's Low findings (A10, A11, A12, A13, A15, A16, A17). The shapes, fixed on 12 Nov before building

The user's word on 12 Nov, about 22:45 UTC: fix the seven left open in `research/audit.md`'s second pass. All of it
is in the account contract, with small changes in the keeper and the backend. **The pool, the engine and the gateway
don't change:** no pool deploy, nothing published on OutLayer, no `set_config`. The factory is redeployed plainly,
so the fixes reach accounts made after it. Each fix has a test that fails on the code as it is.

No stored record of an existing account matters (accounts never take new code), but **every view an older reader
uses keeps its fields**: new fields are added, none renamed or removed. The engine reads `get_state` and refuses no
unknown field.

### 47.1 A10: a bump's fees

`evm_bump(nonce, max_fee, tip)` keeps its arguments. New rules, for every caller:
- `max_fee` is at least a tenth above the kept one (as today) and **at most an eighth above it** (kept × 1.125,
  rounded down; never under kept × 1.1 rounded up, so one value always fits). So each bump uses one of the seven
  steps of room and no more, whoever calls.
- `tip` is at least a tenth above the kept one and at most `max_fee` (as today).
- **Anyone but the owner waits 60 seconds** from the block time the kept transaction was signed. The owner bumps at
  once.
- The keeper sends `max_fee` = the kept one × 1.1 rounded up (it sent the limit), keeps its own rule for the tip,
  capped at that `max_fee`, and bumps no sooner than the contract allows.

### 47.2 A11: a signer call that failed

When the signer's call fails or times out, a listed borrow, withdrawal or transfer on Aave's chain **stays listed**,
as it does today when the signer answers something unreadable: a signature may still become public. It is dropped
when a verdict shows the chain has used that nonce (as today).
- The step may run again, and the owner's own call may be made again, **with the same nonce, while that listing is
  there**: its own stale listing never blocks a transaction's second signing. Signing the same nonce again replaces
  the listing and doesn't add one; the listing keeps the larger amount of the two.
- If that can't be made safe (a listing that would block its own retry for good), say so and leave A11 as it is.

### 47.3 A12, the rest: `sell`, `home`, `e_home`

A transfer's record gains an optional `expect`: `{"token": "<a listed NEAR token>", "amount": "<units>"}`, what the
quote says will arrive on NEAR.
- Where it comes from: `hl_withdraw` and `evm_withdraw` take an optional last argument `expect`; `withdraw`'s
  `transfer` object takes an optional `expect` for a `sell`. A plan step's `sell` and `home` have none (the step
  carries no amount out).
- With `expect`, a deposit with the transfer's msg settles it as **arrived** only when it is that token and at least
  80% of that amount, and as **refunded** only when it is the token sent and at least 80% of the amount sent.
  Anything else with the msg is kept as a plain deposit and the record stays, as section 40's rule for `to_hl` and
  `to_evm`.
- Without `expect`, as today.
- `expect` is refused when its token isn't listed or its amount is 0. `to_hl` and `to_evm` take none.
- The backend adds `expect` to the `next` call of a `home` and an `e_home` quote: the token and amount of its
  `delivers`. Old accounts ignore the unknown argument.

### 47.4 A13: a fee that lands between a repayment and its result

The account counts its loan record's changes (a private counter; not a new field of `loan` in any view). A loan
from the pool and a settlement's fee each move it on. A repayment remembers the count when it is sent, and
`on_repaid` gets it back:
- count unchanged: as today (a repayment that came back partly unused closes the loan).
- count moved: the principal comes down by what the pool used, and **the loan stays open** whatever came back. The
  next repayment that comes back unused closes it.

### 47.5 A15: a plan that is replaced before the keeper can run it

A stored plan (a top-up's or an unwind's; not a funding plan) **is kept, and a newer verdict's plan dropped,** when
all of these hold:
- the stored plan has a step that hasn't run;
- the newer verdict was read fewer than `KEEP_PLAN_BLOCKS` = 100 blocks after the stored plan's;
- the newer verdict's action is the stored plan's, and its plan has the same steps in the same order by kind,
  lender and token (amounts and quotes may differ).

A plan of a more severe action replaces it at once (REBALANCE, then REBALANCE_NOW, then DELEVERAGE), a HEALTHY
verdict still clears it, and a plan of another shape replaces it.
- A kept plan's `l_add` asks today that the latest check is the one that ordered it. It now asks that the latest
  check **orders the same step**: the plan remembers the block of the newest verdict that confirmed it (a verdict
  whose plan had the same shape), and the step runs when the held verdict is that one.
- Every other rule of a step stands: fresh verdict, current counter, each step once.

### 47.6 A16: the account's own NEAR

`withdraw` pays a new receiver's token registration (0.00125 NEAR) only while the account keeps a reserve: its
balance less what its storage locks, after the payment, is at least `NEAR_RESERVE`. Below that, the transfer goes
out without the registration, and fails for a receiver the token doesn't know (`on_sent` then undoes it, as today).
- `NEAR_RESERVE`: enough storage for the largest verdict and a full `pending` list, and at least 0.3 NEAR; the
  builder works out the figure and says how.
- A plan step's own sends (the unwind) pay the registration as today, with no reserve.
- No caller changes.

### 47.7 A17

1. **A stranger's repayment at Aave on an old verdict: no change.** It is bounded already: once one such repayment
   is signed, the next waits until a verdict shows it mined (section 40, A9).
2. **`allow.withdraw` as a JSON number: no change.** The contract reads it exactly; the format is the engine's.
3. **The permission's rate and cushion, on chain, at an `l_borrow` step** (both lenders), from the held verdict's
   line for that lender: refused when its rate (`r_bp`) is above `max_rate_bp`, and when the lender is owed already
   (`d` above 0) and its cushion (`hf_bp`) is under `min_hf_bp`. A top-up never asks. `moves` stays unread: the
   engine plans no move.
4. **The pool's pause and step limit.**
   - `l_borrow`: when the pool's settlement answers that the pool is paused, the step stops: nothing is borrowed
     at the lender, and the step may run again.
   - A top-up's `l_repay` and `l_add` **at Rhea** ask the pool's `check_step` first, with the NEAR token and amount
     they send, as a transfer step does: a paused pool or a day's total past the step limit refuses it, nothing
     moves, and the step may run again.
   - A top-up **at Aave** is unchanged: it spends what is already at the account's address on Aave's chain.
   - An `l_supply` is unchanged: the owner starts it with `fund`, and while the pool is owed it needs a verdict.

### 47.8 What must pass again

Every suite. The factory's redeploy tested over its saved live code and state. Then gate 2 (its `top_up` runs the
changed path) and gate 4, each on a new account.

### 47.9 As built

(Each part adds its notes here.)

#### Keeper and backend

Built in the night of 12 to 13 Nov, to section 47 as written: the account's new code wasn't there to read or run
against. The suites: keeper 203 to 205, backend 156 to 157; `pnpm -r build` is clean. No service was started, no
gate was run, and nothing was sent.

- **A10 (47.1), changed** (`services/keeper/src/decide.ts`, the bump; `evm.ts`, `readEvm`).
  - `max_fee` is the kept transaction's fee limit and a tenth, rounded up: the lowest the account takes. It was the
    config's whole limit. Seven such bumps fit under the limit from a first try at half of it, so `MAX_BUMPS` is 7
    (it was 3).
  - The tip is still ten times the kept one (at least 10,000,000 wei), now capped at that new `max_fee`, not at the
    config's limit.
  - No bump within 60 s of the kept transaction's `signed_at`, by the chain's clock. The keeper didn't read
    `signed_at` before; `readEvm` now does (`signedAtMs`). The keeper's own wait is still three minutes from when
    it first saw the transaction unmined, or from its last bump, so the 60 s only bite when the owner has just
    bumped it.
  - When a tenth more would pass the config's limit the keeper says so once and sends nothing.
  - An account from before 47.1 takes the same values.
- **A12 (47.3), changed** (`services/api/src/hl-handlers.ts`: `nextCall`, `postEvmMoveQuote`, new `expectOf`). The
  `next` call of a committed `home` and `e_home` quote has `expect: {token, amount}` as its last argument, beside
  `exp`: the NEAR token and the quote's `amountOut` in that token's units (for `e_home`, the answer's own
  `delivers`). It is left out when the quote names no amount above 0 or a token the backend doesn't list, and for
  `to_hl` and `to_evm`.
  - **Who else builds those calls.** The gates and the fault script pass the backend's `next.args` on whole
    (`hedge-steps.ts` `stepHome`, `moves-steps.ts` `runMove`, `fault-run.ts`), so `expect` goes with them. The
    keeper builds neither call. `aave-steps.ts` `stepEvmOut` calls `evm_withdraw` with no `exp`: it records no
    transfer, so it has nothing to expect.
  - **The web app builds both by hand and drops `expect`:** `web/src/lib/tx.ts` 258 (`hlWithdrawTx`) and 206
    (`evmWithdrawTx`); their callers `web/src/components/move-usdc.tsx` 238 and `web/src/lib/moves.ts` 183; the
    type of `next` in `web/src/lib/api.ts` 104 and 105; and the preview's stand-in,
    `web/src/app/dev/home/moves-standin.ts` 107. Not changed from here.
- **A15 (47.5), one change.**
  - **The keeper already runs the stored plan:** `readPlan` reads `get_state().plan`, and every `execute_step`
    carries that plan's `pid`. It never ran a verdict's own plan.
  - **A refusal's words were never read:** any `execute_step` the account refuses leads to one check for a new
    plan, whatever it says.
  - **Changed: the keeper's own rule for `l_add`** (`decide.ts`, `ordersSamePlan`; `state.ts`, `toVerdict`). It held
    an `l_add` back unless the held verdict's block was the plan's id, which is the old account's rule. Under 47.5
    a kept plan has an older id, so the keeper would never have run its `l_add`. It now also runs it when the held
    verdict's own plan has the stored plan's action and the same steps by kind, lender and token: the account's
    own test for keeping a plan. On an older account that case can't arise (a newer plan replaces the stored one).
  - **Left:** a step the account refused under a kept plan isn't tried again while the plan keeps its id; the
    check the keeper asks for brings a new id only when it is read 100 blocks or more after the plan's.
- **A17 (47.7, items 3 and 4), one change.**
  - **An `l_borrow` refused for the permission's rate or cushion, or stopped because the pool is paused: nothing
    to change.** A funding step that doesn't go through is tried three times in all, 15 s apart (each try after a
    paused pool needs a fresh check first, since the counter moved), logged each time with the account's own
    words; then the keeper stops the plan with one note and the client can ask again. It doesn't start again by
    itself if the pool is unpaused inside the plan's 30 minutes.
  - **Changed: a top-up step that doesn't go out** (`decide.ts`, `TOP_UP_AGAIN_MS`, `PlanRun.gaveUpAt`). Before, three
    tries were followed at once by a check, whose new plan got three more: three transactions and a check about
    every two minutes for as long as the pool stayed paused or over its day's step limit. Now the keeper says once
    that the step didn't go out, with the account's words, and asks for the new plan three minutes later (the
    main session shortened the first build's ten: three minutes is past the 100 blocks a kept plan lasts, and a
    client who needs the top-up shouldn't wait longer). This also slows the same loop for a top-up that moved
    nothing for any other reason (no USDC in the account).
- **Tests, each seen to fail with its change undone:**
  - `decide.test.ts`, "…47.1 (A10): a transaction that stays unmined is signed again…" (it replaces the stage 3
    test of the old rule): the seven fee limits and tips, the rounding up, the limit reached, the minute after
    signing. `evm.test.ts`: `signed_at` read as `signedAtMs`.
  - `decide.test.ts`, "…47.5 (A15): the keeper runs the account's stored plan under its own id…".
  - `decide.test.ts`, "…47.7: a top-up step our pool refuses…".
  - `services/api/src/hl-handlers.test.ts`, "…47.3 (A12): the next call of a move home carries `expect`…"; the two
    older tests of `home` and `e_home` now expect it too.

#### Web app

Built on 13 Nov, to 47.3 as written. The app's suite went from 225 to 227, with lint and build clean. No server was
started and nothing was sent; the account's new code wasn't run against.

- **The two calls that bring money home pass the quote's `expect` through** (`web/src/lib/tx.ts`): `hlWithdrawTx` and
  `evmWithdrawTx` take a last argument `expect` (`MoveExpect`: `{token, amount}`) and put it in the call's JSON
  beside `exp`. With none, the call has no `expect` key at all. Only the two fields go out.
- **No version switch.** The app sends it whenever the quote's `next.args` carries it, and an older account ignores
  it. A quote from an older backend carries none and sends none.
- **Callers:** `web/src/components/move-usdc.tsx` (`Home`, the USDC home from Hyperliquid) and
  `web/src/lib/moves.ts` (`nextTx`, the two moves home from Aave's chain). "Send a token out" is `evm_withdraw`
  with no quote, so it sends neither `exp` nor `expect`.
- **Types:** the `hl_withdraw` and `evm_withdraw` shapes of `MoveQuoteAnswer.move.next` gain an optional `expect`
  (`web/src/lib/api.ts`).
- **The preview's stand-in** (`web/src/app/dev/home/moves-standin.ts`) puts `expect` in a move home's quote, as the
  backend does: the token and amount of its `delivers`.
- **Tests,** each seen failing before the change:
  - `web/src/lib/tx.test.ts`: "the two calls that bring money home carry the quote's `expect`, and no `expect` key
    without one" (both builders).
  - `web/src/lib/moves.test.ts`: "a move home passes the quote's `expect` through to evm_withdraw, and sends none
    when the quote has none" (the caller for Aave's chain).
  - The Hyperliquid caller is a component with no unit test: its builder is covered, and the type check holds the
    argument in place.

#### Account

Built on 12 Nov, 22:54 to 23:36 UTC: A13, A16, A17 point 3, A10, the rest of A12, A17 point 4, and A15 (added last,
once the keeper's side was known). Left out whole: A11. The account's unit tests went from 398 to 410. Nothing was
deployed.

- **47.4, A13: built.** A private stored field `loan_seq` (the last; no view shows it). A loan from the pool and a
  settlement with a fee each move it on. `repay_pool` passes it to `on_repaid(amount, seq)`. When the count has
  moved, `on_repaid` takes what the pool used off the principal and leaves the loan open, and logs "repaid N: new
  debt to the pool was booked meanwhile, so the loan stays open".
  Test: `a_fee_booked_while_a_repayment_is_on_its_way_keeps_the_loan_open` (seen failing with the rule switched
  off).
- **47.6, A16: built.** `NEAR_RESERVE` = 0.3 NEAR. How: a verdict is at most 4,096 bytes of JSON, kept as read and in
  fields, under 9 KB; a full `pending` is 8 transfers of about 220 bytes, 8 Aave listings of about 100 and a borrow,
  under 3 KB; together 12 KB, which locks 0.12 NEAR, so the floor of 0.3 decides. The owner's `withdraw` pays the
  0.00125 NEAR registration only when the balance less what storage locks, less that payment, is at least the
  reserve; otherwise only `ft_transfer` goes out. A plan step's sends pay it as before.
  Test: `a_withdrawal_pays_a_new_receivers_registration_only_while_the_account_keeps_its_near_reserve`.
- **47.7 item 3, A17: built.** At an `l_borrow` step, from the held verdict's line for the step's lender and the
  stored permission: "Rhea's rate (2501 bp) is above the 2500 bp the permission allows" (or "Aave's"), and, when
  `d` is above 0, "the cushion at Rhea (14999 bp) is under the 15000 bp the permission asks for".
  Test: `a_borrow_step_holds_the_lender_to_the_permissions_rate_and_cushion`.
- **47.1, A10: built.** `max_fee` at most `max(kept + kept / 8, kept + ceil(kept / 10), kept + 1)`: "a bump raises
  the fee by an eighth at most: N wei a gas". A caller who isn't the owner, before `signed_at` + 60 s: "anyone but
  the owner bumps a transaction once it is 60 seconds old: wait N s". Both come after the older checks, so those
  refusals read as before. A bump's own `signed_at` starts the minute again.
  Test: `a_bump_raises_the_fee_by_an_eighth_at_most_and_anyone_but_the_owner_waits_a_minute`.
- **47.2, A11: left as it is.** Keeping the listing after a failed signer call can't be made to work in the account
  alone. The engine counts a listed borrow as debt and a listed withdrawal as collateral gone (section 33), so the
  check for the second try gives the lender no room, or allows no withdrawal, while the listing stands. The step
  could then run again only after someone used that nonce on Aave's chain with another transaction. A signer
  time-out, which happens on testnet, would stall a funding plan. It needs the engine to know a listing whose
  nonce no kept transaction has, and the engine doesn't change in this round.
- **47.3, the rest of A12: built.**
  - `Expect {token, amount}` (`plan.rs`): `token` a listed NEAR token id, `amount` a string of its units.
  - `hl_withdraw(amount, destination, source_dex, exp, expect)` and `evm_withdraw(token, amount, to, exp, expect)`
    take it as the last, optional argument. `withdraw`'s `transfer` takes it as `{"kind": "sell", "exp": N,
    "expect": {"token", "amount"}}`.
  - A pending transfer shows `"expect": {"token", "amount"}` when it has one, and no such key when it has none.
  - `ft_on_transfer`, for a `sell`, `home` or `e_home` with `expect`: arrived only for that token and
    `amount × 5 ≥ expect × 4`; refunded only for the token sent and 80% of what was sent; anything else logs "kept
    as a deposit: not the delivery or the refund of transfer <id>" and the record stays. Without `expect`, as before.
  - Refusals: "expect names a token that isn't allow-listed", "expect's amount must be positive", "only a sell move
    takes expect" (a `to_hl` or `to_evm`).
  - **Beyond 47.3:** `expect` without `exp` on `hl_withdraw` or `evm_withdraw` is refused ("expect needs exp: only a
    recorded move expects a delivery"), since nothing is recorded to hold it. The backend's quotes always send both.
  - Tests: `a_move_that_says_what_to_expect_is_settled_only_by_a_credible_delivery_or_refund` (seen failing with the
    rule switched off), `expect_names_a_listed_token_and_an_amount_and_only_a_recorded_sale_or_move_home_takes_it`;
    on the built contracts, `a12_a_sale_that_says_what_to_expect_is_settled_only_by_a_credible_delivery`
    (`contracts/tests/tests/audit_fixes.rs`), with real token transfers.
- **47.7 item 4, A17: built, both halves.**
  - **The pause at `l_borrow`.** `on_step_settled` treats the pool's answer `{"skipped": "the pool is paused…"}` as
    not settled: nothing goes to Rhea, no signature is asked for Aave, the listing is dropped and the step may run
    again. It matches the start of the pool's own text, "the pool is paused". Any other skip counts as before.
  - **A top-up at Rhea.** `l_repay`: once the account's USDC is read, `on_repay_ready` calls the pool's
    `check_step(plan_id, step, token, amount)` with the USDC token and the amount it will send (the smaller of the
    step's and the balance), and a new callback `on_repay_checked(pid, i, amount)` repays. `l_add`: `execute_step`
    bumps the counter, calls `check_step` with the step's token and amount, and a new callback
    `on_add_ready(pid, i, token, amount)` posts the collateral. A refusal by the pool logs "step i of plan pid
    didn't go out, as the pool refused it: nothing was sent, and it may run again" and reopens the step.
  - Gas: `on_repay_ready` 145 TGas (was 125), `on_repay_checked` 120, `on_add_ready` 130. In the sandbox an `l_add`
    burnt 20.2 TGas in all and an `l_repay` 29.8.
  - **What follows from the pool's own `check_step`,** which this round doesn't change: an `l_add` needs the
    operator's step price for the collateral token ("no step price is set for this token" otherwise); a top-up
    counts toward the $50,000 a day, at that price; and an account the pool blocked after a write-off gets no
    top-up at Rhea, its `l_repay` included.
  - Tests: `a_paused_pool_stops_a_borrow_step_at_either_lender`, `a_top_up_at_rhea_asks_the_pools_check_step_first`;
    the four older tests of Rhea's top-up steps follow the new calls. On the built contracts
    (`contracts/tests/tests/lender.rs`, the top-up test): the paused pool refuses the `l_repay`, nothing reaches
    Rhea, and after the pause it runs and the pool's `step` event counts $10,000, $47,500 for the day. That world
    now sets a step price for mNBTC.
- **47.5, A15: built.**
  - `KEEP_PLAN_BLOCKS` = 100 (`plan.rs`). `store_plan` keeps the stored plan and drops the verdict's when the stored
    one has a step not run, the verdict's `blk` is under the stored `pid` + 100, the action is the same, and the
    steps are the same in number and order by `k`, `l` and `tok`, compared in lower case (`Plan::same_shape`). It
    logs "plan P kept: the check read at block B orders the same steps" and emits no `plan_stored`.
  - The stored plan remembers that verdict's block in a private field, `confirmed`, which starts at its own `pid`.
    No view shows it: `get_state().plan` is unchanged.
  - Any other action replaces the plan at once, a more severe one included; another shape replaces it; a plan with
    no step left is replaced at once; a HEALTHY verdict with nothing to do still clears it; the same-block rule
    stands.
  - A top-up's `l_add` runs when the held verdict's `blk` is the plan's `pid` or the remembered block, and under
    no other verdict. Its refusal keeps its words. Every other check of the step stands.
  - `l_repay` and the unwind's steps compare the held verdict with nothing but the plan's id in the call, so a
    kept plan's steps run under a newer verdict with no change.
  - Tests: `a_newer_check_that_orders_the_same_steps_keeps_the_stored_plan_for_100_blocks`,
    `a_plan_with_no_step_left_is_replaced_at_once_and_a_healthy_check_still_clears_a_kept_one`,
    `a_kept_plans_l_add_runs_under_the_newer_check_that_orders_it_and_under_no_other` (each seen failing first),
    and `a_plan_of_another_shape_or_a_more_severe_action_replaces_the_stored_one_at_once`, which guards what
    already held. On the built contracts, `contracts/tests/tests/lender.rs`: the check that orders the top-up
    again keeps the plan's id, and its `l_add` runs.
- **Builds** (`contracts/build.sh --sizes`):
  - account 535,378 B, `79827e65a44d0edb1c640ea4401c3fcdf53e22aed10e7339b7e40a98f6470ea4`;
  - factory 768,255 B, `66cb907098640365ae9c52762e90ae548d9f35958b8a81d893201d9f449c3a95`;
  - pool unchanged, `ca21d533…`.
- **6 NEAR now leaves a new account 0.61 NEAR free** (it was 0.81 before this round: the account's code grew by
  20 KB), and 0.50 after Rhea's registration. The sandbox bars moved to 0.6 at opening and 0.45 after the first
  Rhea loan. The opening bar passes by 0.009 NEAR: a kilobyte more code trips it. `MIN_DEPOSIT` wants 7 NEAR at the
  next change of the factory's source.
- **The Aave sandbox test and the Node vector** follow A10: the owner bumps to 550,000,000 wei
  (`supply_bumped` in `contracts/account/src/evm_vectors.json`).

### 47.10 At the join (12 Nov, 23:14 to 23:45 UTC). Built and tested; NOT deployed

**What is in the code:** A10, the rest of A12, A13, A15, A16, A17 items 3 and 4. **What is not:** A11 (its fix
needs the engine: a listing kept after a failed signer call is counted by the engine as debt or as collateral gone,
which holds back the step's own second try). A17 items 1 and 2 need no change.

**The main session's own runs on the joined code:**
- `contracts/build.sh --sizes`: account 535,378 B `79827e65a44d0edb1c640ea4401c3fcdf53e22aed10e7339b7e40a98f6470ea4`;
  factory 768,255 B `66cb907098640365ae9c52762e90ae548d9f35958b8a81d893201d9f449c3a95`; pool 478,954 B
  `ca21d533…`, the live one. The same hashes as the account's helper reported.
- Contracts, whole workspace: 696 passed, 0 failed (682 before): account 410, pool 137, and every sandbox suite,
  with `upgrade_low.rs` (new): the live factory `2cb452a5…`, with its state of 22:55 UTC, takes the new code with
  no init call, refuses `migrate`, answers every view as before, and makes an account that runs the new code with
  the live pool and tokens.
- JavaScript 655: keeper 205, backend 157, stand-in 54, its client 12, app 227. `pnpm -r build` and lint clean.
- The engine wasn't touched (329).

**Read line by line** against the saved source: `lib.rs` (307 changed lines) and `plan.rs` (28). `types`, `pool`
and `factory` sources are byte for byte what they were.

**One change the main session made to a helper's work:** the keeper's wait after a top-up that didn't go out in
three tries is 3 minutes, not the 10 first built (`TOP_UP_AGAIN_MS`).

**Read on testnet (22:55 UTC, the pool's saved state):** the pool holds no step price for any token. So after the
deploy a top-up that posts test bitcoin at Rhea (`l_add`) is refused until the operator sets one
(`research/low_fixes_deploy.md`, step 2). A top-up that repays in USDC needs none.

**What the deploy needs, in one sitting** (`research/low_fixes_deploy.md`): the factory's plain redeploy
(keychain); `set_step_price` for `mnbtc.pbf-ops.testnet` (keychain, the operator); about 11 test NEAR in the
keeper; then gate 2 and gate 4 on new accounts. Until then testnet runs the code of section 46.

### 47.11 On testnet (13 Nov, 09:53 UTC). Both gates passed on this code (10:30 and 10:55 UTC)

- **The factory** `pbf.testnet` was redeployed at 09:53:31 UTC (transaction
  `5bcvE6vsaieHAjXvFFPeCSpZRmaTU4bzmAstoZ8sZtV7`): code `66cb907098640365ae9c52762e90ae548d9f35958b8a81d893201d9f449c3a95`,
  carrying account `79827e65a44d0edb1c640ea4401c3fcdf53e22aed10e7339b7e40a98f6470ea4`. A plain redeploy: its
  config, its 16 accounts and its pause flag answer byte for byte as before. Accounts made before keep their code.
- **The pool** holds a step price for `mnbtc.pbf-ops.testnet` since 09:53:56 UTC: $80,000 a coin, 8 decimals
  (transaction `4rByENy1LMCqV4EpFNUoBDMakj8AkPqJPZQcjBxYAExf`). The pool's code is unchanged.
- **Test NEAR:** the user's `pbf-fund10.testnet` and `pbf-fund11.testnet` sent 9.9 each to the keeper at about
  10:09 UTC (22.53 held before gate 2, 10.35 after gate 4).
- **Gate 2 PASSED, 10:11:28 to 10:30:56 UTC, one run:** `fund-rhea-11131011.pbf.testnet` (code `79827e65…`), 26
  steps. Record `research/data/phase6_funding_rhea.low-fixes-2026-11-13.json`. A Rhea loan of $527.03 and a pool
  loan of $502.45; a fee of $0.000214 and a subsidy of $0.00017, each at its second try (two settlements are 2
  minutes apart); the price drop took Rhea's cushion to 1.30 and the keeper repaid $70.76, back to 1.50.
  - **The new path, on chain** (transaction `5HXw3BKGzf1Cs9bPTqwBWPAUUw6pjaS9SpUWMTHgPAqX`): `execute_step`,
    `settle` (skipped, too soon), `on_settled`, `ft_balance_of`, `on_repay_ready`, the pool's
    `check_step({"plan_id":"277497573","step":0,"token":"musdc.pbf-ops.testnet","amount":"70762661"})`,
    `on_repay_checked`, `ft_transfer_call` to Rhea with `"OnlyRepay"`, `on_lender_repaid`. Every receipt succeeded.
  - `hl_withdraw` carried `"expect":{"token":"musdc.pbf-ops.testnet","amount":"428035523"}` (transaction
    `2FaLt59wxUzKs3LSpUrjkJ6T9B53ohmVNjKpjAj9csoz`) and the arrival settled the transfer.
  - Read after, by the main session: the pool's `debt_of` 0; the account holds neither token; Rhea shows no
    collateral and nothing borrowed (under one unit of USDC is left in its books); Hyperliquid shows no position.
  - The float's dust short (0.00011 BTC, under Hyperliquid's $10 minimum) is still there, noted by the step.
- **Gate 4 PASSED, 10:32:00 to 10:55:52 UTC, one run:** `fund-move-11131031.pbf.testnet` (code `79827e65…`), 18
  steps, address `0x243d9551bf8bbbe00b964b3cbf696824e794d4e1` on Base Sepolia. Record
  `research/data/phase6_funding_moves.low-fixes-2026-11-13.json`. An Aave loan of $21.07 against wrapped test
  ETH and a pool loan of $99.35. The float used 0.002001 test ETH (0.03999 left).
  - Both `evm_withdraw` calls carried `expect`: the loan's way home `{"token":"musdc.pbf-ops.testnet","amount":"21064942"}`
    (transaction `QNnpFdQfspRTVFQVwjueq2izTS28WVYQ7nqhLuaonaN`), the collateral's
    `{"token":"mnbtc.pbf-ops.testnet","amount":"54808"}` (`C7XA81yaPUt4C9cPwZZXbHgPirVoqPQxg6ejmstzFSXQ`).
  - **One refusal inside `loan_home`, put right by the step itself:** the first `evm_withdraw`
    (`7Z3vuKXwvLGg9DoPAG5MCzk1rxFYxEMrHeCNadER6Wa2`) was refused, "with a loan open, an Ethereum withdrawal needs
    a verdict for this token and amount". The keeper's check for the end of the funding plan
    (`B16oKBr3VJBiuabUz1Ah5NiA6vvAPiaUT17qcFN7NNyL`, 10:46:56) had replaced the gate's verdict. The audit's A4,
    still open. The gate asked for a check again and the second call went through.
  - Read after, by the main session: the pool's `debt_of` 0; the account holds neither token; Aave's
    `getUserAccountData` for the address shows debt 0 (and dust of collateral, 22 in its 8-decimal dollars). Left
    at the address: 0.994 USDC and 0.00199 ETH.
- **The keeper's log over both runs** (10:10 to 10:57 UTC, 282 lines): no error and no fee bump.
- **Not met live** (the tests alone show them): A10's bump limits, A15's kept plan, every refusal the fixes add,
  and a Rhea top-up that posts bitcoin (`l_add`), which is what the step price is for.
- The three services were stopped at 10:56 UTC. As run: `research/low_fixes_deploy.md`.


## 48. Privacy level 1, "hide who" (13 Nov; the user's "Build it"). Rules, written before building

The user reopened PLAN.md 14's privacy levels on 13 Nov and chose level 1: the app shows an account only to its
owner and to us, and new accounts get a random name. The plan is `research/privacy_level1_plan.md`. **No contract,
engine or gateway change; nothing is deployed.** The changes are in `services/api`, `web`, the keeper package's
backend client, and the docs. What it does not do: NEAR itself stays readable, the factory still lists each account
with its owner, and Hyperliquid positions stay public.

### 48.1 The setting

- `ACCOUNT_PRIVACY` in `.env`: `owner` (the default when unset or empty) or `off`. Anything else stops the backend
  at start with a message. `off` is today's behaviour on every route, with no token asked or made.
- `OPEN_ACCOUNTS` in `.env`: client accounts anyone may look at, separated by commas (`<name>.<factory>` each;
  anything else stops the backend at start). Default: none. Not secret.
- `SERVICE_TOKEN_FILE`: where the backend writes its service token. Default `services/api/logs/service-token`
  (git-ignored). The keeper package reads the same setting, with the same default.
- All three names go into `.env.example`.

### 48.2 Sign-in: `POST /api/session`

- Body: `{"auth": {owner, public_key, signature, message, nonce, recipient}}`, the shape orders use (section 9,
  "Auth"), with `owner` the wallet that signs and `recipient` exactly `"pb-app-session"`. An order's recipient is
  the gateway's, so neither signature can pass as the other.
- `message` is exactly three lines, joined by `\n`, with no line after:

      Sign in to Prime Broker
      wallet: <the wallet's NEAR account id>
      until: <milliseconds since 1970, a whole number>

- The backend checks, in this order, and refuses with the first that fails:
  1. the shape (`400 bad_request`), and `wallet:` equal to `auth.owner` (`400 bad_request`);
  2. `until` is later than now and at most 10 minutes plus 60 seconds ahead (`400 expired`);
  3. the NEP-413 signature over message, nonce and recipient by `public_key` (`400 auth`), with section 9's
     `verifyNep413`;
  4. the nonce hasn't been used for a sign-in (`409 nonce_used`): kept in memory until its message's `until`;
  5. `public_key` is a **full-access** key of the wallet on NEAR (`403 not_your_key`): the RPC's `query` with
     `request_type: "view_access_key"`, `finality: "final"`, `account_id`, `public_key`. Read live on testnet on
     13 Nov: a key that is there answers `{"permission": "FullAccess", ...}` (a function-call key answers an object
     under `permission`), and a key that isn't answers a `result` with an `error` text. An RPC that doesn't answer
     is `503`, never a yes.
- Answer: `{"token", "wallet", "expires_at_ms"}`. The token is
  `v1.<base64url of {"w": wallet, "exp": expires_at_ms}>.<base64url of HMAC-SHA256(secret, "v1." + that part)>`,
  good for 12 hours (`SESSION_MS`). The secret is 32 random bytes made when the backend starts and kept in memory:
  a restart signs every wallet out. Tokens are compared in constant time.
- Rate limit: 30 sign-ins a minute in all.
- With `ACCOUNT_PRIVACY=off` the route answers `404`.

### 48.3 Who is asking

Every request may carry `Authorization: Bearer <token>`.
- `v1.…`: a wallet's token. A bad or expired one is treated as no token.
- `svc.<64 hex characters>`: the service token. In `owner` mode the backend makes 32 random bytes at start, writes
  them in hex to `SERVICE_TOKEN_FILE` (mode 600, the folder made if missing), and removes the file when it stops.
  It is for our own services on the same machine: the keeper and the gate scripts.
- So a request is from `none`, from `service`, or from a wallet.

### 48.4 Who may see an account: `mayView(who, account)`

Yes, in this order:
1. `ACCOUNT_PRIVACY=off`;
2. the account is in `OPEN_ACCOUNTS`;
3. `service`;
4. (a wallet from here on; `none` is refused with `401 sign_in`, "Sign in with the wallet that owns this account")
   the wallet is the operator's or the keeper's (`OPERATOR_ACCOUNT_ID`, `KEEPER_ACCOUNT_ID`);
5. the account isn't a client account with a state (it doesn't exist, or has no `get_state`): there is nothing of
   a client's to hide, and the wallet may be about to create it;
6. the wallet is the account's `owner` in `get_state` (the owner may be cached for 60 seconds).

Otherwise `403 not_yours`, "This account belongs to another wallet". The refusal never names the owner.

### 48.5 The routes

| Route | Rule |
|---|---|
| `GET /api/account/<id>`, `/api/hl/<id>`, `/api/keeper/<id>`, `/api/activity/<id>`, `/api/lender/<id>` | `mayView` for `<id>` |
| `GET /api/markets?account=`, `GET /api/drill?account=` | `mayView` for the account; with no `account` they stay open |
| `POST /api/preview`, `POST /api/funding-plan`, `POST /api/quote` with `move` | `mayView` for the account in the body. A deposit quote (no `move`) stays open: it tells nothing about the account |
| `GET /api/pricing` | The per-account list (`accounts`) only for `service`, the operator and the keeper, or with privacy off. For everyone else `accounts` is `[]` and `accounts_hidden` is `true`. Every other field stays |
| `GET /api/accounts/mine` (new) | A wallet's token is needed (`401 sign_in` without; `400` for `service`). Answers `{"wallet", "accounts": [{"account_id", "created_at"}], "read_at_ms"}`, newest first: the factory's `list_accounts`, a page at a time as `pricing.ts` reads it, kept where `owner` is the wallet. With privacy off it answers `404` |
| `POST /api/order`, `/api/cancel`, `/api/set-leverage` | Unchanged: the owner signs each one |
| `GET /api/status?account=&transfer=` | `mayView` for the account (added at the join: the helper pointed out it gives a move's status to anyone who knows its number). By deposit address it stays open |
| `POST /api/hl/submit`, `/api/evm/submit`, `/api/evm/gas`, `GET /api/evm/gas` | Unchanged: they post or read what the chain already holds |
| `GET /api/config`, `/api/pool`, `/api/lenders`, `/api/rhea`, `/api/book-stress`, `/api/credit-check*`, `POST /api/drill/fault` | Unchanged: none names a client |

`GET /api/config` gains `"privacy": {"mode": "owner" | "off", "open_accounts": [...], "session_recipient":
"pb-app-session", "session_ms": 43200000}`. A page that finds no `privacy` in the answer treats it as `off`.

A refused request does no chain read beyond the owner's and no OutLayer run: `mayView` comes before the handler's
own work, and before its rate limiter is charged.

### 48.6 The web app

- **The token.** Kept in `localStorage` under `pb:session`, per wallet, with its expiry; sent on every backend
  call; dropped when it has expired, when the backend answers `401 sign_in`, and when the wallet signs out.
- **The sign-in card.** A wallet is connected, the mode is `owner`, and there is no token: every page that shows
  an account shows one card instead, "Confirm this wallet is yours: one free signature, no transaction", with a
  button. The button has the wallet sign section 48.2's message (the provider's `signMessage`) and posts it. The
  pages read nothing about an account until there is a token.
- **No wallet.** Risk and Activity say "Connect your wallet to see your account" and list the open accounts from
  `/api/config` as links (`?account=<name>`), read-only as today. The free-text name field for visitors is gone.
  With no open account, only the first sentence shows.
- **Another wallet's account** (`403 not_yours`): the picker says "This name belongs to another wallet" and the
  page shows nothing else about it.
- **The operator's and the keeper's wallets** open any account by name, as today.
- **The Book page:** the "By account" table shows when `accounts_hidden` isn't true; otherwise one line, "The
  per-client lines show only to the operator."
- **Names.** `suggestName` goes; `randomName()` gives 10 characters from `abcdefghijklmnopqrstuvwxyz234567` out of
  `crypto.getRandomValues`, and always passes `nameProblem`. A wallet's account is, in this order: the name
  remembered in this browser; else the newest of `GET /api/accounts/mine`; else a random name, made once and
  remembered. The client can still type any name.
- **"Your accounts".** When `GET /api/accounts/mine` answers more than one, the picker offers them to choose from.
- **Mode `off`,** or a backend that doesn't say: no card, no token, and every page behaves as before this section.
  The canned test page `/dev/home` runs this way.

### 48.7 The keeper package

Every call it makes to the backend (the gate scripts' client in `gate-world.ts`, and the keeper's own loop where it
posts to the backend) sends `Authorization: Bearer svc.<hex>` when `SERVICE_TOKEN_FILE` is there, read again on a
`401`. With no file nothing is sent, and everything works against a backend with privacy off.

### 48.8 As built

#### Web app

Built on 13 Nov, to 48.6 as written, with canned answers: the backend's side was being built at the same time and
nothing was run against it. No server was started and nothing was signed or sent, so no page of this was seen in a
browser. The app's suite went from 227 to 241, with lint and build clean.

- **The plain part** (`web/src/lib/session.ts`): the message of 48.2 (`sessionMessage`), the token's store
  (`pb:session`, one per wallet with its expiry: `saveSession`, `readSession`, `dropSession`), the token the next
  call sends (`setCurrentSession`, `currentToken`, `dropCurrentSession`), the mode from `/api/config`
  (`privacyOf`: no `privacy` block means `off`), the state (`sessionState`: off, no wallet, needs sign-in, ready),
  and what a visitor sees (`visitorView`).
- **Every backend call** goes through `api()` (`web/src/lib/api.ts`): it sends `Authorization: Bearer <token>` when
  there is one that hasn't run out, and a 401 with code `sign_in` drops the token.
- **The provider** (`web/src/providers/session-provider.tsx`, `useSession`), inside the wallet's provider: reads the
  mode, keeps the token for the connected wallet, and signs in. `signIn()` has the wallet sign the message with
  recipient `pb-app-session` and posts it as `{auth}` (`toAuth` in `web/src/lib/gateway.ts` now takes the recipient;
  an order's stays the gateway's). A wallet that signs out, or is swapped for another, has its token dropped.
- **The card and the gate** (`web/src/components/sign-in-card.tsx`): `SignInCard`, and `AccountGate`, which shows
  the card in place of its children while a wallet has no token. It wraps Home's cockpit, the four pages behind
  `WalletGate` (Account, Borrow, Trade, Deposit), and Risk and Activity for a connected wallet.
  `useClientAccount` also passes a null path until the app may read.
  - **While `/api/config` hasn't answered,** the gate shows a quiet placeholder, in both modes, so nothing is read
    before the mode is known. With privacy off that is the one visible difference, for a moment at first load.
- **No wallet** (Risk, Activity): `VisitorNotice` says "Connect your wallet to see your account." and lists
  `privacy.open_accounts` as links (`?account=<name>`). `?account=` opens an account only if it is in that list. With
  privacy off the name field is as it was.
- **The picker** (`web/src/components/account-picker.tsx`, words in `web/src/lib/picker.ts`):
  - 403 `not_yours`: "This name belongs to another wallet." The hook then hands the page no answer and no error,
    so nothing else about the account shows. Home has the same line with its "Use another account" field.
  - The operator's or the keeper's wallet (`ids.operator`, `ids.keeper` in `/api/config`): "<account> belongs to
    another wallet. You are looking as the operator."
  - An open account, for a signed-in wallet that isn't its owner: "… It is open for anyone to look at."
  - With privacy on the owner's id is never printed by the picker or by Home's pill. With privacy off both name it,
    as before.
  - "Your accounts": buttons under the name field when `GET /api/accounts/mine` lists more than one.
- **Names** (`web/src/lib/names.ts`): `suggestName` is gone. `randomName()` draws 10 characters from
  `abcdefghijklmnopqrstuvwxyz234567` by `crypto.getRandomValues`. `chooseName` gives the order: the remembered name,
  else the newest of `/api/accounts/mine`, else none, and `usePrimeAccount` then makes a random name once and
  remembers it under `pb:account-names`. A name the client clears to type another stays empty.
- **The Book page:** `pricingBook().accountsHidden` follows `accounts_hidden`; the page then shows "The per-client
  lines show only to the operator." in place of the table.
- **The drill page** reads an account by the name typed and isn't gated: a 401 or a 403 there shows one line in
  words where the bands' suggestion would be.
- **`/dev/home`** wraps its page in the session's "off" value, so it renders as before whatever the backend says.
- **Tests,** by rule:
  - `web/src/lib/names.test.ts`: the random name (5,000 draws, each passing `nameProblem`, none repeated); the name
    order.
  - `web/src/lib/session.test.ts`: the message's exact text and the recipient; the token stored per wallet and
    dropped on expiry and on sign-out; the token sent on every call, and not once expired; the 401 `sign_in` drop
    (and a 403 leaving it alone); the four states; Risk and Activity with no wallet, with and without open
    accounts; privacy off as before.
  - `web/src/lib/picker.test.ts`: yours and new; another wallet's; the operator looking and an open account;
    several of yours.
  - `web/src/lib/pricing.test.ts`: the Book page with and without the per-client list.
- **Not done:** no component test (the suite is the pure helpers), and no look in a browser. The sign-in's round
  trip with a real wallet and the real backend is for the click-through.

#### Backend and keeper client

Built on 13 Nov, to 48.1 to 48.5 and 48.7 as written. The suites: backend 157 to 199, keeper 205 to 209; both
packages build. No service was started, no gate was run, nothing was signed or sent, and `.env` was not read. So
none of this has met a real wallet or the running backend yet.

- **The setting** (`services/api/src/config.ts`; `.env.example`; `.gitignore` now has `services/api/logs/`):
  `ACCOUNT_PRIVACY` (`owner` unless it says `off`; anything else stops the backend with the two values in words),
  `OPEN_ACCOUNTS` (each must be `<name>.<factory>`, or the backend stops and names the one that isn't),
  `SERVICE_TOKEN_FILE` (default `services/api/logs/service-token`).
- **Sign-in** (`services/api/src/session.ts`, new: `postSession`, `Sessions`). The five checks in 48.2's order.
  - `parseAuth` (`hl-handlers.ts`) takes the recipient it expects; an order's is still the gateway's and no other.
  - The key check is a new read, `ChainReader.accessKey` (`rpc.ts`): `view_access_key` at the final block, which
    answers full, function-call or none. A JSON-RPC error whose cause is UNKNOWN_ACCESS_KEY or UNKNOWN_ACCOUNT reads
    as none; anything else is an error, and the route answers 503.
  - **The nonce is given back when NEAR's RPC didn't answer,** so the wallet's one signature can be sent again and
    the client doesn't have to sign twice. It is kept for every other outcome.
  - **The limit of 30 a minute is charged after the signature and the nonce pass and before the read of NEAR:**
    garbage costs nothing of it, and the read it protects is the one a stranger could make us pay for. Past it:
    `429 too_many_sign_ins`.
- **Who is asking** (`session.ts`: `who`): the service token, a wallet's token, or nobody. A token that is changed,
  expired or made by another backend is nobody's. Both kinds are compared in constant time (`timingSafeEqual`).
  - `index.ts` makes the token secret and the service token at start, writes the token's file (folder made, mode
    600) and removes it on exit, SIGINT and SIGTERM. If the file can't be written the backend still starts and
    says so in capitals in its log: wallets can sign in, the keeper and the gates would be refused.
- **`mayView`** (`session.ts`): 48.4's six cases in order, then `403 not_yours`. The owner is kept 60 seconds; "no
  such account" isn't kept, so an account just made is hidden from its first read on. A read of the owner that
  fails is an error, not a yes.
- **The routes** (`server.ts`, `route`): `who` once per request, then `mayView` before the handler for every route
  of 48.5's table. A POST's body is read first, since the account is in it; a body that names no account goes on
  to the route's own 400.
  - `GET /api/pricing` (`pricing.ts`): a hidden answer reads no account at all (the pool's part alone, kept in the
    same 15-second cache under its own key), and has `accounts: []` and `accounts_hidden: true`. An answer that
    isn't hidden has no `accounts_hidden` field, so with privacy off it is byte for byte what it was.
  - `GET /api/accounts/mine` (`pricing.ts`, `getMyAccounts`), and `listFactoryAccounts`, which `listAccounts` now
    sits on. It reads at most the factory's first 200 accounts, as `/api/pricing` does.
  - `GET /api/config` has the `privacy` block in both modes.
- **The keeper package** (`services/keeper/src/service-token.ts`, new). `backendFetch` adds the header when the
  file holds a token, reads the file once, and reads it again on a 401. It is used by the gate scripts' client
  (`gate-world.ts`: `world.api.get` and `post`, which every gate and `gatePreflight` go through) and by the
  keeper's one call to the backend (`index.ts`: `POST /api/evm/submit`). Calls to Hyperliquid and to the stand-in
  use plain `fetch` and never carry it. The keeper's loop reads NEAR directly and needs nothing else.
- **Tests** (`services/api/src/session.test.ts`, 42; `services/keeper/src/service-token.test.ts`, 4). One rule each:

  | Rule | Test (its name starts) |
  |---|---|
  | The setting | "48.1: ACCOUNT_PRIVACY is owner unless it says off…" |
  | Sign-in good | "48.2, a good sign-in…" |
  | Wrong signature | "48.2, a wrong signature is refused with 400 auth…" |
  | Wallet line not the signer, and the shape | "48.2, the wallet line must be the signer…" |
  | Order and sign-in can't pass as each other | "48.2, an order's signature can't sign a wallet in…" |
  | `until` passed | "48.2, a sign-in whose time has passed…" |
  | `until` too far ahead | "48.2, a sign-in dated more than 10 minutes and 60 seconds ahead…" |
  | Nonce twice | "48.2, a nonce signs a wallet in once…" |
  | Key not on the wallet | "48.2, a key that isn't on the wallet…" |
  | Function-call key | "48.2, a function-call key…" |
  | RPC down is 503, not a yes | "48.2, NEAR's RPC down is 503…" |
  | 30 a minute | "48.2, at most 30 sign-ins a minute…" |
  | The RPC read's shapes | "48.2, the access-key read…" |
  | A changed token | "48.3, a changed token is no token…" |
  | An expired token | "48.3, an expired token is no token…" |
  | A wrong service token | "48.3, the service token…" |
  | The file: mode 600, removed | "48.3, the service token's file…" |
  | `mayView`'s six yes cases | "48.4, yes 1…" to "48.4, yes 6…" |
  | `mayView`'s two refusals | "48.4, refusal 1…", "48.4, refusal 2…" |
  | Each of the ten routes: 401, 403, 200 for the owner, the service, the operator, an open account | "48.5, GET /api/account/<id>…" and nine more, one a route |
  | A refusal comes before OutLayer, the limiter and every read but the owner's | "48.5, a refusal comes before the route's work…" (fakes that fail the test if reached) |
  | Routes that name no client stay open | "48.5, the routes that name no client stay open…" |
  | `/api/pricing` with and without the list | "48.5, GET /api/pricing…" |
  | `/api/accounts/mine` | "48.5, GET /api/accounts/mine…" |
  | `/api/config`'s block | "48.5, GET /api/config says the privacy mode…" |
  | Sign-in over HTTP, and nothing secret in the log | "48.5, POST /api/session over HTTP…" |
  | `ACCOUNT_PRIVACY=off` | "ACCOUNT_PRIVACY=off: every route answers anyone as before…" (the ten answers equal the owner's with privacy on; `/api/session` and `/api/accounts/mine` 404) |
  | The keeper's client | "48.7: with the file there…", "48.7: with no file nothing is sent…", "48.7: on a 401 the file is read again…" |

  Seven rules were also undone one at a time in the compiled files, and their tests failed: nobody refused, any
  key taken, a nonce reused, a token's signature unchecked, a sign-in's signature unchecked, the per-account list
  shown to anyone, another wallet's account shown.
- **The tests from before** build their dependencies with privacy off (`fakes.ts`), and none changed.
- **Left as it is, and why:**
  - **`POST /api/set-leverage`, `/api/hl/submit`, `/api/evm/submit`, `/api/evm/gas` and `GET /api/status`** name an
    account and ask no token, as 48.5 says. `GET /api/status?account=&transfer=` answers 1Click's status for a move
    of that account to anyone who knows its number.
  - **A wallet's own id in the path** (`GET /api/account/<wallet>`) is 401 for nobody and open to any signed-in
    wallet: a wallet has no state, so 48.4's fifth case applies.
  - **The service token's file is removed by whichever backend stops:** two backends started on one machine would
    share the path, and the first to stop takes the other's file. Not handled.
  - **Sessions live in memory:** a backend restart signs every wallet out, as 48.2 says.

### 48.9 At the join (13 Nov, 11:28 to 12:17 UTC). Built, tested, checked live; one gate run held up by OutLayer

**The main session's own work.**
- Read every changed line against the copy of before (`<scratchpad>/before_privacy/`): `session.ts` whole, and the
  diffs of `server.ts`, `config.ts`, `rpc.ts`, `index.ts`, `pricing.ts`, `handlers.ts`, `hl-handlers.ts`,
  `fakes.ts`, the keeper package's four files, and the web app's 29.
- **One addition:** `GET /api/status?account=&transfer=` now asks `mayView` (48.5's table says so), with its test.
- **Suites, the main session's own runs:** backend 200 (157 before), keeper 209 (205), stand-in 54, its client 12,
  app 241 (227): 716 in all (655). `pnpm -r build` and the app's lint clean. Contracts 696 and engine 329 untouched.
- `OPEN_ACCOUNTS` set through `scripts/set-env.sh` to this morning's two gate accounts,
  `fund-rhea-11131011.pbf.testnet` and `fund-move-11131031.pbf.testnet`. `ACCOUNT_PRIVACY` is left unset: `owner`.

**Live, against the running backend (11:34 UTC), nothing deployed.**
- With no token: a private account (`fund-rhea-11122148.pbf.testnet`) is `401 sign_in` on `/api/account`, `/api/hl`,
  `/api/keeper`, `/api/activity`, `/api/lender`, `/api/markets?account=`, `/api/drill?account=`, `POST /api/preview`
  and `/api/status?account=&transfer=`; an open account, `/api/pool`, `/api/markets` and `/api/drill` are 200.
  A wrong service token is 401; the service token from its file (mode 600, 69 bytes) is 200.
  `/api/pricing` gives 0 accounts with `accounts_hidden` true, and 11 accounts to the service token.
- **Through the web app's proxy** (port 3000) the same three answers: the proxy passes `Authorization` on.
- **Two real sign-ins**, each a NEP-413 signature by a real testnet key and the live `view_access_key` read:
  - `pbf-keeper.testnet` (one of us): signed in; the same message again is `409 nonce_used`; it reads a private
    account, lists its 16 accounts at `/api/accounts/mine`, and gets the pricing list.
  - `shim.pbf-ops.testnet` (a wallet that isn't ours): signed in; the private account, its Hyperliquid side and a
    preview for it are `403 not_yours`; an open account and a name not made yet are 200; it has 0 accounts; no
    pricing list; its token with one character changed is `401 sign_in`.
  - Refused: a signature made for the gateway's recipient (400), a message naming another wallet (400), a time
    that has passed and one an hour ahead (`400 expired`), and the stand-in's key signing as the keeper's wallet
    (`403 not_your_key`).
- **In the browser with no wallet:** Risk and Activity say "Connect your wallet to see your account." and list
  the two open accounts; an open one opens read-only; a private one's `?account=` link shows nothing about it; the
  Book page says "The per-client lines show only to the operator."; no console error.

**Gate 2 through the guarded backend: 15 of 26 steps passed, then held up by OutLayer, not by this section.**
- `fund-rhea-11131136.pbf.testnet`, started 11:36 UTC. The backend refused nothing the gate asked.
- `short` stopped twice with the gateway's "AUTH the message has expired": the order waited 136 s and 122 s in
  OutLayer's queue, and an order's signature lasts 110 s (the gateway takes at most 120 s ahead). The third try
  waited 97 s and filled. Records: `research/data/phase6_funding_rhea.stopped-outlayer-queue-2026-11-13.json`.
- `fund`, `funded`, `settle_fee`, `settle_subsidy` and `price_drop` passed. So every guarded route gate 2 uses
  (`/api/hl`, `/api/markets?account=`, `/api/preview`, `/api/funding-plan`, `/api/quote` with `move`) answered the
  gate with the service token.
- `top_up` has waited since 11:57: five checks in a row (11:57, 11:59, 12:02, 12:11, 12:13) came back as
  "OutLayer returned no verdict: the run failed or timed out" (on chain: "Execution promise failed"). A preview
  over OutLayer's HTTPS API at 12:14 answered rightly (REBALANCE) after 173 s, of which the run was 10.8 s: the
  queue is about 160 s, and a check on chain gets about 2 minutes.
- **Seen in the keeper, and left:** after three failed checks for a thin cushion at Rhea it stops asking for that
  reason; the next check came from the hourly sample, 7 minutes later. Worth a rule of its own after the deadline.

**Not checked:** a real wallet in the browser (the sign-in card, the random name, "This name belongs to another
wallet"). That is the user's click-through.

### 48.10 How that gate run ended (13 Nov, 12:27 UTC), and one fix it led to

- **`top_up` failed after 25 minutes** (the step's own limit): seven checks in a row, 11:57 to 12:18 UTC, came back
  with no verdict from OutLayer. The gate went on to its way out, as it is written to: the price back, Rhea and
  the pool repaid, the collateral back from Rhea, the short closed (the order took 31 s: OutLayer's queue was
  short again by 12:24, when a check also answered in 20 s).
- **`home` then failed on a race, not on OutLayer:** the keeper posts a signed Hyperliquid action it sees in an
  account, and at 12:24:26 it posted this transfer a second before the gate's own `POST /api/hl/submit`.
  Hyperliquid took the keeper's and answered the gate "Invalid nonce: duplicate nonce 1794572660145". The money
  came home all the same: $438.26 of test USDC in the account, no transfer pending.
- **The fix (backend, `postHlSubmit`):** "duplicate nonce" with the entry's own nonce is now a yes, with
  `already_posted: true` and Hyperliquid's words kept in `hl`. Any other refusal, another nonce, or an HTTP error
  is still a refusal. It serves the app too: before, the page would have shown "Hyperliquid refused it" for a
  transfer that had gone through. Tests: backend 201 (one new, one changed to a refusal that is a refusal).
- **The run's end:** `--from home` at 12:27 (nothing left on Hyperliquid to bring home) and `withdraw` passed. The
  account holds neither token and owes nothing. The record says NOT PASSED for `top_up` alone:
  `research/data/phase6_funding_rhea.privacy-outlayer-slow-2026-11-13.json`; the two earlier stops are
  `…stopped-outlayer-queue-…` and `…stopped-outlayer-checks-…`.
- **So gate 2 has not passed in one clean run on the final backend and keeper code.** Every step but `top_up`
  passed through the guarded backend; `top_up` passed this morning on the same contracts (47.11). A clean run
  needs a new account: about 6.7 test NEAR, and the keeper holds 4.27.

### 48.11 Gate 2 PASSED on the final code, through the guarded backend (13 Nov, 13:21 UTC), and the keeper's fix

- **GATE 2 PASSED:** `fund-rhea-11131229.pbf.testnet` (account code `79827e65…`), all 26 steps, 12:29:35 to
  13:21:21 UTC. Record: `research/data/phase6_funding_rhea.privacy-level1-2026-11-13.json`. The backend ran with
  `ACCOUNT_PRIVACY` unset (`owner`), and the gate reached it with the service token alone; nothing was refused.
- **It took three starts, each stop OutLayer's:** `agent` at 12:36 (no agent named in 6 minutes; kept as
  `…stopped-outlayer-agent-…`), then `settle_subsidy` at 13:02 (no verdict; `…stopped-outlayer-settle-…`). Steps 5
  to 15 ran in six minutes from 12:51, and 16 to 26 in five from 13:16, when OutLayer answered in 20 to 85 s.
  OutLayer's testnet on 13 Nov, as timed by a preview through our backend: 95, 143, 128, 84, 39, 18 s (12:39 to
  12:50), 176 s (13:03), 75, 67, 85, 77 s (13:10 to 13:16). A check on chain gets about 2 minutes and an order's
  signature lasts 110 s, so answers up to about 100 s pass.
- **Read after, by the main session:** the pool's `debt_of` 0; the account holds neither token; no position on
  Hyperliquid. The top-up went through the pool's `check_step` as in 47.11 (60 s for the step).
- **The keeper's fix (`decide.ts`, `CHECK_AGAIN_MS` 2 minutes).** A band crossed, a big move and a thin cushion at
  a lender each ask for a check once per verdict. A check is tried three times; when all three brought no verdict,
  nothing asked again until the hourly check (seen at 12:04 to 12:11 UTC: a cushion at 1.30 with no check asked for
  7 minutes). Now, 2 minutes after the third failure, the once-per-verdict marks go back to where the verdict left
  them (`moved`, `lenderAsked`, `sides`), so whatever still holds asks again, three tries at a time. A check refused
  for good (`retry: false`) is not asked again this way, and a new verdict ends it. Memory: `checkGaveUpAt`. Test:
  "a check that failed three times is asked again two minutes later while what asked for it still holds".
- **Suites after both fixes, the main session's own run:** backend 201, keeper 210, app 241, stand-in 54, its client
  12: 718, none failing.
- The keeper runs as `keeper-one` again (the factory's newest account), for the user's click-through.

### 48.12 The user's click-through with a real wallet (13 Nov, 13:35 to 14:13 UTC), and three fixes from it

Record: `research/data/privacy_level1_click_through.json`. Wallet `quiethare6001.testnet` (Meteor), new account
`npme2jlqx2.pbf.testnet` on the final code (`79827e65…`).

- **Seen by the user:** the "Confirm this wallet" card and its one signature; "New account" giving the random name
  `npme2jlqx2`; "Set up the demo for me" through to the hedge and Aave's test collateral; "Where it comes from" for
  $500 (Aave $21.75 at 0.74%, our pool $478.24 at 2.00%); and "Borrow $500.00": check, "It would lend $500.00",
  loan signed.
- **Read on chain by the main session:** the keeper ran funding plan `f277520281` in four minutes (`l_supply`
  14:09:58, `l_borrow` 14:11:40, `p_borrow` by 14:13:21). The pool is owed $478.28; Aave shows $39.26 posted, $21.71
  owed, health factor 1.54 (the permission asks 1.50); the account holds $488.28 of test USDC and its 0.015 nBTC;
  the short of 0.015 BTC is open; state HEALTHY.
- **Fix 1, NEAR's RPC.** The wallet showed "Rate limits exceeded" (FastNEAR, code -429), and then the backend's
  reads failed the same way. The wallet, the backend, the keeper and the stand-in all used FastNEAR's free testnet
  endpoint from one machine. Its archival endpoint, tried first, allows less still (NEAR's docs: archival is paid).
  Now the backend reads through dRPC's free testnet endpoint, `https://near-testnet.drpc.org`, from the list at
  docs.near.org/api/rpc/providers: set for the `api` entry in `.claude/launch.json` (a value in the environment
  wins over `.env`), 48 of 48 reads answered. `.env`'s `NEAR_RPC_URL` is FastNEAR's regular endpoint again for the
  keeper and the stand-in, which send transactions and were proven on it. The app's wallet connection lists
  FastNEAR, then dRPC. **For the hosted demo:** the backend needs an endpoint of its own there too.
- **Fix 2, the free preview.** In the setup card's Borrow step, "Preview the result (free)" sent the `fund` intent
  to `POST /api/preview`, which takes check, borrow and withdraw and answered "Unknown intent fund". In the app
  since Phase 6. The app now reads a `fund` preview from `POST /api/funding-plan`, which runs the same engine and
  answers the verdict (`web/src/components/preview.tsx`).
- **Fix 3, a random name for a second account.** The wallet had two accounts from earlier phases, so the app opened
  one of those. The picker now has a "New account" button that fills in `randomName()`.
- **Also seen:** each backend restart signs every wallet out (48.2), three sign-ins in this run; Next's developer
  badge "1 Issue" was the wallet library's "Iframe not loaded" after the wallet window closed.
- **Not tried in this run:** another wallet's account name in the picker, the Aave part's way home, repaying, and
  the Risk and Activity pages as the owner.

### 48.13 The way out by hand, with the user's wallet (13 Nov, 14:44 to 15:41 UTC)

The user asked to "bring the loan home and unwind it so we have tested the complete workflow". All of it ran from
the app with the Meteor wallet on `npme2jlqx2.pbf.testnet`; the main session read each stage on chain. Record:
`research/data/privacy_level1_click_through.json`.

| Stage | What the user did | Read on chain |
|---|---|---|
| The loan home | "Bring the loan home", $21.71955, with its check | $21.715162 on NEAR by 15:19:32 ($510.00 held) |
| Our pool | "Repay", our pool alone, all | `debt_of` 0 at 15:22:38, the loan closed |
| USDC out | "Send USDC to Aave's chain", $21.80 | $21.795175 at the address |
| Aave | "Repay", all of Aave | Aave's debt 0 by 15:28:08 |
| Collateral | "Take collateral back", 0.02 WETH, then "Bring the bitcoin home" | 56,013 units of nBTC on NEAR by 15:32:40 |
| The hedge | Trade, "Close…", "Sign and send the order" | no position by 15:36:12 |
| USDC home | "Move USDC", home from Hyperliquid, $442 | $441.710760 on NEAR by 15:37:57 |
| Out | "Withdraw" twice | $451 and 0.0155 nBTC in the wallet by 15:41 |

End, read at 15:42 UTC: nothing owed to the pool or Aave, no position, $0.62 of USDC and 6,013 units of nBTC left in
the account (the amounts typed were rounded), $0.73 on Hyperliquid, $0.0756 of USDC at the address.

**OutLayer.** "Bring the loan home" needs a check while the pool is owed. Three checks came back "OutLayer returned
no verdict" (14:44, 14:57, 15:09), one landed while the wallet's window had closed (14:52), and the fifth passed
(15:18). Timed through the backend over the same hour: 162, 502 after 182 s, 170, 99, 67, 28, 63 s.

**Found and fixed (app only unless said):**
- **The free preview for the other two Phase 6 intents.** `evm_withdraw` answered "Unknown intent" as `fund` had
  (48.12). The app no longer offers the link for `evm_withdraw` and `lender_withdraw` (`check-flow.tsx`). The
  backend's `parseIntent` now takes `fund`, `lender_withdraw` and `evm_withdraw` (test: "preview: the three kinds
  of question from Phase 6 …"; backend 202). **Not live until the backend's next restart**, which signs wallets out.
- **"Signed but wasn't sent" and "has no signed entry", both false.** The page learns a signed entry's number from
  its own transaction's event, and asked the backend to send it before the backend's NEAR node (dRPC since 48.12)
  showed it: 404. The keeper sent each 8 seconds later. The page now asks again for up to 25 s on a 404
  (`use-evm-send.ts`, `use-sign-and-post.ts`).

**Seen and left:**
- **A move the engine never sees arrive.** A `to_evm` move of USDC counts as arrived only while the USDC is at the
  address (`EVM_ARRIVAL_MIN_SHARE`, 80% of what was sent). The panel says "Run a check before you repay Aave with
  it". The main session told the user to skip that check because OutLayer was slow; the repayment spent the USDC,
  so `move:2` stays listed until its deadline (16:04:53 UTC) and is then the owner's to drop (`forget_transfer`,
  "Drop this move"). With nothing owed it blocks nothing. The page's advice was right.
- The "Take collateral back" panel has no "All" button, and its "against a loan there of $21.71" came from the last
  verdict, stale after the repayment.
- Each check that came back empty cost the user 0.001 NEAR and two minutes; the page says "No result was stored"
  and offers "Start again".

**17:41 UTC, the last of it.** The user dropped `move:2` from Home ("Drop this move"): `forget_transfer`, transaction
`DNCfKhzppG3YvmMptfcRM1YvE34MJ1g5yqXFSG9AX7wi`; the account lists nothing as on its way. The backend was restarted at
17:39 with the `parseIntent` change live (an unknown intent now names all six). The desktop app had stopped all four
services at 17:26 UTC while the session was idle; only the backend and the app were started again.


## 49. The app's second shape (13 Nov, evening; the user's feedback after the click-through). Rules, written before building

The user ran the whole flow by hand (48.12, 48.13) and said: the app is unintuitive, there are too many clicks, and
the steps were hard to follow even when told exactly. Their nine points, and the answers agreed in chat, are the
rules here. **No contract and no engine change.** Everything is additive: the pages of before stay reachable under
More, so the flows that passed today keep working while the new ones are built.

### 49.1 What the user asked for

1. **Tabs:** Home, Spot, Perps, Borrow, Basis trade, More. "Trade" goes: it becomes Spot and Perps.
2. **Perps** laid out as a perps exchange is: the market's figures on top, a price chart, the order book and recent
   trades, the order form, and positions and open orders below. Our own name and look, not another venue's logo or
   colours.
3. **Spot** like NEAR Intents' swap screen: "You pay", "You receive", a token picker, the price as you type, one
   Swap button. About 25 tokens: the coins of our perps list that NEAR Intents supports, with USDC and USDT.
4. **Home** opens with the portfolio: its value now, and a chart of it over time.
5. **"Set up the demo for me" goes.** A tab of its own, **Basis trade**, takes its place: pick a token, and the page
   leads through holding it, shorting the same amount, and borrowing against both. It also has **Close everything**:
   the way out in one guided run.
6. **No "Get a price" button anywhere.** A price shows as the amount is typed. One button per action.
7. **No help needed.** Each screen says what it is for and has one main action; a failure says what to do next.
8. **Borrow:** the page of today, with repaying on it.
9. **Credit check and Book** move under More.

### 49.2 What is real on testnet, and what the page says

- NEAR Intents has no testnet. **Every listed token shows a real price** (1Click's own token list and dry quotes).
  **A swap completes only for tokens that exist as test tokens** and are in the account's settings.
- **Tokens that swap for real** after the deploy of 49.6: USDC, nBTC (shown as BTC), ETH, wNEAR (shown as NEAR) and
  USDT. The engine already prices all five (`risk/pb-read/src/near.rs`, `TOKEN_NAMES`; `risk-core/src/params.rs`), so
  they sit in the account and count toward loans with no engine change. Until that deploy: USDC and nBTC.
- For any other token the Swap button is replaced by one line: "This pair trades on mainnet. On testnet you see its
  real price." Never a button that fails.

### 49.3 The backend (`services/api`), new routes, all additive

| Route | Answers | Who may ask (48.4) |
|---|---|---|
| `GET /api/spot/tokens?account=` | `{"tokens": [{"symbol", "name", "price_usd", "on_intents", "intents_asset", "token_id", "decimals", "swaps_here", "lendable"}], "read_at_ms"}`: our perps coins that 1Click's token list has, plus USDC and USDT, at most 25, dearest market first. `token_id` and `swaps_here` come from the account's settings (the factory's, with no account). Kept 60 s | Anyone; with `account`, `mayView` |
| `POST /api/quote` with `"swap": {"from": <token id>, "to": <token id>}`, `account`, `amount`, `dry` | The quote, and with `dry: false` the account's next call: selling a token other than USDC is `withdraw` with `transfer: {"kind": "sell", "exp", "expect"}`; paying in USDC is a plain `withdraw` of USDC to the deposit address, and the token bought arrives as a deposit. `needs_check` as for a move | `mayView` |
| `GET /api/perps/:coin` | `{"coin", "ctx": {mark, oracle, funding, open_interest, day_volume, prev_day_px}, "book": {bids, asks}, "trades": [...], "read_at_ms"}` from Hyperliquid's `metaAndAssetCtxs`, `l2Book` and `recentTrades`. Kept 1 s | Anyone |
| `GET /api/perps/:coin/candles?interval=&n=` | Hyperliquid's `candleSnapshot`. Kept 5 s | Anyone |
| `POST /api/check` `{"account", "intent"}` | The keeper asks for the check and pays for it (49.4): `{"accepted", "blk", "tries", "tx"}` or the refusal's reason | The account's owner only (a wallet's token); 6 a minute per account |
| `GET /api/portfolio/:account` | `{"points": [{"t_ms", "equity_micro", "debt_micro"}]}`: one point per verdict the account has stored, oldest first, from the indexer's `on_verdict` logs or the keeper's log, whichever the backend can read | `mayView` |

### 49.4 Checks the broker pays for

`request_check` may be called by anyone (the keeper calls it hourly). So the app no longer has the client's wallet
send it. The page posts `POST /api/check`; the backend hands it to the keeper over the keeper's own port, with the
service token (48.3); the keeper sends `request_check(intent)` with 0.01 NEAR of its own, and asks again, up to three
times, when OutLayer returns no verdict. The client's wallet then approves only the action. If the keeper isn't
running, or refuses, the page falls back to the check from the client's wallet, as today. The keeper's status port
answers `POST /check` only to a caller with the service token.

### 49.5 The web app

- **Who owns which files** (helpers build at the same time, so no file has two writers):
  - shell: `lib/pages.ts`, `components/navigation.tsx`, `components/home/**`, `app/borrow/**`, `components/check-flow.tsx`,
    `hooks/use-check-then-act.ts`, `components/home/moves.tsx`, `components/move-usdc.tsx`, `lib/api.ts`;
  - basis: `app/basis/**`, `components/basis/**`, `lib/basis.ts`;
  - perps: `app/perps/**`, `components/perps/**`, `lib/perps.ts`;
  - spot: `app/spot/**`, `components/spot/**`, `lib/spot.ts`.
  A helper that needs a change in a file it doesn't own says so in its report and doesn't make it.
- **No new dependency.** Charts are drawn by the app itself (canvas or SVG).
- **Prices as you type:** every amount field that used to have "Get a price" asks for the price 400 ms after the
  last keystroke and shows it; the one button then starts the action (the committed quote, the check of 49.4 when
  one is needed, and the wallet's approval), and the page follows it to the end.
- The pages of before (`/trade`, `/account`, `/deposit`, `/risk`, `/activity`, `/drill`, `/credit-check`, `/book`)
  stay, under More.

### 49.6 The deploy this needs (the user's keychain; nothing else on testnet changes)

Three test tokens from `contracts/testnet/token` (the file `musdc` and `mnbtc` run): `ETH` (18 decimals), `wNEAR`
(24) and `USDT` (6), under `pbf-ops.testnet`; then the factory's `set_config` with the five tokens, which reaches
accounts made after it. The stand-in's float gets each token by `mint`. One gate on a new account after it.

### 49.7 As built

#### Perps

Built by helper P on 13 Nov, evening. Code and unit tests only: nothing deployed, signed or sent, no service started
or stopped, no new dependency. The page is `/perps`.

**Files** (all new; nothing else was edited):

- `web/src/lib/perps.ts` and `web/src/lib/perps.test.ts` (40 tests): every reading and every sum, as pure functions.
- `web/src/app/perps/page.tsx`, `perps-view.tsx`: the page. It reads `GET /api/markets` (plain for anyone, and with
  `?account=` once the wallet has an account, so the band is that account's own, INTERFACES.md 42),
  `GET /api/perps/:coin` every second, `GET /api/perps/:coin/candles?interval=&n=240` every 5 seconds, and for a
  confirmed wallet `GET /api/account/:id` and `GET /api/hl/:account` (every 8 seconds, as the trade page).
  `/perps?coin=ETH` opens on that market.
- `web/src/components/perps/`: `perps-layout.tsx` (the frame), `market-bar.tsx`, `chart.tsx`, `order-book.tsx`,
  `order-form.tsx`, `account-tables.tsx`, `action-status.tsx`, `use-feed.ts`, `use-gateway-action.ts`, and
  `perps.module.css` (a CSS module: the page's own layout classes, every colour one of `globals.css`'s `--pb-`
  variables, so light and dark follow the app).
- `web/src/app/perps/sample/` (`page.tsx`, `sample-view.tsx`, `states.ts`): development only, like `/dev/home`. A
  production build answers it with "not found". `/perps/sample?state=live|thin|empty|down|expired` shows the page's
  own panels from sample data with no backend and no wallet; its buttons play an order's wait and result, and
  nothing is signed or sent.

**The layout** (`perps.module.css`): from 1180 px, the market's figures on top, then chart, book and form side by
side, with the tables under the chart and book. From 760 px, the chart across, book and form side by side, tables
below. On a phone, stacked: figures, a 250 px chart, the form, the book, the tables; "Trade" in the top bar jumps to
the form. No horizontal scroll at 375 px (measured in the browser).

**What it reads from 49.3, and how tolerantly** (`parsePerps`, `parseCandles`): a number may be a number or a
numeric string; book rows may be `{px, sz}` or `[px, sz]`; Hyperliquid's own names (`markPx`, `levels: [bids, asks]`)
are read too; a row that isn't a price and a size above 0 is dropped; the book is sorted whatever order it came in;
candles come as a list or under `candles`, are sorted, one per opening time, and a row missing a price is dropped.
`open_interest` is taken as coins (Hyperliquid's `openInterest`) and shown in dollars at the mark.

**When a route can't answer** (404, a refusal, the backend down): the chart says "The price chart isn’t available
right now. It will show here when it is." and the book says the same of itself. The top bar then shows what
`GET /api/markets` has (mark, oracle, volume, funding) and a dash for the day's change and open interest. The page
asks again 8 seconds after an error, not every second, and rests while the tab is hidden (`use-feed.ts`).

**The chart** (`chartModel`, drawn in SVG by `chart.tsx`): the newest candle at the right edge, each bar 6 to 14 px
wide, so a phone shows the newest candles that fit and a handful of candles stay slim at the right instead of being
stretched across. Volume sits in its own pane underneath. The last close has a dashed line and a label on the price
axis. The crosshair names the candle's time, open, high, low, close, its move and its volume. With fewer than 10
candles, or none with volume, it says "Testnet has few trades in this market"; with none at all it draws nothing and
says that alone.

**The order.** One button. The wallet signs one NEP-413 message per order, built by `lib/gateway.ts`'s
`orderMessage`, `expiryNow`, `randomNonce` and `toAuth`, and posted with `lib/api.ts`'s `sendOrder`: the same calls,
in the same order, as `app/trade/trade-view.tsx`. Cancel uses `cancelMessage` and `sendCancel` the same way.

- **Market** is an immediate-or-cancel limit at `reference × (1 ± band_bp / 20,000)`, a buy rounded down and a sell
  up: **half the band past the reference**, the exact sum of the trade page's "Close…" and of the setup's hedge
  (`MARKET_BAND_SHARE = 0.5` in `lib/perps.ts`). The brief said "the far edge of the band, exactly as Close
  computes"; Close computes half the band, and the code follows Close, because the gateway measures the band from
  its own reference price and the very edge would often be refused (P2). The reference is testnet's oracle, else its
  mark, as on the trade page; when `GET /api/perps/:coin` has answered, its mark and oracle (a second old) are used
  in place of the markets list's (up to 30 seconds old).
- When the book's best price on the other side is already past that limit, the form says the order would not fill
  right now, before the wait.
- **Limit**: the typed price, rounded so it is never worse than typed. A price outside the band stops the order on
  the page, with the band in words; the trade page only warned and let the gateway refuse it.
- **Size** in the coin or in USDC. USDC becomes coins at the limit price for a limit order and at the mark for a
  market order, cut down to the coin's decimals.
- **While it runs**: "Waiting for your wallet to sign. Nothing is sent until you do.", then "The broker's risk
  checks are running in a sealed computer: 14 s. This takes 20 to 60 seconds.", and past 60 seconds "Still
  checking: 75 s. The sealed computer takes one order at a time, and it is busy. You don't need to do anything."
  Every Buy, Sell, Close and Cancel button waits while one action is on its way.
- **The result** is `lib/gateway.ts`'s words, except two the page words itself: a refusal `AUTH` whose reason says
  "expired" becomes "The gateway was too slow this time. Nothing was placed. Try again." with a **Try again** button
  that signs a fresh message (new expiry, new nonce, the same order); and Hyperliquid's "could not immediately
  match" becomes "Nothing was placed. There was nobody to trade with at a price the risk checks take."
- **Close** on a position is one click and one signature: all of the position (Hyperliquid's own `szi` text, so the
  size is exact), the other side, reduce-only, at the market price. Hyperliquid's $10 minimum is not checked on the
  page for a close; Hyperliquid judges it.

**Privacy level 1** (48.6): the figures, the chart, the book and the trades show to anyone. The form's place holds
`WalletGate` (the sign-in line with no wallet, the one card for a wallet that hasn't confirmed), and the tables'
place holds one quiet line. Nothing about an account is asked for before the wallet has confirmed:
`useClientAccount` and the two reads behind it stay off until then.

**Which test proves which rule** (`web/src/lib/perps.test.ts`):

| Rule | Test |
|---|---|
| The two routes of 49.3 | "the two routes of INTERFACES.md 49.3, with the coin escaped" |
| Tolerant reading of the market | "the market's answer: figures as numbers…", "the book is sorted whatever order it came in…", "Hyperliquid's own l2Book shape and field names are read too", "an answer with parts missing still parses…" |
| The top bar's figures, and its fallback | "the top bar: prices with the coin’s decimals…", "while the live figures are missing, the top bar shows what the markets list has" |
| Book rows with running totals | "book rows carry a running total from the best price outward" |
| Depth bars | "depth shares are measured against the deeper side, so the two sides compare" |
| The spread | "the spread: the gap, its share of the middle price, and none for an empty or crossed book" |
| Candles read tolerantly | "candleSnapshot rows become candles…", "a broken candle row is dropped, not drawn" |
| Thin data says so | "thin data says "Testnet has few trades in this market"" |
| Candles as bars and scales | "candles as bars: the newest at the right edge, inside the box, highs above lows", "round steps for the price scale" |
| A phone's width | "at a phone's width only the newest candles that fit are drawn, none thinner than the least step" |
| Few candles, flat candles, none | "a few candles stay slim at the right…", "one flat candle, or none, never divides by zero" |
| The crosshair | "the crosshair finds the candle under it and the price at its height" |
| A market order's price from the band | "a market order's price is the trade page's Close sum: half the band past the reference, on the side that fills", "the form prices from the live mark and oracle when the market has answered" |
| Size between the coin and USDC | "USDC typed as a size becomes coins, cut down to the coin’s decimals, and back", "size in USDC: at the limit for a limit order, at the mark for a market order" |
| Hyperliquid's rounding | "a limit order: rounded by Hyperliquid’s rules, never worse than typed, and worth what it says" |
| What stops an order | "what stops an order is said in words, and nothing is signed", "a limit price outside the gateway's band is stopped before the wait, with the band in words", "a market order that the book cannot fill inside the band says so before the wait" |
| Close in one order | "Close is one order: all of the position, the other side, reduce-only, at the market" |
| The expired message | "an expired message says the gateway was too slow, and that nothing was placed" |
| Every other answer | "every other answer comes back in lib/gateway.ts's words" |
| Honest about speed | "the progress line is honest about the wait: 20 to 60 seconds, one order at a time" |

**Checked in the browser** (the dev server, `/perps/sample`, no wallet): the three layouts at 1440, 900 and 375 px
(light at all three, dark at 375 px), the crosshair, a click on a book price filling the form, the size rounding note, the played wait and
result, "Try again" after an expired answer, Close from the positions table, and the thin, empty and down states.
`/perps` itself, signed out, showed the sign-in line in the form's place and the calm lines for the chart and book
(the running backend had not yet loaded the 49.3 routes).

**Not tested by hand, because it needs a wallet and a restarted backend:** signing and sending a real order, a real
cancel and a real Close through the gateway; the real wait's length; a real expired answer; the page against the
live `GET /api/perps/:coin` and its candles; the sign-in card for a connected wallet that hasn't confirmed; the
account picker under the form.

#### Stand-in and tokens

Built on 13 Nov, 19:05 to 19:45 UTC, in `services/oneclick-shim` only. Nothing is deployed, signed or started. The
deploy is written, not run: `research/spot_tokens_deploy.md`.

**The five NEAR test tokens** (`assets.ts`). Asset ids are `nep141:<token id>`, as before. The three new ids come
from the stand-in's settings, with defaults:

| Asset id | Symbol in the stand-in | Decimals | Priced as (1Click's own list, `blockchain: "near"`, read 13 Nov 19:09 UTC) | Setting |
|---|---|---|---|---|
| `nep141:musdc.pbf-ops.testnet` | mUSDC | 6 | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (USDC) | `MUSDC_TOKEN_ID` |
| `nep141:mnbtc.pbf-ops.testnet` | mNBTC | 8 | `nep141:nbtc.bridge.near` (BTC) | `MNBTC_TOKEN_ID` |
| `nep141:meth.pbf-ops.testnet` | ETH | 18 | `nep141:eth.bridge.near` (ETH) | `METH_TOKEN_ID` |
| `nep141:mwnear.pbf-ops.testnet` | wNEAR | 24 | `nep141:wrap.near` (wNEAR) | `MWNEAR_TOKEN_ID` |
| `nep141:musdt.pbf-ops.testnet` | USDT | 6 | `nep141:usdt.tether-token.near` (USDT) | `MUSDT_TOKEN_ID` |

The first two rows, the Hyperliquid asset and the Base Sepolia assets are unchanged, and keep their place in the
list; the three new ones come last. 1Click's decimals for the five are the test tokens', so amounts carry over.

**A swap between any two of the five** is an ordinary quote: `POST /v0/quote` with `originAsset` and
`destinationAsset` from the table, `amount` in the origin's own units, `recipient` and `refundTo` NEAR accounts,
and `customRecipientMsg` for the delivery (and the refund). Nothing in the request is new:

```json
{"dry": false, "swapType": "EXACT_INPUT", "slippageTolerance": 100,
 "originAsset": "nep141:meth.pbf-ops.testnet", "depositType": "ORIGIN_CHAIN",
 "destinationAsset": "nep141:musdc.pbf-ops.testnet", "amount": "25704297758585232",
 "refundTo": "a.pbf.testnet", "refundType": "ORIGIN_CHAIN",
 "recipient": "a.pbf.testnet", "recipientType": "DESTINATION_CHAIN",
 "deadline": "2026-11-13T20:00:00.000Z", "customRecipientMsg": "{\"pb\":{\"transfer\":\"move:4\"}}"}
```

- **The life is the one of before:** a deposit address of its own (64 hex), the deposit seen with `ft_balance_of`
  there, delivery after the quote's `timeEstimate` with `ft_transfer_call` and the msg, the fault switch, and a
  refund of the origin token to `refundTo` with the same msg. Statuses and `GET /v0/status` don't change.
- **Price:** the real 1Click's dry quote for the two mainnet assets, as for every quote. On 13 Nov it priced all
  twenty directions at $50, and down to a cent's worth; it refuses under about 7 satoshis of bitcoin.
- **When 1Click refuses** (HTTP 400) a swap that names at least one of the three new tokens, the price is the two
  dollar prices of 1Click's token list: `amountOut = amountIn × price(origin) / price(destination)`, rounded
  down, with no cost taken off, `minAmountOut` from the request's slippage, and `timeEstimate` 22. The quote (and
  its status, under `shim.note`) then carries
  `shim: {"asked", "delivers", "symbol", "why", "price": "token_list", "said": <1Click's words>, "usd": {"origin", "destination", "originUpdatedAt", "destinationUpdatedAt"}}`,
  with `asked` equal to `delivers`. If the list lacks a price for either token, can't be read, or the request's
  slippage isn't whole basis points, 1Click's refusal goes back as it came. An amount worth less than one unit of
  the destination is refused in words (400). mUSDC and mNBTC between themselves never fall back: that pair answers
  as before (`near-routes.ts`, `listPriceCovers`).
- **Amounts** are whole units in BigInt from the request to the transfer, for 6, 8, 18 and 24 decimals. A list
  price is read as a decimal with 12 places before any arithmetic.
- **Until a new token is deployed,** a quote that names it is refused, dry or not, with HTTP 400:
  "Test ETH isn't on testnet yet: no token contract is deployed at meth.pbf-ops.testnet. Until it is, the stand-in
  swaps mUSDC and mNBTC only". `GET /v0/tokens` lists a new token only once it is deployed. The stand-in asks the
  chain with a view of the token's `ft_metadata` when a quote names it (`near-tokens.ts`): never for mUSDC or
  mNBTC, again 15 s after a "not there", and never again once it answered with the right decimals. So the stand-in
  needs no restart after the deploy. Other decimals than the table's are refused too (400). If the view itself
  fails, the quote answers 502 and says to try again.
- **The float** has the token's own `mint` make up what it is short of before a delivery (as since stage 4), and
  now before a refund too. `mint` attaches 0.00125 NEAR, so it also registers a float the token doesn't know.
- **No route to Base Sepolia or change to Hyperliquid's** for the new tokens: stage 4's four routes are what they
  were.

**Files:** `assets.ts` (`NearTokens`, `NEAR_TWINS`, `checkDeployed`), `config.ts` (three ids), `near-tokens.ts`
(new), `near-routes.ts` (new), `server.ts` (the refusal, the listing, the fallback), `engine.ts` (the mint before
a refund), `near-float.ts` (a comment), `index.ts` (the probe, three lines in the log), `live-kit.ts` (the live
tools keep to mUSDC and mNBTC), `fakes.ts` (fixtures added), `spot.test.ts` (new).

**Tests:** the stand-in 65 (54 before, none changed), its client 12. In `spot.test.ts`: the table above against
1Click's rows; all twenty directions through the whole life over HTTP, with amounts of 6, 8, 18 and 24 decimals
checked to the unit against hand-written figures; the list-price fallback and each case where nothing is made up;
the mint before a delivery and a refund; the fault switch on new pairs; the refusal before the deploy, and a token
starting to swap with no restart; NEAR's three "no token there" answers.

**One thing differs for mUSDC and mNBTC,** and only where a swap failed before: a refund now mints when the float
is short of the token (it used to end FAILED with the token's own error). Their quotes, prices and refusals are
what they were.

**What reading the engine and the pool showed** (all in `research/spot_tokens_deploy.md`, with file and line):
- An account that lists the three new tokens and holds none passes a check as today, on one condition: each
  listed id is a deployed token (the engine reads `ft_balance_of` on every listed token; a failed read is no
  verdict). So the tokens are deployed before the factory's `set_config`.
- wNEAR counts in full. ETH counts at Aave's test price for WETH over the engine's ETH price, at most 1. **USDT
  counts at 0.80 and is listed reduce-only on testnet:** nothing there gives its ratio.
- The pool has caps for all of them already and no coin status to set. It needs a **step price** for each new
  token before a plan step can sell one; the three operator calls are in the notes.
- A new account keeps about 0.605 NEAR free with five tokens (0.61 with two), and `create_account` needs 210 TGas
  (300 is attached). Creating an account with five tokens isn't proved in the sandbox.
- An account made before the `set_config` can't receive a new token: a swap that delivers one to it ends FAILED.

#### Shell

Built by helper W on 13 Nov, evening. Code and unit tests only: nothing deployed, signed or sent, no service started
or stopped, no new dependency, `next build` not run (the dev server was up). All paths are under `web/src/`.

**Files.** Changed: `lib/pages.ts` (and its test), `components/navigation.tsx`, `hooks/use-check-then-act.ts`,
`components/check-flow.tsx`, `components/home/moves.tsx`, `components/move-usdc.tsx`, `components/home/cockpit.tsx`,
`components/home/setup-card.tsx`, `components/home/panels.tsx`, `components/home/lenders.tsx`,
`app/borrow/borrow-view.tsx`, `lib/api.ts`. New, each pure helper with its test: `lib/broker-check.ts`,
`lib/typed-price.ts`, `lib/portfolio.ts`, `lib/borrow-page.ts`; and `hooks/use-typed-price.ts`,
`components/home/portfolio.tsx`. `components/flow-progress.tsx` and `globals.css` are not the shell's and were not
touched: the calm progress lines live in `check-flow.tsx`, and the tab row's spacing is an inline style.

**1. Tabs** (`lib/pages.ts`, `navigation.tsx`). Home, Spot `/spot`, Perps `/perps`, Borrow `/borrow`, Basis trade
`/basis`, More. Under More, in this order: Add funds, Activity, Risk, Account details, Trade (classic), Credit check,
Book, Drill (testnet). The row wraps on a narrow screen.

**2. Checks the broker pays for** (`use-check-then-act.ts`, `check-flow.tsx`, `lib/broker-check.ts`).
- `run(job)` now posts `POST /api/check` (`postCheck` in `lib/api.ts`) and, at the same time, reads the account
  every 2 s for a result that answers this intent. As soon as one is stored the page goes on to the action, whether
  or not the POST has answered. `run(job, 'wallet')` is the path of before, unchanged.
- What the page does with the answer, matched to `services/api/src/check.ts` and the keeper's `clientCheck`:

  | Answer | The page |
  |---|---|
  | 200, `accepted: true` | goes on: it reads the stored result from the account, and what the engine allowed or refused is said from there, as before |
  | 200, `accepted: false`, reason "…its result may still arrive…" | keeps waiting and watching the account |
  | 200, `accepted: false`, any other reason | stops, with plain words and what to do next; the keeper's own reason is under "The details". **No automatic fallback**: the keeper already asked up to three times |
  | 504 `check_slow`, 502, or no connection | keeps waiting and watching the account, up to 9 minutes |
  | 404, 503 (`keeper_off`, `keeper_failed`), 401, 403, 429, 400, or a 200 with neither a yes nor a reason | falls back to the wallet's check at once, and says so: "The broker's check isn't available right now, so your wallet pays for this one: at most 0.01 NEAR." |

- While it runs the page shows one line: "The risk engine is checking your account. This usually takes under a
  minute." After a minute it adds "Still checking. A slow answer is asked for again by itself: you don't need to do
  anything." The keeper's retries never show. The wallet opens once, for the action.
- After a broker's check that didn't go through, "Try again" starts over (the broker's check again), and a link
  "Use my wallet for the check (at most 0.01 NEAR)" runs the same job with the wallet's check (`again('wallet')`).
- `CheckFlow`: one button with the action's own words ("Borrow $300.00"), no "(0.01 NEAR)", and the free preview link
  is gone (the check costs the client nothing now). `CheckProgress` is exported for pages that drive the hook
  themselves; `onWallet` is optional.
- `FlowState` gained `{phase: 'broker', since}`, `broker?: boolean` on the later phases, and `fellBack?: string`.

**3. No "Get a price"** (`moves.tsx`, `move-usdc.tsx`, `lib/typed-price.ts`, `hooks/use-typed-price.ts`). The dry
price is asked 400 ms after the last keystroke, and again by itself every 30 s while the amount stays. One button
("Move 0.01 nBTC", "Send 20 USDC", "Bring 21.71 USDC home", "Move 50 USDC to Hyperliquid") holds the price, runs the
check of point 2 when one is needed, opens the wallet once and follows the move to the end. "Get a price" and "Start
this move" are gone. The 24-hour deadline guard and `expect` are as before.

**4. Home's portfolio** (`components/home/portfolio.tsx`, `lib/portfolio.ts`). Home opens with "Your portfolio": the
value now (Home's live net worth; the latest point's until prices are read), the chart from
`GET /api/portfolio/:account` drawn as one SVG path with a fill under it, the change since the first point, the low
and the high. With fewer than two points: "The chart fills in as checks come: each check of your account adds a
point." Under it, one row: On NEAR, On Hyperliquid, At lenders, Less what you owe. Then Home as it was.

**5. "Set up the demo for me" is off Home.** `SetupCard` takes `demoButton={false}` there; `setup-actions.ts` and the
checklist are untouched and importable. With no short position and no loan, Home shows one card, "Start a basis
trade", linking to `/basis`. The setup checklist itself stays on Home, so a new wallet can still open an account.

**6. Borrow page** (`app/borrow/borrow-view.tsx`, `panels.tsx`, `lib/borrow-page.ts`).
- One card "Borrow": "You can borrow $304.56 now, at 6.50% a year." ("about", and "The risk engine sets the exact
  figure when you press Borrow", when the account holds no check from the last minute), the amount with Max, "Where
  it comes from" for an account with lenders, one Borrow button. Which limit sets the most is a detail line.
- One card "What you owe": "You owe $1,025.73, at 8.08% a year.", each source for an account with lenders, the
  amount with one Repay button, and "Repay everything" (or "Repay all of Aave" with one lender picked). A line under
  it says what it sends before it is pressed, and what stays owed when the account's USDC doesn't cover it. Home's
  Repay panel is the same component, so it has the button too.
- "Take collateral back": the All button is always there; with a loan still shown at the lender, a line says the
  lender may refuse all of it and what to do then.
- A lender's figures come from the account's last check. When that check is older than 120 blocks, the Repay panel,
  the "Take collateral back" panel and Home's lender cards say "as of the last check, about 40 minutes ago"
  (`lender.verdict_blk` against the account read's `block_height`).

**7. Words.** In the shell's files no sentence a client reads names a verdict, a counter, a nonce or a quote outside
a detail line; "fresh check" sentences now say "the risk engine checks this first".

**Which test proves which rule**

| Rule | Test |
|---|---|
| Tabs and More (49.1 points 1, 9) | `pages.test.ts`: "the tabs are Home, Spot, Perps, Borrow, Basis trade and More; every page of before is under More (INTERFACES.md 49.1)", "every page of before has a route in src/app; the three new tabs are linked while their pages are being built" |
| An accepted check goes on | `broker-check.test.ts`: "an accepted check goes on to the action, with the block the engine read" |
| The fallback rule (49.4) | "the fallback rule: 404, 503, or any refusal to run it uses the wallet's own check, as before" |
| A check that stored no result is said, not paid for again | "a check the keeper asked for that stored no result is said in plain words: the wallet isn't asked to pay for the same answer" |
| A cut-off request waits | "a request cut off before its answer keeps waiting: the check may still land" |
| Price 400 ms after the last keystroke | `typed-price.test.ts`: "the price is asked for 400 ms after the last keystroke, not on every key" |
| A price that ran out is fetched again | "a price that has run out is asked for again by itself; a newer keystroke comes first" |
| The chart's points to its path | `portfolio.test.ts`: "the backend's points become dollars, oldest first, and a point that can't be read is left out", "points become one SVG path: time left to right, value bottom to top, inside the box" |
| Fewer than two points | "fewer than two points is no chart, and a value that never moved is a level line" |
| The change line and the money row | "the change since the first point, in words", "where the money is, in one row: NEAR, Hyperliquid, at lenders, less what is owed" |
| The Borrow page's headline figures | `borrow-page.test.ts`: "what you can borrow and the rate, and what you owe, each in one line" |
| "Repay everything" | ""Repay everything" says what it pays before it is pressed, and what stays owed when the account holds less" |
| "As of the last check" | "a lender's figure from an old check says so: "as of the last check"" |

Each of these fails on the code as it was (the helpers and the tab placement did not exist). The suite: 408 pass
(241 before; 14 are the shell's new ones, the rest the Spot, Perps and Basis helpers'). `tsc --noEmit` and `eslint .`
clean.

**Seen in the browser** (the running dev server, no wallet, `/dev/home` with sample data): the tab row and the More
menu; Home's portfolio card with the empty-chart line and the money row; "Start a basis trade" on a new account and
no "Set up the demo for me"; the Repay panel with "Repay everything" and its line; "Take collateral back" with All
while a loan shows; the Move USDC panel with one button. `/borrow` signed out shows the page's line and the sign-in.

**Not run, and why.** Nothing was clicked through with a wallet, so: the broker's check against the live backend and
keeper, the fallback in a real wallet, a move started by the one button, the chart with real points, and the Borrow
page signed in are unproven by hand. The hook's racing of the POST with the account reads has no unit test (it needs
a browser and a backend); its decision rule does.

**Left out, or different from the brief.**
- A 200 `accepted: false` is shown, not sent to the wallet (see the table). If the fallback is wanted there too, it
  is one line in `brokerCheckOutcome`.
- The setup checklist stays on Home without the demo button; only the button went.
- The Borrow page keeps "Compared with Rhea alone, and the carry" under the two cards, as it was.
- `/dev/home` (not the shell's file) has no sample portfolio points and no sample for an old check, so the drawn
  chart and the "as of the last check" line were not seen, only tested.

#### Backend and keeper

Built by helper K on 13 Nov, evening, in `services/api` and `services/keeper` only. Code and unit tests: nothing is
deployed, signed or sent, no service was started or stopped, and `.env` was not read. All five items of the brief
are built. The backend and the keeper need a restart to load them (either order: the keeper reads the token file at
each call).

**Where an answer differs from 49.3's table, or adds to it.**

1. **Candles come in an envelope,** not as Hyperliquid's bare array:
   `{"coin", "interval", "candles": [{"t", "T", "o", "c", "h", "l", "v", "n"}], "read_at_ms"}`, oldest first. Each
   candle is Hyperliquid's own, less its `s` and `i` (the coin and the interval, which the envelope says once).
2. **The Spot list's order** is USDC, USDT, then our allowed perps coins by the market value our coin file gives
   each (`mcap_usd` in `research/data/universe_v0.json`), biggest first. That is my reading of "dearest market
   first"; the two dollar tokens lead because the file has no market value for them. Today the list is 20 rows:
   1Click's list has no HYPE, ENA, PUMP, WLD or ONDO.
3. **`debt_micro` can be `null`** on a portfolio point: a log line written before this build has no debt on it.
4. **A swap's own fields sit under `swap`,** as a move's sit under `move`.
5. **`POST /api/check` answers 504 `check_slow`** when the keeper is still at it after the backend's wait, so the
   page keeps watching the account. A keeper that answers nonsense is 503 `keeper_failed` (the page falls back).

**The routes, with every field.**

| Route | Answer | Refusals |
|---|---|---|
| `POST /api/check` `{account, intent}` | 200 `{"accepted": true, "blk": number or null, "tries": 1 to 3, "tx": string or null}`, or 200 `{"accepted": false, "reason": string, "tries": 0 to 3, "tx": string or null}` | 404 `not_found` (privacy off); 401 `sign_in`; 403 `not_yours` (another wallet, the operator's or keeper's wallet, the service token, an open account that isn't yours); 400 (not a client account, a bad intent); 404 `no_account`; 503 `keeper_off`; 429 `too_many_checks`; 504 `check_slow`; 503 `keeper_failed` |
| `GET /api/perps/:coin` | `{"coin", "ctx": {"mark", "oracle", "funding", "open_interest", "day_volume", "prev_day_px"}, "book": {"bids": [{"px", "sz", "n"}], "asks": [...]}, "trades": [{"side": "B" or "A", "px", "sz", "time", "tid"}], "read_at_ms"}`. `ctx` values are Hyperliquid's decimal strings, or null. 20 levels a side, best first. Up to 40 trades, newest first; `side` is the taker's (B bought). No address is passed on | 400 (not a coin's name); 404 `unknown_coin` (not in our coin file: Hyperliquid isn't asked); 404 `not_listed` (ours, and not on Hyperliquid testnet) |
| `GET /api/perps/:coin/candles?interval=&n=` | point 1 above. `interval` is one of Hyperliquid's (`1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d 3d 1w 1M`), `1h` unless said; `n` is 1 to 500, 200 unless said | 400 for another interval or n; the coin's refusals |
| `GET /api/spot/tokens?account=` | `{"tokens": [{"symbol", "name", "price_usd": number or null, "on_intents": boolean, "intents_asset": string or null, "token_id": string or null, "decimals": number, "swaps_here": boolean, "lendable": boolean}], "read_at_ms"}`, at most 25 | 400 (`account` isn't a client account); 502 `oneclick_unreachable`; 503 `spot_off` |
| `POST /api/quote` `{dry, swap: {from, to}, account, amount, slippageTolerance?}` | 1Click's quote, plus `"swap": {"from", "to", "account", "next", "transfer_id", "exp_ms", "delivers": {"token", "symbol", "amount"}, "needs_check", "swaps_here": true}` | 400 `not_here` (a token that isn't in the account's settings; the words say "mainnet"); 400 `same_asset`; 400 (shape, amount, dry, slippage); 404 `not_deployed`; 1Click's own refusal as it came |
| `GET /api/portfolio/:account` | `{"points": [{"t_ms": number, "equity_micro": number, "debt_micro": number or null}], "read_at_ms", "keeper_log": boolean}`, oldest first, the newest 500 | 400 (not a client account) |

**Who may ask** (`server.ts`; `mayView` runs before the route's own work, as in 48.5): the two perps routes and the
Spot list with no `account` are open. The Spot list with `account`, a quote with `swap`, and the portfolio go
through `mayView`: 401 `sign_in` with no token, 403 `not_yours` for another wallet, and a stranger costs one read
of the account's owner and nothing else. `POST /api/check` is stricter than `mayView`: the owner's wallet alone.

**The check the broker pays for (49.4).**
- Backend (`check.ts`): the order is privacy, who asks, the account's shape, the owner (from the 60 s owner cache or
  one `get_state`), the intent (`parseIntent`, with the account's own token list beside the backend's two), the
  keeper's door, then the limiter (6 a minute for an account, `CHECKS_PER_MINUTE`), then the call. So a stranger
  uses none of the owner's six. The call is `POST http://127.0.0.1:<KEEPER_PORT>/check` with
  `Authorization: Bearer <service token>` and `{account, intent}`, waiting up to three OutLayer waits.
- Keeper (`status.ts`): `POST /check` on the status port, which listens on 127.0.0.1 only. The token is compared in
  constant time before the body is read: 401 without it, with another, or when the keeper finds no token file. It
  reads the file at each call, so a backend started again needs no keeper restart. Body over 4 KB or not
  `{account, intent}`: 400. A keeper in a dry run or with no key has no such door (404, which the backend turns
  into `keeper_off`). The account must be `<name>.<factory>` (`isClientAccount`).
- Keeper (`loop.ts`, `clientCheck`): the check goes out through the same `requestCheck` the loop uses, now with the
  page's intent. It is asked again only when the account answered "OutLayer returned no verdict…" (any reason that
  names OutLayer), three times in all. A refusal of the account's own, and a check whose end wasn't seen, are not
  asked again; the unseen one is remembered as a check on its way (`checkPending`) and its reason says "…its result
  may still arrive…". A second ask for an account while one is out is refused with `tries: 0`.
- **One check at a time, three ways:** `oneAtATime` queues every `request_check` for an account, the loop's and the
  page's; while the page's check is out (12 minutes at most) and for 90 s after its verdict, unless the account's
  counter has moved, `decide` treats the account as busy (`Seen.clientCheck`) and holds its own checks with a note;
  and the page's check sets `lastCheckAt` and `checkPrices`, so its verdict counts as one the keeper asked for.

**Perps (`perps.ts`).** Requests are Hyperliquid's own, checked against `@nktkas/hyperliquid` 0.33.3's types:
`{"type": "metaAndAssetCtxs"}` (the read `/api/markets` already shares), `{"type": "l2Book", "coin"}`,
`{"type": "recentTrades", "coin"}`, `{"type": "candleSnapshot", "req": {"coin", "interval", "startTime", "endTime"}}`.
A market is kept 1 s and candles 5 s for one coin, interval and n, and a read under way is shared: ten pages cost
one read. A failed read isn't kept.

**Spot (`spot.ts`).**
- The list is 1Click's own `GET /v0/tokens` (`@pb/oneclick`'s `tokens()`), read at 1Click's host with no key:
  `ONECLICK_API_URL`, else `https://1click.chaindefuser.com`. It is an existing setting with a new use on testnet;
  nothing was added to `.env.example`. Kept 60 s and shared by every account's answer; an account's answer is kept
  60 s too.
- A row is one of our allowed coins that the list has. NEAR is the list's `wNEAR`, and kPEPE's coin is its `PEPE`.
  For the five the engine prices (USDC, USDT, BTC as nBTC, ETH, NEAR as wNEAR) `intents_asset` is 1Click's entry for
  the very token the engine reads on mainnet (`mainnet.ts`); for the rest it is the list's first entry. `name` is
  written by hand in `spot.ts`: the list has none.
- `token_id` and `decimals` come from the account's `get_config().tokens`, matched by the pool's name (`symbol`);
  the factory's with no account or for an account with no contract. `swaps_here` is "the settings list a token for
  it". `lendable` is "one of the five".
- A swap's asset ids are `nep141:<token id>`, the stand-in's own (`assets.ts`). Both tokens must be in the
  account's settings: an older account can't receive a token it doesn't list, so that pair is refused here
  (`not_here`) and not sent to fail.
- Selling a token other than USDC: the quote carries the transfer's msg (`{"pb":{"transfer":"move:<n>"}}`), `next`
  is `withdraw` with `transfer: {"kind": "sell", "exp", "expect": {"token", "amount"}}`, and the backend keeps the
  deposit address so `GET /api/status?account=&transfer=` finds it. Paying in USDC: the deposit msg, a plain
  `withdraw`, no transfer. USDC is the account's `usdc_token`. `needs_check` is
  `{"withdraw": {"token": from, "amount"}}` while a loan is open, else null, dry or not.

**Portfolio (`portfolio.ts`).** Points are read from the keeper's log, which the backend already reads; nothing is
read from the chain, and an account's answer is kept 30 s. A point is a `verdict` line (the loop logs one for each
new verdict of an account with a loan) or a `check` line of a page's check that carries figures; two lines for one
verdict (`blk`) make one point, at the earlier time. The keeper now writes `debt` (the account's principal at our
pool) on its `verdict` line, and `blk`, `eq` and `debt` on an accepted page's check. So an account with no loan gets
points only from the page's own checks, and a time when the keeper wasn't running has none.

**Files.** Backend: `check.ts`, `perps.ts`, `spot.ts`, `portfolio.ts`, `second-shape.test.ts` (new); `server.ts`,
`handlers.ts` (`Deps.keeperCheck`, `Deps.oneClickMainnet`, `limits.checks`, the `swap` branch of `postQuote`),
`config.ts` (`keeperUrl`, `oneClickMainnetUrl`), `index.ts`. Keeper: `client-check.test.ts` (new); `loop.ts`
(`clientCheck`, `clientCheckHolds`, `oneAtATime`, the two log lines), `decide.ts` (`Seen.clientCheck`), `status.ts`
(`POST /check`), `index.ts`, `accounts.ts` (`isClientAccount`).

**Tests.** `pnpm --filter @pb/api test`: 237 (202 before, none changed). `pnpm --filter @pb/keeper test`: 228 (210
before, none changed). Both build. Each rule below was also undone in the compiled file, and its test failed.

| Rule | Test (the start of its name) |
|---|---|
| Only the owner's wallet asks a check | "49.4, only the owner's wallet…", "49.4 over HTTP: POST /api/check is 401…" |
| Refused before the chain, the limiter and the keeper | "49.4, nobody and nobody's token: 401 sign_in, before…" |
| Six a minute for an account | "49.4, six checks a minute for an account…" |
| `keeper_off`, `keeper_failed`, `check_slow` | "49.4, the keeper isn't running: 503 keeper_off…", "49.4, a check cut off by the wait is 504…" |
| 404 with privacy off | "49.4, with privacy off the route isn't there…" |
| The bearer token and the body the keeper gets | "49.4, the backend's call to the keeper…" |
| The keeper's door takes the service token only | "49.4, POST /check is refused without the service token…" |
| Retried on OutLayer's silence, three times in all | "49.4, "OutLayer returned no verdict" is asked again…", "49.4, three tries and no more…" |
| Nothing else is retried | "49.4, a verdict the account itself refused isn't asked again…", "49.4, a check whose end wasn't seen…" |
| One check at a time | "49.4, one check at a time: a second ask…", "49.4, one door for every check…", "49.4, decide: a check that is due waits…", "49.4, tick: with a client's check on its way…" |
| Our coins only, and short caches | "49.3, the perps routes answer our own coins only…", "49.3, a market's answer is kept one second…", "49.3, candles are kept five seconds…" |
| The Spot list's rows, order, size and cache | "49.3, the Spot list: USDC and USDT, then…", "…is at most 25 tokens", "…is kept 60 seconds…" |
| A sale is recorded with what should arrive | "49.3, selling a token for USDC…" |
| USDC is a plain withdraw | "49.3, paying in USDC…" |
| `needs_check` as a move's | "49.3, needs_check for a swap is a move's…" |
| `mayView` before the work, on each guarded route | the three "49.3, <route>: 401 with nothing, 403 for another wallet, before any work…" |
| One point a verdict, oldest first, cheap | "49.3, the portfolio's points…", "49.3, the portfolio is cheap…" |

**Read live, sending nothing** (the compiled handlers against Hyperliquid testnet's info API and a copy of 1Click's
list saved at 19:19 UTC): BTC's market, 20 levels a side, 10 trades (testnet gives 10), five 15-minute candles, and
the 20 Spot rows with their prices.

**Not run, and why.** No service was started, so nothing went through the running backend or keeper: a real check
by `POST /api/check`, a real swap quote from the stand-in, and the pages against these routes are unproven by hand.
The wiring in the two `index.ts` files has no unit test (it runs only when a service starts); what it calls does.

#### Spot

Built on 13 Nov, 19:02 to 19:45 UTC, in the spot helper's files only (49.5). Nothing was signed, sent, deployed or
started. The page was run in a browser against canned answers (`/spot/dev`, below), not against the backend's new
routes: the running backend answered `404` for `GET /api/spot/tokens` (read at 19:27 UTC; it needs a restart to
carry the new routes), and `/spot` shows its one calm line until then. The shapes were checked against `services/api/src/spot.ts` as written, by reading it.

**Files.** `web/src/lib/spot.ts` (every rule and sentence, no React) with `spot.test.ts`; `web/src/app/spot/page.tsx`;
`web/src/components/spot/`: `spot-view.tsx` (the page), `swap-box.tsx` (the box), `token-picker.tsx`, `use-swap.ts`
(the one-click run), `spot.module.css`; and `web/src/app/spot/dev/` (`page.tsx`, `preview.tsx`, `standin.ts`), the
development-only preview.

**The page** (`/spot`), top to bottom:
- The title, and one line: "Swap tokens inside your account. Prices come from NEAR Intents." On testnet it adds "On
  testnet our own stand-in carries the swap, at Intents’ real prices."
- **The box.** "You pay": an amount, the token, "Balance 500 USDC" and Max. A round button flips the two sides, and
  what was to be received becomes what is paid. "You receive": the amount the price gives, and the token. Under
  each amount its dollars and the token's own price ("1 BTC = $97,412.50"). Then Rate (the dearer token first; it is
  a button that turns it round), Cost (the quote's dollars in less dollars out, with the share), "You receive at
  least" (`minAmountOut`) and Time. Then one button: Swap.
- **The price comes by itself:** `POST /api/quote` `{dry: true, account, amount, swap: {from, to}}` 400 ms after the
  last keystroke and again every 30 s, through the shell's `useTypedPrice` (one timing for the whole app). It is
  asked only for a pair that swaps here, for the wallet's own account. Before it comes, for a visitor, and for a
  pair that can't swap here, the box shows what the two tokens' list prices give, marked "≈" and "by today’s
  prices, before costs".
- **The picker** (the app's side panel): search by symbol or name; "In your account" first, the most dollars first,
  each with its balance, its dollars and its price; then the rest in the backend's order with its price. A token
  that `lendable` marks carries "counts toward loans"; one that doesn't swap here carries "mainnet" and can still
  be picked. Picking the token the other side has swaps the two.
- **What stands under the box** is one thing, decided by `slotFor` in this order: no token list (a placeholder, or
  "The token list isn’t answering right now. The page keeps trying."); a pair that can't swap here ("This pair
  trades on mainnet. On testnet you see its real price.", for everyone, also when the price route answers
  `not_here` or `same_asset`, or any 4xx whose words say "mainnet"); no wallet ("Sign in to swap"); a wallet that
  hasn't confirmed (48.6: "Confirm this wallet to swap"); no account ("You have no account yet. Open one on Home,
  then come back to swap.", with a button to Home); another wallet's, or not the owner's; else the Swap button. The
  button can be pressed only with an amount the account holds and a price for it; otherwise a line under it says
  what is missing ("Enter an amount to see the price.", "You have 500 USDC in your account.", "Getting the price…",
  the backend's own refusal, or "The live price isn’t answering right now. The page keeps trying." for a 404, a 5xx
  or no backend).
- **Swap, one click** (`use-swap.ts`): (1) holds the price (`dry: false`); (2) builds the wallet's call from
  `swap.next` (`swapCall`); (3) when `swap.needs_check` names a withdrawal, runs it through the shell's
  `useCheckThenAct` and `CheckProgress`, so the broker pays (49.4) and the wallet opens once; with no check the
  wallet opens straight away; (4) follows `GET /api/status?depositAddress=` every 5 s to a final status and says
  "You received 0.00512767 BTC. It is in your account.", with the status's own `swapDetails.amountOut` when it has
  one, else the quote's as "about". Then "Swap again". A sale's transfer id is remembered in the browser
  (`pb:moves`), so Home's "Money on its way" can ask about it.
- **Under the box:** "Tokens you buy stay in your account. The ones marked “counts toward loans” raise what you can
  borrow." Then "In your account": the account's name, each token held, its amount and dollars, and the total.
- **Which account:** the one `usePrimeAccount` gives, which is the one Home shows. The page has no account picker:
  the choice made where there is one (Borrow, Account details, Home's "Use another account") is remembered per
  wallet in the browser, and Spot follows it.
- **Privacy level 1:** the list and its prices are read with no account and show to anyone. The account's balances,
  the list by the account's own settings, the price route and the Swap button need `useClientAccount` to have read
  the account, which it does only for a confirmed wallet (or with privacy off).

**The wallet's call** (`swapCall`) is the account's `withdraw(token, amount, receiver, transfer?)` with 1 yoctoNEAR
and 300 TGas, through `lib/tx.ts`'s `withdrawTx`:
- selling a token other than USDC: `transfer: {"kind": "sell", "exp", "expect": {"token", "amount"}}`, as `next`
  has it (`expect` is left out when `next` has none or it isn't a token id and whole units);
- paying in USDC: no `transfer`;
- **a sale whose `next` has no `transfer` goes out as that plain withdraw.** The backend writes it so for an account
  with no `next_move`, and has the delivery arrive with the deposit msg. (The brief named only the first two.)
- Not sent, with one sentence ending "Nothing was sent. Try again for a new price.": no `next` or another method;
  another token than the one paid with; more than was typed; a `receiver` other than the quote's `depositAddress`;
  a `transfer` of any other kind, without a numeric `exp`, or on a USDC payment; a price whose deadline has
  passed; and a quote that expires more than 24 hours ahead (40.1, `withdrawTx`'s own refusal).
- The check's intent is `{withdraw: {token, amount}}` of the call itself, which is what the account compares.
- **A guard the brief didn't ask for** (`priceMoved`): one click means nobody reads the held price before the
  wallet opens, so a held price that delivers less than the "You receive at least" on screen isn't sent, and the
  page says what it would deliver now.

**A failure in one sentence, with what to do** (all in `lib/spot.ts`): the price couldn't be held (`holdProblem`);
the wallet closed ("…press Approve to open it again", and Approve sends the same call unless its price has run
out); the account refused the call, in its own words (`refusedWords`); and each final status (`statusWords`):
REFUNDED and INCOMPLETE_DEPOSIT say the tokens came back, FAILED says they haven't and where to look (Home's
"Money on its way" for a sale, Activity for a USDC payment, which the account doesn't list).

**`/spot/dev?state=visitor|ready|loan|refund|new|quiet`** (development only; a production build answers 404, as
`/dev/home`): the page from sample data, with a wallet that sends nothing and a stand-in for the page's routes
(25 tokens with typed-in prices, five that swap; a quote at the two prices less 0.1%; a check that passes after
2.5 s in `loan`; a status that goes waiting, swapping, delivered, or sent back in `refund`). Run on 13 Nov: a swap
to its end in `ready` (USDC for ETH, and Max of USDC for bitcoin), in `loan` (bitcoin for USDC, with the check) and
in `refund`; a mainnet pair's line; the other three states looked at; `ready` also in dark and at a phone's width.

**Tests** (`web/src/lib/spot.test.ts`, 77; the app's suite 414 at 19:44 UTC, `tsc --noEmit` and `eslint .` clean),
by rule:

| Rule | Test |
|---|---|
| The lines under the title | "under the title: what the page is, and on testnet…" |
| The list as 49.3 writes it, at most 25 | "the token list is read as INTERFACES.md 49.3 writes it…", "the list never shows more than 25 tokens…", "a row with no name, no price or no flags still shows…", "an answer that isn’t the list…" |
| Held tokens first, with balances; search | "the picker lists the tokens the account holds first…", "a token held with nothing in it…", "the search finds a token by its symbol or its name…", "the search finds nBTC by "btc"…" |
| Amounts by each token's decimals; Max | "an amount typed is read with the token’s own decimals: 6 for USDC, 8 for bitcoin, 18 for ETH", "nothing typed, zero, or no token…", "more than the account holds is marked, and still priced…", "Max fills in all the account holds, exactly…", "units become text for the amount field…", "amounts read with grouping…" |
| The rate and its inverse | "a quote’s rate is what arrives over what leaves…", "with no quote, the rate is the two tokens’ own prices…", "the rate first shows the dearer token’s price in the other…" |
| Which pairs swap here, and the line (49.2) | "a pair swaps here only when both tokens do…", "a pair that can’t swap on testnet never gets a button, whoever looks…", "the backend’s two refusals of a pair, `not_here` and `same_asset`, both get the mainnet line", "a token that says it swaps here but names no id on NEAR…" |
| The price request (49.3) | "the price is asked as INTERFACES.md 49.3 writes it…", "a pair with a token that has no id here is never asked for a price" |
| A 404 or an error: one calm line | "a price route that isn’t there yet, or a backend that is down, gets one calm line", "a price route that doesn’t answer leaves the button unpressable…", "a token list that didn’t answer gets one calm line…" |
| The wallet's call from `next` | "selling a token other than USDC: withdraw with the sale’s record and what should arrive, exactly as the quote’s next says", "paying in USDC: a plain withdraw…", "a sale whose next call carries no record goes out as the plain withdraw…", "the backend’s own answer for a sale and for a USDC payment, as services/api/src/spot.ts writes them, both build"; what isn't sent: "a dry quote, or one with no next call or another call, sends nothing…", "a next call for another token, for more than was typed, or to another address…", "a record of any other kind…", "a price that has run out is not sent…", "a held price that delivers less than the box’s "at least" is not sent…" |
| The check, when the quote names one | "while the account owes our pool the quote names a check: a withdrawal of the call’s own token and amount" |
| Status to words; "You received X" | "1Click’s seven statuses map to five stages…", "a swap that went through says "You received X"…", "a swap on its way says where it is…", "a swap that failed says in one sentence what happened and what to do" |
| Privacy level 1 | "privacy level 1: no wallet gets "sign in" and an unconfirmed wallet "confirm"; neither sees a Swap button", "privacy level 1: balances show only to a confirmed wallet…" |

**Not done, and not seen:**
- **No swap with a real wallet, and no call to the live routes.** Unproven by hand: the list and a price from the
  real backend; the wallet's approval of a `withdraw` with a `sell` transfer; the check's hand-off to the wallet on
  this page; the status of a real swap; balances after one.
- **Balances of ETH, wNEAR and USDT won't show after 49.6's deploy as the backend stands.** The page reads balances
  from `GET /api/account`, which lists only the backend's own two tokens (`ids.tokens`: USDC and nBTC). A token
  missing there shows no balance and no Max, isn't listed under "In your account", and paying with it has no
  "more than you hold" line (the account itself would refuse). The page already reads an optional `balance` (the
  token's own units, digits) on a row of `GET /api/spot/tokens?account=`, if the backend adds one; listing the
  account's own settings' tokens in `GET /api/account` would be better, since that is read every 8 s and the list
  is kept 60 s.
- **A check that runs longer than the price holds.** The held price lasts about 10 minutes and the broker's check
  can take up to 9. The call that goes to the wallet after a slow check is the one built at the start; nothing
  re-reads the deadline at that moment (the hook has no place for it).
- No component test: the suite is the pure helpers, as for the rest of the app.
- `MoveTransfer` in `lib/tx.ts` names `to_hl` and `to_evm` only, so `swapCall` passes its `sell` record through a
  cast. `web/README.md` and `lib/pages.ts` don't mention `/spot/dev`.

#### Basis trade

The page `/basis` (13 Nov, evening). It takes the place of "Set up the demo for me" (49.1, point 5). App only: no
contract, engine or backend change, and nothing was deployed, signed or sent.

**Files** (all new): `web/src/app/basis/page.tsx`; `web/src/components/basis/` (`basis-view.tsx`, `open-trade.tsx`,
`close-trade.tsx`, `loan-box.tsx`, `parts.tsx`, `use-basis-data.ts`, `use-open-run.ts`, `use-close-run.ts`);
`web/src/lib/basis.ts` with `basis.test.ts`; and a development-only preview, `web/src/app/basis/dev/` (`page.tsx`,
`preview.tsx`, `states.ts`).

**The page.** Three cards say the trade (hold the coin, short the same amount on Hyperliquid, borrow dollars against
both). Then two cards: "Open a basis trade" and "Close everything". It is behind `WalletGate`, so with privacy level 1
a wallet that hasn't confirmed sees the sign-in card (48.6). One run at a time: while one card's run is on, the other
offers nothing.

**Every decision is made from the account's real state**, read again before each step (`GET /api/account`,
`/api/hl`, `/api/lender`, 1Click's status for each listed move). The page remembers nothing between steps, so a
reload or a failure goes on from where the account is, and the button then reads "Continue: <the step>".

**Open a basis trade** (`openSteps` in `lib/basis.ts`; the run is `use-open-run.ts`).
- A coin, a size and one button, "Open the basis trade". The size defaults to about $1,150 of the coin in two figures
  (0.015 BTC at $76,000) and must fit Hyperliquid's size step. Once the coin is in the account the trade is that size:
  the short matches what is held.
- **The coins** are the tokens of the settings that a perp can hedge, in this order: nBTC (shown as BTC), ETH, wNEAR
  (shown as NEAR). For an account that exists they are the account's own settings, `get_config().tokens`, read from
  NEAR through the wallet's connection; for a new one the factory's (`factory_config.tokens` in `GET /api/config`).
  Nothing the settings don't list is offered. A token whose balance the page can't read (it isn't in
  `GET /api/account`'s `balances`) shows as "(not yet)" with the reason and can't be picked.
- **The rail**, nine steps at most: open your account; put the coin and the margin in your account; create your
  Hyperliquid address; move the margin to Hyperliquid; connect the trading agent; approve the trading agent; short
  the same amount; get test collateral for Aave (testnet, when the account's settings name Aave and the backend's
  helper is on); borrow dollars against both. The current step is highlighted, with a line on what it is for.
- **Each approval is said before the wallet opens** (`openApproval`): "Your wallet will ask you to approve: move
  $440.00 of USDC to Hyperliquid." The run then goes on to the next step by itself and stops at the loan.
- **Which code runs each step.** Seven are the demo setup's own, called through `useSetupActions().runStep` from
  `components/home/setup-actions.ts` (the account, the address, the margin, the agent, its approval, the BTC short,
  test collateral for Aave): they are the ones the click-through of 13 Nov proved. Two are this page's: the
  collateral in the size picked (two `mint`s in one approval where the wallet can), and the short of a coin other
  than BTC (the same order as the demo's, by coin).
- **The margin** is 38% of the short's value, up to $10, at least $20 (the demo moved $430 for $1,140), plus $10 that
  stays on NEAR. What already sits on Hyperliquid counts: the margin step is done only when Hyperliquid holds three
  quarters of that or the short is open, so the dollar a closed trade left there is not taken for margin.
- **Margin already on its way** (a `to_hl` transfer listed) is waited for, never sent again.
- **The loan** (`loan-box.tsx`): an amount, where it comes from, and one button, which is the app's own `CheckFlow`
  (`fund` for an account that can use lenders, `borrow` otherwise; "Borrow $X instead" when the check allows less).
  The default is the engine's own figure once a check has given one, else 40% of the coin's value down to $10
  (`suggestedLoan`), and nothing under $1,000 of collateral, with a line that says why. Where it comes from is
  `WhereItComesFrom` (Home's) for an account that can use lenders, and "the broker's own pool, at X% a year"
  otherwise. While the loan's steps run, Home's `FundingPlan` shows them.

**Close everything** (`nextCloseStep` in `lib/basis.ts`; the run is `use-close-run.ts`). One button; the rail has five
parts: repay the loans; take the collateral back and bring it home; close the short; bring the USDC home from
Hyperliquid; withdraw to your wallet. Before each step the account is read and `nextCloseStep(state)` decides:

1. **What is already under way:** a loan whose steps still run is stopped (`cancel_funding`); a step at Rhea that is
   finishing is waited for; a transaction the account signed for Aave's chain and never sent is sent; one sent and
   not mined is waited for; a listed move is waited for, or dropped once past its deadline (`forget_transfer`).
2. **Our pool:** repaid first when the USDC on NEAR covers it (the debt and 0.002%), with `repay(debt + 0.1% + $1)` or
   all the USDC if that is less, so that the pool sends some back and the account's loan closes. Repaying needs no
   check, and with the pool repaid nothing after it needs one. When the USDC doesn't cover it and USDC sits at the
   address on Aave's chain, that comes home first (`e_home`, with the check the quote names). Otherwise the account
   needs more USDC: minted on testnet, and on mainnet the run stops and says "Add funds, then press Close everything
   again".
   - A loan the account still counts as open with nothing owed (a repayment of exactly the debt) is closed by $1 that
     comes straight back: without that, USDC can't come home from Hyperliquid.
3. **Rhea:** `lender_repay` of the debt, 0.002% and 100 micro-USD, from NEAR.
4. **Aave:** `lender_repay` from the USDC at the address (with `evm_approve` first, unless the account lists it).
   Short by the interest alone, testnet's faucet adds 1 test USDC (`POST /api/evm/gas`), with no move and no check;
   if the faucet fails, or the shortfall is larger, USDC is sent from NEAR (`to_evm`).
5. **Collateral:** `lender_withdraw` of all that Aave holds, then Rhea; what Rhea kept above the debt comes back
   after its collateral; collateral at the address comes home (`e_home`); then USDC left there, if $2 or more.
6. **The short:** a reduce-only, immediate-or-cancel order for the position's size, half the price band past the
   reference. **Then** `hl_withdraw` of what Hyperliquid says can leave, if $2 or more.
7. **Out:** `withdraw` of every balance to the owner's wallet, in one approval where the wallet can.

- **The lesson of 48.13 is a rule:** while a move to Aave's chain is listed, the step is to wait for it, and once
  1Click says it arrived the step is the check (`check_move`), never the repayment, even when the address already
  holds enough. Only when the account lists nothing is Aave repaid. The page says so on the step: "The repayment
  comes after it, not before."
- **On the user's own account of 13 Nov the way out needs no check:** repay the pool, repay Aave, take the WETH back,
  bring it home, close the short, bring the USDC home, withdraw.
- **What is owed to a lender is not taken from the last check alone** (48.13: "stale after the repayment").
  `GET /api/lender`'s `lenders[].debt` is the held verdict's figure, so after a repayment it still shows the loan.
  The page sets it against what it can see for itself (`lenderSide`, `aaveOwed`): with nothing posted with a lender
  nothing is owed there (`evm.posted` and `held` are the lender's own books); while Rhea holds a deposit of the
  account's, Rhea has been paid; and the account's transactions on Aave's chain show each mined borrow and repayment
  in order. When those can't tell (no borrow on the list, or the list is full at 20), the check's figure stands,
  and after a repayment the run asks for one check so the page sees it.
- **A part that couldn't be read is never taken for a part with nothing in it:** the run stops, and says so, when
  Hyperliquid or the lenders didn't answer, or Aave's chain couldn't be read while something is owed or posted there.
- **Checks** go through `useCheckThenAct` as it is (the broker's check of 49.4 first, the wallet's as the fallback).

**A failure** shows in a box under the step: what happened in one sentence, what to do, and "Try again", which reads
the account and goes on from where it is (`failureWords`). "OutLayer didn't answer in time. Nothing was sent. Try
again." The reason as the contract, the wallet or the server gave it is behind "Details". The words `verdict`,
`counter`, `nonce` and `quote` appear in no title, announcement, note or failure line.

**The preview** (development only; a production build answers "not found"): `/basis/dev?state=new|margin|loan|open|
aave-home|aave-repaid|empty`. A stand-in in the page answers the calls to `/api/...` from a made-up account and plays
the chain, Hyperliquid, Aave's chain, 1Click and the check on it; the wallet approves at once, or with
`&wallet=refuses` turns every approval down. Nothing is signed or sent.

**Which test proves which rule** (`lib/basis.test.ts`, 43 tests):

| Rule | Test |
|---|---|
| Only tokens the settings list; ETH and NEAR once they are there | "the dropdown offers only tokens the settings list: BTC today, ETH and NEAR once they are there"; "a token the page can't read, or a coin Hyperliquid doesn't list, shows and can't be picked, with the reason"; "settingsTokens reads `tokens` from a config answer…" |
| The size and its default | "the first size is about $1,150 of the coin…"; "a size is read in the token's units, and one finer than Hyperliquid's step is refused in words" |
| The margin, and what the collateral step adds | "the margin is 38% of the short, up to $10, and the collateral step adds only what is missing"; "the margin that moves is all the USDC but $10…" |
| The loan's default | "the loan's default: the engine's own figure when there is one, else 40% of the coin, and nothing under $1,000" |
| The open flow's steps from state; resume at the right step | "opening, step by step: each step is done by what the chain and Hyperliquid show, and the next one is current" |
| Nothing is sent twice | "margin on its way to Hyperliquid is waited for, never sent a second time"; "a loan whose steps are still running is waited for, and counts as borrowed once they have run" |
| Opening again after a close | "a dollar left on Hyperliquid by an earlier trade is not margin: the trade can be opened again after a close"; "a lender loan that was repaid doesn't count as borrowed, though the last check still shows it…" |
| The Aave step only when the settings name Aave | "test collateral for Aave is a step only on testnet, for an account whose settings name Aave, while the helper is on" |
| The short is the picked coin's | "the short is the picked coin's: a BTC short doesn't hedge ETH" |
| Each approval is announced | "each wallet approval is announced before it opens, with its amounts"; "every step of the way out has a plain line, and says what the wallet will ask before it asks" |
| `nextCloseStep`, every branch | the fourteen tests named "closing: …" |
| The lesson of 48.13 | "closing, the lesson of 13 Nov: after USDC is sent to Aave's chain the next step is the check, and only then the repayment" |
| The pool first when the USDC covers it; fewest checks | "closing: our pool is repaid first when the account's USDC covers it, which needs no check"; "closing, start to end on the user's own account of 13 Nov: no check is needed anywhere" |
| A lender's money comes home when it is needed | "closing: when the USDC on NEAR doesn't cover the pool, the lender's money comes home from Aave's chain, with its check" |
| A repayment the last check hasn't seen | "a repayment the last check hasn't seen still counts…"; "after Aave and Rhea are repaid, the close state says so at once, though the last check still shows the loans" |
| The close state from the backend's reads | "the close state is read from the account, its lenders, its address and Hyperliquid"; "an unread chain marks nothing as unsent…"; "a Hyperliquid side that couldn't be read is never taken for one with nothing on it"; "USDC a unified Hyperliquid account keeps in spot can come home…" |
| A failure in one sentence and what to do | "a failure says what happened in one sentence, and what to do" |
| No verdict, counter, nonce or quote on the main surface | "no word of the engine's own reaches the main surface: verdict, counter, nonce, quote" |

Results on 13 Nov, 19:48 UTC: `pnpm --filter @pb/web test` 415 of 415 (241 before this round; 43 are this page's);
`tsc --noEmit` and `eslint .` clean. Privacy level 1 has no test of its own here: the page uses `WalletGate` as the
other pages do.

**Looked at in the browser pane** (the running dev server, the preview's stand-in; no wallet, nothing sent): `/basis`
with no wallet shows the three cards and the sign-in line. In the preview: from `new`, one click ran the eight steps
to the loan, "Borrow $450.00" ran the check and the loan, and "Close everything" ran to "Everything is closed"; from
`open` (the user's account of 13 Nov) the way out took seven steps and no check; from `aave-home` it took nine, in the
order send, wait, check, repay; with `wallet=refuses` both runs stop with "The wallet closed before you approved.
Nothing was sent. Try again." A phone's width shows no sideways scroll.

**Not done, not proved:**
- **Nothing ran against testnet or a real wallet.** The two runs are proved only against the preview's stand-in, which
  I wrote from the shapes in `lib/api.ts`. The first real click-through is the user's.
- **ETH and NEAR can't be picked yet**, even after 49.6's deploy, until `GET /api/account` lists their balances (the
  backend's `ids.tokens` has USDC and nBTC; the Spot notes above say the same). The opening run is written for any
  coin, and its two own steps for ETH and NEAR were never run.
- **Collateral on mainnet:** the collateral step mints test tokens, so on mainnet the run stops there and points to
  Add funds.
- **A position under Hyperliquid's $10 minimum** can't be closed by the run: the app's order rounding refuses it.
- **Amounts under $2** on Hyperliquid or at the address on Aave's chain are left there, and the last line says so.
- **A move home that 1Click sent back** stays listed until its deadline; the run waits for it (8 minutes, then it
  says the money is still on its way) and drops it once it is past the deadline.
- **Right after a close, Home's checklist rule `testCollateralStep` (`lib/setup.ts`) still counts Aave's collateral
  as there**, from the last check's `posted`, until the next check. Opening again in that hour skips the test
  collateral, and the loan comes from our pool.
- `web/README.md` doesn't mention `/basis` or `/basis/dev`.

### 49.8 At the join (13 Nov, 19:38 to 20:39 UTC)

**The token deploy ran as `research/spot_tokens_deploy.md` writes it**, 19:38 to 19:41 UTC, thirteen transactions,
each signed from the keychain. One `create-account` (`musdt`) answered "Transaction has expired" and was sent again.
- `meth.pbf-ops.testnet` (18 decimals), `mwnear.pbf-ops.testnet` (24), `musdt.pbf-ops.testnet` (6): the code on
  chain is `f17e208d…`, the file `musdc` runs. Deploys `Fi46mSMu…`, `GTFW34BG…`, `4EHTpDoi…`.
- The float holds 500 test ETH, 250,000 test wNEAR and 1,000,000 test USDT (`AXXDE97r…`, `5gPgh3Kr…`, `2Fm8EpbK…`).
- The pool's step prices: ETH $2,300, wNEAR $4.20, USDT $1.05 (`D8bXVoc8…`, `2XHfKtVH…`, `J9kwjY3S…`).
- The factory's `set_config` (`DYCzMaN4…`, 19:40:50 UTC): `tokens` is the only key that changed, now five. Account
  code `79827e65…`, 21 accounts, not paused: as before. **Accounts made from then on list five tokens; older ones
  two**, and the Spot page shows them the mainnet line for ETH, NEAR and USDT.

**Suites, my own runs:** backend 238, keeper 228, stand-in 65, app 416, 1Click client 12 (959). The app's `tsc
--noEmit` and lint are clean. `next build` was not run (the dev server was up).

**Changed at the join (mine):**
- Backend `getAccount` read balances for the backend's own two tokens only, so test ETH, wNEAR and USDT would never
  show a balance. It now reads the account's own list (`accountTokens`: `get_config().tokens`, kept 10 minutes; a
  list that can't be read falls back to the two and isn't kept). Test: "account: the balances are of the tokens the
  account's own settings list…".
- Home's net worth priced USDC and nBTC only, and went blank with any other token held. It now prices ETH and wNEAR
  from the markets read and USDT at $1 (`components/home/cockpit.tsx`).
- Home's "Trade" button, which led to the page of before, is two: "Swap" (`/spot`) and "Perps" (`/perps`). The
  Hyperliquid card's link goes to `/perps`.
- `lib/tx.ts` `MoveTransfer` takes `sell` with its `expect`; the Spot page's cast is gone.
- `lib/setup.ts` `testCollateralStep`: Aave's live reading (`evm.posted`) decides when there is one; the last
  check's row counts only without it. After a close the row still showed collateral, so a reopened trade would have
  skipped the step. Test added in `setup.test.ts`.
- `.claude/launch.json`: `keeper-two` (`--newest 2`), so a gate's account and a click-through's are both watched.

**Kept as the helpers built them:** the stand-in's three choices (no list-price fallback for the pair of before,
mint before a refund for every token, the symbols ETH, wNEAR, USDT on chain); the page doesn't fall back to a
wallet-paid check by itself after the keeper asked and no result was stored (a link does it by hand); candles in an
envelope; the Spot list ordered by market value.

**Proved live:**
- `create_account` with five tokens: `fund-rhea-11131946.pbf.testnet`, 6.9 s, owner `pbf-keeper.testnet`. Its five
  registrations and balances read back. A preview on it brought a verdict (HEALTHY).
- **A real swap both ways** through `POST /api/quote` with `swap` and the owner's `withdraw` (near CLI, the keeper's
  key): 5 USDC to 0.002552604135152772 test ETH (`4MHFRS3C…`, SUCCESS in about 30 s), then all of it back for
  4.965847 USDC with `transfer: {"kind":"sell","exp","expect"}` (`4rpKcFux…`, `move:1`, SUCCESS in about 30 s).
  No loan was open, so neither needed a check.
- **The keeper's `POST /check`**, called with the service token for `npme2jlqx2.pbf.testnet` (closed, no loan):
  accepted on the first try in 98 s (`9E1xSFMp…`).
- **Gate 2 passed on this code, 20:38:47 UTC**, on that five-token account, in three starts. Both stops were
  OutLayer's testnet queue ("OutLayer returned no verdict": `fund` at 19:54, `settle_fee` at 20:11; previews took 94
  to 176 s then, 15 to 45 s when it passed). The keeper, on this round's code, did the top-up by itself (76 s).
  Record: `research/data/phase6_funding_rhea.second-shape-2026-11-13.json`.

**Not proved:** every wallet step of the new pages (Spot's swap, Perps' orders, the Basis trade's two runs, the
Borrow page), and `POST /api/check` asked by a signed-in wallet. Swaps into test wNEAR and test USDT (only ETH was
swapped). A check on an account that holds test wNEAR (NEAR then becomes a third priced coin). `next build`.

## 50. The app's third shape, and the pause that lifts early (13 Nov, 21:15 UTC; rules before the build)

The user's second click-through (13 Nov, from 20:50 UTC) and their words "implement these ui/ux changes first
followed by the real fix".

### 50.1 The app (web only; no contract, engine or backend change)

1. **Signed out, Home shows the app, not a sales page.** `components/home/landing.tsx`'s headline, paragraph, two
   buttons, "The worked example" and "How it works" all go ("this whole page looks a bit amateur"). In their place:
   the same Home frame a signed-in wallet sees, with the portfolio card empty and one "Sign in" button in it, and a
   short row of live prices (public reads) that link to Spot and Perps. No sentence that sells.
2. **Home, signed in.** Stays: the portfolio card, the setup checklist while it is unfinished, the three tiles,
   health and "Where your money is", money on its way, a loan on its way, "Your address on Base Sepolia", recent
   activity. Goes: the "Start a basis trade" card, and the whole row of buttons (Borrow, Repay, Add funds, Withdraw,
   Move USDC, Swap, Perps). The lenders' cards ("Aave on Base Sepolia", "Rhea on NEAR") move to the Borrow page,
   with their Repay and "Take collateral back" working there.
3. **"Add funds" under More becomes "Add & withdraw"**: one page (`/deposit`) with both, adding first and
   withdrawing second, each with its own heading, one account read. The withdrawal is the one of before (its check
   when a loan is open).
4. **Moving USDC to and from Hyperliquid** lost its Home button, so it sits on the Perps page: one "Move USDC"
   button by the account figures that opens the panel of before.
5. **The pause banner says what to do.** For an account as they are today: the sentence of before, then "A new
   account can borrow today." with the way to one.

Every panel that a moved or removed button opened must still be reachable from the page its subject now lives on.
The dev sample pages follow. No new dependency.

### 50.2 The pause that lifts early (engine, account, keeper, backend, app)

The plan, with what it rests on, is `research/send_pause_plan.md`. The interface, exactly:

- **`get_state().hl`** gains two fields on accounts made after the deploy:
  - `open_sends`: a list of strings, each the nonce (unix ms) of a `sendAsset` the account asked the signer to sign
    that no accepted verdict has named as sent and that is younger than `SEND_OPEN_MS`. Oldest first, at most 8.
  - `send_floor_until_ms`: a string, unix ms, `"0"` when unused. When a ninth is noted, the oldest leaves the list
    and the floor becomes the later of itself and that nonce plus `SEND_OPEN_MS`.
  - `send_open_until_ms` keeps its meaning and its place: the pause's end. It is always the later of the floor and
    the newest open nonce plus `SEND_OPEN_MS`, or `"0"` with neither.
  - An account that doesn't show `open_sends` is one made before: the rule of before, for 2 days and 1 hour.
- **The verdict** gains `sent`: a list of JSON numbers, nonces. Left out when empty. The engine names a nonce only
  when it is in the account's `open_sends` **and** Hyperliquid's `userNonFundingLedgerUpdates` for the account's
  address shows an entry whose `delta.type` is `"send"`, whose `delta.user` is the account's address (any case) and
  whose `delta.nonce` is that number.
- **The order of the engine's reads:** with any open send, that ledger read (from one hour before the oldest open
  nonce) comes before `clearinghouseState` and `spotClearinghouseState`. So a transfer the verdict names as sent is
  already out of the balances the verdict counts. The ledger read for `arrived` stays where it is, after them.
  A ledger read that fails names nothing, and the run goes on.
- **The account, on accepting a verdict** (and only then): removes from `open_sends` every nonce in `sent`, drops
  the ones older than `SEND_OPEN_MS`, and sets `send_open_until_ms` by the rule above. A nonce in `sent` that isn't
  in the list changes nothing. `assert_no_send_open` and its callers don't change.
- **Not changed:** the pool, `pb-gateway`, the parameter file, its hash, the model name, `SEND_OPEN_MS`.
- **The gate** (gate 2) gains `pause_lifted`, `borrow_again`, `repay_again` between `home` and `withdraw`.
- **The app**, for an account that shows `open_sends`: a page no longer holds back the check that precedes a loan
  while the pause is on; the banner says "Your transfer out of Hyperliquid went through. The next check confirms it,
  and borrowing opens again." with "Check now"; after a check that left the pause on: "A transfer out of
  Hyperliquid was signed and not sent. Borrowing opens again on <date>."

### 50.3 As built

#### Keeper and gate

Built by helper K in `services/keeper/src` and `services/api/src`. Code and unit tests only: nothing is deployed,
signed or sent, no service was started or stopped, `.env` was not read, and there is no new dependency.

**Gate 2's step list** (`funding-kit.ts`, `FUNDING_CLOSE_OUT`): `repay_rhea`, `repay`, `credit`, `rhea_withdraw`,
`close_short`, `home`, **`pause_lifted`, `borrow_again`, `repay_again`**, `withdraw`. 29 steps in all (26 before).
`--from` takes each new id, the dry run prints them as steps 21 to 23 (the withdrawal is 24), and the gate's last
line says whether the second loan was shown or skipped (`passWords`).

**The three steps** (`funding-steps.ts`). Each reads `get_state().hl` first.

| Step | On an account that shows `open_sends` | It passes when |
|---|---|---|
| `pause_lifted` | Reads Hyperliquid's `userNonFundingLedgerUpdates` for the account's address, from one hour before the oldest open nonce, every 5 s for up to 2 minutes, until every open nonce shows as a `send` by that address (50.2's own rule, `sendsInLedger`). Then `request_check` with `{"borrow":{"amount":"50000000"}}` and 0.01 NEAR. If the pause is still on after the result is accepted, it waits 30 s and asks once more | `hl.send_open_until_ms` is exactly `"0"` and `hl.open_sends` is an empty list. Two checks at most: a second miss fails the step, and its words name the open transfers and the date, or the floor |
| `borrow_again` | The owner's `borrow(amount)` with 1 yoctoNEAR and 300 TGas, on the result the account holds. Amount: $50, or `allow.borrow` if that is less | The pool's `debt_of` went up and the account's USDC balance went up by the amount, inside 30 s. It fails, sending nothing, when the result isn't HEALTHY or allows nothing (the words repeat what the result said), and when the pause is still on. It fails when the pool refuses (`borrow` answers false), with the pool's logs |
| `repay_again` | `repay` of the debt, a tenth of a percent and $1 more (the `repay` step's own body, now shared as `repayAll` in `hedge-steps.ts`) | `debt_of` is 0 and the loan is closed |

- **One check serves both.** `borrow_again` asks for another check only when the result the account holds can't
  back a borrow (`heldBacksBorrow`): it doesn't answer a borrow, its nonce isn't the account's counter, or it has
  fewer than 15 of its 120 blocks left. `pause_lifted` run again after it passed asks for none while that result
  still stands.
- **An account made before the deploy** shows no `open_sends`: each of the three steps records
  `detail.skipped` and passes, nothing is sent or read from Hyperliquid, and `pause_lifted` logs one line:
  "<account> was made before the pause could lift early (its state shows no open_sends): it keeps the 2 days and
  1 hour, so pause_lifted, borrow_again and repay_again are skipped".
- **The record.** `context.pause_lifted` is `{"blk", "checks", "open_before", "sent"}` and `context.borrowed_again`
  is the amount. `pause_lifted`'s detail has `open_before`, `send_open_until_ms_before`, `ledger` (`shown`,
  `waited_s`), each check's result summary with its `sent` and what the account showed after it, and the final
  `send_open_until_ms` and `open_sends`. `borrow_again`'s has `borrowed`, `asked`, `allowed`, `checks_asked_here`,
  the result's summary, the USDC before and after, `debt_after`, and `seconds_since_home` (from the end of the
  record's `home` step). `home`'s detail gains `open_sends` when the account shows it.
- **A record written before today resumes.** Its steps are all still in the list, so `--from <any old step>` keeps
  what it kept before. The three new steps are not in it, so they run when the run reaches them: with
  `--from withdraw` they run first, and on an older account they are skipped and the gate can pass.

**`assertNoSendOpen`** (`hedge-steps.ts`, now built on `sendOpenProblem`). An older account gets the sentence of
before, word for word ("… Use a new --name."). An account that shows `open_sends` is told that a check lifts the
pause once Hyperliquid's history shows the transfer (in gate 2, run from `pause_lifted`), and when it ends by
itself. With a floor in force it is told that no check ends it sooner.

**Types.** `state.ts`: `AccountState.hl` gains `open_sends?: string[]` and `send_floor_until_ms?: string`, and
`VerdictJson` gains `sent?: number[]`. `hedge-steps.ts`: `HlAnswer.hl` gains the same two, and `state()`'s verdict
gains `intent`. The keeper's loop reads none of them and is unchanged.

**Backend: nothing needed.** No code in `services/api` reads `send_open_until_ms` or holds anything back on it.
`GET /api/account/:id` answers the account's whole `get_state()` and `GET /api/hl/:account` answers its `hl` object,
both as the account gives them, so the two new fields reach the pages with no change. I added the three fields to
the `HlState` type as a note, and one test that both routes pass them on and that an older account's answer has
neither new field.

**Tests.** `pnpm --filter @pb/keeper test`: 248 (228 before). `pnpm --filter @pb/api test`: 239 (238 before). Both
build. New: `services/keeper/src/pause-steps.test.ts` (20 tests) and one test in `services/api/src/hl-handlers.test.ts`.
Two tests of before in `funding-kit.test.ts` were changed on purpose: the pinned step list (now with the three
steps, 29 in all) and the count of the plan's "Checks:" lines (22, was 18). Each rule was undone in the compiled
file and its test failed.

| Rule | Test (the start of its name) |
|---|---|
| The step order with the three new steps | "50.2, gate 2's way out: after the transfer home…", "the gate's steps: the hedge, then the loan…" |
| The dry run's plan knows them | "50.2, the dry run's plan says the three new steps in their place…" |
| The skip on an older account | "50.2, on an account that doesn't show open_sends the three steps are skipped with one line…" |
| `pause_lifted` passes only on `"0"` and an empty list | "50.2, the pause is lifted only when…", "50.2, pause_lifted fails when the list is empty and send_open_until_ms isn't "0"…" |
| The one retry, and never a third check | "50.2, pause_lifted asks once more when the first check leaves the pause on…", "50.2, pause_lifted fails after the second check…" |
| No check before Hyperliquid's history shows the transfer | "50.2, pause_lifted asks for no check while Hyperliquid's history doesn't show the transfer…" |
| What counts as sent | "50.2, a transfer counts as sent when Hyperliquid's history has a send by the account's own address…" |
| The amount rule | "50.2, the second loan is $50, or what the check allows if that is less…", "50.2, borrow_again borrows what the check allows…" |
| One check serves both | "50.2, borrow_again borrows $50 from our pool on the check that lifted the pause, with no second check…", "50.2, borrow_again asks for a second check only when…" |
| The loan must arrive; the pause must be off | "50.2, borrow_again fails when the pause is still on, when the pool refuses the loan, and when the loan doesn't reach the account" |
| An old record resumes | "50.2, a record written before the three steps existed still resumes…" |
| The message for each kind of account | "50.2, what stops a borrow while a transfer is open…" |
| The pass-through in the backend | "50.2: the account's open_sends, send_floor_until_ms and send_open_until_ms reach the pages…" |

**Read live, sending nothing.** For `npme2jlqx2.pbf.testnet` (made before the deploy): its `get_state().hl` shows
`send_open_until_ms` and no `open_sends`, and Hyperliquid testnet's ledger shows the row the plan quotes
(`delta.type` "send", `delta.user` the account's address, `delta.nonce` 1794584202071, the nonce of its signed
`sendAsset`). The tests' ledger row is that row. The gate's dry run (`--dry-run`, no key) prints the 24 lines.

**Not proved.** Nothing ran against an account that shows `open_sends`: none exists before the deploy. So the
three steps are proved against a fake account that follows 50.2's rule, not against the new contract and engine.
Whether the engine allows a $50 loan on the gate's book after the hedge is closed is the engine's answer on the
night; if it allows less the gate borrows that, and if nothing, `borrow_again` fails with the result's own words.
Whether the account's stored result shows `sent` depends on the contract's view; the step's pass rule doesn't use it.

**Decided differently from the brief, or beyond it.**
- `pause_lifted` waits at most 2 minutes for Hyperliquid's history. If the transfer doesn't show, it stops without
  asking for a check (a check then would lift nothing and cost 0.01 NEAR) and says to run from `pause_lifted` again.
- The amount rule sits in `borrow_again`. `pause_lifted` passes when the pause is off, whatever the result allows.
- `borrow_again` refuses to run while the pause is on, with "run from pause_lifted first".

#### App

Built by helper W on 13 to 14 Nov. Web only (`web/src`), code and unit tests: nothing deployed, signed or sent, no
service started or stopped, no new dependency, `next build` not run (the dev server was up).

**50.1, the user's second click-through**

1. **Signed out, Home is the app** (`components/home/landing.tsx`, `components/home/portfolio.tsx`,
   `lib/landing.ts`). The label, headline, paragraph, two buttons, "The worked example" and "How it works" are gone.
   In their place: the "Your account" heading, the portfolio card standing empty (`PortfolioEmpty`: a dash, "Sign in
   with your NEAR wallet to see your account.", one "Sign in" button, the four places with dashes), and "Markets":
   BTC, ETH and NEAR with live prices from the public `GET /api/spot/tokens`, each with "Swap" (to `/spot`) and
   "Perps" (to `/perps?coin=<coin>`). A coin with no price yet shows a dash.
2. **Home, signed in** (`components/home/cockpit.tsx`). Gone: the "Start a basis trade" card (`BasisCard` is
   deleted), the whole row of buttons, and the lenders' cards. Stays: the portfolio card, the setup checklist while
   unfinished, the three tiles, the danger alert, a credit to claim and USDC left at a lender, money on its way, a
   loan on its way, Health and "Where your money is", the address card with its own actions, recent activity. Home's
   side panel now opens only: Repay and Add funds (from the danger alert, as before), "Send a token out" and the
   four moves (from the address card and the checklist). With a position at a lender, one quiet line under "Where
   your money is" names the lenders and links to the Borrow page.
   **The Borrow page** (`app/borrow/borrow-view.tsx`) has the lenders' cards under "What you owe", headed "Your
   lenders". A card's Repay picks that lender in the repay form above and scrolls to it (the button then reads
   "Repay all of Aave"). "Take collateral back" opens its side panel there; "Bring the bitcoin home" in that panel
   and "Send USDC to Aave's chain" in the repay form open the move's panel on the same page (testnet, the owner).
   The page's "You can borrow" figure is now Home's own (`borrowEstimate`: the last check's credit line less
   everything owed, never above the pool's limits), not the pool's limit alone.
3. **"Add & withdraw"** (`/deposit`; `lib/pages.ts`, `app/deposit/*`, `components/withdraw-form.tsx`). One page,
   one read of the account: "Add funds" (test tokens, a deposit from the wallet, a deposit through 1Click), then
   "Withdraw" (the form of before in a card "To a NEAR wallet", with its check first while a loan is open). The
   label, blurb, title, icon and summary changed; the address stays `/deposit`. The 1Click deposit lost its "Get a
   price" and "Get a deposit address" buttons: the price comes as the amount is typed (`useTypedPrice`), and one
   button holds it and opens the wallet.
4. **"Move USDC" on Perps** (`components/perps/account-tables.tsx`, `app/perps/perps-view.tsx`). One button beside
   "Hyperliquid equity …" in the head of the positions table opens `MoveUsdc` in the app's `Drawer`.
5. **The pause banner** (`components/send-window-notice.tsx`, `lib/hl.ts`). For an account as they are today: the
   sentence of before, then "A new account can borrow today." and a button "Open a new account". It sets a new
   random name for the wallet (`client.setName(randomName())`) and opens Home, where the setup checklist shows that
   name in its field, to keep or change. The banner is on Home, Borrow, Account details and Basis trade.

The dev samples follow: `/dev/home` has states `paused` and `paused-new`, and `&page=borrow` / `&page=deposit` show
the same sample account on the Borrow page and on "Add & withdraw". `/perps/sample` has the "Move USDC" button.

**50.2, the pause that lifts early (the app's part)**

- `lib/types.ts` `HlState`: `open_sends?: string[]`, `send_floor_until_ms?: string`.
- `lib/hl.ts`: `liftsEarly(hl)` is `hl.open_sends !== undefined`; `holdsLoan(hl, now)` is "the pause is on and the
  account doesn't lift early"; `pauseBanner(hl, now)` says which banner (`wait` or `check`); `stillPausedWords`.
- The three places that held a loan's check back now pass `holdsLoan` instead of "the pause is on": the Borrow page,
  Home's setup checklist (`cockpit.tsx`), and the Basis trade's loan step (`components/basis/use-basis-data.ts`).
  So an account without `open_sends` is held back exactly as before, and one with it runs its check.
- `hooks/use-check-then-act.ts`, in `proceed`: with the check's result in, the pause is read again from that same
  read of the account. Still on, for a `borrow` or a `fund`: the wallet isn't opened, and the run ends with "The
  last check didn't find your transfer out of Hyperliquid in its history yet. Check again in a minute. If the
  transfer was never sent, borrowing opens again on <date and time>." A plain check that left the pause on carries
  the same words as `note` on its `done` state.
- The banner for such an account: "Your transfer out of Hyperliquid went through. The next check confirms it, and
  borrowing opens again." with "Check now": `useCheckThenAct`, intent `{check: {}}`, the broker's check first. When
  the account's pause is gone the banner goes.

**Which test proves which rule**

| Rule | Test |
|---|---|
| Signed out: BTC, ETH, NEAR with live prices and links | `landing.test.ts`: "signed out, Home shows BTC, ETH and NEAR with live prices, each linked to Spot and to its market on Perps", "while the price list hasn't answered, or names no price, the row still shows each coin, with a dash" |
| The empty portfolio card's row | `portfolio.test.ts`: "before a wallet connects the row stands empty: four places, four dashes" |
| "Add & withdraw" in More, at `/deposit` | `pages.test.ts`: "the tabs are Home, Spot, Perps, Borrow, Basis trade and More; every page of before is under More (INTERFACES.md 49.1)" (now also the label, title and summary of `/deposit`), "the pages of PLAN.md 5.8 are all listed, once each" |
| Which account lifts early | `hl.test.ts`: "an account that shows open_sends lifts early; one that doesn't keeps the rule of before" |
| The check before a loan is held back only on an account of before | "a page holds back the check before a loan only for an account of before, while its pause is on" |
| The two banners, and that the banner goes | "the banner: an account of before waits and is shown the way to a new account; one that lifts early gets "Check now"" |
| After a check that left the pause on | "after a check that left the pause on, the wallet isn't opened for the loan and the page says when borrowing opens" |

422 pass; `tsc --noEmit` and `eslint .` clean. Points 2 and 4 of 50.1 are layout and wiring with no rule in `lib/`:
they were checked in the browser.

**Seen in the browser** (the running dev server, no wallet, 1440 px and 375 px, no sideways scroll at 375):
signed-out Home with live prices; `/dev/home` (`three`, `call`, `paused`): no action row, no basis card, no lender
cards, and the danger alert's Repay and Add funds each open their panel; `/dev/home?state=three&page=borrow`: the
lenders' cards, "Repay Aave" picking Aave in the form, "Take collateral back" and from it "Bring the bitcoin home";
`paused`: the banner with "Open a new account", which set a new name and went Home; `paused-new` on the Borrow
page: the loan's check ran, the first one left the pause on and the page said so without opening the wallet for the
loan, then "Check now" ran a second check, the sample cleared the pause and the banner went;
`&page=deposit`: "Add & withdraw" with both parts; `/perps/sample`: the "Move USDC" button and its panel; `/perps`,
`/borrow`, `/deposit` signed out.

**Not proved.** Nothing was run with a wallet or against an account that shows `open_sends` (none exists before the
deploy): the samples played both. In the samples the broker's check isn't there, so every check went the wallet's
way; "Check now" through the broker's check is unproved by hand. The real Perps page's "Move USDC" (signed in) and
the 1Click deposit's one button were not pressed.

**Different from the brief, or beyond it.**
- The words after a check that left the pause on are the brief's ("The last check didn't find your transfer…"),
  not the shorter ones in 50.2's last bullet.
- Home keeps one line that points to the Borrow page when the account has a position at a lender.
- The 1Click deposit's "Get a price" went (49.1 point 6), though this round's brief didn't name it.
- The Borrow page's "You can borrow" figure changed to Home's (it showed the pool's daily limit, $2,499.74, where
  Home showed $304.56).

#### Engine

Built on 14 Nov. The engine's suite went from 329 to 345. Lint shows only the seven old warnings in `risk-core`'s
tests, `backtest examples` says 144 of 144, and the five verdict fixtures and the five credit replays are identical
byte for byte. `risk-core`, `pb-gateway`'s files, the parameter file, its hash and the model name are untouched.
Nothing was deployed, uploaded, signed or sent.

- **The file to publish:** `risk/target/wasm32-wasip2/release/pb-risk.wasm`, 1,648,051 B, sha256
  `d7dd9cc4f35dd323c456b2c3090b3e97f3d1c8a7abdb3ec6afe25f0c5f5bdadc`.
  - Built from `risk/` with `RUSTFLAGS="--remap-path-prefix=$HOME=~" cargo build -p pb-risk --target wasm32-wasip2
    --release --locked`, rustc 1.93.0. The two changed crates built again gave the same hash.
  - The file it replaced there was the live one (`fb2cee3b…`, 1,643,228 B). `pb-gateway.wasm` beside it is still
    the live `fba556c2…`: it wasn't built.
- **The account's list** (`risk/pb-read/src/near.rs`, `state`): `ClientState.open_sends`, from
  `get_state().hl.open_sends`. Strings or numbers. No list (an older account), `null` or an empty list reads as
  none. An entry that isn't a nonce is left out and the rest of the state still reads: the engine then never
  names it, and the pause runs its full time.
- **The read** (`risk/pb-read/src/read.rs`, `read_hl_account`): with any open send, the first thing Hyperliquid
  is asked is `{"type":"userNonFundingLedgerUpdates","user":<address>,"startTime":<oldest open nonce minus
  3,600,000>}`. It comes before `clearinghouseState`, `frontendOpenOrders`, `userAbstraction` and
  `spotClearinghouseState`.
  - The ledger read for `arrived` is where it was, after the balances, unchanged. With a move to Hyperliquid
    pending and a send open, a run asks for the ledger twice, each time from its own start.
  - A read that fails adds "Hyperliquid ledger for sent transfers: <why>" to the inputs' `errors`, names nothing,
    and the run goes on to its verdict.
  - With nothing open there is no request: a run asks Hyperliquid 5 things as before, and 6 with a send open.
  - **Only `pb-risk`'s read does it** (`read_all`). The gateway's read (`read_all_with`) asks exactly what it
    asked before, in the same order: it names nothing, so the request would be for nothing, and its behaviour
    was not to change. This is the one thing 50.2 doesn't say.
  - **What the order gives:** a transfer the ledger shows is already out of the balances read after it. One that
    goes through between the two reads is out of the balances and not named; the next check names it.
- **Saved in the inputs** (`risk/pb-read/src/inputs.rs`, `HlReads`): `sent_ledger` (the answer as read) and
  `sent_from_ms` (its `startTime`), after `ledger_from_ms`. Both are left out when not read, so a run saved before
  today keeps its form, its `in` and its verdict.
- **The match** (`risk/pb-read/src/hl.rs`, `sent(ledger, address, open)`): the open nonces, in the account's
  order, each once, for which the ledger has an entry with `delta.type` `"send"`, `delta.user` the address
  whatever the case of its letters, and `delta.nonce` the nonce **as a JSON number**, which is how Hyperliquid
  writes it. A nonce written as text finds no match.
- **The verdict** (`risk/pb-risk/src/verdict.rs`): `sent`, a list of JSON numbers, after `arrived` and before
  `ext`: `"sent":[1794584202071]`. Left out when empty. It is worked out from the inputs alone (the account's
  state and `sent_ledger`), so a saved run replays it. The same for check and preview and for every intent. A
  refusal is `{"ok":false,"reason":…}` as before.
- **Read live, sending nothing** (14 Nov): Hyperliquid testnet's answer to the engine's own request for
  `0x303d6ecc…` with `startTime` 1794580602071 is the one `send` row, its nonce 1794584202071 a number. That row,
  with the delivery before it, is the tests' ledger: `risk/pb-read/tests/fixtures/testnet/hl_ledger_send.json`.
- **Tests.** Each rule was undone in the source and its tests failed; put back, all pass.

  | Rule | Test |
  |---|---|
  | `sent` names the live row's nonce; the case of the address doesn't matter | `pb-risk/tests/sent.rs` "the verdict names the nonce of the transfer Hyperliquid's ledger shows as sent"; `pb-read/src/hl.rs` "the ledger names the open send it shows as sent by the account" |
  | Money coming in is no match: the delivery, an `internalTransfer` carrying the nonce, a `send` to the account | `hl.rs` "money coming in is not a transfer sent"; `sent.rs` "money coming in, another address's send and another nonce name nothing" |
  | Another address's `send` is no match | `hl.rs` "another address's send is not a match"; the same `sent.rs` test |
  | Another nonce is no match | `hl.rs` "a send with another nonce is not a match"; the same `sent.rs` test |
  | The ledger is asked for first, from one hour before the oldest open nonce | `sent.rs` "with an open send the ledger is asked for before the balances" |
  | Nothing open: no request and no `sent` | `sent.rs` "with no open send there is no ledger request and no sent in the verdict" |
  | The read for `arrived` stays after the balances | `sent.rs` "the ledger read for arrivals stays after the balances" |
  | A failed read names nothing and the verdict still comes | `sent.rs` "a ledger read that fails names nothing and the run still brings its verdict" |
  | A refusal names nothing | `sent.rs` "a refused run names nothing" |
  | A run saved before today reads back and replays byte for byte | `sent.rs` "a run saved before the rule reads back and replays to the same verdict" (the five fixtures); `pb-read/src/inputs.rs` "the ledger read for sent transfers is left out when not read and survives a round trip"; `pipeline.rs` "the committed fixtures replay", as before |
  | A run that names a transfer replays from its saved inputs | `sent.rs` "a run that names a transfer replays from its saved inputs" |
  | The gateway's read is as it was | `sent.rs` "the gateway's read asks for no such ledger" |
  | The list reads as strings or numbers, and an older account has none | `pb-read/src/near.rs` "open sends are read as strings or numbers and an older account has none" |

- **Not proved:**
  - Nothing ran in the enclave, and no account accepted a verdict with `sent`: that is the deploy's proof.
  - A transfer from the spot balance (`sourceDex: "spot"`): its row wasn't seen. If it reads differently there is
    no match and the pause runs its 2 days and 1 hour.
  - That Hyperliquid never shows a `send` it later takes back. The rule rests on it, as the plan says.
  - The build's hash from an empty build folder or another machine.
- **Left as it is:** RISK_ENGINE.md's Appendix A doesn't list `sent`.

#### Keeper and gate: the short pause gate

Built by helper K in `services/keeper` only. Code and unit tests: nothing is deployed, signed or sent, and no service
was touched.

`pnpm --filter @pb/keeper pause:demo -- [--name <label>] [--from <step>] [--dry-run]` proves the lift alone, with
no hedge: Hyperliquid's prices, the gateway, a lender and the operator play no part. Without `--name` the account
is `pause-<month day hour minute>.pbf.testnet`. The record is `research/data/pause_gate.json`.

**Steps** (`pause-kit.ts`, `PAUSE_STEP_IDS`): `create`, `deposit`, `hl_init`, `to_hl`, `home`, `pause_lifted`,
`borrow_again`, `repay_again`, `withdraw`. Each is the function the other gates run: hedge-steps' for the first
five and the last, gate 2's three for the lift. The book is the small size's: $440 of test USDC and 0.015 test nBTC,
with $430 going to Hyperliquid and straight back.

**It does not pass on an account made before the deploy.** The gate sets `mustLift` on its gate (`LiftGate` in
`funding-steps.ts`). With it, `pause_lifted` fails on an account that shows no `open_sends`, sends nothing, and
says the account was made before the deploy and to use a new `--name`; `borrow_again` and `repay_again` refuse the
same way. Gate 2 doesn't set it, and its three steps skip and pass as before.

**The dry run** prints the nine steps and what stands in the way: the account's name being used, the keeper's NEAR
(6.2 for a new account), the backend, the stand-in (`GET /v0/tokens`), the float's USDC in perps on Hyperliquid (the
stand-in delivers the $430 from it), and the factory: paused, its `account_code_hash()`, and the engine it pins.
The account code `79827e65…` and the engine `fb2cee3b…` are the ones from before the deploy (read from the factory
on 13 Nov; the plan's way back): with either still there the dry run says which call comes first, and a real run
refuses to start, so no account is paid for. Going on with an account (`--from`), its own state and its own pinned
engine are read instead. No gateway and no keeper service is asked for.

**The end.** "PAUSE GATE PASSED: 1 check lifted the pause, and a loan of $50.00 from our pool arrived N s after the
USDC came home from Hyperliquid (M s after that transfer was signed). It was repaid, and both tokens were
withdrawn." N is from the end of the `home` step to the loan's arrival; M is from the transfer's nonce. Otherwise
"NOT PASSED: <steps>". A stopped run says what it left (USDC on Hyperliquid, a loan, tokens in the account) with the
`--from` step that deals with each, then the resume command. It reads only: the float's orders are never touched,
since another gate may be using the float.

**`home` straight after `to_hl`: nothing in it assumes the hedge ran.**
- It takes Hyperliquid's `withdrawable` less a cent. With no position that is the whole balance.
- The account's `hl_withdraw` wants the owner, no loan open, no borrow under way and a Hyperliquid address. No agent.
- The backend's quote for `home` wants the address and no loan; `POST /api/hl/submit` wants only the signed entry.
- One difference from gate 2: the `to_hl` transfer is still listed when `home` runs (in gate 2 the checks in between
  settle it). The account doesn't mind. The check of `pause_lifted` is then the first one after both moves, so its
  result has to show the arrival on Hyperliquid and name the transfer home as sent. `borrow` is refused only once a
  listed transfer is overdue, 30 minutes after its quote expires: about 40 minutes after `to_hl`.
- Hyperliquid takes $1 from the first transfer to a new address (13 Nov: $429.66 delivered, $428.66 shown).

**What the deposit leaves the account worth.** About $437 of USDC (the run of 13 Nov had $436.81 left of $440
after both moves) and 0.015 nBTC, about $996 at $66,420: about $1,430, with no hedge. The Phase 2 gate's first loan
was on such a book (USDC and nBTC only, nothing on Hyperliquid, tier WATCH): the engine allowed half the account's
worth, $19,499 on $38,998, with the tier's cap binding (`research/data/phase2_first_loan.json`). By that the line
here would be about $700, fourteen times the $50. Not run: a preview costs an OutLayer run, and the engine has
changed since 7 Nov.

**Files.** New: `pause-demo.ts`, `pause-kit.ts`, `pause-kit.test.ts`, `pause-fakes.ts` (the fake account and gate,
moved out of `pause-steps.test.ts` so both test files use it). Changed: `funding-steps.ts` (`LiftGate`, `mustLift`),
`funding-kit.ts` (`needsLiftWords`), `pause-steps.test.ts` (its imports), `package.json` (the `pause:demo` line).

**Tests.** `pnpm --filter @pb/keeper test`: 256 (248 before; none changed in meaning). Each rule below was undone
in the compiled file and its test failed.

| Rule | Test (the start of its name) |
|---|---|
| The step order | "the pause gate's steps, in order: an account, USDC to Hyperliquid and straight back…" |
| The refusal on an older account | "the pause gate doesn't pass on an account made before the deploy…" |
| The dry run's plan | "the pause gate's dry run names its nine steps in order…" |
| What stands in the way | "the pause gate's dry run: with everything in place…", "…before the deploy: the factory's account code and its engine…", "…catches each single thing out of place…" |
| The last line | "on an account that shows open_sends the pause gate's lift, loan and repayment pass…" |
| What a stopped run leaves | "what a stopped pause gate leaves is said with the step that deals with it…" |

**Run, sending nothing:** the dry run with no key. It found the keeper's 21.74 NEAR, the backend, the stand-in and
785.95 USDC on the float, and two things in the way: the factory's account code and its engine are still the ones
from before the deploy.

**Not proved.** No real run: `create` to `home` have run in every gate but never with `home` straight after
`to_hl`, and the lift itself waits for the deploy. The float's 785.95 USDC carries one gate's $430 at a time: this
gate and gate 2 both hold $430 of it for a minute or so, so they shouldn't reach `to_hl` together.

#### Account

Built by helper A on 14 Nov, 21:20 to 22:10 UTC, in `contracts/account/src` (`hl.rs`, `lib.rs`, `verdict.rs`,
`tests.rs`) and the sandbox tests (`contracts/tests/tests/upgrade_pause.rs`, new). Code and local tests only: nothing is deployed, signed or
sent, `.env` was not read, and there is no new crate. The factory's source, the pool's and the shared types are
untouched.

**State and view** (`hl.rs`). `Hl` stores `open_sends: Vec<U64>` and `send_floor_until_ms: U64` right after
`send_open_until_ms`, and `get_state().hl` shows them there:
`{"path", "address", "agent", "next_nonce_ms", "send_open_until_ms": "<ms>", "open_sends": ["<nonce>", …],
"send_floor_until_ms": "<ms>", "signed": […]}`. A new account starts with `[]` and `"0"`. `MAX_OPEN_SENDS` is 8.
`SEND_OPEN_MS` is unchanged.

**One rule sets the three fields**, `Hl::set_send_open(now_ms)`, with the block's time:
1. every listed nonce with `nonce + SEND_OPEN_MS <= now_ms` leaves the list;
2. a floor that is `<= now_ms` becomes 0;
3. while more than 8 are listed, the oldest leaves and the floor becomes the later of itself and that nonce plus
   `SEND_OPEN_MS`;
4. `send_open_until_ms` is the later of the floor and the newest listed nonce plus `SEND_OPEN_MS`, and 0 with
   neither.

It runs in two places:
- **`Hl::note_send(nonce, now_ms)`**: adds the nonce, then the rule. `sign_send` calls it when the signature is
  asked for, with `env::block_timestamp_ms()`, for `hl_withdraw` and for a plan's `home` step.
- **`Hl::settle_sends(sent, now_ms)`**: removes every listed nonce that `sent` names, then the rule. `accept` calls
  it right after it settles `arrived`, so only for a verdict that passed every check. When the pause was on before
  the call and is over after it, the account logs one line:
  `Hyperliquid shows the signed transfer as sent: the pause on borrowing ends now`.

**The verdict** (`verdict.rs`). `Verdict.sent: Vec<u64>`, `#[serde(default)]` and `#[borsh(skip)]`: JSON numbers,
and none when left out. The stored verdict's layout is unchanged. `get_state().verdict.verdict` is the kept JSON,
so it shows `sent` as it came.

**Not changed.** `assert_no_send_open`, its eight callers and its refusal text; the counter's rules; every other
field of every view.

**Where it differs from 50.2, or adds to it.**
- The view shows the list as it is stored. A nonce past its 2 days and 1 hour, and a floor that has passed, leave at
  the next transfer or accepted verdict, not by the clock alone. `send_open_until_ms` is right at every moment all
  the same: a time in the past means no pause, as before.
- A verdict that names some of the open transfers and leaves the pause on logs nothing. Only the verdict that ends
  the pause logs the line.
- `sent` has no limit of its own; the 4 KB limit of a verdict bounds it.

**Size and NEAR.** Account 539,798 B, sha256 `48497d26493cd49180306ae1c4ecc5f4d45f78c8b09516124db5e95b25e1311c`
(4,420 B more than the live `79827e65…`). Factory 772,679 B, sha256
`8f93689ed67a91a471cd4d0d0771c5953a36fa996fa882098b0f56b6d52f6e3a` (4,424 B more than the live `66cb9070…`). Pool
478,954 B, `ca21d533…`: byte for byte the one on chain.
- The redeploy locks 0.0442 NEAR more in `pbf.testnet`. Read on 14 Nov at 21:30 UTC it held 10.1298 NEAR with
  771,766 B stored (2.41 NEAR free), so 2.37 NEAR stays free.
- Each new account locks 0.0442 NEAR more. With the live config (five tokens) 6 NEAR now leaves it 0.561 NEAR
  free at opening, where the live code leaves 0.605. `MIN_DEPOSIT` stays 6. The sandbox bars that asked for 0.6 at
  opening now ask for 0.55: `aave.rs`, `lender.rs`, `upgrade.rs`, `upgrade_stage4.rs`, `upgrade_audit.rs`,
  `upgrade_low.rs`, and the new `upgrade_pause.rs`. After its first loan at Rhea an account has 0.4541 NEAR free;
  that bar in `lender.rs` is 0.45 and was left alone, so about 400 B more account code trips it.
- `account.rs` pinned the whole empty `hl` view; it now lists the two new fields.

**Tests.** `cargo test -p pb-account`: 423 (410 before). The whole contracts suite: 710 (696 before): 648 unit
tests and 62 on the sandbox, all green. Not in one run: the first whole run stopped at `account.rs`'s pinned view
(fixed), and in the second, one test of `account.rs` hung for nine minutes on the busy machine
(`a_failed_transfer_is_forgotten_once_overdue…`, which has no transfer out of Hyperliquid in it); it passed in the
first run and passes alone in 26 s. Every other file ran once after that, green. Each rule was undone in the source
in turn (12 times) and its tests failed. The sandbox test failed too with the lift undone in a rebuilt account, and
the rebuild from the restored source gave the two hashes above again.

| Rule | Test |
|---|---|
| A nonce named in `sent` ends the pause; the borrow before it is refused, the one right after goes through | `a_verdict_that_names_the_transfer_as_sent_ends_the_pause_and_the_borrow_right_after_goes_through` |
| A nonce not named keeps the pause | `a_verdict_that_does_not_name_the_transfer_keeps_the_pause` |
| Two open, one named: the pause holds until the other's 2 days and 1 hour | `with_two_transfers_open_naming_one_keeps_the_pause_until_the_others_2_days_and_1_hour` |
| A ninth moves the oldest into the floor, and the floor holds whatever `sent` says | `a_ninth_transfer_moves_the_oldest_into_the_floor_and_the_floor_holds_whatever_a_verdict_names`, and in `hl.rs` `a_ninth_open_send_moves_the_oldest_into_the_floor_and_the_floor_holds_whatever_is_named_as_sent` |
| A refused verdict lifts nothing (old counter, wrong model, another account, `ok` false, over 4 KB) | `a_refused_verdict_lifts_nothing_even_if_it_names_the_transfer` |
| A nonce the account never noted changes nothing | `a_verdict_naming_a_nonce_the_account_never_noted_changes_nothing` |
| Old nonces drop by themselves | `a_transfer_that_is_2_days_and_1_hour_old_leaves_the_list_by_itself`, and in `hl.rs` `a_send_that_is_2_days_and_an_hour_old_leaves_the_list_when_the_next_is_noted` |
| The view | `the_view_shows_the_open_transfers_as_strings_and_the_floor`, and the two view-shape tests of before, which now list the two fields |
| Listed from the moment the signature is asked for | `a_transfer_is_listed_from_the_moment_its_signature_is_asked_for_even_if_the_answer_never_arrives` |
| Never shorter than the rule of before unless something is named | in `hl.rs`, `with_nothing_named_as_sent_the_pause_is_never_shorter_than_the_rule_of_before_made_it` (600 steps, the floor in use) and `naming_a_send_ends_the_pause_only_when_no_other_is_open` |
| The redeploy, a new account and an account made before | `upgrade_pause.rs`, `the_live_factory_takes_the_account_code_whose_pause_lifts_early_and_only_its_new_accounts_lift_it` |

**The sandbox test** puts the live factory (`66cb9070…`), pool and five tokens, as read on 14 Nov at 21:24 UTC into
`contracts/target/live-pause/`, into the sandbox under their testnet names, with the two mocks under the names the
live config gives the signer and OutLayer. An account is made by the live factory. `migrate` as the init call is
refused. The plain redeploy keeps `get_config`, `list_accounts`, `accounts_count` and `is_paused`, and
`account_code_hash` becomes the new account's. Then a new account: its transfer out of Hyperliquid is signed and
listed, a check that doesn't name it is accepted and the borrow is refused, a check that names it logs the line and
empties the list, and the live pool lends it $100. The account made before does the same and keeps the rule of
before: the verdict that names its transfer is accepted, its `hl` doesn't move and shows no `open_sends`, and its
borrow is refused until the 2 days and 1 hour.

**Not proved.** Nothing ran on testnet. The verdicts in every test are canned: that the real engine names the right
nonce, and reads Hyperliquid's history before the balances, is the engine's side. The 200-block wait for a signer
that never answers was not run on the sandbox; the unit test covers that the transfer stays listed.

**For the main session.** `contracts/tests/fetch_live.py` doesn't know the config's three newer tokens. To fetch
them again, its `CONTRACTS` table needs `"meth": "meth.pbf-ops.testnet"`, `"mwnear": "mwnear.pbf-ops.testnet"` and
`"musdt": "musdt.pbf-ops.testnet"`; I read them with the script's own `fetch`, without editing it.

### 50.4 A signed order lives up to 4 minutes on testnet (13 Nov, 22:17 UTC; rules before the build; the figure changed from 5 to 4 minutes at 22:35 UTC)

The user, 13 Nov: "why do we only give 120 seconds for outlayer? if it has repeatedly shown to take more time then
lets give it 5 minutes"; then, told that the slowest answers of the day were 176 and 186 s and that the
figure is a cap and not a wait, "lets make it 4 minutes". On 13 Nov OutLayer's testnet took 94 to 186 s for a run in several spells, and an order
signed to live 110 s reached the gateway expired ("the message has expired: sign it again").

What can change and what can't:
- **An order's life is ours.** The gateway refuses a message signed to expire more than `MAX_AHEAD_MS` (120 s)
  after the block it reads, and the pages and gates sign for 110 s.
- **A check's two minutes are NEAR's.** `request_check` reaches OutLayer through a yielded call, and NEAR resumes a
  yielded call after 200 blocks at the latest. Nothing here changes that; the keeper asks again (49.4).

The rule:
- **`pb-gateway`:** the longest a message may be signed ahead becomes a setting of the network, beside
  `price_band_floor` (`risk/pb-read/src/request.rs`): **240,000 ms on testnet, 120,000 ms on mainnet** as before (decided inside `pb-gateway`, so `pb-risk` keeps its hash).
  The refusal says the figure of the network it ran for. Nothing else in the gateway changes: a message is still
  taken once (its nonce is stored), and an expired one is still refused.
- **Who gets it:** an account pins its gateway when it is made, so only accounts made after the new gateway is
  pinned. An account that pins an older gateway (the seven hashes up to `fba556c2…`) keeps 120 s.
- **Backend:** `GET /api/markets?account=<id>` gains `order_life_ms`: what the page should sign for on that
  account's own gateway: **230,000** on the new one, **110,000** on an older one (10 s under the gateway's limit,
  for the gap between clocks). With no account: the factory's pinned gateway. The backend's own wait for a run
  (`OUTLAYER_WAIT_MS`, default 180 s) must not cut an order off before its life is over: default 270 s, and an order's own run is
  waited for to the end of its life and 40 s more.
- **App and gates:** every place that signs a gateway message (order, cancel, the setup's short, the Basis trade's
  runs, the gates' orders) signs for that account's `order_life_ms`, and falls back to 110 s when the backend
  doesn't say. Waits and timeouts around an order follow: nothing gives up before the order's life is over.
- **Words:** while an order waits longer than usual the page says one calm line, not an error.
- **Not changed:** the account contract, the pool, `pb-risk`'s rules, the parameter file, how a check works.

#### Gateway (as built)

Built on 14 Nov, in `risk/pb-gateway/src/` only, first at 5 minutes and then moved to the 4 minutes of the rule
above: 240,000 ms on testnet, and the pages sign for 230 s. The engine's suite went from 345 to 349. Lint shows
only the seven old warnings in `risk-core`'s tests. Nothing was uploaded, published, signed or sent.

- **The two files,** built from `risk/` with `RUSTFLAGS="--remap-path-prefix=$HOME=~" cargo build -p <name>
  --target wasm32-wasip2 --release --locked` (rustc 1.93.0):

  | File | Size | sha256 |
  |---|---|---|
  | `pb-risk.wasm` | 1,648,051 B | `d7dd9cc4f35dd323c456b2c3090b3e97f3d1c8a7abdb3ec6afe25f0c5f5bdadc`, the published one: unchanged |
  | `pb-gateway.wasm` | 1,567,319 B | `68a50dfa8518271b96ed0484257609694dd50b4bad9b577c199d609e2e705480` |

  - `pb-gateway` built a second time gave the same hash. The live file is `fba556c2…` (1,566,030 B). The 5-minute
    build of earlier that day (`b8b501ad…`, the same size) is replaced by this one; the engine's helper uploaded
    neither.
  - **The new gateway file also carries the reader as it is since 50.3** (`risk/pb-read`, shared by both
    programs): it is the first gateway built since then. The gateway's own reads are the same requests in the
    same order (50.3's test "the gateway's read asks for no such ledger"); it reads past `open_sends`.
- **The limit is decided in the gateway, not in the network's settings** as the rule above says: `pb-read` had
  to stay as published, so `pb-risk` keeps its hash.
  - `gateway.rs`: `MAX_AHEAD_MS` stays 120,000 and is every other network's; `TESTNET_MAX_AHEAD_MS` is 240,000;
    `max_ahead_ms(network)` picks by the network the request names.
  - `check_life(network, expires_ms, block_ms)` is the two checks that were at the end of `chain_auth`, in the
    same place and order: expired first, then too far ahead. `chain_auth` takes the request's network; `order`
    and `cancel` pass it.
- **The words.** On testnet: "the message expires more than 240 s ahead: the gateway takes at most 240 s". On any
  other network: the 120 s sentence, letter for letter. Expired: "the message has expired: sign it again", as
  before.
- **Exactly at the limit is taken:** 240,000 ms ahead passes, 240,001 is refused, as 120,000 and 120,001 were.
- **Nothing else changed.** A message's nonce is stored when it is taken and never removed, so a message is
  taken once whatever its life. A refused message's nonce isn't stored.
- **Mainnet can't be reached through the gateway today:** a request that names any network but testnet is
  refused first ("network "mainnet" is not served: testnet only"). The 120 s for other networks is proved on
  `check_life` itself.
- **What else in the gateway assumes 120 s: nothing that needed changing.**

  | Found | What it is |
  |---|---|
  | The nonce store (`store.rs`, `nonce:<base64>`) | No keep time at all: set once, never removed |
  | `chain_auth`'s comment ("within 120 s of that block") | Reworded |
  | `tests.rs`, "auth refuses the wrong signer, key, expiry and caller" | Its too-far case was 121 s ahead; it is 241 s now |
  | `tests.rs`, a `sending` step record 120 s old | A plan step of a run that stopped; not a message's life. Left |
  | `VERDICT_LIFE_BLOCKS` = 120 | Blocks, the account's rule for a result. Left |
  | `LOCK_STALE_MS` 60 s, `FILLS_WINDOW_MS` 60 s, `RECENT_FILL_MS` 10 s, the 60 orders a minute | Counted from the gateway's own run or its own orders, not from the message. Left |

- **Tests** (`risk/pb-gateway/src/tests.rs`). Each rule was undone in the source and its test failed; put back,
  all pass.

  | Rule | Test |
  |---|---|
  | On testnet 230 s ahead is taken and 241 s is refused with the testnet words; a cancel too | "on testnet a message signed 230 s ahead is taken and one signed 241 s ahead is refused" |
  | On any other network 121 s is refused with the words of before and 119 s is taken | "on mainnet a message 121 s ahead is still refused with the words of before and 119 s is taken" |
  | A message used once is refused the second time, at once and all through its life (60 s to 240 s) | "a message used once is refused the second time whatever its life" |
  | An expired message is refused, never used or not | "an expired message is refused" |

- **Not proved:**
  - Nothing ran in the enclave: the new gateway hasn't answered `agent_address` or taken an order there.
  - The build's hash from an empty build folder or another machine.
- **Section 9 above** (the gateway's checks) still says "at most 120 s ahead"; sections 32 and 48 name the 120 s
  as it was on their day.

#### Backend and gates (as built)

Built by helper K in `services/api/src` and `services/keeper/src`. Code and unit tests only: nothing is deployed,
signed or sent, no service was touched, and `.env` was not read.

**The figures here are the 4-minute ones** (the user's change of 13 Nov, after this was first built for 5): the
gateway takes 240 s on testnet, a page or a gate signs for 230 s, the backend's default wait is 270 s and its
longest wait for an order is 280 s, and a gate waits 310 s for one call to the backend. Only numbers moved.

**`GET /api/markets` gains `order_life_ms`** (`hl-handlers.ts`), beside `band_floor_bp`, for the same gateway the
bands are for: the account's own pin, or the factory's with no account or one not made yet.
- **110000** when that gateway is one of seven builds: the six of the band list and `fba556c2…`, pinned on 13 Nov.
- **230000** for any other build on testnet, which is any newer one.
- 110000 too when no gateway is known (a factory with no pin, or one that can't be read) and on mainnet: every
  build takes the shorter life.
- Two lists, so the band keeps its meaning: `GATEWAYS_BEFORE_THE_BAND_FLOOR` is untouched (six), and
  `GATEWAYS_BEFORE_THE_LONG_LIFE` is those six and `fba556c2…` (seven). `fba556c2…` has the 3% band and the 110 s.

**Every clock between the page and OutLayer on `POST /api/order` and `/api/cancel`.**

| Where | Before | Now |
|---|---|---|
| The backend's wait for the run (`OUTLAYER_WAIT_MS`; `outlayer.ts`, `config.ts`) | 180 s unless set | 270 s unless set |
| The same, for an order or a cancel (`orderWaitMs`) | the setting | the setting, or what is left of the signed message's life and 40 s more if that is longer; a claimed life is counted as 240 s at most. So an order signed for 230 s is waited for 270 s even where `OUTLAYER_WAIT_MS` is set to 180 s |
| The client's poll | every 2 s; one request may take 30 s; a failed poll is a miss | unchanged |
| What answers 502 first | `502 outlayer_unknown` when the wait above runs out | the same, and only after that wait |
| The backend's HTTP server | no limit on how long an answer may take | unchanged |
| **The app's proxy** (`web/next.config.js`, `experimental.proxyTimeout`) | 210 s | **still 210 s: not my file.** It answers before the backend does, 20 s before a 230 s order's life is over. It needs 310 s at least (the backend's longest wait for an order, 280 s, and 30 s) |
| A gate's wait for one call to the backend (`gate-world.ts`, `apiWaitMs`) | 210 s | 310 s: `backendWaitMs` (the setting or the backend's 270 s, and 280 s at least) and 30 s |

- **Previews, funding plans, credit checks and set-leverage** use the same client and take the setting as it is: one
  that sits in OutLayer's queue is now waited for up to 270 s, not 180 s, before the route answers 504. A run is
  still charged once and the limit of previews a minute is the same; in a slow spell more requests stay open at
  once. Behind the app's proxy they are still cut at 210 s.
- `POST /api/check`'s wait for the keeper is three such waits and 30 s each: 15 minutes with the new default, 10.5
  before. The keeper's three tries end long before either.
- `.env.example` line 61 still says "Default 180000 (3 minutes)": not my file. If `.env` sets `OUTLAYER_WAIT_MS`,
  that value still rules previews; orders and cancels are covered by their own rule above.

**Gates** (`hedge-kit.ts`, `hedge-steps.ts`). `EXPIRY_MS` (110 s) is now the fallback. The life comes from the
same answer the band comes from (`gatewayBand`, `priceFacts`), read once a step: `orderLifeOf` takes
`order_life_ms` when it is a whole number from 10000 to 230000, and 110000 otherwise. The short, the close, the
refused close and the 40 orders at once (fixed at 110 s before) sign for it. The off-list coin's order and the
cancels after a stop read it by `orderLife`, which gives 110 s when the backend doesn't answer. The short's
record gains `order_life_ms`.

**The keeper's own loop signs nothing for the gateway.** Its runs are `{mode, account, network}` with no owner's
message and no expiry (`index.ts`, `runGateway`), so no life applies to them. It times them with its own
`OUTLAYER_WAIT_MS` default, 180 s, which I left: a tick waits for a run, and "the keeper is running" (240 s, in the
keeper and in the backend) is built on it. The checks it sends are NEAR's two minutes, as 50.4 says.

**Files.** Backend: `hl-handlers.ts` (`order_life_ms`, the second list, `orderLifeMs`, `orderWaitMs`, the order
route's wait), `outlayer.ts` (the default; a run's own wait), `config.ts` (words), and tests in
`hl-handlers.test.ts`, `outlayer.test.ts`, `server.test.ts`. Keeper: `hedge-kit.ts`, `hedge-steps.ts`, `config.ts`
(`backendWaitMs`), `gate-world.ts`, and tests in `hedge-steps.test.ts`, `outlayer.test.ts`.

**Tests.** `pnpm --filter @pb/api test`: 244 (239 before). `pnpm --filter @pb/keeper test`: 259 (256 before). Both
build. Two tests of before were changed on purpose: the backend's pinned default wait (270 s, was 180 s) in
`outlayer.test.ts` and `server.test.ts`. Each rule was undone in the compiled file and its test failed.

| Rule | Test (the start of its name) |
|---|---|
| 110000 on each of the seven older builds, bands unchanged | "50.4, markets: an account on any of the seven older gateway builds…" |
| 230000 on an unknown newer build, band unchanged | "50.4, markets: an account on a gateway build the backend doesn't know…" |
| No account: the factory's gateway by the same rule | "50.4, markets with no account, or one not made yet…" |
| The band list keeps its meaning | the first of these, and "markets: the band is the one the account's own pinned gateway uses…" (unchanged) |
| The default wait | "a run that never ends is given OUTLAYER_WAIT_MS (270 s unless set…", "config: testnet only…" |
| An order's run is waited for to the end of its life | "50.4: the backend waits for an order's or a cancel's run…", "50.4: one run can be given its own wait…" |
| The gate signs for the account's figure | "50.4: the gate signs every order for the life the backend says…" |
| The gate falls back to 110 s | "50.4: the gate falls back to 110 s when the backend doesn't say…" |
| The gate waits as long as the backend | "50.4: a gate waits for the backend as long as the backend may wait for an order…" |

**Decided differently from the brief.**
- An order's wait has its own rule beside the new default, so that a set `OUTLAYER_WAIT_MS` can't cut an order off.
- The keeper's own default stays 180 s, for the reason above. The gates' wait no longer comes from it.

**Not proved.** No order has been signed for 230 s against the new gateway. What `.env` sets for
`OUTLAYER_WAIT_MS` is not known to me. The app's proxy still gives up at 210 s.

#### App (as built)

Built by helper W on 14 Nov, 02:00 to 02:50 local (+04). `web/src` and one line of `web/next.config.js`; code and
unit tests only: nothing deployed, signed or sent, no new dependency, no `next build`. The figures are the user's
4 minutes: 230 s on the new gateway.

**The life a message is signed for** (`lib/gateway.ts`). `orderLifeMs(markets)` reads `order_life_ms` from the
markets answer for the account: a whole number from 10,000 to 230,000 (`LIFE_MAX_MS`) is used; anything else, or
no answer yet, is 110,000 (`EXPIRY_MS`, unchanged). `expiresAt` and `expiryNow` take the life as their last
argument. Every signer passes it:

| Signer | Where its life comes from |
|---|---|
| Perps: order, Close, cancel (`components/perps/use-gateway-action.ts`) | the page's markets read with the account (`ownMarkets`), given to the hook |
| The old Trade page: order and cancel (`app/trade/trade-view.tsx`) | its own markets read with the account |
| The setup checklist's short (`components/home/setup-actions.ts`) | the markets read the step makes before it signs |
| Basis trade, the short (`components/basis/use-open-run.ts`) | the same |
| Basis trade, closing the position (`components/basis/use-close-run.ts`) | the same |

`set_leverage` signs nothing. No other place signs a gateway message.

**Waits and timeouts.** What was found:
- `lib/api.ts` has no timeout of its own: a request waits as long as the server holds it.
- No run gives up while it waits for the order's answer. The waits the runs do have (30 or 40 s for the position
  to show on Hyperliquid) start after the gateway has answered.
- **The app's own proxy gave up at 210 s** (`web/next.config.js`, `experimental.proxyTimeout`), under the order's
  life. It is now 370,000. Next's dev server watches that file and restarted itself when it changed (its child
  process started at 02:33:28 local): the new figure is live, and no restart by hand is needed. The comment beside
  it still names 290 s and 340 s; the file was not touched a second time, because a change restarts the server
  again and would cut off an order on its way.
- What changed in the app (`lib/order-life.ts`, `sendWithinLife`, used by all five signers): an answer that was cut
  off rather than given (the proxy's bare 500, a dropped connection, a 502 or 504 with no code of the backend's, or
  the backend's `outlayer_unknown`), arriving after at least 10 s of waiting and before the order's life is over,
  is not shown as a failure. The page says the calm line and stays busy until the life is over, then says "The
  order's answer didn't come back. It may still have reached Hyperliquid: look at your open orders and fills before
  you sign it again." (the backend's own words for `outlayer_unknown`). The same error within 10 s is the error it
  says it is.

**Words.**
- Past 30 seconds of waiting, every page says "The order is waiting its turn at the risk engine. It can take a few
  minutes on testnet." (`orderWaitWords`): Perps adds the seconds so far; the setup's short, the Basis runs and the
  old Trade page swap their waiting line for it. The button stays busy. Before 30 s the lines are as they were
  ("usually 20 to 60 seconds").
- A message that expired says once: "The order waited too long at the risk engine, and its signature ran out.
  Nothing was placed. Sign again to send it." (`lib/gateway.ts`, `EXPIRED_ORDER_WORDS`, in `orderWords` and
  `cancelWords`, so every page says the same and not the check's code). The button is "Sign again": on Perps, in
  the Basis trade's failure box, and on the setup checklist.

**Orders Hyperliquid testnet can't take now** (`lib/hl-reach.ts`; testnet only). The figures are the keeper's
(`services/keeper/src/hedge-kit.ts`): `HL_TESTNET_REACH_BP` 240 and `BAND_EDGE_BP` 10, and `reachOf` as there: the
nearer of Hyperliquid's 2.4% and the account's band less 0.1%. A market "can trade now" when its mark stands nearer
its oracle price than that (the keeper's `hedgeNow`, from the mark and oracle the markets answer carries; the book
isn't read, and prices aren't rounded first). One thing is added: this app prices an order that should fill at once
half the band past the reference price (1.5% with a 3% band), so between 1.5% and 2.4% a market also counts as not
trading, with its own words ("too far for an order placed from here to fill at once").
- **Basis trade tab:** each coin of the dropdown carries `tradesNow` and `whyNotNow` (`basisTokens`). One that
  can't trade is marked "(not trading on Hyperliquid testnet right now)", can't be picked, and its line shows under
  the form: "Hyperliquid testnet's BTC price is 2.6% away from its reference price right now, and it takes no order
  that far out. Pick another coin, or try BTC again later." The page opens on the coin the account already holds
  (a trade under way keeps its coin), else on the first that can trade now. With several coins and none trading, one
  line says so. The button is off while the picked coin can't trade and the short is still to open; once the short
  is open the rest goes on. The short, the closing order and the setup's short also read the prices again right
  before signing, and stop with the same words instead of asking the wallet.
- **Perps:** the picked market is judged from its live prices. When it can't trade, the line stands above the
  form ("Pick another market…"), the button is off for a market order and for a limit priced further out than an
  order may be, and Close in the positions table is off with the line as its title. A limit nearer the reference
  price is left to Hyperliquid: it can rest on the book.
- On mainnet nothing is stopped.

**Which test proves which rule**

| Rule | Test |
|---|---|
| The life comes from the markets answer for the account, and falls back to 110 s | `order-life.test.ts`: "the life an order is signed for comes from the markets answer for that account, and falls back to 110 s" |
| The expiry in the message is now plus that life | "the expiry written into the message is now plus that life" |
| The calm line's rule | "an order that waits longer than 30 seconds gets one calm line, not an error; before that, none"; `perps.test.ts`: "the progress line is honest about the wait: usually 20 to 60 seconds, and past 30 the one calm line, never an error" |
| An expired message, once, with "Sign again" | `order-life.test.ts`: "a message that did expire says so once, with "Sign again""; `perps.test.ts`: "an expired message says once that the order waited too long, that nothing was placed, and to sign again"; `basis.test.ts`: "a failure says what happened in one sentence, and what to do" |
| Nothing gives up before the life is over | `order-life.test.ts`: "nothing gives up before the order's life is over: a cut-off answer waits out the rest of it, with the calm line", "an answer, a refusal and an error of the backend's own come back as they are" |
| The keeper's figures | `hl-reach.test.ts`: "the figures are the keeper's own: Hyperliquid testnet trades up to about 2.4% from its oracle price, and a price stays 0.1% inside the gateway's band" |
| Which coins can trade now | "which coins can trade now: BTC 2.6% from its reference price can't, ETH at 1.13% and NEAR at 0.10% can"; `basis.test.ts`: "each coin of the dropdown says whether a short can open now, from its live price and reference price; on mainnet all can" |
| Testnet only | `hl-reach.test.ts`: "on mainnet nothing changes: the same prices stop nothing" |
| The default pick | "the default pick is the first coin that can trade now; with none, the first that can be picked, and the page says so" |
| The words | "the words: the dropdown marks the coin, and one line says why in plain words and what to do" |
| Perps: which orders are stopped | "on Perps, in a market that can't trade now, a market order is stopped and so is a limit priced out of reach; a nearer limit is left to Hyperliquid" |

435 pass (422 before); `tsc --noEmit` and `eslint .` clean.

**Seen in the browser** (the dev server, no wallet, my own tab): `/perps/sample?state=slow` (new): the usual line
at 28 s, the calm line at 31 s with Close still off, then the fill; `?state=expired`: the expired words once, with
"Sign again" and "Not now"; `?state=far` (new): the line above the form, the button off for a market order and for
a limit at 66,900, on for a limit at 70,500, Close off with the line as its title; `/basis/dev?state=margin`: the
run went through the short and stopped at the loan; `/basis/dev?state=btc-out` (new): BTC marked in the dropdown,
the line, the button off; `?state=new`: the button on.

**Not proved.** No order was signed or sent, so: a real message signed for 230 s on the new gateway, a real wait
past 30 s, a real expiry, and a request held by the proxy past 210 s are unproved by hand. The backend's
`order_life_ms` was read on disk afterwards (`services/api/src/hl-handlers.ts`): it sits at the top of the markets
answer, where the app reads it; the two were not run together. The Basis tab with three coins on offer was tested,
not seen (the sample has BTC alone).

### 50.5 At the join (13 Nov, 21:19 to 23:25 UTC)

**What the user decided along the way** (their words, 13 Nov): "implement these ui/ux changes first followed by the
real fix"; "the name cant be add & withdraw - it has to be deposit and withdraw … i need the withdraw workflow as
well"; "remove trade classic from more"; of lending or depositing at Aave and Rhea by hand, "do nothing for the lending
part then - we already have a smooth process"; "lets make it 4 minutes"; of Home's checklist, "all we want is to guide
a person till they open the account" and "we want that thing to go away after the account setup is done".

**Changed at the join (mine):**
- `/deposit` is "Deposit & withdraw", with two buttons at its top that show one side or the other (the withdrawal
  sat under three deposit cards and wasn't seen). `/trade` has `place: 'none'`: its address stays, nothing links to it.
- Home's checklist is `openingView` (`lib/setup.ts`): the wallet and the account, titled "Open your account", gone
  the moment the account is open. The whole list stays for the Basis trade's runs.
- The services ran from frozen copies of the tested builds while helpers edited those packages (22:19 to 22:46), then
  from the new code. `.claude/launch.json` has `keeper-three` (`--newest 3`).

**Suites, my own runs unless said:** contracts 710 (one whole run), engine 345 before the gateway's change and 349
after (the engine helper's run), backend 244, keeper 259, app 436, stand-in 65, 1Click client 12. The app's
`tsc --noEmit` and lint are clean, and **`next build` passed at 23:21 UTC** (18 routes, all static).

**The pause that lifts early (50.2), as deployed:**
- `pb-risk` `d7dd9cc4f35dd323c456b2c3090b3e97f3d1c8a7abdb3ec6afe25f0c5f5bdadc` (1,648,051 B): uploaded 21:48 (txs
  `6X2e9aAn…`, `EgCL3HZV…`), fetched back with the right size and hash, added with `--no-activate`, and run once by
  its version key before anything pointed at it (a normal verdict, 186 s in OutLayer's queue).
- The factory's redeploy, 22:19:48 (tx `7SMgLiLdvMTnfocXK4jWTdqoArTzWbN4xdiyhizAd6nc`): code `8f93689e…` (772,679 B),
  `account_code_hash` `48497d26493cd49180306ae1c4ecc5f4d45f78c8b09516124db5e95b25e1311c` (539,798 B). `get_config`,
  22 accounts and `is_paused` read as before. A new account now opens with 0.561 NEAR free.
- `set_config`, 22:20:15 (tx `5MnZ6J2njJFGSF9dtN8DKaVFes9StcxgZjxUKXkP2AJS`): `risk.version_key` only.
- **The short pause gate passed at 22:24:53, first run** (`pause-11132221.pbf.testnet`,
  `research/data/pause_gate.pass-2026-11-13.json`): the transfer home was signed with nonce 1794608537411 and left
  `send_open_until_ms` at 1794784937411 (15 Nov); one check (`Gh4s6ozV…`) named that nonce in `sent`, the account
  showed `open_sends` empty and `send_open_until_ms` "0", and `borrow` for $50 (`EAfLkiso…`) went through 84 s after
  the USDC came home, 138 s after the transfer was signed. The verdict allowed $731.55 on that book with no hedge.

**A signed order's life (50.4), as deployed:**
- Built first at 5 minutes (`b8b501ad…`, uploaded 22:25 and added as a version; never allowed to read the seed, never
  pinned), then at the user's 4 minutes: `pb-gateway`
  `68a50dfa8518271b96ed0484257609694dd50b4bad9b577c199d609e2e705480` (1,567,319 B), uploaded 22:38 (txs `7UpfnPZM…`,
  `FtJhVArc…`), fetched back and compared, added with `--no-activate`. `pb-risk` kept its hash.
- **The seed's rule (`update_access`, eight hashes, `research/data/order_life_update_access.json`) was sent by the
  user from their own terminal**, about 22:41: the app's permission check refused that step to the main session, as
  a write to who may read a secret. Its hash isn't recorded here.
- The new build then answered `agent_address` for `demo1.pbf.testnet` with
  `0x68643293a2b557f696b7d485b4e1ddaac4a2d46a`, the address of before (157 s in OutLayer's queue).
- `set_config`, 22:45:27 (tx `CyGK96BU8v2Kuwcz4B4eU7cswuDXrYDpLtAve7vvqrM4`): `gateway.version_key` only.
- Read back at 22:46: `GET /api/markets` says `order_life_ms` 230000 with no account, and 110000 for accounts made
  before (`npme2jlqx2`, `pause-11132221`).

**Who has what:** an account made from 19:41 UTC on 13 Nov lists five tokens; from 22:20, its pause lifts early; from
22:45, its orders may be signed for up to 4 minutes. `dopv3pdlim.pbf.testnet` (the user's, wallet
`sourvest632.testnet`) is the first with all three.

**Gate 4 on this code** (`fund-move-11132247.pbf.testnet`): its pass point, `loan_home`, passed at 23:09:41 (test
bitcoin to Aave's chain, an Aave loan, the loan home on NEAR). Its way out stopped at `usdc_out` at 23:17:53, three
checks in a row with no verdict from OutLayer. Resumed at 23:52:50, once OutLayer answered in about a minute again, it ran to the end: **gate 4 passed in full at
00:00:41 UTC on 14 Nov** (Aave and our pool repaid, the collateral back and home, everything withdrawn; record
`research/data/phase6_funding_moves.pause-and-order-life-2026-11-13.json`).

**The gateway's limit, probed live at 00:02 UTC on 14 Nov** (scratchpad `pause_deploy/probe_order_life.mjs`): on
`fund-move-11132247.pbf.testnet`, which pins `68a50dfa…`, its owner signed two ETH buys at half the market, which
can't be placed (the account has no agent, and the price is far outside the band). Signed 250 s ahead: refused with
AUTH, "the message expires more than 240 s ahead: the gateway takes at most 240 s". Signed 230 s ahead: past that
check, and refused next with INPUT, "…'s agent is not the gateway's (0x62d5c138…): call request_agent, then
hl_approve_agent". OutLayer answered both in 5 to 6 s.

**Not proved when this was written:** an order that fills through the new gateway; gate 2
with its three new steps (Hyperliquid testnet's BTC mark stood 2.5% to 2.6% from its oracle from 21:35 to 23:13, and
Hyperliquid takes no order that far out); the Basis trade with a coin other than BTC; every wallet step of the pages
of sections 49 and 50; the refusal side of 50.2 on chain (a transfer signed and never sent), which only tests show.

**Gate 2 on this code did not run to the end** (`fund-rhea-11140014.pbf.testnet`). The mark came inside 2.4% for a
moment at 00:14 UTC on 14 Nov and the gate started: `create`, `deposit`, `hl_init`, `to_hl`, `agent` (the new gateway
named the agent on chain, 105.6 s) and `approve` (Hyperliquid listed it) passed. At `short`, 00:17:17, the mark stood
2.56% out again, and the gate opens no hedge it couldn't close. A script waited until 01:14 UTC for the mark to come
within 2.3%; it stayed between 2.5% and 2.7%. The account holds its test USDC on Hyperliquid and its tokens on
NEAR, with no loan and no short; the gate goes on with `--name fund-rhea-11140014 --from short`.

**Left as it is:** in a market whose mark is 1.5% to 2.4% from its oracle, the app shows the coin as not trading,
because the app prices its own fill-now orders half the band past the reference price; the gates price 0.3% through
the mark and can trade there. Changing the app's pricing is undecided.

**14 Nov, 08:08 to 08:18 UTC: the stopped gate 2 account was unwound with the pause gate's steps, and passed them.**
The stand-in's float on Hyperliquid was down to $356, because `fund-rhea-11140014.pbf.testnet` held $429 of it as
margin for a hedge it could never open, and a Basis trade's margin move (about $440) would have been refused. The
pause gate's record was written for that account from its own passed steps (`create` to `to_hl`, from
`research/data/phase6_funding_rhea.stopped-at-short-2026-11-14.json`) and the gate went on from `home`:
- `home` 08:09:16: the USDC came home, and the float stood at $784.62 again.
- `pause_lifted`: the first two checks got no verdict from OutLayer (its queue again); the third (92 s) lifted the
  pause. `borrow_again` ($50), `repay_again`, `withdraw` followed: **PAUSE GATE PASSED at 08:18:28**, the second
  account to show the lift (`research/data/pause_gate.gate2-account-2026-11-14.json`).
- One fix on the way (`services/keeper/src/pause-kit.ts`, `toHlDone`): the gate's start-up check wanted the float to
  hold the $430 even for a run that goes on after `to_hl`, and so refused the way home that would refill it.
Gate 2 itself still has no run on this code: it needs a new account and Hyperliquid testnet's BTC mark within 2.4% of
its oracle.

### 50.6 A token with 24 decimals was read 100 times too large (14 Nov)

**What was wrong.** `pb_read::util::pow10` gave 10^d only up to d = 22 and 10^22 for anything more. The factory's
config gives wNEAR (`mwnear.pbf-ops.testnet`) 24 decimals, so every amount of it was read 100 times too large: 346.1
wNEAR ($1,150) counted as 34,610 ($115,000). Found on 14 Nov while measuring the Basis trade's margin share: that
book came out with equity $115,441.72 and `allow.borrow` $46,745.15. It was in `pb-risk` up to `d7dd9cc4…` and in
`pb-gateway` up to `68a50dfa…`. The other four tokens have 6, 8 and 18 decimals and were always read rightly.

#### Engine (as built)

- **The fix** (`risk/pb-read/src/util.rs`, `pow10`): the true power for every count of decimals.
  - d up to 22: exact, as before, bit for bit.
  - d from 23 to 38: the nearest `f64` to 10^d. 10^38 is the largest power of ten a `u128` holds.
  - d past 38: the product of two such values. No token has that many: the config refuses more than 24.
  - The same on every platform: the power is an integer, and its conversion to `f64` is Rust's own cast, which
    rounds to nearest and is done in software for a 128-bit integer.
- **Nothing else changed.** Every caller goes through `pow10`, so one line fixes them all:
  - the book's NEAR holdings and a lender's (`pb-read/src/book.rs`), and what a pending transfer sends;
  - a withdraw intent, a lender withdrawal and what is free on NEAR (`pb-risk/src/verdict.rs`);
  - a plan's sale amount (`pb-risk/src/plan.rs`, `sell_leg`) and a lender top-up (`pb-risk/src/lenders.rs`);
  - the credit check's spot holdings and its 1Click amounts (`pb-risk/src/credit.rs`, `pb-read/src/credit.rs`);
  - the gateway's order check, which reads through the same book, and its count of an unused withdrawal
    (`pb-gateway/src/gateway.rs`).
- **Not touched by it:** the loops in `pb-read/src/steps.rs` are about a price's digits and never ask for more
  than 10^22, so they give the same bits as before. `evm::to_micro` and the lenders' dollar values scale in whole
  numbers and never used `pow10`.
- **Every saved run is what it was:** none holds a token past 22 decimals. From the run: the five verdict
  fixtures and the five credit replays are identical byte for byte, the two live snapshots in `research/data`
  give the same values, and `backtest examples` says 144 of 144.
- **Tests.** Each fails with the fix undone (all six did); with it, the suite is 355 (349 before), and lint shows
  only the seven old warnings.

  | What | Test |
  |---|---|
  | The power of ten, exact to 10^22 and true past it | `pb-read/src/util.rs` "the power of ten is the true one for every count of decimals a token may have" |
  | 346.1 wNEAR is 346.1 in the book and about $1,600 in the verdict's equity; the same holding written with 6, 18 or 22 decimals is the same book | `pb-risk/tests/decimals.rs` "a holding of 346.1 units of a 24-decimals token is valued as 346.1 units in the book and in the equity" |
  | A withdrawal of $33 of it is allowed and one of $1,096 behind a $100 loan is refused (it was allowed) | `decimals.rs` "a withdraw intent of a 24-decimals token is weighed at its true size" |
  | A plan's sale of 86.525 wNEAR is written as 86,525 and 21 zeros (it was 100 times too small) | `decimals.rs` "a plan's sale of a 24-decimals token is written in its true units" |
  | The credit check values 346.1 wNEAR at $4 as $1,384.40 | `pb-risk/tests/credit.rs` "the credit check values a 24-decimals token at its true size" |
  | An order is checked on a book that holds 346.1 wNEAR: $1,150 more equity, not $115,000 | `pb-gateway/src/tests.rs` "an order is checked on the true size of a 24-decimals token" |

- **The two files,** built from `risk/` with `RUSTFLAGS="--remap-path-prefix=$HOME=~" cargo build -p <name> --target
  wasm32-wasip2 --release --locked` (rustc 1.93.0). A second build of each gave the same hash.

  | File | Size | sha256 |
  |---|---|---|
  | `pb-risk.wasm` | 1,644,197 B | `9149e09b785f4fdea40b01110120a2eca49e907ad11b70d7e144abdd423e0d45` |
  | `pb-gateway.wasm` | 1,566,274 B | `e3b3ce6f02797301d299d18df6353b065a56581a2362286204cc2b135a933638` |

  Both are a little smaller than the files they replace (1,648,051 B and 1,567,319 B).
- **Who gets it:** an account pins its engine and gateway when it is made. An account that pins `d7dd9cc4…` or an
  older engine still reads wNEAR 100 times too large.
- **Not proved:** nothing ran in the enclave; and the hash from an empty build folder or another machine.

#### As deployed (the main session, 14 Nov, 08:39 to 08:54 UTC)

- **Shown live before the fix.** `fund-move-11132247.pbf.testnet` (ours, a five-token account, empty) was given 100
  test wNEAR, about $332 (mint `BTEA79YmYs4MNuCKbWoMcWoFiVUs6z7LtfQaMSgQVqVy`). A preview by the live engine
  `d7dd9cc4…` put its equity at **$33,075.99**.
- **The fixed builds.** `pb-risk` `9149e09b785f4fdea40b01110120a2eca49e907ad11b70d7e144abdd423e0d45` (1,644,197 B;
  uploads `82f5HdnF…`, `Hk8atcjv…`) and `pb-gateway`
  `e3b3ce6f02797301d299d18df6353b065a56581a2362286204cc2b135a933638` (1,566,274 B; uploads `CJLz49yU…`,
  `zVv7sEV9…`), each fetched back with the right size and hash and added with `--no-activate`. Engine suite 355 by the
  main session's own run; the diff is `pow10` alone.
- **Shown live after.** The same account, the fixed engine run by its version key: equity **$332.64**.
- **The seed's rule** (`research/data/decimals_fix_update_access.json`, nine hashes) was sent by the user from their
  own terminal. The fixed gateway then answered `agent_address` for `demo1.pbf.testnet` with
  `0x68643293a2b557f696b7d485b4e1ddaac4a2d46a`, the address of before.
- **`set_config`, 08:53:59** (tx `8E3mH4UwDHf8Y45oyK31Wke8HsBtsjHckLaipdGN8eN3`): `risk.version_key` and
  `gateway.version_key`, nothing else. 26 accounts, not paused, account code `48497d26…` as before.
- **Who has the fix:** accounts made from 08:54 UTC on 14 Nov. An account made between 13 Nov 19:41 and then lists
  wNEAR and pins an engine that reads it 100 times too large: the gate accounts and `dopv3pdlim.pbf.testnet`, all
  ours or the user's. The pool's own limits still apply to them, but nothing in the engine does: don't hold wNEAR on
  those accounts.
- **Also on 14 Nov, the app:** the Basis trade's margin is 25% of the short's value (`MARGIN_SHARE_BP`, was 38%), on
  the user's word and the engine helper's measurement of 21 runs (the loan offered doesn't move with the share; a
  REBALANCE with a loan open starts at 10% for ETH and 12% for NEAR on a calm day; under 25% the stress tests see
  the ETH or NEAR short closed out). The stand-in's stock on Hyperliquid stays about $785, so two trades can be
  open at once.

#### Gate 2 on the final code (the main session, 14 Nov, 09:00 to 09:27 UTC): PASSED

Hyperliquid testnet's BTC mark came back to 1.8% from its oracle at 08:59 UTC, after standing 2.5% to 2.7% out since
21:35 the evening before. The operator sent the keeper 4 test NEAR (`EFZ3MqYG…`), and gate 2 ran on a new account,
`fund-rhea-11140900.pbf.testnet`, which pins `pb-risk` `9149e09b…` and `pb-gateway` `e3b3ce6f…` and lists five
tokens: every change of 13 and 14 Nov at once.
- **All 29 steps passed** (`research/data/phase6_funding_rhea.final-2026-11-14.json`), in two starts.
- `short` 09:02:37: the hedge opened with a sell at $66,136, **signed for 230,000 ms and filled**: the first filled
  order through a gateway that takes a 4-minute life, and through the fixed build.
- `fund`: $997.11 asked; Rhea lent $509.09 against the bitcoin, our pool the rest. Fee and subsidy settled.
- `top_up` took 717 s: the keeper saw the cushion at about 1.30 at once, and OutLayer gave no verdict for its first
  two checks. The third brought the plan, and the keeper ran it by itself.
- `close_short`, `home`, then `pause_lifted` (one check), `borrow_again` ($50, 135 s after the USDC came home),
  `repay_again`, `withdraw`.
- **The one stop was a race, not a fault:** at `settle_fee` the gate's check and the keeper's own landed together,
  and the account kept the newer verdict and refused the gate's ("blk 277636087 is older than the held verdict's
  277636089"). The gate went on from that step. With OutLayer answering in seconds this can happen to any gate that
  asks its own checks while the keeper watches the account.

Gates on tonight's code, in all: the pause gate twice (13 Nov 22:24, 14 Nov 08:18), gate 4 (14 Nov 00:00, before the
24-decimals fix, which changed `pow10` alone), gate 2 (14 Nov 09:27, on everything).

## 51. ETH as collateral at Rhea and at Aave (14 Nov, 09:50 UTC; rules before the build)

The user, 14 Nov: "i want eth and near added to rhea and aave", then, told what is possible, "Build both" (ETH at
Rhea and ETH at Aave). The plan, with what it rests on, the times and the cut lines, is `research/eth_lenders_plan.md`.
NEAR stays out: the contract takes no Rhea collateral over 18 decimals (audit X2), and Aave's test market lists no NEAR.

**No change to the account contract, the pool or the parameter file. The engine and the gateway change only if the
engine's proof (51.1) fails; then both are published and pinned as on the morning of 14 Nov.**

### 51.1 ETH at Rhea

- **Our Rhea copy** lists `meth.pbf-ops.testnet` with real Rhea's settings for `eth.bridge.near` (read 14 Nov:
  `volatility_ratio` 7500, `extra_decimals` 0, usable as collateral), collateral only (not borrowable) and with the
  caps lifted, as test bitcoin was listed. Its price is a fixed `default_price` in the copy's price setting, in the
  same form as bitcoin's, with test ETH's 18 decimals.
- **The factory:** `lenders.rhea.collateral` = `["mnbtc.pbf-ops.testnet", "meth.pbf-ops.testnet"]`, nothing else
  changed. Accounts made after it can post either.
- **The engine** names ETH on NEAR `ETH.b`. Its Rhea side walks the collateral list. It must be shown, in the
  engine's own tests, that with ETH in the list: a `fund` plan posts ETH at Rhea and borrows there; the cushion and
  the liquidation share use ETH's ratio; a top-up adds ETH or repays; an account holding both tokens is handled by the
  rule that is there, said in words.
- **The keeper** keeps the copy's price of every token in the factory's Rhea collateral list within 0.25% of
  Hyperliquid's oracle price for its coin (bitcoin: BTC; ETH: ETH), each with its own decimals. A hold names the
  token it holds; one without a name is bitcoin's, as before. It writes nothing for a token whose price setting it
  can't read as expected, and says why.
- **Words:** what is posted is called by its plain name: "bitcoin" for nBTC, "ether" for ETH.
- **Gate 2** takes `--coin ETH`: test ETH as the collateral, an ETH short of the same size, the same steps and
  checks. Without it, bitcoin, exactly as before.

### 51.2 ETH at Aave, from the client's own ETH

- **The stand-in** gains two routes: test ETH on NEAR (`nep141:meth.pbf-ops.testnet`) to WETH on Base Sepolia, and
  WETH back to test ETH. Priced from 1Click as the bitcoin routes are. WETH out is at most 0.02 a move from the
  float's own test ETH, keeping its gas reserve, and a quote past that is refused in words.
- **The backend:** `POST /api/quote` with `move: "to_evm"` takes `token` = test ETH's id. With `move: "e_home"` and
  a collateral token's address, the new optional `to` (a NEAR token id of the account) says what it comes home as;
  left out, bitcoin, as before.
- **The engine:** a `to_evm` move of ETH is matched by dollar value like bitcoin's, and WETH at the address and at
  Aave counts as today. To be shown in its tests; no change expected.
- **The app:** two more moves, `ether-out` and `ether-home`, beside the four of before; on an ETH Basis trade the
  Aave step offers the client's own ETH and says the cap in dollars.
- **Gate 4** takes `--coin ETH`.
- **The cap is the fact to keep in view:** about $38 a move, about $70 in all, until the float holds more test ETH.

### 51.3 As built

#### Engine

**Every proof passed with no change to the engine's source.** `pb-risk` is still `9149e09b…` and `pb-gateway`
`e3b3ce6f…` (built again on 14 Nov: nothing to compile, the same hashes). Nothing is to be published. The suite went
from 355 to 364; lint shows only the seven old warnings.

- **The tests:** `risk/pb-risk/tests/eth_lenders.rs` (new, 9 tests), end to end through the program against the
  pretend world. The world (`risk/pb-risk/tests/common/mod.rs`) learned test ETH: `eth` (with it the config lists
  ETH and the Rhea list is bitcoin, then ETH) and `hl_coin` (an ETH short at the pretend mark of $2,257.40).
- **Rhea's answers in the tests:** mainnet's recorded views under the test ids (USDC's ratio 9500, bitcoin's 8000,
  ETH's 7500 with no extra decimals, collateral only), each with a fixed price in the copy's form: the price in
  cents, with the token's decimals and two more (`{"multiplier":"224700","decimals":20}` for ETH at $2,247).

**Part 1, Rhea** (the account: 0.5118 test ETH, $1,150.01; a short of the same size with $290 of margin; no bitcoin;
the pool as it stands live, lenders first):

| Asked | Shown |
|---|---|
| 1. A `fund` verdict | `l_supply` of all the ETH at Rhea, `l_borrow` $546.26 there, `p_borrow` $461.75 from our pool: **$1,008.01 in all** (the tier's cap on collateral binds). A $200 request posts only $421.05 of ETH and takes nothing from the pool |
| 2. The liquidation share and the cushion | `liq_bp` 7125 (7500 x 9500). $1,150.0146 posted against $400: cushion 2.0484, rounded down, room $146.26. Bitcoin and ETH posted together: the two ratios weighted by value |
| 3. A fall at Rhea to $1,950, $546 owed | Cushion 1.3023, REBALANCE. With spare ETH: `l_add` of 0.0777 ETH ($152). With none: `l_repay` $71.96. With neither: no step, and the line says $72 is needed. At $1,700 (1.1353): REBALANCE_NOW, all the spare ETH, then a repayment |
| 4. Bitcoin and ETH held | $300 asked: part of the bitcoin. $600: all the bitcoin, then 0.2239 ETH. More than the book carries: both whole, Rhea $907.26, our pool $629.61 |
| 5. Taking the ETH back | $400 owed: a quarter may leave, three tenths may not ($842.11 must stay). After $200 repaid: 60% may, 70% may not. Repaid in full: all of it |

- **The rule for an account with both** (it was there): a plan posts the account's spare collateral in the order of
  its Rhea list, bitcoin first and then ETH, each only as far as the loan needs. A top-up adds in the same order.
- **Rhea lends $546 on the ETH, not the $430 of the plan:** $1,150.01 x 71.25% / 1.5.
- **One thing the factory's config must keep:** on testnet ETH's ratio to its coin comes from Aave's oracle price
  for WETH, so it needs Aave in the account's config, as the factory has it. With Rhea alone the ETH counts at 80%
  and is held to shrinking (a test shows it).
- **6. The Credit check page** (`pb-risk/src/credit.rs`, `rhea_lender`): nothing breaks. It reads mainnet's Rhea,
  not our copy or the factory's list, and compares on bitcoin alone (`collateral: "nBTC"`, bitcoin's 76%). What it
  under-tells: for a book with ETH and no bitcoin it shows no loan from Rhea, where a testnet account now gets one.
  Left as it is.

**Part 2, Aave:**

- **A `to_evm` move of test ETH** (0.02, $44.94): arrived when the address holds 81%, 85% or all of it as WETH; not
  at 79%, 75% or nothing. The owner's own move counts nothing on its way; a plan step's counts at 98%.
- **WETH from the account's own ETH** counts as WETH always did: the same 0.5118 ETH all on NEAR, or with 0.02 at
  the address, or with 0.02 posted at Aave, is one book to the cent. Aave's entry shows $44.94 at 85% once posted.
- **An `e_home` move of WETH** whose record expects test ETH, expects bitcoin, or says nothing gives the same
  verdict in every figure. The engine reads the token sent and the amount; it doesn't read `expect`.

**Not proved:** nothing ran in the enclave or against the live copy; the copy's real answers for ETH (its
`get_assets` entry and price setting) were not read, the tests use mainnet's entry and the form given above.

#### Stand-in

Built on 14 Nov, 09:58 to 10:06 UTC, in `services/oneclick-shim` only. Nothing is deployed, signed or started; the
running stand-in loads it at its next start. The notes for the Rhea listing are `research/eth_rhea_deploy.md`
(written, not run).

**Two more routes** (`evm-routes.ts`), beside stage 4's four, which answer what they answered:

| Route | Request | What arrives |
|---|---|---|
| `eth_out` | `originAsset` `nep141:meth.pbf-ops.testnet`, `destinationAsset` `1cs_v1:base-sepolia:erc20:0x4200…0006` (WETH), `refundTo` the NEAR account, `recipient` its 0x address | WETH at the address, wrapped from the float's own test ETH |
| `eth_home` | `originAsset` WETH's id, `destinationAsset` `nep141:meth.pbf-ops.testnet`, `refundTo` the 0x address, `recipient` the NEAR account | Test ETH on NEAR, from the float's stock, minted when it is short |

- **WETH comes home as bitcoin unless the quote's destination is test ETH.** A quote from WETH to
  `nep141:mnbtc.pbf-ops.testnet` is the `btc_home` of before, in every figure.
- **Price.** 1Click's dry quote for ETH on NEAR and ETH on Base: `nep141:eth.bridge.near` and
  `nep141:base.omft.near` (both in its token list, 18 decimals). **1Click gives no price between ETH on NEAR and
  WETH on Base** (`nep141:base-0x4200…0006.omft.near`): "No liquidity available", both ways, at 0.0001, 0.005, 0.02
  and 1 ETH, on 14 Nov at 09:59 UTC. It prices ETH on Base both ways: 0.02 ETH out arrives as 0.0199954 (22 s);
  0.02 home as 0.01999596 (35 s). WETH is ETH wrapped one for one, which is how the float makes it, so that is the
  price of the move. The quote's assets and amounts stay WETH's and test ETH's; there is no `shim` note.
- **The cap is the one that was there.** More than 0.02 WETH in one move is refused, dry or not, with HTTP 400:
  "This would arrive as 0.029991 WETH, and the stand-in brings at most 0.02 WETH in one move: its float has little
  test ETH. Send at most 0.020006001800540162 ETH (20006001800540162 units)". So is a float that couldn't wrap the
  amount and keep 0.003 ETH for gas. The way home has no cap.
- **The life is the one of before.** Out: a NEAR deposit address of its own, the deposit seen there, WETH wrapped
  and sent after the quoted time, a refund of the test ETH on NEAR with the msg. Home: the float's address on Base
  Sepolia with the quote's id as memo, the deposit matched by token, sender and amount, test ETH delivered with
  `ft_transfer_call` and the msg, and the WETH unwrapped into the float's test ETH again, so the ETH goes round.
- **Any other pair** between a NEAR token and Base Sepolia is refused (400): "The stand-in moves bitcoin and USDC
  between NEAR and Base Sepolia on four routes only: … Ether has two more: ETH to WETH, and WETH to ETH. ETH to
  WBTC isn't one". The first sentence gained "bitcoin and USDC"; nothing reads it but people.
- No setting is new. `BASE_TWINS.eth` in `assets.ts` is 1Click's id for ETH on Base.

**Files:** `evm-routes.ts` (the two routes, their price), `assets.ts` (`BASE_TWINS.eth`), `server.ts` and
`engine.ts` (comments only: the engine's delivery, mint, refund and unwrap already did what these routes need),
`fakes.ts` (fixtures added), `eth-routes.test.ts` (new).

**Tests:** the stand-in 71 (65 before, none changed), its client 12. The six in `eth-routes.test.ts`, each named
as its rule: which pairs are routes, and that WETH to mNBTC stays bitcoin; the price asked of 1Click (the made-up
1Click refuses WETH as the real one does); the cap and the gas reserve, in their words; ether out end to end with
a forced refund; WETH home as test ETH with the mint, the msg and the unwrap, and the same WETH home as bitcoin;
both routes over HTTP. **Each rule was undone in a copy of the source and its test failed:** the routes removed,
the price asked for WETH itself, WETH home to test ETH treated as bitcoin, the cap, the gas reserve, the mint, the
unwrap, the msg on the delivery, the msg on the refund (nine changes, nine failures; unchanged, six pass).

**Not proved:** no move ran on testnet. The float's test ETH on Base Sepolia was not read (the quote reads it
when it is made). 1Click's answers above are today's; if it stops pricing ETH on Base, these two routes answer
its refusal as it comes, as the bitcoin routes do.

#### Keeper, gates and backend

Built by helper K in `services/keeper` only. Code and unit tests: nothing is deployed, signed or sent, no service
was touched, and `.env` was not read. **Built: the keeper's price sync (51.1) and gate 2 with `--coin ETH`. Not
built in the time: the backend's lender rows and words, the backend's ETH quotes for Aave's chain, and gate 4 with
`--coin ETH`** (see the end).

**The keeper's price sync** (`rhea-price.ts`, `index.ts`).
- `RheaPrices` keeps one `RheaPriceJob` for each token of the factory's `lenders.rhea.collateral` that the
  factory's own token list names as bitcoin (`nBTC`, against BTC's oracle) or ETH (`ETH`, against ETH's). The list
  is read again every five minutes, so a token the factory adds is picked up without a restart; while the factory
  can't be read the last list stands, and before any read it is bitcoin alone, as before.
- Each token's decimals are the factory's token list's, and the copy's price setting must say the same (8 for
  bitcoin, 18 for test ETH), or the keeper writes nothing for it and says why. The price's own decimals must be the
  token's plus 0 to 8. The arithmetic is the one of before: a whole token in dollars is
  `multiplier / 10^(price decimals - token decimals)`. For test ETH's setting as it is on the copy (`decimals` 18,
  `default_price.decimals` 20) the multiplier is cents: $1,948.23 is `"194823"`.
- The jobs run one after the other (one account signs each update), and one token's trouble never stops another:
  no setting, other decimals, an oracle price that doesn't look right (ETH: outside $50 to $500,000), a failed
  transaction. A list entry the keeper has no Hyperliquid price for (wNEAR, say) is left, said once an hour.
- **A hold names its token:** the hold file takes `"token": "<token id>"`. One without it is bitcoin's, as before.
  A name that isn't a string is no hold at all.
- The log: bitcoin's lines are word for word what they were. Ether's say "ETH price" and "an ether", and carry
  `token` and `coin`. A tick's summary keeps `btc_oracle`, `rhea_btc`, `rhea_hold` and gains `eth_oracle`,
  `rhea_eth`, `rhea_eth_hold` once test ETH is kept.
- **The cushion watch** (`cushion.ts`) needed the same: it scales a Rhea cushion by the copy's price since the
  last check, and knew bitcoin's only. Ether's price goes beside it (`prices.lenders["rhea:ETH"]`), and the watch
  takes whichever fell furthest, since a verdict doesn't say which token the account posted. So a fall of ether at
  the copy asks for a check on every account that owes Rhea, bitcoin ones too: one check too many, never one too
  few. Without this the ETH gate's `top_up` would wait for the hourly check.

**Gate 2 takes `--coin ETH`** (`funding-demo.ts`, `funding-steps.ts`, `funding-kit.ts`, `hedge-steps.ts`,
`hedge-kit.ts`, `gate-world.ts`). Without it, bitcoin.
- The hedge steps take the coin from the gate's world (`World.coin`): every `"BTC"`, `btcSz` and `mnbtc` of
  before now reads it, and with none set gives BTC, 5 size decimals and test nBTC. The float tools are called with
  the coin.
- The ETH plan (`planForCoin`) is the bitcoin plan's book in dollars: test ETH worth the bitcoin run's 0.015 BTC,
  cut to ETH's size decimals from Hyperliquid's meta and written with 18, and a short of that size. Today: 0.5244
  test ETH, about $993, and a 0.5244 ETH short.
- Rhea's record is read in the token's own units (18 decimals are Rhea's own inside, so one for one), the copy's
  price is read with ETH's decimals, the oracle is ETH's, the hold of `price_drop` names test ETH, `rhea_withdraw`
  takes test ETH back, and the `keeper` step wants the keeper's tick to show `rhea_eth`.
- Its record is `research/data/phase6_funding_rhea_eth.json`, so the bitcoin record stays.
- **Bitcoin is pinned by the tests of before**, none of which changed: the short, the close, the 40 at once, the
  refused close, the float's calls, the hold with no name, Rhea's units. The suite passed on the transformed code
  before any ETH test was written.

**Tests.** `pnpm --filter @pb/keeper test`: 270 (259 before). `pnpm --filter @pb/api test`: 244, untouched.

| Rule | Test (the start of its name) |
|---|---|
| ETH's 18 decimals to the unit, and the call | "51.1, ETH's 18 decimals to the unit…" |
| Which tokens are kept | "51.1, which tokens are kept: the factory's Rhea collateral list…" |
| Each at its own oracle, with its own decimals | "51.1, each token is kept at its own coin's oracle price…" |
| A hold names its token; none is bitcoin's | "51.1, a hold names the token it holds…" |
| One token's trouble never stops another | "51.1, a token whose setting isn't as expected is left alone…" |
| The list is the factory's, read again | "51.1, the list is the factory's, read again every five minutes…" |
| The cushion watch on ether | "51.1, the copy has a price for each token it takes…" |
| The ETH plan | "51.1, the ETH plan is the bitcoin plan's book in dollars…" |
| ETH orders, and bitcoin as before | "51.1, with the coin set to ETH the short's orders name ETH…" |
| Rhea's units for 18 decimals | "51.1, Rhea's record read for test ETH…" |
| The keeper is ready for an ETH gate | "51.1, the keeper is ready for an ETH gate only when…" |

**Not undone one by one:** unlike the earlier rounds, I did not run each rule's test against the compiled file with
the rule taken out. There was no time.

**Run, sending nothing.**
- The price job as a dry run against the live copy, the live factory and Hyperliquid's oracle: bitcoin at $67,469,
  0.10% from the oracle; and, with the factory's list read as if it had test ETH, ether at $1,913.11 from the
  copy's own setting (18 and 20 decimals), 0.00% from the oracle.
- Gate 2's dry run with `--coin ETH`: the plan above, the copy's ETH price read, the hedge priced in ETH, and one
  thing in the way: "the factory's Rhea settings don't list meth.pbf-ops.testnet as collateral". The bitcoin dry
  run: nothing in the way.

**The commands.**
- Gate 2 in ETH: `pnpm --filter @pb/keeper funding:demo -- --lender rhea --coin ETH` (resume:
  `… --lender rhea --coin ETH --name <label> --from <step>`). After: the factory's `set_config` with test ETH in
  the Rhea list, and the keeper started again on this code.
- Gate 4 in ETH: **not built.** `funding:demo -- --lender aave --moves` takes no `--coin`.

**Safe to restart.** The keeper: yes, its `dist` is the build these tests ran on. It keeps bitcoin as before, and
starts keeping ether once the factory lists test ETH. The backend: nothing of mine changed this round.

**Not built, and what I found.**
- **The backend's lender rows** (`services/api/src/lenders.ts`) are made for bitcoin by their shape, not their
  words: the testnet Rhea row is `collateral: "nBTC"` with one token's terms. ETH is a second token's terms on the
  row, which the app reads; not started.
- **The backend's quotes** (`hl-handlers.ts`, `postEvmMoveQuote`): `to_evm` takes test bitcoin or USDC only, and
  `e_home` brings a collateral token home as bitcoin. Test ETH as `token` and the new `to` are not started.
- **Gate 4 with `--coin ETH`,** and the question of what Aave lends against $38 of WETH: not looked at.

**Not proved.** No ETH run. The keeper's start file (`index.ts`) runs only when the service starts. The float
tools' `--coin ETH` was not called. A few lines of the ETH gate's dry run still say "BTC" or "bitcoin" where they
mean the coin (the hedge's and the copy's "found" lines, and the `keeper` step's words).

#### App

Built by helper W on 14 Nov, 09:53 to 10:20 UTC. `web/src` only; code and unit tests: nothing deployed, signed or
sent, no new dependency, no `next build`.

**Part 1, ETH at Rhea**

- **One rule for the name** (`lib/funding.ts`): `plainName(symbol)` is "bitcoin" for nBTC and WBTC, "ether" for ETH
  and WETH. What a lender holds is named from its own record (`postedWord`, as before), so test ETH at Rhea reads as
  ether on the lender's card, in the repay form and in the take-back panel with no further change.
- **What Rhea would take, before it holds anything** (`rheaCollateralOf`, `wouldPostWord`): from the account's own
  list, `lenders.rhea.collateral` of its `get_config()`. The backend's lender answer doesn't carry that list
  (`config_lenders` has the lenders' names only), so the app reads it from NEAR through the wallet's connection, once
  per account (`hooks/use-own-settings.ts`, moved out of the Basis hook), and from the factory's settings in
  `GET /api/config` for an account not opened yet. Of the list, the tokens the account holds are named ("ether",
  "bitcoin and ether"); with none held, the list ("bitcoin or ether"). **Without the list, or with bitcoin alone in
  it, the word is "bitcoin": an account from before is promised nothing against its ether.**
- **Where it shows:** "Where it comes from" under the amount on the Borrow page and in the Basis trade's loan box
  ("Rhea: against your ether"); the permission's notes at opening and on Account details ("A lender looks only at
  the bitcoin or ether posted with it"), from the factory's or the account's settings.
- **The loan's steps** name the token an account made since 14 Nov posts ("Post 0.236 ETH with Rhea"): the funding
  plan and "Money on its way" now know the account's own tokens (`balances` of GET /api/account), not only the
  app's two.
- **The Basis trade with ETH:** the loan box names Rhea as a source when this account's Rhea takes the trade's coin
  and the engine's split isn't on show; with the split on show, it is the engine's own. The close run was already
  written per token: it repays Rhea and takes back whatever Rhea holds, by that token's own name.

**Part 2, ETH at Aave: built, and switched off** (switched ON by the main session on 14 Nov, 14:40 UTC, after gate 4
in ETH passed: see 51.4. The paragraph below is the state when the app was built.)

**`ETHER_MOVES_ON` in `lib/moves.ts` is `false`.** When this was built the backend's `POST /api/quote` took only
test bitcoin and USDC for `to_evm` and had no `to` for `e_home` (the backend helper's note above: "not started"), so
a button here would only have shown its refusal. With the switch off no account is offered the two moves, the Basis
trade's Aave step is the faucet's as before, and WETH comes home as bitcoin as before. Setting it to `true` turns
all of the following on; nothing else needs a change.

- **Two more moves** (`lib/moves.ts`): `ether-out` ("Move ETH to Aave's chain": `to_evm` with test ETH's id) and
  `ether-home` ("Bring the ETH home": `e_home` with the WETH's address and `to` = test ETH's id, `moveQuoteBody`).
  The bitcoin's way home sends no `to`, as before. They show beside the bitcoin moves on the address card, only for
  an account whose own tokens include test ETH (`etherToken`, `movesFor`: the `balances` list has a token with the
  symbol ETH).
- **The cap** (`etherCapWords`): "At most 0.02 ETH a move on testnet (about $38): the stand-in has little test ETH
  on that chain.", under the amount before anything is typed, with today's dollars when the page has ETH's price.
  An amount over the cap asks for no price: the line turns red and the button stays off. A quote the stand-in
  refuses for its size (`isSizeRefusal`, its own words "brings at most … in one move") shows the same line.
- **A quote's words:** ETH out "arrives as WETH, the wrapped form of ETH that Aave takes"; WETH home "arrives as
  ETH". A listed move home of WETH no longer says "to arrive as nBTC" on an account that lists test ETH: the
  account's record doesn't say which it comes home as.
- **The Basis trade's Aave step, on an ETH trade** (`offersOwnEther`, `ownEtherAmount`): the run stops there, as it
  stops at the loan, with three choices: "Move 0.02 ETH to Aave's chain" (the move's panel, the amount filled in),
  "Use the faucet's test collateral" (the step of before), "Skip Aave". On a bitcoin trade the step runs by itself
  from the faucet, as before.
- **Coming home:** on the close run, WETH at the address comes home as ETH when the trade is in ETH (the account
  lists test ETH and holds ETH on NEAR or is short ETH: `comesHomeAsEther`), else as bitcoin. On the Borrow page the
  take-back panel's way home is "Bring the ETH home" for an account that holds ETH and no bitcoin.

**Which test proves which rule**

| Rule | Test |
|---|---|
| One name rule for both lenders | `funding.test.ts`: "one rule names what either lender holds or would take: bitcoin for nBTC, ether for ETH, at Rhea as at Aave (INTERFACES.md 51.1)" |
| The account's own list decides; an account from before is promised nothing | "what Rhea would take comes from the account's own list: an account from before lists bitcoin alone, and is promised nothing against its ether" |
| The permission's notes | `permission.test.ts`: "the permission's notes name what a lender takes from this account: bitcoin, or bitcoin or ether once its settings let Rhea take test ETH (INTERFACES.md 51.1)" |
| Six moves | `moves.test.ts`: "the four moves: bitcoin and USDC go out with to_evm, the loan and the bitcoin come home with e_home; and two more with the client's own ETH" |
| Only for an account that lists test ETH | "the two ETH moves show only for an account whose own settings list test ETH" |
| The quote's `token` and `to` | "ETH goes out as to_evm with test ETH's id, and WETH comes home as ETH by naming it in `to`; without `to` it comes home as bitcoin, as before" |
| The cap, and a refusal for size | "the cap is said before the client types: at most 0.02 ETH a move, about $38; and a quote refused for its size says the same, not an error" |
| The quote's and the listed move's words | "a quote for ETH says it arrives as WETH, and one for WETH home says it arrives as ETH, with no word of bitcoin" |
| The ETH trade's close | `basis.test.ts`: "an ETH trade closes as a bitcoin trade does: Rhea gives the ether back, and WETH comes home as ETH; on a bitcoin trade it comes home as bitcoin, as before (INTERFACES.md 51)" |
| The Aave step's offer | "on an ETH trade the Aave step offers the client's own ETH, up to the cap; on any other trade it is the faucet's, as before" |

445 pass (436 before); `tsc --noEmit` and `eslint .` clean. The tests of part 2 pass the switch as on.

**Samples** (`/dev/home`): `rhea-eth`, an account whose Rhea holds 0.236 test ETH against a loan; `aave-eth`, the
`aave` account with test ETH among its tokens.

**Seen in the browser** (the dev server, no wallet, my own tab): `rhea-eth` on the Borrow page: no "bitcoin"
anywhere, "Against your ether", Rhea's card ("Ether could fall 43% before Rhea would sell", "75% of the ether's
value", "Your 0.236 ETH"), and the take-back panel ("Rhea holds 0.236 ETH of yours"); `rhea-eth` on Home;
`aave-eth`, before the switch went in (with it off the sample shows the bitcoin move alone): "Move ETH to Aave's
chain" beside the bitcoin move, its panel with the cap line before typing, and with 0.05 typed the line red and
the button off; `three` on the Borrow page (Aave ether, Rhea bitcoin, as before);
`/basis/dev?state=loan` unchanged.

**Not proved.** Nothing ran against the deployed settings, the backend's new `to`, or the stand-in's ETH routes: the
quote bodies are 51.2's as written, and the size refusal's words were read from `services/oneclick-shim`. The Basis
trade's ETH path (Rhea in the loan box, the Aave step's three choices, WETH home as ETH) has no sample: `/basis/dev`
has bitcoin alone. `ether-home` was not opened in a sample (no WETH at the sample's address).

**Decided differently, or left.**
- The Rhea list is read from the account's `get_config()` in the browser, because the lender answer doesn't carry it.
  If the backend adds it, `useOwnSettings` can go.
- "Skippable as today": the Basis rail had no skip for the Aave step; "Skip Aave" is new, on an ETH trade only, and
  isn't remembered across a reload.
- Home's "Where your money is" counts test ETH in its dollars and still lists only nBTC and USDC by name. The
  withdraw form offers only the app's two tokens. Both are as before, and not part of this round.

#### Keeper, gates and backend: the three items left (as built, 14 Nov, 10:30 UTC)

Built by helper K in `services/api/src` and `services/keeper`. Code and unit tests: nothing is deployed, signed or
sent, no service was started or stopped, and `.env` was not read. This replaces "Not built" in my notes above: the
backend's quotes for Aave's chain, the backend's lender rows, and gate 4 with `--coin ETH` are built.

**1. The backend's quotes for Aave's chain** (`hl-handlers.ts`, `POST /api/quote`).
- **`move: "to_evm"`** takes as `token` test bitcoin's id, USDC's id, or **test ETH's id** (the token the account's
  own `get_config().tokens` names `ETH`; an account from before has none, and its message names bitcoin and USDC
  only). For test ETH the stand-in is asked for `nep141:<test ETH id>` to WETH on Aave's chain
  (`1cs_v1:base-sepolia:erc20:<the Aave settings' WETH address>`). Settings that list no WETH: `409 no_aave`. The
  answer is the one of before: the next call is the account's `withdraw` of the ETH with the transfer, and with a
  pool loan open a check for that withdrawal comes first.
- **`move: "e_home"`** with a collateral token's address takes the optional **`to`**: a NEAR token id, test bitcoin's
  or test ETH's, of the account's own settings. It is the quote's destination (`nep141:<to>`), and `delivers` and
  the `expect` the account is told name that token. Left out: bitcoin, as before. Refused with `400 bad_request`:
  `to` that isn't a string; `to` with USDC that isn't USDC ("USDC on <chain> comes home as USDC: leave "to" out");
  `to` that is neither token; test ETH for a token that isn't WETH ("only WETH comes home as ether").
- **A refusal for size** is `400` with `error: "move_too_large"` and the stand-in's own sentence as `message`. It is
  told from the stand-in's other refusals by its words ("at most … in one move", "Ask for less"), which were read in
  `services/oneclick-shim/src/evm-routes.ts`; any other refusal of the stand-in's stays as it was: the
  stand-in's own status (`400`) with `error: "oneclick"`. So the page can tell the two apart by `error`. The
  sentence is passed on whole, so the app's own reading of the words (`isSizeRefusal` in `web/src/lib/moves.ts`)
  still works. A dry quote is refused the same way, so the page can ask before the client signs.

**2. The backend's lender rows and words** (`lenders.ts`).
- **`GET /api/lenders`, the testnet Rhea row, gains `collaterals`.** Every field of before is there and means what
  it meant: `collateral: "nBTC"`, `ltv_bp` and `liq_bp` are bitcoin's. The new field, bitcoin first:

  ```json
  "collaterals": [
    { "token": "mnbtc.pbf-ops.testnet", "symbol": "nBTC", "name": "bitcoin", "decimals": 8,  "ltv_bp": 7600, "liq_bp": 7600 },
    { "token": "meth.pbf-ops.testnet",  "symbol": "ETH",  "name": "ether",   "decimals": 18, "ltv_bp": 7125, "liq_bp": 7125 }
  ]
  ```

  These are today's figures, read at 10:29 UTC from the live factory and copy through the compiled code. The list
  is the factory's `lenders.rhea.collateral`, each token with the symbol and decimals of the factory's own token
  list; `ltv_bp` is the token's `volatility_ratio` times USDC's, and Rhea's two figures are equal, as for bitcoin.
  A token the copy doesn't list is left out. With a factory that can't be read the list is bitcoin alone. The other
  three rows (Aave both, Rhea mainnet) have no `collaterals`. The row is kept 5 minutes, as before. It is the
  factory's list, so it says what a new account can post: an account from before still has its own list in its
  `get_config()`, and the app's rule that the account's own list decides stays right.
- **`POST /api/lender/:account/plan` gains `posted`:** what the plan posts, one entry for each `l_supply` step:
  `{ "l": "rhea", "token": "meth.pbf-ops.testnet", "symbol": "ETH", "name": "ether", "decimals": 18, "amount": "<units>" }`.
  At Aave `token` is the address and `symbol` the Aave settings' (`WETH` is "ether", `WBTC` "bitcoin"). A token
  nobody names has `symbol: null` and its id as `name`.
- **`GET /api/lender/:account`** needed no change: Rhea's `held` already names the account's own tokens, so test
  ETH shows as `ETH` in its own units (a test pins it).
- **Words:** `plainName(symbol)` is the one rule: "bitcoin" for nBTC and WBTC, "ether" for ETH and WETH. The backend
  had no sentence about Rhea that said bitcoin: the rows carried it, and now carry the name.

**3. Gate 4 takes `--coin ETH`** (`moves-demo.ts`, `moves-steps.ts`, `moves-kit.ts`). Without it, bitcoin.
- The account holds test ETH worth the bitcoin gate's $1,300 (today 0.6896 test ETH) and nothing else. The engine
  lends nothing to an account worth under $1,000.
- `btc_out` (the step keeps its name, so `--from` and the records stay one list) sends **0.02 test ETH** with no
  probe: a dry quote first, and if the stand-in takes less today, 2.5% under the amount its refusal names, said in
  the step. A refusal that names no amount stops the step in the stand-in's words.
- `btc_home` asks with `to` = test ETH, and waits for test ETH in the account. The rest is the bitcoin gate's.
- The record is `research/data/phase6_funding_moves_eth.json`, so the bitcoin record stays.
- **What Aave is likely to lend: about $21.** The last bitcoin gate 4 that passed
  (`research/data/phase6_funding_moves.json`, 13 Nov 22:47 UTC) already ran at this size, because the stand-in's
  float capped it: 0.019502 WETH posted, counted at $37.43, and Aave lent $20.82 (cushion 1.528, liquidation at
  85%), with $99.38 from our pool beside it. **No check needs a smaller floor:** the gate's checks ask that Aave's
  books show the collateral and a verdict shows the loan, not for a size, and they passed at $20.82.
- **The ETH gates' dry runs say the coin.** Gate 2's lines that still said BTC or bitcoin (the hedge's and the
  copy's "found" lines, the `keeper` step, the float's margin line) and gate 4's now name ETH, ether or test ETH. A
  test reads every line of the ETH plan for "BTC", "bitcoin" and "nBTC".

**Tests.** `pnpm --filter @pb/api test`: 251 (244 before). `pnpm --filter @pb/keeper test`: 274 (270 before). Both
build.

| Rule | Test (the start of its name) |
|---|---|
| `to_evm` takes test ETH | `hl-handlers.test.ts`: "51.2, to_evm takes test ETH…" |
| `e_home` takes `to` | "51.2, e_home takes `to`…" |
| A refusal for size has its own code | "51.2, a move the stand-in refuses for its size comes back as 400 move_too_large…" |
| The row carries each token's terms | `lenders.test.ts`: "51.1, the testnet Rhea row carries each collateral token's own terms…" |
| A token the copy doesn't list; a factory unread | "51.1, a token of the factory's list the copy doesn't list yet…" |
| The plan says what it posts | "51.1, the funding plan says what it posts by its plain name…" |
| What an account holds at Rhea | "51.1, what an account holds at Rhea shows test ETH…" |
| Gate 4 in ETH, start to end | `moves-gate.test.ts`: "51.2, the moves gate in ETH, start to end…" |
| When the stand-in takes less today | "51.2, when the stand-in takes less than 0.02 ETH today…" |
| Gate 4's dry run in ETH | "51.2, the moves gate's dry run in ETH…" |
| The ETH gate's words | `funding-kit.test.ts`: "51.1, the ETH gate's dry run says the coin in every line…" |

**Undone one by one, this time.** Each rule was taken out of the compiled file, its tests run, and the file put
back: 5 in the backend, 9 for part 1 (the price sync, the cushion watch, the hedge steps, the plan, Rhea's units,
the keeper's readiness, the words) and 4 for gate 4. Every one made a test fail. Both suites were run again after.

**Run, sending nothing** (14 Nov, 10:28 to 10:30 UTC).
- Gate 4's dry run with `--coin ETH`: nothing in the way. The float on Base Sepolia holds 0.03598 test ETH.
- Gate 2's dry run with `--coin ETH`: the factory now lists test ETH, the copy counts an ether at $1,908.3 (0.06%
  from the oracle), and one thing is in the way: the float holds 350.51 USDC in perps on Hyperliquid testnet and a
  small run needs about 530.
- The row above, from two view calls.

**The commands.**
- Gate 4 in ETH: `pnpm --filter @pb/keeper funding:demo -- --lender aave --moves --coin ETH` (resume:
  `… --lender aave --moves --coin ETH --name <label> --from <step>`).
- Gate 2 in ETH: `pnpm --filter @pb/keeper funding:demo -- --lender rhea --coin ETH`.

**Safe to restart.** Both: each `dist` is the build its suite last ran on, with every undone rule put back and the
build run again from the source. The backend needs its restart for the ETH quotes, `collaterals` and `posted`; the
stand-in must be running with its ETH routes for gate 4.

**Not proved.** No ETH run on testnet: the quotes were tested against a stand-in of the test's own, with the real
one's ids and refusal words read from its source. The `move_too_large` rule reads the stand-in's words: if those
change, the refusal goes back to `400` with `error: "oneclick"` and nothing else breaks. The keeper's start file and the
float tools' `--coin ETH` are as in my notes above. Gate 4 in ETH leaves the stand-in's float with less test ETH
for WETH: each run sends 0.02 out and brings it back, less what the routes cost.

### 51.4 At the join (the main session, 14 Nov, 10:15 to 14:45 UTC)

**Part 1, ETH at Rhea: live and proven.**
- 10:15:50 UTC: the factory's `set_config` put test ETH beside test bitcoin in `lenders.rhea.collateral`
  (`86SxTFnVLpRtZ5vUz8gLMQg2BpX9CBX7x5R94nL3RSSz`; the steps and the way back are in `research/eth_rhea_deploy.md`).
  No code was deployed. Accounts made from 10:16 UTC can post ETH at Rhea.
- The keeper keeps our Rhea copy's ETH price beside its bitcoin price (`rhea_eth` in each tick).
- Gate 2 in ETH PASSED at 11:37:20 UTC on `fund-eth-11141017.pbf.testnet`, 29 steps
  (`research/data/phase6_funding_rhea_eth.pass-2026-11-14.json`): 0.5274 ETH and a short of the same size; $478.78
  from Rhea and $518.21 from the pool; ETH at Rhea dropped from $1,910.90 to $1,653.94; the keeper repaid $64.48
  there; the cushion was back at 1.50; the pause lifted after one check.
- One fix of mine on the way: `hedgeNow` passes the coin's size decimals to both `gatePx` calls.

**Part 2, ETH at Aave: proven, and the app's switch is on.**
- Gate 4 in ETH PASSED at 13:38:35 UTC on `fund-move-eth-11141036.pbf.testnet`, 18 steps
  (`research/data/phase6_funding_moves_eth.pass-2026-11-14.json`). 0.02 test ETH left NEAR and arrived as
  0.0199954 WETH; Aave lent $21.12; the loan came home; Aave was repaid; the WETH was taken back and came home
  through `e_home` with `to` naming test ETH, as 0.01999148 test ETH; all of it withdrawn. The float used 0.002 test
  ETH.
- It ran from 10:36 to 13:38. OutLayer's testnet answered almost no check between 11:45 and 13:36 (one at 13:09,
  one at 13:36).
- **The pool's part did not run** ($99.38 in the plan). The keeper stopped the plan after three checks that were read
  before the Aave borrow was mined, and the plan ran out. The gate now says so and goes on (`poolPartLapsed` in
  `funding-kit.ts`; `pool_part_dropped` in the record). So this run does not show a pool loan beside an Aave loan
  against ETH; the bitcoin run of 14 Nov 00:00 shows that split.
- **One repayment was sent twice.** The run moved to the server at 13:10. My first retry script there took the gate's
  own description line for an OutLayer wait and ran `repay_aave` again: nonce 6 at the account's address is a
  repayment Aave reverted, because nonce 5 had already repaid everything. No money moved. The script that finished
  the run (`gate4_resume.sh`) waits until the account's held verdict shows no Aave debt before it goes on, and
  retries only when the "stopped at" line names an OutLayer wait.
- A speck of WETH (107,673,698 wei, interest) is left posted at Aave.
- **`ETHER_MOVES_ON` is `true` since 14:40 UTC** (`web/src/lib/moves.ts`). The web tests pass with it on (445). The
  two ETH moves, the Basis trade's "Move 0.02 ETH to Aave's chain" and WETH coming home as ETH are offered to accounts
  whose own settings list test ETH. None of it has been clicked through with a wallet.

**Where it runs.** Since 13:10 UTC the keeper, the stand-in, the backend and the app run on the hosted server
(`https://13-192-48-169.sslip.io`), not on the build machine. The server was changed to `t3.medium` at 14:36 UTC.

**Checked on the hosted site after the switch (14:41 to 14:45 UTC):** the app restarted at 14:40:46; every page
answers; the Credit check's worked example, with no wallet, came back from OutLayer after 185 seconds (normally about
10): a $94,173.67 line next to Rhea's $63,086.95. So the server's backend reaches OutLayer and pays for runs, and
OutLayer's testnet was still slow.

### 51.5 The app's own orders are priced 2.3% out, not 1.5% (the main session, 14 Nov, 15:15 to 15:25 UTC)

**Why.** At 15:14 UTC Hyperliquid testnet's BTC mark stood 1.58% under its oracle price. The app priced an order
meant to fill at once half the band past the reference (1.5% with the 3% band) and marked a coin as not trading
from 1.5% (50.4 and the notes at 50.5 name this gap). The keeper's own runs trade out to 2.4%. The user said to
widen it, before their wallet click-through.

**The rule now, in one place (`web/src/lib/hl-reach.ts`).**
- `ownOrderBp(band)` = what may be priced (`reachOf`: the nearer of Hyperliquid testnet's 2.4% and the band less
  0.1%) less another 0.1%. With the 3% band: **2.3%**. With a 1% band: 0.8% (it was 0.5%).
- `ownFillBp(band)` = `ownOrderBp` less 0.3% (`THROUGH_MARK_BP`, the keeper's own figure for meeting the book).
  A coin counts as **not trading from 2.0%** with the 3% band (`why: 'page'`, `limitBp` 200); from 0.5% with a 1%
  band, as before.
- Every place that prices such an order uses `ownOrderBp`: a market order on Perps (`lib/perps.ts`, `marketPrice`;
  `MARKET_BAND_SHARE` is gone), the old trade page's fill price and "Close…", the Basis trade's short
  (`use-open-run.ts`) and its close (`use-close-run.ts`), and the setup's short (`setup-actions.ts`).

**What it costs.** The gateway checks the book as if the order filled at its limit (P4, `worst_fill`), so a market
order now counts 2.3% of its size against the account at the check, not 1.5%: $23 on a $1,000 order, not $15. The
fill itself is at the book's prices, as before.

**Tests.** `hl-reach.test.ts` (a new test for the two figures; 1.58% trades, 2.2% does not, an older 1% band still
stops at 0.5%) and `perps.test.ts` (the expected market prices: 69,001 x 1.023 = 70,588 and x 0.977 = 67,414). Web
446 tests, tsc and lint clean. Live on the hosted site since 15:24 UTC. **Not proven by a live order:** no order has
been sent from the app at the new price; the first will be the user's click-through.

### 51.6 The Deposit page loses its 1Click part, and one line is reworded (the main session, 14 Nov, 15:45 to 15:55 UTC)

From the user's wallet click-through on the hosted site.
- **"2. Deposit from your wallet"** now says: "This moves tokens from your wallet into your account. Once they are
  there, they count as collateral." (It named `ft_transfer_call`.)
- **"3. Or deposit through 1Click" is gone from the page** (`web/src/app/deposit/deposit-view.tsx`: `ThroughOneClick`
  and its status words). On testnet it only turned one test token into the other through the stand-in, which the
  Spot tab does. The page is two steps: get test tokens, deposit them. `lib/pages.ts` and the Home panel's link say
  the same. `oneClickDepositTx` stays in `lib/tx.ts` with its test; nothing on a page calls it now.
- On mainnet a deposit from another chain through 1Click would come back as its own piece of work; nothing here is
  on mainnet.

### 51.7 Deposit & withdraw is a tab, right after Home (the main session, 14 Nov, 15:56 UTC)

The user, during the click-through: "move the deposit and withdraw button and workflow out of more and make it
seperate tab right next to the home tab so users dont have to search and the tabs act as a guide. First home, then
deposit then buy spot then trade perps then borrow."
- **Tabs now:** Home, Deposit & withdraw, Spot, Perps, Borrow, Basis trade, More (`web/src/lib/pages.ts`: `/deposit`
  has `place: 'tab'` and is first in `TAB_ORDER`). Basis trade stays where it was, after Borrow.
- **More now:** Activity, Risk, Account details, Credit check, Book, Drill.
- The page, its address (`/deposit`) and every link to it are unchanged. `pages.test.ts` holds the new order.
