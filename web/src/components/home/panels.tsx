'use client';
// What the Home page's side panels hold (9 Nov redesign): borrow in one click, repay, add funds; withdrawing and
// moving USDC reuse their forms from the Account page. Phase 6, stage 2 (INTERFACES.md 29): an account that can use
// lenders borrows through `fund`, repays its dearest source first, pays a lender off with the little extra that clears
// it, brings back what that leaves at the lender, takes collateral back from a lender, and claims a credit the pool
// owes it. Stage 3 (INTERFACES.md 33): Aave is a third source. It is repaid from the USDC at the account's address on
// Aave's chain, its collateral comes back to that address, and a token is sent out of the address with `evm_withdraw`.
// Each of those has the account sign an Ethereum transaction, which the page then sends (hooks/use-evm-send.ts).
import Link from 'next/link';
import { useState } from 'react';

import { CheckFlow } from '@/components/check-flow';
import { EvmLines, EvmTxLink } from '@/components/evm-lines';
import { FundingPlan } from '@/components/home/funding-plan';
import { WhereItComesFrom } from '@/components/home/lenders';
import { TxStatus } from '@/components/tx-status';
import { NetworkId, Tokens, UsdcToken } from '@/config';
import { useApi } from '@/hooks/use-api';
import type { ClientAccount } from '@/hooks/use-client-account';
import { useEvmSend } from '@/hooks/use-evm-send';
import { useNow } from '@/hooks/use-now';
import { useTx, type TxRecord } from '@/hooks/use-tx';
import { ApiError, EVM_GAS_PATH, evmGas, type AccountAnswer, type EvmGasInfo, type FundingSource, type LenderAccountAnswer, type LenderName, type LenderPosition } from '@/lib/api';
import { checkAgeWords, everythingLabel, everythingWords, owedAfter, oweHeadline } from '@/lib/borrow-page';
import { approved, collateralAt, EVM_CHAIN_NAME, isEvmAddress, microUsd, tokenAmount, walletToken } from '@/lib/evm';
import { planRunning } from '@/lib/fund';
import { canUseLenders, formatCushion, postedWords, sourceName, toMicro } from '@/lib/funding';
import { creditOwed, creditWords, depositsAt, depositWords, inSentence, loanView, paysOff, lenderPayoff, repayMost, repayOrder, repaySplit, shortOfPayoff, splitWords, usdOrDust, type Purses } from '@/lib/loan';
import type { Token } from '@/lib/types';
import { loanOpen } from '@/lib/hl';
import { borrowTx, claimCreditTx, evmApproveTx, evmWithdrawTx, fundTx, lenderRepayTx, lenderWithdrawTx, mintTx, repayTx, txFailure, txHash, txLogs, type Outcome, type Tx } from '@/lib/tx';
import { displayUnits, formatBp, formatUnits, formatUsd, parseUnits } from '@/lib/units';
import { useNearWallet } from '@/providers/near-provider';

/** Down to whole cents, for an amount put into an input. */
const cents = (micro: bigint) => (micro / 10_000n) * 10_000n;

function readAmount(text: string, decimals: number, max?: bigint, maxWords?: string): { units: string | null; problem: string | null } {
  if (!text) return { units: null, problem: null };
  try {
    const units = parseUnits(text, decimals);
    if (units === '0') return { units: null, problem: 'Enter an amount above 0' };
    if (max !== undefined && BigInt(units) > max) return { units: null, problem: maxWords ?? `That is more than the ${formatUnits(max, decimals)} there` };
    return { units, problem: null };
  } catch (error) {
    return { units: null, problem: (error as Error).message };
  }
}

