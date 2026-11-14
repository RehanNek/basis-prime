// The account's address on Aave's chain: what sits there, its gas, and its signed transactions in words (INTERFACES.md 33).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EvmAnswer } from './api.ts';
import {
  approved,
  collateralAt,
  ethWei,
  evmAddressUrl,
  evmSignedFromLogs,
  evmStatus,
  evmTokens,
  evmTxUrl,
  formatEth,
  GAS_PER_TX_WEI,
  gasView,
  isEvmAddress,
  microUsd,
  newSigned,
  evmSettled,
  shortAddress,
  signedBySteps,
  signedWords,
  statusWords,
  testCollateral,
  tokenAmount,
  unsent,
  walletAmount,
  walletUsd,
} from './evm.ts';

// INTERFACES.md 24's testnet tokens on Base Sepolia.
const WBTC = '0x54114591963CF60EF3aA63bEfD6eC263D98145a4';
const USDC = '0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f';
const ADDRESS = '0x8c01b1a86db01769c246d3739da0bb74ae3217fb';

/** INTERFACES.md 33: `evm` in GET /api/lender/:account, after a supply and a borrow. */
const EVM: EvmAnswer = {
  address: ADDRESS,
  nonce: 3,
  chain_nonce: 2,
  eth: '2000000000000000',
  wallet: [
    { token: WBTC, symbol: 'WBTC', decimals: 8, amount: '500000' },
    { token: USDC, symbol: 'USDC', decimals: 6, amount: '323000000' },
  ],
  signed: [
    { nonce: 0, kind: 'approve', token: WBTC, amount: null, hash: '0xa0', status: 'mined' },
    { nonce: 1, kind: 'supply', token: WBTC, amount: '1000000', hash: '0xa1', status: 'mined' },
    { nonce: 2, kind: 'borrow', token: USDC, amount: '323000000', hash: '0xa2', status: 'signed' },
  ],
};

test('a transaction and an address link to Base Sepolia’s explorer', () => {
  assert.equal(evmTxUrl('0xa2'), 'https://sepolia.basescan.org/tx/0xa2');
  assert.equal(evmAddressUrl(ADDRESS), `https://sepolia.basescan.org/address/${ADDRESS}`);
  assert.equal(shortAddress(ADDRESS), '0x8c01…17fb');
  assert.equal(isEvmAddress(ADDRESS), true);
  assert.equal(isEvmAddress('alice.testnet'), false);
  assert.equal(isEvmAddress('0x8c01'), false);
});

test('the address’s gas reads as ETH, and says whether a transaction can go out', () => {
  assert.equal(ethWei('2000000000000000'), 2_000_000_000_000_000n);
  assert.equal(ethWei(500_000_000_000_000), 500_000_000_000_000n);
  assert.equal(ethWei(null), null);
  assert.equal(ethWei('0.002'), null);
  assert.equal(formatEth(2_000_000_000_000_000n), '0.0020 ETH');
  assert.equal(formatEth(1_234_567_000_000_000_000n), '1.2345 ETH');
  // A transaction may need its gas limit of 500,000 at 1 gwei held: 0.0005 ETH.
  assert.equal(GAS_PER_TX_WEI, 500_000_000_000_000n);
  assert.deepEqual(gasView('2000000000000000'), { amount: '0.0020 ETH', enough: true, words: 'Enough for its next transactions. Each one spends a tiny part of it.' });
  const low = gasView('100000000000000');
  assert.equal(low.enough, false);
  assert.equal(low.words, 'Too little: a transaction can need up to 0.0005 ETH held at the address before it goes out.');
  assert.equal(gasView(undefined).enough, null);
});

