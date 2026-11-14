// The verdict in words, and when a stored verdict can back an action (INTERFACES.md 4; RISK_ENGINE.md Appendix A).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { APPENDIX_A, DEMO_BORROW, STATE } from './test-fixtures.ts';
import type { StoredVerdict } from './types.ts';
import { beforePermissionChange, bindingWords, freshness, fundLends, intentWords, lesserAmount, summarizeVerdict, verdictUse, VERDICT_LIFETIME_BLOCKS } from './verdict.ts';

const TOKENS = [
  { id: 'musdc.pbf-ops.testnet', symbol: 'USDC', label: 'mUSDC', decimals: 6 },
  { id: 'mnbtc.pbf-ops.testnet', symbol: 'nBTC', label: 'mNBTC', decimals: 8 },
];

test('Appendix A in words: state, line, what sets it, the top risks and the top-up', () => {
  const summary = summarizeVerdict(APPENDIX_A);
  assert.equal(summary.ok, true);
  assert.equal(summary.state?.label, 'Healthy');
  assert.equal(summary.state?.tone, 'success');
  assert.equal(summary.action, null, 'NONE needs no line of its own');
  assert.equal(summary.headline, 'Healthy. It may borrow $0.00 more now, against a credit line of $94,500.00.');
  const fact = (label: string) => summary.facts.find((f) => f.label === label)?.value;
  assert.equal(fact('What sets the line'), "the Standard tier's cap: 70% of the collateral");
  assert.equal(fact('Equity (for credit)'), '$40,500.00 ($40,500.00)');
  assert.equal(fact('Initial requirement / safety buffer'), '$19,520.00 / $15,616.00');
  assert.equal(fact('Score and tier'), '700, Standard');
  assert.equal(fact('Rate'), '6.50% a year');
  assert.deepEqual(summary.risks, ['replay 13 Mar 2020 rebound', 'ADL BTC 2/3S then 2/3S', 'nBTC depeg 20%']);
  assert.deepEqual(summary.warnings, ['A Hyperliquid top-up of $11,251.00 would remove a liquidation from the top risks.']);
});

test('the other states and actions, and pb-risk refusing to make a verdict', () => {
  const deleverage = summarizeVerdict({ ...APPENDIX_A, state: 'DELEVERAGE', action: 'DELEVERAGE', coins: { uncertain: ['DOGE'], stale: [], reduce_only: ['nBTC'] } });
  assert.equal(deleverage.state?.tone, 'danger');
  assert.match(deleverage.action!, /^Deleverage: unwind part of the book/);
  assert.ok(deleverage.warnings.includes('Prices uncertain for DOGE: no new risk in them.'));
  assert.ok(deleverage.warnings.includes('Reduce-only: nBTC.'));
  assert.equal(summarizeVerdict({ ...APPENDIX_A, state: 'MARGIN_CALL' }).state?.label, 'Margin call');

  const refusal = summarizeVerdict({ ok: false, reason: 'account alice.pbf.testnet has no get_state' });
  assert.equal(refusal.ok, false);
  assert.equal(refusal.headline, 'The risk engine made no decision: account alice.pbf.testnet has no get_state');
  assert.deepEqual(refusal.facts, []);
});

test('every binding code has words; a scenario after the code is kept', () => {
  for (let i = 0; i <= 9; i++) assert.doesNotMatch(bindingWords(`C${i}`), /^C\d$/);
  assert.equal(bindingWords('C4', 'PREFERRED'), "the Preferred tier's cap: 85% of the collateral");
  assert.equal(bindingWords('C1:replay 13 Mar 2020'), 'staying above the initial requirement after the loan, in the worst stress scenario (replay 13 Mar 2020)');
  assert.equal(bindingWords('POOL'), 'POOL', 'an unknown code is shown as it is');
});

test('a verdict lasts 120 blocks from the block pb-risk read', () => {
  assert.equal(VERDICT_LIFETIME_BLOCKS, 120);
  assert.deepEqual(freshness(1000, 1000), { age: 0, blocksLeft: 120, secondsLeft: 73, fresh: true });
  assert.equal(freshness(1000, 1120).fresh, true);
  assert.deepEqual(freshness(1000, 1121), { age: 121, blocksLeft: 0, secondsLeft: 0, fresh: false });
});

test('a borrow needs a fresh, unused verdict answering a borrow, allowing the amount', () => {
  const stored = STATE.verdict!;
  const borrow = (amount: string) => ({ borrow: { amount } });

  assert.deepEqual(verdictUse(stored, 3, 1050, borrow('24150000000')), { ok: true, why: 'Fresh for 70 more blocks (about 43 s).' });
  assert.equal(verdictUse(stored, 3, 1050, borrow('24150000001')).why, 'It allows borrowing up to 24,150 USDC, less than 24,150.000001.');
  assert.match(verdictUse(stored, 4, 1050, borrow('1')).why, /^Already used/);
  assert.match(verdictUse(stored, 3, 1121, borrow('1')).why, /^Too old: 121 blocks/);
  assert.match(verdictUse({ ...stored, intent: { check: {} } }, 3, 1050, borrow('1')).why, /answers a plain check, not a borrow/);
  assert.match(verdictUse(null, 3, 1050, borrow('1')).why, /^No check yet/);
});

