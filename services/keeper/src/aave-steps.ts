// The Aave gate's steps (FUNDING.md 10, gate 3; INTERFACES.md 33), each against the world the other gates use. The
// gate signs for the client only (the keeper's key owns its account). Everything on Aave's chain goes through the
// backend: POST /api/evm/gas for test ETH and collateral, POST /api/evm/submit to send what the account signed, and
// GET /api/lender/:account to see the address, Aave's books and each transaction's status. The keeper, which must be
// running, approves the collateral, runs the funding plan and sends the same transactions as a backup.
import { aaveRepayAmount, aaveSettlement, aaveSplitProblem, keeperWatches, MIN_GAS_WEI, pickCollateral, REPAY_MINT_UNITS, REPAY_SPARE_UNITS, type Collateral, type PoolPricing, type Room } from "./aave-kit.js";
import { KEEPER_ALIVE_MS } from "./config.js";
import { aaveSettings, type AaveSettings } from "./evm.js";
import { fundAmount, fundParts, keeperLines, poolPartLapsed } from "./funding-kit.js";
import { call, requestCheck, STEPS, until, verdictSummary, type Gate, type World } from "./hedge-steps.js";
import type { LogEvent } from "./jsonl.js";
import { ONE_YOCTO, TGAS_ACCOUNT } from "./near-tx.js";
import { readExt, readFunding } from "./plan.js";
import type { AccountState } from "./state.js";

export interface AaveOptions {
  /** What the preview is asked for, in micro-USD: more than the book can carry, so the answer is the most it can. */
  askMicro: bigint;
  /** How long the keeper has to run the funding plan (it lasts 30 minutes). */
  fundWaitMs: number;
  /** How long the settlement step keeps trying while the pool answers "skipped", and how often. */
  settleWaitMs: number;
  settleEveryMs: number;
  /**
   * Stage 4's gate: the most to ask our pool for, in micro-USD. While the account owes our pool, a move needs room
   * on its credit line (money in transit counts 0 for credit), so that gate asks for Aave's part and about $100 from
   * the pool, not the whole line. Left out, the fund step asks for all the preview can lend.
   */
  poolCapMicro?: bigint;
}

export interface AaveGate extends Gate {
  /** The keeper's log, oldest first. */
  keeperLog(): LogEvent[];
  options: AaveOptions;
}

/** How long the gate waits for a transaction on Aave's chain to be mined, or for money to show at the address. Blocks there are 2 s or less. */
const EVM_WAIT_MS = 120_000;
/** How long it waits for something the keeper does on its next tick or with its next check. */
const KEEPER_WAIT_MS = 300_000;
/** The test tokens' storage_balance_bounds().min, as the other gates send with a mint. */
const STORAGE = 1_250_000_000_000_000_000_000n;

export interface Held {
  token: string;
  symbol: string;
  decimals: number;
  amount: string;
}

/** GET /api/lender/:account, the parts the gate reads (services/api/src/lenders.ts and evm-handlers.ts). */
export interface LenderView {
  lenders: { l: string; posted: number; debt: number; hf_bp: number; held: Held[] }[];
  evm: {
    address: string;
    nonce: number | null;
    chain_nonce: number | null;
    eth: string | null;
    wallet: Held[];
    posted: Held[];
    signed: { nonce: number; kind: string; token: string | null; amount: string | null; hash: string; status: string }[];
    chain_error: string | null;
  } | null;
}

export const accountState = (w: World) => w.near.view<AccountState>(w.account, "get_state");
const iso = (ms: number) => new Date(ms).toISOString();

export async function lenderView(w: World): Promise<LenderView> {
  const { status, body } = await w.api.get(`/api/lender/${w.account}`);
  if (status !== 200) throw new Error(`GET /api/lender/${w.account} answered HTTP ${status}: ${String((body as { message?: unknown } | null)?.message ?? "")}`);
  return body as LenderView;
}

/** The account's side on Aave's chain, which must be readable for the gate to go on. */
export async function evmSide(w: World): Promise<NonNullable<LenderView["evm"]>> {
  const view = await lenderView(w);
  if (!view.evm) throw new Error(`${w.account} has no side on Aave's chain: its config has no Aave settings, or it has no address yet`);
  if (view.evm.chain_error) throw new Error(`Aave's chain couldn't be read: ${view.evm.chain_error}`);
  return view.evm;
}

