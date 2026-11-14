import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { fakeChain, fakeDeps, T0 } from "./fakes.js";
import { getPricing, PRICING_CACHE_MS, pricingAccount, tierList } from "./pricing.js";
import { RpcError } from "./rpc.js";
import { createApiServer } from "./server.js";

const POOL = "pool.pbf.testnet";
const FACTORY = "pbf.testnet";
const FUNDING = { order: "cheapest", loan_days: 90 };
const LIMITS = { max_rate_bp: 6_000, avg_plus_bp: 500, max_period_ns: 172_800_000_000_000, account_subsidy_day: "100000000", pool_subsidy_day_bp: 5 };
const CAPPED = { lender: { margin_bp: 0, cap_bp: 800 } };
const MARGIN = { lender: { margin_bp: 120, cap_bp: null } };
const FIXED = { fixed: { rate_bp: 650 } };

/** The pool's get_pricing answer for an account with nothing set and nothing on record. */
const PLAIN = { pricing: "pass_through", from: "default", fees_charged: "0", subsidy_paid: "0", credit: "0", settled_at: "0", last: [] };
const rheaReport = (debt: string) => ({ lender: "rhea", debt, rate_bp: 1_591, supply_bp: 1_016 });
const rheaExt = (d: number) => ({ l: "rhea", c: 1_130_000_000, d, hf_bp: 15_000, r_bp: 1_591, s_bp: 1_016, room: 0, liq_bp: 7_600 });
const state = (ext?: unknown[]) => ({ owner: "x.testnet", counter: 1, loan: { principal: "0" }, verdict: ext ? { intent: { check: {} }, received_block: 5, verdict: { ok: true, state: "HEALTHY", blk: 4, nonce: 1, ext } } : null });

/** A pool with pricing live, and five accounts: one of each kind the Book page has to tell apart. */
function book() {
  const pricing: Record<string, unknown> = {
    // Its own policy, and a Rhea loan the pool has settled on.
    "own.pbf.testnet": { pricing: CAPPED, from: "account", fees_charged: "0", subsidy_paid: "457500", credit: "0", settled_at: "1794400000000000000", last: [rheaReport("570000000")] },
    // No policy of its own: its tier's. A Rhea loan all the same.
    "tier.pbf.testnet": { pricing: MARGIN, from: "tier", fees_charged: "108", subsidy_paid: "0", credit: "0", settled_at: "1794400000000000000", last: [rheaReport("430000000")] },
    // A loan made a minute ago: the pool's last report still says 0 (it was written just before the borrow).
    "fresh.pbf.testnet": { ...PLAIN, settled_at: "1794400100000000000", last: [rheaReport("0")] },
    // A pool loan only, and nothing set: not on the list.
    "plain.pbf.testnet": PLAIN,
    // Repaid long ago, but the pool still holds a credit for it.
    "credit.pbf.testnet": { ...PLAIN, subsidy_paid: "9000", credit: "2500" },
  };
  const states: Record<string, unknown> = {
    "own.pbf.testnet": state([rheaExt(570_250_000)]),
    "tier.pbf.testnet": state([rheaExt(430_000_000)]),
    "fresh.pbf.testnet": state([rheaExt(600_000_000)]),
    "plain.pbf.testnet": state(),
    "credit.pbf.testnet": state([rheaExt(0)]),
  };
  const ids = Object.keys(pricing);
  return fakeChain({
    views: {
      [`${POOL}.get_params`]: { operator: "pbf-ops.testnet", funding: FUNDING, pricing_limits: LIMITS, tier_pricing: { WATCH: FIXED, PREFERRED: MARGIN } },
      [`${POOL}.get_pool`]: { cash: "900000000000", loans: "100000000000", fees_charged: "108", subsidy_paid: "466500", subsidy_left_24h: "499533500" },
      [`${POOL}.get_pricing`]: (args: Record<string, unknown>) => pricing[String(args.account_id)] ?? PLAIN,
      [`${FACTORY}.list_accounts`]: ids.map((account_id) => ({ account_id, owner: "x.testnet" })),
      ...Object.fromEntries(ids.map((id) => [`${id}.get_state`, states[id]])),
    },
  });
}

