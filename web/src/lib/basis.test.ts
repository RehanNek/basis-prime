// The Basis trade page's decisions (INTERFACES.md 49.1, point 5): which tokens, the steps of opening from the
// account's real state, the next step of closing, and what a failure says.
// Runs with Node's own TypeScript support: pnpm --filter @pb/web test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AccountAnswer, LenderAccountAnswer, MarketCoin } from './api.ts';
import {
  aaveOwed,
  basisTokens,
  CLOSE_STAGES,
  closeStage,
  closeStateFrom,
  closeSummary,
  closeWords,
  comesHomeAsEther,
  collateralPlan,
  coversPool,
  defaultSize,
  dollarsToMicro,
  failureWords,
  hlWasRead,
  JARGON,
  marginEnough,
  marginFor,
  marginToMove,
  moveAmount,
  nextCloseStep,
  offersOwnEther,
  openApproval,
  openSteps,
  ownEtherAmount,
  openTitle,
  readSize,
  settingsTokens,
  suggestedLoan,
  valueMicro,
  type CloseState,
  type CloseStep,
  type OpenKey,
} from './basis.ts';
import type { HlAnswer, HyperliquidView } from './hl.ts';
import { lenderPayoff, poolExtra } from './loan.ts';
import { STATE } from './test-fixtures.ts';

const USDC = 'musdc.pbf-ops.testnet';
const NBTC = 'mnbtc.pbf-ops.testnet';
const AAVE_USDC = '0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f';
const WETH = '0x4200000000000000000000000000000000000006';
const NOW = 1_794_000_000_000;
const usd = (dollars: number) => BigInt(Math.round(dollars * 1e6));

// ---------- fixtures ----------

const account = (parts: { nbtc?: string; usdc?: string; debt?: string; pending?: unknown[]; exists?: boolean } = {}): AccountAnswer => ({
  account_id: 'alice.pbf.testnet',
  block_height: 1_000,
  exists: parts.exists ?? true,
  has_contract: parts.exists ?? true,
  state: parts.exists === false ? null : { ...STATE, loan: { principal: parts.debt ?? '0' }, pending: parts.pending ?? [] },
  balances: [
    { token: USDC, symbol: 'USDC', decimals: 6, amount: parts.usdc ?? '0' },
    { token: NBTC, symbol: 'nBTC', decimals: 8, amount: parts.nbtc ?? '0' },
  ],
  debt: parts.debt ?? '0',
  borrower: null,
  not_deployed: [],
});

const view = (funded: boolean, agents: string[], short: string | null, withdrawable = '0'): HyperliquidView => ({
  clearinghouse_state: {
    marginSummary: { accountValue: funded ? '428' : '0', totalNtlPos: '0', totalMarginUsed: '0' },
    crossMarginSummary: { accountValue: funded ? '428' : '0', totalNtlPos: '0', totalMarginUsed: '0' },
    crossMaintenanceMarginUsed: '0',
    withdrawable,
    assetPositions: short
      ? [{ position: { coin: short, szi: '-0.015', entryPx: '76000', positionValue: '1140', unrealizedPnl: '0', liquidationPx: null, leverage: { type: 'cross', value: 5 }, marginUsed: '228' } }]
      : [],
  },
  spot_usdc: null,
  abstraction: null,
  open_orders: [],
  fills: [],
  agents: agents.map((address) => ({ name: 'pb', address, validUntil: null })),
  errors: {},
});

const hl = (parts: { address?: boolean; funded?: boolean; agent?: boolean; approved?: boolean; short?: string | null; gateway?: boolean; withdrawable?: string } = {}): HlAnswer => ({
  account_id: 'alice.pbf.testnet',
  owner: 'alice.testnet',
  block_height: 1_000,
  near_time_ms: 0,
  hl: { path: 'hyperliquid-1', address: parts.address ? '0xabc' : null, agent: parts.agent ? { address: '0xAGENT', received_block: 900 } : null },
  address: parts.address ? '0xabc' : null,
  gateway: parts.gateway === false ? null : { project_id: 'pbf-keeper.testnet/pb-gateway', version_key: null },
  hyperliquid: parts.address ? view(Boolean(parts.funded), parts.approved ? ['0xagent'] : [], parts.short ?? null, parts.withdrawable) : null,
});

const HEDGED = hl({ address: true, funded: true, agent: true, approved: true, short: 'BTC' });

const lender = (parts: Partial<LenderAccountAnswer> = {}): LenderAccountAnswer => ({
  account: 'alice.pbf.testnet',
  read_at_ms: NOW,
  config_lenders: ['aave', 'rhea'],
  permission: null,
  funding: null,
  verdict_blk: null,
  lenders: [],
  pricing: null,
  evm: { address: '0x8c01b1a86db01769c246d3739da0bb74ae3217fb', nonce: 0, chain_nonce: 0, eth: '0', wallet: [{ token: AAVE_USDC, symbol: 'USDC', decimals: 6, amount: '0' }], signed: [] },
  ...parts,
});

const BTC = { symbol: 'nBTC', coin: 'BTC' };
const open = (parts: { account?: AccountAnswer; hl?: HlAnswer; lender?: LenderAccountAnswer | null; helperOn?: boolean; testnet?: boolean }) =>
  openSteps({ token: BTC, account: parts.account, hl: parts.hl, lender: parts.lender, testnet: parts.testnet ?? true, helperOn: parts.helperOn, nowMs: NOW });
const marks = (v: ReturnType<typeof openSteps>) => Object.fromEntries(v.steps.map((s) => [s.key, s.mark]));

/** An account with nothing open: every branch of the way out starts from this and adds what it is about. */
const closed: CloseState = {
  poolDebt: 0n,
  aaveDebt: 0n,
  rheaDebt: 0n,
  rheaDeposit: 0n,
  usdcNear: 0n,
  usdcEvm: 0n,
  usdcEvmToken: null,
  aaveHeld: [],
  rheaHeld: [],
  evmCollateral: [],
  nearTokens: [],
  moves: [],
  evmUnsent: null,
  evmUnmined: false,
  chainUnread: false,
  lenderBusy: false,
  planRunning: false,
  positions: [],
  hlWithdrawable: 0n,
  loanStillOpen: false,
  canMint: true,
  canFaucet: true,
};
const next = (parts: Partial<CloseState>): CloseStep => nextCloseStep({ ...closed, ...parts });

// ---------- the tokens ----------

const coin = (name: string, listed = true): MarketCoin => ({
  coin: name,
  allowed: true,
  tier: 1,
  band_bp: 300,
  universe_sz_decimals: 5,
  client_cap_usd: 1_000_000,
  testnet: listed ? { asset: 3, sz_decimals: name === 'BTC' ? 5 : 2, max_leverage: 40, delisted: false, mark_px: '76010', oracle_px: '76000', mid_px: null, day_ntl_vlm: null } : null,
  status: null,
});

test('the dropdown offers only tokens the settings list: BTC today, ETH and NEAR once they are there', () => {
  const two = [
    { id: USDC, symbol: 'USDC', decimals: 6 },
    { id: NBTC, symbol: 'nBTC', decimals: 8 },
  ];
  const today = basisTokens(two, ['USDC', 'nBTC'], [coin('BTC'), coin('ETH'), coin('NEAR')]);
  assert.deepEqual(today.map((t) => [t.coin, t.usable]), [['BTC', true]]);
  assert.equal(today[0]!.label, 'BTC (Bitcoin)');
  assert.equal(today[0]!.price, 76_000);
  assert.equal(today[0]!.szDecimals, 5);

  // After the deploy of INTERFACES.md 49.6: five tokens in the settings. USDC and USDT are dollars, so never a basis.
  const five = [...two, { id: 'eth.pbf-ops.testnet', symbol: 'ETH', decimals: 18 }, { id: 'wnear.pbf-ops.testnet', symbol: 'wNEAR', decimals: 24 }, { id: 'usdt.pbf-ops.testnet', symbol: 'USDT', decimals: 6 }];
  const later = basisTokens(five, ['USDC', 'nBTC', 'ETH', 'wNEAR', 'USDT'], [coin('BTC'), coin('ETH'), coin('NEAR')]);
  assert.deepEqual(later.map((t) => [t.coin, t.id, t.usable]), [
    ['BTC', NBTC, true],
    ['ETH', 'eth.pbf-ops.testnet', true],
    ['NEAR', 'wnear.pbf-ops.testnet', true],
  ]);
  // No settings, no tokens: nothing is made up.
  assert.deepEqual(basisTokens(null, ['nBTC'], [coin('BTC')]), []);
  assert.deepEqual(basisTokens([{ id: USDC, symbol: 'USDC', decimals: 6 }], ['USDC'], [coin('BTC')]), []);
});

