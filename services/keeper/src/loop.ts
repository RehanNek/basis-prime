// One keeper tick (PLAN.md 5.7; INTERFACES.md 17): read the prices once, then for each client account read its state,
// decide (decide.ts), act, and log every action as a JSON line with its transaction hash or attestation URL. Every
// effect is a dependency, so the loop is tested with fakes and a scripted chain.
import { afterAction, afterZeroSettle, CHECK_WAIT_MS, decide, FUND_FRESH_BLOCKS, KEEP_PRICES_MS, MAX_ZERO_AGAIN, verdictKey, type Action, type EvmSeen, type KeptPrices, type Memory, type Outcome, type Seen } from "./decide.js";
import { pendingAave, rawFields, readEvm, type AaveSettings } from "./evm.js";
import type { Prices } from "./bands.js";
import type { Log } from "./jsonl.js";
import { settlementIn, skippedTooSoon } from "./near-tx.js";
import { isOverdue, lenderName, nsToMs, pendingLender, pendingTransfers, readExt, readFunding, readPlan, type LenderExt, type PlanStep } from "./plan.js";
import { hlAddressOf, loanOpen, toVerdict, type AccountState } from "./state.js";

/** What every account shares this tick. */
export interface Market {
  prices: Prices;
  /** The final block's time, ms, and the keeper's time when it read it. */
  chainNowMs?: number;
  readAt?: number;
  /** The final block's height (Phase 6: a pending lender action's block and a verdict's age are measured against it). */
  chainBlock?: number;
  /** Fields for the tick's log line: the block, the BTC mark, the drill ratio, the keeper's balance. */
  summary: Record<string, unknown>;
}

export interface CheckResult {
  ok: boolean;
  hash: string | null;
  /** on_verdict's answer, when the RPC has it: whether the account kept the verdict, and if not why. */
  accepted?: boolean | null;
  reason?: string | null;
  attestationUrl: string | null;
  seconds: number;
  failure?: string;
}

export interface GatewayResult {
  ok: boolean;
  retry: boolean;
  replan: boolean;
  code: string | null;
  reason: string | null;
  output: unknown;
  callId: string | null;
  attestationUrl: string | null;
  seconds: number;
}

export interface StepResult {
  ok: boolean;
  hash: string | null;
  failure?: string;
  logs: string[];
  seconds: number;
  /** The transaction was never sent (a network failure): worth another try. */
  retry: boolean;
}

/** The account's `settle()` (INTERFACES.md 25): `result` is the pool's answer, a settlement or `{"skipped": "<why>"}`. */
export interface SettleResult {
  ok: boolean;
  hash: string | null;
  result?: unknown;
  failure?: string;
  logs: string[];
  seconds: number;
  /** The transaction was never sent: worth another try behind the next check. */
  retry: boolean;
}

export type GatewayMode = "deleverage" | "cancel_risky";

export interface KeeperDeps {
  readMarket(): Promise<Market>;
  /** The client accounts to watch: the factory's list_accounts, or --account. */
  listAccounts(): Promise<string[]>;
  /** get_state, or null while there is no account contract. */
  readState(account: string): Promise<AccountState | null>;
  blockTimeMs(height: number): Promise<number>;
  /** The coins the Hyperliquid address holds a position in. */
  readPerps(address: `0x${string}`): Promise<string[]>;
  /**
   * Phase 5 (INTERFACES.md 21): the account's own drill ratio on testnet (get_ratio_for), which pb-risk reads as π for
   * nBTC; null when the drill's code has none, and the shared ratio in the market's prices stands.
   */
  readRatioFor?(account: string): Promise<number | null>;
  /** `intent`: what the check is for, as the account's `request_check` takes it. Left out, it is a plain `{"check": {}}`. */
  requestCheck(account: string, intent?: unknown): Promise<CheckResult>;
  runGateway(account: string, mode: GatewayMode): Promise<GatewayResult>;
  /** `step` carries the step's kind and its 1Click deposit address, if it has one. */
  executeStep(account: string, pid: string, i: number, step: { k: string; dep?: string }): Promise<StepResult>;
  /** Phase 6: the account's `settle()`, which needs the fresh verdict a check just brought. */
  settle?(account: string): Promise<SettleResult>;
  /**
   * INTERFACES.md 40.4, item 10: the lender report the pool's last settlement stored for the account (the pool's
   * `get_pricing(account).last`: each lender and the debt there, micro-USD), or null when the pool has no record.
   * INTERFACES.md 45.3, item 9: `priced` says whether the policy that applies to the account is anything but
   * pass-through.
   */
  readPricing?(account: string): Promise<{ last: { lender: string; debt: string }[]; priced?: boolean } | null>;
  /**
   * INTERFACES.md 45.3, item 10: the least time the pool keeps between two settlements of one account, in ms (its
   * `get_params().pricing_limits.min_period_ns`), or null when the pool doesn't say.
   */
  readMinPeriodMs?(): Promise<number | null>;
  /** 1Click's status for a deposit address, or null when it doesn't know it. */
  transferStatus?(dep: string): Promise<string | null>;
  /** Phase 3's backup: posts the account's newly signed Hyperliquid actions. One line per entry handled. */
  postSigned?(account: string, state: AccountState): Promise<string[]>;
  /** Drops a cached read after the keeper changed the account. */
  forget?(account: string): void;

  // ---------- Stage 3 (INTERFACES.md 33): Aave's chain. Without these the keeper leaves Aave's steps to the account's own refusals. ----------
  /** The account's Aave settings (get_config().lenders.aave), or null when it has none. */
  readAave?(account: string): Promise<AaveSettings | null>;
  /** How many transactions of the address Aave's chain has used. */
  readEvmNonce?(address: string): Promise<number>;
  /** Whether the address lets Aave's Pool take the token. */
  readApproved?(token: string, address: string, pool: string): Promise<boolean>;
  /** The account's `evm_approve(token)` and `evm_bump(nonce, max_fee, tip)`: each has the signer sign a transaction. */
  evmApprove?(account: string, token: string): Promise<StepResult>;
  evmBump?(account: string, nonce: number, maxFee: string, tip: string): Promise<StepResult>;
  /** Sends the account's signed transactions the chain hasn't used yet: through the backend, and by itself. One line per entry handled. */
  sendEvm?(account: string, state: AccountState, chainNonce: number, aave: AaveSettings): Promise<string[]>;
  log: Log;
  now(): number;
  random?(): number;
}