export const amountOf = (list: Held[], token: string) => BigInt(list.find((t) => t.token === token.toLowerCase())?.amount ?? "0");
export const aaveDebt = (state: AccountState | null) => readExt(state?.verdict?.verdict.ext).find((e) => e.l === "aave");

export async function settingsOf(w: World): Promise<AaveSettings> {
  const aave = aaveSettings(await w.near.view<unknown>(w.account, "get_config"));
  if (!aave) throw new Error(`${w.account}'s config has no Aave settings: it was made by a factory from before stage 3`);
  return aave;
}

/** POST /api/evm/gas, with the helper's refusal in its own words. */
export async function gasHelper(w: World, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const answer = await w.api.post("/api/evm/gas", { account: w.account, ...body });
  if (answer.status !== 200) throw new Error(`the gas helper refused (HTTP ${answer.status}): ${String((answer.body as { message?: unknown } | null)?.message ?? "no reason given")}`);
  return answer.body as Record<string, unknown>;
}

/**
 * Sends the account's newest signed transaction of `kind` signed at or after `fromNonce` (POST /api/evm/submit; the
 * keeper sends it too), and waits until the chain has mined it. A transaction that was mined and reverted fails the step.
 */
export async function sendAndWait(w: World, fromNonce: number, kind: string): Promise<{ nonce: number; hash: string; submit: unknown; status: string }> {
  const find = (evm: NonNullable<LenderView["evm"]>) => evm.signed.filter((e) => e.kind === kind && e.nonce >= fromNonce).at(-1);
  const listed = (evm: NonNullable<LenderView["evm"]>) => evm.signed.map((e) => `${e.nonce} ${e.kind} (${e.status})`).join(", ") || "none";
  const signed = await until(w, `the account to hold a signed ${kind} with nonce ${fromNonce} or later`, EVM_WAIT_MS, 3_000, () => evmSide(w), (evm) => find(evm) !== undefined, (evm) => `its signed transactions were ${listed(evm)}`);
  const entry = find(signed)!;
  const submit = await w.api.post("/api/evm/submit", { account: w.account, nonce: entry.nonce }).catch((error: unknown) => ({ status: 0, body: { message: error instanceof Error ? error.message : String(error) } }));
  const done = await until(w, `Aave's chain to mine the ${kind} (nonce ${entry.nonce}, ${entry.hash})`, EVM_WAIT_MS, 3_000, () => evmSide(w), (evm) => {
    const now = evm.signed.find((e) => e.hash === entry.hash);
    return now !== undefined && now.status !== "signed" && now.status !== "sent";
  }, (evm) => `its status was "${evm.signed.find((e) => e.hash === entry.hash)?.status ?? "no longer kept"}", and the chain had used ${evm.chain_nonce ?? "an unread number of"} of the address's nonces`);
  const status = done.signed.find((e) => e.hash === entry.hash)!.status;
  if (status !== "mined") throw new Error(`the ${kind} (nonce ${entry.nonce}, ${entry.hash}) ended as "${status}" on Aave's chain, not mined`);
  return { nonce: entry.nonce, hash: entry.hash, submit: submit.body, status };
}

// ---------- setup ----------

export async function stepDepositUsdc({ runner, plan, world: w }: Gate) {
  await runner.run("deposit", "mint and deposit the test USDC", {}, async (step) => {
    const want = BigInt(plan.deposit_usdc_micro);
    const held = () => w.near.view<string>(w.ids.musdc, "ft_balance_of", { account_id: w.account });
    // A run that is resumed may hold a part already: only what is missing is minted and deposited.
    const before = BigInt(await held());
    const amount = (want > before ? want - before : 0n).toString();
    if (amount !== "0") {
      await call(w, step, w.ids.musdc, "mint", { account_id: w.owner, amount }, 30, STORAGE, "mint test USDC");
      await call(w, step, w.ids.musdc, "ft_transfer_call", { receiver_id: w.account, amount, msg: "" }, 100, ONE_YOCTO, "deposit test USDC");
    }
    const balance = await held();
    return { ok: BigInt(balance) >= want, detail: { musdc: balance, held_before: before.toString(), added: amount } };
  });
}

// ---------- the gate ----------

