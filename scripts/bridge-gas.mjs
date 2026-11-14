#!/usr/bin/env node
// Moves test ETH from the gas wallet on Sepolia (Ethereum's test network) to the same address on Base Sepolia,
// through Base's own bridge. Testnet only: it refuses any other chain and any other destination.
//
//   node scripts/bridge-gas.mjs <eth>           simulate only: checks, the fee, the gas estimate
//   node scripts/bridge-gas.mjs <eth> --send    sign, send, wait for Sepolia's receipt, then for Base Sepolia's credit
//
// How it bridges: a plain ETH transfer to Base's L1StandardBridge on Sepolia. The bridge's `receive()` deposits the
// ETH for the sender's own address on Base Sepolia (OP Stack's standard bridge; it accepts this from plain wallets
// only, which the gas wallet is). The address is from Base's docs, "L1 Contract Addresses / Ethereum Testnet
// (Sepolia)", https://docs.base.org/specifications/reference/base-contracts, read 11 Nov 2026.
//
// The key is read from .env (EVM_GAS_PRIVATE_KEY) and is never printed. No new dependency: secp256k1 and Keccak come
// from the @noble packages the 1Click stand-in already uses, and the transaction (EIP-1559, type 2) is RLP-encoded here.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shim = createRequire(path.join(root, "services/oneclick-shim/package.json"));
const load = (id) => import(pathToFileURL(shim.resolve(id)).href);
const { secp256k1 } = await load("@noble/curves/secp256k1.js");
const { keccak_256 } = await load("@noble/hashes/sha3.js");
const { bytesToHex, concatBytes, hexToBytes } = await load("@noble/hashes/utils.js");

