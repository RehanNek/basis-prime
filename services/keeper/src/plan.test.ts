import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AccountLister } from "./accounts.js";
import { bandLevels, bigMoves, crossings, sidesOf } from "./bands.js";
import { JsonLog, readTail } from "./jsonl.js";
import { eventsIn, stepStalled, txResult } from "./near-tx.js";
import { attestationByTx, OutLayerRunner, readGatewayAnswer } from "./outlayer.js";
import { FUNDING_KINDS, isOverdue, nsToMs, pendingLender, pendingTransfers, readExt, readFunding, readPlan } from "./plan.js";

test("Phase 6: a lender action under way is read from get_state's pending, beside the borrows and transfers", () => {
  const lender = { lender: "rhea", kind: "borrow", amount: "570000000", until_block: 276_800_143 };
  const transfer = { transfer: { id: "move:7", kind: "to_hl", token: "musdc.pbf-ops.testnet", amount: "11000000", dep: "ab".repeat(32), deadline: "1" } };
  const read = { lender: "rhea", kind: "borrow", amount: "570000000", untilBlock: 276_800_143 };
  assert.deepEqual(pendingLender([{ borrow: { amount: "5" } }, transfer, { lender }]), read);
  assert.deepEqual(pendingLender({ lender }), read, "pending as an object with a lender field reads the same");
  assert.deepEqual(pendingLender([{ lender: { ...lender, kind: "withdraw", until_block: "276800143" } }])!.kind, "withdraw");
  assert.equal(pendingTransfers([transfer, { lender }]).length, 1, "and it is not a transfer");
  for (const none of [undefined, null, [], [transfer], [{ lender: null }], [{ lender: { lender: "rhea" } }], "x"]) assert.equal(pendingLender(none), null);
});

test("the stored plan: who runs each step, and the step in words", () => {
  const plan = readPlan({
    plan: {
      pid: "276800123",
      action: "DELEVERAGE",
      stored_at: "1794300000000000000",
      steps: [
        { k: "cancel", done: false },
        { k: "repay", amt: 10_000_000, done: true },
        { k: "perp", coin: "BTC", buy: true, sz: "0.00375", px: "76190", done: false },
        { k: "sell", tok: "mnbtc.pbf-ops.testnet", amt: "100000", min: 70_000_000, dep: "ab".repeat(32), exp: 1_794_300_600_000, done: false },
        { k: "home", amt: 5_000_000, dep: "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d", exp: "1794300600000", done: false },
      ],
    },
  })!;
  assert.equal(plan.pid, "276800123");
  assert.equal(plan.storedAtMs, 1_794_300_000_000);
  assert.deepEqual(plan.steps.map((s) => [s.i, s.k, s.runner, s.done, s.exp ?? null]), [
    [0, "cancel", "gateway", false, null],
    [1, "repay", "execute_step", true, null],
    [2, "perp", "gateway", false, null],
    [3, "sell", "execute_step", false, 1_794_300_600_000],
    [4, "home", "execute_step", false, 1_794_300_600_000],
  ]);
  assert.deepEqual(plan.steps.map((s) => s.text), [
    "cancel the resting orders that add risk",
    "repay $10.00 to the pool from the account's USDC",
    "buy 0.00375 BTC at 76190, reduce-only, at once or not at all",
    "sell 100000 units of mnbtc.pbf-ops.testnet through 1Click for at least $70.00",
    "bring $5.00 of USDC home from Hyperliquid",
  ]);
  // An account made before Phase 4 keeps its plan in words.
  const old = readPlan({ deleverage: { confirmed_plan: { at: "5000000", blk: 99, steps: ["buy back 0.3194 BTC of the short"] } } })!;
  assert.deepEqual([old.pid, old.source, old.steps[0]!.runner, old.steps[0]!.text], ["99", "confirmed_plan", "words", "buy back 0.3194 BTC of the short"]);
  assert.equal(readPlan({ plan: null, deleverage: { confirmed_plan: null } }), null);
});

