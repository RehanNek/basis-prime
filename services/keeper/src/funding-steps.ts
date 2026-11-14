// The Phase 6 gate's own steps (FUNDING.md 10, gate 2; INTERFACES.md 25 and 26), each a function of the gate's world:
// the chain, the backend, Hyperliquid's info API, the keeper's log and the keeper's price hold. funding-demo.ts gives
// them the real ones; the tests give fakes. The setup and most of the way out are hedge-demo's steps.
//
//   keeper          the keeper runs, watches the account and keeps our Rhea copy's BTC price
//   order           the operator: the pool fills a loan from the lender first, for the moment of the `fund`
//   fund            a preview, a check for {"fund":{"amount"}}, and the client's one fund(amount)
//   order_back      the operator: the pool's order as it was
//   funded          the keeper runs the plan: Rhea shows collateral and a debt, and our pool a debt
//   fee_policy      the operator: Rhea's rate plus 5 points for this account
//   settle_fee      a check and settle(), until the pool's record shows a fee
//   subsidy_policy  the operator: Rhea's rate capped at 0, so the pool pays down to Rhea's deposit rate
//   settle_subsidy  a check and settle(), until the pool's record shows a subsidy
//   price_drop      a hold on the keeper's price sync: the copy's BTC price is kept under the oracle
//   top_up          the keeper asks for a check, gets a top-up plan and runs it; the cushion is back
//   price_back      the hold is cleared: the copy's price is the oracle's again
//   repay_rhea      the client's lender_repay, in full
//   credit          the client's claim_credit, if the pool holds one
//   rhea_withdraw   the client's lender_withdraw of all the nBTC, and of the USDC the repayment left at Rhea
//   pause_lifted    after `home` (INTERFACES.md 50.2): a check that sees the transfer home in Hyperliquid's history
//                   lifts the pause on borrowing. Skipped, with borrow_again and repay_again, on an older account
//   borrow_again    the client's borrow from our pool on that check's result, minutes after the USDC came home
//   repay_again     that loan repaid in full
//
// Who signs what: the client (the keeper's key owns the gate's accounts, as in the earlier gates) signs the opening
// with its permission, the checks, `fund`, `settle`, and the way out. The operator signs the two `set_pricing` and
// the two `set_funding`. The script never runs a funding or top-up step, and never sets the copy's price: those are
// the keeper's, running on its own, and the script only watches the chain and reads the keeper's log.
import { ACT_HF_BP, showCushion } from "./cushion.js";
import { BORROW_AGAIN_MICRO, borrowAgainAmount, heldBacksBorrow, LEDGER_EVERY_MS, LEDGER_WAIT_MS, ledgerFrom, needsLiftWords, olderAccountWords, PAUSE_CHECKS, PAUSE_RETRY_WAIT_MS, pauseLifted, pauseStaysWords, sendsInLedger, showsOpenSends, DEPOSITS, dropFor, FEE_POLICY, FREE_NEAR_NEEDED, fundAmount, fundParts, GATE_ORDER, keeperLines, keeperReady, rheaPosition, rheaRepayAmount, settleCheck, settledBetween, splitProblem, SUBSIDY_POLICY, type GateLender, type PricingView, type RheaPosition, type Source } from "./funding-kit.js";
import { call, coinOf, collateralOf, repayAll, requestCheck, sameJson, state, until, verdictSummary, type Gate, type World } from "./hedge-steps.js";
import type { StepContext } from "./hedge-kit.js";
import type { LogEvent } from "./jsonl.js";
import { settleWords } from "./loop.js";
import { eventsIn, settlementIn, TGAS_ACCOUNT, type NearCall, type PoolSettled, type TxResult } from "./near-tx.js";
import { pendingLender, readExt, readFunding, readPlan, TOP_UP_KINDS, type LenderExt } from "./plan.js";
import { gapBp, HOLD_MAX_MS, priceOf, readPriceInfo, RHEA_PRICE_BAND_BP, type RheaHold } from "./rhea-price.js";
import type { AccountState } from "./state.js";

export interface FundingOptions {
  /** What the preview is asked for, in micro-USD: more than the book can carry, so the answer is the most it can. */
  askMicro: bigint;
  /** The cushion the price drop aims for, in bp. */
  aimBp: number;
  /** How long the keeper has to run the funding plan (it lasts 30 minutes). */
  fundWaitMs: number;
  /** How long a settlement step keeps trying while the pool answers "skipped", and how often. */
  settleWaitMs: number;
  settleEveryMs: number;
  /** How long the keeper has to top Rhea up after the drop. */
  topUpWaitMs: number;
}

/**
 * What the three steps of INTERFACES.md 50.2 (pause_lifted, borrow_again, repay_again) need of a gate: gate 2 runs
 * them, and so does the short pause gate (pause-demo.ts), which has no lender and no operator.
 */
export interface LiftGate extends Gate {
  /** The final block's height. */
  finalBlock(): Promise<number>;
  /**
   * The pause gate sets this: the lift is its whole point, so on an account that doesn't show `open_sends` the
   * three steps fail, and say the account was made before the deploy. Left out (gate 2), they are skipped and pass.
   */
  mustLift?: boolean;
}

export interface FundingGate extends LiftGate {
  lender: GateLender;
  /** Our Rhea copy. */
  rheaId: string;
  /** The pool's operator: it signs set_pricing and set_funding. Null without its key. */
  operator: { id: string; call: NearCall | null };
  /** The keeper's log, oldest first. */
  keeperLog(): LogEvent[];
  /** The hold on the keeper's price sync (rhea-price.ts): set it, and the keeper keeps the copy's price that far from the oracle. */
  hold: { set(hold: RheaHold): void; clear(): void };
  /** The client account's NEAR above what its storage locks. */
  freeNear(): Promise<number>;
  /** The final block's height. */
  finalBlock(): Promise<number>;
  options: FundingOptions;
}

// ---------- reads ----------

const accountState = (w: World) => w.near.view<AccountState>(w.account, "get_state");

export function rheaAccount(g: FundingGate): Promise<RheaPosition> {
  const w = g.world;
  return w.near.view<unknown>(g.rheaId, "get_account", { account_id: w.account }).then((a) => rheaPosition(a, w.ids.musdc, collateralOf(w), w.coin?.tokenDecimals ?? 8));
}

