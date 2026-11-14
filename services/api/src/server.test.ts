import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { apiConfig, EVM_MAINNETS, EVM_TEST_CHAINS, evmChainProblem } from "./config.js";
import { fakeChain, fakeDeps } from "./fakes.js";
import { HlError } from "./hl.js";
import { clientAddress, createApiServer, errorAnswer } from "./server.js";
import { isAccountId, isPrimeAccount, isU128, parseIntent } from "./validate.js";

/** Starts the server on a free port with fake dependencies, and returns a fetch for its paths. */
async function serve(deps = fakeDeps().deps) {
  const lines: string[] = [];
  const server = createApiServer(deps, (line) => lines.push(line));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers };
  };
  return { call, lines, close: () => new Promise((resolve) => server.close(resolve)) };
}

const post = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("the routes answer JSON, uncached, and each request is logged without its query", async () => {
  const { chain } = fakeChain({ views: { "musdc.pbf-ops.testnet.ft_balance_of": "7", "mnbtc.pbf-ops.testnet.ft_balance_of": "0" }, missing: ["pool.pbf.testnet"] });
  const { call, lines, close } = await serve(fakeDeps({ chain }).deps);
  try {
    const pool = await call("/api/pool");
    assert.equal(pool.status, 200);
    assert.equal(pool.body.deployed, false);
    assert.equal(pool.headers.get("cache-control"), "no-store");

    const account = await call("/api/account/alice.pbf.testnet");
    assert.equal(account.status, 200);
    assert.deepEqual(account.body.not_deployed, ["pool.pbf.testnet"]);

    const status = await call("/api/status?depositAddress=abc");
    assert.equal(status.body.status, "PROCESSING");
    assert.ok(lines.some((l) => /^GET \/api\/status -> 200 in \d+ ms$/.test(l)), lines.join("\n"));
  } finally {
    await close();
  }
});

test("bad requests get a code and a message; unknown routes are 404", async () => {
  const { call, close } = await serve();
  try {
    assert.deepEqual(await call("/api/nope").then((r) => [r.status, r.body.error]), [404, "not_found"]);
    assert.deepEqual(await call("/api/account/NOT%20VALID").then((r) => [r.status, r.body.error]), [400, "bad_request"]);
    assert.deepEqual(await call("/api/account/%E0%A4%A").then((r) => [r.status, r.body.error]), [400, "bad_request"]);
    assert.deepEqual(await call("/api/preview", post("{not json")).then((r) => [r.status, r.body.error]), [400, "bad_request"]);
    assert.deepEqual(await call("/api/preview", post("x".repeat(20_000))).then((r) => [r.status, r.body.error]), [413, "too_large"]);
    const preview = await call("/api/preview", post({ account: "nobody.pbf.testnet", intent: { check: {} } }));
    assert.equal(preview.status, 404);
    assert.match(String(preview.body.message), /nobody\.pbf\.testnet has no account contract yet/);
  } finally {
    await close();
  }
});

test("an unexpected error is logged but answered without its details", () => {
  const lines: string[] = [];
  const answer = errorAnswer(new Error("connect ECONNREFUSED https://rpc.example/secret-key"), (l) => lines.push(l));
  assert.deepEqual(answer, { status: 500, body: { error: "internal", message: "The backend failed; its log says why" } });
  assert.match(lines[0]!, /secret-key/, "the details stay in the server's own log");
});

test("config: testnet only, ids default to INTERFACES.md 1, API_URL sets the port, bad ids are refused", () => {
  const config = apiConfig({ API_URL: "http://localhost:9000", FACTORY_ACCOUNT_ID: "pbf.testnet", OUTLAYER_PAYMENT_KEY: "k:1:s" });
  assert.equal(config.port, 9000);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.ids.pool, "pool.pbf.testnet");
  assert.equal(config.ids.riskProject, "pbf-keeper.testnet/pb-risk");
  assert.equal(config.outlayerApiUrl, "https://testnet-api.outlayer.ai");
  assert.equal(apiConfig({}).port, 8788);
  assert.equal(apiConfig({}).outlayerPaymentKey, undefined);
  // OUTLAYER_WAIT_MS: how long a run may take, its wait in OutLayer's queue included. 270 s unless set (INTERFACES.md
  // 50.4; 3 minutes before): an order signed for 230 s must not be given up on before its life is over.
  assert.equal(apiConfig({}).outlayerWaitMs, 270_000);
  assert.throws(() => apiConfig({ OUTLAYER_WAIT_MS: "soon" }), /the default, 270000, is 4 and a half minutes/);
  assert.equal(apiConfig({ OUTLAYER_WAIT_MS: "240000" }).outlayerWaitMs, 240_000);
  for (const bad of ["soon", "9999", "600001", "180000.5"]) assert.throws(() => apiConfig({ OUTLAYER_WAIT_MS: bad }), /OUTLAYER_WAIT_MS must be a whole number of milliseconds from 10000 to 600000/, bad);
  assert.throws(() => apiConfig({ NEAR_NETWORK: "mainnet" }), /testnet for now/);
  assert.throws(() => apiConfig({ POOL_ACCOUNT_ID: "Pool!" }), /POOL_ACCOUNT_ID is not a valid NEAR account id/);
});

