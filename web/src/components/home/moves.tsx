'use client';
// The four moves between NEAR and Aave's chain, on testnet (stage 4; INTERFACES.md 36; FUNDING.md 6.4 and 9):
//   Move bitcoin to Aave's chain   to_evm, nBTC      withdraw with transfer {"kind":"to_evm","exp"}
//   Send USDC to Aave's chain      to_evm, USDC      the same call
//   Bring the loan home            e_home, USDC      evm_withdraw with `exp`
//   Bring the bitcoin home         e_home, WBTC/WETH the same call
// The client starts each one. The app's second shape (INTERFACES.md 49.5): the price shows as the amount is typed
// (1Click's, our stand-in on testnet), and one button runs the move to the end: it holds the price, which names
// 1Click's address for the move; runs the check when the account needs one (`move.needs_check`), paid by the broker;
// opens the wallet once for the account's own call (`move.next`); and follows the move until it settles. A move home
// has the account sign a transfer on Aave's chain, which the page then sends, as for the other Aave steps.
import { useState } from 'react';

import { CheckFlow, CheckProgress } from '@/components/check-flow';
import { EvmLines } from '@/components/evm-lines';
import { Dot } from '@/components/flow-progress';
import { knownTokens, StagePill, useMoveStatus } from '@/components/pending-moves';
import { TxStatus } from '@/components/tx-status';
import { Tokens } from '@/config';
import type { ClientAccount } from '@/hooks/use-client-account';
import { useCheckThenAct } from '@/hooks/use-check-then-act';
import { useEvmSend } from '@/hooks/use-evm-send';
import { useTypedPrice } from '@/hooks/use-typed-price';
import { useNow } from '@/hooks/use-now';
import { useTx } from '@/hooks/use-tx';
import { ApiError, quoteMove, type AccountAnswer, type LenderAccountAnswer, type MoveQuoteAnswer } from '@/lib/api';
import { EVM_CHAIN_NAME, gasView, shortAddress } from '@/lib/evm';
import { toMicro } from '@/lib/funding';
import {
  CARRIER_WORDS,
  counted,
  etherCapWords,
  etherToken,
  isSizeRefusal,
  moveEnds,
  moveQuoteBody,
  MOVES,
  moveSources,
  moveStage,
  needsCheck,
  nextRefusal,
  nextTx,
  overEtherCap,
  quoteWords,
  rememberMove,
  sizeLimitWords,
  stageWords,
  type KnownToken,
  type MoveKey,
} from '@/lib/moves';
import { isOverdue, pendingTransfers } from '@/lib/risk';
import type { Outcome } from '@/lib/tx';
import { displayUnits, formatUnits, formatUsd, parseUnits } from '@/lib/units';
import type { Use } from '@/lib/verdict';

interface Props {
  which: MoveKey;
  client: ClientAccount;
  answer: AccountAnswer;
  lender?: LenderAccountAnswer;
  /** Kept for the pages that pass it: no preview is offered here. */
  previewEnabled?: boolean;
  reloadLender?: () => void;
  /** Today's prices, for the size limit in dollars and in bitcoin. */
  prices: { btc: number | null; eth: number | null };
  /** An amount the panel opens with: the Basis trade's "Move 0.02 ETH to Aave's chain". */
  initial?: string;
}

/** What each move has nothing of, said plainly. */
const NOTHING: Record<MoveKey, string> = {
  'bitcoin-out': 'The account holds no nBTC on NEAR to move.',
  'usdc-out': 'The account holds no USDC on NEAR to send.',
  'loan-home': `No USDC sits at the account’s address on ${EVM_CHAIN_NAME}, so there is nothing to bring home. A loan from Aave arrives there.`,
  'bitcoin-home': `No collateral sits at the account’s address on ${EVM_CHAIN_NAME}. Take it back from Aave first, on Aave’s card.`,
  'ether-out': 'The account holds no ETH on NEAR to move. Buy some on Spot, or add it on “Deposit & withdraw”.',
  'ether-home': `No WETH sits at the account’s address on ${EVM_CHAIN_NAME}. Take it back from Aave first, on Aave’s card.`,
};

