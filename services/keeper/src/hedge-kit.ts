// What the Phase 3 gate script (hedge-demo.ts) is made of, apart from the network: the two sizes and their caps, the
// order messages exactly as pb-gateway parses them, the NEP-413 Auth, and the step bookkeeping, modelled on
// scripts/first-loan.py: each step has an `expect_fail`, the record is JSON, and the run passes when every step's
// `ok` equals `!expect_fail` (and a refusal came with the code it should have).
import { randomBytes } from "node:crypto";

import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";

// ---------- the steps ----------

/** Every step, in order (PLAN.md 11.4, the Phase 3 gate). `--from` takes one of these. */
export const STEP_IDS = [
  "create",
  "deposit",
  "hl_init",
  "to_hl",
  "agent",
  "approve",
  "short",
  "borrow",
  "take_out",
  "refuse_close",
  "burst",
  "refuse_coin",
  "repay",
  "close_short",
  "home",
  "withdraw",
] as const;
export type StepId = (typeof STEP_IDS)[number];

export function isStepId(value: string): value is StepId {
  return (STEP_IDS as readonly string[]).includes(value);
}

/** A NEAR transaction a step sent. */
export interface TxRecord {
  label: string;
  hash: string | null;
  ok: boolean;
  /** Gas burnt by every receipt, in TGas. */
  gas_tgas: number;
  failure?: string;
  /** Receipts by contract, with their gas, where a step wants them (the MPC signer's, say). */
  receipts?: { executor: string; gas_tgas: number }[];
  result?: unknown;
  seconds: number;
}

/** One call to the backend that ran pb-gateway, or posted to Hyperliquid. */
export interface GatewayRecord {
  label: string;
  http_status: number;
  ok: boolean;
  code?: string | null;
  reason?: string | null;
  status?: string | null;
  oid?: number | null;
  filled_sz?: string | null;
  avg_px?: string | null;
  call_id?: string | null;
  attestation_url?: string | null;
  error?: string;
  seconds: number;
}

export interface StepRecord {
  /** A StepId in the hedge gate; the Phase 4 scripts (drill-demo, fault-run) add their own. */
  id: string;
  label: string;
  /** Did the action go through? */
  ok: boolean;
  expect_fail: boolean;
  /** For an expected refusal: the gateway codes it must come with. */
  expect_codes?: string[];
  code?: string | null;
  /** ok == !expect_fail, and the refusal's code is one expected. */
  pass: boolean;
  started_utc: string;
  seconds: number;
  txs: TxRecord[];
  gateway: GatewayRecord[];
  detail: unknown;
}

export type Size = "small" | "full";

export interface HedgeRecord {
  version: 1;
  account: string;
  owner: string;
  size: Size;
  api_url: string;
  started_utc: string;
  finished_utc?: string;
  /** Amounts and caps for this run (planFor). */
  plan: Plan;
  /** What later steps (and a resumed run) need: the HL address, the float's orders, quotes... */
  context: Record<string, unknown>;
  steps: StepRecord[];
  pass?: boolean;
  /** What was left open on Hyperliquid when a run stopped, and how to close it. */
  leftovers?: string[];
}

export function stepPass(step: Pick<StepRecord, "ok" | "expect_fail" | "expect_codes" | "code">): boolean {
  if (step.ok !== !step.expect_fail) return false;
  if (step.expect_fail && step.expect_codes?.length) return step.expect_codes.includes(step.code ?? "");
  return true;
}

/** The run passes when every step ran and passed. */
export function runPasses(record: HedgeRecord): boolean {
  return stepsPass(record.steps, STEP_IDS);
}

/** With `--until`: the steps up to and including `until` ran and passed. */
export function runPassesUntil(record: HedgeRecord, until: StepId): boolean {
  return stepsPass(record.steps, STEP_IDS.slice(0, STEP_IDS.indexOf(until) + 1));
}

/** Every id in `ids` ran, and every step recorded passed. */
export function stepsPass(steps: StepRecord[], ids: readonly string[]): boolean {
  const done = new Set(steps.map((s) => s.id));
  return ids.every((id) => done.has(id)) && steps.every(stepPass);
}

/** For `--from`: keeps the steps before `from`, with the context, and drops the rest. */
export function resumeAt(record: HedgeRecord, from: StepId): HedgeRecord {
  const { pass: _pass, finished_utc: _finished, leftovers: _leftovers, ...rest } = record;
  return { ...rest, steps: stepsBefore(record.steps, STEP_IDS, from) };
}

