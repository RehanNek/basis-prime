// Development only: sample answers for Phase 6's three endpoints (INTERFACES.md 28) and a credit check with `funding`
// (INTERFACES.md 27), built to the shapes as written, so the new pieces can be seen without a backend. Stage 2 adds an
// account that borrows from Rhea, its funding plan, the pool's pricing for it, and GET /api/pricing.
import type { CreditAnswer, CreditFunding, FundingPlanAnswer, LenderAccountAnswer, LenderName, LenderPosition, LendersAnswer, Permission, Pricing, PricingAnswer, PricingView } from '@/lib/api';
import { blendedBp } from '@/lib/funding';
import type { FundingState, FundingStep } from '@/lib/types';

import { isLenderState, type LenderState, type RheaState } from './states';

/** The app's default terms (INTERFACES.md 24). */
const PERMISSION: Permission = { lenders: ['aave', 'rhea'], min_hf_bp: 15_000, max_rate_bp: 2_500, moves: 'any' };
/** The same terms for an account whose config has Rhea alone, as on testnet in stage 2. */
export const RHEA_PERMISSION: Permission = { ...PERMISSION, lenders: ['rhea'] };

export const AAVE_RATE_BP = 533;
/** Rhea's USDC rates in FUNDING.md 2: it charges borrowers 15.91% and pays depositors 10.32%. */
export const RHEA_RATE_BP = 1_591;
export const RHEA_SUPPLY_BP = 1_032;
/** The sample pool's Standard rate in the lender states: FUNDING.md 2's 6.50%. */
export const POOL_RATE_BP = 650;
export const NBTC_ID = 'mnbtc.pbf-ops.testnet';
/** The sample's bitcoin price, and Rhea's rule: it lends up to 76% of the bitcoin's value, and the engine stops at a cushion of 1.5. */
export const BTC_USD = 76_000;
const RHEA_LIQ_BP = 7_600;
const TARGET_HF_BP = 15_000;
/** The demo's policy for Rhea (FUNDING.md 15): the lender's rate, but never above 8%. */
export const RHEA_CAP: Pricing = { lender: { margin_bp: 0, cap_bp: 800 } };

// Aave's cushion is posted × 85% ÷ owed: 1.50 with $570 posted against $323, then 1.24 and 1.12 as bitcoin falls.
const aave = (posted: number, hf_bp: number, status: LenderPosition['status'], room = 0): LenderPosition => ({
  l: 'aave', posted, debt: 323_000_000, hf_bp, liq_bp: 8_500, rate_bp: AAVE_RATE_BP, supply_bp: 410, room, status,
  // The backend reads no collateral at Aave until stage 3.
  held: [],
});

const POSITIONS: Record<LenderState, LenderPosition[]> = {
  lenders: [aave(570_000_000, 15_000, 'safe', 180_000_000)],
  'lender-thin': [
    aave(471_200_000, 12_400, 'thin'),
    // Rhea's cushion is posted × 76% ÷ owed.
    {
      l: 'rhea', posted: 380_000_000, debt: 192_530_000, hf_bp: 15_000, liq_bp: 7_600, rate_bp: 1_591, supply_bp: 1_032, room: 0, status: 'safe',
      held: [{ token: 'mnbtc.pbf-ops.testnet', symbol: 'nBTC', decimals: 8, amount: '500000' }], deposit: '0',
    },
  ],
  'lender-act': [aave(425_600_000, 11_200, 'act')],
};

/** Test ETH on NEAR, which an account made since 14 Nov may post at Rhea (INTERFACES.md 51.1). */
export const METH_ID = 'meth.pbf-ops.testnet';

/** Micro-USD of bitcoin as nBTC units (8 decimals), at the sample price. */
export const nbtcUnits = (micro: bigint): bigint => (micro * 100n) / BigInt(BTC_USD);
/** The other way: nBTC units as micro-USD. */
export const nbtcMicro = (units: bigint): bigint => (units * BigInt(BTC_USD)) / 100n;
/** What Rhea lends against this much bitcoin (micro-USD) at the engine's cushion of 1.5. */
export const rheaLends = (posted: bigint): bigint => (posted * BigInt(RHEA_LIQ_BP)) / BigInt(TARGET_HF_BP);

