// The four moves between NEAR and Aave's chain (stage 4; INTERFACES.md 36; FUNDING.md 6.4 and 9). The client starts
// each one, the way they move USDC to Hyperliquid: a 1Click quote (our stand-in on testnet), then the account's own
// call, which records the move as a pending transfer `move:<n>` until it settles.
//   to_evm:  nBTC or USDC leaves the account on NEAR (`withdraw` with `transfer`) and arrives at the account's own
//            address on Aave's chain. The account can't see that chain, so a check settles the transfer.
//   e_home:  USDC or collateral leaves that address (`evm_withdraw` with `exp`) and arrives in the account on NEAR,
//            which settles the transfer by itself.
// INTERFACES.md 51.2 adds two: test ETH from NEAR to that address, where it arrives as WETH, and WETH home again as
// test ETH. They are for an account whose own settings list test ETH, and the stand-in caps one move at 0.02 ETH.
// This file is the words and the plain data: what a quote says, where a move stands, and what a listed transfer is.
import type { MoveQuoteAnswer, SwapStatus } from './api.ts';
import { EVM_CHAIN_NAME } from './evm.ts';
import { buildMove, evmWithdrawTx, moveExpiryProblem, withdrawTx, type Tx } from './tx.ts';
import type { Intent } from './types.ts';
import { displayUnits, formatUsd } from './units.ts';

/** The moves, by what the client is doing: the four of stage 4, and the two with the client's own ETH. */
export type MoveKey = 'bitcoin-out' | 'loan-home' | 'usdc-out' | 'bitcoin-home' | 'ether-out' | 'ether-home';

export interface MoveDef {
  key: MoveKey;
  /** The backend's name for it in POST /api/quote. */
  move: 'to_evm' | 'e_home';
  title: string;
  /** What leaves, what arrives and where, before any amount is typed. */
  about: string;
}

export const MOVES: Record<MoveKey, MoveDef> = {
  'bitcoin-out': {
    key: 'bitcoin-out',
    move: 'to_evm',
    title: 'Move bitcoin to Aave’s chain',
    about: `Your nBTC leaves the account on NEAR and arrives at the account’s own address on ${EVM_CHAIN_NAME}, where Aave can take it as collateral.`,
  },
  'loan-home': {
    key: 'loan-home',
    move: 'e_home',
    title: 'Bring the loan home',
    about: `What Aave lent sits as USDC at the account’s address on ${EVM_CHAIN_NAME}. This brings it to your account on NEAR.`,
  },
  'usdc-out': {
    key: 'usdc-out',
    move: 'to_evm',
    title: 'Send USDC to Aave’s chain',
    about: `USDC leaves the account on NEAR and arrives at the account’s own address on ${EVM_CHAIN_NAME}. Aave is repaid from there.`,
  },
  'bitcoin-home': {
    key: 'bitcoin-home',
    move: 'e_home',
    title: 'Bring the bitcoin home',
    about: `Collateral you took back from Aave sits at the account’s address on ${EVM_CHAIN_NAME}. This brings it to your account on NEAR, as nBTC.`,
  },
  'ether-out': {
    key: 'ether-out',
    move: 'to_evm',
    title: 'Move ETH to Aave’s chain',
    about: `Your ETH leaves the account on NEAR and arrives at the account’s own address on ${EVM_CHAIN_NAME} as WETH, the wrapped form Aave takes as collateral.`,
  },
  'ether-home': {
    key: 'ether-home',
    move: 'e_home',
    title: 'Bring the ETH home',
    about: `WETH you took back from Aave sits at the account’s address on ${EVM_CHAIN_NAME}. This brings it to your account on NEAR, as ETH.`,
  },
};

/**
 * The one switch for the client's own ETH on Aave's chain (INTERFACES.md 51.2). ON since 14 Nov, 14:40 UTC: the
 * backend's `POST /api/quote` takes test ETH for `to_evm` and a `to` for `e_home`, and the scripted run of 14 Nov
 * (finished 13:38 UTC, research/data/phase6_funding_moves_eth.pass-2026-11-14.json) went through both on live
 * testnet. The two moves on the address card, the Basis trade's "Move 0.02 ETH to Aave's chain", and WETH coming home
 * as ETH all follow from it. Set it to false to take all of them away.
 */
export const ETHER_MOVES_ON = true;

