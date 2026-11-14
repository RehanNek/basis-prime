'use client';
// The Risk page (PLAN.md 5.8; INTERFACES.md 17): how the risk engine last saw the account, and what the keeper did
// about it. The buffer and the initial requirement, the top risks in words, the bands next to today's prices, the
// margin-call clock, the stored plan with each step's status, pending transfers with overdue ones marked, and the
// history of verdicts and of the keeper's actions, each with its transaction or attestation.
import { useState, type ReactNode } from 'react';

import { AccountPicker } from '@/components/account-picker';
import { ApiProblem, NotDeployed } from '@/components/notices';
import { AccountGate, VisitorNotice } from '@/components/sign-in-card';
import { knownTokens, TransferStage } from '@/components/pending-moves';
import { VerdictCard } from '@/components/verdict-card';
import { accountUrl, FactoryContract, txUrl } from '@/config';
import { useApi } from '@/hooks/use-api';
import { useClientAccount } from '@/hooks/use-client-account';
import { useDebounced } from '@/hooks/use-debounced';
import { useNow } from '@/hooks/use-now';
import { accountPath, DRILL_PATH, drillPathFor, keeperPath, marketsPath, type AccountAnswer, type ApiError, type DrillAnswer, type KeeperAnswer, type KeeperEvent, type MarketsAnswer } from '@/lib/api';
import { accountIdFor, nameProblem } from '@/lib/names';
import { loanOpen } from '@/lib/hl';
import { transferWords } from '@/lib/moves';
import {
  bandRows,
  isOverdue,
  keeperActions,
  marginClock,
  MARGIN_CALL_LIMIT_MS,
  minutes,
  pendingTransfers,
  readPlan,
  riskWords,
  showLevel,
  stepStatus,
  verdictHistory,
} from '@/lib/risk';
import type { Verdict } from '@/lib/types';
import { formatUsd } from '@/lib/units';
import { visitorView } from '@/lib/session';
import { useNearWallet } from '@/providers/near-provider';
import { useSession } from '@/providers/session-provider';

/** Aave's two test collateral tokens on Base Sepolia (INTERFACES.md 24 and 33), for naming a move home on this page. */
const AAVE_TEST_COLLATERAL = [
  { token: '0x54114591963cf60ef3aa63befd6ec263d98145a4', symbol: 'WBTC', decimals: 8, amount: '0' },
  { token: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, amount: '0' },
];

export function RiskView() {
  const { signedAccountId, loading } = useNearWallet();
  return (
    <main className="pb-container pb-page" style={{ maxWidth: 960 }}>
      <h1 className="h3">Risk</h1>
      <p className="lead">
        How the risk engine last saw the account, and what the keeper did about it. Every step links to its transaction or to
        OutLayer&apos;s attestation of the run.
      </p>
      {loading ? (
        <p className="text-body-secondary">Loading the wallet…</p>
      ) : signedAccountId ? (
        <AccountGate>
          <SignedIn />
        </AccountGate>
      ) : (
        <ByName />
      )}
    </main>
  );
}

/** With a wallet: the account the wallet works on, as on the other pages. */
function SignedIn() {
  const client = useClientAccount(8_000);
  return (
    <RiskBody answer={client.answer} error={client.error}>
      <AccountPicker name={client.name} problem={client.problem} onName={client.setName} answer={client.answer} owner={client.owner} errorCode={client.errorCode} mine={client.mine} finding={client.finding} />
    </RiskBody>
  );
}

/**
 * Without a wallet. Privacy level 1 (INTERFACES.md 48.6): "Connect your wallet to see your account", and the accounts
 * anyone may look at as links; `?account=<an open account>` opens one, read only. With privacy off, the name field as
 * it was.
 */
function ByName() {
  const session = useSession();
  const [asked] = useState(() => new URLSearchParams(window.location.search).get('account'));
  if (session.checking) return <div className="pb-skeleton" style={{ height: 120 }} aria-busy="true" />;
  const view = visitorView({ mode: session.mode, openAccounts: session.openAccounts, asked, factory: FactoryContract });
  return view.kind === 'connect' ? <Visitor links={view.links} open={view.open} /> : <FreeText first={view.name} />;
}

