import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { test } from "node:test";

import { OneClickError, type QuoteRequest, type QuoteResponse, type StatusResponse } from "@pb/oneclick";

import { apiConfig } from "./config.js";
import { fakeChain, fakeDeps, fakeHl, T0, UNIVERSE } from "./fakes.js";
import { getAccount, getStatus, MoveBook, postQuote, type Deps } from "./handlers.js";
import { bandFloorBp, exchangeBody, expectOf, GATEWAYS_BEFORE_THE_BAND_FLOOR, GATEWAYS_BEFORE_THE_LONG_LIFE, getHl, getMarkets, MAX_ORDER_LIFE_MS, moveQuoteRequest, moveTooLarge, ORDER_LIFE_BEFORE_MS, ORDER_LIFE_MS, ORDER_WAIT_SLACK_MS, orderLifeMs, orderWaitMs, postCancel, postHlSubmit, postOrder, postSetLeverage, TESTNET_BAND_FLOOR_BP, type HlSigned } from "./hl-handlers.js";
import { KeyedRateLimiter } from "./limiter.js";
import { nep413Hash } from "./nep413.js";
import { OutLayerError, type OutLayerRun } from "./outlayer.js";
import { HttpError } from "./validate.js";

const ALICE = "alice.pbf.testnet";
const OWNER = "alice.testnet";
const HL = "0x00000000000000000000000000000000000a11ce";
const AGENT = "0x000000000000000000000000000000000000a6e7";
const FLOAT = "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d";
const MUSDC = "musdc.pbf-ops.testnet";
const GATEWAY = { project_id: "pbf-keeper.testnet/pb-gateway", version_key: "9a7e" };

const APPROVE: HlSigned = {
  index: 0,
  kind: "approveAgent",
  action: `{"type":"approveAgent","hyperliquidChain":"Testnet","signatureChainId":"0x66eee","agentAddress":"${AGENT}","agentName":"pb valid_until 1809552000000","nonce":1794000000000}`,
  nonce: 1794000000000,
  signature: { r: `0x${"1".repeat(64)}`, s: `0x${"2".repeat(64)}`, v: 27 },
  signed_block: 900,
};
const SEND: HlSigned = {
  index: 1,
  kind: "sendAsset",
  action: `{"type":"sendAsset","hyperliquidChain":"Testnet","signatureChainId":"0x66eee","destination":"${FLOAT}","sourceDex":"","destinationDex":"","token":"USDC:0xeb62eee3685fc4c43992febcd9e75443","amount":"9500","fromSubAccount":"","nonce":1794000000001}`,
  nonce: 1794000000001,
  signature: { r: `0x${"3".repeat(64)}`, s: `0x${"4".repeat(64)}`, v: 28 },
  signed_block: 950,
};

const state = (hl: Record<string, unknown>, principal = "0") => ({ owner: OWNER, counter: 3, loan: { principal }, verdict: null, hl: { path: "hyperliquid-1", ...hl } });
const WITH_HL = state({ address: HL, agent: { address: AGENT, received_block: 800 }, next_nonce_ms: "1794000000002", signed: [APPROVE, SEND] });

function rejectsWith(status: number, code: string, pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof HttpError, String(error));
    assert.equal(error.status, status, error.message);
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

const CLEARINGHOUSE = {
  marginSummary: { accountValue: "9499.0", totalNtlPos: "25000.0", totalRawUsd: "34499.0", totalMarginUsed: "1000.0" },
  crossMarginSummary: { accountValue: "9499.0", totalNtlPos: "25000.0", totalRawUsd: "34499.0", totalMarginUsed: "1000.0" },
  crossMaintenanceMarginUsed: "425.0",
  withdrawable: "8499.0",
  assetPositions: [{ type: "oneWay", position: { coin: "BTC", szi: "-0.33", leverage: { type: "cross", value: 25 }, entryPx: "75757", positionValue: "25000", unrealizedPnl: "0", liquidationPx: "100000", marginUsed: "1000", maxLeverage: 40 } }],
  time: T0,
};
const HL_INFO = {
  clearinghouseState: CLEARINGHOUSE,
  spotClearinghouseState: { balances: [{ coin: "HYPE", token: 150, total: "1.0", hold: "0.0" }, { coin: "USDC", token: 0, total: "12.5", hold: "0.5" }] },
  userAbstraction: "default",
  frontendOpenOrders: [{ coin: "BTC", side: "A", limitPx: "76000", sz: "0.01", oid: 77, timestamp: T0, origSz: "0.01", reduceOnly: false, orderType: "Limit", tif: "Gtc", cloid: null }],
  userFills: Array.from({ length: 60 }, (_, i) => ({ coin: "BTC", px: "75757", sz: "0.005", side: "A", time: T0 - i, oid: 70 + i, tid: i })),
  extraAgents: [{ name: "pb", address: AGENT, validUntil: 1809552000000 }],
};

test("hl: before hl_init there is no address, so Hyperliquid isn't asked; near_time_ms is the final block's", async () => {
  const { chain } = fakeChain({ views: { [`${ALICE}.get_state`]: state({ address: null }), [`${ALICE}.get_config`]: { gateway: GATEWAY } }, height: 4000 });
  const { hl, infoCalls } = fakeHl();
  const answer = await getHl(fakeDeps({ chain, hl }).deps, ALICE);
  assert.equal(answer.address, null);
  assert.equal(answer.hyperliquid, null);
  assert.deepEqual(answer.gateway, { ...GATEWAY, secrets_ref: null }, "the pinned gateway: this account can trade once set up");
  assert.equal(answer.near_time_ms, T0);
  assert.equal(answer.block_height, 4000);
  assert.equal(answer.owner, OWNER);
  assert.equal(infoCalls.length, 0);
});

test("hl: the six info reads for hl.address, spot USDC picked out, the last 50 fills, and the account's hl as stored", async () => {
  const { chain } = fakeChain({ views: { [`${ALICE}.get_state`]: WITH_HL } });
  const { hl, infoCalls } = fakeHl({ info: HL_INFO });
  const answer = await getHl(fakeDeps({ chain, hl }).deps, ALICE);

  assert.deepEqual(
    infoCalls.map((c) => c.type).sort(),
    ["clearinghouseState", "extraAgents", "frontendOpenOrders", "spotClearinghouseState", "userAbstraction", "userFills"],
  );
  assert.ok(infoCalls.every((c) => c.user === HL && Object.keys(c).length === 2), "each is {type, user}");
  assert.deepEqual(answer.hl, WITH_HL.hl);
  assert.equal(answer.gateway, null, "no gateway in its config: an account from before Phase 3");
  const h = answer.hyperliquid!;
  assert.deepEqual(h.clearinghouse_state, CLEARINGHOUSE);
  assert.deepEqual(h.spot_usdc, { total: "12.5", hold: "0.5" });
  assert.equal(h.abstraction, "default");
  assert.equal((h.open_orders as unknown[]).length, 1);
  assert.equal(h.fills!.length, 50);
  assert.equal((h.fills![0] as { oid: number }).oid, 70, "newest first, as Hyperliquid sends them");
  assert.deepEqual(h.agents, HL_INFO.extraAgents);
  assert.deepEqual(h.errors, {});
});

test("hl: a read that fails comes back null with its reason, and the rest still show", async () => {
  const { chain } = fakeChain({ views: { [`${ALICE}.get_state`]: WITH_HL } });
  const { hl } = fakeHl({ info: { ...HL_INFO, extraAgents: new Error("HTTP 429"), spotClearinghouseState: { balances: [] } } });
  const h = (await getHl(fakeDeps({ chain, hl }).deps, ALICE)).hyperliquid!;
  assert.equal(h.agents, null);
  assert.deepEqual(h.errors, { extraAgents: "HTTP 429" });
  assert.deepEqual(h.spot_usdc, { total: "0", hold: "0" }, "no USDC in spot is zero, not unknown");
  assert.deepEqual(h.clearinghouse_state, CLEARINGHOUSE);
});

test("hl: reads are cached for a few seconds; fresh re-reads the agents and the mode only", async () => {
  let now = T0;
  const { chain } = fakeChain({ views: { [`${ALICE}.get_state`]: WITH_HL } });
  const { hl, infoCalls } = fakeHl({ info: HL_INFO });
  const { TtlCache } = await import("./hl.js");
  const deps = fakeDeps({ chain, hl, hlCache: new TtlCache(() => now) }).deps;

  await getHl(deps, ALICE);
  await getHl(deps, ALICE);
  assert.equal(infoCalls.length, 6, "the second read within 2 s is served from the cache");
  await getHl(deps, ALICE, true);
  assert.deepEqual(infoCalls.slice(6).map((c) => c.type).sort(), ["extraAgents", "userAbstraction"]);
  now += 5_000;
  await getHl(deps, ALICE);
  assert.deepEqual(infoCalls.slice(8).map((c) => c.type).sort(), ["clearinghouseState", "frontendOpenOrders", "spotClearinghouseState", "userFills"]);
});

test("hl: only client accounts, and only once they have a contract", async () => {
  const { deps } = fakeDeps();
  await assert.rejects(getHl(deps, "alice.testnet"), rejectsWith(400, "bad_request"));
  await assert.rejects(getHl(deps, ALICE), rejectsWith(404, "not_deployed", /no account contract yet/));
});

