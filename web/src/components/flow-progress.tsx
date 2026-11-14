'use client';
// How a check-then-act flow is going, one line per step, from waiting to done, each with its transaction link.
import type { ReactNode } from 'react';

import { txUrl } from '@/config';
import type { FlowState } from '@/hooks/use-check-then-act';
import { useNow } from '@/hooks/use-now';
import { formatUsd } from '@/lib/units';
import { freshness, fundLends, SECONDS_PER_BLOCK } from '@/lib/verdict';

type Mark = 'todo' | 'busy' | 'done' | 'failed' | 'current';

export function Dot({ mark, n }: { mark: Mark; n?: number }) {
  if (mark === 'done') return <span className="pb-dot done" aria-label="done"><i className="bi bi-check-lg" aria-hidden="true" /></span>;
  if (mark === 'failed') return <span className="pb-dot failed" aria-label="failed"><i className="bi bi-x-lg" aria-hidden="true" /></span>;
  if (mark === 'busy') return <span className="pb-dot busy" aria-label="in progress" />;
  return <span className={`pb-dot ${mark === 'current' ? 'current' : ''}`}>{n ?? ''}</span>;
}

export function TxLink({ hash, text = 'transaction' }: { hash?: string; text?: string }) {
  if (!hash) return null;
  return (
    <a href={txUrl(hash)} target="_blank" rel="noreferrer" className="ms-1">
      {text} <i className="bi bi-box-arrow-up-right" style={{ fontSize: '0.7rem' }} aria-hidden="true" />
    </a>
  );
}

export function FlowLine({ mark, n, what, how }: { mark: Mark; n?: number; what: ReactNode; how?: ReactNode }) {
  return (
    <li>
      <Dot mark={mark} n={n} />
      <div>
        <div className={`what ${mark === 'todo' ? 'todo' : ''}`}>{what}</div>
        {how && <div className="how">{how}</div>}
      </div>
    </li>
  );
}

/** Seconds a stored verdict can still back an action, counted from a block height read at `at`. */
function SecondsLeft({ blk, height, at }: { blk: number; height: number; at: number }) {
  const now = useNow(1000);
  const estimate = height + Math.floor((now - at) / (SECONDS_PER_BLOCK * 1000));
  const left = freshness(blk, estimate);
  return <>{left.fresh ? `good for about ${left.secondsLeft} more seconds` : 'expired'}</>;
}

interface Props {
  state: FlowState;
  /** "Borrow 500 USDC". Without it, the flow is a plain check. */
  actLabel?: string;
  /** What to say once the action is sent, in place of "Done". */
  actDone?: string;
  onConfirm: () => void;
  onReset: () => void;
  /** After a refusal: a smaller amount the same check allows, and how to send it. */
  allowed?: { label: string; onUse: () => void } | null;
}

export function FlowProgress({ state, actLabel, actDone, onConfirm, onReset, allowed }: Props) {
  const now = useNow(1000);
  if (state.phase === 'idle') return null;
  const p = state.phase;
  const failedAt = p === 'failed' ? state.step : null;
  const checkHash = 'checkHash' in state ? state.checkHash : undefined;

  const checkMark: Mark = p === 'check' ? 'busy' : failedAt === 'check' ? 'failed' : 'done';
  const verdictMark: Mark = p === 'check' || failedAt === 'check' ? 'todo' : p === 'verdict' ? 'busy' : failedAt === 'verdict' ? 'failed' : 'done';
  const actMark: Mark =
    p === 'act' ? 'busy' : p === 'confirm' ? 'current' : p === 'done' ? 'done' : failedAt === 'act' ? 'failed' : 'todo';

  const verdict = 'verdict' in state && typeof state.verdict === 'object' ? state.verdict : null;
  const allows = !verdict
    ? null
    : 'borrow' in verdict.intent
      ? `It allows borrowing up to ${formatUsd(verdict.verdict.allow.borrow)}.`
      : 'fund' in verdict.intent
        ? `It would lend ${formatUsd(fundLends(verdict))}.`
        : null;

  return (
    <div className="mt-3" aria-live="polite">
      <ul className="pb-flow">
        <FlowLine
          mark={checkMark}
          n={1}
          what="Check your account (0.01 NEAR)"
          how={p === 'check' ? 'Approve it in your wallet.' : checkHash ? <>Sent<TxLink hash={checkHash} /></> : undefined}
        />
        <FlowLine
          mark={verdictMark}
          n={2}
          what="The risk engine reviews the whole book"
          how={
            p === 'verdict'
              ? `Usually 5 to 20 seconds, at most about two minutes · ${Math.round((now - state.since) / 1000)} s`
              : verdictMark === 'done'
                ? (allows ?? 'Done.')
                : undefined
          }
        />
        {actLabel && (
          <FlowLine
            mark={p === 'refused' ? 'todo' : actMark}
            n={3}
            what={actLabel}
            how={
              p === 'act' ? (
                'Approve it in your wallet.'
              ) : p === 'confirm' ? (
                <>
                  {state.note} The check is <SecondsLeft blk={state.verdict.verdict.blk} height={state.height} at={state.at} />.
                </>
              ) : p === 'done' ? (
                <>{actDone ?? 'Done'}<TxLink hash={state.actHash} /></>
              ) : undefined
            }
          />
        )}
      </ul>

      {p === 'confirm' && (
        <div className="d-flex flex-wrap gap-2 mt-2">
          <button type="button" className="btn btn-primary btn-sm" onClick={onConfirm}>
            Confirm: {actLabel}
          </button>
          <button type="button" className="btn btn-outline-secondary btn-sm" onClick={onReset}>
            Cancel
          </button>
        </div>
      )}

      {p === 'refused' && (
        <div className="alert alert-warning small mt-2 mb-0">
          <div className="fw-medium mb-1">{allowed ? 'The check allows less than you asked for.' : 'The check didn’t allow this.'}</div>
          <div>{state.why}</div>
          <div className="d-flex flex-wrap gap-2 mt-2">
            {allowed && (
              <button type="button" className="btn btn-primary btn-sm" onClick={allowed.onUse}>
                {allowed.label}
              </button>
            )}
            <button type="button" className="btn btn-outline-secondary btn-sm" onClick={onReset}>
              Start again
            </button>
          </div>
        </div>
      )}

      {p === 'failed' && (
        <div className="alert alert-danger small mt-2 mb-0">
          <div>{state.why}</div>
          {state.logs.length > 0 && (
            <details className="mt-1">
              <summary>The contract’s log ({state.logs.length} lines)</summary>
              <pre className="small mb-0 text-wrap">{state.logs.join('\n')}</pre>
            </details>
          )}
          <button type="button" className="btn btn-outline-secondary btn-sm mt-2" onClick={onReset}>
            Start again
          </button>
        </div>
      )}

      {p === 'done' && !actLabel && (
        <p className="small mt-2 mb-0" style={{ color: 'var(--pb-good-ink)' }}>
          The result is in your account.
        </p>
      )}
    </div>
  );
}
