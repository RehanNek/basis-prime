'use client';
// A value that follows another once it has stopped changing for `ms`: typing an account name reads the
// chain once, not on every key.
import { useEffect, useState } from 'react';

export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
