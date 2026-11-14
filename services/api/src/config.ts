// The backend's settings, from .env (see .env.example). Every id defaults to the testnet id in
// INTERFACES.md 1, so an empty variable means "the documented one".
import { fileURLToPath } from "node:url";

import type { Env } from "@pb/oneclick";

import { DEFAULT_OUTLAYER_WAIT_MS } from "./outlayer.js";
import { isAccountId, isPrimeAccount } from "./validate.js";

export const DEFAULT_API_URL = "http://localhost:8788";
export const TESTNET_NEAR_RPC = "https://test.rpc.fastnear.com";
/**
 * Phase 5 reads mainnet, and never signs or pays there (INTERFACES.md 18 and 22): Rhea's terms over this RPC, checked
 * live on 9 Nov (research/near.md 8 names FastNEAR's free RPC).
 */
export const MAINNET_NEAR_RPC = "https://free.rpc.fastnear.com";
/** Hyperliquid mainnet's info API, read only: today's BTC price for the credit check's worked example. */
export const MAINNET_HL_API = "https://api.hyperliquid.xyz";
/** 1Click's own host (research/intents.md; @pb/oneclick's ONECLICK_DEFAULT_URL). The Spot screen's token list is read here, with no key. */
export const MAINNET_ONECLICK_API = "https://1click.chaindefuser.com";
/** FastNEAR's transactions API for testnet (https://docs.fastnear.com/tx), behind GET /api/activity/:account. */
export const TESTNET_TX_INDEXER = "https://tx.test.fastnear.com";
export const TESTNET_OUTLAYER_API = "https://testnet-api.outlayer.ai";
/** INTERFACES.md 1. */
export const TESTNET_HL_API = "https://api.hyperliquid-testnet.xyz";
/** Hyperliquid testnet USDC's token string (INTERFACES.md 1; spotMeta, 8 Nov). */
export const HL_TESTNET_USDC_TOKEN = "USDC:0xeb62eee3685fc4c43992febcd9e75443";
/**
 * The stand-in's 1Click asset id for Hyperliquid testnet USDC (services/oneclick-shim/src/assets.ts). Like the
 * real 1Click's Hyperliquid USDC, it has 8 decimals (research/scripts/day1_oneclick_dry.py, from /v0/tokens).
 */
export const HL_TESTNET_USDC_ASSET = "1cs_v1:hypercore:hip1:0xeb62eee3685fc4c43992febcd9e75443";
/** The stand-in's Hyperliquid float (INTERFACES.md 1). Every Hyperliquid deposit to the stand-in goes here. */
export const HL_TESTNET_FLOAT = "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d";

/**
 * Phase 6 (INTERFACES.md 24; research/aave.md names the sources): Aave's test market on Base Sepolia. All public.
 * The pool and the data provider are in bgd-labs/aave-address-book (AaveV3BaseSepolia.sol); the faucet is in Aave's
 * interface repository. Chain id and data provider were confirmed by a live eth_call on 10 Nov.
 */
export const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
export const BASE_SEPOLIA_CHAIN_ID = 84_532;
export const AAVE_TESTNET_POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
export const AAVE_TESTNET_DATA_PROVIDER = "0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b";
export const AAVE_TESTNET_FAUCET = "0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc";

/**
 * The chains the backend starts on: test chains only (INTERFACES.md 30, "For stage 2 to settle", item 7), as it
 * already refuses a Hyperliquid API that isn't testnet's. Base Sepolia is where Aave's test market is; the other
 * three are the Sepolia test chains Aave also runs a test market on. Ids and names are from the public chain
 * registry (chainid.network, read 11 Nov).
 */
export const EVM_TEST_CHAINS: Record<number, string> = {
  84532: "Base Sepolia",
  11155111: "Ethereum Sepolia",
  421614: "Arbitrum Sepolia",
  11155420: "OP Sepolia",
};