export interface TransferSeen {
  status: string | null;
  polledAt: number;
  overdue: boolean;
  /** Its deadline was more than 24.5 hours ahead, and that was said. */
  far?: boolean;
}

export interface AccountMemory {
  decide: Memory;
  transfers: Record<string, TransferSeen>;
  /** The last account line logged, so a line is written only when something changes. */
  shown?: string;
  missing?: boolean;
  blocked?: boolean;
  /** Stage 3: the account's Aave settings once read (null: it has none), the chain's nonce as last read, and the tokens found approved. */
  aave?: AaveSettings | null;
  evmChainNonce?: number;
  approved?: string[];
  /**
   * INTERFACES.md 40.4, item 10: the lenders whose line in the pool's last report is known to show no debt. A lender
   * leaves the list when a verdict shows it owed, so the record is read again once that debt is gone.
   */
  lenderLineClear?: string[];
  /**
   * INTERFACES.md 44: the prices read for the account on each tick of the last 10 minutes, oldest first, with the
   * final block's height when the tick began. A verdict the keeper didn't ask for is measured from them (decide.ts,
   * pricesAtBlock). It is written before the tick decides anything, so a tick that fails later still leaves it.
   */
  kept?: KeptPrices[];
  /**
   * INTERFACES.md 49.4: a check the client's page asked the keeper for. `at`: when it went out. `acceptedAt` and
   * `counter`: when its verdict landed, and the account's counter then. Until the client has acted on it (the
   * counter moves) or CLIENT_CHECK_GRACE_MS has passed, the keeper asks for no check of its own for the account.
   */
  clientCheck?: { at: number; acceptedAt?: number; counter?: number };
}

/** 1Click is asked about each pending transfer at most this often. */
export const TRANSFER_POLL_MS = 30_000;
/**
 * A 1Click quote lives a day at most, and a transfer's deadline is its quote's expiry and 30 minutes. One further
 * ahead than this is no real transfer on its way (research/audit.md A7). Accounts made since the fix of 12 Nov
 * refuse to record one (INTERFACES.md 40.1); an older account can still hold one, and the keeper says so.
 */
export const MOVE_FAR_MS = 24.5 * 60 * 60_000;
/**
 * INTERFACES.md 49.4. A check the client's page asked for is given this long to come back before the keeper's own
 * checks for the account go on (a run can wait its turn at OutLayer, and is asked up to three times)...
 */
export const CLIENT_CHECK_FLIGHT_MS = 12 * 60_000;
/** ...and once its verdict is in, the client has this long to act on it: the account takes a verdict for 120 blocks, a little over a minute. */
export const CLIENT_CHECK_GRACE_MS = 90_000;
/** A client's check is asked again when OutLayer brought no verdict: this many times in all. */
export const CLIENT_CHECK_TRIES = 3;

/** Whether a client's check is on its way for the account, or its verdict still waits for the client's action. */
export function clientCheckHolds(mem: AccountMemory, counter: number, now: number): boolean {
  const c = mem.clientCheck;
  if (!c) return false;
  if (c.acceptedAt === undefined) return now - c.at < CLIENT_CHECK_FLIGHT_MS;
  return now - c.acceptedAt < CLIENT_CHECK_GRACE_MS && (c.counter === undefined || c.counter === counter);
}

/**
 * One at a time for an account: each call waits for the one before it for the same account, whoever made it, and
 * accounts don't wait for each other. The keeper's `request_check` goes through this, so a check the client's page
 * asked for (INTERFACES.md 49.4) and one of the loop's own never run side by side: the second would replace the
 * first's verdict, or be refused when it lands. One that fails doesn't hold the next.
 */
export function oneAtATime<A extends unknown[], T>(send: (account: string, ...rest: A) => Promise<T>): (account: string, ...rest: A) => Promise<T> {
  const out = new Map<string, Promise<unknown>>();
  return (account, ...rest) => {
    const turn = (out.get(account) ?? Promise.resolve()).catch(() => undefined).then(() => send(account, ...rest));
    out.set(account, turn);
    const clear = () => {
      if (out.get(account) === turn) out.delete(account);
    };
    turn.then(clear, clear);
    return turn;
  };
}

/** What the keeper answers a client's check with (INTERFACES.md 49.3, `POST /api/check`). */
export type ClientCheckAnswer = { accepted: true; blk: number | null; tries: number; tx: string | null } | { accepted: false; reason: string; tries: number; tx: string | null };

/**
 * INTERFACES.md 49.4: the check a client's page asks for, sent and paid by the keeper. It goes out through the same
 * `requestCheck` the keeper's own checks use, with the client's intent, and is asked again, up to three times in all,
 * when OutLayer brings no verdict. The account's memory is marked first, so the loop asks for no check of its own
 * meanwhile, and takes the verdict as one the keeper asked for (measured from the prices of now).
 *
 * Asked again: "OutLayer returned no verdict" and "OutLayer's call failed", the account's own words for a run that
 * failed or timed out. Not asked again: a check whose end the keeper didn't see (its verdict may still land, and a
 * second would only queue behind it), and anything else the account refuses.
 */
