// What the Phase 6 gate script (funding-demo.ts) is made of, apart from the network (FUNDING.md 10, gate 2;
// INTERFACES.md 24 to 26): the step list, the permission and the two pricing policies it uses, every deposit it
// attaches, the sums it sizes its calls with, how it reads Rhea's own record of the account, and the plan in words
// for a dry run. funding-steps.ts runs the steps; the tests check these pieces on their own.
import { ACT_HF_BP, NOW_HF_BP, showCushion } from "./cushion.js";
import { KEEPER_ALIVE_MS } from "./config.js";
import { belowLimit, type Plan } from "./hedge-kit.js";
import type { LogEvent } from "./jsonl.js";
import type { PoolSettled } from "./near-tx.js";
import { HOLD_MIN_SHIFT_BP } from "./rhea-price.js";

// ---------- the steps ----------

/** The demo book's setup, with hedge-demo's own steps: an account with test nBTC, hedged by a short on Hyperliquid. */
export const FUNDING_SETUP = ["create", "deposit", "hl_init", "to_hl", "agent", "approve", "short"] as const;
/** The gate itself. */
export const FUNDING_GATE = ["keeper", "order", "fund", "order_back", "funded", "fee_policy", "settle_fee", "subsidy_policy", "settle_subsidy", "price_drop", "top_up", "price_back"] as const;
/**
 * The way out: everything repaid and withdrawn. `repay`, `close_short`, `home` and `withdraw` are hedge-demo's.
 * Between `home` and `withdraw` (INTERFACES.md 50.2): a check lifts the pause the transfer home left, and the account
 * borrows again and repays, minutes after its USDC came home.
 */
export const FUNDING_CLOSE_OUT = ["repay_rhea", "repay", "credit", "rhea_withdraw", "close_short", "home", "pause_lifted", "borrow_again", "repay_again", "withdraw"] as const;
export const FUNDING_STEP_IDS: readonly string[] = [...FUNDING_SETUP, ...FUNDING_GATE, ...FUNDING_CLOSE_OUT];

/** The lenders a gate can run against. Aave is stage 3. */
export const GATE_LENDERS = ["rhea"] as const;
export type GateLender = (typeof GATE_LENDERS)[number];

// ---------- what the client and the operator sign ----------

/**
 * The permission the client signs with the account's opening: the app's default terms (INTERFACES.md 24), naming
 * only the lender this gate uses. The engine may borrow there down to a cushion of 1.5, at up to 25% a year.
 */
export function demoPermission(lender: GateLender) {
  return { lenders: [lender], min_hf_bp: 15_000, max_rate_bp: 2_500, moves: "any" };
}

/** The lender's rate plus 5 points: the client pays more than the lender charges, so a settlement books a fee. */
export const FEE_POLICY = { lender: { margin_bp: 500, cap_bp: null } };
/**
 * The lender's rate, capped at 0: the pool pays the difference, down to the floor (the client never pays less than
 * the lender pays its own depositors), so a settlement books a subsidy of the borrow rate less the deposit rate.
 */
export const SUBSIDY_POLICY = { lender: { margin_bp: 0, cap_bp: 0 } };

/**
 * What each call attaches, in yoctoNEAR. The account's: `fund`, `lender_repay` and `lender_withdraw` want exactly 1;
 * `settle` and `claim_credit` take none (the account contract as built, 11 Nov). The pool's operator methods take
 * none, like its `set_kyb`. One table, so a change in a contract is one change here.
 */
export const DEPOSITS = {
  fund: 1n,
  lender_repay: 1n,
  lender_withdraw: 1n,
  settle: 0n,
  claim_credit: 0n,
  set_pricing: 0n,
  set_funding: 0n,
} as const;

/**
 * The pool's source order the gate needs while the client asks for the loan. Our Rhea copy charges mainnet's rate
 * (about 15.9% a year), which is dearer than our pool, so under the default order, "cheapest", the engine would fund
 * the whole loan from our pool and there would be no Rhea loan to show. The operator sets this before `fund` and puts
 * back what was there straight after: the plan's steps are fixed once `fund` has stored them.
 */
export const GATE_ORDER = "lender_first";

/** Rhea charges 0.1 NEAR, once, to register an account, which the first `l_supply` pays from the account's own balance. */
export const RHEA_STORAGE_NEAR = 0.1;
/** What the gate wants free in the account before `fund`: that, and something over for the account's own storage. */
export const FREE_NEAR_NEEDED = 0.15;

// ---------- sums ----------

/** Rhea counts both tokens with 18 decimals inside (research/rhea.md 2): 10^12 for each micro-USDC, 10^10 for each of nBTC's units. */
export const USDC_INNER = 10n ** 12n;
export const NBTC_INNER = 10n ** 10n;

/** How far under a preview's total the client asks: 0.5%, so the on-chain check, a little later, still gives the whole split. */
export const FUND_MARGIN_BP = 50n;

/** The amount to ask `fund` for, from what a preview says can be lent in all (micro-USD). */
export function fundAmount(previewTotal: bigint): bigint {
  return belowLimit(previewTotal - (previewTotal * FUND_MARGIN_BP) / 10_000n);
}

export interface Source {
  source: string;
  amount: number;
  rate_bp: number | null;
}

/**
 * The gate needs a loan with two parts: one from the lender and one from our pool. What is wrong with a split that
 * hasn't both, in words that say what to change; null when it has.
 */