/**
 * The account at Rhea: `posted` and `debt` in micro-USD. With nothing owed there is no cushion to show. `deposit` is
 * USDC lying there as a plain deposit, which a repayment above the debt leaves.
 */
export function rheaPosition(posted: bigint, debt: bigint, deposit = 0n): LenderPosition {
  const hf = debt > 0n ? Number((posted * BigInt(RHEA_LIQ_BP)) / debt) : 0;
  const room = rheaLends(posted) - debt;
  return {
    l: 'rhea', posted: Number(posted), debt: Number(debt), hf_bp: hf, liq_bp: RHEA_LIQ_BP, rate_bp: RHEA_RATE_BP, supply_bp: RHEA_SUPPLY_BP, room: Number(room > 0n ? room : 0n),
    status: debt === 0n ? 'none' : hf < 12_000 ? 'act' : hf < 13_500 ? 'thin' : 'safe',
    // Stage 2, from Rhea's own record: the collateral there in the token's own units, and the plain deposit.
    held: posted > 0n ? [{ token: NBTC_ID, symbol: 'nBTC', decimals: 8, amount: nbtcUnits(posted).toString() }] : [],
    deposit: deposit.toString(),
  };
}

/** The pool's `get_pricing` for the sample account. */
function pricingView(pricing: Pricing, from: PricingView['from'], credit = '0'): PricingView {
  return { pricing, from, fees_charged: '0', subsidy_paid: credit === '0' ? '0' : '13140000', credit, settled_at: `${Date.now() - 20 * 60_000}000000`, last: [] };
}

/** $380 of bitcoin posted with Rhea (0.005 nBTC), which lends $192.53 against it at a cushion of 1.5. */
const POSTED = 380_000_000n;
const OWED = rheaLends(POSTED);
/** $456 of bitcoin (0.006 nBTC), for the states with a loan already running. */
const POSTED_WIDE = 456_000_000n;

/** A funding plan for $500: post 0.005 nBTC with Rhea, borrow $192.53 there, and $307.47 from our pool. */
export function planSample(done: boolean[], storedMsAgo: number): FundingState {
  const stored = Date.now() - storedMsAgo;
  const steps: FundingStep[] = [
    { k: 'l_supply', l: 'rhea', tok: NBTC_ID, amt: nbtcUnits(POSTED).toString() },
    { k: 'l_borrow', l: 'rhea', amt: Number(OWED) },
    { k: 'p_borrow', amt: 500_000_000 - Number(OWED) },
  ];
  return { pid: 'f999950', amount: '500000000', stored_at: `${stored}000000`, expires_at: `${stored + 30 * 60_000}000000`, steps: steps.map((s, i) => ({ ...s, done: Boolean(done[i]) })) };
}

