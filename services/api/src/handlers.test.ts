import assert from "node:assert/strict";
import { test } from "node:test";

import { OneClickError } from "@pb/oneclick";

import { fakeChain, fakeDeps, T0 } from "./fakes.js";
import { DEPOSIT_MSG, getAccount, getConfig, getPool, getStatus, postPreview, postQuote } from "./handlers.js";
import { RateLimiter } from "./limiter.js";
import { HttpError } from "./validate.js";

const ALICE = "alice.pbf.testnet";
const MUSDC = "musdc.pbf-ops.testnet";
const MNBTC = "mnbtc.pbf-ops.testnet";

/** The tokens are live on testnet; the factory, the pool and the drill aren't yet (7 Nov). */
const TODAY = { [`${MUSDC}.ft_balance_of`]: "0", [`${MNBTC}.ft_balance_of`]: "0" };

const STATE = {
  owner: "alice.testnet",
  counter: 3,
  blocked: false,
  loan: { principal: "0" },
  verdict: null,
  margin_call: { since: "0", intervals: [] },
  deleverage: { first_at: "0", confirmed_plan: null },
  hourly: [],
  pending: [],
  hl: { path: "hyperliquid-1", address: null },
};

function rejectsWith(status: number, code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof HttpError, String(error));
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  };
}

test("config: the ids of INTERFACES.md 1, which contracts are live, and no factory Config before the factory is", async () => {
  const { chain } = fakeChain({ views: TODAY, missing: ["pbf.testnet", "pool.pbf.testnet"] });
  const { deps } = fakeDeps({ chain });

  const config = await getConfig(deps);

  assert.deepEqual(config.ids, {
    factory: "pbf.testnet",
    pool: "pool.pbf.testnet",
    operator: "pbf-ops.testnet",
    keeper: "pbf-keeper.testnet",
    tokens: [
      { id: MUSDC, symbol: "USDC", decimals: 6 },
      { id: MNBTC, symbol: "nBTC", decimals: 8 },
    ],
    drill: "drill.pbf-ops.testnet",
    mpc: "v1.signer-prod.testnet",
    outlayer: "outlayer.testnet",
    risk_project: "pbf-keeper.testnet/pb-risk",
    gateway_project: "pbf-keeper.testnet/pb-gateway",
    shim_float: "shim.pbf-ops.testnet",
    hl_float: "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d",
    hl_usdc_token: "USDC:0xeb62eee3685fc4c43992febcd9e75443",
    hl_usdc_asset: "1cs_v1:hypercore:hip1:0xeb62eee3685fc4c43992febcd9e75443",
  });
  assert.equal(config.gateway_enabled, true);
  assert.equal(config.hl_api, "api.hyperliquid-testnet.xyz");
  assert.deepEqual(config.deployed, {
    "pbf.testnet": false,
    "pool.pbf.testnet": false,
    [MUSDC]: true,
    [MNBTC]: true,
    "drill.pbf-ops.testnet": false,
  });
  assert.equal(config.factory_config, null);
  assert.equal(config.network, "testnet");
  assert.equal(config.preview_enabled, true);
});

test("config: once the factory is live, its get_config comes along; without a payment key previews are off", async () => {
  const factoryConfig = { pool_id: "pool.pbf.testnet", model: "B-0.2", risk: { project_id: "pbf-keeper.testnet/pb-risk", version_key: "ab12" } };
  const { chain } = fakeChain({ views: { ...TODAY, "pbf.testnet.get_config": factoryConfig } });
  const { deps } = fakeDeps({ chain, outlayer: undefined });
  const config = await getConfig(deps);
  assert.deepEqual(config.factory_config, factoryConfig);
  assert.equal(config.deployed["pbf.testnet"], true);
  assert.equal(config.preview_enabled, false);
});