test("markets: universe coins in the file's order, testnet's listing by name, the bands, and the pool's statuses", async () => {
  const meta = {
    universe: [
      { name: "SOL", szDecimals: 2, maxLeverage: 10 },
      { name: "TAO", szDecimals: 3, maxLeverage: 10, isDelisted: true },
      { name: "BTC", szDecimals: 5, maxLeverage: 40 },
    ],
  };
  const ctxs = [
    { markPx: "89.4", oraclePx: "89.3", midPx: "89.41", dayNtlVlm: "348384", funding: "0", openInterest: "1", prevDayPx: "90" },
    { markPx: "222.7", oraclePx: "222.9", midPx: null, dayNtlVlm: "0", funding: "0", openInterest: "0", prevDayPx: "220" },
    { markPx: "75824.0", oraclePx: "75929.3", midPx: "75819.5", dayNtlVlm: "2119812.6", funding: "0.0000410", openInterest: "9", prevDayPx: "75000" },
  ];
  const { chain } = fakeChain({
    views: {
      "pool.pbf.testnet.coin_statuses": [["SOL", { status: "reduce_only", since: "1", emergency: false }]],
      "pbf.testnet.get_config": { params_hash: UNIVERSE.hash.toUpperCase() },
    },
  });
  const { hl, infoCalls } = fakeHl({ info: { metaAndAssetCtxs: [meta, ctxs] } });
  const answer = await getMarkets(fakeDeps({ chain, hl }).deps);

  assert.deepEqual(infoCalls, [{ type: "metaAndAssetCtxs" }]);
  assert.deepEqual(answer.coins.map((c) => [c.coin, c.allowed, c.band_bp, c.testnet?.asset ?? null]), [
    ["BTC", true, 100, 2],
    ["SOL", true, 200, 0],
    ["XRP", true, 300, null],
    ["TAO", false, 300, 1],
  ]);
  const btc = answer.coins[0]!;
  assert.deepEqual(btc.testnet, {
    asset: 2,
    sz_decimals: 5,
    max_leverage: 40,
    delisted: false,
    mark_px: "75824.0",
    oracle_px: "75929.3",
    mid_px: "75819.5",
    day_ntl_vlm: "2119812.6",
    funding: "0.0000410",
  });
  assert.equal(answer.coins[3]!.testnet!.delisted, true);
  assert.deepEqual(answer.coins[1]!.status, { status: "reduce_only", since: "1", emergency: false });
  assert.equal(btc.status, null);
  assert.equal(answer.params_hash_matches, true, "compared ignoring case");
  assert.equal(answer.pool_statuses, "read");
  assert.equal(answer.hl_error, null);
});

test("markets: without Hyperliquid or the pool, the list still comes, saying what is missing", async () => {
  const { chain } = fakeChain({ missing: ["pool.pbf.testnet", "pbf.testnet"] });
  const { hl } = fakeHl({ info: { metaAndAssetCtxs: new Error("Hyperliquid did not answer") } });
  const answer = await getMarkets(fakeDeps({ chain, hl }).deps);
  assert.equal(answer.hl_error, "Hyperliquid did not answer");
  assert.ok(answer.coins.every((c) => c.testnet === null && c.status === null));
  assert.equal(answer.pool_statuses, "not_deployed");
  assert.equal(answer.params_hash_matches, null);
});

test("markets: the band is the one the account's own pinned gateway uses: on testnet 3% at least for a gateway built since 12 Nov, the parameter file's for an older one", async () => {
  const OLD = "9a2e035c2f62906d8e390db28c5be23b0753ca20b7d842908ac35916b09643e8"; // pinned on 12 Nov, before the rule
  const NEW = "ab".repeat(32); // any later build: the backend needs no hash of it
  const pin = (version_key: string) => ({ gateway: { project_id: "pbf-keeper.testnet/pb-gateway", version_key, secrets_ref: null } });
  const bands = (answer: Awaited<ReturnType<typeof getMarkets>>) => [answer.band_from, answer.gateway_version, answer.band_floor_bp, ...answer.coins.map((c) => c.band_bp)];
  const BOB = "bob.pbf.testnet";
  // The factory pins the new gateway; alice was made before and pins the old one; bob was made since.
  const { chain } = fakeChain({ views: { "pbf.testnet.get_config": { params_hash: UNIVERSE.hash, ...pin(NEW) }, [`${ALICE}.get_config`]: pin(OLD), [`${BOB}.get_config`]: pin(NEW.toUpperCase()) } });
  const { hl } = fakeHl({ info: { metaAndAssetCtxs: [{ universe: [] }, []] } });
  const deps = fakeDeps({ chain, hl }).deps;

  // The file's bands are 1%, 2%, 3% and 3% (BTC, SOL, XRP, TAO). An older gateway uses them as they are.
  assert.deepEqual(bands(await getMarkets(deps, ALICE)), ["account", OLD, 0, 100, 200, 300, 300]);
  // A gateway built since uses 3% where the file says less, and the file's band where it says more.
  assert.deepEqual(bands(await getMarkets(deps, BOB)), ["account", NEW.toUpperCase(), 300, 300, 300, 300, 300]);
  // With no account, and for an account that isn't made yet: the gateway the factory pins, which a new account gets.
  assert.deepEqual(bands(await getMarkets(deps)), ["factory", NEW, 300, 300, 300, 300, 300]);
  assert.deepEqual(bands(await getMarkets(deps, "carol.pbf.testnet")), ["factory", NEW, 300, 300, 300, 300, 300]);
  await assert.rejects(getMarkets(deps, "alice.testnet"), rejectsWith(400, "bad_request", /client account/));

  // Before the deploy the factory still pins the old gateway: 1% for everyone. A factory with no pin, or none that
  // can be read, leaves the file's band too.
  const before = fakeDeps({ chain: fakeChain({ views: { "pbf.testnet.get_config": { params_hash: UNIVERSE.hash, ...pin(OLD) } } }).chain, hl }).deps;
  assert.deepEqual(bands(await getMarkets(before)), ["factory", OLD, 0, 100, 200, 300, 300]);
  const unpinned = fakeDeps({ chain: fakeChain({ views: { "pbf.testnet.get_config": { params_hash: UNIVERSE.hash } } }).chain, hl }).deps;
  assert.deepEqual(bands(await getMarkets(unpinned)), ["factory", null, 0, 100, 200, 300, 300]);
  const gone = fakeDeps({ chain: fakeChain({ missing: ["pbf.testnet"] }).chain, hl }).deps;
  assert.deepEqual(bands(await getMarkets(gone)), [null, null, 0, 100, 200, 300, 300]);

  // The rule on its own: testnet only, and every gateway that could run on 12 Nov keeps the file's band.
  assert.deepEqual([bandFloorBp("testnet", NEW), bandFloorBp("testnet", OLD), bandFloorBp("testnet", null), bandFloorBp("mainnet", NEW), TESTNET_BAND_FLOOR_BP], [300, 0, 0, 0, 300]);
  assert.equal(GATEWAYS_BEFORE_THE_BAND_FLOOR.size, 6);
  for (const version of GATEWAYS_BEFORE_THE_BAND_FLOOR) assert.equal(bandFloorBp("testnet", version), 0, version);
});

// ---------- orders ----------

/** The NEP-413 vector made with near-api-js's signer (nep413.test.ts): alice.testnet signs INTERFACES.md 9's example. */
const VECTOR_AUTH = {
  owner: OWNER,
  public_key: "ed25519:9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj",
  signature: "5qPzxHwjjuSdu1l6eXIfCfQ3vEbm1BXEjit6LDrJrn1lNV9kOwpXyB6z5jyd459/lXqfkymf9GHKXue016U9Cg==",
  message:
    '{"pb":"order","account":"alice.pbf.testnet","order":{"coin":"BTC","is_buy":false,"sz":"0.33","limit_px":"74500","reduce_only":false,"tif":"Ioc"},"expires_ms":1794000060000}',
  nonce: "//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=",
  recipient: "pb-gateway",
};

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

/** Signs a message the way a NEP-413 wallet does, with a fresh key. */
function signAuth(message: string, owner = OWNER) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const nonce = randomBytes(32);
  const signature = sign(null, nep413Hash({ message, nonce, recipient: "pb-gateway" }), privateKey);
  return { owner, public_key: `ed25519:${base58(raw)}`, signature: signature.toString("base64"), message, nonce: nonce.toString("base64"), recipient: "pb-gateway" };
}

const ORDER_OK = {
  ok: true,
  acct: ALICE,
  status: "filled",
  oid: 123,
  filled_sz: "0.33",
  avg_px: "75012",
  sent: { coin: "BTC", is_buy: false, sz: "0.33", limit_px: "74500", reduce_only: false, tif: "Ioc" },
  hl: { status: "ok" },
  after: { state: "HEALTHY", eq: 34499000000, im: 19520000000, line: 24150000000, hl_margin_ratio_bp: 447 },
};

function gatewayDeps(output: unknown = ORDER_OK, views: Record<string, unknown> = {}) {
  const runs: { project: string; input: unknown; versionKey: string | undefined }[] = [];
  const { chain } = fakeChain({
    views: { [`${ALICE}.get_state`]: WITH_HL, [`${ALICE}.get_config`]: { gateway: GATEWAY, signature_chain_id: "0x66eee" }, ...views },
  });
  const outlayer = {
    async run(project: string, input: unknown, versionKey?: string): Promise<OutLayerRun> {
      runs.push({ project, input, versionKey });
      return { callId: "c-9", status: "completed", output, error: null, computeCost: "2000", timeMs: 3100, attestationUrl: "https://testnet-api.outlayer.ai/attestations/by-call/c-9" };
    },
  };
  return { ...fakeDeps({ chain, outlayer }), runs };
}

test("order: the signed order goes to pb-gateway in mode order, pinned to the account's version, and its answer comes back", async () => {
  const { deps, runs } = gatewayDeps();
  const answer = await postOrder(deps, { account: ALICE, auth: { ...VECTOR_AUTH, extra: "dropped" } });

  assert.deepEqual(runs, [
    { project: "pbf-keeper.testnet/pb-gateway", input: { mode: "order", account: ALICE, network: "testnet", auth: VECTOR_AUTH }, versionKey: "9a7e" },
  ]);
  assert.deepEqual(answer, { ...ORDER_OK, call_id: "c-9", attestation_url: "https://testnet-api.outlayer.ai/attestations/by-call/c-9" });
});

