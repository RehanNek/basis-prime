'use client';
// The account's own address on Aave's chain, on Home (stage 3; FUNDING.md 4.5; INTERFACES.md 33). It is the address
// Chain Signatures gave the account for Hyperliquid, the same on every such chain. The card shows what sits there
// (the collateral Aave can take, and the USDC a loan from Aave arrives as), its gas, and the transactions the account
// signed, each as signed, sent, mined or failed, with a link to Base Sepolia's explorer.
import { useState } from 'react';

import { EvmTxLink } from '@/components/evm-lines';
import { Dot } from '@/components/flow-progress';
import { NetworkId } from '@/config';
import { ApiError, evmGas, evmSubmit, type EvmAnswer, type EvmSigned } from '@/lib/api';
import { EVM_CHAIN_NAME, evmAddressUrl, evmStatus, gasView, shortAddress, signedWords, STATUS_LABEL, statusWords, tokenAmount } from '@/lib/evm';
import { MOVES, type MoveKey } from '@/lib/moves';
import { formatUsd } from '@/lib/units';

interface Props {
  accountId: string;
  evm: EvmAnswer;
  isOwner: boolean;
  /** Testnet: the backend's gas helper is on (`on` in GET /api/evm/gas), so "Get test gas" has something to ask. */
  gasHelp: boolean;
  /** Opens the panel that sends a token out of the address. */
  onSendOut: () => void;
  /** Testnet, the owner: opens the panel for a move between NEAR and this address (stage 4). */
  onMove?: (key: MoveKey) => void;
  /** INTERFACES.md 51.2: the account's own settings list test ETH, so its ETH can move here and back. */
  ether?: boolean;
  /** Reads the account at its lenders again, after something changed at the address. */
  reload: () => void;
}

/** How many of the signed transactions the card lists: the newest. */
const SHOWN = 5;

