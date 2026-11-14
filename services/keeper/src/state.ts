// What the keeper reads from each account's get_state (INTERFACES.md 4, 8 and 14): its last verdict, its loan, its
// DELEVERAGE pair, its stored plan, its pending transfers and its Hyperliquid master address. One read per account per
// tick serves all of them. Reads only: nothing is signed here.
import type { RiskAction, RiskState, Verdict } from "./decide.js";
import type { SignedEntry } from "./hl-post.js";

/** The verdict as the account stores it (RISK_ENGINE.md Appendix A): the parts the keeper reads. */
export interface VerdictJson {
  ok?: boolean;
  state: RiskState;
  action: RiskAction;
  blk: number;
  nonce: number;
  eq?: number;
  mm?: number;
  im?: number;
  since?: number;
  bands?: unknown;
  top?: string[];
  pool?: { hold?: Record<string, unknown> };
  venues?: { hl_margin_ratio_bp?: number };
  plan?: unknown[];
  /** Phase 6 (INTERFACES.md 25): the lender positions, and the steps a `fund` intent was answered with. */
  ext?: unknown;
  fund?: unknown[];
  /** What the verdict allows, in micro-USD: `borrow` from our pool, a `withdraw`, and (Phase 6) `fund` in all. */
  allow?: { borrow?: number; withdraw?: number; fund?: number };
  /** Stage 3 (INTERFACES.md 33): how many of the account's transactions Aave's chain had used when the verdict was read. */
  evm?: { nonce?: number };
  /** INTERFACES.md 50.2: the account's open transfers out of Hyperliquid (their nonces) that Hyperliquid's own ledger shows as sent. Left out when none. */
  sent?: number[];
}

/** The parts of get_state the keeper uses. Phase 4 fields are missing on older accounts. */
export interface AccountState {
  owner: string;
  counter: number;
  blocked?: boolean;
  /** `open` stays true until a repayment comes back partly unused (INTERFACES.md 4, as built). */
  loan: { principal: string; open?: boolean };
  /** received_at (ns, Phase 4) is the block time the verdict arrived. */
  verdict: { intent: unknown; received_block: number; received_at?: string; verdict: VerdictJson } | null;
  margin_call?: { since: string; below?: boolean; intervals: [string, string][] };
  /** first_at is when the first DELEVERAGE verdict of the open pair arrived (ns). Phases 2-3 keep the plan here. */
  deleverage?: { first_at: string; confirmed_plan?: unknown };
  /** Phase 4 (INTERFACES.md 14): the stored plan. */
  plan?: unknown;
  /** Borrows and 1Click transfers under way, and (Phase 6, stage 2) a lender action: `{"lender": {...}}`. */
  pending?: unknown;
  /** Phase 3 adds agent, next_nonce_ms and signed (INTERFACES.md 8). */
  /**
   * INTERFACES.md 50.2, accounts made after that deploy: `open_sends` lists the nonces (unix ms, as strings, oldest
   * first, at most 8) of the transfers out of Hyperliquid no accepted verdict has named as sent, and
   * `send_floor_until_ms` is the floor a ninth open one leaves ("0" when unused). `send_open_until_ms` is then "0"
   * once none is open. An account that doesn't show `open_sends` keeps the 2 days and 1 hour.
   */
  hl?: { path: string; address: string | null; signed?: SignedEntry[]; send_open_until_ms?: string; open_sends?: string[]; send_floor_until_ms?: string };
  /** Phase 6 (INTERFACES.md 25), new accounts only: the owner's permission to use lenders, and the funding plan. */
  permission?: unknown;
  funding?: unknown;
  /**
   * The audit fixes of 12 Nov (INTERFACES.md 40.1), accounts made since: the block height of the last
   * `set_permission`, or of the account's making when a permission came with it; 0 if none was ever set. `fund` and
   * the lender steps refuse a held verdict whose `blk` isn't above it. `set_permission` no longer moves the counter.
   */
  permission_blk?: number;
  /** Stage 3 (INTERFACES.md 33): `{nonce, signed: [...]}`, the account's transactions for Aave's chain (evm.ts reads it). */
  evm?: unknown;
}

/**
 * INTERFACES.md 45.3, item 9: whether the pool's `get_pricing(account)` answer names a policy other than
 * pass-through (`"pass_through"`, `{"lender": …}` or `{"fixed": …}`; INTERFACES.md 26). The pool answers with the
 * policy that applies: the account's own, else its tier's, else pass-through. No answer, or one with no policy, is
 * pass-through.
 */
export function isPriced(record: unknown): boolean {
  const pricing = (record as { pricing?: unknown } | null | undefined)?.pricing;
  return pricing !== undefined && pricing !== null && pricing !== "pass_through";
}

