// The shim's float on Base Sepolia (INTERFACES.md 36): the gas wallet, EVM_GAS_PRIVATE_KEY. Every Base Sepolia
// quote's deposit address is this wallet's address, so a deposit is found among the token transfers into it, by its
// sender and its exact amount, as on Hyperliquid. Deliveries and refunds are token transfers out of it.
//
// One wallet, two processes. The backend's gas helper signs with the same key. So each send here reads the pending
// nonce right before signing, and when the node says that nonce is taken (the other process got there first) it
// reads it again and signs again, a few times.
//
// Test ETH is scarce: the wallet holds about 0.048 and there is no easy way to more. WETH is wrapped from that ETH
// only when a delivery needs it (`wrap`) and unwrapped when it comes back (`unwrap`), so the ETH goes round and
// only gas is spent: about 0.000001 ETH a transaction at Base Sepolia's fees (research/aave.md).
//
// Finding deposits. The public RPC answers eth_getLogs for at most 200 blocks at a time ("eth_getLogs is limited to a
// 200 range", read 11 Nov), and a block there is 0.2 s, so 200 blocks are 40 s. `incoming` therefore takes a block
// range and the engine walks it 200 blocks at a time from where each waiting quote began; nothing scans a day of
// logs. A deposit whose transaction hash was reported is read straight from its receipt instead.
//
// The transaction is Ethereum's type 2, encoded and signed as scripts/bridge-gas.mjs does (and services/api's
// evm-tx.ts, whose tests check the encoding against a transaction Base Sepolia mined), with the @noble packages.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";

/** One ERC-20 transfer into the float. */
export interface EvmTransfer {
  hash: string;
  logIndex: number;
  block: number;
  /** The token's address and the sender's, lowercase. */
  token: string;
  from: string;
  amount: bigint;
}

export interface EvmFloat {
  /** The float's address, lowercase. */
  readonly address: string;
  readonly chainId: number;
  blockNumber(): Promise<number>;
  /** Transfers of `token` into the float in blocks `fromBlock` to `toBlock`: at most LOG_RANGE blocks. */
  incoming(token: string, fromBlock: number, toBlock: number): Promise<EvmTransfer[]>;
  /** The transfers into the float in one transaction's receipt; null while it isn't mined. */
  receiptTransfers(hash: string): Promise<EvmTransfer[] | null>;
  ethBalance(): Promise<bigint>;
  tokenBalance(token: string): Promise<bigint>;
  /** How much more of `token` Aave's pool can take, in the token's units: null when it has no supply cap. */
  aaveRoom(token: string, decimals: number): Promise<bigint | null>;
  /** Each send waits for its receipt, and throws in words if it was refused or reverted. */
  transfer(token: string, to: string, amount: bigint): Promise<{ hash: string }>;
  /** WETH's deposit() with `amount` of the float's ETH, and its withdraw(amount) back into ETH. */
  wrap(amount: bigint): Promise<{ hash: string }>;
  unwrap(amount: bigint): Promise<{ hash: string }>;
  /** Aave's faucet mints `amount` of a test token to the float. */
  mint(token: string, amount: bigint): Promise<{ hash: string }>;
  /** Why the faucet wouldn't mint that now, in the node's words, or null if it would. Nothing is sent: the node only runs it. */
  mintProblem(token: string, amount: bigint): Promise<string | null>;
}

/** The most blocks one eth_getLogs may cover on Base Sepolia's public RPC. */
export const LOG_RANGE = 200;

/**
 * Selectors and the Transfer event's topic: the first four bytes (or all 32) of keccak256 of each signature. The tests
 * recompute every one. `withdraw(uint256)` is WETH's unwrap; the two `get…` are Aave's data provider's (services/api's
 * evm-tx.ts has their layouts, checked with live calls on 11 Nov).
 */
