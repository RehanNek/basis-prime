// The Spot page's plain part (INTERFACES.md 49.1 to 49.3): the token list and its order, amounts by each token's
// decimals, the rate and its inverse, which pairs swap on testnet and the line for the others, the wallet's call
// from a quote's `next`, and a swap's status in words. Runs with: pnpm --filter @pb/web test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ABOUT_LINE,
  aboutLines,
  accountStand,
  amountWords,
  balancesLine,
  costWords,
  defaultPair,
  estimateOut,
  fieldText,
  heldUnits,
  holdings,
  holdProblem,
  refusedWords,
  swapLabel,
  isUsdc,
  MAINNET_LINE,
  MAX_TOKENS,
  maxText,
  NO_PRICE_LINE,
  orderTokens,
  ACCOUNT_UNREAD_LINE,
  estimateText,
  NO_ACCOUNT_LINE,
  NO_TOKENS_LINE,
  NOT_OWNER_LINE,
  NOT_YOURS_LINE,
  pairLine,
  pairState,
  pricedFrom,
  priceMoved,
  priceRate,
  priceWords,
  quoteProblem,
  slotFor,
  tokenHue,
  quoteRate,
  rateWords,
  readPay,
  readQuote,
  readTokens,
  receivedUnits,
  searchTokens,
  showNumber,
  shownRate,
  shownSymbol,
  SWAP_FIGURES,
  showUnits,
  statusWords,
  swapBody,
  swapCall,
  swapCheck,
  swapCost,
  swapSettled,
  swapStage,
  swapTimeWords,
  TESTNET_LINE,
  tokenBy,
  tokensPath,
  usdValue,
  walletProblem,
  type SpotToken,
  type SwapQuote,
} from './spot.ts';
import { DEPOSIT, GAS } from './tx.ts';

const ALICE = 'alice.pbf.testnet';
const MUSDC = 'musdc.pbf-ops.testnet';
const MNBTC = 'mnbtc.pbf-ops.testnet';
const METH = 'eth.pbf-ops.testnet';
const DEPOSIT_ADDRESS = '9f3c0d5e7a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5';
const EXP = 1_794_500_000_000;
/** The clock the calls are built at: ten minutes before the quote expires. */
const NOW = EXP - 10 * 60_000;

/** GET /api/spot/tokens as INTERFACES.md 49.3 writes it: dearest market first. */
const ANSWER = {
  read_at_ms: 1_794_499_000_000,
  tokens: [
    { symbol: 'BTC', name: 'Bitcoin', price_usd: 97_412.5, on_intents: true, intents_asset: 'nep141:nbtc.bridge.near', token_id: MNBTC, decimals: 8, swaps_here: true, lendable: true },
    { symbol: 'ETH', name: 'Ethereum', price_usd: 3_150.25, on_intents: true, intents_asset: 'nep141:eth.bridge.near', token_id: METH, decimals: 18, swaps_here: true, lendable: true },
    { symbol: 'SOL', name: 'Solana', price_usd: 182.4, on_intents: true, intents_asset: 'nep141:sol.omft.near', token_id: null, decimals: 9, swaps_here: false, lendable: false },
    { symbol: 'DOGE', name: 'Dogecoin', price_usd: '0.1525', on_intents: true, intents_asset: 'nep141:doge.omft.near', token_id: null, decimals: 8, swaps_here: false, lendable: false },
    { symbol: 'USDC', name: 'USD Coin', price_usd: 1, on_intents: true, intents_asset: 'nep141:usdc.near', token_id: MUSDC, decimals: 6, swaps_here: true, lendable: true },
    { symbol: 'USDT', name: 'Tether', price_usd: 1.0004, on_intents: true, intents_asset: 'nep141:usdt.tether-token.near', token_id: null, decimals: 6, swaps_here: false, lendable: false },
  ],
};
const TOKENS = readTokens(ANSWER);
const [BTC, ETH, SOL, DOGE, USDC, USDT] = TOKENS as [SpotToken, SpotToken, SpotToken, SpotToken, SpotToken, SpotToken];

/** $500 of USDC and 0.0155 BTC, as GET /api/account lists them. */
const BALANCES = [
  { token: MUSDC, amount: '500000000' },
  { token: MNBTC, amount: '1550000' },
];

/** A committed quote: 0.001 BTC sold for $97.31 of USDC. */
const sale = (over: Record<string, unknown> = {}, quote: Record<string, unknown> = {}) =>
  readQuote({
    correlationId: 'c1',
    quote: {
      depositAddress: DEPOSIT_ADDRESS,
      amountIn: '100000',
      amountInFormatted: '0.001',
      amountOut: '97310000',
      amountOutFormatted: '97.31',
      minAmountOut: '96340000',
      amountInUsd: '97.41',
      amountOutUsd: '97.31',
      deadline: new Date(EXP).toISOString(),
      timeEstimate: 20,
      ...quote,
    },
    swap: {
      from: MNBTC,
      to: MUSDC,
      next: { method: 'withdraw', args: { token: MNBTC, amount: '100000', receiver: DEPOSIT_ADDRESS, transfer: { kind: 'sell', exp: EXP, expect: { token: MUSDC, amount: '97310000' } } } },
      transfer_id: 'move:7',
      needs_check: null,
      ...over,
    },
  })!;

/** A committed quote: $100 of USDC paid for 0.00102549 BTC. */
const purchase = (over: Record<string, unknown> = {}) =>
  readQuote({
    correlationId: 'c2',
    quote: { depositAddress: DEPOSIT_ADDRESS, amountIn: '100000000', amountOut: '102549', minAmountOut: '101523', amountInUsd: '100.00', amountOutUsd: '99.89', deadline: new Date(EXP).toISOString(), timeEstimate: 20 },
    swap: { from: MUSDC, to: MNBTC, next: { method: 'withdraw', args: { token: MUSDC, amount: '100000000', receiver: DEPOSIT_ADDRESS } }, needs_check: null, ...over },
  })!;

// ---------- the words ----------

test('under the title: what the page is, and on testnet that our stand-in carries the swap at Intents’ real prices', () => {
  assert.equal(ABOUT_LINE, 'Swap tokens inside your account. Prices come from NEAR Intents.');
  assert.deepEqual(aboutLines('testnet'), [ABOUT_LINE, 'On testnet our own stand-in carries the swap, at Intents’ real prices.']);
  assert.equal(TESTNET_LINE, aboutLines('testnet')[1]);
  assert.deepEqual(aboutLines('mainnet'), [ABOUT_LINE]);
});

// ---------- the token list ----------

test('the token list is read as INTERFACES.md 49.3 writes it, in the backend’s order, with a price sent as text read as a number', () => {
  assert.deepEqual(TOKENS.map((t) => t.symbol), ['BTC', 'ETH', 'SOL', 'DOGE', 'USDC', 'USDT']);
  assert.deepEqual(BTC, { symbol: 'BTC', name: 'Bitcoin', price_usd: 97_412.5, on_intents: true, intents_asset: 'nep141:nbtc.bridge.near', token_id: MNBTC, decimals: 8, swaps_here: true, lendable: true });
  assert.equal(DOGE.price_usd, 0.1525);
  assert.equal(SOL.token_id, null);
  assert.equal(SOL.swaps_here, false);
});

test('the list never shows more than 25 tokens, and leaves out a row it couldn’t name or count', () => {
  const many = { tokens: Array.from({ length: 40 }, (_, i) => ({ symbol: `T${i}`, name: `Token ${i}`, price_usd: 1, decimals: 6, swaps_here: false, lendable: false })) };
  assert.equal(MAX_TOKENS, 25);
  assert.equal(readTokens(many).length, 25);
  assert.equal(readTokens(many)[24]!.symbol, 'T24');
  const odd = { tokens: [null, 'BTC', { name: 'no symbol', decimals: 8 }, { symbol: 'X', decimals: 6.5 }, { symbol: 'Y' }, { symbol: 'btc', decimals: 8 }, { symbol: 'BTC', decimals: 8 }, { symbol: ' OK ', decimals: 6 }] };
  assert.deepEqual(readTokens(odd).map((t) => t.symbol), ['btc', 'OK']);
});

