// The moves gate's parts that need no chain (FUNDING.md 10, gate 4; INTERFACES.md 36): its steps, its sizes, the dry
// run's words, and what stands in the way of a real run. moves-steps.ts runs the steps; moves-demo.ts is the script.
import { keeperWatches } from "./aave-kit.js";
import { KEEPER_ALIVE_MS } from "./config.js";
import type { AaveSettings } from "./evm.js";
import type { Plan } from "./hedge-kit.js";

/** Setup, signed by the client: the account with its permission, test nBTC only, and its address. */
export const MOVES_SETUP = ["create", "deposit", "hl_init"] as const;
/** The gate: gas to the address, bitcoin to Aave's chain, a check that settles it, one `fund`, the keeper's steps, the loan home. */
export const MOVES_GATE = ["keeper", "gas", "btc_out", "arrived", "fund", "funded", "loan_home"] as const;
/** Leaving, as a client would: USDC back to Aave's chain, Aave and our pool repaid, the collateral back and home, everything withdrawn. */
export const MOVES_CLOSE_OUT = ["usdc_out", "usdc_arrived", "repay_aave", "repay", "aave_withdraw", "btc_home", "withdraw", "float"] as const;
export const MOVES_STEP_IDS: readonly string[] = [...MOVES_SETUP, ...MOVES_GATE, ...MOVES_CLOSE_OUT];
/** The gate has passed FUNDING.md's gate 4 once this step has: the borrowed USDC is in the account on NEAR. */
export const MOVES_PASS_POINT = "loan_home";

/**
 * The account's book: test nBTC only. The engine lends nothing to an account worth under $1,000, so the gate
 * deposits 0.02 nBTC, or more if bitcoin is cheap enough that 0.02 is under $1,300.
 */
export const MOVES_NBTC_UNITS = 2_000_000n;
export const MOVES_BOOK_USD = 1_300;

/** The gate's plan: the small size's caps, no USDC, and the nBTC above. */
export function movesPlan(plan: Plan): Plan {
  // INTERFACES.md 51.2: with --coin ETH the account holds test ETH worth the same $1,300, and no bitcoin. The plan
  // that comes in is the coin's (hedge-kit's planForCoin): its price is ETH's, and its token has 18 decimals.
  if (plan.coin === "ETH") {
    const tenThousandths = BigInt(Math.ceil((MOVES_BOOK_USD / plan.btc_px) * 10_000));
    return { ...plan, deposit_usdc_micro: "0", deposit_nbtc_units: (tenThousandths * 10n ** 14n).toString() };
  }
  const forPrice = BigInt(Math.ceil((MOVES_BOOK_USD / plan.btc_px) * 1e8));
  return { ...plan, deposit_usdc_micro: "0", deposit_nbtc_units: (forPrice > MOVES_NBTC_UNITS ? forPrice : MOVES_NBTC_UNITS).toString() };
}

/**
 * The permission the client signs with the account's opening: Aave alone, on the app's default terms. Unlike gate 3's
 * account this one holds nBTC on NEAR, which Rhea would lend against, and this gate is about the moves to Aave.
 */
export function movesPermission() {
  return { lenders: ["aave"], min_hf_bp: 15_000, max_rate_bp: 2_500, moves: "any" };
}

/**
 * How much nBTC the first move sends. Aave's test market has no room for WBTC most days, and then the bitcoin arrives
 * as wrapped test ETH, of which the stand-in brings at most 0.02 a move (its float has little test ETH). So the gate
 * prices a small probe first: if that would arrive as WETH, it sends what brings 0.0195 WETH; if as WBTC, 0.015 nBTC.
 * The probe is 0.0002 nBTC: about $15 on 12 Nov, which is 0.007 WETH, well under the stand-in's 0.02.
 */
export const PROBE_NBTC_UNITS = 20_000n;
/**
 * INTERFACES.md 51.2, the ETH gate: the first move sends 0.02 test ETH, which arrives as a little under 0.02 WETH
 * (1Click priced 0.02 ETH to Base at 0.0199954 on 14 Nov), inside the 0.02 WETH the stand-in brings in one move.
 * No probe is needed: ether arrives as WETH whatever room Aave has for WBTC.
 */
export const ETH_MOVE_UNITS = 20_000_000_000_000_000n;
export const WETH_AIM_WEI = 19_500_000_000_000_000n;
export const WBTC_MOVE_UNITS = 1_500_000n;

