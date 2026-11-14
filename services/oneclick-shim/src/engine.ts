// The life of a committed quote in the shim, with 1Click's statuses:
//
//   PENDING_DEPOSIT -> (deposit reported) KNOWN_DEPOSIT_TX -> (full deposit seen) PROCESSING
//     -> after the quoted time: SUCCESS (delivered from the float), or what the fault switch forces:
//        REFUNDED (the deposit goes back to refundTo), FAILED (nothing moves), or a late SUCCESS.
//   A deposit short of amountIn at the deadline: INCOMPLETE_DEPOSIT, and the part that came is refunded.
//   A deposit after the deadline: REFUNDED.
//
// Deposits on NEAR are found with ft_balance_of on the quote's own deposit address. On Hyperliquid,
// every quote shares the float's address, so a deposit is the oldest unused ledger entry from the
// quote's sender (its refundTo) for exactly amountIn.
//
// Stage 4 (INTERFACES.md 36): Base Sepolia works as Hyperliquid does. Every quote shares the float's address (the gas
// wallet), and a deposit is the oldest unused transfer of the quote's token from the quote's sender for exactly
// amountIn, in a block no older than the quote. A reported transaction is read from its receipt; otherwise the
// float's incoming transfers are read since the quote began, 200 blocks at a time (evm-float.ts says why). A
// delivery there is a token transfer from the float: WETH is wrapped from its test ETH when it is short, and test
// WBTC and USDC are minted by Aave's faucet. WETH that comes back is unwrapped once its swap has delivered.
//
// Section 49 (the Spot page): five test tokens swap on NEAR, any two of them, through this same life. Amounts are
// whole units in BigInt, whatever the token's decimals (6, 8, 18 or 24). The float delivers and refunds from its own
// stock, and has the test token's public faucet mint what it is short of.
//
// Section 51.2: test ETH on NEAR to WETH on Base Sepolia and back (evm-routes.ts) is this same machinery. WETH out is
// wrapped from the float's test ETH; WETH that comes home is unwrapped again, whether it comes home as bitcoin or as
// test ETH; and the test ETH handed back on NEAR is minted when the float is short.
//
// The msg (INTERFACES.md 14). 1Click's quote takes `customRecipientMsg`, "Message to pass to ft_transfer_call
// when withdrawing assets to NEAR" (its openapi.yaml, QuoteRequest, read 8 Nov). The shim delivers to a NEAR
// recipient with ft_transfer_call and that msg, as 1Click does, and also refunds to a NEAR refundTo with it, so
// the account learns of a refund the same way: {"pb":{"transfer":"<id>"}}. 1Click's spec says nothing of a msg on
// refunds; the refund half is the stand-in's own.
import { randomBytes, randomUUID } from "node:crypto";

import { isTerminal, type QuoteRequest, type QuoteResponse, type ShimNote, type StatusResponse, type SwapStatus, type TxHashRef } from "@pb/oneclick";

import { formatUnits, parseUnits, type Chain, type ShimAsset } from "./assets.js";
import { LOG_RANGE, type EvmFloat, type EvmTransfer } from "./evm-float.js";
import { HL_USDC_DECIMALS, usdSendAmount, type HlFloat, type HlTransfer } from "./hl-float.js";
import type { NearFloat } from "./near-float.js";
import type { Fault, Store, Swap } from "./state.js";

/** A deposit seen this soon after the deadline still counts, since the shim polls every few seconds. */
export const DEADLINE_GRACE_MS = 30_000;
/** How long the shim keeps watching after the deadline, so a late deposit is refunded, not lost. */
export const WATCH_AFTER_DEADLINE_MS = 10 * 60_000;
/** 1Click's default quote lifetime. */
export const DEFAULT_DEADLINE_MS = 10 * 60_000;
/** A Hyperliquid transfer this long before the quote can't be its deposit. */
const HL_CLOCK_SKEW_MS = 60_000;
/** Base Sepolia: at most this many 200-block reads of the logs for one token in one tick (800 s of chain). */
const MAX_LOG_CHUNKS = 20;
/**
 * The logs are read up to this many blocks behind the newest one (1 s at Base Sepolia's 0.2 s blocks). The public RPC
 * is several nodes: one can name a newer block than the next has logs for, and a range read too early would pass
 * over a deposit for good.
 */
