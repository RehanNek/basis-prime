// The gate scripts' world (hedge-demo, drill-demo, fault-run): NEAR, the backend, Hyperliquid testnet's info API, the
// float tools and the keeper's signer, built from the repo's .env. The keys are loaded here and never printed.
// Testnet only: each check below refuses anything else.
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
import { AccountDoesNotExistError } from "near-api-js/rpc-errors";

import { API_SLACK_MS, backendWaitMs } from "./config.js";
import { signAuth, type GateCoin } from "./hedge-kit.js";
import type { World } from "./hedge-steps.js";
import { nearCaller, type NearCall } from "./near-tx.js";
import { backendFetch, serviceTokenFile } from "./service-token.js";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const TESTNET_HL_API = "https://api.hyperliquid-testnet.xyz";
export const FACTORY = "pbf.testnet";

export const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

export interface GateSettings {
  /** The client account: <name>.pbf.testnet. */
  name: string;
  account: string;
  apiUrl: string;
  /**
   * How long a call to the backend may take: as long as the backend may wait for a run that sits in OutLayer's
   * queue (config.ts, backendWaitMs: OUTLAYER_WAIT_MS or the backend's 270 s, and at least the 280 s it gives an
   * order at the longest), plus 30 s for its own reads around the run. 310 s unless set (210 s before INTERFACES.md
   * 50.4): a gate never gives up on an order before its life is over.
   */
  apiWaitMs: number;
  hlApi: string;
  rpcUrl: string;
  /** The keeper, which owns the gate's client accounts. */
  owner: string;
  hlFloat: string;
  musdc: string;
  mnbtc: string;
  shimUrl: string;
  dryRun: boolean;
  /** Read from .env; empty in a dry run. Only nearCaller and the NEP-413 signer see them. */
  keys: { keeper?: string; operator?: string };
  operator: string;
  drillId: string;
  outlayerApi: string;
  env(key: string): string | undefined;
}

/** Loads the repo's .env and checks it is testnet's. `fail` stops the script with a message. */
export function gateSettings(tool: string, name: string, dryRun: boolean, fail: (message: string) => never): GateSettings {
  if (!/^([a-z\d]+[-_])*[a-z\d]+$/.test(name)) fail(`--name ${name} isn't one part of a NEAR account id`);
  // PB_ENV_FILE names another settings file, or "none": the documented testnet defaults and no keys, which is all a
  // dry run needs.
  const envFile = process.env.PB_ENV_FILE?.trim() || `${ROOT}.env`;
  if (envFile !== "none" && existsSync(envFile)) process.loadEnvFile(envFile);
  const env = (key: string) => process.env[key]?.trim() || undefined;
  if ((env("NEAR_NETWORK") ?? "testnet") !== "testnet") fail(`NEAR_NETWORK isn't testnet: ${tool} runs on testnet only`);
  const hlApi = (env("HL_API_URL") ?? TESTNET_HL_API).replace(/\/+$/, "");
  if (!new URL(hlApi).hostname.includes("testnet")) fail(`HL_API_URL (${hlApi}) isn't Hyperliquid testnet's`);
  const keeper = env("KEEPER_PRIVATE_KEY");
  if (!keeper && !dryRun) fail("KEEPER_PRIVATE_KEY is empty in .env");
  let runWaitMs: number;
  try {
    runWaitMs = backendWaitMs(process.env);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  return {
    name,
    account: `${name}.${FACTORY}`,
    apiUrl: (env("API_URL") ?? "http://localhost:8788").replace(/\/+$/, ""),
    apiWaitMs: runWaitMs + API_SLACK_MS,
    hlApi,
    rpcUrl: env("NEAR_RPC_URL") ?? "https://test.rpc.fastnear.com",
    owner: env("KEEPER_ACCOUNT_ID") ?? "pbf-keeper.testnet",
    hlFloat: (env("HL_FLOAT_ADDRESS") ?? "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d").toLowerCase(),
    musdc: env("MUSDC_TOKEN_ID") ?? "musdc.pbf-ops.testnet",
    mnbtc: env("MNBTC_TOKEN_ID") ?? "mnbtc.pbf-ops.testnet",
    shimUrl: (env("SHIM_URL") ?? "http://localhost:8787").replace(/\/+$/, ""),
    dryRun,
    keys: { ...(keeper && !dryRun ? { keeper } : {}), ...(env("OPERATOR_PRIVATE_KEY") && !dryRun ? { operator: env("OPERATOR_PRIVATE_KEY")! } : {}) },
    operator: env("OPERATOR_ACCOUNT_ID") ?? "pbf-ops.testnet",
    drillId: env("DRILL_ACCOUNT_ID") ?? "drill.pbf-ops.testnet",
    outlayerApi: (env("OUTLAYER_API_URL") ?? "https://testnet-api.outlayer.ai").replace(/\/+$/, ""),
    env,
  };
}

/**
 * One JSON call. `fetchImpl` is plain `fetch` unless the call is to our own backend, which gets the fetch that adds
 * the service token (service-token.ts; INTERFACES.md 48.7). Hyperliquid and the stand-in never get that one.
 */
export async function http(method: "GET" | "POST", url: string, body: unknown, timeoutMs: number, headers: Record<string, string> = {}, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // a plain-text answer stays text
  }
  return { status: response.status, body: parsed };
}