export function splitProblem(sources: Source[], lender: GateLender): string | null {
  const part = (name: string) => sources.find((s) => s.source === name)?.amount ?? 0;
  const name = lender === "rhea" ? "Rhea" : "Aave";
  if (part(lender) <= 0 && part("pool") <= 0) return "the engine found nothing to lend: is the short open, and does the account hold the nBTC?";
  if (part(lender) <= 0) return `the whole loan would come from our pool and none from ${name}: it has no room, or its rate is above the permission's 25%, or the pool's funding order isn't "lender_first" (the order step sets it)`;
  if (part("pool") <= 0) return `the whole loan would come from ${name} and none from our pool: ask for more, or check the pool's own limits for a new account`;
  return null;
}

/** The parts of a `fund` verdict's steps: what the lender and our pool are each to lend, in micro-USD. */
export function fundParts(steps: unknown, lender: GateLender | "aave"): { lender: bigint; pool: bigint; kinds: string[] } {
  let fromLender = 0n;
  let fromPool = 0n;
  const kinds: string[] = [];
  for (const step of Array.isArray(steps) ? (steps as ({ k?: unknown; l?: unknown; amt?: unknown } | null)[]) : []) {
    kinds.push(String(step?.k ?? "?"));
    const amount = typeof step?.amt === "number" || typeof step?.amt === "string" ? BigInt(Math.trunc(Number(step.amt))) : 0n;
    if (step?.k === "l_borrow" && step.l === lender) fromLender += amount;
    if (step?.k === "p_borrow") fromPool += amount;
  }
  return { lender: fromLender, pool: fromPool, kinds };
}

/** The cushion the price drop aims for: under 1.35, where the engine plans a top-up, and over 1.2. */
export const DROP_AIM_BP = 13_000;

/**
 * How far to hold the Rhea copy's BTC price under the oracle so that a cushion of `hfBp` falls to `aimBp`: the
 * cushion moves with the price, so the price must fall by 1 - aim / cushion. In bp, negative. Throws when the
 * cushion is already at or under the aim, or the fall would be more than the keeper's hold allows.
 */
export function dropFor(hfBp: number, aimBp = DROP_AIM_BP): number {
  if (!(aimBp >= NOW_HF_BP && aimBp < ACT_HF_BP)) throw new Error(`the price drop aims between ${showCushion(NOW_HF_BP)} and ${showCushion(ACT_HF_BP)}, not at ${showCushion(aimBp)}`);
  if (!(hfBp > aimBp)) throw new Error(`Rhea's cushion is ${showCushion(hfBp)} already, at or under the ${showCushion(aimBp)} the price drop aims for`);
  const shift = -Math.ceil((1 - aimBp / hfBp) * 10_000);
  if (shift < HOLD_MIN_SHIFT_BP) throw new Error(`a cushion of ${showCushion(hfBp)} needs bitcoin ${(-shift / 100).toFixed(1)}% down to reach ${showCushion(aimBp)}: more than a hold may ask for`);
  return shift;
}

/** What to send Rhea to clear a debt read a moment ago: the debt, 0.002% for the interest of the next minutes, and a little dust. */
export function rheaRepayAmount(debtMicro: bigint): bigint {
  return debtMicro + debtMicro / 50_000n + 100n;
}

/**
 * What a subsidy settlement should come to, in micro-USD, rounded down as the pool rounds it: the debt, times the
 * lender's borrow rate less its deposit rate, for `seconds` of a year. The gate uses it to say beforehand when a
 * subsidy would be too small to show.
 */
export function expectedSubsidyMicro(debtMicro: bigint, rateBp: number, supplyBp: number, seconds: number): bigint {
  const gap = Math.max(0, Math.round(rateBp) - Math.round(supplyBp));
  return (debtMicro * BigInt(gap) * BigInt(Math.max(0, Math.round(seconds)))) / (10_000n * 31_536_000n);
}

// ---------- Rhea's own record of the account ----------

export interface RheaPosition {
  /** Whether the account has registered with Rhea at all. */
  registered: boolean;
  /** USDC owed, in micro-USD, rounded up; nBTC posted as collateral, in the token's units, rounded down. */
  debtMicro: bigint;
  collateralUnits: bigint;
  /** USDC the account has lying at Rhea, not as collateral: what a repayment beyond the debt leaves there. */
  suppliedMicro: bigint;
}

/** Rhea's `get_account` answer (null before the account registers), read for our two tokens. Balances are inner units. */
export function rheaPosition(account: unknown, usdcId: string, nbtcId: string, collateralDecimals = 8): RheaPosition {
  // Rhea counts every token with 18 decimals inside: 10^10 for each of nBTC's units (8 decimals), 1 for each of
  // test ETH's (18). `nbtcId` is the collateral token, bitcoin's unless the gate posts another (INTERFACES.md 51.1).
  const collateralInner = 10n ** BigInt(18 - collateralDecimals);
  const a = account as { supplied?: unknown; collateral?: unknown; borrowed?: unknown } | null;
  const inner = (list: unknown, token: string): bigint => {
    const held = Array.isArray(list) ? (list as ({ token_id?: unknown; balance?: unknown } | null)[]).find((e) => e?.token_id === token) : undefined;
    return typeof held?.balance === "string" && /^\d+$/.test(held.balance) ? BigInt(held.balance) : 0n;
  };
  if (!a || typeof a !== "object") return { registered: false, debtMicro: 0n, collateralUnits: 0n, suppliedMicro: 0n };
  const debt = inner(a.borrowed, usdcId);
  return {
    registered: true,
    debtMicro: (debt + USDC_INNER - 1n) / USDC_INNER,
    collateralUnits: inner(a.collateral, nbtcId) / collateralInner,
    suppliedMicro: inner(a.supplied, usdcId) / USDC_INNER,
  };
}

// ---------- the pool's pricing record ----------

