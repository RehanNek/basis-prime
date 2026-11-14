// The funding plan (FUNDING.md 4.3; INTERFACES.md 25), stage 2: the steps `fund(amount)` stored, as the keeper runs
// them, in words. The page reads them from `funding.steps` in GET /api/lender/:account; `done` means started. A plan
// lasts 30 minutes and its steps run strictly in order. Pure functions, so the words can be tested.
// Stage 3 (INTERFACES.md 33): a step at Aave is an Ethereum transaction the account signs, so it goes on from started
// to signed, sent and mined, read from `evm.signed[].status`.
import type { EvmStatus } from './api.ts';
import { EVM_CHAIN_NAME, evmSettled, evmStatus, statusWords } from './evm.ts';
import { sourceName } from './funding.ts';
import type { FundingState, FundingStep, Token } from './types.ts';
import { displayUnits, formatUsd } from './units.ts';

export type StepMark = 'done' | 'busy' | 'todo' | 'failed';

export interface PlanStepView {
  i: number;
  k: string;
  mark: StepMark;
  what: string;
  /** A line under it, when there is something to add. */
  how: string | null;
  /** A step at Aave: its signed Ethereum transaction and where that stands, for a link to the chain's explorer. */
  tx?: { hash: string; status: EvmStatus };
}

export interface FundingPlanView {
  pid: string;
  /** `running`: steps still to start, inside the 30 minutes. `expired`: steps left when the time ran out. */
  status: 'running' | 'done' | 'expired';
  headline: string;
  detail: string;
  steps: PlanStepView[];
  /** Whole minutes until the plan expires; 0 once it has. */
  minutesLeft: number;
  /** Whether the page shows it: always while steps are left, and for a finished plan until its 30 minutes are over. */
  show: boolean;
}

/**
 * A lender action the account lists as under way: nothing that adds risk runs meanwhile.
 * - At Rhea (INTERFACES.md 25) it has `until_block`, the last block of its 20-block wait.
 * - At Aave (INTERFACES.md 33) it has `evm_nonce` instead: it counts until the chain has used that nonce.
 */
export interface PendingLender {
  lender: string;
  kind: string;
  amount: string;
  until_block: number | null;
  evm_nonce: number | null;
}

/**
 * The `lender` entry of get_state().pending, or null. `pending` is a list of entries such as {"transfer": …}; one
 * written as an object with a `lender` field reads the same.
 */
export function pendingLender(pending: unknown): PendingLender | null {
  const entries = Array.isArray(pending) ? pending : pending && typeof pending === 'object' ? [pending] : [];
  for (const entry of entries) {
    const found = (entry as { lender?: unknown } | null)?.lender;
    if (found && typeof found === 'object') {
      const { lender, kind, amount, until_block, evm_nonce } = found as Record<string, unknown>;
      return {
        lender: String(lender ?? ''),
        kind: String(kind ?? ''),
        amount: String(amount ?? '0'),
        until_block: typeof until_block === 'number' ? until_block : null,
        evm_nonce: typeof evm_nonce === 'number' ? evm_nonce : null,
      };
    }
  }
  return null;
}

/** A NEAR block time in ns (string or number) as ms; 0 when it can't be read. */
export function nsToMs(ns: unknown): number {
  try {
    return Number(BigInt(typeof ns === 'number' ? Math.trunc(ns) : String(ns ?? '0')) / 1_000_000n);
  } catch {
    return 0;
  }
}

/** A step's dollars: "$50,667.00". Its `amt` is micro-USD, a JSON integer or a string of digits. */
const usd = (amt: unknown): string => {
  try {
    return formatUsd(BigInt(typeof amt === 'number' ? Math.trunc(amt) : String(amt ?? '0')));
  } catch {
    return '?';
  }
};

/**
 * A step's collateral, named by its token: "0.0131 nBTC", "0.02 WETH". The token is a NEAR id, or for Aave a 0x
 * address in any case. For a token the page doesn't know, just "collateral": on Aave's test market it may be ether.
 */
function collateral(step: FundingStep, tokens: Token[]): string {
  const token = tokens.find((t) => t.id === step.tok || (typeof step.tok === 'string' && t.id.toLowerCase() === step.tok.toLowerCase()));
  if (!token) return 'collateral';
  try {
    return `${displayUnits(String(step.amt ?? '0'), token.decimals, token.decimals)} ${token.symbol}`;
  } catch {
    return token.symbol;
  }
}

