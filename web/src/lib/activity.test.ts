// The Activity page's words (INTERFACES.md 22), on items shaped as GET /api/activity answered for drill1 on 9 Nov.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ActivityItem } from './api.ts';
import { activityLines, activityWords, MONEY_KINDS } from './activity.ts';
import type { Token } from './types.ts';

const MUSDC = 'musdc.pbf-ops.testnet';
const MNBTC = 'mnbtc.pbf-ops.testnet';
const TOKENS: Token[] = [
  { id: MUSDC, symbol: 'USDC', label: 'mUSDC', decimals: 6 },
  { id: MNBTC, symbol: 'nBTC', label: 'mNBTC', decimals: 8 },
];
const SHIM = 'shim.pbf-ops.testnet';

const item = (kind: ActivityItem['kind'], detail: Record<string, unknown>, extra: Partial<ActivityItem> = {}): ActivityItem => ({
  at_ms: 1_794_146_238_890, block: 276_784_835, tx: 'QHiupX', ok: true, kind, by: 'pbf-keeper.testnet', moves: [], detail, source: 'indexer', ...extra,
});
const words = (i: ActivityItem) => activityWords(i, TOKENS, SHIM);

test('money in and out, in words', () => {
  assert.equal(words(item('create', { owner: 'pbf-keeper.testnet', registered: true })), 'Account created, owned by pbf-keeper.testnet, and registered with the pool');
  assert.equal(words(item('deposit', { token: MNBTC, sent: '1500000', kept: true }, { moves: [{ token: MNBTC, amount: '1500000', other: 'pbf-keeper.testnet' }] })), 'Deposited 0.015 mNBTC from pbf-keeper.testnet');
  assert.equal(words(item('deposit', { token: MUSDC, sent: '5000000', kept: true }, { by: SHIM, moves: [{ token: MUSDC, amount: '5000000', other: SHIM }] })), 'Deposited 5 mUSDC through 1Click (the stand-in on testnet)');
  assert.equal(words(item('deposit', { token: MUSDC, sent: '5000000', kept: false })), "A deposit of 5 mUSDC came back: the account didn't keep it");
  assert.equal(words(item('borrow', { asked: '1097175834', amount: '1097175834', debt: '1097175835', tier: 'STANDARD' })), 'Borrowed $1,097.17 from the pool (standard tier); it now owes $1,097.17');
  assert.equal(words(item('borrow', { asked: '5000000', amount: null })), 'Asked to borrow $5.00: no loan was made');
  assert.equal(words(item('repay', { sent: '1089263563', amount: '1087176392' })), "Repaid $1,087.17 to the pool; the pool sent back $2.08 it didn't need");
  assert.equal(words(item('withdraw', { token: MUSDC, amount: '1097175834', to: 'pbf-keeper.testnet', implicit_receiver: false })), 'Withdrew 1,097.1758 mUSDC to pbf-keeper.testnet');
  assert.equal(words(item('withdraw', { token: MUSDC, amount: '5000000', to: 'bb103ace98e62872', implicit_receiver: true })), 'Withdrew 5 mUSDC to a 1Click deposit address (bb103ace…)');
});

test('moves to and from Hyperliquid, plans and their steps, setup, checks', () => {
  assert.equal(words(item('to_hl', { token: MUSDC, amount: '430000000', transfer: 'move:0' })), 'Sent 430 mUSDC to Hyperliquid through 1Click (transfer move:0)');
  assert.equal(words(item('arrived', { transfer: 'move:0', how: 'verdict' })), 'The move to Hyperliquid (transfer move:0) arrived: a check saw the USDC there');
  assert.equal(words(item('home', { amount: '426811579', transfer: 'move:1' })), 'Signed $426.81 of USDC home from Hyperliquid, for 1Click to carry (transfer move:1)');
  assert.equal(words(item('arrived', { transfer: 'move:1', how: 'arrived', token: MUSDC, sent: '426543916' }, { moves: [{ token: MUSDC, amount: '426543916', other: SHIM }] })), '426.5439 mUSDC arrived from 1Click (transfer move:1)');
  assert.equal(words(item('refund', { transfer: 'move:2', how: 'refunded', token: MUSDC, sent: '11000000' })), '1Click refunded 11 mUSDC (transfer move:2)');
  assert.equal(words(item('plan', { pid: '276784686', action: 'DELEVERAGE', steps: ['repay', 'perp'] })), 'A DELEVERAGE plan was stored: repay, perp');
  assert.equal(words(item('plan_step', { pid: '276784686', i: 0, k: 'repay', repaid: '10000000' })), 'Plan 276784686, step 0 (repay): repaid $10.00 to the pool');
  assert.equal(
    words(item('plan_step', { pid: '276784686', i: 1, k: 'perp', status: 'filled', filled_sz: '0.00375', avg_px: '75860.5' }, { source: 'keeper_log', tx: null, by: 'keeper' })),
    'Plan 276784686, step 1 (perp): the gateway placed it on Hyperliquid, filled, 0.00375 at 75860.5',
  );
  assert.equal(words(item('setup', { method: 'hl_init' })), 'Set up the account’s Hyperliquid address (Chain Signatures)');
  assert.equal(words(item('check', { intent: { borrow: { amount: '1097175834' } } })), 'A check of borrowing 1,097.1758 USDC, asked by pbf-keeper.testnet');
  assert.equal(words(item('kyb', { entity: 'acme' })), 'The operator set the KYB flag, entity acme');
  assert.equal(words(item('other', { method: 'hello', receiver: 'x.testnet' })), 'hello on x.testnet');
  assert.ok(!MONEY_KINDS.includes('check') && !MONEY_KINDS.includes('setup'));
});

test('lines link the transaction, or the attestation of a gateway run; a failure says so', () => {
  const lines = activityLines(
    [
      item('borrow', { asked: '5000000', amount: null }, { ok: false }),
      item('plan_step', { pid: '1', i: 1, k: 'perp', status: 'filled' }, { tx: null, source: 'keeper_log', attestation_url: 'https://testnet-api.outlayer.ai/attestations/by-call/bf77' }),
    ],
    TOKENS,
    (h) => `https://testnet.nearblocks.io/txns/${h}`,
  );
  assert.equal(lines[0]!.what, 'Failed: Asked to borrow $5.00: no loan was made');
  assert.deepEqual(lines[0]!.links, [{ href: 'https://testnet.nearblocks.io/txns/QHiupX', text: 'transaction' }]);
  assert.deepEqual(lines[1]!.links, [{ href: 'https://testnet-api.outlayer.ai/attestations/by-call/bf77', text: 'attestation' }]);
});
