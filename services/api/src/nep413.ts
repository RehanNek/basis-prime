// NEP-413 signed messages (https://github.com/near/NEPs/blob/master/neps/nep-0413.md), as the wallet signs them
// for an order (INTERFACES.md 9, "Auth"). The backend checks the signature itself before paying for a gateway
// run, so a forged or garbled request costs nothing. The gateway still checks everything, and is the authority:
// the backend can only refuse what the gateway would refuse too.
//
// What is signed: sha256(borsh(u32 2^31 + 413) || borsh({message: string, nonce: [u8; 32], recipient: string,
// callbackUrl: Option<string>})), with ed25519. Borsh writes a u32 little-endian, a string as its u32 byte length
// then its UTF-8 bytes, a fixed array as its bytes, and None as one 0 byte. This is near-api-js 7.4.0's
// serializeMessage (lib/index.js, "src/nep413/schema.ts"), which nep413.test.ts checks against.
import { createHash, createPublicKey, verify } from "node:crypto";

/** 2^31 + 413: the tag that keeps a NEP-413 message from ever being a valid transaction. */
export const NEP413_TAG = 2_147_484_061;

export interface Nep413Payload {
  message: string;
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string | null;
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function borshString(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  return Buffer.concat([u32(bytes.length), bytes]);
}

/** The 32 bytes the wallet signs. */
export function nep413Hash(payload: Nep413Payload): Buffer {
  if (payload.nonce.length !== 32) throw new Error("A NEP-413 nonce is exactly 32 bytes");
  const callback = payload.callbackUrl == null ? Buffer.of(0) : Buffer.concat([Buffer.of(1), borshString(payload.callbackUrl)]);
  const body = Buffer.concat([u32(NEP413_TAG), borshString(payload.message), Buffer.from(payload.nonce), borshString(payload.recipient), callback]);
  return createHash("sha256").update(body).digest();
}

/** An ed25519 public key's DER prefix (SubjectPublicKeyInfo, OID 1.3.101.112), so node:crypto can load the raw 32 bytes. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Checks an ed25519 signature over the NEP-413 hash. `publicKey` is the 32 raw bytes. */
export function verifyNep413(publicKey: Uint8Array, signature: Uint8Array, payload: Nep413Payload): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]), format: "der", type: "spki" });
  try {
    return verify(null, nep413Hash(payload), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin's alphabet, as NEAR keys use) to bytes. Throws on a character outside it. */
export function base58Decode(text: string): Uint8Array {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new Error("not base58");
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0); // each leading "1" is a leading zero byte
  }
  return Uint8Array.from(bytes);
}

/** "ed25519:<base58>" to the 32 raw key bytes, or null if it isn't one. */
export function ed25519PublicKey(text: string): Uint8Array | null {
  const match = /^ed25519:([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(text);
  if (!match) return null;
  try {
    const bytes = base58Decode(match[1]!);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

/** Standard base64 (with padding) to bytes, or null if it isn't exactly `length` bytes of canonical base64. */
export function base64Bytes(text: string, length: number): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const bytes = Buffer.from(text, "base64");
  if (bytes.length !== length || bytes.toString("base64") !== text) return null;
  return new Uint8Array(bytes);
}
