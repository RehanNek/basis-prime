'use client';
// The client account a page works on, and the backend's read of it (get_state, balances, debt, borrower),
// refreshed every `intervalMs`.
// Privacy level 1 (INTERFACES.md 48.6): nothing about an account is read until the app may: privacy is off, or the
// wallet has confirmed it is the owner's. When the backend says the name is another wallet's (403 `not_yours`), the
// page shows the picker's one line and nothing else about that account.
import { useApi } from '@/hooks/use-api';
import { useDebounced } from '@/hooks/use-debounced';
import { usePrimeAccount } from '@/hooks/use-prime-account';
import { accountPath, type AccountAnswer } from '@/lib/api';
import { useSession } from '@/providers/session-provider';

/** The refusals the picker and the sign-in card say in their own words, so a page doesn't print them a second time. */
const SAID_ELSEWHERE = ['not_yours', 'sign_in'];

export function useClientAccount(intervalMs = 8_000) {
  const pick = usePrimeAccount();
  const session = useSession();
  const may = session.state === 'off' || session.state === 'ready';
  const path = useDebounced(may && pick.accountId ? accountPath(pick.accountId) : null, 400);
  const read = useApi<AccountAnswer>(path, intervalMs);
  // While a new name is being typed, the last answer is about another account: don't show it.
  const answer = read.data?.account_id === pick.accountId ? read.data : undefined;
  const errorCode = read.error?.code ?? null;
  // Another wallet's account: whatever was read before the refusal isn't shown either.
  const notYours = errorCode === 'not_yours';
  return {
    ...pick,
    answer: notYours ? undefined : answer,
    error: errorCode && SAID_ELSEWHERE.includes(errorCode) ? undefined : read.error,
    /** The backend's code for a refusal of this account's read, for the picker's line. */
    errorCode,
    fetchedAt: read.fetchedAt,
    reload: read.reload,
    isOwner: Boolean(!notYours && answer?.state && answer.state.owner === pick.owner),
    /** The wallet owns the account, or it doesn't exist yet and the wallet would create it. */
    isOwnerOrNew: Boolean(!notYours && answer && (!answer.exists || answer.state?.owner === pick.owner)),
  };
}

export type ClientAccount = ReturnType<typeof useClientAccount>;