test("pool: deployed false until the pool is live, then get_pool and get_params", async () => {
  const before = fakeDeps({ chain: fakeChain({ missing: ["pool.pbf.testnet"] }).chain });
  assert.deepEqual(await getPool(before.deps), { pool_id: "pool.pbf.testnet", deployed: false, reason: "no contract code" });

  const views = { "pool.pbf.testnet.get_pool": { cash: "100000000000", paused: false }, "pool.pbf.testnet.get_params": { operator: "pbf-ops.testnet" } };
  const after = fakeDeps({ chain: fakeChain({ views, height: 4242 }).chain });
  assert.deepEqual(await getPool(after.deps), {
    pool_id: "pool.pbf.testnet",
    deployed: true,
    block_height: 4242,
    pool: { cash: "100000000000", paused: false },
    params: { operator: "pbf-ops.testnet" },
  });
});

test("account: get_state, each token's balance, and the pool's debt_of and get_borrower for it", async () => {
  const borrower = { tier: "STANDARD", debt: "0", created_at: "1", first_week_until: "2" };
  const { chain, calls } = fakeChain({
    height: 5000,
    views: {
      [`${ALICE}.get_state`]: STATE,
      [`${MUSDC}.ft_balance_of`]: ({ account_id }: Record<string, unknown>) => (account_id === ALICE ? "9500000000" : "0"),
      [`${MNBTC}.ft_balance_of`]: "25000000",
      "pool.pbf.testnet.debt_of": "0",
      "pool.pbf.testnet.get_borrower": borrower,
    },
  });
  const { deps } = fakeDeps({ chain });

  const answer = await getAccount(deps, ALICE);

  assert.deepEqual(answer, {
    account_id: ALICE,
    block_height: 5000,
    exists: true,
    has_contract: true,
    state: STATE,
    balances: [
      { token: MUSDC, symbol: "USDC", decimals: 6, amount: "9500000000" },
      { token: MNBTC, symbol: "nBTC", decimals: 8, amount: "25000000" },
    ],
    debt: "0",
    borrower,
    not_deployed: [],
  });
  assert.ok(calls.includes(`pool.pbf.testnet.debt_of({"account_id":"${ALICE}"})`));
  assert.ok(calls.includes(`pool.pbf.testnet.get_borrower({"account_id":"${ALICE}"})`));
});

test("account: the balances are of the tokens the account's own settings list, five for an account made since 13 Nov (INTERFACES.md 49.6)", async () => {
  const METH = "meth.pbf-ops.testnet";
  const five = [
    { id: MUSDC, symbol: "USDC", decimals: 6 },
    { id: MNBTC, symbol: "nBTC", decimals: 8 },
    { id: METH, symbol: "ETH", decimals: 18 },
    { id: "mwnear.pbf-ops.testnet", symbol: "wNEAR", decimals: 24 },
    { id: "musdt.pbf-ops.testnet", symbol: "USDT", decimals: 6 },
  ];
  const { chain, calls } = fakeChain({
    views: {
      [`${ALICE}.get_state`]: STATE,
      [`${ALICE}.get_config`]: { tokens: five, usdc_token: MUSDC },
      [`${MUSDC}.ft_balance_of`]: "1000000",
      [`${MNBTC}.ft_balance_of`]: "0",
      [`${METH}.ft_balance_of`]: "30000000000000000",
      "mwnear.pbf-ops.testnet.ft_balance_of": "0",
      "musdt.pbf-ops.testnet.ft_balance_of": "0",
    },
    missing: ["pool.pbf.testnet"],
  });
  const { deps } = fakeDeps({ chain });
  const answer = await getAccount(deps, ALICE);
  assert.deepEqual(answer.balances.map((b) => `${b.symbol}:${b.decimals}:${b.amount}`), ["USDC:6:1000000", "nBTC:8:0", "ETH:18:30000000000000000", "wNEAR:24:0", "USDT:6:0"]);
  // The settings are written once, so they are read once and kept.
  await getAccount(deps, ALICE);
  assert.equal(calls.filter((c) => c.startsWith(`${ALICE}.get_config(`)).length, 1);

  // An account made before lists two, and one whose settings can't be read gets the backend's own two.
  const older = fakeChain({ views: { ...TODAY, [`${ALICE}.get_state`]: STATE, [`${ALICE}.get_config`]: { tokens: five.slice(0, 2) } }, missing: ["pool.pbf.testnet"] });
  assert.deepEqual((await getAccount(fakeDeps({ chain: older.chain }).deps, ALICE)).balances.map((b) => b.symbol), ["USDC", "nBTC"]);
  const unread = fakeChain({ views: { ...TODAY, [`${ALICE}.get_state`]: STATE }, missing: ["pool.pbf.testnet"] });
  const unreadDeps = fakeDeps({ chain: unread.chain }).deps;
  assert.deepEqual((await getAccount(unreadDeps, ALICE)).balances.map((b) => b.symbol), ["USDC", "nBTC"]);
  await getAccount(unreadDeps, ALICE);
  assert.equal(unread.calls.filter((c) => c.startsWith(`${ALICE}.get_config(`)).length, 2, "a list that couldn't be read isn't kept");
});