test('each coin of the dropdown says whether a short can open now, from its live price and reference price; on mainnet all can', () => {
  // INTERFACES.md 50.4, 13 Nov 22:28 UTC: BTC's price stood 2.60% under its reference price, ETH's 1.13%, NEAR's 0.10%.
  const at = (name: string, oracle: number, offPercent: number): MarketCoin => {
    const row = coin(name);
    return { ...row, testnet: { ...row.testnet!, mark_px: String(oracle * (1 + offPercent / 100)), oracle_px: String(oracle) } };
  };
  const settings = [
    { id: NBTC, symbol: 'nBTC', decimals: 8 },
    { id: 'eth.pbf-ops.testnet', symbol: 'ETH', decimals: 18 },
    { id: 'wnear.pbf-ops.testnet', symbol: 'wNEAR', decimals: 24 },
  ];
  const readable = ['nBTC', 'ETH', 'wNEAR'];
  const live = [at('BTC', 68_800, -2.6), at('ETH', 1_950, -1.13), at('NEAR', 3.5, -0.1)];
  const options = basisTokens(settings, readable, live);
  assert.deepEqual(options.map((o) => [o.coin, o.usable, o.tradesNow]), [['BTC', true, false], ['ETH', true, true], ['NEAR', true, true]]);
  assert.equal(options[0]!.whyNotNow, 'Hyperliquid testnet’s BTC price is 2.6% away from its reference price right now, and it takes no order that far out. Pick another coin, or try BTC again later.');
  assert.deepEqual([options[1]!.whyNotNow, options[2]!.whyNotNow], [null, null]);
  // Before the markets have answered nothing is stopped, and on mainnet nothing ever is.
  assert.deepEqual(basisTokens(settings, readable, undefined).map((o) => o.tradesNow), [true, true, true]);
  assert.deepEqual(basisTokens(settings, readable, live, false).map((o) => [o.tradesNow, o.whyNotNow]), [[true, null], [true, null], [true, null]]);
});

test('a token the page can’t read, or a coin Hyperliquid doesn’t list, shows and can’t be picked, with the reason', () => {
  const settings = [
    { id: NBTC, symbol: 'nBTC', decimals: 8 },
    { id: 'eth.pbf-ops.testnet', symbol: 'ETH', decimals: 18 },
  ];
  const unread = basisTokens(settings, ['USDC', 'nBTC'], [coin('BTC'), coin('ETH')]);
  assert.equal(unread[1]!.usable, false);
  assert.match(unread[1]!.why!, /can’t read the account’s ETH/);
  const unlisted = basisTokens(settings, ['nBTC', 'ETH'], [coin('BTC'), coin('ETH', false)]);
  assert.equal(unlisted[1]!.usable, false);
  assert.match(unlisted[1]!.why!, /isn’t listed on Hyperliquid/);
});

test('settingsTokens reads `tokens` from a config answer, and gives null for anything else', () => {
  assert.deepEqual(settingsTokens({ tokens: [{ id: NBTC, symbol: 'nBTC', decimals: 8 }, { id: 7 }], pool_id: 'pool.pbf.testnet' }), [{ id: NBTC, symbol: 'nBTC', decimals: 8 }]);
  assert.equal(settingsTokens(null), null);
  assert.equal(settingsTokens({ tokens: [] }), null);
  assert.equal(settingsTokens({ lenders: {} }), null);
});

// ---------- sizes and amounts ----------

test('the first size is about $1,150 of the coin, in two figures and within Hyperliquid’s size step', () => {
  assert.equal(defaultSize(76_000, 5), '0.015');
  assert.equal(defaultSize(3_500, 4), '0.32');
  assert.equal(defaultSize(2.5, 1), '460');
  assert.equal(defaultSize(3_500, 1), '0.3');
  assert.equal(defaultSize(null, 5), '');
});

test('a size is read in the token’s units, and one finer than Hyperliquid’s step is refused in words', () => {
  assert.deepEqual(readSize('0.015', { decimals: 8 }, 5), { units: 1_500_000n, problem: null });
  assert.deepEqual(readSize('0.0150', { decimals: 8 }, 5), { units: 1_500_000n, problem: null });
  assert.equal(readSize('0.0150001', { decimals: 8 }, 5).problem, 'Hyperliquid takes at most 5 decimal places for this coin');
  assert.equal(readSize('1.5', { decimals: 24 }, 0).problem, 'Hyperliquid takes whole numbers of this coin');
  assert.equal(readSize('0', { decimals: 8 }, 5).problem, 'Enter a size above 0');
  assert.equal(readSize('abc', { decimals: 8 }, 5).problem, 'Enter a size, like 0.015');
  assert.deepEqual(readSize('', { decimals: 8 }, 5), { units: null, problem: null });
});

test('the margin is 25% of the short, up to $10, and the collateral step adds only what is missing', () => {
  const value = valueMicro(1_500_000n, 8, 76_000)!;
  assert.equal(value, usd(1_140));
  // 25% of $1,140 is $285, rounded up to $290 (it was 38%, $440, until 14 Nov).
  assert.equal(marginFor(value), usd(290));
  assert.equal(marginFor(usd(30)), usd(20));
  // A new account: the coin, and the margin with the $10 that stays on NEAR.
  assert.deepEqual(collateralPlan({ sizeUnits: 1_500_000n, heldUnits: 0n, usdcHeld: 0n, value, hlEquity: 0n }), { coin: 1_500_000n, usdc: usd(300) });
  // The coin is there already and some of the USDC: only the rest.
  assert.deepEqual(collateralPlan({ sizeUnits: 1_500_000n, heldUnits: 1_500_000n, usdcHeld: usd(100), value, hlEquity: 0n }), { coin: 0n, usdc: usd(200) });
  // Enough margin already on Hyperliquid: no more USDC.
  assert.deepEqual(collateralPlan({ sizeUnits: 2_000_000n, heldUnits: 1_500_000n, usdcHeld: 0n, value, hlEquity: usd(428) }), { coin: 500_000n, usdc: 0n });
  // The 73 cents an earlier trade left there is not margin: the rest is added, with the $10 that stays on NEAR.
  assert.deepEqual(collateralPlan({ sizeUnits: 1_500_000n, heldUnits: 0n, usdcHeld: usd(0.62), value, hlEquity: usd(0.73) }), { coin: 1_500_000n, usdc: usd(290 - 0.73 + 10 - 0.62) });
  // A little short of the full margin: at least $10 moves, the least that can.
  assert.deepEqual(collateralPlan({ sizeUnits: 1_500_000n, heldUnits: 1_500_000n, usdcHeld: 0n, value, hlEquity: usd(215) }), { coin: 0n, usdc: usd(85) });
  assert.equal(marginEnough(usd(218), value), true);
  assert.equal(marginEnough(usd(217), value), false);
  assert.equal(valueMicro(1n, 8, null), null);
});

test('the margin that moves is all the USDC but $10, and nothing under Hyperliquid’s $10 first deposit', () => {
  assert.equal(marginToMove(usd(450)), usd(440));
  assert.equal(marginToMove(usd(15)), usd(15));
  assert.equal(marginToMove(usd(9)), null);
});

test('the loan’s default: the engine’s own figure when there is one, else 40% of the coin, and nothing under $1,000', () => {
  assert.equal(suggestedLoan({ estimate: 512_345_678n, coinValue: usd(1_140) }), 512_340_000n);
  assert.equal(suggestedLoan({ estimate: null, coinValue: usd(1_140) }), usd(450));
  assert.equal(suggestedLoan({ estimate: 0n, coinValue: usd(1_140) }), usd(450));
  assert.equal(suggestedLoan({ estimate: null, coinValue: usd(900) }), null);
  assert.equal(suggestedLoan({ estimate: null, coinValue: null }), null);
});

