// The moves gate's steps (FUNDING.md 10, gate 4; INTERFACES.md 36), each against the world the other gates use. The
// client starts every move: a quote from the backend (POST /api/quote with move "to_evm" or "e_home"), the check the
// quote names while our pool is owed, then the account's own call. The stand-in delivers. The gate signs for the
// client only; the keeper, which must be running, runs the funding plan and sends the signed transactions too.
//
// Three rules from gate 3's live runs are built in. A step first looks at what the account already has, so a run that
// is resumed asks for nothing twice. Every wait says what it waited for and what it last saw. And a check that brings
// no verdict (Aave's chain unreadable means no verdict at all) is waited out and asked again, with each reason kept
// in the record.
import { isTerminal, type SwapStatus } from "@pb/oneclick";

import { MIN_GAS_WEI, REPAY_SPARE_UNITS, type Collateral } from "./aave-kit.js";
import { aaveDebt, accountState, amountOf, evmSide, gasHelper, sendAndWait, settingsOf, stepAaveWithdraw, stepFundAave, stepFundedAave, stepKeeperWatches, stepRepayAave, type AaveGate } from "./aave-steps.js";
import type { Runner, StepContext } from "./hedge-kit.js";
import { call, coinOf, collateralOf, requestCheck, STEPS, until, verdictSummary, type World } from "./hedge-steps.js";
import { btcOutUnits, ETH_MOVE_UNITS, fitsOneMove, FLOAT_SPEND_LIMIT_WEI, PROBE_NBTC_UNITS, usdcBackUnits, verdictSpent } from "./moves-kit.js";
import { ONE_YOCTO, TGAS_ACCOUNT } from "./near-tx.js";
import { pendingTransfers, readFunding, type PendingTransfer } from "./plan.js";

/** How long the gate waits for the stand-in to see a deposit and deliver: the quote's own lifetime. */
const MOVE_WAIT_MS = 600_000;
/** How long it waits for money to show at the address on Aave's chain, or for the float's test ETH to come back. */
const SHOW_WAIT_MS = 120_000;
/** A check that brings no verdict is asked again a minute later, this many times in all. */
const CHECK_TRIES = 3;
const CHECK_AGAIN_MS = 60_000;
/** A check, then the call it backs: again when the account says the verdict can't back the call any more. */
const CALL_TRIES = 3;
/** The checks that settle a move to Aave's chain: the engine's read of the address may be a block behind. */
const ARRIVED_TRIES = 4;
/** The test tokens' storage_balance_bounds().min, as the other gates send with a mint. */
const STORAGE = 1_250_000_000_000_000_000_000n;
const WBTC_WORDS = "the 0.015 nBTC a WBTC move sends";

const iso = (ms: number) => new Date(ms).toISOString();
const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
const balanceOn = (w: World, token: string, holder = w.account) => w.near.view<string>(token, "ft_balance_of", { account_id: holder }).then(BigInt);

/** Every check that brought no verdict is kept in the record, whatever becomes of its step. */
function noteFailedCheck(runner: Runner, w: World, check: string, why: string) {
  const kept = (runner.record.context.checks_that_failed as unknown[] | undefined) ?? [];
  runner.record.context.checks_that_failed = [...kept, { at: iso(w.now()), check, why }];
}

/** A check, asked again a minute later when it brings no verdict or the account doesn't keep it. */
async function checkAgain({ runner, world: w }: AaveGate, step: StepContext, intent: Record<string, unknown>, label: string) {
  const reasons: string[] = [];
  for (let n = 1; ; n += 1) {
    try {
      return await requestCheck(w, step, intent, n === 1 ? label : `${label}, try ${n}`);
    } catch (error) {
      reasons.push(text(error));
      noteFailedCheck(runner, w, label, text(error));
      if (n >= CHECK_TRIES) throw new Error(`${label} brought no verdict in ${n} tries: ${reasons.map((r, i) => `(${i + 1}) ${r}`).join("; ")}`);
      w.log(`  ${label} brought no verdict (${text(error)}): waiting a minute, then asking again`);
      await w.sleep(CHECK_AGAIN_MS);
    }
  }
}

