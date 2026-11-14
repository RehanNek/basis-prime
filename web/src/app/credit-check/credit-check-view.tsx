'use client';
// The credit check (PLAN.md 2, step 1; INTERFACES.md 18 and 22): any mainnet Hyperliquid address, or the worked
// example, plus spot tokens, and what our pool would lend against the whole book next to what Rhea would lend against
// the spot alone. No wallet. pb-risk reads mainnet in OutLayer's enclave; nothing is signed or paid on mainnet.
import { useState, type ReactNode } from 'react';

import { ApiProblem } from '@/components/notices';
import { api, ApiError, CREDIT_EXAMPLE_PATH, creditCheck, type CreditAnswer, type CreditExample, type CreditFunding, type SpotToken } from '@/lib/api';
import { checkSteps, creditRequest, creditView, exampleRows, exampleWords, MAX_SPOT_ROWS, SPOT_TOKENS, type CreditView, type SpotRow } from '@/lib/credit';
import { useNow } from '@/hooks/use-now';
import { fundingView } from '@/lib/funding';
import { stillWaitingWords } from '@/lib/outlayer';

export function CreditCheckView() {
  return (
    <main className="pb-container pb-page" style={{ maxWidth: 1040 }}>
      <h1 className="h3">Credit check</h1>
      <p className="lead">
        What our pool would lend against a whole hedged book, next to what Rhea would lend against the spot tokens alone. Paste any
        Hyperliquid address from mainnet, or try the worked example. No wallet needed.
      </p>
      <CreditCheck />
    </main>
  );
}

