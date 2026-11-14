// Ethereum type 2 transactions (EIP-1559), read and written by hand (INTERFACES.md 33; FUNDING.md 4.5):
//
//   the hash to sign   keccak256(0x02 || rlp([chain_id, nonce, max_priority_fee, max_fee, gas_limit, to, value, data, []]))
//   what is sent       0x02 || rlp([... the same nine ..., y_parity, r, s])
//   its hash           keccak256 of what is sent
//
// Two uses. The accounts' own transactions come signed from the chain (get_state().evm.signed): the backend reads
// each one back apart before it sends it, so that a wrong chain, a wrong contract or a wrong signer is caught here.
// And the gas wallet (EVM_GAS_PRIVATE_KEY, testnet only) signs its own two kinds: a plain ETH transfer and a call to
// Aave's faucet. The encoder is the one scripts/bridge-gas.mjs moved the gas wallet's ETH with; secp256k1 and Keccak
// come from the @noble packages the 1Click stand-in uses, at the same versions.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/** A transaction that can't be read, or isn't one we send. The message is plain words for the caller. */
export class EvmTxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvmTxError";
  }
}

export type Rlp = Uint8Array | Rlp[];

/** Minimal big-endian bytes of a non-negative integer; empty for 0, as RLP wants. */
export function bigBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new EvmTxError("a negative number can't go into a transaction");
  if (value === 0n) return new Uint8Array(0);
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return hexToBytes(hex);
}

function head(length: number, offset: number): Uint8Array {
  if (length < 56) return Uint8Array.of(offset + length);
  const size = bigBytes(BigInt(length));
  return concatBytes(Uint8Array.of(offset + 55 + size.length), size);
}

export function rlpEncode(item: Rlp): Uint8Array {
  if (Array.isArray(item)) {
    const body = concatBytes(...item.map(rlpEncode));
    return concatBytes(head(body.length, 0xc0), body);
  }
  if (item.length === 1 && item[0]! < 0x80) return item;
  return concatBytes(head(item.length, 0x80), item);
}

/** Reads one RLP item that must fill `bytes` exactly. Lengths written the long way where the short way fits are refused. */
export function rlpDecode(bytes: Uint8Array): Rlp {
  const [item, end] = decodeAt(bytes, 0);
  if (end !== bytes.length) throw new EvmTxError("the transaction has bytes left over after its fields");
  return item;
}

function decodeAt(bytes: Uint8Array, at: number): [Rlp, number] {
  const first = bytes[at];
  if (first === undefined) throw new EvmTxError("the transaction ends in the middle of a field");
  if (first < 0x80) return [bytes.subarray(at, at + 1), at + 1];
  const list = first >= 0xc0;
  const base = list ? 0xc0 : 0x80;
  let start = at + 1;
  let length = first - base;
  if (length > 55) {
    const sizeBytes = length - 55;
    if (sizeBytes > 4 || start + sizeBytes > bytes.length || bytes[start] === 0) throw new EvmTxError("a field's length in the transaction isn't written the way Ethereum wants");
    length = 0;
    for (let i = 0; i < sizeBytes; i += 1) length = length * 256 + bytes[start + i]!;
    if (length < 56) throw new EvmTxError("a field's length in the transaction isn't written the way Ethereum wants");
    start += sizeBytes;
  }
  const end = start + length;
  if (end > bytes.length) throw new EvmTxError("the transaction ends in the middle of a field");
  if (!list) {
    if (length === 1 && bytes[start]! < 0x80) throw new EvmTxError("a one-byte field in the transaction isn't written the way Ethereum wants");
    return [bytes.subarray(start, end), end];
  }
  const items: Rlp[] = [];
  let next = start;
  while (next < end) {
    const [item, after] = decodeAt(bytes, next);
    if (after > end) throw new EvmTxError("a field in the transaction runs past the end of its list");
    items.push(item);
    next = after;
  }
  return [items, end];
}

/** The nine fields a type 2 transaction is signed over. The access list is always empty here, and so not a field. */
export interface Type2Tx {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  /** 0x and 40 hex digits, lowercase. */
  to: string;
  value: bigint;
  /** 0x hex; "0x" for none. */
  data: string;
}

export interface SignedTx extends Type2Tx {
  yParity: 0 | 1;
  r: bigint;
  s: bigint;
  /** keccak256 of the raw transaction: what the chain knows it by. */
  hash: string;
  /** The address whose key signed it, recovered from the signature. Lowercase. */
  from: string;
}

const HEX = /^0x([0-9a-fA-F]{2})*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** secp256k1's group order: a signature's r and s are below it, and Ethereum wants s in the lower half (EIP-2). */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const hex = (bytes: Uint8Array) => `0x${bytesToHex(bytes)}`;
const fromHex = (text: string) => hexToBytes(text.slice(2));