// ---------- opening ----------

test('opening, step by step: each step is done by what the chain and Hyperliquid show, and the next one is current', () => {
  const walk: [string, Parameters<typeof open>[0], OpenKey | null][] = [
    ['no account yet', { account: account({ exists: false }) }, 'account'],
    ['an empty account', { account: account() }, 'collateral'],
    ['the coin without margin', { account: account({ nbtc: '1500000', usdc: '15000000' }) }, 'collateral'],
    ['coin and margin', { account: account({ nbtc: '1500000', usdc: '450000000' }) }, 'address'],
    ['an address', { account: account({ nbtc: '1500000', usdc: '450000000' }), hl: hl({ address: true }) }, 'margin'],
    ['margin on Hyperliquid', { account: account({ nbtc: '1500000', usdc: '10000000' }), hl: hl({ address: true, funded: true }) }, 'agent'],
    ['an agent', { account: account({ nbtc: '1500000', usdc: '10000000' }), hl: hl({ address: true, funded: true, agent: true }) }, 'approve'],
    ['the agent approved', { account: account({ nbtc: '1500000', usdc: '10000000' }), hl: hl({ address: true, funded: true, agent: true, approved: true }) }, 'short'],
    ['the short open', { account: account({ nbtc: '1500000', usdc: '10000000' }), hl: HEDGED }, 'loan'],
    ['borrowed', { account: account({ nbtc: '1500000', usdc: '510000000', debt: '500000000' }), hl: HEDGED }, null],
  ];
  for (const [name, input, expected] of walk) {
    const v = open(input);
    assert.equal(v.next, expected, name);
    assert.equal(v.waiting, false, name);
    const at = v.steps.findIndex((s) => s.key === expected);
    assert.deepEqual(v.steps.map((s) => s.mark).filter((m) => m === 'current').length, expected ? 1 : 0, name);
    if (expected) assert.equal(v.steps[at]!.mark, 'current', name);
  }
  const done = open({ account: account({ nbtc: '1500000', usdc: '510000000', debt: '500000000' }), hl: HEDGED });
  assert.equal(done.complete, true);
  assert.deepEqual(done.steps.map((s) => s.key), ['account', 'collateral', 'address', 'margin', 'agent', 'approve', 'short', 'loan']);
});

test('a dollar left on Hyperliquid by an earlier trade is not margin: the trade can be opened again after a close', () => {
  // After "Close everything": the account, its address and its agent are still there, and $0.73 is left on Hyperliquid.
  const leftover: HlAnswer = { ...hl({ address: true, funded: true, agent: true, approved: true }), hyperliquid: { ...view(true, ['0xagent'], null), clearinghouse_state: { ...view(true, [], null).clearinghouse_state!, crossMarginSummary: { accountValue: '0.73', totalNtlPos: '0', totalMarginUsed: '0' } } } };
  const value = usd(1_140);
  const read = (a: AccountAnswer) => openSteps({ token: BTC, account: a, hl: leftover, lender: null, testnet: true, helperOn: undefined, nowMs: NOW, value });
  // Nothing in the account: the collateral step is next, and it will add the margin too.
  assert.equal(read(account()).next, 'collateral');
  // The coin and the margin's USDC are in the account: the margin moves next, though the address is "funded".
  const again = read(account({ nbtc: '1500000', usdc: '450000000' }));
  assert.equal(again.next, 'margin');
  assert.deepEqual([marks(again).address, marks(again).margin, marks(again).agent, marks(again).approve, marks(again).short], ['done', 'current', 'done', 'done', 'todo']);
  // Without a value to measure against, any USDC there counts, as on Home's checklist.
  assert.equal(openSteps({ token: BTC, account: account({ nbtc: '1500000', usdc: '450000000' }), hl: leftover, lender: null, testnet: true, helperOn: undefined, nowMs: NOW }).next, 'short');
  // With the short open, the margin is whatever Hyperliquid holds: nothing to move.
  assert.equal(openSteps({ token: BTC, account: account({ nbtc: '1500000', usdc: '10000000' }), hl: HEDGED, lender: null, testnet: true, helperOn: undefined, nowMs: NOW, value: usd(5_000) }).next, 'loan');
});

test('margin on its way to Hyperliquid is waited for, never sent a second time', () => {
  const moving = account({ nbtc: '1500000', usdc: '10000000', pending: [{ transfer: { id: 'move:1', kind: 'to_hl', token: USDC, amount: '440000000', dep: 'dep1', deadline: '0' } }] });
  const v = open({ account: moving, hl: hl({ address: true }) });
  assert.equal(v.next, 'margin');
  assert.equal(v.waiting, true);
  assert.equal(marks(v).margin, 'waiting');
  // The $10 left on NEAR is not mistaken for missing collateral while the rest is on its way.
  assert.equal(marks(v).collateral, 'done');
});

test('a loan whose steps are still running is waited for, and counts as borrowed once they have run', () => {
  const plan = { pid: 'f1', amount: '500000000', stored_at: `${NOW - 60_000}000000`, expires_at: `${NOW + 29 * 60_000}000000`, steps: [{ k: 'p_borrow', amt: 500_000_000, done: false }] };
  const running = open({ account: account({ nbtc: '1500000', usdc: '10000000' }), hl: HEDGED, lender: lender({ funding: plan }) });
  assert.equal(running.next, 'loan');
  assert.equal(running.waiting, true);
  // A loan from a lender alone leaves the account's own loan record closed: it is borrowed all the same.
  const fromAave = lender({ lenders: [{ l: 'aave', posted: 39_260_000, debt: 21_710_000, hf_bp: 15_400, liq_bp: 8_300, rate_bp: 74, supply_bp: 10, room: 0, status: 'safe', held: [{ token: WETH, symbol: 'WETH', decimals: 18, amount: '20000000000000000' }] }] });
  assert.equal(open({ account: account({ nbtc: '1500000', usdc: '10000000' }), hl: HEDGED, lender: fromAave }).complete, true);
});

test('a lender loan that was repaid doesn’t count as borrowed, though the last check still shows it: the trade can be opened again', () => {
  const stale = { l: 'aave' as const, posted: 39_260_000, debt: 21_710_000, hf_bp: 15_400, liq_bp: 8_300, rate_bp: 74, supply_bp: 10, room: 0, status: 'safe' as const };
  const evm = { address: '0x8c01', nonce: 6, chain_nonce: 6, eth: '1', wallet: [{ token: WETH, symbol: 'WETH', decimals: 18, amount: '20000000000000000' }], posted: [], signed: [] };
  // Repaid, and the collateral taken back: nothing is posted with Aave, so nothing is owed there.
  const again = open({ account: account({ nbtc: '1500000', usdc: '10000000' }), hl: HEDGED, lender: lender({ lenders: [stale], evm }), helperOn: true });
  assert.equal(again.next, 'loan');
  assert.equal(again.complete, false);
  // Still posted and still owed: borrowed.
  const owing = lender({ lenders: [stale], evm: { ...evm, posted: [{ token: WETH, symbol: 'WETH', decimals: 18, amount: '20000000000000000' }] } });
  assert.equal(open({ account: account({ nbtc: '1500000', usdc: '10000000' }), hl: HEDGED, lender: owing, helperOn: true }).complete, true);
});

test('test collateral for Aave is a step only on testnet, for an account whose settings name Aave, while the helper is on', () => {
  const ready = { account: account({ nbtc: '1500000', usdc: '10000000' }), hl: HEDGED };
  const withAave = open({ ...ready, lender: lender(), helperOn: true });
  assert.equal(withAave.next, 'aave');
  assert.deepEqual(withAave.steps.map((s) => s.key).slice(-2), ['aave', 'loan']);
  // Once the address holds collateral, the step is done and the loan is next.
  const got = lender({ evm: { address: '0x8c01', nonce: 0, chain_nonce: 0, eth: '0', wallet: [{ token: WETH, symbol: 'WETH', decimals: 18, amount: '20000000000000000' }], signed: [] } });
  assert.equal(open({ ...ready, lender: got, helperOn: true }).next, 'loan');
  // No Aave in the settings, the helper off, or mainnet: no such step.
  for (const without of [open({ ...ready, lender: lender({ config_lenders: ['rhea'] }), helperOn: true }), open({ ...ready, lender: lender(), helperOn: false }), open({ ...ready, lender: lender(), helperOn: true, testnet: false })]) {
    assert.equal(without.steps.some((s) => s.key === 'aave'), false);
    assert.equal(without.next, 'loan');
  }
});

