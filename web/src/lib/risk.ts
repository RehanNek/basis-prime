// What the Risk page shows (PLAN.md 5.8; INTERFACES.md 13, 14 and 17), worked out from get_state, the verdict and the
// keeper's log: the stored plan with each step's status, pending transfers (overdue ones marked), the bands next to
// today's prices, the margin-call clock, and the history of verdicts and of what the keeper did.
import type { KeeperEvent } from './api.ts';
import type { AccountState } from './types.ts';

// ---------- the stored plan ----------

export type StepRunner = 'gateway' | 'execute_step' | 'words';

export interface PlanStep {
  i: number;
  k: string;
  done: boolean;
  runner: StepRunner;
  /** The quote's expiry, unix ms (sell, to_hl, home). */
  exp?: number;
  text: string;
}

export interface PlanView {
  pid: string;
  action: string;
  storedAtMs: number | null;
  steps: PlanStep[];
  /** `plan` (Phase 4) or `confirmed_plan` (accounts made before it: the steps are words only). */
  source: 'plan' | 'confirmed_plan';
}

const GATEWAY_KINDS = ['cancel', 'perp'];
const EXECUTE_KINDS = ['repay', 'sell', 'to_hl', 'home'];

/** A NEAR time in ns (string or number) as ms; null when missing or zero. */
export function nsToMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value / 1e6);
  if (typeof value === 'string' && /^\d+$/.test(value) && value !== '0') return Number(BigInt(value) / 1_000_000n);
  return null;
}

const dollars = (micro: unknown) => `$${(Number(micro ?? 0) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A plan step in words (INTERFACES.md 13). */
export function stepWords(step: Record<string, unknown>): string {
  switch (step.k) {
    case 'cancel':
      return 'Cancel the resting orders that add risk.';
    case 'repay':
      return `Repay ${dollars(step.amt)} to the pool from the account's USDC.`;
    case 'perp':
      return `${step.buy ? 'Buy' : 'Sell'} ${String(step.sz)} ${String(step.coin)} at ${String(step.px)}: reduce-only, at once or not at all.`;
    case 'sell':
      return `Sell ${String(step.amt)} units of ${String(step.tok)} through 1Click, for at least ${dollars(step.min)}.`;
    case 'to_hl':
      return `Move ${dollars(step.amt)} of USDC to the account's Hyperliquid address.`;
    case 'home':
      return `Bring ${dollars(step.amt)} of USDC home from Hyperliquid.`;
    default:
      return `A step of kind ${String(step.k)}.`;
  }
}

export function readPlan(state: Pick<AccountState, 'plan' | 'deleverage'> | null | undefined): PlanView | null {
  if (!state) return null;
  const plan = state.plan as { pid?: unknown; action?: unknown; stored_at?: unknown; steps?: unknown } | null | undefined;
  if (plan && typeof plan === 'object') {
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    return { pid: String(plan.pid ?? ''), action: typeof plan.action === 'string' ? plan.action : 'DELEVERAGE', storedAtMs: nsToMs(plan.stored_at), steps: steps.map(planStep), source: 'plan' };
  }
  const confirmed = state.deleverage?.confirmed_plan as { at?: unknown; blk?: unknown; steps?: unknown } | null | undefined;
  if (confirmed && typeof confirmed === 'object') {
    const steps = Array.isArray(confirmed.steps) ? confirmed.steps : [];
    return { pid: String(confirmed.blk ?? ''), action: 'DELEVERAGE', storedAtMs: nsToMs(confirmed.at), steps: steps.map(planStep), source: 'confirmed_plan' };
  }
  return null;
}

function planStep(raw: unknown, i: number): PlanStep {
  if (typeof raw === 'string') return { i, k: 'words', done: false, runner: 'words', text: raw };
  const step = (raw ?? {}) as Record<string, unknown>;
  const k = typeof step.k === 'string' ? step.k : '?';
  const runner: StepRunner = GATEWAY_KINDS.includes(k) ? 'gateway' : EXECUTE_KINDS.includes(k) ? 'execute_step' : 'words';
  const exp = typeof step.exp === 'number' ? step.exp : typeof step.exp === 'string' && /^\d+$/.test(step.exp) ? Number(step.exp) : undefined;
  return { i, k, done: step.done === true, runner, ...(exp !== undefined && { exp }), text: stepWords(step) };
}

export interface StepStatus {
  label: string;
  tone: 'success' | 'info' | 'warning' | 'secondary' | 'danger';
  /** A link to what ran it: the transaction, or the gateway's attestation. */
  link?: { href: string; text: string };
}

const QUOTE_MARGIN_MS = 5 * 60_000;

/**
 * Where a step stands. execute_step steps say so in the account (`done`). The gateway's steps are recorded in its own
 * storage, so the page reads the keeper's log for the gateway's answer.
 */