test('a withdrawal with a loan needs a verdict for the same token and amount', () => {
  const stored = { intent: { withdraw: { token: 'musdc.pbf-ops.testnet', amount: '5' } }, received_block: 1003, verdict: DEMO_BORROW };
  assert.equal(verdictUse(stored, 3, 1010, { withdraw: { token: 'musdc.pbf-ops.testnet', amount: '5' } }).ok, true);
  assert.equal(verdictUse(stored, 3, 1010, { withdraw: { token: 'musdc.pbf-ops.testnet', amount: '6' } }).ok, false);
  assert.equal(verdictUse(stored, 3, 1010, { withdraw: { token: 'mnbtc.pbf-ops.testnet', amount: '5' } }).ok, false);
  assert.match(verdictUse(STATE.verdict, 3, 1010, { withdraw: { token: 'musdc.pbf-ops.testnet', amount: '5' } }).why, /not a withdrawal/);
});

test('intents in words', () => {
  assert.equal(intentWords({ check: {} }, TOKENS), 'a check');
  assert.equal(intentWords({ borrow: { amount: '24150000000' } }, TOKENS), 'borrowing 24,150 USDC');
  assert.equal(intentWords({ withdraw: { token: 'mnbtc.pbf-ops.testnet', amount: '25000000' } }, TOKENS), 'withdrawing 0.25 nBTC');
  assert.equal(intentWords({ fund: { amount: '94500000000' } }, TOKENS), 'a loan of 94,500 USDC, from the sources the engine picks');
  assert.equal(intentWords({ lender_withdraw: { lender: 'rhea', token: 'mnbtc.pbf-ops.testnet', amount: '500000' } }, TOKENS), 'taking 0.005 nBTC back from Rhea');
});

/** A `fund` verdict for $94,500 (INTERFACES.md 25): Rhea lends $50,667 and our pool $43,833. */
const fundVerdict = (over: Partial<StoredVerdict['verdict']> = {}): StoredVerdict => ({
  intent: { fund: { amount: '94500000000' } },
  received_block: 1003,
  verdict: {
    ...DEMO_BORROW,
    allow: { withdraw: 0, borrow: 43_833_000_000, fund: 94_500_000_000 },
    fund: [
      { k: 'l_supply', l: 'rhea', tok: 'mnbtc.pbf-ops.testnet', amt: '131000000' },
      { k: 'l_borrow', l: 'rhea', amt: 50_667_000_000 },
      { k: 'p_borrow', amt: 43_833_000_000 },
    ],
    ...over,
  },
});

test('fund needs a fresh, unused, HEALTHY verdict that answers a loan of the same amount and has steps', () => {
  const fund = (amount: string, partial?: boolean) => ({ fund: { amount, partial } });
  assert.equal(verdictUse(fundVerdict(), 3, 1050, fund('94500000000')).ok, true);
  assert.equal(verdictUse(fundVerdict(), 3, 1050, fund('90000000000')).why, 'It answers a loan of another amount.');
  assert.match(verdictUse(STATE.verdict, 3, 1050, fund('24150000000')).why, /^It answers a borrow, not a loan/);
  assert.equal(verdictUse(fundVerdict({ state: 'WATCH' }), 3, 1050, fund('94500000000')).why, 'Only a safe account can borrow more.');
  assert.equal(verdictUse(fundVerdict({ fund: [] }), 3, 1050, fund('94500000000')).why, 'The engine found nothing to lend now.');
  assert.equal(verdictUse(fundVerdict({ allow: { withdraw: 0, borrow: 0, fund: 0 } }), 3, 1050, fund('94500000000')).why, 'The engine found nothing to lend now.');
  assert.match(verdictUse(fundVerdict(), 4, 1050, fund('94500000000')).why, /^Already used/);
  assert.match(verdictUse(fundVerdict(), 3, 1121, fund('94500000000')).why, /^Too old/);
});

test('a check read at or before the block the permission last changed in can’t back a loan: the app asks for a new one', () => {
  // INTERFACES.md 40.1 (the audit's A8): set_permission no longer moves the counter. The account records its block
  // (`permission_blk`), and `fund` refuses a held verdict whose `blk` isn't above it. The sample verdict read block 1000.
  const fund = { fund: { amount: '94500000000' } };
  const words = 'It was run before your lender permission last changed: a check from before the change can’t back a loan.';
  assert.deepEqual(verdictUse(fundVerdict(), 3, 1050, fund, 1000), { ok: false, why: words });
  assert.deepEqual(verdictUse(fundVerdict(), 3, 1050, fund, 1040), { ok: false, why: words });
  // A check read after the change backs it, the counter being the same all along.
  assert.equal(verdictUse(fundVerdict(), 3, 1050, fund, 999).ok, true);
  // An account from before the fix has no `permission_blk`, and one whose permission was never set has 0: no such rule.
  assert.equal(verdictUse(fundVerdict(), 3, 1050, fund).ok, true);
  assert.equal(verdictUse(fundVerdict(), 3, 1050, fund, 0).ok, true);
  // The rule is `fund`'s alone: a borrow from our pool, or a withdrawal, is backed as before.
  assert.equal(verdictUse(STATE.verdict, 3, 1050, { borrow: { amount: '24150000000' } }, 1040).ok, true);
  // A used check is still said to be used first: that is why it can back nothing at all.
  assert.match(verdictUse(fundVerdict(), 4, 1050, fund, 1040).why, /^Already used/);
});

