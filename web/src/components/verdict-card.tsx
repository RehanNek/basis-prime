'use client';
// A verdict in plain words (RISK_ENGINE.md Appendix A): the state, the credit line and what sets it, the
// top risks, and, for a stored verdict, how long it can still back an action.
import { Tokens } from '@/config';
import type { Intent, Refusal, Verdict } from '@/lib/types';
import { beforePermissionChange, freshness, intentWords, summarizeVerdict, VERDICT_LIFETIME_BLOCKS } from '@/lib/verdict';

interface Props {
  verdict: Verdict | Refusal;
  /** What it answers. */
  intent?: Intent;
  title: string;
  /**
   * For a stored verdict: the account's counter and the current block height, and the block the lender permission
   * last changed in (`permission_blk`; missing on an account from before the audit fix).
   */
  stored?: { counter: number; height: number; permissionBlk?: number };
}

export function VerdictCard({ verdict, intent, title, stored }: Props) {
  const summary = summarizeVerdict(verdict);
  return (
    <div className="card mb-3">
      <div className="card-header d-flex flex-wrap align-items-center gap-2">
        <span className="fw-semibold">{title}</span>
        {summary.state && <span className={`badge text-bg-${summary.state.tone}`}>{summary.state.label}</span>}
        {intent && <span className="small text-body-secondary">answers {intentWords(intent, Tokens)}</span>}
      </div>
      <div className="card-body small">
        <p className="mb-2">{summary.headline}</p>
        {summary.state?.words && <p className="text-body-secondary mb-2">{summary.state.words}</p>}
        {summary.action && <p className="mb-2 fw-semibold">{summary.action}</p>}
        {summary.facts.length > 0 && (
          <dl className="row mb-2">
            {summary.facts.map((fact) => (
              <div key={fact.label} className="col-sm-6 d-flex gap-2">
                <dt className="fw-normal text-body-secondary">{fact.label}</dt>
                <dd className="mb-1">{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {summary.risks.length > 0 && (
          <>
            <div className="text-body-secondary">The biggest risks:</div>
            <ol className="mb-2">
              {summary.risks.map((risk) => (
                <li key={risk}>{risk}</li>
              ))}
            </ol>
          </>
        )}
        {summary.warnings.map((warning) => (
          <div key={warning} className="text-warning-emphasis">
            {warning}
          </div>
        ))}
        {stored && verdict.ok && (
          <Freshness verdict={verdict} counter={stored.counter} height={stored.height} beforeChange={Boolean(intent && 'fund' in intent) && beforePermissionChange(verdict.blk, stored.permissionBlk)} />
        )}
      </div>
    </div>
  );
}

function Freshness({ verdict, counter, height, beforeChange }: { verdict: Verdict; counter: number; height: number; beforeChange: boolean }) {
  const age = freshness(verdict.blk, height);
  const used = verdict.nonce !== counter;
  return (
    <p className="mb-0 mt-2">
      The engine read block {verdict.blk.toLocaleString()}; a check lasts {VERDICT_LIFETIME_BLOCKS} blocks, about a minute.{' '}
      {used ? (
        <span className="badge text-bg-secondary">Used: the counter has moved on</span>
      ) : beforeChange ? (
        // INTERFACES.md 40.1: a check for a loan read before the permission last changed backs no loan.
        <span className="badge text-bg-secondary">From before the permission changed: a new loan needs a new check</span>
      ) : age.fresh ? (
        <span className={`badge text-bg-${age.blocksLeft < 20 ? 'warning' : 'success'}`}>
          Fresh for {age.blocksLeft} more blocks (about {age.secondsLeft} s)
        </span>
      ) : (
        <span className="badge text-bg-secondary">Expired {age.age - VERDICT_LIFETIME_BLOCKS} blocks ago</span>
      )}
    </p>
  );
}
