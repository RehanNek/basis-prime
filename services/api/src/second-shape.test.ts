// The app's second shape (INTERFACES.md 49.3 and 49.4), the backend's side: the check the broker pays for, the Perps
// screen's market reads, the Spot screen's tokens and swap quotes, and the portfolio's points. Against fakes: nothing
// here reaches a chain, Hyperliquid or 1Click. One rule, one test.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { QuoteRequest, QuoteResponse, StatusResponse, TokenInfo } from "@pb/oneclick";

import { CHECKS_PER_MINUTE, keeperCheckOver, postCheck, type KeeperCheck } from "./check.js";
import { apiConfig } from "./config.js";
import { fakeChain, fakeDeps, fakeFetch, fakeHl, T0 } from "./fakes.js";
import type { KeeperEvent } from "./drill.js";
import { DEPOSIT_MSG, postQuote, type Deps } from "./handlers.js";
import { TtlCache } from "./hl.js";
import { KeyedRateLimiter } from "./limiter.js";
import { BOOK_LEVELS, CANDLES_TTL_MS, getCandles, getPerp, MAX_CANDLES, PERPS_TTL_MS, TRADES_SHOWN } from "./perps.js";
import { getPortfolio, MAX_POINTS, PORTFOLIO_TTL_MS, portfolioPoints } from "./portfolio.js";
import { createApiServer } from "./server.js";
import { NOBODY, Sessions, type Who } from "./session.js";
import { getSpotTokens, MAX_SPOT_TOKENS, SPOT_TTL_MS } from "./spot.js";
import type { Universe } from "./universe.js";
import { HttpError } from "./validate.js";

const WALLET = "alice.testnet";
const OTHER = "mallory.testnet";
const OPERATOR = "pbf-ops.testnet";
const ALICE = "alice.pbf.testnet";
const OPEN = "demo.pbf.testnet";
const POOL = "pool.pbf.testnet";
const FACTORY = "pbf.testnet";
const USDC = "musdc.pbf-ops.testnet";
const NBTC = "mnbtc.pbf-ops.testnet";
const METH = "meth.pbf-ops.testnet";
const SVC = `svc.${"ab".repeat(32)}`;
const OWNER_ENV = { NEAR_NETWORK: "testnet", SHIM_NEAR_ACCOUNT_ID: "shim.pbf-ops.testnet", ACCOUNT_PRIVACY: "owner", OPEN_ACCOUNTS: OPEN };

const stateOf = (owner: string, principal = "0") => ({ owner, counter: 3, loan: { principal }, verdict: null, hl: null, pending: [], plan: null, next_move: 4 });
/** The account's own token list: the backend's two, and one more the account's settings carry. */
const TOKENS = [
  { id: USDC, decimals: 6, symbol: "USDC" },
  { id: NBTC, decimals: 8, symbol: "nBTC" },
  { id: METH, decimals: 18, symbol: "ETH" },
];

/** Dependencies with privacy on: ALICE belongs to WALLET, OPEN is open to anyone. */
export function world(options: { overrides?: Partial<Deps>; now?: () => number; views?: Record<string, unknown>; hlInfo?: Record<string, unknown> } = {}) {
  const now = options.now ?? (() => T0);
  const { chain, calls } = fakeChain({
    views: {
      [`${ALICE}.get_state`]: stateOf(WALLET),
      [`${ALICE}.get_config`]: { tokens: TOKENS },
      [`${OPEN}.get_state`]: stateOf("someone-else.testnet"),
      [`${OPEN}.get_config`]: { tokens: TOKENS },
      [`${FACTORY}.get_config`]: { tokens: TOKENS },
      [`${POOL}.get_params`]: { operator: OPERATOR },
      ...options.views,
    },
    wallets: [WALLET, OTHER],
  });
  const { hl, infoCalls } = fakeHl({ info: options.hlInfo ?? {} });
  const sessions = new Sessions({ serviceToken: SVC, now });
  const made = fakeDeps({ config: apiConfig(OWNER_ENV), chain, hl, hlCache: new TtlCache(now), sessions, now, readKeeperLog: () => ({ found: true, events: [] }), ...options.overrides });
  const wallet = (id: string): Who => ({ kind: "wallet", wallet: id });
  return { ...made, sessions, calls, infoCalls, wallet, token: (id: string) => sessions.issue(id, now()).token };
}