test('a row with no name, no price or no flags still shows: named by its symbol, with no price, as not swapping here', () => {
  const [bare] = readTokens({ tokens: [{ symbol: 'ARB', decimals: 18 }] });
  assert.deepEqual(bare, { symbol: 'ARB', name: 'ARB', price_usd: null, on_intents: true, intents_asset: null, token_id: null, decimals: 18, swaps_here: false, lendable: false });
  for (const price of [0, -1, 'abc', '', null, Number.NaN]) assert.equal(readTokens({ tokens: [{ symbol: 'ARB', decimals: 18, price_usd: price }] })[0]!.price_usd, null);
});

test('a token that says it swaps here but names no id on NEAR counts as not swapping here: no quote could name it', () => {
  const [token] = readTokens({ tokens: [{ symbol: 'SOL', decimals: 9, token_id: null, swaps_here: true }] });
  assert.equal(token!.swaps_here, false);
});

test('an answer that isn’t the list (the route isn’t live yet) reads as no tokens', () => {
  for (const answer of [undefined, null, {}, { tokens: 'soon' }, { error: 'not_found' }, 'Not found']) assert.deepEqual(readTokens(answer), []);
});

test('the list is asked with the account once the page may read it, and without one for a visitor', () => {
  assert.equal(tokensPath(ALICE), '/api/spot/tokens?account=alice.pbf.testnet');
  assert.equal(tokensPath(null), '/api/spot/tokens');
  assert.equal(tokensPath(), '/api/spot/tokens');
});

test('nBTC shows as BTC and wNEAR as NEAR; every other name shows as it is', () => {
  assert.equal(shownSymbol('nBTC'), 'BTC');
  assert.equal(shownSymbol('wNEAR'), 'NEAR');
  assert.equal(shownSymbol('ETH'), 'ETH');
  assert.equal(isUsdc(USDC), true);
  assert.equal(isUsdc(USDT), false);
});

test('a token is found by its symbol whatever the case', () => {
  assert.equal(tokenBy(TOKENS, 'btc'), BTC);
  assert.equal(tokenBy(TOKENS, 'XRP'), null);
  assert.equal(tokenBy(TOKENS, null), null);
});

test('the box opens paying USDC and receiving bitcoin; without them, with the first two tokens that swap here', () => {
  assert.deepEqual(defaultPair(TOKENS), { pay: 'USDC', receive: 'BTC' });
  assert.deepEqual(defaultPair([ETH, SOL, BTC]), { pay: 'ETH', receive: 'BTC' });
  assert.deepEqual(defaultPair([SOL, ETH, DOGE]), { pay: 'ETH', receive: 'SOL' });
  assert.deepEqual(defaultPair([USDC, SOL, ETH]), { pay: 'USDC', receive: 'ETH' });
  assert.deepEqual(defaultPair([SOL]), { pay: 'SOL', receive: null });
  assert.deepEqual(defaultPair([]), { pay: null, receive: null });
});

// ---------- balances, order and search ----------

test('what the account holds of a token comes from its balances, by the token’s id; a visitor’s is unknown', () => {
  assert.equal(heldUnits(USDC, BALANCES), 500_000_000n);
  assert.equal(heldUnits(BTC, BALANCES), 1_550_000n);
  assert.equal(heldUnits(ETH, BALANCES), null);
  assert.equal(heldUnits(SOL, BALANCES), null);
  assert.equal(heldUnits(USDC, undefined), null);
  assert.equal(heldUnits(USDC, [{ token: MUSDC, amount: null }]), null);
});

test('a balance the token’s own row carries is used when the account’s balances don’t list the token', () => {
  const [eth] = readTokens({ tokens: [{ ...ANSWER.tokens[1], balance: '20000000000000000' }] });
  assert.equal(heldUnits(eth!, BALANCES), 20_000_000_000_000_000n);
  assert.equal(heldUnits(eth!, [...BALANCES, { token: METH, amount: '5' }]), 5n);
  assert.equal(readTokens({ tokens: [{ ...ANSWER.tokens[1], balance: '0.02' }] })[0]!.balance, undefined);
});

test('an amount’s dollar value is its whole tokens times the token’s price', () => {
  assert.equal(usdValue('1550000', BTC), 0.0155 * 97_412.5);
  assert.equal(usdValue(500_000_000n, USDC), 500);
  assert.equal(usdValue('1', { ...BTC, price_usd: null }), null);
});

test('the picker lists the tokens the account holds first, the most dollars first, then the rest in the backend’s order', () => {
  const rows = orderTokens(TOKENS, BALANCES);
  assert.deepEqual(rows.map((r) => r.token.symbol), ['BTC', 'USDC', 'ETH', 'SOL', 'DOGE', 'USDT']);
  assert.equal(rows[0]!.held, 1_550_000n);
  assert.ok(Math.abs(rows[0]!.usd! - 1_509.89) < 0.01);
  assert.equal(rows[1]!.usd, 500);
  assert.equal(rows[2]!.held, null);
  // More dollars of USDC than of bitcoin: USDC first.
  assert.deepEqual(orderTokens(TOKENS, [{ token: MUSDC, amount: '5000000000' }, { token: MNBTC, amount: '1550000' }]).slice(0, 2).map((r) => r.token.symbol), ['USDC', 'BTC']);
});

test('a token held with nothing in it, and every token for a visitor, keeps the backend’s order', () => {
  assert.deepEqual(orderTokens(TOKENS, [{ token: MUSDC, amount: '0' }]).map((r) => r.token.symbol), ['BTC', 'ETH', 'SOL', 'DOGE', 'USDC', 'USDT']);
  assert.deepEqual(orderTokens(TOKENS, undefined).map((r) => r.token.symbol), ['BTC', 'ETH', 'SOL', 'DOGE', 'USDC', 'USDT']);
  assert.ok(orderTokens(TOKENS, undefined).every((r) => r.held === null && r.usd === null));
});

test('a held token with no price sorts after the held ones that have one', () => {
  const noPrice = TOKENS.map((t) => (t.symbol === 'BTC' ? { ...t, price_usd: null } : t));
  assert.deepEqual(orderTokens(noPrice, BALANCES).slice(0, 2).map((r) => r.token.symbol), ['USDC', 'BTC']);
});

test('the balances under the box: the tokens held, with their dollar total', () => {
  const { rows, total } = holdings(orderTokens(TOKENS, BALANCES));
  assert.deepEqual(rows.map((r) => r.token.symbol), ['BTC', 'USDC']);
  assert.ok(Math.abs(total - 2_009.89) < 0.01);
  assert.deepEqual(holdings(orderTokens(TOKENS, undefined)), { rows: [], total: 0 });
});

test('the search finds a token by its symbol or its name, whatever the case, the closest symbol first', () => {
  const rows = orderTokens(TOKENS, undefined);
  const found = (q: string) => searchTokens(rows, q).map((r) => r.token.symbol);
  assert.deepEqual(found(''), ['BTC', 'ETH', 'SOL', 'DOGE', 'USDC', 'USDT']);
  assert.deepEqual(found('  '), ['BTC', 'ETH', 'SOL', 'DOGE', 'USDC', 'USDT']);
  assert.deepEqual(found('usd'), ['USDC', 'USDT']);
  assert.deepEqual(found('BITCOIN'), ['BTC']);
  assert.deepEqual(found('sol'), ['SOL']);
  // "et": ETH starts with it, then Tether's name holds it.
  assert.deepEqual(found('et'), ['ETH', 'USDT']);
  // "t": no symbol starts with it; BTC, ETH and USDT hold it, then Tether... is USDT already, and "Bitcoin" is BTC's.
  assert.deepEqual(found('t'), ['BTC', 'ETH', 'USDT']);
  assert.deepEqual(found('xrp'), []);
});

