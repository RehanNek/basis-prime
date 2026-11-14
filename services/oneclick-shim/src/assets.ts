// The test assets the shim moves, and the mainnet assets the real 1Click prices them as.
// Decimals match on both sides, so amounts carry over unchanged.
//
// INTERFACES.md 49 (the Spot page): five test tokens swap on NEAR. mUSDC and mNBTC are the two of Phase 1; test ETH,
// wNEAR and USDT are new, and their token contracts may not be deployed yet (research/spot_tokens_deploy.md). Until
// one is, a quote that names it is refused in words (server.ts, near-tokens.ts) and the listing leaves it out.
import { randomBytes } from "node:crypto";

import { baseSepoliaAssetId } from "@pb/oneclick";

/** NEAR testnet, Hyperliquid testnet, and (stage 4, INTERFACES.md 36) Base Sepolia, where Aave's test market is. */
export type Chain = "near" | "hl" | "evm";

export interface ShimAsset {
  /** The asset id clients use on testnet. */
  assetId: string;
  /** The mainnet asset the real 1Click prices it as. */
  mainnetAssetId: string;
  chain: Chain;
  symbol: string;
  decimals: number;
  /** NEAR: the token contract. Hyperliquid: the token name used in transfers. Base Sepolia: the token's address, lowercase. */
  contract: string;
  /**
   * Section 49's three NEAR tokens only: the contract may not be deployed yet, so a quote that names the asset first
   * asks the chain whether it is there, with these decimals. mUSDC and mNBTC are never asked about.
   */
  checkDeployed?: true;
}

/**
 * The NEAR test tokens' contracts. The first two exist since Phase 1. The other three are section 49's: left out,
 * the stand-in has the assets it always had.
 */
export interface NearTokens {
  musdc: string;
  mnbtc: string;
  /** Test ETH, 18 decimals. */
  meth?: string;
  /** Test wNEAR, 24 decimals. */
  mwnear?: string;
  /** Test USDT, 6 decimals. */
  musdt?: string;
}

/**
 * The assets on NEAR mainnet that 1Click prices the five test tokens as, from 1Click's own token list (GET
 * /v0/tokens, read 13 Nov 2026, 19:09 UTC: the rows with `blockchain: "near"` and the symbols USDC, BTC, ETH, wNEAR
 * and USDT). Their decimals there are 6, 8, 18, 24 and 6: the test tokens', so amounts carry over unchanged.
 * 1Click priced all twenty directions among them that evening (research/spot_tokens_deploy.md).
 */
export const NEAR_TWINS = {
  usdc: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  nbtc: "nep141:nbtc.bridge.near",
  eth: "nep141:eth.bridge.near",
  wnear: "nep141:wrap.near",
  usdt: "nep141:usdt.tether-token.near",
} as const;

/** The tokens of the factory's Aave settings on Base Sepolia (INTERFACES.md 24): USDC, and WBTC and WETH where listed. */
export interface EvmTokens {
  usdc: string;
  wbtc?: string;
  weth?: string;
}

/**
 * The mainnet assets 1Click prices the Base Sepolia test tokens as, from 1Click's own token list (GET /v0/tokens,
 * read 11 Nov): USDC, WETH and cbBTC on Base. 1Click lists no WBTC on Base; cbBTC is the bitcoin it delivers there,
 * with WBTC's 8 decimals, so test WBTC is priced as cbBTC.
 */
export const BASE_TWINS = {
  usdc: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  wbtc: "nep141:base-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near",
  weth: "nep141:base-0x4200000000000000000000000000000000000006.omft.near",
  /**
   * Section 51.2: ETH itself on Base, 18 decimals, from the same list (read 14 Nov). The ether routes are priced
   * with it (evm-routes.ts): 1Click has no liquidity between ETH on NEAR and WETH on Base, and WETH is ETH wrapped
   * one for one.
   */
  eth: "nep141:base.omft.near",
} as const;

