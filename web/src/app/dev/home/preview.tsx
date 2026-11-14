'use client';
// Development only: the Home cockpit in a chosen state, from sample data, with a wallet that sends nothing. It lets the
// redesign be checked (and shown) without a testnet account in that state. page.tsx refuses it in production.
// Phase 6 adds the lender cards and the borrow panel's "Where it comes from" (the `lender…` states), and a credit
// check's answer with "How this loan would be funded" (the `funding…` states). Stage 2 adds an account that borrows
// from Rhea (states.ts, RHEA_STATES), with a stand-in keeper that runs a loan's steps, the Account page with the
// permission, and the Book page with its pricing.
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { AccountView } from '@/app/account/account-view';
import { BookView } from '@/app/book/book-view';
import { CreditResultView } from '@/app/credit-check/credit-check-view';
import { BorrowView } from '@/app/borrow/borrow-view';
import { DepositView } from '@/app/deposit/deposit-view';
import { Cockpit } from '@/components/home/cockpit';
import { marketsPath, type LenderAccountAnswer, type LenderPosition, type MarketsAnswer, type Pricing, type PricingAnswer, type PricingTarget, type PricingView } from '@/lib/api';
import { rememberMove } from '@/lib/moves';
import type { EvmSignedEntry, FundingState, FundingStep, Permission } from '@/lib/types';
import { NearContext, type NearContextValue } from '@/providers/near-provider';
import { SESSION_OFF, SessionContext } from '@/providers/session-provider';

import { aaveAccountSample, aavePlanSample, AAVE_USDC, collateralRoom, ETH_USD, ownEvmSample, tokenMicro } from './aave-samples';
import { evmSignedLog, gasEvm, mineEvm, signEvm, stopEvm, submitEvm } from './aave-standin';
import { depositOnNear, minedForHome, moveDeadline, moveDelivered, moveQuote, movesNamed, moveStatus, seedMove, signedForHome, stopMoves } from './moves-standin';
import { BTC_USD, creditSample, fundingPlanSample, lenderAccountSample, lendersSample, METH_ID, NBTC_ID, nbtcMicro, POOL_RATE_BP, pricingSample, rheaPlanSample, rheaPosition } from './samples';
import { aaveSampleOf, isAaveState, isAccountState, isBookState, isFundingState, isLenderState, isMoveState, isPauseState, isRheaState, STATES, type PreviewState } from './states';

const OWNER = 'alice.testnet';
const OPERATOR = 'pbf-ops.testnet';
const ACCOUNT = 'alice.pbf.testnet';
const BTC = BTC_USD;
const usd = (dollars: number) => String(Math.round(dollars * 1_000_000));
/** The sample account's credit line. With the $800 loan it can still borrow $304.60. */
const LINE = 1_104_600_000n;

/** When the sample was opened: its pause counts from here. */
const SAMPLE_NOW = Date.now();
/** State `paused-new`: how many checks the sample has answered. The second one finds the transfer sent. */
let pauseChecks = 0;

/** The account each state starts from: none, collateral only, hedged, with a loan, or in a margin call. */
type Base = 'new' | 'setup' | 'ready' | 'loan' | 'call';

function baseOf(asked: PreviewState): Base {
  if (asked === 'account-new') return 'new';
  // The pause after a transfer out of Hyperliquid: hedged and ready, so the loan is the next thing to do.
  if (isPauseState(asked) || asked === 'aave-eth') return 'ready';
  // `credit` and `leave` owe Rhea alone: the pool owes a credit only once its own part of the loan is paid off.
  if (asked === 'fund' || asked === 'plan' || asked === 'plan-expired' || asked === 'credit' || asked === 'leave') return 'ready';
  // Stage 3: `three` has a loan from our pool as well; the other Aave states are hedged and ready. Stage 4's states
  // with a move under way are the `three` account.
  if (isMoveState(asked)) return 'loan';
  if (isAaveState(asked)) return asked === 'three' ? 'loan' : 'ready';
  if (isLenderState(asked) || isRheaState(asked) || isBookState(asked) || isFundingState(asked)) return 'loan';
  return asked;
}

function verdict(over: Record<string, unknown> = {}) {
  return {
    ok: true, v: 1, model: 'B-0.2', params: 'p', acct: ACCOUNT, blk: 999_950, nonce: 7,
    eq: 778_000_000, eq_allow: 778_000_000, mm: 178_000_000, im: 222_000_000, state: 'HEALTHY', action: 'NONE', since: 0,
    score: 700, tier: 'STANDARD', rate_bp: 200, allow: { withdraw: 0, borrow: 304_600_000 }, credit: { line: Number(LINE), binding: 'C4' },
    volf_bp: 10_000, top: ['nBTC depeg 20%', 'replay 13 Mar 2020 rebound', 'ADL BTC 2/3S then 2/3S'], topup: 0,
    pool: { hold: { nBTC: 1_140_000_000 } }, coins: { uncertain: [], stale: [], reduce_only: [] },
    ...over,
  };
}

const borrowerSample = (debt: string) => ({
  created_at: '0', first_week_until: '0', debt, tier: 'STANDARD', history_tier: null, last_upgrade_at: null, kyb_entity: null, tier_override: null, blocked: false,
  hl_address: null, steps_24h: '0', shares_bp: {}, hold: {}, hl_eq: '0',
});