test('the search finds nBTC by "btc", the name it shows under', () => {
  const rows = orderTokens(readTokens({ tokens: [{ symbol: 'ETH', decimals: 18 }, { symbol: 'nBTC', name: 'Bridged bitcoin', decimals: 8 }] }), undefined);
  assert.deepEqual(searchTokens(rows, 'btc').map((r) => r.token.symbol), ['nBTC']);
});

// ---------- amounts ----------

test('an amount typed is read with the token’s own decimals: 6 for USDC, 8 for bitcoin, 18 for ETH', () => {
  assert.deepEqual(readPay('100', USDC, null), { units: '100000000', problem: null, over: false });
  assert.deepEqual(readPay('0.001', BTC, null), { units: '100000', problem: null, over: false });
  assert.deepEqual(readPay('0.02', ETH, null), { units: '20000000000000000', problem: null, over: false });
  assert.deepEqual(readPay('1,250.5', USDC, null), { units: '1250500000', problem: null, over: false });
});

test('nothing typed, zero, or no token is no amount and no complaint; text that isn’t a number says so', () => {
  assert.deepEqual(readPay('', USDC, null), { units: null, problem: null, over: false });
  assert.deepEqual(readPay('  ', USDC, null), { units: null, problem: null, over: false });
  assert.deepEqual(readPay('0', USDC, null), { units: null, problem: null, over: false });
  assert.deepEqual(readPay('0.', USDC, null), { units: null, problem: null, over: false });
  assert.deepEqual(readPay('5', null, null), { units: null, problem: null, over: false });
  assert.deepEqual(readPay('abc', USDC, null), { units: null, problem: 'Enter an amount, like 100 or 0.5', over: false });
  assert.deepEqual(readPay('-5', USDC, null), { units: null, problem: 'Enter an amount, like 100 or 0.5', over: false });
  assert.deepEqual(readPay('1.0000001', USDC, null), { units: null, problem: 'At most 6 decimal places', over: false });
});

test('more than the account holds is marked, and still priced; all of it is not too much; a visitor has no limit', () => {
  assert.deepEqual(readPay('500.000001', USDC, 500_000_000n), { units: '500000001', problem: null, over: true });
  assert.deepEqual(readPay('500', USDC, 500_000_000n), { units: '500000000', problem: null, over: false });
  assert.deepEqual(readPay('1', USDC, 0n), { units: '1000000', problem: null, over: true });
  assert.deepEqual(readPay('1000000', USDC, null), { units: '1000000000000', problem: null, over: false });
});

test('Max fills in all the account holds, exactly, and what it fills in reads back as the same units', () => {
  assert.equal(maxText(1_550_000n, BTC), '0.0155');
  assert.equal(maxText(500_000_000n, USDC), '500');
  assert.equal(maxText(20_000_000_000_000_001n, ETH), '0.020000000000000001');
  for (const [held, token] of [[1_550_000n, BTC], [499_999_999n, USDC], [20_000_000_000_000_001n, ETH]] as const) {
    assert.deepEqual(readPay(maxText(held, token), token, held), { units: held.toString(), problem: null, over: false });
  }
});

test('units become text for the amount field without grouping, cut and never rounded up', () => {
  assert.equal(fieldText('97310000', 6), '97.31');
  assert.equal(fieldText('102549', 8), '0.00102549');
  assert.equal(fieldText('19999999999999999', 18, 8), '0.01999999');
  assert.equal(fieldText('1999999', 6, 2), '1.99');
  assert.equal(fieldText('5000000', 6, 2), '5');
  assert.equal(fieldText('1234567890', 6, 0), '1234');
});

test('amounts read with grouping and about six figures, never fewer than two decimals', () => {
  assert.equal(showUnits('97412500000', 6), '97,412.5');
  assert.equal(showUnits('97412567891', 6), '97,412.56');
  assert.equal(showUnits('10265', 8), '0.00010265');
  assert.equal(showUnits('102549', 8), '0.00102549');
  // 0.0317460317…: cut after six figures (0.0317460), and the closing zero isn't written.
  assert.equal(showUnits('31746031746031746', 18), '0.031746');
  assert.equal(showUnits('31746931746031746', 18), '0.0317469');
  assert.equal(showUnits('1234567890123456789', 18), '1.23456');
  assert.equal(showUnits('0', 6), '0');
  assert.equal(amountWords('100000', BTC), '0.001 BTC');
  assert.equal(amountWords('97310000', USDC), '97.31 USDC');
  assert.equal(amountWords('100000', { ...BTC, symbol: 'nBTC' }), '0.001 BTC');
});

test('a plain number reads with grouping and about six figures', () => {
  assert.equal(showNumber(97_412.5), '97,412.5');
  assert.equal(showNumber(97_412.567), '97,412.57');
  assert.equal(showNumber(30.9221), '30.9221');
  assert.equal(showNumber(1.0004), '1.0004');
  assert.equal(showNumber(0.0000102657), '0.0000102657');
  assert.equal(showNumber(0), '0');
  assert.equal(showNumber(Number.NaN), '?');
});

test('a price reads as dollars and cents, and one under a dollar with about four figures', () => {
  assert.equal(priceWords(97_412.5), '$97,412.50');
  assert.equal(priceWords(1), '$1.00');
  assert.equal(priceWords(0.1525), '$0.1525');
  assert.equal(priceWords(0.000012345), '$0.00001235');
  assert.equal(priceWords(null), 'no price');
});

test('an estimate becomes text the amount field reads back: at most 8 decimals, and no more than the token has', () => {
  assert.equal(estimateText(0.115800333, 18), '0.11580033');
  assert.equal(estimateText(364.8, 6), '364.8');
  assert.equal(estimateText(97_412.5678919, 6), '97412.567892');
  assert.equal(estimateText(2, 8), '2');
  assert.equal(estimateText(0.0000000001, 8), '');
  assert.equal(estimateText(0, 8), '');
  assert.equal(estimateText(Number.NaN, 8), '');
  for (const [amount, token] of [[0.115800333, ETH], [364.8, USDC], [0.00102549, BTC]] as const) assert.equal(readPay(estimateText(amount, token.decimals), token, null).problem, null);
});

test('a token’s round mark has the same colour every time, nBTC has bitcoin’s, and the five that swap here read apart', () => {
  assert.equal(tokenHue('BTC'), tokenHue('BTC'));
  assert.equal(tokenHue('nBTC'), tokenHue('BTC'));
  assert.equal(tokenHue('wNEAR'), tokenHue('NEAR'));
  assert.equal(tokenHue('btc'), tokenHue('BTC'));
  for (const symbol of [...TOKENS.map((t) => t.symbol), 'XRP', 'PEPE', 'A', '']) assert.ok(Number.isInteger(tokenHue(symbol)) && tokenHue(symbol) >= 0 && tokenHue(symbol) < 360);
  assert.equal(new Set(['BTC', 'ETH', 'USDC', 'USDT', 'NEAR'].map(tokenHue)).size, 5);
});

test('the rate first shows the dearer token’s price in the other, whichever is paid, and turns round when pressed', () => {
  const selling = quoteRate('100000', '97310000', BTC, USDC)!;
  const buying = quoteRate('100000000', '102549', USDC, BTC)!;
  assert.equal(shownRate(selling, BTC, USDC), '1 BTC = 97,310 USDC');
  assert.equal(shownRate(buying, USDC, BTC), '1 BTC = 97,514.36 USDC');
  assert.equal(shownRate(selling, BTC, USDC, true), '1 USDC = 0.0000102764 BTC');
  assert.equal(shownRate(buying, USDC, BTC, true), '1 USDC = 0.0000102549 BTC');
});

