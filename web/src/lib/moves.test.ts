// The moves between NEAR and Aave's chain (INTERFACES.md 36): a quote in words, the account's next call, where a move
// stands, and a listed transfer in words. Runs with: pnpm --filter @pb/web test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MoveQuoteAnswer } from './api.ts';
import {
  ETHER_MOVES_ON,
  etherCapWords,
  etherToken,
  isSizeRefusal,
  listedEther,
  listedWords,
  MOVES,
  moveCost,
  moveQuoteBody,
  movesFor,
  moveSources,
  moveStage,
  needsCheck,
  nextRefusal,
  nextTx,
  overEtherCap,
  quoteWords,
  recallMove,
  rememberMove,
  sizeLimitWords,
  STAGE_LABEL,
  stageWords,
  statusQuery,
  timeWords,
  transferWords,
  type KnownToken,
} from './moves.ts';

const ALICE = 'alice.pbf.testnet';
const NBTC: KnownToken = { id: 'mnbtc.pbf-ops.testnet', symbol: 'nBTC', decimals: 8 };
const MUSDC: KnownToken = { id: 'musdc.pbf-ops.testnet', symbol: 'USDC', decimals: 6 };
// INTERFACES.md 24 and 33: Aave's test tokens on Base Sepolia, as the backend writes them (lower case).
const WETH: KnownToken = { id: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 };
const WBTC: KnownToken = { id: '0x54114591963cf60ef3aa63befd6ec263d98145a4', symbol: 'WBTC', decimals: 8 };
const USDC: KnownToken = { id: '0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f', symbol: 'USDC', decimals: 6 };
const TOKENS = [NBTC, MUSDC, WETH, WBTC, USDC];
const DEPOSIT = '9f3c0d5e7a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5';
const FLOAT = '0x2031181d63507368232579af4c64a1c3428407ff';
const EXP = 1_794_500_000_000;
/** The clock the next calls are built at: ten minutes before the quote expires. */
const NOW = EXP - 10 * 60_000;

/** A quote for 0.00055 nBTC to Aave's chain, where it arrives as wrapped test ETH: Aave's bitcoin pool is full. */
const bitcoinOut = (over: Partial<MoveQuoteAnswer['move']> = {}): MoveQuoteAnswer => ({
  correlationId: 'c1',
  quote: { amountIn: '55000', amountInFormatted: '0.00055', amountOut: '13860000000000000', amountOutFormatted: '0.01386', minAmountOut: '13700000000000000', amountInUsd: '41.80', amountOutUsd: '41.59', timeEstimate: 120 },
  move: { kind: 'to_evm', account: ALICE, next: null, delivers: { token: WETH.id, symbol: 'WETH', chain: 'Base Sepolia', amount: '13860000000000000' }, needs_check: null, ...over },
});

/** A quote for $23.03 of USDC home from Aave's chain. */
const loanHome = (over: Partial<MoveQuoteAnswer['move']> = {}): MoveQuoteAnswer => ({
  correlationId: 'c2',
  quote: { amountIn: '23033364', amountInFormatted: '23.033364', amountOut: '22987297', amountOutFormatted: '22.987297', minAmountOut: '22900000', amountInUsd: '23.03', amountOutUsd: '22.99', timeEstimate: 45 },
  move: { kind: 'e_home', account: ALICE, next: null, delivers: { token: MUSDC.id, symbol: 'USDC', chain: 'NEAR', amount: '22987297' }, needs_check: null, ...over },
});

test('the four moves: bitcoin and USDC go out with to_evm, the loan and the bitcoin come home with e_home; and two more with the client’s own ETH', () => {
  assert.deepEqual(
    Object.values(MOVES).map((m) => [m.title, m.move]),
    [
      ['Move bitcoin to Aave’s chain', 'to_evm'],
      ['Bring the loan home', 'e_home'],
      ['Send USDC to Aave’s chain', 'to_evm'],
      ['Bring the bitcoin home', 'e_home'],
      // INTERFACES.md 51.2
      ['Move ETH to Aave’s chain', 'to_evm'],
      ['Bring the ETH home', 'e_home'],
    ],
  );
});

// ---------- INTERFACES.md 51.2: the client's own ETH ----------