/** Runs one of the float tools (services/oneclick-shim/dist), built once at the start. */
function floatTool(tool: "float-order" | "float-cancel" | "float-close", args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`services/oneclick-shim/dist/${tool}.js`, ...args], { cwd: ROOT, env: process.env });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${tool} failed (exit ${code}): ${out.trim().split("\n").slice(-2).join(" | ")}`));
    });
  });
}

/** Builds the float tools (and their workspace dependency) once, with the pnpm next to this Node (.nvmrc). */
export function buildFloatTools() {
  execFileSync("pnpm", ["--filter", "@pb/oneclick-shim...", "build"], { cwd: ROOT, stdio: "ignore", env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` } });
}

export interface Gear {
  world: World;
  provider: JsonRpcProvider;
  /** Signs as the keeper (the client account's owner), or null in a dry run. */
  keeperCall: NearCall | null;
  /** Signs as the operator, or null when its key is missing or in a dry run. */
  operatorCall: NearCall | null;
}

export function gateGear(s: GateSettings, coin?: GateCoin): Gear {
  // INTERFACES.md 51.1: the float trades the gate's coin. BTC unless the gate says another.
  const floatCoin = coin?.coin ?? "BTC";
  const provider = new JsonRpcProvider({ url: s.rpcUrl });
  const keeperCall = s.keys.keeper ? nearCaller(provider, s.owner, s.keys.keeper) : null;
  const operatorCall = s.keys.operator ? nearCaller(provider, s.operator, s.keys.operator) : null;
  const signer = s.keys.keeper ? KeyPairSigner.fromSecretKey(s.keys.keeper as KeyPairString) : null;
  // Privacy level 1 (INTERFACES.md 48.7): every call to the backend carries its service token, when its file is there.
  const toBackend = backendFetch(serviceTokenFile(s.env("SERVICE_TOKEN_FILE")));
  const world: World = {
    account: s.account,
    owner: s.owner,
    ids: { factory: FACTORY, pool: `pool.${FACTORY}`, musdc: s.musdc, mnbtc: s.mnbtc, mpc: "v1.signer-prod.testnet", hlFloat: s.hlFloat },
    near: {
      call: async (contract, method, args, options) => {
        if (!keeperCall) throw new Error("no signing key: a dry run sends nothing");
        return keeperCall(contract, method, args, options);
      },
      view: async <T>(contract: string, method: string, args: Record<string, unknown> = {}) =>
        (await provider.callFunction({ contractId: contract, method, args, blockQuery: { finality: "final" } })) as T,
      exists: async (id: string) => {
        try {
          await provider.viewAccount({ accountId: id, blockQuery: { finality: "final" } });
          return true;
        } catch (error) {
          if (error instanceof AccountDoesNotExistError) return false;
          throw error;
        }
      },
      finalBlockMs: async () => Number(BigInt((await provider.viewBlock({ finality: "final" })).header.timestamp_nanosec) / 1_000_000n),
    },
    api: {
      get: (path) => http("GET", `${s.apiUrl}${path}`, undefined, 30_000, {}, toBackend),
      // The backend waits for a run through its time in OutLayer's queue; the script waits a little longer than it.
      post: (path, body, timeoutMs = s.apiWaitMs) => http("POST", `${s.apiUrl}${path}`, body, timeoutMs, {}, toBackend),
    },
    hl: {
      info: async <T>(body: Record<string, unknown>) => {
        const { status, body: answer } = await http("POST", `${s.hlApi}/info`, body, 15_000);
        if (status !== 200) throw new Error(`Hyperliquid's ${String(body.type)} answered HTTP ${status}`);
        return answer as T;
      },
    },
    float: {
      order: async ({ side, sz, px, tif }) => {
        const text = await floatTool("float-order", ["--coin", floatCoin, "--side", side, "--size", sz, "--price", px, "--tif", tif, "--yes"]);
        const oid = /resting, oid (\d+)/.exec(text)?.[1];
        return { oid: oid ? Number(oid) : null, text: text.trim().split("\n").filter((l) => l.includes("Hyperliquid:")).join("; ") };
      },
      cancel: (oid) => floatTool("float-cancel", oid === null ? ["--all", "--coin", floatCoin] : ["--coin", floatCoin, "--oid", String(oid)]),
      close: () => floatTool("float-close", ["--coin", floatCoin]),
    },
    sign: async (message) => {
      if (!signer) throw new Error("no signing key: a dry run signs nothing");
      return signAuth(signer, s.owner, message);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    log,
    ...(coin ? { coin } : {}),
  };
  return { world, provider, keeperCall, operatorCall };
}

/** The backend runs the gateway and talks to Hyperliquid testnet; the factory pins a gateway. */
export async function gatePreflight(world: World, apiUrl: string, fail: (message: string) => never) {
  const { status, body } = await world.api.get("/api/config").catch((error: unknown) => fail(`the backend at ${apiUrl} doesn't answer (${String(error)}): pnpm --filter @pb/api start`));
  const config = body as { gateway_enabled?: boolean; hl_api?: string };
  if (status !== 200 || !config.gateway_enabled) fail(`the backend at ${apiUrl} can't run the gateway (gateway_enabled is ${String(config.gateway_enabled)}): set OUTLAYER_PAYMENT_KEY`);
  if (!config.hl_api?.includes("testnet")) fail(`the backend talks to ${config.hl_api}, not Hyperliquid testnet`);
  const factory = await world.near.view<{ gateway?: { version_key?: string } }>(FACTORY, "get_config");
  if (!factory.gateway?.version_key) fail("the factory pins no pb-gateway version yet");
}

/** An account's NEAR balance, in NEAR: create_account takes 5 of the keeper's, and each check 0.01 for OutLayer. */
export async function nearBalance(provider: JsonRpcProvider, accountId: string): Promise<number> {
  const view = await provider.viewAccount({ accountId, blockQuery: { finality: "final" } });
  return Number(BigInt(view.amount) / 10n ** 20n) / 1e4;
}

/** A byte of storage locks 10^19 yoctoNEAR of an account's balance. */
const STORAGE_PRICE_PER_BYTE = 10n ** 19n;

/**
 * What an account can spend, in NEAR: its balance less what its storage locks. Phase 6: the first `l_supply`
 * registers the client account at Rhea, which takes 0.1 NEAR of the account's own.
 */
export async function nearFree(provider: JsonRpcProvider, accountId: string): Promise<number> {
  const view = await provider.viewAccount({ accountId, blockQuery: { finality: "final" } });
  const free = BigInt(view.amount) - BigInt(view.storage_usage) * STORAGE_PRICE_PER_BYTE;
  return free > 0n ? Number(free / 10n ** 20n) / 1e4 : 0;
}

/** The final block's height. */
export async function finalHeight(provider: JsonRpcProvider): Promise<number> {
  return (await provider.viewBlock({ finality: "final" })).header.height;
}