export function BorrowBox({
  client,
  answer,
  estimate,
  previewEnabled,
  paused,
  lender,
  reloadLender,
  planBelow = false,
  would,
}: {
  client: ClientAccount;
  answer: AccountAnswer;
  estimate: bigint | null;
  previewEnabled: boolean;
  paused: boolean;
  /**
   * The account at each lender (GET /api/lender/:account). An account whose config has lenders borrows through `fund`:
   * one amount, and the engine picks the sources. Today's accounts: the panel is as it was.
   */
  lender?: LenderAccountAnswer;
  reloadLender?: () => void;
  /** In Home's setup checklist the loan's steps show in their own card under it, so they aren't repeated here. */
  planBelow?: boolean;
  /** INTERFACES.md 51.1: what each lender would take from the account, in a word, before it holds anything ("ether" at Rhea for an account that lists and holds test ETH). */
  would?: Partial<Record<LenderName, string>>;
}) {
  const most = estimate !== null && estimate > 0n ? cents(estimate) : null;
  const [text, setText] = useState(() => (most ? formatUnits(most, UsdcToken.decimals) : ''));
  const now = useNow(5_000);
  const { units, problem } = readAmount(text, UsdcToken.decimals);
  const id = answer.account_id;
  const funded = canUseLenders(lender);
  // The account refuses a second funding plan while one still has steps to run.
  const onItsWay = funded && planRunning(lender?.funding, now);
  const ready = units && !paused && !onItsWay ? units : null;
  const signed = planBelow ? 'Signed. The keeper now runs the loan’s steps: they show under this checklist.' : 'Signed. The keeper now runs the loan’s steps, below.';
  const reload = () => {
    client.reload();
    reloadLender?.();
  };

  return (
    <div>
      <label className="form-label small pb-muted mb-1" htmlFor="borrow-amount">
        How much to borrow
      </label>
      <div className="input-group mb-1" style={{ maxWidth: 380 }}>
        <span className="input-group-text">$</span>
        <input id="borrow-amount" className="form-control num" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="0.00" autoComplete="off" />
        <span className="input-group-text">USDC</span>
        {most && (
          <button type="button" className="btn btn-outline-secondary" onClick={() => setText(formatUnits(most, UsdcToken.decimals))}>
            Max
          </button>
        )}
      </div>
      <div className="form-text mb-3">
        {most ? `Max is about ${formatUsd(most)}. The risk engine sets the exact figure when you press Borrow.` : 'The risk engine works out the most you can borrow when you press Borrow.'}
      </div>
      {funded && previewEnabled && <WhereItComesFrom account={id} amount={units} pricing={lender?.pricing?.pricing} posted={postedWords(lender, would)} />}
      {funded ? (
        <CheckFlow
          account={answer}
          fetchedAt={client.fetchedAt}
          reload={reload}
          intent={ready ? { fund: { amount: ready } } : null}
          inputProblem={paused ? 'Borrowing is paused for a moment: a transfer out of Hyperliquid can still be posted. Try again in a few minutes.' : problem}
          checkLabel="Borrow"
          previewEnabled={previewEnabled}
          // The button keeps its amount while it waits: without an intent it can't be pressed.
          act={units ? { label: `Borrow ${formatUsd(units)}`, use: { fund: { amount: units } }, tx: fundTx(id, units), done: signed } : null}
          // A check that lends less than was asked: the same check backs the smaller loan, once the client says yes.
          retarget={(allowed, held) =>
            'fund' in held.intent
              ? {
                  label: `Borrow ${formatUsd(allowed)}`,
                  use: { fund: { amount: held.intent.fund.amount, partial: true } },
                  tx: fundTx(id, held.intent.fund.amount),
                  done: signed,
                }
              : null
          }
          isOwner={client.isOwner}
        />
      ) : (
        <CheckFlow
          account={answer}
          fetchedAt={client.fetchedAt}
          reload={client.reload}
          // While borrowing is paused the account would refuse the borrow, so the check isn't asked for.
          intent={units && !paused ? { borrow: { amount: units } } : null}
          inputProblem={paused ? 'Borrowing is paused for a moment: a transfer out of Hyperliquid can still be posted. Try again in a few minutes.' : problem}
          checkLabel="Borrow"
          previewEnabled={previewEnabled}
          act={units && !paused ? { label: `Borrow ${formatUsd(units)}`, use: { borrow: { amount: units } }, tx: borrowTx(id, units) } : null}
          retarget={(allowed) => ({ label: `Borrow ${formatUsd(allowed)}`, use: { borrow: { amount: allowed.toString() } }, tx: borrowTx(id, allowed.toString()) })}
          isOwner={client.isOwner}
        />
      )}
      {onItsWay && <div className="form-text">A loan is already on its way. Once its steps have run, or you stop it, you can borrow again.</div>}
      {funded && !planBelow && (
        <FundingPlan
          accountId={id}
          funding={lender?.funding}
          pending={answer.state?.pending}
          height={answer.block_height}
          evm={lender?.evm}
          ownEvm={answer.state?.evm}
          isOwner={client.isOwner}
          onChanged={reload}
          balances={answer.balances}
        />
      )}
    </div>
  );
}

/** One transaction of a run. */
interface RunItem {
  label: string;
  tx: Tx;
  /**
   * What must follow once it went through, before the next starts. Stage 3: a call at Aave only has the account sign an
   * Ethereum transaction, and this sends it to Aave's chain and waits for it. It answers whether that worked.
   */
  after?: (outcome: Outcome) => Promise<boolean>;
  /** The run goes on if this one fails: Aave's one-time approval, which the account may already have given. */
  optional?: boolean;
}

/** Several transactions, one after another, each with its own line. It stops at the first that fails, and says whether all went through. */
function useTxs() {
  const { sendTx } = useNearWallet();
  const [busy, setBusy] = useState(false);
  const [records, setRecords] = useState<TxRecord[]>([]);
  const run = async (list: RunItem[]): Promise<boolean> => {
    setBusy(true);
    setRecords([]);
    const done: TxRecord[] = [];
    let ok = true;
    try {
      for (const { label, tx, after, optional } of list) {
        let went = false;
        try {
          const outcome = await sendTx(tx);
          const failure = txFailure(outcome);
          done.push({ label, hash: txHash(outcome), failure, logs: txLogs(outcome) });
          setRecords([...done]);
          went = !failure && (after ? await after(outcome) : true);
        } catch (error) {
          const said = error instanceof Error ? error.message : String(error);
          done.push({ label, error: /reject|cancel/i.test(said) ? 'Cancelled in the wallet' : said, logs: [] });
          setRecords([...done]);
        }
        if (!went && !optional) {
          ok = false;
          break;
        }
      }
    } finally {
      setBusy(false);
    }
    return ok;
  };
  return { run, busy, records };
}

