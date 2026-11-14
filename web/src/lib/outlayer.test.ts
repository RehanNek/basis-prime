// What the app says about OutLayer (INTERFACES.md 51.15): the banner, the waiting line and the words of a wait that ran out.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bannerWords, duration, isBusy, NAME_AFTER_S, NO_ANSWER_WORDS, OUTLAYER_IS, OUTLAYER_PATH, PREVIEW_SKIPPED_WORDS, stillWaitingWords, type OutlayerHealth } from './outlayer.ts';

const NOW = 1_794_680_000_000;
const health = (over: Partial<OutlayerHealth> = {}): OutlayerHealth => ({ state: 'ok', window_s: 900, runs: 3, unanswered: 0, last_seconds: 13, last_answered: true, last_answer_ms: NOW - 20_000, waiting_s: null, read_at_ms: NOW, ...over });

test('a length of time in words', () => {
  assert.equal(duration(0), '0 s');
  assert.equal(duration(45.9), '45 s');
  assert.equal(duration(60), '1 min');
  assert.equal(duration(137), '2 min 17 s');
  assert.equal(duration(301), '5 min 1 s');
  assert.equal(duration(-4), '0 s');
});

test('no banner while OutLayer answers well, or when nothing is known', () => {
  assert.equal(OUTLAYER_PATH, '/api/outlayer');
  assert.equal(bannerWords(health(), NOW), null);
  assert.equal(bannerWords(health({ state: 'unknown', runs: 0, last_seconds: null, last_answered: null }), NOW), null);
  assert.equal(bannerWords(null, NOW), null);
  assert.equal(bannerWords(undefined, NOW), null);
  assert.deepEqual([isBusy(health()), isBusy(health({ state: 'slow' })), isBusy(health({ state: 'down' })), isBusy(health({ state: 'unknown' })), isBusy(undefined)], [false, true, true, false, false]);
});

test('slow: the banner names OutLayer, gives the figure, and says nothing is lost', () => {
  // 14 Nov, 17:25 UTC on the hosted site: the last run took 137 seconds.
  const slow = bannerWords(health({ state: 'slow', last_seconds: 137 }), NOW)!;
  assert.equal(slow.tone, 'warn');
  assert.equal(slow.headline, 'OutLayer’s testnet is answering slowly right now.');
  assert.equal(slow.detail, 'The last risk check took 2 min 17 s; it normally takes 5 to 20 seconds.');
  assert.equal(slow.body, `${OUTLAYER_IS} Borrowing, Hyperliquid orders and some moves wait on it. Nothing is lost while it is slow: a step that runs out of time can be started again.`);
  // A check still waiting is the fresher news.
  assert.equal(bannerWords(health({ state: 'slow', waiting_s: 95 }), NOW)!.detail, 'A risk check has been waiting 1 min 35 s; it normally takes 5 to 20 seconds.');
  // The latest got no answer, though one before it did.
  assert.equal(bannerWords(health({ state: 'slow', last_seconds: 301, last_answered: false, unanswered: 1 }), NOW)!.detail, 'The last risk check got no answer after 5 min 1 s.');
  assert.equal(bannerWords(health({ state: 'slow', last_seconds: null, last_answered: null }), NOW)!.detail, 'Risk checks are taking longer than their usual 5 to 20 seconds.');
});

test('down: the last checks got no answer, and for how long none has', () => {
  const down = bannerWords(health({ state: 'down', runs: 3, unanswered: 3, last_seconds: 301, last_answered: false, last_answer_ms: NOW - 22 * 60_000 }), NOW)!;
  assert.equal(down.tone, 'bad');
  assert.equal(down.headline, 'OutLayer’s testnet is not answering right now.');
  assert.equal(down.detail, 'The last risk check got no answer after 5 min 1 s, and none has been answered for 22 min.');
  // Nothing was ever answered since the backend started.
  assert.equal(bannerWords(health({ state: 'down', last_seconds: 270, last_answered: false, last_answer_ms: null }), NOW)!.detail, 'The last risk check got no answer after 4 min 30 s.');
});

test('a waiting line names OutLayer once the wait passes a minute, and a wait that ran out says nothing moved', () => {
  assert.equal(NAME_AFTER_S, 60);
  assert.equal(stillWaitingWords(20), null);
  assert.equal(stillWaitingWords(60), null);
  assert.equal(
    stillWaitingWords(100),
    'Still waiting for OutLayer: 1 min 40 s. OutLayer is the outside service that runs the risk check, and its testnet is slow right now. Nothing has been signed yet, and you don’t need to do anything.',
  );
  assert.match(NO_ANSWER_WORDS, /^OutLayer didn’t answer in time, so nothing was signed or moved\./);
  assert.match(NO_ANSWER_WORDS, /not your wallet or this app/);
  assert.match(NO_ANSWER_WORDS, /Try again/);
  assert.match(PREVIEW_SKIPPED_WORDS, /OutLayer is slow right now/);
  // Plain words: no contract or protocol terms.
  for (const words of [NO_ANSWER_WORDS, OUTLAYER_IS, stillWaitingWords(100)!, PREVIEW_SKIPPED_WORDS]) assert.doesNotMatch(words, /verdict|yield|TEE|enclave|callback|nonce/i);
});
