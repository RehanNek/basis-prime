// Phase 3's endpoints (INTERFACES.md 11): the account's Hyperliquid side, orders through pb-gateway, posting the
// actions the account contract had the MPC signer sign, and quotes for moving USDC to and from Hyperliquid.
// Testnet only: apiConfig refuses any other NEAR network or Hyperliquid API.
//
//   GET  /api/hl/:account     get_state().hl, and Hyperliquid's view of hl.address
//   GET  /api/markets         the coins of universe_v0.json, with testnet's meta and the pool's coin statuses
//   POST /api/order           {account, auth}: pb-gateway, mode "order"
//   POST /api/cancel          {account, auth}: pb-gateway, mode "cancel"
//   POST /api/set-leverage    {account}: pb-gateway, mode "set_leverage"
//   POST /api/hl/submit       {account, index}: posts hl.signed[index], read from the chain, to Hyperliquid's /exchange
//   POST /api/quote           {dry, move: "to_hl" | "home", account, amount}: the two USDC moves (below)
//
// Stage 4 (INTERFACES.md 36): POST /api/quote also takes move "to_evm" | "e_home" with `token`: the four moves
// between the account on NEAR and its address on Aave's chain (postEvmMoveQuote, at the end of this file).
import { baseSepoliaAddress, baseSepoliaAssetId, OneClickError, type QuoteRequest, type QuoteResponse } from "@pb/oneclick";

import { EVM_TEST_CHAINS } from "./config.js";
import { aaveConfOf } from "./evm-handlers.js";
import { DEPOSIT_MSG, DEFAULT_SLIPPAGE_BP, QUOTE_DEADLINE_MS, oneClickCall, soft, type Deps } from "./handlers.js";
import { marketInfo, userInfo, USER_INFO_TYPES, type AssetCtx, type Hex, type PerpMeta, type SpotClearinghouseState, type UserInfoType } from "./hl.js";
import { base64Bytes, ed25519PublicKey, verifyNep413 } from "./nep413.js";
import { OutLayerError } from "./outlayer.js";
import { NotDeployedError, type ViewResult } from "./rpc.js";
import { asObject, badRequest, HttpError, isAccountId, isPrimeAccount, isU128 } from "./validate.js";

const HL_ADDRESS = /^0x[0-9a-f]{40}$/;
const PROJECT_ID = /^[a-z\d._-]+\/[a-z\d._-]+$/;
/** The NEP-413 recipient every order and cancel is signed for (INTERFACES.md 9). */
export const GATEWAY_RECIPIENT = "pb-gateway";
/** A signed message is a short compact JSON (INTERFACES.md 9); anything much longer isn't one. */
const MAX_MESSAGE_CHARS = 2_048;
/** INTERFACES.md 11: the last 50 fills. */
export const FILLS_SHOWN = 50;

// ---------- what the backend reads from the account contract (INTERFACES.md 8) ----------

export interface HlSigned {
  index: number;
  kind: string;
  /** Compact JSON: posted parsed, so its strings (the amount above all) reach Hyperliquid unchanged. */
  action: string;
  nonce: number;
  signature: { r: string; s: string; v: number };
  signed_block: number;
}

export interface HlState {
  path: string;
  address: string | null;
  agent?: { address: string; received_block: number } | null;
  next_nonce_ms?: string;
  signed?: HlSigned[];
  /**
   * The pause after a transfer out of Hyperliquid was signed (INTERFACES.md 8 and 50.2): its end, and, on accounts
   * made after the deploy of 50.2, the nonces of the transfers no accepted check has shown as sent, and the floor a
   * ninth open one leaves. The backend reads none of them: GET /api/hl and GET /api/account pass the account's own
   * `hl` on as it is, so the pages see them exactly as the account shows them.
   */
  send_open_until_ms?: string;
  open_sends?: string[];
  send_floor_until_ms?: string;
}

interface StateView {
  owner: string;
  /** `open` stays true until a repayment comes back partly unused (INTERFACES.md 4, as built). */
  loan?: { principal?: string; open?: boolean };
  hl?: HlState;
  /**
   * Phase 4 (INTERFACES.md 14 and 17): the n of the id `move:<n>` the account gives its next move. The msg that
   * resolves the move is fixed in the quote, before the account's call, so the backend needs n first.
   */
  next_move?: number | string;
  /** INTERFACES.md 40.1: the block the permission last changed in, on accounts made since 12 Nov. The move quotes don't read it. */
  permission_blk?: number;
}

/** The id the account's next move will get, `move:<n>`, if its get_state says (next_move); null otherwise. */
export function nextMoveId(state: { next_move?: unknown }): string | null {
  const n = state.next_move;
  if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) return `move:${n}`;
  if (typeof n === "string" && /^\d{1,20}$/.test(n)) return `move:${n}`;
  return null;
}

/** INTERFACES.md 14: the msg 1Click delivers (and the stand-in refunds) with, which resolves a pending transfer. */
export function transferMsg(id: string): string {
  return JSON.stringify({ pb: { transfer: id } });
}

/** A loan is open as the account counts it: `loan.open` where the contract has it, else what is still owed. */
export function loanOpen(loan: StateView["loan"]): boolean {
  if (!loan) return false;
  return loan.open ?? (loan.principal ?? "0") !== "0";
}

/** The account's get_state, or 404 while it has no account contract. */
async function readState(deps: Deps, account: string): Promise<ViewResult<StateView>> {
  try {
    const read = await deps.chain.view<StateView | null>(account, "get_state");
    if (!read.value) throw new HttpError(404, "not_deployed", `${account} has no state`);
    return read as ViewResult<StateView>;
  } catch (error) {
    if (error instanceof NotDeployedError) throw new HttpError(404, "not_deployed", `${account} has no account contract yet (${error.reason})`);
    throw error;
  }
}

function clientAccount(deps: Deps, value: unknown): string {
  const { factory } = deps.config.ids;
  if (!isPrimeAccount(value, factory)) throw badRequest(`account must be a client account, <name>.${factory}`);
  return value;
}

function hlAddressOf(state: StateView): Hex | null {
  const address = state.hl?.address?.toLowerCase();
  return address && HL_ADDRESS.test(address) ? (address as Hex) : null;
}

// ---------- GET /api/hl/:account ----------

/**
 * The account's `hl` from get_state and, once hl_init has set hl.address, Hyperliquid's view of that address.
 * Each Hyperliquid read stands alone: one that fails comes back null, with the reason in `errors`, and the rest
 * still show. `fresh` re-reads the agents and the account mode at once, after an approval the page waits on.
 * `near_time_ms` is the final block's time, which the trade page builds an order's expiry from. `gateway` is the
 * pb-gateway the account pins: null for an account made before Phase 3, which can't trade.
 */
