# Basis Prime: an onchain prime brokerage on NEAR

**Track:** NEAR HACKATHON, Unstoppable DeFi (`defi`). A self-custody prime brokerage on NEAR: one account that trades spot and perps and borrows against both together. It runs on testnet and is hosted at https://13-192-48-169.sslip.io. Built between 3 and 14 November 2026.

**Our other entry:** [Three Engines, One Token](https://github.com/RehanNek/near-investment-thesis), an investment thesis on NEAR, in the Investment Thesis track (`thesis`). The two projects are independent and share no code.

## Our pitch

**Imagine taking SpaceX stock from Base and using it as collateral to trade on Hyperliquid. That is what we are building at Basis Prime.**

Basis Prime is an onchain prime brokerage. You get portfolio margin on the assets NEAR Intents supports, and you trade on the venues that matter, all from one account that stays yours.

**What a prime broker changes.** Today, if you want to borrow, you go to a lending protocol and deposit spot assets. The protocol lends against that deposit alone. It can't see your perps account, so a fully hedged book borrows as if it had no hedge. A prime broker looks at your whole portfolio, spot and perps together, and gives you margin financing against all of it. One example: $25,000 of bitcoin on NEAR with a $25,000 short on Hyperliquid, backed by $9,500 of margin, carries almost no price risk. Rhea would lend about $15,800 against the bitcoin alone, at a safe distance from liquidation. Our engine lends $24,150 against the whole book (the figures are worked through under "The problem").

**Why onchain, and why NEAR.** The prime brokers that serve crypto today hold your assets for you, and they were not built for onchain markets. Basis Prime changes both:

- **Self-custody.** Each client has an account contract of their own on NEAR. Only that contract can move their tokens on NEAR. Through NEAR Chain Signatures, only it can take money out of their Hyperliquid account or sign for their address on Aave's chain. We never hold a client's keys.
- **Minimal trust.** The risk engine and the order gateway run in OutLayer's secure enclave. Each account accepts answers only from the exact program it pins, so nobody can alter a risk check, not even us.
- **Deep liquidity from day one.** We don't have to raise a lending pool before the first client arrives. A loan draws on Aave's and Rhea's liquidity as well as our own pool. The client asks for one amount; the engine splits it between the lenders and the pool, and the account does every step.

**The whole product is hosted: https://13-192-48-169.sslip.io** The app, the backend, the keeper and the 1Click stand-in all run there on testnet, and we keep it up through judging. "Try it now" starts there: what to click, and what you will see.

**Where it stands.** Everything below runs on NEAR testnet, Hyperliquid testnet and Base Sepolia. Nothing has signed or paid anything on a mainnet. The credit check reads mainnet data. Today the venue is Hyperliquid; an account holds five test tokens (USDC, bitcoin, ETH, NEAR, USDT), and bitcoin and ETH can be posted with a lender; the lenders are Aave's test market and our own copy of Rhea. Tokenised stocks, more venues and mainnet are where this goes next; none of that is built.

- **One loan against a hedged book, part from a lender and part from our pool.** The risk engine splits it. On 14 Nov, on live testnet, a book of about $1,000 of test bitcoin with a short of the same size borrowed $509.09 from our Rhea copy and $488.02 from our pool. The same book in test ETH borrowed $478.78 from Rhea and $518.21 from our pool.
- **Four scripted end-to-end runs passed on live testnet on 14 Nov** ("gates"), each on a new account, every transaction recorded: through Rhea with bitcoin, through Rhea with ETH, through Aave with bitcoin, and through Aave with the client's own ETH. They are listed under "What ran on live testnet".
- **The whole life of a loan was done by hand from the web app with a real wallet on 13 Nov:** open the account, hedge, borrow, bring the lender's money home across chains, repay, take the collateral back, close the hedge, withdraw (`research/data/privacy_level1_click_through.json`). The pages were rebuilt after that, and on 14 Nov a new wallet used them on the hosted site: deposits, swaps on Spot, shorts on Hyperliquid and a $1,000 loan from Rhea.
- **The credit check runs on live mainnet data** inside OutLayer's enclave. On 9 Nov the worked example got a $94,172 line from us, against $63,089 from Rhea at a safe health factor. A local replay matches the enclave's attested output (step 6).
- **The backtest replays five crash days with money arriving 2, 15 or 60 minutes late.** In all 90 cases the pool lost nothing (step 5).
- **The depeg drill ran on testnet with nobody touching anything after the shock** (8 Nov, `research/data/phase4_drill_small.json`). We pushed the test price of bridged bitcoin down against BTC; the keeper watched the account go to watch, margin call and deleverage, and ran the attested plan through the gateway.
- **Every contract went through a security review, twice** (`research/audit.md`). Every High and Medium finding is fixed and live on testnet. What is open is under "Security review".
- **The app shows a client's account only to that client and to the broker** (see "Privacy").

## The problem

Lenders value each deposit alone. Take a client holding $25k of BTC on NEAR (as nBTC), with a $25k BTC short on Hyperliquid backed by $9,500 of USDC margin. Price moves cancel out, so the book carries almost no BTC price risk. Rhea still lends only against the nBTC: about $15.8k if the client keeps a safe 1.2 health factor, at 17.4% a year (Rhea's USDC rate on 3 Nov).

Our engine stress-tests the whole book against the venues' own rules and real crash days. It lends $24,150 against the whole book: 70% of its $34,500, the cap for a new client. The rate depends on how much of the pool is lent out (6.5% at 60%). The numbers come from the reference engine, checked against Hyperliquid testnet's margin rules (`research/day1.md`).

## How it works

1. **Contracts** (`contracts/`): a factory that creates client accounts, the account contract, and the pool. The pool has its own limits, which hold even if the engine is wrong:
   - net new lending is at most 10% of its capital per 24 hours;
   - a new account can borrow at most $25k in its first week;
   - large actions need our co-signature;
   - lending can be paused, but repaying never is.
2. **Risk engine** (`risk/`): `pb-risk` runs in OutLayer's enclave, reads every input itself (NEAR, Hyperliquid, the lenders) and returns a signed verdict: the state, the credit line, the client's rating, how a loan splits between a lender and the pool and, when needed, an unwind plan. The account contract accepts only fresh verdicts from the program whose hash it pins.
3. **Order gateway** (`risk/pb-gateway`): every Hyperliquid order passes the engine's pre-trade checks, one order at a time per account, and is then signed inside the enclave by a trading key made for that account alone. The key's seed was generated inside OutLayer, so nobody has seen it. On Hyperliquid such a key can place and cancel orders and can't take money out. The account approves it through Chain Signatures.
4. **Lenders:** the account posts collateral and borrows in its own name. At Rhea, on NEAR, by contract calls. At Aave, on Base, by Ethereum transactions the account signs through Chain Signatures.
5. **Money movement:** 1Click (NEAR Intents) carries swaps and the moves between NEAR, Hyperliquid and Aave's chain. A deposit from a NEAR wallet into the account, and a withdrawal back to it, is a plain token transfer.
6. **Keeper** (`services/keeper`): asks for checks, runs funding and unwind plans step by step, and tops a lender up when its cushion thins. It uses only public methods, so anyone can run one.
7. **Web app** (`web/`): the tabs read left to right in the order a new client goes: Home, Deposit & withdraw, Spot, Perps, Borrow, Basis trade (put a coin and its margin in the account, short the same amount on Hyperliquid, borrow against both, in one run); under More: Activity, Risk, Account details, Credit check, Book, Drill.

The engine's rules and formulas are in [RISK_ENGINE.md](RISK_ENGINE.md); lending through outside lenders in [FUNDING.md](FUNDING.md); every interface, with what was run and when, in [INTERFACES.md](INTERFACES.md). Those files and the code's comments cite "PLAN.md" by section number: that was our working plan from before the build, and it is not in this repository.

### What NEAR does here, and what sits on other chains

- **Built here, on NEAR:** the three contracts, the two enclave programs, the keeper, the backend and the app.
- **NEAR Chain Signatures** (`v1.signer-prod.testnet`): each client account derives its own Hyperliquid and Ethereum-side address and signs for it. Nobody holds a private key for those addresses: they sign only when the account contract asks.
- **NEAR Intents, 1Click:** every move of money between chains is a 1Click quote and deposit. On testnet a stand-in answers 1Click's API (NEAR Intents has no testnet); its prices are real 1Click quotes.
- **OutLayer:** runs the risk engine and the order gateway in an enclave, with an attestation per run.
- **Rhea:** its live mainnet lending terms are read by the credit check; on testnet the account lends through a copy of Rhea's own release file.
- **Other chains' products we use, not ours:** Hyperliquid (the perps venue) and Aave on Base (a lender). Only the NEAR side above is our work.

## What is real, and what stands in for something

| Piece | On testnet | Real or a stand-in |
|---|---|---|
| Factory, client account and pool contracts | `pbf.testnet`, `<name>.pbf.testnet`, `pool.pbf.testnet` | Real: our contracts, deployed |
| Risk engine and order gateway | `pbf-keeper.testnet/pb-risk` and `/pb-gateway`, run by OutLayer's enclave through `outlayer.testnet` | Real. Each account pins the program's hash and refuses any other |
| Chain Signatures | `v1.signer-prod.testnet` | Real: it signs each account's Hyperliquid actions and its transactions on Base Sepolia |
| Hyperliquid | Hyperliquid's own testnet | Real venue, test money. Its traded price can stand 1 to 3% from its own oracle price |
| Aave | Aave's own test market on Base Sepolia (Pool `0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27`) | Real contracts, test tokens |
| Rhea | `rhea.pbf-ops.testnet` | **Our own copy** of Rhea's release file (`vendor/burrowland/`, unchanged, sha256 `bdd286fe…395055`). Rhea's testnet deployment had empty prices, so we stood one up with our test tokens. Its prices are fixed numbers that our keeper keeps at Hyperliquid's oracle |
| NEAR Intents (1Click) | `services/oneclick-shim` | **A stand-in.** It answers 1Click's own API, takes its prices from real 1Click quotes, and delivers test tokens from floats of ours. It can also fake a refund, a failure or a late delivery |
| Tokens on NEAR | `musdc`, `mnbtc`, `meth`, `mwnear`, `musdt`, each under `.pbf-ops.testnet` | **Test tokens** of ours, with a public `mint` |
| The nBTC to BTC ratio | `drill.pbf-ops.testnet` | **A stand-in** for the bridge's real ratio, so a depeg can be played |
| Keeper | `services/keeper` | Real |
| Mainnet | read only | The credit check reads Hyperliquid, 1Click and Rhea on mainnet. Nothing is signed or paid there |

## Try it now

Every step says what to do and what you will see. Start in a browser with the hosted app. Steps 1 to 9 after it run on your own machine.

### In a browser: the hosted app

Open https://13-192-48-169.sslip.io. It is the whole product on testnet: the app with our backend, keeper and 1Click stand-in behind it, on a server of ours, kept up through judging. Nothing to install, and no key.

**With no wallet**

| | Do | See |
|---|---|---|
| H1 | Open the site. | The tabs in the order a client goes: Home, Deposit & withdraw, Spot, Perps, Borrow, Basis trade, More. Home shows today's BTC, ETH and NEAR prices under "Markets". |
| H2 | More, then Book. | The broker's pool, read live from `pool.pbf.testnet`: its capital (about $10,000,000 of test USDC), loans out, the rate for each tier, the pool's own limits (such as "A new account's first week $25,000.00"), and the last stress test of the whole book with a link to OutLayer's attestation of that run. |
| H3 | More, then Risk, then click `fund-rhea-11131011.pbf.testnet`. | What the risk engine last answered for one of our demo accounts: "Healthy", a credit line of $1,035.02 set by "the Standard tier's cap: 70% of the collateral", equity of $1,478.73, and the biggest risks it found (the market of 12 March 2020 replayed, nBTC losing 20% against BTC, Hyperliquid auto-deleveraging the short). |
| H4 | More, then Activity, then the same account. | One loan from start to end, each line with a link to its transaction: the account created, USDC and bitcoin deposited, 430 USDC sent to Hyperliquid through 1Click, the funding plan's three steps (bitcoin posted at Rhea, a loan from Rhea, a loan from the pool), $502.44 repaid to the pool, the USDC brought home from Hyperliquid, the withdrawal. |
| H5 | Spot. | The swap form with live prices from NEAR Intents, such as "1 BTC = 65,809.22 USDC". The button reads "Sign in to swap". |
| H6 | Perps. | Hyperliquid testnet's BTC-USD market: mark and oracle price, order book, funding. The coin list is the engine's allow-list of 23, with 7 marked "not on testnet". |
| H7 | More, then Credit check, then "Or use the worked example", then Check. | The risk engine runs in OutLayer's enclave on live mainnet data, and answers with our credit line for a $100,000 hedged bitcoin book next to what Rhea would lend against the bitcoin alone (on 9 Nov: $94,172 against $63,089). About 10 seconds when OutLayer's testnet is answering. When it is slow, a banner on every page says so and the line under the button counts the wait; with no answer in about 4.5 minutes the page says "OutLayer did not answer", and Check can be pressed again. Step 6 below checks the 9 Nov run against its attestation without OutLayer. |

**With a NEAR testnet wallet** holding about 7 test NEAR (we used Meteor)

| | Do | See |
|---|---|---|
| W1 | Click Sign in, top right, and sign the one free message. | Home shows "Open your account". |
| W2 | Follow "Open your account" (6 NEAR). | An account contract of your own, with a random name like `k7x2m9qa4t.pbf.testnet`. Home then shows your portfolio: on NEAR, on Hyperliquid, at lenders, less what you owe. |
| W3 | Deposit & withdraw: "1. Get test tokens", then "2. Deposit from your wallet". | Test USDC and test bitcoin, minted free on testnet, now in your account. Home counts them. |
| W4 | Spot: swap some USDC for BTC. | The swap goes through the 1Click stand-in at NEAR Intents' real price, and the BTC shows under "In your account". |
| W5 | Perps: press "Set up trading" (four steps; your wallet opens once for each). Then place a Market order, Sell / Short. | Your account gets its own Hyperliquid address through Chain Signatures and USDC moves there as margin. The order passes the engine's checks in the enclave, and the short shows under your positions. |
| W6 | Borrow: read "Most you can borrow now", enter an amount, press Borrow. | The engine checks the whole book and splits the loan between a lender and our pool. The USDC arrives in your account, and the page shows what you owe and to whom. |
| W7 | Basis trade: fill in "Open a basis trade" and start it. | W3, W5 and W6 as one run: the coin and its margin go in, the short opens, the loan is drawn. |

W1 to W6 were done with a new wallet on the hosted site on 14 Nov, up to a $1,000 loan from Rhea. W5 to W7 each wait on a risk check in OutLayer's enclave: seconds on a good hour, minutes when its testnet is slow. A wait that runs out moves nothing and can be started again. The demo's test money is shared between visitors (see "Known limits").

### On your own machine

Steps 1 to 7 need no key, no wallet and no account. Tools: Python 3.10 or later (standard library only), Rust (`rust-toolchain.toml` pins 1.93.0; if rustup doesn't install it on its own, run `rustup toolchain install` in `risk/`), Node 24.22.2 (`.nvmrc`) with pnpm.

1. **Run the reference engine's worked example.**
   ```bash
   python3 -I research/scripts/risk_engine_ref.py research/data/universe_v0.json research/data/replays_v0.json
   ```
   You see, in about 5 seconds, the full-size hedged book: $100k of nBTC, a $100k BTC short and $35k of Hyperliquid margin.
   - `borrow allowance $94,500 (binding: C4 tier cap)` and `Preferred: $114,750`;
   - a depeg table where the state goes from `HEALTHY` to `WATCH` at nBTC/BTC 0.80, and to `DELEVERAGE` at 0.75;
   - the unwind plan: `perp BTC: trade $25,000, cost $15`. It buys back a quarter of the short instead of selling nBTC at the depegged price.

   The same command with `tests` added at the end runs the engine's 27 property checks: 27 lines marked `[ok]` and `0 failures`.

2. **Run the Rust engine, and compare it with the reference.**
   ```bash
   cd risk && cargo test --workspace && cargo run -p backtest --release -- examples
   ```
   364 tests pass. They cover the engine, the readers of NEAR, Hyperliquid, Rhea and Aave, and the order gateway (Hyperliquid's own signing test vectors, the wallet-signature check, every refusal code). They include a comparison with the Python reference on 559 recorded cases, where every number matches to the last bit. The last line printed is `risk-core vs the Python reference: 144 of 144 lines identical`.

3. **Run the services' and the app's tests.**
   ```bash
   pnpm install && pnpm test
   ```
   1,087 tests pass: the 1Click client (12), the testnet stand-in for 1Click (71), the backend (261), the keeper and the gate scripts (275), the web app (468).

4. **Run the contracts' tests on a local NEAR chain.** The sandbox tests load the contracts' built files, so build them once. That needs cargo-near 0.22.0 (`cargo install cargo-near --version 0.22.0 --locked`).
   ```bash
   cd contracts && ./build.sh && cargo test --workspace --locked
   ```
   710 tests pass, in about 8 minutes once compiled; the first run downloads NEAR's local sandbox (about 29 MB).
   - They try to break each of the pool's own limits, such as the daily lending budget, the $25k first-week limit and the co-signature above $250k. Every attempt is refused.
   - They run funding, unwind and rebalance plans step by step, and the account's records under 1Click refunds, failures and late deliveries.
   - The `upgrade*` suites start from the code and state that were live on testnet at eight points of the build. Those snapshots are in the repository (`contracts/target/live*`, about 13 MB; the one exception to `target/` in `.gitignore`), so the suites run offline.

5. **Replay five crash days with slow money.**
   ```bash
   cd risk && cargo run -p backtest --release -- crash
   ```
   In about 15 seconds you see the table below; every case is in `research/data/backtest_v0.json`. Each book starts with its full credit line drawn and the money taken out. It then lives through the ten worst 4-hour windows of five crash days, minute by minute. The engine checks every minute, and the keeper acts on what it says. Trades on Hyperliquid fill at once; money moved between NEAR and Hyperliquid arrives 2, 15 or 60 minutes later.

   | Book | Loan | Delay | Lowest equity (window, minute) | ÷ debt | Worst state (windows) | Hyperliquid liquidations | Pool loss |
   |---|---:|---:|---|---:|---|---|---:|
   | 13.1 hedged | $94,500 | 2 min | $27,363 (2020-03-12 up, min 39) | 0.29 | DELEVERAGE (1 of 10) | 1: 2020-03-12 up, min 23 (backstop) | $0 |
   | 13.1 hedged | $94,500 | 15 min | $26,036 (2020-03-12 up, min 35) | 0.28 | DELEVERAGE (1 of 10) | 1: 2020-03-12 up, min 23 (backstop) | $0 |
   | 13.1 hedged | $94,500 | 60 min | $24,710 (2020-03-12 up, min 39) | 0.26 | DELEVERAGE (1 of 10) | 1: 2020-03-12 up, min 23 (backstop) | $0 |
   | 13.4 directional, $80k margin | $79,015 | 2 min | $40,125 (2020-03-12 down, min 230) | 0.51 | WATCH (8 of 10) | none | $0 |
   | 13.4 directional, $80k margin | $79,015 | 15 min | $40,103 (2020-03-12 down, min 230) | 0.51 | WATCH (7 of 10) | none | $0 |
   | 13.4 directional, $80k margin | $79,015 | 60 min | $39,924 (2020-03-12 down, min 230) | 0.51 | WATCH (6 of 10) | none | $0 |
   | 13.4 directional, $200k margin | $140,620 | 2, 15 or 60 min | $98,520 (2020-03-12 down, min 230) | 0.70 | HEALTHY (10 of 10) | none | $0 |

   The command prints three more columns: equity ÷ IM, plan steps run and refused, and the worst pool loss during each window.
   - **The pool lost nothing in any of the 90 cases.** The lowest any account fell was 0.26 times its debt.
   - **One liquidation, the same at every delay.** On 13 March 2020, BTC rose 30% within a minute. Hyperliquid liquidated the hedged book's short 23 minutes into that window, whatever the delay. The engine plans for exactly this: the short's margin is lost with it, and the nBTC still covers the loan.

6. **Check two of the enclave's answers yourself.** Each command recomputes, from the inputs the enclave read, what it answered, and prints the hash its attestation should show.
   ```bash
   cd risk && cargo run -p backtest --release -- verdict ../research/data/phase2_preview_snapshot.json
   ```
   prints `a2b074b4524ce36680631bd7c010caab38aecefd2b83191b5b8fa59be415c74a`: the first loan's verdict (7 Nov). The run's attestation is linked in `research/data/phase2_first_loan.json` under `attestation.url` and shows the same `output_hash`.
   ```bash
   cd risk && cargo run -p backtest --release -- credit ../research/data/phase5_credit_snapshot.json
   ```
   prints `6179ca708eeb6e2489e4a3d37e02a8a8fda8c20cde161d04b097b16b0e4e2e64`: the credit check of 9 Nov on mainnet data (ours $94,172, set by the Standard tier's 70% cap; Rhea's $63,089 at a 1.2 health factor, read from Rhea's mainnet contract). Its attestation is linked in `research/data/phase5_live_runs.json`.

7. **Read the live deployment.**
   ```bash
   python3 -I scripts/live-check.py
   ```
   It only reads NEAR testnet's public RPC and Hyperliquid testnet's public API. You see:
   - the factory's code hash, `8f93689e…2f6e3a`, and the pool's, `ca21d533…63ab4c`;
   - what every new client account gets: the account code `48497d26…e1311c`, the risk engine pinned at `9149e09b…3e0d45`, the gateway at `e3b3ce6f…933638`, five tokens, Rhea taking nBTC and ETH, Aave on chain 84532 taking WBTC and WETH;
   - the pool's cash and loans;
   - what our Rhea copy counts a bitcoin and an ether at, next to Hyperliquid testnet's oracle price. They are within 0.25% while our keeper runs.

   Then follow one recorded loan on the explorer. On 14 Nov the account `fund-eth-11141017.pbf.testnet` posted 0.5274 test ETH at Rhea and borrowed against it: [the posting](https://testnet.nearblocks.io/txns/8HTTqUPLzsYPAH2sBbMQnPSQYzn6Xyd1bfEfybC8ESic), [Rhea's loan](https://testnet.nearblocks.io/txns/HzUDsq5dCr8iBQWzQ1Cyg6sHBnHFbtCnc3HEckh466GH), [the pool's loan](https://testnet.nearblocks.io/txns/9sZrNdxqMTzvV1gg7JtMnXNGkHbhznzwbHQJyoXLVH1s). The check between them ran in the enclave:
   ```bash
   curl -s https://testnet-api.outlayer.ai/attestations/by-tx/3wMzVmhahFvwqmYBNTZfVYgvj8ktvbtjG3LRdcawwuGw
   ```
   Its `wasm_hash` is `9149e09b785f4fdea40b01110120a2eca49e907ad11b70d7e144abdd423e0d45`, the engine the account pins. All 29 steps of that run, with every transaction, are in `research/data/phase6_funding_rhea_eth.pass-2026-11-14.json`.

8. **Run the app yourself.** The hosted app is above; this is a copy without our keys. After step 3's `pnpm install`, in two terminals:
   ```bash
   SHIM_URL=http://localhost:8787 pnpm --filter @pb/api start
   ```
   ```bash
   pnpm --filter @pb/web dev
   ```
   The backend prints `previews and orders off (OUTLAYER_PAYMENT_KEY is empty)`. Open http://localhost:3000.
   - **With no key and no wallet** you can read the pages that show public data: Book (the pool's money, read live from `pool.pbf.testnet`) and the markets on Spot and Perps.
   - **With a NEAR testnet wallet** holding about 7 test NEAR, the steps that need only NEAR work in a copy without our keys: open an account (6 NEAR), mint and deposit test tokens (the Deposit & withdraw tab), borrow from the pool (the check is paid from your wallet, 0.01 NEAR), repay, withdraw. This path was last walked by hand on 7 Nov, on the first version of the pages (`research/data/phase2_web_click_through.json`), and not again on today's pages.
   - **What needs keys you don't have:** orders on Hyperliquid and the free previews (an OutLayer payment key), the credit check page (the same key), moves between chains (the stand-in, with its floats on NEAR, Hyperliquid and Base Sepolia), and a lender's part of a loan (a running keeper). `.env.example` lists every setting. Steps 6 and 7 and the records below stand in for these.

9. **Check Hyperliquid testnet against the real market** (optional; public APIs only).
   ```bash
   python3 -I research/scripts/day1_hl_testnet.py research/data/universe_v0.json /tmp/hl_testnet.json 1 0
   ```
   You see, for each of our 23 coins, whether testnet lists it, its margin rules on each network, and how far testnet's mark and oracle prices sit from Binance, OKX, Bybit and Coinbase.

## What ran on live testnet

Each run is a script that plays the client, with our keeper running beside it. It makes a new account, checks every step against the chain, and writes every transaction to its record. The commands are `pnpm --filter @pb/keeper funding:demo -- --lender rhea [--coin ETH]` and `… --lender aave --moves [--coin ETH]`; they need our keys.

| Run | When (UTC) | What it showed | Record (`research/data/`) |
|---|---|---|---|
| Rhea, bitcoin | 14 Nov, 09:27 | 29 steps: a BTC short through the gateway; a loan of $509.09 from Rhea and $488.02 from our pool; a fee and a subsidy settled; Rhea's bitcoin price dropped and the keeper topped Rhea up on its own; everything repaid and withdrawn; then, after the USDC came home from Hyperliquid, one check lifted the pause and a second loan was borrowed | `phase6_funding_rhea.final-2026-11-14.json` |
| Rhea, ETH | 14 Nov, 11:37 | The same 29 steps with test ETH and an ETH short: $478.78 from Rhea, $518.21 from our pool; ETH at Rhea dropped from $1,910.90 to $1,653.94; the keeper repaid $64.48 there and the cushion was back at 1.50 | `phase6_funding_rhea_eth.pass-2026-11-14.json` |
| Aave, bitcoin | 14 Nov, 00:00 | 18 steps: test bitcoin moved from NEAR to the account's address on Base Sepolia, where it arrived as WETH; Aave lent $20.82 against it and our pool $99.38; the loan came home to NEAR; then all of it back: repay, take the collateral back, bring it home, withdraw | `phase6_funding_moves.pause-and-order-life-2026-11-13.json` |
| Aave, the client's own ETH | 14 Nov, 13:38 | The same 18 steps with the client's own test ETH: 0.02 ETH moved to Base Sepolia, where it arrived as WETH; Aave lent $21.12 against it; the loan came home to NEAR; then all of it back: Aave repaid, the WETH taken back and brought home as test ETH, withdrawn. Two things went differently from the bitcoin run. It took three hours, from 10:36, because OutLayer's testnet answered almost no check between 11:45 and 13:36. And the pool's part of the loan ($99.38 in the plan) did not run: no check came back before the plan ran out, so the loan was Aave's $21.12 alone. One repayment was sent a second time by our script after the first had landed; Aave refused it, as nothing was owed | `phase6_funding_moves_eth.pass-2026-11-14.json` |

Earlier runs, by script and by hand, are in the Status table.

## Security review

Every contract we deploy went through the `near-contract-audit` checklist and a line-by-line read, twice: on 9 Nov, and on 12 Nov for the lender code (`research/audit.md`, with each finding's place in the code, what was checked, and the test that covers the fix). There was no Critical finding.

| Finding | Fix | Live for |
|---|---|---|
| **High (9 Nov):** a check read while a loan was still arriving could back a withdrawal of that loan | The account's counter moves again once the money has moved, so that check is refused | Accounts made since 9 Nov |
| **Medium (9 Nov):** one "default" verdict could freeze an account for good | It needs a second verdict 2 to 5 minutes later, and the account can be unblocked after review | Accounts made since 9 Nov |
| **High (12 Nov):** the owner could name a far-off expiry for a move, so money "on its way" hid a hole in the book for a long time | A move's expiry is bounded, and an overdue move stops anything that adds risk | Accounts made since 12 Nov |
| **High (12 Nov):** the owner could change the lender permission again and again, so every check arrived stale and no unwind plan was stored | The permission's change is counted apart, and a check stays good for everything but a new loan | Accounts made since 12 Nov |
| **Medium (12 Nov):** anyone could repay a speck at Aave over and over and hold the account's one signing slot | Anyone but the owner repays the whole debt there or nothing | Accounts made since 12 Nov |
| **Medium (12 Nov), three in the pool:** a fee had no upper bound; a fee or a subsidy could be booked on lender debt that wasn't there; a fee lapsed after 48 hours | Daily limits per account and for the pool, the debt checked against the lender's own figure, and a fee covers all the time since the last settlement | Every account, since 12 Nov |
| **Low (12 Nov), six of seven in the account** | Fixed (INTERFACES.md 47) | Accounts made since 13 Nov |
| **Found by our own tests (14 Nov):** the engine and the gateway counted a token with 24 decimals (test wNEAR) 100 times too large | The power of ten is no longer capped (`risk/pb-read/src/util.rs`) | Accounts made since 14 Nov, 08:54 UTC |

**Still open,** each with its reason in `research/audit.md`:
- a signing call that timed out is taken as "no signature exists" (Low; its fix needs the engine too);
- the operator's own methods don't yet require 1 yoctoNEAR (Low);
- anyone's check can replace the owner's unused one, so an owner's action can fail once and has to be asked again (Low; the app asks again);
- client accounts never take new code (by design; a fix reaches accounts made after it).

**Changed after the review, and not reviewed:** the rule that lifts the pause after money comes home from Hyperliquid (13 Nov; see "Known limits"), and the ETH paths of 14 Nov, which changed no contract.

## Privacy

**What an outsider can see.** NEAR and Hyperliquid are public. Anyone who knows a client account's address can read its balances, its loan and the engine's last check on NEAR, and its positions on Hyperliquid. The broker sees every client in full: that is its job.

**Level 1, "hide who", is built (13 Nov).** It hides whose account is whose. It does not hide what is in an account.
- **The app shows an account only to its owner and to the broker.** A wallet confirms itself with one free signed message (NEP-413, no transaction), good for 12 hours. The backend then answers about an account only to its owner's wallet, the operator's and the keeper's. Anyone else gets "This account belongs to another wallet", with no owner and no numbers.
- **The Risk and Activity pages open no account by name.** With no wallet they list the demo accounts we marked as open (`OPEN_ACCOUNTS`), read-only.
- **The Book page's per-client lines show only to the operator.** The pool's totals, rates and stress test stay public.
- **A new account gets a random name,** like `k7x2m9qa4t.pbf.testnet`, not one made from the wallet's name.
- **`ACCOUNT_PRIVACY=off`** puts all of it back, for a demo where every page should be open.

**What level 1 doesn't do.** The chain stays readable. The factory still lists each account with its owner's wallet. Hyperliquid positions stay public. A client who wants no link at all opens the account from a new wallet funded through a confidential swap: the steps are in `research/privacy_fresh_wallet.md` (mainnet only; written down, not built). Further levels are planned and not built.

## Known limits

**The testnet demo**
- **It is small.** About $1,000 of test bitcoin or test ETH against a short of the same size, because Hyperliquid's test dollars are scarce. It is the book of "The problem" at about 1/25 of the size.
- **A stand-in plays 1Click,** and our own copy plays Rhea (see the table above).
- **OutLayer's testnet is slow in spells.** A check on chain gets about two minutes (NEAR's limit for a waiting call). On 13 and 14 Nov the enclave's queue was at times longer, and on 14 Nov between 11:45 and 13:36 UTC it answered almost no check. An unanswered check moves nothing: the account stores no answer and the action isn't taken. The keeper and the app ask again. The app says when this is happening: the backend times its own OutLayer runs (`GET /api/outlayer`), a banner on every page says when OutLayer's testnet is slow or silent, and a wait that passes a minute names OutLayer and shows the time. On testnet an order may be signed for up to 4 minutes for the same reason (2 on mainnet).
- **Hyperliquid testnet takes no order priced more than about 2.4% from its oracle price,** and its own traded price sometimes stands further out than that (BTC did for 11 hours on 13 and 14 Nov). The app prices an order that should fill at once 2.3% past the reference price, and marks a coin as not trading once Hyperliquid's own price stands 2.0% or more from it.
- **On testnet, an order may be priced up to 3% from the reference price.** The rule on mainnet is each coin's own band: 1% for bitcoin (`RISK_ENGINE.md` 9).
- **The client's own ETH moves to Aave's chain 0.02 ETH at a time** (about $38), because the stand-in has to hand over real test ETH there and holds little.
- **A tester's wallet needs about 7 test NEAR:** 6 to open the account, the rest for checks and gas.
- **The hosted demo's test money is shared.** Every visitor's moves and hedges draw on the same floats (about $785 of test USDC on Hyperliquid, which carries two hedged trades of about $1,000 at once, and a little test ETH on Base Sepolia). If they are used up, moves and new hedges stop until we refill them.

**The product**
- **Client accounts never take new code.** An account keeps the code and settings it was made with, so each fix reaches the accounts made after it. Accounts made since 14 Nov, 10:16 UTC have everything in this README.
- **After money comes home from Hyperliquid, new borrowing waits for one check.** Hyperliquid accepts a signed transfer for 2 days, so an old one could take collateral out from under a loan. The account lists each transfer it signed; once a check sees it in Hyperliquid's own history, the pause lifts. Without that it lasts 2 days and 1 hour. Repaying is never blocked. This rule is newer than the security review.
- **NEAR can't be posted with a lender.** Our contract takes Rhea collateral with at most 18 decimals (wNEAR has 24), and Aave's market has no NEAR. NEAR still counts in the whole-book loan from our pool.
- **Deposit and withdraw take USDC and bitcoin.** ETH, NEAR and USDT get in and out of an account through a swap on Spot.
- **nBTC and ETH on NEAR are priced from 1Click alone.** No NEAR pool trades enough of either to give a second price (`research/near_dex.md`). Caps limit the loss if a bridge failed (loans resting on nBTC can't exceed 30% of the pool's money, 15% for ETH), and we can freeze a token at once: no new loans rest on it, and nobody is forced to sell.
- **The credit check prices at most 6 coins per address,** to stay inside OutLayer's 20 seconds per run, and prices nBTC with a 1Click quote made without our key, which carries 1Click's extra 0.25% fee, so the line comes out slightly low.
- **The enclave programs' hashes can't yet be rebuilt from any checkout path.** The published builds are `RUSTFLAGS="--remap-path-prefix=$HOME=~" cargo build -p pb-risk --target wasm32-wasip2 --release`; a path-independent build is not done.
- **The app loads its fonts from Google Fonts** in the browser.

## Status

| Phase | What | State |
|---|---|---|
| 0 | Setup and the unknowns: repo skeleton, day-1 checks | Done (7 Nov) (`research/day1.md`) |
| 1 | Engine and pool, offline | Done (7 Nov) |
| 2 | First loan on testnet | Done (7 Nov), by script and from the web app with a Meteor wallet (`research/data/phase2_web_click_through.json`) |
| 3 | The hedge: Chain Signatures and the gateway | Done (8 Nov), at the testnet size, by script and from the web app (`research/data/phase3_hedge_small.json`, `research/data/phase3_web_click_through.json`) |
| 4 | Guard rails and the depeg drill | Done (8 Nov): the drill with nobody touching it, the close-out, and the stand-in's three faults (`research/data/phase4_drill_small.json`, `research/data/phase4_faults.json`) |
| 5 | Credit check on mainnet data, backtest | Done (9 Nov) (`research/data/phase5_live_runs.json`); the first security review |
| 6 | Funding through outside lenders: Rhea and Aave, the split, pricing, the moves between chains | Done (10 to 13 Nov), in four stages, each ending in a run on live testnet (FUNDING.md 11); the second security review and its fixes; privacy level 1; the whole workflow by hand with a real wallet on 13 Nov |
| after | The app rebuilt around tabs; five test tokens that swap; the pause that lifts after one check; ETH as collateral at Rhea, and the client's own ETH at Aave | 13 and 14 Nov. Both ETH paths proven by a run (see above) |
| hosting | The app, backend, keeper and stand-in on one server | 14 Nov: https://13-192-48-169.sslip.io |
| not done | Any mainnet step | |

## Repository layout

```
contracts/   NEAR contracts (Rust, near-sdk 5.29.1): factory, account, pool, testnet tokens and mocks, sandbox tests
risk/        risk-core (pure Rust library), pb-read (the readers), pb-risk and pb-gateway (OutLayer programs), backtest (CLI)
services/    TypeScript: 1Click client, 1Click stand-in for testnet, keeper and gate scripts, backend (API)
web/         Next.js app: Home, Deposit & withdraw, Spot, Perps, Borrow, Basis trade; under More, activity, risk,
             account details, credit check, book and the testnet drill
scripts/     testnet setup scripts, and live-check.py (step 7)
research/    notes with sources, market data, the Python reference engine, the security review, and research/data/:
             the record of every live run
vendor/      Rhea's release file, for the testnet copy
```

Keys go in `.env` only (see `.env.example`); `.env` is gitignored.

## What was built when, and with what

- **All of it was written inside the hackathon's window.** The work started on 3 Nov 2026; there is no earlier code of ours in it, and no other project of ours shares code with it.
- **It was built in one working folder without version control,** so the repository's history starts at the submission. What was built on which day is in the dated records under `research/data/` and the dated sections of INTERFACES.md.
- **Written with AI coding help** (Claude Code), under the team's direction; every live step on testnet was approved by a person.
- **Other people's code:**
  - `vendor/burrowland/` is Rhea's own release file, unchanged, used only to stand up a copy of Rhea on testnet (`scripts/rhea-setup.sh` checks its hash);
  - libraries, at pinned versions: near-sdk 5.29.1 and cargo-near 0.22.0 (contracts); near-api-js 7.4.0, @hot-labs/near-connect 0.11.4, @nktkas/hyperliquid 0.33.3, Next.js 16.4.5, React 19.3.1, Bootstrap 5.3.8 and Bootstrap Icons 1.13.2 (services and web app); the rest are in `Cargo.lock` and `pnpm-lock.yaml`;
  - the `near-contract-audit` checklist from NEAR's agent skills, for the security review.

## License

MIT
