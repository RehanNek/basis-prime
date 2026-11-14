'use client';
// The setup checklist's actions (9 Nov redesign), each as one async step that returns once its effect shows on the
// chain or on Hyperliquid: open the account, add test collateral, then the hedge's five parts. "Set up the demo for
// me" runs them in order, reading the account afresh before each, and stops at the borrow, which is the client's
// own decision. The wallet approves every transaction; nothing here signs anything itself.
// Phase 6, stage 2 (INTERFACES.md 25): opening the account also signs the funding permission, when one is offered and
// the client leaves it ticked, in the same approval. A new account costs 6 NEAR.
// Stage 3 (INTERFACES.md 33): on testnet, an account whose config has Aave also gets test collateral at its address on
// Base Sepolia, from the backend's gas wallet, with no wallet approval.
import { useRef, useState } from 'react';

import { FactoryContract, NetworkId, Tokens } from '@/config';
import {
  accountPath,
  api,
  ApiError,
  EVM_GAS_PATH,
  evmGas,
  hlPath,
  lenderPath,
  LENDERS_PATH,
  marketsPath,
  quoteMove,
  sendOrder,
  statusPath,
  submitSigned,
  type AccountAnswer,
  type EvmGasInfo,
  type LenderAccountAnswer,
  type LendersAnswer,
  type MarketsAnswer,
  type StatusAnswer,
} from '@/lib/api';
import { collateralAt, EVM_CHAIN_NAME, testCollateral } from '@/lib/evm';
import { termsFor } from '@/lib/funding';
import { expiryNow, GATEWAY_RECIPIENT, orderLifeMs, orderMessage, orderWords, randomNonce, toAuth } from '@/lib/gateway';
import { coinTradingNow, notTradingWords, ownOrderBp } from '@/lib/hl-reach';
import { sendWithinLife } from '@/lib/order-life';
import { agentApproved, hlFunded, hlSummary, lastSignedIndex, loanOpen, newSignedEntry, signedIndexFromLogs, submitWords, type HlAnswer } from '@/lib/hl';
import { decFromNumber, decText, roundOrder, roundPrice } from '@/lib/hl-rules';
import { held, setupView, testCollateralStep } from '@/lib/setup';
import { swapStatusWords } from '@/lib/swap';
import { createAccountTx, hlApproveAgentTx, hlInitTx, mintTx, requestAgentTx, txFailure, txHash, txLogs, withdrawTx, type Outcome } from '@/lib/tx';
import type { Permission } from '@/lib/types';
import { formatUnits } from '@/lib/units';
import { useNearWallet } from '@/providers/near-provider';

/** The demo's collateral (PLAN.md 2 at the quarter size the user tests with): about $1,100 of nBTC and $440 of USDC. */
export const DEMO_NBTC_UNITS = 1_500_000n;
export const DEMO_USDC_UNITS = 440_000_000n;
/** USDC kept on NEAR when the rest moves to Hyperliquid as margin. */
export const KEEP_ON_NEAR = 10_000_000n;
/** Hyperliquid opens an address on a first deposit of at least $10 (INTERFACES.md 8). */
export const FIRST_DEPOSIT_MIN = 10_000_000n;

export type RunStatus =
  | { kind: 'idle' }
  | { kind: 'running'; what: string; detail: string }
  | { kind: 'done'; what: string; detail?: string; hash?: string; /** A transaction on Aave's chain, for a link to its explorer. */ evmHash?: string }
  | { kind: 'failed'; what: string; why: string; logs?: string[] };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads until `ok` holds or `ms` runs out; null on time-out. Misses are retried. */
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms: number, every = 2_500): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const value = await read();
      if (ok(value)) return value;
    } catch {
      // a missed read: try again
    }
    await sleep(every);
  }
  return null;
}

class StepFailed extends Error {
  readonly logs: string[];
  constructor(message: string, logs: string[] = []) {
    super(message);
    this.logs = logs;
  }
}

const words = (error: unknown) => {
  if (error instanceof ApiError) return error.message;
  const text = error instanceof Error ? error.message : String(error);
  return /reject|cancel/i.test(text) ? 'Cancelled in the wallet' : text;
};

