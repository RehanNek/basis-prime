import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { outputHashOfAnswer, parseRaw, sortedHash, sortedRaw } from "./canonical.js";
import { CREDIT_SHARE_MS, getCreditExample, nbtcUnits, outputHash, parseCreditInput, postCreditCheck, priceMicro, sortedJson } from "./credit.js";
import { fakeChain, fakeDeps, fakeHl, T0 } from "./fakes.js";
import type { OutLayerRun } from "./outlayer.js";
import { HttpError } from "./validate.js";

const ADDRESS = "0x1B242C24F5E67E93D7B58C3DAD77CCC90DACD7D0";
const PIN = { risk: { project_id: "pbf-keeper.testnet/pb-risk", version_key: "5A2A2A20" } };
const RESULT = { ok: true, v: 1, mode: "credit_check", verdict: { credit: { line: 94_500_000_000, binding: "C4" }, tier: "STANDARD", score: 700 } };

function rejectsWith(status: number, code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof HttpError, String(error));
    assert.deepEqual([error.status, error.code], [status, code], error.message);
    return true;
  };
}

/** Deps whose OutLayer answers `output`, with a clock the test moves. */
function world(options: { output?: unknown; attestation?: unknown; factory?: unknown } = {}) {
  let now = T0;
  const runs: { project: string; input: unknown; versionKey: string | undefined }[] = [];
  const read: string[] = [];
  const { chain } = fakeChain({ views: options.factory === undefined ? { "pbf.testnet.get_config": PIN } : options.factory === null ? {} : { "pbf.testnet.get_config": options.factory } });
  const { deps } = fakeDeps({
    chain,
    now: () => now,
    outlayer: {
      async run(project: string, input: unknown, versionKey?: string): Promise<OutLayerRun> {
        runs.push({ project, input, versionKey });
        return { callId: `call-${runs.length}`, status: "completed", output: options.output ?? RESULT, error: null, computeCost: "1100", timeMs: 4_200, attestationUrl: `https://testnet-api.outlayer.ai/attestations/by-call/call-${runs.length}` };
      },
    },
    attestations: async (url: string) => {
      read.push(url);
      return options.attestation ?? null;
    },
  });
  // fakeDeps' limiters read T0; give these the moving clock.
  return { deps, runs, read, advance: (ms: number) => void (now += ms), now: () => now };
}

test("credit input: exactly one of an address and a book; spot tokens by the pool's names; one order for one question", () => {
  assert.deepEqual(parseCreditInput({ hl_address: ` ${ADDRESS} ` }), { hl_address: ADDRESS.toLowerCase(), book: null, spot: [] });
  const book = parseCreditInput({
    book: { usdc: "35000000000", positions: [{ coin: "SOL", usd: "5000000000" }, { coin: "BTC", usd: "-100000000000" }] },
    spot: [{ token: "USDT", amount: "5" }, { token: "nBTC", amount: "132080104" }],
  });
  assert.deepEqual(book.book?.positions.map((p) => p.coin), ["BTC", "SOL"], "positions by coin");
  assert.deepEqual(book.spot.map((s) => s.token), ["nBTC", "USDT"], "spot in the pool's token order");
  assert.equal(book.hl_address, null);

  const bad: [unknown, RegExp][] = [
    [{}, /exactly one/],
    [{ hl_address: ADDRESS, book: { usdc: "0", positions: [] } }, /exactly one/],
    [{ hl_address: "0x12" }, /0x and 40 hex/],
    [{ book: { usdc: "-1", positions: [] } }, /book\.usdc/],
    [{ book: { usdc: "1", positions: [{ coin: "BTC", usd: "0" }] } }, /not 0/],
    [{ book: { usdc: "1", positions: [{ coin: "BTC", usd: "1" }, { coin: "BTC", usd: "2" }] } }, /BTC twice/],
    [{ book: { usdc: "1", positions: [{ coin: "xyz:TSLA", usd: "1" }] } }, /coin name/],
    [{ book: { usdc: "1", positions: [{ coin: "BTC", usd: "-1000000000000001" }] } }, /at most \$1B/],
    [{ hl_address: ADDRESS, spot: [{ token: "SOL", amount: "1" }] }, /one of USDC, nBTC, ETH, USDT, wNEAR/],
    [{ hl_address: ADDRESS, spot: [{ token: "nBTC", amount: "1" }, { token: "nBTC", amount: "2" }] }, /nBTC twice/],
    [{ hl_address: ADDRESS, spot: [{ token: "nBTC", amount: "0" }] }, /positive whole number/],
    [{ hl_address: ADDRESS, spot: Array.from({ length: 6 }, () => ({ token: "USDC", amount: "1" })) }, /at most 5/],
  ];
  for (const [body, why] of bad) assert.throws(() => parseCreditInput(body), why, JSON.stringify(body));
});

