'use client';
// One click for a swap (INTERFACES.md 49.1 point 3, 49.3 and 49.5). Swap:
//   1. holds the price: POST /api/quote with `swap` and `dry: false`, which answers 1Click's deposit address (our
//      stand-in's on testnet) and the account's next call;
//   2. runs the check when the quote names one (the account owes our pool): the broker pays for it (49.4), through
//      the same hook every other check-then-act uses;
//   3. opens the wallet once, for the account's `withdraw` to the deposit address, built from the quote's `next`
//      (lib/spot.ts, swapCall);
//   4. follows the swap by its deposit address (GET /api/status) to the end.
// lib/spot.ts has every rule and every sentence; this hook only keeps where the run is.
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApi } from '@/hooks/use-api';
import { useCheckThenAct } from '@/hooks/use-check-then-act';
import { api, ApiError, statusPath } from '@/lib/api';
import { rememberMove } from '@/lib/moves';
import {
  amountWords,
  holdProblem,
  NOTHING_SENT,
  priceMoved,
  readQuote,
  receivedUnits,
  refusedWords,
  statusWords,
  SWAP_FIGURES,
  swapBody,
  swapCall,
  swapLabel,
  swapSettled,
  walletProblem,
  type SpotToken,
  type StatusWords,
  type SwapQuote,
  type SwapStatusAnswer,
} from '@/lib/spot';
import { txFailure, txHash, type Tx } from '@/lib/tx';
import type { Intent } from '@/lib/types';
import type { Use } from '@/lib/verdict';
import { useNearWallet } from '@/providers/near-provider';

/** A swap this page started: the price that was held, and the call built from it. */
export interface Started {
  pay: SpotToken;
  receive: SpotToken;
  /** What was typed, in the paying token's units. */
  units: string;
  quote: SwapQuote;
  tx: Tx;
  check: Intent | null;
  /** 1Click's deposit address for this swap. */
  receiver: string;
  /** The account lists the swap as a sale under way: only a sale of a token other than USDC. */
  recorded: boolean;
  label: string;
}

/** Where a run is. */
export type Step =
  | { at: 'idle' }
  /** Asking for the price to be held. */
  | { at: 'holding' }
  /** The check, then the wallet: the check's own progress shows. */
  | { at: 'checking' }
  /** The wallet is open for the swap. */
  | { at: 'wallet' }
  /** The wallet closed or failed before sending: Approve opens it again. */
  | { at: 'closed'; problem: string }
  /** The tokens left the account: the page follows the swap. */
  | { at: 'following'; hash?: string }
  /** Nothing was swapped, and why. */
  | { at: 'stopped'; problem: string; hash?: string };

const asError = (failure: unknown) => (failure instanceof ApiError ? failure : { status: 0, code: 'error', message: String(failure) });