const METH: KnownToken = { id: 'meth.pbf-ops.testnet', symbol: 'ETH', decimals: 18 };
const BALANCES_BEFORE = [
  { token: MUSDC.id, symbol: 'USDC', decimals: 6 },
  { token: NBTC.id, symbol: 'nBTC', decimals: 8 },
];
const BALANCES_SINCE = [...BALANCES_BEFORE, { token: METH.id, symbol: 'ETH', decimals: 18 }];

test('the two ETH moves show only for an account whose own settings list test ETH', () => {
  assert.deepEqual(movesFor(BALANCES_SINCE, true), ['bitcoin-out', 'loan-home', 'usdc-out', 'bitcoin-home', 'ether-out', 'ether-home']);
  assert.deepEqual(movesFor(BALANCES_BEFORE, true), ['bitcoin-out', 'loan-home', 'usdc-out', 'bitcoin-home']);
  assert.deepEqual(movesFor(undefined, true), ['bitcoin-out', 'loan-home', 'usdc-out', 'bitcoin-home']);
  assert.deepEqual(etherToken(BALANCES_SINCE, true), METH);
  assert.equal(etherToken(BALANCES_BEFORE, true), null);
  assert.deepEqual(listedEther(BALANCES_SINCE), METH);
  // One switch: while it is off (the backend's quote doesn't take test ETH yet), no account is offered them.
  assert.deepEqual(movesFor(BALANCES_SINCE, false), ['bitcoin-out', 'loan-home', 'usdc-out', 'bitcoin-home']);
  assert.equal(etherToken(BALANCES_SINCE, false), null);
  assert.equal(typeof ETHER_MOVES_ON, 'boolean');
  assert.deepEqual(movesFor(BALANCES_SINCE), movesFor(BALANCES_SINCE, ETHER_MOVES_ON));
});

test('ETH goes out as to_evm with test ETH’s id, and WETH comes home as ETH by naming it in `to`; without `to` it comes home as bitcoin, as before', () => {
  assert.deepEqual(moveQuoteBody('ether-out', { dry: true, account: ALICE, token: METH.id, amount: '20000000000000000', ether: METH }), {
    dry: true,
    move: 'to_evm',
    account: ALICE,
    token: METH.id,
    amount: '20000000000000000',
  });
  assert.deepEqual(moveQuoteBody('ether-home', { dry: false, account: ALICE, token: WETH.id, amount: '20000000000000000', ether: METH }), {
    dry: false,
    move: 'e_home',
    account: ALICE,
    token: WETH.id,
    amount: '20000000000000000',
    to: METH.id,
  });
  // The bitcoin's way home, with the same WETH: no `to`.
  assert.equal('to' in moveQuoteBody('bitcoin-home', { dry: true, account: ALICE, token: WETH.id, amount: '1', ether: METH }), false);
  assert.equal('to' in moveQuoteBody('loan-home', { dry: true, account: ALICE, token: USDC.id, amount: '1', ether: METH }), false);
  // What each can take: test ETH on NEAR, and the WETH at the address.
  const near = [{ token: MUSDC, amount: '250000000' }, { token: NBTC, amount: '1500000' }, { token: METH, amount: '354000000000000000' }];
  const wallet = [
    { token: WETH.id, symbol: 'WETH', decimals: 18, amount: '20000000000000000' },
    { token: WBTC.id, symbol: 'WBTC', decimals: 8, amount: '5000' },
    { token: USDC.id, symbol: 'USDC', decimals: 6, amount: '33200000' },
  ];
  assert.deepEqual(moveSources('ether-out', near, wallet), [{ token: METH, held: 354_000_000_000_000_000n }]);
  assert.deepEqual(moveSources('ether-home', near, wallet), [{ token: WETH, held: 20_000_000_000_000_000n }]);
  assert.deepEqual(moveSources('ether-out', near.slice(0, 2), wallet), [], 'an account from before has no ETH to move');
});

