// The credit-check page's helpers (INTERFACES.md 18 and 22).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CreditAnswer, CreditExample, CreditResult } from './api.ts';
import { checkSteps, creditRequest, creditView, exampleRows, exampleWords, formatPrice, lineWords } from './credit.ts';

const EXAMPLE: CreditExample = {
  book: { usdc: '35000000000', positions: [{ coin: 'BTC', usd: '-100000000000' }] },
  spot: [{ token: 'nBTC', amount: '135486300' }],
  btc_usd: '73808.2',
  price_source: "Hyperliquid mainnet's oracle price",
  read_at_ms: Date.UTC(2026, 10, 9, 12, 15),
};

/** INTERFACES.md 18's output for the worked example at full size: the Standard line of PLAN.md 6.9, Rhea's $63k. */
const RESULT: CreditResult = {
  ok: true, v: 1, mode: 'credit_check', model: 'B-0.2', params: 'p', network: 'mainnet', hl_address: null,
  book: EXAMPLE.book, spot: EXAMPLE.spot, at_ms: 0, near_blk: 276_900_000,
  verdict: {
    eq: 135_000_000_000, eq_allow: 135_000_000_000, mm: 15_616_000_000, im: 19_520_000_000, score: 700, tier: 'STANDARD',
    rate_bp: 200, rate_bp_at_60: 650, credit: { line: 94_500_000_000, binding: 'C4' },
    top: ['replay 2020-03-12 up (from 2020-03-13 02:16 UTC)', 'nBTC depeg 20%'], topup: 0,
    coins: { uncertain: [], stale: [], reduce_only: [] },
  },
  limits: { first_week: 25_000_000_000, ceiling: 250_000_000_000 },
  unlisted: [], without_unlisted: null,
  ignored: [{ what: 'spot HYPE', why: 'Hyperliquid spot tokens other than USDC are left out' }],
  prices: { BTC: 73_808_200_000, kPEPE: 9_870 },
  pi: { nBTC: { bp: 9_990, source: '1Click dry quote, no key' } },
  rhea: { contract: 'contract.main.burrow.near', blk: 223_738_912, max: 76_000_000_000, safe: 63_333_333_333, usdc_borrow_apr_bp: 1_588, usdc_volatility_bp: 9_500, tokens: [{ token: 'nBTC', value: 100_000_000_000, volatility_bp: 8_000, collateral: true }] },
  pool: { id: 'pool.pbf.testnet', util_bp: 220 },
  in: 'ab',
};

const answer = (result: CreditAnswer['result'], attestation: Partial<CreditAnswer['attestation']> = {}): CreditAnswer => ({
  input: { hl_address: null, book: EXAMPLE.book, spot: EXAMPLE.spot },
  result,
  run: { call_id: 'c1', attestation_url: 'https://testnet-api.outlayer.ai/attestations/by-call/c1', time_ms: 6_000, compute_cost: '1200' },
  program: { project_id: 'pbf-keeper.testnet/pb-risk', version_key: '5a2a2a20' },
  output_sha256: 'f00d',
  attestation: { found: true, wasm_hash: '5a2a2a20', output_hash: 'f00d', input_hash: 'ab', timestamp: 1, wasm_matches: true, output_matches: true, error: null, ...attestation },
  computed_at_ms: 0,
  cached: false,
  age_s: 0,
});

test('the request: an address or the worked example, and spot rows in each mainnet token’s own units', () => {
  const address = '0x1B242C24F5E67E93D7B58C3DAD77CCC90DACD7D0';
  assert.deepEqual(creditRequest({ address: ` ${address} `, book: null, rows: [{ token: 'nBTC', amount: '1.5' }, { token: 'wNEAR', amount: '' }] }), {
    request: { hl_address: address.toLowerCase(), spot: [{ token: 'nBTC', amount: '150000000' }] },
    problems: [],
  });
  assert.deepEqual(creditRequest({ address: '', book: EXAMPLE.book, rows: [{ token: 'ETH', amount: '2' }] }).request, { book: EXAMPLE.book, spot: [{ token: 'ETH', amount: '2000000000000000000' }] });
  assert.deepEqual(creditRequest({ address: '', book: null, rows: [] }).problems, ['Paste a Hyperliquid address, or use the worked example']);
  assert.deepEqual(creditRequest({ address: '0x12', book: null, rows: [] }).problems, ['A Hyperliquid address is 0x and 40 hex characters']);
  const bad = creditRequest({ address, book: null, rows: [{ token: 'USDC', amount: '1.1234567' }, { token: 'nBTC', amount: '1' }, { token: 'nBTC', amount: '2' }, { token: 'USDT', amount: '0' }] });
  assert.equal(bad.request, null);
  assert.deepEqual(bad.problems, ['USDC: At most 6 decimal places', 'nBTC is listed twice: put it in one row', 'The USDt amount must be above 0']);
});

