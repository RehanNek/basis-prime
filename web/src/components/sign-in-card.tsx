'use client';
// Privacy level 1 (INTERFACES.md 48.6): the one card a page shows in place of an account while a wallet is connected
// and hasn't confirmed it is the owner's. The pages read nothing about an account until it has.
import type { ReactNode } from 'react';

import { CONNECT_WORDS, SIGN_IN_WORDS } from '@/lib/session';
import { useSession } from '@/providers/session-provider';

export function SignInCard() {
  const session = useSession();
  return (
    <section className="pb-card" style={{ maxWidth: 560 }} aria-labelledby="sign-in-title">
      <h2 id="sign-in-title" className="pb-card-title">
        Confirm this wallet
      </h2>
      <p className="mb-2">{SIGN_IN_WORDS}</p>
      <p className="small pb-muted">
        Your account shows only to you and to the broker. Your wallet signs a short message to say it is yours. It lasts 12 hours in this browser.
      </p>
      <button type="button" className="btn btn-primary" disabled={session.signingIn} onClick={() => void session.signIn()}>
        {session.signingIn ? 'Waiting for your wallet…' : 'Confirm with one signature'}
      </button>
      {session.problem && <div className="form-text text-danger">{session.problem}</div>}
    </section>
  );
}

/**
 * Shows its children only once the app may read an account: privacy is off, or the wallet has confirmed it is the
 * owner's. Until the backend has said which, it shows a quiet placeholder, so nothing is read too early.
 */
export function AccountGate({ children }: { children: ReactNode }) {
  const session = useSession();
  if (session.checking) return <div className="pb-skeleton" style={{ height: 120 }} aria-busy="true" />;
  if (session.state === 'needs_sign_in') return <SignInCard />;
  return <>{children}</>;
}

/**
 * For a visitor with no wallet on a page that used to open any account by name (Risk, Activity): the one sentence,
 * and the accounts anyone may look at, as links. With none open, only the sentence shows.
 */
export function VisitorNotice({ links, open }: { links: { account: string; name: string }[]; open: string | null }) {
  return (
    <div className="mb-3">
      <p className="mb-2">{CONNECT_WORDS}</p>
      {links.length > 0 && (
        <p className="small text-body-secondary mb-0">
          Anyone can look at {links.length === 1 ? 'this account' : 'these accounts'}, without acting on {links.length === 1 ? 'it' : 'them'}:{' '}
          {links.map((link, i) => (
            <span key={link.account}>
              {i > 0 && ', '}
              <a href={`?account=${encodeURIComponent(link.name)}`} className={link.account === open ? 'fw-semibold' : ''}>
                {link.account}
              </a>
            </span>
          ))}
          .
        </p>
      )}
    </div>
  );
}
