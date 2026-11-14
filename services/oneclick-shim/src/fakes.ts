// In-memory stand-ins for the floats, for the unit tests. Nothing here touches a network.
import { baseSepoliaAssetId, OneClickClient, type QuoteRequest, type QuoteResponse, type TokenInfo } from "@pb/oneclick";

import { BASE_TWINS, formatUnits, HL_TESTNET_USDC_ASSET, NEAR_TWINS, shimAssets } from "./assets.js";
import { LOG_RANGE, type EvmFloat, type EvmTransfer } from "./evm-float.js";
import type { HlFloat, HlTransfer } from "./hl-float.js";
import type { FtTransfer, FtTransferResult, NearFloat } from "./near-float.js";

export const ASSETS = shimAssets({ musdc: "musdc.pbf-ops.testnet", mnbtc: "mnbtc.pbf-ops.testnet" });
export const MUSDC = "nep141:musdc.pbf-ops.testnet";
export const MNBTC = "nep141:mnbtc.pbf-ops.testnet";
export const HL_USDC = HL_TESTNET_USDC_ASSET;

export class FakeNear implements NearFloat {
  readonly accountId = "shim.pbf-ops.testnet";
  readonly transfers: FtTransfer[] = [];
  readonly #balances = new Map<string, bigint>();
  /** The next transfer throws this message. */
  failNext: string | undefined;
  /** What a receiver's ft_on_transfer keeps (ft_transfer_call only). */
  keptOnCall: bigint | undefined;

  /** Someone sends `amount` of `token` to `account`. */
  credit(token: string, account: string, amount: bigint): void {
    const key = `${token}:${account}`;
    this.#balances.set(key, (this.#balances.get(key) ?? 0n) + amount);
  }

  async balanceOf(token: string, account: string): Promise<bigint> {
    return this.#balances.get(`${token}:${account}`) ?? 0n;
  }

  async transfer(transfer: FtTransfer): Promise<FtTransferResult> {
    if (this.failNext) {
      const message = this.failNext;
      this.failNext = undefined;
      throw new Error(message);
    }
    this.transfers.push(transfer);
    const used = transfer.msg === undefined ? transfer.amount : (this.keptOnCall ?? transfer.amount);
    return { txHash: `near-tx-${this.transfers.length}`, usedAmount: used };
  }
}

export class FakeHl implements HlFloat {
  readonly address = "0x00000000000000000000000000000000000f10a7";
  readonly incoming: HlTransfer[] = [];
  readonly sends: { destination: string; amount: bigint }[] = [];

  async incomingTransfers(sinceMs: number): Promise<HlTransfer[]> {
    return this.incoming.filter((t) => t.time >= sinceMs);
  }

  async usdSend(destination: string, amount: bigint): Promise<{ hash: string }> {
    this.sends.push({ destination, amount });
    return { hash: `0xhl${this.sends.length}` };
  }
}

/** A quote request as a client would send it to the shim. */
export function request(overrides: Partial<QuoteRequest> = {}): QuoteRequest {
  return {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: MUSDC,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: MNBTC,
    amount: "10000000",
    refundTo: "pbf-keeper.testnet",
    refundType: "ORIGIN_CHAIN",
    recipient: "pbf-ops.testnet",
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(1_000_000 + 10 * 60_000).toISOString(),
    ...overrides,
  };
}

/** What the real 1Click answers for a dry quote: $10 of USDC into nBTC, in about 20 s. */
export function priced(amountIn = "10000000", amountOut = "13117", timeEstimate = 20): QuoteResponse {
  return {
    correlationId: "upstream-id",
    timestamp: "2026-11-07T08:11:46.614Z",
    signature: "ed25519:upstream",
    quoteRequest: {} as QuoteRequest,
    quote: {
      amountIn,
      amountInFormatted: "10",
      amountInUsd: "9.99",
      minAmountIn: amountIn,
      amountOut,
      amountOutFormatted: "0.00013117",
      amountOutUsd: "9.97",
      minAmountOut: "12985",
      timeEstimate,
    },
  };
}

// ---------- stage 4: Base Sepolia ----------

