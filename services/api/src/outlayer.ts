// Runs pb-risk and pb-gateway over OutLayer's HTTPS API: previews the UI shows before anyone pays for an on-chain
// check, credit checks, and orders (INTERFACES.md 7 and 11). The request is the one measured on testnet on 7 Nov
// (research/outlayer.md 3 and "Measured on testnet"; research/scripts/day1_outlayer_checks.py):
//
//   POST <api>/call/<owner>/<project>
//   X-Payment-Key: owner:nonce:secret         (server-side only; runs are charged to the key)
//   X-Compute-Limit: <micro-USD>              (the most one run may cost)
//   {"input": {...}, "async": true, "resource_limits": {...}, "version_key": "<sha256>"}
//
// `input` goes as a JSON object, which OutLayer writes to the program's stdin as JSON text: that is how
// the Phase 0 probe ran.
//
// The run is asked for, then asked about (since 11 Nov). A run can sit in OutLayer's queue for a minute or more
// before its 3 seconds of work, and a call that waits for its answer on one connection was cut off at about 100 s
// (no answer, or HTTP 524). So the call is submitted with "async": true, which answers at once:
//   {call_id, status: "pending", poll_url: "/calls/<id>", attestation_url: "/attestations/by-call/<id>"}
// and GET <api>/calls/<id>, with the same key, answers {call_id, status: "pending", attestation_url} until the run
// ends, then the same object a synchronous call gave (read live on 11 Nov):
//   {call_id, status: "completed", output, compute_cost, instructions, time_ms, attestation_url}
// with `attestation_url` as a path on the API host, and `time_ms` the run's own time, its wait in the queue left out.
// OutLayer's API.md names `pending` as the one state that is not an end. The client asks every 2 seconds, for up to
// OUTLAYER_WAIT_MS in all (270 s unless set; 180 s before INTERFACES.md 50.4), and gives its callers the result a
// synchronous call gave them. One run may be given its own wait: an order's or a cancel's is never shorter than
// what is left of the signed message's life (hl-handlers.ts, orderWaitMs).
//
// 503 on the submit is safe to retry, once; 500 may already have run and been charged (there is no idempotency
// key), so it is not retried. A poll that fails (the network, a busy API) is only a miss: the run goes on, and the
// client asks again. A run still pending when the time is up is reported as OutLayer not answering; it may still run.

import { outputHashOfAnswer } from "./canonical.js";

/** The same limits the account contract passes to request_execution (INTERFACES.md 4). */
export const RESOURCE_LIMITS = { max_instructions: 2_000_000_000, max_memory_mb: 256, max_execution_seconds: 20 } as const;

/** $0.01, OutLayer's default, said out loud. A 2B-instruction run costs about $0.003 at most. */
export const COMPUTE_LIMIT_MICRO_USD = 10_000;

/**
 * How long a run may take from its submit to its end, queue included, unless OUTLAYER_WAIT_MS says otherwise: 270 s.
 * It was 180 s up to 13 Nov. Since INTERFACES.md 50.4 an order signed for an account on the new gateway lives 230 s,
 * and the backend must not give up on its run before that life is over: 230 s, and 40 s for a run that gets its
 * turn at the last moment (its own work is 20 s at most) and the polls around it.
 */
export const DEFAULT_OUTLAYER_WAIT_MS = 270_000;
/** How often a pending run is asked about. */
export const OUTLAYER_POLL_MS = 2_000;

export interface OutLayerRun {
  callId: string | null;
  /** "completed" when the program ran and exited. */
  status: string;
  /** The program's JSON output, parsed. */
  output: unknown;
  error: string | null;
  /** What the run cost, in micro-USD. */
  computeCost: string | null;
  timeMs: number | null;
  /** The run's TDX attestation record, as a full URL. */
  attestationUrl: string | null;
  /** SHA-256 of the output in sorted form, from the answer's own text: what the attestation calls output_hash. */
  outputSha256?: string | null;
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

/** What each refusal means, in words, as before. */
const WHY: Record<number, string> = {
  401: "the payment key was refused",
  402: "the payment key has run out of credit",
  403: "the payment key may not run this project",
  408: "the run took too long for a synchronous call",
  500: "OutLayer failed; the run may still have happened and been charged",
  503: "OutLayer is busy; try again in a moment",
};

export class OutLayerClient {
  readonly #apiUrl: string;
  readonly #paymentKey: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #waitMs: number;
  readonly #pollMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  constructor(options: OutLayerOptions) {
    this.#apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.#paymentKey = options.paymentKey;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#waitMs = options.waitMs ?? DEFAULT_OUTLAYER_WAIT_MS;
    this.#pollMs = options.pollMs ?? OUTLAYER_POLL_MS;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
  }

