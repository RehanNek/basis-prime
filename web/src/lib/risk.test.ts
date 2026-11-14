// The Risk page's helpers and the drill panel's: runs with pnpm --filter @pb/web test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { KeeperEvent } from './api.ts';
import { bandRows, isOverdue, keeperActions, marginClock, MARGIN_CALL_LIMIT_MS, minutes, pendingTransfers, readPlan, riskWords, showLevel, slideCommand, slideFromBands, slideProblem, stepStatus, verdictHistory } from './risk.ts';
import { hlWithdrawTx, setRatioTx, withdrawTx } from './tx.ts';

const T0 = Date.UTC(2026, 10, 10, 12, 0);
const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
const txUrl = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;

const PLAN = {
  pid: '276800123',
  action: 'DELEVERAGE',
  stored_at: ns(T0),
  steps: [
    { k: 'repay', amt: 10_000_000, done: true },
    { k: 'perp', coin: 'BTC', buy: true, sz: '0.00375', px: '76190', done: false },
    { k: 'sell', tok: 'mnbtc.pbf-ops.testnet', amt: '100000', min: 70_000_000, dep: 'ab'.repeat(32), exp: T0 + 4 * 60_000, done: false },
  ],
};

test('the stored plan in words, and each step where it stands', () => {
  const plan = readPlan({ plan: PLAN })!;
  assert.deepEqual([plan.pid, plan.action, plan.storedAtMs, plan.source], ['276800123', 'DELEVERAGE', T0, 'plan']);
  assert.deepEqual(plan.steps.map((s) => s.text), [
    "Repay $10.00 to the pool from the account's USDC.",
    'Buy 0.00375 BTC at 76190: reduce-only, at once or not at all.',
    'Sell 100000 units of mnbtc.pbf-ops.testnet through 1Click, for at least $70.00.',
  ]);
  const events: KeeperEvent[] = [
    { t: '2', event: 'gateway', mode: 'deleverage', pid: '276800123', ok: true, placed: [{ i: 1, k: 'perp', status: 'filled', filled_sz: '0.00375' }], attestation_url: 'https://testnet-api.outlayer.ai/attestations/by-call/c1' },
    { t: '1', event: 'step', pid: '276800123', i: 0, k: 'repay', ok: true, tx: 'H1' },
  ];
  assert.deepEqual(stepStatus(plan, plan.steps[0]!, events, T0, txUrl), { label: 'Done', tone: 'success', link: { href: txUrl('H1'), text: 'transaction' } });
  assert.deepEqual(stepStatus(plan, plan.steps[1]!, events, T0, txUrl), { label: 'Placed: filled, 0.00375 filled', tone: 'success', link: { href: 'https://testnet-api.outlayer.ai/attestations/by-call/c1', text: 'attestation' } });
  assert.equal(stepStatus(plan, plan.steps[1]!, [], T0, txUrl).label, 'Waiting for the gateway');
  const rerun: KeeperEvent = { t: '3', event: 'gateway', mode: 'deleverage', pid: '276800123', ok: true, placed: [], skipped: [{ i: 1, k: 'perp', why: 'ran before: filled' }] };
  assert.equal(stepStatus(plan, plan.steps[1]!, [rerun, ...events], T0, txUrl).label, 'Placed: filled, 0.00375 filled', 'placed by an earlier run');
  const p2: KeeperEvent = { t: '4', event: 'gateway', mode: 'deleverage', pid: '276800123', ok: false, placed: [], refused: [{ i: 1, k: 'perp', code: 'P2', reason: 'px has left the band' }] };
  assert.equal(stepStatus(plan, plan.steps[1]!, [p2], T0, txUrl).label, 'Refused: P2 px has left the band');
  assert.match(stepStatus(plan, plan.steps[2]!, events, T0, txUrl).label, /too close to expiry/);
  const old = readPlan({ deleverage: { first_at: '0', confirmed_plan: { at: ns(T0), blk: 9, steps: ['buy back 0.3194 BTC'] } } })!;
  assert.deepEqual([old.source, stepStatus(old, old.steps[0]!, [], T0, txUrl).label], ['confirmed_plan', 'In words only']);
});

test('pending transfers, overdue once past their deadline', () => {
  const list = pendingTransfers([{ borrow: { amount: '1' } }, { transfer: { id: 'move:4', kind: 'to_hl', token: 'musdc.pbf-ops.testnet', amount: '11000000', dep: 'ab'.repeat(32), deadline: ns(T0) } }]);
  assert.deepEqual(list.map((t) => [t.id, t.kind, t.deadlineMs]), [['move:4', 'to_hl', T0]]);
  assert.equal(isOverdue(list[0]!, T0), false);
  assert.equal(isOverdue(list[0]!, T0 + 1), true);
});

test('the margin-call clock: time below the buffer over 24 hours, an open interval counted to now, out of 4 hours', () => {
  const clock = marginClock({ since: ns(T0 - 30 * 60_000), below: true, intervals: [[ns(T0 - 25 * 60 * 60_000), ns(T0 - 23 * 60 * 60_000)], [ns(T0 - 30 * 60_000), ns(T0 - 20 * 60_000)]] }, T0);
  assert.equal(clock.belowMs, 60 * 60_000 + 30 * 60_000, "an hour of yesterday's interval is within 24 h, and today's runs to now");
  assert.equal(clock.leftMs, MARGIN_CALL_LIMIT_MS - clock.belowMs);
  assert.deepEqual([clock.sinceMs, clock.below, minutes(clock.belowMs)], [T0 - 30 * 60_000, true, '1 h 30 min']);
  assert.deepEqual(marginClock(undefined, T0), { belowMs: 0, leftMs: MARGIN_CALL_LIMIT_MS, sinceMs: null, below: false });
});