/** POST /api/quote's answer for a move (services/api/src/hl-handlers.ts, postEvmMoveQuote). */
interface MoveQuote {
  quote: { depositAddress?: string; depositMemo?: string | null; amountIn: string; amountOut: string };
  shim?: { symbol: string; why: string };
  move: {
    next: { method: string; args: Record<string, unknown> } | null;
    delivers: { token: string; symbol: string; chain: string; amount: string };
    needs_check: Record<string, unknown> | null;
    transfer_id: string | null;
    exp_ms: number | null;
  };
}

interface MoveAsk {
  move: "to_evm" | "e_home";
  token: string;
  amount: string;
  /** INTERFACES.md 51.2, `e_home` of a collateral token: the NEAR token it comes home as. Left out: bitcoin. */
  to?: string;
}

async function quoteMove(w: World, body: MoveAsk & { dry: boolean }): Promise<MoveQuote> {
  const answer = await w.api.post("/api/quote", { account: w.account, ...body });
  // A quote the stand-in's float couldn't fill is refused here, in its words, before anything is signed.
  if (answer.status !== 200 && answer.status !== 201) throw new Error(`the quote was refused (HTTP ${answer.status}): ${String((answer.body as { message?: unknown } | null)?.message ?? "no reason given")}`);
  return answer.body as MoveQuote;
}

interface StandIn {
  status: SwapStatus;
  reason: string | null;
  hashes: string[];
}

/** The stand-in's status for a deposit address (and memo, where quotes share the float's address), through the backend. */
async function standIn(w: World, depositAddress: string, memo?: string | null): Promise<StandIn> {
  const query = `depositAddress=${encodeURIComponent(depositAddress)}${memo ? `&depositMemo=${encodeURIComponent(memo)}` : ""}`;
  const { status, body } = await w.api.get(`/api/status?${query}`);
  if (status !== 200) throw new Error(`GET /api/status answered HTTP ${status}: ${String((body as { message?: unknown } | null)?.message ?? "")}`);
  const b = body as { status: SwapStatus; swapDetails?: { refundReason?: string; destinationChainTxHashes?: { hash: string }[] } };
  return { status: b.status, reason: b.swapDetails?.refundReason ?? null, hashes: (b.swapDetails?.destinationChainTxHashes ?? []).map((h) => h.hash) };
}

/** Waits until the stand-in has ended the move, and stops the step unless it delivered. */
async function delivered(w: World, what: string, depositAddress: string, memo?: string | null) {
  const statuses: string[] = [];
  const done = await until(
    w,
    `the stand-in to deliver ${what}`,
    MOVE_WAIT_MS,
    5_000,
    async () => {
      const now = await standIn(w, depositAddress, memo);
      if (statuses.at(-1) !== now.status) statuses.push(now.status);
      return now;
    },
    (s) => isTerminal(s.status),
    (s) => `its status was ${s.status}`,
  );
  if (done.status !== "SUCCESS") throw new Error(`the stand-in ended ${what} as ${done.status}${done.reason ? `: ${done.reason}` : ""}`);
  return { statuses, delivery: done.hashes };
}

const pendingMoves = async (w: World, kind: "to_evm" | "e_home"): Promise<PendingTransfer[]> => pendingTransfers((await accountState(w)).pending).filter((t) => t.kind === kind);
const movesOf = (runner: Runner) => (runner.record.context.moves as Record<string, { transfer_id: string | null; deposit_address: string; deposit_memo: string | null }> | undefined) ?? {};

/**
 * One move, from its quote to the stand-in's delivery:
 *   - a price first: a quote the float couldn't fill is refused there, before a check is paid for;
 *   - test ETH for gas, if the move leaves Aave's chain and the address is short;
 *   - while our pool is owed, the check the quote names, and the verdict must allow the move;
 *   - a committed quote, kept in the record before anything is signed;
 *   - the account's call. If the account says the verdict can't back it (the check itself moved the counter on, by
 *     showing a transaction on Aave's chain mined), a new check and the call again;
 *   - for a move home, the signed transfer sent and mined;
 *   - the stand-in's SUCCESS.
 */