export async function getHl(deps: Deps, accountId: string, fresh = false) {
  const account = clientAccount(deps, accountId);
  const [state, block, config] = await Promise.all([
    readState(deps, account),
    deps.chain.finalBlock(),
    soft(deps.chain.view<{ gateway?: { project_id?: unknown; version_key?: unknown; secrets_ref?: unknown } } | null>(account, "get_config")),
  ]);
  const address = hlAddressOf(state.value);
  const pin = config?.value?.gateway;
  const base = {
    account_id: account,
    owner: state.value.owner,
    block_height: Math.max(state.blockHeight, block.height),
    near_time_ms: block.timeMs,
    hl: state.value.hl ?? null,
    address,
    gateway:
      pin && typeof pin.project_id === "string"
        ? {
            project_id: pin.project_id,
            version_key: typeof pin.version_key === "string" && pin.version_key ? pin.version_key : null,
            // null when the wasm's manifest names the seed's row in author_secrets, as built (INTERFACES.md 9).
            secrets_ref: pin.secrets_ref ?? null,
          }
        : null,
  };
  if (!address) return { ...base, hyperliquid: null };

  const slow = new Set<UserInfoType>(["userAbstraction", "extraAgents"]);
  const reads = await Promise.all(
    USER_INFO_TYPES.map((type) =>
      userInfo<unknown>(deps.hl, deps.hlCache, type, address, fresh && slow.has(type)).then(
        (value) => ({ type, value, error: null }),
        (error: unknown) => ({ type, value: null, error: error instanceof Error ? error.message : String(error) }),
      ),
    ),
  );
  const got = Object.fromEntries(reads.map((r) => [r.type, r.value])) as Record<UserInfoType, unknown>;
  const errors = Object.fromEntries(reads.filter((r) => r.error !== null).map((r) => [r.type, r.error]));

  const spot = got.spotClearinghouseState as SpotClearinghouseState | null;
  const usdc = spot?.balances?.find((b) => b.coin === "USDC");
  const fills = got.userFills as unknown[] | null;
  return {
    ...base,
    hyperliquid: {
      clearinghouse_state: got.clearinghouseState ?? null,
      /** USDC in the address's spot balance. A unified account keeps its USDC here (research/hyperliquid.md). */
      spot_usdc: spot ? { total: usdc?.total ?? "0", hold: usdc?.hold ?? "0" } : null,
      abstraction: got.userAbstraction ?? null,
      open_orders: got.frontendOpenOrders ?? null,
      fills: Array.isArray(fills) ? fills.slice(0, FILLS_SHOWN) : null,
      agents: got.extraAgents ?? null,
      errors,
    },
  };
}

// ---------- GET /api/markets ----------

interface CoinState {
  status: string;
  since: string;
  emergency: boolean;
}

/**
 * The price band on testnet (INTERFACES.md 42; RISK_ENGINE.md 9, P2): the parameter file's band for a coin or 3%,
 * whichever is larger. It is a testnet allowance: Hyperliquid testnet's mark was seen 0.8% to 2.0% from its own
 * oracle price on 11 and 12 Nov, and an order has to be priced near the mark to fill.
 */
export const TESTNET_BAND_FLOOR_BP = 300;

/**
 * Each account pins its gateway when it is made, so the band it trades under is its own gateway's. These are the
 * pb-gateway versions from before the 3% rule (their wasm hashes, which are the pinned version keys), as the
 * secret's access rule listed every gateway that could run on 12 Nov (research/data/audit_fixes_update_access.json).
 * An account that pins one of them keeps the parameter file's band. Any later version carries the rule.
 */
export const GATEWAYS_BEFORE_THE_BAND_FLOOR: ReadonlySet<string> = new Set([
  "fcae6052c4cde41d4dcb50460f4788df848e648839ce392fb6f15dc1581223d5",
  "6746393a828da9e9f3cb302f1e1a57d1c50d1042d66c3b7a659f58652a747efb",
  "e5d4b32459d5acf5dbd163e787705e952decfbcf8c0815301fff0ff1e9418b50",
  "6bdc21f66476c14dfda7e94d9257b7ccc53e4621d4c518b763dba1d98226455b",
  "06dc7787e8fc5db00747588e21c6e704c13e5055dc14f2fb2c20c5dd4db426c1",
  "9a2e035c2f62906d8e390db28c5be23b0753ca20b7d842908ac35916b09643e8",
]);

/** The least band, in bp, that a pinned gateway uses on this network: 300 on testnet for one built since the rule, else 0. */
export function bandFloorBp(network: string, gatewayVersion: string | null): number {
  if (network !== "testnet" || !gatewayVersion) return 0;
  return GATEWAYS_BEFORE_THE_BAND_FLOOR.has(gatewayVersion.toLowerCase()) ? 0 : TESTNET_BAND_FLOOR_BP;
}

/**
 * How long a page or a gate signs an order or a cancel for (INTERFACES.md 50.4): 10 s under what the account's own
 * pinned gateway takes, for the gap between clocks. The gateway built for 50.4 takes a message signed up to 240 s
 * ahead on testnet; every build before it takes 120 s.
 */
export const ORDER_LIFE_MS = 230_000;
export const ORDER_LIFE_BEFORE_MS = 110_000;

/**
 * The pb-gateway builds that take a message signed at most 120 s ahead: the six from before the 3% band, and the
 * one pinned on 13 Nov, which has the 3% band and the 120 s. This list is about a message's life only: the band has
 * its own list above, and the two differ by that one build. Any later build takes 240 s on testnet.
 */
export const GATEWAYS_BEFORE_THE_LONG_LIFE: ReadonlySet<string> = new Set([...GATEWAYS_BEFORE_THE_BAND_FLOOR, "fba556c2b9e64cf216fb3c805c998a1a210d5ef257960091853e3a8e0303ceb6"]);

/**
 * What to sign for, in ms, on a pinned gateway: 230 s on testnet for a build since 50.4, 110 s for an older one.
 * 110 s too where no gateway is known and on mainnet, whose gateway keeps 120 s: a shorter life is taken by every build.
 */
export function orderLifeMs(network: string, gatewayVersion: string | null): number {
  if (network !== "testnet" || !gatewayVersion) return ORDER_LIFE_BEFORE_MS;
  return GATEWAYS_BEFORE_THE_LONG_LIFE.has(gatewayVersion.toLowerCase()) ? ORDER_LIFE_BEFORE_MS : ORDER_LIFE_MS;
}