test('“before the permission changed” means read at that block or earlier, and never applies to an account without the field', () => {
  assert.equal(beforePermissionChange(1000, 1000), true);
  assert.equal(beforePermissionChange(1000, 1001), true);
  assert.equal(beforePermissionChange(1001, 1000), false);
  // 0: no permission was ever set. Missing: the account was made before the audit fix.
  assert.equal(beforePermissionChange(1000, 0), false);
  assert.equal(beforePermissionChange(1000, undefined), false);
  assert.equal(beforePermissionChange(1000, null), false);
});

test('a check that lends less than was asked stops, and goes on once the client accepts the smaller loan', () => {
  const less = fundVerdict({ allow: { withdraw: 0, borrow: 20_000_000_000, fund: 70_667_000_000 } });
  const use = (partial?: boolean) => ({ fund: { amount: '94500000000', partial } });
  assert.deepEqual(verdictUse(less, 3, 1050, use()), { ok: false, why: 'It would lend $70,667.00 of the $94,500.00 you asked for.' });
  assert.equal(verdictUse(less, 3, 1050, use(true)).ok, true);
  assert.equal(fundLends(less), 70_667_000_000n);
  assert.equal(lesserAmount(less), 70_667_000_000n);
  // A check that lends it all has no smaller amount to offer, and one that isn't HEALTHY offers nothing.
  assert.equal(lesserAmount(fundVerdict()), 0n);
  assert.equal(lesserAmount(fundVerdict({ state: 'WATCH', allow: { withdraw: 0, borrow: 0, fund: 70_667_000_000 } })), 0n);
  assert.equal(fundLends(STATE.verdict), 0n);
});

test('after a refused borrow, the smaller amount is a little under the verdict’s allowance', () => {
  // 0.01% plus 2 micro-USDC below $24,150 (lib/borrow.ts).
  assert.equal(lesserAmount(STATE.verdict!), 24_147_584_998n);
  assert.equal(lesserAmount({ intent: { check: {} }, received_block: 1, verdict: DEMO_BORROW }), 0n);
});

test('taking collateral back from a lender needs a verdict for the same lender, token and amount that allows it', () => {
  const intent = { lender_withdraw: { lender: 'rhea', token: 'mnbtc.pbf-ops.testnet', amount: '500000' } };
  const stored = (withdraw: number): StoredVerdict => ({ intent, received_block: 1003, verdict: { ...DEMO_BORROW, allow: { withdraw, borrow: 0 } } });
  assert.equal(verdictUse(stored(500_000), 3, 1010, intent).ok, true);
  assert.match(verdictUse(stored(0), 3, 1010, intent).why, /^It doesn’t allow taking this much back/);
  assert.equal(verdictUse(stored(500_000), 3, 1010, { lender_withdraw: { ...intent.lender_withdraw, amount: '600000' } }).why, 'It answers another lender, token or amount.');
  assert.equal(verdictUse(stored(500_000), 3, 1010, { lender_withdraw: { ...intent.lender_withdraw, lender: 'aave' } }).ok, false);
  assert.match(verdictUse(STATE.verdict, 3, 1010, intent).why, /not taking collateral back from a lender/);
});

test('sending a token out of the address on Aave’s chain needs a verdict for the same token and amount that allows it', () => {
  const WETH = '0x4200000000000000000000000000000000000006';
  const intent = { evm_withdraw: { token: WETH, amount: '5000000000000000' } };
  const stored = (withdraw: number): StoredVerdict => ({ intent, received_block: 1003, verdict: { ...DEMO_BORROW, allow: { withdraw, borrow: 0 } } });
  assert.equal(verdictUse(stored(5_000_000_000_000_000), 3, 1010, intent).ok, true);
  assert.match(verdictUse(stored(0), 3, 1010, intent).why, /^It doesn’t allow sending this much out/);
  assert.equal(verdictUse(stored(5_000_000_000_000_000), 3, 1010, { evm_withdraw: { token: WETH, amount: '6000000000000000' } }).why, 'It answers another token or amount.');
  assert.match(verdictUse(STATE.verdict, 3, 1010, intent).why, /not sending a token out of the address/);
  assert.equal(
    intentWords(intent, [...TOKENS, { id: WETH, symbol: 'WETH', label: 'WETH', decimals: 18 }]),
    'sending 0.005 WETH out of the account’s address on Aave’s chain',
  );
});
