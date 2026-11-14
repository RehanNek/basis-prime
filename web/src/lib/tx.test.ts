// The transactions the wallet signs, checked against INTERFACES.md 3-4, and 25-26 for Phase 6. Runs with: pnpm --filter @pb/web test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  borrowTx,
  buildMove,
  cancelFundingTx,
  claimCreditTx,
  connectorActions,
  cosignBorrowTx,
  createAccountTx,
  depositTx,
  evmApproveTx,
  evmWithdrawTx,
  forgetTransferTx,
  fundTx,
  hlApproveAgentTx,
  hlInitTx,
  hlWithdrawTx,
  lenderRepayTx,
  lenderWithdrawTx,
  mintTx,
  moveExpiryProblem,
  MoveRefused,
  oneClickDepositTx,
  repayTx,
  requestAgentTx,
  requestCheckTx,
  setCoinStatusTx,
  setFundingTx,
  setKybTx,
  setPausedTx,
  setPermissionTx,
  setPricingTx,
  txFailure,
  txHash,
  txLogs,
  withdrawTx,
} from './tx.ts';

const TGAS = '000000000000';
const ALICE = 'alice.pbf.testnet';
const MUSDC = 'musdc.pbf-ops.testnet';

/** INTERFACES.md 24: the app's default terms. */
const PERMISSION = { lenders: ['rhea' as const], min_hf_bp: 15_000, max_rate_bp: 2_500, moves: 'any' as const };

test('create_account({name, owner}) on the factory, with 6 NEAR and 300 TGas', () => {
  assert.deepEqual(createAccountTx('pbf.testnet', 'alice', 'alice.testnet'), {
    receiverId: 'pbf.testnet',
    actions: [{ methodName: 'create_account', args: { name: 'alice', owner: 'alice.testnet' }, gas: `300${TGAS}`, deposit: '6000000000000000000000000' }],
  });
});

test('one signature opens the account and signs the permission: create_account({name, owner, permission})', () => {
  const tx = createAccountTx('pbf.testnet', 'alice', 'alice.testnet', PERMISSION);
  assert.deepEqual(tx.actions, [{ methodName: 'create_account', args: { name: 'alice', owner: 'alice.testnet', permission: PERMISSION }, gas: `300${TGAS}`, deposit: '6000000000000000000000000' }]);
  // Opening without one leaves the field out, as before Phase 6.
  assert.deepEqual(createAccountTx('pbf.testnet', 'alice', 'alice.testnet', null).actions[0]?.args, { name: 'alice', owner: 'alice.testnet' });
});

test('the permission and the funding plan are owner calls with exactly 1 yoctoNEAR (INTERFACES.md 25)', () => {
  assert.deepEqual(setPermissionTx(ALICE, PERMISSION), { receiverId: ALICE, actions: [{ methodName: 'set_permission', args: { permission: PERMISSION }, gas: `100${TGAS}`, deposit: '1' }] });
  // Cancelling sends null.
  assert.deepEqual(setPermissionTx(ALICE, null).actions[0]?.args, { permission: null });
  assert.deepEqual(fundTx(ALICE, '94500000000').actions, [{ methodName: 'fund', args: { amount: '94500000000' }, gas: `100${TGAS}`, deposit: '1' }]);
  assert.deepEqual(cancelFundingTx(ALICE).actions, [{ methodName: 'cancel_funding', args: {}, gas: `100${TGAS}`, deposit: '1' }]);
});

test('repaying a lender, taking collateral back from it, and claiming the pool’s credit', () => {
  assert.deepEqual(lenderRepayTx(ALICE, 'rhea', '10133000000'), {
    receiverId: ALICE,
    actions: [{ methodName: 'lender_repay', args: { lender: 'rhea', amount: '10133000000' }, gas: `300${TGAS}`, deposit: '1' }],
  });
  assert.deepEqual(lenderWithdrawTx(ALICE, 'rhea', 'mnbtc.pbf-ops.testnet', '500000').actions, [
    { methodName: 'lender_withdraw', args: { lender: 'rhea', token: 'mnbtc.pbf-ops.testnet', amount: '500000' }, gas: `300${TGAS}`, deposit: '1' },
  ]);
  // claim_credit takes no deposit: the account's method isn't payable.
  assert.deepEqual(claimCreditTx(ALICE).actions, [{ methodName: 'claim_credit', args: {}, gas: `300${TGAS}`, deposit: '0' }]);
});