/** The pool's `get_pricing(account_id)` (INTERFACES.md 26). Money is micro-USD in strings. */
export interface PricingView {
  pricing: unknown;
  from: string;
  fees_charged: string;
  subsidy_paid: string;
  credit: string;
  settled_at: string;
  last: unknown[];
  /** INTERFACES.md 45.1: the fees the operator took back with `reverse_fee`. A pool from before that has no such field. */
  fees_reversed?: string;
}

/**
 * The pool's `get_params().pricing_limits` (INTERFACES.md 26, and 45.1 for the last three). The amounts are
 * micro-USD in strings, the periods plain numbers of nanoseconds.
 */
export interface PricingLimitsView {
  max_rate_bp?: number;
  avg_plus_bp?: number;
  max_period_ns?: number;
  min_period_ns?: number;
  account_subsidy_day?: string;
  pool_subsidy_day_bp?: number;
  /** A lender's reported debt counts at no more than this in a settlement, for a fee and for a subsidy. */
  max_lender_debt?: string;
  /** The most fee one account is charged in 24 hours. */
  account_fee_day?: string;
  /** The most fee the whole pool books in 24 hours, in bp of its capital. */
  pool_fee_day_bp?: number;
}

/** What was booked between two readings of the account's pricing record. */
export function settledBetween(before: PricingView, after: PricingView): { fee: bigint; subsidy: bigint } {
  return { fee: BigInt(after.fees_charged) - BigInt(before.fees_charged), subsidy: BigInt(after.subsidy_paid) - BigInt(before.subsidy_paid) };
}

/**
 * INTERFACES.md 45.3, item 11: what a settlement step makes of the sum the pool's record shows booked, and of the
 * pool's own answer to the try that booked it (its `settle` event, read from that transaction's logs).
 *
 * The gate's sums are a few ten-thousandths of a dollar, far inside the pool's 24-hour limits. So a settlement
 * that says the limits cut something from it means a limit is set wrong, and the step fails and says so. `own` is
 * null when another settlement booked the sum (the keeper's hourly one): its cut can't be read from here, and the
 * step goes by the pool's record alone, as it did before.
 */
export function settleCheck(want: "fee" | "subsidy", booked: bigint, own: PoolSettled | null): { ok: boolean; cut: string | null; why?: string } {
  if (booked <= 0n) return { ok: false, cut: own?.cut ?? null };
  if (!own) return { ok: true, cut: null };
  if (BigInt(own.cut) === 0n) return { ok: true, cut: own.cut };
  const limits = want === "fee" ? "account_fee_day or pool_fee_day_bp" : "account_subsidy_day or pool_subsidy_day_bp";
  return { ok: false, cut: own.cut, why: `the pool's 24-hour limits cut ${Number(own.cut) / 1e6} USDC from this ${want}, which is far too small to reach them: look at ${limits} in the pool's pricing limits` };
}

/**
 * INTERFACES.md 45.1: the pool's limits on a settlement's fee, as one line for the dry run, and what in them would
 * stop this gate's fee step: a lender's debt counted at less than the account will owe, or a 24-hour fee budget of
 * nothing. A pool from before those limits has none of the three fields, and the line says so.
 */
export function feeLimits(limits: PricingLimitsView, expectDebtMicro: bigint): { line: string; problems: string[] } {
  const dollars = (micro: string) => `$${(Number(micro) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const { max_lender_debt: most, account_fee_day: day, pool_fee_day_bp: share } = limits;
  if (most === undefined && day === undefined && share === undefined) return { line: "the pool has no limits on a settlement's fee: it is from before the pool's change of 12 Nov (INTERFACES.md 45)", problems: [] };
  const whole = (value: string | undefined): value is string => typeof value === "string" && /^\d+$/.test(value);
  if (!whole(most) || !whole(day) || typeof share !== "number") return { line: "the pool's limits on a settlement's fee can't be read", problems: ["the pool's pricing_limits has some of max_lender_debt, account_fee_day and pool_fee_day_bp, but not all three as INTERFACES.md 45.1 writes them"] };
  const problems: string[] = [];
  if (BigInt(most) < expectDebtMicro) problems.push(`the pool counts a lender's debt only up to ${dollars(most)} (max_lender_debt), and this account will owe Rhea about ${dollars(expectDebtMicro.toString())}: the fee would be worked out on less`);
  if (BigInt(day) === 0n || share === 0) problems.push(`the pool's 24-hour fee budget is nothing (${BigInt(day) === 0n ? "account_fee_day" : "pool_fee_day_bp"} is 0): every fee would be cut to nothing, and the fee step could never pass`);
  const gap = typeof limits.min_period_ns === "number" ? `; two settlements are at least ${Math.round(limits.min_period_ns / 1e9)} s apart` : "";
  return { line: `the pool's limits on a settlement's fee: a lender's debt counts up to ${dollars(most)}, an account is charged at most ${dollars(day)} in 24 hours, and the pool books at most ${(share / 100).toFixed(2)}% of its capital in 24 hours${gap}`, problems };
}

// ---------- the keeper, seen through its log ----------

/**
 * Whether the keeper's log shows it running for real, watching `account`, and keeping the Rhea copy's price: the
 * gate only signs for the client and the operator, and everything else is the keeper's. Unlike the depeg drill's
 * `keeperSees`, it doesn't wait for a loan: here the keeper has to be there before the loan starts.
 */