/** The longest any gateway takes a message signed ahead (testnet's 240 s), and what a run needs once its turn comes: its own 20 s at most, and the polls around it. */
export const MAX_ORDER_LIFE_MS = 240_000;
export const ORDER_WAIT_SLACK_MS = 40_000;

/**
 * How long the backend waits for an order's or a cancel's run (INTERFACES.md 50.4: nothing gives up before the
 * order's life is over). Never less than OUTLAYER_WAIT_MS (`configured`), and never less than what is left of the
 * signed message's own life plus 40 s, whatever that setting says. A message that claims a longer life than any
 * gateway takes is waited for as one of 240 s: the gateway would refuse it.
 */
export function orderWaitMs(configured: number, expiresMs: number, nowMs: number): number {
  const left = Math.min(Math.max(0, expiresMs - nowMs), MAX_ORDER_LIFE_MS);
  return Math.max(configured, left + ORDER_WAIT_SLACK_MS);
}

const pinnedGateway = (config: { gateway?: { version_key?: unknown } | null } | null | undefined): string | null =>
  typeof config?.gateway?.version_key === "string" && config.gateway.version_key ? config.gateway.version_key : null;

/**
 * Every coin of universe_v0.json in the file's order: whether it is on the allow-list, its band and size rule,
 * how testnet lists it (from metaAndAssetCtxs, read by name: asset numbers differ by network, research/day1.md 12),
 * and the pool's status for it. A coin missing from testnet, or delisted there, can't be traded on testnet.
 *
 * `band_bp` is the band the gateway uses for the coin (P2). With `?account=<client account>` it is that account's
 * own pinned gateway's: on testnet 3% at least for a gateway built since 12 Nov, the parameter file's band for an
 * older one. With no account, or one that isn't made yet, it is the band of the gateway the factory pins for new
 * accounts. `band_from` says which ("account" or "factory"), `gateway_version` names the gateway, and
 * `band_floor_bp` is the 300 or 0 that was applied.
 *
 * `order_life_ms` (INTERFACES.md 50.4) is what to sign an order or a cancel for on that same gateway: 230000 on a
 * build that takes 240 s, 110000 on an older one.
 */
export async function getMarkets(deps: Deps, accountId?: string | null) {
  const { ids } = deps.config;
  const account = accountId === undefined || accountId === null || accountId === "" ? null : clientAccount(deps, accountId);
  const [universe, market, statuses, factoryConfig, accountConfig] = await Promise.all([
    deps.universe(),
    marketInfo<[PerpMeta, AssetCtx[]]>(deps.hl, deps.hlCache).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error: error instanceof Error ? error.message : String(error) }),
    ),
    soft(deps.chain.view<[string, CoinState][]>(ids.pool, "coin_statuses")),
    soft(deps.chain.view<{ params_hash?: string; gateway?: { version_key?: unknown } | null } | null>(ids.factory, "get_config")),
    account ? soft(deps.chain.view<{ gateway?: { version_key?: unknown } | null } | null>(account, "get_config")) : null,
  ]);
  // The account's own pin where it has a contract; else the factory's, which is what a new account gets.
  const own = accountConfig?.value ? pinnedGateway(accountConfig.value) : null;
  const bandFrom = accountConfig?.value ? "account" : factoryConfig?.value ? "factory" : null;
  const gatewayVersion = accountConfig?.value ? own : pinnedGateway(factoryConfig?.value);
  const floorBp = bandFloorBp(ids.network, gatewayVersion);

  const listed = new Map<string, { asset: number; meta: PerpMeta["universe"][number]; ctx: AssetCtx | undefined }>();
  if (market.value) {
    const [meta, ctxs] = market.value;
    meta.universe.forEach((entry, asset) => listed.set(entry.name, { asset, meta: entry, ctx: ctxs[asset] }));
  }
  const status = new Map((statuses?.value ?? []).map(([coin, state]) => [coin, state]));
  const pinned = factoryConfig?.value?.params_hash ?? null;

  return {
    network: ids.network,
    hl_api: new URL(deps.config.hlApiUrl).host,
    hl_error: market.error,
    params_hash: universe.hash,
    /** Whether the file here is the one the factory pins for new accounts. */
    params_hash_pinned: pinned,
    params_hash_matches: pinned === null ? null : pinned.toLowerCase() === universe.hash,
    pool_statuses: statuses === null ? "not_deployed" : "read",
    /** Whose gateway the bands below are for, which gateway that is, and the least band it uses (INTERFACES.md 42). */
    band_from: bandFrom,
    gateway_version: gatewayVersion,
    band_floor_bp: floorBp,
    /** How long to sign an order or a cancel for on that gateway, in ms (INTERFACES.md 50.4). */
    order_life_ms: orderLifeMs(ids.network, gatewayVersion),
    coins: universe.coins.map(([coin, entry]) => {
      const hl = listed.get(coin);
      return {
        coin,
        allowed: entry.allowed,
        tier: entry.tier,
        band_bp: Math.max(Math.round(entry.params.price_band * 10_000), floorBp),
        universe_sz_decimals: entry.hl_sz_decimals,
        client_cap_usd: Math.round(entry.params.client_cap_usd),
        testnet: hl
          ? {
              asset: hl.asset,
              sz_decimals: hl.meta.szDecimals,
              max_leverage: hl.meta.maxLeverage,
              delisted: hl.meta.isDelisted === true,
              mark_px: hl.ctx?.markPx ?? null,
              oracle_px: hl.ctx?.oraclePx ?? null,
              mid_px: hl.ctx?.midPx ?? null,
              day_ntl_vlm: hl.ctx?.dayNtlVlm ?? null,
              /** The current hourly funding rate: positive means longs pay shorts. */
              funding: hl.ctx?.funding ?? null,
            }
          : null,
        status: status.get(coin) ?? null,
      };
    }),
  };
}

// ---------- orders and cancels through pb-gateway ----------

/** INTERFACES.md 9, "Auth": the wallet's NEP-413 signature over the order or cancel message. */
export interface Auth {
  owner: string;
  public_key: string;
  signature: string;
  message: string;
  nonce: string;
  recipient: string;
}

export interface ParsedAuth {
  auth: Auth;
  publicKey: Uint8Array;
  signature: Uint8Array;
  nonce: Uint8Array;
}

/**
 * Checks the shape of `auth` and decodes its key, signature and nonce. Extra fields are dropped. `recipient` is the
 * one the caller expects, and no other is taken: an order's is the gateway's, a sign-in's is its own
 * (INTERFACES.md 48.2), so a signature made for one can never pass as the other.
 */
