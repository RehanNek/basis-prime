import assert from "node:assert/strict";
import { test } from "node:test";

import { ACTIVITY_CACHE_MS, FastNearTx, getActivity, keeperPlacements, readTx, type AccountTx, type ActivityContext, type IndexedTx, type TxIndexer } from "./activity.js";
import type { KeeperEvent } from "./drill.js";
import { fakeDeps, fakeFetch, T0 } from "./fakes.js";
import { RateLimiter } from "./limiter.js";
import { HttpError } from "./validate.js";

const ACC = "drill1.pbf.testnet";
const MUSDC = "musdc.pbf-ops.testnet";
const MNBTC = "mnbtc.pbf-ops.testnet";
const POOL = "pool.pbf.testnet";
const KEEPER = "pbf-keeper.testnet";
const SHIM = "shim.pbf-ops.testnet";
const CTX: ActivityContext = { account: ACC, factory: "pbf.testnet", pool: POOL, tokens: [MUSDC, MNBTC] };
const META = { atMs: T0, block: 276_784_835, ok: true };

const ev = (standard: string, event: string, data: unknown) => `EVENT_JSON:${JSON.stringify({ standard, version: "1.0.0", event, data })}`;
const ft = (from: string, to: string, amount: string, memo?: string) => ev("nep141", "ft_transfer", [{ old_owner_id: from, new_owner_id: to, amount, ...(memo ? { memo } : {}) }]);
const pb = (event: string, data: unknown) => ev("pb-pool", event, data);

/** A transaction as FastNEAR's /v0/transactions answers it (the shape read live on 9 Nov), with its receipts' logs. */
function tx(hash: string, signer: string, receiver: string, method: string, args: unknown, receipts: [string, string[], string?][]): IndexedTx {
  return {
    transaction: { hash, signer_id: signer, receiver_id: receiver, actions: [{ FunctionCall: { method_name: method, args: Buffer.from(JSON.stringify(args)).toString("base64"), gas: 300_000_000_000_000, deposit: "1" } }] },
    execution_outcome: { block_height: 276_784_835, outcome: { executor_id: signer, logs: [], status: { SuccessReceiptId: "r0" } } },
    receipts: receipts.map(([executor, logs, failure]) => ({
      receipt: { receiver_id: executor },
      execution_outcome: { outcome: { executor_id: executor, logs, status: failure ? { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: failure } } } } } : { SuccessValue: "" } } },
    })),
  };
}

const kinds = (items: { kind: string }[]) => items.map((i) => i.kind);

test("money in and out: deposits, the loan, taking it out, and a repayment with the pool's refund, from the contracts' own events", () => {
  const deposit = readTx(tx("D", KEEPER, MUSDC, "ft_transfer_call", { receiver_id: ACC, amount: "440000000", msg: "" }, [[MUSDC, [ft(KEEPER, ACC, "440000000")]], [ACC, []], ["evil.testnet", [ft("x.testnet", ACC, "999")]]]), META, CTX);
  assert.deepEqual(deposit, [
    { at_ms: T0, block: 276_784_835, tx: "D", ok: true, kind: "deposit", by: KEEPER, moves: [{ token: MUSDC, amount: "440000000", other: KEEPER }], detail: { token: MUSDC, sent: "440000000", kept: true }, source: "indexer" },
  ]);

  const [borrow] = readTx(tx("B", KEEPER, ACC, "borrow", { amount: "1097175834" }, [[ACC, []], [POOL, [pb("borrow", { account_id: ACC, amount: "1097175834", tier: "STANDARD", debt: "1097175835" })]], [MUSDC, [ft(POOL, ACC, "1097175834")]]]), META, CTX);
  assert.deepEqual([borrow!.kind, borrow!.detail, borrow!.moves], ["borrow", { asked: "1097175834", amount: "1097175834", debt: "1097175835", tier: "STANDARD", returned: null }, [{ token: MUSDC, amount: "1097175834", other: POOL }]]);

  const [out] = readTx(tx("W", KEEPER, ACC, "withdraw", { token: MUSDC, amount: "1097175834", receiver: KEEPER }, [[ACC, []], [MUSDC, [ft(ACC, KEEPER, "1097175834")]]]), META, CTX);
  assert.deepEqual([out!.kind, out!.detail.to, out!.moves], ["withdraw", KEEPER, [{ token: MUSDC, amount: "-1097175834", other: KEEPER }]]);

  const [repay] = readTx(
    tx("R", KEEPER, ACC, "repay", { amount: "1089263563" }, [[ACC, []], [MUSDC, [ft(ACC, POOL, "1089263563")]], [POOL, [pb("repay", { account_id: ACC, amount: "1087176392" })]], [MUSDC, [ft(POOL, ACC, "2087171", "refund")]]]),
    META,
    CTX,
  );
  assert.deepEqual([repay!.kind, repay!.detail, repay!.moves], ["repay", { sent: "1089263563", amount: "1087176392" }, [{ token: MUSDC, amount: "-1087176392", other: POOL }]]);
});

