// What a client pays under the operator's pricing policy, and the Book page's view of it (FUNDING.md 5; INTERFACES.md 26).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FundingPlanAnswer, Pricing, PricingAnswer } from './api.ts';
import {
  cardRateNote,
  clientRateBp,
  feeLimitLines,
  fromWords,
  fundingFromForm,
  lentThrough,
  limitsWords,
  orderWords,
  parsePoints,
  periodWords,
  policyKind,
  policyNote,
  pricedPlan,
  pricingBook,
  pricingExample,
  pricingFromForm,
  pricingProblem,
  pricingWords,
  targetWords,
} from './pricing.ts';

const MARGIN: Pricing = { lender: { margin_bp: 120, cap_bp: null } };
const CAP: Pricing = { lender: { margin_bp: 0, cap_bp: 800 } };
const FIXED: Pricing = { fixed: { rate_bp: 650 } };

test('each policy is said in a few words', () => {
  assert.equal(pricingWords('pass_through'), 'Each source at its own rate');
  assert.equal(pricingWords(null), 'Each source at its own rate');
  assert.equal(pricingWords(MARGIN), 'The lender’s rate plus 1.20 points');
  assert.equal(pricingWords(CAP), 'The lender’s rate, but never above 8.00%');
  assert.equal(pricingWords({ lender: { margin_bp: -50, cap_bp: 900 } }), 'The lender’s rate less 0.50 points, but never above 9.00%');
  assert.equal(pricingWords({ lender: { margin_bp: 100, cap_bp: null } }), 'The lender’s rate plus 1.00 point');
  assert.equal(pricingWords(FIXED), '6.50% a year on the whole loan');
  assert.deepEqual([policyKind('pass_through'), policyKind(MARGIN), policyKind(FIXED), policyKind(undefined)], ['pass_through', 'lender', 'fixed', 'pass_through']);
});

test('the client’s rate follows INTERFACES.md 26’s worked numbers', () => {
  // Rhea at 15.91% with a cap of 8%: with a deposit rate of 0 the client pays 8%; with Rhea's real 10.32% the floor
  // makes the client pay 10.32%.
  assert.equal(clientRateBp(CAP, 'rhea', 1_591, 0), 800);
  assert.equal(clientRateBp(CAP, 'rhea', 1_591, 1_032), 1_032);
  // Aave at 5.33% plus 1.2 points.
  assert.equal(clientRateBp(MARGIN, 'aave', 533, 410), 653);
  // One rate on everything: 6.50% on Aave's part and on our pool's.
  assert.equal(clientRateBp(FIXED, 'aave', 533, 410), 650);
  assert.equal(clientRateBp(FIXED, 'pool', 700), 650);
  // Pass-through, and no policy at all: each source at its own rate.
  assert.equal(clientRateBp('pass_through', 'rhea', 1_591, 1_032), 1_591);
  assert.equal(clientRateBp(null, 'pool', 650), 650);
  // A margin policy leaves our pool's own part alone.
  assert.equal(clientRateBp(MARGIN, 'pool', 650), 650);
});

test('a subsidy never takes the client under the lender’s deposit rate, nor above the lender’s own', () => {
  // A fixed 6.50% against Rhea at 15.91% that pays depositors 10.32%: the client pays 10.32%.
  assert.equal(clientRateBp(FIXED, 'rhea', 1_591, 1_032), 1_032);
  // A deposit rate above the lender's own rate can't push the client above what the lender charges.
  assert.equal(clientRateBp(CAP, 'rhea', 1_000, 1_200), 1_000);
  // A negative margin never goes below zero.
  assert.equal(clientRateBp({ lender: { margin_bp: -900, cap_bp: null } }, 'aave', 533, 0), 0);
});