test('what sits at the address: each token by name, and its worth in dollars', () => {
  assert.equal(walletAmount(EVM, 'WBTC'), 500_000n);
  assert.equal(walletAmount(EVM, 'USDC'), 323_000_000n);
  assert.equal(walletAmount(EVM, 'DAI'), 0n);
  assert.equal(walletAmount(null, 'USDC'), 0n);
  assert.deepEqual(evmTokens(EVM)[0], { id: WBTC, symbol: 'WBTC', label: 'WBTC', decimals: 8 });
  // 0.005 WBTC at $76,000 and $323 of USDC.
  assert.equal(walletUsd(EVM, { btc: 76_000, eth: 3_000 }), 703);
  // Without a bitcoin price the total is unknown rather than wrong.
  assert.equal(walletUsd(EVM, { btc: null, eth: 3_000 }), null);
  assert.equal(walletUsd(null, { btc: 76_000, eth: 3_000 }), 0);
});

// Aave's test market also takes wrapped test ETH, which has 18 decimals (INTERFACES.md 33, the change after the live try).
const WETH = '0x4200000000000000000000000000000000000006';
const WITH_ETHER: EvmAnswer = { ...EVM, wallet: [{ token: WETH, symbol: 'WETH', decimals: 18, amount: '20000000000000000' }, { ...EVM.wallet[0]!, amount: '0' }, EVM.wallet[1]!] };

test('nothing assumes bitcoin or 8 decimals: ether at the address reads by its own name and decimals', () => {
  assert.deepEqual(collateralAt(WITH_ETHER).map((t) => t.symbol), ['WETH']);
  assert.deepEqual(collateralAt(EVM).map((t) => t.symbol), ['WBTC']);
  assert.deepEqual(collateralAt(null), []);
  assert.equal(tokenAmount('20000000000000000', WITH_ETHER.wallet[0]!), '0.02 WETH');
  // Ether that arrived from a move has all 18 places filled: 8 are shown.
  assert.equal(tokenAmount('12603333333333333', WITH_ETHER.wallet[0]!), '0.01260333 WETH');
  // 0.02 WETH at $3,000 and $323 of USDC.
  assert.equal(walletUsd(WITH_ETHER, { btc: null, eth: 3_000 }), 383);
  assert.equal(signedWords({ kind: 'supply', token: WETH, amount: '20000000000000000' }, WITH_ETHER.wallet), 'Post 0.02 WETH with Aave');
  assert.equal(signedWords({ kind: 'withdraw', token: WETH.toUpperCase().replace('0X', '0x'), amount: '5000000000000000' }, WITH_ETHER.wallet), 'Take 0.005 WETH back from Aave');
});

test('the testnet step asks for bitcoin when Aave’s test pool has room for it, as much as the nBTC whose move it stands in for', () => {
  const room = [{ token: WBTC, symbol: 'WBTC', decimals: 8, room: '250000000' }, { token: WETH, symbol: 'WETH', decimals: 18, room: null }];
  const choice = testCollateral(room, 1_500_000n);
  assert.equal(choice.kind, 'bitcoin');
  assert.deepEqual(choice.ask, { mint: { token: WBTC, amount: '1500000' } });
  assert.equal(choice.amount, '0.015 test WBTC');
  assert.equal(choice.why, 'Moving your bitcoin to Aave’s chain is a later stage, so here Aave’s own test faucet hands the account’s address test bitcoin in its place. Your nBTC stays on NEAR.');
  // No cap at all is room enough; the faucet gives at most 1 WBTC a call; with no nBTC on NEAR it asks for the demo's 0.015.
  assert.equal(testCollateral([{ token: WBTC, symbol: 'WBTC', decimals: 8, room: null }], 500_000_000n).amount, '1 test WBTC');
  assert.deepEqual(testCollateral(room, 0n).ask, { mint: { token: WBTC, amount: '1500000' } });
});

test('when Aave’s test pool for bitcoin is full, the step asks for test ether and says why', () => {
  const full = [{ token: WBTC, symbol: 'WBTC', decimals: 8, room: '0' }, { token: WETH, symbol: 'WETH', decimals: 18, room: null }];
  const choice = testCollateral(full, 1_500_000n);
  assert.equal(choice.kind, 'ether');
  // The gas wallet wraps at most 0.02 test ETH a day for one account.
  assert.deepEqual(choice.ask, { wrap: { amount: '20000000000000000' } });
  assert.equal(choice.amount, '0.02 test WETH');
  assert.equal(choice.why, 'Aave’s test pool for bitcoin is full today, so this demo posts test ether. On mainnet it would be your bitcoin. Moving your bitcoin to Aave’s chain is a later stage.');
  // Room for less than the account's bitcoin counts as full.
  assert.equal(testCollateral([{ token: WBTC, symbol: 'WBTC', decimals: 8, room: '1000000' }], 1_500_000n).kind, 'ether');
  // With no reading of the room, ether: Aave's test market takes it either way.
  const unread = testCollateral(undefined, 1_500_000n);
  assert.equal(unread.kind, 'ether');
  assert.match(unread.why, /^The page couldn’t read whether Aave’s test pool has room for bitcoin/);
});