function CreditCheck() {
  const [address, setAddress] = useState(() => (typeof window === 'undefined' ? '' : (new URLSearchParams(window.location.search).get('address') ?? '')));
  const [example, setExample] = useState<CreditExample | null>(null);
  const [rows, setRows] = useState<SpotRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // When the check was sent: past a minute the line under the button names OutLayer and says how long it has waited.
  const [since, setSince] = useState<number | null>(null);
  const now = useNow();
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [answer, setAnswer] = useState<CreditAnswer | null>(null);

  const { request, problems } = creditRequest({ address, book: example?.book ?? null, rows });
  const setRow = (i: number, patch: Partial<SpotRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const unused = SPOT_TOKENS.find((t) => !rows.some((r) => r.token === t.token))?.token ?? 'USDC';

  const useExample = async () => {
    setBusy('Reading today’s BTC price from Hyperliquid mainnet…');
    setError(undefined);
    try {
      const next = await api<CreditExample>(CREDIT_EXAMPLE_PATH);
      setExample(next);
      setRows(exampleRows(next));
    } catch (failure) {
      setError(failure instanceof ApiError ? failure : new ApiError(0, 'error', String(failure)));
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    if (!request) return;
    setBusy('The risk engine is reading Hyperliquid mainnet, the prices, a 1Click quote and Rhea, inside a sealed computer (OutLayer): about 10 seconds…');
    setSince(now);
    setError(undefined);
    try {
      setAnswer(await creditCheck(request));
    } catch (failure) {
      setError(failure instanceof ApiError ? failure : new ApiError(0, 'error', String(failure)));
    } finally {
      setBusy(null);
      setSince(null);
    }
  };

  return (
    <>
      <section className="card mb-3">
        <div className="card-body">
          {example ? (
            <div className="mb-3">
              <div className="small text-body-secondary">The worked example</div>
              <p className="mb-1">{exampleWords(example)}</p>
              <button
                className="btn btn-sm btn-link px-0"
                onClick={() => {
                  setExample(null);
                  setRows([]);
                }}
              >
                Use a Hyperliquid address instead
              </button>
            </div>
          ) : (
            <div className="mb-3">
              <label className="form-label small text-body-secondary" htmlFor="hl-address">
                Hyperliquid address (mainnet)
              </label>
              <input
                id="hl-address"
                className="form-control font-monospace"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="0x…"
                autoComplete="off"
                spellCheck={false}
              />
              <div className="form-text">
                Its perps, margin and open orders are read from Hyperliquid mainnet.{' '}
                <button className="btn btn-sm btn-link p-0 align-baseline" onClick={useExample} disabled={Boolean(busy)}>
                  Or use the worked example
                </button>
                : $100,000 of nBTC hedged by a $100,000 BTC short, with $35,000 of margin.
              </div>
            </div>
          )}

          <div className="small text-body-secondary mb-1">Spot tokens on NEAR (optional, at most {MAX_SPOT_ROWS})</div>
          {rows.map((row, i) => (
            <div key={i} className="d-flex gap-2 mb-2" style={{ maxWidth: 480 }}>
              <select className="form-select form-select-sm" style={{ maxWidth: 120 }} value={row.token} onChange={(e) => setRow(i, { token: e.target.value as SpotToken })} aria-label="Token">
                {SPOT_TOKENS.map((t) => (
                  <option key={t.token} value={t.token}>
                    {t.label}
                  </option>
                ))}
              </select>
              <input className="form-control form-control-sm" value={row.amount} onChange={(e) => setRow(i, { amount: e.target.value })} placeholder="amount" aria-label="Amount" inputMode="decimal" />
              <button className="btn btn-sm btn-outline-secondary" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove this token">
                ✕
              </button>
            </div>
          ))}
          {rows.length < MAX_SPOT_ROWS && (
            <button className="btn btn-sm btn-outline-secondary mb-3" onClick={() => setRows([...rows, { token: unused, amount: '' }])}>
              Add a spot token
            </button>
          )}

          {problems.length > 0 && (address || example || rows.some((r) => r.amount)) && (
            <ul className="small text-danger mb-2">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="d-flex flex-wrap align-items-center gap-2">
            <button className="btn btn-primary" disabled={!request || Boolean(busy)} onClick={run}>
              Check
            </button>
            <span className="small text-body-secondary">
              Each new check is a paid run in a sealed computer (OutLayer), so a few a minute at most. The same check within a minute answers from the first run.
            </span>
          </div>
          {busy && <p className="small mt-2 mb-0">{(since !== null ? stillWaitingWords((now - since) / 1000) : null) ?? busy}</p>}
        </div>
      </section>
      <ApiProblem error={error} />
      {answer && <CreditResultView answer={answer} />}
    </>
  );
}

/** A credit check's answer in words. The development preview shows it from sample data too. */
export function CreditResultView({ answer }: { answer: CreditAnswer }) {
  const view = creditView(answer);
  const when = new Date(answer.computed_at_ms).toLocaleString();
  return (
    <>
      <p className="small text-body-secondary">
        Computed {when}
        {answer.cached ? `, ${answer.age_s} s ago, by the same check run then` : ''}. The risk engine&apos;s own answer, in words.
      </p>
      {!view.ok ? (
        <div className="alert alert-warning">The risk engine gave no result: {view.refusal}</div>
      ) : (
        <>
          <div className="row g-3 mb-3">
            <Ours view={view} />
            <Rhea view={view} />
          </div>
          {view.warnings.map((w) => (
            <div key={w} className="alert alert-warning py-2 small">
              {w}
            </div>
          ))}
          <Funding funding={answer.result.ok === true ? answer.result.funding : undefined} />
          <div className="row g-3 mb-3">
            <Card title="The biggest risks, in words">
              {view.risks.length ? (
                <ol className="mb-0">
                  {view.risks.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ol>
              ) : (
                <p className="mb-0">None named.</p>
              )}
            </Card>
            <Card title="Left out, and why">
              {view.unlisted.coins.length > 0 && (
                <p className="mb-2">
                  Coins outside the allow-list: {view.unlisted.coins.join(', ')}
                  {view.unlisted.more > 0 ? ` and ${view.unlisted.more} more` : ''}. A position or order in one sets the line to $0. {view.unlisted.without}
                </p>
              )}
              {view.ignored.length > 0 ? (
                <ul className="mb-0">
                  {view.ignored.map((i) => (
                    <li key={i.what}>
                      <strong>{i.what}</strong>: {i.why}
                    </li>
                  ))}
                </ul>
              ) : (
                view.unlisted.coins.length === 0 && <p className="mb-0">Nothing: every position and token was counted.</p>
              )}
            </Card>
          </div>
          <div className="row g-3 mb-3">
            <Card title="Prices and π used">
              <p className="mb-2 text-body-secondary">Reference prices are the median of up to six sources (RISK_ENGINE.md 3.2); π is what 1 bridged token is worth in what it wraps.</p>
              <table className="table table-sm mb-0">
                <tbody>
                  {view.prices.map((p) => (
                    <tr key={p.coin}>
                      <td>{p.coin}</td>
                      <td className="text-end font-monospace">{p.price}</td>
                    </tr>
                  ))}
                  {view.pi.map((p) => (
                    <tr key={p.token}>
                      <td>π {p.token}</td>
                      <td className="text-end">
                        <span className="font-monospace">{p.ratio}</span> <span className="text-body-secondary">({p.source})</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <CheckIt answer={answer} />
          </div>
        </>
      )}
    </>
  );
}

function Ours({ view }: { view: CreditView }) {
  const o = view.ours!;
  return (
    <Card title="Our pool" tone="primary">
      <div className="fs-4 font-monospace">{o.line}</div>
      <p className="mb-2">
        is the credit line: the most a new account with this book may owe. In its first week the pool lends at most {o.firstWeek}
        {o.firstWeekBinds ? ', so that is what it lends now' : ''}.
      </p>
      <Rows
        rows={[
          ['What sets the line', o.sets],
          ['Score and tier', `${o.score}, ${o.tier}`],
          ['Rate now', `${o.rateNow} a year, with the test pool ${o.util} lent out`],
          ['Rate at 60% lent out', `${o.rateAt60} a year`],
        ]}
      />
      <p className="mb-0 text-body-secondary">
        The line counts the whole book: the hedge on Hyperliquid and the spot on NEAR together, with a safety buffer before anything is sold. The terms are
        the testnet pool&apos;s, the only pool that exists.
      </p>
    </Card>
  );
}

function Rhea({ view }: { view: CreditView }) {
  const r = view.rhea!;
  return (
    <Card title="Rhea alone">
      {r.error ? (
        <p className="text-warning-emphasis">Rhea&apos;s terms could not be read: {r.error}</p>
      ) : (
        <>
          <div className="fs-4 font-monospace">{r.safe}</div>
          <p className="mb-2">
            is what Rhea would lend against the spot tokens alone and still keep a health factor of 1.2. At its most, {r.max}, the position is
            liquidated on the first move against it. Rhea can&apos;t see Hyperliquid, so the hedge counts for nothing there.
          </p>
          <Rows
            rows={[
              ['USDC borrow rate now', `${r.usdcRate} a year`],
              ...r.rows.map((t): [string, string] => [t.token, t.collateral ? `${t.value}, counted at ${t.ratio}` : `${t.value}, not taken as collateral`]),
            ]}
          />
          <p className="mb-0 text-body-secondary">
            Read from {r.contract} on mainnet at block {r.blk.toLocaleString()}, valued at our reference prices.
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * "How this loan would be funded" (INTERFACES.md 27 and 29): the line with each lender and our pool, what the whole
 * loan would cost, and the one the engine would use. A result with no `funding` (an older engine) shows nothing.
 */
function Funding({ funding }: { funding: CreditFunding | undefined }) {
  const view = fundingView(funding);
  if (!view) return null;
  return (
    <section className="card mb-3" aria-labelledby="funding-title">
      <div className="card-header fw-semibold" id="funding-title">
        How this loan would be funded
      </div>
      <div className="card-body small">
        <p className="mb-2">{view.intro}</p>
        <p className="mb-2 text-body-secondary">{view.cushion}</p>
        <p className="mb-3 fw-semibold">{view.choice}</p>
        <div className="row g-3">
          {view.lenders.map((lender) => (
            <div key={lender.l} className="col-12 col-lg-6">
              <div className={`pb-funding${lender.used ? ' used' : ''}`}>
                <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
                  <h3 className="h6 mb-0">{lender.name}</h3>
                  <span className="text-body-secondary">{lender.where}</span>
                  <span className={`pb-pill ms-auto ${lender.used ? 'good' : 'neutral'}`}>{lender.used ? 'The engine would use this' : 'Not used'}</span>
                </div>
                <p className="mb-2 pb-funding-lead">{lender.headline}</p>
                {lender.rows.length > 0 && <Rows rows={lender.rows} />}
                {/* Stage 3: the bitcoin's trip there and back, in dollars, against what the lender's lower rate saves. */}
                {lender.trip && <p className="mb-2">{lender.trip}</p>}
                {lender.why ? (
                  <p className="mb-0">
                    <span className="fw-semibold">{lender.used ? 'Why this one: ' : 'Why not: '}</span>
                    {lender.why}
                  </p>
                ) : (
                  <p className="mb-0">{lender.move}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CheckIt({ answer }: { answer: CreditAnswer }) {
  return (
    <Card title="Check it yourself">
      {answer.run.attestation_url && (
        <p className="mb-2">
          <a href={answer.run.attestation_url} target="_blank" rel="noreferrer">
            OutLayer&apos;s attestation of this run
          </a>
        </p>
      )}
      <ol className="mb-0 text-break">
        {checkSteps(answer).map((s) => (
          <li key={s} className="mb-1">
            {s}
          </li>
        ))}
      </ol>
    </Card>
  );
}

function Card({ title, tone, children }: { title: string; tone?: 'primary'; children: ReactNode }) {
  return (
    <div className="col-12 col-lg-6">
      <section className={`card h-100 ${tone ? `border-${tone}` : ''}`}>
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
            <td className="text-body-secondary">{label}</td>
            <td className="text-end">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
