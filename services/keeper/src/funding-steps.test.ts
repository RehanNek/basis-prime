// The Phase 6 gate's steps against a fake world: a scripted account, our Rhea copy, the pool's pricing record and
// funding order, the backend's preview, Hyperliquid's oracle, the keeper's log and its price hold. Between two polls
// the fake "keeper" may act (`between`), so the watching steps can be played through. These check the step logic and
// its bookkeeping: what is sent, by whom, with which deposit, and what each step takes as proof. Nothing here reaches
// a chain.
import assert from "node:assert/strict";
import { test } from "node:test";

import { FEE_POLICY, FUNDING_STEP_IDS, NBTC_INNER, SUBSIDY_POLICY, USDC_INNER, demoPermission, type PricingView } from "./funding-kit.js";
import { FUNDING_STEPS, restoreOrder, stepCredit, stepFund, stepFunded, stepKeeperUp, stepOrder, stepOrderBack, stepPolicy, stepPriceBack, stepPriceDrop, stepRepayRhea, stepRheaWithdraw, stepSettle, stepTopUp, type FundingGate } from "./funding-steps.js";
import { planFor, StepFailed, StepRunner, type RunRecord } from "./hedge-kit.js";
import { CREATE_DEPOSIT, requestCheck, stepCreate, STEPS, type TxResult, type World } from "./hedge-steps.js";
import type { LogEvent } from "./jsonl.js";
import type { NearCall } from "./near-tx.js";
import type { RheaHold, TokenPriceInfo } from "./rhea-price.js";
import type { AccountState, VerdictJson } from "./state.js";

const ACCOUNT = "demo.pbf.testnet";
const KEEPER = "pbf-keeper.testnet";
const OPERATOR = "pbf-ops.testnet";
const POOL = "pool.pbf.testnet";
const RHEA = "rhea.pbf-ops.testnet";
const MUSDC = "musdc.pbf-ops.testnet";
const MNBTC = "mnbtc.pbf-ops.testnet";
const T0 = 1_794_400_000_000;
const USD = 1_000_000n;

const HEALTHY: VerdictJson = { ok: true, state: "HEALTHY", action: "NONE", blk: 5_000, nonce: 8 };
const rheaExt = (hf_bp: number, d = 570_000_000) => ({ l: "rhea", c: 1_130_000_000, d, hf_bp, r_bp: 1_591, s_bp: 1_016, room: 0, liq_bp: 7_600 });
const FUND_STEPS = [
  { k: "l_supply", l: "rhea", tok: MNBTC, amt: "1500000" },
  { k: "l_borrow", l: "rhea", amt: 570_000_000 },
  { k: "p_borrow", amt: 530_000_000 },
];

interface Chain {
  now: number;
  block: number;
  exists: boolean;
  state: AccountState;
  /** Rhea's own record of the account, in inner units; null before it registers. */
  rhea: { collateral: bigint; debt: bigint; supplied: bigint } | null;
  copy: TokenPriceInfo;
  oracle: number;
  pricing: PricingView;
  /** The pool's get_params().funding. */
  poolFunding: { order: string; loan_days: number };
  poolDebt: bigint;
  balances: Record<string, bigint>;
  /** Whether the account is registered on the USDC token, and its NEAR above its storage. */
  registered: boolean;
  freeNear: number;
  /** Handed out one per request_check. */
  verdicts: VerdictJson[];
  /** One per settle(): the pool's answer, and what it does to the pricing record. */
  /** `logs`: the transaction's logs, where the pool's own answer is (INTERFACES.md 45.3, item 11). */
  settles: { answer: unknown; fee?: bigint; subsidy?: bigint; logs?: string[] }[];
  /** The answer to POST /api/funding-plan. */
  preview: unknown;
  keeperLog: LogEvent[];
  holds: (RheaHold | "clear")[];
  /** What the keeper does while the script sleeps. */
  between?: (chain: Chain) => void;
  /** A factory from before Phase 6 drops the permission. */
  oldFactory?: boolean;
}

interface Sent {
  by: string;
  contract: string;
  method: string;
  args: Record<string, unknown>;
  deposit: bigint;
  /** The block it was sent in. */
  block: number;
}

function chain(overrides: Partial<Chain> = {}): Chain {
  return {
    now: T0,
    block: 5_010,
    exists: true,
    state: { owner: KEEPER, counter: 8, loan: { principal: "0", open: false }, verdict: { intent: { check: {} }, received_block: 5_004, verdict: HEALTHY }, plan: null, pending: [], permission: demoPermission("rhea"), permission_blk: 4_990, funding: null },
    rhea: null,
    copy: { decimals: 8, fraction_digits: 2, price_identifier: "e6".repeat(32), extra_call: null, default_price: { multiplier: "7600000", decimals: 10 } },
    oracle: 76_000,
    pricing: { pricing: "pass_through", from: "default", fees_charged: "0", subsidy_paid: "0", credit: "0", settled_at: "0", last: [] },
    poolFunding: { order: "cheapest", loan_days: 90 },
    poolDebt: 0n,
    balances: {},
    registered: true,
    freeNear: 0.61,
    verdicts: [],
    settles: [],
    preview: null,
    keeperLog: [],
    holds: [],
    ...overrides,
  };
}

