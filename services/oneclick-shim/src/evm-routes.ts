// Stage 4 (INTERFACES.md 36): the four routes between NEAR and Base Sepolia, how each is priced, and what the float
// can fill.
//
//   mNBTC -> WBTC   bitcoin to Aave's chain. Priced as 1Click's nBTC -> cbBTC on Base. When Aave's test market has no
//                   room for that much WBTC (its supply cap), the quote delivers WETH of the same dollar value
//                   instead, and says so: `quoteRequest.destinationAsset` and the amounts are WETH's, and `shim` says
//                   what was asked for and why. mNBTC -> WETH may also be asked for by name.
//   mUSDC -> USDC   1Click's USDC on NEAR -> USDC on Base.
//   USDC -> mUSDC   the same route the other way.
//   WBTC -> mNBTC   1Click's cbBTC on Base -> nBTC. WETH -> mNBTC: the WETH's dollar value in cbBTC, then that route.
//
// Section 51.2 (INTERFACES.md 51): two more, for ether, so a client's own ETH on NEAR can be posted at Aave.
//
//   ETH -> WETH     test ETH on NEAR to WETH on Base Sepolia, wrapped from the float's own test ETH (the cap and the
//                   gas reserve below apply as they are).
//   WETH -> ETH     WETH home as test ETH, from the float's stock on NEAR (it mints what it is short of, engine.ts).
//                   WETH comes home as bitcoin unless the quote's destination is test ETH.
//
// Both are priced as 1Click's ETH on NEAR and ETH on Base (`nep141:eth.bridge.near`, `nep141:base.omft.near`). 1Click
// gives no price between ETH on NEAR and WETH on Base ("No liquidity available", both ways, from 0.0001 to 1 ETH, on
// 14 Nov), and prices ETH on Base both ways (0.02 ETH out arrived as 0.0199954, in 22 s; home, 35 s). WETH is ETH
// wrapped one for one, which is how the float makes it, so that is the price of the move. Every amount has 18
// decimals, so 1Click's units carry over unchanged.
//
// WETH's dollar value. 1Click prices no route between nBTC and WETH on Base ("No liquidity available", both ways, on
// 11 Nov). So the bitcoin leg takes 1Click's real price and cost for nBTC and cbBTC, and the step between cbBTC's
// dollars and WETH uses the prices in 1Click's own token list (GET /v0/tokens).
//
// What the float can fill is checked when the quote is made, dry or not, so nobody deposits into a quote that can't
// deliver:
//   - WETH: at most 0.02 a move, and only what the float can wrap from its test ETH while keeping 0.003 for gas;
//   - WBTC and USDC on Base: what the float holds, or what Aave's faucet would mint to it now. The faucet is open to
//     anyone and gives at most 1 WBTC or 1,000,000 USDC a call ("Mint limit transaction exceeded" above that, read
//     with eth_estimateGas on 11 Nov); research/aave.md adds once an hour for a recipient and token. The node runs the
//     mint without sending it, so a faucet that would refuse says so here.
import type { OneClickClient, QuoteRequest, QuoteResponse, ShimNote, TokenInfo } from "@pb/oneclick";

import { BASE_TWINS, formatUnits, mainnetPlaceholder, NEAR_TWINS, type ShimAsset } from "./assets.js";
import type { EvmFloat } from "./evm-float.js";

/** One move brings at most this much WETH: the float holds about 0.048 test ETH, and can't easily get more. */
export const MAX_WETH_OUT = 20_000_000_000_000_000n;
/** What the float keeps in ETH after wrapping, for the gas of its own transactions. */
export const ETH_RESERVE_WEI = 3_000_000_000_000_000n;
/** Aave's faucet's most in one call, in whole tokens. */
export const FAUCET_MAX_TOKENS: Record<string, bigint> = { WBTC: 1n, USDC: 1_000_000n };

export type EvmRoute = "btc_out" | "usdc_out" | "usdc_home" | "btc_home" | "eth_out" | "eth_home";

/** A quote the stand-in won't make, in words for whoever asked. */
export class RouteRefused extends Error {}

