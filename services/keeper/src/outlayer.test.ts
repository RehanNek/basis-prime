// The keeper's OutLayer runner asks for a run, then asks about it (11 Nov): the fakes here stand in for OutLayer's
// API, with the answers read live that day ({call_id, status: "pending", poll_url, attestation_url}, then the
// completed run).
import assert from "node:assert/strict";
import { test } from "node:test";

import { API_SLACK_MS, BACKEND_ORDER_WAIT_MAX_MS, BACKEND_OUTLAYER_WAIT_MS, backendWaitMs, KEEPER_ALIVE_MS, keeperConfig, outlayerWaitMs, VERDICT_WAIT_MS } from "./config.js";
import { DEFAULT_OUTLAYER_WAIT_MS, OUTLAYER_POLL_MS, OutLayerError, OutLayerRunner } from "./outlayer.js";

const KEY = "pbf-keeper.testnet:1:supersecretsupersecret";
const INPUT = { mode: "deleverage", account: "a.pbf.testnet", network: "testnet" };
const SUBMITTED = { call_id: "c1", status: "pending", poll_url: "/calls/c1", attestation_url: "/attestations/by-call/c1" };
const PENDING = { call_id: "c1", status: "pending", attestation_url: "/attestations/by-call/c1" };
const COMPLETED = { call_id: "c1", status: "completed", output: { ok: true, pid: "9", placed: [1] }, compute_cost: "1100", instructions: 5, time_ms: 2_900, attestation_url: "/attestations/by-call/c1" };

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** A fetch that answers with the next canned response (the last one again once they run out), and a clock that only moves when the runner sleeps. */
function fakes(...answers: ({ status: number; body: unknown } | Error)[]) {
  const sent: Sent[] = [];
  const sleeps: number[] = [];
  let at = 5_000_000;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string> });
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (answer instanceof Error) throw answer;
    return new Response(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  const runner = (waitMs?: number) =>
    new OutLayerRunner({
      apiUrl: "https://testnet-api.outlayer.ai/",
      paymentKey: KEY,
      fetch: fetchImpl,
      now: () => at,
      sleep: async (ms) => {
        sleeps.push(ms);
        at += ms;
      },
      ...(waitMs === undefined ? {} : { waitMs }),
    });
  return { sent, sleeps, runner };
}

test("a gateway run that waits its turn is asked about every 2 s until it ends, and comes back as a run that waited did", async () => {
  const f = fakes({ status: 200, body: SUBMITTED }, { status: 200, body: PENDING }, { status: 200, body: PENDING }, { status: 200, body: COMPLETED });
  const run = await f.runner().run("pbf-keeper.testnet/pb-gateway", INPUT, "fcae60");
  assert.deepEqual(run, {
    callId: "c1",
    status: "completed",
    output: { ok: true, pid: "9", placed: [1] },
    error: null,
    computeCost: "1100",
    timeMs: 2_900,
    attestationUrl: "https://testnet-api.outlayer.ai/attestations/by-call/c1",
  });
  assert.deepEqual(f.sleeps, [OUTLAYER_POLL_MS, OUTLAYER_POLL_MS, OUTLAYER_POLL_MS]);
  assert.equal(OUTLAYER_POLL_MS, 2_000);
  assert.deepEqual(
    f.sent.map((s) => [s.method, s.url]),
    [
      ["POST", "https://testnet-api.outlayer.ai/call/pbf-keeper.testnet/pb-gateway"],
      ["GET", "https://testnet-api.outlayer.ai/calls/c1"],
      ["GET", "https://testnet-api.outlayer.ai/calls/c1"],
      ["GET", "https://testnet-api.outlayer.ai/calls/c1"],
    ],
  );
  for (const s of f.sent) assert.equal(s.headers["X-Payment-Key"], KEY, "the same key asks about the run");
  assert.equal("X-Compute-Limit" in f.sent[1]!.headers, false);
});

test("a gateway run that ends without completing comes back with its status and error, for the keeper to try again", async () => {
  const f = fakes({ status: 200, body: SUBMITTED }, { status: 200, body: { call_id: "c1", status: "failed", error: "execution timed out after 20 s" } });
  const run = await f.runner().run("pbf-keeper.testnet/pb-gateway", INPUT);
  assert.deepEqual([run.status, run.error, run.output, run.attestationUrl], ["failed", "execution timed out after 20 s", null, "https://testnet-api.outlayer.ai/attestations/by-call/c1"]);
});

test("a gateway run that never ends is given OUTLAYER_WAIT_MS, then reported as OutLayer not answering; it may still run", async () => {
  const f = fakes({ status: 200, body: SUBMITTED }, { status: 200, body: PENDING });
  await assert.rejects(f.runner().run("pbf-keeper.testnet/pb-gateway", INPUT), (error: unknown) => {
    assert.ok(error instanceof OutLayerError);
    assert.equal(error.status, 504);
    assert.equal(error.message, "OutLayer did not answer: the run was still waiting its turn after 180 s (call c1). It may still run");
    return true;
  });
  assert.equal(DEFAULT_OUTLAYER_WAIT_MS, 180_000);
  assert.equal(f.sent.length, 1 + 90, "the submit, then a question every 2 s for 180 s");

  const short = fakes({ status: 200, body: SUBMITTED }, { status: 200, body: PENDING });
  await assert.rejects(short.runner(30_000).run("pbf-keeper.testnet/pb-gateway", INPUT), /still waiting its turn after 30 s \(call c1\)/);
  assert.equal(short.sent.length, 1 + 15);
});

