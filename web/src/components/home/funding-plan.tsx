'use client';
// A loan's steps as the keeper runs them (FUNDING.md 8; INTERFACES.md 25 and 29, stage 2): the funding plan `fund`
// stored, each step going from waiting to done, read from `funding.steps` in GET /api/lender/:account. It says when
// the plan's 30 minutes ran out with steps left, and lets the owner drop the plan (`cancel_funding`).
// Stage 3 (INTERFACES.md 33): a step at Aave is an Ethereum transaction the account signs. It shows as signing, signed,
// sent and mined, from `evm.signed[].status`, with a link to it on Base Sepolia's explorer.
import { EvmTxLink } from '@/components/evm-lines';
import { FlowLine } from '@/components/flow-progress';
import { TxStatus } from '@/components/tx-status';
import { Tokens } from '@/config';
import { useNow } from '@/hooks/use-now';
import { useTx } from '@/hooks/use-tx';
import type { EvmAnswer } from '@/lib/api';
import { evmTokens, signedBySteps } from '@/lib/evm';
import { fundingPlanView } from '@/lib/fund';
import { cancelFundingTx } from '@/lib/tx';
import type { AccountState, FundingState } from '@/lib/types';

interface Props {
  accountId: string;
  funding: FundingState | null | undefined;
  /** The account's `pending`, for a Rhea action that is still finishing, and the block height it was read at. */
  pending?: unknown;
  height?: number;
  /**
   * Stage 3: the account's address on Aave's chain, with each signed transaction's status (GET /api/lender/:account),
   * and the account's own list of them (get_state().evm), which says which plan step signed each.
   */
  evm?: EvmAnswer | null;
  ownEvm?: AccountState['evm'];
  isOwner: boolean;
  /** Called after the plan is dropped, to read the account again. */
  onChanged: () => void;
  /** On Home, as a card of its own; in the borrow panel, under the button. */
  card?: boolean;
  /**
   * The account's own tokens on NEAR (GET /api/account's `balances`), so a step names what it posts: an account made
   * since 14 Nov may post test ETH at Rhea (INTERFACES.md 51.1), which the app's built-in list doesn't have.
   */
  balances?: { token: string; symbol: string; decimals: number }[];
}

export function FundingPlan({ accountId, funding, pending, height, evm, ownEvm, isOwner, onChanged, card, balances }: Props) {
  const now = useNow(5_000);
  const tx = useTx();
  // The tokens at the address name what a step posts: WBTC, or WETH on Aave's test market.
  const own = (balances ?? []).filter((b) => !Tokens.some((t) => t.id === b.token)).map((b) => ({ id: b.token, symbol: b.symbol, label: b.symbol, decimals: b.decimals }));
  const view = fundingPlanView(funding, now, { tokens: [...Tokens, ...own, ...evmTokens(evm)], pending, height, signed: evm ? signedBySteps(evm, ownEvm) : undefined });
  if (!view || !view.show) {
    // The last "dropped" line stays in view after the plan itself is gone.
    return tx.last ? <TxStatus record={tx.last} busy={tx.busy} /> : null;
  }

  const drop = async () => {
    await tx.run('Drop the plan', cancelFundingTx(accountId));
    onChanged();
  };

  const body = (
    <>
      <p className={`mb-1 ${view.status === 'expired' ? 'fw-medium' : ''}`}>{view.headline}</p>
      <div className="small pb-muted">{view.detail}</div>
      <ul className="pb-flow" aria-live="polite">
        {view.steps.map((step) => (
          <FlowLine
            key={step.i}
            mark={step.mark}
            n={step.i + 1}
            what={step.what}
            how={
              step.how || step.tx ? (
                <>
                  {step.how}
                  <EvmTxLink hash={step.tx?.hash} />
                </>
              ) : undefined
            }
          />
        ))}
      </ul>
      {view.status !== 'done' && (
        <div className="mt-2">
          <button type="button" className={`btn btn-sm ${view.status === 'expired' ? 'btn-primary' : 'btn-outline-secondary'}`} disabled={!isOwner || tx.busy} onClick={() => void drop()}>
            {view.status === 'expired' ? 'Drop the plan' : 'Stop here'}
          </button>
          <div className="form-text">
            {view.status === 'expired'
              ? 'Dropping it clears this notice. It changes nothing that already ran.'
              : 'Stopping drops the steps that haven’t started. A step that has started still finishes, so what was borrowed so far stays borrowed.'}
          </div>
          {!isOwner && <div className="form-text">Only the account’s owner can do this.</div>}
        </div>
      )}
      <TxStatus record={tx.last} busy={tx.busy} />
    </>
  );

  if (!card) {
    return (
      <section className="pb-sources mt-3" aria-labelledby="plan-title">
        <h3 id="plan-title" className="pb-sources-title">
          Your loan, step by step
        </h3>
        {body}
      </section>
    );
  }
  return (
    <section className={`pb-card mb-4 ${view.status === 'expired' ? 'pb-card-warn' : ''}`} aria-labelledby="plan-card-title">
      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <h2 id="plan-card-title" className="pb-card-title mb-0">
          Your loan, step by step
        </h2>
        <span className={`pb-pill ms-auto ${view.status === 'expired' ? 'warn' : view.status === 'done' ? 'good' : 'neutral'}`}>
          {view.status === 'expired' ? 'Ran out of time' : view.status === 'done' ? 'Done' : `About ${view.minutesLeft} min left`}
        </span>
      </div>
      {body}
    </section>
  );
}
