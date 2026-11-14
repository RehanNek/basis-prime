'use client';
// The Borrow page (INTERFACES.md 49.1 point 8): borrowing and repaying on the one page. On top, what the account can
// borrow now and the rate, an amount with a Max, where it would come from, and one Borrow button. Under it, what is
// owed, with one Repay button and "Repay everything". The figures' words are lib/borrow-page.ts.
// The app's third shape (INTERFACES.md 50.1 point 2): the lenders' cards ("Aave on Base Sepolia", "Rhea on NEAR") live
// here, under what is owed. A card's Repay picks that lender in the repay form above it; "Take collateral back" opens
// its side panel, and so do the moves those two offer on testnet (send USDC to Aave's chain, bring the bitcoin home).
// From before: PLAN.md 5.8 (which limit sets the most, what Rhea alone would lend, the carry; Rhea's terms live from
// GET /api/rhea, with the 3 Nov figures when that doesn't answer), and Phase 6, stage 2 (INTERFACES.md 29): an account
// whose config has lenders borrows through `fund`, with the loan's steps, and repays its dearest source first.
import { useRef, useState } from 'react';

import { AccountPicker } from '@/components/account-picker';
import { CheckFlow } from '@/components/check-flow';
import { Drawer } from '@/components/drawer';
import { LenderCards } from '@/components/home/lenders';
import { MoveBox } from '@/components/home/moves';
import { BorrowBox, LenderWithdrawBox, RepayBox } from '@/components/home/panels';
import { ApiProblem, NotDeployed, WalletGate } from '@/components/notices';
import { SendWindowNotice } from '@/components/send-window-notice';
import { TxStatus } from '@/components/tx-status';
import { NetworkId, UsdcToken } from '@/config';
import { useApi } from '@/hooks/use-api';
import { useClientAccount, type ClientAccount } from '@/hooks/use-client-account';
import { useLenderAccount } from '@/hooks/use-lender-account';
import { useNow } from '@/hooks/use-now';
import { useOwnSettings } from '@/hooks/use-own-settings';
import { useTx } from '@/hooks/use-tx';
import {
  CONFIG_PATH,
  hlPath,
  marketsPath,
  POOL_PATH,
  RHEA_PATH,
  type AccountAnswer,
  type ConfigAnswer,
  type FundingSource,
  type LenderName,
  type MarketsAnswer,
  type PoolAnswer,
  type RheaAnswer,
} from '@/lib/api';
import { borrowable, type Borrowable } from '@/lib/borrow';
import { borrowHeadline, checkAgeWords, everythingLabel, everythingWords, owedAfter, oweHeadline } from '@/lib/borrow-page';
import { carry, rheaAlone, rheaTerms } from '@/lib/carry';
import { borrowEstimate, rateFor } from '@/lib/cockpit';
import { canUseLenders, lenderPositions, postedWord, sourceName, TARGET_CUSHION_BP, wouldPostWord } from '@/lib/funding';
import { hlSummary, holdsLoan, type HlAnswer } from '@/lib/hl';
import { loanView } from '@/lib/loan';
import { etherToken, MOVES, type MoveKey } from '@/lib/moves';
import { borrowTx, repayTx } from '@/lib/tx';
import { formatBp, formatDollars, formatUnits, formatUsd, parseUnits } from '@/lib/units';
import { freshness } from '@/lib/verdict';

export function BorrowView() {
  return (
    <main className="pb-container pb-page" style={{ maxWidth: 960 }}>
      <h1 className="h3">Borrow</h1>
      <p className="lead">Borrow USDC against your whole account, and repay it, on this one page.</p>
      <WalletGate>
        <BorrowBody />
      </WalletGate>
    </main>
  );
}

