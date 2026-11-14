// The funding permission in words, and the account's own checks on it (FUNDING.md 4.2; INTERFACES.md 24 and 25).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  configuredLenders,
  defaultPermission,
  draftOf,
  lenderList,
  movesWords,
  parseCushion,
  parsePercent,
  PERMISSION_LIMITS,
  permissionFromDraft,
  permissionLimits,
  permissionProblem,
  permissionSummary,
  permissionTerms,
  samePermission,
} from './permission.ts';
import { settingsPostedWord } from './funding.ts';
import type { LenderName, Permission } from './types.ts';

/** INTERFACES.md 24: the app's default terms, for an account with both lenders. */
const DEFAULT: Permission = { lenders: ['aave', 'rhea'], min_hf_bp: 15_000, max_rate_bp: 2_500, moves: 'any' };
const RHEA: LenderName[] = ['rhea'];

test('the lenders a config has settings for are read from its `lenders`, Aave first', () => {
  const rhea = { contract_id: 'rhea.pbf-ops.testnet', collateral: ['mnbtc.pbf-ops.testnet'] };
  assert.deepEqual(configuredLenders({ lenders: { rhea, aave: null } }), ['rhea']);
  assert.deepEqual(configuredLenders({ lenders: { rhea, aave: { chain_id: 84_532 } } }), ['aave', 'rhea']);
  // A config from before Phase 6, and no config at all.
  assert.deepEqual(configuredLenders({ tokens: [] }), []);
  assert.deepEqual(configuredLenders(null), []);
});

test('the permission offered at opening names every lender the account will have, on the default terms', () => {
  assert.deepEqual(defaultPermission(['rhea', 'aave']), DEFAULT);
  assert.deepEqual(defaultPermission(RHEA), { lenders: ['rhea'], min_hf_bp: 15_000, max_rate_bp: 2_500, moves: 'any' });
  assert.equal(defaultPermission([]), null);
});

test('the four terms are said in plain words: which lenders, the smallest cushion, the highest rate, moves', () => {
  const terms = permissionTerms({ ...DEFAULT, lenders: ['rhea'] });
  assert.deepEqual(terms.map((t) => [t.label, t.value]), [
    ['Lender', 'Rhea'],
    ['Smallest cushion', '1.50'],
    ['Highest rate', '25.00% a year'],
    ['Moving a loan between lenders', 'Allowed'],
  ]);
  assert.equal(terms[0]!.note, 'Part of a loan may come from this lender. A lender looks only at the bitcoin posted with it.');
  assert.equal(terms[1]!.note, 'At 1.00 a lender sells the bitcoin posted with it. A new loan there must leave at least 1.50, so bitcoin could fall 33% first.');
  assert.equal(terms[2]!.note, 'The engine borrows from a lender only while its rate is at or under this. On $1,000 for a year, that is at most $250.');
  assert.match(terms[3]!.note, /doesn’t move a running loan yet/);
  assert.deepEqual(permissionTerms(DEFAULT).slice(0, 1).map((t) => [t.label, t.value]), [['Lenders', 'Aave and Rhea']]);
  assert.equal(movesWords('lower_cost_only'), 'Only to a cheaper lender');
  assert.equal(movesWords('off'), 'Not allowed');
  assert.equal(lenderList([]), 'None');
});

test('a permission in one line, and an account with none', () => {
  assert.equal(permissionSummary({ ...DEFAULT, lenders: ['rhea'] }), 'Rhea may lend to this account, down to a cushion of 1.50 and up to 25.00% a year.');
  assert.equal(permissionSummary(null), 'No permission is signed: every loan comes from our pool alone.');
  assert.equal(permissionSummary({ ...DEFAULT, lenders: [] }), 'The permission names no lender, so every loan comes from our pool alone.');
});

test('the page refuses what the account would: a lender it has no settings for, a cushion or a rate out of range', () => {
  assert.equal(permissionProblem({ ...DEFAULT, lenders: ['rhea'] }, RHEA), null);
  assert.equal(permissionProblem(DEFAULT, RHEA), 'This account has no settings for Aave, so it can’t be named.');
  assert.equal(permissionProblem({ ...DEFAULT, lenders: ['rhea', 'rhea'] }, RHEA), 'Rhea is named twice.');
  assert.match(permissionProblem({ ...DEFAULT, lenders: ['compound' as LenderName] }, RHEA)!, /isn’t a lender this account knows/);
  // The contract's bounds: 12000 to 50000 for the cushion, 1 to 10000 for the rate.
  assert.equal(permissionProblem({ ...DEFAULT, lenders: ['rhea'], min_hf_bp: 12_000 }, RHEA), null);
  assert.equal(permissionProblem({ ...DEFAULT, lenders: ['rhea'], min_hf_bp: 11_999 }, RHEA), 'The smallest cushion must be between 1.20 and 5.00.');
  assert.equal(permissionProblem({ ...DEFAULT, lenders: ['rhea'], min_hf_bp: 50_001 }, RHEA), 'The smallest cushion must be between 1.20 and 5.00.');
  assert.equal(permissionProblem({ ...DEFAULT, lenders: ['rhea'], max_rate_bp: 10_000 }, RHEA), null);
  assert.equal(permissionProblem({ ...DEFAULT, lenders: ['rhea'], max_rate_bp: 0 }, RHEA), 'The highest rate must be above 0% and at most 100% a year.');
  assert.equal(permissionProblem({ ...DEFAULT, lenders: ['rhea'], max_rate_bp: 10_001 }, RHEA), 'The highest rate must be above 0% and at most 100% a year.');
});

