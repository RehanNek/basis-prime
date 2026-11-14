// The Basis trade page (INTERFACES.md 49.1, point 5): hold a coin, short the same amount on Hyperliquid, borrow dollars
// against both; and "Close everything", the way out in one guided run. This file is the decisions and the words, as
// pure functions: which tokens can be picked, the steps of opening and where the account stands in them, the next
// step of closing, and what a failure says. Every decision is made from what the account really holds and owes, read
// again before each step, so a reload or a failure resumes at the right place.
import type { AccountAnswer, LenderAccountAnswer, MarketCoin } from './api.ts';
import { collateralAt, evmStatus, microUsd, walletToken } from './evm.ts';
import { pendingLender, planRunning } from './fund.ts';
import { toMicro } from './funding.ts';
import { coinTradingNow, notTradingWords } from './hl-reach.ts';
import { agentApproved, hlFunded, hlSummary, loanOpen, type HlAnswer } from './hl.ts';
import { lenderExtra, lenderPayoff, poolExtra } from './loan.ts';
import { etherToken, type MoveStage } from './moves.ts';
import { isOverdue, pendingTransfers } from './risk.ts';
import { held, testCollateralStep } from './setup.ts';

// ---------- the tokens ----------

/** The perp that hedges each token an account can hold. A token shows only when the account's settings list it. */
export const HEDGES: Record<string, { coin: string; name: string }> = {
  nBTC: { coin: 'BTC', name: 'Bitcoin' },
  ETH: { coin: 'ETH', name: 'Ether' },
  wNEAR: { coin: 'NEAR', name: 'NEAR' },
};

/** One token of an account's (or the factory's) settings: `get_config().tokens`. */
export interface SettingsToken {
  id: string;
  symbol: string;
  decimals: number;
}

/** The token a basis trade holds, and the coin it shorts. */
export interface BasisToken extends SettingsToken {
  coin: string;
}

export interface BasisOption extends BasisToken {
  /** "BTC (Bitcoin)". */
  label: string;
  /** Hyperliquid's price for the coin, in dollars; null when it wasn't read. */
  price: number | null;
  /** Hyperliquid's size step for the coin, in decimals. */
  szDecimals: number;
  /** How far an order's price may sit from the reference, in basis points. */
  bandBp: number;
  usable: boolean;
  /** Why it can't be picked, when it can't. */
  why: string | null;
  /**
   * INTERFACES.md 50.4: can a short in this coin open (and close) on Hyperliquid now? False while testnet's own price
   * for it stands too far from its reference price for any order to be taken (lib/hl-reach.ts). Always true on mainnet.
   */
  tradesNow: boolean;
  /** Why not, in one line with what to do; null while it can. */
  whyNotNow: string | null;
}

/** The tokens of a config answer (`tokens` of the factory's or an account's `get_config()`), or null when it has none. */
export function settingsTokens(config: unknown): SettingsToken[] | null {
  const tokens = (config as { tokens?: unknown } | null | undefined)?.tokens;
  if (!Array.isArray(tokens)) return null;
  const out = tokens.flatMap((t) => {
    const { id, symbol, decimals } = (t ?? {}) as Record<string, unknown>;
    return typeof id === 'string' && typeof symbol === 'string' && typeof decimals === 'number' ? [{ id, symbol, decimals }] : [];
  });
  return out.length > 0 ? out : null;
}

/**
 * The tokens the page offers: those the settings list that a perp can hedge, in the order BTC, ETH, NEAR. Nothing the
 * settings don't list is ever offered. `readable` is the symbols whose balance the page can read (the backend's
 * `balances`): a token it can't read is shown and can't be picked, since every step is decided from the holding.
 */
export function basisTokens(settings: SettingsToken[] | null | undefined, readable: string[], coins: MarketCoin[] | undefined, testnet = true): BasisOption[] {
  const out: BasisOption[] = [];
  for (const [symbol, hedge] of Object.entries(HEDGES)) {
    const token = (settings ?? []).find((t) => t.symbol === symbol);
    if (!token) continue;
    const market = coins?.find((c) => c.coin === hedge.coin);
    const listed = market?.testnet && !market.testnet.delisted ? market.testnet : null;
    const oracle = Number(listed?.oracle_px ?? NaN);
    const mark = Number(listed?.mark_px ?? NaN);
    const price = Number.isFinite(oracle) ? oracle : Number.isFinite(mark) ? mark : null;
    let why: string | null = null;
    if (!readable.includes(symbol)) why = `This page can’t read the account’s ${hedge.coin} yet, so it can’t lead this trade.`;
    else if (coins && !listed) why = `${hedge.coin} isn’t listed on Hyperliquid right now, so it can’t be shorted.`;
    else if (market && !market.allowed) why = `${hedge.coin} isn’t on the broker’s list of coins.`;
    const trading = coinTradingNow(listed ? market : null, testnet);
    out.push({
      ...token,
      coin: hedge.coin,
      label: `${hedge.coin} (${hedge.name})`,
      price,
      szDecimals: listed?.sz_decimals ?? market?.universe_sz_decimals ?? 0,
      bandBp: market?.band_bp ?? 0,
      usable: why === null,
      why,
      tradesNow: trading.ok,
      whyNotNow: notTradingWords(hedge.coin, trading, 'coin'),
    });
  }
  return out;
}

// ---------- sizes and amounts ----------

/** The demo's size in dollars: about what 0.015 BTC is worth, and enough for the pool to lend against. */
export const DEFAULT_VALUE_USD = 1_150;
/** Our pool lends against $1,000 of collateral or more. */
export const MIN_VALUE_TO_BORROW = 1_000_000_000n;
/** USDC kept on NEAR when the margin moves to Hyperliquid, as the demo keeps it. */
export const KEEP_ON_NEAR = 10_000_000n;
/** Hyperliquid opens an address on a first deposit of at least $10 (INTERFACES.md 8). */
export const FIRST_DEPOSIT_MIN = 10_000_000n;
/**
 * Margin as a share of the short's value: 25% (the user, 14 Nov: "have the basis trade move less margin"; it was 38%,
 * the demo's $430 for a $1,140 short). The 1Click stand-in delivers the margin from a stock of about $785 on
 * Hyperliquid testnet, so at 38% one trade could be open at a time, and at 25% two.
 * Why 25% and not less: the engine was run on a $1,150 trade in BTC, ETH and NEAR at seven shares from 38% to 10%
 * (14 Nov). The loan it offers doesn't move with the share. With a loan open it asks for more margin (REBALANCE) from
 * 10% down for ETH and 12% down for NEAR on a calm day, and from about 25% and 29% down on the most volatile day it
 * allows for. And under 25% its stress tests see the ETH or NEAR short closed out, which halves the room between the
 * account's worth and what the loan needs. At 25% nothing is worse than at 38% on a calm day, for all three coins.
 */