const pricing = (g: FundingGate) => g.world.near.view<PricingView>(g.world.ids.pool, "get_pricing", { account_id: g.world.account });

interface FundingSettings {
  order?: string;
  loan_days?: number;
}
const poolFunding = async (g: FundingGate) => (await g.world.near.view<{ funding?: FundingSettings | null }>(g.world.ids.pool, "get_params")).funding ?? null;

/** What our Rhea copy counts one bitcoin at, in dollars. Throws with the reason if it has no fixed price to read. */
export async function copyPrice(g: FundingGate): Promise<number> {
  const w = g.world;
  // The gate's collateral token: bitcoin's setting has 8 decimals, test ETH's 18 (INTERFACES.md 51.1).
  const token = w.coin && w.coin.coin === "ETH" ? ({ coin: "ETH", decimals: w.coin.tokenDecimals } as const) : undefined;
  const info = readPriceInfo(await w.near.view<unknown>(g.rheaId, "get_token_pyth_info", { token_id: collateralOf(w) }), token);
  if (typeof info === "string") throw new Error(info);
  return priceOf(info);
}

/** Hyperliquid testnet's BTC oracle price: what the engine counts a bitcoin at, and what the keeper holds the copy to. */
export async function btcOracle(w: World): Promise<number> {
  const [meta, ctxs] = await w.hl.info<[{ universe: { name: string }[] }, { oraclePx?: string }[]]>({ type: "metaAndAssetCtxs" });
  // The gate's coin: BTC unless the gate hedges another (INTERFACES.md 51.1).
  const px = Number(ctxs[meta.universe.findIndex((u) => u.name === coinOf(w))]?.oraclePx);
  if (!(px > 0)) throw new Error(`Hyperliquid testnet gave no ${coinOf(w)} oracle price`);
  return px;
}

/** The copy's price against a level `shiftBp` from the oracle (0: the oracle itself). */
async function priceGap(g: FundingGate, shiftBp: number) {
  const [copy, oracle] = await Promise.all([copyPrice(g), btcOracle(g.world)]);
  return { copy, oracle, gap_bp: Math.round(gapBp(copy, oracle * (1 + shiftBp / 10_000)) * 10) / 10 };
}

/** The gate's coin in words (INTERFACES.md 51.1): bitcoin's are the words of before. */
const coinWords = (w: World) => (coinOf(w) === "ETH" ? { coin: "ETH", one: "an ether", plain: "ether", token: "ETH" } : { coin: "BTC", one: "a bitcoin", plain: "bitcoin", token: "nBTC" });

const rheaExt = (state: AccountState | null): LenderExt | undefined => readExt(state?.verdict?.verdict.ext).find((e) => e.l === "rhea");
const iso = (ms: number) => new Date(ms).toISOString();
const usd = (micro: bigint | string | number) => `$${(Number(micro) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Makes sure the account holds `want` micro-USDC: what is missing comes from the owner, minted from the test token's faucet if need be. */
async function ensureUsdc(w: World, step: StepContext, want: bigint): Promise<{ put_in: string; minted: string }> {
  const held = BigInt(await w.near.view<string>(w.ids.musdc, "ft_balance_of", { account_id: w.account }));
  if (held >= want) return { put_in: "0", minted: "0" };
  const missing = want - held;
  const ownerHas = BigInt(await w.near.view<string>(w.ids.musdc, "ft_balance_of", { account_id: w.owner }));
  const minted = ownerHas < missing ? missing - ownerHas : 0n;
  if (minted > 0n) await call(w, step, w.ids.musdc, "mint", { account_id: w.owner, amount: minted.toString() }, 30, 1_250_000_000_000_000_000_000n, "mint mUSDC to the owner");
  await call(w, step, w.ids.musdc, "ft_transfer_call", { receiver_id: w.account, amount: missing.toString(), msg: "" }, 100, 1n, "deposit mUSDC for the repayment");
  return { put_in: missing.toString(), minted: minted.toString() };
}

/**
 * While the account lists a lender action as under way (20 blocks after a borrow or a withdrawal at Rhea), it
 * refuses a withdrawal of collateral, and a check asked for now is refused when it lands. Waits until that block
 * has passed. Returns the block waited for, or null when nothing was listed.
 */
async function waitOutLender(g: FundingGate): Promise<number | null> {
  const listed = pendingLender((await accountState(g.world)).pending);
  if (!listed) return null;
  await until(g.world, `block ${listed.untilBlock} to pass (the account counts its ${listed.kind} at Rhea as under way until then)`, 120_000, 3_000, () => g.finalBlock(), (height) => height > listed.untilBlock);
  return listed.untilBlock;
}

/**
 * How long the gate waits for something the keeper does on its next tick or with its next check. Ticks start 15 s
 * apart, but one waits for whatever it sent: a check that sits in OutLayer's queue can hold it for minutes.
 */
const KEEPER_WAIT_MS = 300_000;

// ---------- the steps ----------

export async function stepKeeperUp(g: FundingGate) {
  const { runner, world: w } = g;
  await runner.run("keeper", `the keeper is running, watches the account, and keeps our Rhea copy's ${coinWords(w).coin} price`, {}, async () => {
    const ready = () => keeperReady(g.keeperLog(), w.account, w.now(), coinOf(w) === "ETH" ? "ETH" : "BTC");
    const seen = await until(w, "the keeper to watch the account", KEEPER_WAIT_MS, 5_000, async () => ready(), (r) => r.ok).catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}. ${ready().why}`);
    });
    const price = await priceGap(g, 0);
    const inBand = price.gap_bp <= RHEA_PRICE_BAND_BP;
    return {
      ok: inBand,
      detail: { ...seen, rhea_btc_usd: price.copy, oracle_usd: price.oracle, gap_bp: price.gap_bp, ...(inBand ? {} : { why: `our Rhea copy counts ${coinWords(w).one} at $${price.copy}, ${(price.gap_bp / 100).toFixed(2)}% from Hyperliquid's oracle at $${price.oracle}: outside the 0.25% band the keeper holds it to` }) },
    };
  });
}

