// The shim's HTTP API: 1Click's four endpoints, plus the fault switch.
//
//   GET  /v0/tokens          the test assets, priced as their mainnet twins
//   POST /v0/quote           dry: the real 1Click's price for the mainnet twins. Real: that price,
//                            plus a deposit address the shim watches. Stage 4: a quote to or from Base
//                            Sepolia is one of four routes (evm-routes.ts; six since section 51.2, with
//                            test ETH to WETH and back), refused in words if the float couldn't fill it. Section 49: test ETH, wNEAR and USDT on NEAR are
//                            refused in words until their contracts are deployed (near-tokens.ts), and
//                            a swap that touches one is priced from 1Click's token list when 1Click
//                            gives no quote for it (near-routes.ts)
//   POST /v0/deposit/submit  report a deposit transaction
//   GET  /v0/status          ?depositAddress=...&depositMemo=...
//   GET|POST /admin/fault    the fault switch; needs "Authorization: Bearer <SHIM_ADMIN_TOKEN>".
//                            Body {"mode":"none"|"refund"|"fail"|"late","delaySeconds"?:600}
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { OneClickError, type OneClickClient, type QuoteRequest, type QuoteResponse, type ShimNote, type TokenInfo } from "@pb/oneclick";

import { chainName, isValidAddress, mainnetPlaceholder, type ShimAsset } from "./assets.js";
import { DEFAULT_DEADLINE_MS, type Engine } from "./engine.js";
import type { EvmFloat } from "./evm-float.js";
import { evmRoute, priceEvmRoute, RouteRefused } from "./evm-routes.js";
import { listPriceCovers, listPriceQuote } from "./near-routes.js";
import type { DeployProbe } from "./near-tokens.js";
import { DEFAULT_LATE_SECONDS, type FaultMode } from "./state.js";

