// The keeper's settings, from .env (see .env.example) and the command line.
//   --once            run one tick and exit
//   --account <id>    watch this client account only (repeatable). Without it, the factory's list_accounts.
//   --newest <n>      watch only the n accounts the factory made last (1 to 100). A gate run and a click-through each
//                     make a new account, so `--newest 1` follows whichever is under way with no name to give. Not
//                     with --account.
//   --dry-run         read and decide, log what it would do, and send nothing (no transaction, no gateway run, no post)
//
// Phase 6, stage 2: RHEA_ACCOUNT_ID turns on the job that keeps our Rhea copy's BTC price in step with Hyperliquid's
// oracle. It signs as the copy's owner (OPERATOR_ACCOUNT_ID, OPERATOR_PRIVATE_KEY).
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { DEFAULT_OUTLAYER_WAIT_MS } from "./outlayer.js";
import { serviceTokenFile } from "./service-token.js";

export type Env = Record<string, string | undefined>;

export const TESTNET_NEAR_RPC = "https://test.rpc.fastnear.com";
export const TESTNET_HL_API = "https://api.hyperliquid-testnet.xyz";
export const TESTNET_OUTLAYER_API = "https://testnet-api.outlayer.ai";
/** Stage 3: Aave's test market is on Base Sepolia (research/aave.md): its public RPC and chain id. */
export const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
export const BASE_SEPOLIA_CHAIN_ID = 84_532;
/**
 * The chains the keeper may send the accounts' signed Ethereum transactions on: test chains only, the same list the
 * backend starts on (services/api/src/config.ts, each id checked there against the chain's own RPC). An account's
 * address is the same on every Ethereum-style chain, so a mainnet here would be real transactions.
 */
export const EVM_TEST_CHAINS: Record<number, string> = { 84532: "Base Sepolia", 11155111: "Sepolia", 421614: "Arbitrum Sepolia", 11155420: "OP Sepolia" };
/** The backend, which sends the signed transactions first (POST /api/evm/submit); the keeper is the backup. */
export const DEFAULT_API_URL = "http://localhost:8788";
/** PLAN.md 5.7: every 15 s, for each account. */
export const TICK_MS = 15_000;
/** The keeper's status page, on localhost (.claude/launch.json's `keeper`). */
export const DEFAULT_STATUS_PORT = 8789;
/** The keeper's JSON-lines log, next to its code unless KEEPER_LOG_FILE says otherwise. */
export const DEFAULT_LOG_FILE = fileURLToPath(new URL("../logs/keeper.jsonl", import.meta.url));
/** The daily book stress test's results (INTERFACES.md 19), unless BOOK_STRESS_LOG_FILE says otherwise. */
export const DEFAULT_STRESS_FILE = fileURLToPath(new URL("../logs/book-stress.jsonl", import.meta.url));
/** Phase 6: the file that puts our Rhea copy's BTC price on hold (rhea-price.ts), unless RHEA_PRICE_HOLD_FILE says otherwise. */
export const DEFAULT_RHEA_HOLD_FILE = fileURLToPath(new URL("../logs/rhea-price-hold.json", import.meta.url));

/**
 * OUTLAYER_WAIT_MS: how long one OutLayer run may take from its submit to its end, its wait in OutLayer's queue
 * included (outlayer.ts): 180 s unless set. The keeper's own gateway runs wait this long. They carry no signed
 * message and no expiry, and a tick waits for them, so this default stays where it was when the backend's went to
 * 270 s (INTERFACES.md 50.4). The gate scripts' calls to the backend wait by `backendWaitMs` below.
 */
export function outlayerWaitMs(env: Env): number {
  const ms = Number(env.OUTLAYER_WAIT_MS?.trim() || DEFAULT_OUTLAYER_WAIT_MS);
  if (!Number.isInteger(ms) || ms < 10_000 || ms > 600_000) throw new Error("OUTLAYER_WAIT_MS must be a whole number of milliseconds from 10000 to 600000 (the default, 180000, is 3 minutes)");
  return ms;
}
export const API_SLACK_MS = 30_000;

/** The backend's own default for OUTLAYER_WAIT_MS since INTERFACES.md 50.4 (services/api/src/outlayer.ts): 270 s. */
export const BACKEND_OUTLAYER_WAIT_MS = 270_000;
/**
 * The longest the backend waits for one order's or cancel's run, whatever OUTLAYER_WAIT_MS says: the longest life a
 * gateway takes (240 s on testnet) and 40 s more (services/api/src/hl-handlers.ts, orderWaitMs).
 */
