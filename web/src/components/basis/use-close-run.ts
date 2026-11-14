'use client';
// "Close everything" (INTERFACES.md 49.1, point 5): the way out in one guided run. Before each step the account, its
// lenders, its address on Aave's chain and Hyperliquid are read again, and the next step is whatever
// `nextCloseStep` (lib/basis.ts) decides from that. Nothing is decided from memory, so pressing the button again
// after a reload or a failure goes on from where the account really is.
//
// Each step waits until its effect shows before the next is decided. A step that needs a check (bringing USDC home
// from Aave's chain while our pool is owed, and the check that sees a move to Aave's chain) uses the app's own
// check-then-act flow (hooks/use-check-then-act.ts), so the broker pays for it where it can.
import { useEffect, useRef, useState } from 'react';

import { failedPhase, sleep, StepFailed, until, type RunPhase } from '@/components/basis/parts';
import { NetworkId } from '@/config';
import { useCheckThenAct } from '@/hooks/use-check-then-act';
import { useEvmSend } from '@/hooks/use-evm-send';
import {
  accountPath,
  api,
  ApiError,
  EVM_GAS_PATH,
  evmGas,
  evmSubmit,
  hlPath,
  lenderPath,
  marketsPath,
  quoteMove,
  sendOrder,
  statusPath,
  submitSigned,
  type AccountAnswer,
  type EvmGasInfo,
  type LenderAccountAnswer,
  type MarketsAnswer,
  type MoveQuoteAnswer,
  type StatusAnswer,
} from '@/lib/api';
import { closeStage, closeStateFrom, closeWords, hlWasRead, MIN_MOVE, nextCloseStep, type CloseState, type CloseStep } from '@/lib/basis';
import { approved, EVM_CHAIN_NAME, gasView, walletToken } from '@/lib/evm';
import { expiryNow, GATEWAY_RECIPIENT, orderLifeMs, orderMessage, orderWords, randomNonce, toAuth } from '@/lib/gateway';
import { coinTradingNow, notTradingWords, ownOrderBp } from '@/lib/hl-reach';
import { sendWithinLife } from '@/lib/order-life';
import { lastSignedIndex, newSignedEntry, signedIndexFromLogs, submitWords, type HlAnswer, type SubmitAnswer } from '@/lib/hl';
import { decFromNumber, decText, roundOrder, roundPrice } from '@/lib/hl-rules';
import { moveStage, needsCheck, nextRefusal, nextTx, recallMove, rememberMove, statusQuery, type MoveStage } from '@/lib/moves';
import { isOverdue, pendingTransfers } from '@/lib/risk';
import {
  buildMove,
  cancelFundingTx,
  evmApproveTx,
  forgetTransferTx,
  hlWithdrawTx,
  lenderRepayTx,
  lenderWithdrawTx,
  mintTx,
  repayTx,
  txFailure,
  txLogs,
  withdrawTx,
  type Outcome,
  type Tx,
} from '@/lib/tx';
import type { Intent } from '@/lib/types';
import type { Use } from '@/lib/verdict';
import { useNearWallet } from '@/providers/near-provider';

interface Input {
  /** The client account, once it exists. */
  accountId: string | null;
  /** The wallet that owns it: the withdrawal goes there. */
  owner: string;
  testnet: boolean;
  usdcId: string | null;
  reloadAll: () => void;
}

/** One reading of everything the way out is decided from. */
interface Reading {
  account: AccountAnswer;
  hl: HlAnswer;
  lender: LenderAccountAnswer;
  state: CloseState;
  /** When Hyperliquid's side was read: an order's expiry is counted from it. */
  readAt: number;
}

/** What this browser remembers of a move it started: the memo 1Click tells it apart by. */
function recalled(account: string, id: string) {
  try {
    return recallMove(window.localStorage, account, id);
  } catch {
    return null;
  }
}

const sameStep = (a: CloseStep, b: CloseStep) => JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) === JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

