import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeFetch } from "./fakes.js";
import { NearRpc, NotDeployedError, RpcError, ViewError } from "./rpc.js";

const URL_WITH_KEY = "https://rpc.example/secret-key-123/";
const bytes = (value: unknown) => [...Buffer.from(JSON.stringify(value))];

test("view() sends call_function at the final block with base64 args, and decodes the JSON answer", async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { jsonrpc: "2.0", result: { result: bytes("1000000"), block_height: 276621165, logs: [] } } });
  const rpc = new NearRpc({ url: URL_WITH_KEY, fetch: impl });

  const { value, blockHeight } = await rpc.view<string>("musdc.pbf-ops.testnet", "ft_balance_of", { account_id: "a.testnet" });

  assert.equal(value, "1000000");
  assert.equal(blockHeight, 276621165);
  const params = (calls[0]?.body as { method: string; params: Record<string, string> });
  assert.equal(params.method, "query");
  assert.equal(params.params.request_type, "call_function");
  assert.equal(params.params.finality, "final");
  assert.equal(params.params.method_name, "ft_balance_of");
  assert.deepEqual(JSON.parse(Buffer.from(params.params.args_base64!, "base64").toString()), { account_id: "a.testnet" });
});

test("a contract that isn't live yet is NotDeployedError, in each of the three ways testnet says so", async () => {
  const { impl } = fakeFetch(
    // no account (a JSON-RPC error)
    { status: 200, body: { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, data: "account drill.pbf-ops.testnet does not exist while viewing" } } },
    // an account with no code (an error inside the result), as seen on pool.pbf.testnet on 7 Nov
    { status: 200, body: { result: { error: 'wasm execution failed with error: CompilationError(CodeDoesNotExist { account_id: "pool.pbf.testnet" })', logs: [] } } },
    // a contract without the method
    { status: 200, body: { result: { error: "wasm execution failed with error: MethodResolveError(MethodNotFound)", logs: [] } } },
    // newer nodes: no code as a JSON-RPC error
    { status: 200, body: { error: { name: "HANDLER_ERROR", cause: { name: "NO_CONTRACT_CODE" } } } },
  );
  const rpc = new NearRpc({ url: URL_WITH_KEY, fetch: impl });

  const reasons: string[] = [];
  for (const contract of ["drill.pbf-ops.testnet", "pool.pbf.testnet", "musdc.pbf-ops.testnet", "pbf.testnet"]) {
    await assert.rejects(rpc.view(contract, "get_state"), (error: unknown) => {
      assert.ok(error instanceof NotDeployedError);
      assert.equal(error.contract, contract);
      reasons.push(error.reason);
      return true;
    });
  }
  assert.deepEqual(reasons, ["no account", "no contract code", "its contract has no get_state method", "no contract code"]);
});

test("a panic is a ViewError with the panic message; an HTTP failure is an RpcError naming the host only", async () => {
  const panic = 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "Failed to deserialize input from JSON." })';
  const { impl } = fakeFetch({ status: 200, body: { result: { error: panic, logs: [] } } }, { status: 429, body: "slow down" });
  const rpc = new NearRpc({ url: URL_WITH_KEY, fetch: impl, retryDelaysMs: [] });

  await assert.rejects(rpc.view("musdc.pbf-ops.testnet", "ft_balance_of"), (error: unknown) => {
    assert.ok(error instanceof ViewError);
    assert.equal(error.message, "musdc.pbf-ops.testnet.ft_balance_of failed: Failed to deserialize input from JSON.");
    return true;
  });
  await assert.rejects(rpc.view("x.testnet", "m"), (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.equal(error.message, "NEAR RPC (rpc.example) answered HTTP 429");
    assert.ok(!error.message.includes("secret-key-123"));
    return true;
  });
});

test("a 429 or 503 is asked again after a pause, and the answer that follows is used", async () => {
  const answer = { status: 200, body: { result: { result: bytes("7"), block_height: 9, logs: [] } } };
  const { impl, calls } = fakeFetch({ status: 429, body: "slow down" }, { status: 503, body: "busy" }, answer);
  const pauses: number[] = [];
  const rpc = new NearRpc({ url: URL_WITH_KEY, fetch: impl, retryDelaysMs: [5, 10, 20], sleep: async (ms) => void pauses.push(ms) });

  assert.deepEqual(await rpc.view<string>("musdc.pbf-ops.testnet", "ft_balance_of"), { value: "7", blockHeight: 9 });
  assert.equal(calls.length, 3);
  assert.deepEqual(pauses, [5, 10]);
});

test("a 429 that keeps coming ends as an RpcError naming the status, after every retry", async () => {
  const { impl, calls } = fakeFetch({ status: 429, body: "" }, { status: 429, body: "" }, { status: 429, body: "" });
  const rpc = new NearRpc({ url: URL_WITH_KEY, fetch: impl, retryDelaysMs: [1, 1], sleep: async () => {} });

  await assert.rejects(rpc.view("x.testnet", "m"), (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.equal(error.message, "NEAR RPC (rpc.example) answered HTTP 429");
    return true;
  });
  assert.equal(calls.length, 3);
});

test("the same read asked again within a moment shares one RPC call; a failed read is not shared", async () => {
  const answer = (v: string) => ({ status: 200, body: { result: { result: bytes(v), block_height: 1, logs: [] } } });
  const { impl, calls } = fakeFetch(answer("a"), { status: 500, body: "" }, answer("b"), answer("c"));
  const rpc = new NearRpc({ url: URL_WITH_KEY, fetch: impl, cacheMs: 60_000, retryDelaysMs: [] });

  const [first, second] = await Promise.all([rpc.view<string>("t.testnet", "m", { k: 1 }), rpc.view<string>("t.testnet", "m", { k: 1 })]);
  assert.equal(first.value, "a");
  assert.equal(second.value, "a");
  assert.equal(calls.length, 1);
  // Other args are another read; a failure is forgotten, so the next try asks again.
  await assert.rejects(rpc.view("t.testnet", "m", { k: 2 }), RpcError);
  assert.equal((await rpc.view<string>("t.testnet", "m", { k: 2 })).value, "b");
  assert.equal(calls.length, 3);
});

test("a fetch that throws becomes an RpcError without the URL", async () => {
  const failing = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(new NearRpc({ url: URL_WITH_KEY, fetch: failing }).view("x.testnet", "m"), /NEAR RPC \(rpc\.example\) did not answer: fetch failed/);
});

test("account() tells a missing account, a wallet with no code and a contract apart", async () => {
  const { impl } = fakeFetch(
    { status: 200, body: { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } } },
    { status: 200, body: { result: { amount: "1", code_hash: "11111111111111111111111111111111", block_height: 7 } } },
    { status: 200, body: { result: { amount: "1", code_hash: "HFgoZ9sv4SU9AHsQEkyCTzdXczwmMvTsNvppWN2H4pH1", block_height: 8 } } },
  );
  const rpc = new NearRpc({ url: URL_WITH_KEY, fetch: impl });

  assert.deepEqual(await rpc.account("nobody.testnet"), { exists: false, hasCode: false, blockHeight: 0 });
  assert.deepEqual(await rpc.account("pbf.testnet"), { exists: true, hasCode: false, blockHeight: 7 });
  assert.deepEqual(await rpc.account("musdc.pbf-ops.testnet"), { exists: true, hasCode: true, blockHeight: 8 });
});
