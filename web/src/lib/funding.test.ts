// Funding from lenders in words (INTERFACES.md 27 to 29): the credit check's funding, the borrow panel's sources and
// Home's lender cards.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CreditFunding, FundingPlanAnswer, LenderAccountAnswer, LenderPosition, LenderTerms } from './api.ts';
import {
  blendedBp,
  canUseLenders,
  CUSHION_ZONES,
  cushionExplained,
  cushionMarker,
  cushionStatus,
  cushionView,
  dollars,
  fallBp,
  formatCushion,
  fundingView,
  lenderCard,
  lenderPositions,
  moveBothWays,
  penaltyWords,
  percent,
  plainName,
  planView,
  postedWord,
  postedWords,
  rheaCollateralOf,
  splitWords,
  termsFor,
  toMicro,
  tripWords,
  wouldPostWord,
} from './funding.ts';

/** INTERFACES.md 27's example, with a Rhea entry beside it. */
const FUNDING: CreditFunding = {
  line: 94_172_000_000,
  pool_rate_bp: 650,
  target_hf_bp: 15_000,
  loan_days: 90,
  lenders: [
    {
      l: 'aave', chain: 'Ethereum', collateral: 'WBTC', rate_bp: 533, supply_bp: 410, liq_bp: 8_500, ltv_bp: 8_100, penalty_bp: 500, free: 158_900_000_000_000,
      lends: 56_503_000_000, pool: 37_669_000_000, fall_bp: 3_333, blended_bp: 580,
      move: { cost_bp: 56, cost: 560_000_000, saves: 163_000_000, source: '1Click dry quote' },
      used: true, why: 'Aave is cheaper than our pool',
    },
    {
      l: 'rhea', chain: 'NEAR', collateral: 'nBTC', rate_bp: 1_591, supply_bp: 1_032, liq_bp: 7_600, ltv_bp: 7_600, penalty_bp: 30, free: 250_000_000_000,
      lends: 50_667_000_000, pool: 43_505_000_000, fall_bp: 3_333, blended_bp: 1_156, move: null,
      used: false, why: 'Rhea costs more than our pool',
    },
  ],
  choice: 'aave',
};

const AAVE: LenderPosition = { l: 'aave', posted: 570_000_000, debt: 323_000_000, hf_bp: 15_000, liq_bp: 8_500, rate_bp: 533, supply_bp: 410, room: 180_000_000, status: 'safe' };

const account = (lenders: LenderPosition[], permission: LenderAccountAnswer['permission'] = null): LenderAccountAnswer => ({
  account: 'alice.pbf.testnet', read_at_ms: 0, permission, funding: null, verdict_blk: 1_000, lenders, pricing: null,
});

test('amounts in a sentence read to the nearest dollar from $100 up, and with cents below', () => {
  assert.equal(dollars(56_667_000_000), '$56,667');
  // The engine's own figures: $56,666.666666 and $37,833.333334 make $94,500.
  assert.equal(dollars(56_666_666_666), '$56,667');
  assert.equal(dollars(37_833_333_334), '$37,833');
  assert.equal(dollars('198410958'), '$198');
  assert.equal(dollars(12_340_000), '$12.34');
  assert.equal(dollars(56_000_000), '$56');
  assert.equal(dollars(0), '$0');
  assert.equal(toMicro('37833000000'), 37_833_000_000n);
  assert.equal(toMicro(undefined), 0n);
  assert.equal(toMicro('not a number'), 0n);
});

test('shares and cushions read as people say them, rounded down', () => {
  assert.equal(percent(3_333), '33%');
  assert.equal(percent(870), '8.7%');
  assert.equal(percent(500), '5%');
  assert.equal(percent(30), '0.3%');
  assert.equal(percent(3_334, true), '33.3%');
  assert.equal(percent(500, true), '5%');
  assert.equal(formatCushion(15_000), '1.50');
  assert.equal(formatCushion(12_400), '1.24');
});

