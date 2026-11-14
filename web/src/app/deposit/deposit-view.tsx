'use client';
// "Deposit & withdraw" (INTERFACES.md 50.1 point 3; the user's words, 13 Nov: "it has to be deposit and withdraw",
// and "i see only deposit options, i need the withdraw workflow as well"). One page for both, on one read of the
// account, with the two names side by side at the top: one click shows either. Deposit (PLAN.md 5.8, Phase 2): test
// tokens from the faucet, then a deposit from the wallet. The third part, a deposit through 1Click, was taken off the
// page on 14 Nov (the user: "do we need that thing at all?"): on testnet it only turned one test token into the
// other, which the Spot tab does through the same stand-in. Withdraw: the form of before, with its check first while
// a loan is open (components/withdraw-form.tsx).
import Link from 'next/link';
import { useState } from 'react';

import { AccountPicker } from '@/components/account-picker';
import { ApiProblem, NotDeployed, WalletGate } from '@/components/notices';
import { TxStatus } from '@/components/tx-status';
import { Withdraw } from '@/components/withdraw-form';
import { NetworkId, Tokens } from '@/config';
import { useApi } from '@/hooks/use-api';
import { useClientAccount, type ClientAccount } from '@/hooks/use-client-account';
import { useTx } from '@/hooks/use-tx';
import { accountPath, type AccountAnswer } from '@/lib/api';
import { depositTx, mintTx } from '@/lib/tx';
import type { Token } from '@/lib/types';
import { displayUnits, formatUnits, parseUnits } from '@/lib/units';

export function DepositView() {
  return (
    <main className="pb-container pb-page" style={{ maxWidth: 960 }}>
      <h1 className="h3">Deposit &amp; withdraw</h1>
      <p className="lead">Put tokens into your account, or take them out to a wallet.</p>
      <WalletGate>
        <DepositBody />
      </WalletGate>
    </main>
  );
}

function DepositBody() {
  const client = useClientAccount();
  const wallet = useApi<AccountAnswer>(client.owner ? accountPath(client.owner) : null, 8_000);
  const ready = Boolean(client.answer?.state);
  // Which of the two shows.
  const [side, setSide] = useState<'deposit' | 'withdraw'>('deposit');

  return (
    <>
      <ApiProblem error={client.error ?? wallet.error} />
      <AccountPicker name={client.name} problem={client.problem} onName={client.setName} answer={client.answer} owner={client.owner} errorCode={client.errorCode} mine={client.mine} finding={client.finding} />
      {client.answer && <NotDeployed contracts={client.answer.not_deployed} />}
      {client.answer && !client.answer.exists && (
        <div className="alert alert-secondary small">
          This name has no account yet. <Link href="/">Open it on Home</Link> first: adding and withdrawing need it to exist.
        </div>
      )}
      <div className="btn-group mt-3 mb-3" role="tablist" aria-label="Deposit or withdraw">
        {(['deposit', 'withdraw'] as const).map((which) => (
          <button
            key={which}
            type="button"
            role="tab"
            aria-selected={side === which}
            className={`btn ${side === which ? 'btn-primary' : 'btn-outline-secondary'}`}
            style={{ minWidth: 140 }}
            onClick={() => setSide(which)}
          >
            <i className={`bi ${which === 'deposit' ? 'bi-box-arrow-in-down' : 'bi-box-arrow-up'}`} aria-hidden="true" /> {which === 'deposit' ? 'Deposit' : 'Withdraw'}
          </button>
        ))}
      </div>
      {side === 'deposit' && (
        <div id="deposit">
          {NetworkId === 'testnet' && <Faucet owner={client.owner} wallet={wallet.data} reload={wallet.reload} />}
          <FromWallet client={client} wallet={wallet.data} ready={ready} reloadWallet={wallet.reload} />
        </div>
      )}
      {side === 'withdraw' && (
        <section className="card mb-3" id="withdraw">
          <div className="card-header fw-semibold">Withdraw to a NEAR wallet</div>
          <div className="card-body">
            {client.answer?.state ? (
              <Withdraw client={client} answer={client.answer} previewEnabled={false} bare />
            ) : (
              <p className="small text-body-secondary mb-0">Once your account is open and holds tokens, you take them out here.</p>
            )}
          </div>
        </section>
      )}
    </>
  );
}

const balanceOf = (answer: AccountAnswer | undefined, token: Token) => answer?.balances.find((b) => b.token === token.id)?.amount ?? '0';

