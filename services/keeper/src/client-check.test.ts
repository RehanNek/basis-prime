// INTERFACES.md 49.4: the checks the broker pays for, the keeper's side. The client's page asks the backend, the
// backend asks the keeper's status port (POST /check, with the service token), and the keeper sends `request_check`
// with the page's intent by the same door its own checks use. Against fakes: nothing here reaches a chain.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { isClientAccount } from "./accounts.js";
import { decide, verdictKey, type Seen } from "./decide.js";
import type { LogEvent } from "./jsonl.js";
import { CLIENT_CHECK_FLIGHT_MS, CLIENT_CHECK_GRACE_MS, CLIENT_CHECK_TRIES, clientCheck, clientCheckHolds, oneAtATime, tick, type AccountMemory, type CheckResult, type ClientCheckAnswer, type KeeperDeps } from "./loop.js";
import type { AccountState } from "./state.js";
import { statusServer, type KeeperStatus } from "./status.js";

const S = 1_000;
const T0 = Date.UTC(2026, 10, 13, 20, 0);
const ACCOUNT = "alice.pbf.testnet";
const NO_VERDICT = "OutLayer returned no verdict: the run failed or timed out";
const TOKEN = `svc.${"cd".repeat(32)}`;

const result = (more: Partial<CheckResult>): CheckResult => ({ ok: true, hash: "tx-1", accepted: true, reason: null, attestationUrl: null, seconds: 20, ...more });
const refused = (reason: string, hash: string): CheckResult => result({ accepted: false, reason, hash });

/** An account with a verdict in, and a keeper whose `request_check` answers from a list. */
function keeper(answers: (CheckResult | Error)[], options: { loan?: string; now?: () => number } = {}) {
  const sent: { account: string; intent: unknown }[] = [];
  const events: LogEvent[] = [];
  const clock = { now: T0 };
  const now = options.now ?? (() => clock.now);
  const state: AccountState = {
    owner: "alice.testnet",
    counter: 7,
    loan: { principal: options.loan ?? "0", open: (options.loan ?? "0") !== "0" },
    verdict: { intent: { check: {} }, received_block: 5_010, verdict: { ok: true, blk: 5_000, nonce: 7, state: "HEALTHY", action: "NONE", eq: 1_518_714_350, plan: [] } },
    deleverage: { first_at: "0" },
    plan: null,
    pending: [],
    hl: null,
  } as unknown as AccountState;
  const forgotten: string[] = [];
  const deps = {
    readState: async () => structuredClone(state),
    requestCheck: async (account: string, intent?: unknown) => {
      sent.push({ account, intent });
      const answer = answers.shift() ?? result({});
      if (answer instanceof Error) throw answer;
      return answer;
    },
    forget: (account: string) => void forgotten.push(account),
    log: (event: string, msg: string, fields: Record<string, unknown> = {}) => events.push({ t: new Date(now()).toISOString(), event, msg, ...fields }),
    now,
  } as unknown as KeeperDeps;
  return { deps, sent, events, state, clock, forgotten, memory: new Map<string, AccountMemory>() };
}

// ---------- the check itself ----------

test("49.4, a client's check goes out once with the page's own intent, and the answer names the verdict's block, the transaction and one try", async () => {
  const k = keeper([result({ hash: "tx-9" })]);
  const intent = { withdraw: { token: "mnbtc.pbf-ops.testnet", amount: "14000" } };
  const answer = await clientCheck(k.deps, k.memory, ACCOUNT, intent);
  assert.deepEqual(answer, { accepted: true, blk: 5_000, tries: 1, tx: "tx-9" });
  assert.deepEqual(k.sent, [{ account: ACCOUNT, intent }]);
  assert.deepEqual(k.forgotten, [ACCOUNT], "the next read of the account is a fresh one");
});

test(`49.4, "OutLayer returned no verdict" is asked again, up to three times in all: the third try's verdict is the answer`, async () => {
  const k = keeper([refused(NO_VERDICT, "tx-1"), refused(NO_VERDICT, "tx-2"), result({ hash: "tx-3" })]);
  const answer = await clientCheck(k.deps, k.memory, ACCOUNT, { check: {} });
  assert.deepEqual(answer, { accepted: true, blk: 5_000, tries: 3, tx: "tx-3" });
  assert.equal(k.sent.length, 3);
  assert.deepEqual(k.events.filter((e) => e.event === "check").map((e) => [e.try, e.accepted]), [[1, false], [2, false], [3, true]]);
});

