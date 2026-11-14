'use client';
// Moving USDC between the account and its Hyperliquid address through 1Click (the stand-in on testnet), as
// INTERFACES.md 8 and 12 set out. Amounts are USDC, counted in micro-USDC as mUSDC and hl_withdraw count them.
//   To Hyperliquid: a quote, then withdraw(mUSDC, amountIn, the deposit address). With a loan, that withdrawal
//                   needs its own verdict first. The stand-in delivers USDC to the account's Hyperliquid address.
//   Home:           a quote, then hl_withdraw(amountIn, the float): the MPC signer signs a sendAsset and the
//                   backend posts it. The stand-in matches it by sender and exact amount, and delivers mUSDC.
// Then the live status, every 5 s, until it is final.
// The app's second shape (INTERFACES.md 49.5): the price shows as the amount is typed, and one button runs each move
// to the end: it holds the price, runs the check when a loan is out (the broker pays for it), opens the wallet once,
// and follows the move.
import { useState } from 'react';

import { CheckProgress } from '@/components/check-flow';
import { PhaseLine } from '@/components/hyperliquid-card';
import { TxStatus } from '@/components/tx-status';
import { UsdcToken } from '@/config';
import { useApi } from '@/hooks/use-api';
import { useCheckThenAct } from '@/hooks/use-check-then-act';
import type { ClientAccount } from '@/hooks/use-client-account';
import { useSignAndPost } from '@/hooks/use-sign-and-post';
import { useTx } from '@/hooks/use-tx';
import { useTypedPrice } from '@/hooks/use-typed-price';
import { ApiError, quoteMove, statusPath, type AccountAnswer, type MoveQuoteAnswer, type StatusAnswer } from '@/lib/api';
import { hlFunded, lastSignedIndex, loanOpen, type HlAnswer } from '@/lib/hl';
import { swapStatusWords } from '@/lib/swap';
import { buildMove, hlWithdrawTx, withdrawTx } from '@/lib/tx';
import { formatUnits, parseUnits } from '@/lib/units';

/** Hyperliquid opens an address on a first deposit of at least $10 (INTERFACES.md 8). */
const FIRST_DEPOSIT_MIN = 10_000_000n;

interface Props {
  client: ClientAccount;
  answer: AccountAnswer;
  hl: HlAnswer | undefined;
  reloadHl: () => void;
  previewEnabled: boolean;
  /** Without the card: inside a side panel. */
  bare?: boolean;
}

export function MoveUsdc({ client, answer, hl, reloadHl, previewEnabled, bare }: Props) {
  const body = (
    <>
        <p>
          Move USDC between the account on NEAR and its Hyperliquid address. Type an amount to see the price. 1Click carries it; on testnet our own stand-in plays
          1Click, with real prices.
        </p>
        {!hl?.address ? (
          <p className="text-body-secondary mb-0">Set up the Hyperliquid address first (step 1 of the Hyperliquid card).</p>
        ) : (
          <div className="row g-4">
            <div className={bare ? 'col-12' : 'col-lg-6'}>
              <ToHyperliquid client={client} answer={answer} hl={hl} />
            </div>
            <div className={bare ? 'col-12' : 'col-lg-6'}>
              <Home client={client} answer={answer} hl={hl} reloadHl={reloadHl} />
            </div>
          </div>
        )}
    </>
  );
  if (bare) return <div className="small">{body}</div>;
  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">Move USDC to and from Hyperliquid</div>
      <div className="card-body small">{body}</div>
    </section>
  );
}

/** Reads a USDC amount: micro-USDC, or the problem in words. */
function readUsdc(text: string, max?: bigint): { units: string | null; problem: string | null } {
  if (!text) return { units: null, problem: null };
  try {
    const units = parseUnits(text, 6);
    if (units === '0') return { units: null, problem: 'Enter an amount above 0' };
    if (max !== undefined && BigInt(units) > max) return { units: null, problem: `That is more than the ${formatUnits(max, 6)} USDC there` };
    return { units, problem: null };
  } catch (error) {
    return { units: null, problem: (error as Error).message };
  }
}

/** Phase 4 (INTERFACES.md 14): the account records the move as a pending transfer until 1Click's msg resolves it. */
function TransferNote({ id }: { id: string | null | undefined }) {
  if (!id) return null;
  return (
    <details className="text-body-secondary mt-1">
      <summary>The details</summary>
      The account records this move as pending transfer <code>{id}</code> until 1Click delivers or refunds it. Home lists it under “Money on its way”.
    </details>
  );
}

/** Polls 1Click's status for a committed quote until it is final, and says it in words. */
function MoveStatus({ quote, ends }: { quote: MoveQuoteAnswer | null; ends: { to: string; refundTo: string } }) {
  const address = quote?.quote.depositAddress;
  const status = useApi<StatusAnswer>(address ? statusPath(address, quote?.quote.depositMemo) : null, 5_000, (s) => swapStatusWords(s.status, ends).done);
  if (!address) return null;
  if (!status.data) return <p className="mt-2 mb-0">Status: {status.error ? status.error.message : 'asking…'}</p>;
  const shown = swapStatusWords(status.data.status, ends);
  return (
    <p className="mt-2 mb-0">
      Status: <span className={`badge text-bg-${shown.tone}`}>{status.data.status}</span> {shown.words}
      {status.data.swapDetails?.refundReason && ` (${status.data.swapDetails.refundReason})`}
    </p>
  );
}

