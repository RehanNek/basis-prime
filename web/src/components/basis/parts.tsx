'use client';
// What the two runs of the Basis trade page share: how a run stands, the line that says what is happening now, and
// the box that says what went wrong and what to do (INTERFACES.md 49.1, point 7).
import { ApiError } from '@/lib/api';
import { failureWords, type FailureWords } from '@/lib/basis';

/** How a guided run stands. `raw` is the reason as the contract, the wallet or the server gave it: it shows only behind "Details". */
export type RunPhase =
  | { kind: 'idle' }
  | { kind: 'running'; title: string; announce: string | null; detail: string | null }
  | { kind: 'failed'; title: string; raw: string; logs: string[]; said?: FailureWords }
  /** The run can't go on by itself: the client has something to do first. */
  | { kind: 'stopped'; title: string; words: string }
  | { kind: 'finished' };

/** A step's failure. Its message is the raw reason; `said` replaces the page's own reading of it. */
export class StepFailed extends Error {
  readonly logs: string[];
  readonly said?: FailureWords;
  constructor(message: string, logs: string[] = [], said?: FailureWords) {
    super(message);
    this.logs = logs;
    this.said = said;
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads until `ok` holds or `ms` runs out; null on time-out. Misses are retried. */
export async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms: number, every = 2_500): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const value = await read();
      if (ok(value)) return value;
    } catch {
      // a missed read: try again
    }
    await sleep(every);
  }
  return null;
}

/** A failed phase from whatever a step threw. */
export function failedPhase(title: string, error: unknown): RunPhase {
  if (error instanceof StepFailed) return { kind: 'failed', title, raw: error.message, logs: error.logs, said: error.said };
  if (error instanceof ApiError) return { kind: 'failed', title, raw: error.message, logs: [] };
  return { kind: 'failed', title, raw: error instanceof Error ? error.message : String(error), logs: [] };
}

/** What is happening now: the step, what the wallet is about to ask, and how it is going. */
export function LiveLine({ announce, detail }: { announce: string | null; detail: string | null }) {
  return (
    <div className="mt-1" aria-live="polite">
      {announce && (
        <div className="d-flex align-items-start gap-2 fw-medium">
          <i className="bi bi-wallet2 mt-1" aria-hidden="true" />
          <span>{announce}</span>
        </div>
      )}
      {detail && (
        <div className="small pb-muted d-flex align-items-start gap-2 mt-1">
          <span className="spinner-border spinner-border-sm mt-1 flex-shrink-0" aria-hidden="true" />
          <span>{detail}</span>
        </div>
      )}
    </div>
  );
}

/** What happened, in one sentence, what to do, and the one button that does it. The raw reason stays behind "Details". */
export function FailureBox({ title, raw, logs, said, onRetry, busy }: { title: string; raw: string; logs: string[]; said?: FailureWords; onRetry: () => void; busy?: boolean }) {
  const words = said ?? failureWords(raw);
  return (
    <div className="alert alert-warning mt-2 mb-0" role="alert">
      <div className="fw-medium">{words.happened}</div>
      <div>{words.todo}</div>
      <div className="d-flex flex-wrap align-items-center gap-3 mt-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onRetry}>
          {words.button ?? 'Try again'}
        </button>
        {(raw || logs.length > 0) && (
          <details className="small">
            <summary>Details</summary>
            <div className="pb-muted">While: {title}.</div>
            {raw && <div className="text-break">{raw}</div>}
            {logs.length > 0 && <pre className="small mb-0 text-wrap">{logs.join('\n')}</pre>}
          </details>
        )}
      </div>
    </div>
  );
}
