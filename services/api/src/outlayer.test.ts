import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { fakeFetch } from "./fakes.js";
import { COMPUTE_LIMIT_MICRO_USD, DEFAULT_OUTLAYER_WAIT_MS, OUTLAYER_POLL_MS, OutLayerClient, OutLayerError, RESOURCE_LIMITS } from "./outlayer.js";

const KEY = `pbf-keeper.testnet:1:${"ab".repeat(32)}`;
const INPUT = { mode: "preview", account: "alice.pbf.testnet", intent: { check: {} }, network: "testnet", snapshot: false };
const COMPLETED = {
  call_id: "0a57",
  status: "completed",
  output: { ok: true, state: "HEALTHY" },
  compute_cost: "1000",
  instructions: 226668,
  time_ms: 764,
  attestation_url: "/attestations/by-call/0a57",
};
/** What the submit answers at once, and what a poll answers while the run waits its turn (read live on 11 Nov). */
const SUBMITTED = { call_id: "0a57", status: "pending", poll_url: "/calls/0a57", attestation_url: "/attestations/by-call/0a57" };
const PENDING = { call_id: "0a57", status: "pending", attestation_url: "/attestations/by-call/0a57" };
const noSleep = async () => {};
/** What the caller of a run gets: the same for a run that ended at once and for one that was asked about. */
const RUN = {
  callId: "0a57",
  status: "completed",
  output: { ok: true, state: "HEALTHY" },
  error: null,
  computeCost: "1000",
  timeMs: 764,
  attestationUrl: "https://testnet-api.outlayer.ai/attestations/by-call/0a57",
  // Phase 5: SHA-256 of '{"ok":true,"state":"HEALTHY"}', the output in sorted form, read from the answer's own text.
  outputSha256: createHash("sha256").update('{"ok":true,"state":"HEALTHY"}').digest("hex"),
};

/** A clock that only moves when the client sleeps, so a 3-minute wait takes no time. */
function fakeClock() {
  let at = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => at,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      at += ms;
    },
  };
}

test("run() posts to /call/<owner>/<project> with the key, the compute limit, the input as an object, async: true and the limits", async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: COMPLETED });
  const client = new OutLayerClient({ apiUrl: "https://testnet-api.outlayer.ai/", paymentKey: KEY, fetch: impl, sleep: noSleep });

  const run = await client.run("pbf-keeper.testnet/pb-risk", INPUT, "3f89e644");

  assert.equal(calls[0]?.url, "https://testnet-api.outlayer.ai/call/pbf-keeper.testnet/pb-risk");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.headers["X-Payment-Key"], KEY);
  assert.equal(calls[0]?.headers["X-Compute-Limit"], String(COMPUTE_LIMIT_MICRO_USD));
  assert.deepEqual(calls[0]?.body, { input: INPUT, async: true, resource_limits: RESOURCE_LIMITS, version_key: "3f89e644" });
  assert.deepEqual(RESOURCE_LIMITS, { max_instructions: 2_000_000_000, max_memory_mb: 256, max_execution_seconds: 20 });

  // A submit that answers with the run's end already is the end: nothing is asked about.
  assert.equal(calls.length, 1);
  assert.deepEqual(run, RUN);
});

test("a run that waits its turn is asked about every 2 s until it ends, and the caller gets what a call that waited gave", async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: SUBMITTED }, { status: 200, body: PENDING }, { status: 200, body: PENDING }, { status: 200, body: COMPLETED });
  const clock = fakeClock();
  const client = new OutLayerClient({ apiUrl: "https://testnet-api.outlayer.ai/", paymentKey: KEY, fetch: impl, sleep: clock.sleep, now: clock.now });

  const run = await client.run("pbf-keeper.testnet/pb-risk", INPUT, "3f89e644");

  assert.deepEqual(run, RUN);
  assert.deepEqual(clock.sleeps, [OUTLAYER_POLL_MS, OUTLAYER_POLL_MS, OUTLAYER_POLL_MS]);
  assert.equal(OUTLAYER_POLL_MS, 2_000);
  assert.equal(calls.length, 4);
  for (const poll of calls.slice(1)) {
    assert.equal(poll.url, "https://testnet-api.outlayer.ai/calls/0a57", "the submit's own poll_url, on the API's host");
    assert.equal(poll.method, "GET");
    assert.equal(poll.headers["X-Payment-Key"], KEY, "the same key that submitted it");
    assert.equal("X-Compute-Limit" in poll.headers, false);
    assert.equal(poll.body, undefined);
  }
});

