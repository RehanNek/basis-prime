// What the keeper does for one account on each tick (PLAN.md 5.7; INTERFACES.md 17), as a pure function of what it
// sees now and what it remembers. The effects (request_check, the gateway's modes, execute_step) live in loop.ts.
//
//   - Every 15 s: a price that crossed one of the last verdict's bands since the last tick asks for a check.
//   - During a margin call (or worse): a check at least every 5 minutes, so the contract's clock stays close.
//   - Each hour, at a random minute: a check, so the rating's hourly record has samples the client can't time.
//   - DELEVERAGE: the second check comes about 2.5 minutes after the first verdict arrived (the contract confirms
//     a plan with a second DELEVERAGE verdict 2 to 5 minutes after the first, and stores it).
//   - A stored plan: the gateway's `deleverage` mode places its cancel and perp steps, execute_step runs the rest.
//     Then a check, and more checks until the account is HEALTHY.
//   - REBALANCE and REBALANCE_NOW: the account stores the plan at once, and the keeper runs it at once.
//   - Leaving HEALTHY: the gateway's `cancel_risky` mode cancels the resting orders that add risk.
//
// Phase 6, stage 2 (FUNDING.md 7.1; INTERFACES.md 25 and 28):
//   - A funding plan (the owner's `fund`): its steps run in order, as soon as it is stored and until it expires. Before
//     a step that borrows (`l_borrow`, `p_borrow`), and before posting collateral while the account owes our pool, the
//     keeper asks for the fresh check the step needs. After a Rhea borrow it waits out the 20 blocks the account
//     counts it as under way.
//   - A top-up plan (REBALANCE): its `l_add` and `l_repay` steps run like any other stored step.
//   - A lender's cushion: when bitcoin has moved enough since the last verdict to bring it near 1.35, a check.
//   - Once an hour, after the hourly check: the account's `settle()`, where a lender is owed or the account's policy
//     at our pool isn't pass-through (INTERFACES.md 45.3, item 9).
//   - When the pool skips, as too soon, the settlement that reports a repaid lender as zero: one more check with
//     that settlement behind it once the pool's time between two settlements has passed, twice at most (item 10).
//
// Stage 3 (INTERFACES.md 33): Aave, on its own chain. The account signs Ethereum transactions there, and the keeper
//   - approves a token for Aave's Pool (`evm_approve`) before the first supply or repayment of it;
//   - runs no funding step, and no Aave top-up step, while a signed transaction isn't mined yet;
//   - asks for one fresh check once a transaction that changes the position is mined, and acts for Aave on no
//     verdict from before it;
//   - signs a transaction that stays unmined again with a higher tip (`evm_bump`), inside the config's fee limit.
//   Sending the signed transactions is an effect, in loop.ts and evm.ts.
//
// Stage 4 (INTERFACES.md 36): the client starts every move between NEAR and Aave's chain; the keeper runs none. It
//   asks for one check when the stand-in says a `to_evm` is delivered, loan or no loan: the account can't see Aave's
//   chain, so only a verdict's `arrived` settles that transfer, and USDC that arrived must be settled before it is
//   spent. A signed `e_home` transfer is sent like any signed transaction (loop.ts).
//
// The keeper takes its timing from the chain where it can (the plan's pid, deleverage.first_at, each step's `done`),
// so a restarted keeper picks up where the last one stopped. Running a step twice is refused by the account or the
// gateway, so a repeat only costs a call.
import { bandLevels, bigMoves, crossingWords, crossings, sidesOf, type Prices, type Side } from "./bands.js";
import { cushionMove } from "./cushion.js";
import { FUNDING_KINDS, lenderName, MOVE_KINDS, QUOTE_MARGIN_MS, TOP_UP_KINDS, type FundingView, type LenderExt, type PendingLender, type PlanStep, type PlanView } from "./plan.js";

/** The engine's states and actions (RISK_ENGINE.md 8.1-8.2). */
export type RiskState = "HEALTHY" | "WATCH" | "MARGIN_CALL" | "DELEVERAGE" | "DEFAULT";
export type RiskAction = "NONE" | "REBALANCE" | "REBALANCE_NOW" | "DELEVERAGE";

/** The account's held verdict, in the keeper's terms. */
export interface Verdict {
  state: RiskState;
  action: RiskAction;
  /** The block pb-risk read. A stored plan's pid is this blk, as a string (INTERFACES.md 13). */
  blk: number;
  nonce: number;
  /** The block the account stored it in. */
  receivedBlock: number;
  /** When the account stored it (block time, ms). */
  at: number;
  bands?: unknown;
  /** NEAR-side tokens the verdict counts (its pool.hold). */
  tokens?: string[];
  /** Phase 6: what the verdict lets our pool lend now (allow.borrow, micro-USD), where it says. */
  allowBorrow?: number;
  /** Stage 3: the verdict's `evm.nonce`, how many of the account's transactions Aave's chain had used when it was read. */
  evmNonce?: number;
  /**
   * INTERFACES.md 47.5: the verdict's own plan, step by step, by kind, lender and token. The keeper never runs it:
   * it runs the plan the account stores. It only tells whether this verdict orders the stored plan's steps again.
   */
  planSteps?: { k: string; l?: string; tok?: string }[];
}

/** Stage 3: the account's side on Aave's chain, for an account whose config has Aave (INTERFACES.md 33). */
export interface EvmSeen {
  /** The account's own next nonce: how many transactions it has signed. */
  nonce: number;
  /** How many of them the chain has used, as last read; undefined if it was never read. */
  chainNonce?: number;
  /**
   * get_state().evm.signed, oldest first. `tip` and `fee` are the transaction's own tip and fee limit, in wei.
   * `signedAtMs` is the block time it was signed at (the view's `signed_at`), where the account says.
   */
  signed: { nonce: number; kind: string; step: string | null; tip?: string; fee?: string; signedAtMs?: number }[];
  /** The tokens (addresses, lowercase) Aave's Pool is known to be approved for. */
  approved: string[];
  /** The config's USDC there, and its fee limit in wei. */
  usdc: string;
  maxFee?: string;
}

/** What the keeper sees of one account this tick. */
export interface Seen {
  /** A loan from our pool, or (Phase 6) a debt at a lender in the held verdict's `ext`. */
  hasLoan: boolean;
  counter: number;
  verdict: Verdict | null;
  /** deleverage.first_at, in ms; 0 when no DELEVERAGE pair is open. */
  firstDeleverageAtMs: number;
  plan: PlanView | null;
  prices: Prices;
  /** Hyperliquid perps the account holds, by coin. */
  perps: string[];
  /** The final block's time (ms): first_at is block time, so the second check is timed on the chain's clock. */
  chainNowMs?: number;
  /** The ids of the account's pending 1Click transfers. */
  transfers?: string[];
  /** Phase 6 (INTERFACES.md 28): the held verdict's `ext`, the account's position at each lender. */
  ext?: LenderExt[];
  /** Phase 6, stage 2: the funding plan `fund` stored, if any. */
  funding?: FundingView | null;
  /** A lender action the account still lists as under way. */
  pendingLender?: PendingLender | null;
  /** The final block's height at the start of the tick: the pending action's block and a verdict's age are measured against it. */
  chainBlock?: number;
  /** Whether the account owes our pool. Posting collateral at a lender then needs a fresh check (INTERFACES.md 24, point 8). */
  owesPool?: boolean;
  /** Stage 3: the account's transactions on Aave's chain. */
  evm?: EvmSeen;
  /** Stage 4: the ids of the account's pending `to_evm` transfers that the stand-in says are delivered. */
  delivered?: string[];
  /**
   * INTERFACES.md 40.1 (the audit's A8): the block the account's permission last changed in (get_state's
   * `permission_blk`). The account runs a lender's step only on a verdict read after it. Changing the permission
   * doesn't move the counter any more, so this is the only sign of it. Undefined on an account from before the fix.
   */
  permissionBlk?: number;
  /**
   * INTERFACES.md 44: the prices the keeper read for this account on its last ticks, oldest first and this tick's
   * last, each with the final block's height when its tick began. Kept for KEEP_PRICES_MS.
   */
  kept?: KeptPrices[];
  /**
   * INTERFACES.md 45.3, item 9: whether the account's pricing policy at our pool is anything but pass-through (the
   * pool's `get_pricing`), as read on the tick the hourly check is due. Undefined when it wasn't read: the hour's
   * settlement then goes out only where a lender is owed.
   */
  priced?: boolean;
  /**
   * INTERFACES.md 49.4: a check the client's page asked the keeper for is on its way for this account, or its verdict
   * has just landed and waits for the client's own action. The keeper asks for no check of its own meanwhile: one
   * would queue behind it, or replace the verdict the client is about to act on.
   */
  clientCheck?: boolean;
}