/** Margin to move: all the account's USDC but $10, and at least Hyperliquid's $10 first deposit. */
export function marginToMove(usdcUnits: bigint): bigint | null {
  const amount = usdcUnits - KEEP_ON_NEAR;
  return amount >= FIRST_DEPOSIT_MIN ? amount : usdcUnits >= FIRST_DEPOSIT_MIN ? usdcUnits : null;
}

interface Input {
  accountId: string | null;
  owner: string;
  name: string;
  /** The funding permission to sign with the opening, or null to open without one. */
  permission?: Permission | null;
  /** Stage 3: the client passed over "Get test collateral for Aave", so the demo run doesn't do it either. */
  skipTestCollateral?: boolean;
  reloadAccount: () => void;
  reloadHl: () => void;
  reloadLender?: () => void;
}

export function useSetupActions({ accountId, owner, name, permission, skipTestCollateral, reloadAccount, reloadHl, reloadLender }: Input) {
  const { sendTx, sendTxs, signMessage } = useNearWallet();
  const [status, setStatus] = useState<RunStatus>({ kind: 'idle' });
  const running = useRef(false);
  /** The step under way, so a failure names it. */
  const current = useRef('That step');

  const say = (what: string, detail: string) => {
    current.current = what;
    setStatus({ kind: 'running', what, detail });
  };
  const readAccount = (id: string) => api<AccountAnswer>(accountPath(id));
  const readHl = (id: string, fresh = false) => api<HlAnswer>(hlPath(id, fresh));

  const sent = (outcome: Outcome) => {
    const failure = txFailure(outcome);
    if (failure) throw new StepFailed(failure, txLogs(outcome));
    return txHash(outcome);
  };

  // ---------- the steps; each throws StepFailed (or a wallet error) and returns a done line ----------

  const steps = {
    async account(id: string) {
      say(
        'Opening your account',
        `Approve 6 NEAR in your wallet. About 4.7 NEAR stays with the account as its storage; if anything fails, the factory refunds it.${permission ? ' The same approval signs the lender permission.' : ''}`,
      );
      const hash = sent(await sendTx(createAccountTx(FactoryContract, name, owner, permission)));
      say('Opening your account', 'Waiting for it to appear…');
      if (!(await until(() => readAccount(id), (a) => Boolean(a.state), 60_000))) throw new StepFailed('The account didn’t appear within a minute. The transaction link says what happened.');
      reloadAccount();
      return { what: permission ? 'Your account is open, with the lender permission signed' : 'Your account is open', hash };
    },

    async collateral(id: string) {
      if (NetworkId !== 'testnet') throw new StepFailed('On mainnet, add collateral from the Add funds page.');
      const nbtc = Tokens.find((t) => t.symbol === 'nBTC')!;
      const usdc = Tokens.find((t) => t.symbol === 'USDC')!;
      say(
        'Adding test collateral',
        `Approve in your wallet: ${formatUnits(DEMO_NBTC_UNITS, nbtc.decimals)} test nBTC and ${formatUnits(DEMO_USDC_UNITS, usdc.decimals)} test USDC from the faucet, straight into your account.`,
      );
      const outcomes = await sendTxs([mintTx(nbtc.id, id, DEMO_NBTC_UNITS.toString()), mintTx(usdc.id, id, DEMO_USDC_UNITS.toString())]);
      const hashes = outcomes.map(sent);
      if (!(await until(() => readAccount(id), (a) => held(a, 'nBTC') > 0n, 30_000))) throw new StepFailed('The tokens didn’t show in the account within 30 seconds.');
      reloadAccount();
      return { what: 'Test collateral added', hash: hashes[0] };
    },

    async address(id: string) {
      say('Creating the Hyperliquid address', 'Approve in your wallet. NEAR’s Chain Signatures derive an address that no person holds a key to.');
      const hash = sent(await sendTx(hlInitTx(id)));
      if (!(await until(() => readHl(id), (h) => Boolean(h.address), 30_000))) throw new StepFailed('The address didn’t appear within 30 seconds.');
      reloadHl();
      return { what: 'Hyperliquid address created', hash };
    },

    async margin(id: string, amountUnits?: bigint) {
      const account = await readAccount(id);
      if (account.state && loanOpen(account.state.loan)) throw new StepFailed('With a loan open, moving USDC needs a check first: use Move to Hyperliquid on the Home page.');
      const amount = amountUnits ?? marginToMove(held(account, 'USDC'));
      if (amount === null) throw new StepFailed('The account needs at least 10 USDC to open its Hyperliquid address. Add some first.');
      say('Moving USDC to Hyperliquid', 'Getting a price from 1Click…');
      const quote = await quoteMove({ dry: false, move: 'to_hl', account: id, amount: amount.toString() });
      const next = quote.move.next;
      const address = quote.quote.depositAddress;
      if (next?.method !== 'withdraw' || !address) throw new StepFailed('1Click gave no deposit address for this move. Try again in a minute.');
      say('Moving USDC to Hyperliquid', `Approve in your wallet: ${quote.quote.amountInFormatted} USDC goes to 1Click, which delivers it to the account’s Hyperliquid address.`);
      const hash = sent(await sendTx(withdrawTx(id, next.args.token, next.args.amount, next.args.receiver, next.args.transfer)));
      say('Moving USDC to Hyperliquid', `1Click is delivering it: about ${quote.quote.timeEstimate} seconds.`);
      const ends = { to: 'the Hyperliquid address', refundTo: 'the account' };
      const final = await until(() => api<StatusAnswer>(statusPath(address, quote.quote.depositMemo)), (s) => swapStatusWords(s.status, ends).done, 180_000, 4_000);
      if (!final) throw new StepFailed('1Click hasn’t finished after three minutes. The Risk page shows the transfer while it’s under way.');
      if (final.status !== 'SUCCESS') throw new StepFailed(`1Click didn’t deliver: ${swapStatusWords(final.status, ends).words}`);
      if (!(await until(() => readHl(id), (h) => hlFunded(h.hyperliquid), 60_000))) throw new StepFailed('1Click says delivered, but Hyperliquid doesn’t show the USDC yet. Give it a minute.');
      reloadHl();
      return { what: `${quote.quote.amountOutFormatted} USDC is on Hyperliquid`, hash };
    },

    async agent(id: string) {
      say('Connecting the trading agent', 'Approve 0.01 NEAR in your wallet. The order gateway, in a sealed computer, names the one key that may trade for this account.');
      const hash = sent(await sendTx(requestAgentTx(id)));
      if (!(await until(() => readHl(id), (h) => Boolean(h.hl?.agent), 240_000))) throw new StepFailed('The gateway didn’t name an agent within 4 minutes. The transaction’s log says why.');
      reloadHl();
      return { what: 'Trading agent connected', hash };
    },

    async approve(id: string) {
      const before = await readHl(id);
      const after = lastSignedIndex(before.hl);
      say('Approving the agent on Hyperliquid', 'Approve in your wallet. Chain Signatures then sign Hyperliquid’s approval: usually 8 to 20 seconds.');
      const outcome = await sendTx(hlApproveAgentTx(id));
      const hash = sent(outcome);
      let index = signedIndexFromLogs(txLogs(outcome), 'approveAgent');
      if (index === null) {
        const found = await until(() => readHl(id), (h) => newSignedEntry(h.hl, 'approveAgent', after) !== null, 60_000);
        index = found ? newSignedEntry(found.hl, 'approveAgent', after)!.index : null;
      }
      if (index === null) throw new StepFailed('No signed approval appeared. The signer may have timed out; try again.', txLogs(outcome));
      say('Approving the agent on Hyperliquid', 'Posting the signed approval to Hyperliquid…');
      const answer = await submitSigned(id, index);
      if (!answer.ok) throw new StepFailed(submitWords(answer));
      if (!(await until(() => readHl(id, true), (h) => agentApproved(h).approved === true, 30_000))) throw new StepFailed('Hyperliquid accepted the approval but doesn’t list the agent yet. Give it a minute.');
      reloadHl();
      return { what: 'Agent approved', hash };
    },

    async short(id: string) {
      // INTERFACES.md 42: the band of this account's own gateway, which is the one that judges the order.
      const [markets, account, hl] = await Promise.all([api<MarketsAnswer>(marketsPath(id)), readAccount(id), readHl(id)]);
      const fetchedAt = Date.now();
      const coin = markets.coins.find((c) => c.coin === 'BTC');
      const listed = coin?.testnet && !coin.testnet.delisted ? coin.testnet : null;
      if (!coin || !listed) throw new StepFailed('BTC isn’t listed on Hyperliquid testnet right now.');
      const oracle = Number(listed.oracle_px ?? NaN);
      const reference = Number.isFinite(oracle) ? oracle : Number(listed.mark_px ?? NaN);
      const units = held(account, 'nBTC');
      if (units === 0n || !Number.isFinite(reference)) throw new StepFailed('Nothing to hedge yet: the account holds no nBTC.');
      // INTERFACES.md 50.4: an order Hyperliquid can't take now isn't signed.
      const stopped = notTradingWords('BTC', coinTradingNow(coin, NetworkId === 'testnet'), 'coin');
      if (stopped) throw new StepFailed(`${stopped.replace(' Pick another coin, or try BTC again later.', '')} Nothing was signed. Try again later, or hedge another coin on the Basis trade tab.`);
      // Sell as much BTC as the account holds nBTC, at a limit below the reference (lib/hl-reach.ts, ownOrderBp), now or never.
      const target = decFromNumber(reference * (1 - ownOrderBp(coin.band_bp) / 10_000));
      if (!target) throw new StepFailed('No price to sell at.');
      const rounded = roundOrder({ size: formatUnits(units, 8), price: decText(roundPrice(target, listed.sz_decimals, 'up')), isBuy: false, szDecimals: listed.sz_decimals });
      if (rounded.problems.length) throw new StepFailed(rounded.problems.join(' '));
      const order = { coin: 'BTC', is_buy: false, sz: rounded.sz, limit_px: rounded.limitPx, reduce_only: false, tif: 'Ioc' as const };
      // INTERFACES.md 50.4: signed for as long as this account's own gateway takes (the same markets answer says it).
      const life = orderLifeMs(markets);
      const message = orderMessage(id, order, expiryNow(hl.near_time_ms, fetchedAt, life));
      const nonce = randomNonce();
      say(`Opening the short: sell ${rounded.sz} BTC`, 'Approve in your wallet. It signs a message, with no fee.');
      const signed = await signMessage({ message, recipient: GATEWAY_RECIPIENT, nonce });
      say(`Opening the short: sell ${rounded.sz} BTC`, 'The risk engine checks the order, then places it on Hyperliquid…');
      // Past 30 seconds the line turns calm, and the step waits for as long as the order lives.
      const answer = await sendWithinLife({ send: () => sendOrder(id, toAuth(signed, message, nonce)), lifeMs: life, network: NetworkId, onCalm: (words) => say(`Opening the short: sell ${rounded.sz} BTC`, words) });
      const said = orderWords(answer);
      if (!answer.ok) throw new StepFailed(said.headline, said.lines);
      if (!(await until(() => readHl(id), (h) => (h.hyperliquid ? hlSummary(h.hyperliquid).positions.some((p) => p.side === 'short') : false), 30_000))) {
        throw new StepFailed(`${said.headline} But no short shows on Hyperliquid yet.`);
      }
      reloadHl();
      return { what: said.headline };
    },
  };

  /**
   * Stage 3, testnet (INTERFACES.md 33): test collateral for Aave at the account's address on Base Sepolia, and gas for
   * it. It stands in for the bitcoin's move, which is a later stage. The backend's gas wallet does it (POST
   * /api/evm/gas): Aave's faucet mints test WBTC when Aave's test pool has room for bitcoin, and otherwise the gas
   * wallet wraps some of its own test ETH. No wallet approval is needed.
   */
  const aave = async (id: string): Promise<{ what: string; hash?: string; evmHash?: string }> => {
    if (NetworkId !== 'testnet') throw new StepFailed('Test collateral exists on testnet only.');
    const [lender, terms, account] = await Promise.all([api<LenderAccountAnswer>(lenderPath(id)), api<LendersAnswer>(LENDERS_PATH).catch(() => null), readAccount(id)]);
    if (!lender.evm?.address) throw new StepFailed('The account has no address on Aave’s chain yet. It is the same as its Hyperliquid address: create that first, in the hedge step.');
    const choice = testCollateral(termsFor(terms?.lenders, 'aave', 'testnet')?.collateral_room, held(account, 'nBTC'));
    say('Getting test collateral for Aave', `Asking for ${choice.amount} and gas at the account’s address on ${EVM_CHAIN_NAME}. Your wallet has nothing to approve.`);
    const answer = await evmGas(id, choice.ask);
    // The backend waits up to 20 seconds for what it sent, and says when the chain mined it and it failed there.
    if ((answer.mint ?? answer.wrap)?.ok === false) throw new StepFailed(`${EVM_CHAIN_NAME} mined the test collateral’s transaction, but it failed there, so nothing arrived. Try again.`);
    say('Getting test collateral for Aave', `It is on its way. Waiting for it to show at the address on ${EVM_CHAIN_NAME}…`);
    if (!(await until(() => api<LenderAccountAnswer>(lenderPath(id)), (l) => collateralAt(l.evm).length > 0, 120_000))) {
      throw new StepFailed('The test collateral didn’t show at the address within two minutes. The link on the address card says what happened.');
    }
    reloadLender?.();
    return { what: `${choice.amount} is at the account’s address on ${EVM_CHAIN_NAME}`, evmHash: answer.mint?.hash ?? answer.wrap?.hash ?? answer.eth.hash ?? undefined };
  };

  type Key = keyof typeof steps | 'aave';

  /** Runs one step, saying how it went. Returns whether it worked. */
  const runStep = async (key: Key, amountUnits?: bigint): Promise<boolean> => {
    if (!accountId) return false;
    current.current = 'That step';
    try {
      const result: { what: string; hash?: string; evmHash?: string } =
        key === 'aave' ? await aave(accountId) : key === 'margin' ? await steps.margin(accountId, amountUnits) : await steps[key](accountId);
      setStatus({ kind: 'done', what: result.what, hash: result.hash, evmHash: result.evmHash });
      return true;
    } catch (error) {
      setStatus({ kind: 'failed', what: current.current, why: words(error), logs: error instanceof StepFailed ? error.logs : undefined });
      return false;
    }
  };

  /** "Set up the demo for me": every step left before the borrow, in order, from fresh reads each time. */
  const runAll = async () => {
    if (!accountId || running.current) return;
    running.current = true;
    try {
      for (let guard = 0; guard < 10; guard++) {
        let account: AccountAnswer;
        try {
          account = await readAccount(accountId);
        } catch (error) {
          setStatus({ kind: 'failed', what: 'Reading your account', why: words(error) });
          return;
        }
        const hl = account.state ? await readHl(accountId).catch(() => undefined) : undefined;
        // Stage 3: an account whose config has Aave gets test collateral for it on testnet, after the hedge.
        const lender = account.state ? await api<LenderAccountAnswer>(lenderPath(accountId)).catch(() => undefined) : undefined;
        const helperOn = lender && NetworkId === 'testnet' ? await api<EvmGasInfo>(EVM_GAS_PATH).then((g) => g.on, () => undefined) : undefined;
        const view = setupView({ signedIn: true, account, hl, testCollateral: testCollateralStep({ testnet: NetworkId === 'testnet', lender, skipped: Boolean(skipTestCollateral), helperOn }) });
        let key: Key | null = null;
        if (view.next === 'account') key = 'account';
        else if (view.next === 'collateral') key = 'collateral';
        else if (view.next === 'aave') key = 'aave';
        else if (view.next === 'hedge') {
          if (view.hedge === 'unavailable') {
            setStatus({ kind: 'failed', what: 'Hedging', why: 'This account was made before trading existed, so it can’t hedge. Open a new account under another name.' });
            return;
          }
          key = view.hedge === 'done' ? null : view.hedge;
        }
        if (!key) {
          setStatus({ kind: 'done', what: view.next === 'borrow' ? 'Ready to borrow' : 'All set', detail: view.next === 'borrow' ? 'Pick an amount below.' : undefined });
          return;
        }
        if (!(await runStep(key))) return;
      }
    } finally {
      running.current = false;
    }
  };

  const busy = status.kind === 'running';
  return { status, runStep, runAll, busy, clear: () => setStatus({ kind: 'idle' }) };
}