test("order: the gateway's refusal is the answer, with the check that refused", async () => {
  const { deps } = gatewayDeps({ ok: false, code: "P8", reason: "equity after the trade is below the initial requirement" });
  const answer = await postOrder(deps, { account: ALICE, auth: VECTOR_AUTH });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, "P8");
  assert.equal(answer.call_id, "c-9");
});

test("order: refused before paying for a run when the request can't pass the gateway's AUTH or INPUT checks", async () => {
  const { deps, runs } = gatewayDeps();
  const send = (auth: unknown, account = ALICE) => postOrder(deps, { account, auth });

  await assert.rejects(send(VECTOR_AUTH, "alice.testnet"), rejectsWith(400, "bad_request", /client account/));
  await assert.rejects(send(undefined), rejectsWith(400, "bad_request", /auth must be an object/));
  await assert.rejects(send({ ...VECTOR_AUTH, recipient: "someone-else" }), rejectsWith(400, "bad_request", /recipient/));
  await assert.rejects(send({ ...VECTOR_AUTH, nonce: "AAAA" }), rejectsWith(400, "bad_request", /32 bytes/));
  await assert.rejects(send({ ...VECTOR_AUTH, public_key: "ed25519:xyz" }), rejectsWith(400, "bad_request", /public_key/));
  await assert.rejects(send({ ...VECTOR_AUTH, message: VECTOR_AUTH.message.replace('"0.33"', '"0.34"') }), rejectsWith(400, "auth", /NEP-413/));
  await assert.rejects(send(signAuth(VECTOR_AUTH.message.replace(ALICE, "bob.pbf.testnet"))), rejectsWith(400, "bad_request", /another account/));
  await assert.rejects(send(signAuth(VECTOR_AUTH.message.replace('"pb":"order"', '"pb":"cancel"'))), rejectsWith(400, "bad_request", /"pb":"order"/));
  await assert.rejects(send(signAuth(VECTOR_AUTH.message.replace('"Ioc"', '"Fok"'))), rejectsWith(400, "bad_request", /tif/));
  await assert.rejects(send(signAuth(VECTOR_AUTH.message.replace('"74500"', "74500"))), rejectsWith(400, "bad_request", /decimal strings/));
  await assert.rejects(send(signAuth("not json")), rejectsWith(400, "bad_request", /not JSON/));
  await assert.rejects(send(signAuth(VECTOR_AUTH.message, "mallory.testnet")), rejectsWith(403, "not_owner", /only the owner can trade/));
  assert.equal(runs.length, 0);
});

test("order: an account from before Phase 3 has no gateway; without a payment key orders are off", async () => {
  const old = gatewayDeps(ORDER_OK, { [`${ALICE}.get_config`]: { risk: { project_id: "pbf-keeper.testnet/pb-risk" } } });
  await assert.rejects(postOrder(old.deps, { account: ALICE, auth: VECTOR_AUTH }), rejectsWith(409, "no_gateway", /made before Phase 3/));
  const other = gatewayDeps(ORDER_OK, { [`${ALICE}.get_config`]: { gateway: { project_id: "mallory.testnet/pb-gateway" } } });
  await assert.rejects(postOrder(other.deps, { account: ALICE, auth: VECTOR_AUTH }), rejectsWith(409, "bad_config"));
  const off = gatewayDeps();
  off.deps.outlayer = undefined;
  await assert.rejects(postOrder(off.deps, { account: ALICE, auth: VECTOR_AUTH }), rejectsWith(503, "gateway_off"));
  assert.equal(old.runs.length + other.runs.length, 0);
});

test("order: 60 a minute per account, counted before the run; other accounts have their own minute", async () => {
  const { deps, runs } = gatewayDeps();
  deps.limits.orders = new KeyedRateLimiter(2, 60_000, () => T0);
  await postOrder(deps, { account: ALICE, auth: VECTOR_AUTH });
  await postOrder(deps, { account: ALICE, auth: VECTOR_AUTH });
  await assert.rejects(postOrder(deps, { account: ALICE, auth: VECTOR_AUTH }), rejectsWith(429, "too_many_orders", /60 orders a minute/));
  assert.equal(runs.length, 2);
  assert.ok(deps.limits.orders.take("bob.pbf.testnet"));
});

test("order: when OutLayer fails mid-run, the answer warns that the order may have reached Hyperliquid", async () => {
  const { deps } = gatewayDeps();
  deps.outlayer = {
    run: async () => {
      throw new OutLayerError(500, "OutLayer answered HTTP 500: OutLayer failed; the run may still have happened and been charged");
    },
  };
  await assert.rejects(postOrder(deps, { account: ALICE, auth: VECTOR_AUTH }), rejectsWith(502, "outlayer_unknown", /may still have reached Hyperliquid/));
});

test("cancel: a signed cancel message goes to mode cancel; an order message is refused there", async () => {
  const { deps, runs } = gatewayDeps({ ok: true, acct: ALICE, hl: { status: "ok" } });
  const message = `{"pb":"cancel","account":"${ALICE}","cancel":{"coin":"BTC","oid":77},"expires_ms":1794000060000}`;
  const auth = signAuth(message);
  const answer = await postCancel(deps, { account: ALICE, auth });
  assert.equal(answer.ok, true);
  assert.deepEqual(runs[0]!.input, { mode: "cancel", account: ALICE, network: "testnet", auth });
  await assert.rejects(postCancel(deps, { account: ALICE, auth: VECTOR_AUTH }), rejectsWith(400, "bad_request", /"pb":"cancel"/));
  await assert.rejects(postCancel(deps, { account: ALICE, auth: signAuth(message.replace("77", '"77"')) }), rejectsWith(400, "bad_request", /oid/));
});

test("set-leverage: no signature, the gateway picks the numbers; a few a minute per account", async () => {
  const { deps, runs } = gatewayDeps({ ok: true, acct: ALICE, set: { BTC: 5 } });
  deps.limits.leverage = new KeyedRateLimiter(1, 60_000, () => T0);
  const answer = await postSetLeverage(deps, { account: ALICE });
  assert.deepEqual(answer.set, { BTC: 5 });
  assert.deepEqual(runs[0]!.input, { mode: "set_leverage", account: ALICE, network: "testnet" });
  await assert.rejects(postSetLeverage(deps, { account: ALICE }), rejectsWith(429, "too_many_leverage_sets"));
  await assert.rejects(postSetLeverage(deps, { account: "nobody" }), rejectsWith(400, "bad_request"));
});

// ---------- signed actions ----------

test("submit: the entry is read from the chain by its index and posted to /exchange as {action, nonce, signature}", async () => {
  const { chain } = fakeChain({ views: { [`${ALICE}.get_state`]: WITH_HL, [`${ALICE}.get_config`]: { signature_chain_id: "0x66eee" } } });
  const { hl, exchangeCalls } = fakeHl();
  const answer = await postHlSubmit(fakeDeps({ chain, hl }).deps, { account: ALICE, index: 1 });

  assert.deepEqual(exchangeCalls, [{ action: JSON.parse(SEND.action), nonce: SEND.nonce, signature: SEND.signature }]);
  assert.equal((exchangeCalls[0] as { action: { amount: string } }).action.amount, "9500", "the amount string reaches Hyperliquid unchanged");
  assert.equal(answer.ok, true);
  assert.equal(answer.kind, "sendAsset");
  assert.deepEqual(answer.hl, { status: "ok", response: { type: "default" } });
});

test("submit: Hyperliquid's refusal is the answer; a missing index is 404; nothing is posted for a bad entry", async () => {
  const { chain } = fakeChain({ views: { [`${ALICE}.get_state`]: WITH_HL, [`${ALICE}.get_config`]: { signature_chain_id: "0x66eee" } } });
  const { hl, exchangeCalls } = fakeHl({ exchange: [{ status: 200, body: { status: "err", response: "Extra agent already used." } }] });
  const deps = fakeDeps({ chain, hl }).deps;
  const answer = await postHlSubmit(deps, { account: ALICE, index: 0 });
  assert.equal(answer.ok, false);
  assert.equal("already_posted" in answer, false);
  assert.deepEqual(answer.hl, { status: "err", response: "Extra agent already used." });

  await assert.rejects(postHlSubmit(deps, { account: ALICE, index: 5 }), rejectsWith(404, "no_entry", /keeps 0 to 1/));
  await assert.rejects(postHlSubmit(deps, { account: ALICE, index: -1 }), rejectsWith(400, "bad_request"));
  await assert.rejects(postHlSubmit(deps, { account: ALICE, index: "0" }), rejectsWith(400, "bad_request"));
  assert.equal(exchangeCalls.length, 1);
});

test("submit: an action Hyperliquid took before is a yes: \"duplicate nonce\" with the entry's own nonce means the keeper, or an earlier try, posted it first", async () => {
  const views = { [`${ALICE}.get_state`]: WITH_HL, [`${ALICE}.get_config`]: { signature_chain_id: "0x66eee" } };
  // The keeper posts a signed entry it sees too. On 13 Nov it got there a second before the gate's own post.
  const taken = fakeHl({ exchange: [{ status: 200, body: { status: "err", response: `Invalid nonce: duplicate nonce ${SEND.nonce}` } }] });
  const answer = await postHlSubmit(fakeDeps({ chain: fakeChain({ views }).chain, hl: taken.hl }).deps, { account: ALICE, index: 1 });
  assert.deepEqual([answer.ok, (answer as { already_posted?: boolean }).already_posted], [true, true]);
  assert.deepEqual(answer.hl, { status: "err", response: `Invalid nonce: duplicate nonce ${SEND.nonce}` }, "Hyperliquid's own words stay in the answer");

  // Another nonce in the refusal is not this action, and any other refusal is a refusal.
  const other = fakeHl({ exchange: [{ status: 200, body: { status: "err", response: "Invalid nonce: duplicate nonce 1794000000999" } }] });
  assert.equal((await postHlSubmit(fakeDeps({ chain: fakeChain({ views }).chain, hl: other.hl }).deps, { account: ALICE, index: 1 })).ok, false);
  const low = fakeHl({ exchange: [{ status: 200, body: { status: "err", response: "Invalid nonce: nonce too low" } }] });
  assert.equal((await postHlSubmit(fakeDeps({ chain: fakeChain({ views }).chain, hl: low.hl }).deps, { account: ALICE, index: 1 })).ok, false);
  const down = fakeHl({ exchange: [{ status: 502, body: { status: "err", response: `Invalid nonce: duplicate nonce ${SEND.nonce}` } }] });
  assert.equal((await postHlSubmit(fakeDeps({ chain: fakeChain({ views }).chain, hl: down.hl }).deps, { account: ALICE, index: 1 })).ok, false);
});

