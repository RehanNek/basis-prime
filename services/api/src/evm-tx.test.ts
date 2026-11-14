import assert from "node:assert/strict";
import { test } from "node:test";

import { addressOfKey, bigBytes, CALLS, callData, decodeSignedTx, EvmTxError, keyBytes, POOL_CALLS, rlpDecode, rlpEncode, selectorOf, signTx, TOKEN_CALLS, txHash, type Type2Tx } from "./evm-tx.js";

const hex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`;
const bytes = (text: string) => Uint8Array.from(Buffer.from(text.replace(/^0x/, ""), "hex"));

/** Hardhat's first test account: a key every Ethereum developer knows, with its address, from Hardhat's own docs. */
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

/**
 * A transaction Base Sepolia really mined: the gas wallet's `approve(pool, max)` on WETH, from the live try of 11 Nov
 * (research/data/aave_spike_weth.json, step "approve WETH"). The fields are eth_getTransactionByHash's, read on 11 Nov.
 */
const MINED = {
  tx: {
    chainId: 84_532n,
    nonce: 4n,
    maxPriorityFeePerGas: 0xf4240n,
    maxFeePerGas: 0x3b9aca00n,
    gasLimit: 0x111c9n,
    to: "0x4200000000000000000000000000000000000006",
    value: 0n,
    data: "0x095ea7b30000000000000000000000008bab6d1b75f19e9ed9fce8b9bd338844ff79ae27ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  } satisfies Type2Tx,
  yParity: 0n,
  r: 0x36261f3cc07367f7574f7b54ad17a314ab20f5b667d6ada3631ac5741c162137n,
  s: 0x4b16bda1bf4738f935f800e233ac6cb35b42e0d77fb6099a7766f3fb9d80073cn,
  hash: "0x0e2cf3dceedd2056511fd28405dc5977e306aa9089be0954238fdef4765fd77d",
  from: "0x2031181d63507368232579af4c64a1c3428407ff",
};

/** The raw bytes of a signed type 2 transaction, from its fields. */
function rawOf(tx: Type2Tx, yParity: bigint, r: bigint, s: bigint): string {
  const body = rlpEncode([bigBytes(tx.chainId), bigBytes(tx.nonce), bigBytes(tx.maxPriorityFeePerGas), bigBytes(tx.maxFeePerGas), bigBytes(tx.gasLimit), bytes(tx.to), bigBytes(tx.value), bytes(tx.data), [], bigBytes(yParity), bigBytes(r), bigBytes(s)]);
  return hex(Uint8Array.of(2, ...body));
}

test("every selector is the first four bytes of keccak256 of its signature", () => {
  for (const [name, call] of Object.entries(CALLS)) assert.equal(selectorOf(call.signature), call.selector, name);
  // The four of Aave's Pool and the two of a token that an account's transaction may carry (FUNDING.md 4.5).
  assert.deepEqual(POOL_CALLS, ["0x617ba037", "0xa415bcad", "0x573ade81", "0x69328dec"]);
  assert.deepEqual(TOKEN_CALLS, ["0x095ea7b3", "0xa9059cbb"]);
  assert.equal(CALLS.mint.selector, "0xc6c3bbe6");
  assert.equal(CALLS.deposit.selector, "0xd0e30db0");
});

test("RLP: Ethereum's own examples, and a decoder that takes only the one way each value is written", () => {
  // From the RLP page of ethereum.org: "dog", the list ["cat", "dog"], the empty string, the empty list, 15, 1024.
  assert.equal(hex(rlpEncode(Uint8Array.from(Buffer.from("dog")))), "0x83646f67");
  assert.equal(hex(rlpEncode([Uint8Array.from(Buffer.from("cat")), Uint8Array.from(Buffer.from("dog"))])), "0xc88363617483646f67");
  assert.equal(hex(rlpEncode(new Uint8Array(0))), "0x80");
  assert.equal(hex(rlpEncode([])), "0xc0");
  assert.equal(hex(rlpEncode(bigBytes(15n))), "0x0f");
  assert.equal(hex(rlpEncode(bigBytes(1024n))), "0x820400");
  assert.equal(hex(rlpEncode(bigBytes(0n))), "0x80", "zero is the empty string");
  const long = new Uint8Array(60).fill(7);
  assert.equal(hex(rlpEncode(long)).slice(0, 6), "0xb83c", "55 bytes or more: the length's own length first");

  const nested = [bigBytes(84_532n), [], [long, bigBytes(1n)], new Uint8Array(0)];
  assert.deepEqual(rlpDecode(rlpEncode(nested)), nested);
  for (const bad of ["0x8100", "0xb80100", "0x83646f", "0xc883636174", "0x0f0f", "0xb90000"]) assert.throws(() => rlpDecode(bytes(bad)), EvmTxError, bad);
});

test("a transaction Base Sepolia mined reads back to its real hash and its real sender", () => {
  const raw = rawOf(MINED.tx, MINED.yParity, MINED.r, MINED.s);
  assert.equal(txHash(raw), MINED.hash, "keccak256 of the raw bytes is the hash the chain knows it by");
  const read = decodeSignedTx(raw);
  assert.deepEqual({ ...read }, { ...MINED.tx, yParity: 0, r: MINED.r, s: MINED.s, hash: MINED.hash, from: MINED.from });
  assert.equal(read.data.slice(0, 10), CALLS.approve.selector);
});

test("the gas wallet's signature: the address of a key, a transaction signed with it, and the same transaction read back", () => {
  const key = keyBytes(TEST_KEY, "EVM_GAS_PRIVATE_KEY");
  assert.equal(addressOfKey(key), TEST_ADDRESS);
  const tx: Type2Tx = { chainId: 84_532n, nonce: 0n, maxPriorityFeePerGas: 1_000_000n, maxFeePerGas: 11_000_000n, gasLimit: 21_000n, to: "0x1111111111111111111111111111111111111111", value: 2_000_000_000_000_000n, data: "0x" };
  const signed = signTx(tx, key);
  assert.match(signed.raw, /^0x02f8/);
  assert.equal(signed.hash, txHash(signed.raw));
  const read = decodeSignedTx(signed.raw);
  assert.equal(read.from, TEST_ADDRESS, "the signature leads back to the key's address");
  assert.deepEqual({ chainId: read.chainId, nonce: read.nonce, to: read.to, value: read.value, data: read.data, gasLimit: read.gasLimit }, { chainId: 84_532n, nonce: 0n, to: tx.to, value: tx.value, data: "0x", gasLimit: 21_000n });
  assert.deepEqual(signTx(tx, key), signed, "the same transaction signs the same way every time (RFC 6979)");
  // Another nonce is another transaction, and a changed byte is another signer.
  assert.notEqual(signTx({ ...tx, nonce: 1n }, key).hash, signed.hash);
  const changed = rawOf({ ...tx, value: tx.value + 1n }, BigInt(read.yParity), read.r, read.s);
  assert.notEqual(decodeSignedTx(changed).from, TEST_ADDRESS);
});

test("anything that isn't one of our signed type 2 transactions is refused in words", () => {
  const raw = rawOf(MINED.tx, MINED.yParity, MINED.r, MINED.s);
  const refused = (text: string, why: RegExp) => assert.throws(() => decodeSignedTx(text), (e: unknown) => e instanceof EvmTxError && why.test(e.message), text.slice(0, 20));
  refused("not hex", /isn't 0x hex/);
  refused(`0x01${raw.slice(4)}`, /isn't Ethereum's type 2/);
  refused(raw.slice(0, -2), /ends in the middle|bytes left over|written the way/);
  refused(`${raw}00`, /bytes left over/);
  const fields = (extra: Partial<Type2Tx> = {}, y = MINED.yParity, r = MINED.r, s = MINED.s) => rawOf({ ...MINED.tx, ...extra }, y, r, s);
  refused(fields({}, 2n), /signature isn't one Ethereum accepts/);
  refused(fields({}, 0n, MINED.r, 0n), /signature isn't one Ethereum accepts/);
  // The other half of the curve's order: Ethereum refuses a high s (EIP-2).
  refused(fields({}, 1n, MINED.r, 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n - MINED.s), /signature isn't one Ethereum accepts/);
  // No receiver would create a contract; a list of eleven fields is a legacy shape.
  const noTo = rlpEncode([bigBytes(84_532n), bigBytes(4n), bigBytes(1n), bigBytes(1n), bigBytes(1n), new Uint8Array(0), bigBytes(0n), new Uint8Array(0), [], bigBytes(0n), bigBytes(MINED.r), bigBytes(MINED.s)]);
  refused(hex(Uint8Array.of(2, ...noTo)), /no receiver/);
  const withAccess = rlpEncode([bigBytes(84_532n), bigBytes(4n), bigBytes(1n), bigBytes(1n), bigBytes(1n), bytes(MINED.tx.to), bigBytes(0n), new Uint8Array(0), [[bytes(MINED.tx.to), []]], bigBytes(0n), bigBytes(MINED.r), bigBytes(MINED.s)]);
  refused(hex(Uint8Array.of(2, ...withAccess)), /access list/);
  refused(hex(Uint8Array.of(2, ...rlpEncode([bigBytes(1n), bigBytes(2n)]))), /12 fields/);
});

test("call data is the selector and 32-byte words; a key that isn't 32 bytes of hex is refused without repeating it", () => {
  assert.equal(
    callData(CALLS.mint.selector, ["0x54114591963CF60EF3aA63bEfD6eC263D98145a4", TEST_ADDRESS, 1_500_000n]),
    `0xc6c3bbe6${"0".repeat(24)}54114591963cf60ef3aa63befd6ec263d98145a4${"0".repeat(24)}${TEST_ADDRESS.slice(2)}${(1_500_000).toString(16).padStart(64, "0")}`,
  );
  assert.equal(callData(CALLS.deposit.selector, []), "0xd0e30db0");
  assert.throws(() => callData("0xC6C3BBE6", []), /not a 4-byte selector/);
  assert.throws(() => callData(CALLS.transfer.selector, ["0x1234", 1n]), /not a 0x address/);
  assert.throws(() => callData(CALLS.transfer.selector, [TEST_ADDRESS, -1n]), /doesn't fit 32 bytes/);
  assert.equal(hex(keyBytes(` ${TEST_KEY.slice(2)} `, "EVM_GAS_PRIVATE_KEY")), TEST_KEY);
  assert.throws(() => keyBytes("0xabc123", "EVM_GAS_PRIVATE_KEY"), (e: unknown) => e instanceof EvmTxError && e.message === "EVM_GAS_PRIVATE_KEY isn't a 32-byte key in hex (64 hex digits)" && !e.message.includes("abc123"));
});
