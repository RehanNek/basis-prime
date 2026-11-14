'use client';
// The trade page (INTERFACES.md 12; PLAN.md 5.8). Orders go to Hyperliquid only through pb-gateway:
//   1. pick a coin (the 23 of universe_v0.json; those testnet lists can be picked), a side, a size and a limit
//      price, with the coin's band shown around the reference price;
//   2. the page rounds them to Hyperliquid's rules and builds INTERFACES.md 9's message;
//   3. the wallet signs it (NEP-413, recipient pb-gateway, 32 random nonce bytes), and the page posts it to
//      /api/order; the backend runs the gateway in OutLayer, which checks it and, if it passes, places it;
//   4. the answer comes back in words, including which check refused.
// The page also lists open orders (each with a cancel, signed the same way), positions and recent fills.
import Link from 'next/link';
import { useState } from 'react';

import { AccountPicker } from '@/components/account-picker';
import { ApiProblem, NotDeployed, WalletGate } from '@/components/notices';
import { NetworkId } from '@/config';
import { useApi } from '@/hooks/use-api';
import { useClientAccount } from '@/hooks/use-client-account';
import { ApiError, hlPath, marketsPath, sendCancel, sendOrder, setLeverage, type MarketCoin, type MarketsAnswer } from '@/lib/api';
import {
  cancelMessage,
  cancelWords,
  expiryNow,
  GATEWAY_RECIPIENT,
  leverageWords,
  orderLifeMs,
  orderMessage,
  orderWords,
  randomNonce,
  TIFS,
  toAuth,
  type AnswerWords,
  type GatewayAnswer,
  type Tif,
} from '@/lib/gateway';
import { sendWithinLife } from '@/lib/order-life';
import { hlSummary, setupStep, sideWords, type HlAnswer } from '@/lib/hl';
import { ownOrderBp } from '@/lib/hl-reach';
import { bandFloorWords, bandPercent, bandProblem, decFromNumber, decText, priceBand, roundOrder, roundPrice, showPrice } from '@/lib/hl-rules';
import { formatDollars, formatUsd } from '@/lib/units';
import { useNearWallet } from '@/providers/near-provider';

export function TradeView() {
  return (
    <main className="pb-container pb-page" style={{ maxWidth: 1040 }}>
      <h1 className="h3">Trade</h1>
      <p className="lead">
        Orders on the account&apos;s Hyperliquid address go through the gateway, which runs the risk checks in a sealed
        computer (OutLayer) first. Your wallet signs each order; nobody holds a Hyperliquid key that can skip the checks.
      </p>
      <WalletGate>
        <TradeBody />
      </WalletGate>
    </main>
  );
}

interface Form {
  coin: string;
  isBuy: boolean;
  size: string;
  price: string;
  reduceOnly: boolean;
  tif: Tif;
}

interface Result {
  title: string;
  words: AnswerWords;
  answer?: GatewayAnswer;
}

function TradeBody() {
  const client = useClientAccount();
  const accountId = client.answer?.state ? client.answer.account_id : null;
  // INTERFACES.md 42: asked with the account, each coin's band is the one that account's own pinned gateway enforces.
  // Before there is an account, the plain path answers with the band a new account would get.
  const markets = useApi<MarketsAnswer>(marketsPath(accountId), 30_000);
  const hl = useApi<HlAnswer>(accountId ? hlPath(accountId) : null, 8_000);
  const hlData = hl.data?.account_id === accountId ? hl.data : undefined;
  const [form, setForm] = useState<Form>({ coin: 'BTC', isBuy: false, size: '', price: '', reduceOnly: false, tif: 'Gtc' });
  const [result, setResult] = useState<Result | null>(null);

  return (
    <>
      <ApiProblem error={client.error ?? markets.error ?? hl.error} />
      <AccountPicker name={client.name} problem={client.problem} onName={client.setName} answer={client.answer} owner={client.owner} errorCode={client.errorCode} mine={client.mine} finding={client.finding} />
      {client.answer && <NotDeployed contracts={client.answer.not_deployed} />}
      {client.answer && !client.answer.exists && <div className="alert alert-secondary small">Create the account on the Account page first.</div>}
      {hlData && <Readiness hl={hlData} />}
      {markets.data && (
        <OrderForm
          markets={markets.data}
          hl={hlData}
          hlFetchedAt={hl.fetchedAt}
          isOwner={client.isOwner}
          form={form}
          setForm={setForm}
          onResult={(r) => {
            setResult(r);
            hl.reload();
          }}
        />
      )}
      {result && <ResultCard result={result} />}
      {hlData?.hyperliquid && (
        <>
          <Positions hl={hlData} markets={markets.data} onClose={(f) => setForm(f)} />
          <OpenOrders hl={hlData} hlFetchedAt={hl.fetchedAt} lifeMs={orderLifeMs(markets.data)} isOwner={client.isOwner} onResult={(r) => { setResult(r); hl.reload(); }} />
          <Fills hl={hlData} />
          <Leverage accountId={hlData.account_id} onResult={(r) => { setResult(r); hl.reload(); }} />
        </>
      )}
    </>
  );
}

