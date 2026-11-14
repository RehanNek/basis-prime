'use client';
// The Perps page's order form (INTERFACES.md 49.1): Buy/Long or Sell/Short, Market or Limit, a size in the coin or in
// USDC, reduce-only, what the order is worth, and one button. lib/perps.ts builds the order (a market order is an
// immediate-or-cancel limit inside the gateway's band, priced as the trade page's "Close…" prices it) and rounds it
// to Hyperliquid's rules; the button has the wallet sign it once and posts it (use-gateway-action.ts).
import type { ReactNode } from 'react';

import { TIFS, type Tif } from '@/lib/gateway';
import { notTradingWords, orderStopped, type Trading } from '@/lib/hl-reach';
import { bandPercent, decFromNumber, decText } from '@/lib/hl-rules';
import { buildOrder, coinFromUsd, marketFillNote, orderLabel, priceFromBook, priceText, sizeStep, usdFromCoin, type CoinFacts, type OrderKind, type SizeUnit, type Spread } from '@/lib/perps';
import { formatUsd } from '@/lib/units';

import { ActionStatus } from './action-status';
import s from './perps.module.css';
import type { GatewayAction } from './use-gateway-action';

export interface FormState {
  isBuy: boolean;
  kind: OrderKind;
  size: string;
  sizeIn: SizeUnit;
  price: string;
  reduceOnly: boolean;
  tif: Tif;
}

/**
 * The form opens on a market order, and Market is the first tab (the user, 14 Nov: "lets keep market first and limit
 * second with the default option being market"). `tif` is the limit order's; a market order is always now-or-never.
 */
export const EMPTY_FORM: FormState = { isBuy: true, kind: 'market', size: '', sizeIn: 'coin', price: '', reduceOnly: false, tif: 'Gtc' };
export const ORDER_KINDS = ['market', 'limit'] as const;

interface Props {
  coin: string;
  facts: CoinFacts | null;
  form: FormState;
  onForm: (patch: Partial<FormState>) => void;
  /** The book's best prices, for "Mid" and for the market order's note. */
  spread: Spread | null;
  /** Why this account can't trade yet, in words; null when it can. */
  blocked: ReactNode | null;
  action: GatewayAction;
  /**
   * INTERFACES.md 50.4: whether Hyperliquid testnet can take an order in this market now (lib/hl-reach.ts). When it
   * can't, one line above the form says why, and the button is off for an order that couldn't be taken.
   */
  trading?: Trading;
}

