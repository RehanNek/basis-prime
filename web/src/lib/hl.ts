// The account's Hyperliquid side as the pages show it (INTERFACES.md 8 and 11): the setup steps, the equity and
// margin ratio, positions, orders and fills, and the actions the account had the MPC signer sign.
import type { HlState } from './types.ts';

/** GET /api/hl/:account (services/api/src/hl-handlers.ts). */
export interface HlAnswer {
  account_id: string;
  owner: string;
  block_height: number;
  /** The final block's time: an order's expiry is built from it. */
  near_time_ms: number;
  hl: HlState | null;
  address: string | null;
  /** The account's pinned pb-gateway; secrets_ref is null as built (the seed comes through author_secrets). */
  gateway: { project_id: string; version_key: string | null; secrets_ref?: unknown } | null;
  hyperliquid: HyperliquidView | null;
}

export interface HyperliquidView {
  clearinghouse_state: ClearinghouseState | null;
  spot_usdc: { total: string; hold: string } | null;
  abstraction: string | null;
  open_orders: OpenOrder[] | null;
  fills: Fill[] | null;
  agents: { name: string; address: string; validUntil: number | null }[] | null;
  errors: Record<string, string>;
}

/** Hyperliquid's clearinghouseState (info-endpoint/perpetuals), the parts shown. */
export interface ClearinghouseState {
  marginSummary: { accountValue: string; totalNtlPos: string; totalMarginUsed: string };
  crossMarginSummary: { accountValue: string; totalNtlPos: string; totalMarginUsed: string };
  crossMaintenanceMarginUsed: string;
  withdrawable: string;
  assetPositions: {
    position: {
      coin: string;
      szi: string;
      entryPx: string;
      positionValue: string;
      unrealizedPnl: string;
      liquidationPx: string | null;
      leverage: { type: string; value: number };
      marginUsed: string;
    };
  }[];
}

/** frontendOpenOrders. */
export interface OpenOrder {
  coin: string;
  side: 'B' | 'A';
  limitPx: string;
  sz: string;
  origSz: string;
  oid: number;
  timestamp: number;
  reduceOnly: boolean;
  orderType: string;
  tif: string | null;
}

/** userFills, newest first. */
export interface Fill {
  coin: string;
  px: string;
  sz: string;
  side: 'B' | 'A';
  time: number;
  dir: string;
  closedPnl: string;
  fee: string;
  oid: number;
  tid: number;
  hash: string;
}

export interface Position {
  coin: string;
  size: number;
  side: 'long' | 'short';
  entryPx: string;
  value: number;
  pnl: number;
  liquidationPx: string | null;
  leverage: string;
}

export interface HlSummary {
  /** Perps account value (clearinghouseState). */
  perps: number | null;
  spotUsdc: number | null;
  mode: string | null;
  /** Whether this mode lets spot USDC back perps (research/hyperliquid.md, 7 Nov: a unified account keeps its USDC in spot). */
  spotCounts: boolean;
  /** What Hyperliquid's margin works from: perps, plus spot USDC in a unified or portfolio-margin account. */
  equity: number | null;
  maintenance: number | null;
  /** maintenance / equity, as Hyperliquid's margin ratio: liquidation at 100% (RISK_ENGINE.md 4.3). */
  marginRatioBp: number | null;
  positions: Position[];
  /** A note when USDC sits in spot and the mode leaves unclear whether it counts (INTERFACES.md 9). */
  note: string | null;
}

const num = (text: string | null | undefined): number | null => {
  if (text === null || text === undefined) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};

