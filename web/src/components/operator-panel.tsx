'use client';
// The operator's controls on the Book page (PLAN.md 5.8; INTERFACES.md 12): KYB flags, co-signing a large borrow,
// pausing, and coin statuses. Each is a pool method only the operator may call (contracts/pool/src/admin.rs), so
// the panel shows only to the operator's wallet, and that wallet signs. Each change logs a public event.
// Phase 6, stage 2 (INTERFACES.md 26): what a client pays on a lender's part of a loan, for one account or a whole tier
// (`set_pricing`), and the source order with the loan life (`set_funding`).
import { useState } from 'react';

import { TxStatus } from '@/components/tx-status';
import { UsdcToken } from '@/config';
import { useApi } from '@/hooks/use-api';
import { useTx } from '@/hooks/use-tx';
import { MARKETS_PATH, type FundingOrder, type MarketsAnswer, type PricingAnswer, type PricingLimits, type PricingTarget } from '@/lib/api';
import { isAccountId } from '@/lib/names';
import { FUNDING_ORDERS, fundingFromForm, orderWords, periodWords, pricingExample, pricingFromForm, pricingWords, targetWords, tierName, TIERS, type PolicyKind } from '@/lib/pricing';
import { cosignBorrowTx, setCoinStatusTx, setFundingTx, setKybTx, setPausedTx, setPricingTx, type CoinStatus } from '@/lib/tx';
import type { ParamsView, PoolView, Tier } from '@/lib/types';
import { formatUsd, parseUnits } from '@/lib/units';
import { useNearWallet } from '@/providers/near-provider';

/** The pool's bridged tokens are allowed or frozen; coins are allowed, reduce-only or removed (admin.rs). */
const COIN_STATUSES: CoinStatus[] = ['allowed', 'reduce_only', 'removed'];
const TOKEN_STATUSES: CoinStatus[] = ['allowed', 'frozen'];

interface Props {
  poolId: string;
  pool: PoolView;
  params: ParamsView;
  /** GET /api/pricing, when the backend and the pool have it: the pricing controls show only then. */
  pricing?: PricingAnswer;
  /** Called after a pricing change, to read it again. */
  onPricingChanged?: () => void;
}

