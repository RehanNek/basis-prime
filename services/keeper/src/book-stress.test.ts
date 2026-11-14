import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BookStressJob, PIN_CHECK_MS, STRESS_EVERY_MS, STRESS_INPUT, STRESS_REFUSED_RETRY_MS, STRESS_RETRY_MS, stressHistory, stressWords, type Pin, type StressDeps } from "./book-stress.js";
import { keeperConfig } from "./config.js";
import { JsonLog, readTail, type LogEvent } from "./jsonl.js";
import type { OutLayerRun } from "./outlayer.js";

const T0 = Date.UTC(2026, 10, 10, 12, 0);
const PIN: Pin = { project: "pbf-keeper.testnet/pb-risk", versionKey: "5a2a2a20" };
/** pb-risk's `book` output (INTERFACES.md 19). */
const RESULT = {
  ok: true, v: 1, mode: "book", blk: 276_900_000, capital: 50_000_000_000, loans: 1_097_000_000,
  accounts: [{ acct: "drill1.pbf.testnet", debt: 1_097_000_000, eq: 1_520_000_000 }],
  worst: { scenario: "replay 2020-03-12 down", pool_loss: 12_500_000 }, limit: 1_250_000_000, pass: true,
  top: [{ scenario: "replay 2020-03-12 down", pool_loss: 12_500_000 }], in: "ab",
};

function harness(options: { answers?: (OutLayerRun | Error)[]; pin?: Pin | null; dryRun?: boolean; history?: LogEvent[] } = {}) {
  let now = T0;
  let pin = options.pin === undefined ? PIN : options.pin;
  const runs: { project: string; input: unknown; versionKey: string | undefined }[] = [];
  const recorded: Record<string, unknown>[] = [];
  const said: string[] = [];
  const answers = [...(options.answers ?? [])];
  const deps: StressDeps = {
    pin: async () => pin,
    async run(project, input, versionKey) {
      runs.push({ project, input, versionKey });
      const next = answers.shift() ?? { callId: "c", status: "completed", output: RESULT, error: null, computeCost: "1200", timeMs: 6_000, attestationUrl: "https://testnet-api.outlayer.ai/attestations/by-call/c" };
      if (next instanceof Error) throw next;
      return next;
    },
    record: (event, msg, fields) => recorded.push({ t: new Date(now).toISOString(), event, msg, ...fields }),
    log: (_event, msg) => said.push(msg),
    now: () => now,
    ...(options.dryRun ? { dryRun: true } : {}),
  };
  const job = new BookStressJob(deps, stressHistory(options.history ?? []));
  return { job, runs, recorded, said, advance: (ms: number) => void (now += ms), setPin: (p: Pin | null) => void (pin = p) };
}

test("the book stress test runs at start with no result yet, then once a day, with the version the factory pins", async () => {
  const h = harness();
  const first = await h.job.maybeRun();
  assert.deepEqual(h.runs, [{ project: "pbf-keeper.testnet/pb-risk", input: { mode: "book", network: "testnet" }, versionKey: "5a2a2a20" }]);
  assert.deepEqual(STRESS_INPUT, { mode: "book", network: "testnet" });
  assert.equal(first?.ok, true);
  assert.deepEqual(h.recorded[0], {
    t: new Date(T0).toISOString(),
    event: "book_stress",
    msg: "the book stress test: 1 account(s) with a loan; the worst scenario (replay 2020-03-12 down) loses the pool $12.5 against a limit of $1,250; pass",
    ok: true,
    result: RESULT,
    call_id: "c",
    attestation_url: "https://testnet-api.outlayer.ai/attestations/by-call/c",
    time_ms: 6_000,
    compute_cost: "1200",
    program: { project_id: "pbf-keeper.testnet/pb-risk", version_key: "5a2a2a20" },
  });
  h.advance(STRESS_EVERY_MS - 60_000);
  assert.equal(await h.job.maybeRun(), null, "not a day yet");
  h.advance(60_000);
  assert.equal((await h.job.maybeRun())?.ok, true);
  assert.equal(h.runs.length, 2);
});