test('the short is the picked coin’s: a BTC short doesn’t hedge ETH', () => {
  const eth = openSteps({ token: { symbol: 'ETH', coin: 'ETH' }, account: { ...account(), balances: [...account({ usdc: '10000000' }).balances, { token: 'eth.pbf-ops.testnet', symbol: 'ETH', decimals: 18, amount: '320000000000000000' }] }, hl: HEDGED, lender: null, testnet: true, helperOn: undefined, nowMs: NOW });
  assert.equal(eth.next, 'short');
  assert.equal(eth.steps.find((s) => s.key === 'short')!.title, 'Short the same amount of ETH');
});

test('an account from before trading existed is told so, and nothing is offered', () => {
  assert.match(open({ account: account({ nbtc: '1500000' }), hl: hl({ gateway: false }) }).blocked!, /can’t hedge/);
  assert.equal(open({ account: account({ nbtc: '1500000' }), hl: hl({}) }).blocked, null);
});

test('each wallet approval is announced before it opens, with its amounts', () => {
  assert.equal(openApproval('margin', 'BTC', { margin: '430 USDC' }), 'Your wallet will ask you to approve: move 430 USDC to Hyperliquid.');
  assert.equal(openApproval('collateral', 'BTC', { coin: '0.015 BTC', usdc: '450 USDC' }), 'Your wallet will ask you to approve: add 0.015 BTC and 450 USDC to your account, as test tokens.');
  assert.match(openApproval('account', 'BTC', { permission: true })!, /open your account, for 6 NEAR.*outside lenders/);
  assert.match(openApproval('short', 'BTC', { size: '0.015 BTC' })!, /^Your wallet will ask you to sign: sell 0\.015 BTC on Hyperliquid/);
  assert.equal(openApproval('loan', 'BTC', { loan: '$450.00' }), 'Your wallet will ask you to approve: borrow $450.00.');
  // Test collateral for Aave comes from the backend's own wallet: nothing to approve.
  assert.equal(openApproval('aave', 'BTC'), null);
});

// ---------- closing: every branch of nextCloseStep ----------

test('closing: nothing open is done', () => {
  assert.deepEqual(next({}), { kind: 'done' });
});

test('closing: what is already under way comes first, in this order', () => {
  const busy: Partial<CloseState> = { poolDebt: usd(478), usdcNear: usd(488), planRunning: true, lenderBusy: true, evmUnsent: 4, evmUnmined: true, moves: [{ id: 'move:2', kind: 'e_home', stage: 'moving', overdue: false }] };
  assert.deepEqual(next(busy), { kind: 'stop_loan' });
  assert.deepEqual(next({ ...busy, planRunning: false }), { kind: 'wait_lender' });
  assert.deepEqual(next({ ...busy, planRunning: false, lenderBusy: false }), { kind: 'send_signed', nonce: 4 });
  assert.deepEqual(next({ ...busy, planRunning: false, lenderBusy: false, evmUnsent: null }), { kind: 'wait_mined' });
  assert.deepEqual(next({ ...busy, planRunning: false, lenderBusy: false, evmUnsent: null, evmUnmined: false }), { kind: 'wait_move', id: 'move:2', moveKind: 'e_home' });
});

test('closing, the lesson of 13 Nov: after USDC is sent to Aave’s chain the next step is the check, and only then the repayment', () => {
  const owes: Partial<CloseState> = { aaveDebt: usd(21.71), usdcEvmToken: AAVE_USDC };
  // 1. The address is short, the account on NEAR has the USDC: send it.
  const send = next({ ...owes, usdcEvm: 0n, usdcNear: usd(30), canFaucet: false });
  assert.equal(send.kind, 'usdc_out');
  // 2. The move is listed and on its way: wait, whatever the address holds.
  const listed = { id: 'move:2', kind: 'to_evm', overdue: false };
  assert.deepEqual(next({ ...owes, usdcEvm: 0n, moves: [{ ...listed, stage: 'moving' }] }), { kind: 'wait_move', id: 'move:2', moveKind: 'to_evm' });
  assert.deepEqual(next({ ...owes, usdcEvm: usd(21.8), moves: [{ ...listed, stage: null }] }), { kind: 'wait_move', id: 'move:2', moveKind: 'to_evm' });
  // 3. It has arrived and is still listed: the check, never the repayment, even though the address now covers the debt.
  const arrived = next({ ...owes, usdcEvm: usd(21.8), moves: [{ ...listed, stage: 'arrived' }] });
  assert.deepEqual(arrived, { kind: 'check_move', id: 'move:2' });
  // The same when its deadline has passed: a check settles a move that did arrive.
  assert.deepEqual(next({ ...owes, usdcEvm: usd(21.8), moves: [{ ...listed, stage: 'arrived', overdue: true }] }), { kind: 'check_move', id: 'move:2' });
  // 4. The check has seen it, so the account lists nothing: now the repayment.
  assert.deepEqual(next({ ...owes, usdcEvm: usd(21.8), moves: [] }), { kind: 'repay_aave', amount: lenderPayoff(usd(21.71)), token: AAVE_USDC });
});

test('closing: a move past its deadline that never arrived is dropped, so it stops being listed', () => {
  assert.deepEqual(next({ moves: [{ id: 'move:3', kind: 'to_evm', stage: 'failed', overdue: true }] }), { kind: 'drop_move', id: 'move:3' });
  assert.deepEqual(next({ moves: [{ id: 'move:4', kind: 'e_home', stage: 'refunded', overdue: true }] }), { kind: 'drop_move', id: 'move:4' });
  // Sent back, deadline not passed yet: it is still listed, so the page waits.
  assert.deepEqual(next({ moves: [{ id: 'move:4', kind: 'e_home', stage: 'refunded', overdue: false }] }), { kind: 'wait_move', id: 'move:4', moveKind: 'e_home' });
});

test('closing: our pool is repaid first when the account’s USDC covers it, which needs no check', () => {
  // The user's own account on 13 Nov: $488.28 on NEAR, $478.28 owed to the pool, Aave's $21.72 at the address.
  const demo: Partial<CloseState> = { poolDebt: usd(478.28), usdcNear: usd(488.28), aaveDebt: usd(21.71), usdcEvm: usd(21.72), usdcEvmToken: AAVE_USDC };
  assert.deepEqual(next(demo), { kind: 'repay_pool', amount: usd(478.28) + poolExtra(usd(478.28)), owed: usd(478.28) });
  // With less than the pool's little extra to spare, all of the USDC goes: the pool sends back what is above the debt.
  assert.deepEqual(next({ poolDebt: usd(478.28), usdcNear: usd(478.5) }), { kind: 'repay_pool', amount: usd(478.5), owed: usd(478.28) });
  assert.equal(coversPool(usd(478.28), usd(478.28)), false);
  assert.equal(coversPool(usd(478.3), usd(478.28)), true);
});

test('closing: a loan the account still counts as open, with nothing owed, is closed by $1 that comes straight back', () => {
  // Otherwise USDC can't come home from Hyperliquid: the account refuses while its loan is open.
  assert.deepEqual(next({ loanStillOpen: true, usdcNear: usd(10), hlWithdrawable: usd(430) }), { kind: 'repay_pool', amount: usd(1), owed: 0n });
  assert.equal(closeWords({ kind: 'repay_pool', amount: usd(1), owed: 0n }).title, 'Close the loan with our pool');
  assert.deepEqual(next({ loanStillOpen: true, usdcNear: 0n, hlWithdrawable: usd(430) }), { kind: 'add_usdc', amount: usd(1), canMint: true });
  const exact = closeStateFrom({ account: { ...account({ usdc: '10000000' }), state: { ...STATE, loan: { principal: '0', open: true } } }, hl: undefined, lender: null, nowMs: NOW, testnet: true });
  assert.equal(exact.loanStillOpen, true);
  assert.equal(closeStateFrom({ account: account({ usdc: '10000000' }), hl: undefined, lender: null, nowMs: NOW, testnet: true }).loanStillOpen, false);
});