export function OperatorPanel({ poolId, pool, params, pricing, onPricingChanged }: Props) {
  const { signedAccountId } = useNearWallet();
  if (signedAccountId !== params.operator) return null;
  const funding = pricing?.funding ?? params.funding;
  return (
    <section className="card mt-3 border-warning">
      <div className="card-header fw-semibold">Operator: {params.operator}</div>
      <div className="card-body small">
        <p>Only the operator can make these changes. The wallet signs each one, and the pool logs it as a public event.</p>
        <div className="row g-4">
          <div className="col-lg-6">
            <Pause poolId={poolId} paused={pool.paused} />
            <Kyb poolId={poolId} />
            <Cosign poolId={poolId} threshold={params.caps.cosign_borrow_above} />
          </div>
          <div className="col-lg-6">
            <CoinStatuses poolId={poolId} tokens={Object.keys(params.caps.wrapper_cap_bp)} />
          </div>
          {funding && (
            <>
              <div className="col-lg-6">
                <PricingPolicy poolId={poolId} limits={pricing?.limits} onChanged={onPricingChanged} />
              </div>
              <div className="col-lg-6">
                {/* Keyed by the stored settings, so the form starts again from them after a change. */}
                <FundingOrderForm key={`${funding.order}:${funding.loan_days}`} poolId={poolId} order={funding.order} loanDays={funding.loan_days} onChanged={onPricingChanged} />
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** Two lenders to picture a policy with: a cheap one and a dear one, each with what it pays its own depositors (FUNDING.md 2). */
const EXAMPLES = [
  { rate_bp: 533, supply_bp: 410 },
  { rate_bp: 1_591, supply_bp: 1_032 },
];

const POLICY_KINDS: { kind: PolicyKind; label: string }[] = [
  { kind: 'pass_through', label: 'Each source at its own rate' },
  { kind: 'lender', label: 'The lender’s rate, with a margin or a cap' },
  { kind: 'fixed', label: 'One rate on the whole loan' },
];

/** `set_pricing(target, pricing)`: what one account, or every account of a tier, pays on a lender's part of a loan. */
function PricingPolicy({ poolId, limits, onChanged }: { poolId: string; limits?: PricingLimits | null; onChanged?: () => void }) {
  const [scope, setScope] = useState<'account' | 'tier'>('account');
  const [account, setAccount] = useState('');
  const [tier, setTier] = useState<Tier>('STANDARD');
  const [kind, setKind] = useState<PolicyKind>('lender');
  const [margin, setMargin] = useState('');
  const [cap, setCap] = useState('');
  const [rate, setRate] = useState('');
  const tx = useTx();
  const target: PricingTarget | null = scope === 'tier' ? { tier } : isAccountId(account.trim()) ? { account: account.trim() } : null;
  const { pricing, problem } = pricingFromForm({ kind, margin, cap, rate });
  const send = async (label: string, next: typeof pricing) => {
    if (!target) return;
    await tx.run(label, setPricingTx(poolId, target, next));
    onChanged?.();
  };
  return (
    <div className="mb-3">
      <h3 className="h6">What a client pays</h3>
      <p className="mb-1">
        On the part of a loan that comes from a lender. An account&apos;s own policy wins, then its tier&apos;s; with neither, each source is paid at its own rate. One
        rate on the whole loan covers our pool&apos;s part too.
      </p>
      <div className="d-flex flex-wrap gap-2 mb-2">
        <select className="form-select form-select-sm" style={{ maxWidth: 140 }} value={scope} onChange={(e) => setScope(e.target.value as 'account' | 'tier')} aria-label="One account or a tier">
          <option value="account">One account</option>
          <option value="tier">A whole tier</option>
        </select>
        {scope === 'account' ? (
          <input className="form-control form-control-sm" style={{ maxWidth: 240 }} value={account} onChange={(e) => setAccount(e.target.value)} placeholder="account, e.g. acme.pbf.testnet" aria-label="Account" />
        ) : (
          <select className="form-select form-select-sm" style={{ maxWidth: 160 }} value={tier} onChange={(e) => setTier(e.target.value as Tier)} aria-label="Tier">
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {tierName(t)}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="d-flex flex-wrap gap-2 mb-2">
        <select className="form-select form-select-sm" style={{ maxWidth: 340 }} value={kind} onChange={(e) => setKind(e.target.value as PolicyKind)} aria-label="Policy">
          {POLICY_KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
        {kind === 'lender' && (
          <>
            <div className="input-group input-group-sm" style={{ maxWidth: 190 }}>
              <span className="input-group-text">margin</span>
              <input className="form-control" inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} placeholder="0" aria-label="Margin in points" />
              <span className="input-group-text">points</span>
            </div>
            <div className="input-group input-group-sm" style={{ maxWidth: 170 }}>
              <span className="input-group-text">cap</span>
              <input className="form-control" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="none" aria-label="Cap, percent a year" />
              <span className="input-group-text">%</span>
            </div>
          </>
        )}
        {kind === 'fixed' && (
          <div className="input-group input-group-sm" style={{ maxWidth: 170 }}>
            <input className="form-control" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="6.5" aria-label="Rate, percent a year" />
            <span className="input-group-text">% a year</span>
          </div>
        )}
      </div>
      {problem && <div className="form-text text-danger mb-1">{problem}</div>}
      {pricing && (
        <div className="mb-2 text-body-secondary">
          <div className="text-body">
            With this, {target ? targetWords(target) : 'the account'} pays {pricingWords(pricing).toLowerCase()}.
          </div>
          {EXAMPLES.map((e) => (
            <div key={e.rate_bp}>{pricingExample(pricing, e.rate_bp, e.supply_bp)}</div>
          ))}
        </div>
      )}
      <div className="d-flex flex-wrap gap-2">
        <button className="btn btn-sm btn-primary" disabled={!target || !pricing || tx.busy} onClick={() => target && pricing && void send(`Pricing for ${targetWords(target)}`, pricing)}>
          Set
        </button>
        <button className="btn btn-sm btn-outline-secondary" disabled={!target || tx.busy} onClick={() => target && void send(`Clear the pricing for ${targetWords(target)}`, null)}>
          Clear
        </button>
      </div>
      <div className="form-text">Clearing removes this policy: {scope === 'tier' ? 'the tier’s accounts go back to each source at its own rate' : 'the account goes back to its tier’s'}. A change counts from each account’s next settlement, for the whole time that settlement covers. {periodWords(limits)}</div>
      <TxStatus record={tx.last} busy={tx.busy} />
    </div>
  );
}

/** `set_funding({order, loan_days})`: which source the engine fills first, and how long a loan is expected to last. */
function FundingOrderForm({ poolId, order, loanDays, onChanged }: { poolId: string; order: string; loanDays: number; onChanged?: () => void }) {
  const [next, setNext] = useState<FundingOrder>(FUNDING_ORDERS.includes(order as FundingOrder) ? (order as FundingOrder) : 'cheapest');
  const [days, setDays] = useState(String(loanDays));
  const tx = useTx();
  const { funding, problem } = fundingFromForm({ order: next, days });
  const unchanged = funding !== null && funding.order === order && funding.loan_days === loanDays;
  return (
    <div className="mb-3">
      <h3 className="h6">Where loans come from</h3>
      <p className="mb-1">
        The engine fills a loan from its sources in this order, as far as each one safely lends. The loan life is how long it expects a loan to last, when it weighs the cost
        of moving bitcoin to a lender against the interest that saves.
      </p>
      <div className="d-flex flex-wrap gap-2">
        <select className="form-select form-select-sm" style={{ maxWidth: 240 }} value={next} onChange={(e) => setNext(e.target.value as FundingOrder)} aria-label="Source order">
          {FUNDING_ORDERS.map((o) => (
            <option key={o} value={o}>
              {orderWords(o)}
            </option>
          ))}
        </select>
        <div className="input-group input-group-sm" style={{ maxWidth: 190 }}>
          <span className="input-group-text">loan life</span>
          <input className="form-control" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} aria-label="Loan life in days" />
          <span className="input-group-text">days</span>
        </div>
        <button
          className="btn btn-sm btn-primary"
          disabled={!funding || unchanged || tx.busy}
          onClick={async () => {
            if (!funding) return;
            await tx.run(`${orderWords(funding.order)}, loans of ${funding.loan_days} days`, setFundingTx(poolId, funding));
            onChanged?.();
          }}
        >
          Set
        </button>
      </div>
      {problem && <div className="form-text text-danger">{problem}</div>}
      <p className="mt-1 mb-0 text-body-secondary">
        Now: {orderWords(order).toLowerCase()}, with loans expected to last {loanDays} days.
      </p>
      <TxStatus record={tx.last} busy={tx.busy} />
    </div>
  );
}

function Pause({ poolId, paused }: { poolId: string; paused: boolean }) {
  const tx = useTx();
  return (
    <div className="mb-3">
      <h3 className="h6">Pause</h3>
      <p className="mb-1">The pool is {paused ? 'paused: no new loans or plan steps' : 'open'}. Repaying is never paused.</p>
      <button className={`btn btn-sm ${paused ? 'btn-success' : 'btn-danger'}`} disabled={tx.busy} onClick={() => tx.run(paused ? 'Resume the pool' : 'Pause the pool', setPausedTx(poolId, !paused))}>
        {paused ? 'Resume' : 'Pause'}
      </button>
      <TxStatus record={tx.last} busy={tx.busy} />
    </div>
  );
}

function Kyb({ poolId }: { poolId: string }) {
  const [account, setAccount] = useState('');
  const [entity, setEntity] = useState('');
  const tx = useTx();
  const ok = isAccountId(account.trim());
  return (
    <div className="mb-3">
      <h3 className="h6">KYB flag</h3>
      <p className="mb-1">
        Marks a client as checked, with an entity id: accounts with the same id count as one client. Preferred tier needs it. Clearing it
        takes a Preferred account down to Standard at once.
      </p>
      <div className="d-flex flex-wrap gap-2">
        <input className="form-control form-control-sm" style={{ maxWidth: 220 }} value={account} onChange={(e) => setAccount(e.target.value)} placeholder="account, e.g. acme.pbf.testnet" aria-label="Account" />
        <input className="form-control form-control-sm" style={{ maxWidth: 160 }} value={entity} onChange={(e) => setEntity(e.target.value)} placeholder="entity id" aria-label="Entity id" />
        <button className="btn btn-sm btn-primary" disabled={!ok || !entity.trim() || entity.length > 64 || tx.busy} onClick={() => tx.run(`KYB flag for ${account}`, setKybTx(poolId, account.trim(), entity.trim()))}>
          Set
        </button>
        <button className="btn btn-sm btn-outline-secondary" disabled={!ok || tx.busy} onClick={() => tx.run(`Clear the KYB flag of ${account}`, setKybTx(poolId, account.trim(), null))}>
          Clear
        </button>
      </div>
      <TxStatus record={tx.last} busy={tx.busy} />
    </div>
  );
}

function Cosign({ poolId, threshold }: { poolId: string; threshold: string }) {
  const [account, setAccount] = useState('');
  const [text, setText] = useState('');
  const tx = useTx();
  let units: string | null = null;
  let problem: string | null = null;
  try {
    units = text ? parseUnits(text, UsdcToken.decimals) : null;
  } catch (error) {
    problem = (error as Error).message;
  }
  const ok = isAccountId(account.trim()) && units !== null && units !== '0';
  return (
    <div className="mb-3">
      <h3 className="h6">Co-sign a borrow</h3>
      <p className="mb-1">A borrow above {formatUsd(threshold)} needs the operator&apos;s co-signature for that account and exact amount. Each one is used once.</p>
      <div className="d-flex flex-wrap gap-2">
        <input className="form-control form-control-sm" style={{ maxWidth: 220 }} value={account} onChange={(e) => setAccount(e.target.value)} placeholder="account" aria-label="Account to co-sign for" />
        <div className="input-group input-group-sm" style={{ maxWidth: 200 }}>
          <input className="form-control" value={text} onChange={(e) => setText(e.target.value)} placeholder="amount" aria-label="USDC amount" />
          <span className="input-group-text">USDC</span>
        </div>
        <button className="btn btn-sm btn-primary" disabled={!ok || tx.busy} onClick={() => units && tx.run(`Co-sign a borrow of ${text} USDC by ${account}`, cosignBorrowTx(poolId, account.trim(), units))}>
          Co-sign
        </button>
      </div>
      {problem && <div className="form-text text-danger">{problem}</div>}
      <TxStatus record={tx.last} busy={tx.busy} />
    </div>
  );
}

function CoinStatuses({ poolId, tokens }: { poolId: string; tokens: string[] }) {
  const markets = useApi<MarketsAnswer>(MARKETS_PATH, 30_000);
  const [coin, setCoin] = useState('XRP');
  const [status, setStatus] = useState<CoinStatus>('removed');
  const [emergency, setEmergency] = useState(false);
  const tx = useTx();
  const isToken = tokens.includes(coin);
  const allowed = isToken ? TOKEN_STATUSES : COIN_STATUSES;
  const current = markets.data?.coins.find((c) => c.coin === coin)?.status;
  return (
    <div>
      <h3 className="h6">Coin status</h3>
      <p className="mb-1">
        Every program version reads this list. A coin is allowed, reduce-only (only orders that shrink a position) or removed; a bridged
        token ({tokens.join(', ') || 'none'}) is allowed or frozen, and a frozen one counts as zero toward new loans.
      </p>
      <div className="d-flex flex-wrap gap-2 align-items-center">
        <select
          className="form-select form-select-sm"
          style={{ maxWidth: 130 }}
          value={coin}
          onChange={(e) => {
            setCoin(e.target.value);
            setStatus(tokens.includes(e.target.value) ? 'frozen' : 'removed');
          }}
          aria-label="Coin or token"
        >
          <optgroup label="Coins">
            {(markets.data?.coins ?? []).map((c) => (
              <option key={c.coin} value={c.coin}>{c.coin}</option>
            ))}
          </optgroup>
          <optgroup label="Bridged tokens">
            {tokens.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </optgroup>
        </select>
        <select className="form-select form-select-sm" style={{ maxWidth: 150 }} value={status} onChange={(e) => setStatus(e.target.value as CoinStatus)} aria-label="Status">
          {allowed.map((s) => (
            <option key={s} value={s}>{s.replace('_', '-')}</option>
          ))}
        </select>
        {status === 'reduce_only' && (
          <div className="form-check">
            <input id="emergency" className="form-check-input" type="checkbox" checked={emergency} onChange={(e) => setEmergency(e.target.checked)} />
            <label className="form-check-label" htmlFor="emergency">emergency (24 h notice, not 7 days)</label>
          </div>
        )}
        <button className="btn btn-sm btn-primary" disabled={!allowed.includes(status) || tx.busy} onClick={() => tx.run(`Set ${coin} to ${status}`, setCoinStatusTx(poolId, coin, status, emergency))}>
          Set
        </button>
      </div>
      <p className="mt-1 mb-0 text-body-secondary">Now: {current ? `${current.status.replace('_', '-')} since ${new Date(Number(BigInt(current.since) / 1_000_000n)).toLocaleString()}` : "not on the list, so the parameter file's allow-list applies"}.</p>
      <TxStatus record={tx.last} busy={tx.busy} />
    </div>
  );
}