/** Test ETH among an account's own tokens (GET /api/account's `balances`), or null: an account from before 13 Nov lists none. */
export function listedEther(balances: { token: string; symbol: string; decimals: number }[] | null | undefined): KnownToken | null {
  const eth = (balances ?? []).find((b) => b.symbol === 'ETH');
  return eth ? { id: eth.token, symbol: eth.symbol, decimals: eth.decimals } : null;
}

/** The two moves of the client's own ETH show only for an account whose own settings list test ETH, and only with the switch on: its token there, or null. */
export function etherToken(balances: { token: string; symbol: string; decimals: number }[] | null | undefined, on: boolean = ETHER_MOVES_ON): KnownToken | null {
  return on ? listedEther(balances) : null;
}

/** The moves an account can be offered: the four of before, and the two with ETH when its settings list test ETH. */
export function movesFor(balances: { token: string; symbol: string; decimals: number }[] | null | undefined, on: boolean = ETHER_MOVES_ON): MoveKey[] {
  const four: MoveKey[] = ['bitcoin-out', 'loan-home', 'usdc-out', 'bitcoin-home'];
  return etherToken(balances, on) ? [...four, 'ether-out', 'ether-home'] : four;
}

/**
 * What POST /api/quote is asked for a move (INTERFACES.md 36 and 51.2). `token` is what leaves: a NEAR token id for
 * `to_evm`, an address on Aave's chain for `e_home`. Bringing WETH home as ETH names the account's test ETH in `to`;
 * without `to` it comes home as bitcoin, as before.
 */
export function moveQuoteBody(
  key: MoveKey,
  input: { dry: boolean; account: string; token: string; amount: string; ether: KnownToken | null },
): { dry: boolean; move: 'to_evm' | 'e_home'; account: string; token: string; amount: string; to?: string } {
  const { dry, account, token, amount, ether } = input;
  return { dry, move: MOVES[key].move, account, token, amount, ...(key === 'ether-home' && ether ? { to: ether.id } : {}) };
}

/** Who carries a move, said once on each panel. Testnet has no 1Click, so our own stand-in plays it. */
export const CARRIER_WORDS = 'A move costs money and takes a few minutes. 1Click carries it; on testnet our own stand-in plays 1Click, with real prices.';

/** Where a move's tokens arrive, and where they come from. */
export const moveEnds = (move: 'to_evm' | 'e_home'): { to: string; from: string } =>
  move === 'to_evm'
    ? { to: `the account’s own address on ${EVM_CHAIN_NAME}`, from: 'your account on NEAR' }
    : { to: 'your account on NEAR', from: `the account’s address on ${EVM_CHAIN_NAME}` };

// ---------- the size limit ----------

/** The stand-in's float on Base Sepolia is the gas wallet's test ETH: one move brings at most 0.02 of it, wrapped. */
export const MOVE_MAX_WETH = 0.02;

/**
 * The limit, where the bitcoin amount is typed. With today's prices it says the dollars and the bitcoin that is; without
 * them, the figure INTERFACES.md 36 gives ("about $40").
 */
export function sizeLimitWords(prices: { btc: number | null; eth: number | null }): string {
  const dollars = prices.eth !== null && prices.eth > 0 ? MOVE_MAX_WETH * prices.eth : null;
  const start = `On testnet one move brings at most ${MOVE_MAX_WETH} wrapped test ETH, about $${dollars === null ? '40' : Math.round(dollars)}, because test ETH is scarce.`;
  if (dollars === null || prices.btc === null || !(prices.btc > 0)) return start;
  return `${start} That is about ${(dollars / prices.btc).toFixed(5)} nBTC at today’s prices: a quote for more is refused.`;
}

/**
 * The cap on a move of the client's own ETH, said before an amount is typed (INTERFACES.md 51.2): the stand-in hands
 * over real test ETH on Aave's chain, and holds little. The dollars are today's when the page has ETH's price.
 */
export function etherCapWords(ethPrice: number | null | undefined): string {
  const dollars = typeof ethPrice === 'number' && ethPrice > 0 ? Math.round(MOVE_MAX_WETH * ethPrice) : 38;
  return `At most ${MOVE_MAX_WETH} ETH a move on testnet (about $${dollars}): the stand-in has little test ETH on that chain.`;
}

/** Is an amount of ETH over the cap? `units` are the token's own (18 decimals for test ETH and for WETH). */
export function overEtherCap(units: string | bigint, decimals: number): boolean {
  const cap = (BigInt(Math.round(MOVE_MAX_WETH * 1_000)) * 10n ** BigInt(decimals)) / 1_000n;
  return BigInt(units) > cap;
}