test('bands next to today\'s prices', () => {
  const rows = bandRows({ BTC: { hl100: 103_038_392_164 }, nBTC: { im_bp: 8_309, mr_bp: 7_914 } }, { marks: { BTC: 76_000 }, pi: { nBTC: 8_400 } });
  assert.deepEqual(rows.map((r) => [r.asset, r.field, r.kind, r.level, r.now]), [
    ['BTC', 'hl100', 'price', 103_038.392164, 76_000],
    ['nBTC', 'im_bp', 'pi', 8_309, 8_400],
    ['nBTC', 'mr_bp', 'pi', 7_914, 8_400],
  ]);
  assert.deepEqual([showLevel('price', 103_038.392164), showLevel('pi', 8_309)], ['$103,038.39', '0.8309']);
});

test("the keeper's log as history: verdicts, and actions with their links", () => {
  const events: KeeperEvent[] = [
    { t: '3', event: 'verdict', state: 'DELEVERAGE', action: 'DELEVERAGE', blk: 7, eq: 400_000_000, mm: 470_000_000, im: 590_000_000 },
    { t: '2', event: 'check', msg: 'asked for a check; the verdict is in', why: 'the second check for DELEVERAGE', tx: 'H2', attestation_url: 'https://a/by-tx/H2', accepted: true },
    { t: '1', event: 'gateway', mode: 'cancel_risky', ok: false, code: 'P0', attestation_url: 'https://a/by-call/c0' },
  ];
  assert.deepEqual(verdictHistory(events), [{ at: '3', state: 'DELEVERAGE', action: 'DELEVERAGE', blk: 7, eq: 400_000_000, mm: 470_000_000, im: 590_000_000, links: [] }]);
  const timed: KeeperEvent[] = [
    { t: '2026-11-10T12:00:20.000Z', event: 'verdict', state: 'WATCH', action: 'NONE', blk: 9 },
    { t: '2026-11-10T12:00:05.000Z', event: 'check', tx: 'H9', attestation_url: 'https://a/by-tx/H9' },
  ];
  assert.deepEqual(verdictHistory(timed, txUrl)[0]!.links, [{ href: txUrl('H9'), text: 'check' }, { href: 'https://a/by-tx/H9', text: 'attestation' }], 'the check 15 s before it');
  assert.equal(riskWords('replay 2020-03-12 up (from 2020-03-13 02:16 UTC)'), 'The market of 2020-03-12 replayed with prices rising, from 2020-03-13 02:16 UTC');
  assert.equal(riskWords('ADL BTC 0.67S then 0.67S'), 'Hyperliquid auto-deleveraging part of the BTC position');
  assert.equal(riskWords('nBTC depeg 20%'), 'nBTC losing 20% against BTC');
  assert.equal(riskWords('something new'), 'something new');
  assert.deepEqual(keeperActions(events, txUrl), [
    { at: '2', what: 'Asked for a check', why: 'the second check for DELEVERAGE', ok: true, links: [{ href: txUrl('H2'), text: 'transaction' }, { href: 'https://a/by-tx/H2', text: 'attestation' }] },
    { at: '1', what: 'pb-gateway: cancel_risky refused (P0)', ok: false, links: [{ href: 'https://a/by-call/c0', text: 'attestation' }] },
  ]);
});

test('the slide command, the ratios it takes, and a slide from the bands', () => {
  assert.equal(slideCommand('0.82,0.78,0.75', '2'), 'pnpm --filter @pb/keeper drill -- --slide 0.82,0.78,0.75 --every 2');
  assert.equal(slideCommand('0.82', '2', 'drill1'), 'pnpm --filter @pb/keeper drill -- --slide 0.82 --every 2 --account drill1');
  assert.equal(slideFromBands({ nBTC: { im_bp: 8_406, mr_bp: 7_970, dl_bp: 7_594 } }), '0.8256,0.7820,0.7444');
  assert.equal(slideFromBands({ nBTC: { im_bp: 8_406 } }), null);
  assert.equal(slideFromBands(undefined), null);
  assert.equal(slideProblem('0.84,0.80,0.75'), null);
  assert.match(slideProblem('0.84,,0.75')!, /commas/);
  assert.match(slideProblem('0.84,1.2')!, /1.2 isn't a ratio|at most 1/);
});

test('Phase 4 moves pass the transfer and its expiry; the drill owner sets the ratio', () => {
  assert.deepEqual(withdrawTx('a.pbf.testnet', 'musdc.pbf-ops.testnet', '11000000', 'ab', { kind: 'to_hl', exp: T0 }, T0 - 60_000).actions[0]?.args, { token: 'musdc.pbf-ops.testnet', amount: '11000000', receiver: 'ab', transfer: { kind: 'to_hl', exp: T0 } });
  assert.deepEqual(withdrawTx('a.pbf.testnet', 'musdc.pbf-ops.testnet', '1', 'b').actions[0]?.args, { token: 'musdc.pbf-ops.testnet', amount: '1', receiver: 'b' }, 'unchanged without one');
  assert.deepEqual(hlWithdrawTx('a.pbf.testnet', '11000000', '0xFC9D', T0, T0 - 60_000).actions[0]?.args, { amount: '11000000', destination: '0xfc9d', exp: T0 });
  assert.deepEqual(setRatioTx('drill.pbf-ops.testnet', 7_500), { receiverId: 'drill.pbf-ops.testnet', actions: [{ methodName: 'set_ratio', args: { bp: 7_500 }, gas: '30000000000000', deposit: '0' }] });
});
