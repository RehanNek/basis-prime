'use client';
// One button for an action that needs a fresh check (INTERFACES.md 4; 9 Nov redesign). It asks for the check, waits
// for the verdict to land in the account, then sends the action at once, while the verdict is fresh. If the action's
// approval doesn't open by itself (a popup blocker, or the wallet was closed), the verdict stays good for about a
// minute and a Confirm button sends it.
//
// The app's second shape (INTERFACES.md 49.4): the broker pays for the check. The page posts POST /api/check, the
// keeper sends it and asks again when OutLayer returns nothing, and the client's wallet opens once, for the action.
// When the broker can't run it (no such route, the keeper isn't running, or it refuses to), the page falls back to
// the check from the client's own wallet, as before: lib/broker-check.ts has the rule.
import { useCallback, useEffect, useRef, useState } from 'react';

import { accountPath, api, ApiError, postCheck, type AccountAnswer } from '@/lib/api';
import { brokerCheckOutcome, type BrokerCheck } from '@/lib/broker-check';
import { NO_ANSWER_WORDS } from '@/lib/outlayer';
import { isLoan, stillPausedWords } from '@/lib/hl';
import { requestCheckTx, txFailure, txHash, txLogs, type Outcome, type Tx } from '@/lib/tx';
import type { Intent, StoredVerdict } from '@/lib/types';
import { verdictUse, type Use } from '@/lib/verdict';
import { useNearWallet } from '@/providers/near-provider';

/**
 * OutLayer's yield window is 200 blocks: after it, the account gets nothing. That is two minutes at testnet's
 * fastest blocks and over three at its slowest, so the page waits four.
 */
const WAIT_LIMIT_MS = 240_000;
const POLL_MS = 2_000;
/**
 * How long the page watches for the broker's check: the keeper asks up to three times, each with OutLayer's window,
 * so this is longer than one check from the wallet.
 */
const BROKER_WAIT_MS = 9 * 60_000;

export interface Act {
  label: string;
  use: Use;
  tx: Tx;
  /** What to say once it is sent, when "Done" would say too much: `fund` only stores a plan (INTERFACES.md 25). */
  done?: string;
  /**
   * Called with the outcome once the action's transaction went through. Stage 3: an action at Aave only has the account
   * sign an Ethereum transaction, which the page then sends to Aave's chain (hooks/use-evm-send.ts).
   */
  onSent?: (outcome: Outcome) => void;
}

export interface Job {
  intent: Intent;
  /** What the check is for. Without it, the check is all there is (a plain check). */
  act?: Act | null;
}

/**
 * Where the chain is; `height` and `at` are the block height read at `at` (ms), to count the verdict down.
 * `broker` is true on a run whose check the broker paid for: the page then shows one calm line for the check, and
 * the wallet's steps of before only when it fell back.
 */
export type FlowState =
  | { phase: 'idle' }
  /** The broker's check is running (INTERFACES.md 49.4). Its retries don't show. */
  | { phase: 'broker'; since: number }
  | { phase: 'check'; fellBack?: string }
  | { phase: 'verdict'; checkHash?: string; since: number; fellBack?: string }
  | { phase: 'act'; checkHash?: string; verdict: StoredVerdict; height: number; at: number; broker?: boolean }
  | { phase: 'confirm'; checkHash?: string; verdict: StoredVerdict; height: number; at: number; note: string; broker?: boolean }
  /** `note`: after a plain check on an account whose pause lifts early (INTERFACES.md 50.2), what to say when the pause is still on. */
  | { phase: 'done'; checkHash?: string; actHash?: string; verdict: StoredVerdict; broker?: boolean; note?: string }
  | { phase: 'refused'; checkHash?: string; verdict: StoredVerdict; why: string; height: number; at: number; broker?: boolean }
  | { phase: 'failed'; step: 'check' | 'verdict' | 'act'; checkHash?: string; actHash?: string; why: string; logs: string[]; broker?: boolean };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function walletWords(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return /reject|cancel/i.test(text) ? 'Cancelled in the wallet' : text;
}

const sameIntent = (a: Intent, b: Intent) => JSON.stringify(a) === JSON.stringify(b);