/** Reads an amount typed in a token's units: the units, or the problem in words. */
function readAmount(text: string, token: Token, max?: string): { units: string | null; problem: string | null } {
  if (!text) return { units: null, problem: null };
  try {
    const units = parseUnits(text, token.decimals);
    if (units === '0') return { units: null, problem: 'Enter an amount above 0' };
    if (max !== undefined && BigInt(units) > BigInt(max)) return { units: null, problem: `That is more than the ${formatUnits(max, token.decimals)} ${token.label} there` };
    return { units, problem: null };
  } catch (error) {
    return { units: null, problem: (error as Error).message };
  }
}

/** Testnet only: the test tokens' public faucet, to the wallet (PLAN.md 5.1). */
function Faucet({ owner, wallet, reload }: { owner: string; wallet: AccountAnswer | undefined; reload: () => void }) {
  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">1. Get test tokens</div>
      <div className="card-body small">
        <p>
          Testnet only: anyone can mint mUSDC (playing USDC) and mNBTC (playing nBTC) into their wallet. The first mint
          registers your wallet on the token for 0.00125 NEAR; after that the deposit comes back.
        </p>
        {Tokens.map((token) => (
          <MintRow key={token.id} token={token} owner={owner} balance={balanceOf(wallet, token)} reload={reload} />
        ))}
      </div>
    </section>
  );
}

const MINT_DEFAULTS: Record<string, string> = { USDC: '10000', nBTC: '0.25' };

function MintRow({ token, owner, balance, reload }: { token: Token; owner: string; balance: string; reload: () => void }) {
  const [text, setText] = useState(MINT_DEFAULTS[token.symbol] ?? '1');
  const tx = useTx();
  const { units, problem } = readAmount(text, token);
  return (
    <div className="mb-2">
      <div className="d-flex flex-wrap align-items-center gap-2">
        <input className="form-control form-control-sm" style={{ maxWidth: 160 }} value={text} onChange={(e) => setText(e.target.value)} aria-label={`${token.label} to mint`} />
        <button
          className="btn btn-sm btn-outline-primary"
          disabled={!units || tx.busy}
          onClick={async () => {
            if (!units) return;
            await tx.run(`Mint ${text} ${token.label}`, mintTx(token.id, owner, units));
            reload();
          }}
        >
          Get test {token.label}
        </button>
        <span className="text-body-secondary">Your wallet holds {displayUnits(balance, token.decimals, token.decimals)} {token.label}</span>
      </div>
      {problem && <div className="form-text text-danger">{problem}</div>}
      <TxStatus record={tx.last} busy={tx.busy} />
    </div>
  );
}

/** INTERFACES.md 4: ft_transfer_call to the account with msg "" is a deposit, kept. */
function FromWallet({ client, wallet, ready, reloadWallet }: { client: ClientAccount; wallet: AccountAnswer | undefined; ready: boolean; reloadWallet: () => void }) {
  const [tokenId, setTokenId] = useState(Tokens[0]!.id);
  const [text, setText] = useState('');
  const tx = useTx();
  const token = Tokens.find((t) => t.id === tokenId) ?? Tokens[0]!;
  const held = balanceOf(wallet, token);
  const { units, problem } = readAmount(text, token, held);
  const accountId = client.answer?.account_id;

  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">2. Deposit from your wallet</div>
      <div className="card-body small">
        <p>This moves tokens from your wallet into your account. Once they are there, they count as collateral.</p>
        <div className="d-flex flex-wrap align-items-center gap-2">
          <select className="form-select form-select-sm" style={{ maxWidth: 120 }} value={tokenId} onChange={(e) => setTokenId(e.target.value)} aria-label="Token">
            {Tokens.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <input className="form-control form-control-sm" style={{ maxWidth: 200 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={`you hold ${formatUnits(held, token.decimals)}`} aria-label="Amount" />
          <button
            className="btn btn-sm btn-primary"
            disabled={!ready || !units || !accountId || tx.busy}
            onClick={async () => {
              if (!units || !accountId) return;
              await tx.run(`Deposit ${text} ${token.label}`, depositTx(token.id, accountId, units));
              reloadWallet();
              client.reload();
            }}
          >
            Deposit into the account
          </button>
        </div>
        {problem && <div className="form-text text-danger">{problem}</div>}
        {client.answer && (
          <p className="mt-2 mb-0 text-body-secondary">
            The account holds{' '}
            {client.answer.balances.map((b, i) => (
              <span key={b.token}>
                {i > 0 && ' and '}
                {b.amount === null ? '?' : displayUnits(b.amount, b.decimals, b.decimals)} {Tokens.find((t) => t.id === b.token)?.label ?? b.symbol}
              </span>
            ))}
            .
          </p>
        )}
        <TxStatus record={tx.last} busy={tx.busy} />
      </div>
    </section>
  );
}