export function RepayBox({
  client,
  answer,
  lender,
  poolRateBp,
  reloadLender,
  first,
  onSendUsdc,
}: {
  client: ClientAccount;
  answer: AccountAnswer;
  /** The account at each lender. With a lender loan, the repayment pays the dearest source first. */
  lender?: LenderAccountAnswer;
  /** Our pool's rate for the account's tier, to say which source is dearest. */
  poolRateBp?: number | null;
  reloadLender?: () => void;
  /** Opened from a lender's card: that lender alone, until the client picks otherwise. */
  first?: FundingSource | null;
  /** Stage 4, testnet: opens "Send USDC to Aave's chain", for repaying Aave with USDC that is on NEAR. */
  onSendUsdc?: () => void;
}) {
  const [text, setText] = useState('');
  const [only, setOnly] = useState<FundingSource | ''>(first ?? '');
  const [faucet, setFaucet] = useState<{ busy: boolean; said?: { ok: boolean; text: string; hash?: string } }>({ busy: false });
  const txs = useTxs();
  const state = answer.state!;
  const id = answer.account_id;
  const reload = () => {
    client.reload();
    reloadLender?.();
  };
  const evmSend = useEvmSend(id, reload);
  const poolDebt = BigInt(answer.debt ?? state.loan.principal);
  const usdc = BigInt(answer.balances.find((b) => b.token === UsdcToken.id)?.amount ?? '0');
  const loan = loanView({ poolDebt, poolRateBp: poolRateBp ?? null, lenders: lender?.lenders ?? [], pricing: lender?.pricing?.pricing });
  const chosen = repayOrder(loan.parts, only || null);
  const withLender = loan.parts.some((p) => p.source !== 'pool');
  // Stage 3: Aave is repaid from the USDC at the account's address on its chain; our pool and Rhea from the USDC on NEAR.
  const evm = lender?.evm ?? null;
  const evmUsdcToken = walletToken(evm, 'USDC');
  const owesAave = loan.parts.some((p) => p.source === 'aave');
  const purses: Purses = { near: usdc, evm: owesAave && evmUsdcToken ? microUsd(evmUsdcToken.amount, evmUsdcToken.decimals) : 0n };
  // Testnet: paying Aave off takes a little more USDC at the address than was borrowed, for the interest. While the
  // backend's gas helper is on (GET /api/evm/gas), Aave's faucet can put 1 test USDC there.
  const gasHelp = useApi<EvmGasInfo>(NetworkId === 'testnet' && owesAave ? EVM_GAS_PATH : null, 60_000);
  const aaveDebt = loan.parts.find((p) => p.source === 'aave')?.debt ?? 0n;
  // Only when 1 USDC closes the gap: an address the loan has left needs the USDC itself, sent from NEAR (stage 4).
  const short = gasHelp.data?.on === true && Boolean(evmUsdcToken) && (!only || only === 'aave') && shortOfPayoff(aaveDebt, purses.evm) && purses.evm + 1_000_000n >= lenderPayoff(aaveDebt);
  const getInterestUsdc = async () => {
    if (!evmUsdcToken) return;
    setFaucet({ busy: true });
    let waitsToBeMined = false;
    try {
      const one = (10n ** BigInt(evmUsdcToken.decimals)).toString();
      const { mint } = await evmGas(id, { mint: { token: evmUsdcToken.token, amount: one } });
      waitsToBeMined = mint?.mined !== true;
      setFaucet({
        busy: false,
        said:
          mint?.ok === false
            ? { ok: false, text: `${EVM_CHAIN_NAME} mined the faucet’s transaction, but it failed there, so nothing arrived.`, hash: mint.hash }
            : { ok: true, text: '', hash: mint?.hash },
      });
    } catch (error) {
      setFaucet({ busy: false, said: { ok: false, text: error instanceof ApiError ? error.message : String(error) } });
    }
    reload();
    // The backend waits up to 20 seconds for the faucet's transaction: one mined after that shows on a later read.
    for (const ms of waitsToBeMined ? [3_000, 6_000] : []) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      reload();
    }
  };
  // Interest accrues every second and the pool returns anything above the debt, so "all" sends the pool a little extra.
  const all = repayMost(chosen.order, purses);
  // "Repay everything" (INTERFACES.md 49.1 point 8): the most the account's USDC can pay now, in one click. With one
  // source picked in the list it pays that source off instead, and says so on the button.
  const everything = repaySplit(all, chosen.order, purses);
  const owedChosen = chosen.order.reduce((sum, p) => sum + p.debt, 0n);
  const oneSource = only && loan.parts.length > 1 && loan.parts.some((p) => p.source === only) ? only : null;
  // A lender's figures are the last check's, not the lender's now: say so once that check is old.
  const asOf = withLender ? checkAgeWords(lender?.verdict_blk, answer.block_height) : null;
  const holds = owesAave
    ? `Your account holds ${formatUsd(purses.near)} of USDC on NEAR and ${formatUsd(purses.evm)} at its address on ${EVM_CHAIN_NAME}`
    : `Your account holds ${formatUsd(usdc)} of USDC`;
  const { units, problem } = readAmount(text, UsdcToken.decimals, purses.near + purses.evm, holds);
  const split = units ? repaySplit(BigInt(units), chosen.order, purses) : [];
  const sends = split.reduce((sum, p) => sum + p.amount, 0n);
  // A payment that clears a lender sends it a little over the debt read, and Rhea keeps the rest as a deposit.
  const cleared = paysOff(split, chosen.order);
  const deleverage = state.verdict?.verdict.action === 'DELEVERAGE';
  // What the sources repaid from NEAR are owed, against the USDC there.
  const owedFromNear = loan.parts.filter((p) => p.source !== 'aave').reduce((sum, p) => sum + p.debt, 0n);

  /** The transactions of one payment. Aave's are Ethereum transactions the account signs, which the page then sends. */
  const itemsFor = (p: { source: FundingSource; amount: bigint }): RunItem[] => {
    const label = `Repay ${formatUsd(p.amount)} to ${inSentence(p.source)}`;
    if (p.source === 'pool') return [{ label, tx: repayTx(id, p.amount.toString()) }];
    if (p.source !== 'aave' || !evmUsdcToken) return [{ label, tx: lenderRepayTx(id, p.source, p.amount.toString()) }];
    const fromNonce = evm?.nonce ?? 0;
    // Aave takes USDC from the address only after a one-time approval. Unless it is known to be there, ask for it first.
    const approve: RunItem[] =
      approved(evm, evmUsdcToken.token, state.evm) === true
        ? []
        : [{ label: 'Let Aave take USDC from the address (once)', tx: evmApproveTx(id, evmUsdcToken.token), optional: true, after: (o) => evmSend.send(o, 'approve', `Send the approval to ${EVM_CHAIN_NAME}`, fromNonce) }];
    // lender_repay takes micro-USD for every lender (INTERFACES.md 25).
    return [...approve, { label, tx: lenderRepayTx(id, 'aave', p.amount.toString()), after: (o) => evmSend.send(o, 'repay', `Send the repayment to ${EVM_CHAIN_NAME}`, fromNonce) }];
  };

  // How the repayments just sent went: they stay in view once the last of them has cleared the loan.
  const sent = (
    <>
      {txs.busy && !evmSend.busy && <TxStatus record={null} busy />}
      {txs.records.map((record) => (
        <TxStatus key={record.label} record={record} />
      ))}
      <EvmLines lines={evmSend.lines} />
    </>
  );

  if (!loanOpen(state.loan) && loan.total === 0n) {
    return (
      <>
        <p className="pb-muted">Nothing is borrowed, so there is nothing to repay.</p>
        {sent}
        <LenderDeposits accountId={id} lender={lender} onChanged={reload} />
      </>
    );
  }
  const mayRepay = client.isOwner || deleverage;
  const everythingLine = everythingWords({ pays: all, left: owedAfter(chosen.order, everything), source: oneSource ? sourceName(oneSource) : null });
  return (
    <div>
      <p className="mb-2">
        <span className="fw-semibold">{oweHeadline({ owed: loan.total, rateBp: loan.rateBp })}</span> Repay any part of it at any time.
      </p>
      {withLender && (
        <>
          <dl className="pb-rows mb-2">
            {loan.parts.map((part) => (
              <div key={part.source}>
                <dt>{part.name}</dt>
                <dd>
                  <span className="num">{formatUsd(part.debt)}</span>
                  <span className="sub">{part.payBp === null ? 'Rate not read yet' : `costs you ${formatBp(part.payBp)} a year`}</span>
                </dd>
              </div>
            ))}
          </dl>
          {asOf && <div className="form-text mb-2">A lender’s figure here is {asOf}. A repayment made since then shows after the next check of your account.</div>}
          <p className="mb-2">{chosen.why}</p>
          {loan.parts.length > 1 && (
            <select className="form-select form-select-sm mb-3" style={{ maxWidth: 380 }} value={only} onChange={(e) => setOnly(e.target.value as FundingSource | '')} aria-label="Which source to repay">
              <option value="">Pay the dearest first</option>
              {loan.parts.map((part) => (
                <option key={part.source} value={part.source}>
                  Pay {inSentence(part.source)} alone
                </option>
              ))}
            </select>
          )}
        </>
      )}
      <div className="d-flex flex-wrap align-items-start gap-2 mb-1">
        <div className="input-group" style={{ maxWidth: 280 }}>
          <span className="input-group-text">$</span>
          <input className="form-control num" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="0.00" aria-label="USDC to repay" autoComplete="off" />
          <span className="input-group-text">USDC</span>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={split.length === 0 || !mayRepay || txs.busy}
          onClick={async () => {
            const paid = await txs.run(split.flatMap(itemsFor));
            if (paid) setText('');
            reload();
          }}
        >
          Repay {sends > 0n ? formatUsd(sends) : ''}
        </button>
        {/* One click: every source's debt with the little extra that clears it, as far as the account's USDC goes. */}
        <button
          type="button"
          className="btn btn-outline-primary"
          disabled={everything.length === 0 || !mayRepay || txs.busy}
          onClick={async () => {
            const paid = await txs.run(everything.flatMap(itemsFor));
            if (paid) setText('');
            reload();
          }}
        >
          {everythingLabel(oneSource ? sourceName(oneSource) : null)}
        </button>
      </div>
      {/* With nothing at the address to pay Aave alone from, the lines below say how to get USDC there. */}
      {(all > 0n || oneSource !== 'aave') && <div className="form-text">{everythingLine}</div>}
      {problem && <div className="form-text text-danger">{problem}</div>}
      {owesAave && (
        <div className="form-text">
          Aave is repaid from the USDC at the account’s address on {EVM_CHAIN_NAME}: {formatUsd(purses.evm)} is there. Our pool and Rhea are repaid from the USDC on NEAR:{' '}
          {formatUsd(purses.near)}.
        </div>
      )}
      {(short || faucet.said) && (
        <div className="form-text">
          {short && (
            <>
              Interest grows every second, so paying a loan off takes a little more than was borrowed. On testnet, Aave’s faucet can add it at the address.{' '}
              <button type="button" className="btn btn-outline-secondary btn-sm" disabled={faucet.busy} onClick={() => void getInterestUsdc()}>
                {faucet.busy ? 'Asking…' : 'Get 1 test USDC for the interest'}
              </button>
            </>
          )}
          {faucet.said && (
            <div className={faucet.said.ok ? '' : 'text-danger'}>
              {/* Once the address holds enough, the test USDC has arrived. */}
              {!faucet.said.ok ? faucet.said.text : short ? '1 test USDC is on its way to the address.' : '1 test USDC is at the address.'}
              <EvmTxLink hash={faucet.said.hash} />
            </div>
          )}
        </div>
      )}
      {/* Stage 4, testnet: once the loan has come home, the USDC to repay Aave with is on NEAR. This sends it back. */}
      {onSendUsdc && owesAave && (!only || only === 'aave') && shortOfPayoff(aaveDebt, purses.evm) && (
        <div className="form-text">
          The address holds less USDC than Aave is owed. To repay Aave with USDC from your account on NEAR, send it there first: it costs a little and takes a few
          minutes.{' '}
          <button type="button" className="btn btn-outline-secondary btn-sm" onClick={onSendUsdc}>
            Send USDC to Aave’s chain
          </button>
        </div>
      )}
      {withLender && split.length > 1 && <div className="form-text">This sends {splitWords(split)}. Your wallet asks you to approve each one.</div>}
      {withLender && units && sends < BigInt(units) && <div className="form-text">That is more than can be paid from here, so {formatUsd(sends)} is sent.</div>}
      {cleared.map((source) => (
        <div className="form-text" key={source}>
          This pays {sourceName(source)} off. It is sent a little over the debt read, about 1 cent on $500, because interest there grows by the second.{' '}
          {source === 'aave'
            ? 'Aave takes only what it is owed, and the rest stays at the address.'
            : `${sourceName(source)} keeps what it doesn’t need as your deposit, and this page then shows a button that brings it back.`}
        </div>
      ))}
      {usdc < owedFromNear && <div className="form-text">Your account holds {formatUsd(usdc)} of USDC on NEAR. To repay more from there, add funds or bring USDC home from Hyperliquid.</div>}
      {!mayRepay && <div className="form-text">Only the owner can repay, unless the account is unwinding.</div>}
      {/* INTERFACES.md 40.1, item 3: the account refuses a part repayment at Aave from anyone but the owner. */}
      {!client.isOwner && split.some((p) => p.source === 'aave' && p.amount < aaveDebt) && (
        <div className="form-text text-danger">Anyone but the owner repays all of what Aave is owed, or nothing: the account refuses a part of it.</div>
      )}
      <details className="form-text">
        <summary>How repaying works</summary>
        {withLender
          ? `The account pays from its own USDC. A part payment to a lender is sent as it is; paying it off adds the little extra that clears it. Our pool sends back anything above its part. Repaying needs no check and is never paused. A lender’s figures update with the next check of your account.${
              owesAave ? ` A repayment to Aave is a transaction on ${EVM_CHAIN_NAME}: the account signs it through Chain Signatures, and this page sends it and waits for it to be mined.` : ''
            }`
          : 'The account pays the pool from its own USDC, and the pool sends back anything above what is owed. Repaying needs no check and is never paused.'}
      </details>
      {sent}
      <LenderDeposits accountId={id} lender={lender} onChanged={reload} />
    </div>
  );
}

