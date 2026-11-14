// The NEAR-side tokens of RISK_ENGINE.md 5.4 on mainnet, by the pool's names (INTERFACES.md 2). The credit check's spot
// rows and Rhea's terms use them. Contract ids from RISK_ENGINE.md 5.4; decimals from each token's ft_metadata, read on
// mainnet on 9 Nov (block 223,672,646): USDC 6, USDt 6, NBTC 8, ETH 18, wNEAR 24.

export const SPOT_TOKENS = ["USDC", "nBTC", "ETH", "USDT", "wNEAR"] as const;
export type SpotToken = (typeof SPOT_TOKENS)[number];

export const MAINNET_TOKENS: Record<SpotToken, { id: string; decimals: number }> = {
  USDC: { id: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6 },
  nBTC: { id: "nbtc.bridge.near", decimals: 8 },
  ETH: { id: "eth.bridge.near", decimals: 18 },
  USDT: { id: "usdt.tether-token.near", decimals: 6 },
  wNEAR: { id: "wrap.near", decimals: 24 },
};

/** Rhea's lending contract on mainnet (research/rhea.md 1). */
export const RHEA_CONTRACT = "contract.main.burrow.near";

export function isSpotToken(value: unknown): value is SpotToken {
  return typeof value === "string" && (SPOT_TOKENS as readonly string[]).includes(value);
}
