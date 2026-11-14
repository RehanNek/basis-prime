# 1Click / Intents / Aurora / Agent API findings (main session, 2026-11-03)

The research agent for this topic stopped on an API rate limit; these notes come from what it saved (docs/, quotes/, tokens.json) plus the local near-intents skill.

## Tokens (live GET /v0/tokens, 2026-11-03)
- USDC on NEAR nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 (6 dec); USDT on NEAR usdt.tether-token.near
- BTC on NEAR: nBTC nep141:nbtc.bridge.near (8 dec, symbol BTC, liquid); old Rainbow wBTC 2260fac...factory.bridge.near is illiquid (a $10k dry quote returned $6.3k); native BTC nep141:btc.omft.near
- ETH on NEAR eth.bridge.near; wNEAR wrap.near
- Hyperliquid USDC 1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054 (8 dec); HyperEVM USDC erc20 variant not supported as origin
- Arbitrum USDC nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near; Base USDC nep141:base-0x8335...omft.near; Ethereum USDC nep141:eth-0xa0b8...omft.near; Solana USDC nep141:sol-5ce3bf...omft.near
- Prices that day: BTC $77,371; ETH $2,286; NEAR $3.80

## Dry quotes without an API key (2026-11-03 ~16:30 UTC)
| Route | Result | timeEstimate |
| NEAR USDC -> HL USDC, $1,000 | 999.48 out | 30 s |
| HL USDC -> NEAR USDC, $1,000 | 999.60 out | 35 s |
| Arbitrum USDC -> NEAR USDC, $1,000 | 999.80 out | 25 s |
| NEAR USDC -> Arbitrum USDC, $1,000 | 999.79 out | 19 s |
| nBTC -> NEAR USDC, $10,000 | 9,983.6 out (-0.17%) | 20 s |
| native BTC -> NEAR USDC, $10,000 | 9,978.9 out | 805 s |
| wNEAR -> NEAR USDC, $999 | 999.04 out | 22 s |
| NEAR USDC -> HL USDC, $100,000 | 99,979 out | 30 s |
| NEAR USDC -> HL USDC, $1,000,000 | No liquidity available | |
| HL USDC -> NEAR USDC, $100,000 and $1,000,000 | No liquidity available | |
| HL USDC -> NEAR, $1 and $0.4 | Amount is too low | |
| NEAR USDC -> HL, $1 and $0.3 | Amount is too low for the destination chain | |
Later probes from this machine got Cloudflare 403 (error 1010); not retried. HL->NEAR capacity lies between $1k and $100k per quote; re-probe with the team's API key.

## Delivery and contracts
- 1Click pays a NEAR recipient with ft_transfer; with customRecipientMsg it uses ft_transfer_call (recipient must implement ft_on_transfer). Funds are LOST if the recipient has no storage_deposit on that token (openapi.yaml). Register storage for every token on every client contract before use.
- A contract can deposit into intents.near with ft_transfer_call and withdraw with a direct ft_withdraw call as predecessor (no signing). Signed intents need add_public_key on intents.near.
- Changelog 2026-10-27: 1Click swaps are confidential-only (settle on the NEAR Private Shard; nearTxHashes lists shield/unshield; no public swap hash). Changelog 2026-09-09: temporary $1,000 minimum on origin->origin swaps for BSC, Polygon, TON, Optimism, Avalanche, Stellar, Monad, XLayer, ADI.
- Fees page: protocol 0.0001%; no key +0.25% on non-ANY_INPUT quotes; key 0.20%, or 0.01% for stablecoin pairs and same-asset routes; quote-improvement split 50/50; key from partners.near-intents.org. The no-key dry quotes above on stable routes cost only 0.02-0.05%; check how the unauthenticated fee appears.

## Aurora Intents
- API key from studio.aurora.dev (not secret). Fee split integrator/Aurora 60/40, Aurora floor 2 bps stables / 10 bps others, max 500 bps. Rate limits per key per endpoint: 100 per 10 s and 2,000 per hour.
- Persistent deposit addresses: POST https://intents-api.aurora.dev/api/persistent-deposit-address/{apiKey} with {recipient, sender, depositChain, destinationChain, destinationAsset, confidential?, recipientType?}. destinationChain can be near. One address serves all EVM chains. Creating new addresses is limited to organisations approved by Aurora (others get 403).
- Intents Connect API: multi-step executions (request-an-execution, request-steps-execution).

## Agent API (docs.agentsonintents.com)
- Mainnet; partner API key (X-API-Key). GET /v1/network reports contract_id outlayer.near (runs on OutLayer).
- Owner: a NEAR account with an ed25519 full-access key, or a passkey (EVM owners gated).
- Policy: frozen, actions [swap, transfer, withdraw], confidential, owner_approval, assets, limits {per_transaction, hourly, daily, monthly} per asset, max_actions_per_hour, destinations {mode "only", list [{action, chain, address}]} (transfer to NEAR accounts allowed), budget {daily_usd, weekly_usd, monthly_usd}, timelock_ms (0-30 days), schedule, optional native keys. One policy change per 10 minutes; freeze immediate.
- Funds sit in the agent's NEAR Intents balance (public or confidential). Deposit addresses: POST /v1/agents/{id}/deposit; refunds go to the agent's own balance.
- Quotas: 3,000 requests/min per partner, 1,200 per key, 100 agents per day, 100 deposit addresses per agent per day.

## Checked 7 Nov, while building the client and the testnet shim
- The live API refuses a quote without `slippageTolerance`, `deadline`, `depositType`, `refundType` or `recipientType`, though the docs call them optional. Our client's types require all five.
- With our key, real quotes match dry ones to within 0.2 bp (`research/day1.md` 4–6).