/** A price in one line: what leaves, what arrives, and how long it takes. */
function PriceLine({ quote, from, to }: { quote: MoveQuoteAnswer; from: string; to: string }) {
  return (
    <p className="mt-2 mb-2">
      {from} sends {quote.quote.amountInFormatted} USDC; {to} gets about {quote.quote.amountOutFormatted} USDC, in about {quote.quote.timeEstimate} seconds.
    </p>
  );
}

function ToHyperliquid({ client, answer, hl }: { client: ClientAccount; answer: AccountAnswer; hl: HlAnswer }) {
  const [text, setText] = useState('');
  const [committed, setCommitted] = useState<MoveQuoteAnswer | null>(null);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const tx = useTx();
  const flow = useCheckThenAct(answer.account_id, client.reload);
  const held = BigInt(answer.balances.find((b) => b.token === UsdcToken.id)?.amount ?? '0');
  const read = readUsdc(text, held);
  const first = !hlFunded(hl.hyperliquid);
  const amountProblem = read.problem ?? (first && read.units && BigInt(read.units) < FIRST_DEPOSIT_MIN ? 'The first deposit must be at least 10 USDC: Hyperliquid opens the address with it, and keeps 1 USDC' : null);
  const units = amountProblem ? null : read.units;
  const hasLoan = loanOpen(answer.state!.loan);
  // INTERFACES.md 49.5: the price comes by itself, 400 ms after the last keystroke.
  const typed = useTypedPrice(units && !committed ? `to_hl:${units}` : null, () => quoteMove({ dry: true, move: 'to_hl', account: answer.account_id, amount: units ?? '0' }), committed !== null);
  const label = `Move ${text || '…'} USDC to Hyperliquid`;
  const running = starting || tx.busy || flow.busy || flow.state.phase === 'confirm';
  const stopped = flow.state.phase === 'refused' || flow.state.phase === 'failed';
  const again = () => {
    setCommitted(null);
    setProblem(null);
    flow.reset();
  };

  /** The one button: hold the price, run the check when a loan is out, open the wallet once, then follow the move. */
  const go = async () => {
    if (!units) return;
    setStarting(true);
    setProblem(null);
    try {
      const quote = await quoteMove({ dry: false, move: 'to_hl', account: answer.account_id, amount: units });
      const next = quote.move.next;
      // A price that expires more than 24 hours ahead isn't built (INTERFACES.md 40.5): the account would refuse it.
      const built = next?.method === 'withdraw' ? buildMove(() => withdrawTx(answer.account_id, next.args.token, next.args.amount, next.args.receiver, next.args.transfer)) : null;
      if (!built?.tx) {
        setProblem(built?.problem ?? 'The price came back without the next step, so nothing was sent. Try again in a moment.');
        return;
      }
      setCommitted(quote);
      if (hasLoan) {
        const use = { withdraw: { token: UsdcToken.id, amount: quote.quote.amountIn } };
        await flow.run({ intent: use, act: { label, use, tx: built.tx } });
      } else {
        const outcome = await tx.run(label, built.tx);
        if (!outcome) setCommitted(null);
      }
      client.reload();
    } catch (failure) {
      setProblem(`${failure instanceof ApiError ? failure.message : String(failure)} Nothing was sent.`);
    } finally {
      setStarting(false);
    }
  };
  const shown = committed ?? typed.price;

  return (
    <>
      <h3 className="h6">To Hyperliquid</h3>
      <p className="mb-2">USDC leaves the account and arrives at its Hyperliquid address, where it is the margin for your positions.</p>
      <div className="input-group input-group-sm" style={{ maxWidth: 260 }}>
        <input className="form-control" inputMode="decimal" value={text} disabled={committed !== null} onChange={(e) => setText(e.target.value)} placeholder={`holds ${formatUnits(held, 6)}`} aria-label="USDC to move to Hyperliquid" />
        <span className="input-group-text">USDC</span>
      </div>
      {text && amountProblem && <div className="form-text text-danger">{amountProblem}</div>}
      {typed.asking && <div className="form-text">Getting the price…</div>}
      {typed.error && !committed && <div className="alert alert-warning py-1 px-2 mt-2 mb-0">{typed.error}</div>}
      {shown && <PriceLine quote={shown} from="The account" to="the address" />}
      {!stopped && (
        <button className="btn btn-sm btn-primary mt-1" disabled={!units || !typed.price || running || committed !== null || !client.isOwner} onClick={() => void go()}>
          {running ? 'Working…' : label}
        </button>
      )}
      {!client.isOwner && <div className="form-text">Only the owner can move it.</div>}
      {problem && (
        <div className="alert alert-warning py-1 px-2 mt-2 mb-0">
          {problem}{' '}
          <button type="button" className="btn btn-link btn-sm p-0 align-baseline" onClick={again}>
            Try again
          </button>
        </div>
      )}
      <CheckProgress state={flow.state} actLabel={label} onConfirm={() => void flow.confirm()} onReset={again} onWallet={() => flow.again('wallet')} />
      <TxStatus record={tx.last} busy={tx.busy} />
      <MoveStatus quote={committed} ends={{ to: 'the Hyperliquid address', refundTo: 'the account' }} />
      {committed && <TransferNote id={committed.move.transfer_id} />}
    </>
  );
}