export const LOG_LAG_BLOCKS = 5;

/** What GET /v0/status returns: 1Click's shape, plus a `shim` block for the drill panel. */
export type ShimStatus = StatusResponse & {
  shim: { fault: Fault["mode"] | null; deliverAt: string | null; refundTxHash: string | null; note?: ShimNote };
};

export interface EngineDeps {
  store: Store;
  assets: ShimAsset[];
  near?: NearFloat;
  hl?: HlFloat;
  /** Stage 4: the float on Base Sepolia. */
  evm?: EvmFloat;
  now?: () => number;
  log?: (line: string) => void;
}

export class Engine {
  readonly #store: Store;
  readonly #assets: ShimAsset[];
  readonly #near: NearFloat | undefined;
  readonly #hl: HlFloat | undefined;
  readonly #evm: EvmFloat | undefined;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  /** All state changes run one at a time, so no swap is ever delivered twice. */
  #queue: Promise<unknown> = Promise.resolve();
  /** The float's incoming Hyperliquid transfers, read once per tick. */
  #hlCache: HlTransfer[] | undefined;
  /** The Base Sepolia tokens whose logs were read on this tick. */
  readonly #evmScanned = new Set<string>();

  constructor(deps: EngineDeps) {
    this.#store = deps.store;
    this.#assets = deps.assets;
    this.#near = deps.near;
    this.#hl = deps.hl;
    this.#evm = deps.evm;
    this.#now = deps.now ?? Date.now;
    this.#log = deps.log ?? (() => {});
  }

  asset(assetId: string): ShimAsset {
    const asset = this.#assets.find((a) => a.assetId === assetId);
    if (!asset) throw new Error(`Unknown asset ${assetId}`);
    return asset;
  }

  get fault(): Fault {
    return this.#store.state.fault;
  }

  setFault(fault: Fault): void {
    this.#store.state.fault = fault;
    this.#store.save();
    this.#log(`fault switch: ${fault.mode}${fault.mode === "late" ? ` (${fault.delaySeconds} s late)` : ""}`);
  }

  /** After a restart: a swap caught mid-send is marked FAILED rather than sent again. */
  recover(): void {
    for (const swap of this.#store.swaps()) {
      if (!swap.sending) continue;
      swap.reason = `the shim stopped while sending the ${swap.sending}; check the float's transactions before retrying by hand`;
      delete swap.sending;
      this.#setStatus(swap, "FAILED");
    }
    this.#store.save();
  }

