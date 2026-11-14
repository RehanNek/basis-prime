// The shim's HTTP API, end to end over a real local socket, with a fake upstream 1Click and fake floats.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { OneClickClient, type QuoteRequest } from "@pb/oneclick";

import { BASE_TWINS } from "./assets.js";
import { Engine } from "./engine.js";
import { ASSETS, ASSETS_WITH_BASE, B_WBTC, BASE_TOKENS, FakeEvm, FakeHl, FakeNear, HL_USDC, MNBTC, MUSDC, priced, request } from "./fakes.js";
import { createShimServer } from "./server.js";
import { Store } from "./state.js";

const ADMIN = "test-admin-token";
const upstreamCalls: { url: string; body: QuoteRequest | undefined }[] = [];
let nextUpstream: { status: number; body: unknown } | undefined;

/** The real 1Click, faked: it prices any quote at $10 -> 0.00013117 BTC, unless told otherwise. */
const upstream = new OneClickClient({
  baseUrl: "https://1click.example",
  fetch: (async (url: string | URL | Request, init?: RequestInit) => {
    upstreamCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const answer = nextUpstream ?? {
      status: String(url).endsWith("/v0/tokens") ? 200 : 201,
      body: String(url).endsWith("/v0/tokens")
        ? [{ assetId: "nep141:nbtc.bridge.near", decimals: 8, blockchain: "near", symbol: "BTC", price: 76050, priceUpdatedAt: "2026-11-07T08:11:00.827Z" }]
        : priced(),
    };
    nextUpstream = undefined;
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch,
});

const near = new FakeNear();
const engine = new Engine({ store: new Store(), assets: ASSETS, near, hl: new FakeHl() });
const server = createShimServer({ engine, upstream, assets: ASSETS, floats: { near: true, hl: false }, adminToken: ADMIN });
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function call(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

test("GET /v0/tokens lists the three test assets, priced as their mainnet twins", async () => {
  const { status, body } = await call("GET", "/v0/tokens");
  assert.equal(status, 200);
  const list = body as unknown as { assetId: string; symbol: string; decimals: number; price: number }[];
  assert.deepEqual(list.map((t) => [t.assetId, t.symbol, t.decimals]), [
    [MUSDC, "mUSDC", 6],
    [MNBTC, "mNBTC", 8],
    [HL_USDC, "USDC", 8],
  ]);
  assert.equal(list[1]?.price, 76050);
});

test("a dry quote asks the real 1Click about the mainnet twins, with placeholder parties", async () => {
  upstreamCalls.length = 0;
  const { status, body } = await call("POST", "/v0/quote", request({ dry: true, customRecipientMsg: "{}" }));
  assert.equal(status, 201);
  assert.equal(body.quote.amountOut, "13117");
  assert.equal(body.quote.depositAddress, undefined);
  assert.equal(body.quoteRequest.originAsset, MUSDC, "the answer echoes the client's own request");

  const sent = upstreamCalls[0]?.body;
  assert.equal(sent?.dry, true);
  assert.equal(sent?.originAsset, "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
  assert.equal(sent?.destinationAsset, "nep141:nbtc.bridge.near");
  assert.equal(sent?.recipient, "aurora");
  assert.equal(sent?.refundTo, "aurora");
  assert.equal(sent?.customRecipientMsg, undefined);
});

test("a committed quote is priced dry upstream, and gets a deposit address the shim watches", async () => {
  upstreamCalls.length = 0;
  const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
  const { status, body } = await call("POST", "/v0/quote", request({ deadline }));
  assert.equal(status, 201);
  assert.equal(upstreamCalls[0]?.body?.dry, true, "the shim never asks the real 1Click for a committed quote");
  assert.match(body.quote.depositAddress, /^[0-9a-f]{64}$/);
  assert.equal(body.quote.deadline, deadline);

  const polled = await call("GET", `/v0/status?depositAddress=${body.quote.depositAddress}`);
  assert.equal(polled.status, 200);
  assert.equal(polled.body.status, "PENDING_DEPOSIT");
  assert.equal(polled.body.correlationId, body.correlationId);

  const submitted = await call("POST", "/v0/deposit/submit", { txHash: "HASH", depositAddress: body.quote.depositAddress });
  assert.equal(submitted.body.status, "KNOWN_DEPOSIT_TX");
  assert.deepEqual(submitted.body.swapDetails.originChainTxHashes, [{ hash: "HASH", explorerUrl: "https://testnet.nearblocks.io/txns/HASH" }]);
});

test("quotes the shim can't serve are refused with a reason", async () => {
  const cases: [Partial<QuoteRequest>, number, RegExp][] = [
    [{ originAsset: "nep141:wrap.testnet" }, 400, /Unknown originAsset/],
    [{ swapType: "EXACT_OUTPUT" }, 400, /EXACT_INPUT only/],
    [{ recipient: "Not An Account!" }, 400, /recipient is not a valid NEAR account/],
    [{ amount: "0" }, 400, /positive whole number/],
    [{ recipientType: "INTENTS" }, 400, /DESTINATION_CHAIN only/],
    [{ destinationAsset: HL_USDC, recipient: "0x3333333333333333333333333333333333333333" }, 503, /Hyperliquid float is off/],
  ];
  for (const [overrides, expectedStatus, message] of cases) {
    const { status, body } = await call("POST", "/v0/quote", request({ deadline: new Date(Date.now() + 600_000).toISOString(), ...overrides }));
    assert.equal(status, expectedStatus, JSON.stringify(overrides));
    assert.match(body.message, message);
  }
});

test("the real 1Click's refusal is passed through as it came", async () => {
  nextUpstream = { status: 400, body: { message: "Amount is too low" } };
  const { status, body } = await call("POST", "/v0/quote", request({ dry: true }));
  assert.equal(status, 400);
  assert.deepEqual(body, { message: "Amount is too low" });
});

test("unknown deposit addresses and routes answer 404", async () => {
  assert.equal((await call("GET", "/v0/status?depositAddress=nope")).status, 404);
  assert.equal((await call("POST", "/v0/deposit/submit", { txHash: "H", depositAddress: "nope" })).status, 404);
  assert.equal((await call("GET", "/v1/anything")).status, 404);
});

test("the fault switch needs the admin token", async () => {
  assert.equal((await call("POST", "/admin/fault", { mode: "fail" })).status, 401);
  assert.equal((await call("POST", "/admin/fault", { mode: "fail" }, "wrong")).status, 401);
  assert.equal((await call("POST", "/admin/fault", { mode: "explode" }, ADMIN)).status, 400);

  const set = await call("POST", "/admin/fault", { mode: "late", delaySeconds: 90 }, ADMIN);
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.fault, { mode: "late", delaySeconds: 90 });
  assert.deepEqual((await call("GET", "/admin/fault", undefined, ADMIN)).body.fault, { mode: "late", delaySeconds: 90 });

  await call("POST", "/admin/fault", { mode: "none" }, ADMIN);
  assert.equal(engine.fault.mode, "none");
});

test("with no admin token configured, the fault switch is off", async () => {
  const closed = createShimServer({ engine, upstream, assets: ASSETS, floats: { near: true, hl: false }, adminToken: undefined });
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  try {
    const port = (closed.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/admin/fault`, { headers: { Authorization: "Bearer " } });
    assert.equal(response.status, 503);
  } finally {
    closed.close();
  }
});

test("stage 4 over HTTP: a quote to Base Sepolia is priced through its route, refused in words (400) when the float couldn't fill it, and needs the float on to commit", async () => {
  const evm = new FakeEvm();
  evm.room[BASE_TOKENS.wbtc.toLowerCase()] = 2_500_000_000n;
  const withBase = new Engine({ store: new Store(), assets: ASSETS_WITH_BASE, near, hl: new FakeHl(), evm });
  const on = createShimServer({ engine: withBase, upstream, assets: ASSETS_WITH_BASE, floats: { near: true, hl: false, evm: true }, evm, adminToken: ADMIN });
  const off = createShimServer({ engine: withBase, upstream, assets: ASSETS_WITH_BASE, floats: { near: true, hl: false, evm: false }, adminToken: ADMIN });
  await Promise.all([on, off].map((s) => new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve))));
  const post = async (s: typeof on, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/v0/quote`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const ADDRESS = "0x5ebf298b5e84faf68d644b1b3987867c99fca794";
  const toBase = request({ originAsset: MNBTC, destinationAsset: B_WBTC, amount: "55000", refundTo: "a.pbf.testnet", recipient: ADDRESS, deadline: new Date(Date.now() + 600_000).toISOString() });
  try {
    upstreamCalls.length = 0;
    const committed = await post(on, toBase);
    assert.equal(committed.status, 201);
    assert.match(committed.body.quote.depositAddress, /^[0-9a-f]{64}$/);
    // The real 1Click priced nBTC to cbBTC on Base, with placeholders for the parties.
    assert.deepEqual([upstreamCalls[0]!.body!.originAsset, upstreamCalls[0]!.body!.destinationAsset, upstreamCalls[0]!.body!.dry], ["nep141:nbtc.bridge.near", BASE_TWINS.wbtc, true]);
    // The listing has the three Base Sepolia tokens after the stand-in's first three.
    const tokens = await fetch(`http://127.0.0.1:${(on.address() as AddressInfo).port}/v0/tokens`).then((r) => r.json() as Promise<{ symbol: string }[]>);
    assert.deepEqual(tokens.map((t) => t.symbol), ["mUSDC", "mNBTC", "USDC", "USDC", "WBTC", "WETH"]);

    evm.mintRefusal = "execution reverted";
    const short = await post(on, { ...toBase, dry: true });
    assert.equal(short.status, 400);
    assert.match(short.body.message, /^The stand-in's float holds 0 WBTC, and Aave's faucet wouldn't mint the 0\.00013117 WBTC it is short of now \(execution reverted\)/);
    evm.mintRefusal = null;
    const wrong = await post(on, { ...toBase, originAsset: MUSDC, dry: true });
    assert.deepEqual([wrong.status, /on four routes only/.test(wrong.body.message)], [400, true]);
    const bad = await post(on, { ...toBase, recipient: "a.pbf.testnet" });
    assert.deepEqual([bad.status, bad.body.message], [400, "recipient is not a valid Base Sepolia address"]);

    // With the float off, a price still answers, and a committed quote says what to set.
    assert.equal((await post(off, { ...toBase, dry: true })).status, 201);
    const refusedOff = await post(off, toBase);
    assert.deepEqual([refusedOff.status, refusedOff.body.message], [503, "The shim's Base Sepolia float is off: set EVM_GAS_PRIVATE_KEY (the gas wallet is the float there)"]);
  } finally {
    on.close();
    off.close();
  }
});
