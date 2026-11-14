'use client';
// Under the chart (INTERFACES.md 49.1): the account's positions, open orders and fills on Hyperliquid, from the same
// GET /api/hl/:account the trade page reads.
//   - Close places the order in one click and one wallet signature: all of the position, the other side, reduce-only,
//     at the market price (lib/perps.ts, closeIntent and buildOrder). Nothing is filled into the form first.
//   - Cancel goes through the gateway too, signed like an order, so the gateway's record of the account stays right.
import { useState } from 'react';

import type { MarketCoin } from '@/lib/api';
import { hlSummary, sideWords, type HlAnswer } from '@/lib/hl';
import { buildOrder, closeIntent, coinFacts, orderLabel, priceText } from '@/lib/perps';
import { formatDollars } from '@/lib/units';

import { ActionStatus } from './action-status';
import s from './perps.module.css';
import type { GatewayAction } from './use-gateway-action';

type Tab = 'positions' | 'orders' | 'fills';

/** How many fills the table lists. */
const FILLS_SHOWN = 25;

interface Props {
  hl: HlAnswer;
  coins: MarketCoin[];
  /** The wallet owns the account and its Hyperliquid setup is done: Close and Cancel can be pressed. */
  canAct: boolean;
  action: GatewayAction;
  /** Shows a market when its name is clicked in a table. */
  onCoin: (coin: string) => void;
  /** INTERFACES.md 50.1 point 4: opens the panel that moves USDC to and from Hyperliquid. Without it, no button. */
  onMoveUsdc?: () => void;
  /** INTERFACES.md 50.4: why Hyperliquid testnet can't take an order in a coin's market now, or null. Close is a market order, so it is off then. */
  notTrading?: (coin: string) => string | null;
}