export function parseAuth(value: unknown, recipient: string = GATEWAY_RECIPIENT): ParsedAuth {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("auth must be an object: {owner, public_key, signature, message, nonce, recipient}");
  }
  const f = value as Record<string, unknown>;
  if (!isAccountId(f.owner)) throw badRequest("auth.owner must be the NEAR account that signed");
  const publicKey = typeof f.public_key === "string" ? ed25519PublicKey(f.public_key) : null;
  if (!publicKey) throw badRequest("auth.public_key must be ed25519:<base58 of 32 bytes>");
  const signature = typeof f.signature === "string" ? base64Bytes(f.signature, 64) : null;
  if (!signature) throw badRequest("auth.signature must be the base64 of 64 bytes");
  const nonce = typeof f.nonce === "string" ? base64Bytes(f.nonce, 32) : null;
  if (!nonce) throw badRequest("auth.nonce must be the base64 of 32 bytes");
  if (f.recipient !== recipient) throw badRequest(`auth.recipient must be "${recipient}"`);
  if (typeof f.message !== "string" || !f.message || f.message.length > MAX_MESSAGE_CHARS) {
    throw badRequest(`auth.message must be the signed message, at most ${MAX_MESSAGE_CHARS} characters`);
  }
  const auth: Auth = {
    owner: f.owner,
    public_key: f.public_key as string,
    signature: f.signature as string,
    message: f.message,
    nonce: f.nonce as string,
    recipient,
  };
  return { auth, publicKey, signature, nonce };
}

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;
const TIFS = ["Gtc", "Ioc", "Alo"];

/**
 * Reads the signed message: compact JSON with "pb" the kind, "account" the account in the request, the order or
 * the cancel, and "expires_ms". Rounding is the gateway's to check (INPUT), with Hyperliquid's live meta.
 */
