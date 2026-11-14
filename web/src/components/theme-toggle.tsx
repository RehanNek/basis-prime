'use client';
// Light and dark. <ThemeSync> re-applies the choice after hydration (React's dev remount clears what the inline
// script set) and follows the system while no choice is saved; <ThemeToggle> saves one.
import { useLayoutEffect, useState } from 'react';

import { parseChoice, resolveTheme, THEME_KEY, type Theme } from '@/lib/theme';

function readChoice() {
  try {
    return parseChoice(window.localStorage.getItem(THEME_KEY));
  } catch {
    return 'system' as const;
  }
}

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
const apply = (theme: Theme) => document.documentElement.setAttribute('data-bs-theme', theme);

export function ThemeSync() {
  useLayoutEffect(() => {
    apply(resolveTheme(readChoice(), systemDark()));
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = () => {
      if (readChoice() === 'system') apply(resolveTheme('system', media.matches));
    };
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, []);
  return null;
}

/** Rendered on the client only (inside the wallet provider), so it can read the page's theme as it starts. */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'dark' : 'light'));
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className={className}
      title={`Switch to the ${next} look`}
      aria-label={`Switch to the ${next} look`}
      onClick={() => {
        try {
          window.localStorage.setItem(THEME_KEY, next);
        } catch {
          // Private mode: the choice lasts for this page only.
        }
        apply(next);
        setTheme(next);
      }}
    >
      <i className={`bi ${theme === 'dark' ? 'bi-sun' : 'bi-moon-stars'}`} aria-hidden="true" />
    </button>
  );
}
