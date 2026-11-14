'use client';
// Funding from lenders on Home (FUNDING.md 8; INTERFACES.md 29): a card per lender the account has a position at, with
// a cushion bar in the style of the health bar, and the borrow panel's "Where it comes from". Stage 2 adds each card's
// two ways out, repaying that lender and taking collateral back, which open Home's side panels.
import { NetworkId } from '@/config';
import { useApi } from '@/hooks/use-api';
import { useFundingPlan } from '@/hooks/use-funding-plan';
import { LENDERS_PATH, type LenderName, type LenderPosition, type LendersAnswer, type LenderTerms, type Pricing } from '@/lib/api';
import { cushionExplained, lenderCard, looksAt, termsFor, toMicro, type PlanView } from '@/lib/funding';
import { cardRateNote, pricedPlan } from '@/lib/pricing';

/** What a lender card's buttons do. Without it, the cards only show. */
export interface LenderActions {
  /** Only the account's owner takes collateral back; repaying follows `repay`'s own rule. */
  isOwner: boolean;
  onRepay: (lender: LenderName) => void;
  onTakeBack: (lender: LenderName) => void;
}

/**
 * A card per lender, under the health bar and "Where your money is". `targetBp` is the cushion the engine borrows to.
 * `pricing` is the pool's policy for the account: when it changes what the client pays, the card says so under the rate.
 */
export function LenderCards({
  positions,
  targetBp,
  actions,
  pricing,
  postedWord = 'bitcoin',
  asOf,
}: {
  positions: LenderPosition[];
  targetBp: number;
  actions?: LenderActions;
  pricing?: Pricing | null;
  /** "as of the last check, about 40 minutes ago", once the check these figures come from is old (lib/borrow-page.ts). */
  asOf?: string | null;
  /** What the first card's lender holds, in a word, for the one explanation of "cushion": bitcoin, or ether on Aave's test market. */
  postedWord?: string;
}) {
  // The lender's chain and token names, when the backend has them. The cards read well without.
  const terms = useApi<LendersAnswer>(positions.length > 0 ? LENDERS_PATH : null);
  if (positions.length === 0) return null;
  return (
    <div className="pb-grid lenders mb-4">
      {positions.map((position, i) => (
        <LenderCardView
          key={position.l}
          position={position}
          terms={termsFor(terms.data?.lenders, position.l, NetworkId)}
          explain={i === 0 ? cushionExplained(targetBp, postedWord) : null}
          actions={actions}
          pays={cardRateNote(pricing, position.l, position.rate_bp, position.supply_bp)}
          asOf={asOf ?? null}
        />
      ))}
    </div>
  );
}