/** The operator's set_funding on the pool, which must then show in get_params. */
async function setOrder(g: FundingGate, step: StepContext, funding: FundingSettings, label: string): Promise<TxResult> {
  if (!g.operator.call) throw new Error("OPERATOR_PRIVATE_KEY is empty in .env: the operator sets the pool's funding order");
  const tx = await g.operator.call(g.world.ids.pool, "set_funding", { funding }, { tgas: 30, deposit: DEPOSITS.set_funding, label });
  step.tx(tx);
  if (!tx.ok) throw new Error(`${label} failed: ${tx.failure ?? "no reason given"} (tx ${tx.hash})`);
  return tx;
}

/**
 * Our Rhea copy charges mainnet's rate, dearer than our pool, so under the pool's default order ("cheapest") the
 * whole loan would come from our pool. For the moment of the `fund`, the operator has the lender filled first.
 * What was there before is kept in the record, and `order_back` (or the run's last act, if it stops) puts it back.
 */
export async function stepOrder(g: FundingGate) {
  const { runner } = g;
  await runner.run("order", `the operator has the pool fill a loan from the lender first ("${GATE_ORDER}"), for the client's fund`, {}, async (step) => {
    const before = await poolFunding(g);
    if (!before) throw new Error("the pool's get_params has no funding settings: it needs the Phase 6 code");
    if (before.order === GATE_ORDER) {
      runner.record.context.funding_order = { before, changed: false };
      return { ok: true, detail: { already: `the pool's order is "${GATE_ORDER}" already: nothing to set, and nothing to put back`, funding: before } };
    }
    // Kept before the call goes out, so a run that stops right here still knows what to put back.
    runner.record.context.funding_order = { before, changed: true };
    const tx = await setOrder(g, step, { ...before, order: GATE_ORDER }, `set_funding (${GATE_ORDER})`);
    const after = await poolFunding(g);
    return { ok: after?.order === GATE_ORDER, detail: { before, after, events: eventsIn(tx.logs).map((e) => e.event) } };
  });
}

/** Puts the pool's order back, if the `order` step changed it and it hasn't been put back. Returns whether it sent anything. */
export async function restoreOrder(g: FundingGate, step: StepContext): Promise<{ restored: boolean; funding: FundingSettings | null }> {
  const kept = g.runner.record.context.funding_order as { before: FundingSettings; changed: boolean; restored?: boolean } | undefined;
  if (!kept?.changed || kept.restored) return { restored: false, funding: await poolFunding(g) };
  await setOrder(g, step, kept.before, `set_funding (back to ${kept.before.order ?? "what it was"})`);
  kept.restored = true;
  return { restored: true, funding: await poolFunding(g) };
}

export async function stepOrderBack(g: FundingGate) {
  const { runner } = g;
  await runner.run("order_back", "the operator puts the pool's funding order back as it was", {}, async (step) => {
    const kept = runner.record.context.funding_order as { before: FundingSettings; changed: boolean } | undefined;
    if (!kept) throw new Error("the record doesn't say what the pool's order was: run the order step first");
    const { restored, funding } = await restoreOrder(g, step);
    return { ok: sameJson(funding, kept.before), detail: restored ? { put_back: kept.before, funding } : { why: "the order step changed nothing, or it is back already", funding } };
  });
}

export async function stepFund(g: FundingGate) {
  const { runner, world: w } = g;
  await runner.run("fund", "a preview, a check for the fund intent, then the client's one fund(amount)", {}, async (step) => {
    // Two things Rhea's loan needs of the account, checked before anything is paid for. Not registered on the USDC
    // token, the borrowed money can't be delivered and stays at Rhea as a deposit (research/rhea.md 12). And the
    // first l_supply registers the account at Rhea, which takes 0.1 NEAR of the account's own.
    const [registered, free] = await Promise.all([w.near.view<unknown>(w.ids.musdc, "storage_balance_of", { account_id: w.account }), g.freeNear()]);
    if (!registered) return { ok: false, detail: { why: `${w.account} isn't registered on the USDC token (${w.ids.musdc}): Rhea's loan couldn't reach it and would stay at Rhea as a deposit. Register it with the token's storage_deposit first` } };
    if (free < FREE_NEAR_NEEDED) return { ok: false, detail: { why: `${w.account} has ${free.toFixed(3)} NEAR free: registering at Rhea takes 0.1 of it, and the gate wants ${FREE_NEAR_NEEDED} there. Send the account some NEAR`, free_near: free } };

    const started = w.now();
    const { status, body } = await w.api.post("/api/funding-plan", { account: w.account, amount: g.options.askMicro.toString() });
    const view = (body ?? {}) as { total?: number; sources?: Source[]; steps?: unknown[]; blended_bp?: number | null; verdict?: Record<string, unknown>; run?: { call_id?: string; attestation_url?: string }; message?: string };
    step.gateway({ label: "preview (fund)", http_status: status, ok: status === 200 && view.verdict?.ok === true, call_id: view.run?.call_id ?? null, attestation_url: view.run?.attestation_url ?? null, reason: view.message ?? (view.verdict?.reason as string | undefined) ?? null, seconds: Math.round((w.now() - started) / 100) / 10 });
    if (status !== 200) throw new Error(`the funding preview failed: HTTP ${status} ${view.message ?? ""}`);
    const preview = { asked: g.options.askMicro.toString(), total: view.total ?? 0, sources: view.sources ?? [], steps: view.steps ?? [], blended_bp: view.blended_bp ?? null };
    const problem = splitProblem(preview.sources, g.lender);
    if (problem) return { ok: false, detail: { why: problem, preview, verdict: view.verdict ?? null } };

    // The client asks for a little under what the preview can lend, so the check a moment later still gives it all.
    const amount = fundAmount(BigInt(Math.trunc(preview.total)));
    if (amount <= 0n) return { ok: false, detail: { why: "the preview can lend too little to ask for", preview } };
    const v = await requestCheck(w, step, { fund: { amount: amount.toString() } }, "request_check (fund)");
    const parts = fundParts(v.fund, g.lender);
    const verdict = { ...verdictSummary(v), fund: v.fund ?? null, ext: v.ext ?? null };
    if (v.ok !== true || v.state !== "HEALTHY" || parts.lender <= 0n || parts.pool <= 0n) {
      return { ok: false, detail: { why: "the check's own answer isn't a loan from both Rhea and our pool: nothing was signed", amount: amount.toString(), preview, verdict } };
    }
    await call(w, step, w.account, "fund", { amount: amount.toString() }, 100, DEPOSITS.fund, "fund");
    const pid = `f${String(v.blk)}`;
    const st = await until(w, `the funding plan ${pid} to be stored`, 30_000, 2_000, () => accountState(w), (s) => readFunding(s)?.pid === pid);
    const funding = readFunding(st)!;
    runner.record.context.funding = { pid, amount: amount.toString(), from_lender: parts.lender.toString(), from_pool: parts.pool.toString(), stored_at_ms: funding.storedAtMs, expires_at_ms: funding.expiresAtMs };
    return {
      ok: funding.steps.length === parts.kinds.length && funding.steps.every((s, i) => s.k === parts.kinds[i]),
      detail: { amount: amount.toString(), from_rhea: parts.lender.toString(), from_pool: parts.pool.toString(), free_near: free, preview, verdict, funding: { pid, expires_at_ms: funding.expiresAtMs, steps: funding.steps.map((s) => ({ i: s.i, k: s.k, text: s.text })) } },
    };
  });
}

