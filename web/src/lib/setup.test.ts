// Runs with Node's own TypeScript support: pnpm --filter @pb/web test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AccountAnswer, LenderAccountAnswer } from './api.ts';
import type { HlAnswer, HyperliquidView } from './hl.ts';
import { hedgePart, openingView, setupView, testCollateralStep } from './setup.ts';
import { STATE } from './test-fixtures.ts';

const account = (nbtc: string, principal = '0'): AccountAnswer => ({
  account_id: 'alice.pbf.testnet',
  block_height: 1_000,
  exists: true,
  has_contract: true,
  state: { ...STATE, loan: { principal } },
  balances: [
    { token: 'musdc.pbf-ops.testnet', symbol: 'USDC', decimals: 6, amount: '440000000' },
    { token: 'mnbtc.pbf-ops.testnet', symbol: 'nBTC', decimals: 8, amount: nbtc },
  ],
  debt: principal,
  borrower: null,
  not_deployed: [],
});

const view = (funded: boolean, agents: string[], short: boolean): HyperliquidView => ({
  clearinghouse_state: {
    marginSummary: { accountValue: funded ? '428' : '0', totalNtlPos: '0', totalMarginUsed: '0' },
    crossMarginSummary: { accountValue: funded ? '428' : '0', totalNtlPos: '0', totalMarginUsed: '0' },
    crossMaintenanceMarginUsed: '0',
    withdrawable: '0',
    assetPositions: short
      ? [{ position: { coin: 'BTC', szi: '-0.015', entryPx: '76000', positionValue: '1140', unrealizedPnl: '0', liquidationPx: null, leverage: { type: 'cross', value: 5 }, marginUsed: '228' } }]
      : [],
  },
  spot_usdc: null,
  abstraction: null,
  open_orders: [],
  fills: [],
  agents: agents.map((address) => ({ name: 'pb', address, validUntil: null })),
  errors: {},
});

const hl = (parts: { address?: boolean; funded?: boolean; agent?: boolean; approved?: boolean; short?: boolean; gateway?: boolean }): HlAnswer => ({
  account_id: 'alice.pbf.testnet',
  owner: 'alice.testnet',
  block_height: 1_000,
  near_time_ms: 0,
  hl: { path: 'hyperliquid-1', address: parts.address ? '0xabc' : null, agent: parts.agent ? { address: '0xAGENT', received_block: 900 } : null },
  address: parts.address ? '0xabc' : null,
  gateway: parts.gateway === false ? null : { project_id: 'pbf-keeper.testnet/pb-gateway', version_key: null },
  hyperliquid: parts.address ? view(Boolean(parts.funded), parts.approved ? ['0xagent'] : [], Boolean(parts.short)) : null,
});

test('a new visitor: one step done (the wallet), the account is next', () => {
  const v = setupView({ signedIn: true, account: { ...account('0'), exists: false, state: null }, hl: undefined });
  assert.equal(v.done, 1);
  assert.equal(v.next, 'account');
  assert.deepEqual(v.steps.map((s) => s.title), ['Connect your NEAR wallet', 'Open your account', 'Add collateral', 'Hedge on Hyperliquid', 'Borrow']);
});

test('collateral is done once the account holds nBTC', () => {
  assert.equal(setupView({ signedIn: true, account: account('0'), hl: undefined }).next, 'collateral');
  assert.equal(setupView({ signedIn: true, account: account('1500000'), hl: hl({}) }).next, 'hedge');
});

test('the hedge walks through its parts, and is done with a short on Hyperliquid', () => {
  assert.equal(hedgePart(hl({})), 'address');
  assert.equal(hedgePart(hl({ address: true })), 'margin');
  assert.equal(hedgePart(hl({ address: true, funded: true })), 'agent');
  assert.equal(hedgePart(hl({ address: true, funded: true, agent: true })), 'approve');
  assert.equal(hedgePart(hl({ address: true, funded: true, agent: true, approved: true })), 'short');
  assert.equal(hedgePart(hl({ address: true, funded: true, agent: true, approved: true, short: true })), 'done');
  assert.equal(hedgePart(hl({ address: true, gateway: false })), 'unavailable');
});

test('everything done once a loan is open', () => {
  const ready = hl({ address: true, funded: true, agent: true, approved: true, short: true });
  const before = setupView({ signedIn: true, account: account('1500000'), hl: ready });
  assert.equal(before.next, 'borrow');
  assert.equal(before.done, 4);
  const after = setupView({ signedIn: true, account: account('1500000', '1090000000'), hl: ready });
  assert.equal(after.complete, true);
  assert.equal(after.next, null);
});

test('a loan that came from a lender alone counts as borrowed too', () => {
  // Nothing owed to our pool, so the account's own loan record is closed, but it owes Rhea.
  const ready = hl({ address: true, funded: true, agent: true, approved: true, short: true });
  assert.equal(setupView({ signedIn: true, account: account('1000000'), hl: ready, borrowed: true }).complete, true);
  assert.equal(setupView({ signedIn: true, account: account('1000000'), hl: ready, borrowed: false }).next, 'borrow');
});

// Stage 3 (INTERFACES.md 33): the testnet step before the borrow, for an account whose config has Aave.
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f';
const atLenders = (over: Partial<LenderAccountAnswer> = {}): LenderAccountAnswer => ({
  account: 'alice.pbf.testnet', read_at_ms: 0, config_lenders: ['aave', 'rhea'], permission: null, funding: null, verdict_blk: null, lenders: [], pricing: null,
  evm: { address: '0x8c01b1a86db01769c246d3739da0bb74ae3217fb', nonce: 0, chain_nonce: 0, eth: '0', wallet: [{ token: USDC, symbol: 'USDC', decimals: 6, amount: '0' }], signed: [] },
  ...over,
});

