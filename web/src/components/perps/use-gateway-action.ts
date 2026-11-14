'use client';
// One order or one cancel through pb-gateway, the way the trade page does it (INTERFACES.md 9 and 12): the page builds
// the message, the wallet signs it once (NEP-413, recipient pb-gateway, 32 random nonce bytes), and the page posts it
// to /api/order or /api/cancel. The gateway runs in a sealed computer, takes 20 to 60 seconds and one order at a
// time, so this hook holds a single action: while it is on its way every Buy, Sell, Close and Cancel button waits.
// A message that expired before the gateway read it can be sent again: "Sign again" signs a fresh one, with a new
// expiry and nonce.
// INTERFACES.md 50.4: the message is signed for the account's own gateway's life (`lifeMs`, from the markets answer
// for the account; 110 s without it), and the hook doesn't give up before that life is over (lib/order-life.ts).
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, sendCancel, sendOrder } from '@/lib/api';
import { cancelMessage, expiryNow, EXPIRY_MS, GATEWAY_RECIPIENT, orderMessage, randomNonce, toAuth, type GatewayAnswer, type GatewayOrder } from '@/lib/gateway';
import { sendWithinLife } from '@/lib/order-life';
import type { HlAnswer } from '@/lib/hl';
import { resultWords, type ResultWords, type Waiting } from '@/lib/perps';
import { useNearWallet } from '@/providers/near-provider';

/** Where on the page the action was started: its progress and result show there. */
export type Origin = 'form' | 'positions' | 'orders';

export type GatewayRequest =
  | { kind: 'order'; origin: Origin; label: string; order: GatewayOrder }
  | { kind: 'cancel'; origin: Origin; label: string; coin: string; oid: number };

export type ActionState =
  | { kind: 'idle' }
  | { kind: 'waiting'; request: GatewayRequest; phase: Waiting; since: number }
  | { kind: 'done'; request: GatewayRequest; words: ResultWords; answer: GatewayAnswer }
  | { kind: 'failed'; request: GatewayRequest; message: string };

export interface GatewayAction {
  state: ActionState;
  busy: boolean;
  run: (request: GatewayRequest) => Promise<void>;
  /** Signs and sends the last request again: for one that expired. */
  again: () => void;
  dismiss: () => void;
}

function failureWords(failure: unknown): string {
  if (failure instanceof ApiError) return failure.message;
  const text = failure instanceof Error ? failure.message : String(failure);
  return /reject|cancel|denied|closed/i.test(text) ? 'You closed the wallet without signing. Nothing was sent.' : text;
}

export function useGatewayAction(hl: HlAnswer | undefined, hlFetchedAt: number, onSettled: () => void, lifeMs: number = EXPIRY_MS): GatewayAction {
  const { signMessage } = useNearWallet();
  const [state, setState] = useState<ActionState>({ kind: 'idle' });
  // The newest read of the account and what to do afterwards, for the moment an order is signed (an event, never a render).
  const latest = useRef({ hl, hlFetchedAt, onSettled, lifeMs });
  useEffect(() => {
    latest.current = { hl, hlFetchedAt, onSettled, lifeMs };
  });
  const running = useRef(false);

  const run = useCallback(
    async (request: GatewayRequest) => {
      const account = latest.current.hl;
      // One at a time: the gateway refuses a second order for the account while the first is being handled (P0).
      if (!account || running.current) return;
      running.current = true;
      setState({ kind: 'waiting', request, phase: 'signing', since: Date.now() });
      try {
        const life = latest.current.lifeMs;
        const expires = expiryNow(account.near_time_ms, latest.current.hlFetchedAt, life);
        const message = request.kind === 'order' ? orderMessage(account.account_id, request.order, expires) : cancelMessage(account.account_id, { coin: request.coin, oid: request.oid }, expires);
        const nonce = randomNonce();
        const signed = await signMessage({ message, recipient: GATEWAY_RECIPIENT, nonce });
        if (signed.accountId !== account.owner) throw new Error(`${signed.accountId} signed, but the account belongs to ${account.owner}.`);
        setState({ kind: 'waiting', request, phase: 'checking', since: Date.now() });
        const auth = toAuth(signed, message, nonce);
        // The status line turns calm by itself after 30 seconds (lib/perps.ts, progressWords); a cut-off answer waits out the life.
        const answer = await sendWithinLife({ send: () => (request.kind === 'order' ? sendOrder(account.account_id, auth) : sendCancel(account.account_id, auth)), lifeMs: life });
        setState({ kind: 'done', request, words: resultWords(answer, request.kind === 'order' ? { kind: 'order' } : { kind: 'cancel', oid: request.oid }), answer });
      } catch (failure) {
        setState({ kind: 'failed', request, message: failureWords(failure) });
      } finally {
        running.current = false;
        latest.current.onSettled();
      }
    },
    [signMessage],
  );

  const again = useCallback(() => {
    if (state.kind === 'done' || state.kind === 'failed') void run(state.request);
  }, [run, state]);
  const dismiss = useCallback(() => setState((last) => (last.kind === 'waiting' ? last : { kind: 'idle' })), []);

  return { state, busy: state.kind === 'waiting', run, again, dismiss };
}