/** INTERFACES.md 44: what the keeper read for an account on one tick. */
export interface KeptPrices {
  /** The final block's height when the tick began. */
  block: number;
  /** The keeper's clock then, ms. */
  at: number;
  prices: Prices;
}

export interface StepRun {
  state: "sent" | "retry" | "failed" | "expired";
  tries: number;
  at: number;
  why?: string;
}

/** What the keeper did with one funding plan (get_state().funding), by its pid. */
export interface FundingRun {
  /** execute_step, by step index. */
  steps: Record<number, StepRun>;
  /** The fresh checks asked for step `i`: how many, and when the last one went. */
  check?: { i: number; tries: number; at: number; key?: string };
  /** Notes already written for this plan, so each is said once. */
  said?: string[];
  /** A check was asked for once every step had run. */
  rechecked?: boolean;
  /** The keeper gave up on the plan: a step was refused too often, or no check would back it. */
  stopped?: boolean;
}

/** What the keeper did with one stored plan. */
export interface PlanRun {
  /** The gateway's `deleverage` run for this plan. */
  gateway?: StepRun;
  /** execute_step, by step index. */
  steps: Record<number, StepRun>;
  /** A check was asked for once every step had run. */
  rechecked?: boolean;
  /** Something refused a step: a new plan is needed. */
  replan?: boolean;
  replanAsked?: boolean;
  /** INTERFACES.md 47.7: a top-up step didn't go out in MAX_TRIES tries. Since when: the check for a new plan waits TOP_UP_AGAIN_MS from here. */
  gaveUpAt?: number;
}

/** What the keeper remembers about an account between ticks. */
export interface Memory {
  /** "<blk>:<received_block>" of the verdict last seen. */
  verdictKey?: string;
  lastState?: RiskState;
  /** When the keeper last asked for a check, and the prices then. */
  lastCheckAt?: number;
  checkPrices?: Prices;
  lastCounter?: number;
  /** Since when nothing changed: neither the counter nor the verdict. */
  quietSince?: number;
  /** The verdict already refreshed because an action used it. */
  refreshedFor?: string;
  /** Which side of each band the prices were on at the last tick. */
  sides?: Record<string, Side>;
  /** The prices the held verdict is measured from (see `base` in decide), and the big moves already acted on. */
  refPrices?: Prices;
  moved?: string[];
  nextHourlyAt?: number;
  /** The second DELEVERAGE check sent for the pair that opened at `firstAt`. */
  secondCheck?: { firstAt: number; sentAt: number; tries: number };
  plans?: Record<string, PlanRun>;
  /** A plan ran at this time: checks go on until the account is HEALTHY. */
  recoveringSince?: number;
  /** The verdict for which cancel_risky was called. */
  cancelledFor?: string;
  /** A check that failed to send, to send again. */
  retryCheck?: { reason: string; tries: number };
  /**
   * The check the keeper last asked for, while its end isn't known. A verdict can take a minute or two to come back
   * when OutLayer's queue is long, and a second check asked for meanwhile only queues behind the first: so until this
   * one's verdict lands, it is known to have failed, or CHECK_WAIT_MS has passed, the keeper asks for no other.
   */
  checkPending?: { at: number };
  /** What asked for a check while that one was under way: one check for all of it goes out when it is over. */
  checkHeld?: string[];
  /** Stage 3: the evm_approve calls the keeper made, by token: how many, and when the last one went. */
  approvals?: Record<string, { tries: number; at: number; said?: boolean }>;
  /** The fresh check asked for once the account's transactions on Aave's chain were mined: at which nonce, and when. */
  evmRecheck?: { nonce: number; at: number };
  /** Stage 4: the delivered `to_evm` transfers a check was already asked for. Kept with or without a loan. */
  arrivedAsked?: string[];
  /** The lowest transaction the chain hasn't used: since when the keeper has seen it so, and the bumps it made. */
  evmStuck?: { nonce: number; since: number; bumps: number; at?: number; said?: boolean };
  /** Phase 6: the funding plans the keeper is running or has run, by pid. */
  fundings?: Record<string, FundingRun>;
  /** The lenders whose cushion already asked for a check under this verdict. */
  lenderAsked?: string[];
  /**
   * A check failed MAX_TRIES times in a row and brought no verdict: since when. CHECK_AGAIN_MS later, what asked for
   * it is asked again if it still holds (INTERFACES.md 48.11).
   */
  checkGaveUpAt?: number;
  /** The hourly settlement is due: it goes out right after the next check. `tries` counts the ones that didn't go. */
  settleDue?: { tries: number };
  /**
   * INTERFACES.md 45.3, item 10: the pool skipped, as too soon, the settlement that reports a repaid lender as zero.
   * One more check with that settlement behind it goes out at `at`, MAX_ZERO_AGAIN times at most.
   */
  zeroAgain?: ZeroAgain;
  /**
   * A lender action is (or was) listed as under way until this block. Until a verdict read after it is held, the
   * keeper doesn't act for the lender on what it holds.
   */
  lenderUntil?: number;
  /** Checks were held back while that action was under way: one goes out as soon as its block has passed. */
  lenderHeld?: boolean;
  /** The fresh check asked for once `until` had passed, and when. */
  lenderRecheck?: { until: number; at: number };
}

export type Action =
  | { kind: "request_check"; reason: string }
  | { kind: "cancel_risky"; reason: string }
  | { kind: "deleverage"; pid: string; reason: string }
  | { kind: "execute_step"; pid: string; i: number; k: string; reason: string; dep?: string }
  /** `zero`: the settlement that reports a repaid lender as zero (INTERFACES.md 40.4, item 10, and 45.3, item 10). */
  | { kind: "settle"; reason: string; zero?: true }
  /** Stage 3: `evm_approve(token)`, and `evm_bump(nonce, max_fee, tip)` with fees in wei. */
  | { kind: "evm_approve"; token: string; reason: string }
  | { kind: "evm_bump"; nonce: number; maxFee: string; tip: string; reason: string };

/** How an action went. `retry`: it may work on a later tick. `replan`: the plan can't run; a new verdict is needed. */
export interface Outcome {
  ok: boolean;
  retry?: boolean;
  replan?: boolean;
  why?: string;
  /** A check that was sent, but whose end the keeper didn't see: its verdict may still land. */
  pending?: boolean;
  /** A settlement that went through, and that the pool skipped because the account's last one was too short a time ago. */
  tooSoon?: boolean;
}

/** INTERFACES.md 45.3, item 10: the settlement that reports a repaid lender as zero, to be tried again. */
export interface ZeroAgain {
  /**
   * When the next try may go: the pool's `min_period_ns` after the try the pool skipped. Left out once that try is
   * asked for, until its settlement's end is known.
   */
  at?: number;
  /** The tries asked for so far. */
  tries: number;
  /** The pool's `min_period_ns` in ms, as the keeper read it when the pool first skipped. */
  waitMs: number;
  /**
   * The pool skipped the last try too: the keeper asks no more, and looks at the pool's record again after the
   * account's next check, as it did before. It starts afresh once that record shows no debt left to report.
   */
  stopped?: true;
}

