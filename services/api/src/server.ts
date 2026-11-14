// The backend's HTTP API (INTERFACES.md 7). JSON over HTTP, on localhost; the web app reaches it through
// Next's /api proxy, so the browser never needs a cross-origin call.
//
//   GET  /api/config          ids, which contracts are live, the factory's Config
//   GET  /api/pool            the pool's get_pool and get_params
//   GET  /api/account/:id     get_state, token balances, pool.debt_of and pool.get_borrower
//   POST /api/preview         {account, intent}: pb-risk in preview mode over OutLayer's HTTPS API
//   POST /api/quote           a 1Click quote for a deposit (the shim on testnet), or, with "move", for moving
//                             USDC to or from the account's Hyperliquid address (Phase 3)
//   GET  /api/status          ?depositAddress=...&depositMemo=...: 1Click's status for it; or, for a move this
//                             backend quoted, ?account=...&transfer=move:<n> (stage 4)
//
// Phase 3 (INTERFACES.md 11; hl-handlers.ts):
//   GET  /api/hl/:account     get_state().hl and Hyperliquid's view of hl.address; ?fresh=1 re-reads the agents
//   GET  /api/markets         the coins, their bands and size rules, testnet's listing, the pool's coin statuses;
//                             ?account=: the bands of that account's own pinned gateway (INTERFACES.md 42)
//   POST /api/order           {account, auth}: pb-gateway runs the order
//   POST /api/cancel          {account, auth}: pb-gateway cancels
//   POST /api/set-leverage    {account}: pb-gateway sets the account's leverage
//   POST /api/hl/submit       {account, index}: posts the account's signed action to Hyperliquid
//
// Phase 4 (INTERFACES.md 17; drill.ts), testnet only:
//   GET  /api/drill           the drill's ratio and owner, and the stand-in's fault in force (?account=: its own ratio)
//   POST /api/drill/fault     {fault, delay_seconds?}: sets the stand-in's fault switch
//   GET  /api/keeper/:account the keeper's log lines for the account, and whether the keeper is running
//
// Phase 5 (INTERFACES.md 18-22):
//   POST /api/credit-check          {hl_address? | book?, spot?}: pb-risk's credit_check over OutLayer, mainnet reads
//   GET  /api/credit-check/example  the worked example as a request body, at today's BTC price
//   GET  /api/rhea                  Rhea's terms on mainnet now
//   GET  /api/activity/:account     the account's history, from a testnet indexer and the keeper's log
//   GET  /api/book-stress           the keeper's latest daily book stress test
//
// Phase 6, stage 1 (INTERFACES.md 28; lenders.ts), read only:
//   GET  /api/lenders               each lender's terms now: Aave and Rhea on mainnet, Aave's test market, our Rhea copy
//   GET  /api/lender/:account       the account's permission, funding plan and lender positions
//   POST /api/funding-plan          {account, amount}: pb-risk's preview of the `fund` intent, as sources and steps
//
// Phase 6, stage 2 (pricing.ts), read only:
//   GET  /api/pricing               what the operator has set clients to pay, what the pool has charged and paid for
//                                   it, and every account with a lender loan
//   GET  /api/lender/:account also answers what the account holds at Rhea (`held`, `deposit`), and
//   GET  /api/keeper/:account our Rhea copy's BTC price as the keeper keeps it, with the hold on it if one is set
//
// Privacy level 1 (INTERFACES.md 48; session.ts). With ACCOUNT_PRIVACY=owner, the default, a route that names a client
// account answers only its owner's wallet, the operator's and the keeper's, and our own services:
//   POST /api/session               {auth}: a wallet signs in, and gets a token for 12 hours (404 with privacy off)
//   GET  /api/accounts/mine         the signed-in wallet's own client accounts, newest first
// Every request may carry `Authorization: Bearer <token>`. The check comes before a route's own work.
//
// The app's second shape (INTERFACES.md 49.3 and 49.4):
//   POST /api/check                 {account, intent}: the keeper asks for the check and pays for it (check.ts).
//                                   The account's owner only; 404 with privacy off; 503 keeper_off without a keeper
//   GET  /api/perps/:coin           one perp market: its figures, order book and last trades (perps.ts). Open
//   GET  /api/perps/:coin/candles   ?interval=&n=: the market's candles, oldest first. Open
//   GET  /api/spot/tokens           ?account=: the Spot screen's tokens with 1Click's real prices (spot.ts)
//   POST /api/quote                 with "swap": {from, to}: a swap between two tokens of the account (spot.ts)
//   GET  /api/portfolio/:account    one point per check result the keeper saw the account store (portfolio.ts)
//
// Errors are {"error": "<code>", "message": "<words>"}. Unknown failures are logged here and answered
// without their details, so nothing server-side (a key, an RPC URL) can leak into an answer.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { OneClickError } from "@pb/oneclick";

