// Privacy level 1 (INTERFACES.md 48): the sign-in, who is asking, who may see an account, and every route of 48.5's
// table, against fakes. Nothing here reaches a chain. One rule, one test.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { apiConfig, DEFAULT_SERVICE_TOKEN_FILE } from "./config.js";
import { fakeChain, fakeDeps, fakeHl, T0 } from "./fakes.js";
import { getConfig, type Deps } from "./handlers.js";
import { postOrder } from "./hl-handlers.js";
import { RateLimiter } from "./limiter.js";
import { nep413Hash } from "./nep413.js";
import { getMyAccounts, getPricing } from "./pricing.js";
import { NearRpc, RpcError } from "./rpc.js";
import { createApiServer } from "./server.js";
import { mayView, newServiceToken, NOBODY, OWNER_CACHE_MS, postSession, removeServiceToken, SESSION_MS, SESSION_RECIPIENT, Sessions, SIGN_INS_PER_MINUTE, who, writeServiceToken, type Who } from "./session.js";
import { HttpError } from "./validate.js";

const WALLET = "alice.testnet";
const OTHER = "mallory.testnet";
const OPERATOR = "pbf-ops.testnet";
const KEEPER = "pbf-keeper.testnet";
const ALICE = "alice.pbf.testnet";
const OPEN = "demo.pbf.testnet";
const POOL = "pool.pbf.testnet";
const FACTORY = "pbf.testnet";
const HL = "0x00000000000000000000000000000000000a11ce";
const SVC = `svc.${"ab".repeat(32)}`;
const MIN = 60_000;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** A wallet's key, as a wallet holds it: the private half signs, the public half is what NEAR lists. */
function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, text: `ed25519:${base58(publicKey.export({ format: "der", type: "spki" }).subarray(-32))}` };
}

const signInMessage = (wallet: string, until: number) => `Sign in to Prime Broker\nwallet: ${wallet}\nuntil: ${until}`;

/** What the app posts to sign a wallet in: section 48.2's message, signed the NEP-413 way for the sign-in's own recipient. */
function signIn(key: { privateKey: KeyObject; text: string }, options: { wallet?: string; until?: number; message?: string; recipient?: string; owner?: string } = {}) {
  const wallet = options.wallet ?? WALLET;
  const message = options.message ?? signInMessage(wallet, options.until ?? T0 + 10 * MIN);
  const recipient = options.recipient ?? SESSION_RECIPIENT;
  const nonce = randomBytes(32);
  const signature = sign(null, nep413Hash({ message, nonce, recipient }), key.privateKey);
  return { auth: { owner: options.owner ?? wallet, public_key: key.text, signature: signature.toString("base64"), message, nonce: nonce.toString("base64"), recipient } };
}

const OWNER_ENV = { NEAR_NETWORK: "testnet", SHIM_NEAR_ACCOUNT_ID: "shim.pbf-ops.testnet", ACCOUNT_PRIVACY: "owner", OPEN_ACCOUNTS: OPEN };

/** The account `id` as the chain shows it: a client account of `owner`, with a Hyperliquid address. */
const stateOf = (owner: string) => ({ owner, counter: 3, loan: { principal: "0" }, verdict: null, hl: { path: "hyperliquid-1", address: HL }, pending: [], plan: null, next_move: 4 });

/** Dependencies with privacy on: ALICE belongs to WALLET, OPEN is open to anyone, and `key` is WALLET's full-access key. */
function ownerDeps(options: { keys?: Record<string, "full" | "function_call" | "none" | Error>; overrides?: Partial<Deps>; now?: () => number } = {}) {
  const now = options.now ?? (() => T0);
  const pin = { risk: { project_id: "pbf-keeper.testnet/pb-risk", version_key: "c0ffee" }, gateway: { project_id: "pbf-keeper.testnet/pb-gateway", version_key: "9a7e" } };
  const { chain, calls } = fakeChain({
    views: {
      [`${ALICE}.get_state`]: stateOf(WALLET),
      [`${ALICE}.get_config`]: pin,
      [`${OPEN}.get_state`]: stateOf("someone-else.testnet"),
      [`${OPEN}.get_config`]: pin,
      "musdc.pbf-ops.testnet.ft_balance_of": "7",
      "mnbtc.pbf-ops.testnet.ft_balance_of": "0",
      [`${FACTORY}.list_accounts`]: [
        { account_id: "old.pbf.testnet", created_at: "1794000000000000000", owner: WALLET },
        { account_id: OPEN, created_at: "1794100000000000000", owner: "someone-else.testnet" },
        { account_id: ALICE, created_at: "1794200000000000000", owner: WALLET },
      ],
      [`${POOL}.get_params`]: { operator: OPERATOR, funding: { order: "cheapest", loan_days: 90 }, pricing_limits: { max_rate_bp: 6_000 }, tier_pricing: {} },
      [`${POOL}.get_pool`]: { fees_charged: "108", subsidy_paid: "0", subsidy_left_24h: "5" },
      [`${POOL}.get_pricing`]: { pricing: { fixed: { rate_bp: 650 } }, from: "account", fees_charged: "108", subsidy_paid: "0", credit: "0", settled_at: "1", last: [] },
      [`${POOL}.coin_statuses`]: [],
      [`${FACTORY}.get_config`]: {},
    },
    wallets: [WALLET, OTHER],
    keys: options.keys ?? {},
  });
  const meta = { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] };
  const ctxs = [{ markPx: "75824.0", oraclePx: "75929.3", midPx: "75819.5", dayNtlVlm: "1", funding: "0", openInterest: "9", prevDayPx: "75000" }];
  const { hl } = fakeHl({
    info: { metaAndAssetCtxs: [meta, ctxs], clearinghouseState: { marginSummary: {}, crossMarginSummary: {}, assetPositions: [], withdrawable: "0", time: T0 }, spotClearinghouseState: { balances: [] }, userAbstraction: "default", frontendOpenOrders: [], userFills: [], extraAgents: [] },
  });
  const sessions = new Sessions({ serviceToken: SVC, now });
  const made = fakeDeps({
    config: apiConfig(OWNER_ENV),
    chain,
    hl,
    sessions,
    now,
    readKeeperLog: () => ({ found: true, events: [] }),
    indexer: { host: "tx.test.fastnear.com", accountTxs: async () => ({ txs: [], total: 0, more: false }), transactions: async () => [] },
    ...options.overrides,
  });
  return { ...made, sessions, calls };
}