export interface Decision {
  actions: Action[];
  memory: Memory;
  /** Things worth a log line that are not actions. */
  notes: string[];
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
/** The contract's two-check window: 2 to 5 minutes after the first DELEVERAGE verdict arrived. */
export const SECOND_CHECK_AFTER_MS = 2 * MINUTE;
export const SECOND_CHECK_BEFORE_MS = 5 * MINUTE;
/** The keeper aims for 2.5 minutes, so the verdict lands well inside the window even if OutLayer is slow. */
export const SECOND_CHECK_AIM_MS = 150 * SECOND;
/** A second check whose verdict hasn't confirmed the plan is tried again after this, while the window is open. */
export const SECOND_CHECK_RETRY_MS = 40 * SECOND;
export const SECOND_CHECK_LAST_MS = 270 * SECOND;
export const MARGIN_CALL_CHECK_MS = 5 * MINUTE;
/** After a plan ran, checks go on every 5 minutes for up to an hour until the account is HEALTHY. */
export const RECOVER_CHECK_MS = 5 * MINUTE;
export const RECOVER_FOR_MS = 60 * MINUTE;
/** A verdict an action used describes the book before it: refresh it after a minute with no changes. */
export const QUIET_MS = MINUTE;
/** A failed step or gateway run is tried again after this, at most MAX_TRIES times in all. */
export const RETRY_AFTER_MS = 15 * SECOND;
export const MAX_TRIES = 3;
/** A step whose transaction went through shows `done` within a tick; after this the keeper may try it again. */
export const SENT_WAIT_MS = MINUTE;
/**
 * One check at a time (11 Nov). A check waits its turn in OutLayer's queue, 30 to 100 s on a slow day, before its
 * verdict comes back. One whose end the keeper didn't see is given this long to bring its verdict or fail before
 * another is asked for, at most MAX_TRIES times in all. Whatever asks for a check meanwhile is kept, and goes out as
 * one check when the first is over.
 */
export const CHECK_WAIT_MS = 150 * SECOND;
/** A check the keeper asked for this recently: the verdict that comes back is measured from the prices then. */
const CHECK_PRICES_FOR_MS = 4 * MINUTE;
/**
 * A funding step that borrows needs a verdict at most 120 blocks old when it runs (the account's FRESH_BLOCKS). The
 * keeper runs it only on one at most 90 blocks old, so the step's own transaction still lands in time.
 */
export const FUND_FRESH_BLOCKS = 90;
/**
 * A funding step's check that brought no verdict the step can run on is asked again after this, at most
 * MAX_FUND_CHECKS times in all: the same wait and the same three tries as any other check.
 */
export const FUND_CHECK_EVERY_MS = CHECK_WAIT_MS;
export const MAX_FUND_CHECKS = 3;
/** The fresh check after a lender action is asked again after this, while no verdict from after it is held. */
export const LENDER_RECHECK_MS = CHECK_WAIT_MS;
/**
 * After a check has failed MAX_TRIES times in a row (OutLayer gave no verdict for six minutes on 13 Nov), how long
 * until a band still crossed, a move still as big or a cushion still thin asks for one again. Without it each of
 * those asks once per verdict, and with no new verdict nothing would ask until the hourly check.
 */
export const CHECK_AGAIN_MS = 2 * MINUTE;
/**
 * Stage 3: a signed Ethereum transaction that the chain still hasn't used after this long is signed again with
 * higher fees, at most MAX_BUMPS times. Blocks on Aave's test chain are 2 s or less, so one that waits three minutes
 * is stuck.
 *
 * INTERFACES.md 47.1 (research/audit.md A10). The account takes a bump whose fee limit is between a tenth and an
 * eighth above the kept one, and whose tip is at least a tenth above the kept tip and not above the new fee limit.
 * So the keeper sends the kept fee limit and a tenth, rounded up (the lowest value the account takes), and ten
 * times the tip, never above that fee limit. It used to send the config's whole limit, which left no later bump
 * any room. A first try is signed at half the config's limit, so seven bumps of a tenth fit under it. Once a
 * tenth more would be above the limit, the keeper says so once instead of asking. An account from before 47.1
 * takes the same values.
 */
export const EVM_BUMP_AFTER_MS = 3 * MINUTE;
export const MAX_BUMPS = 7;
/**
 * INTERFACES.md 47.7, item 4. A top-up's step at Rhea asks our pool first, and the pool refuses it while it is
 * paused or past the day's step limit: nothing moves, and the step may run again. That can last hours. So when a
 * top-up step hasn't gone out in MAX_TRIES tries, the keeper says so once and asks for the check that brings a new
 * plan only after this long, not at once. Three minutes: long enough that the check is read 100 blocks after the
 * plan it replaces (the account keeps a plan that long, INTERFACES.md 47.5), and short for a client who needs the
 * top-up. The main session set it; the first build waited ten.
 */
export const TOP_UP_AGAIN_MS = 3 * MINUTE;
/** INTERFACES.md 47.1: the account makes anyone but its owner wait this long after a transaction was signed before a bump. */
export const EVM_BUMP_SIGNED_WAIT_MS = MINUTE;
/** The first tip an account signs with is 1,000,000 wei (INTERFACES.md 33); a bump goes to at least ten times that. */
const MIN_BUMP_TIP_WEI = 10_000_000n;
/** At most this many reasons are kept for the check that waits behind another. */
const MAX_HELD_REASONS = 8;
/**
 * INTERFACES.md 45.3, item 10. When the pool skips, as too soon, the settlement that reports a repaid lender as zero,
 * the keeper asks for one more check with that settlement behind it once the pool's `min_period_ns` has passed: this
 * many times at most. Until then the pool's record still shows the debt, and a client who borrows there again would
 * be charged for the time in between.
 */
export const MAX_ZERO_AGAIN = 2;
const ZERO_CHECK = "the pool skipped, as too soon, the settlement that reports a repaid lender as zero, and the time it keeps between two settlements has passed: one more check, with that settlement behind it";
const ZERO_SETTLE = "the settlement that reports a repaid lender as zero, again, on the check just made: the pool skipped the last one as too soon";
const HOURLY_SETTLE = "the hourly settlement, on the check just made: what the client pays on the lender's part against the operator's price";

/** A random minute of the next clock hour. */
export function nextHourlyCheck(now: number, random: () => number = Math.random): number {
  const nextHour = (Math.floor(now / (60 * MINUTE)) + 1) * 60 * MINUTE;
  return nextHour + Math.floor(random() * 60) * MINUTE;
}

export function verdictKey(v: Verdict | null): string {
  return v ? `${v.blk}:${v.receivedBlock}` : "none";
}

/** INTERFACES.md 44: each tick's prices are kept this long. */
export const KEEP_PRICES_MS = 10 * MINUTE;

/**
 * INTERFACES.md 44: the prices to measure from for a verdict the keeper didn't ask for, read at block `blk`: what the
 * keeper itself had read by that block, not what it reads now. Undefined when it has kept nothing that old.
 *
 * A kept tick's number and the verdict's `blk` are both final blocks. But the engine reads everything at that one
 * block, and the keeper doesn't: its own reads see the chain's newest block, a little past the final one, and in a
 * tick where it sets our Rhea copy's price it carries the price it has just set, which lands some blocks later still.
 * So a tick that began at or before `blk` can already hold a move the verdict doesn't have. The tick before it
 * can't: all it read, it read before that later tick began. So of the kept ticks at or before `blk` the newest is
 * passed over and the one before it is taken: an earlier reference, never a later one. With only one, that one.
 *
 * A tick with no price for a lender that another kept tick has one for (the read failed) is passed over too, so a
 * lender's cushion is measured on the lender's own price at both ends.
 */
export function pricesAtBlock(kept: KeptPrices[] | undefined, blk: number): Prices | undefined {
  const all = kept ?? [];
  const lenders = [...new Set(all.flatMap((k) => Object.keys(k.prices.lenders ?? {})))];
  const within = all.filter((k) => k.block <= blk);
  const before = within.length > 1 ? within.slice(0, -1) : within;
  return before.filter((k) => lenders.every((l) => k.prices.lenders?.[l] !== undefined)).at(-1)?.prices;
}

export function decide(memory: Memory, seen: Seen, now: number, random: () => number = Math.random): Decision {
  const v = seen.verdict;
  const key = verdictKey(v);

  // States apply only while there is a loan (RISK_ENGINE.md 8.1). Without one there is nothing to watch, and the
  // schedules start again when a loan does. Phase 6: a funding plan with steps still to run is where a loan starts,
  // so the account is watched from the moment `fund` stores it.
  const funding = seen.funding && seen.funding.steps.length > 0 ? seen.funding : null;
  const fundingLive = Boolean(funding && funding.steps.some((s) => !s.done) && (funding.expiresAtMs === null || (seen.chainNowMs ?? now) <= funding.expiresAtMs));
  // Stage 4: a `to_evm` the stand-in says is delivered, and that no check was asked for yet.
  const arrivals = (seen.delivered ?? []).filter((id) => !(memory.arrivedAsked ?? []).includes(id));
  const arrivalWords = `the stand-in says ${arrivals.length === 1 ? `transfer ${arrivals[0]}` : `transfers ${arrivals.join(", ")}`} to Aave's chain ${arrivals.length === 1 ? "is" : "are"} delivered: a check, whose verdict settles ${arrivals.length === 1 ? "it" : "them"} once it sees the money at the address`;
  if (!seen.hasLoan && !fundingLive) {
    const kept: Memory = { verdictKey: key, lastCounter: seen.counter, ...(v && { lastState: v.state }) };
    // With no loan there is one thing left to do: that check, one at a time, asked again if it fails (three tries).
    const landed = key !== memory.verdictKey;
    const out = landed ? undefined : memory.checkPending;
    const again = landed ? undefined : memory.retryCheck;
    const wait = (out !== undefined && now - out.at < CHECK_WAIT_MS) || seen.clientCheck === true;
    const asked = [...(memory.arrivedAsked ?? []), ...(wait ? [] : arrivals)].slice(-50);
    // INTERFACES.md 45.3, item 10: the settlement that reports a repaid lender as zero, which the pool skipped as too
    // soon. A lender repaid often leaves no loan at all, so it is tried again here too: one more check once the
    // pool's time between two settlements has passed, with the settlement behind it. One that was asked for and
    // hasn't gone (its check failed) goes behind the next check.
    const zero = memory.zeroAgain;
    const zeroDue = zero !== undefined && zero.at !== undefined && now >= zero.at && zero.tries < MAX_ZERO_AGAIN;
    const zeroOpen = zero !== undefined && zero.at === undefined && !zero.stopped;
    const rest: Memory = { ...kept, ...(asked.length ? { arrivedAsked: asked } : {}), ...(out ? { checkPending: out } : {}), ...(again ? { retryCheck: again } : {}), ...(zero ? { zeroAgain: zero } : {}) };
    const reason = wait ? null : arrivals.length ? arrivalWords : again ? `again: ${again.reason}` : zeroDue ? ZERO_CHECK : null;
    if (!reason) return { actions: [], notes: [], memory: rest };
    const actions: Action[] = [{ kind: "request_check", reason }];
    if (zeroDue || zeroOpen) actions.push({ kind: "settle", reason: ZERO_SETTLE, zero: true });
    return { actions, notes: [], memory: { ...rest, lastCheckAt: now, ...(zeroDue ? { zeroAgain: { tries: zero.tries + 1, waitMs: zero.waitMs } } : {}) } };
  }

  const next: Memory = { ...memory, plans: { ...(memory.plans ?? {}) } };
  const actions: Action[] = [];
  const notes: string[] = [];
  const reasons: string[] = [];
  const fresh = key !== memory.verdictKey;
  if (fresh || seen.counter !== memory.lastCounter) next.quietSince = now;
  next.lastCounter = seen.counter;
  // A loan that starts under a verdict already seen: the big-move test measures from now.
  next.refPrices ??= seen.prices;
  // One check at a time. A verdict that has landed ends the wait for the check the keeper asked for, and is the
  // answer a failed one was to be asked again for.
  if (fresh) {
    next.checkPending = undefined;
    next.retryCheck = undefined;
  }
  const pendingAt = next.checkPending?.at;
  // INTERFACES.md 49.4: a check the client's page asked for through the keeper counts as one on its way too.
  const busy = (pendingAt !== undefined && now - pendingAt < CHECK_WAIT_MS) || seen.clientCheck === true;

  // ---------- a new verdict, and the band triggers ----------
  const levels = v ? bandLevels(v.bands) : [];
  if (fresh) {
    next.verdictKey = key;
    next.moved = [];
    next.lenderAsked = undefined;
    // A verdict the keeper asked for was made with the prices of the moment it asked, so a band crossed since then
    // shows at once. Any other verdict is measured from what the keeper had read by the verdict's own block
    // (INTERFACES.md 44): a price that moved between that block and this first sight of the verdict is in neither
    // the verdict nor the prices of now. Only when nothing that old is kept is it measured from now.
    const askedRecently = memory.lastCheckAt !== undefined && now - memory.lastCheckAt <= CHECK_PRICES_FOR_MS && memory.checkPrices;
    const base = askedRecently ? memory.checkPrices! : ((v ? pricesAtBlock(seen.kept, v.blk) : undefined) ?? seen.prices);
    next.refPrices = base;
    next.sides = sidesOf(levels, base);
    if (v) {
      if (v.state !== "HEALTHY" && (memory.lastState === undefined || memory.lastState === "HEALTHY")) {
        actions.push({ kind: "cancel_risky", reason: memory.lastState === "HEALTHY" ? `the account left HEALTHY for ${v.state}` : `the account is ${v.state} when the keeper first sees it` });
        next.cancelledFor = key;
      }
      next.lastState = v.state;
      if (v.state === "HEALTHY") next.recoveringSince = undefined;
    }
  }
  // A check given up on brought no verdict, so everything below that asks "once per verdict" has asked already.
  // CHECK_AGAIN_MS later those marks are put back to where the verdict left them: what still holds asks again.
  if (fresh) next.checkGaveUpAt = undefined;
  else if (v && memory.checkGaveUpAt !== undefined && now - memory.checkGaveUpAt >= CHECK_AGAIN_MS) {
    next.checkGaveUpAt = undefined;
    next.moved = [];
    next.lenderAsked = undefined;
    next.sides = sidesOf(levels, next.refPrices ?? seen.prices);
  }
  if (v) {
    for (const crossing of crossings(levels, next.sides ?? {}, seen.prices)) reasons.push(crossingWords(crossing));
    next.sides = { ...(next.sides ?? {}), ...sidesOf(levels, seen.prices) };
    const moves = bigMoves({ perps: seen.perps, tokens: v.tokens ?? [] }, levels, next.refPrices ?? seen.prices, seen.prices, next.moved ?? []);
    for (const move of moves) reasons.push(move.words);
    if (moves.length) next.moved = [...(next.moved ?? []), ...moves.map((m) => m.asset)];
  }

  // ---------- Phase 6: a lender action under way ----------
  // For 20 blocks after a borrow or a withdrawal at Rhea the account lists it in `pending`. A verdict read in that
  // time can show the lender's cushion too low, and a check asked for in it is refused if its verdict lands after
  // (the account's counter moves when the wait ends). So while it lasts the keeper asks for no check; once the block
  // has passed it asks for one fresh check; and until that verdict is held it doesn't act for the lender (a top-up,
  // a funding step, the cushion watch) on the one from before.
  const wait: LenderWait = { waiting: false, readEarly: false };
  if (seen.chainBlock !== undefined) {
    const listed = seen.pendingLender;
    if (listed && listed.untilBlock > (next.lenderUntil ?? 0)) next.lenderUntil = listed.untilBlock;
    if (next.lenderUntil !== undefined && v && v.blk > next.lenderUntil) {
      // A verdict read after the action's blocks: the wait is over.
      next.lenderUntil = undefined;
      next.lenderHeld = undefined;
    }
    const until = next.lenderUntil;
    if (until !== undefined) {
      wait.until = until;
      wait.what = listed ? `its ${listed.kind === "withdraw" ? "withdrawal" : listed.kind} at ${lenderName(listed.lender)}` : "a lender action";
      wait.waiting = seen.chainBlock <= until;
      wait.readEarly = true;
      // One fresh check once the block has passed. If its verdict never lands (the check failed for good), another
      // goes out 150 s later, so the lender isn't left unwatched until the hourly check. While another check is on
      // its way this one waits: that one's verdict, read after the block, is the fresh one.
      const asked = next.lenderRecheck?.until === until ? next.lenderRecheck : undefined;
      if (!wait.waiting && !busy && (!asked || now - asked.at >= LENDER_RECHECK_MS)) {
        reasons.push(`the account counted ${wait.what} as under way until block ${until}, which has passed: a fresh check`);
        next.lenderRecheck = { until, at: now };
        next.lenderHeld = undefined;
        wait.asked = true;
      }
    }
  }

  // ---------- Stage 4: a move to Aave's chain that the stand-in says is delivered ----------
  if (arrivals.length && !busy) {
    reasons.push(arrivalWords);
    next.arrivedAsked = [...(next.arrivedAsked ?? []), ...arrivals].slice(-50);
  }

  // ---------- Stage 3: the account's transactions on Aave's chain ----------
  // A signed transaction never expires, and the keeper sends it at once. Until the chain has used its nonce the
  // keeper runs no funding step and no Aave top-up; once it has, one fresh check; and until that verdict is held it
  // doesn't act for Aave on the one from before. An approval changes no position, so it asks for no check.
  const evm = seen.evm;
  if (evm) {
    const chain = evm.chainNonce;
    wait.unmined = chain === undefined ? evm.nonce > 0 : chain < evm.nonce;
    const oldest = chain === undefined ? undefined : evm.signed.filter((e) => e.nonce === chain).at(-1);
    if (wait.unmined) {
      wait.unminedId = `${chain ?? "?"}`;
      wait.unminedWords =
        chain === undefined
          ? "Aave's chain hasn't been read yet, so the keeper can't tell whether the account's transactions there are mined"
          : `the account's transaction ${chain} on Aave's chain${oldest ? ` (${evmKindWords(oldest.kind)})` : ""} isn't mined yet`;
    }
    const readAt = v?.evmNonce ?? chain ?? 0;
    const unseen = evm.signed.filter((e) => e.kind !== "approve" && e.nonce >= readAt).at(-1);
    if (unseen) {
      wait.evmEarly = true;
      wait.evmEarlyWords = `the last one was read before the account's transaction ${unseen.nonce} on Aave's chain (${evmKindWords(unseen.kind)}) was mined`;
      const asked = next.evmRecheck?.nonce === evm.nonce ? next.evmRecheck : undefined;
      if (!wait.unmined && !wait.waiting && !busy && (!asked || now - asked.at >= LENDER_RECHECK_MS)) {
        reasons.push(`the account's transaction ${unseen.nonce} on Aave's chain (${evmKindWords(unseen.kind)}) has been mined: a fresh check`);
        next.evmRecheck = { nonce: evm.nonce, at: now };
        wait.asked = true;
      }
    }

    // A transaction that stays unmined: signed again with a higher tip, inside the config's fee limit.
    if (wait.unmined && chain !== undefined && oldest) {
      const stuck = memory.evmStuck?.nonce === chain ? memory.evmStuck : { nonce: chain, since: now, bumps: 0 };
      next.evmStuck = stuck;
      if (now - (stuck.at ?? stuck.since) >= EVM_BUMP_AFTER_MS && stuck.bumps < MAX_BUMPS && !stuck.said) {
        const limit = evm.maxFee !== undefined ? BigInt(evm.maxFee) : null;
        const tip = oldest.tip !== undefined ? BigInt(oldest.tip) : null;
        const fee = oldest.fee !== undefined ? BigInt(oldest.fee) : null;
        // INTERFACES.md 47.1: the kept fee limit and a tenth, rounded up: the lowest the account takes, so each bump
        // uses one step of the room under the config's limit. The tip by the keeper's own rule, ten times the kept
        // one, and never above that new fee limit.
        const nextFee = fee === null ? null : (fee * 11n + 9n) / 10n;
        const higher = tip === null ? null : tip * 10n > MIN_BUMP_TIP_WEI ? tip * 10n : MIN_BUMP_TIP_WEI;
        const nextTip = higher === null || nextFee === null ? null : higher > nextFee ? nextFee : higher;
        const waited = Math.round((now - stuck.since) / SECOND);
        const what = `the account's transaction ${chain} on Aave's chain (${evmKindWords(oldest.kind)})`;
        // The account makes anyone but its owner wait a minute from the block time the kept one was signed: a bump
        // the owner has just made is left that long. Nothing is said: the next tick looks again.
        const tooFresh = oldest.signedAtMs !== undefined && (seen.chainNowMs ?? now) - oldest.signedAtMs < EVM_BUMP_SIGNED_WAIT_MS;
        if (tooFresh) {
          // wait
        } else if (limit === null || tip === null || fee === null || nextFee === null || nextTip === null) {
          notes.push(`${what} isn't mined after ${waited} s, and the keeper can't sign it again with more: its fees or the config's fee limit can't be read`);
          next.evmStuck = { ...stuck, said: true };
        } else if (nextFee > limit) {
          notes.push(`${what} isn't mined after ${waited} s, and the keeper can't sign it again with more: a tenth above its fee limit (${fee} wei) would be ${nextFee} wei, over the config's limit of ${limit} wei`);
          next.evmStuck = { ...stuck, said: true };
        } else if (!(nextTip > tip && nextTip * 10n >= tip * 11n)) {
          notes.push(`${what} isn't mined after ${waited} s, and the keeper can't sign it again with more: its tip (${tip} wei) can't go a tenth higher under a fee limit of ${nextFee} wei`);
          next.evmStuck = { ...stuck, said: true };
        } else {
          actions.push({ kind: "evm_bump", nonce: chain, maxFee: nextFee.toString(), tip: nextTip.toString(), reason: `${what} isn't mined after ${waited} s: signed again with a fee limit of ${nextFee} wei instead of ${fee}, a tenth more, and a tip of ${nextTip} wei instead of ${tip}; the config's limit is ${limit} wei` });
          next.evmStuck = { ...stuck, bumps: stuck.bumps + 1, at: now };
        }
      }
    } else {
      next.evmStuck = undefined;
    }
  }
  /**
   * Whether Aave's Pool may take `token` from the account's address. If not, and no approval is on its way, this asks
   * for `evm_approve`: one a tick, a minute apart, three tries for a token.
   */
  const approved = (token: string, why: string): boolean => {
    if (!evm) return true;
    const t = token.toLowerCase();
    if (evm.approved.includes(t)) return true;
    if (wait.unmined || actions.some((a) => a.kind === "evm_approve")) return false;
    const tried = next.approvals?.[t];
    if (tried && tried.tries >= MAX_TRIES) {
      if (!tried.said) {
        notes.push(`${t} still isn't approved for Aave's Pool after ${tried.tries} tries of evm_approve: the keeper stops asking, and what needs it waits`);
        next.approvals = { ...next.approvals, [t]: { ...tried, said: true } };
      }
      return false;
    }
    if (tried && now - tried.at < SENT_WAIT_MS) return false;
    actions.push({ kind: "evm_approve", token: t, reason: why });
    next.approvals = { ...(next.approvals ?? {}), [t]: { tries: (tried?.tries ?? 0) + 1, at: now } };
    return false;
  };

  // ---------- Phase 6: the lenders' cushions ----------
  // Bitcoin has moved enough since this verdict to bring a lender's cushion near 1.35 (cushion.ts): a check, once per
  // lender and verdict. The engine reads the real position and, under 1.35, plans the top-up.
  if (v) {
    for (const e of seen.ext ?? []) {
      // Not on a verdict read before the lender's last action was done: the fresh check comes first.
      if (e.l === "aave" ? wait.evmEarly || wait.unmined : wait.readEarly) continue;
      if (next.lenderAsked?.includes(e.l)) continue;
      const move = cushionMove(e, next.refPrices ?? seen.prices, seen.prices);
      if (!move) continue;
      reasons.push(move.words);
      next.lenderAsked = [...(next.lenderAsked ?? []), e.l];
    }
  }

  // ---------- DELEVERAGE: the second check ----------
  const planIsTheVerdicts = Boolean(seen.plan && v && seen.plan.pid === String(v.blk));
  if (v?.action === "DELEVERAGE" && !planIsTheVerdicts) {
    const firstAt = seen.firstDeleverageAtMs;
    if (firstAt > 0) {
      const sent = memory.secondCheck?.firstAt === firstAt ? memory.secondCheck : undefined;
      const waited = (seen.chainNowMs ?? now) - firstAt;
      const seconds = Math.round(waited / SECOND);
      if (!sent && waited >= SECOND_CHECK_AIM_MS) {
        reasons.push(
          waited <= SECOND_CHECK_BEFORE_MS
            ? `the second check for DELEVERAGE, ${seconds} s after the first verdict arrived`
            : `DELEVERAGE again, ${seconds} s after the first verdict: past the 5-minute window, so this check starts a new pair`,
        );
        next.secondCheck = { firstAt, sentAt: now, tries: 1 };
      } else if (sent && !busy && now - sent.sentAt >= SECOND_CHECK_RETRY_MS && waited <= SECOND_CHECK_LAST_MS && sent.tries < MAX_TRIES) {
        reasons.push(`the second check for DELEVERAGE again, ${seconds} s after the first: the plan isn't stored yet`);
        next.secondCheck = { firstAt, sentAt: now, tries: sent.tries + 1 };
      }
    } else {
      notes.push("the verdict says DELEVERAGE but deleverage.first_at is 0: the account confirms plans by its own clock");
    }
  }

  // ---------- the stored plan ----------
  const plan = seen.plan;
  if (plan && plan.source === "confirmed_plan" && fresh) notes.push(`the stored plan ${plan.pid} is in words only (an account made before Phase 4): nothing to run`);
  if (plan && plan.source === "plan" && plan.steps.length > 0 && v && (planIsTheVerdicts || v.action !== "NONE")) {
    const run: PlanRun = { ...(next.plans![plan.pid] ?? { steps: {} }), steps: { ...(next.plans![plan.pid]?.steps ?? {}) } };
    let open = false;
    if (plan.steps.some((s) => s.runner === "gateway")) {
      const g = run.gateway;
      if (!g || (g.state === "retry" && now - g.at >= RETRY_AFTER_MS && g.tries < MAX_TRIES)) {
        const kinds = plan.steps.filter((s) => s.runner === "gateway").map((s) => `${s.i}:${s.k}`).join(", ");
        actions.push({ kind: "deleverage", pid: plan.pid, reason: `the stored ${plan.action} plan ${plan.pid}: the gateway places its steps ${kinds}` });
        open = true;
      } else if (g.state === "retry" && g.tries < MAX_TRIES) {
        open = true;
      }
    }
    for (const step of plan.steps) {
      if (step.runner !== "execute_step" || step.done) continue;
      // Phase 6: a top-up plan's lender steps (l_add, l_repay) only lower risk, and run like any other step. The kinds
      // that make a loan belong in a funding plan: one found here is noted once and left alone, and the plan stays
      // open, so the keeper doesn't ask for the "its steps have run" check over and over.
      if (FUNDING_KINDS.includes(step.k) && !TOP_UP_KINDS.includes(step.k)) {
        if (fresh) notes.push(`step ${step.i} (${step.k}) of plan ${plan.pid} belongs in a funding plan, not in this one: the keeper leaves it alone`);
        open = true;
        continue;
      }
      if (TOP_UP_KINDS.includes(step.k)) {
        // A top-up is sized on the lender's cushion. On a verdict from before a lender action's blocks had passed,
        // that figure can be too low: the fresh check comes first, and a top-up it still orders runs then.
        // The same on Aave: not while a transaction there is unmined, nor on a verdict from before it was mined.
        const onAave = (step.raw as { l?: unknown } | null)?.l === "aave";
        if (onAave ? wait.evmEarly || wait.unmined : wait.readEarly) {
          open = true;
          continue;
        }
        // The account runs an `l_add` only under the verdict that ordered it (its `blk` is the plan's id). If another
        // check has landed since, the step can't run: the keeper asks for a new plan. An `l_repay` isn't held back.
        // INTERFACES.md 47.5 (A15): an account made since then keeps its stored plan when a newer verdict orders the
        // same steps, and runs the `l_add` under that verdict. So a held verdict whose own plan has the stored
        // plan's action and steps (by kind, lender and token) backs the step too.
        if (step.k === "l_add" && !planIsTheVerdicts && !ordersSamePlan(v, plan)) {
          if (!run.replan) notes.push(`step ${step.i} (l_add) of plan ${plan.pid} can't run any more: a later check has landed, and the account adds collateral only under the check that ordered it`);
          run.replan = true;
          continue;
        }
        // Aave's Pool takes a token from the address only once the address has approved it.
        if (onAave) {
          const token = step.k === "l_add" ? String((step.raw as { tok?: unknown } | null)?.tok ?? "").toLowerCase() : (evm?.usdc ?? "");
          if (token && !approved(token, `step ${step.i} (${step.k}) of plan ${plan.pid} takes ${token} from the account's address: Aave's Pool is approved for it first (once per token)`)) {
            open = true;
            continue;
          }
        }
      }
      const tried = run.steps[step.i];
      // A repay after a sale repays the sale's proceeds: it waits until the sale's transfer has resolved (INTERFACES.md
      // 13, as built), since the account repays only what it holds.
      const sale = step.k === "repay" ? plan.steps.find((s) => s.i < step.i && s.k === "sell" && (!s.done || (seen.transfers ?? []).includes(`${plan.pid}:${s.i}`))) : undefined;
      if (sale) {
        open = true;
        continue;
      }
      if (step.exp !== undefined && step.exp - now < QUOTE_MARGIN_MS) {
        if (!tried) {
          run.steps[step.i] = { state: "expired", tries: 0, at: now, why: "its quote has less than 5 minutes left" };
          run.replan = true;
          notes.push(`step ${step.i} (${step.k}) of plan ${plan.pid} can't run: its quote has less than 5 minutes left`);
        }
        continue;
      }
      if (!tried || (tried.state === "retry" && now - tried.at >= RETRY_AFTER_MS && tried.tries < MAX_TRIES) || (tried.state === "sent" && now - tried.at >= SENT_WAIT_MS && tried.tries < MAX_TRIES)) {
        const dep = (step.raw as { dep?: unknown } | null)?.dep;
        actions.push({ kind: "execute_step", pid: plan.pid, i: step.i, k: step.k, reason: `step ${step.i} of the stored ${plan.action} plan ${plan.pid}: ${step.text}`, ...(typeof dep === "string" ? { dep } : {}) });
        open = true;
      } else if ((tried.state === "retry" || tried.state === "sent") && tried.tries < MAX_TRIES) {
        open = true;
      }
    }
    if (run.replan && !run.replanAsked) {
      reasons.push(`plan ${plan.pid} can't run as it is: a check for a new plan`);
      run.replanAsked = true;
      run.rechecked = true;
      next.recoveringSince ??= now;
    } else if (!open && !run.rechecked && !wait.unmined) {
      // (Stage 3: not while a step's transaction on Aave's chain is unmined. The check would read Aave as it was.)
      // INTERFACES.md 47.7: a top-up step that didn't go out in its tries (our pool is paused, or past its day's step
      // limit; the account holds nothing to send) is said once, and the check for a new plan waits TOP_UP_AGAIN_MS.
      const stuck = plan.steps.find((s) => !s.done && TOP_UP_KINDS.includes(s.k) && run.steps[s.i]?.state === "retry" && run.steps[s.i]!.tries >= MAX_TRIES);
      if (stuck && run.gaveUpAt === undefined) {
        run.gaveUpAt = now;
        const why = run.steps[stuck.i]!.why;
        notes.push(`step ${stuck.i} (${stuck.k}) of plan ${plan.pid} didn't go out in ${MAX_TRIES} tries${why ? ` (${why})` : ""}: the keeper asks for a new plan in ${TOP_UP_AGAIN_MS / MINUTE} minutes and tries again then`);
      }
      if (!stuck || now - run.gaveUpAt! >= TOP_UP_AGAIN_MS) {
        reasons.push(stuck ? `step ${stuck.i} (${stuck.k}) of plan ${plan.pid} didn't go out ${TOP_UP_AGAIN_MS / MINUTE} minutes ago: a check for a new plan, to try again` : `the steps of plan ${plan.pid} have run: a check to see where the account stands`);
        run.rechecked = true;
        next.recoveringSince = now;
      }
    }
    next.plans![plan.pid] = run;
  }

  // ---------- Phase 6: the funding plan ----------
  if (funding) {
    const before = memory.fundings?.[funding.pid];
    const run: FundingRun = { ...(before ?? { steps: {} }), steps: { ...(before?.steps ?? {}) } };
    runFunding(funding, run, seen, now, before !== undefined, wait, { actions, notes, reasons, approved, ...(busy ? { pendingAt } : {}) });
    // Only the plan the account holds now is remembered.
    next.fundings = { [funding.pid]: run };
  } else if (next.fundings) {
    next.fundings = undefined;
  }

  // Stage 3: once Aave is owed, its Pool is approved for USDC ahead of time, so that a repayment (a top-up's, or the
  // client's own) needs no extra step when it matters. Not while a funding plan still has steps to run.
  if (evm && (seen.ext ?? []).some((e) => e.l === "aave" && e.d > 0) && !(funding && funding.steps.some((s) => !s.done))) {
    approved(evm.usdc, "Aave is owed: its Pool is approved to take USDC from the account's address now, so that a repayment needs no extra step later");
  }

  // ---------- regular checks ----------
  const lastSeen = Math.max(memory.lastCheckAt ?? 0, v?.at ?? 0);
  if (v && (v.state === "MARGIN_CALL" || v.state === "DELEVERAGE") && now - lastSeen >= MARGIN_CALL_CHECK_MS) {
    reasons.push(`${v.state === "MARGIN_CALL" ? "a margin call" : "DELEVERAGE"}: a check at least every 5 minutes`);
  }
  if (next.recoveringSince !== undefined && v && v.state !== "HEALTHY") {
    if (now - next.recoveringSince > RECOVER_FOR_MS) {
      notes.push("an hour after the plan the account is still not HEALTHY: back to the usual checks");
      next.recoveringSince = undefined;
    } else if (v.state === "WATCH" && now - lastSeen >= RECOVER_CHECK_MS) {
      reasons.push("not HEALTHY yet after the plan: another check");
    }
  }
  // (Stage 3: not while a transaction on Aave's chain is unmined. A check then would read Aave as it was before it.)
  if (v && v.nonce < seen.counter && next.refreshedFor !== key && now - (next.quietSince ?? now) >= QUIET_MS && !wait.unmined) {
    reasons.push("an action used the last verdict, so its bands describe the book before it: a fresh check");
    next.refreshedFor = key;
  }
  if (next.nextHourlyAt === undefined) {
    next.nextHourlyAt = nextHourlyCheck(now, random);
  } else if (now >= next.nextHourlyAt) {
    reasons.push("the hourly sample for the rating");
    next.nextHourlyAt = nextHourlyCheck(now, random);
    // Phase 6: where a lender is owed, the hourly settlement follows this check (FUNDING.md 5.2 and 7.1).
    // INTERFACES.md 45.3, item 9: and where the account's policy isn't pass-through, lender or no lender. Under a
    // fixed rate the pool's own part is settled too, and nothing else would ever settle it.
    if ((seen.ext ?? []).some((e) => e.d > 0) || seen.priced === true) next.settleDue = { tries: 0 };
  }
  // INTERFACES.md 45.3, item 10: the settlement that reports a repaid lender as zero, which the pool skipped as too
  // soon. One more check once the pool's time between two settlements has passed, with the settlement behind it.
  const zero = memory.zeroAgain;
  if (zero !== undefined && zero.at !== undefined && now >= zero.at && zero.tries < MAX_ZERO_AGAIN) {
    reasons.push(ZERO_CHECK);
    next.settleDue ??= { tries: 0 };
    next.zeroAgain = { tries: zero.tries + 1, waitMs: zero.waitMs };
  }
  // Asked for and not gone yet: the next settlement is that one.
  const zeroOpen = next.zeroAgain !== undefined && next.zeroAgain.at === undefined && !next.zeroAgain.stopped;
  // What asked for a check while another was on its way goes out now that it is over, as one check.
  if (!busy && next.checkHeld?.length) {
    reasons.unshift(...next.checkHeld.filter((r) => !reasons.includes(r)));
    next.checkHeld = undefined;
  }
  if (next.retryCheck && reasons.length === 0 && !busy) {
    reasons.push(`again: ${next.retryCheck.reason}`);
  }

  // Phase 6: no check while a lender action is under way. Whatever asked for one is covered by the fresh check that
  // goes out as soon as its block has passed.
  if (wait.waiting && reasons.length > 0) {
    if (!next.lenderHeld) notes.push(`a check waits until block ${wait.until} has passed: the account counts ${wait.what} as under way, and a check asked for now would be refused when its verdict lands (${reasons.join("; ")})`);
    next.lenderHeld = true;
    reasons.length = 0;
  }

  // One check at a time: while the last one's end isn't known, a second would only queue behind it at OutLayer.
  if (busy && reasons.length > 0) {
    if (!next.checkHeld?.length) {
      notes.push(
        pendingAt !== undefined && now - pendingAt < CHECK_WAIT_MS
          ? `a check waits its turn: the one the keeper asked for ${Math.round((now - pendingAt) / SECOND)} s ago hasn't come back, and another now would only queue behind it. ` +
              `It goes out when that one's verdict lands, or ${CHECK_WAIT_MS / SECOND} s after it was asked for (${reasons.join("; ")})`
          : `a check waits its turn: the client's page has asked for one, and another now would queue behind it or replace the result the client is about to act on. ` +
              `It goes out once the client has acted, or a little after (${reasons.join("; ")})`,
      );
    }
    next.checkHeld = [...new Set([...(next.checkHeld ?? []), ...reasons])].slice(0, MAX_HELD_REASONS);
    reasons.length = 0;
  }

  if (reasons.length > 0) {
    actions.push({ kind: "request_check", reason: reasons.join("; ") });
    next.lastCheckAt = now;
    next.checkPrices = seen.prices;
    // Any check sent after a lender action's block has passed is the fresh one that action waits for.
    if (next.lenderRecheck && next.lenderRecheck.until === next.lenderUntil && !wait.waiting) next.lenderRecheck = { ...next.lenderRecheck, at: now };
    // settle() needs a fresh verdict, so it goes out right behind a check: the loop skips it if the check failed.
    if (next.settleDue) {
      actions.push(zeroOpen ? { kind: "settle", reason: ZERO_SETTLE, zero: true } : { kind: "settle", reason: HOURLY_SETTLE });
    }
  } else if (fresh && v && memory.checkPending && next.settleDue && !wait.readEarly) {
    // The check the settlement was to follow came back after all: its end wasn't seen, and its verdict has landed.
    // (Not on a verdict read while a lender action was under way: that one waits for the fresh check, as above.)
    const back = "the hourly settlement, on the check that has now come back: what the client pays on the lender's part against the operator's price";
    actions.push(zeroOpen ? { kind: "settle", reason: ZERO_SETTLE, zero: true } : { kind: "settle", reason: back });
  }
  return { actions, memory: next, notes };
}

/**
 * INTERFACES.md 47.5 (research/audit.md A15): whether the held verdict's own plan is the stored plan again: the same
 * action, and the same steps in the same order by kind, lender and token. Amounts and quotes may differ. That is the
 * account's own test for keeping a stored plan instead of the newer verdict's.
 */
export function ordersSamePlan(v: Verdict | null, plan: PlanView): boolean {
  const ordered = v?.planSteps;
  if (!v || !ordered || v.action !== plan.action || ordered.length !== plan.steps.length) return false;
  const text = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : undefined);
  return plan.steps.every((step, i) => {
    const raw = step.raw as { l?: unknown; tok?: unknown } | null;
    const now = ordered[i]!;
    return now.k === step.k && text(now.l) === text(raw?.l) && text(now.tok) === text(raw?.tok);
  });
}