function fakeGate(c: Chain, options: Partial<FundingGate["options"]> = {}, operatorKey = true) {
  const sent: Sent[] = [];
  const logged: string[] = [];
  const bal = (token: string, holder: string) => c.balances[`${token}:${holder}`] ?? 0n;
  const move = (token: string, from: string | null, to: string | null, amount: bigint) => {
    if (from) {
      if (bal(token, from) < amount) throw new Error(`${from} holds too little ${token}`);
      c.balances[`${token}:${from}`] = bal(token, from) - amount;
    }
    if (to) c.balances[`${token}:${to}`] = bal(token, to) + amount;
  };
  const listed = () => (c.state.pending as { lender?: { until_block: number } }[]).find((p) => p.lender)?.lender ?? null;
  const tx = (label: string, result: unknown = null): TxResult => ({ label, hash: `H${sent.length}`, ok: true, gas_tgas: 5, seconds: 1, logs: [], result });
  const world: World = {
    account: ACCOUNT,
    owner: KEEPER,
    ids: { factory: "pbf.testnet", pool: POOL, musdc: MUSDC, mnbtc: MNBTC, mpc: "v1.signer-prod.testnet", hlFloat: "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d" },
    near: {
      call: async (contract, method, args, o) => {
        sent.push({ by: KEEPER, contract, method, args, deposit: o.deposit, block: c.block });
        const amount = BigInt(String(args.amount ?? "0"));
        switch (method) {
          case "create_account":
            c.exists = true;
            // INTERFACES.md 40.1: `new` records the block when a permission comes with it; 0 if none was ever set.
            c.state = { ...c.state, owner: String(args.owner), permission: c.oldFactory ? null : (args.permission ?? null), permission_blk: !c.oldFactory && args.permission ? c.block : 0 };
            return tx(o.label);
          case "request_check": {
            // The account's rule: a check asked for while a lender action is under way is refused when it lands.
            const under = listed();
            if (under && c.block <= under.until_block) throw new Error("a check was asked for while a lender action was under way");
            c.block += 3;
            const verdict = c.verdicts.shift() ?? { ...HEALTHY, blk: c.block - 2 };
            c.state.verdict = { intent: args.intent, received_block: c.block, verdict };
            return tx(o.label, { accepted: true, reason: null });
          }
          case "fund": {
            const held = c.state.verdict!.verdict;
            // The audit's A8: a check read before the permission last changed backs no fund.
            if (held.blk <= (c.state.permission_blk ?? 0)) return { ...tx(o.label), ok: false, failure: `the check was read before the permission last changed (block ${c.state.permission_blk}): ask for a new check` };
            c.state.funding = { pid: `f${held.blk}`, amount: String(args.amount), stored_at: String(BigInt(c.now) * 1_000_000n), expires_at: String(BigInt(c.now + 30 * 60_000) * 1_000_000n), steps: (held.fund ?? []).map((s) => ({ ...(s as object), done: false })) };
            c.state.counter += 1;
            return tx(o.label);
          }
          case "settle": {
            const s = c.settles.shift() ?? { answer: { skipped: "nothing scripted" } };
            c.pricing = { ...c.pricing, fees_charged: String(BigInt(c.pricing.fees_charged) + (s.fee ?? 0n)), subsidy_paid: String(BigInt(c.pricing.subsidy_paid) + (s.subsidy ?? 0n)), settled_at: s.fee || s.subsidy ? String(BigInt(c.now) * 1_000_000n) : c.pricing.settled_at };
            return { ...tx(o.label, s.answer), ...(s.logs ? { logs: s.logs } : {}) };
          }
          case "lender_repay": {
            move(MUSDC, ACCOUNT, RHEA, amount);
            const inner = amount * USDC_INNER;
            const used = inner < c.rhea!.debt ? inner : c.rhea!.debt;
            c.rhea = { ...c.rhea!, debt: c.rhea!.debt - used, supplied: c.rhea!.supplied + inner - used };
            return tx(o.label);
          }
          case "lender_withdraw": {
            // The account's rule: no withdrawal at Rhea while one is still listed as under way.
            const under = listed();
            if (under && c.block <= under.until_block) throw new Error(`no lender withdrawal until block ${under.until_block} has passed: a withdrawal at rhea is still under way`);
            const token = String(args.token);
            c.rhea = token === MNBTC ? { ...c.rhea!, collateral: c.rhea!.collateral - amount * NBTC_INNER } : { ...c.rhea!, supplied: c.rhea!.supplied - amount * USDC_INNER };
            move(token, null, ACCOUNT, amount);
            c.state.pending = [{ lender: { lender: "rhea", kind: "withdraw", amount: amount.toString(), until_block: c.block + 20, token } }];
            return tx(o.label);
          }
          case "claim_credit":
            move(MUSDC, null, ACCOUNT, BigInt(c.pricing.credit));
            c.pricing = { ...c.pricing, credit: "0" };
            return tx(o.label);
          case "mint":
            move(contract, null, String(args.account_id), amount);
            return tx(o.label);
          case "ft_transfer_call":
            move(contract, KEEPER, String(args.receiver_id), amount);
            return tx(o.label);
          default:
            throw new Error(`unexpected call ${method}`);
        }
      },
      view: async <T>(contract: string, method: string, args: Record<string, unknown> = {}) => {
        if (method === "get_state") return structuredClone(c.state) as T;
        if (method === "get_config") return { gateway: { project_id: "pbf-keeper.testnet/pb-gateway", version_key: "g1", secrets_ref: null }, risk: { version_key: "r1" } } as T;
        if (method === "get_account") return (c.rhea ? { account_id: ACCOUNT, supplied: c.rhea.supplied ? [{ token_id: MUSDC, balance: c.rhea.supplied.toString() }] : [], collateral: c.rhea.collateral ? [{ token_id: MNBTC, balance: c.rhea.collateral.toString() }] : [], borrowed: c.rhea.debt ? [{ token_id: MUSDC, balance: c.rhea.debt.toString() }] : [] } : null) as T;
        if (method === "get_token_pyth_info") return structuredClone(c.copy) as T;
        if (method === "get_pricing") return structuredClone(c.pricing) as T;
        if (method === "get_params") return { operator: OPERATOR, funding: { ...c.poolFunding }, pricing_limits: {} } as T;
        if (method === "debt_of") return c.poolDebt.toString() as T;
        if (method === "ft_balance_of") return bal(contract, String(args.account_id)).toString() as T;
        if (method === "storage_balance_of") return (c.registered ? { total: "1250000000000000000000", available: "0" } : null) as T;
        throw new Error(`unexpected view ${contract}.${method}`);
      },
      exists: async () => c.exists,
      finalBlockMs: async () => c.now,
    },
    api: {
      get: async (path) => {
        throw new Error(`unexpected GET ${path}`);
      },
      post: async (path) => {
        if (path !== "/api/funding-plan") throw new Error(`unexpected POST ${path}`);
        return c.preview ? { status: 200, body: c.preview } : { status: 502, body: { error: "outlayer_run", message: "pb-risk did not complete" } };
      },
    },
    hl: {
      info: async <T>(body: Record<string, unknown>) => {
        if (body.type !== "metaAndAssetCtxs") throw new Error(`unexpected info ${String(body.type)}`);
        return [{ universe: [{ name: "SOL" }, { name: "BTC" }] }, [{ oraclePx: "150" }, { oraclePx: String(c.oracle), markPx: String(c.oracle) }]] as T;
      },
    },
    float: { order: async () => ({ oid: null, text: "" }), cancel: async () => "", close: async () => "" },
    sign: async () => {
      throw new Error("nothing is signed for the gateway in these steps");
    },
    sleep: async (ms) => {
      c.now += ms;
      c.block += Math.round(ms / 1_000);
      c.between?.(c);
    },
    now: () => c.now,
    log: (line) => logged.push(line),
  };
  const operatorCall: NearCall = async (contract, method, args, o) => {
    sent.push({ by: OPERATOR, contract, method, args, deposit: o.deposit, block: c.block });
    if (method === "set_pricing") c.pricing = { ...c.pricing, pricing: args.pricing, from: "account" };
    else if (method === "set_funding") c.poolFunding = { ...(args.funding as Chain["poolFunding"]) };
    else throw new Error(`unexpected operator call ${method}`);
    return { label: o.label, hash: `OP${sent.length}`, ok: true, gas_tgas: 3, seconds: 1, logs: [`EVENT_JSON:{"standard":"pb","version":"1","event":"${method}","data":[{}]}`] };
  };
  const record: RunRecord = { context: {}, steps: [] };
  const gate: FundingGate = {
    runner: new StepRunner(record, () => {}, () => {}, () => c.now),
    plan: planFor("small", 76_000),
    world,
    name: "demo",
    permission: demoPermission("rhea"),
    lender: "rhea",
    rheaId: RHEA,
    operator: { id: OPERATOR, call: operatorKey ? operatorCall : null },
    keeperLog: () => c.keeperLog,
    hold: { set: (h) => c.holds.push(h), clear: () => c.holds.push("clear") },
    freeNear: async () => c.freeNear,
    finalBlock: async () => c.block,
    options: { askMicro: 2_000n * USD, aimBp: 13_000, fundWaitMs: 10 * 60_000, settleWaitMs: 10 * 60_000, settleEveryMs: 120_000, topUpWaitMs: 15 * 60_000, ...options },
  };
  const step = (id: string) => record.steps.find((s) => s.id === id)!;
  const calls = (by = KEEPER) => sent.filter((s) => s.by === by).map((s) => s.method);
  return { gate, sent, logged, record, step, calls };
}

