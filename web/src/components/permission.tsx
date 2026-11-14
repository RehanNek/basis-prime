'use client';
// The funding permission (FUNDING.md 4.2; INTERFACES.md 25 and 29, stage 2). Where an account is opened, its terms in
// plain words, signed in the same approval as the opening, or left out. On the Account page, the card that changes or
// cancels it: `set_permission`, which the owner's wallet signs with 1 yoctoNEAR.
import { useId, useState } from 'react';

import { TxStatus } from '@/components/tx-status';
import { useTx } from '@/hooks/use-tx';
import {
  CANCEL_WORDS,
  CHANGE_WORDS,
  defaultPermission,
  draftOf,
  lenderList,
  movesWords,
  permissionLimits,
  permissionFromDraft,
  permissionSummary,
  permissionTerms,
  samePermission,
  type PermissionDraft,
} from '@/lib/permission';
import { sourceName } from '@/lib/funding';
import { setPermissionTx } from '@/lib/tx';
import type { LenderName, Permission } from '@/lib/types';

/** The four terms, each with what it means. */
export function PermissionTerms({ permission, posted }: { permission: Permission; posted?: string }) {
  return (
    <dl className="pb-rows pb-terms-rows">
      {permissionTerms(permission, posted).map((term) => (
        <div key={term.label}>
          <dt>
            <span>
              <span className="pb-terms-label">{term.label}</span>
              <span className="sub">{term.note}</span>
            </span>
          </dt>
          <dd className="num">{term.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Under the account's name where it is opened: the permission on offer and its terms, with a tick to sign it in the
 * same approval. Unticked, the account opens without one. Nothing shows when the factory's config has no lenders.
 */
export function OpeningPermission({ offered, on, onToggle, posted }: { offered: Permission | null; on: boolean; onToggle: (on: boolean) => void; /** What a lender would take from the new account, in a word (INTERFACES.md 51.1). */ posted?: string }) {
  const id = useId();
  if (!offered) return null;
  const lenders = lenderList(offered.lenders);
  return (
    <section className="pb-terms mb-2" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="pb-sources-title">
        The lender permission
      </h3>
      <p className="small mb-2">
        With it, part of a loan can come from {lenders}, and our pool lends the rest against your whole hedged book. Without it, every loan comes from our pool alone. One
        approval opens the account and signs it.
      </p>
      <PermissionTerms permission={offered} posted={posted} />
      <p className="form-text mt-2 mb-2">{permissionLimits(posted)} You can change or cancel it on the Account page at any time.</p>
      <div className="form-check mb-0">
        <input id={`${id}-on`} className="form-check-input" type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        <label className="form-check-label" htmlFor={`${id}-on`}>
          Sign this permission when the account opens
        </label>
      </div>
      {!on && <div className="form-text">The account will open without it. You can sign it later on the Account page.</div>}
    </section>
  );
}

const MOVES: Permission['moves'][] = ['any', 'lower_cost_only', 'off'];

/** The form for a permission's terms. `available` is the lenders the account's config has settings for. */
function PermissionForm({ draft, available, onChange }: { draft: PermissionDraft; available: LenderName[]; onChange: (draft: PermissionDraft) => void }) {
  const id = useId();
  const toggle = (l: LenderName, on: boolean) => onChange({ ...draft, lenders: on ? [...draft.lenders, l] : draft.lenders.filter((x) => x !== l) });
  return (
    <div className="row g-3 mb-2">
      <div className="col-sm-6">
        <div className="form-label mb-1">Lenders</div>
        {available.map((l) => (
          <div className="form-check" key={l}>
            <input id={`${id}-${l}`} className="form-check-input" type="checkbox" checked={draft.lenders.includes(l)} onChange={(e) => toggle(l, e.target.checked)} />
            <label className="form-check-label" htmlFor={`${id}-${l}`}>
              {sourceName(l)}
            </label>
          </div>
        ))}
      </div>
      <div className="col-sm-6">
        <label className="form-label mb-1" htmlFor={`${id}-moves`}>
          Moving a loan between lenders
        </label>
        <select id={`${id}-moves`} className="form-select form-select-sm" value={draft.moves} onChange={(e) => onChange({ ...draft, moves: e.target.value as Permission['moves'] })}>
          {MOVES.map((m) => (
            <option key={m} value={m}>
              {movesWords(m)}
            </option>
          ))}
        </select>
      </div>
      <div className="col-sm-6">
        <label className="form-label mb-1" htmlFor={`${id}-cushion`}>
          Smallest cushion
        </label>
        <input id={`${id}-cushion`} className="form-control form-control-sm num" inputMode="decimal" value={draft.cushion} onChange={(e) => onChange({ ...draft, cushion: e.target.value })} />
        <div className="form-text">From 1.2 to 5. At 1.00 a lender sells.</div>
      </div>
      <div className="col-sm-6">
        <label className="form-label mb-1" htmlFor={`${id}-rate`}>
          Highest rate
        </label>
        <div className="input-group input-group-sm">
          <input id={`${id}-rate`} className="form-control num" inputMode="decimal" value={draft.rate} onChange={(e) => onChange({ ...draft, rate: e.target.value })} />
          <span className="input-group-text">% a year</span>
        </div>
      </div>
    </div>
  );
}

interface CardProps {
  accountId: string;
  isOwner: boolean;
  /** The account's permission now, from get_state(). */
  permission: Permission | null;
  /** The lenders the account's own config has settings for. */
  available: LenderName[];
  /** Is a funding plan with steps left stored? A change stops its lender steps. */
  planRunning?: boolean;
  onChanged: () => void;
  /** What a lender takes from this account, in a word: "bitcoin", or "bitcoin or ether" when its settings let Rhea take test ETH (INTERFACES.md 51.1). */
  posted?: string;
}

/** The Account page's card: the permission now, and changing or cancelling it. */
export function PermissionCard({ accountId, isOwner, permission, available, planRunning, onChanged, posted }: CardProps) {
  const tx = useTx();
  const [draft, setDraft] = useState<PermissionDraft | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const edited = draft ? permissionFromDraft(draft, available) : null;
  const unchanged = Boolean(edited?.permission && samePermission(edited.permission, permission));
  const start = permission ?? defaultPermission(available);

  const send = async (label: string, next: Permission | null) => {
    const outcome = await tx.run(label, setPermissionTx(accountId, next));
    if (outcome) {
      setDraft(null);
      setCancelling(false);
    }
    onChanged();
  };

  return (
    <section className="card mb-3" aria-labelledby="permission-card-title">
      <div className="card-header fw-semibold" id="permission-card-title">
        Lender permission
      </div>
      <div className="card-body small">
        <p className={permission ? 'mb-2' : 'mb-2 text-body-secondary'}>{permissionSummary(permission)}</p>
        {permission && permission.lenders.length > 0 && !draft && <PermissionTerms permission={permission} posted={posted} />}
        {!permission && available.length === 0 && <p className="mb-0 text-body-secondary">This account has no lenders in its settings, so there is no permission to sign.</p>}

        {draft && edited && (
          <div className="mt-2">
            <PermissionForm draft={draft} available={available} onChange={setDraft} />
            {edited.permission && !unchanged && <p className="mb-2">With the new terms: {permissionSummary(edited.permission)}</p>}
            {edited.problem && <div className="form-text text-danger mb-2">{edited.problem}</div>}
            <div className="d-flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={!edited.permission || unchanged || !isOwner || tx.busy}
                onClick={() => edited.permission && void send(permission ? 'Change the lender permission' : 'Sign the lender permission', edited.permission)}
              >
                {permission ? 'Sign the new terms' : 'Sign this permission'}
              </button>
              <button type="button" className="btn btn-sm btn-outline-secondary" disabled={tx.busy} onClick={() => setDraft(null)}>
                {permission ? 'Keep it as it is' : 'Not now'}
              </button>
            </div>
            {unchanged && <div className="form-text">These are the terms already signed.</div>}
          </div>
        )}

        {cancelling && (
          <div className="alert alert-warning mt-2 mb-0">
            <div className="mb-2">{CANCEL_WORDS}</div>
            <div className="d-flex flex-wrap gap-2">
              <button type="button" className="btn btn-sm btn-danger" disabled={!isOwner || tx.busy} onClick={() => void send('Cancel the lender permission', null)}>
                Cancel the permission
              </button>
              <button type="button" className="btn btn-sm btn-outline-secondary" disabled={tx.busy} onClick={() => setCancelling(false)}>
                Keep it
              </button>
            </div>
          </div>
        )}

        {!draft && !cancelling && start && (
          <div className="d-flex flex-wrap gap-2 mt-2">
            <button type="button" className="btn btn-sm btn-outline-primary" disabled={!isOwner || tx.busy} onClick={() => setDraft(draftOf(start))}>
              {permission ? 'Change the terms' : 'Sign a permission'}
            </button>
            {permission && (
              <button type="button" className="btn btn-sm btn-outline-secondary" disabled={!isOwner || tx.busy} onClick={() => setCancelling(true)}>
                Cancel it
              </button>
            )}
          </div>
        )}

        {(draft || cancelling) && (
          <p className="form-text mb-0">
            {CHANGE_WORDS}
            {planRunning && ' A loan is on its way: its steps that borrow from a lender stop if that lender is no longer permitted.'}
          </p>
        )}
        {start && !draft && !cancelling && <p className="form-text mb-0">{permissionLimits(posted)}</p>}
        {!isOwner && start && <div className="form-text">Only the account’s owner can change this.</div>}
        <TxStatus record={tx.last} busy={tx.busy} />
      </div>
    </section>
  );
}