/** The tokens of the factory's Aave settings on Base Sepolia (INTERFACES.md 24 and 33). */
export const BASE_TOKENS = {
  usdc: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
  wbtc: "0x54114591963CF60EF3aA63bEfD6eC263D98145a4",
  weth: "0x4200000000000000000000000000000000000006",
};
export const ASSETS_WITH_BASE = shimAssets({ musdc: "musdc.pbf-ops.testnet", mnbtc: "mnbtc.pbf-ops.testnet" }, BASE_TOKENS);
export const B_USDC = baseSepoliaAssetId(BASE_TOKENS.usdc);
export const B_WBTC = baseSepoliaAssetId(BASE_TOKENS.wbtc);
export const B_WETH = baseSepoliaAssetId(BASE_TOKENS.weth);

/** The float on Base Sepolia, made up: balances, the blocks' logs, and everything it was asked to send. */
export class FakeEvm implements EvmFloat {
  readonly address = "0x2031181d63507368232579af4c64a1c3428407ff";
  readonly chainId = 84_532;
  block = 57_000_000;
  eth = 48_000_000_000_000_000n;
  readonly balances = new Map<string, bigint>();
  /** Aave's room for a token; a token not named here has no cap. */
  room: Record<string, bigint> = {};
  readonly logs: EvmTransfer[] = [];
  readonly receipts = new Map<string, EvmTransfer[]>();
  readonly sent: { kind: "transfer" | "wrap" | "unwrap" | "mint"; token?: string; to?: string; amount: bigint }[] = [];
  /** Every range of blocks whose logs were read. */
  readonly ranges: [string, number, number][] = [];
  /** What Aave's faucet says when it won't mint. */
  mintRefusal: string | null = null;
  /** The next send throws this message. */
  failNext: string | undefined;
  readonly #weth = BASE_TOKENS.weth.toLowerCase();

  /** `from` sends `amount` of `token` to the float, in the current block. */
  deposit(token: string, from: string, amount: bigint, hash = `0x${String(this.logs.length + 1).padStart(64, "0")}`): EvmTransfer {
    const transfer = { hash, logIndex: 0, block: this.block, token: token.toLowerCase(), from: from.toLowerCase(), amount };
    this.logs.push(transfer);
    this.#add(transfer.token, amount);
    return transfer;
  }

  #add(token: string, by: bigint): void {
    this.balances.set(token, (this.balances.get(token) ?? 0n) + by);
  }

  #fail(): void {
    if (!this.failNext) return;
    const message = this.failNext;
    this.failNext = undefined;
    throw new Error(message);
  }

  async blockNumber(): Promise<number> {
    return this.block;
  }

  async incoming(token: string, fromBlock: number, toBlock: number): Promise<EvmTransfer[]> {
    if (toBlock - fromBlock >= LOG_RANGE) throw new Error("eth_getLogs is limited to a 200 range");
    this.ranges.push([token, fromBlock, toBlock]);
    return this.logs.filter((l) => l.token === token && l.block >= fromBlock && l.block <= toBlock);
  }

  async receiptTransfers(hash: string): Promise<EvmTransfer[] | null> {
    return this.receipts.get(hash) ?? null;
  }

  async ethBalance(): Promise<bigint> {
    return this.eth;
  }

  async tokenBalance(token: string): Promise<bigint> {
    return this.balances.get(token.toLowerCase()) ?? 0n;
  }

  async aaveRoom(token: string): Promise<bigint | null> {
    return this.room[token.toLowerCase()] ?? null;
  }

  async transfer(token: string, to: string, amount: bigint): Promise<{ hash: string }> {
    this.#fail();
    if ((this.balances.get(token.toLowerCase()) ?? 0n) < amount) throw new Error("the transfer would fail: execution reverted: ERC20: transfer amount exceeds balance");
    this.#add(token.toLowerCase(), -amount);
    this.sent.push({ kind: "transfer", token: token.toLowerCase(), to, amount });
    return { hash: `0xbase${this.sent.length}` };
  }

  async wrap(amount: bigint): Promise<{ hash: string }> {
    this.#fail();
    if (this.eth < amount) throw new Error("wrapping would fail: insufficient funds for gas * price + value");
    this.eth -= amount;
    this.#add(this.#weth, amount);
    this.sent.push({ kind: "wrap", amount });
    return { hash: `0xbase${this.sent.length}` };
  }

  async unwrap(amount: bigint): Promise<{ hash: string }> {
    this.#fail();
    this.#add(this.#weth, -amount);
    this.eth += amount;
    this.sent.push({ kind: "unwrap", amount });
    return { hash: `0xbase${this.sent.length}` };
  }

  async mint(token: string, amount: bigint): Promise<{ hash: string }> {
    this.#fail();
    if (this.mintRefusal) throw new Error(`Aave's faucet minting would fail: ${this.mintRefusal}`);
    this.#add(token.toLowerCase(), amount);
    this.sent.push({ kind: "mint", token: token.toLowerCase(), amount });
    return { hash: `0xbase${this.sent.length}` };
  }

  async mintProblem(): Promise<string | null> {
    return this.mintRefusal;
  }
}