const keeperLine = (c: Chain, event: string, fields: Record<string, unknown>): LogEvent => ({ t: new Date(c.now).toISOString(), event, account: ACCOUNT, ...fields });

test("every step of the gate has its function: the gate's own, and hedge-demo's for the hedge and the way out", () => {
  for (const id of FUNDING_STEP_IDS) assert.ok(id in FUNDING_STEPS || id in STEPS, `no function for ${id}`);
});

test("the opening: create_account with 6 NEAR carries the permission, and the account must then hold it", async () => {
  const c = chain({ exists: false });
  const { gate, sent, step } = fakeGate(c);
  await stepCreate(gate);
  assert.equal(step("create").pass, true, JSON.stringify(step("create").detail));
  assert.deepEqual(sent.map((s) => [s.contract, s.method, s.args, s.deposit]), [["pbf.testnet", "create_account", { name: "demo", owner: KEEPER, permission: { lenders: ["rhea"], min_hf_bp: 15_000, max_rate_bp: 2_500, moves: "any" } }, CREATE_DEPOSIT]]);
  assert.equal(CREATE_DEPOSIT, 6n * 10n ** 24n);
  assert.deepEqual((step("create").detail as { permission: unknown; created: boolean }).permission, demoPermission("rhea"));

  // A factory from before Phase 6 makes the account and drops the permission: the step says so and stops.
  const old = fakeGate(chain({ exists: false, oldFactory: true }));
  await assert.rejects(stepCreate(old.gate), StepFailed);
  assert.match((old.step("create").detail as { why: string }).why, /doesn't hold the permission asked for: the factory didn't pass it on \(is it the Phase 6 factory\?\)/);

  // Without a permission (the earlier gates) the call is as it always was.
  const plain = fakeGate(chain({ exists: false }));
  delete plain.gate.permission;
  await stepCreate(plain.gate);
  assert.deepEqual(plain.sent[0]!.args, { name: "demo", owner: KEEPER });
});