/**
 * Did the stand-in refuse a quote for its size? Its own words (services/oneclick-shim/src/evm-routes.ts): "…the
 * stand-in brings at most 0.02 WETH in one move: its float has little test ETH…". The page then says the cap, not an error.
 */
export const isSizeRefusal = (message: string | null | undefined): boolean => /brings at most|at most [\d.]+ (WETH|ETH)[^.]* in one move/i.test(message ?? '');

// ---------- a quote in words ----------

/** A token the page can name and count: by its id on NEAR, or its 0x address on Aave's chain. */
export interface KnownToken {
  id: string;
  symbol: string;
  decimals: number;
}

const known = (tokens: KnownToken[], id: string | null | undefined): KnownToken | undefined => (id ? tokens.find((t) => t.id.toLowerCase() === id.toLowerCase()) : undefined);

/** "About 20 seconds", "about 3 minutes": the quote's own estimate. */
export function timeWords(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return 'a few minutes';
  if (seconds < 90) return `about ${Math.round(seconds)} seconds`;
  return `about ${Math.round(seconds / 60)} minutes`;
}

/** What the move costs, in dollars: what leaves less what arrives, by the quote's own dollar figures. Null without them. */
export function moveCost(quote: MoveQuoteAnswer['quote']): { cost: number; leaves: number; arrives: number } | null {
  const leaves = Number(quote.amountInUsd);
  const arrives = Number(quote.amountOutUsd);
  if (quote.amountInUsd === undefined || quote.amountOutUsd === undefined || !Number.isFinite(leaves) || !Number.isFinite(arrives) || leaves <= 0) return null;
  return { cost: Math.max(0, leaves - arrives), leaves, arrives };
}

const dollars = (value: number): string => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** An amount of a token in words: dollars for USDC, else the token's own count and name, to 6 places. */
export const counted = (units: string | bigint, token: KnownToken): string =>
  token.symbol === 'USDC' && token.decimals === 6 ? `${formatUsd(units)} of USDC` : `${displayUnits(units, token.decimals, Math.min(token.decimals, 6))} ${token.symbol}`;

export interface QuoteWords {
  /** "0.00055 nBTC leaves your account on NEAR." */
  leaves: string;
  /** "About 0.0139 WETH arrives at the account's own address on Base Sepolia, in about 2 minutes." */
  arrives: string;
  /** "The move costs about $0.21: $41.80 leaves and about $41.59 arrives." */
  cost: string;
  /** Why something other than what was sent arrives, when it does. */
  why: string | null;
}

/**
 * A move's quote in plain words. `leaving` is the token that leaves, which the page chose. What arrives is the quote's
 * own `move.delivers`: its amount is counted by the token's decimals when the page knows that token, and otherwise
 * the quote's formatted amount stands in. A backend from before stage 4 sends no `delivers`.
 */
export function quoteWords(key: MoveKey, answer: MoveQuoteAnswer, leaving: KnownToken, tokens: KnownToken[]): QuoteWords {
  const def = MOVES[key];
  const ends = moveEnds(def.move);
  const { quote } = answer;
  const delivers = answer.move.delivers ?? null;
  const arriving = known(tokens, delivers?.token);
  const symbol = delivers?.symbol ?? '';
  const arrives = delivers && arriving && /^\d+$/.test(delivers.amount) ? counted(delivers.amount, arriving) : `${quote.amountOutFormatted}${symbol ? ` ${symbol}` : ''}`;
  const cost = moveCost(quote);
  // Bitcoin that arrives as something else: on testnet, wrapped test ETH while Aave's bitcoin pool is full. The
  // stand-in says why in its own words (`shim.why`, services/oneclick-client/src/types.ts); the page's sentence
  // stands in when it doesn't.
  const swapped = key === 'bitcoin-out' && delivers !== null && delivers.symbol !== 'WBTC';
  const said = typeof answer.shim?.why === 'string' && answer.shim.why.trim() ? answer.shim.why.trim().replace(/\.?$/, '.') : null;
  return {
    leaves: `${/^\d+$/.test(quote.amountIn) ? counted(quote.amountIn, leaving) : `${quote.amountInFormatted} ${leaving.symbol}`} leaves ${ends.from}.`,
    arrives: `About ${arrives} arrives at ${ends.to}, in ${timeWords(quote.timeEstimate)}.`,
    cost: cost
      ? `The move costs about ${dollars(cost.cost)}: ${dollars(cost.leaves)} leaves and about ${dollars(cost.arrives)} arrives.`
      : 'The quote gives no dollar figures, so the page can’t say what the move costs: compare what leaves with what arrives.',
    why: key === 'ether-out'
      ? 'It arrives as WETH, the wrapped form of ETH that Aave takes.'
      : key === 'ether-home'
        ? 'It arrives as ETH.'
        : said
      ? `${said} On mainnet it would arrive as bitcoin.`
      : swapped
        ? `Aave’s test pool for bitcoin is full today, so your bitcoin arrives as ${delivers.symbol === 'WETH' ? 'wrapped test ETH' : delivers.symbol} worth the same in dollars. On mainnet it would arrive as bitcoin.`
        : key === 'bitcoin-home'
          ? 'It arrives as nBTC, whichever token left.'
          : null,
  };
}

