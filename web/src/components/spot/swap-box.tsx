'use client';
// The swap box (INTERFACES.md 49.1 point 3), laid out as NEAR Intents' swap screen is: "You pay" with a token, an
// amount, the account's balance and Max; a round button that flips the two sides; "You receive" with a token and the
// amount the price gives; the rate, the cost and the time; and one button, Swap.
//   - The price comes by itself, 400 ms after the last keystroke, and again before it runs out (INTERFACES.md 49.5).
//     Until it comes, and for anyone with no account to ask for, the box shows what the two tokens' own prices give.
//   - A pair that can't swap on testnet shows its real price and rate, and one line where the button would be
//     (INTERFACES.md 49.2). lib/spot.ts, slotFor, decides what stands there.
//   - Prices show to anyone; balances and the Swap button need a confirmed wallet (INTERFACES.md 48.6).
import Link from 'next/link';
import { useState } from 'react';

import { CheckProgress } from '@/components/check-flow';
import { Dot, TxLink } from '@/components/flow-progress';
import { NetworkId } from '@/config';
import { useTypedPrice } from '@/hooks/use-typed-price';
import { api, ApiError } from '@/lib/api';
import { SIGN_IN_WORDS } from '@/lib/session';
import {
  amountWords,
  costWords,
  defaultPair,
  estimateOut,
  estimateText,
  fieldText,
  heldUnits,
  maxText,
  pairState,
  pricedFrom,
  priceRate,
  priceWords,
  quoteRate,
  readPay,
  showNumber,
  shownRate,
  shownSymbol,
  showUnits,
  slotFor,
  SWAP_FIGURES,
  swapBody,
  swapTimeWords,
  tokenBy,
  usdValue,
  type AccountStand,
  type Held,
  type Priced,
  type SpotToken,
  type SwapBody,
  type SwapQuote,
  type TokenRow,
} from '@/lib/spot';
import { formatDollars } from '@/lib/units';
import { useNearWallet } from '@/providers/near-provider';
import { useSession } from '@/providers/session-provider';

import styles from './spot.module.css';
import { TokenMark, TokenPicker } from './token-picker';
import { useSwap, type Swap } from './use-swap';

interface Props {
  /** The tokens of GET /api/spot/tokens, and the same with what the account holds, the account's own first. */
  tokens: SpotToken[];
  rows: TokenRow[];
  /** The list didn't answer. */
  listFailed: boolean;
  /** The wallet's own account, once the page has read it; null for a visitor. */
  accountId: string | null;
  balances: Held[] | undefined;
  stand: AccountStand;
  reload: () => void;
}

/** The price for what is typed. It never rejects: a refusal is an answer the box shows in words. */
function askPrice(body: SwapBody | null): Promise<Priced> {
  if (!body) return Promise.resolve({ quote: null, problem: null });
  return api<unknown>('/api/quote', { method: 'POST', body: JSON.stringify(body) }).then(
    (answer) => pricedFrom({ ok: true, answer }),
    (failure: unknown) => pricedFrom(failure instanceof ApiError ? { ok: false, status: failure.status, code: failure.code, message: failure.message } : { ok: false, status: 0, code: 'error', message: String(failure) }),
  );
}