async function runMove(g: AaveGate, step: StepContext, id: string, ask: MoveAsk) {
  const { runner, world: w } = g;
  const priced = await quoteMove(w, { dry: true, ...ask });
  let needs = priced.move.needs_check;
  if (ask.move === "e_home" && BigInt((await evmSide(w)).eth ?? "0") < MIN_GAS_WEI) await gasHelper(w, {});
  const check = async () => {
    const v = await checkAgain(g, step, needs!, `request_check (${id})`);
    // In the answer to a withdrawal, allow.withdraw is the amount asked if the engine allows it, and 0 if not.
    const allowed = Number((v.allow as { withdraw?: unknown } | undefined)?.withdraw ?? 0);
    if (v.ok !== true || v.state !== "HEALTHY" || !(allowed > 0)) {
      throw new Error(`the check doesn't allow ${id} now: ${String(v.reason ?? `the account is ${String(v.state)}, and the verdict allows no withdrawal`)}. While our pool is owed, a move needs room on the credit line`);
    }
    return verdictSummary(v);
  };
  let verdict = needs ? await check() : null;

  const answer = await quoteMove(w, { dry: false, ...ask });
  const depositAddress = answer.quote.depositAddress;
  if (!answer.move.next || !depositAddress) throw new Error("the committed quote came without a deposit address or the account's next call");
  const saved = { transfer_id: answer.move.transfer_id, deposit_address: depositAddress, deposit_memo: answer.quote.depositMemo ?? null, sends: { token: ask.token, amount: answer.quote.amountIn }, delivers: answer.move.delivers, note: answer.shim?.why ?? null, exp_ms: answer.move.exp_ms };
  runner.record.context.moves = { ...movesOf(runner), [id]: saved };

  const nonceBefore = ask.move === "e_home" ? ((await evmSide(w)).nonce ?? 0) : 0;
  const { method, args } = answer.move.next;
  const checkedAgain: string[] = [];
  for (let n = 1; ; n += 1) {
    try {
      const tx = await call(w, step, w.account, method, args, TGAS_ACCOUNT, ONE_YOCTO, n === 1 ? `${method} (${id})` : `${method} (${id}, try ${n})`);
      // A call that goes through can still move nothing: the tokens didn't leave (withdraw then answers false), or
      // the signer signed nothing. The account drops the move again and logs "transfer move:n didn't go out".
      const dropped = tx.logs.find((line) => line.includes("didn't go out")) ?? (ask.move === "to_evm" && tx.result === false ? `${method} answered false` : null);
      if (dropped) throw new Error(`the move didn't go out, and the account dropped it again: ${dropped} (tx ${tx.hash})`);
      break;
    } catch (error) {
      if (n >= CALL_TRIES || !verdictSpent(text(error))) throw error;
      // The first quote can read the account a block before a loan shows in it: the pool's part of a funding plan
      // is in the pool's books one hop before the account's own record (seen on 12 Nov, right after `funded`). The
      // quote is asked again what check the move needs now.
      if (!needs) needs = (await quoteMove(w, { dry: true, ...ask })).move.needs_check;
      if (!needs) throw error;
      checkedAgain.push(text(error));
      w.log(`  the account wants a new check before ${method} (${text(error)}): asking for one`);
      verdict = await check();
    }
  }
  const transfer = ask.move === "e_home" ? await sendAndWait(w, nonceBefore, "transfer") : null;
  const stand_in = await delivered(w, `${id} (${saved.transfer_id ?? "no transfer id"})`, depositAddress, saved.deposit_memo);
  return { ...saved, needed_check: needs, verdict, ...(checkedAgain.length ? { checked_again_because: checkedAgain } : {}), ...(transfer ? { transfer } : {}), stand_in };
}

// ---------- setup ----------

export async function stepDepositNbtc({ runner, plan, world: w }: AaveGate) {
  // INTERFACES.md 51.2: the gate's collateral token is test nBTC, or test ETH with --coin ETH.
  const [token, name] = [collateralOf(w), coinOf(w) === "ETH" ? "test ETH" : "test nBTC"];
  await runner.run("deposit", `mint and deposit the ${name}`, {}, async (step) => {
    const want = BigInt(plan.deposit_nbtc_units);
    // A run that is resumed may hold a part already: only what is missing is minted and deposited.
    const before = await balanceOn(w, token);
    const amount = (want > before ? want - before : 0n).toString();
    if (amount !== "0") {
      await call(w, step, token, "mint", { account_id: w.owner, amount }, 30, STORAGE, `mint ${name}`);
      await call(w, step, token, "ft_transfer_call", { receiver_id: w.account, amount, msg: "" }, 100, ONE_YOCTO, `deposit ${name}`);
    }
    const balance = await balanceOn(w, token);
    return { ok: balance >= want, detail: { mnbtc: balance.toString(), held_before: before.toString(), added: amount } };
  });
}

