// The transactions the web app asks the wallet to sign (INTERFACES.md 3-4, and 25-26 for Phase 6), built as plain
// data so they can be checked against the spec without a wallet. The backend signs nothing: every one of these goes
// through near-connect in the browser.
import type { FundingSettings, Pricing, PricingTarget } from './api.ts';
import type { Intent, Permission } from './types.ts';

const TGAS = 10n ** 12n;
const tgas = (n: number) => (BigInt(n) * TGAS).toString();

/** Gas per call. Unused gas comes back, so methods that call other contracts get the most a call may carry. */
export const GAS = {
  /** INTERFACES.md 3: create_account needs 300 TGas. */
  createAccount: tgas(300),
  /** request_check, borrow, repay and withdraw all call other contracts and wait for callbacks. */
  accountCall: tgas(300),
  /** A deposit: the token calls the account's ft_on_transfer. */
  ftTransferCall: tgas(100),
  /** mint, storage_deposit and ft_transfer only touch the token. */
  tokenCall: tgas(30),
  /** INTERFACES.md 8: hl_init calls the MPC signer's derived_public_key and a callback; attach 100 TGas. */
  hlInit: tgas(100),
  /** request_agent (OutLayer), hl_approve_agent and hl_withdraw (the MPC signer): attach 300 TGas. */
  hlCall: tgas(300),
  /** set_permission, fund and cancel_funding change only the account's own state. */
  ownCall: tgas(100),
} as const;

/** Deposits in yoctoNEAR. */
export const DEPOSIT = {
  /**
   * INTERFACES.md 24, point 9: at least 6 NEAR, since the account's code grew in Phase 6. About 4.7 NEAR stays as the
   * account's storage, and the factory refunds on failure.
   */
  createAccount: '6000000000000000000000000',
  /** INTERFACES.md 4: at least 0.01 NEAR; it pays OutLayer, which refunds the unused part. */
  check: '10000000000000000000000',
  /** Every owner method that moves funds asks for exactly 1 yoctoNEAR, so only a full-access key can call it. */
  oneYocto: '1',
  /**
   * INTERFACES.md 25 names no deposit for these two, so they are as the account contract has them
   * (contracts/account/src/lib.rs, read 11 Nov): lender_repay asks for 1 yoctoNEAR, as `repay` does, and claim_credit
   * takes no deposit at all, so attaching one would be refused.
   */
  lenderRepay: '1',
  claimCredit: '0',
  /**
   * evm_approve (stage 3) is open to anyone and INTERFACES.md 33 names no deposit. The contract wasn't written when
   * this was: no deposit, as `hl_init`, the account's other call open to anyone, takes none. Change it here if it asks.
   */
  evmApprove: '0',
  /** The test tokens' storage_balance_bounds().min (0.00126 NEAR): mint registers an account with it, and returns it if already registered. */
  tokenStorage: '1250000000000000000000',
} as const;

export interface FunctionCall {
  methodName: string;
  args: Record<string, unknown>;
  gas: string;
  deposit: string;
}

/** One transaction: calls to one contract, signed together. */
export interface Tx {
  receiverId: string;
  actions: FunctionCall[];
}

const call = (methodName: string, args: Record<string, unknown>, gas: string, deposit: string): FunctionCall => ({ methodName, args, gas, deposit });

/**
 * Factory: creates <name>.<factory> for `owner`. With a `permission` (INTERFACES.md 25), the factory hands it to the
 * new account, so one signature opens the account and signs the permission. Left out, the account has none.
 */
export function createAccountTx(factory: string, name: string, owner: string, permission?: Permission | null): Tx {
  return { receiverId: factory, actions: [call('create_account', { name, owner, ...(permission && { permission }) }, GAS.createAccount, DEPOSIT.createAccount)] };
}

/** Account: asks pb-risk for a verdict on `intent`. Anyone may call it. */
export function requestCheckTx(account: string, intent: Intent): Tx {
  return { receiverId: account, actions: [call('request_check', { intent }, GAS.accountCall, DEPOSIT.check)] };
}