function rejectsWith(status: number, code: string, pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof HttpError, String(error));
    assert.deepEqual([error.status, error.code], [status, code], error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

async function serve(deps: Deps) {
  const server = createApiServer(deps, () => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const call = async (path: string, options: { token?: string; body?: unknown } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: options.body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { call, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A keeper that records what it is asked and answers from a list (the last answer repeats). */
function fakeKeeper(...answers: ({ status: number; body: unknown } | Error)[]) {
  const asked: { account: string; intent: unknown }[] = [];
  const keeper: KeeperCheck = async (account, intent) => {
    asked.push({ account, intent });
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { keeper, asked };
}
const ACCEPTED = { status: 200, body: { accepted: true, blk: 1234, tries: 1, tx: "Hash1" } };
const checks = (now: () => number = () => T0) => ({ limits: { ...fakeDeps().deps.limits, checks: new KeyedRateLimiter(CHECKS_PER_MINUTE, 60_000, now) } });

// ---------- 49.4: POST /api/check ----------

test("49.4, the owner's check goes to the keeper with the account and the intent, and the keeper's answer comes back as it is", async () => {
  const { keeper, asked } = fakeKeeper(ACCEPTED);
  const { deps, wallet } = world({ overrides: { keeperCheck: keeper, ...checks() } });
  const answer = await postCheck(deps, wallet(WALLET), { account: ALICE, intent: { borrow: { amount: "5000000" } } });
  assert.deepEqual(answer, { accepted: true, blk: 1234, tries: 1, tx: "Hash1" });
  assert.deepEqual(asked, [{ account: ALICE, intent: { borrow: { amount: "5000000" } } }]);
  // A withdrawal of a token only the account's own settings list (not one of the backend's two) is taken too.
  await postCheck(deps, wallet(WALLET), { account: ALICE, intent: { withdraw: { token: METH, amount: "7" } } });
  assert.deepEqual(asked[1], { account: ALICE, intent: { withdraw: { token: METH, amount: "7" } } });
});

test("49.4, a check the engine refused is a 200 with accepted false and the reason in the engine's words, with the tries and the last transaction", async () => {
  const { keeper } = fakeKeeper({ status: 200, body: { accepted: false, reason: "the withdrawal would leave the account below its margin", tries: 1, tx: "Hash2" } });
  const { deps, wallet } = world({ overrides: { keeperCheck: keeper, ...checks() } });
  const answer = await postCheck(deps, wallet(WALLET), { account: ALICE, intent: { check: {} } });
  assert.deepEqual(answer, { accepted: false, reason: "the withdrawal would leave the account below its margin", tries: 1, tx: "Hash2" });
});

test("49.4, nobody and nobody's token: 401 sign_in, before the chain, the limiter and the keeper are touched", async () => {
  const { keeper, asked } = fakeKeeper(ACCEPTED);
  const { deps, calls } = world({ overrides: { keeperCheck: keeper, ...checks() } });
  await assert.rejects(postCheck(deps, NOBODY, { account: ALICE, intent: { check: {} } }), rejectsWith(401, "sign_in"));
  assert.deepEqual([asked.length, calls.length], [0, 0]);
  assert.equal(deps.limits.checks!.take(ALICE), true, "nothing was taken from the account's six");
});

test("49.4, only the owner's wallet: another wallet, the operator's wallet and our own service token are each 403 not_yours, and the keeper isn't asked", async () => {
  const { keeper, asked } = fakeKeeper(ACCEPTED);
  const { deps, wallet } = world({ overrides: { keeperCheck: keeper, ...checks() } });
  const body = { account: ALICE, intent: { check: {} } };
  await assert.rejects(postCheck(deps, wallet(OTHER), body), rejectsWith(403, "not_yours", /another wallet/));
  await assert.rejects(postCheck(deps, wallet(OPERATOR), body), rejectsWith(403, "not_yours"));
  await assert.rejects(postCheck(deps, { kind: "service" }, body), rejectsWith(403, "not_yours", /Only the wallet that owns/));
  // An open account is open to read, not to spend the keeper's NEAR on: its owner alone may ask.
  await assert.rejects(postCheck(deps, wallet(WALLET), { account: OPEN, intent: { check: {} } }), rejectsWith(403, "not_yours"));
  assert.equal(asked.length, 0);
  // A stranger's asks don't use up the owner's six a minute.
  for (let i = 0; i < CHECKS_PER_MINUTE; i += 1) assert.equal((await postCheck(deps, wallet(WALLET), body)).accepted, true);
});

test("49.4, an account that isn't a client account is 400, one with no state yet is 404 no_account, and a bad intent is 400: none reaches the keeper", async () => {
  const { keeper, asked } = fakeKeeper(ACCEPTED);
  const { deps, wallet } = world({ overrides: { keeperCheck: keeper, ...checks() } });
  await assert.rejects(postCheck(deps, wallet(WALLET), { account: "alice.testnet", intent: { check: {} } }), rejectsWith(400, "bad_request"));
  await assert.rejects(postCheck(deps, wallet(WALLET), { account: "new.pbf.testnet", intent: { check: {} } }), rejectsWith(404, "no_account"));
  await assert.rejects(postCheck(deps, wallet(WALLET), { account: ALICE, intent: { withdraw: { token: "other.testnet", amount: "1" } } }), rejectsWith(400, "bad_request"));
  await assert.rejects(postCheck(deps, wallet(WALLET), { account: ALICE, intent: { drain: {} } }), rejectsWith(400, "bad_request"));
  await assert.rejects(postCheck(deps, wallet(WALLET), { account: ALICE }), rejectsWith(400, "bad_request"));
  assert.equal(asked.length, 0);
});

test("49.4, six checks a minute for an account: the seventh is 429 too_many_checks without the keeper, another account has its own six, and the next minute starts again", async () => {
  let now = T0;
  const { keeper, asked } = fakeKeeper(ACCEPTED);
  const { deps, wallet } = world({ now: () => now, overrides: { keeperCheck: keeper, ...checks(() => now) }, views: { "bob.pbf.testnet.get_state": stateOf(WALLET), "bob.pbf.testnet.get_config": { tokens: TOKENS } } });
  const body = { account: ALICE, intent: { check: {} } };
  assert.equal(CHECKS_PER_MINUTE, 6);
  for (let i = 0; i < 6; i += 1) await postCheck(deps, wallet(WALLET), body);
  await assert.rejects(postCheck(deps, wallet(WALLET), body), rejectsWith(429, "too_many_checks"));
  assert.equal(asked.length, 6);
  assert.equal((await postCheck(deps, wallet(WALLET), { account: "bob.pbf.testnet", intent: { check: {} } })).accepted, true);
  now += 60_001;
  assert.equal((await postCheck(deps, wallet(WALLET), body)).accepted, true);
});

test("49.4, the keeper isn't running: 503 keeper_off when it can't be reached, when the backend has no door to it, and when it doesn't know this backend's token", async () => {
  const body = { account: ALICE, intent: { check: {} } };
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const down = world({ overrides: { keeperCheck: fakeKeeper(refused).keeper, ...checks() } });
  await assert.rejects(postCheck(down.deps, down.wallet(WALLET), body), rejectsWith(503, "keeper_off", /from your wallet/));
  const none = world({ overrides: checks() });
  await assert.rejects(postCheck(none.deps, none.wallet(WALLET), body), rejectsWith(503, "keeper_off"));
  for (const status of [401, 404]) {
    const old = world({ overrides: { keeperCheck: fakeKeeper({ status, body: { error: "unauthorized" } }).keeper, ...checks() } });
    await assert.rejects(postCheck(old.deps, old.wallet(WALLET), body), rejectsWith(503, "keeper_off"), String(status));
  }
  // The keeper answered and made no sense of it: the page falls back as well (it waits only on 502 and 504).
  const odd = world({ overrides: { keeperCheck: fakeKeeper({ status: 500, body: null }).keeper, ...checks() } });
  await assert.rejects(postCheck(odd.deps, odd.wallet(WALLET), body), rejectsWith(503, "keeper_failed"));
});

test("49.4, a check cut off by the wait is 504 check_slow, so the page keeps watching the account and doesn't send a second check", async () => {
  const slow = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const { deps, wallet } = world({ overrides: { keeperCheck: fakeKeeper(slow).keeper, ...checks() } });
  await assert.rejects(postCheck(deps, wallet(WALLET), { account: ALICE, intent: { check: {} } }), rejectsWith(504, "check_slow"));
});

test("49.4, with privacy off the route isn't there: 404, whoever asks", async () => {
  const { keeper, asked } = fakeKeeper(ACCEPTED);
  const { deps } = fakeDeps({ keeperCheck: keeper });
  await assert.rejects(postCheck(deps, NOBODY, { account: ALICE, intent: { check: {} } }), rejectsWith(404, "not_found"));
  await assert.rejects(postCheck(deps, { kind: "wallet", wallet: WALLET }, { account: ALICE, intent: { check: {} } }), rejectsWith(404, "not_found"));
  assert.equal(asked.length, 0);
  const { call, close } = await serve(deps);
  try {
    assert.equal((await call("/api/check", { body: { account: ALICE, intent: { check: {} } } })).status, 404);
  } finally {
    await close();
  }
});

test("49.4 over HTTP: POST /api/check is 401 with no token, 403 for another wallet and for the service token, and the keeper's answer for the owner", async () => {
  const { keeper, asked } = fakeKeeper(ACCEPTED);
  const { deps, token } = world({ overrides: { keeperCheck: keeper, ...checks() } });
  const { call, close } = await serve(deps);
  try {
    const body = { account: ALICE, intent: { check: {} } };
    assert.deepEqual([(await call("/api/check", { body })).status, (await call("/api/check", { body })).body.error], [401, "sign_in"]);
    assert.equal((await call("/api/check", { body, token: "v1.bad.token" })).status, 401);
    assert.equal((await call("/api/check", { body, token: token(OTHER) })).status, 403);
    assert.equal((await call("/api/check", { body, token: SVC })).status, 403);
    assert.equal(asked.length, 0);
    const mine = await call("/api/check", { body, token: token(WALLET) });
    assert.deepEqual([mine.status, mine.body], [200, { accepted: true, blk: 1234, tries: 1, tx: "Hash1" }]);
  } finally {
    await close();
  }
});

test("49.4, the backend's call to the keeper: POST <keeper>/check with the service token as a bearer and {account, intent}, and the status and body as they came", async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { accepted: true, blk: 9, tries: 2, tx: "H" } }, { status: 401, body: { error: "unauthorized" } }, { status: 500, body: "not json" });
  const keeper = keeperCheckOver("http://127.0.0.1:8789", SVC, 120_000, impl);
  assert.deepEqual(await keeper(ALICE, { check: {} }), { status: 200, body: { accepted: true, blk: 9, tries: 2, tx: "H" } });
  assert.deepEqual([calls[0]!.url, calls[0]!.method, calls[0]!.headers.Authorization, calls[0]!.body], ["http://127.0.0.1:8789/check", "POST", `Bearer ${SVC}`, { account: ALICE, intent: { check: {} } }]);
  assert.deepEqual(await keeper(ALICE, { check: {} }), { status: 401, body: { error: "unauthorized" } });
  assert.deepEqual(await keeper(ALICE, { check: {} }), { status: 500, body: null });
  assert.equal(apiConfig({}).keeperUrl, "http://127.0.0.1:8789");
  assert.equal(apiConfig({ KEEPER_PORT: "9001" }).keeperUrl, "http://127.0.0.1:9001");
});

// ---------- 49.3: GET /api/perps/:coin and its candles ----------

const META = { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "SOL", szDecimals: 2, maxLeverage: 20 }] };
const CTXS = [
  { markPx: "75824.0", oraclePx: "75929.3", midPx: "75819.5", dayNtlVlm: "1234567.8", funding: "0.0000125", openInterest: "912.4", prevDayPx: "75000.0" },
  { markPx: "150.1", oraclePx: "150.0", midPx: "150.05", dayNtlVlm: "5", funding: "-0.00001", openInterest: "7", prevDayPx: "149" },
];
const level = (px: number, sz: string) => ({ px: String(px), sz, n: 2 });
const BOOK = { coin: "BTC", time: T0, levels: [Array.from({ length: 30 }, (_, i) => level(75_820 - i, "0.5")), Array.from({ length: 30 }, (_, i) => level(75_821 + i, "0.25"))] };
const TRADES = Array.from({ length: 50 }, (_, i) => ({ coin: "BTC", side: i % 2 ? "A" : "B", px: "75820.0", sz: "0.01", time: T0 - 50_000 + i * 1_000, hash: `0x${i}`, tid: i, users: ["0x1", "0x2"] }));
const candle = (t: number) => ({ t, T: t + 3_599_999, s: "BTC", i: "1h", o: "1", c: "2", h: "3", l: "0.5", v: "10", n: 4 });
const HL_INFO = { metaAndAssetCtxs: [META, CTXS], l2Book: BOOK, recentTrades: TRADES, candleSnapshot: [candle(T0 - 3_600_000), candle(T0 - 7_200_000), candle(T0 - 10_800_000)] };

test("49.3, GET /api/perps/BTC answers the market's figures, twenty levels a side and the last forty trades, newest first, as Hyperliquid's own strings", async () => {
  const { deps, infoCalls } = world({ hlInfo: HL_INFO });
  const answer = await getPerp(deps, "BTC");
  assert.deepEqual(Object.keys(answer), ["coin", "ctx", "book", "trades", "read_at_ms"]);
  assert.deepEqual([answer.coin, answer.read_at_ms], ["BTC", T0]);
  assert.deepEqual(answer.ctx, { mark: "75824.0", oracle: "75929.3", funding: "0.0000125", open_interest: "912.4", day_volume: "1234567.8", prev_day_px: "75000.0" });
  assert.deepEqual([answer.book.bids.length, answer.book.asks.length], [BOOK_LEVELS, BOOK_LEVELS]);
  assert.deepEqual([answer.book.bids[0], answer.book.asks[0]], [{ px: "75820", sz: "0.5", n: 2 }, { px: "75821", sz: "0.25", n: 2 }]);
  assert.equal(answer.trades.length, TRADES_SHOWN);
  assert.deepEqual(answer.trades[0], { side: "A", px: "75820.0", sz: "0.01", time: T0 - 1_000, tid: 49 }, "the newest first, and nobody's address");
  // Hyperliquid's own request shapes, one of each.
  assert.deepEqual(infoCalls, [{ type: "metaAndAssetCtxs" }, { type: "l2Book", coin: "BTC" }, { type: "recentTrades", coin: "BTC" }]);
  // The coin is taken as our list writes it, whatever the case in the path.
  assert.equal((await getPerp(deps, "btc")).coin, "BTC");
});

test("49.3, the perps routes answer our own coins only: another coin is 404 unknown_coin and Hyperliquid isn't asked; a coin of ours that testnet lacks is 404 not_listed", async () => {
  const { deps, infoCalls } = world({ hlInfo: HL_INFO });
  await assert.rejects(getPerp(deps, "DOGE"), rejectsWith(404, "unknown_coin"));
  await assert.rejects(getCandles(deps, "DOGE", new URLSearchParams()), rejectsWith(404, "unknown_coin"));
  await assert.rejects(getPerp(deps, "BTC/../x"), rejectsWith(400, "bad_request"));
  assert.equal(infoCalls.length, 0);
  // XRP is on our list (fakes.ts) and not in this testnet's universe.
  await assert.rejects(getPerp(deps, "XRP"), rejectsWith(404, "not_listed"));
});

test("49.3, a market's answer is kept one second and shared: ten pages at once cost Hyperliquid one read of each kind, and a second later it reads again", async () => {
  let now = T0;
  const { deps, infoCalls } = world({ hlInfo: HL_INFO, now: () => now });
  assert.equal(PERPS_TTL_MS, 1_000);
  await Promise.all(Array.from({ length: 10 }, () => getPerp(deps, "BTC")));
  assert.equal(infoCalls.length, 3);
  now += 999;
  await getPerp(deps, "BTC");
  assert.equal(infoCalls.length, 3);
  now += 2;
  await getPerp(deps, "BTC");
  assert.equal(infoCalls.filter((c) => c.type === "l2Book").length, 2);
  assert.equal(infoCalls.filter((c) => c.type === "recentTrades").length, 2);
});

test("49.3, GET /api/perps/BTC/candles asks Hyperliquid's candleSnapshot for the last n candles and answers them oldest first; 1h and 200 unless said", async () => {
  const { deps, infoCalls } = world({ hlInfo: HL_INFO });
  const answer = await getCandles(deps, "BTC", new URLSearchParams("interval=1h&n=3"));
  assert.deepEqual(Object.keys(answer), ["coin", "interval", "candles", "read_at_ms"]);
  assert.deepEqual([answer.coin, answer.interval, answer.read_at_ms], ["BTC", "1h", T0]);
  assert.deepEqual(answer.candles.map((c) => c.t), [T0 - 10_800_000, T0 - 7_200_000, T0 - 3_600_000]);
  assert.deepEqual(answer.candles[2], { t: T0 - 3_600_000, T: T0 - 1, o: "1", c: "2", h: "3", l: "0.5", v: "10", n: 4 });
  assert.deepEqual(infoCalls, [{ type: "candleSnapshot", req: { coin: "BTC", interval: "1h", startTime: T0 - 3 * 3_600_000, endTime: T0 } }]);
  await getCandles(deps, "BTC", new URLSearchParams());
  assert.deepEqual(infoCalls[1], { type: "candleSnapshot", req: { coin: "BTC", interval: "1h", startTime: T0 - 200 * 3_600_000, endTime: T0 } });
  // No more than asked for, the newest kept.
  assert.deepEqual((await getCandles(deps, "BTC", new URLSearchParams("interval=1h&n=2"))).candles.map((c) => c.t), [T0 - 7_200_000, T0 - 3_600_000]);
});

test("49.3, candles: an interval Hyperliquid doesn't have and an n that isn't 1 to 500 are 400 before Hyperliquid is asked", async () => {
  const { deps, infoCalls } = world({ hlInfo: HL_INFO });
  for (const bad of ["interval=2m", "interval=1H", "n=0", "n=501", "n=1.5", "n=abc", "n=-3"]) {
    await assert.rejects(getCandles(deps, "BTC", new URLSearchParams(bad)), rejectsWith(400, "bad_request"), bad);
  }
  assert.equal(MAX_CANDLES, 500);
  assert.equal(infoCalls.length, 0);
});

test("49.3, candles are kept five seconds for one coin, interval and n", async () => {
  let now = T0;
  const { deps, infoCalls } = world({ hlInfo: HL_INFO, now: () => now });
  assert.equal(CANDLES_TTL_MS, 5_000);
  await Promise.all(Array.from({ length: 10 }, () => getCandles(deps, "BTC", new URLSearchParams("interval=15m&n=50"))));
  now += 4_999;
  await getCandles(deps, "BTC", new URLSearchParams("interval=15m&n=50"));
  assert.equal(infoCalls.length, 1);
  await getCandles(deps, "BTC", new URLSearchParams("interval=1h&n=50"));
  assert.equal(infoCalls.length, 2, "another interval is another read");
  now += 2;
  await getCandles(deps, "BTC", new URLSearchParams("interval=15m&n=50"));
  assert.equal(infoCalls.length, 3);
});

test("49.3 over HTTP: the perps routes are open to anyone, signed in or not, with privacy on", async () => {
  const { deps } = world({ hlInfo: HL_INFO });
  const { call, close } = await serve(deps);
  try {
    const market = await call("/api/perps/BTC");
    assert.deepEqual([market.status, market.body.coin], [200, "BTC"]);
    const candles = await call("/api/perps/BTC/candles?interval=1h&n=3");
    assert.deepEqual([candles.status, (candles.body.candles as unknown[]).length], [200, 3]);
    assert.equal((await call("/api/perps/DOGE")).status, 404);
    assert.equal((await call("/api/perps/BTC/candles?interval=2m")).status, 400);
  } finally {
    await close();
  }
});

// ---------- 49.3: GET /api/spot/tokens ----------

const MAINNET_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const listed = (symbol: string, blockchain: string, assetId: string, decimals: number, price: number): TokenInfo => ({ assetId, decimals, blockchain, symbol, price, priceUpdatedAt: "2026-11-13T19:18:31.764Z" });
/** A cut of 1Click's own list as it was read on 13 Nov: several chains' entries for one symbol, in its order. */
const ONECLICK_LIST: TokenInfo[] = [
  listed("wNEAR", "near", "nep141:wrap.near", 24, 3.53),
  listed("BTC", "btc", "nep141:btc.omft.near", 8, 68_987),
  listed("BTC", "near", "nep141:nbtc.bridge.near", 8, 68_987),
  listed("ETH", "eth", "nep141:eth.omft.near", 18, 1_948.23),
  listed("ETH", "near", "nep141:eth.bridge.near", 18, 1_948.23),
  listed("SOL", "sol", "nep141:sol.omft.near", 9, 80.16),
  listed("XRP", "xrp", "nep141:xrp.omft.near", 6, 1.024),
  listed("USDC", "eth", "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", 6, 0.999529),
  listed("USDC", "near", MAINNET_USDC, 6, 0.999529),
  listed("USDT", "near", "nep141:usdt.tether-token.near", 6, 0.999298),
  listed("PEPE", "eth", "nep141:eth-0x6982508145454ce325ddbe47a25d4ec3d2311933.omft.near", 18, 4.46e-6),
  listed("TAO", "eth", "nep141:eth-0xtao.omft.near", 9, 300),
  listed("NEAR", "bsc", "nep141:bnb-0x1fa4a73a3f0133f0025378af00236f3abdee5d63.omdep.near", 18, 3.53),
];
const coinOf = (allowed: boolean, mcap?: number) => ({ allowed, tier: 3, hl_sz_decimals: 2, params: { price_band: 0.03, client_cap_usd: 1, book_cap_usd: 3 }, ...(mcap === undefined ? {} : { mcap_usd: mcap }) });
/** Our coins in the file's order, which is not the order of their size. HYPE isn't on 1Click's list; TAO isn't allowed. */
const SPOT_UNIVERSE: Universe = {
  coins: [
    ["SOL", coinOf(true, 40e9)],
    ["BTC", coinOf(true, 1_500e9)],
    ["HYPE", coinOf(true, 12e9)],
    ["NEAR", coinOf(true, 4e9)],
    ["ETH", coinOf(true, 230e9)],
    ["kPEPE", coinOf(true, 2e9)],
    ["XRP", coinOf(true, 60e9)],
    ["TAO", coinOf(false, 3e9)],
  ],
  hash: "00",
};
function fakeOneClickList(list: TokenInfo[] | Error = ONECLICK_LIST) {
  const reads = { n: 0 };
  return {
    reads,
    source: {
      async tokens() {
        reads.n += 1;
        if (list instanceof Error) throw list;
        return structuredClone(list);
      },
    },
  };
}
const spotWorld = (options: Parameters<typeof world>[0] & { list?: TokenInfo[] | Error } = {}) => {
  const one = fakeOneClickList(options.list);
  return { ...world({ ...options, overrides: { oneClickMainnet: one.source, universe: async () => SPOT_UNIVERSE, ...options.overrides } }), reads: one.reads };
};
/** Settings of before the deploy of 49.6: USDC and nBTC only. */
const TWO_TOKENS = { tokens: TOKENS.slice(0, 2), usdc_token: USDC };

test("49.3, the Spot list: USDC and USDT, then our perps coins that 1Click's list has, the biggest market first, each with 1Click's price", async () => {
  const { deps } = spotWorld({ views: { [`${FACTORY}.get_config`]: TWO_TOKENS } });
  const answer = await getSpotTokens(deps, new URLSearchParams());
  assert.deepEqual(Object.keys(answer), ["tokens", "read_at_ms"]);
  assert.equal(answer.read_at_ms, T0);
  // HYPE isn't on 1Click's list and TAO isn't one of our allowed coins: neither is shown.
  assert.deepEqual(answer.tokens.map((t) => t.symbol), ["USDC", "USDT", "BTC", "ETH", "XRP", "SOL", "NEAR", "PEPE"]);
  for (const t of answer.tokens) assert.deepEqual(Object.keys(t), ["symbol", "name", "price_usd", "on_intents", "intents_asset", "token_id", "decimals", "swaps_here", "lendable"], t.symbol);
  const by = Object.fromEntries(answer.tokens.map((t) => [t.symbol, t]));
  // BTC is the engine's nBTC: 1Click's entry for that very token, not its first BTC; our test token's id; it swaps here.
  assert.deepEqual(by.BTC, { symbol: "BTC", name: "Bitcoin", price_usd: 68_987, on_intents: true, intents_asset: "nep141:nbtc.bridge.near", token_id: NBTC, decimals: 8, swaps_here: true, lendable: true });
  assert.deepEqual(by.USDC, { symbol: "USDC", name: "USD Coin", price_usd: 0.999529, on_intents: true, intents_asset: MAINNET_USDC, token_id: USDC, decimals: 6, swaps_here: true, lendable: true });
  // ETH counts toward loans, and has no test token in these settings yet: its real price, and no swap here.
  assert.deepEqual(by.ETH, { symbol: "ETH", name: "Ethereum", price_usd: 1_948.23, on_intents: true, intents_asset: "nep141:eth.bridge.near", token_id: null, decimals: 18, swaps_here: false, lendable: true });
  // NEAR is 1Click's wNEAR on NEAR (not the "NEAR" it lists on another chain), and kPEPE's coin is its PEPE.
  assert.deepEqual([by.NEAR!.intents_asset, by.NEAR!.decimals, by.NEAR!.lendable, by.NEAR!.swaps_here], ["nep141:wrap.near", 24, true, false]);
  assert.deepEqual([by.PEPE!.name, by.PEPE!.price_usd, by.PEPE!.lendable], ["Pepe", 4.46e-6, false]);
  assert.deepEqual(by.SOL, { symbol: "SOL", name: "Solana", price_usd: 80.16, on_intents: true, intents_asset: "nep141:sol.omft.near", token_id: null, decimals: 9, swaps_here: false, lendable: false });
});

test("49.3, with an account the ids are that account's own settings': a token they list swaps here; an account with no contract gets the factory's", async () => {
  const { deps } = spotWorld({ views: { [`${FACTORY}.get_config`]: TWO_TOKENS } });
  const mine = await getSpotTokens(deps, new URLSearchParams({ account: ALICE }));
  const eth = mine.tokens.find((t) => t.symbol === "ETH")!;
  assert.deepEqual([eth.token_id, eth.swaps_here, eth.decimals], [METH, true, 18]);
  const fresh = await getSpotTokens(deps, new URLSearchParams({ account: "new.pbf.testnet" }));
  assert.deepEqual([fresh.tokens.find((t) => t.symbol === "ETH")!.token_id, fresh.tokens.find((t) => t.symbol === "BTC")!.token_id], [null, NBTC]);
  await assert.rejects(getSpotTokens(deps, new URLSearchParams({ account: "alice.testnet" })), rejectsWith(400, "bad_request"));
});

test("49.3, the Spot list is at most 25 tokens", async () => {
  const many: Universe = { coins: Array.from({ length: 40 }, (_, i) => [`C${i}`, coinOf(true, 1e9 - i)]), hash: "00" };
  const list = [...ONECLICK_LIST, ...Array.from({ length: 40 }, (_, i) => listed(`C${i}`, "eth", `nep141:c${i}.omft.near`, 18, 1))];
  const { deps } = spotWorld({ list, overrides: { universe: async () => many } });
  const answer = await getSpotTokens(deps, new URLSearchParams());
  assert.equal(MAX_SPOT_TOKENS, 25);
  assert.equal(answer.tokens.length, 25);
  assert.deepEqual(answer.tokens.slice(0, 3).map((t) => t.symbol), ["USDC", "USDT", "C0"]);
});

test("49.3, the Spot list is kept 60 seconds: many pages and two accounts cost 1Click one read, and a minute later it is read again", async () => {
  let now = T0;
  const { deps, reads, calls } = spotWorld({ now: () => now });
  assert.equal(SPOT_TTL_MS, 60_000);
  await Promise.all([...Array.from({ length: 10 }, () => getSpotTokens(deps, new URLSearchParams())), getSpotTokens(deps, new URLSearchParams({ account: ALICE }))]);
  now += 59_999;
  await getSpotTokens(deps, new URLSearchParams({ account: ALICE }));
  assert.equal(reads.n, 1);
  assert.equal(calls.filter((c) => c.startsWith(`${ALICE}.get_config`)).length, 1, "the account's settings are read once in the minute too");
  now += 2;
  await getSpotTokens(deps, new URLSearchParams());
  assert.equal(reads.n, 2);
});

test("49.3, 1Click's list not answering is 502 oneclick_unreachable and isn't kept: the next ask reads again; with no reader at all it is 503 spot_off", async () => {
  const down = spotWorld({ list: new Error("fetch failed") });
  await assert.rejects(getSpotTokens(down.deps, new URLSearchParams()), rejectsWith(502, "oneclick_unreachable"));
  await assert.rejects(getSpotTokens(down.deps, new URLSearchParams()), rejectsWith(502, "oneclick_unreachable"));
  assert.equal(down.reads.n, 2);
  const off = world();
  await assert.rejects(getSpotTokens(off.deps, new URLSearchParams()), rejectsWith(503, "spot_off"));
});

// ---------- 49.3: POST /api/quote with "swap" ----------

const DEPOSIT = "f".repeat(64);
/** A stand-in that prices every quote the same way and records what it was asked. */
function fakeQuotes(amountOut = "9900000") {
  const asked: QuoteRequest[] = [];
  const oneClick: Deps["oneClick"] = {
    baseUrl: "http://localhost:8787",
    async quote(request: QuoteRequest): Promise<QuoteResponse> {
      asked.push(request);
      return {
        correlationId: "q-9",
        quoteRequest: request,
        quote: { amountIn: request.amount, amountOut, minAmountOut: "9800000", timeEstimate: 20, deadline: request.deadline, ...(request.dry ? {} : { depositAddress: DEPOSIT }) },
      } as unknown as QuoteResponse;
    },
    async status(): Promise<StatusResponse> {
      return { correlationId: "q-9", status: "PROCESSING" } as StatusResponse;
    },
  };
  return { oneClick, asked };
}
const settingsOf = { tokens: TOKENS, usdc_token: USDC };

test("49.3, selling a token for USDC: the stand-in is asked for the two tokens by their NEAR ids, and the next call is a withdraw that records the sale with what should arrive", async () => {
  const { oneClick, asked } = fakeQuotes("9900000");
  const { deps } = world({ overrides: { oneClick }, views: { [`${ALICE}.get_config`]: settingsOf } });
  const answer = await postQuote(deps, { dry: false, swap: { from: NBTC, to: USDC }, account: ALICE, amount: "14000" });
  const deadline = T0 + 10 * 60_000;
  assert.deepEqual(asked, [
    {
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: `nep141:${NBTC}`,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: `nep141:${USDC}`,
      amount: "14000",
      refundTo: ALICE,
      refundType: "ORIGIN_CHAIN",
      recipient: ALICE,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(deadline).toISOString(),
      // The delivery, and a refund, carry the sale's own msg, so the account settles the transfer it listed.
      customRecipientMsg: JSON.stringify({ pb: { transfer: "move:4" } }),
    },
  ]);
  assert.equal(answer.quote.amountOut, "9900000");
  assert.deepEqual((answer as unknown as { swap: unknown }).swap, {
    from: NBTC,
    to: USDC,
    account: ALICE,
    next: { method: "withdraw", args: { token: NBTC, amount: "14000", receiver: DEPOSIT, transfer: { kind: "sell", exp: deadline, expect: { token: USDC, amount: "9900000" } } } },
    transfer_id: "move:4",
    exp_ms: deadline,
    delivers: { token: USDC, symbol: "USDC", amount: "9900000" },
    needs_check: null,
    swaps_here: true,
  });
  // The sale can be followed by its transfer's id, as a move can.
  assert.deepEqual(deps.moves?.find(ALICE, "move:4"), { depositAddress: DEPOSIT });
});

test("49.3, paying in USDC: a plain withdraw of USDC to the deposit address with no sale to record, and the token bought comes with the deposit msg", async () => {
  const { oneClick, asked } = fakeQuotes("14100");
  const { deps } = world({ overrides: { oneClick }, views: { [`${ALICE}.get_config`]: settingsOf } });
  const answer = (await postQuote(deps, { dry: false, swap: { from: USDC, to: NBTC }, account: ALICE, amount: "10000000", slippageTolerance: 50 })) as unknown as { swap: Record<string, unknown> };
  assert.deepEqual([asked[0]!.originAsset, asked[0]!.destinationAsset, asked[0]!.slippageTolerance, asked[0]!.customRecipientMsg], [`nep141:${USDC}`, `nep141:${NBTC}`, 50, DEPOSIT_MSG]);
  assert.deepEqual(answer.swap.next, { method: "withdraw", args: { token: USDC, amount: "10000000", receiver: DEPOSIT } });
  assert.deepEqual([answer.swap.transfer_id, answer.swap.exp_ms, answer.swap.delivers], [null, null, { token: NBTC, symbol: "nBTC", amount: "14100" }]);
  assert.equal(deps.moves?.find(ALICE, "move:4"), undefined);
});

test("49.3, a dry swap quote is a price only: no next call, no transfer named, and nothing kept", async () => {
  const { oneClick, asked } = fakeQuotes();
  const { deps } = world({ overrides: { oneClick }, views: { [`${ALICE}.get_config`]: settingsOf } });
  const answer = (await postQuote(deps, { dry: true, swap: { from: NBTC, to: USDC }, account: ALICE, amount: "14000" })) as unknown as { quote: { amountOut: string }; swap: Record<string, unknown> };
  assert.deepEqual([asked[0]!.dry, asked[0]!.customRecipientMsg], [true, DEPOSIT_MSG]);
  assert.deepEqual([answer.quote.amountOut, answer.swap.next, answer.swap.transfer_id, answer.swap.needs_check], ["9900000", null, null, null]);
});

test("49.3, a swap of a token only the account's own settings list (test ETH) is quoted like any other", async () => {
  const { oneClick, asked } = fakeQuotes();
  const { deps } = world({ overrides: { oneClick }, views: { [`${ALICE}.get_config`]: settingsOf } });
  const answer = (await postQuote(deps, { dry: false, swap: { from: METH, to: NBTC }, account: ALICE, amount: "5000000000000000" })) as unknown as { swap: { next: { args: { transfer: unknown } } } };
  assert.deepEqual([asked[0]!.originAsset, asked[0]!.destinationAsset], [`nep141:${METH}`, `nep141:${NBTC}`]);
  assert.deepEqual(answer.swap.next.args.transfer, { kind: "sell", exp: T0 + 10 * 60_000, expect: { token: NBTC, amount: "9900000" } });
});

test("49.3, needs_check for a swap is a move's: with a loan open, a withdrawal of the token and amount that leave; with none, null", async () => {
  const { oneClick } = fakeQuotes();
  const owing = world({ overrides: { oneClick }, views: { [`${ALICE}.get_state`]: stateOf(WALLET, "250000000"), [`${ALICE}.get_config`]: settingsOf } });
  for (const [from, to, amount] of [[NBTC, USDC, "14000"], [USDC, NBTC, "10000000"]] as const) {
    for (const dry of [true, false]) {
      const answer = (await postQuote(owing.deps, { dry, swap: { from, to }, account: ALICE, amount })) as unknown as { swap: { needs_check: unknown } };
      assert.deepEqual(answer.swap.needs_check, { withdraw: { token: from, amount } }, `${from} dry ${dry}`);
    }
  }
  const clear = world({ overrides: { oneClick }, views: { [`${ALICE}.get_config`]: settingsOf } });
  const none = (await postQuote(clear.deps, { dry: false, swap: { from: USDC, to: NBTC }, account: ALICE, amount: "1" })) as unknown as { swap: { needs_check: unknown } };
  assert.equal(none.swap.needs_check, null);
});

test("49.3, a swap the account can't make is refused before the stand-in is asked: a token that isn't the account's (400 not_here), the same token twice, a bad amount, no account", async () => {
  const { oneClick, asked } = fakeQuotes();
  const { deps } = world({ overrides: { oneClick }, views: { [`${ALICE}.get_config`]: TWO_TOKENS } });
  const ask = (body: Record<string, unknown>) => postQuote(deps, { dry: true, account: ALICE, amount: "5", ...body });
  await assert.rejects(ask({ swap: { from: USDC, to: METH } }), rejectsWith(400, "not_here", /mainnet/));
  await assert.rejects(ask({ swap: { from: "sol.testnet", to: USDC } }), rejectsWith(400, "not_here"));
  await assert.rejects(ask({ swap: { from: USDC, to: USDC } }), rejectsWith(400, "same_asset"));
  for (const swap of [{}, { from: USDC }, { from: 5, to: USDC }, "nBTC", null]) await assert.rejects(ask({ swap }), rejectsWith(400, "bad_request"), JSON.stringify(swap));
  for (const amount of ["0", "-1", "1.5", 5, undefined]) await assert.rejects(ask({ swap: { from: USDC, to: NBTC }, amount }), rejectsWith(400, "bad_request"), String(amount));
  await assert.rejects(ask({ swap: { from: USDC, to: NBTC }, dry: "yes" }), rejectsWith(400, "bad_request"));
  await assert.rejects(ask({ swap: { from: USDC, to: NBTC }, account: "alice.testnet" }), rejectsWith(400, "bad_request"));
  await assert.rejects(ask({ swap: { from: USDC, to: NBTC }, account: "new.pbf.testnet" }), rejectsWith(404, "not_deployed"));
  assert.equal(asked.length, 0);
});

// ---------- 49.3: GET /api/portfolio/:account ----------

const line = (t: string, event: string, account: string, more: Record<string, unknown>): KeeperEvent => ({ t, event, account, ...more });
const LOG: KeeperEvent[] = [
  line("2026-11-13T10:00:00.000Z", "verdict", ALICE, { blk: 100, eq: 1_500_000_000, debt: "500000000", state: "HEALTHY" }),
  line("2026-11-13T10:00:01.000Z", "account", ALICE, { loan: true }),
  line("2026-11-13T10:30:00.000Z", "verdict", OPEN, { blk: 150, eq: 77, debt: "1" }),
  // A check the keeper's own loop asked for: the line has no figures, and its verdict line follows.
  line("2026-11-13T11:00:00.000Z", "check", ALICE, { tx: "H1", accepted: true }),
  line("2026-11-13T11:00:20.000Z", "verdict", ALICE, { blk: 200, eq: 1_480_000_000 }),
  // A check the client's page asked for carries the figures, and the loop then logs the same verdict again.
  line("2026-11-13T12:00:00.000Z", "check", ALICE, { tx: "H2", accepted: true, blk: 300, eq: 1_510_000_000, debt: "480000000" }),
  line("2026-11-13T12:00:09.000Z", "verdict", ALICE, { blk: 300, eq: 1_510_000_000, debt: "480000000" }),
  line("2026-11-13T12:30:00.000Z", "check", ALICE, { tx: "H3", accepted: false, reason: "OutLayer returned no verdict" }),
  line("2026-11-13T13:00:00.000Z", "verdict", ALICE, { blk: 400, eq: -2_000_000, debt: "480000000" }),
];

test("49.3, the portfolio's points: one per verdict the keeper's log shows for the account, oldest first, with the equity and the debt to our pool", async () => {
  const { deps } = world({ overrides: { readKeeperLog: () => ({ found: true, events: [...LOG].reverse() }) } });
  const answer = await getPortfolio(deps, ALICE);
  assert.deepEqual(Object.keys(answer), ["points", "read_at_ms", "keeper_log"]);
  assert.deepEqual(answer.points, [
    { t_ms: Date.parse("2026-11-13T10:00:00.000Z"), equity_micro: 1_500_000_000, debt_micro: 500_000_000 },
    // A line from before the debt was logged: the point is drawn, and its debt is unknown.
    { t_ms: Date.parse("2026-11-13T11:00:20.000Z"), equity_micro: 1_480_000_000, debt_micro: null },
    { t_ms: Date.parse("2026-11-13T12:00:00.000Z"), equity_micro: 1_510_000_000, debt_micro: 480_000_000 },
    { t_ms: Date.parse("2026-11-13T13:00:00.000Z"), equity_micro: -2_000_000, debt_micro: 480_000_000 },
  ]);
  assert.deepEqual([answer.read_at_ms, answer.keeper_log], [T0, true]);
  // Another account's lines are another account's.
  assert.deepEqual(portfolioPoints(LOG, OPEN), [{ t_ms: Date.parse("2026-11-13T10:30:00.000Z"), equity_micro: 77, debt_micro: 1 }]);
});

test("49.3, the portfolio is cheap: the log is read once in 30 seconds for an account, only the newest 500 points are kept, and no log is no points", async () => {
  let now = T0;
  let reads = 0;
  const many = Array.from({ length: 600 }, (_, i) => line(new Date(T0 - (600 - i) * 60_000).toISOString(), "verdict", ALICE, { blk: i, eq: i }));
  const { deps, calls } = world({ now: () => now, overrides: { readKeeperLog: () => ((reads += 1), { found: true, events: many }) } });
  const first = await getPortfolio(deps, ALICE);
  assert.deepEqual([PORTFOLIO_TTL_MS, MAX_POINTS, first.points.length, first.points[0]!.equity_micro, first.points.at(-1)!.equity_micro], [30_000, 500, 500, 100, 599]);
  now += 29_999;
  await getPortfolio(deps, ALICE);
  assert.equal(reads, 1);
  now += 2;
  await getPortfolio(deps, ALICE);
  assert.equal(reads, 2);
  assert.equal(calls.length, 0, "nothing is read from the chain");
  const none = world({ overrides: { readKeeperLog: () => ({ found: false, events: [] }) } });
  assert.deepEqual(await getPortfolio(none.deps, ALICE), { points: [], read_at_ms: T0, keeper_log: false });
  await assert.rejects(getPortfolio(none.deps, "alice.testnet"), rejectsWith(400, "bad_request"));
});

// ---------- 49.3 and 48.5: who may ask the new routes ----------

const GUARDED: { name: string; path: (id: string) => string; body?: (id: string) => unknown }[] = [
  { name: "GET /api/spot/tokens?account=", path: (id) => `/api/spot/tokens?account=${id}` },
  { name: "GET /api/portfolio/<id>", path: (id) => `/api/portfolio/${id}` },
  { name: "POST /api/quote with swap", path: () => "/api/quote", body: (id) => ({ dry: true, swap: { from: NBTC, to: USDC }, account: id, amount: "14000" }) },
];

for (const route of GUARDED) {
  test(`49.3, ${route.name}: 401 with nothing, 403 for another wallet, before any work; the route's own answer for the owner, the service token and an open account`, async () => {
    const quotes = fakeQuotes();
    const one = fakeOneClickList();
    let logReads = 0;
    const { deps, token, calls } = world({
      overrides: { oneClick: quotes.oneClick, oneClickMainnet: one.source, universe: async () => SPOT_UNIVERSE, readKeeperLog: () => ((logReads += 1), { found: true, events: LOG }) },
      views: { [`${ALICE}.get_config`]: settingsOf, [`${OPEN}.get_config`]: settingsOf },
    });
    const { call, close } = await serve(deps);
    try {
      const options = (id: string) => (route.body ? { body: route.body(id) } : {});
      const nobody = await call(route.path(ALICE), options(ALICE));
      assert.deepEqual([nobody.status, nobody.body.error], [401, "sign_in"]);
      const stranger = await call(route.path(ALICE), { ...options(ALICE), token: token(OTHER) });
      assert.deepEqual([stranger.status, stranger.body.error], [403, "not_yours"]);
      // The stranger cost one read of the account's owner, and nothing else: no settings, no 1Click, no log.
      assert.deepEqual(calls, [`${ALICE}.get_state({})`]);
      assert.deepEqual([quotes.asked.length, one.reads.n, logReads], [0, 0, 0]);
      for (const [who, id, tok] of [["the owner", ALICE, token(WALLET)], ["the service", ALICE, SVC], ["anyone, an open account", OPEN, undefined]] as const) {
        const answer = await call(route.path(id), { ...options(id), ...(tok ? { token: tok } : {}) });
        assert.equal(answer.status, 200, `${who}: ${JSON.stringify(answer.body)}`);
      }
    } finally {
      await close();
    }
  });
}

test("49.3 over HTTP: the Spot list with no account is open to anyone, and a deposit quote stays open beside the swap's guard", async () => {
  const one = fakeOneClickList();
  const { deps } = world({ overrides: { oneClickMainnet: one.source, universe: async () => SPOT_UNIVERSE } });
  const { call, close } = await serve(deps);
  try {
    const list = await call("/api/spot/tokens");
    assert.deepEqual([list.status, (list.body.tokens as { symbol: string }[])[0]!.symbol], [200, "USDC"]);
    const deposit = await call("/api/quote", { body: { dry: true, originAsset: "nep141:x", destinationAsset: "nep141:y", refundTo: "a.testnet", amount: "5", recipient: ALICE } });
    assert.equal(deposit.status, 200);
  } finally {
    await close();
  }
});