/**
 * INTERFACES.md 45.3, item 10: the least time the pool keeps between two settlements of one account, in ms, from its
 * `get_params()` (`pricing_limits.min_period_ns`, a plain JSON number of nanoseconds). Null when the pool doesn't say.
 */
export function minPeriodMs(params: unknown): number | null {
  const ns = (params as { pricing_limits?: { min_period_ns?: unknown } | null } | null | undefined)?.pricing_limits?.min_period_ns;
  const n = typeof ns === "number" ? ns : typeof ns === "string" && /^\d+$/.test(ns) ? Number(ns) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.ceil(n / 1_000_000) : null;
}

/** What StateReader needs from NEAR: a view that answers null while a contract isn't live, and block times. */
export interface StateSource {
  viewOrNull<T extends object>(contractId: string, method: string, args?: Record<string, unknown>): Promise<T | null>;
  blockTimeMs(height: number): Promise<number>;
}

/** A loan is open as the account counts it: `loan.open` where the contract has it, else what is still owed. */
export function loanOpen(loan: AccountState["loan"] | undefined): boolean {
  if (!loan) return false;
  return loan.open ?? loan.principal !== "0";
}

/** The stored verdict in the keeper's terms. `at` is when the account stored it, so a new verdict has a new `at`. */
export function toVerdict(state: AccountState, storedAtMs: number): Verdict | null {
  if (!state.verdict) return null;
  const { verdict, received_block } = state.verdict;
  return {
    state: verdict.state,
    action: verdict.action,
    blk: verdict.blk,
    nonce: verdict.nonce,
    receivedBlock: received_block,
    at: storedAtMs,
    bands: verdict.bands,
    tokens: Object.keys(verdict.pool?.hold ?? {}),
    ...(typeof verdict.allow?.borrow === "number" ? { allowBorrow: verdict.allow.borrow } : {}),
    ...(typeof verdict.evm?.nonce === "number" && Number.isSafeInteger(verdict.evm.nonce) ? { evmNonce: verdict.evm.nonce } : {}),
    // INTERFACES.md 47.5: the verdict's own plan by kind, lender and token, to tell whether it orders the stored plan again.
    ...(Array.isArray(verdict.plan) ? { planSteps: verdict.plan.map(stepShape) } : {}),
  };
}

/** One step of a verdict's plan by what the account compares: its kind, and its lender and token where it has them. */
function stepShape(step: unknown): { k: string; l?: string; tok?: string } {
  const s = (step && typeof step === "object" ? step : {}) as { k?: unknown; l?: unknown; tok?: unknown };
  return { k: typeof s.k === "string" ? s.k : "?", ...(typeof s.l === "string" ? { l: s.l } : {}), ...(typeof s.tok === "string" ? { tok: s.tok } : {}) };
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The master address derived through Chain Signatures, once the account has one (Phase 3). */
export function hlAddressOf(state: AccountState | null): `0x${string}` | undefined {
  const address = state?.hl?.address;
  return address && EVM_ADDRESS.test(address) ? (address.toLowerCase() as `0x${string}`) : undefined;
}

export class StateReader {
  readonly #source: StateSource;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #states = new Map<string, { readAt: number; state: Promise<AccountState | null> }>();
  readonly #blockTimes = new Map<number, Promise<number>>();

  /** A read is shared for `ttlMs`: long enough to cover one tick, short of the next (15 s). */
  constructor(source: StateSource, ttlMs = 5_000, now: () => number = Date.now) {
    this.#source = source;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /** get_state, or null while the account (or its contract) doesn't exist. */
  state(account: string): Promise<AccountState | null> {
    const cached = this.#states.get(account);
    if (cached && this.#now() - cached.readAt < this.#ttlMs) return cached.state;
    const state = this.#source.viewOrNull<AccountState>(account, "get_state");
    this.#states.set(account, { readAt: this.#now(), state });
    state.catch(() => this.#states.delete(account)); // a failed read isn't kept
    return state;
  }

  /** Forgets the cached read, after the keeper changed the account. */
  forget(account: string): void {
    this.#states.delete(account);
  }

  async verdict(account: string): Promise<Verdict | null> {
    const state = await this.state(account);
    if (!state?.verdict) return null;
    return toVerdict(state, await this.blockTimeMs(state.verdict.received_block));
  }

  async hlAddress(account: string): Promise<`0x${string}` | undefined> {
    return hlAddressOf(await this.state(account));
  }

  blockTimeMs(height: number): Promise<number> {
    let time = this.#blockTimes.get(height);
    if (!time) {
      if (this.#blockTimes.size >= 1_000) this.#blockTimes.clear();
      time = this.#source.blockTimeMs(height);
      this.#blockTimes.set(height, time);
      time.catch(() => this.#blockTimes.delete(height));
    }
    return time;
  }
}
