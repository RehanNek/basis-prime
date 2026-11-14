'use client';
// Getting an account ready to trade, on the Perps page itself (INTERFACES.md 51.9). The user, 14 Nov, on a new
// wallet: "i went to trade on hyperliquid but i was redirected to account and then im stuck here after step 3 ... can
// we make this entire process more intuitve?" Before, the order form sent a new account to the Account page's
// Hyperliquid card, which named contract methods and let the steps be pressed out of order.
//   - The four steps show where the order would be placed, each in one plain line, with what is done ticked off.
//   - One button does every step that is left, in order: the wallet opens once for each, and a step that fails stops
//     the run and says why. The button then goes on from that step.
//   - The steps themselves are Home's (components/home/setup-actions.ts): each returns once its effect shows on the
//     chain or on Hyperliquid.
import Link from 'next/link';
import { useState } from 'react';

import { Dot, TxLink } from '@/components/flow-progress';
import { useSetupActions } from '@/components/home/setup-actions';
import { NetworkId } from '@/config';
import type { ClientAccount } from '@/hooks/use-client-account';
import type { HlAnswer } from '@/lib/hl';
import { held } from '@/lib/setup';
import { MARGIN_MIN, readMargin, setupButtonWords, setupLeadWords, suggestedMargin, TRADE_PARTS, tradePartsDone, tradePartsLeft } from '@/lib/trade-setup';
import { displayUnits } from '@/lib/units';

interface Props {
  client: ClientAccount;
  accountId: string;
  hl: HlAnswer;
  reloadHl: () => void;
}

export function TradeSetup({ client, accountId, hl, reloadHl }: Props) {
  const testnet = NetworkId === 'testnet';
  const actions = useSetupActions({ accountId, owner: client.owner, name: client.name, reloadAccount: client.reload, reloadHl });
  const usdc = held(client.answer, 'USDC');
  /** What is typed for the first move; until something is, the suggestion shows. */
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? suggestedMargin(usdc);
  const margin = readMargin(text, usdc, testnet);
  /** The whole run, from the click to its last step: the button stays off between two steps too. */
  const [running, setRunning] = useState(false);

  const done = tradePartsDone(hl);
  const left = tradePartsLeft(hl);
  const next = left[0] ?? null;
  const needsMargin = left.includes('margin');
  const short = needsMargin && usdc < MARGIN_MIN;
  const busy = running || actions.busy;
  const ready = client.isOwner && !busy && left.length > 0 && (!needsMargin || margin.units !== null);

  const run = async () => {
    if (!ready) return;
    setRunning(true);
    try {
      for (const part of left) {
        const worked = await actions.runStep(part, part === 'margin' ? (margin.units ?? undefined) : undefined);
        if (!worked) return;
      }
      actions.clear();
    } finally {
      setRunning(false);
    }
  };

  const status = actions.status;
  return (
    <div className="mt-1">
      <div className="fw-semibold" style={{ fontSize: '0.95rem' }}>
        Before your first trade
      </div>
      <p className="pb-muted mb-2">{setupLeadWords(left)}</p>

      <ul className="pb-flow mt-0 mb-2">
        {TRADE_PARTS.map((p, i) => {
          const mark = done[p.part] ? 'done' : p.part === next ? (busy ? 'busy' : 'current') : 'todo';
          return (
            <li key={p.part}>
              <Dot mark={mark} n={i + 1} />
              <div className="flex-grow-1">
                <div className={`what ${mark === 'todo' ? 'todo' : ''}`}>{p.title}</div>
                {!done[p.part] && <div className="how">{p.why}</div>}
                {p.part === 'margin' && !done.margin && (
                  <div className="mt-1">
                    {short ? (
                      <div>
                        Your account holds {displayUnits(usdc, 6, 2)} USDC, and this needs at least $10. <Link href="/deposit">Deposit USDC first</Link>, then come back.
                      </div>
                    ) : (
                      <>
                        <div className="input-group input-group-sm" style={{ maxWidth: 220 }}>
                          <span className="input-group-text">$</span>
                          <input
                            className="form-control num"
                            inputMode="decimal"
                            autoComplete="off"
                            value={text}
                            disabled={busy}
                            onChange={(event) => setTyped(event.target.value)}
                            aria-label="USDC to move to Hyperliquid"
                          />
                          <span className="input-group-text">USDC</span>
                        </div>
                        <div className={margin.problem ? 'text-danger' : 'pb-muted'} role={margin.problem ? 'alert' : undefined}>
                          {margin.problem ?? `Your account holds ${displayUnits(usdc, 6, 2)} USDC. Hyperliquid keeps $1 of the first deposit.`}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {status.kind === 'running' && (
        <div className="mb-2" role="status" aria-live="polite">
          <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
          <span className="fw-medium">{status.what}.</span> {status.detail}
        </div>
      )}
      {status.kind === 'done' && left.length > 0 && (
        <div className="mb-2" aria-live="polite">
          {status.what}.<TxLink hash={status.hash} />
        </div>
      )}
      {status.kind === 'failed' && (
        <div className="alert alert-warning mb-2" role="alert">
          <div className="fw-medium">{status.what} didn’t finish.</div>
          <div>{status.why}</div>
          <div className="mt-1">Nothing after it was started. Press the button to go on from this step.</div>
        </div>
      )}

      <button type="button" className="btn btn-primary w-100" disabled={!ready} onClick={() => void run()}>
        {busy && <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />}
        {setupButtonWords(left, busy)}
      </button>
      {!client.isOwner && <div className="pb-muted mt-1">Only the account’s owner can set it up.</div>}
    </div>
  );
}
