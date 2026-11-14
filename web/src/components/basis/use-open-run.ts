'use client';
// Opening a basis trade in one run (INTERFACES.md 49.1, point 5). One button starts it; before each step the account
// is read again and the next step is whatever the chain and Hyperliquid show is still missing (lib/basis.ts,
// `openSteps`), so a reload or a failure goes on from the right place. Each wallet approval is said before the wallet
// opens. The run stops at the loan, whose amount is the client's to pick.
//
// The steps that the demo setup already runs (open the account, the Hyperliquid address, the margin, the agent and its
// approval, test collateral for Aave, and the BTC short) are its own, imported from components/home/setup-actions.ts:
// they are the ones the user's click-through of 13 Nov proved. Two are this page's: adding the collateral in the size
// picked, and the short of a coin other than BTC.
//
// INTERFACES.md 51.14: a trade added on top of what the account already has runs the same steps with a `base`, where
// the account stood when it was started. It adds only the new coin, moves only the margin the bigger short needs,
// and sells only the new size: this page's own short does that for every coin, bitcoin too.
import { useRef, useState } from 'react';

import { useSetupActions } from '@/components/home/setup-actions';
import { failedPhase, sleep, StepFailed, until, type RunPhase } from '@/components/basis/parts';
import { NetworkId } from '@/config';
import type { ClientAccount } from '@/hooks/use-client-account';
import { accountPath, api, EVM_GAS_PATH, hlPath, lenderPath, marketsPath, sendOrder, type AccountAnswer, type EvmGasInfo, type LenderAccountAnswer, type MarketsAnswer } from '@/lib/api';
import {
  collateralPlan,
  marginToAdd,
  marginToMove,
  openApproval,
  openSteps,
  openTitle,
  shortAdded,
  shortTarget,
  shortUnitsOf,
  TESTNET_MARGIN_MAX,
  valueMicro,
  DEFAULT_VALUE_USD,
  type BasisOption,
  type OpenKey,
  type TradeBase,
} from '@/lib/basis';
import { expiryNow, GATEWAY_RECIPIENT, orderLifeMs, orderMessage, orderWords, randomNonce, toAuth } from '@/lib/gateway';
import { coinTradingNow, notTradingWords, ownOrderBp } from '@/lib/hl-reach';
import { sendWithinLife } from '@/lib/order-life';
import { hlSummary, loanOpen, type HlAnswer } from '@/lib/hl';
import { decFromNumber, decText, roundOrder, roundPrice } from '@/lib/hl-rules';
import { pendingTransfers } from '@/lib/risk';
import { held } from '@/lib/setup';
import { mintTx, txFailure, txLogs } from '@/lib/tx';
import type { Permission } from '@/lib/types';
import { formatUnits, formatUsd } from '@/lib/units';
import { useNearWallet } from '@/providers/near-provider';

interface Input {
  client: ClientAccount;
  token: BasisOption | null;
  /** The size picked, in the token's units; null when the field doesn't hold one. */
  sizeUnits: bigint | null;
  usdcId: string | null;
  permission: Permission | null;
  reloadAll: () => void;
  reloadHl: () => void;
  reloadLender: () => void;
  /**
   * INTERFACES.md 51.2: the Aave step offers the client's own ETH beside the faucet's test collateral, so the run stops
   * there for the client to choose, as it stops at the loan. `start({ faucet: true })` goes on with the faucet.
   */
  ownEther?: boolean;
  /** The client passed the Aave step over. */
  skipAave?: boolean;
  /** INTERFACES.md 51.14: a trade started on top of what the account had, to go on with. `start({ base })` starts one. */
  base?: TradeBase | null;
}

/** What Hyperliquid holds for the account, in micro-USD: 0 before it has an address there. */
const equityOf = (hl: HlAnswer | undefined): bigint => BigInt(Math.max(0, Math.round((hl?.hyperliquid ? (hlSummary(hl.hyperliquid).equity ?? 0) : 0) * 1e6)));

/** The steps the demo setup runs under the same names. */
const SETUP_STEPS = ['account', 'address', 'margin', 'agent', 'approve', 'aave'] as const;
type SetupStep = (typeof SETUP_STEPS)[number];
const isSetupStep = (key: OpenKey): key is SetupStep => (SETUP_STEPS as readonly string[]).includes(key);