test('the cap is said before the client types: at most 0.02 ETH a move, about $38; and a quote refused for its size says the same, not an error', () => {
  assert.equal(etherCapWords(1_900), 'At most 0.02 ETH a move on testnet (about $38): the stand-in has little test ETH on that chain.');
  assert.equal(etherCapWords(null), 'At most 0.02 ETH a move on testnet (about $38): the stand-in has little test ETH on that chain.');
  assert.equal(etherCapWords(3_184.2), 'At most 0.02 ETH a move on testnet (about $64): the stand-in has little test ETH on that chain.');
  assert.equal(overEtherCap('20000000000000000', 18), false);
  assert.equal(overEtherCap('20000000000000001', 18), true);
  assert.equal(overEtherCap('354000000000000000', 18), true);
  // The stand-in's own refusal (services/oneclick-shim/src/evm-routes.ts).
  assert.equal(isSizeRefusal('This would arrive as 0.05 WETH, and the stand-in brings at most 0.02 WETH in one move: its float has little test ETH. Send at most 0.02 ETH (20000000000000000 units)'), true);
  assert.equal(isSizeRefusal('The backend is not running'), false);
  assert.equal(isSizeRefusal(null), false);
});

test('a quote for ETH says it arrives as WETH, and one for WETH home says it arrives as ETH, with no word of bitcoin', () => {
  const out: MoveQuoteAnswer = {
    correlationId: 'c3',
    quote: { amountIn: '20000000000000000', amountInFormatted: '0.02', amountOut: '19900000000000000', amountOutFormatted: '0.0199', minAmountOut: '19800000000000000', amountInUsd: '38.00', amountOutUsd: '37.81', timeEstimate: 120 },
    move: { kind: 'to_evm', account: ALICE, next: null, delivers: { token: WETH.id, symbol: 'WETH', chain: 'Base Sepolia', amount: '19900000000000000' }, needs_check: null },
    shim: { why: 'Wrapped from the float’s own test ETH' },
  } as MoveQuoteAnswer;
  const words = quoteWords('ether-out', out, METH, [...TOKENS, METH]);
  assert.equal(words.leaves, '0.02 ETH leaves your account on NEAR.');
  assert.match(words.arrives, /^About 0\.0199 WETH arrives at the account’s own address on Base Sepolia/);
  assert.equal(words.why, 'It arrives as WETH, the wrapped form of ETH that Aave takes.');
  const home: MoveQuoteAnswer = { ...out, move: { ...out.move, kind: 'e_home', delivers: { token: METH.id, symbol: 'ETH', chain: 'NEAR', amount: '19800000000000000' } } } as MoveQuoteAnswer;
  const back = quoteWords('ether-home', home, WETH, [...TOKENS, METH]);
  assert.equal(back.why, 'It arrives as ETH.');
  assert.match(back.arrives, /^About 0\.0198 ETH arrives at your account on NEAR/);
  for (const line of [words.leaves, words.arrives, words.why, back.arrives, back.why]) assert.doesNotMatch(line ?? '', /bitcoin|nBTC/i);
  // A listed move home of WETH no longer claims nBTC on an account that lists test ETH; on one that doesn't, it does, as before.
  const transfer = { id: 'move:3', kind: 'e_home', token: WETH.id, amount: '20000000000000000', dep: FLOAT };
  assert.equal(transferWords(transfer, [...TOKENS, METH], true), '0.02 WETH home from Base Sepolia');
  assert.equal(transferWords(transfer, TOKENS, true), '0.02 WETH home from Base Sepolia, to arrive as nBTC');
  // While the ETH moves are switched off, WETH does come home as bitcoin, and the words say so, as before.
  assert.equal(transferWords(transfer, [...TOKENS, METH], false), '0.02 WETH home from Base Sepolia, to arrive as nBTC');
});

test('a quote says what leaves, what arrives and where, how long it takes and what it costs, in its own numbers', () => {
  const words = quoteWords('bitcoin-out', bitcoinOut(), NBTC, TOKENS);
  assert.equal(words.leaves, '0.00055 nBTC leaves your account on NEAR.');
  assert.equal(words.arrives, 'About 0.01386 WETH arrives at the account’s own address on Base Sepolia, in about 2 minutes.');
  assert.equal(words.cost, 'The move costs about $0.21: $41.80 leaves and about $41.59 arrives.');
  const home = quoteWords('loan-home', loanHome(), USDC, TOKENS);
  // USDC reads in dollars either way.
  assert.equal(home.leaves, '$23.03 of USDC leaves the account’s address on Base Sepolia.');
  assert.equal(home.arrives, 'About $22.98 of USDC arrives at your account on NEAR, in about 45 seconds.');
  assert.equal(home.cost, 'The move costs about $0.04: $23.03 leaves and about $22.99 arrives.');
  assert.equal(home.why, null);
});

