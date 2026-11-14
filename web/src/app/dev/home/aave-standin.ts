// Development only: the preview's stand-in for Aave's chain (stage 3; INTERFACES.md 33). It plays the account's
// signing (a new entry in `evm.signed`, status `signed`), the backend's two routes (POST /api/evm/submit, which sends
// a signed transaction, and POST /api/evm/gas, the testnet faucet), and the chain itself, which mines a sent
// transaction a few seconds later and moves the sample's balances. Nothing is signed or sent.
import type { EvmAnswer, EvmGasAnswer, EvmSigned, EvmSubmitAnswer, LenderAccountAnswer } from '@/lib/api';
import type { EvmSignedEntry } from '@/lib/types';

import { AAVE_USDC, aavePosition, WBTC, WETH } from './aave-samples';

/** The parts of the sample account's state the stand-in changes. */
export interface EvmOwner {
  evm?: { nonce: number; signed: EvmSignedEntry[]; approved?: string[] } | null;
  pending: unknown[];
}

const SENT_TO_MINED_MS = 3_500;
const FAUCET_MS = 1_500;
const timers = new Set<ReturnType<typeof setTimeout>>();

function later(ms: number, run: () => void) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    run();
  }, ms);
  timers.add(timer);
}

/** Stops everything on its way: the preview is closing, or showing another state. */
export function stopEvm() {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
}

const same = (a: string | null | undefined, b: string) => (a ?? '').toLowerCase() === b.toLowerCase();

/** Adds `delta` units of a token to what sits at the address. */
function bumpWallet(evm: EvmAnswer, token: string, delta: bigint) {
  const entry = evm.wallet.find((t) => same(t.token, token));
  if (entry) entry.amount = (BigInt(entry.amount) + delta).toString();
}

/** Changes the account at Aave: `units` of a collateral token and `debt` in micro-USD are added. */
function moveAave(lender: LenderAccountAnswer, token: string | null, units: bigint, debt: bigint) {
  const now = lender.lenders.find((p) => p.l === 'aave');
  const held = [WETH, WBTC].map((t) => ({ ...t, amount: BigInt(now?.held?.find((h) => same(h.token, t.token))?.amount ?? '0') + (token && same(token, t.token) ? units : 0n) }));
  const owed = BigInt(now?.debt ?? 0) + debt;
  const next = aavePosition(held.map((h) => ({ ...h, amount: h.amount > 0n ? h.amount : 0n })), owed > 0n ? owed : 0n);
  lender.lenders = [next, ...lender.lenders.filter((p) => p.l !== 'aave')];
}

/** The account's `evm_signed` event, as its transaction logs it. */
export const evmSignedLog = (nonce: number, kind: string, hash: string): string =>
  `EVENT_JSON:${JSON.stringify({ standard: 'pb-pool', version: '1.0.0', event: 'evm_signed', data: [{ nonce, kind, hash }] })}`;

/**
 * The account signs one Ethereum transaction: it takes the next nonce and joins `evm.signed`, in the backend's answer
 * and in the account's own state, as signed and not yet sent. A borrow or a withdrawal is also listed as pending.
 */
export function signEvm(lender: LenderAccountAnswer, owner: EvmOwner, tx: { kind: string; token: string; amount: string | null; to?: string | null; step?: string | null }): EvmSigned {
  const evm = lender.evm!;
  const nonce = evm.nonce ?? 0;
  const entry: EvmSigned = { nonce, kind: tx.kind, token: tx.token, amount: tx.amount, hash: `0xsim${nonce}${tx.kind}${Date.now().toString(16)}`, status: 'signed', step: tx.step ?? null };
  evm.nonce = nonce + 1;
  evm.signed = [...evm.signed, entry].slice(-20);
  const before = owner.evm?.approved ?? [];
  owner.evm = {
    nonce: evm.nonce,
    // The tokens whose approval the account has signed.
    approved: tx.kind === 'approve' && !before.includes(tx.token.toLowerCase()) ? [...before, tx.token.toLowerCase()] : before,
    signed: [...(owner.evm?.signed ?? []), { nonce, kind: tx.kind, token: tx.token, amount: tx.amount, to: tx.to ?? null, raw: '0x02', hash: entry.hash, step: tx.step ?? null, signed_at: `${Date.now()}000000` }].slice(-20),
  };
  if (tx.kind === 'borrow' || tx.kind === 'withdraw') owner.pending = [...owner.pending, { lender: { lender: 'aave', kind: tx.kind, amount: tx.amount, token: tx.token, evm_nonce: nonce } }];
  return entry;
}