function BorrowBody() {
  const client = useClientAccount();
  const pool = useApi<PoolAnswer>(POOL_PATH, 15_000);
  const config = useApi<ConfigAnswer>(CONFIG_PATH);
  const now = useNow(5_000);
  const { answer } = client;
  const limit = answer?.state && pool.data?.deployed ? headroom(answer, pool.data, now) : null;
  const lender = useLenderAccount(answer?.state ? answer.account_id : null);
  const previewEnabled = config.data?.preview_enabled ?? false;
  const funded = canUseLenders(lender.data);
  // INTERFACES.md 51.1: what Rhea would take from this account, by its own settings: bitcoin for an account from
  // before 14 Nov, and ether too for one made since that holds test ETH.
  const own = useOwnSettings(answer?.state ? answer.account_id : null);
  const would = {
    rhea: wouldPostWord(
      own.rheaCollateral,
      (answer?.balances ?? []).map((b) => ({ id: b.token, symbol: b.symbol })),
      (id) => BigInt(answer?.balances.find((b) => b.token === id)?.amount ?? '0') > 0n,
    ),
  };
  // The lenders' cards (INTERFACES.md 50.1 point 2), and what their buttons open.
  const positions = lenderPositions(lender.data);
  // What the account can borrow now, as Home's tile works it out: the engine's own answer from a check of the last
  // minute, else the last check's credit line less everything owed, and never more than the pool's own limits.
  const stored = answer?.state?.verdict ?? null;
  const owed = loanView({ poolDebt: BigInt(answer?.debt ?? answer?.state?.loan.principal ?? '0'), poolRateBp: null, lenders: positions }).total;
  const estimate =
    answer?.state && pool.data?.deployed
      ? borrowEstimate({
          pool: pool.data.pool,
          params: pool.data.params,
          borrower: answer.borrower,
          verdict: stored?.verdict ?? null,
          live: Boolean(limit?.live && stored && 'borrow' in stored.intent),
          debt: owed,
          nowNs: BigInt(now) * 1_000_000n,
        })
      : null;
  const [panel, setPanel] = useState<{ kind: 'take-back'; lender: LenderName } | { kind: MoveKey } | null>(null);
  // The lender a card's Repay button picked: the repay form opens on it.
  const [repayFirst, setRepayFirst] = useState<FundingSource | null>(null);
  const oweCard = useRef<HTMLElement>(null);
  // Stage 4: the moves between NEAR and Aave's chain run through our 1Click stand-in, so they are testnet's alone.
  const onMove = NetworkId === 'testnet' && client.isOwner ? (key: MoveKey) => setPanel({ kind: key }) : undefined;
  // INTERFACES.md 51.2: on an account whose coin is test ETH (it lists it, holds some and holds no bitcoin), WETH
  // taken back from Aave goes home as ETH; on any other, as bitcoin, as before.
  const holdsOf = (symbol: string) => BigInt(answer?.balances.find((b) => b.symbol === symbol)?.amount ?? '0');
  const etherHome = etherToken(answer?.balances) !== null && holdsOf('ETH') > 0n && holdsOf('nBTC') === 0n;
  const markets = useApi<MarketsAnswer>(answer?.state ? marketsPath(answer.account_id) : null, 60_000);
  const priceOf = (coin: string) => {
    const market = markets.data?.coins.find((c) => c.coin === coin)?.testnet;
    const price = Number(market?.oracle_px ?? market?.mark_px ?? NaN);
    return Number.isFinite(price) ? price : null;
  };
  const poolRateBp = answer?.state && pool.data?.deployed ? rateFor(pool.data.pool, answer.borrower?.tier ?? answer.state.verdict?.verdict.tier) : null;
  // An account whose pause lifts early (INTERFACES.md 50.2) isn't held back: its check is what lifts the pause.
  const paused = answer?.state ? holdsLoan(answer.state.hl, now) : false;

  return (
    <>
      <ApiProblem error={client.error ?? pool.error} />
      <AccountPicker name={client.name} problem={client.problem} onName={client.setName} answer={answer} owner={client.owner} errorCode={client.errorCode} mine={client.mine} finding={client.finding} />
      {answer && <NotDeployed contracts={answer.not_deployed} what="Borrowing opens once the pool is live on testnet." />}
      {answer && !answer.exists && <div className="alert alert-secondary small">Create the account on the Account page first.</div>}
      {answer?.state && (
        <>
          <SendWindowNotice hl={answer.state.hl} accountId={answer.account_id} reload={client.reload} onNewName={client.setName} />
          <section className="card mb-3">
            <div className="card-header fw-semibold">Borrow</div>
            <div className="card-body small">
              <p className="mb-2">
                {/* Without a check from the last minute the figure is a guide: the engine's answer sets it when Borrow is pressed. */}
                <span className="fw-semibold">
                  {estimate && estimate.amount === null
                    ? 'The risk engine works out what you can borrow when you press Borrow.'
                    : borrowHeadline({ canBorrow: estimate?.amount ?? null, rateBp: poolRateBp, exact: estimate?.basis === 'engine' })}
                </span>{' '}
                {estimate && estimate.basis !== 'engine' && (estimate.amount ?? 0n) > 0n && 'The risk engine sets the exact figure when you press Borrow. '}
                {funded ? 'That is our pool’s rate; when part of a loan comes from a lender, the rate for your amount shows under it.' : 'The USDC arrives in your account.'}
              </p>
              {funded ? (
                // An account that can use lenders: one amount, the engine picks the sources, and the keeper runs the steps.
                <BorrowBox client={client} answer={answer} estimate={estimate?.amount ?? null} previewEnabled={previewEnabled} paused={paused} lender={lender.data} reloadLender={lender.reload} would={would} />
              ) : (
                <BorrowForm client={client} answer={answer} limit={limit?.result ?? null} most={estimate?.amount ?? null} paused={paused} />
              )}
              {limit && <Limits result={limit.result} />}
            </div>
          </section>
          <section className="card mb-3" ref={oweCard} style={{ scrollMarginTop: '5rem' }}>
            <div className="card-header fw-semibold">What you owe</div>
            <div className="card-body small">
              {funded || positions.length > 0 ? (
                // Remade when a lender's card picks that lender, so the form opens on it.
                <RepayBox
                  key={repayFirst ?? 'dearest'}
                  client={client}
                  answer={answer}
                  lender={lender.data}
                  poolRateBp={poolRateBp}
                  reloadLender={lender.reload}
                  first={repayFirst}
                  onSendUsdc={onMove ? () => onMove('usdc-out') : undefined}
                />
              ) : (
                <RepayForm client={client} answer={answer} rateBp={poolRateBp} />
              )}
            </div>
          </section>
          {positions.length > 0 && (
            <>
              <h2 className="h5 mt-4 mb-1">Your lenders</h2>
              <p className="small text-body-secondary mb-3">What each lender holds for you and what you owe it. Repay one, or take collateral back from it.</p>
              <LenderCards
                positions={positions}
                targetBp={Math.max(TARGET_CUSHION_BP, lender.data?.permission?.min_hf_bp ?? 0)}
                postedWord={postedWord(positions[0]?.held)}
                actions={{
                  isOwner: client.isOwner,
                  onRepay: (l: LenderName) => {
                    setRepayFirst(l);
                    oweCard.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  },
                  onTakeBack: (l: LenderName) => setPanel({ kind: 'take-back', lender: l }),
                }}
                pricing={lender.data?.pricing?.pricing}
                asOf={checkAgeWords(lender.data?.verdict_blk, answer.block_height)}
              />
            </>
          )}
          <Compare answer={answer} />
          {panel && (
            <Drawer title={panel.kind === 'take-back' ? `Take collateral back from ${sourceName(panel.lender)}` : MOVES[panel.kind].title} onClose={() => setPanel(null)}>
              {panel.kind === 'take-back' ? (
                <LenderWithdrawBox
                  client={client}
                  answer={answer}
                  lender={lender.data}
                  which={panel.lender}
                  previewEnabled={previewEnabled}
                  reloadLender={lender.reload}
                  onBringHome={onMove ? () => onMove(etherHome ? 'ether-home' : 'bitcoin-home') : undefined}
                  homeLabel={MOVES[etherHome ? 'ether-home' : 'bitcoin-home'].title}
                />
              ) : (
                <MoveBox key={panel.kind} which={panel.kind} client={client} answer={answer} lender={lender.data} previewEnabled={previewEnabled} reloadLender={lender.reload} prices={{ btc: priceOf('BTC'), eth: priceOf('ETH') }} />
              )}
            </Drawer>
          )}
        </>
      )}
    </>
  );
}

