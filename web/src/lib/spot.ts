// Spot (INTERFACES.md 49.1 point 3, 49.2 and 49.3): swapping one token of the account for another, laid out as NEAR
// Intents' swap screen is: "You pay", "You receive", a token picker, the price as the amount is typed, one Swap button.
//   - The tokens come from GET /api/spot/tokens: about 25, each with 1Click's real price.
//   - The price comes from POST /api/quote with `swap` and `dry: true`, 400 ms after the last keystroke.
//   - Swap commits the quote (`dry: false`) and sends the account's next call as the quote's `next` says: a `withdraw`
//     to 1Click's deposit address (our stand-in's on testnet). Selling a token other than USDC, the call carries
//     `transfer: {"kind": "sell", "exp", "expect"}`, so the account records the sale; paying in USDC it is a plain
//     withdraw, and the token bought arrives as a deposit.
//   - NEAR Intents has no testnet. A token that has no test token here still shows its real price, and one line
//     stands where the Swap button would be.
// This file is the plain part: every reading of an answer and every sum, with no React in it.
import type { QuoteAnswer } from './api.ts';
import { timeWords } from './moves.ts';
import type { SessionState } from './session.ts';
import { buildMove, withdrawTx, type Tx } from './tx.ts';
import type { Intent } from './types.ts';
import { displayUnits, formatDollars, formatUnits, parseUnits } from './units.ts';

// ---------- the words every visitor reads ----------

/** Under the title: what the page is. */
export const ABOUT_LINE = 'Swap tokens inside your account. Prices come from NEAR Intents.';
/** Added on testnet (INTERFACES.md 49.2). */
export const TESTNET_LINE = 'On testnet our own stand-in carries the swap, at Intents’ real prices.';
/** In place of the Swap button, for a pair that can't swap on testnet (INTERFACES.md 49.2). Never a button that fails. */
export const MAINNET_LINE = 'This pair trades on mainnet. On testnet you see its real price.';
/** Under the box: where bought tokens sit. */
export const SITS_LINE = 'Tokens you buy stay in your account. The ones marked “counts toward loans” raise what you can borrow.';
/** The mark on a token the engine counts as collateral (`lendable`). */
export const LENDABLE_MARK = 'counts toward loans';
/** The one calm line when the price route doesn't answer (it may not be live yet). */
export const NO_PRICE_LINE = 'The live price isn’t answering right now. The page keeps trying.';
/** The one calm line when the token list doesn't answer. */
export const NO_TOKENS_LINE = 'The token list isn’t answering right now. The page keeps trying.';

/** The lines under the title, for a network. */
export const aboutLines = (network: 'mainnet' | 'testnet'): string[] => (network === 'testnet' ? [ABOUT_LINE, TESTNET_LINE] : [ABOUT_LINE]);

// ---------- the token list ----------

/** One row of GET /api/spot/tokens (INTERFACES.md 49.3), as the backend names its fields. */
export interface SpotToken {
  /** The coin's own name on the screen: BTC, ETH, NEAR, USDC. */
  symbol: string;
  name: string;
  /** Dollars for one whole token, from 1Click; null when it gave none. */
  price_usd: number | null;
  on_intents: boolean;
  intents_asset: string | null;
  /** The token's id on NEAR in the account's settings; null for a token with no test token here. */
  token_id: string | null;
  decimals: number;
  /** A swap of this token completes here. False: the page shows its real price and the mainnet line. */
  swaps_here: boolean;
  /** The engine counts it toward loans. */
  lendable: boolean;
  /**
   * Not in INTERFACES.md 49.3. If the backend ever adds the account's balance to a row (the token's own units), the
   * page reads it when GET /api/account's balances don't list the token.
   */
  balance?: string | null;
}

/** "About 25 tokens" (INTERFACES.md 49.1): the page shows no more than this, whatever the backend sends. */
export const MAX_TOKENS = 25;

