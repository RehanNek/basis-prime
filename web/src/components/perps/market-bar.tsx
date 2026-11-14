'use client';
// The Perps page's top bar (INTERFACES.md 49.1): the coin picker, then the market's figures: mark price, oracle
// price, 24-hour change, 24-hour volume, open interest and funding.
import { compactUsd, dayChange, fundingText, openInterestText, priceText, type Direction, type PerpsCtx } from '@/lib/perps';

import s from './perps.module.css';

/** Where "Trade" jumps to on a phone: the order form's place in the layout. */
export const ORDER_FORM_ID = 'perps-order';

const tone = (dir: Direction | undefined) => (dir === 'up' ? s.good : dir === 'down' ? s.bad : '');

interface Props {
  coins: { coin: string; listed: boolean }[];
  coin: string;
  onCoin: (coin: string) => void;
  szDecimals: number;
  ctx: PerpsCtx;
}

export function MarketBar({ coins, coin, onCoin, szDecimals, ctx }: Props) {
  const change = dayChange(ctx.mark, ctx.prevDayPx, szDecimals);
  const funding = fundingText(ctx.funding);
  const interest = openInterestText(ctx.openInterest, ctx.mark, coin);
  return (
    <section className={`${s.panel} ${s.bar}`} aria-label="Market">
      <select className={`form-select ${s.coinPick}`} value={coin} onChange={(event) => onCoin(event.target.value)} aria-label="Market">
        {/* Before the list has loaded, the picker still names the coin on show. */}
        {!coins.some((c) => c.coin === coin) && <option value={coin}>{coin}-USD</option>}
        {coins.map((c) => (
          <option key={c.coin} value={c.coin} disabled={!c.listed}>
            {c.coin}-USD{c.listed ? '' : ' (not on testnet)'}
          </option>
        ))}
      </select>
      <a className={`btn btn-primary btn-sm ${s.phoneOnly}`} href={`#${ORDER_FORM_ID}`}>
        Trade
      </a>
      <dl className={`${s.stats} ${s.num}`}>
        <div className={s.stat}>
          <dt>Mark</dt>
          <dd className={s.mark}>{priceText(ctx.mark, szDecimals)}</dd>
        </div>
        <div className={s.stat}>
          <dt>Oracle</dt>
          <dd>{priceText(ctx.oracle, szDecimals)}</dd>
        </div>
        <div className={s.stat}>
          <dt>24h change</dt>
          <dd className={tone(change?.dir)}>
            {change ? (
              <>
                <span className={s.wideOnly}>{change.abs} / </span>
                {change.pct}
              </>
            ) : (
              '–'
            )}
          </dd>
        </div>
        <div className={s.stat}>
          <dt>24h volume</dt>
          <dd>{compactUsd(ctx.dayVolume)}</dd>
        </div>
        <div className={s.stat}>
          <dt>Open interest</dt>
          <dd title={interest?.coins}>{interest ? interest.usd : '–'}</dd>
        </div>
        <div className={s.stat}>
          <dt>Funding / hour</dt>
          <dd className={tone(funding?.dir)} title={funding?.who}>
            {funding ? funding.text : '–'}
          </dd>
        </div>
      </dl>
    </section>
  );
}
