// Signed NEAR calls for the keeper and the testnet tools (near-api-js 7.4.0). Each call waits until the transaction
// and its receipts are final, and comes back as a plain record: the hash, whether it worked, the gas, the contract's
// own words when it failed, the return value and the logs. A failure never throws; it is in the record.
//
// The key is given once, when the caller is made, and never printed. near-api-js keeps one nonce counter per key
// and retries a transaction that hit a used nonce, so two programs signing with the same key (the keeper and a gate
// script) only cost a retry.
import { Account, actions, getTransactionLastResult, type JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";

export interface TxResult {
  label: string;
  hash: string | null;
  ok: boolean;
  /** Gas burnt by the transaction and every receipt, in TGas. */
  gas_tgas: number;
  failure?: string;
  /** Receipts by contract, with their gas. */
  receipts?: { executor: string; gas_tgas: number }[];
  /** The transaction's return value (the last receipt's), when it worked. */
  result?: unknown;
  seconds: number;
  logs: string[];
}

export interface CallOptions {
  tgas: number;
  deposit: bigint;
  label: string;
}

export type NearCall = (contract: string, method: string, args: Record<string, unknown>, options: CallOptions) => Promise<TxResult>;

/** The parts of a transaction outcome the record keeps. */
export interface Outcome {
  transaction?: { hash?: string };
  transaction_outcome?: { outcome?: { gas_burnt?: number } };
  status?: unknown;
  receipts_outcome?: { outcome?: { executor_id?: string; gas_burnt?: number; logs?: string[]; status?: unknown } }[];
}

/** The contract's words for a failed status, or undefined if it didn't fail. */
export function failureText(status: unknown): string | undefined {
  if (!status || typeof status !== "object" || !("Failure" in status)) return undefined;
  const text = JSON.stringify((status as { Failure: unknown }).Failure);
  return /"ExecutionError":"([^"]*)"/.exec(text)?.[1] ?? text.slice(0, 400);
}

/** A finished transaction's outcome as a TxResult. */
export function txResult(label: string, outcome: Outcome, seconds: number): TxResult {
  const receipts = (outcome.receipts_outcome ?? []).map((r) => ({ executor: r.outcome?.executor_id ?? "?", gas_tgas: Number(r.outcome?.gas_burnt ?? 0) / 1e12 }));
  const gas = Number(outcome.transaction_outcome?.outcome?.gas_burnt ?? 0) / 1e12 + receipts.reduce((s, r) => s + r.gas_tgas, 0);
  const failure = failureText(outcome.status);
  let result: unknown;
  if (!failure) {
    try {
      result = getTransactionLastResult(outcome as Parameters<typeof getTransactionLastResult>[0]);
    } catch {
      result = undefined;
    }
  }
  const receiptFailures = (outcome.receipts_outcome ?? []).map((r) => failureText(r.outcome?.status)).filter(Boolean);
  return {
    label,
    hash: outcome.transaction?.hash ?? null,
    ok: !failure,
    gas_tgas: Math.round(gas * 100) / 100,
    ...(failure ? { failure } : receiptFailures.length ? { failure: `a receipt failed: ${receiptFailures[0]}` } : {}),
    receipts,
    result,
    seconds: Math.round(seconds * 10) / 10,
    logs: (outcome.receipts_outcome ?? []).flatMap((r) => r.outcome?.logs ?? []),
  };
}

/** Signs as `accountId` with `key`. */
export function nearCaller(provider: JsonRpcProvider, accountId: string, key: string): NearCall {
  const account = new Account(accountId, provider, key as KeyPairString);
  return async (contract, method, args, options) => {
    const started = Date.now();
    try {
      const outcome = (await account.signAndSendTransaction({
        receiverId: contract,
        actions: [actions.functionCall(method, args, teraToGas(options.tgas), options.deposit)],
        waitUntil: "FINAL",
        throwOnFailure: false,
      })) as unknown as Outcome;
      return txResult(options.label, outcome, (Date.now() - started) / 1000);
    } catch (error) {
      return { label: options.label, hash: null, ok: false, gas_tgas: 0, failure: error instanceof Error ? error.message : String(error), seconds: (Date.now() - started) / 1000, logs: [] };
    }
  };
}

