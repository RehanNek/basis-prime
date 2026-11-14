import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { getDrill, getKeeper, postDrillFault, readJsonLines, shimAdmin, type Fault, type KeeperEvent, type ShimAdmin } from "./drill.js";
import { fakeChain, fakeDeps, fakeFetch, T0 } from "./fakes.js";
import { RateLimiter } from "./limiter.js";
import { createApiServer } from "./server.js";
import { HttpError } from "./validate.js";

const DRILL = "drill.pbf-ops.testnet";

function fakeAdmin(start: Fault = { mode: "none", delaySeconds: 600 }) {
  let fault = start;
  const sets: Fault[] = [];
  const admin: ShimAdmin = {
    get: async () => fault,
    set: async (next) => (sets.push(next), (fault = next)),
  };
  return { admin, sets };
}

function rejectsWith(status: number, code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof HttpError, String(error));
    assert.deepEqual([error.status, error.code], [status, code], error.message);
    return true;
  };
}

test("drill: the ratio and its owner from the drill contract, and the fault in force from the stand-in", async () => {
  const { chain } = fakeChain({ views: { [`${DRILL}.get_ratio`]: { bp: 8_400, set_at: "1794300000000000000" }, [`${DRILL}.owner`]: "pbf-ops.testnet" } });
  const { admin } = fakeAdmin({ mode: "late", delaySeconds: 120 });
  const answer = await getDrill(fakeDeps({ chain, shimAdmin: admin }).deps);
  assert.deepEqual(answer, {
    network: "testnet",
    drill_id: DRILL,
    deployed: true,
    block_height: 1000,
    ratio: { bp: 8_400, set_at: "1794300000000000000" },
    owner: "pbf-ops.testnet",
    faults_enabled: true,
    fault: { mode: "late", delaySeconds: 120 },
    fault_error: null,
    account_ratio: null,
  });
  const off = await getDrill(fakeDeps({ chain: fakeChain({}).chain }).deps);
  assert.deepEqual([off.deployed, off.ratio, off.faults_enabled, off.fault], [false, null, false, null]);
  assert.match(off.fault_error!, /SHIM_ADMIN_TOKEN or SHIM_URL is empty/);
});

test("drill fault: one of four modes, a delay for late, at most 10 changes a minute, and off without the token", async () => {
  const { admin, sets } = fakeAdmin();
  const { deps } = fakeDeps({ shimAdmin: admin });
  deps.limits.faults = new RateLimiter(2, 60_000, () => T0);
  assert.deepEqual(await postDrillFault(deps, { fault: "refund" }), { fault: { mode: "refund", delaySeconds: 600 } });
  assert.deepEqual(await postDrillFault(deps, { fault: "late", delay_seconds: 90 }), { fault: { mode: "late", delaySeconds: 90 } });
  await assert.rejects(postDrillFault(deps, { fault: "none" }), rejectsWith(429, "too_many_faults"));
  assert.deepEqual(sets.map((f) => f.mode), ["refund", "late"]);
  await assert.rejects(postDrillFault(deps, { fault: "explode" }), rejectsWith(400, "bad_request"));
  await assert.rejects(postDrillFault(deps, { fault: "late", delay_seconds: 0 }), rejectsWith(400, "bad_request"));
  await assert.rejects(postDrillFault(fakeDeps().deps, { fault: "fail" }), rejectsWith(503, "faults_off"));
});

test("the stand-in's admin client: the bearer token in the header only, never in an error", async () => {
  const token = "a-very-long-admin-token-0123456789";
  const { impl, calls } = fakeFetch({ status: 200, body: { fault: { mode: "none", delaySeconds: 600 } } }, { status: 200, body: { fault: { mode: "fail", delaySeconds: 600 } } }, { status: 401, body: { message: `Wrong token ${token}` } });
  const admin = shimAdmin("http://localhost:8787/", token, impl);
  assert.deepEqual(await admin.get(), { mode: "none", delaySeconds: 600 });
  assert.deepEqual(await admin.set({ mode: "fail", delaySeconds: 600 }), { mode: "fail", delaySeconds: 600 });
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.headers.Authorization, c.body]), [
    ["GET", "http://localhost:8787/admin/fault", `Bearer ${token}`, undefined],
    ["POST", "http://localhost:8787/admin/fault", `Bearer ${token}`, { mode: "fail", delaySeconds: 600 }],
  ]);
  await assert.rejects(admin.get(), (error: Error) => error instanceof HttpError && error.code === "shim_fault" && !error.message.includes(token));
});