test('bitcoin that arrives as wrapped test ETH says why; as WBTC it needs no reason', () => {
  assert.equal(
    quoteWords('bitcoin-out', bitcoinOut(), NBTC, TOKENS).why,
    'Aave’s test pool for bitcoin is full today, so your bitcoin arrives as wrapped test ETH worth the same in dollars. On mainnet it would arrive as bitcoin.',
  );
  const asBitcoin = bitcoinOut({ delivers: { token: WBTC.id, symbol: 'WBTC', chain: 'Base Sepolia', amount: '54700' } });
  const words = quoteWords('bitcoin-out', asBitcoin, NBTC, TOKENS);
  assert.equal(words.why, null);
  assert.equal(words.arrives, 'About 0.000547 WBTC arrives at the account’s own address on Base Sepolia, in about 2 minutes.');
  // The stand-in's own reason (`shim.why`) is shown when the quote carries one, with what mainnet would do.
  const withReason = { ...bitcoinOut(), shim: { symbol: 'WETH', why: 'Aave\'s test market has room for 0 more WBTC (its supply cap), less than the 0.000547 this would bring: the bitcoin arrives as wrapped test ETH of the same dollar value' } };
  assert.equal(
    quoteWords('bitcoin-out', withReason, NBTC, TOKENS).why,
    'Aave\'s test market has room for 0 more WBTC (its supply cap), less than the 0.000547 this would bring: the bitcoin arrives as wrapped test ETH of the same dollar value. On mainnet it would arrive as bitcoin.',
  );
  // The way home turns either token back into nBTC.
  assert.equal(quoteWords('bitcoin-home', loanHome({ delivers: { token: NBTC.id, symbol: 'nBTC', chain: 'NEAR', amount: '54000' } }), WETH, TOKENS).why, 'It arrives as nBTC, whichever token left.');
});

test('a quote without `delivers`, or without dollar figures, still reads: the quote’s own formatted amount, and no made-up cost', () => {
  const bare = bitcoinOut({ delivers: null });
  delete bare.quote.amountInUsd;
  const words = quoteWords('bitcoin-out', bare, NBTC, TOKENS);
  assert.equal(words.arrives, 'About 0.01386 arrives at the account’s own address on Base Sepolia, in about 2 minutes.');
  assert.equal(words.cost, 'The quote gives no dollar figures, so the page can’t say what the move costs: compare what leaves with what arrives.');
  assert.equal(words.why, null);
  assert.equal(moveCost(bare.quote), null);
  // A token the page doesn't know is counted by the quote's formatted amount, under the name the quote gives.
  const unknown = bitcoinOut({ delivers: { token: '0x00000000000000000000000000000000000000ff', symbol: 'cbBTC', chain: 'Base Sepolia', amount: '1' } });
  assert.equal(quoteWords('bitcoin-out', unknown, NBTC, TOKENS).arrives, 'About 0.01386 cbBTC arrives at the account’s own address on Base Sepolia, in about 2 minutes.');
});

test('the time a move takes is the quote’s estimate, in seconds or minutes', () => {
  assert.equal(timeWords(20), 'about 20 seconds');
  assert.equal(timeWords(180), 'about 3 minutes');
  assert.equal(timeWords(undefined), 'a few minutes');
});

test('the size limit is said in dollars and in bitcoin when prices are known, and as “about $40” when they aren’t', () => {
  assert.equal(sizeLimitWords({ btc: null, eth: null }), 'On testnet one move brings at most 0.02 wrapped test ETH, about $40, because test ETH is scarce.');
  assert.equal(
    sizeLimitWords({ btc: 76_000, eth: 2_000 }),
    'On testnet one move brings at most 0.02 wrapped test ETH, about $40, because test ETH is scarce. That is about 0.00053 nBTC at today’s prices: a quote for more is refused.',
  );
});