test('closing: when the USDC on NEAR doesn’t cover the pool, the lender’s money comes home from Aave’s chain, with its check', () => {
  const step = next({ poolDebt: usd(478.28), usdcNear: usd(460), usdcEvm: usd(21.72), usdcEvmToken: AAVE_USDC, aaveDebt: usd(21.71) });
  assert.equal(step.kind, 'usdc_home');
  assert.deepEqual(step, { kind: 'usdc_home', token: AAVE_USDC, amount: moveAmount(usd(478.28) + usd(478.28) / 50_000n + 100n - usd(460)), needsCheck: true });
  // Never more than is there.
  const all = next({ poolDebt: usd(478.28), usdcNear: usd(400), usdcEvm: usd(21.72), usdcEvmToken: AAVE_USDC });
  assert.deepEqual(all, { kind: 'usdc_home', token: AAVE_USDC, amount: usd(21.72), needsCheck: true });
});

test('closing: with nothing to bring home, the account needs more USDC: minted on testnet, asked for on mainnet', () => {
  const short = next({ poolDebt: usd(478.28), usdcNear: usd(470) });
  assert.equal(short.kind, 'add_usdc');
  assert.equal(short.kind === 'add_usdc' && short.canMint, true);
  assert.equal(short.kind === 'add_usdc' && short.amount > usd(9) && short.amount < usd(10), true);
  const mainnet = next({ poolDebt: usd(478.28), usdcNear: usd(470), canMint: false });
  assert.equal(mainnet.kind === 'add_usdc' && mainnet.canMint, false);
  assert.equal(closeWords(mainnet).approval, null);
  assert.match(closeWords(mainnet).note!, /Add funds, then press Close everything again/);
});

test('closing: Rhea is repaid from NEAR with the little extra that clears it, and what it keeps comes back', () => {
  assert.deepEqual(next({ rheaDebt: usd(192.53), usdcNear: usd(300) }), { kind: 'repay_rhea', amount: lenderPayoff(usd(192.53)) });
  assert.equal(next({ rheaDebt: usd(192.53), usdcNear: usd(100) }).kind, 'add_usdc');
  assert.deepEqual(next({ rheaDeposit: 4_100n, usdcNear: usd(100) }), { kind: 'rhea_deposit_back', amount: 4_100n });
  // The collateral comes back before the deposit does: while the deposit lies there, it shows that Rhea has been paid.
  const nbtc = { token: NBTC, symbol: 'nBTC', decimals: 8, amount: 1_310_000n };
  assert.deepEqual(next({ rheaDeposit: 4_100n, rheaHeld: [nbtc] }), { kind: 'take_back', lender: 'rhea', held: nbtc });
});

test('a repayment the last check hasn’t seen still counts: Aave’s own chain shows it, so no check is needed to go on', () => {
  const borrow = { nonce: 2, kind: 'borrow', amount: '21710000', status: 'mined' };
  const repay = { nonce: 4, kind: 'repay', amount: '21710534', status: 'mined' };
  // Borrowed and not repaid: the check's figure, which has the interest.
  assert.equal(aaveOwed(usd(21.72), [borrow]), usd(21.72));
  // Repaid in full since the check: nothing is owed, whatever the check still says.
  assert.equal(aaveOwed(usd(21.72), [borrow, { nonce: 3, kind: 'approve', status: 'mined' }, repay]), 0n);
  // A repayment that isn't mined yet, or failed on the chain, takes nothing off.
  assert.equal(aaveOwed(usd(21.72), [borrow, { ...repay, status: 'sent' }]), usd(21.72));
  assert.equal(aaveOwed(usd(21.72), [borrow, { ...repay, status: 'failed' }]), usd(21.72));
  // Borrowed again after repaying: the new loan is owed.
  assert.equal(aaveOwed(0n, [borrow, repay, { nonce: 5, kind: 'borrow', amount: '50000000', status: 'mined' }]), usd(50));
  // A part repayment leaves the rest; the larger of the two figures is asked for, and Aave takes only what it is owed.
  assert.equal(aaveOwed(usd(21.72), [borrow, { ...repay, amount: '10000000' }]), usd(21.72));
  assert.equal(aaveOwed(usd(5), [borrow, { ...repay, amount: '10000000' }]), usd(11.71));
  // A list that can't tell (no borrow on it, or full, so its oldest may be gone): the check's figure stands.
  assert.equal(aaveOwed(usd(21.72), [repay]), usd(21.72));
  assert.equal(aaveOwed(usd(21.72), Array.from({ length: 20 }, (_, i) => ({ ...repay, nonce: i }))), usd(21.72));
});

test('after Aave and Rhea are repaid, the close state says so at once, though the last check still shows the loans', () => {
  const stale = { posted: 39_260_000, debt: 21_710_000, hf_bp: 15_400, liq_bp: 8_300, rate_bp: 74, supply_bp: 10, room: 0, status: 'safe' as const };
  const weth = { token: WETH, symbol: 'WETH', decimals: 18, amount: '20000000000000000' };
  const evm = (signed: { nonce: number; kind: string; amount?: string; hash: string; status: string }[], posted = [weth]) => ({
    address: '0x8c01',
    nonce: 5,
    chain_nonce: 5,
    eth: '1',
    wallet: [{ token: AAVE_USDC, symbol: 'USDC', decimals: 6, amount: '1000000' }],
    posted,
    signed,
  });
  const read = (l: LenderAccountAnswer) => closeStateFrom({ account: account({ usdc: '10000000' }), hl: HEDGED, lender: l, nowMs: NOW, testnet: true, helperOn: true });
  const borrowed = [{ nonce: 1, kind: 'supply', hash: '0x1', status: 'mined' }, { nonce: 2, kind: 'borrow', amount: '21710000', hash: '0x2', status: 'mined' }];
  const repaid = [...borrowed, { nonce: 3, kind: 'approve', hash: '0x3', status: 'mined' }, { nonce: 4, kind: 'repay', amount: '21710534', hash: '0x4', status: 'mined' }];
  assert.equal(read(lender({ lenders: [{ l: 'aave', ...stale }], evm: evm(borrowed) })).aaveDebt, usd(21.71));
  const after = read(lender({ lenders: [{ l: 'aave', ...stale }], evm: evm(repaid) }));
  assert.equal(after.aaveDebt, 0n);
  assert.equal(nextCloseStep(after).kind, 'take_back');
  // Once the collateral is back too, nothing is posted, so nothing can be owed there.
  const out = read(lender({ lenders: [{ l: 'aave', ...stale }], evm: evm(borrowed, []) }));
  assert.equal(out.aaveDebt, 0n);
  assert.deepEqual(out.aaveHeld, []);

  // Rhea: what it kept above the debt shows it has been paid; then the collateral, then the deposit, and then nothing.
  const nbtc = { token: NBTC, symbol: 'nBTC', decimals: 8, amount: '1310000' };
  const rhea = (held: typeof nbtc[], deposit: string) => read(lender({ lenders: [{ l: 'rhea', ...stale, debt: 192_530_000, held, deposit }], evm: null }));
  assert.equal(rhea([nbtc], '0').rheaDebt, usd(192.53));
  assert.equal(nextCloseStep({ ...rhea([nbtc], '0'), usdcNear: usd(300) }).kind, 'repay_rhea');
  assert.equal(rhea([nbtc], '4100').rheaDebt, 0n);
  assert.equal(nextCloseStep(rhea([nbtc], '4100')).kind, 'take_back');
  assert.equal(nextCloseStep(rhea([], '4100')).kind, 'rhea_deposit_back');
  assert.equal(rhea([], '0').rheaDebt, 0n);
});

