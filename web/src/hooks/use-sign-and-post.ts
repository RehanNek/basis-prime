'use client';
// An action the account has the MPC signer sign, then the backend posts to Hyperliquid (INTERFACES.md 8 and 11):
//   1. the wallet sends hl_approve_agent or hl_withdraw;
//   2. the signature lands in get_state().hl.signed, and the account logs an hl_signed event with its index;
//   3. POST /api/hl/submit {account, index}: the backend reads that entry from the chain and posts it.
import { useCallback, useState } from 'react';

import { useTx } from '@/hooks/use-tx';
import { api, ApiError, hlPath, submitSigned } from '@/lib/api';
import { newSignedEntry, signedIndexFromLogs, type HlAnswer, type SubmitAnswer } from '@/lib/hl';
import { txLogs, type Tx } from '@/lib/tx';

/** The MPC signer took 8-20 s on testnet (research/day1.md 3); give it a minute before saying nothing came. */
const WAIT_MS = 60_000;
/** How long the backend may answer "no signed entry with that index" before the page believes it. */
const NOT_YET_MS = 25_000;

export type SignPhase =
  | { kind: 'idle' }
  | { kind: 'waiting' }
  | { kind: 'posting'; index: number }
  | { kind: 'done'; index: number; answer: SubmitAnswer }
  | { kind: 'failed'; index?: number; message: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function useSignAndPost(account: string) {
  const tx = useTx();
  const [phase, setPhase] = useState<SignPhase>({ kind: 'idle' });

  /** Posts one stored entry again (or for the first time): harmless twice, since Hyperliquid refuses a used nonce. */
  const post = useCallback(
    async (index: number): Promise<SubmitAnswer | null> => {
      setPhase({ kind: 'posting', index });
      // The page learns the entry's index from the call's own event a moment before the backend's read of NEAR shows
      // it (the wallet and the backend may ask different NEAR nodes). So "no signed entry" (404) is asked again for a
      // short while before it counts as a failure. Seen on 13 Nov: the page said so while the keeper posted the entry.
      const askBy = Date.now() + NOT_YET_MS;
      for (;;) {
        try {
          const answer = await submitSigned(account, index);
          setPhase({ kind: 'done', index, answer });
          return answer;
        } catch (error) {
          if (error instanceof ApiError && error.status === 404 && Date.now() < askBy) {
            await sleep(2_500);
            continue;
          }
          setPhase({ kind: 'failed', index, message: error instanceof ApiError ? error.message : String(error) });
          return null;
        }
      }
    },
    [account],
  );

  /** Sends the transaction, finds the entry it made, and posts it. `afterIndex` is the last index before it. */
  const run = useCallback(
    async (label: string, transaction: Tx, kind: 'approveAgent' | 'sendAsset', afterIndex: number): Promise<SubmitAnswer | null> => {
      setPhase({ kind: 'idle' });
      const outcome = await tx.run(label, transaction);
      if (!outcome) return null;
      setPhase({ kind: 'waiting' });
      let index = signedIndexFromLogs(txLogs(outcome), kind);
      const until = Date.now() + WAIT_MS;
      while (index === null && Date.now() < until) {
        try {
          index = newSignedEntry((await api<HlAnswer>(hlPath(account))).hl, kind, afterIndex)?.index ?? null;
        } catch {
          // a missed read: try again
        }
        if (index === null) await sleep(2_500);
      }
      if (index === null) {
        setPhase({ kind: 'failed', message: "No signed action appeared. The MPC signer may have timed out, and then the account stores nothing: the transaction's logs say why. Try again." });
        return null;
      }
      return post(index);
    },
    [account, post, tx],
  );

  return { run, post, phase, tx };
}