/** GET /api/lender/:account for stage 2's states: an account whose config has Rhea, with the default permission. */
function rheaAccountSample(account: string, state: RheaState): LenderAccountAnswer {
  const base = { account, read_at_ms: Date.now(), config_lenders: ['rhea'] as LenderName[], permission: RHEA_PERMISSION, verdict_blk: 999_950 };
  switch (state) {
    case 'fund':
      return { ...base, funding: null, lenders: [], pricing: pricingView(RHEA_CAP, 'account') };
    case 'plan':
      return { ...base, funding: planSample([true, false, false], 6 * 60_000), lenders: [rheaPosition(POSTED, 0n)], pricing: pricingView('pass_through', 'default') };
    case 'plan-expired':
      return { ...base, funding: planSample([true, false, false], 35 * 60_000), lenders: [rheaPosition(POSTED, 0n)], pricing: pricingView('pass_through', 'default') };
    // A loan with a little room: 0.006 nBTC posted against the same $192.53, a cushion of 1.80. Taking 0.001 nBTC back
    // leaves 1.50, which the engine allows; more than that it refuses.
    case 'credit':
      return { ...base, funding: null, lenders: [rheaPosition(POSTED_WIDE, OWED)], pricing: pricingView(RHEA_CAP, 'account', '12340000') };
    // Leaving Rhea: the same loan, and $0.37 that an earlier repayment left there as a deposit.
    case 'leave':
      return { ...base, funding: null, lenders: [rheaPosition(POSTED_WIDE, OWED, 370_000n)], pricing: pricingView('pass_through', 'default') };
    // INTERFACES.md 51.1: the same loan against test ETH. Rhea counts ether at 75%, so $456 posted and $192.53 owed is a cushion of 1.78.
    case 'rhea-eth': {
      const position = rheaPosition(POSTED_WIDE, OWED);
      const hf = Number((POSTED_WIDE * 7_500n) / OWED);
      return {
        ...base,
        funding: null,
        lenders: [{ ...position, liq_bp: 7_500, hf_bp: hf, room: 0, held: [{ token: METH_ID, symbol: 'ETH', decimals: 18, amount: '236000000000000000' }] }],
        pricing: pricingView('pass_through', 'default'),
      };
    }
    default:
      return { ...base, funding: null, lenders: [rheaPosition(POSTED_WIDE, OWED)], pricing: pricingView('pass_through', 'default') };
  }
}

/** GET /api/lender/:account. An account of today has no permission and no lender. */
export function lenderAccountSample(account: string, state: LenderState | RheaState | null): LenderAccountAnswer {
  if (state && !isLenderState(state)) return rheaAccountSample(account, state);
  return { account, read_at_ms: Date.now(), permission: state ? PERMISSION : null, funding: null, verdict_blk: state ? 999_950 : null, lenders: state ? POSITIONS[state] : [], pricing: null };
}

/**
 * GET /api/pricing (stage 2): the pool's pricing as the Book page reads it, with the demo's two policies (FUNDING.md
 * 15): Standard accounts pay a lender's rate plus 1.2 points, and the sample account pays Rhea's rate up to 8%.
 */
export function pricingSample(account: string): PricingAnswer {
  const settled = `${Date.now() - 20 * 60_000}000000`;
  return {
    read_at_ms: Date.now(),
    funding: { order: 'lender_first', loan_days: 90 },
    // INTERFACES.md 45.1: the three limits on fees, at the pool's defaults.
    limits: {
      max_rate_bp: 6_000, avg_plus_bp: 500, max_period_ns: 172_800_000_000_000, account_subsidy_day: '100000000', pool_subsidy_day_bp: 5,
      max_lender_debt: '1000000000000', account_fee_day: '1000000000', pool_fee_day_bp: 50,
    },
    // The pool's $25,000 of capital gives a budget of $12.50 a day at 5 bp; $0.64 of it went today.
    pool: { fees_charged: '680000', subsidy_paid: '13140000', subsidy_left_24h: '11860000', fees_reversed: '0' },
    tiers: [{ tier: 'STANDARD', pricing: { lender: { margin_bp: 120, cap_bp: null } } }],
    accounts: [
      {
        account, pricing: RHEA_CAP, from: 'account', fees_charged: '0', subsidy_paid: '13140000', credit: '12340000', settled_at: settled,
        last: [{ lender: 'rhea', debt: OWED.toString(), rate_bp: RHEA_RATE_BP, supply_bp: RHEA_SUPPLY_BP }], lender_debt: [{ lender: 'rhea', debt: OWED.toString() }],
      },
      {
        account: 'bob.pbf.testnet', pricing: { lender: { margin_bp: 120, cap_bp: null } }, from: 'tier', fees_charged: '680000', subsidy_paid: '0', credit: '0', settled_at: settled,
        last: [{ lender: 'rhea', debt: '310000000', rate_bp: RHEA_RATE_BP, supply_bp: RHEA_SUPPLY_BP }], lender_debt: [{ lender: 'rhea', debt: '310000000' }],
      },
      // A fresh loan: the pool hasn't settled it yet, so its own report is still empty and the verdict's figure counts.
      { account: 'carol.pbf.testnet', pricing: 'pass_through', from: 'default', fees_charged: '0', subsidy_paid: '0', credit: '0', settled_at: '0', last: [], lender_debt: [{ lender: 'rhea', debt: '250000000' }] },
    ],
  };
}

