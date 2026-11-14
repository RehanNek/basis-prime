// Aave v3's terms for GET /api/lenders (INTERFACES.md 28): USDC to borrow against wrapped bitcoin. Read-only.
//
// Mainnet (Ethereum's core market) comes from Aave's own API, https://api.v3.aave.com/graphql, as
// research/scripts/aave_live.py reads it. The query below asks `reserve(request: {market, underlyingToken, chainId})`
// twice. Checked against the API's schema and with a live call on 10 Nov:
//   - ReserveRequest takes market, underlyingToken and chainId; the answer is a Reserve, or null;
//   - Reserve.supplyInfo has apy, maxLTV, liquidationThreshold and liquidationBonus (each a PercentValue whose `value`
//     is a fraction as a decimal string: "0.81" is 81%) and canBeCollateral;
//   - Reserve.borrowInfo (null for a token that can't be borrowed) has apy and availableLiquidity, a TokenAmount whose
//     amount.value is whole tokens as a decimal string.
// The market's and the tokens' addresses are the ones the API itself lists for chain 1 (the `markets` query, and
// research/data/aave_live_2026-11-10.json): AaveV3Ethereum, USDC and WBTC.
//
// Testnet (Base Sepolia) comes from three `eth_call`s to Aave's protocol data provider (INTERFACES.md 24). Selectors
// and return layouts are from AaveProtocolDataProvider.sol in aave-dao/aave-v3-origin; each selector is the first four
// bytes of keccak256 of the signature, recomputed on 10 Nov with @noble/hashes, and each layout was checked with a live
// call at Base Sepolia block 57,135,551:
//   - getReserveData(address) 0x35ea6a75 -> 12 words: [2] totalAToken, [4] totalVariableDebt, [5] liquidityRate,
//     [6] variableBorrowRate. The rates are a year's simple rate with 27 decimals (a "ray");
//   - getReserveConfigurationData(address) 0x3e150141 -> 10 words: [0] decimals, [1] ltv, [2] liquidationThreshold,
//     [3] liquidationBonus (all three out of 10,000; the bonus counts from 10,000, so 10500 is a 5% penalty),
//     [5] usageAsCollateralEnabled;
//   - getVirtualUnderlyingBalance(address) 0x6fb07f96 -> 1 word: the tokens the pool holds, free to borrow.
// Aave's API quotes rates compounded each second (APY), so the testnet rates are compounded the same way here.
import { callWithAddress, EvmError, words, type EvmReader } from "./evm.js";

export const AAVE_API_URL = "https://api.v3.aave.com/graphql";

/** Ethereum's core market and its two tokens, as Aave's API lists them. */
export const AAVE_MAINNET = {
  chainId: 1,
  market: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  wbtc: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
} as const;

/** Aave's test tokens on Base Sepolia (INTERFACES.md 24; research/aave.md). */
export const AAVE_TESTNET_TOKENS = {
  usdc: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
  wbtc: "0x54114591963CF60EF3aA63bEfD6eC263D98145a4",
} as const;

export const SELECTORS = {
  getReserveData: "0x35ea6a75",
  getReserveConfigurationData: "0x3e150141",
  getVirtualUnderlyingBalance: "0x6fb07f96",
} as const;

export const AAVE_QUERY = `query($market: EvmAddress!, $chain: ChainId!, $usdc: EvmAddress!, $wbtc: EvmAddress!) {
  usdc: reserve(request: { market: $market, underlyingToken: $usdc, chainId: $chain }) {
    underlyingToken { symbol decimals }
    supplyInfo { apy { value } }
    borrowInfo { apy { value } availableLiquidity { amount { value } } }
  }
  wbtc: reserve(request: { market: $market, underlyingToken: $wbtc, chainId: $chain }) {
    underlyingToken { symbol decimals }
    supplyInfo { maxLTV { value } liquidationThreshold { value } liquidationBonus { value } canBeCollateral }
  }
}`;

/** The terms every lender row shares (INTERFACES.md 28). `free` is micro-USD, as a string. */
export interface Terms {
  rate_bp: number;
  supply_bp: number;
  free: string;
  ltv_bp: number;
  liq_bp: number;
  penalty_bp: number;
}

/** Posts one GraphQL query to Aave's API and returns its `data`; tests pass a fake. */
export type AaveApi = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

