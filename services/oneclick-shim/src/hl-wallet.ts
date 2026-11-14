// A local secp256k1 wallet for @nktkas/hyperliquid, so the float can sign usdSend without viem or ethers.
// The SDK builds the EIP-712 typed data; we hash it (EIP-712, flat structs only, which is all
// Hyperliquid uses) and sign the digest. Checked against the Python SDK's test vectors in hl-wallet.test.ts.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

type Hex = `0x${string}`;

interface TypedField {
  name: string;
  type: string;
}

export interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, readonly TypedField[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** Hyperliquid's domain fields, used when the caller doesn't list EIP712Domain itself. */
const DOMAIN_FIELDS: TypedField[] = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

/** keccak256(0x1901 || domainSeparator || hashStruct(message)). */
export function hashTypedData({ domain, types, primaryType, message }: TypedData): Uint8Array {
  const fields = types[primaryType];
  if (!fields) throw new Error(`EIP-712: no type named ${primaryType}`);
  const domainSeparator = hashStruct("EIP712Domain", types.EIP712Domain ?? DOMAIN_FIELDS, domain);
  return keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), domainSeparator, hashStruct(primaryType, fields, message)));
}

function hashStruct(name: string, fields: readonly TypedField[], data: Record<string, unknown>): Uint8Array {
  const typeString = `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
  const encoded = fields.map((f) => encodeField(f.type, data[f.name]));
  return keccak_256(concatBytes(keccak_256(utf8ToBytes(typeString)), ...encoded));
}

function encodeField(type: string, value: unknown): Uint8Array {
  if (type === "string") return keccak_256(utf8ToBytes(String(value)));
  if (type === "bytes") return keccak_256(hexToBytes(strip0x(String(value))));
  if (type === "bool") return word(value ? 1n : 0n);
  if (type === "address") return leftPad(hexToBytes(strip0x(String(value)).padStart(40, "0")));
  if (type === "bytes32") return hexToBytes(strip0x(String(value)).padStart(64, "0"));
  if (/^uint(8|16|32|64|128|256)$/.test(type)) return word(BigInt(value as bigint | number | string));
  throw new Error(`EIP-712 type ${type} is not supported here (flat structs only)`);
}

function word(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("EIP-712: negative uint");
  return hexToBytes(value.toString(16).padStart(64, "0"));
}

function leftPad(bytes: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array(32 - bytes.length), bytes);
}

function strip0x(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

export interface LocalWallet {
  /** Lowercase 0x address of the key. */
  address: Hex;
  /** viem-style: one parameter, which is how the SDK recognises a local account. Returns r || s || v. */
  signTypedData(params: TypedData): Promise<Hex>;
}

export function addressOf(publicKeyUncompressed: Uint8Array): Hex {
  return `0x${bytesToHex(keccak_256(publicKeyUncompressed.slice(1)).slice(-20))}`;
}

export function localWallet(privateKey: string): LocalWallet {
  const key = hexToBytes(strip0x(privateKey));
  if (key.length !== 32) throw new Error("A Hyperliquid private key is 32 bytes (0x and 64 hex characters)");
  return {
    address: addressOf(secp256k1.getPublicKey(key, false)),
    async signTypedData(params) {
      // RFC 6979 deterministic, low-s. "recovered" puts the recovery byte first: [rec, r, s].
      const signature = secp256k1.sign(hashTypedData(params), key, { prehash: false, format: "recovered" });
      const v = 27 + (signature[0] ?? 0);
      return `0x${bytesToHex(signature.slice(1))}${v.toString(16)}`;
    },
  };
}
