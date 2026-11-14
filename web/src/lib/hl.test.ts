// The account's Hyperliquid side as the pages show it: equity per account mode, the margin ratio, the setup steps,
// and finding the action the account just had signed.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentApproved,
  hlSummary,
  holdsLoan,
  isLoan,
  lastSignedIndex,
  liftsEarly,
  loanOpen,
  NEW_ACCOUNT_WORDS,
  newSignedEntry,
  PAUSE_CHECK_WORDS,
  pauseBanner,
  sendWindow,
  setupStep,
  signedIndexFromLogs,
  stillPausedWords,
  submitWords,
  type HlAnswer,
  type HyperliquidView,
} from './hl.ts';
import { swapStatusWords } from './swap.ts';

const AGENT = '0x000000000000000000000000000000000000a6e7';

const VIEW: HyperliquidView = {
  clearinghouse_state: {
    marginSummary: { accountValue: '9499.0', totalNtlPos: '25000.0', totalMarginUsed: '1000.0' },
    crossMarginSummary: { accountValue: '9499.0', totalNtlPos: '25000.0', totalMarginUsed: '1000.0' },
    crossMaintenanceMarginUsed: '425.0',
    withdrawable: '8499.0',
    assetPositions: [
      { position: { coin: 'BTC', szi: '-0.33', entryPx: '75757', positionValue: '25000', unrealizedPnl: '-12.5', liquidationPx: '101000', leverage: { type: 'cross', value: 25 }, marginUsed: '1000' } },
      { position: { coin: 'ETH', szi: '0.0', entryPx: '0', positionValue: '0', unrealizedPnl: '0', liquidationPx: null, leverage: { type: 'cross', value: 5 }, marginUsed: '0' } },
    ],
  },
  spot_usdc: { total: '0.0', hold: '0.0' },
  abstraction: 'default',
  open_orders: [],
  fills: [],
  agents: [{ name: 'pb', address: AGENT.toUpperCase().replace('0X', '0x'), validUntil: 1809552000000 }],
  errors: {},
};

const answer = (over: Partial<HlAnswer> = {}): HlAnswer => ({
  account_id: 'alice.pbf.testnet',
  owner: 'alice.testnet',
  block_height: 1,
  near_time_ms: 0,
  hl: { path: 'hyperliquid-1', address: '0xa11ce', agent: { address: AGENT, received_block: 5 }, signed: [] },
  address: '0xa11ce',
  gateway: { project_id: 'pbf-keeper.testnet/pb-gateway', version_key: null },
  hyperliquid: VIEW,
  ...over,
});

test("equity, the margin ratio and positions from Hyperliquid's own numbers; empty positions left out", () => {
  const s = hlSummary(VIEW);
  assert.equal(s.equity, 9499);
  assert.equal(s.marginRatioBp, 447, '425 / 9499');
  assert.deepEqual(s.positions.map((p) => [p.coin, p.side, p.size, p.leverage]), [['BTC', 'short', 0.33, '25x cross']]);
  assert.equal(s.note, null);
});

test('a unified account keeps its USDC in spot, so its equity adds spot USDC; in default mode it is flagged, not added', () => {
  const unified = hlSummary({ ...VIEW, abstraction: 'unifiedAccount', spot_usdc: { total: '207.36738', hold: '0' }, clearinghouse_state: { ...VIEW.clearinghouse_state!, crossMarginSummary: { accountValue: '0.0', totalNtlPos: '0', totalMarginUsed: '0' }, crossMaintenanceMarginUsed: '0.0', assetPositions: [] } });
  assert.equal(unified.equity, 207.36738);
  assert.equal(unified.marginRatioBp, 0);
  const fresh = hlSummary({ ...VIEW, spot_usdc: { total: '9.68', hold: '0' } });
  assert.equal(fresh.equity, 9499);
  assert.match(fresh.note!, /mode is "default".*still being checked/);
  assert.match(hlSummary({ ...VIEW, abstraction: 'disabled', spot_usdc: { total: '1', hold: '0' } }).note!, /not margin/);
});

