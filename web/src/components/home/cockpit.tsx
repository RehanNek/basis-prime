'use client';
// Home for a signed-in client (option D, 9 Nov): the setup checklist on top until setup is done, then the numbers
// first (what you can borrow, what you owe, what you're worth), the health bar, where the money is, and the latest
// activity. The app's third shape (INTERFACES.md 50.1 point 2): the row of action buttons and the "Start a basis
// trade" card are gone, and the lenders' cards live on the Borrow page. What Home still opens in a side panel: Repay
// and Add funds from the danger alert, and the address card's own actions. Phase 6, stage 2 (INTERFACES.md 29): one loan total over our pool and every
// lender, a loan's steps as the keeper runs them, and a credit the pool owes back. Stage 3 (INTERFACES.md 33): Aave is a
// lender like Rhea, with the account's own address on Base Sepolia in a card of its own, and on testnet a setup step
// that gets it test collateral.
import Link from 'next/link';
import { useCallback, useState } from 'react';

import { Drawer } from '@/components/drawer';
import { Dot } from '@/components/flow-progress';
import { EvmCard } from '@/components/home/evm-card';
import { PortfolioCard } from '@/components/home/portfolio';
import { MoveBox } from '@/components/home/moves';
import { FundingPlan } from '@/components/home/funding-plan';
import { AddFundsBox, ClaimCredit, EvmWithdrawBox, LenderDeposits, RepayBox } from '@/components/home/panels';
import { SetupCard } from '@/components/home/setup-card';
import { useSetupActions } from '@/components/home/setup-actions';
import { PendingMoves } from '@/components/pending-moves';
import { ApiProblem, NotDeployed } from '@/components/notices';
import { SendWindowNotice } from '@/components/send-window-notice';
import { accountUrl, FactoryContract, NetworkId, Tokens, txUrl } from '@/config';
import { useApi } from '@/hooks/use-api';
import { useClientAccount, type ClientAccount } from '@/hooks/use-client-account';
import { useLenderAccount } from '@/hooks/use-lender-account';
import { useNow } from '@/hooks/use-now';
import { activityLines, MONEY_KINDS } from '@/lib/activity';
import {
  activityPath,
  CONFIG_PATH,
  drillPathFor,
  EVM_GAS_PATH,
  hlPath,
  marketsPath,
  POOL_PATH,
  type AccountAnswer,
  type ActivityAnswer,
  type ConfigAnswer,
  type DrillAnswer,
  type EvmGasInfo,
  type MarketsAnswer,
  type PoolAnswer,
} from '@/lib/api';
import { ago, borrowEstimate, healthView, netWorth, positionWords, rateFor, type BorrowEstimate } from '@/lib/cockpit';
import { EVM_CHAIN_NAME, tokenAmount, walletUsd } from '@/lib/evm';
import { lenderPositions, settingsPostedWord, sourceName, toMicro } from '@/lib/funding';
import { hlSummary, holdsLoan, loanOpen, type HlAnswer } from '@/lib/hl';
import { loanView, type LoanView } from '@/lib/loan';
import { etherToken, MOVES, type MoveKey } from '@/lib/moves';
import { accountsToOffer } from '@/lib/picker';
import { configuredLenders, defaultPermission } from '@/lib/permission';
import { held, openingView, setupView, testCollateralStep } from '@/lib/setup';
import type { StoredVerdict } from '@/lib/types';
import { displayUnits, formatBp, formatDollars, formatUsd } from '@/lib/units';
import { bindingWords, freshness, SECONDS_PER_BLOCK } from '@/lib/verdict';
import { useSession } from '@/providers/session-provider';

type Panel = 'repay' | 'add' | 'send-out' | MoveKey;

const PANEL_TITLES: Record<Panel, string> = {
  repay: 'Repay',
  add: 'Add funds',
  'send-out': `Send a token out of your address on ${EVM_CHAIN_NAME}`,
  // Stage 4, testnet: the four moves between NEAR and Aave's chain.
  'bitcoin-out': MOVES['bitcoin-out'].title,
  'loan-home': MOVES['loan-home'].title,
  'usdc-out': MOVES['usdc-out'].title,
  'bitcoin-home': MOVES['bitcoin-home'].title,
  // INTERFACES.md 51.2: the client's own ETH, for an account whose settings list test ETH.
  'ether-out': MOVES['ether-out'].title,
  'ether-home': MOVES['ether-home'].title,
};

