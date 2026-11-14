// A sliding-window limit on previews: each one is a pb-risk run charged to our OutLayer payment key,
// so an open endpoint must not be able to spend it all.

/** About $0.003 a run at most, so 20 a minute caps the spend near $0.06 a minute. */
export const PREVIEWS_PER_MINUTE = 20;

/**
 * Phase 3 (INTERFACES.md 11). Orders: 60 a minute per account, the same as the gateway's own P10 limit, so the
 * gateway's check is the one that bites. Cancels get the same. set_leverage needs no owner signature, so anyone
 * can ask for it: a few a minute per account is plenty. Posting a signed action costs no OutLayer run, but each
 * one uses some of our IP's Hyperliquid limit.
 */
export const ORDERS_PER_MINUTE = 60;
export const CANCELS_PER_MINUTE = 60;
export const LEVERAGE_SETS_PER_MINUTE = 6;
export const SUBMITS_PER_MINUTE = 30;
/** Every gateway run, all accounts together: a cap on what our payment key can be made to spend. */
export const GATEWAY_RUNS_PER_MINUTE = 240;
/** Phase 4: changes to the stand-in's fault switch (testnet), all callers together. */
export const FAULTS_PER_MINUTE = 10;

/**
 * Phase 5 (INTERFACES.md 22). A credit check is a pb-risk run paid by our key that reads mainnet: at most 6 a minute in
 * all, and 2 per client address (the caller's IP). Identical inputs share one result for 60 s, which costs no run.
 */
export const CREDIT_CHECKS_PER_MINUTE = 6;
export const CREDIT_CHECKS_PER_CLIENT = 2;
/** Activity reads from the indexer (each one up to 6 calls), all accounts together: polite to a free service. */
export const ACTIVITY_READS_PER_MINUTE = 30;

/** One sliding window per key (an account id). */
export class KeyedRateLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, RateLimiter>();

  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  take(key: string): boolean {
    return this.#window(key).take();
  }

  /** Whether `take(key)` would succeed now, without taking anything. */
  available(key: string): boolean {
    return this.#window(key).available();
  }

  #window(key: string): RateLimiter {
    let window = this.#windows.get(key);
    if (!window) {
      if (this.#windows.size > 10_000) this.#windows.clear(); // a flood of made-up keys can't grow it forever
      window = new RateLimiter(this.#max, this.#windowMs, this.#now);
      this.#windows.set(key, window);
    }
    return window;
  }
}

export class RateLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  #times: number[] = [];

  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Takes one slot if there is one free in the window. */
  take(): boolean {
    if (!this.available()) return false;
    this.#times.push(this.#now());
    return true;
  }

  /** Whether a slot is free now, without taking it: for two limits that must both pass before either is used. */
  available(): boolean {
    const now = this.#now();
    this.#times = this.#times.filter((t) => now - t < this.#windowMs);
    return this.#times.length < this.#max;
  }
}

/**
 * Stage 3 (INTERFACES.md 33): sending an account's signed Ethereum transaction costs us nothing but a call to the
 * chain's public RPC, which is rate-limited: 30 a minute in all is polite.
 */
export const EVM_SUBMITS_PER_MINUTE = 30;

/**
 * The gas helper (POST /api/evm/gas, testnet only). The gas wallet's test ETH comes from faucets that need a sign-in,
 * so an open endpoint must not be able to drain it:
 * - an address is topped up to 0.002 ETH, and only when it holds under 0.001. A transaction needs its gas limit times
 *   its fee limit held, 0.0005 ETH at most on testnet (INTERFACES.md 33), and spends a tiny part of it;
 * - 3 top-ups a day for one account, and 0.02 ETH of top-ups a day in all;
 * - wrapped ETH for collateral: 0.02 ETH a day for one account, and never so much that the wallet is left with under
 *   0.01 ETH;
 * - Aave's faucet's own limits: once an hour for one recipient and token, at most 1 whole token of collateral or
 *   1,000,000 USDC a call (research/aave.md).
 */
export const GAS_FLOOR_WEI = 2_000_000_000_000_000n;
export const GAS_LOW_WEI = 1_000_000_000_000_000n;
export const GAS_TOP_UPS_PER_ACCOUNT_PER_DAY = 3;
export const GAS_WEI_PER_DAY = 20_000_000_000_000_000n;
export const WRAP_WEI_PER_ACCOUNT_PER_DAY = 20_000_000_000_000_000n;
export const GAS_WALLET_RESERVE_WEI = 10_000_000_000_000_000n;
export const FAUCET_MINTS_PER_HOUR = 1;
export const FAUCET_MAX_USDC_TOKENS = 1_000_000n;
export const DAY_MS = 24 * 60 * 60_000;
export const HOUR_MS = 60 * 60_000;

/** A sliding window over amounts instead of counts: at most `max` in all within the window, per key. */
export class KeyedBudget {
  readonly #max: bigint;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #spent = new Map<string, { at: number; amount: bigint }[]>();

  constructor(max: bigint, windowMs: number, now: () => number = Date.now) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** What `key` may still spend now. */
  left(key: string): bigint {
    const now = this.#now();
    const kept = (this.#spent.get(key) ?? []).filter((e) => now - e.at < this.#windowMs);
    if (kept.length) this.#spent.set(key, kept);
    else this.#spent.delete(key);
    const used = kept.reduce((sum, e) => sum + e.amount, 0n);
    return used >= this.#max ? 0n : this.#max - used;
  }

  /** Books `amount` against `key` if it still fits. */
  take(key: string, amount: bigint): boolean {
    if (amount > this.left(key)) return false;
    if (this.#spent.size > 10_000 && !this.#spent.has(key)) this.#spent.clear(); // a flood of made-up keys can't grow it forever
    this.#spent.set(key, [...(this.#spent.get(key) ?? []), { at: this.#now(), amount }]);
    return true;
  }
}