test('the whole loan’s rate is each part’s rate weighted by its amount', () => {
  // FUNDING.md 2: $56,667 from Aave at 5.33% and $37,833 from our pool at 6.50% make 5.80%.
  assert.equal(blendedBp([{ amount: 56_667_000_000, rate_bp: 533 }, { amount: '37833000000', rate_bp: 650 }]), 580);
  assert.equal(blendedBp([{ amount: 100, rate_bp: 650 }]), 650);
  assert.equal(blendedBp([{ amount: 0, rate_bp: 650 }]), null);
  assert.equal(blendedBp([]), null);
  // A part whose rate isn't known leaves the whole loan's rate unknown, rather than wrong.
  assert.equal(blendedBp([{ amount: 100, rate_bp: 533 }, { amount: 100, rate_bp: null }]), null);
});

test('a cushion of 1.5 lets bitcoin fall a third before the lender sells', () => {
  assert.equal(fallBp(15_000), 3_333);
  assert.equal(fallBp(13_000), 2_307);
  assert.equal(fallBp(10_000), 0);
  assert.equal(fallBp(0), 0);
});

test('the cushion has three states: safe, thin under 1.35 and act under 1.2, and none with nothing owed', () => {
  assert.equal(cushionStatus(15_000, 1), 'safe');
  assert.equal(cushionStatus(13_500, 1), 'safe');
  assert.equal(cushionStatus(13_499, 1), 'thin');
  assert.equal(cushionStatus(12_000, '1'), 'thin');
  assert.equal(cushionStatus(11_999, 1), 'act');
  assert.equal(cushionStatus(0, 0), 'none');
  assert.equal(cushionStatus(15_000, '0'), 'none');
});

test('the marker moves right as the cushion thins, and stays inside its zone', () => {
  assert.ok(cushionMarker(30_000) <= 2);
  assert.ok(cushionMarker(15_000) > cushionMarker(18_000));
  assert.ok(cushionMarker(13_501) < CUSHION_ZONES.thin);
  assert.equal(cushionMarker(13_500), CUSHION_ZONES.thin - 1);
  assert.ok(cushionMarker(12_400) > CUSHION_ZONES.thin && cushionMarker(12_400) < CUSHION_ZONES.act);
  assert.ok(cushionMarker(11_200) > CUSHION_ZONES.act && cushionMarker(11_200) < 100);
  assert.ok(cushionMarker(9_000) <= 98);
});

test('a lender’s cushion in a sentence: how far bitcoin could fall before that lender would sell', () => {
  assert.deepEqual(cushionView(AAVE), { status: 'safe', label: 'Safe', tone: 'good', marker: cushionMarker(15_000), words: 'Bitcoin could fall 33% before Aave would sell.' });
  const thin = cushionView({ l: 'rhea', hf_bp: 12_400, debt: 1, status: 'thin' });
  assert.equal(thin.tone, 'warn');
  assert.equal(thin.words, 'Bitcoin could fall only 19% before Rhea would sell. That is thin, so the engine plans a top-up from your spare bitcoin or cash.');
  const act = cushionView({ l: 'aave', hf_bp: 11_200, debt: 1, status: 'act' });
  assert.equal(act.label, 'Act now');
  assert.equal(act.words, 'Bitcoin could fall only 10% before Aave would sell. Repay Aave or post more bitcoin there now.');
  assert.match(cushionView({ l: 'aave', hf_bp: 9_900, debt: 1, status: 'act' }).words, /Aave can sell now/);
  assert.deepEqual(cushionView({ l: 'aave', hf_bp: 0, debt: 0, status: 'none' }), { status: 'none', label: 'Nothing owed', tone: 'neutral', marker: null, words: 'Nothing is owed to Aave, so nothing there can be sold.' });
});

test('a status the page doesn’t know is worked out from the cushion itself', () => {
  assert.equal(cushionView({ l: 'aave', hf_bp: 12_000, debt: 5, status: 'later' as LenderPosition['status'] }).status, 'thin');
});

test('“cushion” is explained in plain words, with the engine’s target', () => {
  assert.match(cushionExplained(), /At 1\.00 the lender sells, so the engine borrows only up to a cushion of 1\.50\.$/);
  assert.match(cushionExplained(16_000), /a cushion of 1\.60\.$/);
});

test('an account gets a card only for a lender it has something at', () => {
  const empty: LenderPosition = { ...AAVE, l: 'rhea', posted: '0', debt: 0, hf_bp: 0, room: 0, status: 'none' };
  assert.deepEqual(lenderPositions(account([AAVE, empty])).map((p) => p.l), ['aave']);
  assert.deepEqual(lenderPositions(account([])), []);
  assert.deepEqual(lenderPositions(undefined), []);
});

