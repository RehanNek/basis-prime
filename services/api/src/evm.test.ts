import assert from "node:assert/strict";
import { test } from "node:test";

import { callWithAddress, EvmError, EvmRpc, isEvmAddress, words } from "./evm.js";
import { fakeFetch } from "./fakes.js";

const USDC = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
const PROVIDER = "0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b";
const hex = (...values: bigint[]) => `0x${values.map((v) => v.toString(16).padStart(64, "0")).join("")}`;

test("call data for f(address) is the selector and the address left-padded to 32 bytes; a result is read as whole 32-byte words", () => {
  assert.equal(callWithAddress("0x35ea6a75", USDC), "0x35ea6a75000000000000000000000000ba50cd2a20f6da35d788639e581bca8d0b5d4d5f");
  assert.throws(() => callWithAddress("0x35ea6a75", "0x1234"), /not a 0x address/);
  assert.throws(() => callWithAddress("35ea6a75", USDC), /not a 4-byte selector/);
  assert.deepEqual([isEvmAddress(USDC), isEvmAddress(USDC.slice(2)), isEvmAddress("alice.testnet"), isEvmAddress(undefined)], [true, false, false, false]);
  assert.deepEqual(words(hex(1n, 2n), 2, "x"), [1n, 2n]);
  assert.deepEqual(words(hex((1n << 256n) - 1n), 1, "x"), [(1n << 256n) - 1n], "the largest uint256 survives");
  assert.throws(() => words("0x1234", 1, "getReserveData(USDC)"), /getReserveData\(USDC\) answered something that isn't whole 32-byte words/);
  assert.throws(() => words(hex(1n), 12, "getReserveData(USDC)"), (e: unknown) => e instanceof EvmError && /answered 1 words where 12 were expected/.test(e.message));
});

test("the Ethereum reader sends one batch, eth_chainId first and every call at the latest block, and matches the replies by id", async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: [{ jsonrpc: "2.0", id: 2, result: hex(7n) }, { jsonrpc: "2.0", id: 0, result: "0x14a34" }, { jsonrpc: "2.0", id: 1, result: hex(5n) }] });
  const rpc = new EvmRpc({ url: "https://sepolia.base.org", fetch: impl });
  const answer = await rpc.calls([{ to: PROVIDER, data: callWithAddress("0x35ea6a75", USDC) }, { to: PROVIDER, data: callWithAddress("0x6fb07f96", USDC) }]);
  assert.deepEqual(answer, { chainId: 84_532, results: [hex(5n), hex(7n)] });
  assert.deepEqual([calls.length, calls[0]!.url, calls[0]!.method], [1, "https://sepolia.base.org", "POST"]);
  const sent = calls[0]!.body as { id: number; method: string; params: unknown[] }[];
  assert.deepEqual(sent.map((s) => [s.id, s.method]), [[0, "eth_chainId"], [1, "eth_call"], [2, "eth_call"]]);
  assert.deepEqual(sent[1]!.params, [{ to: PROVIDER, data: `0x35ea6a75${"0".repeat(24)}ba50cd2a20f6da35d788639e581bca8d0b5d4d5f` }, "latest"]);
});

test("the Ethereum reader says what failed, naming the RPC by its host only: a URL can carry a key", async () => {
  const call = [{ to: PROVIDER, data: "0x35ea6a75" }];
  const reverted = new EvmRpc({ url: "https://rpc.example/v2/secret-key", fetch: fakeFetch({ status: 200, body: [{ id: 0, result: "0x14a34" }, { id: 1, error: { code: 3, message: "execution reverted" } }] }).impl });
  await assert.rejects(reverted.calls(call), (e: unknown) => e instanceof EvmError && /failed on rpc\.example: execution reverted/.test(e.message) && !e.message.includes("secret-key"));
  const limited = new EvmRpc({ url: "https://sepolia.base.org", fetch: fakeFetch({ status: 429, body: "slow down" }).impl });
  await assert.rejects(limited.calls([]), /sepolia\.base\.org\) answered HTTP 429/);
  const single = new EvmRpc({ url: "https://sepolia.base.org", fetch: fakeFetch({ status: 200, body: { error: { message: "batch too large" } } }).impl });
  await assert.rejects(single.calls([]), /refused the batch: batch too large/);
  const short = new EvmRpc({ url: "https://sepolia.base.org", fetch: fakeFetch({ status: 200, body: [{ id: 0, result: "0x14a34" }] }).impl });
  await assert.rejects(short.calls(call), /left eth_call to 0xBc9f.* out of its answer/);
  const notJson = new EvmRpc({ url: "https://sepolia.base.org", fetch: fakeFetch({ status: 200, body: "<html>" }).impl });
  await assert.rejects(notJson.calls([]), /answered something that isn't JSON/);
  const unreachable = new EvmRpc({ url: "https://sepolia.base.org", fetch: (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as typeof fetch });
  await assert.rejects(unreachable.calls([]), /sepolia\.base\.org\) didn't answer: getaddrinfo ENOTFOUND/);
  const noChain = new EvmRpc({ url: "https://sepolia.base.org", fetch: fakeFetch({ status: 200, body: [{ id: 0, result: "0x" }] }).impl });
  await assert.rejects(noChain.calls([]), /eth_chainId on sepolia\.base\.org answered nothing/);
});