/** One step in plain words (INTERFACES.md 25's kinds). A loan step borrows at most what a fresh check allows. */
export function stepWords(step: FundingStep, tokens: Token[]): string {
  const lender = sourceName(String(step.l ?? 'the lender'));
  switch (step.k) {
    case 'p_borrow':
      return `Borrow up to ${usd(step.amt)} from our pool`;
    case 'l_supply':
      return `Post ${collateral(step, tokens)} with ${lender}, to borrow against`;
    case 'l_borrow':
      return `Borrow up to ${usd(step.amt)} from ${lender}`;
    case 'to_evm':
      return `Move ${collateral(step, tokens)} to the account’s own Ethereum address, through 1Click`;
    case 'e_home':
      return `Bring ${usd(step.amt)} of USDC home to NEAR, through 1Click`;
    case 'l_repay':
      return `Repay ${usd(step.amt)} to ${lender}`;
    case 'l_add':
      return `Add ${collateral(step, tokens)} to what is posted with ${lender}`;
    default:
      return `A step this page doesn’t know (${String(step.k)})`;
  }
}

/** The steps the account runs at Aave by signing an Ethereum transaction, and that transaction's kind. */
const AAVE_KINDS: Record<string, string> = { l_supply: 'supply', l_add: 'supply', l_borrow: 'borrow', l_repay: 'repay' };
const atAave = (step: FundingStep): boolean => step.l === 'aave' && step.k in AAVE_KINDS;

/** What the keeper does to run the step now. */
function runningWords(step: FundingStep): string {
  if (atAave(step)) {
    return step.k === 'l_borrow'
      ? `The keeper asks the risk engine for a fresh check, then has the account sign the borrow and sends it to ${EVM_CHAIN_NAME}.`
      : `The keeper has the account sign it, then sends it to ${EVM_CHAIN_NAME}.`;
  }
  if (step.k === 'p_borrow' || step.k === 'l_borrow') return 'The keeper asks the risk engine for a fresh check, then borrows what it allows.';
  if (step.k === 'to_evm' || step.k === 'e_home') return 'The keeper sends it, and 1Click delivers it in a few minutes.';
  return 'The keeper is running it now.';
}

/**
 * The stored funding plan as a list of steps going from waiting to done. Null with no plan.
 * - `pending` is the account's `pending`: a Rhea borrow that is still finishing keeps its step spinning. The account
 *   drops that entry only at its next call, so with `height`, the chain's block height now, an entry whose last block
 *   has passed counts as finished.
 * - `signed` is each step's signed Ethereum transaction, by "<pid>:<i>" (lib/evm.ts, signedBySteps). With it, a step
 *   at Aave is done only once its transaction is mined, and the step after it waits for that. Without it (a backend
 *   from before stage 3), a started step counts as done, as at Rhea.
 */
