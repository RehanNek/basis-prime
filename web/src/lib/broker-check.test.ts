// Checks the broker pays for (INTERFACES.md 49.4): what the page does with POST /api/check's answer.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BROKER_CHECK_WORDS, brokerCheckOutcome, refusalWords } from './broker-check.ts';
import { NO_ANSWER_WORDS } from './outlayer.ts';

test('an accepted check goes on to the action, with the block the engine read', () => {
  assert.deepEqual(brokerCheckOutcome({ ok: true, answer: { accepted: true, blk: 277_520_281, tries: 2, tx: '9xQp' } }), { kind: 'accepted', blk: 277_520_281, tx: '9xQp' });
  assert.deepEqual(brokerCheckOutcome({ ok: true, answer: { accepted: true } }), { kind: 'accepted', blk: null, tx: null });
  assert.equal(BROKER_CHECK_WORDS, 'The risk engine is checking your account. This usually takes under a minute.');
});

test('the fallback rule: 404, 503, or any refusal to run it uses the wallet’s own check, as before', () => {
  // A backend from before the route.
  assert.equal(brokerCheckOutcome({ ok: false, status: 404, code: 'not_found', message: 'Not found' }).kind, 'fallback');
  // The keeper isn't running, or couldn't ask (services/api/src/check.ts: `keeper_off`, `keeper_failed`).
  assert.equal(brokerCheckOutcome({ ok: false, status: 503, code: 'keeper_off', message: 'The keeper isn’t running' }).kind, 'fallback');
  assert.equal(brokerCheckOutcome({ ok: false, status: 503, code: 'keeper_failed', message: 'The keeper couldn’t ask for this check' }).kind, 'fallback');
  // A refusal that isn't the engine's own: not signed in, not the owner, too many in a minute.
  assert.equal(brokerCheckOutcome({ ok: false, status: 401, code: 'sign_in', message: 'Sign in' }).kind, 'fallback');
  assert.equal(brokerCheckOutcome({ ok: false, status: 403, code: 'not_yours', message: 'This account belongs to another wallet' }).kind, 'fallback');
  assert.deepEqual(brokerCheckOutcome({ ok: false, status: 429, code: 'too_many', message: 'Too many checks this minute' }), { kind: 'fallback', why: 'Too many checks this minute' });
  // An answer with neither a yes nor a reason is no answer.
  assert.equal(brokerCheckOutcome({ ok: true, answer: {} }).kind, 'fallback');
  assert.equal(brokerCheckOutcome({ ok: true, answer: null }).kind, 'fallback');
});

test('a check the keeper asked for that stored no result is said in plain words: the wallet isn’t asked to pay for the same answer', () => {
  // Three tries, and OutLayer brought nothing each time (the keeper's own words, services/keeper/src/loop.ts).
  assert.deepEqual(brokerCheckOutcome({ ok: true, answer: { accepted: false, reason: ' OutLayer returned no verdict ', tries: 3, tx: '9xQp' } }), {
    kind: 'refused',
    // INTERFACES.md 51.15: the words name OutLayer and say that nothing was signed or moved.
    why: NO_ANSWER_WORDS,
    detail: 'OutLayer returned no verdict',
  });
  assert.equal(refusalWords('a check for this account is already on its way: wait for it'), 'A check of your account is already running, so nothing was sent. Wait a minute, then try again.');
  // Anything else: the words say what to do, and the reason itself is kept for the detail line.
  assert.deepEqual(brokerCheckOutcome({ ok: true, answer: { accepted: false, reason: 'the account is frozen', tries: 1 } }), {
    kind: 'refused',
    why: 'The check didn’t go through, so nothing was sent. Try again in a minute; the details say why.',
    detail: 'the account is frozen',
  });
  // No sentence a client reads names a verdict, a nonce or a counter. Since 14 Nov the one about OutLayer does name
  // OutLayer (INTERFACES.md 51.15: the user wants it said who is being waited on); the others still don't.
  for (const reason of ['OutLayer returned no verdict', 'OutLayer’s call failed', 'a check for this account is already on its way: wait for it', 'the account is frozen']) {
    assert.doesNotMatch(refusalWords(reason), /verdict|nonce|counter/i);
  }
  assert.match(refusalWords('OutLayer’s call failed'), /^OutLayer didn’t answer in time/);
  for (const reason of ['a check for this account is already on its way: wait for it', 'the account is frozen']) assert.doesNotMatch(refusalWords(reason), /OutLayer/i);
});

test('a request cut off before its answer keeps waiting: the check may still land', () => {
  assert.deepEqual(brokerCheckOutcome({ ok: false, status: 0, code: 'offline', message: 'The page could not reach its server.' }), { kind: 'waiting' });
  assert.deepEqual(brokerCheckOutcome({ ok: false, status: 504, code: 'check_slow', message: 'The check is taking longer than usual. Its result may still arrive' }), { kind: 'waiting' });
  // The keeper's own answer for a check whose end it didn't see.
  assert.deepEqual(brokerCheckOutcome({ ok: true, answer: { accepted: false, reason: 'the check didn’t come back in time, and its result may still arrive: timed out', tries: 1, tx: null } }), { kind: 'waiting' });
});