export function keeperReady(events: LogEvent[], account: string, nowMs: number, coin: "BTC" | "ETH" = "BTC"): { ok: boolean; why: string; last_tick_at: string | null; rhea_btc: number | null } {
  const last = events.filter((e) => e.event === "tick").at(-1);
  const none = { ok: false, last_tick_at: last?.t ?? null, rhea_btc: null };
  if (!last) return { ...none, why: "the keeper's log has no tick yet: start it with pnpm --filter @pb/keeper start" };
  const age = nowMs - Date.parse(last.t);
  if (age > KEEPER_ALIVE_MS) return { ...none, why: `the keeper's last tick was ${Math.round(age / 1000)} s ago: is it running?` };
  const start = events.filter((e) => e.event === "start" && typeof e.msg === "string" && e.msg.startsWith("the keeper is starting")).at(-1);
  if (start?.msg?.includes("dry run")) return { ...none, why: "the keeper runs as a dry run: it sends nothing. Start it without --dry-run" };
  if (!Array.isArray(last.accounts) || !(last.accounts as unknown[]).includes(account)) return { ...none, why: `the keeper's last tick doesn't list ${account} yet (it reads the factory's list once a minute)` };
  // The tick's own figure for the gate's coin: `rhea_btc`, or `rhea_eth` once the keeper keeps test ETH's price (INTERFACES.md 51.1).
  const seen = coin === "ETH" ? last.rhea_eth : last.rhea_btc;
  const rhea = typeof seen === "number" ? seen : null;
  if (rhea === null) return { ...none, why: coin === "ETH" ? "the keeper isn't keeping our Rhea copy's ETH price: it does once the factory lists test ETH as Rhea collateral and the copy has a price setting for it (start the keeper again after both)" : "the keeper isn't keeping our Rhea copy's BTC price: set RHEA_ACCOUNT_ID and OPERATOR_PRIVATE_KEY in .env and start it again" };
  return { ok: true, why: `the keeper ticked ${Math.round(age / 1000)} s ago, watches ${account}, and reads our Rhea copy's ${coin} price at $${rhea.toLocaleString("en-US")}`, last_tick_at: last.t, rhea_btc: rhea };
}

/** The keeper's log lines about `account` since `sinceIso`, of the kinds the gate records. */
export function keeperLines(events: LogEvent[], account: string, sinceIso: string, kinds: string[]): LogEvent[] {
  return events.filter((e) => e.account === account && e.t >= sinceIso && kinds.includes(e.event));
}

/**
 * A funding plan whose pool step can no longer run (14 Nov, the ETH gate at Aave): it is the plan the gate signed,
 * it has run out (a plan lasts 30 minutes), its lender's loan is done, and the only steps left are the pool's
 * (`p_borrow`). The keeper asks for a fresh check before the pool lends, and stops the plan when three checks in a
 * row bring no verdict; on 14 Nov OutLayer's testnet answered none of five. The Aave gate is about the lender's
 * part, so it goes on from here and records that the pool's part did not run. Any other unfinished plan is not this.
 */
export function poolPartLapsed(plan: { pid: string; expiresAtMs: number | null; steps: { k: string; done: boolean }[] } | null, pid: string | undefined, nowMs: number): boolean {
  if (!plan || !pid || plan.pid !== pid || plan.expiresAtMs === null || nowMs <= plan.expiresAtMs) return false;
  const left = plan.steps.filter((s) => !s.done);
  return left.length > 0 && left.every((s) => s.k === "p_borrow") && plan.steps.some((s) => s.k === "l_borrow" && s.done);
}

// ---------- the plan, in words ----------

export interface PlanWords {
  account: string;
  owner: string;
  operator: string;
  lender: GateLender;
  rheaId: string;
  pool: string;
  apiUrl: string;
  plan: Plan;
  recordFile: string;
  holdFile: string;
  aimBp: number;
  settleWaitMin: number;
  settleEverySec: number;
  /** --fund-wait: minutes the keeper has to run the funding plan. */
  fundWaitMin?: number;
}

/**
 * --fund-wait and --top-up-wait unless given, in minutes. 20 and 25 since 11 Nov (10 and 15 before): each of the
 * keeper's checks can take two minutes when OutLayer's queue is long, and a funding plan needs three or four.
 */
export const DEFAULT_FUND_WAIT_MIN = 20;
export const DEFAULT_TOP_UP_WAIT_MIN = 25;

