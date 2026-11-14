// Privacy level 1 (INTERFACES.md 48.7): the keeper package's calls to the backend carry its service token when the
// file is there, and nothing when it isn't. No file is written and no call leaves the test.
import assert from "node:assert/strict";
import { test } from "node:test";

import { keeperConfig } from "./config.js";
import { backendSubmit } from "./evm.js";
import { http } from "./gate-world.js";
import { backendFetch, DEFAULT_SERVICE_TOKEN_FILE, readServiceToken, serviceTokenFile } from "./service-token.js";

const TOKEN = `svc.${"ab".repeat(32)}`;
const NEWER = `svc.${"cd".repeat(32)}`;
const FILE = "/somewhere/service-token";

/** A backend that records each call's Authorization header and answers with the next canned status (200 unless said). */
function backend(...statuses: number[]) {
  const seen: (string | undefined)[] = [];
  const bodies: unknown[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push((init?.headers as Record<string, string> | undefined)?.Authorization);
    bodies.push(init?.body);
    return new Response(JSON.stringify({ ok: true }), { status: statuses.shift() ?? 200 });
  }) as typeof fetch;
  return { impl, seen, bodies };
}

/** A token file that holds `text`, or isn't there when `text` is null. Each read is counted. */
function file(initial: string | null) {
  const state = { text: initial, reads: 0 };
  const read = (path: string) => {
    state.reads += 1;
    assert.equal(path, FILE);
    if (state.text === null) throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    return state.text;
  };
  return { state, read };
}

test("48.7: the service token's file is SERVICE_TOKEN_FILE, or the api package's logs/service-token, as the backend has it", () => {
  assert.match(DEFAULT_SERVICE_TOKEN_FILE, /services\/api\/logs\/service-token$/);
  assert.equal(serviceTokenFile(undefined), DEFAULT_SERVICE_TOKEN_FILE);
  assert.equal(serviceTokenFile("  "), DEFAULT_SERVICE_TOKEN_FILE);
  assert.equal(serviceTokenFile(" /tmp/x/token "), "/tmp/x/token");
  assert.equal(keeperConfig({}, []).serviceTokenFile, DEFAULT_SERVICE_TOKEN_FILE);
  assert.equal(keeperConfig({ SERVICE_TOKEN_FILE: "/tmp/x/token" }, []).serviceTokenFile, "/tmp/x/token");
  // Only a service token is one: anything else in the file is no token.
  assert.equal(readServiceToken(FILE, () => `${TOKEN}\n`), TOKEN);
  for (const text of ["", "svc.short", TOKEN.toUpperCase(), `v1.${"a".repeat(64)}`, `${TOKEN}0`]) assert.equal(readServiceToken(FILE, () => text), null, text);
  assert.equal(readServiceToken(FILE, file(null).read), null);
});

test("48.7: with the file there, every call to the backend carries the token; the file is read once", async () => {
  const { impl, seen, bodies } = backend();
  const { state, read } = file(`${TOKEN}\n`);
  const toBackend = backendFetch(FILE, impl, read);
  // The gate scripts' client (gate-world.ts), a GET and a POST, with its own headers kept.
  const got = await http("GET", "http://localhost:8788/api/lender/a.pbf.testnet", undefined, 5_000, {}, toBackend);
  await http("POST", "http://localhost:8788/api/funding-plan", { account: "a.pbf.testnet", amount: "1" }, 5_000, { "X-Other": "1" }, toBackend);
  // The keeper's own call (evm.ts): POST /api/evm/submit.
  await backendSubmit("http://localhost:8788", toBackend)("a.pbf.testnet", 3);
  assert.deepEqual([got.status, got.body], [200, { ok: true }]);
  assert.deepEqual(seen, [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  assert.deepEqual(bodies, [undefined, '{"account":"a.pbf.testnet","amount":"1"}', '{"account":"a.pbf.testnet","nonce":3}'], "the calls themselves are as they were");
  assert.equal(state.reads, 1);
});

test("48.7: with no file nothing is sent, and a call works as it did against a backend with privacy off", async () => {
  const { impl, seen } = backend();
  const { read } = file(null);
  const toBackend = backendFetch(FILE, impl, read);
  const got = await http("GET", "http://localhost:8788/api/config", undefined, 5_000, {}, toBackend);
  await backendSubmit("http://localhost:8788", toBackend)("a.pbf.testnet", 3);
  assert.equal(got.status, 200);
  assert.deepEqual(seen, [undefined, undefined]);
  // A call that isn't to the backend (Hyperliquid, the stand-in) uses plain fetch and never has the header.
  const plain = backend();
  const original = globalThis.fetch;
  globalThis.fetch = plain.impl;
  try {
    await http("POST", "https://api.hyperliquid-testnet.xyz/info", { type: "meta" }, 5_000);
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(plain.seen, [undefined]);
});

/** A token file whose reads give these texts in turn (the last one from then on); null is "no such file". */
function fileThen(...texts: (string | null)[]) {
  let reads = 0;
  return (path: string) => {
    assert.equal(path, FILE);
    const text = texts[Math.min(reads++, texts.length - 1)];
    if (text === null || text === undefined) throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    return text;
  };
}

test("48.7: on a 401 the file is read again: a backend that restarted, or started after the keeper, is answered with its new token; with no newer token the 401 stands", async () => {
  const ask = (client: typeof fetch) => http("GET", "http://localhost:8788/api/hl/a.pbf.testnet", undefined, 5_000, {}, client);

  // The backend restarted and wrote a new token: the old one is refused once, and the call goes again with the new one.
  const restarted = backend(401, 200, 200);
  const client = backendFetch(FILE, restarted.impl, fileThen(TOKEN, NEWER));
  assert.equal((await ask(client)).status, 200);
  assert.deepEqual(restarted.seen, [`Bearer ${TOKEN}`, `Bearer ${NEWER}`]);
  await ask(client);
  assert.equal(restarted.seen[2], `Bearer ${NEWER}`, "the new token is kept for the calls after");

  // The keeper started before the backend: no file at first, so nothing is sent. The backend refuses, the file is
  // there by then, and the call goes again with the token.
  const cold = backend(401, 200);
  assert.equal((await ask(backendFetch(FILE, cold.impl, fileThen(null, TOKEN)))).status, 200);
  assert.deepEqual(cold.seen, [undefined, `Bearer ${TOKEN}`]);

  // The file still holds the token that was refused: the 401 is the answer, and the call isn't made twice.
  const same = backend(401);
  assert.equal((await ask(backendFetch(FILE, same.impl, fileThen(TOKEN)))).status, 401);
  assert.deepEqual(same.seen, [`Bearer ${TOKEN}`]);
  // No file at all, and a 401: the same.
  const none = backend(401);
  assert.equal((await ask(backendFetch(FILE, none.impl, fileThen(null)))).status, 401);
  assert.deepEqual(none.seen, [undefined]);
});
