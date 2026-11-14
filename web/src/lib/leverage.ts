// The Perps order form's leverage slider (INTERFACES.md 51.11). The user, 14 Nov: "theres no leverage adjuster".
//
// What the slider is: a way to size an order as a multiple of the account's margin on Hyperliquid. 3x on $300 of
// margin fills in an order of $900. It reads back the same way: whatever size is typed, the slider and its line say
// how many times the margin that order is.
//
// What it is not: Hyperliquid's own leverage setting for the account. Only the gateway's key, in the enclave, can sign
// that change, and it sets it itself from the risk engine when the account has a loan (pb-gateway, set_leverage). The
// slider never touches it, and the form says so. With cross margin that setting only caps how large a position can
// get, which is why the slider stops there.
// Nothing here reads the clock, the network or the browser.

/** Hyperliquid's leverage for a coin on an account that has never changed it: 20x cross, or the coin's own most when that is less. */
export const HL_DEFAULT_LEVERAGE = 20;
/** The slider moves in halves. */
export const LEVERAGE_STEP = 0.5;

/**
 * Where the slider ends: Hyperliquid's leverage setting for this account and coin. With a position in the coin the
 * account's own setting is known (Hyperliquid reports it with the position); without one it is the setting a new
 * account has.
 */
export function leverageCap(positionLeverage: number | null | undefined, coinMax: number | null | undefined): number {
  if (typeof positionLeverage === 'number' && positionLeverage >= 1) return Math.floor(positionLeverage);
  const most = typeof coinMax === 'number' && coinMax >= 1 ? Math.floor(coinMax) : HL_DEFAULT_LEVERAGE;
  return Math.min(HL_DEFAULT_LEVERAGE, most);
}

/** The order's size in USDC for a leverage: margin x leverage, cut down to cents. Empty for nothing. */
export function sizeForLeverage(equityUsd: number, leverage: number): string {
  if (!(equityUsd > 0) || !(leverage > 0)) return '';
  const cents = Math.floor(equityUsd * leverage * 100 + 1e-6);
  if (cents <= 0) return '';
  const text = (cents / 100).toFixed(2);
  return text.endsWith('.00') ? text.slice(0, -3) : text.replace(/0$/, '');
}

/** How many times the margin an order worth `orderMicroUsd` is. Null without margin. */
export function leverageOf(orderMicroUsd: bigint, equityUsd: number): number | null {
  if (!(equityUsd > 0)) return null;
  return Number(orderMicroUsd) / 1_000_000 / equityUsd;
}

/** Where the slider's handle sits for an order: its leverage to the nearest half, never past the slider's end. */
export function sliderAt(leverage: number | null, cap: number): number {
  if (leverage === null || !(leverage > 0)) return 0;
  return Math.min(cap, Math.round(leverage / LEVERAGE_STEP) * LEVERAGE_STEP);
}

/** "3x", "0.33x", "12.5x": two decimals under 10, one from there. A dash for nothing. */
export function leverageText(leverage: number | null): string {
  if (leverage === null || !(leverage > 0)) return '–';
  const shown = leverage >= 10 ? Math.round(leverage * 10) / 10 : Math.round(leverage * 100) / 100;
  return `${shown}x`;
}

const dollars = (value: number): string => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The line under the slider: what the order is against the margin, or what the slider does while nothing is typed. */
export function leverageWords(input: { leverage: number | null; equityUsd: number; cap: number }): string {
  const { leverage, equityUsd, cap } = input;
  const margin = dollars(equityUsd);
  if (leverage === null || !(leverage > 0)) return `Drag to size the order from your margin on Hyperliquid (${margin}), up to ${cap}x.`;
  const line = `This order is ${leverageText(leverage)} your margin on Hyperliquid (${margin}).`;
  return leverage > cap ? `${line} That is more than the ${cap}x Hyperliquid allows this account, so it would be refused.` : line;
}

/** Said once under the slider, so nobody takes it for Hyperliquid's own setting. */
export const LEVERAGE_NOTE = 'The slider sets the order’s size. It doesn’t change the leverage setting on Hyperliquid, and the broker’s risk checks can still refuse a large order.';