test('Aave’s calls through Chain Signatures (INTERFACES.md 33): the same lender calls, with the token’s 0x address', () => {
  const WETH = '0x4200000000000000000000000000000000000006';
  // lender_repay takes micro-USD for every lender; lender_withdraw the token's own units (WETH has 18 decimals).
  assert.deepEqual(lenderRepayTx(ALICE, 'aave', '323006560').actions[0]?.args, { lender: 'aave', amount: '323006560' });
  assert.deepEqual(lenderWithdrawTx(ALICE, 'aave', WETH, '5000000000000000').actions, [
    { methodName: 'lender_withdraw', args: { lender: 'aave', token: WETH, amount: '5000000000000000' }, gas: '300' + TGAS, deposit: '1' },
  ]);
  // Sending a token out of the address: the owner, 1 yoctoNEAR, and the MPC signer's gas.
  assert.deepEqual(evmWithdrawTx(ALICE, WETH, '5000000000000000', '0x2031181d63507368232579AF4c64a1c3428407fF'), {
    receiverId: ALICE,
    actions: [{ methodName: 'evm_withdraw', args: { token: WETH, amount: '5000000000000000', to: '0x2031181d63507368232579AF4c64a1c3428407fF' }, gas: '300' + TGAS, deposit: '1' }],
  });
  // The one-time approval is open to anyone, with no deposit.
  assert.deepEqual(evmApproveTx(ALICE, WETH).actions, [{ methodName: 'evm_approve', args: { token: WETH }, gas: '300' + TGAS, deposit: '0' }]);
  assert.equal(
    JSON.stringify(requestCheckTx(ALICE, { evm_withdraw: { token: WETH, amount: '5000000000000000' } }).actions[0]?.args),
    '{"intent":{"evm_withdraw":{"token":"0x4200000000000000000000000000000000000006","amount":"5000000000000000"}}}',
  );
});

test('a check can ask for a loan from every source, or for collateral back from a lender', () => {
  assert.deepEqual(requestCheckTx(ALICE, { fund: { amount: '94500000000' } }).actions[0]?.args, { intent: { fund: { amount: '94500000000' } } });
  // The account compares the stored intent field for field, in this order: lender, token, amount.
  assert.equal(
    JSON.stringify(requestCheckTx(ALICE, { lender_withdraw: { lender: 'rhea', token: 'mnbtc.pbf-ops.testnet', amount: '500000' } }).actions[0]?.args),
    '{"intent":{"lender_withdraw":{"lender":"rhea","token":"mnbtc.pbf-ops.testnet","amount":"500000"}}}',
  );
});

test('request_check({intent}) with 0.01 NEAR, for each kind of intent', () => {
  const check = requestCheckTx(ALICE, { check: {} });
  assert.equal(check.receiverId, ALICE);
  assert.deepEqual(check.actions[0], { methodName: 'request_check', args: { intent: { check: {} } }, gas: `300${TGAS}`, deposit: '10000000000000000000000' });
  assert.deepEqual(requestCheckTx(ALICE, { borrow: { amount: '24150000000' } }).actions[0]?.args, { intent: { borrow: { amount: '24150000000' } } });
  assert.deepEqual(requestCheckTx(ALICE, { withdraw: { token: MUSDC, amount: '5' } }).actions[0]?.args, { intent: { withdraw: { token: MUSDC, amount: '5' } } });
});

test('the moves between NEAR and Aave’s chain (INTERFACES.md 36): withdraw with a to_evm transfer, and evm_withdraw with the quote’s expiry', () => {
  const USDC_ON_BASE = '0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f';
  const DEPOSIT_ADDRESS = '9f3c0d5e7a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5';
  const FLOAT = '0x2031181d63507368232579af4c64a1c3428407ff';
  // The quote expires ten minutes after the clock these calls are built at.
  const NOW = 1_794_500_000_000 - 10 * 60_000;
  // Bitcoin to the address there: today's withdraw, to the quote's deposit address, naming the move and its expiry.
  assert.deepEqual(withdrawTx(ALICE, 'mnbtc.pbf-ops.testnet', '55000', DEPOSIT_ADDRESS, { kind: 'to_evm', exp: 1_794_500_000_000 }, NOW), {
    receiverId: ALICE,
    actions: [
      { methodName: 'withdraw', args: { token: 'mnbtc.pbf-ops.testnet', amount: '55000', receiver: DEPOSIT_ADDRESS, transfer: { kind: 'to_evm', exp: 1_794_500_000_000 } }, gas: `300${TGAS}`, deposit: '1' },
    ],
  });
  // The loan home: the account signs a transfer to the quote's deposit address, and `exp` has it recorded as a move.
  assert.deepEqual(evmWithdrawTx(ALICE, USDC_ON_BASE, '23033364', FLOAT, 1_794_500_000_000, NOW).actions, [
    { methodName: 'evm_withdraw', args: { token: USDC_ON_BASE, amount: '23033364', to: FLOAT, exp: 1_794_500_000_000 }, gas: `300${TGAS}`, deposit: '1' },
  ]);
  // Without an expiry it is the plain call: no `exp` at all, not a null one.
  assert.equal('exp' in evmWithdrawTx(ALICE, USDC_ON_BASE, '1', FLOAT).actions[0]!.args, false);
});

