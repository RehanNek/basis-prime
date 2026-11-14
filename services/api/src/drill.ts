// Phase 4's endpoints (INTERFACES.md 17), testnet only:
//
//   GET  /api/drill            the drill's nBTC/BTC ratio and owner, and the stand-in's fault in force; with
//                              ?account=<id>, also the ratio pb-risk reads for that account (Phase 5, INTERFACES.md 21)
//   POST /api/drill/fault      {fault: "none" | "refund" | "fail" | "late", delay_seconds?}: sets the stand-in's fault
//                              switch with SHIM_ADMIN_TOKEN, which never leaves the backend
//   GET  /api/keeper/:account  the keeper's log lines for the account (its checks, gateway runs and steps, with their
//                              transactions and attestations), and whether the keeper is running. Phase 6, stage 2:
//                              also its settlements, and our Rhea copy's BTC price with the hold on it, if one is set
//
// The fault switch is the stand-in's (services/oneclick-shim/src/server.ts): GET and POST /admin/fault with
// "Authorization: Bearer <token>", body {"mode", "delaySeconds"}. It applies to every swap whose deposit arrives
// while it is set.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import type { Deps } from "./handlers.js";
import { soft } from "./handlers.js";
import { NotDeployedError } from "./rpc.js";
import { asObject, badRequest, HttpError, isPrimeAccount } from "./validate.js";

export type FaultMode = "none" | "refund" | "fail" | "late";
export const FAULT_MODES: FaultMode[] = ["none", "refund", "fail", "late"];
/** The stand-in's own default for a late delivery: 10 minutes. */
export const DEFAULT_LATE_SECONDS = 600;

export interface Fault {
  mode: FaultMode;
  delaySeconds: number;
}

export interface ShimAdmin {
  get(): Promise<Fault>;
  set(fault: Fault): Promise<Fault>;
}

/** The stand-in's fault switch. The token goes in the Authorization header only, and never into an error. */
export function shimAdmin(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): ShimAdmin {
  const url = `${baseUrl.replace(/\/+$/, "")}/admin/fault`;
  const call = async (init: RequestInit): Promise<Fault> => {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new HttpError(502, "shim_unreachable", `The 1Click stand-in is unreachable at ${new URL(url).host}: pnpm --filter @pb/oneclick-shim start`);
    }
    const body = (await response.json().catch(() => null)) as { fault?: Fault; message?: string } | null;
    if (!response.ok || !body?.fault) {
      const why = typeof body?.message === "string" ? body.message.split(token).join("<token>") : `HTTP ${response.status}`;
      throw new HttpError(502, "shim_fault", `The stand-in's fault switch answered: ${why}`);
    }
    return body.fault;
  };
  return { get: () => call({ method: "GET" }), set: (fault) => call({ method: "POST", body: JSON.stringify(fault) }) };
}

export interface Ratio {
  bp: number;
  set_at: string;
}

/**
 * One account's own ratio (INTERFACES.md 21): get_ratio_for answers it, or the shared one when the account has none.
 * Null while the drill's code has no get_ratio_for (the old code): pb-risk then reads the shared get_ratio.
 */
export async function ratioFor(deps: Deps, account: string): Promise<Ratio | null> {
  try {
    return (await deps.chain.view<Ratio>(deps.config.ids.drill, "get_ratio_for", { account_id: account })).value;
  } catch (error) {
    if (error instanceof NotDeployedError) return null;
    throw error;
  }
}

/**
 * GET /api/drill: the ratio pb-risk reads for nBTC on testnet, the drill's owner, and the fault in force. With an
 * account, also the ratio pb-risk reads for that account: its own if it has one (`per_account` says whether the drill's
 * code knows per-account ratios yet).
 */