  /** Turns a priced (dry) quote into a committed one: picks the deposit address and starts watching it. */
  openSwap(request: QuoteRequest, priced: QuoteResponse, extra: { evmFromBlock?: number; note?: ShimNote } = {}): QuoteResponse {
    const origin = this.asset(request.originAsset);
    const destination = this.asset(request.destinationAsset);
    const now = this.#now();
    const deadline = request.deadline ? Date.parse(request.deadline) : now + DEFAULT_DEADLINE_MS;
    const id = randomUUID();
    // Hyperliquid and Base Sepolia: every quote shares the float's address, and the memo tells them apart.
    const shared = origin.chain === "hl" ? this.#hlFloat().address : origin.chain === "evm" ? this.#evmFloat().address : null;
    // NEAR: a fresh implicit account id, like 1Click's. Nobody holds its key, so deposits stay there.
    const depositAddress = shared ?? randomBytes(32).toString("hex");
    const depositMemo = shared ? id : null;
    const response: QuoteResponse = {
      ...priced,
      ...(extra.note ? { shim: extra.note } : {}),
      correlationId: id,
      timestamp: new Date(now).toISOString(),
      signature: "",
      quoteRequest: request,
      quote: {
        ...priced.quote,
        depositAddress,
        depositMemo,
        deadline: new Date(deadline).toISOString(),
        timeWhenInactive: new Date(deadline + WATCH_AFTER_DEADLINE_MS).toISOString(),
      },
    };
    this.#store.state.swaps[id] = {
      id,
      createdAt: now,
      request,
      response,
      origin: origin.chain,
      destination: destination.chain,
      depositAddress,
      depositMemo,
      deadline,
      inactiveAt: deadline + WATCH_AFTER_DEADLINE_MS,
      status: "PENDING_DEPOSIT",
      updatedAt: now,
      depositTxHashes: [],
      depositedAmount: "0",
      refundedAmount: "0",
      ...(extra.evmFromBlock !== undefined ? { evmFromBlock: extra.evmFromBlock } : {}),
      ...(extra.note ? { note: extra.note } : {}),
    };
    this.#store.save();
    this.#log(
      `quote ${short(id)}: ${response.quote.amountInFormatted} ${origin.symbol} -> ${response.quote.amountOutFormatted} ` +
        `${destination.symbol} for ${request.recipient}; deposit to ${depositAddress}${depositMemo ? ` (memo ${depositMemo})` : ""}`,
    );
    return response;
  }

  find(depositAddress: string, depositMemo?: string | null): Swap | undefined {
    return this.#store.find(depositAddress, depositMemo);
  }

  /** POST /v0/deposit/submit: notes the transaction and looks at the deposit address at once. */
  submitDeposit(depositAddress: string, txHash: string, memo?: string): Promise<Swap | undefined> {
    return this.#serial(async () => {
      const swap = this.#store.find(depositAddress, memo);
      if (!swap) return undefined;
      if (txHash && !swap.depositTxHashes.includes(txHash)) swap.depositTxHashes.push(txHash);
      if (swap.status === "PENDING_DEPOSIT") this.#setStatus(swap, "KNOWN_DEPOSIT_TX", `deposit tx ${txHash} reported`);
      this.#store.save();
      this.#hlCache = undefined;
      this.#evmScanned.clear();
      await this.#advanceSafely(swap);
      return swap;
    });
  }

  /** One pass over every swap that can still move. The server runs it every few seconds. */
  tick(): Promise<void> {
    return this.#serial(async () => {
      this.#hlCache = undefined;
      this.#evmScanned.clear();
      for (const swap of this.#store.swaps()) {
        if (!isTerminal(swap.status)) await this.#advanceSafely(swap);
      }
    });
  }

  statusOf(swap: Swap): ShimStatus {
    const quote = swap.response.quote;
    const origin = this.asset(swap.request.originAsset);
    const destination = this.asset(swap.request.destinationAsset);
    const originHashes = [...swap.depositTxHashes, swap.refundTxHash].filter((h): h is string => Boolean(h));
    const deliveryHashes = swap.deliveryTxHash ? [swap.deliveryTxHash] : [];
    const nearHashes = [...(swap.origin === "near" ? originHashes : []), ...(swap.destination === "near" ? deliveryHashes : [])];
    return {
      correlationId: swap.id,
      quoteResponse: swap.response,
      status: swap.status,
      updatedAt: new Date(swap.updatedAt).toISOString(),
      swapDetails: {
        intentHashes: [],
        nearTxHashes: nearHashes,
        amountIn: quote.amountIn,
        amountInFormatted: quote.amountInFormatted,
        amountInUsd: quote.amountInUsd,
        ...(swap.deliveredAmount !== undefined && {
          amountOut: swap.deliveredAmount,
          amountOutFormatted: formatUnits(swap.deliveredAmount, destination.decimals),
        }),
        originChainTxHashes: originHashes.map((h) => txRef(swap.origin, h)),
        destinationChainTxHashes: deliveryHashes.map((h) => txRef(swap.destination, h)),
        depositedAmount: swap.depositedAmount,
        depositedAmountFormatted: formatUnits(swap.depositedAmount, origin.decimals),
        refundedAmount: swap.refundedAmount,
        refundedAmountFormatted: formatUnits(swap.refundedAmount, origin.decimals),
        ...(swap.reason !== undefined && { refundReason: swap.reason }),
      },
      shim: {
        fault: swap.fault?.mode ?? null,
        deliverAt: swap.deliverAt ? new Date(swap.deliverAt).toISOString() : null,
        refundTxHash: swap.refundTxHash ?? null,
        ...(swap.note ? { note: swap.note } : {}),
      },
    };
  }

  // ---------- the state machine ----------

  async #advanceSafely(swap: Swap): Promise<void> {
    try {
      await this.#advance(swap);
    } catch (error) {
      // A failed read (an RPC hiccup) just waits for the next tick. Sends never get here: they settle the swap.
      this.#log(`swap ${short(swap.id)}: ${errorText(error)} (will retry)`);
    }
  }

  async #advance(swap: Swap): Promise<void> {
    const now = this.#now();
    const quote = swap.response.quote;
    const amountIn = BigInt(quote.amountIn);
    const origin = this.asset(swap.request.originAsset);

    if (swap.status === "PENDING_DEPOSIT" || swap.status === "KNOWN_DEPOSIT_TX") {
      if (now > swap.inactiveAt) return;
      const deposited = await this.#depositedAmount(swap);
      if (deposited === 0n) return;
      swap.depositedAmount = deposited.toString();
      swap.depositedAt ??= now;
      const amountText = `${formatUnits(deposited, origin.decimals)} ${origin.symbol}`;

      if (swap.depositedAt > swap.deadline + DEADLINE_GRACE_MS) {
        return this.#refund(swap, deposited, "REFUNDED", `the deposit of ${amountText} arrived after the quote's deadline`);
      }
      if (deposited >= amountIn) {
        swap.fault = { ...this.#store.state.fault };
        const lateMs = swap.fault.mode === "late" ? swap.fault.delaySeconds * 1000 : 0;
        swap.deliverAt = now + quote.timeEstimate * 1000 + lateMs;
        const faultText = swap.fault.mode === "none" ? "" : `, fault switch: ${swap.fault.mode}`;
        this.#setStatus(swap, "PROCESSING", `deposit of ${amountText} seen${faultText}; due ${new Date(swap.deliverAt).toISOString()}`);
        return this.#store.save();
      }
      if (now > swap.deadline + DEADLINE_GRACE_MS) {
        const reason = `only ${amountText} of ${formatUnits(amountIn, origin.decimals)} arrived before the deadline`;
        return this.#refund(swap, deposited, "INCOMPLETE_DEPOSIT", reason);
      }
      if (swap.status === "PENDING_DEPOSIT") this.#setStatus(swap, "KNOWN_DEPOSIT_TX", `${amountText} of the deposit has arrived`);
      return this.#store.save();
    }

    if (swap.status === "PROCESSING" && now >= (swap.deliverAt ?? 0)) {
      const mode = swap.fault?.mode ?? "none";
      if (mode === "refund") {
        return this.#refund(swap, BigInt(swap.depositedAmount), "REFUNDED", "the fault switch forced a refund");
      }
      if (mode === "fail") {
        swap.reason = "the fault switch forced a failure: nothing is delivered and the deposit is kept, as when 1Click fails";
        this.#setStatus(swap, "FAILED");
        return this.#store.save();
      }
      const delivered = await this.#deliver(swap);
      if (delivered) await this.#unwrapReturned(swap);
      // EXACT_INPUT: anything sent above amountIn goes back, as 1Click does. It goes with no msg: the transfer the
      // msg names was delivered, so the excess must not read as its refund.
      const excess = BigInt(swap.depositedAmount) - amountIn;
      if (delivered && excess > 0n) await this.#sendBack(swap, excess, "the deposit was more than amountIn", false);
    }
  }

  /** How much has arrived for this swap, in origin-token units. */
  async #depositedAmount(swap: Swap): Promise<bigint> {
    if (swap.origin === "near") {
      return this.#nearFloat().balanceOf(this.asset(swap.request.originAsset).contract, swap.depositAddress);
    }
    if (BigInt(swap.depositedAmount) > 0n) return BigInt(swap.depositedAmount);
    if (swap.origin === "evm") {
      const match = await this.#evmDeposit(swap);
      if (!match) return 0n;
      const key = `${match.hash}:${match.logIndex}`;
      this.#store.state.usedEvmLogs.push(key);
      this.#store.state.evmSeen = this.#store.state.evmSeen.filter((t) => `${t.hash}:${t.logIndex}` !== key);
      if (!swap.depositTxHashes.includes(match.hash)) swap.depositTxHashes.push(match.hash);
      return match.amount;
    }
    // Hyperliquid: the oldest unused transfer into the float from this sender, for exactly amountIn.
    const transfers = await this.#hlTransfers();
    const used = new Set(this.#store.state.usedHlHashes);
    const sender = swap.request.refundTo.toLowerCase();
    const amountIn = BigInt(swap.response.quote.amountIn);
    const match = transfers.find(
      (t) => !used.has(t.hash) && t.from === sender && t.amount === amountIn && t.time >= swap.createdAt - HL_CLOCK_SKEW_MS,
    );
    if (!match) return 0n;
    this.#store.state.usedHlHashes.push(match.hash);
    swap.depositTxHashes.push(match.hash);
    swap.depositedAt = match.time;
    return match.amount;
  }

  async #hlTransfers(): Promise<HlTransfer[]> {
    if (this.#hlCache) return this.#hlCache;
    const waiting = this.#store.swaps().filter((s) => s.origin === "hl" && !isTerminal(s.status));
    const since = Math.min(...waiting.map((s) => s.createdAt)) - HL_CLOCK_SKEW_MS;
    this.#hlCache = await this.#hlFloat().incomingTransfers(since);
    return this.#hlCache;
  }

  /** Base Sepolia: the oldest unused transfer of the quote's token into the float from the quote's sender, for exactly amountIn. */
  async #evmDeposit(swap: Swap): Promise<EvmTransfer | undefined> {
    const float = this.#evmFloat();
    const token = this.asset(swap.request.originAsset).contract;
    const sender = swap.request.refundTo.toLowerCase();
    const amountIn = BigInt(swap.response.quote.amountIn);
    const used = new Set(this.#store.state.usedEvmLogs);
    const fits = (t: EvmTransfer) => !used.has(`${t.hash}:${t.logIndex}`) && t.token === token && t.from === sender && t.amount === amountIn && t.block >= (swap.evmFromBlock ?? 0);
    // A transaction that was reported is read from its own receipt: no logs to look through.
    for (const hash of swap.depositTxHashes) {
      const match = (await float.receiptTransfers(hash))?.find(fits);
      if (match) return match;
    }
    await this.#evmScan(token);
    return this.#store.state.evmSeen
      .map((t) => ({ ...t, amount: BigInt(t.amount) }))
      .filter(fits)
      .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)[0];
  }

  /**
   * Reads the float's incoming transfers of `token`, once a tick: from where the oldest waiting quote began, or from
   * where the last read ended, 200 blocks at a time. What it finds waits in the state until a quote claims it.
   */
  async #evmScan(token: string): Promise<void> {
    if (this.#evmScanned.has(token)) return;
    this.#evmScanned.add(token);
    const float = this.#evmFloat();
    const state = this.#store.state;
    const waiting = this.#store.swaps().filter((s) => s.origin === "evm" && !isTerminal(s.status) && BigInt(s.depositedAmount) === 0n && this.asset(s.request.originAsset).contract === token);
    const latest = (await float.blockNumber()) - LOG_LAG_BLOCKS;
    const oldest = Math.min(...waiting.map((s) => s.evmFromBlock ?? latest));
    let from = Math.max((state.evmScannedTo[token] ?? -1) + 1, oldest);
    for (let chunk = 0; chunk < MAX_LOG_CHUNKS && from <= latest; chunk += 1) {
      const to = Math.min(from + LOG_RANGE - 1, latest);
      for (const t of await float.incoming(token, from, to)) {
        if (!state.evmSeen.some((s) => s.hash === t.hash && s.logIndex === t.logIndex)) state.evmSeen.push({ ...t, amount: t.amount.toString() });
      }
      state.evmScannedTo[token] = to;
      from = to + 1;
    }
    if (state.evmSeen.length > 500) state.evmSeen.splice(0, state.evmSeen.length - 500);
    this.#store.save();
  }

  /** WETH that came back is turned into the float's test ETH again, so the ETH goes round. If that fails, the WETH stays wrapped and the next delivery of WETH uses it first. */
  async #unwrapReturned(swap: Swap): Promise<void> {
    const origin = this.asset(swap.request.originAsset);
    if (origin.chain !== "evm" || origin.symbol !== "WETH" || !this.#evm) return;
    const amount = BigInt(swap.response.quote.amountIn);
    try {
      swap.unwrapTxHash = (await this.#evm.unwrap(amount)).hash;
      this.#log(`swap ${short(swap.id)}: unwrapped the ${formatUnits(amount, origin.decimals)} WETH that came back into the float's test ETH, tx ${swap.unwrapTxHash}`);
    } catch (error) {
      this.#log(`swap ${short(swap.id)}: the ${formatUnits(amount, origin.decimals)} WETH that came back stays wrapped (${errorText(error)}); the next delivery of WETH uses it first`);
    }
    this.#store.save();
  }

  /** Sends amountOut to the recipient from the float: SUCCESS (returns true), or FAILED with the reason. */
  async #deliver(swap: Swap): Promise<boolean> {
    const destination = this.asset(swap.request.destinationAsset);
    const amount = BigInt(swap.response.quote.amountOut);
    swap.sending = "delivery";
    this.#store.save();
    try {
      if (destination.chain === "near") {
        const near = this.#nearFloat();
        // A float short of a test token has the token's own faucet mint it (stage 4: nothing else pays it mNBTC).
        if (near.mint) {
          const held = await near.balanceOf(destination.contract, near.accountId);
          if (held < amount) await near.mint(destination.contract, amount - held);
        }
        const result = await near.transfer({
          token: destination.contract,
          receiverId: swap.request.recipient,
          amount,
          msg: swap.request.customRecipientMsg,
          memo: `1click-shim ${swap.id}`,
        });
        swap.deliveryTxHash = result.txHash;
        swap.deliveredAmount = result.usedAmount.toString();
        if (result.usedAmount < amount) {
          swap.reason =
            `the recipient's ft_on_transfer kept ${formatUnits(result.usedAmount, destination.decimals)} of ` +
            `${formatUnits(amount, destination.decimals)} ${destination.symbol}; the rest went back to the float`;
          this.#setStatus(swap, "FAILED", `tx ${result.txHash}`);
          return false;
        }
      } else if (destination.chain === "evm") {
        const float = this.#evmFloat();
        const held = await float.tokenBalance(destination.contract);
        // WETH is wrapped from the float's test ETH, only as much as is short; test WBTC and USDC come from Aave's faucet.
        if (held < amount) {
          if (destination.symbol === "WETH") await float.wrap(amount - held);
          else await float.mint(destination.contract, amount - held);
        }
        swap.deliveryTxHash = (await float.transfer(destination.contract, swap.request.recipient, amount)).hash;
        swap.deliveredAmount = amount.toString();
      } else {
        const result = await this.#hlFloat().usdSend(swap.request.recipient, amount);
        swap.deliveryTxHash = result.hash;
        swap.deliveredAmount = parseUnits(usdSendAmount(amount), HL_USDC_DECIMALS).toString();
      }
      const tx = swap.deliveryTxHash || "(hash not found yet)";
      this.#setStatus(swap, "SUCCESS", `delivered ${swap.response.quote.amountOutFormatted} ${destination.symbol}, tx ${tx}`);
      return true;
    } catch (error) {
      swap.reason = `delivery failed: ${errorText(error)}`;
      this.#setStatus(swap, "FAILED");
      return false;
    } finally {
      delete swap.sending;
      this.#store.save();
    }
  }

  /** Refunds `amount` of the origin token to refundTo and settles the swap with `status`. */
  async #refund(swap: Swap, amount: bigint, status: SwapStatus, reason: string): Promise<void> {
    if (await this.#sendBack(swap, amount, reason)) {
      swap.reason = reason;
      this.#setStatus(swap, status, reason);
    } else {
      this.#setStatus(swap, "FAILED");
    }
    this.#store.save();
  }

  /**
   * Sends origin tokens from the float to refundTo. On NEAR, a quote with customRecipientMsg is refunded with
   * ft_transfer_call and that msg (`withMsg`), so the account resolves its pending transfer. Returns false (with the
   * reason recorded) if it fails, or if the receiver's ft_on_transfer handed the tokens back.
   */
  async #sendBack(swap: Swap, amount: bigint, why: string, withMsg = true): Promise<boolean> {
    const origin = this.asset(swap.request.originAsset);
    swap.sending = "refund";
    this.#store.save();
    try {
      if (origin.chain === "near") {
        const msg = withMsg ? swap.request.customRecipientMsg : undefined;
        const near = this.#nearFloat();
        // Deposits on NEAR stay at their deposit addresses, so a refund comes out of the float's own stock. A float
        // short of the test token has the token's faucet mint what is missing, as for a delivery (section 49).
        if (near.mint) {
          const held = await near.balanceOf(origin.contract, near.accountId);
          if (held < amount) await near.mint(origin.contract, amount - held);
        }
        const result = await near.transfer({
          token: origin.contract,
          receiverId: swap.request.refundTo,
          amount,
          ...(msg !== undefined && { msg }),
          memo: `1click-shim refund ${swap.id}`,
        });
        swap.refundTxHash = result.txHash;
        if (result.usedAmount < amount) {
          const kept = formatUnits(result.usedAmount, origin.decimals);
          swap.refundedAmount = (BigInt(swap.refundedAmount) + result.usedAmount).toString();
          swap.reason = `${why}, but the refund's receiver kept only ${kept} of ${formatUnits(amount, origin.decimals)} ${origin.symbol}; the rest went back to the float`;
          return false;
        }
      } else if (origin.chain === "evm") {
        // The deposit sits in the float: the same token goes back to the address it came from.
        swap.refundTxHash = (await this.#evmFloat().transfer(origin.contract, swap.request.refundTo, amount)).hash;
      } else {
        swap.refundTxHash = (await this.#hlFloat().usdSend(swap.request.refundTo, amount)).hash;
      }
      swap.refundedAmount = (BigInt(swap.refundedAmount) + amount).toString();
      this.#log(`swap ${short(swap.id)}: refunded ${formatUnits(amount, origin.decimals)} ${origin.symbol} to ${swap.request.refundTo} (${why})`);
      return true;
    } catch (error) {
      swap.reason = `${why}, but the refund failed: ${errorText(error)}`;
      return false;
    } finally {
      delete swap.sending;
      this.#store.save();
    }
  }

  #setStatus(swap: Swap, status: SwapStatus, note?: string): void {
    swap.status = status;
    swap.updatedAt = this.#now();
    const detail = note ?? swap.reason;
    this.#log(`swap ${short(swap.id)}: ${status}${detail ? ` (${detail})` : ""}`);
  }

  #nearFloat(): NearFloat {
    if (!this.#near) throw new Error("The NEAR float is off: set SHIM_NEAR_ACCOUNT_ID and SHIM_NEAR_PRIVATE_KEY");
    return this.#near;
  }

  #hlFloat(): HlFloat {
    if (!this.#hl) throw new Error("The Hyperliquid float is off: set HL_FLOAT_ADDRESS and HL_FLOAT_PRIVATE_KEY");
    return this.#hl;
  }

  #evmFloat(): EvmFloat {
    if (!this.#evm) throw new Error("The Base Sepolia float is off: set EVM_GAS_PRIVATE_KEY, and the factory's config needs its Aave settings");
    return this.#evm;
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

function txRef(chain: Chain, hash: string): TxHashRef {
  const explorerUrl =
    chain === "near" ? `https://testnet.nearblocks.io/txns/${hash}` : chain === "evm" ? `https://sepolia.basescan.org/tx/${hash}` : `https://app.hyperliquid-testnet.xyz/explorer/tx/${hash}`;
  return { hash, explorerUrl };
}

function short(id: string): string {
  return id.slice(0, 8);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