test('today’s accounts, with no permission and no lender listed, can’t use lenders', () => {
  assert.equal(canUseLenders(account([])), false);
  assert.equal(canUseLenders(undefined), false);
  assert.equal(canUseLenders(account([AAVE])), true);
  assert.equal(canUseLenders(account([], { lenders: ['aave', 'rhea'], min_hf_bp: 15_000, max_rate_bp: 2_500, moves: 'any' })), true);
});

test('when the backend says which lenders the account’s config has, that alone decides', () => {
  assert.equal(canUseLenders({ ...account([]), config_lenders: ['rhea'] }), true);
  // An account whose config has no lenders keeps today's borrow, whatever else the answer holds.
  assert.equal(canUseLenders({ ...account([AAVE], { lenders: [], min_hf_bp: 15_000, max_rate_bp: 2_500, moves: 'any' }), config_lenders: [] }), false);
});

test('a lender card says what is posted, what is owed, the rate and the cushion', () => {
  const terms: LenderTerms = { l: 'aave', network: 'testnet', chain: 'Base Sepolia', collateral: 'WBTC', rate_bp: 533, supply_bp: 410, free: '1000000000', ltv_bp: 8_100, liq_bp: 8_500, penalty_bp: 500, source: 'Aave', stale: false };
  assert.equal(termsFor([{ ...terms, network: 'mainnet', chain: 'Ethereum' }, terms], 'aave', 'testnet'), terms);
  assert.equal(termsFor([terms], 'rhea', 'testnet'), null);
  const card = lenderCard(AAVE, terms);
  assert.equal(card.name, 'Aave');
  assert.equal(card.where, 'On Base Sepolia');
  assert.equal(card.posted, '$570.00');
  assert.equal(card.postedSub, 'Your WBTC, at today’s price');
  assert.equal(card.owed, '$323.00');
  assert.equal(card.rate, '5.33% a year');
  assert.equal(card.cushion, '1.50');
  assert.equal(card.sells, 'Aave sells once the loan passes 85% of the bitcoin’s value.');
  assert.equal(card.room, 'Aave could lend $180 more against what you hold.');
  const bare = lenderCard({ ...AAVE, room: '0' });
  assert.equal(bare.where, null);
  assert.equal(bare.room, null);
});

test('the split says what each source looks at and what it lends, in dollars', () => {
  assert.equal(
    splitWords([{ source: 'aave', amount: 56_667_000_000, rate_bp: 533 }, { source: 'pool', amount: 37_833_000_000, rate_bp: 650 }]),
    'Aave lends $56,667 against your bitcoin at 5.33%. Our pool lends the other $37,833 against your whole hedged book at 6.50%.',
  );
  assert.equal(splitWords([{ source: 'aave', amount: 0, rate_bp: 533 }, { source: 'pool', amount: '500000000', rate_bp: 650 }]), 'Our pool lends all $500 against your whole hedged book at 6.50%.');
});

test('the borrow panel lists each source, its amount and its rate, then the whole loan’s rate', () => {
  const plan: FundingPlanAnswer = {
    asked: '500000000', total: 500_000_000,
    sources: [{ source: 'aave', amount: 302_000_000, rate_bp: 533 }, { source: 'pool', amount: '198000000', rate_bp: 650 }],
    steps: [], ext: [], blended_bp: 579, verdict: { ok: true }, run: {},
  };
  assert.deepEqual(planView(plan), {
    rows: [
      { source: 'aave', name: 'Aave', amount: '$302.00', rate: '5.33%' },
      { source: 'pool', name: 'Our pool', amount: '$198.00', rate: '6.50%' },
    ],
    total: '$500.00',
    rate: '5.79%',
    words: 'Aave lends $302 against your bitcoin at 5.33%. Our pool lends the other $198 against your whole hedged book at 6.50%.',
    short: null,
  });
  // Without the backend's own figure, the page works the whole loan's rate out itself.
  assert.equal(planView({ ...plan, blended_bp: undefined })?.rate, '5.79%');
  assert.equal(planView({ ...plan, asked: 800_000_000 })?.short, 'The engine would fund $500.00 of the $800.00 asked.');
  // A source whose rate the answer didn't carry is listed with its amount alone.
  const unknown = planView({ ...plan, blended_bp: null, sources: [{ source: 'aave', amount: 302_000_000, rate_bp: null }, plan.sources![1]!] })!;
  assert.equal(unknown.rows[0]!.rate, null);
  assert.equal(unknown.rate, null);
  assert.equal(unknown.words, 'Aave lends $302 against your bitcoin. Our pool lends the other $198 against your whole hedged book at 6.50%.');
});

