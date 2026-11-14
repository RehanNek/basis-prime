'use client';
// An account's own settings (`get_config()`), read once from NEAR through the wallet's connection: its tokens, and
// the tokens Rhea takes from it as collateral (`lenders.rhea.collateral`, INTERFACES.md 51.1). The factory's settings
// reach only accounts made after them, so an account from before a change lists fewer tokens than the factory does,
// and takes bitcoin alone at Rhea.
import { useEffect, useState } from 'react';

import { settingsTokens, type SettingsToken } from '@/lib/basis';
import { rheaCollateralOf } from '@/lib/funding';
import { useNearWallet } from '@/providers/near-provider';

export interface OwnSettings {
  /** The account's tokens; null when the settings list none, or couldn't be read. */
  tokens: SettingsToken[] | null;
  /** The ids of the tokens Rhea takes from this account; null when it has no Rhea, or the settings couldn't be read. */
  rheaCollateral: string[] | null;
}

/** Each account's own settings, read once: they change only when the operator migrates the account. */
const settingsRead = new Map<string, OwnSettings>();
const NONE: OwnSettings = { tokens: null, rheaCollateral: null };

/** Null fields while the settings are being read, and when they couldn't be. `settled` is false only while reading. */
export function useOwnSettings(accountId: string | null): OwnSettings & { settled: boolean } {
  const { viewFunction } = useNearWallet();
  const [loaded, setLoaded] = useState<{ id: string; settings: OwnSettings } | null>(null);
  useEffect(() => {
    if (!accountId || settingsRead.has(accountId)) return undefined;
    let cancelled = false;
    // A node that never answers doesn't hold the page: after 6 seconds the tokens the backend reads stand in.
    const timer = setTimeout(() => {
      if (!cancelled) setLoaded((now) => (now?.id === accountId ? now : { id: accountId, settings: NONE }));
    }, 6_000);
    viewFunction({ contractId: accountId, method: 'get_config' }).then(
      (config) => {
        const settings = { tokens: settingsTokens(config), rheaCollateral: rheaCollateralOf(config) };
        settingsRead.set(accountId, settings);
        if (!cancelled) setLoaded({ id: accountId, settings });
      },
      () => {
        if (!cancelled) setLoaded({ id: accountId, settings: NONE });
      },
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [accountId, viewFunction]);
  if (!accountId) return { ...NONE, settled: true };
  const read = settingsRead.get(accountId);
  if (read) return { ...read, settled: true };
  return loaded?.id === accountId ? { ...loaded.settings, settled: true } : { ...NONE, settled: false };
}