/** Every step of the gate, in order, with what it sends and what it checks: the dry run prints this. */
export function describeGate(w: PlanWords): string[] {
  const usd = (micro: string) => `$${(Number(micro) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  // INTERFACES.md 51.1: with --coin ETH the plan's figures are the coin's (hedge-kit's planForCoin).
  const btc = Number(w.plan.deposit_nbtc_units) / 10 ** (w.plan.token_decimals ?? 8);
  const [coin, token] = w.plan.coin === "ETH" ? ["ETH", "test ETH"] : ["BTC", "test nBTC"];
  const permission = demoPermission(w.lender);
  return [
    `account ${w.account}, owned by ${w.owner}; operator ${w.operator}; lender ${w.lender} (${w.rheaId}); pool ${w.pool}; backend ${w.apiUrl}`,
    `the book: ${btc} ${token} (about $${Math.round(btc * w.plan.btc_px).toLocaleString("en-US")} at ${coin} $${w.plan.btc_px.toLocaleString("en-US")}), ${usd(w.plan.deposit_usdc_micro)} of test USDC, ${usd(w.plan.to_hl_micro)} of it on Hyperliquid, a ${w.plan.short_sz} ${coin} short`,
    "",
    "setup, signed by the client (the keeper's key owns the gate's account):",
    ` 1 create          create_account with 6 NEAR and the permission ${JSON.stringify(permission)}, in one signature. Checks: get_state().permission is that permission`,
    ` 2 deposit         mint and deposit the test USDC and ${token}`,
    ` 3 hl_init, to_hl, agent, approve, short   the hedge, as in the Phase 3 gate: the engine lends against a hedged book`,
    "",
    "the gate:",
    ` 4 keeper          nothing is sent. Checks: the keeper's log shows a tick in the last ${KEEPER_ALIVE_MS / 60_000} minutes, not a dry run, with ${w.account} in its list and our Rhea copy's ${coin} price; that price is within 0.25% of Hyperliquid's oracle`,
    ` 5 order           the operator's set_funding({"order":"lender_first"}), unless it is that already: our Rhea copy charges mainnet's rate, dearer than our pool, so under "cheapest" the whole loan would come from our pool. Checks: get_params().funding says lender_first`,
    ` 6 fund            a preview through POST /api/funding-plan; request_check with {"fund":{"amount"}} for 0.5% under what it can lend (0.01 NEAR); then the client's one fund(amount) with 1 yoctoNEAR. Checks first: the account is registered on the USDC token (or Rhea's loan would stay at Rhea), and has 0.15 NEAR free (Rhea takes 0.1 to register it). Checks: the preview and the verdict both split the loan between Rhea and our pool; get_state().funding holds the verdict's steps under the id f<its block>`,
    ` 7 order_back      the operator's set_funding with the order that was there before. Checks: get_params().funding is as it was`,
    ` 8 funded          nothing is sent: the keeper runs the steps. Checks: every funding step is done inside ${w.fundWaitMin ?? DEFAULT_FUND_WAIT_MIN} minutes; Rhea's get_account shows ${coin === "ETH" ? "ETH" : "nBTC"} posted and USDC owed; the pool's debt_of is above 0; a verdict's ext shows the Rhea loan`,
    ` 9 fee_policy      the operator's set_pricing({"account"}, ${JSON.stringify(FEE_POLICY)}): Rhea's rate plus 5 points. Checks: get_pricing says so, from "account"`,
    `10 settle_fee      request_check (0.01 NEAR), then settle(); again every ${w.settleEverySec} s while the pool answers "skipped" (up to ${w.settleWaitMin} min). Checks: the pool's fees_charged for the account went up, and the pool's own answer to that settlement (its settle event) has a cut of 0: its 24-hour fee limits took nothing off`,
    `11 subsidy_policy  the operator's set_pricing({"account"}, ${JSON.stringify(SUBSIDY_POLICY)}): Rhea's rate, capped at 0, so the pool pays down to Rhea's deposit rate. Checks: get_pricing says so`,
    `12 settle_subsidy  as step 10. Checks: the pool's subsidy_paid for the account went up, with a cut of 0`,
    `13 price_drop      sets a hold in the keeper's file (${w.holdFile}): keep our Rhea copy's ${coin} price far enough under the oracle to take Rhea's cushion to ${showCushion(w.aimBp)}. The keeper sets the price, and its price sync leaves it there. Checks: the copy's get_token_pyth_info shows the lower price`,
    `14 top_up          nothing is sent: the keeper asks for a check, the engine answers REBALANCE with an l_add or l_repay step, the keeper runs it. Checks: a verdict with Rhea's cushion under ${showCushion(ACT_HF_BP)} and such a plan; the keeper's own step in its log; more collateral or less debt at Rhea; then a verdict with the cushion back at ${showCushion(ACT_HF_BP)} or more, at the lower price`,
    `15 price_back      clears the hold. Checks: the copy's ${coin} price is back within 0.25% of the oracle`,
    "",
    "the way out, signed by the client:",
    `16 repay_rhea      lender_repay("rhea", the debt and a hair more) with 1 yoctoNEAR. Checks: Rhea's get_account shows no USDC owed`,
    `17 repay           repay to our pool (the settlements' fee is in its debt). Checks: debt_of is 0 and the loan is closed`,
    `18 credit          claim_credit(), only if the pool holds a credit for the account. Checks: the credit is 0`,
    `19 rhea_withdraw   lender_withdraw("rhea", ${token}, all of it), then lender_withdraw("rhea", test USDC, what the repayment left there), each with 1 yoctoNEAR; no check is needed with nothing owed to our pool. Checks: Rhea holds no collateral and no USDC for the account, and both are back in it`,
    `20 close_short, home   the short closed, the USDC home from Hyperliquid. Checks: no short is left, and the stand-in delivered the USDC`,
    `21 pause_lifted    on an account that shows open_sends: nothing is sent until Hyperliquid's own history shows the transfer home (up to ${LEDGER_WAIT_MS / 60_000} minutes); then request_check with {"borrow":{"amount":"${BORROW_AGAIN_MICRO}"}} (0.01 NEAR). Checks: once the result is accepted, get_state().hl.send_open_until_ms is "0" and open_sends is empty. If not, one more check ${PAUSE_RETRY_WAIT_MS / 1000} s later; a second miss fails the step`,
    `22 borrow_again    the client's borrow with that same check result (another check only if its ${FRESH_BLOCKS} blocks ran out), for $${Number(BORROW_AGAIN_MICRO) / 1e6} or what the result allows if that is less, with 1 yoctoNEAR. Checks: the pool's debt_of is above 0, and the USDC arrived in the account`,
    `23 repay_again     repay to our pool, all of it. Checks: debt_of is 0 and the loan is closed`,
    `   (an account made before the pause could lift early shows no open_sends: steps 21 to 23 are skipped, with one line that says so)`,
    `24 withdraw        both tokens back to the client, with no check. Checks: the account holds neither token`,
    "",
    `the record: ${w.recordFile}, saved after every step; --from <step> resumes from it`,
  ];
}

// ---------- what must be there before the gate can run ----------