export function parseSignedMessage(message: string, kind: "order" | "cancel", account: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    throw badRequest("auth.message is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw badRequest("auth.message must be a JSON object");
  const m = parsed as Record<string, unknown>;
  if (m.pb !== kind) throw badRequest(`auth.message must have "pb":"${kind}" for /api/${kind}`);
  if (m.account !== account) throw badRequest("auth.message names another account than the request");
  if (typeof m.expires_ms !== "number" || !Number.isSafeInteger(m.expires_ms)) throw badRequest("auth.message.expires_ms must be a time in ms");
  const body = m[kind];
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest(`auth.message.${kind} must be an object`);
  const b = body as Record<string, unknown>;
  if (typeof b.coin !== "string" || !b.coin || b.coin.length > 32) throw badRequest(`auth.message.${kind}.coin must be Hyperliquid's coin name`);
  if (kind === "order") {
    if (typeof b.is_buy !== "boolean" || typeof b.reduce_only !== "boolean") throw badRequest("auth.message.order needs is_buy and reduce_only as booleans");
    if (typeof b.sz !== "string" || !DECIMAL.test(b.sz) || typeof b.limit_px !== "string" || !DECIMAL.test(b.limit_px)) {
      throw badRequest("auth.message.order needs sz and limit_px as decimal strings");
    }
    if (!TIFS.includes(b.tif as string)) throw badRequest(`auth.message.order.tif must be one of ${TIFS.join(", ")}`);
  } else if (typeof b.oid !== "number" || !Number.isSafeInteger(b.oid) || b.oid < 0) {
    throw badRequest("auth.message.cancel.oid must be the order's id");
  }
  return m;
}

/** The account's pinned pb-gateway (INTERFACES.md 3, `gateway`). Accounts made before Phase 3 have none. */
async function gatewayPin(deps: Deps, account: string): Promise<{ project: string; versionKey: string | undefined }> {
  let config: { gateway?: { project_id?: unknown; version_key?: unknown } } | null;
  try {
    config = (await deps.chain.view<typeof config>(account, "get_config")).value;
  } catch (error) {
    if (error instanceof NotDeployedError) throw new HttpError(404, "not_deployed", `${account} has no account contract yet (${error.reason})`);
    throw error;
  }
  const gateway = config?.gateway;
  if (!gateway || typeof gateway.project_id !== "string") {
    throw new HttpError(409, "no_gateway", `${account} was made before Phase 3: its config names no pb-gateway, so it can't trade. Create a new account.`);
  }
  if (!PROJECT_ID.test(gateway.project_id) || gateway.project_id !== deps.config.ids.gatewayProject) {
    throw new HttpError(409, "bad_config", `${account} pins ${gateway.project_id}, not our gateway ${deps.config.ids.gatewayProject}`);
  }
  const versionKey = typeof gateway.version_key === "string" && gateway.version_key ? gateway.version_key : undefined;
  return { project: gateway.project_id, versionKey };
}

/** pb-gateway's JSON output (INTERFACES.md 9), with the run's call_id and attestation_url added. */
export type GatewayAnswer = Record<string, unknown> & { call_id: string | null; attestation_url: string | null };

/** One pb-gateway run over OutLayer's HTTPS API, paid by our key. Answers its output, plus call_id and attestation_url. */
async function runGateway(deps: Deps, account: string, input: Record<string, unknown>, what: "order" | "cancel" | "set_leverage", waitMs?: number): Promise<GatewayAnswer> {
  const outlayer = deps.outlayer;
  if (!outlayer) throw new HttpError(503, "gateway_off", "Orders are off: OUTLAYER_PAYMENT_KEY is empty in the backend's .env");
  const pin = await gatewayPin(deps, account);
  if (!deps.limits.gatewayRuns.take()) throw new HttpError(429, "too_many_runs", "Too many gateway runs this minute, across all accounts; try again shortly");

  let run;
  try {
    // An order's or a cancel's run is waited for to the end of its message's life at least (orderWaitMs).
    run = await (waitMs === undefined ? outlayer.run(pin.project, input, pin.versionKey) : outlayer.run(pin.project, input, pin.versionKey, { waitMs }));
  } catch (error) {
    // 408, 500 and our own timeout leave the run's fate unknown: it may have posted to Hyperliquid.
    if (error instanceof OutLayerError && [408, 500, 504].includes(error.status) && what !== "set_leverage") {
      throw new HttpError(502, "outlayer_unknown", `${error.message}. The ${what} may still have reached Hyperliquid: look at the open orders and fills before sending it again.`);
    }
    throw error;
  }
  if (run.status !== "completed") throw new HttpError(502, "outlayer_run", `pb-gateway did not complete: ${run.error ?? run.status}`);
  if (!run.output || typeof run.output !== "object" || Array.isArray(run.output)) {
    throw new HttpError(502, "outlayer_run", "pb-gateway answered something that isn't a JSON object");
  }
  return { ...(run.output as Record<string, unknown>), call_id: run.callId, attestation_url: run.attestationUrl };
}

/**
 * POST /api/order and /api/cancel: {account, auth}. Before paying for a run, the backend checks what it can by
 * itself: the message's shape, that it names this account, that `auth.owner` owns the account, and the NEP-413
 * signature. The gateway checks all of that again, plus the key, the expiry and the nonce, and is the authority.
 * Its refusals ({"ok":false,"code","reason"}) are answers, with HTTP 200.
 */
async function signedRun(deps: Deps, body: unknown, kind: "order" | "cancel") {
  const fields = asObject(body);
  const account = clientAccount(deps, fields.account);
  const parsed = parseAuth(fields.auth);
  const message = parseSignedMessage(parsed.auth.message, kind, account);
  if (!verifyNep413(parsed.publicKey, parsed.signature, { message: parsed.auth.message, nonce: parsed.nonce, recipient: GATEWAY_RECIPIENT })) {
    throw new HttpError(400, "auth", "The signature doesn't check out as a NEP-413 signature of this message by this key; the gateway would refuse it (AUTH)");
  }
  const limiter = kind === "order" ? deps.limits.orders : deps.limits.cancels;
  if (!limiter.take(account)) throw new HttpError(429, `too_many_${kind}s`, `At most 60 ${kind}s a minute per account; try again shortly`);

  const state = await readState(deps, account);
  if (state.value.owner !== parsed.auth.owner) {
    throw new HttpError(403, "not_owner", `${parsed.auth.owner} signed, but ${account} belongs to ${state.value.owner}: only the owner can trade`);
  }
  const waitMs = orderWaitMs(deps.config.outlayerWaitMs, message.expires_ms as number, deps.now());
  return runGateway(deps, account, { mode: kind, account, network: deps.config.ids.network, auth: parsed.auth }, kind, waitMs);
}

export const postOrder = (deps: Deps, body: unknown) => signedRun(deps, body, "order");
export const postCancel = (deps: Deps, body: unknown) => signedRun(deps, body, "cancel");

/** POST /api/set-leverage {account}: no owner signature, because the gateway picks the numbers (INTERFACES.md 9). */
export async function postSetLeverage(deps: Deps, body: unknown) {
  const account = clientAccount(deps, asObject(body).account);
  if (!deps.limits.leverage.take(account)) throw new HttpError(429, "too_many_leverage_sets", "At most 6 leverage updates a minute per account");
  return runGateway(deps, account, { mode: "set_leverage", account, network: deps.config.ids.network }, "set_leverage");
}

// ---------- POST /api/hl/submit ----------

const SIGNED_KINDS = ["approveAgent", "sendAsset"];
const HEX64 = /^0x[0-9a-f]{64}$/i;

/** What goes to /exchange for one stored entry, after checking it is a testnet action of its kind. */
export function exchangeBody(entry: HlSigned, signatureChainId: string): { action: Record<string, unknown>; nonce: number; signature: HlSigned["signature"] } {
  if (!SIGNED_KINDS.includes(entry.kind)) throw new HttpError(422, "bad_entry", `Entry ${entry.index} is a ${entry.kind}, which the backend doesn't post`);
  let action: Record<string, unknown>;
  try {
    action = JSON.parse(entry.action) as Record<string, unknown>;
  } catch {
    throw new HttpError(422, "bad_entry", `Entry ${entry.index}'s action isn't JSON`);
  }
  if (!action || typeof action !== "object" || action.type !== entry.kind) throw new HttpError(422, "bad_entry", `Entry ${entry.index}'s action isn't a ${entry.kind}`);
  if (action.hyperliquidChain !== "Testnet") throw new HttpError(422, "not_testnet", `Entry ${entry.index} is for Hyperliquid ${String(action.hyperliquidChain)}; the backend posts testnet actions only`);
  if (action.signatureChainId !== signatureChainId) throw new HttpError(422, "bad_entry", `Entry ${entry.index} was signed for chain id ${String(action.signatureChainId)}, not ${signatureChainId}`);
  if (action.nonce !== entry.nonce || !Number.isSafeInteger(entry.nonce)) throw new HttpError(422, "bad_entry", `Entry ${entry.index}'s nonce doesn't match its action`);
  const { r, s, v } = entry.signature ?? ({} as HlSigned["signature"]);
  if (!HEX64.test(r) || !HEX64.test(s) || (v !== 27 && v !== 28)) throw new HttpError(422, "bad_entry", `Entry ${entry.index}'s signature isn't {r, s, v}`);
  return { action, nonce: entry.nonce, signature: { r, s, v } };
}

/**
 * POST /api/hl/submit {account, index}: reads hl.signed from the chain (never from the browser), and posts the
 * entry with that index to Hyperliquid's /exchange as {action, nonce, signature} (INTERFACES.md 8). Posting twice
 * is harmless: Hyperliquid refuses a nonce it has seen. Answers Hyperliquid's reply.
 */
export async function postHlSubmit(deps: Deps, body: unknown) {
  const fields = asObject(body);
  const account = clientAccount(deps, fields.account);
  const index = fields.index;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) throw badRequest("index must be the signed entry's index, a whole number");
  if (!deps.limits.submits.take()) throw new HttpError(429, "too_many_submits", "Too many posts to Hyperliquid this minute; try again shortly");

  const state = await readState(deps, account);
  const signed = state.value.hl?.signed ?? [];
  const entry = signed.find((e) => e.index === index);
  if (!entry) {
    const have = signed.map((e) => e.index);
    throw new HttpError(404, "no_entry", `${account} has no signed entry ${index}${have.length ? ` (it keeps ${have[0]} to ${have[have.length - 1]})` : " (it has none yet)"}`);
  }
  const config = await soft(deps.chain.view<{ signature_chain_id?: string } | null>(account, "get_config"));
  const posted = exchangeBody(entry, config?.value?.signature_chain_id ?? "0x66eee");
  const reply = await deps.hl.exchange(posted);
  const answer = reply.body as { status?: unknown; response?: unknown } | string;
  const accepted = reply.status === 200 && typeof answer === "object" && answer?.status === "ok";
  // Hyperliquid takes a signed action once. "duplicate nonce" with this entry's own nonce means it took this very
  // action before: the keeper posts a signed entry it sees too, and may get there a second before the page or the
  // gate does (seen on 13 Nov, and for an approval on 12 Nov). The action is in, so the answer is a yes, and says so.
  const already =
    !accepted &&
    reply.status === 200 &&
    typeof answer === "object" &&
    answer?.status === "err" &&
    typeof answer.response === "string" &&
    /duplicate nonce/i.test(answer.response) &&
    answer.response.includes(String(entry.nonce));
  return {
    account,
    index,
    kind: entry.kind,
    nonce: entry.nonce,
    ok: accepted || already,
    ...(already ? { already_posted: true as const } : {}),
    http_status: reply.status,
    hl: reply.body,
    posted,
  };
}