export function useOpenRun({ client, token, sizeUnits, usdcId, permission, reloadAll, reloadHl, reloadLender, ownEther, skipAave, base: startedBase }: Input) {
  const { sendTxs, signMessage } = useNearWallet();
  const actions = useSetupActions({ accountId: client.accountId, owner: client.owner, name: client.name, permission, reloadAccount: client.reload, reloadHl, reloadLender });
  const [phase, setPhase] = useState<RunPhase>({ kind: 'idle' });
  /** The step under way is one of the demo setup's: its own status has the live line, and the reason if it fails. */
  const [fromSetup, setFromSetup] = useState(false);
  /** The step the run is on, by its own fresh read: the rail follows it while the page's own reads catch up. */
  const [at, setAt] = useState<OpenKey | null>(null);
  const running = useRef(false);
  const testnet = NetworkId === 'testnet';

  const readAccount = (id: string) => api<AccountAnswer>(accountPath(id));
  const readHl = (id: string) => api<HlAnswer>(hlPath(id));

  /** Adds the coin and the margin, on testnet as test tokens from the faucet, in one approval where the wallet can. */
  const collateral = async (id: string, picked: BasisOption, account: AccountAnswer, hl: HlAnswer | undefined, announce: (words: string | null, detail: string) => void, base: TradeBase | null) => {
    if (!testnet) throw new StepFailed('On mainnet the collateral comes from your own wallet.', [], { happened: `Your account needs ${picked.coin} and USDC first.`, todo: 'Add them on the Add funds page, then come back and press the button again.' });
    if (!usdcId) throw new StepFailed('The page has no USDC token to add.');
    const heldUnits = held(account, picked.symbol);
    // An added trade brings the coin up to what the account had and the new size; the margin is for the whole short.
    const size = base ? base.heldUnits + base.sizeUnits : (sizeUnits ?? heldUnits);
    const value = valueMicro(base ? shortTarget(base) : size, picked.decimals, picked.price) ?? BigInt(DEFAULT_VALUE_USD) * 1_000_000n;
    const plan = collateralPlan({ sizeUnits: size, heldUnits, usdcHeld: held(account, 'USDC'), value, hlEquity: equityOf(hl) });
    const txs = [...(plan.coin > 0n ? [mintTx(picked.id, id, plan.coin.toString())] : []), ...(plan.usdc > 0n ? [mintTx(usdcId, id, plan.usdc.toString())] : [])];
    if (txs.length === 0) throw new StepFailed('Enter a size above 0.', [], { happened: 'The size is empty.', todo: 'Enter how much to hold, then press the button again.' });
    announce(
      openApproval('collateral', picked.coin, {
        coin: plan.coin > 0n ? `${formatUnits(plan.coin, picked.decimals)} ${picked.coin}` : undefined,
        usdc: plan.usdc > 0n ? `${formatUnits(plan.usdc, 6)} USDC` : undefined,
      }),
      'Waiting for your wallet…',
    );
    const outcomes = await sendTxs(txs);
    for (const outcome of outcomes) {
      const failure = txFailure(outcome);
      if (failure) throw new StepFailed(failure, txLogs(outcome));
    }
    announce(null, 'Waiting for the tokens to show in your account…');
    const wanted = heldUnits + plan.coin;
    if (!(await until(() => readAccount(id), (a) => held(a, picked.symbol) >= wanted && held(a, 'USDC') >= held(account, 'USDC') + plan.usdc, 40_000))) {
      throw new StepFailed('The tokens didn’t show in the account within 40 seconds.');
    }
  };

  /** The short, for a coin other than BTC: as much of the coin as the account holds of its token, filled now or not at all. */
  const short = async (id: string, picked: BasisOption, account: AccountAnswer, announce: (words: string | null, detail: string) => void, base: TradeBase | null) => {
    const [markets, hl] = await Promise.all([api<MarketsAnswer>(marketsPath(id)), readHl(id)]);
    const fetchedAt = Date.now();
    const coin = markets.coins.find((c) => c.coin === picked.coin);
    const listed = coin?.testnet && !coin.testnet.delisted ? coin.testnet : null;
    if (!coin || !listed) throw new StepFailed(`${picked.coin} isn’t listed on Hyperliquid right now.`);
    const oracle = Number(listed.oracle_px ?? NaN);
    const reference = Number.isFinite(oracle) ? oracle : Number(listed.mark_px ?? NaN);
    // An added trade sells only what is still missing of the bigger short; a first trade, all the account holds.
    const shortNow = shortUnitsOf(hl, picked.coin, picked.decimals);
    const units = base ? (shortTarget(base) > shortNow ? shortTarget(base) - shortNow : 0n) : held(account, picked.symbol);
    if (units === 0n || !Number.isFinite(reference)) throw new StepFailed(base ? `The ${picked.coin} short is already as big as this trade makes it.` : `Nothing to hedge yet: the account holds no ${picked.coin}.`);
    // INTERFACES.md 50.4: an order Hyperliquid can't take now isn't signed. The page's own read may be half a minute old; this one is fresh.
    const stopped = notTradingWords(picked.coin, coinTradingNow(coin, testnet), 'coin');
    if (stopped) throw new StepFailed(stopped, [], { happened: stopped, todo: 'Nothing was signed or sent. What is in your account stays there.' });
    // A limit below the reference (lib/hl-reach.ts, ownOrderBp): it fills at once, and stays inside the band.
    const target = decFromNumber(reference * (1 - ownOrderBp(coin.band_bp) / 10_000));
    if (!target) throw new StepFailed('No price to sell at.');
    const rounded = roundOrder({ size: formatUnits(units, picked.decimals), price: decText(roundPrice(target, listed.sz_decimals, 'up')), isBuy: false, szDecimals: listed.sz_decimals });
    if (rounded.problems.length) throw new StepFailed(rounded.problems.join(' '));
    const order = { coin: picked.coin, is_buy: false, sz: rounded.sz, limit_px: rounded.limitPx, reduce_only: false, tif: 'Ioc' as const };
    // INTERFACES.md 50.4: signed for as long as this account's own gateway takes (the same markets answer says it).
    const life = orderLifeMs(markets);
    const message = orderMessage(id, order, expiryNow(hl.near_time_ms, fetchedAt, life));
    const nonce = randomNonce();
    announce(openApproval('short', picked.coin, { size: `${rounded.sz} ${picked.coin}` }), 'Waiting for your wallet…');
    const signed = await signMessage({ message, recipient: GATEWAY_RECIPIENT, nonce });
    announce(null, 'The risk engine checks the order, then places it on Hyperliquid…');
    // Past 30 seconds the line turns calm, and the step waits for as long as the order lives.
    const answer = await sendWithinLife({ send: () => sendOrder(id, toAuth(signed, message, nonce)), lifeMs: life, network: testnet ? 'testnet' : 'mainnet', onCalm: (words) => announce(null, words) });
    const said = orderWords(answer);
    if (!answer.ok) throw new StepFailed(said.headline, said.lines);
    const there = (h: HlAnswer) => (base ? shortAdded(base, shortUnitsOf(h, picked.coin, picked.decimals)) : h.hyperliquid ? hlSummary(h.hyperliquid).positions.some((p) => p.coin === picked.coin && p.side === 'short') : false);
    if (!(await until(() => readHl(id), there, 40_000))) {
      throw new StepFailed(`${said.headline} But no short shows on Hyperliquid yet.`);
    }
  };

  /** Runs every step that is left before the loan, in order, each from a fresh read of the account. */
  const start = async (opts: { faucet?: boolean; base?: TradeBase | null } = {}) => {
    const id = client.accountId;
    if (!id || !token || running.current) return;
    running.current = true;
    const picked = token;
    // The trade this run is for: one just started on top of what the account has, one started before, or a first trade.
    const found = opts.base !== undefined ? opts.base : (startedBase ?? null);
    const base = found && found.symbol === picked.symbol ? found : null;
    let title = 'Reading your account';
    try {
      for (let guard = 0; guard < 14; guard++) {
        setFromSetup(false);
        if (guard === 0) setPhase({ kind: 'running', title, announce: null, detail: 'Reading your account…' });
        const account = await readAccount(id);
        const hl = account.state ? await readHl(id) : undefined;
        const lender = account.state ? await api<LenderAccountAnswer>(lenderPath(id)).catch(() => undefined) : undefined;
        const helperOn = lender && testnet && (lender.config_lenders ?? []).includes('aave') ? await api<EvmGasInfo>(EVM_GAS_PATH).then((g) => g.on, () => undefined) : undefined;
        // The size the trade is, or will be: what the account holds of the coin, else the size picked. For an added
        // trade, the whole short once it is open: the margin has to carry all of it.
        const sized = base ? shortTarget(base) : held(account, picked.symbol) > 0n ? held(account, picked.symbol) : sizeUnits;
        const view = openSteps({ token: picked, account, hl, lender, testnet, helperOn, nowMs: Date.now(), value: sized ? valueMicro(sized, picked.decimals, picked.price) : null, skipAave, base });
        if (view.blocked) throw new StepFailed(view.blocked, [], { happened: 'This account can’t hedge.', todo: 'It was made before trading existed. Open a new account under another name.' });
        const key = view.next;
        // The loan is the client's own decision: the page stops here, with an amount filled in.
        // And on an ETH trade so is the collateral for Aave: the client's own ETH, the faucet's, or none.
        if (key === null || key === 'loan' || (key === 'aave' && ownEther && !opts.faucet)) {
          setPhase({ kind: 'idle' });
          reloadAll();
          return;
        }
        title = openTitle(key, picked.coin);
        setAt(key);
        const announce = (words: string | null, detail: string) => setPhase({ kind: 'running', title, announce: words, detail });

        if (view.waiting) {
          // Margin that is already on its way is waited for, never sent again.
          announce(null, 'The USDC is on its way to Hyperliquid. This takes a minute or two.');
          if (!(await until(() => readAccount(id), (a) => !pendingTransfers(a.state?.pending).some((t) => t.kind === 'to_hl'), 5 * 60_000, 4_000))) throw new StepFailed('The USDC hasn’t arrived on Hyperliquid after five minutes: it is still on its way.');
          reloadAll();
          continue;
        }

        // An added trade whose margin has to move while our pool is owed: that move needs a risk check first, which
        // the page's "Move USDC to Hyperliquid" box runs. The run stops here for it, and goes on once the margin is there.
        if (key === 'margin' && base && account.state && loanOpen(account.state.loan)) {
          setPhase({ kind: 'idle' });
          reloadAll();
          return;
        }
        if (key === 'collateral') await collateral(id, picked, account, hl, announce, base);
        else if (key === 'short' && (base || !(picked.coin === 'BTC' && picked.symbol === 'nBTC'))) await short(id, picked, account, announce, base);
        else {
          // One of the demo setup's own steps. It says how it is going in its own status, which the page shows.
          // An added trade moves only the margin the bigger short still needs; a first trade, all it added but $10.
          const margin = key !== 'margin' ? null : base && sized ? marginToAdd({ totalValue: valueMicro(sized, picked.decimals, picked.price) ?? 0n, hlEquity: equityOf(hl), usdcHeld: held(account, 'USDC') }) : marginToMove(held(account, 'USDC'));
          if (key === 'margin' && base && margin === null) throw new StepFailed('The account holds under $10 of USDC, too little to move as margin.', [], { happened: 'There is no USDC in the account for the margin.', todo: 'Deposit USDC on the Deposit & withdraw tab, then press the button again.' });
          if (key === 'margin' && base && testnet && margin !== null && margin > TESTNET_MARGIN_MAX) {
            throw new StepFailed('This trade needs more margin than testnet can carry.', [], { happened: `The short would need ${formatUsd(margin)} more margin on Hyperliquid, and on testnet one move is $500 at most.`, todo: 'Nothing was moved. Close everything below, or open a smaller trade.' });
          }
          const size = key === 'short' ? `${formatUnits(held(account, picked.symbol), picked.decimals)} ${picked.coin}` : undefined;
          announce(openApproval(key, picked.coin, { margin: margin ? `${formatUsd(margin)} of USDC` : undefined, size, permission: Boolean(permission) }, testnet), 'Waiting for your wallet…');
          setFromSetup(true);
          const ok = await actions.runStep(isSetupStep(key) ? key : 'short', key === 'margin' && base && margin !== null ? margin : undefined);
          if (!ok) {
            // The reason is in the demo setup's own status; the page reads it from there.
            setPhase({ kind: 'failed', title, raw: '', logs: [] });
            return;
          }
          setFromSetup(false);
        }
        reloadAll();
        // The backend's next read of the chain may trail the wallet's by a moment.
        await sleep(600);
      }
      throw new StepFailed('The steps kept coming back.');
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setFromSetup(false);
      setPhase(failedPhase(title, /reject|cancel/i.test(text) && !(error instanceof StepFailed) ? new StepFailed('Cancelled in the wallet') : error));
    } finally {
      running.current = false;
      setAt(null);
    }
  };

  // What the page shows: the demo setup's own words while one of its steps runs, and its reason when one fails.
  const setup = actions.status;
  let shown: RunPhase = phase;
  // Once the wallet has approved and the step is waiting for its effect, the line about the approval has had its say.
  const approved = (detail: string) => /^waiting for it|delivering|posting|checks the order|on its way/i.test(detail);
  if (fromSetup && phase.kind === 'running' && setup.kind === 'running') shown = { ...phase, announce: approved(setup.detail) ? null : phase.announce, detail: setup.detail };
  if (fromSetup && phase.kind === 'failed' && setup.kind === 'failed') shown = { ...phase, raw: setup.why, logs: setup.logs ?? [] };

  return { phase: shown, at, start, busy: phase.kind === 'running' };
}
