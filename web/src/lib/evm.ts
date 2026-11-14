// The account's address on Aave's chain (FUNDING.md 4.5; INTERFACES.md 33), stage 3: what sits there, its gas, and
// the Ethereum transactions the account signed through Chain Signatures, each as signed, sent, mined or failed. On
// testnet the chain is Base Sepolia. Pure functions, so the words can be tested.
import type { EvmAnswer, EvmSigned, EvmStatus, EvmToken, LenderTerms } from './api.ts';
import { sourceName } from './funding.ts';
import type { EvmSignedEntry, Token } from './types.ts';
import { displayUnits, formatUsd } from './units.ts';

/** Base Sepolia's explorer (chain id 84532), where a transaction's hash and an address can be looked up. */
export const EVM_EXPLORER = 'https://sepolia.basescan.org';
export const EVM_CHAIN_NAME = 'Base Sepolia';
export const evmTxUrl = (hash: string): string => `${EVM_EXPLORER}/tx/${hash}`;
export const evmAddressUrl = (address: string): string => `${EVM_EXPLORER}/address/${address}`;

/**
 * The most gas one of the account's transactions may need: its gas limit, at most 500,000, at the config's
 * `max_fee_per_gas` of 1 gwei on testnet (INTERFACES.md 33). An address holding less may not get a transaction out.
 */
export const GAS_PER_TX_WEI = 500_000n * 1_000_000_000n;

/** The gas wallet wraps at most 0.02 of its test ETH a day for one account (INTERFACES.md 33), in wei. */
export const WRAP_MAX_WEI = 20_000_000_000_000_000n;
/** The demo's bitcoin, in nBTC's units (8 decimals): what the faucet is asked for when the account holds none on NEAR. */
const DEMO_BTC_UNITS = 1_500_000n;