// ---------- POST /api/quote with a move ----------

export type Move = "to_hl" | "home";

/** The shim's (and 1Click's) Hyperliquid USDC has 8 decimals; micro-USDC has 6. */
const HL_UNITS_PER_MICRO = 100n;

/**
 * The quote helpers (INTERFACES.md 8, 11). `amount` is micro-USDC either way, as mUSDC and hl_withdraw count it.
 *   to_hl: mUSDC on NEAR -> Hyperliquid USDC. Recipient the account's hl.address, refund the account.
 *   home:  Hyperliquid USDC -> mUSDC. Recipient the account, with the deposit msg so the account books it;
 *          refund hl.address. The deposit address is the float, and the stand-in matches the deposit by its sender
 *          (hl.address) and its exact amount.
 * Phase 4 (INTERFACES.md 14): with a `transferId`, the msg is {"pb":{"transfer":<id>}} instead. Home, 1Click delivers
 * with it; to Hyperliquid, the stand-in refunds with it (1Click's field for a NEAR msg is customRecipientMsg).
 */
export function moveQuoteRequest(input: {
  move: Move;
  dry: boolean;
  account: string;
  hlAddress: string;
  amountMicro: string;
  musdc: string;
  hlUsdcAsset: string;
  nowMs: number;
  slippageBp: number;
  transferId?: string | null;
}): QuoteRequest {
  const common = {
    dry: input.dry,
    swapType: "EXACT_INPUT" as const,
    slippageTolerance: input.slippageBp,
    depositType: "ORIGIN_CHAIN" as const,
    refundType: "ORIGIN_CHAIN" as const,
    recipientType: "DESTINATION_CHAIN" as const,
    deadline: new Date(input.nowMs + QUOTE_DEADLINE_MS).toISOString(),
  };
  if (input.move === "to_hl") {
    return {
      ...common,
      originAsset: `nep141:${input.musdc}`,
      destinationAsset: input.hlUsdcAsset,
      amount: input.amountMicro,
      refundTo: input.account,
      recipient: input.hlAddress,
      ...(input.transferId ? { customRecipientMsg: transferMsg(input.transferId) } : {}),
    };
  }
  return {
    ...common,
    originAsset: input.hlUsdcAsset,
    destinationAsset: `nep141:${input.musdc}`,
    amount: (BigInt(input.amountMicro) * HL_UNITS_PER_MICRO).toString(),
    refundTo: input.hlAddress,
    recipient: input.account,
    customRecipientMsg: input.transferId ? transferMsg(input.transferId) : DEPOSIT_MSG,
  };
}

/**
 * The account's next call for a committed quote: what the web app asks the wallet to sign. With `expMs` (Phase 4,
 * INTERFACES.md 14), the call also carries the transfer's expiry, so the account records it as pending:
 * `withdraw({..., transfer: {kind: "to_hl", exp}})` or `hl_withdraw({..., exp})`.
 */
export function nextCall(move: Move, quote: { depositAddress?: string; amountIn: string; amountOut?: string }, musdc: string, hlFloat: string, expMs?: number) {
  const depositAddress = quote.depositAddress;
  if (!depositAddress) return null;
  if (move === "to_hl") {
    return { method: "withdraw", args: { token: musdc, amount: quote.amountIn, receiver: depositAddress, ...(expMs !== undefined && { transfer: { kind: "to_hl", exp: expMs } }) } };
  }
  if (depositAddress.toLowerCase() !== hlFloat) {
    throw new HttpError(502, "bad_quote", `The stand-in gave ${depositAddress} as the deposit address, not its float ${hlFloat}`);
  }
  const units = BigInt(quote.amountIn);
  if (units % HL_UNITS_PER_MICRO !== 0n) throw new HttpError(502, "bad_quote", `amountIn ${quote.amountIn} has more than 6 decimals, so hl_withdraw can't send it exactly`);
  // INTERFACES.md 47.3: with the transfer's expiry goes what the quote says will arrive on NEAR, test USDC here.
  return { method: "hl_withdraw", args: { amount: (units / HL_UNITS_PER_MICRO).toString(), destination: depositAddress.toLowerCase(), ...(expMs !== undefined && { exp: expMs, ...expectOf(musdc, quote.amountOut) }) } };
}

/**
 * INTERFACES.md 47.3 (research/audit.md A12): `expect`, the last argument of the `hl_withdraw` and `evm_withdraw` that
 * start a move home. It is what the quote says will arrive on NEAR: the token's id and the amount in the token's own
 * units. The account keeps it with the transfer, and then counts a deposit that carries the transfer's msg as its
 * arrival only when it is that token and at least 80% of that amount. An account from before 47 ignores it. It is
 * left out when the token isn't one the backend lists, or the amount isn't a whole number above 0: the account
 * refuses such an `expect`, and without one it settles as before.
 */
export function expectOf(token: string | undefined, amount: string | undefined): { expect?: { token: string; amount: string } } {
  return token && typeof amount === "string" && /^\d+$/.test(amount) && BigInt(amount) > 0n ? { expect: { token, amount } } : {};
}

/** Keeps a committed move quote's deposit address and memo, so GET /api/status can find it by the transfer's id. */
function rememberMove(deps: Deps, account: string, transferId: string | null, quote: QuoteResponse) {
  const depositAddress = quote.quote.depositAddress;
  if (!transferId || !depositAddress) return;
  deps.moves?.remember(account, transferId, { depositAddress, ...(quote.quote.depositMemo ? { depositMemo: quote.quote.depositMemo } : {}) });
}

/** The tokens of an account's own settings (`get_config().tokens`): id, the pool's name for it, and its decimals. */
function accountTokens(config: unknown): { id: string; symbol: string; decimals: number }[] {
  const listed = (config as { tokens?: unknown } | null | undefined)?.tokens;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((t) => {
    const row = t as { id?: unknown; symbol?: unknown; decimals?: unknown } | null;
    return row && typeof row.id === "string" && typeof row.symbol === "string" && typeof row.decimals === "number" ? [{ id: row.id, symbol: row.symbol, decimals: row.decimals }] : [];
  });
}

/**
 * INTERFACES.md 51.2: the stand-in's refusal of a move for its size, as an answer the page can tell apart:
 * `400 move_too_large`, with the stand-in's own words (they say the most that can be sent). The stand-in brings at
 * most 0.02 WETH in one move, and can't wrap more test ETH than its float holds. Any other refusal stays 1Click's.
 */
