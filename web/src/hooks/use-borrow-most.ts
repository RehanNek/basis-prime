'use client';
// The most an account can borrow, asked of the risk engine when the Borrow page opens (INTERFACES.md 51.12; the user,
// 14 Nov: "it always displays whats the maximum ... a user can borrow"). It is a preview of the `fund` intent for far
// more than could be lent (POST /api/funding-plan): the answer's total is what a check would allow, from the lenders
// and our pool together. It only reads: nothing is signed or sent.
//   - Each answer is a run of the risk engine that the backend pays for and limits, so it asks once for the same
//     account and the same book within a minute. `bookKey` changes when the account's balances or debt do: then it
//     asks again, and the last figure stays in view meanwhile.
//   - No answer, or a refusal, is "not known", never "nothing": the page then falls back to its own estimate.
import { useEffect, useState } from 'react';

import { fundingPlan, type FundingPlanAnswer } from '@/lib/api';
import { ASK_FOR_MOST, mostFromPlan } from '@/lib/borrow-page';

/** How long an answer stands in for asking again. */
const KEEP_MS = 60_000;
const asked = new Map<string, { at: number; answer: Promise<FundingPlanAnswer | null> }>();

function ask(account: string, key: string): Promise<FundingPlanAnswer | null> {
  const now = Date.now();
  for (const [k, entry] of asked) if (now - entry.at > KEEP_MS) asked.delete(k);
  let entry = asked.get(key);
  if (!entry) {
    entry = { at: now, answer: fundingPlan(account, ASK_FOR_MOST).catch(() => null) };
    asked.set(key, entry);
  }
  return entry.answer;
}

export interface BorrowMost {
  /** The engine's figure in micro-USD, or null while there is none for this account. */
  most: bigint | null;
  /** A question is out: the figure in view, if any, is the last one. */
  asking: boolean;
}

/** `account` is null when the page shouldn't ask: no account, previews off, or an account that borrows from the pool alone. */
export function useBorrowMost(account: string | null, bookKey: string): BorrowMost {
  const key = account ? `${account}|${bookKey}` : null;
  const [loaded, setLoaded] = useState<{ account: string; key: string; most: bigint | null } | null>(null);

  useEffect(() => {
    if (!account || !key) return undefined;
    let cancelled = false;
    void ask(account, key).then((answer) => {
      if (!cancelled) setLoaded({ account, key, most: mostFromPlan(answer) });
    });
    return () => {
      cancelled = true;
    };
  }, [account, key]);

  if (!account || !key) return { most: null, asking: false };
  if (!loaded || loaded.account !== account) return { most: null, asking: true };
  return { most: loaded.most, asking: loaded.key !== key };
}