export async function stepFunded(g: FundingGate) {
  const { runner, world: w } = g;
  await runner.run("funded", "the keeper runs the funding plan: the account ends with a Rhea loan and a pool loan", {}, async () => {
    const stored = runner.record.context.funding as { pid?: string; stored_at_ms?: number | null } | undefined;
    if (!stored?.pid) throw new Error("the record has no funding plan: run the fund step first");
    const since = iso((stored.stored_at_ms ?? w.now()) - 60_000);
    const lines = () => keeperLines(g.keeperLog(), w.account, since, ["step", "check", "note"]);
    const allDone = (s: AccountState) => {
      const f = readFunding(s);
      return f !== null && f.pid === stored.pid && f.steps.every((x) => x.done);
    };
    await until(w, "the keeper to run every step of the funding plan", g.options.fundWaitMs, 5_000, () => accountState(w), allDone).catch((error: unknown) => {
      const last = lines().slice(-3).map((l) => `${l.event}: ${l.msg ?? ""}`).join(" | ");
      throw new Error(`${error instanceof Error ? error.message : String(error)}. The keeper's last lines for the account: ${last || "none"}`);
    });
    const [rhea, debt] = await Promise.all([rheaAccount(g), w.near.view<string>(w.ids.pool, "debt_of", { account_id: w.account })]);
    // The keeper asks for a check once the steps have run: its verdict is the first to show the Rhea loan.
    const shown = await until(w, "a verdict that shows the Rhea loan", KEEPER_WAIT_MS, 5_000, () => accountState(w), (s) => (rheaExt(s)?.d ?? 0) > 0).catch(() => null);
    const ext = rheaExt(shown) ?? null;
    runner.record.context.loans = { rhea_debt_micro: rhea.debtMicro.toString(), rhea_collateral_units: rhea.collateralUnits.toString(), pool_debt_micro: debt };
    const steps = lines().filter((l) => l.event === "step" && l.pid === stored.pid);
    return {
      ok: rhea.debtMicro > 0n && rhea.collateralUnits > 0n && BigInt(debt) > 0n && ext !== null,
      detail: {
        rhea: { debt_micro: rhea.debtMicro.toString(), collateral_units: rhea.collateralUnits.toString() },
        pool_debt_micro: debt,
        ext,
        keeper_steps: steps.map((l) => ({ at: l.t, i: l.i, k: l.k, ok: l.ok, tx: l.tx })),
        keeper_checks: lines().filter((l) => l.event === "check").map((l) => ({ at: l.t, tx: l.tx, why: l.why })),
        keeper_notes: lines().filter((l) => l.event === "note").map((l) => l.msg),
      },
    };
  });
}

/** The operator sets what this one account pays (the pool's set_pricing), and the pool's record must then say so. */
export async function stepPolicy(g: FundingGate, id: "fee_policy" | "subsidy_policy") {
  const { runner, world: w } = g;
  const [policy, words] = id === "fee_policy" ? [FEE_POLICY, "Rhea's rate plus 5 points"] : [SUBSIDY_POLICY, "Rhea's rate capped at 0, so our pool pays down to Rhea's deposit rate"];
  await runner.run(id, `the operator sets the account's price: ${words}`, {}, async (step) => {
    if (!g.operator.call) throw new Error("OPERATOR_PRIVATE_KEY is empty in .env: the operator sets what the client pays");
    const tx = await g.operator.call(w.ids.pool, "set_pricing", { target: { account: w.account }, pricing: policy }, { tgas: 30, deposit: DEPOSITS.set_pricing, label: `set_pricing (${id})` });
    step.tx(tx);
    if (!tx.ok) throw new Error(`set_pricing failed: ${tx.failure ?? "no reason given"} (tx ${tx.hash})`);
    const stored = await pricing(g);
    return { ok: sameJson(stored.pricing, policy) && stored.from === "account", detail: { policy, stored: stored.pricing, from: stored.from, events: eventsIn(tx.logs).map((e) => e.event) } };
  });
}

/**
 * A settlement that books what the policy in force should: a fee, or a subsidy. Each try is a fresh check (a plain
 * {"check":{}}) and the account's settle(). The pool answers "skipped" when it is too soon after the last
 * settlement, so the step tries again every `settleEveryMs` until the pool's own record for the account shows the
 * sum, or `settleWaitMs` runs out. It goes by that record, not by who called: if the keeper's hourly settlement books
 * it first, that counts.
 *
 * INTERFACES.md 45.3, item 11: the account's `settle()` answers only `true`, so each try's own answer from the pool
 * is read from the transaction's logs: "too soon", or the settlement with its fee, its subsidy and what the pool's
 * 24-hour limits cut from either. The step fails if the settlement that booked the sum was cut (`settleCheck`).
 */