/** The funding steps the keeper runs today. */
const FUND_RUN_KINDS = ["l_supply", "l_borrow", "p_borrow"];

/** A lender action the account lists, or listed, as under way (decide's "a lender action under way"). */
interface LenderWait {
  /** Its block hasn't passed yet: the account refuses every funding step, and the keeper asks for no check. */
  waiting: boolean;
  /** The held verdict is from before that block had passed. */
  readEarly: boolean;
  until?: number;
  /** "its borrow at Rhea". */
  what?: string;
  /** The fresh check after it is being asked for on this tick. */
  asked?: boolean;
  /** Stage 3: a signed transaction on Aave's chain isn't mined yet: no funding step and no Aave top-up. Checks still go. */
  unmined?: boolean;
  unminedWords?: string;
  unminedId?: string;
  /** The held verdict was read before a transaction that changes the Aave position was mined. */
  evmEarly?: boolean;
  evmEarlyWords?: string;
}

/** A signed Ethereum transaction's kind (INTERFACES.md 33), in words. */
export function evmKindWords(kind: string): string {
  const words: Record<string, string> = { approve: "an approval", supply: "a supply at Aave", borrow: "a borrow at Aave", repay: "a repayment to Aave", withdraw: "a withdrawal from Aave", transfer: "a transfer out" };
  return words[kind] ?? `a ${kind}`;
}

