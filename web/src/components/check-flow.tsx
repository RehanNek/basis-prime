'use client';
// A check, and the action it backs, in one click (INTERFACES.md 4; 9 Nov redesign).
// The app's second shape (INTERFACES.md 49.4): the broker pays for the check. One calm line shows while it runs, the
// keeper's retries don't show, and the wallet opens once, for the action. When the broker can't run the check, the
// wallet's own check takes over as before, and the page says so first (hooks/use-check-then-act.ts).
// The same flow backs a borrow, a withdrawal, a loan through lenders (`fund`), and taking collateral back.
import { useState } from 'react';

import { FlowLine, FlowProgress, TxLink } from '@/components/flow-progress';
import { VerdictCard } from '@/components/verdict-card';
import { useCheckThenAct, type Act, type FlowState } from '@/hooks/use-check-then-act';
import { useNow } from '@/hooks/use-now';
import type { AccountAnswer } from '@/lib/api';
import { BROKER_CHECK_WORDS, USE_WALLET_LABEL, WALLET_CHECK_WORDS } from '@/lib/broker-check';
import type { Intent, StoredVerdict } from '@/lib/types';
import { formatUsd } from '@/lib/units';
import { freshness, fundLends, lesserAmount, SECONDS_PER_BLOCK } from '@/lib/verdict';

interface Props {
  account: AccountAnswer;
  fetchedAt: number;
  reload: () => void;
  /** Null while the inputs aren't valid. */
  intent: Intent | null;
  inputProblem?: string | null;
  checkLabel: string;
  /** Kept for the pages that pass it: the free preview is gone, since the check itself now costs the client nothing. */
  previewEnabled?: boolean;
  /** The action the check backs. Owner-only, so `isOwner` must be true to send it. */
  act?: Act | null;
  isOwner: boolean;
  /** Show the stored verdict here (pages without an overview). */
  showStored?: boolean;
  /**
   * After a refusal that still allows a smaller loan: the action for that amount (micro-USDC), given the verdict that
   * allows it.
   */
  retarget?: (allowed: bigint, held: StoredVerdict) => Act | null;
  /** The button's look: the main action of its panel, or a quieter one. */
  primary?: boolean;
}

