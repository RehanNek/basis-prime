// The keeper's backup for posting signed Hyperliquid actions: recent entries only, each once per process,
// testnet only, retried while Hyperliquid doesn't answer. Nothing here touches a network.
import assert from "node:assert/strict";
import { test } from "node:test";

import { keeperConfig } from "./config.js";
import { exchangeBody, hlExchange, POST_WINDOW_MS, SignedPoster, type SignedEntry } from "./hl-post.js";
import { tick, type KeeperDeps } from "./loop.js";
import type { AccountState } from "./state.js";

const T0 = Date.UTC(2026, 10, 8, 12, 0);
const SIG = { r: `0x${"1".repeat(64)}`, s: `0x${"2".repeat(64)}`, v: 27 };
const entry = (index: number, nonce: number, kind = "sendAsset", chain = "Testnet"): SignedEntry => ({
  index,
  kind,
  action: JSON.stringify({ type: kind, hyperliquidChain: chain, signatureChainId: "0x66eee", amount: "9500", nonce }),
  nonce,
  signature: SIG,
  signed_block: 100 + index,
});

function fakeExchange(...replies: ({ status: number; body: unknown } | Error)[]) {
  const posted: unknown[] = [];
  const exchange = async (body: unknown) => {
    posted.push(body);
    const reply = replies.shift() ?? { status: 200, body: { status: "ok", response: { type: "default" } } };
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { exchange, posted };
}

test("recent entries are posted once each, oldest first, as {action, nonce, signature}; old ones are left alone", async () => {
  const { exchange, posted } = fakeExchange();
  const poster = new SignedPoster(exchange, () => T0);
  const entries = [entry(2, T0 - 1_000), entry(1, T0 - 60_000, "approveAgent"), entry(0, T0 - POST_WINDOW_MS - 1)];

  const lines = await poster.postNew("alice.pbf.testnet", entries);
  assert.deepEqual(lines, ["signed #1 (approveAgent) posted: Hyperliquid accepted it", "signed #2 (sendAsset) posted: Hyperliquid accepted it"]);
  assert.deepEqual(posted[1], { action: JSON.parse(entries[0]!.action), nonce: T0 - 1_000, signature: SIG });
  assert.deepEqual(await poster.postNew("alice.pbf.testnet", entries), [], "the next tick posts nothing again");
  assert.equal((await poster.postNew("bob.pbf.testnet", [entry(2, T0)])).length, 1, "another account's #2 is its own");
});

test("Hyperliquid's refusal is logged and not retried; no answer is retried on the next tick", async () => {
  const { exchange, posted } = fakeExchange({ status: 200, body: { status: "err", response: "Invalid nonce" } }, new Error("timeout"));
  const poster = new SignedPoster(exchange, () => T0);
  assert.deepEqual(await poster.postNew("a.pbf.testnet", [entry(0, T0)]), ['signed #0 (sendAsset) posted: Hyperliquid answered "Invalid nonce"']);
  assert.match((await poster.postNew("a.pbf.testnet", [entry(1, T0)]))[0]!, /did not answer \(timeout\); will retry/);
  assert.match((await poster.postNew("a.pbf.testnet", [entry(1, T0)]))[0]!, /posted: Hyperliquid accepted it/);
  assert.equal(posted.length, 3);
});

test("only testnet actions of the two kinds whose nonce and signature are whole", () => {
  assert.ok(exchangeBody(entry(0, T0)).body);
  assert.match(exchangeBody(entry(0, T0, "sendAsset", "Mainnet")).refused!, /testnet actions only/);
  assert.match(exchangeBody(entry(0, T0, "withdraw3")).refused!, /doesn't post/);
  assert.match(exchangeBody({ ...entry(0, T0), nonce: 1 }).refused!, /nonce/);
  assert.match(exchangeBody({ ...entry(0, T0), signature: { ...SIG, v: 1 } }).refused!, /signature/);
});

test("the tick logs what it posted, and the keeper refuses any Hyperliquid API but testnet's", async () => {
  const lines: { event: string; msg: string; account?: unknown }[] = [];
  const state: AccountState = { owner: "alice.testnet", counter: 0, loan: { principal: "0" }, verdict: null, hl: { path: "hyperliquid-1", address: null, signed: [entry(0, T0, "approveAgent")] } };
  const posted: string[] = [];
  const deps: KeeperDeps = {
    readMarket: async () => ({ prices: { marks: {}, pi: {} }, summary: {} }),
    listAccounts: async () => ["alice.pbf.testnet"],
    readState: async () => state,
    blockTimeMs: async () => T0,
    readPerps: async () => [],
    requestCheck: async () => ({ ok: true, hash: null, attestationUrl: null, seconds: 0 }),
    runGateway: async () => ({ ok: true, retry: false, replan: false, code: null, reason: null, output: null, callId: null, attestationUrl: null, seconds: 0 }),
    executeStep: async () => ({ ok: true, hash: null, logs: [], seconds: 0, retry: false }),
    postSigned: async (account, s) => (posted.push(`${account} ${s.hl?.signed?.length}`), ["signed #0 (approveAgent) posted: Hyperliquid accepted it"]),
    log: (event, msg, fields = {}) => lines.push({ event, msg, ...fields }),
    now: () => T0,
  };
  await tick(deps, new Map());
  assert.deepEqual(posted, ["alice.pbf.testnet 1"], "the backup gets the signed entries from the same get_state");
  assert.deepEqual(lines.at(-1), { event: "hl_post", msg: "signed #0 (approveAgent) posted: Hyperliquid accepted it", account: "alice.pbf.testnet" });
  assert.throws(() => keeperConfig({ HL_API_URL: "https://hl-proxy.example" }, []), /testnet's API/);
});

test("hlExchange posts JSON to <api>/exchange and passes Hyperliquid's answer on", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("Failed to deserialize the JSON body", { status: 422 });
  }) as typeof fetch;
  const reply = await hlExchange("https://api.hyperliquid-testnet.xyz/", fetchImpl)({ action: {} });
  assert.deepEqual(reply, { status: 422, body: "Failed to deserialize the JSON body" });
  assert.equal(calls[0]!.url, "https://api.hyperliquid-testnet.xyz/exchange");
});