export function moveTooLarge(error: unknown): HttpError | null {
  if (!(error instanceof OneClickError) || error.status !== 400) return null;
  const words = (error.body as { message?: unknown } | null)?.message;
  if (typeof words !== "string" || !/at most .+ in one move|Ask for less/.test(words)) return null;
  return new HttpError(400, "move_too_large", words);
}

/** POST /api/quote {dry, move, account, amount, slippageTolerance?}. */
export async function postMoveQuote(deps: Deps, fields: Record<string, unknown>) {
  const { ids } = deps.config;
  const move = fields.move;
  if (move === "to_evm" || move === "e_home") return postEvmMoveQuote(deps, fields, move);
  if (move !== "to_hl" && move !== "home") throw badRequest('move must be "to_hl", "home", "to_evm" or "e_home"');
  if (typeof fields.dry !== "boolean") throw badRequest("dry must be true (a price) or false (a deposit address)");
  const account = clientAccount(deps, fields.account);
  if (!isU128(fields.amount) || fields.amount === "0") throw badRequest("amount must be a positive whole number of micro-USDC, as a string");
  const slippage = fields.slippageTolerance ?? DEFAULT_SLIPPAGE_BP;
  if (typeof slippage !== "number" || !Number.isInteger(slippage) || slippage < 1 || slippage > 500) {
    throw badRequest("slippageTolerance must be a whole number of basis points from 1 to 500");
  }

  const state = await readState(deps, account);
  const hlAddress = hlAddressOf(state.value);
  if (!hlAddress) throw new HttpError(409, "no_hl_address", `${account} has no Hyperliquid address yet: set it up first (hl_init)`);
  if (move === "home" && loanOpen(state.value.loan)) {
    throw new HttpError(409, "loan_open", "USDC can't come home from Hyperliquid while a loan is open: the account refuses hl_withdraw until Phase 4");
  }
  const musdc = ids.tokens.find((t) => t.symbol === "USDC")!.id;
  // Phase 4: a committed move to or from a Phase 4 account is a pending transfer, named before the call.
  const transferId = fields.dry ? null : nextMoveId(state.value);
  const request = moveQuoteRequest({
    move,
    dry: fields.dry,
    account,
    hlAddress,
    amountMicro: fields.amount,
    musdc,
    hlUsdcAsset: ids.hlUsdcAsset,
    nowMs: deps.now(),
    slippageBp: slippage,
    transferId,
  });
  const quote = await oneClickCall(deps, () => deps.oneClick.quote(request));
  const deadline = Date.parse(quote.quote.deadline ?? request.deadline);
  const expMs = transferId && Number.isFinite(deadline) ? deadline : undefined;
  const next = fields.dry ? null : nextCall(move, quote.quote, musdc, ids.hlFloat, expMs);
  rememberMove(deps, account, transferId, quote);
  return { ...quote, move: { kind: move, account, hl_address: hlAddress, next, transfer_id: transferId, exp_ms: expMs ?? null } };
}

// ---------- Stage 4 (INTERFACES.md 36): POST /api/quote with move "to_evm" | "e_home" ----------

export type EvmMove = "to_evm" | "e_home";

/**
 * POST /api/quote {dry, move: "to_evm" | "e_home", account, token?, amount, slippageTolerance?}: the four moves
 * between the account on NEAR and its own address on Aave's chain, through 1Click (the stand-in on testnet).
 *
 *   to_evm  `token` is a NEAR token of the account: its nBTC (the default), which arrives as WBTC, or as WETH of the
 *           same dollar value when Aave has no room for the WBTC; or its USDC, which arrives as Aave's USDC.
 *   e_home  `token` is an address on Aave's chain: Aave's USDC (the default), which comes home as USDC; or a
 *           collateral token (WBTC, WETH), which comes home as nBTC.
 *
 * INTERFACES.md 51.2, for an account whose own settings list test ETH: `to_evm` also takes test ETH's id as
 * `token`, which arrives as WETH; and `e_home` of a collateral token takes the optional `to`, the NEAR token id it
 * comes home as: test bitcoin (the default, as before) or, for WETH, test ETH. A move the stand-in refuses for its
 * size (it brings at most 0.02 WETH a move) is answered `400 move_too_large` with the stand-in's own words.
 *
 * `amount` is in the token's own units. The address and the Aave settings are read from the chain, so the browser
 * names neither. The answer is the quote, with `move`:
 *   - `next`: the account's next call: `withdraw` with `transfer: {kind: "to_evm", exp}`, or `evm_withdraw` with `exp`;
 *   - `delivers`: {token, symbol, chain, amount}, what arrives and where (the stand-in says when it is WETH);
 *   - `needs_check`: while the account owes our pool, the intent to ask a check for before that call; else null.
 * A committed quote names the transfer first (`move:<n>`) and carries its msg, as the moves to Hyperliquid do.
 */
