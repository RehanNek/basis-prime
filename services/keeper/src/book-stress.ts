// The daily book stress test (INTERFACES.md 19; RISK_ENGINE.md 12.1, last row): every account with a loan, its scenarios
// run together, with the unwind costs of the book's total size per coin, since our clients would be selling together. The
// pool's loss on an extreme day must stay within 2.5% of its capital.
//
// pb-risk computes it, in mode `book` over OutLayer's HTTPS API with our payment key: {"mode":"book","network":"testnet"}.
// The keeper runs it once a day, and at start when the last result is more than a day old, with the pb-risk version the
// factory pins (get_config().risk), and appends each attempt, with its attestation link, to BOOK_STRESS_LOG_FILE as one
// JSON line. The backend answers the latest one at GET /api/book-stress, and the Book page shows it.
//
// A run that fails (OutLayer busy or down) is tried again 15 minutes later. A run pb-risk refuses ({"ok":false}, say
// more than 10 accounts with loans, or a version without the `book` mode) is an answer, kept, and tried again an hour
// later. A new pinned version runs at once, so the result follows a deploy.
import type { Log, LogEvent } from "./jsonl.js";
import type { OutLayerRun } from "./outlayer.js";

export const STRESS_EVERY_MS = 24 * 60 * 60_000;
export const STRESS_RETRY_MS = 15 * 60_000;
export const STRESS_REFUSED_RETRY_MS = 60 * 60_000;
export const STRESS_INPUT = { mode: "book", network: "testnet" } as const;

export interface Pin {
  project: string;
  versionKey: string | undefined;
}

export interface StressDeps {
  /** The pb-risk the factory pins for new accounts, or null when it pins none we can run. */
  pin(): Promise<Pin | null>;
  run(project: string, input: unknown, versionKey?: string): Promise<OutLayerRun>;
  /** Appends one line to the results file. */
  record(event: string, msg: string, fields: Record<string, unknown>): void;
  /** The keeper's own log. */
  log: Log;
  now(): number;
  /** A dry run reads the pin and says what it would run, and runs nothing. */
  dryRun?: boolean;
}

export interface StressHistory {
  /** When the last result pb-risk answered with ok came. */
  lastOkMs: number | null;
  /** When the last attempt was, whatever came of it, and how it ended. */
  lastTryMs: number | null;
  lastTry: "ok" | "refused" | "failed" | null;
  /** The pinned version the last attempt ran. */
  lastVersion: string | null;
}

/** The history in the results file, oldest line first. */
export function stressHistory(events: LogEvent[]): StressHistory {
  const history: StressHistory = { lastOkMs: null, lastTryMs: null, lastTry: null, lastVersion: null };
  for (const e of events) {
    if (e.event !== "book_stress") continue;
    const at = Date.parse(e.t);
    if (!Number.isFinite(at)) continue;
    const result = e.result as { ok?: unknown } | null | undefined;
    const outcome = e.ok === true && result?.ok === true ? "ok" : result && result.ok === false ? "refused" : "failed";
    history.lastTryMs = at;
    history.lastTry = outcome;
    history.lastVersion = typeof (e.program as { version_key?: unknown } | undefined)?.version_key === "string" ? (e.program as { version_key: string }).version_key : null;
    if (outcome === "ok") history.lastOkMs = at;
  }
  return history;
}

/** Between runs, the pin is read this often to see a newly pinned version. */
export const PIN_CHECK_MS = 10 * 60_000;

export class BookStressJob {
  readonly #deps: StressDeps;
  readonly #history: StressHistory;
  #running = false;
  #pinCheckedAt: number | null = null;
  #saidDry = false;

  constructor(deps: StressDeps, history: StressHistory) {
    this.#deps = deps;
    this.#history = { ...history };
  }

  /** Whether a run is due by time: a day since the last result, and past the wait after the last attempt. */
  due(now: number): boolean {
    const h = this.#history;
    if (h.lastTryMs !== null) {
      const wait = h.lastTry === "failed" ? STRESS_RETRY_MS : h.lastTry === "refused" ? STRESS_REFUSED_RETRY_MS : STRESS_EVERY_MS;
      if (now - h.lastTryMs < wait) return false;
    }
    return h.lastOkMs === null || now - h.lastOkMs >= STRESS_EVERY_MS;
  }