test("config, Phase 3: Hyperliquid testnet only; the float defaults to INTERFACES.md 1's, lowercase", () => {
  const config = apiConfig({});
  assert.equal(config.hlApiUrl, "https://api.hyperliquid-testnet.xyz");
  assert.equal(config.ids.hlFloat, "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d");
  assert.equal(config.ids.gatewayProject, "pbf-keeper.testnet/pb-gateway");
  assert.equal(apiConfig({ HL_FLOAT_ADDRESS: "0xFC9D786B69B900EC51DFE8EBBF19ED47BE59009D" }).ids.hlFloat, "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d");
  assert.throws(() => apiConfig({ HL_API_URL: "https://api.hyperliquid.xyz" }), /testnet only/);
  assert.throws(() => apiConfig({ HL_FLOAT_ADDRESS: "0x12" }), /not a 0x address/);
});

test("Phase 3 routes: markets, the account's Hyperliquid side, and their errors", async () => {
  const { fakeHl } = await import("./fakes.js");
  const { hl } = fakeHl({ info: { metaAndAssetCtxs: new Error("down") } });
  const { chain } = fakeChain({ views: { "alice.pbf.testnet.get_state": { owner: "alice.testnet", hl: { path: "hyperliquid-1", address: null } } } });
  const { call, close } = await serve(fakeDeps({ chain, hl }).deps);
  try {
    const markets = await call("/api/markets");
    assert.equal(markets.status, 200);
    assert.equal(markets.body.hl_error, "down");
    const account = await call("/api/hl/alice.pbf.testnet");
    assert.equal(account.status, 200);
    assert.equal(account.body.address, null);
    assert.deepEqual(await call("/api/hl/bob.pbf.testnet").then((r) => [r.status, r.body.error]), [404, "not_deployed"]);
    assert.deepEqual(await call("/api/hl/submit").then((r) => [r.status, r.body.error]), [400, "bad_request"], "GET of submit is not an account");
    assert.deepEqual(await call("/api/order", post({ account: "alice.pbf.testnet" })).then((r) => [r.status, r.body.error]), [400, "bad_request"]);
    assert.deepEqual(await call("/api/hl/submit", post({ account: "alice.pbf.testnet", index: 0 })).then((r) => [r.status, r.body.error]), [404, "no_entry"]);
  } finally {
    await close();
  }
});

test("a Hyperliquid failure is a 502 that says so", () => {
  const answer = errorAnswer(new HlError(504, "Hyperliquid (api.hyperliquid-testnet.xyz) did not answer: timeout"), () => {});
  assert.deepEqual(answer, { status: 502, body: { error: "hyperliquid", message: "Hyperliquid (api.hyperliquid-testnet.xyz) did not answer: timeout" } });
});

test("validation: account ids, client accounts, U128 strings and the three intents", () => {
  assert.ok(isAccountId("alice.testnet") && isAccountId("a1b2".repeat(16)) && !isAccountId("A.testnet") && !isAccountId("a"));
  assert.ok(isPrimeAccount("alice.pbf.testnet", "pbf.testnet"));
  assert.ok(isPrimeAccount("my-fund_2.pbf.testnet", "pbf.testnet"));
  assert.ok(!isPrimeAccount("pbf.testnet", "pbf.testnet"));
  assert.ok(!isPrimeAccount("a.b.pbf.testnet", "pbf.testnet"), "only direct children of the factory");
  assert.ok(!isPrimeAccount("alicepbf.testnet", "pbf.testnet"));
  assert.ok(isU128("0") && isU128("340282366920938463463374607431768211455"));
  assert.ok(!isU128("340282366920938463463374607431768211456") && !isU128("01") && !isU128("1.5") && !isU128(5));

  const tokens = ["musdc.pbf-ops.testnet"];
  assert.deepEqual(parseIntent({ check: {} }, tokens), { check: {} });
  assert.deepEqual(parseIntent({ borrow: { amount: "5" } }, tokens), { borrow: { amount: "5" } });
  assert.deepEqual(parseIntent({ withdraw: { token: "musdc.pbf-ops.testnet", amount: "5", extra: 1 } }, tokens), {
    withdraw: { token: "musdc.pbf-ops.testnet", amount: "5" },
  });
  assert.throws(() => parseIntent({ check: {}, borrow: { amount: "1" } }, tokens), /exactly one/);
  assert.throws(() => parseIntent({ swap: {} }, tokens), /Unknown intent swap/);
  assert.throws(() => parseIntent({ borrow: { amount: "0" } }, tokens), /positive/);
  assert.throws(() => parseIntent("check", tokens), /must be an object/);
});