/** The chain mines the transaction of that nonce: its balances move, and the account's pending entry for it goes. */
export function mineEvm(lender: LenderAccountAnswer, owner: EvmOwner, nonce: number, after?: () => void) {
  const evm = lender.evm;
  const entry = evm?.signed.find((e) => e.nonce === nonce);
  if (!evm || !entry || entry.status === 'mined') return;
  entry.status = 'mined';
  evm.chain_nonce = Math.max(evm.chain_nonce ?? 0, nonce + 1);
  const token = entry.token ?? '';
  const amount = BigInt(entry.amount ?? '0');
  if (entry.kind === 'approve') {
    const held = evm.wallet.find((t) => same(t.token, token));
    if (held) held.approved = true;
  } else if (entry.kind === 'supply') {
    bumpWallet(evm, token, -amount);
    moveAave(lender, token, amount, 0n);
  } else if (entry.kind === 'borrow') {
    bumpWallet(evm, AAVE_USDC.token, amount);
    moveAave(lender, null, 0n, amount);
  } else if (entry.kind === 'repay') {
    // Aave takes at most what it is owed.
    const owed = BigInt(lender.lenders.find((p) => p.l === 'aave')?.debt ?? 0);
    const paid = amount < owed ? amount : owed;
    bumpWallet(evm, AAVE_USDC.token, -paid);
    moveAave(lender, null, 0n, -paid);
  } else if (entry.kind === 'withdraw') {
    bumpWallet(evm, token, amount);
    moveAave(lender, token, -amount, 0n);
  } else if (entry.kind === 'transfer') {
    bumpWallet(evm, token, -amount);
  }
  owner.pending = owner.pending.filter((p) => (p as { lender?: { evm_nonce?: number } } | null)?.lender?.evm_nonce !== nonce);
  after?.();
}

/** POST /api/evm/submit: the signed transaction of that nonce goes to the chain, which mines it a few seconds later. */
export function submitEvm(lender: LenderAccountAnswer, owner: EvmOwner, nonce: number, after?: () => void): EvmSubmitAnswer | null {
  const entry = lender.evm?.signed.find((e) => e.nonce === nonce);
  if (!entry) return null;
  if (entry.status === 'signed') {
    entry.status = 'sent';
    later(SENT_TO_MINED_MS, () => mineEvm(lender, owner, nonce, after));
  }
  return { hash: entry.hash, status: entry.status === 'mined' ? 'mined' : 'sent' };
}

/**
 * POST /api/evm/gas (testnet): the gas wallet tops the address up to 0.002 ETH. With `mint`, Aave's faucet hands the
 * address test WBTC; with `wrap`, the gas wallet wraps its own test ETH and sends the WETH. Each arrives a moment later.
 */
export function gasEvm(lender: LenderAccountAnswer, body: { mint?: { token: string; amount: string }; wrap?: { amount: string } }): EvmGasAnswer | null {
  const evm = lender.evm;
  if (!evm?.address) return null;
  const topUp = 2_000_000_000_000_000n;
  const had = BigInt(String(evm.eth ?? '0'));
  const sent = had < topUp ? topUp - had : 0n;
  const stamp = Date.now().toString(16);
  later(FAUCET_MS, () => {
    evm.eth = (had + sent).toString();
    if (body.mint) bumpWallet(evm, body.mint.token, BigInt(body.mint.amount));
    if (body.wrap) bumpWallet(evm, WETH.token, BigInt(body.wrap.amount));
  });
  return {
    address: evm.address,
    eth: { balance: (had + sent).toString(), sent: sent.toString(), hash: sent > 0n ? `0xsimgas${stamp}` : null },
    mint: body.mint ? { hash: `0xsimmint${stamp}`, amount: body.mint.amount } : null,
    wrap: body.wrap ? { hash: `0xsimwrap${stamp}`, amount: body.wrap.amount } : null,
  };
}