const digits = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** A price as a positive number, from a number or a string of one; anything else is no price. */
function priceOf(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The tokens of GET /api/spot/tokens, in the backend's order (USDC and USDT, then the biggest market first), at most 25. A row with no symbol
 * or no whole number of decimals is left out: the page couldn't name it or count it. A second row with a symbol
 * already seen is left out too. A token counts as swapping here only when the row says so and names its id on NEAR.
 */
export function readTokens(answer: unknown): SpotToken[] {
  const list = (answer as { tokens?: unknown } | null | undefined)?.tokens;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const tokens: SpotToken[] = [];
  for (const row of list) {
    if (tokens.length === MAX_TOKENS) break;
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const symbol = text(r.symbol);
    if (!symbol || seen.has(symbol.toUpperCase())) continue;
    if (typeof r.decimals !== 'number' || !Number.isInteger(r.decimals) || r.decimals < 0 || r.decimals > 36) continue;
    seen.add(symbol.toUpperCase());
    const tokenId = text(r.token_id);
    tokens.push({
      symbol,
      name: text(r.name) ?? symbol,
      price_usd: priceOf(r.price_usd),
      on_intents: r.on_intents !== false,
      intents_asset: text(r.intents_asset),
      token_id: tokenId,
      decimals: r.decimals,
      swaps_here: r.swaps_here === true && tokenId !== null,
      lendable: r.lendable === true,
      ...(digits(r.balance) && { balance: r.balance }),
    });
  }
  return tokens;
}

/** The path the page reads the list by: with the account once the page may read it, so the ids are that account's. */
export const tokensPath = (account?: string | null): string => (account ? `/api/spot/tokens?account=${encodeURIComponent(account)}` : '/api/spot/tokens');

/** INTERFACES.md 49.2: nBTC shows as BTC and wNEAR as NEAR, if the backend sends the token's own name. */
export function shownSymbol(symbol: string): string {
  if (symbol === 'nBTC') return 'BTC';
  if (symbol === 'wNEAR') return 'NEAR';
  return symbol;
}

/** The USDC token: paying with it is a plain withdraw, and selling anything else is a `sell`. */
export const isUsdc = (token: Pick<SpotToken, 'symbol'>): boolean => token.symbol === 'USDC';

const sameToken = (a: SpotToken, b: SpotToken): boolean => a.symbol.toUpperCase() === b.symbol.toUpperCase();

/** A token of the list by its symbol, whatever the case; null when it isn't there. */
export function tokenBy(tokens: SpotToken[], symbol: string | null | undefined): SpotToken | null {
  if (!symbol) return null;
  return tokens.find((t) => t.symbol.toUpperCase() === symbol.toUpperCase()) ?? null;
}

/** What the box opens with: pay USDC, receive bitcoin. Without them, the first two tokens that swap here, else the first two. */
export function defaultPair(tokens: SpotToken[]): { pay: string | null; receive: string | null } {
  const here = tokens.filter((t) => t.swaps_here);
  const pay = tokenBy(tokens, 'USDC') ?? here[0] ?? tokens[0] ?? null;
  const others = (list: SpotToken[]) => list.filter((t) => !pay || !sameToken(t, pay));
  const receive = tokenBy(others(tokens), 'BTC') ?? tokenBy(others(tokens), 'nBTC') ?? others(here)[0] ?? others(tokens)[0] ?? null;
  return { pay: pay?.symbol ?? null, receive: receive?.symbol ?? null };
}

// ---------- balances ----------

/** One row of GET /api/account's `balances`. */
export interface Held {
  token: string;
  amount: string | null;
}

/**
 * How much of a token the account holds, in the token's own units. Null when the page doesn't know: no account was
 * read (a visitor), the token has no id here, or neither the account's balances nor the row names it.
 */
export function heldUnits(token: SpotToken, balances: Held[] | null | undefined): bigint | null {
  if (!balances || !token.token_id) return null;
  const row = balances.find((b) => b.token === token.token_id);
  if (row && digits(row.amount)) return BigInt(row.amount);
  return digits(token.balance) ? BigInt(token.balance) : null;
}

/** Whole tokens as a float, for display and for rates only: never for an amount that is sent. */
const whole = (units: string | bigint, decimals: number): number => Number(BigInt(units)) / 10 ** decimals;

/** An amount's dollar value at the token's price; null without a price. */
export function usdValue(units: string | bigint, token: SpotToken): number | null {
  return token.price_usd === null ? null : whole(units, token.decimals) * token.price_usd;
}

/** A token with what the account holds of it. */
export interface TokenRow {
  token: SpotToken;
  /** Null when the page doesn't know (see `heldUnits`). */
  held: bigint | null;
  usd: number | null;
}

/**
 * The picker's order: the tokens the account holds first, the most dollars first (one with no price after those with
 * one), then the rest in the backend's order.
 */
export function orderTokens(tokens: SpotToken[], balances: Held[] | null | undefined): TokenRow[] {
  const rows = tokens.map((token, at) => {
    const held = heldUnits(token, balances);
    return { token, held, usd: held === null ? null : usdValue(held, token), at };
  });
  const has = (row: { held: bigint | null }) => row.held !== null && row.held > 0n;
  const mine = rows.filter(has).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || a.at - b.at);
  const rest = rows.filter((row) => !has(row));
  return [...mine, ...rest].map(({ token, held, usd }) => ({ token, held, usd }));
}

/** The rows the account holds something of, and their dollar total (the tokens with a price). */
export function holdings(rows: TokenRow[]): { rows: TokenRow[]; total: number } {
  const mine = rows.filter((row) => row.held !== null && row.held > 0n);
  return { rows: mine, total: mine.reduce((sum, row) => sum + (row.usd ?? 0), 0) };
}

/**
 * The picker's search, by symbol and by name, whatever the case. A symbol that starts with what was typed comes
 * first, then a symbol that holds it, then a name that holds it; inside each the order stays. Nothing typed: every row.
 */
export function searchTokens(rows: TokenRow[], query: string): TokenRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  const rank = (row: TokenRow): number => {
    const symbols = [row.token.symbol.toLowerCase(), shownSymbol(row.token.symbol).toLowerCase()];
    if (symbols.some((s) => s.startsWith(q))) return 0;
    if (symbols.some((s) => s.includes(q))) return 1;
    return row.token.name.toLowerCase().includes(q) ? 2 : 3;
  };
  return rows
    .map((row, at) => ({ row, at, rank: rank(row) }))
    .filter((entry) => entry.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map((entry) => entry.row);
}

// ---------- amounts ----------

