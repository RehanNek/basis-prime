'use client';
// Home opens with the portfolio (INTERFACES.md 49.1 point 4): the account's value now, a chart of it over time, and
// under it where the money is, in one row. The chart is drawn here, as an SVG path, from GET /api/portfolio/:account:
// one point per check result the account has stored. With fewer than two points it shows the value and one line.
// Signed out (INTERFACES.md 50.1 point 1), the same card stands empty with the one "Sign in" button in it.
import { useApi } from '@/hooks/use-api';
import { portfolioPath, type PortfolioAnswer } from '@/lib/api';
import { changeWords, CHART_EMPTY_WORDS, chartPath, moneyRow, portfolioPoints } from '@/lib/portfolio';

const BOX = { width: 600, height: 120, pad: 10 };

const dollars = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

interface Props {
  accountId: string;
  /** What the account is worth now, in dollars, as Home works it out from live balances; null while a price is missing. */
  value: number | null;
  onNear: number | null;
  onHl: number | null;
  /** What is posted with lenders, and what sits at the account's address on a lender's chain, in dollars. */
  atLenders: number | null;
  /** The whole loan, in dollars. */
  owed: number;
}

export function PortfolioCard({ accountId, value, onNear, onHl, atLenders, owed }: Props) {
  const read = useApi<PortfolioAnswer>(portfolioPath(accountId), 60_000);
  const points = portfolioPoints(read.data);
  const shape = chartPath(points, BOX);
  // The value now is the live one; until its prices are read, the latest check's.
  const now = value ?? (points.length > 0 ? points[points.length - 1]!.v : null);
  const change = changeWords(points, when);
  const falling = shape !== null && points[points.length - 1]!.v < points[0]!.v;
  const stroke = falling ? 'var(--pb-bad)' : 'var(--pb-good)';

  return (
    <section className="pb-card mb-3" aria-labelledby="portfolio-title">
      <div className="d-flex flex-wrap align-items-baseline gap-2">
        <h2 id="portfolio-title" className="pb-card-title mb-0">
          Your portfolio
        </h2>
        <span className="small pb-muted">What you would keep if everything were sold today and the loan repaid.</span>
      </div>
      <div className="num" style={{ fontFamily: 'var(--pb-serif)', fontSize: '2.1rem', fontWeight: 600, lineHeight: 1.2 }}>
        {now === null ? '—' : dollars(now)}
      </div>
      {shape ? (
        <>
          <div className="small pb-muted mb-1">{change}</div>
          <svg viewBox={`0 0 ${BOX.width} ${BOX.height}`} preserveAspectRatio="none" role="img" aria-label={`The account’s value over time. ${change ?? ''}`} style={{ display: 'block', width: '100%', height: 120 }}>
            <path d={shape.area} fill={stroke} opacity={0.12} />
            <path d={shape.line} fill="none" stroke={stroke} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>
          <div className="d-flex justify-content-between small pb-muted">
            <span>{when(points[0]!.t)}</span>
            <span>
              Low {dollars(shape.min)} · High {dollars(shape.max)}
            </span>
            <span>{when(points[points.length - 1]!.t)}</span>
          </div>
        </>
      ) : (
        <div className="small pb-muted">{CHART_EMPTY_WORDS}</div>
      )}
      {/* Where the money is, in one row. The card below has each part in full. */}
      <div className="d-flex flex-wrap gap-4 mt-3 pt-3" style={{ borderTop: '1px solid var(--pb-line)' }}>
        {moneyRow({ onNear, onHl, atLenders, owed }).map((part) => (
          <div key={part.label}>
            <div className="small pb-muted">{part.label}</div>
            <div className="num fw-semibold">{part.value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The same card before a wallet connects (INTERFACES.md 50.1 point 1): no value, no chart, the row of places with
 * dashes, and the one button that signs in.
 */
export function PortfolioEmpty({ onSignIn }: { onSignIn: () => void }) {
  return (
    <section className="pb-card mb-3" aria-labelledby="portfolio-title">
      <div className="d-flex flex-wrap align-items-center gap-3">
        <div className="me-auto">
          <h2 id="portfolio-title" className="pb-card-title mb-0">
            Your portfolio
          </h2>
          <div className="num" style={{ fontFamily: 'var(--pb-serif)', fontSize: '2.1rem', fontWeight: 600, lineHeight: 1.2 }}>
            —
          </div>
          <div className="small pb-muted">Sign in with your NEAR wallet to see your account.</div>
        </div>
        <button type="button" className="btn btn-primary" onClick={onSignIn}>
          Sign in
        </button>
      </div>
      <div className="d-flex flex-wrap gap-4 mt-3 pt-3" style={{ borderTop: '1px solid var(--pb-line)' }}>
        {moneyRow({ onNear: null, onHl: null, atLenders: null, owed: null }).map((part) => (
          <div key={part.label}>
            <div className="small pb-muted">{part.label}</div>
            <div className="num fw-semibold">{part.value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
