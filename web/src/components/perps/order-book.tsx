'use client';
// The Perps page's order book and recent trades (INTERFACES.md 49.1), from GET /api/perps/:coin every second. Asks
// sit above the spread and bids below, each row with its size, a running total and a bar behind it for the depth so
// far. Clicking a price puts it in the order form.
import { useState } from 'react';

import { bookView, priceText, sizeText, type BookRow, type PerpsMarket } from '@/lib/perps';

import s from './perps.module.css';

/** Levels shown on each side. */
const DEPTH = 11;

interface Props {
  coin: string;
  szDecimals: number;
  /** Undefined while the first answer is on its way. */
  market: PerpsMarket | undefined;
  /** The backend couldn't answer. */
  failed: boolean;
  onPrice: (pxText: string) => void;
}

export function BookPanel({ coin, szDecimals, market, failed, onPrice }: Props) {
  const [tab, setTab] = useState<'book' | 'trades'>('book');
  return (
    <section className={`${s.panel} ${s.book}`} aria-label="Order book and trades">
      <div className={s.panelHead}>
        <div className={s.tabs} role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'book'} className={`${s.tab} ${tab === 'book' ? s.tabOn : ''}`} onClick={() => setTab('book')}>
            Order book
          </button>
          <button type="button" role="tab" aria-selected={tab === 'trades'} className={`${s.tab} ${tab === 'trades' ? s.tabOn : ''}`} onClick={() => setTab('trades')}>
            Trades
          </button>
        </div>
      </div>
      {!market ? (
        <div className={s.panelBody}>
          {failed ? <p className={s.calm}>The order book isn’t available right now. It will show here when it is.</p> : <div className="pb-skeleton" style={{ height: 320 }} aria-busy="true" />}
        </div>
      ) : tab === 'book' ? (
        <Book coin={coin} szDecimals={szDecimals} market={market} onPrice={onPrice} />
      ) : (
        <Trades coin={coin} szDecimals={szDecimals} market={market} onPrice={onPrice} />
      )}
    </section>
  );
}

function Book({ coin, szDecimals, market, onPrice }: { coin: string; szDecimals: number; market: PerpsMarket; onPrice: (pxText: string) => void }) {
  const view = bookView(market.bids, market.asks, DEPTH);
  if (view.bids.length === 0 && view.asks.length === 0) {
    return (
      <div className={s.panelBody}>
        <p className={s.calm}>Nobody is quoting {coin} on testnet right now.</p>
      </div>
    );
  }
  const row = (level: BookRow, side: 'ask' | 'bid') => (
    <button key={`${side}-${level.pxText}`} type="button" className={`${s.bookRow} ${s.num}`} onClick={() => onPrice(level.pxText)} title="Use this price">
      <i aria-hidden="true" className={`${s.depth} ${side === 'ask' ? s.askDepth : s.bidDepth}`} style={{ width: `${(level.share * 100).toFixed(1)}%` }} />
      <span className={side === 'ask' ? s.bad : s.good}>{priceText(level.px, szDecimals)}</span>
      <span>{sizeText(level.sz, szDecimals)}</span>
      <span>{sizeText(level.total, szDecimals)}</span>
    </button>
  );
  return (
    <div className="pb-1">
      <div className={s.bookHead}>
        <span>Price</span>
        <span>Size ({coin})</span>
        <span>Total ({coin})</span>
      </div>
      {/* Asks are listed with the best at the bottom, next to the spread. */}
      {[...view.asks].reverse().map((level) => row(level, 'ask'))}
      <div className={`${s.spread} ${s.num}`}>
        <span>Spread</span>
        {view.spread ? (
          <>
            <b>{priceText(view.spread.abs, szDecimals)}</b>
            <span>{view.spread.pct.toFixed(3)}%</span>
          </>
        ) : (
          <span>one side is empty</span>
        )}
      </div>
      {view.bids.map((level) => row(level, 'bid'))}
    </div>
  );
}

function Trades({ coin, szDecimals, market, onPrice }: { coin: string; szDecimals: number; market: PerpsMarket; onPrice: (pxText: string) => void }) {
  if (market.trades.length === 0) {
    return (
      <div className={s.panelBody}>
        <p className={s.calm}>No recent trades in {coin} on testnet.</p>
      </div>
    );
  }
  return (
    <div className="pb-1" style={{ maxHeight: 470, overflowY: 'auto' }}>
      <div className={s.bookHead}>
        <span>Price</span>
        <span>Size ({coin})</span>
        <span>Time</span>
      </div>
      {market.trades.map((trade) => (
        <button key={trade.id} type="button" className={`${s.bookRow} ${s.num}`} onClick={() => onPrice(trade.pxText)} title="Use this price">
          <span className={trade.isBuy ? s.good : s.bad}>{priceText(trade.px, szDecimals)}</span>
          <span>{sizeText(trade.sz, szDecimals)}</span>
          <span className="pb-muted">{new Date(trade.time).toLocaleTimeString('en-GB')}</span>
        </button>
      ))}
    </div>
  );
}