// ---------- the gate ----------

/** GET /api/evm/gas: the gas wallet, which is the stand-in's float on Base Sepolia. */
async function floatNow(w: World): Promise<{ gas_wallet: string | null; balance: string | null }> {
  const { status, body } = await w.api.get("/api/evm/gas");
  if (status !== 200) throw new Error(`GET /api/evm/gas answered HTTP ${status}`);
  return body as { gas_wallet: string | null; balance: string | null };
}

export async function stepGas({ runner, world: w }: AaveGate) {
  await runner.run("gas", "test ETH for gas reaches the account's address on Aave's chain; the float's own test ETH is noted", {}, async () => {
    const float = await floatNow(w);
    // What the float held before the run, kept from the first time this step runs.
    const kept = runner.record.context.float as { eth_before?: string | null } | undefined;
    if (!kept?.eth_before) runner.record.context.float = { gas_wallet: float.gas_wallet, eth_before: float.balance };
    const before = await evmSide(w);
    const helped = BigInt(before.eth ?? "0") >= MIN_GAS_WEI ? null : await gasHelper(w, {});
    const after = await until(w, `test ETH to show at ${before.address}`, SHOW_WAIT_MS, 3_000, () => evmSide(w), (evm) => BigInt(evm.eth ?? "0") >= MIN_GAS_WEI, (evm) => `${evm.eth ?? "0"} wei there`);
    return { ok: true, detail: { address: before.address, eth_wei: after.eth, helper: helped ?? "the address had enough already", float_before: runner.record.context.float } };
  });
}