/** Account: borrows `amount` mUSDC units against its fresh borrow verdict. */
export function borrowTx(account: string, amount: string): Tx {
  return { receiverId: account, actions: [call('borrow', { amount }, GAS.accountCall, DEPOSIT.oneYocto)] };
}

/** Account: repays the pool from the account's mUSDC. The pool sends back anything above the debt. */
export function repayTx(account: string, amount: string): Tx {
  return { receiverId: account, actions: [call('repay', { amount }, GAS.accountCall, DEPOSIT.oneYocto)] };
}

/**
 * Phase 4 (INTERFACES.md 14): a move to Hyperliquid names its kind and its quote's expiry, so the account records it.
 * Stage 4 (INTERFACES.md 36): so does a move to the account's address on Aave's chain, `to_evm`.
 */
export interface MoveTransfer {
  /** `sell` (INTERFACES.md 49.2): the Spot page's sale of a token other than USDC. */
  kind: 'to_hl' | 'to_evm' | 'sell';
  exp: number;
  /** Only a `sell` takes it: what its quote says will arrive (INTERFACES.md 47.3). */
  expect?: { token: string; amount: string };
}

/**
 * INTERFACES.md 40.1 (the second audit's A7): the account records a move only if its quote's expiry is at most 24
 * hours after the block's time, and refuses the call otherwise. A 1Click quote lives a day at most.
 */
export const MAX_QUOTE_LIFE_MS = 24 * 60 * 60_000;

/**
 * Why the app won't build a move whose quote expires at `exp` (unix ms), or null when it will. The app's own quotes
 * expire minutes ahead, so this should never show: it is here so that a call the account would refuse is said in
 * plain words and not sent.
 */
export function moveExpiryProblem(exp: number, nowMs: number): string | null {
  return exp - nowMs > MAX_QUOTE_LIFE_MS
    ? 'This quote expires more than 24 hours from now. The account takes a move only when its quote ends within a day, so nothing was sent: ask for a new quote.'
    : null;
}

/** A builder's refusal of a move. Its message is for the client. */
export class MoveRefused extends Error {}

function assertQuoteLife(exp: number | undefined, nowMs: number) {
  const problem = exp === undefined ? null : moveExpiryProblem(exp, nowMs);
  if (problem) throw new MoveRefused(problem);
}

/**
 * INTERFACES.md 47.3 (the second audit's A12): what a move home's quote says will arrive on NEAR, a listed token and
 * its amount in that token's units. It is the optional last argument of `hl_withdraw` and `evm_withdraw`: the account
 * records it, so that a stranger's one-unit deposit with the transfer's msg can't settle the transfer early. An
 * account from before the fix ignores the argument, so the app sends it whenever the quote carries it.
 */
export interface MoveExpect {
  token: string;
  amount: string;
}

/** The `expect` argument of a call, or nothing: a quote from an older backend carries none, and the call then has no such key. */
const expectArg = (expect: MoveExpect | null | undefined): { expect?: MoveExpect } => (expect ? { expect: { token: expect.token, amount: expect.amount } } : {});

/** A move's transaction, or the reason the app won't build it, for a page to show in place of the send button. */
export function buildMove(build: () => Tx): { tx: Tx; problem: null } | { tx: null; problem: string } {
  try {
    return { tx: build(), problem: null };
  } catch (error) {
    if (error instanceof MoveRefused) return { tx: null, problem: error.message };
    throw error;
  }
}

/**
 * Account: sends `amount` of `token` to `receiver`. With no loan it needs no verdict. A move to Hyperliquid on a
 * Phase 4 account also passes `transfer`, and the account records the move as a pending transfer. A move to Aave's
 * chain (stage 4) is the same call with `transfer: {"kind": "to_evm", "exp"}`, for nBTC or USDC.
 *
 * With a `transfer` whose `exp` is more than 24 hours after `nowMs`, it throws `MoveRefused` (INTERFACES.md 40.5).
 */
export function withdrawTx(account: string, token: string, amount: string, receiver: string, transfer?: MoveTransfer, nowMs: number = Date.now()): Tx {
  assertQuoteLife(transfer?.exp, nowMs);
  return { receiverId: account, actions: [call('withdraw', { token, amount, receiver, ...(transfer && { transfer }) }, GAS.accountCall, DEPOSIT.oneYocto)] };
}