export const EVM_CALLS = {
  transfer: { signature: "transfer(address,uint256)", selector: "0xa9059cbb" },
  balanceOf: { signature: "balanceOf(address)", selector: "0x70a08231" },
  deposit: { signature: "deposit()", selector: "0xd0e30db0" },
  withdraw: { signature: "withdraw(uint256)", selector: "0x2e1a7d4d" },
  mint: { signature: "mint(address,address,uint256)", selector: "0xc6c3bbe6" },
  getReserveCaps: { signature: "getReserveCaps(address)", selector: "0x46fbe558" },
  getATokenTotalSupply: { signature: "getATokenTotalSupply(address)", selector: "0x51460e25" },
} as const;
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const TRANSFER_EVENT = "Transfer(address,address,uint256)";

const hex = (bytes: Uint8Array) => `0x${bytesToHex(bytes)}`;
const word = (value: string | bigint) => (typeof value === "bigint" ? value.toString(16).padStart(64, "0") : value.slice(2).toLowerCase().padStart(64, "0"));
/** Call data: the selector, then each argument as a 32-byte word. */
export function callData(selector: string, args: (string | bigint)[]): string {
  return `${selector}${args.map(word).join("")}`;
}

function bigBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array(0);
  let text = value.toString(16);
  if (text.length % 2) text = `0${text}`;
  return hexToBytes(text);
}
type Rlp = Uint8Array | Rlp[];
function rlp(item: Rlp): Uint8Array {
  const head = (length: number, offset: number) => {
    if (length < 56) return Uint8Array.of(offset + length);
    const size = bigBytes(BigInt(length));
    return concatBytes(Uint8Array.of(offset + 55 + size.length), size);
  };
  if (Array.isArray(item)) {
    const body = concatBytes(...item.map(rlp));
    return concatBytes(head(body.length, 0xc0), body);
  }
  return item.length === 1 && item[0]! < 0x80 ? item : concatBytes(head(item.length, 0x80), item);
}

export interface EvmTx {
  chainId: bigint;
  nonce: bigint;
  tip: bigint;
  maxFee: bigint;
  gasLimit: bigint;
  to: string;
  value: bigint;
  data: string;
}

/** A type 2 transaction signed with `key`: the raw bytes to send, and its hash. */
export function signEvmTx(tx: EvmTx, key: Uint8Array): { raw: string; hash: string } {
  const fields: Rlp[] = [bigBytes(tx.chainId), bigBytes(tx.nonce), bigBytes(tx.tip), bigBytes(tx.maxFee), bigBytes(tx.gasLimit), hexToBytes(tx.to.slice(2)), bigBytes(tx.value), hexToBytes(tx.data.slice(2)), []];
  const digest = keccak_256(concatBytes(Uint8Array.of(2), rlp(fields)));
  // "recovered" puts the recovery byte first: [rec, r, s] (as hl-wallet.ts uses it).
  const signature = secp256k1.sign(digest, key, { prehash: false, format: "recovered" });
  const r = BigInt(hex(signature.slice(1, 33)));
  const s = BigInt(hex(signature.slice(33, 65)));
  const raw = concatBytes(Uint8Array.of(2), rlp([...fields, bigBytes(BigInt(signature[0]!)), bigBytes(r), bigBytes(s)]));
  return { raw: hex(raw), hash: hex(keccak_256(raw)) };
}

/** The address a 32-byte private key signs for, lowercase. */
export function addressOfKey(key: Uint8Array): string {
  return hex(keccak_256(secp256k1.getPublicKey(key, false).slice(1)).slice(-20));
}

/** The node's words for "that nonce is taken": another transaction with it is mined, or waits with the same or a higher fee. */
export const NONCE_TAKEN = /nonce too low|replacement transaction underpriced|already known/i;
/** The float never pays more than this per gas; Base Sepolia's fee is hundreds of times lower. */
const MAX_FEE_WEI = 5_000_000_000n;
const MIN_TIP_WEI = 1_000_000n;
const SEND_TRIES = 4;

export interface EvmFloatOptions {
  rpcUrl: string;
  chainId: number;
  /** 32 bytes of hex, with or without 0x. */
  privateKey: string;
  weth: string;
  faucet: string;
  dataProvider: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** How long a send waits for its receipt. */
  receiptWaitMs?: number;
}