test("moves to and from Hyperliquid: the move out with its transfer id, the signed send home, its arrival, and a refund", () => {
  const dep = "bb103ace98e62872b7a500da67eebfbc1d2f604781f6dba146ee13c2c15dac00";
  const [toHl] = readTx(tx("T", KEEPER, ACC, "withdraw", { token: MUSDC, amount: "430000000", receiver: dep, transfer: { kind: "to_hl", exp: 1 } }, [[ACC, [`transfer move:0 under way: 430000000 ${MUSDC} to ${dep}`]], [MUSDC, [ft(ACC, dep, "430000000")]]]), META, CTX);
  assert.deepEqual([toHl!.kind, toHl!.detail], ["to_hl", { token: MUSDC, amount: "430000000", to: dep, transfer: "move:0", implicit_receiver: true }]);

  const [home] = readTx(tx("H", KEEPER, ACC, "hl_withdraw", { amount: "426811579", destination: "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d", exp: 1, source_dex: "" }, [[ACC, [`transfer move:1 under way: 42681157900 USDC to 0xfc9d`, pb("hl_signed", [{ account: ACC, index: 1, kind: "sendAsset", nonce: 1 }])]]]), META, CTX);
  assert.deepEqual([home!.kind, home!.detail], ["home", { amount: "426811579", destination: "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d", transfer: "move:1" }]);

  const arrival = (how: string) =>
    readTx(tx("A", SHIM, MUSDC, "ft_transfer_call", { receiver_id: ACC, amount: "426543916", msg: '{"pb":{"transfer":"move:1"}}' }, [[MUSDC, [ft(SHIM, ACC, "426543916", "1click-shim")]], [ACC, [pb("transfer_done", { id: "move:1", how })]]]), META, CTX);
  const [arrived] = arrival("arrived");
  assert.deepEqual([arrived!.kind, arrived!.by, arrived!.detail, arrived!.moves], ["arrived", SHIM, { transfer: "move:1", how: "arrived", token: MUSDC, sent: "426543916" }, [{ token: MUSDC, amount: "426543916", other: SHIM }]]);
  assert.equal(arrival("refunded")[0]!.kind, "refund");
});