/**
 * GET /api/lenders. Stage 3: Aave's testnet row also says what its pool can still take of each collateral token
 * (`collateralRoom`), which the testnet step "Get test collateral for Aave" reads.
 */
export function lendersSample(collateralRoom?: LendersAnswer['lenders'][number]['collateral_room']): LendersAnswer {
  return {
    read_at_ms: Date.now(),
    lenders: [
      { l: 'aave', network: 'mainnet', chain: 'Ethereum', collateral: 'WBTC', rate_bp: AAVE_RATE_BP, supply_bp: 410, free: '158900000000000', ltv_bp: 8_100, liq_bp: 8_500, penalty_bp: 500, source: 'Aave’s API', stale: false, read_at_ms: Date.now() },
      {
        l: 'aave', network: 'testnet', chain: 'Base Sepolia', collateral: 'WBTC', rate_bp: AAVE_RATE_BP, supply_bp: 410, free: '2500000000000', ltv_bp: 8_100, liq_bp: 8_500, penalty_bp: 500,
        source: 'Aave’s data provider on Base Sepolia', stale: false, read_at_ms: Date.now(), ...(collateralRoom && { collateral_room: collateralRoom }),
      },
      { l: 'rhea', network: 'mainnet', chain: 'NEAR', collateral: 'nBTC', rate_bp: 1_591, supply_bp: 1_032, free: '250000000000', ltv_bp: 7_600, liq_bp: 7_600, penalty_bp: 30, source: 'contract.main.burrow.near', stale: false, read_at_ms: Date.now() },
      { l: 'rhea', network: 'testnet', chain: 'NEAR', collateral: 'nBTC', rate_bp: 1_591, supply_bp: 1_032, free: '250000000000', ltv_bp: 7_600, liq_bp: 7_600, penalty_bp: 30, source: 'rhea.pbf-ops.testnet', stale: false, read_at_ms: Date.now() },
    ],
  };
}

/**
 * POST /api/funding-plan: Aave lends up to its room against the bitcoin, our pool the rest, up to what the account can
 * borrow. `verdict` and `run` stand in for the engine's own.
 */
export function fundingPlanSample(state: LenderState, amount: string, most: bigint): FundingPlanAnswer {
  const asked = BigInt(amount);
  const total = asked < most ? asked : most;
  const room = BigInt(POSITIONS[state].find((p) => p.l === 'aave')?.room ?? 0);
  const fromAave = total < room ? total : room;
  const sources: NonNullable<FundingPlanAnswer['sources']> = [];
  if (fromAave > 0n) sources.push({ source: 'aave', amount: Number(fromAave), rate_bp: AAVE_RATE_BP });
  if (total > fromAave) sources.push({ source: 'pool', amount: Number(total - fromAave), rate_bp: POOL_RATE_BP });
  const steps: unknown[] = [];
  if (fromAave > 0n) steps.push({ k: 'l_borrow', l: 'aave', amt: Number(fromAave) });
  if (total > fromAave) steps.push({ k: 'p_borrow', amt: Number(total - fromAave) });
  return { asked: amount, total: Number(total), sources, steps, ext: [], blended_bp: blendedBp(sources), verdict: { ok: true }, run: { call_id: null, compute_cost: null, time_ms: 600, attestation_url: null } };
}

const least = (a: bigint, b: bigint) => (a < b ? a : b);
const atLeastZero = (x: bigint) => (x > 0n ? x : 0n);

