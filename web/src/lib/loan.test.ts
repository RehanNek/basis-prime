// One loan from several sources: the total, what each part costs the client, and which a repayment pays first
// (FUNDING.md 8; INTERFACES.md 29).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LenderPosition, Pricing } from './api.ts';
import { creditOwed, creditWords, depositsAt, depositWords, inSentence, lenderExtra, lenderPayoff, loanView, onNear, paysOff, poolExtra, repayMost, repayOrder, repaySplit, shortOfPayoff, splitWords, usdOrDust } from './loan.ts';

/** FUNDING.md 2's Rhea case at a hundredth of its size: $506.67 from Rhea at 15.91%, $438.33 from our pool at 6.50%. */
const RHEA: LenderPosition = { l: 'rhea', posted: 1_000_000_000, debt: 506_670_000, hf_bp: 15_000, liq_bp: 7_600, rate_bp: 1_591, supply_bp: 1_032, room: 0, status: 'safe' };
const POOL_DEBT = 438_330_000n;
const loan = (pricing?: Pricing | null, lenders: LenderPosition[] = [RHEA], poolDebt = POOL_DEBT) => loanView({ poolDebt, poolRateBp: 650, lenders, pricing });

test('the loan total is our pool’s part plus each lender’s', () => {
  const view = loan();
  assert.equal(view.total, 945_000_000n);
  assert.deepEqual(view.parts.map((p) => [p.source, p.name, p.debt, p.ownBp, p.payBp]), [
    ['rhea', 'Rhea', 506_670_000n, 1_591, 1_591],
    ['pool', 'Our pool', 438_330_000n, 650, 650],
  ]);
  // ($506.67 at 15.91% and $438.33 at 6.50%) over $945.
  assert.equal(view.rateBp, 1_155);
  assert.equal(view.words, 'At 11.55% a year on the whole loan: $506.67 from Rhea, $438.33 from our pool');
});

test('a loan from our pool alone reads as it did before lenders', () => {
  const view = loan(null, []);
  assert.equal(view.total, POOL_DEBT);
  assert.equal(view.words, 'At 6.50% a year, from the broker’s pool');
  assert.equal(loanView({ poolDebt: POOL_DEBT, poolRateBp: null, lenders: [] }).words, 'From the broker’s pool');
  assert.equal(loan(null, [], 0n).words, 'Nothing borrowed');
  // A lender with nothing owed is no part of the loan.
  assert.deepEqual(loan(null, [{ ...RHEA, debt: 0 }]).parts.map((p) => p.source), ['pool']);
});

test('under a pricing policy each part shows what the client pays, not what the source charges', () => {
  // A cap of 8% on Rhea's 15.91%: the floor makes it Rhea's deposit rate, 10.32%.
  const capped = loan({ lender: { margin_bp: 0, cap_bp: 800 } });
  assert.deepEqual(capped.parts.map((p) => p.payBp), [1_032, 650]);
  assert.equal(capped.rateBp, 855);
  // One rate on the whole loan moves our pool's part too.
  assert.deepEqual(loan({ fixed: { rate_bp: 1_700 } }).parts.map((p) => p.payBp), [1_700, 1_700]);
});

test('a lender whose rate wasn’t read leaves the whole loan’s rate unsaid', () => {
  const view = loan(null, [{ ...RHEA, rate_bp: null }]);
  assert.equal(view.rateBp, null);
  assert.equal(view.words, '$506.67 from Rhea, $438.33 from our pool');
});

test('a repayment pays the dearest source first, and says why', () => {
  const { order, why } = repayOrder(loan().parts);
  assert.deepEqual(order.map((p) => p.source), ['rhea', 'pool']);
  assert.equal(why, 'This pays Rhea first: it costs you the most, 15.91% a year against 6.50% for our pool.');
  // A lender cheaper than our pool: the pool comes first.
  const cheap = repayOrder(loan(null, [{ ...RHEA, l: 'aave', rate_bp: 533 }]).parts);
  assert.deepEqual(cheap.order.map((p) => p.source), ['pool', 'aave']);
  assert.equal(cheap.why, 'This pays our pool first: it costs you the most, 6.50% a year against 5.33% for Aave.');
});

test('“dearest” is what the client pays: a capped lender can cost less than our pool', () => {
  const capped = repayOrder(loan({ lender: { margin_bp: 0, cap_bp: 500 } }, [{ ...RHEA, supply_bp: 0 }]).parts);
  assert.deepEqual(capped.order.map((p) => [p.source, p.payBp]), [['pool', 650], ['rhea', 500]]);
});

test('sources that cost the client the same: the lender first, since that widens the cushion', () => {
  const fixed = repayOrder(loan({ fixed: { rate_bp: 1_700 } }).parts);
  assert.deepEqual(fixed.order.map((p) => p.source), ['rhea', 'pool']);
  assert.equal(fixed.why, 'This pays Rhea first. Your sources cost you the same, 17.00% a year, and a smaller loan with Rhea widens your cushion there.');
});