function fields(tx: Type2Tx): Rlp[] {
  if (!ADDRESS.test(tx.to)) throw new EvmTxError(`${tx.to} is not a 0x address`);
  if (!HEX.test(tx.data)) throw new EvmTxError("the call data isn't 0x hex");
  return [bigBytes(tx.chainId), bigBytes(tx.nonce), bigBytes(tx.maxPriorityFeePerGas), bigBytes(tx.maxFeePerGas), bigBytes(tx.gasLimit), fromHex(tx.to), bigBytes(tx.value), fromHex(tx.data), []];
}

/** The digest a type 2 transaction is signed over. */
export function signingHash(tx: Type2Tx): Uint8Array {
  return keccak_256(concatBytes(Uint8Array.of(2), rlpEncode(fields(tx))));
}

/** The address of a public key (65 bytes, uncompressed): the last 20 bytes of keccak256 of its x and y. */
function addressOfPublicKey(publicKey: Uint8Array): string {
  return hex(keccak_256(publicKey.slice(1)).slice(-20));
}

/** The address a 32-byte private key signs for. */
export function addressOfKey(key: Uint8Array): string {
  return addressOfPublicKey(secp256k1.getPublicKey(key, false));
}

/** Signs `tx` with `key`: the raw transaction to send, and its hash. RFC 6979, low s, as Ethereum wants. */
export function signTx(tx: Type2Tx, key: Uint8Array): { raw: string; hash: string } {
  // "recovered" puts the recovery byte first: [rec, r, s] (as scripts/bridge-gas.mjs and the stand-in's wallet use it).
  const signature = secp256k1.sign(signingHash(tx), key, { prehash: false, format: "recovered" });
  const r = BigInt(hex(signature.slice(1, 33)));
  const s = BigInt(hex(signature.slice(33, 65)));
  const raw = concatBytes(Uint8Array.of(2), rlpEncode([...fields(tx), bigBytes(BigInt(signature[0]!)), bigBytes(r), bigBytes(s)]));
  return { raw: hex(raw), hash: hex(keccak_256(raw)) };
}

/** keccak256 of a raw transaction, as 0x hex. */
export function txHash(raw: string): string {
  if (!HEX.test(raw)) throw new EvmTxError("the raw transaction isn't 0x hex");
  return hex(keccak_256(fromHex(raw)));
}

/**
 * Reads a signed type 2 transaction apart, and recovers who signed it. Refuses anything else: another type, a wrong
 * number of fields, a number with leading zeros, an access list that isn't empty, a signature Ethereum would refuse.
 */
export function decodeSignedTx(raw: string): SignedTx {
  if (typeof raw !== "string" || !HEX.test(raw) || raw.length < 6) throw new EvmTxError("the raw transaction isn't 0x hex");
  const bytes = fromHex(raw);
  if (bytes[0] !== 2) throw new EvmTxError("the transaction isn't Ethereum's type 2 (it doesn't start with 0x02)");
  const list = rlpDecode(bytes.subarray(1));
  if (!Array.isArray(list) || list.length !== 12) throw new EvmTxError("the transaction doesn't have a type 2 transaction's 12 fields");
  const bytesAt = (i: number, what: string): Uint8Array => {
    const item = list[i]!;
    if (Array.isArray(item)) throw new EvmTxError(`the transaction's ${what} is a list`);
    return item;
  };
  const number = (i: number, what: string, maxBytes = 32): bigint => {
    const b = bytesAt(i, what);
    if (b.length > maxBytes || (b.length > 0 && b[0] === 0)) throw new EvmTxError(`the transaction's ${what} isn't a number written the way Ethereum wants`);
    return b.length === 0 ? 0n : BigInt(hex(b));
  };
  const to = bytesAt(5, "receiver");
  if (to.length !== 20) throw new EvmTxError("the transaction has no receiver: it would create a contract");
  const access = list[8]!;
  if (!Array.isArray(access) || access.length !== 0) throw new EvmTxError("the transaction has an access list, which ours never have");
  const tx: Type2Tx = {
    chainId: number(0, "chain id", 8),
    nonce: number(1, "nonce", 8),
    maxPriorityFeePerGas: number(2, "tip"),
    maxFeePerGas: number(3, "fee limit"),
    gasLimit: number(4, "gas limit", 8),
    to: hex(to),
    value: number(6, "value"),
    data: hex(bytesAt(7, "call data")),
  };
  const yParity = number(9, "signature", 1);
  const r = number(10, "signature");
  const s = number(11, "signature");
  if (yParity > 1n || r === 0n || r >= N || s === 0n || s > N / 2n) throw new EvmTxError("the transaction's signature isn't one Ethereum accepts");
  let from: string;
  try {
    const signature = concatBytes(Uint8Array.of(Number(yParity)), hexToBytes(r.toString(16).padStart(64, "0")), hexToBytes(s.toString(16).padStart(64, "0")));
    const recovered = secp256k1.recoverPublicKey(signature, signingHash(tx), { prehash: false });
    from = addressOfPublicKey(secp256k1.Point.fromBytes(recovered).toBytes(false));
  } catch {
    throw new EvmTxError("the transaction's signature doesn't lead back to any address");
  }
  return { ...tx, yParity: Number(yParity) as 0 | 1, r, s, hash: hex(keccak_256(bytes)), from };
}

