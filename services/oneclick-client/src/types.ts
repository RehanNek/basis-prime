// The parts of the 1Click API we use (https://1click.chaindefuser.com, v0).
// Field names follow the live API as seen on 7 Nov 2026 (research/intents.md, research/day1.md 4-6).

/** The seven statuses 1Click reports for a deposit address. */
export type SwapStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "SUCCESS"
  | "INCOMPLETE_DEPOSIT"
  | "REFUNDED"
  | "FAILED";

/** Statuses that never change again. */
export const TERMINAL_STATUSES: readonly SwapStatus[] = ["SUCCESS", "INCOMPLETE_DEPOSIT", "REFUNDED", "FAILED"];

export function isTerminal(status: SwapStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** One entry of GET /v0/tokens. */
export interface TokenInfo {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  /** USD price, for display only. */
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string;
  coingeckoId?: string;
}

export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
export type DepositType = "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type RecipientType = "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type RefundType = "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";

/**
 * Body of POST /v0/quote. Amounts are strings in the asset's smallest unit.
 * The live API refuses a quote that leaves out any field before `depositMode` (checked 7 Nov 2026).
 */
export interface QuoteRequest {
  /** true: a price only, no deposit address. false: a committed quote with a deposit address. */
  dry: boolean;
  swapType: SwapType;
  /** Basis points: 100 = 1%. */
  slippageTolerance: number;
  originAsset: string;
  depositType: DepositType;
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: RefundType;
  recipient: string;
  recipientType: RecipientType;
  /** ISO time. The deposit must arrive before it. */
  deadline: string;
  depositMode?: "SIMPLE" | "MEMO";
  /** NEAR recipients only: 1Click delivers with ft_transfer_call and this msg instead of ft_transfer. */
  customRecipientMsg?: string;
  referral?: string;
  quoteWaitingTimeMs?: number;
  appFees?: { recipient: string; fee: number }[];
}

export interface Quote {
  /** Only on committed (non-dry) quotes: where to send amountIn. */
  depositAddress?: string;
  depositMemo?: string | null;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn?: string;
  maxAmountIn?: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  /** Only on committed quotes. */
  deadline?: string;
  timeWhenInactive?: string;
  /** Seconds from deposit to delivery. */
  timeEstimate: number;
  refundFee?: string;
  withdrawFee?: string;
}

export interface QuoteResponse {
  correlationId: string;
  timestamp: string;
  signature: string;
  quoteRequest: QuoteRequest;
  quote: Quote;
  /** The testnet stand-in only (INTERFACES.md 36): set when a quote delivers another asset than the one asked for. */
  shim?: ShimNote;
}

/**
 * The stand-in's note on a quote for bitcoin to Aave's chain: Aave's test market caps how much WBTC it takes, so when
 * there is no room for the amount, the stand-in delivers wrapped test ETH of the same dollar value. The quote's
 * `quoteRequest.destinationAsset` and its amounts are then WETH's; this says what was asked for, and why.
 */
export interface ShimNote {
  /** The destination asset the request named. */
  asked: string;
  /** The asset the quote delivers, and its symbol. */
  delivers: string;
  symbol: string;
  /** In words, for the person looking at the quote. */
  why: string;
}

/**
 * The stand-in's third chain (INTERFACES.md 36): Base Sepolia, where Aave's test market is. 1Click has no testnet,
 * so these ids are the stand-in's own, in 1Click's `1cs_v1:<chain>:erc20:<address>` form (its token list names
 * newer Base tokens that way, read 11 Nov) with a chain name 1Click doesn't use, so none can be mistaken for a
 * mainnet asset: WETH has the same address on Base and on Base Sepolia.
 */
export const BASE_SEPOLIA_ASSET_PREFIX = "1cs_v1:base-sepolia:erc20:";

/** The stand-in's asset id for a token on Base Sepolia, by its address. */
export function baseSepoliaAssetId(address: string): string {
  return `${BASE_SEPOLIA_ASSET_PREFIX}${address.toLowerCase()}`;
}

/** The token's address (lowercase) for one of those ids, or null for any other asset id. */
export function baseSepoliaAddress(assetId: string): string | null {
  const address = assetId.startsWith(BASE_SEPOLIA_ASSET_PREFIX) ? assetId.slice(BASE_SEPOLIA_ASSET_PREFIX.length) : "";
  return /^0x[0-9a-f]{40}$/.test(address) ? address : null;
}

/** Body of POST /v0/deposit/submit: tells 1Click a deposit was sent, to speed it up. */
export interface SubmitDepositRequest {
  txHash: string;
  depositAddress: string;
  nearSenderAccount?: string;
  memo?: string;
}

export interface TxHashRef {
  hash: string;
  explorerUrl: string;
}

export interface SwapDetails {
  intentHashes?: string[];
  nearTxHashes?: string[];
  amountIn?: string;
  amountInFormatted?: string;
  amountInUsd?: string;
  amountOut?: string;
  amountOutFormatted?: string;
  amountOutUsd?: string;
  slippage?: number;
  originChainTxHashes: TxHashRef[];
  destinationChainTxHashes: TxHashRef[];
  depositedAmount?: string;
  depositedAmountFormatted?: string;
  refundedAmount?: string;
  refundedAmountFormatted?: string;
  refundReason?: string;
}

/** Answer of GET /v0/status and POST /v0/deposit/submit. */
export interface StatusResponse {
  correlationId: string;
  quoteResponse: QuoteResponse;
  status: SwapStatus;
  updatedAt: string;
  swapDetails: SwapDetails;
}
