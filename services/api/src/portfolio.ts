// INTERFACES.md 49.3: GET /api/portfolio/:account, the points of Home's chart.
//
// One point per check result (verdict) the keeper saw the account store, oldest first: what the engine counted the
// account as worth (`eq`, micro-USD) and what it owed our pool then. They are read from the keeper's own log, which
// the backend already reads for GET /api/keeper: the loop's `verdict` lines (an account with a loan), and the
// `check` lines of the checks the client's page asked for (49.4), which carry the same figures. Nothing is read from
// the chain, and an account's answer is kept half a minute.
//
// A line from before 13 Nov has no debt on it: its point says `debt_micro: null`.
import { readJsonLines, type KeeperEvent } from "./drill.js";
import type { Deps } from "./handlers.js";
import { badRequest, isPrimeAccount } from "./validate.js";

export const PORTFOLIO_TTL_MS = 30_000;
/** The newest points kept in one answer. */
export const MAX_POINTS = 500;

export interface PortfolioPoint {
  t_ms: number;
  /** The engine's equity for the account, in micro-USD. It can be below zero. */
  equity_micro: number;
  /** What the account owed our pool, in micro-USDC; null where the log line doesn't say. */
  debt_micro: number | null;
}

/** The points one account's log lines give, oldest first, one for a verdict however many lines name it. */
export function portfolioPoints(events: KeeperEvent[], account: string): PortfolioPoint[] {
  const byVerdict = new Map<string, PortfolioPoint>();
  for (const e of events) {
    if (e.account !== account || (e.event !== "verdict" && e.event !== "check")) continue;
    if (typeof e.eq !== "number" || !Number.isFinite(e.eq)) continue;
    const t = Date.parse(e.t);
    if (!Number.isFinite(t)) continue;
    const debt = typeof e.debt === "string" && /^\d{1,30}$/.test(e.debt) ? Number(e.debt) : typeof e.debt === "number" && Number.isFinite(e.debt) && e.debt >= 0 ? e.debt : null;
    // The verdict's block names it. The earliest line that shows it gives its time.
    const key = typeof e.blk === "number" ? `blk:${e.blk}` : `t:${t}`;
    const had = byVerdict.get(key);
    if (!had) {
      byVerdict.set(key, { t_ms: t, equity_micro: e.eq, debt_micro: debt });
      continue;
    }
    had.t_ms = Math.min(had.t_ms, t);
    if (had.debt_micro === null && debt !== null) had.debt_micro = debt;
  }
  return [...byVerdict.values()].sort((a, b) => a.t_ms - b.t_ms).slice(-MAX_POINTS);
}

/** GET /api/portfolio/:account. The server has already checked that the asker may see the account. */
export async function getPortfolio(deps: Deps, accountId: string) {
  const { factory } = deps.config.ids;
  if (!isPrimeAccount(accountId, factory)) throw badRequest(`account must be a client account, <name>.${factory}`);
  return deps.hlCache.get(`portfolio:${accountId}`, PORTFOLIO_TTL_MS, async () => {
    const log = (deps.readKeeperLog ?? readJsonLines)(deps.config.keeperLogFile);
    return { points: portfolioPoints(log.events, accountId), read_at_ms: deps.now(), keeper_log: log.found };
  });
}
