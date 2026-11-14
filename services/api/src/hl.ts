// Hyperliquid's HTTP API, testnet only (INTERFACES.md 11): the info reads behind GET /api/hl/:account and
// GET /api/markets, and the one write the backend makes, POST /exchange with an action the account contract
// signed through Chain Signatures (POST /api/hl/submit). A plain fetch client, so the tests fake it.
//
// Every info request is POST <api>/info with a JSON body {"type": ..., ...}. The types used here, each checked
// against Hyperliquid's docs (HL = https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api) or, where
// the docs say nothing, against both SDKs (@nktkas/hyperliquid 0.33.3 esm/api/info/_methods/*.d.ts, and
// hyperliquid-python-sdk hyperliquid/info.py):
//
//   clearinghouseState     {"type","user"}  HL info-endpoint/perpetuals#retrieve-users-perpetuals-account-summary
//                          -> marginSummary, crossMarginSummary {accountValue,totalNtlPos,totalRawUsd,totalMarginUsed},
//                             crossMaintenanceMarginUsed, withdrawable, assetPositions[].position, time
//   spotClearinghouseState {"type","user"}  HL info-endpoint/spot#retrieve-a-users-token-balances
//                          -> balances[] {coin,token,total,hold,entryNtl}
//   userAbstraction        {"type","user"}  HL info-endpoint#query-a-users-abstraction-state
//                          -> "unifiedAccount" | "portfolioMargin" | "disabled" | "default" | "dexAbstraction"
//   frontendOpenOrders     {"type","user"}  HL info-endpoint#retrieve-a-users-open-orders-with-additional-frontend-info
//                          -> [{coin,side "B"|"A",limitPx,sz,oid,timestamp,origSz,reduceOnly,orderType,tif,cloid,...}]
//   userFills              {"type","user"}  HL info-endpoint#retrieve-a-users-fills: "at most 2000 most recent fills",
//                          newest first -> [{coin,px,sz,side,time,startPosition,dir,closedPnl,hash,oid,crossed,fee,tid,...}]
//   extraAgents            {"type","user"}  not in HL's docs. Python SDK Info.extra_agents and @nktkas extraAgents.d.ts:
//                          -> [{name, address, validUntil}]. The Python SDK's recorded answer
//                          (tests/cassettes/info_test/test_extra_agents.yaml) shows the name without its
//                          " valid_until <ms>" suffix, which comes back as validUntil.
//   metaAndAssetCtxs       {"type"}         HL info-endpoint/perpetuals#retrieve-perpetuals-asset-contexts-includes-mark-price-current-funding-open-interest-etc
//                          -> [{universe:[{name,szDecimals,maxLeverage,marginTableId,isDelisted?}]},
//                              [{markPx,oraclePx,midPx,dayNtlVlm,funding,openInterest,prevDayPx,...}]]
//
// Weights (research/hyperliquid.md 6): 2 for clearinghouseState and spotClearinghouseState, 20 for the others,
// against 1,200 a minute per IP. So reads are cached for a few seconds, and a page polling every 10 s stays far
// below the limit.

export type Hex = `0x${string}`;

export class HlError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HlError";
    this.status = status;
  }
}

/** What the handlers need from Hyperliquid; tests pass a fake. */
export interface HlApi {
  /** POST /info. Throws HlError when Hyperliquid fails or answers something that isn't JSON. */
  info<T>(body: Record<string, unknown>): Promise<T>;
  /** POST /exchange. Hyperliquid's answer as it came, with the HTTP status: it says "err" in the body, with HTTP 200. */
  exchange(body: unknown): Promise<{ status: number; body: unknown }>;
}

