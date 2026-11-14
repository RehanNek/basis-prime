# Hyperliquid facts (subagent report, checked 2026-11-03; saved by the main session)

HL = https://hyperliquid.gitbook.io/hyperliquid-docs ; PY = hyperliquid-python-sdk/hyperliquid

1. Signing
- Master only (user-signed EIP-712): approveAgent, withdraw3, sendAsset, spotSend, usdSend, usdClassTransfer.
- Master or API wallet (L1): order, cancel, updateLeverage, modify, cancelByCloid, scheduleCancel, noop, agentSendAsset, agentSetAbstraction.
- User-signed domain: name "HyperliquidSignTransaction", version "1", chainId = int(signatureChainId,16), verifyingContract 0x0. signatureChainId: any hex chain id matching the domain; PY uses "0x66eee" even on mainnet. hyperliquidChain "Mainnet"/"Testnet".
- Types: ApproveAgent(string hyperliquidChain,address agentAddress,string agentName,uint64 nonce); Withdraw(string hyperliquidChain,string destination,string amount,uint64 time) [type withdraw3]; SendAsset(string hyperliquidChain,string destination,string sourceDex,string destinationDex,string token,string amount,string fromSubAccount,uint64 nonce); SpotSend(string hyperliquidChain,string destination,string token,string amount,uint64 time); UsdSend(string hyperliquidChain,string destination,string amount,uint64 time); UsdClassTransfer(string hyperliquidChain,string amount,bool toPerp,uint64 nonce). primaryType prefix "HyperliquidTransaction:". time/nonce field must equal outer nonce. expiresAfter null. PY unnamed agent: signs agentName "" then deletes the key from the posted action.
- L1: connectionId = keccak256(msgpack(action) || nonce u64 BE || (0x00 | 0x01||vault20) || [0x00||expiresAfter u64 BE]); sign EIP-712 Agent(string source,bytes32 connectionId), domain {name "Exchange", version "1", chainId 1337, verifyingContract 0x0}; source "a" mainnet, "b" testnet.
- Plain secp256k1 sig over keccak256(0x1901||domainSep||structHash) is enough; send {r,s,v} with v 27/28 (convert MPC recovery id 0/1). Low-s enforcement UNVERIFIED: normalise s>n/2 -> n-s and flip v. Lowercase addresses. Bad sig -> "User or API Wallet ... does not exist" / "Must deposit before performing actions".
- Body: {"action":{...},"nonce":ms,"signature":{"r","s","v"},"vaultAddress":null,"expiresAfter":null}. cancel {"type":"cancel","cancels":[{"a":0,"o":123}]}; updateLeverage {"type":"updateLeverage","asset":0,"isCross":true,"leverage":5}.
2. Nonces: 100 highest per signer; > smallest stored, unused, within (T-2d, T+1d) ms. Master and each agent tracked separately (MPC actions never collide with agent trading). noop burns a nonce.
3. API wallets: 1 unnamed + 3 named per master, +2 named per sub-account. Expiry via agentName "<name> valid_until <ms>" (max 180 d); default UNVERIFIED; read info extraAgents. Pruned when replaced, expired, or master has no funds. No revoke: replace. Never reuse an agent address (replay after pruning). Agents cannot withdraw/send/approve; can trade, set leverage, agentSendAsset (self only), agentSetAbstraction (can switch to portfolio margin). Query state with the master address; userRole on agent -> {"role":"agent","data":{"user"}}.
4. Activation: address must have received funds before any action ("Must deposit before performing actions"). New account costs 1 USDC activation gas on first tx naming it as destination (HL/for-developers/api/activation-gas-fee); CCTP: taken on first outbound action. Whether 1Click credit activates the account and who pays the 1 USDC: UNVERIFIED; keep 1-2 USDC buffer. Arbitrum bridge min 5 USDC.
5. Testnet: API https://api.hyperliquid-testnet.xyz, app https://app.hyperliquid-testnet.xyz, faucet /drip 1,000 mock USDC only for addresses that deposited on mainnet. Brand-new address funding via usdSend/sendAsset from a teammate: UNVERIFIED, test small. 1Click doesn't reach testnet. Testnet BTC asset 3, ETH asset 4 (mainnet 0,1); USDC token USDC:0xeb62eee3685fc4c43992febcd9e75443 (mainnet USDC:0x6d1e7cde53ba9467b783cb7c530ce054). Testnet BTC tiers 40x <$10k, 25x <$50k, then 10x; partial liquidation from $10k.
6. Info: clearinghouseState{user,dex?}: marginSummary/crossMarginSummary {accountValue,totalNtlPos,totalRawUsd,totalMarginUsed}, crossMaintenanceMarginUsed, withdrawable, time, assetPositions[].position {coin,szi,leverage{type,value,rawUsd?},entryPx,positionValue,unrealizedPnl,returnOnEquity,liquidationPx|null,marginUsed,maxLeverage,cumFunding{allTime,sinceOpen,sinceChange}}; compute liquidation yourself. spotClearinghouseState balances[]{coin,token,hold,total,entryNtl}. metaAndAssetCtxs: universe[{name,szDecimals,maxLeverage,marginTableId}], ctx[{markPx,oraclePx,midPx,funding,openInterest,premium,impactPxs,dayNtlVlm,prevDayPx}]. predictedFundings; fundingHistory {coin,fundingRate,premium,time}; userFunding; candleSnapshot latest 5,000 candles; l2Book 20 levels; userFillsByTime 2,000/resp, latest 10,000; time-range queries 500 items. Also activeAssetData, userRole, extraAgents, userAbstraction, userRateLimit, borrowLendUserState. WS: clearinghouseState, allDexsClearinghouseState, spotState, webData3.
   Rate limits: 1,200 weight/min per IP; exchange 1+floor(batch/40); info weight 2 for l2Book, allMids, clearinghouseState, orderStatus, spotClearinghouseState, exchangeStatus; userRole 60; others 20. WS 10 connections, 1,000 subs, 10 unique users. Per address actions: 1 request per 1 USDC traded + 10,000 initial.
