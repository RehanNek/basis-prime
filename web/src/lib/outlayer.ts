// How OutLayer is answering, and what the app says about it (INTERFACES.md 51.15).
//
// The user, 14 Nov, after a loan's check sat for nine minutes with "usually 5 to 20 seconds" on the screen: "its for
// sure gonna be stuck when judges are judging ... tell me if we can display something where we say that outlayer is
// not responding so they know its not our fault, its outlayer". Until then the app's waiting lines said "the risk
// engine" and "a sealed computer" and never the name. Now they name OutLayer once a wait passes a minute, a banner
// on every page says when its testnet is slow or silent, and a wait that runs out says plainly that nothing was
// signed or moved.
//
// The figures come from GET /api/outlayer: the backend times the runs it makes anyway and asks for none of its own.
// Nothing here reads the clock, the network or the browser.

export type OutlayerState = 'ok' | 'slow' | 'down' | 'unknown';

/** GET /api/outlayer (services/api/src/outlayer-health.ts). */
export interface OutlayerHealth {
  state: OutlayerState;
  window_s: number;
  runs: number;
  unanswered: number;
  last_seconds: number | null;
  last_answered: boolean | null;
  last_answer_ms: number | null;
  waiting_s: number | null;
  read_at_ms: number;
}

export const OUTLAYER_PATH = '/api/outlayer';

/** A wait under this is not remarked on. */
export const NAME_AFTER_S = 60;

/** "45 s", "2 min 17 s", "5 min". Whole seconds, never negative. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  const rest = s % 60;
  return rest === 0 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 60)} min ${rest} s`;
}

/** What OutLayer is, in one sentence, for a reader who has never heard of it. */
export const OUTLAYER_IS = 'OutLayer is the outside service that runs this app’s risk checks in a sealed computer.';

/** Said when a wait runs out with no answer. Nothing was signed for the action, so nothing moved. */
export const NO_ANSWER_WORDS =
  'OutLayer didn’t answer in time, so nothing was signed or moved. OutLayer is the outside service that runs the risk check, and its testnet is slow in spells: this is not your wallet or this app. Try again; it often answers on the next try.';

/** Is OutLayer slow or silent now? Then the app asks it for nothing it can do without (previews, the borrow figure). */
export function isBusy(health: OutlayerHealth | null | undefined): boolean {
  return health?.state === 'slow' || health?.state === 'down';
}

/**
 * The line under a check that has waited more than a minute: it names what is being waited on and for how long.
 * Null before that: the page keeps its own "usually …" line.
 */
export function stillWaitingWords(waitedS: number): string | null {
  if (!(waitedS > NAME_AFTER_S)) return null;
  return `Still waiting for OutLayer: ${duration(waitedS)}. OutLayer is the outside service that runs the risk check, and its testnet is slow right now. Nothing has been signed yet, and you don’t need to do anything.`;
}

export interface Banner {
  tone: 'warn' | 'bad';
  headline: string;
  /** What the backend saw, with the figure. */
  detail: string;
  /** What OutLayer is and what the reader can do. */
  body: string;
}

/** The banner on every page while OutLayer is slow or silent. Null when it answers well, or when nothing is known. */
export function bannerWords(health: OutlayerHealth | null | undefined, nowMs: number): Banner | null {
  if (!health || !isBusy(health)) return null;
  const body = `${OUTLAYER_IS} Borrowing, Hyperliquid orders and some moves wait on it. Nothing is lost while it is slow: a step that runs out of time can be started again.`;
  if (health.state === 'down') {
    const after = health.last_seconds !== null ? ` after ${duration(health.last_seconds)}` : '';
    const since = health.last_answer_ms !== null && nowMs > health.last_answer_ms ? `, and none has been answered for ${duration((nowMs - health.last_answer_ms) / 1000)}` : '';
    return { tone: 'bad', headline: 'OutLayer’s testnet is not answering right now.', detail: `The last risk check got no answer${after}${since}.`, body };
  }
  let detail: string;
  if (health.waiting_s !== null && health.waiting_s > NAME_AFTER_S) detail = `A risk check has been waiting ${duration(health.waiting_s)}; it normally takes 5 to 20 seconds.`;
  else if (health.last_answered === false && health.last_seconds !== null) detail = `The last risk check got no answer after ${duration(health.last_seconds)}.`;
  else if (health.last_seconds !== null) detail = `The last risk check took ${duration(health.last_seconds)}; it normally takes 5 to 20 seconds.`;
  else detail = 'Risk checks are taking longer than their usual 5 to 20 seconds.';
  return { tone: 'warn', headline: 'OutLayer’s testnet is answering slowly right now.', detail, body };
}

/** Said in place of a preview the page didn't ask for while OutLayer is slow. */
export const PREVIEW_SKIPPED_WORDS = 'OutLayer is slow right now, so the page isn’t asking it for a preview. The split shows after you press Borrow.';