/**
 * The mainnets Aave v3 has a market on, named so the refusal can say which one EVM_CHAIN_ID is (the same registry).
 * The guard doesn't rest on this list: every id that isn't a test chain above is refused, listed here or not.
 */
export const EVM_MAINNETS: Record<number, string> = {
  1: "Ethereum",
  10: "OP Mainnet",
  56: "BNB Smart Chain",
  100: "Gnosis",
  137: "Polygon",
  146: "Sonic",
  324: "zkSync",
  1088: "Metis Andromeda",
  1868: "Soneium",
  5000: "Mantle",
  8453: "Base",
  9745: "Plasma",
  42161: "Arbitrum One",
  42220: "Celo",
  43114: "Avalanche C-Chain",
  57073: "Ink",
  59144: "Linea",
  534352: "Scroll",
};

/**
 * Why the backend won't start on this chain, or null if it will. On Aave's chain the backend will send the accounts'
 * signed transactions and pay their gas from EVM_GAS_PRIVATE_KEY (stage 3), and the accounts' addresses there are the
 * ones they have on every Ethereum-style chain. Pointed at a mainnet, that would be real transactions with real money.
 */
export function evmChainProblem(chainId: number): string | null {
  if (chainId in EVM_TEST_CHAINS) return null;
  const tests = Object.entries(EVM_TEST_CHAINS).map(([id, name]) => `${id} ${name}`).join(", ");
  const mainnet = EVM_MAINNETS[chainId];
  if (mainnet) return `EVM_CHAIN_ID ${chainId} is ${mainnet}, a mainnet: the backend runs on test chains only (${tests}). There it will send the accounts' signed transactions and pay their gas, which on a mainnet is real money`;
  return `EVM_CHAIN_ID ${chainId} isn't a test chain the backend knows (${tests}): it starts on those only, so that it can never send a transaction on a mainnet`;
}

/** A token the accounts hold, named as in the factory's Config (INTERFACES.md 3). */
export interface TokenConfig {
  id: string;
  symbol: string;
  decimals: number;
}

/** INTERFACES.md 1: the ids every part shares. */
export interface Ids {
  network: "testnet";
  factory: string;
  pool: string;
  operator: string;
  keeper: string;
  tokens: TokenConfig[];
  drill: string;
  mpc: string;
  outlayer: string;
  /** pb-risk's OutLayer project, owned by the keeper: pbf-keeper.testnet/pb-risk. */
  riskProject: string;
  /** pb-gateway's OutLayer project (Phase 3): pbf-keeper.testnet/pb-gateway. */
  gatewayProject: string;
  /** The 1Click shim's NEAR float. */
  shimFloat: string | undefined;
  /** The shim's Hyperliquid float, lowercase. */
  hlFloat: string;
  /** Hyperliquid USDC: its token string on Hyperliquid, and its 1Click asset id (8 decimals). */
  hlUsdcToken: string;
  hlUsdcAsset: string;
}