test('the setup steps: address, first deposit, agent, approval', () => {
  assert.equal(setupStep(answer({ address: null, hyperliquid: null })), 'init');
  const empty = { ...VIEW, clearinghouse_state: { ...VIEW.clearinghouse_state!, crossMarginSummary: { accountValue: '0.0', totalNtlPos: '0', totalMarginUsed: '0' } } };
  assert.equal(setupStep(answer({ hyperliquid: empty })), 'fund');
  assert.equal(setupStep(answer({ hl: { path: 'hyperliquid-1', address: '0xa11ce', agent: null } })), 'agent');
  assert.equal(setupStep(answer({ hyperliquid: { ...VIEW, agents: [] } })), 'approve');
  assert.equal(setupStep(answer()), 'ready');
  assert.deepEqual(agentApproved(answer()), { approved: true, validUntil: 1809552000000 }, 'addresses compared ignoring case');
  assert.deepEqual(agentApproved(answer({ hyperliquid: { ...VIEW, agents: null } })), { approved: null, validUntil: null }, "can't tell while extraAgents failed");
});

test('the newly signed action: from the hl_signed event in the logs, or as a new entry in hl.signed', () => {
  const logs = [
    'verdict accepted: nonce 3',
    'EVENT_JSON:{"standard":"pb-pool","version":"1.0.0","event":"hl_signed","data":[{"account":"alice.pbf.testnet","index":4,"kind":"approveAgent","nonce":1794000000000}]}',
  ];
  assert.equal(signedIndexFromLogs(logs, 'approveAgent'), 4);
  assert.equal(signedIndexFromLogs(logs, 'sendAsset'), null);
  assert.equal(signedIndexFromLogs(['EVENT_JSON:{not json'], 'approveAgent'), null);

  const entry = (index: number, kind: string) => ({ index, kind, action: '{}', nonce: index, signature: { r: '0x', s: '0x', v: 27 }, signed_block: 1 });
  const hl = { path: 'hyperliquid-1', address: '0xa', signed: [entry(2, 'approveAgent'), entry(3, 'sendAsset'), entry(5, 'sendAsset')] };
  assert.equal(lastSignedIndex(hl), 5);
  assert.equal(lastSignedIndex({ path: 'p', address: null }), -1);
  assert.equal(newSignedEntry(hl, 'sendAsset', 3)?.index, 5);
  assert.equal(newSignedEntry(hl, 'approveAgent', 2), null);
});

test("Hyperliquid's reply to a posted action, and a move's statuses, in words", () => {
  assert.equal(submitWords({ account: 'a', index: 0, kind: 'approveAgent', nonce: 1, ok: true, http_status: 200, hl: { status: 'ok' } }), 'Hyperliquid accepted the approval.');
  assert.equal(submitWords({ account: 'a', index: 1, kind: 'sendAsset', nonce: 1, ok: false, http_status: 200, hl: { status: 'err', response: 'Must deposit before performing actions' } }), 'Hyperliquid refused it: Must deposit before performing actions');
  const ends = { to: 'the Hyperliquid address', refundTo: 'the account' };
  assert.deepEqual(swapStatusWords('SUCCESS', ends), { words: 'Delivered to the Hyperliquid address.', tone: 'success', done: true });
  assert.equal(swapStatusWords('REFUNDED', ends).words, 'Refunded to the account.');
  assert.equal(swapStatusWords('PROCESSING', ends).done, false);
});

test('borrowing waits while a signed transfer home can still be posted; a loan counts as open as the account counts it', () => {
  const hl = { path: 'hyperliquid-1', address: '0xa', send_open_until_ms: '1794315600000' };
  assert.deepEqual(sendWindow(hl, 1794315599999), { untilMs: 1794315600000 });
  assert.equal(sendWindow(hl, 1794315600000), null, 'open again at the time it names');
  assert.equal(sendWindow({ ...hl, send_open_until_ms: '0' }, 1), null, '"0" before the first sendAsset');
  assert.equal(sendWindow({ path: 'hyperliquid-1', address: null }, 1), null, 'a Phase 2 account has no window');
  assert.equal(loanOpen({ principal: '0', open: true }), true, 'repaid exactly: still open until a repayment comes back partly unused');
  assert.equal(loanOpen({ principal: '5', open: false }), false);
  assert.equal(loanOpen({ principal: '5' }), true, 'without the field, what is still owed decides');
  assert.equal(loanOpen(undefined), false);
});