/** Which of the six routes this pair is; null when neither side is on Base Sepolia. Throws for any other pair that is. */
export function evmRoute(origin: ShimAsset, destination: ShimAsset): EvmRoute | null {
  if (origin.chain !== "evm" && destination.chain !== "evm") return null;
  const near = (a: ShimAsset, symbol: string) => a.chain === "near" && a.symbol === symbol;
  const base = (a: ShimAsset, ...symbols: string[]) => a.chain === "evm" && symbols.includes(a.symbol);
  if (near(origin, "mNBTC") && base(destination, "WBTC", "WETH")) return "btc_out";
  if (near(origin, "mUSDC") && base(destination, "USDC")) return "usdc_out";
  if (base(origin, "USDC") && near(destination, "mUSDC")) return "usdc_home";
  if (base(origin, "WBTC", "WETH") && near(destination, "mNBTC")) return "btc_home";
  // Section 51.2: test ETH on NEAR is the asset priced as 1Click's ETH on NEAR, whatever its token is called.
  const nearEth = (a: ShimAsset) => a.chain === "near" && a.mainnetAssetId === NEAR_TWINS.eth;
  if (nearEth(origin) && base(destination, "WETH")) return "eth_out";
  if (base(origin, "WETH") && nearEth(destination)) return "eth_home";
  throw new RouteRefused(`The stand-in moves bitcoin and USDC between NEAR and Base Sepolia on four routes only: mNBTC to WBTC (or WETH), mUSDC to USDC, USDC to mUSDC, and WBTC or WETH to mNBTC. Ether has two more: ETH to WETH, and WETH to ETH. ${origin.symbol} to ${destination.symbol} isn't one`);
}

export interface RouteDeps {
  upstream: Pick<OneClickClient, "quote" | "tokens">;
  assets: ShimAsset[];
  /** Undefined when the Base Sepolia float is off: prices still work, and nothing about the float is checked. */
  evm?: EvmFloat;
  now: () => number;
  deadlineMs: number;
}

export interface PricedRoute {
  /** The request as it is answered: its destination is the asset the quote delivers. */
  request: QuoteRequest;
  priced: QuoteResponse;
  note?: ShimNote;
}

const twin = (assets: ShimAsset[], symbol: string) => assets.find((a) => a.chain === "evm" && a.symbol === symbol);

/** Prices one of the six routes with the real 1Click, and refuses what the float couldn't fill. */
export async function priceEvmRoute(deps: RouteDeps, request: QuoteRequest, origin: ShimAsset, destination: ShimAsset, route: EvmRoute): Promise<PricedRoute> {
  const { customRecipientMsg: _msg, ...rest } = request;
  const upstream = (from: ShimAsset, to: ShimAsset, amount: string) =>
    deps.upstream.quote({
      ...rest,
      dry: true,
      originAsset: from.mainnetAssetId,
      destinationAsset: to.mainnetAssetId,
      amount,
      recipient: mainnetPlaceholder(to.chain),
      refundTo: mainnetPlaceholder(from.chain),
      deadline: request.deadline ?? new Date(deps.now() + deps.deadlineMs).toISOString(),
    });
  let prices: TokenInfo[] | undefined;
  const priceOf = async (asset: ShimAsset): Promise<number> => {
    prices ??= await deps.upstream.tokens();
    const price = prices.find((t) => t.assetId === asset.mainnetAssetId)?.price;
    if (typeof price !== "number" || !(price > 0)) throw new Error(`1Click's token list has no price for ${asset.symbol}'s mainnet twin (${asset.mainnetAssetId})`);
    return price;
  };
  const wbtc = twin(deps.assets, "WBTC");
  const weth = twin(deps.assets, "WETH");

  let out: PricedRoute;
  if (route === "btc_out") {
    if (!wbtc) throw new RouteRefused("The factory's Aave settings list no WBTC, so the stand-in has no price for bitcoin on Base Sepolia");
    const asBtc = await upstream(origin, wbtc, request.amount);
    let delivers = destination;
    let note: ShimNote | undefined;
    if (destination.symbol === "WBTC" && deps.evm && weth) {
      const room = await deps.evm.aaveRoom(wbtc.contract, wbtc.decimals);
      if (room !== null && room < BigInt(asBtc.quote.amountOut)) {
        delivers = weth;
        note = {
          asked: destination.assetId,
          delivers: weth.assetId,
          symbol: weth.symbol,
          why: `Aave's test market has room for ${formatUnits(room, wbtc.decimals)} more WBTC (its supply cap), less than the ${asBtc.quote.amountOutFormatted} this would bring: the bitcoin arrives as wrapped test ETH of the same dollar value`,
        };
      }
    }
    if (delivers.symbol === "WBTC") {
      out = { request, priced: asBtc };
    } else {
      // WETH of the same dollar value: 1Click's dollars for the cbBTC, at its token list's price for WETH.
      const usd = Number(asBtc.quote.amountOutUsd);
      const amountOut = BigInt(Math.floor((usd / (await priceOf(delivers))) * 1e9)) * 10n ** 9n;
      if (!(usd > 0) || amountOut <= 0n) throw new RouteRefused("That is too little bitcoin to arrive as any WETH");
      const minOut = (amountOut * BigInt(asBtc.quote.minAmountOut)) / BigInt(asBtc.quote.amountOut);
      out = {
        request: { ...request, destinationAsset: delivers.assetId },
        priced: { ...asBtc, quote: { ...asBtc.quote, amountOut: amountOut.toString(), amountOutFormatted: formatUnits(amountOut, delivers.decimals), minAmountOut: minOut.toString() } },
        ...(note ? { note } : {}),
      };
    }
  } else if (route === "btc_home" && origin.symbol === "WETH") {
    if (!wbtc) throw new RouteRefused("The factory's Aave settings list no WBTC, so the stand-in has no price for bitcoin on Base Sepolia");
    const usd = (Number(BigInt(request.amount) / 10n ** 9n) / 1e9) * (await priceOf(origin));
    const asBtc = BigInt(Math.floor((usd / (await priceOf(wbtc))) * 10 ** wbtc.decimals));
    if (asBtc <= 0n) throw new RouteRefused("That is too little WETH to come home as any bitcoin");
    const home = await upstream(wbtc, destination, asBtc.toString());
    out = { request, priced: { ...home, quote: { ...home.quote, amountIn: request.amount, amountInFormatted: formatUnits(request.amount, origin.decimals), amountInUsd: usd.toFixed(6), minAmountIn: request.amount } } };
  } else if (route === "eth_out" || route === "eth_home") {
    // 1Click's price for ETH on NEAR and ETH on Base: it has none for WETH on Base, which is that ETH wrapped one
    // for one. The request and what is delivered stay WETH's.
    const asEth = (asset: ShimAsset): ShimAsset => (asset.chain === "evm" ? { ...asset, mainnetAssetId: BASE_TWINS.eth } : asset);
    out = { request, priced: await upstream(asEth(origin), asEth(destination), request.amount) };
  } else {
    out = { request, priced: await upstream(origin, destination, request.amount) };
  }

  const delivered = deps.assets.find((a) => a.assetId === out.request.destinationAsset)!;
  const problem = await fillProblem(deps.evm, delivered, BigInt(out.priced.quote.amountOut), BigInt(out.priced.quote.amountIn), origin);
  if (problem) throw new RouteRefused(problem);
  return out;
}