export function btcOutUnits(probe: { symbol: string; amount: string }, probeUnits: bigint = PROBE_NBTC_UNITS): bigint {
  if (probe.symbol !== "WETH") return WBTC_MOVE_UNITS;
  const arrives = BigInt(probe.amount);
  if (arrives <= 0n) throw new Error("the probe quote would deliver nothing");
  return (probeUnits * WETH_AIM_WEI) / arrives;
}

/**
 * The stand-in's refusal of too much WETH names the most nBTC that fits one move: "Send at most 0.00055739 nBTC (55739
 * units)" (services/oneclick-shim/src/evm-routes.ts, fillProblem). The gate then sends 2.5% under that, as the aim of
 * 0.0195 WETH is 2.5% under 0.02. Null when the words name no amount.
 */
export function fitsOneMove(refusal: string): bigint | null {
  const most = /\((\d+) units\)/.exec(refusal)?.[1];
  return most ? (BigInt(most) * 975n) / 1_000n : null;
}

/**
 * The most the gate asks our pool for: $100 beside Aave's part. While the account owes our pool, a move needs room
 * on its credit line, because money in transit counts 0 for credit; with the whole line borrowed, bringing the loan
 * home and sending USDC back would both be refused.
 */
export const POOL_PART_MICRO = 100_000_000n;

/**
 * What to send back to Aave's chain to repay a debt read a moment ago: the debt, and the larger of 1% and 1 USDC for
 * the route's cost and the interest. (On 12 Nov 1Click priced 24 USDC to Base at 23.9928: a cost of 0.03%.)
 */
export function usdcBackUnits(debtMicro: bigint): bigint {
  const spare = debtMicro / 100n > 1_000_000n ? debtMicro / 100n : 1_000_000n;
  return debtMicro + spare;
}

/**
 * Whether a failed `withdraw` or `evm_withdraw` says the held verdict can't back it, in the account's own words
 * (contracts/account/src/lib.rs): the answer is a new check, then the call again. It happens when the check itself
 * showed a transaction on Aave's chain mined, which moves the account's counter on; when a transaction is still listed
 * as under way; or when another check (the keeper's) landed after the gate's.
 */
export function verdictSpent(message: string): boolean {
  return /the verdict was already used|blocks old, above the|no verdict: ask for a check first|needs a verdict for this token and amount|until a check shows Ethereum transaction/.test(message);
}

/** What the float must hold in test ETH for a run on the wrapped path: 0.02 to wrap, 0.003 it keeps for gas, a 0.002 top-up for the address, and its fees. */
export const MOVES_FLOAT_NEEDS_WEI = 20_000_000_000_000_000n + 3_000_000_000_000_000n + 2_000_000_000_000_000n + 200_000_000_000_000n;
/**
 * The most test ETH a run may leave the float down by and still count as "back, less gas": the gas helper's top-ups
 * for the address (0.002 the first time, at most three a day) and the float's own fees. A run that ends further down
 * has its wrapped test ETH still wrapped somewhere, and the last step says so.
 */
export const FLOAT_SPEND_LIMIT_WEI = 7_000_000_000_000_000n;

export interface MovesWords {
  account: string;
  owner: string;
  pool: string;
  apiUrl: string;
  shimUrl: string;
  plan: Plan;
  recordFile: string;
  fundWaitMin: number;
}

