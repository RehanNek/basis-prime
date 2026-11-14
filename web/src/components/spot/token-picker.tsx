'use client';
// The Spot page's token picker (INTERFACES.md 49.1 point 3): the tokens of GET /api/spot/tokens, each with its symbol,
// name and real price, searchable, with the ones the account holds first and their balances. A token that can't swap
// on testnet is still pickable: the box then shows its real price and the mainnet line (INTERFACES.md 49.2).
import { useEffect, useRef, useState } from 'react';

import { Drawer } from '@/components/drawer';
import { LENDABLE_MARK, MAINNET_LINE, priceWords, searchTokens, shownSymbol, showUnits, tokenHue, type SpotToken, type TokenRow } from '@/lib/spot';
import { formatDollars } from '@/lib/units';

import styles from './spot.module.css';

/** A token's round mark: its first letter on its own colour. The app ships no token pictures. */
export function TokenMark({ token, large }: { token: SpotToken; large?: boolean }) {
  return (
    <span className={`${styles.mark} ${large ? styles.large : ''}`} style={{ background: `hsl(${tokenHue(token.symbol)} 42% 40%)` }} aria-hidden="true">
      {shownSymbol(token.symbol).charAt(0).toUpperCase()}
    </span>
  );
}

/** The marks beside a token's name: that it counts toward loans, and on testnet that it trades on mainnet only. */
export function TokenTags({ token }: { token: SpotToken }) {
  return (
    <>
      {token.lendable && <span className={`pb-pill good ${styles.tag}`}>{LENDABLE_MARK}</span>}
      {!token.swaps_here && (
        <span className={`pb-pill neutral ${styles.tag}`} title={MAINNET_LINE}>
          mainnet
        </span>
      )}
    </>
  );
}

interface Props {
  /** "You pay" or "You receive": which side is being picked. */
  title: string;
  /** Every token, the account's own first (lib/spot.ts, orderTokens). */
  rows: TokenRow[];
  /** The token this side has now. */
  chosen: SpotToken | null;
  onPick: (token: SpotToken) => void;
  onClose: () => void;
}

export function TokenPicker({ title, rows, chosen, onPick, onClose }: Props) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  // The panel opens with the search ready to type in.
  useEffect(() => {
    search.current?.focus();
  }, []);

  const found = searchTokens(rows, query);
  const mine = found.filter((row) => row.held !== null && row.held > 0n);
  const rest = found.filter((row) => !(row.held !== null && row.held > 0n));

  const list = (part: TokenRow[]) => (
    <ul className={styles.list}>
      {part.map(({ token, held, usd }) => (
        <li key={token.symbol}>
          <button
            type="button"
            className={`${styles.row} ${chosen?.symbol === token.symbol ? styles.chosen : ''}`}
            aria-current={chosen?.symbol === token.symbol ? 'true' : undefined}
            onClick={() => {
              onPick(token);
              onClose();
            }}
          >
            <TokenMark token={token} large />
            <span className={styles.rowName}>
              <span className={styles.symbol}>
                {shownSymbol(token.symbol)}
                <TokenTags token={token} />
              </span>
              <span className={styles.name}>{token.name}</span>
            </span>
            <span className={styles.rowFigures}>
              {held !== null && held > 0n ? (
                <>
                  {showUnits(held, token.decimals)}
                  <span className={styles.lesser}>
                    {usd === null ? priceWords(token.price_usd) : `${formatDollars(usd)} · ${priceWords(token.price_usd)} each`}
                  </span>
                </>
              ) : (
                priceWords(token.price_usd)
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <Drawer title={title} onClose={onClose}>
      <input
        ref={search}
        type="search"
        className={`form-control ${styles.search}`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by name or symbol"
        aria-label="Search tokens"
        autoComplete="off"
        spellCheck={false}
      />
      {found.length === 0 && <p className="pb-muted">No token matches “{query.trim()}”. The page lists {rows.length} tokens.</p>}
      {mine.length > 0 && (
        <>
          <div className={`pb-eyebrow ${styles.group}`}>In your account</div>
          {list(mine)}
        </>
      )}
      {rest.length > 0 && (
        <>
          {mine.length > 0 && <div className={`pb-eyebrow ${styles.group}`}>All tokens</div>}
          {list(rest)}
        </>
      )}
    </Drawer>
  );
}
