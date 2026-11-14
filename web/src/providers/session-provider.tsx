'use client';
// Privacy level 1 (INTERFACES.md 48.6): whether the app has to know whose wallet this is before it shows an account.
// The mode comes from GET /api/config's `privacy` block; a backend that doesn't say counts as `off`, and then there is
// no card and no token. With `owner`, a connected wallet signs one free message (NEP-413, no transaction), the backend
// answers a token good for 12 hours, and lib/api.ts sends it on every call. The token is kept per wallet in this
// browser and dropped when it runs out, when the backend refuses it, and when the wallet signs out.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';

import { useApi } from '@/hooks/use-api';
import { useNow } from '@/hooks/use-now';
import { ApiError, CONFIG_PATH, postSession, type ConfigAnswer } from '@/lib/api';
import { randomNonce, toAuth } from '@/lib/gateway';
import {
  dropSession,
  onSessionDropped,
  privacyOf,
  readSession,
  saveSession,
  SESSION_RECIPIENT,
  sessionMessage,
  sessionState,
  setCurrentSession,
  SIGN_IN_WINDOW_MS,
  type PrivacyMode,
  type Session,
  type SessionState,
} from '@/lib/session';
import { useNearWallet } from '@/providers/near-provider';

export interface SessionValue {
  mode: PrivacyMode;
  state: SessionState;
  /** The backend hasn't said yet whether privacy is on: a page that would read an account waits. */
  checking: boolean;
  /** Accounts anyone may look at, from the backend's settings. */
  openAccounts: string[];
  /** The connected wallet is the operator's or the keeper's: the backend lets it open any account by name. */
  isOperator: boolean;
  /** Has the wallet sign the sign-in message, and posts it. Needs a click: wallets open a window to sign. */
  signIn: () => Promise<void>;
  signingIn: boolean;
  /** Why the last sign-in didn't work, in words. */
  problem: string | null;
}

/** Privacy off: no card, no token, every page as before this section. The canned test page runs this way. */
export const SESSION_OFF: SessionValue = { mode: 'off', state: 'off', checking: false, openAccounts: [], isOperator: false, signIn: async () => undefined, signingIn: false, problem: null };

export const SessionContext = createContext<SessionValue>(SESSION_OFF);

export function useSession(): SessionValue {
  return useContext(SessionContext);
}

/** The token this browser keeps for a wallet, if it is still good. */
function kept(wallet: string, nowMs: number): Session | null {
  try {
    return wallet ? readSession(window.localStorage, wallet, nowMs) : null;
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: PropsWithChildren) {
  const { signedAccountId: wallet, loading, signMessage } = useNearWallet();
  const config = useApi<ConfigAnswer>(CONFIG_PATH);
  const { mode, openAccounts } = privacyOf(config.data);
  const now = useNow(30_000);
  // Each sign-in, sign-out and refusal moves this on, so the token is read from the browser's store again.
  const [changes, setChanges] = useState(0);
  const [signingIn, setSigningIn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // `now` ticks every half minute, so a token that runs out stops counting without a reload.
  const session = useMemo(() => (mode === 'owner' ? kept(wallet, now) : null), [mode, wallet, now, changes]); // eslint-disable-line react-hooks/exhaustive-deps
  // lib/api.ts sends this token. It is set here, before the pages below render and read, so their first call has it.
  setCurrentSession(session ? wallet : null, session);

  // The backend refused the token (401 sign_in): lib/api.ts dropped it, and the card shows again.
  useEffect(() => onSessionDropped(() => setChanges((n) => n + 1)), []);

  // Signing the wallet out drops its token: the next wallet in this browser starts with none of it.
  const last = useRef('');
  useEffect(() => {
    const before = last.current;
    last.current = wallet;
    if (loading || !before || before === wallet) return;
    try {
      dropSession(window.localStorage, before);
    } catch {
      // no store: nothing was kept
    }
  }, [wallet, loading]);

  const signIn = useCallback(async () => {
    if (!wallet) return;
    setSigningIn(true);
    setProblem(null);
    try {
      const nonce = randomNonce();
      const message = sessionMessage(wallet, Date.now() + SIGN_IN_WINDOW_MS);
      const signed = await signMessage({ message, recipient: SESSION_RECIPIENT, nonce });
      const answer = await postSession(toAuth(signed, message, nonce, SESSION_RECIPIENT));
      saveSession(window.localStorage, wallet, { token: answer.token, expires_at_ms: answer.expires_at_ms });
      setChanges((n) => n + 1);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setProblem(error instanceof ApiError ? text : /reject|cancel|denied|closed/i.test(text) ? 'The wallet closed before you signed. Nothing was sent.' : `The wallet didn’t sign: ${text}`);
    } finally {
      setSigningIn(false);
    }
  }, [wallet, signMessage]);

  const ids = config.data?.ids;
  const value: SessionValue = {
    mode,
    state: sessionState({ mode, wallet, hasToken: session !== null }),
    checking: config.loading,
    openAccounts,
    isOperator: Boolean(wallet && ids && (wallet === ids.operator || wallet === ids.keeper)),
    signIn,
    signingIn,
    problem,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