test('closing: Aave is repaid from the address; short by the interest alone, testnet’s faucet adds it; else USDC is sent', () => {
  const owes: Partial<CloseState> = { aaveDebt: usd(21.71), usdcEvmToken: AAVE_USDC };
  assert.deepEqual(next({ ...owes, usdcEvm: usd(21.72) }), { kind: 'repay_aave', amount: lenderPayoff(usd(21.71)), token: AAVE_USDC });
  // $21.7096 at the address against $21.71 and its interest: 1 test USDC closes the gap, with no move and no check.
  assert.deepEqual(next({ ...owes, usdcEvm: 21_709_600n }), { kind: 'faucet_usdc', token: AAVE_USDC });
  // No faucet (mainnet, or the helper is off): the shortfall is sent from NEAR, at least $1.
  assert.deepEqual(next({ ...owes, usdcEvm: 21_709_600n, usdcNear: usd(5), canFaucet: false }), { kind: 'usdc_out', amount: 1_000_000n });
  // The loan went home: all of it must go back, with the move's cost on top.
  const back = next({ ...owes, usdcEvm: 0n, usdcEvmToken: null, usdcNear: usd(30) });
  assert.deepEqual(back, { kind: 'usdc_out', amount: moveAmount(lenderPayoff(usd(21.71))) });
  assert.equal(back.kind === 'usdc_out' && back.amount > usd(21.9) && back.amount < usd(22), true);
  // And when NEAR hasn't enough either.
  assert.equal(next({ ...owes, usdcEvm: 0n, usdcNear: usd(10), canFaucet: false }).kind, 'add_usdc');
});

test('closing: when Aave’s chain can’t be read, the page says so before anything at Aave, and still repays the pool first', () => {
  assert.deepEqual(next({ chainUnread: true, aaveDebt: usd(21.71) }), { kind: 'wait_chain' });
  assert.equal(next({ chainUnread: true, aaveDebt: usd(21.71), poolDebt: usd(100), usdcNear: usd(200) }).kind, 'repay_pool');
  // Nothing at Aave: the unread chain holds nothing back.
  assert.deepEqual(next({ chainUnread: true }), { kind: 'done' });
});

test('an ETH trade closes as a bitcoin trade does: Rhea gives the ether back, and WETH comes home as ETH; on a bitcoin trade it comes home as bitcoin, as before (INTERFACES.md 51)', () => {
  const METH = 'meth.pbf-ops.testnet';
  const weth = { token: WETH, symbol: 'WETH', decimals: 18, amount: 20_000_000_000_000_000n };
  const eth = { token: METH, symbol: 'ETH', decimals: 18, amount: 236_000_000_000_000_000n };
  // Rhea holds ether: it is taken back by its own token, like bitcoin.
  assert.deepEqual(next({ rheaHeld: [eth] }), { kind: 'take_back', lender: 'rhea', held: eth });
  assert.equal(closeWords({ kind: 'take_back', lender: 'rhea', held: eth }).title, 'Take 0.236 ETH back from Rhea');
  // The trade is in ETH (the account lists test ETH and is short ETH): WETH at the address comes home as ETH.
  const ethTrade = { etherId: METH, evmCollateral: [weth], positions: [{ coin: 'ETH', side: 'short' as const, size: 0.59 }] };
  assert.deepEqual(next(ethTrade), { kind: 'collateral_home', held: weth, to: METH });
  assert.equal(closeWords({ kind: 'collateral_home', held: weth, to: METH }).note, 'It arrives as ETH in a few minutes.');
  assert.equal(comesHomeAsEther(weth, { etherId: METH, nearTokens: [eth], positions: [] }), true, 'it holds ETH on NEAR');
  // A bitcoin trade on the same kind of account: the faucet's WETH stood in for bitcoin, and comes home as bitcoin.
  assert.deepEqual(next({ etherId: METH, evmCollateral: [weth], positions: [{ coin: 'BTC', side: 'short' as const, size: 0.015 }] }), { kind: 'collateral_home', held: weth });
  assert.equal(closeWords({ kind: 'collateral_home', held: weth }).note, 'It arrives as BTC in a few minutes.');
  // An account from before lists no test ETH: nothing changes for it.
  assert.equal(comesHomeAsEther(weth, { etherId: null, nearTokens: [], positions: [{ coin: 'ETH', side: 'short', size: 1 }] }), false);
  assert.equal(comesHomeAsEther({ symbol: 'WBTC' }, { etherId: METH, nearTokens: [eth], positions: [] }), false);
});

test('on an ETH trade the Aave step offers the client’s own ETH, up to the cap; on any other trade it is the faucet’s, as before', () => {
  assert.equal(offersOwnEther('ETH', true, true), true);
  assert.equal(offersOwnEther('BTC', true, true), false);
  assert.equal(offersOwnEther('ETH', false, true), false, 'an account that doesn’t list test ETH');
  assert.equal(offersOwnEther('ETH', true, false), false, 'testnet only');
  // "Move 0.02 ETH to Aave's chain": the cap, or all the account holds when that is less.
  assert.equal(ownEtherAmount(590_000_000_000_000_000n, 18), '0.02');
  assert.equal(ownEtherAmount(12_500_000_000_000_000n, 18), '0.0125');
  assert.equal(ownEtherAmount(0n, 18), '0');
});

test('closing: the collateral comes back from the lenders, then home from Aave’s chain; then leftover USDC there', () => {
  const weth = { token: WETH, symbol: 'WETH', decimals: 18, amount: 20_000_000_000_000_000n };
  const nbtc = { token: NBTC, symbol: 'nBTC', decimals: 8, amount: 1_310_000n };
  assert.deepEqual(next({ aaveHeld: [weth], rheaHeld: [nbtc], evmCollateral: [weth] }), { kind: 'take_back', lender: 'aave', held: weth });
  assert.deepEqual(next({ rheaHeld: [nbtc], evmCollateral: [weth] }), { kind: 'take_back', lender: 'rhea', held: nbtc });
  assert.deepEqual(next({ evmCollateral: [weth], usdcEvm: usd(5), usdcEvmToken: AAVE_USDC }), { kind: 'collateral_home', held: weth });
  // Nothing owed to the pool by now, so bringing USDC home needs no check. Under $2 it stays: the move would cost as much.
  assert.deepEqual(next({ usdcEvm: usd(5), usdcEvmToken: AAVE_USDC }), { kind: 'usdc_home', token: AAVE_USDC, amount: usd(5), needsCheck: false });
  assert.deepEqual(next({ usdcEvm: usd(1.07), usdcEvmToken: AAVE_USDC }), { kind: 'done' });
});

test('closing: then the short, the USDC home from Hyperliquid, and the withdrawal, in that order', () => {
  const tokens = [
    { token: USDC, symbol: 'USDC', decimals: 6, amount: usd(451) },
    { token: NBTC, symbol: 'nBTC', decimals: 8, amount: 1_556_013n },
  ];
  const end: Partial<CloseState> = { positions: [{ coin: 'BTC', side: 'short', size: 0.015 }], hlWithdrawable: usd(442.73), nearTokens: tokens };
  assert.deepEqual(next(end), { kind: 'close_position', coin: 'BTC', side: 'short', size: 0.015 });
  assert.deepEqual(next({ ...end, positions: [] }), { kind: 'hl_home', amount: usd(442.73) });
  // The 73 cents the user's own run left on Hyperliquid stay there.
  assert.deepEqual(next({ ...end, positions: [], hlWithdrawable: usd(0.73) }), { kind: 'withdraw', tokens });
  assert.deepEqual(next({ ...end, positions: [], hlWithdrawable: 0n, nearTokens: [] }), { kind: 'done' });
});