test('the USDC at the address counts in micro-USD, whatever the token’s decimals', () => {
  assert.equal(microUsd('323000000', 6), 323_000_000n);
  assert.equal(microUsd('323000000000000000000', 18), 323_000_000n);
  assert.equal(microUsd('32300', 2), 323_000_000n);
  assert.equal(microUsd('not a number', 6), 0n);
});

test('each kind of signed transaction is said in plain words', () => {
  const say = (i: number) => signedWords(EVM.signed[i]!, EVM.wallet);
  assert.equal(say(0), 'Let Aave take WBTC from the address (once per token)');
  assert.equal(say(1), 'Post 0.01 WBTC with Aave');
  assert.equal(say(2), 'Borrow $323.00 from Aave');
  assert.equal(signedWords({ kind: 'repay', token: USDC.toLowerCase(), amount: '100000000' }, EVM.wallet), 'Repay $100.00 to Aave');
  assert.equal(signedWords({ kind: 'withdraw', token: WBTC, amount: '250000' }, EVM.wallet), 'Take 0.0025 WBTC back from Aave');
  assert.equal(signedWords({ kind: 'transfer', token: USDC, amount: '50000000', to: '0x2031181d63507368232579AF4c64a1c3428407fF' }, EVM.wallet), 'Send $50.00 out of the address to 0x2031…07fF');
  // A token the page has no reading of, and a kind it doesn't know.
  assert.equal(signedWords({ kind: 'supply', token: '0x0000000000000000000000000000000000000001', amount: '5' }, EVM.wallet), 'Post collateral with Aave');
  assert.equal(signedWords({ kind: 'later', token: null, amount: null }), 'A transaction this page doesn’t know (later)');
});

test('a signed borrow or withdrawal counts before it is mined, and the words say so', () => {
  assert.equal(statusWords('borrow', 'signed'), 'Signed, not mined yet: it waits to be sent to Base Sepolia. The loan already counts: a signed transaction never expires, and anyone can send it.');
  assert.equal(statusWords('withdraw', 'sent'), 'Sent to Base Sepolia, not mined yet. The collateral already counts as gone: a signed transaction never expires, and anyone can send it.');
  assert.equal(statusWords('transfer', 'sent'), 'Sent to Base Sepolia, not mined yet. The tokens already count as gone, and the account takes no new loan and sends nothing else out until it is mined.');
  assert.equal(statusWords('supply', 'signed'), 'Signed, not mined yet: it waits to be sent to Base Sepolia.');
  assert.equal(statusWords('borrow', 'mined'), 'Mined on Base Sepolia.');
  assert.equal(statusWords('repay', 'failed'), 'Base Sepolia mined it, but it failed there, so nothing moved.');
  // The backend's fifth status: the chain used this nonce for another transaction.
  assert.equal(statusWords('repay', 'replaced'), 'Base Sepolia gave its place in line to another signing of the account’s, so this one can never be mined.');
  assert.equal(evmStatus('replaced'), 'replaced');
  assert.deepEqual(['signed', 'sent', 'mined', 'failed', 'replaced'].map((s) => evmSettled(evmStatus(s))), [false, false, true, true, true]);
  // A status the page doesn't know is at least signed: that is why the entry is on the list.
  assert.equal(evmStatus('queued'), 'signed');
  assert.equal(evmStatus('mined'), 'mined');
});

