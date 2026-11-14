// Privacy level 1 (INTERFACES.md 48): the sign-in message, the token's store, the token on every backend call, and
// what a page shows. Runs with: pnpm --filter @pb/web test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { api, ApiError } from './api.ts';
import { toAuth } from './gateway.ts';
import { pickerLine, pickerWords } from './picker.ts';
import {
  CONNECT_WORDS,
  currentToken,
  dropCurrentSession,
  dropSession,
  onSessionDropped,
  privacyOf,
  readSession,
  saveSession,
  SESSION_RECIPIENT,
  SESSION_STORAGE_KEY,
  sessionMessage,
  sessionState,
  setCurrentSession,
  SIGN_IN_WORDS,
  visitorView,
} from './session.ts';

const ALICE = 'alice.testnet';
const NOW = 1_794_600_000_000;
const HOUR = 3_600_000;
const FACTORY = 'pbf.testnet';

/** A stand-in for the browser's store. */
function store() {
  const kept = new Map<string, string>();
  return { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), kept };
}

/** A stand-in for fetch that answers one canned reply and keeps what it was sent. */
function fakeFetch(status: number, body: unknown) {
  const calls: { path: string; headers: Record<string, string> }[] = [];
  const impl = (async (path: string, init?: RequestInit) => {
    calls.push({ path, headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('the sign-in message is exactly three lines: the title, the wallet, and until when (INTERFACES.md 48.2)', () => {
  assert.equal(sessionMessage(ALICE, 1_794_600_600_000), 'Sign in to Prime Broker\nwallet: alice.testnet\nuntil: 1794600600000');
  // A whole number of milliseconds, and no line after the third.
  assert.equal(sessionMessage(ALICE, 1_794_600_600_000.7).split('\n').length, 3);
  assert.equal(sessionMessage(ALICE, 1_794_600_600_000.7).endsWith('until: 1794600600000'), true);
  // The signed body is the shape orders use, with the session's recipient, so neither signature passes as the other.
  assert.equal(SESSION_RECIPIENT, 'pb-app-session');
  const signed = { accountId: ALICE, publicKey: 'ed25519:9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj', signature: '5qPzxHwjjuSdu1l6eXIfCfQ3vEbm1BXEjit6LDrJrn1lNV9kOwpXyB6z5jyd459/lXqfkymf9GHKXue016U9Cg==' };
  assert.equal(toAuth(signed, 'm', new Uint8Array(32), SESSION_RECIPIENT).recipient, 'pb-app-session');
  assert.equal(toAuth(signed, 'm', new Uint8Array(32)).recipient, 'pb-gateway');
});

test('a wallet’s token is stored per wallet with its expiry, and dropped once it has expired', () => {
  const s = store();
  saveSession(s, ALICE, { token: 'v1.a.b', expires_at_ms: NOW + 12 * HOUR });
  saveSession(s, 'bob.testnet', { token: 'v1.c.d', expires_at_ms: NOW + HOUR });
  assert.deepEqual(JSON.parse(s.kept.get(SESSION_STORAGE_KEY)!), { 'alice.testnet': { token: 'v1.a.b', expires_at_ms: NOW + 12 * HOUR }, 'bob.testnet': { token: 'v1.c.d', expires_at_ms: NOW + HOUR } });
  assert.equal(readSession(s, ALICE, NOW)?.token, 'v1.a.b');
  // Two hours on, Bob's has run out: it reads as none, and it is gone from the store. Alice's stays.
  assert.equal(readSession(s, 'bob.testnet', NOW + 2 * HOUR), null);
  assert.deepEqual(Object.keys(JSON.parse(s.kept.get(SESSION_STORAGE_KEY)!)), ['alice.testnet']);
  // Signing the wallet out drops its token.
  dropSession(s, ALICE);
  assert.equal(readSession(s, ALICE, NOW), null);
  // A store that holds something else reads as no token, and never throws.
  s.kept.set(SESSION_STORAGE_KEY, 'not json');
  assert.equal(readSession(s, ALICE, NOW), null);
});

test('every backend call sends the token, and none when there is none or it has expired', async () => {
  setCurrentSession(ALICE, { token: 'v1.a.b', expires_at_ms: Date.now() + HOUR });
  const withToken = fakeFetch(200, { ok: true });
  await api('/api/account/a.pbf.testnet', undefined, withToken.impl);
  assert.equal(withToken.calls[0]!.headers.Authorization, 'Bearer v1.a.b');
  assert.equal(withToken.calls[0]!.headers['Content-Type'], 'application/json');
  // A token past its expiry isn't sent.
  setCurrentSession(ALICE, { token: 'v1.old.x', expires_at_ms: Date.now() - 1 });
  assert.equal(currentToken(), null);
  const expired = fakeFetch(200, { ok: true });
  await api('/api/pool', undefined, expired.impl);
  assert.equal('Authorization' in expired.calls[0]!.headers, false);
  setCurrentSession(null, null);
});

test('a 401 “sign_in” drops the token from memory and from the store, and tells the page', async () => {
  const s = store();
  const session = { token: 'v1.a.b', expires_at_ms: Date.now() + HOUR };
  saveSession(s, ALICE, session);
  setCurrentSession(ALICE, session);
  let told = 0;
  const stop = onSessionDropped(() => (told += 1));
  // lib/api.ts drops it on the backend's 401 with the code `sign_in`.
  const refused = fakeFetch(401, { error: 'sign_in', message: 'Sign in with the wallet that owns this account' });
  await assert.rejects(api('/api/account/a.pbf.testnet', undefined, refused.impl), (e: unknown) => e instanceof ApiError && e.status === 401 && e.code === 'sign_in');
  assert.equal(currentToken(), null);
  assert.equal(told, 1);
  // The same drop, with the browser's store in hand, clears the stored token too.
  setCurrentSession(ALICE, session);
  dropCurrentSession(s);
  assert.equal(readSession(s, ALICE, Date.now()), null);
  assert.equal(told, 2);
  // Another refusal leaves the token alone: a 403 for someone else's account is not a bad token.
  setCurrentSession(ALICE, session);
  const notYours = fakeFetch(403, { error: 'not_yours', message: 'This account belongs to another wallet' });
  await assert.rejects(api('/api/account/b.pbf.testnet', undefined, notYours.impl));
  assert.equal(currentToken(), 'v1.a.b');
  stop();
  setCurrentSession(null, null);
});

test('the app’s state: privacy off, no wallet, a wallet that must confirm, or ready', () => {
  assert.equal(sessionState({ mode: 'owner', wallet: '', hasToken: false }), 'no_wallet');
  assert.equal(sessionState({ mode: 'owner', wallet: ALICE, hasToken: false }), 'needs_sign_in');
  assert.equal(sessionState({ mode: 'owner', wallet: ALICE, hasToken: true }), 'ready');
  assert.deepEqual(privacyOf({ privacy: { mode: 'owner', open_accounts: ['demo.pbf.testnet', 7, ''] } }), { mode: 'owner', openAccounts: ['demo.pbf.testnet'] });
  assert.equal(SIGN_IN_WORDS, 'Confirm this wallet is yours: one free signature, no transaction.');
});

test('Risk and Activity with no wallet say to connect, and list the open accounts as links when there are any', () => {
  const open = ['fund-rhea-11131011.pbf.testnet', 'fund-move-11131031.pbf.testnet'];
  assert.equal(CONNECT_WORDS, 'Connect your wallet to see your account.');
  // With open accounts: each is a link by its name, and none is opened until one is asked for.
  assert.deepEqual(visitorView({ mode: 'owner', openAccounts: open, asked: null, factory: FACTORY }), {
    kind: 'connect',
    links: [
      { account: 'fund-rhea-11131011.pbf.testnet', name: 'fund-rhea-11131011' },
      { account: 'fund-move-11131031.pbf.testnet', name: 'fund-move-11131031' },
    ],
    open: null,
  });
  // ?account=<an open account> still opens it, by its name or its whole id.
  assert.equal(visitorView({ mode: 'owner', openAccounts: open, asked: 'fund-rhea-11131011', factory: FACTORY }).kind, 'connect');
  assert.equal((visitorView({ mode: 'owner', openAccounts: open, asked: 'fund-rhea-11131011', factory: FACTORY }) as { open: string | null }).open, 'fund-rhea-11131011.pbf.testnet');
  assert.equal((visitorView({ mode: 'owner', openAccounts: open, asked: 'fund-move-11131031.pbf.testnet', factory: FACTORY }) as { open: string | null }).open, 'fund-move-11131031.pbf.testnet');
  // Any other name opens nothing: there is no free-text way in.
  assert.equal((visitorView({ mode: 'owner', openAccounts: open, asked: 'alice', factory: FACTORY }) as { open: string | null }).open, null);
  // With no open account, only the sentence shows: no links, nothing opened.
  assert.deepEqual(visitorView({ mode: 'owner', openAccounts: [], asked: 'alice', factory: FACTORY }), { kind: 'connect', links: [], open: null });
});

test('privacy off, or a backend that doesn’t say, is as before: no card, no token, the owner named, the name field', async () => {
  // A backend from before this sends no `privacy`.
  assert.deepEqual(privacyOf({}), { mode: 'off', openAccounts: [] });
  assert.deepEqual(privacyOf(null), { mode: 'off', openAccounts: [] });
  assert.deepEqual(privacyOf({ privacy: { mode: 'off', open_accounts: [] } }), { mode: 'off', openAccounts: [] });
  // No card, with or without a wallet or a token.
  assert.equal(sessionState({ mode: 'off', wallet: ALICE, hasToken: false }), 'off');
  assert.equal(sessionState({ mode: 'off', wallet: '', hasToken: false }), 'off');
  // No token is sent.
  setCurrentSession(null, null);
  const plain = fakeFetch(200, { ok: true });
  await api('/api/account/a.pbf.testnet', undefined, plain.impl);
  assert.deepEqual(plain.calls[0]!.headers, { 'Content-Type': 'application/json' });
  // The picker names another wallet's account by its owner, in the words it had.
  const line = pickerLine({ answer: { account_id: 'bob.pbf.testnet', exists: true, state: { owner: 'bob.testnet' } }, owner: ALICE, mode: 'off' });
  assert.equal(pickerWords(line), 'bob.pbf.testnet belongs to bob.testnet, not you: you can look and ask for checks, but only the owner can borrow, repay or withdraw.');
  // Risk and Activity keep their name field for a visitor, filled from ?account=.
  assert.deepEqual(visitorView({ mode: 'off', openAccounts: [], asked: 'alice.pbf.testnet', factory: FACTORY }), { kind: 'free_text', name: 'alice' });
  assert.deepEqual(visitorView({ mode: 'off', openAccounts: [], asked: null, factory: FACTORY }), { kind: 'free_text', name: '' });
});