/** The check a move needs first, while the account owes our pool: the quote's `needs_check`, if it is one the page knows. */
export function needsCheck(move: MoveQuoteAnswer['move']): Intent | null {
  const asked = move.needs_check as Record<string, { token?: unknown; amount?: unknown } | undefined> | null | undefined;
  if (!asked || typeof asked !== 'object') return null;
  for (const kind of ['withdraw', 'evm_withdraw'] as const) {
    const body = asked[kind];
    if (body && typeof body.token === 'string' && typeof body.amount === 'string') return { [kind]: { token: body.token, amount: body.amount } } as Intent;
  }
  return null;
}

/**
 * The account's next call for a committed quote (`move.next`), as a transaction for the wallet. Null for any other
 * call, and for one that wouldn't be recorded as a move: the backend leaves out the transfer's kind, or `exp`, when it
 * couldn't read the quote's deadline, and a move the account doesn't list is one the page can't follow or settle.
 */
export function nextTx(account: string, next: MoveQuoteAnswer['move']['next'], nowMs: number = Date.now()): Tx | null {
  if (!next) return null;
  // A quote that expires more than 24 hours ahead is one the account would refuse (INTERFACES.md 40.1): the builders
  // don't build it, and `nextRefusal` has the words.
  if (next.method === 'withdraw' && next.args.transfer?.kind === 'to_evm') {
    const { args } = next;
    return buildMove(() => withdrawTx(account, args.token, args.amount, args.receiver, args.transfer, nowMs)).tx;
  }
  if (next.method === 'evm_withdraw' && next.args.exp !== undefined) {
    const { args } = next;
    // The quote's `expect` goes out with it (INTERFACES.md 47.3); a quote without one sends none.
    return buildMove(() => evmWithdrawTx(account, args.token, args.amount, args.to, args.exp, nowMs, args.expect)).tx;
  }
  return null;
}

/** Why the app won't send a committed quote's next call, when its expiry is the reason; else null. */
export function nextRefusal(next: MoveQuoteAnswer['move']['next'], nowMs: number = Date.now()): string | null {
  if (!next) return null;
  const exp = next.method === 'withdraw' ? next.args.transfer?.exp : next.args.exp;
  return exp === undefined ? null : moveExpiryProblem(exp, nowMs);
}

// ---------- where a move stands ----------

/** Waiting for the deposit, on its way, arrived, sent back, failed, or past its deadline. */
export type MoveStage = 'waiting' | 'moving' | 'arrived' | 'refunded' | 'failed' | 'overdue';

/**
 * A move's stage from 1Click's status for it and the account's own deadline. A final status wins; else a move past its
 * deadline is overdue whatever 1Click says. Null when neither says anything: the page then shows only what the
 * account lists.
 */
export function moveStage(status: SwapStatus | string | null | undefined, overdue: boolean): MoveStage | null {
  if (status === 'SUCCESS') return 'arrived';
  if (status === 'REFUNDED' || status === 'INCOMPLETE_DEPOSIT') return 'refunded';
  if (status === 'FAILED') return overdue ? 'overdue' : 'failed';
  if (overdue) return 'overdue';
  if (status === 'PENDING_DEPOSIT') return 'waiting';
  if (status === 'KNOWN_DEPOSIT_TX' || status === 'PROCESSING') return 'moving';
  return null;
}

export const STAGE_LABEL: Record<MoveStage, string> = {
  waiting: 'Waiting for the deposit',
  moving: 'On its way',
  arrived: 'Arrived',
  refunded: 'Sent back',
  failed: 'Failed',
  overdue: 'Overdue',
};

export const STAGE_TONE: Record<MoveStage, 'neutral' | 'warn' | 'good' | 'bad'> = { waiting: 'neutral', moving: 'warn', arrived: 'good', refunded: 'warn', failed: 'bad', overdue: 'bad' };

