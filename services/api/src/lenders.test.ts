import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { AaveApi } from "./aave.js";
import { apiConfig } from "./config.js";
import type { EvmReader } from "./evm.js";
import { fakeChain, fakeDeps, T0 } from "./fakes.js";
import { fundingView, getLender, getLenders, LENDERS_CACHE_MS, lenderStatus, plainName, postedOf, postFundingPlan, readExt, rheaCollateralTokens, rheaHoldings, rheaLtvOf, rheaTermsOf } from "./lenders.js";
import { MAINNET_TOKENS } from "./mainnet.js";
import { rheaFree } from "./rhea.js";
import { RpcError } from "./rpc.js";
import { HttpError } from "./validate.js";

const ALICE = "alice.pbf.testnet";
const MUSDC = "musdc.pbf-ops.testnet";
const MNBTC = "mnbtc.pbf-ops.testnet";
/** INTERFACES.md 51.1: bitcoin's entry in the testnet Rhea row's `collaterals`, with the terms the row itself carries. */
const BITCOIN_AT_RHEA = { token: MNBTC, symbol: "nBTC", name: "bitcoin", decimals: 8, ltv_bp: 7_600, liq_bp: 7_600 };
const hex = (...values: bigint[]) => `0x${values.map((v) => v.toString(16).padStart(64, "0")).join("")}`;

/** Aave's API and its data provider on Base Sepolia, as they answered on 10 Nov (aave.test.ts has the same reads). */
const AAVE_API_ANSWER = {
  usdc: {
    underlyingToken: { symbol: "USDC", decimals: 6 },
    supplyInfo: { apy: { value: "0.042975004835241658471549509" } },
    borrowInfo: { apy: { value: "0.050841553026630224387883458" }, availableLiquidity: { amount: { value: "163234342.643274" } } },
  },
  wbtc: { underlyingToken: { symbol: "WBTC", decimals: 8 }, supplyInfo: { maxLTV: { value: "0.81" }, liquidationThreshold: { value: "0.85" }, liquidationBonus: { value: "0.05" }, canBeCollateral: true } },
};
const BASE_SEPOLIA = [
  hex(0n, 30_037_429_057n, 51_859_252_766_568n, 0n, 7_152_228_230_247n, 911_669_480_384_519_912_838_080n, 7_350_160_413_001_912_115_431_107n, 0n, 0n, 1_244_884_701_053_326_239_932_388_465n, 1_297_755_086_611_011_380_098_791_613n, 1_794_348_968n),
  hex(8n, 8_150n, 8_300n, 10_500n, 1_000n, 1n, 0n, 0n, 1n, 0n),
  hex(44_744_893_737_579n),
];

/** Rhea's get_assets on mainnet on 10 Nov at block 223,978,042, less the fields not read. */
const RHEA_ASSETS = [
  {
    token_id: MAINNET_TOKENS.USDC.id,
    supplied: { balance: "12509780801368100898315446" },
    borrowed: { balance: "10831579929502987084687669" },
    reserved: "200002388111842272668747",
    prot_fee: "672994604193599068728",
    margin_debt: { shares: "0", balance: "0" },
    margin_pending_debt: "0",
    borrow_apr: "0.160499048190070219026496378",
    supply_apr: "0.104225943085056404507646112",
    config: { volatility_ratio: 9500, can_use_as_collateral: true, can_deposit: true, can_borrow: true, extra_decimals: 12 },
  },
  {
    token_id: "nbtc.bridge.near",
    supplied: { balance: "5110030346558736673" },
    borrowed: { balance: "1663769328096457763" },
    reserved: "1466216852025668",
    prot_fee: "168946709805224",
    borrow_apr: "0.020048902589901407771522668",
    supply_apr: "0.00489577560144067442465565",
    config: { volatility_ratio: 8000, can_use_as_collateral: true, can_deposit: true, can_borrow: true, extra_decimals: 10 },
  },
];

/** Every lender answering, with switches to take each one down and counts of the reads made. */
function world(env: Record<string, string> = {}) {
  let now = T0;
  const down = { aave: false, evm: false, rhea: false, copy: false };
  const reads = { aave: 0, evm: 0, rhea: 0, copy: 0 };
  const aaveApi: AaveApi = async () => {
    reads.aave += 1;
    if (down.aave) throw new Error("Aave's API (api.v3.aave.com) answered HTTP 503");
    return AAVE_API_ANSWER;
  };
  const evm: EvmReader = {
    async calls() {
      reads.evm += 1;
      if (down.evm) throw new Error("The Ethereum RPC (sepolia.base.org) answered HTTP 429");
      return { chainId: 84_532, results: BASE_SEPOLIA };
    },
  };
  const mainnet = fakeChain({ height: 223_978_042, views: { "contract.main.burrow.near.get_assets": () => {
    reads.rhea += 1;
    if (down.rhea) throw new RpcError("NEAR RPC (free.rpc.fastnear.com) answered HTTP 503");
    return RHEA_ASSETS;
  } } }).chain;
  // Our testnet copy is the same contract with the test tokens.
  const copy = RHEA_ASSETS.map((a, i) => ({ ...a, token_id: i === 0 ? MUSDC : MNBTC }));
  const chain = fakeChain({ height: 240_000_000, views: { "rhea.pbf-ops.testnet.get_assets": (args: Record<string, unknown>) => {
    reads.copy += 1;
    assert.deepEqual(args, { token_ids: [MUSDC, MNBTC] });
    if (down.copy) throw new RpcError("NEAR RPC answered HTTP 503");
    return copy;
  } } }).chain;
  const { deps } = fakeDeps({ aaveApi, evm, mainnet, chain, now: () => now, config: apiConfig({ NEAR_NETWORK: "testnet", ...env }) });
  return { deps, down, reads, tick: (ms: number) => (now += ms) };
}