const MOVE_KEYS = Object.keys(MOVES) as MoveKey[];
const isMove = (panel: Panel): panel is MoveKey => (MOVE_KEYS as string[]).includes(panel);

const HIDE_KEY = 'pb:setup-hidden';

function readHidden(): Record<string, boolean> {
  try {
    return JSON.parse(window.localStorage.getItem(HIDE_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function Cockpit() {
  const client = useClientAccount();
  const session = useSession();
  const answer = client.answer;
  const state = answer?.state ?? null;
  const accountId = state ? answer!.account_id : null;
  const config = useApi<ConfigAnswer>(CONFIG_PATH);
  const pool = useApi<PoolAnswer>(POOL_PATH, 15_000);
  const hl = useApi<HlAnswer>(accountId ? hlPath(accountId) : null, 10_000);
  const markets = useApi<MarketsAnswer>(accountId ? marketsPath(accountId) : null, 60_000);
  const drill = useApi<DrillAnswer>(NetworkId === 'testnet' && accountId ? drillPathFor(accountId) : null, 60_000);
  // Phase 6: the account at each lender. Today's accounts have none, and a backend without the endpoint answers an
  // error, which shows as nothing: no cards, and the borrow panel as it was.
  const lender = useLenderAccount(accountId);
  const lenderData = lender.data;
  // Stage 3, testnet: whether the backend's gas helper is on, for an account whose config has Aave.
  const gasHelp = useApi<EvmGasInfo>(NetworkId === 'testnet' && (lenderData?.config_lenders ?? []).includes('aave') ? EVM_GAS_PATH : null, 60_000);
  const helperOn = gasHelp.data?.on;
  const now = useNow(5_000);
  const hlData = hl.data?.account_id === accountId ? hl.data : undefined;
  // The permission a new account is offered (INTERFACES.md 24): every lender the factory's config has, on the app's
  // default terms. Ticked off, the account opens without one.
  const offered = defaultPermission(configuredLenders(config.data?.factory_config));
  const [withPermission, setWithPermission] = useState(true);
  // Stage 3, testnet: "Get test collateral for Aave" can be passed over, to borrow without Aave.
  const [skipTestCollateral, setSkipTestCollateral] = useState(false);
  const actions = useSetupActions({
    accountId: client.accountId,
    owner: client.owner,
    name: client.name,
    permission: withPermission ? offered : null,
    skipTestCollateral,
    reloadAccount: client.reload,
    reloadHl: hl.reload,
    reloadLender: lender.reload,
  });
  const [hidden, setHidden] = useState<Record<string, boolean>>(readHidden);
  const [panel, setPanel] = useState<Panel | null>(null);
  const closePanel = useCallback(() => setPanel(null), []);
  const openPanel = (next: Panel) => setPanel(next);

  const hideKey = client.accountId ?? '';
  const setupHidden = Boolean(hidden[hideKey]);
  const setHide = (value: boolean) => {
    const next = { ...hidden, [hideKey]: value };
    setHidden(next);
    try {
      window.localStorage.setItem(HIDE_KEY, JSON.stringify(next));
    } catch {
      // Private mode: it stays hidden for this visit only.
    }
  };

  // ---------- the numbers ----------
  // `debt` is what the account owes our pool. The whole loan adds what it owes each lender, as its latest check read it.
  const debt = BigInt(answer?.debt ?? state?.loan.principal ?? '0');
  const positions = lenderPositions(lenderData);
  const poolLive = pool.data?.deployed ? pool.data : null;
  const rateBp = poolLive ? rateFor(poolLive.pool, answer?.borrower?.tier ?? state?.verdict?.verdict.tier) : null;
  const loan = loanView({ poolDebt: debt, poolRateBp: rateBp, lenders: positions, pricing: lenderData?.pricing?.pricing });
  const posted = positions.reduce((sum, p) => sum + toMicro(p.posted), 0n);
  const hasLoan = state ? loanOpen(state.loan) || loan.total > 0n : false;
  // A loan that came from a lender alone counts as borrowed too.
  const setup = setupView({
    signedIn: true,
    account: answer,
    hl: hlData,
    borrowed: loan.total > 0n,
    testCollateral: testCollateralStep({ testnet: NetworkId === 'testnet', lender: lenderData, skipped: skipTestCollateral, helperOn }),
  });
  // Stage 3: the account's address on Aave's chain, and what sits there.
  const evm = lenderData?.evm?.address ? lenderData.evm : null;
  const stored: StoredVerdict | null = state?.verdict ?? null;
  const verdict = stored?.verdict ?? null;
  const height = answer ? answer.block_height + Math.floor((now - client.fetchedAt) / (SECONDS_PER_BLOCK * 1000)) : 0;
  const live = Boolean(stored && state && verdict && verdict.nonce === state.counter && freshness(verdict.blk, height).fresh && 'borrow' in stored.intent);
  // The verdict's credit line counts the whole debt, lenders' loans included, so the estimate takes the whole debt off it.
  const estimate: BorrowEstimate | null =
    state && poolLive ? borrowEstimate({ pool: poolLive.pool, params: poolLive.params, borrower: answer!.borrower, verdict, live, debt: loan.total, nowNs: BigInt(now) * 1_000_000n }) : null;
  const btc = markets.data?.coins.find((c) => c.coin === 'BTC')?.testnet;
  const btcPrice = Number(btc?.oracle_px ?? btc?.mark_px ?? NaN);
  const eth = markets.data?.coins.find((c) => c.coin === 'ETH')?.testnet;
  const ethPrice = Number(eth?.oracle_px ?? eth?.mark_px ?? NaN);
  const near = markets.data?.coins.find((c) => c.coin === 'NEAR')?.testnet;
  const nearPrice = Number(near?.oracle_px ?? near?.mark_px ?? NaN);
  // What sits at the address on Aave's chain, in dollars: null when a token there can't be priced.
  const prices = { btc: Number.isFinite(btcPrice) ? btcPrice : null, eth: Number.isFinite(ethPrice) ? ethPrice : null };
  const atAddress = walletUsd(evm, prices);
  // Stage 4: the moves between NEAR and Aave's chain run through our 1Click stand-in, so they are testnet's alone.
  const onMove = NetworkId === 'testnet' && client.isOwner ? (key: MoveKey) => openPanel(key) : undefined;
  const ratioBp = drill.data?.account_ratio?.ratio?.bp ?? drill.data?.ratio?.bp ?? 10_000;
  const summary = hlData?.hyperliquid ? hlSummary(hlData.hyperliquid) : null;
  const worth = answer
    ? netWorth({
        balances: answer.balances,
        tokens: Tokens,
        // An account made since 13 Nov may also hold test ETH, wNEAR and USDT (INTERFACES.md 49.6), bought on Spot.
        prices: {
          USDC: 1,
          USDT: 1,
          nBTC: Number.isFinite(btcPrice) ? (btcPrice * ratioBp) / 10_000 : null,
          ETH: Number.isFinite(ethPrice) ? ethPrice : null,
          wNEAR: Number.isFinite(nearPrice) ? nearPrice : null,
        },
        // An address holding something the page can't price leaves the total unknown rather than wrong.
        hlEquity: atAddress === null ? null : hlData && !hlData.address ? 0 : (summary?.equity ?? null),
        debt: loan.total,
        atLenders: Number(posted) / 1e6 + (atAddress ?? 0),
      })
    : null;
  const health = healthView(verdict, hasLoan);
  const checkedAgo = verdict ? ago(now - Math.max(0, height - verdict.blk) * SECONDS_PER_BLOCK * 1000, now) : null;
  // An account whose pause lifts early (INTERFACES.md 50.2) isn't held back: its check is what lifts the pause.
  const paused = state ? holdsLoan(state.hl, now) : false;
  const previewEnabled = config.data?.preview_enabled ?? false;
  // The checklist needs both reads: an account's hedge is only known once Hyperliquid has answered.
  // Without a usable name there is nothing to read: the checklist shows at once, to pick one.
  const settled = !client.accountId || Boolean(answer && (!answer.state || hlData || hl.error));
  // Once seen unfinished, the checklist stays until closed, so its last step's "done" stays in view.
  // Home's checklist leads as far as the open account and then goes (lib/setup.ts, openingView).
  const opening = openingView(setup);
  const showSetup = settled && !opening.complete && !setupHidden;
  const danger = health.tone === 'bad' || health.tone === 'warn';

  return (
    <main className="pb-container pb-page">
      <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
        <h1 className="h3 mb-0 me-1">Your account</h1>
        {state && (
          <a href={accountUrl(answer!.account_id)} target="_blank" rel="noreferrer" className="pb-pill neutral text-break" title="On the explorer">
            {answer!.account_id} <i className="bi bi-box-arrow-up-right" style={{ fontSize: '0.7rem' }} aria-hidden="true" />
          </a>
        )}
        {/* With privacy on, another wallet's account is never named by its owner (INTERFACES.md 48.6). */}
        {state && !client.isOwner && <span className="pb-pill warn">{session.mode === 'off' ? `Owned by ${state.owner}` : 'Another wallet’s account'}: you can look, not act</span>}
        {setupHidden && !opening.complete && (
          <button type="button" className="btn btn-link btn-sm" onClick={() => setHide(false)}>
            Show the setup checklist
          </button>
        )}
        {state && <SwitchAccount client={client} />}
      </div>

      {/* Privacy level 1: the backend won't show another wallet's account. One line, and the way to another name. */}
      {client.errorCode === 'not_yours' && (
        <div className="alert alert-secondary d-flex flex-wrap align-items-center gap-2">
          <span>This name belongs to another wallet.</span>
          <SwitchAccount client={client} />
        </div>
      )}
      <ApiProblem error={client.error ?? config.error} />
      {answer && <NotDeployed contracts={answer.not_deployed} />}
      {state && <SendWindowNotice hl={state.hl} accountId={answer!.account_id} reload={client.reload} onNewName={client.setName} />}

      {!answer && !client.error && client.accountId && client.errorCode !== 'not_yours' && <Skeleton />}

      {/* The app's second shape (INTERFACES.md 49.1 point 4): Home opens with the portfolio. */}
      {state && answer && (
        <PortfolioCard
          accountId={answer.account_id}
          value={worth?.total ?? null}
          onNear={worth?.onNear ?? null}
          onHl={worth?.onHl ?? null}
          atLenders={atAddress === null ? null : Number(posted) / 1e6 + atAddress}
          owed={Number(loan.total) / 1e6}
        />
      )}
      {showSetup && (
        <SetupCard
          demoButton={false}
          client={client}
          answer={answer}
          view={opening}
          actions={actions}
          estimate={estimate?.amount ?? null}
          previewEnabled={previewEnabled}
          paused={paused}
          lender={lenderData}
          reloadLender={lender.reload}
          permission={{ offered, on: withPermission, onToggle: setWithPermission, posted: settingsPostedWord(config.data?.factory_config) }}
          onSkipTestCollateral={() => setSkipTestCollateral(true)}
          onMoveBitcoin={onMove ? () => onMove('bitcoin-out') : undefined}
          factoryLive={config.data?.deployed[FactoryContract]}
          onHide={() => setHide(true)}
        />
      )}

      {state && answer && (
        <>
          {danger && (
            <div className={`alert ${health.tone === 'bad' ? 'alert-danger' : 'alert-warning'} d-flex flex-wrap align-items-center gap-2`} role="alert">
              <i className="bi bi-exclamation-triangle" aria-hidden="true" />
              <span className="me-auto">{health.words}</span>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => openPanel('repay')} disabled={!hasLoan}>
                Repay
              </button>
              <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => openPanel('add')}>
                Add funds
              </button>
            </div>
          )}
          <ClaimCredit client={client} accountId={answer.account_id} lender={lenderData} reloadLender={lender.reload} />
          {/* USDC that a repayment above the debt left at a lender: the line that says so, and the way back. */}
          <LenderDeposits
            accountId={answer.account_id}
            lender={lenderData}
            onChanged={() => {
              client.reload();
              lender.reload();
            }}
            notice
          />
          <div className="pb-tiles mb-3">
            <div className="pb-tile hero">
              <div className="l">You can borrow now</div>
              <div className="v">{estimate?.amount != null ? formatUsd(estimate.amount) : '—'}</div>
              <div className="s">{estimate ? estimate.why : 'Reading the pool…'}</div>
            </div>
            <div className="pb-tile">
              <div className="l">You owe</div>
              <div className="v">{formatUsd(loan.total)}</div>
              <div className="s">{loan.total > 0n ? loan.words : rateBp !== null ? `At ${formatBp(rateBp)} a year, from the broker’s pool` : 'From the broker’s pool'}</div>
            </div>
            <div className="pb-tile">
              <div className="l">Net worth</div>
              <div className="v">{worth?.total != null ? formatDollars(worth.total) : '—'}</div>
              <div className="s">If everything were sold today and the loan repaid</div>
            </div>
          </div>

          {/* Moves through 1Click that the account lists as under way, with where each stands. */}
          <PendingMoves client={client} answer={answer} wallet={evm?.wallet} now={now} previewEnabled={previewEnabled} />

          {/* A loan on its way: its steps, until its 30 minutes are over or the plan is dropped. The borrow panel shows them too. */}
          <FundingPlan
            accountId={answer.account_id}
            funding={lenderData?.funding}
            pending={state.pending}
            height={answer.block_height}
            evm={lenderData?.evm}
            ownEvm={state.evm}
            isOwner={client.isOwner}
            onChanged={lender.reload}
            card
            balances={answer.balances}
          />

          <div className="pb-grid two mb-4">
            <HealthCard view={health} verdict={stored} checkedAgo={checkedAgo} accountId={answer.account_id} />
            <MoneyCard
              answer={answer}
              hl={hlData}
              summary={summary}
              worth={worth}
              loan={loan}
              posted={posted > 0n ? { amount: posted, at: positions.filter((p) => toMicro(p.posted) > 0n).map((p) => sourceName(p.l)) } : null}
              atAddress={evm ? evm.wallet.filter((t) => toMicro(t.amount) > 0n).map((t) => (t.symbol === 'USDC' && t.decimals === 6 ? `${formatUsd(t.amount)} USDC` : tokenAmount(t.amount, t))) : []}
              nbtcPrice={Number.isFinite(btcPrice) ? (btcPrice * ratioBp) / 10_000 : null}
            />
          </div>

          {/* The lenders' cards moved to the Borrow page (INTERFACES.md 50.1 point 2): one line says where. */}
          {positions.length > 0 && (
            <p className="small pb-muted mb-4">
              You have collateral or a loan with {positions.map((p) => sourceName(p.l)).join(' and ')}. <Link href="/borrow">The Borrow page</Link> shows each lender, and repays it or takes
              collateral back.
            </p>
          )}

          {evm && (
            <div className="mb-4">
              <EvmCard accountId={answer.account_id} evm={evm} isOwner={client.isOwner} gasHelp={helperOn === true} onSendOut={() => openPanel('send-out')} onMove={onMove} ether={etherToken(answer.balances) !== null} reload={lender.reload} />
            </div>
          )}

          <RecentActivity accountId={answer.account_id} now={now} />
        </>
      )}

      {panel && state && answer && (
        <Drawer title={PANEL_TITLES[panel]} onClose={closePanel}>
          {panel === 'repay' && <RepayBox client={client} answer={answer} lender={lenderData} poolRateBp={rateBp} reloadLender={lender.reload} onSendUsdc={onMove ? () => onMove('usdc-out') : undefined} />}
          {isMove(panel) && <MoveBox key={panel} which={panel} client={client} answer={answer} lender={lenderData} previewEnabled={previewEnabled} reloadLender={lender.reload} prices={prices} />}
          {panel === 'send-out' && <EvmWithdrawBox client={client} answer={answer} lender={lenderData} previewEnabled={previewEnabled} reloadLender={lender.reload} />}
          {panel === 'add' && <AddFundsBox client={client} answer={answer} />}
        </Drawer>
      )}
    </main>
  );
}

function Skeleton() {
  return (
    <div aria-busy="true">
      <div className="pb-tiles mb-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="pb-skeleton" style={{ height: 108 }} />
        ))}
      </div>
      <div className="pb-skeleton" style={{ height: 200 }} />
    </div>
  );
}