/** Why the held verdict can't back this funding step, or null if it can. The words end "... needs a fresh check first: ". */
function checkProblem(step: PlanStep, seen: Seen, wait: LenderWait): string | null {
  if (seen.verdict && wait.evmEarly && !wait.readEarly) return wait.evmEarlyWords ?? "the last one was read before the account's last transaction on Aave's chain was mined";
  const v = seen.verdict;
  if (!v) return "the account holds no check yet";
  if (wait.readEarly) return `the last one was read before block ${wait.until}, while the account still counted ${wait.what} as under way`;
  if (v.nonce !== seen.counter) return COUNTER_MOVED;
  // A lender's step needs a verdict read after the permission last changed (INTERFACES.md 40.1). The counter
  // doesn't show that change, so the verdict's block is compared with the account's own record of it.
  if (step.k.startsWith("l_") && seen.permissionBlk !== undefined && v.blk <= seen.permissionBlk) return `${PERMISSION_CHANGED} (block ${seen.permissionBlk})`;
  const age = seen.chainBlock === undefined ? 0 : seen.chainBlock - v.blk;
  if (age > FUND_FRESH_BLOCKS) return `the last one is ${age} blocks old`;
  if (v.state !== "HEALTHY") return `the last one says ${v.state}, and new borrowing needs HEALTHY`;
  if (step.k === "p_borrow" && v.allowBorrow !== undefined && v.allowBorrow <= 0) return "the last one lets our pool lend nothing now";
  if (step.k === "l_borrow") {
    const lender = (step.raw as { l?: unknown } | null)?.l;
    const room = seen.ext?.find((e) => e.l === lender)?.room ?? 0;
    if (room <= 0) return `the last one gives ${lenderName(lender)} no room to lend against the collateral posted there`;
  }
  return null;
}

