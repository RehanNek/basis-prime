// What the short pause gate (pause-demo.ts) is made of, apart from the network (INTERFACES.md 50.2): its step list,
// the plan in words for a dry run, what stands in its way, what a stopped run leaves open, and its last line.
//
// The gate proves one thing: an account borrows again minutes after its USDC came home from Hyperliquid, because a
// check that sees the transfer in Hyperliquid's own history lifts the pause. It needs a transfer out of Hyperliquid
// and one check, and nothing else: no hedge, no agent, no order, no lender, no operator call. Every step is one
// the other gates already run (hedge-steps.ts and funding-steps.ts).
import { BORROW_AGAIN_MICRO, FRESH_BLOCKS, LEDGER_WAIT_MS, needsLiftWords, PAUSE_RETRY_WAIT_MS, showsOpenSends, type SendPause } from "./funding-kit.js";
import { stepBorrowAgain, stepPauseLifted, stepRepayAgain, type LiftGate } from "./funding-steps.js";
import type { Plan, StepRecord } from "./hedge-kit.js";
import { hlState, STEPS, type World } from "./hedge-steps.js";

/** The gate's steps, in order. */
export const PAUSE_STEP_IDS: readonly string[] = ["create", "deposit", "hl_init", "to_hl", "home", "pause_lifted", "borrow_again", "repay_again", "withdraw"];

/** Each step's function: hedge-demo's for the account, the two moves and the withdrawal, and gate 2's three for the lift. */
export const PAUSE_STEPS: Record<string, (g: LiftGate) => Promise<void>> = {
  create: STEPS.create,
  deposit: STEPS.deposit,
  hl_init: STEPS.hl_init,
  to_hl: STEPS.to_hl,
  home: STEPS.home,
  pause_lifted: stepPauseLifted,
  borrow_again: stepBorrowAgain,
  repay_again: stepRepayAgain,
  withdraw: STEPS.withdraw,
};

/**
 * What the factory gave a new account before the deploy of INTERFACES.md 50.2, read from the factory on 13 Nov
 * (`account_code_hash()` and `get_config().risk.version_key`) and named in research/send_pause_plan.md as the way
 * back. An account with that code shows no `open_sends`, and that engine names no transfer as sent: with either
 * still in place the gate can't pass, and the dry run says so.
 */
export const ACCOUNT_CODE_BEFORE_LIFT = "79827e65a44d0edb1c640ea4401c3fcdf53e22aed10e7339b7e40a98f6470ea4";
export const RISK_BEFORE_LIFT = "fb2cee3bb0b9dd8215b8c667a27dc6c565868487ccdf2e402f0327d516b2aee6";

/** A new account takes 6 NEAR of the keeper's; the checks (0.01 each, two at most) and the gas a little more. */
export const PAUSE_OWNER_NEAR = 6.2;
/** A run that goes on with an account that exists needs only the checks and the gas. */
export const PAUSE_RESUME_NEAR = 0.2;

// ---------- the plan in words ----------

export interface PauseWords {
  account: string;
  owner: string;
  apiUrl: string;
  shimUrl: string;
  plan: Plan;
  recordFile: string;
}

