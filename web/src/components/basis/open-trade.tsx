'use client';
// "Open a basis trade" (INTERFACES.md 49.1, point 5): a token, a size and one button, then a rail with every step named
// in plain words. The current step is highlighted, each wallet approval is said before the wallet opens, and the run
// goes on by itself to the loan. The rail is drawn from what the account really shows (lib/basis.ts, `openSteps`), so
// after a reload it stands at the right step and the button says which.
//
// INTERFACES.md 51.14 (the user, 14 Nov: "i want to place a second third or fourth basis trade and i want the flow
// like as if i had zero basis trades"): the form is always here. An account that already holds a trade, however it
// got there, opens another on top: the page notes where the account stood (`TradeBase`), keeps that in the browser
// so a reload goes on with it, and counts the new coin, the new short and the new loan from there.
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { Dot } from '@/components/flow-progress';
import { FundingPlan } from '@/components/home/funding-plan';
import { LoanBox } from '@/components/basis/loan-box';
import { FailureBox, LiveLine } from '@/components/basis/parts';
import type { BasisData } from '@/components/basis/use-basis-data';
import { useOpenRun } from '@/components/basis/use-open-run';
import { FactoryContract } from '@/config';
import { Drawer } from '@/components/drawer';
import { MoveBox } from '@/components/home/moves';
import { MoveUsdc } from '@/components/move-usdc';
import {
  baseFromText,
  baseStands,
  baseToText,
  collateralPlan,
  defaultSize,
  DEFAULT_VALUE_USD,
  marginFor,
  marginToAdd,
  marginTooLarge,
  MIN_VALUE_TO_BORROW,
  offersOwnEther,
  openSteps,
  owedInAll,
  ownEtherAmount,
  readSize,
  shortTarget,
  shortUnitsOf,
  tradeBase,
  valueMicro,
  type OpenKey,
  type TradeBase,
} from '@/lib/basis';
import { hlSummary, loanOpen } from '@/lib/hl';
import { defaultCoin, NONE_TRADING_WORDS, NOT_TRADING_MARK } from '@/lib/hl-reach';
import { etherCapWords, etherToken, MOVES } from '@/lib/moves';
import { held } from '@/lib/setup';
import { formatUnits, formatUsd } from '@/lib/units';

/** What each step is for, in a line, shown under the step the run is on. */
const ABOUT: Record<OpenKey, string> = {
  account: 'Your own account on NEAR. Your wallet owns it, and it holds your coin and your loan.',
  collateral: 'The coin is what you hold. The USDC is the margin for the short.',
  address: 'An address on Hyperliquid that only your account can sign for. Nobody holds a key to it.',
  margin: 'Most of the USDC goes to Hyperliquid as margin. $10 stays in your account.',
  agent: 'The order gateway names the one key that may place orders for this account. It can trade, and it can’t withdraw.',
  approve: 'Your account tells Hyperliquid that this key may place its orders.',
  short: 'A short as big as what you hold cancels out the coin’s price moves.',
  aave: 'Aave lends against collateral at your account’s address on its chain. On testnet that collateral comes from a faucet.',
  loan: 'USDC, lent against the coin and the short together.',
};

/** A trade started on top of what the account had, in the browser's own store: read, written, and forgotten. */
const storeKeyFor = (accountId: string | null) => (accountId ? `pb:basis:adding:${accountId}` : null);
function readStored(key: string | null, nowMs: number): TradeBase | null {
  if (!key) return null;
  try {
    return baseFromText(window.localStorage.getItem(key), nowMs);
  } catch {
    return null;
  }
}
function writeStored(key: string | null, base: TradeBase | null) {
  if (!key) return;
  try {
    if (base) window.localStorage.setItem(key, baseToText(base));
    else window.localStorage.removeItem(key);
  } catch {
    // no store: the trade is then remembered only until the page is reloaded
  }
}

interface Props {
  data: BasisData;
  /** "Close everything" is running: this card then only says so, and offers nothing. */
  closing?: boolean;
  /** Tells the page while this card's run is on, so the other run can't be started beside it. */
  onRunning?: (running: boolean) => void;
}

