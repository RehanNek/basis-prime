# Aave v3 as a funding source (main session, 10 Nov 2026)

Read with `python3 -I research/scripts/aave_live.py <out.json>`, from Aave's own API (`https://api.v3.aave.com/graphql`). The saved read is `research/data/aave_live_2026-11-10.json`. Read-only: nothing was signed.

## Live terms

**USDC to borrow:**

| Market | Borrow rate | Free | Room under the borrow cap | Lent out | Steep part starts |
|---|---|---|---|---|---|
| Ethereum (core) | 5.33% | $158.9M | $62.6M | 94.4% | 94% |
| Arbitrum | 4.02% | $35.8M | $32.4M | 82.4% | 90% |
| Base | 6.76% | $16.0M | $16.5M | 91.8% | 90% |

**Bitcoin as collateral:**

| Market | Token | Most it lends (LTV) | Liquidates at | Liquidator's bonus | Room under the supply cap |
|---|---|---|---|---|---|
| Ethereum | WBTC | 81% | 85% | 5.0% | 3,782 WBTC, about $277M |
| Ethereum | cbBTC | 81% | 85% | 7.5% | 1,679 cbBTC, about $123M |
| Arbitrum | WBTC | 78% | 82% | 7.0% | 384 WBTC, about $28M |
| Base | cbBTC | 81% | 84% | 6.0% | 825 cbBTC, about $61M |