/** Before the first order: the Hyperliquid setup on the Account page. */
function Readiness({ hl }: { hl: HlAnswer }) {
  if (!hl.gateway) {
    return <div className="alert alert-secondary small">This account was made before Phase 3: it has no gateway, so it can&apos;t trade. Create a new account.</div>;
  }
  const step = setupStep(hl);
  if (step === 'ready') return null;
  const what = { init: 'set up its Hyperliquid address', fund: 'make a first deposit of at least $10', agent: "get the gateway's agent", approve: 'approve the agent on Hyperliquid' }[step];
  return (
    <div className="alert alert-info small">
      Before trading, the account needs to {what}: see the Hyperliquid card on the <Link href="/account">Account page</Link>.
    </div>
  );
}

/** Coin facts the form needs: the size rule from testnet's meta (it wins there), the band, the reference price. */
function coinFacts(coin: MarketCoin | undefined) {
  if (!coin) return null;
  const listed = coin.testnet && !coin.testnet.delisted ? coin.testnet : null;
  const szDecimals = listed?.sz_decimals ?? coin.universe_sz_decimals;
  const oracle = Number(listed?.oracle_px ?? NaN);
  const mark = Number(listed?.mark_px ?? NaN);
  // The gateway's reference price is the engine's median of exchange prices (RISK_ENGINE.md 3.2), with testnet's
  // oracle as one source; testnet's oracle tracks the exchanges closely (research/day1.md 12), so it stands in here.
  const reference = Number.isFinite(oracle) ? oracle : mark;
  const broken = Number.isFinite(oracle) && Number.isFinite(mark) && Math.abs(mark / oracle - 1) > 0.1;
  return { listed, szDecimals, mark, reference, band: Number.isFinite(reference) ? priceBand(reference, coin.band_bp) : null, broken };
}

