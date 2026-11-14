// New accounts get a random name, and which account a wallet works on (INTERFACES.md 48.6).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chooseName, nameProblem, ownNames, randomName } from './names.ts';

const FACTORY = 'pbf.testnet';

test('a random name is 10 characters from a to z and 2 to 7, always passes the factory’s name rule, and never repeats', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5_000; i += 1) {
    const name = randomName();
    assert.match(name, /^[a-z2-7]{10}$/);
    assert.equal(nameProblem(name, FACTORY), null);
    seen.add(name);
  }
  // 5,000 draws of about 50 bits each: a repeat would mean the randomness is broken.
  assert.equal(seen.size, 5_000);
  // Each byte gives one character by its low 5 bits, whatever the byte.
  assert.equal(randomName((bytes) => bytes.fill(0)), 'aaaaaaaaaa');
  assert.equal(randomName((bytes) => bytes.fill(255)), '7777777777');
  assert.equal(randomName((bytes) => bytes.map((_, i) => i)), 'abcdefghij');
  assert.equal(nameProblem('7777777777', FACTORY), null);
});

test('a wallet’s account is the remembered name, else the newest of its own, else none yet (a random one is then made)', () => {
  const mine = [{ account_id: 'k7x2m9qa4t.pbf.testnet' }, { account_id: 'older.pbf.testnet' }];
  // 1. The name remembered in this browser wins, whatever the backend lists.
  assert.deepEqual(chooseName({ remembered: 'alice', mine, factory: FACTORY }), { name: 'alice', from: 'remembered' });
  // A name the client cleared to type another stays empty: the field isn't refilled under their fingers.
  assert.deepEqual(chooseName({ remembered: '', mine, factory: FACTORY }), { name: '', from: 'remembered' });
  // 2. Else the newest of the wallet's own accounts: the list comes newest first.
  assert.deepEqual(chooseName({ remembered: undefined, mine, factory: FACTORY }), { name: 'k7x2m9qa4t', from: 'mine' });
  // 3. Else none: the caller makes a random name once, and remembers it.
  assert.deepEqual(chooseName({ remembered: undefined, mine: [], factory: FACTORY }), { name: '', from: 'none' });
  assert.deepEqual(chooseName({ remembered: undefined, mine: null, factory: FACTORY }), { name: '', from: 'none' });
  // An account under another factory isn't one this app can open by name.
  assert.deepEqual(ownNames([{ account_id: 'x.other.testnet' }, { account_id: 'mine.pbf.testnet' }], FACTORY), ['mine']);
});
