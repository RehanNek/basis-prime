'use client';
// The book (PLAN.md 5.8): a public, read-only view of the broker's pool, from its get_pool and get_params.
// No wallet needed. Phase 3 adds the operator's controls below it (KYB flags, co-signing, pause, coin status),
// shown only to the operator's wallet (components/operator-panel.tsx). Phase 5 adds the daily stress test of the
// whole book (INTERFACES.md 19), which the keeper runs in pb-risk and the backend reads back. Phase 6, stage 2
// (INTERFACES.md 26 and 29) adds funding from lenders: the source order, what each client pays, the fees earned, the
// subsidies paid and what is lent through each lender, from GET /api/pricing, and the operator's controls for them.
import type { ReactNode } from 'react';

import { ApiProblem, NotDeployed } from '@/components/notices';
import { OperatorPanel } from '@/components/operator-panel';
import { accountUrl, PoolContract } from '@/config';
import { useApi } from '@/hooks/use-api';
import { BOOK_STRESS_PATH, POOL_PATH, PRICING_PATH, type BookStressAnswer, type BookStressLine, type BookStressResult, type PoolAnswer, type PricingAnswer } from '@/lib/api';
import { pricingBook, type PricingBook } from '@/lib/pricing';
import { riskWords } from '@/lib/risk';
import type { Exposure, ParamsView, PoolView } from '@/lib/types';
import { formatBp, formatUsd } from '@/lib/units';

export function BookView() {
  const pool = useApi<PoolAnswer>(POOL_PATH, 15_000);
  // Phase 6: the pool's pricing. A backend or a pool without it answers an error, which shows as nothing.
  const pricing = useApi<PricingAnswer>(PRICING_PATH, 30_000);
  const answer = pool.data;
  // The pool's capital gives the dollar figure in its daily limit on fees (INTERFACES.md 45.1).
  const book = pricingBook(pricing.data, answer?.deployed ? answer.pool.capital : null);
  return (
    <main className="pb-container pb-page" style={{ maxWidth: 1040 }}>
      <h1 className="h3">Book</h1>
      <p className="lead">
        The broker&apos;s pool lends only the broker&apos;s own capital. Everything here is read from{' '}
        <a href={accountUrl(PoolContract)} target="_blank" rel="noreferrer">
          {PoolContract}
        </a>{' '}
        on chain.
      </p>
      <ApiProblem error={pool.error} />
      {pool.loading && <p className="text-body-secondary">Reading the pool…</p>}
      {answer && !answer.deployed && <NotDeployed contracts={[answer.pool_id]} what="The book fills in once the pool is live on testnet." />}
      {answer?.deployed && <Book pool={answer.pool} params={answer.params} height={answer.block_height} />}
      {book && <Lenders book={book} />}
      <StressTest />
      {answer?.deployed && <OperatorPanel poolId={answer.pool_id} pool={answer.pool} params={answer.params} pricing={pricing.data} onPricingChanged={pricing.reload} />}
    </main>
  );
}

/**
 * Funding from lenders (FUNDING.md 5 and 8; INTERFACES.md 26): where loans come from, what each client pays on a
 * lender's part, and what that has earned or cost the pool.
 */