export function useCheckThenAct(accountId: string, onChange?: () => void) {
  const { sendTx } = useNearWallet();
  const [state, setState] = useState<FlowState>({ phase: 'idle' });
  const job = useRef<Job | null>(null);
  const alive = useRef(true);
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const set = useCallback((next: FlowState) => {
    if (alive.current) setState(next);
  }, []);
  const notify = useCallback(() => changed.current?.(), []);

  const read = useCallback(() => api<AccountAnswer>(accountPath(accountId)), [accountId]);

  /** Sends the action with a verdict that can back it. */
  const act = useCallback(
    async (a: Act, verdict: StoredVerdict, height: number, at: number, checkHash?: string, broker = false) => {
      set({ phase: 'act', checkHash, verdict, height, at, broker });
      try {
        const outcome = await sendTx(a.tx);
        const failure = txFailure(outcome);
        if (failure) set({ phase: 'failed', step: 'act', checkHash, actHash: txHash(outcome), why: failure, logs: txLogs(outcome), broker });
        else {
          set({ phase: 'done', checkHash, actHash: txHash(outcome), verdict, broker });
          a.onSent?.(outcome);
        }
      } catch (error) {
        const why = walletWords(error);
        set({
          phase: 'confirm',
          checkHash,
          verdict,
          height,
          at,
          note: why === 'Cancelled in the wallet' ? 'The wallet closed before you approved it.' : `The wallet didn't open by itself (${why}).`,
          broker,
        });
      }
      notify();
    },
    [notify, sendTx, set],
  );

  /** A verdict for this intent that landed after `fromBlock`, from one read of the account, or null. */
  const landed = useCallback(
    async (intent: Intent, fromBlock: number): Promise<{ stored: StoredVerdict; answer: AccountAnswer } | null> => {
      const answer = await read();
      const v = answer.state?.verdict;
      return v && answer.state && v.received_block > fromBlock && sameIntent(v.intent, intent) ? { stored: v, answer } : null;
    },
    [read],
  );

  /** With the check's result in the account: say so, or send the action it backs. */
  const proceed = useCallback(
    async (next: Job, found: { stored: StoredVerdict; answer: AccountAnswer }, checkHash: string | undefined, broker: boolean) => {
      const { stored, answer } = found;
      const at = Date.now();
      // INTERFACES.md 50.2: on an account whose pause lifts early, the check is what lifts it. With the result in, the
      // pause is read again from the same read of the account.
      const still = stillPausedWords(answer.state?.hl, at);
      if (!next.act) {
        set({ phase: 'done', checkHash, verdict: stored, broker, ...(still ? { note: still } : {}) });
        notify();
        return;
      }
      // Still on: the account would refuse the loan, so the wallet isn't opened for it.
      if (still && isLoan(next.act.use)) {
        set({ phase: 'failed', step: 'act', checkHash, why: still, logs: [], broker });
        notify();
        return;
      }
      const usable = verdictUse(stored, answer.state!.counter, answer.block_height, next.act.use, answer.state!.permission_blk);
      if (!usable.ok) {
        set({ phase: 'refused', checkHash, verdict: stored, why: usable.why, height: answer.block_height, at, broker });
        notify();
        return;
      }
      await act(next.act, stored, answer.block_height, at, checkHash, broker);
    },
    [act, notify, set],
  );

  /** The check from the client's own wallet, as before: the fallback when the broker can't run it. */
  const walletRun = useCallback(
    async (next: Job, fromBlock: number, fellBack?: string) => {
      set({ phase: 'check', fellBack });
      let outcome;
      try {
        outcome = await sendTx(requestCheckTx(accountId, next.intent));
      } catch (error) {
        set({ phase: 'failed', step: 'check', why: walletWords(error), logs: [] });
        return;
      }
      const checkHash = txHash(outcome);
      const failure = txFailure(outcome);
      if (failure) {
        set({ phase: 'failed', step: 'check', checkHash, why: failure, logs: txLogs(outcome) });
        return;
      }
      set({ phase: 'verdict', checkHash, since: Date.now(), fellBack });
      notify();

      const until = Date.now() + WAIT_LIMIT_MS;
      let found: { stored: StoredVerdict; answer: AccountAnswer } | null = null;
      while (!found && Date.now() < until && alive.current) {
        await sleep(POLL_MS);
        found = await landed(next.intent, fromBlock).catch(() => null);
      }
      if (!alive.current) return;
      if (!found) {
        set({
          phase: 'failed',
          step: 'verdict',
          checkHash,
          why: NO_ANSWER_WORDS,
          logs: txLogs(outcome),
        });
        notify();
        return;
      }
      await proceed(next, found, checkHash, false);
    },
    [accountId, landed, notify, proceed, sendTx, set],
  );

  /**
   * The broker's check (INTERFACES.md 49.4): POST /api/check, while the page watches the account for the result. The
   * keeper's retries don't show. Returns what came of it: the result landed, the answer was no, or the broker can't
   * run it and the wallet's own check takes over.
   */
  const brokerRun = useCallback(
    async (next: Job, fromBlock: number): Promise<{ kind: 'landed'; found: { stored: StoredVerdict; answer: AccountAnswer }; tx: string | null } | { kind: 'refused' | 'fallback' | 'silent'; why: string; detail?: string }> => {
      let posted: BrokerCheck | null = null;
      const post = postCheck(accountId, next.intent).then(
        (answer) => brokerCheckOutcome({ ok: true, answer }),
        (error: unknown) =>
          brokerCheckOutcome(error instanceof ApiError ? { ok: false, status: error.status, code: error.code, message: error.message } : { ok: false, status: 0, message: String(error) }),
      );
      void post.then((outcome) => {
        posted = outcome;
      });
      const until = Date.now() + BROKER_WAIT_MS;
      while (Date.now() < until && alive.current) {
        // A refusal to run it comes back at once: don't make the client wait a poll for the fallback.
        await Promise.race([post, sleep(POLL_MS)]);
        const said = posted as BrokerCheck | null;
        if (said?.kind === 'fallback' || said?.kind === 'refused') return said;
        const found = await landed(next.intent, fromBlock).catch(() => null);
        if (found) return { kind: 'landed', found, tx: said?.kind === 'accepted' ? said.tx : null };
        // Accepted, and the backend's node doesn't show it yet: read again after a moment.
        if (said) await sleep(POLL_MS);
      }
      return { kind: 'silent', why: NO_ANSWER_WORDS };
    },
    [accountId, landed],
  );

  const run = useCallback(
    async (next: Job, paidBy: 'broker' | 'wallet' = 'broker') => {
      job.current = next;
      set(paidBy === 'broker' ? { phase: 'broker', since: Date.now() } : { phase: 'check' });
      let fromBlock = 0;
      try {
        fromBlock = (await read()).state?.verdict?.received_block ?? 0;
      } catch {
        // the wait below only takes a verdict for this intent, so an unknown start is safe
      }
      if (paidBy === 'wallet') {
        await walletRun(next, fromBlock);
        return;
      }
      const outcome = await brokerRun(next, fromBlock);
      if (!alive.current) return;
      if (outcome.kind === 'landed') {
        notify();
        await proceed(next, outcome.found, undefined, true);
      } else if (outcome.kind === 'fallback') {
        await walletRun(next, fromBlock, outcome.why);
      } else {
        set({ phase: 'failed', step: 'verdict', why: outcome.why, logs: outcome.detail ? [outcome.detail] : [], broker: true });
        notify();
      }
    },
    [brokerRun, notify, proceed, read, set, walletRun],
  );

  /**
   * Sends an action with the verdict already stored: after the wallet closed, or a smaller amount after a refusal.
   * Reads the account first, so an expired or used verdict is said rather than paid for.
   */
  const confirm = useCallback(
    async (override?: Act) => {
      const a = override ?? job.current?.act;
      if (!a) return;
      let answer: AccountAnswer;
      try {
        answer = await read();
      } catch (error) {
        set({ phase: 'failed', step: 'act', why: error instanceof ApiError ? error.message : String(error), logs: [] });
        return;
      }
      const stored = answer.state?.verdict ?? null;
      const usable = stored && answer.state ? verdictUse(stored, answer.state.counter, answer.block_height, a.use, answer.state.permission_blk) : null;
      if (!stored || !usable?.ok) {
        set({ phase: 'failed', step: 'act', why: `${usable?.why ?? 'No check result is stored.'} Run it again.`, logs: [] });
        return;
      }
      if (override && job.current) job.current = { ...job.current, act: override };
      await act(a, stored, answer.block_height, Date.now(), 'checkHash' in state ? state.checkHash : undefined, 'broker' in state ? Boolean(state.broker) : false);
    },
    [act, read, set, state],
  );

  /** The same job once more: after a broker's check that didn't go through, with the wallet's own check when the client asks for it. */
  const again = useCallback(
    (paidBy: 'broker' | 'wallet' = 'broker') => {
      if (job.current) void run(job.current, paidBy);
    },
    [run],
  );

  const reset = useCallback(() => set({ phase: 'idle' }), [set]);
  const busy = state.phase === 'broker' || state.phase === 'check' || state.phase === 'verdict' || state.phase === 'act';
  return { state, run, again, confirm, reset, busy };
}