export async function clientCheck(deps: KeeperDeps, memory: Map<string, AccountMemory>, account: string, intent: unknown): Promise<ClientCheckAnswer> {
  const mem: AccountMemory = memory.get(account) ?? { decide: {}, transfers: {} };
  memory.set(account, mem);
  const started = deps.now();
  if (mem.clientCheck && mem.clientCheck.acceptedAt === undefined && started - mem.clientCheck.at < CLIENT_CHECK_FLIGHT_MS) {
    return { accepted: false, reason: "a check for this account is already on its way: wait for it", tries: 0, tx: null };
  }
  mem.clientCheck = { at: started };
  // The verdict this brings is the keeper's own asking: its moves are measured from the prices of now.
  const prices = mem.kept?.at(-1)?.prices;
  mem.decide = { ...mem.decide, lastCheckAt: started, ...(prices ? { checkPrices: prices } : {}) };
  let tx: string | null = null;
  let reason = "no reason given";
  for (let tries = 1; tries <= CLIENT_CHECK_TRIES; tries++) {
    let r: CheckResult;
    try {
      r = await deps.requestCheck(account, intent);
    } catch (error) {
      r = { ok: false, hash: null, attestationUrl: null, seconds: 0, failure: errorText(error) };
    }
    tx = r.hash ?? tx;
    const accepted = r.ok && r.accepted !== false;
    // An accepted check's line carries what its verdict says the account is worth and owes our pool: the backend
    // draws the page's chart from these lines and the loop's `verdict` lines (INTERFACES.md 49.3, the portfolio).
    let state: Awaited<ReturnType<KeeperDeps["readState"]>> | null = null;
    if (accepted) {
      deps.forget?.(account);
      state = await deps.readState(account).catch(() => null);
    }
    const held = state?.verdict?.verdict;
    deps.log("check", accepted ? "the client's page asked for a check; the verdict is in" : `the client's page asked for a check, and it brought no verdict: ${r.reason ?? r.failure ?? "no reason given"}`, {
      account,
      tx: r.hash,
      attestation_url: r.attestationUrl,
      accepted: r.accepted ?? null,
      reason: r.reason ?? null,
      seconds: r.seconds,
      why: "asked by the client's page (POST /check)",
      try: tries,
      ...(held ? { blk: held.blk, eq: held.eq, debt: state?.loan?.principal ?? null } : {}),
    });
    if (accepted) {
      mem.clientCheck = { at: started, acceptedAt: deps.now(), ...(state ? { counter: state.counter } : {}) };
      return { accepted: true, blk: state?.verdict?.verdict.blk ?? null, tries, tx: r.hash };
    }
    reason = r.reason ?? r.failure ?? reason;
    const unseen = !r.ok && r.hash === null;
    const noVerdict = r.accepted === false && /OutLayer/.test(r.reason ?? "");
    if (unseen || !noVerdict || tries === CLIENT_CHECK_TRIES) {
      // One whose end wasn't seen may still land: the loop waits for it as for any check of its own.
      if (unseen) mem.decide = { ...mem.decide, checkPending: { at: started } };
      mem.clientCheck = undefined;
      return { accepted: false, reason: unseen ? `the check didn't come back in time, and its result may still arrive: ${reason}` : reason, tries, tx };
    }
  }
  mem.clientCheck = undefined;
  return { accepted: false, reason, tries: CLIENT_CHECK_TRIES, tx };
}

/** The pool's own default for `min_period_ns`, 10 minutes (contracts/pool/src/pricing.rs): what the keeper waits when it can't read the pool's. */
export const DEFAULT_MIN_PERIOD_MS = 10 * 60_000;
/** The lenders a pool's report can name (contracts/pool/src/settle.rs). */
const REPORT_LENDERS = ["aave", "rhea"];

export async function tick(deps: KeeperDeps, memory: Map<string, AccountMemory>, options: { accounts?: string[] } = {}): Promise<void> {
  const now = deps.now();
  let market: Market;
  try {
    market = await deps.readMarket();
  } catch (error) {
    deps.log("tick", `the market reads failed: ${errorText(error)}`, {});
    market = { prices: { marks: {}, pi: {} }, summary: {} };
  }
  let accounts: string[];
  try {
    accounts = options.accounts?.length ? options.accounts : await deps.listAccounts();
  } catch (error) {
    accounts = [...memory.keys()];
    deps.log("error", `could not list the factory's accounts (${errorText(error)}); watching the ${accounts.length} already known`, {});
  }
  deps.log("tick", `${accounts.length} client account(s) to look at`, { ...market.summary, accounts });

  // Accounts are handled side by side; one account's trouble never stops the others.
  await Promise.all(
    accounts.map((account) =>
      handle(deps, account, market, memory, now).catch((error: unknown) => deps.log("error", `skipped this tick: ${errorText(error)}`, { account })),
    ),
  );
}

