// The account's stored plan and pending transfers, as the keeper reads them from get_state (INTERFACES.md 13-14).
//
//   plan: null | {pid, action, stored_at, steps: [{k, ..., done}]}
//
// Who runs each step (13): the gateway's `deleverage` mode places `cancel` and `perp`; `execute_step({pid, i})` runs
// `repay`, `sell`, `to_hl` and `home`. Accounts made before Phase 4 have `deleverage.confirmed_plan` instead, whose
// steps are words: the keeper shows them and runs nothing.
//
// Phase 6 (INTERFACES.md 25 and 28; FUNDING.md 4.3) adds seven kinds, all run by the account's `execute_step`:
//   - in the funding plan (get_state().funding, pid "f<blk>"): `l_supply`, `l_borrow`, `to_evm`, `e_home`, `p_borrow`;
//   - in a top-up plan (the stored REBALANCE plan): `l_repay` and `l_add`.
// Stage 2: decide.ts runs the funding plan's `l_supply`, `l_borrow` and `p_borrow` in order, and a top-up plan's
// `l_repay` and `l_add`. The two that move money between chains (`to_evm`, `e_home`) wait for stage 4.

export type StepRunnerKind = "gateway" | "execute_step" | "words";

export interface PlanStep {
  i: number;
  k: string;
  done: boolean;
  runner: StepRunnerKind;
  /** The quote's expiry (unix ms), for sell, to_hl and home. */
  exp?: number;
  /** The step in words. */
  text: string;
  raw: unknown;
}

export interface PlanView {
  pid: string;
  action: string;
  /** Block time (ms) when the account stored it, if it says. */
  storedAtMs: number | null;
  steps: PlanStep[];
  /** `plan` (Phase 4) or `confirmed_plan` (Phases 2-3: words only). */
  source: "plan" | "confirmed_plan";
}

export const GATEWAY_KINDS = ["cancel", "perp"];
export const EXECUTE_KINDS = ["repay", "sell", "to_hl", "home"];
/** Phase 6: the lender and funding steps. `execute_step` runs each of them, with a pid that starts with `f` for the funding plan. */
export const FUNDING_KINDS = ["p_borrow", "l_supply", "l_borrow", "to_evm", "e_home", "l_repay", "l_add"];
/** The two a top-up plan holds (the stored REBALANCE plan). They only lower risk. */
export const TOP_UP_KINDS = ["l_repay", "l_add"];
/** The two that move money between chains: stage 4. The keeper leaves them alone until then. */
export const MOVE_KINDS = ["to_evm", "e_home"];
/** execute_step needs at least 5 minutes left on a step's quote (INTERFACES.md 14). */
export const QUOTE_MARGIN_MS = 5 * 60_000;

/** The stored plan, from Phase 4's `plan` or the older `deleverage.confirmed_plan`. Null when there is none. */
export function readPlan(state: { plan?: unknown; deleverage?: { confirmed_plan?: unknown } } | null | undefined): PlanView | null {
  if (!state) return null;
  const plan = state.plan as { pid?: unknown; action?: unknown; stored_at?: unknown; steps?: unknown } | null | undefined;
  if (plan && typeof plan === "object") {
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    return {
      pid: String(plan.pid ?? ""),
      action: typeof plan.action === "string" ? plan.action : "DELEVERAGE",
      storedAtMs: nsToMs(plan.stored_at),
      steps: steps.map((step, i) => planStep(step, i)),
      source: "plan",
    };
  }
  const confirmed = state.deleverage?.confirmed_plan as { at?: unknown; blk?: unknown; steps?: unknown } | null | undefined;
  if (confirmed && typeof confirmed === "object") {
    const steps = Array.isArray(confirmed.steps) ? confirmed.steps : [];
    return {
      pid: String(confirmed.blk ?? ""),
      action: "DELEVERAGE",
      storedAtMs: nsToMs(confirmed.at),
      steps: steps.map((step, i) => planStep(step, i)),
      source: "confirmed_plan",
    };
  }
  return null;
}