/** What the script found on testnet and on this machine before it sends anything. `null` means the read failed. */
export interface Found {
  account: string;
  /** Whether the client account exists already, and whether this run resumes an earlier one (--from). */
  accountExists: boolean | null;
  resuming: boolean;
  owner: string;
  ownerNear: number | null;
  operator: string;
  hasOperatorKey: boolean;
  rheaId: string;
  nbtcId: string;
  /** The factory's get_config().lenders: what a new account is given. `undefined` when the factory has none. */
  factoryLenders: { rhea?: { contract_id?: string; collateral?: string[] } | null } | null | undefined;
  /** Whether the copy's account exists, and its BTC price in dollars, or in words why it has none. */
  copyExists: boolean | null;
  copyPrice: number | string | null;
  oracle: number | null;
  /** The copy's USDC terms, from the backend's GET /api/lenders (its testnet Rhea row). */
  rheaTerms: { rate_bp: number; supply_bp: number; free: string } | null;
  /** The pool's get_params(). */
  poolParams: { operator?: string; funding?: { order?: string } | null; pricing_limits?: PricingLimitsView | null } | null;
  /** The backend's GET /api/config. */
  backend: { preview_enabled?: boolean; gateway_enabled?: boolean } | null;
  keeper: { ok: boolean; why: string };
  /** The float's trouble carrying the short, in words, or null. */
  floatProblem: string | null;
  /**
   * Whether the hedge can go through the gateway now, opened and closed (hedge-kit's hedgeNow; INTERFACES.md 42):
   * its orders must sit inside the band of the gateway the account pins and meet Hyperliquid's real book. Null
   * when it couldn't be worked out; left out for a run that goes on after the hedge.
   */
  hedge?: { ok: boolean; why: string } | null;
  /** About what the account will owe Rhea, for judging whether a subsidy can show. */
  expectDebtMicro: bigint;
  /** INTERFACES.md 51.1: the gate's coin, for the words. Left out: BTC. */
  coin?: "BTC" | "ETH";
}

/** A settlement step waits about this long between two settlements. */
export const SETTLE_GAP_SECONDS = 120;
/** Creating the account, plus the checks (0.01 NEAR each, about 15 of them) and gas. */
export const OWNER_NEAR_NEEDED = 6.6;

/**
 * What stands in the gate's way, in words that say what to do, and one line per thing found. An empty `problems`
 * means the run can start.
 */
export function gateProblems(f: Found): { lines: string[]; problems: string[] } {
  const lines: string[] = [];
  const problems: string[] = [];
  const pct = (bp: number) => `${(bp / 100).toFixed(2)}%`;
  const dollars = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  // The gate's coin in words: bitcoin's lines are the ones of before.
  const [coin, one, token] = f.coin === "ETH" ? ["ETH", "an ether", "test ETH"] : ["BTC", "a bitcoin", "test nBTC"];

  // The client account: fresh, and the keeper's key can pay for it.
  if (f.accountExists === null) problems.push(`couldn't read whether ${f.account} exists: is NEAR_RPC_URL reachable?`);
  else if (f.accountExists && !f.resuming) problems.push(`${f.account} exists already: the gate starts from a fresh account, so give a new --name (or --from <step> to go on with this one)`);
  else lines.push(f.accountExists ? `${f.account} exists: resuming` : `${f.account} doesn't exist yet: it will be made`);
  if (f.ownerNear === null) problems.push(`couldn't read ${f.owner}'s balance`);
  else if (!f.accountExists && f.ownerNear < OWNER_NEAR_NEEDED) problems.push(`${f.owner} holds ${f.ownerNear.toFixed(2)} NEAR: a new account takes 6, and the run's checks and gas about 0.6 more. Top it up from the testnet faucet`);
  else lines.push(`${f.owner} holds ${f.ownerNear.toFixed(4)} NEAR`);

  // The factory must hand new accounts the Rhea settings, or the account can't use Rhea at all.
  const rhea = f.factoryLenders?.rhea;
  if (f.factoryLenders === null) problems.push("couldn't read the factory's config");
  else if (!rhea?.contract_id) problems.push("the factory's config has no lenders.rhea, so it makes accounts that can't use Rhea: it needs the Phase 6 code and its migrate() with the Rhea settings");
  else if (rhea.contract_id !== f.rheaId) problems.push(`the factory's config names ${rhea.contract_id} as Rhea, and RHEA_ACCOUNT_ID is ${f.rheaId}: they must be the same contract`);
  else if (!(rhea.collateral ?? []).includes(f.nbtcId)) problems.push(`the factory's Rhea settings don't list ${f.nbtcId} as collateral`);
  else lines.push(`the factory gives new accounts Rhea at ${rhea.contract_id}, with ${f.nbtcId} as collateral`);

  // Our Rhea copy: there, with a fixed BTC price the keeper keeps in step, and USDC to lend at a rate that shows.
  if (f.copyExists === null) problems.push(`couldn't read whether ${f.rheaId} exists`);
  else if (!f.copyExists) problems.push(`${f.rheaId} doesn't exist: our copy of Rhea must be deployed, with test USDC and ${token} listed, a fixed price for each, and USDC supplied to lend`);
  else if (typeof f.copyPrice !== "number") problems.push(f.copyPrice ?? `couldn't read ${f.rheaId}'s price setting for ${f.nbtcId}`);
  else if (f.oracle === null) problems.push(`couldn't read Hyperliquid testnet's ${coin} oracle price`);
  else {
    const gap = (Math.abs(f.copyPrice - f.oracle) / f.oracle) * 10_000;
    if (gap > 25) problems.push(`${f.rheaId} counts ${one} at ${dollars(f.copyPrice)}, ${pct(gap)} from Hyperliquid's oracle at ${dollars(f.oracle)}: the keeper isn't keeping it in step (set RHEA_ACCOUNT_ID and OPERATOR_PRIVATE_KEY in .env, then start the keeper)`);
    else lines.push(`${f.rheaId} counts ${one} at ${dollars(f.copyPrice)}, ${pct(gap)} from Hyperliquid's oracle`);
  }
  if (f.copyExists) {
    const t = f.rheaTerms;
    if (!t) problems.push("the backend's GET /api/lenders has no testnet Rhea row: set RHEA_ACCOUNT_ID in .env and start the backend again");
    else {
      const debt = dollars(Math.round(Number(f.expectDebtMicro) / 1e6));
      lines.push(`our Rhea copy lends USDC at ${pct(t.rate_bp)} a year, pays depositors ${pct(t.supply_bp)}, and has ${dollars(Math.floor(Number(t.free) / 1e6))} free`);
      if (BigInt(t.free) < f.expectDebtMicro * 2n) problems.push(`our Rhea copy has ${dollars(Number(t.free) / 1e6)} of USDC free, and the account will ask it for about ${debt}: supply more test USDC to it`);
      if (expectedSubsidyMicro(f.expectDebtMicro, t.rate_bp, t.supply_bp, SETTLE_GAP_SECONDS) < 1n) {
        problems.push(
          `our Rhea copy's borrow rate (${pct(t.rate_bp)}) is too close to its deposit rate (${pct(t.supply_bp)}): on about ${debt}, a subsidy over ${SETTLE_GAP_SECONDS} s comes to less than a millionth of a dollar, so none would show. Have more of its USDC borrowed (a second test account will do) until it lends at 1% a year or more`,
        );
      }
    }
  }

  // The pool: pricing live, and the operator's key to set it.
  const params = f.poolParams;
  if (params === null) problems.push("couldn't read the pool's get_params");
  else if (!params.funding || !params.pricing_limits) problems.push("the pool has no pricing yet (its get_params has no funding or pricing_limits): it needs the Phase 6 code and its migrate()");
  else {
    lines.push(`the pool's funding order is "${params.funding.order ?? "?"}"`);
    // INTERFACES.md 45.1: the limits on a settlement's fee, and anything in them that would stop the fee step.
    const fee = feeLimits(params.pricing_limits, f.expectDebtMicro);
    lines.push(fee.line);
    problems.push(...fee.problems);
    if (params.operator !== undefined && params.operator !== f.operator) problems.push(`the pool's operator is ${params.operator}, not ${f.operator} (OPERATOR_ACCOUNT_ID)`);
  }
  if (!f.hasOperatorKey) problems.push("OPERATOR_PRIVATE_KEY is empty in .env: the operator sets the account's price twice in this gate");

  // The backend, the keeper and the float.
  if (f.backend === null) problems.push("the backend doesn't answer: pnpm --filter @pb/api start");
  else if (!f.backend.preview_enabled || !f.backend.gateway_enabled) problems.push("the backend can't run previews or the gateway: OUTLAYER_PAYMENT_KEY is empty in its .env");
  else lines.push("the backend runs previews and the gateway");
  if (f.keeper.ok) lines.push(f.keeper.why);
  else problems.push(f.keeper.why);
  if (f.floatProblem) problems.push(f.floatProblem);
  // The hedge: no account is made for a run whose short the gateway would refuse, or couldn't close again.
  if (f.hedge === null) problems.push("couldn't work out whether the hedge can go through the gateway now: Hyperliquid's prices or the backend's GET /api/markets didn't answer");
  else if (f.hedge) (f.hedge.ok ? lines : problems).push(f.hedge.why);
  return { lines, problems };
}

