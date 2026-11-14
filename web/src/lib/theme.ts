// Light or dark: the visitor's saved choice, else the system's. Bootstrap 5.3 reads data-bs-theme on <html>, and
// globals.css re-points its colours for each. The inline script in layout.tsx applies it before the first paint.

export type ThemeChoice = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'pb:theme';

/** Runs in <head> before anything paints: the same rule as resolveTheme, written out for the browser. */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');var d=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-bs-theme',d?'dark':'light')}catch(e){}})()`;

export function parseChoice(value: string | null | undefined): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): Theme {
  if (choice === 'system') return systemDark ? 'dark' : 'light';
  return choice;
}
