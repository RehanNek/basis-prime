// What the drill gate script (drill-demo.ts) sees while the keeper acts, as a record (PLAN.md 11.5): every verdict and
// change of state, every stored plan and each step's `done`, pending transfers, the account's BTC position on
// Hyperliquid, the ratio, and the keeper's own log lines for the account (its checks with their transactions and
// attestations, the gateway's placements, the steps it ran). The script only watches; it never acts for the keeper.
//
// The gate passes (RISK_ENGINE.md 8; PLAN.md 2, step 6) when, in this order, the account went WATCH, MARGIN_CALL and
// DELEVERAGE; a second DELEVERAGE verdict confirmed a stored DELEVERAGE plan; the BTC short got smaller after the
// plan was stored (the buy-back); and a HEALTHY verdict came after the plan.
import { KEEPER_ALIVE_MS } from "./config.js";
import type { LogEvent } from "./jsonl.js";
import { pendingTransfers, readPlan } from "./plan.js";
import type { AccountState } from "./state.js";

export interface Observation {
  at: number;
  state: AccountState | null;
  /** The account's BTC position on Hyperliquid (negative: a short), or null when it couldn't be read. */
  btc: number | null;
  ratioBp: number | null;
}

export interface WatchEvent {
  at: string;
  kind: "ratio" | "verdict" | "state" | "plan" | "step" | "transfer" | "position" | "keeper" | "note";
  what: string;
  data?: unknown;
}

export interface VerdictSeen {
  at: string;
  blk: number;
  received_block: number;
  nonce: number;
  state: string;
  action: string;
  eq: number | null;
  mm: number | null;
  im: number | null;
  bands: unknown;
  ratio_bp: number | null;
}

export interface DrillChecks {
  watch_seen: boolean;
  margin_call_seen: boolean;
  deleverage_verdicts: number;
  /** WATCH came first, then MARGIN_CALL, then DELEVERAGE. */
  in_order: boolean;
  plan_stored: { pid: string; action: string; steps: string[] } | null;
  confirmed_twice: boolean;
  buy_back: { gateway_placed: unknown[]; btc_at_plan: number | null; btc_now: number | null; bought: boolean };
  healthy_after_plan: boolean;
  pass: boolean;
}

/** The keeper log events the record keeps. */
const KEEPER_EVENTS = ["decide", "check", "gateway", "step", "transfer", "verdict", "note", "error"];

export class DrillWatch {
  readonly account: string;
  readonly events: WatchEvent[] = [];
  readonly verdicts: VerdictSeen[] = [];
  readonly plans: { at: string; pid: string; action: string; steps: string[] }[] = [];
  readonly placements: unknown[] = [];
  readonly stepRuns: unknown[] = [];
  readonly checksAsked: unknown[] = [];
  #verdictKey: string | undefined;
  #state: string | undefined;
  #planPid: string | undefined;
  #done = new Map<string, boolean>();
  #pending = new Set<string>();
  #btc: number | null | undefined;
  #ratio: number | null | undefined;
  #keeperSeen = new Set<string>();
  #planAt: number | undefined;
  #btcAtPlan: number | null = null;
  #healthyAfterPlan = false;

  constructor(account: string) {
    this.account = account;
  }