test('an amount that is swapped reads with eight figures, in the box and in "You received" alike', () => {
  assert.equal(SWAP_FIGURES, 8);
  assert.equal(amountWords('31711760000000000', ETH, SWAP_FIGURES), '0.03171176 ETH');
  assert.equal(amountWords('31711760000000000', ETH), '0.0317117 ETH');
  assert.equal(showUnits('31711760000000000', 18, SWAP_FIGURES), '0.03171176');
});

// ---------- the rate ----------

test('a quote’s rate is what arrives over what leaves, each by its own decimals, with its inverse', () => {
  // 0.001 BTC for 97.31 USDC.
  const rate = quoteRate('100000', '97310000', BTC, USDC)!;
  assert.ok(Math.abs(rate.rate - 97_310) < 1e-6);
  assert.ok(Math.abs(rate.inverse - 1 / 97_310) < 1e-12);
  assert.equal(rateWords(rate, BTC, USDC), '1 BTC = 97,310 USDC');
  assert.equal(rateWords(rate, BTC, USDC, true), '1 USDC = 0.0000102764 BTC');
  // 0.02 ETH (18 decimals) for 0.00064 BTC (8 decimals).
  const cross = quoteRate('20000000000000000', '64000', ETH, BTC)!;
  assert.ok(Math.abs(cross.rate - 0.032) < 1e-12);
  assert.equal(rateWords(cross, ETH, BTC), '1 ETH = 0.032 BTC');
  assert.equal(rateWords(cross, ETH, BTC, true), '1 BTC = 31.25 ETH');
});

test('a quote with nothing leaving, nothing arriving, or amounts that aren’t whole numbers gives no rate', () => {
  assert.equal(quoteRate('0', '97310000', BTC, USDC), null);
  assert.equal(quoteRate('100000', '0', BTC, USDC), null);
  assert.equal(quoteRate('0.001', '97.31', BTC, USDC), null);
});

test('with no quote, the rate is the two tokens’ own prices: for a visitor, and for a pair that can’t swap here', () => {
  const rate = priceRate(SOL, USDC)!;
  assert.equal(rate.rate, 182.4);
  assert.equal(rateWords(rate, SOL, USDC), '1 SOL = 182.4 USDC');
  assert.equal(rateWords(priceRate(BTC, ETH)!, BTC, ETH), '1 BTC = 30.9221 ETH');
  assert.equal(priceRate({ ...SOL, price_usd: null }, USDC), null);
  assert.equal(priceRate(SOL, { ...USDC, price_usd: null }), null);
});

test('an estimate from the prices: what an amount would buy, and its dollars', () => {
  // 2 SOL at $182.40 is $364.80, which at $3,150.25 an ETH is about 0.1158 ETH.
  const estimate = estimateOut('2000000000', SOL, ETH)!;
  assert.ok(Math.abs(estimate.usd - 364.8) < 1e-9);
  assert.ok(Math.abs(estimate.amount - 364.8 / 3_150.25) < 1e-12);
  assert.equal(estimateOut('2000000000', { ...SOL, price_usd: null }, ETH), null);
  assert.equal(estimateOut('2.5', SOL, ETH), null);
});

// ---------- whether a pair swaps here ----------

test('a pair swaps here only when both tokens do; if either doesn’t, the one line shows in place of the Swap button', () => {
  assert.equal(pairState(USDC, BTC), 'here');
  assert.equal(pairState(BTC, ETH), 'here');
  assert.equal(pairState(USDC, SOL), 'mainnet');
  assert.equal(pairState(SOL, USDC), 'mainnet');
  assert.equal(pairState(SOL, DOGE), 'mainnet');
  assert.equal(pairLine('here'), null);
  assert.equal(pairLine('mainnet'), 'This pair trades on mainnet. On testnet you see its real price.');
  assert.equal(MAINNET_LINE, pairLine('mainnet'));
});

test('the same token on both sides, or a side with no token, is no pair: the line says what to pick', () => {
  assert.equal(pairState(USDC, USDC), 'same');
  assert.equal(pairState(SOL, SOL), 'same');
  assert.equal(pairState(USDC, null), 'pick');
  assert.equal(pairState(null, null), 'pick');
  assert.equal(pairLine('same'), 'Pick two different tokens.');
  assert.equal(pairLine('pick'), 'Pick the token you pay with and the token you receive.');
});

// ---------- the quote ----------

test('the price is asked as INTERFACES.md 49.3 writes it: swap {from, to} by token id, the account, the amount in units, dry', () => {
  assert.deepEqual(swapBody({ dry: true, account: ALICE, pay: BTC, receive: USDC, units: '100000' }), { dry: true, account: ALICE, amount: '100000', swap: { from: MNBTC, to: MUSDC } });
  assert.deepEqual(swapBody({ dry: false, account: ALICE, pay: USDC, receive: ETH, units: '100000000' }), { dry: false, account: ALICE, amount: '100000000', swap: { from: MUSDC, to: METH } });
});

test('a pair with a token that has no id here is never asked for a price', () => {
  assert.equal(swapBody({ dry: true, account: ALICE, pay: USDC, receive: SOL, units: '100000000' }), null);
  assert.equal(swapBody({ dry: true, account: ALICE, pay: SOL, receive: USDC, units: '1000000000' }), null);
});

test('a quote is read: the amounts, the dollars, the time, the address, the deadline, the next call and the check', () => {
  const quote = sale({ needs_check: { withdraw: { token: MNBTC, amount: '100000' } } });
  assert.equal(quote.amountIn, '100000');
  assert.equal(quote.amountOut, '97310000');
  assert.equal(quote.minAmountOut, '96340000');
  assert.equal(quote.inUsd, 97.41);
  assert.equal(quote.outUsd, 97.31);
  assert.equal(quote.seconds, 20);
  assert.equal(quote.depositAddress, DEPOSIT_ADDRESS);
  assert.equal(quote.deadlineMs, EXP);
  assert.equal(quote.transferId, 'move:7');
  assert.equal(quote.swapsHere, true);
  assert.deepEqual(quote.needsCheck, { withdraw: { token: MNBTC, amount: '100000' } });
  assert.equal((quote.next as { method: string }).method, 'withdraw');
});

test('the next call and the check are found under `swap`, under `move` as a move’s are, or on the answer itself', () => {
  const quote = { amountIn: '100000', amountOut: '97310000', minAmountOut: '96340000', timeEstimate: 20 };
  const next = { method: 'withdraw', args: { token: MNBTC, amount: '100000', receiver: DEPOSIT_ADDRESS } };
  const check = { withdraw: { token: MNBTC, amount: '100000' } };
  for (const answer of [{ quote, swap: { next, needs_check: check } }, { quote, move: { kind: 'swap', next, needs_check: check } }, { quote, next, needs_check: check }]) {
    const read = readQuote(answer)!;
    assert.deepEqual(read.next, next);
    assert.deepEqual(read.needsCheck, check);
  }
  // `swap` may only echo the pair, with the rest under `move`.
  assert.deepEqual(readQuote({ quote, swap: { from: MNBTC, to: MUSDC }, move: { next } })!.next, next);
});

test('a dry quote has no address, no deadline and no next call; an answer with no countable quote reads as none', () => {
  const dry = readQuote({ quote: { amountIn: '100000', amountOut: '97310000', minAmountOut: '96340000', timeEstimate: 20 }, swap: { next: null } })!;
  assert.equal(dry.depositAddress, null);
  assert.equal(dry.deadlineMs, null);
  assert.equal(dry.next, null);
  assert.equal(dry.needsCheck, null);
  assert.equal(dry.inUsd, null);
  for (const answer of [undefined, null, {}, { quote: null }, { quote: { amountIn: '0.001', amountOut: '97.31' } }, { quote: { amountIn: '100000' } }, { error: 'not_found' }]) assert.equal(readQuote(answer), null);
});

