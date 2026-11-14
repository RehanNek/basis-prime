import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";

import { base58Decode, base64Bytes, ed25519PublicKey, NEP413_TAG, nep413Hash, verifyNep413 } from "./nep413.js";

/**
 * Made with near-api-js 7.4.0's own NEP-413 signer (KeyPairSigner.signNep413Message), from a throwaway key whose
 * seed is the bytes 1..32. The message is INTERFACES.md 9's example order; the nonce is the bytes 255..224.
 */
const VECTOR = {
  public_key: "ed25519:9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj",
  signature: "5qPzxHwjjuSdu1l6eXIfCfQ3vEbm1BXEjit6LDrJrn1lNV9kOwpXyB6z5jyd459/lXqfkymf9GHKXue016U9Cg==",
  nonce: "//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=",
  message:
    '{"pb":"order","account":"alice.pbf.testnet","order":{"coin":"BTC","is_buy":false,"sz":"0.33","limit_px":"74500","reduce_only":false,"tif":"Ioc"},"expires_ms":1794000060000}',
};

const decoded = () => ({
  key: ed25519PublicKey(VECTOR.public_key)!,
  signature: base64Bytes(VECTOR.signature, 64)!,
  nonce: base64Bytes(VECTOR.nonce, 32)!,
});

test("a signature made by near-api-js's NEP-413 signer verifies, for recipient pb-gateway", () => {
  const { key, signature, nonce } = decoded();
  assert.equal(key.length, 32);
  assert.deepEqual([...nonce.slice(0, 3)], [255, 254, 253]);
  assert.equal(verifyNep413(key, signature, { message: VECTOR.message, nonce, recipient: "pb-gateway" }), true);
});

test("changing anything signed breaks it: the message, the nonce, the recipient, a callback URL, the key", () => {
  const { key, signature, nonce } = decoded();
  const payload = { message: VECTOR.message, nonce, recipient: "pb-gateway" };
  assert.equal(verifyNep413(key, signature, { ...payload, message: VECTOR.message.replace('"0.33"', '"0.34"') }), false);
  const otherNonce = Uint8Array.from(nonce);
  otherNonce[0] = 0;
  assert.equal(verifyNep413(key, signature, { ...payload, nonce: otherNonce }), false);
  assert.equal(verifyNep413(key, signature, { ...payload, recipient: "pb-gateway2" }), false);
  assert.equal(verifyNep413(key, signature, { ...payload, callbackUrl: "https://x.example" }), false);
  const otherKey = Uint8Array.from(key);
  otherKey[31] ^= 1;
  assert.equal(verifyNep413(otherKey, signature, payload), false);
  assert.equal(verifyNep413(key, signature.slice(0, 63), payload), false, "a short signature is refused, not thrown");
});

test("the signed bytes: sha256 of the tag 2^31 + 413, then borsh of message, nonce, recipient and no callback", () => {
  assert.equal(NEP413_TAG, 2 ** 31 + 413);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const payload = { message: "héllo", nonce: new Uint8Array(32).fill(7), recipient: "pb-gateway" };
  const signature = sign(null, nep413Hash(payload), privateKey);
  assert.equal(verifyNep413(raw, signature, payload), true);
  assert.throws(() => nep413Hash({ ...payload, nonce: new Uint8Array(31) }), /exactly 32 bytes/);
});

test("keys, signatures and nonces are decoded strictly", () => {
  assert.deepEqual([...base58Decode("1112")], [0, 0, 0, 1], "leading 1s are zero bytes");
  assert.equal(ed25519PublicKey("ed25519:0OIl"), null, "0, O, I and l aren't base58");
  assert.equal(ed25519PublicKey("secp256k1:9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj"), null);
  assert.equal(ed25519PublicKey("ed25519:11111111111111111111111111111111111"), null, "35 zero bytes is not a 32-byte key");
  assert.equal(base64Bytes(VECTOR.signature, 32), null, "the wrong length");
  assert.equal(base64Bytes(VECTOR.signature.replace(/=+$/, ""), 64), null, "padding is required");
  assert.equal(base64Bytes("a b", 2), null);
});