export function EvmCard({ accountId, evm, isOwner, gasHelp, onSendOut, onMove, ether, reload }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string; hash?: string } | null>(null);
  if (!evm.address) return null;
  const gas = gasView(evm.eth);
  const some = (amount: string) => /^\d+$/.test(amount) && BigInt(amount) > 0n;
  const holds = evm.wallet.some((t) => some(t.amount));
  const usdcThere = evm.wallet.some((t) => t.symbol === 'USDC' && some(t.amount));
  const collateralThere = evm.wallet.some((t) => t.symbol !== 'USDC' && some(t.amount));
  const wethThere = evm.wallet.some((t) => t.symbol === 'WETH' && some(t.amount));
  // The USDC always, and each collateral token that is there.
  const shown = evm.wallet.filter((t) => t.symbol === 'USDC' || some(t.amount));
  const newest = [...evm.signed].sort((a, b) => b.nonce - a.nonce).slice(0, SHOWN);

  /** One request to the backend, with what came of it said under the card's rows. */
  const ask = async (what: string, request: () => Promise<{ text: string; hash?: string }>) => {
    setBusy(what);
    setSaid(null);
    try {
      setSaid({ ok: true, ...(await request()) });
    } catch (error) {
      setSaid({ ok: false, text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(null);
      reload();
      // What was just sent is mined a few seconds later: read the address again then, not only at the next half minute.
      for (const ms of [4_000, 10_000]) setTimeout(reload, ms);
    }
  };
  const getGas = () =>
    ask('gas', async () => {
      const answer = await evmGas(accountId);
      return answer.eth.hash ? { text: 'Gas is on its way to the address.', hash: answer.eth.hash } : { text: 'The address has enough gas already, so none was sent.' };
    });
  const sendAgain = (entry: EvmSigned) =>
    ask(`send:${entry.nonce}`, async () => {
      const answer = await evmSubmit(accountId, entry.nonce);
      const text = answer.status !== 'mined' ? `It is sent to ${EVM_CHAIN_NAME}.` : answer.reverted ? `${EVM_CHAIN_NAME} mined it, but it failed there, so nothing moved.` : `It is mined on ${EVM_CHAIN_NAME}.`;
      return { text, hash: answer.hash };
    });

  return (
    <section className="pb-card" aria-labelledby="evm-title">
      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <h2 id="evm-title" className="pb-card-title mb-0">
          Your address on {EVM_CHAIN_NAME}
        </h2>
        <a href={evmAddressUrl(evm.address)} target="_blank" rel="noreferrer" className="pb-pill neutral ms-auto" title={evm.address}>
          {shortAddress(evm.address)} <i className="bi bi-box-arrow-up-right" style={{ fontSize: '0.7rem' }} aria-hidden="true" />
        </a>
      </div>
      <div className="small pb-muted mb-3">
        The account’s own address there: no person holds its key, and the account signs for it through Chain Signatures. Aave lends against what the account posts from
        here, and a loan from Aave arrives here as USDC.
      </div>
      {evm.chain_error && (
        <div className="small text-danger mb-2">
          {EVM_CHAIN_NAME} couldn’t be read just now ({evm.chain_error}), so what sits at the address and where each transaction stands are missing here. Nothing is
          lost: this page reads it again on its own.
        </div>
      )}
      <dl className="pb-rows">
        {/* Each token by its own name and decimals: the collateral may be bitcoin or, on Aave's test market, ether. */}
        {shown.map((token) => (
          <div key={token.token}>
            <dt>{token.symbol}</dt>
            <dd>
              <span className="num">{token.symbol === 'USDC' && token.decimals === 6 ? formatUsd(token.amount) : tokenAmount(token.amount, token)}</span>
              <span className="sub">{token.symbol === 'USDC' ? 'Repays Aave from here' : 'Aave takes it as collateral'}</span>
            </dd>
          </div>
        ))}
        {!evm.chain_error && !shown.some((t) => t.symbol !== 'USDC') && (
          <div>
            <dt>Collateral</dt>
            <dd>
              <span className="num">None here</span>
              <span className="sub">What Aave holds shows on its card</span>
            </dd>
          </div>
        )}
        <div>
          <dt>Gas</dt>
          <dd>
            <span className="num">{gas.amount}</span>
            <span className={`sub ${gas.enough === false ? 'text-danger' : ''}`}>{gas.words}</span>
          </dd>
        </div>
      </dl>
      <div className="d-flex flex-wrap gap-2 mt-3">
        <button type="button" className="btn btn-sm btn-outline-secondary" disabled={!isOwner || !holds} onClick={onSendOut}>
          Send a token out
        </button>
        {NetworkId === 'testnet' && gasHelp && (
          <button type="button" className={`btn btn-sm ${gas.enough === false ? 'btn-primary' : 'btn-outline-secondary'}`} disabled={busy !== null} onClick={() => void getGas()}>
            {busy === 'gas' ? 'Asking…' : 'Get test gas'}
          </button>
        )}
      </div>
      {/* Stage 4, testnet: the moves between NEAR and this address, through 1Click's stand-in. Each opens its own panel. */}
      {onMove && (
        <>
          <div className="d-flex flex-wrap gap-2 mt-2">
            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => onMove('bitcoin-out')}>
              {MOVES['bitcoin-out'].title}
            </button>
            {usdcThere && (
              <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => onMove('loan-home')}>
                {MOVES['loan-home'].title}
              </button>
            )}
            {collateralThere && (
              <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => onMove('bitcoin-home')}>
                {MOVES['bitcoin-home'].title}
              </button>
            )}
            {/* The client's own ETH, beside the bitcoin moves, for an account whose settings list test ETH. */}
            {ether && (
              <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => onMove('ether-out')}>
                {MOVES['ether-out'].title}
              </button>
            )}
            {ether && wethThere && (
              <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => onMove('ether-home')}>
                {MOVES['ether-home'].title}
              </button>
            )}
          </div>
          <div className="form-text">Moves between NEAR and this address go through 1Click. On testnet our own stand-in plays it, and each move costs a little and takes a few minutes.</div>
        </>
      )}
      {said && (
        <div className={`form-text ${said.ok ? '' : 'text-danger'}`}>
          {said.text}
          <EvmTxLink hash={said.hash} />
        </div>
      )}

      {newest.length > 0 && (
        <>
          <h3 className="pb-sources-title mt-3">What the account signed there</h3>
          <ul className="pb-flow mt-0 mb-0">
            {newest.map((entry) => {
              const status = evmStatus(entry.status);
              return (
                <li key={`${entry.nonce}:${entry.hash}`}>
                  <Dot mark={status === 'mined' ? 'done' : status === 'failed' ? 'failed' : status === 'replaced' ? 'todo' : 'busy'} />
                  <div>
                    <div className="what">
                      {signedWords(entry, evm.wallet)}
                      <span className={`pb-pill ms-2 ${status === 'mined' ? 'good' : status === 'failed' ? 'bad' : status === 'replaced' ? 'neutral' : 'warn'}`}>{STATUS_LABEL[status]}</span>
                    </div>
                    <div className="how">
                      {statusWords(entry.kind, status)}
                      <EvmTxLink hash={entry.hash} />
                      {status === 'signed' && (
                        <button type="button" className="btn btn-link btn-sm p-0 ms-2 align-baseline" disabled={busy !== null} onClick={() => void sendAgain(entry)}>
                          {busy === `send:${entry.nonce}` ? 'Sending…' : 'Send it now'}
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