/** What checkProblem says when the account's counter has moved since the verdict: a new check answers that at once. */
const COUNTER_MOVED = "the last one was made before the account's latest change";
/** What it says when the owner changed the permission after the verdict was read: a new check answers that at once too. */
const PERMISSION_CHANGED = "the last one was read before the permission last changed";

/**
 * Phase 6 (INTERFACES.md 25): the funding plan's next step. Steps run strictly in order, so only the first one not
 * done is looked at. It adds an execute_step action, a reason for a check, or a note; `run` is updated in place.
 * `kept` says the keeper already knew this plan, so it ran (or tried) its steps itself.
 */
function runFunding(
  funding: FundingView,
  run: FundingRun,
  seen: Seen,
  now: number,
  kept: boolean,
  wait: LenderWait,
  /**
   * `pendingAt`: a check is on its way, asked for then, and no other is asked for until it is over. `approved`
   * (stage 3): whether Aave's Pool may take a token from the address; it asks for the approval if not.
   */
  out: { actions: Action[]; notes: string[]; reasons: string[]; pendingAt?: number; approved?: (token: string, why: string) => boolean },
): void {
  const say = (id: string, note: string) => {
    if (run.said?.includes(id)) return;
    out.notes.push(note);
    run.said = [...(run.said ?? []), id];
  };
  const step = funding.steps.find((s) => !s.done);
  if (!step) {
    if (kept && !run.rechecked && !wait.unmined) {
      out.reasons.push(`the steps of funding plan ${funding.pid} have run: a check to see where the account stands`);
      run.rechecked = true;
    }
    return;
  }
  if (run.stopped) return;
  const name = `step ${step.i} (${step.k}) of funding plan ${funding.pid}`;
  if (funding.expiresAtMs !== null && (seen.chainNowMs ?? now) > funding.expiresAtMs) {
    say("expired", `funding plan ${funding.pid} ran out of its 30 minutes with ${name} still to run: the client can ask for the rest again`);
    return;
  }
  if (!FUND_RUN_KINDS.includes(step.k)) {
    say(
      `left:${step.i}`,
      MOVE_KINDS.includes(step.k)
        ? `${name} moves money between chains, which the keeper doesn't run yet: ${step.text}`
        : `${name} is not a step a funding plan holds: the keeper leaves it alone`,
    );
    return;
  }
  const stop = (why: string) => {
    say(`stopped:${step.i}`, `${name} ${why}: the keeper stops this plan here, and the client can ask again`);
    run.stopped = true;
  };
  const tried = run.steps[step.i];
  if (tried) {
    // A step whose transaction went through shows `done` within a tick.
    if (tried.state === "sent" && now - tried.at < SENT_WAIT_MS) return;
    if (tried.tries >= MAX_TRIES) return stop(`didn't go through in ${tried.tries} tries${tried.why ? ` (${tried.why})` : ""}`);
    if (tried.state === "retry" && now - tried.at < RETRY_AFTER_MS) return;
  }
  // Rhea finishes a borrow or a withdrawal a block or two after the account's call: for 20 blocks the account lists
  // it as under way, and refuses every funding step.
  if (wait.waiting) {
    say(`wait:${step.i}:${wait.until}`, `${name} waits: the account counts ${wait.what} as under way until block ${wait.until} has passed`);
    return;
  }
  // Stage 3: nothing runs while a transaction on Aave's chain isn't mined: the next step is planned on its result.
  if (wait.unmined) {
    say(`unmined:${step.i}:${wait.unminedId}`, `${name} waits: ${wait.unminedWords}`);
    return;
  }
  // Posting collateral at Aave takes the token from the account's address, which must have approved Aave's Pool.
  if (step.k === "l_supply" && (step.raw as { l?: unknown } | null)?.l === "aave" && out.approved) {
    const token = String((step.raw as { tok?: unknown } | null)?.tok ?? "").toLowerCase();
    if (token && !out.approved(token, `${name} takes ${token} from the account's address: Aave's Pool is approved for it first (once per token)`)) return;
  }
  // Every step that adds debt borrows on a verdict made for it (INTERFACES.md 24, point 1), and so does posting
  // collateral while the account owes our pool (point 8). The check is a plain {"check":{}}: a borrow intent's
  // verdict would be added to the unfinished step by the order gateway, which would then refuse orders for nothing.
  if (step.k !== "l_supply" || seen.owesPool) {
    const problem = checkProblem(step, seen, wait);
    if (problem) {
      // One check at a time: the one already on its way is this step's check too, once its verdict lands. It counts
      // as no try of the step's own.
      if (out.pendingAt !== undefined) {
        say(`behind:${step.i}:${out.pendingAt}`, `${name} needs a fresh check first, and waits for the one the keeper asked for ${Math.round((now - out.pendingAt) / SECOND)} s ago: ${problem}`);
        return;
      }
      const asked = run.check?.i === step.i ? run.check : undefined;
      // A check that came back (another verdict is held now) and found the account's counter moved on is asked again
      // at once: Aave's pending action is dropped when its verdict lands, which moves the counter. So is one that
      // found the permission changed since it was read (INTERFACES.md 40.1). Any other problem waits its 150 s.
      const cameBack = asked?.key !== undefined && asked.key !== verdictKey(seen.verdict);
      const atOnce = problem === COUNTER_MOVED || problem.startsWith(PERMISSION_CHANGED);
      if (asked && now - asked.at < FUND_CHECK_EVERY_MS && !(cameBack && atOnce)) return;
      if (asked && asked.tries >= MAX_FUND_CHECKS) return stop(`can't run: after ${asked.tries} checks, ${problem}`);
      // The check that follows a lender action is this step's check too: one reason says it.
      if (!wait.asked) out.reasons.push(`${name} needs a fresh check first: ${problem}`);
      run.check = { i: step.i, tries: (asked?.tries ?? 0) + 1, at: now, key: verdictKey(seen.verdict) };
      return;
    }
  }
  out.actions.push({ kind: "execute_step", pid: funding.pid, i: step.i, k: step.k, reason: `step ${step.i} of funding plan ${funding.pid}: ${step.text}` });
}