// ---------- the pause that lifts early (INTERFACES.md 50.2): pause_lifted, borrow_again, repay_again ----------

/**
 * What the three steps read of `get_state().hl`. An account made after the deploy of 50.2 shows `open_sends`: the
 * nonces (unix ms, as strings) of the transfers out of Hyperliquid it asked the signer to sign and that no accepted
 * check has shown as sent. An account made before doesn't show the field, and keeps the 2 days and 1 hour.
 */
export interface SendPause {
  address?: string | null;
  send_open_until_ms?: string;
  open_sends?: string[];
  send_floor_until_ms?: string;
}

/** The second loan, minutes after the USDC came home: $50, or what the check allows if that is less. In micro-USDC. */
export const BORROW_AGAIN_MICRO = 50_000_000n;
/** How long `pause_lifted` looks for the transfer in Hyperliquid's own history before it asks for the check, and how often. */
export const LEDGER_WAIT_MS = 120_000;
export const LEDGER_EVERY_MS = 5_000;
/** `pause_lifted` asks for at most two checks: the engine's read of the history can trail by a moment, so it asks once more after this wait. */
export const PAUSE_CHECKS = 2;
export const PAUSE_RETRY_WAIT_MS = 30_000;
/** The account takes a check's result for 120 blocks from the block it read (its FRESH_BLOCKS). The gate borrows on one that has at least 15 left. */
export const FRESH_BLOCKS = 120;
export const FRESH_MARGIN_BLOCKS = 15;

/** Whether the account is one made after the deploy: it shows the list, empty or not. */
export function showsOpenSends(hl: SendPause | null | undefined): hl is SendPause & { open_sends: string[] } {
  return Array.isArray(hl?.open_sends);
}

/** The pause is over: the account shows the list, the list is empty, and `send_open_until_ms` is "0". Nothing less. */
export function pauseLifted(hl: SendPause | null | undefined): boolean {
  return showsOpenSends(hl) && hl.open_sends.length === 0 && hl.send_open_until_ms === "0";
}

/** One line for an account made before the deploy, where the three steps have nothing to show. */
export function olderAccountWords(account: string): string {
  return `${account} was made before the pause could lift early (its state shows no open_sends): it keeps the 2 days and 1 hour, so pause_lifted, borrow_again and repay_again are skipped`;
}