/** The one button's words, before the amount and the token. */
const VERB: Record<MoveKey, { start: string; end: string }> = {
  'bitcoin-out': { start: 'Move', end: '' },
  'usdc-out': { start: 'Send', end: '' },
  'loan-home': { start: 'Bring', end: ' home' },
  'bitcoin-home': { start: 'Bring', end: ' home' },
  'ether-out': { start: 'Move', end: ' to Aave’s chain' },
  'ether-home': { start: 'Bring', end: ' home' },
};

export function MoveBox({ which, client, answer, lender, reloadLender, prices, initial }: Props) {
  const def = MOVES[which];
  const id = answer.account_id;
  const evm = lender?.evm ?? null;
  const [tokenId, setTokenId] = useState('');
  const [text, setText] = useState(initial ?? '');
  const [committed, setCommitted] = useState<MoveQuoteAnswer | null>(null);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const direct = useTx();
  const now = useNow(5_000);
  const reload = () => {
    client.reload();
    reloadLender?.();
  };
  const evmSend = useEvmSend(id, reload);
  // The check, when the move needs one, and the wallet's approval: one run, started by the one button.
  const flow = useCheckThenAct(id, reload);

  // The account's own tokens on NEAR: the app's two, and whatever else its settings list (test ETH since 14 Nov).
  const near = [
    ...Tokens.map((t) => ({ token: { id: t.id, symbol: t.symbol, decimals: t.decimals }, amount: answer.balances.find((b) => b.token === t.id)?.amount ?? null })),
    ...answer.balances.filter((b) => !Tokens.some((t) => t.id === b.token)).map((b) => ({ token: { id: b.token, symbol: b.symbol, decimals: b.decimals }, amount: b.amount })),
  ];
  const ether = etherToken(answer.balances);
  const sources = moveSources(which, near, evm?.wallet ?? []);
  const tokens = knownTokens(evm?.wallet, answer.balances);
  const live = sources.find((s) => s.token.id === tokenId) ?? sources[0];
  // Once the move is under way the token may be gone from where it was: the panel keeps showing what it was about.
  const [kept, setKept] = useState<{ token: KnownToken; held: bigint } | null>(null);
  const picked = committed ? (kept ?? live) : live;

  const read = (() => {
    if (!picked || !text) return { units: null as string | null, problem: null as string | null };
    // The amount is fixed once the move has started.
    if (committed) return { units: committed.quote.amountIn, problem: null };
    try {
      const units = parseUnits(text, picked.token.decimals);
      if (units === '0') return { units: null, problem: 'Enter an amount above 0' };
      if (BigInt(units) > picked.held) return { units: null, problem: `That is more than the ${displayUnits(picked.held, picked.token.decimals, picked.token.decimals)} ${picked.token.symbol} there` };
      // INTERFACES.md 51.2: over the stand-in's cap no price is asked for; the cap's own line, already on show, says why.
      if (which === 'ether-out' && overEtherCap(units, picked.token.decimals)) return { units: null, problem: null };
      return { units, problem: null };
    } catch (error) {
      return { units: null, problem: (error as Error).message };
    }
  })();

  // INTERFACES.md 49.5: the price comes by itself, 400 ms after the last keystroke, and again before it runs out.
  const token = picked?.token.id ?? '';
  const units = read.units;
  const typed = useTypedPrice(units && token && !committed ? `${which}:${token}:${units}` : null, () => quoteMove(moveQuoteBody(which, { dry: true, account: id, token, amount: units ?? '0', ether })), committed !== null);

  // What the stand-in says of the move this panel started, and the account's own record of it.
  const started = sent ? committed : null;
  const status = useMoveStatus(started?.quote.depositAddress ? { depositAddress: started.quote.depositAddress, depositMemo: started.quote.depositMemo ?? null } : null);
  const listed = pendingTransfers(answer.state?.pending).find((t) => t.id === started?.move.transfer_id);

  if (!evm?.address) {
    return <p className="pb-muted mb-0">The account has no address on {EVM_CHAIN_NAME} yet, or the page couldn’t read it. It is the same as its Hyperliquid address: set that up first.</p>;
  }

  const again = () => {
    setCommitted(null);
    setProblem(null);
    setSent(false);
    flow.reset();
  };
  const label = picked ? `${VERB[which].start} ${text || '…'} ${picked.token.symbol}${VERB[which].end}` : VERB[which].start;
  // A move home is a transfer the account signs for Aave's chain: the page sends it, and 1Click waits for it there.
  const afterCall = async (outcome: Outcome) => {
    setSent(true);
    if (def.move === 'e_home') await evmSend.send(outcome, 'transfer', `Send the transfer to ${EVM_CHAIN_NAME}`, evm.nonce ?? 0);
    reload();
  };

  /**
   * The one button: hold the price (1Click names where to send), run the check when the move needs one, open the
   * wallet once, and follow the move to the end.
   */
  const go = async () => {
    if (!picked || !units) return;
    setStarting(true);
    setProblem(null);
    try {
      const quote = await quoteMove(moveQuoteBody(which, { dry: false, account: id, token: picked.token.id, amount: units, ether }));
      const at = Date.now();
      const call = nextTx(id, quote.move.next, at);
      if (!call) {
        setProblem(nextRefusal(quote.move.next, at) ?? 'The price came back without the next step, so nothing was sent. Try again in a moment.');
        return;
      }
      setKept(picked);
      setCommitted(quote);
      // So that this browser can ask 1Click about the move later, from the list on Home.
      if (quote.move.transfer_id && quote.quote.depositAddress) {
        rememberMove(window.localStorage, { account: id, id: quote.move.transfer_id, depositAddress: quote.quote.depositAddress, depositMemo: quote.quote.depositMemo ?? null });
      }
      const check = needsCheck(quote.move);
      if (check) {
        await flow.run({
          intent: check,
          act: { label, use: check as Use, tx: call, ...(def.move === 'e_home' && { done: `Signed. This page now sends it to ${EVM_CHAIN_NAME}.` }), onSent: (outcome: Outcome) => void afterCall(outcome) },
        });
      } else {
        const outcome = await direct.run(label, call);
        if (outcome) await afterCall(outcome);
        // The wallet was closed, or the account said no: the button comes back, and a new price is fetched.
        else setCommitted(null);
      }
    } catch (failure) {
      const said = failure instanceof ApiError ? failure.message : String(failure);
      // A quote the stand-in refuses for its size says the cap, not an error (INTERFACES.md 51.2).
      setProblem(isEther && isSizeRefusal(said) ? `${etherCapWords(prices.eth)} Nothing was sent: type a smaller amount.` : `${said} Nothing was sent.`);
    } finally {
      setStarting(false);
    }
  };
  const isEther = which === 'ether-out' || which === 'ether-home';
  // Over the cap as typed, or refused for size when the price was asked for: the cap's line, not an error.
  const overCap = Boolean(which === 'ether-out' && picked && text && !committed && (() => {
    try {
      return overEtherCap(parseUnits(text, picked.token.decimals), picked.token.decimals);
    } catch {
      return false;
    }
  })());
  const sizeRefused = isEther && !committed && isSizeRefusal(typed.error);

  const shown = committed ?? typed.price;
  const words = shown && picked ? quoteWords(which, shown, picked.token, tokens) : null;
  const aaveDebt = toMicro(lender?.lenders.find((p) => p.l === 'aave')?.debt ?? 0);
  const stage = started ? moveStage(status.data?.status ?? null, listed ? isOverdue(listed, now) : false) : null;
  const ends = moveEnds(def.move);
  const running = starting || flow.busy || flow.state.phase === 'confirm' || direct.busy || evmSend.busy;
  // The check said no, or failed: the client changes the amount or tries again from here.
  const stopped = flow.state.phase === 'refused' || flow.state.phase === 'failed';

  return (
    <div>
      <p>{def.about}</p>
      <p className="form-text">{CARRIER_WORDS}</p>
      {!picked ? (
        <p className="pb-muted mb-0">{NOTHING[which]}</p>
      ) : (
        <>
          <div className="d-flex flex-wrap gap-2 mb-1" style={{ maxWidth: 420 }}>
            {sources.length > 1 && (
              <select className="form-select form-select-sm" style={{ maxWidth: 120 }} value={picked.token.id} disabled={committed !== null} onChange={(e) => setTokenId(e.target.value)} aria-label="Token">
                {sources.map((s) => (
                  <option key={s.token.id} value={s.token.id}>
                    {s.token.symbol}
                  </option>
                ))}
              </select>
            )}
            <div className="input-group input-group-sm" style={{ flex: '1 1 220px' }}>
              <input className="form-control num" inputMode="decimal" value={text} disabled={committed !== null} onChange={(e) => setText(e.target.value)} placeholder="0.00" aria-label={`${picked.token.symbol} to move`} autoComplete="off" />
              <span className="input-group-text">{picked.token.symbol}</span>
              {/* All of it, where a whole balance is what moves: the loan, the USDC to repay with, the collateral home. */}
              {which !== 'bitcoin-out' && which !== 'ether-out' && (
                <button type="button" className="btn btn-outline-secondary" disabled={committed !== null} onClick={() => setText(formatUnits(picked.held, picked.token.decimals))}>
                  All
                </button>
              )}
            </div>
          </div>
          {!committed && (
            <div className="form-text mb-2">
              {def.move === 'to_evm' ? 'Your account holds' : 'The address holds'} {counted(picked.held, picked.token)}.
              {which === 'bitcoin-out' && ` ${sizeLimitWords(prices)}`}
              {/* INTERFACES.md 51.2: the cap is said before the client types, and again, marked, when the amount is over it. */}
              {isEther && <span className={overCap || sizeRefused ? 'text-danger' : undefined}> {etherCapWords(prices.eth)}</span>}
              {which === 'usdc-out' && aaveDebt > 0n && ` Aave is owed ${formatUsd(aaveDebt)}: to pay it off, send a little more than that, because the move costs a little and interest grows.`}
            </div>
          )}
          {/* A move home is a transaction the address pays for with that chain's ETH. */}
          {def.move === 'e_home' && !committed && gasView(evm.eth).enough === false && (
            <div className="form-text text-danger">The address holds too little of {EVM_CHAIN_NAME}’s ETH to pay for this transfer. “Get test gas”, on the address card, adds some.</div>
          )}
          {read.problem && <div className="form-text text-danger">{read.problem}</div>}

          {/* The price, as the amount is typed: no button asks for it. */}
          {typed.asking && <div className="form-text mb-2">Getting the price…</div>}
          {typed.error && !committed && !sizeRefused && <div className="alert alert-warning py-1 px-2 small">{typed.error}</div>}
          {words && (
            <div className="pb-terms small mb-2">
              <div>
                {words.leaves} {words.arrives}
              </div>
              <div>{words.cost}</div>
              {words.why && <div className="pb-muted">{words.why}</div>}
            </div>
          )}

          {!sent && !stopped && (
            <>
              <button type="button" className="btn btn-primary" disabled={!units || !typed.price || running || committed !== null || !client.isOwner} onClick={() => void go()}>
                {running ? (
                  <>
                    <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
                    Working…
                  </>
                ) : (
                  label
                )}
              </button>
              {!running && !committed && (
                <div className="form-text">{client.isOwner ? 'One click. Your wallet opens once to approve it, and this page follows the move until it arrives.' : 'Only the account’s owner can start a move.'}</div>
              )}
            </>
          )}
          {starting && !committed && <div className="form-text">Holding this price…</div>}
          {problem && (
            <div className="alert alert-warning py-1 px-2 small mt-2">
              {problem}{' '}
              <button type="button" className="btn btn-link btn-sm p-0 align-baseline" onClick={again}>
                Try again
              </button>
            </div>
          )}

          {/* The check, when the move needs one, and the wallet's approval. After a no, "Try again" starts over. */}
          <CheckProgress state={flow.state} actLabel={label} actDone={def.move === 'e_home' ? `Signed. This page now sends it to ${EVM_CHAIN_NAME}.` : undefined} onConfirm={() => void flow.confirm()} onReset={again} onWallet={() => flow.again('wallet')} />
          <TxStatus record={direct.last} busy={direct.busy} />
          <EvmLines lines={evmSend.lines} />
          {committed && !sent && committed.quote.depositAddress && (
            <details className="form-text mt-2">
              <summary>The details</summary>
              The tokens go to 1Click’s address for this move, {shortAddress(committed.quote.depositAddress)}
              {committed.quote.deadline && `, and the price holds until ${new Date(committed.quote.deadline).toLocaleTimeString()}`}. The account lists the move
              {committed.move.transfer_id ? ` (${committed.move.transfer_id})` : ''} as under way until it settles.
            </details>
          )}

          {started && (
            <>
              <h3 className="pb-sources-title mt-3">Where the move stands</h3>
              <ul className="pb-flow mt-0 mb-0">
                <li>
                  <Dot mark={stage === 'arrived' ? 'done' : stage === 'failed' || stage === 'overdue' ? 'failed' : stage === 'refunded' ? 'todo' : 'busy'} />
                  <div>
                    <div className="what">
                      {MOVES[which].title}
                      <StagePill stage={stage} />
                    </div>
                    <div className="how">
                      {stage
                        ? stageWords(stage, def.move, Boolean(listed))
                        : status.error
                          ? `1Click’s status didn’t answer: ${status.error.message}`
                          : `Asking 1Click where it is. It should reach ${ends.to} in a few minutes.`}
                      {status.data?.swapDetails?.refundReason && ` 1Click’s reason: ${status.data.swapDetails.refundReason}.`}
                    </div>
                    <div className="how">On testnet this is what our stand-in for 1Click says. “Money on its way”, on Home, keeps showing it after you close this panel.</div>
                  </div>
                </li>
              </ul>
              {/* The account can't see Aave's chain: a check tells it the tokens are there. */}
              {def.move === 'to_evm' && stage === 'arrived' && listed && (
                <div className="mt-2">
                  <p className="form-text">
                    {which === 'usdc-out'
                      ? 'Run a check before you repay Aave with it: the account counts the USDC as arrived only once a check has seen it at the address.'
                      : 'Run a check, so the account counts the tokens as arrived. Then borrow: the loan’s first step posts them with Aave.'}
                  </p>
                  <CheckFlow account={answer} fetchedAt={client.fetchedAt} reload={reload} intent={{ check: {} }} checkLabel="Check now" isOwner={client.isOwner} primary={false} />
                </div>
              )}
              {/* Settled: what the client came to do is the next thing. */}
              {def.move === 'to_evm' && stage === 'arrived' && !listed && (
                <p className="form-text mt-2 mb-0">
                  {which === 'usdc-out' ? 'The account counts it now. To repay Aave with it, close this panel and open Repay on Aave’s card.' : 'The account counts it now. Borrow, and the loan’s first step posts it with Aave.'}
                </p>
              )}
              {(stage === 'arrived' || stage === 'refunded' || stage === 'failed') && (
                <button
                  type="button"
                  className="btn btn-link btn-sm px-0 mt-2"
                  onClick={() => {
                    setText('');
                    again();
                  }}
                >
                  Start another move
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
