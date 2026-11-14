// Development only: the preview's stand-in for the moves between NEAR and Aave's chain (stage 4; INTERFACES.md 36).
// It plays the backend's POST /api/quote for `to_evm` and `e_home`, 1Click's status for a move (GET /api/status), and
// the delivery a few seconds after the deposit. The amounts are the sample's own prices with a small cost taken off.
// Nothing is quoted by 1Click, and nothing moves.
import type { LenderAccountAnswer, MoveQuoteAnswer, StatusAnswer, SwapStatus } from '@/lib/api';
import type { StartedMove } from '@/lib/moves';

import { AAVE_USDC, ETH_USD, WBTC, WETH } from './aave-samples';
import { BTC_USD, NBTC_ID } from './samples';

/** 1Click's one address on Base Sepolia in the sample: every deposit there goes to it, told apart by a memo. */
export const MOVE_FLOAT = '0x2031181d63507368232579af4c64a1c3428407ff';
const MUSDC_ID = 'musdc.pbf-ops.testnet';
/** The most one move brings, in wrapped test ETH (18 decimals): 0.02. */
const MAX_WETH = 20_000_000_000_000_000n;
/** The account's deadline for a move: the quote's expiry and 30 minutes. */
const GRACE_MS = 30 * 60_000;

interface Swap {
  id: string;
  kind: 'to_evm' | 'e_home';
  depositAddress: string;
  depositMemo: string | null;
  delivers: { token: string; symbol: string; chain: string; amount: string };
  status: SwapStatus;
  /** The nonce of the signed transfer that carries a move home's deposit. */
  nonce?: number;
}

let swaps: Swap[] = [];
let quotes = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();

function later(ms: number, run: () => void) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    run();
  }, ms);
  timers.add(timer);
}