test("the keeper step sends nothing: it reads the keeper's log and the copy's price against the oracle", async () => {
  const c = chain();
  c.keeperLog = [{ t: new Date(T0 - 5_000).toISOString(), event: "tick", accounts: [ACCOUNT], rhea_btc: 76_000 }];
  const ok = fakeGate(c);
  await stepKeeperUp(ok.gate);
  assert.deepEqual([ok.step("keeper").pass, ok.sent.length], [true, 0]);
  assert.deepEqual((({ rhea_btc_usd, oracle_usd, gap_bp }) => [rhea_btc_usd, oracle_usd, gap_bp])(ok.step("keeper").detail as Record<string, number>), [76_000, 76_000, 0]);

  // A price out of the band means the keeper's price sync isn't doing its work.
  const stale = chain({ oracle: 76_400 });
  stale.keeperLog = c.keeperLog;
  const bad = fakeGate(stale);
  await assert.rejects(stepKeeperUp(bad.gate), StepFailed);
  assert.match((bad.step("keeper").detail as { why: string }).why, /0\.52% from Hyperliquid's oracle at \$76400: outside the 0\.25% band/);

  // No keeper at all: the step waits three minutes, then says what its log shows.
  await assert.rejects(stepKeeperUp(fakeGate(chain()).gate), /timed out after 300 s waiting for the keeper to watch the account\. the keeper's log has no tick yet/);
});

test("the pool's order: the operator sets lender_first before the fund and puts back what was there, once; an order that is lender_first already is left alone", async () => {
  const c = chain();
  const { gate, sent, step, record } = fakeGate(c);
  await stepOrder(gate);
  assert.equal(step("order").pass, true, JSON.stringify(step("order").detail));
  assert.deepEqual(sent.map((s) => [s.by, s.contract, s.method, s.args, s.deposit]), [[OPERATOR, POOL, "set_funding", { funding: { order: "lender_first", loan_days: 90 } }, 0n]]);
  assert.deepEqual(record.context.funding_order, { before: { order: "cheapest", loan_days: 90 }, changed: true });
  assert.equal(c.poolFunding.order, "lender_first");

  await stepOrderBack(gate);
  assert.equal(step("order_back").pass, true, JSON.stringify(step("order_back").detail));
  assert.deepEqual(sent[1]!.args, { funding: { order: "cheapest", loan_days: 90 } });
  assert.deepEqual(c.poolFunding, { order: "cheapest", loan_days: 90 });
  // The run's last act calls the same thing: it is back already, so nothing more is sent.
  assert.deepEqual(await restoreOrder(gate, { tx: () => {}, gateway: () => {} }), { restored: false, funding: { order: "cheapest", loan_days: 90 } });
  assert.equal(sent.length, 2);

  // A run that stopped between the two: the last act puts the order back.
  const stopped = fakeGate(chain());
  await stepOrder(stopped.gate);
  assert.equal((await restoreOrder(stopped.gate, { tx: () => {}, gateway: () => {} })).restored, true);
  assert.deepEqual(stopped.sent.map((s) => (s.args.funding as { order: string }).order), ["lender_first", "cheapest"]);

  const already = fakeGate(chain({ poolFunding: { order: "lender_first", loan_days: 90 } }));
  await stepOrder(already.gate);
  await stepOrderBack(already.gate);
  assert.deepEqual([already.step("order").pass, already.step("order_back").pass, already.sent.length], [true, true, 0]);
  await assert.rejects(stepOrder(fakeGate(chain(), {}, false).gate), /OPERATOR_PRIVATE_KEY is empty in \.env: the operator sets the pool's funding order/);
});

const PREVIEW = {
  asked: "2000000000",
  total: 1_100_000_000,
  sources: [{ source: "rhea", amount: 570_000_000, rate_bp: 1_591 }, { source: "pool", amount: 530_000_000, rate_bp: 650 }],
  steps: FUND_STEPS,
  blended_bp: 1_138,
  verdict: { ok: true, state: "HEALTHY" },
  run: { call_id: "pv-1", attestation_url: "https://a/pv-1" },
};

test("the fund step: a preview, a check for 0.5% under what it can lend, then one fund() with 1 yoctoNEAR; the plan is stored under f and the verdict's block", async () => {
  const c = chain({ preview: PREVIEW, verdicts: [{ ...HEALTHY, blk: 5_011, fund: FUND_STEPS, allow: { borrow: 530_000_000, fund: 1_094_390_548 }, ext: [rheaExt(0, 0)] }] });
  // INTERFACES.md 40.1 (the audit's A8): the permission last changed in block 5009, after the check the account
  // still holds (block 5000), and the counter didn't move. `fund` would refuse that check. The step never relies on
  // it: its own check is read at block 5011, after the change.
  c.state.permission_blk = 5_009;
  const { gate, sent, step, record } = fakeGate(c);
  await stepFund(gate);
  assert.equal(step("fund").pass, true, JSON.stringify(step("fund").detail));
  assert.deepEqual(sent.map((s) => [s.method, JSON.stringify(s.args), s.deposit]), [
    ["request_check", JSON.stringify({ intent: { fund: { amount: "1094390548" } } }), 10n ** 22n],
    ["fund", JSON.stringify({ amount: "1094390548" }), 1n],
  ]);
  assert.deepEqual(record.context.funding, { pid: "f5011", amount: "1094390548", from_lender: "570000000", from_pool: "530000000", stored_at_ms: T0, expires_at_ms: T0 + 30 * 60_000 });
  assert.deepEqual(step("fund").gateway.map((g) => [g.label, g.ok, g.call_id]), [["preview (fund)", true, "pv-1"]]);
  assert.deepEqual((step("fund").detail as { funding: { steps: { k: string }[] } }).funding.steps.map((s) => s.k), ["l_supply", "l_borrow", "p_borrow"]);
});

test("the fund step asks for nothing while the account couldn't take Rhea's loan: not registered on the USDC token, or with under 0.15 NEAR free", async () => {
  const unregistered = fakeGate(chain({ preview: PREVIEW, registered: false }));
  await assert.rejects(stepFund(unregistered.gate), StepFailed);
  assert.match((unregistered.step("fund").detail as { why: string }).why, /isn't registered on the USDC token \(musdc\.pbf-ops\.testnet\): Rhea's loan couldn't reach it and would stay at Rhea as a deposit/);
  const poor = fakeGate(chain({ preview: PREVIEW, freeNear: 0.08 }));
  await assert.rejects(stepFund(poor.gate), StepFailed);
  assert.match((poor.step("fund").detail as { why: string }).why, /has 0\.080 NEAR free: registering at Rhea takes 0\.1 of it, and the gate wants 0\.15 there/);
  assert.deepEqual([unregistered.sent.length, poor.sent.length, unregistered.step("fund").gateway.length], [0, 0, 0], "no preview, no check, no fund");
});

test("the fund step signs nothing when the loan wouldn't have both parts: in the preview, or in the check's own answer", async () => {
  const poolOnly = { ...PREVIEW, sources: [PREVIEW.sources[1]], steps: [FUND_STEPS[2]] };
  const a = fakeGate(chain({ preview: poolOnly }));
  await assert.rejects(stepFund(a.gate), StepFailed);
  assert.deepEqual(a.sent, [], "not even a check is paid for");
  assert.match((a.step("fund").detail as { why: string }).why, /^the whole loan would come from our pool and none from Rhea/);

  // The preview was fine, but by the check Rhea had no room left: the check is paid, and fund() is never signed.
  const b = fakeGate(chain({ preview: PREVIEW, verdicts: [{ ...HEALTHY, blk: 5_011, fund: [FUND_STEPS[2]!] }] }));
  await assert.rejects(stepFund(b.gate), StepFailed);
  assert.deepEqual(b.calls(), ["request_check"]);
  assert.match((b.step("fund").detail as { why: string }).why, /isn't a loan from both Rhea and our pool: nothing was signed/);

  await assert.rejects(stepFund(fakeGate(chain()).gate), /the funding preview failed: HTTP 502 pb-risk did not complete/);
});

test("funded: the script only watches while the keeper runs the plan; it passes on Rhea's own record, the pool's debt and a verdict that shows the loan", async () => {
  const c = chain();
  c.state.funding = { pid: "f5011", amount: "1094390548", stored_at: "1", expires_at: "2", steps: FUND_STEPS.map((s) => ({ ...s, done: false })) };
  // The keeper, between the script's polls: a step every 15 s, then its check.
  let ticks = 0;
  c.between = (x) => {
    ticks += 1;
    const steps = (x.state.funding as { steps: { k: string; done: boolean }[] }).steps;
    const next = steps.findIndex((s) => !s.done);
    if (ticks % 3 === 0 && next >= 0) {
      steps[next]!.done = true;
      x.keeperLog.push(keeperLine(x, "step", { pid: "f5011", i: next, k: steps[next]!.k, ok: true, tx: `K${next}` }));
      if (next === 0) x.rhea = { collateral: 1_500_000n * NBTC_INNER, debt: 0n, supplied: 0n };
      if (next === 1) x.rhea = { ...x.rhea!, debt: 570n * USD * USDC_INNER };
      if (next === 2) x.poolDebt = 530n * USD;
    } else if (ticks % 3 === 0 && !x.state.verdict!.verdict.ext) {
      x.keeperLog.push(keeperLine(x, "check", { tx: "KC", why: "the steps of funding plan f5011 have run" }));
      x.state.verdict = { intent: { check: {} }, received_block: x.block, verdict: { ...HEALTHY, blk: x.block - 2, ext: [rheaExt(15_066)] } };
    }
  };
  const { gate, sent, step, record } = fakeGate(c);
  record.context.funding = { pid: "f5011", stored_at_ms: T0 };
  await stepFunded(gate);
  assert.equal(step("funded").pass, true, JSON.stringify(step("funded").detail));
  assert.deepEqual(sent, [], "the script runs no step itself");
  const detail = step("funded").detail as { rhea: unknown; pool_debt_micro: string; ext: { hf_bp: number }; keeper_steps: { k: string; tx: string }[] };
  assert.deepEqual([detail.rhea, detail.pool_debt_micro, detail.ext.hf_bp], [{ debt_micro: "570000000", collateral_units: "1500000" }, "530000000", 15_066]);
  assert.deepEqual(detail.keeper_steps.map((s) => `${s.k}:${s.tx}`), ["l_supply:K0", "l_borrow:K1", "p_borrow:K2"]);
  assert.deepEqual(record.context.loans, { rhea_debt_micro: "570000000", rhea_collateral_units: "1500000", pool_debt_micro: "530000000" });

  // A keeper that stops halfway: the step times out and quotes the keeper's own last words.
  const stuck = chain();
  stuck.state.funding = { pid: "f5011", amount: "1", stored_at: "1", expires_at: "2", steps: FUND_STEPS.map((s, i) => ({ ...s, done: i === 0 })) };
  stuck.keeperLog = [keeperLine(stuck, "note", { msg: "step 1 (l_borrow) of funding plan f5011 can't run: after 4 checks, the last one gives Rhea no room to lend against the collateral posted there: the keeper stops this plan here, and the client can ask again" })];
  const s = fakeGate(stuck, { fundWaitMs: 2 * 60_000 });
  s.record.context.funding = { pid: "f5011", stored_at_ms: T0 };
  await assert.rejects(stepFunded(s.gate), /timed out after 120 s waiting for the keeper to run every step of the funding plan\. The keeper's last lines for the account: note: step 1 \(l_borrow\) of funding plan f5011 can't run/);
});

test("the operator's price: set_pricing for this one account, with no deposit, and the pool's record must then say so", async () => {
  const c = chain();
  const { gate, sent, step } = fakeGate(c);
  await stepPolicy(gate, "fee_policy");
  await stepPolicy(gate, "subsidy_policy");
  assert.deepEqual(sent.map((s) => [s.by, s.contract, s.method, JSON.stringify(s.args), s.deposit]), [
    [OPERATOR, POOL, "set_pricing", JSON.stringify({ target: { account: ACCOUNT }, pricing: FEE_POLICY }), 0n],
    [OPERATOR, POOL, "set_pricing", JSON.stringify({ target: { account: ACCOUNT }, pricing: SUBSIDY_POLICY }), 0n],
  ]);
  assert.deepEqual([step("fee_policy").pass, step("subsidy_policy").pass], [true, true]);
  assert.deepEqual((step("subsidy_policy").detail as { stored: unknown; from: string; events: string[] }), { policy: SUBSIDY_POLICY, stored: SUBSIDY_POLICY, from: "account", events: ["set_pricing"] });
  await assert.rejects(stepPolicy(fakeGate(chain(), {}, false).gate, "fee_policy"), /OPERATOR_PRIVATE_KEY is empty in \.env: the operator sets what the client pays/);
});

test("a settlement: a plain check and settle(), again while the pool says it is too soon, until its record shows the fee", async () => {
  const c = chain({ settles: [{ answer: { skipped: "the last settlement was 40 seconds ago" } }, { answer: { fee: "108", subsidy: "0", credit: "0", period_ns: "160000000000" }, fee: 108n }] });
  const { gate, sent, step, logged } = fakeGate(c);
  await stepSettle(gate, "settle_fee");
  assert.equal(step("settle_fee").pass, true, JSON.stringify(step("settle_fee").detail));
  assert.deepEqual(sent.map((s) => [s.method, JSON.stringify(s.args), s.deposit]), [
    ["request_check", '{"intent":{"check":{}}}', 10n ** 22n],
    ["settle", "{}", 0n],
    ["request_check", '{"intent":{"check":{}}}', 10n ** 22n],
    ["settle", "{}", 0n],
  ]);
  assert.deepEqual(logged.filter((l) => l.includes("try")), ["  try 1: nothing settled: the last settlement was 40 seconds ago", "  try 2: settled: a fee of $0.000108 was added to what the account owes our pool"]);
  const detail = step("settle_fee").detail as { fee: string; tries: { tx: string; said: string }[] };
  assert.deepEqual([detail.fee, detail.tries.length], ["108", 2]);
  assert.equal(c.now, T0 + 120_000, "two minutes between the tries");

  // With a lender action still listed, the step waits its block out before it asks for the check.
  const under = chain({ settles: [{ answer: { fee: "5", subsidy: "0" }, fee: 5n }] });
  under.state.pending = [{ lender: { lender: "rhea", kind: "borrow", amount: "570000000", until_block: 5_030 } }];
  const waited = fakeGate(under);
  await stepSettle(waited.gate, "settle_fee");
  assert.equal(waited.step("settle_fee").pass, true);
  assert.ok(waited.sent[0]!.block > 5_030, "the check goes out after block 5030");
});

test("a settlement counts by the pool's record, whoever called: the keeper's hourly one may book the subsidy first; none in time fails with the pool's last words", async () => {
  // Our settle() is told "too soon" because the keeper's settlement came just before it, and booked the subsidy.
  const c = chain({ settles: [{ answer: { skipped: "the last settlement was 12 seconds ago" }, subsidy: 65n }] });
  const first = fakeGate(c);
  await stepSettle(first.gate, "settle_subsidy");
  assert.equal(first.step("settle_subsidy").pass, true);
  assert.equal((first.step("settle_subsidy").detail as { subsidy: string }).subsidy, "65");

  // A fee where a subsidy was due isn't the proof: the step keeps trying, then gives up after its time.
  const wrong = chain({ settles: [{ answer: { fee: "9", subsidy: "0" }, fee: 9n }, { answer: { skipped: "too soon" } }, { answer: { skipped: "too soon" } }] });
  const second = fakeGate(wrong, { settleWaitMs: 5 * 60_000 });
  await assert.rejects(stepSettle(second.gate, "settle_subsidy"), StepFailed);
  assert.equal((second.step("settle_subsidy").detail as { why: string }).why, "no subsidy was booked in 5 minutes; the pool last said: nothing settled: too soon");
  assert.equal(second.calls().filter((m) => m === "settle").length, 3);
});

test("the price drop: a hold asks the keeper for 13.34% under the oracle, and the step waits until the copy shows it", async () => {
  const c = chain();
  c.state.verdict!.verdict = { ...HEALTHY, ext: [rheaExt(15_000)] };
  // The keeper picks the hold up on its next tick and sets the price.
  c.between = (x) => {
    const hold = x.holds.at(-1);
    if (hold && hold !== "clear" && x.copy.default_price.multiplier === "7600000") {
      x.copy = { ...x.copy, default_price: { multiplier: String(Math.round(x.oracle * (1 + hold.shift_bp / 10_000) * 100)), decimals: 10 } };
      x.keeperLog.push({ t: new Date(x.now).toISOString(), event: "rhea_price", msg: "set our Rhea copy's BTC price to $65,861.60", tx: "KP1" });
    }
  };
  const { gate, sent, step, record } = fakeGate(c);
  await stepPriceDrop(gate);
  assert.equal(step("price_drop").pass, true, JSON.stringify(step("price_drop").detail));
  assert.deepEqual(sent, [], "the script sets no price itself");
  assert.deepEqual(c.holds, [{ shift_bp: -1_334, until_ms: T0 + 25 * 60_000, by: "funding:demo for demo.pbf.testnet" }]);
  const d = step("price_drop").detail as Record<string, unknown>;
  assert.deepEqual([d.cushion_before_bp, d.shift_bp, d.price_before_usd, d.price_after_usd, d.keeper_tx], [15_000, -1_334, 76_000, 65_861.6, "KP1"]);
  assert.deepEqual(record.context.hold, { shift_bp: -1_334, started_ms: T0, until_ms: T0 + 25 * 60_000, cushion_before_bp: 15_000 });

  // No Rhea loan in the held verdict: nothing to shake, and no hold is set.
  const none = fakeGate(chain());
  await assert.rejects(stepPriceDrop(none.gate), /the held verdict shows no Rhea loan to shake/);
  // A keeper that never moves the price: the step fails after two minutes (the run then clears the hold).
  const idle = chain();
  idle.state.verdict!.verdict = { ...HEALTHY, ext: [rheaExt(15_000)] };
  await assert.rejects(stepPriceDrop(fakeGate(idle).gate), /timed out after 300 s waiting for the keeper to set our Rhea copy's BTC price to the hold's level/);
});

/** The keeper's side of a top-up, played between the script's polls: check, plan, step, check. */
function topUpScript(restores: boolean) {
  let ticks = 0;
  return (x: Chain) => {
    ticks += 1;
    if (ticks === 2) {
      x.keeperLog.push(keeperLine(x, "check", { tx: "KC1", why: "Rhea's cushion was 1.50 at the last check, and bitcoin's price at Rhea has gone from $76,000 to $65,861.60 since" }));
      const plan = [{ k: "l_repay", l: "rhea", amt: 75_810_000 }];
      x.state.verdict = { intent: { check: {} }, received_block: x.block, verdict: { ok: true, state: "HEALTHY", action: "REBALANCE", blk: 6_000, nonce: 9, ext: [rheaExt(12_999)], plan, top: ["rhea: cushion 1.30 is under 1.35"] } };
      x.state.plan = { pid: "6000", action: "REBALANCE", stored_at: "1", steps: plan.map((s) => ({ ...s, done: false })) };
    }
    if (ticks === 4) {
      (x.state.plan as { steps: { done: boolean }[] }).steps[0]!.done = true;
      x.rhea = { ...x.rhea!, debt: x.rhea!.debt - 75_810_000n * USDC_INNER };
      x.keeperLog.push(keeperLine(x, "step", { pid: "6000", i: 0, k: "l_repay", ok: true, tx: "KS1" }));
    }
    if (ticks === 6 && restores) {
      x.state.verdict = { intent: { check: {} }, received_block: x.block, verdict: { ...HEALTHY, blk: 6_040, nonce: 10, ext: [rheaExt(14_990, 494_190_000)] } };
      x.state.plan = null;
    }
  };
}

function dropped(restores: boolean): Chain {
  const c = chain({ rhea: { collateral: 1_500_000n * NBTC_INNER, debt: 570n * USD * USDC_INNER, supplied: 0n }, between: topUpScript(restores) });
  c.copy = { ...c.copy, default_price: { multiplier: "6586160", decimals: 10 } };
  c.state.verdict!.verdict = { ...HEALTHY, ext: [rheaExt(15_000)] };
  return c;
}

test("the top-up: the script only watches. It passes on a thin verdict with a top-up plan, the keeper's own step, less debt at Rhea, and the cushion back", async () => {
  const { gate, sent, step, record, logged } = fakeGate(dropped(true));
  record.context.hold = { shift_bp: -1_334, started_ms: T0 };
  await stepTopUp(gate);
  assert.equal(step("top_up").pass, true, JSON.stringify(step("top_up").detail));
  assert.deepEqual(sent, [], "the script runs no step and asks for no check");
  const d = step("top_up").detail as { checks: Record<string, boolean>; thin: { cushion_bp: number; action: string; steps: unknown[] }; restored: { cushion_bp: number }; keeper_steps: { k: string; tx: string }[]; rhea_before: { debt_micro: string }; rhea_after: { debt_micro: string }; step_seen_done: unknown };
  assert.deepEqual(d.checks, { thin_verdict_with_plan: true, keeper_ran_the_step: true, rhea_position_better: true, cushion_back: true, price_still_down: true });
  assert.deepEqual([d.thin.cushion_bp, d.thin.action, d.restored.cushion_bp], [12_999, "REBALANCE", 14_990]);
  assert.deepEqual(d.keeper_steps.map((s) => [s.k, s.tx]), [["l_repay", "KS1"]]);
  assert.deepEqual([d.rhea_before.debt_micro, d.rhea_after.debt_micro, d.step_seen_done], ["570000000", "494190000", { pid: "6000", i: 0, k: "l_repay" }]);
  assert.ok(logged.includes("  a verdict: HEALTHY, action REBALANCE; Rhea's cushion 1.30"));
});

test("a top-up that doesn't bring the cushion back fails the step, and the run goes on to put the price back and close out", async () => {
  const { gate, step, record } = fakeGate(dropped(false), { topUpWaitMs: 3 * 60_000 });
  record.context.hold = { shift_bp: -1_334, started_ms: T0 };
  await stepTopUp(gate); // observed: it doesn't throw
  assert.equal(step("top_up").pass, false);
  assert.deepEqual((step("top_up").detail as { checks: Record<string, boolean> }).checks, { thin_verdict_with_plan: true, keeper_ran_the_step: true, rhea_position_better: true, cushion_back: false, price_still_down: true });
  await assert.rejects(stepTopUp(fakeGate(chain()).gate), /the record has no price drop/);
});

test("the price comes back: the hold is cleared, and the step waits until the copy is within 0.25% of the oracle again", async () => {
  const c = chain();
  c.copy = { ...c.copy, default_price: { multiplier: "6586160", decimals: 10 } };
  c.between = (x) => {
    if (x.holds.at(-1) === "clear") x.copy = { ...x.copy, default_price: { multiplier: "7601000", decimals: 10 } };
  };
  const { gate, step, sent } = fakeGate(c);
  await stepPriceBack(gate);
  assert.deepEqual([step("price_back").pass, c.holds, sent.length], [true, ["clear"], 0]);
  assert.deepEqual(step("price_back").detail, { price_usd: 76_010, oracle_usd: 76_000, gap_bp: 1.3 });
});

test("the way out at Rhea: lender_repay with 1 yoctoNEAR for the debt and a hair more, with what the account lacks put in first; nothing owed after, and the cents left there are said", async () => {
  const debt = 494_250_000n; // with a few hours' interest
  const c = chain({ rhea: { collateral: 1_500_000n * NBTC_INNER, debt: debt * USDC_INNER, supplied: 0n }, balances: { [`${MUSDC}:${ACCOUNT}`]: 400n * USD, [`${MUSDC}:${KEEPER}`]: 50n * USD } });
  const { gate, sent, step } = fakeGate(c);
  await stepRepayRhea(gate);
  assert.equal(step("repay_rhea").pass, true, JSON.stringify(step("repay_rhea").detail));
  const want = debt + debt / 50_000n + 100n;
  const missing = want - 400n * USD;
  assert.deepEqual(sent.map((s) => [s.method, String(s.args.amount), s.deposit]), [
    ["mint", (missing - 50n * USD).toString(), 1_250_000_000_000_000_000_000n],
    ["ft_transfer_call", missing.toString(), 1n],
    ["lender_repay", want.toString(), 1n],
  ]);
  assert.deepEqual(sent[2]!.args, { lender: "rhea", amount: want.toString() });
  assert.deepEqual(step("repay_rhea").detail, { debt_before_micro: debt.toString(), sent_micro: want.toString(), put_in: missing.toString(), minted: (missing - 50n * USD).toString(), left_at_rhea_micro: (want - debt).toString() });
  assert.equal(c.rhea!.debt, 0n);

  // Nothing owed (a resumed run): nothing is sent.
  const again = fakeGate(c);
  await stepRepayRhea(again.gate);
  assert.deepEqual([again.step("repay_rhea").pass, again.sent.length], [true, 0]);
});

test("the credit is claimed only when the pool holds one", async () => {
  const none = fakeGate(chain());
  await stepCredit(none.gate);
  assert.deepEqual([none.step("credit").pass, none.sent.length], [true, 0]);
  const c = chain();
  c.pricing = { ...c.pricing, credit: "2500", subsidy_paid: "2500" };
  const some = fakeGate(c);
  await stepCredit(some.gate);
  assert.deepEqual(some.sent.map((s) => [s.contract, s.method, s.deposit]), [[ACCOUNT, "claim_credit", 0n]]);
  assert.deepEqual([some.step("credit").pass, (some.step("credit").detail as { claimed_micro: string }).claimed_micro, c.balances[`${MUSDC}:${ACCOUNT}`]], [true, "2500", 2_500n]);
});

test("everything comes back from Rhea: the nBTC, then, once that withdrawal's 20 blocks have passed, the USDC the repayment left there; each a lender_withdraw with 1 yoctoNEAR", async () => {
  const position = { collateral: 1_500_000n * NBTC_INNER + 4_999n, debt: 0n, supplied: 9_985n * USDC_INNER + 7n };
  const c = chain({ rhea: { ...position } });
  const { gate, sent, step } = fakeGate(c);
  await stepRheaWithdraw(gate);
  assert.equal(step("rhea_withdraw").pass, true, JSON.stringify(step("rhea_withdraw").detail));
  assert.deepEqual(sent.map((s) => [s.contract, s.method, s.args, s.deposit]), [
    [ACCOUNT, "lender_withdraw", { lender: "rhea", token: MNBTC, amount: "1500000" }, 1n],
    [ACCOUNT, "lender_withdraw", { lender: "rhea", token: MUSDC, amount: "9985" }, 1n],
  ]);
  assert.ok(sent[1]!.block > sent[0]!.block + 20, "the account lists the first withdrawal for 20 blocks, and refuses another until they have passed");
  assert.deepEqual(step("rhea_withdraw").detail, { nbtc_withdrawn_units: "1500000", account_holds_nbtc_units: "1500000", usdc_withdrawn_micro: "9985", left_at_rhea_micro: "0", waited_for_blocks: [sent[0]!.block + 20] });
  assert.deepEqual([c.balances[`${MNBTC}:${ACCOUNT}`], c.balances[`${MUSDC}:${ACCOUNT}`]], [1_500_000n, 9_985n]);

  // Only with Rhea and our pool both repaid: then neither withdrawal needs a check.
  const owing = fakeGate(chain({ rhea: { ...position, debt: 5n * USD * USDC_INNER } }));
  await assert.rejects(stepRheaWithdraw(owing.gate), /Rhea is still owed \$5\.00: the repay_rhea step comes first/);
  const poolOwed = fakeGate(chain({ rhea: { ...position }, poolDebt: 530n * USD }));
  await assert.rejects(stepRheaWithdraw(poolOwed.gate), /our pool is still owed \$530\.00: the repay step comes first, so this withdrawal needs no check/);
  assert.deepEqual([owing.sent.length, poolOwed.sent.length], [0, 0]);
  // Nothing there (a resumed run), or only the deposit left.
  const empty = fakeGate(chain({ rhea: { collateral: 0n, debt: 0n, supplied: 0n } }));
  await stepRheaWithdraw(empty.gate);
  assert.deepEqual([empty.step("rhea_withdraw").pass, empty.sent.length], [true, 0]);
  const cents = fakeGate(chain({ rhea: { collateral: 0n, debt: 0n, supplied: 9_985n * USDC_INNER } }));
  await stepRheaWithdraw(cents.gate);
  assert.deepEqual(cents.sent.map((s) => s.args.token), [MUSDC]);
});

test("a check that waits its turn at OutLayer: no outcome from the RPC is not a failure, the script waits 4 minutes for the verdict, and a failure the chain reported stops the step", async () => {
  let now = T0;
  let landsAt = Number.POSITIVE_INFINITY;
  const recorded: (string | null)[] = [];
  const step = { tx: (t: { hash: string | null }) => recorded.push(t.hash), gateway: () => {} };
  const world = (tx: TxResult) =>
    ({
      account: ACCOUNT,
      near: {
        call: async () => tx,
        view: async () => (now >= landsAt ? { verdict: { received_block: 5_100, verdict: { ok: true, state: "HEALTHY", blk: 5_095 } } } : { verdict: { received_block: 5_004, verdict: { ok: true, state: "HEALTHY", blk: 5_000 } } }),
      },
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    }) as unknown as World;
  // The RPC stopped waiting before the transaction ended: no hash, no outcome.
  const unseen: TxResult = { label: "request_check (test)", hash: null, ok: false, gas_tgas: 0, failure: "the RPC stopped waiting", seconds: 60, logs: [] };

  // The verdict lands 200 s later: that is the check's answer.
  landsAt = T0 + 200_000;
  const v = await requestCheck(world(unseen), step, { check: {} }, "request_check (test)");
  assert.equal(v.blk, 5_095);
  assert.deepEqual(recorded, [null], "the transaction is on the record all the same");

  // It never lands: after 4 minutes the step fails, and says what became of the call.
  now = T0;
  landsAt = Number.POSITIVE_INFINITY;
  await assert.rejects(requestCheck(world(unseen), step, { check: {} }, "request_check (test)"), /^Error: timed out after 240 s waiting for the verdict for request_check \(test\) \(the call's own end wasn't seen: the RPC stopped waiting\)$/);

  // A failure the chain reported, and a verdict the account refused, stop the step at once, as before.
  now = T0;
  await assert.rejects(requestCheck(world({ ...unseen, hash: "H1", failure: "a receipt failed" }), step, { check: {} }, "request_check (test)"), /^Error: request_check \(test\) failed: a receipt failed \(tx H1\)$/);
  const refused: TxResult = { label: "request_check (test)", hash: "H2", ok: true, gas_tgas: 40, seconds: 90, logs: [], result: { accepted: false, reason: "nonce 8 is not the counter 9" } };
  await assert.rejects(requestCheck(world(refused), step, { check: {} }, "request_check (test)"), /^Error: the account refused the verdict: nonce 8 is not the counter 9$/);
  assert.equal(now, T0, "neither waited");
});

// ---------- INTERFACES.md 45.3, item 11: the settlement steps read the pool's own answer ----------

/** A settlement's transaction as the chain shows it: the account's settle() answers `true`, and the logs carry the pool's answer. */
const poolSettleEvent = (fee: string, subsidy: string, cut: string) =>
  `EVENT_JSON:{"standard":"pb-pool","version":"1.0.0","event":"settle","data":{"account_id":"${ACCOUNT}","pricing":{"lender":{"margin_bp":500,"cap_bp":null}},"from":"account","period_ns":"233028571815","fee":"${fee}","subsidy":"${subsidy}","cut":"${cut}","credit":"0","debt":"509888252","parts":[]}}`;
const TOO_SOON = "the pool settled nothing: too soon: this account settled 88 seconds ago, and two settlements are at least 2 minutes apart";

test("INTERFACES.md 45.3, item 11: gate 2's fee step, on its own figures of 12 Nov: too soon at the first try, then a fee of $0.000202 with a cut of 0, both read from the logs; a fee the pool's 24-hour limits cut fails the step", async () => {
  // 12 Nov, 19:28 and 19:30 UTC: the first settle() 88 s after the borrow's own settlement, the second 233 s after.
  const c = chain({
    settles: [
      { answer: true, logs: [TOO_SOON] },
      { answer: true, fee: 202n, logs: [poolSettleEvent("202", "0", "0"), "the pool settled: a fee of 202 and a subsidy of 0"] },
    ],
  });
  const { gate, step, logged } = fakeGate(c);
  await stepSettle(gate, "settle_fee");
  assert.equal(step("settle_fee").pass, true, JSON.stringify(step("settle_fee").detail));
  assert.deepEqual(logged.filter((l) => l.includes("try")), [
    "  try 1: nothing settled: too soon: this account settled 88 seconds ago, and two settlements are at least 2 minutes apart",
    "  try 2: settled: a fee of $0.000202 was added to what the account owes our pool",
  ]);
  const detail = step("settle_fee").detail as { fee: string; cut: string | null; period_ns: string; tries: { answer: unknown; pool: unknown }[] };
  assert.deepEqual([detail.fee, detail.cut, detail.period_ns], ["202", "0", "233028571815"]);
  assert.deepEqual(detail.tries.map((t) => t.answer), [true, true], "what the account's settle() answered is kept as it was");
  assert.deepEqual(detail.tries[0]!.pool, { skipped: "too soon: this account settled 88 seconds ago, and two settlements are at least 2 minutes apart" });
  assert.deepEqual(detail.tries[1]!.pool, { fee: "202", subsidy: "0", cut: "0", credit: "0", period_ns: "233028571815", debt: "509888252" });

  // The subsidy step, the same way: $0.000176, nothing cut.
  const sub = chain({ settles: [{ answer: true, subsidy: 176n, logs: [poolSettleEvent("0", "176", "0"), "the pool settled: a fee of 0 and a subsidy of 176"] }] });
  const second = fakeGate(sub);
  await stepSettle(second.gate, "settle_subsidy");
  assert.equal(second.step("settle_subsidy").pass, true);
  assert.deepEqual([(second.step("settle_subsidy").detail as { subsidy: string; cut: string }).subsidy, (second.step("settle_subsidy").detail as { cut: string }).cut], ["176", "0"]);

  // A fee the pool's 24-hour limits cut: booked, but the step fails and says which limits to look at.
  const cut = chain({ settles: [{ answer: true, fee: 150n, logs: [poolSettleEvent("150", "0", "52")] }] });
  const third = fakeGate(cut);
  await assert.rejects(stepSettle(third.gate, "settle_fee"), StepFailed);
  const why = third.step("settle_fee").detail as { fee: string; cut: string; why: string };
  assert.deepEqual([why.fee, why.cut], ["150", "52"]);
  assert.equal(why.why, "the pool's 24-hour limits cut 0.000052 USDC from this fee, which is far too small to reach them: look at account_fee_day or pool_fee_day_bp in the pool's pricing limits");
  assert.deepEqual(third.logged.filter((l) => l.includes("try")), ["  try 1: settled: a fee of $0.00015 was added to what the account owes our pool; the pool's 24-hour fee limits took $0.000052 off it, which isn't owed later"]);

  // Booked by the keeper's own settlement just before this try: the step passes on the record, and says the cut wasn't read.
  const other = chain({ settles: [{ answer: true, fee: 202n, logs: [TOO_SOON] }] });
  const fourth = fakeGate(other);
  await stepSettle(fourth.gate, "settle_fee");
  const unread = fourth.step("settle_fee").detail as { cut: string | null; cut_unread?: string };
  assert.equal(fourth.step("settle_fee").pass, true);
  assert.deepEqual([unread.cut, typeof unread.cut_unread], [null, "string"]);
});