**What our own borrowing would do to the rate** (each market's own curve, which reproduces the live rate):

| We borrow | Ethereum | Arbitrum |
|---|---|---|
| $5M | 5.60% | 4.14% |
| $10M | 5.91% | 4.26% |
| $20M | 6.53% | 6.74% |
| $30M | 7.16% | 12.11% |

Either market reaches our 6.5% client rate after about $19.5M.

## The worked example, Aave first

$100,000 of WBTC on Ethereum, our line $94,500, the client pays 6.5%, Aave charges 5.33%.

| Aave's cushion | From Aave | From our pool | BTC fall before Aave liquidates | Our yearly net | On our money |
|---|---|---|---|---|---|
| None: the maximum | $81,000 | $13,500 | 4.7% | $1,825 | 13.5% |
| 1.2 | $70,833 | $23,667 | 16.7% | $2,367 | 10.0% |
| 1.3 | $65,385 | $29,115 | 23.1% | $2,657 | 9.1% |
| 1.5 | $56,667 | $37,833 | 33.3% | $3,122 | 8.3% |
| Pool alone | $0 | $94,500 | n/a | $6,142 | 6.5% |

- **Aave first is right, because Aave is cheaper than our client rate.** The order is the opposite of Rhea's, whose 15.9% makes it a last resort.
- **The maximum is not usable.** At 81% a 4.7% dip triggers liquidation. Liquidators may then repay up to half the loan and take that much bitcoin plus the bonus: on this example the client loses about $2,025 and about $42,500 of bitcoin leaves the hedge.
- **Aave's penalty is 5% to 7.5%, against Rhea's roughly 0.3%.** So the cushion matters more on Aave.
- **Aave cannot see the hedge either.** The balancing between venues stays (research/rhea.md 11).

## What a build needs

- **The bitcoin must be on Aave's chain,** as WBTC or cbBTC, held by an address the client's NEAR account controls through Chain Signatures. It is the same key as the account's Hyperliquid address, so the address is the same on every EVM chain.
- **The account must build and sign Ethereum transactions:** approve, supply, borrow, repay and withdraw. Someone must send them and pay gas on that chain.

## Facts for the build (helper report, 11 Nov; sources are the official pages named)

**Aave's Pool calls** (`IPool.sol` in `aave-dao/aave-v3-origin`, and aave.com/docs/aave-v3/smart-contracts/pool):

| Call | Signature | Selector (recompute in tests) |
|---|---|---|
| Supply | `supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)` | `0x617ba037` |
| Borrow | `borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)` | `0xa415bcad` |
| Repay | `repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)` | `0x573ade81` |
| Withdraw | `withdraw(address asset, uint256 amount, address to)` | `0x69328dec` |
| Read | `getUserAccountData(address user)` | `0xbf92857c` |

- `interestRateMode` is 2 (variable); `referralCode` is 0.
- `getUserAccountData` returns collateral, debt and room in the oracle's base currency (USD with 8 decimals), the liquidation threshold and LTV in basis points, and the health factor scaled by 1e18. With no debt the health factor is the largest uint256.
- A supply needs an ERC-20 `approve` to the Pool first. A first supply is switched on as collateral by itself.
- Anyone may repay for a borrower (`onBehalfOf`).
- **Liquidation:** a liquidator may repay up to 50% of the whole debt, or all of it once the health factor is 0.95 or lower. The collateral taken is the debt covered times the reserve's bonus.

**Aave's test market on Base Sepolia** (`AaveV3BaseSepolia.sol` in `bgd-labs/aave-address-book`, confirmed by reads of the chain):

| What | Address |
|---|---|
| Pool | `0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27` |
| PoolAddressesProvider | `0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00` |
| Protocol data provider | `0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b` |
| Oracle | `0x943b0dE18d4abf4eF02A85912F8fc07684C141dF` |
| WBTC (8 decimals) | `0x54114591963CF60EF3aA63bEfD6eC263D98145a4` |
| USDC (6 decimals) | `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f` |
| Faucet | `0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc` |

- WBTC is collateral there (LTV 81.5%, liquidates at 83%), and its test price follows real BTC ($73,342 on the 10 Nov read). $43.8M of test USDC was free to borrow.
- **The faucet is open to anyone:** `mint(address token, address to, uint256 amount)`, selector `0xc6c3bbe6`. It gives at most 1 WBTC or 1,000,000 USDC per call, once an hour per recipient and token. The faucet's address is not in the address book; it comes from Aave's interface repository, and both test tokens name it as their owner.
- **Base Sepolia:** chain id 84532, RPC `https://sepolia.base.org` (rate-limited), explorer `https://sepolia.basescan.org`, 200 ms blocks since 21 Oct 2026. Gas ETH comes from faucets that need a sign-in (Coinbase Developer Platform, Alchemy).

**Chain Signatures** (docs.near.org and the `near/mpc` contract README): the signer is `v1.signer-prod.testnet` on testnet and `v1.signer` on mainnet. `sign` takes `{"request": {"payload_v2": {"Ecdsa": "<32-byte hex>"}, "path", "domain_id": 0}}`, as our account already calls it, and returns `big_r`, `s` and `recovery_id`. The docs point to the `omni-transaction` crate (0.5.0) for building transactions inside a contract; we can also write the one transaction shape we need by hand.

**An Ethereum type-2 transaction** (EIP-1559): the signed hash is `keccak256(0x02 || rlp([chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit, to, value, data, access_list]))`. The sent transaction adds `y_parity`, `r` and `s` to the list. `y_parity` is the signer's `recovery_id`.

**Hyperliquid's USDC** (hyperliquid.gitbook.io): USDC is now minted natively on Hyperliquid's own chain, and Circle's CCTP is the preferred way in and out. The old bridge on Arbitrum is deprecated. It still credits deposits in under a minute (5 USDC minimum) and pays withdrawals in 3 to 5 minutes for a $1 fee. So Arbitrum is not a long-term shortcut to Hyperliquid.

## Moving bitcoin and USDC between NEAR and Aave's chains (1Click dry quotes, 10 Nov, 21:30 UTC)

Read with `python3 -I research/scripts/oneclick_routes.py`. Dry quotes move nothing. They were asked without our key. (Corrected 11 Nov: this line said they include 1Click's extra 0.25% fee. `research/day1.md` measured on 7 Nov that dry quotes are the same with or without a key, and that a real quote with our key matches the dry one. So these are what we'd pay with our key.)

| Route | Size | Cost | Time |
|---|---|---|---|
| nBTC on NEAR to WBTC on Ethereum | $10,000 and $100,000 | 0.56% | about 29 s |
| nBTC on NEAR to cbBTC on Base | $10,000 and $100,000 | 0.39% | about 22 s |
| Either of those | $500,000 | No liquidity | n/a |
| nBTC on NEAR to cbBTC on Ethereum | $100,000 | No liquidity | n/a |
| WBTC on Ethereum to nBTC on NEAR | $100,000 | 0.13% | about 45 s |
| cbBTC on Base to nBTC on NEAR | $100,000 | 1.03% | about 35 s |
| USDC on NEAR to WBTC on Ethereum | $100,000 | 0.71% | about 29 s |
| USDC on NEAR to cbBTC on Base | $100,000 | No liquidity | n/a |
| USDC on Ethereum or Base to USDC on NEAR | $50,000 | 0.02% | 35 to 45 s |
| USDC on NEAR to USDC on Base | $20,000 | 0.02% | about 22 s |
| USDC on NEAR to ETH on Ethereum, for gas | $50 | 0.38% | about 27 s |

- **So an account holding nBTC can use Aave.** 1Click turns the nBTC into WBTC at the account's own Ethereum address, and brings the borrowed USDC back to NEAR.
- **One move is limited to about $100,000 today.** A bigger position has to move in parts.
- **The move costs $560 on the worked example,** against a margin of $663 a year on Aave's part. So it pays for itself only on a loan that lasts, or when it frees pool money that we can lend to someone else. The engine should move bitcoin only when the saving over the loan's expected life beats the cost.
- **1Click lists no WBTC on Arbitrum,** so Aave's Arbitrum market can't be reached this way.

## Base and Arbitrum instead of Ethereum (11 Nov, 10:35 UTC)

The user asked to drop Ethereum mainnet and keep Aave on L2s only, preferably Arbitrum and Base. Read again with `aave_live.py` (`research/data/aave_live_2026-11-11.json`) and `oneclick_routes.py`; more dry quotes are in `research/data/oneclick_l2_moves_2026-11-11.json`.

| | Ethereum | Base | Arbitrum |
|---|---|---|---|
| Aave's Pool | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| USDC to borrow | 4.73%, $170M free | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`: 5.16%, $19.2M free, 90.3% used (kink 90%) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`: 3.98%, $37.6M free |
| Bitcoin collateral | WBTC: LTV 81%, sells at 85%, penalty 5% | cbBTC `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf`: 81%, 84%, 6% | WBTC `0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f`: 78%, 82%, 7% |
| 1Click delivers that token | Yes | Yes: `nep141:base-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near` | **No.** 1Click's Arbitrum list is ARB, ETH, GMX, SWEAT, USDC, USDT0, WETH |
| nBTC there, $100,000 | 0.39% of the bitcoin (0.52% by dollar value), about 29 s | 0.30% of the bitcoin (0.34% by dollar value), about 22 s | n/a |
| Back to nBTC, $100,000 | Not quoted on 11 Nov; 0.13% on 10 Nov | Not quoted on 11 Nov; 1.03% on 10 Nov | n/a |

- **Every route that starts on Ethereum or Base** answered "Quoting for this pair is not available" on 11 Nov, bitcoin and USDC alike. So the trip back has one reading only, 10 Nov's.
- **Base is cheaper to reach and was dearer to leave.** On 10 Nov's readings the round trip was 0.69% through Ethereum and 1.42% through Base.
- **Base's own docs** (`docs.base.org/get-started/get-funds`) list the Base Sepolia gas faucets. The Coinbase Developer Platform faucet (`portal.cdp.coinbase.com/onchain-tools/faucet`) gives up to 0.1 ETH per 24 hours and needs a Coinbase sign-in.

## A live round trip on Aave's test market, and its full bitcoin cap (11 Nov, about 16:30 UTC)

`node scripts/aave-spike.mjs [--weth] [--send]`, with the gas wallet standing in for a client account. Records:
`research/data/aave_spike_weth.json`.

- **Aave's faucet works** on Base Sepolia: 0.01 WBTC and 1 USDC minted to the wallet (87,902 gas each).
- **WBTC can't be supplied there now.** Its supply cap is 175 WBTC and exactly 175 are supplied, so a supply reverts
  (error data `0xf58f733a`). LINK is full too. WETH has room (1,736 of 2,500), and cbETH, USDC and USDT have no cap.
  The public RPC limits `eth_getLogs` to 200 blocks, so I couldn't see how often the cap frees up.
- **With wrapped test ETH the whole round trip went through:** wrap 0.01 ETH, approve, supply (collateral $20.77,
  LTV 83.5%, liquidates at 85%), borrow 10 USDC (health factor 1.77), approve, repay all with the maximum amount,
  withdraw all, unwrap. USDC there has $44.6M free at 0.74%.

| Call | Gas used |
|---|---|
| `approve` | 46,584 |
| `supply` | 185,866 |
| `borrow` | 259,935 |
| `repay` (all) | 162,260 |
| `withdraw` (all) | 173,127 |
| WETH `deposit` and `withdraw` | 44,866 and 35,116 |

  Each cost about 0.000001 test ETH.
- **Aave's other test markets** (addresses from `bgd-labs/aave-address-book`):
  - **Ethereum Sepolia** (Pool `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951`, data provider
    `0x3e9708d80f7B3e43118013075F7e95CE3AB31F31`, WBTC `0x29f2D40B0605204364af54EC677bD022dA425d03`): WBTC has no cap
    and the faucet is open, but WBTC's price is fixed at $60,000, USDC costs 64% a year with only $29,482 free, and
    the engine would read the fixed price as a 19% depeg. Not usable as it is.
  - **Arbitrum Sepolia and OP Sepolia** list no WBTC.
- **So stage 3's Aave leg on testnet takes WBTC when its cap has room, and wrapped test ETH otherwise.** On mainnet
  the plan is unchanged: WBTC on Ethereum.

**Not confirmed:** which Aave version runs on Ethereum and Arbitrum mainnet; CCTP's time, fee and minimum for Hyperliquid; the total gas for a contract's `sign` call and its callback beyond the 50 TGas we already send.