export async function stepSettle(g: FundingGate, id: "settle_fee" | "settle_subsidy") {
  const { runner, world: w } = g;
  const want = id === "settle_fee" ? "fee" : "subsidy";
  await runner.run(id, `a check, then settle(): the pool books a ${want}`, {}, async (step) => {
    const first = await pricing(g);
    const deadline = w.now() + g.options.settleWaitMs;
    const tries: { at: string; tx: string | null; said: string; answer: unknown; pool: PoolSettled | { skipped: string } | null; fees_charged: string; subsidy_paid: string }[] = [];
    for (;;) {
      const n = tries.length + 1;
      // A check asked for while a lender action is under way is refused when it lands: wait that out first.
      await waitOutLender(g);
      await requestCheck(w, step, { check: {} }, `request_check (${id}, try ${n})`);
      const tx = await call(w, step, w.account, "settle", {}, TGAS_ACCOUNT, DEPOSITS.settle, `settle (${id}, try ${n})`);
      const after = await pricing(g);
      const answer = settlementIn(tx.logs);
      const said = settleWords(answer ?? tx.result).words;
      tries.push({ at: iso(w.now()), tx: tx.hash, said, answer: tx.result ?? null, pool: answer, fees_charged: after.fees_charged, subsidy_paid: after.subsidy_paid });
      w.log(`  try ${n}: ${said}`);
      const booked = settledBetween(first, after);
      const got = want === "fee" ? booked.fee : booked.subsidy;
      if (got > 0n) {
        // This try's own settlement, when it is the one that booked the sum: what the pool's limits cut from it.
        const own = answer && !("skipped" in answer) ? answer : null;
        const checked = settleCheck(want, got, own);
        const read = own ? { period_ns: own.period_ns } : { cut_unread: "another settlement than this try's own booked it (the keeper's hourly one), so its cut can't be read here" };
        return {
          ok: checked.ok,
          detail: { [want]: got.toString(), in_words: `${want === "fee" ? "a fee" : "a subsidy"} of ${Number(got) / 1e6} USDC`, cut: checked.cut, ...read, ...(checked.why ? { why: checked.why } : {}), policy: after.pricing, fees_charged: after.fees_charged, subsidy_paid: after.subsidy_paid, credit: after.credit, settled_at: after.settled_at, last: after.last, tries },
        };
      }
      if (w.now() + g.options.settleEveryMs > deadline) {
        return { ok: false, detail: { why: `no ${want} was booked in ${Math.round(g.options.settleWaitMs / 60_000)} minutes; the pool last said: ${said}`, policy: after.pricing, last: after.last, tries } };
      }
      await w.sleep(g.options.settleEveryMs);
    }
  });
}

export async function stepPriceDrop(g: FundingGate) {
  const { runner, world: w } = g;
  await runner.run("price_drop", `${coinWords(w).plain} falls at Rhea: a hold keeps our copy's ${coinWords(w).coin} price under the oracle, to take the cushion to ${showCushion(g.options.aimBp)}`, {}, async () => {
    const ext = rheaExt(await accountState(w));
    if (!ext || ext.d <= 0 || ext.hf_bp <= 0) throw new Error("the held verdict shows no Rhea loan to shake");
    const shift = dropFor(ext.hf_bp, g.options.aimBp);
    const before = await priceGap(g, 0);
    const started = w.now();
    const untilMs = started + Math.min(HOLD_MAX_MS - 60_000, g.options.topUpWaitMs + 10 * 60_000);
    // The keeper's price sync would put a dropped price straight back. So the script doesn't set the price: it sets
    // a hold, and the keeper itself moves the copy's price to the oracle's less the shift and keeps it there.
    // The hold names the token it is for when that isn't bitcoin: a hold with no name is bitcoin's (rhea-price.ts).
    g.hold.set({ shift_bp: shift, until_ms: untilMs, by: `funding:demo for ${w.account}`, ...(coinOf(w) === "BTC" ? {} : { token: collateralOf(w) }) });
    runner.record.context.hold = { shift_bp: shift, started_ms: started, until_ms: untilMs, cushion_before_bp: ext.hf_bp };
    const after = await until(w, `the keeper to set our Rhea copy's ${coinWords(w).coin} price to the hold's level`, KEEPER_WAIT_MS, 5_000, () => priceGap(g, shift), (r) => r.gap_bp <= RHEA_PRICE_BAND_BP);
    const set = g.keeperLog().filter((e) => e.event === "rhea_price" && typeof e.tx === "string" && e.t >= iso(started - 5_000)).at(-1);
    return {
      ok: true,
      detail: { cushion_before_bp: ext.hf_bp, aim_bp: g.options.aimBp, shift_bp: shift, until: iso(untilMs), price_before_usd: before.copy, price_after_usd: after.copy, oracle_usd: after.oracle, keeper_tx: set?.tx ?? null, keeper_said: set?.msg ?? null },
    };
  });
}

/**
 * The script only watches. It passes when, with the price still down: a verdict showed Rhea's cushion under 1.35 with
 * a REBALANCE plan holding a top-up step for Rhea; the keeper's log shows it ran such a step; Rhea's own record shows
 * more collateral or less debt than before; and a later verdict shows the cushion at 1.35 or more.
 */
