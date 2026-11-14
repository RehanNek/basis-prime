'use client';
// Development only: the Spot page from sample data (standin.ts), with a wallet that sends nothing, so the page can be
// looked at and clicked through without the backend's routes, a wallet or a testnet account. page.tsx refuses it in
// production. It works as /dev/home does: the page's own calls to /api/... are answered from the sample while this
// page is open, and the browser's real fetch comes back when it closes.
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { SpotView } from '@/components/spot/spot-view';
import { NearContext, type NearContextValue } from '@/providers/near-provider';
import { SESSION_OFF, SessionContext } from '@/providers/session-provider';

import { makeStandin, OWNER, STATES, type SpotState } from './standin';

/** The browser's own fetch, kept once, so a second render (React's strict mode) never wraps a stand-in in another. */
const realFetch = typeof window === 'undefined' ? undefined : window.fetch.bind(window);

/** The sample in use. React's strict mode runs a state's first value twice and keeps one: both must be the same sample. */
let installed: { state: SpotState; wallet: NearContextValue } | null = null;

function install(state: SpotState): NearContextValue {
  if (installed?.state === state) return installed.wallet;
  const standin = makeStandin(state);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
    const answer = await standin.answer(url.replace(/^https?:\/\/[^/]+/, ''), init);
    return answer ?? realFetch!(input, init);
  };
  const nothing = async () => {
    throw new Error('Preview: nothing is sent');
  };
  const wallet: NearContextValue = {
    loading: false,
    signedAccountId: state === 'visitor' ? '' : OWNER,
    signIn: async () => undefined,
    signOut: async () => undefined,
    viewFunction: async () => null,
    callFunction: nothing,
    sendTx: standin.sendTx,
    sendTxs: (txs) => Promise.all(txs.map(standin.sendTx)),
    signMessage: nothing,
  };
  installed = { state, wallet };
  return wallet;
}

let pendingUninstall: ReturnType<typeof setTimeout> | null = null;

function uninstall() {
  pendingUninstall = null;
  installed = null;
  if (realFetch) window.fetch = realFetch;
}

export function Preview({ state }: { state: SpotState }) {
  // The stand-in goes in as the page first renders, before the page's own effects read anything.
  const [wallet] = useState(() => install(state));
  useEffect(() => {
    // React's strict mode unmounts and mounts again at once: put the real fetch back only on a real unmount.
    if (pendingUninstall) clearTimeout(pendingUninstall);
    pendingUninstall = null;
    return () => {
      pendingUninstall = setTimeout(uninstall, 0);
    };
  }, [wallet]);

  return (
    <>
      <div className="pb-container pt-3">
        <div className="alert alert-info small mb-0 d-flex flex-wrap gap-2 align-items-center">
          <span className="fw-medium">Preview with sample data.</span> The prices are a typed-in snapshot and the swap is simulated here: nothing is sent.
          <span className="ms-auto d-flex flex-wrap gap-2">
            {STATES.map((s) => (
              <Link key={s} href={`/spot/dev?state=${s}`} className={s === state ? 'fw-semibold' : ''}>
                {s}
              </Link>
            ))}
          </span>
        </div>
      </div>
      {/* Privacy level 1 (INTERFACES.md 48.6): the canned page runs with privacy off, whatever the backend beside it says. */}
      <NearContext.Provider value={wallet}>
        <SessionContext.Provider value={SESSION_OFF}>
          <SpotView />
        </SessionContext.Provider>
      </NearContext.Provider>
    </>
  );
}