export async function stepKeeperWatches(g: AaveGate) {
  const { runner, world: w } = g;
  await runner.run("keeper", "the keeper is running, is a stage 3 keeper, and watches the account", {}, async () => {
    const look = () => keeperWatches(g.keeperLog(), w.account, w.now());
    const seen = await until(w, "the keeper to watch the account", KEEPER_WAIT_MS, 5_000, async () => look(), (r) => r.ok).catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}. ${look().why}`);
    });
    return { ok: true, detail: { ...seen, alive_window_s: KEEPER_ALIVE_MS / 1000 } };
  });
}

export async function stepCollateral({ runner, world: w }: AaveGate) {
  await runner.run("collateral", "test ETH for gas and the collateral reach the account's address on Aave's chain", {}, async () => {
    const lenders = await w.api.get("/api/lenders");
    const rows = lenders.status === 200 ? ((lenders.body as { lenders?: { l: string; network: string; collateral_room?: Room[] }[] }).lenders ?? []) : [];
    const rooms = rows.find((r) => r.l === "aave" && r.network === "testnet")?.collateral_room ?? null;
    const pick = pickCollateral(rooms);
    if ("problem" in pick) return { ok: false, detail: { why: pick.problem, rooms } };
    const before = await evmSide(w);
    const want = BigInt(pick.amount);
    const have = amountOf(before.wallet, pick.token);
    // A run that is resumed may hold the collateral already: then only the gas is asked for.
    const ask = have >= want ? {} : pick.how === "mint" ? { mint: { token: pick.token, amount: (want - have).toString() } } : { wrap: { amount: (want - have).toString() } };
    const helped = await gasHelper(w, ask);
    const collateral: Collateral & { gas_wallet: unknown; address: string } = { ...pick, gas_wallet: helped.gas_wallet ?? null, address: before.address };
    runner.record.context.collateral = collateral;
    const after = await until(w, `the ${pick.symbol} and the test ETH to show at ${before.address}`, EVM_WAIT_MS, 3_000, () => evmSide(w), (evm) => amountOf(evm.wallet, pick.token) >= want && BigInt(evm.eth ?? "0") >= MIN_GAS_WEI, (evm) => `the address held ${amountOf(evm.wallet, pick.token)} units of ${pick.symbol} and ${evm.eth ?? "0"} wei`);
    return { ok: true, detail: { collateral, rooms, helper: helped, address: before.address, eth_wei: after.eth, wallet: after.wallet } };
  });
}

export async function stepFundAave(g: AaveGate) {
  const { runner, world: w } = g;
  await runner.run("fund", "a preview, a check for the fund intent, then the client's one fund(amount)", {}, async (step) => {
    const started = w.now();
    const { status, body } = await w.api.post("/api/funding-plan", { account: w.account, amount: g.options.askMicro.toString() });
    const view = (body ?? {}) as { total?: number; sources?: { source: string; amount: number; rate_bp: number | null }[]; steps?: unknown[]; blended_bp?: number | null; verdict?: Record<string, unknown>; run?: { call_id?: string; attestation_url?: string }; message?: string };
    step.gateway({ label: "preview (fund)", http_status: status, ok: status === 200 && view.verdict?.ok === true, call_id: view.run?.call_id ?? null, attestation_url: view.run?.attestation_url ?? null, reason: view.message ?? (view.verdict?.reason as string | undefined) ?? null, seconds: Math.round((w.now() - started) / 100) / 10 });
    if (status !== 200) throw new Error(`the funding preview failed: HTTP ${status} ${view.message ?? ""}`);
    const preview = { asked: g.options.askMicro.toString(), total: view.total ?? 0, sources: view.sources ?? [], steps: view.steps ?? [], blended_bp: view.blended_bp ?? null };
    const problem = aaveSplitProblem(preview.sources);
    if (problem) return { ok: false, detail: { why: problem, preview, verdict: view.verdict ?? null } };

    // The client asks for a little under what the preview can lend, so the check a moment later still gives it all.
    // With a cap on the pool's part (stage 4's gate), it asks for Aave's part and no more than the cap from our pool.
    const part = (name: string) => BigInt(Math.trunc(preview.sources.find((s) => s.source === name)?.amount ?? 0));
    const capped = g.options.poolCapMicro !== undefined && part("pool") > g.options.poolCapMicro ? part("aave") + g.options.poolCapMicro : null;
    const amount = fundAmount(capped ?? BigInt(Math.trunc(preview.total)));
    if (amount <= 0n) return { ok: false, detail: { why: "the preview can lend too little to ask for", preview } };
    const v = await requestCheck(w, step, { fund: { amount: amount.toString() } }, "request_check (fund)");
    const parts = fundParts(v.fund, "aave");
    const verdict = { ...verdictSummary(v), fund: v.fund ?? null, ext: v.ext ?? null, evm: v.evm ?? null };
    // A part from our pool is recorded when it comes, and isn't needed: the gate is Aave's.
    if (v.ok !== true || v.state !== "HEALTHY" || parts.lender <= 0n) {
      return { ok: false, detail: { why: "the check's own answer has no loan from Aave: nothing was signed", amount: amount.toString(), preview, verdict } };
    }
    const poolPart = parts.pool > 0n;
    await call(w, step, w.account, "fund", { amount: amount.toString() }, 100, ONE_YOCTO, "fund");
    const pid = `f${String(v.blk)}`;
    const st = await until(w, `the funding plan ${pid} to be stored`, 30_000, 2_000, () => accountState(w), (s) => readFunding(s)?.pid === pid, (s) => `the account's funding plan was ${readFunding(s)?.pid ?? "none"}`);
    const funding = readFunding(st)!;
    runner.record.context.funding = { pid, amount: amount.toString(), from_aave: parts.lender.toString(), from_pool: parts.pool.toString(), pool_part: poolPart, stored_at_ms: funding.storedAtMs, expires_at_ms: funding.expiresAtMs };
    const kinds = funding.steps.map((s) => s.k);
    return {
      ok: kinds.length === parts.kinds.length && kinds.every((k, i) => k === parts.kinds[i]) && kinds.includes("l_borrow"),
      detail: { amount: amount.toString(), from_aave: parts.lender.toString(), from_pool: parts.pool.toString(), pool_part: poolPart, ...(poolPart ? {} : { note: "the engine gave Aave's part alone: the run goes on without a pool loan" }), preview, verdict, funding: { pid, expires_at_ms: funding.expiresAtMs, steps: funding.steps.map((s) => ({ i: s.i, k: s.k, text: s.text })) } },
    };
  });
}

