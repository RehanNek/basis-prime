// The Borrow page's numbers (INTERFACES.md 49.1 point 8), in the words the page shows.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ASK_FOR_MOST, borrowHeadline, checkAgeWords, everythingLabel, everythingWords, mostFromPlan, mostWords, owedAfter, oweHeadline } from './borrow-page.ts';

test('what you can borrow and the rate, and what you owe, each in one line', () => {
  assert.equal(borrowHeadline({ canBorrow: 304_560_000n, rateBp: 650 }), 'You can borrow $304.56 now, at 6.50% a year.');
  assert.equal(borrowHeadline({ canBorrow: 304_560_000n, rateBp: null }), 'You can borrow $304.56 now.');
  // Without the engine's own answer from the last minute the figure is the pool's limit alone: "about".
  assert.equal(borrowHeadline({ canBorrow: 304_560_000n, rateBp: 650, exact: false }), 'You can borrow about $304.56 now, at 6.50% a year.');
  assert.equal(borrowHeadline({ canBorrow: 0n, rateBp: 650 }), 'You can’t borrow more right now.');
  assert.equal(borrowHeadline({ canBorrow: null, rateBp: 650 }), 'Reading what you can borrow…');
  assert.equal(oweHeadline({ owed: 1_025_730_000n, rateBp: 808 }), 'You owe $1,025.73, at 8.08% a year.');
  assert.equal(oweHeadline({ owed: 0n, rateBp: 808 }), 'You owe nothing.');
});

test('“Repay everything” says what it pays before it is pressed, and what stays owed when the account holds less', () => {
  // The user's own way out (48.13): $21.72 owed to Aave and $500 to our pool, with $510 on NEAR and $21.80 at the address.
  const owed = [{ source: 'aave', debt: 21_719_550n }, { source: 'pool', debt: 500_000_000n }];
  const enough = [{ source: 'aave', amount: 21_720_084n }, { source: 'pool', amount: 501_500_000n }];
  assert.equal(owedAfter(owed, enough), 0n);
  assert.equal(
    everythingWords({ pays: 523_220_084n, left: owedAfter(owed, enough) }),
    '“Repay everything” sends $523.22: the whole loan and a little over, because interest grows by the second. What isn’t needed stays yours.',
  );
  // Nothing at the address: our pool is paid off, Aave is not, and the pool's little extra doesn't hide what Aave is owed.
  const poolOnly = [{ source: 'pool', amount: 501_500_000n }];
  assert.equal(owedAfter(owed, poolOnly), 21_719_550n);
  assert.equal(everythingWords({ pays: 501_500_000n, left: owedAfter(owed, poolOnly) }), '“Repay everything” sends $501.50, all the USDC the account can pay with now. $21.71 stays owed.');
  // One lender picked to pay alone: the button and the words name it.
  assert.equal(everythingLabel('Aave'), 'Repay all of Aave');
  assert.equal(everythingLabel(null), 'Repay everything');
  assert.equal(
    everythingWords({ pays: 21_720_084n, left: 0n, source: 'Aave' }),
    '“Repay all of Aave” sends $21.72: all Aave is owed and a little over, because interest grows by the second. What isn’t needed stays yours.',
  );
  assert.equal(everythingWords({ pays: 10_000_000n, left: 11_719_550n, source: 'Aave' }), '“Repay all of Aave” sends $10.00, all the USDC the account can pay with now. $11.71 stays owed to Aave.');
  assert.equal(everythingWords({ pays: 0n, left: 500_000_000n }), 'The account holds no USDC to repay with. Add funds, or bring USDC home from Hyperliquid, first.');
});

test('a lender’s figure from an old check says so: “as of the last check”', () => {
  // The user saw "a loan there of $21.71" after repaying it: the figure was the last check's, 40 minutes old.
  assert.equal(checkAgeWords(277_520_000, 277_520_000 + 3_934), 'as of the last check, about 40 minutes ago');
  assert.equal(checkAgeWords(1_000, 1_000 + 200), 'as of the last check, about 2 minutes ago');
  assert.equal(checkAgeWords(1_000, 1_000 + 121), 'as of the last check, about 1 minute ago');
  assert.equal(checkAgeWords(1_000, 1_000 + 12_000), 'as of the last check, about 2 hours ago');
  // A check within its own lifetime is fresh, and a block the page doesn't know says nothing.
  assert.equal(checkAgeWords(1_000, 1_100), null);
  assert.equal(checkAgeWords(null, 1_100), null);
  assert.equal(checkAgeWords(0, 1_100), null);
});

test('the most that can be borrowed is the engine’s total for a loan far larger than could be lent', () => {
  assert.equal(ASK_FOR_MOST, '1000000000000000', '$1 billion in micro-USD');
  // 14 Nov, the Aave run with the client's own ETH: asked for $2,000, the engine would fund $656.63.
  const plan = { asked: ASK_FOR_MOST, total: 656_626_931, sources: [{ source: 'aave' as const, amount: 21_115_322, rate_bp: 74 }, { source: 'pool' as const, amount: 635_511_609, rate_bp: 500 }], verdict: { ok: true } };
  assert.equal(mostFromPlan(plan), 656_626_931n);
  assert.equal(mostFromPlan({ ...plan, total: '656626931' }), 656_626_931n, 'a string or a number');
  assert.equal(mostFromPlan({ asked: ASK_FOR_MOST, total: 0, sources: [], verdict: { ok: true } }), 0n, 'an answer of nothing is nothing');
  // No answer and a refusal are "not known", never "nothing".
  assert.equal(mostFromPlan(null), null);
  assert.equal(mostFromPlan({ asked: ASK_FOR_MOST, total: 0, sources: [], verdict: { ok: false, reason: 'the engine could not read the book' } }), null);
  assert.equal(mostFromPlan({ asked: ASK_FOR_MOST }), null);
});

test('“Most you can borrow now” always has a figure or a plain line to read', () => {
  // The figure is cut down to cents, never rounded up: $656.626931 shows as $656.62.
  assert.deepEqual(mostWords({ engine: 656_626_931n, asking: false, estimate: null }), { figure: '$656.62 USDC', note: 'Worked out by the risk engine from your whole account, just now.' });
  assert.deepEqual(mostWords({ engine: 656_626_931n, asking: true, estimate: 600_000_000n }), { figure: '$656.62 USDC', note: 'From the risk engine a moment ago. It is working the figure out again.' });
  assert.deepEqual(mostWords({ engine: 0n, asking: false, estimate: 300_000_000n }), {
    figure: '$0.00 USDC',
    note: 'Nothing can be borrowed against the account as it stands. Deposit collateral, or repay, to raise it.',
  });
  // Before the engine answers: the page's own guide when it has one, else that it is being worked out.
  assert.deepEqual(mostWords({ engine: null, asking: true, estimate: 304_560_000n }), { figure: 'about $304.56 USDC', note: 'From your last check. The risk engine is working out the exact figure: 10 to 60 seconds.' });
  assert.deepEqual(mostWords({ engine: null, asking: true, estimate: null }), { figure: 'Working it out…', note: 'The risk engine is reading your whole account: 10 to 60 seconds.' });
  // The engine isn't asked (an account that borrows from the pool alone) or didn't answer.
  assert.deepEqual(mostWords({ engine: null, asking: false, estimate: 304_560_000n }), { figure: 'about $304.56 USDC', note: 'From your last check. The risk engine sets the exact figure when you press Borrow.' });
  assert.deepEqual(mostWords({ engine: null, asking: false, estimate: 0n }), { figure: 'Not known yet', note: 'The risk engine sets the figure when you press Borrow.' });
});