/** What was typed in "You pay", read with the token's decimals. */
export interface PayAmount {
  /** The token's own units; null while nothing countable is typed. */
  units: string | null;
  /** What is wrong with the text, in words; null when nothing is. */
  problem: string | null;
  /** More than the account holds. The price still shows; the Swap button says so and doesn't send. */
  over: boolean;
}

/**
 * Reads the amount typed. Nothing, or zero, is no amount and no problem: the box just shows no price yet. `held` is
 * what the account holds, or null when the page doesn't know, and then nothing is "too much".
 */
export function readPay(typed: string, token: SpotToken | null, held: bigint | null): PayAmount {
  if (!token || !typed.trim()) return { units: null, problem: null, over: false };
  let units: string;
  try {
    units = parseUnits(typed, token.decimals);
  } catch (error) {
    return { units: null, problem: (error as Error).message, over: false };
  }
  if (units === '0') return { units: null, problem: null, over: false };
  return { units, problem: null, over: held !== null && BigInt(units) > held };
}

/** Units as text for the amount field: exact, no grouping, cut (never rounded up) to `maxFraction` places. */
export function fieldText(units: string | bigint, decimals: number, maxFraction = decimals): string {
  const [int, fraction = ''] = formatUnits(units, decimals).split('.');
  const kept = fraction.slice(0, Math.max(0, maxFraction)).replace(/0+$/, '');
  return kept ? `${int}.${kept}` : int!;
}

/** Max: all the account holds of the token, exactly. */
export const maxText = (held: bigint, token: SpotToken): string => fieldText(held, token.decimals);

/**
 * Units for reading: thousands grouped, cut to about `significant` figures and never fewer than two decimals where
 * the token has them. "97412500000" of a 6-decimal token is "97,412.5"; "10265" of an 8-decimal one is "0.00010265".
 */
export function showUnits(units: string | bigint, decimals: number, significant = 6): string {
  const [int, fraction = ''] = formatUnits(units, decimals).replace('-', '').split('.');
  const leadingZeros = fraction.length - fraction.replace(/^0+/, '').length;
  const places = int === '0' ? leadingZeros + significant : Math.max(2, significant - int!.length);
  return displayUnits(units, decimals, Math.min(places, decimals));
}

/** A plain number for reading (a rate, an estimate): grouped, to about `significant` figures. */
export function showNumber(value: number, significant = 6): string {
  if (!Number.isFinite(value)) return '?';
  if (value === 0) return '0';
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const places = magnitude >= 0 ? Math.max(2, significant - magnitude - 1) : Math.min(18, significant - magnitude - 1);
  return value.toLocaleString('en-US', { maximumFractionDigits: places });
}

/** "0.001 BTC": an amount with its token's name on the screen. */
export const amountWords = (units: string | bigint, token: SpotToken, significant = 6): string => `${showUnits(units, token.decimals, significant)} ${shownSymbol(token.symbol)}`;

/** The figures an amount that is swapped shows with: the box and "You received" say the same number. */
export const SWAP_FIGURES = 8;

/** A token's price for reading: "$97,412.50", and for one under a dollar about four figures, "$0.1525". */
export function priceWords(price: number | null): string {
  if (price === null) return 'no price';
  return price >= 1 ? formatDollars(price) : `$${showNumber(price, 4)}`;
}

/** An estimate (whole tokens, a float) as text for the amount field: at most 8 decimals, and no more than the token has. */
export function estimateText(amount: number, decimals: number): string {
  if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e21) return '';
  const fixed = amount.toFixed(Math.min(decimals, 8));
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return trimmed === '0' ? '' : trimmed;
}

/** The hues of the five tokens that swap here, picked so that they read apart: orange, indigo, blue, teal, green. */
const HUES: Record<string, number> = { BTC: 32, ETH: 232, USDC: 212, USDT: 172, NEAR: 140 };

/** A colour for a token's round mark, the same every time for the same symbol: a hue from 0 to 359. */
export function tokenHue(symbol: string): number {
  const name = shownSymbol(symbol).toUpperCase();
  if (name in HUES) return HUES[name]!;
  let sum = 7;
  for (const letter of name) sum = (sum * 131 + letter.charCodeAt(0) * 17) % 360;
  return sum;
}

// ---------- the rate ----------

export interface Rate {
  /** What one whole token paid buys of the token received. */
  rate: number;
  /** The other way round: what one whole token received costs in the token paid. */
  inverse: number;
}

const rateFrom = (rate: number): Rate | null => (Number.isFinite(rate) && rate > 0 ? { rate, inverse: 1 / rate } : null);

/** The rate a quote gives: what arrives over what leaves, each counted by its token's decimals. */
export function quoteRate(amountIn: string, amountOut: string, pay: SpotToken, receive: SpotToken): Rate | null {
  if (!digits(amountIn) || !digits(amountOut) || BigInt(amountIn) === 0n) return null;
  return rateFrom(whole(amountOut, receive.decimals) / whole(amountIn, pay.decimals));
}

/** The rate the two tokens' own prices give, for a pair with no quote: a visitor's, or one that can't swap here. */
export function priceRate(pay: SpotToken, receive: SpotToken): Rate | null {
  if (pay.price_usd === null || receive.price_usd === null) return null;
  return rateFrom(pay.price_usd / receive.price_usd);
}