test('the next call is the quote’s own: withdraw with a to_evm transfer, or evm_withdraw with the expiry', () => {
  const out = nextTx(ALICE, { method: 'withdraw', args: { token: NBTC.id, amount: '55000', receiver: DEPOSIT, transfer: { kind: 'to_evm', exp: EXP } } }, NOW);
  assert.deepEqual(out?.actions[0]?.args, { token: NBTC.id, amount: '55000', receiver: DEPOSIT, transfer: { kind: 'to_evm', exp: EXP } });
  assert.equal(out?.receiverId, ALICE);
  const home = nextTx(ALICE, { method: 'evm_withdraw', args: { token: USDC.id, amount: '23033364', to: FLOAT, exp: EXP } }, NOW);
  assert.deepEqual(home?.actions[0], { methodName: 'evm_withdraw', args: { token: USDC.id, amount: '23033364', to: FLOAT, exp: EXP }, gas: '300000000000000', deposit: '1' });
  // Without the expiry the account wouldn't record the move, so the page doesn't send it.
  assert.equal(nextTx(ALICE, { method: 'evm_withdraw', args: { token: USDC.id, amount: '23033364', to: FLOAT } }), null);
  assert.equal(nextTx(ALICE, { method: 'withdraw', args: { token: NBTC.id, amount: '55000', receiver: DEPOSIT } }), null);
  // A dry quote has no next call, and a call for another move isn't this page's to send.
  assert.equal(nextTx(ALICE, null), null);
  assert.equal(nextTx(ALICE, { method: 'hl_withdraw', args: { amount: '1', destination: FLOAT } }), null);
  assert.equal(nextTx(ALICE, { method: 'withdraw', args: { token: MUSDC.id, amount: '1', receiver: DEPOSIT, transfer: { kind: 'to_hl', exp: EXP } } }, NOW), null);
});

test('a move home passes the quote’s `expect` through to evm_withdraw, and sends none when the quote has none (INTERFACES.md 47.3)', () => {
  const expect = { token: MUSDC.id, amount: '22987297' };
  const withIt = nextTx(ALICE, { method: 'evm_withdraw', args: { token: USDC.id, amount: '23033364', to: FLOAT, exp: EXP, expect } }, NOW);
  assert.deepEqual(withIt?.actions[0]?.args, { token: USDC.id, amount: '23033364', to: FLOAT, exp: EXP, expect });
  // A quote from an older backend carries none, and the call then has no such key.
  const without = nextTx(ALICE, { method: 'evm_withdraw', args: { token: USDC.id, amount: '23033364', to: FLOAT, exp: EXP } }, NOW);
  assert.equal('expect' in without!.actions[0]!.args, false);
});

test('a quote that expires more than 24 hours ahead is not sent, and the page says why (INTERFACES.md 40.5)', () => {
  const DAY = 24 * 60 * 60_000;
  const words = 'This quote expires more than 24 hours from now. The account takes a move only when its quote ends within a day, so nothing was sent: ask for a new quote.';
  const out = { method: 'withdraw' as const, args: { token: NBTC.id, amount: '55000', receiver: DEPOSIT, transfer: { kind: 'to_evm' as const, exp: NOW + DAY + 1 } } };
  const home = { method: 'evm_withdraw' as const, args: { token: USDC.id, amount: '23033364', to: FLOAT, exp: NOW + 30 * DAY } };
  assert.equal(nextTx(ALICE, out, NOW), null);
  assert.equal(nextTx(ALICE, home, NOW), null);
  assert.equal(nextRefusal(out, NOW), words);
  assert.equal(nextRefusal(home, NOW), words);
  // The app's own quotes, minutes ahead, and one a day ahead to the millisecond, have nothing to say.
  assert.equal(nextRefusal({ ...home, args: { ...home.args, exp: EXP } }, NOW), null);
  assert.equal(nextRefusal({ ...home, args: { ...home.args, exp: NOW + DAY } }, NOW), null);
  assert.notEqual(nextTx(ALICE, { ...home, args: { ...home.args, exp: NOW + DAY } }, NOW), null);
  assert.equal(nextRefusal(null, NOW), null);
});

test('a move needs a check first only when the quote names one, for a withdrawal or a transfer out of the address', () => {
  assert.equal(needsCheck(bitcoinOut().move), null);
  assert.deepEqual(needsCheck(bitcoinOut({ needs_check: { withdraw: { token: NBTC.id, amount: '55000' } } }).move), { withdraw: { token: NBTC.id, amount: '55000' } });
  assert.deepEqual(needsCheck(loanHome({ needs_check: { evm_withdraw: { token: USDC.id, amount: '23033364' } } }).move), { evm_withdraw: { token: USDC.id, amount: '23033364' } });
  // Anything else isn't a check this page can ask for.
  assert.equal(needsCheck(bitcoinOut({ needs_check: { borrow: { amount: '1' } } }).move), null);
});