test('a move whose quote expires more than 24 hours ahead is not built: the account would refuse it (INTERFACES.md 40.5)', () => {
  const NOW = 1_794_500_000_000;
  const DAY = 24 * 60 * 60_000;
  const FLOAT = '0x2031181d63507368232579af4c64a1c3428407ff';
  const USDC_ON_BASE = '0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f';
  const words = 'This quote expires more than 24 hours from now. The account takes a move only when its quote ends within a day, so nothing was sent: ask for a new quote.';
  const refused = (error: unknown) => error instanceof MoveRefused && error.message === words;
  // Each of the three calls that has the account record a move.
  assert.throws(() => withdrawTx(ALICE, MUSDC, '7', 'deposit-address', { kind: 'to_hl', exp: NOW + DAY + 1 }, NOW), refused);
  assert.throws(() => withdrawTx(ALICE, 'mnbtc.pbf-ops.testnet', '55000', 'deposit-address', { kind: 'to_evm', exp: NOW + 365 * DAY }, NOW), refused);
  assert.throws(() => hlWithdrawTx(ALICE, '9500000000', FLOAT, NOW + DAY + 1, NOW), refused);
  assert.throws(() => evmWithdrawTx(ALICE, USDC_ON_BASE, '23033364', FLOAT, NOW + DAY + 1, NOW), refused);
  // Exactly 24 hours ahead is still a quote the account takes, as is the app's own, minutes ahead.
  assert.equal(withdrawTx(ALICE, MUSDC, '7', 'deposit-address', { kind: 'to_hl', exp: NOW + DAY }, NOW).actions[0]?.methodName, 'withdraw');
  assert.equal(hlWithdrawTx(ALICE, '9500000000', FLOAT, NOW + 10 * 60_000, NOW).actions[0]?.methodName, 'hl_withdraw');
  assert.equal(evmWithdrawTx(ALICE, USDC_ON_BASE, '23033364', FLOAT, NOW + DAY, NOW).actions[0]?.methodName, 'evm_withdraw');
  assert.equal(moveExpiryProblem(NOW + DAY, NOW), null);
  assert.equal(moveExpiryProblem(NOW + DAY + 1, NOW), words);
  // A call that records no move has no expiry to judge: a plain withdrawal, a plain transfer out.
  assert.equal(withdrawTx(ALICE, MUSDC, '7', 'alice.testnet', undefined, NOW).actions[0]?.methodName, 'withdraw');
  assert.equal(evmWithdrawTx(ALICE, USDC_ON_BASE, '1', FLOAT, undefined, NOW).actions[0]?.methodName, 'evm_withdraw');
  assert.equal(hlWithdrawTx(ALICE, '1', FLOAT, undefined, NOW).actions[0]?.methodName, 'hl_withdraw');
  // A page asks for the transaction or the reason, and shows the reason in place of the button.
  assert.deepEqual(buildMove(() => hlWithdrawTx(ALICE, '1', FLOAT, NOW + 2 * DAY, NOW)), { tx: null, problem: words });
  assert.equal(buildMove(() => hlWithdrawTx(ALICE, '1', FLOAT, NOW + 60_000, NOW)).problem, null);
  // Any other error is not a refusal, and is not swallowed.
  assert.throws(() => buildMove(() => { throw new Error('other'); }), /other/);
});

