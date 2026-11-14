'use client';
// The body of a page that isn't built yet: what it will show, when it comes, and the wallet state.
import { pageAt } from '@/lib/pages';
import { useNearWallet } from '@/providers/near-provider';

export function Placeholder({ href }: { href: string }) {
  const page = pageAt(href);
  const { signedAccountId } = useNearWallet();

  return (
    <main className="pb-container pb-page" style={{ maxWidth: 820 }}>
      <h1 className="h3">{page.title}</h1>
      <p className="lead">{page.summary}</p>
      <div className="alert alert-secondary small">
        Placeholder: this page is built in {page.phase} (PLAN.md 11). It shows no real data yet.
      </div>
      {page.wallet ? (
        signedAccountId ? (
          <p>
            Signed in as <code>{signedAccountId}</code>.
          </p>
        ) : (
          <p>Sign in with a NEAR testnet wallet to see your account here.</p>
        )
      ) : (
        <p className="text-body-secondary">No wallet needed.</p>
      )}
    </main>
  );
}