export const BACKEND_ORDER_WAIT_MAX_MS = 280_000;

/**
 * How long the backend may take over one run, as a gate script must reckon it: OUTLAYER_WAIT_MS where it is set
 * (the backend reads the same setting), else the backend's default, and never less than its longest wait for an
 * order. A gate waits this long and `API_SLACK_MS` more for an answer, so it never gives up on an order before the
 * backend does (INTERFACES.md 50.4).
 */
export function backendWaitMs(env: Env): number {
  const set = env.OUTLAYER_WAIT_MS?.trim() ? outlayerWaitMs(env) : BACKEND_OUTLAYER_WAIT_MS;
  return Math.max(set, BACKEND_ORDER_WAIT_MAX_MS);
}
/**
 * A check on the chain (request_check, request_agent) rides the same queue: the account asks OutLayer, and the
 * verdict comes back in a later block. A gate script gives one this long to arrive before it calls it lost.
 */
export const VERDICT_WAIT_MS = 240_000;
/**
 * A keeper that ticked this recently is running. Its ticks start 15 s apart, but one waits for whatever it sent: a
 * check or a gateway run that sits in OutLayer's queue holds the tick for up to OUTLAYER_WAIT_MS.
 */
export const KEEPER_ALIVE_MS = 240_000;

export interface KeeperConfig {
  nearRpcUrl: string;
  hlApiUrl: string;
  outlayerApiUrl: string;
  /** OUTLAYER_WAIT_MS: how long a gateway run may take, its wait in OutLayer's queue included. */
  outlayerWaitMs: number;
  keeperId: string;
  /** Whether KEEPER_PRIVATE_KEY is set. The key itself is read once, in index.ts, and never logged. */
  hasKeeperKey: boolean;
  /** Whether OUTLAYER_PAYMENT_KEY is set: without it the gateway's modes can't run. */
  hasPaymentKey: boolean;
  factoryId: string;
  poolId: string | undefined;
  drillId: string;
  /** pb-gateway's OutLayer project: <keeper>/pb-gateway. */
  gatewayProject: string;
  accounts: string[];
  /** --newest: watch only this many of the factory's accounts, the ones it made last. Undefined: all of them. */
  newest: number | undefined;
  once: boolean;
  dryRun: boolean;
  tickMs: number;
  logFile: string;
  /** Phase 5: the book stress test's results, one JSON line per run (the backend reads them back). */
  stressFile: string;
  statusPort: number;

  // ---------- Phase 6, stage 2 (INTERFACES.md 28; FUNDING.md 7.1) ----------
  /** RHEA_ACCOUNT_ID: our Rhea copy on testnet, whose BTC price the keeper keeps in step. Empty: that job is off. */
  rheaId: string | undefined;
  /** The copy's owner, which signs its price changes: the operator. Its key (OPERATOR_PRIVATE_KEY) is read in index.ts. */
  operatorId: string;
  hasOperatorKey: boolean;
  /** Test nBTC, the token whose price at the copy is kept. */
  nbtcId: string;
  /** The file that puts the copy's BTC price on hold: a small JSON file the gate script sets and clears. */
  rheaHoldFile: string;

  // ---------- Stage 3 (INTERFACES.md 33) ----------
  /** EVM_RPC_URL and EVM_CHAIN_ID: Aave's chain, a test chain only. */
  evmRpcUrl: string;
  evmChainId: number;
  /** API_URL: the backend, whose POST /api/evm/submit sends a signed transaction before the keeper's own send. */
  apiUrl: string;
  /** SERVICE_TOKEN_FILE: where the backend writes the token its own services send (INTERFACES.md 48.7; service-token.ts). */
  serviceTokenFile: string;
}