import { getActivity } from "./activity.js";
import { getBookStress } from "./book-stress.js";
import { postCheck } from "./check.js";
import { getCreditExample, postCreditCheck } from "./credit.js";
import { getDrill, getKeeper, postDrillFault } from "./drill.js";
import { getRhea } from "./rhea.js";
import { getAccount, getConfig, getPool, getStatus, postPreview, postQuote, type Deps } from "./handlers.js";
import { getLender, getLenders, postFundingPlan } from "./lenders.js";
import { getHl, getMarkets, postCancel, postHlSubmit, postOrder, postSetLeverage } from "./hl-handlers.js";
import { HlError } from "./hl.js";
import { EvmError } from "./evm.js";
import { getEvmGas, postEvmGas, postEvmSubmit } from "./evm-handlers.js";
import { OutLayerError } from "./outlayer.js";
import { getCandles, getPerp } from "./perps.js";
import { getPortfolio } from "./portfolio.js";
import { getSpotTokens } from "./spot.js";
import { getMyAccounts, getPricing } from "./pricing.js";
import { isOurs, mayView, postSession, who } from "./session.js";
import { NotDeployedError, RpcError, ViewError } from "./rpc.js";
import { HttpError } from "./validate.js";

const MAX_BODY_BYTES = 16 * 1024;

export function createApiServer(deps: Deps, log: (line: string) => void = () => {}): Server {
  return createServer((request, response) => {
    const started = Date.now();
    const path = (request.url ?? "/").split("?")[0];
    route(deps, request)
      .then((body) => send(response, 200, body))
      .catch((error: unknown) => {
        const { status, body } = errorAnswer(error, log);
        send(response, status, body);
      })
      .finally(() => log(`${request.method} ${path} -> ${response.statusCode} in ${Date.now() - started} ms`));
  });
}

