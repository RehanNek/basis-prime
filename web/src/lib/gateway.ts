// Orders and cancels for pb-gateway (INTERFACES.md 9): the exact message the wallet signs, the Auth that goes with
// it, and the gateway's answer in plain words. The order lives only inside the signed message, never next to it.
import { formatUsd } from './units.ts';

/** The NEP-413 recipient every order and cancel is signed for. */
export const GATEWAY_RECIPIENT = 'pb-gateway';
/**
 * How far ahead an order's signature lasts when the backend doesn't say (INTERFACES.md 50.4): the fallback. An older
 * gateway wants expires_ms in the future and at most 120 s ahead of the NEAR final block's time; 110 s leaves room
 * for the final block's lag, and as much time as there is for the run to wait its turn at OutLayer.
 */
export const EXPIRY_MS = 110_000;

/**
 * A life the app will sign for: a whole number of milliseconds from 10 s to 230 s, the longest any gateway of ours
 * takes (testnet's new one takes a message up to 240 s ahead; the user's "4 minutes", 13 Nov). Anything else is no
 * answer, and the page signs for 110 s.
 */
const LIFE_MIN_MS = 10_000;
export const LIFE_MAX_MS = 230_000;

/**
 * INTERFACES.md 50.4: how long a message is signed for on this account's own gateway. The backend says it in
 * GET /api/markets?account=<id> as `order_life_ms`: 230,000 on testnet's new gateway (which takes a message up to
 * 240 s ahead), 110,000 on an older one. When the answer doesn't carry it, or hasn't come: 110 s, which every
 * gateway takes.
 */
export function orderLifeMs(markets: { order_life_ms?: unknown } | null | undefined): number {
  const life = markets?.order_life_ms;
  return typeof life === 'number' && Number.isInteger(life) && life >= LIFE_MIN_MS && life <= LIFE_MAX_MS ? life : EXPIRY_MS;
}

export type Tif = 'Gtc' | 'Ioc' | 'Alo';
export const TIFS: { value: Tif; words: string }[] = [
  { value: 'Gtc', words: 'Good till cancelled: rests on the book' },
  { value: 'Ioc', words: 'Immediate or cancel: fills now, the rest is cancelled' },
  { value: 'Alo', words: 'Add liquidity only: rests, or is refused if it would fill at once' },
];

export interface GatewayOrder {
  coin: string;
  is_buy: boolean;
  /** Decimal strings, already rounded to Hyperliquid's rules (lib/hl-rules.ts). */
  sz: string;
  limit_px: string;
  reduce_only: boolean;
  tif: Tif;
}

/**
 * The signed message, compact JSON with its keys in INTERFACES.md 9's order:
 * {"pb":"order","account":A,"order":{"coin","is_buy","sz","limit_px","reduce_only","tif"},"expires_ms":ms}
 */
export function orderMessage(account: string, order: GatewayOrder, expiresMs: number): string {
  const { coin, is_buy, sz, limit_px, reduce_only, tif } = order;
  return JSON.stringify({ pb: 'order', account, order: { coin, is_buy, sz, limit_px, reduce_only, tif }, expires_ms: expiresMs });
}

/** For a cancel, "pb" is "cancel" and the message carries "cancel":{"coin","oid"} instead of "order". */
export function cancelMessage(account: string, cancel: { coin: string; oid: number }, expiresMs: number): string {
  return JSON.stringify({ pb: 'cancel', account, cancel: { coin: cancel.coin, oid: cancel.oid }, expires_ms: expiresMs });
}

/**
 * The expiry from the NEAR time the backend last read (`near_time_ms`), moved on by the time since, plus the life
 * the message is signed for: the account's own (`orderLifeMs`), or 110 s.
 */
export function expiresAt(nearTimeMs: number, fetchedAt: number, now: number, lifeMs: number = EXPIRY_MS): number {
  return nearTimeMs + Math.max(0, now - fetchedAt) + lifeMs;
}

/** The same, now: for the moment an order is signed (an event, never a render). */
export function expiryNow(nearTimeMs: number, fetchedAt: number, lifeMs: number = EXPIRY_MS): number {
  return expiresAt(nearTimeMs, fetchedAt, Date.now(), lifeMs);
}

