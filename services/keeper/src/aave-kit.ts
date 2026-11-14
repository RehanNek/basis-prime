// The Aave gate's parts that need no chain (FUNDING.md 10, gate 3; INTERFACES.md 33): its steps, what the client
// signs, which collateral it uses, what to repay, the dry run's words, and what stands in the way of a real run.
// aave-steps.ts runs the steps; aave-demo.ts is the script.
import { KEEPER_ALIVE_MS } from "./config.js";
import type { AaveSettings } from "./evm.js";
import type { Plan } from "./hedge-kit.js";
import type { LogEvent } from "./jsonl.js";

/** Setup, signed by the client: the account with its permission, its USDC, and its address (the same on Aave's chain). */
export const AAVE_SETUP = ["create", "deposit", "hl_init"] as const;
/** The gate itself: the keeper is there; gas and collateral reach the address; one `fund`; the keeper runs it; a settlement. */
export const AAVE_GATE = ["keeper", "collateral", "fund", "funded", "settle"] as const;
/** Leaving: Aave repaid, our pool repaid, the collateral back from Aave and out of the address, and the USDC withdrawn. */
export const AAVE_CLOSE_OUT = ["repay_aave", "repay", "aave_withdraw", "evm_out", "withdraw"] as const;
export const AAVE_STEP_IDS: readonly string[] = [...AAVE_SETUP, ...AAVE_GATE, ...AAVE_CLOSE_OUT];

/** The permission the client signs with the account's opening: both lenders, on the app's default terms (INTERFACES.md 24). */
export function aavePermission() {
  return { lenders: ["aave", "rhea"], min_hf_bp: 15_000, max_rate_bp: 2_500, moves: "any" };
}

/**
 * The gate's test USDC on NEAR. The engine lends nothing to an account worth under $1,000 (RISK_ENGINE.md, C0), and
 * this gate's account holds no nBTC, so the small plan's $440 isn't enough: the first live run (11 Nov) stopped at
 * `fund` with a book of $481.61.
 */
export const AAVE_DEPOSIT_USDC_MICRO = 1_200_000_000n;

/** The small plan with the Aave gate's own deposit. */
export function aavePlan(plan: Plan): Plan {
  return { ...plan, deposit_usdc_micro: AAVE_DEPOSIT_USDC_MICRO.toString() };
}

/**
 * For `--from`: whether the record's deposit is under what the gate takes now. The deposit step then runs again and
 * adds the difference, so a run that stopped on too small a book can go on with its account.
 */
export function depositShort(saved: Plan, now: Plan): boolean {
  return BigInt(saved.deposit_usdc_micro) < BigInt(now.deposit_usdc_micro);
}

/** What the gate posts at Aave: 0.015 test WBTC from Aave's faucet, or 0.02 test ETH wrapped by the gas wallet. */
export const WBTC_UNITS = 1_500_000n;
export const WRAP_WEI = 20_000_000_000_000_000n;
/** The address needs this much test ETH before a step signs for it: two transactions at the fee limit. */
export const MIN_GAS_WEI = 1_000_000_000_000_000n;
/** What the gas wallet must hold for the wrapped path: the 0.02 it wraps, the 0.01 it keeps, a top-up, and its fees. */
export const WRAP_WALLET_NEEDS_WEI = WRAP_WEI + 10_000_000_000_000_000n + 2_000_000_000_000_000n + 100_000_000_000_000n;

/** One row of the backend's `collateral_room` (GET /api/lenders, the testnet Aave row). */
export interface Room {
  token: string;
  symbol: string;
  decimals: number;
  room: string | null;
}

export interface Collateral {
  symbol: string;
  token: string;
  decimals: number;
  /** The token's own units. */
  amount: string;
  /** `mint`: Aave's faucet mints it. `wrap`: the gas wallet wraps its own test ETH. `move` (stage 4's gate): the stand-in delivers it for the account's nBTC. */
  how: "mint" | "wrap" | "move";
  why: string;
}