/** A NEAR float whose test tokens' own faucet mints to it (stage 4). */
export class FakeNearWithMint extends FakeNear {
  readonly minted: { token: string; amount: bigint }[] = [];

  async mint(token: string, amount: bigint): Promise<{ txHash: string }> {
    this.minted.push({ token, amount });
    this.credit(token, this.accountId, amount);
    return { txHash: `near-mint-${this.minted.length}` };
  }
}

/** 1Click's prices on the night of 11 Nov (its token list): cbBTC and WETH on Base, and the two USDC. */
export const BASE_PRICES = { cbbtc: 74_505, weth: 2_078.08, usdc: 0.999581 };

/**
 * The real 1Click, made up for the Base routes: a dry quote that pays out 99.7% (bitcoin) or 99.97% (USDC) of the
 * dollars that go in, in the destination twin's units, and a token list with the three prices.
 */
export function fakeUpstream() {
  const calls: QuoteRequest[] = [];
  const twins: Record<string, { decimals: number; price: number }> = {
    "nep141:nbtc.bridge.near": { decimals: 8, price: BASE_PRICES.cbbtc },
    [BASE_TWINS.wbtc]: { decimals: 8, price: BASE_PRICES.cbbtc },
    [BASE_TWINS.weth]: { decimals: 18, price: BASE_PRICES.weth },
    [BASE_TWINS.usdc]: { decimals: 6, price: BASE_PRICES.usdc },
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": { decimals: 6, price: BASE_PRICES.usdc },
  };
  return {
    calls,
    async quote(request: QuoteRequest): Promise<QuoteResponse> {
      calls.push(request);
      const from = twins[request.originAsset];
      const to = twins[request.destinationAsset];
      if (!from || !to) throw new Error(`no made-up price for ${request.originAsset} to ${request.destinationAsset}`);
      const usdIn = (Number(request.amount) / 10 ** from.decimals) * from.price;
      const usdOut = usdIn * (from.decimals === 6 && to.decimals === 6 ? 0.9997 : 0.997);
      const out = BigInt(Math.floor((usdOut / to.price) * 10 ** to.decimals));
      return {
        correlationId: "upstream-id",
        timestamp: "2026-11-11T21:42:00.000Z",
        signature: "ed25519:upstream",
        quoteRequest: request,
        quote: { amountIn: request.amount, amountInFormatted: String(Number(request.amount) / 10 ** from.decimals), amountInUsd: usdIn.toFixed(6), minAmountIn: request.amount, amountOut: out.toString(), amountOutFormatted: String(Number(out) / 10 ** to.decimals), amountOutUsd: usdOut.toFixed(6), minAmountOut: ((out * 99n) / 100n).toString(), timeEstimate: 22 },
      };
    },
    async tokens() {
      return Object.entries(twins).map(([assetId, t]) => ({ assetId, decimals: t.decimals, blockchain: "base", symbol: "?", price: t.price, priceUpdatedAt: "2026-11-11T21:40:00.000Z" }));
    },
  };
}

// ---------- section 49: five test tokens on NEAR ----------

/** The five NEAR test tokens: the two of Phase 1, and section 49's three at their default ids. */
export const SPOT_TOKENS = { musdc: "musdc.pbf-ops.testnet", mnbtc: "mnbtc.pbf-ops.testnet", meth: "meth.pbf-ops.testnet", mwnear: "mwnear.pbf-ops.testnet", musdt: "musdt.pbf-ops.testnet" };
export const ASSETS_FIVE = shimAssets(SPOT_TOKENS);
export const METH = "nep141:meth.pbf-ops.testnet";
export const MWNEAR = "nep141:mwnear.pbf-ops.testnet";
export const MUSDT = "nep141:musdt.pbf-ops.testnet";