function fixtures(asked: PreviewState) {
  // The lender states are the account with a loan, plus a position at a lender and the pool at FUNDING.md's 6.50%.
  const aaveSample = aaveSampleOf(asked);
  const withLender = isLenderState(asked) || isRheaState(asked) || aaveSample ? asked : null;
  // Stage 3's states have both lenders in the account's config, and an address on Base Sepolia.
  const lender = aaveSample ? aaveAccountSample(ACCOUNT, aaveSample) : lenderAccountSample(ACCOUNT, isLenderState(asked) || isRheaState(asked) ? asked : null);
  // A borrow at Aave that is signed and not yet mined is listed as pending from the moment it is signed.
  const signedBorrow = (lender.evm?.signed ?? []).find((e) => e.kind === 'borrow' && e.status !== 'mined');
  const state = baseOf(asked);
  const exists = state !== 'new';
  // Stage 2's accounts have part of their 0.015 nBTC posted with Rhea, and those with a loan have USDC to repay with.
  const atRhea = lender.lenders.find((p) => p.l === 'rhea');
  // State `rhea-eth`: the account's coin is test ETH, part of it posted with Rhea, and it holds no bitcoin.
  const ethAtRhea = atRhea?.held?.[0]?.symbol === 'ETH';
  const nbtc = state === 'new' || ethAtRhea ? '0' : (1_500_000n - BigInt(atRhea?.held?.[0]?.amount ?? '0')).toString();
  const usdc = state === 'setup' ? '440000000' : atRhea && BigInt(atRhea.debt) > 0n ? '250000000' : '10000000';
  const loan = state === 'loan' || state === 'call' ? usd(800) : '0';
  const v =
    state === 'call'
      ? verdict({ eq: 160_000_000, state: 'MARGIN_CALL', allow: { withdraw: 0, borrow: 0 }, credit: { line: 800_000_000, binding: 'C1' }, top: ['nBTC depeg 35%', 'nBTC depeg 20%'] })
      : state === 'ready'
        ? verdict({
            // With a loan from a lender, the engine's equity is the loan state's.
            ...(lenderDebt(lender) === 0n && { eq: 1_578_000_000 }),
            allow: { withdraw: 0, borrow: Number(LINE) },
            ...(withLender && { rate_bp: POOL_RATE_BP, credit: { line: Number(LINE + lenderDebt(lender)), binding: 'C4' } }),
          })
        : state === 'loan'
          ? verdict(withLender ? { rate_bp: POOL_RATE_BP, credit: { line: Number(LINE + lenderDebt(lender)), binding: 'C4' } } : {})
          : null;
  const account = {
    account_id: ACCOUNT, block_height: 1_000_000, exists, has_contract: exists,
    state: exists
      ? {
          owner: OWNER, counter: 8, blocked: false, loan: { principal: loan, open: loan !== '0' },
          verdict: v ? { intent: { check: {} }, received_block: 999_960, verdict: v } : null,
          hl: {
            path: 'hyperliquid-1',
            address: '0x8c01b1a86db01769c246d3739da0bb74ae3217fb',
            // The pause: a transfer out signed an hour ago, which can be posted for two days. An account made after
            // the fix (INTERFACES.md 50.2) also lists it.
            send_open_until_ms: isPauseState(asked) ? String(SAMPLE_NOW - 3_600_000 + 2 * 86_400_000) : '0',
            ...(asked === 'paused-new' && { open_sends: [String(SAMPLE_NOW - 3_600_000)], send_floor_until_ms: '0' }),
          },
          pending: signedBorrow ? [{ lender: { lender: 'aave', kind: 'borrow', amount: signedBorrow.amount, token: AAVE_USDC.token, evm_nonce: signedBorrow.nonce } }] : [],
          // Accounts made before Phase 6 have neither field.
          ...(withLender && { permission: lender.permission, funding: lender.funding }),
          // Stage 3: the account's own list of what it signed for Aave's chain.
          ...(lender.evm && { evm: ownEvmSample(lender.evm) }),
        }
      : null,
    balances: [
      { token: 'musdc.pbf-ops.testnet', symbol: 'USDC', decimals: 6, amount: usdc },
      { token: NBTC_ID, symbol: 'nBTC', decimals: 8, amount: nbtc },
      ...(ethAtRhea || asked === 'aave-eth' ? [{ token: METH_ID, symbol: 'ETH', decimals: 18, amount: '354000000000000000' }] : []),
    ],
    debt: loan,
    borrower: exists ? borrowerSample(loan) : null,
    not_deployed: [],
  };
  const hedged = state === 'ready' || state === 'loan' || state === 'call';
  const hl = {
    account_id: ACCOUNT, owner: OWNER, block_height: 1_000_000, near_time_ms: Date.now(),
    hl: account.state?.hl ? { ...account.state.hl, agent: hedged ? { address: '0xa9e1', received_block: 1 } : null, signed: [] } : null,
    address: account.state?.hl?.address ?? null,
    gateway: { project_id: 'pbf-keeper.testnet/pb-gateway', version_key: null },
    hyperliquid: account.state?.hl?.address
      ? {
          clearinghouse_state: {
            marginSummary: { accountValue: hedged ? '428' : '0', totalNtlPos: hedged ? '1140' : '0', totalMarginUsed: hedged ? '228' : '0' },
            crossMarginSummary: { accountValue: hedged ? '428' : '0', totalNtlPos: hedged ? '1140' : '0', totalMarginUsed: hedged ? '228' : '0' },
            crossMaintenanceMarginUsed: hedged ? '57' : '0',
            withdrawable: hedged ? '200' : '0',
            assetPositions: hedged
              ? [{ position: { coin: 'BTC', szi: '-0.015', entryPx: '76000', positionValue: '1140', unrealizedPnl: '0', liquidationPx: '101000', leverage: { type: 'cross', value: 5 }, marginUsed: '228' } }]
              : [],
          },
          spot_usdc: null, abstraction: 'default', open_orders: [], fills: [],
          agents: hedged ? [{ name: 'pb', address: '0xa9e1', validUntil: null }] : [],
          errors: {},
        }
      : null,
  };
  const pricing = pricingSample(ACCOUNT);
  const pool = {
    pool_id: 'pool.pbf.testnet', deployed: true, block_height: 1_000_000,
    pool: {
      cash: usd(24_200), loans: usd(800), capital: usd(25_000), utilisation_bp: 320, rate_bp: withLender ? { preferred: POOL_RATE_BP - 100, standard: POOL_RATE_BP, watch: POOL_RATE_BP + 300 } : { preferred: 100, standard: 200, watch: 500 },
      interest_earned: '0', written_off: '0', funded: usd(25_000), defunded: '0', paused: false, lent_24h: '0', daily_budget: usd(2_500), daily_budget_bp: 1000,
      pending_budget: null, wrappers: {}, hyperliquid: { amount: '0', cap: usd(12_500) }, book: {},
    },
    params: {
      operator: OPERATOR, factory: 'pbf.testnet', token: 'musdc.pbf-ops.testnet',
      periods: { new_account_ns: '0', upgrade_ns: '0', budget_delay_ns: '0', window_ns: '0' },
      rates: { kink_bp: 8000, at_kink_bp: 600, at_full_bp: 5000, spread_bp: { preferred: 100, standard: 200, watch: 500 } },
      caps: {
        max_utilisation_bp: 9000, client_share_bp: 2500, new_account_limit: usd(2_500), ceiling: { preferred: usd(5_000_000), standard: usd(1_000_000), watch: usd(100_000) },
        cosign_borrow_above: usd(250_000), cosign_steps_above: usd(50_000), wrapper_cap_bp: {}, hl_cap_bp: 5000, book_cap: {},
      },
      daily_budget_bp: 1000, pending_budget: null, funding: pricing.funding,
    },
  };
  const now = Date.now();
  const activity = {
    account: ACCOUNT, read_at_ms: now, indexer: { host: '', docs: '' }, total: 4, listed: 4, detailed: 4, more: false, keeper_log: false, cached: false,
    items:
      state === 'loan' || state === 'call'
        ? [
            { at_ms: now - 4 * 60_000, block: 1, tx: '9xQp', ok: true, kind: 'borrow', by: OWNER, moves: [], detail: { amount: usd(800), debt: usd(800), tier: 'STANDARD' }, source: 'indexer' },
            { at_ms: now - 22 * 60_000, block: 1, tx: '7hKd', ok: true, kind: 'to_hl', by: OWNER, moves: [], detail: { token: 'musdc.pbf-ops.testnet', amount: '430000000' }, source: 'indexer' },
            { at_ms: now - 31 * 60_000, block: 1, tx: '5mTr', ok: true, kind: 'deposit', by: OWNER, moves: [{ token: NBTC_ID, amount: '1500000', other: OWNER }], detail: { token: NBTC_ID }, source: 'indexer' },
          ]
        : [],
  };
  return {
    // The factory's config names Rhea (stage 2), so opening an account offers the permission.
    '/api/config': {
      network: 'testnet', ids: { shim_float: 'float.pbf-ops.testnet' }, deployed: { 'pbf.testnet': true },
      factory_config: { lenders: { rhea: { contract_id: 'rhea.pbf-ops.testnet', collateral: [NBTC_ID] }, aave: null } }, preview_enabled: true,
    },
    [`/api/account/${ACCOUNT}`]: account,
    [`/api/hl/${ACCOUNT}`]: hl,
    '/api/pool': pool,
    '/api/markets': { network: 'testnet', hl_api: '', hl_error: null, params_hash: '', params_hash_pinned: null, params_hash_matches: null, pool_statuses: 'read', coins: [{ coin: 'BTC', allowed: true, tier: 1, band_bp: 200, universe_sz_decimals: 5, client_cap_usd: 0, testnet: { asset: 3, sz_decimals: 5, max_leverage: 40, delisted: false, mark_px: String(BTC), oracle_px: String(BTC), mid_px: String(BTC), day_ntl_vlm: '1', funding: '0.0000125' }, status: null }, { coin: 'ETH', allowed: true, tier: 1, band_bp: 200, universe_sz_decimals: 4, client_cap_usd: 0, testnet: { asset: 4, sz_decimals: 4, max_leverage: 25, delisted: false, mark_px: String(ETH_USD), oracle_px: String(ETH_USD), mid_px: String(ETH_USD), day_ntl_vlm: '1', funding: '0.0000125' }, status: null }] },
    [`/api/drill?account=${ACCOUNT}`]: { network: 'testnet', drill_id: 'drill.pbf-ops.testnet', deployed: true, block_height: 1, ratio: { bp: 10_000, set_at: '0' }, owner: null, faults_enabled: false, fault: null, fault_error: null, account_ratio: null },
    [`/api/activity/${ACCOUNT}`]: activity,
    // Phase 6 (INTERFACES.md 28). POST /api/funding-plan is answered in install(), from the amount asked.
    [`/api/lender/${ACCOUNT}`]: lender,
    // Stage 3: Aave's test pool for bitcoin is full, as on 11 Nov, except in the state that shows it with room.
    '/api/lenders': lendersSample(aaveSample ? collateralRoom(asked === 'aave-bitcoin') : undefined),
    // Stage 2: the pool's pricing for the Book page, which also reads the daily stress test.
    '/api/pricing': pricing,
    '/api/book-stress': { log_found: false, latest: null, last_result: null, history: [] },
  } as Record<string, unknown>;
}