test("a question about the run that fails is only a miss, a refused key ends it, and neither shows the key", async () => {
  const missed = fakes({ status: 200, body: SUBMITTED }, { status: 404, body: { error: "Call not found", reason: "call_not_found" } }, new TypeError("fetch failed"), { status: 502, body: "<html>" }, { status: 200, body: COMPLETED });
  assert.equal((await missed.runner().run("pbf-keeper.testnet/pb-gateway", INPUT)).status, "completed");
  assert.equal(missed.sent.length, 5);

  const lost = fakes({ status: 200, body: SUBMITTED }, { status: 404, body: { error: "Call not found", reason: "call_not_found" } });
  await assert.rejects(lost.runner(10_000).run("pbf-keeper.testnet/pb-gateway", INPUT), /after 10 s \(call c1; the last time it was asked about, OutLayer answered HTTP 404 \(it doesn't know the call\)\)\. It may still run$/);

  const refused = fakes({ status: 200, body: SUBMITTED }, { status: 401, body: `bad key ${KEY}` });
  await assert.rejects(refused.runner().run("pbf-keeper.testnet/pb-gateway", INPUT), (error: unknown) => {
    assert.ok(error instanceof OutLayerError);
    assert.equal(error.status, 401);
    assert.ok(!error.message.includes("supersecret"), error.message);
    assert.match(error.message, /^OutLayer answered HTTP 401: bad key <payment key>$/);
    return true;
  });
  assert.equal(refused.sent.length, 2);
});

test("503 on the submit is retried once; a submit that gets no answer is OutLayer not answering", async () => {
  const busy = fakes({ status: 503, body: { error: "busy" } }, { status: 200, body: SUBMITTED }, { status: 200, body: COMPLETED });
  assert.equal((await busy.runner().run("pbf-keeper.testnet/pb-gateway", INPUT)).status, "completed");
  assert.deepEqual(busy.sent.map((s) => s.method), ["POST", "POST", "GET"]);
  assert.deepEqual(busy.sleeps, [1_000, OUTLAYER_POLL_MS]);

  const down = fakes(new TypeError("fetch failed"));
  await assert.rejects(down.runner().run("pbf-keeper.testnet/pb-gateway", INPUT), (error: unknown) => error instanceof OutLayerError && error.status === 504 && error.message === "OutLayer did not answer: fetch failed");
  assert.equal(down.sent.length, 1);
});

test("OUTLAYER_WAIT_MS is 3 minutes unless set, and what waits on a run waits longer than the run", () => {
  assert.equal(outlayerWaitMs({}), 180_000);
  assert.equal(outlayerWaitMs({ OUTLAYER_WAIT_MS: " 120000 " }), 120_000);
  assert.equal(keeperConfig({ OUTLAYER_WAIT_MS: "240000" }, []).outlayerWaitMs, 240_000);
  for (const bad of ["soon", "9999", "600001", "180000.5"]) assert.throws(() => outlayerWaitMs({ OUTLAYER_WAIT_MS: bad }), /OUTLAYER_WAIT_MS must be a whole number of milliseconds from 10000 to 600000/, bad);
  // A gate script's call to the backend outlasts the backend's own wait; a check on the chain and the keeper's
  // "is it running" window outlast a run's 3 minutes too.
  assert.ok(outlayerWaitMs({}) + API_SLACK_MS > DEFAULT_OUTLAYER_WAIT_MS);
  assert.ok(VERDICT_WAIT_MS > DEFAULT_OUTLAYER_WAIT_MS);
  assert.ok(KEEPER_ALIVE_MS > DEFAULT_OUTLAYER_WAIT_MS);
});

test("50.4: a gate waits for the backend as long as the backend may wait for an order: 280 s at least, and 30 s more, whatever OUTLAYER_WAIT_MS says; the keeper's own gateway runs keep their 3 minutes", () => {
  // The backend's default wait is 270 s since 50.4, and an order's run gets its life (240 s at most) and 40 s.
  assert.deepEqual([BACKEND_OUTLAYER_WAIT_MS, BACKEND_ORDER_WAIT_MAX_MS], [270_000, 280_000]);
  assert.equal(backendWaitMs({}), 280_000);
  assert.equal(backendWaitMs({ OUTLAYER_WAIT_MS: "180000" }), 280_000, "set shorter, the backend still waits out an order's life");
  assert.equal(backendWaitMs({ OUTLAYER_WAIT_MS: "400000" }), 400_000);
  assert.equal(backendWaitMs({ OUTLAYER_WAIT_MS: "  " }), 280_000);
  assert.throws(() => backendWaitMs({ OUTLAYER_WAIT_MS: "soon" }), /OUTLAYER_WAIT_MS must be a whole number/);
  // What a gate gives one call to the backend (gate-world.ts): longer than the longest order lives.
  assert.equal(backendWaitMs({}) + API_SLACK_MS, 310_000);
  assert.ok(backendWaitMs({}) + API_SLACK_MS > 230_000 + 40_000);
  // The keeper's own runs carry no signed message and no expiry, and a tick waits for them: unchanged.
  assert.equal(outlayerWaitMs({}), 180_000);
  assert.ok(KEEPER_ALIVE_MS > outlayerWaitMs({}));
});
