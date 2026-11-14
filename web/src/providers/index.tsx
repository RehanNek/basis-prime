'use client';

import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import type { PropsWithChildren } from 'react';

import { Brand, Navigation, Tabs } from '@/components/navigation';
import { ThemeSync } from '@/components/theme-toggle';
import { SessionProvider } from '@/providers/session-provider';

/** While the wallet library loads: the header without the wallet, and a quiet page. */
function Loading() {
  const pathname = usePathname();
  return (
    <>
      <header>
        <div className="pb-appbar">
          <div className="pb-container pb-appbar-row">
            <Brand />
          </div>
        </div>
        <Tabs pathname={pathname} more={<span className="pb-tab">More</span>} />
      </header>
      <main className="pb-container pb-page" aria-busy="true">
        <div className="pb-skeleton mb-3" style={{ height: 34, maxWidth: 320 }} />
        <div className="pb-skeleton mb-2" style={{ height: 16, maxWidth: 560 }} />
        <div className="pb-skeleton" style={{ height: 160 }} />
      </main>
    </>
  );
}

// Wallet libraries require browser APIs. Initialize them after hydration.
const NearProvider = dynamic(
  () => import('@/providers/near-provider').then((module) => module.NearProvider),
  { ssr: false, loading: Loading },
);

export function Providers({ children }: PropsWithChildren) {
  return (
    <>
      <ThemeSync />
      <NearProvider>
        <SessionProvider>
          <Navigation />
          {children}
        </SessionProvider>
      </NearProvider>
    </>
  );
}