test('the two calls that bring money home carry the quote’s `expect`, and no `expect` key without one (INTERFACES.md 47.3)', () => {
  const NOW = 1_794_500_000_000;
  const EXP = NOW + 10 * 60_000;
  const FLOAT = '0x2031181d63507368232579af4c64a1c3428407ff';
  const USDC_ON_BASE = '0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f';
  // What the quote says will arrive on NEAR: the account records it, so a stranger's one-unit deposit can't settle
  // the transfer early. An older account ignores the argument.
  const expect = { token: MUSDC, amount: '9480000' };
  // hl_withdraw: USDC home from Hyperliquid.
  assert.deepEqual(hlWithdrawTx(ALICE, '9500000', FLOAT, EXP, NOW, expect).actions[0]?.args, { amount: '9500000', destination: FLOAT, exp: EXP, expect: { token: MUSDC, amount: '9480000' } });
  assert.equal('expect' in hlWithdrawTx(ALICE, '9500000', FLOAT, EXP, NOW).actions[0]!.args, false);
  // evm_withdraw: the loan, or the collateral, home from Aave's chain.
  assert.deepEqual(evmWithdrawTx(ALICE, USDC_ON_BASE, '23033364', FLOAT, EXP, NOW, expect).actions[0]?.args, {
    token: USDC_ON_BASE, amount: '23033364', to: FLOAT, exp: EXP, expect: { token: MUSDC, amount: '9480000' },
  });
  assert.equal('expect' in evmWithdrawTx(ALICE, USDC_ON_BASE, '23033364', FLOAT, EXP, NOW).actions[0]!.args, false);
  // Only the two fields go out, whatever else the quote's object holds; a null or empty one sends none.
  assert.deepEqual(hlWithdrawTx(ALICE, '1', FLOAT, EXP, NOW, { ...expect, other: 1 } as never).actions[0]?.args.expect, expect);
  assert.equal('expect' in evmWithdrawTx(ALICE, USDC_ON_BASE, '1', FLOAT, EXP, NOW, null).actions[0]!.args, false);
});

test('an overdue transfer is dropped with forget_transfer({id}): the owner, 1 yoctoNEAR', () => {
  assert.deepEqual(forgetTransferTx(ALICE, 'move:3'), {
    receiverId: ALICE,
    actions: [{ methodName: 'forget_transfer', args: { id: 'move:3' }, gas: `100${TGAS}`, deposit: '1' }],
  });
});

test('borrow, repay and withdraw are owner calls with exactly 1 yoctoNEAR', () => {
  assert.deepEqual(borrowTx(ALICE, '24150000000').actions, [{ methodName: 'borrow', args: { amount: '24150000000' }, gas: `300${TGAS}`, deposit: '1' }]);
  assert.deepEqual(repayTx(ALICE, '100').actions, [{ methodName: 'repay', args: { amount: '100' }, gas: `300${TGAS}`, deposit: '1' }]);
  assert.deepEqual(withdrawTx(ALICE, MUSDC, '7', 'alice.testnet'), {
    receiverId: ALICE,
    actions: [{ methodName: 'withdraw', args: { token: MUSDC, amount: '7', receiver: 'alice.testnet' }, gas: `300${TGAS}`, deposit: '1' }],
  });
});

test("the faucet's mint, and a deposit as ft_transfer_call to the account with msg \"\"", () => {
  assert.deepEqual(mintTx(MUSDC, 'alice.testnet', '10000000000'), {
    receiverId: MUSDC,
    actions: [{ methodName: 'mint', args: { account_id: 'alice.testnet', amount: '10000000000' }, gas: `30${TGAS}`, deposit: '1250000000000000000000' }],
  });
  assert.deepEqual(depositTx(MUSDC, ALICE, '5000000'), {
    receiverId: MUSDC,
    actions: [{ methodName: 'ft_transfer_call', args: { receiver_id: ALICE, amount: '5000000', msg: '' }, gas: `100${TGAS}`, deposit: '1' }],
  });
});

test('a 1Click deposit registers the fresh deposit address, then pays it, in one transaction', () => {
  const address = 'a'.repeat(64);
  const tx = oneClickDepositTx('mnbtc.pbf-ops.testnet', address, '25000000');
  assert.equal(tx.receiverId, 'mnbtc.pbf-ops.testnet');
  assert.deepEqual(
    tx.actions.map((a) => [a.methodName, a.args, a.deposit]),
    [
      ['storage_deposit', { account_id: address, registration_only: true }, '1250000000000000000000'],
      ['ft_transfer', { receiver_id: address, amount: '25000000' }, '1'],
    ],
  );
});

test('the Hyperliquid side (INTERFACES.md 8): hl_init with 100 TGas and no deposit, the rest with 300 TGas', () => {
  assert.deepEqual(hlInitTx(ALICE), { receiverId: ALICE, actions: [{ methodName: 'hl_init', args: {}, gas: `100${TGAS}`, deposit: '0' }] });
  assert.deepEqual(requestAgentTx(ALICE).actions, [{ methodName: 'request_agent', args: {}, gas: `300${TGAS}`, deposit: '10000000000000000000000' }], '0.01 NEAR for OutLayer, as for a check');
  assert.deepEqual(hlApproveAgentTx(ALICE).actions, [{ methodName: 'hl_approve_agent', args: {}, gas: `300${TGAS}`, deposit: '1' }]);
  assert.deepEqual(hlWithdrawTx(ALICE, '9500000000', '0xFC9D786B69B900EC51DFE8EBBF19ED47BE59009D').actions, [
    { methodName: 'hl_withdraw', args: { amount: '9500000000', destination: '0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d' }, gas: `300${TGAS}`, deposit: '1' },
  ]);
});