export interface ShimServerDeps {
  engine: Engine;
  /** The real 1Click. */
  upstream: OneClickClient;
  assets: ShimAsset[];
  floats: { near: boolean; hl: boolean; evm?: boolean };
  /** Stage 4: the float on Base Sepolia, for what a quote needs to know of it (Aave's room for WBTC, what it holds). */
  evm?: EvmFloat;
  /**
   * Section 49: why one of the three new NEAR test tokens can't be quoted yet (it isn't deployed), or null. Left
   * out, every asset in `assets` counts as deployed.
   */
  deployed?: DeployProbe;
  adminToken: string | undefined;
  now?: () => number;
  log?: (line: string) => void;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createShimServer(deps: ShimServerDeps): Server {
  return createServer((request, response) => {
    route(deps, request)
      .then(({ status, body }) => send(response, status, body))
      .catch((error: unknown) => {
        if (error instanceof HttpError) return send(response, error.status, { message: error.message });
        if (error instanceof OneClickError) return send(response, error.status, error.body); // 1Click's own answer
        deps.log?.(`error: ${error instanceof Error ? error.message : String(error)}`);
        return send(response, 502, { message: error instanceof Error ? error.message : String(error) });
      });
  });
}

async function route(deps: ShimServerDeps, request: IncomingMessage): Promise<{ status: number; body: unknown }> {
  const url = new URL(request.url ?? "/", "http://shim");
  const path = `${request.method} ${url.pathname}`;
  switch (path) {
    case "GET /v0/tokens":
      return { status: 200, body: await tokens(deps) };
    case "POST /v0/quote":
      return { status: 201, body: await quote(deps, await readJson(request)) };
    case "POST /v0/deposit/submit":
      return { status: 200, body: await submit(deps, await readJson(request)) };
    case "GET /v0/status": {
      const swap = deps.engine.find(url.searchParams.get("depositAddress") ?? "", url.searchParams.get("depositMemo"));
      if (!swap) throw new HttpError(404, "Unknown deposit address (and memo)");
      return { status: 200, body: deps.engine.statusOf(swap) };
    }
    case "GET /admin/fault":
      checkAdmin(deps, request);
      return { status: 200, body: { fault: deps.engine.fault } };
    case "POST /admin/fault":
      checkAdmin(deps, request);
      return { status: 200, body: { fault: setFault(deps, await readJson(request)) } };
    default:
      throw new HttpError(404, `No route for ${path}`);
  }
}

/**
 * The test assets, with the display price of their mainnet twins (or 0 if 1Click can't be reached). Section 49's
 * tokens are listed once they are deployed, so the list never names a token no quote would take.
 */
async function tokens(deps: ShimServerDeps): Promise<TokenInfo[]> {
  let real: TokenInfo[] = [];
  try {
    real = await deps.upstream.tokens();
  } catch (error) {
    deps.log?.(`tokens: 1Click unreachable, serving without prices (${error instanceof Error ? error.message : error})`);
  }
  const listed: ShimAsset[] = [];
  for (const asset of deps.assets) {
    if ((await notDeployed(deps, asset).catch(() => "the chain couldn't be asked")) === null) listed.push(asset);
  }
  return listed.map((asset) => {
    const twin = real.find((t) => t.assetId === asset.mainnetAssetId);
    return {
      assetId: asset.assetId,
      decimals: asset.decimals,
      blockchain: twin?.blockchain ?? (asset.chain === "near" ? "near" : asset.chain === "hl" ? "hypercore" : "base"),
      symbol: asset.symbol,
      price: twin?.price ?? 0,
      priceUpdatedAt: twin?.priceUpdatedAt ?? new Date(0).toISOString(),
      contractAddress: asset.contract,
    };
  });
}

/** Why this asset can't be quoted yet, or null. Only section 49's tokens are ever asked about. */
async function notDeployed(deps: ShimServerDeps, asset: ShimAsset): Promise<string | null> {
  return asset.checkDeployed && deps.deployed ? deps.deployed(asset) : null;
}

async function quote(deps: ShimServerDeps, body: unknown) {
  const request = checkQuote(deps, body);
  const origin = deps.assets.find((a) => a.assetId === request.originAsset)!;
  const destination = deps.assets.find((a) => a.assetId === request.destinationAsset)!;

  // Section 49: a token that isn't deployed yet is refused, dry or not, before anything is priced.
  for (const asset of [origin, destination]) {
    let why: string | null;
    try {
      why = await notDeployed(deps, asset);
    } catch (error) {
      throw new HttpError(502, `The stand-in couldn't ask NEAR testnet whether ${asset.contract} (test ${asset.symbol}) is deployed: ${error instanceof Error ? error.message : String(error)}. Try again`);
    }
    if (why) throw new HttpError(400, why);
  }

  // Stage 4: a route to or from Base Sepolia has its own pricing, and may deliver WETH where WBTC was asked for.
  try {
    const route = evmRoute(origin, destination);
    if (route) {
      const now = deps.now ?? Date.now;
      const out = await priceEvmRoute({ upstream: deps.upstream, assets: deps.assets, ...(deps.evm ? { evm: deps.evm } : {}), now, deadlineMs: DEFAULT_DEADLINE_MS }, request, origin, destination, route);
      if (request.dry) return { ...out.priced, signature: "", quoteRequest: out.request, ...(out.note ? { shim: out.note } : {}) };
      // A deposit on Base Sepolia is looked for from the block the quote is made in.
      const evmFromBlock = origin.chain === "evm" && deps.evm ? await deps.evm.blockNumber() : undefined;
      return deps.engine.openSwap(out.request, out.priced, { ...(evmFromBlock !== undefined ? { evmFromBlock } : {}), ...(out.note ? { note: out.note } : {}) });
    }
  } catch (error) {
    if (error instanceof RouteRefused) throw new HttpError(400, error.message);
    throw error;
  }

  // The real 1Click prices the mainnet twins. It only prices, so the parties are placeholders,
  // and the msg (which only matters for delivery) stays here.
  const { customRecipientMsg: _msg, ...rest } = request;
  let priced: QuoteResponse;
  let note: ShimNote | undefined;
  try {
    priced = await deps.upstream.quote({
      ...rest,
      dry: true,
      originAsset: origin.mainnetAssetId,
      destinationAsset: destination.mainnetAssetId,
      recipient: mainnetPlaceholder(destination.chain),
      refundTo: mainnetPlaceholder(origin.chain),
      deadline: request.deadline ?? new Date((deps.now ?? Date.now)() + DEFAULT_DEADLINE_MS).toISOString(),
    });
  } catch (error) {
    // Section 49: 1Click gave no quote for this pair or amount. A swap that touches one of the three new NEAR tokens
    // is then priced from 1Click's own token list, and the quote says so. Otherwise its refusal goes back as it came.
    const listed = error instanceof OneClickError && error.status === 400 && listPriceCovers(origin, destination) ? await priceFromList(deps, request, origin, destination, error) : null;
    if (!listed) throw error;
    ({ priced, note } = listed);
  }

  if (request.dry) return { ...priced, signature: "", quoteRequest: request, ...(note ? { shim: note } : {}) };
  return deps.engine.openSwap(request, priced, note ? { note } : {});
}

/** The quote at the token list's prices (near-routes.ts), or null when the list can't be read or lacks a price. */
async function priceFromList(deps: ShimServerDeps, request: QuoteRequest, origin: ShimAsset, destination: ShimAsset, refusal: OneClickError) {
  let list: TokenInfo[];
  try {
    list = await deps.upstream.tokens();
  } catch (error) {
    deps.log?.(`quote: 1Click gave no quote and its token list couldn't be read (${error instanceof Error ? error.message : String(error)}); passing its refusal on`);
    return null;
  }
  const body = refusal.body as { message?: unknown } | null;
  const said = typeof body?.message === "string" && body.message.trim() ? body.message.trim() : `HTTP ${refusal.status}`;
  try {
    const listed = listPriceQuote(request, origin, destination, list, said, (deps.now ?? Date.now)());
    if (listed) deps.log?.(`quote: ${origin.symbol} -> ${destination.symbol}, ${request.amount} units, priced from 1Click's token list (1Click said: ${said})`);
    return listed;
  } catch (error) {
    if (error instanceof RouteRefused) throw new HttpError(400, error.message);
    throw error;
  }
}

/** Checks a quote request against what the shim supports. Returns it typed, or throws a 400 or 503. */
function checkQuote(deps: ShimServerDeps, body: unknown): QuoteRequest {
  if (!body || typeof body !== "object") throw new HttpError(400, "The body must be a JSON object");
  const request = body as QuoteRequest;
  const known = deps.assets.map((a) => a.assetId).join(", ");
  const origin = deps.assets.find((a) => a.assetId === request.originAsset);
  const destination = deps.assets.find((a) => a.assetId === request.destinationAsset);

  if (typeof request.dry !== "boolean") throw new HttpError(400, "dry must be true or false");
  if (request.swapType !== "EXACT_INPUT") throw new HttpError(400, "The shim supports swapType EXACT_INPUT only (PLAN.md 5.4)");
  if (!origin) throw new HttpError(400, `Unknown originAsset ${request.originAsset}. The shim knows: ${known}`);
  if (!destination) throw new HttpError(400, `Unknown destinationAsset ${request.destinationAsset}. The shim knows: ${known}`);
  if (![undefined, "ORIGIN_CHAIN"].includes(request.depositType)) throw new HttpError(400, "The shim supports depositType ORIGIN_CHAIN only");
  if (![undefined, "DESTINATION_CHAIN"].includes(request.recipientType)) throw new HttpError(400, "The shim supports recipientType DESTINATION_CHAIN only");
  if (![undefined, "ORIGIN_CHAIN"].includes(request.refundType)) throw new HttpError(400, "The shim supports refundType ORIGIN_CHAIN only");
  if (typeof request.amount !== "string" || !/^[1-9]\d*$/.test(request.amount)) throw new HttpError(400, "amount must be a positive whole number of units, as a string");
  if (typeof request.recipient !== "string" || !isValidAddress(destination.chain, request.recipient)) {
    throw new HttpError(400, `recipient is not a valid ${addressWords(destination)}`);
  }
  if (typeof request.refundTo !== "string" || !isValidAddress(origin.chain, request.refundTo)) {
    throw new HttpError(400, `refundTo is not a valid ${addressWords(origin)}`);
  }
  // 1Click uses the msg for a delivery to NEAR; the shim also refunds a NEAR origin with it (engine.ts).
  if (request.customRecipientMsg !== undefined && destination.chain !== "near" && origin.chain !== "near") {
    throw new HttpError(400, "customRecipientMsg only applies when the recipient or the refund is on NEAR");
  }
  if (request.deadline !== undefined && Number.isNaN(Date.parse(request.deadline))) throw new HttpError(400, "deadline must be an ISO time");

  if (!request.dry) {
    const now = (deps.now ?? Date.now)();
    if (request.deadline !== undefined && Date.parse(request.deadline) < now + 60_000) {
      throw new HttpError(400, "deadline must be at least a minute ahead");
    }
    const chains = [origin.chain, destination.chain];
    if (chains.includes("near") && !deps.floats.near) {
      throw new HttpError(503, "The shim's NEAR float is off: set SHIM_NEAR_ACCOUNT_ID and SHIM_NEAR_PRIVATE_KEY");
    }
    if (chains.includes("hl") && !deps.floats.hl) {
      throw new HttpError(503, "The shim's Hyperliquid float is off: set HL_FLOAT_ADDRESS and HL_FLOAT_PRIVATE_KEY");
    }
    if (chains.includes("evm") && !deps.floats.evm) {
      throw new HttpError(503, "The shim's Base Sepolia float is off: set EVM_GAS_PRIVATE_KEY (the gas wallet is the float there)");
    }
  }
  return request;
}

function addressWords(asset: ShimAsset): string {
  return asset.chain === "near" ? "NEAR account" : `${chainName(asset.chain)} address`;
}

async function submit(deps: ShimServerDeps, body: unknown) {
  const { txHash, depositAddress, memo } = (body ?? {}) as { txHash?: unknown; depositAddress?: unknown; memo?: unknown };
  if (typeof depositAddress !== "string" || typeof txHash !== "string") {
    throw new HttpError(400, "depositAddress and txHash are required strings");
  }
  const swap = await deps.engine.submitDeposit(depositAddress, txHash, typeof memo === "string" ? memo : undefined);
  if (!swap) throw new HttpError(404, "Unknown deposit address (and memo)");
  return deps.engine.statusOf(swap);
}

const FAULT_MODES: FaultMode[] = ["none", "refund", "fail", "late"];

function setFault(deps: ShimServerDeps, body: unknown) {
  const { mode, delaySeconds } = (body ?? {}) as { mode?: unknown; delaySeconds?: unknown };
  if (!FAULT_MODES.includes(mode as FaultMode)) throw new HttpError(400, `mode must be one of ${FAULT_MODES.join(", ")}`);
  const delay = delaySeconds ?? DEFAULT_LATE_SECONDS;
  if (typeof delay !== "number" || !Number.isInteger(delay) || delay < 1 || delay > 86_400) {
    throw new HttpError(400, "delaySeconds must be a whole number of seconds from 1 to 86400");
  }
  deps.engine.setFault({ mode: mode as FaultMode, delaySeconds: delay });
  return deps.engine.fault;
}

/** The fault switch needs the admin token. Compared through hashes, in constant time. */
function checkAdmin(deps: ShimServerDeps, request: IncomingMessage): void {
  if (!deps.adminToken) throw new HttpError(503, "SHIM_ADMIN_TOKEN is empty, so the fault switch is off");
  const given = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const digest = (text: string) => createHash("sha256").update(text).digest();
  if (!timingSafeEqual(digest(given), digest(deps.adminToken))) throw new HttpError(401, "Wrong or missing admin token");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 64 * 1024) throw new HttpError(413, "The body is too large");
  }
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    throw new HttpError(400, "The body is not valid JSON");
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