/** The account name is remembered per wallet; this changes it, for a wallet with more than one account. */
function SwitchAccount({ client }: { client: ClientAccount }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="btn btn-link btn-sm ms-auto" onClick={() => setOpen(true)}>
        Use another account
      </button>
    );
  }
  return (
    <div className="input-group input-group-sm ms-auto" style={{ maxWidth: 320 }}>
      {/* The wallet's own accounts, when it has more than one, are offered as the field's suggestions. */}
      <input className="form-control" value={client.name} onChange={(e) => client.setName(e.target.value)} aria-label="Account name" autoFocus spellCheck={false} list="own-accounts" />
      <datalist id="own-accounts">
        {accountsToOffer(client.mine).map((own) => (
          <option key={own} value={own} />
        ))}
      </datalist>
      <span className="input-group-text">.{FactoryContract}</span>
      <button type="button" className="btn btn-outline-secondary" onClick={() => setOpen(false)}>
        Done
      </button>
    </div>
  );
}

function HealthCard({ view, verdict, checkedAgo, accountId }: { view: ReturnType<typeof healthView>; verdict: StoredVerdict | null; checkedAgo: string | null; accountId: string }) {
  const v = verdict?.verdict;
  return (
    <section className="pb-card" aria-labelledby="health-title">
      <div className="d-flex align-items-center justify-content-between gap-2">
        <h2 id="health-title" className="pb-card-title mb-0">
          Health
        </h2>
        <span className={`pb-pill ${view.tone}`}>{view.label}</span>
      </div>
      <div className="pb-health-bar" aria-hidden="true">
        <div className="pb-health-zones">
          <div />
          <div />
          <div />
          <div />
        </div>
        {view.marker !== null && <div className="pb-health-marker" style={{ left: `${view.marker}%` }} />}
      </div>
      <div className="pb-health-labels" aria-hidden="true">
        <span>Safe</span>
        <span>Watch</span>
        <span>
          <span className="d-none d-sm-inline">Margin call</span>
          <span className="d-sm-none">Call</span>
        </span>
        <span>Unwind</span>
      </div>
      <p className="mt-3 mb-1">{view.words}</p>
      {checkedAgo && <div className="small pb-muted">From your latest check, {checkedAgo}.</div>}
      {v && (
        <details className="mt-2 small">
          <summary>Why?</summary>
          <dl className="pb-rows mt-2">
            <div>
              <dt>Equity, as the engine counts it</dt>
              <dd className="num">{formatUsd(v.eq)}</dd>
            </div>
            <div>
              <dt>Needed to borrow more</dt>
              <dd className="num">{formatUsd(v.im)}</dd>
            </div>
            <div>
              <dt>The safety line (margin call below it)</dt>
              <dd className="num">{formatUsd(v.mm)}</dd>
            </div>
            <div>
              <dt>Your credit line</dt>
              <dd>
                <span className="num">{formatUsd(v.credit.line)}</span>
                <span className="sub">Set by {bindingWords(v.credit.binding, v.tier)}</span>
              </dd>
            </div>
          </dl>
          {v.top.length > 0 && (
            <>
              <div className="pb-muted mt-2">The scenarios that hurt most:</div>
              <ol className="mb-1 ps-3">
                {v.top.map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ol>
            </>
          )}
          <Link href={`/risk?account=${encodeURIComponent(accountId)}`}>
            The full risk page <i className="bi bi-arrow-right" aria-hidden="true" />
          </Link>
        </details>
      )}
    </section>
  );
}

function MoneyCard(props: {
  answer: AccountAnswer;
  hl: HlAnswer | undefined;
  summary: ReturnType<typeof hlSummary> | null;
  worth: ReturnType<typeof netWorth> | null;
  /** The whole loan: our pool's part and each lender's. */
  loan: LoanView;
  /** What is posted with lenders as collateral, in micro-USD, and with whom. Null with nothing posted. */
  posted: { amount: bigint; at: string[] } | null;
  /** Stage 3: what sits at the account's address on Aave's chain, each token by name. Empty with nothing there. */
  atAddress: string[];
  nbtcPrice: number | null;
}) {
  const { answer, hl, summary, worth, loan, posted, atAddress, nbtcPrice } = props;
  const nbtc = held(answer, 'nBTC');
  const usdc = held(answer, 'USDC');
  const positions = summary ? positionWords(summary.positions) : [];
  return (
    <section className="pb-card" aria-labelledby="money-title">
      <h2 id="money-title" className="pb-card-title">
        Where your money is
      </h2>
      <dl className="pb-rows">
        <div>
          <dt>
            <i className="bi bi-safe" aria-hidden="true" /> On NEAR
          </dt>
          <dd>
            <span className="num">
              {displayUnits(nbtc, 8, 8)} nBTC · {displayUnits(usdc, 6, 2)} USDC
            </span>
            <span className="sub">{worth?.onNear != null ? `About ${formatDollars(worth.onNear)}` : nbtcPrice === null && nbtc > 0n ? 'Reading prices…' : ''}</span>
          </dd>
        </div>
        <div>
          <dt>
            <i className="bi bi-graph-down-arrow" aria-hidden="true" /> On Hyperliquid
          </dt>
          <dd>
            {!hl ? (
              <span className="pb-muted">Reading…</span>
            ) : !hl.address ? (
              <span className="pb-muted">Not set up yet</span>
            ) : (
              <>
                <span className="num">{summary?.equity != null ? formatDollars(summary.equity) : '?'}</span>
                <span className="sub">{positions.length ? positions.join(' · ') : 'No positions'}</span>
              </>
            )}
          </dd>
        </div>
        {posted && (
          <div>
            <dt>
              <i className="bi bi-shield-lock" aria-hidden="true" /> With lenders
            </dt>
            <dd>
              <span className="num">{formatUsd(posted.amount)}</span>
              <span className="sub">Posted with {posted.at.join(' and ')}, to borrow against</span>
            </dd>
          </div>
        )}
        {atAddress.length > 0 && (
          <div>
            <dt>
              <i className="bi bi-wallet2" aria-hidden="true" /> On {EVM_CHAIN_NAME}
            </dt>
            <dd>
              <span className="num">{atAddress.join(' · ')}</span>
              <span className="sub">At the account’s own address there</span>
            </dd>
          </div>
        )}
        <div>
          <dt>
            <i className="bi bi-bank" aria-hidden="true" /> Your loan
          </dt>
          <dd>
            <span className="num">{formatUsd(loan.total)}</span>
            {loan.parts.length > 1 || loan.parts.some((p) => p.source !== 'pool') ? (
              loan.parts.map((part) => (
                <span className="sub" key={part.source}>
                  {formatUsd(part.debt)} from {part.source === 'pool' ? 'our pool' : part.name}
                  {part.payBp !== null ? ` at ${formatBp(part.payBp)}` : ''}
                </span>
              ))
            ) : (
              <span className="sub">{loan.total > 0n ? `From the broker’s pool${loan.rateBp !== null ? ` at ${formatBp(loan.rateBp)}` : ''}` : 'Nothing borrowed'}</span>
            )}
          </dd>
        </div>
      </dl>
      <Link href="/account" className="small d-inline-block mt-2">
        Account details <i className="bi bi-arrow-right" aria-hidden="true" />
      </Link>
    </section>
  );
}

function RecentActivity({ accountId, now }: { accountId: string; now: number }) {
  const activity = useApi<ActivityAnswer>(activityPath(accountId), 30_000);
  const config = useApi<ConfigAnswer>(CONFIG_PATH);
  const items = activity.data?.account === accountId ? activity.data.items.filter((item) => MONEY_KINDS.includes(item.kind)).slice(0, 5) : [];
  const lines = activityLines(items, Tokens, txUrl, config.data?.ids.shim_float);
  return (
    <section className="pb-card" aria-labelledby="activity-title">
      <div className="d-flex align-items-baseline justify-content-between">
        <h2 id="activity-title" className="pb-card-title">
          Recent activity
        </h2>
        <Link href={`/activity?account=${encodeURIComponent(accountId)}`} className="small">
          See all <i className="bi bi-arrow-right" aria-hidden="true" />
        </Link>
      </div>
      {activity.error && !activity.data ? (
        <p className="pb-muted small mb-0">{activity.error.message}</p>
      ) : !activity.data ? (
        <p className="pb-muted small mb-0">Reading…</p>
      ) : lines.length === 0 ? (
        <p className="pb-muted small mb-0">Nothing yet. Deposits, loans and moves show here as they happen.</p>
      ) : (
        <ul className="pb-activity">
          {lines.map((line, i) => (
            <li key={`${line.at}-${i}`}>
              <Dot mark={line.ok ? 'done' : 'failed'} />
              <div className="flex-grow-1" style={{ minWidth: 0 }}>
                <div>{line.what}</div>
                <div className="when">
                  {ago(line.at, now)}
                  {line.links.map((link) => (
                    <a key={link.href} href={link.href} target="_blank" rel="noreferrer" className="ms-2">
                      {link.text} <i className="bi bi-box-arrow-up-right" style={{ fontSize: '0.7rem' }} aria-hidden="true" />
                    </a>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