test("a check that stores a plan and sees a move arrive is three lines; a plan step, setup, the account's creation, KYB, a failure", () => {
  const check = readTx(tx("C", KEEPER, ACC, "request_check", { intent: { check: {} } }, [[ACC, [pb("plan_stored", { pid: "276784686", action: "DELEVERAGE", steps: ["repay", "perp"] }), pb("transfer_done", { id: "move:0", how: "verdict" })]]]), META, CTX);
  assert.deepEqual(kinds(check), ["check", "plan", "arrived"]);
  assert.deepEqual(check[1]!.detail, { pid: "276784686", action: "DELEVERAGE", steps: ["repay", "perp"] });
  assert.deepEqual(check[2]!.detail, { transfer: "move:0", how: "verdict" });

  const [step] = readTx(tx("S", KEEPER, ACC, "execute_step", { pid: "276784686", i: 0 }, [[ACC, [pb("step_run", { pid: "276784686", i: 0, k: "repay" })]], [MUSDC, [ft(ACC, POOL, "10000000")]], [POOL, [pb("repay", { account_id: ACC, amount: "10000000" })]]]), META, CTX);
  assert.deepEqual([step!.kind, step!.detail], ["plan_step", { pid: "276784686", i: 0, k: "repay", repaid: "10000000", transfer: null }]);

  assert.equal(readTx(tx("I", KEEPER, ACC, "hl_init", {}, [[ACC, []]]), META, CTX)[0]!.kind, "setup");
  const [created] = readTx(tx("N", KEEPER, "pbf.testnet", "create_account", { name: "drill1", owner: KEEPER }, [[POOL, [pb("register", { account_id: ACC })]]]), META, CTX);
  assert.deepEqual([created!.kind, created!.detail], ["create", { owner: KEEPER, registered: true }]);
  const [kyb] = readTx(tx("K", "pbf-ops.testnet", POOL, "set_kyb", { account_id: ACC, entity: "acme" }, [[POOL, [pb("set_kyb", { account_id: ACC, entity: "acme" })]]]), META, CTX);
  assert.deepEqual([kyb!.kind, kyb!.detail], ["kyb", { entity: "acme" }]);

  const [failed] = readTx(tx("F", KEEPER, ACC, "borrow", { amount: "5" }, [[ACC, [], "Smart contract panicked: the verdict is stale"]]), META, CTX);
  assert.deepEqual([failed!.kind, failed!.ok, failed!.detail.amount], ["borrow", false, null]);
  assert.equal(readTx(tx("X", KEEPER, "elsewhere.testnet", "hello", {}, []), { ...META, ok: false }, CTX)[0]!.ok, false);
});

test("the gateway's placements of plan steps come from the keeper's log, with the run's attestation", () => {
  const line: KeeperEvent = {
    t: new Date(T0).toISOString(),
    event: "gateway",
    account: ACC,
    mode: "deleverage",
    pid: "276784686",
    placed: [{ avg_px: "75860.5", filled_sz: "0.00375", i: 1, k: "perp", oid: 64831077423, status: "filled" }],
    attestation_url: "https://testnet-api.outlayer.ai/attestations/by-call/bf77",
  };
  assert.deepEqual(keeperPlacements([line, { ...line, account: "other.pbf.testnet" }, { ...line, mode: "cancel_risky", placed: null }], ACC), [
    {
      at_ms: T0,
      block: null,
      tx: null,
      ok: true,
      kind: "plan_step",
      by: "keeper",
      moves: [],
      detail: { pid: "276784686", i: 1, k: "perp", status: "filled", filled_sz: "0.00375", avg_px: "75860.5", via: "pb-gateway" },
      source: "keeper_log",
      attestation_url: "https://testnet-api.outlayer.ai/attestations/by-call/bf77",
    },
  ]);
});

/** An indexer holding `n` transactions of the account, newest first, each a deposit. */
function fakeIndexer(n: number, atMs: (i: number) => number) {
  const lists: string[] = [];
  const fetched: string[][] = [];
  let txs: AccountTx[] = Array.from({ length: n }, (_, i) => ({ transaction_hash: `h${i}`, tx_block_height: 1_000 - i, tx_block_timestamp: `${BigInt(atMs(i)) * 1_000_000n}`, is_success: true }));
  const indexer: TxIndexer = {
    host: "tx.test.fastnear.com",
    async accountTxs(account) {
      lists.push(account);
      return { txs, total: txs.length, more: false };
    },
    async transactions(hashes) {
      fetched.push(hashes);
      return hashes.map((h) => tx(h, KEEPER, MUSDC, "ft_transfer_call", { receiver_id: ACC, amount: "1", msg: "" }, [[MUSDC, [ft(KEEPER, ACC, "1")]]]));
    },
  };
  return { indexer, lists, fetched, add: (t: AccountTx) => (txs = [t, ...txs]) };
}

