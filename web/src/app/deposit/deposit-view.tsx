'use client';
// "Deposit & withdraw" (INTERFACES.md 50.1 point 3; the user's words, 13 Nov: "it has to be deposit and withdraw",
// and "i see only deposit options, i need the withdraw workflow as well"). One page for both, on one read of the
// account, with the two names side by side at the top: one click shows either. Deposit (PLAN.md 5.8, Phase 2): test
// tokens from the faucet, a deposit from the wallet, and a deposit through 1Click (the shim on testnet) with a live
// status. Withdraw: the form of before, with its check first while a loan is open (components/withdraw-form.tsx).
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
import { useTypedPrice } from '@/hooks/use-typed-price';
import { accountPath, ApiError, quote, statusPath, type AccountAnswer, type QuoteAnswer, type StatusAnswer, type SwapStatus } from '@/lib/api';
import { depositTx, mintTx, oneClickDepositTx } from '@/lib/tx';
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
          <ThroughOneClick client={client} ready={ready} />
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

/** 1Click's statuses in words (PLAN.md 5.4: REFUNDED, FAILED and INCOMPLETE_DEPOSIT are shown, not hidden). */
const STATUS_WORDS: Record<SwapStatus, { words: string; tone: string; done: boolean }> = {
  PENDING_DEPOSIT: { words: 'Waiting for your deposit to reach the deposit address.', tone: 'secondary', done: false },
  KNOWN_DEPOSIT_TX: { words: '1Click has seen the deposit transaction.', tone: 'info', done: false },
  PROCESSING: { words: 'The deposit arrived; 1Click is delivering it.', tone: 'info', done: false },
  SUCCESS: { words: 'Delivered into the account.', tone: 'success', done: true },
  INCOMPLETE_DEPOSIT: { words: 'Less than the quoted amount arrived before the deadline; what came is refunded.', tone: 'warning', done: true },
  REFUNDED: { words: 'Refunded to your wallet.', tone: 'warning', done: true },
  FAILED: { words: 'Failed: nothing moved.', tone: 'danger', done: true },
};

/** PLAN.md 5.4, "Deposit from any chain": a quote through the backend, a deposit address, the wallet pays it, 1Click delivers. */
function ThroughOneClick({ client, ready }: { client: ClientAccount; ready: boolean }) {
  const [fromId, setFromId] = useState(Tokens[1]!.id);
  const [toId, setToId] = useState(Tokens[0]!.id);
  const [text, setText] = useState('');
  const [committed, setCommitted] = useState<QuoteAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tx = useTx();
  const [paid, setPaid] = useState(false);

  const from = Tokens.find((t) => t.id === fromId) ?? Tokens[1]!;
  const to = Tokens.find((t) => t.id === toId) ?? Tokens[0]!;
  const { units, problem } = readAmount(text, from);
  const accountId = client.answer?.account_id;

  const depositAddress = paid ? committed?.quote.depositAddress : undefined;
  // PLAN.md 5.4 polls every 5-10 s, until the status is final.
  const status = useApi<StatusAnswer>(depositAddress ? statusPath(depositAddress, committed?.quote.depositMemo) : null, 5_000, (s) => STATUS_WORDS[s.status]?.done ?? false);
  const shown = status.data ? STATUS_WORDS[status.data.status] : undefined;

  const body = (dry: boolean) => ({ dry, originAsset: `nep141:${from.id}`, destinationAsset: `nep141:${to.id}`, amount: units ?? '0', recipient: accountId ?? '', refundTo: client.owner });
  // INTERFACES.md 49.1 point 6: no "Get a price" button. The price comes as the amount is typed, and one button does
  // the rest: it holds the price, gets the deposit address and opens the wallet to pay it.
  const typed = useTypedPrice(ready && units && accountId ? `${from.id}:${to.id}:${units}` : null, () => quote(body(true)), busy || paid);
  const priced = committed ?? typed.price;
  const go = async () => {
    if (!units || !accountId) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await quote(body(false));
      const address = answer.quote.depositAddress;
      if (!address) {
        setError('The price came back without a deposit address, so nothing was sent. Try again in a moment.');
        return;
      }
      setCommitted(answer);
      const outcome = await tx.run(`Send ${answer.quote.amountInFormatted} ${from.label} to 1Click`, oneClickDepositTx(from.id, address, answer.quote.amountIn));
      if (outcome) setPaid(true);
    } catch (failure) {
      setError(`${failure instanceof ApiError ? failure.message : String(failure)} Nothing was sent. Try again.`);
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    setCommitted(null);
    setPaid(false);
    setError(null);
  };

  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">3. Or deposit through 1Click</div>
      <div className="card-body small">
        <p>
          1Click takes a token from any chain and delivers the one you pick into the account, with a message the account books
          as a deposit. {NetworkId === 'testnet' && '1Click has no testnet, so our shim stands in for it here: real prices, simulated delivery from its float.'}
        </p>
        <div className="d-flex flex-wrap align-items-center gap-2">
          <span>Send</span>
          <input className="form-control form-control-sm" style={{ maxWidth: 140 }} value={text} onChange={(e) => { setText(e.target.value); reset(); }} placeholder="amount" aria-label="Amount to send" />
          <select className="form-select form-select-sm" style={{ maxWidth: 110 }} value={fromId} onChange={(e) => { setFromId(e.target.value); reset(); }} aria-label="Token to send">
            {Tokens.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <span>and the account gets</span>
          <select className="form-select form-select-sm" style={{ maxWidth: 110 }} value={toId} onChange={(e) => { setToId(e.target.value); reset(); }} aria-label="Token the account gets">
            {Tokens.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        {problem && <div className="form-text text-danger">{problem}</div>}
        {!priced && typed.asking && <div className="form-text">Getting the price…</div>}
        {!priced && typed.error && <div className="form-text text-danger">{typed.error} The page asks again by itself.</div>}
        {priced && (
          <p className="mt-2 mb-2">
            You send {priced.quote.amountInFormatted} {from.label}; the account gets about {priced.quote.amountOutFormatted} {to.label} (at least{' '}
            {formatUnits(priced.quote.minAmountOut, to.decimals)}), in about {priced.quote.timeEstimate} seconds.
          </p>
        )}
        <button type="button" className="btn btn-sm btn-primary mt-1" disabled={!ready || !units || !priced || busy || paid || tx.busy} onClick={() => void go()}>
          {busy ? 'Working…' : `Send ${text || '…'} ${from.label} through 1Click`}
        </button>
        {!paid && <div className="form-text">One click: your wallet opens once. It registers 1Click’s deposit address on the token (0.00125 NEAR), then pays it.</div>}
        {error && <div className="alert alert-warning small mt-2 mb-0">{error}</div>}
        {committed?.quote.depositAddress && (
          <details className="form-text">
            <summary>The details</summary>
            Deposit address <code>{committed.quote.depositAddress}</code>
            {committed.quote.deadline && <> · the price holds until {new Date(committed.quote.deadline).toLocaleTimeString()}</>}
          </details>
        )}
        <TxStatus record={tx.last} busy={tx.busy} />
        {depositAddress && (
          <p className="mt-2 mb-0">
            Status:{' '}
            {shown ? (
              <>
                <span className={`badge text-bg-${shown.tone}`}>{status.data!.status}</span> {shown.words}
                {status.data!.swapDetails?.refundReason && ` (${status.data!.swapDetails.refundReason})`}
              </>
            ) : (
              'asking…'
            )}
          </p>
        )}
      </div>
    </section>
  );
}