test('a move’s stage: waiting for the deposit, on its way, arrived, sent back, failed, or overdue', () => {
  assert.equal(moveStage('PENDING_DEPOSIT', false), 'waiting');
  assert.equal(moveStage('KNOWN_DEPOSIT_TX', false), 'moving');
  assert.equal(moveStage('PROCESSING', false), 'moving');
  assert.equal(moveStage('SUCCESS', false), 'arrived');
  assert.equal(moveStage('REFUNDED', false), 'refunded');
  assert.equal(moveStage('FAILED', false), 'failed');
  // Past its deadline it is overdue, unless 1Click says it arrived or came back.
  assert.equal(moveStage('PENDING_DEPOSIT', true), 'overdue');
  assert.equal(moveStage('FAILED', true), 'overdue');
  assert.equal(moveStage(null, true), 'overdue');
  assert.equal(moveStage('SUCCESS', true), 'arrived');
  // With no status and time left, the page knows only what the account lists.
  assert.equal(moveStage(null, false), null);
  assert.equal(STAGE_LABEL.waiting, 'Waiting for the deposit');
});

test('the words for a stage say what the account itself knows', () => {
  // A move to Aave's chain that has arrived stays listed until a check sees it.
  assert.equal(
    stageWords('arrived', 'to_evm'),
    'Arrived at the account’s own address on Base Sepolia. The account can’t see that chain, so it keeps the move listed until a check sees the tokens there.',
  );
  assert.equal(stageWords('arrived', 'to_evm', false), 'Arrived at the account’s own address on Base Sepolia.');
  assert.equal(stageWords('arrived', 'e_home'), 'Arrived at your account on NEAR.');
  assert.equal(stageWords('waiting', 'e_home'), '1Click is waiting for the transfer out of the address to be mined on Base Sepolia.');
  assert.equal(stageWords('moving', 'to_evm'), '1Click has the tokens and is delivering to the account’s own address on Base Sepolia.');
  // A refund on NEAR settles by itself; one on Aave's chain the account can't see.
  assert.equal(stageWords('refunded', 'to_evm'), '1Click sent the tokens back to your account on NEAR, so nothing is lost but the time.');
  assert.match(stageWords('refunded', 'e_home'), /stays listed until its deadline passes; then drop it\.$/);
  assert.match(stageWords('overdue', 'to_evm'), /^Past its deadline\. While it is listed, borrowing, and withdrawing with a loan, wait\./);
});

test('a listed transfer reads as what is moving and where, for the two new kinds and the old ones', () => {
  const t = (kind: string, token: string, amount: string) => ({ id: 'move:1', kind, token, amount, dep: DEPOSIT });
  assert.equal(transferWords(t('to_evm', NBTC.id, '55000'), TOKENS), '0.00055 nBTC to the account’s own address on Base Sepolia');
  assert.equal(transferWords(t('to_evm', MUSDC.id, '25000000'), TOKENS), '$25.00 of USDC to the account’s own address on Base Sepolia');
  // A move home names its USDC as "USDC", and its collateral by the 0x address, in lower case.
  assert.equal(transferWords(t('e_home', 'USDC', '23033364'), TOKENS), '$23.03 of USDC home from Base Sepolia');
  assert.equal(transferWords(t('e_home', WETH.id, '20000000000000000'), TOKENS), '0.02 WETH home from Base Sepolia, to arrive as nBTC');
  assert.equal(transferWords(t('to_hl', MUSDC.id, '430000000'), TOKENS), '$430.00 of USDC to Hyperliquid');
  assert.equal(transferWords(t('home', 'USDC', '100000000'), TOKENS), '$100.00 of USDC home from Hyperliquid');
  // A token the page doesn't know keeps its own name and units.
  assert.equal(transferWords(t('e_home', '0x00000000000000000000000000000000000000ff', '7'), TOKENS), '7 units of 0x00000000000000000000000000000000000000ff home from Base Sepolia');
});