test("without a poll_url the run is asked about at /calls/<id>", async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { call_id: "0a57", status: "pending" } }, { status: 200, body: COMPLETED });
  const run = await new OutLayerClient({ apiUrl: "https://o.example/", paymentKey: KEY, fetch: impl, sleep: noSleep }).run("a.testnet/b", INPUT);
  assert.equal(calls[1]?.url, "https://o.example/calls/0a57");
  assert.equal(run.attestationUrl, "https://o.example/attestations/by-call/0a57");
});

test("a run that ends without completing comes back as its status and error, as it did before", async () => {
  const failedRun = { call_id: "0a57", status: "failed", error: "execution timed out after 20 s", attestation_url: "/attestations/by-call/0a57" };
  const { impl } = fakeFetch({ status: 200, body: SUBMITTED }, { status: 200, body: PENDING }, { status: 200, body: failedRun });
  const run = await new OutLayerClient({ apiUrl: "https://o.example", paymentKey: KEY, fetch: impl, sleep: noSleep }).run("a.testnet/b", INPUT);
  assert.deepEqual([run.status, run.error, run.output, run.callId], ["failed", "execution timed out after 20 s", null, "0a57"]);
  assert.equal(run.outputSha256, null, "no output, so nothing to hash");
});

test("a run that never ends is given OUTLAYER_WAIT_MS (270 s unless set, so an order signed for 230 s is waited out), then reported as OutLayer not answering, with its call id", async () => {
  // Every question about the run gets `pending`.
  let asked = 0;
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "GET") asked += 1;
    return new Response(JSON.stringify(init?.method === "GET" ? PENDING : SUBMITTED), { status: 200 });
  }) as typeof fetch;
  const clock = fakeClock();
  const client = new OutLayerClient({ apiUrl: "https://o.example", paymentKey: KEY, fetch: impl, sleep: clock.sleep, now: clock.now });

  await assert.rejects(client.run("a.testnet/b", INPUT), (error: unknown) => {
    assert.ok(error instanceof OutLayerError);
    assert.equal(error.status, 504, "the status the order route reads as: its fate is unknown");
    assert.equal(error.message, "OutLayer did not answer: the run was still waiting its turn after 270 s (call 0a57). It may still run");
    return true;
  });
  // INTERFACES.md 50.4: 180 s before. An order's 230 s, and 40 s for a run that gets its turn at the last moment.
  assert.equal(DEFAULT_OUTLAYER_WAIT_MS, 270_000);
  assert.equal(asked, 135, "every 2 s for 270 s");

  // The setting: a shorter wait gives up sooner.
  const short = fakeClock();
  asked = 0;
  await assert.rejects(new OutLayerClient({ apiUrl: "https://o.example", paymentKey: KEY, fetch: impl, sleep: short.sleep, now: short.now, waitMs: 20_000 }).run("a.testnet/b", INPUT), /still waiting its turn after 20 s/);
  assert.equal(asked, 10);
});

