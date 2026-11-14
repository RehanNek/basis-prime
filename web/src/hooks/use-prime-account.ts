'use client';
// Which client account the signed-in wallet is looking at (INTERFACES.md 48.6). In this order: the name this browser
// remembers for the wallet; else the newest of the wallet's own accounts, which the backend lists once the wallet has
// confirmed it is the owner's (GET /api/accounts/mine); else a random name, made once and remembered. The client can
// still type any name.
import { useEffect, useState } from 'react';

import { FactoryContract } from '@/config';
import { useApi } from '@/hooks/use-api';
import { ACCOUNTS_MINE_PATH, type MineAnswer } from '@/lib/api';
import { accountIdFor, chooseName, nameProblem, ownNames, randomName } from '@/lib/names';
import { useNearWallet } from '@/providers/near-provider';
import { useSession } from '@/providers/session-provider';

const STORAGE_KEY = 'pb:account-names';

function readNames(): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function remember(wallet: string, name: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readNames(), [wallet]: name }));
  } catch {
    // Private mode: the name just isn't remembered.
  }
}

/** The random name made for a wallet with no account yet: one per wallet, whichever part of the page asks. */
const made = new Map<string, string>();
function randomFor(wallet: string): string {
  const name = made.get(wallet) ?? randomName();
  made.set(wallet, name);
  return name;
}

export function usePrimeAccount() {
  const { signedAccountId } = useNearWallet();
  const session = useSession();
  // The wallet provider renders on the client only (providers/index.tsx), so localStorage is there.
  const [names, setNames] = useState<Record<string, string>>(readNames);

  // The wallet's own accounts, once it may ask. With privacy off there is no such list, and none is asked for.
  const mine = useApi<MineAnswer>(session.state === 'ready' ? ACCOUNTS_MINE_PATH : null);
  const listed = mine.data?.wallet === signedAccountId ? mine.data.accounts : null;
  // Null while the list is still on its way: the name then waits, so a random one isn't made too early.
  const own = session.state === 'off' ? [] : listed ?? (mine.error ? [] : null);
  const chosen = chooseName({ remembered: signedAccountId ? names[signedAccountId] : undefined, mine: own, factory: FactoryContract });
  const fresh = Boolean(signedAccountId) && chosen.from === 'none' && own !== null;
  const name = fresh ? randomFor(signedAccountId) : chosen.name;
  const finding = Boolean(signedAccountId) && chosen.from === 'none' && own === null;
  const problem = finding ? null : nameProblem(name, FactoryContract);

  // A random name is made once: remembered here, so the next visit finds the same one.
  useEffect(() => {
    if (fresh) remember(signedAccountId, name);
  }, [fresh, signedAccountId, name]);

  const setName = (next: string) => {
    const clean = next.trim().toLowerCase();
    setNames({ ...names, [signedAccountId]: clean });
    remember(signedAccountId, clean);
  };

  return {
    owner: signedAccountId,
    name,
    problem,
    accountId: problem || !name ? null : accountIdFor(name, FactoryContract),
    setName,
    /** Still asking the backend for the wallet's own accounts: the name isn't known yet. */
    finding,
    /** The wallet's own accounts under this factory, newest first; empty with privacy off. */
    mine: ownNames(listed, FactoryContract),
  };
}
