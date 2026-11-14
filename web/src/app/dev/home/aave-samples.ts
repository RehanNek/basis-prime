// Development only: sample answers for stage 3 (INTERFACES.md 33), Aave's test market on Base Sepolia through Chain
// Signatures: the account's address there (`evm` in GET /api/lender/:account), Aave's position with what it holds, a
// funding plan whose steps are signed Ethereum transactions, and Aave's room for each collateral token.
import type { EvmAnswer, EvmSigned, EvmToken, FundingPlanAnswer, LenderAccountAnswer, LenderName, LenderPosition, LenderTerms, Permission } from '@/lib/api';
import { blendedBp } from '@/lib/funding';
import type { EvmSignedEntry, FundingState, FundingStep } from '@/lib/types';

import { BTC_USD, POOL_RATE_BP, rheaPosition } from './samples';
import type { AaveState } from './states';

// INTERFACES.md 24 and 33: Aave's test tokens on Base Sepolia. WETH came in after the live try: its pool has room.
export const WBTC = { token: '0x54114591963CF60EF3aA63bEfD6eC263D98145a4', symbol: 'WBTC', decimals: 8 };
export const WETH = { token: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 };
export const AAVE_USDC = { token: '0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f', symbol: 'USDC', decimals: 6 };
/** The sample's ether price. */
export const ETH_USD = 3_000;
/** The account's address on Base Sepolia: its Hyperliquid address, the same key and path. */
export const EVM_ADDRESS = '0x8c01b1a86db01769c246d3739da0bb74ae3217fb';
/** Aave's test market in the sample: it lends USDC at 0.74% a year, and sells once a loan passes 83% of what is posted. */
export const AAVE_TEST_RATE_BP = 74;
const AAVE_TEST_SUPPLY_BP = 10;
const AAVE_LIQ_BP = 8_300;
const TARGET_HF_BP = 15_000;

const BOTH: Permission = { lenders: ['aave', 'rhea'], min_hf_bp: 15_000, max_rate_bp: 2_500, moves: 'any' };

/** What `units` of a token at the address are worth, in micro-USD, at the sample's prices. */
export function tokenMicro(token: string, units: bigint): bigint {
  if (token.toLowerCase() === WETH.token.toLowerCase()) return (units * BigInt(ETH_USD)) / 10n ** 12n;
  if (token.toLowerCase() === WBTC.token.toLowerCase()) return (units * BigInt(BTC_USD)) / 100n;
  return units;
}

/** What Aave lends against this much collateral (micro-USD) at the engine's cushion of 1.5. */
export const aaveLends = (posted: bigint): bigint => (posted * BigInt(AAVE_LIQ_BP)) / BigInt(TARGET_HF_BP);

/** The account at Aave: what it holds by token, and what is owed, in micro-USD. */
export function aavePosition(held: { token: string; symbol: string; decimals: number; amount: bigint }[], debt: bigint): LenderPosition {
  const posted = held.reduce((sum, h) => sum + tokenMicro(h.token, h.amount), 0n);
  const hf = debt > 0n ? Number((posted * BigInt(AAVE_LIQ_BP)) / debt) : 0;
  const room = aaveLends(posted) - debt;
  return {
    l: 'aave', posted: Number(posted), debt: Number(debt), hf_bp: hf, liq_bp: AAVE_LIQ_BP, rate_bp: AAVE_TEST_RATE_BP, supply_bp: AAVE_TEST_SUPPLY_BP, room: Number(room > 0n ? room : 0n),
    status: debt === 0n ? 'none' : hf < 12_000 ? 'act' : hf < 13_500 ? 'thin' : 'safe',
    held: held.filter((h) => h.amount > 0n).map((h) => ({ token: h.token, symbol: h.symbol, decimals: h.decimals, amount: h.amount.toString() })),
  };
}

const wallet = (weth: bigint, wbtc: bigint, usdc: bigint): EvmToken[] => [
  { ...WETH, amount: weth.toString() },
  { ...WBTC, amount: wbtc.toString() },
  { ...AAVE_USDC, amount: usdc.toString() },
];