export function stepStatus(plan: PlanView, step: PlanStep, events: KeeperEvent[], nowMs: number, txUrl: (hash: string) => string): StepStatus {
  if (step.runner === 'words') return { label: 'In words only', tone: 'secondary' };
  if (step.runner === 'gateway') {
    // The gateway's runs for this plan, newest first. A step placed by any run stays placed; a later run skips it.
    const runs = events.filter((e) => e.event === 'gateway' && e.mode === 'deleverage' && String(e.pid ?? '') === plan.pid);
    if (runs.length === 0) return { label: 'Waiting for the gateway', tone: 'info' };
    const attestation = (run: KeeperEvent) => (typeof run.attestation_url === 'string' ? { link: { href: run.attestation_url, text: 'attestation' } } : {});
    for (const run of runs) {
      const placed = entries(run.placed).find((p) => p.i === step.i);
      if (placed) return { label: `Placed: ${String(placed.status ?? 'sent')}${placed.filled_sz ? `, ${String(placed.filled_sz)} filled` : ''}`, tone: 'success', ...attestation(run) };
    }
    const latest = runs[0]!;
    const refused = entries(latest.refused).find((p) => p.i === step.i);
    if (refused) return { label: `Refused: ${String(refused.code ?? '')} ${String(refused.reason ?? '')}`.trim(), tone: 'danger', ...attestation(latest) };
    const skipped = entries(latest.skipped).find((p) => p.i === step.i);
    if (skipped) return { label: `Skipped: ${String(skipped.why ?? '')}`, tone: 'secondary', ...attestation(latest) };
    if (latest.ok === false) return { label: `The gateway refused: ${String(latest.code ?? '')} ${String(latest.reason ?? '')}`.trim(), tone: 'danger', ...attestation(latest) };
    return { label: 'The gateway ran; not placed', tone: 'warning', ...attestation(latest) };
  }
  const ran = events.find((e) => e.event === 'step' && String(e.pid ?? '') === plan.pid && e.i === step.i);
  const link = ran && typeof ran.tx === 'string' ? { href: txUrl(ran.tx), text: 'transaction' } : undefined;
  if (step.done) return { label: 'Done', tone: 'success', ...(link && { link }) };
  if (ran && ran.ok === false) return { label: `Refused: ${String(ran.failure ?? '')}`, tone: 'danger', ...(link && { link }) };
  if (step.exp !== undefined && step.exp - nowMs < QUOTE_MARGIN_MS) return { label: 'Its quote is too close to expiry: the next verdict re-plans it', tone: 'warning' };
  return { label: 'Waiting for execute_step', tone: 'info' };
}

/** The gateway's `placed`, `refused` or `skipped` list, as logged by the keeper. */
function entries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Record<string, unknown>[]) : [];
}

// ---------- pending transfers ----------

export interface PendingTransfer {
  id: string;
  kind: string;
  token: string;
  amount: string;
  dep: string;
  deadlineMs: number | null;
}

export function pendingTransfers(pending: unknown): PendingTransfer[] {
  if (!Array.isArray(pending)) return [];
  return pending.flatMap((entry) => {
    const t = (entry as { transfer?: Record<string, unknown> } | null)?.transfer;
    if (!t || typeof t !== 'object') return [];
    return [{ id: String(t.id ?? ''), kind: String(t.kind ?? ''), token: String(t.token ?? ''), amount: String(t.amount ?? ''), dep: String(t.dep ?? ''), deadlineMs: nsToMs(t.deadline) }];
  });
}

/** Past its deadline (the quote's exp plus 30 minutes): borrowing and withdrawing with a loan are refused meanwhile. */
export function isOverdue(transfer: PendingTransfer, nowMs: number): boolean {
  return transfer.deadlineMs !== null && nowMs > transfer.deadlineMs;
}

export const TRANSFER_KINDS: Record<string, string> = {
  sell: 'a sale through 1Click',
  to_hl: 'USDC to Hyperliquid',
  home: 'USDC home from Hyperliquid',
  // Stage 4 (INTERFACES.md 36): the moves between NEAR and Aave's chain. lib/moves.ts says each one in full.
  to_evm: 'a move to the account’s address on Aave’s chain',
  e_home: 'a move home from Aave’s chain',
};

// ---------- the margin-call clock (RISK_ENGINE.md 8.1) ----------

export const MARGIN_CALL_LIMIT_MS = 4 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface MarginClock {
  /** Time below the safety buffer over the last 24 hours, counting an open interval up to now. */
  belowMs: number;
  leftMs: number;
  /** When the current margin call started, if one is open. */
  sinceMs: number | null;
  below: boolean;
}