export function useCloseRun({ accountId, owner, testnet, usdcId, reloadAll }: Input) {
  const { sendTx, sendTxs, signMessage } = useNearWallet();
  const id = accountId ?? '';
  const evmSend = useEvmSend(id, reloadAll);
  const flow = useCheckThenAct(id, reloadAll);
  // The check flow's state as of the last render: a step reads it after the flow's own promise has settled.
  const flowNow = useRef(flow.state);
  useEffect(() => {
    flowNow.current = flow.state;
  });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [phase, setPhase] = useState<RunPhase>({ kind: 'idle' });
  /** The step the run is on, for the rail. */
  const [step, setStep] = useState<CloseStep | null>(null);
  /** What this run has done so far, in its own words. */
  const [done, setDone] = useState<string[]>([]);
  /** The part of the way out the run is in: a step that only waits stays under the part it waits in. */
  const [stage, setStage] = useState<number | null>(null);
  /** The lines of Aave's chain shown are the current step's: those that came after this one. */
  const [linesFrom, setLinesFrom] = useState(0);
  const lastLine = useRef(0);
  useEffect(() => {
    lastLine.current = evmSend.lines.reduce((max, line) => Math.max(max, line.key), 0);
  });
  const running = useRef(false);
  const helper = useRef<boolean | null>(null);

  /** All three reads must answer: a part that can't be read is never taken for a part with nothing in it. */
  const read = async (): Promise<Reading> => {
    const [account, hl, lender] = await Promise.all([api<AccountAnswer>(accountPath(id)), api<HlAnswer>(hlPath(id)), api<LenderAccountAnswer>(lenderPath(id))]);
    const readAt = Date.now();
    if (!account.state) throw new StepFailed('The account isn’t open yet.', [], { happened: 'There is no account to close.', todo: 'Open a basis trade first.' });
    if (!hlWasRead(hl)) throw new StepFailed('Hyperliquid didn’t answer for this account.', [], { happened: 'The page couldn’t read Hyperliquid just now.', todo: 'Nothing was sent. Try again in a moment.' });
    const stages: Record<string, MoveStage | null> = {};
    await Promise.all(
      pendingTransfers(account.state.pending).map(async (transfer) => {
        const overdue = isOverdue(transfer, readAt);
        const query = statusQuery(transfer, recalled(id, transfer.id));
        const status = query ? await api<StatusAnswer>(statusPath(query.depositAddress, query.depositMemo)).then((s) => s.status, () => null) : null;
        stages[transfer.id] = moveStage(status, overdue);
      }),
    );
    const withAave = testnet && (lender.config_lenders ?? []).includes('aave');
    // Whether the backend's helper is on doesn't change within a run: it is asked once.
    if (withAave && helper.current === null) helper.current = await api<EvmGasInfo>(EVM_GAS_PATH).then((g) => g.on, () => false);
    const helperOn = withAave && helper.current === true;
    return { account, hl, lender, readAt, state: closeStateFrom({ account, hl, lender, stages, nowMs: readAt, testnet, helperOn }) };
  };

  /** Waits until the account shows `ok`, or throws with `late` when it doesn't in time. */
  const shows = async (ok: (s: CloseState) => boolean, ms: number, late: string, every = 4_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && alive.current) {
      try {
        if (ok((await read()).state)) return;
      } catch {
        // a missed read: try again
      }
      await sleep(every);
    }
    throw new StepFailed(late);
  };

  const sent = (outcome: Outcome): Outcome => {
    const failure = txFailure(outcome);
    if (failure) throw new StepFailed(failure, txLogs(outcome));
    return outcome;
  };

  /** Why the check flow stopped short, as a failure. */
  const flowFailure = (): StepFailed => {
    const f = flowNow.current;
    if (f.phase === 'refused') return new StepFailed(f.why, [], { happened: 'The risk engine didn’t allow this step.', todo: 'Nothing was sent. Try again in a minute: your account may need a moment to settle.' });
    if (f.phase === 'failed') return new StepFailed(f.why, f.logs);
    if (f.phase === 'confirm') return new StepFailed('Cancelled in the wallet');
    return new StepFailed('The check didn’t finish.');
  };

  /** A plain check: the risk engine looks at the account, which is how the account learns a move to Aave's chain arrived. */
  const check = async () => {
    await flow.run({ intent: { check: {} } });
    await sleep(200);
    if (flowNow.current.phase !== 'done') throw flowFailure();
    flow.reset();
  };

  /** A check for `intent`, then `tx` at once while the check is fresh. Returns the transaction's outcome. */
  const checkThen = async (intent: Intent, tx: Tx, label: string): Promise<Outcome> => {
    const got: { outcome: Outcome | null } = { outcome: null };
    await flow.run({ intent, act: { label, use: intent as Use, tx, onSent: (outcome) => void (got.outcome = outcome) } });
    await sleep(200);
    if (!got.outcome) throw flowFailure();
    flow.reset();
    return got.outcome;
  };

  /**
   * After a repayment to a lender: waits for the page's own signs of it (lib/basis.ts, `closeStateFrom`). Where those
   * can't tell, what is owed there is what the last check read, so a check is run and the account read again.
   */
  const seen = async (ok: (s: CloseState) => boolean, ms: number, late: string) => {
    try {
      await shows(ok, ms, late);
    } catch {
      setPhase((now) => (now.kind === 'running' ? { ...now, announce: null, detail: 'Sent. The risk engine now looks at your account, so the page sees the repayment.' } : now));
      await check();
      await shows(ok, 40_000, late);
    }
  };

  /** So that this browser can ask 1Click about the move later. */
  const remember = (quote: MoveQuoteAnswer) => {
    if (quote.move.transfer_id && quote.quote.depositAddress) {
      rememberMove(window.localStorage, { account: id, id: quote.move.transfer_id, depositAddress: quote.quote.depositAddress, depositMemo: quote.quote.depositMemo ?? null });
    }
  };

  /** A transaction on Aave's chain needs that chain's ETH at the address: on testnet the backend's helper tops it up. */
  const gas = async (r: Reading) => {
    if (r.state.canFaucet && gasView(r.lender.evm?.eth).enough === false) await evmGas(id).catch(() => undefined);
  };

  /** Sends what the account just signed for Aave's chain, and waits for it to be mined. */
  const onChain = async (outcome: Outcome, kind: string, what: string, fromNonce: number) => {
    if (!(await evmSend.send(outcome, kind, what, fromNonce))) throw new StepFailed(`${what}: it was not mined on ${EVM_CHAIN_NAME}.`);
  };

  /** A token from the address on Aave's chain to the account on NEAR, through 1Click. */
  const home = async (r: Reading, token: string, units: bigint, label: string, to?: string) => {
    await gas(r);
    // INTERFACES.md 51.2: `to` names what a collateral token comes home as (test ETH on an ETH trade); without it, bitcoin.
    const quote = await quoteMove({ dry: false, move: 'e_home', account: id, token, amount: units.toString(), ...(to ? { to } : {}) });
    const tx = nextTx(id, quote.move.next);
    if (!tx) throw new StepFailed(nextRefusal(quote.move.next) ?? 'The move came without a call the account would record, so nothing was sent.');
    remember(quote);
    const asked = needsCheck(quote.move);
    const outcome = asked ? await checkThen(asked, tx, label) : sent(await sendTx(tx));
    await onChain(outcome, 'transfer', `Send it to ${EVM_CHAIN_NAME}`, r.lender.evm?.nonce ?? 0);
    // It settles by itself when it lands on NEAR.
    await shows((s) => !s.moves.some((m) => m.id === quote.move.transfer_id), 8 * 60_000, 'The money is still on its way after eight minutes.', 5_000);
  };

  /**
   * USDC from the account on NEAR to its address on Aave's chain, through 1Click. The account then lists the move:
   * the next steps wait for it, have a check see it, and only then repay (INTERFACES.md 48.13).
   */
  const sendOut = async (amount: bigint, before: CloseState) => {
    if (!usdcId) throw new StepFailed('The page has no USDC token to send.');
    const quote = await quoteMove({ dry: false, move: 'to_evm', account: id, token: usdcId, amount: amount.toString() });
    const tx = nextTx(id, quote.move.next);
    if (!tx) throw new StepFailed(nextRefusal(quote.move.next) ?? 'The move came without a call the account would record, so nothing was sent.');
    remember(quote);
    const asked = needsCheck(quote.move);
    if (asked) await checkThen(asked, tx, closeWords({ kind: 'usdc_out', amount }).title);
    else sent(await sendTx(tx));
    await shows((s) => s.moves.some((m) => m.kind === 'to_evm') || s.usdcNear < before.usdcNear, 40_000, 'The move doesn’t show on the account’s list yet.');
  };

  /** Posts a transfer the account signed for Hyperliquid. The backend's read of NEAR may trail the wallet's by a moment. */
  const post = async (index: number): Promise<SubmitAnswer> => {
    const askBy = Date.now() + 25_000;
    for (;;) {
      try {
        return await submitSigned(id, index);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404 && Date.now() < askBy) {
          await sleep(2_500);
          continue;
        }
        throw error;
      }
    }
  };

  const run = async (next: CloseStep, r: Reading) => {
    const before = r.state;
    switch (next.kind) {
      case 'stop_loan':
        sent(await sendTx(cancelFundingTx(id)));
        return shows((s) => !s.planRunning, 40_000, 'The loan’s steps still show as running.');
      case 'wait_lender':
        return shows((s) => !s.lenderBusy, 90_000, 'Rhea hasn’t finished after 90 seconds: it is still on its way.');
      case 'send_signed':
        await gas(r);
        await evmSubmit(id, next.nonce);
        return shows((s) => s.evmUnsent !== next.nonce, 150_000, `The transaction is not mined yet on ${EVM_CHAIN_NAME}.`);
      case 'wait_mined':
        return shows((s) => !s.evmUnmined, 150_000, `The transaction is not mined yet on ${EVM_CHAIN_NAME}.`);
      case 'drop_move':
        sent(await sendTx(forgetTransferTx(id, next.id)));
        return shows((s) => !s.moves.some((m) => m.id === next.id), 40_000, 'The move still shows on the account’s list.');
      case 'check_move':
        await check();
        return shows((s) => !s.moves.some((m) => m.id === next.id), 40_000, 'The check ran, but the USDC is still on its way to the address.');
      case 'wait_move':
        return shows(
          (s) => {
            const move = s.moves.find((m) => m.id === next.id);
            return !move || move.overdue || (move.kind === 'to_evm' && move.stage === 'arrived');
          },
          8 * 60_000,
          'The money is still on its way after eight minutes.',
          5_000,
        );
      case 'repay_pool':
        sent(await sendTx(repayTx(id, next.amount.toString())));
        return shows((s) => (before.poolDebt > 0n ? s.poolDebt < before.poolDebt : !s.loanStillOpen), 40_000, 'The repayment doesn’t show yet.');
      case 'add_usdc':
        if (!usdcId) throw new StepFailed('The page has no USDC token to add.');
        sent(await sendTx(mintTx(usdcId, id, next.amount.toString())));
        return shows((s) => s.usdcNear > before.usdcNear, 40_000, 'The test USDC doesn’t show in the account yet.');
      case 'repay_rhea':
        sent(await sendTx(lenderRepayTx(id, 'rhea', next.amount.toString())));
        return seen((s) => s.rheaDebt === 0n && !s.lenderBusy, 60_000, 'Rhea doesn’t show the repayment yet.');
      case 'rhea_deposit_back':
        if (!usdcId) throw new StepFailed('The page has no USDC token to bring back.');
        sent(await sendTx(lenderWithdrawTx(id, 'rhea', usdcId, next.amount.toString())));
        return shows((s) => s.rheaDeposit === 0n, 90_000, 'Rhea doesn’t show the USDC as returned yet.');
      case 'wait_chain':
        throw new StepFailed(r.lender.evm?.chain_error ?? 'Aave’s chain could not be read.', [], { happened: 'The page can’t read Aave’s chain right now.', todo: 'Nothing was sent. Try again in a minute.' });
      case 'faucet_usdc': {
        const one = (10n ** BigInt(walletToken(r.lender.evm, 'USDC')?.decimals ?? 6)).toString();
        try {
          const answer = await evmGas(id, { mint: { token: next.token, amount: one } });
          if (answer.mint?.ok === false) throw new StepFailed(`${EVM_CHAIN_NAME} mined the faucet’s transaction, but it failed there, so nothing arrived.`);
        } catch (error) {
          // The faucet has its limits. The missing dollar can come from the account on NEAR instead, as on mainnet.
          if (before.usdcNear < MIN_MOVE) throw error;
          const words = closeWords({ kind: 'usdc_out', amount: MIN_MOVE });
          setPhase({ kind: 'running', title: words.title, announce: words.approval, detail: 'Aave’s faucet didn’t answer, so the USDC comes from your account instead.' });
          return sendOut(MIN_MOVE, before);
        }
        return shows((s) => s.usdcEvm > before.usdcEvm, 90_000, 'The test USDC doesn’t show at the address yet.');
      }
      case 'repay_aave': {
        await gas(r);
        const fromNonce = r.lender.evm?.nonce ?? 0;
        // Aave takes USDC from the address only after a one-time approval. Unless it is known to be there, ask for it first.
        if (approved(r.lender.evm, next.token, r.account.state?.evm) !== true) {
          setPhase({ kind: 'running', title: closeWords(next).title, announce: 'Your wallet will ask you to approve: let Aave take USDC from your address on its chain. It is asked once.', detail: null });
          const allowed = sent(await sendTx(evmApproveTx(id, next.token)));
          await onChain(allowed, 'approve', `Send the approval to ${EVM_CHAIN_NAME}`, fromNonce);
          setPhase({ kind: 'running', title: closeWords(next).title, announce: `Your wallet will ask you to approve: repay Aave from your address on its chain.`, detail: 'Aave takes only what it is owed.' });
        }
        const repaid = sent(await sendTx(lenderRepayTx(id, 'aave', next.amount.toString())));
        await onChain(repaid, 'repay', `Send the repayment to ${EVM_CHAIN_NAME}`, fromNonce);
        return seen((s) => s.aaveDebt === 0n, 45_000, 'Aave doesn’t show the repayment yet.');
      }
      case 'usdc_out':
        return sendOut(next.amount, before);
      case 'usdc_home': {
        const decimals = walletToken(r.lender.evm, 'USDC')?.decimals ?? 6;
        const units = decimals >= 6 ? next.amount * 10n ** BigInt(decimals - 6) : next.amount / 10n ** BigInt(6 - decimals);
        return home(r, next.token, units, closeWords(next).title);
      }
      case 'collateral_home':
        return home(r, next.held.token, next.held.amount, closeWords(next).title, next.to);
      case 'take_back': {
        const amount = next.held.amount.toString();
        if (next.lender === 'aave') {
          await gas(r);
          const outcome = sent(await sendTx(lenderWithdrawTx(id, 'aave', next.held.token, amount)));
          await onChain(outcome, 'withdraw', `Send the withdrawal to ${EVM_CHAIN_NAME}`, r.lender.evm?.nonce ?? 0);
          return shows((s) => !s.aaveHeld.some((h) => h.token === next.held.token), 90_000, 'Aave still shows the collateral as posted.');
        }
        sent(await sendTx(lenderWithdrawTx(id, 'rhea', next.held.token, amount)));
        return shows((s) => !s.rheaHeld.some((h) => h.token === next.held.token) && !s.lenderBusy, 120_000, 'Rhea still shows the collateral as posted.');
      }
      case 'close_position': {
        const markets = await api<MarketsAnswer>(marketsPath(id));
        const coin = markets.coins.find((c) => c.coin === next.coin);
        const listed = coin?.testnet && !coin.testnet.delisted ? coin.testnet : null;
        if (!coin || !listed) throw new StepFailed(`${next.coin} isn’t listed on Hyperliquid right now.`);
        const oracle = Number(listed.oracle_px ?? NaN);
        const reference = Number.isFinite(oracle) ? oracle : Number(listed.mark_px ?? NaN);
        const isBuy = next.side === 'short';
        // INTERFACES.md 50.4: an order Hyperliquid can't take now isn't signed.
        const stopped = notTradingWords(next.coin, coinTradingNow(coin, NetworkId === 'testnet'), 'coin');
        if (stopped) {
          throw new StepFailed(stopped, [], {
            happened: `Hyperliquid testnet isn’t taking ${next.coin} orders right now, so the position can’t be closed yet.`,
            todo: 'Nothing was signed or sent. Try again later: the page goes on from where your account really is.',
          });
        }
        // A limit past the reference on the side that fills (lib/hl-reach.ts, ownOrderBp): it fills at once, inside the band.
        const target = decFromNumber(reference * (1 + ((isBuy ? 1 : -1) * ownOrderBp(coin.band_bp)) / 10_000));
        if (!target) throw new StepFailed('No price to close at.');
        const rounded = roundOrder({ size: String(next.size), price: decText(roundPrice(target, listed.sz_decimals, isBuy ? 'down' : 'up')), isBuy, szDecimals: listed.sz_decimals });
        if (rounded.problems.length) throw new StepFailed(rounded.problems.join(' '));
        const order = { coin: next.coin, is_buy: isBuy, sz: rounded.sz, limit_px: rounded.limitPx, reduce_only: true, tif: 'Ioc' as const };
        // INTERFACES.md 50.4: signed for as long as this account's own gateway takes (the same markets answer says it).
        const life = orderLifeMs(markets);
        const message = orderMessage(id, order, expiryNow(r.hl.near_time_ms, r.readAt, life));
        const nonce = randomNonce();
        const signed = await signMessage({ message, recipient: GATEWAY_RECIPIENT, nonce });
        const waiting = (detail: string) => setPhase({ kind: 'running', title: closeWords(next).title, announce: null, detail });
        waiting('The risk engine checks the order, then places it on Hyperliquid…');
        // Past 30 seconds the line turns calm, and the step waits for as long as the order lives.
        const answer = await sendWithinLife({ send: () => sendOrder(id, toAuth(signed, message, nonce)), lifeMs: life, network: NetworkId, onCalm: waiting });
        const said = orderWords(answer);
        if (!answer.ok) throw new StepFailed(said.headline, said.lines);
        return shows((s) => !s.positions.some((p) => p.coin === next.coin && p.size >= next.size), 40_000, `${said.headline} But the position still shows on Hyperliquid.`);
      }
      case 'hl_home': {
        const quote = await quoteMove({ dry: false, move: 'home', account: id, amount: next.amount.toString() });
        const call = quote.move.next;
        if (call?.method !== 'hl_withdraw') throw new StepFailed('The move came without a call for the account, so nothing was sent.');
        const built = buildMove(() => hlWithdrawTx(id, call.args.amount, call.args.destination, call.args.exp, undefined, call.args.expect));
        if (!built.tx) throw new StepFailed(built.problem);
        remember(quote);
        const after = lastSignedIndex(r.hl.hl);
        const outcome = sent(await sendTx(built.tx));
        setPhase({ kind: 'running', title: closeWords(next).title, announce: null, detail: 'Signed. Sending the transfer to Hyperliquid, then waiting for the USDC to arrive…' });
        let index = signedIndexFromLogs(txLogs(outcome), 'sendAsset');
        if (index === null) {
          const found = await until(() => api<HlAnswer>(hlPath(id)), (h) => newSignedEntry(h.hl, 'sendAsset', after) !== null, 60_000);
          index = found ? newSignedEntry(found.hl, 'sendAsset', after)!.index : null;
        }
        if (index === null) throw new StepFailed('No signed transfer appeared. The signer may have timed out.', txLogs(outcome));
        const posted = await post(index);
        if (!posted.ok) throw new StepFailed(submitWords(posted));
        return shows((s) => s.usdcNear > before.usdcNear && !s.moves.some((m) => m.id === quote.move.transfer_id), 5 * 60_000, '1Click hasn’t finished after five minutes: the USDC is still on its way.', 4_000);
      }
      case 'withdraw': {
        const outcomes = await sendTxs(next.tokens.map((t) => withdrawTx(id, t.token, t.amount.toString(), owner)));
        outcomes.forEach(sent);
        return shows((s) => s.nearTokens.length === 0, 40_000, 'The withdrawal doesn’t show yet.');
      }
      default:
        return undefined;
    }
  };

  /** Leads the way out: reads, decides the next step, says what the wallet will ask, does it, and reads again. */
  const start = async () => {
    if (!accountId || running.current) return;
    running.current = true;
    setDone([]);
    setStage(null);
    helper.current = null;
    let title = 'Reading your account';
    let last: CloseStep | null = null;
    let repeats = 0;
    try {
      setPhase({ kind: 'running', title, announce: null, detail: 'Reading your account…' });
      for (let guard = 0; guard < 40; guard++) {
        title = 'Reading your account';
        const reading = await read();
        const next = nextCloseStep(reading.state);
        setStep(next);
        const words = closeWords(next);
        title = words.title;
        if (next.kind === 'done') {
          setPhase({ kind: 'finished' });
          reloadAll();
          return;
        }
        // The same step, unchanged, a third time: its effect isn't showing, so the page stops rather than repeat it.
        repeats = last && sameStep(last, next) ? repeats + 1 : 0;
        last = next;
        if (repeats >= 2) throw new StepFailed(`“${title}” keeps coming back.`, [], { happened: 'This step isn’t showing as done.', todo: 'Nothing more was sent. Wait a minute, then try again.' });
        if (next.kind === 'add_usdc' && !next.canMint) {
          setPhase({ kind: 'stopped', title, words: words.note ?? '' });
          return;
        }
        const part = closeStage(next);
        if (part !== null) setStage(part);
        setLinesFrom(lastLine.current);
        setPhase({ kind: 'running', title, announce: words.approval, detail: words.note });
        await run(next, reading);
        const finished = title;
        setDone((all) => [...all, finished]);
        reloadAll();
      }
      throw new StepFailed('The way out took more steps than it should.');
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setPhase(failedPhase(title, /reject|cancel/i.test(text) && !(error instanceof StepFailed) ? new StepFailed('Cancelled in the wallet') : error));
      reloadAll();
    } finally {
      running.current = false;
    }
  };

  return { phase, step, stage, done, start, busy: phase.kind === 'running', evmLines: evmSend.lines.filter((line) => line.key > linesFrom), check: flow.state };
}