test('a plan step finds its signed transaction by the step it carries, or through the account’s own list by nonce', () => {
  // The backend sends `step` itself.
  const withStep = signedBySteps({ signed: [{ ...EVM.signed[1]!, step: 'f100:0' }, { ...EVM.signed[2]!, step: 'f100:1' }] });
  assert.equal(withStep.get('f100:1')?.status, 'signed');
  // It doesn't: get_state().evm.signed has the step for each nonce.
  const own = { signed: [{ nonce: 1, kind: 'supply', hash: '0xa1', step: 'f100:0' }, { nonce: 2, kind: 'borrow', hash: '0xa2', step: 'f100:1' }, { nonce: 0, kind: 'approve', hash: '0xa0', step: null }] };
  const joined = signedBySteps(EVM, own);
  assert.deepEqual([...joined.keys()], ['f100:0', 'f100:1']);
  assert.equal(joined.get('f100:0')?.hash, '0xa1');
  // A step signed again with higher fees shows its newest transaction.
  const bumped = signedBySteps({ signed: [{ ...EVM.signed[2]!, step: 'f100:1' }, { nonce: 2, kind: 'borrow', hash: '0xb2', status: 'sent', step: 'f100:1' }] });
  assert.equal(bumped.get('f100:1')?.hash, '0xb2');
  assert.equal(signedBySteps(null).size, 0);
});

test('the account’s evm_signed event gives the nonce to send', () => {
  const logs = [
    'a plain log line',
    'EVENT_JSON:{"standard":"pb-pool","version":"1.0.0","event":"hl_signed","data":[{"index":4,"kind":"approveAgent"}]}',
    'EVENT_JSON:{"standard":"pb-pool","version":"1.0.0","event":"evm_signed","data":[{"nonce":3,"kind":"repay","hash":"0xa3"}]}',
  ];
  assert.deepEqual(evmSignedFromLogs(logs), { nonce: 3, kind: 'repay', hash: '0xa3' });
  assert.deepEqual(evmSignedFromLogs(logs, 'repay'), { nonce: 3, kind: 'repay', hash: '0xa3' });
  assert.equal(evmSignedFromLogs(logs, 'withdraw'), null);
  assert.equal(evmSignedFromLogs(['EVENT_JSON:not json']), null);
});

test('without the event, the newest signed transaction of that kind from the next nonce on is the one', () => {
  assert.equal(newSigned(EVM, 'borrow', 2)?.hash, '0xa2');
  assert.equal(newSigned(EVM, 'borrow', 3), null);
  assert.equal(newSigned(EVM, 'repay', 0), null);
});

test('signed transactions that were never sent are offered again, the lowest nonce first', () => {
  assert.deepEqual(unsent(EVM).map((e) => e.nonce), [2]);
  assert.deepEqual(unsent({ signed: [{ ...EVM.signed[2]!, nonce: 5 }, { ...EVM.signed[2]!, nonce: 4 }] }).map((e) => e.nonce), [4, 5]);
  assert.deepEqual(unsent(undefined), []);
});

test('whether Aave has its one-time approval for a token: the backend’s word, else a mined approve, else unknown', () => {
  assert.equal(approved(EVM, WBTC), true);
  assert.equal(approved(EVM, USDC), null);
  assert.equal(approved({ ...EVM, wallet: [{ ...EVM.wallet[1]!, approved: false }] }, USDC), false);
  assert.equal(approved({ ...EVM, wallet: [{ ...EVM.wallet[1]!, approved: true }], signed: [] }, USDC.toLowerCase()), true);
  assert.equal(approved(null, USDC), null);
});

test('the account’s own list of signed approvals decides, when its contract gives one', () => {
  // get_state().evm.approved: token addresses, in any case. It wins over the fallback either way.
  assert.equal(approved(EVM, USDC, { approved: [USDC.toLowerCase()] }), true);
  assert.equal(approved(EVM, WBTC, { approved: [USDC] }), false);
  assert.equal(approved(null, USDC, { approved: [] }), false);
  // An older account contract has no list: today's way stands.
  assert.equal(approved(EVM, WBTC, { }), true);
  assert.equal(approved(EVM, USDC, null), null);
});