/** The kinds of transfer an account lists (INTERFACES.md 14 and 36). */
export type TransferKindName = 'sell' | 'to_hl' | 'home' | 'to_evm' | 'e_home';

/** Where a listed transfer's money is going, and where it would come back to. */
function transferEnds(kind: string): { to: string; from: string } {
  if (kind === 'to_evm' || kind === 'e_home') return moveEnds(kind);
  if (kind === 'to_hl') return { to: 'the account’s Hyperliquid address', from: 'your account on NEAR' };
  if (kind === 'home') return { to: 'your account on NEAR', from: 'the account’s Hyperliquid address' };
  return { to: 'your account on NEAR', from: 'your account on NEAR' };
}

/**
 * A stage in a sentence or two, for a transfer of this kind. It says what the account itself knows: a move to Aave's
 * chain is settled by a check, because the account can't see that chain; a move home settles when it lands on NEAR.
 * `listed` is whether the account still lists the transfer as under way.
 */
export function stageWords(stage: MoveStage, kind: string, listed = true): string {
  const ends = transferEnds(kind);
  switch (stage) {
    case 'waiting':
      return kind === 'e_home'
        ? `1Click is waiting for the transfer out of the address to be mined on ${EVM_CHAIN_NAME}.`
        : '1Click is waiting for the tokens to reach its address for this move.';
    case 'moving':
      return `1Click has the tokens and is delivering to ${ends.to}.`;
    case 'arrived':
      if (kind === 'to_evm' && listed) return `Arrived at ${ends.to}. The account can’t see that chain, so it keeps the move listed until a check sees the tokens there.`;
      return `Arrived at ${ends.to}.`;
    case 'refunded':
      if (kind === 'e_home' && listed) {
        return `1Click sent the tokens back to ${ends.from}, so nothing is lost. The account can’t see that chain, so the move stays listed until its deadline passes; then drop it.`;
      }
      return `1Click sent the tokens back to ${ends.from}, so nothing is lost but the time.`;
    case 'failed':
      return '1Click delivered nothing and sent nothing back. Once the move is past its deadline you can drop it, so that it stops holding back borrowing.';
    default:
      return kind === 'to_evm'
        ? 'Past its deadline. While it is listed, borrowing, and withdrawing with a loan, wait. If the tokens did arrive, a check settles it; if not, drop it.'
        : 'Past its deadline. While it is listed, borrowing, and withdrawing with a loan, wait. If nothing arrived, drop it: money that arrives later is kept as a plain deposit.';
  }
}

// ---------- a listed transfer in words ----------

/** One pending transfer as the account lists it (`get_state().pending`). */
export interface ListedTransfer {
  id: string;
  kind: string;
  token: string;
  amount: string;
  dep: string;
}

/** An amount of a token the page knows, else the raw units with the token's own name. */
function amountOf(amount: string, token: KnownToken | undefined, name: string): string {
  if (!/^\d+$/.test(amount)) return name;
  return token ? counted(amount, token) : `${amount} units of ${name}`;
}

/**
 * What a listed transfer is, in a client's words. `tokens` are the tokens the page knows: the account's on NEAR by
 * id, and those at its address on Aave's chain by 0x address. A move home names its USDC as "USDC", as `home` does.
 */
export function transferWords(transfer: ListedTransfer, tokens: KnownToken[], etherOn: boolean = ETHER_MOVES_ON): string {
  const usdc: KnownToken = { id: 'USDC', symbol: 'USDC', decimals: 6 };
  const token = transfer.token === 'USDC' ? usdc : known(tokens, transfer.token);
  const what = amountOf(transfer.amount, token, transfer.token);
  switch (transfer.kind) {
    case 'to_evm':
      return `${what} to ${moveEnds('to_evm').to}`;
    case 'e_home': {
      // WETH may come home as ETH on an account that lists test ETH (INTERFACES.md 51.2): the account's record doesn't
      // say which, so the page then doesn't either.
      const maybeEther = etherOn && token?.symbol === 'WETH' && tokens.some((t) => t.symbol === 'ETH');
      return token && token.symbol !== 'USDC' && !maybeEther ? `${what} home from ${EVM_CHAIN_NAME}, to arrive as nBTC` : `${what} home from ${EVM_CHAIN_NAME}`;
    }
    case 'to_hl':
      return `${what} to Hyperliquid`;
    case 'home':
      return `${what} home from Hyperliquid`;
    case 'sell':
      return `${what} sold through 1Click`;
    default:
      return `${what} (${transfer.kind})`;
  }
}