export function AccountTables({ hl, coins, canAct, action, onCoin, onMoveUsdc, notTrading }: Props) {
  const [tab, setTab] = useState<Tab>('positions');
  const view = hl.hyperliquid;
  if (!view) {
    return (
      <section className={`${s.panel} ${s.panelBody}`}>
        <p className={s.calm}>Your positions and orders show here once the account has a Hyperliquid address.</p>
      </section>
    );
  }
  const summary = hlSummary(view);
  const orders = view.open_orders ?? [];
  const fills = (view.fills ?? []).slice(0, FILLS_SHOWN);
  const tabs: { id: Tab; label: string }[] = [
    { id: 'positions', label: `Positions (${summary.positions.length})` },
    { id: 'orders', label: `Open orders (${orders.length})` },
    { id: 'fills', label: 'Fills' },
  ];
  const rawSize = (coin: string) => view.clearinghouse_state?.assetPositions.find((p) => p.position.coin === coin)?.position.szi ?? '';
  const coinButton = (coin: string) => (
    <button type="button" className={s.linkBtn} style={{ fontSize: 'inherit' }} onClick={() => onCoin(coin)}>
      {coin}
    </button>
  );

  return (
    <section className={s.panel} aria-label="Your positions, orders and fills">
      <div className={s.panelHead}>
        <div className={s.tabs} role="tablist">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`${s.tab} ${tab === t.id ? s.tabOn : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <span className={`ms-auto small pb-muted ${s.num}`}>
          Hyperliquid equity {formatDollars(summary.equity)}
          {summary.marginRatioBp !== null && ` · margin ratio ${(summary.marginRatioBp / 100).toFixed(2)}% (liquidation at 100%)`}
        </span>
        {/* The margin for these positions is USDC on Hyperliquid: this moves it there from the account on NEAR, and back. */}
        {onMoveUsdc && (
          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onMoveUsdc}>
            <i className="bi bi-arrow-left-right" aria-hidden="true" /> Move USDC
          </button>
        )}
      </div>
      <div className={s.panelBody}>
        {tab === 'positions' &&
          (summary.positions.length === 0 ? (
            <p className={s.calm}>No open positions.</p>
          ) : (
            <div className="table-responsive">
              <table className={`table table-sm align-middle ${s.num}`}>
                <thead>
                  <tr>
                    <th>Market</th>
                    <th className="text-end">Size</th>
                    <th className="text-end">Value</th>
                    <th className="text-end">Entry</th>
                    <th className="text-end">Mark</th>
                    <th className="text-end">Profit</th>
                    <th className="text-end">Liquidation</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {summary.positions.map((p) => {
                    const facts = coinFacts(coins.find((c) => c.coin === p.coin));
                    const intent = closeIntent({ coin: p.coin, szi: rawSize(p.coin) });
                    const built = intent ? buildOrder(intent, facts, { closing: true }) : null;
                    const order = built?.order ?? null;
                    return (
                      <tr key={p.coin}>
                        <td>
                          {coinButton(p.coin)} <span className={p.side === 'long' ? s.good : s.bad}>{p.side}</span> <span className="pb-muted">{p.leverage}</span>
                        </td>
                        <td className="text-end">{rawSize(p.coin).replace(/^-/, '') || p.size}</td>
                        <td className="text-end">{formatDollars(p.value)}</td>
                        <td className="text-end">{priceText(Number(p.entryPx), facts?.szDecimals ?? 0)}</td>
                        <td className="text-end">{priceText(facts?.mark ?? null, facts?.szDecimals ?? 0)}</td>
                        <td className={`text-end ${p.pnl < 0 ? s.bad : p.pnl > 0 ? s.good : ''}`}>{formatDollars(p.pnl)}</td>
                        <td className="text-end">{p.liquidationPx ? priceText(Number(p.liquidationPx), facts?.szDecimals ?? 0) : 'none'}</td>
                        <td className="text-end">
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-secondary py-0"
                            disabled={!order || !canAct || action.busy || Boolean(notTrading?.(p.coin))}
                            title={notTrading?.(p.coin) ?? (order ? 'Closes the whole position at the market price. Your wallet signs once.' : (built?.problems[0] ?? 'This position can’t be closed from here right now.'))}
                            onClick={() => order && void action.run({ kind: 'order', origin: 'positions', label: `Close the ${p.coin} ${p.side}: ${orderLabel(order, 'market')}`, order })}
                          >
                            Close
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        {tab === 'positions' && <ActionStatus action={action} origin="positions" />}

        {tab === 'orders' &&
          (orders.length === 0 ? (
            <p className={s.calm}>No orders resting on the book.</p>
          ) : (
            <div className="table-responsive">
              <table className={`table table-sm align-middle ${s.num}`}>
                <thead>
                  <tr>
                    <th>Market</th>
                    <th>Side</th>
                    <th className="text-end">Size left (of)</th>
                    <th className="text-end">Price</th>
                    <th>Kind</th>
                    <th>Placed</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.oid}>
                      <td>{coinButton(o.coin)}</td>
                      <td className={o.side === 'B' ? s.good : s.bad}>{sideWords(o.side)}</td>
                      <td className="text-end">
                        {o.sz} ({o.origSz})
                      </td>
                      <td className="text-end">{o.limitPx}</td>
                      <td>
                        {o.orderType}
                        {o.tif ? ` ${o.tif}` : ''}
                        {o.reduceOnly ? ', reduce-only' : ''}
                      </td>
                      <td>{new Date(o.timestamp).toLocaleTimeString('en-GB')}</td>
                      <td className="text-end">
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-danger py-0"
                          disabled={!canAct || action.busy}
                          onClick={() => void action.run({ kind: 'cancel', origin: 'orders', label: `Cancel the ${sideWords(o.side)} of ${o.sz} ${o.coin} at ${o.limitPx}`, coin: o.coin, oid: o.oid })}
                        >
                          Cancel
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        {tab === 'orders' && <ActionStatus action={action} origin="orders" />}

        {tab === 'fills' &&
          (fills.length === 0 ? (
            <p className={s.calm}>No fills yet.</p>
          ) : (
            <div className="table-responsive">
              <table className={`table table-sm align-middle ${s.num}`}>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Market</th>
                    <th>What</th>
                    <th className="text-end">Size</th>
                    <th className="text-end">Price</th>
                    <th className="text-end">Fee</th>
                    <th className="text-end">Closed profit</th>
                  </tr>
                </thead>
                <tbody>
                  {fills.map((f) => (
                    <tr key={`${f.tid}-${f.oid}`}>
                      <td>{new Date(f.time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                      <td>{coinButton(f.coin)}</td>
                      <td className={f.side === 'B' ? s.good : s.bad}>{f.dir || sideWords(f.side)}</td>
                      <td className="text-end">{f.sz}</td>
                      <td className="text-end">{f.px}</td>
                      <td className="text-end">{f.fee}</td>
                      <td className="text-end">{f.closedPnl}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </div>
    </section>
  );
}