test('an answer that says the pair can’t swap here is read so, whichever key says it', () => {
  const quote = { amountIn: '100000', amountOut: '97310000' };
  assert.equal(readQuote({ quote, swap: { swaps_here: false } })!.swapsHere, false);
  assert.equal(readQuote({ quote, swaps_here: false })!.swapsHere, false);
  assert.equal(readQuote({ quote })!.swapsHere, true);
});

test('the cost is the dollars that leave less the dollars that arrive, with its share; the time is the quote’s own', () => {
  const cost = swapCost(sale())!;
  assert.ok(Math.abs(cost.cost - 0.1) < 1e-9);
  assert.ok(Math.abs(cost.share - 0.1 / 97.41) < 1e-12);
  assert.equal(costWords(sale()), '$0.10 (0.10%)');
  assert.equal(costWords(purchase()), '$0.11 (0.11%)');
  // More arrives than leaves by the quote's rounding: no negative cost.
  assert.equal(costWords({ inUsd: 10, outUsd: 10.01 }), '$0.00 (0.00%)');
  assert.equal(swapCost({ inUsd: null, outUsd: 97.31 }), null);
  assert.equal(costWords({ inUsd: null, outUsd: null }), 'not given by this quote');
  assert.equal(swapTimeWords(sale()), 'About 20 seconds');
  assert.equal(swapTimeWords({ seconds: 180 }), 'About 3 minutes');
  assert.equal(swapTimeWords({ seconds: null }), 'A few minutes');
});

test('a price route that isn’t there yet, or a backend that is down, gets one calm line', () => {
  for (const error of [
    { status: 404, code: 'not_found', message: 'No such route' },
    { status: 404, code: 'http_error', message: 'The backend answered HTTP 404' },
    { status: 500, code: 'backend_down', message: 'The backend is not running: start it with pnpm --filter @pb/api start' },
    { status: 502, code: 'oneclick', message: '1Click did not answer' },
    { status: 0, code: 'offline', message: 'The page could not reach its server.' },
  ]) {
    assert.deepEqual(quoteProblem(error), { kind: 'quiet', line: NO_PRICE_LINE });
  }
  assert.equal(NO_PRICE_LINE, 'The live price isn’t answering right now. The page keeps trying.');
});

test('a refusal that says the stand-in can’t carry the pair gets the mainnet line; any other is the backend’s own sentence', () => {
  assert.deepEqual(quoteProblem({ status: 400, code: 'not_here', message: 'ETH on NEAR to ETH on Base is one asset on two networks' }), { kind: 'mainnet', line: MAINNET_LINE });
  assert.deepEqual(quoteProblem({ status: 400, code: 'bad_request', message: 'This pair trades on mainnet only' }), { kind: 'mainnet', line: MAINNET_LINE });
  assert.deepEqual(quoteProblem({ status: 409, code: 'too_small', message: 'The least 1Click swaps is $1' }), { kind: 'said', line: 'The least 1Click swaps is $1' });
  assert.deepEqual(quoteProblem({ status: 403, code: 'not_yours', message: 'This account belongs to another wallet' }), { kind: 'said', line: 'This account belongs to another wallet' });
});

test('the price route’s answer as the box takes it: a quote, a quote for a pair that can’t swap here, or the refusal', () => {
  const quote = { amountIn: '100000', amountOut: '97310000' };
  const good = pricedFrom({ ok: true, answer: { quote } });
  assert.equal(good.problem, null);
  assert.equal(good.quote!.amountOut, '97310000');
  // The real price still shows, with the mainnet line.
  const elsewhere = pricedFrom({ ok: true, answer: { quote, swap: { swaps_here: false } } });
  assert.equal(elsewhere.quote!.amountOut, '97310000');
  assert.deepEqual(elsewhere.problem, { kind: 'mainnet', line: MAINNET_LINE });
  assert.deepEqual(pricedFrom({ ok: true, answer: { message: 'soon' } }), { quote: null, problem: { kind: 'quiet', line: NO_PRICE_LINE } });
  assert.deepEqual(pricedFrom({ ok: false, status: 404, code: 'not_found', message: 'No such route' }), { quote: null, problem: { kind: 'quiet', line: NO_PRICE_LINE } });
  assert.deepEqual(pricedFrom({ ok: false, status: 400, code: 'not_here', message: 'One asset on two networks' }), { quote: null, problem: { kind: 'mainnet', line: MAINNET_LINE } });
});

// ---------- what stands under the box ----------

/** A confirmed wallet on its own account, 100 USDC typed with $500 held, and a price for it: the Swap button, ready. */
const READY: Parameters<typeof slotFor>[0] = {
  tokens: 6,
  listFailed: false,
  pair: 'here',
  wallet: 'connected',
  session: 'ready',
  account: 'ready',
  amount: { units: '100000000', problem: null, over: false },
  pay: USDC,
  held: 500_000_000n,
  asking: false,
  priced: { quote: purchase(), problem: null },
};

test('a confirmed wallet, its own account, an amount it holds and a price for it: the Swap button can be pressed', () => {
  assert.deepEqual(slotFor(READY), { kind: 'swap', ready: true, hint: null });
  // With privacy off there is nothing to confirm.
  assert.deepEqual(slotFor({ ...READY, session: 'off' }), { kind: 'swap', ready: true, hint: null });
});

test('a pair that can’t swap on testnet never gets a button, whoever looks: the one line stands in its place', () => {
  const line = { kind: 'line', line: 'This pair trades on mainnet. On testnet you see its real price.' };
  assert.deepEqual(slotFor({ ...READY, pair: 'mainnet' }), line);
  assert.deepEqual(slotFor({ ...READY, pair: 'mainnet', wallet: 'none', session: 'no_wallet', account: 'none' }), line);
  assert.deepEqual(slotFor({ ...READY, pair: 'mainnet', session: 'needs_sign_in' }), line);
  // Both tokens swap here, but the price route says the stand-in can't carry this pair: the same line.
  assert.deepEqual(slotFor({ ...READY, priced: { quote: null, problem: { kind: 'mainnet', line: MAINNET_LINE } } }), line);
  assert.deepEqual(slotFor({ ...READY, priced: { quote: purchase(), problem: { kind: 'mainnet', line: MAINNET_LINE } } }), line);
  assert.deepEqual(slotFor({ ...READY, pair: 'same' }), { kind: 'line', line: 'Pick two different tokens.' });
});

test('privacy level 1: no wallet gets "sign in" and an unconfirmed wallet "confirm"; neither sees a Swap button', () => {
  assert.deepEqual(slotFor({ ...READY, wallet: 'none', session: 'no_wallet', account: 'reading' }), { kind: 'sign_in' });
  // Privacy off and no wallet: still no button without a wallet.
  assert.deepEqual(slotFor({ ...READY, wallet: 'none', session: 'off', account: 'reading' }), { kind: 'sign_in' });
  assert.deepEqual(slotFor({ ...READY, session: 'needs_sign_in', account: 'reading' }), { kind: 'confirm' });
  for (const waiting of [{ wallet: 'loading' as const }, { session: 'checking' as const }, { account: 'reading' as const }]) assert.deepEqual(slotFor({ ...READY, ...waiting }), { kind: 'wait' });
});

test('no account, another wallet’s, or not the owner: a line says so, and the first shows the way to Home', () => {
  assert.deepEqual(slotFor({ ...READY, account: 'none' }), { kind: 'line', line: NO_ACCOUNT_LINE, home: true });
  assert.deepEqual(slotFor({ ...READY, account: 'not_yours' }), { kind: 'line', line: NOT_YOURS_LINE });
  assert.deepEqual(slotFor({ ...READY, account: 'not_owner' }), { kind: 'line', line: NOT_OWNER_LINE });
  assert.deepEqual(slotFor({ ...READY, account: 'unread' }), { kind: 'line', line: ACCOUNT_UNREAD_LINE });
  assert.equal(NO_ACCOUNT_LINE, 'You have no account yet. Open one on Home, then come back to swap.');
});