export async function stepFundedAave(g: AaveGate) {
  const { runner, world: w } = g;
  await runner.run("funded", "the keeper runs the funding plan: the account ends with an Aave loan, and a pool loan if the plan had one", {}, async () => {
    const stored = runner.record.context.funding as { pid?: string; stored_at_ms?: number | null; pool_part?: boolean } | undefined;
    const collateral = runner.record.context.collateral as Collateral | undefined;
    if (!stored?.pid || !collateral) throw new Error("the record has no funding plan or no collateral: run the collateral and fund steps first");
    const since = iso((stored.stored_at_ms ?? w.now()) - 60_000);
    const lines = () => keeperLines(g.keeperLog(), w.account, since, ["step", "check", "note", "evm", "evm_send"]);
    const allDone = (s: AccountState) => {
      const f = readFunding(s);
      return f !== null && f.pid === stored.pid && f.steps.every((x) => x.done);
    };
    const progress = (s: AccountState) => {
      const f = readFunding(s);
      return f ? `plan ${f.pid} had ${f.steps.filter((x) => x.done).length} of ${f.steps.length} steps done` : "the account had no funding plan";
    };
    // A plan that ran out with only the pool's step left can't finish (funding-kit's poolPartLapsed): the wait ends
    // there too, and the pool's part is recorded as not run, with the keeper's own note of why.
    const lapsed = (s: AccountState) => poolPartLapsed(readFunding(s), stored.pid, w.now());
    const settled = await until(w, "the keeper to run every step of the funding plan", g.options.fundWaitMs, 5_000, () => accountState(w), (s) => allDone(s) || lapsed(s), progress).catch((error: unknown) => {
      const last = lines().slice(-4).map((l) => `${l.event}: ${l.msg ?? ""}`).join(" | ");
      throw new Error(`${error instanceof Error ? error.message : String(error)}. The keeper's last lines for the account: ${last || "none"}`);
    });
    if (!allDone(settled)) {
      const note = lines().filter((l) => l.event === "note").map((l) => l.msg ?? "").at(-1);
      const why = `the plan ${stored.pid} ran out with its pool step not run${note ? `; the keeper's note: ${note}` : ""}`;
      runner.record.context.funding = { ...stored, pool_part: false, pool_part_dropped: why };
      stored.pool_part = false;
      w.log(`  the pool's part did not run: ${why}. The gate goes on with Aave's loan alone`);
    }
    // The keeper asks for a check once the borrow is mined: its verdict is the first to show the Aave loan.
    const shown = await until(w, "a verdict that shows the Aave loan", KEEPER_WAIT_MS, 5_000, () => accountState(w), (s) => (aaveDebt(s)?.d ?? 0) > 0).catch(() => null);
    const ext = aaveDebt(shown) ?? null;
    const [evm, debt] = await Promise.all([evmSide(w), w.near.view<string>(w.ids.pool, "debt_of", { account_id: w.account })]);
    const posted = amountOf(evm.posted, collateral.token);
    const kinds = ["approve", "supply", "borrow"];
    const mined = kinds.map((kind) => evm.signed.filter((e) => e.kind === kind).at(-1)?.status ?? "not signed");
    // The pool's loan is checked only when the plan had a pool part (the fund step recorded whether it did).
    const poolPart = stored.pool_part !== false;
    runner.record.context.loans = { aave_debt_micro: ext?.d ?? 0, aave_posted_units: posted.toString(), pool_debt_micro: debt, pool_part: poolPart };
    return {
      ok: ext !== null && posted > 0n && (!poolPart || BigInt(debt) > 0n) && mined.every((s) => s === "mined"),
      detail: {
        pool_part: poolPart,
        ...(allDone(settled) ? {} : { pool_part_dropped: (runner.record.context.funding as { pool_part_dropped?: string }).pool_part_dropped }),
        ext,
        aave_books: { posted: evm.posted, at_the_address: evm.wallet },
        pool_debt_micro: debt,
        transactions: evm.signed.map((e) => ({ nonce: e.nonce, kind: e.kind, hash: e.hash, status: e.status })),
        ...(mined.every((s) => s === "mined") ? {} : { why: `not every transaction is mined: ${kinds.map((k, i) => `${k} ${mined[i]}`).join(", ")}` }),
        keeper_steps: lines().filter((l) => l.event === "step" && l.pid === stored.pid).map((l) => ({ at: l.t, i: l.i, k: l.k, ok: l.ok, tx: l.tx })),
        keeper_checks: lines().filter((l) => l.event === "check").map((l) => ({ at: l.t, tx: l.tx, why: l.why })),
        keeper_sends: lines().filter((l) => l.event === "evm_send" || l.event === "evm").map((l) => ({ at: l.t, msg: l.msg })),
        keeper_notes: lines().filter((l) => l.event === "note").map((l) => l.msg),
      },
    };
  });
}