async function handle(deps: KeeperDeps, account: string, market: Market, memory: Map<string, AccountMemory>, now: number): Promise<void> {
  const mem: AccountMemory = memory.get(account) ?? { decide: {}, transfers: {} };
  memory.set(account, mem);
  const state = await deps.readState(account);
  if (!state) {
    if (!mem.missing) deps.log("account", "no account contract there yet", { account });
    mem.missing = true;
    return;
  }
  mem.missing = false;
  if (state.blocked) {
    if (!mem.blocked) deps.log("account", "the account is blocked (DEFAULT): nothing to do", { account });
    mem.blocked = true;
    return;
  }

  // Phase 6: a debt at a lender is a loan too. The held verdict's `ext` says so, and the engine counts the whole debt.
  const ext = readExt(state.verdict?.verdict.ext);
  const owesPool = loanOpen(state.loan);
  const hasLoan = owesPool || ext.some((e) => e.d > 0);
  // received_at (ns) is when the account stored the verdict; older accounts don't say, so the block's time stands in.
  const verdict = state.verdict ? toVerdict(state, nsToMs(state.verdict.received_at) ?? (await deps.blockTimeMs(state.verdict.received_block))) : null;
  const plan = readPlan(state);
  const address = hlAddressOf(state);
  const perps = hasLoan && address ? await deps.readPerps(address).catch(() => [] as string[]) : [];
  // The bands are compared with the π pb-risk reads for this account: its own drill ratio, when it has one.
  let ratioRead = true;
  const ownRatio = hasLoan && deps.readRatioFor ? await deps.readRatioFor(account).catch(() => ((ratioRead = false), null)) : null;
  const prices = ownRatio === null ? market.prices : { ...market.prices, pi: { ...market.prices.pi, nBTC: ownRatio } };
  // INTERFACES.md 44: what this tick read is kept for 10 minutes, with the final block's height when the tick began.
  // Not a tick whose read of the account's own ratio failed (its prices aren't the account's), nor one with no block.
  const kept = (mem.kept ?? []).filter((k) => now - k.at <= KEEP_PRICES_MS);
  if (market.chainBlock !== undefined && ratioRead) kept.push({ block: market.chainBlock, at: now, prices });
  mem.kept = kept;
  // INTERFACES.md 45.3, item 9: on the tick the hourly check is due, where no lender is owed, is the account's
  // policy at our pool anything but pass-through? Then this hour's settlement goes out all the same. One read an
  // hour, and only for an account that has a loan and owes no lender: where a lender is owed it settles anyway.
  let priced: boolean | undefined;
  const hourlyDue = hasLoan && mem.decide.nextHourlyAt !== undefined && now >= mem.decide.nextHourlyAt;
  if (hourlyDue && deps.readPricing && !ext.some((e) => e.d > 0)) {
    try {
      priced = (await deps.readPricing(account))?.priced === true;
    } catch (error) {
      deps.log("error", `the pool's record of what the account pays couldn't be read (${errorText(error)}): no settlement behind this hour's check`, { account });
    }
  }
  const funding = readFunding(state);
  const aave = address ? await aaveOf(deps, account, state, mem) : null;
  const evm = aave && address ? await readEvmSide(deps, account, state, mem, aave, address, [...(plan?.steps ?? []), ...(funding?.steps ?? [])], ext) : undefined;
  const seen: Seen = {
    hasLoan,
    counter: state.counter,
    verdict,
    firstDeleverageAtMs: nsToMs(state.deleverage?.first_at) ?? 0,
    plan,
    prices,
    perps,
    transfers: pendingTransfers(state.pending).map((t) => t.id),
    // Phase 6: the held verdict's lender positions, when it has any; the funding plan; a lender action under way.
    ...(ext.length ? { ext } : {}),
    owesPool,
    funding,
    pendingLender: pendingLender(state.pending),
    ...(evm ? { evm } : {}),
    // Stage 4: the moves to Aave's chain that the stand-in (1Click) said were delivered when it was last asked.
    delivered: pendingTransfers(state.pending).filter((t) => t.kind === "to_evm" && mem.transfers[t.id]?.status === "SUCCESS").map((t) => t.id),
    // INTERFACES.md 40.1: the block the permission last changed in, on an account that records it.
    ...(typeof state.permission_blk === "number" ? { permissionBlk: state.permission_blk } : {}),
    ...(market.chainBlock !== undefined ? { chainBlock: market.chainBlock } : {}),
    ...(kept.length ? { kept } : {}),
    ...(priced !== undefined ? { priced } : {}),
    ...(clientCheckHolds(mem, state.counter, now) ? { clientCheck: true } : {}),
    // The final block was read at the start of the tick: carry its time forward by the keeper's clock since.
    ...(market.chainNowMs !== undefined && market.readAt !== undefined ? { chainNowMs: market.chainNowMs + (now - market.readAt) } : {}),
  };

  const before = mem.decide;
  const decision = decide(before, seen, now, deps.random);
  if (hasLoan && verdict && verdictKey(verdict) !== before.verdictKey) {
    const v = state.verdict!.verdict;
    deps.log("verdict", `a new verdict: ${v.state}, action ${v.action}`, {
      account,
      blk: v.blk,
      nonce: v.nonce,
      received_block: state.verdict!.received_block,
      state: v.state,
      action: v.action,
      eq: v.eq,
      // What the account owes our pool as this verdict arrives, for the page's chart (INTERFACES.md 49.3).
      debt: state.loan?.principal ?? null,
      mm: v.mm,
      im: v.im,
      since: v.since,
      hl_margin_ratio_bp: v.venues?.hl_margin_ratio_bp,
      bands: v.bands,
      top: v.top,
      plan_steps: Array.isArray(v.plan) ? v.plan.length : 0,
    });
  }
  showAccount(deps, account, state, hasLoan, now, mem, ownRatio);
  for (const note of decision.notes) deps.log("note", note, { account });

  // After a check: a lender's line the pool still holds with debt, where the new verdict shows none owed. It goes
  // before this tick's own actions: a step among them may borrow at that lender again, and the pool should hold the
  // zero by then. settle() leaves the account's counter alone, so the verdict still backs what follows.
  const zeroSettle = verdict && verdictKey(verdict) !== before.verdictKey ? await settleRepaidLender(deps, account, state, mem, ext, decision.actions, market.chainBlock, now) : null;

  let next = decision.memory;
  // Nothing left to report as zero: whatever was to be tried again is over.
  if (zeroSettle === "clear") next = next.zeroAgain ? { ...next, zeroAgain: undefined } : next;
  else if (zeroSettle) next = await noteZeroSettle(deps, account, next, zeroSettle);
  let checkFailed = false;
  for (const action of decision.actions) {
    deps.log("decide", action.reason, { account, action: action.kind, ...("pid" in action && { pid: action.pid }), ...("i" in action && { i: action.i, k: action.k }) });
    // settle() runs on the verdict the check before it brought: with no new verdict it would only be refused.
    const outcome: Outcome = action.kind === "settle" && checkFailed ? skipSettle(deps, account) : await act(deps, account, action);
    if (action.kind === "request_check" && !outcome.ok) checkFailed = true;
    next = afterAction(next, action, outcome, deps.now());
    if (action.kind === "settle" && action.zero) next = await noteZeroSettle(deps, account, next, outcome);
  }
  if (decision.actions.length) deps.forget?.(account);
  mem.decide = next;

  // Stage 3: send what the account has signed for Aave's chain and the chain hasn't used. A step, an approval or a
  // bump that ran on this tick has just signed one: the state is read again, so that it goes out now.
  if (aave && deps.sendEvm && mem.evmChainNonce !== undefined) {
    const signedNow = decision.actions.some((a) => a.kind === "execute_step" || a.kind === "evm_approve" || a.kind === "evm_bump");
    const latest = signedNow ? ((await deps.readState(account).catch(() => null)) ?? state) : state;
    const lines = await deps.sendEvm(account, latest, mem.evmChainNonce, aave).catch((error: unknown) => [`the signed transactions couldn't be sent: ${errorText(error)}`]);
    for (const line of lines) deps.log("evm_send", line, { account });
  }

  await pollTransfers(deps, account, state, mem, now);
  for (const line of (await deps.postSigned?.(account, state)) ?? []) deps.log("hl_post", line, { account });
}