test('the Swap button can’t be pressed without an amount, with more than the account holds, or without a price, and says which', () => {
  const none = { units: null, problem: null, over: false };
  assert.deepEqual(slotFor({ ...READY, amount: none, priced: null }), { kind: 'swap', ready: false, hint: 'Enter an amount to see the price.' });
  assert.deepEqual(slotFor({ ...READY, amount: { units: null, problem: 'At most 6 decimal places', over: false }, priced: null }), { kind: 'swap', ready: false, hint: 'At most 6 decimal places' });
  assert.deepEqual(slotFor({ ...READY, amount: { units: '600000000', problem: null, over: true } }), { kind: 'swap', ready: false, hint: 'You have 500 USDC in your account.' });
  assert.deepEqual(slotFor({ ...READY, asking: true, priced: null }), { kind: 'swap', ready: false, hint: 'Getting the price…' });
  assert.deepEqual(slotFor({ ...READY, priced: null }), { kind: 'swap', ready: false, hint: 'Getting the price…' });
});

test('a price route that doesn’t answer leaves the button unpressable with one calm line; a refusal shows the backend’s sentence', () => {
  assert.deepEqual(slotFor({ ...READY, priced: pricedFrom({ ok: false, status: 404, code: 'not_found', message: 'No such route' }) }), { kind: 'swap', ready: false, hint: NO_PRICE_LINE });
  assert.deepEqual(slotFor({ ...READY, priced: pricedFrom({ ok: false, status: 409, code: 'too_small', message: 'The least 1Click swaps is $1' }) }), { kind: 'swap', ready: false, hint: 'The least 1Click swaps is $1' });
});

test('where the page is with the account: another wallet’s, none, not the owner’s, ready, still reading, or not answering', () => {
  const base = { notYours: false, read: null, isOwner: false, finding: false, named: true, failed: false };
  assert.equal(accountStand({ ...base, notYours: true, read: { exists: true, hasState: true }, isOwner: true }), 'not_yours');
  assert.equal(accountStand({ ...base, read: { exists: false, hasState: false } }), 'none');
  assert.equal(accountStand({ ...base, read: { exists: true, hasState: false } }), 'none');
  assert.equal(accountStand({ ...base, read: { exists: true, hasState: true }, isOwner: true }), 'ready');
  assert.equal(accountStand({ ...base, read: { exists: true, hasState: true } }), 'not_owner');
  assert.equal(accountStand({ ...base, finding: true }), 'reading');
  assert.equal(accountStand(base), 'reading');
  assert.equal(accountStand({ ...base, named: false }), 'none');
  assert.equal(accountStand({ ...base, failed: true }), 'unread');
});

test('privacy level 1: balances show only to a confirmed wallet; everyone else gets a line that says what to do', () => {
  assert.equal(balancesLine({ wallet: false, session: 'no_wallet', account: 'none', tokens: 25 }), 'Sign in to see what your account holds.');
  assert.equal(balancesLine({ wallet: false, session: 'off', account: 'none', tokens: 25 }), 'Sign in to see what your account holds.');
  assert.equal(balancesLine({ wallet: true, session: 'needs_sign_in', account: 'reading', tokens: 25 }), 'Confirm your wallet to see what your account holds.');
  assert.equal(balancesLine({ wallet: true, session: 'ready', account: 'ready', tokens: 25 }), null);
  assert.equal(balancesLine({ wallet: true, session: 'off', account: 'ready', tokens: 25 }), null);
  assert.equal(balancesLine({ wallet: true, session: 'ready', account: 'not_owner', tokens: 25 }), null);
  assert.equal(balancesLine({ wallet: true, session: 'ready', account: 'none', tokens: 25 }), 'Nothing yet. Open your account on Home first.');
  assert.equal(balancesLine({ wallet: true, session: 'ready', account: 'not_yours', tokens: 25 }), NOT_YOURS_LINE);
  assert.equal(balancesLine({ wallet: true, session: 'ready', account: 'unread', tokens: 25 }), ACCOUNT_UNREAD_LINE);
  assert.equal(balancesLine({ wallet: true, session: 'ready', account: 'reading', tokens: 25 }), 'Reading your account…');
  // With no token list the page can't name what the account holds: it says the list is why, not that there is nothing.
  assert.equal(balancesLine({ wallet: true, session: 'ready', account: 'ready', tokens: 0 }), NO_TOKENS_LINE);
});

test('a token list that didn’t answer gets one calm line, and a placeholder while it loads', () => {
  assert.deepEqual(slotFor({ ...READY, tokens: 0, listFailed: true, pair: 'pick' }), { kind: 'line', line: NO_TOKENS_LINE });
  assert.deepEqual(slotFor({ ...READY, tokens: 0, listFailed: false, pair: 'pick' }), { kind: 'wait' });
  assert.equal(NO_TOKENS_LINE, 'The token list isn’t answering right now. The page keeps trying.');
});

// ---------- the wallet's call ----------

test('selling a token other than USDC: withdraw with the sale’s record and what should arrive, exactly as the quote’s next says', () => {
  const call = swapCall(ALICE, sale(), BTC, '100000', NOW);
  assert.equal(call.problem, null);
  assert.deepEqual(call.tx, {
    receiverId: ALICE,
    actions: [
      {
        methodName: 'withdraw',
        args: { token: MNBTC, amount: '100000', receiver: DEPOSIT_ADDRESS, transfer: { kind: 'sell', exp: EXP, expect: { token: MUSDC, amount: '97310000' } } },
        gas: GAS.accountCall,
        deposit: DEPOSIT.oneYocto,
      },
    ],
  });
  assert.deepEqual(call.transfer, { kind: 'sell', exp: EXP, expect: { token: MUSDC, amount: '97310000' } });
  assert.equal(call.check, null);
  // The swap's status is asked by the address the tokens went to.
  assert.equal(call.receiver, DEPOSIT_ADDRESS);
});

test('a sale whose quote names nothing to expect goes out with its kind and expiry alone', () => {
  const call = swapCall(ALICE, sale({ next: { method: 'withdraw', args: { token: MNBTC, amount: '100000', receiver: DEPOSIT_ADDRESS, transfer: { kind: 'sell', exp: EXP } } } }), BTC, '100000', NOW);
  assert.deepEqual(call.tx!.actions[0]!.args, { token: MNBTC, amount: '100000', receiver: DEPOSIT_ADDRESS, transfer: { kind: 'sell', exp: EXP } });
});

test('paying in USDC: a plain withdraw to the deposit address, with no transfer in it', () => {
  const call = swapCall(ALICE, purchase(), USDC, '100000000', NOW);
  assert.equal(call.problem, null);
  assert.deepEqual(call.tx, {
    receiverId: ALICE,
    actions: [{ methodName: 'withdraw', args: { token: MUSDC, amount: '100000000', receiver: DEPOSIT_ADDRESS }, gas: GAS.accountCall, deposit: DEPOSIT.oneYocto }],
  });
  assert.equal('transfer' in call.tx!.actions[0]!.args, false);
  assert.equal(call.transfer, null);
});

test('while the account owes our pool the quote names a check: a withdrawal of the call’s own token and amount', () => {
  const selling = swapCall(ALICE, sale({ needs_check: { withdraw: { token: MNBTC, amount: '100000' } } }), BTC, '100000', NOW);
  assert.deepEqual(selling.check, { withdraw: { token: MNBTC, amount: '100000' } });
  const paying = swapCall(ALICE, purchase({ needs_check: { withdraw: { token: MUSDC, amount: '100000000' } } }), USDC, '100000000', NOW);
  assert.deepEqual(paying.check, { withdraw: { token: MUSDC, amount: '100000000' } });
  // The account compares the check with its own call, so that is what the check names.
  assert.deepEqual(swapCheck(sale({ needs_check: { withdraw: { token: 'x', amount: '1' } } }), MNBTC, '100000'), { withdraw: { token: MNBTC, amount: '100000' } });
  for (const none of [null, undefined, {}, 'yes', { borrow: { amount: '1' } }, { withdraw: null }]) assert.equal(swapCheck(sale({ needs_check: none }), MNBTC, '100000'), null);
});