async function route(deps: Deps, request: IncomingMessage): Promise<unknown> {
  const url = new URL(request.url ?? "/", "http://api");
  const { pathname } = url;
  const method = request.method ?? "GET";
  // Privacy level 1 (INTERFACES.md 48.3 to 48.5): who is asking, and for each route that names a client account,
  // whether they may see it. `seen` throws the refusal, before the route's own work: no read of the chain beyond
  // the account's owner, no OutLayer run, and no share of a rate limit for a stranger.
  const asker = who(deps, request);
  const seen = async (id: string | null | undefined): Promise<void> => {
    if (typeof id === "string" && id !== "") await mayView(deps, asker, id);
  };
  /** A POST's body, once whoever asks may see the account it names. A body that names none is the route's own to refuse. */
  const bodyFor = async (when: (fields: Record<string, unknown>) => boolean = () => true): Promise<unknown> => {
    const body = await readJson(request);
    const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    if (when(fields)) await seen(typeof fields.account === "string" ? fields.account : null);
    return body;
  };

  if (method === "GET" && pathname === "/api/config") return getConfig(deps);
  if (method === "GET" && pathname === "/api/pool") return getPool(deps);
  if (method === "POST" && pathname === "/api/session") return postSession(deps, await readJson(request));
  // INTERFACES.md 49.4: the keeper asks for the check and pays for it. The account's owner only.
  if (method === "POST" && pathname === "/api/check") return postCheck(deps, asker, await readJson(request));
  if (method === "GET" && pathname === "/api/accounts/mine") {
    if (deps.config.accountPrivacy === "off") throw new HttpError(404, "not_found", `No route for ${method} ${pathname}`);
    if (asker.kind === "none") throw new HttpError(401, "sign_in", "Sign in with your wallet to list its accounts");
    if (asker.kind === "service") throw new HttpError(400, "bad_request", "The service token names no wallet: this route lists a signed-in wallet's own accounts");
    return getMyAccounts(deps, asker.wallet);
  }
  const account = /^\/api\/account\/([^/]+)$/.exec(pathname);
  if (method === "GET" && account) {
    const id = decodeSegment(account[1]!);
    await seen(id);
    return getAccount(deps, id);
  }
  if (method === "POST" && pathname === "/api/preview") return postPreview(deps, await bodyFor());
  // A deposit quote (no `move`) tells nothing about the account, and stays open.
  // A swap (INTERFACES.md 49.3) names the account as a move does.
  if (method === "POST" && pathname === "/api/quote") return postQuote(deps, await bodyFor((fields) => fields.move !== undefined || fields.swap !== undefined));
  if (method === "GET" && pathname === "/api/status") {
    // By the account's own transfer id (?account=&transfer=) the question names a client account; by deposit address
    // it names none, and stays open (INTERFACES.md 48.5).
    if (!url.searchParams.get("depositAddress")) await seen(url.searchParams.get("account"));
    return getStatus(deps, url.searchParams);
  }

  // INTERFACES.md 49.3: one perp market for the Perps screen, and its candles. Open: they name no client.
  const perp = /^\/api\/perps\/([^/]+)(\/candles)?$/.exec(pathname);
  if (method === "GET" && perp) return perp[2] ? getCandles(deps, decodeSegment(perp[1]!), url.searchParams) : getPerp(deps, decodeSegment(perp[1]!));
  // The Spot screen's tokens: anyone's to read, and with `account` (whose own token ids it then answers) the account's viewers'.
  if (method === "GET" && pathname === "/api/spot/tokens") {
    await seen(url.searchParams.get("account"));
    return getSpotTokens(deps, url.searchParams);
  }
  // Home's chart: one point per check result the keeper saw the account store.
  const portfolio = /^\/api\/portfolio\/([^/]+)$/.exec(pathname);
  if (method === "GET" && portfolio) {
    const id = decodeSegment(portfolio[1]!);
    await seen(id);
    return getPortfolio(deps, id);
  }
  if (method === "GET" && pathname === "/api/markets") {
    await seen(url.searchParams.get("account"));
    return getMarkets(deps, url.searchParams.get("account"));
  }
  if (method === "POST" && pathname === "/api/hl/submit") return postHlSubmit(deps, await readJson(request));
  const hl = /^\/api\/hl\/([^/]+)$/.exec(pathname);
  if (method === "GET" && hl) {
    const id = decodeSegment(hl[1]!);
    await seen(id);
    return getHl(deps, id, url.searchParams.get("fresh") === "1");
  }
  if (method === "POST" && pathname === "/api/order") return postOrder(deps, await readJson(request));
  if (method === "POST" && pathname === "/api/cancel") return postCancel(deps, await readJson(request));
  if (method === "POST" && pathname === "/api/set-leverage") return postSetLeverage(deps, await readJson(request));

  if (method === "GET" && pathname === "/api/drill") {
    await seen(url.searchParams.get("account"));
    return getDrill(deps, url.searchParams.get("account"));
  }
  if (method === "POST" && pathname === "/api/drill/fault") return postDrillFault(deps, await readJson(request));
  const keeper = /^\/api\/keeper\/([^/]+)$/.exec(pathname);
  if (method === "GET" && keeper) {
    const id = decodeSegment(keeper[1]!);
    await seen(id);
    return getKeeper(deps, id);
  }

  if (method === "POST" && pathname === "/api/credit-check") return postCreditCheck(deps, await readJson(request), clientAddress(request));
  if (method === "GET" && pathname === "/api/credit-check/example") return getCreditExample(deps);
  if (method === "GET" && pathname === "/api/rhea") return getRhea(deps);
  if (method === "GET" && pathname === "/api/book-stress") return getBookStress(deps);
  const activity = /^\/api\/activity\/([^/]+)$/.exec(pathname);
  if (method === "GET" && activity) {
    const id = decodeSegment(activity[1]!);
    await seen(id);
    return getActivity(deps, id);
  }

  if (method === "GET" && pathname === "/api/lenders") return getLenders(deps);
  const lender = /^\/api\/lender\/([^/]+)$/.exec(pathname);
  if (method === "GET" && lender) {
    const id = decodeSegment(lender[1]!);
    await seen(id);
    return getLender(deps, id);
  }
  if (method === "POST" && pathname === "/api/funding-plan") return postFundingPlan(deps, await bodyFor());
  // The per-account list is for us only: our services, the operator's wallet and the keeper's (or privacy off).
  if (method === "GET" && pathname === "/api/pricing") return getPricing(deps, deps.config.accountPrivacy !== "off" && !isOurs(deps, asker));
  if (method === "POST" && pathname === "/api/evm/submit") return postEvmSubmit(deps, await readJson(request));
  if (method === "POST" && pathname === "/api/evm/gas") return postEvmGas(deps, await readJson(request));
  if (method === "GET" && pathname === "/api/evm/gas") return getEvmGas(deps);
  throw new HttpError(404, "not_found", `No route for ${method} ${pathname}`);
}

