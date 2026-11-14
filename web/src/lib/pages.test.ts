// Runs with Node's own TypeScript support: pnpm --filter @pb/web test
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import { morePages, navPages, pageAt, PAGES, tabPages } from './pages.ts';

test('the pages of PLAN.md 5.8 are all listed, once each', () => {
  assert.deepEqual(
    PAGES.map((p) => p.title),
    ['Spot', 'Perps', 'Basis trade', 'Credit check', 'Book', 'Account', 'Deposit & withdraw', 'Trade', 'Borrow', 'Risk', 'Activity', 'Drill'],
  );
  assert.equal(new Set(PAGES.map((p) => p.href)).size, PAGES.length);
});

test('every page of before has a route in src/app; the three new tabs are linked while their pages are being built', () => {
  // INTERFACES.md 49.5: Spot, Perps and Basis trade are other helpers' folders, built at the same time.
  const beingBuilt = ['/spot', '/perps', '/basis'];
  for (const page of PAGES) {
    if (beingBuilt.includes(page.href)) continue;
    assert.ok(existsSync(new URL(`../app${page.href}/page.tsx`, import.meta.url)), `missing src/app${page.href}/page.tsx`);
  }
  assert.deepEqual(PAGES.filter((p) => beingBuilt.includes(p.href)).map((p) => p.place), ['tab', 'tab', 'tab']);
});

test('the drill panel is shown on testnet only', () => {
  assert.ok(navPages('testnet').some((p) => p.href === '/drill'));
  assert.ok(!navPages('mainnet').some((p) => p.href === '/drill'));
  assert.equal(navPages('mainnet').length, PAGES.length - 1);
});

test('the tabs are Home, Spot, Perps, Borrow, Basis trade and More; the pages of before are under More, but the old order form (INTERFACES.md 49.1)', () => {
  assert.deepEqual(tabPages('testnet').map((p) => [p.label, p.href]), [['Spot', '/spot'], ['Perps', '/perps'], ['Borrow', '/borrow'], ['Basis trade', '/basis']]);
  // Credit check and Book moved under More. The old order form left the menu on the user's word (13 Nov); its address stays.
  assert.deepEqual(
    morePages('testnet').map((p) => p.label),
    ['Deposit & withdraw', 'Activity', 'Risk', 'Account details', 'Credit check', 'Book', 'Drill'],
  );
  // INTERFACES.md 50.1 point 3: "Add funds" became "Deposit & withdraw" (the user's name for it), one page for both,
  // at the address of before.
  assert.deepEqual([pageAt('/deposit').label, pageAt('/deposit').title, pageAt('/deposit').place], ['Deposit & withdraw', 'Deposit & withdraw', 'more']);
  assert.match(pageAt('/deposit').summary, /Depositing: .*Withdrawing: /);
  assert.equal(pageAt('/trade').place, 'none');
  assert.ok(![...tabPages('testnet'), ...morePages('testnet')].some((p) => p.href === '/trade'));
  // Every other page is a tab or in More.
  assert.equal(tabPages('testnet').length + morePages('testnet').length, PAGES.length - 1);
  assert.ok(!morePages('mainnet').some((p) => p.href === '/drill'));
  for (const page of PAGES) {
    assert.ok(page.label && page.blurb && page.icon.startsWith('bi-'), `${page.href} needs a label, a blurb and an icon`);
    assert.ok(page.blurb.length <= 64, `${page.href}'s blurb should fit one line of the menu`);
  }
});

test('the public pages need no wallet; the account pages do (Risk and Activity only read, so anyone may look)', () => {
  assert.deepEqual(
    PAGES.filter((p) => !p.wallet).map((p) => p.href),
    ['/credit-check', '/book', '/risk', '/activity', '/drill'],
  );
  assert.equal(pageAt('/borrow').wallet, true);
  assert.throws(() => pageAt('/hello-near'), /No page at \/hello-near/);
});