// ---------- Phase 6 (INTERFACES.md 25): funding from lenders. Owner calls on the account, 1 yoctoNEAR each. ----------

/**
 * Account (owner): replaces the funding permission, or cancels it with null. Since the audit fix (INTERFACES.md
 * 40.1) it leaves the counter alone and the account records the block instead (`permission_blk`): `fund` then needs
 * a check read after that block.
 */
export function setPermissionTx(account: string, permission: Permission | null): Tx {
  return { receiverId: account, actions: [call('set_permission', { permission }, GAS.ownCall, DEPOSIT.oneYocto)] };
}

/**
 * Account (owner): stores the fresh `fund` verdict's steps as the funding plan, for a loan of `amount` micro-USD in
 * all. It moves no money: the keeper runs the steps with execute_step.
 */
export function fundTx(account: string, amount: string): Tx {
  return { receiverId: account, actions: [call('fund', { amount }, GAS.ownCall, DEPOSIT.oneYocto)] };
}

/** Account (owner): drops the funding plan. Steps that have started stay as they are. */
export function cancelFundingTx(account: string): Tx {
  return { receiverId: account, actions: [call('cancel_funding', {}, GAS.ownCall, DEPOSIT.oneYocto)] };
}

/**
 * Account: repays `lender` up to `amount` micro-USD from the account's USDC, with 1 yoctoNEAR. The owner, and anyone
 * when `repay` is open to anyone. Rhea takes at most the debt and keeps the rest as the account's plain deposit there,
 * so the page sends no more than is owed.
 */
export function lenderRepayTx(account: string, lender: string, amount: string): Tx {
  return { receiverId: account, actions: [call('lender_repay', { lender, amount }, GAS.accountCall, DEPOSIT.lenderRepay)] };
}

/**
 * Account (owner): takes `amount` units of `token` back from `lender`. While the account owes our pool it needs a
 * fresh verdict that answers this same lender_withdraw.
 */
export function lenderWithdrawTx(account: string, lender: string, token: string, amount: string): Tx {
  return { receiverId: account, actions: [call('lender_withdraw', { lender, token, amount }, GAS.accountCall, DEPOSIT.oneYocto)] };
}

/** Account (owner): has the pool pay the account its credit, in USDC. No deposit: the method takes none. */
export function claimCreditTx(account: string): Tx {
  return { receiverId: account, actions: [call('claim_credit', {}, GAS.accountCall, DEPOSIT.claimCredit)] };
}

// ---------- Stage 3 (INTERFACES.md 33): the account's address on Aave's chain, through Chain Signatures ----------

/**
 * Account (owner, 1 yoctoNEAR): signs a transfer of `amount` of a config token from the account's address on Aave's
 * chain to `to`, a 0x address there. While the account owes our pool it needs a fresh verdict answering this
 * evm_withdraw. The MPC signer signs it, so it gets the gas a Hyperliquid signature gets.
 *
 * Stage 4 (INTERFACES.md 36): with `exp`, the expiry in unix ms of the 1Click quote whose deposit address is `to`,
 * the account records the move home as a pending transfer. Without it, it is the plain call. An `exp` more than 24
 * hours after `nowMs` throws `MoveRefused` (INTERFACES.md 40.5).
 */
export function evmWithdrawTx(account: string, token: string, amount: string, to: string, exp?: number, nowMs: number = Date.now(), expect?: MoveExpect | null): Tx {
  assertQuoteLife(exp, nowMs);
  return { receiverId: account, actions: [call('evm_withdraw', { token, amount, to, ...(exp !== undefined && { exp }), ...expectArg(expect) }, GAS.hlCall, DEPOSIT.oneYocto)] };
}

/**
 * Account (owner, 1 yoctoNEAR; INTERFACES.md 14): drops the pending transfer `id` (`move:<n>`) once it is overdue.
 * A transfer that failed returns nothing, so without this it would hold back borrowing for good. It changes only the
 * account's own state.
 */