test("a failed run is tried again after 15 minutes, a refusal after an hour, and a newly pinned version at once", async () => {
  const h = harness({ answers: [new Error("OutLayer answered HTTP 503: busy"), { callId: "r", status: "completed", output: { ok: false, reason: "unknown mode book" }, error: null, computeCost: "1000", timeMs: 900, attestationUrl: "https://a/r" }] });
  const failed = await h.job.maybeRun();
  assert.deepEqual([failed?.ok, failed?.error], [false, "OutLayer answered HTTP 503: busy"]);
  h.advance(STRESS_RETRY_MS - 1_000);
  assert.equal(await h.job.maybeRun(), null);
  h.advance(1_000);
  const refused = await h.job.maybeRun();
  assert.deepEqual([refused?.ok, refused?.error, refused?.attestation_url], [false, "unknown mode book", "https://a/r"]);
  h.advance(STRESS_REFUSED_RETRY_MS - PIN_CHECK_MS);
  assert.equal(await h.job.maybeRun(), null, "the same version, refused under an hour ago");
  h.setPin({ project: PIN.project, versionKey: "beefcafe" });
  h.advance(PIN_CHECK_MS);
  const deployed = await h.job.maybeRun();
  assert.deepEqual([deployed?.ok, h.runs.at(-1)?.versionKey], [true, "beefcafe"]);
  assert.equal(h.runs.length, 3);
  assert.equal(h.recorded.length, 3, "every attempt is recorded");
});

test("from the file at start: a result under a day old waits; a dry run and a missing pin run nothing", async () => {
  const yesterday: LogEvent = { t: new Date(T0 - 3_600_000).toISOString(), event: "book_stress", msg: "", ok: true, result: RESULT, program: { version_key: "5a2a2a20" } };
  assert.deepEqual(stressHistory([yesterday, { t: "x", event: "book_stress" }]), { lastOkMs: T0 - 3_600_000, lastTryMs: T0 - 3_600_000, lastTry: "ok", lastVersion: "5a2a2a20" });
  const waits = harness({ history: [yesterday] });
  assert.equal(await waits.job.maybeRun(), null);
  assert.equal(waits.runs.length, 0);
  const old = harness({ history: [{ ...yesterday, t: new Date(T0 - STRESS_EVERY_MS - 1).toISOString() }] });
  assert.equal((await old.job.maybeRun())?.ok, true, "more than a day old: it runs at start");

  const dry = harness({ dryRun: true });
  assert.equal(await dry.job.maybeRun(), null);
  assert.equal(dry.runs.length, 0);
  assert.match(dry.said[0]!, /^dry run: the book stress test is due; it would run pbf-keeper\.testnet\/pb-risk 5a2a2a20 in mode book$/);
  const none = harness({ pin: null });
  const failed = await none.job.maybeRun();
  assert.deepEqual([failed?.ok, failed?.error, none.runs.length], [false, "the factory pins no pb-risk of ours, so there is nothing to run", 0]);
});

test("the results file: one JSON line per attempt, read back for the history; BOOK_STRESS_LOG_FILE moves it", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "pb-stress-")), "book-stress.jsonl");
  const out = new JsonLog({ file, out: () => {}, now: () => T0 });
  out.log("book_stress", stressWords(RESULT), { ok: true, result: RESULT, program: { version_key: "5a2a2a20" } });
  const { events } = readTail(file);
  assert.equal(events.length, 1);
  assert.deepEqual(stressHistory(events), { lastOkMs: T0, lastTryMs: T0, lastTry: "ok", lastVersion: "5a2a2a20" });
  assert.equal(stressWords({ ...RESULT, worst: null, accounts: [] }), "the book stress test: 0 account(s) with a loan, nothing at risk; pass");
  assert.equal(stressWords({ ...RESULT, worst: null }), "the book stress test: 1 account(s) with a loan, no scenario costs the pool anything; pass");
  assert.equal(keeperConfig({ BOOK_STRESS_LOG_FILE: file }, []).stressFile, file);
  assert.match(keeperConfig({}, []).stressFile, /services\/keeper\/logs\/book-stress\.jsonl$/);
});