export function OrderForm({ coin, facts, form, onForm, spread, blocked, action, trading }: Props) {
  const built = buildOrder({ coin, ...form }, facts);
  const notTrading = trading ? notTradingWords(coin, trading, 'market') : null;
  const stopped = trading ? orderStopped({ trading, kind: form.kind, limitPx: built.order?.limit_px ?? form.price, reference: facts?.reference, bandBp: facts?.bandBp ?? 0 }) : false;
  const market = form.kind === 'market';
  const szDecimals = facts?.szDecimals ?? 0;
  const typed = Boolean(form.size || (!market && form.price));
  const fillNote = market ? marketFillNote({ isBuy: form.isBuy, marketPx: built.marketPx, bestBid: spread?.bid, bestAsk: spread?.ask, szDecimals }) : null;

  /** The price a size is counted at when the unit is switched: the mark for a market order, else the typed limit. */
  const countedAt = (): string | null => {
    if (!market) return form.price ? priceFromBook(form.price, form.isBuy, szDecimals) : null;
    const mark = facts?.mark ? decFromNumber(facts.mark) : null;
    return mark ? decText(mark) : null;
  };
  const switchUnit = (next: SizeUnit) => {
    if (next === form.sizeIn) return;
    const at = countedAt();
    const converted = form.size && at ? (next === 'usd' ? usdFromCoin(form.size, at) : coinFromUsd(form.size, at, szDecimals)) : null;
    onForm({ sizeIn: next, size: converted && converted !== '0' ? converted : '' });
  };
  const useMid = () => {
    const mid = spread ? decFromNumber(spread.mid) : null;
    if (mid) onForm({ price: priceFromBook(decText(mid), form.isBuy, szDecimals) });
  };

  const send = () => {
    if (!built.order || blocked || stopped || action.busy) return;
    void action.run({ kind: 'order', origin: 'form', label: orderLabel(built.order, form.kind), order: built.order });
  };

  return (
    <section className={s.panel} aria-label="Place an order">
      <div className={s.panelHead}>
        <div className={s.tabs} role="tablist" aria-label="Order type">
          {ORDER_KINDS.map((kind) => (
            <button key={kind} type="button" role="tab" aria-selected={form.kind === kind} className={`${s.tab} ${form.kind === kind ? s.tabOn : ''}`} onClick={() => onForm({ kind })}>
              {kind === 'limit' ? 'Limit' : 'Market'}
            </button>
          ))}
        </div>
      </div>
      <form
        className={s.panelBody}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {notTrading && (
          <p className="small text-danger mb-2" role="status">
            {notTrading}
          </p>
        )}
        <div className={s.sides} role="group" aria-label="Side">
          <button type="button" className={`btn btn-sm ${form.isBuy ? 'btn-success' : 'btn-outline-success'}`} aria-pressed={form.isBuy} onClick={() => onForm({ isBuy: true })}>
            Buy / Long
          </button>
          <button type="button" className={`btn btn-sm ${!form.isBuy ? 'btn-danger' : 'btn-outline-danger'}`} aria-pressed={!form.isBuy} onClick={() => onForm({ isBuy: false })}>
            Sell / Short
          </button>
        </div>

        {!market && (
          <div className="mt-3">
            <div className={s.fieldLabel}>
              <label htmlFor="perps-price">Price (USD)</label>
              <button type="button" className={s.linkBtn} disabled={!spread} onClick={useMid} title="The middle of the best bid and the best ask">
                Mid
              </button>
            </div>
            <input id="perps-price" className={`form-control form-control-sm ${s.num}`} inputMode="decimal" autoComplete="off" value={form.price} onChange={(event) => onForm({ price: event.target.value })} placeholder={facts?.mark ? priceText(facts.mark, szDecimals) : '0'} />
          </div>
        )}

        <div className="mt-3">
          <div className={s.fieldLabel}>
            <label htmlFor="perps-size">Size</label>
            <span className="d-flex gap-2" role="group" aria-label="Size in">
              {(['coin', 'usd'] as const).map((unit) => (
                <button key={unit} type="button" className={s.linkBtn} style={form.sizeIn === unit ? { fontWeight: 600, color: 'var(--pb-ink)' } : undefined} aria-pressed={form.sizeIn === unit} onClick={() => switchUnit(unit)}>
                  {unit === 'coin' ? coin : 'USDC'}
                </button>
              ))}
            </span>
          </div>
          <div className="input-group input-group-sm">
            <input
              id="perps-size"
              className={`form-control ${s.num}`}
              inputMode="decimal"
              autoComplete="off"
              value={form.size}
              onChange={(event) => onForm({ size: event.target.value })}
              placeholder={form.sizeIn === 'coin' ? (facts ? `steps of ${sizeStep(szDecimals)}` : '0') : 'at least 10'}
            />
            <span className="input-group-text">{form.sizeIn === 'coin' ? coin : 'USDC'}</span>
          </div>
        </div>

        <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mt-3">
          <div className="form-check mb-0">
            <input id="perps-reduce" className="form-check-input" type="checkbox" checked={form.reduceOnly} onChange={(event) => onForm({ reduceOnly: event.target.checked })} />
            <label className="form-check-label small" htmlFor="perps-reduce" title="The order may only shrink a position, never open or grow one">
              Reduce-only
            </label>
          </div>
          {!market && (
            <select className="form-select form-select-sm w-auto" value={form.tif} onChange={(event) => onForm({ tif: event.target.value as Tif })} aria-label="How long the order lasts">
              {TIFS.map((t) => (
                <option key={t.value} value={t.value} title={t.words}>
                  {t.words.split(':')[0]}
                </option>
              ))}
            </select>
          )}
        </div>

        <dl className={`${s.summary} ${s.num} mt-3`}>
          <div>
            <dt>Order value</dt>
            <dd>{built.worthMicro > 0n ? `${market ? 'about ' : ''}${formatUsd(built.worthMicro)}` : '–'}</dd>
          </div>
          {built.order && form.sizeIn === 'usd' && (
            <div>
              <dt>Size</dt>
              <dd>
                {built.order.sz} {coin}
              </dd>
            </div>
          )}
          {market && (
            <div>
              <dt>{form.isBuy ? 'Pays at most' : 'Accepts at least'}</dt>
              <dd>{built.marketPx ? priceText(Number(built.marketPx), szDecimals) : '–'}</dd>
            </div>
          )}
          {facts?.band && (
            <div>
              <dt title="The broker's risk checks take prices this close to the reference price">Prices allowed (±{bandPercent(facts.bandBp)})</dt>
              <dd>
                {priceText(facts.band.low, szDecimals)} – {priceText(facts.band.high, szDecimals)}
              </dd>
            </div>
          )}
        </dl>

        {market && <p className={`${s.calm} mt-2`}>A market order fills at once at the best prices on the book. What can’t fill is cancelled.</p>}
        {typed && built.problems.map((problem) => (
          <p key={problem} className="small text-danger mt-2 mb-0">
            {problem}
          </p>
        ))}
        {typed && [...built.notes, ...(fillNote ? [fillNote] : [])].map((note) => (
          <p key={note} className="small text-warning-emphasis mt-2 mb-0">
            {note.charAt(0).toUpperCase() + note.slice(1)}
            {note.endsWith('.') ? '' : '.'}
          </p>
        ))}
        {blocked && <div className="small mt-2">{blocked}</div>}

        <button type="submit" className={`btn w-100 mt-3 ${form.isBuy ? 'btn-success' : 'btn-danger'}`} disabled={!built.order || Boolean(blocked) || stopped || action.busy}>
          {form.isBuy ? 'Buy / Long' : 'Sell / Short'} {coin}
        </button>
        <ActionStatus action={action} origin="form" />
        {action.state.kind === 'idle' && <p className={`${s.calm} mt-2`}>Your wallet signs the order. The broker’s risk checks then run in a sealed computer, which takes 20 to 60 seconds.</p>}
      </form>
    </section>
  );
}