/**
 * USDC of the account's that is sitting at a lender as a plain deposit (stage 2): what a repayment above the debt left
 * there. One line per lender says how much, with a button that brings it back: `lender_withdraw` of the USDC token,
 * with 1 yoctoNEAR. Anyone may call it and it needs no check, so the button isn't the owner's alone. `notice` gives it
 * Home's notice look; in a panel it is plain.
 */
export function LenderDeposits({ accountId, lender, onChanged, notice }: { accountId: string; lender?: LenderAccountAnswer; onChanged: () => void; notice?: boolean }) {
  const tx = useTx();
  const sitting = depositsAt(lender?.lenders);
  if (sitting.length === 0) return tx.last || tx.busy ? <TxStatus record={tx.last} busy={tx.busy} /> : null;
  return (
    <div className={notice ? 'alert alert-info' : 'mt-3'} role="status">
      {sitting.map((deposit) => (
        <div className="d-flex flex-wrap align-items-center gap-3" key={deposit.l}>
          <span className={notice ? '' : 'small'} style={{ flex: '1 1 20rem', minWidth: 0 }}>
            {notice && <i className="bi bi-box-arrow-in-left me-2" aria-hidden="true" />}
            {depositWords(deposit.name, deposit.amount)}
          </span>
          <button
            type="button"
            className={`btn btn-sm ${notice ? 'btn-primary' : 'btn-outline-primary'}`}
            disabled={tx.busy}
            onClick={async () => {
              await tx.run(`Bring ${usdOrDust(deposit.amount)} back from ${deposit.name}`, lenderWithdrawTx(accountId, deposit.l, UsdcToken.id, deposit.amount.toString()));
              onChanged();
            }}
          >
            Bring back {usdOrDust(deposit.amount)}
          </button>
        </div>
      ))}
      <TxStatus record={tx.last} busy={tx.busy} />
    </div>
  );
}