7. Margin: IM = size*mark/leverage; MM = half of IM at max leverage. BTC max 40x (20x >$150M) -> MM 1.25%; ETH 25x (15x >$100M) -> MM 2%. Tiered deduction. Liquidation: market orders to book first; >$100k positions 20% at a time, 30 s cooldown; below 2/3 of MM the HLP liquidator vault takes positions and the MM is not returned; no clearance fee. ADL when account/isolated position value < 0; ranks profitable opposite side by (mark/entry)*(notional/account value); closes at previous mark. 10-11 Oct 2025: first cross-margin ADL in 2+ years; ~$2.1B liquidated 21:16-21:27 UTC in ~16 rounds (arxiv 2512.01112). Funding hourly at 1/8 of 8h rate; F = avg premium + clamp(0.0001 - premium, -0.0005, 0.0005); premium sampled every 5 s; impact notional $20k BTC/ETH; cap per docs. Oracle: validators' weighted median of CEX spot (~3 s), stake-weighted median. Mark: median(oracle + EMA(mid-oracle), median(bid,ask,last), CEX perp mids).
8. Portfolio margin: spot + cross perps together; BTC LTV 0.5, HYPE 0.65; stable borrow APY 0.05 + 4.75*max(0, util-0.8); liquidation when PM ratio > 0.95 (threshold 0.5+0.5*LTV); backstop 0xbbb..b 20% steps. Needs >$10k account value or >$5M volume; ceiling $25M (page) vs $5M (FAQ); no open positions when enabling; caps BTC 200, USDC 250M supply/50M borrow. 50k actions/day. Stage UNVERIFIED (earlier pre-alpha, alpha in Mar 2026). Enable: userSetAbstraction {abstraction:"portfolioMargin"} or agentSetAbstraction {"abstraction":"p"}. Modes: unifiedAccount (recommended), portfolioMargin, disabled (standard separate balances), dexAbstraction (discontinued); fresh address shows "default". HIP-3: 500k HYPE stake, coins "dex:COIN", asset id 100000+dexIndex*10000+index, 11 DEXs live.
9. Fees perps (14d vol, perps + 2x spot): base 0.045/0.015; >$5M 0.040/0.012; >$25M 0.035/0.008; >$100M 0.030/0.004; >$500M 0.028/0; >$2B 0.026/0; >$7B 0.024/0. Min order $10 perps; spot 10 quote units. Max market order $30M (>=25x assets) down to $500k; limit 10x market max.
10. SDKs: hyperliquid-python-sdk 0.24.0 (utils/signing.py, tests/signing_test.py); @nktkas/hyperliquid 0.33.3 (2026-08-02); hyperliquid_rust_sdk 0.6.0 (stale; tokio/reqwest, not WASI); hypersdk 0.3.0 (WASI UNVERIFIED). Own WASI signer: rmp-serde 1.3.1 (to_vec_named), alloy-primitives/alloy-sol-types 1.7.3 or sha3, k256 0.14 (RFC 6979). Gotchas: msgpack key order exactly as SDK, type first; omit absent optionals; prices <=5 sig figs and <= 6-szDecimals decimals (BTC integer); sizes <= szDecimals; float_to_wire normalisation; EIP-712 type names with ":" need manual typehash.
11. withdraw3 to Arbitrum: $1 fee, ~3-5 min, legacy bridge deprecated in favour of CCTP. sendAsset {type,hyperliquidChain,signatureChainId,destination,sourceDex,destinationDex,token,amount,fromSubAccount,nonce}; token "USDC:0x6d1e7cde53ba9467b783cb7c530ce054"; dex "" = default perp, "spot" = spot. spotSend {type,hyperliquidChain,signatureChainId,destination,token,amount,time}. 1Click from HL: send quote.amountIn via sendAsset or spotSend; 0.2 USDC fee, 0.5 USDC minimum; usdSend +1 USDC.