/**
 * The collateral for this run. WBTC when Aave's supply cap has room for the gate's 0.015 (a `room` of null is no
 * cap); otherwise wrapped test ETH, if that has room. Aave refuses a supply that would pass a cap, so the choice is
 * made on the cap as read now.
 */
export function pickCollateral(rooms: Room[] | null | undefined): Collateral | { problem: string } {
  if (!rooms || rooms.length === 0) return { problem: "the backend's GET /api/lenders gave no collateral_room for Aave's test market: is the stage 3 backend running, and does the factory's config have Aave?" };
  const fits = (r: Room | undefined, amount: bigint) => r !== undefined && (r.room === null || BigInt(r.room) >= amount);
  const show = (r: Room | undefined) => (!r ? "not in the config" : r.room === null ? "no cap" : `room for ${Number(r.room) / 10 ** r.decimals} ${r.symbol}`);
  const wbtc = rooms.find((r) => r.symbol === "WBTC");
  const weth = rooms.find((r) => r.symbol === "WETH");
  if (wbtc && fits(wbtc, WBTC_UNITS)) return { symbol: "WBTC", token: wbtc.token, decimals: wbtc.decimals, amount: WBTC_UNITS.toString(), how: "mint", why: `Aave's test market takes WBTC now (${show(wbtc)}): 0.015 WBTC from Aave's faucet` };
  if (weth && fits(weth, WRAP_WEI)) return { symbol: "WETH", token: weth.token, decimals: weth.decimals, amount: WRAP_WEI.toString(), how: "wrap", why: `Aave's test market has no room for WBTC now (${show(wbtc)}), and takes WETH (${show(weth)}): 0.02 test ETH wrapped by the gas wallet` };
  return { problem: `Aave's test market has room for neither collateral now: WBTC ${show(wbtc)}, WETH ${show(weth)}` };
}

/**
 * What to send Aave to clear a debt read a moment ago: the debt, 0.1% for the interest until it is mined, and a
 * little dust. Aave takes only what is owed and leaves the rest at the address (IPool.repay; research/aave.md).
 */
export function aaveRepayAmount(debtMicro: bigint): bigint {
  return debtMicro + debtMicro / 1_000n + 1_000n;
}

/**
 * Repaying Aave in full takes a little more USDC than was borrowed, for the interest. Before the repayment the gate
 * has Aave's faucet mint 1 test USDC to the address (as the live round trip of 11 Nov did), unless the address
 * already holds half a dollar more than is owed: a run that is resumed has had its mint, and the faucet gives once
 * an hour.
 */
export const REPAY_MINT_UNITS = 1_000_000n;
export const REPAY_SPARE_UNITS = 500_000n;

/**
 * What is wrong with a `fund` split, or null. The gate needs a part from Aave. A part from our pool is welcome and
 * not needed: on a small book the engine may give Aave's part alone, and the gate then runs without a pool loan.
 */
export function aaveSplitProblem(sources: { source: string; amount: number }[]): string | null {
  const part = (name: string) => sources.find((s) => s.source === name)?.amount ?? 0;
  if (part("rhea") > 0) return "the split has a part from Rhea too: this gate's account holds no nBTC on NEAR, so that isn't expected";
  if (part("aave") <= 0 && part("pool") <= 0) return "the engine found nothing to lend: is the collateral at the account's address on Aave's chain, and is the account worth $1,000 or more (the engine lends nothing under that)?";
  if (part("aave") <= 0) return "the whole loan would come from our pool and none from Aave: its supply cap may have filled, or its rate is above the permission's 25%";
  return null;
}

/** The pool's record of what an account pays (its `get_pricing`): the totals, when it last settled, and the report it settled on. */
export interface PoolPricing {
  fees_charged: string;
  subsidy_paid: string;
  /** Nanoseconds. */
  settled_at: string;
  last: { lender: string; debt: string; rate_bp: number; supply_bp: number }[];
  /** INTERFACES.md 45.1: the fees the operator took back with `reverse_fee`. A pool from before that has no such field. */
  fees_reversed?: string;
}