export async function postEvmMoveQuote(deps: Deps, fields: Record<string, unknown>, move: EvmMove) {
  const { ids } = deps.config;
  if (typeof fields.dry !== "boolean") throw badRequest("dry must be true (a price) or false (a deposit address)");
  const account = clientAccount(deps, fields.account);
  if (!isU128(fields.amount) || fields.amount === "0") throw badRequest("amount must be a positive whole number of the token's own units, as a string");
  const slippage = fields.slippageTolerance ?? DEFAULT_SLIPPAGE_BP;
  if (typeof slippage !== "number" || !Number.isInteger(slippage) || slippage < 1 || slippage > 500) {
    throw badRequest("slippageTolerance must be a whole number of basis points from 1 to 500");
  }
  if (fields.token !== undefined && typeof fields.token !== "string") throw badRequest("token must be a string: a NEAR token id for to_evm, an address on Aave's chain for e_home");
  if (fields.to !== undefined && typeof fields.to !== "string") throw badRequest("to must be a string: the NEAR token id a collateral token comes home as");

  const [state, config] = await Promise.all([readState(deps, account), soft(deps.chain.view<unknown>(account, "get_config"))]);
  const address = hlAddressOf(state.value);
  if (!address) throw new HttpError(409, "no_hl_address", `${account} has no address yet: it gets one with its Hyperliquid address (hl_init), and it is the same on Aave's chain`);
  const aave = aaveConfOf(config?.value);
  if (!aave) throw new HttpError(409, "no_aave", `${account} has no settings for Aave: it was made before Aave was added, so it can't move anything to Aave's chain`);

  const usdc = ids.tokens.find((t) => t.symbol === "USDC")!;
  const nbtc = ids.tokens.find((t) => t.symbol !== "USDC")!;
  // INTERFACES.md 51.2: test ETH is a token of the account's own settings (the backend's own list has USDC and
  // bitcoin only). An account made before the five tokens has none, and moves no ether.
  const own = accountTokens(config?.value);
  const eth = own.find((t) => t.symbol === "ETH") ?? null;
  const chain = EVM_TEST_CHAINS[aave.chainId] ?? `chain ${aave.chainId}`;
  const symbolOn = (token: string) => [aave.usdc, ...aave.collateral].find((t) => t.address === token)?.symbol ?? token;
  // A committed move is a pending transfer, named before the call (INTERFACES.md 14).
  const transferId = fields.dry ? null : nextMoveId(state.value);
  const common = {
    dry: fields.dry,
    swapType: "EXACT_INPUT" as const,
    slippageTolerance: slippage,
    depositType: "ORIGIN_CHAIN" as const,
    refundType: "ORIGIN_CHAIN" as const,
    recipientType: "DESTINATION_CHAIN" as const,
    amount: fields.amount,
    deadline: new Date(deps.now() + QUOTE_DEADLINE_MS).toISOString(),
  };

  let request: QuoteRequest;
  let token: string;
  if (move === "to_evm") {
    token = (fields.token as string | undefined) ?? nbtc.id;
    const wbtc = aave.collateral.find((t) => t.symbol === "WBTC") ?? aave.collateral[0];
    const weth = aave.collateral.find((t) => t.symbol === "WETH");
    const isEth = eth !== null && token === eth.id;
    if (token !== usdc.id && token !== nbtc.id && !isEth) throw badRequest(`token must be ${eth ? `${nbtc.id}, ${eth.id}` : nbtc.id} or ${usdc.id}: the tokens the account can move to Aave's chain`);
    if (token === nbtc.id && !wbtc) throw new HttpError(409, "no_aave", `${account}'s Aave settings list no collateral token for its bitcoin to arrive as`);
    // Test ETH arrives as WETH (the stand-in wraps its own test ETH: at most 0.02 a move).
    if (isEth && !weth) throw new HttpError(409, "no_aave", `${account}'s Aave settings list no WETH for its ether to arrive as`);
    const arrivesAs = token === usdc.id ? aave.usdc.address : isEth ? weth!.address : wbtc!.address;
    // The stand-in refunds a NEAR origin with the msg, so the account learns of a refund (as for to_hl).
    request = { ...common, originAsset: `nep141:${token}`, destinationAsset: baseSepoliaAssetId(arrivesAs), refundTo: account, recipient: address, ...(transferId ? { customRecipientMsg: transferMsg(transferId) } : {}) };
  } else {
    token = ((fields.token as string | undefined) ?? aave.usdc.address).toLowerCase();
    const known = token === aave.usdc.address || aave.collateral.some((t) => t.address === token);
    if (!known) throw badRequest(`token must be a token of the account's Aave settings on ${chain}: ${[aave.usdc, ...aave.collateral].map((t) => `${t.symbol} ${t.address}`).join(", ")}`);
    // What it comes home as: Aave's USDC as USDC; a collateral token as bitcoin, or, with `to` (INTERFACES.md 51.2),
    // as the token of the account's own settings that `to` names: test bitcoin, or test ETH for WETH.
    const to = fields.to as string | undefined;
    let home = token === aave.usdc.address ? usdc.id : nbtc.id;
    if (to !== undefined && token === aave.usdc.address) {
      if (to !== usdc.id) throw badRequest(`USDC on ${chain} comes home as USDC: leave "to" out`);
    } else if (to !== undefined && to !== nbtc.id) {
      if (!eth || to !== eth.id) throw badRequest(`to must be ${eth ? `${nbtc.id} or ${eth.id}` : nbtc.id}: what a collateral token on ${chain} can come home as`);
      if (symbolOn(token) !== "WETH") throw badRequest(`only WETH comes home as ether: ${symbolOn(token)} comes home as bitcoin`);
      home = eth.id;
    }
    // Delivered on NEAR with the msg, which settles the transfer, as for `home`.
    request = { ...common, originAsset: baseSepoliaAssetId(token), destinationAsset: `nep141:${home}`, refundTo: address, recipient: account, customRecipientMsg: transferId ? transferMsg(transferId) : DEPOSIT_MSG };
  }

  const quote = await oneClickCall(deps, () => deps.oneClick.quote(request)).catch((error: unknown) => {
    throw moveTooLarge(error) ?? error;
  });
  const deadline = Date.parse(quote.quote.deadline ?? request.deadline);
  const expMs = transferId && Number.isFinite(deadline) ? deadline : undefined;

  // What arrives and where: the quote's own destination, which the stand-in changes to WETH when Aave has no room for WBTC.
  const arrives = quote.quoteRequest?.destinationAsset ?? request.destinationAsset;
  const onBase = baseSepoliaAddress(arrives);
  const nearToken = [...ids.tokens, ...own].find((t) => `nep141:${t.id}` === arrives);
  const delivers = onBase ? { token: onBase, symbol: symbolOn(onBase), chain, amount: quote.quote.amountOut } : { token: nearToken?.id ?? arrives, symbol: nearToken?.symbol ?? arrives, chain: "NEAR", amount: quote.quote.amountOut };

  let next: { method: string; args: Record<string, unknown> } | null = null;
  const depositAddress = quote.quote.depositAddress;
  if (!fields.dry && depositAddress) {
    if (move === "to_evm") {
      next = { method: "withdraw", args: { token, amount: quote.quote.amountIn, receiver: depositAddress, ...(expMs !== undefined && { transfer: { kind: "to_evm", exp: expMs } }) } };
    } else {
      if (!/^0x[0-9a-fA-F]{40}$/.test(depositAddress)) throw new HttpError(502, "bad_quote", `The stand-in gave ${depositAddress} as the deposit address, which is no address on ${chain}`);
      // INTERFACES.md 47.3: with the expiry goes what the quote delivers on NEAR, so only that settles the transfer.
      next = { method: "evm_withdraw", args: { token, amount: quote.quote.amountIn, to: depositAddress.toLowerCase(), ...(expMs !== undefined && { exp: expMs, ...expectOf(nearToken?.id, delivers.amount) }) } };
    }
  }
  // While the account owes our pool, taking a token out needs a verdict for exactly that (INTERFACES.md 4 and 33).
  const needsCheck = !loanOpen(state.value.loan) ? null : move === "to_evm" ? { withdraw: { token, amount: fields.amount } } : { evm_withdraw: { token, amount: fields.amount } };
  if (next) rememberMove(deps, account, transferId, quote);
  return { ...quote, move: { kind: move, account, hl_address: address, next, transfer_id: transferId, exp_ms: expMs ?? null, delivers, needs_check: needsCheck } };
}