test("GET /api/lenders: Aave and Rhea on mainnet and Aave's test market, each in INTERFACES.md 28's shape; no testnet Rhea row until RHEA_ACCOUNT_ID is set", async () => {
  const { deps } = world();
  const answer = await getLenders(deps);
  assert.equal(answer.read_at_ms, T0);
  assert.deepEqual(answer.lenders, [
    { l: "aave", network: "mainnet", chain: "Ethereum", collateral: "WBTC", rate_bp: 508, supply_bp: 430, free: "163234342643274", ltv_bp: 8_100, liq_bp: 8_500, penalty_bp: 500, source: "Aave's API (api.v3.aave.com), the Ethereum core market", stale: false, read_at_ms: T0 },
    { l: "rhea", network: "mainnet", chain: "NEAR", collateral: "nBTC", rate_bp: 1_605, supply_bp: 1_042, free: "1878876254581", ltv_bp: 7_600, liq_bp: 7_600, penalty_bp: 30, source: "contract.main.burrow.near.get_assets at block 223978042, via free.rpc.fastnear.com", stale: false, read_at_ms: T0 },
    { l: "aave", network: "testnet", chain: "Base Sepolia", collateral: "WBTC", rate_bp: 74, supply_bp: 9, free: "44744893737579", ltv_bp: 8_150, liq_bp: 8_300, penalty_bp: 500, collateral_room: [], source: "eth_call to Aave's data provider 0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b, via sepolia.base.org", stale: false, read_at_ms: T0 },
  ]);
});

test("GET /api/lenders keeps each lender 5 minutes; one that stops answering gives its last terms, stale, and the others still answer fresh", async () => {
  const { deps, down, reads, tick } = world();
  await getLenders(deps);
  tick(60_000);
  await getLenders(deps);
  assert.deepEqual(reads, { aave: 1, evm: 1, rhea: 1, copy: 0 }, "a second request inside 5 minutes reads nothing");

  tick(LENDERS_CACHE_MS);
  down.aave = true;
  down.rhea = true;
  const later = await getLenders(deps);
  assert.deepEqual(reads, { aave: 2, evm: 2, rhea: 2, copy: 0 });
  assert.deepEqual(later.lenders.map((r) => [r.l, r.network, r.stale, r.read_at_ms]), [
    ["aave", "mainnet", true, T0],
    ["rhea", "mainnet", true, T0],
    ["aave", "testnet", false, T0 + 60_000 + LENDERS_CACHE_MS],
  ]);
  assert.equal(later.lenders[0]!.rate_bp, 508, "the stale row carries the last terms read");
});

test("GET /api/lenders leaves out a lender that has never answered, and never fails because one did", async () => {
  const { deps, down } = world();
  down.aave = true;
  down.evm = true;
  down.rhea = true;
  assert.deepEqual(await getLenders(deps), { read_at_ms: T0, lenders: [] });
  down.evm = false;
  assert.deepEqual((await getLenders(deps)).lenders.map((r) => `${r.l}:${r.network}`), ["aave:testnet"], "a failed read isn't kept: the next request tries again");
  // A backend with no mainnet reader, no Aave API and no Ethereum RPC answers an empty list.
  assert.deepEqual((await getLenders(fakeDeps().deps)).lenders, []);
});

test("GET /api/lenders adds our testnet Rhea copy once RHEA_ACCOUNT_ID is set and answers; while it doesn't answer the row is left out", async () => {
  const { deps, down, reads } = world({ RHEA_ACCOUNT_ID: "rhea.pbf-ops.testnet" });
  down.copy = true;
  assert.deepEqual((await getLenders(deps)).lenders.map((r) => `${r.l}:${r.network}`), ["aave:mainnet", "rhea:mainnet", "aave:testnet"]);
  down.copy = false;
  const answer = await getLenders(deps);
  assert.deepEqual(answer.lenders.map((r) => `${r.l}:${r.network}`), ["aave:mainnet", "rhea:mainnet", "aave:testnet", "rhea:testnet"]);
  assert.deepEqual(answer.lenders[3], { l: "rhea", network: "testnet", chain: "NEAR", collateral: "nBTC", rate_bp: 1_605, supply_bp: 1_042, free: "1878876254581", ltv_bp: 7_600, liq_bp: 7_600, penalty_bp: 30, collaterals: [BITCOIN_AT_RHEA], source: "rhea.pbf-ops.testnet.get_assets at block 240000000, via test.rpc.fastnear.com", stale: false, read_at_ms: T0 });
  assert.equal(reads.copy, 2);
  // An account that isn't a Rhea contract (no get_assets) is left out too.
  const wrong = world({ RHEA_ACCOUNT_ID: "pool.pbf.testnet" });
  assert.equal((await getLenders(wrong.deps)).lenders.length, 3);
});