export function forgetTransferTx(account: string, id: string): Tx {
  return { receiverId: account, actions: [call('forget_transfer', { id }, GAS.ownCall, DEPOSIT.oneYocto)] };
}

/**
 * Account (anyone): signs the one-time approval that lets Aave's pool take `token` from the address, which a supply or
 * a repayment of that token needs. INTERFACES.md 33 names no deposit for it, so none is attached.
 */
export function evmApproveTx(account: string, token: string): Tx {
  return { receiverId: account, actions: [call('evm_approve', { token }, GAS.hlCall, DEPOSIT.evmApprove)] };
}

/** Test token (testnet): the public faucet. The storage deposit registers `accountId` if it isn't yet. */
export function mintTx(token: string, accountId: string, amount: string): Tx {
  return { receiverId: token, actions: [call('mint', { account_id: accountId, amount }, GAS.tokenCall, DEPOSIT.tokenStorage)] };
}

/** Token: deposits from the wallet into the account. msg "" is a plain deposit (INTERFACES.md 4). */
export function depositTx(token: string, account: string, amount: string): Tx {
  return { receiverId: token, actions: [call('ft_transfer_call', { receiver_id: account, amount, msg: '' }, GAS.ftTransferCall, DEPOSIT.oneYocto)] };
}

/** Account (anyone): derives and stores the account's Hyperliquid address through Chain Signatures. No deposit. */
export function hlInitTx(account: string): Tx {
  return { receiverId: account, actions: [call('hl_init', {}, GAS.hlInit, '0')] };
}

/** Account (owner): asks pb-gateway, on-chain, for this account's agent address. 0.01 NEAR goes to OutLayer, as for a check. */
export function requestAgentTx(account: string): Tx {
  return { receiverId: account, actions: [call('request_agent', {}, GAS.hlCall, DEPOSIT.check)] };
}

/** Account (owner): has the MPC signer sign Hyperliquid's ApproveAgent for the stored agent. */
export function hlApproveAgentTx(account: string): Tx {
  return { receiverId: account, actions: [call('hl_approve_agent', {}, GAS.hlCall, DEPOSIT.oneYocto)] };
}

/**
 * Account (owner): has the MPC signer sign a sendAsset of `amount` micro-USDC to `destination`. Refused with a loan.
 * On a Phase 4 account, `exp` (the quote's expiry, ms) makes the account record the move as a pending transfer. An
 * `exp` more than 24 hours after `nowMs` throws `MoveRefused` (INTERFACES.md 40.5).
 */
export function hlWithdrawTx(account: string, amount: string, destination: string, exp?: number, nowMs: number = Date.now(), expect?: MoveExpect | null): Tx {
  assertQuoteLife(exp, nowMs);
  return { receiverId: account, actions: [call('hl_withdraw', { amount, destination: destination.toLowerCase(), ...(exp !== undefined && { exp }), ...expectArg(expect) }, GAS.hlCall, DEPOSIT.oneYocto)] };
}

/** The drill contract (testnet; INTERFACES.md 5): its owner sets the nBTC/BTC ratio, in basis points. No deposit. */
export function setRatioTx(drill: string, bp: number): Tx {
  return { receiverId: drill, actions: [call('set_ratio', { bp }, GAS.tokenCall, '0')] };
}

// ---------- the operator's pool settings (contracts/pool/src/admin.rs): operator only, no deposit ----------

/** Records an account's KYB flag with an entity id, or clears it with null (a Preferred account drops to Standard). */
export function setKybTx(pool: string, accountId: string, entity: string | null): Tx {
  return { receiverId: pool, actions: [call('set_kyb', { account_id: accountId, entity }, GAS.tokenCall, '0')] };
}

/** Co-signs one borrow above the pool's co-signature threshold. Used once. In JSON: {"borrow":{account_id, amount}}. */
export function cosignBorrowTx(pool: string, accountId: string, amount: string): Tx {
  return { receiverId: pool, actions: [call('cosign', { request: { borrow: { account_id: accountId, amount } } }, GAS.tokenCall, '0')] };
}