test('one source, the client’s own pick, and nothing owed', () => {
  assert.equal(repayOrder(loan(null, []).parts).why, 'This pays our pool: it is the only source you owe.');
  const picked = repayOrder(loan().parts, 'pool');
  assert.deepEqual(picked.order.map((p) => p.source), ['pool']);
  assert.equal(picked.why, 'This pays our pool alone, as you chose.');
  // A pick that isn't owed anything falls back to the dearest first.
  assert.deepEqual(repayOrder(loan().parts, 'aave').order.map((p) => p.source), ['rhea', 'pool']);
  assert.deepEqual(repayOrder([]), { order: [], why: '' });
  assert.match(repayOrder(loan(null, [{ ...RHEA, rate_bp: null }]).parts).why, /^This pays our pool first\. Not every source’s rate was read/);
});

test('paying a lender off sends the debt, 0.002% and 100 micro-USD, as the keeper’s gate does', () => {
  // services/keeper/src/funding-kit.ts, rheaRepayAmount: debt + debt / 50,000 + 100.
  assert.equal(lenderExtra(506_670_000n), 10_233n);
  assert.equal(lenderPayoff(506_670_000n), 506_680_233n);
  assert.equal(lenderPayoff(192_533_333n), 192_537_283n);
  assert.equal(lenderExtra(0n), 0n);
});

test('a repayment is cut into one payment per source, the dearest first', () => {
  const { order } = repayOrder(loan().parts);
  assert.deepEqual(repaySplit(100_000_000n, order), [{ source: 'rhea', amount: 100_000_000n }]);
  // Passing over Rhea on the way to our pool pays Rhea off, with its little extra.
  assert.deepEqual(repaySplit(600_000_000n, order), [{ source: 'rhea', amount: 506_680_233n }, { source: 'pool', amount: 93_319_767n }]);
  assert.equal(splitWords(repaySplit(600_000_000n, order)), '$506.68 to Rhea, then $93.31 to our pool');
  assert.deepEqual(repaySplit(0n, order), []);
});

test('a lender is sent at most its pay-off amount; what is above goes to our pool, which sends back the rest', () => {
  const { order } = repayOrder(loan().parts);
  // $950 against $945 owed: Rhea gets its pay-off amount, the pool everything else.
  assert.deepEqual(repaySplit(950_000_000n, order), [{ source: 'rhea', amount: 506_680_233n }, { source: 'pool', amount: 443_319_767n }]);
  // With nothing owed to the pool, what is above the lender's pay-off amount isn't sent at all.
  assert.deepEqual(repaySplit(600_000_000n, repayOrder(loan(null, [RHEA], 0n).parts).order), [{ source: 'rhea', amount: 506_680_233n }]);
});

test('“All” sends each lender its pay-off amount and our pool its part with a little extra, up to the USDC held', () => {
  const { order } = repayOrder(loan().parts);
  assert.equal(poolExtra(POOL_DEBT), 1_438_330n);
  assert.equal(repayMost(order, onNear(5_000_000_000n)), 506_680_233n + 438_330_000n + 1_438_330n);
  assert.equal(repayMost(order, onNear(200_000_000n)), 200_000_000n);
  // "Repay all" for Rhea alone: its debt and the little extra.
  assert.equal(repayMost(repayOrder(loan().parts, 'rhea').order, onNear(5_000_000_000n)), 506_680_233n);
  assert.equal(poolExtra(0n), 0n);
});

/** Stage 3: a loan from all three. Aave lends $323 at 5.33% against what is posted on Base Sepolia. */
const AAVE: LenderPosition = { l: 'aave', posted: 570_000_000, debt: 323_000_000, hf_bp: 15_000, liq_bp: 8_500, rate_bp: 533, supply_bp: 410, room: 0, status: 'safe' };
const three = (pricing?: Pricing | null) => loanView({ poolDebt: POOL_DEBT, poolRateBp: 650, lenders: [AAVE, RHEA], pricing });

test('with three sources the dearest is still paid first, and the reason names what the other two cost', () => {
  const view = three();
  assert.equal(view.total, 323_000_000n + 506_670_000n + POOL_DEBT);
  assert.deepEqual(view.parts.map((p) => p.source), ['aave', 'rhea', 'pool']);
  const { order, why } = repayOrder(view.parts);
  assert.deepEqual(order.map((p) => p.source), ['rhea', 'pool', 'aave']);
  assert.equal(why, 'This pays Rhea first: it costs you the most, 15.91% a year against 6.50% for our pool and 5.33% for Aave.');
});

