// A signed order's life and the wait around it (INTERFACES.md 50.4).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cancelMessage, EXPIRED_ORDER_WORDS, EXPIRY_MS, expiresAt, isExpired, LIFE_MAX_MS, orderLifeMs, orderMessage, orderWords, SIGN_AGAIN } from './gateway.ts';
import { answerCutOff, CALM_AFTER_MS, NO_ANSWER_WORDS, ORDER_WAIT_WORDS, orderWaitWords, sendWithinLife } from './order-life.ts';

const ALICE = 'alice.pbf.testnet';
const ORDER = { coin: 'BTC', is_buy: false, sz: '0.015', limit_px: '66000', reduce_only: false, tif: 'Ioc' as const };

test('the life an order is signed for comes from the markets answer for that account, and falls back to 110 s', () => {
  // The account's own gateway is the new one: 230 s, 10 s under its 240 s limit (the user's 4 minutes).
  assert.equal(orderLifeMs({ order_life_ms: 230_000 }), 230_000);
  assert.equal(LIFE_MAX_MS, 230_000);
  // An account that pins an older gateway.
  assert.equal(orderLifeMs({ order_life_ms: 110_000 }), 110_000);
  // A backend from before the field, an answer that hasn't come yet, or a value that can't be a life (longer than
  // any gateway of ours takes, not a whole number, not positive): 110 s.
  assert.equal(EXPIRY_MS, 110_000);
  for (const answer of [{}, null, undefined, { order_life_ms: '230000' }, { order_life_ms: 0 }, { order_life_ms: -5 }, { order_life_ms: 230_000.5 }, { order_life_ms: 230_001 }, { order_life_ms: 290_000 }, { order_life_ms: 86_400_000 }, { order_life_ms: Number.NaN }]) {
    assert.equal(orderLifeMs(answer), 110_000, JSON.stringify(answer));
  }
});

test('the expiry written into the message is now plus that life', () => {
  // NEAR's time as the backend read it, moved on by the 3 s since, plus the account's life.
  const expires = expiresAt(1_794_600_000_000, 5_000, 8_000, orderLifeMs({ order_life_ms: 230_000 }));
  assert.equal(expires, 1_794_600_000_000 + 3_000 + 230_000);
  assert.equal(orderMessage(ALICE, ORDER, expires).endsWith(`"expires_ms":${1_794_600_233_000}}`), true);
  assert.equal(cancelMessage(ALICE, { coin: 'BTC', oid: 7 }, expires).endsWith(`"expires_ms":${1_794_600_233_000}}`), true);
  // Without a life from the backend: 110 s, as before.
  assert.equal(expiresAt(1_794_600_000_000, 5_000, 8_000), 1_794_600_000_000 + 3_000 + 110_000);
  assert.equal(expiresAt(1_794_600_000_000, 5_000, 8_000, orderLifeMs(null)), 1_794_600_000_000 + 3_000 + 110_000);
});

test('an order that waits longer than 30 seconds gets one calm line, not an error; before that, none', () => {
  assert.equal(CALM_AFTER_MS, 30_000);
  assert.equal(orderWaitWords(0), null);
  assert.equal(orderWaitWords(30_000), null);
  assert.equal(orderWaitWords(30_001), 'The order is waiting its turn at OutLayer, which runs the risk checks in a secure enclave on NEAR. Its testnet can take a few minutes.');
  assert.equal(orderWaitWords(229_000), ORDER_WAIT_WORDS);
  // It is still calm, and since 14 Nov it names who is being waited on (INTERFACES.md 51.15).
  assert.doesNotMatch(ORDER_WAIT_WORDS, /fail|error|expired|verdict/i);
  assert.match(ORDER_WAIT_WORDS, /OutLayer/);
  assert.doesNotMatch(orderWaitWords(60_000, 'mainnet')!, /testnet/);
});

