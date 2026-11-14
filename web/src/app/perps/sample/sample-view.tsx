'use client';
// /perps/sample (development only): the Perps page's own panels fed from sample data, to look at the layout with no
// backend and no wallet.
//   state=live     a busy market, a position, an open order and fills;
//   state=thin     four candles and a two-level book, as a quiet testnet market looks;
//   state=empty    no candles, an empty book, no trades;
//   state=down     the backend can't answer the two market routes;
//   state=expired  as live, and the first order comes back expired, so "Sign again" shows.
//   state=far      as live, with BTC's price 2.6% under its reference price: Hyperliquid testnet takes no BTC order,
//                  so one line above the form says so, and the order button and Close are off (INTERFACES.md 50.4).
//   state=slow     as live, and an order has already waited 27 seconds when it is sent, so the calm line of
//                  INTERFACES.md 50.4 shows three seconds later, with the button still busy.
// The buttons play an order: two seconds for the wallet, six for the checks, then a result. Nothing is signed or sent.
import { useCallback, useRef, useState } from 'react';

import { Drawer } from '@/components/drawer';
import { AccountTables } from '@/components/perps/account-tables';
import { ChartPanel } from '@/components/perps/chart';
import { MarketBar } from '@/components/perps/market-bar';
import { BookPanel } from '@/components/perps/order-book';
import { EMPTY_FORM, OrderForm, type FormState } from '@/components/perps/order-form';
import { PerpsLayout } from '@/components/perps/perps-layout';
import type { ActionState, GatewayAction, GatewayRequest } from '@/components/perps/use-gateway-action';
import type { MarketCoin } from '@/lib/api';
import type { GatewayAnswer } from '@/lib/gateway';
import type { HlAnswer } from '@/lib/hl';
import { coinTradingNow, notTradingWords } from '@/lib/hl-reach';
import { coinFacts, intervalMs, parseCandles, parsePerps, pickerCoins, priceFromBook, resultWords, spreadOf, type Candle, type Interval } from '@/lib/perps';


import type { SampleState } from './states';

const row = (coin: string, szDecimals: number, mark: number, listed = true): MarketCoin => ({
  coin,
  allowed: true,
  tier: 1,
  band_bp: 300,
  universe_sz_decimals: szDecimals,
  client_cap_usd: 1_000_000,
  testnet: listed ? { asset: 1, sz_decimals: szDecimals, max_leverage: 20, delisted: false, mark_px: String(mark), oracle_px: String(mark * 1.004), mid_px: String(mark), day_ntl_vlm: '2082333.6', funding: '0.0000125' } : null,
  status: null,
});
const COINS = [row('BTC', 5, 68_535), row('ETH', 4, 1_935.8), row('SOL', 2, 142.31), row('DOGE', 0, 0.064521), row('HYPE', 2, 31.2, false)];

/** A steady pseudo-random walk, so the sample looks the same on every load. */
function walk(n: number, start: number, span: Interval, endMs: number): Candle[] {
  let seed = 7;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const length = intervalMs(span);
  let price = start;
  return Array.from({ length: n }, (_, i) => {
    const o = price;
    const c = o * (1 + (next() - 0.5) * 0.006);
    price = c;
    return { t: endMs - (n - 1 - i) * length, o, c, h: Math.max(o, c) * (1 + next() * 0.002), l: Math.min(o, c) * (1 - next() * 0.002), v: next() * 0.4 };
  });
}

/** 13 Nov 2026, 16:00 UTC: a fixed clock for the sample. */
const END_MS = 1_794_585_600_000;

function sampleMarket(state: SampleState, mark: number) {
  if (state === 'down') return undefined;
  const levels = state === 'empty' ? 0 : state === 'thin' ? 2 : 14;
  const tick = mark >= 1000 ? Math.round(mark * 0.00012) : mark * 0.0002;
  const side = (sign: number) => Array.from({ length: levels }, (_, i) => ({ px: String(Number((mark + sign * tick * (i + 1.5)).toPrecision(5))), sz: String(Number((0.002 + ((i * 37) % 11) * 0.0031).toFixed(5))), n: 1 }));
  const trades = state === 'empty' ? [] : Array.from({ length: state === 'thin' ? 3 : 30 }, (_, i) => ({ side: i % 3 === 0 ? 'A' : 'B', px: String(Number((mark + tick * ((i % 5) - 2)).toPrecision(5))), sz: String(0.0005 * ((i % 4) + 1)), time: END_MS - i * 7_000, tid: i }));
  return parsePerps({
    coin: 'BTC',
    ctx: { mark: String(mark), oracle: String(mark * 1.004), funding: '0.0000125', open_interest: '57.66534', day_volume: '2082520.17', prev_day_px: String(mark * 1.031) },
    book: { bids: side(-1), asks: side(1) },
    trades,
    read_at_ms: END_MS,
  })!;
}