test('a row says how the client’s rate differs from the source’s own, and nothing when it doesn’t', () => {
  assert.equal(policyNote('rhea', 1_591, 1_032), 'Rhea charges 15.91%; we pay the rest');
  assert.equal(policyNote('aave', 533, 653), 'Aave charges 5.33%; the rest is our margin');
  assert.equal(policyNote('pool', 700, 650), 'Our pool’s own rate is 7.00%');
  assert.equal(policyNote('aave', 533, 533), null);
});

test('a lender card says what the client pays when that isn’t the lender’s own rate', () => {
  assert.equal(cardRateNote(CAP, 'rhea', 1_591, 1_032), 'You pay 10.32%: we pay the rest');
  assert.equal(cardRateNote(MARGIN, 'aave', 533, 410), 'You pay 6.53%: the rest is our margin');
  assert.equal(cardRateNote('pass_through', 'rhea', 1_591, 1_032), null);
  assert.equal(cardRateNote(null, 'rhea', 1_591, 1_032), null);
  assert.equal(cardRateNote(CAP, 'rhea', null, null), null);
});

test('the borrow panel’s sources show what the client pays under the account’s policy', () => {
  const plan: FundingPlanAnswer = {
    asked: '94500000000', total: 94_500_000_000,
    sources: [{ source: 'rhea', amount: 50_667_000_000, rate_bp: 1_591 }, { source: 'pool', amount: 43_833_000_000, rate_bp: 650 }],
    steps: [], ext: [{ l: 'rhea', c: 100_000_000_000, d: 0, hf_bp: 0, r_bp: 1_591, s_bp: 1_032, room: 50_667_000_000, liq_bp: 7_600 }],
    blended_bp: 1_155, verdict: { ok: true }, run: {},
  };
  const capped = pricedPlan(plan, CAP)!;
  assert.deepEqual(capped.rows, [
    { source: 'rhea', name: 'Rhea', amount: '$50,667.00', rate: '10.32%', note: 'Rhea charges 15.91%; we pay the rest' },
    { source: 'pool', name: 'Our pool', amount: '$43,833.00', rate: '6.50%' },
  ]);
  // ($50,667 at 10.32% and $43,833 at 6.50%) over $94,500.
  assert.equal(capped.rate, '8.55%');
  // Pass-through, or no policy read yet: the sources' own rates and the backend's own figure.
  assert.equal(pricedPlan(plan, 'pass_through')!.rate, '11.55%');
  assert.deepEqual(pricedPlan(plan, null)!.rows[0], { source: 'rhea', name: 'Rhea', amount: '$50,667.00', rate: '15.91%' });
  // One rate on the whole loan: the floor still holds on Rhea's part.
  assert.deepEqual(pricedPlan(plan, FIXED)!.rows.map((r) => r.rate), ['10.32%', '6.50%']);
  assert.equal(pricedPlan(null, CAP), null);
});

test('a policy is refused as the pool would refuse it', () => {
  assert.equal(pricingProblem('pass_through'), null);
  assert.equal(pricingProblem({ lender: { margin_bp: -10_000, cap_bp: 10_000 } }), null);
  assert.equal(pricingProblem({ lender: { margin_bp: 10_001, cap_bp: null } }), 'The margin must be between -100 and 100 points.');
  assert.equal(pricingProblem({ lender: { margin_bp: 0, cap_bp: 10_001 } }), 'The cap must be between 0% and 100% a year.');
  assert.equal(pricingProblem({ fixed: { rate_bp: 10_001 } }), 'The rate must be between 0% and 100% a year.');
  assert.equal(pricingProblem(FIXED), null);
});