test('a refusal, or an engine that doesn’t know the question yet, shows nothing', () => {
  assert.equal(planView(null), null);
  assert.equal(planView({ asked: '500000000', verdict: { ok: false, reason: 'unknown intent: fund' }, run: {} }), null);
  assert.equal(planView({ ok: false, reason: 'unknown intent: fund' } as FundingPlanAnswer), null);
  assert.equal(planView({ asked: 1, total: 0, sources: [], verdict: { ok: true } }), null);
  // As the backend answers a refusal: HTTP 200, a total of 0 and nothing listed.
  assert.equal(planView({ asked: '500000000', total: 0, sources: [], steps: [], ext: [], blended_bp: null, verdict: { ok: false, reason: 'unknown variant `fund`' }, run: {} }), null);
});

test('every amount reads the same as a number or as a string of digits', () => {
  const asNumbers = planView({ asked: 500_000_000, total: 500_000_000, sources: [{ source: 'aave', amount: 302_000_000, rate_bp: 533 }, { source: 'pool', amount: 198_000_000, rate_bp: 650 }], blended_bp: null });
  const asStrings = planView({ asked: '500000000', total: '500000000', sources: [{ source: 'aave', amount: '302000000', rate_bp: 533 }, { source: 'pool', amount: '198000000', rate_bp: 650 }], blended_bp: null });
  assert.deepEqual(asStrings, asNumbers);
  assert.equal(asNumbers?.rate, '5.79%');
  const aave = FUNDING.lenders[0]!;
  const text = (n: number | string) => String(n);
  const strings = fundingView({ ...FUNDING, line: text(FUNDING.line), lenders: [{ ...aave, lends: text(aave.lends), pool: text(aave.pool), move: { ...aave.move!, cost: text(aave.move!.cost), saves: text(aave.move!.saves) } }] });
  assert.deepEqual(strings, fundingView({ ...FUNDING, lenders: [aave] }));
  assert.deepEqual(lenderCard({ ...AAVE, posted: '570000000', debt: '323000000', room: '180000000' }), lenderCard(AAVE));
});

test('a lender whose rate wasn’t read says so instead of showing a wrong one', () => {
  assert.equal(lenderCard({ ...AAVE, rate_bp: null }).rate, 'Not read yet');
});

test('the credit check says how the loan would be funded with each lender, and which one the engine would use', () => {
  const view = fundingView(FUNDING)!;
  assert.equal(view.choice, 'The engine would use Aave for the part against your bitcoin, and our pool for the rest.');
  assert.match(view.intro, /This is the \$94,172 line with each lender, with our pool at 6\.50% a year/);
  const [aave, rhea] = view.lenders;
  assert.equal(aave!.headline, 'Aave lends $56,503 against your bitcoin at 5.33%. Our pool lends the other $37,669 against your whole hedged book at 6.50%.');
  assert.equal(aave!.where, 'On Ethereum, against WBTC');
  assert.equal(aave!.used, true);
  assert.equal(aave!.why, 'Aave is cheaper than our pool');
  assert.deepEqual(aave!.rows, [
    ['The whole loan would cost', '5.80% a year'],
    ['From our pool alone it would cost', '6.50% a year'],
    ['Bitcoin can fall, before Aave would sell', '33.3%'],
    ['Aave’s penalty if it sells', '5%'],
    ['Moving the bitcoin there costs', '$560 (0.56%)'],
    ['Interest saved over 90 days', '$163'],
  ]);
  assert.equal(
    aave!.move,
    'Moving the bitcoin to Ethereum as WBTC would cost about $560 (0.56%; 1Click dry quote). Over 90 days Aave would save $163 of interest against borrowing it all from our pool, so the move costs more than it saves.',
  );
  assert.equal(rhea!.used, false);
  // A split the engine wouldn't use is said as what would happen, not as what happens.
  assert.equal(rhea!.headline, 'Rhea would lend $50,667 against your bitcoin at 15.91%. Our pool would lend the other $43,505 against your whole hedged book at 6.50%.');
  assert.equal(rhea!.move, 'Your bitcoin stays on NEAR, so there is nothing to move.');
  assert.deepEqual(rhea!.rows.slice(3), [
    ['Rhea’s penalty if it sells', '0.3%'],
    ['Moving the bitcoin', 'Not needed: it stays on NEAR'],
  ]);
});

