'use client';
// Home before a wallet connects (INTERFACES.md 50.1 point 1): the app itself, as an exchange looks before sign-in.
// The same frame a signed-in wallet sees: the "Your account" heading, the portfolio card standing empty with the one
// "Sign in" button in it, and a short row of live prices (the public GET /api/spot/tokens) that lead to Spot and
// Perps. Nothing here sells anything.
import Link from 'next/link';

import { PortfolioEmpty } from '@/components/home/portfolio';
import { useApi } from '@/hooks/use-api';
import { homeMarkets } from '@/lib/landing';
import { readTokens, tokensPath } from '@/lib/spot';
import { useNearWallet } from '@/providers/near-provider';

export function Landing() {
  const { signIn } = useNearWallet();
  const tokens = useApi<unknown>(tokensPath(), 60_000);
  const markets = homeMarkets(readTokens(tokens.data));
  return (
    <main className="pb-container pb-page">
      <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
        <h1 className="h3 mb-0 me-1">Your account</h1>
      </div>
      <PortfolioEmpty onSignIn={() => signIn().catch(() => undefined)} />
      <section aria-labelledby="markets-title">
        <h2 id="markets-title" className="pb-card-title">
          Markets
        </h2>
        <div className="pb-tiles mb-3">
          {markets.map((market) => (
            <div key={market.symbol} className="pb-tile">
              <div className="l">{market.symbol}</div>
              <div className="v">{market.price}</div>
              <div className="s">
                <Link href={market.spotHref}>Swap</Link>
                {' · '}
                <Link href={market.perpsHref}>Perps</Link>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