export async function stepTopUp(g: FundingGate) {
  const { runner, world: w } = g;
  await runner.run("top_up", "the keeper tops Rhea up on its own: a check, a top-up plan, its step, and the cushion is back", { observe: true }, async () => {
    const hold = runner.record.context.hold as { shift_bp: number; started_ms: number } | undefined;
    if (!hold) throw new Error("the record has no price drop: run the price_drop step first");
    const since = iso(hold.started_ms - 5_000);
    const deadline = w.now() + g.options.topUpWaitMs;
    const before = await rheaAccount(g);
    const verdicts: { at: string; blk: number; state: string; action: string; cushion_bp: number | null }[] = [];
    let thin: { blk: number; action: string; cushion_bp: number; steps: unknown[]; top: unknown } | null = null;
    let stepDone: { pid: string; i: number; k: string } | null = null;
    let restored: { blk: number; cushion_bp: number } | null = null;
    let key = "";
    const ran = () => keeperLines(g.keeperLog(), w.account, since, ["step"]).filter((l) => l.ok === true && TOP_UP_KINDS.includes(String(l.k)));
    let now = await rheaAccount(g);
    for (;;) {
      const st = await accountState(w).catch(() => null);
      const held = st?.verdict;
      if (held && `${held.verdict.blk}:${held.received_block}` !== key) {
        key = `${held.verdict.blk}:${held.received_block}`;
        const v = held.verdict;
        const ext = rheaExt(st);
        verdicts.push({ at: iso(w.now()), blk: v.blk, state: v.state, action: v.action, cushion_bp: ext?.hf_bp ?? null });
        w.log(`  a verdict: ${v.state}, action ${v.action}; Rhea's cushion ${ext ? showCushion(ext.hf_bp) : "not shown"}`);
        const topUps = (Array.isArray(v.plan) ? v.plan : []).filter((s) => TOP_UP_KINDS.includes(String((s as { k?: unknown } | null)?.k)) && (s as { l?: unknown }).l === "rhea");
        if (!thin && ext && ext.hf_bp > 0 && ext.hf_bp < ACT_HF_BP && (v.action === "REBALANCE" || v.action === "REBALANCE_NOW") && topUps.length > 0) {
          thin = { blk: v.blk, action: v.action, cushion_bp: ext.hf_bp, steps: topUps, top: v.top ?? null };
        } else if (thin && v.blk > thin.blk && ext && ext.hf_bp >= ACT_HF_BP) {
          restored = { blk: v.blk, cushion_bp: ext.hf_bp };
        }
      }
      const done = readPlan(st)?.steps.find((s) => TOP_UP_KINDS.includes(s.k) && s.done);
      if (!stepDone && done && thin) stepDone = { pid: readPlan(st)!.pid, i: done.i, k: done.k };
      now = await rheaAccount(g).catch(() => now);
      const better = now.collateralUnits > before.collateralUnits || now.debtMicro < before.debtMicro;
      if ((thin && restored && better && ran().length > 0) || w.now() >= deadline) break;
      await w.sleep(5_000);
    }
    const better = now.collateralUnits > before.collateralUnits || now.debtMicro < before.debtMicro;
    const keeperSteps = ran().map((l) => ({ at: l.t, pid: l.pid, i: l.i, k: l.k, tx: l.tx }));
    const price = await priceGap(g, hold.shift_bp).catch(() => null);
    const checks = {
      thin_verdict_with_plan: thin !== null,
      keeper_ran_the_step: keeperSteps.length > 0,
      rhea_position_better: better,
      cushion_back: restored !== null,
      price_still_down: price !== null && price.gap_bp <= RHEA_PRICE_BAND_BP,
    };
    return {
      ok: Object.values(checks).every(Boolean),
      detail: {
        checks,
        thin,
        step_seen_done: stepDone,
        restored,
        rhea_before: { debt_micro: before.debtMicro.toString(), collateral_units: before.collateralUnits.toString() },
        rhea_after: { debt_micro: now.debtMicro.toString(), collateral_units: now.collateralUnits.toString() },
        keeper_steps: keeperSteps,
        keeper_checks: keeperLines(g.keeperLog(), w.account, since, ["check"]).map((l) => ({ at: l.t, tx: l.tx, why: l.why })),
        verdicts,
        price,
      },
    };
  });
}

export async function stepPriceBack(g: FundingGate) {
  const { runner, world: w } = g;
  await runner.run("price_back", `the hold is cleared: the keeper brings our Rhea copy's ${coinWords(w).coin} price back to the oracle's`, {}, async () => {
    g.hold.clear();
    const after = await until(w, `the keeper to bring our Rhea copy's ${coinWords(w).coin} price back to the oracle's`, KEEPER_WAIT_MS, 5_000, () => priceGap(g, 0), (r) => r.gap_bp <= RHEA_PRICE_BAND_BP);
    return { ok: true, detail: { price_usd: after.copy, oracle_usd: after.oracle, gap_bp: after.gap_bp } };
  });
}

export async function stepRepayRhea(g: FundingGate) {
  const { runner, world: w } = g;
  await runner.run("repay_rhea", "the client repays Rhea in full", {}, async (step) => {
    const before = await rheaAccount(g);
    if (before.debtMicro === 0n) return { ok: true, detail: { already: "nothing is owed at Rhea" } };
    // Rhea's debt grows every millisecond, so a hair more than was read goes in. What is over stays at Rhea in the
    // account's name, as a deposit of a few cents, which rhea_withdraw brings back once our pool is repaid too.
    const want = rheaRepayAmount(before.debtMicro);
    const funded = await ensureUsdc(w, step, want);
    await call(w, step, w.account, "lender_repay", { lender: "rhea", amount: want.toString() }, TGAS_ACCOUNT, DEPOSITS.lender_repay, "lender_repay (rhea)");
    const after = await until(w, "Rhea to show nothing owed", 60_000, 3_000, () => rheaAccount(g), (p) => p.debtMicro === 0n);
    w.log(`  Rhea was owed ${usd(before.debtMicro)}; ${usd(want)} went in, and ${usd(after.suppliedMicro)} is left there in the account's name`);
    return { ok: true, detail: { debt_before_micro: before.debtMicro.toString(), sent_micro: want.toString(), ...funded, left_at_rhea_micro: after.suppliedMicro.toString() } };
  });
}

export async function stepCredit(g: FundingGate) {
  const { runner, world: w } = g;
  await runner.run("credit", "the client claims what the pool owes the account, if anything", {}, async (step) => {
    const held = await pricing(g);
    if (BigInt(held.credit) === 0n) return { ok: true, detail: { credit: "0", why: "the pool holds no credit for the account: nothing to claim", fees_charged: held.fees_charged, subsidy_paid: held.subsidy_paid } };
    await call(w, step, w.account, "claim_credit", {}, TGAS_ACCOUNT, DEPOSITS.claim_credit, "claim_credit");
    const after = await until(w, "the credit to be paid out", 30_000, 2_000, () => pricing(g), (p) => BigInt(p.credit) === 0n);
    return { ok: true, detail: { claimed_micro: held.credit, fees_charged: after.fees_charged, subsidy_paid: after.subsidy_paid } };
  });
}

/**
 * Everything the account has at Rhea comes back: the nBTC it posted, then the few cents of USDC the repayment left
 * there. Both are the account's `lender_withdraw`, with 1 yoctoNEAR. With Rhea and our pool both repaid, neither
 * needs a check. The account refuses a withdrawal of collateral while it lists a lender action as under way, so the
 * step waits such a listing out first.
 */