/**
 * Where a listed transfer stands, in words. Without a status from 1Click it says what the account knows (the transfer
 * is under way, and until when), and why the page can't say more.
 */
export function listedWords(kind: string, stage: MoveStage | null, known: { asked: boolean; error?: string | null; until?: string | null }): string {
  if (stage) return stageWords(stage, kind);
  const start = `The account lists it as under way.${known.until ? ` It has until ${known.until}.` : ''}`;
  if (known.error) return `${start} 1Click’s status didn’t answer: ${known.error}`;
  if (!known.asked) return `${start} 1Click’s status for a move like this shows only in the browser that started it.`;
  return `${start} Asking 1Click…`;
}

// ---------- what can leave ----------

/**
 * The tokens a move can take, with how much of each is there. Bitcoin and USDC go out from the account's balances on
 * NEAR; the loan comes home from the USDC at the account's address on Aave's chain, and the bitcoin from the
 * collateral there (WBTC or WETH: everything at the address but the USDC). A token with nothing there is left out.
 */
export function moveSources(
  key: MoveKey,
  near: { token: KnownToken; amount: string | null }[],
  wallet: { token: string; symbol: string; decimals: number; amount: string }[],
): { token: KnownToken; held: bigint }[] {
  const some = (amount: string | null): bigint => (amount !== null && /^\d+$/.test(amount) ? BigInt(amount) : 0n);
  const leaves = key === 'bitcoin-out' ? 'nBTC' : key === 'ether-out' ? 'ETH' : 'USDC';
  const list =
    MOVES[key].move === 'to_evm'
      ? near.filter((b) => b.token.symbol === leaves).map((b) => ({ token: b.token, held: some(b.amount) }))
      : wallet
          // The loan comes home from the USDC there; ETH from the WETH; bitcoin from any collateral, as before.
          .filter((t) => (key === 'loan-home' ? t.symbol === 'USDC' : key === 'ether-home' ? t.symbol === 'WETH' : t.symbol !== 'USDC'))
          .map((t) => ({ token: { id: t.token, symbol: t.symbol, decimals: t.decimals }, held: some(t.amount) }));
  return list.filter((s) => s.held > 0n);
}

// ---------- asking 1Click about a listed transfer ----------

/** A move this browser started: what 1Click's status is asked by. */
export interface StartedMove {
  account: string;
  id: string;
  depositAddress: string;
  depositMemo: string | null;
}

export const MOVES_STORAGE_KEY = 'pb:moves';
const REMEMBERED = 20;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function readMoves(store: Store): StartedMove[] {
  try {
    const list = JSON.parse(store.getItem(MOVES_STORAGE_KEY) ?? '[]') as unknown;
    return Array.isArray(list) ? (list.filter((m) => m && typeof m.account === 'string' && typeof m.id === 'string' && typeof m.depositAddress === 'string') as StartedMove[]) : [];
  } catch {
    return [];
  }
}

/** Remembers a committed quote under its transfer id, in this browser: the newest 20. Never throws. */
export function rememberMove(store: Store, move: StartedMove): void {
  try {
    const rest = readMoves(store).filter((m) => !(m.account === move.account && m.id === move.id));
    store.setItem(MOVES_STORAGE_KEY, JSON.stringify([...rest, move].slice(-REMEMBERED)));
  } catch {
    // private mode: the status then shows only for moves whose deposit address is their own
  }
}

export function recallMove(store: Store, account: string, id: string): StartedMove | null {
  return readMoves(store).find((m) => m.account === account && m.id === id) ?? null;
}

/**
 * What to ask 1Click's status by, for a listed transfer. A move that leaves NEAR has a deposit address of its own, so
 * the account's record is enough. One that leaves Hyperliquid or Aave's chain goes to 1Click's one address there and
 * is told apart by a memo the account doesn't keep: only the browser that started it knows. Null when the page can't ask.
 */
export function statusQuery(transfer: ListedTransfer, remembered: StartedMove | null): { depositAddress: string; depositMemo: string | null } | null {
  // What the browser remembers counts only if it is about this transfer: the same deposit address as the account lists.
  if (remembered && remembered.depositAddress.toLowerCase() === transfer.dep.toLowerCase()) return { depositAddress: remembered.depositAddress, depositMemo: remembered.depositMemo };
  if ((transfer.kind === 'to_evm' || transfer.kind === 'to_hl') && transfer.dep) return { depositAddress: transfer.dep, depositMemo: null };
  return null;
}
