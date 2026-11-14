'use client';
// The Perps page (INTERFACES.md 49.1): a perps exchange's layout in the app's own look.
//   - The market's figures, the chart, the order book and the trades are public: GET /api/markets,
//     GET /api/perps/:coin every second and GET /api/perps/:coin/candles every five (INTERFACES.md 49.3). They show to
//     anyone, with or without a wallet.
//   - The order form, the positions, the open orders and the fills are the account's. Privacy level 1 (INTERFACES.md
//     48.6): nothing about an account is read or shown until the wallet has confirmed it is the owner's; until then the
//     form's place holds the sign-in card (WalletGate).
//   - An order is built in lib/perps.ts, signed once by the wallet and posted to the gateway exactly as the trade page
//     does it (components/perps/use-gateway-action.ts). Close on a position is one click and one signature.
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { AccountPicker } from '@/components/account-picker';
import { Drawer } from '@/components/drawer';
import { MoveUsdc } from '@/components/move-usdc';
import { ApiProblem, WalletGate } from '@/components/notices';
import { AccountTables } from '@/components/perps/account-tables';
import { ChartPanel } from '@/components/perps/chart';
import { MarketBar } from '@/components/perps/market-bar';
import { BookPanel } from '@/components/perps/order-book';
import { EMPTY_FORM, OrderForm, type FormState } from '@/components/perps/order-form';
import { PerpsLayout } from '@/components/perps/perps-layout';
import s from '@/components/perps/perps.module.css';
import { useFeed } from '@/components/perps/use-feed';
import { useGatewayAction } from '@/components/perps/use-gateway-action';
import { useApi } from '@/hooks/use-api';
import { useClientAccount, type ClientAccount } from '@/hooks/use-client-account';
import { hlPath, MARKETS_PATH, marketsPath, type MarketsAnswer } from '@/lib/api';
import { NetworkId } from '@/config';
import { orderLifeMs } from '@/lib/gateway';
import { coinTradingNow, notTradingWords } from '@/lib/hl-reach';
import { setupStep, type HlAnswer } from '@/lib/hl';
import { candlesPath, coinFacts, ctxFromMarkets, mergeCtx, parseCandles, parsePerps, perpsPath, pickerCoins, priceFromBook, spreadOf, withLivePrices, type Interval } from '@/lib/perps';
import { useNearWallet } from '@/providers/near-provider';
import { useSession } from '@/providers/session-provider';

const DEFAULT_COIN = 'BTC';

/** `/perps?coin=ETH` opens on that market. The page renders in the browser only (providers/index.tsx). */
function askedCoin(): string {
  const asked = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('coin');
  return asked && /^[A-Za-z0-9]{1,16}$/.test(asked) ? asked : DEFAULT_COIN;
}

