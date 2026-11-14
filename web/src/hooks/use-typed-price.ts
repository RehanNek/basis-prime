'use client';
// A price as the amount is typed (INTERFACES.md 49.5): asked for 400 ms after the last keystroke, shown, and asked for
// again by itself before it runs out. No "Get a price" button. lib/typed-price.ts has the timing.
import { useEffect, useRef, useState } from 'react';

import { useDebounced } from '@/hooks/use-debounced';
import { ApiError } from '@/lib/api';
import { PRICE_DELAY_MS, PRICE_LIFE_MS } from '@/lib/typed-price';

interface Priced<T> {
  key: string;
  price?: T;
  error?: string;
}

/**
 * `key` names what is being priced (the token and the amount), or is null when there is nothing valid to price. `ask`
 * fetches the price for the current key. While `paused` (the action is under way) nothing is asked.
 */
export function useTypedPrice<T>(key: string | null, ask: () => Promise<T>, paused = false) {
  const settled = useDebounced(key, PRICE_DELAY_MS);
  const [priced, setPriced] = useState<Priced<T> | null>(null);
  const [round, setRound] = useState(0);
  const latest = useRef(ask);
  useEffect(() => {
    latest.current = ask;
  });

  useEffect(() => {
    if (!settled || paused) return undefined;
    let cancelled = false;
    latest.current().then(
      (price) => {
        if (!cancelled) setPriced({ key: settled, price });
      },
      (failure: unknown) => {
        if (!cancelled) setPriced({ key: settled, error: failure instanceof ApiError ? failure.message : String(failure) });
      },
    );
    // Before the price on screen runs out, it is asked for again.
    const again = setTimeout(() => setRound((n) => n + 1), PRICE_LIFE_MS);
    return () => {
      cancelled = true;
      clearTimeout(again);
    };
  }, [settled, paused, round]);

  // A price shows only for what is typed now: a new keystroke clears it at once.
  const current = priced && priced.key === key ? priced : null;
  return {
    price: current?.price ?? null,
    error: current?.error ?? null,
    /** The amount is typed and its price hasn't come yet. */
    asking: key !== null && !paused && current === null,
  };
}