function planStep(raw: unknown, i: number): PlanStep {
  if (typeof raw === "string") return { i, k: "words", done: false, runner: "words", text: raw, raw };
  const step = (raw ?? {}) as Record<string, unknown>;
  const k = typeof step.k === "string" ? step.k : "?";
  const runner: StepRunnerKind = GATEWAY_KINDS.includes(k) ? "gateway" : EXECUTE_KINDS.includes(k) || FUNDING_KINDS.includes(k) ? "execute_step" : "words";
  const exp = typeof step.exp === "number" ? step.exp : typeof step.exp === "string" && /^\d+$/.test(step.exp) ? Number(step.exp) : undefined;
  return { i, k, done: step.done === true, runner, ...(exp !== undefined && { exp }), text: stepWords(step), raw };
}

/** A plan step in words (INTERFACES.md 13). Amounts are micro-USD; sizes and prices are Hyperliquid's strings. */
export function stepWords(step: Record<string, unknown>): string {
  const usd = (v: unknown) => `$${(Number(v ?? 0) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  switch (step.k) {
    case "cancel":
      return "cancel the resting orders that add risk";
    case "repay":
      return `repay ${usd(step.amt)} to the pool from the account's USDC`;
    case "perp":
      return `${step.buy ? "buy" : "sell"} ${String(step.sz)} ${String(step.coin)} at ${String(step.px)}, reduce-only, at once or not at all`;
    case "sell":
      return `sell ${String(step.amt)} units of ${String(step.tok)} through 1Click for at least ${usd(step.min)}`;
    case "to_hl":
      return `move ${usd(step.amt)} of USDC to the account's Hyperliquid address`;
    case "home":
      return `bring ${usd(step.amt)} of USDC home from Hyperliquid`;
    // Phase 6 (INTERFACES.md 25): USDC amounts are micro-USD; collateral amounts are the token's own units.
    case "p_borrow":
      return `borrow ${usd(step.amt)} from our pool, or what a fresh verdict allows if that is less`;
    case "l_supply":
      return `post ${String(step.amt)} units of ${String(step.tok)} at ${lenderName(step.l)} as collateral`;
    case "l_borrow":
      return `borrow ${usd(step.amt)} of USDC from ${lenderName(step.l)}, or the room a fresh verdict gives if that is less`;
    case "to_evm":
      return `move ${String(step.amt)} units of ${String(step.tok)} through 1Click to the account's own Ethereum address`;
    case "e_home":
      return `bring ${usd(step.amt)} of USDC home from the account's Ethereum address through 1Click`;
    case "l_repay":
      return `repay ${usd(step.amt)} to ${lenderName(step.l)} from the account's USDC`;
    case "l_add":
      return `add ${String(step.amt)} units of ${String(step.tok)} to the collateral at ${lenderName(step.l)}`;
    default:
      return `a step of kind ${String(step.k)}`;
  }
}

/** A lender by its name in words (INTERFACES.md 24: "aave" and "rhea"). */
export function lenderName(l: unknown): string {
  return l === "aave" ? "Aave" : l === "rhea" ? "Rhea" : `the lender ${String(l)}`;
}

/** The account's funding plan (INTERFACES.md 25): what `fund(amount)` stored from the held verdict's `fund` steps. */
export interface FundingView {
  /** "f" and the verdict's block, so it can't be mistaken for the unwind plan. */
  pid: string;
  /** What the owner asked for in all, micro-USD, as the account stores it. */
  amount: string;
  storedAtMs: number | null;
  /** The plan lasts 30 minutes from when it was stored. */
  expiresAtMs: number | null;
  steps: PlanStep[];
}

/** get_state().funding, or null when the account has none (every account made before Phase 6). */
export function readFunding(state: { funding?: unknown } | null | undefined): FundingView | null {
  const funding = state?.funding as { pid?: unknown; amount?: unknown; stored_at?: unknown; expires_at?: unknown; steps?: unknown } | null | undefined;
  if (!funding || typeof funding !== "object") return null;
  const steps = Array.isArray(funding.steps) ? funding.steps : [];
  return {
    pid: String(funding.pid ?? ""),
    amount: String(funding.amount ?? "0"),
    storedAtMs: nsToMs(funding.stored_at),
    expiresAtMs: nsToMs(funding.expires_at),
    steps: steps.map((step, i) => planStep(step, i)),
  };
}