/** The account's Aave settings, read once and kept. A read that fails is tried again on the next tick. */
async function aaveOf(deps: KeeperDeps, account: string, state: AccountState, mem: AccountMemory): Promise<AaveSettings | null> {
  if (!deps.readAave || !readEvm(state)) return null;
  if (mem.aave !== undefined) return mem.aave;
  try {
    mem.aave = await deps.readAave(account);
    return mem.aave;
  } catch (error) {
    deps.log("error", `the account's Aave settings couldn't be read (${errorText(error)}): its Aave steps wait`, { account });
    return null;
  }
}

/**
 * The account's side on Aave's chain for this tick. The chain's nonce is read while the account has signed more than
 * the chain was last seen to use; an allowance is read for each token a step still to run takes from the address
 * (and for USDC once Aave is owed), until it is found in place.
 */
async function readEvmSide(deps: KeeperDeps, account: string, state: AccountState, mem: AccountMemory, aave: AaveSettings, address: string, steps: PlanStep[], ext: LenderExt[]): Promise<EvmSeen | undefined> {
  const own = readEvm(state);
  if (!own) return undefined;
  if (deps.readEvmNonce && (mem.evmChainNonce === undefined || mem.evmChainNonce < own.nonce)) {
    try {
      mem.evmChainNonce = await deps.readEvmNonce(address);
    } catch (error) {
      deps.log("error", `Aave's chain couldn't be read (${errorText(error)}): the account's steps there wait`, { account });
    }
  }
  const wanted = new Set<string>();
  for (const step of steps) {
    const raw = step.raw as { l?: unknown; tok?: unknown } | null;
    if (step.done || raw?.l !== "aave") continue;
    if ((step.k === "l_supply" || step.k === "l_add") && typeof raw.tok === "string") wanted.add(raw.tok.toLowerCase());
    if (step.k === "l_repay") wanted.add(aave.usdc.address);
  }
  if (ext.some((e) => e.l === "aave" && e.d > 0)) wanted.add(aave.usdc.address);
  for (const token of wanted) {
    if (mem.approved?.includes(token) || !deps.readApproved) continue;
    const ok = await deps.readApproved(token, address, aave.pool).catch(() => false);
    if (ok) mem.approved = [...(mem.approved ?? []), token];
  }
  return {
    nonce: own.nonce,
    ...(mem.evmChainNonce !== undefined ? { chainNonce: mem.evmChainNonce } : {}),
    signed: own.signed.map((e) => {
      const fields = rawFields(e.raw);
      return { nonce: e.nonce, kind: e.kind, step: e.step, ...(fields ? { tip: fields.tip.toString(), fee: fields.maxFee.toString() } : {}), ...(e.signedAtMs !== undefined ? { signedAtMs: e.signedAtMs } : {}) };
    }),
    approved: mem.approved ?? [],
    usdc: aave.usdc.address,
    ...(aave.maxFeePerGas !== null ? { maxFee: aave.maxFeePerGas } : {}),
  };
}

/**
 * research/audit.md P4, the keeper's part (INTERFACES.md 40.4, item 10). The pool works out what a client pays on a
 * lender's part from two reports of the debt there, and nothing reports a debt that has gone: the hourly settlement
 * needs a loan, and a lender repaid may leave none. So after a check, where the pool's last report still shows debt at a lender and
 * the new verdict shows none owed there, the keeper settles once, on that verdict. The pool then holds a report of
 * zero for that lender, and the next look finds nothing to do.
 *
 * Kept cheap. The pool's record is read only when a new verdict has landed, only for a lender that verdict shows
 * nothing owed at, and not again once the record was seen to hold no debt for that lender, until a verdict shows the
 * lender owed again. An account with no pricing record, or with no line for its lenders, costs one read.
 *
 * It answers how its settlement went; "clear" when the pool's record has no debt left to report as zero; null when
 * it couldn't look. INTERFACES.md 45.3, item 10: when the pool skipped the settlement as too soon, one more try is
 * set for when the pool's time between two settlements has passed (noteZeroSettle), and until then nothing is sent
 * from here.
 */