test("pending transfers: the transfer entries only, with their deadline; overdue once it has passed", () => {
  const list = pendingTransfers([
    { borrow: { amount: "5" } },
    { transfer: { id: "276800123:1", kind: "sell", token: "mnbtc.pbf-ops.testnet", amount: "100000", dep: "ab".repeat(32), deadline: "1794302400000000000" } },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.deadlineMs, 1_794_302_400_000);
  assert.equal(isOverdue(list[0]!, 1_794_302_400_000), false);
  assert.equal(isOverdue(list[0]!, 1_794_302_400_001), true);
  assert.deepEqual(pendingTransfers(undefined), []);
  assert.equal(nsToMs("0"), null);
});

test("bands: levels by kind, sides, crossings and big moves", () => {
  const levels = bandLevels({ BTC: { hl50: 101_781_826_406, im: 104_195_000_000 }, nBTC: { im_bp: 8_309, mr_bp: 7_914, dl_bp: 7_574 }, ETH: { odd: 1, mr: "x" } });
  assert.deepEqual(levels.map((l) => [l.id, l.kind, l.level]), [
    ["BTC.hl50", "price", 101_781.826406],
    ["BTC.im", "price", 104_195],
    ["nBTC.im_bp", "pi", 8_309],
    ["nBTC.mr_bp", "pi", 7_914],
    ["nBTC.dl_bp", "pi", 7_574],
  ]);
  const before = sidesOf(levels, { marks: { BTC: 76_000 }, pi: { nBTC: 10_000 } });
  assert.deepEqual(before, { "BTC.hl50": "below", "BTC.im": "below", "nBTC.im_bp": "above", "nBTC.mr_bp": "above", "nBTC.dl_bp": "above" });
  const crossed = crossings(levels, before, { marks: { BTC: 76_000 }, pi: { nBTC: 7_900 } });
  assert.deepEqual(crossed.map((c) => c.level.id), ["nBTC.im_bp", "nBTC.mr_bp"], "one jump can cross two bands");
  assert.deepEqual(crossings(levels, before, { marks: {}, pi: {} }), [], "no price, no crossing");
  const moves = bigMoves({ perps: ["SOL"], tokens: ["nBTC"] }, levels, { marks: { SOL: 100 }, pi: { nBTC: 10_000 } }, { marks: { SOL: 94 }, pi: { nBTC: 9_000 } }, []);
  assert.deepEqual(moves.map((m) => m.asset), ["price:SOL"], "nBTC has bands; SOL moved 6% with none");
});

test("pb-gateway's answers: P0, READ and HL are tried again; other refusals ask for a new plan", () => {
  assert.deepEqual(readGatewayAnswer({ ok: true, placed: [] }), { ok: true, retry: false, replan: false, code: null, reason: null });
  assert.deepEqual(readGatewayAnswer({ ok: false, code: "P0", reason: "another order is in flight" }), { ok: false, retry: true, replan: false, code: "P0", reason: "another order is in flight" });
  assert.deepEqual(readGatewayAnswer({ ok: false, code: "P2", reason: "px left the band" }).replan, true);
  assert.equal(readGatewayAnswer(null).reason, "no answer");
  // deleverage answers ok:true and lists the steps it refused (INTERFACES.md 16, as built).
  const p2 = { ok: true, pid: "9", placed: [], refused: [{ i: 1, k: "perp", code: "P2", reason: "px 80000 has left BTC's 1% band around 75999.99: ask for a new verdict" }] };
  assert.deepEqual(readGatewayAnswer(p2), { ok: false, retry: false, replan: true, code: "P2", reason: "px 80000 has left BTC's 1% band around 75999.99: ask for a new verdict" });
  assert.deepEqual(readGatewayAnswer({ ok: true, refused: [{ i: 1, k: "perp", code: "HL", reason: "no answer" }] }).retry, true, "Hyperliquid refused: a later run may try again");
});

test("OutLayer: the keeper's run is the backend's request, the payment key never shows, and an on-chain run's attestation is by tx", async () => {
  const sent: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    if (sent.length === 1) return new Response(JSON.stringify({ call_id: "c1", status: "completed", output: '{"ok":true,"acct":"a.pbf.testnet"}', attestation_url: "/attestations/by-call/c1" }), { status: 200 });
    return new Response("bad key owner:1:supersecretsupersecret", { status: 401 });
  }) as typeof fetch;
  const runner = new OutLayerRunner({ apiUrl: "https://testnet-api.outlayer.ai/", paymentKey: "owner:1:supersecretsupersecret", fetch: fetchImpl });
  const run = await runner.run("pbf-keeper.testnet/pb-gateway", { mode: "deleverage", account: "a.pbf.testnet", network: "testnet" }, "fcae60");
  assert.equal(sent[0]!.url, "https://testnet-api.outlayer.ai/call/pbf-keeper.testnet/pb-gateway");
  assert.equal(sent[0]!.headers["X-Payment-Key"], "owner:1:supersecretsupersecret");
  assert.deepEqual(sent[0]!.body, { input: { mode: "deleverage", account: "a.pbf.testnet", network: "testnet" }, async: true, resource_limits: { max_instructions: 2_000_000_000, max_memory_mb: 256, max_execution_seconds: 20 }, version_key: "fcae60" });
  assert.deepEqual([run.callId, run.output, run.attestationUrl], ["c1", { ok: true, acct: "a.pbf.testnet" }, "https://testnet-api.outlayer.ai/attestations/by-call/c1"]);
  await assert.rejects(runner.run("p/q", {}), (error: Error) => !error.message.includes("supersecret") && /HTTP 401/.test(error.message));
  assert.equal(attestationByTx("https://testnet-api.outlayer.ai/", "A9aR"), "https://testnet-api.outlayer.ai/attestations/by-tx/A9aR");
});