test('the worked example in words and as rows', () => {
  assert.deepEqual(exampleRows(EXAMPLE), [{ token: 'nBTC', amount: '1.354863' }]);
  assert.equal(
    exampleWords(EXAMPLE),
    "$35,000 of USDC margin on Hyperliquid and a $100,000 BTC short, with $100,000 of nBTC at $73,808.2 a BTC: Hyperliquid mainnet's oracle price, read at 12:15 UTC.",
  );
});

test('the result in words: our line and what sets it, the first-week limit, Rhea next to it, the risks, prices and π', () => {
  const view = creditView(answer(RESULT));
  assert.deepEqual(view.ours, {
    line: '$94,500.00', firstWeek: '$25,000.00', firstWeekBinds: true, tier: 'Standard', score: 700,
    rateNow: '2.00%', rateAt60: '6.50%', sets: "the Standard tier's cap: 70% of the collateral", util: '2.20%',
  });
  assert.deepEqual([view.rhea?.safe, view.rhea?.max, view.rhea?.usdcRate], ['$63,333.33', '$76,000.00', '15.88%']);
  assert.deepEqual(view.rhea?.rows, [{ token: 'nBTC', value: '$100,000.00', ratio: '0.80', collateral: true }]);
  assert.deepEqual(view.risks, ['The market of 2020-03-12 replayed with prices rising, from 2020-03-13 02:16 UTC', 'nBTC losing 20% against BTC']);
  assert.deepEqual(view.prices, [{ coin: 'BTC', price: '$73,808.20' }, { coin: 'kPEPE', price: '$0.00987' }]);
  assert.deepEqual(view.pi, [{ token: 'nBTC', ratio: '0.9990', source: '1Click dry quote, no key' }]);
  assert.deepEqual(view.ignored, RESULT.ignored);

  const unlisted = creditView(answer({ ...RESULT, verdict: { ...RESULT.verdict, credit: { line: 0, binding: 'UNLISTED' } }, unlisted: ['TAO'], without_unlisted: { line: 94_000_000_000, binding: 'C4', score: 700, tier: 'STANDARD', rate_bp: 200 } }));
  assert.equal(unlisted.ours?.sets, 'a position or an order in a coin outside the allow-list: no credit while it is open');
  assert.equal(unlisted.unlisted.without, "Without them the line would be $94,000.00 (Standard, score 700, 2.00% a year), set by the Standard tier's cap: 70% of the collateral.");
  assert.equal(lineWords('PRICE'), 'prices that are uncertain right now: no new credit until they settle');
  assert.equal(formatPrice(Number.NaN), '?');

  const refused = creditView(answer({ ok: false, reason: 'unknown mode credit_check' }));
  assert.deepEqual([refused.ok, refused.refusal, refused.ours], [false, 'unknown mode credit_check', null]);
});

test('how to check it yourself: the version and the output hash, and whether this page found them in the attestation', () => {
  const steps = checkSteps(answer(RESULT));
  assert.match(steps[0]!, /call c1, as pbf-keeper\.testnet\/pb-risk version 5a2a2a20: the version our factory pins/);
  assert.match(steps[1]!, /wasm_hash should be 5a2a2a20, and its output_hash f00d/);
  assert.equal(steps[2], 'This page read the attestation: the wasm hash matches and the output hash matches.');
  assert.match(checkSteps(answer(RESULT, { output_matches: false }))[2]!, /doesn't match: wasm ok, output differs/);
  assert.match(checkSteps(answer(RESULT, { found: false, error: 'OutLayer answered no attestation record yet' }))[2]!, /could not be read here \(OutLayer answered no attestation record yet\)/);
  assert.match(steps.at(-1)!, /backtest --release -- credit <file>/);
});