test('the operator’s form becomes the pool’s own JSON', () => {
  const form = { kind: 'lender' as const, margin: '1.2', cap: '', rate: '' };
  assert.deepEqual(pricingFromForm(form), { pricing: MARGIN, problem: null });
  assert.deepEqual(pricingFromForm({ ...form, margin: '', cap: '8' }), { pricing: CAP, problem: null });
  assert.deepEqual(pricingFromForm({ ...form, margin: '-0.5', cap: '9' }).pricing, { lender: { margin_bp: -50, cap_bp: 900 } });
  assert.deepEqual(pricingFromForm({ ...form, kind: 'fixed', rate: '6.5' }), { pricing: FIXED, problem: null });
  assert.deepEqual(pricingFromForm({ ...form, kind: 'pass_through' }), { pricing: 'pass_through', problem: null });
  assert.equal(pricingFromForm({ ...form, margin: 'lots' }).problem, 'Enter the margin in points, like 1.2 or -0.5');
  assert.equal(pricingFromForm({ ...form, cap: '8%' }).problem, 'Enter the cap as a percent, like 8, or leave it empty');
  assert.equal(pricingFromForm({ ...form, kind: 'fixed', rate: '101' }).problem, 'The rate must be between 0% and 100% a year.');
  // Nothing typed yet is no problem, and no policy.
  assert.deepEqual(pricingFromForm({ ...form, kind: 'fixed', rate: '' }), { pricing: null, problem: null });
  assert.equal(parsePoints('-0.5', true), -50);
  assert.equal(parsePoints('-0.5'), null);
});

test('a policy comes with a dollar example: what the client pays, and what we keep or pay', () => {
  assert.equal(pricingExample(MARGIN, 533, 410), 'On $10,000 from a lender at 5.33%, the client pays 6.53%: $653 a year. We keep $120.');
  // The floor lifts a cap of 8% to the lender's deposit rate, and the example says so.
  assert.equal(
    pricingExample(CAP, 1_591, 1_032),
    'On $10,000 from a lender at 15.91%, the client pays 10.32%: $1,032 a year. We pay $559. The client never pays less than that lender pays its own depositors, 10.32%.',
  );
  assert.equal(pricingExample(CAP, 1_591, 0), 'On $10,000 from a lender at 15.91%, the client pays 8.00%: $800 a year. We pay $791.');
  assert.equal(pricingExample('pass_through', 533), 'On $10,000 from a lender at 5.33%, the client pays 5.33%: $533 a year. We keep nothing and pay nothing.');
});

test('the source order and the loan life, from the form and in words', () => {
  assert.equal(orderWords('cheapest'), 'The cheapest source first');
  assert.equal(orderWords('pool_first'), 'Our pool first');
  assert.equal(orderWords('lender_first'), 'A lender first');
  // The engine reads an order it doesn't know as the cheapest first, so the page says the same.
  assert.equal(orderWords('later'), 'The cheapest source first');
  assert.deepEqual(fundingFromForm({ order: 'lender_first', days: '90' }), { funding: { order: 'lender_first', loan_days: 90 }, problem: null });
  assert.equal(fundingFromForm({ order: 'cheapest', days: '0' }).problem, 'The loan life must be a whole number of days, at least 1.');
  assert.equal(fundingFromForm({ order: 'cheapest', days: '7.5' }).funding, null);
  assert.deepEqual(fundingFromForm({ order: 'cheapest', days: '' }), { funding: null, problem: null });
});

test('a target and where a policy came from, in words', () => {
  assert.equal(targetWords({ account: 'alice.pbf.testnet' }), 'alice.pbf.testnet');
  assert.equal(targetWords({ tier: 'STANDARD' }), 'every Standard account');
  assert.deepEqual(['account', 'tier', 'default'].map(fromWords), ['Set for this account', 'From its tier', 'The default']);
});