test('a lender with no fixed penalty says so: the engine answers 0 for Rhea', () => {
  assert.equal(penaltyWords(500), '5%');
  assert.equal(penaltyWords(30), '0.3%');
  assert.equal(penaltyWords(0), 'No fixed penalty: a small discount, about 0.3% so far');
  assert.equal(penaltyWords(null), 'No fixed penalty: a small discount, about 0.3% so far');
});

test('a move that saves more than it costs pays for itself, and a missing quote is said', () => {
  const aave = FUNDING.lenders[0]!;
  const pays = fundingView({ ...FUNDING, loan_days: 365, lenders: [{ ...aave, move: { ...aave.move!, saves: 661_000_000 } }] })!;
  assert.match(pays.lenders[0]!.move, /Over 365 days Aave would save \$661 of interest .* so the move pays for itself\.$/);
  const none = fundingView({ ...FUNDING, lenders: [{ ...aave, move: null }] })!;
  assert.equal(none.lenders[0]!.move, 'No quote came for moving the bitcoin to Ethereum, so that cost isn’t counted here.');
  assert.deepEqual(none.lenders[0]!.rows.at(-1), ['Moving the bitcoin', 'No quote came, so its cost isn’t counted']);
});

// Stage 3 (INTERFACES.md 33): the engine counts the bitcoin's trip to the lender and back.
const BOTH_WAYS = { cost_bp: 49, cost: 490_000_000, back_bp: 13, back: 130_000_000, back_quoted: true, total: 620_000_000, saves: 207_000_000, source: '1Click dry quotes, no key' };

test('the move is said in dollars, there and back, against what the lender’s lower rate saves', () => {
  const aave = { ...FUNDING.lenders[0]!, used: false, move: BOTH_WAYS };
  assert.equal(tripWords(aave, 90), 'Moving the bitcoin there costs $490 and bringing it back $130. Aave’s lower rate saves $207 over 90 days, which doesn’t cover the $620.');
  // Over a year the saving beats both ways.
  assert.equal(tripWords({ ...aave, move: { ...BOTH_WAYS, saves: 839_000_000 } }, 365), 'Moving the bitcoin there costs $490 and bringing it back $130. Aave’s lower rate saves $839 over 365 days, which covers the $620.');
  // A lender that is no cheaper saves nothing.
  assert.equal(tripWords({ ...aave, move: { ...BOTH_WAYS, saves: 0 } }, 90), 'Moving the bitcoin there costs $490 and bringing it back $130. Aave’s rate is no lower than our pool’s, so the move saves nothing against the $620.');
  const view = fundingView({ ...FUNDING, choice: 'pool', lenders: [aave] })!.lenders[0]!;
  assert.equal(view.trip, tripWords(aave, 90));
  assert.deepEqual(view.rows.slice(4), [
    ['Moving the bitcoin there costs', '$490 (0.49%)'],
    ['Bringing it back costs', '$130 (0.13%)'],
    ['There and back', '$620'],
    ['Interest saved over 90 days', '$207'],
  ]);
});

test('when no quote came for the way back, it is counted as the way there, and the page says so', () => {
  const move = { ...BOTH_WAYS, back_bp: 49, back: 490_000_000, back_quoted: false, total: 980_000_000 };
  const aave = { ...FUNDING.lenders[0]!, used: false, move };
  assert.deepEqual(moveBothWays(move), { there: 490_000_000n, back: 490_000_000n, total: 980_000_000n, backQuoted: false });
  assert.equal(
    tripWords(aave, 90),
    'Moving the bitcoin there costs $490. No quote came for bringing it back, so that is counted as the same again. Aave’s lower rate saves $207 over 90 days, which doesn’t cover the $980.',
  );
  const rows = fundingView({ ...FUNDING, lenders: [aave] })!.lenders[0]!.rows;
  assert.deepEqual(rows[5], ['Bringing it back costs', '$490: no quote came, so it is counted as the way there']);
  assert.deepEqual(rows[6], ['There and back', '$980']);
});