/** Forgets every move: the preview is closing, or showing another state. */
export function stopMoves() {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  swaps = [];
  quotes = 0;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const units = (value: bigint, decimals: number, shown = 6): string => {
  const text = value.toString().padStart(decimals + 1, '0');
  const fraction = text.slice(-decimals).slice(0, shown).replace(/0+$/, '');
  return `${text.slice(0, -decimals)}${fraction ? `.${fraction}` : ''}`;
};

/** A token's worth in micro-USD at the sample's prices, by its id on NEAR or its address on Aave's chain. */
function micro(token: string, amount: bigint): bigint {
  if (token === NBTC_ID || same(token, WBTC.token)) return (amount * BigInt(BTC_USD)) / 100n;
  if (same(token, WETH.token)) return (amount * BigInt(ETH_USD)) / 10n ** 12n;
  return amount;
}

/** What arrives for a move, after the sample's cost: 0.5% for bitcoin, 0.2% for USDC. `room` is whether Aave's pool takes WBTC. */
function delivery(move: 'to_evm' | 'e_home', token: string, amount: bigint, room: boolean): Swap['delivers'] & { decimals: number; usd: bigint } {
  const worth = micro(token, amount);
  const dollars = token === MUSDC_ID || same(token, AAVE_USDC.token);
  const usd = (worth * (dollars ? 998n : 995n)) / 1000n;
  if (move === 'e_home') {
    return dollars
      ? { token: MUSDC_ID, symbol: 'USDC', chain: 'NEAR', amount: usd.toString(), decimals: 6, usd }
      : { token: NBTC_ID, symbol: 'nBTC', chain: 'NEAR', amount: ((usd * 100n) / BigInt(BTC_USD)).toString(), decimals: 8, usd };
  }
  if (dollars) return { token: AAVE_USDC.token.toLowerCase(), symbol: 'USDC', chain: 'Base Sepolia', amount: usd.toString(), decimals: 6, usd };
  return room
    ? { token: WBTC.token.toLowerCase(), symbol: 'WBTC', chain: 'Base Sepolia', amount: ((usd * 100n) / BigInt(BTC_USD)).toString(), decimals: 8, usd }
    : { token: WETH.token.toLowerCase(), symbol: 'WETH', chain: 'Base Sepolia', amount: ((usd * 10n ** 12n) / BigInt(ETH_USD)).toString(), decimals: 18, usd };
}

const dollarText = (microUsd: bigint) => (Number(microUsd) / 1e6).toFixed(2);

/**
 * POST /api/quote for a move to or from Aave's chain, as INTERFACES.md 36 shapes it. A dry quote is a price; a
 * committed one names 1Click's address for the move, the transfer the account will record, and the account's next call.
 */
export function moveQuote(
  body: { dry?: boolean; move?: string; account?: string; token?: string; amount?: string },
  at: { owesPool: boolean; wbtcRoom: boolean; nextId: string },
): { status: number; answer: MoveQuoteAnswer | { error: string; message: string } } {
  const move = body.move === 'e_home' ? 'e_home' : 'to_evm';
  const token = body.token ?? (move === 'to_evm' ? NBTC_ID : AAVE_USDC.token);
  const amount = BigInt(body.amount ?? '0');
  const out = delivery(move, token, amount, at.wbtcRoom);
  if (move === 'to_evm' && out.symbol === 'WETH' && BigInt(out.amount) > MAX_WETH) {
    return { status: 400, answer: { error: 'too_large', message: 'On testnet one move brings at most 0.02 wrapped test ETH, because test ETH is scarce. Ask for less bitcoin.' } };
  }
  const decimalsIn = token === NBTC_ID || same(token, WBTC.token) ? 8 : same(token, WETH.token) ? 18 : 6;
  const dry = body.dry !== false;
  const exp = Date.now() + 10 * 60_000;
  quotes += 1;
  const depositAddress = move === 'to_evm' ? `sim${quotes}`.padEnd(64, 'a1b2c3d4') : MOVE_FLOAT;
  const depositMemo = move === 'to_evm' ? null : `q-${quotes}`;
  const next: MoveQuoteAnswer['move']['next'] = dry
    ? null
    : move === 'to_evm'
      ? { method: 'withdraw', args: { token, amount: amount.toString(), receiver: depositAddress, transfer: { kind: 'to_evm', exp } } }
      : { method: 'evm_withdraw', args: { token: token.toLowerCase(), amount: amount.toString(), to: MOVE_FLOAT, exp, expect: { token: out.token, amount: out.amount } } };
  if (!dry) swaps.push({ id: at.nextId, kind: move, depositAddress, depositMemo, delivers: { token: out.token, symbol: out.symbol, chain: out.chain, amount: out.amount }, status: 'PENDING_DEPOSIT' });
  const check = move === 'to_evm' ? { withdraw: { token, amount: amount.toString() } } : { evm_withdraw: { token: token.toLowerCase(), amount: amount.toString() } };
  // As the real stand-in does (services/oneclick-shim/src/evm-routes.ts): when the bitcoin arrives as WETH, it says why.
  const asBitcoin = (out.usd * 100n) / BigInt(BTC_USD);
  const shim =
    move === 'to_evm' && out.symbol === 'WETH'
      ? {
          asked: WBTC.token.toLowerCase(),
          delivers: out.token,
          symbol: out.symbol,
          why: `Aave's test market has room for 0 more WBTC (its supply cap), less than the ${units(asBitcoin, 8, 8)} this would bring: the bitcoin arrives as wrapped test ETH of the same dollar value`,
        }
      : null;
  return {
    status: 200,
    answer: {
      ...(shim && { shim }),
      correlationId: `sim-${quotes}`,
      quote: {
        ...(!dry && { depositAddress, depositMemo, deadline: new Date(exp).toISOString() }),
        amountIn: amount.toString(),
        amountInFormatted: units(amount, decimalsIn, 8),
        amountOut: out.amount,
        amountOutFormatted: units(BigInt(out.amount), out.decimals),
        minAmountOut: ((BigInt(out.amount) * 99n) / 100n).toString(),
        amountInUsd: dollarText(micro(token, amount)),
        amountOutUsd: dollarText(out.usd),
        timeEstimate: move === 'to_evm' ? 120 : 45,
      },
      move: {
        kind: move,
        account: body.account ?? '',
        next,
        transfer_id: dry ? null : at.nextId,
        exp_ms: dry ? null : exp,
        delivers: { token: out.token, symbol: out.symbol, chain: out.chain, amount: out.amount },
        needs_check: at.owesPool ? check : null,
      },
    },
  };
}

/** GET /api/status: what the stand-in says of the move with this deposit address, and memo when it has one. */
export function moveStatus(depositAddress: string, depositMemo: string | null): StatusAnswer | null {
  const swap = swaps.find((s) => same(s.depositAddress, depositAddress) && (s.depositMemo ?? null) === (depositMemo ?? null));
  if (!swap) return null;
  return { status: swap.status, updatedAt: new Date().toISOString(), ...(swap.status === 'REFUNDED' && { swapDetails: { refundReason: 'the sample’s delivery was switched off' } }) };
}

/** The account's deadline for a transfer recorded now, as get_state() writes it: nanoseconds, as a string. */
export const moveDeadline = (expMs: number): string => `${expMs + GRACE_MS}000000`;

/**
 * The deposit of a move reached 1Click: it is seen, then processed, and a few seconds later delivered. `deliver` gets
 * what arrives, to move the sample's balances.
 */
function onDeposit(swap: Swap, deliver: (swap: Swap) => void) {
  if (swap.status !== 'PENDING_DEPOSIT') return;
  swap.status = 'KNOWN_DEPOSIT_TX';
  later(2_500, () => {
    swap.status = 'PROCESSING';
    later(5_000, () => {
      swap.status = 'SUCCESS';
      deliver(swap);
    });
  });
}

/** A `withdraw` with a to_evm transfer paid the move's own deposit address. */
export function depositOnNear(receiver: string, deliver: (swap: Swap) => void): string | null {
  const swap = swaps.find((s) => s.kind === 'to_evm' && s.depositAddress === receiver);
  if (!swap) return null;
  onDeposit(swap, deliver);
  return swap.id;
}

/** An `evm_withdraw` with `exp` signed the transfer that will carry a move home's deposit: the newest quote waits for it. */
export function signedForHome(nonce: number): string | null {
  const swap = [...swaps].reverse().find((s) => s.kind === 'e_home' && s.status === 'PENDING_DEPOSIT' && s.nonce === undefined);
  if (!swap) return null;
  swap.nonce = nonce;
  return swap.id;
}

/** The chain mined the signed transaction of that nonce: if it carries a move home, 1Click now has its deposit. */
export function minedForHome(nonce: number, deliver: (swap: Swap) => void) {
  const swap = swaps.find((s) => s.kind === 'e_home' && s.nonce === nonce);
  if (swap) onDeposit(swap, deliver);
}

/** Has the stand-in delivered the move with this transfer id? A check then settles a move to Aave's chain. */
export const moveDelivered = (id: string): boolean => swaps.some((s) => s.id === id && s.status === 'SUCCESS');

/** How many moves the stand-in has named, for the next `move:<n>`. */
export const movesNamed = (): number => swaps.length;

// ---------- the five sample states ----------

export const MOVE_STATE_NAMES = ['move-waiting', 'move-way', 'move-arrived', 'move-refunded', 'move-overdue'] as const;
export type MoveStateName = (typeof MOVE_STATE_NAMES)[number];

/**
 * One move under way for each sample state, as the account lists it and as the stand-in sees it:
 * - `move-waiting`: the loan on its way home. The account signed the transfer out of the address; it isn't mined yet,
 *   so 1Click is still waiting for the deposit. "Send it now" on the address card sends it.
 * - `move-way`: bitcoin on its way to Aave's chain: 1Click has it and is delivering.
 * - `move-arrived`: bitcoin that has arrived at the address as wrapped test ETH. The account keeps it listed until a
 *   check sees it there.
 * - `move-refunded`: collateral on its way home that 1Click sent back to the address.
 * - `move-overdue`: USDC for Aave's chain that 1Click failed to deliver, past its deadline: the owner drops it.
 */
export function seedMove(
  state: MoveStateName,
  account: string,
  lender: LenderAccountAnswer,
  sign: (tx: { kind: string; token: string; amount: string; to: string }) => number,
): { pending: unknown[]; remembered: StartedMove[] } {
  const now = Date.now();
  const transfer = (id: string, kind: string, token: string, amount: string, dep: string, deadlineMs: number) => ({ transfer: { id, kind, token, amount, dep, deadline: `${deadlineMs}000000` } });
  const soon = now + 9 * 60_000 + GRACE_MS;
  const out = (amount: bigint) => delivery('to_evm', NBTC_ID, amount, false);
  const wallet = (token: string) => lender.evm?.wallet.find((t) => same(t.token, token));
  switch (state) {
    case 'move-waiting': {
      const amount = wallet(AAVE_USDC.token)?.amount ?? '0';
      const home = delivery('e_home', AAVE_USDC.token, BigInt(amount), false);
      const nonce = sign({ kind: 'transfer', token: AAVE_USDC.token.toLowerCase(), amount, to: MOVE_FLOAT });
      swaps.push({ id: 'move:1', kind: 'e_home', depositAddress: MOVE_FLOAT, depositMemo: 'q-seed', delivers: home, status: 'PENDING_DEPOSIT', nonce });
      return { pending: [transfer('move:1', 'e_home', 'USDC', amount, MOVE_FLOAT, soon)], remembered: [{ account, id: 'move:1', depositAddress: MOVE_FLOAT, depositMemo: 'q-seed' }] };
    }
    case 'move-way':
    case 'move-arrived': {
      const dep = 'seed'.padEnd(64, 'a1b2c3d4');
      const arrives = out(55_000n);
      const arrived = state === 'move-arrived';
      swaps.push({ id: 'move:1', kind: 'to_evm', depositAddress: dep, depositMemo: null, delivers: arrives, status: arrived ? 'SUCCESS' : 'PROCESSING' });
      const weth = wallet(WETH.token);
      if (arrived && weth) weth.amount = (BigInt(weth.amount) + BigInt(arrives.amount)).toString();
      // The sample's delivery of the move still on its way lands a little later.
      if (!arrived) {
        later(20_000, () => {
          const swap = swaps.find((s) => s.id === 'move:1');
          if (swap) swap.status = 'SUCCESS';
          if (weth) weth.amount = (BigInt(weth.amount) + BigInt(arrives.amount)).toString();
        });
      }
      return { pending: [transfer('move:1', 'to_evm', NBTC_ID, '55000', dep, soon)], remembered: [] };
    }
    case 'move-refunded': {
      const amount = wallet(WETH.token)?.amount ?? '0';
      swaps.push({ id: 'move:1', kind: 'e_home', depositAddress: MOVE_FLOAT, depositMemo: 'q-seed', delivers: delivery('e_home', WETH.token, BigInt(amount), false), status: 'REFUNDED' });
      return { pending: [transfer('move:1', 'e_home', WETH.token.toLowerCase(), amount, MOVE_FLOAT, soon)], remembered: [{ account, id: 'move:1', depositAddress: MOVE_FLOAT, depositMemo: 'q-seed' }] };
    }
    default: {
      const dep = 'late'.padEnd(64, 'a1b2c3d4');
      swaps.push({ id: 'move:1', kind: 'to_evm', depositAddress: dep, depositMemo: null, delivers: delivery('to_evm', MUSDC_ID, 25_000_000n, false), status: 'FAILED' });
      return { pending: [transfer('move:1', 'to_evm', MUSDC_ID, '25000000', dep, now - 12 * 60_000)], remembered: [] };
    }
  }
}
