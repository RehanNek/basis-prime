'use client';
// Where a loan of this amount would come from (INTERFACES.md 28, POST /api/funding-plan). It asks a moment after the
// amount stops changing, and asks once for the same amount within a minute, since each answer is a run of the risk
// engine that the backend pays for and limits. It only reads: nothing is signed or sent. A failure counts as no
// answer, so the panel shows nothing rather than an error.
import { useEffect, useState } from 'react';

import { useDebounced } from '@/hooks/use-debounced';
import { fundingPlan, type FundingPlanAnswer } from '@/lib/api';

interface Loaded {
  account: string;
  amount: string;
  answer: FundingPlanAnswer | null;
}

/** How long an answer stands in for asking again. The book moves, so not for long. */
const KEEP_MS = 60_000;
const asked = new Map<string, { at: number; answer: Promise<FundingPlanAnswer | null> }>();

function ask(account: string, amount: string): Promise<FundingPlanAnswer | null> {
  const key = `${account}:${amount}`;
  const now = Date.now();
  for (const [k, entry] of asked) if (now - entry.at > KEEP_MS) asked.delete(k);
  let entry = asked.get(key);
  if (!entry) {
    entry = { at: now, answer: fundingPlan(account, amount).catch(() => null) };
    asked.set(key, entry);
  }
  return entry.answer;
}

export function useFundingPlan(account: string | null, amount: string | null, waitMs = 800): { answer: FundingPlanAnswer | null; stale: boolean } {
  const settled = useDebounced(amount, waitMs);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!account || !settled) return undefined;
    let cancelled = false;
    void ask(account, settled).then((answer) => {
      if (!cancelled) setLoaded({ account, amount: settled, answer });
    });
    return () => {
      cancelled = true;
    };
  }, [account, settled]);

  // No amount, or another account's answer: nothing. While a new amount is being typed or asked about, the last
  // answer stays in view, marked stale, so the panel doesn't jump.
  if (!account || !amount || !loaded || loaded.account !== account) return { answer: null, stale: false };
  return { answer: loaded.answer, stale: loaded.amount !== amount };
}