export async function getDrill(deps: Deps, account?: string | null) {
  const { ids } = deps.config;
  if (account && !isPrimeAccount(account, ids.factory)) throw badRequest(`account must be a client account, <name>.${ids.factory}`);
  const [ratio, owner, own] = await Promise.all([
    soft(deps.chain.view<Ratio>(ids.drill, "get_ratio")),
    soft(deps.chain.view<string>(ids.drill, "owner")),
    account ? ratioFor(deps, account) : Promise.resolve(null),
  ]);
  const accountRatio = account
    ? {
        account,
        per_account: own !== null,
        ratio: own ?? ratio?.value ?? null,
        /** Whether it is the shared ratio: no ratio of its own, or one equal to the shared one. */
        shared: own === null || (ratio !== null && own.bp === ratio.value.bp && own.set_at === ratio.value.set_at),
      }
    : null;
  let fault: Fault | null = null;
  let faultError: string | null = null;
  if (!deps.shimAdmin) {
    faultError = "SHIM_ADMIN_TOKEN or SHIM_URL is empty in the backend's .env, so the fault switch is off";
  } else {
    try {
      fault = await deps.shimAdmin.get();
    } catch (error) {
      faultError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    network: ids.network,
    drill_id: ids.drill,
    deployed: ratio !== null,
    block_height: ratio?.blockHeight ?? null,
    ratio: ratio?.value ?? null,
    owner: owner?.value ?? null,
    faults_enabled: deps.shimAdmin !== undefined,
    fault,
    fault_error: faultError,
    account_ratio: accountRatio,
  };
}

/** POST /api/drill/fault {fault, delay_seconds?}. */
export async function postDrillFault(deps: Deps, body: unknown) {
  const fields = asObject(body);
  const mode = fields.fault;
  if (!FAULT_MODES.includes(mode as FaultMode)) throw badRequest(`fault must be one of ${FAULT_MODES.join(", ")}`);
  const delay = fields.delay_seconds ?? DEFAULT_LATE_SECONDS;
  if (typeof delay !== "number" || !Number.isInteger(delay) || delay < 1 || delay > 86_400) throw badRequest("delay_seconds must be a whole number of seconds from 1 to 86400");
  if (!deps.shimAdmin) throw new HttpError(503, "faults_off", "The fault switch is off: SHIM_ADMIN_TOKEN or SHIM_URL is empty in the backend's .env");
  if (deps.limits.faults && !deps.limits.faults.take()) throw new HttpError(429, "too_many_faults", "At most 10 fault changes a minute; try again shortly");
  const fault = await deps.shimAdmin.set({ mode: mode as FaultMode, delaySeconds: delay });
  return { fault };
}

// ---------- the keeper's log ----------

export interface KeeperEvent {
  t: string;
  event: string;
  msg?: string;
  account?: string;
  [field: string]: unknown;
}

/** The keeper's log lines this endpoint passes on. Ticks and starts only say whether the keeper is running. */
const ACCOUNT_EVENTS = ["verdict", "account", "decide", "check", "gateway", "step", "transfer", "note", "error", "hl_post", "settle"];

/**
 * Phase 6, stage 2: our Rhea copy's BTC price as the keeper keeps it (services/keeper/src/rhea-price.ts). The keeper
 * writes the copy's price, Hyperliquid's oracle price and the hold in force on every tick, and a `rhea_price` line
 * whenever it sets the price, a hold starts or ends, or something is in the way. A hold is the testnet drill's
 * switch: while it is on, the keeper keeps the copy's price `shift_bp` from the oracle instead of at it.
 */
export interface KeeperRhea {
  /** What the copy counts a bitcoin at, and Hyperliquid's oracle price, in dollars. */
  btc_usd: number | null;
  oracle_usd: number | null;
  /** The hold on the price, if one is in force: how far from the oracle, until when (unix ms), and who set it. */
  hold: { shift_bp: number; until_ms: number; by: string | null } | null;
  /** The keeper's latest line about the price. */
  last: { t: string; msg: string | null; tx: string | null } | null;
}

/** Null when the keeper isn't keeping the copy's price at all (no RHEA_ACCOUNT_ID in its settings). */
function keeperRhea(events: KeeperEvent[], lastTick: KeeperEvent | undefined): KeeperRhea | null {
  if (!lastTick || !("rhea_btc" in lastTick)) return null;
  const number = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const h = lastTick.rhea_hold as { shift_bp?: unknown; until_ms?: unknown; by?: unknown } | null | undefined;
  const line = events.filter((e) => e.event === "rhea_price").at(-1);
  return {
    btc_usd: number(lastTick.rhea_btc),
    oracle_usd: number(lastTick.btc_oracle),
    hold: h && typeof h.shift_bp === "number" && typeof h.until_ms === "number" ? { shift_bp: h.shift_bp, until_ms: h.until_ms, by: typeof h.by === "string" ? h.by : null } : null,
    last: line ? { t: line.t, msg: line.msg ?? null, tx: typeof line.tx === "string" ? line.tx : null } : null,
  };
}
/**
 * A keeper that ticked this recently is running. Its ticks start 15 s apart, but one waits for whatever it sent: a
 * check or a gateway run that sits in OutLayer's queue can hold a tick for up to OUTLAYER_WAIT_MS (3 minutes). So
 * 4 minutes since 11 Nov (1 before), the same as the keeper's own gate scripts allow.
 */
export const KEEPER_ALIVE_MS = 240_000;

/** The last `maxBytes` of a JSON-lines file, parsed. A missing file has no events. */
export function readJsonLines(file: string, maxBytes = 4_000_000): { found: boolean; events: KeeperEvent[] } {
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
    if (length < size) lines.shift();
    const events: KeeperEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as KeeperEvent;
        if (parsed && typeof parsed.event === "string" && typeof parsed.t === "string") events.push(parsed);
      } catch {
        // not a log line
      }
    }
    return { found: true, events };
  } finally {
    closeSync(fd);
  }
}

/** GET /api/keeper/:account: the keeper's lines for the account, newest first, and whether the keeper is running. */
export function getKeeper(deps: Deps, account: string, limit = 200) {
  const { factory } = deps.config.ids;
  if (!isPrimeAccount(account, factory)) throw badRequest(`account must be a client account, <name>.${factory}`);
  const { found, events } = (deps.readKeeperLog ?? readJsonLines)(deps.config.keeperLogFile);
  const lastTick = events.filter((e) => e.event === "tick").at(-1);
  const lastStart = events.filter((e) => e.event === "start" && typeof e.msg === "string" && e.msg.startsWith("the keeper is starting")).at(-1);
  const mine = events.filter((e) => e.account === account && ACCOUNT_EVENTS.includes(e.event));
  return {
    account,
    log_found: found,
    keeper: {
      last_tick_at: lastTick?.t ?? null,
      running: lastTick ? deps.now() - Date.parse(lastTick.t) <= KEEPER_ALIVE_MS : false,
      dry_run: Boolean(lastStart?.msg?.includes("dry run")),
      watches: Array.isArray(lastTick?.accounts) ? (lastTick.accounts as unknown[]).includes(account) : false,
      nbtc_ratio_bp: typeof lastTick?.nbtc_ratio_bp === "number" ? lastTick.nbtc_ratio_bp : null,
      rhea: keeperRhea(events, lastTick),
    },
    events: mine.slice(-limit).reverse(),
  };
}