export function evmFloat(options: EvmFloatOptions): EvmFloat {
  const clean = options.privateKey.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error("EVM_GAS_PRIVATE_KEY isn't a 32-byte key in hex (64 hex digits)");
  const key = hexToBytes(clean);
  const address = addressOfKey(key);
  const host = new URL(options.rpcUrl).host;
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const weth = options.weth.toLowerCase();
  let chainChecked = false;

  /** One JSON-RPC request. A refusal by the node throws its own words; only the RPC's host is ever named. */
  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    let reply: { result?: unknown; error?: { message?: unknown } };
    try {
      const response = await fetchImpl(options.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      reply = (await response.json()) as typeof reply;
    } catch (error) {
      throw new Error(`Base Sepolia (${host}) didn't answer ${method}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (reply.error) throw new Error(`${method}: ${String(reply.error.message ?? "refused").slice(0, 200)}`);
    return reply.result ?? null;
  }
  const quantity = async (method: string, params: unknown[]) => BigInt((await rpc(method, params)) as string);
  /** Nothing is read from or sent to a node that answers for another chain than EVM_CHAIN_ID. */
  async function checkChain(): Promise<void> {
    if (chainChecked) return;
    const chain = Number(await quantity("eth_chainId", []));
    if (chain !== options.chainId) throw new Error(`EVM_RPC_URL (${host}) answers for chain ${chain}, and the stand-in is set to chain ${options.chainId}`);
    chainChecked = true;
  }
  const call = async (to: string, data: string) => {
    await checkChain();
    return (await rpc("eth_call", [{ to, data }, "latest"])) as string;
  };
  const wordAt = (result: string, index: number) => BigInt(`0x${result.slice(2 + 64 * index, 2 + 64 * (index + 1)) || "0"}`);

  const transfersIn = (logs: { address?: string; topics?: string[]; data?: string; transactionHash?: string; logIndex?: string; blockNumber?: string }[]): EvmTransfer[] =>
    logs
      .filter((l) => l.topics?.length === 3 && l.topics[0]?.toLowerCase() === TRANSFER_TOPIC && `0x${l.topics[2]!.slice(26)}`.toLowerCase() === address)
      .map((l) => ({ hash: String(l.transactionHash).toLowerCase(), logIndex: Number(BigInt(l.logIndex ?? "0x0")), block: Number(BigInt(l.blockNumber ?? "0x0")), token: String(l.address).toLowerCase(), from: `0x${l.topics![1]!.slice(26)}`.toLowerCase(), amount: BigInt(l.data && l.data !== "0x" ? l.data : "0x0") }));

  /** Signs and sends one transaction, then waits for its receipt. The nonce is read right before each signature. */
  async function send(what: string, to: string, value: bigint, data: string): Promise<{ hash: string }> {
    await checkChain();
    // The node runs it first without sending: one that would revert (a faucet's limit, too little ETH) says so here.
    const estimate = await quantity("eth_estimateGas", [{ from: address, to, value: `0x${value.toString(16)}`, data }]).catch((error: unknown) => {
      throw new Error(`${what} would fail: ${error instanceof Error ? error.message : String(error)}`);
    });
    const gasLimit = (estimate * 3n) / 2n;
    let last = "";
    for (let attempt = 1; attempt <= SEND_TRIES; attempt += 1) {
      const [nonce, block, suggested] = await Promise.all([
        quantity("eth_getTransactionCount", [address, "pending"]),
        rpc("eth_getBlockByNumber", ["latest", false]) as Promise<{ baseFeePerGas?: string } | null>,
        quantity("eth_maxPriorityFeePerGas", []).catch(() => MIN_TIP_WEI),
      ]);
      const tip = suggested > MIN_TIP_WEI ? suggested : MIN_TIP_WEI;
      const maxFee = BigInt(block?.baseFeePerGas ?? "0x0") * 2n + tip;
      if (maxFee > MAX_FEE_WEI) throw new Error(`${what} isn't sent: gas on Base Sepolia costs ${Number(maxFee) / 1e9} gwei now, above what the float pays`);
      const signed = signEvmTx({ chainId: BigInt(options.chainId), nonce, tip, maxFee, gasLimit, to, value, data }, key);
      try {
        await rpc("eth_sendRawTransaction", [signed.raw]);
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
        // The backend's gas helper signs with this key too: it took the nonce. Read it again and sign again.
        if (NONCE_TAKEN.test(last) && attempt < SEND_TRIES) {
          await sleep(500 * attempt);
          continue;
        }
        throw new Error(`${what} was refused by the node: ${last}`);
      }
      const waitMs = options.receiptWaitMs ?? 60_000;
      for (let waited = 0; waited < waitMs; waited += 1_000) {
        await sleep(1_000);
        const receipt = (await rpc("eth_getTransactionReceipt", [signed.hash]).catch(() => null)) as { status?: string } | null;
        if (!receipt) continue;
        if (!/^0x0*1$/.test(receipt.status ?? "")) throw new Error(`${what} was mined and reverted (${signed.hash})`);
        return { hash: signed.hash };
      }
      throw new Error(`${what} was sent (${signed.hash}) and isn't mined after ${waitMs / 1000} s: look it up before sending again`);
    }
    throw new Error(`${what} was refused by the node ${SEND_TRIES} times: ${last}`);
  }

  return {
    address,
    chainId: options.chainId,
    async blockNumber() {
      await checkChain();
      return Number(await quantity("eth_blockNumber", []));
    },
    async incoming(token, fromBlock, toBlock) {
      await checkChain();
      if (toBlock - fromBlock >= LOG_RANGE) throw new Error(`eth_getLogs covers at most ${LOG_RANGE} blocks, and ${fromBlock} to ${toBlock} was asked for`);
      const logs = (await rpc("eth_getLogs", [{ address: token, topics: [TRANSFER_TOPIC, null, `0x${word(address)}`], fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` }])) as Parameters<typeof transfersIn>[0];
      return transfersIn(Array.isArray(logs) ? logs : []);
    },
    async receiptTransfers(hash) {
      await checkChain();
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return [];
      const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as { status?: string; logs?: Parameters<typeof transfersIn>[0] } | null;
      if (!receipt) return null;
      return /^0x0*1$/.test(receipt.status ?? "") ? transfersIn(receipt.logs ?? []) : [];
    },
    async ethBalance() {
      await checkChain();
      return quantity("eth_getBalance", [address, "latest"]);
    },
    async tokenBalance(token) {
      return wordAt(await call(token, callData(EVM_CALLS.balanceOf.selector, [address])), 0);
    },
    async aaveRoom(token, decimals) {
      const [caps, supplied] = await Promise.all([call(options.dataProvider, callData(EVM_CALLS.getReserveCaps.selector, [token])), call(options.dataProvider, callData(EVM_CALLS.getATokenTotalSupply.selector, [token]))]);
      const cap = wordAt(caps, 1);
      if (cap === 0n) return null;
      const most = cap * 10n ** BigInt(decimals);
      const now = wordAt(supplied, 0);
      return most > now ? most - now : 0n;
    },
    transfer: (token, to, amount) => send(`the transfer of ${amount} units of ${token} to ${to}`, token, 0n, callData(EVM_CALLS.transfer.selector, [to, amount])),
    wrap: (amount) => send(`wrapping ${amount} wei of the float's test ETH`, weth, amount, EVM_CALLS.deposit.selector),
    unwrap: (amount) => send(`unwrapping ${amount} wei of WETH`, weth, 0n, callData(EVM_CALLS.withdraw.selector, [amount])),
    mint: (token, amount) => send(`Aave's faucet minting ${amount} units of ${token}`, options.faucet, 0n, callData(EVM_CALLS.mint.selector, [token, address, amount])),
    async mintProblem(token, amount) {
      await checkChain();
      try {
        await rpc("eth_estimateGas", [{ from: address, to: options.faucet, data: callData(EVM_CALLS.mint.selector, [token, address, amount]) }]);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  };
}
