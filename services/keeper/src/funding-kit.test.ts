// The Phase 6 gate's pieces that need no network: its step list, what the client and the operator sign, its sums, how
// it reads Rhea's record and the keeper's log, the plan in words, and what must be there before it can run.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  demoPermission,
  DEPOSITS,
  describeGate,
  dropFor,
  expectedSubsidyMicro,
  feeLimits,
  FEE_POLICY,
  GATE_ORDER,
  fundAmount,
  FUNDING_CLOSE_OUT,
  FUNDING_GATE,
  FUNDING_SETUP,
  FUNDING_STEP_IDS,
  fundParts,
  gateProblems,
  keeperLines,
  keeperReady,
  poolPartLapsed,
  rheaPosition,
  rheaRepayAmount,
  settleCheck,
  settledBetween,
  splitProblem,
  SUBSIDY_POLICY,
  type Found,
  type PricingLimitsView,
  type PricingView,
} from "./funding-kit.js";
import { hedgeNow, planFor, planForCoin } from "./hedge-kit.js";
import type { LogEvent } from "./jsonl.js";

const ACCOUNT = "demo.pbf.testnet";
const MUSDC = "musdc.pbf-ops.testnet";
const MNBTC = "mnbtc.pbf-ops.testnet";
const T0 = Date.UTC(2026, 10, 12, 9, 0);

test("the gate's steps: the hedge, then the loan, the two settlements and the top-up, then the way out, each named once", () => {
  assert.deepEqual(FUNDING_STEP_IDS, [
    ...["create", "deposit", "hl_init", "to_hl", "agent", "approve", "short"],
    ...["keeper", "order", "fund", "order_back", "funded", "fee_policy", "settle_fee", "subsidy_policy", "settle_subsidy", "price_drop", "top_up", "price_back"],
    // INTERFACES.md 50.2: between the transfer home and the withdrawal, the pause is lifted and the account borrows again.
    ...["repay_rhea", "repay", "credit", "rhea_withdraw", "close_short", "home", "pause_lifted", "borrow_again", "repay_again", "withdraw"],
  ]);
  assert.equal(new Set(FUNDING_STEP_IDS).size, FUNDING_STEP_IDS.length);
  assert.equal(FUNDING_SETUP.length + FUNDING_GATE.length + FUNDING_CLOSE_OUT.length, 29);
  // The pool's order is set just before the client's fund, and put back just after it.
  assert.deepEqual(FUNDING_GATE.slice(1, 4), ["order", "fund", "order_back"]);
  assert.equal(GATE_ORDER, "lender_first");
});

test("what is signed: the app's default permission naming the one lender, a fee policy and a subsidy policy in the pool's JSON, and each call's deposit", () => {
  assert.deepEqual(demoPermission("rhea"), { lenders: ["rhea"], min_hf_bp: 15_000, max_rate_bp: 2_500, moves: "any" });
  assert.deepEqual(JSON.parse(JSON.stringify(FEE_POLICY)), { lender: { margin_bp: 500, cap_bp: null } });
  assert.deepEqual(SUBSIDY_POLICY, { lender: { margin_bp: 0, cap_bp: 0 } });
  // The account's fund, lender_repay and lender_withdraw want exactly 1 yoctoNEAR; settle, claim_credit and the
  // pool's operator calls take none. The app sends the same.
  assert.deepEqual(DEPOSITS, { fund: 1n, lender_repay: 1n, lender_withdraw: 1n, settle: 0n, claim_credit: 0n, set_pricing: 0n, set_funding: 0n });
});