## Checked 7 Nov on testnet, while funding the float
- **The app's Send button** moves USDC with `sendAsset` into the recipient's spot balance. `usdSend` spends perps USDC, so a standard account first needs `usdClassTransfer` (spot → perps); `float:to-perps` in the shim does this for the float.
- **Unified accounts.** An account in `unifiedAccount` mode (info `userAbstraction`) keeps its USDC in spot, and `clearinghouseState` shows 0 for it. Our tester's account was unified; the fresh float was standard. So anything that reads a Hyperliquid account's equity, including the engine's replica in Phase 3, must check the mode and add spot USDC for unified accounts.
- **New addresses.** A transfer to an address that has never sent a Hyperliquid transaction costs 1 USDC.

## Account modes (8 Nov): where the USDC sits

Sources: [account abstraction modes](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes), [info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) and [exchange endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint) docs, and testnet info reads on 8 Nov (no `/exchange` call).

**What the docs say.**
- `userAbstraction` answers one of `"unifiedAccount"`, `"portfolioMargin"`, `"disabled"`, `"default"` and `"dexAbstraction"`, and defines none of them.
- The modes page describes three live modes:
  - **unified:** one balance per asset, shared by spot and every cross position;
  - **portfolio margin:** HYPE, BTC, USDC and USDT together, with borrowing;
  - **standard / manual:** separate perp and spot balances.

  For API users, unified and portfolio-margin accounts show all their balances and holds in `spotClearinghouseState`, and the perp DEX states "are not meaningful". DEX abstraction is discontinued.

**What `default` means: standard, measured.**
- **Our float `0xfc9d…009d`** answers `default`. `clearinghouseState` shows its 790.63 USDC (`accountValue`) and its spot balances are empty. Its ledger (`userNonFundingLedgerUpdates`) shows that the `accountClassTransfer` from spot to perps worked, which a unified account has no use for.
- **120 recent testnet traders,** collected from `recentTrades`: 33 `default`, 66 unified and 21 `disabled`. The `default` ones with positions have a meaningful perp account value next to a separate spot balance, for example $327.90 in perps and a $500 spot balance with no hold.
- **A never-used address** answers `default`, with role `missing`.