/**
 * What the pool booked between two readings of its record, or null if it settled nothing new for the Aave loan. The
 * account's own `settle()` answers only that it ran (`true`), whatever the pool did, so the gate reads the pool's
 * record: a later `settled_at`, on a report that has Aave's loan in it. The first live run (11 Nov) read the
 * account's answer instead and kept trying while the pool settled four times.
 */
export function aaveSettlement(before: PoolPricing | null, after: PoolPricing | null): { fee: string; subsidy: string; aave_debt: string; rate_bp: number; settled_at: string; words: string } | null {
  if (!after || BigInt(after.settled_at) <= BigInt(before?.settled_at ?? "0")) return null;
  const leg = after.last.find((r) => r.lender === "aave");
  if (!leg || BigInt(leg.debt) <= 0n) return null;
  const fee = BigInt(after.fees_charged) - BigInt(before?.fees_charged ?? "0");
  const subsidy = BigInt(after.subsidy_paid) - BigInt(before?.subsidy_paid ?? "0");
  const usdc = (micro: bigint) => `${Number(micro) / 1e6} USDC`;
  const booked = fee > 0n ? `a fee of ${usdc(fee)} was added` : subsidy > 0n ? `a subsidy of ${usdc(subsidy)} was taken off` : "nothing was added or taken off";
  return {
    fee: fee.toString(),
    subsidy: subsidy.toString(),
    aave_debt: leg.debt,
    rate_bp: leg.rate_bp,
    settled_at: after.settled_at,
    words: `settled: the pool's report has $${(Number(leg.debt) / 1e6).toFixed(2)} owed to Aave at ${(leg.rate_bp / 100).toFixed(2)}% a year, and ${booked}`,
  };
}

/** Whether the keeper's log shows it running for real and listing `account`. Unlike the Rhea gate's check, no Rhea price is needed. */
export function keeperWatches(events: LogEvent[], account: string, nowMs: number): { ok: boolean; why: string; last_tick_at: string | null } {
  const last = events.filter((e) => e.event === "tick").at(-1);
  if (!last) return { ok: false, why: "the keeper's log has no tick yet: start it with pnpm --filter @pb/keeper start", last_tick_at: null };
  const age = nowMs - Date.parse(last.t);
  if (age > KEEPER_ALIVE_MS) return { ok: false, why: `the keeper's last tick was ${Math.round(age / 1000)} s ago: is it running?`, last_tick_at: last.t };
  const start = events.filter((e) => e.event === "start" && typeof e.msg === "string" && e.msg.startsWith("the keeper is starting")).at(-1);
  if (start?.msg?.includes("dry run")) return { ok: false, why: "the keeper runs as a dry run: it sends nothing. Start it without --dry-run", last_tick_at: last.t };
  if (start && typeof start.evm !== "string") return { ok: false, why: "the keeper that is running is from before stage 3 (its start line names no chain for Aave): build and start it again", last_tick_at: last.t };
  if (!Array.isArray(last.accounts) || !(last.accounts as unknown[]).includes(account)) return { ok: false, why: `the keeper's last tick doesn't list ${account} yet (it reads the factory's list once a minute)`, last_tick_at: last.t };
  return { ok: true, why: `the keeper ticked ${Math.round(age / 1000)} s ago and watches ${account}`, last_tick_at: last.t };
}

export interface AaveWords {
  account: string;
  owner: string;
  pool: string;
  apiUrl: string;
  plan: Plan;
  recordFile: string;
  fundWaitMin: number;
  settleWaitMin: number;
  settleEverySec: number;
}