test("the amount to ask for is 0.5% under what the preview can lend; a split needs a part from the lender and a part from our pool", () => {
  assert.equal(fundAmount(1_100_000_000n), 1_094_390_548n, "$1,100 less 0.5%, then 0.01% and 2 micro-USDC");
  assert.equal(fundAmount(0n), 0n);
  const both = [{ source: "rhea", amount: 570_000_000, rate_bp: 600 }, { source: "pool", amount: 530_000_000, rate_bp: 650 }];
  assert.equal(splitProblem(both, "rhea"), null);
  assert.match(splitProblem([both[1]!], "rhea")!, /^the whole loan would come from our pool and none from Rhea: .*the pool's funding order isn't "lender_first" \(the order step sets it\)$/);
  assert.match(splitProblem([both[0]!], "rhea")!, /^the whole loan would come from Rhea and none from our pool/);
  assert.match(splitProblem([], "rhea")!, /^the engine found nothing to lend/);
  // The verdict's own steps, as fund() will store them.
  const steps = [{ k: "l_supply", l: "rhea", tok: MNBTC, amt: "1500000" }, { k: "l_borrow", l: "rhea", amt: 570_000_000 }, { k: "p_borrow", amt: "530000000" }];
  assert.deepEqual(fundParts(steps, "rhea"), { lender: 570_000_000n, pool: 530_000_000n, kinds: ["l_supply", "l_borrow", "p_borrow"] });
  assert.deepEqual(fundParts([{ k: "l_borrow", l: "aave", amt: 5 }], "rhea"), { lender: 0n, pool: 0n, kinds: ["l_borrow"] });
  assert.deepEqual(fundParts(undefined, "rhea"), { lender: 0n, pool: 0n, kinds: [] });
});