test("49.4, three tries and no more: when OutLayer brings no verdict three times, the answer is the refusal with its reason and the last transaction", async () => {
  const k = keeper([refused(NO_VERDICT, "tx-1"), refused(NO_VERDICT, "tx-2"), refused(NO_VERDICT, "tx-3"), result({ hash: "tx-4" })]);
  const answer = await clientCheck(k.deps, k.memory, ACCOUNT, { check: {} });
  assert.equal(CLIENT_CHECK_TRIES, 3);
  assert.deepEqual(answer, { accepted: false, reason: NO_VERDICT, tries: 3, tx: "tx-3" });
  assert.equal(k.sent.length, 3);
  assert.equal(k.memory.get(ACCOUNT)!.clientCheck, undefined, "nothing of the client's is on its way any more");
});

test("49.4, a verdict the account itself refused isn't asked again: another run would be refused the same way, and would cost the same", async () => {
  const why = "the verdict's nonce isn't the account's counter";
  const k = keeper([refused(why, "tx-1"), result({})]);
  assert.deepEqual(await clientCheck(k.deps, k.memory, ACCOUNT, { check: {} }), { accepted: false, reason: why, tries: 1, tx: "tx-1" });
  assert.equal(k.sent.length, 1);
});

test("49.4, a check whose end wasn't seen isn't sent again, since it may still land: the answer says so, and the loop waits for it as for one of its own", async () => {
  const k = keeper([{ ok: false, hash: null, attestationUrl: null, seconds: 60, failure: "the RPC stopped waiting" }, result({})]);
  const answer = await clientCheck(k.deps, k.memory, ACCOUNT, { check: {} });
  assert.equal(answer.accepted, false);
  assert.match((answer as { reason: string }).reason, /^the check didn't come back in time, and its result may still arrive: the RPC stopped waiting$/);
  assert.deepEqual([answer.tries, answer.tx, k.sent.length], [1, null, 1]);
  assert.deepEqual(k.memory.get(ACCOUNT)!.decide.checkPending, { at: T0 });
  // A sender that throws is the same: nothing is known of the transaction.
  const thrown = keeper([new Error("socket hang up")]);
  const second = await clientCheck(thrown.deps, thrown.memory, ACCOUNT, { check: {} });
  assert.deepEqual([second.accepted, second.tries, thrown.sent.length], [false, 1, 1]);
});

test("49.4, one check at a time: a second ask for an account while its first is on its way is refused, and nothing more is sent", async () => {
  let release: (r: CheckResult) => void = () => undefined;
  const k = keeper([]);
  (k.deps as { requestCheck: KeeperDeps["requestCheck"] }).requestCheck = (account, intent) => {
    k.sent.push({ account, intent });
    return new Promise<CheckResult>((resolve) => (release = resolve));
  };
  const first = clientCheck(k.deps, k.memory, ACCOUNT, { check: {} });
  // Answered at once: it doesn't wait for the first.
  const soon = new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 200));
  const second = await Promise.race([clientCheck(k.deps, k.memory, ACCOUNT, { borrow: { amount: "5" } }), soon]);
  assert.deepEqual(second, { accepted: false, reason: "a check for this account is already on its way: wait for it", tries: 0, tx: null });
  assert.equal(k.sent.length, 1);
  release(result({ hash: "tx-1" }));
  assert.equal((await first).accepted, true);
  // Once the first is in, the next ask goes out.
  (k.deps as { requestCheck: KeeperDeps["requestCheck"] }).requestCheck = async () => result({ hash: "tx-2" });
  assert.deepEqual(await clientCheck(k.deps, k.memory, ACCOUNT, { check: {} }), { accepted: true, blk: 5_000, tries: 1, tx: "tx-2" });
});

