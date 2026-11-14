'use client';
// The withdraw form (PLAN.md 5.8), on "Deposit & withdraw" (INTERFACES.md 50.1 point 3), the Account page and the Activity
// page. With no loan a withdrawal needs no verdict; with one, it needs a fresh verdict for the same token and amount
// (INTERFACES.md 4).
import { useState } from 'react';

import { CheckFlow } from '@/components/check-flow';
import { TxStatus } from '@/components/tx-status';
import { Tokens } from '@/config';
import type { ClientAccount } from '@/hooks/use-client-account';
import { useTx } from '@/hooks/use-tx';
import type { AccountAnswer } from '@/lib/api';
import { loanOpen } from '@/lib/hl';
import { isAccountId } from '@/lib/names';
import { withdrawTx } from '@/lib/tx';
import { formatUnits, parseUnits } from '@/lib/units';

export function Withdraw({ client, answer, previewEnabled, bare }: { client: ClientAccount; answer: AccountAnswer; previewEnabled: boolean; bare?: boolean }) {
  const [tokenId, setTokenId] = useState(Tokens[0]!.id);
  const [amountText, setAmountText] = useState('');
  const [receiverText, setReceiverText] = useState('');
  const direct = useTx();

  const token = Tokens.find((t) => t.id === tokenId) ?? Tokens[0]!;
  const balance = answer.balances.find((b) => b.token === token.id)?.amount ?? '0';
  const receiver = receiverText.trim() || client.owner;
  let amount: string | null = null;
  let problem: string | null = null;
  try {
    amount = amountText ? parseUnits(amountText, token.decimals) : null;
    if (amount === '0') problem = 'Enter an amount above 0';
    else if (amount && BigInt(amount) > BigInt(balance)) problem = `The account holds ${formatUnits(balance, token.decimals)} ${token.label}`;
  } catch (error) {
    problem = (error as Error).message;
  }
  if (!problem && !isAccountId(receiver)) problem = 'The receiver is not a valid NEAR account id';
  const ready = amount && !problem ? amount : null;
  const tx = ready ? withdrawTx(answer.account_id, token.id, ready, receiver) : null;
  const hasLoan = loanOpen(answer.state!.loan);

  const body = (
    <>
        <p>
          {hasLoan
            ? 'Take a token out to a NEAR wallet. You have a loan open, so the risk engine checks the withdrawal first: it goes through only if the loan stays covered.'
            : 'Take a token out to a NEAR wallet. With no loan open it goes straight through.'}
        </p>
        <div className="row g-2 mb-2">
          <div className="col-sm-3">
            <select className="form-select form-select-sm" value={tokenId} onChange={(e) => setTokenId(e.target.value)} aria-label="Token">
              {Tokens.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="col-sm-4">
            <input className="form-control form-control-sm" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder={`amount (holds ${formatUnits(balance, token.decimals)})`} aria-label="Amount" />
          </div>
          <div className="col-sm-5">
            <input className="form-control form-control-sm" value={receiverText} onChange={(e) => setReceiverText(e.target.value)} placeholder={`to ${client.owner}`} aria-label="Receiver" />
          </div>
        </div>
        {hasLoan ? (
          <CheckFlow
            account={answer}
            fetchedAt={client.fetchedAt}
            reload={client.reload}
            intent={ready ? { withdraw: { token: token.id, amount: ready } } : null}
            inputProblem={amountText ? problem : null}
            checkLabel="Withdraw"
            previewEnabled={previewEnabled}
            act={tx && ready ? { label: `Withdraw ${amountText} ${token.label}`, use: { withdraw: { token: token.id, amount: ready } }, tx } : null}
            isOwner={client.isOwner}
          />
        ) : (
          <>
            <button
              className="btn btn-sm btn-success"
              disabled={!tx || !client.isOwner || direct.busy}
              onClick={async () => {
                if (!tx) return;
                await direct.run(`Withdraw ${amountText} ${token.label}`, tx);
                client.reload();
              }}
            >
              Withdraw
            </button>
            {amountText && problem && <div className="form-text text-danger">{problem}</div>}
            {!client.isOwner && <div className="form-text">Only the owner can withdraw.</div>}
            <TxStatus record={direct.last} busy={direct.busy} />
          </>
        )}
    </>
  );
  if (bare) return <div className="small">{body}</div>;
  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">Withdraw</div>
      <div className="card-body small">{body}</div>
    </section>
  );
}