const ACCOUNT = 'sample.pbf.testnet';
const HL: HlAnswer = {
  account_id: ACCOUNT,
  owner: 'you.testnet',
  block_height: 1,
  near_time_ms: END_MS,
  hl: null,
  address: '0x0000000000000000000000000000000000000001',
  gateway: { project_id: 'sample', version_key: null },
  hyperliquid: {
    clearinghouse_state: {
      marginSummary: { accountValue: '512.40', totalNtlPos: '500.31', totalMarginUsed: '25.01' },
      crossMarginSummary: { accountValue: '512.40', totalNtlPos: '500.31', totalMarginUsed: '25.01' },
      crossMaintenanceMarginUsed: '6.25',
      withdrawable: '480.10',
      assetPositions: [{ position: { coin: 'BTC', szi: '-0.0073', entryPx: '68610.0', positionValue: '500.31', unrealizedPnl: '0.55', liquidationPx: '131250.0', leverage: { type: 'cross', value: 20 }, marginUsed: '25.01' } }],
    },
    spot_usdc: null,
    abstraction: 'disabled',
    open_orders: [{ coin: 'ETH', side: 'B', limitPx: '1900.0', sz: '0.05', origSz: '0.05', oid: 4_711, timestamp: END_MS - 600_000, reduceOnly: false, orderType: 'Limit', tif: 'Gtc' }],
    fills: [
      { coin: 'BTC', px: '68610.0', sz: '0.0073', side: 'A', time: END_MS - 3_600_000, dir: 'Open Short', closedPnl: '0.0', fee: '0.225', oid: 1, tid: 1, hash: '0x1' },
      { coin: 'ETH', px: '1941.2', sz: '0.05', side: 'A', time: END_MS - 7_200_000, dir: 'Close Long', closedPnl: '1.31', fee: '0.043', oid: 2, tid: 2, hash: '0x2' },
    ],
    agents: [],
    errors: {},
  },
};

/** Plays an order: the wallet, the checks, a result. With `expireFirst` the first one comes back expired; with `slow` it waits past 30 seconds. */
function usePlayedAction(expireFirst: boolean, slow = false): GatewayAction {
  const [state, setState] = useState<ActionState>({ kind: 'idle' });
  const expired = useRef(!expireFirst);
  const run = useCallback(async (request: GatewayRequest) => {
    setState({ kind: 'waiting', request, phase: 'signing', since: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    setState({ kind: 'waiting', request, phase: 'checking', since: Date.now() - (slow ? 27_000 : 0) });
    await new Promise((resolve) => setTimeout(resolve, slow ? 12_000 : 6_000));
    let answer: GatewayAnswer;
    if (!expired.current) {
      expired.current = true;
      answer = { ok: false, code: 'AUTH', reason: 'the message has expired: sign it again' };
    } else if (request.kind === 'cancel') {
      answer = { ok: true, hl: { response: { data: { statuses: ['success'] } } } };
    } else if (request.order.tif === 'Ioc') {
      answer = { ok: true, status: 'filled', filled_sz: request.order.sz, avg_px: '68560', sent: request.order };
    } else {
      answer = { ok: true, status: 'resting', oid: 4_712, sent: request.order };
    }
    setState({ kind: 'done', request, words: resultWords(answer, request.kind === 'order' ? { kind: 'order' } : { kind: 'cancel', oid: request.oid }), answer });
  }, [slow]);
  const again = () => {
    if (state.kind === 'done' || state.kind === 'failed') void run(state.request);
  };
  return { state, busy: state.kind === 'waiting', run, again, dismiss: () => setState({ kind: 'idle' }) };
}

export function SampleView({ state }: { state: SampleState }) {
  const [coin, setCoin] = useState('BTC');
  const [span, setSpan] = useState<Interval>('15m');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [moving, setMoving] = useState(false);
  const action = usePlayedAction(state === 'expired', state === 'slow');
  // State `far`: 13 Nov, 22:28 UTC, BTC's mark stood 2.60% under its oracle price.
  const coins = state === 'far' ? COINS.map((c) => (c.coin === 'BTC' && c.testnet ? { ...c, testnet: { ...c.testnet, oracle_px: String(68_535 / 0.974) } } : c)) : COINS;
  const listed = coins.find((c) => c.coin === coin);
  const facts = coinFacts(listed);
  const notTrading = (name: string) => notTradingWords(name, coinTradingNow(coins.find((c) => c.coin === name), true), 'market');
  const szDecimals = facts?.szDecimals ?? 0;
  const mark = facts?.mark ?? 100;
  const market = sampleMarket(state, mark);
  const candles = state === 'down' ? undefined : state === 'empty' ? [] : parseCandles(walk(state === 'thin' ? 4 : 200, mark * 0.97, span, END_MS));
  const spread = market ? spreadOf(market.bids[0]?.px, market.asks[0]?.px) : null;
  const patch = (change: Partial<FormState>) => setForm((last) => ({ ...last, ...change }));
  const showCoin = (next: string) => {
    setCoin(next);
    patch({ size: '', price: '' });
  };
  return (
    <PerpsLayout
      bar={<MarketBar coins={pickerCoins(COINS)} coin={coin} onCoin={showCoin} szDecimals={szDecimals} ctx={market?.ctx ?? { mark, oracle: mark * 1.004, funding: 0.0000125, openInterest: null, dayVolume: 2_082_333, prevDayPx: null }} />}
      chart={<ChartPanel coin={coin} szDecimals={szDecimals} candles={candles} failed={state === 'down'} interval={span} onInterval={setSpan} />}
      book={<BookPanel coin={coin} szDecimals={szDecimals} market={market} failed={state === 'down'} onPrice={(px) => patch({ kind: 'limit', price: priceFromBook(px, form.isBuy, szDecimals) })} />}
      form={
        <>
          <OrderForm coin={coin} facts={facts} form={form} onForm={patch} spread={spread} blocked={null} action={action} trading={coinTradingNow(listed, true)} />
          <p className="small pb-muted mt-2">Sample data ({state}). Nothing here is signed or sent.</p>
        </>
      }
      tables={
        <>
          <AccountTables hl={HL} coins={coins} canAct action={action} onCoin={showCoin} onMoveUsdc={() => setMoving(true)} notTrading={notTrading} />
          {moving && (
            <Drawer title="Move USDC to or from Hyperliquid" onClose={() => setMoving(false)}>
              <p className="small pb-muted mb-0">Sample data: on the Perps page this panel moves USDC between your account on NEAR and its Hyperliquid address.</p>
            </Drawer>
          )}
        </>
      }
    />
  );
}