const L1 = { name: "Sepolia", rpc: process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com", chain: 11155111n };
const L2 = { name: "Base Sepolia", rpc: "https://sepolia.base.org", chain: 84532n };
const BRIDGE = "0xfd0Bf71F60660E2f608ed56e1659C450eB113120";
const PORTAL = "0x49f53e41452C74589E85cA1677426Ba426459e85";
const MAX_WEI = 60_000_000_000_000_000n; // 0.06 ETH in one run
const MIN_TIP_WEI = 100_000_000n; // 0.1 gwei

const fail = (why) => {
  console.error(`bridge-gas: ${why}`);
  process.exit(1);
};

async function rpc(net, method, params = []) {
  const res = await fetch(net.rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${net.name}'s RPC answered HTTP ${res.status} to ${method}`);
  const out = await res.json();
  if (out.error) throw new Error(`${net.name}: ${method}: ${out.error.message}`);
  return out.result;
}
const num = async (net, method, params) => BigInt(await rpc(net, method, params));
const eth = (wei) => `${(Number(wei) / 1e18).toFixed(8)} ETH`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One setting from .env, without printing anything. */
function setting(name) {
  let text;
  try {
    text = readFileSync(path.join(root, ".env"), "utf8");
  } catch {
    fail(".env can't be read");
  }
  const line = text.split("\n").find((l) => l.startsWith(`${name}=`));
  return line === undefined ? undefined : line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
}

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

function parseEth(text) {
  if (!/^\d+(\.\d{1,18})?$/.test(text ?? "")) fail("give the amount in ETH, for example 0.002");
  const [whole, frac = ""] = text.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0"));
}

const args = process.argv.slice(2);
const send = args.includes("--send");
const value = parseEth(args.find((a) => !a.startsWith("--")));
if (value === 0n || value > MAX_WEI) fail(`the amount must be above 0 and at most ${eth(MAX_WEI)}`);

const keyHex = (setting("EVM_GAS_PRIVATE_KEY") ?? "").replace(/^0x/, "");
if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) fail("EVM_GAS_PRIVATE_KEY in .env isn't a 32-byte hex key");
const key = hexToBytes(keyHex);
const from = `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(key, false).slice(1)).slice(-20))}`;
const expected = setting("EVM_GAS_ADDRESS");
if (expected && expected.toLowerCase() !== from) fail("the key in .env doesn't belong to EVM_GAS_ADDRESS");

if ((await num(L1, "eth_chainId")) !== L1.chain) fail(`${L1.rpc} isn't Sepolia`);
if ((await num(L2, "eth_chainId")) !== L2.chain) fail(`${L2.rpc} isn't Base Sepolia`);
if ((await rpc(L1, "eth_getCode", [BRIDGE, "latest"])).length <= 2) fail("there is no contract at the bridge's address on Sepolia");

const [balance, nonce, block, suggested, l2Before] = await Promise.all([
  num(L1, "eth_getBalance", [from, "latest"]),
  num(L1, "eth_getTransactionCount", [from, "pending"]),
  rpc(L1, "eth_getBlockByNumber", ["latest", false]),
  num(L1, "eth_maxPriorityFeePerGas"),
  num(L2, "eth_getBalance", [from, "latest"]),
]);
const tip = suggested > MIN_TIP_WEI ? suggested : MIN_TIP_WEI;
const maxFee = BigInt(block.baseFeePerGas) * 2n + tip;
const estimate = await num(L1, "eth_estimateGas", [{ from, to: BRIDGE, value: `0x${value.toString(16)}` }]);
const gasLimit = (estimate * 3n) / 2n;
const worstFee = gasLimit * maxFee;

console.log(`gas wallet        ${from}`);
console.log(`on ${L1.name}        ${eth(balance)}, nonce ${nonce}`);
console.log(`on ${L2.name}   ${eth(l2Before)}`);
console.log(`to bridge         ${eth(value)} to ${BRIDGE}`);
console.log(`gas               estimate ${estimate}, limit ${gasLimit}; fee at most ${eth(worstFee)} (${Number(maxFee) / 1e9} gwei)`);
if (balance < value + worstFee) fail("the wallet doesn't hold the amount plus the fee on Sepolia");
if (!send) {
  console.log("simulated only: add --send to move it");
  process.exit(0);
}

const fields = [big(L1.chain), big(nonce), big(tip), big(maxFee), big(gasLimit), hexToBytes(BRIDGE.slice(2)), big(value), new Uint8Array(0), []];
const digest = keccak_256(concatBytes(Uint8Array.of(2), rlp(fields)));
// "recovered" puts the recovery byte first: [rec, r, s] (as services/oneclick-shim/src/hl-wallet.ts uses it).
const sig = secp256k1.sign(digest, key, { prehash: false, format: "recovered" });
const r = BigInt(`0x${bytesToHex(sig.slice(1, 33))}`);
const s = BigInt(`0x${bytesToHex(sig.slice(33, 65))}`);
const raw = concatBytes(Uint8Array.of(2), rlp([...fields, big(BigInt(sig[0])), big(r), big(s)]));
const hash = await rpc(L1, "eth_sendRawTransaction", [`0x${bytesToHex(raw)}`]);
if (hash !== `0x${bytesToHex(keccak_256(raw))}`) fail(`the node answered an unexpected hash: ${hash}`);
console.log(`sent on ${L1.name}   ${hash}`);

let receipt = null;
for (let i = 0; i < 36 && !receipt; i += 1) {
  await sleep(5_000);
  receipt = await rpc(L1, "eth_getTransactionReceipt", [hash]);
}
if (!receipt) fail("no receipt on Sepolia after 3 minutes; look the hash up before sending again");
if (BigInt(receipt.status) !== 1n) fail(`the deposit failed on Sepolia (status ${receipt.status})`);
const viaPortal = receipt.logs.some((l) => l.address.toLowerCase() === PORTAL.toLowerCase());
console.log(`mined on ${L1.name}  block ${BigInt(receipt.blockNumber)}, gas used ${BigInt(receipt.gasUsed)}, deposit event from Base's portal: ${viaPortal ? "yes" : "NO"}`);

for (let i = 0; i < 40; i += 1) {
  const now = await num(L2, "eth_getBalance", [from, "latest"]);
  if (now > l2Before) {
    console.log(`arrived on ${L2.name}: ${eth(now)} (was ${eth(l2Before)}) after about ${i * 10} s`);
    process.exit(0);
  }
  await sleep(10_000);
}
console.log(`not on ${L2.name} yet after 400 s; the deposit is mined on Sepolia, so check the balance again later`);