export async function stepSettleAave(g: AaveGate) {
  const { runner, world: w } = g;
  await runner.run("settle", "a check, then settle(): the pool books a settlement for the Aave loan", {}, async (step) => {
    // Without a pool loan the settlement isn't what the gate is for: it is tried three times, and what the pool or
    // the account said is recorded either way.
    const poolPart = (runner.record.context.funding as { pool_part?: boolean } | undefined)?.pool_part !== false;
    const deadline = w.now() + g.options.settleWaitMs;
    const tries: { at: string; tx: string | null; said: string; answer: unknown }[] = [];
    // What the pool booked is read from the pool's own record of the account: the account's settle() answers only
    // that it ran. A record that can't be read counts as nothing booked.
    const poolRecord = () => w.near.view<PoolPricing | null>(w.ids.pool, "get_pricing", { account_id: w.account }).catch(() => null);
    for (;;) {
      const n = tries.length + 1;
      const before = await poolRecord();
      // The keeper asks for checks of its own. One that lands between this one's request and its verdict has the
      // account refuse it: that is a try that didn't count, not a failed step.
      const checked = await requestCheck(w, step, { check: {} }, `request_check (settle, try ${n})`).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      let said = `the check before it didn't hold: ${checked}`;
      let answer: unknown = null;
      let hash: string | null = null;
      if (checked === null) {
        // With a pool loan a settle() that fails stops the step. Without one it is a try that is written down.
        const tx = await call(w, step, w.account, "settle", {}, TGAS_ACCOUNT, 0n, `settle (try ${n})`).catch((error: unknown) => {
          if (poolPart) throw error;
          return error instanceof Error ? error.message : String(error);
        });
        if (typeof tx === "string") {
          said = `settle() didn't go through: ${tx}`;
        } else {
          hash = tx.hash;
          const booked = aaveSettlement(before, await poolRecord());
          said = booked ? booked.words : "nothing settled: the pool's record of the account didn't move (it settles at most once in its period)";
          answer = booked;
        }
      }
      tries.push({ at: iso(w.now()), tx: hash, said, answer });
      w.log(`  try ${n}: ${said}`);
      if (answer !== null) return { ok: true, detail: { settled: true, settlement: answer, in_words: said, tries } };
      if (!poolPart && n >= 3) return { ok: true, detail: { settled: false, note: `the account has no pool loan, and the pool booked no settlement in ${n} tries; it last said: ${said}`, tries } };
      if (w.now() + g.options.settleEveryMs > deadline) return { ok: false, detail: { why: `the pool booked no settlement in ${Math.round(g.options.settleWaitMs / 60_000)} minutes; it last said: ${said}`, tries } };
      await w.sleep(g.options.settleEveryMs);
    }
  });
}