export const MARGIN_SHARE_BP = 2_500;

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** A sensible first size: about $1,150 of the coin, cut to two figures and to Hyperliquid's size step. "0.015" for BTC. */
export function defaultSize(price: number | null, szDecimals: number): string {
  if (price === null || !(price > 0)) return '';
  const raw = DEFAULT_VALUE_USD / price;
  const figures = Math.floor(Math.log10(raw));
  const step = 10 ** (figures - 1);
  const cut = Math.floor(raw / step + 1e-9) * step;
  const decimals = Math.max(0, Math.min(szDecimals, 1 - figures));
  const text = cut.toFixed(decimals);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** The size typed, in the token's own units, or what is wrong with it. Hyperliquid takes sizes in steps of `szDecimals`. */
export function readSize(text: string, token: { decimals: number }, szDecimals: number): { units: bigint | null; problem: string | null } {
  const clean = text.trim();
  if (!clean) return { units: null, problem: null };
  const match = /^(\d*)(?:\.(\d*))?$/.exec(clean);
  if (!match || (match[1] === '' && !match[2])) return { units: null, problem: 'Enter a size, like 0.015' };
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  const most = Math.min(szDecimals, token.decimals);
  if (fraction.length > most) return { units: null, problem: most === 0 ? 'Hyperliquid takes whole numbers of this coin' : `Hyperliquid takes at most ${most} decimal places for this coin` };
  const units = BigInt(match[1] || '0') * pow10(token.decimals) + BigInt(fraction.padEnd(token.decimals, '0') || '0');
  if (units === 0n) return { units: null, problem: 'Enter a size above 0' };
  return { units, problem: null };
}

/** What `units` of a token is worth, in micro-USD, at `price` dollars a coin. Display and sizing only. */
export function valueMicro(units: bigint, decimals: number, price: number | null): bigint | null {
  if (price === null || !(price > 0)) return null;
  return BigInt(Math.round((Number(units) / 10 ** decimals) * price * 1e6));
}

/** The margin a short of this value starts with: 25% of it (`MARGIN_SHARE_BP`), rounded up to $10, and at least $20. */
export function marginFor(value: bigint): bigint {
  const share = (value * BigInt(MARGIN_SHARE_BP)) / 10_000n;
  const rounded = ((share + 9_999_999n) / 10_000_000n) * 10_000_000n;
  return rounded > 20_000_000n ? rounded : 20_000_000n;
}

/** Is what sits on Hyperliquid enough margin for a short worth `value`? Three quarters of the starting margin, or more. */
export const marginEnough = (hlEquity: bigint, value: bigint): boolean => hlEquity * 4n >= marginFor(value) * 3n;

/**
 * What the collateral step adds (on testnet, minted): the coin up to the size picked, and USDC for the margin with
 * $10 that stays on NEAR. What the account already holds counts, and so does what already sits on Hyperliquid: an
 * address with enough margin needs none, and one with a little left from an earlier trade needs only the rest (at
 * least $10, the least that can move).
 */
export function collateralPlan(input: { sizeUnits: bigint; heldUnits: bigint; usdcHeld: bigint; value: bigint; hlEquity: bigint }): { coin: bigint; usdc: bigint } {
  const coin = input.sizeUnits > input.heldUnits ? input.sizeUnits - input.heldUnits : 0n;
  const missing = marginFor(input.value) - input.hlEquity;
  const wanted = marginEnough(input.hlEquity, input.value) ? 0n : (missing > FIRST_DEPOSIT_MIN ? missing : FIRST_DEPOSIT_MIN) + KEEP_ON_NEAR;
  return { coin, usdc: wanted > input.usdcHeld ? wanted - input.usdcHeld : 0n };
}

/** Margin to move: all the account's USDC but $10, and at least Hyperliquid's $10 first deposit. Null when there is too little. */
export function marginToMove(usdc: bigint): bigint | null {
  const amount = usdc - KEEP_ON_NEAR;
  return amount >= FIRST_DEPOSIT_MIN ? amount : usdc >= FIRST_DEPOSIT_MIN ? usdc : null;
}

/**
 * The loan the page suggests. The engine's own figure when a check has given one; before any check, 40% of what the
 * coin is worth, down to $10, which a hedged book of this size has always been lent. Null under $1,000 of collateral.
 */
export function suggestedLoan(input: { estimate: bigint | null; coinValue: bigint | null }): bigint | null {
  if (input.estimate !== null && input.estimate > 0n) return (input.estimate / 10_000n) * 10_000n;
  if (input.coinValue === null || input.coinValue < MIN_VALUE_TO_BORROW) return null;
  return ((input.coinValue * 4n) / 10n / 10_000_000n) * 10_000_000n;
}

// ---------- opening: the steps, from the account's real state ----------

export type OpenKey = 'account' | 'collateral' | 'address' | 'margin' | 'agent' | 'approve' | 'short' | 'aave' | 'loan';

export interface OpenInput {
  token: Pick<BasisToken, 'symbol' | 'coin'>;
  account: AccountAnswer | undefined;
  hl: HlAnswer | undefined;
  lender: LenderAccountAnswer | null | undefined;
  testnet: boolean;
  /** `on` from GET /api/evm/gas: whether the backend can hand out test collateral for Aave. */
  helperOn: boolean | undefined;
  nowMs: number;
  /**
   * What the coin in the account (or the size picked, before it is there) is worth, in micro-USD. With it, the margin
   * step is done only when Hyperliquid holds enough for a short of that size: a dollar left there by an earlier
   * trade is not margin. Without it, any USDC on Hyperliquid counts, as on Home's checklist.
   */
  value?: bigint | null;
  /** The client passed the Aave step over: the loan then comes without Aave. */
  skipAave?: boolean;
  /**
   * INTERFACES.md 51.14: this trade is added on top of what the account already had. The coin, the short and the
   * loan are then done once the account has that much MORE than `base` shows. Without it (a first trade) each step
   * is done by what the account holds at all, as before.
   */
  base?: TradeBase | null;
}

// ---------- another trade, on top of what the account has (INTERFACES.md 51.14) ----------

/**
 * Where the account stood when another trade was started, and that trade's size. The user, 14 Nov: "i want to place a
 * second third or fourth basis trade and i want the flow like as if i had zero basis trades". An account has one
 * book, so "another trade" is more of the coin, a bigger short and a bigger loan: the page remembers where it
 * started and counts from there. Amounts of the coin are in the token's own units; `owed` is micro-USD.
 */
export interface TradeBase {
  symbol: string;
  decimals: number;
  /** The new trade's size. */
  sizeUnits: bigint;
  /** What the account held of the coin, and was short, when the trade was started. */
  heldUnits: bigint;
  shortUnits: bigint;
  /** What it owed in all, to our pool and to lenders. */
  owed: bigint;
  startedMs: number;
}

/** How long a started trade is gone on with. After that the page takes the account as it finds it. */
export const BASE_KEEP_MS = 6 * 60 * 60_000;

/** The account's short in a coin on Hyperliquid, in the token's own units. 0 with none, and for a long. */
export function shortUnitsOf(hl: HlAnswer | undefined, coin: string, decimals: number): bigint {
  const position = hl?.hyperliquid ? hlSummary(hl.hyperliquid).positions.find((p) => p.coin === coin && p.side === 'short') : undefined;
  return position ? BigInt(Math.round(Math.abs(position.size) * 10 ** decimals)) : 0n;
}

/** Everything the account owes now, to our pool and to its lenders, as the page can see it. */
export function owedInAll(account: AccountAnswer | undefined, lender: LenderAccountAnswer | null | undefined): bigint {
  const side = lenderSide(lender);
  return toMicro(account?.debt ?? account?.state?.loan.principal ?? 0) + side.aaveDebt + side.rheaDebt;
}

/** The account as it stands, as the starting point of a trade of `sizeUnits`. */
export function tradeBase(input: { token: Pick<BasisToken, 'symbol' | 'coin' | 'decimals'>; sizeUnits: bigint; account: AccountAnswer | undefined; hl: HlAnswer | undefined; lender: LenderAccountAnswer | null | undefined; nowMs: number }): TradeBase {
  const { token } = input;
  return {
    symbol: token.symbol,
    decimals: token.decimals,
    sizeUnits: input.sizeUnits,
    heldUnits: held(input.account, token.symbol),
    shortUnits: shortUnitsOf(input.hl, token.coin, token.decimals),
    owed: owedInAll(input.account, input.lender),
    startedMs: input.nowMs,
  };
}

/**
 * Does a remembered trade still fit the account? Only while the account is open and still has the short it had when
 * the trade was started. After "Close everything", or on another account under the same name, it doesn't: the page
 * then takes the account as it finds it.
 */
export function baseStands(base: TradeBase, account: AccountAnswer | undefined, hl: HlAnswer | undefined, coin: string): boolean {
  return Boolean(account?.state) && base.shortUnits > 0n && shortUnitsOf(hl, coin, base.decimals) >= base.shortUnits;
}

/** The short the account has once the added trade is open, in the token's units: what it had, and the new size. */
export const shortTarget = (base: TradeBase): bigint => base.shortUnits + base.sizeUnits;

/** Is the new short there? 99% of its size counts, so a size cut to Hyperliquid's step still does. */
export const shortAdded = (base: TradeBase, shortNow: bigint): boolean => shortNow >= base.shortUnits + (base.sizeUnits * 99n) / 100n;

/**
 * Has a new loan been taken since the trade was started? What is owed grows by itself, by the second, so a little
 * more is not a loan: it counts from $5 more, or 0.1% of what was owed when that is larger.
 */
export function loanAdded(base: TradeBase, owedNow: bigint): boolean {
  const drift = base.owed / 1_000n;
  return owedNow >= base.owed + (drift > 5_000_000n ? drift : 5_000_000n);
}

/**
 * The margin an added trade moves to Hyperliquid: what the whole short will need, less what already sits there, at
 * least Hyperliquid's $10, and no more than the account's USDC. Null when the account holds under $10 of USDC.
 * On a first trade the page moves all the USDC it added but $10 (`marginToMove`); an account that is adding a trade
 * may hold USDC of its own, which stays where it is.
 */
export function marginToAdd(input: { totalValue: bigint; hlEquity: bigint; usdcHeld: bigint }): bigint | null {
  const missing = marginFor(input.totalValue) - input.hlEquity;
  const wanted = missing > FIRST_DEPOSIT_MIN ? missing : FIRST_DEPOSIT_MIN;
  if (wanted <= input.usdcHeld) return wanted;
  return input.usdcHeld >= FIRST_DEPOSIT_MIN ? input.usdcHeld : null;
}

/**
 * On testnet the margin that arrives on Hyperliquid comes out of one float of test USDC that every visitor shares
 * (about $775 on 14 Nov), so one trade's margin is $500 at most: a trade of about $2,000.
 */
export const TESTNET_MARGIN_MAX = 500_000_000n;

/**
 * Why a trade can't be opened on testnet, or null: the margin it has to move (`needed`, micro-USD) is more than the
 * shared float carries in one move. A first trade moves its whole margin; an added one, what the bigger short still lacks.
 */
export function marginTooLarge(needed: bigint | null, testnet: boolean): string | null {
  if (!testnet || needed === null || needed <= TESTNET_MARGIN_MAX) return null;
  return 'On testnet a trade can be about $2,000 at most: its margin comes out of test USDC on Hyperliquid that everyone trying the app shares.';
}

/** A started trade as text for the browser's own store, and back. Anything that isn't one reads as null. */
export function baseToText(base: TradeBase): string {
  return JSON.stringify({ ...base, sizeUnits: base.sizeUnits.toString(), heldUnits: base.heldUnits.toString(), shortUnits: base.shortUnits.toString(), owed: base.owed.toString() });
}

export function baseFromText(text: string | null | undefined, nowMs: number): TradeBase | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const digits = (v: unknown): bigint | null => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null);
    const [size, heldBefore, shortBefore, owed] = [digits(raw.sizeUnits), digits(raw.heldUnits), digits(raw.shortUnits), digits(raw.owed)];
    if (typeof raw.symbol !== 'string' || typeof raw.decimals !== 'number' || typeof raw.startedMs !== 'number') return null;
    if (size === null || size === 0n || heldBefore === null || shortBefore === null || owed === null) return null;
    if (nowMs - raw.startedMs > BASE_KEEP_MS || raw.startedMs > nowMs + 60_000) return null;
    return { symbol: raw.symbol, decimals: raw.decimals, sizeUnits: size, heldUnits: heldBefore, shortUnits: shortBefore, owed, startedMs: raw.startedMs };
  } catch {
    return null;
  }
}