export interface ApiConfig {
  /** The backend listens on localhost only, like the shim. */
  host: string;
  port: number;
  /** Phase 5: mainnet RPC, for reads only (Rhea's terms). */
  mainnetRpcUrl: string;
  /** Hyperliquid mainnet's API, for /info reads only. */
  hlMainnetApiUrl: string;
  /** 1Click's own host, read only: its token list and prices for the Spot screen (INTERFACES.md 49.3). ONECLICK_API_URL. */
  oneClickMainnetUrl: string;
  /** FastNEAR's testnet transactions API, for the activity page. */
  txIndexerUrl: string;
  /** FASTNEAR_API_KEY, optional: sent to the indexer as a bearer token and nowhere else. */
  fastnearApiKey: string | undefined;
  /** The keeper's book stress results (INTERFACES.md 19), JSON lines. */
  bookStressFile: string;
  nearRpcUrl: string;
  outlayerApiUrl: string;
  /** OUTLAYER_PAYMENT_KEY. It goes to OutLayer as X-Payment-Key and nowhere else: never logged, never answered. */
  outlayerPaymentKey: string | undefined;
  /**
   * OUTLAYER_WAIT_MS: how long one run may take from its submit to its end, its wait in OutLayer's queue included
   * (outlayer.ts). 270 s unless set (180 s before INTERFACES.md 50.4). Previews, credit checks, funding plans and
   * set-leverage wait this long at most. An order or a cancel waits this long, or to the end of its signed message's
   * life and 40 s more if that is longer (hl-handlers.ts, orderWaitMs).
   */
  outlayerWaitMs: number;
  /** Hyperliquid's API. Testnet only: anything else is refused at start. */
  hlApiUrl: string;
  ids: Ids;
  /** Phase 4: the stand-in's address, for its fault switch (SHIM_URL). */
  shimUrl: string | undefined;
  /** SHIM_ADMIN_TOKEN. It goes to the stand-in as a bearer token and nowhere else: never logged, never answered. */
  shimAdminToken: string | undefined;
  /** The keeper's JSON-lines log (KEEPER_LOG_FILE), read back for the Risk page. */
  keeperLogFile: string;

  // ---------- Phase 6 (INTERFACES.md 24 and 28) ----------
  /** EVM_RPC_URL and EVM_CHAIN_ID: the chain Aave's test market is on. Only a test chain is taken (EVM_TEST_CHAINS). */
  evmRpcUrl: string;
  evmChainId: number;
  /** AAVE_POOL_ADDRESS, AAVE_DATA_PROVIDER_ADDRESS and AAVE_FAUCET_ADDRESS on that chain. Public addresses. */
  aavePool: string;
  aaveDataProvider: string;
  aaveFaucet: string;
  /**
   * EVM_GAS_PRIVATE_KEY: pays gas for the accounts' signed Ethereum transactions from stage 3 (POST /api/evm/submit).
   * Nothing reads it in stage 1. Never logged, never answered.
   */
  evmGasPrivateKey: string | undefined;
  /** RHEA_ACCOUNT_ID: our Rhea copy on testnet (rhea.pbf-ops.testnet, from stage 2). Empty: no testnet Rhea row. */
  rheaAccountId: string | undefined;

  // ---------- Privacy level 1 (INTERFACES.md 48.1) ----------
  /**
   * ACCOUNT_PRIVACY. "owner" (the default): a client account is shown only to its owner's wallet, to the operator's
   * and the keeper's, and to our own services. "off": every route answers anyone, as before, and no token is asked
   * or made.
   */
  accountPrivacy: "owner" | "off";
  /** OPEN_ACCOUNTS: client accounts anyone may look at (demo accounts). Not secret. */
  openAccounts: string[];
  /** SERVICE_TOKEN_FILE: where the backend writes the token its own services send (mode 600). The file is the secret, not its path. */
  serviceTokenFile: string;
  /** INTERFACES.md 49.4: the keeper's own port on this machine (KEEPER_PORT, default 8789), where POST /check is. */
  keeperUrl: string;
}

/** The keeper writes its log here unless KEEPER_LOG_FILE says otherwise (services/keeper/src/config.ts). */
export const DEFAULT_KEEPER_LOG = fileURLToPath(new URL("../../keeper/logs/keeper.jsonl", import.meta.url));
/** The backend's service token goes here unless SERVICE_TOKEN_FILE says otherwise (git-ignored; the keeper package reads the same file). */
export const DEFAULT_SERVICE_TOKEN_FILE = fileURLToPath(new URL("../logs/service-token", import.meta.url));
/** And the daily book stress test's results here, unless BOOK_STRESS_LOG_FILE says otherwise. */
export const DEFAULT_BOOK_STRESS_LOG = fileURLToPath(new URL("../../keeper/logs/book-stress.jsonl", import.meta.url));