// ---------- leaving ----------

export async function stepRepayAave({ runner, world: w }: AaveGate) {
  await runner.run("repay_aave", "the client repays Aave in full, from the USDC at the account's address", {}, async (step) => {
    const aave = await settingsOf(w);
    const usdc = aave.usdc.address;
    const owed = aaveDebt(await accountState(w))?.d ?? 0;
    if (owed <= 0) return { ok: true, detail: { already: "the held verdict shows nothing owed to Aave" } };
    const want = aaveRepayAmount(BigInt(Math.trunc(owed)));
    let evm = await evmSide(w);

    // The borrowed USDC is at the address; the interest since isn't. One mint of 1 test USDC from Aave's faucet
    // covers it. (Aave takes only what is owed, so the repayment may ask for more than the address holds.)
    let minted: Record<string, unknown> | null = null;
    const held = amountOf(evm.wallet, usdc);
    if (held < BigInt(Math.trunc(owed)) + REPAY_SPARE_UNITS) {
      minted = await gasHelper(w, { mint: { token: usdc, amount: REPAY_MINT_UNITS.toString() } });
      evm = await until(w, "the 1 USDC from Aave's faucet to show at the address", EVM_WAIT_MS, 3_000, () => evmSide(w), (e) => amountOf(e.wallet, usdc) >= held + REPAY_MINT_UNITS, (e) => `the address held ${amountOf(e.wallet, usdc)} units of USDC (${held} before)`);
    } else if (BigInt(evm.eth ?? "0") < MIN_GAS_WEI) {
      await gasHelper(w, {});
    }

    // Aave's Pool takes the USDC only once the address has approved it. The keeper does that once Aave is owed; if
    // it hasn't yet, the client does (evm_approve is open to anyone).
    let approval: unknown = "the keeper's, already mined";
    const approvals = () => evm.signed.filter((e) => e.kind === "approve" && e.token === usdc);
    if (!approvals().some((e) => e.status === "mined")) {
      if (approvals().length === 0) await call(w, step, w.account, "evm_approve", { token: usdc }, TGAS_ACCOUNT, 0n, "evm_approve (USDC)");
      approval = await sendAndWait(w, approvals().at(-1)?.nonce ?? evm.nonce ?? 0, "approve");
      evm = await evmSide(w);
    }

    const from = evm.nonce ?? 0;
    await call(w, step, w.account, "lender_repay", { lender: "aave", amount: want.toString() }, TGAS_ACCOUNT, ONE_YOCTO, "lender_repay (aave)");
    const repaid = await sendAndWait(w, from, "repay");
    const v = await requestCheck(w, step, { check: {} }, "request_check (after the Aave repayment)");
    const left = readExt(v.ext).find((e) => e.l === "aave")?.d ?? 0;
    return { ok: left === 0, detail: { owed_micro: owed, sent_micro: want.toString(), faucet: minted, approval, repayment: repaid, owed_after_micro: left, verdict: verdictSummary(v) } };
  });
}