export function keeperConfig(env: Env, argv: string[]): KeeperConfig {
  const value = (name: string) => env[name]?.trim() || undefined;
  const network = value("NEAR_NETWORK") ?? "testnet";
  if (network !== "testnet") {
    throw new Error(`The keeper runs on testnet for now (NEAR_NETWORK is ${network}); the mainnet run needs a yes first (PLAN.md 12)`);
  }
  const hlApiUrl = value("HL_API_URL") ?? TESTNET_HL_API;
  if (new URL(hlApiUrl).hostname === "api.hyperliquid.xyz") throw new Error("HL_API_URL points at Hyperliquid mainnet; the keeper is on testnet");
  // Phase 3: the keeper posts signed actions to /exchange (hl-post.ts), so anything but testnet's API is refused.
  if (!new URL(hlApiUrl).hostname.includes("testnet")) throw new Error(`HL_API_URL must be Hyperliquid testnet's API (${TESTNET_HL_API})`);

  const { values } = parseArgs({
    args: argv[0] === "--" ? argv.slice(1) : argv, // `pnpm start -- --once` passes the "--" on
    options: {
      once: { type: "boolean", default: false },
      account: { type: "string", multiple: true, default: [] },
      newest: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const newest = values.newest === undefined ? undefined : Number(values.newest);
  if (newest !== undefined && !(Number.isInteger(newest) && newest >= 1 && newest <= 100)) throw new Error("--newest takes a whole number from 1 to 100: how many of the factory's newest accounts to watch");
  if (newest !== undefined && values.account.length > 0) throw new Error("give --account or --newest, not both");
  const keeperId = value("KEEPER_ACCOUNT_ID") ?? "pbf-keeper.testnet";
  const port = Number(value("KEEPER_PORT") ?? DEFAULT_STATUS_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("KEEPER_PORT must be a port number");
  // Phase 6: the keeper changes a price at this contract, signing as its owner. It must be our own copy on testnet:
  // Rhea itself (contract.main.burrow.near) is never written to.
  const rheaId = value("RHEA_ACCOUNT_ID");
  if (rheaId !== undefined && !/^([a-z\d]+[-_.])*[a-z\d]+\.testnet$/.test(rheaId)) {
    throw new Error("RHEA_ACCOUNT_ID must be our Rhea copy on testnet (rhea.pbf-ops.testnet): the keeper sets its BTC price, and never touches Rhea itself");
  }
  const evmChainId = Number(value("EVM_CHAIN_ID") ?? BASE_SEPOLIA_CHAIN_ID);
  if (!(evmChainId in EVM_TEST_CHAINS)) {
    throw new Error(`EVM_CHAIN_ID ${value("EVM_CHAIN_ID")} isn't a test chain the keeper knows (${Object.entries(EVM_TEST_CHAINS).map(([id, name]) => `${id} ${name}`).join(", ")}): it sends the accounts' signed transactions on those only`);
  }
  const evmRpcUrl = (value("EVM_RPC_URL") ?? BASE_SEPOLIA_RPC).replace(/\/+$/, "");
  if (!/^https?:$/.test(new URL(evmRpcUrl).protocol)) throw new Error("EVM_RPC_URL must be an http(s) URL");
  return {
    evmRpcUrl,
    evmChainId,
    apiUrl: (value("API_URL") ?? DEFAULT_API_URL).replace(/\/+$/, ""),
    serviceTokenFile: serviceTokenFile(value("SERVICE_TOKEN_FILE")),
    rheaId,
    operatorId: value("OPERATOR_ACCOUNT_ID") ?? "pbf-ops.testnet",
    hasOperatorKey: Boolean(value("OPERATOR_PRIVATE_KEY")),
    nbtcId: value("MNBTC_TOKEN_ID") ?? "mnbtc.pbf-ops.testnet",
    rheaHoldFile: value("RHEA_PRICE_HOLD_FILE") ?? DEFAULT_RHEA_HOLD_FILE,
    nearRpcUrl: value("NEAR_RPC_URL") ?? TESTNET_NEAR_RPC,
    hlApiUrl,
    outlayerApiUrl: (value("OUTLAYER_API_URL") ?? TESTNET_OUTLAYER_API).replace(/\/+$/, ""),
    outlayerWaitMs: outlayerWaitMs(env),
    keeperId,
    hasKeeperKey: Boolean(value("KEEPER_PRIVATE_KEY")),
    hasPaymentKey: Boolean(value("OUTLAYER_PAYMENT_KEY")),
    factoryId: value("FACTORY_ACCOUNT_ID") ?? "pbf.testnet",
    poolId: value("POOL_ACCOUNT_ID"),
    drillId: value("DRILL_ACCOUNT_ID") ?? "drill.pbf-ops.testnet",
    gatewayProject: `${keeperId}/pb-gateway`,
    accounts: values.account,
    newest,
    once: values.once,
    dryRun: values["dry-run"],
    tickMs: TICK_MS,
    logFile: value("KEEPER_LOG_FILE") ?? DEFAULT_LOG_FILE,
    stressFile: value("BOOK_STRESS_LOG_FILE") ?? DEFAULT_STRESS_FILE,
    statusPort: port,
  };
}

/** Only the host of a URL, for logs: an RPC URL can carry a key in its path or query. */
export function hostOf(url: string): string {
  return new URL(url).host;
}
