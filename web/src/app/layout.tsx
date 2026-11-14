import '@/app/globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { THEME_SCRIPT } from '@/lib/theme';
import { Providers } from '@/providers';

export const metadata: Metadata = {
  title: { default: 'Basis Prime', template: '%s · Basis Prime' },
  description: 'Cross-venue prime brokerage on NEAR: one account per client, credit against the whole hedged book.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0b2545' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1a2e' },
  ],
};

// The fonts come from Google Fonts in the browser (Inter for text, Source Serif 4 for headings and numbers);
// Georgia and the system sans stand in until they load, or if they can't.
const FONTS = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The inline script picks light or dark before the first paint (the saved choice, else the system's), so
    // <html>'s data-bs-theme can differ from what the server wrote: hence suppressHydrationWarning.
    <html lang="en" data-bs-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={FONTS} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