test('when the dearest two cost the same and a third costs less, the lender among them goes first', () => {
  // A cap of 6.50% on a lender's rate, with nothing paid to depositors: Rhea and our pool both cost 6.50%, Aave 5.33%.
  const view = loanView({ poolDebt: POOL_DEBT, poolRateBp: 650, lenders: [AAVE, { ...RHEA, supply_bp: 0 }], pricing: { lender: { margin_bp: 0, cap_bp: 650 } } });
  const { order, why } = repayOrder(view.parts);
  assert.deepEqual(order.map((p) => [p.source, p.payBp]), [['rhea', 650], ['pool', 650], ['aave', 533]]);
  assert.equal(why, 'This pays Rhea first: nothing costs you more, at 6.50% a year. A smaller loan with Rhea widens your cushion there.');
});

test('Aave is repaid from the USDC at the account’s address on its chain, our pool and Rhea from the USDC on NEAR', () => {
  const { order } = repayOrder(three().parts);
  // $250 on NEAR and $400 on Base Sepolia. "All": Rhea and our pool share the $250, Aave takes its pay-off amount.
  const purses = { near: 250_000_000n, evm: 400_000_000n };
  assert.equal(repayMost(order, purses), 250_000_000n + 323_006_560n);
  assert.deepEqual(repaySplit(1_000_000_000n, order, purses), [{ source: 'rhea', amount: 250_000_000n }, { source: 'aave', amount: 323_006_560n }]);
  // A source whose purse is empty is passed over: with nothing on NEAR, $100 goes to Aave.
  assert.deepEqual(repaySplit(100_000_000n, order, { near: 0n, evm: 400_000_000n }), [{ source: 'aave', amount: 100_000_000n }]);
  // And with nothing at the address, Aave gets nothing.
  assert.deepEqual(repaySplit(600_000_000n, repayOrder(three().parts, 'aave').order, onNear(5_000_000_000n)), []);
  // What is above every debt goes to our pool only as far as the USDC on NEAR reaches.
  assert.deepEqual(repaySplit(2_000_000_000n, order, { near: 950_000_000n, evm: 0n }), [{ source: 'rhea', amount: 506_680_233n }, { source: 'pool', amount: 443_319_767n }]);
});

test('paying Aave off takes a little more than was borrowed, so the borrowed USDC alone at the address is short', () => {
  // $33.20 borrowed and still at the address: the pay-off amount is $33.200764, so it is short.
  assert.equal(lenderPayoff(33_200_000n), 33_200_764n);
  assert.equal(shortOfPayoff(33_200_000n, 33_200_000n), true);
  // With 1 test USDC more it isn't, and with nothing owed there is nothing to be short of.
  assert.equal(shortOfPayoff(33_200_000n, 34_200_000n), false);
  assert.equal(shortOfPayoff(33_200_000n, 33_200_764n), false);
  assert.equal(shortOfPayoff(0n, 0n), false);
});

test('the page knows when a payment sends a lender more than the debt read, so it can say where the rest goes', () => {
  const { order } = repayOrder(loan().parts);
  assert.deepEqual(paysOff(repaySplit(600_000_000n, order), order), ['rhea']);
  assert.deepEqual(paysOff(repaySplit(506_670_000n, order), order), []);
  assert.deepEqual(paysOff(repaySplit(100_000_000n, order), order), []);
});

test('USDC sitting at a lender as a plain deposit is listed with its amount, and dust stays readable', () => {
  assert.deepEqual(depositsAt([{ l: 'rhea', deposit: '370000' }, { l: 'aave' }]), [{ l: 'rhea', name: 'Rhea', amount: 370_000n }]);
  assert.deepEqual(depositsAt([{ l: 'rhea', deposit: '0' }]), []);
  assert.deepEqual(depositsAt(undefined), []);
  assert.equal(usdOrDust(370_000n), '$0.37');
  assert.equal(usdOrDust(4_100n), '$0.0041');
  assert.equal(usdOrDust(100n), '$0.0001');
  assert.equal(usdOrDust(0n), '$0.00');
  assert.equal(
    depositWords('Rhea', 370_000n),
    '$0.37 of yours is sitting at Rhea. A repayment sent Rhea a little more than it was owed, and it kept the rest as your deposit. Bringing it back puts it in your account as USDC, and needs no check.',
  );
});

test('a credit the pool owes back, and why', () => {
  assert.equal(creditOwed({ credit: '12340000' }), 12_340_000n);
  assert.equal(creditOwed({ credit: '0' }), 0n);
  assert.equal(creditOwed(null), 0n);
  assert.equal(creditWords(12_340_000n), 'Our pool owes you $12.34. It pays part of a lender’s rate for you, and that came to more than you owe the pool. Claiming sends it to your account as USDC.');
  assert.equal(inSentence('pool'), 'our pool');
  assert.equal(inSentence('aave'), 'Aave');
});