export function SwapBox({ tokens, rows, listFailed, accountId, balances, stand, reload }: Props) {
  const wallet = useNearWallet();
  const session = useSession();
  const [paySymbol, setPaySymbol] = useState<string | null>(null);
  const [receiveSymbol, setReceiveSymbol] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [picking, setPicking] = useState<'pay' | 'receive' | null>(null);
  const [inverted, setInverted] = useState(false);
  /** The price on screen when Swap was pressed. */
  const [atClick, setAtClick] = useState<SwapQuote | null>(null);
  const swap = useSwap(stand === 'ready' ? accountId : null, reload);

  // The box opens paying USDC for bitcoin. While a swap runs, it keeps showing the tokens the swap is about.
  const opening = defaultPair(tokens);
  const pay = swap.started?.pay ?? tokenBy(tokens, paySymbol ?? opening.pay);
  const receive = swap.started?.receive ?? tokenBy(tokens, receiveSymbol ?? opening.receive);
  const held = pay ? heldUnits(pay, balances) : null;
  const receiveHeld = receive ? heldUnits(receive, balances) : null;
  const amount = readPay(text, pay, held);
  const pair = pairState(pay, receive);

  // INTERFACES.md 49.5: no "Get a price" button. Only a pair that swaps here, for an account the page may ask for.
  const body = pair === 'here' && stand === 'ready' && accountId && pay && receive && amount.units ? swapBody({ dry: true, account: accountId, pay, receive, units: amount.units }) : null;
  const typed = useTypedPrice<Priced>(body && !swap.locked ? JSON.stringify(body) : null, () => askPrice(body), swap.locked);

  // What the box shows: the price for what is typed; from the click, the price that was on screen then; and once the
  // price is held, the held one.
  const quote = swap.started?.quote ?? (swap.locked ? atClick : (typed.price?.quote ?? null));
  const twoTokens = pay !== null && receive !== null && pair !== 'same';
  // With no quote, what the two tokens' own prices give: for a visitor, a pair that can't swap here, and the moment
  // before the quote comes.
  const estimate = !quote && twoTokens && amount.units ? estimateOut(amount.units, pay, receive) : null;
  const rate = twoTokens ? (quote ? quoteRate(quote.amountIn, quote.amountOut, pay, receive) : priceRate(pay, receive)) : null;
  const payUsd = pay && amount.units ? (quote?.inUsd ?? usdValue(amount.units, pay)) : null;
  const receiveUsd = receive && quote ? (quote.outUsd ?? usdValue(quote.amountOut, receive)) : (estimate?.usd ?? null);

  const slot = slotFor({
    tokens: tokens.length,
    listFailed,
    pair,
    wallet: wallet.loading ? 'loading' : wallet.signedAccountId ? 'connected' : 'none',
    session: session.checking ? 'checking' : session.state,
    account: stand,
    amount,
    pay,
    held,
    asking: typed.asking,
    priced: typed.price,
  });
  const frozen = swap.locked || tokens.length === 0;

  const pick = (side: 'pay' | 'receive', token: SpotToken) => {
    // Picking the token the other side already has swaps the two round.
    if (side === 'pay') {
      setPaySymbol(token.symbol);
      if (receive?.symbol === token.symbol) setReceiveSymbol(pay?.symbol ?? null);
    } else {
      setReceiveSymbol(token.symbol);
      if (pay?.symbol === token.symbol) setPaySymbol(receive?.symbol ?? null);
    }
  };

  /** The two sides change places, and what was to be received becomes what is paid. */
  const flip = () => {
    if (!pay || !receive) return;
    setPaySymbol(receive.symbol);
    setReceiveSymbol(pay.symbol);
    setText(quote ? fieldText(quote.amountOut, receive.decimals, 8) : estimate ? estimateText(estimate.amount, receive.decimals) : text);
    setInverted(false);
  };

  const go = () => {
    if (slot.kind !== 'swap' || !slot.ready || !pay || !receive || !amount.units) return;
    const shown = typed.price?.quote ?? null;
    setAtClick(shown);
    void swap.start({ pay, receive, units: amount.units, shown });
  };

  return (
    <section className={styles.box} aria-label="Swap">
      <div className={styles.legs}>
        <div className={styles.leg}>
          <div className={styles.legHead}>
            <label htmlFor="spot-pay">You pay</label>
            {pay && held !== null && (
              <span>
                Balance {showUnits(held, pay.decimals)} {shownSymbol(pay.symbol)}{' '}
                <button type="button" className={styles.max} disabled={frozen || held === 0n} onClick={() => setText(maxText(held, pay))}>
                  Max
                </button>
              </span>
            )}
          </div>
          <div className={styles.legRow}>
            <input id="spot-pay" className={styles.amount} inputMode="decimal" autoComplete="off" placeholder="0" value={text} disabled={frozen} onChange={(event) => setText(event.target.value)} />
            <TokenButton token={pay} side="Token you pay with" disabled={frozen} onClick={() => setPicking('pay')} />
          </div>
          <LegFoot usd={payUsd} token={pay} />
        </div>

        <div className={styles.flipRow}>
          <button type="button" className={styles.flip} disabled={frozen || !pay || !receive} onClick={flip} aria-label="Swap the two tokens round" title="Swap the two tokens round">
            <i className="bi bi-arrow-down-up" aria-hidden="true" />
          </button>
        </div>

        <div className={styles.leg}>
          <div className={styles.legHead}>
            <span id="spot-receive-label">You receive</span>
            {receive && receiveHeld !== null && (
              <span>
                Balance {showUnits(receiveHeld, receive.decimals)} {shownSymbol(receive.symbol)}
              </span>
            )}
          </div>
          <div className={styles.legRow}>
            <output className={`${styles.amountOut} ${quote ? '' : estimate ? styles.estimate : styles.empty}`} htmlFor="spot-pay" aria-labelledby="spot-receive-label" aria-live="polite">
              {quote && receive ? showUnits(quote.amountOut, receive.decimals, SWAP_FIGURES) : estimate ? `≈ ${showNumber(estimate.amount)}` : '0'}
            </output>
            <TokenButton token={receive} side="Token you receive" disabled={frozen} onClick={() => setPicking('receive')} />
          </div>
          <LegFoot usd={receiveUsd} token={receive} />
        </div>
      </div>

      {rate && pay && receive && (
        <dl className={`pb-rows ${styles.details}`}>
          <div>
            <dt>Rate</dt>
            <dd>
              <button type="button" className={styles.rateButton} onClick={() => setInverted(!inverted)} title="Show the rate the other way round">
                {shownRate(rate, pay, receive, inverted)} <i className="bi bi-arrow-left-right" aria-hidden="true" style={{ fontSize: '0.75rem' }} />
              </button>
              {!quote && <span className="sub">by today’s prices, before costs</span>}
            </dd>
          </div>
          {quote && (
            <>
              <div>
                <dt>Cost</dt>
                <dd>{costWords(quote)}</dd>
              </div>
              {quote.minAmountOut && (
                <div>
                  <dt>You receive at least</dt>
                  <dd>{amountWords(quote.minAmountOut, receive, SWAP_FIGURES)}</dd>
                </div>
              )}
              <div>
                <dt>Time</dt>
                <dd>{swapTimeWords(quote)}</dd>
              </div>
            </>
          )}
        </dl>
      )}

      <div className={styles.slot}>
        {swap.step.at !== 'idle' ? (
          <Progress
            swap={swap}
            onAgain={() => {
              swap.reset();
              setText('');
            }}
          />
        ) : slot.kind === 'line' ? (
          <>
            <div className={styles.line} role="status">
              {slot.line}
            </div>
            {slot.home && (
              <Link href="/" className={`btn btn-primary mt-2 ${styles.swap}`}>
                Go to Home
              </Link>
            )}
          </>
        ) : slot.kind === 'wait' ? (
          <div className="pb-skeleton" style={{ height: 48 }} aria-busy="true" />
        ) : slot.kind === 'sign_in' ? (
          <>
            <button type="button" className={`btn btn-primary ${styles.swap}`} onClick={() => wallet.signIn().catch(() => undefined)}>
              Sign in to swap
            </button>
            <div className={styles.hint}>Prices show without a wallet. Swapping needs your NEAR {NetworkId} wallet.</div>
          </>
        ) : slot.kind === 'confirm' ? (
          <>
            <button type="button" className={`btn btn-primary ${styles.swap}`} disabled={session.signingIn} onClick={() => void session.signIn()}>
              {session.signingIn ? 'Waiting for your wallet…' : 'Confirm this wallet to swap'}
            </button>
            <div className={styles.hint}>{SIGN_IN_WORDS}</div>
            {session.problem && <div className="form-text text-danger text-center">{session.problem}</div>}
          </>
        ) : (
          <>
            <button type="button" className={`btn btn-primary ${styles.swap}`} disabled={!slot.ready} onClick={go}>
              Swap
            </button>
            {slot.hint && (
              <div className={styles.hint} role="status">
                {slot.hint}
              </div>
            )}
          </>
        )}
      </div>

      {picking && (
        <TokenPicker
          title={picking === 'pay' ? 'You pay' : 'You receive'}
          rows={rows}
          chosen={picking === 'pay' ? pay : receive}
          onPick={(token) => pick(picking, token)}
          onClose={() => setPicking(null)}
        />
      )}
    </section>
  );
}

