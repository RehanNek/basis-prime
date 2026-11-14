'use client';
// What pb-risk would say now, before anyone pays for an on-chain check: the backend runs it in preview
// mode over OutLayer's HTTPS API (INTERFACES.md 7). A preview is stored nowhere and backs no action.
import { useState } from 'react';

import { VerdictCard } from '@/components/verdict-card';
import { ApiError, fundingPlan, preview, type PreviewAnswer } from '@/lib/api';
import type { Intent, Refusal, Verdict } from '@/lib/types';

/**
 * A loan that may come through a lender is asked for with the `fund` intent (INTERFACES.md 25). The backend's
 * /api/preview takes check, borrow and withdraw only, and answered a `fund` preview "Unknown intent fund" (seen in the
 * click-through of 13 Nov). The same engine run is behind POST /api/funding-plan, which also answers the verdict: so a
 * `fund` preview is read from there.
 */
async function previewOf(account: string, intent: Intent): Promise<PreviewAnswer> {
  if (!('fund' in intent)) return preview(account, intent);
  const plan = await fundingPlan(account, intent.fund.amount);
  if (!plan.verdict) throw new ApiError(502, 'no_verdict', 'The risk engine gave no answer for this preview. Try again.');
  const run = (plan.run ?? {}) as Partial<PreviewAnswer['run']>;
  return {
    account,
    intent,
    verdict: plan.verdict as Verdict | Refusal,
    run: { call_id: run.call_id ?? null, compute_cost: run.compute_cost ?? null, time_ms: run.time_ms ?? null, attestation_url: run.attestation_url ?? null },
    program: { project_id: '', version_key: null },
  };
}

export function usePreview() {
  const [answer, setAnswer] = useState<PreviewAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (account: string, intent: Intent) => {
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer(await previewOf(account, intent));
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return { run, answer, error, busy };
}

export function PreviewResult({ answer, error }: { answer: PreviewAnswer | null; error: string | null }) {
  if (error) return <div className="alert alert-warning small mt-2">Preview: {error}</div>;
  if (!answer) return null;
  const { run } = answer;
  return (
    <div className="mt-2">
      <VerdictCard verdict={answer.verdict} intent={answer.intent} title="Preview: what the risk engine would say now (free, stored nowhere)" />
      <p className="small text-body-secondary">
        Ran in {run.time_ms ?? '?'} ms in a sealed computer (OutLayer)
        {run.compute_cost && `, costing ${(Number(run.compute_cost) / 1e6).toFixed(4)} USD of our payment key`}
        {answer.program.version_key ? `, build ${answer.program.version_key.slice(0, 10)}…` : ', active build'}
        {run.attestation_url && (
          <>
            {' · '}
            <a href={run.attestation_url} target="_blank" rel="noreferrer">
              attestation
            </a>
          </>
        )}
      </p>
    </div>
  );
}
