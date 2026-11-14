'use client';
// The account at each lender (INTERFACES.md 28, GET /api/lender/:account): its permission, its funding plan, its lender
// positions and the pool's pricing for it. Read every half minute, and every few seconds while a funding plan has steps
// left, so the steps go from waiting to done as the keeper runs them. A backend without the endpoint answers an error,
// which shows as nothing: today's accounts look as they did.
import { useState } from 'react';

import { useApi } from '@/hooks/use-api';
import { useNow } from '@/hooks/use-now';
import { lenderPath, type LenderAccountAnswer } from '@/lib/api';
import { planRunning } from '@/lib/fund';

const SLOW_MS = 30_000;
const FAST_MS = 4_000;

export function useLenderAccount(accountId: string | null) {
  const [fast, setFast] = useState(false);
  const read = useApi<LenderAccountAnswer>(accountId ? lenderPath(accountId) : null, fast ? FAST_MS : SLOW_MS);
  // While another account's name is being typed, the last answer is about another account: don't show it.
  const data = read.data?.account === accountId ? read.data : undefined;
  const now = useNow(5_000);
  const running = planRunning(data?.funding, now);
  if (running !== fast) setFast(running);
  return { data, reload: read.reload };
}