/** Notes how an action went. */
export function afterAction(memory: Memory, action: Action, outcome: Outcome, now: number): Memory {
  const next: Memory = { ...memory, plans: { ...(memory.plans ?? {}) } };
  const run = (pid: string): PlanRun => {
    const current = next.plans![pid] ?? { steps: {} };
    const copy = { ...current, steps: { ...current.steps } };
    next.plans![pid] = copy;
    return copy;
  };
  const state = (o: Outcome): StepRun["state"] => (o.ok ? "sent" : o.retry ? "retry" : "failed");
  switch (action.kind) {
    case "request_check": {
      if (outcome.ok) {
        next.retryCheck = undefined;
        next.checkPending = undefined;
      } else {
        const tries = (memory.retryCheck?.tries ?? 0) + 1;
        const reason = action.reason.replace(/^again: /, "");
        next.retryCheck = outcome.retry !== false && tries < MAX_TRIES ? { reason, tries } : undefined;
        // The last try of a check that could have been tried again: given up on, with no verdict. decide() lets what
        // asked for it ask again CHECK_AGAIN_MS from now. A check refused for good (retry false) isn't asked again.
        if (outcome.retry !== false && tries >= MAX_TRIES && !outcome.pending) next.checkGaveUpAt = now;
        // A check known to have failed is over, and the next may go at once. One whose end wasn't seen may still
        // bring its verdict: the keeper waits for it, from the moment it asked (decide's "one check at a time").
        next.checkPending = outcome.pending ? { at: memory.lastCheckAt ?? now } : undefined;
      }
      break;
    }
    case "cancel_risky":
    // Stage 3: decide() counted the try when it asked; what the call brought shows on the chain by the next tick.
    case "evm_approve":
    case "evm_bump":
      break;
    case "deleverage": {
      const r = run(action.pid);
      r.gateway = { state: state(outcome), tries: (r.gateway?.tries ?? 0) + 1, at: now, ...(outcome.why ? { why: outcome.why } : {}) };
      if (outcome.replan || (!outcome.ok && !outcome.retry)) r.replan = true;
      break;
    }
    case "execute_step": {
      // Phase 6: a funding plan's step ("f<blk>"). A refusal isn't the end of it, as it is for a stored plan's step:
      // the keeper asks for a new check and tries again, at most MAX_TRIES times in all (runFunding counts them).
      const funding = next.fundings?.[action.pid];
      if (action.pid.startsWith("f") && funding) {
        const prev = funding.steps[action.i];
        const tried: StepRun = { state: outcome.ok ? "sent" : "retry", tries: (prev?.tries ?? 0) + 1, at: now, ...(outcome.why ? { why: outcome.why } : {}) };
        // After a refusal the next check goes at once: whatever refused the step may have moved the counter.
        const check = !outcome.ok && funding.check ? { ...funding.check, at: 0 } : funding.check;
        next.fundings = { ...next.fundings, [action.pid]: { ...funding, steps: { ...funding.steps, [action.i]: tried }, ...(check ? { check } : {}) } };
        break;
      }
      const r = run(action.pid);
      const prev = r.steps[action.i];
      r.steps[action.i] = { state: state(outcome), tries: (prev?.tries ?? 0) + 1, at: now, ...(outcome.why ? { why: outcome.why } : {}) };
      if (outcome.replan || (!outcome.ok && !outcome.retry)) r.replan = true;
      break;
    }
    case "settle": {
      // A settlement that never went out (its check failed, or the network did) goes behind the next check instead.
      // One the account or the pool refused is left: the next hourly one covers the time since (FUNDING.md 5.2).
      const tries = (memory.settleDue?.tries ?? 0) + 1;
      next.settleDue = !outcome.ok && outcome.retry && tries < MAX_TRIES ? { tries } : undefined;
      break;
    }
  }
  return next;
}

/**
 * INTERFACES.md 45.3, item 10: notes how the settlement that reports a repaid lender as zero went.
 *
 * - The pool skipped it as too soon: one more try once `waitMs` (the pool's `min_period_ns`) has passed,
 *   MAX_ZERO_AGAIN times at most. After the last one the keeper stops asking (`stopped`), and the pool's record is
 *   looked at again after the account's next check, as before.
 * - It went through any other way: the pool has the report, and there is nothing more to try.
 * - It never went out (its check failed): it stays as it is, to go behind the next check.
 */
export function afterZeroSettle(memory: Memory, outcome: Outcome, now: number, waitMs: number): Memory {
  const zero = memory.zeroAgain;
  if (outcome.tooSoon) {
    if (zero?.stopped) return memory;
    const tries = zero?.tries ?? 0;
    return { ...memory, zeroAgain: tries < MAX_ZERO_AGAIN ? { at: now + waitMs, tries, waitMs } : { tries, waitMs, stopped: true } };
  }
  return outcome.ok && zero ? { ...memory, zeroAgain: undefined } : memory;
}
