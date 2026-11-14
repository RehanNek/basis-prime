import assert from "node:assert/strict";
import { test } from "node:test";

import { baseSepoliaAddress, baseSepoliaAssetId } from "./types.js";

import { OneClickClient, OneClickError, waitForStatus } from "./client.js";
import { oneClickFromEnv } from "./env.js";
import type { QuoteRequest, StatusResponse, SwapStatus } from "./types.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake fetch that records each call and answers with the next canned response. */
function fakeFetch(...answers: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const answer = answers.shift() ?? { status: 500, body: "no canned answer left" };
    const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return new Response(text, { status: answer.status });
  }) as typeof fetch;
  return { impl, calls };
}

const QUOTE: QuoteRequest = {
  dry: true,
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  depositType: "ORIGIN_CHAIN",
  destinationAsset: "nep141:nbtc.bridge.near",
  amount: "10000000",
  refundTo: "aurora",
  refundType: "ORIGIN_CHAIN",
  recipient: "aurora",
  recipientType: "DESTINATION_CHAIN",
  deadline: "2026-11-07T08:21:46.000Z",
};

function statusOf(status: SwapStatus): StatusResponse {
  return {
    correlationId: "c1",
    status,
    updatedAt: "2026-11-07T08:00:00.000Z",
    quoteResponse: {} as StatusResponse["quoteResponse"],
    swapDetails: { originChainTxHashes: [], destinationChainTxHashes: [] },
  };
}

test("tokens() sends GET /v0/tokens with the key in X-API-Key", async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: [{ assetId: "nep141:wrap.near", decimals: 24 }] });
  const client = new OneClickClient({ baseUrl: "https://1click.example/", apiKey: "k-123", fetch: impl });

  const tokens = await client.tokens();

  assert.equal(tokens[0]?.assetId, "nep141:wrap.near");
  assert.equal(calls[0]?.url, "https://1click.example/v0/tokens");
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.headers["X-API-Key"], "k-123");
  assert.equal(calls[0]?.headers["Content-Type"], undefined);
});

test("quote() posts the request as JSON and accepts HTTP 201", async () => {
  const answer = { correlationId: "q1", quote: { amountIn: "10000000", amountOut: "13117", timeEstimate: 20 } };
  const { impl, calls } = fakeFetch({ status: 201, body: answer });
  const client = new OneClickClient({ baseUrl: "https://1click.example", apiKey: "k", fetch: impl });

  const response = await client.quote(QUOTE);

  assert.equal(response.quote.amountOut, "13117");
  assert.equal(calls[0]?.url, "https://1click.example/v0/quote");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.headers["Content-Type"], "application/json");
  assert.deepEqual(calls[0]?.body, QUOTE);
});

test("without a key, no X-API-Key header is sent", async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: [] });
  await new OneClickClient({ baseUrl: "http://localhost:8787", fetch: impl }).tokens();
  assert.equal("X-API-Key" in (calls[0]?.headers ?? {}), false);
});

test("status() puts the deposit address and memo in the query string", async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: statusOf("PROCESSING") }, { status: 200, body: statusOf("SUCCESS") });
  const client = new OneClickClient({ baseUrl: "http://localhost:8787", fetch: impl });

  assert.equal((await client.status("abc 1", "m/2")).status, "PROCESSING");
  assert.equal((await client.status("abc")).status, "SUCCESS");

  assert.equal(calls[0]?.url, "http://localhost:8787/v0/status?depositAddress=abc+1&depositMemo=m%2F2");
  assert.equal(calls[1]?.url, "http://localhost:8787/v0/status?depositAddress=abc");
});

test("submitDeposit() posts the transaction hash", async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: statusOf("KNOWN_DEPOSIT_TX") });
  const client = new OneClickClient({ baseUrl: "http://localhost:8787", fetch: impl });

  const status = await client.submitDeposit({ txHash: "H1", depositAddress: "abc", nearSenderAccount: "a.testnet" });

  assert.equal(status.status, "KNOWN_DEPOSIT_TX");
  assert.equal(calls[0]?.url, "http://localhost:8787/v0/deposit/submit");
  assert.deepEqual(calls[0]?.body, { txHash: "H1", depositAddress: "abc", nearSenderAccount: "a.testnet" });
});

