// GET /api/book-stress (INTERFACES.md 19 and 22): the latest daily book stress test. The keeper runs pb-risk's `book`
// mode once a day over OutLayer's HTTPS API and appends each result, with its attestation link, to a JSON-lines file
// (services/keeper/src/book-stress.ts; BOOK_STRESS_LOG_FILE). This reads that file back, on the same machine.
import type { KeeperEvent } from "./drill.js";
import { readJsonLines } from "./drill.js";
import type { Deps } from "./handlers.js";

export interface StressLine {
  t: string;
  ok: boolean;
  /** pb-risk's `book` output (INTERFACES.md 19), or null when the run failed. */
  result: Record<string, unknown> | null;
  error: string | null;
  call_id: string | null;
  attestation_url: string | null;
  time_ms: number | null;
  compute_cost: string | null;
  program: { project_id: string | null; version_key: string | null } | null;
}

function line(e: KeeperEvent): StressLine {
  const result = e.result && typeof e.result === "object" && !Array.isArray(e.result) ? (e.result as Record<string, unknown>) : null;
  const program = e.program && typeof e.program === "object" ? (e.program as Record<string, unknown>) : null;
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    t: e.t,
    ok: e.ok === true && result?.ok === true,
    result,
    error: text(e.error) ?? (result && result.ok === false ? text(result.reason) : null),
    call_id: text(e.call_id),
    attestation_url: text(e.attestation_url),
    time_ms: typeof e.time_ms === "number" ? e.time_ms : null,
    compute_cost: text(e.compute_cost),
    program: program ? { project_id: text(program.project_id), version_key: text(program.version_key) } : null,
  };
}

/**
 * The latest attempt, the latest result that worked, and the last 30 attempts in short, newest first. `log_found` is
 * false until the keeper has written the file.
 */
export function getBookStress(deps: Deps) {
  const { found, events } = (deps.readBookStress ?? readJsonLines)(deps.config.bookStressFile);
  const runs = events.filter((e) => e.event === "book_stress").map(line);
  const latest = runs.at(-1) ?? null;
  const lastOk = [...runs].reverse().find((r) => r.ok) ?? null;
  return {
    log_found: found,
    latest,
    last_result: lastOk,
    history: runs
      .slice(-30)
      .reverse()
      .map((r) => ({
        t: r.t,
        ok: r.ok,
        pass: typeof r.result?.pass === "boolean" ? r.result.pass : null,
        worst_loss: typeof (r.result?.worst as { pool_loss?: unknown } | null | undefined)?.pool_loss === "number" ? (r.result!.worst as { pool_loss: number }).pool_loss : null,
        limit: typeof r.result?.limit === "number" ? r.result.limit : null,
        attestation_url: r.attestation_url,
        error: r.error,
      })),
  };
}