function rejectsWith(status: number, code: string, pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof HttpError, String(error));
    assert.deepEqual([error.status, error.code], [status, code], error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

// ---------- 48.1: the setting ----------

test("48.1: ACCOUNT_PRIVACY is owner unless it says off, and anything else stops the backend; OPEN_ACCOUNTS takes client accounts only", () => {
  assert.equal(apiConfig({}).accountPrivacy, "owner");
  assert.equal(apiConfig({ ACCOUNT_PRIVACY: "  " }).accountPrivacy, "owner");
  assert.equal(apiConfig({ ACCOUNT_PRIVACY: "owner" }).accountPrivacy, "owner");
  assert.equal(apiConfig({ ACCOUNT_PRIVACY: "off" }).accountPrivacy, "off");
  for (const bad of ["on", "OFF", "false", "0", "none"]) assert.throws(() => apiConfig({ ACCOUNT_PRIVACY: bad }), /ACCOUNT_PRIVACY must be "owner".*or "off"/, bad);
  assert.deepEqual(apiConfig({}).openAccounts, []);
  assert.deepEqual(apiConfig({ OPEN_ACCOUNTS: " a.pbf.testnet, b.pbf.testnet ,a.pbf.testnet," }).openAccounts, ["a.pbf.testnet", "b.pbf.testnet"]);
  for (const bad of ["alice.testnet", "a.b.pbf.testnet", "pbf.testnet", "A.pbf.testnet", "a.pbf.testnet;b.pbf.testnet"]) {
    assert.throws(() => apiConfig({ OPEN_ACCOUNTS: `a.pbf.testnet,${bad}` }), /OPEN_ACCOUNTS lists .* which isn't a client account/, bad);
  }
  assert.match(apiConfig({}).serviceTokenFile, /services\/api\/logs\/service-token$/);
  assert.equal(apiConfig({}).serviceTokenFile, DEFAULT_SERVICE_TOKEN_FILE);
  assert.equal(apiConfig({ SERVICE_TOKEN_FILE: "/tmp/x/token" }).serviceTokenFile, "/tmp/x/token");
});

// ---------- 48.2: sign-in ----------

test("48.2, a good sign-in: a full-access key of the wallet signs the three lines, and the answer is a token for that wallet for 12 hours", async () => {
  const key = newKey();
  const { deps, sessions, calls } = ownerDeps({ keys: { [`${WALLET} ${key.text}`]: "full" } });
  const answer = await postSession(deps, signIn(key));
  assert.deepEqual([answer.wallet, answer.expires_at_ms], [WALLET, T0 + SESSION_MS]);
  assert.equal(SESSION_MS, 12 * 60 * MIN);
  // v1.<base64url of {"w", "exp"}>.<base64url of the HMAC>
  const parts = answer.token.split(".");
  assert.deepEqual([parts.length, parts[0]], [3, "v1"]);
  assert.deepEqual(JSON.parse(Buffer.from(parts[1]!, "base64url").toString()), { w: WALLET, exp: T0 + SESSION_MS });
  assert.equal(Buffer.from(parts[2]!, "base64url").length, 32);
  assert.equal(sessions.walletOf(answer.token, T0 + 1), WALLET);
  assert.deepEqual(who(deps, bearer(answer.token)), { kind: "wallet", wallet: WALLET });
  assert.deepEqual(calls, [`accessKey(${WALLET})`], "one read of NEAR: the key");
});

test("48.2, a wrong signature is refused with 400 auth, before NEAR is asked", async () => {
  const [key, another] = [newKey(), newKey()];
  const { deps, calls } = ownerDeps({ keys: { [`${WALLET} ${key.text}`]: "full" } });
  const body = signIn(another);
  body.auth.public_key = key.text; // signed by another key than the one it names
  await assert.rejects(postSession(deps, body), rejectsWith(400, "auth"));
  // A message changed after signing fails the same way.
  const changed = signIn(key);
  changed.auth.message = signInMessage(WALLET, T0 + 9 * MIN);
  await assert.rejects(postSession(deps, changed), rejectsWith(400, "auth"));
  assert.deepEqual(calls, []);
});

test("48.2, the wallet line must be the signer: a message that names another wallet is 400 bad_request, and so is any other shape", async () => {
  const key = newKey();
  const { deps, calls } = ownerDeps({ keys: { [`${WALLET} ${key.text}`]: "full", [`${OTHER} ${key.text}`]: "full" } });
  await assert.rejects(postSession(deps, signIn(key, { owner: OTHER })), rejectsWith(400, "bad_request", /wallet line isn't auth\.owner/));
  for (const message of [
    `Sign in to Prime Broker\nwallet: ${WALLET}`,
    `Sign in to Prime Broker\nwallet: ${WALLET}\nuntil: ${T0 + MIN}\n`,
    `Sign in to Prime Broker\nwallet: ${WALLET}\nuntil: ${T0 + MIN}\nand: more`,
    `Sign in to Another App\nwallet: ${WALLET}\nuntil: ${T0 + MIN}`,
    `Sign in to Prime Broker\nwallet: ${WALLET}\nuntil: soon`,
    `Sign in to Prime Broker\nwallet: ${WALLET}\nuntil: 1.5`,
  ]) {
    await assert.rejects(postSession(deps, signIn(key, { message })), rejectsWith(400, "bad_request"), message);
  }
  await assert.rejects(postSession(deps, {}), rejectsWith(400, "bad_request"));
  await assert.rejects(postSession(deps, { auth: "x" }), rejectsWith(400, "bad_request"));
  assert.deepEqual(calls, []);
});

test("48.2, an order's signature can't sign a wallet in, and a sign-in's can't place an order: each takes its own recipient only", async () => {
  const key = newKey();
  const { deps } = ownerDeps({ keys: { [`${WALLET} ${key.text}`]: "full" } });
  await assert.rejects(postSession(deps, signIn(key, { recipient: "pb-gateway" })), rejectsWith(400, "bad_request", /auth\.recipient must be "pb-app-session"/));
  await assert.rejects(postOrder(deps, { account: ALICE, auth: signIn(key).auth }), rejectsWith(400, "bad_request", /auth\.recipient must be "pb-gateway"/));
});

test("48.2, a sign-in whose time has passed is 400 expired", async () => {
  const key = newKey();
  const { deps, calls } = ownerDeps({ keys: { [`${WALLET} ${key.text}`]: "full" } });
  await assert.rejects(postSession(deps, signIn(key, { until: T0 })), rejectsWith(400, "expired", /time has passed/));
  await assert.rejects(postSession(deps, signIn(key, { until: T0 - 1 })), rejectsWith(400, "expired"));
  assert.deepEqual(calls, []);
});

test("48.2, a sign-in dated more than 10 minutes and 60 seconds ahead is 400 expired; one exactly that far is taken", async () => {
  const key = newKey();
  const { deps } = ownerDeps({ keys: { [`${WALLET} ${key.text}`]: "full" } });
  await assert.rejects(postSession(deps, signIn(key, { until: T0 + 11 * MIN + 1 })), rejectsWith(400, "expired", /too far ahead/));
  assert.equal((await postSession(deps, signIn(key, { until: T0 + 11 * MIN }))).wallet, WALLET);
});

test("48.2, a nonce signs a wallet in once: the same message sent again is 409 nonce_used, until its time has passed", async () => {
  const key = newKey();
  let now = T0;
  const { deps } = ownerDeps({ keys: { [`${WALLET} ${key.text}`]: "full" }, now: () => now });
  const body = signIn(key);
  assert.equal((await postSession(deps, body)).wallet, WALLET);
  await assert.rejects(postSession(deps, structuredClone(body)), rejectsWith(409, "nonce_used"));
  now = T0 + 9 * MIN;
  await assert.rejects(postSession(deps, structuredClone(body)), rejectsWith(409, "nonce_used"));
  // Past its `until` the message is refused as expired, so the nonce needn't be kept any longer.
  now = T0 + 10 * MIN;
  await assert.rejects(postSession(deps, structuredClone(body)), rejectsWith(400, "expired"));
});

test("48.2, a key that isn't on the wallet is 403 not_your_key: anyone can make a key and sign as anyone", async () => {
  const [key, stranger] = [newKey(), newKey()];
  const { deps, calls } = ownerDeps({ keys: { [`${WALLET} ${key.text}`]: "full" } });
  await assert.rejects(postSession(deps, signIn(stranger)), rejectsWith(403, "not_your_key", /isn't a key of that wallet/));
  // The right key for another wallet is no key of this one.
  await assert.rejects(postSession(deps, signIn(key, { wallet: OTHER })), rejectsWith(403, "not_your_key"));
  assert.deepEqual(calls, [`accessKey(${WALLET})`, `accessKey(${OTHER})`]);
});

test("48.2, a function-call key is 403 not_your_key: an app's key for one contract doesn't speak for the wallet", async () => {
  const key = newKey();
  const { deps } = ownerDeps({ keys: { [`${WALLET} ${key.text}`]: "function_call" } });
  await assert.rejects(postSession(deps, signIn(key)), rejectsWith(403, "not_your_key", /can only call one contract/));
});

test("48.2, NEAR's RPC down is 503 and never a yes; the same message can be sent again once it answers", async () => {
  const key = newKey();
  const keys: Record<string, "full" | Error> = { [`${WALLET} ${key.text}`]: new RpcError("NEAR RPC (test.rpc.fastnear.com) did not answer: timeout") };
  const { deps } = ownerDeps({ keys });
  const body = signIn(key);
  await assert.rejects(postSession(deps, body), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.deepEqual([error.status, error.code], [503, "near_rpc"]);
    assert.doesNotMatch(error.message, /fastnear|timeout/, "the RPC's own words stay out of the answer");
    return true;
  });
  keys[`${WALLET} ${key.text}`] = "full";
  assert.equal((await postSession(deps, structuredClone(body))).wallet, WALLET, "the nonce wasn't spent on a read that failed");
});

test("48.2, at most 30 sign-ins a minute in all, counted only once a signature has passed", async () => {
  const key = newKey();
  const { deps } = ownerDeps({ keys: { [`${WALLET} ${key.text}`]: "full" } });
  assert.equal(SIGN_INS_PER_MINUTE, 30);
  // Garbage costs nothing of the limit.
  for (let i = 0; i < 40; i++) await assert.rejects(postSession(deps, { auth: { owner: WALLET } }), rejectsWith(400, "bad_request"));
  for (let i = 0; i < 30; i++) assert.equal((await postSession(deps, signIn(key))).wallet, WALLET);
  await assert.rejects(postSession(deps, signIn(key)), rejectsWith(429, "too_many_sign_ins"));
});

test("48.2, the access-key read: full access, a function-call key, no such key, no such account, and an RPC that doesn't answer", async () => {
  const asked: unknown[] = [];
  const rpc = (result: unknown, status = 200) =>
    new NearRpc({
      url: "https://rpc.example/key-in-path",
      cacheMs: 0,
      retryDelaysMs: [],
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        asked.push(JSON.parse(String(init?.body)).params);
        return new Response(JSON.stringify(result), { status });
      }) as typeof fetch,
    });
  const key = "ed25519:9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj";
  assert.equal(await rpc({ result: { permission: "FullAccess", nonce: 7, block_height: 1 } }).accessKey(WALLET, key), "full");
  assert.deepEqual(asked[0], { request_type: "view_access_key", finality: "final", account_id: WALLET, public_key: key });
  assert.equal(await rpc({ result: { permission: { FunctionCall: { allowance: null, receiver_id: "x.testnet", method_names: [] } }, nonce: 1 } }).accessKey(WALLET, key), "function_call");
  assert.equal(await rpc({ result: { error: `access key ${key} does not exist while viewing`, block_height: 1 } }).accessKey(WALLET, key), "none");
  assert.equal(await rpc({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" }, data: "no such key" } }).accessKey(WALLET, key), "none");
  assert.equal(await rpc({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } }).accessKey(WALLET, key), "none");
  // Anything else is an error, never a kind of key.
  await assert.rejects(rpc({ result: { error: "something else went wrong" } }).accessKey(WALLET, key), RpcError);
  await assert.rejects(rpc({ result: { nonce: 1 } }).accessKey(WALLET, key), RpcError);
  await assert.rejects(rpc("busy", 503).accessKey(WALLET, key), RpcError);
});

// ---------- 48.3: who is asking ----------

test("48.3, a changed token is no token: a token for another wallet, another expiry or with another signature names nobody", () => {
  const { deps, sessions } = ownerDeps();
  const { token } = sessions.issue(WALLET, T0);
  const [v, said, mac] = token.split(".") as [string, string, string];
  const forged = Buffer.from(JSON.stringify({ w: OPERATOR, exp: T0 + SESSION_MS })).toString("base64url");
  const later = Buffer.from(JSON.stringify({ w: WALLET, exp: T0 + 100 * SESSION_MS })).toString("base64url");
  const flipped = `${mac.slice(0, -2)}${mac.endsWith("AA") ? "BB" : "AA"}`;
  for (const bad of [`${v}.${forged}.${mac}`, `${v}.${later}.${mac}`, `${v}.${said}.${flipped}`, `${v}.${said}.`, `${v}.${said}`, `v2.${said}.${mac}`, `${token}.x`, "", "v1..", "Bearer"]) {
    assert.equal(sessions.walletOf(bad, T0 + 1), null, bad.slice(0, 12));
    assert.deepEqual(who(deps, bearer(bad)), NOBODY);
  }
  // A token another backend made (another secret) is nobody's here: a restart signs every wallet out.
  assert.equal(new Sessions().walletOf(token, T0 + 1), null);
  assert.equal(sessions.walletOf(token, T0 + 1), WALLET);
});

test("48.3, an expired token is no token: good to the last millisecond of its 12 hours, and not after", () => {
  let now = T0;
  const { deps, sessions } = ownerDeps({ now: () => now });
  const { token } = sessions.issue(WALLET, T0);
  now = T0 + SESSION_MS - 1;
  assert.deepEqual(who(deps, bearer(token)), { kind: "wallet", wallet: WALLET });
  now = T0 + SESSION_MS;
  assert.deepEqual(who(deps, bearer(token)), NOBODY);
});

test("48.3, the service token: the one the backend made is our own service, and any other is nobody", () => {
  const { deps } = ownerDeps();
  assert.deepEqual(who(deps, bearer(SVC)), { kind: "service" });
  assert.deepEqual(who(deps, { headers: { authorization: [`Bearer ${SVC}`] } }), { kind: "service" });
  for (const wrong of [`svc.${"ab".repeat(31)}ac`, `svc.${"ab".repeat(31)}`, `svc.${"AB".repeat(32)}`, "svc.", `${SVC}0`, SVC.slice(4)]) assert.deepEqual(who(deps, bearer(wrong)), NOBODY, wrong.slice(0, 10));
  // Not a bearer header, or none at all.
  assert.deepEqual(who(deps, { headers: { authorization: SVC } }), NOBODY);
  assert.deepEqual(who(deps, { headers: {} }), NOBODY);
  // A backend that made no service token takes none.
  const none = fakeDeps({ config: apiConfig(OWNER_ENV), sessions: new Sessions() }).deps;
  assert.deepEqual(who(none, bearer(SVC)), NOBODY);
  assert.match(newServiceToken(), /^svc\.[0-9a-f]{64}$/);
  assert.notEqual(newServiceToken(), newServiceToken());
});

test("48.3, the service token's file: its folder is made, it is for this user only (mode 600), and it goes when the backend stops", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pb-svc-")), "logs", "service-token");
  writeServiceToken(file, SVC);
  assert.equal(readFileSync(file, "utf8"), `${SVC}\n`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // Written again over an older file: still 600.
  writeServiceToken(file, `svc.${"cd".repeat(32)}`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  removeServiceToken(file);
  assert.equal(existsSync(file), false);
  removeServiceToken(file); // gone already: fine
});

// ---------- 48.4: who may see an account ----------

const wallet = (id: string): Who => ({ kind: "wallet", wallet: id });

test("48.4, yes 1: with ACCOUNT_PRIVACY=off anyone may see any account, and nothing is read to decide it", async () => {
  const { chain, calls } = fakeChain({ views: { [`${ALICE}.get_state`]: stateOf(WALLET) } });
  const { deps } = fakeDeps({ chain });
  assert.equal(deps.config.accountPrivacy, "off");
  await mayView(deps, NOBODY, ALICE);
  await mayView(deps, wallet(OTHER), ALICE);
  assert.deepEqual(calls, []);
});

test("48.4, yes 2: an account in OPEN_ACCOUNTS shows to anyone, signed in or not", async () => {
  const { deps, calls } = ownerDeps();
  await mayView(deps, NOBODY, OPEN);
  await mayView(deps, wallet(OTHER), OPEN);
  assert.deepEqual(calls, []);
});

test("48.4, yes 3: our own service sees every account", async () => {
  const { deps, calls } = ownerDeps();
  await mayView(deps, { kind: "service" }, ALICE);
  assert.deepEqual(calls, []);
});

test("48.4, yes 4: the operator's wallet and the keeper's see every account", async () => {
  const { deps, calls } = ownerDeps();
  await mayView(deps, wallet(OPERATOR), ALICE);
  await mayView(deps, wallet(KEEPER), ALICE);
  assert.deepEqual(calls, []);
});

test("48.4, yes 5: an account with no state (not made yet, or no client account at all) has nothing to hide from a signed-in wallet", async () => {
  const { deps } = ownerDeps();
  await mayView(deps, wallet(OTHER), "new-one.pbf.testnet"); // doesn't exist: the wallet may be about to make it
  await mayView(deps, wallet(OTHER), WALLET); // a wallet: no contract, no state
  await mayView(deps, wallet(OTHER), POOL); // a contract with no get_state
  await mayView(deps, wallet(OTHER), "not an account id"); // the route says what is wrong with it
  // Still nothing for nobody.
  await assert.rejects(mayView(deps, NOBODY, "new-one.pbf.testnet"), rejectsWith(401, "sign_in"));
});

test("48.4, yes 6: the wallet that is the account's owner in get_state; the owner is read once and kept 60 seconds", async () => {
  let now = T0;
  const { deps, calls } = ownerDeps({ now: () => now });
  await mayView(deps, wallet(WALLET), ALICE);
  await mayView(deps, wallet(WALLET), ALICE);
  assert.deepEqual(calls, [`${ALICE}.get_state({})`], "one read");
  now = T0 + OWNER_CACHE_MS - 1;
  await mayView(deps, wallet(WALLET), ALICE);
  assert.equal(calls.length, 1);
  now = T0 + OWNER_CACHE_MS;
  await mayView(deps, wallet(WALLET), ALICE);
  assert.equal(calls.length, 2, "read again after 60 seconds");
  assert.equal(OWNER_CACHE_MS, 60_000);
});

test("48.4, refusal 1: nobody is told to sign in (401 sign_in), before anything is read", async () => {
  const { deps, calls } = ownerDeps();
  await assert.rejects(mayView(deps, NOBODY, ALICE), rejectsWith(401, "sign_in", /^Sign in with the wallet that owns this account$/));
  assert.deepEqual(calls, []);
});

test("48.4, refusal 2: another wallet's account is 403 not_yours, and the refusal never names the owner; a read that fails is not a yes", async () => {
  const { deps } = ownerDeps();
  await assert.rejects(mayView(deps, wallet(OTHER), ALICE), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.deepEqual([error.status, error.code, error.message], [403, "not_yours", "This account belongs to another wallet"]);
    assert.doesNotMatch(error.message, new RegExp(WALLET));
    return true;
  });
  // From the cache too.
  await assert.rejects(mayView(deps, wallet(OTHER), ALICE), rejectsWith(403, "not_yours"));
  const down = fakeChain({ views: { [`${ALICE}.get_state`]: new RpcError("NEAR RPC did not answer") } });
  const broken = fakeDeps({ config: apiConfig(OWNER_ENV), chain: down.chain, sessions: new Sessions() }).deps;
  await assert.rejects(mayView(broken, wallet(OTHER), ALICE), RpcError);
});

// ---------- 48.5: the routes ----------

/** Starts the server on a free port, and returns a fetch for its paths that can carry a token. */
async function serve(deps: Deps) {
  const lines: string[] = [];
  const server = createApiServer(deps, (line) => lines.push(line));
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
  return { call, lines, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Every route of 48.5's table that names a client account, as a request for account `id`. */
const ROUTES: { name: string; path: (id: string) => string; body?: (id: string) => unknown }[] = [
  { name: "GET /api/account/<id>", path: (id) => `/api/account/${id}` },
  { name: "GET /api/hl/<id>", path: (id) => `/api/hl/${id}` },
  { name: "GET /api/keeper/<id>", path: (id) => `/api/keeper/${id}` },
  { name: "GET /api/activity/<id>", path: (id) => `/api/activity/${id}` },
  { name: "GET /api/lender/<id>", path: (id) => `/api/lender/${id}` },
  { name: "GET /api/markets?account=", path: (id) => `/api/markets?account=${id}` },
  { name: "GET /api/drill?account=", path: (id) => `/api/drill?account=${id}` },
  { name: "POST /api/preview", path: () => "/api/preview", body: (id) => ({ account: id, intent: { check: {} } }) },
  { name: "POST /api/funding-plan", path: () => "/api/funding-plan", body: (id) => ({ account: id, amount: "1000000" }) },
  { name: "POST /api/quote with move", path: () => "/api/quote", body: (id) => ({ dry: true, move: "to_hl", account: id, amount: "1000000" }) },
];

for (const route of ROUTES) {
  test(`48.5, ${route.name}: 401 with nothing, 403 for another wallet, and the route's own answer for the owner, the service token and an open account`, async () => {
    const { deps, sessions } = ownerDeps();
    const { call, close } = await serve(deps);
    const ask = (id: string, token?: string) => call(route.path(id), { ...(token ? { token } : {}), ...(route.body ? { body: route.body(id) } : {}) });
    try {
      const nothing = await ask(ALICE);
      assert.deepEqual([nothing.status, nothing.body.error, nothing.body.message], [401, "sign_in", "Sign in with the wallet that owns this account"]);
      const another = await ask(ALICE, sessions.issue(OTHER, T0).token);
      assert.deepEqual([another.status, another.body.error, another.body.message], [403, "not_yours", "This account belongs to another wallet"]);
      // An expired or changed token is no token.
      assert.equal((await ask(ALICE, `${sessions.issue(WALLET, T0).token}x`)).status, 401);
      assert.equal((await ask(ALICE, sessions.issue(WALLET, T0 - SESSION_MS).token)).status, 401);

      const owner = await ask(ALICE, sessions.issue(WALLET, T0).token);
      assert.equal(owner.status, 200, JSON.stringify(owner.body).slice(0, 300));
      assert.equal((await ask(ALICE, SVC)).status, 200);
      assert.equal((await ask(ALICE, sessions.issue(OPERATOR, T0).token)).status, 200, "the operator's wallet");
      assert.equal((await ask(OPEN)).status, 200, "an open account, with no token");
      assert.equal((await ask(OPEN, sessions.issue(OTHER, T0).token)).status, 200, "an open account, for any wallet");
    } finally {
      await close();
    }
  });
}

test("48.5, GET /api/status by an account's transfer id: 401 with nothing, 403 for another wallet, and the route's own answer for the owner; by deposit address it stays open", async () => {
  const { deps, sessions } = ownerDeps();
  const { call, close } = await serve(deps);
  const path = `/api/status?account=${ALICE}&transfer=move:0`;
  try {
    assert.deepEqual([(await call(path)).status, (await call(path)).body.error], [401, "sign_in"]);
    const another = await call(path, { token: sessions.issue(OTHER, T0).token });
    assert.deepEqual([another.status, another.body.error], [403, "not_yours"]);
    // The owner reaches the route itself: no quote is on record for this move here, and it says so.
    const owner = await call(path, { token: sessions.issue(WALLET, T0).token });
    assert.deepEqual([owner.status, owner.body.error], [404, "unknown_move"]);
    assert.equal((await call(path, { token: SVC })).status, 404);
    assert.equal((await call("/api/status?depositAddress=abc")).status, 200);
  } finally {
    await close();
  }
});

test("48.5, a refusal comes before the route's work: no OutLayer run, no share of a rate limit, and no read of the chain but the account's owner", async () => {
  // A limiter and an OutLayer that fail the test if a refused request reaches them.
  const never = (what: string) => () => assert.fail(`a refused request reached ${what}`);
  class NoLimiter extends RateLimiter {
    override take(): boolean {
      return assert.fail("a refused request took a share of a rate limit");
    }
    override available(): boolean {
      return assert.fail("a refused request looked at a rate limit");
    }
  }
  const { deps, sessions, calls } = ownerDeps({
    overrides: {
      outlayer: { run: never("OutLayer") },
      previews: new NoLimiter(1, 60_000),
      oneClick: { baseUrl: "http://localhost:8787", quote: never("1Click"), status: never("1Click") },
      hl: { info: never("Hyperliquid"), exchange: never("Hyperliquid") },
      indexer: { host: "tx.test.fastnear.com", accountTxs: never("the indexer"), transactions: never("the indexer") },
      readKeeperLog: never("the keeper's log"),
    },
  });
  deps.limits.activityReads = new NoLimiter(1, 60_000);
  const { call, close } = await serve(deps);
  const stranger = sessions.issue(OTHER, T0).token;
  try {
    for (const route of ROUTES) {
      const body = route.body ? { body: route.body(ALICE) } : {};
      assert.equal((await call(route.path(ALICE), body)).status, 401, route.name);
      assert.equal((await call(route.path(ALICE), { ...body, token: stranger })).status, 403, route.name);
    }
    assert.deepEqual([...new Set(calls)], [`${ALICE}.get_state({})`], "the only read is the owner's, for the signed-in stranger");
    assert.equal(calls.length, 1, "and it is read once for all ten routes");
  } finally {
    await close();
  }
});

test("48.5, the routes that name no client stay open: markets and drill with no account, a deposit quote, config, pool, status", async () => {
  const { deps } = ownerDeps();
  const { call, close } = await serve(deps);
  try {
    for (const path of ["/api/markets", "/api/drill", "/api/config", "/api/pool", "/api/status?depositAddress=abc"]) assert.equal((await call(path)).status, 200, path);
    // A deposit quote has no `move`: it names the account money goes to, and tells nothing about it.
    const deposit = await call("/api/quote", { body: { dry: true, originAsset: "nep141:x", destinationAsset: "nep141:musdc.pbf-ops.testnet", amount: "5", refundTo: "bob.testnet", recipient: ALICE } });
    assert.equal(deposit.status, 200, JSON.stringify(deposit.body));
    // A body that names no account is the route's own to refuse, as before.
    assert.equal((await call("/api/preview", { body: { intent: { check: {} } } })).status, 400);
  } finally {
    await close();
  }
});

test("48.5, GET /api/pricing: the per-account list for our service, the operator and the keeper; for everyone else accounts is [] and accounts_hidden is true, with every other field as it was", async () => {
  const { deps, sessions, calls } = ownerDeps();
  const { call, close } = await serve(deps);
  try {
    const hidden = await call("/api/pricing");
    assert.equal(hidden.status, 200);
    assert.deepEqual([hidden.body.accounts, hidden.body.accounts_hidden], [[], true]);
    assert.deepEqual(hidden.body.pool, { fees_charged: "108", fees_reversed: "0", subsidy_paid: "0", subsidy_left_24h: "5" });
    assert.deepEqual([hidden.body.funding, hidden.body.limits, hidden.body.tiers], [{ order: "cheapest", loan_days: 90 }, { max_rate_bp: 6_000 }, []]);
    assert.equal(calls.some((c) => c.includes("get_pricing") || c.includes("list_accounts") || c.includes("get_state")), false, "no account is read for an asker the list is hidden from");
    // A client's own wallet doesn't see the others either.
    const client = await call("/api/pricing", { token: sessions.issue(WALLET, T0).token });
    assert.deepEqual([client.body.accounts, client.body.accounts_hidden], [[], true]);

    for (const token of [SVC, sessions.issue(OPERATOR, T0).token, sessions.issue(KEEPER, T0).token]) {
      const shown = await call("/api/pricing", { token });
      assert.deepEqual((shown.body.accounts as { account: string }[]).map((a) => a.account), ["old.pbf.testnet", OPEN, ALICE]);
      assert.equal("accounts_hidden" in shown.body, false);
      assert.deepEqual(shown.body.pool, hidden.body.pool);
    }
    // Once the whole book is in the 15-second cache, a hidden answer still has no account in it.
    const after = await call("/api/pricing");
    assert.deepEqual([after.body.accounts, after.body.accounts_hidden], [[], true]);
  } finally {
    await close();
  }
  // The handler by itself: hidden or not is the caller's to say.
  const again = ownerDeps();
  assert.equal((await getPricing(again.deps)).accounts.length, 3);
  assert.deepEqual((await getPricing(again.deps, true)).accounts, []);
});

test("48.5, GET /api/accounts/mine: the signed-in wallet's own accounts from the factory's list, newest first; 401 without a wallet's token, 400 for the service", async () => {
  const { deps, sessions } = ownerDeps();
  const { call, close } = await serve(deps);
  try {
    const none = await call("/api/accounts/mine");
    assert.deepEqual([none.status, none.body.error], [401, "sign_in"]);
    const service = await call("/api/accounts/mine", { token: SVC });
    assert.deepEqual([service.status, service.body.error], [400, "bad_request"]);
    const mine = await call("/api/accounts/mine", { token: sessions.issue(WALLET, T0).token });
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body, {
      wallet: WALLET,
      accounts: [
        { account_id: ALICE, created_at: "1794200000000000000" },
        { account_id: "old.pbf.testnet", created_at: "1794000000000000000" },
      ],
      read_at_ms: T0,
    });
    const nothing = await call("/api/accounts/mine", { token: sessions.issue(OTHER, T0).token });
    assert.deepEqual(nothing.body.accounts, []);
  } finally {
    await close();
  }
  assert.deepEqual((await getMyAccounts(deps, "someone-else.testnet")).accounts, [{ account_id: OPEN, created_at: "1794100000000000000" }]);
});

test("48.5, GET /api/config says the privacy mode, the open accounts, and what a sign-in is signed for", async () => {
  const on = await getConfig(ownerDeps().deps);
  assert.deepEqual(on.privacy, { mode: "owner", open_accounts: [OPEN], session_recipient: "pb-app-session", session_ms: 43_200_000 });
  const off = await getConfig(fakeDeps().deps);
  assert.deepEqual(off.privacy, { mode: "off", open_accounts: [], session_recipient: "pb-app-session", session_ms: 43_200_000 });
});

test("48.5, POST /api/session over HTTP: a wallet signs in, and its token then opens its own account and not another's", async () => {
  const key = newKey();
  const { deps } = ownerDeps({ keys: { [`${WALLET} ${key.text}`]: "full" } });
  const { call, lines, close } = await serve(deps);
  try {
    const signedIn = await call("/api/session", { body: signIn(key) });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    const token = signedIn.body.token as string;
    assert.equal((await call(`/api/account/${ALICE}`, { token })).status, 200);
    assert.equal((await call(`/api/account/${OPEN}`, { token })).status, 200);
    const refused = await call("/api/session", { body: signIn(newKey()) });
    assert.deepEqual([refused.status, refused.body.error], [403, "not_your_key"]);
    // Nothing of a token or a key is in the log: a line is the method, the path and the status.
    assert.equal(lines.some((line) => line.includes(token) || line.includes(key.text) || line.includes("svc.")), false);
    assert.match(lines[0]!, /^POST \/api\/session -> 200 in \d+ ms$/);
  } finally {
    await close();
  }
});

// ---------- ACCOUNT_PRIVACY=off ----------

test("ACCOUNT_PRIVACY=off: every route answers anyone as before, a token changes nothing, and /api/session and /api/accounts/mine are 404", async () => {
  const on = ownerDeps();
  // The same chain and services, with privacy off and no sessions at all.
  const { deps } = ownerDeps({ overrides: { config: apiConfig({ ...OWNER_ENV, ACCOUNT_PRIVACY: "off" }), sessions: undefined } });
  assert.equal(deps.sessions, undefined);
  const { call, close } = await serve(deps);
  const guarded = await serve(on.deps);
  try {
    for (const route of ROUTES) {
      const options = route.body ? { body: route.body(ALICE) } : {};
      const open = await call(route.path(ALICE), options);
      assert.equal(open.status, 200, route.name);
      // The answer is the one the owner gets with privacy on: the check changes who is answered, not what.
      const owner = await guarded.call(route.path(ALICE), { ...options, token: on.sessions.issue(WALLET, T0).token });
      assert.deepEqual(open.body, owner.body, route.name);
      assert.equal((await call(route.path(ALICE), { ...options, token: "v1.garbage.token" })).status, 200, route.name);
    }
    const pricing = await call("/api/pricing");
    assert.equal((pricing.body.accounts as unknown[]).length, 3);
    assert.equal("accounts_hidden" in pricing.body, false);
    const session = await call("/api/session", { body: signIn(newKey()) });
    assert.deepEqual([session.status, session.body.error], [404, "not_found"]);
    const mine = await call("/api/accounts/mine");
    assert.deepEqual([mine.status, mine.body.error], [404, "not_found"]);
    assert.deepEqual(who(deps, bearer(SVC)), NOBODY, "nobody is asked who they are");
  } finally {
    await close();
    await guarded.close();
  }
});