function OrderForm(props: {
  markets: MarketsAnswer;
  hl: HlAnswer | undefined;
  hlFetchedAt: number;
  isOwner: boolean;
  form: Form;
  setForm: (f: Form) => void;
  onResult: (r: Result) => void;
}) {
  const { markets, hl, hlFetchedAt, isOwner, form, setForm, onResult } = props;
  const { signMessage, signedAccountId } = useNearWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const coin = markets.coins.find((c) => c.coin === form.coin);
  const facts = coinFacts(coin);
  const rounded = facts ? roundOrder({ size: form.size, price: form.price, isBuy: form.isBuy, szDecimals: facts.szDecimals }) : null;
  const update = (patch: Partial<Form>) => setForm({ ...form, ...patch });

  const problems: string[] = [];
  if (!facts?.listed) problems.push(`${form.coin} isn't listed on Hyperliquid testnet, so it can't be traded here.`);
  if (form.size || form.price) problems.push(...(rounded?.problems ?? []));
  const warnings: string[] = [];
  if (coin && !coin.allowed) warnings.push(`${coin.coin} is not on the allow-list: the gateway refuses it (P1). Send it to see the refusal.`);
  if (coin?.status && coin.status.status !== 'allowed') warnings.push(`The pool marks ${coin.coin} ${coin.status.status.replace('_', '-')}${coin.status.status === 'reduce_only' ? ': only orders that shrink a position pass' : ''}.`);
  if (facts?.broken) warnings.push(`Testnet's mark and oracle for ${form.coin} are far apart: its testnet price is not a real market.`);
  const bandNote = facts?.band && rounded?.limitPx ? bandProblem(Number(rounded.limitPx), facts.band) : null;
  if (bandNote) warnings.push(bandNote);
  const ready = hl && hl.gateway && setupStep(hl) === 'ready';
  const canSend = Boolean(rounded && rounded.problems.length === 0 && facts?.listed && ready && isOwner && !busy && form.size && form.price);

  /** A limit inside the band, past the reference on the side that fills (lib/hl-reach.ts, ownOrderBp). */
  const fillPrice = () => {
    if (!facts?.band) return;
    const target = facts.reference * (1 + ((form.isBuy ? 1 : -1) * ownOrderBp(coin!.band_bp)) / 10_000);
    const dec = decFromNumber(target);
    if (dec) update({ price: decText(roundPrice(dec, facts.szDecimals, form.isBuy ? 'down' : 'up')) });
  };

  const send = async () => {
    if (!hl || !rounded || !coin) return;
    setBusy('Waiting for your wallet to sign…');
    setError(null);
    try {
      const order = { coin: coin.coin, is_buy: form.isBuy, sz: rounded.sz, limit_px: rounded.limitPx, reduce_only: form.reduceOnly, tif: form.tif };
      // INTERFACES.md 50.4: signed for as long as this account's own gateway takes (its markets answer says it).
      const life = orderLifeMs(markets);
      const message = orderMessage(hl.account_id, order, expiryNow(hl.near_time_ms, hlFetchedAt, life));
      const nonce = randomNonce();
      const signed = await signMessage({ message, recipient: GATEWAY_RECIPIENT, nonce });
      if (signed.accountId !== hl.owner) throw new Error(`${signed.accountId} signed, but the account belongs to ${hl.owner}`);
      setBusy('The gateway is checking the order and placing it: usually 20 to 60 seconds…');
      // Past 30 seconds the line turns calm, and the page waits for as long as the order lives.
      const answer = await sendWithinLife({ send: () => sendOrder(hl.account_id, toAuth(signed, message, nonce)), lifeMs: life, network: NetworkId, onCalm: setBusy });
      onResult({ title: `Order: ${form.isBuy ? 'buy' : 'sell'} ${rounded.sz} ${coin.coin} at ${rounded.limitPx}`, words: orderWords(answer), answer });
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : failure instanceof Error ? (/reject|cancel/i.test(failure.message) ? 'Cancelled in the wallet' : failure.message) : String(failure));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">New order</div>
      <div className="card-body small">
        <div className="row g-2 align-items-end">
          <div className="col-sm-3">
            <label className="form-label mb-1" htmlFor="coin">Coin</label>
            <select id="coin" className="form-select form-select-sm" value={form.coin} onChange={(e) => update({ coin: e.target.value, price: '' })}>
              <optgroup label="On the allow-list">
                {markets.coins.filter((c) => c.allowed).map((c) => (
                  <option key={c.coin} value={c.coin} disabled={!c.testnet || c.testnet.delisted}>
                    {c.coin}
                    {!c.testnet ? ' (not on testnet)' : c.testnet.delisted ? ' (delisted on testnet)' : ''}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Not on the list (the gateway refuses)">
                {markets.coins.filter((c) => !c.allowed).map((c) => (
                  <option key={c.coin} value={c.coin} disabled={!c.testnet || c.testnet.delisted}>
                    {c.coin}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
          <div className="col-sm-3">
            <div className="btn-group btn-group-sm w-100" role="group" aria-label="Side">
              <button className={`btn ${form.isBuy ? 'btn-success' : 'btn-outline-success'}`} onClick={() => update({ isBuy: true })}>Buy / long</button>
              <button className={`btn ${!form.isBuy ? 'btn-danger' : 'btn-outline-danger'}`} onClick={() => update({ isBuy: false })}>Sell / short</button>
            </div>
          </div>
          <div className="col-sm-3">
            <label className="form-label mb-1" htmlFor="size">Size ({form.coin})</label>
            <input id="size" className="form-control form-control-sm" value={form.size} onChange={(e) => update({ size: e.target.value })} placeholder={facts ? `step ${decText({ units: 1n, scale: facts.szDecimals })}` : ''} />
          </div>
          <div className="col-sm-3">
            <label className="form-label mb-1" htmlFor="price">Limit price</label>
            <div className="input-group input-group-sm">
              <input id="price" className="form-control" value={form.price} onChange={(e) => update({ price: e.target.value })} placeholder="USD" />
              <button className="btn btn-outline-secondary" disabled={!facts?.band} onClick={fillPrice} title="Half the band past the reference, on the side that fills">
                Fill price
              </button>
            </div>
          </div>
        </div>
        <div className="d-flex flex-wrap gap-3 align-items-center mt-2">
          <div className="form-check">
            <input id="reduce" className="form-check-input" type="checkbox" checked={form.reduceOnly} onChange={(e) => update({ reduceOnly: e.target.checked })} />
            <label className="form-check-label" htmlFor="reduce">Reduce-only (it may only shrink the position)</label>
          </div>
          <select className="form-select form-select-sm" style={{ maxWidth: 380 }} value={form.tif} onChange={(e) => update({ tif: e.target.value as Tif })} aria-label="Time in force">
            {TIFS.map((t) => (
              <option key={t.value} value={t.value}>{t.value}: {t.words}</option>
            ))}
          </select>
        </div>

        {facts && coin && (
          <div className="border rounded p-2 mt-2 bg-light">
            {facts.listed ? (
              <>
                <div>
                  {coin.coin}: mark <span className="font-monospace">{showPrice(facts.mark, facts.szDecimals)}</span>, reference about{' '}
                  <span className="font-monospace">{showPrice(facts.reference, facts.szDecimals)}</span> (testnet&apos;s oracle).{' '}
                  {facts.band && (
                    <>
                      Price band ±{bandPercent(coin.band_bp)}: <span className="font-monospace">{showPrice(facts.band.low, facts.szDecimals)}</span> to{' '}
                      <span className="font-monospace">{showPrice(facts.band.high, facts.szDecimals)}</span>. {bandFloorWords(coin.band_bp, markets.band_floor_bp)}
                    </>
                  )}
                </div>
                <div className="text-body-secondary">
                  Sizes in steps of {decText({ units: 1n, scale: facts.szDecimals })}; prices with 5 significant figures and{' '}
                  {6 - facts.szDecimals <= 0 ? 'no decimals' : 6 - facts.szDecimals === 1 ? 'at most 1 decimal' : `at most ${6 - facts.szDecimals} decimals`}; at least $10.
                  {coin.testnet?.day_ntl_vlm && ` Testnet traded $${Math.round(Number(coin.testnet.day_ntl_vlm)).toLocaleString()} of it in the last day.`}
                </div>
              </>
            ) : (
              <div>{coin.coin} isn&apos;t on Hyperliquid testnet{coin.testnet?.delisted ? ' any more (delisted)' : ''}.</div>
            )}
          </div>
        )}

        {rounded && rounded.sz && rounded.limitPx && (
          <p className="mt-2 mb-1">
            Will sign: {form.isBuy ? 'buy' : 'sell'} <span className="font-monospace">{rounded.sz}</span> {form.coin} at{' '}
            <span className="font-monospace">{rounded.limitPx}</span>, {form.tif}
            {form.reduceOnly ? ', reduce-only' : ''}; worth {formatUsd(rounded.notionalMicro)}.
            {rounded.changes.length > 0 && <span className="text-body-secondary"> Rounded: {rounded.changes.join('; ')}.</span>}
          </p>
        )}
        {problems.map((p) => (
          <div key={p} className="text-danger">{p}</div>
        ))}
        {warnings.map((w) => (
          <div key={w} className="text-warning-emphasis">{w}</div>
        ))}
        <div className="d-flex flex-wrap align-items-center gap-2 mt-2">
          <button className={`btn btn-sm ${form.isBuy ? 'btn-success' : 'btn-danger'}`} disabled={!canSend} onClick={send}>
            Sign and send the order
          </button>
          {!isOwner && hl && <span className="text-body-secondary">Only the owner ({hl.owner}) can trade; you are {signedAccountId}.</span>}
          {busy && <span>{busy}</span>}
        </div>
        {error && <div className="alert alert-warning py-1 px-2 mt-2 mb-0">{error}</div>}
      </div>
    </section>
  );
}

function ResultCard({ result }: { result: Result }) {
  const { words, answer } = result;
  return (
    <section className={`card mb-3 border-${words.ok ? 'success' : 'danger'}`}>
      <div className="card-header d-flex flex-wrap gap-2 align-items-center">
        <span className="fw-semibold">{result.title}</span>
        <span className={`badge text-bg-${words.ok ? 'success' : 'danger'}`}>{words.ok ? 'done' : 'refused'}</span>
      </div>
      <div className="card-body small">
        <p className="mb-1">{words.headline}</p>
        {words.lines.map((line) => (
          <p key={line} className="mb-1 text-body-secondary">{line}</p>
        ))}
        {answer?.attestation_url && (
          <p className="mb-0">
            Checked in a sealed computer (OutLayer) ·{' '}
            <a href={answer.attestation_url} target="_blank" rel="noreferrer">attestation</a>
          </p>
        )}
        {answer?.hl !== undefined && (
          <details className="mt-1">
            <summary>Hyperliquid&apos;s answer</summary>
            <pre className="small mb-0 text-wrap">{JSON.stringify(answer.hl, null, 1)}</pre>
          </details>
        )}
      </div>
    </section>
  );
}

function Positions({ hl, markets, onClose }: { hl: HlAnswer; markets: MarketsAnswer | undefined; onClose: (f: Form) => void }) {
  const summary = hlSummary(hl.hyperliquid!);
  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">Positions</div>
      <div className="card-body small">
        <p className="mb-2">
          Equity {formatDollars(summary.equity)}; Hyperliquid margin ratio{' '}
          {summary.marginRatioBp === null ? '?' : `${(summary.marginRatioBp / 100).toFixed(2)}%`} (liquidation at 100%).
        </p>
        {summary.positions.length === 0 ? (
          <p className="text-body-secondary mb-0">No positions.</p>
        ) : (
          <table className="table table-sm mb-0">
            <thead>
              <tr>
                <th>Coin</th>
                <th className="text-end">Size</th>
                <th className="text-end">Entry</th>
                <th className="text-end">Value</th>
                <th className="text-end">PnL</th>
                <th className="text-end">Liquidation</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {summary.positions.map((p) => {
                const facts = coinFacts(markets?.coins.find((c) => c.coin === p.coin));
                return (
                  <tr key={p.coin}>
                    <td>{p.coin} {p.side} <span className="text-body-secondary">({p.leverage})</span></td>
                    <td className="text-end font-monospace">{p.size}</td>
                    <td className="text-end font-monospace">{p.entryPx}</td>
                    <td className="text-end font-monospace">{formatDollars(p.value)}</td>
                    <td className={`text-end font-monospace ${p.pnl < 0 ? 'text-danger' : ''}`}>{formatDollars(p.pnl)}</td>
                    <td className="text-end font-monospace">{p.liquidationPx ?? 'none'}</td>
                    <td className="text-end">
                      <button
                        className="btn btn-sm btn-outline-secondary py-0"
                        title="Fill the form with a reduce-only order that closes it"
                        onClick={() => {
                          const isBuy = p.side === 'short';
                          let price = '';
                          if (facts?.band) {
                            const target = facts.reference * (1 + ((isBuy ? 1 : -1) * ownOrderBp(facts.band.bandBp)) / 10_000);
                            const dec = decFromNumber(target);
                            if (dec) price = decText(roundPrice(dec, facts.szDecimals, isBuy ? 'down' : 'up'));
                          }
                          onClose({ coin: p.coin, isBuy, size: String(p.size), price, reduceOnly: true, tif: 'Ioc' });
                        }}
                      >
                        Close…
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function OpenOrders({ hl, hlFetchedAt, lifeMs, isOwner, onResult }: { hl: HlAnswer; hlFetchedAt: number; lifeMs: number; isOwner: boolean; onResult: (r: Result) => void }) {
  const { signMessage } = useNearWallet();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const orders = hl.hyperliquid?.open_orders ?? [];

  const cancel = async (coin: string, oid: number) => {
    setBusy(oid);
    setError(null);
    try {
      // INTERFACES.md 50.4: a cancel is signed for the same life as an order, and waited for as long.
      const message = cancelMessage(hl.account_id, { coin, oid }, expiryNow(hl.near_time_ms, hlFetchedAt, lifeMs));
      const nonce = randomNonce();
      const signed = await signMessage({ message, recipient: GATEWAY_RECIPIENT, nonce });
      if (signed.accountId !== hl.owner) throw new Error(`${signed.accountId} signed, but the account belongs to ${hl.owner}`);
      const answer = await sendWithinLife({ send: () => sendCancel(hl.account_id, toAuth(signed, message, nonce)), lifeMs, network: NetworkId });
      onResult({ title: `Cancel order ${oid}`, words: cancelWords(answer, oid), answer });
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">Open orders</div>
      <div className="card-body small">
        {orders.length === 0 ? (
          <p className="text-body-secondary mb-0">None resting.</p>
        ) : (
          <table className="table table-sm mb-0">
            <thead>
              <tr>
                <th>Coin</th>
                <th>Side</th>
                <th className="text-end">Size (of)</th>
                <th className="text-end">Limit</th>
                <th>Kind</th>
                <th>Placed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.oid}>
                  <td>{o.coin}</td>
                  <td>{sideWords(o.side)}</td>
                  <td className="text-end font-monospace">{o.sz} ({o.origSz})</td>
                  <td className="text-end font-monospace">{o.limitPx}</td>
                  <td>{o.orderType}{o.tif ? ` ${o.tif}` : ''}{o.reduceOnly ? ', reduce-only' : ''}</td>
                  <td>{new Date(o.timestamp).toLocaleTimeString()}</td>
                  <td className="text-end">
                    <button className="btn btn-sm btn-outline-danger py-0" disabled={!isOwner || busy !== null} onClick={() => cancel(o.coin, o.oid)}>
                      {busy === o.oid ? 'Cancelling…' : 'Cancel'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-body-secondary mt-2 mb-0">A cancel goes through the gateway too, signed like an order, so its record of the account stays right.</p>
        {error && <div className="alert alert-warning py-1 px-2 mt-2 mb-0">{error}</div>}
      </div>
    </section>
  );
}

function Fills({ hl }: { hl: HlAnswer }) {
  const fills = hl.hyperliquid?.fills ?? [];
  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">Recent fills</div>
      <div className="card-body small">
        {fills.length === 0 ? (
          <p className="text-body-secondary mb-0">No fills yet.</p>
        ) : (
          <table className="table table-sm mb-0">
            <thead>
              <tr>
                <th>Time</th>
                <th>Coin</th>
                <th>What</th>
                <th className="text-end">Size</th>
                <th className="text-end">Price</th>
                <th className="text-end">Fee</th>
                <th className="text-end">Closed PnL</th>
              </tr>
            </thead>
            <tbody>
              {fills.map((f) => (
                <tr key={`${f.tid}-${f.oid}`}>
                  <td>{new Date(f.time).toLocaleString()}</td>
                  <td>{f.coin}</td>
                  <td>{f.dir || sideWords(f.side)}</td>
                  <td className="text-end font-monospace">{f.sz}</td>
                  <td className="text-end font-monospace">{f.px}</td>
                  <td className="text-end font-monospace">{f.fee}</td>
                  <td className="text-end font-monospace">{f.closedPnl}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

/** set_leverage needs no signature: the gateway picks the numbers (INTERFACES.md 9). */
function Leverage({ accountId, onResult }: { accountId: string; onResult: (r: Result) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">Leverage lock</div>
      <div className="card-body small">
        <p className="mb-2">
          The gateway sets each coin&apos;s cross leverage on Hyperliquid to the most the credit checks allow at full use, so
          Hyperliquid&apos;s own margin check refuses anything bigger, even without the gateway.
        </p>
        <button
          className="btn btn-sm btn-outline-secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const answer = await setLeverage(accountId);
              onResult({ title: 'Set leverage', words: leverageWords(answer), answer });
            } catch (failure) {
              setError(failure instanceof ApiError ? failure.message : String(failure));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Setting…' : 'Set leverage now'}
        </button>
        {error && <div className="alert alert-warning py-1 px-2 mt-2 mb-0">{error}</div>}
      </div>
    </section>
  );
}
