// A small NEAR JSON-RPC client for views. The backend only reads: it holds no NEAR key and signs nothing.
//
// A view on a contract that isn't live yet fails in one of three ways (seen on testnet, 7 Nov):
//   - no account:       a JSON-RPC error whose cause is UNKNOWN_ACCOUNT;
//   - no contract code: a result whose `error` says CodeDoesNotExist (newer nodes: cause NO_CONTRACT_CODE);
//   - no such method:   a result whose `error` says MethodNotFound (an older or different contract).
// All three become NotDeployedError, so the web app can say "not deployed yet" instead of "error".

/** The contract isn't there yet, or isn't the one we expect. */
export class NotDeployedError extends Error {
  readonly contract: string;
  readonly reason: string;

  constructor(contract: string, reason: string) {
    super(`${contract} is not deployed yet: ${reason}`);
    this.name = "NotDeployedError";
    this.contract = contract;
    this.reason = reason;
  }
}

/** The RPC node failed or answered something we can't read. */
export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcError";
  }
}

/** The contract ran and panicked. */
export class ViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewError";
  }
}

export interface ViewResult<T> {
  value: T;
  blockHeight: number;
}

export interface AccountView {
  exists: boolean;
  hasCode: boolean;
  blockHeight: number;
}

export interface BlockView {
  height: number;
  /** The block's timestamp in ms. The gateway measures an order's expiry against the final block's (INTERFACES.md 9). */
  timeMs: number;
}

/** What the handlers need from the chain; tests pass a fake. */
export interface ChainReader {
  view<T>(contractId: string, method: string, args?: Record<string, unknown>): Promise<ViewResult<T>>;
  account(accountId: string): Promise<AccountView>;
  /** The latest final block. */
  finalBlock(): Promise<BlockView>;
  /**
   * Privacy level 1 (INTERFACES.md 48.2, step 5): what kind of access key `publicKey` ("ed25519:…") is on
   * `accountId` at the latest final block. "full": a full-access key. "function_call": a key that can only call
   * some contract. "none": no such key, or no such account. It throws when the RPC doesn't answer or answers
   * something else: that is never a yes.
   */
  accessKey(accountId: string, publicKey: string): Promise<AccessKeyKind>;
}

export type AccessKeyKind = "full" | "function_call" | "none";

/** The code hash of an account with no contract. */
const NO_CODE = "11111111111111111111111111111111";

/** The RPC said "too many requests" (429) or "busy" (503): worth asking again after a pause. */
class RpcBusyError extends RpcError {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
  }
}

export class NearRpc implements ChainReader {
  readonly #url: string;
  readonly #host: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #retryDelaysMs: readonly number[];
  readonly #cacheMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Reads made in the last moment, by method and params: answered or still on their way. */
  readonly #recent = new Map<string, { at: number; result: Promise<Record<string, unknown>> }>();