/** `evm` in GET /api/lender/:account: the address, its gas in wei, what sits there, and what the account signed. */
function evmSample(over: Partial<EvmAnswer>): EvmAnswer {
  return { address: EVM_ADDRESS, nonce: 0, chain_nonce: 0, eth: '0', wallet: wallet(0n, 0n, 0n), signed: [], ...over };
}

/** 0.02 test WETH, $60 at the sample's price: Aave lends $33.20 against it at a cushion of 1.5. */
const POSTED_WETH = 20_000_000_000_000_000n;
const OWED = aaveLends(tokenMicro(WETH.token, POSTED_WETH));
const PLAN_ID = 'f999950';

const mined = (nonce: number, kind: string, token: string, amount: string | null, step: string | null = null): EvmSigned => ({ nonce, kind, token, amount, hash: `0xsample${nonce}${kind}`, status: 'mined', step });

/** A funding plan for $500 with Aave: post 0.02 WETH there, borrow $33.20 from Aave, and the rest from our pool. */
function planSample(done: boolean[], storedMsAgo: number): FundingState {
  const stored = Date.now() - storedMsAgo;
  const steps: FundingStep[] = [
    { k: 'l_supply', l: 'aave', tok: WETH.token, amt: POSTED_WETH.toString() },
    { k: 'l_borrow', l: 'aave', amt: Number(OWED) },
    { k: 'p_borrow', amt: 500_000_000 - Number(OWED) },
  ];
  return { pid: PLAN_ID, amount: '500000000', stored_at: `${stored}000000`, expires_at: `${stored + 30 * 60_000}000000`, steps: steps.map((s, i) => ({ ...s, done: Boolean(done[i]) })) };
}

/** GET /api/lender/:account for stage 3's states: an account whose config has both lenders, with the default permission. */
export function aaveAccountSample(account: string, state: AaveState): LenderAccountAnswer {
  const base = {
    account, read_at_ms: Date.now(), config_lenders: ['aave', 'rhea'] as LenderName[], permission: BOTH, verdict_blk: 999_950, funding: null,
    pricing: { pricing: 'pass_through' as const, from: 'default' as const, fees_charged: '0', subsidy_paid: '0', credit: '0', settled_at: '0', last: [] },
  };
  const approve = mined(0, 'approve', WETH.token, null);
  const supply = mined(1, 'supply', WETH.token, POSTED_WETH.toString(), `${PLAN_ID}:0`);
  switch (state) {
    // A loan on its way: the collateral is posted and mined; the borrow is signed and not yet sent.
    case 'aave-plan':
      return {
        ...base,
        funding: planSample([true, true, false], 4 * 60_000),
        lenders: [aavePosition([{ ...WETH, amount: POSTED_WETH }], 0n)],
        evm: evmSample({
          nonce: 3, chain_nonce: 2, eth: '1800000000000000',
          signed: [approve, supply, { nonce: 2, kind: 'borrow', token: AAVE_USDC.token, amount: OWED.toString(), hash: '0xsample2borrow', status: 'signed', step: `${PLAN_ID}:1` }],
        }),
      };
    // One loan from all three: $800 from our pool, $192.53 from Rhea, $33.20 from Aave. The Aave loan sits at the address.
    case 'three':
      return {
        ...base,
        lenders: [aavePosition([{ ...WETH, amount: POSTED_WETH }], OWED), rheaPosition(456_000_000n, 192_533_333n)],
        evm: evmSample({
          nonce: 3, chain_nonce: 3, eth: '1600000000000000', wallet: wallet(5_000_000_000_000_000n, 0n, OWED),
          signed: [approve, supply, mined(2, 'borrow', AAVE_USDC.token, OWED.toString(), `${PLAN_ID}:1`)],
        }),
      };
    // Hedged and ready, with nothing at the address yet: the testnet step gets test collateral first.
    default:
      return { ...base, lenders: [], evm: evmSample({}) };
  }
}