/** NEP-297 events in a transaction's logs: `EVENT_JSON:{"standard","version","event","data"}`. */
export function eventsIn(logs: string[]): { event: string; data: unknown }[] {
  const events: { event: string; data: unknown }[] = [];
  for (const line of logs) {
    if (!line.startsWith("EVENT_JSON:")) continue;
    try {
      const parsed = JSON.parse(line.slice("EVENT_JSON:".length)) as { event?: unknown; data?: unknown };
      if (typeof parsed.event === "string") events.push({ event: parsed.event, data: parsed.data });
    } catch {
      // not an event after all
    }
  }
  return events;
}

/** One settlement as the pool booked it (its `settle` event; INTERFACES.md 26 and 45.1). Money is micro-USD, in strings. */
export interface PoolSettled {
  fee: string;
  subsidy: string;
  /**
   * What the pool's 24-hour budgets cut: from a subsidy, and (since INTERFACES.md 45.1) from a fee too. It isn't
   * owed later.
   */
  cut: string;
  credit: string;
  period_ns: string;
  /** The account's debt to our pool afterwards. */
  debt?: string;
}

/**
 * What the pool answered a settlement, read from the transaction's logs. The account's own `settle()` answers only
 * that the pool's call ran (`true`), whatever the pool did. The pool logs a `settle` event when it books one, and the
 * account logs the pool's reason when it booked none ("the pool settled nothing: <why>"). Null when the logs have
 * neither.
 */
export function settlementIn(logs: string[]): PoolSettled | { skipped: string } | null {
  const money = (value: unknown) => (typeof value === "string" && /^\d+$/.test(value) ? value : null);
  for (const { event, data } of eventsIn(logs)) {
    const d = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
    if (event !== "settle" || !d || typeof d !== "object") continue;
    const [fee, subsidy, debt] = [money(d.fee), money(d.subsidy), money(d.debt)];
    if (fee === null || subsidy === null) continue;
    return { fee, subsidy, cut: money(d.cut) ?? "0", credit: money(d.credit) ?? "0", period_ns: money(d.period_ns) ?? "0", ...(debt !== null ? { debt } : {}) };
  }
  const nothing = "the pool settled nothing: ";
  const line = logs.find((l) => l.startsWith(nothing));
  return line ? { skipped: line.slice(nothing.length) } : null;
}

/**
 * Whether the pool skipped a settlement because the account's last one was too short a time ago: its answer then
 * starts "too soon" (contracts/pool/src/settle.rs).
 */
export function skippedTooSoon(answer: unknown): boolean {
  const skipped = (answer as { skipped?: unknown } | null | undefined)?.skipped;
  return typeof skipped === "string" && skipped.startsWith("too soon");
}

/**
 * Why an `execute_step` whose transaction went through still moved nothing, in words, or null if it moved.
 *
 * - Phase 6: a funding or top-up step that didn't go out reopens, and the account's log says why ("step 1 of plan
 *   f123 didn't go out, as Rhea refused it: nothing was borrowed, and it may run again"). Those words are passed on.
 * - What execute_step returns (INTERFACES.md 14, as built): `repay` (and `l_repay`), the amount used, "0" for none;
 *   `home`, the new signed entry or null; every other kind, whether it went out, `false` for no.
 * The step may run again, and its `done` on the next tick is what the keeper goes by.
 */
export function stepStalled(kind: string, tx: Pick<TxResult, "ok" | "result" | "logs">): string | null {
  if (!tx.ok) return null;
  const reopened = tx.logs.find((line) => line.includes("didn't go out"));
  if (reopened) return reopened;
  const r = tx.result;
  if (r === undefined) return null;
  const nothing = kind === "repay" || kind === "l_repay" ? String(r) === "0" : kind === "home" ? r === null : r === false;
  return nothing ? `nothing moved (execute_step returned ${JSON.stringify(r)}): the step may run again` : null;
}

export const ONE_YOCTO = 1n;
/** request_check and request_agent: at least 0.01 NEAR for OutLayer, which refunds the unused part (INTERFACES.md 4). */
export const CHECK_DEPOSIT = 10n ** 22n;
/** Every account method that calls out is given 300 TGas (INTERFACES.md 4 and 14). */
export const TGAS_ACCOUNT = 300;
