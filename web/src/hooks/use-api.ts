'use client';
// Reads one backend path, optionally again every `intervalMs` (until `done` says the answer is final), and
// keeps the last answer with the time it arrived: the verdict countdown measures from it. A null path
// reads nothing.
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiError } from '@/lib/api';

interface Loaded<T> {
  path: string | null;
  data?: T;
  error?: ApiError;
  fetchedAt?: number;
}

export function useApi<T>(path: string | null, intervalMs = 0, done?: (data: T) => boolean) {
  const [loaded, setLoaded] = useState<Loaded<T>>({ path: null });
  const [tick, setTick] = useState(0);
  // The latest `done`, without re-running the effect when a new function is passed each render.
  const doneRef = useRef(done);
  useEffect(() => {
    doneRef.current = done;
  });

  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const load = () =>
      api<T>(path).then(
        (data) => {
          if (cancelled) return;
          setLoaded({ path, data, fetchedAt: Date.now() });
          if (timer && doneRef.current?.(data)) clearInterval(timer);
        },
        (error: unknown) => {
          const failure = error instanceof ApiError ? error : new ApiError(0, 'error', String(error));
          // Keep showing the last good answer for this path, with the error beside it.
          if (!cancelled) setLoaded((last) => (last.path === path ? { ...last, error: failure } : { path, error: failure }));
        },
      );
    void load();
    if (intervalMs > 0) timer = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [path, intervalMs, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const current: Loaded<T> = loaded.path === path ? loaded : { path };
  return {
    data: current.data,
    error: current.error,
    fetchedAt: current.fetchedAt ?? 0,
    loading: path !== null && current.data === undefined && current.error === undefined,
    reload,
  };
}