test("Phase 5 routes: the credit check, its example, Rhea, the activity, the book stress test; the client's address", async () => {
  const { call, close } = await serve();
  try {
    assert.deepEqual(await call("/api/credit-check", post({})).then((r) => [r.status, r.body.error]), [400, "bad_request"]);
    assert.deepEqual(await call("/api/credit-check/example").then((r) => [r.status, r.body.error]), [503, "example_off"]);
    assert.deepEqual(await call("/api/rhea").then((r) => [r.status, r.body.error]), [503, "rhea_off"]);
    assert.deepEqual(await call("/api/activity/alice.pbf.testnet").then((r) => [r.status, r.body.error]), [503, "activity_off"]);
    assert.deepEqual(await call("/api/activity/alice.testnet").then((r) => [r.status, r.body.error]), [400, "bad_request"]);
    const stress = await call("/api/book-stress");
    assert.equal(stress.status, 200);
    assert.equal(typeof stress.body.log_found, "boolean");
    const config = await call("/api/config");
    assert.equal(config.body.credit_check_enabled, true);
  } finally {
    await close();
  }
  const via = (remoteAddress: string, forwarded?: string) => clientAddress({ socket: { remoteAddress } as never, headers: forwarded ? { "x-forwarded-for": forwarded } : {} });
  assert.equal(via("203.0.113.5", "1.2.3.4"), "203.0.113.5", "from outside: the socket, whatever the header says");
  assert.equal(via("127.0.0.1", "198.51.100.7, 10.0.0.1"), "198.51.100.7", "through the web app's proxy: the client it names");
  assert.equal(via("::1"), "::1");
});

test("config, Phase 5: mainnet reads, the indexer and the book stress file default to the documented ones", () => {
  const config = apiConfig({});
  assert.deepEqual([config.mainnetRpcUrl, config.hlMainnetApiUrl, config.txIndexerUrl, config.fastnearApiKey], ["https://free.rpc.fastnear.com", "https://api.hyperliquid.xyz", "https://tx.test.fastnear.com", undefined]);
  assert.equal(apiConfig({ FASTNEAR_TX_URL: "https://tx.example/", FASTNEAR_API_KEY: "k" }).txIndexerUrl, "https://tx.example");
  assert.throws(() => apiConfig({ MAINNET_NEAR_RPC_URL: "ftp://x" }), /MAINNET_NEAR_RPC_URL must be an http\(s\) URL/);
});

test("Phase 6 routes: the lenders' terms, an account's lender view, and the funding plan, whose refusal is a 200", async () => {
  const { chain } = fakeChain({ views: { "alice.pbf.testnet.get_config": {}, "alice.pbf.testnet.get_state": { owner: "alice.testnet", counter: 1, loan: { principal: "0" }, verdict: null } } });
  const outlayer = { run: async () => ({ callId: "c", status: "completed" as const, output: { ok: false, reason: "unknown intent: fund" }, error: null, computeCost: "1000", timeMs: 5, attestationUrl: null }) };
  const { call, close } = await serve(fakeDeps({ chain, outlayer }).deps);
  try {
    const lenders = await call("/api/lenders");
    assert.deepEqual([lenders.status, lenders.body.lenders], [200, []], "no lender can be read here: an empty list, not an error");
    const lender = await call("/api/lender/alice.pbf.testnet");
    assert.deepEqual([lender.status, lender.body.permission, lender.body.funding, lender.body.lenders, lender.body.pricing], [200, null, null, [], null]);
    assert.deepEqual(await call("/api/lender/NOT%20VALID").then((r) => [r.status, r.body.error]), [400, "bad_request"]);
    const plan = await call("/api/funding-plan", post({ account: "alice.pbf.testnet", amount: "94500000000" }));
    assert.deepEqual([plan.status, plan.body.asked, plan.body.total, plan.body.sources, plan.body.verdict], [200, "94500000000", 0, [], { ok: false, reason: "unknown intent: fund" }]);
    assert.deepEqual(await call("/api/funding-plan", post({ account: "alice.pbf.testnet", amount: "-1" })).then((r) => [r.status, r.body.error]), [400, "bad_request"]);
    assert.deepEqual(await call("/api/funding-plan").then((r) => [r.status, r.body.error]), [404, "not_found"], "the funding plan is a POST");
    // Stage 3's two routes are POSTs too. With no chain and no gas wallet in these deps, each says it is off.
    assert.deepEqual(await call("/api/evm/submit", post({ account: "alice.pbf.testnet", nonce: 0 })).then((r) => [r.status, r.body.error]), [503, "evm_off"]);
    assert.deepEqual(await call("/api/evm/gas", post({ account: "alice.pbf.testnet" })).then((r) => [r.status, r.body.error]), [503, "gas_off"]);
    // The helper's own state is a read: off here, with its limits.
    assert.deepEqual(await call("/api/evm/gas").then((r) => [r.status, r.body.on, r.body.gas_wallet, r.body.balance, r.body.chain_id, r.body.floor]), [200, false, null, null, 84_532, "2000000000000000"]);
  } finally {
    await close();
  }
});