/** Hyperliquid testnet USDC (research/hyperliquid.md 5). Mainnet's is USDC:0x6d1e7cde53ba9467b783cb7c530ce054. */
export const HL_TESTNET_USDC_TOKEN = "USDC:0xeb62eee3685fc4c43992febcd9e75443";
export const HL_TESTNET_USDC_ASSET = "1cs_v1:hypercore:hip1:0xeb62eee3685fc4c43992febcd9e75443";

export function shimAssets(tokens: NearTokens, evm?: EvmTokens): ShimAsset[] {
  // Section 49's tokens come last, so every asset of before keeps its place in the list.
  const onNear = (contract: string | undefined, symbol: string, decimals: number, twin: string): ShimAsset[] =>
    contract ? [{ assetId: `nep141:${contract}`, mainnetAssetId: twin, chain: "near", symbol, decimals, contract, checkDeployed: true }] : [];
  const onBase = (address: string | undefined, symbol: string, decimals: number, twin: string): ShimAsset[] =>
    address ? [{ assetId: baseSepoliaAssetId(address), mainnetAssetId: twin, chain: "evm", symbol, decimals, contract: address.toLowerCase() }] : [];
  return [
    {
      assetId: `nep141:${tokens.musdc}`,
      mainnetAssetId: NEAR_TWINS.usdc,
      chain: "near",
      symbol: "mUSDC",
      decimals: 6,
      contract: tokens.musdc,
    },
    {
      assetId: `nep141:${tokens.mnbtc}`,
      mainnetAssetId: NEAR_TWINS.nbtc,
      chain: "near",
      symbol: "mNBTC",
      decimals: 8,
      contract: tokens.mnbtc,
    },
    {
      assetId: HL_TESTNET_USDC_ASSET,
      mainnetAssetId: "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054",
      chain: "hl",
      symbol: "USDC",
      decimals: 8,
      contract: HL_TESTNET_USDC_TOKEN,
    },
    ...onBase(evm?.usdc, "USDC", 6, BASE_TWINS.usdc),
    ...onBase(evm?.wbtc, "WBTC", 8, BASE_TWINS.wbtc),
    ...onBase(evm?.weth, "WETH", 18, BASE_TWINS.weth),
    ...onNear(tokens.meth, "ETH", 18, NEAR_TWINS.eth),
    ...onNear(tokens.mwnear, "wNEAR", 24, NEAR_TWINS.wnear),
    ...onNear(tokens.musdt, "USDT", 6, NEAR_TWINS.usdt),
  ];
}

/** A chain in words, for messages. */
export function chainName(chain: Chain): string {
  return chain === "near" ? "NEAR" : chain === "hl" ? "Hyperliquid" : "Base Sepolia";
}

/**
 * Who sends and receives in the dry quote the shim asks the real 1Click for. That quote only prices
 * the route, so any valid mainnet party will do: `aurora` exists on NEAR mainnet, and 1Click accepts
 * a fresh random EVM address (research/day1.md 4-5, research/scripts/day1_oneclick_*.py).
 */
export function mainnetPlaceholder(chain: Chain): string {
  return chain === "near" ? "aurora" : `0x${randomBytes(20).toString("hex")}`;
}

const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Is this a valid address on the chain: a NEAR account id, or a 0x address on Hyperliquid or Base Sepolia? */
export function isValidAddress(chain: Chain, address: string): boolean {
  return chain === "near" ? NEAR_ACCOUNT.test(address) : EVM_ADDRESS.test(address);
}

/** 13117 with 8 decimals -> "0.00013117"; 10000000 with 6 decimals -> "10". */
export function formatUnits(units: bigint | string, decimals: number): string {
  const value = BigInt(units);
  const sign = value < 0n ? "-" : "";
  const digits = (value < 0n ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** "10.5" with 8 decimals -> 1050000000n. Refuses more decimals than the asset has. */
export function parseUnits(amount: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(amount.trim());
  if (!match) throw new Error(`Not a decimal amount: "${amount}"`);
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > decimals) throw new Error(`"${amount}" has more than ${decimals} decimals`);
  return BigInt(match[1] + fraction.padEnd(decimals, "0"));
}