/** The steps that come before `from` in `ids`. */
export function stepsBefore(steps: StepRecord[], ids: readonly string[], from: string): StepRecord[] {
  const cut = ids.indexOf(from);
  return steps.filter((s) => ids.indexOf(s.id) < cut);
}

/** A step stopped the run: its error, and the step's own record. */
export class StepFailed extends Error {
  readonly step: StepRecord;
  constructor(step: StepRecord, message: string) {
    super(message);
    this.name = "StepFailed";
    this.step = step;
  }
}

/** What a step's body reports. */
export interface StepOutcome {
  ok: boolean;
  code?: string | null;
  detail?: unknown;
}

/** What a step's body gets: places to note its transactions and gateway calls as they happen. */
export interface StepContext {
  tx(record: TxRecord): void;
  gateway(record: GatewayRecord): void;
}

/** What a step runner needs of its record: the steps so far, and the context later steps read. */
export interface RunRecord {
  context: Record<string, unknown>;
  steps: StepRecord[];
}

export interface StepOptions {
  expect_fail?: boolean;
  expect_codes?: string[];
  observe?: boolean;
}

/** What the steps see of their runner (hedge-steps.ts takes any record that has steps and a context). */
export interface Runner {
  readonly record: RunRecord;
  done(id: string): boolean;
  run(id: string, label: string, options: StepOptions, body: (step: StepContext) => Promise<StepOutcome>): Promise<StepRecord>;
}

/**
 * Runs the steps in order, saving the record after each one. A step that throws counts as not ok. An action that
 * fails stops the run (StepFailed). A step marked `observe` (the refusals, and the 40 orders) is recorded and the run
 * goes on either way, as scripts/first-loan.py does, so the close-out still happens; the final test sees it.
 */
export class StepRunner<R extends RunRecord = HedgeRecord> implements Runner {
  readonly record: R;
  readonly #save: (record: R) => void;
  readonly #log: (line: string) => void;
  readonly #now: () => number;

  constructor(record: R, save: (record: R) => void, log: (line: string) => void, now: () => number = Date.now) {
    this.record = record;
    this.#save = save;
    this.#log = log;
    this.#now = now;
  }

  done(id: string): boolean {
    return this.record.steps.some((s) => s.id === id);
  }