test('without a status from 1Click, a listed transfer says what the account knows and why the page can’t say more', () => {
  assert.equal(listedWords('e_home', null, { asked: false, until: '14:05:00' }), 'The account lists it as under way. It has until 14:05:00. 1Click’s status for a move like this shows only in the browser that started it.');
  assert.equal(listedWords('to_evm', null, { asked: true }), 'The account lists it as under way. Asking 1Click…');
  assert.equal(listedWords('to_evm', null, { asked: true, error: 'The page could not reach its server.' }), 'The account lists it as under way. 1Click’s status didn’t answer: The page could not reach its server.');
  // With a stage, the stage's own words.
  assert.equal(listedWords('e_home', 'arrived', { asked: true }), 'Arrived at your account on NEAR.');
});

test('what a move can take: nBTC or USDC from the account on NEAR, the USDC or the collateral at the address', () => {
  const near = [
    { token: MUSDC, amount: '250000000' },
    { token: NBTC, amount: '1500000' },
  ];
  const wallet = [
    { token: WETH.id, symbol: 'WETH', decimals: 18, amount: '20000000000000000' },
    { token: WBTC.id, symbol: 'WBTC', decimals: 8, amount: '0' },
    { token: USDC.id, symbol: 'USDC', decimals: 6, amount: '33200000' },
  ];
  assert.deepEqual(moveSources('bitcoin-out', near, wallet), [{ token: NBTC, held: 1_500_000n }]);
  assert.deepEqual(moveSources('usdc-out', near, wallet), [{ token: MUSDC, held: 250_000_000n }]);
  assert.deepEqual(moveSources('loan-home', near, wallet), [{ token: USDC, held: 33_200_000n }]);
  // The collateral at the address may be WBTC or WETH: whichever is there, never the USDC.
  assert.deepEqual(moveSources('bitcoin-home', near, wallet), [{ token: WETH, held: 20_000_000_000_000_000n }]);
  // Nothing there, or a balance the page couldn't read, offers nothing.
  assert.deepEqual(moveSources('loan-home', near, []), []);
  assert.deepEqual(moveSources('bitcoin-out', [{ token: NBTC, amount: null }], wallet), []);
});

test('1Click’s status can be asked from the account’s record for a move that leaves NEAR, and only by the browser that started one that leaves Aave’s chain', () => {
  const out = { id: 'move:1', kind: 'to_evm', token: NBTC.id, amount: '55000', dep: DEPOSIT };
  const home = { id: 'move:2', kind: 'e_home', token: 'USDC', amount: '23033364', dep: FLOAT };
  assert.deepEqual(statusQuery(out, null), { depositAddress: DEPOSIT, depositMemo: null });
  assert.equal(statusQuery(home, null), null);
  // This browser remembers the quote it committed, with the memo that tells it apart at 1Click's one address there.
  const kept = new Map<string, string>();
  const store = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
  rememberMove(store, { account: ALICE, id: 'move:2', depositAddress: FLOAT, depositMemo: 'q-17' });
  assert.deepEqual(statusQuery(home, recallMove(store, ALICE, 'move:2')), { depositAddress: FLOAT, depositMemo: 'q-17' });
  assert.equal(recallMove(store, 'bob.pbf.testnet', 'move:2'), null);
  // A remembered move with another deposit address is about some other transfer: it is not used.
  assert.deepEqual(statusQuery(out, { account: ALICE, id: 'move:1', depositAddress: 'stale', depositMemo: null }), { depositAddress: DEPOSIT, depositMemo: null });
  assert.equal(statusQuery(home, { account: ALICE, id: 'move:2', depositAddress: 'stale', depositMemo: 'q-1' }), null);
  // Remembering the same move again replaces it, and storage that fails never throws.
  rememberMove(store, { account: ALICE, id: 'move:2', depositAddress: FLOAT, depositMemo: 'q-18' });
  assert.equal(recallMove(store, ALICE, 'move:2')?.depositMemo, 'q-18');
  const broken = { getItem: () => 'not json', setItem: () => { throw new Error('full'); } };
  rememberMove(broken, { account: ALICE, id: 'move:3', depositAddress: FLOAT, depositMemo: null });
  assert.equal(recallMove(broken, ALICE, 'move:3'), null);
});