/** The collateral posted at a lender, from the lender's own record (`held` in GET /api/lender/:account): the most that can be taken back. */
function heldAt(position: LenderPosition): { token: Token; amount: bigint }[] {
  return (position.held ?? [])
    .map((h) => ({ token: { id: h.token, symbol: h.symbol, label: Tokens.find((t) => t.id === h.token)?.label ?? h.symbol, decimals: h.decimals }, amount: toMicro(h.amount) }))
    .filter((h) => h.amount > 0n);
}

/**
 * Taking collateral back from a lender (INTERFACES.md 25): `lender_withdraw(lender, token, amount)`. While the account
 * owes our pool it needs a fresh check that answers this same request, so one click runs both. With nothing owed to our
 * pool it needs none: the lender's own rule still applies.
 */
export function LenderWithdrawBox({
  client,
  answer,
  lender,
  which,
  previewEnabled,
  reloadLender,
  onBringHome,
  homeLabel = 'Bring the bitcoin home',
}: {
  client: ClientAccount;
  answer: AccountAnswer;
  lender?: LenderAccountAnswer;
  which: LenderName;
  previewEnabled: boolean;
  reloadLender?: () => void;
  /** Stage 4, testnet: opens "Bring the bitcoin home", for collateral that came back from Aave to the address. */
  onBringHome?: () => void;
  /** INTERFACES.md 51.2: the move's own name, when it isn't bitcoin's: "Bring the ETH home" on an account whose trade is in ETH. */
  homeLabel?: string;
}) {
  const position = lender?.lenders.find((p) => p.l === which);
  const options = position ? heldAt(position) : [];
  const [tokenId, setTokenId] = useState('');
  const [text, setText] = useState('');
  const direct = useTx();
  const name = sourceName(which);
  const id = answer.account_id;
  const reload = () => {
    client.reload();
    reloadLender?.();
  };
  // At Aave the call only has the account sign a transaction for Aave's chain: the page then sends it.
  const evmSend = useEvmSend(id, reload);
  const atAave = which === 'aave';
  const sendIt = (outcome: Outcome) => evmSend.send(outcome, 'withdraw', `Send the withdrawal to ${EVM_CHAIN_NAME}`, lender?.evm?.nonce ?? 0);
  // Stage 4, testnet: collateral that is back at the address can go on home to NEAR, as nBTC.
  const back = atAave && onBringHome ? collateralAt(lender?.evm) : [];
  const bringHome = back.length > 0 && (
    <div className="form-text mt-2">
      {back.map((t) => tokenAmount(t.amount, t)).join(' and ')} of collateral sits at the account’s address on {EVM_CHAIN_NAME}.{' '}
      <button type="button" className="btn btn-outline-secondary btn-sm" onClick={onBringHome}>
        {homeLabel}
      </button>
    </div>
  );
  // Once all of it has come back the box has nothing left to offer, but what just happened stays on show.
  if (!position || toMicro(position.posted) <= 0n) {
    return (
      <div>
        <p className="pb-muted mb-0">Nothing is posted with {name}, so there is nothing to take back.</p>
        <TxStatus record={direct.last} busy={direct.busy} />
        <EvmLines lines={evmSend.lines} />
        {bringHome}
      </div>
    );
  }
  // The most that can come back is what the lender's own record holds. Without that reading the page offers nothing.
  if (options.length === 0) {
    return <p className="pb-muted mb-0">The page has no reading of what {name} holds for you just now, so it can’t say how much can come back. Try again in a moment.</p>;
  }

  const picked = options.find((o) => o.token.id === tokenId) ?? options[0]!;
  const { token } = picked;
  const heldWords = `${displayUnits(picked.amount, token.decimals, token.decimals)} ${token.symbol}`;
  const { units, problem } = readAmount(text, token.decimals, picked.amount, `${name} holds ${heldWords} of yours: that is the most that can come back`);
  const state = answer.state!;
  const owesPool = loanOpen(state.loan) || BigInt(answer.debt ?? '0') > 0n;
  const owesLender = toMicro(position.debt) > 0n;
  const tx = units ? lenderWithdrawTx(id, which, token.id, units) : null;
  // The loan figure is the last check's, not the lender's now (48.13: "$21.71" stayed on show after it was repaid).
  const asOf = owesLender ? checkAgeWords(lender?.verdict_blk, answer.block_height) : null;

  return (
    <div>
      <p>
        {name} holds <span className="num fw-semibold">{heldWords}</span> of yours, worth about {formatUsd(toMicro(position.posted))}
        {owesLender
          ? asOf
            ? `. The loan there was ${formatUsd(toMicro(position.debt))} ${asOf}: if you have repaid it since, all of this can come back.`
            : `, against a loan there of ${formatUsd(toMicro(position.debt))}. The cushion is ${formatCushion(position.hf_bp)}; taking collateral back makes it thinner.`
          : ', and nothing is owed there.'}{' '}
        {atAave
          ? `It comes back to the account’s own address on ${EVM_CHAIN_NAME}, not to NEAR. ${onBringHome ? `“${homeLabel}” then moves it on to NEAR.` : '“Send a token out”, on that address’s card, moves it on from there.'}`
          : 'It comes back to your account on NEAR.'}
      </p>
      {options.length > 1 && (
        <select className="form-select form-select-sm mb-2" style={{ maxWidth: 380 }} value={token.id} onChange={(e) => setTokenId(e.target.value)} aria-label="Token">
          {options.map((o) => (
            <option key={o.token.id} value={o.token.id}>
              {o.token.symbol}
            </option>
          ))}
        </select>
      )}
      <div className="input-group mb-2" style={{ maxWidth: 380 }}>
        <input className="form-control num" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="0.00" aria-label={`${token.symbol} to take back`} autoComplete="off" />
        <span className="input-group-text">{token.symbol}</span>
        {/* Always there (48.13: the user had to type 0.02 by hand). With a loan still open the lender refuses all of it, and the line below says so. */}
        <button type="button" className="btn btn-outline-secondary" onClick={() => setText(formatUnits(picked.amount, token.decimals))}>
          All
        </button>
      </div>
      <div className="form-text mb-2">
        At most {heldWords}
        {owesLender ? `, and less if ${name} is still owed: enough must stay to cover the loan there. If it refuses all of it, repay ${name} first or take back less.` : '.'}
      </div>
      {owesPool ? (
        <>
          <p className="form-text">
            You owe our pool, so the risk engine checks this first: it goes through only if your whole account still covers your loans afterwards, and the cushion with{' '}
            {name} stays wide enough.
          </p>
          <CheckFlow
            account={answer}
            fetchedAt={client.fetchedAt}
            reload={reload}
            intent={units ? { lender_withdraw: { lender: which, token: token.id, amount: units } } : null}
            inputProblem={problem}
            checkLabel="Take back"
            previewEnabled={previewEnabled}
            act={
              tx && units
                ? {
                    label: `Take back ${text} ${token.symbol}`,
                    use: { lender_withdraw: { lender: which, token: token.id, amount: units } },
                    tx,
                    ...(atAave && { done: `Signed. This page now sends it to ${EVM_CHAIN_NAME}, below.`, onSent: (outcome: Outcome) => void sendIt(outcome) }),
                  }
                : null
            }
            isOwner={client.isOwner}
          />
          <EvmLines lines={evmSend.lines} />
        </>
      ) : (
        <>
          <p className="form-text">
            You owe our pool nothing, so this needs no check. {owesLender ? `${name} itself refuses an amount that would leave its loan short of cover.` : ''}
          </p>
          {problem && <div className="form-text text-danger">{problem}</div>}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!tx || !client.isOwner || direct.busy}
            onClick={async () => {
              if (!tx) return;
              const outcome = await direct.run(`Take back ${text} ${token.symbol} from ${name}`, tx);
              if (outcome && atAave) await sendIt(outcome);
              reload();
            }}
          >
            Take back {units ? `${text} ${token.symbol}` : ''}
          </button>
          {!client.isOwner && <div className="form-text">Only the account’s owner can do this.</div>}
          <TxStatus record={direct.last} busy={direct.busy} />
          <EvmLines lines={evmSend.lines} />
        </>
      )}
      {bringHome}
    </div>
  );
}