export function OpenTrade({ data, closing = false, onRunning }: Props) {
  const { client, answer, state, options, testnet } = data;
  const [picked, setPicked] = useState('');
  const [typed, setTyped] = useState<string | null>(null);
  // The client passed the Aave step over. Kept up here: the steps below are read with it.
  const [skipAave, setSkipAave] = useState(false);
  const usable = options.filter((o) => o.usable);
  // INTERFACES.md 50.4: the page opens on the coin the account already holds, else on the first that can trade now.
  const token = usable.find((o) => o.symbol === picked) ?? defaultCoin(options, (symbol) => held(answer, symbol) > 0n);

  const heldUnits = token ? held(answer, token.symbol) : 0n;
  const hlEquity = BigInt(Math.max(0, Math.round((data.hl?.hyperliquid ? (hlSummary(data.hl.hyperliquid).equity ?? 0) : 0) * 1e6)));
  const usdcHeld = held(answer, 'USDC');

  // ---------- which trade the form is for ----------
  // A first trade: every step is done or not by what the account holds at all, and the size is what it holds.
  const steps = (value: bigint | null, base: TradeBase | null) => (token ? openSteps({ token, account: answer, hl: data.hl, lender: data.lender, testnet, helperOn: data.helperOn, nowMs: data.now, value, skipAave, base }) : null);
  const firstFixed = heldUnits > 0n;
  // Whether a first trade is already open doesn't turn on the size: with a short in place its margin is there.
  const firstComplete = Boolean(steps(null, null)?.complete);
  // A trade started on top of what the account had, kept in the browser: the page goes on with it until its loan is
  // taken (or the client says it is done). It is read once per account.
  const storeKey = storeKeyFor(client.accountId);
  const [saved, setSaved] = useState<{ key: string | null; base: TradeBase | null }>({ key: null, base: null });
  if (saved.key !== storeKey) setSaved({ key: storeKey, base: readStored(storeKey, data.now) });
  const remember = (base: TradeBase | null) => {
    writeStored(storeKey, base);
    setSaved({ key: storeKey, base });
  };
  // A remembered trade counts only while the account still has what it had when the trade was started.
  const begun = saved.key === storeKey && saved.base && token && saved.base.symbol === token.symbol && baseStands(saved.base, answer, data.hl, token.coin) ? saved.base : null;
  const begunView = begun && token ? steps(valueMicro(shortTarget(begun), token.decimals, token.price), begun) : null;
  /** The added trade the page is in the middle of, or null. */
  const active = begun && begunView && !begunView.complete ? begun : null;
  /** The account already holds a trade (or one is being added): the form then opens another on top. */
  const again = firstComplete || active !== null;

  // Once the coin is in the account on a first trade, the trade is that size: the short matches what is held.
  const sizeFixed = !again && firstFixed;
  const sizeText = !token ? '' : active ? formatUnits(active.sizeUnits, token.decimals) : sizeFixed ? formatUnits(heldUnits, token.decimals) : (typed ?? defaultSize(token.price, token.szDecimals));
  const size = !token ? { units: null, problem: null } : active ? { units: active.sizeUnits, problem: null } : sizeFixed ? { units: heldUnits, problem: null } : readSize(sizeText, token, token.szDecimals);
  const value = token && size.units ? valueMicro(size.units, token.decimals, token.price) : null;
  // Another trade counts from where the account stands now, until it is started; then from where it stood.
  const base = again && token ? (active ?? tradeBase({ token, sizeUnits: size.units ?? 1n, account: answer, hl: data.hl, lender: data.lender, nowMs: data.now })) : null;
  const totalValue = base && token ? valueMicro(shortTarget(base), token.decimals, token.price) : null;
  const plan = !token || !size.units
    ? null
    : base
      ? collateralPlan({ sizeUnits: base.heldUnits + base.sizeUnits, heldUnits, usdcHeld, value: totalValue ?? BigInt(DEFAULT_VALUE_USD) * 1_000_000n, hlEquity })
      : collateralPlan({ sizeUnits: size.units, heldUnits, usdcHeld, value: value ?? BigInt(DEFAULT_VALUE_USD) * 1_000_000n, hlEquity });
  // The margin the trade has to move: all of it on a first trade, what the bigger short still lacks on another.
  const marginNeeded = base ? (totalValue !== null && marginFor(totalValue) > hlEquity ? marginFor(totalValue) - hlEquity : 0n) : value !== null ? marginFor(value) : null;
  const tooLarge = active || sizeFixed ? null : marginTooLarge(marginNeeded, testnet);

  // INTERFACES.md 51.2: on an ETH trade the Aave step offers the client's own ETH beside the faucet's test collateral,
  // and can be passed over. The run stops there for the choice, as it stops at the loan.
  const ether = etherToken(answer?.balances);
  const ownEther = Boolean(token && offersOwnEther(token.coin, ether !== null, testnet) && client.isOwner);
  const [movingEther, setMovingEther] = useState(false);
  const [movingMargin, setMovingMargin] = useState(false);
  const run = useOpenRun({ client, token, sizeUnits: size.units, usdcId: data.usdc?.id ?? null, permission: data.offered, reloadAll: data.reloadAll, reloadHl: data.reloadHl, reloadLender: data.reloadLender, ownEther, skipAave, base: active });
  const start = async (opts: { faucet?: boolean } = {}) => {
    // Another trade: note where the account stands as it starts, and go on from that even after a reload.
    let startFrom = active;
    if (again && !startFrom) {
      if (!token || !size.units) return;
      startFrom = tradeBase({ token, sizeUnits: size.units, account: answer, hl: data.hl, lender: data.lender, nowMs: data.now });
      remember(startFrom);
    }
    onRunning?.(true);
    try {
      await run.start(again ? { ...opts, base: startFrom } : opts);
    } finally {
      onRunning?.(false);
    }
  };
  const view = base ? steps(totalValue, base) : steps(value, null);

  // ---------- what can't go on, said once ----------
  if (closing) {
    return (
      <Card>
        <p className="mb-0 pb-muted">“Close everything” is running below. A new trade can be opened once it has finished.</p>
      </Card>
    );
  }
  if (!client.accountId) {
    return (
      <Card>
        <p className="mb-0">{client.finding ? 'Looking for your account…' : (client.problem ?? 'Pick a name for your account first.')}</p>
      </Card>
    );
  }
  if (client.errorCode === 'not_yours') {
    return (
      <Card>
        <p className="mb-0">This name belongs to another wallet. Use “Another account” above to pick one of yours.</p>
      </Card>
    );
  }
  if (!data.settled || !view) {
    return (
      <Card>
        {data.settled && options.length === 0 ? (
          <p className="mb-0">This account’s settings list no coin that can be hedged, so there is no basis trade to open here.</p>
        ) : data.settled && !token ? (
          <ul className="mb-0 ps-3">
            {options.map((o) => (
              <li key={o.symbol}>{o.why}</li>
            ))}
          </ul>
        ) : (
          <div className="pb-skeleton" style={{ height: 160 }} aria-busy="true" />
        )}
      </Card>
    );
  }
  const taken = answer?.exists && (!state || state.owner !== client.owner);
  if (taken) {
    return (
      <Card>
        <p className="mb-0">{answer?.account_id} isn’t your account. Use “Another account” above to pick another name.</p>
      </Card>
    );
  }

  const phase = run.phase;
  // While the run is on, the rail follows the run's own step, which comes from a fresher read than the page's.
  const runAt = run.busy && run.at ? view.steps.findIndex((s) => s.key === run.at) : -1;
  const current = runAt >= 0 ? run.at : view.next;
  // Once the coin is in the account (or the run has stopped on a step), the button says where the run goes on from.
  const started = again ? active !== null : view.steps.some((s) => (s.key === 'collateral' || s.key === 'short') && s.mark === 'done') || phase.kind === 'failed';
  // What is owed now, to our pool and to lenders: a lender's part as the page can see it, not as the last check read it.
  const owed = owedInAll(answer, data.lender);
  const shortNow = token ? shortUnitsOf(data.hl, token.coin, token.decimals) : 0n;
  // An added trade whose margin has to move while the pool is owed: that move needs a check first, which the
  // "Move USDC" box runs. The page offers it at the margin step.
  const marginByHand = active !== null && view.next === 'margin' && !view.waiting && Boolean(state && loanOpen(state.loan));
  const marginHint = marginByHand && totalValue !== null ? marginToAdd({ totalValue, hlEquity, usdcHeld }) : null;
  // The two steps that are the client's own choice: the loan, and on an ETH trade what Aave gets as collateral.
  const atAaveChoice = view.next === 'aave' && ownEther;
  const atLoan = view.next === 'loan' || atAaveChoice;
  const etherPrice = options.find((o) => o.coin === 'ETH')?.price ?? null;
  const btcPrice = options.find((o) => o.coin === 'BTC')?.price ?? null;
  const nextStep = view.steps.find((s) => s.key === view.next);
  // INTERFACES.md 50.4: a short that Hyperliquid can't take now isn't started. Once the short is open, the rest goes on.
  const needsShort = view.steps.some((s) => s.key === 'short' && s.mark !== 'done');
  const stoppedNow = Boolean(token && !token.tradesNow && needsShort);
  // With one coin on offer its own line says it all; with several, one line first says that none can trade.
  const noneTrades = usable.length > 1 && usable.every((o) => !o.tradesNow);
  const canStart = Boolean(token) && !view.blocked && !run.busy && (sizeFixed || (size.units !== null && !size.problem)) && data.factoryLive !== false && !stoppedNow && !tooLarge && !marginByHand;
  const coin = token!.coin;

  return (
    <Card>
      {/* What the account already holds, in one line: a new trade goes on top of it. */}
      {again && !active && token && (
        <p className="small pb-muted mb-3">
          Your account already holds {formatUnits(heldUnits, token.decimals)} {coin}, is short {formatUnits(shortNow, token.decimals)} {coin} on Hyperliquid and owes {formatUsd(owed)}. A new trade is added on top of
          that. <Link href="/">Home</Link> shows how safe the loan is; to leave, use “Close everything” below.
        </p>
      )}
      {active && (
        <p className="small pb-muted mb-3">
          Adding a trade of {formatUnits(active.sizeUnits, token!.decimals)} {coin} on top of what the account had.{' '}
          {!run.busy && (
            <button type="button" className="btn btn-link btn-sm p-0 align-baseline" onClick={() => remember(null)}>
              Stop here
            </button>
          )}
          {!run.busy && ' (what was added so far stays in your account).'}
        </p>
      )}
      {/* The form: a token, a size, one button. Once the coin is in the account on a first trade, the trade is that size. */}
      {!view.complete && (
        <div className="d-flex flex-wrap align-items-end gap-3 mb-2">
          <div>
            <label className="form-label small pb-muted mb-1" htmlFor="basis-token">
              Coin
            </label>
            <select id="basis-token" className="form-select" style={{ minWidth: 170 }} value={token!.symbol} disabled={run.busy || sizeFixed || active !== null} onChange={(e) => { setPicked(e.target.value); setTyped(null); }}>
              {options.map((o) => (
                <option key={o.symbol} value={o.symbol} disabled={!o.usable || (!o.tradesNow && o.symbol !== token!.symbol)}>
                  {o.label}
                  {!o.usable ? ' (not yet)' : !o.tradesNow ? ` (${NOT_TRADING_MARK})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label small pb-muted mb-1" htmlFor="basis-size">
              Size
            </label>
            <div className="input-group" style={{ maxWidth: 220 }}>
              <input id="basis-size" className={`form-control num ${size.problem || tooLarge ? 'is-invalid' : ''}`} inputMode="decimal" value={sizeText} disabled={run.busy || sizeFixed || active !== null} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
              <span className="input-group-text">{coin}</span>
            </div>
          </div>
          {!atLoan && (
            <button type="button" className="btn btn-primary" disabled={!canStart} onClick={() => void start()}>
              {run.busy ? (
                <>
                  <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
                  Working…
                </>
              ) : started && nextStep ? (
                `Continue: ${nextStep.title.charAt(0).toLowerCase()}${nextStep.title.slice(1)}`
              ) : (
                'Open the basis trade'
              )}
            </button>
          )}
        </div>
      )}
      {!view.complete && (
        <div className="form-text mb-3">
          {size.problem || tooLarge ? (
            <span className="text-danger">{size.problem ?? tooLarge}</span>
          ) : active ? (
            `The trade adds ${formatUnits(active.sizeUnits, token!.decimals)} ${coin}${value !== null ? `, about ${formatUsd(value)}` : ''}, and a short of the same size.`
          ) : sizeFixed ? (
            `Your account holds ${formatUnits(heldUnits, token!.decimals)} ${coin}${value !== null ? `, about ${formatUsd(value)}` : ''}. The short is the same size.`
          ) : (
            <>
              {value !== null ? `About ${formatUsd(value)} of ${coin}. ` : ''}
              {testnet && plan && (plan.coin > 0n || plan.usdc > 0n)
                ? `On testnet the page adds ${[plan.coin > 0n ? `${formatUnits(plan.coin, token!.decimals)} test ${coin}` : null, plan.usdc > 0n ? `${formatUnits(plan.usdc, 6)} test USDC for the margin` : null].filter(Boolean).join(' and ')}. `
                : ''}
              {value !== null && value < MIN_VALUE_TO_BORROW ? 'Our pool lends against $1,000 or more, so a trade this small may get no loan. ' : ''}
              Your wallet approves each step, and the page says what it will ask before it opens.
            </>
          )}
          {options.filter((o) => !o.usable).map((o) => (
            <div key={o.symbol}>{o.why}</div>
          ))}
          {/* A coin whose price on Hyperliquid testnet is too far out for any order: why, and what to do. */}
          {needsShort && (noneTrades ? <div className="text-danger">{NONE_TRADING_WORDS}</div> : null)}
          {needsShort &&
            usable
              .filter((o) => !o.tradesNow && o.whyNotNow)
              .map((o) => (
                <div key={o.symbol} className={o.symbol === token!.symbol ? 'text-danger' : undefined}>
                  {o.whyNotNow}
                </div>
              ))}
        </div>
      )}
      {view.next === 'account' && phase.kind === 'idle' && (
        <div className="form-text mb-3">
          The account will be <span className="text-break fw-medium">{client.accountId}</span>, under {FactoryContract}. Opening it costs 6 NEAR, and about 4.7 NEAR of that stays in the account.
          {data.offered ? ' The same approval lets outside lenders fund part of a loan; you can change that on the Account page.' : ''}
          {data.factoryLive === false ? ' The factory isn’t live on this network yet.' : ''}
        </div>
      )}
      {view.blocked && <div className="alert alert-secondary small">{view.blocked}</div>}

      {/* The rail: every step, the current one open. */}
      <ol className="pb-checklist mt-2 mb-0">
        {view.steps.map((step, i) => {
          const here = step.key === current;
          const busyHere = here && phase.kind === 'running';
          const isDone = runAt >= 0 ? i < runAt : step.mark === 'done';
          return (
            <li key={step.key}>
              <Dot mark={isDone ? 'done' : here && phase.kind === 'failed' ? 'failed' : busyHere || (here && step.mark === 'waiting') ? 'busy' : here ? 'current' : 'todo'} n={i + 1} />
              <div className="flex-grow-1" style={{ minWidth: 0 }}>
                <div className={`pb-step-title ${isDone ? 'done' : ''}`}>{step.title}</div>
                {here && (
                  <div className="mt-1">
                    <div className="pb-step-detail">{ABOUT[step.key]}</div>
                    {phase.kind === 'running' && <LiveLine announce={phase.announce} detail={phase.detail} />}
                    {phase.kind === 'failed' && <FailureBox title={phase.title} raw={phase.raw} logs={phase.logs} said={phase.said} onRetry={() => void start()} />}
                    {step.key === 'margin' && step.mark === 'waiting' && phase.kind === 'idle' && <div className="small pb-muted mt-1">The USDC is on its way to Hyperliquid. Press Continue once you are back: the page waits for it and goes on.</div>}
                    {step.key === 'margin' && marginByHand && answer && phase.kind !== 'running' && (
                      <div className="mt-2">
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => setMovingMargin(true)}>
                          Move USDC to Hyperliquid
                        </button>
                        <div className="form-text">
                          Your account owes our pool, so moving USDC out of it needs a risk check first. This box runs the check and the move.
                          {marginHint ? ` Move ${formatUsd(marginHint)} or more.` : ''} Once it has arrived, the page goes on to the short.
                        </div>
                        {movingMargin && (
                          <Drawer title="Move USDC to Hyperliquid" onClose={() => { setMovingMargin(false); data.reloadAll(); }}>
                            <MoveUsdc client={client} answer={answer} hl={data.hl} reloadHl={data.reloadHl} previewEnabled={false} bare />
                          </Drawer>
                        )}
                      </div>
                    )}
                    {step.key === 'aave' && atAaveChoice && answer && state && ether && phase.kind !== 'running' && (
                      <div className="mt-2">
                        <div className="d-flex flex-wrap gap-2">
                          <button type="button" className="btn btn-primary btn-sm" disabled={held(answer, 'ETH') === 0n} onClick={() => setMovingEther(true)}>
                            Move {ownEtherAmount(held(answer, 'ETH'), ether.decimals)} ETH to Aave’s chain
                          </button>
                          <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => void start({ faucet: true })}>
                            Use the faucet’s test collateral
                          </button>
                          <button type="button" className="btn btn-link btn-sm" onClick={() => setSkipAave(true)}>
                            Skip Aave
                          </button>
                        </div>
                        <div className="form-text">
                          Your own ETH arrives at the account’s address there as WETH, and Aave lends against it. {etherCapWords(etherPrice)} Without Aave, the loan comes from the other sources.
                        </div>
                        {movingEther && (
                          <Drawer title={MOVES['ether-out'].title} onClose={() => { setMovingEther(false); data.reloadAll(); }}>
                            <MoveBox which="ether-out" client={client} answer={answer} lender={data.lender} reloadLender={data.reloadLender} prices={{ btc: btcPrice, eth: etherPrice }} initial={ownEtherAmount(held(answer, 'ETH'), ether.decimals)} />
                          </Drawer>
                        )}
                      </div>
                    )}
                    {step.key === 'loan' && step.mark === 'current' && answer && state && phase.kind !== 'running' && (
                      <div className="mt-2">
                        <LoanBox
                          client={client}
                          answer={answer}
                          lender={data.lender}
                          coin={coin}
                          coinValue={valueMicro(heldUnits, token!.decimals, token!.price)}
                          estimate={data.estimate}
                          poolRateBp={data.rateBp}
                          previewEnabled={data.previewEnabled}
                          paused={data.paused}
                          reload={data.reloadAll}
                          would={data.would}
                          rheaTakesCoin={Boolean(data.rheaCollateral?.includes(token!.id))}
                        />
                        {active && (
                          <button type="button" className="btn btn-link btn-sm p-0 mt-2" onClick={() => remember(null)}>
                            Finish without a new loan
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {/* A failure before any step could be named (the first read of the account). */}
      {phase.kind === 'failed' && !view.steps.some((s) => s.key === current) && <FailureBox title={phase.title} raw={phase.raw} logs={phase.logs} said={phase.said} onRetry={() => void start()} />}

      {/* The loan's steps as the keeper runs them, while they run and once they have. */}
      {answer && state && (atLoan || again) && (
        <FundingPlan accountId={answer.account_id} funding={data.lender?.funding} pending={state.pending} height={answer.block_height} evm={data.lender?.evm} ownEvm={state.evm} isOwner={client.isOwner} onChanged={data.reloadAll} balances={answer.balances} />
      )}

    </Card>
  );
}

function Card({ title = 'Open a basis trade', children }: { title?: string; children: ReactNode }) {
  return (
    <section className="pb-card mb-4" aria-labelledby="basis-open-title">
      <h2 id="basis-open-title" className="pb-card-title">
        {title}
      </h2>
      {children}
    </section>
  );
}
