'use client';
// The setup checklist on top of Home until setup is done (option D, 9 Nov): five steps, the current one open with its
// button, and on testnet "Set up the demo for me", which runs every step before the borrow in a row.
// Phase 6, stage 2 (INTERFACES.md 29): "Open your account" shows the funding permission and its terms, and one
// signature opens the account and signs it.
// Stage 3 (INTERFACES.md 33): on testnet, an account whose config has Aave gets a step before the borrow, "Get test
// collateral for Aave": test bitcoin when Aave's test pool has room for it, test ether when it doesn't.
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { EvmTxLink } from '@/components/evm-lines';
import { Dot, TxLink } from '@/components/flow-progress';
import { BorrowBox } from '@/components/home/panels';
import { OpeningPermission } from '@/components/permission';
import { DEMO_NBTC_UNITS, DEMO_USDC_UNITS, marginToMove, type RunStatus, type useSetupActions } from '@/components/home/setup-actions';
import { FactoryContract, NetworkId } from '@/config';
import type { ClientAccount } from '@/hooks/use-client-account';
import { useApi } from '@/hooks/use-api';
import { LENDERS_PATH, type AccountAnswer, type LenderAccountAnswer, type LendersAnswer } from '@/lib/api';
import { collateralAt, EVM_CHAIN_NAME, testCollateral, tokenAmount } from '@/lib/evm';
import { canUseLenders, termsFor } from '@/lib/funding';
import { EXPIRED_ORDER_WORDS, SIGN_AGAIN } from '@/lib/gateway';
import { HEDGE_PARTS, held, type SetupKey, type SetupView } from '@/lib/setup';
import type { Permission } from '@/lib/types';
import { formatUnits, formatUsd, parseUnits } from '@/lib/units';

type Actions = ReturnType<typeof useSetupActions>;

interface Props {
  client: ClientAccount;
  answer: AccountAnswer | undefined;
  view: SetupView;
  actions: Actions;
  estimate: bigint | null;
  previewEnabled: boolean;
  paused: boolean;
  /** The account at each lender (INTERFACES.md 28). An account that can use lenders borrows through `fund`. */
  lender?: LenderAccountAnswer;
  reloadLender?: () => void;
  /** The permission a new account is offered, and whether the client keeps it ticked. `offered` is null when the factory's config has no lenders. */
  permission: OpeningChoice;
  factoryLive: boolean | undefined;
  /** Stage 3: passes over "Get test collateral for Aave", to borrow without it. */
  onSkipTestCollateral?: () => void;
  /** Stage 4, testnet: opens "Move bitcoin to Aave's chain", the other way to get collateral to the address. */
  onMoveBitcoin?: () => void;
  /**
   * The app's second shape (INTERFACES.md 49.1 point 5): Home no longer offers "Set up the demo for me", so it passes
   * false. A page that still wants the button leaves this out.
   */
  demoButton?: boolean;
  onHide: () => void;
}

export interface OpeningChoice {
  offered: Permission | null;
  on: boolean;
  onToggle: (on: boolean) => void;
  /** What a lender would take from the new account, in a word, by the factory's settings (INTERFACES.md 51.1). */
  posted?: string;
}

/** The borrow step for an account that can use lenders. */
const BORROW_WITH_LENDERS = 'USDC against the whole book: from our pool, and from a lender when your permission names one. One click runs the check and starts the loan.';

const DETAIL: Record<SetupKey, string> = {
  wallet: '',
  account: 'Your own account contract on NEAR. Your wallet owns it, and it holds your collateral and your loan.',
  collateral: 'nBTC is what you borrow against. Some USDC goes to Hyperliquid as margin for the hedge.',
  hedge: 'A short on Hyperliquid as big as your nBTC cancels out BTC’s price moves, so the engine can lend more against it.',
  aave: 'Aave lends against what sits at the account’s own address on Base Sepolia, which it posts there. On testnet that collateral comes from a faucet.',
  borrow: 'USDC from the broker’s pool, against the whole book. One click runs the check and borrows.',
};

