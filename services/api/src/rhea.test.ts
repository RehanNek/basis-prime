import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeChain, fakeDeps, T0 } from "./fakes.js";
import { MAINNET_TOKENS } from "./mainnet.js";
import { aprBp, getRhea, readRheaAssets, RHEA_CACHE_MS } from "./rhea.js";
import { RpcError } from "./rpc.js";
import { HttpError } from "./validate.js";

/** get_assets as mainnet answered it on 9 Nov (block 223,671,598), less the fields not read. eth.bridge.near left out. */
const ASSETS = [
  { token_id: MAINNET_TOKENS.USDC.id, borrow_apr: "0.166986378336576512798006891", supply_apr: "0.108839788010259514206117056", config: { volatility_ratio: 9500, can_use_as_collateral: true, can_deposit: true, can_borrow: true } },
  { token_id: "usdt.tether-token.near", borrow_apr: "0.166809737898518946072033392", supply_apr: "0.108764528854919907242454787", config: { volatility_ratio: 9500, can_use_as_collateral: true, can_deposit: true, can_borrow: true } },
  { token_id: "nbtc.bridge.near", borrow_apr: "0.020133864173290449358000463", supply_apr: "0.004937157864266723561507566", config: { volatility_ratio: 8000, can_use_as_collateral: true, can_deposit: true, can_borrow: true } },
  { token_id: "wrap.near", borrow_apr: "0.025336650347819218142650858", supply_apr: "0.003370711248122828839732995", config: { volatility_ratio: 7500, can_use_as_collateral: false, can_deposit: true, can_borrow: true } },
];

test("Rhea's terms: volatility ratios, collateral, APRs in bp, and what it lends against each token alone", () => {
  assert.equal(aprBp("0.166986378336576512798006891"), 1_670);
  assert.equal(aprBp("1e-3"), null);
  const terms = readRheaAssets(ASSETS, 223_671_598, T0, "free.rpc.fastnear.com");
  assert.deepEqual(terms.usdc, { token_id: MAINNET_TOKENS.USDC.id, volatility_bp: 9_500, borrow_apr_bp: 1_670, supply_apr_bp: 1_088 });
  const nbtc = terms.tokens.find((t) => t.token === "nBTC")!;
  assert.deepEqual(nbtc, { token: "nBTC", token_id: "nbtc.bridge.near", listed: true, volatility_bp: 8_000, collateral: true, can_borrow: true, borrow_apr_bp: 201, supply_apr_bp: 49, ltv_bp: 7_600 });
  assert.deepEqual(terms.tokens.map((t) => [t.token, t.ltv_bp]), [["USDC", 9_025], ["nBTC", 7_600], ["ETH", 0], ["USDT", 9_025], ["wNEAR", 0]]);
  assert.equal(terms.tokens.find((t) => t.token === "ETH")!.listed, false, "a token Rhea doesn't list counts 0");
  assert.equal(terms.tokens.find((t) => t.token === "wNEAR")!.collateral, false);
  // As pb-risk counts it: a token Rhea takes no deposits of isn't collateral, whatever can_use_as_collateral says.
  const closed = ASSETS.map((a) => (a.token_id === "nbtc.bridge.near" ? { ...a, config: { ...a.config, can_deposit: false } } : a));
  assert.deepEqual(readRheaAssets(closed, 1, T0, "x").tokens.find((t) => t.token === "nBTC")!.ltv_bp, 0);
  assert.throws(() => readRheaAssets({}, 1, T0, "x"), (e: unknown) => e instanceof HttpError && e.code === "rhea");
});

test("GET /api/rhea reads get_assets on contract.main.burrow.near once per 5 minutes; with mainnet down it answers the last terms, stale", async () => {
  let now = T0;
  let down = false;
  const reads: unknown[] = [];
  const { chain } = fakeChain({ views: { "contract.main.burrow.near.get_assets": (args: Record<string, unknown>) => {
    reads.push(args);
    if (down) throw new RpcError("NEAR RPC (free.rpc.fastnear.com) answered HTTP 503");
    return ASSETS;
  } } });
  const { deps } = fakeDeps({ mainnet: chain, now: () => now });
  const first = await getRhea(deps);
  assert.deepEqual(reads, [{ token_ids: [MAINNET_TOKENS.USDC.id, "nbtc.bridge.near", "eth.bridge.near", "usdt.tether-token.near", "wrap.near"] }]);
  assert.deepEqual([first.contract, first.view, first.rpc, first.stale, first.age_s], ["contract.main.burrow.near", "get_assets", "free.rpc.fastnear.com", false, 0]);
  now += 60_000;
  assert.equal((await getRhea(deps)).age_s, 60);
  assert.equal(reads.length, 1, "kept for 5 minutes");
  now += RHEA_CACHE_MS;
  down = true;
  const stale = await getRhea(deps);
  assert.equal(reads.length, 2);
  assert.deepEqual([stale.stale, stale.age_s], [true, 360]);
  assert.match(String((stale as { error?: string }).error), /HTTP 503/);

  const fresh = fakeDeps({ mainnet: fakeChain({ views: { "contract.main.burrow.near.get_assets": new RpcError("down") } }).chain });
  await assert.rejects(getRhea(fresh.deps), (e: unknown) => e instanceof HttpError && e.status === 502 && e.code === "rhea_unreachable");
  await assert.rejects(getRhea(fakeDeps().deps), (e: unknown) => e instanceof HttpError && e.code === "rhea_off");
});