test("the JSON-lines log: each event one line, in the file and out; the file read back from its tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-keeper-"));
  const file = join(dir, "logs", "keeper.jsonl");
  const out: string[] = [];
  const { log } = new JsonLog({ file, out: (l) => out.push(l), now: () => Date.UTC(2026, 10, 10) });
  log("check", "asked for a check", { account: "a.pbf.testnet", tx: "H1", amount: 5n });
  log("tick", "1 client account(s) to look at");
  assert.equal(out[0], '{"t":"2026-11-10T00:00:00.000Z","event":"check","msg":"asked for a check","account":"a.pbf.testnet","tx":"H1","amount":"5"}');
  writeFileSync(join(dir, "noise.jsonl"), "not json\n");
  assert.deepEqual(readTail(file).events.map((e) => e.event), ["check", "tick"]);
  assert.deepEqual(readTail(join(dir, "noise.jsonl")).events, []);
  assert.deepEqual(readTail(join(dir, "missing.jsonl")), { found: false, events: [] });
  assert.deepEqual(readTail(file, 100).events.map((e) => e.event), ["tick"], "a cut first line is dropped");
});

test("the factory's accounts, a page of 100 at a time, read again after a minute", async () => {
  let now = 0;
  const calls: unknown[] = [];
  const all = Array.from({ length: 150 }, (_, i) => ({ account_id: `a${i}.pbf.testnet` }));
  const lister = new AccountLister(
    { viewOrNull: async <T extends object>(_c: string, _m: string, args?: Record<string, unknown>) => (calls.push(args), all.slice(Number(args!.from_index), Number(args!.from_index) + Number(args!.limit)) as unknown as T) },
    "pbf.testnet",
    60_000,
    () => now,
  );
  assert.equal((await lister.list()).length, 150);
  assert.deepEqual(calls, [{ from_index: 0, limit: 100 }, { from_index: 100, limit: 100 }]);
  await lister.list();
  assert.equal(calls.length, 2, "kept for a minute");
  now = 60_000;
  await lister.list();
  assert.equal(calls.length, 4);
});

