// The shim's Hyperliquid testnet float. Every Hyperliquid quote's deposit address is the float's
// address, so a deposit is found in the float's ledger by its sender and amount. Deliveries and
// refunds are usdSend from the float (perp USDC, which is where 1Click credits Hyperliquid).
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";

import { formatUnits, parseUnits } from "./assets.js";
import { localWallet } from "./hl-wallet.js";

/** Hyperliquid USDC amounts in the shim are in 1Click's units for the asset: 8 decimals. */
export const HL_USDC_DECIMALS = 8;
/** usdSend moves perp USDC, which has 6 decimals. */
const USD_SEND_DECIMALS = 6;

export interface HlTransfer {
  hash: string;
  time: number;
  /** Lowercase sender address. */
  from: string;
  /** In 8-decimal units. */
  amount: bigint;
}

export interface HlFloat {
  /** Lowercase float address. */
  readonly address: string;
  /** USDC sent to the float since `sinceMs`, by usdSend, spotSend or sendAsset. */
  incomingTransfers(sinceMs: number): Promise<HlTransfer[]>;
  /** Sends USDC from the float's perp balance. Returns the ledger hash once it shows up. */
  usdSend(destination: string, amount: bigint): Promise<{ hash: string }>;
}

/** usdSend takes at most 6 decimals: round down, so the float never sends more than quoted. */
export function usdSendAmount(amount: bigint): string {
  const step = 10n ** BigInt(HL_USDC_DECIMALS - USD_SEND_DECIMALS);
  return formatUnits((amount / step) * step, HL_USDC_DECIMALS);
}

interface LedgerDelta {
  type: string;
  user?: string;
  destination?: string;
  usdc?: string;
  token?: string;
  amount?: string;
}

/** Picks the USDC transfers into `address` out of the float's non-funding ledger. */
export function incomingUsdc(address: string, updates: { time: number; hash: string; delta: LedgerDelta }[]): HlTransfer[] {
  const transfers: HlTransfer[] = [];
  for (const { time, hash, delta } of updates) {
    if (delta.destination?.toLowerCase() !== address || !delta.user) continue;
    let amount: string | undefined;
    if (delta.type === "internalTransfer") amount = delta.usdc; // usdSend
    else if ((delta.type === "send" || delta.type === "spotTransfer") && delta.token?.startsWith("USDC")) amount = delta.amount; // sendAsset, spotSend
    if (amount === undefined) continue;
    transfers.push({ hash, time, from: delta.user.toLowerCase(), amount: parseUnits(amount, HL_USDC_DECIMALS) });
  }
  return transfers;
}

export function hlFloat(apiUrl: string, address: string, privateKey: string): HlFloat {
  const wallet = localWallet(privateKey);
  const float = address.toLowerCase();
  if (wallet.address !== float) throw new Error("HL_FLOAT_PRIVATE_KEY does not belong to HL_FLOAT_ADDRESS");

  const transport = new HttpTransport({ isTestnet: true, apiUrl });
  const info = new InfoClient({ transport });
  // signatureChainId 0x66eee, as the Python SDK uses (research/hyperliquid.md 1).
  const exchange = new ExchangeClient({ transport, wallet, signatureChainId: "0x66eee" });

  const ledger = async (sinceMs: number) =>
    (await info.userNonFundingLedgerUpdates({ user: float as `0x${string}`, startTime: sinceMs })) as unknown as {
      time: number;
      hash: string;
      delta: LedgerDelta;
    }[];

  return {
    address: float,

    async incomingTransfers(sinceMs) {
      return incomingUsdc(float, await ledger(sinceMs));
    },

    async usdSend(destination, amount) {
      const sentAt = Date.now();
      const amountText = usdSendAmount(amount);
      await exchange.usdSend({ destination: destination.toLowerCase() as `0x${string}`, amount: amountText });
      // usdSend's answer carries no hash; find our transfer in the float's ledger for the explorer link.
      const sent = (await ledger(sentAt - 5_000)).find(
        (u) => u.delta.type === "internalTransfer" && u.delta.destination?.toLowerCase() === destination.toLowerCase(),
      );
      return { hash: sent?.hash ?? "" };
    },
  };
}