/**
 * Sending a token out of the account's address on Aave's chain (stage 3; INTERFACES.md 33): `evm_withdraw(token,
 * amount, to)`, the owner only. While the account owes our pool it needs a fresh check that answers this same token and
 * amount, so one click runs both. The account signs the transfer through Chain Signatures, and the page sends it.
 */
export function EvmWithdrawBox({ client, answer, lender, previewEnabled, reloadLender }: { client: ClientAccount; answer: AccountAnswer; lender?: LenderAccountAnswer; previewEnabled: boolean; reloadLender?: () => void }) {
  const evm = lender?.evm ?? null;
  const tokens = (evm?.wallet ?? []).filter((t) => toMicro(t.amount) > 0n);
  const [tokenId, setTokenId] = useState('');
  const [text, setText] = useState('');
  const [toText, setToText] = useState('');
  const direct = useTx();
  const id = answer.account_id;
  const reload = () => {
    client.reload();
    reloadLender?.();
  };
  const evmSend = useEvmSend(id, reload);
  if (!evm?.address) return <p className="pb-muted mb-0">The account has no address on {EVM_CHAIN_NAME} yet.</p>;
  // Once the last of it has gone the box has nothing left to offer, but what just happened stays on show.
  if (tokens.length === 0) {
    return (
      <div>
        <p className="pb-muted mb-0">Nothing sits at the account’s address on {EVM_CHAIN_NAME}, so there is nothing to send out.</p>
        <TxStatus record={direct.last} busy={direct.busy} />
        <EvmLines lines={evmSend.lines} />
      </div>
    );
  }

  const token = tokens.find((t) => t.token === tokenId) ?? tokens[0]!;
  const there = toMicro(token.amount);
  const { units, problem: amountProblem } = readAmount(text, token.decimals, there, `The address holds ${tokenAmount(there, token)}`);
  const to = toText.trim();
  const problem = amountProblem ?? (to && !isEvmAddress(to) ? `The destination must be an address on ${EVM_CHAIN_NAME}: 0x and 40 letters and digits` : null);
  const ready = units && isEvmAddress(to) ? units : null;
  const tx = ready ? evmWithdrawTx(id, token.token, ready, to) : null;
  const owesPool = loanOpen(answer.state!.loan) || BigInt(answer.debt ?? '0') > 0n;
  const sendIt = (outcome: Outcome) => evmSend.send(outcome, 'transfer', `Send the transfer to ${EVM_CHAIN_NAME}`, evm.nonce ?? 0);
  const label = `Send ${text} ${token.symbol}`;

  return (
    <div>
      <p>
        This sends a token from the account’s own address on {EVM_CHAIN_NAME} to any address there. The account signs the transfer through Chain Signatures, and this page
        sends it.
      </p>
      <div className="d-flex flex-wrap gap-2 mb-2" style={{ maxWidth: 380 }}>
        {tokens.length > 1 && (
          <select className="form-select form-select-sm" style={{ maxWidth: 120 }} value={token.token} onChange={(e) => setTokenId(e.target.value)} aria-label="Token">
            {tokens.map((t) => (
              <option key={t.token} value={t.token}>
                {t.symbol}
              </option>
            ))}
          </select>
        )}
        <div className="input-group input-group-sm" style={{ flex: '1 1 200px' }}>
          <input className="form-control num" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="0.00" aria-label={`${token.symbol} to send`} autoComplete="off" />
          <span className="input-group-text">{token.symbol}</span>
          <button type="button" className="btn btn-outline-secondary" onClick={() => setText(formatUnits(there, token.decimals))}>
            All
          </button>
        </div>
      </div>
      <input className="form-control form-control-sm mb-1" style={{ maxWidth: 380 }} value={toText} onChange={(e) => setToText(e.target.value)} placeholder="to 0x…" aria-label="Destination address" autoComplete="off" spellCheck={false} />
      <div className="form-text mb-2">The address holds {tokenAmount(there, token)}. Check the destination: a transfer on {EVM_CHAIN_NAME} can’t be undone.</div>
      {owesPool ? (
        <>
          <p className="form-text">You owe our pool, so the risk engine checks this first: it goes through only if what stays still covers your loans.</p>
          <CheckFlow
            account={answer}
            fetchedAt={client.fetchedAt}
            reload={reload}
            intent={ready ? { evm_withdraw: { token: token.token, amount: ready } } : null}
            inputProblem={problem}
            checkLabel="Send"
            previewEnabled={previewEnabled}
            act={
              tx && ready
                ? {
                    label,
                    use: { evm_withdraw: { token: token.token, amount: ready } },
                    tx,
                    done: `Signed. This page now sends it to ${EVM_CHAIN_NAME}, below.`,
                    onSent: (outcome: Outcome) => void sendIt(outcome),
                  }
                : null
            }
            isOwner={client.isOwner}
          />
        </>
      ) : (
        <>
          <p className="form-text">You owe our pool nothing, so this needs no check.</p>
          {problem && <div className="form-text text-danger">{problem}</div>}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!tx || !client.isOwner || direct.busy || evmSend.busy}
            onClick={async () => {
              if (!tx) return;
              const outcome = await direct.run(label, tx);
              if (outcome) await sendIt(outcome);
              reload();
            }}
          >
            Send {ready ? `${text} ${token.symbol}` : ''}
          </button>
          {!client.isOwner && <div className="form-text">Only the account’s owner can do this.</div>}
          <TxStatus record={direct.last} busy={direct.busy} />
        </>
      )}
      <EvmLines lines={evmSend.lines} />
    </div>
  );
}