test("a transaction outcome as a record: failure words, the return value, logs and events", () => {
  const ok = txResult("execute_step", {
    transaction: { hash: "H" },
    transaction_outcome: { outcome: { gas_burnt: 2e12 } },
    status: { SuccessValue: Buffer.from('{"accepted":true}').toString("base64") },
    receipts_outcome: [{ outcome: { executor_id: "a.pbf.testnet", gas_burnt: 3e12, logs: ['EVENT_JSON:{"standard":"pb","version":"1.0.0","event":"step_run","data":[{"pid":"1","i":0,"k":"repay"}]}'], status: {} } }],
  }, 3.04);
  assert.deepEqual([ok.ok, ok.hash, ok.gas_tgas, ok.result, ok.seconds], [true, "H", 5, { accepted: true }, 3]);
  assert.deepEqual(eventsIn(ok.logs), [{ event: "step_run", data: [{ pid: "1", i: 0, k: "repay" }] }]);
  const failed = txResult("execute_step", { transaction: { hash: "F" }, status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: the step is done" } } } } } }, 1);
  assert.deepEqual([failed.ok, failed.failure], [false, "Smart contract panicked: the step is done"]);
});

test("a step whose transaction went through but moved nothing: the account's own words when it reopened the step, else what execute_step returned", () => {
  const tx = (result: unknown, logs: string[] = []) => ({ ok: true, result, logs });
  const reopened = "step 1 of plan f5011 didn't go out, as Rhea refused it: nothing was borrowed, and it may run again";
  assert.equal(stepStalled("l_borrow", tx(false, ["a log", reopened])), reopened);
  assert.equal(stepStalled("l_supply", tx(true, ["step 0 of plan f5011 didn't go out: Rhea took no collateral, and it may run again"])), "step 0 of plan f5011 didn't go out: Rhea took no collateral, and it may run again");
  assert.equal(stepStalled("p_borrow", tx(false)), "nothing moved (execute_step returned false): the step may run again");
  assert.equal(stepStalled("repay", tx("0")), 'nothing moved (execute_step returned "0"): the step may run again');
  assert.equal(stepStalled("l_repay", tx("0")), 'nothing moved (execute_step returned "0"): the step may run again');
  assert.equal(stepStalled("home", tx(null)), "nothing moved (execute_step returned null): the step may run again");
  // It moved, or the answer doesn't say: the step's `done` on the next tick decides.
  for (const [kind, result] of [["p_borrow", true], ["repay", "5000000"], ["l_repay", "75810000"], ["home", { index: 3 }], ["l_add", undefined], ["sell", null]] as const) assert.equal(stepStalled(kind, tx(result)), null);
  assert.equal(stepStalled("l_borrow", { ok: false, result: undefined, logs: [reopened] }), null, "a failed transaction is said by its own failure");
});

test("Phase 6: the seven lender and funding kinds are all execute_step's, and each is said in words with its amount", () => {
  const steps = [
    { k: "l_supply", l: "rhea", tok: "mnbtc.pbf-ops.testnet", amt: "131000000", done: true },
    { k: "l_borrow", l: "rhea", amt: 50_667_000_000, done: false },
    { k: "to_evm", tok: "mnbtc.pbf-ops.testnet", amt: "77000000", min: "76900000", dep: "ab".repeat(32), exp: 1_794_300_600_000, done: false },
    { k: "l_borrow", l: "aave", amt: 56_667_000_000, done: false },
    { k: "e_home", amt: 56_667_000_000, dep: "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d", exp: "1794300600000", done: false },
    { k: "p_borrow", amt: 37_833_000_000, done: false },
    { k: "l_repay", l: "rhea", amt: 10_133_000_000, done: false },
    { k: "l_add", l: "aave", tok: "0x54114591963CF60EF3aA63bEfD6eC263D98145a4", amt: "2500000", done: false },
  ];
  // A top-up plan is the stored REBALANCE plan, read as any other.
  const plan = readPlan({ plan: { pid: "276800123", action: "REBALANCE", stored_at: "1794300000000000000", steps } })!;
  assert.deepEqual([...new Set(plan.steps.map((s) => s.k))].sort(), [...FUNDING_KINDS].sort(), "all seven kinds");
  assert.ok(plan.steps.every((s) => s.runner === "execute_step"));
  assert.deepEqual(plan.steps.map((s) => s.text), [
    "post 131000000 units of mnbtc.pbf-ops.testnet at Rhea as collateral",
    "borrow $50,667.00 of USDC from Rhea, or the room a fresh verdict gives if that is less",
    "move 77000000 units of mnbtc.pbf-ops.testnet through 1Click to the account's own Ethereum address",
    "borrow $56,667.00 of USDC from Aave, or the room a fresh verdict gives if that is less",
    "bring $56,667.00 of USDC home from the account's Ethereum address through 1Click",
    "borrow $37,833.00 from our pool, or what a fresh verdict allows if that is less",
    "repay $10,133.00 to Rhea from the account's USDC",
    "add 2500000 units of 0x54114591963CF60EF3aA63bEfD6eC263D98145a4 to the collateral at Aave",
  ]);
  assert.deepEqual(plan.steps.map((s) => s.exp ?? null), [null, null, 1_794_300_600_000, null, 1_794_300_600_000, null, null, null], "the quotes' expiries, as for sell and home");
  assert.equal(readPlan({ plan: { pid: "1", steps: [{ k: "l_borrow", l: "compound", amt: 1_000_000 }] } })!.steps[0]!.text, "borrow $1.00 of USDC from the lender compound, or the room a fresh verdict gives if that is less");
});

test("Phase 6: the funding plan of get_state, with its id, amount and 30-minute expiry; none on an account made before", () => {
  const funding = readFunding({
    funding: {
      pid: "f276800123",
      amount: "94500000000",
      stored_at: "1794300000000000000",
      expires_at: "1794301800000000000",
      steps: [
        { k: "l_supply", l: "rhea", tok: "mnbtc.pbf-ops.testnet", amt: "131000000", done: true },
        { k: "l_borrow", l: "rhea", amt: 50_667_000_000, done: false },
        { k: "p_borrow", amt: 43_833_000_000, done: false },
      ],
    },
  })!;
  assert.deepEqual([funding.pid, funding.amount, funding.storedAtMs, funding.expiresAtMs], ["f276800123", "94500000000", 1_794_300_000_000, 1_794_301_800_000]);
  assert.deepEqual(funding.steps.map((s) => [s.i, s.k, s.runner, s.done]), [[0, "l_supply", "execute_step", true], [1, "l_borrow", "execute_step", false], [2, "p_borrow", "execute_step", false]]);
  assert.equal(funding.steps[2]!.text, "borrow $43,833.00 from our pool, or what a fresh verdict allows if that is less");
  assert.equal(readFunding({ funding: null }), null);
  assert.equal(readFunding({}), null);
  assert.equal(readFunding(null), null);
});

test("Phase 6: a verdict's ext is one position per lender, aave first; an older verdict has none", () => {
  const rhea = { l: "rhea", c: 100_000_000_000, d: 50_667_000_000, hf_bp: 15_000, r_bp: 1_591, s_bp: 1_032, room: 0, liq_bp: 7_600 };
  assert.deepEqual(readExt([rhea, { l: "aave", c: 5 }, { l: "rhea", d: 1 }, { l: "compound" }, null, "x"]), [{ l: "aave", c: 5, d: 0, hf_bp: 0, r_bp: 0, s_bp: 0, room: 0, liq_bp: 0 }, rhea]);
  assert.deepEqual(readExt(undefined), []);
  assert.deepEqual(readExt({ l: "rhea" }), []);
});