async function settleRepaidLender(deps: KeeperDeps, account: string, state: AccountState, mem: AccountMemory, ext: LenderExt[], planned: Action[], chainBlock: number | undefined, now: number): Promise<Outcome | "clear" | null> {
  const owed = ext.filter((e) => e.d > 0).map((e): string => e.l);
  if (mem.lenderLineClear) mem.lenderLineClear = mem.lenderLineClear.filter((l) => !owed.includes(l));
  if (!deps.readPricing || !deps.settle) return null;
  const open = REPORT_LENDERS.filter((l) => !owed.includes(l) && !mem.lenderLineClear?.includes(l));
  if (open.length === 0) return "clear";
  // The pool skipped this settlement as too soon a moment ago: the next try has its time, and one sent before it
  // would only be skipped again.
  const again = mem.decide.zeroAgain;
  if (again?.at !== undefined && now < again.at) return null;
  // settle() runs on the held verdict, which must be unused and fresh: the first verdict a keeper sees after it
  // starts may be days old. While the account lists a lender action as under way, a verdict may not show that
  // lender's debt yet. And when this tick asks for a check or settles anyway, that reports the position. In each
  // case the line is looked at after the next check.
  const v = state.verdict?.verdict;
  const tooOld = chainBlock === undefined || !v || chainBlock - v.blk > FUND_FRESH_BLOCKS;
  const listed = (Array.isArray(state.pending) ? state.pending : []).some((p) => Boolean((p as { lender?: unknown } | null)?.lender));
  if (!v || tooOld || v.nonce !== state.counter || listed || planned.some((a) => a.kind === "request_check" || a.kind === "settle")) return null;
  let last: { lender: string; debt: string }[];
  try {
    last = (await deps.readPricing(account))?.last ?? [];
  } catch (error) {
    deps.log("error", `the pool's record of what the account pays couldn't be read (${errorText(error)}): it is looked at again after the next check`, { account });
    return null;
  }
  const stale = open.filter((l) => last.some((line) => line.lender === l && WHOLE.test(line.debt) && BigInt(line.debt) > 0n));
  // A lender with no debt in the pool's record needs no further look.
  mem.lenderLineClear = [...(mem.lenderLineClear ?? []), ...open.filter((l) => !stale.includes(l))];
  if (stale.length === 0) return "clear";
  const action: Action = {
    kind: "settle",
    reason: `the pool's last report still shows debt at ${stale.map(lenderName).join(" and ")}, and this check shows nothing owed there: one settlement, so the pool's record says so too`,
    zero: true,
  };
  deps.log("decide", action.reason, { account, action: action.kind });
  // Whether the pool took the report shows in its record: that is read again after the next check, and not after that.
  const outcome = await act(deps, account, action);
  deps.forget?.(account);
  return outcome;
}

/**
 * INTERFACES.md 45.3, item 10: books how the settlement that reports a repaid lender as zero went (decide.ts,
 * afterZeroSettle), and says what follows when the pool skipped it as too soon.
 *
 * How the keeper knows it was skipped: the account's `settle()` answers only `true`, but the account logs the pool's
 * answer in the same transaction, and "too soon" is how the pool's own reason starts (near-tx.ts, settlementIn). No
 * read. How long it waits: the pool's `min_period_ns`, read once when the pool first skips and kept with the retry.
 * If that read fails, the pool's own default of 10 minutes is taken, which is never too short for a pool set lower.
 */
async function noteZeroSettle(deps: KeeperDeps, account: string, memory: Memory, outcome: Outcome): Promise<Memory> {
  if (!outcome.tooSoon) return afterZeroSettle(memory, outcome, deps.now(), 0);
  let waitMs = memory.zeroAgain?.waitMs;
  let unread = "";
  if (waitMs === undefined) {
    const read = deps.readMinPeriodMs ? await deps.readMinPeriodMs().catch(() => null) : null;
    waitMs = typeof read === "number" && read > 0 ? read : DEFAULT_MIN_PERIOD_MS;
    if (waitMs !== read) unread = "; the pool's own figure couldn't be read, so its default is taken";
  }
  const next = afterZeroSettle(memory, outcome, deps.now(), waitMs);
  const seconds = Math.round(waitMs / 1000);
  if (next.zeroAgain?.at !== undefined) {
    deps.log("note", `the pool skipped that settlement as too soon, so its record still shows the lender's debt: one more check, with the settlement behind it, in ${seconds} s, the time the pool keeps between two settlements${unread} (try ${next.zeroAgain.tries + 1} of ${MAX_ZERO_AGAIN})`, { account });
  } else if (next.zeroAgain?.stopped && !memory.zeroAgain?.stopped) {
    deps.log("note", `the pool skipped that settlement as too soon again, after ${MAX_ZERO_AGAIN} more tries: the keeper stops asking, and looks at the pool's record again after the account's next check`, { account });
  }
  return next;
}

function skipSettle(deps: KeeperDeps, account: string): Outcome {
  deps.log("settle", "not settled this time: the check before it brought no verdict, so it goes behind the next check", { account, ok: false, tx: null });
  return { ok: false, retry: true, why: "the check before it failed" };
}

/** One line whenever the account's loan, state, plan, funding plan, lender positions, pending transfers or own drill ratio change. */
function showAccount(deps: KeeperDeps, account: string, state: AccountState, hasLoan: boolean, now: number, mem: AccountMemory, ownRatio: number | null) {
  const plan = readPlan(state);
  const transfers = pendingTransfers(state.pending);
  const funding = readFunding(state);
  const ext = readExt(state.verdict?.verdict.ext);
  const waiting = pendingLender(state.pending);
  const evmOwn = readEvm(state);
  const fields = {
    loan: hasLoan,
    counter: state.counter,
    state: state.verdict?.verdict.state ?? null,
    action: state.verdict?.verdict.action ?? null,
    plan: plan ? { pid: plan.pid, action: plan.action, source: plan.source, steps: plan.steps.map((s) => ({ i: s.i, k: s.k, done: s.done, text: s.text })) } : null,
    first_deleverage_at_ms: nsToMs(state.deleverage?.first_at),
    margin_call_since_ms: nsToMs(state.margin_call?.since),
    pending: transfers.map((t) => ({ id: t.id, kind: t.kind, amount: t.amount, overdue: isOverdue(t, now) })),
    // Phase 6: the funding plan and the lender positions, shown only on accounts that have them.
    ...(funding ? { funding: { pid: funding.pid, amount: funding.amount, expires_at_ms: funding.expiresAtMs, steps: funding.steps.map((s) => ({ i: s.i, k: s.k, done: s.done, text: s.text })) } } : {}),
    ...(ext.length ? { lenders: ext } : {}),
    ...(waiting ? { pending_lender: { lender: waiting.lender, kind: waiting.kind, amount: waiting.amount, until_block: waiting.untilBlock } } : {}),
    // Stage 3: the account's nonce on Aave's chain, the chain's own as last read, and the Aave actions it lists as under way.
    ...(evmOwn ? { evm: { nonce: evmOwn.nonce, chain_nonce: mem.evmChainNonce ?? null, pending: pendingAave(state.pending).map((p) => ({ kind: p.kind, amount: p.amount, evm_nonce: p.evmNonce })) } } : {}),
    ...(ownRatio !== null ? { nbtc_ratio_bp: ownRatio } : {}),
  };
  const shown = JSON.stringify(fields);
  if (shown === mem.shown) return;
  mem.shown = shown;
  const words = hasLoan ? `${fields.state ?? "no verdict"}${plan ? `, plan ${plan.pid} (${plan.action}, ${plan.steps.filter((s) => s.done).length} of ${plan.steps.length} steps done)` : ""}` : "no loan";
  deps.log("account", words, { account, ...fields });
}