/**
 * INTERFACES.md 51.2: on an ETH trade, for an account whose own settings list test ETH, the Aave step offers the
 * client's own ETH beside the faucet's test collateral. On any other trade the step is the faucet's, as before.
 */
export const offersOwnEther = (coin: string, listsEther: boolean, testnet: boolean): boolean => testnet && listsEther && coin === 'ETH';

/** How much of the client's ETH that offer moves: the stand-in's cap of 0.02, or all the account holds when that is less. As text for the amount field. */
export function ownEtherAmount(heldUnits: bigint, decimals: number): string {
  const cap = (2n * pow10(decimals)) / 100n;
  const units = heldUnits < cap ? heldUnits : cap;
  const whole = units / pow10(decimals);
  const fraction = (units % pow10(decimals)).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export type OpenMark = 'done' | 'current' | 'waiting' | 'todo';

export interface OpenStepView {
  key: OpenKey;
  title: string;
  mark: OpenMark;
}

export interface OpenView {
  steps: OpenStepView[];
  /** The first step that isn't done, or null when the trade is open and borrowed against. */
  next: OpenKey | null;
  /** The next step is already under way (margin on its way, or the loan's steps running): the page waits, and sends nothing. */
  waiting: boolean;
  complete: boolean;
  /** Why this account can't open the trade at all, when it can't. */
  blocked: string | null;
}

export function openTitle(key: OpenKey, coin: string): string {
  switch (key) {
    case 'account':
      return 'Open your account';
    case 'collateral':
      return `Put the ${coin} and the margin in your account`;
    case 'address':
      return 'Create your Hyperliquid address';
    case 'margin':
      return 'Move the margin to Hyperliquid';
    case 'agent':
      return 'Connect the trading agent';
    case 'approve':
      return 'Approve the trading agent on Hyperliquid';
    case 'short':
      return `Short the same amount of ${coin}`;
    case 'aave':
      return 'Get test collateral for Aave';
    default:
      return 'Borrow dollars against both';
  }
}

/** Does the account owe anything, to our pool or to a lender? A lender's part is read as `lenderSide` reads it. */
function borrowed(account: AccountAnswer | undefined, lender: LenderAccountAnswer | null | undefined): boolean {
  const state = account?.state;
  if (!state) return false;
  const side = lenderSide(lender);
  return toMicro(account?.debt ?? state.loan.principal) > 0n || side.aaveDebt > 0n || side.rheaDebt > 0n;
}

/**
 * Where the account stands in opening the trade. Each step is done or not by what the chain and Hyperliquid show now:
 * nothing is remembered. A step whose effect is on its way (USDC moving to Hyperliquid, a loan's steps running) is
 * `waiting`, so the page never sends it twice.
 */
export function openSteps(input: OpenInput): OpenView {
  const { token, account, hl, lender } = input;
  const state = account?.state ?? null;
  const transfers = pendingTransfers(state?.pending);
  const toHl = transfers.some((t) => t.kind === 'to_hl');
  const summary = hl?.hyperliquid ? hlSummary(hl.hyperliquid) : null;
  // INTERFACES.md 51.14: an added trade counts from where the account stood when it was started.
  const base = input.base && input.base.symbol === token.symbol ? input.base : null;
  const short = base ? shortAdded(base, shortUnitsOf(hl, token.coin, base.decimals)) : (summary?.positions ?? []).some((p) => p.coin === token.coin && p.side === 'short');
  const equity = BigInt(Math.max(0, Math.round((summary?.equity ?? 0) * 1e6)));
  // Margin is there once the short is open, or Hyperliquid holds enough for it.
  const funded = short || (hl ? hlFunded(hl.hyperliquid) && (input.value == null || marginEnough(equity, input.value)) : false);
  const owes = borrowed(account, lender);
  const loanOnItsWay = planRunning(lender?.funding, input.nowMs);
  const coinThere = base ? held(account, token.symbol) >= base.heldUnits + base.sizeUnits : held(account, token.symbol) > 0n;
  const loanThere = base ? loanAdded(base, owedInAll(account, lender)) : owes;
  const test = testCollateralStep({ testnet: input.testnet, lender, skipped: input.skipAave === true, helperOn: input.helperOn });

  const done: Record<OpenKey, boolean> = {
    account: state !== null,
    // The coin is there, and so is the margin: on NEAR, on its way, or already on Hyperliquid.
    collateral: state !== null && (short || (coinThere && (funded || toHl || held(account, 'USDC') >= 2n * FIRST_DEPOSIT_MIN))),
    address: state !== null && Boolean(hl?.address),
    margin: state !== null && funded,
    agent: state !== null && Boolean(hl?.hl?.agent),
    approve: state !== null && hl !== undefined && agentApproved(hl).approved === true,
    short: state !== null && short,
    // A loan that is already open doesn't wait for test collateral.
    aave: test !== 'needed' || owes || loanOnItsWay,
    loan: loanThere && !loanOnItsWay,
  };
  const keys: OpenKey[] = ['account', 'collateral', 'address', 'margin', 'agent', 'approve', 'short', ...(test ? (['aave'] as OpenKey[]) : []), 'loan'];
  const next = keys.find((key) => !done[key]) ?? null;
  const waiting = (next === 'margin' && toHl) || (next === 'loan' && loanOnItsWay);
  const steps = keys.map((key): OpenStepView => ({ key, title: openTitle(key, token.coin), mark: done[key] ? 'done' : key === next ? (waiting ? 'waiting' : 'current') : 'todo' }));
  const blocked = state !== null && hl !== undefined && !hl.gateway ? 'This account was made before trading existed, so it can’t hedge. Open a new account under another name.' : null;
  return { steps, next, waiting, complete: next === null, blocked };
}

/** What a step's amounts are, for its announcement. Each is already in words: "0.015 BTC", "$440.00". */
export interface OpenAmounts {
  coin?: string;
  usdc?: string;
  margin?: string;
  size?: string;
  loan?: string;
  permission?: boolean;
}

/**
 * What the wallet is about to ask, said before it opens. Null for a step the wallet has nothing to approve in.
 * `testnet` tokens are test tokens the page mints.
 */
export function openApproval(key: OpenKey, coin: string, amounts: OpenAmounts = {}, testnet = true): string | null {
  const ask = 'Your wallet will ask you to approve: ';
  switch (key) {
    case 'account':
      return `${ask}open your account, for 6 NEAR. About 4.7 NEAR stays in the account${amounts.permission ? ', and the same approval lets outside lenders fund part of a loan' : ''}.`;
    case 'collateral':
      return `${ask}add ${[amounts.coin, amounts.usdc].filter(Boolean).join(' and ') || `${coin} and USDC`} to your account${testnet ? ', as test tokens' : ''}.`;
    case 'address':
      return `${ask}create your account’s Hyperliquid address. It costs only the network fee.`;
    case 'margin':
      return `${ask}move ${amounts.margin ?? 'the margin'} to Hyperliquid.`;
    case 'agent':
      return `${ask}connect the trading agent, for 0.01 NEAR.`;
    case 'approve':
      return `${ask}let the trading agent place orders for this account on Hyperliquid.`;
    case 'short':
      return `Your wallet will ask you to sign: sell ${amounts.size ?? `the same amount of ${coin}`} on Hyperliquid. It is a message, with no fee.`;
    case 'aave':
      return null;
    default:
      return `${ask}borrow ${amounts.loan ?? 'the amount you pick'}.`;
  }
}

// ---------- closing: the next step, from the account's real state ----------

/**
 * INTERFACES.md 51.2: WETH at the address comes home as test ETH when the trade is in ETH: the account's own settings
 * list test ETH, and it holds ETH on NEAR or is short ETH. Anything else comes home as bitcoin, as before: the faucet's
 * WETH on a bitcoin trade stood in for bitcoin.
 */
export function comesHomeAsEther(held: Pick<CloseToken, 'symbol'>, s: Pick<CloseState, 'etherId' | 'nearTokens' | 'positions'>): boolean {
  if (held.symbol !== 'WETH' || !s.etherId) return false;
  return s.nearTokens.some((t) => t.symbol === 'ETH' && t.amount > 0n) || s.positions.some((p) => p.coin === 'ETH' && p.size > 0);
}

/** A token amount the close run acts on: on NEAR by token id, on Aave's chain by 0x address. */
export interface CloseToken {
  token: string;
  symbol: string;
  decimals: number;
  amount: bigint;
}

/** A transfer the account lists as under way, with where 1Click says it stands (null when it couldn't be asked). */
export interface CloseMove {
  id: string;
  kind: string;
  stage: MoveStage | null;
  overdue: boolean;
}

/** Everything the way out is decided from. Money is micro-USD; token amounts are in the token's own units. */
export interface CloseState {
  poolDebt: bigint;
  aaveDebt: bigint;
  rheaDebt: bigint;
  /** USDC a repayment left at Rhea as the account's plain deposit. */
  rheaDeposit: bigint;
  usdcNear: bigint;
  /** USDC at the account's address on Aave's chain: a loan from Aave arrives there, and Aave is repaid from there. */
  usdcEvm: bigint;
  /** That USDC's 0x address, or null when the address holds none of it. */
  usdcEvmToken: string | null;
  aaveHeld: CloseToken[];
  rheaHeld: CloseToken[];
  /** Collateral that is back at the address on Aave's chain, not yet home. */
  evmCollateral: CloseToken[];
  /** What the account holds on NEAR, USDC and the coin, to withdraw at the end. */
  nearTokens: CloseToken[];
  /** INTERFACES.md 51.2: test ETH's id on NEAR when the account's own settings list it; else null, or left out. */
  etherId?: string | null;
  moves: CloseMove[];
  /** The oldest transaction the account signed for Aave's chain that was never sent: its place in line, or null. */
  evmUnsent: number | null;
  /** A transaction that was sent to Aave's chain and isn't mined yet. */
  evmUnmined: boolean;
  /** Aave's chain couldn't be read, so the page doesn't know what is at the address. */
  chainUnread: boolean;
  /** A step at Rhea is still finishing. */
  lenderBusy: boolean;
  /** A loan's steps are still running. */
  planRunning: boolean;
  positions: { coin: string; side: 'long' | 'short'; size: number }[];
  /** USDC that can leave Hyperliquid now. */
  hlWithdrawable: bigint;
  /**
   * The account still counts its loan as open though the pool is owed nothing: a repayment of exactly the debt leaves
   * it so, until one comes back partly unused (INTERFACES.md 4). While it is open, USDC can't come home from Hyperliquid.
   */
  loanStillOpen: boolean;
  /** Testnet: the page can mint test USDC into the account. */
  canMint: boolean;
  /** Testnet: Aave's faucet can put 1 test USDC at the address, for a loan's interest. */
  canFaucet: boolean;
}

export type CloseStep =
  | { kind: 'stop_loan' }
  | { kind: 'wait_lender' }
  | { kind: 'send_signed'; nonce: number }
  | { kind: 'wait_mined' }
  | { kind: 'drop_move'; id: string }
  | { kind: 'check_move'; id: string }
  | { kind: 'wait_move'; id: string; moveKind: string }
  /** `amount` is what is sent: a little over `owed`, since interest grows, and the pool sends back the rest. */
  | { kind: 'repay_pool'; amount: bigint; owed: bigint }
  | { kind: 'usdc_home'; token: string; amount: bigint; needsCheck: boolean }
  | { kind: 'add_usdc'; amount: bigint; canMint: boolean }
  | { kind: 'repay_rhea'; amount: bigint }
  | { kind: 'rhea_deposit_back'; amount: bigint }
  | { kind: 'wait_chain' }
  | { kind: 'faucet_usdc'; token: string }
  | { kind: 'repay_aave'; amount: bigint; token: string }
  | { kind: 'usdc_out'; amount: bigint }
  | { kind: 'take_back'; lender: 'aave' | 'rhea'; held: CloseToken }
  /** `to`: the NEAR token it comes home as (INTERFACES.md 51.2): test ETH on an ETH trade. Left out, bitcoin, as before. */
  | { kind: 'collateral_home'; held: CloseToken; to?: string }
  | { kind: 'close_position'; coin: string; side: 'long' | 'short'; size: number }
  | { kind: 'hl_home'; amount: bigint }
  | { kind: 'withdraw'; tokens: CloseToken[] }
  | { kind: 'done' };

/** A move through 1Click isn't worth starting for less than $1. */
export const MIN_MOVE = 1_000_000n;
/** USDC left at the address, or on Hyperliquid, under $2 stays where it is: moving it costs about as much. */
export const LEFTOVER_MIN = 2_000_000n;

/** Does the USDC on NEAR pay our pool off? The debt read, and the interest of the next minutes. */
export const coversPool = (usdcNear: bigint, poolDebt: bigint): boolean => usdcNear >= poolDebt + lenderExtra(poolDebt);

/** What a move must carry so that `need` arrives: the move's cost and a little interest on top, and at least $1. */
export function moveAmount(need: bigint): bigint {
  const amount = need + need / 100n + 50_000n;
  return amount > MIN_MOVE ? amount : MIN_MOVE;
}

const least = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * The next step of "Close everything", or `done`. It is decided from the account's real state alone, so pressing the
 * button again after a reload or a failure goes on from where the account is.
 *
 * The order: first whatever is already under way (a step that is finishing, a signed transaction to send, a move on
 * its way); then the loans, our pool first when the account's USDC covers it, since repaying needs no check and with
 * the pool repaid nothing after it needs one; then the collateral back and home; the short; the USDC home from
 * Hyperliquid; and the withdrawal.
 *
 * The lesson of 13 Nov (INTERFACES.md 48.13): a move of USDC to Aave's chain stays listed until a check sees it at
 * the address. So while one is listed the step is to wait for it, then `check_move`, and never the repayment: USDC
 * spent before the check would leave the move listed until its deadline.
 */
export function nextCloseStep(s: CloseState): CloseStep {
  // 1. What is already under way.
  if (s.planRunning) return { kind: 'stop_loan' };
  if (s.lenderBusy) return { kind: 'wait_lender' };
  if (s.evmUnsent !== null) return { kind: 'send_signed', nonce: s.evmUnsent };
  if (s.evmUnmined) return { kind: 'wait_mined' };
  const move = s.moves[0];
  if (move) {
    if (move.kind === 'to_evm' && move.stage === 'arrived') return { kind: 'check_move', id: move.id };
    if (move.overdue) return { kind: 'drop_move', id: move.id };
    return { kind: 'wait_move', id: move.id, moveKind: move.kind };
  }

  // 2. Our pool. Repaying needs no check; bringing USDC home from Aave's chain while the pool is owed does.
  if (s.poolDebt > 0n) {
    if (coversPool(s.usdcNear, s.poolDebt)) return { kind: 'repay_pool', amount: least(s.usdcNear, s.poolDebt + poolExtra(s.poolDebt)), owed: s.poolDebt };
    const short = s.poolDebt + lenderExtra(s.poolDebt) - s.usdcNear;
    if (s.usdcEvmToken && s.usdcEvm >= MIN_MOVE) return { kind: 'usdc_home', token: s.usdcEvmToken, amount: least(s.usdcEvm, moveAmount(short)), needsCheck: true };
    return { kind: 'add_usdc', amount: short + 1_000_000n, canMint: s.canMint };
  }
  // Owed nothing, and still open on the account's own record: $1 sent to the pool comes straight back and closes it.
  if (s.loanStillOpen) return s.usdcNear >= MIN_MOVE ? { kind: 'repay_pool', amount: MIN_MOVE, owed: 0n } : { kind: 'add_usdc', amount: MIN_MOVE, canMint: s.canMint };

  // 3. Rhea: repaid from the USDC on NEAR. What it keeps above the debt comes back later, after its collateral.
  if (s.rheaDebt > 0n) {
    const payoff = lenderPayoff(s.rheaDebt);
    if (s.usdcNear >= payoff) return { kind: 'repay_rhea', amount: payoff };
    return { kind: 'add_usdc', amount: payoff - s.usdcNear + 1_000_000n, canMint: s.canMint };
  }

  // 4. Aave: repaid from the USDC at the address on its chain.
  if (s.chainUnread && (s.aaveDebt > 0n || s.aaveHeld.length > 0)) return { kind: 'wait_chain' };
  if (s.aaveDebt > 0n) {
    const payoff = lenderPayoff(s.aaveDebt);
    if (s.usdcEvmToken && s.usdcEvm >= payoff) return { kind: 'repay_aave', amount: payoff, token: s.usdcEvmToken };
    // Short by the interest alone: on testnet Aave's faucet adds it, with no move and no check.
    if (s.canFaucet && s.usdcEvmToken && s.usdcEvm + 1_000_000n >= payoff) return { kind: 'faucet_usdc', token: s.usdcEvmToken };
    const send = moveAmount(payoff - s.usdcEvm);
    if (s.usdcNear >= send) return { kind: 'usdc_out', amount: send };
    return { kind: 'add_usdc', amount: send - s.usdcNear, canMint: s.canMint };
  }

  // 5. The collateral: back from the lenders, then home from Aave's chain.
  const atAave = s.aaveHeld.find((h) => h.amount > 0n);
  if (atAave) return { kind: 'take_back', lender: 'aave', held: atAave };
  const atRhea = s.rheaHeld.find((h) => h.amount > 0n);
  if (atRhea) return { kind: 'take_back', lender: 'rhea', held: atRhea };
  // What a repayment left at Rhea comes back last: while it lies there, it is the sign that Rhea has been paid.
  if (s.rheaDeposit > 0n) return { kind: 'rhea_deposit_back', amount: s.rheaDeposit };
  const back = s.evmCollateral.find((h) => h.amount > 0n);
  if (back) return { kind: 'collateral_home', held: back, ...(comesHomeAsEther(back, s) ? { to: s.etherId! } : {}) };
  if (s.usdcEvmToken && s.usdcEvm >= LEFTOVER_MIN) return { kind: 'usdc_home', token: s.usdcEvmToken, amount: s.usdcEvm, needsCheck: false };

  // 6. The hedge, then its margin.
  const position = s.positions.find((p) => p.size > 0);
  if (position) return { kind: 'close_position', coin: position.coin, side: position.side, size: position.size };
  if (s.hlWithdrawable >= LEFTOVER_MIN) return { kind: 'hl_home', amount: s.hlWithdrawable };

  // 7. Out to the wallet.
  const tokens = s.nearTokens.filter((t) => t.amount > 0n);
  if (tokens.length > 0) return { kind: 'withdraw', tokens };
  return { kind: 'done' };
}

/**
 * Was the account's Hyperliquid side really read? An account with no address there has nothing to read. One with an
 * address must come with Hyperliquid's own answer: without it the page doesn't know whether a short is open, and
 * must not go on as if none were.
 */
export const hlWasRead = (hl: HlAnswer | undefined): hl is HlAnswer => hl !== undefined && (!hl.address || Boolean(hl.hyperliquid?.clearinghouse_state));

/** Dollars as Hyperliquid writes them ("442.73") in micro-USD, cut to whole cents. 0 when it can't be read. */
export function dollarsToMicro(text: string | null | undefined): bigint {
  const value = Number(text ?? NaN);
  return Number.isFinite(value) && value > 0 ? BigInt(Math.floor(value * 100 + 1e-6)) * 10_000n : 0n;
}

const amountOf = (text: unknown): bigint => (typeof text === 'string' && /^\d+$/.test(text) ? BigInt(text) : 0n);

/** The account keeps its newest 20 signed transactions: a list that long may have lost its oldest. */
const SIGNED_KEPT = 20;

/**
 * What the account owes Aave now, in micro-USD. The backend's figure (`checked`) is what the last check read, and a
 * repayment since then doesn't show in it until the next check. The account's own transactions on Aave's chain do
 * show it, in the order the chain mined them: each mined borrow adds, each mined repayment takes off, never below
 * zero, since Aave takes only what it is owed. So when the list holds the whole story and nothing is left, nothing is
 * owed, whatever the last check said; and no check is needed to see it.
 *
 * When the list can't tell (no borrow on it, or it is full and may have lost its oldest), the check's figure stands.
 */
export function aaveOwed(checked: bigint, signed: { nonce: number; kind: string; amount?: string | null; status: unknown }[], usdcDecimals = 6): bigint {
  const mined = signed.filter((e) => evmStatus(e.status) === 'mined').sort((a, b) => a.nonce - b.nonce);
  if (signed.length >= SIGNED_KEPT || !mined.some((e) => e.kind === 'borrow')) return checked;
  let owed = 0n;
  for (const entry of mined) {
    const amount = microUsd(amountOf(entry.amount), usdcDecimals);
    if (entry.kind === 'borrow') owed += amount;
    else if (entry.kind === 'repay') owed = owed > amount ? owed - amount : 0n;
  }
  if (owed === 0n) return 0n;
  return checked > owed ? checked : owed;
}

/**
 * The account at its lenders, as it stands now. What is posted comes from each lender's own books, so it is right
 * now. What is owed is what the last check read (INTERFACES.md 48.13: "stale after the repayment"), so it is set
 * against what the page can see for itself: a lender lends only against what is posted with it, so with nothing
 * posted nothing is owed; Rhea keeps what a repayment sent above the debt as a deposit, so while that lies there Rhea
 * has been paid; and Aave's own chain shows each borrow and repayment (`aaveOwed`).
 */
export function lenderSide(lender: LenderAccountAnswer | null | undefined): { aaveDebt: bigint; rheaDebt: bigint; rheaDeposit: bigint; aaveHeld: CloseToken[]; rheaHeld: CloseToken[] } {
  const evm = lender?.evm?.address ? lender.evm : null;
  const chainUnread = Boolean(evm?.chain_error);
  const position = (l: string) => (lender?.lenders ?? []).find((p) => p.l === l);
  const tokens = (list: { token: string; symbol: string; decimals: number; amount: string }[] | undefined): CloseToken[] =>
    (list ?? []).map((h) => ({ token: h.token, symbol: h.symbol, decimals: h.decimals, amount: amountOf(h.amount) })).filter((h) => h.amount > 0n);
  const aaveHeld = tokens(evm?.posted?.length ? evm.posted : position('aave')?.held);
  const rheaHeld = tokens(position('rhea')?.held);
  const rheaDeposit = toMicro(position('rhea')?.deposit);
  const signed = chainUnread ? [] : (evm?.signed ?? []);
  const aaveChecked = toMicro(position('aave')?.debt);
  return {
    aaveDebt: aaveHeld.length === 0 && !chainUnread ? 0n : aaveOwed(aaveChecked, signed, walletToken(evm, 'USDC')?.decimals ?? 6),
    rheaDebt: rheaHeld.length === 0 || rheaDeposit > 0n ? 0n : toMicro(position('rhea')?.debt),
    rheaDeposit,
    aaveHeld,
    rheaHeld,
  };
}

/**
 * The close state, from the backend's three reads of the account and 1Click's word on each listed move. `stages` is
 * each listed transfer's stage by its id, where the page could ask.
 */
export function closeStateFrom(input: {
  account: AccountAnswer;
  hl: HlAnswer | undefined;
  lender: LenderAccountAnswer | null | undefined;
  stages?: Record<string, MoveStage | null>;
  nowMs: number;
  testnet: boolean;
  helperOn?: boolean;
}): CloseState {
  const { account, hl, lender, nowMs } = input;
  const state = account.state;
  const evm = lender?.evm?.address ? lender.evm : null;
  const chainUnread = Boolean(evm?.chain_error);
  const evmUsdc = walletToken(evm, 'USDC');
  const { aaveDebt, rheaDebt, rheaDeposit, aaveHeld, rheaHeld } = lenderSide(lender);
  const signed = chainUnread ? [] : (evm?.signed ?? []);
  const unsent = signed.filter((e) => evmStatus(e.status) === 'signed').sort((a, b) => a.nonce - b.nonce)[0];
  const listed = pendingLender(state?.pending);
  const clearing = hl?.hyperliquid?.clearinghouse_state;
  const poolDebt = toMicro(account.debt ?? state?.loan.principal);
  // A unified Hyperliquid account keeps its USDC in spot: what is free there can leave when perps has nothing to give.
  const perps = dollarsToMicro(clearing?.withdrawable);
  const spot = dollarsToMicro(hl?.hyperliquid?.spot_usdc?.total) - dollarsToMicro(hl?.hyperliquid?.spot_usdc?.hold);
  return {
    poolDebt,
    aaveDebt,
    rheaDebt,
    rheaDeposit,
    usdcNear: held(account, 'USDC'),
    usdcEvm: evmUsdc ? microUsd(evmUsdc.amount, evmUsdc.decimals) : 0n,
    usdcEvmToken: evmUsdc && amountOf(evmUsdc.amount) > 0n ? evmUsdc.token : null,
    aaveHeld,
    rheaHeld,
    evmCollateral: collateralAt(evm).map((t) => ({ token: t.token, symbol: t.symbol, decimals: t.decimals, amount: amountOf(t.amount) })),
    nearTokens: account.balances.map((b) => ({ token: b.token, symbol: b.symbol, decimals: b.decimals, amount: amountOf(b.amount) })).filter((b) => b.amount > 0n),
    // Null while the ETH moves are switched off (lib/moves.ts, ETHER_MOVES_ON): WETH then comes home as bitcoin, as before.
    etherId: etherToken(account.balances)?.id ?? null,
    moves: pendingTransfers(state?.pending).map((t) => ({ id: t.id, kind: t.kind, stage: input.stages?.[t.id] ?? null, overdue: isOverdue(t, nowMs) })),
    evmUnsent: unsent ? unsent.nonce : null,
    evmUnmined: signed.some((e) => evmStatus(e.status) === 'sent'),
    chainUnread,
    // Rhea's wait has a last block; the account drops the entry only at its next call, so a passed block counts as finished.
    lenderBusy: Boolean(listed && listed.until_block !== null && account.block_height <= listed.until_block),
    planRunning: planRunning(lender?.funding, nowMs),
    positions: hl?.hyperliquid ? hlSummary(hl.hyperliquid).positions.map((p) => ({ coin: p.coin, side: p.side, size: p.size })) : [],
    hlWithdrawable: perps >= LEFTOVER_MIN || spot <= 0n ? perps : spot,
    loanStillOpen: poolDebt === 0n && loanOpen(state?.loan),
    canMint: input.testnet,
    canFaucet: input.testnet && input.helperOn === true,
  };
}

/** The five parts of the way out, as the page's rail shows them. */
export const CLOSE_STAGES = ['Repay the loans', 'Take the collateral back and bring it home', 'Close the short', 'Bring the USDC home from Hyperliquid', 'Withdraw to your wallet'] as const;

/** Which part a step belongs to: 0 to 4, and 5 when everything is done. A step that waits for something under way has none. */
export function closeStage(step: CloseStep): number | null {
  switch (step.kind) {
    case 'stop_loan':
    case 'repay_pool':
    case 'add_usdc':
    case 'repay_rhea':
    case 'rhea_deposit_back':
    case 'wait_chain':
    case 'faucet_usdc':
    case 'repay_aave':
    case 'usdc_out':
    case 'check_move':
      return 0;
    case 'usdc_home':
      return step.needsCheck ? 0 : 1;
    case 'take_back':
    case 'collateral_home':
      return 1;
    case 'close_position':
      return 2;
    case 'hl_home':
      return 3;
    case 'withdraw':
      return 4;
    case 'done':
      return 5;
    default:
      return null;
  }
}

const usd = (micro: bigint): string => {
  const cents = micro / 10_000n;
  return `$${(cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(cents % 100n).toString().padStart(2, '0')}`;
};

/** A token amount for a sentence: "0.02 WETH", to at most 8 places. */
export function tokenWords(t: Pick<CloseToken, 'amount' | 'decimals' | 'symbol'>): string {
  const digits = t.amount.toString().padStart(t.decimals + 1, '0');
  const whole = digits.slice(0, digits.length - t.decimals);
  const fraction = digits.slice(digits.length - t.decimals).slice(0, 8).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} ${t.symbol === 'nBTC' ? 'BTC' : t.symbol === 'wNEAR' ? 'NEAR' : t.symbol}`;
}

const lenderName = (l: string): string => (l === 'aave' ? 'Aave' : l === 'rhea' ? 'Rhea' : l);

export interface StepWords {
  /** What the step does, as its line on the rail. */
  title: string;
  /** What the wallet is about to ask, said before it opens; null when the wallet has nothing to approve. */
  approval: string | null;
  /** What happens with no approval, or after it. */
  note: string | null;
}

/** A step of the way out in plain words: its line, and what the wallet will ask before it asks. */
export function closeWords(step: CloseStep): StepWords {
  const ask = 'Your wallet will ask you to approve: ';
  switch (step.kind) {
    case 'stop_loan':
      return { title: 'Stop the loan that is still on its way', approval: `${ask}stop the loan’s remaining steps.`, note: 'What it already borrowed is repaid next.' };
    case 'wait_lender':
      return { title: 'Wait for Rhea to finish its last step', approval: null, note: 'A few seconds. Nothing to approve.' };
    case 'send_signed':
      return { title: 'Send a transaction your account already signed for Aave’s chain', approval: null, note: 'It was signed earlier and never sent. Nothing to approve.' };
    case 'wait_mined':
      return { title: 'Wait for Aave’s chain to confirm the last transaction', approval: null, note: 'Usually a few seconds. Nothing to approve.' };
    case 'drop_move':
      return { title: 'Clear a move that ran out of time', approval: `${ask}take the expired move off your account’s list. It moves no money.`, note: null };
    case 'check_move':
      return {
        title: 'Check that the USDC has arrived on Aave’s chain',
        approval: null,
        note: 'The risk engine looks at your account, so the account counts the USDC as arrived. The repayment comes after it, not before.',
      };
    case 'wait_move':
      return {
        title: step.moveKind === 'to_evm' ? 'Wait for the USDC to arrive on Aave’s chain' : step.moveKind === 'to_hl' ? 'Wait for the USDC to arrive on Hyperliquid' : 'Wait for the money to arrive in your account',
        approval: null,
        note: 'It is on its way: a few minutes at most. Nothing to approve.',
      };
    case 'repay_pool':
      return step.owed > 0n
        ? {
            title: `Repay the ${usd(step.owed)} you owe our pool`,
            approval: `${ask}repay our pool. ${usd(step.amount)} is sent, a little over the ${usd(step.owed)} you owe, because interest grows by the second. The pool sends back the rest.`,
            note: null,
          }
        : { title: 'Close the loan with our pool', approval: `${ask}send ${usd(step.amount)} to our pool. You owe it nothing, so it comes straight back, and your account then counts the loan as closed.`, note: null };
    case 'usdc_home':
      return {
        title: `Bring ${usd(step.amount)} of USDC home from Aave’s chain`,
        approval: `${ask}send ${usd(step.amount)} of USDC from your address on Aave’s chain to your account.`,
        note: step.needsCheck ? 'You still owe our pool, so the risk engine checks your account first. It takes a minute or two.' : 'It arrives in a few minutes.',
      };
    case 'add_usdc':
      return step.canMint
        ? { title: `Add ${usd(step.amount)} of test USDC to cover what you owe`, approval: `${ask}add ${usd(step.amount)} of test USDC to your account.`, note: 'Your account holds a little less USDC than it owes, because interest grows and moves cost a little.' }
        : { title: `Add ${usd(step.amount)} of USDC to cover what you owe`, approval: null, note: 'Your account holds less USDC than it owes. Add funds, then press Close everything again.' };
    case 'repay_rhea':
      return { title: `Repay Rhea ${usd(step.amount)}`, approval: `${ask}repay ${usd(step.amount)} to Rhea. It is a little over what you owe, because interest grows by the second.`, note: null };
    case 'rhea_deposit_back':
      return { title: `Bring back the ${usd(step.amount)} Rhea kept`, approval: `${ask}bring ${usd(step.amount)} of USDC back from Rhea.`, note: null };
    case 'wait_chain':
      return { title: 'Read your address on Aave’s chain', approval: null, note: 'The page can’t read Aave’s chain right now, so it doesn’t know what is there.' };
    case 'faucet_usdc':
      return { title: 'Get 1 test USDC for Aave’s interest', approval: null, note: 'Paying Aave off takes a little more than was borrowed. On testnet Aave’s faucet adds it. Nothing to approve.' };
    case 'repay_aave':
      return {
        title: `Repay Aave ${usd(step.amount)}`,
        approval: `${ask}repay ${usd(step.amount)} to Aave from your address on its chain. The first time, your wallet asks once more, to let Aave take the USDC.`,
        note: 'Aave takes only what it is owed.',
      };
    case 'usdc_out':
      return { title: `Send ${usd(step.amount)} of USDC to Aave’s chain`, approval: `${ask}send ${usd(step.amount)} of USDC to your address on Aave’s chain, to repay Aave with.`, note: 'It takes a few minutes. Then a check, then the repayment.' };
    case 'take_back':
      return {
        title: `Take ${tokenWords(step.held)} back from ${lenderName(step.lender)}`,
        approval: `${ask}take ${tokenWords(step.held)} back from ${lenderName(step.lender)}.`,
        note: step.lender === 'aave' ? 'It comes back to your address on Aave’s chain. The next step brings it home.' : null,
      };
    case 'collateral_home':
      return { title: `Bring ${tokenWords(step.held)} home from Aave’s chain`, approval: `${ask}send ${tokenWords(step.held)} from your address on Aave’s chain to your account.`, note: `It arrives as ${step.to ? 'ETH' : 'BTC'} in a few minutes.` };
    case 'close_position':
      return {
        title: `Close the ${step.side} of ${step.size} ${step.coin}`,
        approval: `Your wallet will ask you to sign: ${step.side === 'short' ? 'buy' : 'sell'} ${step.size} ${step.coin} on Hyperliquid, to close the ${step.side}. It is a message, with no fee.`,
        note: null,
      };
    case 'hl_home':
      return { title: `Bring ${usd(step.amount)} of USDC home from Hyperliquid`, approval: `${ask}send ${usd(step.amount)} of USDC from Hyperliquid to your account.`, note: 'It arrives in about a minute.' };
    case 'withdraw':
      return {
        title: 'Withdraw to your wallet',
        approval: `${ask}withdraw ${step.tokens.map((t) => (t.symbol === 'USDC' && t.decimals === 6 ? `${usd(t.amount)} of USDC` : tokenWords(t))).join(' and ')} to your wallet.`,
        note: null,
      };
    default:
      return { title: 'Everything is closed', approval: null, note: null };
  }
}

/** What "Close everything" has to deal with, one short line each. Empty when nothing is open. */
export function closeSummary(s: CloseState): string[] {
  const lines: string[] = [];
  const owed = [
    s.poolDebt > 0n ? `${usd(s.poolDebt)} to our pool` : null,
    s.aaveDebt > 0n ? `${usd(s.aaveDebt)} to Aave` : null,
    s.rheaDebt > 0n ? `${usd(s.rheaDebt)} to Rhea` : null,
  ].filter(Boolean);
  if (owed.length > 0) lines.push(`You owe ${owed.join(', ')}.`);
  const posted = [...s.aaveHeld.map((h) => `${tokenWords(h)} with Aave`), ...s.rheaHeld.map((h) => `${tokenWords(h)} with Rhea`), ...s.evmCollateral.map((h) => `${tokenWords(h)} at your address on Aave’s chain`)];
  if (posted.length > 0) lines.push(`Collateral: ${posted.join(', ')}.`);
  for (const p of s.positions) lines.push(`A ${p.side} of ${p.size} ${p.coin} is open on Hyperliquid.`);
  if (s.hlWithdrawable >= LEFTOVER_MIN) lines.push(`${usd(s.hlWithdrawable)} of USDC is on Hyperliquid.`);
  const here = s.nearTokens.map((t) => (t.symbol === 'USDC' && t.decimals === 6 ? `${usd(t.amount)} of USDC` : tokenWords(t)));
  if (here.length > 0) lines.push(`Your account holds ${here.join(' and ')}.`);
  return lines;
}

// ---------- a failure, in one sentence and what to do ----------

export interface FailureWords {
  /** What happened, in one sentence. */
  happened: string;
  /** Whether anything went out, and what to do. */
  todo: string;
  /** The button's words when "Try again" would say the wrong thing: "Sign again" for an order whose signature ran out. */
  button?: string;
}

/**
 * A failure for the client: what happened, and what to do. The raw reason (a contract's words, a server's message)
 * stays behind "Details"; nothing here uses the engine's own vocabulary.
 */
export function failureWords(raw: string): FailureWords {
  const text = raw ?? '';
  const again = 'Try again: the page goes on from where your account really is.';
  // INTERFACES.md 50.4: an order whose signed message ran out before the gateway read it, said once, with "Sign again".
  if (/signature ran out|message has expired/i.test(text)) return { happened: 'The order waited too long at the risk engine, and its signature ran out.', todo: 'Nothing was placed. Sign again.', button: 'Sign again' };
  // An order whose answer never came back: it may have been placed, so the page reads the account before anything else.
  if (/may still have reached Hyperliquid/i.test(text)) return { happened: 'The order’s answer didn’t come back.', todo: `It may still have been placed. ${again}` };
  if (/reject|cancel|denied|wallet closed|closed before/i.test(text)) return { happened: 'The wallet closed before you approved.', todo: 'Nothing was sent. Try again.' };
  if (/rate limit|429|too many requests/i.test(text)) return { happened: 'NEAR’s network is busy right now.', todo: 'Nothing was sent. Wait a minute, then try again.' };
  if (/could not reach|offline|not running|backend|HTTP 5\d\d|failed to fetch|network ?error/i.test(text)) return { happened: 'The page couldn’t reach its server.', todo: 'Nothing was sent. Try again in a moment.' };
  if (/doesn.t allow|allows (less|borrowing)|would lend|only a safe account|didn.t allow/i.test(text)) return { happened: 'The risk engine didn’t allow this step.', todo: 'Nothing was sent. Repay part of what you owe first, then try again.' };
  if (/outlayer|risk engine|verdict|no result|no answer|gateway didn.t|didn.t answer/i.test(text)) return { happened: 'OutLayer didn’t answer in time.', todo: 'Nothing was sent. Try again.' };
  if (/signer|no signed|sign(ed|ature) .*(timed|appear)/i.test(text)) return { happened: 'The signature didn’t come back in time.', todo: 'Nothing was sent. Try again.' };
  if (/didn.t (appear|show)|hasn.t finished|not mined|still on its way|doesn.t (show|list)|within (a|two|three|\d+) (minute|second)/i.test(text)) return { happened: 'This step is taking longer than usual.', todo: `It may still finish by itself. ${again}` };
  if (/1click|deposit address|deliver|refund/i.test(text)) return { happened: 'The move didn’t go through.', todo: `If money left, it comes back to where it started. ${again}` };
  if (/price band|band|refused by check|hyperliquid (refused|didn.t)/i.test(text)) return { happened: 'Hyperliquid didn’t take the order at this price.', todo: 'Nothing was traded. Try again: the page reads the price again.' };
  if (/insufficient|not enough|too little|holds less|more than the/i.test(text)) return { happened: 'The account holds too little for this step.', todo: again };
  return { happened: 'This step didn’t finish.', todo: again };
}

/** The words the main surface never uses (INTERFACES.md 49.1, point 7): they belong to the engine, not to the client. */
export const JARGON = /\b(verdict|counter|nonce|quote)s?\b/i;