export function fundingPlanView(
  funding: FundingState | null | undefined,
  nowMs: number,
  options: { tokens?: Token[]; pending?: unknown; height?: number; signed?: Map<string, { hash: string; status: unknown }> } = {},
): FundingPlanView | null {
  if (!funding || !Array.isArray(funding.steps) || funding.steps.length === 0) return null;
  const tokens = options.tokens ?? [];
  const steps = funding.steps;
  const expiresMs = nsToMs(funding.expires_at);
  const next = steps.findIndex((s) => !s.done);
  const left = next === -1 ? 0 : steps.length - next;
  const expired = expiresMs > 0 && nowMs > expiresMs;
  const minutesLeft = expired || expiresMs === 0 ? 0 : Math.max(1, Math.ceil((expiresMs - nowMs) / 60_000));
  const listed = pendingLender(options.pending);
  // Rhea's wait has a last block. Aave's has none: its step's own transaction says where it stands.
  const finishing = listed && listed.until_block !== null && (options.height === undefined || options.height <= listed.until_block) ? listed : null;
  // The step Rhea is still finishing: the last one started, when it is that lender's borrow.
  const lastStarted = next === -1 ? steps.length - 1 : next - 1;
  const stillFinishing = (i: number, step: FundingStep) => Boolean(finishing && finishing.kind === 'borrow' && i === lastStarted && step.k === 'l_borrow' && step.l === finishing.lender);

  // A started step at Aave: its transaction's status, `signing` until the signed transaction shows, or null when the
  // step isn't Aave's or the page has no reading of the signed transactions.
  const signed = options.signed;
  const aaveStage = (i: number): { status: EvmStatus | 'signing'; hash: string | null } | null => {
    const step = steps[i];
    if (!step?.done || !signed || !atAave(step)) return null;
    const tx = signed.get(`${funding.pid}:${i}`);
    return tx ? { status: evmStatus(tx.status), hash: tx.hash } : { status: 'signing', hash: null };
  };
  const unmined = (i: number): boolean => {
    const stage = aaveStage(i);
    return stage !== null && (stage.status === 'signing' || !evmSettled(stage.status));
  };
  const waitingToMine = steps.some((_, i) => unmined(i));
  const failedOnChain = steps.some((_, i) => aaveStage(i)?.status === 'failed');
  // All started but one still to be mined: the loan is still on its way, whatever the clock says.
  const status: FundingPlanView['status'] = next === -1 ? (waitingToMine ? 'running' : 'done') : expired ? 'expired' : 'running';

  const views = steps.map((step, i): PlanStepView => {
    const what = stepWords(step, tokens);
    if (step.done) {
      const stage = aaveStage(i);
      if (stage) {
        if (stage.status === 'signing') return { i, k: step.k, mark: 'busy', what, how: 'Signing: Chain Signatures sign it for the account, usually in 8 to 20 seconds.' };
        const tx = { hash: stage.hash!, status: stage.status };
        // A step signed again with a higher fee (evm_bump) is the same call under the same nonce: the chain mines one of the two.
        if (stage.status === 'replaced') return { i, k: step.k, mark: 'done', what, how: `${EVM_CHAIN_NAME} mined an earlier signing of this step, so this later one never will be.`, tx };
        const mark: StepMark = stage.status === 'mined' ? 'done' : stage.status === 'failed' ? 'failed' : 'busy';
        return { i, k: step.k, mark, what, how: statusWords(AAVE_KINDS[step.k]!, stage.status), tx };
      }
      return stillFinishing(i, step)
        ? { i, k: step.k, mark: 'busy', what, how: `${sourceName(finishing!.lender)} is finishing it: a few seconds more.` }
        : { i, k: step.k, mark: 'done', what, how: null };
    }
    if (i !== next) return { i, k: step.k, mark: 'todo', what, how: null };
    if (expired) return { i, k: step.k, mark: 'failed', what, how: 'It didn’t run before the plan’s 30 minutes were over.' };
    // The keeper waits for an Aave step's receipt and a fresh check before it runs the next step.
    if (i > 0 && unmined(i - 1)) return { i, k: step.k, mark: 'todo', what, how: `Waiting: it runs once the step before is mined on ${EVM_CHAIN_NAME}.` };
    return { i, k: step.k, mark: 'busy', what, how: finishing ? `Waiting for ${sourceName(finishing.lender)} to finish the step before.` : runningWords(step) };
  });

  // The loan is what its steps borrow in all, which can be less than the owner asked for.
  const lends = planLends(funding);
  const asked = usd(lends > 0n ? lends : funding.amount);
  const count = steps.length;
  let headline: string;
  let detail: string;
  if (status === 'done') {
    headline = failedOnChain ? `A step of your ${asked} loan failed on ${EVM_CHAIN_NAME}: nothing moved in it.` : `Every step of your ${asked} loan has run.`;
    detail = 'Each loan step borrowed what its fresh check allowed. Your balances, and what you owe to whom, update within a few seconds.';
  } else if (next === -1) {
    headline = `Your ${asked} loan is on its way: its last step is waiting to be mined on ${EVM_CHAIN_NAME}.`;
    detail = 'The keeper sends each signed step and waits for it to be mined. You approve nothing more.';
  } else if (status === 'expired') {
    headline = `This plan ran out of time with ${left} of its ${count} steps still to run.`;
    detail = 'Nothing more of it will run. The steps that ran stay as they are, so part of the loan may have arrived. Borrow again for the rest, or drop the plan to clear it.';
  } else {
    // The step under way: the first that hasn't started, or that started at Aave and isn't mined yet.
    const under = steps.findIndex((s, i) => !s.done || unmined(i));
    headline = `Your ${asked} loan is on its way: step ${(under === -1 ? next : under) + 1} of ${count}.`;
    detail = `The keeper runs the steps in order, and you approve nothing more. The plan lasts 30 minutes: about ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'} left.`;
  }
  return { pid: funding.pid, status, headline, detail, steps: views, minutesLeft, show: status !== 'done' || !expired };
}

/** What a plan's steps borrow in all, in micro-USD: its pool and lender borrows, each at most this much. */
export function planLends(funding: Pick<FundingState, 'steps'>): bigint {
  let total = 0n;
  for (const step of funding.steps) {
    if (step.k !== 'p_borrow' && step.k !== 'l_borrow') continue;
    try {
      total += BigInt(typeof step.amt === 'number' ? Math.trunc(step.amt) : String(step.amt ?? '0'));
    } catch {
      // a step whose amount can't be read adds nothing
    }
  }
  return total;
}

/** Does the account hold a plan with steps still to start, inside its 30 minutes? `fund` refuses a second one. */
export function planRunning(funding: FundingState | null | undefined, nowMs: number): boolean {
  return fundingPlanView(funding, nowMs)?.status === 'running';
}