/** Every step of the gate, in order, with what it sends and what it checks: the dry run prints this. */
export function describeMovesGate(w: MovesWords): string[] {
  const eth = w.plan.coin === "ETH";
  const nbtc = Number(w.plan.deposit_nbtc_units) / 10 ** (w.plan.token_decimals ?? 8);
  const [coin, token] = eth ? ["ETH", "test ETH"] : ["BTC", "test nBTC"];
  return [
    `account ${w.account}, owned by ${w.owner}; Aave's test market on Base Sepolia, reached through the stand-in at ${w.shimUrl}; pool ${w.pool}; backend ${w.apiUrl}`,
    `the book: ${nbtc} ${token} (about $${Math.round(nbtc * w.plan.btc_px).toLocaleString("en-US")} at ${coin} $${w.plan.btc_px.toLocaleString("en-US")}) in the account on NEAR, and nothing else. The engine lends nothing to an account worth under $1,000`,
    "",
    "setup, signed by the client (the keeper's key owns the gate's account):",
    ` 1 create          create_account with 6 NEAR and the permission ${JSON.stringify(movesPermission())}, in one signature`,
    ` 2 deposit         mint and deposit the ${token} (only what the account is short of)`,
    ` 3 hl_init         hl_init: the account's address through Chain Signatures, the same on Aave's chain`,
    "",
    "the gate:",
    ` 4 keeper          nothing is sent. Checks: the keeper's log shows a tick in the last ${KEEPER_ALIVE_MS / 60_000} minutes, from a keeper that knows Aave's chain, not a dry run, with ${w.account} in its list`,
    ` 5 gas             POST /api/evm/gas: test ETH for gas to the account's address, and nothing else. Records what the float holds before the run`,
    ...(eth ? [` 6 btc_out         (ether, under the step's old name) POST /api/quote with move "to_evm" and test ETH as the token, for 0.02 ETH: it arrives as a little under 0.02 WETH, the most the stand-in brings in one move; the account's withdraw with the transfer. Checks: the stand-in delivers; the WETH is at the account's address`] : []),
    ` 6 btc_out         POST /api/quote with move "to_evm" for a probe of 0.0002 nBTC, then for the amount that brings 0.0195 WETH (or 0.015 nBTC as WBTC, if Aave has room); the account's withdraw with the transfer. Checks: the stand-in delivers; the collateral is at the address; the record says which token and why`,
    ` 7 arrived         request_check (0.01 NEAR): the verdict's arrived settles the transfer. Checks: the account no longer lists it`,
    ` 8 fund            a preview; request_check with {"fund":{"amount"}} for Aave's part and at most $100 from our pool (a move needs room on the credit line while the pool is owed); the client's one fund(amount). Checks: the plan has l_borrow`,
    ` 9 funded          nothing is sent: the keeper approves the collateral, runs each step, sends each signed transaction. Checks: every step is done inside ${w.fundWaitMin} minutes; Aave's books show the collateral posted; a verdict's ext shows the Aave loan`,
    `10 loan_home       POST /api/quote with move "e_home" for the borrowed USDC; the check it names, while our pool is owed; evm_withdraw with the quote's expiry; POST /api/evm/submit. Checks: mined; the stand-in delivers; the USDC is in the account on NEAR and the transfer is settled. THE GATE'S PASS POINT`,
    "",
    "leaving, signed by the client:",
    `11 usdc_out        "to_evm" for USDC: what Aave is owed and the larger of 1% and 1 USDC over, with the check the quote names; withdraw with the transfer. Checks: delivered; the USDC is at the address`,
    `12 usdc_arrived    request_check: the verdict settles that transfer before the USDC is spent`,
    `13 repay_aave      lender_repay("aave", the debt and 0.1%); POST /api/evm/submit. Checks: mined; a fresh verdict shows nothing owed to Aave`,
    `14 repay           the pool's loan repaid from the account's USDC, if there is one (the interest comes from the test token's faucet)`,
    `15 aave_withdraw   lender_withdraw("aave", token, all of it); POST /api/evm/submit. Checks: mined; the collateral is at the address`,
    `16 btc_home        "e_home" for the collateral${eth ? ', with "to" naming test ETH' : ""}; evm_withdraw with the quote's expiry; POST /api/evm/submit. Checks: mined; delivered as ${eth ? "test ETH" : "nBTC"} in the account on NEAR; the transfer is settled`,
    `17 withdraw        both tokens out of the account to the keeper, with no verdict`,
    `18 float           nothing is sent. Records what the float holds after the run, how much test ETH the run used, and what is left at the account's address`,
    "",
    "every check that fails (Aave's chain unreadable brings no verdict at all) is asked again a minute later, three times in all, and each failure is kept in the record",
    "",
    `the record goes to ${w.recordFile}; resume with --from <step>`,
    // With --coin ETH the first move has its own line above: bitcoin's probe line is left out.
  ].filter((line) => !(eth && line.startsWith(' 6 btc_out         POST /api/quote with move "to_evm" for a probe')));
}

/** What the dry run found, read-only. A null is a read that failed. */
export interface MovesFound {
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
  /** GET /api/evm/gas: the gas wallet, which is the stand-in's float on Base Sepolia. */
  gas: { on: boolean; gas_wallet: string | null; balance: string | null } | null;
  /** The symbols of the stand-in's Base Sepolia assets (its GET /v0/tokens); null when it didn't answer. */
  shimBase: string[] | null;
  keeper: ReturnType<typeof keeperWatches> | { ok: boolean; why: string };
  /** What was built here against what the factory has (the main session's addition, after gate 3). */
  code?: BuiltVsLive[];
}

/**
 * A file built here and what the factory has in its place: sha256 in hex, null when one couldn't be read. A fresh
 * account gets the factory's account code and pins the factory's two programs, so a deploy that isn't finished
 * would cost a live run (and 6 NEAR) to find out.
 */
