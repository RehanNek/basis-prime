// How OutLayer is answering, from the backend's own runs (INTERFACES.md 51.15; GET /api/outlayer).
//
// The user, 14 Nov: "this borrowing thing that goes through outlayer is for sure gonna cause us problems ... tell me if
// we can display something where we say that outlayer is not responding". Every risk check, order and preview the
// backend makes is a run of our program on OutLayer's testnet, and on 13 and 14 Nov that testnet was slow in spells:
// a run that takes 10 seconds on a good hour took two to five minutes, or got no answer. The app can't make it
// faster, but it can say what it is waiting on.
//
// Nothing here calls OutLayer: it only times the runs the backend makes anyway. An hour with no run has nothing to
// say ("unknown"), and the app then shows nothing.
import { OutLayerError, type OutLayerClient, type OutLayerRun } from "./outlayer.js";

/** One run, from the moment it was sent. `endedMs` is null while it waits; `answered` says whether an answer came. */
export interface RunNote {
  startedMs: number;
  endedMs: number | null;
  answered: boolean | null;
}

export type OutLayerState = "ok" | "slow" | "down" | "unknown";

export interface OutLayerHealth {
  state: OutLayerState;
  /** The runs counted are those that ended in this many seconds. */
  window_s: number;
  runs: number;
  /** Of those, the ones OutLayer gave no answer to. */
  unanswered: number;
  /** How long the latest run that ended took, and whether it was answered. */
  last_seconds: number | null;
  last_answered: boolean | null;
  /** When OutLayer last answered a run, in ms; null when none of the runs kept was answered. */
  last_answer_ms: number | null;
  /** The longest a run still waiting has waited, in seconds. */
  waiting_s: number | null;
  read_at_ms: number;
}

/** A run counts for a quarter of an hour after it ends. */
export const HEALTH_WINDOW_MS = 15 * 60_000;
/** A run that takes over a minute is slow: a good one takes 5 to 20 seconds. */
export const SLOW_SECONDS = 60;
/** How many runs are kept. */
const KEEP = 60;

const seconds = (ms: number): number => Math.round(ms / 1000);
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/**
 * How OutLayer is answering now.
 * - `unknown`: no run ended in the last 15 minutes and none is waiting.
 * - `down`: the last runs (up to three) all got no answer.
 * - `slow`: the latest run got no answer but an earlier one did; or the latest took over a minute; or the middle one
 *   of the last three did; or a run has been waiting over a minute.
 * - `ok`: otherwise.
 */
export function healthOf(notes: readonly RunNote[], nowMs: number): OutLayerHealth {
  const ended = notes.filter((n) => n.endedMs !== null && nowMs - n.endedMs <= HEALTH_WINDOW_MS).sort((a, b) => a.endedMs! - b.endedMs!);
  const waiting = notes.filter((n) => n.endedMs === null).map((n) => nowMs - n.startedMs);
  const waitingS = waiting.length > 0 ? seconds(Math.max(...waiting)) : null;
  const latest = ended[ended.length - 1] ?? null;
  const lastThree = ended.slice(-3);
  const answeredAt = notes.filter((n) => n.answered === true && n.endedMs !== null).map((n) => n.endedMs!);
  const took = (n: RunNote) => (n.endedMs! - n.startedMs) / 1000;

  let state: OutLayerState;
  if (!latest && waitingS === null) state = "unknown";
  else if (latest && lastThree.every((n) => n.answered === false)) state = "down";
  else if ((latest && (latest.answered === false || took(latest) > SLOW_SECONDS || median(lastThree.map(took)) > SLOW_SECONDS)) || (waitingS !== null && waitingS > SLOW_SECONDS)) state = "slow";
  else state = "ok";

  return {
    state,
    window_s: HEALTH_WINDOW_MS / 1000,
    runs: ended.length,
    unanswered: ended.filter((n) => n.answered === false).length,
    last_seconds: latest ? seconds(latest.endedMs! - latest.startedMs) : null,
    last_answered: latest ? latest.answered : null,
    last_answer_ms: answeredAt.length > 0 ? Math.max(...answeredAt) : null,
    waiting_s: waitingS,
    read_at_ms: nowMs,
  };
}

/** Is a failed run OutLayer giving no answer? A refused payment key (401, 402, 403) is ours to fix, and says nothing of OutLayer. */
export function isNoAnswer(error: unknown): boolean {
  return !(error instanceof OutLayerError && [401, 402, 403].includes(error.status));
}

/** Keeps the last runs' times. */
export class OutLayerWatch {
  readonly #notes: RunNote[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  start(): RunNote {
    const note: RunNote = { startedMs: this.#now(), endedMs: null, answered: null };
    this.#notes.push(note);
    if (this.#notes.length > KEEP) this.#notes.splice(0, this.#notes.length - KEEP);
    return note;
  }

  end(note: RunNote, answered: boolean): void {
    note.endedMs = this.#now();
    note.answered = answered;
  }

  /** A run that said nothing about OutLayer (our own key was refused) is forgotten. */
  forget(note: RunNote): void {
    const at = this.#notes.indexOf(note);
    if (at >= 0) this.#notes.splice(at, 1);
  }

  health(): OutLayerHealth {
    return healthOf(this.#notes, this.#now());
  }
}

/** The client as it is, with every run timed. A run that ends, whatever the program said, is an answer. */
export function watched(client: Pick<OutLayerClient, "run">, watch: OutLayerWatch): Pick<OutLayerClient, "run"> {
  return {
    async run(projectId: string, input: unknown, versionKey?: string, options?: { waitMs?: number }): Promise<OutLayerRun> {
      const note = watch.start();
      try {
        const result = await client.run(projectId, input, versionKey, options);
        watch.end(note, true);
        return result;
      } catch (error) {
        if (isNoAnswer(error)) watch.end(note, false);
        else watch.forget(note);
        throw error;
      }
    },
  };
}

/** What the route answers when the backend makes no runs at all (no payment key). */
export function noHealth(nowMs: number): OutLayerHealth {
  return healthOf([], nowMs);
}