test("49.4, the keeper's own memory of the check: asked at this time and at these prices, so the verdict counts as one the keeper asked for", async () => {
  const k = keeper([result({})]);
  const prices = { marks: { BTC: 76_000 }, pi: { nBTC: 9_990 } };
  k.memory.set(ACCOUNT, { decide: {}, transfers: {}, kept: [{ at: T0 - 15 * S, prices }] } as unknown as AccountMemory);
  await clientCheck(k.deps, k.memory, ACCOUNT, { check: {} });
  const mem = k.memory.get(ACCOUNT)!;
  assert.deepEqual([mem.decide.lastCheckAt, mem.decide.checkPrices], [T0, prices]);
  assert.deepEqual(mem.clientCheck, { at: T0, acceptedAt: T0, counter: 7 });
});

test("49.3, the accepted check's log line carries the verdict's block, what the engine counts the account as worth and what it owes our pool: the page's chart reads these", async () => {
  const k = keeper([result({ hash: "tx-5" })], { loan: "480000000" });
  await clientCheck(k.deps, k.memory, ACCOUNT, { check: {} });
  const line = k.events.find((e) => e.event === "check")!;
  assert.deepEqual([line.account, line.tx, line.accepted, line.blk, line.eq, line.debt, line.why], [ACCOUNT, "tx-5", true, 5_000, 1_518_714_350, "480000000", "asked by the client's page (POST /check)"]);
  // A refused one carries none: there is no verdict to read.
  const no = keeper([refused("the verdict is for another intent", "tx-6")]);
  await clientCheck(no.deps, no.memory, ACCOUNT, { check: {} });
  assert.deepEqual(["blk" in no.events[0]!, "eq" in no.events[0]!], [false, false]);
});

// ---------- the loop holds its own checks ----------

test("49.4, clientCheckHolds: while the client's check is on its way (12 minutes at most), and for 90 s after its verdict unless the account's counter has moved", () => {
  const mem = (clientCheck: AccountMemory["clientCheck"]) => ({ decide: {}, transfers: {}, clientCheck }) as AccountMemory;
  assert.equal(clientCheckHolds(mem(undefined), 7, T0), false);
  assert.equal(clientCheckHolds(mem({ at: T0 }), 7, T0 + CLIENT_CHECK_FLIGHT_MS - 1), true);
  assert.equal(clientCheckHolds(mem({ at: T0 }), 7, T0 + CLIENT_CHECK_FLIGHT_MS), false, "a check that never came back doesn't hold the keeper for good");
  const landed = mem({ at: T0, acceptedAt: T0 + 30 * S, counter: 7 });
  assert.equal(clientCheckHolds(landed, 7, T0 + 30 * S + CLIENT_CHECK_GRACE_MS - 1), true);
  assert.equal(clientCheckHolds(landed, 7, T0 + 30 * S + CLIENT_CHECK_GRACE_MS), false, "the verdict has gone stale: the client didn't act");
  assert.equal(clientCheckHolds(landed, 8, T0 + 31 * S), false, "the client acted: the counter moved");
  assert.deepEqual([CLIENT_CHECK_FLIGHT_MS, CLIENT_CHECK_GRACE_MS], [12 * 60 * S, 90 * S]);
});