export function SetupCard({ client, answer, view, actions, estimate, previewEnabled, paused, lender, reloadLender, permission, factoryLive, onSkipTestCollateral, onMoveBitcoin, demoButton, onHide }: Props) {
  const busy = actions.busy;
  const demo = demoButton !== false && NetworkId === 'testnet' && view.next !== null && view.next !== 'borrow' && view.next !== 'wallet';
  // The borrow step stays open after it's done, so its progress and transaction link stay in view.
  const [keepBorrow, setKeepBorrow] = useState(false);
  if (view.next === 'borrow' && !keepBorrow) setKeepBorrow(true);
  const approvals = approvalsLeft(view);
  // Home's list ends at the open account (lib/setup.ts, openingView): its words are about the account alone.
  const opening = !view.steps.some((s) => s.key === 'borrow');

  return (
    <section className="pb-setup mb-4" aria-labelledby="setup-title">
      <div className="d-flex flex-wrap align-items-start gap-2 mb-2">
        <div className="me-auto">
          <h2 id="setup-title" className="pb-card-title mb-0">
            {opening ? 'Open your account' : view.complete ? 'You’re all set' : 'Finish setting up'}
          </h2>
          <div className="small pb-muted">
            {opening
              ? `${view.done} of ${view.steps.length} done. Once it is open, this goes away and the tabs above are yours.`
              : view.complete
                ? 'Your hedged loan is open. The numbers below are live.'
                : `${view.done} of ${view.steps.length} done. The numbers below fill in as you go.`}
          </div>
        </div>
        {demo && (
          <button type="button" className="btn btn-primary" disabled={busy || !client.accountId || !client.isOwnerOrNew} onClick={() => void actions.runAll()}>
            <i className="bi bi-magic me-1" aria-hidden="true" />
            Set up the demo for me
          </button>
        )}
        {view.complete ? (
          <button type="button" className="btn btn-outline-secondary btn-sm" onClick={onHide}>
            Close
          </button>
        ) : (
          <button type="button" className="pb-iconbtn" title="Hide the checklist" aria-label="Hide the checklist" onClick={onHide}>
            <i className="bi bi-x-lg" aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="pb-progress mb-2" role="progressbar" aria-valuemin={0} aria-valuemax={view.steps.length} aria-valuenow={view.done} aria-label="Setup progress">
        <div style={{ width: `${(view.done * 100) / view.steps.length}%` }} />
      </div>
      {demo && actions.status.kind === 'idle' && (
        <p className="small pb-muted mb-2">
          The demo button runs every step up to the borrow, one after another.{' '}
          {approvals === 0
            ? 'Your wallet has nothing to approve for what is left.'
            : `Your wallet asks you to approve each one: ${approvals === 1 ? 'one approval' : `${approvals} approvals`} in all.`}
        </p>
      )}
      {/* INTERFACES.md 50.4: the hedge's order is the checklist's one signed message; when it ran out, "Sign again" signs a fresh one. */}
      <RunLine status={actions.status} onClear={actions.clear} onSignAgain={() => void actions.runStep('short')} />

      <ol className="pb-checklist mt-2">
        {view.steps.map((step, i) => {
          const current = step.key === view.next;
          const open = current || (step.key === 'borrow' && keepBorrow);
          return (
            <li key={step.key}>
              {/* A step the client passed over keeps its number: it wasn't done. */}
              <Dot mark={step.skipped ? 'todo' : step.done ? 'done' : current ? 'current' : 'todo'} n={i + 1} />
              <div className="flex-grow-1" style={{ minWidth: 0 }}>
                <div className={`pb-step-title ${step.done ? 'done' : ''}`}>{step.title}</div>
                {step.done && <DoneLine step={step.key} skipped={Boolean(step.skipped)} client={client} answer={answer} lender={lender} />}
                {open && (
                  <div className="mt-1">
                    {DETAIL[step.key] && <div className="pb-step-detail mb-2">{step.key === 'borrow' && canUseLenders(lender) ? BORROW_WITH_LENDERS : DETAIL[step.key]}</div>}
                    <StepBody step={step.key} {...{ client, answer, view, actions, estimate, previewEnabled, paused, lender, reloadLender, permission, factoryLive, onSkipTestCollateral, onMoveBitcoin }} />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** How many wallet approvals "Set up the demo for me" will ask for from here. */
function approvalsLeft(view: SetupView): number {
  const done = Object.fromEntries(view.steps.map((s) => [s.key, s.done]));
  const parts = HEDGE_PARTS.map((p) => p.part);
  const hedgeLeft = done.hedge || view.hedge === 'unavailable' ? 0 : !done.account ? parts.length : parts.length - Math.max(0, parts.indexOf(view.hedge as (typeof parts)[number]));
  return (done.account ? 0 : 1) + (done.collateral ? 0 : 1) + hedgeLeft;
}

/** What the runner is doing now, or how its last step went. */
function RunLine({ status, onClear, onSignAgain }: { status: RunStatus; onClear: () => void; onSignAgain?: () => void }) {
  if (status.kind === 'idle') return null;
  if (status.kind === 'running') {
    return (
      <ul className="pb-flow mt-1 mb-0" aria-live="polite">
        <li>
          <Dot mark="busy" />
          <div>
            <div className="what fw-medium">{status.what}</div>
            <div className="how">{status.detail}</div>
          </div>
        </li>
      </ul>
    );
  }
  if (status.kind === 'done') {
    return (
      <ul className="pb-flow mt-1 mb-0" aria-live="polite">
        <li>
          <Dot mark="done" />
          <div>
            <div className="what">
              {status.what}
              <TxLink hash={status.hash} />
              <EvmTxLink hash={status.evmHash} />
            </div>
            {status.detail && <div className="how">{status.detail}</div>}
          </div>
        </li>
      </ul>
    );
  }
  return (
    <div className="alert alert-danger small mt-2 mb-0" role="alert">
      <div className="fw-medium">{status.what} didn’t finish.</div>
      <div>{status.why}</div>
      {status.logs && status.logs.length > 0 && (
        <details className="mt-1">
          <summary>Details ({status.logs.length})</summary>
          <pre className="small mb-0 text-wrap">{status.logs.join('\n')}</pre>
        </details>
      )}
      <div className="d-flex flex-wrap gap-2 mt-2">
        {onSignAgain && status.why === EXPIRED_ORDER_WORDS && (
          <button type="button" className="btn btn-primary btn-sm" onClick={onSignAgain}>
            {SIGN_AGAIN}
          </button>
        )}
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={onClear}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function DoneLine({ step, skipped, client, answer, lender }: { step: SetupKey; skipped: boolean; client: ClientAccount; answer: AccountAnswer | undefined; lender?: LenderAccountAnswer }) {
  // What sits at the address on Aave's chain, or what Aave already holds, each token by its own name.
  const atAddress = collateralAt(lender?.evm).map((t) => tokenAmount(t.amount, t));
  const atAave = (lender?.lenders.find((p) => p.l === 'aave')?.held ?? []).map((h) => tokenAmount(h.amount, h));
  const line: Partial<Record<SetupKey, ReactNode>> = {
    wallet: <>Signed in as {client.owner}</>,
    account: answer?.account_id,
    collateral: answer ? `${formatUnits(held(answer, 'nBTC'), 8)} nBTC and ${formatUnits(held(answer, 'USDC'), 6)} USDC in the account` : null,
    aave: skipped
      ? 'Skipped: Aave has nothing to lend against, so a loan comes from the other sources.'
      : atAddress.length > 0
        ? `${atAddress.join(' and ')} at the account’s address on ${EVM_CHAIN_NAME}`
        : atAave.length > 0
          ? `${atAave.join(' and ')} posted with Aave`
          : null,
  };
  return line[step] ? <div className="pb-step-detail text-break">{line[step]}</div> : null;
}

function StepBody(props: Omit<Props, 'onHide'> & { step: SetupKey }) {
  const { step, client, answer, view, actions, estimate, previewEnabled, paused, lender, reloadLender, permission, factoryLive, onSkipTestCollateral, onMoveBitcoin } = props;
  const busy = actions.busy;
  if (step === 'aave') return <TestCollateral answer={answer} actions={actions} onSkip={onSkipTestCollateral} onMove={onMoveBitcoin} />;
  if (step === 'account') return <OpenAccount client={client} answer={answer} actions={actions} permission={permission} factoryLive={factoryLive} />;
  if (step === 'collateral') {
    if (NetworkId !== 'testnet') {
      return (
        <Link href="/deposit" className="btn btn-primary btn-sm">
          Add funds
        </Link>
      );
    }
    return (
      <div className="d-flex flex-wrap align-items-center gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !client.isOwnerOrNew} onClick={() => void actions.runStep('collateral')}>
          Add test collateral
        </button>
        <span className="small pb-muted">
          {formatUnits(DEMO_NBTC_UNITS, 8)} test nBTC and {formatUnits(DEMO_USDC_UNITS, 6)} test USDC, straight into your account.{' '}
          <Link href="/deposit">Other ways</Link>
        </span>
      </div>
    );
  }
  if (step === 'hedge') return <Hedge client={client} answer={answer} view={view} actions={actions} />;
  if (step === 'borrow' && answer?.state) {
    return <BorrowBox client={client} answer={answer} estimate={estimate} previewEnabled={previewEnabled} paused={paused} lender={lender} reloadLender={reloadLender} planBelow />;
  }
  return null;
}

/**
 * "Get test collateral for Aave" (testnet): which token, why, and the button. The request goes to the backend's gas
 * wallet, so the wallet has nothing to approve, and anyone looking at the account may press it.
 */
function TestCollateral({ answer, actions, onSkip, onMove }: { answer: AccountAnswer | undefined; actions: Actions; onSkip?: () => void; onMove?: () => void }) {
  // What Aave's test pool can still take of each token: its pool for bitcoin is capped, and can be full.
  const terms = useApi<LendersAnswer>(LENDERS_PATH);
  const choice = testCollateral(termsFor(terms.data?.lenders, 'aave', 'testnet')?.collateral_room, answer ? held(answer, 'nBTC') : 0n);
  return (
    <div>
      <p className="small mb-2">{choice.why}</p>
      <div className="d-flex flex-wrap align-items-center gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={actions.busy || !answer?.state || (terms.loading && !terms.data)} onClick={() => void actions.runStep('aave')}>
          Get {choice.amount}
        </button>
        {onSkip && (
          <button type="button" className="btn btn-link btn-sm px-1" disabled={actions.busy} onClick={onSkip}>
            Skip this and borrow without Aave
          </button>
        )}
      </div>
      <div className="form-text">
        It arrives at the account’s own address on {EVM_CHAIN_NAME}, with a little of that chain’s ETH to pay for its transactions. Your wallet has nothing to approve.
      </div>
      {onMove && (
        <div className="form-text">
          Or move a little of your own bitcoin there, as a client would on mainnet: it costs a little and takes a few minutes.{' '}
          <button type="button" className="btn btn-link btn-sm p-0 align-baseline" disabled={actions.busy} onClick={onMove}>
            Move bitcoin to Aave’s chain
          </button>
        </div>
      )}
    </div>
  );
}

function OpenAccount({
  client,
  answer,
  actions,
  permission,
  factoryLive,
}: {
  client: ClientAccount;
  answer: AccountAnswer | undefined;
  actions: Actions;
  permission: OpeningChoice;
  factoryLive: boolean | undefined;
}) {
  const taken = answer?.exists && (!answer.state || answer.state.owner !== client.owner);
  return (
    <div>
      <label className="form-label small pb-muted mb-1" htmlFor="account-name">
        Pick a name
      </label>
      <div className="input-group mb-1" style={{ maxWidth: 460 }}>
        <input
          id="account-name"
          className={`form-control ${(client.problem && client.name) || taken ? 'is-invalid' : ''}`}
          value={client.name}
          onChange={(e) => client.setName(e.target.value)}
          placeholder="name"
          autoComplete="off"
          spellCheck={false}
        />
        <span className="input-group-text">.{FactoryContract}</span>
      </div>
      <div className="form-text mb-2">
        {client.problem
          ? client.problem
          : taken
            ? answer?.state
              ? `${answer.account_id} belongs to someone else. Pick another name.`
              : `${answer?.account_id} exists and isn’t a client account. Pick another name.`
            : 'Opening it costs 6 NEAR, and about 4.7 NEAR of that stays with the account as its storage. If anything fails, the factory refunds you.'}
      </div>
      <OpeningPermission offered={permission.offered} on={permission.on} onToggle={permission.onToggle} posted={permission.posted} />
      <button type="button" className="btn btn-primary btn-sm" disabled={actions.busy || !client.accountId || Boolean(taken) || factoryLive === false} onClick={() => void actions.runStep('account')}>
        Open {client.accountId ?? 'the account'} (6 NEAR)
      </button>
      {factoryLive === false && <div className="form-text text-danger">The factory isn’t live on this network yet.</div>}
    </div>
  );
}

function Hedge({ client, answer, view, actions }: { client: ClientAccount; answer: AccountAnswer | undefined; view: SetupView; actions: Actions }) {
  const suggested = answer ? marginToMove(held(answer, 'USDC')) : null;
  const [text, setText] = useState(() => (suggested ? formatUnits(suggested, 6) : ''));
  if (view.hedge === 'unavailable') {
    return (
      <div className="alert alert-secondary small mb-0">
        This account was made before trading existed, so it can’t hedge. Open a new account under another name.
      </div>
    );
  }
  const order = HEDGE_PARTS.map((p) => p.part);
  const at = view.hedge === 'done' ? order.length : order.indexOf(view.hedge as (typeof order)[number]);
  let amount: bigint | null = null;
  try {
    amount = text ? BigInt(parseUnits(text, 6)) : null;
  } catch {
    amount = null;
  }
  const busy = actions.busy || !client.isOwner;

  return (
    <ul className="pb-flow mt-0">
      {HEDGE_PARTS.map((p, i) => {
        const mark = i < at ? 'done' : i === at ? 'current' : 'todo';
        return (
          <li key={p.part}>
            <Dot mark={mark} n={i + 1} />
            <div className="flex-grow-1">
              <div className={`what ${mark === 'todo' ? 'todo' : ''}`}>{p.title}</div>
              {mark === 'current' && (
                <div className="mt-1 mb-1">
                  {p.part === 'address' && (
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void actions.runStep('address')}>
                      Create the address
                    </button>
                  )}
                  {p.part === 'margin' && (
                    <div className="d-flex flex-wrap align-items-center gap-2">
                      <div className="input-group input-group-sm" style={{ maxWidth: 220 }}>
                        <span className="input-group-text">$</span>
                        <input className="form-control num" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} aria-label="USDC to move to Hyperliquid" />
                        <span className="input-group-text">USDC</span>
                      </div>
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy || !amount || amount < 10_000_000n} onClick={() => amount && void actions.runStep('margin', amount)}>
                        Move {amount ? formatUsd(amount) : ''} to Hyperliquid
                      </button>
                      <span className="small pb-muted w-100">At least $10: Hyperliquid opens the address with the first deposit and keeps $1 of it.</span>
                    </div>
                  )}
                  {p.part === 'agent' && (
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void actions.runStep('agent')}>
                      Connect the agent (0.01 NEAR)
                    </button>
                  )}
                  {p.part === 'approve' && (
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void actions.runStep('approve')}>
                      Approve the agent
                    </button>
                  )}
                  {p.part === 'short' && (
                    <div className="d-flex flex-wrap align-items-center gap-2">
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void actions.runStep('short')}>
                        Open the short
                      </button>
                      <span className="small pb-muted">
                        Sells {answer ? formatUnits(held(answer, 'nBTC'), 8) : '?'} BTC on Hyperliquid, filled now, within the price band. The risk engine checks it first.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