  /**
   * Runs the test if it is due, or if the factory now pins a version that hasn't run yet (looked at every 10 minutes).
   * Returns what it recorded, or null when it didn't run. Never throws: a failure is recorded and tried again later.
   */
  async maybeRun(): Promise<Record<string, unknown> | null> {
    const deps = this.#deps;
    if (this.#running) return null;
    const now = deps.now();
    const byTime = this.due(now);
    if (!byTime && this.#pinCheckedAt !== null && now - this.#pinCheckedAt < PIN_CHECK_MS) return null;
    this.#running = true;
    try {
      this.#pinCheckedAt = now;
      let pin: Pin | null;
      try {
        pin = await deps.pin();
      } catch (error) {
        return byTime ? this.#failed(now, null, `the factory's pinned pb-risk could not be read: ${text(error)}`) : null;
      }
      const h = this.#history;
      const newVersion = pin !== null && h.lastTryMs !== null && (pin.versionKey ?? null) !== h.lastVersion && now - h.lastTryMs >= STRESS_RETRY_MS;
      if (!byTime && !newVersion) return null;
      if (!pin) return this.#failed(now, null, "the factory pins no pb-risk of ours, so there is nothing to run");
      if (deps.dryRun) {
        if (!this.#saidDry) deps.log("book_stress", `dry run: the book stress test is due; it would run ${pin.project} ${pin.versionKey ?? "(the active version)"} in mode book`, {});
        this.#saidDry = true;
        return null;
      }
      const program = { project_id: pin.project, version_key: pin.versionKey ?? null };
      let run: OutLayerRun;
      try {
        run = await deps.run(pin.project, STRESS_INPUT, pin.versionKey);
      } catch (error) {
        return this.#failed(now, program, text(error));
      }
      if (run.status !== "completed") return this.#failed(now, program, `pb-risk did not complete: ${run.error ?? run.status}`, run);
      const result = run.output && typeof run.output === "object" && !Array.isArray(run.output) ? (run.output as Record<string, unknown>) : null;
      const ok = result?.ok === true;
      const fields = {
        ok,
        result,
        ...(ok ? {} : { error: typeof result?.reason === "string" ? result.reason : "pb-risk answered something that isn't a book stress result" }),
        call_id: run.callId,
        attestation_url: run.attestationUrl,
        time_ms: run.timeMs,
        compute_cost: run.computeCost,
        program,
      };
      const msg = ok ? stressWords(result!) : `pb-risk refused the book stress test: ${String(fields.error)}`;
      deps.record("book_stress", msg, fields);
      deps.log("book_stress", msg, { ok, pass: result?.pass ?? null, call_id: run.callId, attestation_url: run.attestationUrl });
      h.lastTryMs = now;
      h.lastTry = ok ? "ok" : result && result.ok === false ? "refused" : "failed";
      h.lastVersion = program.version_key;
      if (ok) h.lastOkMs = now;
      return fields;
    } finally {
      this.#running = false;
    }
  }

  #failed(now: number, program: { project_id: string; version_key: string | null } | null, error: string, run?: OutLayerRun): Record<string, unknown> {
    const fields = { ok: false, result: null, error, call_id: run?.callId ?? null, attestation_url: run?.attestationUrl ?? null, time_ms: run?.timeMs ?? null, compute_cost: run?.computeCost ?? null, program };
    this.#deps.record("book_stress", `the book stress test failed: ${error}`, fields);
    this.#deps.log("book_stress", `the book stress test failed: ${error}; it runs again in 15 minutes`, { ok: false });
    this.#history.lastTryMs = now;
    this.#history.lastTry = "failed";
    if (program) this.#history.lastVersion = program.version_key;
    return fields;
  }
}

/** The result in one sentence: the accounts, the worst scenario's loss against the limit, pass or fail. */
export function stressWords(result: Record<string, unknown>): string {
  const usd = (micro: unknown) => (typeof micro === "number" ? `$${(micro / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "?");
  const accounts = Array.isArray(result.accounts) ? result.accounts.length : 0;
  const worst = result.worst as { scenario?: unknown; pool_loss?: unknown } | null | undefined;
  // pb-risk leaves `worst` null when no account has a loan, and when no scenario costs the pool anything (INTERFACES.md 19).
  if (!worst) return `the book stress test: ${accounts} account(s) with a loan, ${accounts === 0 ? "nothing at risk" : "no scenario costs the pool anything"}; ${result.pass === false ? "FAIL" : "pass"}`;
  return `the book stress test: ${accounts} account(s) with a loan; the worst scenario (${String(worst.scenario)}) loses the pool ${usd(worst.pool_loss)} against a limit of ${usd(result.limit)}; ${result.pass === true ? "pass" : "FAIL"}`;
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