const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const LOG: KeeperEvent[] = [
  { t: at(-100), event: "start", msg: "the keeper is starting" },
  { t: at(-30), event: "tick", msg: "2 client account(s) to look at", accounts: ["drill1.pbf.testnet", "x.pbf.testnet"], nbtc_ratio_bp: 7_500 },
  { t: at(-29), event: "check", msg: "asked for a check; the verdict is in", account: "drill1.pbf.testnet", tx: "H1", attestation_url: "https://testnet-api.outlayer.ai/attestations/by-tx/H1" },
  { t: at(-28), event: "check", msg: "asked for a check; the verdict is in", account: "x.pbf.testnet", tx: "H2" },
  { t: at(-20), event: "gateway", msg: "pb-gateway ran deleverage", account: "drill1.pbf.testnet", mode: "deleverage", placed: [{ i: 1, k: "perp" }] },
];

test("keeper log: the account's lines, newest first, and whether the keeper is running and watching it", () => {
  const { deps } = fakeDeps({ readKeeperLog: () => ({ found: true, events: LOG }) });
  const answer = getKeeper(deps, "drill1.pbf.testnet");
  assert.deepEqual(answer.keeper, { last_tick_at: at(-30), running: true, dry_run: false, watches: true, nbtc_ratio_bp: 7_500, rhea: null });
  assert.deepEqual(answer.events.map((e) => [e.event, e.tx ?? null]), [["gateway", null], ["check", "H1"]]);
  // A tick is held while a check waits its turn at OutLayer (up to 3 minutes), so the keeper counts as running for 4
  // minutes after its last one.
  const held = getKeeper(fakeDeps({ readKeeperLog: () => ({ found: true, events: LOG }), now: () => T0 + 120_000 }).deps, "drill1.pbf.testnet");
  assert.equal(held.keeper.running, true);
  const stale = getKeeper(fakeDeps({ readKeeperLog: () => ({ found: true, events: LOG }), now: () => T0 + 240_000 }).deps, "drill1.pbf.testnet");
  assert.equal(stale.keeper.running, false);
  assert.throws(() => getKeeper(deps, "alice.testnet"), /client account/);

  const dir = mkdtempSync(join(tmpdir(), "pb-api-"));
  const file = join(dir, "keeper.jsonl");
  writeFileSync(file, `${LOG.map((e) => JSON.stringify(e)).join("\n")}\nnot json\n`);
  assert.equal(readJsonLines(file).events.length, LOG.length);
  assert.deepEqual(readJsonLines(join(dir, "none.jsonl")), { found: false, events: [] });
});

test("keeper log, Phase 6: our Rhea copy's BTC price as the keeper keeps it, the hold on it while one is set, and the account's settlements", () => {
  const hold = { shift_bp: -1_334, until_ms: T0 + 25 * 60_000, by: "funding:demo for drill1.pbf.testnet" };
  const log: KeeperEvent[] = [
    ...LOG,
    { t: at(-19), event: "rhea_price", msg: "a hold is on (funding:demo for drill1.pbf.testnet): our Rhea copy's BTC price is kept 13.34% under Hyperliquid's oracle until 2026-11-08T12:25:00.000Z", rhea: "rhea.pbf-ops.testnet", hold },
    { t: at(-18), event: "rhea_price", msg: "set our Rhea copy's BTC price to $65,861.60: it was $76,000.00, 15.39% from the hold's level of $65,861.60 (13.34% under Hyperliquid's oracle at $76,000.00)", tx: "KP1", hold },
    { t: at(-17), event: "settle", msg: "settled: a fee of $0.000108 was added to what the account owes our pool", account: "drill1.pbf.testnet", tx: "S1", fee: "108" },
    { t: at(-15), event: "tick", msg: "2 client account(s) to look at", accounts: ["drill1.pbf.testnet", "x.pbf.testnet"], nbtc_ratio_bp: 10_000, btc_oracle: 76_000, rhea_btc: 65_861.6, rhea_hold: hold },
  ];
  const held = getKeeper(fakeDeps({ readKeeperLog: () => ({ found: true, events: log }) }).deps, "drill1.pbf.testnet");
  assert.deepEqual(held.keeper.rhea, {
    btc_usd: 65_861.6,
    oracle_usd: 76_000,
    hold,
    last: { t: at(-18), msg: "set our Rhea copy's BTC price to $65,861.60: it was $76,000.00, 15.39% from the hold's level of $65,861.60 (13.34% under Hyperliquid's oracle at $76,000.00)", tx: "KP1" },
  });
  assert.deepEqual(held.events.map((e) => [e.event, e.tx ?? null]), [["settle", "S1"], ["gateway", null], ["check", "H1"]], "the settlement is one of the account's lines; the price lines are the keeper's own");

  // The hold cleared: the next tick says none, and the price is the oracle's again.
  const cleared = [...log, { t: at(-1), event: "rhea_price", msg: "the hold is over: our Rhea copy's BTC price goes back to Hyperliquid's oracle" }, { t: at(0), event: "tick", accounts: ["drill1.pbf.testnet"], btc_oracle: 76_000, rhea_btc: 76_000, rhea_hold: null }];
  const free = getKeeper(fakeDeps({ readKeeperLog: () => ({ found: true, events: cleared }) }).deps, "drill1.pbf.testnet").keeper.rhea;
  assert.deepEqual([free?.btc_usd, free?.hold, free?.last?.tx], [76_000, null, null]);
  // A keeper with no Rhea copy in its settings writes none of these fields: rhea is null, as on the earlier phases' logs.
  assert.equal(getKeeper(fakeDeps({ readKeeperLog: () => ({ found: true, events: LOG }) }).deps, "drill1.pbf.testnet").keeper.rhea, null);
});