/** "1 BTC = 97,412.5 USDC", or the other way round when `inverted`. */
export function rateWords(rate: Rate, pay: SpotToken, receive: SpotToken, inverted = false): string {
  return inverted
    ? `1 ${shownSymbol(receive.symbol)} = ${showNumber(rate.inverse)} ${shownSymbol(pay.symbol)}`
    : `1 ${shownSymbol(pay.symbol)} = ${showNumber(rate.rate)} ${shownSymbol(receive.symbol)}`;
}

/**
 * The rate as the box first shows it: the dearer token's price in the other, "1 BTC = 97,412.5 USDC", whichever of
 * the two is paid. `turned` is the other way round: the rate is a button that turns it.
 */
export function shownRate(rate: Rate, pay: SpotToken, receive: SpotToken, turned = false): string {
  return rateWords(rate, pay, receive, rate.rate >= 1 ? turned : !turned);
}

/** What an amount would buy at the two tokens' prices, in whole tokens, and its dollars. An estimate: no quote backs it. */
export function estimateOut(units: string, pay: SpotToken, receive: SpotToken): { amount: number; usd: number } | null {
  const rate = priceRate(pay, receive);
  if (!rate || !digits(units) || pay.price_usd === null) return null;
  const paid = whole(units, pay.decimals);
  return { amount: paid * rate.rate, usd: paid * pay.price_usd };
}

// ---------- whether a pair swaps here ----------

/** Where a pair stands before any quote: a token is missing, both are the same, it can't swap on testnet, or it can. */
export type Pair = 'pick' | 'same' | 'mainnet' | 'here';

export function pairState(pay: SpotToken | null, receive: SpotToken | null): Pair {
  if (!pay || !receive) return 'pick';
  if (sameToken(pay, receive)) return 'same';
  return pay.swaps_here && receive.swaps_here ? 'here' : 'mainnet';
}

/** The line that stands where the Swap button would be, for a pair that can't be swapped; null for one that can. */
export function pairLine(pair: Pair): string | null {
  if (pair === 'pick') return 'Pick the token you pay with and the token you receive.';
  if (pair === 'same') return 'Pick two different tokens.';
  return pair === 'mainnet' ? MAINNET_LINE : null;
}

// ---------- the quote ----------

/** The body of POST /api/quote for a swap (INTERFACES.md 49.3). `amount` is in the paying token's own units. */
export interface SwapBody {
  dry: boolean;
  account: string;
  amount: string;
  swap: { from: string; to: string };
}

/** Null unless both tokens have an id here: the route names a token by its id. */
export function swapBody(input: { dry: boolean; account: string; pay: SpotToken; receive: SpotToken; units: string }): SwapBody | null {
  if (!input.pay.token_id || !input.receive.token_id) return null;
  return { dry: input.dry, account: input.account, amount: input.units, swap: { from: input.pay.token_id, to: input.receive.token_id } };
}

/** The parts of a swap's quote the page reads. */
export interface SwapQuote {
  amountIn: string;
  amountOut: string;
  minAmountOut: string | null;
  inUsd: number | null;
  outUsd: number | null;
  /** Seconds from the deposit to the delivery, by the quote's own estimate. */
  seconds: number | null;
  /** On a committed quote: where the tokens go, and until when the price holds. */
  depositAddress: string | null;
  depositMemo: string | null;
  deadlineMs: number | null;
  /** The account's next call, as the backend wrote it: `swapCall` reads it. */
  next: unknown;
  /** The check to run first, as the backend wrote it. */
  needsCheck: unknown;
  /** The pending transfer the account will record for a sale (`move:<n>`), when the backend names it. */
  transferId: string | null;
  /** False only when the answer itself says this pair can't swap here. */
  swapsHere: boolean;
}

const dollarsOf = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Reads the answer of POST /api/quote for a swap: 1Click's quote, with the account's next call, the check and the
 * sale's id under `swap` (services/api/src/spot.ts, postSwapQuote). INTERFACES.md 49.3 names no key, and a move's
 * sit under `move`, so a key missing from `swap` is read from `move`, then from the answer's own top. Null when the
 * answer has no countable quote.
 */
export function readQuote(answer: unknown): SwapQuote | null {
  const a = (answer ?? {}) as Record<string, unknown>;
  const q = a.quote as Partial<QuoteAnswer['quote']> | null | undefined;
  if (!q || typeof q !== 'object' || !digits(q.amountIn) || !digits(q.amountOut)) return null;
  const part = (key: string): Record<string, unknown> => (a[key] && typeof a[key] === 'object' ? (a[key] as Record<string, unknown>) : {});
  const meta = { ...a, ...part('move'), ...part('swap') };
  const deadline = typeof q.deadline === 'string' ? Date.parse(q.deadline) : NaN;
  return {
    amountIn: q.amountIn,
    amountOut: q.amountOut,
    minAmountOut: digits(q.minAmountOut) ? q.minAmountOut : null,
    inUsd: dollarsOf(q.amountInUsd),
    outUsd: dollarsOf(q.amountOutUsd),
    seconds: typeof q.timeEstimate === 'number' && Number.isFinite(q.timeEstimate) && q.timeEstimate > 0 ? q.timeEstimate : null,
    depositAddress: text(q.depositAddress),
    depositMemo: text(q.depositMemo),
    deadlineMs: Number.isFinite(deadline) ? deadline : null,
    next: meta.next ?? null,
    needsCheck: meta.needs_check ?? null,
    transferId: text(meta.transfer_id),
    swapsHere: meta.swaps_here !== false,
  };
}

