#!/usr/bin/env node
// Test vectors for the account contract's Ethereum encoder (contracts/account/src/evm.rs; INTERFACES.md 33).
//
//   node contracts/account/evm-vectors.mjs          writes contracts/account/src/evm_vectors.json
//   node contracts/account/evm-vectors.mjs --check  fails if that file isn't what this script writes
//
// It builds each kind of transaction the account signs (Ethereum type 2), independently of the Rust code: the
// calls' data, the RLP and the hashes are written out here, and the signatures come from a throwaway key. The Rust
// tests then build the same transactions from the same fields and must get the same signing hash, raw transaction
// and hash, and recover the same address from the signature.
//
// It reads nothing secret and sends nothing. The key is the keccak256 of a fixed sentence: it holds no money on any
// chain and is never printed. No new dependency: secp256k1 and Keccak come from the @noble packages the 1Click
// stand-in already uses, as in scripts/bridge-gas.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const shim = createRequire(path.join(root, "services/oneclick-shim/package.json"));
const load = (id) => import(pathToFileURL(shim.resolve(id)).href);
const { secp256k1 } = await load("@noble/curves/secp256k1.js");
const { keccak_256 } = await load("@noble/hashes/sha3.js");
const { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } = await load("@noble/hashes/utils.js");

const OUT = path.join(here, "src/evm_vectors.json");
// Aave's test market on Base Sepolia (INTERFACES.md 24) and the gas wallet's address, as somewhere to send to.
const CHAIN = 84532n;
const POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
const WBTC = "0x54114591963CF60EF3aA63bEfD6eC263D98145a4";
const USDC = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
const WETH = "0x4200000000000000000000000000000000000006";
const OTHER = "0x2031181d63507368232579AF4c64a1c3428407fF";
// The address every account has in the sandbox: the MPC mock answers with one fixed key (contracts/testnet/mpc-mock).
const SANDBOX = "0xd7f35513286b7a0c2a7d8648c72588751ce0dd7c";
const MAX = (1n << 256n) - 1n;
const TIP = 1_000_000n;
const MAX_FEE = 1_000_000_000n;

const key = keccak_256(utf8ToBytes("pbf account contract: Ethereum test vectors, a throwaway key"));
const address = `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(key, false).slice(1)).slice(-20))}`;

/** Minimal big-endian bytes of a non-negative integer; empty for 0, as RLP wants. */
function big(v) {
  if (v === 0n) return new Uint8Array(0);
  let h = v.toString(16);
  if (h.length % 2) h = `0${h}`;
  return hexToBytes(h);
}
function head(n, offset) {
  if (n < 56) return Uint8Array.of(offset + n);
  const b = big(BigInt(n));
  return concatBytes(Uint8Array.of(offset + 55 + b.length), b);
}
function rlp(x) {
  if (Array.isArray(x)) {
    const body = concatBytes(...x.map(rlp));
    return concatBytes(head(body.length, 0xc0), body);
  }
  if (x.length === 1 && x[0] < 0x80) return x;
  return concatBytes(head(x.length, 0x80), x);
}

/** A call's data: the first 4 bytes of the keccak256 of its signature, then each argument as a 32-byte word. */
function call(signature, ...args) {
  const selector = bytesToHex(keccak_256(utf8ToBytes(signature)).slice(0, 4));
  const word = (a) => (typeof a === "string" ? a.slice(2).toLowerCase() : a.toString(16)).padStart(64, "0");
  return `0x${selector}${args.map(word).join("")}`;
}

/** One signed type 2 transaction, with everything a test needs to rebuild it. */
function transaction(name, { nonce, to, data, gasLimit, tip = TIP, maxFee = MAX_FEE }) {
  const fields = [big(CHAIN), big(nonce), big(tip), big(maxFee), big(gasLimit), hexToBytes(to.slice(2)), big(0n), hexToBytes(data.slice(2)), []];
  const digest = keccak_256(concatBytes(Uint8Array.of(2), rlp(fields)));
  // "recovered" puts the recovery byte first: [rec, r, s].
  const sig = secp256k1.sign(digest, key, { prehash: false, format: "recovered" });
  const [r, s] = [sig.slice(1, 33), sig.slice(33, 65)];
  const number = (bytes) => BigInt(`0x${bytesToHex(bytes)}`);
  const raw = concatBytes(Uint8Array.of(2), rlp([...fields, big(BigInt(sig[0])), big(number(r)), big(number(s))]));
  // The address the signature recovers to over that digest: it must be the key's.
  const point = secp256k1.Signature.fromBytes(sig, "recovered").recoverPublicKey(digest);
  const recovered = `0x${bytesToHex(keccak_256(point.toBytes(false).slice(1)).slice(-20))}`;
  if (recovered !== address) throw new Error(`${name}: the signature recovers to ${recovered}, not ${address}`);
  return {
    name,
    chain_id: CHAIN.toString(),
    nonce: nonce.toString(),
    max_priority_fee_per_gas: tip.toString(),
    max_fee_per_gas: maxFee.toString(),
    gas_limit: gasLimit.toString(),
    to: to.toLowerCase(),
    data,
    signing_hash: `0x${bytesToHex(digest)}`,
    y_parity: sig[0],
    r: `0x${bytesToHex(r)}`,
    s: `0x${bytesToHex(s)}`,
    raw: `0x${bytesToHex(raw)}`,
    hash: `0x${bytesToHex(keccak_256(raw))}`,
    recovered,
  };
}