/** As the contract counts it (contracts/account/src/records.rs, MarginCall::total). */
export function marginClock(mc: AccountState['margin_call'], nowMs: number): MarginClock {
  const intervals = mc?.intervals ?? [];
  const below = mc?.below === true;
  const cutoff = nowMs - DAY_MS;
  let total = 0;
  intervals.forEach(([start, end], i) => {
    const s = Math.max(nsToMs(start) ?? 0, cutoff);
    const e = below && i === intervals.length - 1 ? nowMs : (nsToMs(end) ?? 0);
    total += Math.max(0, e - s);
  });
  return { belowMs: total, leftMs: Math.max(0, MARGIN_CALL_LIMIT_MS - total), sinceMs: nsToMs(mc?.since), below };
}

export function minutes(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

// ---------- bands (RISK_ENGINE.md 8.3) ----------

export interface BandRow {
  asset: string;
  field: string;
  kind: 'price' | 'pi';
  /** USD for a coin, basis points for a token's ratio. */
  level: number;
  meaning: string;
  now: number | null;
}

const PRICE_FIELDS: Record<string, string> = {
  hl50: "Hyperliquid's margin ratio reaches 50%",
  hl100: "Hyperliquid's margin ratio reaches 100%: it liquidates",
  im: 'equity reaches the initial requirement: WATCH',
  mr: 'equity reaches the safety buffer: MARGIN_CALL',
};
const PI_FIELDS: Record<string, string> = {
  im_bp: 'equity reaches the initial requirement: WATCH',
  mr_bp: 'equity reaches the safety buffer: MARGIN_CALL',
  dl_bp: 'equity reaches 0.8 times the buffer: DELEVERAGE',
};

/** The verdict's bands, with today's mark (coins) or ratio (tokens) beside each. */
export function bandRows(bands: unknown, prices: { marks: Record<string, number>; pi: Record<string, number> }): BandRow[] {
  if (!bands || typeof bands !== 'object') return [];
  const rows: BandRow[] = [];
  for (const [asset, entry] of Object.entries(bands as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    for (const [field, value] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof value !== 'number') continue;
      if (field in PRICE_FIELDS) rows.push({ asset, field, kind: 'price', level: value / 1e6, meaning: PRICE_FIELDS[field]!, now: prices.marks[asset] ?? null });
      else if (field in PI_FIELDS) rows.push({ asset, field, kind: 'pi', level: value, meaning: PI_FIELDS[field]!, now: prices.pi[asset] ?? null });
    }
  }
  return rows;
}

export function showLevel(kind: BandRow['kind'], value: number): string {
  return kind === 'pi' ? (value / 10_000).toFixed(4) : `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

// ---------- history, from the keeper's log ----------

export interface VerdictLine {
  at: string;
  state: string;
  action: string;
  blk: number | null;
  eq: number | null;
  mm: number | null;
  im: number | null;
  /** When the keeper asked for this verdict: its request_check transaction and OutLayer's attestation of the run. */
  links: { href: string; text: string }[];
}

/** A verdict the keeper asked for arrives within this long of its check (OutLayer's queue can take a few minutes). */
const CHECK_TO_VERDICT_MS = 240_000;

/**
 * The verdicts the keeper saw, newest first (as the log is given). A verdict that came within 90 s after one of the
 * keeper's checks links to that check's transaction and attestation.
 */
export function verdictHistory(events: KeeperEvent[], txUrl?: (hash: string) => string): VerdictLine[] {
  const checks = events.filter((e) => e.event === 'check' && typeof e.tx === 'string');
  return events
    .filter((e) => e.event === 'verdict')
    .map((e) => {
      const seen = Date.parse(e.t);
      const asked = checks.find((c) => {
        const at = Date.parse(c.t);
        return at <= seen && seen - at <= CHECK_TO_VERDICT_MS;
      });
      const links: { href: string; text: string }[] = [];
      if (asked && txUrl) links.push({ href: txUrl(String(asked.tx)), text: 'check' });
      if (asked && typeof asked.attestation_url === 'string') links.push({ href: asked.attestation_url, text: 'attestation' });
      return { at: e.t, state: String(e.state ?? '?'), action: String(e.action ?? '?'), blk: typeof e.blk === 'number' ? e.blk : null, eq: num(e.eq), mm: num(e.mm), im: num(e.im), links };
    });
}

/** The coin a wrapped token tracks (RISK_ENGINE.md 3.3). */
const TRACKS: Record<string, string> = { nBTC: 'BTC', 'ETH.b': 'ETH', ETH: 'ETH', USDT: 'the dollar' };

/**
 * The engine's top risks (RISK_ENGINE.md 4.5's scenario names) in words. "replay 2020-03-12 up (from 2020-03-13 02:16
 * UTC)" is that day's market replayed with prices rising, "ADL BTC ..." is Hyperliquid auto-deleveraging the BTC
 * position, and "nBTC depeg 20%" is nBTC losing 20% against BTC. Anything else stays as the engine wrote it.
 */
export function riskWords(name: string): string {
  const replay = /^replay (\d{4}-\d{2}-\d{2}) (up|down)(?: \(from ([^)]+)\))?/.exec(name);
  if (replay) return `The market of ${replay[1]} replayed with prices ${replay[2] === 'up' ? 'rising' : 'falling'}${replay[3] ? `, from ${replay[3]}` : ''}`;
  const adl = /^ADL (\S+)/.exec(name);
  if (adl) return `Hyperliquid auto-deleveraging part of the ${adl[1]} position`;
  const depeg = /^(\S+) depeg (\d+)%/.exec(name);
  if (depeg) return `${depeg[1]} losing ${depeg[2]}% against ${TRACKS[depeg[1]!] ?? 'its coin'}`;
  return name;
}

export interface ActionLine {
  at: string;
  what: string;
  why?: string;
  ok: boolean;
  links: { href: string; text: string }[];
}

/** The keeper's checks, gateway runs and steps, newest first, each with its transaction and attestation. */
export function keeperActions(events: KeeperEvent[], txUrl: (hash: string) => string): ActionLine[] {
  const lines: ActionLine[] = [];
  for (const e of events) {
    const links: { href: string; text: string }[] = [];
    if (typeof e.tx === 'string' && e.tx) links.push({ href: txUrl(e.tx), text: 'transaction' });
    if (typeof e.attestation_url === 'string') links.push({ href: e.attestation_url, text: 'attestation' });
    if (e.event === 'check') lines.push({ at: e.t, what: 'Asked for a check', ...(typeof e.why === 'string' && { why: e.why }), ok: e.accepted !== false && !String(e.msg ?? '').startsWith('the check failed'), links });
    else if (e.event === 'gateway') lines.push({ at: e.t, what: `pb-gateway: ${String(e.mode ?? '')}${e.ok === false ? ` refused (${String(e.code ?? '')})` : ''}`, ok: e.ok !== false, links });
    else if (e.event === 'step') lines.push({ at: e.t, what: `execute_step: step ${String(e.i)} (${String(e.k)}) of plan ${String(e.pid)}`, ok: e.ok !== false, links });
    else if (e.event === 'transfer') lines.push({ at: e.t, what: String(e.msg ?? ''), ok: !/overdue/.test(String(e.msg ?? '')), links });
  }
  return lines;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ---------- the drill (testnet) ----------

/** Each step of a slide lands this far past its band (the risk side suggests 150-200 bp). */
export const SLIDE_BELOW_BP = 150;

/**
 * A slide from a verdict's nBTC bands (im_bp, mr_bp, dl_bp): each band less 150 bp, so the account goes WATCH,
 * MARGIN_CALL and DELEVERAGE in turn. Null when the verdict lacks one of them. On the small demo book at BTC $75,800
 * the bands are 0.8406, 0.7970 and 0.7594, so §17's example 0.84,0.80,0.75 would skip MARGIN_CALL.
 */
export function slideFromBands(bands: unknown, belowBp = SLIDE_BELOW_BP): string | null {
  const b = (bands as { nBTC?: Record<string, unknown> } | null | undefined)?.nBTC;
  const levels = [b?.im_bp, b?.mr_bp, b?.dl_bp];
  if (!levels.every((v): v is number => typeof v === 'number')) return null;
  const points = levels.map((bp) => bp - belowBp);
  if (points.some((bp) => bp <= 0 || bp > 10_000) || !(points[0]! > points[1]! && points[1]! > points[2]!)) return null;
  return points.map((bp) => (bp / 10_000).toFixed(4)).join(',');
}

/**
 * The slide command for the keeper's drill tool (INTERFACES.md 17). With an account it sets that account's own ratio
 * (INTERFACES.md 21), or the shared one while the drill has no per-account ratios yet.
 */
export function slideCommand(points: string, everyMinutes: string, account?: string): string {
  return `pnpm --filter @pb/keeper drill -- --slide ${points} --every ${everyMinutes}${account ? ` --account ${account}` : ''}`;
}

/** Checks a slide like "0.84,0.80,0.75": each a ratio above 0 and at most 1, with at most 4 decimals. */
export function slideProblem(points: string): string | null {
  const parts = points.split(',').map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => p === '')) return 'List ratios with commas, like 0.84,0.80,0.75';
  for (const p of parts) {
    if (!/^(0|1)?(\.\d{1,4})?$/.test(p) || p === '.') return `${p} isn't a ratio like 0.75`;
    const v = Number(p);
    if (!(v > 0 && v <= 1)) return `${p} must be above 0 and at most 1`;
  }
  return null;
}
