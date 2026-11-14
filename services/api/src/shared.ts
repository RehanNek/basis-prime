// Answers kept for a while by key, so the same question asked again costs nothing: a credit check's result for 60 s,
// Rhea's terms for 5 minutes, an account's activity for 30 s. One read is in flight per key at a time, and a failed one
// is forgotten at once, so the next request tries again.

export interface Entry<T> {
  at: number;
  value: Promise<T>;
}

export class Shared<T> {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #entries = new Map<string, Entry<T>>();
  /** The last value that arrived for each key, with when it was asked for: kept after it expires, for a stale answer. */
  readonly #last = new Map<string, { at: number; value: T }>();

  constructor(ttlMs: number, max = 500) {
    this.#ttlMs = ttlMs;
    this.#max = max;
  }

  /** The entry for `key` if it is younger than the time to live (or still on its way). */
  get(key: string, now: number): Entry<T> | undefined {
    const entry = this.#entries.get(key);
    return entry && now - entry.at < this.#ttlMs ? entry : undefined;
  }

  /** Keeps `value` for `key` from `now`, and returns it. If it fails, the entry goes at once. */
  set(key: string, now: number, value: Promise<T>): Promise<T> {
    if (this.#entries.size >= this.#max) {
      for (const [k, e] of this.#entries) if (now - e.at >= this.#ttlMs) this.#entries.delete(k);
      if (this.#entries.size >= this.#max) this.#entries.clear();
    }
    const entry = { at: now, value };
    this.#entries.set(key, entry);
    value.then(
      (v) => {
        if (this.#last.size >= this.#max && !this.#last.has(key)) this.#last.clear();
        this.#last.set(key, { at: now, value: v });
      },
      () => {
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
      },
    );
    return value;
  }

  /** The last value that arrived for `key`, however old. */
  last(key: string): { at: number; value: T } | undefined {
    return this.#last.get(key);
  }
}