/** Loopback addresses: a request from one of these came through a proxy on this machine, the web app's. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Who is asking, for the credit check's per-client limit (INTERFACES.md 22). The browser reaches the backend through
 * the web app's proxy on this machine, so a request from a loopback address names its client in X-Forwarded-For when
 * the proxy passes one on; otherwise the socket's address is the client. A caller can write that header itself, so the
 * per-client limit is a fair share only: the cap on runs in all (6 a minute) holds whatever it says.
 */
export function clientAddress(request: Pick<IncomingMessage, "headers" | "socket">): string {
  const socket = request.socket.remoteAddress ?? "unknown";
  if (!LOOPBACK.has(socket)) return socket;
  const header = request.headers["x-forwarded-for"];
  const first = (Array.isArray(header) ? header[0] : header)?.split(",")[0]?.trim();
  return first ? first.slice(0, 64) : socket;
}

/** The status and body for an error. Only errors we made ourselves carry their message to the browser. */
export function errorAnswer(error: unknown, log: (line: string) => void): { status: number; body: Record<string, unknown> } {
  if (error instanceof HttpError) return { status: error.status, body: { error: error.code, message: error.message } };
  if (error instanceof NotDeployedError) {
    return { status: 503, body: { error: "not_deployed", contract: error.contract, message: error.message } };
  }
  if (error instanceof OutLayerError) return { status: 502, body: { error: "outlayer", message: error.message } };
  if (error instanceof HlError) return { status: 502, body: { error: "hyperliquid", message: error.message } };
  if (error instanceof EvmError) return { status: 502, body: { error: "evm", message: error.message } };
  if (error instanceof OneClickError) {
    return { status: error.status >= 500 ? 502 : error.status, body: { error: "oneclick", message: error.message } };
  }
  if (error instanceof RpcError || error instanceof ViewError) return { status: 502, body: { error: "near_rpc", message: error.message } };
  log(`unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  return { status: 500, body: { error: "internal", message: "The backend failed; its log says why" } };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "bad_request", "The account id in the path isn't valid URL encoding");
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "The body is too large");
  }
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    throw new HttpError(400, "bad_request", "The body is not valid JSON");
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}
