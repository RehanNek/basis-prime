'use client';
// "Close everything" (INTERFACES.md 49.1, point 5): one button that leads the way out in order. The card says what is
// open, shows the five parts of the way out with the one the account is at, and under it the step being done: what
// the wallet will ask, said before it opens, and how the step is going. The order is decided from the account's real
// state before every step (lib/basis.ts, `nextCloseStep`).
import Link from 'next/link';

import { EvmLines } from '@/components/evm-lines';
import { Dot } from '@/components/flow-progress';
import { FailureBox, LiveLine } from '@/components/basis/parts';
import type { BasisData } from '@/components/basis/use-basis-data';
import { useCloseRun } from '@/components/basis/use-close-run';
import { BROKER_CHECK_WORDS, WALLET_CHECK_WORDS } from '@/lib/broker-check';
import { CLOSE_STAGES, closeStage, closeStateFrom, closeSummary, closeWords, hlWasRead, nextCloseStep } from '@/lib/basis';

interface Props {
  data: BasisData;
  /** The opening run is on: the way out can't be started beside it. */
  opening?: boolean;
  /** Tells the page while this card's run is on. */
  onRunning?: (running: boolean) => void;
}

export function CloseTrade({ data, opening = false, onRunning }: Props) {
  const { client, answer, state } = data;
  const run = useCloseRun({ accountId: data.accountId, owner: client.owner, testnet: data.testnet, usdcId: data.usdc?.id ?? null, reloadAll: data.reloadAll });

  const start = async () => {
    onRunning?.(true);
    try {
      await run.start();
    } finally {
      onRunning?.(false);
    }
  };

  // Nothing is decided until the account, Hyperliquid and the lenders have all answered: a part that hasn't been read
  // is never taken for a part with nothing in it.
  const read = answer && state && hlWasRead(data.hl) && data.lender ? closeStateFrom({ account: answer, hl: data.hl, lender: data.lender, nowMs: data.now, testnet: data.testnet, helperOn: data.helperOn }) : null;
  if (!state || !answer) return null;

  const phase = run.phase;
  const nextStep = read ? nextCloseStep(read) : null;
  // While the run is on, the rail follows the run's own step; otherwise what the account shows now.
  const step = phase.kind === 'idle' || phase.kind === 'finished' ? nextStep : (run.step ?? nextStep);
  const nothing = nextStep?.kind === 'done' && phase.kind !== 'running';
  // A step that only waits belongs to no part by itself: during a run it stays under the part the run is in.
  const at = step ? (closeStage(step) ?? (phase.kind === 'idle' ? null : run.stage)) : null;
  const summary = read ? closeSummary(read) : [];
  // The check flow's own line, while one runs inside a step.
  const checking = run.check.phase === 'broker' || run.check.phase === 'verdict' ? BROKER_CHECK_WORDS : run.check.phase === 'check' ? WALLET_CHECK_WORDS : run.check.phase === 'act' ? 'The check passed. Approve the step in your wallet.' : null;

  return (
    <section className="pb-card mb-4" aria-labelledby="basis-close-title">
      <h2 id="basis-close-title" className="pb-card-title">
        Close everything
      </h2>
      {!read ? (
        data.hlError || (data.hl && !hlWasRead(data.hl)) ? (
          <p className="mb-0 pb-muted">The page couldn’t read your account’s Hyperliquid side just now, so it can’t say what is open. It asks again in a few seconds.</p>
        ) : (
          <div className="pb-skeleton" style={{ height: 120 }} aria-busy="true" />
        )
      ) : nothing && phase.kind !== 'finished' ? (
        <p className="mb-0 pb-muted">Nothing is open: no loan, no short, and nothing left in the account.</p>
      ) : (
        <>
          <p className="mb-2">
            One button leads the way out, in this order. It repays what you owe, takes your collateral back, closes the short, brings the USDC home, and withdraws to your wallet. Your wallet approves each
            step, and the page says what it will ask before it opens.
          </p>
          {summary.length > 0 && phase.kind !== 'finished' && (
            <ul className="small pb-muted ps-3 mb-3">
              {summary.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          {phase.kind !== 'finished' && (
            <div className="d-flex flex-wrap align-items-center gap-3 mb-3">
              {/* With only tokens to withdraw, the account may be on its way into a trade: the button is then the quieter one. */}
              <button type="button" className={`btn ${nextStep?.kind === 'withdraw' && !run.busy ? 'btn-outline-primary' : 'btn-primary'}`} disabled={run.busy || opening || !client.isOwner || nothing} onClick={() => void start()}>
                {run.busy ? (
                  <>
                    <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
                    Working…
                  </>
                ) : (
                  'Close everything'
                )}
              </button>
              {!run.busy && !opening && nextStep && nextStep.kind !== 'done' && <span className="small pb-muted">First: {lower(closeWords(nextStep).title)}.</span>}
              {!client.isOwner && <span className="small pb-muted">Only the account’s owner can close it.</span>}
              {opening && <span className="small pb-muted">The trade is being opened above. Wait for it to stop first.</span>}
            </div>
          )}

          <ol className="pb-checklist mb-0">
            {CLOSE_STAGES.map((stage, i) => {
              const finished = phase.kind === 'finished' || (at !== null && i < at);
              const here = !finished && at === i;
              return (
                <li key={stage}>
                  <Dot mark={finished ? 'done' : here && phase.kind === 'failed' ? 'failed' : here && phase.kind === 'running' ? 'busy' : here ? 'current' : 'todo'} n={i + 1} />
                  <div className="flex-grow-1" style={{ minWidth: 0 }}>
                    <div className={`pb-step-title ${finished ? 'done' : ''}`}>{stage}</div>
                    {here && <Now run={run} checking={checking} onRetry={() => void start()} />}
                  </div>
                </li>
              );
            })}
          </ol>
          {/* A step that only waits for something already under way belongs to no part of the rail: it shows here. */}
          {at === null && phase.kind !== 'finished' && (
            <div className="mt-3">
              <Now run={run} checking={checking} onRetry={() => void start()} />
            </div>
          )}

          {run.done.length > 0 && (
            <details className="small mt-3">
              <summary>
                Done in this run ({run.done.length})
              </summary>
              <ol className="mb-0 ps-3">
                {run.done.map((line, i) => (
                  <li key={`${i}-${line}`}>{line}</li>
                ))}
              </ol>
            </details>
          )}
          {phase.kind === 'finished' && (
            <p className="mt-3 mb-0" style={{ color: 'var(--pb-good-ink)' }}>
              Everything is closed. Nothing is owed, the short is closed, and your tokens are in your wallet.
              {read && (read.hlWithdrawable >= 10_000n || read.usdcEvm >= 10_000n) ? ' Less than $2 is left on Hyperliquid or at your address on Aave’s chain: moving so little would cost about as much.' : ''}
            </p>
          )}
        </>
      )}
    </section>
  );
}

const lower = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** The step being done now, under its part of the rail: its name, what the wallet will ask, how it is going, or what went wrong. */
function Now({ run, checking, onRetry }: { run: ReturnType<typeof useCloseRun>; checking: string | null; onRetry: () => void }) {
  const phase = run.phase;
  if (phase.kind === 'idle' || phase.kind === 'finished') return null;
  return (
    <div className="mt-1">
      <div className="fw-medium">{phase.title}</div>
      {phase.kind === 'running' && <LiveLine announce={phase.announce} detail={checking ?? phase.detail ?? (phase.announce ? 'Waiting for your wallet…' : 'Working…')} />}
      {phase.kind !== 'stopped' && <EvmLines lines={run.evmLines} />}
      {phase.kind === 'failed' && <FailureBox title={phase.title} raw={phase.raw} logs={phase.logs} said={phase.said} onRetry={onRetry} />}
      {phase.kind === 'stopped' && (
        <div className="alert alert-secondary mt-2 mb-0">
          {phase.words}{' '}
          <Link href="/deposit">
            Add funds <i className="bi bi-arrow-right" aria-hidden="true" />
          </Link>
        </div>
      )}
    </div>
  );
}