test("account: before anything is live, the reads that need the pool are null and the pool is listed", async () => {
  const { chain } = fakeChain({ views: TODAY, missing: ["pool.pbf.testnet"] });
  const answer = await getAccount(fakeDeps({ chain }).deps, ALICE);
  assert.equal(answer.exists, false, "no account until the factory creates it");
  assert.equal(answer.state, null);
  assert.equal(answer.debt, null);
  assert.equal(answer.borrower, null);
  assert.deepEqual(answer.balances.map((b) => b.amount), ["0", "0"]);
  assert.deepEqual(answer.not_deployed, ["pool.pbf.testnet"]);
});

test("account: a wallet has balances but no state; a bad id is refused", async () => {
  const { chain } = fakeChain({ views: TODAY, wallets: ["alice.testnet"], missing: ["pool.pbf.testnet"] });
  const deps = fakeDeps({ chain }).deps;
  const wallet = await getAccount(deps, "alice.testnet");
  assert.equal(wallet.exists, true);
  assert.equal(wallet.has_contract, false);
  assert.equal(wallet.state, null);
  assert.deepEqual(wallet.not_deployed, ["pool.pbf.testnet"], "the wallet itself isn't one of our contracts");
  await assert.rejects(getAccount(deps, "Not An Account"), rejectsWith(400, "bad_request"));
});

test("preview: runs pb-risk in preview mode on the build the account pins, and returns its verdict", async () => {
  const pin = { risk: { project_id: "pbf-keeper.testnet/pb-risk", version_key: "c0ffee" } };
  const { chain } = fakeChain({ views: { [`${ALICE}.get_config`]: pin } });
  const { deps, runs } = fakeDeps({ chain });

  const answer = await postPreview(deps, { account: ALICE, intent: { borrow: { amount: "24150000000" } } });

  assert.deepEqual(runs, [
    {
      project: "pbf-keeper.testnet/pb-risk",
      input: { mode: "preview", account: ALICE, intent: { borrow: { amount: "24150000000" } }, network: "testnet", snapshot: false },
      versionKey: "c0ffee",
    },
  ]);
  assert.deepEqual(answer.verdict, { ok: true, v: 1, state: "HEALTHY", allow: { borrow: 24_150_000_000, withdraw: 0 } });
  assert.deepEqual(answer.run, {
    call_id: "call-1",
    compute_cost: "1000",
    time_ms: 812,
    attestation_url: "https://testnet-api.outlayer.ai/attestations/by-call/call-1",
  });
  assert.deepEqual(answer.program, { project_id: "pbf-keeper.testnet/pb-risk", version_key: "c0ffee" });
});