/** Every step of the gate, in order, with what it sends and what it checks: the dry run prints this. */
export function describeAaveGate(w: AaveWords): string[] {
  const usd = (micro: string) => `$${(Number(micro) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return [
    `account ${w.account}, owned by ${w.owner}; lender Aave's test market on Base Sepolia; pool ${w.pool}; backend ${w.apiUrl}`,
    `the book: ${usd(w.plan.deposit_usdc_micro)} of test USDC in the account on NEAR, and at its address on Aave's chain 0.015 test WBTC, or 0.02 wrapped test ETH if Aave's WBTC cap is full. No nBTC and no Hyperliquid position`,
    "",
    "setup, signed by the client (the keeper's key owns the gate's account):",
    ` 1 create          create_account with 6 NEAR and the permission ${JSON.stringify(aavePermission())}, in one signature. Checks: get_state().permission is that permission`,
    ` 2 deposit         mint and deposit the test USDC: what the account is short of ${usd(w.plan.deposit_usdc_micro)} (the engine lends nothing to an account worth under $1,000)`,
    ` 3 hl_init         hl_init: the account's address through Chain Signatures, the same on Aave's chain`,
    "",
    "the gate:",
    ` 4 keeper          nothing is sent. Checks: the keeper's log shows a tick in the last ${KEEPER_ALIVE_MS / 60_000} minutes, from a stage 3 keeper, not a dry run, with ${w.account} in its list`,
    ` 5 collateral      reads Aave's room for WBTC (the backend's collateral_room). POST /api/evm/gas: test ETH to the address, and 0.015 WBTC from Aave's faucet, or 0.02 test ETH wrapped by the gas wallet when the cap is full. Checks: the address holds the ETH and the collateral; the record says which collateral and why`,
    ` 6 fund            a preview through POST /api/funding-plan; request_check with {"fund":{"amount"}} for 0.5% under what it can lend (0.01 NEAR); then the client's one fund(amount) with 1 yoctoNEAR. Checks: the split has a part from Aave; the stored plan is the verdict's steps, with l_borrow among them. A part from our pool is recorded if it came, and the run goes on without one`,
    ` 7 funded          nothing is sent: the keeper approves the collateral, runs each step, sends each signed transaction and waits for it. Checks: every step is done inside ${w.fundWaitMin} minutes; Aave's own books show the collateral posted; the approval, the supply and the borrow are mined; a verdict's ext shows the Aave loan; the pool's debt_of is above 0 if the plan had a pool part`,
    ` 8 settle          request_check (0.01 NEAR), then settle(); again every ${w.settleEverySec} s while the pool answers "skipped" (up to ${w.settleWaitMin} min). Checks: the pool answers a settlement. Without a pool loan it is tried three times and recorded either way`,
    "",
    "leaving, signed by the client:",
    ` 9 repay_aave      POST /api/evm/gas with a mint of 1 test USDC from Aave's faucet, for the interest; evm_approve for USDC if the keeper hasn't yet; lender_repay("aave", the debt and 0.1%) with 1 yoctoNEAR; POST /api/evm/submit. Checks: the repayment is mined; a fresh verdict shows nothing owed to Aave`,
    `10 repay           the pool's loan repaid from the account's USDC, if there is one`,
    `11 aave_withdraw   lender_withdraw("aave", token, all of it) with 1 yoctoNEAR; POST /api/evm/submit. Checks: mined; Aave's books show nothing posted; the collateral is at the address`,
    `12 evm_out         evm_withdraw(token, all of it, the gas wallet's address) with 1 yoctoNEAR; POST /api/evm/submit: wrapped ETH goes back to the wallet that paid for it. Checks: mined; the address holds none of it`,
    `13 withdraw        the USDC out of the account to the keeper, with no verdict`,
    "",
    `the record goes to ${w.recordFile}; resume with --from <step>`,
  ];
}

/** What the dry run found, read-only. A null is a read that failed. */
export interface AaveFound {
  account: string;
  accountExists: boolean | null;
  resuming: boolean;
  owner: string;
  ownerNear: number | null;
  /** The factory's Aave settings: null when it has none, undefined when its config couldn't be read. */
  factoryAave: AaveSettings | null | undefined;
  evmChainId: number;
  /** GET /api/config answered. */
  backend: boolean;
  /** The testnet Aave row's collateral_room; null when the row or the field is missing. */
  rooms: Room[] | null;
  /** GET /api/evm/gas. */
  gas: { on: boolean; gas_wallet: string | null; balance: string | null } | null;
  keeper: { ok: boolean; why: string };
}

/** The keeper's own NEAR for a run: 6 to open the account, and 0.01 for each check. */
export const AAVE_OWNER_NEAR_NEEDED = 6.6;