test("GET /api/pricing: the pool's funding order, limits and totals, the tiers that have a policy, and every account with a lender loan, a policy of its own or something on record", async () => {
  const { chain } = book();
  const answer = await getPricing(fakeDeps({ chain }).deps);
  assert.deepEqual(answer, {
    read_at_ms: T0,
    funding: FUNDING,
    limits: LIMITS,
    pool: { fees_charged: "108", fees_reversed: "0", subsidy_paid: "466500", subsidy_left_24h: "499533500" },
    // Only the tiers the operator has set, in the pool's order, whatever order the pool's map came in.
    tiers: [{ tier: "PREFERRED", pricing: MARGIN }, { tier: "WATCH", pricing: FIXED }],
    accounts: [
      { account: "own.pbf.testnet", pricing: CAPPED, from: "account", fees_charged: "0", fees_reversed: "0", subsidy_paid: "457500", credit: "0", settled_at: "1794400000000000000", last: [rheaReport("570000000")], lender_debt: [{ lender: "rhea", debt: "570250000" }] },
      { account: "tier.pbf.testnet", pricing: MARGIN, from: "tier", fees_charged: "108", fees_reversed: "0", subsidy_paid: "0", credit: "0", settled_at: "1794400000000000000", last: [rheaReport("430000000")], lender_debt: [{ lender: "rhea", debt: "430000000" }] },
      // A fresh loan is on the list by its verdict, though the pool's last report hasn't seen it yet.
      { account: "fresh.pbf.testnet", pricing: "pass_through", from: "default", fees_charged: "0", fees_reversed: "0", subsidy_paid: "0", credit: "0", settled_at: "1794400100000000000", last: [rheaReport("0")], lender_debt: [{ lender: "rhea", debt: "600000000" }] },
      { account: "credit.pbf.testnet", pricing: "pass_through", from: "default", fees_charged: "0", fees_reversed: "0", subsidy_paid: "9000", credit: "2500", settled_at: "0", last: [], lender_debt: [] },
    ],
  });
  // What the Book page adds up: what is lent through Rhea, by the pool's reports and by the verdicts.
  const sum = (pick: (a: (typeof answer.accounts)[number]) => { lender: string; debt: string }[]) => answer.accounts.flatMap(pick).filter((r) => r.lender === "rhea").reduce((s, r) => s + BigInt(r.debt), 0n);
  assert.deepEqual([sum((a) => a.last), sum((a) => a.lender_debt)], [1_000_000_000n, 1_600_250_000n]);
});

test("GET /api/pricing on a pool from before stage 2: nothing set, nothing charged, no lists, and no account is read", async () => {
  const { chain, calls } = fakeChain({ views: { [`${POOL}.get_params`]: { operator: "pbf-ops.testnet", caps: {} }, [`${POOL}.get_pool`]: { cash: "1", loans: "0" }, [`${FACTORY}.list_accounts`]: [{ account_id: "old.pbf.testnet" }] } });
  assert.deepEqual(await getPricing(fakeDeps({ chain }).deps), { read_at_ms: T0, funding: null, limits: null, pool: null, tiers: [], accounts: [] });
  assert.deepEqual(calls, [`${POOL}.get_params({})`, `${POOL}.get_pool({})`]);
  // No pool at all answers the same.
  assert.deepEqual(await getPricing(fakeDeps().deps), { read_at_ms: T0, funding: null, limits: null, pool: null, tiers: [], accounts: [] });
});

test("GET /api/pricing is kept 15 s, and an account that can't be read is left out while the others answer", async () => {
  let now = T0;
  const { chain, calls } = book();
  const { deps } = fakeDeps({ chain, now: () => now });
  await getPricing(deps);
  const reads = calls.length;
  now += PRICING_CACHE_MS - 1;
  assert.equal((await getPricing(deps)).read_at_ms, T0);
  assert.equal(calls.length, reads, "inside 15 s nothing is read again");
  now += 1;
  assert.equal((await getPricing(deps)).read_at_ms, T0 + PRICING_CACHE_MS);
  assert.equal(calls.length, 2 * reads);

  const broken = fakeChain({
    views: {
      [`${POOL}.get_params`]: { funding: FUNDING, pricing_limits: LIMITS },
      [`${POOL}.get_pool`]: { fees_charged: "0", subsidy_paid: "0", subsidy_left_24h: "0" },
      [`${POOL}.get_pricing`]: (args: Record<string, unknown>) => {
        if (args.account_id === "bad.pbf.testnet") throw new RpcError("NEAR RPC answered HTTP 503");
        return { ...PLAIN, from: "account", pricing: FIXED };
      },
      [`${FACTORY}.list_accounts`]: [{ account_id: "bad.pbf.testnet" }, { account_id: "good.pbf.testnet" }],
      "good.pbf.testnet.get_state": state(),
    },
  });
  const answer = await getPricing(fakeDeps({ chain: broken.chain }).deps);
  assert.deepEqual(answer.accounts.map((a) => [a.account, a.from]), [["good.pbf.testnet", "account"]]);
  assert.deepEqual(answer.tiers, [], "no tier has a policy");
});

