// Runs pb-gateway's keeper modes, `deleverage` and `cancel_risky` (INTERFACES.md 16), over OutLayer's HTTPS API with
// our payment key. The same request as the backend's (services/api/src/outlayer.ts, measured on testnet on 7 Nov):
//
//   POST <api>/call/<owner>/<project>
//   X-Payment-Key: owner:nonce:secret         (never logged; runs execute as the key's owner, pbf-keeper.testnet)
//   X-Compute-Limit: <micro-USD>
//   {"input": {...}, "async": true, "resource_limits": {...}, "version_key": "<sha256>"}
//
// pb-gateway answers these modes only over HTTPS for pbf-keeper.testnet, so the keeper's own key is the one that works.
//
// The run is asked for, then asked about (since 11 Nov), as in the backend's client. A run can sit in OutLayer's
// queue for a minute or more, and a call that waited for its answer on one connection was cut off at about 100 s. So
// the submit goes with "async": true and answers at once with {call_id, status: "pending", poll_url,
// attestation_url}; GET <api>/calls/<id>, with the same key, answers `pending` until the run ends, then the object a
// synchronous call gave: {call_id, status, output | error, compute_cost, instructions, time_ms, attestation_url}.
// The runner asks every 2 seconds for up to OUTLAYER_WAIT_MS in all (180 s unless set).
//
// 503 on the submit is safe to retry, once; 500 leaves a run's fate unknown, so it is not retried here. A poll that
// fails is only a miss: the run goes on, and the runner asks again. A run still pending when the time is up is
// reported as OutLayer not answering; it may still run, and the gateway's own step records stop a repeat from
// placing anything twice.

/** The same limits the account contract passes to request_execution (INTERFACES.md 4). */
export const RESOURCE_LIMITS = { max_instructions: 2_000_000_000, max_memory_mb: 256, max_execution_seconds: 20 } as const;
/** $0.01 at most per run. A gateway run costs about $0.001. */
export const COMPUTE_LIMIT_MICRO_USD = 10_000;
/** How long a run may take from its submit to its end, queue included, unless OUTLAYER_WAIT_MS says otherwise. */
export const DEFAULT_OUTLAYER_WAIT_MS = 180_000;
/** How often a pending run is asked about. */
export const OUTLAYER_POLL_MS = 2_000;

export interface OutLayerRun {
  callId: string | null;
  status: string;
  output: unknown;
  error: string | null;
  computeCost: string | null;
  timeMs: number | null;
  /** The run's TDX attestation record, as a full URL. */
  attestationUrl: string | null;
}

export class OutLayerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "OutLayerError";
    this.status = status;
  }
}

export interface OutLayerOptions {
  apiUrl: string;
  paymentKey: string;
  fetch?: typeof fetch;
  /** One request's own limit. The submit and every poll answer at once, so this is short. */
  timeoutMs?: number;
  /** The whole run's limit, from the submit to its end (OUTLAYER_WAIT_MS). */
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class OutLayerRunner {
  readonly apiUrl: string;
  readonly #paymentKey: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #waitMs: number;
  readonly #pollMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  constructor(options: OutLayerOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.#paymentKey = options.paymentKey;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#waitMs = options.waitMs ?? DEFAULT_OUTLAYER_WAIT_MS;
    this.#pollMs = options.pollMs ?? OUTLAYER_POLL_MS;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
  }

  /** One run: submitted, then asked about every 2 seconds until it ends. */
  async run(projectId: string, input: unknown, versionKey?: string): Promise<OutLayerRun> {
    const body: Record<string, unknown> = { input, async: true, resource_limits: RESOURCE_LIMITS };
    if (versionKey) body.version_key = versionKey;
    const started = this.#now();
    let response = await this.#send(`${this.apiUrl}/call/${projectId}`, "POST", body);
    if (response.status === 503) {
      await this.#sleep(1_000);
      response = await this.#send(`${this.apiUrl}/call/${projectId}`, "POST", body);
    }
    const submitted = await this.#answer(response);
    const callId = typeof submitted.call_id === "string" ? submitted.call_id : null;
    const attestation = typeof submitted.attestation_url === "string" ? submitted.attestation_url : null;

    // Anything but `pending` is the run's end, on the submit's own answer too.
    let answer = submitted;
    let miss: string | null = null;
    while (answer.status === "pending") {
      if (!callId) throw new OutLayerError(502, "OutLayer said the run is pending but gave no call id to ask about");
      const waited = this.#now() - started;
      if (waited >= this.#waitMs) {
        throw new OutLayerError(504, `OutLayer did not answer: the run was still waiting its turn after ${Math.round(waited / 1000)} s (call ${callId}${miss ? `; the last time it was asked about, ${miss}` : ""}). It may still run`);
      }
      await this.#sleep(this.#pollMs);
      const path = typeof submitted.poll_url === "string" ? submitted.poll_url : `/calls/${callId}`;
      const polled = await this.#poll(new URL(path, `${this.apiUrl}/`).toString());
      if (typeof polled === "string") miss = polled;
      else answer = polled;
    }

    const finalAttestation = typeof answer.attestation_url === "string" ? answer.attestation_url : attestation;
    return {
      callId: typeof answer.call_id === "string" ? answer.call_id : callId,
      status: typeof answer.status === "string" ? answer.status : "unknown",
      output: typeof answer.output === "string" ? (parseJson(answer.output) ?? answer.output) : (answer.output ?? null),
      error: answer.error === undefined || answer.error === null ? null : describe(answer.error),
      computeCost: answer.compute_cost === undefined || answer.compute_cost === null ? null : String(answer.compute_cost),
      timeMs: typeof answer.time_ms === "number" ? answer.time_ms : null,
      attestationUrl: finalAttestation === null ? null : new URL(finalAttestation, `${this.apiUrl}/`).toString(),
    };
  }

