'use client';
// Reads one of the Perps page's market routes (INTERFACES.md 49.3) again and again: the order book every second, the
// candles every five. Unlike hooks/use-api.ts it asks one at a time (the next read starts `intervalMs` after the last
// one answered), waits longer after an error, so a backend that can't answer isn't asked every second, and rests
// while the tab is hidden. The answer is parsed by a pure function of lib/perps.ts; the last good one stays on show
// beside an error.
import { useEffect, useRef, useState } from 'react';

import { api, ApiError } from '@/lib/api';

/** After an error the next read waits at least this long. */
const ERROR_WAIT_MS = 8_000;

interface Fed<T> {
  path: string | null;
  data?: T;
  error?: ApiError;
}

export function useFeed<T>(path: string | null, intervalMs: number, parse: (raw: unknown) => T | null) {
  const [fed, setFed] = useState<Fed<T>>({ path: null });
  // The latest parser, without restarting the reads when a new function is passed.
  const parseRef = useRef(parse);
  useEffect(() => {
    parseRef.current = parse;
  });

  useEffect(() => {
    if (!path) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      let wait = intervalMs;
      if (document.visibilityState !== 'hidden') {
        try {
          const data = parseRef.current(await api<unknown>(path));
          if (stopped) return;
          if (data === null) throw new ApiError(0, 'bad_answer', 'The backend answered something this page can’t read.');
          setFed({ path, data });
        } catch (failure) {
          if (stopped) return;
          const error = failure instanceof ApiError ? failure : new ApiError(0, 'error', String(failure));
          setFed((last) => (last.path === path ? { ...last, error } : { path, error }));
          wait = Math.max(intervalMs, ERROR_WAIT_MS);
        }
      }
      timer = setTimeout(() => void read(), wait);
    };
    void read();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [path, intervalMs]);

  const current: Fed<T> = fed.path === path ? fed : { path };
  return { data: current.data, error: current.error, loading: path !== null && current.data === undefined && current.error === undefined };
}