test("50.4: one run can be given its own wait, longer or shorter than the client's: an order's run is waited for to the end of its life whatever OUTLAYER_WAIT_MS says", async () => {
  let asked = 0;
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "GET") asked += 1;
    return new Response(JSON.stringify(init?.method === "GET" ? PENDING : SUBMITTED), { status: 200 });
  }) as typeof fetch;
  // The client is set to 3 minutes, as before 50.4; this run is given 270 s.
  const long = fakeClock();
  const client = new OutLayerClient({ apiUrl: "https://o.example", paymentKey: KEY, fetch: impl, sleep: long.sleep, now: long.now, waitMs: 180_000 });
  await assert.rejects(client.run("a.testnet/b", INPUT, undefined, { waitMs: 270_000 }), /still waiting its turn after 270 s/);
  assert.equal(asked, 135);
  // Without one, the client's own stands.
  asked = 0;
  const plain = fakeClock();
  await assert.rejects(new OutLayerClient({ apiUrl: "https://o.example", paymentKey: KEY, fetch: impl, sleep: plain.sleep, now: plain.now, waitMs: 180_000 }).run("a.testnet/b", INPUT, "c0ffee"), /still waiting its turn after 180 s/);
  assert.equal(asked, 90);
});

test("a question about the run that fails is only a miss: the run goes on, and the client asks again", async () => {
  const answers: (() => Response)[] = [
    () => new Response(JSON.stringify(SUBMITTED), { status: 200 }),
    () => new Response(JSON.stringify({ error: "Call not found", reason: "call_not_found" }), { status: 404 }),
    () => {
      throw new TypeError("fetch failed");
    },
    () => new Response("<html>bad gateway</html>", { status: 502 }),
    () => new Response("not json", { status: 200 }),
    () => new Response(JSON.stringify(COMPLETED), { status: 200 }),
  ];
  let sent = 0;
  const impl = (async () => answers[sent++]!()) as unknown as typeof fetch;
  const run = await new OutLayerClient({ apiUrl: "https://testnet-api.outlayer.ai", paymentKey: KEY, fetch: impl, sleep: noSleep }).run("a.testnet/b", INPUT);
  assert.deepEqual(run, RUN);
  assert.equal(sent, 6);

  // When the time runs out on misses, the words say what the last one was.
  const lost = (async (_url: string | URL | Request, init?: RequestInit) =>
    init?.method === "GET" ? new Response(JSON.stringify({ error: "Call not found", reason: "call_not_found" }), { status: 404 }) : new Response(JSON.stringify(SUBMITTED), { status: 200 })) as typeof fetch;
  const clock = fakeClock();
  await assert.rejects(
    new OutLayerClient({ apiUrl: "https://o.example", paymentKey: KEY, fetch: lost, sleep: clock.sleep, now: clock.now, waitMs: 10_000 }).run("a.testnet/b", INPUT),
    /^OutLayerError: OutLayer did not answer: the run was still waiting its turn after 10 s \(call 0a57; the last time it was asked about, OutLayer answered HTTP 404 \(it doesn't know the call\)\)\. It may still run$/,
  );
});

test("the key refused while the run is asked about ends it at once, in the words a refused submit has", async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: SUBMITTED }, { status: 401, body: { error: "Missing X-Payment-Key header", reason: "missing_payment_key" } }, { status: 200, body: COMPLETED });
  await assert.rejects(new OutLayerClient({ apiUrl: "https://o.example", paymentKey: KEY, fetch: impl, sleep: noSleep }).run("a.testnet/b", INPUT), (error: unknown) => {
    assert.ok(error instanceof OutLayerError);
    assert.equal(error.status, 401);
    assert.equal(error.message, "OutLayer answered HTTP 401: the payment key was refused (Missing X-Payment-Key header)");
    return true;
  });
  assert.equal(calls.length, 2);
});

test("a submit that says pending but gives no call id can't be asked about", async () => {
  const { impl } = fakeFetch({ status: 200, body: { status: "pending" } });
  await assert.rejects(new OutLayerClient({ apiUrl: "https://o.example", paymentKey: KEY, fetch: impl, sleep: noSleep }).run("a.testnet/b", INPUT), (error: unknown) => {
    assert.ok(error instanceof OutLayerError);
    assert.equal(error.status, 502);
    assert.match(error.message, /gave no call id/);
    return true;
  });
});

