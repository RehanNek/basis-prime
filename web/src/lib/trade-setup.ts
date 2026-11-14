// Getting an account ready to trade on Hyperliquid, as the Perps page leads through it (INTERFACES.md 51.9).
// The user, 14 Nov, on a new wallet: "i went to trade on hyperliquid but i was redirected to account and then im
// stuck here after step 3 ... can we make this entire process more intuitve?" The four steps of INTERFACES.md 12 are
// the same; what changes is where they are (on the Perps page, where the order would be placed) and how they are said.
// Nothing here reads the clock, the network or the browser.
import { agentApproved, hlFunded, type HlAnswer } from './hl.ts';
import { formatUnits, parseUnits } from './units.ts';

export type TradePart = 'address' | 'margin' | 'agent' | 'approve';

/** The four steps in the order they run, each with its name and one plain line on what it is for. */
export const TRADE_PARTS: { part: TradePart; title: string; why: string }[] = [
  { part: 'address', title: 'Create your Hyperliquid address', why: 'Your account gets its own address on Hyperliquid. Nobody holds a key to it.' },
  { part: 'margin', title: 'Move USDC there as margin', why: 'Trades on Hyperliquid are backed by USDC. It comes out of your account, and you can bring it back.' },
  { part: 'agent', title: 'Connect the trading key', why: 'The one key that can place your orders, and only after the broker’s risk checks. Costs 0.01 NEAR.' },
  { part: 'approve', title: 'Approve the trading key on Hyperliquid', why: 'Hyperliquid then takes this account’s orders from that key.' },
];

/**
 * Which of the four are done, each read on its own: the Account page lets the trading key be connected before the
 * first deposit, so a later step can be done while an earlier one isn't.
 */
export function tradePartsDone(hl: HlAnswer): Record<TradePart, boolean> {
  return {
    address: Boolean(hl.address),
    margin: hlFunded(hl.hyperliquid),
    agent: Boolean(hl.hl?.agent),
    approve: agentApproved(hl).approved === true,
  };
}

/** The steps still to do, in the order they run. The approval comes last: Hyperliquid needs the address open and the key named. */
export function tradePartsLeft(hl: HlAnswer): TradePart[] {
  const done = tradePartsDone(hl);
  return TRADE_PARTS.map((p) => p.part).filter((part) => !done[part]);
}

/** Hyperliquid opens an address on a first deposit of at least $10 (INTERFACES.md 8), in USDC's 6 decimals. */
export const MARGIN_MIN = 10_000_000n;
/**
 * On testnet the USDC that arrives on Hyperliquid comes out of one float of test USDC that every visitor shares
 * (about $775 on 14 Nov), so one move stays small.
 */
export const TESTNET_MARGIN_MAX = 500_000_000n;
/** What the amount field opens with: enough margin for a first small trade. */
export const MARGIN_SUGGESTED = 300_000_000n;

const usdc = (units: bigint): string => formatUnits(units, 6);

/** The amount the field opens with: $300, or all the account's USDC when it holds less; empty when it holds under $10. */
export function suggestedMargin(heldUnits: bigint): string {
  if (heldUnits < MARGIN_MIN) return '';
  return usdc(heldUnits < MARGIN_SUGGESTED ? heldUnits : MARGIN_SUGGESTED);
}

/** The USDC typed for the first move, in units, or why it can't be moved, in words. Nothing typed is neither. */
export function readMargin(text: string, heldUnits: bigint, testnet: boolean): { units: bigint | null; problem: string | null } {
  const typed = text.trim().replace(/^\$/, '');
  if (!typed) return { units: null, problem: null };
  let units: bigint;
  try {
    units = BigInt(parseUnits(typed, 6));
  } catch {
    return { units: null, problem: 'Enter an amount of USDC, like 300.' };
  }
  if (units < MARGIN_MIN) return { units: null, problem: 'Move at least $10: Hyperliquid opens the address with its first deposit.' };
  if (units > heldUnits) return { units: null, problem: `Your account holds ${usdc(heldUnits)} USDC. Move that much or less.` };
  if (testnet && units > TESTNET_MARGIN_MAX) return { units: null, problem: `On testnet, move $${usdc(TESTNET_MARGIN_MAX)} or less: the test USDC on Hyperliquid is shared by everyone trying the app.` };
  return { units, problem: null };
}

/** The button's words: what one click will do now. */
export function setupButtonWords(left: TradePart[], busy: boolean): string {
  if (busy) return 'Working…';
  if (left.length === TRADE_PARTS.length) return 'Set up trading';
  return left.length === 1 ? 'Finish setting up' : 'Continue setting up';
}

/** One line over the steps: how many are left, and that one button does them. */
export function setupLeadWords(left: TradePart[]): string {
  if (left.length === 1) return 'One step is left. One button does it, and your wallet opens once. You do this once per account.';
  return `${left.length} steps are left. One button does them in order, and your wallet opens once for each. You do this once per account.`;
}