/** On Home, when the pool owes the account a credit (INTERFACES.md 26): what it is, and the button that claims it. */
export function ClaimCredit({ client, accountId, lender, reloadLender }: { client: ClientAccount; accountId: string; lender?: LenderAccountAnswer; reloadLender?: () => void }) {
  const tx = useTx();
  const credit = creditOwed(lender?.pricing);
  if (credit === 0n) return tx.last ? <TxStatus record={tx.last} busy={tx.busy} /> : null;
  return (
    <div className="alert alert-info" role="status">
      <div className="d-flex flex-wrap align-items-center gap-3">
        <span style={{ flex: '1 1 20rem', minWidth: 0 }}>
          <i className="bi bi-cash-stack me-2" aria-hidden="true" />
          {creditWords(credit)}
        </span>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!client.isOwner || tx.busy}
          onClick={async () => {
            await tx.run(`Claim ${formatUsd(credit)}`, claimCreditTx(accountId));
            client.reload();
            reloadLender?.();
          }}
        >
          Claim {formatUsd(credit)}
        </button>
      </div>
      {!client.isOwner && <div className="small mt-1">Only the account’s owner can claim it.</div>}
      <TxStatus record={tx.last} busy={tx.busy} />
    </div>
  );
}

const TEST_DEFAULTS: Record<string, string> = { USDC: '440', nBTC: '0.015' };