// ---------- INTERFACES.md 50.2: the pause that lifts early ----------

const UNTIL = 1794315600000;
/** An account of before: the pause, and no list of open transfers. */
const BEFORE = { path: 'hyperliquid-1', address: '0xa', send_open_until_ms: String(UNTIL) };
/** An account made after the fix: the same pause, with the transfer it signed on the list. */
const AFTER = { ...BEFORE, open_sends: ['1794142800000'], send_floor_until_ms: '0' };

test('an account that shows open_sends lifts early; one that doesn’t keeps the rule of before', () => {
  assert.equal(liftsEarly(AFTER), true);
  assert.equal(liftsEarly({ ...AFTER, open_sends: [] }), true, 'an empty list is still the new account');
  assert.equal(liftsEarly(BEFORE), false);
  assert.equal(liftsEarly(null), false);
  assert.equal(liftsEarly(undefined), false);
});

test('a page holds back the check before a loan only for an account of before, while its pause is on', () => {
  assert.equal(holdsLoan(BEFORE, UNTIL - 1), true);
  assert.equal(holdsLoan(BEFORE, UNTIL), false, 'the pause is over');
  // The check itself lifts the pause on an account made after the fix, so it isn't held back.
  assert.equal(holdsLoan(AFTER, UNTIL - 1), false);
  assert.equal(holdsLoan({ path: 'hyperliquid-1', address: null }, 1), false);
  assert.equal(isLoan({ borrow: { amount: '1' } }), true);
  assert.equal(isLoan({ fund: { amount: '1' } }), true);
  assert.equal(isLoan({ withdraw: { token: 't', amount: '1' } }), false);
});

test('the banner: an account of before waits and is shown the way to a new account; one that lifts early gets “Check now”', () => {
  assert.deepEqual(pauseBanner(BEFORE, UNTIL - 1), { kind: 'wait', untilMs: UNTIL });
  assert.deepEqual(pauseBanner(AFTER, UNTIL - 1), { kind: 'check', untilMs: UNTIL });
  assert.equal(pauseBanner(BEFORE, UNTIL), null, 'when the pause is gone the banner goes');
  assert.equal(pauseBanner(AFTER, UNTIL), null);
  assert.equal(pauseBanner({ ...AFTER, send_open_until_ms: '0', open_sends: [] }, 1), null, 'the check that found the transfer sent cleared it');
  assert.equal(NEW_ACCOUNT_WORDS, 'A new account can borrow today.');
  assert.equal(PAUSE_CHECK_WORDS, 'Your transfer out of Hyperliquid went through. The next check confirms it, and borrowing opens again.');
});

test('after a check that left the pause on, the wallet isn’t opened for the loan and the page says when borrowing opens', () => {
  const when = () => '15 Nov, 09:00';
  assert.equal(
    stillPausedWords(AFTER, UNTIL - 1, when),
    'The last check didn’t find your transfer out of Hyperliquid in its history yet. Check again in a minute. If the transfer was never sent, borrowing opens again on 15 Nov, 09:00.',
  );
  // The check found it: the account cleared the pause, and the loan goes to the wallet.
  assert.equal(stillPausedWords({ ...AFTER, send_open_until_ms: '0', open_sends: [] }, UNTIL - 1, when), null);
  assert.equal(stillPausedWords(AFTER, UNTIL, when), null);
  // An account of before never gets here: its page held the check back, as it always did.
  assert.equal(stillPausedWords(BEFORE, UNTIL - 1, when), null);
});