export async function stepRheaWithdraw(g: FundingGate) {
  const { runner, world: w } = g;
  await runner.run("rhea_withdraw", `the client takes the ${coinWords(w).token} back from Rhea, and the USDC the repayment left there`, {}, async (step) => {
    const before = await rheaAccount(g);
    if (before.collateralUnits === 0n && before.suppliedMicro === 0n) return { ok: true, detail: { already: "the account has nothing at Rhea" } };
    if (before.debtMicro > 0n) throw new Error(`Rhea is still owed ${usd(before.debtMicro)}: the repay_rhea step comes first`);
    const poolDebt = BigInt(await w.near.view<string>(w.ids.pool, "debt_of", { account_id: w.account }));
    if (poolDebt > 0n) throw new Error(`our pool is still owed ${usd(poolDebt)}: the repay step comes first, so this withdrawal needs no check`);
    const balance = async (token: string) => BigInt(await w.near.view<string>(token, "ft_balance_of", { account_id: w.account }));
    const waited: number[] = [];
    const takeBack = async (token: string, amount: bigint, what: string, left: (p: RheaPosition) => bigint) => {
      const blockWaited = await waitOutLender(g);
      if (blockWaited !== null) waited.push(blockWaited);
      const held = await balance(token);
      await call(w, step, w.account, "lender_withdraw", { lender: "rhea", token, amount: amount.toString() }, TGAS_ACCOUNT, DEPOSITS.lender_withdraw, `lender_withdraw (rhea, ${what})`);
      // Rhea sends it a block or two after the call returns.
      return until(w, `the ${what} to come back from Rhea`, 90_000, 3_000, async () => ({ rhea: await rheaAccount(g), held: await balance(token) }), (r) => left(r.rhea) === 0n && r.held >= held + amount);
    };
    let nbtc = await balance(collateralOf(w));
    if (before.collateralUnits > 0n) nbtc = (await takeBack(collateralOf(w), before.collateralUnits, coinOf(w) === "ETH" ? "ETH" : "nBTC", (p) => p.collateralUnits)).held;
    // What a repayment above the debt left at Rhea, as the account's plain deposit.
    const deposit = (await rheaAccount(g)).suppliedMicro;
    if (deposit > 0n) await takeBack(w.ids.musdc, deposit, "USDC", (p) => p.suppliedMicro);
    const after = await rheaAccount(g);
    return {
      ok: after.collateralUnits === 0n && after.suppliedMicro === 0n,
      detail: { nbtc_withdrawn_units: before.collateralUnits.toString(), account_holds_nbtc_units: nbtc.toString(), usdc_withdrawn_micro: deposit.toString(), left_at_rhea_micro: after.suppliedMicro.toString(), waited_for_blocks: waited },
    };
  });
}

// ---------- the pause that lifts early (INTERFACES.md 50.2) ----------

const BORROW_AGAIN_INTENT = { borrow: { amount: BORROW_AGAIN_MICRO.toString() } };

/**
 * `pause_lifted`: the transfer home left the account paused (it lends nothing new while that signature could still
 * be posted). On an account that shows `open_sends`, a check that sees the transfer in Hyperliquid's own history
 * ends the pause. The step waits for the history to show it, asks for a check with a borrow intent, so the same
 * result backs `borrow_again`, and passes only when the account then shows `send_open_until_ms` "0" and no open
 * transfer. The engine's read of the history can trail by a moment: one more check after a short wait, and a second
 * miss fails the step.
 *
 * An account made before the deploy shows no `open_sends`: the step is skipped with one line, and passes.
 */