/** Every step of the gate, in order, with what it sends and what it checks: the dry run prints this. */
export function describePauseGate(w: PauseWords): string[] {
  const usdc = Number(w.plan.deposit_usdc_micro) / 1e6;
  const btc = Number(w.plan.deposit_nbtc_units) / 1e8;
  const toHl = Number(w.plan.to_hl_micro) / 1e6;
  const loan = Number(BORROW_AGAIN_MICRO) / 1e6;
  return [
    `account ${w.account}, owned by ${w.owner}; backend ${w.apiUrl}; the 1Click stand-in ${w.shimUrl}`,
    `the book: $${usdc} of test USDC and ${btc} test nBTC (about $${Math.round(btc * w.plan.btc_px).toLocaleString("en-US")} at BTC $${w.plan.btc_px.toLocaleString("en-US")}). $${toHl} of the USDC goes to Hyperliquid and comes straight back. No hedge, no agent, no order, no lender, no operator call`,
    "",
    "the steps, signed by the client (the keeper's key owns the gate's account):",
    "1 create          create_account with 6 NEAR. Checks: the keeper owns the account",
    "2 deposit         mint and deposit the test USDC and test nBTC. Checks: the account holds both",
    "3 hl_init         the account's Hyperliquid address, through Chain Signatures. Checks: get_state().hl.address is set",
    `4 to_hl           a move quote from the backend, withdraw to its deposit address, and the stand-in's status until SUCCESS. Checks: the USDC shows on Hyperliquid`,
    "5 home            a move quote, hl_withdraw of what Hyperliquid shows as withdrawable less a cent, the signed transfer posted through POST /api/hl/submit, and the status until SUCCESS. Checks: the stand-in delivered the USDC to the account. This is the transfer that starts the pause",
    `6 pause_lifted    nothing is sent until Hyperliquid's own history shows that transfer (up to ${LEDGER_WAIT_MS / 60_000} minutes); then request_check with {"borrow":{"amount":"${BORROW_AGAIN_MICRO}"}} (0.01 NEAR). Checks: once the result is accepted, get_state().hl.send_open_until_ms is "0" and open_sends is empty. If not, one more check ${PAUSE_RETRY_WAIT_MS / 1000} s later; a second miss fails the step. An account that shows no open_sends was made before the deploy: the step fails and says so`,
    `7 borrow_again    the client's borrow with that same check result (another check only if its ${FRESH_BLOCKS} blocks ran out), for $${loan} or what the result allows if that is less, with 1 yoctoNEAR. Checks: the pool's debt_of is above 0, and the USDC arrived in the account`,
    "8 repay_again     repay to our pool, all of it. Checks: debt_of is 0 and the loan is closed",
    "9 withdraw        both tokens back to the client, with no check. Checks: the account holds neither token",
    "",
    "it passes when all nine steps pass, and then says how many seconds after the USDC came home the loan arrived",
    `the record: ${w.recordFile}, saved after every step; --from <step> resumes from it`,
  ];
}

// ---------- what must be there before the gate can run ----------

/** What the script found on testnet and on this machine before it sends anything. `null` means the read failed. */
export interface PauseFound {
  account: string;
  accountExists: boolean | null;
  /** This run goes on with an earlier one (--from). */
  resuming: boolean;
  /**
   * For an account that exists: its `get_state().hl` (null when the state couldn't be read; left out when the state
   * has no `hl` at all), and the engine it pins. Both left out when the account doesn't exist.
   */
  hl?: SendPause | null;
  ownRisk?: string | null;
  owner: string;
  ownerNear: number | null;
  /** The factory: whether it is paused, the hash of the account code it gives a new account, and the engine it pins. */
  factoryPaused: boolean | null;
  accountCode: string | null;
  factoryRisk: string | null;
  apiUrl: string;
  /** The backend's GET /api/config. */
  backend: { hl_api?: string } | null;
  shimUrl: string;
  /** Whether the stand-in answered GET /v0/tokens. */
  standIn: boolean | null;
  /** The float's USDC in perps on Hyperliquid: the stand-in delivers the move to Hyperliquid from it. */
  floatUsdc: number | null;
  /** What the gate moves to Hyperliquid, in dollars. */
  toHlUsd: number;
  /**
   * The move to Hyperliquid has run already (a run going on from `home` or later): the float needs nothing for it.
   * Left out, the move is still to come. Found on 14 Nov, bringing home the margin of a gate that had stopped: the
   * float was short exactly because that account held its USDC, and the start-up check refused the way home.
   */
  toHlDone?: boolean;
}

const short = (hash: string) => `${hash.slice(0, 8)}…`;

/**
 * What stands in the gate's way, in words that say what to do, and one line per thing found. An empty `problems`
 * means the run can start.
 */