test("Phase 4 routes: GET /api/drill, POST /api/drill/fault, GET /api/keeper/:account", async () => {
  const { chain } = fakeChain({ views: { [`${DRILL}.get_ratio`]: { bp: 10_000, set_at: "1" }, [`${DRILL}.owner`]: "pbf-ops.testnet" } });
  const { admin } = fakeAdmin();
  const server = createApiServer(fakeDeps({ chain, shimAdmin: admin, readKeeperLog: () => ({ found: true, events: LOG }) }).deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const drill = (await (await fetch(`${base}/api/drill`)).json()) as { ratio: { bp: number }; fault: Fault };
    assert.deepEqual([drill.ratio.bp, drill.fault.mode], [10_000, "none"]);
    const set = await fetch(`${base}/api/drill/fault`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fault: "refund" }) });
    assert.deepEqual([set.status, ((await set.json()) as { fault: Fault }).fault.mode], [200, "refund"]);
    const keeper = (await (await fetch(`${base}/api/keeper/drill1.pbf.testnet`)).json()) as { events: unknown[] };
    assert.equal(keeper.events.length, 2);
  } finally {
    server.close();
  }
});

test("drill, Phase 5: with an account, the ratio pb-risk reads for it (its own, or the shared one while the old code has no get_ratio_for)", async () => {
  const shared = { bp: 10_000, set_at: "1" };
  const views = { [`${DRILL}.get_ratio`]: shared, [`${DRILL}.owner`]: "pbf-ops.testnet" };
  const own = fakeChain({ views: { ...views, [`${DRILL}.get_ratio_for`]: ({ account_id }: Record<string, unknown>) => (account_id === "drill1.pbf.testnet" ? { bp: 7_800, set_at: "2" } : shared) } });
  const mine = await getDrill(fakeDeps({ chain: own.chain }).deps, "drill1.pbf.testnet");
  assert.deepEqual(mine.account_ratio, { account: "drill1.pbf.testnet", per_account: true, ratio: { bp: 7_800, set_at: "2" }, shared: false });
  assert.ok(own.calls.includes(`${DRILL}.get_ratio_for({"account_id":"drill1.pbf.testnet"})`));
  const other = await getDrill(fakeDeps({ chain: own.chain }).deps, "x.pbf.testnet");
  assert.deepEqual(other.account_ratio, { account: "x.pbf.testnet", per_account: true, ratio: shared, shared: true });
  const old = await getDrill(fakeDeps({ chain: fakeChain({ views }).chain }).deps, "drill1.pbf.testnet");
  assert.deepEqual(old.account_ratio, { account: "drill1.pbf.testnet", per_account: false, ratio: shared, shared: true });
  await assert.rejects(getDrill(fakeDeps().deps, "alice.testnet"), rejectsWith(400, "bad_request"));
});
