// The order message the wallet signs, the Auth beside it, and the gateway's answers in words (INTERFACES.md 9).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cancelMessage, cancelWords, EXPIRY_MS, expiresAt, hlStatuses, leverageWords, normalizePublicKey, normalizeSignature, orderMessage, orderWords, randomNonce, toAuth, toBase64 } from './gateway.ts';

const ALICE = 'alice.pbf.testnet';
const ORDER = { coin: 'BTC', is_buy: false, sz: '0.33', limit_px: '74500', reduce_only: false, tif: 'Ioc' as const };

test("the order message is INTERFACES.md 9's compact JSON, keys in its order, the order only inside it", () => {
  assert.equal(
    orderMessage(ALICE, ORDER, 1794000060000),
    '{"pb":"order","account":"alice.pbf.testnet","order":{"coin":"BTC","is_buy":false,"sz":"0.33","limit_px":"74500","reduce_only":false,"tif":"Ioc"},"expires_ms":1794000060000}',
  );
  const shuffled = { tif: 'Ioc' as const, reduce_only: false, limit_px: '74500', sz: '0.33', is_buy: false, coin: 'BTC' };
  assert.equal(orderMessage(ALICE, shuffled, 1), orderMessage(ALICE, ORDER, 1), 'the key order does not depend on the caller');
  assert.equal(cancelMessage(ALICE, { coin: 'BTC', oid: 123 }, 1794000060000), '{"pb":"cancel","account":"alice.pbf.testnet","cancel":{"coin":"BTC","oid":123},"expires_ms":1794000060000}');
});

test('the expiry: NEAR time plus the time since it was read, plus 90 s, inside the gateway\'s 120 s', () => {
  assert.equal(expiresAt(1_000_000, 5_000, 8_000), 1_000_000 + 3_000 + EXPIRY_MS);
  assert.ok(EXPIRY_MS < 120_000);
  assert.equal(randomNonce().length, 32);
  assert.notDeepEqual(randomNonce(), randomNonce());
});

test("Meteor's answer becomes the Auth as it is; other wallets' encodings are converted", () => {
  const nonce = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
  const meteor = {
    accountId: 'alice.testnet',
    publicKey: 'ed25519:9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj',
    signature: '5qPzxHwjjuSdu1l6eXIfCfQ3vEbm1BXEjit6LDrJrn1lNV9kOwpXyB6z5jyd459/lXqfkymf9GHKXue016U9Cg==',
  };
  const message = orderMessage(ALICE, ORDER, 1794000060000);
  assert.deepEqual(toAuth(meteor, message, nonce), {
    owner: 'alice.testnet',
    public_key: meteor.publicKey,
    signature: meteor.signature,
    message,
    nonce: '//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=',
    recipient: 'pb-gateway',
  });

  const bytes = Uint8Array.from(atob(meteor.signature), (c) => c.charCodeAt(0));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(normalizeSignature(hex), meteor.signature);
  assert.equal(normalizeSignature(meteor.signature.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')), meteor.signature, 'url-safe, unpadded');
  const base58 = encodeBase58(bytes);
  assert.equal(normalizeSignature(base58), meteor.signature);
  assert.equal(normalizeSignature(`ed25519:${base58}`), meteor.signature);
  assert.throws(() => normalizeSignature('AAAA'), /isn't 64 bytes/);

  assert.equal(normalizePublicKey('9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj'), meteor.publicKey);
  assert.throws(() => normalizePublicKey('secp256k1:abc'), /isn't ed25519/);
  assert.equal(toBase64(new Uint8Array([0, 1, 2])), 'AAEC');
});

test("the gateway's answers in words: a fill, a partial fill, a resting order, and each kind of refusal", () => {
  const filled = orderWords({ ok: true, status: 'filled', oid: 1, filled_sz: '0.33', avg_px: '75012', sent: ORDER, after: { state: 'HEALTHY', eq: 34_499_000_000, im: 19_520_000_000, line: 24_150_000_000, hl_margin_ratio_bp: 447 } });
  assert.equal(filled.headline, 'Sell 0.33 BTC at 74500: filled 0.33 at an average 75012.');
  assert.match(filled.lines[0]!, /healthy, equity \$34,499\.00 against an initial requirement of \$19,520\.00, credit line \$24,150\.00, Hyperliquid margin ratio 4\.47%/);
  assert.match(orderWords({ ok: true, status: 'partial', filled_sz: '0.1', avg_px: '75000', sent: ORDER }).headline, /partly filled, 0\.1 at an average 75000; the rest was cancelled/);
  assert.match(orderWords({ ok: true, status: 'resting', oid: 99, sent: { ...ORDER, tif: 'Gtc' } }).headline, /resting on the book as order 99/);

  const p8 = orderWords({ ok: false, code: 'P8', reason: 'equity after 40,255 < IM 46,509' });
  assert.equal(p8.ok, false);
  assert.match(p8.headline, /^Refused by check P8\. After this order the loan would not be covered/);
  assert.deepEqual(p8.lines, ['The gateway says: equity after 40,255 < IM 46,509']);
  for (const code of ['P0', 'P1', 'P2', 'P3', 'P6', 'P7', 'P9', 'P10', 'AUTH', 'HL', 'INPUT']) {
    assert.doesNotMatch(orderWords({ ok: false, code }).headline, /\(\w+\)\.$/, `${code} has words`);
  }
  assert.equal(orderWords({ ok: false, code: 'X1' }).headline, 'Refused (X1).');
});

test("cancels and leverage in words, with Hyperliquid's own status for the cancel", () => {
  const ok = { ok: true, hl: { status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } } };
  assert.deepEqual(cancelWords(ok, 77), { ok: true, headline: 'Order 77 is cancelled.', lines: [] });
  const gone = { ok: true, hl: { status: 'ok', response: { type: 'cancel', data: { statuses: [{ error: 'Order was never placed, already canceled, or filled.' }] } } } };
  assert.equal(cancelWords(gone, 77).headline, "Hyperliquid didn't cancel order 77: Order was never placed, already canceled, or filled.");
  assert.deepEqual(hlStatuses({ response: { data: { statuses: [{ resting: { oid: 5 } }] } } }), ['{"resting":{"oid":5}}']);
  assert.equal(leverageWords({ ok: true, set: { BTC: 5, ETH: 3 } }).headline, 'Leverage set: BTC 5x, ETH 3x.');
});

function encodeBase58(bytes: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt(`0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`);
  let out = '';
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}