/** Pauses (or resumes) new loans and plan steps. Repaying is never paused. */
export function setPausedTx(pool: string, paused: boolean): Tx {
  return { receiverId: pool, actions: [call('set_paused', { paused }, GAS.tokenCall, '0')] };
}

export type CoinStatus = 'allowed' | 'reduce_only' | 'removed' | 'frozen';

/** A coin's status (allowed, reduce-only or removed) or a bridged token's (allowed or frozen). */
export function setCoinStatusTx(pool: string, coin: string, status: CoinStatus, emergency = false): Tx {
  const args: Record<string, unknown> = { coin, status };
  if (status === 'reduce_only' && emergency) args.emergency = true;
  return { receiverId: pool, actions: [call('set_coin_status', args, GAS.tokenCall, '0')] };
}

// ---------- the operator's pricing settings (INTERFACES.md 26, stage 2): operator only, no deposit ----------

/** What one account, or a whole tier, pays on a lender's part of a loan. `null` clears it: the tier's then applies, else pass-through. */
export function setPricingTx(pool: string, target: PricingTarget, pricing: Pricing | null): Tx {
  return { receiverId: pool, actions: [call('set_pricing', { target, pricing }, GAS.tokenCall, '0')] };
}

/** The order the engine fills a loan's sources in, and how many days a loan is expected to last. */
export function setFundingTx(pool: string, funding: FundingSettings): Tx {
  return { receiverId: pool, actions: [call('set_funding', { funding }, GAS.tokenCall, '0')] };
}

/**
 * Token: pays a 1Click deposit address. The address is a fresh account the token has never seen, so the
 * sender registers it first, as with the real 1Click (PLAN.md 5.4, "As built").
 */
export function oneClickDepositTx(token: string, depositAddress: string, amount: string): Tx {
  return {
    receiverId: token,
    actions: [
      call('storage_deposit', { account_id: depositAddress, registration_only: true }, GAS.tokenCall, DEPOSIT.tokenStorage),
      call('ft_transfer', { receiver_id: depositAddress, amount }, GAS.tokenCall, DEPOSIT.oneYocto),
    ],
  };
}

/** The same transaction in near-connect's action format. */
export function connectorActions(tx: Tx) {
  return tx.actions.map((params) => ({ type: 'FunctionCall' as const, params }));
}

/** The parts of a FinalExecutionOutcome the app reads. */
export interface Outcome {
  transaction?: { hash?: string };
  transaction_outcome?: { id?: string };
  status?: unknown;
  receipts_outcome?: { id?: string; outcome?: { logs?: string[]; status?: unknown } }[];
}

export function txHash(outcome: Outcome | undefined): string | undefined {
  return outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id;
}

/** Every log line the transaction's receipts left: the account says here which verdict check failed. */
export function txLogs(outcome: Outcome | undefined): string[] {
  return (outcome?.receipts_outcome ?? []).flatMap((r) => r.outcome?.logs ?? []);
}

/** Why the transaction or one of its receipts failed, in the contract's words, or null if nothing did. */
export function txFailure(outcome: Outcome | undefined): string | null {
  const failures = [outcome?.status, ...(outcome?.receipts_outcome ?? []).map((r) => r.outcome?.status)]
    .map((status) => (status && typeof status === 'object' && 'Failure' in status ? (status as { Failure: unknown }).Failure : undefined))
    .filter((failure) => failure !== undefined);
  return failures.length ? describeFailure(failures[0]) : null;
}

/**
 * A contract's own words, e.g. "Smart contract panicked: amount is above the verdict's borrow allowance",
 * from wherever the TxExecutionError keeps them; otherwise the error itself, whose name says enough.
 */
function describeFailure(failure: unknown): string {
  if (typeof failure === 'string') return failure;
  return executionError(failure) ?? JSON.stringify(failure).slice(0, 300);
}

function executionError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const fields = value as Record<string, unknown>;
  if (typeof fields.ExecutionError === 'string') return fields.ExecutionError;
  for (const inner of Object.values(fields)) {
    const found = executionError(inner);
    if (found) return found;
  }
  return null;
}