test("the operator's pool settings (contracts/pool/src/admin.rs): no deposit, the pool's own JSON shapes", () => {
  const POOL = 'pool.pbf.testnet';
  assert.deepEqual(setKybTx(POOL, ALICE, 'acme-fund').actions, [{ methodName: 'set_kyb', args: { account_id: ALICE, entity: 'acme-fund' }, gas: `30${TGAS}`, deposit: '0' }]);
  assert.deepEqual(setKybTx(POOL, ALICE, null).actions[0]?.args, { account_id: ALICE, entity: null });
  assert.deepEqual(cosignBorrowTx(POOL, ALICE, '300000000000').actions[0]?.args, { request: { borrow: { account_id: ALICE, amount: '300000000000' } } });
  assert.deepEqual(setPausedTx(POOL, true).actions[0]?.args, { paused: true });
  assert.deepEqual(setCoinStatusTx(POOL, 'XRP', 'removed').actions[0]?.args, { coin: 'XRP', status: 'removed' });
  assert.deepEqual(setCoinStatusTx(POOL, 'SOL', 'reduce_only', true).actions[0]?.args, { coin: 'SOL', status: 'reduce_only', emergency: true });
  const freeze = setCoinStatusTx(POOL, 'nBTC', 'frozen');
  assert.equal(freeze.receiverId, POOL);
  assert.deepEqual(freeze.actions.map((a) => a.deposit), ['0'], 'admin methods are not payable');
});

test("the operator's pricing settings (INTERFACES.md 26): set_pricing for an account or a tier, and set_funding", () => {
  const POOL = 'pool.pbf.testnet';
  assert.deepEqual(setPricingTx(POOL, { account: ALICE }, { lender: { margin_bp: 0, cap_bp: 800 } }), {
    receiverId: POOL,
    actions: [{ methodName: 'set_pricing', args: { target: { account: ALICE }, pricing: { lender: { margin_bp: 0, cap_bp: 800 } } }, gas: `30${TGAS}`, deposit: '0' }],
  });
  assert.deepEqual(setPricingTx(POOL, { tier: 'STANDARD' }, { fixed: { rate_bp: 650 } }).actions[0]?.args, { target: { tier: 'STANDARD' }, pricing: { fixed: { rate_bp: 650 } } });
  assert.deepEqual(setPricingTx(POOL, { tier: 'WATCH' }, 'pass_through').actions[0]?.args, { target: { tier: 'WATCH' }, pricing: 'pass_through' });
  // null clears it.
  assert.deepEqual(setPricingTx(POOL, { account: ALICE }, null).actions[0]?.args, { target: { account: ALICE }, pricing: null });
  assert.deepEqual(setFundingTx(POOL, { order: 'lender_first', loan_days: 90 }).actions, [
    { methodName: 'set_funding', args: { funding: { order: 'lender_first', loan_days: 90 } }, gas: `30${TGAS}`, deposit: '0' },
  ]);
});

test("near-connect's action format wraps each call", () => {
  assert.deepEqual(connectorActions(borrowTx(ALICE, '1')), [{ type: 'FunctionCall', params: { methodName: 'borrow', args: { amount: '1' }, gas: `300${TGAS}`, deposit: '1' } }]);
});

test("an outcome's hash, logs and failure, in the contract's own words", () => {
  const ok = {
    transaction: { hash: 'H1' },
    status: { SuccessValue: '' },
    receipts_outcome: [{ outcome: { logs: ['verdict refused: nonce 2 is not the counter 3'], status: { SuccessValue: '' } } }, { outcome: { logs: [] } }],
  };
  assert.equal(txHash(ok), 'H1');
  assert.equal(txHash({ transaction_outcome: { id: 'H2' } }), 'H2');
  assert.deepEqual(txLogs(ok), ['verdict refused: nonce 2 is not the counter 3']);
  assert.equal(txFailure(ok), null);

  const panicked = {
    status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: amount is above the verdict\'s borrow allowance' } } } } },
  };
  assert.equal(txFailure(panicked), "Smart contract panicked: amount is above the verdict's borrow allowance");

  const inner = { status: { SuccessValue: '' }, receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { index: 0, kind: { AccountAlreadyExists: { account_id: ALICE } } } } } } }] };
  assert.match(txFailure(inner)!, /AccountAlreadyExists/);
});