export function pauseProblems(f: PauseFound): { lines: string[]; problems: string[] } {
  const lines: string[] = [];
  const problems: string[] = [];

  // The account. A new one gets the factory's code and engine; one that exists has its own.
  if (f.accountExists === null) problems.push(`couldn't read whether ${f.account} exists: is NEAR_RPC_URL reachable?`);
  else if (f.accountExists && !f.resuming) problems.push(`${f.account} exists already: the gate starts from a fresh account, so give a new --name (or --from <step> to go on with this one)`);
  else if (f.accountExists) {
    if (f.hl === null) problems.push(`couldn't read ${f.account}'s state`);
    else if (f.hl === undefined) lines.push(`${f.account} exists: resuming. Its state shows nothing of Hyperliquid yet, so whether it shows open_sends can't be said before pause_lifted`);
    else if (!showsOpenSends(f.hl)) problems.push(needsLiftWords(f.account));
    else lines.push(`${f.account} exists and shows open_sends: resuming`);
    if (f.ownRisk === RISK_BEFORE_LIFT) problems.push(`${f.account} pins the engine from before the deploy (pb-risk ${short(RISK_BEFORE_LIFT)}): its results name no transfer as sent, so no check would lift the pause. Use a new --name once the factory pins the new engine`);
  } else {
    lines.push(`${f.account} doesn't exist yet: it will be made`);
    if (f.factoryPaused === null || f.accountCode === null || f.factoryRisk === null) problems.push("couldn't read the factory (is_paused, account_code_hash, get_config): is NEAR_RPC_URL reachable?");
    else {
      if (f.factoryPaused) problems.push("the factory is paused: it makes no account");
      if (f.accountCode === ACCOUNT_CODE_BEFORE_LIFT) problems.push(`the factory still gives new accounts the code from before the deploy (account_code_hash ${short(ACCOUNT_CODE_BEFORE_LIFT)}): a new account wouldn't show open_sends, and the gate would stop at pause_lifted. The factory's redeploy comes first`);
      else lines.push(`the factory gives new accounts the code ${short(f.accountCode)}, not the one from before the deploy`);
      if (f.factoryRisk === RISK_BEFORE_LIFT) problems.push(`the factory still pins the engine from before the deploy (pb-risk ${short(RISK_BEFORE_LIFT)}): its results name no transfer as sent, so no check would lift the pause. The factory's set_config with the new risk.version_key comes first`);
      else lines.push(`the factory pins pb-risk ${short(f.factoryRisk)}, not the one from before the deploy`);
    }
  }

  // The keeper's NEAR: it owns the account and pays for it.
  const need = f.accountExists ? PAUSE_RESUME_NEAR : PAUSE_OWNER_NEAR;
  if (f.ownerNear === null) problems.push(`couldn't read ${f.owner}'s balance`);
  else if (f.ownerNear < need) problems.push(`${f.owner} holds ${f.ownerNear.toFixed(2)} NEAR: ${f.accountExists ? "the checks (0.01 each) and the gas take about 0.2" : "a new account takes 6, and the checks and gas about 0.2 more"}. Top it up from the testnet faucet`);
  else lines.push(`${f.owner} holds ${f.ownerNear.toFixed(4)} NEAR`);

  // The backend gives the two move quotes, reads Hyperliquid and posts the signed transfer. No gateway is needed.
  if (f.backend === null) problems.push(`the backend at ${f.apiUrl} doesn't answer: pnpm --filter @pb/api start`);
  else if (!f.backend.hl_api?.includes("testnet")) problems.push(`the backend talks to ${String(f.backend.hl_api)}, not Hyperliquid testnet`);
  else lines.push("the backend answers, and talks to Hyperliquid testnet");

  // The stand-in carries the USDC both ways, and delivers on Hyperliquid from the float's perps balance.
  if (!f.standIn) problems.push(`the 1Click stand-in at ${f.shimUrl} doesn't answer GET /v0/tokens: pnpm --filter @pb/oneclick-shim start`);
  else lines.push("the 1Click stand-in answers");
  if (f.toHlDone) lines.push(`the float holds ${f.floatUsdc === null ? "an unread amount of" : f.floatUsdc.toFixed(2)} USDC in perps on Hyperliquid; the move to Hyperliquid has run already, so nothing more is delivered from it`);
  else if (f.floatUsdc === null) problems.push("couldn't read the float on Hyperliquid testnet");
  else if (f.floatUsdc < f.toHlUsd + 1) problems.push(`the float holds ${f.floatUsdc.toFixed(2)} USDC in perps on Hyperliquid, and the stand-in delivers the gate's $${f.toHlUsd} from it. Top it up on Hyperliquid testnet`);
  else lines.push(`the float holds ${f.floatUsdc.toFixed(2)} USDC in perps on Hyperliquid: enough for the $${f.toHlUsd} the stand-in delivers`);
  return { lines, problems };
}