test("an account's line: on the list for a lender loan in the pool's report or in its verdict, a policy of its own, or a fee, subsidy or credit on record", () => {
  assert.equal(pricingAccount("a.pbf.testnet", PLAIN, undefined), null);
  assert.equal(pricingAccount("a.pbf.testnet", { ...PLAIN, last: [rheaReport("0")] }, [rheaExt(0)]), null, "a repaid loan with nothing on record");
  assert.equal(pricingAccount("a.pbf.testnet", null, [rheaExt(5)]), null, "the pool doesn't know it");
  assert.equal(pricingAccount("a.pbf.testnet", { ...PLAIN, last: [rheaReport("5")] }, undefined)?.account, "a.pbf.testnet");
  assert.deepEqual(pricingAccount("a.pbf.testnet", PLAIN, [rheaExt(5.9), { l: "aave", d: 7 }])?.lender_debt, [{ lender: "aave", debt: "7" }, { lender: "rhea", debt: "5" }]);
  assert.equal(pricingAccount("a.pbf.testnet", { ...PLAIN, from: "account", pricing: FIXED }, undefined)?.from, "account");
  assert.equal(pricingAccount("a.pbf.testnet", { ...PLAIN, from: "tier", pricing: MARGIN }, undefined), null, "a tier's policy alone doesn't list every account of the tier");
  assert.equal(pricingAccount("a.pbf.testnet", { ...PLAIN, fees_charged: "1" }, undefined)?.fees_charged, "1");
  // Money that isn't a whole number in a string reads as "0", so the app can always add it up.
  assert.deepEqual(pricingAccount("a.pbf.testnet", { pricing: FIXED, from: "account", fees_charged: 5, last: [{ lender: "rhea", debt: 9 }, "x"] }, undefined), { account: "a.pbf.testnet", pricing: FIXED, from: "account", fees_charged: "0", fees_reversed: "0", subsidy_paid: "0", credit: "0", settled_at: "0", last: [{ lender: "rhea", debt: "0", rate_bp: 0, supply_bp: 0 }], lender_debt: [] });
  assert.deepEqual(tierList({ STANDARD: FIXED, WATCH: null }), [{ tier: "STANDARD", pricing: FIXED }]);
  assert.deepEqual([tierList(undefined), tierList([]), tierList("x")], [[], [], []]);
});

test("the route: GET /api/pricing answers the book; it is a GET only", async () => {
  const server = createApiServer(fakeDeps({ chain: book().chain }).deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/api/pricing`);
    const body = (await response.json()) as { funding: unknown; accounts: { account: string }[] };
    assert.deepEqual([response.status, body.funding, body.accounts.length], [200, FUNDING, 4]);
    assert.equal((await fetch(`${base}/api/pricing`, { method: "POST" })).status, 404);
  } finally {
    server.close();
  }
});

test("INTERFACES.md 45.3, item 11: GET /api/pricing passes on the pool's three limits on a fee, and the fees the operator took back, for the pool and for each account", async () => {
  // The pool after its change of 12 Nov: three more limits, and a total of reversed fees in get_pool and get_pricing.
  const limits = { ...LIMITS, min_period_ns: 120_000_000_000, max_lender_debt: "1000000000000", account_fee_day: "1000000000", pool_fee_day_bp: 50 };
  const { chain } = fakeChain({
    views: {
      [`${POOL}.get_params`]: { operator: "pbf-ops.testnet", funding: FUNDING, pricing_limits: limits, tier_pricing: {} },
      [`${POOL}.get_pool`]: { fees_charged: "4000108", fees_reversed: "4000000", subsidy_paid: "0", subsidy_left_24h: "5000000000" },
      [`${POOL}.get_pricing`]: { pricing: MARGIN, from: "account", fees_charged: "4000108", fees_reversed: "4000000", subsidy_paid: "0", credit: "0", settled_at: "1794500000000000000", last: [rheaReport("545000000")] },
      [`${FACTORY}.list_accounts`]: [{ account_id: "wrong-fee.pbf.testnet", owner: "x.testnet" }],
      "wrong-fee.pbf.testnet.get_state": state([rheaExt(545_000_000)]),
    },
  });
  const answer = await getPricing(fakeDeps({ chain }).deps);
  assert.deepEqual(answer.limits, limits, "the limits come through as the pool writes them");
  assert.deepEqual(answer.pool, { fees_charged: "4000108", fees_reversed: "4000000", subsidy_paid: "0", subsidy_left_24h: "5000000000" });
  assert.deepEqual(answer.accounts.map((a) => [a.account, a.fees_charged, a.fees_reversed]), [["wrong-fee.pbf.testnet", "4000108", "4000000"]]);
  // A pool from before the change has no such total: it reads "0", for the pool and for an account.
  const before = await getPricing(fakeDeps({ chain: book().chain }).deps);
  assert.deepEqual([before.pool?.fees_reversed, before.accounts.map((a) => a.fees_reversed)], ["0", ["0", "0", "0", "0"]]);
  assert.equal(pricingAccount("a.pbf.testnet", { ...PLAIN, from: "account", fees_charged: "9", fees_reversed: 9 }, undefined)?.fees_reversed, "0", "money that isn't a whole number in a string reads as 0");
});