test("preview: the three kinds of question from Phase 6 go to pb-risk as they are: a loan through lenders, collateral back from a lender, a token out of the address on Aave's chain", async () => {
  // Until 13 Nov the backend answered these "Unknown intent", and the app's free preview link showed that to the user.
  const pin = { risk: { project_id: "pbf-keeper.testnet/pb-risk", version_key: "c0ffee" } };
  const USDC_ON_BASE = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
  const asked = [
    { fund: { amount: "500000000" } },
    { lender_withdraw: { lender: "rhea", token: "mnbtc.pbf-ops.testnet", amount: "1500000" } },
    { lender_withdraw: { lender: "aave", token: "0x4200000000000000000000000000000000000006", amount: "20000000000000000" } },
    { evm_withdraw: { token: USDC_ON_BASE, amount: "21719550" } },
  ];
  const { deps, runs } = fakeDeps({ chain: fakeChain({ views: { [`${ALICE}.get_config`]: pin } }).chain });
  for (const intent of asked) await postPreview(deps, { account: ALICE, intent });
  assert.deepEqual(
    runs.map((r) => (r.input as { intent: unknown }).intent),
    [asked[0], asked[1], asked[2], { evm_withdraw: { token: USDC_ON_BASE.toLowerCase(), amount: "21719550" } }],
  );
  // Each is checked before a run is paid for.
  const bad = [
    { fund: { amount: "0" } },
    { lender_withdraw: { lender: "compound", token: "mnbtc.pbf-ops.testnet", amount: "1" } },
    { lender_withdraw: { lender: "rhea", token: "Not A Token", amount: "1" } },
    { evm_withdraw: { token: "mnbtc.pbf-ops.testnet", amount: "1" } },
    { evm_withdraw: { token: USDC_ON_BASE, amount: "1.5" } },
    { hl_withdraw: { amount: "1" } },
  ];
  for (const intent of bad) await assert.rejects(postPreview(deps, { account: ALICE, intent }), rejectsWith(400, "bad_request"), JSON.stringify(intent));
  assert.equal(runs.length, asked.length);
});

test("preview: pb-risk's own refusal is the answer, not an error", async () => {
  const { chain } = fakeChain({ views: { [`${ALICE}.get_config`]: { risk: { project_id: "pbf-keeper.testnet/pb-risk" } } } });
  const { deps } = fakeDeps({
    chain,
    outlayer: {
      run: async () => ({ callId: "c", status: "completed", output: { ok: false, reason: "the pool is paused" }, error: null, computeCost: "1000", timeMs: 5, attestationUrl: null }),
    },
  });
  const answer = await postPreview(deps, { account: ALICE, intent: { check: {} } });
  assert.deepEqual(answer.verdict, { ok: false, reason: "the pool is paused" });
  assert.equal(answer.program.version_key, null, "no pinned version: OutLayer runs the active one");
});

test("preview: refused before paying for a run when the request or the account isn't right", async () => {
  const { chain } = fakeChain({ views: { [`${ALICE}.get_config`]: {} } });
  const { deps, runs } = fakeDeps({ chain });

  await assert.rejects(postPreview(deps, { account: "alice.testnet", intent: { check: {} } }), rejectsWith(400, "bad_request"));
  await assert.rejects(postPreview(deps, { account: "a.b.pbf.testnet", intent: { check: {} } }), rejectsWith(400, "bad_request"));
  await assert.rejects(postPreview(deps, { account: ALICE, intent: { borrow: { amount: "-5" } } }), rejectsWith(400, "bad_request"));
  await assert.rejects(postPreview(deps, { account: ALICE, intent: { withdraw: { token: "wrap.testnet", amount: "1" } } }), rejectsWith(400, "bad_request"));
  await assert.rejects(postPreview(deps, { account: "bob.pbf.testnet", intent: { check: {} } }), rejectsWith(404, "not_deployed"));
  await assert.rejects(postPreview(fakeDeps({ chain, outlayer: undefined }).deps, { account: ALICE, intent: { check: {} } }), rejectsWith(503, "preview_off"));
  assert.equal(runs.length, 0);
});

