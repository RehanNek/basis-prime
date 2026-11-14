// The shim's state: every committed quote ("swap") and the fault switch.
// It lives in memory and, when a file is given, in a small JSON file, so a restart loses nothing.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { QuoteRequest, QuoteResponse, ShimNote, SwapStatus } from "@pb/oneclick";

import type { Chain } from "./assets.js";

/** The fault switch. It applies to every swap whose deposit arrives while it is on. */
export type FaultMode = "none" | "refund" | "fail" | "late";

export interface Fault {
  mode: FaultMode;
  /** For "late": how long after the quoted time the delivery happens. */
  delaySeconds: number;
}

export const DEFAULT_LATE_SECONDS = 600;

export interface Swap {
  /** Our correlationId. */
  id: string;
  createdAt: number;
  /** The quote request as the client sent it, with testnet asset ids. */
  request: QuoteRequest;
  /** What we answered, including the deposit address. */
  response: QuoteResponse;
  origin: Chain;
  destination: Chain;
  depositAddress: string;
  /** Set on Hyperliquid quotes, which all share the float's address, to tell them apart. */
  depositMemo: string | null;
  deadline: number;
  /** After this the shim stops watching the deposit address. */
  inactiveAt: number;
  status: SwapStatus;
  updatedAt: number;
  /** Deposit transactions: reported with /v0/deposit/submit, or matched on Hyperliquid. */
  depositTxHashes: string[];
  /** Origin-token units seen at the deposit address. */
  depositedAmount: string;
  depositedAt?: number;
  /** The fault in force when the deposit arrived. */
  fault?: Fault;
  /** When the shim delivers (or acts out the fault). */
  deliverAt?: number;
  deliveryTxHash?: string;
  deliveredAmount?: string;
  refundTxHash?: string;
  refundedAmount: string;
  /** Why it was refunded or failed. */
  reason?: string;
  /** Set while a transfer is being sent, so a crash mid-send never leads to sending twice. */
  sending?: "delivery" | "refund";
  /** Base Sepolia deposits: the block the quote was made in, and how far the logs have been read for it. */
  evmFromBlock?: number;
  /** Set when the quote delivers WETH where WBTC was asked for (INTERFACES.md 36). */
  note?: ShimNote;
  /** WETH that came back and was turned into the float's test ETH again. */
  unwrapTxHash?: string;
}

/** A token transfer into the Base Sepolia float that no quote has claimed yet. Amounts are strings: the state is JSON. */
export interface SeenEvmTransfer {
  hash: string;
  logIndex: number;
  block: number;
  token: string;
  from: string;
  amount: string;
}

export interface ShimState {
  fault: Fault;
  swaps: Record<string, Swap>;
  /** Hyperliquid ledger entries already matched to a swap, so none is counted twice. */
  usedHlHashes: string[];
  /** Base Sepolia: transfers matched to a swap ("<tx hash>:<log index>"), transfers seen and not matched yet, and the last block read for each token. */
  usedEvmLogs: string[];
  evmSeen: SeenEvmTransfer[];
  evmScannedTo: Record<string, number>;
}

export class Store {
  state: ShimState;
  readonly #file: string | undefined;

  /** With no file, the state is kept in memory only (tests). */
  constructor(file?: string) {
    this.#file = file;
    this.state = { fault: { mode: "none", delaySeconds: DEFAULT_LATE_SECONDS }, swaps: {}, usedHlHashes: [], usedEvmLogs: [], evmSeen: [], evmScannedTo: {} };
    if (file) {
      try {
        this.state = { ...this.state, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<ShimState>) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  /** Writes the state to its file: a temporary file first, then a rename, so it is never half-written. */
  save(): void {
    if (!this.#file) return;
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    renameSync(tmp, this.#file);
  }

  swaps(): Swap[] {
    return Object.values(this.state.swaps);
  }

  /** The swap for a deposit address (and memo, on Hyperliquid). */
  find(depositAddress: string, depositMemo?: string | null): Swap | undefined {
    const address = depositAddress.toLowerCase();
    return this.swaps().find(
      (s) => s.depositAddress.toLowerCase() === address && (s.depositMemo === null || s.depositMemo === depositMemo),
    );
  }
}