/** 1Click's own token list (GET /v0/tokens) for the five on NEAR, as it answered on 13 Nov 2026 at 19:09 UTC. */
export const NEAR_LIST: TokenInfo[] = [
  { assetId: NEAR_TWINS.usdc, decimals: 6, blockchain: "near", symbol: "USDC", price: 0.999562, priceUpdatedAt: "2026-11-13T19:09:01.190Z", contractAddress: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" },
  { assetId: NEAR_TWINS.nbtc, decimals: 8, blockchain: "near", symbol: "BTC", price: 68940, priceUpdatedAt: "2026-11-13T19:09:01.190Z", contractAddress: "nbtc.bridge.near" },
  { assetId: NEAR_TWINS.eth, decimals: 18, blockchain: "near", symbol: "ETH", price: 1945.2, priceUpdatedAt: "2026-11-13T19:09:01.190Z", contractAddress: "eth.bridge.near" },
  { assetId: NEAR_TWINS.wnear, decimals: 24, blockchain: "near", symbol: "wNEAR", price: 3.53, priceUpdatedAt: "2026-11-13T19:09:01.190Z", contractAddress: "wrap.near" },
  { assetId: NEAR_TWINS.usdt, decimals: 6, blockchain: "near", symbol: "USDT", price: 0.999319, priceUpdatedAt: "2026-11-13T19:09:01.190Z", contractAddress: "usdt.tether-token.near" },
];

/** The list's prices as whole numbers of 10^-12 dollars, written out by hand (not derived from the numbers above). */
export const NEAR_PRICES_E12: Record<string, { decimals: number; price: bigint }> = {
  [NEAR_TWINS.usdc]: { decimals: 6, price: 999_562_000_000n },
  [NEAR_TWINS.nbtc]: { decimals: 8, price: 68_940_000_000_000_000n },
  [NEAR_TWINS.eth]: { decimals: 18, price: 1_945_200_000_000_000n },
  [NEAR_TWINS.wnear]: { decimals: 24, price: 3_530_000_000_000n },
  [NEAR_TWINS.usdt]: { decimals: 6, price: 999_319_000_000n },
};

/** What the made-up 1Click pays out for a swap on NEAR: the list's prices less 0.3%, in whole units, rounded down. */
export function spotOut(amountIn: bigint, fromTwin: string, toTwin: string): bigint {
  const [from, to] = [NEAR_PRICES_E12[fromTwin]!, NEAR_PRICES_E12[toTwin]!];
  return (amountIn * from.price * 10n ** BigInt(to.decimals) * 997n) / (to.price * 10n ** BigInt(from.decimals) * 1000n);
}

/**
 * The real 1Click, made up for swaps among the five on NEAR, behind a real client: its token list, and dry quotes in
 * exact whole units (`spotOut`), in 20 s. `refuse` makes the next quotes answer that instead; `list` replaces the
 * token list; `listFails` makes the list unreachable.
 */
export function fakeSpotUpstream() {
  const state = {
    quotes: [] as QuoteRequest[],
    listReads: 0,
    refuse: undefined as { status: number; body: unknown } | undefined,
    list: NEAR_LIST,
    listFails: false,
  };
  const client = new OneClickClient({
    baseUrl: "https://1click.example",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/v0/tokens")) {
        state.listReads += 1;
        return state.listFails ? new Response("bad gateway", { status: 502 }) : new Response(JSON.stringify(state.list), { status: 200 });
      }
      const request = JSON.parse(String(init?.body)) as QuoteRequest;
      state.quotes.push(request);
      if (state.refuse) return new Response(JSON.stringify(state.refuse.body), { status: state.refuse.status });
      const [from, to] = [NEAR_PRICES_E12[request.originAsset], NEAR_PRICES_E12[request.destinationAsset]];
      if (!from || !to) return new Response(JSON.stringify({ message: "tokenIn is not valid" }), { status: 400 });
      const amountIn = BigInt(request.amount);
      const out = spotOut(amountIn, request.originAsset, request.destinationAsset);
      const usd = (units: bigint, t: { decimals: number; price: bigint }) => formatUnits((units * t.price) / 10n ** BigInt(t.decimals), 12);
      const answer: QuoteResponse = {
        correlationId: "upstream-id",
        timestamp: "2026-11-13T19:10:00.000Z",
        signature: "ed25519:upstream",
        quoteRequest: request,
        quote: { amountIn: request.amount, amountInFormatted: formatUnits(amountIn, from.decimals), amountInUsd: usd(amountIn, from), minAmountIn: request.amount, amountOut: out.toString(), amountOutFormatted: formatUnits(out, to.decimals), amountOutUsd: usd(out, to), minAmountOut: ((out * 99n) / 100n).toString(), timeEstimate: 20 },
      };
      return new Response(JSON.stringify(answer), { status: 201 });
    }) as typeof fetch,
  });
  return { client, state };
}