  /**
   * One run of `projectId` ("owner/project") on `input`, pinned to `versionKey` when given: submitted, then asked
   * about until it ends. `options.waitMs` is this run's own limit, in place of the client's (OUTLAYER_WAIT_MS).
   */
  async run(projectId: string, input: unknown, versionKey?: string, options?: { waitMs?: number }): Promise<OutLayerRun> {
    const waitMs = options?.waitMs ?? this.#waitMs;
    const body: Record<string, unknown> = { input, async: true, resource_limits: RESOURCE_LIMITS };
    if (versionKey) body.version_key = versionKey;
    const started = this.#now();

    let response = await this.#send(`${this.#apiUrl}/call/${projectId}`, "POST", body);
    if (response.status === 503) {
      await this.#sleep(1_000); // OutLayer says 503 is safe to retry; once is enough for a preview
      response = await this.#send(`${this.#apiUrl}/call/${projectId}`, "POST", body);
    }
    const submitted = await this.#answer(response);
    const callId = typeof submitted.answer.call_id === "string" ? submitted.answer.call_id : null;
    const attestation = typeof submitted.answer.attestation_url === "string" ? submitted.answer.attestation_url : null;

    // Anything but `pending` is the run's end, on the submit's own answer too.
    let last = submitted;
    let miss: string | null = null;
    while (last.answer.status === "pending") {
      if (!callId) throw new OutLayerError(502, "OutLayer said the run is pending but gave no call id to ask about");
      const waited = this.#now() - started;
      if (waited >= waitMs) {
        throw new OutLayerError(504, `OutLayer did not answer: the run was still waiting its turn after ${Math.round(waited / 1000)} s (call ${callId}${miss ? `; the last time it was asked about, ${miss}` : ""}). It may still run`);
      }
      await this.#sleep(this.#pollMs);
      const path = typeof submitted.answer.poll_url === "string" ? submitted.answer.poll_url : `/calls/${callId}`;
      const polled = await this.#poll(new URL(path, `${this.#apiUrl}/`).toString());
      if (typeof polled === "string") miss = polled;
      else last = polled;
    }

    const { answer, text } = last;
    const finalAttestation = typeof answer.attestation_url === "string" ? answer.attestation_url : attestation;
    return {
      callId: typeof answer.call_id === "string" ? answer.call_id : callId,
      status: typeof answer.status === "string" ? answer.status : "unknown",
      output: typeof answer.output === "string" ? (parseJson(answer.output) ?? answer.output) : (answer.output ?? null),
      error: answer.error === undefined || answer.error === null ? null : describe(answer.error),
      computeCost: answer.compute_cost === undefined || answer.compute_cost === null ? null : String(answer.compute_cost),
      timeMs: typeof answer.time_ms === "number" ? answer.time_ms : null,
      attestationUrl: finalAttestation === null ? null : new URL(finalAttestation, `${this.#apiUrl}/`).toString(),
      outputSha256: outputHashOfAnswer(text),
    };
  }

  /** One question about a pending run: its answer, or in words why this one was a miss (the run itself goes on). */
  async #poll(url: string): Promise<{ answer: Record<string, unknown>; text: string } | string> {
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

  /** A response as its JSON object and its own text. Throws, in the words callers know, for a refusal or anything that isn't JSON. */
  async #answer(response: Response): Promise<{ answer: Record<string, unknown>; text: string }> {
    const text = this.#scrub(await response.text());
    const parsed = parseJson(text);
    if (!response.ok) {
      const reason = WHY[response.status];
      const detail = describe(parsed ?? text);
      const message = reason && detail ? `${reason} (${detail})` : reason || detail || "no details";
      throw new OutLayerError(response.status, `OutLayer answered HTTP ${response.status}: ${message}`);
    }
    if (!parsed || typeof parsed !== "object") throw new OutLayerError(502, "OutLayer answered something that isn't JSON");
    return { answer: parsed as Record<string, unknown>, text };
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

  /** Removes the payment key from any text that might be shown, in case an error message ever echoes it. */
  #scrub(text: string): string {
    const secret = this.#paymentKey.split(":").pop() ?? "";
    let clean = text.split(this.#paymentKey).join("<payment key>");
    if (secret.length >= 16) clean = clean.split(secret).join("<payment key>");
    return clean;
  }
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
    for (const key of ["message", "error", "reason", "detail"]) {
      if (typeof fields[key] === "string") return fields[key] as string;
    }
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "").slice(0, 300);
}