test('a dry quote, or one with no next call or another call, sends nothing and says so in a sentence', () => {
  const said = 'The price came back without the account’s next step. Nothing was sent. Try again for a new price.';
  for (const next of [null, undefined, 'withdraw', { method: 'hl_withdraw', args: { amount: '1', destination: '0x00' } }, { method: 'withdraw' }, { method: 'withdraw', args: { token: MNBTC, amount: '0', receiver: DEPOSIT_ADDRESS } }, { method: 'withdraw', args: { token: MNBTC, amount: '100000' } }]) {
    assert.deepEqual(swapCall(ALICE, sale({ next }), BTC, '100000', NOW), { tx: null, check: null, transfer: null, receiver: null, problem: said });
  }
});

test('a next call for another token, for more than was typed, or to another address than the quote’s own is not sent', () => {
  const next = (args: Record<string, unknown>) => ({ method: 'withdraw', args: { token: MNBTC, amount: '100000', receiver: DEPOSIT_ADDRESS, transfer: { kind: 'sell', exp: EXP }, ...args } });
  assert.equal(swapCall(ALICE, sale({ next: next({ token: MUSDC }) }), BTC, '100000', NOW).problem, 'The price is for another token than the one you are paying with. Nothing was sent. Try again for a new price.');
  assert.equal(swapCall(ALICE, sale({ next: next({ amount: '100001' }) }), BTC, '100000', NOW).problem, 'The price asks for more than you typed. Nothing was sent. Try again for a new price.');
  assert.equal(swapCall(ALICE, sale({ next: next({ receiver: 'someone.testnet' }) }), BTC, '100000', NOW).problem, 'The price names two different addresses to send to. Nothing was sent. Try again for a new price.');
  assert.equal(swapCall(ALICE, sale({ next: next({ amount: '100001' }) }), BTC, '100000', NOW).tx, null);
  // A token with no id here can never match.
  assert.equal(swapCall(ALICE, sale(), SOL, '100000', NOW).tx, null);
});

test('a sale whose next call carries no record goes out as the plain withdraw the quote names: an account that records no moves', () => {
  const plain = { method: 'withdraw', args: { token: MNBTC, amount: '100000', receiver: DEPOSIT_ADDRESS } };
  const call = swapCall(ALICE, sale({ next: plain, transfer_id: null }), BTC, '100000', NOW);
  assert.equal(call.problem, null);
  assert.deepEqual(call.tx!.actions[0]!.args, { token: MNBTC, amount: '100000', receiver: DEPOSIT_ADDRESS });
  assert.equal(call.transfer, null);
});

test('a record of any other kind, a sale’s record with no expiry, and a USDC payment with a record are not sent', () => {
  const plain = { method: 'withdraw', args: { token: MNBTC, amount: '100000', receiver: DEPOSIT_ADDRESS } };
  for (const transfer of [{ kind: 'to_hl', exp: EXP }, { kind: 'to_evm', exp: EXP }, { kind: 'sell' }, { kind: 'sell', exp: String(EXP) }, 'sell']) {
    const call = swapCall(ALICE, sale({ next: { ...plain, args: { ...plain.args, transfer } } }), BTC, '100000', NOW);
    assert.equal(call.tx, null);
    assert.equal(call.problem, 'The price’s next step isn’t the one a swap takes. Nothing was sent. Try again for a new price.');
  }
  const marked = { method: 'withdraw', args: { token: MUSDC, amount: '100000000', receiver: DEPOSIT_ADDRESS, transfer: { kind: 'sell', exp: EXP } } };
  assert.equal(swapCall(ALICE, purchase({ next: marked }), USDC, '100000000', NOW).problem, 'The price’s next step isn’t the one a swap paid in USDC takes. Nothing was sent. Try again for a new price.');
});

test('the backend’s own answer for a sale and for a USDC payment, as services/api/src/spot.ts writes them, both build', () => {
  // postSwapQuote: {...quote, swap: {from, to, account, next, transfer_id, exp_ms, delivers, needs_check, swaps_here}}.
  const figures = { amountIn: '100000', amountInFormatted: '0.001', amountOut: '97310000', amountOutFormatted: '97.31', minAmountOut: '96340000', amountInUsd: '97.41', amountOutUsd: '97.31', timeEstimate: 20, depositAddress: DEPOSIT_ADDRESS, deadline: new Date(EXP).toISOString() };
  const selling = readQuote({
    correlationId: 'c',
    timestamp: 't',
    signature: 's',
    quoteRequest: {},
    quote: figures,
    swap: {
      from: MNBTC,
      to: MUSDC,
      account: ALICE,
      next: { method: 'withdraw', args: { token: MNBTC, amount: '100000', receiver: DEPOSIT_ADDRESS, transfer: { kind: 'sell', exp: EXP, expect: { token: MUSDC, amount: '97310000' } } } },
      transfer_id: 'move:3',
      exp_ms: EXP,
      delivers: { token: MUSDC, symbol: 'USDC', amount: '97310000' },
      needs_check: { withdraw: { token: MNBTC, amount: '100000' } },
      swaps_here: true,
    },
  })!;
  const sold = swapCall(ALICE, selling, BTC, '100000', NOW);
  assert.equal(sold.problem, null);
  assert.deepEqual(sold.check, { withdraw: { token: MNBTC, amount: '100000' } });
  assert.equal(selling.transferId, 'move:3');
  const paying = readQuote({
    quote: { ...figures, amountIn: '100000000', amountOut: '102549' },
    swap: { from: MUSDC, to: MNBTC, account: ALICE, next: { method: 'withdraw', args: { token: MUSDC, amount: '100000000', receiver: DEPOSIT_ADDRESS } }, transfer_id: null, exp_ms: null, delivers: { token: MNBTC, symbol: 'nBTC', amount: '102549' }, needs_check: null, swaps_here: true },
  })!;
  const paid = swapCall(ALICE, paying, USDC, '100000000', NOW);
  assert.equal(paid.problem, null);
  assert.equal(paid.transfer, null);
  assert.equal(paid.check, null);
});

test('the backend’s two refusals of a pair, `not_here` and `same_asset`, both get the mainnet line', () => {
  assert.deepEqual(quoteProblem({ status: 400, code: 'not_here', message: 'sol.near isn’t one of this account’s tokens, so it can’t be swapped here. This pair trades on mainnet' }), { kind: 'mainnet', line: MAINNET_LINE });
  assert.deepEqual(quoteProblem({ status: 400, code: 'same_asset', message: 'Pick two different tokens' }), { kind: 'mainnet', line: MAINNET_LINE });
});

test('a price that has run out is not sent, and neither is a quote that expires more than 24 hours ahead', () => {
  assert.equal(swapCall(ALICE, sale(), BTC, '100000', EXP).problem, 'This price ran out before the swap was sent. Nothing was sent. Try again for a new price.');
  assert.equal(swapCall(ALICE, purchase(), USDC, '100000000', EXP + 1).problem, 'This price ran out before the swap was sent. Nothing was sent. Try again for a new price.');
  const far = swapCall(ALICE, sale({}, { deadline: new Date(EXP).toISOString() }), BTC, '100000', EXP - 25 * 60 * 60_000);
  assert.equal(far.tx, null);
  assert.match(far.problem!, /expires more than 24 hours from now/);
  // Just inside the day: sent.
  assert.equal(swapCall(ALICE, sale(), BTC, '100000', EXP - 24 * 60 * 60_000).problem, null);
});