/** A visitor with privacy on: the sentence, the open accounts, and the one that was opened, if any. */
function Visitor({ links, open }: { links: { account: string; name: string }[]; open: string | null }) {
  const read = useApi<AccountAnswer>(open ? accountPath(open) : null, 8_000);
  const answer = open && read.data?.account_id === open ? read.data : undefined;
  return (
    <RiskBody answer={answer} error={read.error}>
      <VisitorNotice links={links} open={open} />
    </RiskBody>
  );
}

/** Privacy off, as before: any client account, read only. */
function FreeText({ first }: { first: string }) {
  const [name, setName] = useState(first);
  const problem = name ? nameProblem(name, FactoryContract) : null;
  const path = useDebounced(name && !problem ? accountPath(accountIdFor(name, FactoryContract)) : null, 400);
  const read = useApi<AccountAnswer>(path, 8_000);
  const answer = name && !problem && read.data?.account_id === accountIdFor(name, FactoryContract) ? read.data : undefined;
  return (
    <RiskBody answer={answer} error={read.error}>
      <div className="mb-3">
        <label className="form-label small text-body-secondary" htmlFor="risk-account">
          Client account (no wallet needed to look)
        </label>
        <div className="input-group" style={{ maxWidth: 520 }}>
          <input id="risk-account" className={`form-control ${problem ? 'is-invalid' : ''}`} value={name} onChange={(e) => setName(e.target.value.trim().toLowerCase())} placeholder="name" autoComplete="off" spellCheck={false} />
          <span className="input-group-text">.{FactoryContract}</span>
        </div>
        <div className="form-text">
          {problem ??
            (answer ? (
              <a href={accountUrl(answer.account_id)} target="_blank" rel="noreferrer">
                {answer.account_id}
              </a>
            ) : name ? (
              'Reading the account…'
            ) : (
              'Type the name of a client account.'
            ))}
        </div>
      </div>
    </RiskBody>
  );
}

function RiskBody({ answer, error, children }: { answer: AccountAnswer | undefined; error: ApiError | undefined; children: ReactNode }) {
  const accountId = answer?.state ? answer.account_id : null;
  // The ratio pb-risk reads for this account: its own drill ratio, once the drill has per-account ones (INTERFACES.md 21).
  const drill = useApi<DrillAnswer>(accountId ? drillPathFor(accountId) : DRILL_PATH, 15_000);
  const ratio = drill.data?.account_ratio?.ratio ?? drill.data?.ratio ?? null;
  const markets = useApi<MarketsAnswer>(marketsPath(accountId), 30_000);
  const keeper = useApi<KeeperAnswer>(accountId ? keeperPath(accountId) : null, 10_000);
  const now = useNow(5_000);
  const events = keeper.data?.account === accountId ? (keeper.data?.events ?? []) : [];
  const prices = {
    marks: Object.fromEntries((markets.data?.coins ?? []).flatMap((c) => (c.testnet?.mark_px ? [[c.coin, Number(c.testnet.mark_px)]] : []))),
    pi: ratio ? { nBTC: ratio.bp } : ({} as Record<string, number>),
  };

  return (
    <>
      <ApiProblem error={error} />
      {children}
      {answer && <NotDeployed contracts={answer.not_deployed} />}
      {answer && !answer.exists && <div className="alert alert-secondary small">Create the account on the Account page first.</div>}
      {answer?.state && (
        <>
          <Standing answer={answer} />
          <MarginClockCard answer={answer} now={now} />
          <Bands verdict={answer.state.verdict?.verdict ?? null} prices={prices} drill={drill.data} />
          <StoredPlan answer={answer} events={events} now={now} />
          <Transfers answer={answer} now={now} />
          <Keeper keeper={keeper.data} error={keeper.error?.message} events={events} />
          <History events={events} />
        </>
      )}
    </>
  );
}

