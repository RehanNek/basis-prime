// The shim's settings, from .env (see .env.example). It runs on testnet only.
// A float whose variables are empty is simply off: dry quotes still work, and committed quotes
// that need that float are refused with a message saying what to set.
import { fileURLToPath } from "node:url";

import { ONECLICK_DEFAULT_URL, type Env } from "@pb/oneclick";

import type { EvmTokens, NearTokens } from "./assets.js";

export const DEFAULT_SHIM_URL = "http://localhost:8787";
export const TESTNET_NEAR_RPC = "https://test.rpc.fastnear.com";
export const TESTNET_HL_API = "https://api.hyperliquid-testnet.xyz";
/**
 * Stage 4 (INTERFACES.md 36): Base Sepolia, where Aave's test market is. The public RPC, the chain's id, and Aave's
 * faucet and data provider there (research/aave.md has the sources; the backend's defaults are the same).
 */
export const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
export const BASE_SEPOLIA_CHAIN_ID = 84_532;
export const AAVE_TESTNET_FAUCET = "0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc";
export const AAVE_TESTNET_DATA_PROVIDER = "0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b";
/** The chains the stand-in may sign on: test chains only, the list the backend and the keeper keep to. */
export const EVM_TEST_CHAINS: Record<number, string> = { 84532: "Base Sepolia", 11155111: "Sepolia", 421614: "Arbitrum Sepolia", 11155420: "OP Sepolia" };

export interface ShimConfig {
  host: string;
  port: number;
  /** The real 1Click, which prices every quote (dry, mapped to mainnet assets). */
  oneClickUrl: string;
  oneClickKey: string | undefined;
  nearRpcUrl: string;
  /**
   * The NEAR test tokens. INTERFACES.md 49 adds test ETH, wNEAR and USDT: their ids have defaults, and the stand-in
   * asks the chain whether each is deployed before it quotes it (near-tokens.ts).
   */
  tokens: Required<NearTokens>;
  near: { accountId: string; privateKey: string } | undefined;
  hlApiUrl: string;
  hl: { address: string; privateKey: string } | undefined;
  /**
   * Stage 4: the third chain. Its float is the gas wallet (EVM_GAS_PRIVATE_KEY), which the backend's gas helper uses
   * too. Its tokens are the factory's Aave settings', read from the chain at start.
   */
  evm: { rpcUrl: string; chainId: number; privateKey: string | undefined; faucet: string; dataProvider: string };
  factoryId: string;
  /** Guards the fault switch. Empty: the switch is off. */
  adminToken: string | undefined;
  /** Where the state is kept between runs. */
  stateFile: string;
  pollMs: number;
}

export function shimConfig(env: Env, overrides: Partial<ShimConfig> = {}): ShimConfig {
  const value = (name: string) => env[name]?.trim() || undefined;

  const network = value("NEAR_NETWORK") ?? "testnet";
  if (network !== "testnet") throw new Error(`The 1Click shim is for testnet only, but NEAR_NETWORK is ${network}`);

  const hlApiUrl = value("HL_API_URL") ?? TESTNET_HL_API;
  if (new URL(hlApiUrl).hostname === "api.hyperliquid.xyz") {
    throw new Error("HL_API_URL points at Hyperliquid mainnet; the shim only signs on testnet");
  }

  const shimUrl = new URL(value("SHIM_URL") ?? DEFAULT_SHIM_URL);
  const nearAccount = value("SHIM_NEAR_ACCOUNT_ID");
  const nearKey = value("SHIM_NEAR_PRIVATE_KEY");
  const hlAddress = value("HL_FLOAT_ADDRESS");
  const hlKey = value("HL_FLOAT_PRIVATE_KEY");
  const evmChainId = Number(value("EVM_CHAIN_ID") ?? BASE_SEPOLIA_CHAIN_ID);
  if (!(evmChainId in EVM_TEST_CHAINS)) {
    throw new Error(`EVM_CHAIN_ID ${value("EVM_CHAIN_ID")} isn't a test chain the stand-in knows (${Object.entries(EVM_TEST_CHAINS).map(([id, name]) => `${id} ${name}`).join(", ")}): its float signs on those only`);
  }
  const address = (name: string, fallback: string) => {
    const text = value(name) ?? fallback;
    if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new Error(`${name} is not a 0x address (0x and 40 hex digits)`);
    return text;
  };

  return {
    evm: {
      rpcUrl: (value("EVM_RPC_URL") ?? BASE_SEPOLIA_RPC).replace(/\/+$/, ""),
      chainId: evmChainId,
      privateKey: value("EVM_GAS_PRIVATE_KEY"),
      faucet: address("AAVE_FAUCET_ADDRESS", AAVE_TESTNET_FAUCET),
      dataProvider: address("AAVE_DATA_PROVIDER_ADDRESS", AAVE_TESTNET_DATA_PROVIDER),
    },
    factoryId: value("FACTORY_ACCOUNT_ID") ?? "pbf.testnet",
    host: "127.0.0.1",
    port: Number(shimUrl.port || 80),
    oneClickUrl: value("ONECLICK_API_URL") ?? ONECLICK_DEFAULT_URL,
    oneClickKey: value("ONECLICK_JWT"),
    nearRpcUrl: value("NEAR_RPC_URL") ?? TESTNET_NEAR_RPC,
    tokens: {
      musdc: value("MUSDC_TOKEN_ID") ?? "musdc.pbf-ops.testnet",
      mnbtc: value("MNBTC_TOKEN_ID") ?? "mnbtc.pbf-ops.testnet",
      meth: value("METH_TOKEN_ID") ?? "meth.pbf-ops.testnet",
      mwnear: value("MWNEAR_TOKEN_ID") ?? "mwnear.pbf-ops.testnet",
      musdt: value("MUSDT_TOKEN_ID") ?? "musdt.pbf-ops.testnet",
    },
    near: nearAccount && nearKey ? { accountId: nearAccount, privateKey: nearKey } : undefined,
    hlApiUrl,
    hl: hlAddress && hlKey ? { address: hlAddress, privateKey: hlKey } : undefined,
    adminToken: value("SHIM_ADMIN_TOKEN"),
    stateFile: fileURLToPath(new URL("../state/shim-state.json", import.meta.url)),
    pollMs: 3_000,
    ...overrides,
  };
}

/**
 * The Base Sepolia tokens the stand-in moves: the USDC and the WBTC and WETH collateral of the factory's Aave settings
 * (`get_config().lenders.aave`, INTERFACES.md 24). Null when the factory has none, or they are for another chain.
 */
export function evmTokensOf(factoryConfig: unknown, chainId: number): EvmTokens | null {
  const aave = (factoryConfig as { lenders?: { aave?: { chain_id?: unknown; usdc?: { address?: unknown }; collateral?: unknown } | null } | null } | null)?.lenders?.aave;
  const isAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
  if (!aave || aave.chain_id !== chainId || !isAddress(aave.usdc?.address)) return null;
  const collateral = (Array.isArray(aave.collateral) ? aave.collateral : []) as { symbol?: unknown; address?: unknown }[];
  const bySymbol = (symbol: string) => collateral.find((t) => t?.symbol === symbol && isAddress(t.address))?.address as string | undefined;
  const [wbtc, weth] = [bySymbol("WBTC"), bySymbol("WETH")];
  return { usdc: aave.usdc.address, ...(wbtc ? { wbtc } : {}), ...(weth ? { weth } : {}) };
}

/** Only the host of a URL, for logs: an RPC URL can carry a key in its path or query. */
export function hostOf(url: string): string {
  return new URL(url).host;
}