test('a permission that names no lender isn’t sent: cancelling says it more plainly', () => {
  assert.equal(permissionProblem({ ...DEFAULT, lenders: [] }, RHEA), 'Pick at least one lender. To stop lenders altogether, cancel the permission instead.');
});

test('the form’s cushion and rate read as basis points', () => {
  assert.equal(parseCushion('1.5'), 15_000);
  assert.equal(parseCushion(' 1.35 '), 13_500);
  assert.equal(parseCushion('2'), 20_000);
  assert.equal(parseCushion('1.355'), null);
  assert.equal(parseCushion('a lot'), null);
  assert.equal(parsePercent('25'), 2_500);
  assert.equal(parsePercent('15.91'), 1_591);
  assert.equal(parsePercent(''), null);
  assert.equal(parsePercent('-5'), null);
});

test('the Account page’s form reads a permission and writes one back', () => {
  const draft = draftOf(DEFAULT);
  assert.deepEqual(draft, { lenders: ['aave', 'rhea'], cushion: '1.5', rate: '25', moves: 'any' });
  assert.deepEqual(permissionFromDraft(draft, ['aave', 'rhea']), { permission: DEFAULT, problem: null });
  // A wider cushion and a lower ceiling, with the lenders ticked in any order.
  assert.deepEqual(permissionFromDraft({ lenders: ['rhea', 'aave'], cushion: '1.8', rate: '12.5', moves: 'off' }, ['aave', 'rhea']).permission, {
    lenders: ['aave', 'rhea'], min_hf_bp: 18_000, max_rate_bp: 1_250, moves: 'off',
  });
  assert.equal(permissionFromDraft({ ...draft, cushion: 'wide' }, ['aave', 'rhea']).problem, 'Enter the smallest cushion as a number, like 1.5');
  assert.equal(permissionFromDraft({ ...draft, rate: '' }, ['aave', 'rhea']).problem, 'Enter the highest rate as a percent, like 25');
  assert.equal(permissionFromDraft({ ...draft, cushion: '1.1' }, ['aave', 'rhea']).problem, 'The smallest cushion must be between 1.20 and 5.00.');
  assert.equal(permissionFromDraft(draft, RHEA).problem, 'This account has no settings for Aave, so it can’t be named.');
});

test('two permissions are the same when every term is', () => {
  assert.equal(samePermission(DEFAULT, { ...DEFAULT, lenders: ['aave', 'rhea'] }), true);
  assert.equal(samePermission(DEFAULT, { ...DEFAULT, max_rate_bp: 2_000 }), false);
  assert.equal(samePermission(DEFAULT, { ...DEFAULT, lenders: ['rhea'] }), false);
  assert.equal(samePermission(null, undefined), true);
  assert.equal(samePermission(DEFAULT, null), false);
});

test('the permission’s notes name what a lender takes from this account: bitcoin, or bitcoin or ether once its settings let Rhea take test ETH (INTERFACES.md 51.1)', () => {
  const before = permissionTerms(DEFAULT);
  assert.match(before[0]!.note, /A lender looks only at the bitcoin posted with it\.$/);
  assert.match(before[1]!.note, /^At 1\.00 a lender sells the bitcoin posted with it\..* so bitcoin could fall /);
  const since = permissionTerms(DEFAULT, 'bitcoin or ether');
  assert.match(since[0]!.note, /A lender looks only at the bitcoin or ether posted with it\.$/);
  assert.match(since[1]!.note, /^At 1\.00 a lender sells the bitcoin or ether posted with it\..* so bitcoin or ether could fall /);
  assert.match(permissionLimits('bitcoin or ether'), /your bitcoin or ether goes to a lender only as your own position there/);
  assert.equal(permissionLimits(), PERMISSION_LIMITS);
  // The word comes from the settings: the factory's for a new account.
  const NBTC = 'mnbtc.pbf-ops.testnet';
  const ETH = 'meth.pbf-ops.testnet';
  const tokens = [{ id: NBTC, symbol: 'nBTC', decimals: 8 }, { id: ETH, symbol: 'ETH', decimals: 18 }];
  assert.equal(settingsPostedWord({ tokens, lenders: { rhea: { collateral: [NBTC, ETH] } } }), 'bitcoin or ether');
  assert.equal(settingsPostedWord({ tokens, lenders: { rhea: { collateral: [NBTC] } } }), 'bitcoin');
  assert.equal(settingsPostedWord(null), 'bitcoin');
});