  constructor(options: {
    url: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    /** Pauses before each new try after a 429 or 503. Free RPC providers limit how often we may call them. */
    retryDelaysMs?: readonly number[];
    /** How long a read's answer is shared with the same read asked again (0 turns sharing off). */
    cacheMs?: number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.#url = options.url;
    this.#host = new URL(options.url).host; // errors name the host only: the URL can carry a key
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#retryDelaysMs = options.retryDelaysMs ?? [400, 1_000, 2_000];
    this.#cacheMs = options.cacheMs ?? 1_500;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Calls a view method at the latest final block and decodes its JSON answer. */
  async view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<ViewResult<T>> {
    const result = await this.#query(contractId, {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    if (typeof result.error === "string") throw classifyViewError(contractId, method, result.error);
    if (!Array.isArray(result.result)) throw new RpcError(`${contractId}.${method}: the RPC answer has no result`);
    const text = Buffer.from(result.result as number[]).toString("utf8");
    try {
      return { value: (text ? JSON.parse(text) : null) as T, blockHeight: Number(result.block_height) };
    } catch {
      throw new ViewError(`${contractId}.${method} returned something that isn't JSON`);
    }
  }

  /** Whether an account exists and has a contract. */
  async account(accountId: string): Promise<AccountView> {
    try {
      const result = await this.#query(accountId, { request_type: "view_account", finality: "final", account_id: accountId });
      return { exists: true, hasCode: result.code_hash !== NO_CODE, blockHeight: Number(result.block_height) };
    } catch (error) {
      if (error instanceof NotDeployedError && error.reason === "no account") return { exists: false, hasCode: false, blockHeight: 0 };
      throw error;
    }
  }

  /**
   * JSON-RPC `query` with `view_access_key`. Read live on testnet on 13 Nov: a key that is there answers
   * `{"permission": "FullAccess", "nonce": …}` (a function-call key has an object under `permission`), and a key
   * that isn't answers a result with an `error` text. Newer nodes answer that case as a JSON-RPC error whose cause
   * is UNKNOWN_ACCESS_KEY, and an account that isn't there as UNKNOWN_ACCOUNT.
   */
  async accessKey(accountId: string, publicKey: string): Promise<AccessKeyKind> {
    let result: Record<string, unknown>;
    try {
      result = await this.#query(accountId, { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
    } catch (error) {
      if (error instanceof NotDeployedError && error.reason === "no account") return "none";
      if (error instanceof RpcError && error.message.includes("UNKNOWN_ACCESS_KEY")) return "none";
      throw error;
    }
    if (typeof result.error === "string") {
      if (/does not exist/i.test(result.error)) return "none";
      throw new RpcError(`NEAR RPC (${this.#host}) couldn't read the access key`);
    }
    if (result.permission === "FullAccess") return "full";
    if (result.permission && typeof result.permission === "object") return "function_call";
    throw new RpcError(`NEAR RPC (${this.#host}) answered an access key without a permission`);
  }

  /** JSON-RPC `block` at finality final: its height and timestamp. */
  async finalBlock(): Promise<BlockView> {
    const result = await this.#call("block", "the final block", { finality: "final" });
    const header = result.header as { height?: unknown; timestamp_nanosec?: unknown } | undefined;
    if (typeof header?.height !== "number" || typeof header.timestamp_nanosec !== "string") {
      throw new RpcError(`NEAR RPC (${this.#host}) answered a block without a height or timestamp`);
    }
    return { height: header.height, timeMs: Number(BigInt(header.timestamp_nanosec) / 1_000_000n) };
  }

  #query(accountId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#call("query", accountId, params);
  }

  /**
   * One read. The same read asked again within `cacheMs` (two tabs polling one account, or one reply reading a
   * contract twice) shares the first one's answer, so the free RPC's rate limit is reached less often. Only
   * answers are shared: a failed read is forgotten at once.
   */
  #call(method: string, accountId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.#cacheMs <= 0) return this.#callWithRetry(method, accountId, params);
    const key = `${method} ${JSON.stringify(params)}`;
    const now = Date.now();
    const hit = this.#recent.get(key);
    if (hit && now - hit.at < this.#cacheMs) return hit.result;
    const result = this.#callWithRetry(method, accountId, params);
    this.#recent.set(key, { at: now, result });
    result.catch(() => {
      if (this.#recent.get(key)?.result === result) this.#recent.delete(key);
    });
    if (this.#recent.size > 500) {
      for (const [k, v] of this.#recent) if (now - v.at >= this.#cacheMs) this.#recent.delete(k);
    }
    return result;
  }

  /** Asks again after a pause when the RPC answers 429 or 503, up to `retryDelaysMs.length` more times. */
  async #callWithRetry(method: string, accountId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#callOnce(method, accountId, params);
      } catch (error) {
        if (!(error instanceof RpcBusyError) || attempt >= this.#retryDelaysMs.length) {
          throw error instanceof RpcBusyError ? new RpcError(error.message) : error;
        }
        await this.#sleep(error.retryAfterMs ?? this.#retryDelaysMs[attempt]!);
      }
    }
  }

  async #callOnce(method: string, accountId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "pb-api", method, params }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new RpcError(`NEAR RPC (${this.#host}) did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 429 || response.status === 503) {
      // Retry-After is in seconds; wait at most 3 s, so a page's read still answers in time.
      const seconds = Number(response.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 3_000) : null;
      throw new RpcBusyError(`NEAR RPC (${this.#host}) answered HTTP ${response.status}`, retryAfterMs);
    }
    if (!response.ok) throw new RpcError(`NEAR RPC (${this.#host}) answered HTTP ${response.status}`);

    let body: { result?: Record<string, unknown>; error?: { name?: string; cause?: { name?: string }; data?: unknown; message?: string } };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new RpcError(`NEAR RPC (${this.#host}) answered something that isn't JSON`);
    }
    if (body.error) {
      const cause = body.error.cause?.name;
      if (cause === "UNKNOWN_ACCOUNT") throw new NotDeployedError(accountId, "no account");
      if (cause === "NO_CONTRACT_CODE") throw new NotDeployedError(accountId, "no contract code");
      const detail = typeof body.error.data === "string" ? body.error.data : body.error.message ?? "unknown error";
      if (cause === "CONTRACT_EXECUTION_ERROR") {
        throw classifyViewError(accountId, String(params.method_name ?? "?"), detail);
      }
      throw new RpcError(`NEAR RPC (${this.#host}): ${cause ?? body.error.name ?? "error"}: ${detail}`);
    }
    if (!body.result) throw new RpcError(`NEAR RPC (${this.#host}) answered without a result`);
    return body.result;
  }
}

function classifyViewError(contractId: string, method: string, text: string): Error {
  if (text.includes("CodeDoesNotExist")) return new NotDeployedError(contractId, "no contract code");
  if (text.includes("MethodNotFound")) return new NotDeployedError(contractId, `its contract has no ${method} method`);
  const panic = /panic_msg: "(.*)" \}/.exec(text)?.[1];
  return new ViewError(`${contractId}.${method} failed: ${panic ?? text}`);
}