function Lenders({ book }: { book: PricingBook }) {
  return (
    <section className="card mt-3" aria-labelledby="lenders-title">
      <div className="card-header fw-semibold" id="lenders-title">
        Funding from lenders
      </div>
      <div className="card-body small">
        <p className="text-body-secondary mb-3">
          Part of a client&apos;s loan can come from an outside lender, which looks only at the bitcoin posted with it. Our pool lends the rest against the whole hedged book.
          The operator sets what the client pays on the lender&apos;s part, and each hour the pool settles the difference with the client: a fee when the client pays more
          than the lender charges, a subsidy when the client pays less.
        </p>
        <div className="row g-4">
          <div className="col-lg-6">
            <h3 className="h6">Where loans come from</h3>
            <Rows
              rows={[
                ['Source order', book.order],
                ['A loan is expected to last', book.loanDays],
                ...(book.lent.length > 0 ? book.lent.map((l): [string, string] => [`Lent through ${l.name}`, l.amount]) : [['Lent through a lender', 'Nothing now'] as [string, string]]),
              ]}
            />
          </div>
          <div className="col-lg-6">
            <h3 className="h6">Fees and subsidies</h3>
            <Rows
              rows={[
                ['Fees earned', book.fees],
                ['Subsidies paid', book.subsidy],
                ['Left of today’s subsidy budget', book.subsidyLeft],
              ]}
            />
          </div>
        </div>
        {book.limits && <p className={`text-body-secondary ${book.feeLimits.length > 0 ? 'mb-1' : ''}`}>{book.limits}</p>}
        {/* INTERFACES.md 45.1: what a settlement's fee can be at most. A pool from before these limits shows none. */}
        {book.feeLimits.length > 0 && (
          <ul className="text-body-secondary ps-3">
            {book.feeLimits.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}

        <h3 className="h6">What each tier pays on a lender&apos;s part</h3>
        <Rows rows={book.tiers.map((t): [string, string] => [t.name, t.own ? t.pays : `${t.pays} (the default)`])} />

        <h3 className="h6">By account</h3>
        {book.accountsHidden ? (
          // Privacy level 1 (INTERFACES.md 48.6): the backend keeps the per-account list for the operator.
          <p className="text-body-secondary mb-0">The per-client lines show only to the operator.</p>
        ) : book.accounts.length === 0 ? (
          <p className="text-body-secondary mb-0">No account has a policy of its own or a loan through a lender yet.</p>
        ) : (
          <div className="table-responsive">
            <table className="table table-sm mb-0">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Pays</th>
                  <th>Lent through</th>
                  <th className="text-end">Fees</th>
                  <th className="text-end">Subsidies</th>
                  <th className="text-end">Credit owed back</th>
                  <th>Last settled</th>
                </tr>
              </thead>
              <tbody>
                {book.accounts.map((a) => (
                  <tr key={a.account}>
                    <td className="text-break">{a.account}</td>
                    <td>
                      {a.pays}
                      <div className="text-body-secondary">{a.from}</div>
                    </td>
                    <td>{a.lent.length > 0 ? a.lent.map((l) => <div key={l}>{l}</div>) : '—'}</td>
                    <td className="text-end font-monospace">{a.fees}</td>
                    <td className="text-end font-monospace">{a.subsidy}</td>
                    <td className="text-end font-monospace">{a.credit}</td>
                    <td>{a.settledAtMs ? new Date(a.settledAtMs).toLocaleString() : 'Not yet'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function Book({ pool, params, height }: { pool: PoolView; params: ParamsView; height: number }) {
  const caps = params.caps;
  return (
    <>
      {pool.paused && <div className="alert alert-danger">The pool is paused: no new loans. Repaying still works.</div>}
      <div className="row g-3 mb-3">
        <Stat label="Capital" value={formatUsd(pool.capital)} note="cash + loans out, with interest" />
        <Stat label="Cash" value={formatUsd(pool.cash)} />
        <Stat label="Loans out" value={formatUsd(pool.loans)} />
        <Stat label="Utilisation" value={formatBp(pool.utilisation_bp)} note={`at most ${formatBp(caps.max_utilisation_bp)} after a loan`} />
      </div>

      <div className="row g-3">
        <Panel title="Rates now, a year">
          <Rows
            rows={[
              ['Preferred', formatBp(pool.rate_bp.preferred)],
              ['Standard', formatBp(pool.rate_bp.standard)],
              ['Watch', formatBp(pool.rate_bp.watch)],
            ]}
          />
          <p className="text-body-secondary mb-0">
            The base rate rises from 0 to {formatBp(params.rates.at_kink_bp)} at {formatBp(params.rates.kink_bp)} utilisation, then to{' '}
            {formatBp(params.rates.at_full_bp)} at 100%, plus the tier&apos;s spread.
          </p>
        </Panel>
        <Panel title="Earnings and losses">
          <Rows
            rows={[
              ['Interest earned', formatUsd(pool.interest_earned)],
              ['Written off', formatUsd(pool.written_off)],
              ['Funded by the broker', formatUsd(pool.funded)],
              ['Taken back', formatUsd(pool.defunded)],
            ]}
          />
        </Panel>
        <Panel title="The last 24 hours">
          <Rows
            rows={[
              ['New lending, less repayments', formatUsd(pool.lent_24h)],
              [`Daily budget (${formatBp(pool.daily_budget_bp)} of capital)`, formatUsd(pool.daily_budget)],
            ]}
          />
          {pool.pending_budget && (
            <p className="text-body-secondary mb-0">
              A new budget of {formatBp(pool.pending_budget.bp)} applies from {new Date(Number(BigInt(pool.pending_budget.from) / 1_000_000n)).toLocaleString()}.
            </p>
          )}
        </Panel>
        <Panel title="Exposures against their caps">
          <Rows
            rows={[
              ...Object.entries(pool.wrappers).map(([token, e]): [string, string] => [`Loans resting on ${token}`, exposure(e)]),
              ['Loans resting on Hyperliquid', exposure(pool.hyperliquid)],
              ...Object.entries(pool.book).map(([token, e]): [string, string] => [`${token} held by accounts with a loan`, exposure(e)]),
            ]}
          />
        </Panel>
        <Panel title="The pool's own limits">
          <Rows
            rows={[
              ["A new account's first week", formatUsd(caps.new_account_limit)],
              ['One client', `${formatBp(caps.client_share_bp)} of capital`],
              ['Ceiling: Preferred / Standard / Watch', `${formatUsd(caps.ceiling.preferred)} / ${formatUsd(caps.ceiling.standard)} / ${formatUsd(caps.ceiling.watch)}`],
              ['Co-signature for a borrow above', formatUsd(caps.cosign_borrow_above)],
              ['Co-signature for plan steps above, per day', formatUsd(caps.cosign_steps_above)],
            ]}
          />
        </Panel>
        <Panel title="Who runs it">
          <Rows
            rows={[
              ['Operator', params.operator],
              ['Factory', params.factory],
              ['Lends', params.token],
              ['Read at block', height.toLocaleString()],
            ]}
          />
        </Panel>
      </div>
    </>
  );
}

/**
 * The book stress test (RISK_ENGINE.md 12.1, last row; INTERFACES.md 19): every account with a loan, its scenarios run
 * together, selling the book's total size per coin. The pool's loss on the worst extreme day must stay within 2.5% of
 * its capital. The keeper runs it once a day in pb-risk, in OutLayer's enclave.
 */
function StressTest() {
  const read = useApi<BookStressAnswer>(BOOK_STRESS_PATH, 60_000);
  const data = read.data;
  const latest = data?.latest ?? null;
  const shown = data?.last_result ?? null;
  return (
    <section className="card mt-3">
      <div className="card-header fw-semibold">Book stress test</div>
      <div className="card-body small">
        <p className="text-body-secondary mb-2">
          Every account with a loan, its crash scenarios run together, with the selling costs of the whole book at once, since our clients would be
          selling together. The pool&apos;s loss on the worst extreme day must stay within 2.5% of its capital. The keeper runs it in pb-risk once a day.
        </p>
        {read.error && <div className="alert alert-warning py-1 px-2">{read.error.message}</div>}
        {data && !data.log_found && <p className="mb-0">It hasn&apos;t run yet: the keeper runs it at start, then once a day.</p>}
        {latest && !latest.ok && (
          <p className="text-warning-emphasis mb-2">
            The last attempt, {new Date(latest.t).toLocaleString()}, gave no result: {latest.error ?? 'no reason given'}.{shown ? ' The last result is below.' : ''}
          </p>
        )}
        {shown && shown.result && shown.result.ok && <StressResult line={shown} result={shown.result as BookStressResult} />}
      </div>
    </section>
  );
}

function StressResult({ line, result }: { line: BookStressLine; result: BookStressResult }) {
  return (
    <>
      <p className="mb-2">
        <span className={`badge text-bg-${result.pass ? 'success' : 'danger'} me-1`}>{result.pass ? 'Pass' : 'Fail'}</span>
        Run {new Date(line.t).toLocaleString()} over {result.accounts.length} account(s) with a loan, at block {result.blk.toLocaleString()}.{' '}
        {result.worst ? (
          <>
            The worst scenario would cost the pool <strong>{formatUsd(result.worst.pool_loss)}</strong>, against a limit of {formatUsd(result.limit)} (2.5% of its{' '}
            {formatUsd(result.capital)} of capital): {riskWords(result.worst.scenario)}.
          </>
        ) : result.accounts.length === 0 ? (
          <>No account has a loan, so nothing is at risk.</>
        ) : (
          <>No scenario costs the pool anything.</>
        )}
      </p>
      {result.top.length > 0 && (
        <table className="table table-sm mb-2">
          <thead>
            <tr>
              <th>The worst scenarios (at most five)</th>
              <th className="text-end">Pool loss</th>
            </tr>
          </thead>
          <tbody>
            {result.top.map((t) => (
              <tr key={t.scenario}>
                <td>{riskWords(t.scenario)}</td>
                <td className="text-end font-monospace">{formatUsd(t.pool_loss)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mb-0 text-body-secondary">
        Loans out {formatUsd(result.loans)}.{line.program?.version_key ? ` Risk engine version ${line.program.version_key.slice(0, 12)}….` : ''}{' '}
        {line.attestation_url && (
          <a href={line.attestation_url} target="_blank" rel="noreferrer">
            OutLayer&apos;s attestation of this run
          </a>
        )}
      </p>
    </>
  );
}

function exposure(e: Exposure): string {
  return `${formatUsd(e.amount)} of ${formatUsd(e.cap)}`;
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="col-sm-6 col-lg-3">
      <div className="border rounded p-3 h-100">
        <div className="small text-body-secondary">{label}</div>
        <div className="fs-5 font-monospace">{value}</div>
        {note && <div className="small text-body-secondary">{note}</div>}
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="col-lg-6">
      <section className="card h-100">
        <div className="card-header fw-semibold">{title}</div>
        <div className="card-body small">{children}</div>
      </section>
    </div>
  );
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <table className="table table-sm mb-2">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <td>{label}</td>
            <td className="text-end font-monospace">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
