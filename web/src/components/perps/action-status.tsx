'use client';
// Where an order or a cancel stands, next to the button that started it: a calm line with the seconds while the
// broker's risk checks run in the sealed computer (20 to 60 seconds, one order at a time), then the result in words.
// After 30 seconds the line turns calm: the order is waiting its turn (INTERFACES.md 50.4). An expired message says
// so once, with "Sign again": a button that signs a fresh one.
import { useNow } from '@/hooks/use-now';
import { SIGN_AGAIN } from '@/lib/gateway';
import { progressWords } from '@/lib/perps';

import s from './perps.module.css';
import type { ActionState, GatewayAction, Origin } from './use-gateway-action';

export function ActionStatus({ action, origin }: { action: GatewayAction; origin: Origin }) {
  const { state } = action;
  if (state.kind === 'idle' || state.request.origin !== origin) return null;
  // A placed order's own words already say what it was.
  const named = state.kind === 'done' && state.words.ok && state.request.kind === 'order';
  return (
    <div className={`${s.status} mt-2`} role="status" aria-live="polite">
      {!named && <p className="fw-semibold mb-1">{state.request.label}</p>}
      {state.kind === 'waiting' ? <Waiting state={state} /> : <Settled action={action} state={state} />}
    </div>
  );
}

function Waiting({ state }: { state: Extract<ActionState, { kind: 'waiting' }> }) {
  const now = useNow(1000);
  return (
    <p className="d-flex gap-2 align-items-start">
      <span className="spinner-border spinner-border-sm flex-shrink-0 mt-1" aria-hidden="true" />
      <span className={s.num}>{progressWords(state.phase, (now - state.since) / 1000)}</span>
    </p>
  );
}

function Settled({ action, state }: { action: GatewayAction; state: Extract<ActionState, { kind: 'done' | 'failed' }> }) {
  if (state.kind === 'failed') {
    return (
      <>
        <p>{state.message}</p>
        <button type="button" className="btn btn-sm btn-outline-secondary mt-2" onClick={action.dismiss}>
          OK
        </button>
      </>
    );
  }
  const { words, answer } = state;
  return (
    <>
      <p>
        <span className={`pb-pill ${words.ok ? 'good' : words.expired ? 'warn' : 'bad'} me-1`}>{words.ok ? 'Done' : words.expired ? 'Not placed' : 'Refused'}</span> {words.headline}
      </p>
      {words.lines.map((line) => (
        <p key={line} className="pb-muted mt-1">
          {line}
        </p>
      ))}
      {answer.attestation_url && (
        <p className="pb-muted mt-1">
          Checked in a sealed computer (OutLayer) ·{' '}
          <a href={answer.attestation_url} target="_blank" rel="noreferrer">
            proof
          </a>
        </p>
      )}
      <div className="d-flex gap-2 mt-2">
        {words.expired && (
          <button type="button" className="btn btn-sm btn-primary" onClick={action.again}>
            {SIGN_AGAIN}
          </button>
        )}
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={action.dismiss}>
          {words.expired ? 'Not now' : 'OK'}
        </button>
      </div>
    </>
  );
}