**How a unified account looks.** In accounts with open positions:
- `clearinghouseState.accountValue` is only the margin in use, about equal to the spot `hold`;
- the spot USDC `total` moves with the open PnL, tick for tick. One account, sampled 20 s apart: total −0.0465, +0.0839, −0.3586, and its summed `unrealizedPnl` −0.0465, +0.0839, −0.3586. So the spot total is the account value;
- the docs' unified ratio is cross maintenance margin ÷ (spot total − isolated margin).

**Where `usdSend` USDC lands, and why the Phase 1 test found it in spot.** The test's recipient wasn't fresh. The float's ledger shows both deliveries (4.68369 USDC each, `internalTransfer`, which is `usdSend`) going to `0xe6c4…8c80`, the teammate's own account, given with `--to`. That account is `unifiedAccount`: `clearinghouseState` shows 0, and spot holds 207.37 USDC. So:
- `usdSend` credits the recipient's USDC balance;
- for a standard or `default` account that is perps;
- for a unified account it is the one balance, which shows in spot.

`sendAsset` names its source and destination: `""` is the default perp DEX and `"spot"` is spot. The app's Send button used spot to spot.

**What this means for us.**
- **Client accounts start `default`, so standard.** A derived address that has never acted reads `default`, and the shim's `usdSend` lands in perps.
- **Our clients can't change their mode.** Only the master (the account contract's MPC key, which signs `approveAgent` and `sendAsset` only) or our agent (`agentSetAbstraction`, which the gateway never signs) could.
- **pb-risk and pb-gateway still read every case.** Through pb-read, they read `userAbstraction` and `spotClearinghouseState` alongside `clearinghouseState`:
  - `default` and `disabled` take the perp account value;
  - `unifiedAccount` takes the spot USDC total;
  - `portfolioMargin`, `dexAbstraction` and any other answer are refused, since version 0 can't value cross-asset borrowing.
- **Spot USDC in a standard account isn't counted.** It isn't perp margin. `hl_withdraw` with `source_dex: "spot"` could send it home, but nothing on the demo's path puts USDC there.
- **Sending USDC home uses `source_dex: ""` (perps)** for the demo's accounts, because they are standard. `"spot"` is for a unified account, or for USDC that landed in a standard account's spot balance.
- **P10's volume limit, on testnet.** pb-gateway takes the coin's daily volume from mainnet (`metaAndAssetCtxs` `dayNtlVlm` at `api.hyperliquid.xyz`). Testnet's is an artifact: BTC traded $1.94M on testnet and $505.5M on mainnet on 8 Nov.

## L1 signing (8 Nov), from the Python SDK