function LenderCardView({ position, terms, explain, actions, pays, asOf }: { position: LenderPosition; terms: LenderTerms | null; explain: string | null; actions?: LenderActions; pays: string | null; asOf: string | null }) {
  const card = lenderCard(position, terms);
  const titleId = `lender-${card.l}-title`;
  return (
    <section className="pb-card" aria-labelledby={titleId}>
      <div className="d-flex flex-wrap align-items-center gap-2">
        <h2 id={titleId} className="pb-card-title mb-0">
          {card.name}
        </h2>
        {card.where && <span className="small pb-muted">{card.where}</span>}
        <span className={`pb-pill ms-auto ${card.view.tone}`}>{card.view.label}</span>
      </div>
      <div className="pb-health-bar" aria-hidden="true">
        <div className="pb-cushion-zones">
          <div />
          <div />
          <div />
        </div>
        {card.view.marker !== null && <div className="pb-health-marker" style={{ left: `${card.view.marker}%` }} />}
      </div>
      <div className="pb-cushion-labels" aria-hidden="true">
        <span>Safe</span>
        <span>Thin</span>
        <span>Act</span>
      </div>
      <p className="mt-3 mb-1">{card.view.words}</p>
      <div className="small pb-muted mb-3">
        {card.sells}
        {explain && ` ${explain}`}
      </div>
      <dl className="pb-rows">
        <div>
          <dt>Posted there</dt>
          <dd>
            <span className="num">{card.posted}</span>
            <span className="sub">{card.postedSub}</span>
          </dd>
        </div>
        <div>
          <dt>Owed there</dt>
          <dd>
            <span className="num">{card.owed}</span>
            {card.room && <span className="sub">{card.room}</span>}
          </dd>
        </div>
        <div>
          <dt>Rate</dt>
          <dd>
            <span className="num">{card.rate}</span>
            {pays && <span className="sub">{pays}</span>}
          </dd>
        </div>
        <div>
          <dt>Cushion</dt>
          <dd>
            <span className="num">{card.cushion}</span>
            <span className="sub">{card.name} sells at 1.00</span>
          </dd>
        </div>
      </dl>
      {/* The card's figures are the last check's, not the lender's now: a repayment since then isn't in them yet. */}
      {asOf && <div className="small pb-muted mt-2">These figures are {asOf}. What you did since then shows after the next check.</div>}
      {actions && (
        <div className="d-flex flex-wrap gap-2 mt-3">
          <button type="button" className={`btn btn-sm ${card.view.tone === 'bad' ? 'btn-primary' : 'btn-outline-secondary'}`} disabled={toMicro(position.debt) <= 0n} onClick={() => actions.onRepay(position.l)}>
            Repay {card.name}
          </button>
          <button type="button" className="btn btn-sm btn-outline-secondary" disabled={!actions.isOwner || toMicro(position.posted) <= 0n} onClick={() => actions.onTakeBack(position.l)}>
            Take collateral back
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Under the borrow amount: each source of the loan, its amount and its rate, then the whole loan's rate. It asks the
 * engine a moment after the typing stops. A refusal, or an engine that doesn't know the question yet, shows nothing.
 * `pricing` is the pool's policy for the account: with one, each rate is what the client pays.
 */
export function WhereItComesFrom({ account, amount, pricing, posted }: { account: string; amount: string | null; pricing?: Pricing | null; posted?: Partial<Record<string, string>> }) {
  const plan = useFundingPlan(account, amount);
  const view = pricedPlan(plan.answer, pricing);
  return view ? <Sources view={view} stale={plan.stale} posted={posted} /> : null;
}

/**
 * The list itself. `stale` dims it while a new amount is being asked about. `posted` says what each lender looks at, in
 * a word, when the page knows: ether for Aave on its test market, where bitcoin is the default.
 */
export function Sources({ view, stale, posted }: { view: PlanView; stale: boolean; posted?: Partial<Record<string, string>> }) {
  return (
    <section className={`pb-sources mb-3${stale ? ' stale' : ''}`} aria-labelledby="sources-title" aria-busy={stale}>
      <h3 id="sources-title" className="pb-sources-title">
        Where it comes from
      </h3>
      <dl className="pb-rows">
        {view.rows.map((row) => (
          <div key={row.source}>
            <dt>
              <span>
                {row.name}
                <span className="sub">Against {looksAt(row.source, posted?.[row.source])}</span>
                {row.note && <span className="sub">{row.note}</span>}
              </span>
            </dt>
            <dd className="pb-sources-amount">
              <span className="num">{row.amount}</span>
              {row.rate && <span className="sub">at {row.rate} a year</span>}
            </dd>
          </div>
        ))}
        <div>
          <dt>
            <span className="fw-semibold">The whole loan</span>
          </dt>
          <dd>
            <span className="num fw-semibold">{view.total}</span>
            {view.rate && <span className="sub">at {view.rate} a year</span>}
          </dd>
        </div>
      </dl>
      {view.short && <div className="form-text">{view.short}</div>}
      <div className="form-text">
        A lender looks only at what is posted with it. Our pool looks at your whole hedged book. Each source lends at most what a fresh check allows when its step
        runs, so the amounts can come out a little lower.
      </div>
    </section>
  );
}