export function aaveApi(options: { url?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): AaveApi {
  const url = options.url ?? AAVE_API_URL;
  const host = new URL(url).host;
  const doFetch = options.fetch ?? fetch;
  return async (query, variables) => {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      throw new Error(`Aave's API (${host}) didn't answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`Aave's API (${host}) answered HTTP ${response.status}`);
    const body = (await response.json().catch(() => null)) as { data?: unknown; errors?: { message?: unknown }[] } | null;
    if (!body || typeof body !== "object") throw new Error(`Aave's API (${host}) answered something that isn't JSON`);
    if (Array.isArray(body.errors) && body.errors.length) throw new Error(`Aave's API refused the query: ${String(body.errors[0]?.message ?? "no reason given").slice(0, 200)}`);
    return body.data;
  };
}

/** "0.81" -> 8100 bp. Null when it isn't a plain decimal. */
export function fractionBp(text: unknown): number | null {
  if (typeof text !== "string" || !/^\d+(\.\d+)?$/.test(text)) return null;
  const bp = Math.round(Number(text) * 10_000);
  return Number.isFinite(bp) ? bp : null;
}

/** "163234342.643274" whole tokens -> "163234342643274" units of a 6-decimal token, cut (not rounded) past the 6th. */
export function decimalToUnits(text: unknown, decimals: number): string | null {
  if (typeof text !== "string" || !/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, part = ""] = text.split(".");
  return BigInt(`${whole}${part.slice(0, decimals).padEnd(decimals, "0")}`).toString();
}

interface ApiReserve {
  underlyingToken?: { symbol?: unknown; decimals?: unknown };
  supplyInfo?: { apy?: { value?: unknown }; maxLTV?: { value?: unknown }; liquidationThreshold?: { value?: unknown }; liquidationBonus?: { value?: unknown }; canBeCollateral?: unknown } | null;
  borrowInfo?: { apy?: { value?: unknown }; availableLiquidity?: { amount?: { value?: unknown } } } | null;
}

/** The mainnet terms from the API's answer to AAVE_QUERY. Anything missing is an error that names it. */
export function readAaveApi(data: unknown): Terms {
  const { usdc, wbtc } = (data ?? {}) as { usdc?: ApiReserve | null; wbtc?: ApiReserve | null };
  if (!usdc || !wbtc) throw new Error(`Aave's API has no ${usdc ? "WBTC" : "USDC"} reserve in the Ethereum core market`);
  if (usdc.underlyingToken?.symbol !== "USDC" || usdc.underlyingToken.decimals !== 6) throw new Error("Aave's API answered a token that isn't 6-decimal USDC for the USDC address");
  if (!usdc.borrowInfo) throw new Error("Aave's API says USDC can't be borrowed in the Ethereum core market");
  const need = (value: number | string | null, what: string) => {
    if (value === null) throw new Error(`Aave's API answered no ${what}`);
    return value;
  };
  const collateral = wbtc.supplyInfo?.canBeCollateral === true;
  return {
    rate_bp: need(fractionBp(usdc.borrowInfo.apy?.value), "borrow rate for USDC") as number,
    supply_bp: need(fractionBp(usdc.supplyInfo?.apy?.value), "deposit rate for USDC") as number,
    free: need(decimalToUnits(usdc.borrowInfo.availableLiquidity?.amount?.value, 6), "free USDC") as string,
    // A token that isn't collateral lends nothing, whatever its numbers say.
    ltv_bp: collateral ? (need(fractionBp(wbtc.supplyInfo?.maxLTV?.value), "LTV for WBTC") as number) : 0,
    liq_bp: collateral ? (need(fractionBp(wbtc.supplyInfo?.liquidationThreshold?.value), "liquidation threshold for WBTC") as number) : 0,
    penalty_bp: need(fractionBp(wbtc.supplyInfo?.liquidationBonus?.value), "liquidation penalty for WBTC") as number,
  };
}

const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000;

/** A ray rate (a year's simple rate, 27 decimals) as bp a year, compounded each second as Aave's own API quotes it. */
export function rayApyBp(ray: bigint): number {
  // Twelve decimals of the rate are plenty for a figure in bp, and fit a double exactly.
  const apr = Number((ray * 10n ** 12n) / RAY) / 1e12;
  return Math.round(Math.expm1(SECONDS_PER_YEAR * Math.log1p(apr / SECONDS_PER_YEAR)) * 10_000);
}

/** The three calls of the testnet read, in the order readAaveCalls expects their results. */
export function aaveCalls(dataProvider: string, tokens: { usdc: string; wbtc: string } = AAVE_TESTNET_TOKENS) {
  return [
    { to: dataProvider, data: callWithAddress(SELECTORS.getReserveData, tokens.usdc) },
    { to: dataProvider, data: callWithAddress(SELECTORS.getReserveConfigurationData, tokens.wbtc) },
    { to: dataProvider, data: callWithAddress(SELECTORS.getVirtualUnderlyingBalance, tokens.usdc) },
  ];
}

/** The testnet terms from the three calls' results. */
export function readAaveCalls(results: string[]): Terms {
  const reserve = words(results[0] ?? "0x", 12, "getReserveData(USDC)");
  const config = words(results[1] ?? "0x", 10, "getReserveConfigurationData(WBTC)");
  const [free] = words(results[2] ?? "0x", 1, "getVirtualUnderlyingBalance(USDC)");
  const bp = (word: bigint, what: string) => {
    if (word > 100_000n) throw new EvmError(`WBTC's ${what} came back as ${word}, which isn't a figure out of 10,000`);
    return Number(word);
  };
  const collateral = config[5] === 1n;
  const bonus = bp(config[3]!, "liquidation bonus");
  return {
    rate_bp: rayApyBp(reserve[6]!),
    supply_bp: rayApyBp(reserve[5]!),
    // Test USDC has 6 decimals, so its units are micro-USD.
    free: free!.toString(),
    ltv_bp: collateral ? bp(config[1]!, "LTV") : 0,
    liq_bp: collateral ? bp(config[2]!, "liquidation threshold") : 0,
    penalty_bp: Math.max(0, bonus - 10_000),
  };
}

/** Reads Aave's test market through `evm`, refusing an RPC that answers for another chain than `chainId`. */
export async function readAaveTestnet(evm: EvmReader, chainId: number, dataProvider: string): Promise<Terms> {
  const answer = await evm.calls(aaveCalls(dataProvider));
  if (answer.chainId !== chainId) throw new EvmError(`EVM_RPC_URL answers for chain ${answer.chainId} but EVM_CHAIN_ID is ${chainId}: point both at the same chain`);
  return readAaveCalls(answer.results);
}