test('a malformed expect is left out, as the account would refuse it; the sale still goes with its kind and expiry', () => {
  for (const expect of [null, { token: MUSDC }, { token: MUSDC, amount: '97.31' }, { amount: '97310000' }]) {
    const call = swapCall(ALICE, sale({ next: { method: 'withdraw', args: { token: MNBTC, amount: '100000', receiver: DEPOSIT_ADDRESS, transfer: { kind: 'sell', exp: EXP, expect } } } }), BTC, '100000', NOW);
    assert.deepEqual(call.transfer, { kind: 'sell', exp: EXP });
  }
});

test('a held price that delivers less than the box’s "at least" is not sent; one within it is', () => {
  // The box showed 97.31 USDC, at least 96.34.
  const shown = sale();
  assert.equal(priceMoved(shown, { amountOut: '97310000' }, USDC), null);
  assert.equal(priceMoved(shown, { amountOut: '96340000' }, USDC), null);
  assert.equal(priceMoved(shown, { amountOut: '98000000' }, USDC), null);
  assert.equal(
    priceMoved(shown, { amountOut: '96339999' }, USDC),
    'The price moved as you pressed Swap: you would now receive 96.339999 USDC, less than the 96.34 USDC the box promised. Nothing was sent. Try again for a new price.',
  );
  // A price on screen with no floor, or none at all, stops nothing.
  assert.equal(priceMoved({ minAmountOut: null }, { amountOut: '1' }, USDC), null);
  assert.equal(priceMoved(null, { amountOut: '1' }, USDC), null);
});

test('a wallet that was closed, or that failed, is said in one sentence with what to do', () => {
  assert.equal(walletProblem(new Error('User rejected the request')), 'You closed the wallet before approving, so nothing was sent: press Approve to open it again.');
  assert.equal(walletProblem(new Error('User cancelled')), 'You closed the wallet before approving, so nothing was sent: press Approve to open it again.');
  assert.equal(walletProblem(new Error('popup blocked')), 'The wallet didn’t send the swap (popup blocked), so nothing left your account: press Approve to try again.');
  assert.equal(walletProblem('timeout'), 'The wallet didn’t send the swap (timeout), so nothing left your account: press Approve to try again.');
});

test('a price that couldn’t be held when Swap was pressed is said in a sentence, with the backend’s reason when it gave one', () => {
  assert.equal(holdProblem({ status: 404, code: 'not_found', message: 'No such route' }), 'The price couldn’t be held just now. Nothing was sent. Try again for a new price.');
  assert.equal(holdProblem({ status: 0, code: 'offline', message: 'The page could not reach its server.' }), 'The price couldn’t be held just now. Nothing was sent. Try again for a new price.');
  assert.equal(holdProblem({ status: 409, code: 'transfer_overdue', message: 'A move is past its deadline: drop it on Home first' }), 'A move is past its deadline: drop it on Home first. Nothing was sent.');
  assert.equal(holdProblem({ status: 429, code: 'rate_limited', message: 'Too many prices in a minute. Wait a moment.' }), 'Too many prices in a minute. Wait a moment. Nothing was sent.');
  assert.equal(holdProblem({ status: 400, code: 'not_here', message: 'One asset on two networks' }), MAINNET_LINE);
});

test('an account that refused the call is said in its own words, without the panic prefix, and with what to do', () => {
  assert.equal(
    refusedWords('Smart contract panicked: with a loan open, a withdrawal needs a verdict for this token and amount'),
    'Your account didn’t send the tokens, so nothing was swapped. Its reason: with a loan open, a withdrawal needs a verdict for this token and amount. Try again for a new price.',
  );
  assert.equal(refusedWords('Exceeded the prepaid gas.'), 'Your account didn’t send the tokens, so nothing was swapped. Its reason: Exceeded the prepaid gas. Try again for a new price.');
});

test('the check and the approval run under the swap’s own name', () => {
  assert.equal(swapLabel('100000', BTC, USDC), 'Swap 0.001 BTC for USDC');
  assert.equal(swapLabel('100000000', USDC, { ...BTC, symbol: 'nBTC' }), 'Swap 100 USDC for BTC');
});

// ---------- following the swap ----------

test('1Click’s seven statuses map to five stages, and three of them are final', () => {
  assert.equal(swapStage('PENDING_DEPOSIT'), 'waiting');
  assert.equal(swapStage('KNOWN_DEPOSIT_TX'), 'swapping');
  assert.equal(swapStage('PROCESSING'), 'swapping');
  assert.equal(swapStage('SUCCESS'), 'received');
  assert.equal(swapStage('REFUNDED'), 'returned');
  assert.equal(swapStage('INCOMPLETE_DEPOSIT'), 'returned');
  assert.equal(swapStage('FAILED'), 'failed');
  assert.equal(swapStage(null), null);
  assert.equal(swapStage('SOMETHING_NEW'), null);
  assert.deepEqual(['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'INCOMPLETE_DEPOSIT', 'FAILED', null].map(swapSettled), [false, false, false, true, true, true, true, false]);
});

test('a swap that went through says "You received X", with the status’s own figure once it has one', () => {
  const swap = { paid: '0.001 BTC', received: '97.31 USDC', exact: true, recorded: true };
  assert.deepEqual(statusWords('SUCCESS', swap), { stage: 'received', line: 'You received 97.31 USDC. It is in your account.', tone: 'good', done: true });
  assert.equal(statusWords('SUCCESS', { ...swap, exact: false }).line, 'You received about 97.31 USDC. It is in your account.');
  assert.deepEqual(receivedUnits({ status: 'SUCCESS', swapDetails: { amountOut: '97290000' } }, sale()), { units: '97290000', exact: true });
  assert.deepEqual(receivedUnits({ status: 'SUCCESS', swapDetails: {} }, sale()), { units: '97310000', exact: false });
  assert.deepEqual(receivedUnits({ status: 'SUCCESS', swapDetails: { amountOut: '0' } }, sale()), { units: '97310000', exact: false });
  assert.deepEqual(receivedUnits(null, sale()), { units: '97310000', exact: false });
});

test('a swap on its way says where it is, and is not final', () => {
  const swap = { paid: '0.001 BTC', received: '97.31 USDC', exact: false, recorded: true };
  assert.deepEqual(statusWords('PENDING_DEPOSIT', swap), { stage: 'waiting', line: 'Your 0.001 BTC is on its way to the swap.', tone: 'neutral', done: false });
  assert.deepEqual(statusWords('PROCESSING', swap), { stage: 'swapping', line: 'Swapping your 0.001 BTC. This takes a moment.', tone: 'neutral', done: false });
  assert.deepEqual(statusWords(null, swap), { stage: null, line: 'Your 0.001 BTC left your account. Asking where the swap stands.', tone: 'neutral', done: false });
});

test('a swap that failed says in one sentence what happened and what to do', () => {
  const swap = { paid: '0.001 BTC', received: '97.31 USDC', exact: false, recorded: true };
  assert.deepEqual(statusWords('REFUNDED', swap), { stage: 'returned', line: 'The swap didn’t go through, and your 0.001 BTC came back to your account. You can swap again.', tone: 'warn', done: true });
  assert.equal(statusWords('INCOMPLETE_DEPOSIT', swap).line, 'Less than the 0.001 BTC reached the swap in time, so what came was sent back to your account. Check your balance, then swap again.');
  assert.deepEqual(statusWords('FAILED', swap), {
    stage: 'failed',
    line: 'The swap failed and your 0.001 BTC hasn’t come back. Home lists it under “Money on its way”: once its deadline has passed, drop it there.',
    tone: 'bad',
    done: true,
  });
  // Paid in USDC: the account lists nothing, so the sentence doesn't send the client to a list that is empty.
  assert.equal(
    statusWords('FAILED', { paid: '100 USDC', received: '0.00102549 BTC', exact: false, recorded: false }).line,
    'The swap failed and your 100 USDC hasn’t come back. Nothing else left your account: look at Activity for the transfer before you swap again.',
  );
});