export function CheckFlow({ account, fetchedAt, reload, intent, inputProblem, checkLabel, act, isOwner, showStored, retarget, primary = true }: Props) {
  const flow = useCheckThenAct(account.account_id, reload);
  const now = useNow(1000);
  // The action this run was started for: the amount field may change while it runs.
  const [started, setStarted] = useState<Act | null>(null);

  const state = account.state;
  if (!state) return null;
  // The chain moves on between reads: estimate today's height from the time since the last one.
  const height = account.block_height + Math.floor((now - fetchedAt) / (SECONDS_PER_BLOCK * 1000));
  const running = flow.busy || flow.state.phase === 'confirm';
  const ownerOnly = Boolean(act) && !isOwner;

  const start = () => {
    if (!intent) return;
    setStarted(act ?? null);
    void flow.run({ intent, act: act ?? null });
  };

  let allowed: { label: string; onUse: () => void } | null = null;
  if (flow.state.phase === 'refused' && retarget) {
    const most = lesserAmount(flow.state.verdict);
    const smaller = most > 0n ? retarget(most, flow.state.verdict) : null;
    if (smaller) {
      allowed = {
        label: `Borrow ${formatUsd(most)} instead`,
        onUse: () => {
          setStarted(smaller);
          void flow.confirm(smaller);
        },
      };
    }
  }
  return (
    <div>
      <button type="button" className={`btn ${primary ? 'btn-primary' : 'btn-outline-primary'}`} disabled={!intent || running || ownerOnly} onClick={start}>
        {running ? (
          <>
            <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
            Working…
          </>
        ) : act ? (
          act.label
        ) : (
          checkLabel
        )}
      </button>
      {act && flow.state.phase === 'idle' && <div className="form-text">One click. The risk engine checks your account first, then your wallet opens once to approve this.</div>}
      {inputProblem && <div className="form-text text-danger">{inputProblem}</div>}
      {ownerOnly && <div className="form-text">Only the account’s owner can do this.</div>}

      <CheckProgress state={flow.state} actLabel={started?.label} actDone={started?.done} allowed={allowed} onConfirm={() => void flow.confirm()} onReset={flow.reset} onWallet={() => flow.again('wallet')} />

      {showStored && state.verdict && (
        <details className="mt-3">
          <summary>Your latest check result</summary>
          <div className="mt-2">
            <VerdictCard verdict={state.verdict.verdict} intent={state.verdict.intent} title="The account's latest check" stored={{ counter: state.counter, height, permissionBlk: state.permission_blk }} />
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * How a check-then-act run is going, for the button above or for a page that drives the hook itself (a move, which
 * holds its price first). A run the broker's check started shows the calm lines; when the page fell back to the
 * wallet's own check it says so, and shows that check's steps as before.
 */
export function CheckProgress(props: {
  state: FlowState;
  actLabel?: string;
  actDone?: string;
  allowed?: { label: string; onUse: () => void } | null;
  onConfirm: () => void;
  onReset: () => void;
  /** After a broker's check that didn't go through: runs the same job with the wallet's own check (the hook's `again('wallet')`). Without it the way isn't offered. */
  onWallet?: () => void;
}) {
  const { state, actLabel, actDone, allowed = null, onConfirm, onReset, onWallet } = props;
  const now = useNow(1000);
  if (state.phase === 'idle') return null;
  const calm = state.phase === 'broker' || ('broker' in state && state.broker === true);
  if (calm) return <CalmProgress state={state} now={now} actLabel={actLabel} actDone={actDone} allowed={allowed} onConfirm={onConfirm} onReset={onReset} onWallet={onWallet} />;
  return (
    <>
      {'fellBack' in state && state.fellBack !== undefined && <div className="form-text mt-2">{WALLET_CHECK_WORDS}</div>}
      <FlowProgress state={state} actLabel={actLabel} actDone={actDone} onConfirm={onConfirm} onReset={onReset} allowed={allowed} />
    </>
  );
}

/**
 * How a run goes when the broker paid for the check: one line for the check, one for the action, and after a refusal
 * or a failure what to do next. No step asks the wallet for the check.
 */
function CalmProgress(props: { state: FlowState; now: number; actLabel?: string; actDone?: string; allowed: { label: string; onUse: () => void } | null; onConfirm: () => void; onReset: () => void; onWallet?: () => void }) {
  const { state, now, actLabel, actDone, allowed, onConfirm, onReset, onWallet } = props;
  const p = state.phase;
  const verdict = 'verdict' in state && typeof state.verdict === 'object' ? state.verdict : null;
  const allows = !verdict ? null : 'borrow' in verdict.intent ? `It allows borrowing up to ${formatUsd(verdict.verdict.allow.borrow)}.` : 'fund' in verdict.intent ? `It would lend ${formatUsd(fundLends(verdict))}.` : null;
  const checkFailed = p === 'failed' && state.step !== 'act';
  const slow = p === 'broker' && now - state.since > 60_000;

  return (
    <div className="mt-3" aria-live="polite">
      <ul className="pb-flow">
        <FlowLine
          mark={p === 'broker' ? 'busy' : checkFailed ? 'failed' : 'done'}
          n={1}
          what={p === 'broker' ? BROKER_CHECK_WORDS : checkFailed ? 'The risk engine’s check didn’t go through' : 'The risk engine checked your account'}
          how={slow ? 'Still checking. A slow answer is asked for again by itself: you don’t need to do anything.' : p !== 'broker' && !checkFailed ? (allows ?? undefined) : undefined}
        />
        {actLabel && (
          <FlowLine
            mark={p === 'act' ? 'busy' : p === 'confirm' ? 'current' : p === 'done' ? 'done' : p === 'failed' && state.step === 'act' ? 'failed' : 'todo'}
            n={2}
            what={actLabel}
            how={
              p === 'act' ? (
                'Approve it in your wallet.'
              ) : p === 'confirm' ? (
                <>
                  {state.note} You have about {freshness(state.verdict.verdict.blk, state.height + Math.floor((now - state.at) / (SECONDS_PER_BLOCK * 1000))).secondsLeft} seconds to confirm.
                </>
              ) : p === 'done' ? (
                <>
                  {actDone ?? 'Done'}
                  <TxLink hash={state.actHash} />
                </>
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
              {allowed ? 'Change the amount' : 'Try another amount'}
            </button>
          </div>
        </div>
      )}

      {p === 'failed' && (
        <div className="alert alert-danger small mt-2 mb-0">
          <div>{state.why}</div>
          {state.logs.length > 0 && (
            <details className="mt-1">
              <summary>The details</summary>
              <pre className="small mb-0 text-wrap">{state.logs.join('\n')}</pre>
            </details>
          )}
          <div className="d-flex flex-wrap gap-2 mt-2">
            <button type="button" className="btn btn-outline-secondary btn-sm" onClick={onReset}>
              Try again
            </button>
            {/* The check of before, kept within reach: the client's own wallet asks and pays for it. */}
            {checkFailed && onWallet && (
              <button type="button" className="btn btn-link btn-sm" onClick={onWallet}>
                {USE_WALLET_LABEL}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
