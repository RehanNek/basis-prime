import assert from "node:assert/strict";
import { test } from "node:test";

import { isPriced, loanOpen, minPeriodMs, StateReader, toVerdict, type AccountState, type StateSource } from "./state.js";

const T0 = Date.UTC(2026, 10, 8, 12, 0);

/** INTERFACES.md 4's get_state, with a stored DELEVERAGE verdict and a loan. */
const STATE: AccountState = {
  owner: "alice.testnet",
  counter: 3,
  loan: { principal: "24150000000" },
  verdict: { intent: { check: {} }, received_block: 1003, verdict: { state: "DELEVERAGE", action: "DELEVERAGE", blk: 1000, nonce: 3 } },
  hl: { path: "hyperliquid-1", address: "0x1111111111111111111111111111111111111111" },
};

function fakeSource(states: Record<string, AccountState | null>) {
  const calls: string[] = [];
  const source: StateSource = {
    async viewOrNull<T extends object>(contractId: string, method: string) {
      calls.push(`${contractId}.${method}`);
      return (states[contractId] ?? null) as T | null;
    },
    async blockTimeMs(height: number) {
      calls.push(`block ${height}`);
      return T0 + height;
    },
  };
  return { source, calls };
}

test("a stored verdict becomes the keeper's Verdict, timed by the block that stored it", async () => {
  const { source, calls } = fakeSource({ "alice.pbf.testnet": STATE });
  const reader = new StateReader(source, 5_000, () => T0);

  assert.deepEqual(await reader.verdict("alice.pbf.testnet"), { state: "DELEVERAGE", action: "DELEVERAGE", blk: 1000, nonce: 3, receivedBlock: 1003, at: T0 + 1003, bands: undefined, tokens: [] });
  assert.equal(await reader.hlAddress("alice.pbf.testnet"), "0x1111111111111111111111111111111111111111");
  assert.deepEqual(calls, ["alice.pbf.testnet.get_state", "block 1003"], "one get_state serves both reads in a tick");
});

test("no account, no contract or no verdict yet: nothing to act on, and no error", async () => {
  const { source } = fakeSource({ "fresh.pbf.testnet": { ...STATE, verdict: null, hl: { path: "hyperliquid-1", address: null } } });
  const reader = new StateReader(source);
  assert.equal(await reader.verdict("nobody.pbf.testnet"), null);
  assert.equal(await reader.hlAddress("nobody.pbf.testnet"), undefined);
  assert.equal(await reader.verdict("fresh.pbf.testnet"), null);
  assert.equal(await reader.hlAddress("fresh.pbf.testnet"), undefined);
});

test("the next tick reads again; a loan of 0 is no loan, and loan.open wins where the account has it", async () => {
  let now = T0;
  const { source, calls } = fakeSource({ "alice.pbf.testnet": { ...STATE, loan: { principal: "0" } } });
  const reader = new StateReader(source, 5_000, () => now);
  assert.equal(loanOpen((await reader.state("alice.pbf.testnet"))?.loan), false);
  assert.equal(loanOpen({ principal: "0", open: true }), true);
  assert.equal(loanOpen({ principal: "5", open: false }), false);
  await reader.verdict("alice.pbf.testnet");
  now += 15_000;
  await reader.verdict("alice.pbf.testnet");
  assert.deepEqual(calls, ["alice.pbf.testnet.get_state", "block 1003", "alice.pbf.testnet.get_state"], "the block time is kept");
  assert.equal(toVerdict({ ...STATE, verdict: null }, T0), null);
});

test("Phase 6: the verdict's borrow allowance is kept where it says one, for the funding plan's pool step", () => {
  const held = { ...STATE.verdict!, verdict: { ...STATE.verdict!.verdict, allow: { borrow: 530_000_000, withdraw: 0, fund: 1_100_000_000 } } };
  assert.equal(toVerdict({ ...STATE, verdict: held }, T0)!.allowBorrow, 530_000_000);
  assert.equal(toVerdict({ ...STATE, verdict: { ...held, verdict: { ...held.verdict, allow: { borrow: 0 } } } }, T0)!.allowBorrow, 0);
  assert.equal("allowBorrow" in toVerdict(STATE, T0)!, false, "an older verdict's shape is unchanged");
});

test("INTERFACES.md 45.3: what the keeper reads off the pool's views: whether an account's policy is anything but pass-through, and the pool's time between two settlements", () => {
  // get_pricing(account): the policy that applies, the account's own or its tier's.
  assert.equal(isPriced({ pricing: "pass_through", from: "default", fees_charged: "0", last: [] }), false);
  assert.equal(isPriced({ pricing: { fixed: { rate_bp: 650 } }, from: "account" }), true);
  assert.equal(isPriced({ pricing: { lender: { margin_bp: 500, cap_bp: null } }, from: "tier" }), true);
  assert.deepEqual([isPriced(null), isPriced(undefined), isPriced({}), isPriced({ pricing: null })], [false, false, false, false]);

  // get_params().pricing_limits.min_period_ns: 2 minutes on testnet, 10 by default; a plain number of nanoseconds.
  assert.equal(minPeriodMs({ pricing_limits: { max_period_ns: 172_800_000_000_000, min_period_ns: 120_000_000_000 } }), 120_000);
  assert.equal(minPeriodMs({ pricing_limits: { min_period_ns: 600_000_000_000 } }), 600_000);
  assert.equal(minPeriodMs({ pricing_limits: { min_period_ns: "120000000000" } }), 120_000);
  assert.equal(minPeriodMs({ pricing_limits: { min_period_ns: 1 } }), 1, "never rounded down to no wait at all");
  assert.deepEqual([minPeriodMs(null), minPeriodMs({}), minPeriodMs({ pricing_limits: null }), minPeriodMs({ pricing_limits: { min_period_ns: 0 } }), minPeriodMs({ pricing_limits: { min_period_ns: "soon" } })], [null, null, null, null, null]);
});