/** 32 random bytes for the NEP-413 nonce. The gateway refuses a nonce it has seen. */
export function randomNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const clean = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, '='));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function fromBase58(text: string): Uint8Array | null {
  let value = 0n;
  for (const char of text) {
    const digit = B58.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  for (const char of text) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/**
 * The signature as the gateway wants it: standard base64, padded, of the 64 bytes. Meteor already gives that
 * (base64.encode of @scure/base). Other wallets write their own executors and have used base58 (with or without
 * "ed25519:") or hex, so those are converted rather than refused. A string that could be either base58 or
 * unpadded base64 is read as base58 first; if that guess is wrong, the backend's NEP-413 check says so.
 */
export function normalizeSignature(signature: string): string {
  const text = signature.trim();
  const base64 = () => (/^[A-Za-z0-9+/_-]+={0,2}$/.test(text) ? fromBase64(text) : null);
  const base58 = () => fromBase58(text.replace(/^ed25519:/, ''));
  const hex = () => (/^[0-9a-f]{128}$/i.test(text) ? Uint8Array.from(text.match(/../g)!, (h) => parseInt(h, 16)) : null);
  let order: (() => Uint8Array | null)[];
  if (text.endsWith('=')) order = [base64];
  else if (text.startsWith('ed25519:')) order = [base58];
  else if (/^[0-9a-f]{128}$/i.test(text)) order = [hex];
  else if (/[0OIl+/_-]/.test(text)) order = [base64]; // characters base58 never uses
  else order = [base58, base64];
  for (const attempt of order) {
    const bytes = attempt();
    if (bytes?.length === 64) return toBase64(bytes);
  }
  throw new Error("The wallet's signature isn't 64 bytes in any encoding we know");
}

/** "ed25519:<base58>", adding the prefix if the wallet left it off. */
export function normalizePublicKey(publicKey: string): string {
  const text = publicKey.trim();
  if (/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return text;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return `ed25519:${text}`;
  throw new Error(`The wallet signed with a key that isn't ed25519 (${text.split(':')[0]})`);
}

/** INTERFACES.md 9, "Auth". */
export interface Auth {
  owner: string;
  public_key: string;
  signature: string;
  message: string;
  nonce: string;
  recipient: string;
}

/**
 * The signed message as the backend takes it. `recipient` is the gateway's for an order; a sign-in passes the
 * session's (INTERFACES.md 48.2), so neither signature can pass as the other.
 */
export function toAuth(signed: { accountId: string; publicKey: string; signature: string }, message: string, nonce: Uint8Array, recipient: string = GATEWAY_RECIPIENT): Auth {
  return {
    owner: signed.accountId,
    public_key: normalizePublicKey(signed.publicKey),
    signature: normalizeSignature(signed.signature),
    message,
    nonce: toBase64(nonce),
    recipient,
  };
}

// ---------- the gateway's answer in words ----------

/** RISK_ENGINE.md 9's checks, and the gateway's own codes (INTERFACES.md 9). */
export const CHECK_WORDS: Record<string, string> = {
  P0: 'Another order for this account is still being handled. Wait a moment and send it again.',
  P1: 'The coin is not on the allow-list, or it is being removed and this order would not only shrink the position.',
  P2: "The limit price is outside the coin's price band around the reference price.",
  P3: 'Reduce-only is on, but this order would not shrink the position, or it would flip it.',
  P4: 'Taken as filling at its worst price (never better than the mark), the order fails the checks below.',
  P5: 'The order does not count as lowering risk.',
  P6: 'With a loan, an order that adds risk needs the account to be healthy.',
  P7: 'The position would pass the cap for one client, or the cap for the whole book.',
  P8: 'After this order the loan would not be covered: equity below the initial requirement, the loan above the tier cap, or too big a loss for the pool on an extreme day.',
  P9: "Hyperliquid's margin ratio would go above 50%.",
  P10: "Prices are stale, the order is more than 1% of the coin's daily volume, there were more than 60 orders this minute, or the size or price isn't rounded to Hyperliquid's rules.",
  AUTH: "The signature didn't pass: the wrong signer or key, an expired message, or a nonce used before.",
  HL: "Hyperliquid refused the order or didn't answer. The account's lock is released.",
  INPUT: "The request is malformed, or the size or price isn't rounded to Hyperliquid's rules.",
};

export interface GatewayAnswer {
  ok: boolean;
  code?: string;
  reason?: string;
  acct?: string;
  status?: 'filled' | 'partial' | 'resting';
  oid?: number;
  filled_sz?: string;
  avg_px?: string;
  sent?: GatewayOrder;
  hl?: unknown;
  after?: { state: string; eq: number; im: number; line: number; hl_margin_ratio_bp: number };
  set?: Record<string, number>;
  call_id?: string | null;
  attestation_url?: string | null;
}

export interface AnswerWords {
  ok: boolean;
  headline: string;
  lines: string[];
}

/** An order's answer: what happened on Hyperliquid, or which check refused and why. */
export function orderWords(answer: GatewayAnswer): AnswerWords {
  if (!answer.ok) return refusalWords(answer);
  const sent = answer.sent;
  const what = sent ? `${sent.is_buy ? 'Buy' : 'Sell'} ${sent.sz} ${sent.coin} at ${sent.limit_px}` : 'The order';
  let headline: string;
  if (answer.status === 'filled') headline = `${what}: filled ${answer.filled_sz ?? '?'} at an average ${answer.avg_px ?? '?'}.`;
  else if (answer.status === 'partial') {
    const rest = sent?.tif === 'Ioc' ? 'the rest was cancelled' : 'the rest rests on the book';
    headline = `${what}: partly filled, ${answer.filled_sz ?? '?'} at an average ${answer.avg_px ?? '?'}; ${rest}.`;
  } else if (answer.status === 'resting') headline = `${what}: resting on the book as order ${answer.oid ?? '?'}.`;
  else headline = `${what}: sent.`;
  const lines: string[] = [];
  if (answer.after) {
    const a = answer.after;
    lines.push(
      `The engine's view if it all filled at its worst price: ${a.state.toLowerCase()}, equity ${formatUsd(a.eq)} against an initial requirement of ${formatUsd(a.im)}, ` +
        `credit line ${formatUsd(a.line)}, Hyperliquid margin ratio ${(a.hl_margin_ratio_bp / 100).toFixed(2)}%.`,
    );
  }
  return { ok: true, headline, lines };
}

/** A cancel's answer, with Hyperliquid's own status for it. */
export function cancelWords(answer: GatewayAnswer, oid: number): AnswerWords {
  if (!answer.ok) return refusalWords(answer);
  const status = hlStatuses(answer.hl)[0];
  if (status && status !== 'success') return { ok: false, headline: `Hyperliquid didn't cancel order ${oid}: ${status}`, lines: [] };
  return { ok: true, headline: `Order ${oid} is cancelled.`, lines: [] };
}

/** set_leverage's answer: the leverage it set per coin. */
export function leverageWords(answer: GatewayAnswer): AnswerWords {
  if (!answer.ok) return refusalWords(answer);
  const set = Object.entries(answer.set ?? {});
  return {
    ok: true,
    headline: set.length ? `Leverage set: ${set.map(([coin, x]) => `${coin} ${x}x`).join(', ')}.` : 'No position to set leverage for.',
    lines: ["The gateway picks the largest whole leverage that keeps the credit checks true, so Hyperliquid's own margin check refuses anything bigger."],
  };
}

/** The gateway refuses a message whose `expires_ms` has passed with AUTH, "the message has expired: sign it again" (risk/pb-gateway/src/gateway.rs). */
export function isExpired(answer: GatewayAnswer): boolean {
  return !answer.ok && answer.code === 'AUTH' && /expired/i.test(answer.reason ?? '');
}

/** INTERFACES.md 50.4: what every page says, once, when the signed message ran out before the gateway read it. */
export const EXPIRED_ORDER_WORDS = 'The order waited too long at the risk engine, and its signature ran out. Nothing was placed. Sign again to send it.';
/** The button that goes with it: it signs a fresh message, with a new expiry and nonce. */
export const SIGN_AGAIN = 'Sign again';

function refusalWords(answer: GatewayAnswer): AnswerWords {
  if (isExpired(answer)) return { ok: false, headline: EXPIRED_ORDER_WORDS, lines: [] };
  const code = answer.code ?? '?';
  const words = CHECK_WORDS[code];
  return {
    ok: false,
    headline: words ? `Refused by check ${code}. ${words}` : `Refused (${code}).`,
    lines: answer.reason ? [`The gateway says: ${answer.reason}`] : [],
  };
}

/** Hyperliquid's per-order statuses in a reply ({"status":"ok","response":{"data":{"statuses":[...]}}}), as words. */
export function hlStatuses(reply: unknown): string[] {
  const data = (reply as { response?: { data?: { statuses?: unknown[] } } } | undefined)?.response?.data;
  return (data?.statuses ?? []).map((s) => {
    if (typeof s === 'string') return s;
    if (s && typeof s === 'object' && 'error' in s) return String((s as { error: unknown }).error);
    return JSON.stringify(s);
  });
}