export async function stepPauseLifted(g: LiftGate) {
  const { runner, world: w } = g;
  await runner.run("pause_lifted", "a check that sees the transfer home in Hyperliquid's history lifts the pause on borrowing", {}, async (step) => {
    const before = await state(w);
    const hl = before.hl ?? null;
    if (!showsOpenSends(hl)) {
      if (g.mustLift) return { ok: false, detail: { why: needsLiftWords(w.account), send_open_until_ms: hl?.send_open_until_ms ?? null } };
      w.log(`  ${olderAccountWords(w.account)}`);
      return { ok: true, detail: { skipped: olderAccountWords(w.account), send_open_until_ms: hl?.send_open_until_ms ?? null } };
    }
    const open = [...hl.open_sends];
    // Run again after it passed (a resume): the pause is off and the result it brought still backs a borrow.
    if (pauseLifted(hl) && heldBacksBorrow(before.verdict, before.counter, await g.finalBlock()).ok) {
      return { ok: true, detail: { already: "the pause is off, and the check result the account holds still backs a borrow: no check was asked for", send_open_until_ms: hl.send_open_until_ms, open_sends: open } };
    }

    // Hyperliquid's own history first: a check asked for before it shows the transfer would lift nothing.
    let ledger: { shown: string[]; waited_s: number } | null = null;
    const address = hl.address;
    if (open.length > 0 && address) {
      const started = w.now();
      const read = async () => sendsInLedger(await w.hl.info<unknown>({ type: "userNonFundingLedgerUpdates", user: address, startTime: ledgerFrom(open) }), address, open);
      const shown = await until(w, `Hyperliquid's history to show the transfer(s) ${open.join(", ")} as sent`, LEDGER_WAIT_MS, LEDGER_EVERY_MS, read, (seen) => seen.length === open.length, (seen) => `it showed ${seen.length} of ${open.length}`).catch((error: unknown) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}. No check was asked for: run from pause_lifted again once the transfer shows`);
      });
      ledger = { shown, waited_s: Math.round((w.now() - started) / 1000) };
    }

    const checks: { verdict: Record<string, unknown>; send_open_until_ms: string | null; open_sends: string[] | null }[] = [];
    let after = hl as typeof before.hl;
    for (let n = 1; n <= PAUSE_CHECKS; n++) {
      if (n > 1) {
        w.log(`  the check left the pause on (the engine's read of Hyperliquid's history can trail): one more check in ${PAUSE_RETRY_WAIT_MS / 1000} s`);
        await w.sleep(PAUSE_RETRY_WAIT_MS);
      }
      const v = await requestCheck(w, step, BORROW_AGAIN_INTENT, n === 1 ? "request_check (borrow): the check that lifts the pause" : "request_check (borrow), once more");
      after = (await state(w)).hl ?? null;
      checks.push({ verdict: { ...verdictSummary(v), sent: v.sent ?? null }, send_open_until_ms: after?.send_open_until_ms ?? null, open_sends: after?.open_sends ?? null });
      if (pauseLifted(after)) {
        runner.record.context.pause_lifted = { blk: v.blk ?? null, checks: n, open_before: open, sent: v.sent ?? null };
        return { ok: true, detail: { open_before: open, send_open_until_ms_before: hl.send_open_until_ms ?? null, ledger, checks, send_open_until_ms: after!.send_open_until_ms, open_sends: after!.open_sends } };
      }
    }
    return { ok: false, detail: { why: pauseStaysWords(after, PAUSE_CHECKS), open_before: open, ledger, checks } };
  });
}

/** When the `home` step ended, from the record: for saying how soon after it the second loan came. */
function homeEndedMs(steps: { id: string; started_utc: string; seconds: number }[]): number | null {
  const home = steps.find((s) => s.id === "home");
  const started = home ? Date.parse(home.started_utc) : Number.NaN;
  return home && Number.isFinite(started) ? started + home.seconds * 1000 : null;
}

/**
 * `borrow_again`: the owner's `borrow` from our pool, minutes after the USDC came home, on the check result that
 * lifted the pause. Another check is asked for only when that result can't back a borrow any more (used, replaced,
 * or its 120 blocks ran out). The amount is $50, or what the result allows if that is less; a result that allows
 * nothing fails the step with what it said. The loan must arrive in the account.
 */
export async function stepBorrowAgain(g: LiftGate) {
  const { runner, world: w } = g;
  await runner.run("borrow_again", `borrow again from our pool on the check that lifted the pause: ${usd(BORROW_AGAIN_MICRO)}, or what it allows if less`, {}, async (step) => {
    let st = await state(w);
    if (!showsOpenSends(st.hl)) return g.mustLift ? { ok: false, detail: { why: needsLiftWords(w.account) } } : { ok: true, detail: { skipped: olderAccountWords(w.account) } };
    if (!pauseLifted(st.hl)) {
      return { ok: false, detail: { why: `the pause on borrowing is still on for ${w.account}: run from pause_lifted first`, send_open_until_ms: st.hl.send_open_until_ms ?? null, open_sends: st.hl.open_sends } };
    }
    let checksHere = 0;
    const usable = heldBacksBorrow(st.verdict, st.counter, await g.finalBlock());
    if (!usable.ok) {
      w.log(`  ${usable.why}: one more check`);
      await requestCheck(w, step, BORROW_AGAIN_INTENT, "request_check (borrow)");
      checksHere = 1;
      st = await state(w);
    }
    const v = st.verdict!.verdict;
    const sized = borrowAgainAmount(v);
    if ("problem" in sized) return { ok: false, detail: { why: sized.problem, verdict: verdictSummary(v), checks_asked_here: checksHere } };
    const amount = sized.amount;
    const balances = async () => ({
      held: BigInt(await w.near.view<string>(w.ids.musdc, "ft_balance_of", { account_id: w.account })),
      debt: BigInt(await w.near.view<string>(w.ids.pool, "debt_of", { account_id: w.account })),
    });
    const was = await balances();
    const lent = await call(w, step, w.account, "borrow", { amount: amount.toString() }, TGAS_ACCOUNT, 1n, "borrow");
    // borrow returns on_borrowed's answer: false when the pool's own limits refused it (its log says which).
    if (lent.result === false) return { ok: false, detail: { why: "the pool refused the borrow", amount: amount.toString(), verdict: verdictSummary(v), logs: lent.logs } };
    const now = await until(w, `the loan of ${usd(amount)} to arrive in ${w.account}`, 30_000, 2_000, balances, (b) => b.held >= was.held + amount && b.debt > was.debt, (b) => `the account held ${b.held} micro-USDC (${was.held} before) and owed the pool ${b.debt} (${was.debt} before)`);
    const homeEnded = homeEndedMs(runner.record.steps);
    runner.record.context.borrowed_again = amount.toString();
    return {
      ok: true,
      detail: {
        borrowed: amount.toString(),
        asked: BORROW_AGAIN_MICRO.toString(),
        allowed: String((v.allow as { borrow?: unknown } | undefined)?.borrow ?? null),
        checks_asked_here: checksHere,
        verdict: verdictSummary(v),
        usdc_before: was.held.toString(),
        usdc_after: now.held.toString(),
        debt_after: now.debt.toString(),
        seconds_since_home: homeEnded === null ? null : Math.round((w.now() - homeEnded) / 1000),
      },
    };
  });
}

/** `repay_again`: the second loan repaid in full; the loan must be closed. Skipped with the other two on an older account. */
export async function stepRepayAgain(g: LiftGate) {
  const { runner, world: w } = g;
  await runner.run("repay_again", "repay the second loan, all of it", {}, async (step) => {
    if (!showsOpenSends((await state(w)).hl)) return g.mustLift ? { ok: false, detail: { why: needsLiftWords(w.account) } } : { ok: true, detail: { skipped: olderAccountWords(w.account) } };
    return repayAll(w, step);
  });
}

/** The gate's own steps, by id. The others are hedge-steps' STEPS. */
export const FUNDING_STEPS: Record<string, (g: FundingGate) => Promise<void>> = {
  keeper: stepKeeperUp,
  order: stepOrder,
  fund: stepFund,
  order_back: stepOrderBack,
  funded: stepFunded,
  fee_policy: (g) => stepPolicy(g, "fee_policy"),
  settle_fee: (g) => stepSettle(g, "settle_fee"),
  subsidy_policy: (g) => stepPolicy(g, "subsidy_policy"),
  settle_subsidy: (g) => stepSettle(g, "settle_subsidy"),
  price_drop: stepPriceDrop,
  top_up: stepTopUp,
  price_back: stepPriceBack,
  repay_rhea: stepRepayRhea,
  credit: stepCredit,
  rhea_withdraw: stepRheaWithdraw,
  pause_lifted: stepPauseLifted,
  borrow_again: stepBorrowAgain,
  repay_again: stepRepayAgain,
};