test("preview: at most so many runs a minute, and a run that didn't complete is a 502", async () => {
  const { chain } = fakeChain({ views: { [`${ALICE}.get_config`]: {} } });
  const limited = fakeDeps({ chain, previews: new RateLimiter(1, 60_000, () => T0) });
  await postPreview(limited.deps, { account: ALICE, intent: { check: {} } });
  await assert.rejects(postPreview(limited.deps, { account: ALICE, intent: { check: {} } }), rejectsWith(429, "too_many_previews"));

  const failed = fakeDeps({
    chain,
    outlayer: { run: async () => ({ callId: "c", status: "failed", output: null, error: "trap: out of fuel", computeCost: null, timeMs: null, attestationUrl: null }) },
  });
  await assert.rejects(postPreview(failed.deps, { account: ALICE, intent: { check: {} } }), (error: unknown) => {
    assert.ok(error instanceof HttpError && error.status === 502);
    assert.match(error.message, /pb-risk did not complete: trap: out of fuel/);
    return true;
  });
});

test("quote: a deposit into a client account, with the fields 1Click needs filled in", async () => {
  const { deps, quotes } = fakeDeps();
  const body = {
    dry: false,
    originAsset: `nep141:${MNBTC}`,
    destinationAsset: `nep141:${MUSDC}`,
    amount: "1000000",
    recipient: ALICE,
    refundTo: "alice.testnet",
  };

  const answer = await postQuote(deps, body);

  assert.equal((answer as { correlationId: string }).correlationId, "q-1");
  assert.deepEqual(quotes, [
    {
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: `nep141:${MNBTC}`,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: `nep141:${MUSDC}`,
      amount: "1000000",
      refundTo: "alice.testnet",
      refundType: "ORIGIN_CHAIN",
      recipient: ALICE,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(T0 + 10 * 60_000).toISOString(),
      customRecipientMsg: '{"pb":{"deposit":{}}}',
    },
  ]);
  assert.equal(DEPOSIT_MSG, '{"pb":{"deposit":{}}}');

  await assert.rejects(postQuote(deps, { ...body, recipient: "alice.testnet" }), rejectsWith(400, "bad_request"));
  await assert.rejects(postQuote(deps, { ...body, amount: "0" }), rejectsWith(400, "bad_request"));
  await assert.rejects(postQuote(deps, { ...body, dry: "yes" }), rejectsWith(400, "bad_request"));
  await assert.rejects(postQuote(deps, { ...body, slippageTolerance: 5000 }), rejectsWith(400, "bad_request"));
  assert.equal(quotes.length, 1);
});

test("quote and status: 1Click's own errors pass through; an unreachable shim says how to start it", async () => {
  const shimDown = fakeDeps({
    oneClick: {
      baseUrl: "http://localhost:8787",
      quote: async () => {
        throw new TypeError("fetch failed");
      },
      status: async () => {
        throw new OneClickError(404, { message: "Unknown deposit address (and memo)" }, "/v0/status");
      },
    },
  });
  const body = { dry: true, originAsset: "a", destinationAsset: "b", amount: "1", recipient: ALICE, refundTo: "alice.testnet" };
  await assert.rejects(postQuote(shimDown.deps, body), (error: unknown) => {
    assert.ok(error instanceof HttpError && error.code === "oneclick_unreachable");
    assert.match(error.message, /localhost:8787\. On testnet that is the shim: pnpm --filter @pb\/oneclick-shim start/);
    return true;
  });
  await assert.rejects(getStatus(shimDown.deps, new URLSearchParams({ depositAddress: "abc" })), OneClickError);
});

test("status: needs a deposit address, and passes the memo on", async () => {
  const { deps, statuses } = fakeDeps();
  assert.equal(((await getStatus(deps, new URLSearchParams({ depositAddress: "d1", depositMemo: "m1" }))) as { status: string }).status, "PROCESSING");
  await getStatus(deps, new URLSearchParams({ depositAddress: "d2" }));
  assert.deepEqual(statuses, [
    { depositAddress: "d1", memo: "m1" },
    { depositAddress: "d2", memo: undefined },
  ]);
  await assert.rejects(getStatus(deps, new URLSearchParams()), rejectsWith(400, "bad_request"));
});