/** `accountId` is the wallet's own account, or null while there is none to swap for. `onChange` re-reads its balances. */
export function useSwap(accountId: string | null, onChange: () => void) {
  const { sendTx } = useNearWallet();
  const flow = useCheckThenAct(accountId ?? '', onChange);
  const { run: runFlow, reset: resetFlow } = flow;
  const [step, setStep] = useState<Step>({ at: 'idle' });
  const [started, setStarted] = useState<Started | null>(null);
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  });

  /** The wallet's one approval, when no check is needed first. */
  const send = useCallback(
    async (swap: Started) => {
      setStep({ at: 'wallet' });
      try {
        const outcome = await sendTx(swap.tx);
        const failure = txFailure(outcome);
        setStep(failure ? { at: 'stopped', problem: refusedWords(failure), hash: txHash(outcome) } : { at: 'following', hash: txHash(outcome) });
      } catch (error) {
        setStep({ at: 'closed', problem: walletProblem(error) });
      }
      changed.current();
    },
    [sendTx],
  );

  /** `shown` is the price the box showed when Swap was pressed: a held price well under it isn't sent. */
  const start = useCallback(
    async (input: { pay: SpotToken; receive: SpotToken; units: string; shown: SwapQuote | null }) => {
      const body = accountId ? swapBody({ dry: false, account: accountId, pay: input.pay, receive: input.receive, units: input.units }) : null;
      if (!accountId || !body) return;
      setStarted(null);
      setStep({ at: 'holding' });
      let answer: unknown;
      try {
        answer = await api<unknown>('/api/quote', { method: 'POST', body: JSON.stringify(body) });
      } catch (failure) {
        setStep({ at: 'stopped', problem: holdProblem(asError(failure)) });
        return;
      }
      const quote = readQuote(answer);
      const moved = quote ? priceMoved(input.shown, quote, input.receive) : null;
      const call = quote && !moved ? swapCall(accountId, quote, input.pay, input.units, Date.now()) : null;
      if (!quote || !call?.tx) {
        setStep({ at: 'stopped', problem: moved ?? call?.problem ?? `The price came back empty. ${NOTHING_SENT}` });
        return;
      }
      const swap: Started = {
        pay: input.pay,
        receive: input.receive,
        units: input.units,
        quote,
        tx: call.tx,
        check: call.check,
        receiver: call.receiver,
        recorded: call.transfer !== null,
        label: swapLabel(quote.amountIn, input.pay, input.receive),
      };
      setStarted(swap);
      // So that Home's "Money on its way" can ask 1Click about a sale the account lists, from this browser.
      if (quote.transferId) {
        try {
          rememberMove(window.localStorage, { account: accountId, id: quote.transferId, depositAddress: call.receiver, depositMemo: quote.depositMemo });
        } catch {
          // no store: the list then shows what the account itself knows
        }
      }
      if (!call.check) {
        await send(swap);
        return;
      }
      setStep({ at: 'checking' });
      await runFlow({
        intent: call.check,
        act: { label: swap.label, use: call.check as Use, tx: call.tx, done: 'Sent. The swap is under way.', onSent: (outcome) => setStep({ at: 'following', hash: txHash(outcome) }) },
      });
    },
    [accountId, runFlow, send],
  );

  /** After the wallet closed: the same call again, unless its price has run out meanwhile. */
  const approve = useCallback(async () => {
    if (!accountId || !started) return;
    const again = swapCall(accountId, started.quote, started.pay, started.units, Date.now());
    if (!again.tx) {
      setStep({ at: 'stopped', problem: again.problem });
      return;
    }
    await send(started);
  }, [accountId, send, started]);

  const reset = useCallback(() => {
    setStep({ at: 'idle' });
    setStarted(null);
    resetFlow();
  }, [resetFlow]);

  // Once the tokens have left: 1Click's status for the swap, every 5 seconds until it is final.
  const following = step.at === 'following' && started ? statusPath(started.receiver, started.quote.depositMemo) : null;
  const status = useApi<SwapStatusAnswer>(following, 5_000, (answer) => swapSettled(answer.status));
  const settled = swapSettled(status.data?.status);
  // The balances change when the swap settles: read them at once, not at the page's next round.
  useEffect(() => {
    if (settled) changed.current();
  }, [settled]);

  let words: StatusWords | null = null;
  if (started && step.at === 'following') {
    const got = receivedUnits(status.data, started.quote);
    words = statusWords(status.data?.status, {
      paid: amountWords(started.quote.amountIn, started.pay, SWAP_FIGURES),
      received: amountWords(got.units, started.receive, SWAP_FIGURES),
      exact: got.exact,
      recorded: started.recorded,
    });
  }

  return {
    step,
    started,
    /** The check-then-act run, for its progress lines; idle when the swap needed no check. */
    flow,
    /** Where the swap stands once the tokens have left, in one sentence. */
    words,
    /** 1Click's own reason for sending the tokens back, when it gave one. */
    reason: status.data?.swapDetails?.refundReason ?? null,
    /** From the click until "Try again" or "Swap again": the box doesn't change under a run. */
    locked: step.at !== 'idle',
    start,
    approve,
    reset,
  };
}

export type Swap = ReturnType<typeof useSwap>;