export function PerpsView() {
  const wallet = useNearWallet();
  const session = useSession();
  const client = useClientAccount();
  // INTERFACES.md 48.6: the account's side opens only for a connected wallet that has confirmed (or with privacy off).
  const signedIn = !wallet.loading && Boolean(wallet.signedAccountId) && !session.checking && session.state !== 'needs_sign_in';
  const accountId = signedIn && client.answer?.state ? client.answer.account_id : null;

  // The markets list: the plain one shows to anyone; with an account, each coin's band is the one that account's own
  // gateway enforces (INTERFACES.md 42), and it takes over when it arrives.
  const openMarkets = useApi<MarketsAnswer>(MARKETS_PATH, 30_000);
  const ownMarkets = useApi<MarketsAnswer>(accountId ? marketsPath(accountId) : null, 30_000);
  const markets = ownMarkets.data ?? openMarkets.data;
  const hl = useApi<HlAnswer>(accountId ? hlPath(accountId) : null, 8_000);
  const hlData = hl.data?.account_id === accountId ? hl.data : undefined;

  const [picked, setPicked] = useState(askedCoin);
  const [span, setSpan] = useState<Interval>('15m');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  // INTERFACES.md 50.1 point 4: moving USDC to and from Hyperliquid sits here, by the account's figures.
  const [moving, setMoving] = useState(false);

  const coins = pickerCoins(markets?.coins ?? []);
  // A coin that isn't on the list (a mistyped link) falls back to the first one that is.
  const coin = coins.length > 0 && !coins.some((c) => c.coin === picked) ? (coins[0]?.coin ?? DEFAULT_COIN) : picked;
  const feed = useFeed(perpsPath(coin), 1_000, parsePerps);
  const candles = useFeed(candlesPath(coin, span), 5_000, parseCandles);

  const listed = markets?.coins.find((c) => c.coin === coin);
  const live = feed.data && (feed.data.coin === null || feed.data.coin === coin) ? feed.data : undefined;
  const priced = withLivePrices(listed, live?.ctx);
  const facts = coinFacts(priced);
  // INTERFACES.md 50.4: an order Hyperliquid testnet can't take isn't started. The picked market is judged from its live prices.
  const testnet = NetworkId === 'testnet';
  const trading = coinTradingNow(priced, testnet);
  const notTrading = (name: string) => notTradingWords(name, coinTradingNow(name === coin ? priced : markets?.coins.find((c) => c.coin === name), testnet), 'market');
  const szDecimals = facts?.szDecimals ?? 0;
  const ctx = mergeCtx(live?.ctx, ctxFromMarkets(listed));
  const spread = live ? spreadOf(live.bids[0]?.px, live.asks[0]?.px) : null;

  // INTERFACES.md 50.4: an order is signed for as long as this account's own gateway takes; 110 s until the backend says.
  const action = useGatewayAction(hlData, hl.fetchedAt, hl.reload, orderLifeMs(ownMarkets.data));
  const patch = (change: Partial<FormState>) => setForm((last) => ({ ...last, ...change }));
  const showCoin = (next: string) => {
    if (next === coin) return;
    setPicked(next);
    patch({ size: '', price: '' });
  };

  const blocked = signedIn ? whyBlocked(client, accountId, hlData) : null;
  const canAct = Boolean(signedIn && hlData && client.isOwner && hlData.gateway && setupStep(hlData) === 'ready');

  return (
    <PerpsLayout
      bar={<MarketBar coins={coins} coin={coin} onCoin={showCoin} szDecimals={szDecimals} ctx={ctx} />}
      chart={<ChartPanel coin={coin} szDecimals={szDecimals} candles={candles.data} failed={Boolean(candles.error)} interval={span} onInterval={setSpan} />}
      book={<BookPanel coin={coin} szDecimals={szDecimals} market={live} failed={Boolean(feed.error)} onPrice={(px) => patch({ kind: 'limit', price: priceFromBook(px, form.isBuy, szDecimals) })} />}
      form={
        <WalletGate>
          <ApiProblem error={client.error ?? hl.error} />
          <OrderForm coin={coin} facts={facts} form={form} onForm={patch} spread={spread} blocked={blocked} action={action} trading={trading} />
          <AccountLine client={client} accountId={accountId} />
        </WalletGate>
      }
      tables={
        !signedIn ? (
          <Quiet>Your positions, open orders and fills show here once you have signed in.</Quiet>
        ) : hlData ? (
          <>
            <AccountTables hl={hlData} coins={markets?.coins ?? []} canAct={canAct} action={action} onCoin={showCoin} onMoveUsdc={client.answer?.state ? () => setMoving(true) : undefined} notTrading={notTrading} />
            {moving && client.answer?.state && (
              <Drawer title="Move USDC to or from Hyperliquid" onClose={() => setMoving(false)}>
                <MoveUsdc client={client} answer={client.answer} hl={hlData} reloadHl={hl.reload} previewEnabled={false} bare />
              </Drawer>
            )}
          </>
        ) : accountId && !hl.error ? (
          <div className="pb-skeleton" style={{ height: 120 }} aria-busy="true" />
        ) : (
          <Quiet>Your positions, open orders and fills show here once your account is open.</Quiet>
        )
      }
    />
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <section className={`${s.panel} ${s.panelBody}`}>
      <p className={s.calm}>{children}</p>
    </section>
  );
}

/** Why this wallet can't send an order yet, with what to do next; null when it can. */
function whyBlocked(client: ClientAccount, accountId: string | null, hl: HlAnswer | undefined): ReactNode | null {
  if (client.finding) return <span className="pb-muted">Looking for your account…</span>;
  if (client.errorCode === 'not_yours') return 'This account belongs to another wallet. Pick your own below.';
  if (client.problem) return 'Enter your account’s name below.';
  if (client.answer && !client.answer.exists) {
    return (
      <>
        You have no account yet. <Link href="/">Open one on Home</Link>, then come back to trade.
      </>
    );
  }
  if (!accountId || !hl) return <span className="pb-muted">Reading your account…</span>;
  if (!client.isOwner) return `Only the owner (${hl.owner}) can trade from this account.`;
  if (!hl.gateway) return 'This account was made before trading existed, so it can’t trade. Open a new account under another name.';
  const step = setupStep(hl);
  if (step === 'ready') return null;
  const what = { init: 'its Hyperliquid address', fund: 'a first deposit of at least $10 on Hyperliquid', agent: 'the broker’s trading agent', approve: 'your approval of the trading agent on Hyperliquid' }[step];
  return (
    <>
      Before the first order, the account needs {what}. <Link href="/account">Set it up on the Account page</Link>, in the Hyperliquid card.
    </>
  );
}

/** Which account the form trades from, with the picker behind "Change". It opens by itself while there is no account to show. */
function AccountLine({ client, accountId }: { client: ClientAccount; accountId: string | null }) {
  const [open, setOpen] = useState(false);
  const needsPick = !accountId && !client.finding;
  return (
    <div className="small mt-2">
      {accountId && (
        <p className="pb-muted mb-1">
          Trading from <span className="text-break">{accountId}</span>.{' '}
          <button type="button" className={s.linkBtn} onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide' : 'Change'}
          </button>
        </p>
      )}
      {(open || needsPick) && (
        <AccountPicker name={client.name} problem={client.problem} onName={client.setName} answer={client.answer} owner={client.owner} errorCode={client.errorCode} mine={client.mine} finding={client.finding} />
      )}
    </div>
  );
}