async function act(deps: KeeperDeps, account: string, action: Action): Promise<Outcome> {
  switch (action.kind) {
    case "request_check": {
      const r = await deps.requestCheck(account);
      // No transaction outcome came back (the RPC stopped waiting, or the network failed): the check may still be
      // waiting its turn at OutLayer, and its verdict may still land. A failure with a hash is one the chain reported.
      const unseen = !r.ok && r.hash === null;
      const msg = unseen
        ? `the check failed to come back: ${r.failure ?? "no reason given"}. Its verdict may still land, so the keeper asks for another only if none has ${CHECK_WAIT_MS / 1000} s after it asked`
        : !r.ok
          ? `the check failed: ${r.failure ?? "no reason given"}`
          : r.accepted === false
            ? `the account did not keep the verdict: ${r.reason ?? "no reason given"}`
            : "asked for a check; the verdict is in";
      deps.log("check", msg, { account, tx: r.hash, attestation_url: r.attestationUrl, accepted: r.accepted ?? null, reason: r.reason ?? null, seconds: r.seconds, why: action.reason, ...(unseen ? { unseen: true } : {}) });
      // A verdict the account refused (say, another action moved its counter) is asked for again.
      return { ok: r.ok && r.accepted !== false, retry: true, ...(r.failure ? { why: r.failure } : {}), ...(unseen ? { pending: true } : {}) };
    }
    case "cancel_risky":
    case "deleverage": {
      const mode: GatewayMode = action.kind;
      const g = await deps.runGateway(account, mode);
      const out = (g.output ?? {}) as { placed?: unknown; skipped?: unknown; refused?: unknown; cancelled?: unknown; pid?: unknown };
      const msg = g.ok ? `pb-gateway ran ${mode}` : `pb-gateway refused ${mode}: ${g.code ?? "no code"} ${g.reason ?? ""}`.trim();
      deps.log("gateway", msg, {
        account,
        mode,
        ok: g.ok,
        code: g.code,
        reason: g.reason,
        ...("pid" in action && { pid: action.pid }),
        placed: out.placed ?? null,
        skipped: out.skipped ?? null,
        refused: out.refused ?? null,
        cancelled: out.cancelled ?? null,
        call_id: g.callId,
        attestation_url: g.attestationUrl,
        seconds: g.seconds,
        output: g.ok ? undefined : g.output,
      });
      const why = g.code ?? g.reason;
      return { ok: g.ok, retry: g.retry, replan: g.replan, ...(why ? { why } : {}) };
    }
    case "execute_step": {
      const s = await deps.executeStep(account, action.pid, action.i, { k: action.k, ...(action.dep ? { dep: action.dep } : {}) });
      deps.log("step", s.ok ? `execute_step ran step ${action.i} (${action.k}) of plan ${action.pid}` : `execute_step failed for step ${action.i} (${action.k}): ${s.failure ?? "no reason given"}`, {
        account,
        pid: action.pid,
        i: action.i,
        k: action.k,
        ok: s.ok,
        tx: s.hash,
        failure: s.failure ?? null,
        logs: s.logs.filter((l) => l.startsWith("EVENT_JSON:") || /step|refus|plan/i.test(l)).slice(0, 10),
        seconds: s.seconds,
      });
      return { ok: s.ok, retry: s.retry, replan: !s.ok && !s.retry, ...(s.failure ? { why: s.failure } : {}) };
    }
    case "evm_approve":
    case "evm_bump": {
      const call = action.kind === "evm_approve" ? deps.evmApprove?.(account, action.token) : deps.evmBump?.(account, action.nonce, action.maxFee, action.tip);
      if (!call) {
        deps.log("evm", `${action.kind} not called: this keeper has no way to call it`, { account, ok: false, tx: null });
        return { ok: false, retry: false, why: `no ${action.kind}` };
      }
      const s = await call;
      const what = action.kind === "evm_approve" ? `evm_approve for ${action.token}` : `evm_bump for nonce ${action.nonce}`;
      deps.log("evm", s.ok ? `${what}: the account signed the transaction` : `${what} failed: ${s.failure ?? "no reason given"}`, {
        account,
        call: action.kind,
        ...(action.kind === "evm_approve" ? { token: action.token } : { nonce: action.nonce, max_fee: action.maxFee, tip: action.tip }),
        ok: s.ok,
        tx: s.hash,
        failure: s.failure ?? null,
        logs: s.logs.filter((l) => l.startsWith("EVENT_JSON:")).slice(0, 5),
        seconds: s.seconds,
      });
      return { ok: s.ok, retry: true, ...(s.failure ? { why: s.failure } : {}) };
    }
    case "settle": {
      if (!deps.settle) {
        deps.log("settle", "not settled: this keeper has no way to call settle()", { account, ok: false, tx: null });
        return { ok: false, retry: false, why: "no settle()" };
      }
      const s = await deps.settle(account);
      // The account's settle() answers only that the pool's call ran. What the pool did is in the transaction's logs:
      // its own `settle` event, or the account's "the pool settled nothing: <why>".
      const answer = settlementIn(s.logs) ?? s.result;
      const said = settleWords(answer);
      const tooSoon = s.ok && skippedTooSoon(answer);
      deps.log("settle", s.ok ? said.words : `settle() failed: ${s.failure ?? "no reason given"}`, {
        account,
        ok: s.ok,
        tx: s.hash,
        ...(s.ok ? said.fields : {}),
        failure: s.failure ?? null,
        logs: s.logs.filter((l) => l.startsWith("EVENT_JSON:") || /settle|fee|subsid/i.test(l)).slice(0, 10),
        seconds: s.seconds,
      });
      return { ok: s.ok, retry: s.retry, ...(s.failure ? { why: s.failure } : {}), ...(tooSoon ? { tooSoon: true } : {}) };
    }
  }
}

