'use client';
// The last step of opening a basis trade: the loan. An amount with a sensible default, where it would come from, and
// one button. The button is the app's own check-then-act flow (components/check-flow.tsx): the risk engine checks the
// account, then the wallet opens once. An account that can use lenders borrows through `fund`, as on Home; another
// borrows from our pool.
import { useState } from 'react';

import { CheckFlow } from '@/components/check-flow';
import { WhereItComesFrom } from '@/components/home/lenders';
import { UsdcToken } from '@/config';
import type { ClientAccount } from '@/hooks/use-client-account';
import type { AccountAnswer, LenderAccountAnswer, LenderName } from '@/lib/api';
import { MIN_VALUE_TO_BORROW, openApproval, suggestedLoan } from '@/lib/basis';
import { canUseLenders, postedWords } from '@/lib/funding';
import { borrowTx, fundTx } from '@/lib/tx';
import { formatBp, formatUnits, formatUsd, parseUnits } from '@/lib/units';

interface Props {
  client: ClientAccount;
  answer: AccountAnswer;
  lender: LenderAccountAnswer | undefined;
  coin: string;
  /** What the coin in the account is worth, in micro-USD; null when its price wasn't read. */
  coinValue: bigint | null;
  /** What the account could borrow now, by its latest check; null before any check. */
  estimate: bigint | null;
  /** Our pool's rate for the account, in basis points a year. */
  poolRateBp: number | null;
  previewEnabled: boolean;
  paused: boolean;
  reload: () => void;
  /** INTERFACES.md 51.1: what each lender would take from the account, in a word, before it holds anything ("ether" at Rhea for an ETH trade on an account whose settings list it). */
  would?: Partial<Record<LenderName, string>>;
  /** Whether this account's Rhea takes the trade's coin: then Rhea is named as a source even before the engine's split is read. */
  rheaTakesCoin?: boolean;
}

export function LoanBox({ client, answer, lender, coin, coinValue, estimate, poolRateBp, previewEnabled, paused, reload, would, rheaTakesCoin }: Props) {
  const suggested = suggestedLoan({ estimate, coinValue });
  // The field follows the suggestion until the client types in it.
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? (suggested ? formatUnits(suggested, UsdcToken.decimals) : '');
  const id = answer.account_id;
  const funded = canUseLenders(lender);

  let units: string | null = null;
  let problem: string | null = null;
  try {
    units = text ? parseUnits(text, UsdcToken.decimals) : null;
    if (units === '0') {
      units = null;
      problem = 'Enter an amount above 0';
    }
  } catch (error) {
    problem = (error as Error).message;
  }
  const waits = paused ? 'Borrowing is paused for a few minutes while a transfer out of Hyperliquid settles. Try again shortly.' : null;
  const ready = units && !paused ? units : null;
  const signed = 'Signed. The loan now arrives in steps, shown below. You approve nothing more.';

  return (
    <div>
      <label className="form-label small pb-muted mb-1" htmlFor="basis-loan">
        How much to borrow
      </label>
      <div className="input-group mb-1" style={{ maxWidth: 360 }}>
        <span className="input-group-text">$</span>
        <input id="basis-loan" className="form-control num" inputMode="decimal" value={text} onChange={(e) => setTyped(e.target.value)} placeholder="0.00" autoComplete="off" />
        <span className="input-group-text">USDC</span>
      </div>
      <div className="form-text mb-3">
        {estimate !== null && estimate > 0n
          ? `You can borrow about ${formatUsd(estimate)} now. If the risk engine allows less, the page offers that amount.`
          : coinValue !== null && coinValue < MIN_VALUE_TO_BORROW
            ? `Our pool lends against $1,000 of collateral or more. Your ${coin} is worth about ${formatUsd(coinValue)}, so the risk engine may lend nothing.`
            : suggested
              ? `A first loan of about 40% of your ${coin}. The risk engine works out the most you can borrow, and the page offers that if it is less.`
              : 'The risk engine works out the most you can borrow.'}
      </div>

      {funded && previewEnabled ? (
        <WhereItComesFrom account={id} amount={units} pricing={lender?.pricing?.pricing} posted={postedWords(lender, would)} />
      ) : funded && rheaTakesCoin ? (
        // The engine's own split isn't read here: the sources by name, and who looks at what.
        <p className="small mb-3">
          <span className="fw-medium">Where it comes from:</span> Rhea, against your {would?.rhea ?? 'collateral'}, and the broker’s own pool{poolRateBp !== null ? ` (${formatBp(poolRateBp)} a year)` : ''}, against your whole
          hedged book. The risk engine sets each part when you press Borrow.
        </p>
      ) : (
        <p className="small mb-3">
          <span className="fw-medium">Where it comes from:</span> the broker’s own pool{poolRateBp !== null ? `, at ${formatBp(poolRateBp)} a year` : ''}. It lends against your whole hedged book.
        </p>
      )}

      {units && !paused && <p className="small fw-medium mb-2">{openApproval('loan', coin, { loan: formatUsd(units) })}</p>}
      {funded ? (
        <CheckFlow
          account={answer}
          fetchedAt={client.fetchedAt}
          reload={reload}
          intent={ready ? { fund: { amount: ready } } : null}
          inputProblem={waits ?? problem}
          checkLabel="Check"
          act={units ? { label: `Borrow ${formatUsd(units)}`, use: { fund: { amount: units } }, tx: fundTx(id, units), done: signed } : null}
          // A check that lends less than was asked: the same check backs the smaller loan, once the client says yes.
          retarget={(allowed, held) =>
            'fund' in held.intent ? { label: `Borrow ${formatUsd(allowed)}`, use: { fund: { amount: held.intent.fund.amount, partial: true } }, tx: fundTx(id, held.intent.fund.amount), done: signed } : null
          }
          isOwner={client.isOwner}
        />
      ) : (
        <CheckFlow
          account={answer}
          fetchedAt={client.fetchedAt}
          reload={reload}
          intent={ready ? { borrow: { amount: ready } } : null}
          inputProblem={waits ?? problem}
          checkLabel="Check"
          act={ready ? { label: `Borrow ${formatUsd(ready)}`, use: { borrow: { amount: ready } }, tx: borrowTx(id, ready) } : null}
          retarget={(allowed) => ({ label: `Borrow ${formatUsd(allowed)}`, use: { borrow: { amount: allowed.toString() } }, tx: borrowTx(id, allowed.toString()) })}
          isOwner={client.isOwner}
        />
      )}
    </div>
  );
}