test("GET /api/activity: the newest transactions in batches of 20, newest first with the keeper's placements, kept 30 s; settled ones aren't read again", async () => {
  let now = T0;
  const { indexer, lists, fetched, add } = fakeIndexer(45, (i) => T0 - 600_000 - i * 1_000);
  const placement: KeeperEvent = { t: new Date(T0 - 300_000).toISOString(), event: "gateway", account: ACC, mode: "deleverage", pid: "9", placed: [{ i: 1, k: "perp", status: "filled" }], attestation_url: "https://a" };
  const { deps } = fakeDeps({ indexer, now: () => now, readKeeperLog: () => ({ found: true, events: [placement] }) });
  const first = await getActivity(deps, ACC);
  assert.deepEqual(fetched.map((f) => f.length), [20, 20, 5]);
  assert.deepEqual([first.total, first.listed, first.detailed, first.more, first.keeper_log, first.cached], [45, 45, 45, false, true, false]);
  assert.equal(first.items.length, 46);
  assert.deepEqual([first.items[0]!.source, first.items[1]!.tx], ["keeper_log", "h0"], "newest first");
  assert.deepEqual(first.indexer, { host: "tx.test.fastnear.com", docs: "https://docs.fastnear.com/tx/account" });

  now += 10_000;
  assert.equal((await getActivity(deps, ACC)).cached, true);
  assert.equal(lists.length, 1, "kept for 30 s");

  now += ACTIVITY_CACHE_MS;
  add({ transaction_hash: "new", tx_block_height: 2_000, tx_block_timestamp: `${BigInt(now) * 1_000_000n}`, is_success: true });
  const again = await getActivity(deps, ACC);
  assert.deepEqual(fetched.at(-1), ["new"], "only the new transaction is read in full");
  assert.equal(again.items[0]!.tx, "new");

  await assert.rejects(getActivity(deps, "alice.testnet"), (e: unknown) => e instanceof HttpError && e.status === 400);
  await assert.rejects(getActivity(fakeDeps().deps, ACC), (e: unknown) => e instanceof HttpError && e.code === "activity_off");
});

test("GET /api/activity: past the limit on reads, the last answer comes back stale, or 429 without one", async () => {
  const { indexer } = fakeIndexer(1, () => T0 - 600_000);
  let now = T0;
  const { deps } = fakeDeps({ indexer, now: () => now, readKeeperLog: () => ({ found: false, events: [] }) });
  deps.limits.activityReads = new RateLimiter(1, 60_000, () => T0);
  await getActivity(deps, ACC);
  now += ACTIVITY_CACHE_MS;
  const stale = await getActivity(deps, ACC);
  assert.deepEqual([stale.cached, (stale as { stale?: boolean }).stale], [true, true]);
  await assert.rejects(getActivity(deps, "other.pbf.testnet"), (e: unknown) => e instanceof HttpError && e.status === 429);
});

test("FastNEAR's transactions API: POST JSON, newest first, a key only when given, and its failures are 502 indexer", async () => {
  const { impl, calls } = fakeFetch(
    { status: 200, body: { account_txs: [{ transaction_hash: "h", tx_block_height: 1, tx_block_timestamp: "1", is_success: true }], txs_count: 1, resume_token: "" } },
    { status: 200, body: { transactions: [{ transaction: { hash: "h", signer_id: "a", receiver_id: "b", actions: [] } }, {}] } },
    { status: 429, body: "slow down" },
  );
  const indexer = new FastNearTx({ url: "https://tx.test.fastnear.com/", apiKey: "secret", fetch: impl });
  assert.deepEqual(await indexer.accountTxs(ACC, 200), { txs: [{ transaction_hash: "h", tx_block_height: 1, tx_block_timestamp: "1", is_success: true }], total: 1, more: false });
  assert.equal((await indexer.transactions(["h"])).length, 1, "an entry without a transaction is dropped");
  await assert.rejects(indexer.accountTxs(ACC, 200), (e: unknown) => e instanceof HttpError && e.status === 502 && e.code === "indexer" && !e.message.includes("secret"));
  assert.deepEqual(calls.map((c) => [c.url, c.method, c.body]), [
    ["https://tx.test.fastnear.com/v0/account", "POST", { account_id: ACC, desc: true, limit: 200 }],
    ["https://tx.test.fastnear.com/v0/transactions", "POST", { tx_hashes: ["h"] }],
    ["https://tx.test.fastnear.com/v0/account", "POST", { account_id: ACC, desc: true, limit: 200 }],
  ]);
  assert.equal(calls[0]!.headers.Authorization, "Bearer secret");
  const { impl: plain, calls: plainCalls } = fakeFetch({ status: 200, body: { account_txs: [] } });
  await new FastNearTx({ url: "https://tx.test.fastnear.com", fetch: plain }).accountTxs(ACC, 5);
  assert.equal(plainCalls[0]!.headers.Authorization, undefined, "no key: no header");
});
