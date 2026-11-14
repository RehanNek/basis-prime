// Checks the broker pays for (INTERFACES.md 49.4). `request_check` may be called by anyone, so the page no longer has
// the client's wallet send it: it posts POST /api/check, the keeper sends the check with its own 0.01 NEAR and asks
// again, up to three times, when OutLayer returns nothing. The client's wallet then opens once, for the action.
// This file is the rule for what the page does with the backend's answer: go on, say why not, wait, or fall back to
// the check from the client's own wallet, as before.

/** What POST /api/check answers (INTERFACES.md 49.3): accepted with the block it read, or the refusal's reason. */
export interface CheckAnswer {
  accepted?: boolean;
  blk?: number | null;
  tries?: number | null;
  tx?: string | null;
  reason?: string | null;
}

export type BrokerCheck =
  /** The keeper's check was accepted: the account now holds its result, and the action can go to the wallet. */
  | { kind: 'accepted'; blk: number | null; tx: string | null }
  /**
   * The keeper asked and no result was stored: it already asked again, so a check from the wallet would only cost the
   * client for the same answer. `why` says it in plain words with what to do next; `detail` is the keeper's own reason.
   */
  | { kind: 'refused'; why: string; detail: string }
  /** The broker can't run it now: the page uses the wallet's own check, as before. */
  | { kind: 'fallback'; why: string }
  /** The request was cut off before an answer came: the check may still be running, so the page keeps watching the account. */
  | { kind: 'waiting' };

/** The one line shown while the broker's check runs. The keeper's retries don't show. */
export const BROKER_CHECK_WORDS = 'The risk engine is checking your account. This usually takes under a minute.';

/** Said when the page falls back, so the wallet's extra approval isn't a surprise. */
export const WALLET_CHECK_WORDS = 'The broker’s check isn’t available right now, so your wallet pays for this one: at most 0.01 NEAR.';

/** A request that never got its answer: the proxy gave up waiting, or the connection dropped. */
const CUT_OFF = [0, 502, 504];

/**
 * The keeper's reason for a check that stored no result (services/keeper/src/loop.ts, `clientCheck`), in plain words
 * with what to do next. Its own words go in a detail line.
 */
export function refusalWords(reason: string): string {
  if (/already on its way/i.test(reason)) return 'A check of your account is already running, so nothing was sent. Wait a minute, then try again.';
  if (/OutLayer/i.test(reason)) return 'The risk engine gave no answer this time, so nothing was sent. Try again: it usually answers on the next try.';
  return 'The check didn’t go through, so nothing was sent. Try again in a minute; the details say why.';
}

/**
 * What to do with the backend's answer to POST /api/check (services/api/src/check.ts).
 * - `accepted: true`: the account stored the result. Go on: the page reads it from the account, and what the engine
 *   allowed or refused is said from there.
 * - `accepted: false` with a reason: the keeper asked (up to three times when nothing came back) and no result was
 *   stored. The page says so and doesn't spend the client's NEAR on the same answer. One reason is different: "its
 *   result may still arrive" keeps waiting.
 * - 404 (privacy off, or a backend without the route), 503 (the keeper isn't running), or any other refusal to run it
 *   (not signed in, not the owner, too many in a minute): fall back to the wallet's check.
 * - Cut off with no answer (504 `check_slow`, 502, or no connection): wait, the check may still land.
 */
export function brokerCheckOutcome(result: { ok: true; answer: CheckAnswer | null | undefined } | { ok: false; status: number; code?: string; message: string }): BrokerCheck {
  if (result.ok) {
    const answer = result.answer;
    if (answer?.accepted === true) return { kind: 'accepted', blk: typeof answer.blk === 'number' ? answer.blk : null, tx: typeof answer.tx === 'string' ? answer.tx : null };
    if (answer && answer.accepted === false && typeof answer.reason === 'string' && answer.reason.trim()) {
      const detail = answer.reason.trim();
      if (/may still arrive/i.test(detail)) return { kind: 'waiting' };
      return { kind: 'refused', why: refusalWords(detail), detail };
    }
    return { kind: 'fallback', why: 'The broker’s check gave no clear answer.' };
  }
  if (CUT_OFF.includes(result.status)) return { kind: 'waiting' };
  return { kind: 'fallback', why: result.message };
}

/** Under a broker's check that didn't go through: the way to the wallet's own check, by hand. */
export const USE_WALLET_LABEL = 'Use my wallet for the check (at most 0.01 NEAR)';