  /** The attestation of an on-chain run, by the transaction that asked for it (research/outlayer.md 7). */
  attestationByTx(txHash: string): string {
    return `${this.apiUrl}/attestations/by-tx/${txHash}`;
  }

  /** One question about a pending run: its answer, or in words why this one was a miss (the run itself goes on). */
  async #poll(url: string): Promise<Record<string, unknown> | string> {
    let response: Response;
    try {
      response = await this.#send(url, "GET");
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    // The key refused is the end of it. A busy or failing API, or one that doesn't know the call yet, is only a miss.
    if ([401, 402, 403].includes(response.status)) return this.#answer(response);
    if (!response.ok) return `OutLayer answered HTTP ${response.status}${response.status === 404 ? " (it doesn't know the call)" : ""}`;
    try {
      return await this.#answer(response);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** A response as its JSON object. Throws, in the words callers know, for a refusal or anything that isn't JSON. */
  async #answer(response: Response): Promise<Record<string, unknown>> {
    const text = this.#scrub(await response.text());
    const parsed = parseJson(text);
    if (!response.ok) {
      const detail = describe(parsed ?? text);
      throw new OutLayerError(response.status, `OutLayer answered HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    if (!parsed || typeof parsed !== "object") throw new OutLayerError(502, "OutLayer answered something that isn't JSON");
    return parsed as Record<string, unknown>;
  }

  async #send(url: string, method: "GET" | "POST", body?: unknown): Promise<Response> {
    try {
      return await this.#fetch(url, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          Accept: "application/json",
          "X-Payment-Key": this.#paymentKey,
          ...(method === "POST" ? { "X-Compute-Limit": String(COMPUTE_LIMIT_MICRO_USD) } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new OutLayerError(504, `OutLayer did not answer: ${this.#scrub(error instanceof Error ? error.message : String(error))}`);
    }
  }

  /** Takes the payment key out of any text that might be logged. */
  #scrub(text: string): string {
    const secret = this.#paymentKey.split(":").pop() ?? "";
    let clean = text.split(this.#paymentKey).join("<payment key>");
    if (secret.length >= 16) clean = clean.split(secret).join("<payment key>");
    return clean;
  }
}

/** The on-chain attestation link for a request_check transaction. */
export function attestationByTx(apiUrl: string, txHash: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/attestations/by-tx/${txHash}`;
}

/** pb-gateway's answer, sorted into what the keeper does next (INTERFACES.md 9 and 16). */
export interface GatewayVerdict {
  ok: boolean;
  /** Worth trying again on a later tick: another order in flight (P0), a failed read, Hyperliquid or OutLayer. */
  retry: boolean;
  /** The plan can't run as it is (for example P2: the price left the band): ask for a new plan. */
  replan: boolean;
  code: string | null;
  reason: string | null;
}

/** Worth another run later: another order in flight (P0), a failed read, Hyperliquid, or 60 orders a minute (P10). */
const RETRY_CODES = ["P0", "READ", "HL", "P10"];

/**
 * The gateway's answer for the keeper. `deleverage` answers ok:true even when it refuses a step, and lists those in
 * `refused` (INTERFACES.md 16, as built): HL or P10 may go on a later run; P2, P3 or INPUT need a new plan.
 */
export function readGatewayAnswer(output: unknown): GatewayVerdict {
  const o = (output ?? {}) as { ok?: unknown; code?: unknown; reason?: unknown; refused?: unknown };
  if (o.ok === true) {
    const refused = Array.isArray(o.refused) ? (o.refused as { code?: unknown; reason?: unknown }[]) : [];
    if (refused.length === 0) return { ok: true, retry: false, replan: false, code: null, reason: null };
    const lasting = refused.find((r) => !RETRY_CODES.includes(String(r.code)));
    const first = lasting ?? refused[0]!;
    const code = typeof first.code === "string" ? first.code : null;
    const reason = typeof first.reason === "string" ? first.reason : null;
    return lasting ? { ok: false, retry: false, replan: true, code, reason } : { ok: false, retry: true, replan: false, code, reason };
  }
  const code = typeof o.code === "string" ? o.code : null;
  const reason = typeof o.reason === "string" ? o.reason : output === undefined || output === null ? "no answer" : null;
  if (code && RETRY_CODES.includes(code)) return { ok: false, retry: true, replan: false, code, reason };
  return { ok: false, retry: false, replan: true, code, reason };
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function describe(value: unknown): string {
  if (value && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    for (const key of ["message", "error", "reason", "detail"]) if (typeof fields[key] === "string") return fields[key] as string;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "").slice(0, 300);
}