// ---------- the end of a run ----------

/** What a run that passed showed: the loan, and how soon after the USDC came home it arrived. */
export function pausePassWords(steps: StepRecord[], context: Record<string, unknown>): string {
  const again = steps.find((s) => s.id === "borrow_again");
  const detail = (again?.detail ?? {}) as { borrowed?: unknown; seconds_since_home?: unknown };
  const amount = `$${(Number(detail.borrowed ?? 0) / 1e6).toFixed(2)}`;
  const sinceHome = typeof detail.seconds_since_home === "number" ? `${detail.seconds_since_home} s after the USDC came home from Hyperliquid` : "after the USDC came home from Hyperliquid";
  // The transfer's nonce is the time the account asked for its signature, in ms.
  const lifted = context.pause_lifted as { open_before?: unknown[]; checks?: unknown } | undefined;
  const signed = Number(lifted?.open_before?.[0]);
  const arrived = again ? Date.parse(again.started_utc) + again.seconds * 1000 : Number.NaN;
  const sinceSigned = Number.isFinite(signed) && signed > 0 && Number.isFinite(arrived) ? ` (${Math.round((arrived - signed) / 1000)} s after that transfer was signed)` : "";
  const checks = typeof lifted?.checks === "number" ? `${lifted.checks} check${lifted.checks === 1 ? "" : "s"}` : "a check";
  return `${checks} lifted the pause, and a loan of ${amount} from our pool arrived ${sinceHome}${sinceSigned}. It was repaid, and both tokens were withdrawn`;
}

/**
 * What a stopped run leaves, and the step that deals with it. Reads only: this gate posts no order, so nothing of
 * the float's is touched (another gate may be using it).
 */
export async function pauseLeftovers(w: World): Promise<string[]> {
  const lines: string[] = [];
  const soft = async <T>(read: () => Promise<T>): Promise<T | null> => read().catch(() => null);
  if (!(await soft(() => w.near.exists(w.account)))) return [`${w.account} wasn't made: nothing is left open`];
  const hl = await soft(() => hlState(w));
  const onHl = Number(hl?.hyperliquid?.clearinghouse_state?.withdrawable ?? 0);
  if (hl === null) lines.push(`couldn't read ${w.account} on Hyperliquid`);
  else if (onHl >= 1) lines.push(`${w.account} holds ${onHl.toFixed(2)} USDC on Hyperliquid: --from home brings it back`);
  const debt = await soft(() => w.near.view<string>(w.ids.pool, "debt_of", { account_id: w.account }));
  if (debt !== null && BigInt(debt) > 0n) lines.push(`${w.account} owes our pool $${(Number(debt) / 1e6).toFixed(2)}: --from repay_again repays it`);
  const [usdc, nbtc] = await Promise.all([w.ids.musdc, w.ids.mnbtc].map((token) => soft(() => w.near.view<string>(token, "ft_balance_of", { account_id: w.account }))));
  if ((usdc !== null && usdc !== "0") || (nbtc !== null && nbtc !== "0")) lines.push(`${w.account} holds $${(Number(usdc ?? 0) / 1e6).toFixed(2)} of test USDC and ${Number(nbtc ?? 0) / 1e8} test nBTC: --from withdraw sends them back to ${w.owner}`);
  if (lines.length === 0) lines.push("nothing is left open");
  return lines;
}
