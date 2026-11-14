'use client';
// The Spot page (INTERFACES.md 49.1 point 3): swapping one token of the account for another, the way NEAR Intents'
// swap screen does it. One line says what the page is, the swap box follows, then where bought tokens sit, then what
// the account holds with its dollar value.
// Privacy level 1 (INTERFACES.md 48.6): the token list and its prices show to anyone. The account's balances and the
// Swap button need a wallet that has confirmed it is the owner's: until then nothing about an account is read
// (hooks/use-client-account.ts), and the box says what to do.
import Link from 'next/link';

import { NetworkId } from '@/config';
import { useApi } from '@/hooks/use-api';
import { useClientAccount } from '@/hooks/use-client-account';
import { aboutLines, accountStand, balancesLine, holdings, orderTokens, readTokens, shownSymbol, showUnits, SITS_LINE, tokensPath, type TokenRow } from '@/lib/spot';
import { formatDollars } from '@/lib/units';
import { useNearWallet } from '@/providers/near-provider';
import { useSession } from '@/providers/session-provider';

import styles from './spot.module.css';
import { SwapBox } from './swap-box';
import { TokenMark, TokenTags } from './token-picker';

/** The list is kept 60 seconds by the backend: the page asks as often. */
const LIST_EVERY_MS = 60_000;

export function SpotView() {
  return (
    <main className="pb-container pb-page" style={{ maxWidth: 540 }}>
      <h1 className="h3">Spot</h1>
      <p className="lead">{aboutLines(NetworkId).join(' ')}</p>
      <SpotBody />
    </main>
  );
}

function SpotBody() {
  const wallet = useNearWallet();
  const session = useSession();
  const client = useClientAccount();
  const { answer } = client;
  // The account the page swaps for: read, and a client account. Null for a visitor, and until the wallet is confirmed.
  const accountId = answer?.state ? answer.account_id : null;
  // The list for anyone, by the factory's settings; and, once there is an account, by that account's own settings.
  const open = useApi<unknown>(tokensPath(), LIST_EVERY_MS);
  const own = useApi<unknown>(accountId ? tokensPath(accountId) : null, LIST_EVERY_MS);
  const ownTokens = readTokens(own.data);
  const tokens = ownTokens.length > 0 ? ownTokens : readTokens(open.data);
  const balances = accountId ? answer?.balances : undefined;
  const rows = orderTokens(tokens, balances);
  const stand = accountStand({
    notYours: client.errorCode === 'not_yours',
    read: answer ? { exists: answer.exists, hasState: Boolean(answer.state) } : null,
    isOwner: client.isOwner,
    finding: client.finding,
    named: Boolean(client.accountId),
    failed: Boolean(client.error),
  });
  const reload = () => {
    client.reload();
    own.reload();
  };

  return (
    <>
      <SwapBox tokens={tokens} rows={rows} listFailed={tokens.length === 0 && Boolean(open.error) && !open.loading} accountId={accountId} balances={balances} stand={stand} reload={reload} />
      <p className={styles.sits}>{SITS_LINE}</p>
      <Balances
        rows={rows}
        accountId={accountId}
        line={balancesLine({ wallet: Boolean(wallet.signedAccountId), session: session.checking ? 'checking' : session.state, account: stand, tokens: tokens.length })}
        loading={wallet.loading}
      />
    </>
  );
}

/** What the account holds, token by token, with each one's dollar value and the total. The account is named, so it is plain which one a swap is for. */
function Balances({ rows, accountId, line, loading }: { rows: TokenRow[]; accountId: string | null; line: string | null; loading: boolean }) {
  const { rows: mine, total } = holdings(rows);
  return (
    <section className="pb-card" aria-labelledby="spot-balances">
      <div className={styles.total}>
        <div>
          <h2 id="spot-balances" className="pb-card-title mb-0">
            In your account
          </h2>
          {!line && !loading && accountId && <div className="small pb-muted text-break">{accountId}</div>}
        </div>
        {!line && !loading && mine.length > 0 && <span className="num">{formatDollars(total)}</span>}
      </div>
      {loading ? (
        <div className="pb-skeleton" style={{ height: 48 }} aria-busy="true" />
      ) : line ? (
        <p className="pb-muted mb-0">{line}</p>
      ) : mine.length === 0 ? (
        <p className="pb-muted mb-0">
          Your account holds none of these tokens yet. <Link href="/deposit">Deposit</Link> first, then swap here.
        </p>
      ) : (
        <ul className={`${styles.list} ${styles.balances}`}>
          {mine.map(({ token, held, usd }) => (
            <li key={token.symbol} className={styles.row}>
              <TokenMark token={token} large />
              <span className={styles.rowName}>
                <span className={styles.symbol}>
                  {shownSymbol(token.symbol)}
                  <TokenTags token={token} />
                </span>
                <span className={styles.name}>{token.name}</span>
              </span>
              <span className={styles.rowFigures}>
                {held !== null && showUnits(held, token.decimals)}
                <span className={styles.lesser}>{usd === null ? 'no price' : formatDollars(usd)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