export async function stepBtcOut(g: AaveGate) {
  const { runner, world: w } = g;
  const ether = coinOf(w) === "ETH";
  await runner.run("btc_out", `the account's ${ether ? "test ETH" : "nBTC"} moves to its address on Aave's chain through the stand-in`, {}, async (step) => {
    const [aave, evm, waiting] = await Promise.all([settingsOf(w), evmSide(w), pendingMoves(w, "to_evm")]);
    const all = (e: typeof evm, token: string) => amountOf(e.wallet, token) + amountOf(e.posted, token);
    const gasWallet = (await floatNow(w)).gas_wallet;
    const record = (token: (typeof aave.collateral)[number], amount: bigint, address: string, why: string): Collateral & { gas_wallet: string | null; address: string } => ({ symbol: token.symbol, token: token.address, decimals: token.decimals, amount: amount.toString(), how: "move", why, gas_wallet: gasWallet, address });

    // A run that is resumed: the collateral is at the address already, or its move is still under way.
    const there = aave.collateral.find((t) => all(evm, t.address) > 0n);
    if (there && waiting.length === 0) {
      if (!runner.record.context.collateral) runner.record.context.collateral = record(there, all(evm, there.address), evm.address, "found at the address when the run went on");
      return { ok: true, detail: { already: `the address holds ${there.symbol} already`, collateral: runner.record.context.collateral } };
    }
    let moved: Record<string, unknown>;
    if (waiting.length > 0) {
      const t = waiting[0]!;
      moved = { resumed: t.id, stand_in: await delivered(w, `the move ${t.id} that was under way`, t.dep) };
    } else if (ether) {
      // INTERFACES.md 51.2: ether arrives as WETH whatever room Aave has, so there is nothing to probe. 0.02 ETH is
      // the most one move brings; if the stand-in says it is too much today, its refusal names what fits.
      let amount = ETH_MOVE_UNITS;
      let sized = "0.02 test ETH, the most the stand-in brings in one move";
      const whole = await quoteMove(w, { dry: true, move: "to_evm", token: collateralOf(w), amount: amount.toString() }).then(() => null, (error: unknown) => text(error));
      if (whole !== null) {
        const fits = fitsOneMove(whole);
        if (fits === null || fits <= 0n) throw new Error(whole);
        amount = fits;
        sized = `the stand-in takes less than 0.02 test ETH today: ${whole}`;
      }
      moved = { sized, ...(await runMove(g, step, "btc_out", { move: "to_evm", token: collateralOf(w), amount: amount.toString() })) };
    } else {
      // A small probe says what the bitcoin would arrive as: WETH while Aave's WBTC cap is full, WBTC otherwise.
      const probe = await quoteMove(w, { dry: true, move: "to_evm", token: w.ids.mnbtc, amount: PROBE_NBTC_UNITS.toString() });
      let amount = btcOutUnits(probe.move.delivers);
      let sized = `as the probe would arrive: ${probe.move.delivers.symbol}`;
      if (probe.move.delivers.symbol !== "WETH") {
        // Aave may have room for the probe's WBTC and not for the whole move's: that would then arrive as WETH, and
        // far more of it than one move brings. The stand-in's refusal says how much nBTC fits.
        const whole = await quoteMove(w, { dry: true, move: "to_evm", token: w.ids.mnbtc, amount: amount.toString() }).then((q) => q.move.delivers, (error: unknown) => text(error));
        if (typeof whole === "string") {
          const fits = fitsOneMove(whole);
          if (fits === null || fits <= 0n) throw new Error(whole);
          amount = fits;
          sized = `Aave has room for the probe's WBTC and not for ${WBTC_WORDS}: ${whole}`;
        } else if (whole.symbol === "WETH") {
          amount = btcOutUnits(whole, amount);
          sized = `Aave has room for the probe's WBTC and not for ${WBTC_WORDS}, which would arrive as WETH`;
        }
      }
      moved = { probe: { sends: PROBE_NBTC_UNITS.toString(), delivers: probe.move.delivers, note: probe.shim?.why ?? null }, sized, ...(await runMove(g, step, "btc_out", { move: "to_evm", token: w.ids.mnbtc, amount: amount.toString() })) };
    }
    const holds = (e: typeof evm) => e.wallet.filter((t) => t.amount !== "0").map((t) => `${t.amount} ${t.symbol}`).join(", ") || "no tokens";
    const after = await until(w, "the collateral to show at the address", SHOW_WAIT_MS, 3_000, () => evmSide(w), (e) => aave.collateral.some((t) => amountOf(e.wallet, t.address) > 0n), (e) => `the address holds ${holds(e)}`);
    const token = aave.collateral.find((t) => amountOf(after.wallet, t.address) > 0n)!;
    const note = (moved as { note?: string | null }).note;
    const collateral = record(token, amountOf(after.wallet, token.address), after.address, note ?? `the stand-in delivered the ${ether ? "ether" : "bitcoin"} as ${token.symbol}`);
    runner.record.context.collateral = collateral;
    return { ok: true, detail: { collateral, move: moved, at_the_address: after.wallet } };
  });
}

/** A check whose verdict's `arrived` settles a move to Aave's chain: the account can't see that chain itself. */
export async function stepArrived(g: AaveGate, id: "arrived" | "usdc_arrived") {
  const { runner, world: w } = g;
  await runner.run(id, "a check: its verdict sees the money at the address and settles the move", {}, async (step) => {
    const before = await pendingMoves(w, "to_evm");
    if (before.length === 0) return { ok: true, detail: { already: "the account lists no move to Aave's chain: it is settled (the keeper asks for this check too)" } };
    const verdicts: unknown[] = [];
    const failed: string[] = [];
    for (let n = 1; n <= ARRIVED_TRIES; n += 1) {
      const label = n === 1 ? `request_check (${id})` : `request_check (${id}, try ${n})`;
      try {
        const v = await requestCheck(w, step, { check: {} }, label);
        verdicts.push({ ...verdictSummary(v), arrived: (v as { arrived?: unknown }).arrived ?? [] });
      } catch (error) {
        // No verdict at all (Aave's chain unreadable), or the keeper's own check landed first: written down, and asked again.
        failed.push(text(error));
        noteFailedCheck(runner, w, label, text(error));
      }
      const left = await pendingMoves(w, "to_evm");
      if (left.length === 0) return { ok: true, detail: { settled: before.map((t) => t.id), checks: n, verdicts, checks_that_failed: failed } };
      if (n < ARRIVED_TRIES) {
        w.log(`  the account still lists ${left.map((t) => t.id).join(", ")}: waiting a minute, then asking for another check`);
        await w.sleep(CHECK_AGAIN_MS);
      }
    }
    const left = await pendingMoves(w, "to_evm");
    return { ok: false, detail: { why: `after ${ARRIVED_TRIES} checks the account still lists ${left.map((t) => `${t.id} (${t.amount} of ${t.token})`).join(", ")}: no verdict's arrived named it`, verdicts, checks_that_failed: failed } };
  });
}