export class HlHttp implements HlApi {
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: { apiUrl: string; fetch?: typeof fetch; timeoutMs?: number }) {
    this.#apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async info<T>(body: Record<string, unknown>): Promise<T> {
    const { status, text } = await this.#post("/info", body);
    if (status !== 200) throw new HlError(502, `Hyperliquid's ${String(body.type)} answered HTTP ${status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HlError(502, `Hyperliquid's ${String(body.type)} answered something that isn't JSON`);
    }
  }

  async exchange(body: unknown): Promise<{ status: number; body: unknown }> {
    const { status, text } = await this.#post("/exchange", body);
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Hyperliquid answers a malformed body (HTTP 422) in plain text: pass the words on.
    }
    return { status, body: parsed };
  }

  async #post(path: string, body: unknown): Promise<{ status: number; text: string }> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new HlError(504, `Hyperliquid (${new URL(this.#apiUrl).host}) did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { status: response.status, text: await response.text() };
  }
}

/** Keeps each answer for a while, and shares a read already under way. A failed read isn't kept. */
export class TtlCache {
  readonly #now: () => number;
  readonly #entries = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get<T>(key: string, ttlMs: number, read: () => Promise<T>): Promise<T> {
    const hit = this.#entries.get(key);
    if (hit && this.#now() - hit.at < ttlMs) return hit.value as Promise<T>;
    if (this.#entries.size > 2_000) this.#entries.clear();
    const value = read();
    this.#entries.set(key, { at: this.#now(), value });
    value.catch(() => {
      if (this.#entries.get(key)?.value === value) this.#entries.delete(key);
    });
    return value;
  }
}

/** How long each read is kept. Positions, orders and fills move; the mode and the agents rarely do. */
export const HL_TTL_MS = {
  clearinghouseState: 2_000,
  spotClearinghouseState: 2_000,
  frontendOpenOrders: 2_000,
  userFills: 4_000,
  userAbstraction: 30_000,
  extraAgents: 10_000,
  metaAndAssetCtxs: 15_000,
} as const;

export type UserInfoType = "clearinghouseState" | "spotClearinghouseState" | "userAbstraction" | "frontendOpenOrders" | "userFills" | "extraAgents";
export const USER_INFO_TYPES: UserInfoType[] = ["clearinghouseState", "spotClearinghouseState", "userAbstraction", "frontendOpenOrders", "userFills", "extraAgents"];

/** An info read for one user, through the cache. `fresh` skips the cache (after an action the page waits on). */
export function userInfo<T>(hl: HlApi, cache: TtlCache, type: UserInfoType, user: Hex, fresh = false): Promise<T> {
  return cache.get(`${type}:${user}`, fresh ? 0 : HL_TTL_MS[type], () => hl.info<T>({ type, user }));
}

export function marketInfo<T>(hl: HlApi, cache: TtlCache): Promise<T> {
  return cache.get("metaAndAssetCtxs", HL_TTL_MS.metaAndAssetCtxs, () => hl.info<T>({ type: "metaAndAssetCtxs" }));
}

// ---------- the shapes the backend reads (the parts it uses) ----------

export interface ClearinghouseState {
  marginSummary: { accountValue: string; totalNtlPos: string; totalRawUsd: string; totalMarginUsed: string };
  crossMarginSummary: { accountValue: string; totalNtlPos: string; totalRawUsd: string; totalMarginUsed: string };
  crossMaintenanceMarginUsed: string;
  withdrawable: string;
  assetPositions: {
    type: string;
    position: {
      coin: string;
      szi: string;
      leverage: { type: string; value: number };
      entryPx: string;
      positionValue: string;
      unrealizedPnl: string;
      liquidationPx: string | null;
      marginUsed: string;
      maxLeverage: number;
      cumFunding?: { allTime: string; sinceOpen: string; sinceChange: string };
    };
  }[];
  time: number;
}

export interface SpotClearinghouseState {
  balances: { coin: string; token?: number; total: string; hold: string; entryNtl?: string }[];
}

export interface ExtraAgent {
  name: string;
  address: string;
  validUntil: number | null;
}

export interface PerpMeta {
  universe: { name: string; szDecimals: number; maxLeverage: number; marginTableId?: number; isDelisted?: boolean; onlyIsolated?: boolean }[];
}

export interface AssetCtx {
  markPx: string;
  oraclePx: string;
  midPx: string | null;
  dayNtlVlm: string;
  funding: string;
  openInterest: string;
  prevDayPx: string;
}