export function apiConfig(env: Env): ApiConfig {
  const value = (name: string) => env[name]?.trim() || undefined;
  const network = value("NEAR_NETWORK") ?? "testnet";
  if (network !== "testnet") {
    throw new Error(`The backend runs on testnet for now (NEAR_NETWORK is ${network}); the mainnet run needs a yes first (PLAN.md 12)`);
  }

  const account = (name: string, fallback: string): string => {
    const id = value(name) ?? fallback;
    if (!isAccountId(id)) throw new Error(`${name} is not a valid NEAR account id`);
    return id;
  };
  const keeper = account("KEEPER_ACCOUNT_ID", "pbf-keeper.testnet");
  const shimFloat = value("SHIM_NEAR_ACCOUNT_ID");

  // Phase 3 posts signed actions to Hyperliquid, so it must be testnet's API, as in the shim's float tools.
  const hlApiUrl = (value("HL_API_URL") ?? TESTNET_HL_API).replace(/\/+$/, "");
  if (!new URL(hlApiUrl).hostname.includes("testnet")) {
    throw new Error(`HL_API_URL must be Hyperliquid testnet's API (${TESTNET_HL_API}); the backend posts to Hyperliquid on testnet only`);
  }
  const hlFloat = (value("HL_FLOAT_ADDRESS") ?? HL_TESTNET_FLOAT).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(hlFloat)) throw new Error("HL_FLOAT_ADDRESS is not a 0x address");

  const apiUrl = new URL(value("API_URL") ?? DEFAULT_API_URL);
  const httpUrl = (name: string, fallback: string) => {
    const url = (value(name) ?? fallback).replace(/\/+$/, "");
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error(`${name} must be an http(s) URL`);
    return url;
  };
  const evmAddress = (name: string, fallback: string) => {
    const address = value(name) ?? fallback;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`${name} is not a 0x address (0x and 40 hex digits)`);
    return address;
  };
  const evmChainId = Number(value("EVM_CHAIN_ID") ?? BASE_SEPOLIA_CHAIN_ID);
  if (!Number.isSafeInteger(evmChainId) || evmChainId <= 0) throw new Error("EVM_CHAIN_ID must be a chain id, a whole number above 0 (Base Sepolia is 84532)");
  const chainProblem = evmChainProblem(evmChainId);
  if (chainProblem) throw new Error(chainProblem);
  const outlayerWaitMs = Number(value("OUTLAYER_WAIT_MS") ?? DEFAULT_OUTLAYER_WAIT_MS);
  if (!Number.isInteger(outlayerWaitMs) || outlayerWaitMs < 10_000 || outlayerWaitMs > 600_000) {
    throw new Error("OUTLAYER_WAIT_MS must be a whole number of milliseconds from 10000 to 600000 (the default, 270000, is 4 and a half minutes)");
  }
  const rheaAccountId = value("RHEA_ACCOUNT_ID");
  if (rheaAccountId !== undefined && !isAccountId(rheaAccountId)) throw new Error("RHEA_ACCOUNT_ID is not a valid NEAR account id");

  // Privacy level 1 (INTERFACES.md 48.1). A value we can't read stops the backend: a typo must never open every account.
  const keeperPort = Number(value("KEEPER_PORT") ?? 8789);
  if (!Number.isInteger(keeperPort) || keeperPort < 1 || keeperPort > 65_535) throw new Error("KEEPER_PORT must be a port number");
  const said: string = value("ACCOUNT_PRIVACY") ?? "owner";
  const privacy = said === "owner" || said === "off" ? said : null;
  if (privacy === null) {
    throw new Error(`ACCOUNT_PRIVACY must be "owner" (a client account shows only to its owner and to us; the default) or "off" (every account shows to anyone). It is "${said.slice(0, 40)}"`);
  }
  const factory = account("FACTORY_ACCOUNT_ID", "pbf.testnet");
  const openAccounts = (value("OPEN_ACCOUNTS") ?? "").split(",").map((id) => id.trim()).filter((id) => id !== "");
  const notOne = openAccounts.find((id): boolean => !isPrimeAccount(id, factory));
  if (notOne !== undefined) throw new Error(`OPEN_ACCOUNTS lists "${notOne.slice(0, 80)}", which isn't a client account: each must be <name>.${factory}, separated by commas`);

  return {
    evmRpcUrl: httpUrl("EVM_RPC_URL", BASE_SEPOLIA_RPC),
    evmChainId,
    aavePool: evmAddress("AAVE_POOL_ADDRESS", AAVE_TESTNET_POOL),
    aaveDataProvider: evmAddress("AAVE_DATA_PROVIDER_ADDRESS", AAVE_TESTNET_DATA_PROVIDER),
    aaveFaucet: evmAddress("AAVE_FAUCET_ADDRESS", AAVE_TESTNET_FAUCET),
    evmGasPrivateKey: value("EVM_GAS_PRIVATE_KEY"),
    rheaAccountId,
    accountPrivacy: privacy,
    openAccounts: [...new Set(openAccounts)],
    serviceTokenFile: value("SERVICE_TOKEN_FILE") ?? DEFAULT_SERVICE_TOKEN_FILE,
    keeperUrl: `http://127.0.0.1:${keeperPort}`,
    host: "127.0.0.1",
    port: Number(apiUrl.port || 80),
    mainnetRpcUrl: httpUrl("MAINNET_NEAR_RPC_URL", MAINNET_NEAR_RPC),
    hlMainnetApiUrl: httpUrl("HL_MAINNET_API_URL", MAINNET_HL_API),
    oneClickMainnetUrl: httpUrl("ONECLICK_API_URL", MAINNET_ONECLICK_API),
    txIndexerUrl: httpUrl("FASTNEAR_TX_URL", TESTNET_TX_INDEXER),
    fastnearApiKey: value("FASTNEAR_API_KEY"),
    bookStressFile: value("BOOK_STRESS_LOG_FILE") ?? DEFAULT_BOOK_STRESS_LOG,
    nearRpcUrl: value("NEAR_RPC_URL") ?? TESTNET_NEAR_RPC,
    outlayerApiUrl: (value("OUTLAYER_API_URL") ?? TESTNET_OUTLAYER_API).replace(/\/+$/, ""),
    outlayerPaymentKey: value("OUTLAYER_PAYMENT_KEY"),
    outlayerWaitMs,
    hlApiUrl,
    shimUrl: value("SHIM_URL")?.replace(/\/+$/, ""),
    shimAdminToken: value("SHIM_ADMIN_TOKEN"),
    keeperLogFile: value("KEEPER_LOG_FILE") ?? DEFAULT_KEEPER_LOG,
    ids: {
      network,
      factory,
      pool: account("POOL_ACCOUNT_ID", "pool.pbf.testnet"),
      operator: account("OPERATOR_ACCOUNT_ID", "pbf-ops.testnet"),
      keeper,
      tokens: [
        { id: account("MUSDC_TOKEN_ID", "musdc.pbf-ops.testnet"), symbol: "USDC", decimals: 6 },
        { id: account("MNBTC_TOKEN_ID", "mnbtc.pbf-ops.testnet"), symbol: "nBTC", decimals: 8 },
      ],
      drill: account("DRILL_ACCOUNT_ID", "drill.pbf-ops.testnet"),
      mpc: "v1.signer-prod.testnet",
      outlayer: "outlayer.testnet",
      riskProject: `${keeper}/pb-risk`,
      gatewayProject: `${keeper}/pb-gateway`,
      shimFloat: shimFloat && isAccountId(shimFloat) ? shimFloat : undefined,
      hlFloat,
      hlUsdcToken: HL_TESTNET_USDC_TOKEN,
      hlUsdcAsset: HL_TESTNET_USDC_ASSET,
    },
  };
}

/** Only the host of a URL, for logs: an RPC URL can carry a key in its path or query. */
export function hostOf(url: string): string {
  return new URL(url).host;
}