/** GET /api/pricing as the backend answers it (services/api/src/pricing.ts), with the demo's two policies (FUNDING.md 15). */
const ANSWER: PricingAnswer = {
  read_at_ms: 1_794_000_000_000,
  funding: { order: 'cheapest', loan_days: 90 },
  limits: { max_rate_bp: 6_000, avg_plus_bp: 500, max_period_ns: 172_800_000_000_000, account_subsidy_day: '100000000', pool_subsidy_day_bp: 5 },
  pool: { fees_charged: '680000', subsidy_paid: '457500', subsidy_left_24h: '12042500' },
  tiers: [{ tier: 'STANDARD', pricing: MARGIN }],
  accounts: [
    {
      account: 'alice.pbf.testnet', pricing: CAP, from: 'account', fees_charged: '0', subsidy_paid: '457500', credit: '120000', settled_at: '1794000000000000000',
      last: [{ lender: 'rhea', debt: '50667000000', rate_bp: 1_591, supply_bp: 1_032 }],
      lender_debt: [{ lender: 'rhea', debt: '50667000000' }],
    },
    // A fresh loan: the pool hasn't settled it yet, so its own report still says nothing, and the verdict's figure counts.
    {
      account: 'bob.pbf.testnet', pricing: MARGIN, from: 'tier', fees_charged: '680000', subsidy_paid: '0', credit: '0', settled_at: '0',
      last: [],
      lender_debt: [{ lender: 'aave', debt: '56667000000' }, { lender: 'rhea', debt: '1000000000' }],
    },
  ],
};

test('what is lent through each lender is the sum of what each account owes it by its held verdict', () => {
  assert.deepEqual(lentThrough(ANSWER.accounts), [
    { lender: 'aave', name: 'Aave', amount: 56_667_000_000n },
    { lender: 'rhea', name: 'Rhea', amount: 51_667_000_000n },
  ]);
  assert.deepEqual(lentThrough([{ lender_debt: [] }, {}]), []);
  // The pool's own last report isn't counted: a loan repaid since the last settlement would still show there.
  assert.deepEqual(lentThrough([{ ...ANSWER.accounts[0]!, lender_debt: [] }]), []);
});

test('a pool from before stage 2 answers nulls and empty lists, and the Book page shows nothing for it', () => {
  assert.equal(pricingBook({ read_at_ms: 1, funding: null, limits: null, pool: null, tiers: [], accounts: [] }), null);
  // A pool with pricing but nothing set and nothing lent still shows its totals and the default for every tier.
  const empty = pricingBook({ ...ANSWER, tiers: [], accounts: [] })!;
  assert.deepEqual(empty.lent, []);
  assert.deepEqual(empty.accounts, []);
  assert.ok(empty.tiers.every((t) => !t.own && t.pays === 'Each source at its own rate'));
});

test('the Book page shows the order, the fees, the subsidies, the budget left, each tier and each account', () => {
  const book = pricingBook(ANSWER)!;
  assert.equal(book.order, 'The cheapest source first');
  assert.equal(book.loanDays, '90 days');
  assert.deepEqual([book.fees, book.subsidy, book.subsidyLeft], ['$0.68', '$0.45', '$12.04']);
  assert.deepEqual(book.lent, [{ name: 'Aave', amount: '$56,667.00' }, { name: 'Rhea', amount: '$51,667.00' }]);
  assert.deepEqual(book.tiers, [
    { tier: 'PREFERRED', name: 'Preferred', pays: 'Each source at its own rate', own: false },
    { tier: 'STANDARD', name: 'Standard', pays: 'The lender’s rate plus 1.20 points', own: true },
    { tier: 'WATCH', name: 'Watch', pays: 'Each source at its own rate', own: false },
  ]);
  assert.deepEqual(book.accounts[0], {
    account: 'alice.pbf.testnet', pays: 'The lender’s rate, but never above 8.00%', from: 'Set for this account', lent: ['Rhea $50,667.00'],
    fees: '$0.00', subsidy: '$0.45', credit: '$0.12', settledAtMs: 1_794_000_000_000,
  });
  assert.deepEqual(book.accounts[1]!.lent, ['Aave $56,667.00', 'Rhea $1,000.00']);
  assert.equal(book.accounts[1]!.settledAtMs, null);
  assert.equal(
    book.limits,
    'A lender’s rate counts at no more than 60.00% a year, nor its 7-day average plus 5.00 points. One account gets at most $100.00 of subsidy a day, and the whole pool pays at most 0.05% of its capital a day.',
  );
});