test('an engine from before the trip back was counted still reads: the way there alone, and no trip sentence', () => {
  const old = FUNDING.lenders[0]!;
  assert.equal(moveBothWays(old.move), null);
  assert.equal(tripWords(old, 90), null);
  assert.equal(fundingView(FUNDING)!.lenders[0]!.trip, null);
  // Rhea needs no move at all.
  assert.equal(fundingView(FUNDING)!.lenders[1]!.trip, null);
});

test('what is posted with a lender is named for what it is: bitcoin, or ether on Aave’s test market', () => {
  assert.equal(postedWord([{ symbol: 'WBTC' }]), 'bitcoin');
  assert.equal(postedWord([{ symbol: 'nBTC' }]), 'bitcoin');
  assert.equal(postedWord([{ symbol: 'WETH' }]), 'ether');
  assert.equal(postedWord([{ symbol: 'WBTC' }, { symbol: 'WETH' }]), 'collateral');
  // With no reading of it, bitcoin: what the lenders took before stage 3.
  assert.equal(postedWord(undefined), 'bitcoin');
  assert.equal(postedWord([]), 'bitcoin');
  const ether: LenderPosition = { ...AAVE, held: [{ token: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, amount: '20000000000000000' }] };
  assert.equal(cushionView(ether).words, 'Ether could fall 33% before Aave would sell.');
  assert.equal(cushionView({ ...ether, hf_bp: 11_200, status: 'act' }).words, 'Ether could fall only 10% before Aave would sell. Repay Aave or post more ether there now.');
  const card = lenderCard(ether);
  assert.equal(card.postedSub, 'Your 0.02 WETH, at today’s price');
  assert.equal(card.sells, 'Aave sells once the loan passes 85% of the ether’s value.');
  assert.match(cushionExplained(15_000, 'ether'), /how many times over the ether posted with a lender covers the loan there/);
  // Rhea's nBTC by its own amount.
  assert.equal(lenderCard({ ...AAVE, l: 'rhea', held: [{ token: 'mnbtc.pbf-ops.testnet', symbol: 'nBTC', decimals: 8, amount: '600000' }] }).postedSub, 'Your 0.006 nBTC, at today’s price');
});

test('the borrow panel says what each lender looks at: what it holds, or for Aave what waits at the address', () => {
  const weth = { token: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, amount: '20000000000000000' };
  const nbtc = { token: 'mnbtc.pbf-ops.testnet', symbol: 'nBTC', decimals: 8, amount: '600000' };
  const evm = { address: '0x8c01b1a86db01769c246d3739da0bb74ae3217fb', nonce: 0, chain_nonce: 0, eth: '0', wallet: [weth, { ...weth, symbol: 'USDC', decimals: 6, amount: '5000000' }], signed: [] };
  // Nothing posted yet, test ether waiting at the address: Aave would look at ether.
  assert.deepEqual(postedWords({ ...account([]), evm }), { aave: 'ether' });
  // Posted: each lender by what it holds.
  assert.deepEqual(postedWords(account([{ ...AAVE, held: [weth] }, { ...AAVE, l: 'rhea', held: [nbtc] }])), { aave: 'ether', rhea: 'bitcoin' });
  // No reading at all: nothing is said, and the page's default is bitcoin.
  assert.deepEqual(postedWords(account([AAVE])), {});
  assert.deepEqual(postedWords(undefined), {});
});

test('one rule names what either lender holds or would take: bitcoin for nBTC, ether for ETH, at Rhea as at Aave (INTERFACES.md 51.1)', () => {
  assert.deepEqual(['nBTC', 'WBTC', 'ETH', 'WETH', 'LINK'].map(plainName), ['bitcoin', 'bitcoin', 'ether', 'ether', 'collateral']);
  // Test ETH posted at Rhea reads as ether everywhere a holding is named.
  const eth = { token: 'meth.pbf-ops.testnet', symbol: 'ETH', decimals: 18, amount: '500000000000000000' };
  const rhea: LenderPosition = { ...AAVE, l: 'rhea', liq_bp: 7_500, held: [eth] };
  assert.equal(postedWord(rhea.held), 'ether');
  const card = lenderCard(rhea);
  assert.equal(card.postedSub, 'Your 0.5 ETH, at today’s price');
  assert.equal(card.sells, 'Rhea sells once the loan passes 75% of the ether’s value.');
  assert.match(cushionView(rhea).words, /^Ether could fall/);
  assert.deepEqual(postedWords(account([rhea])), { rhea: 'ether' });
});