const WHOLE = /^\d+$/;

/** Micro-USD as dollars: "$12.34", and down to a millionth of a dollar for the small sums an hour's settlement makes. */
export function showMicroUsd(value: unknown): string {
  const micro = typeof value === "string" && WHOLE.test(value) ? Number(value) : typeof value === "number" && Number.isFinite(value) ? value : 0;
  const usd = micro / 1e6;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: usd !== 0 && Math.abs(usd) < 1 ? 6 : 2 })}`;
}

/**
 * The pool's answer to a settlement, in words (the stage 2 rules: `{"skipped": "<why>"}`, or `{"fee", "subsidy",
 * "credit", "period_ns"}` with micro-USD in strings). An answer in another shape is said as it is.
 *
 * INTERFACES.md 45.1: `cut` is what the pool's 24-hour budgets took off, from a subsidy and now from a fee too. It
 * isn't owed later, and it is said whenever it is above zero.
 */
export function settleWords(result: unknown): { words: string; fields: Record<string, unknown> } {
  const r = (result && typeof result === "object" ? result : {}) as { skipped?: unknown; fee?: unknown; subsidy?: unknown; credit?: unknown; period_ns?: unknown; cut?: unknown };
  if (typeof r.skipped === "string") return { words: `nothing settled: ${r.skipped}`, fields: { skipped: r.skipped } };
  const positive = (v: unknown) => (typeof v === "string" && WHOLE.test(v) && Number(v) > 0) || (typeof v === "number" && v > 0);
  const fields = { fee: r.fee ?? null, subsidy: r.subsidy ?? null, credit: r.credit ?? null, period_ns: r.period_ns ?? null, ...(r.cut !== undefined ? { cut: r.cut } : {}) };
  const cut = positive(r.cut) ? showMicroUsd(r.cut) : null;
  if (positive(r.fee)) {
    const less = cut ? `; the pool's 24-hour fee limits took ${cut} off it, which isn't owed later` : "";
    return { words: `settled: a fee of ${showMicroUsd(r.fee)} was added to what the account owes our pool${less}`, fields };
  }
  if (positive(r.subsidy)) {
    const credit = positive(r.credit) ? `; ${showMicroUsd(r.credit)} of credit is the account's to claim` : "";
    const less = cut ? `; the pool's 24-hour subsidy budgets took ${cut} off it` : "";
    return { words: `settled: a subsidy of ${showMicroUsd(r.subsidy)} was taken off what the account owes our pool${credit}${less}`, fields };
  }
  if (cut) return { words: `settled: nothing added or taken off, because the pool's 24-hour limits cut all ${cut} of it`, fields };
  if ("fee" in r || "subsidy" in r) return { words: "settled: nothing to add or take off this time", fields };
  return { words: `settle() answered ${JSON.stringify(result ?? null)}`, fields: { answer: result ?? null } };
}

/** Pending 1Click transfers: overdue ones are logged once; NEAR deposit addresses are polled for 1Click's status. */
async function pollTransfers(deps: KeeperDeps, account: string, state: AccountState, mem: AccountMemory, now: number) {
  const transfers = pendingTransfers(state.pending);
  for (const t of transfers) {
    const known: TransferSeen = mem.transfers[t.id] ?? { status: null, polledAt: 0, overdue: false };
    if (!known.overdue && isOverdue(t, now)) {
      known.overdue = true;
      deps.log("transfer", `transfer ${t.id} (${t.kind}) is overdue: its deadline has passed, so borrowing and withdrawing with a loan are refused`, { account, ...t });
    }
    // INTERFACES.md 40.4, item 12 (research/audit.md A7): a deadline further off than any real quote's, said once.
    if (!known.far && t.deadlineMs !== null && t.deadlineMs - now > MOVE_FAR_MS) {
      known.far = true;
      const hours = Math.round((t.deadlineMs - now) / 3_600_000);
      deps.log(
        "move_far",
        `transfer ${t.id} (${t.kind}) is listed as on its way until ${new Date(t.deadlineMs).toISOString()}, ${hours} hours from now. A 1Click quote lasts a day at most, so no real transfer has a deadline that far off. Only an account made before the fix of 12 Nov can record one`,
        { account, ...t, hours_ahead: hours },
      );
    }
    // Hyperliquid deposits all go to the stand-in's float, which tells them apart by memo; the account doesn't keep
    // the memo, so only NEAR deposit addresses can be asked about.
    if (deps.transferStatus && !t.dep.startsWith("0x") && now - known.polledAt >= TRANSFER_POLL_MS) {
      known.polledAt = now;
      const status = await deps.transferStatus(t.dep).catch(() => null);
      if (status && status !== known.status) {
        deps.log("transfer", `1Click says ${status} for transfer ${t.id} (${t.kind})`, { account, id: t.id, kind: t.kind, dep: t.dep, status });
        known.status = status;
      }
    }
    mem.transfers[t.id] = known;
  }
  for (const id of Object.keys(mem.transfers)) {
    if (transfers.some((t) => t.id === id)) continue;
    deps.log("transfer", `transfer ${id} is no longer pending`, { account, id, last_status: mem.transfers[id]!.status });
    delete mem.transfers[id];
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
