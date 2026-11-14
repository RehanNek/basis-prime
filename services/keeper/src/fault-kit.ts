// What the fault runs (fault-run.ts) check, apart from the network (PLAN.md 11.5: "after each of the shim's faults
// (refund, failure, late delivery), the account's records are right"; INTERFACES.md 14). For each fault the script
// makes one small move with the stand-in's fault switch set, and snapshots the account before, just after its call,
// and once the fault has played out:
//
//   refund (a move to Hyperliquid): REFUNDED. The pending transfer is gone, resolved by the refund's msg, and the
//          account's mUSDC is back where it was.
//   fail   (a move to Hyperliquid): FAILED. Nothing comes back, so the transfer stays pending until its deadline,
//          when it becomes overdue; the mUSDC is gone.
//   late   (a move home):           SUCCESS, later than quoted. The transfer stays pending until the late delivery's
//          msg resolves it, and the mUSDC arrives.
import { pendingTransfers, type PendingTransfer } from "./plan.js";

export type FaultMode = "refund" | "fail" | "late";

export interface FaultSnapshot {
  at: string;
  counter: number;
  /** The account's pending 1Click transfers (INTERFACES.md 14). */
  transfers: PendingTransfer[];
  /** get_state().pending as it is, borrows included. */
  pending: unknown[];
  /** The account's mUSDC on NEAR, in units. */
  musdc: string;
  /** Hyperliquid's view of the account's address, in USDC. */
  hl: { withdrawable: number | null; account_value: number | null };
}

export function snapshotOf(at: number, state: { counter: number; pending?: unknown[] }, musdc: string, hl: FaultSnapshot["hl"]): FaultSnapshot {
  return { at: new Date(at).toISOString(), counter: state.counter, transfers: pendingTransfers(state.pending), pending: state.pending ?? [], musdc, hl };
}

export const EXPECTED_STATUS: Record<FaultMode, string> = { refund: "REFUNDED", fail: "FAILED", late: "SUCCESS" };

export interface FaultChecks {
  transfer_id: string | null;
  status: string;
  status_ok: boolean;
  /** The account recorded the transfer as pending when it sent it. */
  recorded: boolean;
  /** It is gone from pending afterwards (refund and late), or still there (fail). */
  resolved: boolean;
  records_ok: boolean;
  musdc: { before: string; after: string; change: string; expected_change: string };
  balance_ok: boolean;
  /** For the late delivery: how long after the account's call it came, and the delay asked for. */
  late?: { seconds: number; delay_seconds: number; ok: boolean };
  words: string[];
  pass: boolean;
}

export function faultChecks(input: {
  fault: FaultMode;
  transferId: string | null;
  amountMicro: bigint;
  /** What the account should get back on a late delivery home (the quote's amountOut, in mUSDC units). */
  deliveredMicro?: bigint;
  before: FaultSnapshot;
  during: FaultSnapshot;
  after: FaultSnapshot;
  status: string;
  /** Seconds from the account's call to the final status, and the late fault's delay. */
  late?: { seconds: number; delaySeconds: number };
}): FaultChecks {
  const { fault, transferId, before, during, after } = input;
  const words: string[] = [];
  const statusOk = input.status === EXPECTED_STATUS[fault];
  if (!statusOk) words.push(`1Click's status is ${input.status}, not ${EXPECTED_STATUS[fault]}`);
  const has = (s: FaultSnapshot) => transferId !== null && s.transfers.some((t) => t.id === transferId);
  const recorded = has(during);
  if (transferId === null) words.push("the backend named no transfer: the account's get_state has no next_move, so it records no pending transfer for a move");
  else if (!recorded) words.push(`the account recorded no pending transfer ${transferId} when it sent the move`);
  const stillThere = has(after);
  const resolved = fault === "fail" ? stillThere : !stillThere;
  if (recorded && !resolved) words.push(fault === "fail" ? `transfer ${transferId} left pending though nothing came back` : `transfer ${transferId} is still pending after the ${fault === "refund" ? "refund" : "delivery"}`);
  const change = BigInt(after.musdc) - BigInt(before.musdc);
  const expected = fault === "refund" ? 0n : fault === "fail" ? -input.amountMicro : (input.deliveredMicro ?? 0n);
  const balanceOk = fault === "late" && input.deliveredMicro === undefined ? change > 0n : change === expected;
  if (!balanceOk) words.push(`the account's mUSDC changed by ${change}, not ${expected}`);
  const late = input.late ? { seconds: input.late.seconds, delay_seconds: input.late.delaySeconds, ok: input.late.seconds >= input.late.delaySeconds } : undefined;
  if (late && !late.ok) words.push(`the delivery came ${late.seconds} s after the call, before the ${late.delay_seconds} s delay`);
  const recordsOk = recorded && resolved;
  return {
    transfer_id: transferId,
    status: input.status,
    status_ok: statusOk,
    recorded,
    resolved,
    records_ok: recordsOk,
    musdc: { before: before.musdc, after: after.musdc, change: change.toString(), expected_change: expected.toString() },
    balance_ok: balanceOk,
    ...(late && { late }),
    words,
    pass: statusOk && recordsOk && balanceOk && (late?.ok ?? true),
  };
}