/** The latest verdict in words: the state, the buffer (MR) and the initial requirement (IM), the top risks. */
function Standing({ answer }: { answer: AccountAnswer }) {
  const stored = answer.state!.verdict;
  const hasLoan = loanOpen(answer.state!.loan);
  if (!stored) {
    return (
      <section className="card mb-3">
        <div className="card-header fw-semibold">Where the account stands</div>
        <div className="card-body small">No check yet: run one from Home or the Account page.</div>
      </section>
    );
  }
  const v = stored.verdict;
  return (
    <>
      {!hasLoan && <div className="alert alert-secondary small">No loan is open, so the account is HEALTHY whatever the numbers say: states apply only with a loan.</div>}
      <VerdictCard verdict={v} intent={stored.intent} title="Where the account stands" stored={{ counter: answer.state!.counter, height: answer.block_height, permissionBlk: answer.state!.permission_blk }} />
      {v.ok && v.top?.length > 0 && (
        <section className="card mb-3">
          <div className="card-header fw-semibold">The top risks, in words</div>
          <div className="card-body small">
            <p className="mb-2">
              Equity {formatUsd(v.eq)}. The safety buffer is {formatUsd(v.mm)} and the initial requirement {formatUsd(v.im)}: below the buffer is a margin
              call, and below 0.8 times it the plan runs.
            </p>
            <ol className="mb-0">
              {v.top.map((risk) => (
                <li key={risk}>{riskWords(risk)}</li>
              ))}
            </ol>
          </div>
        </section>
      )}
    </>
  );
}

function MarginClockCard({ answer, now }: { answer: AccountAnswer; now: number }) {
  const clock = marginClock(answer.state!.margin_call, now);
  const share = Math.min(100, Math.round((clock.belowMs / MARGIN_CALL_LIMIT_MS) * 100));
  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">The margin-call clock</div>
      <div className="card-body small">
        <p className="mb-2">
          It counts the time below the safety buffer over the last 24 hours, so dipping in and out doesn&apos;t reset it. At 4 hours the plan runs.
        </p>
        <div className="progress mb-2" role="progressbar" aria-label="Time below the buffer" aria-valuenow={share} aria-valuemin={0} aria-valuemax={100}>
          <div className={`progress-bar ${share >= 75 ? 'bg-danger' : share > 0 ? 'bg-warning' : ''}`} style={{ width: `${share}%` }} />
        </div>
        <p className="mb-0">
          {minutes(clock.belowMs)} of 4 h used; {minutes(clock.leftMs)} left.{' '}
          {clock.below ? (
            <span className="badge text-bg-warning">Below the buffer now{clock.sinceMs ? `, since ${new Date(clock.sinceMs).toLocaleTimeString()}` : ''}</span>
          ) : (
            <span className="badge text-bg-success">Not below the buffer</span>
          )}
        </p>
      </div>
    </section>
  );
}

