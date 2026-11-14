// The keeper's log (INTERFACES.md 17): one JSON object per line, on stdout and appended to a file, so every action
// can be traced to its transaction or its OutLayer attestation. Each line has `t` (ISO time), `event` and `msg` (one
// plain sentence), plus the event's fields. No key or payment key ever goes into a field.
//
// The backend's GET /api/keeper/:account and the drill gate script read the file back.
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";

export interface LogEvent {
  t: string;
  event: string;
  msg?: string;
  account?: string;
  [field: string]: unknown;
}

export type Log = (event: string, msg: string, fields?: Record<string, unknown>) => void;

/** JSON.stringify that writes bigints as strings and never throws. */
export function jsonLine(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return JSON.stringify({ t: new Date().toISOString(), event: "log_error", msg: "a log line could not be written as JSON" });
  }
}

export class JsonLog {
  readonly file: string | undefined;
  readonly #out: (line: string) => void;
  readonly #now: () => number;
  #fileError = false;

  constructor(options: { file?: string; out?: (line: string) => void; now?: () => number } = {}) {
    this.file = options.file;
    this.#out = options.out ?? ((line) => console.log(line));
    this.#now = options.now ?? Date.now;
    if (this.file) mkdirSync(dirname(this.file), { recursive: true });
  }

  readonly log: Log = (event, msg, fields = {}) => {
    const line = jsonLine({ t: new Date(this.#now()).toISOString(), event, msg, ...fields });
    this.#out(line);
    if (!this.file) return;
    try {
      appendFileSync(this.file, `${line}\n`);
    } catch (error) {
      if (!this.#fileError) this.#out(jsonLine({ t: new Date(this.#now()).toISOString(), event: "log_error", msg: `could not append to the log file: ${error instanceof Error ? error.message : String(error)}` }));
      this.#fileError = true;
    }
  };
}

/** The events in the last `maxBytes` of a JSON-lines file, oldest first. A missing file has none. */
export function readTail(file: string, maxBytes = 4_000_000): { found: boolean; events: LogEvent[] } {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return { found: false, events: [] };
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (length < size) lines.shift(); // the first line is probably cut
    const events: LogEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as LogEvent;
        if (parsed && typeof parsed === "object" && typeof parsed.event === "string") events.push(parsed);
      } catch {
        // not a log line
      }
    }
    return { found: true, events };
  } finally {
    closeSync(fd);
  }
}
