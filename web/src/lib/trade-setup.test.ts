// Getting ready to trade, as the Perps page leads through it (INTERFACES.md 51.9): which steps are left, how much
// USDC may be moved first, and the words on the button.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { HlAnswer, HyperliquidView } from './hl.ts';
import { MARGIN_MIN, MARGIN_SUGGESTED, readMargin, setupButtonWords, setupLeadWords, suggestedMargin, TESTNET_MARGIN_MAX, TRADE_PARTS, tradePartsDone, tradePartsLeft } from './trade-setup.ts';

const AGENT = '0x000000000000000000000000000000000000a6e7';

const view = (funded: boolean, approved: boolean): HyperliquidView => ({
  clearinghouse_state: {
    marginSummary: { accountValue: funded ? '299.0' : '0.0', totalNtlPos: '0', totalMarginUsed: '0' },
    crossMarginSummary: { accountValue: funded ? '299.0' : '0.0', totalNtlPos: '0', totalMarginUsed: '0' },
    crossMaintenanceMarginUsed: '0',
    withdrawable: funded ? '299.0' : '0.0',
    assetPositions: [],
  },
  spot_usdc: { total: '0.0', hold: '0.0' },
  abstraction: 'default',
  open_orders: [],
  fills: [],
  agents: approved ? [{ name: 'pb', address: AGENT, validUntil: 1809552000000 }] : [],
  errors: {},
});

const hl = (parts: { address?: boolean; funded?: boolean; agent?: boolean; approved?: boolean } = {}): HlAnswer => ({
  account_id: '4w4k4koqe2.pbf.testnet',
  owner: 'newgarden6661.testnet',
  block_height: 1,
  near_time_ms: 0,
  hl: parts.address ? { path: 'hyperliquid-1', address: '0x0c84', agent: parts.agent ? { address: AGENT, received_block: 5 } : null, signed: [] } : null,
  address: parts.address ? '0x0c84' : null,
  gateway: { project_id: 'pbf-keeper.testnet/pb-gateway', version_key: null },
  hyperliquid: parts.address ? view(Boolean(parts.funded), Boolean(parts.approved)) : null,
});

test('the four steps, in the order they run, each said in plain words', () => {
  assert.deepEqual(TRADE_PARTS.map((p) => p.part), ['address', 'margin', 'agent', 'approve']);
  for (const p of TRADE_PARTS) {
    assert.ok(p.title && p.why);
    assert.doesNotMatch(`${p.title} ${p.why}`, /MPC|ApproveAgent|hl_init|request_agent|pb-gateway|OutLayer|userAbstraction|extraAgents/i, 'no contract or protocol names');
  }
});

test('a new account has all four left; each step done drops out, whatever order they were done in', () => {
  assert.deepEqual(tradePartsLeft(hl()), ['address', 'margin', 'agent', 'approve']);
  assert.deepEqual(tradePartsLeft(hl({ address: true })), ['margin', 'agent', 'approve']);
  assert.deepEqual(tradePartsLeft(hl({ address: true, funded: true })), ['agent', 'approve']);
  assert.deepEqual(tradePartsLeft(hl({ address: true, funded: true, agent: true })), ['approve']);
  assert.deepEqual(tradePartsLeft(hl({ address: true, funded: true, agent: true, approved: true })), []);
  // 14 Nov, the user's own account: the key was connected on the Account page before any USDC was moved.
  const stuck = hl({ address: true, agent: true });
  assert.deepEqual(tradePartsDone(stuck), { address: true, margin: false, agent: true, approve: false });
  assert.deepEqual(tradePartsLeft(stuck), ['margin', 'approve'], 'the move comes first, then the approval');
});

test('the amount opens at $300, or at all the account holds when that is less', () => {
  assert.deepEqual([MARGIN_MIN, MARGIN_SUGGESTED, TESTNET_MARGIN_MAX], [10_000_000n, 300_000_000n, 500_000_000n]);
  assert.equal(suggestedMargin(12_274_948_429n), '300');
  assert.equal(suggestedMargin(440_000_000n), '300');
  assert.equal(suggestedMargin(120_500_000n), '120.5');
  assert.equal(suggestedMargin(9_999_999n), '', 'under $10 there is nothing to suggest');
  assert.deepEqual(readMargin(suggestedMargin(12_274_948_429n), 12_274_948_429n, true), { units: 300_000_000n, problem: null });
});

test('what is typed for the first move: at least $10, no more than the account holds, and $500 at most on testnet', () => {
  const held = 12_274_948_429n;
  assert.deepEqual(readMargin('', held, true), { units: null, problem: null });
  assert.deepEqual(readMargin('  ', held, true), { units: null, problem: null });
  assert.deepEqual(readMargin('250', held, true), { units: 250_000_000n, problem: null });
  assert.deepEqual(readMargin('$250.5', held, true), { units: 250_500_000n, problem: null });
  assert.deepEqual(readMargin('500', held, true), { units: 500_000_000n, problem: null });
  assert.equal(readMargin('abc', held, true).problem, 'Enter an amount of USDC, like 300.');
  assert.equal(readMargin('9.99', held, true).problem, 'Move at least $10: Hyperliquid opens the address with its first deposit.');
  assert.equal(readMargin('500.01', held, true).problem, 'On testnet, move $500 or less: the test USDC on Hyperliquid is shared by everyone trying the app.');
  assert.equal(readMargin('5000', held, true).units, null);
  // On mainnet only the account's own balance holds it.
  assert.deepEqual(readMargin('5000', held, false), { units: 5_000_000_000n, problem: null });
  assert.equal(readMargin('400', 120_500_000n, true).problem, 'Your account holds 120.5 USDC. Move that much or less.');
});

test('the button and the line over the steps say what one click does now', () => {
  assert.equal(setupButtonWords(['address', 'margin', 'agent', 'approve'], false), 'Set up trading');
  assert.equal(setupButtonWords(['margin', 'approve'], false), 'Continue setting up');
  assert.equal(setupButtonWords(['approve'], false), 'Finish setting up');
  assert.equal(setupButtonWords(['approve'], true), 'Working…');
  assert.equal(setupLeadWords(['margin', 'approve']), '2 steps are left. One button does them in order, and your wallet opens once for each. You do this once per account.');
  assert.equal(setupLeadWords(['approve']), 'One step is left. One button does it, and your wallet opens once. You do this once per account.');
});