/** The gate's one `fund`. A run that is resumed with the plan stored, or the loan made, signs no second one. */
export async function stepFundMoves(g: AaveGate) {
  const { runner, world: w } = g;
  const state = await accountState(w);
  const plan = readFunding(state);
  const owed = aaveDebt(state)?.d ?? 0;
  if ((plan && plan.steps.length > 0) || owed > 0) {
    await runner.run("fund", "the client's one fund(amount)", {}, async () => {
      if (!runner.record.context.funding) return { ok: false, detail: { why: `${w.account} has a funding plan or an Aave loan already, and the record doesn't say which fund made it: this gate goes on only with its own record` } };
      return { ok: true, detail: { already: plan && plan.steps.length > 0 ? `the funding plan ${plan.pid} is stored` : `Aave is owed $${(owed / 1e6).toFixed(2)}`, funding: runner.record.context.funding } };
    });
    return;
  }
  await stepFundAave(g);
}

export async function stepLoanHome(g: AaveGate) {
  const { runner, world: w } = g;
  await runner.run("loan_home", "the borrowed USDC comes home: from the address on Aave's chain to the account on NEAR", {}, async (step) => {
    const [aave, evm, waiting, nearNow] = await Promise.all([settingsOf(w), evmSide(w), pendingMoves(w, "e_home"), balanceOn(w, w.ids.musdc)]);
    const there = amountOf(evm.wallet, aave.usdc.address);
    const kept = runner.record.context.loan_home as { usdc_before?: string } | undefined;
    if (there === 0n && waiting.length === 0) {
      // Nothing to bring: right only if this run's own move brought it (its quote is in the record).
      if (!movesOf(runner).loan_home) return { ok: false, detail: { why: "the address holds no USDC to bring home, and the record shows no move home: did the funded step end with an Aave loan?", at_the_address: evm.wallet } };
      return { ok: true, detail: { already: "the address holds no USDC and no move home is under way: the loan is in the account", musdc: nearNow.toString() } };
    }
    // What the account held on NEAR before the move, kept so a run that goes on measures from the same place.
    const nearBefore = kept?.usdc_before !== undefined ? BigInt(kept.usdc_before) : nearNow;
    runner.record.context.loan_home = { usdc_before: nearBefore.toString() };
    // A move that was under way when the run stopped is not asked for again: its signed transfer is sent if the
    // chain hasn't mined it yet (the keeper sends it too), and the delivery is waited for.
    const moved = waiting.length > 0 ? { resumed: waiting[0]!.id, transfer: await sendAndWait(w, 0, "transfer") } : await runMove(g, step, "loan_home", { move: "e_home", token: aave.usdc.address, amount: there.toString() });
    const settled = await until(
      w,
      "the USDC to show in the account on NEAR and the move to be settled",
      MOVE_WAIT_MS,
      5_000,
      async () => ({ musdc: await balanceOn(w, w.ids.musdc), pending: await pendingMoves(w, "e_home") }),
      (s) => s.musdc > nearBefore && s.pending.length === 0,
      (s) => `the account holds ${s.musdc} units of USDC (${nearBefore} before) and lists ${s.pending.length} move(s) home`,
    );
    runner.record.context.loan_home = { usdc_before: nearBefore.toString(), usdc_after: settled.musdc.toString() };
    return { ok: true, detail: { sent_from_the_address: there.toString(), arrived_micro: (settled.musdc - nearBefore).toString(), musdc: settled.musdc.toString(), move: moved } };
  });
}

// ---------- leaving ----------