test('closing, start to end on the user’s own account of 13 Nov: no check is needed anywhere', () => {
  const weth = { token: WETH, symbol: 'WETH', decimals: 18, amount: 20_000_000_000_000_000n };
  let s: CloseState = {
    ...closed,
    poolDebt: usd(478.28),
    aaveDebt: usd(21.71),
    usdcNear: usd(488.28),
    usdcEvm: 21_709_600n,
    usdcEvmToken: AAVE_USDC,
    aaveHeld: [weth],
    nearTokens: [{ token: USDC, symbol: 'USDC', decimals: 6, amount: usd(488.28) }, { token: NBTC, symbol: 'nBTC', decimals: 8, amount: 1_500_000n }],
    positions: [{ coin: 'BTC', side: 'short', size: 0.015 }],
    hlWithdrawable: usd(430),
  };
  const kinds: string[] = [];
  // Each step's effect, as the chain would show it afterwards.
  const effect: Record<string, (s: CloseState) => CloseState> = {
    repay_pool: (x) => ({ ...x, poolDebt: 0n, usdcNear: usd(10) }),
    faucet_usdc: (x) => ({ ...x, usdcEvm: x.usdcEvm + 1_000_000n }),
    repay_aave: (x) => ({ ...x, aaveDebt: 0n, usdcEvm: usd(1) }),
    take_back: (x) => ({ ...x, aaveHeld: [], evmCollateral: [weth] }),
    collateral_home: (x) => ({ ...x, evmCollateral: [] }),
    close_position: (x) => ({ ...x, positions: [] }),
    hl_home: (x) => ({ ...x, hlWithdrawable: 0n }),
    withdraw: (x) => ({ ...x, nearTokens: [] }),
  };
  for (let i = 0; i < 12; i++) {
    const step = nextCloseStep(s);
    kinds.push(step.kind);
    if (step.kind === 'done') break;
    assert.notEqual(step.kind, 'check_move');
    assert.equal(step.kind === 'usdc_home' && step.needsCheck, false);
    s = effect[step.kind]!(s);
  }
  assert.deepEqual(kinds, ['repay_pool', 'faucet_usdc', 'repay_aave', 'take_back', 'collateral_home', 'close_position', 'hl_home', 'withdraw', 'done']);
});

// ---------- the close state, from the backend's reads ----------

test('the close state is read from the account, its lenders, its address and Hyperliquid', () => {
  const s = closeStateFrom({
    account: account({ nbtc: '1500000', usdc: '488280000', debt: '478280000', pending: [{ transfer: { id: 'move:2', kind: 'to_evm', token: USDC, amount: '21800000', dep: 'dep2', deadline: `${NOW + 60_000}000000` } }] }),
    hl: hl({ address: true, funded: true, agent: true, approved: true, short: 'BTC', withdrawable: '212.349' }),
    lender: lender({
      lenders: [{ l: 'aave', posted: 39_260_000, debt: 21_710_000, hf_bp: 15_400, liq_bp: 8_300, rate_bp: 74, supply_bp: 10, room: 0, status: 'safe', held: [{ token: WETH, symbol: 'WETH', decimals: 18, amount: '20000000000000000' }] }],
      evm: {
        address: '0x8c01',
        nonce: 3,
        chain_nonce: 2,
        eth: '1',
        wallet: [{ token: AAVE_USDC, symbol: 'USDC', decimals: 6, amount: '21719550' }, { token: WETH, symbol: 'WETH', decimals: 18, amount: '0' }],
        signed: [{ nonce: 1, kind: 'supply', hash: '0x1', status: 'mined' }, { nonce: 2, kind: 'borrow', hash: '0x2', status: 'signed' }],
      },
    }),
    stages: { 'move:2': 'arrived' },
    nowMs: NOW,
    testnet: true,
    helperOn: true,
  });
  assert.equal(s.poolDebt, usd(478.28));
  assert.equal(s.aaveDebt, usd(21.71));
  assert.equal(s.usdcNear, usd(488.28));
  assert.equal(s.usdcEvm, 21_719_550n);
  assert.equal(s.usdcEvmToken, AAVE_USDC);
  assert.deepEqual(s.aaveHeld, [{ token: WETH, symbol: 'WETH', decimals: 18, amount: 20_000_000_000_000_000n }]);
  assert.deepEqual(s.evmCollateral, []);
  assert.deepEqual(s.moves, [{ id: 'move:2', kind: 'to_evm', stage: 'arrived', overdue: false }]);
  assert.equal(s.evmUnsent, 2);
  assert.deepEqual(s.positions, [{ coin: 'BTC', side: 'short', size: 0.015 }]);
  assert.equal(s.hlWithdrawable, usd(212.34));
  assert.equal(s.canFaucet, true);
  assert.deepEqual(s.nearTokens.map((t) => t.symbol), ['USDC', 'nBTC']);
});

test('an unread chain marks nothing as unsent, and a mainnet account has no faucet and no mint', () => {
  const s = closeStateFrom({
    account: account({ usdc: '1000000' }),
    hl: undefined,
    lender: lender({ evm: { address: '0x8c01', nonce: 3, chain_nonce: null, eth: null, wallet: [], signed: [{ nonce: 2, kind: 'borrow', hash: '0x2', status: 'signed' }], chain_error: 'timeout' } }),
    nowMs: NOW,
    testnet: false,
  });
  assert.equal(s.chainUnread, true);
  assert.equal(s.evmUnsent, null);
  assert.equal(s.canMint, false);
  assert.equal(s.canFaucet, false);
  assert.equal(s.usdcEvmToken, null);
  assert.deepEqual(s.positions, []);
});

test('USDC a unified Hyperliquid account keeps in spot can come home when perps has nothing to give', () => {
  const unified: HlAnswer = { ...hl({ address: true, funded: true }), hyperliquid: { ...view(true, [], null, '0'), spot_usdc: { total: '441.5', hold: '1.5' }, abstraction: 'unifiedAccount' } };
  assert.equal(closeStateFrom({ account: account(), hl: unified, lender: null, nowMs: NOW, testnet: true }).hlWithdrawable, usd(440));
  const perps: HlAnswer = { ...unified, hyperliquid: { ...view(true, [], null, '430.25'), spot_usdc: { total: '5', hold: '0' } } };
  assert.equal(closeStateFrom({ account: account(), hl: perps, lender: null, nowMs: NOW, testnet: true }).hlWithdrawable, usd(430.25));
});

test('a Hyperliquid side that couldn’t be read is never taken for one with nothing on it', () => {
  assert.equal(hlWasRead(undefined), false);
  // No address there yet: nothing to read, so nothing is missing.
  assert.equal(hlWasRead(hl({})), true);
  assert.equal(hlWasRead(HEDGED), true);
  // An address, and Hyperliquid didn't answer: the page can't say whether a short is open.
  assert.equal(hlWasRead({ ...HEDGED, hyperliquid: null }), false);
  assert.equal(hlWasRead({ ...HEDGED, hyperliquid: { ...view(true, [], null), clearinghouse_state: null, errors: { clearinghouseState: 'timeout' } } }), false);
});

test('Hyperliquid’s dollars are read down to whole cents', () => {
  assert.equal(dollarsToMicro('442.739'), usd(442.73));
  assert.equal(dollarsToMicro('0.29'), usd(0.29));
  assert.equal(dollarsToMicro(undefined), 0n);
  assert.equal(dollarsToMicro('-3'), 0n);
});

// ---------- the words ----------

const EVERY_STEP: CloseStep[] = [
  { kind: 'stop_loan' },
  { kind: 'wait_lender' },
  { kind: 'send_signed', nonce: 4 },
  { kind: 'wait_mined' },
  { kind: 'drop_move', id: 'move:3' },
  { kind: 'check_move', id: 'move:2' },
  { kind: 'wait_move', id: 'move:2', moveKind: 'to_evm' },
  { kind: 'wait_move', id: 'move:5', moveKind: 'home' },
  { kind: 'repay_pool', amount: usd(479.75), owed: usd(478.28) },
  { kind: 'repay_pool', amount: usd(1), owed: 0n },
  { kind: 'usdc_home', token: AAVE_USDC, amount: usd(21.72), needsCheck: true },
  { kind: 'usdc_home', token: AAVE_USDC, amount: usd(5), needsCheck: false },
  { kind: 'add_usdc', amount: usd(9.3), canMint: true },
  { kind: 'add_usdc', amount: usd(9.3), canMint: false },
  { kind: 'repay_rhea', amount: usd(192.53) },
  { kind: 'rhea_deposit_back', amount: 4_100n },
  { kind: 'wait_chain' },
  { kind: 'faucet_usdc', token: AAVE_USDC },
  { kind: 'repay_aave', amount: usd(21.71), token: AAVE_USDC },
  { kind: 'usdc_out', amount: usd(21.8) },
  { kind: 'take_back', lender: 'aave', held: { token: WETH, symbol: 'WETH', decimals: 18, amount: 20_000_000_000_000_000n } },
  { kind: 'collateral_home', held: { token: WETH, symbol: 'WETH', decimals: 18, amount: 20_000_000_000_000_000n } },
  { kind: 'close_position', coin: 'BTC', side: 'short', size: 0.015 },
  { kind: 'hl_home', amount: usd(442.73) },
  { kind: 'withdraw', tokens: [{ token: USDC, symbol: 'USDC', decimals: 6, amount: usd(451) }, { token: NBTC, symbol: 'nBTC', decimals: 8, amount: 1_550_000n }] },
  { kind: 'done' },
];

