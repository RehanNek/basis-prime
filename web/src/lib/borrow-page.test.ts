// The Borrow page's numbers (INTERFACES.md 49.1 point 8), in the words the page shows.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { borrowHeadline, checkAgeWords, everythingLabel, everythingWords, owedAfter, oweHeadline } from './borrow-page.ts';

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