/** Why the float couldn't deliver `amountOut` of `asset` on Base Sepolia, in words, or null if it can. */
export async function fillProblem(evm: EvmFloat | undefined, asset: ShimAsset, amountOut: bigint, amountIn: bigint, origin: ShimAsset): Promise<string | null> {
  if (asset.chain !== "evm") return null;
  const show = (units: bigint) => `${formatUnits(units, asset.decimals)} ${asset.symbol}`;
  if (asset.symbol === "WETH" && amountOut > MAX_WETH_OUT) {
    const most = (amountIn * MAX_WETH_OUT) / amountOut;
    return `This would arrive as ${show(amountOut)}, and the stand-in brings at most ${show(MAX_WETH_OUT)} in one move: its float has little test ETH. Send at most ${formatUnits(most, origin.decimals)} ${origin.symbol} (${most} units)`;
  }
  if (!evm) return null;
  const held = await evm.tokenBalance(asset.contract);
  if (held >= amountOut) return null;
  const short = amountOut - held;
  if (asset.symbol === "WETH") {
    const eth = await evm.ethBalance();
    if (eth >= short + ETH_RESERVE_WEI) return null;
    return `The stand-in's float holds ${formatUnits(eth, 18)} test ETH and ${show(held)}: it can't wrap ${formatUnits(short, 18)} more and keep ${formatUnits(ETH_RESERVE_WEI, 18)} for gas. Ask for less, or send the float (${evm.address}) test ETH on Base Sepolia`;
  }
  const most = (FAUCET_MAX_TOKENS[asset.symbol] ?? 0n) * 10n ** BigInt(asset.decimals);
  if (short > most) return `The stand-in's float holds ${show(held)}, and Aave's faucet gives at most ${show(most)} in one call: it can't deliver ${show(amountOut)}`;
  const refused = await evm.mintProblem(asset.contract, short);
  return refused ? `The stand-in's float holds ${show(held)}, and Aave's faucet wouldn't mint the ${show(short)} it is short of now (${refused}): it gives each address each token once an hour` : null;
}
