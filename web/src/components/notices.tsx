'use client';
// Small shared notices: "sign in", "not deployed yet", and a backend error in words.
import type { ReactNode } from 'react';

import { AccountGate } from '@/components/sign-in-card';
import type { ApiError } from '@/lib/api';
import { useNearWallet } from '@/providers/near-provider';

/** Shows its children only to a signed-in wallet, and with privacy on only once that wallet has confirmed it is the owner's. */
export function WalletGate({ children }: { children: ReactNode }) {
  const { signedAccountId, loading, signIn } = useNearWallet();
  if (loading) return <p className="text-body-secondary">Loading the wallet…</p>;
  if (!signedAccountId) {
    return (
      <div className="alert alert-secondary d-flex flex-wrap align-items-center gap-2">
        <span>Sign in with a NEAR testnet wallet to use this page.</span>
        <button className="btn btn-sm btn-dark ms-auto" onClick={() => signIn().catch(() => undefined)}>
          Sign in
        </button>
      </div>
    );
  }
  // Privacy level 1 (INTERFACES.md 48.6): every page behind this gate shows an account, so a wallet that hasn't
  // confirmed it is the owner's sees the one card in its place.
  return <AccountGate>{children}</AccountGate>;
}

/** Our contracts go live during integration (Phase 2); until then, pages say so instead of failing. */
export function NotDeployed({ contracts, what }: { contracts: string[]; what?: string }) {
  if (contracts.length === 0) return null;
  return (
    <div className="alert alert-info small">
      Not deployed yet: {contracts.map((c, i) => <span key={c}>{i > 0 && ', '}<code>{c}</code></span>)}.{' '}
      {what ?? 'This part of the page works once it is live on testnet.'}
    </div>
  );
}

export function ApiProblem({ error }: { error: ApiError | undefined }) {
  if (!error) return null;
  return <div className="alert alert-warning small">{error.message}</div>;
}