type Data = Record<string, unknown>;
interface SampleState {
  owner: string;
  counter: number;
  blocked: boolean;
  loan: { principal: string; open: boolean };
  verdict: unknown;
  hl: unknown;
  pending: unknown[];
  permission?: Permission | null;
  permission_blk?: number;
  funding?: FundingState | null;
  evm?: { nonce: number; signed: EvmSignedEntry[]; approved?: string[] } | null;
}
interface SampleAccount {
  block_height: number;
  exists: boolean;
  has_contract: boolean;
  debt: string;
  balances: { symbol: string; amount: string }[];
  borrower: unknown;
  state: SampleState | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const outcome = (hash: string, logs: string[] = []) => ({ transaction: { hash }, status: { SuccessValue: '' }, receipts_outcome: logs.length ? [{ outcome: { logs, status: { SuccessValue: '' } } }] : [] });

/** The sample account and its lender answer, which the stand-ins change in place: the page's next read sees it. */
const accountOf = (data: Data) => data[`/api/account/${ACCOUNT}`] as SampleAccount;
const lenderOf = (data: Data) => data[`/api/lender/${ACCOUNT}`] as LenderAccountAnswer;

/** Adds `delta` units to one of the account's balances. */
function bump(account: SampleAccount, symbol: string, delta: bigint) {
  const balance = account.balances.find((b) => b.symbol === symbol);
  if (balance) balance.amount = (BigInt(balance.amount) + delta).toString();
}

/**
 * Changes the account's position at a lender: `posted`, `debt` and `deposit` are added, in micro-USD. A repayment
 * above the debt clears it, and Rhea keeps the rest as the account's plain deposit.
 */
function movePosition(data: Data, l: string, posted: bigint, debt: bigint, deposit = 0n) {
  const lender = lenderOf(data);
  const now = lender.lenders.find((p) => p.l === l);
  const nextPosted = BigInt(now?.posted ?? 0) + posted;
  const nextDebt = BigInt(now?.debt ?? 0) + debt;
  const over = nextDebt < 0n ? -nextDebt : 0n;
  const nextDeposit = BigInt(now?.deposit ?? '0') + deposit + over;
  let next: LenderPosition;
  if (l === 'rhea') next = rheaPosition(nextPosted > 0n ? nextPosted : 0n, nextDebt > 0n ? nextDebt : 0n, nextDeposit > 0n ? nextDeposit : 0n);
  else if (now) next = { ...now, posted: Number(nextPosted), debt: Number(nextDebt), hf_bp: nextDebt > 0n ? Number((nextPosted * BigInt(now.liq_bp)) / nextDebt) : 0 };
  else return;
  lender.lenders = [...lender.lenders.filter((p) => p.l !== l), next];
}

/** What the sample account owes its lenders, in micro-USD. */
const lenderDebt = (lender: LenderAccountAnswer): bigint => lender.lenders.reduce((sum, p) => sum + BigInt(p.debt), 0n);

/**
 * What the account can still borrow. The sample keeps it simple: $1,104.60 less what it owes our pool. A verdict's
 * credit line counts the whole debt, so the sample verdicts add the lenders' loans to the line.
 */
function canBorrow(data: Data): bigint {
  const owed = BigInt(accountOf(data).debt);
  return owed < LINE ? LINE - owed : 0n;
}

/** Where a loan of `amount` would come from, for the state's kind of account. */
function planFor(state: PreviewState, data: Data, amount: string) {
  if (isLenderState(state)) return fundingPlanSample(state, amount, canBorrow(data));
  const account = accountOf(data);
  if (aaveSampleOf(state)) {
    // Aave lends against what it holds, and against the collateral waiting at the address: ether or bitcoin.
    const lender = lenderOf(data);
    const aave = lender.lenders.find((p) => p.l === 'aave');
    const spare = (lender.evm?.wallet ?? []).find((t) => t.symbol !== 'USDC' && BigInt(t.amount) > 0n) ?? null;
    return aavePlanSample(amount, canBorrow(data), { posted: BigInt(aave?.posted ?? 0), owed: BigInt(aave?.debt ?? 0), spare });
  }
  const rhea = lenderOf(data).lenders.find((p) => p.l === 'rhea');
  const spare = nbtcMicro(BigInt(account.balances.find((b) => b.symbol === 'nBTC')?.amount ?? '0'));
  return rheaPlanSample(amount, canBorrow(data), { posted: BigInt(rhea?.posted ?? 0), owed: BigInt(rhea?.debt ?? 0), spare });
}

// ---------- stage 4: the moves between NEAR and Aave's chain ----------

/** The account's pending entry for a move, by its id. */
const transferId = (entry: unknown): string | undefined => (entry as { transfer?: { id?: string } } | null)?.transfer?.id;

/** A move to Aave's chain is delivered: the tokens show at the address. The account keeps it listed until a check. */
function arriveAtAddress(data: Data, delivers: { token: string; amount: string }) {
  const held = lenderOf(data).evm?.wallet.find((t) => t.token.toLowerCase() === delivers.token.toLowerCase());
  if (held) held.amount = (BigInt(held.amount) + BigInt(delivers.amount)).toString();
}

/** A move home is delivered: the tokens land in the account on NEAR, which settles the transfer by itself. */
function arriveOnNear(data: Data, swap: { id: string; delivers: { symbol: string; amount: string } }) {
  const account = accountOf(data);
  bump(account, swap.delivers.symbol, BigInt(swap.delivers.amount));
  if (account.state) account.state.pending = account.state.pending.filter((p) => transferId(p) !== swap.id);
}

/** The stand-in keeper's timer: one step of the stored plan every few seconds. */
let keeper: ReturnType<typeof setTimeout> | null = null;
const KEEPER_STEP_MS = 5_000;

function stopKeeper() {
  if (keeper) clearTimeout(keeper);
  keeper = null;
  stopEvm();
  stopMoves();
}

/** Runs the plan's next step, as the keeper and the account would: the step is marked done and the money moves. */
function runKeeper(data: Data) {
  stopKeeper();
  keeper = setTimeout(() => {
    const account = accountOf(data);
    const funding = lenderOf(data).funding;
    const step = funding?.steps.find((s) => !s.done);
    if (!funding || !step || !account.state) return;
    step.done = true;
    const amount = BigInt(String(step.amt ?? '0'));
    if (step.l === 'aave' && (step.k === 'l_supply' || step.k === 'l_borrow')) {
      // Stage 3: the account signs an Ethereum transaction for the step; the keeper sends it, and waits for it to be
      // mined before the next step. The first supply of a token is preceded by its one-time approval.
      const lender = lenderOf(data);
      const owner = account.state;
      const i = funding.steps.indexOf(step);
      const supply = step.k === 'l_supply';
      const token = supply ? String(step.tok) : AAVE_USDC.token;
      if (supply && !lender.evm?.signed.some((e) => e.kind === 'approve' && e.token === token)) mineEvm(lender, owner, signEvm(lender, owner, { kind: 'approve', token, amount: null }).nonce);
      account.state.counter += 1;
      account.state.funding = funding;
      keeper = setTimeout(() => {
        const entry = signEvm(lender, owner, { kind: supply ? 'supply' : 'borrow', token, amount: amount.toString(), step: funding.pid + ':' + i });
        keeper = setTimeout(() => {
          submitEvm(lender, owner, entry.nonce, () => {
            if (funding.steps.some((s) => !s.done)) runKeeper(data);
          });
        }, 2_500);
      }, 2_500);
      return;
    }
    if (step.k === 'l_supply') {
      bump(account, 'nBTC', -amount);
      movePosition(data, String(step.l), nbtcMicro(amount), 0n);
    } else if (step.k === 'l_borrow') {
      bump(account, 'USDC', amount);
      movePosition(data, String(step.l), 0n, amount);
    } else if (step.k === 'p_borrow') {
      const total = BigInt(account.debt) + amount;
      account.debt = total.toString();
      account.state.loan = { principal: total.toString(), open: true };
      account.borrower = borrowerSample(account.debt);
      bump(account, 'USDC', amount);
    }
    account.state.counter += 1;
    account.state.funding = funding;
    if (funding.steps.some((s) => !s.done)) runKeeper(data);
  }, KEEPER_STEP_MS);
}

/**
 * A wallet that sends nothing: a check stores a sample verdict a few seconds later, a borrow opens the loan, and
 * `fund` stores a plan that the stand-in keeper then runs. The other Phase 6 calls change the sample the same way.
 */
function simulatedWallet(state: PreviewState, data: Data, signedAccountId: string): NearContextValue {
  const send = async (tx: { actions: { methodName: string; args: Record<string, unknown> }[] }) => {
    await sleep(900);
    const { methodName, args } = tx.actions[0]!;
    const a = accountOf(data);
    const lender = lenderOf(data);
    if (methodName === 'create_account') {
      // The factory makes the account and hands it the permission, if one came with the call.
      const permission = (args.permission as Permission | undefined) ?? null;
      a.exists = true;
      a.has_contract = true;
      a.borrower = borrowerSample('0');
      a.state = { owner: OWNER, counter: 0, blocked: false, loan: { principal: '0', open: false }, verdict: null, hl: { path: 'hyperliquid-1', address: null }, pending: [], permission, permission_blk: permission ? a.block_height : 0, funding: null };
      Object.assign(lender, { config_lenders: ['rhea'], permission });
      return outcome('SIMcreate1111111');
    }
    if (!a.state) return outcome('SIMother33333333');
    const st = a.state;
    if (methodName === 'request_check') {
      const intent = args.intent as { fund?: { amount: string }; lender_withdraw?: { lender: string; token?: string; amount: string }; evm_withdraw?: { token: string; amount: string } };
      setTimeout(() => {
        a.block_height += 100;
        const base = {
          nonce: st.counter,
          blk: a.block_height - 5,
          rate_bp: lender.config_lenders || lender.permission ? POOL_RATE_BP : 200,
          credit: { line: Number(LINE + lenderDebt(lender)), binding: 'C4' },
        };
        let said: Record<string, unknown>;
        if (intent.fund) {
          const plan = planFor(state, data, intent.fund.amount);
          said = verdict({ ...base, allow: { withdraw: 0, borrow: Number(canBorrow(data)), fund: plan.total }, fund: plan.steps, ext: plan.ext });
        } else if (intent.lender_withdraw) {
          // As the engine would: allowed only while the cushion with that lender stays at 1.5 afterwards.
          const at = lender.lenders.find((p) => p.l === intent.lender_withdraw!.lender);
          const units = BigInt(intent.lender_withdraw.amount);
          // What the collateral is worth: nBTC at Rhea, and at Aave the token named, which may be ether.
          const worth = intent.lender_withdraw.lender === 'aave' ? tokenMicro(intent.lender_withdraw.token ?? '', units) : nbtcMicro(units);
          const left = BigInt(at?.posted ?? 0) - worth;
          const owed = BigInt(at?.debt ?? 0);
          const allowed = left >= 0n && (owed === 0n || (left * BigInt(at?.liq_bp ?? 0)) / owed >= 15_000n);
          said = verdict({ ...base, allow: { withdraw: allowed ? Number(intent.lender_withdraw.amount) : 0, borrow: Number(canBorrow(data)) } });
        } else if (intent.evm_withdraw) {
          // Sending a token out of the address: the sample engine allows what sits there.
          said = verdict({ ...base, allow: { withdraw: Number(intent.evm_withdraw.amount), borrow: Number(canBorrow(data)) } });
        } else {
          // A withdrawal for a move to Aave's chain: the sample engine allows it. Any other check allows none.
          const out = (args.intent as { withdraw?: { amount: string } }).withdraw;
          said = verdict({ ...base, allow: { withdraw: out ? Number(out.amount) : 0, borrow: Number(canBorrow(data)) } });
        }
        // Stage 4: a check sees what has arrived at the address, and the account stops listing those moves.
        st.pending = st.pending.filter((p) => !((p as { transfer?: { kind?: string } } | null)?.transfer?.kind === 'to_evm' && moveDelivered(transferId(p) ?? '')));
        st.verdict = { intent: args.intent, received_block: a.block_height, verdict: said };
        // INTERFACES.md 50.2: the check that finds the transfer sent clears the account's pause. Here, the second one.
        const hlState = st.hl as { open_sends?: string[]; send_open_until_ms?: string } | null;
        if (hlState?.open_sends && hlState.open_sends.length > 0) {
          pauseChecks += 1;
          if (pauseChecks >= 2) {
            hlState.open_sends = [];
            hlState.send_open_until_ms = '0';
          }
        }
      }, 4_000);
      return outcome('SIMcheck11111111');
    }
    if (methodName === 'borrow') {
      const total = BigInt(st.loan.principal) + BigInt(String(args.amount));
      st.loan = { principal: total.toString(), open: true };
      st.counter += 1;
      a.debt = total.toString();
      bump(a, 'USDC', BigInt(String(args.amount)));
      return outcome('SIMborrow2222222');
    }
    if (methodName === 'fund') {
      // The account stores the held verdict's funding steps for 30 minutes, none of them started.
      const held = st.verdict as { verdict: { blk: number; fund?: FundingStep[] } } | null;
      const now = Date.now();
      const funding: FundingState = {
        pid: `f${held?.verdict.blk ?? 0}`, amount: String(args.amount), stored_at: `${now}000000`, expires_at: `${now + 30 * 60_000}000000`,
        steps: (held?.verdict.fund ?? []).map((s) => ({ ...s, done: false })),
      };
      lender.funding = funding;
      st.funding = funding;
      st.counter += 1;
      runKeeper(data);
      return outcome('SIMfund444444444');
    }
    if (methodName === 'cancel_funding') {
      stopKeeper();
      lender.funding = null;
      st.funding = null;
      return outcome('SIMcancel5555555');
    }
    if (methodName === 'set_permission') {
      const permission = (args.permission as Permission | null) ?? null;
      lender.permission = permission;
      st.permission = permission;
      // INTERFACES.md 40.1: the counter stays, and the account records the block. A loan needs a check read after it.
      st.permission_blk = a.block_height;
      return outcome('SIMpermit6666666');
    }
    if (methodName === 'repay') {
      const sent = BigInt(String(args.amount));
      const debt = BigInt(a.debt);
      const used = sent < debt ? sent : debt;
      a.debt = (debt - used).toString();
      st.loan = { principal: a.debt, open: a.debt !== '0' };
      a.borrower = borrowerSample(a.debt);
      bump(a, 'USDC', -used);
      return outcome('SIMrepay77777777');
    }
    // Stage 3: a call at Aave only has the account sign an Ethereum transaction, which it logs. The page then sends it
    // (POST /api/evm/submit), and the stand-in chain mines it and moves the balances.
    const signs = (kind: string, token: string, amount: string | null, to?: string) => {
      const entry = signEvm(lender, st, { kind, token, amount, to });
      return outcome(`SIMevm${entry.nonce}${kind}`, [evmSignedLog(entry.nonce, kind, entry.hash)]);
    };
    if (methodName === 'evm_approve' && lender.evm) return signs('approve', String(args.token), null);
    if (methodName === 'evm_withdraw' && lender.evm) {
      st.counter += 1;
      const signed = signs('transfer', String(args.token), String(args.amount), String(args.to));
      // Stage 4: with `exp` the transfer carries a move home, and the account records it as `move:<n>`. Its USDC is
      // named "USDC", its collateral by the 0x address.
      if (typeof args.exp === 'number') {
        const id = signedForHome((lender.evm.nonce ?? 1) - 1);
        const usdc = String(args.token).toLowerCase() === AAVE_USDC.token.toLowerCase();
        if (id) st.pending = [...st.pending, { transfer: { id, kind: 'e_home', token: usdc ? 'USDC' : String(args.token).toLowerCase(), amount: String(args.amount), dep: String(args.to).toLowerCase(), deadline: moveDeadline(args.exp) } }];
      }
      return signed;
    }
    // Stage 4: a withdrawal that names a move to Aave's chain pays 1Click's address for it, and is recorded as `move:<n>`.
    const moving = args.transfer as { kind?: string; exp?: number } | undefined;
    if (methodName === 'withdraw' && moving?.kind === 'to_evm') {
      const symbol = a.balances.find((b) => (b as { token?: string }).token === args.token)?.symbol ?? 'nBTC';
      bump(a, symbol, -BigInt(String(args.amount)));
      st.counter += 1;
      const id = depositOnNear(String(args.receiver), (swap) => arriveAtAddress(data, swap.delivers));
      if (id) st.pending = [...st.pending, { transfer: { id, kind: 'to_evm', token: String(args.token), amount: String(args.amount), dep: String(args.receiver), deadline: moveDeadline(moving.exp ?? Date.now()) } }];
      return outcome('SIMmoveEEEEEEEEE');
    }
    if (methodName === 'forget_transfer') {
      st.pending = st.pending.filter((p) => transferId(p) !== args.id);
      return outcome('SIMforgetFFFFFFF');
    }
    if (methodName === 'lender_repay' && args.lender === 'aave' && lender.evm) return signs('repay', AAVE_USDC.token, String(args.amount));
    if (methodName === 'lender_withdraw' && args.lender === 'aave' && lender.evm) {
      st.counter += 1;
      return signs('withdraw', String(args.token), String(args.amount));
    }
    if (methodName === 'lender_repay') {
      const sent = BigInt(String(args.amount));
      movePosition(data, String(args.lender), 0n, -sent);
      bump(a, 'USDC', -sent);
      return outcome('SIMlrepay8888888');
    }
    if (methodName === 'lender_withdraw') {
      const units = BigInt(String(args.amount));
      if (args.token !== NBTC_ID) {
        // The USDC token: the plain deposit a repayment left at the lender comes back to the account.
        movePosition(data, String(args.lender), 0n, 0n, -units);
        bump(a, 'USDC', units);
        return outcome('SIMbringbackDDDD');
      }
      movePosition(data, String(args.lender), -nbtcMicro(units), 0n);
      bump(a, 'nBTC', units);
      st.counter += 1;
      return outcome('SIMtakeback99999');
    }
    if (methodName === 'claim_credit' && lender.pricing) {
      bump(a, 'USDC', BigInt(lender.pricing.credit));
      lender.pricing = { ...lender.pricing, credit: '0' };
      return outcome('SIMclaimAAAAAAAA');
    }
    // The operator's pricing settings change what GET /api/pricing answers.
    const pricing = data['/api/pricing'] as PricingAnswer;
    if (methodName === 'set_pricing') {
      const target = args.target as PricingTarget;
      const policy = args.pricing as Pricing | null;
      if ('tier' in target) {
        pricing.tiers = [...pricing.tiers.filter((t) => t.tier !== target.tier), ...(policy ? [{ tier: target.tier, pricing: policy }] : [])];
      } else {
        const row = pricing.accounts.find((r) => r.account === target.account);
        const next: Pick<PricingView, 'pricing' | 'from'> = policy ? { pricing: policy, from: 'account' } : { pricing: 'pass_through', from: 'default' };
        if (row) Object.assign(row, next);
        else if (policy) pricing.accounts.push({ account: target.account, ...next, fees_charged: '0', subsidy_paid: '0', credit: '0', settled_at: '0', last: [], lender_debt: [] });
      }
      return outcome('SIMpricingBBBBBB');
    }
    if (methodName === 'set_funding') {
      pricing.funding = args.funding as PricingAnswer['funding'];
      return outcome('SIMfundingCCCCCC');
    }
    return outcome('SIMother33333333');
  };
  return {
    loading: false,
    signedAccountId,
    signIn: async () => undefined,
    signOut: async () => undefined,
    viewFunction: async () => null,
    callFunction: async () => {
      throw new Error('Preview: nothing is sent');
    },
    sendTx: send as unknown as NearContextValue['sendTx'],
    sendTxs: (async (txs: Parameters<typeof send>[0][]) => Promise.all(txs.map(send))) as unknown as NearContextValue['sendTxs'],
    signMessage: async () => {
      throw new Error('Preview: nothing is signed');
    },
  };
}

/** The browser's own fetch, kept once, so a second render (React's strict mode) never wraps a stand-in in another. */
const realFetch = typeof window === 'undefined' ? undefined : window.fetch.bind(window);

/**
 * The sample in use. React's strict mode runs a state's first value twice and keeps one: both runs must hand back the
 * same sample, or the wallet would change one copy of the data while the page reads the other.
 */
let installed: { state: PreviewState; sample: { data: Data; wallet: NearContextValue } } | null = null;

function install(state: PreviewState) {
  if (installed?.state === state) return installed.sample;
  stopKeeper();
  const data = fixtures(state);
  // INTERFACES.md 42: a page with an account asks for the markets as that account's own gateway sees them. The sample
  // account pins a gateway built since the rule, so its bands are the file's or testnet's 3%, whichever is larger.
  const plain = data['/api/markets'] as MarketsAnswer;
  data[marketsPath(ACCOUNT)] = { ...plain, band_from: 'account', gateway_version: 'sample', band_floor_bp: 300, coins: plain.coins.map((c) => ({ ...c, band_bp: Math.max(c.band_bp, 300) })) };
  // Stage 4: the states that show a move under way add it to what the account lists and to what the stand-in knows.
  // The browser that started a move home remembers how to ask 1Click about it: the sample puts that in place too.
  if (isMoveState(state)) {
    const owner = accountOf(data).state!;
    const lender = lenderOf(data);
    const seeded = seedMove(state, ACCOUNT, lender, (tx) => signEvm(lender, owner, tx).nonce);
    owner.pending = [...owner.pending, ...seeded.pending];
    try {
      for (const move of seeded.remembered) rememberMove(window.localStorage, move);
    } catch {
      // private mode: the row then says the status shows only in the browser that started the move
    }
  }
  // The sample wallet's account name, added beside any names this browser already remembers.
  try {
    const names = JSON.parse(window.localStorage.getItem('pb:account-names') ?? '{}') as Record<string, string>;
    window.localStorage.setItem('pb:account-names', JSON.stringify({ ...names, [OWNER]: 'alice' }));
  } catch {
    // private mode: the name field starts empty
  }
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
    const path = decodeURIComponent(url.replace(/^https?:\/\/[^/]+/, ''));
    // Stage 3: the backend's two routes for Aave's chain. One sends a transaction the account signed; the other is
    // testnet's faucet for gas and test collateral.
    // GET /api/evm/gas only reads: the sample's gas helper is on, so the test-collateral step and "Get test gas" show.
    if (path === '/api/evm/gas' && (init?.method ?? 'GET').toUpperCase() === 'GET') {
      return new Response(JSON.stringify({ on: true, chain_id: 84532, gas_wallet: '0x00000000000000000000000000000000000000aa', balance: '50000000000000000' }), { status: 200 });
    }
    if (path === '/api/evm/submit' || path === '/api/evm/gas') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { nonce?: number; mint?: { token: string; amount: string }; wrap?: { amount: string } };
      const lender = lenderOf(data);
      const owner = accountOf(data).state;
      await sleep(700);
      // Stage 4: a mined transfer that carries a move home is 1Click's deposit, and the delivery on NEAR follows.
      const mined = () => minedForHome(Number(body.nonce), (swap) => arriveOnNear(data, swap));
      const answer = !owner ? null : path === '/api/evm/submit' ? submitEvm(lender, owner, Number(body.nonce), mined) : gasEvm(lender, body);
      return new Response(JSON.stringify(answer ?? { error: 'not_found', message: 'The sample account has nothing signed under that nonce, or no address on Base Sepolia.' }), { status: answer ? 200 : 404 });
    }
    // Stage 4: a quote for a move between NEAR and Aave's chain, and 1Click's status for one, from the stand-in.
    if (path === '/api/quote' && aaveSampleOf(state)) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { dry?: boolean; move?: string; account?: string; token?: string; amount?: string };
      if (body.move === 'to_evm' || body.move === 'e_home') {
        await sleep(600);
        const said = moveQuote(body, { owesPool: accountOf(data).debt !== '0', wbtcRoom: state === 'aave-bitcoin', nextId: `move:${movesNamed() + 1}` });
        return new Response(JSON.stringify(said.answer), { status: said.status });
      }
    }
    if (path.startsWith('/api/status?')) {
      const query = new URLSearchParams(path.slice(path.indexOf('?') + 1));
      const said = moveStatus(query.get('depositAddress') ?? '', query.get('depositMemo'));
      return new Response(JSON.stringify(said ?? { error: 'not_found', message: 'The stand-in knows no move with that deposit address.' }), { status: said ? 200 : 404 });
    }
    if (path === '/api/funding-plan' && (isLenderState(state) || isRheaState(state) || aaveSampleOf(state))) {
      // As the backend would: a moment's work, then where a loan of the amount asked would come from.
      const asked = (JSON.parse(String(init?.body ?? '{}')) as { amount?: string }).amount ?? '0';
      await sleep(600);
      return new Response(JSON.stringify(planFor(state, data, asked)), { status: 200 });
    }
    // "Deposit & withdraw" also reads the wallet's own balances, for a deposit from the wallet.
    if (path === `/api/account/${OWNER}`) {
      const wallet = {
        account_id: OWNER, block_height: 1_000_000, exists: true, has_contract: false, state: null, debt: null, borrower: null, not_deployed: [],
        balances: [
          { token: 'musdc.pbf-ops.testnet', symbol: 'USDC', decimals: 6, amount: '25000000' },
          { token: NBTC_ID, symbol: 'nBTC', decimals: 8, amount: '500000' },
        ],
      };
      return new Response(JSON.stringify(wallet), { status: 200 });
    }
    if (path.startsWith('/api/')) {
      const body = data[path.replace('?fresh=1', '')];
      return new Response(JSON.stringify(body ?? { error: 'not_in_preview', message: `The preview has no sample for ${path}` }), { status: body ? 200 : 404 });
    }
    return realFetch!(input, init);
  };
  // The Book page is public; its operator's controls show to the operator's wallet alone.
  const signedIn = state === 'book' ? '' : state === 'book-operator' ? OPERATOR : OWNER;
  const sample = { data, wallet: simulatedWallet(state, data, signedIn) };
  installed = { state, sample };
  return sample;
}

