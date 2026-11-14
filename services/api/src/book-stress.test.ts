import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { getBookStress } from "./book-stress.js";
import { apiConfig } from "./config.js";
import type { KeeperEvent } from "./drill.js";
import { fakeDeps } from "./fakes.js";

/** pb-risk's `book` output as INTERFACES.md 19 shapes it. */
const RESULT = {
  ok: true, v: 1, mode: "book", blk: 276_900_000, capital: 50_000_000_000, loans: 1_097_000_000,
  accounts: [{ acct: "drill1.pbf.testnet", debt: 1_097_000_000, eq: 1_520_000_000 }],
  worst: { scenario: "replay 2020-03-12 down", pool_loss: 0 }, limit: 1_250_000_000, pass: true,
  top: [{ scenario: "replay 2020-03-12 down", pool_loss: 0 }], in: "ab",
};
const line = (t: string, fields: Record<string, unknown>): KeeperEvent => ({ t, event: "book_stress", msg: "the daily book stress test", ...fields });

test("book stress: the latest attempt, the latest result that worked, and the history, newest first", () => {
  const events = [
    line("2026-11-09T01:00:00.000Z", { ok: true, result: RESULT, call_id: "c1", attestation_url: "https://testnet-api.outlayer.ai/attestations/by-call/c1", time_ms: 6_100, compute_cost: "1200", program: { project_id: "pbf-keeper.testnet/pb-risk", version_key: "5a2a" } }),
    { t: "2026-11-09T02:00:00.000Z", event: "tick", msg: "not a stress line" },
    line("2026-11-10T01:00:00.000Z", { ok: false, result: null, error: "OutLayer answered HTTP 503: OutLayer is busy" }),
  ];
  const answer = getBookStress(fakeDeps({ readBookStress: () => ({ found: true, events }) }).deps);
  assert.equal(answer.log_found, true);
  assert.deepEqual([answer.latest?.t, answer.latest?.ok, answer.latest?.error], ["2026-11-10T01:00:00.000Z", false, "OutLayer answered HTTP 503: OutLayer is busy"]);
  assert.deepEqual(answer.last_result, {
    t: "2026-11-09T01:00:00.000Z", ok: true, result: RESULT, error: null, call_id: "c1",
    attestation_url: "https://testnet-api.outlayer.ai/attestations/by-call/c1", time_ms: 6_100, compute_cost: "1200",
    program: { project_id: "pbf-keeper.testnet/pb-risk", version_key: "5a2a" },
  });
  assert.deepEqual(answer.history.map((h) => [h.ok, h.pass, h.worst_loss, h.limit]), [[false, null, null, null], [true, true, 0, 1_250_000_000]]);
  const refused = getBookStress(fakeDeps({ readBookStress: () => ({ found: true, events: [line("t", { ok: true, result: { ok: false, reason: "more than 10 accounts with loans" } })] }) }).deps);
  assert.deepEqual([refused.latest?.ok, refused.latest?.error, refused.last_result], [false, "more than 10 accounts with loans", null]);
});

test("book stress: read from BOOK_STRESS_LOG_FILE; no file yet is log_found false", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-stress-"));
  const file = join(dir, "book-stress.jsonl");
  writeFileSync(file, `${JSON.stringify(line("2026-11-09T01:00:00.000Z", { ok: true, result: RESULT }))}\n`);
  const config = apiConfig({ BOOK_STRESS_LOG_FILE: file });
  assert.equal(config.bookStressFile, file);
  assert.equal(getBookStress(fakeDeps({ config }).deps).last_result?.result?.pass, true);
  const none = getBookStress(fakeDeps({ config: apiConfig({ BOOK_STRESS_LOG_FILE: join(dir, "none.jsonl") }) }).deps);
  assert.deepEqual([none.log_found, none.latest, none.history], [false, null, []]);
  assert.match(apiConfig({}).bookStressFile, /services\/keeper\/logs\/book-stress\.jsonl$/);
});