  #add(at: number, kind: WatchEvent["kind"], what: string, data?: unknown): WatchEvent {
    const event: WatchEvent = { at: new Date(at).toISOString(), kind, what, ...(data !== undefined && { data }) };
    this.events.push(event);
    return event;
  }

  note(at: number, what: string, data?: unknown): WatchEvent {
    return this.#add(at, "note", what, data);
  }

  /** Adds what changed since the last observation. Returns the new events. */
  observe(o: Observation): WatchEvent[] {
    const start = this.events.length;
    if (o.ratioBp !== null && o.ratioBp !== this.#ratio) {
      this.#add(o.at, "ratio", `the nBTC/BTC ratio is ${(o.ratioBp / 10_000).toFixed(4)}`, { bp: o.ratioBp });
      this.#ratio = o.ratioBp;
    }
    const held = o.state?.verdict;
    if (held) {
      const v = held.verdict;
      const key = `${v.blk}:${held.received_block}`;
      if (key !== this.#verdictKey) {
        this.#verdictKey = key;
        const seen: VerdictSeen = {
          at: new Date(o.at).toISOString(),
          blk: v.blk,
          received_block: held.received_block,
          nonce: v.nonce,
          state: v.state,
          action: v.action,
          eq: v.eq ?? null,
          mm: v.mm ?? null,
          im: v.im ?? null,
          bands: v.bands ?? null,
          ratio_bp: o.ratioBp,
        };
        this.verdicts.push(seen);
        this.#add(o.at, "verdict", `a verdict: ${v.state}, action ${v.action} (blk ${v.blk})`, seen);
        if (this.#state !== undefined && this.#state !== v.state) this.#add(o.at, "state", `the account went from ${this.#state} to ${v.state}`);
        this.#state = v.state;
        if (this.#planAt !== undefined && v.state === "HEALTHY") this.#healthyAfterPlan = true;
      }
    }
    const plan = readPlan(o.state);
    if (plan && plan.pid !== this.#planPid) {
      this.#planPid = plan.pid;
      const steps = plan.steps.map((s) => `${s.i}: ${s.text}`);
      this.plans.push({ at: new Date(o.at).toISOString(), pid: plan.pid, action: plan.action, steps });
      this.#add(o.at, "plan", `a ${plan.action} plan is stored (pid ${plan.pid}), ${plan.steps.length} step(s)`, { pid: plan.pid, action: plan.action, source: plan.source, steps: plan.steps.map((s) => s.raw) });
      if (plan.action === "DELEVERAGE" && this.#planAt === undefined) {
        this.#planAt = o.at;
        this.#btcAtPlan = this.#btc ?? o.btc;
      }
    }
    for (const step of plan?.steps ?? []) {
      const key = `${plan!.pid}:${step.i}`;
      if (step.done && !this.#done.get(key)) this.#add(o.at, "step", `step ${step.i} (${step.k}) of plan ${plan!.pid} is done`);
      this.#done.set(key, step.done);
    }
    const pending = pendingTransfers(o.state?.pending);
    for (const t of pending) if (!this.#pending.has(t.id)) this.#add(o.at, "transfer", `transfer ${t.id} (${t.kind}) is pending`, t);
    for (const id of this.#pending) if (!pending.some((t) => t.id === id)) this.#add(o.at, "transfer", `transfer ${id} is no longer pending`);
    this.#pending = new Set(pending.map((t) => t.id));
    if (o.btc !== null && (this.#btc === undefined || this.#btc === null || Math.abs(o.btc - this.#btc) >= 1e-6)) {
      if (this.#btc !== undefined && this.#btc !== null) this.#add(o.at, "position", `the BTC position went from ${this.#btc} to ${o.btc}`, { from: this.#btc, to: o.btc });
      else this.#add(o.at, "position", `the BTC position is ${o.btc}`, { to: o.btc });
      this.#btc = o.btc;
    }
    return this.events.slice(start);
  }

  /** Adds the keeper's log lines for this account that haven't been seen. Returns the new events. */
  keeper(lines: LogEvent[]): WatchEvent[] {
    const start = this.events.length;
    for (const line of lines) {
      if (line.account !== this.account || !KEEPER_EVENTS.includes(line.event)) continue;
      const key = `${line.t}|${line.event}|${line.msg ?? ""}`;
      if (this.#keeperSeen.has(key)) continue;
      this.#keeperSeen.add(key);
      const { t, event, msg, account: _account, ...data } = line;
      if (event === "gateway" && data.mode === "deleverage" && data.ok === true) this.placements.push({ at: t, ...data });
      if (event === "step") this.stepRuns.push({ at: t, ...data });
      if (event === "check") this.checksAsked.push({ at: t, ...data });
      this.events.push({ at: t, kind: "keeper", what: `${event}: ${msg ?? ""}`, data: { event, ...data } });
    }
    return this.events.slice(start);
  }

  /** HEALTHY again after a DELEVERAGE plan was stored. */
  done(): boolean {
    return this.#healthyAfterPlan;
  }

  checks(): DrillChecks {
    const first = (state: string) => this.verdicts.findIndex((v) => v.state === state);
    const [watch, call, dl] = [first("WATCH"), first("MARGIN_CALL"), first("DELEVERAGE")];
    const plan = this.plans.find((p) => p.action === "DELEVERAGE") ?? null;
    const deleverage = this.verdicts.filter((v) => v.action === "DELEVERAGE").length;
    const btcNow = this.#btc ?? null;
    const bought = this.#btcAtPlan !== null && btcNow !== null && btcNow > this.#btcAtPlan + 1e-6;
    const checks: Omit<DrillChecks, "pass"> = {
      watch_seen: watch >= 0,
      margin_call_seen: call >= 0,
      deleverage_verdicts: deleverage,
      in_order: watch >= 0 && call > watch && dl > call,
      plan_stored: plan ? { pid: plan.pid, action: plan.action, steps: plan.steps } : null,
      confirmed_twice: deleverage >= 2 && plan !== null,
      buy_back: { gateway_placed: this.placements, btc_at_plan: this.#btcAtPlan, btc_now: btcNow, bought },
      healthy_after_plan: this.#healthyAfterPlan,
    };
    return { ...checks, pass: checks.watch_seen && checks.margin_call_seen && checks.in_order && checks.confirmed_twice && bought && checks.healthy_after_plan };
  }
}

/** Whether the keeper's log shows it running for real and watching `account` with its loan. */
export function keeperSees(events: LogEvent[], account: string, nowMs: number): { ok: boolean; why: string; last_tick_at: string | null } {
  const ticks = events.filter((e) => e.event === "tick");
  const last = ticks.at(-1);
  if (!last) return { ok: false, why: "the keeper's log has no tick yet: start it with pnpm --filter @pb/keeper start", last_tick_at: null };
  const age = nowMs - Date.parse(last.t);
  if (age > KEEPER_ALIVE_MS) return { ok: false, why: `the keeper's last tick was ${Math.round(age / 1000)} s ago: is it running?`, last_tick_at: last.t };
  const start = events.filter((e) => e.event === "start" && typeof e.msg === "string" && e.msg.startsWith("the keeper is starting")).at(-1);
  if (start?.msg?.includes("dry run")) return { ok: false, why: "the keeper runs as a dry run: it sends nothing. Start it without --dry-run", last_tick_at: last.t };
  const listed = Array.isArray(last.accounts) && (last.accounts as unknown[]).includes(account);
  if (!listed) return { ok: false, why: `the keeper's last tick doesn't list ${account} yet (it reads the factory's list once a minute)`, last_tick_at: last.t };
  const seen = events.some((e) => e.event === "account" && e.account === account && e.loan === true);
  if (!seen) return { ok: false, why: `the keeper hasn't seen ${account} with a loan yet`, last_tick_at: last.t };
  return { ok: true, why: `the keeper ticked ${Math.round(age / 1000)} s ago and watches ${account} with its loan`, last_tick_at: last.t };
}
