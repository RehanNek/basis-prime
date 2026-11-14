'use client';
// The Basis trade page (INTERFACES.md 49.1, point 5; it takes the place of "Set up the demo for me"). What the trade
// is, in three lines; "Open a basis trade", which leads from a token and a size to the loan; and "Close everything",
// the way out in one guided run. The page shows an account, so a wallet that hasn't confirmed it is the owner's sees
// the sign-in card in its place (INTERFACES.md 48.6).
import { useState } from 'react';

import { AccountPicker } from '@/components/account-picker';
import { CloseTrade } from '@/components/basis/close-trade';
import { OpenTrade } from '@/components/basis/open-trade';
import { useBasisData } from '@/components/basis/use-basis-data';
import { ApiProblem, NotDeployed, WalletGate } from '@/components/notices';
import { SendWindowNotice } from '@/components/send-window-notice';

/** The trade in three short lines. */
const THE_TRADE = [
  { title: 'Hold the coin', text: 'It sits in your own account on NEAR.' },
  { title: 'Short the same amount on Hyperliquid', text: 'The coin’s price moves then cancel out.' },
  { title: 'Borrow dollars against both', text: 'The loan counts the coin and the short together.' },
];

export function BasisView() {
  return (
    <main className="pb-container pb-page" style={{ maxWidth: 880 }}>
      <h1 className="h3">Basis trade</h1>
      <div className="pb-steps3 mb-4">
        {THE_TRADE.map((line, i) => (
          <div key={line.title} className="pb-card">
            <div className="n mb-2">{i + 1}</div>
            <div className="fw-semibold mb-1">{line.title}</div>
            <div className="pb-muted small">{line.text}</div>
          </div>
        ))}
      </div>
      <WalletGate>
        <BasisBody />
      </WalletGate>
    </main>
  );
}

function BasisBody() {
  const data = useBasisData();
  const { client, answer, state } = data;
  const [picking, setPicking] = useState(false);
  // One run at a time: while one card's run is on, the other card offers nothing.
  const [running, setRunning] = useState<'open' | 'close' | null>(null);

  return (
    <>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-3 small">
        {client.accountId && (
          <span className="pb-muted">
            Account <span className="text-break fw-medium">{client.accountId}</span>
            {answer && !answer.exists ? ' (not opened yet)' : ''}
          </span>
        )}
        <button type="button" className="btn btn-link btn-sm p-0" onClick={() => setPicking(!picking)}>
          {picking ? 'Done' : 'Another account'}
        </button>
      </div>
      {picking && (
        <AccountPicker name={client.name} problem={client.problem} onName={client.setName} answer={answer} owner={client.owner} errorCode={client.errorCode} mine={client.mine} finding={client.finding} />
      )}
      <ApiProblem error={data.error} />
      {answer && <NotDeployed contracts={answer.not_deployed} />}
      {state && answer && <SendWindowNotice hl={state.hl} accountId={answer.account_id} reload={data.reloadAll} onNewName={client.setName} />}

      <OpenTrade data={data} closing={running === 'close'} onRunning={(on) => setRunning(on ? 'open' : null)} />
      <CloseTrade data={data} opening={running === 'open'} onRunning={(on) => setRunning(on ? 'close' : null)} />
    </>
  );
}
