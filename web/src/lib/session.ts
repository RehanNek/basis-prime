// Privacy level 1, "hide who" (INTERFACES.md 48): the app shows a client account only to its owner and to us.
// A wallet proves it is the owner's with one free signature (NEP-413, no transaction): the backend answers a token,
// good for 12 hours, which every backend call then carries. This file is the plain part: the message to sign, the
// token's store in this browser, the token the next call sends, and what the page should show.
// It imports nothing, so lib/api.ts can read the token from it.

/** INTERFACES.md 48.2: a sign-in's recipient. An order's is the gateway's, so neither signature can pass as the other. */
export const SESSION_RECIPIENT = 'pb-app-session';
/** How far ahead the signed message's `until` is. The backend takes at most 10 minutes plus 60 seconds. */
export const SIGN_IN_WINDOW_MS = 10 * 60_000;
/** Where the tokens are kept in this browser: one per wallet, with its expiry. */
export const SESSION_STORAGE_KEY = 'pb:session';

/** INTERFACES.md 48.2: exactly three lines, joined by a line feed, with no line after. */
export function sessionMessage(wallet: string, untilMs: number): string {
  return `Sign in to Prime Broker\nwallet: ${wallet}\nuntil: ${Math.trunc(untilMs)}`;
}

/** What POST /api/session answers, as the browser keeps it. */
export interface Session {
  token: string;
  expires_at_ms: number;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function readAll(store: Store): Record<string, Session> {
  try {
    const all = JSON.parse(store.getItem(SESSION_STORAGE_KEY) ?? '{}') as unknown;
    return all && typeof all === 'object' && !Array.isArray(all) ? (all as Record<string, Session>) : {};
  } catch {
    return {};
  }
}

function writeAll(store: Store, all: Record<string, Session>) {
  try {
    store.setItem(SESSION_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Private mode: the token then lasts for this visit only.
  }
}

/** Keeps a wallet's token. */
export function saveSession(store: Store, wallet: string, session: Session): void {
  writeAll(store, { ...readAll(store), [wallet]: { token: session.token, expires_at_ms: session.expires_at_ms } });
}

/** Forgets a wallet's token: it signed out, or the backend said the token is no good. */
export function dropSession(store: Store, wallet: string): void {
  const all = readAll(store);
  if (!(wallet in all)) return;
  delete all[wallet];
  writeAll(store, all);
}

/** A wallet's token, or null. One that has expired is dropped and counts as none. */
export function readSession(store: Store, wallet: string, nowMs: number): Session | null {
  const kept = readAll(store)[wallet];
  if (!kept || typeof kept.token !== 'string' || typeof kept.expires_at_ms !== 'number') return null;
  if (kept.expires_at_ms <= nowMs) {
    dropSession(store, wallet);
    return null;
  }
  return kept;
}

// ---------- the token the next backend call sends ----------

let current: { wallet: string; session: Session } | null = null;
const dropped = new Set<() => void>();

/** The provider says which wallet is signed in to the app, and with which token: lib/api.ts sends it. */
export function setCurrentSession(wallet: string | null, session: Session | null): void {
  current = wallet && session ? { wallet, session } : null;
}

/** The token to send now, or null: none, or one that has expired. */
export function currentToken(nowMs: number = Date.now()): string | null {
  return current && current.session.expires_at_ms > nowMs ? current.session.token : null;
}

/** Tells the provider when the token is dropped, so the pages show the sign-in card again. Returns the way to stop. */
export function onSessionDropped(listener: () => void): () => void {
  dropped.add(listener);
  return () => {
    dropped.delete(listener);
  };
}

function browserStore(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The backend answered 401 `sign_in`: the token is no good (the backend restarted, or the token ran out there). It is
 * dropped from memory and from the browser's store, and the pages are told.
 */
export function dropCurrentSession(store: Store | null = browserStore()): void {
  if (!current) return;
  const { wallet } = current;
  current = null;
  if (store) dropSession(store, wallet);
  for (const listener of dropped) listener();
}

// ---------- what the page shows ----------

export type PrivacyMode = 'owner' | 'off';

/**
 * GET /api/config's `privacy` block: `{"mode": "owner" | "off", "open_accounts": [...]}`. A backend that doesn't say
 * is one from before this, and counts as `off`: no card, no token, every page as it was.
 */
export function privacyOf(config: { privacy?: { mode?: unknown; open_accounts?: unknown } | null } | null | undefined): { mode: PrivacyMode; openAccounts: string[] } {
  const privacy = config?.privacy;
  const open = Array.isArray(privacy?.open_accounts) ? privacy.open_accounts.filter((a): a is string => typeof a === 'string' && a.length > 0) : [];
  return { mode: privacy?.mode === 'owner' ? 'owner' : 'off', openAccounts: open };
}

/**
 * Where the app stands: privacy off; no wallet connected; a wallet with no token, which sees the sign-in card where
 * an account would show; or ready, with a token.
 */
export type SessionState = 'off' | 'no_wallet' | 'needs_sign_in' | 'ready';

export function sessionState(input: { mode: PrivacyMode; wallet: string; hasToken: boolean }): SessionState {
  if (input.mode === 'off') return 'off';
  if (!input.wallet) return 'no_wallet';
  return input.hasToken ? 'ready' : 'needs_sign_in';
}

/** The one card's words (INTERFACES.md 48.6). */
export const SIGN_IN_WORDS = 'Confirm this wallet is yours: one free signature, no transaction.';

// ---------- a visitor with no wallet, on Risk and Activity ----------

/** What a page that could be opened by name shows a visitor with no wallet. */
export type VisitorView =
  /** Privacy off: the free-text name field, as before, filled from ?account=. */
  | { kind: 'free_text'; name: string }
  /** Privacy on: "Connect your wallet to see your account", the open accounts as links, and the one opened, if any. */
  | { kind: 'connect'; links: { account: string; name: string }[]; open: string | null };

export const CONNECT_WORDS = 'Connect your wallet to see your account.';

/**
 * `asked` is the page's `?account=`: a name, or a whole account id. With privacy on it opens only an account the
 * backend lists as open to anyone; anything else is ignored, since the backend would refuse it.
 */
export function visitorView(input: { mode: PrivacyMode; openAccounts: string[]; asked: string | null | undefined; factory: string }): VisitorView {
  const suffix = `.${input.factory}`;
  const bare = (id: string) => (id.endsWith(suffix) ? id.slice(0, -suffix.length) : id);
  const asked = (input.asked ?? '').trim().toLowerCase();
  if (input.mode === 'off') return { kind: 'free_text', name: bare(asked) };
  const links = input.openAccounts.map((account) => ({ account, name: bare(account) }));
  const open = asked ? (links.find((l) => l.account === asked || l.name === asked)?.account ?? null) : null;
  return { kind: 'connect', links, open };
}
