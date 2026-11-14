// A small typed client for the 1Click API. It talks to the real API, or to our testnet shim,
// which serves the same endpoints (PLAN.md 5.4). The API key goes in the X-API-Key header and
// must stay on the server: the constructor refuses a key when it runs in a browser.
import {
  isTerminal,
  type QuoteRequest,
  type QuoteResponse,
  type StatusResponse,
  type SubmitDepositRequest,
  type TokenInfo,
} from "./types.js";

export interface OneClickOptions {
  /** For example https://1click.chaindefuser.com, or the shim's http://localhost:8787. */
  baseUrl: string;
  /** Our 1Click partner key (ONECLICK_JWT). Leave it out for keyless calls. */
  apiKey?: string;
  /** Defaults to the global fetch; tests pass a fake. */
  fetch?: typeof fetch;
  /** Per-request timeout. Defaults to 30 s. */
  timeoutMs?: number;
}

/** An HTTP error from 1Click, with the status code and the body it sent back. */
export class OneClickError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, path: string) {
    super(`1Click ${path} answered HTTP ${status}: ${describeBody(body)}`);
    this.name = "OneClickError";
    this.status = status;
    this.body = body;
  }
}

export class OneClickClient {
  readonly baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: OneClickOptions) {
    if (options.apiKey && "window" in globalThis) {
      throw new Error("The 1Click key is server-side only: never build a keyed client in a browser");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey || undefined;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** GET /v0/tokens: every asset 1Click can move, with decimals and a display price. */
  tokens(): Promise<TokenInfo[]> {
    return this.#request("GET", "/v0/tokens");
  }

  /** POST /v0/quote: a dry quote (price only) or a committed one with a deposit address. */
  quote(request: QuoteRequest): Promise<QuoteResponse> {
    return this.#request("POST", "/v0/quote", request);
  }

  /** POST /v0/deposit/submit: report the deposit's transaction hash, so it is picked up sooner. */
  submitDeposit(request: SubmitDepositRequest): Promise<StatusResponse> {
    return this.#request("POST", "/v0/deposit/submit", request);
  }

  /** GET /v0/status for one deposit address (and memo, where the quote gave one). */
  status(depositAddress: string, depositMemo?: string | null): Promise<StatusResponse> {
    const query = new URLSearchParams({ depositAddress });
    if (depositMemo) query.set("depositMemo", depositMemo);
    return this.#request("GET", `/v0/status?${query}`);
  }

  async #request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "pb-oneclick/0.1" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.#apiKey) headers["X-API-Key"] = this.#apiKey;

    const response = await this.#fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const text = await response.text();
    const parsed = parseJson(text);
    if (!response.ok) throw new OneClickError(response.status, parsed ?? text, path.split("?")[0]);
    if (parsed === undefined) throw new OneClickError(response.status, text, path.split("?")[0]);
    return parsed as T;
  }
}

export interface WaitOptions {
  depositMemo?: string | null;
  /** How often to ask. PLAN.md 5.4 polls every 5-10 s. */
  intervalMs?: number;
  /** Give up after this long. */
  timeoutMs?: number;
  /** Stop early when this returns true (default: when the status is terminal). */
  until?: (status: StatusResponse) => boolean;
  /** Called whenever the status changes. */
  onChange?: (status: StatusResponse) => void;
  /** Tests replace the clock and the wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Polls GET /v0/status until the swap settles (or `until` says stop), and returns the last answer. */
export async function waitForStatus(
  client: OneClickClient,
  depositAddress: string,
  options: WaitOptions = {},
): Promise<StatusResponse> {
  const intervalMs = options.intervalMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const until = options.until ?? ((s: StatusResponse) => isTerminal(s.status));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;

  const giveUpAt = now() + timeoutMs;
  let last: StatusResponse | undefined;
  for (;;) {
    const current = await client.status(depositAddress, options.depositMemo);
    if (current.status !== last?.status) options.onChange?.(current);
    last = current;
    if (until(current)) return current;
    if (now() >= giveUpAt) {
      throw new Error(`Gave up after ${Math.round(timeoutMs / 1000)} s: ${depositAddress} is still ${current.status}`);
    }
    await sleep(intervalMs);
  }
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describeBody(body: unknown): string {
  if (body && typeof body === "object" && "message" in body) return String((body as { message: unknown }).message);
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return (text ?? "").slice(0, 200) || "(empty body)";
}