// 0.01 WBTC is 1,000,000 units; $100 is 100,000,000 units of USDC.
const supply = call("supply(address,uint256,address,uint16)", WBTC, 1_000_000n, address, 0n);
const transactions = [
  transaction("approve", { nonce: 0n, to: WBTC, data: call("approve(address,uint256)", POOL, MAX), gasLimit: 100_000n }),
  transaction("supply", { nonce: 1n, to: POOL, data: supply, gasLimit: 300_000n }),
  transaction("borrow", { nonce: 2n, to: POOL, data: call("borrow(address,uint256,uint256,uint16,address)", USDC, 100_000_000n, 2n, 0n, address), gasLimit: 400_000n }),
  transaction("repay", { nonce: 127n, to: POOL, data: call("repay(address,uint256,uint256,address)", USDC, 100_500_000n, 2n, address), gasLimit: 300_000n }),
  transaction("repay_all", { nonce: 128n, to: POOL, data: call("repay(address,uint256,uint256,address)", USDC, MAX, 2n, address), gasLimit: 300_000n }),
  transaction("withdraw", { nonce: 300n, to: POOL, data: call("withdraw(address,uint256,address)", WBTC, 1_000_000n, address), gasLimit: 300_000n }),
  transaction("transfer", { nonce: 5n, to: USDC, data: call("transfer(address,uint256)", OTHER, 99_000_000n), gasLimit: 100_000n }),
  // The same supply signed again with higher fees, as evm_bump does.
  transaction("supply_bumped", { nonce: 1n, to: POOL, data: supply, gasLimit: 300_000n, tip: 2_000_000n, maxFee: MAX_FEE }),
];
// A signature whose r, and one whose s, starts with a zero byte: RLP writes a number without it. About one
// signature in 256 has each, so try nonces until both turn up.
for (const part of ["r", "s"]) {
  for (let nonce = 1_000n; ; nonce += 1n) {
    const tx = transaction(`supply_with_a_short_${part}`, { nonce, to: POOL, data: supply, gasLimit: 300_000n });
    if (tx[part].startsWith("0x00")) {
      transactions.push(tx);
      break;
    }
  }
}

// The transactions the sandbox tests have an account sign (contracts/tests/tests/aave.rs): approve WETH, supply 0.02
// WETH, that supply again with higher fees, and borrow $20, on behalf of the sandbox's address. The account's fee
// limit there is 1 gwei: a first try offers half of it, and the bump offers a tenth more with twice the tip. The test
// hands these signatures to the account as the signer's answers and compares what the deployed contract keeps with
// `raw` and `hash`. They are the throwaway key's signatures, so they recover to its address and not to the
// sandbox's: the mock signs nothing itself.
const FIRST_FEE = MAX_FEE / 2n;
const sandboxSupply = call("supply(address,uint256,address,uint16)", WETH, 20_000_000_000_000_000n, SANDBOX, 0n);
const sandbox = [
  transaction("approve", { nonce: 0n, to: WETH, data: call("approve(address,uint256)", POOL, MAX), gasLimit: 100_000n, maxFee: FIRST_FEE }),
  transaction("supply", { nonce: 1n, to: POOL, data: sandboxSupply, gasLimit: 300_000n, maxFee: FIRST_FEE }),
  transaction("supply_bumped", { nonce: 1n, to: POOL, data: sandboxSupply, gasLimit: 300_000n, tip: 2_000_000n, maxFee: (FIRST_FEE * 11n) / 10n }),
  transaction("borrow", { nonce: 2n, to: POOL, data: call("borrow(address,uint256,uint256,uint16,address)", USDC, 20_000_000n, 2n, 0n, SANDBOX), gasLimit: 400_000n, maxFee: FIRST_FEE }),
  // The move home of contracts/tests/tests/moves.rs: $20 of USDC sent to a 1Click deposit address, as an account's
  // first transaction.
  transaction("home_usdc", { nonce: 0n, to: USDC, data: call("transfer(address,uint256)", OTHER, 20_000_000n), gasLimit: 100_000n, maxFee: FIRST_FEE }),
];

const vectors = {
  note: "Written by contracts/account/evm-vectors.mjs: Ethereum type 2 transactions built and signed in Node with a throwaway key. Don't edit by hand.",
  address,
  transactions,
  sandbox: { account: SANDBOX, transactions: sandbox },
};
const text = `${JSON.stringify(vectors, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(`evm-vectors: ${OUT} is not what this script writes`);
    process.exit(1);
  }
  console.log(`evm-vectors: ${OUT} is up to date (${transactions.length + sandbox.length} transactions)`);
} else {
  writeFileSync(OUT, text);
  console.log(`evm-vectors: wrote ${transactions.length + sandbox.length} transactions, signed by ${address}, to ${OUT}`);
}
