# ETH as collateral at Rhea and at Aave: the plan (written 14 Nov, 09:45 UTC; the user's "Build both" at 09:48; rules in INTERFACES.md 51)

Testnet only. The deadline is 14 Nov, 23:59 UTC.

## What changes for the client

**Today.** A loan against ETH comes from our pool alone. Rhea takes only test bitcoin. Aave takes wrapped ETH, but the
app can only put it there from a faucet (about $40 to $60), not from the ETH the client holds on NEAR.

**After part 1 (ETH at Rhea).** A hedged ETH trade borrows the way a BTC trade does: about half from Rhea against the
ETH posted there, the rest from our pool. On a $1,150 trade that is roughly $430 from Rhea (Rhea counts ETH at 75%,
bitcoin at 80%) and the rest from the pool. The Borrow page shows Rhea holding ETH, with repay and take-back.

**After part 2 (ETH at Aave).** The client can move ETH from NEAR to the account's address on Aave's chain and back,
and Aave lends against it. **It is capped at 0.02 ETH a move, about $38**, because the stand-in has to hand over real
test ETH there and holds about 0.038. Part 2 shows the path; it can't carry a real position on testnet.

Both reach accounts made after the deploy.

## What it rests on (read on 14 Nov, not guessed)

- **Real Rhea takes ETH.** `contract.main.burrow.near` lists `eth.bridge.near`: `volatility_ratio` 7500,
  `extra_decimals` 0, usable as collateral (bitcoin: 8000 and 10).
- **Our contract allows it.** `lenders.rhea.collateral` is a list of listed tokens other than USDC with at most 18
  decimals (`contracts/types/src/lib.rs`); test ETH has 18. A move to Aave's chain "sends any allow-listed token"
  (`contracts/account/src/lib.rs`, `withdraw` with `to_evm`). **No contract change is planned for either part.**
- **The engine's Rhea side is written per token** (`risk/pb-read/src/lenders.rs`, `rhea_position`: it walks the
  config's collateral list, takes each token's ratio and Rhea's own price, and weights the ratios by value). Bitcoin
  is named only in its tests and in the Credit check page's comparison. Whether the funding and top-up plans pick the
  right token when an account holds ETH and no bitcoin is the first thing to prove (step 1.1).
- **Our Rhea copy** (`rhea.pbf-ops.testnet`, owner `pbf-ops.testnet`): a token is listed with `add_asset` and priced
  with `add_token_pyth_info` and a fixed `default_price` (`scripts/rhea-setup.sh`). The keeper keeps bitcoin's price
  in step with Hyperliquid's oracle (`services/keeper/src/rhea-price.ts`); it has bitcoin's 8 decimals written in.
- **Aave's test market on Base Sepolia** lists USDC, USDT, WBTC, WETH, cbETH and LINK (its `getReservesList`).
- **The stand-in's routes to Aave's chain** are four, for bitcoin and USDC (`services/oneclick-shim/src/evm-routes.ts`).
  WETH is delivered by wrapping the float's own test ETH: at most 0.02 a move, keeping 0.003 for gas.

## Part 1: ETH at Rhea

1. **Engine: prove, and change only if the proof fails** (helper E).
   1. Tests in the engine's pretend world with test ETH in the Rhea list: a `fund` plan for an account that holds
      ETH and a short posts ETH at Rhea and borrows there; the cushion and the liquidation share use ETH's 75%; a
      top-up after a price drop adds ETH or repays; an account with both tokens posts both by the rule that is there.
   2. If all pass with no source change, **nothing is published**: `pb-risk` `9149e09b…` and `pb-gateway` `e3b3ce6f…`
      stay. If a change is needed, both are built, published and pinned as on the morning of 14 Nov (the user runs
      the seed's rule; one more `set_config`).
2. **Our Rhea copy** (keychain, `pbf-ops.testnet`, four small transactions): register the copy on
   `meth.pbf-ops.testnet`; `add_asset` with mainnet's ETH settings (collateral only, not borrowable, caps lifted, as
   bitcoin was listed); `add_token_pyth_info` with ETH's price of the moment; read each back.
