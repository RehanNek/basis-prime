// Which client accounts the keeper watches: every account the factory lists (INTERFACES.md 3, list_accounts, at most
// 100 a call). The loop then reads each one's get_state and acts only where a loan is open. The list is read again
// once a minute, so a new account is picked up within a minute of being made.

export interface ListSource {
  viewOrNull<T extends object>(contractId: string, method: string, args?: Record<string, unknown>): Promise<T | null>;
}

const PAGE = 100;

/**
 * `--newest <n>`: the last `n` of the factory's accounts. The factory lists them oldest first (its `list_accounts`),
 * so the newest are at the end. With no `n`, all of them.
 */
export function newestOf(ids: string[], n: number | undefined): string[] {
  return n === undefined ? ids : ids.slice(-n);
}

export class AccountLister {
  readonly #source: ListSource;
  readonly #factory: string;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #cached: { at: number; ids: string[] } | undefined;

  constructor(source: ListSource, factory: string, ttlMs = 60_000, now: () => number = Date.now) {
    this.#source = source;
    this.#factory = factory;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  async list(): Promise<string[]> {
    if (this.#cached && this.#now() - this.#cached.at < this.#ttlMs) return this.#cached.ids;
    const ids: string[] = [];
    for (let from = 0; from < 10_000; from += PAGE) {
      const page = await this.#source.viewOrNull<{ account_id: string }[]>(this.#factory, "list_accounts", { from_index: from, limit: PAGE });
      if (!page) break; // no factory yet
      ids.push(...page.map((entry) => entry.account_id));
      if (page.length < PAGE) break;
    }
    this.#cached = { at: this.#now(), ids };
    return ids;
  }
}

/**
 * Whether `id` is a client account the factory made: `<name>.<factory>`, one name and nothing between. The keeper's
 * POST /check (INTERFACES.md 49.4) sends a check, with 0.01 NEAR, to no other account, whoever asks.
 */
export function isClientAccount(id: string, factory: string): boolean {
  return id.length <= 64 && id.endsWith(`.${factory}`) && /^[a-z0-9]+([-_][a-z0-9]+)*$/.test(id.slice(0, -factory.length - 1));
}