export interface BuiltVsLive {
  what: string;
  file: string;
  built: string | null;
  live: string | null;
}

export const MOVES_OWNER_NEAR_NEEDED = 6.7;

/** One line for each thing found, and what stands in the way of a real run. */
export function movesProblems(f: MovesFound): { lines: string[]; problems: string[] } {
  const lines: string[] = [];
  const problems: string[] = [];
  const eth = (wei: string | bigint) => `${Number(wei) / 1e18} ETH`;
  if (f.accountExists === null) problems.push(`couldn't read whether ${f.account} exists`);
  else if (f.accountExists && !f.resuming) problems.push(`${f.account} exists already: a run needs a fresh account, so give another --name (or --from to go on with this one)`);
  else lines.push(f.accountExists ? `${f.account} exists: the run goes on with it` : `${f.account} is free`);
  if (f.ownerNear === null) problems.push(`couldn't read ${f.owner}'s NEAR`);
  else if (f.ownerNear < MOVES_OWNER_NEAR_NEEDED && !f.accountExists) problems.push(`${f.owner} holds ${f.ownerNear} NEAR, and a run needs about ${MOVES_OWNER_NEAR_NEEDED}: 6 to open the account and 0.01 for each check`);
  else lines.push(`${f.owner} holds ${f.ownerNear} NEAR`);

  if (f.factoryAave === undefined) problems.push("couldn't read the factory's config");
  else if (f.factoryAave === null) problems.push("the factory's config has no Aave settings (lenders.aave), so a new account couldn't move anything to Aave's chain");
  else {
    lines.push(`the factory's Aave settings: chain ${f.factoryAave.chainId}, collateral ${f.factoryAave.collateral.map((t) => t.symbol).join(" and ") || "none"}`);
    if (f.factoryAave.chainId !== f.evmChainId) problems.push(`the factory's Aave settings name chain ${f.factoryAave.chainId}, and EVM_CHAIN_ID is ${f.evmChainId}`);
  }
  if (!f.backend) problems.push("the backend doesn't answer GET /api/config: pnpm --filter @pb/api start");
  else if (!f.gas) problems.push("the backend has no GET /api/evm/gas: it is from before stage 3, so build and start it again");
  else if (!f.gas.on) problems.push("the backend's gas helper is off: set EVM_GAS_PRIVATE_KEY in .env and start the backend again");
  else if (f.gas.balance === null) problems.push(`the gas wallet's balance on Aave's chain couldn't be read (${f.gas.gas_wallet})`);
  else {
    lines.push(`the gas wallet ${f.gas.gas_wallet}, which is the stand-in's float on Base Sepolia, holds ${eth(f.gas.balance)}`);
    if (BigInt(f.gas.balance) < MOVES_FLOAT_NEEDS_WEI && !f.resuming) problems.push(`the float holds ${eth(f.gas.balance)}, and a run needs it to hold ${eth(MOVES_FLOAT_NEEDS_WEI)} (0.02 to wrap, 0.003 it keeps for gas, a top-up for the address): send ${f.gas.gas_wallet} test ETH on Base Sepolia. The run gives the wrapped 0.02 back`);
  }
  if (f.shimBase === null) problems.push("the stand-in doesn't answer GET /v0/tokens: pnpm --filter @pb/oneclick-shim start");
  else if (!f.shimBase.some((s) => s === "WETH" || s === "WBTC")) problems.push("the stand-in that is running doesn't know Base Sepolia's tokens: it is from before stage 4, or the factory had no Aave settings when it started. Build and start it again");
  else lines.push(`the stand-in knows Base Sepolia's ${f.shimBase.join(", ")}. Whether its float there is on shows at the first quote: it needs EVM_GAS_PRIVATE_KEY`);
  if (f.keeper.ok) lines.push(f.keeper.why);
  else problems.push(f.keeper.why);
  // A run that goes on with its account keeps that account's code and pins, so this is for a fresh one.
  for (const c of f.resuming ? [] : (f.code ?? [])) {
    const short = (h: string) => `${h.slice(0, 8)}…`;
    if (c.built === null) lines.push(`${c.what}: no built file at ${c.file}, so it wasn't compared with the factory's`);
    else if (c.live === null) problems.push(`couldn't read the factory's ${c.what}`);
    else if (c.built !== c.live) problems.push(`the factory's ${c.what} is ${short(c.live)}, and the one built here is ${short(c.built)}: the deploy of what is built here isn't finished`);
    else lines.push(`the factory's ${c.what} is the one built here (${short(c.built)})`);
  }
  return { lines, problems };
}