export async function stepUsdcOut(g: AaveGate) {
  const { runner, world: w } = g;
  await runner.run("usdc_out", "USDC goes back to the address on Aave's chain, to repay Aave with", {}, async (step) => {
    const [aave, evm, waiting, state] = await Promise.all([settingsOf(w), evmSide(w), pendingMoves(w, "to_evm"), accountState(w)]);
    const owed = BigInt(Math.trunc(aaveDebt(state)?.d ?? 0));
    const there = amountOf(evm.wallet, aave.usdc.address);
    if (owed === 0n) return { ok: true, detail: { already: "the held verdict shows nothing owed to Aave" } };
    if (there >= owed + REPAY_SPARE_UNITS && waiting.length === 0) return { ok: true, detail: { already: `the address holds ${there} units of USDC, enough to repay the ${owed} owed` } };
    let moved: Record<string, unknown>;
    let added = 0n;
    if (waiting.length > 0) {
      const t = waiting[0]!;
      moved = { resumed: t.id, stand_in: await delivered(w, `the move ${t.id} that was under way`, t.dep) };
    } else {
      const amount = usdcBackUnits(owed) - there;
      // The account holds what it borrowed, less what the way home cost. If that is short of what goes back, the
      // client adds the difference from its own pocket: here, the test token's faucet.
      const held = await balanceOn(w, w.ids.musdc);
      if (held < amount) {
        added = amount - held;
        const ownerHas = await balanceOn(w, w.ids.musdc, w.owner);
        if (ownerHas < added) await call(w, step, w.ids.musdc, "mint", { account_id: w.owner, amount: (added - ownerHas).toString() }, 30, STORAGE, "mint test USDC for the routes' cost");
        await call(w, step, w.ids.musdc, "ft_transfer_call", { receiver_id: w.account, amount: added.toString(), msg: "" }, 100, ONE_YOCTO, "deposit test USDC for the routes' cost");
      }
      moved = await runMove(g, step, "usdc_out", { move: "to_evm", token: w.ids.musdc, amount: amount.toString() });
    }
    const after = await until(w, "the USDC to show at the address", SHOW_WAIT_MS, 3_000, () => evmSide(w), (e) => amountOf(e.wallet, aave.usdc.address) >= owed, (e) => `the address holds ${amountOf(e.wallet, aave.usdc.address)} units of USDC, and ${owed} are owed`);
    return { ok: true, detail: { owed_micro: owed.toString(), added_by_the_client_micro: added.toString(), at_the_address: amountOf(after.wallet, aave.usdc.address).toString(), move: moved } };
  });
}

export async function stepBtcHome(g: AaveGate) {
  const { runner, world: w } = g;
  // INTERFACES.md 51.2: with --coin ETH the WETH comes home as test ETH (the quote's `to`); else as nBTC, as before.
  const ether = coinOf(w) === "ETH";
  const [homeToken, homeName] = [collateralOf(w), ether ? "test ETH" : "nBTC"];
  await runner.run("btc_home", `the collateral comes home: from the address on Aave's chain to the account on NEAR, as ${homeName}`, {}, async (step) => {
    const [aave, evm, waiting, nearNow] = await Promise.all([settingsOf(w), evmSide(w), pendingMoves(w, "e_home"), balanceOn(w, homeToken)]);
    const held = aave.collateral.filter((t) => amountOf(evm.wallet, t.address) > 0n);
    const kept = runner.record.context.btc_home as { nbtc_before?: string } | undefined;
    if (held.length === 0 && waiting.length === 0) {
      if (!Object.keys(movesOf(runner)).some((k) => k.startsWith("btc_home"))) return { ok: false, detail: { why: "the address holds no collateral to bring home, and the record shows no move home: did the aave_withdraw step take it back from Aave?", at_the_address: evm.wallet, still_posted: evm.posted } };
      return { ok: true, detail: { already: "the address holds no collateral and no move home is under way", mnbtc: nearNow.toString() } };
    }
    const nearBefore = kept?.nbtc_before !== undefined ? BigInt(kept.nbtc_before) : nearNow;
    runner.record.context.btc_home = { nbtc_before: nearBefore.toString() };
    const moves: unknown[] = [];
    // As for the loan: a move under way is not asked for again; its signed transfer is sent if it isn't mined yet.
    if (waiting.length > 0) moves.push({ resumed: waiting.map((t) => t.id), transfer: await sendAndWait(w, 0, "transfer") });
    else {
      for (const t of held) moves.push(await runMove(g, step, `btc_home:${t.symbol}`, { move: "e_home", token: t.address, amount: amountOf(evm.wallet, t.address).toString(), ...(ether && t.symbol === "WETH" ? { to: homeToken } : {}) }));
    }
    const settled = await until(
      w,
      `the ${homeName} to show in the account on NEAR and the move to be settled`,
      MOVE_WAIT_MS,
      5_000,
      async () => ({ mnbtc: await balanceOn(w, homeToken), pending: await pendingMoves(w, "e_home") }),
      (s) => s.mnbtc > nearBefore && s.pending.length === 0,
      (s) => `the account holds ${s.mnbtc} units of ${homeName} (${nearBefore} before) and lists ${s.pending.length} move(s) home`,
    );
    runner.record.context.btc_home = { nbtc_before: nearBefore.toString(), nbtc_after: settled.mnbtc.toString() };
    return { ok: true, detail: { sent_from_the_address: held.map((t) => ({ symbol: t.symbol, amount: amountOf(evm.wallet, t.address).toString() })), arrived_units: (settled.mnbtc - nearBefore).toString(), mnbtc: settled.mnbtc.toString(), moves } };
  });
}