let pendingUninstall: ReturnType<typeof setTimeout> | null = null;

function uninstall() {
  pendingUninstall = null;
  installed = null;
  stopKeeper();
  if (realFetch) window.fetch = realFetch;
}

export function Preview({ state, page = 'home' }: { state: PreviewState; page?: 'home' | 'borrow' | 'deposit' }) {
  // The cockpit's reads go to /api/...: answered from the sample data while this page is open. The stand-in goes in
  // as the page first renders, before the cockpit's own effects read anything, and the real fetch comes back after.
  const [sample] = useState(() => install(state));
  useEffect(() => {
    // React's strict mode unmounts and mounts again at once: put the real fetch back only on a real unmount.
    if (pendingUninstall) clearTimeout(pendingUninstall);
    pendingUninstall = null;
    return () => {
      pendingUninstall = setTimeout(uninstall, 0);
    };
  }, [sample]);
  const wallet = sample.wallet;
  // The credit check's sample answer, made once, for the states that show it.
  const [credit] = useState(() => (isFundingState(state) ? creditSample(state === 'funding' ? 'aave' : state === 'funding-noback' ? 'noback' : 'pool') : null));

  return (
    <>
      <div className="pb-container pt-3">
        <div className="alert alert-info small mb-0 d-flex flex-wrap gap-2 align-items-center">
          <span className="fw-medium">Preview with sample data.</span> Checks, loans and the keeper are simulated here: nothing is sent.
          <span className="ms-auto d-flex flex-wrap gap-2">
            {STATES.map((s) => (
              <Link key={s} href={`/dev/home?state=${s}${page === 'home' ? '' : `&page=${page}`}`} className={s === state ? 'fw-semibold' : ''}>
                {s}
              </Link>
            ))}
          </span>
          {/* INTERFACES.md 50.1 point 2: the lenders' cards live on the Borrow page, so the sample shows that page too. */}
          <span className="w-100">
            Showing{' '}
            <Link href={`/dev/home?state=${state}`} className={page === 'home' ? 'fw-semibold' : ''}>
              Home
            </Link>
            {' · '}
            <Link href={`/dev/home?state=${state}&page=borrow`} className={page === 'borrow' ? 'fw-semibold' : ''}>
              the Borrow page
            </Link>
            {' · '}
            <Link href={`/dev/home?state=${state}&page=deposit`} className={page === 'deposit' ? 'fw-semibold' : ''}>
              Deposit &amp; withdraw
            </Link>
          </span>
        </div>
      </div>
      {credit ? (
        // The credit check's answer for the worked example, with "How this loan would be funded".
        <main className="pb-container pb-page" style={{ maxWidth: 1040 }}>
          <h1 className="h3">Credit check</h1>
          <p className="lead">
            The worked example’s answer, from sample data: $100,000 of nBTC hedged by a $100,000 BTC short, with $35,000 of margin.
            {state === 'funding'
              ? ' Here the loan is expected to last a year, so moving the bitcoin to Aave and back pays.'
              : state === 'funding-noback'
                ? ' Here no quote came for bringing the bitcoin back, so that way is counted as the way there.'
                : ' Here the loan is expected to last 90 days, so moving the bitcoin to Aave and back doesn’t pay.'}
          </p>
          <CreditResultView answer={credit} />
        </main>
      ) : (
        // Privacy level 1 (INTERFACES.md 48.6): the canned page runs with privacy off, whatever the backend beside it says.
        <NearContext.Provider value={wallet}>
          <SessionContext.Provider value={SESSION_OFF}>{isBookState(state) ? <BookView /> : isAccountState(state) ? <AccountView /> : page === 'borrow' ? <BorrowView /> : page === 'deposit' ? <DepositView /> : <Cockpit />}</SessionContext.Provider>
        </NearContext.Provider>
      )}
    </>
  );
}