test("the price drop: from a cushion of 1.5, bitcoin 13.34% down at Rhea leaves 1.30; an aim outside 1.2 to 1.35 or a cushion already there is refused", () => {
  assert.equal(dropFor(15_000), -1_334);
  assert.equal(Math.floor(15_000 * (1 - 1_334 / 10_000)), 12_999, "just under the aim, never over it");
  assert.equal(dropFor(15_066, 12_500), -1_704);
  assert.throws(() => dropFor(13_000), /Rhea's cushion is 1\.30 already, at or under the 1\.30 the price drop aims for/);
  assert.throws(() => dropFor(15_000, 13_500), /the price drop aims between 1\.20 and 1\.35, not at 1\.35/);
  assert.throws(() => dropFor(15_000, 11_000), /the price drop aims between/);
  assert.throws(() => dropFor(30_000, 12_000), /needs bitcoin 60\.0% down to reach 1\.20: more than a hold may ask for/);
});

test("the repayment covers the debt and the next minutes' interest; a subsidy is the debt at the borrow rate less the deposit rate", () => {
  assert.equal(rheaRepayAmount(570_000_000n), 570_011_500n, "$570, 0.002% and 100 micro-USDC");
  // FUNDING.md's worked example: $50,667 at 15.91% with a deposit rate of 10.32% is $2,832.29 a year, $0.3233 an hour.
  assert.equal(expectedSubsidyMicro(50_667_000_000n, 1_591, 1_032, 3_600), 323_320n);
  assert.equal(expectedSubsidyMicro(570_000_000n, 600, 300, 120), 65n);
  assert.equal(expectedSubsidyMicro(570_000_000n, 2, 1, 120), 0n, "a copy that lends at 0.02% shows no subsidy in two minutes");
  assert.equal(expectedSubsidyMicro(570_000_000n, 300, 600, 120), 0n);
});

test("Rhea's get_account: inner units (18 decimals) become micro-USD owed, rounded up, and nBTC units posted, rounded down", () => {
  const account = {
    account_id: ACCOUNT,
    supplied: [{ token_id: MUSDC, balance: "11500000000000000", shares: "1" }],
    collateral: [{ token_id: MNBTC, balance: "15000004999999999", shares: "1" }],
    borrowed: [{ token_id: MUSDC, balance: "570000000000000000001", shares: "1" }],
  };
  assert.deepEqual(rheaPosition(account, MUSDC, MNBTC), { registered: true, debtMicro: 570_000_001n, collateralUnits: 1_500_000n, suppliedMicro: 11_500n });
  assert.deepEqual(rheaPosition({ supplied: [], collateral: [], borrowed: [] }, MUSDC, MNBTC), { registered: true, debtMicro: 0n, collateralUnits: 0n, suppliedMicro: 0n });
  assert.deepEqual(rheaPosition(null, MUSDC, MNBTC), { registered: false, debtMicro: 0n, collateralUnits: 0n, suppliedMicro: 0n }, "never registered");
});

test("what a settlement booked is the change in the pool's own record of the account", () => {
  const before: PricingView = { pricing: FEE_POLICY, from: "account", fees_charged: "100", subsidy_paid: "0", credit: "0", settled_at: "1", last: [] };
  assert.deepEqual(settledBetween(before, { ...before, fees_charged: "480" }), { fee: 380n, subsidy: 0n });
  assert.deepEqual(settledBetween(before, { ...before, subsidy_paid: "65" }), { fee: 0n, subsidy: 65n });
});

const tick = (at: number, fields: Record<string, unknown> = {}): LogEvent => ({ t: new Date(at).toISOString(), event: "tick", msg: "1 client account(s) to look at", accounts: [ACCOUNT], rhea_btc: 76_000, ...fields });

test("the keeper is ready when its log shows a fresh tick, for real, listing the account, with our Rhea copy's price", () => {
  const start: LogEvent = { t: new Date(T0 - 60_000).toISOString(), event: "start", msg: "the keeper is starting" };
  assert.deepEqual(keeperReady([start, tick(T0 - 10_000)], ACCOUNT, T0), { ok: true, why: `the keeper ticked 10 s ago, watches ${ACCOUNT}, and reads our Rhea copy's BTC price at $76,000`, last_tick_at: new Date(T0 - 10_000).toISOString(), rhea_btc: 76_000 });
  assert.match(keeperReady([], ACCOUNT, T0).why, /has no tick yet/);
  // A tick is held while a check waits its turn at OutLayer, so the keeper counts as running for 4 minutes after one.
  assert.equal(keeperReady([start, tick(T0 - 90_000)], ACCOUNT, T0).ok, true);
  assert.match(keeperReady([tick(T0 - 300_000)], ACCOUNT, T0).why, /last tick was 300 s ago/);
  assert.match(keeperReady([{ ...start, msg: "the keeper is starting in a dry run: it sends nothing" }, tick(T0)], ACCOUNT, T0).why, /runs as a dry run/);
  assert.match(keeperReady([tick(T0, { accounts: ["other.pbf.testnet"] })], ACCOUNT, T0).why, /doesn't list demo\.pbf\.testnet yet/);
  assert.match(keeperReady([tick(T0, { rhea_btc: null })], ACCOUNT, T0).why, /isn't keeping our Rhea copy's BTC price: set RHEA_ACCOUNT_ID and OPERATOR_PRIVATE_KEY/);
  // Unlike the depeg drill's test, no loan is needed: the keeper must be there before the loan starts.
  const lines: LogEvent[] = [
    { t: new Date(T0).toISOString(), event: "step", account: ACCOUNT, pid: "f1", i: 0 },
    { t: new Date(T0).toISOString(), event: "step", account: "other.pbf.testnet" },
    { t: new Date(T0 - 120_000).toISOString(), event: "check", account: ACCOUNT },
    { t: new Date(T0).toISOString(), event: "verdict", account: ACCOUNT },
  ];
  assert.deepEqual(keeperLines(lines, ACCOUNT, new Date(T0 - 60_000).toISOString(), ["step", "check"]), [lines[0]]);
});

const WORDS = { account: ACCOUNT, owner: "pbf-keeper.testnet", operator: "pbf-ops.testnet", lender: "rhea" as const, rheaId: "rhea.pbf-ops.testnet", pool: "pool.pbf.testnet", apiUrl: "http://localhost:8788", plan: planFor("small", 76_000), recordFile: "research/data/phase6_funding_rhea.json", holdFile: "logs/rhea-price-hold.json", aimBp: 13_000, settleWaitMin: 70, settleEverySec: 120 };

test("the dry run's plan names every step, what each sends and what each checks", () => {
  const lines = describeGate(WORDS);
  const text = lines.join("\n");
  for (const id of FUNDING_STEP_IDS) assert.ok(new RegExp(`\\b${id}\\b`).test(text), `the plan names ${id}`);
  assert.match(lines[0]!, /^account demo\.pbf\.testnet, owned by pbf-keeper\.testnet; operator pbf-ops\.testnet; lender rhea \(rhea\.pbf-ops\.testnet\)/);
  assert.match(lines[1]!, /^the book: 0\.015 test nBTC \(about \$1,140 at BTC \$76,000\), \$440 of test USDC, \$430 of it on Hyperliquid, a 0\.015 BTC short$/);
  assert.ok(text.includes('create_account with 6 NEAR and the permission {"lenders":["rhea"],"min_hf_bp":15000,"max_rate_bp":2500,"moves":"any"}, in one signature'));
  assert.ok(text.includes('set_pricing({"account"}, {"lender":{"margin_bp":500,"cap_bp":null}})'));
  assert.ok(text.includes('set_pricing({"account"}, {"lender":{"margin_bp":0,"cap_bp":0}})'));
  assert.ok(text.includes("again every 120 s while the pool answers \"skipped\" (up to 70 min)"));
  assert.ok(text.includes("to take Rhea's cushion to 1.30"));
  assert.ok(text.includes('the operator\'s set_funding({"order":"lender_first"}), unless it is that already'));
  assert.ok(text.includes("sets a hold in the keeper's file (logs/rhea-price-hold.json)"));
  assert.ok(text.includes('lender_repay("rhea", the debt and a hair more) with 1 yoctoNEAR'));
  // 18 before INTERFACES.md 50.2: the last line (close_short, home, withdraw) is now two, and the three new steps have one each.
  assert.equal(lines.filter((l) => /Checks: /.test(l)).length, 22, "the opening and every step after the hedge say what they check");
});

/** The pool's pricing limits on testnet after the change of 12 Nov (INTERFACES.md 45.1): the defaults, with 2 minutes between two settlements. */
const LIMITS_45: PricingLimitsView = {
  max_rate_bp: 6_000,
  avg_plus_bp: 500,
  max_period_ns: 172_800_000_000_000,
  min_period_ns: 120_000_000_000,
  account_subsidy_day: "100000000",
  pool_subsidy_day_bp: 5,
  max_lender_debt: "1000000000000",
  account_fee_day: "1000000000",
  pool_fee_day_bp: 50,
};

/** Everything in place for a run. */
const READY: Found = {
  account: ACCOUNT,
  accountExists: false,
  resuming: false,
  owner: "pbf-keeper.testnet",
  ownerNear: 8.2,
  operator: "pbf-ops.testnet",
  hasOperatorKey: true,
  rheaId: "rhea.pbf-ops.testnet",
  nbtcId: MNBTC,
  factoryLenders: { rhea: { contract_id: "rhea.pbf-ops.testnet", collateral: [MNBTC] } },
  copyExists: true,
  copyPrice: 76_050,
  oracle: 76_000,
  rheaTerms: { rate_bp: 600, supply_bp: 300, free: "400000000000" },
  poolParams: { operator: "pbf-ops.testnet", funding: { order: "cheapest" }, pricing_limits: LIMITS_45 },
  backend: { preview_enabled: true, gateway_enabled: true },
  keeper: { ok: true, why: "the keeper ticked 5 s ago" },
  floatProblem: null,
  expectDebtMicro: 570_000_000n,
};

test("with everything in place nothing stands in the way, and each thing found is said in a line", () => {
  assert.deepEqual(gateProblems(READY), {
    problems: [],
    lines: [
      "demo.pbf.testnet doesn't exist yet: it will be made",
      "pbf-keeper.testnet holds 8.2000 NEAR",
      "the factory gives new accounts Rhea at rhea.pbf-ops.testnet, with mnbtc.pbf-ops.testnet as collateral",
      "rhea.pbf-ops.testnet counts a bitcoin at $76,050, 0.07% from Hyperliquid's oracle",
      "our Rhea copy lends USDC at 6.00% a year, pays depositors 3.00%, and has $400,000 free",
      'the pool\'s funding order is "cheapest"',
      "the pool's limits on a settlement's fee: a lender's debt counts up to $1,000,000, an account is charged at most $1,000 in 24 hours, and the pool books at most 0.50% of its capital in 24 hours; two settlements are at least 120 s apart",
      "the backend runs previews and the gateway",
      "the keeper ticked 5 s ago",
    ],
  });
});

test("what stands in the way today, before anything of stage 2 is deployed, each with what to do about it", () => {
  const today: Found = { ...READY, ownerNear: 2.95, factoryLenders: undefined, copyExists: false, copyPrice: null, rheaTerms: null, poolParams: { operator: "pbf-ops.testnet" }, backend: null, keeper: { ok: false, why: "the keeper's last tick was 182543 s ago: is it running?" } };
  assert.deepEqual(gateProblems(today).problems, [
    "pbf-keeper.testnet holds 2.95 NEAR: a new account takes 6, and the run's checks and gas about 0.6 more. Top it up from the testnet faucet",
    "the factory's config has no lenders.rhea, so it makes accounts that can't use Rhea: it needs the Phase 6 code and its migrate() with the Rhea settings",
    "rhea.pbf-ops.testnet doesn't exist: our copy of Rhea must be deployed, with test USDC and test nBTC listed, a fixed price for each, and USDC supplied to lend",
    "the pool has no pricing yet (its get_params has no funding or pricing_limits): it needs the Phase 6 code and its migrate()",
    "the backend doesn't answer: pnpm --filter @pb/api start",
    "the keeper's last tick was 182543 s ago: is it running?",
  ]);
});

test("each single thing out of place is caught: a used account, a stale price, a copy that lends too cheaply or has too little, another operator, no key", () => {
  const one = (change: Partial<Found>) => gateProblems({ ...READY, ...change }).problems;
  assert.match(one({ accountExists: true })[0]!, /exists already: the gate starts from a fresh account, so give a new --name/);
  assert.deepEqual(one({ accountExists: true, resuming: true, ownerNear: 1 }), [], "a resumed run needs no new account");
  assert.match(one({ copyPrice: 76_300 })[0]!, /counts a bitcoin at \$76,300, 0\.39% from Hyperliquid's oracle at \$76,000: the keeper isn't keeping it in step/);
  assert.equal(one({ copyPrice: "our Rhea copy has no fixed price for test nBTC (its default_price is empty), so there is nothing for the keeper to keep in step" })[0], "our Rhea copy has no fixed price for test nBTC (its default_price is empty), so there is nothing for the keeper to keep in step");
  assert.match(one({ rheaTerms: { rate_bp: 2, supply_bp: 1, free: "400000000000" } })[0]!, /borrow rate \(0\.02%\) is too close to its deposit rate \(0\.01%\): on about \$570, a subsidy over 120 s comes to less than a millionth of a dollar/);
  assert.match(one({ rheaTerms: { rate_bp: 600, supply_bp: 300, free: "900000000" } })[0]!, /has \$900 of USDC free, and the account will ask it for about \$570: supply more test USDC to it/);
  assert.match(one({ rheaTerms: null })[0]!, /GET \/api\/lenders has no testnet Rhea row: set RHEA_ACCOUNT_ID/);
  assert.match(one({ factoryLenders: { rhea: { contract_id: "other.testnet", collateral: [MNBTC] } } })[0]!, /names other\.testnet as Rhea, and RHEA_ACCOUNT_ID is rhea\.pbf-ops\.testnet/);
  assert.match(one({ factoryLenders: { rhea: { contract_id: "rhea.pbf-ops.testnet", collateral: [] } } })[0]!, /don't list mnbtc\.pbf-ops\.testnet as collateral/);
  assert.match(one({ poolParams: { operator: "someone.testnet", funding: { order: "cheapest" }, pricing_limits: {} } })[0]!, /the pool's operator is someone\.testnet, not pbf-ops\.testnet/);
  assert.match(one({ hasOperatorKey: false })[0]!, /OPERATOR_PRIVATE_KEY is empty in \.env: the operator sets the account's price twice/);
  assert.match(one({ backend: { preview_enabled: false, gateway_enabled: false } })[0]!, /OUTLAYER_PAYMENT_KEY is empty/);
  assert.deepEqual(one({ floatProblem: "the float holds too little" }), ["the float holds too little"]);
  // The hedge (INTERFACES.md 42): a mark too far from the oracle for the account's gateway stops the run before an
  // account is made; one inside the band is a line; a run that goes on after the hedge isn't asked.
  assert.deepEqual(one({ hedge: { ok: false, why: "the hedge can't be opened and closed through the gateway now" } }), ["the hedge can't be opened and closed through the gateway now"]);
  assert.match(one({ hedge: null })[0]!, /couldn't work out whether the hedge can go through the gateway now/);
  assert.equal(gateProblems({ ...READY, hedge: { ok: true, why: "the hedge opens with sells at $74,197 and closes with buys at $74,644" } }).lines.at(-1), "the hedge opens with sells at $74,197 and closes with buys at $74,644");
  assert.deepEqual(one({}), [], "no hedge to open: nothing said");
  assert.equal(one({ accountExists: null, ownerNear: null, factoryLenders: null, copyExists: null, poolParams: null }).length, 5, "a read that failed is said, not passed over");
});

// ---------- INTERFACES.md 45.3, item 11: the pool's limits on a settlement's fee ----------

test("INTERFACES.md 45.3, item 11: the dry run says the pool's limits on a fee, and what in them would stop the fee step", () => {
  const debt = 545_000_000n;
  assert.deepEqual(feeLimits(LIMITS_45, debt), {
    line: "the pool's limits on a settlement's fee: a lender's debt counts up to $1,000,000, an account is charged at most $1,000 in 24 hours, and the pool books at most 0.50% of its capital in 24 hours; two settlements are at least 120 s apart",
    problems: [],
  });
  // A pool from before the change has none of the three: said, and nothing in the way.
  const { max_lender_debt: _m, account_fee_day: _a, pool_fee_day_bp: _p, ...before } = LIMITS_45;
  assert.deepEqual(feeLimits(before, debt), { line: "the pool has no limits on a settlement's fee: it is from before the pool's change of 12 Nov (INTERFACES.md 45)", problems: [] });
  // A lender's debt counted at less than the account will owe: the fee would be worked out on less.
  assert.deepEqual(feeLimits({ ...LIMITS_45, max_lender_debt: "100000000" }, debt).problems, ["the pool counts a lender's debt only up to $100 (max_lender_debt), and this account will owe Rhea about $545: the fee would be worked out on less"]);
  // A 24-hour fee budget of nothing: every fee would be cut to nothing.
  assert.match(feeLimits({ ...LIMITS_45, account_fee_day: "0" }, debt).problems[0]!, /^the pool's 24-hour fee budget is nothing \(account_fee_day is 0\)/);
  assert.match(feeLimits({ ...LIMITS_45, pool_fee_day_bp: 0 }, debt).problems[0]!, /^the pool's 24-hour fee budget is nothing \(pool_fee_day_bp is 0\)/);
  // Only some of the three: not the shape the pool writes.
  assert.equal(feeLimits({ ...before, max_lender_debt: "1000000000000" }, debt).problems.length, 1);
  // In the gate's list of what it found, the line stands with the others, and a problem stops the run.
  assert.match(gateProblems({ ...READY, poolParams: { ...READY.poolParams!, pricing_limits: { ...LIMITS_45, account_fee_day: "0" } } }).problems[0]!, /24-hour fee budget is nothing/);
});

test("INTERFACES.md 45.3, item 11: a settlement step passes on a sum the pool booked whole, fails when the pool's 24-hour limits cut it, and goes by the pool's record alone when another settlement booked it", () => {
  const own = (fee: string, subsidy: string, cut: string) => ({ fee, subsidy, cut, credit: "0", period_ns: "233028571815" });
  // Gate 2's own figures: a 5-point margin on $544.62 for 233 s is $0.000202, with nothing cut.
  assert.deepEqual(settleCheck("fee", 202n, own("202", "0", "0")), { ok: true, cut: "0" });
  assert.deepEqual(settleCheck("subsidy", 176n, own("0", "176", "0")), { ok: true, cut: "0" });
  // Cut by the limits: the step fails, and says which limits to look at.
  assert.deepEqual(settleCheck("fee", 150n, own("150", "0", "52")), {
    ok: false,
    cut: "52",
    why: "the pool's 24-hour limits cut 0.000052 USDC from this fee, which is far too small to reach them: look at account_fee_day or pool_fee_day_bp in the pool's pricing limits",
  });
  assert.match(settleCheck("subsidy", 100n, own("0", "100", "76")).why!, /look at account_subsidy_day or pool_subsidy_day_bp/);
  // Booked by another settlement (the keeper's hourly one): its cut can't be read from this try.
  assert.deepEqual(settleCheck("fee", 202n, null), { ok: true, cut: null });
  // Nothing booked yet: not a pass, whatever the try's own answer was.
  assert.deepEqual(settleCheck("fee", 0n, null), { ok: false, cut: null });
  assert.equal(settleCheck("fee", 0n, own("0", "0", "202")).ok, false);
});

test("51.1, Rhea's record read for test ETH: its 18 decimals are Rhea's own inside, so the units come back one for one; bitcoin's 8 are still divided by 10^10", () => {
  const METH = "meth.pbf-ops.testnet";
  const account = { supplied: [], collateral: [{ token_id: METH, balance: "528400000000000000" }, { token_id: MNBTC, balance: "15000000000000000" }], borrowed: [{ token_id: MUSDC, balance: "430000000000000000000" }] };
  assert.deepEqual(rheaPosition(account, MUSDC, METH, 18), { registered: true, debtMicro: 430_000_000n, collateralUnits: 528_400_000_000_000_000n, suppliedMicro: 0n });
  assert.deepEqual(rheaPosition(account, MUSDC, MNBTC), { registered: true, debtMicro: 430_000_000n, collateralUnits: 1_500_000n, suppliedMicro: 0n });
});

test("51.1, the keeper is ready for an ETH gate only when its tick shows our Rhea copy's ETH price; for bitcoin the test is the one of before", () => {
  const tick = (more: Record<string, unknown>): LogEvent[] => [{ t: new Date(T0 - 5_000).toISOString(), event: "tick", accounts: [ACCOUNT], rhea_btc: 67_469, ...more }];
  assert.equal(keeperReady(tick({}), ACCOUNT, T0).ok, true);
  const noEth = keeperReady(tick({}), ACCOUNT, T0, "ETH");
  assert.deepEqual([noEth.ok, /isn't keeping our Rhea copy's ETH price/.test(noEth.why)], [false, true]);
  const eth = keeperReady(tick({ rhea_eth: 1_913.11 }), ACCOUNT, T0, "ETH");
  assert.deepEqual([eth.ok, eth.rhea_btc, /reads our Rhea copy's ETH price at \$1,913\.11$/.test(eth.why)], [true, 1_913.11, true]);
});

test("51.1, the ETH gate's dry run says the coin in every line: no line of its plan or of what it found says BTC, bitcoin or nBTC; the bitcoin gate's lines are the ones of before", () => {
  const eth = planForCoin("small", 67_400, { coin: "ETH", szDecimals: 4, token: "meth.pbf-ops.testnet", tokenDecimals: 18 }, 1_908.3);
  const lines = describeGate({ ...WORDS, plan: eth });
  assert.deepEqual(lines.filter((l) => /BTC|bitcoin/i.test(l)), [], "the ETH plan's lines");
  assert.equal(lines[1], "the book: 0.5297 test ETH (about $1,011 at ETH $1,908.3), $440 of test USDC, $430 of it on Hyperliquid, a 0.5297 ETH short");
  assert.ok(lines.some((l) => l.includes("our Rhea copy's ETH price; that price is within 0.25% of Hyperliquid's oracle")));
  assert.ok(lines.some((l) => l.includes("Rhea's get_account shows ETH posted and USDC owed")));
  assert.ok(lines.some((l) => l.includes("keep our Rhea copy's ETH price far enough under the oracle")));
  assert.ok(lines.some((l) => l.includes("the copy's ETH price is back within 0.25% of the oracle")));
  assert.ok(lines.some((l) => l.includes('lender_withdraw("rhea", test ETH, all of it)')));

  // What the script found, for an ETH run: the copy's price and the oracle are ether's, and are said so.
  const found = gateProblems({ ...READY, coin: "ETH", nbtcId: "meth.pbf-ops.testnet", factoryLenders: { rhea: { contract_id: "rhea.pbf-ops.testnet", collateral: [MNBTC, "meth.pbf-ops.testnet"] } }, copyPrice: 1_908.3, oracle: 1_907.2 });
  assert.deepEqual(found.problems, []);
  assert.ok(found.lines.includes("rhea.pbf-ops.testnet counts an ether at $1,908.3, 0.06% from Hyperliquid's oracle"));
  assert.deepEqual(found.lines.filter((l) => /BTC|bitcoin/i.test(l)), []);
  assert.match(hedgeNow({ mark: 1_885.2, oracle: 1_907.24, bestBid: Number.NaN, bestAsk: Number.NaN, bandBp: 300, venueBp: 240 }, 4, "ETH").why, /^Hyperliquid's ETH mark \(\$1,885\.2\) is 1\.16% under its oracle price/);

  // Bitcoin: the same lines as before, word for word.
  const btc = describeGate(WORDS);
  assert.ok(btc.some((l) => l.includes("our Rhea copy's BTC price; that price is within 0.25% of Hyperliquid's oracle")));
  assert.ok(btc.some((l) => l.includes("Rhea's get_account shows nBTC posted and USDC owed")));
  assert.ok(gateProblems(READY).lines.some((l) => /counts a bitcoin at \$/.test(l)));
  assert.match(hedgeNow({ mark: 66_144, oracle: 67_254, bestBid: Number.NaN, bestAsk: Number.NaN, bandBp: 300, venueBp: 240 }).why, /^Hyperliquid's BTC mark/);
});


test("a plan that ran out with only the pool's step left is the one case the Aave gate goes on from; any other unfinished plan is not", () => {
  const at = 1_794_654_991_367;
  const plan = (steps: [string, boolean][], pid = "f277646381") => ({ pid, expiresAtMs: at, steps: steps.map(([k, done]) => ({ k, done })) });
  const live = plan([["l_supply", true], ["l_borrow", true], ["p_borrow", false]]);
  // The plan of 14 Nov: Aave's two steps done, the pool's not, and the 30 minutes over.
  assert.equal(poolPartLapsed(live, "f277646381", at + 1), true);
  // Still inside its 30 minutes: the keeper may yet run it.
  assert.equal(poolPartLapsed(live, "f277646381", at), false);
  assert.equal(poolPartLapsed(live, "f277646381", at - 60_000), false);
  // Another plan than the one the gate signed, or no plan, or no record of which.
  assert.equal(poolPartLapsed(live, "f1", at + 1), false);
  assert.equal(poolPartLapsed(null, "f277646381", at + 1), false);
  assert.equal(poolPartLapsed(live, undefined, at + 1), false);
  // The lender's own loan not made: that is the gate's failure, however late it is.
  assert.equal(poolPartLapsed(plan([["l_supply", true], ["l_borrow", false], ["p_borrow", false]]), "f277646381", at + 1), false);
  assert.equal(poolPartLapsed(plan([["l_supply", false], ["l_borrow", false]]), "f277646381", at + 1), false);
  // Every step done isn't this case either: the plan simply finished.
  assert.equal(poolPartLapsed(plan([["l_supply", true], ["l_borrow", true], ["p_borrow", true]]), "f277646381", at + 1), false);
  // A plan with no expiry read can't be said to have run out.
  assert.equal(poolPartLapsed({ ...live, expiresAtMs: null }, "f277646381", at + 1), false);
});