/** A 0x address: `0x` and 40 hex digits. */
export const isEvmAddress = (text: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(text.trim());

/** "0x8c01…17fb", for a line of text. */
export const shortAddress = (address: string): string => (address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address);

/** The address's gas in wei, from `evm.eth`: a string of digits or a whole number. Null when it wasn't read. */
export function ethWei(eth: unknown): bigint | null {
  if (typeof eth === 'bigint') return eth;
  if (typeof eth === 'number' && Number.isFinite(eth) && eth >= 0) return BigInt(Math.trunc(eth));
  if (typeof eth === 'string' && /^\d+$/.test(eth)) return BigInt(eth);
  return null;
}

/** Wei as ETH for reading, to four decimals, rounded down: 2000000000000000 -> "0.0020 ETH". */
export function formatEth(wei: bigint): string {
  const tenThousandths = wei / 10n ** 14n;
  return `${tenThousandths / 10_000n}.${(tenThousandths % 10_000n).toString().padStart(4, '0')} ETH`;
}

export interface GasView {
  amount: string;
  /** Enough for a transaction, or null when the balance wasn't read. */
  enough: boolean | null;
  words: string;
}

/** The address's gas: how much there is, and whether a transaction can go out. A transaction spends a tiny part of it. */
export function gasView(eth: unknown): GasView {
  const wei = ethWei(eth);
  if (wei === null) return { amount: 'Not read yet', enough: null, words: 'The address pays for its transactions with this chain’s ETH.' };
  const enough = wei >= GAS_PER_TX_WEI;
  return {
    amount: formatEth(wei),
    enough,
    words: enough
      ? 'Enough for its next transactions. Each one spends a tiny part of it.'
      : `Too little: a transaction can need up to ${formatEth(GAS_PER_TX_WEI)} held at the address before it goes out.`,
  };
}

/** A token at the address by its name, such as WBTC or USDC. */
export function walletToken(evm: Pick<EvmAnswer, 'wallet'> | null | undefined, symbol: string): EvmToken | null {
  return (evm?.wallet ?? []).find((t) => t.symbol === symbol) ?? null;
}

/** Units of a token at the address, by its name: 0 when it isn't there. */
export function walletAmount(evm: Pick<EvmAnswer, 'wallet'> | null | undefined, symbol: string): bigint {
  try {
    return BigInt(walletToken(evm, symbol)?.amount ?? '0');
  } catch {
    return 0n;
  }
}

/** The address's tokens as the app's own `Token`s, so the step and intent words can name them by their 0x address. */
export function evmTokens(evm: Pick<EvmAnswer, 'wallet'> | null | undefined): Token[] {
  return (evm?.wallet ?? []).map((t) => ({ id: t.token, symbol: t.symbol, label: t.symbol, decimals: t.decimals }));
}

const STATUSES: EvmStatus[] = ['signed', 'sent', 'mined', 'failed', 'replaced'];

/** A status the page knows, else `signed`: an entry is on the list because the account signed it. */
export const evmStatus = (status: unknown): EvmStatus => (STATUSES.includes(status as EvmStatus) ? (status as EvmStatus) : 'signed');

/** A status in a word. */
export const STATUS_LABEL: Record<EvmStatus, string> = { signed: 'Signed', sent: 'Sent', mined: 'Mined', failed: 'Failed', replaced: 'Replaced' };

/** The chain is done with it: mined, mined and reverted, or its place in line went to another transaction. */
export const evmSettled = (status: EvmStatus): boolean => status === 'mined' || status === 'failed' || status === 'replaced';

/**
 * Where a signed transaction stands, in a sentence. A signed borrow, and a signed withdrawal of collateral, count from
 * the moment they are signed (the stale-signature rule): a signed transaction never expires, and anyone can send it.
 */
export function statusWords(kind: string, status: EvmStatus): string {
  const counts =
    kind === 'borrow'
      ? ' The loan already counts: a signed transaction never expires, and anyone can send it.'
      : kind === 'withdraw'
        ? ' The collateral already counts as gone: a signed transaction never expires, and anyone can send it.'
        : // The account lists a signed transfer as under way until the chain has used its nonce (evm_withdraw).
          kind === 'transfer'
          ? ' The tokens already count as gone, and the account takes no new loan and sends nothing else out until it is mined.'
          : '';
  switch (status) {
    case 'signed':
      return `Signed, not mined yet: it waits to be sent to ${EVM_CHAIN_NAME}.${counts}`;
    case 'sent':
      return `Sent to ${EVM_CHAIN_NAME}, not mined yet.${counts}`;
    case 'mined':
      return `Mined on ${EVM_CHAIN_NAME}.`;
    case 'replaced':
      return `${EVM_CHAIN_NAME} gave its place in line to another signing of the account’s, so this one can never be mined.`;
    default:
      return `${EVM_CHAIN_NAME} mined it, but it failed there, so nothing moved.`;
  }
}

/** The address's tokens matched without minding the case of the 0x address. */
const tokenAt = (wallet: EvmToken[] | undefined, address: string | null | undefined): EvmToken | undefined =>
  address ? (wallet ?? []).find((t) => t.token.toLowerCase() === address.toLowerCase()) : undefined;

/** An amount of a token at the address: "$323.00" for USDC, "0.015 WBTC" or "0.02 WETH" for another, and `fallback` for one the page doesn't know. */
function amountWords(entry: Pick<EvmSigned, 'token' | 'amount'>, wallet: EvmToken[] | undefined, fallback: string): string {
  const token = tokenAt(wallet, entry.token);
  try {
    if (!token || entry.amount === null || entry.amount === undefined) return fallback;
    return token.symbol === 'USDC' && token.decimals === 6 ? formatUsd(entry.amount) : `${displayUnits(entry.amount, token.decimals, token.decimals)} ${token.symbol}`;
  } catch {
    return fallback;
  }
}

/** One signed transaction in plain words, by its kind (INTERFACES.md 33): what it does at Aave or at the address. */
export function signedWords(entry: Pick<EvmSigned, 'kind' | 'token' | 'amount'> & { to?: string | null }, wallet?: EvmToken[]): string {
  const lender = sourceName('aave');
  const symbol = tokenAt(wallet, entry.token)?.symbol ?? 'a token';
  switch (entry.kind) {
    case 'approve':
      return `Let ${lender} take ${symbol} from the address (once per token)`;
    case 'supply':
      return `Post ${amountWords(entry, wallet, 'collateral')} with ${lender}`;
    case 'borrow':
      return `Borrow ${amountWords(entry, wallet, 'USDC')} from ${lender}`;
    case 'repay':
      return `Repay ${amountWords(entry, wallet, 'USDC')} to ${lender}`;
    case 'withdraw':
      return `Take ${amountWords(entry, wallet, 'collateral')} back from ${lender}`;
    case 'transfer':
      return `Send ${amountWords(entry, wallet, symbol)} out of the address${entry.to ? ` to ${shortAddress(entry.to)}` : ''}`;
    default:
      return `A transaction this page doesn’t know (${entry.kind})`;
  }
}

/**
 * The signed transaction of each plan step, by "<pid>:<i>". The backend's `evm.signed` has the status; the step comes
 * with it when the backend sends one, and otherwise from the account's own `get_state().evm.signed`, joined by nonce.
 */
export function signedBySteps(evm: Pick<EvmAnswer, 'signed'> | null | undefined, own?: { signed?: EvmSignedEntry[] } | null): Map<string, EvmSigned> {
  const steps = new Map<number, string>();
  for (const entry of own?.signed ?? []) if (entry.step) steps.set(entry.nonce, entry.step);
  const out = new Map<string, EvmSigned>();
  // Oldest first, so a step signed again with higher fees (evm_bump) shows its newest transaction.
  for (const entry of evm?.signed ?? []) {
    const step = entry.step ?? steps.get(entry.nonce);
    if (step) out.set(step, entry);
  }
  return out;
}

/**
 * The account's `evm_signed` event in a transaction's logs (INTERFACES.md 33): an NEP-297 log
 * EVENT_JSON:{…,"event":"evm_signed","data":[{"nonce","kind","hash"}]}. With `kind`, the first of that kind.
 */
export function evmSignedFromLogs(logs: string[], kind?: string): { nonce: number; kind: string; hash: string } | null {
  for (const line of logs) {
    if (!line.startsWith('EVENT_JSON:')) continue;
    try {
      const event = JSON.parse(line.slice('EVENT_JSON:'.length)) as { event?: string; data?: unknown };
      if (event.event !== 'evm_signed') continue;
      const entries = (Array.isArray(event.data) ? event.data : [event.data]) as ({ nonce?: unknown; kind?: unknown; hash?: unknown } | null)[];
      const hit = entries.find((d) => d && typeof d.nonce === 'number' && (!kind || d.kind === kind));
      if (hit) return { nonce: hit.nonce as number, kind: String(hit.kind ?? ''), hash: String(hit.hash ?? '') };
    } catch {
      // not our event
    }
  }
  return null;
}

/** The newest signed transaction of a kind at or after a nonce: what a call that just returned must have signed. */
export function newSigned(evm: Pick<EvmAnswer, 'signed'> | null | undefined, kind: string, fromNonce: number): EvmSigned | null {
  return [...(evm?.signed ?? [])].reverse().find((e) => e.kind === kind && e.nonce >= fromNonce) ?? null;
}

/** Signed transactions that were never sent, oldest first: the page offers to send them, since nonces go in order. */
export function unsent(evm: Pick<EvmAnswer, 'signed'> | null | undefined): EvmSigned[] {
  return (evm?.signed ?? []).filter((e) => evmStatus(e.status) === 'signed').sort((a, b) => a.nonce - b.nonce);
}

/**
 * Does Aave's pool have its one-time approval for this token? The account's own list says (`get_state().evm.approved`,
 * the tokens whose approval it has signed). An account contract from before that list leaves it out: then the
 * backend's `approved` when it says; else a mined `approve` of the token among the signed transactions; else unknown
 * (null), and the page asks for one to be safe.
 */
export function approved(evm: Pick<EvmAnswer, 'wallet' | 'signed'> | null | undefined, token: string, own?: { approved?: unknown } | null): boolean | null {
  if (Array.isArray(own?.approved)) return own.approved.some((t) => typeof t === 'string' && t.toLowerCase() === token.toLowerCase());
  const flag = tokenAt(evm?.wallet, token)?.approved;
  if (typeof flag === 'boolean') return flag;
  const mined = (evm?.signed ?? []).some((e) => e.kind === 'approve' && e.token?.toLowerCase() === token.toLowerCase() && evmStatus(e.status) === 'mined');
  return mined ? true : null;
}

/**
 * What the account holds at its address, in dollars: its USDC, its WBTC at the bitcoin price and its WETH at the ether
 * price. Null when a price is missing, or a token is one the page can't price. Display only.
 */
export function walletUsd(evm: Pick<EvmAnswer, 'wallet'> | null | undefined, prices: { btc: number | null; eth: number | null }): number | null {
  let total = 0;
  for (const t of evm?.wallet ?? []) {
    const amount = Number(t.amount) / 10 ** t.decimals;
    if (!(amount > 0)) continue;
    const price = t.symbol === 'USDC' ? 1 : t.symbol === 'WBTC' ? prices.btc : t.symbol === 'WETH' ? prices.eth : null;
    if (price === null || !Number.isFinite(price)) return null;
    total += amount * price;
  }
  return total;
}

/** A dollar token's units as micro-USD, whatever its decimals: Aave's test USDC has 6, so it reads as it is. */
export function microUsd(units: string | bigint, decimals: number): bigint {
  try {
    const value = BigInt(units);
    return decimals >= 6 ? value / 10n ** BigInt(decimals - 6) : value * 10n ** BigInt(6 - decimals);
  } catch {
    return 0n;
  }
}

/** The tokens at the address that Aave takes as collateral: everything held there but the USDC. */
export function collateralAt(evm: Pick<EvmAnswer, 'wallet'> | null | undefined): EvmToken[] {
  return (evm?.wallet ?? []).filter((t) => t.symbol !== 'USDC' && /^\d+$/.test(t.amount) && BigInt(t.amount) > 0n);
}

/**
 * A token amount with its name, by the token's own decimals: "0.015 WBTC", "0.02 WETH". At most 8 places are shown,
 * so ether that arrived from a move reads "0.01260333 WETH", not its 18 digits.
 */
export const tokenAmount = (units: bigint | string, token: { symbol: string; decimals: number }): string => `${displayUnits(units, token.decimals, Math.min(token.decimals, 8))} ${token.symbol}`;

export interface TestCollateral {
  kind: 'bitcoin' | 'ether';
  /** What POST /api/evm/gas is asked for: Aave's faucet mint of WBTC, or the gas wallet's wrap of test ETH into WETH. */
  ask: { mint: { token: string; amount: string } } | { wrap: { amount: string } };
  /** "0.015 test WBTC", "0.02 test WETH". */
  amount: string;
  /** Why this token, in a sentence or two. */
  why: string;
}

/**
 * The testnet step "Get test collateral for Aave" (INTERFACES.md 33): which token to ask for. Bitcoin when Aave's
 * test pool has room for it (`collateral_room` on Aave's testnet row of GET /api/lenders), as much as the account's
 * nBTC on NEAR, whose move this stands in for. Ether when the pool is full, or when its room wasn't read: Aave's test
 * market takes WETH either way.
 */
export function testCollateral(room: LenderTerms['collateral_room'] | null | undefined, nbtcUnits: bigint): TestCollateral {
  const stage = 'Moving your bitcoin to Aave’s chain is a later stage';
  const wbtc = (room ?? []).find((t) => t.symbol === 'WBTC');
  if (wbtc) {
    // The account's nBTC (8 decimals) in WBTC's own units, and at most the faucet's 1 WBTC a call.
    const one = 10n ** BigInt(wbtc.decimals);
    const held = ((nbtcUnits > 0n ? nbtcUnits : DEMO_BTC_UNITS) * one) / 100_000_000n;
    const wants = held < one ? held : one;
    const fits = wbtc.room === null || (/^\d+$/.test(wbtc.room) && BigInt(wbtc.room) >= wants);
    if (fits) {
      return {
        kind: 'bitcoin',
        ask: { mint: { token: wbtc.token, amount: wants.toString() } },
        amount: `${displayUnits(wants, wbtc.decimals, wbtc.decimals)} test WBTC`,
        why: `${stage}, so here Aave’s own test faucet hands the account’s address test bitcoin in its place. Your nBTC stays on NEAR.`,
      };
    }
  }
  return {
    kind: 'ether',
    ask: { wrap: { amount: WRAP_MAX_WEI.toString() } },
    amount: `${displayUnits(WRAP_MAX_WEI, 18, 18)} test WETH`,
    why: wbtc
      ? `Aave’s test pool for bitcoin is full today, so this demo posts test ether. On mainnet it would be your bitcoin. ${stage}.`
      : `The page couldn’t read whether Aave’s test pool has room for bitcoin, so this demo posts test ether, which it takes. On mainnet it would be your bitcoin. ${stage}.`,
  };
}
