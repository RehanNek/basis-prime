// Amounts: token units (U128 strings) to and from what people type and read. Exact, with bigint: no floats.

/** "1.5" with 6 decimals -> "1500000". Throws on anything that isn't a plain positive or zero decimal number. */
export function parseUnits(text: string, decimals: number): string {
  const clean = text.trim().replace(/,/g, '');
  const match = /^(\d*)(?:\.(\d*))?$/.exec(clean);
  if (!clean || !match || (match[1] === '' && !match[2])) throw new Error('Enter an amount, like 100 or 0.5');
  const [, whole = '', fraction = ''] = match;
  if (fraction.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')).toString();
}

/** "1500000" with 6 decimals -> "1.5". No grouping, so it can go back into an input. */
export function formatUnits(units: string | bigint, decimals: number): string {
  const value = BigInt(units);
  const sign = value < 0n ? '-' : '';
  const digits = (value < 0n ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** For reading: thousands grouped and at most `maxFraction` decimals, rounded down. "24150250000", 6 -> "24,150.25". */
export function displayUnits(units: string | bigint, decimals: number, maxFraction = 4): string {
  const value = BigInt(units);
  const shown = maxFraction < decimals ? (value / 10n ** BigInt(decimals - maxFraction)) * 10n ** BigInt(decimals - maxFraction) : value;
  const [whole, fraction] = formatUnits(shown, decimals).split('.');
  return `${group(whole!)}${fraction ? `.${fraction}` : ''}`;
}

/** Micro-USD (a verdict amount, or micro-USDC) as dollars: 24150000000 -> "$24,150.00". */
export function formatUsd(micro: number | string | bigint): string {
  if (typeof micro === 'number' && !Number.isFinite(micro)) return '?';
  const value = BigInt(typeof micro === 'number' ? Math.trunc(micro) : micro);
  const negative = value < 0n;
  const cents = (negative ? -value : value) / 10_000n;
  const text = `$${group((cents / 100n).toString())}.${(cents % 100n).toString().padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

/** Dollars from a float, for Hyperliquid's own numbers (display only): -11.6 -> "-$11.60", null -> "?". */
export function formatDollars(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '?';
  const text = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value < 0 ? `-$${text}` : `$${text}`;
}

/** Basis points as a percentage: 650 -> "6.50%". */
export function formatBp(bp: number): string {
  return `${(bp / 100).toFixed(2)}%`;
}

/** NEAR as yoctoNEAR: "4" -> "4000000000000000000000000". */
export function nearToYocto(near: string): string {
  return parseUnits(near, 24);
}

function group(whole: string): string {
  const sign = whole.startsWith('-') ? '-' : '';
  return sign + whole.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