test("Rhea's free USDC is its own available_amount: supplied + reserved + prot_fee - borrowed - margin debt, in the token's units", () => {
  assert.equal(rheaFree(RHEA_ASSETS[0]), "1878876254581");
  assert.equal(rheaFree({ ...RHEA_ASSETS[0]!, margin_debt: { balance: "1000000000000000000000000" }, margin_pending_debt: "500000000000000000000000" }), "378876254581");
  assert.equal(rheaFree({ ...RHEA_ASSETS[0]!, borrowed: { balance: "99999999999999999999999999" } }), "0", "never below zero");
  assert.equal(rheaFree({ token_id: "x", borrow_apr: "0.1" }), null, "no balances, no figure");
  assert.throws(() => rheaTermsOf(RHEA_ASSETS, MUSDC, MNBTC), /get_assets doesn't list musdc\.pbf-ops\.testnet/);
  const closed = RHEA_ASSETS.map((a, i) => (i === 1 ? { ...a, config: { ...a.config, can_deposit: false } } : a));
  assert.deepEqual([rheaTermsOf(closed, MAINNET_TOKENS.USDC.id, "nbtc.bridge.near").ltv_bp, rheaTermsOf(closed, MAINNET_TOKENS.USDC.id, "nbtc.bridge.near").liq_bp], [0, 0]);
});

/** get_state of an account made before Phase 6 (INTERFACES.md 4): no permission, no funding, a verdict with no ext. */
const OLD_STATE = {
  owner: "alice.testnet",
  counter: 3,
  loan: { principal: "24150000000" },
  verdict: { intent: { check: {} }, received_block: 1003, verdict: { ok: true, state: "HEALTHY", action: "NONE", blk: 1000, nonce: 3 } },
  pending: [],
};
const PERMISSION = { lenders: ["aave", "rhea"], min_hf_bp: 15_000, max_rate_bp: 2_500, moves: "any" };
const FUNDING = {
  pid: "f276800123",
  amount: "94500000000",
  stored_at: "1794300000000000000",
  expires_at: "1794301800000000000",
  steps: [
    { k: "l_supply", l: "rhea", tok: MNBTC, amt: "131000000", done: true },
    { k: "l_borrow", l: "rhea", amt: 50_667_000_000, done: false },
    { k: "p_borrow", amt: 43_833_000_000, done: false },
  ],
};
const RHEA_EXT = { l: "rhea", c: 100_000_000_000, d: 50_667_000_000, hf_bp: 15_000, r_bp: 1_591, s_bp: 1_032, room: 0, liq_bp: 7_600 };

test("GET /api/lender/:account for today's accounts: no permission, no funding plan, no lenders, and no pricing while the pool has no get_pricing", async () => {
  const { chain, calls } = fakeChain({ views: { [`${ALICE}.get_state`]: OLD_STATE, "pool.pbf.testnet.get_pool": {} }, wallets: ["alice.testnet"] });
  const { deps } = fakeDeps({ chain });
  assert.deepEqual(await getLender(deps, ALICE), { account: ALICE, read_at_ms: T0, config_lenders: [], permission: null, permission_blk: null, funding: null, verdict_blk: 1000, lenders: [], evm: null, pricing: null });
  assert.ok(calls.includes(`pool.pbf.testnet.get_pricing({"account_id":"${ALICE}"})`), calls.join("\n"));
  // No verdict yet, a wallet, and an account that doesn't exist all answer the same empty view.
  const fresh = fakeDeps({ chain: fakeChain({ views: { [`${ALICE}.get_state`]: { ...OLD_STATE, verdict: null } } }).chain });
  assert.deepEqual(await getLender(fresh.deps, ALICE), { account: ALICE, read_at_ms: T0, config_lenders: [], permission: null, permission_blk: null, funding: null, verdict_blk: null, lenders: [], evm: null, pricing: null });
  assert.deepEqual((await getLender(deps, "alice.testnet")).lenders, []);
  assert.equal((await getLender(deps, "nobody.pbf.testnet")).verdict_blk, null);
  await assert.rejects(getLender(deps, "NOT VALID"), (e: unknown) => e instanceof HttpError && e.status === 400);
});

test("GET /api/lender/:account for a Phase 6 account: its permission and funding plan as stored, each lender from the held verdict's ext with a status, and the pool's pricing", async () => {
  const aave = { l: "aave", c: 80_000_000_000, d: 56_667_000_000, hf_bp: 12_000, r_bp: 533, s_bp: 410, room: 1_000_000, liq_bp: 8_500 };
  // An account made since the audit fixes also says in which block its permission last changed (INTERFACES.md 40.1).
  const state = { ...OLD_STATE, permission: PERMISSION, permission_blk: 276_799_900, funding: FUNDING, verdict: { ...OLD_STATE.verdict, verdict: { ...OLD_STATE.verdict.verdict, blk: 276_800_123, ext: [RHEA_EXT, aave, { l: "compound", d: 5 }, null] } } };
  const pricing = { pricing: "pass_through", from: "default", fees_charged: "0", subsidy_paid: "0", credit: "0", settled_at: "0", last: [] };
  const config = { lenders: { rhea: { contract_id: "rhea.pbf-ops.testnet", collateral: ["mnbtc.pbf-ops.testnet"] }, aave: { chain_id: 84532 } } };
  const { chain } = fakeChain({ views: { [`${ALICE}.get_state`]: state, [`${ALICE}.get_config`]: config, "pool.pbf.testnet.get_pricing": pricing } });
  const answer = await getLender(fakeDeps({ chain }).deps, ALICE);
  assert.deepEqual(answer, {
    account: ALICE,
    read_at_ms: T0,
    config_lenders: ["aave", "rhea"],
    permission: PERMISSION,
    // Beside verdict_blk: this verdict was read after the permission last changed, so it can back a fund.
    permission_blk: 276_799_900,
    funding: FUNDING,
    verdict_blk: 276_800_123,
    lenders: [
      { l: "aave", posted: 80_000_000_000, debt: 56_667_000_000, hf_bp: 12_000, liq_bp: 8_500, rate_bp: 533, supply_bp: 410, room: 1_000_000, status: "thin", held: [] },
      // Rhea's own record couldn't be read here (no such contract in this chain): nothing held, no deposit, and the rest stands.
      { l: "rhea", posted: 100_000_000_000, debt: 50_667_000_000, hf_bp: 15_000, liq_bp: 7_600, rate_bp: 1_591, supply_bp: 1_032, room: 0, status: "safe", held: [], deposit: "0" },
    ],
    // Aave settings this thin (a chain id alone) aren't settings the backend can read an address's standing from.
    evm: null,
    pricing,
  });
});

/** Our Rhea copy's own answers in the sandbox (research/rhea.md 12): Rhea's 0.15.7 release file under its testnet names. */
const COPY = JSON.parse(readFileSync(new URL("../../../research/data/rhea_copy_views.json", import.meta.url), "utf8")) as {
  account: string;
  contract_id: string;
  before: { views: { block_height: number; get_account: Record<string, unknown>; get_assets: unknown[]; get_config: Record<string, unknown> } };
};
const TOKENS = [{ id: MUSDC, symbol: "USDC", decimals: 6 }, { id: MNBTC, symbol: "nBTC", decimals: 8 }];

test("stage 2: what the account holds at Rhea, from Rhea's own get_account: collateral in the token's own units, and the USDC left there as a plain deposit", async () => {
  // The saved position: 1 nBTC posted, 40,000 USDC borrowed, nothing supplied. Rhea counts both with 18 decimals.
  const real = COPY.before.views.get_account;
  assert.deepEqual(rheaHoldings(real, TOKENS, MUSDC), { held: [{ token: MNBTC, symbol: "nBTC", decimals: 8, amount: "100000000" }], deposit: "0" });
  // A repayment above the debt leaves the rest as a deposit: 9,985 micro-USD here, with dust under one unit cut off.
  const repaid = { ...real, borrowed: [], supplied: [{ token_id: MUSDC, balance: "9985000000000007", shares: "1", apr: "0.1" }], collateral: [{ token_id: MNBTC, balance: "5000004999999999", shares: "1" }, { token_id: "other.testnet", balance: "7" }] };
  assert.deepEqual(rheaHoldings(repaid, TOKENS, MUSDC), { held: [{ token: MNBTC, symbol: "nBTC", decimals: 8, amount: "500000" }], deposit: "9985" }, "a token the account's config doesn't know is left out");
  assert.deepEqual(rheaHoldings(null, TOKENS, MUSDC), { held: [], deposit: "0" }, "never registered at Rhea");
  assert.deepEqual(rheaHoldings({ collateral: "x", supplied: [{ token_id: MUSDC, balance: "abc" }] }, TOKENS, MUSDC), { held: [], deposit: "0" });

  // Through the endpoint: read at the contract the account's own config names, with the account's own tokens.
  const state = { ...OLD_STATE, permission: PERMISSION, verdict: { ...OLD_STATE.verdict, verdict: { ...OLD_STATE.verdict.verdict, ext: [RHEA_EXT] } } };
  const config = { tokens: TOKENS, usdc_token: MUSDC, lenders: { rhea: { contract_id: COPY.contract_id, collateral: [MNBTC] } } };
  const { chain, calls } = fakeChain({ views: { [`${ALICE}.get_state`]: state, [`${ALICE}.get_config`]: config, [`${COPY.contract_id}.get_account`]: repaid } });
  const answer = await getLender(fakeDeps({ chain }).deps, ALICE);
  assert.deepEqual(answer.lenders, [{ l: "rhea", posted: 100_000_000_000, debt: 50_667_000_000, hf_bp: 15_000, liq_bp: 7_600, rate_bp: 1_591, supply_bp: 1_032, room: 0, status: "safe", held: [{ token: MNBTC, symbol: "nBTC", decimals: 8, amount: "500000" }], deposit: "9985" }]);
  assert.ok(calls.includes(`${COPY.contract_id}.get_account({"account_id":"${ALICE}"})`));
  // An account with no Rhea position in its verdict asks Rhea nothing.
  const none = fakeChain({ views: { [`${ALICE}.get_state`]: OLD_STATE, [`${ALICE}.get_config`]: config } });
  await getLender(fakeDeps({ chain: none.chain }).deps, ALICE);
  assert.ok(!none.calls.some((c) => c.includes("get_account")));
});

test("stage 2: the testnet row reads our copy's real get_assets, as Rhea's 0.15.7 file answers it; its get_config, which has no contract_mode, is never asked for", async () => {
  const assets = COPY.before.views.get_assets;
  // $1,000,000 supplied, $40,000 borrowed, $0.24 kept in reserve: $960,000 free; 0.29% to borrow at 4% lent out.
  assert.deepEqual(rheaTermsOf(assets, MUSDC, MNBTC), { rate_bp: 29, supply_bp: 1, free: "960000000000", ltv_bp: 7_600, liq_bp: 7_600, penalty_bp: 30 });
  assert.equal("contract_mode" in COPY.before.views.get_config, false, "0.15.7 has 19 config fields; mainnet's 0.16.2 has contract_mode too");
  const { chain, calls } = fakeChain({ height: COPY.before.views.block_height, views: { [`${COPY.contract_id}.get_assets`]: assets, [`${COPY.contract_id}.get_config`]: COPY.before.views.get_config } });
  const { deps } = fakeDeps({ chain, config: apiConfig({ RHEA_ACCOUNT_ID: COPY.contract_id }) });
  const row = (await getLenders(deps)).lenders.find((r) => r.l === "rhea" && r.network === "testnet");
  assert.deepEqual(row, { l: "rhea", network: "testnet", chain: "NEAR", collateral: "nBTC", rate_bp: 29, supply_bp: 1, free: "960000000000", ltv_bp: 7_600, liq_bp: 7_600, penalty_bp: 30, collaterals: [BITCOIN_AT_RHEA], source: `rhea.pbf-ops.testnet.get_assets at block ${COPY.before.views.block_height}, via test.rpc.fastnear.com`, stale: false, read_at_ms: T0 });
  // The copy's own get_config is never asked for. (The factory's is, since INTERFACES.md 51.1, for its Rhea collateral list.)
  assert.ok(!calls.some((c) => c.startsWith(`${COPY.contract_id}.get_config`)));
});

test("a lender's status: none with no debt, act under 12000, thin under 13500, else safe; ext keeps aave before rhea and one entry each", () => {
  assert.deepEqual([[0, 0], [1, 11_999], [1, 12_000], [1, 13_499], [1, 13_500]].map(([d, hf_bp]) => lenderStatus({ d: d!, hf_bp: hf_bp! })), ["none", "act", "thin", "thin", "safe"]);
  assert.deepEqual(readExt([RHEA_EXT, { l: "aave" }, { l: "rhea", d: 1 }]).map((e) => [e.l, e.d]), [["aave", 0], ["rhea", 50_667_000_000]]);
  assert.deepEqual(readExt(undefined), []);
});

/** The verdict pb-risk will give a `fund` intent (INTERFACES.md 25 and 27): a fake, since the pinned engine can't yet. */
const FUND_VERDICT = {
  ok: true,
  v: 1,
  state: "HEALTHY",
  action: "NONE",
  blk: 276_800_123,
  rate_bp: 650,
  allow: { borrow: 43_833_000_000, withdraw: 0, fund: 94_500_000_000 },
  ext: [RHEA_EXT],
  fund: [
    { k: "l_supply", l: "rhea", tok: MNBTC, amt: "131000000" },
    { k: "l_borrow", l: "rhea", amt: 50_667_000_000 },
    { k: "p_borrow", amt: 43_833_000_000 },
  ],
};
const completed = (output: unknown) => ({ run: async () => ({ callId: "call-9", status: "completed" as const, output, error: null, computeCost: "1200", timeMs: 900, attestationUrl: "https://testnet-api.outlayer.ai/attestations/by-call/call-9" }) });

test("POST /api/funding-plan runs a preview with the fund intent on the account's pinned build, and answers the sources, the steps and the whole loan's rate", async () => {
  const { chain } = fakeChain({ views: { [`${ALICE}.get_config`]: { risk: { project_id: "pbf-keeper.testnet/pb-risk", version_key: "c0ffee" } } } });
  const runs: unknown[] = [];
  const outlayer = { run: async (project: string, input: unknown, versionKey?: string) => (runs.push({ project, input, versionKey }), completed(FUND_VERDICT).run()) };
  const answer = await postFundingPlan(fakeDeps({ chain, outlayer }).deps, { account: ALICE, amount: "94500000000" });
  assert.deepEqual(runs, [{ project: "pbf-keeper.testnet/pb-risk", input: { mode: "preview", account: ALICE, intent: { fund: { amount: "94500000000" } }, network: "testnet", snapshot: false }, versionKey: "c0ffee" }]);
  assert.deepEqual(answer, {
    asked: "94500000000",
    total: 94_500_000_000,
    sources: [
      { source: "rhea", amount: 50_667_000_000, rate_bp: 1_591 },
      { source: "pool", amount: 43_833_000_000, rate_bp: 650 },
    ],
    steps: FUND_VERDICT.fund,
    ext: [RHEA_EXT],
    // (50,667 x 15.91% + 43,833 x 6.50%) / 94,500 = 11.55%.
    blended_bp: 1_155,
    // INTERFACES.md 51.1: what the plan posts, by its plain name.
    posted: [{ l: "rhea", token: MNBTC, symbol: "nBTC", name: "bitcoin", decimals: 8, amount: "131000000" }],
    verdict: FUND_VERDICT,
    run: { call_id: "call-9", compute_cost: "1200", time_ms: 900, attestation_url: "https://testnet-api.outlayer.ai/attestations/by-call/call-9" },
  });
});

test("POST /api/funding-plan passes pb-risk's refusal through with no sources: today's pinned engine doesn't know fund", async () => {
  const { chain } = fakeChain({ views: { [`${ALICE}.get_config`]: {} } });
  const refusal = { ok: false, reason: "unknown intent: fund" };
  const answer = await postFundingPlan(fakeDeps({ chain, outlayer: completed(refusal) }).deps, { account: ALICE, amount: "94500000000" });
  assert.deepEqual(answer, { asked: "94500000000", total: 0, sources: [], steps: [], ext: [], blended_bp: null, posted: [], verdict: refusal, run: { call_id: "call-9", compute_cost: "1200", time_ms: 900, attestation_url: "https://testnet-api.outlayer.ai/attestations/by-call/call-9" } });
  // An older engine's ordinary verdict (no fund, no ext) reads as nothing to fund, and so does a state with no steps.
  assert.deepEqual(fundingView({ ok: true, state: "HEALTHY", allow: { borrow: 5, withdraw: 0 } }), { total: 0, sources: [], steps: [], ext: [], blended_bp: null });
  assert.deepEqual(fundingView({ ok: true, state: "WATCH", allow: { borrow: 0, withdraw: 0, fund: 0 }, ext: [RHEA_EXT], fund: [] }), { total: 0, sources: [], steps: [], ext: [RHEA_EXT], blended_bp: null });
});

test("a funding view: Aave before Rhea before our pool, and no blended rate when a source's rate is unknown", () => {
  const aave = { l: "aave", c: 0, d: 0, hf_bp: 0, r_bp: 533, s_bp: 410, room: 56_667_000_000, liq_bp: 8_500 };
  const view = fundingView({ ok: true, rate_bp: 650, allow: { fund: 94_500_000_000 }, ext: [aave], fund: [{ k: "p_borrow", amt: 37_833_000_000 }, { k: "l_borrow", l: "aave", amt: 56_667_000_000 }] });
  assert.deepEqual(view.sources, [{ source: "aave", amount: 56_667_000_000, rate_bp: 533 }, { source: "pool", amount: 37_833_000_000, rate_bp: 650 }]);
  // (56,667 x 5.33% + 37,833 x 6.50%) / 94,500 = 5.80%, FUNDING.md's worked figure (INTERFACES.md 27: blended_bp 580).
  assert.equal(view.blended_bp, 580);
  const noRate = fundingView({ ok: true, allow: { fund: 10 }, fund: [{ k: "p_borrow", amt: 10 }] });
  assert.deepEqual([noRate.sources, noRate.blended_bp], [[{ source: "pool", amount: 10, rate_bp: null }], null]);
});

test("POST /api/funding-plan refuses a bad account or amount before paying for a run", async () => {
  const { chain } = fakeChain({ views: { [`${ALICE}.get_config`]: {} } });
  const { deps, runs } = fakeDeps({ chain });
  const bad = (status: number, code: string) => (e: unknown) => e instanceof HttpError && e.status === status && e.code === code;
  await assert.rejects(postFundingPlan(deps, { account: "alice.testnet", amount: "5" }), bad(400, "bad_request"));
  await assert.rejects(postFundingPlan(deps, { account: ALICE, amount: 5 }), bad(400, "bad_request"));
  await assert.rejects(postFundingPlan(deps, { account: ALICE, amount: "0" }), bad(400, "bad_request"));
  await assert.rejects(postFundingPlan(deps, { account: ALICE }), bad(400, "bad_request"));
  await assert.rejects(postFundingPlan(deps, { account: "bob.pbf.testnet", amount: "5" }), bad(404, "not_deployed"));
  await assert.rejects(postFundingPlan(fakeDeps({ chain, outlayer: undefined }).deps, { account: ALICE, amount: "5" }), bad(503, "preview_off"));
  assert.equal(runs.length, 0);
});

// ---------- INTERFACES.md 51.1: ETH at Rhea, in the rows and the words ----------

const METH = "meth.pbf-ops.testnet";
/** The factory's settings after 51.1's set_config: bitcoin and ETH at Rhea, and the five tokens. */
const FACTORY_51 = {
  tokens: [
    { id: MUSDC, symbol: "USDC", decimals: 6 },
    { id: MNBTC, symbol: "nBTC", decimals: 8 },
    { id: METH, symbol: "ETH", decimals: 18 },
    { id: "mwnear.pbf-ops.testnet", symbol: "wNEAR", decimals: 24 },
  ],
  lenders: { rhea: { contract_id: "rhea.pbf-ops.testnet", collateral: [MNBTC, METH] } },
};
/** Our copy's get_assets with test ETH listed as real Rhea lists ETH: volatility ratio 7500, collateral only. */
const copyWithEth = () => [
  ...RHEA_ASSETS.map((a, i) => ({ ...a, token_id: i === 0 ? MUSDC : MNBTC })),
  { token_id: METH, supplied: { balance: "0" }, borrowed: { balance: "0" }, reserved: "0", prot_fee: "0", config: { volatility_ratio: 7500, can_use_as_collateral: true, can_deposit: true, can_borrow: false, extra_decimals: 0 } },
];

test("51.1, the testnet Rhea row carries each collateral token's own terms and plain name, bitcoin first; the row's own collateral, ltv_bp and liq_bp stay bitcoin's, so a reader of before reads what it read", async () => {
  const asked: unknown[] = [];
  const { chain } = fakeChain({
    height: 240_000_000,
    views: {
      "pbf.testnet.get_config": FACTORY_51,
      "rhea.pbf-ops.testnet.get_assets": (args: Record<string, unknown>) => (asked.push(args), copyWithEth()),
    },
  });
  const { deps } = fakeDeps({ chain, config: apiConfig({ RHEA_ACCOUNT_ID: "rhea.pbf-ops.testnet" }) });
  const row = (await getLenders(deps)).lenders.find((r) => r.l === "rhea" && r.network === "testnet")!;
  assert.deepEqual(asked, [{ token_ids: [MUSDC, MNBTC, METH] }], "one read of the copy, for USDC and both collateral tokens");
  // Bitcoin: 8000 x 9500 = 76%. Ether: 7500 x 9500 = 71.25%.
  assert.deepEqual(row.collaterals, [
    { token: MNBTC, symbol: "nBTC", name: "bitcoin", decimals: 8, ltv_bp: 7_600, liq_bp: 7_600 },
    { token: METH, symbol: "ETH", name: "ether", decimals: 18, ltv_bp: 7_125, liq_bp: 7_125 },
  ]);
  assert.deepEqual([row.collateral, row.ltv_bp, row.liq_bp, row.rate_bp, row.supply_bp, row.free, row.penalty_bp], ["nBTC", 7_600, 7_600, 1_605, 1_042, "1878876254581", 30]);
});

test("51.1, a token of the factory's list the copy doesn't list yet is left out of the row; a factory that can't be read, or lists only bitcoin, gives bitcoin alone, as before", async () => {
  const row = async (views: Record<string, unknown>) => {
    const { chain } = fakeChain({ height: 240_000_000, views });
    return (await getLenders(fakeDeps({ chain, config: apiConfig({ RHEA_ACCOUNT_ID: "rhea.pbf-ops.testnet" }) }).deps)).lenders.find((r) => r.l === "rhea" && r.network === "testnet")!;
  };
  const bitcoinOnly = RHEA_ASSETS.map((a, i) => ({ ...a, token_id: i === 0 ? MUSDC : MNBTC }));
  // The factory lists test ETH; the copy doesn't yet.
  assert.deepEqual((await row({ "pbf.testnet.get_config": FACTORY_51, "rhea.pbf-ops.testnet.get_assets": bitcoinOnly })).collaterals, [BITCOIN_AT_RHEA]);
  // No factory to read, and today's factory.
  assert.deepEqual((await row({ "rhea.pbf-ops.testnet.get_assets": copyWithEth() })).collaterals, [BITCOIN_AT_RHEA]);
  assert.deepEqual((await row({ "pbf.testnet.get_config": { ...FACTORY_51, lenders: { rhea: { collateral: [MNBTC] } } }, "rhea.pbf-ops.testnet.get_assets": copyWithEth() })).collaterals, [BITCOIN_AT_RHEA]);
  // The rules on their own.
  assert.deepEqual(rheaCollateralTokens(FACTORY_51, TOKENS[1]!).map((t) => [t.id, t.symbol, t.decimals]), [[MNBTC, "nBTC", 8], [METH, "ETH", 18]]);
  assert.deepEqual(rheaCollateralTokens({ ...FACTORY_51, lenders: { rhea: { collateral: [METH, "other.testnet", MNBTC, METH] } } }, TOKENS[1]!).map((t) => t.id), [MNBTC, METH], "bitcoin first, each once, and one the token list doesn't name left out");
  assert.deepEqual([rheaLtvOf(copyWithEth(), MUSDC, METH), rheaLtvOf(copyWithEth(), MUSDC, MNBTC), rheaLtvOf(copyWithEth(), MUSDC, "other.testnet"), rheaLtvOf(null, MUSDC, METH)], [7_125, 7_600, null, null]);
  // Listed, and not taken as collateral: it lends nothing against it.
  const notCollateral = copyWithEth().map((a) => (a.token_id === METH ? { ...a, config: { ...a.config, can_use_as_collateral: false } } : a));
  assert.equal(rheaLtvOf(notCollateral, MUSDC, METH), 0);
  assert.deepEqual([plainName("nBTC"), plainName("WBTC"), plainName("ETH"), plainName("WETH"), plainName("USDC"), plainName("wNEAR")], ["bitcoin", "bitcoin", "ether", "ether", "USDC", "wNEAR"]);
});

test("51.1, the funding plan says what it posts by its plain name: ether for test ETH at Rhea and for WETH at Aave, bitcoin for nBTC and WBTC; a token nobody names is given by its id", async () => {
  const A_WETH = "0x4200000000000000000000000000000000000006";
  const config = {
    risk: { project_id: "pbf-keeper.testnet/pb-risk", version_key: "c0ffee" },
    tokens: FACTORY_51.tokens,
    lenders: { rhea: { contract_id: "rhea.pbf-ops.testnet", collateral: [MNBTC, METH] }, aave: { chain_id: 84532, collateral: [{ symbol: "WBTC", address: "0x54114591963CF60EF3aA63bEfD6eC263D98145a4", decimals: 8 }, { symbol: "WETH", address: A_WETH, decimals: 18 }] } },
  };
  const verdict = { ...FUND_VERDICT, fund: [{ k: "l_supply", l: "rhea", tok: METH, amt: "524400000000000000" }, { k: "l_borrow", l: "rhea", amt: 430_000_000 }, { k: "p_borrow", amt: 500_000_000 }] };
  const { chain } = fakeChain({ views: { [`${ALICE}.get_config`]: config } });
  const answer = await postFundingPlan(fakeDeps({ chain, outlayer: completed(verdict) }).deps, { account: ALICE, amount: "930000000" });
  assert.deepEqual(answer.posted, [{ l: "rhea", token: METH, symbol: "ETH", name: "ether", decimals: 18, amount: "524400000000000000" }]);
  assert.deepEqual(answer.steps, verdict.fund, "the engine's own steps are passed on as they were");

  const steps = [
    { k: "l_supply", l: "aave", tok: A_WETH.toUpperCase().replace("0X", "0x"), amt: "20000000000000000" },
    { k: "l_supply", l: "aave", tok: "0x54114591963cf60ef3aa63befd6ec263d98145a4", amt: 55000 },
    { k: "l_supply", l: "rhea", tok: MNBTC, amt: "1500000" },
    { k: "l_supply", l: "rhea", tok: "other.testnet", amt: "7" },
    { k: "l_borrow", l: "rhea", amt: 5 },
    { k: "l_supply", l: "nobody", tok: MNBTC, amt: "1" },
  ];
  assert.deepEqual(postedOf(steps, config, TOKENS).map((p) => [p.l, p.symbol, p.name, p.decimals, p.amount]), [
    ["aave", "WETH", "ether", 18, "20000000000000000"],
    ["aave", "WBTC", "bitcoin", 8, "55000"],
    ["rhea", "nBTC", "bitcoin", 8, "1500000"],
    ["rhea", null, "other.testnet", null, "7"],
  ]);
  // An account whose settings can't be read: the backend's own two tokens still name bitcoin.
  assert.deepEqual(postedOf(steps.slice(2, 3), null, TOKENS).map((p) => p.name), ["bitcoin"]);
});

test("51.1, what an account holds at Rhea shows test ETH in its own units, one for one, when its settings list it", async () => {
  const account = { collateral: [{ token_id: METH, balance: "524400000000000000", shares: "1" }, { token_id: MNBTC, balance: "15000000000000000", shares: "1" }], supplied: [] };
  const tokens = [...TOKENS, { id: METH, symbol: "ETH", decimals: 18 }];
  assert.deepEqual(rheaHoldings(account, tokens, MUSDC).held, [
    { token: METH, symbol: "ETH", decimals: 18, amount: "524400000000000000" },
    { token: MNBTC, symbol: "nBTC", decimals: 8, amount: "1500000" },
  ]);
  // An account from before the five tokens doesn't know test ETH: it is left out, as any unknown token is.
  assert.deepEqual(rheaHoldings(account, TOKENS, MUSDC).held.map((h) => h.symbol), ["nBTC"]);
});