/** One line for each thing found, and what stands in the way of a real run. */
export function aaveProblems(f: AaveFound): { lines: string[]; problems: string[] } {
  const lines: string[] = [];
  const problems: string[] = [];
  const eth = (wei: string | bigint) => `${Number(wei) / 1e18} ETH`;
  if (f.accountExists === null) problems.push(`couldn't read whether ${f.account} exists`);
  else if (f.accountExists && !f.resuming) problems.push(`${f.account} exists already: a run needs a fresh account, so give another --name (or --from to go on with this one)`);
  else lines.push(f.accountExists ? `${f.account} exists: the run goes on with it` : `${f.account} is free`);
  if (f.ownerNear === null) problems.push(`couldn't read ${f.owner}'s NEAR`);
  else if (f.ownerNear < AAVE_OWNER_NEAR_NEEDED && !f.accountExists) problems.push(`${f.owner} holds ${f.ownerNear} NEAR, and a run needs about ${AAVE_OWNER_NEAR_NEEDED}: 6 to open the account and 0.01 for each check`);
  else lines.push(`${f.owner} holds ${f.ownerNear} NEAR`);

  if (f.factoryAave === undefined) problems.push("couldn't read the factory's config");
  else if (f.factoryAave === null) problems.push("the factory's config has no Aave settings (lenders.aave): stage 3's factory isn't live yet, so a new account couldn't use Aave");
  else {
    const a = f.factoryAave;
    lines.push(`the factory's Aave settings: chain ${a.chainId}, Pool ${a.pool}, collateral ${a.collateral.map((t) => t.symbol).join(" and ") || "none"}, fee limit ${a.maxFeePerGas ?? "not set"} wei`);
    if (a.chainId !== f.evmChainId) problems.push(`the factory's Aave settings name chain ${a.chainId}, and EVM_CHAIN_ID is ${f.evmChainId}`);
    if (!a.collateral.some((t) => t.symbol === "WBTC" || t.symbol === "WETH")) problems.push("the factory's Aave settings list neither WBTC nor WETH as collateral");
    if (a.maxFeePerGas === null) problems.push("the factory's Aave settings have no max_fee_per_gas");
  }

  if (!f.backend) problems.push("the backend doesn't answer GET /api/config: pnpm --filter @pb/api start");
  const pick = f.backend ? pickCollateral(f.rooms) : null;
  if (pick && "problem" in pick) problems.push(pick.problem);
  else if (pick) lines.push(`collateral: ${pick.why}`);
  if (f.backend) {
    if (!f.gas) problems.push("the backend has no GET /api/evm/gas: it is from before stage 3, so build and start it again");
    else if (!f.gas.on) problems.push("the backend's gas helper is off: set EVM_GAS_PRIVATE_KEY in .env and start the backend again");
    else if (f.gas.balance === null) problems.push(`the gas wallet's balance on Aave's chain couldn't be read (${f.gas.gas_wallet})`);
    else {
      lines.push(`the gas wallet ${f.gas.gas_wallet} holds ${eth(f.gas.balance)}`);
      // A run that goes on with its account has had its wrap (the first live run's had, and the wallet was then
      // 0.004 short of a second one): it needs the wallet's reserve and a top-up. If the address is still short
      // of collateral, the helper refuses in its own words.
      const wrapped = f.resuming && f.accountExists === true;
      const wraps = pick && !("problem" in pick) && pick.how === "wrap";
      const needs = !wraps ? 3_000_000_000_000_000n : wrapped ? WRAP_WALLET_NEEDS_WEI - WRAP_WEI : WRAP_WALLET_NEEDS_WEI;
      if (BigInt(f.gas.balance) < needs) problems.push(`the gas wallet holds ${eth(f.gas.balance)}, and this run needs it to hold ${eth(needs)}${needs === WRAP_WALLET_NEEDS_WEI ? " (0.02 to wrap, 0.01 it keeps, and a top-up)" : ""}: send ${f.gas.gas_wallet} test ETH on Base Sepolia`);
    }
  }
  if (f.keeper.ok) lines.push(f.keeper.why);
  else problems.push(f.keeper.why);
  return { lines, problems };
}