export function hlSummary(view: HyperliquidView): HlSummary {
  const state = view.clearinghouse_state;
  const perps = num(state?.crossMarginSummary.accountValue);
  const spotUsdc = num(view.spot_usdc?.total);
  const mode = view.abstraction;
  const spotCounts = mode === 'unifiedAccount' || mode === 'portfolioMargin';
  const equity = perps === null ? null : perps + (spotCounts ? (spotUsdc ?? 0) : 0);
  const maintenance = num(state?.crossMaintenanceMarginUsed);
  let marginRatioBp: number | null = null;
  if (equity !== null && maintenance !== null) marginRatioBp = equity > 0 ? Math.round((maintenance / equity) * 10_000) : maintenance > 0 ? null : 0;
  const positions = (state?.assetPositions ?? [])
    .map(({ position: p }) => {
      const size = Number(p.szi);
      return {
        coin: p.coin,
        size: Math.abs(size),
        side: size < 0 ? ('short' as const) : ('long' as const),
        entryPx: p.entryPx,
        value: Number(p.positionValue),
        pnl: Number(p.unrealizedPnl),
        liquidationPx: p.liquidationPx,
        leverage: `${p.leverage.value}x ${p.leverage.type}`,
      };
    })
    .filter((p) => p.size > 0);
  let note: string | null = null;
  if (!spotCounts && (spotUsdc ?? 0) > 0) {
    note =
      mode === 'disabled'
        ? 'This account keeps spot and perps apart: its spot USDC is not margin for perps.'
        : `USDC sits in spot and the account's mode is "${mode ?? 'unknown'}". Whether Hyperliquid counts it as margin in this mode is still being checked (INTERFACES.md 9), so the equity here leaves it out.`;
  }
  return { perps, spotUsdc, mode, spotCounts, equity, maintenance, marginRatioBp, positions, note };
}

/** Has Hyperliquid listed the gateway's agent for this address (extraAgents)? Null while it can't be told. */
export function agentApproved(answer: HlAnswer): { approved: boolean | null; validUntil: number | null } {
  const agent = answer.hl?.agent?.address?.toLowerCase();
  const agents = answer.hyperliquid?.agents;
  if (!agent || !agents) return { approved: agent ? null : false, validUntil: null };
  const found = agents.find((a) => a.address.toLowerCase() === agent);
  return { approved: Boolean(found), validUntil: found?.validUntil ?? null };
}

/** Has the address any USDC on Hyperliquid yet? Hyperliquid opens an address on its first deposit. */
export function hlFunded(view: HyperliquidView | null): boolean {
  if (!view) return false;
  return (num(view.clearinghouse_state?.crossMarginSummary.accountValue) ?? 0) > 0 || (num(view.spot_usdc?.total) ?? 0) > 0;
}

export type SetupStep = 'init' | 'fund' | 'agent' | 'approve' | 'ready';

/** Where the account is in INTERFACES.md 12's setup: address, first deposit, agent, approval. */
export function setupStep(answer: HlAnswer): SetupStep {
  if (!answer.address) return 'init';
  if (!hlFunded(answer.hyperliquid)) return 'fund';
  if (!answer.hl?.agent) return 'agent';
  return agentApproved(answer).approved ? 'ready' : 'approve';
}

/** The highest index in hl.signed, or -1 before the first. */
export function lastSignedIndex(hl: HlState | null | undefined): number {
  return (hl?.signed ?? []).reduce((max, e) => Math.max(max, e.index), -1);
}

/** The newest signed entry of a kind made after `afterIndex`, if any. */
export function newSignedEntry(hl: HlState | null | undefined, kind: string, afterIndex: number) {
  return (hl?.signed ?? []).filter((e) => e.kind === kind && e.index > afterIndex).sort((a, b) => b.index - a.index)[0] ?? null;
}

/**
 * The index in the account's hl_signed event (INTERFACES.md 8): an NEP-297 log
 * EVENT_JSON:{"standard":"pb-pool","version":"1.0.0","event":"hl_signed","data":[{"account","index","kind","nonce"}]}.
 */
export function signedIndexFromLogs(logs: string[], kind: string): number | null {
  for (const line of logs) {
    if (!line.startsWith('EVENT_JSON:')) continue;
    try {
      const event = JSON.parse(line.slice('EVENT_JSON:'.length)) as { event?: string; data?: unknown };
      if (event.event !== 'hl_signed') continue;
      const entries = Array.isArray(event.data) ? event.data : [event.data];
      const hit = entries.find((d) => d && typeof d === 'object' && (d as { kind?: string }).kind === kind) as { index?: unknown } | undefined;
      if (hit && typeof hit.index === 'number') return hit.index;
    } catch {
      // not our event
    }
  }
  return null;
}

/** POST /api/hl/submit's answer: Hyperliquid's reply to the posted action. */
export interface SubmitAnswer {
  account: string;
  index: number;
  kind: string;
  nonce: number;
  ok: boolean;
  http_status: number;
  hl: unknown;
}