/** Testnet: the test tokens' faucet, straight into the account. Elsewhere, the Add funds page. */
export function AddFundsBox({ client, answer }: { client: ClientAccount; answer: AccountAnswer }) {
  return (
    <div>
      {NetworkId === 'testnet' ? (
        <>
          <p>Testnet only: mint test tokens straight into your account. They play nBTC and USDC, and are worth nothing.</p>
          {Tokens.map((token) => (
            <MintRow key={token.id} token={token} client={client} answer={answer} />
          ))}
        </>
      ) : (
        <p>Deposit from your wallet, or from any chain through 1Click.</p>
      )}
      <p className="mt-3 mb-0">
        <Link href="/deposit">
          From your wallet, or from another token through 1Click <i className="bi bi-arrow-right" aria-hidden="true" />
        </Link>
      </p>
    </div>
  );
}

function MintRow({ token, client, answer }: { token: Token; client: ClientAccount; answer: AccountAnswer }) {
  const [text, setText] = useState(TEST_DEFAULTS[token.symbol] ?? '1');
  const tx = useTx();
  const { units, problem } = readAmount(text, token.decimals);
  const holds = answer.balances.find((b) => b.token === token.id)?.amount ?? '0';
  return (
    <div className="mb-3">
      <div className="input-group" style={{ maxWidth: 380 }}>
        <input className="form-control num" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} aria-label={`Test ${token.symbol} to add`} />
        <span className="input-group-text">test {token.symbol}</span>
        <button
          type="button"
          className="btn btn-outline-primary"
          disabled={!units || tx.busy}
          onClick={async () => {
            if (!units) return;
            await tx.run(`Add ${text} test ${token.symbol}`, mintTx(token.id, answer.account_id, units));
            client.reload();
          }}
        >
          Add
        </button>
      </div>
      <div className="form-text">
        Your account holds {formatUnits(holds, token.decimals)} {token.symbol}.
      </div>
      {problem && <div className="form-text text-danger">{problem}</div>}
      <TxStatus record={tx.last} busy={tx.busy} />
    </div>
  );
}