test("49.4, decide: a check that is due waits while the client's own is out, with the reason in a note, and goes out once it isn't", () => {
  const verdict = { state: "HEALTHY", action: "NONE", blk: 5_000, nonce: 7, receivedBlock: 5_010, at: T0 - 3_600 * S, bands: {}, tokens: [] };
  const seen = (more: Partial<Seen>): Seen => ({ hasLoan: true, counter: 7, verdict, firstDeleverageAtMs: 0, plan: null, prices: { marks: {}, pi: {} }, perps: [], ...more }) as Seen;
  const hourlyDue = { verdictKey: verdictKey(verdict as NonNullable<Seen["verdict"]>), nextHourlyAt: T0 - S, lastCheckAt: T0 - 3_600 * S };
  const free = decide(hourlyDue, seen({}), T0, () => 0.5);
  assert.deepEqual(free.actions.map((a) => a.kind), ["request_check"]);
  const held = decide(hourlyDue, seen({ clientCheck: true }), T0, () => 0.5);
  assert.deepEqual(held.actions, []);
  assert.equal(held.notes.length, 1);
  assert.match(held.notes[0]!, /^a check waits its turn: the client's page has asked for one/);
  // The held check is remembered, and goes out when the client's is done.
  const after = decide(held.memory, seen({}), T0 + 15 * S, () => 0.5);
  assert.deepEqual(after.actions.map((a) => a.kind), ["request_check"]);
});

test("49.4, tick: with a client's check on its way the loop sends no check of its own for that account, whatever falls due", async () => {
  const k = keeper([], { loan: "250000000" });
  const full = {
    ...k.deps,
    readMarket: async () => ({ prices: { marks: { BTC: 76_000 }, pi: { nBTC: 10_000 } }, summary: {} }),
    listAccounts: async () => [ACCOUNT],
    blockTimeMs: async () => T0 - 3_600 * S,
    readPerps: async () => [],
    random: () => 0.5,
  } as unknown as KeeperDeps;
  // The hourly check is overdue.
  k.memory.set(ACCOUNT, { decide: { verdictKey: "5000:7", nextHourlyAt: T0 - S, lastCheckAt: T0 - 3_600 * S }, transfers: {}, clientCheck: { at: T0 - 20 * S } } as unknown as AccountMemory);
  await tick(full, k.memory);
  assert.equal(k.sent.length, 0);
  // The client's check is done and the client has acted (the counter moved on): the keeper's own goes out.
  k.memory.get(ACCOUNT)!.clientCheck = { at: T0 - 20 * S, acceptedAt: T0, counter: 6 };
  k.clock.now = T0 + 15 * S;
  await tick(full, k.memory);
  assert.deepEqual(k.sent.map((s) => s.account), [ACCOUNT]);
});

test("49.4, one door for every check: two for one account go out one after the other, two accounts don't wait for each other, and a failure doesn't hold the next", async () => {
  const order: string[] = [];
  const gates = new Map<string, () => void>();
  const send = oneAtATime(async (account: string, tag: string) => {
    order.push(`start ${tag}`);
    await new Promise<void>((resolve) => gates.set(tag, resolve));
    order.push(`end ${tag}`);
    if (tag === "a1") throw new Error("the RPC failed");
    return tag;
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const a1 = send("a.pbf.testnet", "a1").catch((error: Error) => error.message);
  const a2 = send("a.pbf.testnet", "a2");
  const b1 = send("b.pbf.testnet", "b1");
  await settle();
  assert.deepEqual(order, ["start a1", "start b1"], "a2 waits for a1; b1 doesn't");
  gates.get("b1")!();
  gates.get("a1")!();
  await settle();
  assert.deepEqual(order, ["start a1", "start b1", "end b1", "end a1", "start a2"]);
  gates.get("a2")!();
  assert.deepEqual([await a1, await a2, await b1], ["the RPC failed", "a2", "b1"]);
});

test("49.4, the keeper sends a client's check to a client account of the factory only: <name>.<factory>, and nothing else", () => {
  for (const id of ["alice.pbf.testnet", "fund-move-11122212.pbf.testnet", "a_b.pbf.testnet"]) assert.equal(isClientAccount(id, "pbf.testnet"), true, id);
  for (const id of ["pbf.testnet", "alice.testnet", "a.b.pbf.testnet", ".pbf.testnet", "Alice.pbf.testnet", "alice.pbf.testnet.evil.testnet", "alicepbf.testnet", `${"a".repeat(60)}.pbf.testnet`, ""]) {
    assert.equal(isClientAccount(id, "pbf.testnet"), false, id);
  }
});

// ---------- POST /check on the status port ----------

const STATUS = { started_at: "2026-11-13T20:00:00.000Z", last_tick_at: null, tick_ms: 15_000, dry_run: false, log_file: "x", accounts: {} } as unknown as KeeperStatus;

async function door(options: { token?: string | null; answer?: ClientCheckAnswer | Error; none?: boolean } = {}) {
  const ran: { account: string; intent: unknown }[] = [];
  const tokenReads = { n: 0 };
  const check = {
    token: () => ((tokenReads.n += 1), options.token === undefined ? TOKEN : options.token),
    run: async (account: string, intent: unknown) => {
      ran.push({ account, intent });
      if (options.answer instanceof Error) throw options.answer;
      return options.answer ?? ({ accepted: true, blk: 5_000, tries: 1, tx: "tx-1" } as ClientCheckAnswer);
    },
  };
  const server = options.none ? statusServer(() => STATUS) : statusServer(() => STATUS, check);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const call = async (method: string, path: string, init: { token?: string; body?: string } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { call, ran, tokenReads, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
const BODY = JSON.stringify({ account: ACCOUNT, intent: { check: {} } });

test("49.4, POST /check with the service token runs the check and answers what it brought", async () => {
  const d = await door();
  try {
    const answer = await d.call("POST", "/check", { token: TOKEN, body: BODY });
    assert.deepEqual([answer.status, answer.body], [200, { accepted: true, blk: 5_000, tries: 1, tx: "tx-1" }]);
    assert.deepEqual(d.ran, [{ account: ACCOUNT, intent: { check: {} } }]);
  } finally {
    await d.close();
  }
});

test("49.4, POST /check is refused without the service token: no header, another token, a token of another length, and a keeper with no token on file are each 401, and no check runs", async () => {
  const d = await door();
  try {
    for (const token of [undefined, `svc.${"ab".repeat(32)}`, "svc.short", `${TOKEN}0`]) {
      const answer = await d.call("POST", "/check", { ...(token ? { token } : {}), body: BODY });
      assert.deepEqual([answer.status, answer.body.error], [401, "unauthorized"], String(token));
      assert.ok(!JSON.stringify(answer.body).includes(TOKEN.slice(4)), "the refusal never repeats the token");
    }
    // A body that isn't even JSON is refused the same way: the token is looked at first.
    assert.equal((await d.call("POST", "/check", { body: "{not json" })).status, 401);
    assert.equal(d.ran.length, 0);
  } finally {
    await d.close();
  }
  const noFile = await door({ token: null });
  try {
    assert.equal((await noFile.call("POST", "/check", { token: TOKEN, body: BODY })).status, 401);
    assert.equal(noFile.ran.length, 0);
  } finally {
    await noFile.close();
  }
});

test("49.4, POST /check reads the token file at each call, so a backend started again is known without starting the keeper again", async () => {
  const d = await door();
  try {
    await d.call("POST", "/check", { token: TOKEN, body: BODY });
    await d.call("POST", "/check", { token: TOKEN, body: BODY });
    assert.equal(d.tokenReads.n, 2);
  } finally {
    await d.close();
  }
});

test("49.4, POST /check with the token and a body that isn't {account, intent}, isn't JSON or is over 4 KB is 400, and no check runs; a check that throws is 500 with no detail", async () => {
  const d = await door();
  try {
    for (const body of [JSON.stringify({ account: ACCOUNT }), JSON.stringify({ intent: { check: {} } }), JSON.stringify({ account: 5, intent: { check: {} } }), JSON.stringify({ account: ACCOUNT, intent: "check" }), "{not json", JSON.stringify({ account: ACCOUNT, intent: { check: {} }, pad: "x".repeat(5_000) })]) {
      const answer = await d.call("POST", "/check", { token: TOKEN, body });
      assert.deepEqual([answer.status, answer.body.error], [400, "bad_request"], body.slice(0, 60));
    }
    assert.equal(d.ran.length, 0);
  } finally {
    await d.close();
  }
  const broken = await door({ answer: new Error(`secret ${TOKEN}`) });
  try {
    const answer = await broken.call("POST", "/check", { token: TOKEN, body: BODY });
    assert.deepEqual([answer.status, answer.body.error], [500, "internal"]);
    assert.ok(!JSON.stringify(answer.body).includes("secret"));
  } finally {
    await broken.close();
  }
});

test("49.4, the status page answers as before beside the new door, and a keeper without the door has no POST /check", async () => {
  const d = await door();
  try {
    for (const path of ["/", "/status"]) {
      const status = await d.call("GET", path);
      assert.deepEqual([status.status, status.body.tick_ms], [200, 15_000], path);
    }
    assert.equal((await d.call("GET", "/check", { token: TOKEN })).status, 404);
  } finally {
    await d.close();
  }
  const none = await door({ none: true });
  try {
    assert.equal((await none.call("POST", "/check", { token: TOKEN, body: BODY })).status, 404);
  } finally {
    await none.close();
  }
});