/** The verdict's bands: where the keeper asks for a fresh check (RISK_ENGINE.md 8.3). */
function Bands({ verdict, prices, drill }: { verdict: Verdict | null; prices: { marks: Record<string, number>; pi: Record<string, number> }; drill: DrillAnswer | undefined }) {
  const rows = verdict?.ok ? bandRows(verdict.bands, prices) : [];
  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">Bands</div>
      <div className="card-body small">
        <p className="mb-2">
          The keeper compares these levels with the prices every 15 s, and asks for a check when one is crossed. A verdict carries bands only with a loan,
          and none during DELEVERAGE, when the plan runs instead.
          {drill?.ratio &&
            ` On testnet the nBTC/BTC ratio is the drill's: ${showLevel('pi', (drill.account_ratio?.ratio ?? drill.ratio).bp)} now${drill.account_ratio && !drill.account_ratio.shared ? ", this account's own" : ''}.`}
        </p>
        {rows.length === 0 ? (
          <p className="text-body-secondary mb-0">The last check has no bands.</p>
        ) : (
          <table className="table table-sm mb-0">
            <thead>
              <tr>
                <th>Asset</th>
                <th>At</th>
                <th>What happens there</th>
                <th className="text-end">Now</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.asset}.${r.field}`}>
                  <td>{r.kind === 'pi' ? `${r.asset}/BTC ratio` : r.asset}</td>
                  <td className="font-monospace">{showLevel(r.kind, r.level)}</td>
                  <td>{r.meaning}</td>
                  <td className="text-end font-monospace">{r.now === null ? '?' : showLevel(r.kind, r.now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function StoredPlan({ answer, events, now }: { answer: AccountAnswer; events: KeeperEvent[]; now: number }) {
  const plan = readPlan(answer.state);
  const firstAt = Number(answer.state!.deleverage?.first_at ?? '0');
  const v = answer.state!.verdict?.verdict;
  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">The stored plan</div>
      <div className="card-body small">
        {!plan ? (
          <p className="mb-0">
            No plan is stored.
            {v?.ok && v.action === 'DELEVERAGE' && firstAt > 0 && (
              <> The last check says DELEVERAGE: the account stores its plan when a second DELEVERAGE check comes 2 to 5 minutes after the first ({new Date(firstAt / 1e6).toLocaleTimeString()}). The keeper asks for it after about 2.5 minutes.</>
            )}
          </p>
        ) : (
          <>
            <p className="mb-2">
              A <strong>{plan.action}</strong> plan, id {plan.pid}
              {plan.storedAtMs && <>, stored {new Date(plan.storedAtMs).toLocaleTimeString()}</>}. The gateway places its cancel and perp steps; anyone can run
              the others with <code>execute_step</code>, and the keeper does. Each step runs once.
              {plan.source === 'confirmed_plan' && ' This account was made before Phase 4, so its plan is in words only and nothing runs it.'}
            </p>
            <ol className="mb-0" start={0}>
              {plan.steps.map((step) => {
                const status = stepStatus(plan, step, events, now, txUrl);
                return (
                  <li key={step.i} className="mb-1">
                    {step.text}{' '}
                    <span className={`badge text-bg-${status.tone}`}>{status.label}</span>
                    {status.link && (
                      <>
                        {' '}
                        <a href={status.link.href} target="_blank" rel="noreferrer">
                          {status.link.text}
                        </a>
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </div>
    </section>
  );
}

function Transfers({ answer, now }: { answer: AccountAnswer; now: number }) {
  const transfers = pendingTransfers(answer.state!.pending);
  // The tokens the page can name. A move home from Aave's chain names its collateral by a 0x address: the two test
  // tokens Aave takes there are listed here by their decimals (INTERFACES.md 24 and 36).
  const tokens = knownTokens(AAVE_TEST_COLLATERAL);
  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">Money in transit</div>
      <div className="card-body small">
        <p className="mb-2">
          Transfers through 1Click that haven&apos;t settled yet: USDC to and from Hyperliquid, and on testnet the moves between NEAR and Aave&apos;s chain. Each one ends
          when 1Click delivers or refunds it with the account&apos;s message, or when a check sees it arrive on Hyperliquid or at the account&apos;s address on Aave&apos;s
          chain. Past its deadline it is overdue, and borrowing or withdrawing with a loan waits: the owner drops it on Home, under &quot;Money on its way&quot;.
        </p>
        {transfers.length === 0 ? (
          <p className="text-body-secondary mb-0">None.</p>
        ) : (
          <table className="table table-sm mb-0">
            <thead>
              <tr>
                <th>Id</th>
                <th>What</th>
                <th>Where it stands (1Click&apos;s status; our stand-in on testnet)</th>
                <th>Deadline</th>
              </tr>
            </thead>
            <tbody>
              {transfers.map((t) => (
                <tr key={t.id} className={isOverdue(t, now) ? 'table-danger' : ''}>
                  <td className="font-monospace">{t.id}</td>
                  <td>{transferWords(t, tokens)}</td>
                  <td>
                    <TransferStage accountId={answer.account_id} transfer={t} now={now} />
                  </td>
                  <td>
                    {t.deadlineMs ? new Date(t.deadlineMs).toLocaleTimeString() : '?'} {isOverdue(t, now) && <span className="badge text-bg-danger">Overdue</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function Keeper({ keeper, error, events }: { keeper: KeeperAnswer | undefined; error: string | undefined; events: KeeperEvent[] }) {
  const actions = keeperActions(events, txUrl).slice(0, 30);
  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">What the keeper did</div>
      <div className="card-body small">
        {error && <div className="alert alert-warning py-1 px-2">{error}</div>}
        {keeper && (
          <p className="mb-2">
            {!keeper.log_found ? (
              <>The keeper&apos;s log isn&apos;t on this machine, so its actions can&apos;t be shown here.</>
            ) : keeper.keeper.running ? (
              <>
                <span className="badge text-bg-success">Running</span> The keeper last looked at {keeper.keeper.last_tick_at ? new Date(keeper.keeper.last_tick_at).toLocaleTimeString() : '?'}
                {keeper.keeper.dry_run ? ', in a dry run: it sends nothing.' : keeper.keeper.watches ? ', and watches this account.' : ', but not this account yet.'}
              </>
            ) : (
              <>
                <span className="badge text-bg-secondary">Not running</span> Its last look was {keeper.keeper.last_tick_at ? new Date(keeper.keeper.last_tick_at).toLocaleString() : 'never'}. Start it
                with <code>pnpm --filter @pb/keeper start</code>.
              </>
            )}
          </p>
        )}
        {actions.length === 0 ? (
          <p className="text-body-secondary mb-0">Nothing yet for this account.</p>
        ) : (
          <ul className="list-unstyled mb-0">
            {actions.map((a, i) => (
              <li key={`${a.at}-${i}`} className="mb-1">
                <span className="text-body-secondary">{new Date(a.at).toLocaleTimeString()}</span> <span className={a.ok ? '' : 'text-danger'}>{a.what}</span>
                {a.why && <span className="text-body-secondary">: {a.why}</span>}
                {a.links.map((l) => (
                  <span key={l.href}>
                    {' · '}
                    <a href={l.href} target="_blank" rel="noreferrer">
                      {l.text}
                    </a>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function History({ events }: { events: KeeperEvent[] }) {
  const verdicts = verdictHistory(events, txUrl).slice(0, 30);
  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">Verdict history</div>
      <div className="card-body small">
        <p className="mb-2">
          Every verdict the keeper saw, newest first. One it asked for links to its check and to OutLayer&apos;s attestation of the run, which ties the
          answer to the program that made it.
        </p>
        {verdicts.length === 0 ? (
          <p className="text-body-secondary mb-0">None recorded yet: the keeper logs the checks of accounts with a loan.</p>
        ) : (
          <table className="table table-sm mb-0">
            <thead>
              <tr>
                <th>Seen</th>
                <th>State</th>
                <th>Action</th>
                <th className="text-end">Equity</th>
                <th className="text-end">Buffer / IM</th>
                <th>Links</th>
              </tr>
            </thead>
            <tbody>
              {verdicts.map((v, i) => (
                <tr key={`${v.at}-${i}`}>
                  <td>{new Date(v.at).toLocaleTimeString()}</td>
                  <td>{v.state}</td>
                  <td>{v.action}</td>
                  <td className="text-end font-monospace">{v.eq === null ? '?' : formatUsd(v.eq)}</td>
                  <td className="text-end font-monospace">
                    {v.mm === null ? '?' : formatUsd(v.mm)} / {v.im === null ? '?' : formatUsd(v.im)}
                  </td>
                  <td>
                    {v.links.map((l, j) => (
                      <span key={l.href}>
                        {j > 0 && ' · '}
                        <a href={l.href} target="_blank" rel="noreferrer">
                          {l.text}
                        </a>
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
