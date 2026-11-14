// A signed order's life, and the wait around it (INTERFACES.md 50.4). An order or a cancel is signed to last as long
// as the account's own gateway takes: `order_life_ms` in GET /api/markets?account=<id> (230 s on testnet's new
// gateway, 110 s on an older one), and 110 s when the answer doesn't say (lib/gateway.ts, `orderLifeMs`). Nothing on
// the page gives up on the order, or calls it failed, before that life is over: this file is the waiting.
//   - After 30 seconds the page says one calm line, not an error, and its button stays busy.
//   - An answer that was cut off on its way (the proxy gave up, the connection dropped, or the backend stopped
//     waiting) is not the order's answer: the page waits out the rest of the life, then says it never came.

/** How long an order waits before the page says the calm line. */
export const CALM_AFTER_MS = 30_000;

/** The one calm line while an order waits longer than usual. */
// INTERFACES.md 51.15: it names OutLayer (the user, 14 Nov: "so they know its not our fault, its outlayer").
export const ORDER_WAIT_WORDS = 'The order is waiting its turn at OutLayer, which runs the risk checks in a secure enclave on NEAR. Its testnet can take a few minutes.';
const ORDER_WAIT_WORDS_MAINNET = 'The order is waiting its turn at OutLayer, which runs the risk checks in a secure enclave on NEAR. It can take a minute or two.';

/** The calm line, once the order has waited more than 30 seconds; before that, null: the page keeps its own words. */
export function orderWaitWords(waitedMs: number, network: 'testnet' | 'mainnet' = 'testnet'): string | null {
  if (!(waitedMs > CALM_AFTER_MS)) return null;
  return network === 'testnet' ? ORDER_WAIT_WORDS : ORDER_WAIT_WORDS_MAINNET;
}

/** A server that isn't there answers at once. One that was cut off while waiting for the order answers late. */
const CUT_OFF_AFTER_MS = 10_000;

/** Said once the order's life is over and its answer never came back. */
export const NO_ANSWER_WORDS = 'The order’s answer didn’t come back. It may still have reached Hyperliquid: look at your open orders and fills before you sign it again.';

/**
 * Was the answer cut off, rather than given? The page's own server stopped waiting (Next's proxy answers 500 with
 * no words of the backend's, which lib/api.ts reads as `backend_down`), the connection dropped (`offline`), a proxy
 * in between timed out (502 or 504 with no code of the backend's), or the backend stopped waiting for the run
 * (`outlayer_unknown`: the order may still be placed). Only after a real wait: an error that comes at once is the
 * error it says it is.
 */
export function answerCutOff(failure: unknown, waitedMs: number): boolean {
  if (!(waitedMs >= CUT_OFF_AFTER_MS)) return false;
  const { status, code } = (failure ?? {}) as { status?: unknown; code?: unknown };
  if (code === 'offline' || code === 'backend_down' || code === 'outlayer_unknown') return true;
  return (status === 502 || status === 504) && code === 'http_error';
}

/**
 * Posts a signed order (or cancel) and waits for its answer for as long as the order lives.
 * - `onCalm` is called once the wait passes 30 seconds, with the calm line to show.
 * - A cut-off answer before the life is over isn't a failure: the page waits out the rest of the life (the order may
 *   still be placed, and can't be posted twice), then throws with words that say the answer never came. The backend's
 *   own words for a run it stopped waiting for are kept.
 * - Every other answer or error comes back as it is.
 * `now`, `sleep` and `timer` are for tests.
 */
export async function sendWithinLife<T>(input: {
  send: () => Promise<T>;
  lifeMs: number;
  onCalm?: (words: string) => void;
  network?: 'testnet' | 'mainnet';
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  timer?: { set: (run: () => void, ms: number) => unknown; clear: (id: unknown) => void };
}): Promise<T> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timer = input.timer ?? { set: (run: () => void, ms: number) => setTimeout(run, ms), clear: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>) };
  const calm = () => input.onCalm?.(orderWaitWords(CALM_AFTER_MS + 1, input.network)!);
  const started = now();
  const pending = timer.set(calm, CALM_AFTER_MS);
  try {
    return await input.send();
  } catch (failure) {
    const waited = now() - started;
    if (!answerCutOff(failure, waited)) throw failure;
    if (waited < input.lifeMs) {
      calm();
      await sleep(input.lifeMs - waited);
    }
    const said = (failure as { code?: unknown; message?: unknown }) ?? {};
    throw new Error(said.code === 'outlayer_unknown' && typeof said.message === 'string' ? said.message : NO_ANSWER_WORDS);
  } finally {
    timer.clear(pending);
  }
}