test("the sorted form, numbers as written, hashes to OutLayer's output_hash: the Phase 2 snapshot gives the attested a2b074b4...", () => {
  assert.equal(sortedJson({ b: 1, a: [{ d: 2, c: "x" }], u: undefined }), '{"a":[{"c":"x","d":2}],"b":1}');
  assert.equal(sortedRaw(parseRaw(' {"b": 82310.0, "a": [{"d": -2e-7, "c": "x\\"y\\u00e9"}], "z": [true, false, null]} ')), '{"a":[{"c":"x\\"yé","d":-2e-7}],"b":82310.0,"z":[true,false,null]}');
  assert.throws(() => parseRaw("{\"a\":1,}"), /not JSON/);
  // research/data/phase2_first_loan.json: "the output_hash its OutLayer attestation should show: a2b074b4...". The
  // snapshot was saved from OutLayer's HTTPS answer, so it holds floats such as 82310.0, which JSON.parse would lose.
  const text = readFileSync(new URL("../../../research/data/phase2_preview_snapshot.json", import.meta.url), "utf8");
  assert.equal(sortedHash(text), "a2b074b4524ce36680631bd7c010caab38aecefd2b83191b5b8fa59be415c74a");
  assert.notEqual(outputHash(JSON.parse(text)), "a2b074b4524ce36680631bd7c010caab38aecefd2b83191b5b8fa59be415c74a", "a parsed copy loses 82310.0");
  assert.equal(outputHashOfAnswer(`{"call_id":"c","output":${text},"status":"completed"}`), "a2b074b4524ce36680631bd7c010caab38aecefd2b83191b5b8fa59be415c74a");
  assert.equal(outputHashOfAnswer(JSON.stringify({ output: text })), "a2b074b4524ce36680631bd7c010caab38aecefd2b83191b5b8fa59be415c74a", "an output given as a string of JSON");
  assert.equal(outputHashOfAnswer('{"output":null}'), null);
});

test("a credit check runs the pb-risk the factory pins, in credit_check mode on mainnet, and checks the attestation", async () => {
  const sha = outputHash(RESULT);
  const w = world({ attestation: { wasm_hash: "5a2a2a20", output_hash: sha, input_hash: "ab", timestamp: 1794200000 } });
  const answer = await postCreditCheck(w.deps, { hl_address: ADDRESS, spot: [{ token: "nBTC", amount: "132080104" }] }, "203.0.113.9");
  assert.deepEqual(w.runs, [
    {
      project: "pbf-keeper.testnet/pb-risk",
      versionKey: "5A2A2A20",
      input: { mode: "credit_check", network: "mainnet", hl_address: ADDRESS.toLowerCase(), book: null, spot: [{ token: "nBTC", amount: "132080104" }], snapshot: false },
    },
  ]);
  assert.deepEqual(answer.result, RESULT);
  assert.deepEqual(answer.run, { call_id: "call-1", attestation_url: "https://testnet-api.outlayer.ai/attestations/by-call/call-1", time_ms: 4_200, compute_cost: "1100" });
  assert.deepEqual(answer.program, { project_id: "pbf-keeper.testnet/pb-risk", version_key: "5A2A2A20" });
  assert.equal(answer.output_sha256, sha);
  assert.deepEqual(answer.attestation, { found: true, wasm_hash: "5a2a2a20", output_hash: sha, input_hash: "ab", timestamp: 1794200000, wasm_matches: true, output_matches: true, error: null });
  assert.equal(answer.cached, false);

  const other = world({ attestation: { wasm_hash: "ffff", output_hash: "00" } });
  const mismatch = await postCreditCheck(other.deps, { hl_address: ADDRESS }, "c");
  assert.deepEqual([mismatch.attestation.wasm_matches, mismatch.attestation.output_matches], [false, false]);
  const missing = await postCreditCheck(world().deps, { hl_address: ADDRESS }, "c");
  assert.deepEqual([missing.attestation.found, missing.attestation.error], [false, "OutLayer answered no attestation record yet"]);
});