/** get_state().evm, the account's own list: the same transactions with the plan step that signed each. */
export function ownEvmSample(evm: EvmAnswer | null | undefined): { nonce: number; signed: EvmSignedEntry[]; approved: string[] } | null {
  if (!evm) return null;
  const approved = [...new Set(evm.signed.filter((e) => e.kind === 'approve' && e.token).map((e) => e.token!.toLowerCase()))];
  return { nonce: evm.nonce ?? 0, approved, signed: evm.signed.map((e) => ({ nonce: e.nonce, kind: e.kind, token: e.token, amount: e.amount, to: null, raw: '0x02', hash: e.hash, step: e.step ?? null, signed_at: '0' })) };
}

/**
 * What Aave's test pool can still take of each collateral token (`collateral_room` on Aave's testnet row of
 * GET /api/lenders). As found on 11 Nov, its pool for WBTC is capped at 175 and full, and WETH has no cap. `open`
 * gives the pool room for bitcoin instead.
 */
export function collateralRoom(open: boolean): NonNullable<LenderTerms['collateral_room']> {
  return [
    { ...WBTC, room: open ? '250000000' : '0' },
    { ...WETH, room: null },
  ];
}

const least = (a: bigint, b: bigint) => (a < b ? a : b);
const atLeastZero = (x: bigint) => (x > 0n ? x : 0n);

/**
 * POST /api/funding-plan for an account that can borrow at Aave: Aave is the cheapest source, so it lends first,
 * against what it already holds and then against just enough of the collateral waiting at the address. Our pool lends
 * the rest, up to what the account can borrow. Amounts are micro-USD.
 */
export function aavePlanSample(amount: string, most: bigint, at: { posted: bigint; owed: bigint; spare: EvmToken | null }): FundingPlanAnswer {
  const asked = BigInt(amount);
  const total = least(asked, most);
  const spare = at.spare ? tokenMicro(at.spare.token, BigInt(at.spare.amount)) : 0n;
  const roomPosted = atLeastZero(aaveLends(at.posted) - at.owed);
  const fromAave = least(total, atLeastZero(aaveLends(at.posted + spare) - at.owed));
  // The collateral to post first: what the part above the posted room needs at a cushion of 1.5, in the token's units.
  const toPost = fromAave > roomPosted && at.spare && spare > 0n ? least(BigInt(at.spare.amount), ((fromAave - roomPosted) * BigInt(TARGET_HF_BP) * BigInt(at.spare.amount)) / (BigInt(AAVE_LIQ_BP) * spare) + 1n) : 0n;
  const fromPool = total - fromAave;
  const sources: NonNullable<FundingPlanAnswer['sources']> = [];
  const steps: FundingStep[] = [];
  if (toPost > 0n && at.spare) steps.push({ k: 'l_supply', l: 'aave', tok: at.spare.token, amt: toPost.toString() });
  if (fromAave > 0n) {
    sources.push({ source: 'aave', amount: Number(fromAave), rate_bp: AAVE_TEST_RATE_BP });
    steps.push({ k: 'l_borrow', l: 'aave', amt: Number(fromAave) });
  }
  if (fromPool > 0n) {
    sources.push({ source: 'pool', amount: Number(fromPool), rate_bp: POOL_RATE_BP });
    steps.push({ k: 'p_borrow', amt: Number(fromPool) });
  }
  const hf = at.owed > 0n ? Number((at.posted * BigInt(AAVE_LIQ_BP)) / at.owed) : 0;
  const ext = [{ l: 'aave', c: Number(at.posted), d: Number(at.owed), hf_bp: hf, r_bp: AAVE_TEST_RATE_BP, s_bp: AAVE_TEST_SUPPLY_BP, room: Number(roomPosted), liq_bp: AAVE_LIQ_BP }];
  return { asked: amount, total: Number(total), sources, steps, ext, blended_bp: blendedBp(sources), verdict: { ok: true }, run: { call_id: null, compute_cost: null, time_ms: 600, attestation_url: null } };
}
