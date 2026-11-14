// How OutLayer is answering, from the backend's own runs (INTERFACES.md 51.15).
import assert from "node:assert/strict";
import { test } from "node:test";

import { HEALTH_WINDOW_MS, healthOf, isNoAnswer, noHealth, OutLayerWatch, SLOW_SECONDS, watched, type RunNote } from "./outlayer-health.js";
import { OutLayerError, type OutLayerRun } from "./outlayer.js";

const T0 = 1_794_680_000_000;
/** A run that ended `agoS` seconds ago after `tookS` seconds. */
const ran = (agoS: number, tookS: number, answered = true): RunNote => ({ startedMs: T0 - (agoS + tookS) * 1000, endedMs: T0 - agoS * 1000, answered });
const waiting = (forS: number): RunNote => ({ startedMs: T0 - forS * 1000, endedMs: null, answered: null });
const RUN: OutLayerRun = { callId: "c", status: "completed", output: {}, error: null, computeCost: null, timeMs: 800, attestationUrl: null };

test("with no run in the last quarter of an hour there is nothing to say", () => {
  assert.deepEqual([HEALTH_WINDOW_MS, SLOW_SECONDS], [900_000, 60]);
  assert.equal(healthOf([], T0).state, "unknown");
  assert.equal(noHealth(T0).state, "unknown");
  const old = healthOf([ran(16 * 60, 12)], T0);
  assert.deepEqual([old.state, old.runs, old.last_seconds], ["unknown", 0, null]);
  assert.equal(old.last_answer_ms, T0 - 16 * 60_000, "when it last answered is still known");
});

test("a good hour: runs of 5 to 20 seconds", () => {
  const h = healthOf([ran(300, 14), ran(120, 9), ran(20, 13)], T0);
  assert.deepEqual(h, { state: "ok", window_s: 900, runs: 3, unanswered: 0, last_seconds: 13, last_answered: true, last_answer_ms: T0 - 20_000, waiting_s: null, read_at_ms: T0 });
  // A run just sent is nothing to remark on.
  assert.equal(healthOf([ran(20, 13), waiting(8)], T0).state, "ok");
  // One slow run in the middle of good ones: the latest and the middle one are both quick.
  assert.equal(healthOf([ran(400, 9), ran(200, 137), ran(20, 13), ran(5, 11)], T0).state, "ok");
});

test("slow: the hosted backend on 14 Nov, 17:19 to 17:26 UTC, three runs of 97 to 137 seconds", () => {
  const h = healthOf([ran(600, 132), ran(380, 97), ran(240, 137)], T0);
  assert.deepEqual([h.state, h.runs, h.unanswered, h.last_seconds, h.last_answered], ["slow", 3, 0, 137, true]);
  // The latest alone took over a minute.
  assert.equal(healthOf([ran(300, 12), ran(100, 9), ran(10, 61)], T0).state, "slow");
  assert.equal(healthOf([ran(10, 60)], T0).state, "ok", "a minute exactly is not yet slow");
  // A run still waiting after more than a minute, though the last ones were quick.
  const still = healthOf([ran(300, 12), ran(100, 9), waiting(95)], T0);
  assert.deepEqual([still.state, still.waiting_s], ["slow", 95]);
  // The latest got no answer, but one before it did.
  const mixed = healthOf([ran(500, 14), ran(300, 137), ran(30, 301, false)], T0);
  assert.deepEqual([mixed.state, mixed.unanswered, mixed.last_answered], ["slow", 1, false]);
});

test("down: the last runs all got no answer", () => {
  // 17:28 UTC: a check that got no answer in 301 seconds, with nothing answered since.
  const one = healthOf([ran(60, 301, false)], T0);
  assert.deepEqual([one.state, one.runs, one.unanswered, one.last_seconds, one.last_answer_ms], ["down", 1, 1, 301, null]);
  const three = healthOf([ran(700, 12), ran(500, 270, false), ran(300, 270, false), ran(40, 301, false)], T0);
  assert.deepEqual([three.state, three.unanswered, three.last_answer_ms], ["down", 3, T0 - 700_000]);
  // One answer brings it back, slow if that answer was.
  assert.equal(healthOf([ran(500, 270, false), ran(300, 270, false), ran(40, 301, false), ran(5, 12)], T0).state, "slow", "two of the last three still got none");
  assert.equal(healthOf([ran(300, 270, false), ran(100, 14), ran(40, 9), ran(5, 12)], T0).state, "ok");
});

test("a refused payment key says nothing about OutLayer; anything else that fails is no answer", () => {
  assert.equal(isNoAnswer(new OutLayerError(504, "OutLayer did not answer")), true);
  assert.equal(isNoAnswer(new OutLayerError(500, "OutLayer failed")), true);
  assert.equal(isNoAnswer(new Error("fetch failed")), true);
  for (const status of [401, 402, 403]) assert.equal(isNoAnswer(new OutLayerError(status, "the payment key was refused")), false);
});

test("the client with every run timed: an answer, no answer, and a refused key", async () => {
  let now = T0;
  const watch = new OutLayerWatch(() => now);
  const plan: (OutLayerRun | Error)[] = [RUN, new OutLayerError(504, "OutLayer did not answer"), new OutLayerError(402, "the payment key has run out of credit")];
  const calls: unknown[][] = [];
  const client = watched(
    {
      async run(...args: unknown[]) {
        calls.push(args);
        now += 137_000;
        const next = plan.shift()!;
        if (next instanceof Error) throw next;
        return next;
      },
    },
    watch,
  );
  assert.equal(watch.health().state, "unknown");
  // The answer is passed on as it is, and so are the arguments.
  assert.equal(await client.run("pbf-keeper.testnet/pb-risk", { a: 1 }, "9149e09b", { waitMs: 5 }), RUN);
  assert.deepEqual(calls[0], ["pbf-keeper.testnet/pb-risk", { a: 1 }, "9149e09b", { waitMs: 5 }]);
  assert.deepEqual([watch.health().state, watch.health().last_seconds], ["slow", 137]);
  // No answer is thrown on to the caller, and counted.
  await assert.rejects(client.run("p", {}), /did not answer/);
  assert.deepEqual([watch.health().state, watch.health().runs, watch.health().unanswered], ["slow", 2, 1]);
  // Our own key refused: thrown on, and not counted against OutLayer.
  await assert.rejects(client.run("p", {}), /run out of credit/);
  assert.deepEqual([watch.health().runs, watch.health().unanswered, watch.health().waiting_s], [2, 1, null]);
});