3. **Keeper** (helper K): `rhea-price.ts` keeps each collateral token of the copy in step with its Hyperliquid
   oracle price (bitcoin and ETH), each with its own decimals. The gate's price hold names the token.
4. **Factory** (keychain, once): `set_config` with `lenders.rhea.collateral` = bitcoin and ETH, nothing else changed.
5. **Backend and app** (helpers K and W): the lender rows, the funding plan's words and the Borrow page say the
   token that is posted ("ether", not "bitcoin"); the Basis trade's loan step shows Rhea for an ETH trade.
6. **Gate** (helper K): gate 2 takes `--coin ETH`: test ETH as collateral, an ETH short, the same 29 steps. This is
   the ETH gate asked for on 14 Nov.
7. **Proof:** gate 2 with `--coin ETH` on a new account; gate 2 with BTC again if Hyperliquid takes BTC orders.

## Part 2: ETH at Aave, from the client's own ETH

1. **Stand-in** (helper T): two routes, test ETH on NEAR to WETH on Base Sepolia and back, priced from 1Click as the
   bitcoin routes are; the same 0.02 WETH cap and gas reserve; refused in words past the cap.
2. **Engine** (helper E): prove that a `to_evm` move of ETH is seen as arrived (it is matched by dollar value) and
   that WETH at the address and at Aave counts as it does today. No change expected.
3. **Backend** (helper K): `POST /api/quote` with `to_evm` and `e_home` takes test ETH and WETH.
4. **App** (helper W): "Move ETH to Aave's chain" and "Bring the ETH home" beside the bitcoin moves; on an ETH Basis
   trade the Aave step offers the client's own ETH, and says the $38 cap.
5. **Gate** (helper K): gate 4 takes `--coin ETH`.
6. **Proof:** gate 4 with `--coin ETH` on a new account. It uses 0.02 of the float's test ETH and gives it back.

No deploy for part 2 unless step 2 finds an engine change.

## What I need from you

- **Test NEAR:** two gate accounts, about 14. Two faucet accounts (`pbf-fund20.testnet`, `pbf-fund21.testnet`), 9.9
  NEAR each to `pbf-keeper.testnet`.
- **Keychain approvals:** four on the Rhea copy and one on the factory. If the engine needs a change: the seed's
  rule (your own command, as before) and one more on the factory.
- Nothing else. Your click-through can run while the helpers build; the pages change under you when the app's part
  lands.

## Time

| Part | Work, helpers side by side | Deploy and proof |
|---|---|---|
| 1, ETH at Rhea, engine unchanged | about 1.5 to 2 hours | about 1 hour |
| 1, if the engine must change | add 30 minutes | add 30 minutes |
| 2, ETH at Aave | about 1.5 hours, alongside part 1 | about 45 minutes |
| **Both** | **about 2 hours** | **about 1.5 to 2 hours** |

So about 3.5 to 4.5 hours from the go, if OutLayer and Hyperliquid allow the gates. Started at 10:15 UTC, that is
about 14:00 to 15:00 UTC, with 9 hours left for the click-through's fixes, the README, the hosted demo, the video and
the form.

## Where it can go wrong, and where to cut

- **It changes the lender paths on the last day.** Part 1 changes no contract and, if step 1.1 holds, no engine. Its
  new risk is in our Rhea copy's settings, the keeper's price sync and the words.
- **The keeper's price sync is the sensitive piece:** a wrong ETH price on the copy would make the engine's cushion
  wrong for every ETH loan at Rhea. It gets its own tests and a dry run against the live copy before it writes.
- **The gates depend on OutLayer and Hyperliquid**, as all night. ETH's price on Hyperliquid testnet has stayed
  within 1.5% of its reference; BTC's hasn't.
- **Cut lines.** If step 1.1 shows the engine needs more than a small change: stop part 1 and say so. If part 2
  isn't proven by 15:00 UTC: leave it out, with the stand-in's routes unused. Part 1 doesn't depend on part 2.
- **The way back:** `set_config` with the collateral list of before; the copy's ETH listing can stay, since no
  account names it.

## What doesn't change

The account contract. The pool. The parameter file. The five tokens. NEAR at either lender (Rhea's 18-decimals rule;
Aave has no NEAR market). Accounts made before the deploy.