test('every step of the way out has a plain line, and says what the wallet will ask before it asks', () => {
  assert.equal(closeWords({ kind: 'usdc_out', amount: usd(21.8) }).approval, 'Your wallet will ask you to approve: send $21.80 of USDC to your address on Aave’s chain, to repay Aave with.');
  assert.equal(closeWords(EVERY_STEP[20]!).title, 'Take 0.02 WETH back from Aave');
  assert.equal(closeWords(EVERY_STEP[22]!).approval, 'Your wallet will ask you to sign: buy 0.015 BTC on Hyperliquid, to close the short. It is a message, with no fee.');
  assert.equal(closeWords(EVERY_STEP[24]!).approval, 'Your wallet will ask you to approve: withdraw $451.00 of USDC and 0.0155 BTC to your wallet.');
  // What is sent to the pool is a little over what is owed, and the line says the figure the client knows: what they owe.
  assert.equal(closeWords(EVERY_STEP[8]!).title, 'Repay the $478.28 you owe our pool');
  assert.match(closeWords(EVERY_STEP[8]!).approval!, /\$479\.75 is sent, a little over the \$478\.28 you owe.*sends back the rest/);
  // The check comes before the repayment, and the page says so.
  assert.match(closeWords({ kind: 'check_move', id: 'move:2' }).note!, /The repayment comes after it, not before/);
  for (const step of EVERY_STEP) {
    const words = closeWords(step);
    assert.ok(words.title.length > 0, step.kind);
    // A step that waits, or that the backend's own wallet does, opens no wallet, and says so in a note instead.
    if (words.approval === null && step.kind !== 'done') assert.ok(words.note, step.kind);
  }
});

test('no word of the engine’s own reaches the main surface: verdict, counter, nonce, quote', () => {
  const said: string[] = [...CLOSE_STAGES];
  for (const step of EVERY_STEP) {
    const words = closeWords(step);
    said.push(words.title, words.approval ?? '', words.note ?? '');
  }
  const keys: OpenKey[] = ['account', 'collateral', 'address', 'margin', 'agent', 'approve', 'short', 'aave', 'loan'];
  for (const key of keys) said.push(openTitle(key, 'BTC'), openApproval(key, 'BTC', { permission: true }) ?? '');
  const raws = [
    'Cancelled in the wallet',
    'OutLayer returned no verdict',
    'The verdict’s nonce doesn’t match the counter',
    'This quote expires more than 24 hours from now.',
    'Rate limits exceeded',
    'The backend is not running: start it with pnpm --filter @pb/api start',
    'Smart contract panicked: amount is above the verdict’s borrow allowance',
    '',
  ];
  for (const raw of raws) {
    const f = failureWords(raw);
    said.push(f.happened, f.todo);
  }
  said.push(...closeSummary({ ...closed, poolDebt: usd(478.28), aaveDebt: usd(21.71), positions: [{ coin: 'BTC', side: 'short', size: 0.015 }], hlWithdrawable: usd(430) }));
  for (const line of said) assert.equal(JARGON.test(line), false, line);
});

test('a failure says what happened in one sentence, and what to do', () => {
  assert.deepEqual(failureWords('OutLayer returned no verdict'), { happened: 'OutLayer didn’t answer in time.', todo: 'Nothing was sent. Try again.' });
  assert.deepEqual(failureWords('The risk engine gave no answer this time, so nothing was sent.'), { happened: 'OutLayer didn’t answer in time.', todo: 'Nothing was sent. Try again.' });
  assert.deepEqual(failureWords('User rejected the request'), { happened: 'The wallet closed before you approved.', todo: 'Nothing was sent. Try again.' });
  // INTERFACES.md 50.4: an order whose signature ran out says so once, with "Sign again"; one whose answer never came says it may be placed.
  assert.deepEqual(failureWords('The order waited too long at the risk engine, and its signature ran out. Nothing was placed. Sign again to send it.'), {
    happened: 'The order waited too long at the risk engine, and its signature ran out.',
    todo: 'Nothing was placed. Sign again.',
    button: 'Sign again',
  });
  assert.deepEqual(failureWords('The order’s answer didn’t come back. It may still have reached Hyperliquid: look at your open orders and fills before you sign it again.'), {
    happened: 'The order’s answer didn’t come back.',
    todo: 'It may still have been placed. Try again: the page goes on from where your account really is.',
  });
  assert.equal(failureWords('OutLayer did not answer. The order may still have reached Hyperliquid: look at the open orders and fills before sending it again.').happened, 'The order’s answer didn’t come back.');
  assert.deepEqual(failureWords('Rate limits exceeded'), { happened: 'NEAR’s network is busy right now.', todo: 'Nothing was sent. Wait a minute, then try again.' });
  assert.equal(failureWords('The page could not reach its server.').happened, 'The page couldn’t reach its server.');
  assert.equal(failureWords('1Click hasn’t finished after three minutes.').happened, 'This step is taking longer than usual.');
  assert.equal(failureWords('1Click didn’t deliver: Refunded to the account.').happened, 'The move didn’t go through.');
  assert.equal(failureWords('No signed approval appeared. The signer may have timed out; try again.').happened, 'The signature didn’t come back in time.');
  // Anything else: still one sentence and a way on, never the raw words.
  assert.equal(failureWords('It doesn’t allow sending this much out: what stays must still cover your loans.').happened, 'The risk engine didn’t allow this step.');
  assert.deepEqual(failureWords('Smart contract panicked: something odd'), { happened: 'This step didn’t finish.', todo: 'Try again: the page goes on from where your account really is.' });
});

test('the rail’s five parts: each step belongs to one, a wait to none, and done is past the last', () => {
  assert.equal(CLOSE_STAGES.length, 5);
  assert.equal(closeStage({ kind: 'repay_pool', amount: 1n, owed: 1n }), 0);
  assert.equal(closeStage({ kind: 'check_move', id: 'move:2' }), 0);
  assert.equal(closeStage({ kind: 'usdc_home', token: AAVE_USDC, amount: 1n, needsCheck: true }), 0);
  assert.equal(closeStage({ kind: 'usdc_home', token: AAVE_USDC, amount: 1n, needsCheck: false }), 1);
  assert.equal(closeStage({ kind: 'take_back', lender: 'rhea', held: { token: NBTC, symbol: 'nBTC', decimals: 8, amount: 1n } }), 1);
  assert.equal(closeStage({ kind: 'close_position', coin: 'BTC', side: 'short', size: 1 }), 2);
  assert.equal(closeStage({ kind: 'hl_home', amount: 1n }), 3);
  assert.equal(closeStage({ kind: 'withdraw', tokens: [] }), 4);
  assert.equal(closeStage({ kind: 'done' }), 5);
  assert.equal(closeStage({ kind: 'wait_move', id: 'move:2', moveKind: 'to_evm' }), null);
});

test('what there is to close, in short lines; nothing open gives none', () => {
  assert.deepEqual(closeSummary(closed), []);
  const lines = closeSummary({
    ...closed,
    poolDebt: usd(478.28),
    aaveDebt: usd(21.71),
    aaveHeld: [{ token: WETH, symbol: 'WETH', decimals: 18, amount: 20_000_000_000_000_000n }],
    positions: [{ coin: 'BTC', side: 'short', size: 0.015 }],
    hlWithdrawable: usd(430),
    nearTokens: [{ token: USDC, symbol: 'USDC', decimals: 6, amount: usd(488.28) }, { token: NBTC, symbol: 'nBTC', decimals: 8, amount: 1_500_000n }],
  });
  assert.deepEqual(lines, [
    'You owe $478.28 to our pool, $21.71 to Aave.',
    'Collateral: 0.02 WETH with Aave.',
    'A short of 0.015 BTC is open on Hyperliquid.',
    '$430.00 of USDC is on Hyperliquid.',
    'Your account holds $488.28 of USDC and 0.015 BTC.',
  ]);
});