test("config, stage 2: the backend starts on a test chain only: a mainnet EVM_CHAIN_ID is refused by its name, and so is any chain it doesn't know", () => {
  assert.deepEqual(EVM_TEST_CHAINS, { 84532: "Base Sepolia", 421614: "Arbitrum Sepolia", 11155111: "Ethereum Sepolia", 11155420: "OP Sepolia" });
  for (const id of Object.keys(EVM_TEST_CHAINS)) assert.equal(apiConfig({ EVM_CHAIN_ID: id }).evmChainId, Number(id));
  assert.throws(
    () => apiConfig({ EVM_CHAIN_ID: "8453" }),
    /^Error: EVM_CHAIN_ID 8453 is Base, a mainnet: the backend runs on test chains only \(84532 Base Sepolia, 421614 Arbitrum Sepolia, 11155111 Ethereum Sepolia, 11155420 OP Sepolia\)\. There it will send the accounts' signed transactions and pay their gas, which on a mainnet is real money$/,
  );
  assert.throws(() => apiConfig({ EVM_CHAIN_ID: "1" }), /EVM_CHAIN_ID 1 is Ethereum, a mainnet/);
  // Every mainnet Aave v3 has a market on is refused by name.
  assert.equal(Object.keys(EVM_MAINNETS).length, 18);
  for (const [id, name] of Object.entries(EVM_MAINNETS)) assert.match(evmChainProblem(Number(id))!, new RegExp(`^EVM_CHAIN_ID ${id} is ${name}, a mainnet`));
  // The guard is the list of test chains, not the list of mainnets: an id on neither is refused too.
  assert.throws(() => apiConfig({ EVM_CHAIN_ID: "31337" }), /EVM_CHAIN_ID 31337 isn't a test chain the backend knows \(84532 Base Sepolia, .*\): it starts on those only, so that it can never send a transaction on a mainnet/);
  assert.equal(evmChainProblem(84_532), null);
});

test("config, Phase 6: the chain and Aave's test market default to INTERFACES.md 24's public addresses; no gas key and no Rhea copy unless set", () => {
  const config = apiConfig({});
  assert.deepEqual([config.evmRpcUrl, config.evmChainId, config.aavePool, config.aaveDataProvider, config.aaveFaucet, config.evmGasPrivateKey, config.rheaAccountId], [
    "https://sepolia.base.org",
    84_532,
    "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
    "0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b",
    "0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc",
    undefined,
    undefined,
  ]);
  const set = apiConfig({ EVM_RPC_URL: "https://rpc.example/", EVM_CHAIN_ID: "11155111", RHEA_ACCOUNT_ID: "rhea.pbf-ops.testnet" });
  assert.deepEqual([set.evmRpcUrl, set.evmChainId, set.rheaAccountId], ["https://rpc.example", 11_155_111, "rhea.pbf-ops.testnet"]);
  assert.throws(() => apiConfig({ AAVE_DATA_PROVIDER_ADDRESS: "0x1234" }), /AAVE_DATA_PROVIDER_ADDRESS is not a 0x address/);
  assert.throws(() => apiConfig({ EVM_CHAIN_ID: "base" }), /EVM_CHAIN_ID must be a chain id/);
  assert.equal(apiConfig({ EVM_CHAIN_ID: "421614" }).evmChainId, 421_614);
  assert.throws(() => apiConfig({ EVM_RPC_URL: "ws://x" }), /EVM_RPC_URL must be an http\(s\) URL/);
  assert.throws(() => apiConfig({ RHEA_ACCOUNT_ID: "Not An Account" }), /RHEA_ACCOUNT_ID is not a valid NEAR account id/);
});