  async run(
    id: string,
    label: string,
    options: StepOptions,
    body: (step: StepContext) => Promise<StepOutcome>,
  ): Promise<StepRecord> {
    const started = this.#now();
    const step: StepRecord = {
      id,
      label,
      ok: false,
      expect_fail: options.expect_fail ?? false,
      ...(options.expect_codes && { expect_codes: options.expect_codes }),
      pass: false,
      started_utc: new Date(started).toISOString(),
      seconds: 0,
      txs: [],
      gateway: [],
      detail: null,
    };
    this.#log(`[${id}] ${label}...`);
    let error: unknown;
    try {
      const outcome = await body({ tx: (t) => step.txs.push(t), gateway: (g) => step.gateway.push(g) });
      step.ok = outcome.ok;
      step.code = outcome.code ?? null;
      step.detail = outcome.detail ?? null;
    } catch (thrown) {
      error = thrown;
      step.ok = false;
      step.detail = { error: thrown instanceof Error ? thrown.message : String(thrown) };
    }
    step.seconds = Math.round((this.#now() - started) / 100) / 10;
    step.pass = stepPass(step);
    this.record.steps = [...this.record.steps.filter((s) => s.id !== id), step];
    this.#save(this.record);
    const mark = step.expect_fail ? (step.ok ? "WENT THROUGH, NOT EXPECTED" : step.pass ? `refused, as expected (${step.code ?? "no code"})` : `refused with ${step.code ?? "no code"}, NOT ${step.expect_codes?.join(" or ")}`) : step.ok ? "ok" : "FAILED";
    this.#log(`[${id}] ${mark} (${step.seconds} s)${step.ok || step.expect_fail ? "" : ` | ${error instanceof Error ? error.message : JSON.stringify(step.detail).slice(0, 300)}`}`);
    // An observed step goes on unless its own code failed (a read or a post that threw).
    if (!step.pass && (!options.observe || error !== undefined)) {
      throw new StepFailed(step, error instanceof Error ? error.message : `step ${id} did not go as expected`);
    }
    return step;
  }
}

// ---------- sizes, amounts and caps ----------

export interface Plan {
  size: Size;
  /** The BTC price the amounts were sized at. */
  btc_px: number;
  deposit_usdc_micro: string;
  deposit_nbtc_units: string;
  /** INTERFACES.md 51.1: the coin, when it isn't bitcoin, and its token's decimals (see planForCoin). */
  coin?: string;
  token_decimals?: number;
  to_hl_micro: string;
  /** The short, in BTC, as Hyperliquid writes it. */
  short_sz: string;
  burst: { count: number; sz: string };
  caps: { to_hl_micro: string; short_usd: number; borrow_micro: string; float_order_usd: number; nbtc_usd: number };
}

/** BTC's szDecimals on Hyperliquid (testnet and mainnet, 8 Nov). */
export const BTC_SZ_DECIMALS = 5;
/** Each of the 40 orders sent at once is "just over $10". */
export const BURST_COUNT = 40;
export const BURST_ORDER_USD = 10.5;

/**
 * full: PLAN.md section 2's demo book: $25k of nBTC at the live price, $9,500 of USDC to Hyperliquid, a $25k short.
 * small: the same book at about 1/22 of the size, in the same proportions, so the same checks bite: 0.015 mNBTC
 * hedged by a 0.015 BTC short, $430 of margin on Hyperliquid and $10 left on NEAR. Its allowance equity (about
 * $1,570 at $76k) stays over the engine's $1,000 floor for credit (C0, RISK_ENGINE.md 7.2).
 *
 * Why the proportions matter: with the loan out, closing the short is refused when the equity left is under the
 * unhedged nBTC's requirement (P8). The line is 70% of collateral (C4), so that holds when the USDC is under about
 * half the nBTC. Checked natively with pb-gateway's check_order and pb-risk on pb-risk's "hedged" fixture (BTC at
 * $76.1k), rescaled, with the loan 0.5% under the line: both books refuse the close by about 11% (small: line
 * $1,103, equity after the close $471 against a requirement of $527; full: line $24,160, $10,316 against $11,576),
 * and all 40 orders of the burst pass. With the loan still in the account, both closes go through. A book of mostly
 * USDC with a small short (2,000 mUSDC, 0.01 mNBTC, a 0.0002 BTC short) lets the close through even with the loan out.
 * Every amount is checked against its size's caps before anything is sent.
 */
export function planFor(size: Size, btcPx: number): Plan {
  if (!Number.isFinite(btcPx) || btcPx < 1_000 || btcPx > 1_000_000) throw new Error(`the BTC price ${btcPx} doesn't look right`);
  const burstSz = sizeAtLeast(BURST_ORDER_USD, btcPx);
  if (size === "small") {
    return checkCaps({
      size,
      btc_px: btcPx,
      deposit_usdc_micro: "440000000",
      deposit_nbtc_units: "1500000",
      to_hl_micro: "430000000",
      short_sz: "0.015",
      burst: { count: BURST_COUNT, sz: burstSz },
      caps: { to_hl_micro: "500000000", short_usd: 2_000, borrow_micro: "2000000000", float_order_usd: 2_000, nbtc_usd: 2_000 },
    });
  }
  const nbtcUnits = BigInt(Math.floor((25_000 / btcPx) * 1e8));
  return checkCaps({
    size,
    btc_px: btcPx,
    deposit_usdc_micro: "9600000000",
    deposit_nbtc_units: nbtcUnits.toString(),
    to_hl_micro: "9500000000",
    short_sz: formatSize(String(25_000 / btcPx), BTC_SZ_DECIMALS),
    burst: { count: BURST_COUNT, sz: burstSz },
    caps: { to_hl_micro: "9600000000", short_usd: 26_000, borrow_micro: "25000000000", float_order_usd: 27_000, nbtc_usd: 26_000 },
  });
}

/**
 * A BTC size as Hyperliquid writes it: 0.33000000000000002 -> "0.33". Sizes here are sums and differences of
 * Hyperliquid's own sizes, so the noise of float arithmetic goes to the nearest 0.00001.
 */
export function btcSz(size: number): string {
  return coinSz(size, BTC_SZ_DECIMALS);
}

/** The same for any coin, with its own size decimals from Hyperliquid's meta (INTERFACES.md 51.1). */
export function coinSz(size: number, szDecimals: number): string {
  return formatSize(size.toFixed(szDecimals), szDecimals);
}

/**
 * The coin a gate hedges and the token it posts as collateral (INTERFACES.md 51.1). Left out everywhere, it is BTC
 * and test nBTC, as before: 5 size decimals, 8 token decimals.
 */
export interface GateCoin {
  /** Hyperliquid's coin: "BTC" or "ETH". */
  coin: string;
  /** Its size decimals on Hyperliquid (meta's szDecimals). */
  szDecimals: number;
  /** The collateral token on NEAR, and its decimals. */
  token: string;
  tokenDecimals: number;
}

/**
 * The plan for another coin than bitcoin: the same book in dollars. The collateral is the coin's test token worth
 * what the bitcoin plan's bitcoin is, cut to the coin's size decimals; the short is that same size; the 40 small
 * orders are sized for the coin. The plan's `deposit_nbtc_units` then holds the collateral token's units and
 * `btc_px` the coin's price: the names are bitcoin's, the figures the coin's.
 */
export function planForCoin(size: Size, btcPx: number, coin: GateCoin, coinPx: number): Plan {
  const base = planFor(size, btcPx);
  if (coin.coin === "BTC") return base;
  if (!Number.isFinite(coinPx) || coinPx <= 0) throw new Error(`the ${coin.coin} price ${coinPx} doesn't look right`);
  const usd = (Number(base.deposit_nbtc_units) / 1e8) * btcPx;
  const step = 10 ** coin.szDecimals;
  const amount = Math.floor((usd / coinPx) * step) / step;
  const text = coinSz(amount, coin.szDecimals);
  const [whole, fraction = ""] = text.split(".");
  const units = BigInt(whole + fraction.padEnd(coin.tokenDecimals, "0"));
  return { ...base, btc_px: coinPx, deposit_nbtc_units: units.toString(), short_sz: text, burst: { count: base.burst.count, sz: sizeAtLeast(BURST_ORDER_USD, coinPx, coin.szDecimals) }, coin: coin.coin, token_decimals: coin.tokenDecimals };
}

/** The smallest BTC size worth at least `usd` at `px`, in Hyperliquid's writing. */
export function sizeAtLeast(usd: number, px: number, szDecimals: number = BTC_SZ_DECIMALS): string {
  const step = 10 ** -szDecimals;
  const units = Math.ceil(usd / px / step);
  return formatSize((units * step).toFixed(szDecimals), szDecimals);
}

function checkCaps(plan: Plan): Plan {
  const usd = (sz: string) => Number(sz) * plan.btc_px;
  if (BigInt(plan.to_hl_micro) > BigInt(plan.caps.to_hl_micro)) throw new Error(`the move to Hyperliquid is above the ${plan.size} cap`);
  if (usd(plan.short_sz) > plan.caps.short_usd) throw new Error(`the short ($${usd(plan.short_sz).toFixed(2)}) is above the ${plan.size} cap of $${plan.caps.short_usd}`);
  if (usd(plan.short_sz) < 10) throw new Error("the short is under Hyperliquid's $10 minimum");
  if ((Number(plan.deposit_nbtc_units) / 10 ** (plan.token_decimals ?? 8)) * plan.btc_px > plan.caps.nbtc_usd) throw new Error(`the nBTC deposit is above the ${plan.size} cap`);
  const burstUsd = usd(plan.burst.sz) * plan.burst.count;
  if (Math.max(usd(plan.short_sz), burstUsd) > plan.caps.float_order_usd) throw new Error(`the float's side ($${burstUsd.toFixed(2)}) is above the ${plan.size} cap`);
  return plan;
}

/** A limit `bp` past the mark, rounded the safe way for Hyperliquid (5 significant figures; BTC prices are whole). */
export function limitPx(mark: number, bp: number, szDecimals = BTC_SZ_DECIMALS): string {
  return formatPrice(String(mark * (1 + bp / 10_000)), szDecimals);
}

// ---------- the gate's own order prices and the gateway's band (INTERFACES.md 42) ----------

/** How far through the mark the gate prices an order that should fill: 0.3%, so the account's order meets the float's. */
export const THROUGH_MARK_BP = 30;
/**
 * How far inside the band's edge a price stays. The gateway measures from its own reference price, which follows
 * Hyperliquid's oracle price but isn't read from it: a tenth of a percent covers the difference.
 */
export const BAND_EDGE_BP = 10;
/**
 * Hyperliquid testnet's own limit on how far from its oracle price a trade may be, as the gates met it on 12 Nov.
 * Its docs name the refusal ("Price too far from oracle") and give no figure. Seen: a buy matched asks 2.44% over
 * the oracle and stopped before one 2.55% over; buys priced 2.7% and 2.8% over were refused whole. The gates keep
 * their own prices a tenth of a percent inside 2.5%.
 */
export const HL_TESTNET_REACH_BP = 240;

/**
 * What one of the gate's own orders is priced from: Hyperliquid's mark and oracle price, the top of its real book,
 * and the band the account's own pinned gateway uses (P2; 300 bp on testnet for a gateway built since 12 Nov, the
 * parameter file's 100 bp for BTC on an older one). The band comes from one place: the backend's GET /api/markets.
 */
export interface PriceFacts {
  mark: number;
  /** NaN when Hyperliquid gave none: no band can then be worked out, and the price is 0.3% through the mark. */
  oracle: number;
  /** NaN when the book couldn't be read or has no such side: the mark stands in for it. */
  bestBid: number;
  bestAsk: number;
  bandBp: number;
  /** Hyperliquid's own limit on a trade's distance from its oracle price, in bp, where one is known. Left out: only the band holds a price. */
  venueBp?: number;
}

/** How far from the oracle price a gate's order may be, in bp, and whether Hyperliquid's own limit is what sets it. */
function reachOf(f: PriceFacts): { bp: number; venue: boolean } {
  const band = f.bandBp - BAND_EDGE_BP;
  return f.venueBp !== undefined && f.venueBp < band ? { bp: f.venueBp, venue: true } : { bp: band, venue: false };
}

export type GatePx = { px: string; held_to_band: boolean } | { problem: string };

const dollars = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/**
 * The price of one of the gate's own orders, or in words why no price works.
 * - `under`: 0.3% under the mark. The float bids there and the account's IOC sells meet it (the short, the burst).
 *   The buy that is meant to be refused by a risk check sits there too, under the asks, so it couldn't fill.
 * - `over`: 0.3% over the mark. The float asks there and the account's IOC buys meet it (closing the short).
 *
 * Two things hold it. It stays inside the gateway's band around the oracle price, less a tenth of a percent: a
 * price further out is brought to that edge. And the float's resting order must not cross the real book (a bid
 * under the best ask, an ask over the best bid), or it would trade with strangers and not wait for the account.
 * When the band's edge is on the wrong side of the book no price does both: the mark is too far from the oracle
 * for an order that could fill to pass the gateway.
 *
 * Where `venueBp` is given and is the nearer limit, the price is held to that instead: Hyperliquid's own limit on
 * a trade's distance from its oracle price (HL_TESTNET_REACH_BP), which the gateway's 3% band lets through.
 */
export function gatePx(side: "under" | "over", f: PriceFacts, szDecimals = BTC_SZ_DECIMALS): GatePx {
  const aim = f.mark * (1 + (side === "under" ? -THROUGH_MARK_BP : THROUGH_MARK_BP) / 10_000);
  const known = Number.isFinite(f.oracle) && f.oracle > 0;
  const { bp: reachBp, venue } = reachOf(f);
  const reach = reachBp / 10_000;
  const held = known ? Math.min(Math.max(aim, f.oracle * (1 - reach)), f.oracle * (1 + reach)) : aim;
  const px = formatPrice(String(held), szDecimals);
  // A bid at or over the best ask would buy from the real book; an ask at or under the best bid would sell into it.
  const book = side === "under" ? (Number.isFinite(f.bestAsk) ? f.bestAsk : f.mark) : Number.isFinite(f.bestBid) ? f.bestBid : f.mark;
  const crosses = side === "under" ? Number(px) >= book : Number(px) <= book;
  if (!crosses) return { px, held_to_band: held !== aim };
  const [order, edge] = side === "under" ? ["bid", `at or over the best ask (${dollars(book)})`] : ["ask", `at or under the best bid (${dollars(book)})`];
  if (held === aim) return { problem: `a ${order} at ${dollars(Number(px))}, 0.3% ${side} the mark (${dollars(f.mark)}), would be ${edge} and cross the real book` };
  const gap = `${(Math.abs(f.mark / f.oracle - 1) * 100).toFixed(2)}% ${f.mark >= f.oracle ? "over" : "under"}`;
  return {
    problem:
      `Hyperliquid's mark (${dollars(f.mark)}) stands ${gap} its oracle price (${dollars(f.oracle)}), and ` +
      (venue
        ? `Hyperliquid testnet itself takes no trade more than about ${reachBp / 100}% from that price. The ${side === "under" ? "lowest" : "highest"} price that could trade, about ${dollars(Number(px))}, is ${edge}: an order Hyperliquid takes couldn't fill, and the float's ${order} there would cross the real book`
        : `the account's gateway takes a price at most ${f.bandBp / 100}% from its reference price, which follows the oracle. The ${side === "under" ? "lowest" : "highest"} price it would take, about ${dollars(Number(px))}, is ${edge}: an order the gateway takes couldn't fill, and the float's ${order} there would cross the real book`),
  };
}

/**
 * Whether the hedge can go through the gateway now, both ways: opened with sells and closed again with buys. A
 * short that couldn't be closed isn't opened. With a 3% band it can while the mark is within about 2.9% of the
 * oracle price; with 1%, within about 0.9%.
 */
export function hedgeNow(f: PriceFacts, szDecimals: number = BTC_SZ_DECIMALS, coin = "BTC"): { ok: boolean; why: string } {
  const [open, close] = [gatePx("under", f, szDecimals), gatePx("over", f, szDecimals)];
  const stopped = "problem" in open ? open.problem : "problem" in close ? close.problem : null;
  if (stopped !== null || "problem" in open || "problem" in close) {
    return { ok: false, why: `${stopped}. The hedge can't be opened and closed through the gateway now: it can once the mark is within about ${reachOf(f).bp / 100}% of the oracle price` };
  }
  const known = Number.isFinite(f.oracle) && f.oracle > 0;
  const gap = known ? `${(Math.abs(f.mark / f.oracle - 1) * 100).toFixed(2)}% ${f.mark >= f.oracle ? "over" : "under"} its oracle price (${dollars(f.oracle)})` : "with no oracle price to measure from";
  return { ok: true, why: `Hyperliquid's ${coin} mark (${dollars(f.mark)}) is ${gap}, and the gateway's band is ${f.bandBp / 100}%${reachOf(f).venue ? ` (Hyperliquid's own limit, about ${reachOf(f).bp / 100}%, is the nearer one)` : ""}: the hedge opens with sells at ${dollars(Number(open.px))} and closes with buys at ${dollars(Number(close.px))}` };
}

/** As the web app does (web/src/lib/borrow.ts): 0.01% plus 2 micro-USDC below a limit, for interest and rounding. */
export function belowLimit(limit: bigint): bigint {
  const below = limit - limit / 10_000n - 2n;
  return below < 0n ? 0n : below;
}

/**
 * How far under the line the gate borrows: 0.5%. With the loan at the tier cap (C4), each order's fee and booked
 * slippage eat into the cap: on the small book, 0.01% under the line let only 19 of the 40 orders through. With 0.5%
 * left, all 40 fit, and the close-short refusal comes from the requirement (equity below IM), as RISK_ENGINE.md 13.7
 * describes it.
 */
export const BORROW_MARGIN_BP = 50n;

/** The amount the gate borrows on a line: 0.5% under it, then belowLimit's margin for interest and rounding. */
export function underLine(line: bigint): bigint {
  return belowLimit(line - (line * BORROW_MARGIN_BP) / 10_000n);
}

/** RISK_ENGINE.md 6: the loan cap per tier, as a share of collateral C = E_A + D. */
export const TIER_CAP_BP: Record<string, number> = { PREFERRED: 8_500, STANDARD: 7_000, WATCH: 5_000 };

/**
 * Two of P8's three credit conditions, read off a verdict (RISK_ENGINE.md 7.3): E_A >= IM, and D <= cap_tier * (E_A + D).
 * The third, the extreme-day pool loss, isn't in a verdict. Amounts are micro-USD; `debt` is the pool's debt_of.
 */
export function creditHolds(verdict: Record<string, unknown>, debt: bigint): { holds: boolean; why: string[] } {
  const eqAllow = Number(verdict.eq_allow ?? verdict.eq ?? Number.NaN);
  const im = Number(verdict.im ?? Number.NaN);
  const capBp = TIER_CAP_BP[String(verdict.tier)];
  const d = Number(debt);
  const why: string[] = [];
  if (!(eqAllow >= im)) why.push(`allowance equity ${eqAllow} is under the requirement ${im}`);
  if (capBp === undefined) why.push(`no tier cap for tier ${String(verdict.tier)}`);
  else if (d * 10_000 > capBp * (eqAllow + d)) why.push(`the loan ${d} is above ${capBp / 100}% of collateral ${eqAllow + d}`);
  return { holds: why.length === 0, why };
}

/** The parts of the pool's views the borrow step reads (contracts/pool/src/views.rs). Amounts are micro-USDC. */
export interface PoolView {
  cash: string;
  loans: string;
  capital: string;
  paused: boolean;
  lent_24h: string;
  daily_budget: string;
}
export interface ParamsView {
  caps: {
    max_utilisation_bp: number;
    client_share_bp: number;
    new_account_limit: string;
    ceiling: { preferred: string; standard: string; watch: string };
  };
}
export interface BorrowerView {
  debt: string;
  tier: "PREFERRED" | "STANDARD" | "WATCH";
  first_week_until: string;
  blocked: boolean;
}

/**
 * The pool's own limits for one account, which hold whatever a verdict says (RISK_ENGINE.md 7.2 and 12.2), as the
 * web app's borrowable() reads them: paused, blocked, its cash, 90% utilisation, the daily budget, one client's
 * share, the tier's ceiling and a new account's first-week limit.
 */
export function poolRoom(pool: PoolView, params: ParamsView, borrower: BorrowerView | null, nowNs: bigint): { label: string; amount: bigint }[] {
  const capital = BigInt(pool.capital);
  const debt = BigInt(borrower?.debt ?? "0");
  const caps = params.caps;
  const limits: { label: string; amount: bigint }[] = [];
  if (pool.paused) limits.push({ label: "the pool is paused", amount: 0n });
  if (!borrower) limits.push({ label: "the account is not registered with the pool", amount: 0n });
  if (borrower?.blocked) limits.push({ label: "the account is blocked", amount: 0n });
  limits.push({ label: "the pool's cash", amount: BigInt(pool.cash) });
  limits.push({ label: "utilisation at most 90%", amount: (capital * BigInt(caps.max_utilisation_bp)) / 10_000n - BigInt(pool.loans) });
  limits.push({ label: "the daily lending budget", amount: BigInt(pool.daily_budget) - BigInt(pool.lent_24h) });
  limits.push({ label: "one client's share", amount: (capital * BigInt(caps.client_share_bp)) / 10_000n - debt });
  if (borrower) {
    const tier = borrower.tier.toLowerCase() as keyof ParamsView["caps"]["ceiling"];
    limits.push({ label: `the ${tier} tier's ceiling`, amount: BigInt(caps.ceiling[tier]) - debt });
    if (nowNs < BigInt(borrower.first_week_until)) limits.push({ label: "a new account's first-week limit", amount: BigInt(caps.new_account_limit) - debt });
  }
  return limits.map((l) => ({ ...l, amount: l.amount < 0n ? 0n : l.amount }));
}

// ---------- the messages pb-gateway parses (risk/pb-gateway/src/msg.rs) ----------

export interface OrderFields {
  coin: string;
  is_buy: boolean;
  sz: string;
  limit_px: string;
  reduce_only: boolean;
  tif: "Gtc" | "Ioc" | "Alo";
}

/**
 * msg.rs's `OrderMessage` written by serde: compact, keys in the struct's order. `parse_exact` re-serialises what it
 * parsed and compares, so this must be byte-for-byte that form.
 */
export function orderMessage(account: string, order: OrderFields, expiresMs: number): string {
  if (!isWireDecimal(order.sz) || !isWireDecimal(order.limit_px)) throw new Error(`sz ${order.sz} and limit_px ${order.limit_px} must be in Hyperliquid's wire form`);
  const { coin, is_buy, sz, limit_px, reduce_only, tif } = order;
  return JSON.stringify({ pb: "order", account, order: { coin, is_buy, sz, limit_px, reduce_only, tif }, expires_ms: expiresMs });
}

export function cancelMessage(account: string, coin: string, oid: number, expiresMs: number): string {
  return JSON.stringify({ pb: "cancel", account, cancel: { coin, oid }, expires_ms: expiresMs });
}

/** msg.rs `decimal`: digits and at most one point, no sign or exponent, no leading zeros, no trailing zeros after the point. */
export function isWireDecimal(text: string): boolean {
  return text.length <= 30 && /^(0|[1-9]\d*)(\.\d*[1-9])?$/.test(text);
}

/**
 * How far ahead an order's signature lasts: the gateway allows at most 120 s past the NEAR final block's time
 * (pb-gateway's MAX_AHEAD_MS). 110 s since 11 Nov: the run reads the time when its turn comes in OutLayer's queue, so
 * an order that waits there longer than this is refused as expired (AUTH), and has to be signed again.
 */
export const EXPIRY_MS = 110_000;

/**
 * INTERFACES.md 50.4: since the gateway built for it, a message may be signed up to 240 s ahead on testnet, and the
 * backend's GET /api/markets?account= says what to sign for on the account's own pinned gateway (`order_life_ms`):
 * 230 s on that build, 110 s on an older one. The gates sign for that figure, and for `EXPIRY_MS` when the route
 * doesn't say: a backend from before, an answer with no such field, or a figure no gateway would take.
 */
export const MAX_ORDER_LIFE_MS = 230_000;
export function orderLifeOf(answer: unknown): number {
  const life = (answer as { order_life_ms?: unknown } | null | undefined)?.order_life_ms;
  return typeof life === "number" && Number.isInteger(life) && life >= 10_000 && life <= MAX_ORDER_LIFE_MS ? life : EXPIRY_MS;
}

/** INTERFACES.md 9's Auth. */
export interface Auth {
  owner: string;
  public_key: string;
  signature: string;
  message: string;
  nonce: string;
  recipient: string;
}

export const GATEWAY_RECIPIENT = "pb-gateway";

/** What signs: near-api-js's Signer.signNep413Message, or a fake. */
export interface Nep413Signer {
  signNep413Message(accountId: string, params: { message: string; recipient: string; nonce: Uint8Array }): Promise<{ publicKey: { toString(): string }; signature: Uint8Array }>;
}

/** Signs `message` for pb-gateway with 32 random nonce bytes, and returns the Auth to post. */
export async function signAuth(signer: Nep413Signer, owner: string, message: string, nonce: Uint8Array = randomBytes(32)): Promise<Auth> {
  const signed = await signer.signNep413Message(owner, { message, recipient: GATEWAY_RECIPIENT, nonce });
  return {
    owner,
    public_key: signed.publicKey.toString(),
    signature: Buffer.from(signed.signature).toString("base64"),
    message,
    nonce: Buffer.from(nonce).toString("base64"),
    recipient: GATEWAY_RECIPIENT,
  };
}

// ---------- the gateway's answers ----------

/** The gateway's output, as /api/order passes it on (INTERFACES.md 9 and 11). */
export interface GatewayAnswer {
  ok?: boolean;
  code?: string;
  reason?: string;
  status?: string;
  oid?: number;
  filled_sz?: string;
  avg_px?: string | null;
  call_id?: string | null;
  attestation_url?: string | null;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

export function gatewayRecord(label: string, httpStatus: number, answer: GatewayAnswer, seconds: number): GatewayRecord {
  return {
    label,
    http_status: httpStatus,
    ok: httpStatus === 200 && answer.ok === true,
    code: answer.code ?? (httpStatus === 200 ? null : (answer.error ?? `HTTP ${httpStatus}`)),
    reason: answer.reason ?? answer.message ?? null,
    status: answer.status ?? null,
    oid: answer.oid ?? null,
    filled_sz: answer.filled_sz ?? null,
    avg_px: answer.avg_px ?? null,
    call_id: answer.call_id ?? null,
    attestation_url: answer.attestation_url ?? null,
    seconds,
  };
}

/** The 40 orders sent at once: how many filled, rested, and were refused, by code. */
export function tallyBurst(records: GatewayRecord[]) {
  const refused: Record<string, number> = {};
  let filled = 0;
  let partial = 0;
  let resting = 0;
  let filledSz = 0;
  for (const r of records) {
    if (r.ok) {
      if (r.status === "filled") filled += 1;
      else if (r.status === "partial") partial += 1;
      else if (r.status === "resting") resting += 1;
      filledSz += Number(r.filled_sz ?? 0);
    } else {
      const code = r.code ?? "unknown";
      refused[code] = (refused[code] ?? 0) + 1;
    }
  }
  return { sent: records.length, filled, partial, resting, refused, filled_sz: Number(filledSz.toFixed(BTC_SZ_DECIMALS)) };
}

/** A position's signed size from a clearinghouseState, 0 when none. */
export function positionSize(clearinghouse: unknown, coin: string): number {
  const positions = (clearinghouse as { assetPositions?: { position: { coin: string; szi: string } }[] } | null)?.assetPositions ?? [];
  return Number(positions.find((p) => p.position.coin === coin)?.position.szi ?? 0);
}