test("without a version key the body leaves it out; output given as JSON text is parsed", async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { ...COMPLETED, output: '{"ok":false,"reason":"no such account"}' } });
  const run = await new OutLayerClient({ apiUrl: "https://o.example", paymentKey: KEY, fetch: impl }).run("p.testnet/pb-risk", INPUT);
  assert.equal("version_key" in (calls[0]?.body as object), false);
  assert.deepEqual(run.output, { ok: false, reason: "no such account" });
});

test("503 on the submit is retried once; 500 is not, because the run may already have been charged", async () => {
  const busy = fakeFetch({ status: 503, body: { error: "busy" } }, { status: 200, body: SUBMITTED }, { status: 200, body: COMPLETED });
  const run = await new OutLayerClient({ apiUrl: "https://o.example", paymentKey: KEY, fetch: busy.impl, sleep: noSleep }).run("a.testnet/b", INPUT);
  assert.equal(run.status, "completed");
  assert.deepEqual(busy.calls.map((c) => c.method), ["POST", "POST", "GET"]);

  // Busy twice: the second 503 is the answer, in the same words as before.
  const stillBusy = fakeFetch({ status: 503, body: { error: "busy" } }, { status: 503, body: { error: "busy" } }, { status: 200, body: COMPLETED });
  await assert.rejects(new OutLayerClient({ apiUrl: "https://o.example", paymentKey: KEY, fetch: stillBusy.impl, sleep: noSleep }).run("a.testnet/b", INPUT), /HTTP 503: OutLayer is busy; try again in a moment \(busy\)/);
  assert.equal(stillBusy.calls.length, 2);

  const failed = fakeFetch({ status: 500, body: { error: "worker crashed" } }, { status: 200, body: COMPLETED });
  await assert.rejects(
    new OutLayerClient({ apiUrl: "https://o.example", paymentKey: KEY, fetch: failed.impl, sleep: noSleep }).run("a.testnet/b", INPUT),
    (error: unknown) => {
      assert.ok(error instanceof OutLayerError);
      assert.equal(error.status, 500);
      assert.match(error.message, /may still have happened and been charged \(worker crashed\)/);
      return true;
    },
  );
  assert.equal(failed.calls.length, 1);
});

test("a submit that gets no answer is OutLayer not answering, as before", async () => {
  const impl = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  await assert.rejects(new OutLayerClient({ apiUrl: "https://o.example", paymentKey: KEY, fetch: impl, sleep: noSleep }).run("a.testnet/b", INPUT), (error: unknown) => {
    assert.ok(error instanceof OutLayerError);
    assert.equal(error.status, 504);
    assert.equal(error.message, "OutLayer did not answer: fetch failed");
    return true;
  });
});

test("an error that echoes the payment key never carries it on, from the submit or from a question about the run", async () => {
  const secret = KEY.split(":")[2]!;
  const { impl } = fakeFetch({ status: 401, body: { message: `invalid key ${KEY} (secret ${secret})` } });
  await assert.rejects(new OutLayerClient({ apiUrl: "https://o.example", paymentKey: KEY, fetch: impl }).run("a.testnet/b", INPUT), (error: unknown) => {
    assert.ok(error instanceof OutLayerError);
    assert.ok(!error.message.includes(secret), error.message);
    assert.match(error.message, /HTTP 401: the payment key was refused \(invalid key <payment key> \(secret <payment key>\)\)/);
    return true;
  });

  const polled = fakeFetch({ status: 200, body: SUBMITTED }, { status: 403, body: { message: `key ${KEY} may not` } });
  await assert.rejects(new OutLayerClient({ apiUrl: "https://o.example", paymentKey: KEY, fetch: polled.impl, sleep: noSleep }).run("a.testnet/b", INPUT), (error: unknown) => {
    assert.ok(error instanceof OutLayerError);
    assert.ok(!error.message.includes(secret), error.message);
    assert.match(error.message, /HTTP 403: the payment key may not run this project \(key <payment key> may not\)/);
    return true;
  });
});