/** One lender position in a verdict's `ext` (INTERFACES.md 25): micro-USD and bp. */
export interface LenderExt {
  l: "aave" | "rhea";
  /** Collateral posted at the lender, and what is owed to it. */
  c: number;
  d: number;
  /** The cushion; 0 with no debt. */
  hf_bp: number;
  /** The lender's borrow and deposit rates. */
  r_bp: number;
  s_bp: number;
  /** What the lender would still lend at the target cushion. */
  room: number;
  liq_bp: number;
}

/** A verdict's `ext`: at most one entry per lender, aave first. Anything else is dropped; a missing number counts 0. */
export function readExt(ext: unknown): LenderExt[] {
  if (!Array.isArray(ext)) return [];
  const amount = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const out: LenderExt[] = [];
  for (const entry of ext as (Record<string, unknown> | null)[]) {
    const l = entry?.l;
    if ((l !== "aave" && l !== "rhea") || out.some((e) => e.l === l)) continue;
    out.push({ l, c: amount(entry!.c), d: amount(entry!.d), hf_bp: amount(entry!.hf_bp), r_bp: amount(entry!.r_bp), s_bp: amount(entry!.s_bp), room: amount(entry!.room), liq_bp: amount(entry!.liq_bp) });
  }
  return out.sort((a, b) => (a.l === b.l ? 0 : a.l === "aave" ? -1 : 1));
}

/**
 * A lender action the account still counts as under way (INTERFACES.md 25; FUNDING.md 4.4): Rhea finishes a borrow or
 * a withdrawal a block or two after the account's call returns, so the account lists it for 20 blocks, and nothing
 * that adds risk runs until `untilBlock` has passed.
 */
export interface PendingLender {
  lender: string;
  /** `borrow` or `withdraw`. */
  kind: string;
  amount: string;
  untilBlock: number;
}

/**
 * The lender action in get_state().pending, or null. `pending` is a list today (`{"lender": {...}}` beside the
 * borrows and transfers); an object with a `lender` field reads the same way.
 */
export function pendingLender(pending: unknown): PendingLender | null {
  const entries: unknown[] = Array.isArray(pending) ? pending : pending && typeof pending === "object" ? [pending] : [];
  for (const entry of entries) {
    const l = (entry as { lender?: Record<string, unknown> } | null)?.lender;
    if (!l || typeof l !== "object") continue;
    const until = typeof l.until_block === "number" ? l.until_block : typeof l.until_block === "string" && /^\d+$/.test(l.until_block) ? Number(l.until_block) : Number.NaN;
    if (!Number.isFinite(until)) continue;
    return { lender: String(l.lender ?? ""), kind: String(l.kind ?? ""), amount: String(l.amount ?? ""), untilBlock: until };
  }
  return null;
}

/** One pending 1Click transfer (INTERFACES.md 14). */
export interface PendingTransfer {
  id: string;
  kind: string;
  token: string;
  amount: string;
  dep: string;
  /** Block time, ns, as the account stores it. */
  deadline: string;
  deadlineMs: number | null;
}

/** The `transfer` entries of get_state().pending. Borrows and anything else are left out. */
export function pendingTransfers(pending: unknown): PendingTransfer[] {
  if (!Array.isArray(pending)) return [];
  const out: PendingTransfer[] = [];
  for (const entry of pending) {
    const t = (entry as { transfer?: Record<string, unknown> } | null)?.transfer;
    if (!t || typeof t !== "object") continue;
    out.push({
      id: String(t.id ?? ""),
      kind: String(t.kind ?? ""),
      token: String(t.token ?? ""),
      amount: String(t.amount ?? ""),
      dep: String(t.dep ?? ""),
      deadline: String(t.deadline ?? "0"),
      deadlineMs: nsToMs(t.deadline),
    });
  }
  return out;
}

/** A transfer is overdue once its deadline (the quote's exp plus 30 minutes) has passed. */
export function isOverdue(transfer: PendingTransfer, nowMs: number): boolean {
  return transfer.deadlineMs !== null && transfer.deadlineMs > 0 && nowMs > transfer.deadlineMs;
}

/** A NEAR U64 time in ns (string or number) as ms; null when missing or zero. */
export function nsToMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value / 1e6);
  if (typeof value === "string" && /^\d+$/.test(value) && value !== "0") return Number(BigInt(value) / 1_000_000n);
  return null;
}