/**
 * POST /api/funding-plan for an account that borrows from Rhea, with the pool's order set to a lender first: Rhea
 * lends against the bitcoin already posted with it, then against just enough of the account's spare bitcoin, and our
 * pool lends the rest, up to what the account can borrow. Amounts are micro-USD.
 */
export function rheaPlanSample(amount: string, most: bigint, at: { posted: bigint; owed: bigint; spare: bigint }): FundingPlanAnswer {
  const asked = BigInt(amount);
  const total = least(asked, most);
  const roomPosted = atLeastZero(rheaLends(at.posted) - at.owed);
  const fromRhea = least(total, atLeastZero(rheaLends(at.posted + at.spare) - at.owed));
  // The bitcoin to post first: what the part above the posted room needs at a cushion of 1.5, rounded up.
  const toPost = fromRhea > roomPosted ? ((fromRhea - roomPosted) * BigInt(TARGET_HF_BP)) / BigInt(RHEA_LIQ_BP) + 1n : 0n;
  const fromPool = total - fromRhea;
  const sources: NonNullable<FundingPlanAnswer['sources']> = [];
  const steps: FundingStep[] = [];
  if (toPost > 0n) steps.push({ k: 'l_supply', l: 'rhea', tok: NBTC_ID, amt: nbtcUnits(toPost).toString() });
  if (fromRhea > 0n) {
    sources.push({ source: 'rhea', amount: Number(fromRhea), rate_bp: RHEA_RATE_BP });
    steps.push({ k: 'l_borrow', l: 'rhea', amt: Number(fromRhea) });
  }
  if (fromPool > 0n) {
    sources.push({ source: 'pool', amount: Number(fromPool), rate_bp: POOL_RATE_BP });
    steps.push({ k: 'p_borrow', amt: Number(fromPool) });
  }
  const now = rheaPosition(at.posted, at.owed);
  const ext = [{ l: 'rhea', c: now.posted, d: now.debt, hf_bp: now.hf_bp, r_bp: RHEA_RATE_BP, s_bp: RHEA_SUPPLY_BP, room: Number(roomPosted), liq_bp: RHEA_LIQ_BP }];
  return { asked: amount, total: Number(total), sources, steps, ext, blended_bp: blendedBp(sources), verdict: { ok: true }, run: { call_id: null, compute_cost: null, time_ms: 600, attestation_url: null } };
}

// The worked example at full size: $100,000 of nBTC, a $100,000 short and $35,000 of margin (FUNDING.md 2).
const LINE = 94_172_000_000;

/**
 * `funding` with Aave used (a loan expected to last a year, so the move pays), or with our pool alone (90 days).
 * Stage 3 (INTERFACES.md 33): the move counts the bitcoin's trip there and back. `noback` is the 90-day case where no
 * quote came for the way back, so the engine counted it as the way there.
 */