/** The pool's limits for this account, with W* from its stored verdict while that could still back a borrow. */
function headroom(answer: AccountAnswer, pool: Extract<PoolAnswer, { deployed: true }>, now: number) {
  const stored = answer.state!.verdict;
  const live = stored && stored.verdict.nonce === answer.state!.counter && freshness(stored.verdict.blk, answer.block_height).fresh ? stored.verdict : null;
  return { live, result: borrowable({ pool: pool.pool, params: pool.params, borrower: answer.borrower, verdict: live, nowNs: BigInt(now) * 1_000_000n }) };
}

/** RISK_ENGINE.md 7.2: the most is the smallest of the engine's own figure and the pool's limits. A detail line names which, and lists them all. */
function Limits({ result }: { result: Borrowable }) {
  return (
    <details className="form-text mt-2">
      <summary>What sets the most you can borrow</summary>
      <p className="mb-1 mt-1">Right now it is {result.binding.label}.</p>
      <table className="table table-sm mb-0">
        <tbody>
          {result.limits.map((limit) => (
            <tr key={limit.label} className={limit === result.binding ? 'fw-semibold' : ''}>
              <td>{limit.label}</td>
              <td className="text-end font-monospace">{formatUsd(limit.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function BorrowForm({ client, answer, limit, most, paused }: { client: ClientAccount; answer: AccountAnswer; limit: Borrowable | null; most: bigint | null; paused: boolean }) {
  const [text, setText] = useState('');
  let units: string | null = null;
  let problem: string | null = null;
  try {
    units = text ? parseUnits(text, UsdcToken.decimals) : null;
    if (units === '0') {
      units = null;
      problem = 'Enter an amount above 0';
    }
  } catch (error) {
    problem = (error as Error).message;
  }
  // The pool's own limits hold whatever the risk engine says: say so before the check, which would end in a refusal.
  const poolBinds = units && limit && limit.binding.source === 'pool' && BigInt(units) > limit.max;

  return (
    <>
      <label className="form-label small text-body-secondary mb-1" htmlFor="borrow-page-amount">
        How much to borrow
      </label>
      <div className="input-group input-group-sm mb-2" style={{ maxWidth: 320 }}>
        <span className="input-group-text">$</span>
        <input id="borrow-page-amount" className="form-control" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="0.00" autoComplete="off" />
        <span className="input-group-text">USDC</span>
        {most !== null && most > 0n && (
          <button type="button" className="btn btn-outline-secondary" onClick={() => setText(formatUnits((most / 10_000n) * 10_000n, UsdcToken.decimals))}>
            Max
          </button>
        )}
      </div>
      {poolBinds && (
        <div className="alert alert-warning py-1 px-2">
          That is more than you can borrow now: {limit.binding.label} leaves room for {formatUsd(limit.max)}. Press Max, or type less.
        </div>
      )}
      <CheckFlow
        account={answer}
        fetchedAt={client.fetchedAt}
        reload={client.reload}
        // While borrowing is paused the account would refuse the borrow, so the check isn't asked for.
        intent={units && !paused ? { borrow: { amount: units } } : null}
        inputProblem={paused ? 'Borrowing is paused for a moment: a transfer out of Hyperliquid can still be posted. Try again in a few minutes.' : problem}
        checkLabel="Borrow"
        act={units && !paused ? { label: `Borrow ${formatUsd(units)}`, use: { borrow: { amount: units } }, tx: borrowTx(answer.account_id, units) } : null}
        retarget={(allowed) => ({ label: `Borrow ${formatUsd(allowed)}`, use: { borrow: { amount: allowed.toString() } }, tx: borrowTx(answer.account_id, allowed.toString()) })}
        isOwner={client.isOwner}
        showStored
      />
    </>
  );
}

function RepayForm({ client, answer, rateBp }: { client: ClientAccount; answer: AccountAnswer; rateBp: number | null }) {
  const [text, setText] = useState('');
  const tx = useTx();
  const debt = BigInt(answer.debt ?? answer.state!.loan.principal);
  const usdc = BigInt(answer.balances.find((b) => b.token === UsdcToken.id)?.amount ?? '0');
  // Interest accrues every second and the pool returns anything above the debt, so "everything" sends a little extra.
  const all = debt === 0n ? 0n : [usdc, debt + debt / 1_000n + 1_000_000n].reduce((a, b) => (a < b ? a : b));

  let units: string | null = null;
  let problem: string | null = null;
  try {
    units = text ? parseUnits(text, UsdcToken.decimals) : null;
    if (units === '0') problem = 'Enter an amount above 0';
    else if (units && BigInt(units) > usdc) problem = `Your account holds ${formatUsd(usdc)} of USDC. Type that or less, or add funds first.`;
  } catch (error) {
    problem = (error as Error).message;
  }
  const ready = units && !problem ? units : null;
  const deleverage = answer.state!.verdict?.verdict.action === 'DELEVERAGE';
  const mayRepay = client.isOwner || deleverage;
  const repay = async (amount: string) => {
    const outcome = await tx.run(`Repay ${formatUsd(amount)}`, repayTx(answer.account_id, amount));
    if (outcome) setText('');
    client.reload();
  };

  if (debt === 0n) {
    return (
      <>
        <p className="text-body-secondary mb-0">{oweHeadline({ owed: 0n, rateBp })} When you borrow, the loan shows here with its Repay button.</p>
        <TxStatus record={tx.last} busy={tx.busy} />
      </>
    );
  }
  return (
    <>
      <p className="mb-2">
        <span className="fw-semibold">{oweHeadline({ owed: debt, rateBp })}</span> Repay any part of it at any time.
      </p>
      <div className="d-flex flex-wrap align-items-start gap-2 mb-1">
        <div className="input-group input-group-sm" style={{ maxWidth: 280 }}>
          <span className="input-group-text">$</span>
          <input className="form-control" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="0.00" aria-label="USDC to repay" autoComplete="off" />
          <span className="input-group-text">USDC</span>
        </div>
        <button type="button" className="btn btn-sm btn-primary" disabled={!ready || !mayRepay || tx.busy} onClick={() => ready && void repay(ready)}>
          Repay {ready ? formatUsd(ready) : ''}
        </button>
        <button type="button" className="btn btn-sm btn-outline-primary" disabled={all === 0n || !mayRepay || tx.busy} onClick={() => void repay(all.toString())}>
          {everythingLabel()}
        </button>
      </div>
      <div className="form-text">{everythingWords({ pays: all, left: owedAfter([{ source: 'pool', debt }], [{ source: 'pool', amount: all }]) })}</div>
      {problem && <div className="form-text text-danger">{problem}</div>}
      {!mayRepay && <div className="form-text">Only the owner can repay, unless the account is unwinding.</div>}
      <details className="form-text">
        <summary>How repaying works</summary>
        The account pays the pool from its own USDC, and the pool sends back anything above what is owed. Repaying needs no check and is never paused.
      </details>
      <TxStatus record={tx.last} busy={tx.busy} />
    </>
  );
}

/**
 * PLAN.md 5.8: what Rhea alone would lend against the nBTC, next to our line, and the carry: the funding the hedge
 * earns on Hyperliquid against the interest the loan costs, at today's rates.
 */
function Compare({ answer }: { answer: AccountAnswer }) {
  const hl = useApi<HlAnswer>(hlPath(answer.account_id), 30_000);
  const markets = useApi<MarketsAnswer>(marketsPath(answer.account_id), 60_000);
  const rhea = useApi<RheaAnswer>(RHEA_PATH, 5 * 60_000);
  const now = useNow(60_000);
  const terms = rheaTerms(rhea.data, now);
  const verdict = answer.state!.verdict?.verdict ?? null;
  const nbtc = verdict?.pool?.hold?.nBTC;
  const view = hl.data?.account_id === answer.account_id ? hl.data.hyperliquid : null;
  const positions = view ? hlSummary(view).positions : [];
  const funding = Object.fromEntries(
    (markets.data?.coins ?? []).filter((c) => c.testnet?.funding != null).map((c) => [c.coin, Number(c.testnet!.funding)]),
  );
  const debtUsd = Number(BigInt(answer.debt ?? answer.state!.loan.principal)) / 1e6;
  const rateBp = verdict?.rate_bp ?? null;
  const result = rateBp !== null ? carry({ positions, fundingHourly: funding, debtUsd, rateBp }) : null;

  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">Compared with Rhea alone, and the carry</div>
      <div className="card-body small">
        <h3 className="h6">Rhea alone</h3>
        {nbtc !== undefined && verdict ? (
          <p>
            Against the account&apos;s nBTC alone ({formatUsd(nbtc)}), Rhea would lend up to <strong>{formatUsd(rheaAlone(BigInt(Math.trunc(nbtc)), terms.nbtcLtvBp))}</strong>
            {' '}({formatBp(terms.nbtcLtvBp)} of it), at about {formatBp(terms.usdcBorrowBp)} a year, with no buffer: liquidation starts at the
            borrow limit. Our pool counts the whole hedged book: a credit line of <strong>{formatUsd(verdict.credit.line)}</strong> at{' '}
            {formatBp(verdict.rate_bp)} a year, with a safety buffer before any unwind.
          </p>
        ) : (
          <p className="text-body-secondary">Run a check first: the comparison uses its value for the nBTC.</p>
        )}
        <p className="text-body-secondary">
          {terms.source === 'live' ? <span className="badge text-bg-success me-1">Live</span> : <span className="badge text-bg-secondary me-1">3 Nov figures</span>}
          {terms.words}
        </p>

        <h3 className="h6">Carry</h3>
        {result && (positions.length > 0 || debtUsd > 0) ? (
          <>
            <p className="mb-1">
              At today&apos;s rates, a year of funding on the Hyperliquid positions comes to <strong>{formatDollars(result.fundingYearUsd)}</strong>,
              and the loan&apos;s interest to <strong>{formatDollars(result.interestYearUsd)}</strong>: net{' '}
              <strong className={result.netYearUsd < 0 ? 'text-danger' : 'text-success'}>{formatDollars(result.netYearUsd)}</strong> a year.
            </p>
            {result.missing.length > 0 && <p className="mb-1 text-warning-emphasis">No funding rate for {result.missing.join(', ')}: left out.</p>}
            <p className="text-body-secondary mb-0">
              Funding changes every hour, and testnet&apos;s runs about three times mainnet&apos;s (BTC: about 36% a year against 11% on 5 Nov,
              research/day1.md 12), so this carry looks better than mainnet&apos;s would.
            </p>
          </>
        ) : (
          <p className="text-body-secondary mb-0">No loan and no Hyperliquid positions yet: nothing to carry.</p>
        )}
      </div>
    </section>
  );
}