function Home({ client, answer, hl, reloadHl }: { client: ClientAccount; answer: AccountAnswer; hl: HlAnswer; reloadHl: () => void }) {
  const [text, setText] = useState('');
  const [committed, setCommitted] = useState<MoveQuoteAnswer | null>(null);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const signer = useSignAndPost(answer.account_id);
  const { units, problem: amountProblem } = readUsdc(text);
  const hasLoan = loanOpen(answer.state!.loan);
  const withdrawable = hl.hyperliquid?.clearinghouse_state?.withdrawable;
  const spot = hl.hyperliquid?.spot_usdc?.total;
  const typed = useTypedPrice(units && !committed && !hasLoan ? `home:${units}` : null, () => quoteMove({ dry: true, move: 'home', account: answer.account_id, amount: units ?? '0' }), committed !== null);
  const busy = starting || signer.tx.busy || signer.phase.kind === 'waiting' || signer.phase.kind === 'posting';
  const label = `Bring ${text || '…'} USDC home`;
  const again = () => {
    setCommitted(null);
    setProblem(null);
  };

  /** The one button: hold the price, have the account sign the transfer out of Hyperliquid, and follow it home. */
  const go = async () => {
    if (!units) return;
    setStarting(true);
    setProblem(null);
    try {
      const quote = await quoteMove({ dry: false, move: 'home', account: answer.account_id, amount: units });
      const next = quote.move.next;
      // A price that expires more than 24 hours ahead isn't built (INTERFACES.md 40.5): the account would refuse it.
      const built = next?.method === 'hl_withdraw' ? buildMove(() => hlWithdrawTx(answer.account_id, next.args.amount, next.args.destination, next.args.exp, undefined, next.args.expect)) : null;
      if (!built?.tx) {
        setProblem(built?.problem ?? 'The price came back without the next step, so nothing was sent. Try again in a moment.');
        return;
      }
      setCommitted(quote);
      await signer.run(label, built.tx, 'sendAsset', lastSignedIndex(hl.hl));
      reloadHl();
    } catch (failure) {
      setProblem(`${failure instanceof ApiError ? failure.message : String(failure)} Nothing was sent.`);
    } finally {
      setStarting(false);
    }
  };
  const shown = committed ?? typed.price;

  return (
    <>
      <h3 className="h6">Home from Hyperliquid</h3>
      <p className="mb-2">
        USDC leaves the Hyperliquid address and arrives in the account on NEAR.
        {withdrawable !== undefined && ` You can bring home up to ${withdrawable} USDC now${spot && Number(spot) > 0 ? `, and ${spot} more sits in spot` : ''}.`}
      </p>
      {hasLoan ? (
        <p className="text-body-secondary mb-0">Not while a loan is open. Repay the loan first, then bring the USDC home.</p>
      ) : (
        <>
          <div className="input-group input-group-sm" style={{ maxWidth: 260 }}>
            <input className="form-control" inputMode="decimal" value={text} disabled={committed !== null} onChange={(e) => setText(e.target.value)} placeholder="amount" aria-label="USDC to bring home" />
            <span className="input-group-text">USDC</span>
          </div>
          {text && amountProblem && <div className="form-text text-danger">{amountProblem}</div>}
          {typed.asking && <div className="form-text">Getting the price…</div>}
          {typed.error && !committed && <div className="alert alert-warning py-1 px-2 mt-2 mb-0">{typed.error}</div>}
          {shown && <PriceLine quote={shown} from="The address" to="the account" />}
          <button className="btn btn-sm btn-primary mt-1" disabled={!units || !typed.price || busy || committed !== null || !client.isOwner} onClick={() => void go()}>
            {busy ? 'Working…' : label}
          </button>
          {!client.isOwner && <div className="form-text">Only the owner can move it.</div>}
          {problem && (
            <div className="alert alert-warning py-1 px-2 mt-2 mb-0">
              {problem}{' '}
              <button type="button" className="btn btn-link btn-sm p-0 align-baseline" onClick={again}>
                Try again
              </button>
            </div>
          )}
          <TxStatus record={signer.tx.last} busy={signer.tx.busy} />
          <PhaseLine phase={signer.phase} />
          {/* The wallet was closed, or the signature didn't go out: the amount can be tried again. */}
          {committed && !busy && (signer.tx.last?.error || signer.tx.last?.failure || signer.phase.kind === 'failed') && (
            <button type="button" className="btn btn-link btn-sm p-0" onClick={again}>
              Try again
            </button>
          )}
          <MoveStatus quote={committed} ends={{ to: 'the account', refundTo: 'the Hyperliquid address' }} />
          {committed && <TransferNote id={committed.move.transfer_id} />}
        </>
      )}
    </>
  );
}
