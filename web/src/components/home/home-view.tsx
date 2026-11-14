'use client';
// Home (9 Nov redesign): what this is, for a visitor; the account's cockpit, for a signed-in client.
import { Cockpit } from '@/components/home/cockpit';
import { Landing } from '@/components/home/landing';
import { AccountGate } from '@/components/sign-in-card';
import { useNearWallet } from '@/providers/near-provider';
import { useSession } from '@/providers/session-provider';

export function HomeView() {
  const { signedAccountId, loading } = useNearWallet();
  const session = useSession();
  if (loading) {
    return (
      <main className="pb-container pb-page" aria-busy="true">
        <div className="pb-skeleton mb-3" style={{ height: 34, maxWidth: 320 }} />
        <div className="pb-skeleton" style={{ height: 160 }} />
      </main>
    );
  }
  if (!signedAccountId) return <Landing />;
  // Privacy level 1 (INTERFACES.md 48.6): the cockpit reads the account, so the wallet confirms it is the owner's first.
  if (session.checking || session.state === 'needs_sign_in') {
    return (
      <main className="pb-container pb-page">
        <h1 className="h3 mb-3">Your account</h1>
        <AccountGate>{null}</AccountGate>
      </main>
    );
  }
  return <Cockpit />;
}