test('what Rhea would take comes from the account’s own list: an account from before lists bitcoin alone, and is promised nothing against its ether', () => {
  const NBTC = 'mnbtc.pbf-ops.testnet';
  const ETH = 'meth.pbf-ops.testnet';
  const tokens = [{ id: NBTC, symbol: 'nBTC' }, { id: ETH, symbol: 'ETH' }, { id: 'musdc.pbf-ops.testnet', symbol: 'USDC' }];
  const both = rheaCollateralOf({ lenders: { rhea: { contract_id: 'rhea.pbf-ops.testnet', collateral: [NBTC, ETH] } } });
  assert.deepEqual(both, [NBTC, ETH]);
  const before = rheaCollateralOf({ lenders: { rhea: { collateral: [NBTC] } } });
  // An account made since the deploy: what it holds of the list.
  assert.equal(wouldPostWord(both, tokens, (id) => id === ETH), 'ether');
  assert.equal(wouldPostWord(both, tokens, (id) => id === NBTC), 'bitcoin');
  assert.equal(wouldPostWord(both, tokens, () => true), 'bitcoin and ether');
  assert.equal(wouldPostWord(both, tokens, () => false), 'bitcoin or ether');
  // An account made before: bitcoin, whatever it holds.
  assert.equal(wouldPostWord(before, tokens, (id) => id === ETH), 'bitcoin');
  assert.equal(wouldPostWord(before, tokens, () => true), 'bitcoin');
  // No Rhea in the settings, or settings that weren't read: bitcoin, as before.
  assert.equal(rheaCollateralOf({ lenders: { aave: {} } }), null);
  assert.equal(rheaCollateralOf(null), null);
  assert.equal(rheaCollateralOf({ lenders: { rhea: { collateral: [] } } }), null);
  assert.equal(wouldPostWord(null, tokens, () => true), 'bitcoin');
  // The borrow panel: Rhea holds nothing yet, so it says what Rhea would take; once Rhea holds something, that wins.
  assert.deepEqual(postedWords(account([]), { rhea: 'ether' }), { rhea: 'ether' });
  const nbtc = { token: NBTC, symbol: 'nBTC', decimals: 8, amount: '600000' };
  assert.deepEqual(postedWords(account([{ ...AAVE, l: 'rhea', held: [nbtc] }]), { rhea: 'ether' }), { rhea: 'bitcoin' });
});

test('with our pool as the choice, and a lender that lends nothing, the words say so', () => {
  const aave = FUNDING.lenders[0]!;
  const view = fundingView({ ...FUNDING, choice: 'pool', lenders: [{ ...aave, lends: 0, pool: FUNDING.line, used: false }] })!;
  assert.equal(view.choice, 'The engine would fund this loan from our pool alone, at 6.50% a year.');
  assert.equal(view.lenders[0]!.headline, 'Aave would lend nothing against your bitcoin now, so our pool would lend all $94,172 against your whole hedged book at 6.50%.');
  // With nothing lent there, how far bitcoin can fall before that lender sells means nothing, so it isn't listed.
  assert.ok(view.lenders[0]!.rows.every(([label]) => !label.startsWith('Bitcoin can fall')));
});

test('a book that gets no line has nothing to fund, and only the engine’s reason is kept', () => {
  const aave = FUNDING.lenders[0]!;
  const view = fundingView({ ...FUNDING, line: 0, choice: 'pool', lenders: [{ ...aave, lends: 0, pool: 0, fall_bp: 0, used: false, why: 'This book gets no line.' }] })!;
  assert.equal(view.choice, 'This book gets no credit line, so there is nothing to fund.');
  assert.doesNotMatch(view.intro, /\$0/);
  assert.deepEqual(view.lenders[0]!.rows, []);
  assert.equal(view.lenders[0]!.why, 'This book gets no line.');
});

test('a result with no funding, from an older engine, shows nothing', () => {
  assert.equal(fundingView(undefined), null);
  assert.equal(fundingView(null), null);
});