function fundingSample(choice: 'aave' | 'pool' | 'noback'): CreditFunding {
  const used = choice === 'aave';
  const quoted = choice !== 'noback';
  const back = quoted ? 130_000_000 : 490_000_000;
  const total = 490_000_000 + back;
  const trip = quoted ? `Moving that bitcoin to Ethereum costs $490 and bringing it back $130` : `Moving that bitcoin to Ethereum costs $490, and with no quote for the way back that counts the same again`;
  return {
    line: LINE, pool_rate_bp: POOL_RATE_BP, target_hf_bp: 15_000, loan_days: used ? 365 : 90,
    lenders: [
      {
        l: 'aave', chain: 'Ethereum', collateral: 'WBTC', rate_bp: AAVE_RATE_BP, supply_bp: 410, liq_bp: 8_500, ltv_bp: 8_100, penalty_bp: 500, free: 158_900_000_000_000,
        lends: 56_503_000_000, pool: 37_669_000_000, fall_bp: 3_333, blended_bp: 580,
        move: { cost_bp: 49, cost: 490_000_000, back_bp: quoted ? 13 : 49, back, back_quoted: quoted, total, saves: used ? 839_000_000 : 207_000_000, source: '1Click dry quotes, no key' },
        used,
        // In the engine's own style (risk/pb-risk/src/credit.rs).
        why: `Aave looks at the bitcoin alone, not the hedge: against $99,711 of it, it lends $56,503 at 5.33% a year, and sells if bitcoin falls 33.3%. Our pool lends the other $37,669 at 6.50%. ${trip}, and Aave's lower rate saves ${
          used ? '$839 over 365 days, so it is used.' : '$207 over 90 days, which doesn’t cover it, so Aave isn’t used: our pool lends the whole $94,172.'
        }`,
      },
      {
        l: 'rhea', chain: 'NEAR', collateral: 'nBTC', rate_bp: 1_591, supply_bp: 1_032, liq_bp: 7_600, ltv_bp: 7_600, penalty_bp: 30, free: 250_000_000_000,
        lends: 50_520_000_000, pool: 43_652_000_000, fall_bp: 3_333, blended_bp: 1_155, move: null,
        used: false,
        why: 'Rhea looks at the bitcoin alone, not the hedge: against $99,711 of it, it lends $50,520 at 15.91% a year, and sells if bitcoin falls 33.3%. Our pool lends the other $43,652 at 6.50%. Rhea costs no less than our pool, so it isn’t used.',
      },
    ],
    choice: used ? 'aave' : 'pool',
  };
}

/** A credit check's whole answer for the worked example, with `funding`. */
export function creditSample(choice: 'aave' | 'pool' | 'noback'): CreditAnswer {
  const book = { usdc: '35000000000', positions: [{ coin: 'BTC', usd: '-100000000000' }] };
  const spot: CreditAnswer['input']['spot'] = [{ token: 'nBTC', amount: '131578947' }];
  return {
    input: { hl_address: null, book, spot },
    result: {
      ok: true, v: 1, mode: 'credit_check', model: 'B-0.2', params: 'sample', network: 'mainnet', hl_address: null, book, spot, at_ms: Date.now(), near_blk: 276_800_123,
      verdict: {
        eq: 134_711_000_000, eq_allow: 134_711_000_000, mm: 15_616_000_000, im: 19_520_000_000, score: 700, tier: 'STANDARD', rate_bp: 200, rate_bp_at_60: POOL_RATE_BP,
        credit: { line: LINE, binding: 'C4' }, top: ['nBTC depeg 20%', 'ADL BTC 2/3S then 2/3S'], topup: 0, coins: { uncertain: [], stale: [], reduce_only: [] },
      },
      limits: { first_week: 25_000_000_000, ceiling: 250_000_000_000 },
      unlisted: [], without_unlisted: null, ignored: [],
      prices: { BTC: 76_000_000_000 },
      pi: { nBTC: { bp: 9_971, source: '1Click dry quote' } },
      rhea: {
        contract: 'contract.main.burrow.near', blk: 223_738_912, max: 75_780_360_000, safe: 63_150_300_000, usdc_borrow_apr_bp: 1_591, usdc_volatility_bp: 9_500,
        tokens: [{ token: 'nBTC', value: 99_711_000_000, volatility_bp: 8_000, collateral: true }],
      },
      pool: { id: 'pool.pbf.testnet', util_bp: 320 },
      funding: fundingSample(choice),
      in: 'sample',
    },
    run: { call_id: null, attestation_url: null, time_ms: 6_000, compute_cost: null },
    program: { project_id: 'pbf-keeper.testnet/pb-risk', version_key: null },
    output_sha256: 'sample',
    attestation: { found: false, wasm_hash: null, output_hash: null, input_hash: null, timestamp: null, wasm_matches: null, output_matches: null, error: 'sample data: no run, so no attestation' },
    computed_at_ms: Date.now(),
    cached: false,
    age_s: 0,
  };
}