[hyperliquid-python-sdk](https://github.com/hyperliquid-dex/hyperliquid-python-sdk) tag 0.24.0 (commit `2fdb18f9`, also master on 8 Nov): `hyperliquid/utils/signing.py`, `exchange.py`, `tests/signing_test.py`.

**The hash and the signature.**
- **The action hash.** `action_hash` = keccak256(`msgpack.packb(action)` ‖ nonce as 8 bytes big-endian ‖ `0x00` with no vault, or `0x01` and the vault's 20 bytes ‖ optionally `0x00` and `expiresAfter` as 8 bytes big-endian).
- **The signed struct.** The phantom agent is `{"source": "a" mainnet | "b" testnet, "connectionId": hash}`. It is signed as EIP-712 `Agent(string source,bytes32 connectionId)` in the domain `{name "Exchange", version "1", chainId 1337, verifyingContract 0x0}`.
- **What eth_account returns.** Low-s and v = 27 or 28. `to_hex` drops leading zeros of r and s.

**msgpack.** Python dict order, with `type` first:
- **An order:** `{"type":"order","orders":[wire],"grouping":"na"}`, and `"builder"` only when one is set. Each wire is `{"a","b","p","s","r","t":{"limit":{"tif"}},"c"}`, with `c` (the cloid, `0x` and 32 hex) only when one is set.
- **A cancel:** `{"type":"cancel","cancels":[{"a","o"}]}`.
- **Leverage:** `{"type":"updateLeverage","asset","isCross","leverage"}`.

**Numbers on the wire.** `float_to_wire` writes `f"{x:.8f}"`, then Decimal-normalizes it, so there are no trailing zeros. The docs ask signers to drop trailing zeros too, and pb-gateway refuses any other spelling instead of rewriting it. From the [tick and lot size](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size) page:
- a price has at most 5 significant figures and at most 6 − szDecimals decimals, but a whole number is always allowed;
- a size has at most szDecimals decimals.

**The post.** `{"action","nonce","signature":{"r","s","v"},"vaultAddress":null,"expiresAfter":null}`. The `/exchange` answers per order are:
- `{"resting":{"oid"}}`;
- `{"filled":{"totalSz","avgPx","oid"}}`;
- `{"error":"..."}`, for example "Order must have minimum value of $10.";
- for a cancel, `"success"` or an error.

**Vectors, now pb-gateway unit tests** (`pb-gateway/src/hlsign.rs`):
- the production phantom agent (ETH buy 0.0147 at 1670.1, Ioc, asset 4, nonce 1677777606040): connectionId `0fcbeda5…2908`;
- the `dummy` action, mainnet and testnet;
- an ETH order with and without a cloid, mainnet and testnet.

All match. The SDK's test key `0x0123…0123` has the address `0x14791697260e4c9a71f18484c9f997b308e59325`.

## The ledger (8 Nov): seeing a delivery arrive

pb-risk lists a pending `to_hl` transfer in the verdict's `arrived` once Hyperliquid shows it delivered (INTERFACES.md 14 and 15). It reads that from `userNonFundingLedgerUpdates`, read-only, on testnet.

**The request:** `{"type": "userNonFundingLedgerUpdates", "user": "0x…", "startTime": <ms>}`. It answers a list, oldest first.

**Read on 8 Nov for `hedge1`'s address `0x1b24…d7d0`,** which received the stand-in's delivery and later sent USDC home:
- **The delivery:** `{"time": 1794135720398, "hash": "0xa7a5…ce6b", "delta": {"type": "internalTransfer", "usdc": "429.602143", "user": "0xfc9d…009d", "destination": "0x1b24…d7d0", "fee": "1.0"}}`.
  - `internalTransfer` is a `usdSend`, which is how the stand-in delivers.
  - `usdc` is what the float sent: the quote's `amountOut`.
  - `fee` is Hyperliquid's 1 USDC for a new address. The account then held 428.602143.
- **The move home:** `{"time": 1794136117562, "hash": "0x0e69…ca8f", "delta": {"type": "send", "user": "0x1b24…d7d0", "destination": "0xfc9d…009d", "sourceDex": "", "destinationDex": "", "token": "USDC", "amount": "427.651787", "usdcValue": "427.651787", "fee": "0.0", "nativeTokenFee": "0.0", "nonce": 1794136108889, "feeToken": ""}}`. This is the account's `sendAsset`.

**How pb-risk matches.** A credit is an `internalTransfer` (its `usdc`) or a USDC `send` (its `usdcValue`) whose `destination` is the account's address. It matches a pending `to_hl` transfer if it is between 95% and 100% of the USDC sent, and no earlier than the transfer's deadline less 24 h 30 min. The 95% covers 1Click's fee and slippage: the stand-in delivered 429.60 for 430, and a dry quote 24.68 for 25.

**Not measured:**
- the entry a bridge deposit (`deposit`) makes;
- how real 1Click delivers to Hyperliquid on mainnet.

pb-risk counts neither as a credit yet.