/** The first four bytes of keccak256 of a function's signature, as 0x hex: "transfer(address,uint256)" -> 0xa9059cbb. */
export function selectorOf(signature: string): string {
  return hex(keccak_256(utf8ToBytes(signature)).slice(0, 4));
}

/**
 * The calls this file's users make or let through. Each selector is recomputed from its signature in the tests
 * (research/aave.md has the sources: IPool.sol in aave-dao/aave-v3-origin, ERC-20, and Aave's faucet).
 */
export const CALLS = {
  approve: { signature: "approve(address,uint256)", selector: "0x095ea7b3" },
  transfer: { signature: "transfer(address,uint256)", selector: "0xa9059cbb" },
  balanceOf: { signature: "balanceOf(address)", selector: "0x70a08231" },
  supply: { signature: "supply(address,uint256,address,uint16)", selector: "0x617ba037" },
  borrow: { signature: "borrow(address,uint256,uint256,uint16,address)", selector: "0xa415bcad" },
  repay: { signature: "repay(address,uint256,uint256,address)", selector: "0x573ade81" },
  withdraw: { signature: "withdraw(address,uint256,address)", selector: "0x69328dec" },
  /** Aave's test faucet: mint(token, to, amount). */
  mint: { signature: "mint(address,address,uint256)", selector: "0xc6c3bbe6" },
  /** WETH, the chain's own wrapper for ETH: deposit() with ETH sent along (scripts/aave-spike.mjs wrapped with it). */
  deposit: { signature: "deposit()", selector: "0xd0e30db0" },
  /**
   * Aave's data provider (AaveProtocolDataProvider.sol in aave-dao/aave-v3-origin), each layout checked with a live
   * call on Base Sepolia on 11 Nov:
   * - getUserReserveData(asset, user) -> 9 words: [0] what the user has posted of the asset, in its own units;
   * - getReserveCaps(asset) -> 2 words: [0] the borrow cap, [1] the supply cap, in whole tokens; 0 means no cap;
   * - getATokenTotalSupply(asset) -> 1 word: what is supplied in all, in the asset's own units.
   */
  getUserReserveData: { signature: "getUserReserveData(address,address)", selector: "0x28dd2d01" },
  getReserveCaps: { signature: "getReserveCaps(address)", selector: "0x46fbe558" },
  getATokenTotalSupply: { signature: "getATokenTotalSupply(address)", selector: "0x51460e25" },
} as const;

/** What a token accepts from an account (approve, transfer), and what Aave's Pool does (FUNDING.md 4.5's table). */
export const TOKEN_CALLS: readonly string[] = [CALLS.approve.selector, CALLS.transfer.selector];
export const POOL_CALLS: readonly string[] = [CALLS.supply.selector, CALLS.borrow.selector, CALLS.repay.selector, CALLS.withdraw.selector];

/** Call data: the selector, then each argument as a 32-byte word (an address left-padded, a number big-endian). */
export function callData(selector: string, args: (string | bigint)[]): string {
  if (!/^0x[0-9a-f]{8}$/.test(selector)) throw new EvmTxError(`${selector} is not a 4-byte selector in lowercase hex`);
  const word = (arg: string | bigint) => {
    if (typeof arg === "bigint") {
      if (arg < 0n || arg >= 1n << 256n) throw new EvmTxError("a number in the call doesn't fit 32 bytes");
      return arg.toString(16).padStart(64, "0");
    }
    if (!ADDRESS.test(arg)) throw new EvmTxError(`${arg} is not a 0x address`);
    return arg.slice(2).toLowerCase().padStart(64, "0");
  };
  return `${selector}${args.map(word).join("")}`;
}

/** A 32-byte hex private key as bytes; anything else is refused in words that never repeat it. */
export function keyBytes(text: string, name: string): Uint8Array {
  const clean = text.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new EvmTxError(`${name} isn't a 32-byte key in hex (64 hex digits)`);
  return hexToBytes(clean);
}