// ---------- section 51.2: ether between NEAR and Base Sepolia ----------

/** Every asset at once: the five NEAR test tokens, Hyperliquid's USDC and Base Sepolia's three. */
export const ASSETS_ALL = shimAssets(SPOT_TOKENS, BASE_TOKENS);

/**
 * 1Click on 14 Nov 2026, about 09:55 UTC, as whole numbers of 10^-12 dollars: ETH at $1,915.26 wherever it is (on
 * NEAR, on Base, and as WETH on Base), bitcoin at $67,452 (nBTC, and cbBTC on Base), and the two USDC at $0.9996.
 */
export const ETH_ROUTE_PRICES_E12: Record<string, { decimals: number; price: bigint }> = {
  [NEAR_TWINS.eth]: { decimals: 18, price: 1_915_260_000_000_000n },
  [BASE_TWINS.eth]: { decimals: 18, price: 1_915_260_000_000_000n },
  [BASE_TWINS.weth]: { decimals: 18, price: 1_915_260_000_000_000n },
  [NEAR_TWINS.nbtc]: { decimals: 8, price: 67_452_000_000_000_000n },
  [BASE_TWINS.wbtc]: { decimals: 8, price: 67_452_000_000_000_000n },
  [NEAR_TWINS.usdc]: { decimals: 6, price: 999_600_000_000n },
  [BASE_TWINS.usdc]: { decimals: 6, price: 999_600_000_000n },
};

/** What the made-up 1Click pays out between two of those assets: their dollar value less 0.03%, rounded down. */
export function ethRouteOut(amountIn: bigint, fromTwin: string, toTwin: string): bigint {
  const [from, to] = [ETH_ROUTE_PRICES_E12[fromTwin]!, ETH_ROUTE_PRICES_E12[toTwin]!];
  return (amountIn * from.price * 10n ** BigInt(to.decimals) * 9_997n) / (to.price * 10n ** BigInt(from.decimals) * 10_000n);
}

/**
 * The real 1Click as it stood on 14 Nov, behind a real client: it prices ETH on NEAR and ETH on Base both ways (22 s
 * out, 35 s home), bitcoin and USDC as before, and answers "No liquidity available" (HTTP 400) for any quote that
 * names WETH on Base, as it did that day. Whole units, exact.
 */
export function fakeEthUpstream() {
  const state = { quotes: [] as QuoteRequest[] };
  const client = new OneClickClient({
    baseUrl: "https://1click.example",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/v0/tokens")) {
        const list = Object.entries(ETH_ROUTE_PRICES_E12).map(([assetId, t]) => ({ assetId, decimals: t.decimals, blockchain: assetId.includes("base") ? "base" : "near", symbol: "?", price: Number(t.price) / 1e12, priceUpdatedAt: "2026-11-14T09:53:30.953Z" }));
        return new Response(JSON.stringify(list), { status: 200 });
      }
      const request = JSON.parse(String(init?.body)) as QuoteRequest;
      state.quotes.push(request);
      const [from, to] = [ETH_ROUTE_PRICES_E12[request.originAsset], ETH_ROUTE_PRICES_E12[request.destinationAsset]];
      if (!from || !to) return new Response(JSON.stringify({ message: "tokenIn is not valid" }), { status: 400 });
      if ([request.originAsset, request.destinationAsset].includes(BASE_TWINS.weth)) return new Response(JSON.stringify({ message: "No liquidity available" }), { status: 400 });
      const amountIn = BigInt(request.amount);
      const out = ethRouteOut(amountIn, request.originAsset, request.destinationAsset);
      const usd = (units: bigint, t: { decimals: number; price: bigint }) => formatUnits((units * t.price) / 10n ** BigInt(t.decimals), 12);
      const answer: QuoteResponse = {
        correlationId: "upstream-id",
        timestamp: "2026-11-14T09:59:00.000Z",
        signature: "ed25519:upstream",
        quoteRequest: request,
        quote: { amountIn: request.amount, amountInFormatted: formatUnits(amountIn, from.decimals), amountInUsd: usd(amountIn, from), minAmountIn: request.amount, amountOut: out.toString(), amountOutFormatted: formatUnits(out, to.decimals), amountOutUsd: usd(out, to), minAmountOut: ((out * 99n) / 100n).toString(), timeEstimate: request.destinationAsset.includes("base") ? 22 : 35 },
      };
      return new Response(JSON.stringify(answer), { status: 201 });
    }) as typeof fetch,
  });
  return { client, state };
}