test('on testnet, an account whose config has Aave gets a sixth step: test collateral for Aave, before the borrow', () => {
  const ready = hl({ address: true, funded: true, agent: true, approved: true, short: true });
  const view = setupView({ signedIn: true, account: account('1500000'), hl: ready, testCollateral: 'needed' });
  assert.deepEqual(view.steps.map((s) => s.title), ['Connect your NEAR wallet', 'Open your account', 'Add collateral', 'Hedge on Hyperliquid', 'Get test collateral for Aave', 'Borrow']);
  assert.equal(view.next, 'aave');
  assert.equal(view.done, 4);
  assert.equal(setupView({ signedIn: true, account: account('1500000'), hl: ready, testCollateral: 'done' }).next, 'borrow');
  // Without the step, the list is the five it was.
  assert.equal(setupView({ signedIn: true, account: account('1500000'), hl: ready }).steps.length, 5);
});

test('the step can be skipped, and a loan that is already open doesn’t wait for it', () => {
  const ready = hl({ address: true, funded: true, agent: true, approved: true, short: true });
  const skipped = setupView({ signedIn: true, account: account('1500000'), hl: ready, testCollateral: 'skipped' });
  assert.equal(skipped.next, 'borrow');
  assert.deepEqual(skipped.steps.find((s) => s.key === 'aave'), { key: 'aave', title: 'Get test collateral for Aave', done: true, skipped: true });
  assert.equal(setupView({ signedIn: true, account: account('1500000', '500000000'), hl: ready, testCollateral: 'needed' }).complete, true);
});

test('the step is done once the address holds a token Aave takes, or Aave holds some; USDC there doesn’t count', () => {
  const step = (lender: LenderAccountAnswer | undefined, skipped = false, testnet = true, helperOn: boolean | undefined = true) => testCollateralStep({ testnet, lender, skipped, helperOn });
  assert.equal(step(atLenders()), 'needed');
  assert.equal(step(atLenders(), true), 'skipped');
  const withEther = atLenders();
  withEther.evm!.wallet.push({ token: WETH, symbol: 'WETH', decimals: 18, amount: '20000000000000000' });
  assert.equal(step(withEther), 'done');
  const withUsdc = atLenders();
  withUsdc.evm!.wallet[0]!.amount = '323000000';
  assert.equal(step(withUsdc), 'needed');
  const posted = atLenders({ lenders: [{ l: 'aave', posted: 60_000_000, debt: 0, hf_bp: 0, liq_bp: 8_300, rate_bp: 74, supply_bp: 10, room: 0, status: 'none', held: [{ token: WETH, symbol: 'WETH', decimals: 18, amount: '20000000000000000' }] }] });
  assert.equal(step(posted), 'done');
  // No such step on mainnet, before the account's lenders are read, or for an account without Aave.
  assert.equal(step(atLenders(), false, false), undefined);
  assert.equal(step(undefined), undefined);
  assert.equal(step(atLenders({ config_lenders: ['rhea'] })), undefined);
});

test('the step shows only while the backend’s gas helper is on, unless the collateral is there already', () => {
  const step = (lender: LenderAccountAnswer, helperOn: boolean | undefined) => testCollateralStep({ testnet: true, lender, skipped: false, helperOn });
  // GET /api/evm/gas answers `on: false`, or hasn't answered yet: there is nothing to press.
  assert.equal(step(atLenders(), false), undefined);
  assert.equal(step(atLenders(), undefined), undefined);
  assert.equal(step(atLenders(), true), 'needed');
  // What Aave's own books show as posted (`evm.posted`) counts, before any check has read the account at Aave.
  const posted = atLenders();
  posted.evm!.posted = [{ token: WETH, symbol: 'WETH', decimals: 18, amount: '20000000000000000' }];
  assert.equal(step(posted, false), 'done');
  // After a close took the collateral back, the last check's row still shows it. Aave's own books say nothing is
  // there, and they are the ones that count: the step is to do again, so a reopened trade borrows at Aave too.
  const closed = atLenders({ lenders: [{ l: 'aave', posted: 60_000_000, debt: 0, hf_bp: 0, liq_bp: 8_300, rate_bp: 74, supply_bp: 10, room: 0, status: 'none', held: [{ token: WETH, symbol: 'WETH', decimals: 18, amount: '20000000000000000' }] }] });
  closed.evm!.posted = [];
  assert.equal(step(closed, true), 'needed');
});

test('Home’s checklist ends at the open account: two steps, and it is complete the moment the account is open', () => {
  // The user, 14 Nov: "all we want is to guide a person till they open the account", and "we want that thing to go away
  // after the account setup is done".
  const before = openingView(setupView({ signedIn: true, account: undefined, hl: undefined, testCollateral: 'needed' }));
  assert.deepEqual(before.steps.map((s) => s.title), ['Connect your NEAR wallet', 'Open your account']);
  assert.deepEqual([before.done, before.next, before.complete], [1, 'account', false]);
  const signedOut = openingView(setupView({ signedIn: false, account: undefined, hl: undefined }));
  assert.deepEqual([signedOut.done, signedOut.next, signedOut.complete], [0, 'wallet', false]);
  // The account is open and holds nothing: the whole list still has four steps to go, Home's has none.
  const whole = setupView({ signedIn: true, account: account('0'), hl: undefined, testCollateral: 'needed' });
  assert.equal(whole.complete, false);
  const after = openingView(whole);
  assert.deepEqual([after.steps.length, after.done, after.next, after.complete], [2, 2, null, true]);
});
