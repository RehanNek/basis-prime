// The account picker's line (INTERFACES.md 48.6): yours, new, another wallet's, the operator looking, several of yours.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { accountsToOffer, pickerLine, pickerWords } from './picker.ts';

const ALICE = 'alice.testnet';
const account = (owner: string | null, exists = true) => ({ account_id: 'k7x2m9qa4t.pbf.testnet', exists, state: owner ? { owner } : null });
const words = (input: Parameters<typeof pickerLine>[0]) => pickerWords(pickerLine(input));

test('your own account, and a name that is free', () => {
  assert.equal(words({ answer: account(ALICE), owner: ALICE, mode: 'owner' }), 'k7x2m9qa4t.pbf.testnet, owned by you.');
  assert.equal(words({ answer: account(null, false), owner: ALICE, mode: 'owner' }), 'k7x2m9qa4t.pbf.testnet doesn’t exist yet: create it below.');
  assert.equal(words({ answer: undefined, owner: ALICE, mode: 'owner' }), 'Reading the account…');
  assert.equal(pickerLine({ answer: account(null), owner: ALICE, mode: 'owner' }).kind, 'not_client');
});

test('another wallet’s account says only that: never the owner, and nothing else about it', () => {
  // The backend refused: 403 `not_yours`. Whatever answer the page still holds isn't used.
  const refused = pickerLine({ answer: account('bob.testnet'), errorCode: 'not_yours', owner: ALICE, mode: 'owner' });
  assert.deepEqual(refused, { kind: 'another_wallet' });
  assert.equal(pickerWords(refused), 'This name belongs to another wallet.');
  assert.equal(words({ answer: undefined, errorCode: 'not_yours', owner: ALICE, mode: 'owner' }), 'This name belongs to another wallet.');
  // An answer about another wallet's account that the page can't explain still names no owner.
  assert.equal(words({ answer: account('bob.testnet'), owner: ALICE, mode: 'owner' }), 'This name belongs to another wallet.');
});

test('the operator looking at a client’s account is told so, and an open account says it is open; neither names the owner', () => {
  const asOperator = words({ answer: account('bob.testnet'), owner: 'pbf-ops.testnet', mode: 'owner', isOperator: true });
  assert.equal(asOperator, 'k7x2m9qa4t.pbf.testnet belongs to another wallet. You are looking as the operator.');
  const open = words({ answer: account('bob.testnet'), owner: ALICE, mode: 'owner', openAccounts: ['k7x2m9qa4t.pbf.testnet'] });
  assert.equal(open, 'k7x2m9qa4t.pbf.testnet belongs to another wallet. It is open for anyone to look at.');
  assert.equal(asOperator.includes('bob.testnet') || open.includes('bob.testnet'), false);
  // The operator's own account is still just theirs.
  assert.equal(pickerLine({ answer: account('pbf-ops.testnet'), owner: 'pbf-ops.testnet', mode: 'owner', isOperator: true }).kind, 'yours');
});

test('“your accounts” are offered to choose from only when the wallet has more than one', () => {
  assert.deepEqual(accountsToOffer(['k7x2m9qa4t', 'older']), ['k7x2m9qa4t', 'older']);
  assert.deepEqual(accountsToOffer(['k7x2m9qa4t']), []);
  assert.deepEqual(accountsToOffer([]), []);
});