test("submit: only testnet actions of the two kinds, signed for 0x66eee, whose nonce matches", () => {
  assert.deepEqual(exchangeBody(APPROVE, "0x66eee").action.agentAddress, AGENT);
  const mainnet = { ...APPROVE, action: APPROVE.action.replace('"Testnet"', '"Mainnet"') };
  assert.throws(() => exchangeBody(mainnet, "0x66eee"), rejectsWith(422, "not_testnet"));
  assert.throws(() => exchangeBody({ ...APPROVE, nonce: 1 }, "0x66eee"), rejectsWith(422, "bad_entry", /nonce/));
  assert.throws(() => exchangeBody({ ...APPROVE, kind: "withdraw3" }, "0x66eee"), rejectsWith(422, "bad_entry"));
  assert.throws(() => exchangeBody({ ...APPROVE, kind: "sendAsset" }, "0x66eee"), rejectsWith(422, "bad_entry", /isn't a sendAsset/));
  assert.throws(() => exchangeBody(APPROVE, "0xa4b1"), rejectsWith(422, "bad_entry", /chain id/));
  assert.throws(() => exchangeBody({ ...APPROVE, signature: { ...APPROVE.signature, v: 0 } }, "0x66eee"), rejectsWith(422, "bad_entry", /signature/));
});

// ---------- moving USDC ----------

function quoteDeps(stateValue: unknown, depositAddress?: string, amountIn?: string) {
  const quotes: QuoteRequest[] = [];
  const { chain } = fakeChain({ views: { [`${ALICE}.get_state`]: stateValue } });
  const oneClick = {
    baseUrl: "http://localhost:8787",
    async quote(request: QuoteRequest): Promise<QuoteResponse> {
      quotes.push(request);
      const quote = { amountIn: amountIn ?? request.amount, amountInFormatted: "x", amountOut: "1", amountOutFormatted: "1", minAmountOut: "1", timeEstimate: 20, ...(depositAddress && { depositAddress, depositMemo: "m-1" }) };
      return { correlationId: "q-7", quoteRequest: request, quote } as QuoteResponse;
    },
    async status() {
      throw new Error("not used");
    },
  };
  return { deps: fakeDeps({ chain, oneClick }).deps, quotes };
}

test("quote to Hyperliquid: mUSDC to the stand-in's Hyperliquid USDC, recipient hl.address, refund the account, then withdraw", async () => {
  const { deps, quotes } = quoteDeps(WITH_HL, "ab".repeat(32));
  const answer = await postQuote(deps, { dry: false, move: "to_hl", account: ALICE, amount: "9500000000" });

  assert.deepEqual(quotes, [
    {
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      depositType: "ORIGIN_CHAIN",
      refundType: "ORIGIN_CHAIN",
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(T0 + 10 * 60_000).toISOString(),
      originAsset: `nep141:${MUSDC}`,
      destinationAsset: "1cs_v1:hypercore:hip1:0xeb62eee3685fc4c43992febcd9e75443",
      amount: "9500000000",
      refundTo: ALICE,
      recipient: HL,
    },
  ]);
  assert.deepEqual((answer as unknown as { move: unknown }).move, {
    kind: "to_hl",
    account: ALICE,
    hl_address: HL,
    next: { method: "withdraw", args: { token: MUSDC, amount: "9500000000", receiver: "ab".repeat(32) } },
    transfer_id: null,
    exp_ms: null,
  });
});

test("Phase 4 moves: the account names its next move, so the quote carries its msg and the call its expiry", async () => {
  const phase4 = { ...WITH_HL, plan: null, pending: [], next_move: 4 };
  const msg = '{"pb":{"transfer":"move:4"}}';
  const deadline = T0 + 10 * 60_000;

  const out = quoteDeps(phase4, "ab".repeat(32));
  const toHl = (await postQuote(out.deps, { dry: false, move: "to_hl", account: ALICE, amount: "11000000" })) as unknown as { move: Record<string, unknown> };
  assert.equal(out.quotes[0]!.customRecipientMsg, msg, "the stand-in refunds to the account with it");
  assert.deepEqual(toHl.move.next, { method: "withdraw", args: { token: MUSDC, amount: "11000000", receiver: "ab".repeat(32), transfer: { kind: "to_hl", exp: deadline } } });
  assert.deepEqual([toHl.move.transfer_id, toHl.move.exp_ms], ["move:4", deadline]);

  const home = quoteDeps({ ...phase4, next_move: "5" }, FLOAT);
  const back = (await postQuote(home.deps, { dry: false, move: "home", account: ALICE, amount: "11000000" })) as unknown as { move: Record<string, unknown> };
  assert.equal(home.quotes[0]!.customRecipientMsg, '{"pb":{"transfer":"move:5"}}', "1Click delivers with it");
  // INTERFACES.md 47.3: with the expiry goes what the quote delivers on NEAR (the fake quote's amountOut is 1).
  assert.deepEqual(back.move.next, { method: "hl_withdraw", args: { amount: "11000000", destination: FLOAT, exp: deadline, expect: { token: MUSDC, amount: "1" } } });

  const dry = quoteDeps(phase4);
  const priced = (await postQuote(dry.deps, { dry: true, move: "to_hl", account: ALICE, amount: "11000000" })) as unknown as { move: Record<string, unknown> };
  assert.deepEqual([dry.quotes[0]!.customRecipientMsg, priced.move.transfer_id], [undefined, null], "a price only names nothing");
});

test("quote home: Hyperliquid USDC (8 decimals) to mUSDC with the deposit msg, refund hl.address; then hl_withdraw to the float", async () => {
  const { deps, quotes } = quoteDeps(WITH_HL, "0xFC9D786B69B900EC51DFE8EBBF19ED47BE59009D");
  const answer = await postQuote(deps, { dry: false, move: "home", account: ALICE, amount: "9500000000" });
  const sent = quotes[0]!;
  assert.equal(sent.originAsset, "1cs_v1:hypercore:hip1:0xeb62eee3685fc4c43992febcd9e75443");
  assert.equal(sent.destinationAsset, `nep141:${MUSDC}`);
  assert.equal(sent.amount, "950000000000", "micro-USDC times 100");
  assert.equal(sent.recipient, ALICE);
  assert.equal(sent.refundTo, HL);
  assert.equal(sent.customRecipientMsg, '{"pb":{"deposit":{}}}');
  assert.deepEqual((answer as unknown as { move: { next: unknown } }).move.next, { method: "hl_withdraw", args: { amount: "9500000000", destination: FLOAT } });

  const dry = await postQuote(quoteDeps(WITH_HL).deps, { dry: true, move: "home", account: ALICE, amount: "1000000" });
  assert.equal((dry as unknown as { move: { next: unknown } }).move.next, null, "a price only: nothing to call yet");
});

test("quote moves: refused without hl.address, home refused with a loan, and a deposit address that can't be the float", async () => {
  await assert.rejects(postQuote(quoteDeps(state({ address: null })).deps, { dry: true, move: "to_hl", account: ALICE, amount: "1" }), rejectsWith(409, "no_hl_address", /hl_init/));
  await assert.rejects(postQuote(quoteDeps(state({ address: HL }, "5")).deps, { dry: true, move: "home", account: ALICE, amount: "1" }), rejectsWith(409, "loan_open"));
  const repaidExactly = { ...state({ address: HL }), loan: { principal: "0", open: true } };
  await assert.rejects(postQuote(quoteDeps(repaidExactly).deps, { dry: true, move: "home", account: ALICE, amount: "1" }), rejectsWith(409, "loan_open"), "loan.open, as the account counts it");
  const closed = { ...state({ address: HL }, "5"), loan: { principal: "5", open: false } };
  await postQuote(quoteDeps(closed).deps, { dry: true, move: "home", account: ALICE, amount: "1" });
  await assert.rejects(postQuote(quoteDeps(WITH_HL, `0x${"9".repeat(40)}`).deps, { dry: false, move: "home", account: ALICE, amount: "1" }), rejectsWith(502, "bad_quote", /not its float/));
  await assert.rejects(postQuote(quoteDeps(WITH_HL, FLOAT, "150").deps, { dry: false, move: "home", account: ALICE, amount: "1" }), rejectsWith(502, "bad_quote", /6 decimals/));
  await assert.rejects(postQuote(quoteDeps(WITH_HL).deps, { dry: true, move: "sideways", account: ALICE, amount: "1" }), rejectsWith(400, "bad_request", /move/));
  await assert.rejects(postQuote(quoteDeps(WITH_HL).deps, { dry: true, move: "to_hl", account: ALICE, amount: "1.5" }), rejectsWith(400, "bad_request", /micro-USDC/));
});

test("the quote helper alone: with a loan, moving to Hyperliquid is still quoted (the withdrawal needs its verdict)", () => {
  const request = moveQuoteRequest({ move: "to_hl", dry: true, account: ALICE, hlAddress: HL, amountMicro: "10000000", musdc: MUSDC, hlUsdcAsset: "a", nowMs: T0, slippageBp: 30 });
  assert.equal(request.slippageTolerance, 30);
  assert.equal(request.customRecipientMsg, undefined, "no msg for a Hyperliquid recipient: the shim refuses one");
});

// ---------- stage 4: the moves between NEAR and Aave's chain (INTERFACES.md 36) ----------

const MNBTC = "mnbtc.pbf-ops.testnet";
const A_USDC = "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f";
const A_WBTC = "0x54114591963cf60ef3aa63befd6ec263d98145a4";
const A_WETH = "0x4200000000000000000000000000000000000006";
const AAVE_CONFIG = {
  lenders: {
    aave: {
      chain_id: 84_532,
      pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
      usdc: { symbol: "USDC", address: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", decimals: 6 },
      collateral: [{ symbol: "WBTC", address: "0x54114591963CF60EF3aA63bEfD6eC263D98145a4", decimals: 8 }, { symbol: "WETH", address: A_WETH, decimals: 18 }],
      max_fee_per_gas: "1000000000",
    },
  },
};
const base = (address: string) => `1cs_v1:base-sepolia:erc20:${address}`;

/** The stand-in, made up: it answers a quote with a deposit address, and may deliver another asset than the one asked for. */
function evmQuoteDeps(stateValue: unknown, answer: { depositAddress?: string; amountOut?: string; delivers?: string; config?: unknown } = {}) {
  const quotes: QuoteRequest[] = [];
  const { chain } = fakeChain({ views: { [`${ALICE}.get_state`]: stateValue, ...(answer.config === null ? {} : { [`${ALICE}.get_config`]: answer.config ?? AAVE_CONFIG }) } });
  const oneClick = {
    baseUrl: "http://localhost:8787",
    async quote(request: QuoteRequest): Promise<QuoteResponse> {
      quotes.push(request);
      const quote = { amountIn: request.amount, amountInFormatted: "x", amountOut: answer.amountOut ?? "54835", amountOutFormatted: "y", minAmountOut: "1", timeEstimate: 22, ...(answer.depositAddress && { depositAddress: answer.depositAddress, depositMemo: "m-1", deadline: new Date(T0 + 10 * 60_000).toISOString() }) };
      return { correlationId: "q-8", quoteRequest: answer.delivers ? { ...request, destinationAsset: answer.delivers } : request, quote, ...(answer.delivers ? { shim: { asked: request.destinationAsset, delivers: answer.delivers, symbol: "WETH", why: "Aave's test market has no room for WBTC" } } : {}) } as QuoteResponse;
    },
    async status() {
      throw new Error("not used");
    },
  };
  return { deps: fakeDeps({ chain, oneClick }).deps, quotes };
}
type MoveAnswer = { move: { kind: string; next: unknown; delivers: unknown; needs_check: unknown; transfer_id: unknown; exp_ms: unknown; hl_address: string }; shim?: { why: string } };
const STAGE4 = { ...WITH_HL, plan: null, pending: [], next_move: 7 };
const OWING = { ...STAGE4, loan: { principal: "100000000", open: true } };

test("stage 4, to_evm: the account's nBTC to its own address on Aave's chain; the next call is withdraw with the transfer, and the answer says what arrives", async () => {
  const deadline = T0 + 10 * 60_000;
  const out = evmQuoteDeps(STAGE4, { depositAddress: "cd".repeat(32) });
  const answer = (await postQuote(out.deps, { dry: false, move: "to_evm", account: ALICE, token: MNBTC, amount: "55000" })) as unknown as MoveAnswer;
  assert.deepEqual(out.quotes, [
    {
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      depositType: "ORIGIN_CHAIN",
      refundType: "ORIGIN_CHAIN",
      recipientType: "DESTINATION_CHAIN",
      amount: "55000",
      deadline: new Date(deadline).toISOString(),
      originAsset: `nep141:${MNBTC}`,
      destinationAsset: base(A_WBTC),
      refundTo: ALICE,
      recipient: HL,
      // The stand-in refunds a NEAR origin with the transfer's msg, as for to_hl.
      customRecipientMsg: '{"pb":{"transfer":"move:7"}}',
    },
  ]);
  assert.deepEqual(answer.move, {
    kind: "to_evm",
    account: ALICE,
    hl_address: HL,
    next: { method: "withdraw", args: { token: MNBTC, amount: "55000", receiver: "cd".repeat(32), transfer: { kind: "to_evm", exp: deadline } } },
    transfer_id: "move:7",
    exp_ms: deadline,
    delivers: { token: A_WBTC, symbol: "WBTC", chain: "Base Sepolia", amount: "54835" },
    // No loan from our pool: the withdrawal needs no verdict.
    needs_check: null,
  });

  // Aave has no room for WBTC: the stand-in's quote delivers WETH, and the answer says so in `delivers` and in `shim`.
  const weth = evmQuoteDeps(STAGE4, { depositAddress: "cd".repeat(32), delivers: base(A_WETH), amountOut: "19659886000000000" });
  const asWeth = (await postQuote(weth.deps, { dry: false, move: "to_evm", account: ALICE, amount: "55000" })) as unknown as MoveAnswer;
  assert.equal(weth.quotes[0]!.originAsset, `nep141:${MNBTC}`, "the nBTC token is the default");
  assert.deepEqual(asWeth.move.delivers, { token: A_WETH, symbol: "WETH", chain: "Base Sepolia", amount: "19659886000000000" });
  assert.equal(asWeth.shim?.why, "Aave's test market has no room for WBTC");

  // USDC to Aave's chain, the way to repay Aave once the loan has come home. The pool is owed, so a check comes first.
  const usdc = evmQuoteDeps(OWING, { depositAddress: "ef".repeat(32), amountOut: "24992500" });
  const back = (await postQuote(usdc.deps, { dry: false, move: "to_evm", account: ALICE, token: MUSDC, amount: "25000000" })) as unknown as MoveAnswer;
  assert.deepEqual([usdc.quotes[0]!.originAsset, usdc.quotes[0]!.destinationAsset], [`nep141:${MUSDC}`, base(A_USDC)]);
  assert.deepEqual(back.move.delivers, { token: A_USDC, symbol: "USDC", chain: "Base Sepolia", amount: "24992500" });
  assert.deepEqual(back.move.needs_check, { withdraw: { token: MUSDC, amount: "25000000" } });
  assert.deepEqual(back.move.next, { method: "withdraw", args: { token: MUSDC, amount: "25000000", receiver: "ef".repeat(32), transfer: { kind: "to_evm", exp: deadline } } });

  // A price only: no transfer is named, no call follows, and what would arrive is still said.
  const dry = evmQuoteDeps(STAGE4);
  const priced = (await postQuote(dry.deps, { dry: true, move: "to_evm", account: ALICE, amount: "55000" })) as unknown as MoveAnswer;
  assert.deepEqual([priced.move.next, priced.move.transfer_id, priced.move.exp_ms, dry.quotes[0]!.customRecipientMsg], [null, null, null, undefined]);
  assert.deepEqual(priced.move.delivers, { token: A_WBTC, symbol: "WBTC", chain: "Base Sepolia", amount: "54835" });
});

test("stage 4, e_home: USDC or collateral at the address comes home through evm_withdraw with the quote's expiry; while our pool is owed, a check for it comes first", async () => {
  const deadline = T0 + 10 * 60_000;
  const float = "0x2031181d63507368232579AF4c64a1c3428407fF";
  const out = evmQuoteDeps(OWING, { depositAddress: float, amountOut: "23026453" });
  const answer = (await postQuote(out.deps, { dry: false, move: "e_home", account: ALICE, amount: "23033364" })) as unknown as MoveAnswer;
  assert.deepEqual([out.quotes[0]!.originAsset, out.quotes[0]!.destinationAsset, out.quotes[0]!.refundTo, out.quotes[0]!.recipient], [base(A_USDC), `nep141:${MUSDC}`, HL, ALICE], "Aave's USDC is the default, and the sender is the account's own address");
  assert.equal(out.quotes[0]!.customRecipientMsg, '{"pb":{"transfer":"move:7"}}', "delivered on NEAR with the msg that settles the transfer, as for home");
  assert.deepEqual(answer.move, {
    kind: "e_home",
    account: ALICE,
    hl_address: HL,
    next: { method: "evm_withdraw", args: { token: A_USDC, amount: "23033364", to: float.toLowerCase(), exp: deadline, expect: { token: MUSDC, amount: "23026453" } } },
    transfer_id: "move:7",
    exp_ms: deadline,
    delivers: { token: MUSDC, symbol: "USDC", chain: "NEAR", amount: "23026453" },
    needs_check: { evm_withdraw: { token: A_USDC, amount: "23033364" } },
  });

  // Collateral comes home as nBTC. With no loan from our pool, no check is needed.
  const weth = evmQuoteDeps(STAGE4, { depositAddress: float, amountOut: "55615" });
  const home = (await postQuote(weth.deps, { dry: false, move: "e_home", account: ALICE, token: "0x4200000000000000000000000000000000000006", amount: "20000000000000000" })) as unknown as MoveAnswer;
  assert.deepEqual([weth.quotes[0]!.originAsset, weth.quotes[0]!.destinationAsset], [base(A_WETH), `nep141:${MNBTC}`]);
  assert.deepEqual([home.move.delivers, home.move.needs_check], [{ token: MNBTC, symbol: "nBTC", chain: "NEAR", amount: "55615" }, null]);
  assert.deepEqual(home.move.next, { method: "evm_withdraw", args: { token: A_WETH, amount: "20000000000000000", to: float.toLowerCase(), exp: deadline, expect: { token: MNBTC, amount: "55615" } } });
  // A price only carries the plain deposit msg, as home does.
  const dry = evmQuoteDeps(STAGE4);
  await postQuote(dry.deps, { dry: true, move: "e_home", account: ALICE, amount: "5" });
  assert.equal(dry.quotes[0]!.customRecipientMsg, '{"pb":{"deposit":{}}}');
  // A deposit address that is no address on Aave's chain is not a call anyone should sign.
  await assert.rejects(postQuote(evmQuoteDeps(STAGE4, { depositAddress: "ab".repeat(32) }).deps, { dry: false, move: "e_home", account: ALICE, amount: "5" }), rejectsWith(502, "bad_quote", /no address on Base Sepolia/));
});

test("stage 4's refusals, in words: no address yet, no Aave settings, a token that isn't the account's, and a move the backend doesn't know", async () => {
  await assert.rejects(postQuote(evmQuoteDeps(state({ address: null })).deps, { dry: true, move: "to_evm", account: ALICE, amount: "1" }), rejectsWith(409, "no_hl_address", /hl_init/));
  await assert.rejects(postQuote(evmQuoteDeps(STAGE4, { config: { lenders: { rhea: { contract_id: "rhea.pbf-ops.testnet" } } } }).deps, { dry: true, move: "e_home", account: ALICE, amount: "1" }), rejectsWith(409, "no_aave", /has no settings for Aave/));
  await assert.rejects(postQuote(evmQuoteDeps(STAGE4, { config: null }).deps, { dry: true, move: "to_evm", account: ALICE, amount: "1" }), rejectsWith(409, "no_aave"));
  const deps = () => evmQuoteDeps(STAGE4).deps;
  await assert.rejects(postQuote(deps(), { dry: true, move: "to_evm", account: ALICE, token: "wrap.testnet", amount: "1" }), rejectsWith(400, "bad_request", /token must be mnbtc\.pbf-ops\.testnet or musdc\.pbf-ops\.testnet/));
  await assert.rejects(postQuote(deps(), { dry: true, move: "e_home", account: ALICE, token: "0x1111111111111111111111111111111111111111", amount: "1" }), rejectsWith(400, "bad_request", /a token of the account's Aave settings on Base Sepolia: USDC 0xba50/));
  await assert.rejects(postQuote(deps(), { dry: true, move: "to_evm", account: ALICE, amount: "1.5" }), rejectsWith(400, "bad_request", /the token's own units/));
  await assert.rejects(postQuote(deps(), { dry: true, move: "to_evm", account: "alice.testnet", amount: "1" }), rejectsWith(400, "bad_request", /client account/));
  await assert.rejects(postQuote(deps(), { dry: true, move: "to_moon", account: ALICE, amount: "1" }), rejectsWith(400, "bad_request", /move must be "to_hl", "home", "to_evm" or "e_home"/));
});

test("stage 4: a move's status can be asked with the account and the transfer's id, from the backend's own record of the quotes it gave", async () => {
  const float = "0x2031181d63507368232579AF4c64a1c3428407fF";
  const asked: { depositAddress: string; memo: string | undefined }[] = [];
  const withStatus = <T extends { deps: Deps }>(out: T): T => {
    out.deps.oneClick = {
      ...out.deps.oneClick,
      async status(depositAddress: string, memo?: string | null) {
        asked.push({ depositAddress, memo: memo ?? undefined });
        return { correlationId: "q-8", status: "PROCESSING" } as StatusResponse;
      },
    };
    return out;
  };
  const out = withStatus(evmQuoteDeps(OWING, { depositAddress: float, amountOut: "23026453" }));
  const status = (fields: Record<string, string>) => getStatus(out.deps, new URLSearchParams(fields));

  // Nothing is on record before the quote, and a price only records nothing.
  await assert.rejects(status({ account: ALICE, transfer: "move:7" }), rejectsWith(404, "unknown_move", /No quote is on record for move:7 of alice\.pbf\.testnet/));
  await postQuote(out.deps, { dry: true, move: "e_home", account: ALICE, amount: "23033364" });
  await assert.rejects(status({ account: ALICE, transfer: "move:7" }), rejectsWith(404, "unknown_move"));

  // A committed move home is paid to the float, and only its memo tells it apart: the record keeps both.
  await postQuote(out.deps, { dry: false, move: "e_home", account: ALICE, amount: "23033364" });
  assert.equal(((await status({ account: ALICE, transfer: "move:7" })) as { status: string }).status, "PROCESSING");
  assert.deepEqual(asked, [{ depositAddress: float, memo: "m-1" }]);
  await assert.rejects(status({ account: ALICE, transfer: "move:8" }), rejectsWith(404, "unknown_move"), "another transfer of the account is not this one");
  await assert.rejects(status({ account: "bob.pbf.testnet", transfer: "move:7" }), rejectsWith(404, "unknown_move"), "nor is another account's");

  // A deposit address, when given, is asked as before.
  await status({ depositAddress: "d9", account: ALICE, transfer: "move:7" });
  assert.deepEqual(asked.at(-1), { depositAddress: "d9", memo: undefined });

  // The moves to and from Hyperliquid are kept the same way.
  const hl = withStatus(quoteDeps({ ...WITH_HL, plan: null, pending: [], next_move: 4 }, FLOAT));
  await postQuote(hl.deps, { dry: false, move: "home", account: ALICE, amount: "11000000" });
  await getStatus(hl.deps, new URLSearchParams({ account: ALICE, transfer: "move:4" }));
  assert.deepEqual(asked.at(-1), { depositAddress: FLOAT, memo: "m-1" });

  // Refused in words: an account that isn't a client's, and a transfer that isn't a move's id.
  await assert.rejects(status({ account: "alice.testnet", transfer: "move:7" }), rejectsWith(400, "bad_request", /client account/));
  await assert.rejects(status({ account: ALICE }), rejectsWith(400, "bad_request", /transfer must be a move's id, move:<n>/));
  await assert.rejects(status({ account: ALICE, transfer: "hl:3" }), rejectsWith(400, "bad_request", /move:<n>/));
  await assert.rejects(status({ transfer: "move:7" }), rejectsWith(400, "bad_request", /client account/));
});

test("the record of move quotes keeps the newest quote for a transfer id, and at most 2,000 of them", () => {
  const book = new MoveBook();
  book.remember(ALICE, "move:1", { depositAddress: "a", depositMemo: "first" });
  book.remember(ALICE, "move:1", { depositAddress: "a", depositMemo: "second" });
  assert.deepEqual(book.find(ALICE, "move:1"), { depositAddress: "a", depositMemo: "second" }, "a quote asked again before the call names the same transfer: the later one is the one to follow");
  assert.equal(book.find(ALICE, "move:2"), undefined);
  for (let n = 0; n < MoveBook.MAX; n += 1) book.remember("bob.pbf.testnet", `move:${n}`, { depositAddress: "b" });
  assert.equal(book.find(ALICE, "move:1"), undefined, "the oldest is dropped first");
  assert.deepEqual(book.find("bob.pbf.testnet", "move:0"), { depositAddress: "b" });
});

test("INTERFACES.md 47.3 (A12): the next call of a move home carries `expect`, the NEAR token and amount the quote delivers; a move out carries none, and neither does a quote with no amount to expect", async () => {
  const deadline = T0 + 10 * 60_000;
  const float = "0x2031181d63507368232579AF4c64a1c3428407fF";
  // e_home, USDC: Aave's USDC leaves the address, and 23.026453 test USDC is what arrives on NEAR.
  const usdc = evmQuoteDeps(STAGE4, { depositAddress: float, amountOut: "23026453" });
  const home = (await postQuote(usdc.deps, { dry: false, move: "e_home", account: ALICE, amount: "23033364" })) as unknown as MoveAnswer;
  const args = (home.move.next as { args: Record<string, unknown> }).args;
  assert.deepEqual(args.expect, { token: MUSDC, amount: "23026453" });
  const delivers = home.move.delivers as { token: string; amount: string };
  assert.deepEqual(args.expect, { token: delivers.token, amount: delivers.amount }, "the same as the answer's own delivers");
  assert.deepEqual(Object.keys(args), ["token", "amount", "to", "exp", "expect"], "the last argument, after the expiry");
  // A quote that names no amount out: no `expect`, and the account settles the transfer as it did before.
  const blank = evmQuoteDeps(STAGE4, { depositAddress: float, amountOut: "0" });
  const none = (await postQuote(blank.deps, { dry: false, move: "e_home", account: ALICE, amount: "23033364" })) as unknown as MoveAnswer;
  assert.deepEqual(none.move.next, { method: "evm_withdraw", args: { token: A_USDC, amount: "23033364", to: float.toLowerCase(), exp: deadline } });

  // to_evm is a move out: nothing arrives on NEAR, and the account takes no `expect` for it.
  const out = evmQuoteDeps(STAGE4, { depositAddress: "cd".repeat(32) });
  const toEvm = (await postQuote(out.deps, { dry: false, move: "to_evm", account: ALICE, token: MNBTC, amount: "55000" })) as unknown as MoveAnswer;
  assert.equal("expect" in (toEvm.move.next as { args: Record<string, unknown> }).args, false);
  // to_hl the same.
  const toHl = quoteDeps({ ...WITH_HL, plan: null, pending: [], next_move: "4" }, "ab".repeat(32));
  const sent = (await postQuote(toHl.deps, { dry: false, move: "to_hl", account: ALICE, amount: "11000000" })) as unknown as { move: { next: { args: Record<string, unknown> } } };
  assert.deepEqual(Object.keys(sent.move.next.args), ["token", "amount", "receiver", "transfer"]);

  // The argument itself: a listed token and a whole amount above 0, or nothing.
  assert.deepEqual(expectOf(MUSDC, "430000000"), { expect: { token: MUSDC, amount: "430000000" } });
  assert.deepEqual([expectOf(MUSDC, "0"), expectOf(MUSDC, undefined), expectOf(MUSDC, "4.3"), expectOf(undefined, "5"), expectOf("", "5")], [{}, {}, {}, {}, {}]);
});

test("50.2: the account's open_sends, send_floor_until_ms and send_open_until_ms reach the pages as the account shows them, through GET /api/hl and GET /api/account; an older account's answer has neither new field", async () => {
  const paused = { address: HL, signed: [SEND], send_open_until_ms: "1794176400001", open_sends: ["1794000000001"], send_floor_until_ms: "0" };
  const lifted = { address: HL, signed: [SEND], send_open_until_ms: "0", open_sends: [], send_floor_until_ms: "0" };
  const older = { address: HL, signed: [SEND], send_open_until_ms: "1794176400001" };
  for (const hlState of [paused, lifted, older]) {
    const stored = state(hlState);
    const { chain } = fakeChain({ views: { [`${ALICE}.get_state`]: stored, [`${MUSDC}.ft_balance_of`]: "0", "mnbtc.pbf-ops.testnet.ft_balance_of": "0", "pool.pbf.testnet.debt_of": "0", "pool.pbf.testnet.get_borrower": null } });
    const { hl } = fakeHl({ info: HL_INFO });
    const { deps } = fakeDeps({ chain, hl });
    assert.deepEqual((await getHl(deps, ALICE)).hl, stored.hl);
    assert.deepEqual(((await getAccount(deps, ALICE)).state as typeof stored).hl, stored.hl);
  }
  // The older account's answer carries no made-up list: the pages tell the two kinds apart by the field being there.
  const { chain } = fakeChain({ views: { [`${ALICE}.get_state`]: state(older) } });
  const answer = await getHl(fakeDeps({ chain, hl: fakeHl({ info: HL_INFO }).hl }).deps, ALICE);
  assert.deepEqual(["open_sends" in answer.hl!, "send_floor_until_ms" in answer.hl!, answer.hl!.send_open_until_ms], [false, false, "1794176400001"]);
});

// ---------- INTERFACES.md 50.4: a signed order lives up to 4 minutes on testnet ----------

const GATEWAY_OF_13_NOV = "fba556c2b9e64cf216fb3c805c998a1a210d5ef257960091853e3a8e0303ceb6";
const pinOf = (version_key: string) => ({ gateway: { project_id: "pbf-keeper.testnet/pb-gateway", version_key, secrets_ref: null } });
/** What GET /api/markets says of the gateway: whose it is, the life to sign for, the least band, and each coin's band (BTC, SOL, XRP, TAO). */
const lifeAndBands = (answer: Awaited<ReturnType<typeof getMarkets>>) => [answer.band_from, answer.order_life_ms, answer.band_floor_bp, ...answer.coins.map((c) => c.band_bp)];
const marketsFor = (factoryPin: string | null, accounts: Record<string, string> = {}) => {
  const views: Record<string, unknown> = { "pbf.testnet.get_config": { params_hash: UNIVERSE.hash, ...(factoryPin ? pinOf(factoryPin) : {}) } };
  for (const [id, version] of Object.entries(accounts)) views[`${id}.get_config`] = pinOf(version);
  return fakeDeps({ chain: fakeChain({ views }).chain, hl: fakeHl({ info: { metaAndAssetCtxs: [{ universe: [] }, []] } }).hl }).deps;
};

test("50.4, markets: an account on any of the seven older gateway builds is told to sign for 110000 ms, and its bands are what they were: the file's for the six, 3% for the one of 13 Nov", async () => {
  assert.deepEqual([ORDER_LIFE_MS, ORDER_LIFE_BEFORE_MS], [230_000, 110_000]);
  assert.equal(GATEWAYS_BEFORE_THE_LONG_LIFE.size, 7);
  assert.deepEqual([...GATEWAYS_BEFORE_THE_LONG_LIFE].slice(0, 6), [...GATEWAYS_BEFORE_THE_BAND_FLOOR], "the six of the band list");
  assert.equal([...GATEWAYS_BEFORE_THE_LONG_LIFE][6], GATEWAY_OF_13_NOV);
  // The band list keeps its own meaning: still six, and the build of 13 Nov is not one of them.
  assert.deepEqual([GATEWAYS_BEFORE_THE_BAND_FLOOR.size, GATEWAYS_BEFORE_THE_BAND_FLOOR.has(GATEWAY_OF_13_NOV)], [6, false]);
  for (const version of GATEWAYS_BEFORE_THE_LONG_LIFE) {
    // The factory pins a newer build; the account was made before and pins its own.
    const deps = marketsFor("ab".repeat(32), { [ALICE]: version });
    const beforeTheBand = GATEWAYS_BEFORE_THE_BAND_FLOOR.has(version);
    assert.deepEqual(lifeAndBands(await getMarkets(deps, ALICE)), beforeTheBand ? ["account", 110_000, 0, 100, 200, 300, 300] : ["account", 110_000, 300, 300, 300, 300, 300], version);
  }
  // The hash in any case, as for the band.
  assert.equal((await getMarkets(marketsFor(null, { [ALICE]: GATEWAY_OF_13_NOV.toUpperCase() }), ALICE)).order_life_ms, 110_000);
});

test("50.4, markets: an account on a gateway build the backend doesn't know, which is any newer one, is told to sign for 230000 ms, with the 3% band as before", async () => {
  const NEW = "5e".repeat(32);
  // The factory still pins the build of 13 Nov; this account pins the new one.
  const deps = marketsFor(GATEWAY_OF_13_NOV, { [ALICE]: NEW });
  const answer = await getMarkets(deps, ALICE);
  assert.deepEqual(lifeAndBands(answer), ["account", 230_000, 300, 300, 300, 300, 300]);
  assert.equal(answer.gateway_version, NEW);
});

test("50.4, markets with no account, or one not made yet: the life is the factory's pinned gateway's, by the same rule; with no gateway known it is 110000", async () => {
  // Today: the factory pins the build of 13 Nov.
  const today = marketsFor(GATEWAY_OF_13_NOV);
  assert.deepEqual(lifeAndBands(await getMarkets(today)), ["factory", 110_000, 300, 300, 300, 300, 300]);
  assert.deepEqual(lifeAndBands(await getMarkets(today, "carol.pbf.testnet")), ["factory", 110_000, 300, 300, 300, 300, 300]);
  // After the new gateway is pinned: a new account will sign for 230 s.
  const after = marketsFor("5e".repeat(32));
  assert.deepEqual(lifeAndBands(await getMarkets(after)), ["factory", 230_000, 300, 300, 300, 300, 300]);
  assert.deepEqual(lifeAndBands(await getMarkets(after, "carol.pbf.testnet")), ["factory", 230_000, 300, 300, 300, 300, 300]);
  // A factory with no pin, or one that can't be read: the short life, which every build takes.
  assert.deepEqual(lifeAndBands(await getMarkets(marketsFor(null))), ["factory", 110_000, 0, 100, 200, 300, 300]);
  const gone = fakeDeps({ chain: fakeChain({ missing: ["pbf.testnet"] }).chain, hl: fakeHl({ info: { metaAndAssetCtxs: [{ universe: [] }, []] } }).hl }).deps;
  assert.deepEqual(lifeAndBands(await getMarkets(gone)), [null, 110_000, 0, 100, 200, 300, 300]);
  // The rule on its own: testnet only. Mainnet's gateway keeps 120 s, whatever the build.
  assert.deepEqual([orderLifeMs("testnet", "5e".repeat(32)), orderLifeMs("testnet", GATEWAY_OF_13_NOV), orderLifeMs("testnet", null), orderLifeMs("mainnet", "5e".repeat(32))], [230_000, 110_000, 110_000, 110_000]);
});

const orderExpiring = (expiresMs: number) =>
  signAuth(`{"pb":"order","account":"${ALICE}","order":{"coin":"BTC","is_buy":false,"sz":"0.33","limit_px":"74500","reduce_only":false,"tif":"Ioc"},"expires_ms":${expiresMs}}`);

test("50.4: the backend waits for an order's or a cancel's run to the end of the message's life and 40 s more, even where OUTLAYER_WAIT_MS is set shorter; set-leverage keeps the setting", async () => {
  const waits: (number | undefined)[] = [];
  const outlayer = {
    async run(_project: string, _input: unknown, _versionKey?: string, options?: { waitMs?: number }): Promise<OutLayerRun> {
      waits.push(options?.waitMs);
      return { callId: "c-9", status: "completed", output: ORDER_OK, error: null, computeCost: "2000", timeMs: 3100, attestationUrl: null };
    },
  };
  const depsWith = (waitMs: string | undefined) => {
    const { chain } = fakeChain({ views: { [`${ALICE}.get_state`]: WITH_HL, [`${ALICE}.get_config`]: { gateway: GATEWAY } } });
    return fakeDeps({ chain, outlayer, config: apiConfig({ NEAR_NETWORK: "testnet", SHIM_NEAR_ACCOUNT_ID: "shim.pbf-ops.testnet", ACCOUNT_PRIVACY: "off", ...(waitMs ? { OUTLAYER_WAIT_MS: waitMs } : {}) }) }).deps;
  };
  // The default, 270 s: an order signed for 230 s on the new gateway is waited for 270 s, and one signed for 110 s too.
  const byDefault = depsWith(undefined);
  await postOrder(byDefault, { account: ALICE, auth: orderExpiring(T0 + 230_000) });
  await postOrder(byDefault, { account: ALICE, auth: orderExpiring(T0 + 110_000) });
  // OUTLAYER_WAIT_MS set to the 3 minutes of before: the order's own life still decides, and the short one keeps the setting.
  const setShort = depsWith("180000");
  await postOrder(setShort, { account: ALICE, auth: orderExpiring(T0 + 230_000) });
  await postOrder(setShort, { account: ALICE, auth: orderExpiring(T0 + 110_000) });
  // A message that claims an hour is waited for as the longest any gateway takes, 240 s; one already expired gets the setting.
  await postOrder(setShort, { account: ALICE, auth: orderExpiring(T0 + 3_600_000) });
  await postOrder(setShort, { account: ALICE, auth: orderExpiring(T0 - 5_000) });
  await postCancel(setShort, { account: ALICE, auth: signAuth(`{"pb":"cancel","account":"${ALICE}","cancel":{"coin":"BTC","oid":77},"expires_ms":${T0 + 230_000}}`) });
  await postSetLeverage(setShort, { account: ALICE });
  assert.deepEqual(waits, [270_000, 270_000, 270_000, 180_000, 280_000, 180_000, 270_000, undefined]);

  assert.deepEqual([MAX_ORDER_LIFE_MS, ORDER_WAIT_SLACK_MS], [240_000, 40_000]);
  assert.deepEqual([orderWaitMs(270_000, T0 + 230_000, T0), orderWaitMs(180_000, T0 + 230_000, T0), orderWaitMs(180_000, T0 + 230_000, T0 + 200_000), orderWaitMs(600_000, T0 + 230_000, T0)], [270_000, 270_000, 180_000, 600_000]);
});

// ---------- INTERFACES.md 51.2: ETH between NEAR and Aave's chain ----------

const METH = "meth.pbf-ops.testnet";
/** An account made since the five tokens: its own settings list test ETH, and its Aave settings WBTC and WETH. */
const ETH_CONFIG = { ...AAVE_CONFIG, tokens: [{ id: MUSDC, symbol: "USDC", decimals: 6 }, { id: MNBTC, symbol: "nBTC", decimals: 8 }, { id: METH, symbol: "ETH", decimals: 18 }] };

test("51.2, to_evm takes test ETH: the stand-in is asked for WETH on Base Sepolia, the next call is a withdraw of the ETH with the transfer, and with a loan open a check for that withdrawal comes first", async () => {
  const deadline = T0 + 10 * 60_000;
  const out = evmQuoteDeps(STAGE4, { depositAddress: "cd".repeat(32), amountOut: "19995400000000000", config: ETH_CONFIG });
  const answer = (await postQuote(out.deps, { dry: false, move: "to_evm", account: ALICE, token: METH, amount: "20000000000000000" })) as unknown as MoveAnswer;
  assert.deepEqual([out.quotes[0]!.originAsset, out.quotes[0]!.destinationAsset, out.quotes[0]!.refundTo, out.quotes[0]!.recipient, out.quotes[0]!.customRecipientMsg], [`nep141:${METH}`, base(A_WETH), ALICE, HL, '{"pb":{"transfer":"move:7"}}']);
  assert.deepEqual(answer.move, {
    kind: "to_evm",
    account: ALICE,
    hl_address: HL,
    next: { method: "withdraw", args: { token: METH, amount: "20000000000000000", receiver: "cd".repeat(32), transfer: { kind: "to_evm", exp: deadline } } },
    transfer_id: "move:7",
    exp_ms: deadline,
    delivers: { token: A_WETH, symbol: "WETH", chain: "Base Sepolia", amount: "19995400000000000" },
    needs_check: null,
  });
  const owing = evmQuoteDeps(OWING, { config: ETH_CONFIG });
  const priced = (await postQuote(owing.deps, { dry: true, move: "to_evm", account: ALICE, token: METH, amount: "5" })) as unknown as MoveAnswer;
  assert.deepEqual([priced.move.next, priced.move.needs_check], [null, { withdraw: { token: METH, amount: "5" } }]);
  // Bitcoin is still the default, and still asks for WBTC.
  await postQuote(out.deps, { dry: true, move: "to_evm", account: ALICE, amount: "55000" });
  assert.deepEqual([out.quotes[1]!.originAsset, out.quotes[1]!.destinationAsset], [`nep141:${MNBTC}`, base(A_WBTC)]);

  // An account from before the five tokens has no test ETH in its settings: the token is refused, in the words of before.
  await assert.rejects(postQuote(evmQuoteDeps(STAGE4).deps, { dry: true, move: "to_evm", account: ALICE, token: METH, amount: "5" }), rejectsWith(400, "bad_request", /^token must be mnbtc\.pbf-ops\.testnet or musdc\.pbf-ops\.testnet: the tokens the account can move to Aave's chain$/));
  await assert.rejects(postQuote(out.deps, { dry: true, move: "to_evm", account: ALICE, token: "wrap.testnet", amount: "5" }), rejectsWith(400, "bad_request", /^token must be mnbtc\.pbf-ops\.testnet, meth\.pbf-ops\.testnet or musdc\.pbf-ops\.testnet/));
  // Aave settings with no WETH: ether has nothing to arrive as.
  const noWeth = { ...ETH_CONFIG, lenders: { aave: { ...AAVE_CONFIG.lenders.aave, collateral: [AAVE_CONFIG.lenders.aave.collateral[0]] } } };
  await assert.rejects(postQuote(evmQuoteDeps(STAGE4, { config: noWeth }).deps, { dry: true, move: "to_evm", account: ALICE, token: METH, amount: "5" }), rejectsWith(409, "no_aave", /no WETH for its ether to arrive as/));
});

test("51.2, e_home takes `to`: WETH comes home as test ETH when it names it, with the delivery the account expects in ETH; left out, or naming bitcoin, it comes home as bitcoin, as before", async () => {
  const deadline = T0 + 10 * 60_000;
  const float = "0x2031181d63507368232579AF4c64a1c3428407fF";
  const out = evmQuoteDeps(STAGE4, { depositAddress: float, amountOut: "19990000000000000", config: ETH_CONFIG });
  const home = (await postQuote(out.deps, { dry: false, move: "e_home", account: ALICE, token: A_WETH, to: METH, amount: "20000000000000000" })) as unknown as MoveAnswer;
  assert.deepEqual([out.quotes[0]!.originAsset, out.quotes[0]!.destinationAsset, out.quotes[0]!.refundTo, out.quotes[0]!.recipient], [base(A_WETH), `nep141:${METH}`, HL, ALICE]);
  assert.deepEqual(home.move.next, { method: "evm_withdraw", args: { token: A_WETH, amount: "20000000000000000", to: float.toLowerCase(), exp: deadline, expect: { token: METH, amount: "19990000000000000" } } });
  assert.deepEqual(home.move.delivers, { token: METH, symbol: "ETH", chain: "NEAR", amount: "19990000000000000" });

  // Left out, and naming bitcoin: the destination of before.
  for (const to of [undefined, MNBTC]) {
    const btc = evmQuoteDeps(STAGE4, { depositAddress: float, amountOut: "55615", config: ETH_CONFIG });
    const answer = (await postQuote(btc.deps, { dry: false, move: "e_home", account: ALICE, token: A_WETH, ...(to ? { to } : {}), amount: "20000000000000000" })) as unknown as MoveAnswer;
    assert.equal(btc.quotes[0]!.destinationAsset, `nep141:${MNBTC}`, String(to));
    assert.deepEqual(answer.move.delivers, { token: MNBTC, symbol: "nBTC", chain: "NEAR", amount: "55615" });
  }
  // What `to` can't be, each refused before the stand-in is asked.
  const ask = (body: Record<string, unknown>) => postQuote(out.deps, { dry: true, move: "e_home", account: ALICE, amount: "5", ...body });
  await assert.rejects(ask({ token: A_WBTC, to: METH }), rejectsWith(400, "bad_request", /^only WETH comes home as ether: WBTC comes home as bitcoin$/));
  await assert.rejects(ask({ token: A_WETH, to: MUSDC }), rejectsWith(400, "bad_request", /^to must be mnbtc\.pbf-ops\.testnet or meth\.pbf-ops\.testnet: what a collateral token on Base Sepolia can come home as$/));
  await assert.rejects(ask({ token: A_WETH, to: "wrap.testnet" }), rejectsWith(400, "bad_request", /^to must be/));
  await assert.rejects(ask({ to: METH }), rejectsWith(400, "bad_request", /^USDC on Base Sepolia comes home as USDC: leave "to" out$/));
  await assert.rejects(ask({ token: A_WETH, to: 5 }), rejectsWith(400, "bad_request", /^to must be a string/));
  // An account with no test ETH in its settings can't bring anything home as ether.
  await assert.rejects(postQuote(evmQuoteDeps(STAGE4).deps, { dry: true, move: "e_home", account: ALICE, token: A_WETH, to: METH, amount: "5" }), rejectsWith(400, "bad_request", /^to must be mnbtc\.pbf-ops\.testnet: what a collateral token/));
  assert.equal(out.quotes.length, 1);
});

test("51.2, a move the stand-in refuses for its size comes back as 400 move_too_large in the stand-in's own words; any other refusal of its stays 1Click's", async () => {
  const tooMuch = "This would arrive as 0.03 WETH, and the stand-in brings at most 0.02 WETH in one move: its float has little test ETH. Send at most 0.020006 ETH (20006000000000000 units)";
  const refusing = (status: number, body: unknown) => {
    const made = evmQuoteDeps(STAGE4, { config: ETH_CONFIG });
    made.deps.oneClick = { ...made.deps.oneClick, quote: async () => Promise.reject(new OneClickError(status, body, "/v0/quote")) };
    return made.deps;
  };
  await assert.rejects(postQuote(refusing(400, { message: tooMuch }), { dry: true, move: "to_evm", account: ALICE, token: METH, amount: "30000000000000000" }), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.deepEqual([error.status, error.code, error.message], [400, "move_too_large", tooMuch]);
    return true;
  });
  // The float can't wrap that much now: the same code, its own words.
  const short = "The stand-in's float holds 0.004 test ETH and 0 WETH: it can't wrap 0.02 more and keep 0.003 for gas. Ask for less, or send the float test ETH on Base Sepolia";
  await assert.rejects(postQuote(refusing(400, { message: short }), { dry: true, move: "to_evm", account: ALICE, token: METH, amount: "20000000000000000" }), rejectsWith(400, "move_too_large", /^The stand-in's float holds 0\.004 test ETH/));
  // Another refusal (a pair it doesn't carry, 1Click's own no): not ours to rename.
  for (const [status, body] of [[400, { message: "The stand-in moves bitcoin and USDC between NEAR and Base Sepolia on four routes only" }], [400, { message: "tokenOut is not valid" }], [503, { message: "at most 0.02 WETH in one move" }], [400, "at most 0.02 WETH in one move"]] as const) {
    await assert.rejects(postQuote(refusing(status, body), { dry: true, move: "to_evm", account: ALICE, token: METH, amount: "5" }), (error: unknown) => error instanceof OneClickError, JSON.stringify(body));
  }
  assert.equal(moveTooLarge(new Error("at most 0.02 WETH in one move")), null);
});