/** Why the pause gate, whose whole point is the lift, can't pass on an account made before the deploy. */
export function needsLiftWords(account: string): string {
  return `${account} was made before the pause could lift early (its state shows no open_sends), so it keeps the 2 days and 1 hour. This gate proves the lift and can't pass on it: run it with a new --name once the factory makes accounts with the new code`;
}

/**
 * The open nonces that Hyperliquid's history shows as sent, by 50.2's own rule: a `userNonFundingLedgerUpdates` row
 * whose `delta.type` is "send", whose `delta.user` is the account's address (any case) and whose `delta.nonce` is
 * the number. Money coming in (a `send` by another address) is no match.
 */
export function sendsInLedger(rows: unknown, address: string, open: string[]): string[] {
  if (!Array.isArray(rows)) return [];
  const sent = new Set<string>();
  for (const row of rows) {
    const d = (row as { delta?: { type?: unknown; user?: unknown; nonce?: unknown } } | null)?.delta;
    if (!d || d.type !== "send" || typeof d.user !== "string" || d.user.toLowerCase() !== address.toLowerCase()) continue;
    if (typeof d.nonce === "number" && Number.isSafeInteger(d.nonce)) sent.add(String(d.nonce));
  }
  return open.filter((nonce) => sent.has(nonce));
}

/** Where the history is read from: an hour before the oldest open nonce, as the engine reads it. */
export function ledgerFrom(open: string[]): number {
  return Math.min(...open.map(Number)) - 3_600_000;
}

/** What a check's result says, in a few words: for a step that fails on it. */
export function verdictWords(v: Record<string, unknown>): string {
  const allow = (v.allow ?? {}) as { borrow?: unknown };
  const parts = [`ok ${String(v.ok)}`, `state ${String(v.state ?? "none")}`, `action ${String(v.action ?? "none")}`, `allow.borrow ${String(allow.borrow ?? "none")}`];
  if (typeof v.reason === "string" && v.reason) parts.push(`reason "${v.reason}"`);
  return parts.join(", ");
}

/**
 * The second loan's amount: $50, or what the check allows if that is less. A check that isn't HEALTHY, or allows
 * nothing, gives no amount: the step fails with what the check said.
 */
export function borrowAgainAmount(verdict: Record<string, unknown>): { amount: bigint } | { problem: string } {
  const raw = Number((verdict.allow as { borrow?: unknown } | undefined)?.borrow ?? 0);
  const allowed = Number.isFinite(raw) && raw > 0 ? BigInt(Math.trunc(raw)) : 0n;
  if (verdict.ok !== true || verdict.state !== "HEALTHY" || allowed <= 0n) return { problem: `the check allows no new loan. It said: ${verdictWords(verdict)}` };
  return { amount: allowed < BORROW_AGAIN_MICRO ? allowed : BORROW_AGAIN_MICRO };
}

/**
 * Whether the check result the account holds can still back a borrow: it answers a borrow, it hasn't been used (its
 * nonce is the account's counter), and it has blocks left. `borrow_again` uses the result `pause_lifted` brought,
 * and asks for another only when this says no.
 */
export function heldBacksBorrow(held: { intent?: unknown; verdict: Record<string, unknown> } | null | undefined, counter: number, height: number): { ok: true } | { ok: false; why: string } {
  if (!held) return { ok: false, why: "the account holds no check result" };
  const intent = held.intent as Record<string, unknown> | null | undefined;
  if (!intent || typeof intent !== "object" || !("borrow" in intent)) return { ok: false, why: "the check result the account holds doesn't answer a borrow" };
  if (held.verdict.nonce !== counter) return { ok: false, why: "the check result the account holds was used already" };
  const age = height - Number(held.verdict.blk);
  if (!(age <= FRESH_BLOCKS - FRESH_MARGIN_BLOCKS)) return { ok: false, why: `the check result the account holds is ${age} blocks old, and the account takes one for ${FRESH_BLOCKS}` };
  return { ok: true };
}

/**
 * Why two checks left the pause on, in plain words. A floor is the ninth open transfer's doing (50.2): no check ends
 * the pause before it. Otherwise the history didn't show a transfer the account signed.
 */
export function pauseStaysWords(hl: SendPause | null | undefined, checks: number): string {
  const until = Number(hl?.send_open_until_ms ?? 0);
  const date = until > 0 ? new Date(until).toISOString() : "a time the account doesn't show";
  const floor = Number(hl?.send_floor_until_ms ?? 0);
  if (floor > 0 && (hl?.open_sends ?? []).length === 0) {
    return `the pause is still on after ${checks} check(s): the account holds a floor until ${new Date(floor).toISOString()} (more than 8 transfers were open at once), and no check ends the pause before it`;
  }
  const open = (hl?.open_sends ?? []).join(", ") || "none listed";
  return `the pause is still on after ${checks} check(s): the account still lists transfer(s) ${open} as not yet seen in Hyperliquid's history, and borrowing stays closed until ${date}. Either Hyperliquid's history doesn't show the transfer home yet, or the engine in use doesn't read it (is the new pb-risk the one the account pins?)`;
}

/** The last line of a run that passed: what gate 2 showed, with or without the second loan. */
export function passWords(steps: { id: string; detail: unknown }[]): string {
  const again = steps.find((s) => s.id === "borrow_again");
  const skipped = !again || Boolean((again.detail as { skipped?: unknown } | null)?.skipped);
  const base = "a Rhea loan and a pool loan, a fee and a subsidy, a top-up, and everything repaid and withdrawn";
  return skipped ? `${base}. The second loan after the transfer home was skipped: the account was made before the pause could lift early` : `${base}; and after the USDC came home from Hyperliquid, a check lifted the pause and a second loan was borrowed and repaid`;
}