export async function stepAaveWithdraw({ runner, world: w }: AaveGate) {
  await runner.run("aave_withdraw", "the client takes the collateral back from Aave", {}, async (step) => {
    const before = await evmSide(w);
    const posted = before.posted.filter((p) => BigInt(p.amount) > 0n);
    if (posted.length === 0) return { ok: true, detail: { already: "Aave's books show nothing posted" } };
    // Not before Aave is repaid: the verdict the repay_aave step ended on must show nothing owed there.
    const owed = aaveDebt(await accountState(w))?.d ?? 0;
    if (owed > 0) return { ok: false, detail: { why: `the held verdict still shows ${(owed / 1e6).toFixed(2)} USDC owed to Aave: the repay_aave step comes first`, owed_micro: owed } };
    if (BigInt(before.eth ?? "0") < MIN_GAS_WEI) await gasHelper(w, {});
    const taken: unknown[] = [];
    for (const p of posted) {
      const from = (await evmSide(w)).nonce ?? 0;
      await call(w, step, w.account, "lender_withdraw", { lender: "aave", token: p.token, amount: p.amount }, TGAS_ACCOUNT, ONE_YOCTO, `lender_withdraw (aave, ${p.symbol})`);
      taken.push({ token: p.token, symbol: p.symbol, amount: p.amount, ...(await sendAndWait(w, from, "withdraw")) });
    }
    // The account lists the withdrawal as under way until a verdict has seen the chain use its nonce: a check drops it.
    const v = await requestCheck(w, step, { check: {} }, "request_check (after the withdrawal from Aave)");
    const after = await evmSide(w);
    // Aave's books may keep a few units of interest earned on what was posted: under a thousandth of it is dust.
    const left = after.posted.map((p) => ({ ...p, of: posted.find((x) => x.token === p.token)?.amount ?? "0" }));
    const cleared = left.every((p) => BigInt(p.amount) * 1_000n <= BigInt(p.of));
    return { ok: cleared && posted.every((p) => amountOf(after.wallet, p.token) >= BigInt(p.amount)), detail: { taken, still_posted: after.posted, at_the_address: after.wallet, verdict: verdictSummary(v) } };
  });
}

export async function stepEvmOut({ runner, world: w }: AaveGate) {
  await runner.run("evm_out", "the collateral leaves the account's address with evm_withdraw, to the gas wallet's address", {}, async (step) => {
    const collateral = runner.record.context.collateral as (Collateral & { gas_wallet?: unknown }) | undefined;
    const to = typeof collateral?.gas_wallet === "string" ? collateral.gas_wallet : null;
    if (!collateral || !to) throw new Error("the record doesn't say which collateral was used or where the gas wallet is: run the collateral step first");
    const before = await evmSide(w);
    const amount = amountOf(before.wallet, collateral.token);
    if (amount === 0n) return { ok: true, detail: { already: `the address holds no ${collateral.symbol}` } };
    if (BigInt(before.eth ?? "0") < MIN_GAS_WEI) await gasHelper(w, {});
    await call(w, step, w.account, "evm_withdraw", { token: collateral.token, amount: amount.toString(), to }, TGAS_ACCOUNT, ONE_YOCTO, `evm_withdraw (${collateral.symbol})`);
    const sent = await sendAndWait(w, before.nonce ?? 0, "transfer");
    const after = await until(w, `the ${collateral.symbol} to leave the address`, EVM_WAIT_MS, 3_000, () => evmSide(w), (evm) => amountOf(evm.wallet, collateral.token) === 0n, (evm) => `the address held ${amountOf(evm.wallet, collateral.token)} units of it`);
    return { ok: true, detail: { token: collateral.token, symbol: collateral.symbol, amount: amount.toString(), to, transfer: sent, at_the_address: after.wallet, eth_left_wei: after.eth } };
  });
}

/** Every step of the Aave gate by its id. The setup's create and hl_init, the pool's repay and the last withdraw are the other gates' own. */
export const AAVE_STEPS: Record<string, (g: AaveGate) => Promise<void>> = {
  create: STEPS.create,
  deposit: stepDepositUsdc,
  hl_init: STEPS.hl_init,
  keeper: stepKeeperWatches,
  collateral: stepCollateral,
  fund: stepFundAave,
  funded: stepFundedAave,
  settle: stepSettleAave,
  repay_aave: stepRepayAave,
  repay: STEPS.repay,
  aave_withdraw: stepAaveWithdraw,
  evm_out: stepEvmOut,
  withdraw: STEPS.withdraw,
};