/** What a swap costs: the dollars that leave less the dollars that arrive, by the quote's own figures, and its share. */
export function swapCost(quote: Pick<SwapQuote, 'inUsd' | 'outUsd'>): { cost: number; share: number } | null {
  if (quote.inUsd === null || quote.outUsd === null || quote.inUsd <= 0) return null;
  const cost = Math.max(0, quote.inUsd - quote.outUsd);
  return { cost, share: cost / quote.inUsd };
}

/** "$0.15 (0.15%)", or that the quote gives no dollar figures. */
export function costWords(quote: Pick<SwapQuote, 'inUsd' | 'outUsd'>): string {
  const cost = swapCost(quote);
  return cost ? `${formatDollars(cost.cost)} (${(cost.share * 100).toFixed(2)}%)` : 'not given by this quote';
}

/** "About 20 seconds", by the quote's own estimate. */
export const swapTimeWords = (quote: Pick<SwapQuote, 'seconds'>): string => {
  const words = timeWords(quote.seconds);
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A refusal of the price route, as the page takes it. */
export interface QuoteProblem {
  /** `mainnet`: the pair can't be carried here, so the mainnet line shows. `quiet`: the route isn't answering. `said`: the backend's own reason. */
  kind: 'mainnet' | 'quiet' | 'said';
  line: string;
}

/**
 * The backend's codes for "this pair can't be carried on testnet" (services/api/src/spot.ts, postSwapQuote):
 * `not_here`, a token that isn't one of the account's own, and `same_asset`, the same token on both sides. A refusal
 * whose own words say "mainnet" counts too, whatever its code.
 */
const NOT_HERE_CODES = ['not_here', 'same_asset'];

/**
 * A refusal of POST /api/quote in the page's words. A pair the stand-in can't carry gets the mainnet line. A route
 * that isn't there yet (404), a backend that is down, or a server error gets one calm line. Anything else is the
 * backend's own sentence, which it writes for the client.
 */
export function quoteProblem(error: { status: number; code: string; message: string }): QuoteProblem {
  if (NOT_HERE_CODES.includes(error.code) || (error.status >= 400 && error.status < 500 && error.status !== 404 && /\bmainnet\b/i.test(error.message))) {
    return { kind: 'mainnet', line: MAINNET_LINE };
  }
  if (error.status === 0 || error.status === 404 || error.status >= 500 || error.code === 'backend_down' || error.code === 'offline' || error.code === 'http_error') {
    return { kind: 'quiet', line: NO_PRICE_LINE };
  }
  return { kind: 'said', line: error.message };
}

/** What the box knows of the price for what is typed: the quote, and the refusal when there is one. */
export interface Priced {
  quote: SwapQuote | null;
  problem: QuoteProblem | null;
}

/**
 * The price route's answer as the box takes it. A quote that says its pair can't swap here keeps its figures, so the
 * real price shows, with the mainnet line. An answer with no countable quote counts as the route not answering.
 */
export function pricedFrom(result: { ok: true; answer: unknown } | { ok: false; status: number; code: string; message: string }): Priced {
  if (!result.ok) return { quote: null, problem: quoteProblem(result) };
  const quote = readQuote(result.answer);
  if (!quote) return { quote: null, problem: { kind: 'quiet', line: NO_PRICE_LINE } };
  return { quote, problem: quote.swapsHere ? null : { kind: 'mainnet', line: MAINNET_LINE } };
}

// ---------- what stands under the box: the Swap button, or the line in its place ----------

/** Where the page is with the account it would swap for. */
export type AccountStand = 'reading' | 'unread' | 'none' | 'not_yours' | 'not_owner' | 'ready';

export type Slot =
  /** No button: one line says why. `home` adds a way to Home, where an account is opened. */
  | { kind: 'line'; line: string; home?: boolean }
  /** Still loading: a quiet placeholder. */
  | { kind: 'wait' }
  /** No wallet: prices show, and swapping needs one. */
  | { kind: 'sign_in' }
  /** Privacy level 1 (INTERFACES.md 48.6): the wallet confirms it is the owner's first. */
  | { kind: 'confirm' }
  /** The Swap button. Not `ready`: it shows and can't be pressed, and `hint` says what is missing. */
  | { kind: 'swap'; ready: boolean; hint: string | null };

/**
 * Where the page is with the account, from what the account's read gave (hooks/use-client-account.ts). `read` is the
 * backend's answer for the account, or null while there is none; `named` is whether the page has an account's name to
 * ask by at all.
 */
export function accountStand(input: { notYours: boolean; read: { exists: boolean; hasState: boolean } | null; isOwner: boolean; finding: boolean; named: boolean; failed: boolean }): AccountStand {
  if (input.notYours) return 'not_yours';
  if (input.read) return !input.read.exists || !input.read.hasState ? 'none' : input.isOwner ? 'ready' : 'not_owner';
  if (input.finding) return 'reading';
  if (!input.named) return 'none';
  return input.failed ? 'unread' : 'reading';
}

/**
 * The line where the balances would be, while the page has none to show; null once it has. `tokens` is how many
 * tokens the list has: with none, the page can't name or price what the account holds, and says the list is why.
 */
export function balancesLine(input: { wallet: boolean; session: 'checking' | SessionState; account: AccountStand; tokens: number }): string | null {
  if (!input.wallet) return 'Sign in to see what your account holds.';
  if (input.session === 'needs_sign_in') return 'Confirm your wallet to see what your account holds.';
  if (input.account === 'ready' || input.account === 'not_owner') return input.tokens === 0 ? NO_TOKENS_LINE : null;
  if (input.account === 'none') return 'Nothing yet. Open your account on Home first.';
  if (input.account === 'not_yours') return NOT_YOURS_LINE;
  return input.account === 'unread' ? ACCOUNT_UNREAD_LINE : 'Reading your account…';
}

export const NO_ACCOUNT_LINE = 'You have no account yet. Open one on Home, then come back to swap.';
export const NOT_YOURS_LINE = 'This account belongs to another wallet.';
export const NOT_OWNER_LINE = 'Only the account’s owner can swap.';
export const ACCOUNT_UNREAD_LINE = 'Your account isn’t answering right now. The page keeps trying.';

/**
 * What stands under the box. In this order:
 *   1. no token list: a placeholder while it loads, one calm line if it didn't answer;
 *   2. a pair that isn't one, or can't swap on testnet: the line, for everyone, and never a button
 *      (INTERFACES.md 49.2), also when the price route itself says the stand-in can't carry the pair;
 *   3. no wallet: "sign in"; a wallet that hasn't confirmed it is the owner's: "confirm" (INTERFACES.md 48.6);
 *   4. no account, another wallet's, or not the owner's: the line;
 *   5. the Swap button, which can be pressed only with an amount the account holds and a price for it.
 */
export function slotFor(input: {
  tokens: number;
  listFailed: boolean;
  pair: Pair;
  wallet: 'loading' | 'none' | 'connected';
  session: 'checking' | SessionState;
  account: AccountStand;
  amount: PayAmount;
  /** The paying token and what the account holds of it, for the "not enough" line. */
  pay: SpotToken | null;
  held: bigint | null;
  asking: boolean;
  priced: Priced | null;
}): Slot {
  if (input.tokens === 0) return input.listFailed ? { kind: 'line', line: NO_TOKENS_LINE } : { kind: 'wait' };
  const line = pairLine(input.pair);
  if (line) return { kind: 'line', line };
  if (input.priced?.problem?.kind === 'mainnet') return { kind: 'line', line: MAINNET_LINE };
  if (input.wallet === 'loading') return { kind: 'wait' };
  if (input.wallet === 'none' || input.session === 'no_wallet') return { kind: 'sign_in' };
  if (input.session === 'checking') return { kind: 'wait' };
  if (input.session === 'needs_sign_in') return { kind: 'confirm' };
  if (input.account === 'reading') return { kind: 'wait' };
  if (input.account === 'unread') return { kind: 'line', line: ACCOUNT_UNREAD_LINE };
  if (input.account === 'not_yours') return { kind: 'line', line: NOT_YOURS_LINE };
  if (input.account === 'none') return { kind: 'line', line: NO_ACCOUNT_LINE, home: true };
  if (input.account === 'not_owner') return { kind: 'line', line: NOT_OWNER_LINE };

  const off = (hint: string): Slot => ({ kind: 'swap', ready: false, hint });
  if (input.amount.problem) return off(input.amount.problem);
  if (!input.amount.units) return off('Enter an amount to see the price.');
  if (input.amount.over) return off(input.pay && input.held !== null ? `You have ${amountWords(input.held, input.pay)} in your account.` : 'That is more than your account holds.');
  if (input.asking || !input.priced) return off('Getting the price…');
  if (input.priced.problem) return off(input.priced.problem.line);
  return input.priced.quote ? { kind: 'swap', ready: true, hint: null } : off('Getting the price…');
}

// ---------- the wallet's call ----------

/** A sale's record on the account (contracts/account/src/plan.rs, `Move`): its kind, the quote's expiry, and what should arrive. */
export interface SellTransfer {
  kind: 'sell';
  exp: number;
  expect?: { token: string; amount: string };
}

export type SwapCall =
  /** `receiver` is 1Click's deposit address for this swap: its status is asked by it. `transfer` is the sale's record, null for a USDC payment. */
  | { tx: Tx; check: Intent | null; transfer: SellTransfer | null; receiver: string; problem: null }
  | { tx: null; check: null; transfer: null; receiver: null; problem: string };

/** What every refusal before the wallet ends with: nothing left the account, and what to do. */
export const NOTHING_SENT = 'Nothing was sent. Try again for a new price.';
const unsent = (problem: string): SwapCall => ({ tx: null, check: null, transfer: null, receiver: null, problem });
const refuse = (what: string): SwapCall => unsent(`${what} ${NOTHING_SENT}`);

/**
 * The transaction the wallet approves for a committed quote, built from the quote's `next` exactly: the account's
 * `withdraw(token, amount, receiver, transfer?)` with 1 yoctoNEAR (services/api/src/spot.ts, postSwapQuote).
 *   - Selling a token other than USDC, `next` carries `transfer: {"kind": "sell", "exp"}`, with `expect` when the
 *     quote names what arrives. The account then lists the sale until its delivery settles it.
 *   - Paying in USDC, `next` is a plain withdraw to the deposit address, with no `transfer`: the account refuses a
 *     `sell` of its USDC. The token bought arrives as a deposit.
 *   - A sale whose `next` carries no `transfer` goes out as the plain withdraw it is: the backend writes it so for an
 *     account that records no moves, and has the delivery arrive as a deposit.
 * Anything else isn't sent, and the reason comes back in a sentence: a `next` that is missing or isn't a withdraw,
 * one for another token than the one paid with, one for more than was typed, one to another address than the quote's
 * own, a `transfer` of any other kind or on a USDC payment, a price that has run out, and a quote that expires more
 * than 24 hours ahead (INTERFACES.md 40.1).
 *
 * `check` is the check to run first, when the quote names one (`needs_check`, while the account owes our pool): a
 * withdrawal of this call's own token and amount, which is what the account compares the check with.
 */
export function swapCall(account: string, quote: SwapQuote, pay: SpotToken, askedUnits: string, nowMs: number): SwapCall {
  const next = quote.next as { method?: unknown; args?: Record<string, unknown> } | null;
  if (!next || typeof next !== 'object' || next.method !== 'withdraw' || !next.args || typeof next.args !== 'object') {
    return refuse('The price came back without the account’s next step.');
  }
  const { token, amount, receiver } = next.args;
  if (typeof token !== 'string' || !digits(amount) || amount === '0' || typeof receiver !== 'string' || !receiver) {
    return refuse('The price came back without the account’s next step.');
  }
  if (token !== pay.token_id) return refuse('The price is for another token than the one you are paying with.');
  if (!digits(askedUnits) || BigInt(amount) > BigInt(askedUnits)) return refuse('The price asks for more than you typed.');
  if (quote.depositAddress && receiver !== quote.depositAddress) return refuse('The price names two different addresses to send to.');

  const raw = next.args.transfer as { kind?: unknown; exp?: unknown; expect?: { token?: unknown; amount?: unknown } | null } | null | undefined;
  let transfer: SellTransfer | null = null;
  if (raw !== undefined && raw !== null) {
    if (isUsdc(pay)) return refuse('The price’s next step isn’t the one a swap paid in USDC takes.');
    if (typeof raw !== 'object' || raw.kind !== 'sell' || typeof raw.exp !== 'number' || !Number.isFinite(raw.exp)) {
      return refuse('The price’s next step isn’t the one a swap takes.');
    }
    if (raw.exp <= nowMs) return refuse('This price ran out before the swap was sent.');
    const expect = raw.expect && typeof raw.expect.token === 'string' && digits(raw.expect.amount) ? { token: raw.expect.token, amount: raw.expect.amount } : null;
    transfer = { kind: 'sell', exp: raw.exp, ...(expect && { expect }) };
  }
  if (quote.deadlineMs !== null && quote.deadlineMs <= nowMs) return refuse('This price ran out before the swap was sent.');

  // lib/tx.ts builds the withdraw (its gas, its 1 yoctoNEAR) and refuses a quote that expires more than 24 hours
  // ahead. It passes the `sell` record on as it is, with its `expect`.
  const built = buildMove(() => withdrawTx(account, token, amount, receiver, transfer ?? undefined, nowMs));
  if (!built.tx) return unsent(built.problem);
  return { tx: built.tx, check: swapCheck(quote, token, amount), transfer, receiver, problem: null };
}

/**
 * One click holds the price and sends, so nobody reads the held price before the wallet opens. This is the guard for
 * that: the price on screen came with "You receive at least" (`minAmountOut`, the price less the slippage the quote
 * allows), and a held price that delivers less than that is not sent. Null when the held price is within it, or when
 * the price on screen named no such floor.
 */
export function priceMoved(shown: Pick<SwapQuote, 'minAmountOut'> | null, held: Pick<SwapQuote, 'amountOut'>, receive: SpotToken): string | null {
  if (!shown?.minAmountOut || BigInt(held.amountOut) >= BigInt(shown.minAmountOut)) return null;
  return `The price moved as you pressed Swap: you would now receive ${amountWords(held.amountOut, receive, SWAP_FIGURES)}, less than the ${amountWords(shown.minAmountOut, receive, SWAP_FIGURES)} the box promised. ${NOTHING_SENT}`;
}

/** The check a swap needs first: the quote's `needs_check`, when it names a withdrawal, for the call's token and amount. */
export function swapCheck(quote: SwapQuote, token: string, amount: string): Intent | null {
  const asked = quote.needsCheck as { withdraw?: unknown } | null;
  if (!asked || typeof asked !== 'object' || !asked.withdraw || typeof asked.withdraw !== 'object') return null;
  return { withdraw: { token, amount } };
}

/** The wallet said no, or never opened: in a sentence, with what to do. */
export function walletProblem(error: unknown): string {
  const said = error instanceof Error ? error.message : String(error);
  return /reject|cancel|denied|closed/i.test(said)
    ? 'You closed the wallet before approving, so nothing was sent: press Approve to open it again.'
    : `The wallet didn’t send the swap (${said}), so nothing left your account: press Approve to try again.`;
}

/** A sentence, closed with a full stop if it has none. */
const sentence = (words: string): string => (/[.!?…]$/.test(words.trim()) ? words.trim() : `${words.trim()}.`);

/**
 * Swap was pressed and the price couldn't be held (the committed quote was refused, or didn't come): one sentence
 * of what happened, and what to do. The backend's own reason is kept when it gave one.
 */
export function holdProblem(error: { status: number; code: string; message: string }): string {
  const problem = quoteProblem(error);
  if (problem.kind === 'mainnet') return problem.line;
  if (problem.kind === 'quiet') return `The price couldn’t be held just now. ${NOTHING_SENT}`;
  return `${sentence(problem.line)} Nothing was sent.`;
}

/** The wallet sent the call and the account refused it, in the contract's own words: nothing was swapped. */
export function refusedWords(failure: string): string {
  return `Your account didn’t send the tokens, so nothing was swapped. Its reason: ${sentence(failure.replace(/^Smart contract panicked: /, ''))} Try again for a new price.`;
}

/** The button a swap's check and approval run under: "Swap 0.001 BTC for USDC". */
export const swapLabel = (units: string | bigint, pay: SpotToken, receive: SpotToken): string => `Swap ${amountWords(units, pay)} for ${shownSymbol(receive.symbol)}`;

// ---------- following the swap ----------

/** Where a swap stands after the account's call: by 1Click's status for its deposit address. */
export type SwapStage = 'waiting' | 'swapping' | 'received' | 'returned' | 'failed';

export function swapStage(status: string | null | undefined): SwapStage | null {
  switch (status) {
    case 'PENDING_DEPOSIT':
      return 'waiting';
    case 'KNOWN_DEPOSIT_TX':
    case 'PROCESSING':
      return 'swapping';
    case 'SUCCESS':
      return 'received';
    case 'REFUNDED':
    case 'INCOMPLETE_DEPOSIT':
      return 'returned';
    case 'FAILED':
      return 'failed';
    default:
      return null;
  }
}

/** A status that never changes again: the page stops asking. */
export const swapSettled = (status: string | null | undefined): boolean => ['received', 'returned', 'failed'].includes(swapStage(status) ?? '');

/** The parts of GET /api/status the page reads (services/oneclick-client/src/types.ts, `StatusResponse`). */
export interface SwapStatusAnswer {
  status?: string;
  swapDetails?: { amountOut?: string; refundedAmount?: string; refundReason?: string } | null;
}

/** What arrived: the status's own figure once it has one, else the quote's, which is then "about". */
export function receivedUnits(status: SwapStatusAnswer | null | undefined, quote: Pick<SwapQuote, 'amountOut'>): { units: string; exact: boolean } {
  const out = status?.swapDetails?.amountOut;
  return digits(out) && out !== '0' ? { units: out, exact: true } : { units: quote.amountOut, exact: false };
}

export interface StatusWords {
  stage: SwapStage | null;
  /** One sentence: what happened, and after a failure what to do. */
  line: string;
  tone: 'neutral' | 'good' | 'warn' | 'bad';
  done: boolean;
}

/**
 * A swap's status in one sentence. `paid` and `received` are amounts with their tokens ("0.001 BTC", "97.41 USDC");
 * `exact` is whether `received` is the status's own figure; `recorded` is whether the account lists the swap as a
 * sale under way, which only a sale of a token other than USDC is.
 */
export function statusWords(status: string | null | undefined, swap: { paid: string; received: string; exact: boolean; recorded: boolean }): StatusWords {
  const stage = swapStage(status);
  switch (stage) {
    case 'waiting':
      return { stage, line: `Your ${swap.paid} is on its way to the swap.`, tone: 'neutral', done: false };
    case 'swapping':
      return { stage, line: `Swapping your ${swap.paid}. This takes a moment.`, tone: 'neutral', done: false };
    case 'received':
      return { stage, line: `You received ${swap.exact ? '' : 'about '}${swap.received}. It is in your account.`, tone: 'good', done: true };
    case 'returned':
      return {
        stage,
        line:
          status === 'INCOMPLETE_DEPOSIT'
            ? `Less than the ${swap.paid} reached the swap in time, so what came was sent back to your account. Check your balance, then swap again.`
            : `The swap didn’t go through, and your ${swap.paid} came back to your account. You can swap again.`,
        tone: 'warn',
        done: true,
      };
    case 'failed':
      return {
        stage,
        line: swap.recorded
          ? `The swap failed and your ${swap.paid} hasn’t come back. Home lists it under “Money on its way”: once its deadline has passed, drop it there.`
          : `The swap failed and your ${swap.paid} hasn’t come back. Nothing else left your account: look at Activity for the transfer before you swap again.`,
        tone: 'bad',
        done: true,
      };
    default:
      return { stage: null, line: `Your ${swap.paid} left your account. Asking where the swap stands.`, tone: 'neutral', done: false };
  }
}