test("an HTTP error becomes a OneClickError with the status and the API's message", async () => {
  const { impl } = fakeFetch(
    { status: 400, body: { message: "Amount is too low" } },
    { status: 502, body: "<html>bad gateway</html>" },
  );
  const client = new OneClickClient({ baseUrl: "https://1click.example", fetch: impl });

  await assert.rejects(client.quote(QUOTE), (error: unknown) => {
    assert.ok(error instanceof OneClickError);
    assert.equal(error.status, 400);
    assert.match(error.message, /\/v0\/quote answered HTTP 400: Amount is too low/);
    return true;
  });
  await assert.rejects(client.tokens(), /HTTP 502: <html>bad gateway<\/html>/);
});

test("a keyed client refuses to run in a browser", () => {
  const global = globalThis as { window?: unknown };
  global.window = {};
  try {
    assert.throws(() => new OneClickClient({ baseUrl: "https://1click.example", apiKey: "k" }), /server-side only/);
    assert.doesNotThrow(() => new OneClickClient({ baseUrl: "https://1click.example" }));
  } finally {
    delete global.window;
  }
});

test("oneClickFromEnv: the shim on testnet with no key, the real API with the key on mainnet", () => {
  const testnet = oneClickFromEnv({ NEAR_NETWORK: "testnet", SHIM_URL: "http://localhost:8787", ONECLICK_JWT: "k" });
  assert.equal(testnet.baseUrl, "http://localhost:8787");

  const mainnet = oneClickFromEnv({ NEAR_NETWORK: "mainnet", ONECLICK_API_URL: "", ONECLICK_JWT: "k" });
  assert.equal(mainnet.baseUrl, "https://1click.chaindefuser.com");

  assert.throws(() => oneClickFromEnv({ NEAR_NETWORK: "testnet", SHIM_URL: "" }), /SHIM_URL is empty/);
  assert.throws(() => oneClickFromEnv({ NEAR_NETWORK: "betanet" }), /testnet or mainnet/);
});

test("the shim client never sends the key, even when ONECLICK_JWT is set", async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: [] });
  await oneClickFromEnv({ NEAR_NETWORK: "testnet", SHIM_URL: "http://localhost:8787", ONECLICK_JWT: "k" }, impl).tokens();
  assert.equal("X-API-Key" in (calls[0]?.headers ?? {}), false);
});

test("waitForStatus polls until a terminal status and reports each change", async () => {
  const { impl, calls } = fakeFetch(
    { status: 200, body: statusOf("PENDING_DEPOSIT") },
    { status: 200, body: statusOf("PENDING_DEPOSIT") },
    { status: 200, body: statusOf("PROCESSING") },
    { status: 200, body: statusOf("REFUNDED") },
  );
  const client = new OneClickClient({ baseUrl: "http://localhost:8787", fetch: impl });
  const seen: string[] = [];

  const final = await waitForStatus(client, "abc", { sleep: async () => {}, onChange: (s) => seen.push(s.status) });

  assert.equal(final.status, "REFUNDED");
  assert.equal(calls.length, 4);
  assert.deepEqual(seen, ["PENDING_DEPOSIT", "PROCESSING", "REFUNDED"]);
});

test("waitForStatus gives up after its timeout", async () => {
  const { impl } = fakeFetch(...Array.from({ length: 10 }, () => ({ status: 200, body: statusOf("PROCESSING") })));
  const client = new OneClickClient({ baseUrl: "http://localhost:8787", fetch: impl });
  let clock = 0;

  await assert.rejects(
    waitForStatus(client, "abc", { intervalMs: 1_000, timeoutMs: 3_000, now: () => clock, sleep: async (ms) => void (clock += ms) }),
    /Gave up after 3 s: abc is still PROCESSING/,
  );
});

test("the stand-in's ids for Base Sepolia's tokens: 1Click's form, a chain name of our own, and the address back out", () => {
  const weth = baseSepoliaAssetId("0x4200000000000000000000000000000000000006");
  assert.equal(weth, "1cs_v1:base-sepolia:erc20:0x4200000000000000000000000000000000000006");
  assert.equal(baseSepoliaAssetId("0x54114591963CF60EF3aA63bEfD6eC263D98145a4"), "1cs_v1:base-sepolia:erc20:0x54114591963cf60ef3aa63befd6ec263d98145a4", "lowercase, whatever the caller's");
  assert.equal(baseSepoliaAddress(weth), "0x4200000000000000000000000000000000000006");
  // 1Click's own id for WETH on Base (its token list, 11 Nov) is another asset, and isn't read as one of ours.
  assert.equal(baseSepoliaAddress("nep141:base-0x4200000000000000000000000000000000000006.omft.near"), null);
  assert.equal(baseSepoliaAddress("1cs_v1:base-sepolia:erc20:0x1234"), null);
});
