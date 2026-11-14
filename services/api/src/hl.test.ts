import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeFetch } from "./fakes.js";
import { HlError, HlHttp, TtlCache } from "./hl.js";
import { NearRpc } from "./rpc.js";

test("info posts {type, user} as JSON to <api>/info and parses the answer", async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: '"default"' }); // a JSON string, as Hyperliquid sends it
  const hl = new HlHttp({ apiUrl: "https://api.hyperliquid-testnet.xyz/", fetch: impl });
  assert.equal(await hl.info({ type: "userAbstraction", user: "0xabc" }), "default");
  assert.equal(calls[0]!.url, "https://api.hyperliquid-testnet.xyz/info");
  assert.equal(calls[0]!.method, "POST");
  assert.deepEqual(calls[0]!.body, { type: "userAbstraction", user: "0xabc" });
  assert.equal(calls[0]!.headers["Content-Type"], "application/json");
});

test("info: an HTTP error or a fetch that throws is an HlError; exchange passes Hyperliquid's answer on as it came", async () => {
  const { impl } = fakeFetch(
    { status: 429, body: "rate limited" },
    { status: 200, body: { status: "err", response: "Must deposit before performing actions" } },
    { status: 422, body: "Failed to deserialize the JSON body" },
  );
  const hl = new HlHttp({ apiUrl: "https://api.hyperliquid-testnet.xyz", fetch: impl });
  await assert.rejects(hl.info({ type: "clearinghouseState", user: "0x1" }), (error: unknown) => {
    assert.ok(error instanceof HlError);
    assert.match(error.message, /clearinghouseState answered HTTP 429: rate limited/);
    return true;
  });
  assert.deepEqual(await hl.exchange({ action: {} }), { status: 200, body: { status: "err", response: "Must deposit before performing actions" } });
  assert.deepEqual(await hl.exchange({ action: {} }), { status: 422, body: "Failed to deserialize the JSON body" });

  const failing = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(new HlHttp({ apiUrl: "https://api.hyperliquid-testnet.xyz", fetch: failing }).info({ type: "x" }), (error: unknown) => {
    assert.ok(error instanceof HlError && error.status === 504);
    assert.match(error.message, /api\.hyperliquid-testnet\.xyz\) did not answer: fetch failed/);
    return true;
  });
});

test("the cache shares a read under way, keeps it for its time, and forgets a failure", async () => {
  let now = 0;
  const cache = new TtlCache(() => now);
  let reads = 0;
  const read = async () => ++reads;
  const [a, b] = await Promise.all([cache.get("k", 1_000, read), cache.get("k", 1_000, read)]);
  assert.deepEqual([a, b, reads], [1, 1, 1]);
  now = 999;
  assert.equal(await cache.get("k", 1_000, read), 1);
  now = 1_000;
  assert.equal(await cache.get("k", 1_000, read), 2);

  await assert.rejects(cache.get("bad", 1_000, async () => Promise.reject(new Error("no"))));
  assert.equal(await cache.get("bad", 1_000, async () => "yes"), "yes", "a failed read isn't kept");
});

test("the final block: its height and its time in ms", async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { result: { header: { height: 276621165, timestamp_nanosec: "1794127876747123456" } } } });
  assert.deepEqual(await new NearRpc({ url: "https://rpc.example", fetch: impl }).finalBlock(), { height: 276621165, timeMs: 1794127876747 });
  assert.deepEqual(calls[0]!.body, { jsonrpc: "2.0", id: "pb-api", method: "block", params: { finality: "final" } });
});
