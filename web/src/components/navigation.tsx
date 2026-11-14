'use client';
// The app shell's header (9 Nov redesign): the name and the network on a navy bar, light and dark, the wallet; then
// the tabs: Home, Spot, Perps, Borrow, Basis trade, and More for the rest (INTERFACES.md 49.1).
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import { ThemeToggle } from '@/components/theme-toggle';
import { accountUrl, NetworkId } from '@/config';
import { morePages, tabPages, type AppPage } from '@/lib/pages';
import { useNearWallet } from '@/providers/near-provider';

export const Navigation = () => {
  const pathname = usePathname();
  return (
    <header>
      <div className="pb-appbar">
        <div className="pb-container pb-appbar-row">
          <Brand />
          <div className="ms-auto d-flex align-items-center gap-2">
            <ThemeToggle className="pb-barbtn icon" />
            <WalletButton />
          </div>
        </div>
      </div>
      <Tabs pathname={pathname} more={<MoreMenu pages={morePages(NetworkId)} pathname={pathname} />} />
    </header>
  );
};

/** The name and the network: shared with the placeholder shown while the wallet library loads. */
export function Brand() {
  return (
    <>
      <Link href="/" className="pb-brand">
        Basis <span>Prime</span>
      </Link>
      <span className="pb-chip" title={NetworkId === 'testnet' ? 'Testnet: test tokens only, nothing here is real money' : 'Mainnet'}>
        <span className="dot" aria-hidden="true" />
        {NetworkId}
      </span>
    </>
  );
}

export function Tabs({ pathname, more }: { pathname: string; more: ReactNode }) {
  return (
    <nav className="pb-tabs" aria-label="Pages">
      {/* Six tabs: on a phone they sit closer together, and wrap to a second line before they would run off the edge. */}
      <div className="pb-container pb-tabs-row" style={{ flexWrap: 'wrap', columnGap: 'clamp(0.7rem, 2.8vw, 1.5rem)', rowGap: 0 }}>
        <Tab href="/" label="Home" active={pathname === '/'} />
        {tabPages(NetworkId).map((page) => (
          <Tab key={page.href} href={page.href} label={page.label} active={pathname === page.href} />
        ))}
        {more}
      </div>
    </nav>
  );
}

function Tab({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link href={href} className={`pb-tab ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
      {label}
    </Link>
  );
}

/** Closes an open menu on a click outside it or on Escape. */
function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return undefined;
    const away = (event: Event) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('touchstart', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('touchstart', away);
      document.removeEventListener('keydown', key);
    };
  }, [ref, open, close]);
}

function MoreMenu({ pages, pathname }: { pages: AppPage[]; pathname: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(wrap, open, close);
  const current = pages.find((page) => page.href === pathname);

  return (
    <div className="pb-menu-wrap" ref={wrap}>
      <button type="button" className={`pb-tab ${current ? 'active' : ''}`} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        {current ? current.label : 'More'}
        <i className="bi bi-chevron-down" style={{ fontSize: '0.7rem' }} aria-hidden="true" />
      </button>
      {open && (
        <div className="pb-menu left" role="menu">
          {pages.map((page) => (
            <Link key={page.href} href={page.href} role="menuitem" className={`pb-menu-item ${page.href === pathname ? 'active' : ''}`} onClick={close}>
              <i className={`bi ${page.icon}`} aria-hidden="true" />
              <span>
                <span className="t">
                  {page.label}
                  {page.testnetOnly && <span className="pb-pill neutral ms-2 py-0">testnet</span>}
                </span>
                <span className="d">{page.blurb}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** A long wallet id, shortened for the bar: the start and the end. */
const shortId = (id: string) => (id.length > 24 ? `${id.slice(0, 12)}…${id.slice(-8)}` : id);

function WalletButton() {
  const { signedAccountId, loading, signIn, signOut } = useNearWallet();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(wrap, open, close);
  // Closing the wallet selector rejects with "User rejected": not an error, so a warning is enough.
  const quietly = (action: Promise<void>) => action.catch((error: unknown) => console.warn('Wallet sign-in or sign-out did not finish:', error));

  if (loading) {
    return (
      <span className="pb-barbtn" aria-busy="true">
        <span className="spinner-border spinner-border-sm" aria-hidden="true" /> Wallet
      </span>
    );
  }
  if (!signedAccountId) {
    return (
      <button type="button" className="pb-barbtn solid" onClick={() => quietly(signIn())}>
        <i className="bi bi-wallet2" aria-hidden="true" /> Sign in
      </button>
    );
  }
  return (
    <div className="pb-menu-wrap" ref={wrap}>
      <button type="button" className="pb-barbtn" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)} title={signedAccountId}>
        <i className="bi bi-person-circle" aria-hidden="true" />
        <span className="d-none d-sm-inline">{shortId(signedAccountId)}</span>
        <i className="bi bi-chevron-down" style={{ fontSize: '0.7rem' }} aria-hidden="true" />
      </button>
      {open && (
        <div className="pb-menu right" role="menu">
          <div className="pb-menu-note">
            Signed in as <span className="text-break fw-medium" style={{ color: 'var(--pb-ink)' }}>{signedAccountId}</span>
          </div>
          <Link href="/account" role="menuitem" className="pb-menu-item" onClick={close}>
            <i className="bi bi-person-badge" aria-hidden="true" />
            <span>
              <span className="t">Account details</span>
              <span className="d">Balances, the loan and the Hyperliquid setup</span>
            </span>
          </Link>
          <a href={accountUrl(signedAccountId)} target="_blank" rel="noreferrer" role="menuitem" className="pb-menu-item" onClick={close}>
            <i className="bi bi-box-arrow-up-right" aria-hidden="true" />
            <span>
              <span className="t">Your wallet on the explorer</span>
            </span>
          </a>
          <div className="pb-menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="pb-menu-item"
            onClick={() => {
              close();
              void quietly(signOut());
            }}
          >
            <i className="bi bi-box-arrow-right" aria-hidden="true" />
            <span>
              <span className="t">Sign out</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