test("the same question within a minute shares one run and one answer, and costs no limit; after a minute it runs again", async () => {
  const w = world();
  const body = { book: { usdc: "35000000000", positions: [{ coin: "BTC", usd: "-100000000000" }] } };
  const [first, second] = await Promise.all([postCreditCheck(w.deps, body, "a"), postCreditCheck(w.deps, body, "b")]);
  assert.equal(w.runs.length, 1, "asked twice at once: one run");
  assert.deepEqual([first.cached, second.cached], [false, true]);
  w.advance(30_000);
  const shared = await postCreditCheck(w.deps, { ...body, spot: [] }, "a");
  assert.deepEqual([shared.cached, shared.age_s, w.runs.length], [true, 30, 1]);
  w.advance(CREDIT_SHARE_MS);
  assert.equal((await postCreditCheck(w.deps, body, "a")).cached, false);
  assert.equal(w.runs.length, 2);
});

test("at most 2 new checks a minute per client address and 6 in all; refused checks make no run", async () => {
  const w = world();
  const ask = (client: string, n: number) => postCreditCheck(w.deps, { hl_address: `0x${n.toString(16).padStart(40, "0")}` }, client);
  await ask("a", 1);
  await ask("a", 2);
  await assert.rejects(ask("a", 3), rejectsWith(429, "too_many_for_you"));
  await ask("b", 4);
  await ask("c", 5);
  await ask("d", 6);
  await ask("e", 7);
  await assert.rejects(ask("f", 8), rejectsWith(429, "too_many_credit_checks"));
  assert.equal(w.runs.length, 6);
  // A repeat of a check already made is free, whoever asks.
  assert.equal((await ask("a", 1)).cached, true);
});

test("credit check errors: no payment key, no factory, another project pinned; pb-risk's refusal is an answer", async () => {
  await assert.rejects(postCreditCheck(fakeDeps({ outlayer: undefined }).deps, { hl_address: ADDRESS }, "a"), rejectsWith(503, "credit_off"));
  const noFactory = world({ factory: null });
  await assert.rejects(postCreditCheck(noFactory.deps, { hl_address: ADDRESS }, "a"), rejectsWith(503, "not_deployed"));
  await assert.rejects(postCreditCheck(noFactory.deps, { hl_address: ADDRESS }, "a"), rejectsWith(503, "not_deployed"), "a failure isn't kept");
  await assert.rejects(postCreditCheck(world({ factory: { risk: { project_id: "someone.testnet/pb-risk", version_key: "1" } } }).deps, { hl_address: ADDRESS }, "a"), rejectsWith(409, "bad_config"));
  const refusal = { ok: false, reason: "unknown mode credit_check" };
  const old = await postCreditCheck(world({ output: refusal }).deps, { hl_address: ADDRESS }, "a");
  assert.deepEqual(old.result, refusal);
  await assert.rejects(postCreditCheck(fakeDeps().deps, { hl_address: "nope" }, "a"), rejectsWith(400, "bad_request"));
});

test("the worked example: $35k of USDC, a $100k BTC short, and $100k of nBTC at Hyperliquid mainnet's BTC oracle price", async () => {
  assert.equal(priceMicro("75711.6"), 75_711_600_000n);
  assert.equal(priceMicro("1e5"), null);
  assert.equal(nbtcUnits(100_000_000_000n, 75_711_600_000n), 132_080_156n, "$100k at $75,711.6 is 1.32080156 nBTC");
  const { hl, infoCalls } = fakeHl({ info: { metaAndAssetCtxs: [{ universe: [{ name: "ETH" }, { name: "BTC" }] }, [{ oraclePx: "2600.1" }, { oraclePx: "75711.6" }]] } });
  const { deps } = fakeDeps({ hlMainnet: hl });
  const example = await getCreditExample(deps);
  assert.deepEqual(example, {
    book: { usdc: "35000000000", positions: [{ coin: "BTC", usd: "-100000000000" }] },
    spot: [{ token: "nBTC", amount: "132080156" }],
    btc_usd: "75711.6",
    price_source: "Hyperliquid mainnet's oracle price",
    read_at_ms: T0,
  });
  await getCreditExample(deps);
  assert.equal(infoCalls.length, 1, "the price is kept for a minute");
  assert.deepEqual(parseCreditInput(example).spot, example.spot, "the example is a valid request");
  await assert.rejects(getCreditExample(fakeDeps({ hlMainnet: fakeHl({ info: { metaAndAssetCtxs: [{ universe: [] }, []] } }).hl }).deps), rejectsWith(502, "hyperliquid"));
});