export async function stepFloat({ runner, world: w }: AaveGate) {
  await runner.run("float", "nothing is sent: what the float holds after the run, and how much test ETH the run used", {}, async () => {
    const before = runner.record.context.float as { gas_wallet?: string | null; eth_before?: string | null } | undefined;
    if (!before?.eth_before) return { ok: false, detail: { why: "the record doesn't say what the float held before the run (the gas step notes it), so what the run used can't be said", float_now: await floatNow(w) } };
    const start = BigInt(before.eth_before);
    const used = (now: { balance: string | null }) => (now.balance === null ? null : start - BigInt(now.balance));
    // The stand-in unwraps the WETH that came home a moment after it delivers the nBTC: give it time to be mined.
    const now = await until(w, "the float's test ETH to be back", SHOW_WAIT_MS, 5_000, () => floatNow(w), (f) => (used(f) ?? FLOAT_SPEND_LIMIT_WEI + 1n) <= FLOAT_SPEND_LIMIT_WEI, (f) => `the float holds ${f.balance ?? "an unread amount of"} wei, and held ${start} before the run`).catch(() => floatNow(w));
    const spent = used(now);
    const address = await evmSide(w).catch(() => null);
    const record = {
      gas_wallet: now.gas_wallet,
      eth_before: before.eth_before,
      eth_after: now.balance,
      used_wei: spent?.toString() ?? null,
      used_eth: spent === null ? null : Number(spent) / 1e18,
      // The top-up for gas stays at the account's address: an account's transactions move tokens, never ETH. So
      // does a little USDC left over from repaying Aave.
      left_at_the_address: address ? { eth_wei: address.eth, tokens: address.wallet.filter((t) => t.amount !== "0").map((t) => ({ symbol: t.symbol, amount: t.amount })) } : null,
    };
    runner.record.context.float = record;
    const back = spent !== null && spent <= FLOAT_SPEND_LIMIT_WEI;
    return { ok: back, detail: { ...record, ...(back ? {} : { why: `the float is ${spent === null ? "unread" : `${Number(spent) / 1e18} test ETH`} down on the run, more than the gas and the top-ups a run uses (${Number(FLOAT_SPEND_LIMIT_WEI) / 1e18}): the WETH that came home may still be wrapped at the float. The stand-in's log says, and its next delivery of WETH uses it first` }) } };
  });
}

/** Every step of the moves gate by its id. Create, hl_init, the pool's repay and the last withdraw are the other gates' own. */
export const MOVES_STEPS: Record<string, (g: AaveGate) => Promise<void>> = {
  create: STEPS.create,
  deposit: stepDepositNbtc,
  hl_init: STEPS.hl_init,
  keeper: stepKeeperWatches,
  gas: stepGas,
  btc_out: stepBtcOut,
  arrived: (g) => stepArrived(g, "arrived"),
  fund: stepFundMoves,
  funded: stepFundedAave,
  loan_home: stepLoanHome,
  usdc_out: stepUsdcOut,
  usdc_arrived: (g) => stepArrived(g, "usdc_arrived"),
  repay_aave: stepRepayAave,
  repay: STEPS.repay,
  aave_withdraw: stepAaveWithdraw,
  btc_home: stepBtcHome,
  withdraw: STEPS.withdraw,
  float: stepFloat,
};