/** The token of one side, as the button that opens the picker. */
function TokenButton({ token, side, disabled, onClick }: { token: SpotToken | null; side: string; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" className={styles.tokenButton} disabled={disabled} onClick={onClick} aria-haspopup="dialog" aria-label={token ? `${side}: ${shownSymbol(token.symbol)}. Change it` : `${side}: pick one`}>
      {token ? (
        <>
          <TokenMark token={token} />
          {shownSymbol(token.symbol)}
        </>
      ) : (
        'Pick a token'
      )}
      <i className="bi bi-chevron-down" aria-hidden="true" style={{ fontSize: '0.7rem' }} />
    </button>
  );
}

/** Under an amount: its dollars, and the token's real price, which shows for every token whether it swaps here or not. */
function LegFoot({ usd, token }: { usd: number | null; token: SpotToken | null }) {
  return (
    <div className={`${styles.sub} d-flex justify-content-between gap-2`}>
      <span>{usd !== null ? formatDollars(usd) : ''}</span>
      {token && <span>{token.price_usd === null ? 'no price' : `1 ${shownSymbol(token.symbol)} = ${priceWords(token.price_usd)}`}</span>}
    </div>
  );
}

/** A swap under way, from holding the price to "You received X": one step at a time, each in a sentence. */
function Progress({ swap, onAgain }: { swap: Swap; onAgain: () => void }) {
  const { step, started, flow, words, reason } = swap;
  const tone = words?.tone === 'good' ? styles.good : words?.tone === 'warn' ? styles.warn : words?.tone === 'bad' ? styles.bad : '';
  return (
    <div aria-live="polite">
      {step.at === 'holding' && (
        <button type="button" className={`btn btn-primary ${styles.swap}`} disabled>
          <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
          Holding the price…
        </button>
      )}
      {/* The check, when the account owes our pool: the broker pays for it, and the wallet opens once, for the swap. */}
      <CheckProgress state={flow.state} actLabel={started?.label} actDone="Sent. The swap is under way." onConfirm={() => void flow.confirm()} onReset={swap.reset} />
      {step.at === 'wallet' && (
        <ul className="pb-flow mt-0 mb-0">
          <li>
            <Dot mark="busy" />
            <div>
              <div className="what">{started?.label}</div>
              <div className="how">Approve it in your wallet.</div>
            </div>
          </li>
        </ul>
      )}
      {step.at === 'closed' && (
        <div className={`${styles.result} ${styles.warn}`}>
          <div>
            <div>{step.problem}</div>
            <div className="d-flex flex-wrap gap-2 mt-2">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void swap.approve()}>
                Approve
              </button>
              <button type="button" className="btn btn-outline-secondary btn-sm" onClick={swap.reset}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {step.at === 'stopped' && (
        <div className={`${styles.result} ${styles.bad}`}>
          <div>
            <div>
              {step.problem}
              <TxLink hash={step.hash} text="the transaction" />
            </div>
            <button type="button" className="btn btn-outline-secondary btn-sm mt-2" onClick={swap.reset}>
              Try again
            </button>
          </div>
        </div>
      )}
      {step.at === 'following' && words && (
        <div className={`${styles.result} ${tone} ${flow.state.phase === 'idle' ? '' : 'mt-2'}`}>
          <Dot mark={!words.done ? 'busy' : words.tone === 'good' ? 'done' : words.tone === 'bad' ? 'failed' : 'todo'} />
          <div>
            <div>
              {words.line}
              {reason && words.stage === 'returned' && ` 1Click’s reason: ${reason}.`}
              <TxLink hash={step.hash} text="your transaction" />
            </div>
            {words.done && (
              <button type="button" className="btn btn-primary btn-sm mt-2" onClick={onAgain}>
                Swap again
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