test('a message that did expire says so once, with “Sign again”', () => {
  const expired = { ok: false, code: 'AUTH', reason: 'the message has expired: sign it again' };
  assert.equal(isExpired(expired), true);
  assert.deepEqual(orderWords(expired), { ok: false, headline: EXPIRED_ORDER_WORDS, lines: [] });
  assert.match(EXPIRED_ORDER_WORDS, /Nothing was placed\./);
  assert.equal(SIGN_AGAIN, 'Sign again');
  // Another refusal by the same check keeps its own words.
  assert.equal(isExpired({ ok: false, code: 'AUTH', reason: 'the wrong signer' }), false);
  assert.match(orderWords({ ok: false, code: 'AUTH', reason: 'the wrong signer' }).headline, /^Refused by check AUTH/);
});

/** A clock the test moves, and a timer that records what was asked of it. */
function world() {
  const state = { t: 1_000_000, calm: [] as string[], slept: [] as number[], cleared: 0 };
  return {
    state,
    now: () => state.t,
    sleep: async (ms: number) => {
      state.slept.push(ms);
      state.t += ms;
    },
    timer: { set: () => 'timer', clear: () => void (state.cleared += 1) },
    onCalm: (words: string) => void state.calm.push(words),
  };
}

test('nothing gives up before the order’s life is over: a cut-off answer waits out the rest of it, with the calm line', async () => {
  const w = world();
  // The proxy stopped waiting after 210 s; the order was signed for 230 s.
  const cut = { status: 500, code: 'backend_down', message: 'The backend is not running' };
  await assert.rejects(
    sendWithinLife({ send: async () => { w.state.t += 210_000; throw cut; }, lifeMs: 230_000, onCalm: w.onCalm, now: w.now, sleep: w.sleep, timer: w.timer }),
    (error: Error) => error.message === NO_ANSWER_WORDS,
  );
  assert.deepEqual(w.state.slept, [20_000], 'the rest of the 230 s');
  assert.deepEqual(w.state.calm, [ORDER_WAIT_WORDS]);
  assert.equal(w.state.cleared, 1);

  // The same error at once is what it says: the server isn't there. Nothing waits.
  const w2 = world();
  await assert.rejects(sendWithinLife({ send: async () => { w2.state.t += 300; throw cut; }, lifeMs: 230_000, onCalm: w2.onCalm, now: w2.now, sleep: w2.sleep, timer: w2.timer }), (error) => error === cut);
  assert.deepEqual([w2.state.slept, w2.state.calm], [[], []]);

  // The backend stopped waiting for the run: its own words are kept, after the life is over.
  const w3 = world();
  const unknown = { status: 502, code: 'outlayer_unknown', message: 'OutLayer did not answer. The order may still have reached Hyperliquid: look at the open orders and fills before sending it again.' };
  await assert.rejects(
    sendWithinLife({ send: async () => { w3.state.t += 180_000; throw unknown; }, lifeMs: 230_000, onCalm: w3.onCalm, now: w3.now, sleep: w3.sleep, timer: w3.timer }),
    (error: Error) => error.message === unknown.message,
  );
  assert.deepEqual(w3.state.slept, [50_000]);
});

test('an answer, a refusal and an error of the backend’s own come back as they are', async () => {
  const w = world();
  const answer = { ok: true, status: 'filled' };
  assert.equal(await sendWithinLife({ send: async () => answer, lifeMs: 230_000, now: w.now, sleep: w.sleep, timer: w.timer }), answer);
  const refused = { status: 429, code: 'too_many_runs', message: 'Too many gateway runs this minute' };
  await assert.rejects(sendWithinLife({ send: async () => { w.state.t += 60_000; throw refused; }, lifeMs: 230_000, now: w.now, sleep: w.sleep, timer: w.timer }), (error) => error === refused);
  assert.deepEqual(w.state.slept, []);
  // What counts as cut off.
  assert.equal(answerCutOff({ status: 0, code: 'offline' }, 45_000), true);
  assert.equal(answerCutOff({ status: 504, code: 'http_error' }, 45_000), true);
  assert.equal(answerCutOff({ status: 502, code: 'outlayer_run' }, 45_000), false, 'the run ended, and the backend says how');
  assert.equal(answerCutOff({ status: 0, code: 'offline' }, 2_000), false);
  assert.equal(answerCutOff(new Error('Cancelled in the wallet'), 45_000), false);
});