/** INTERFACES.md 45.1: the pool's three limits on fees, at their defaults. */
const FEE_LIMITS = { max_lender_debt: '1000000000000', account_fee_day: '1000000000', pool_fee_day_bp: 50 };

test('the three limits on fees each read in one plain line with a dollar figure (INTERFACES.md 45)', () => {
  const limits = { ...ANSWER.limits!, ...FEE_LIMITS };
  // With the pool's own capital, the pool's line gives its own figure: 0.5% of $10,000,000.
  assert.deepEqual(feeLimitLines(limits, '10000000000000'), [
    'A lender’s reported debt counts at no more than $1,000,000.00 in a settlement, for a fee and for a subsidy.',
    'One account is charged at most $1,000.00 of fees in 24 hours. A fee above that is cut, and isn’t owed later.',
    'The whole pool books at most 0.50% of its capital in fees in 24 hours: $50,000.00 on its $10,000,000.00.',
  ]);
  // Without it, the same share on $10,000.
  assert.equal(feeLimitLines(limits)[2], 'The whole pool books at most 0.50% of its capital in fees in 24 hours: $50.00 on each $10,000.00.');
  // The Book page carries them beside the limits it showed before.
  const book = pricingBook({ ...ANSWER, limits }, '25000000000')!;
  assert.equal(book.feeLimits.length, 3);
  assert.equal(book.feeLimits[2], 'The whole pool books at most 0.50% of its capital in fees in 24 hours: $125.00 on its $25,000.00.');
  assert.match(book.limits!, /^A lender’s rate counts at no more than 60\.00% a year/);
});

test('an answer from before the fee limits still renders: no line for a field it doesn’t carry', () => {
  assert.deepEqual(feeLimitLines(ANSWER.limits), []);
  assert.deepEqual(feeLimitLines(null), []);
  assert.deepEqual(pricingBook(ANSWER)!.feeLimits, []);
  // One of the three alone shows alone.
  assert.deepEqual(feeLimitLines({ ...ANSWER.limits!, account_fee_day: '1000000000' }), ['One account is charged at most $1,000.00 of fees in 24 hours. A fee above that is cut, and isn’t owed later.']);
});

test('a settlement’s period: a fee covers all the time since the last one, a subsidy at most 48 hours of it', () => {
  // INTERFACES.md 45.1, point 3. The 48 hours are the pool's own `max_period_ns`.
  assert.equal(periodWords(ANSWER.limits), 'A fee covers all the time since the account’s last settlement. A subsidy covers at most 48 hours of it.');
  assert.equal(periodWords({ ...ANSWER.limits!, max_period_ns: '86400000000000' }), 'A fee covers all the time since the account’s last settlement. A subsidy covers at most 24 hours of it.');
  // Without the limits the pool's default stands in.
  assert.equal(periodWords(null), 'A fee covers all the time since the account’s last settlement. A subsidy covers at most 48 hours of it.');
});

test('the per-client lines show only when the backend sends them: hidden, the page says so in their place (INTERFACES.md 48)', () => {
  // The operator, or privacy off: the list is there.
  const shown = pricingBook(ANSWER)!;
  assert.equal(shown.accountsHidden, false);
  assert.equal(shown.accounts.length, 2);
  assert.equal(pricingBook({ ...ANSWER, accounts_hidden: false })!.accountsHidden, false);
  // Anyone else: `accounts` is empty and `accounts_hidden` is true. The pool's own figures stay.
  const hidden = pricingBook({ ...ANSWER, accounts: [], accounts_hidden: true })!;
  assert.equal(hidden.accountsHidden, true);
  assert.deepEqual(hidden.accounts, []);
  assert.deepEqual([hidden.fees, hidden.subsidy, hidden.order], ['$0.68', '$0.45', 'The cheapest source first']);
});

test('no answer, or an answer of another shape, shows nothing', () => {
  assert.equal(pricingBook(null), null);
  assert.equal(pricingBook({ error: 'not_found' } as unknown as PricingAnswer), null);
  assert.equal(limitsWords(null), null);
});