export function submitWords(answer: SubmitAnswer): string {
  if (answer.ok) return answer.kind === 'approveAgent' ? 'Hyperliquid accepted the approval.' : 'Hyperliquid accepted the transfer.';
  const reply = answer.hl as { response?: unknown } | string | null;
  const why = typeof reply === 'string' ? reply : typeof reply?.response === 'string' ? reply.response : JSON.stringify(reply);
  return `Hyperliquid refused it: ${why}`;
}

/**
 * INTERFACES.md 8, "The send window": once the account signs a sendAsset, borrowing (and a withdrawal while a loan is
 * open) waits until `send_open_until_ms`, because the signed transfer can still be posted until then. Null when open.
 */
export function sendWindow(hl: HlState | null | undefined, nowMs: number): { untilMs: number } | null {
  const until = Number(hl?.send_open_until_ms ?? 0);
  return Number.isFinite(until) && until > nowMs ? { untilMs: until } : null;
}

/**
 * INTERFACES.md 50.2: an account made after the fix lists its open transfers (`open_sends`), and its pause lifts with
 * the check that finds them sent. An account that doesn't show the list keeps the rule of before, for its whole pause.
 */
export const liftsEarly = (hl: HlState | null | undefined): boolean => hl != null && hl.open_sends !== undefined;

/**
 * Does a page hold back the check that precedes a loan? Only for an account of before, while its pause is on. For an
 * account that lifts early the check goes ahead: it is the check that lifts the pause.
 */
export const holdsLoan = (hl: HlState | null | undefined, nowMs: number): boolean => sendWindow(hl, nowMs) !== null && !liftsEarly(hl);

/** The actions the pause refuses on the account: a loan from our pool, or one through `fund`. */
export const isLoan = (use: object): boolean => 'borrow' in use || 'fund' in use;

/**
 * What the pause banner says. `wait`: an account of before, paused until the time, with the way to a new account.
 * `check`: an account that lifts early, with "Check now". Null while borrowing is open.
 */
export function pauseBanner(hl: HlState | null | undefined, nowMs: number): { kind: 'wait' | 'check'; untilMs: number } | null {
  const paused = sendWindow(hl, nowMs);
  return paused ? { kind: liftsEarly(hl) ? 'check' : 'wait', untilMs: paused.untilMs } : null;
}

/** The banner's sentence for an account of before, after "Borrowing paused until <time>." */
export const PAUSE_WAIT_WORDS = 'The account signed a transfer of USDC out of Hyperliquid that can still be posted until then, so a check now could count money that is about to leave.';
/** And what to do about it (INTERFACES.md 50.1 point 5). */
export const NEW_ACCOUNT_WORDS = 'A new account can borrow today.';
/** The banner for an account that lifts early (INTERFACES.md 50.2). */
export const PAUSE_CHECK_WORDS = 'Your transfer out of Hyperliquid went through. The next check confirms it, and borrowing opens again.';

/**
 * After a check's result has landed on an account that lifts early: the pause read again. Still on, the account would
 * refuse the loan, so the wallet isn't opened, and the page says this. Null when borrowing is open, and for an account
 * of before (its pages hold the check back instead).
 */
export function stillPausedWords(hl: HlState | null | undefined, nowMs: number, when: (ms: number) => string = (ms) => new Date(ms).toLocaleString()): string | null {
  if (!liftsEarly(hl)) return null;
  const paused = sendWindow(hl, nowMs);
  if (!paused) return null;
  return `The last check didn’t find your transfer out of Hyperliquid in its history yet. Check again in a minute. If the transfer was never sent, borrowing opens again on ${when(paused.untilMs)}.`;
}

/** Is a loan open, as the account counts it? `loan.open` where the contract has it; else what is still owed. */
export function loanOpen(loan: { principal: string; open?: boolean } | undefined): boolean {
  if (!loan) return false;
  return loan.open ?? loan.principal !== '0';
}

/** Side and direction in words: "B" is a buy, "A" a sell. */
export const sideWords = (side: 'B' | 'A') => (side === 'B' ? 'buy' : 'sell');
