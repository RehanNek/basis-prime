#!/usr/bin/env node
// A live try of Aave's test market on Base Sepolia, with the gas wallet standing in for a client account
// (FUNDING.md 11, stage 0: "check Aave's faucet and gas with a real mint"). Testnet only: it refuses any other chain.
//
//   node scripts/aave-spike.mjs            reads only: balances, the position, and each call's data
//   node scripts/aave-spike.mjs --send     does the round trip and writes research/data/aave_spike.json
//   node scripts/aave-spike.mjs --unwrap [--send]   only turns the wallet's WETH back into test ETH (after an Aave gate)
//
// The round trip: mint test WBTC and a little test USDC from Aave's faucet, approve and supply the WBTC, borrow
// USDC, approve and repay it all, withdraw the WBTC. After each step it reads Aave's own figure for the position.
// It prints each transaction's hash and the gas it used, which sets the gas limits the account contract signs with.
//
// The calls and their selectors are recomputed here from their signatures (research/aave.md has the same list). The
// addresses are Aave's test market's (INTERFACES.md 24). The key is read from .env (EVM_GAS_PRIVATE_KEY) and never
// printed. No new dependency: the signer is the one in scripts/bridge-gas.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shim = createRequire(path.join(root, "services/oneclick-shim/package.json"));
const load = (id) => import(pathToFileURL(shim.resolve(id)).href);
const { secp256k1 } = await load("@noble/curves/secp256k1.js");
const { keccak_256 } = await load("@noble/hashes/sha3.js");
const { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } = await load("@noble/hashes/utils.js");

const RPC = "https://sepolia.base.org";
const CHAIN = 84532n;
const POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
const WBTC = "0x54114591963CF60EF3aA63bEfD6eC263D98145a4";
const USDC = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
const FAUCET = "0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc";
const MAX = (1n << 256n) - 1n;
const WBTC_UNITS = 1_000_000n; // 0.01 WBTC
const USDC_EXTRA = 1_000_000n; // 1 USDC, so that the repayment can cover the interest
const BORROW_UNITS = 100_000_000n; // 100 USDC
const MAX_FEE_WEI = 1_000_000_000n; // 1 gwei: the account's limit on testnet (INTERFACES.md 33)
const TIP_WEI = 1_000_000n;

const fail = (why) => {
  console.error(`aave-spike: ${why}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params = []) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 && attempt < 5) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`Base Sepolia's RPC answered HTTP ${res.status} to ${method}`);
    const out = await res.json();
    if (out.error) throw new Error(`${method}: ${out.error.message}`);
    return out.result;
  }
}

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

// ---------- ABI and RLP ----------
const selector = (signature) => bytesToHex(keccak_256(utf8ToBytes(signature)).slice(0, 4));
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const call = (signature, ...args) => `0x${selector(signature)}${args.map(word).join("")}`;

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

// ---------- The wallet ----------
const keyHex = (setting("EVM_GAS_PRIVATE_KEY") ?? "").replace(/^0x/, "");
if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) fail("EVM_GAS_PRIVATE_KEY in .env isn't a 32-byte hex key");
const key = hexToBytes(keyHex);
const me = `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(key, false).slice(1)).slice(-20))}`;
if (BigInt(await rpc("eth_chainId")) !== CHAIN) fail(`${RPC} isn't Base Sepolia`);

const view = (to, data) => rpc("eth_call", [{ from: me, to, data }, "latest"]);
const uint = async (to, data) => BigInt(await view(to, data));
const words = (hex) => (hex.slice(2).match(/.{64}/g) ?? []).map((w) => BigInt(`0x${w}`));

async function standing() {
  const [eth, weth, wbtc, usdc, account] = await Promise.all([
    rpc("eth_getBalance", [me, "latest"]).then(BigInt),
    uint("0x4200000000000000000000000000000000000006", call("balanceOf(address)", me)),
    uint(WBTC, call("balanceOf(address)", me)),
    uint(USDC, call("balanceOf(address)", me)),
    view(POOL, call("getUserAccountData(address)", me)).then(words),
  ]);
  // getUserAccountData: collateral, debt and room in USD with 8 decimals, threshold and LTV in bp, health factor 1e18.
  const [collateral, debt, room, threshold, ltv, health] = account;
  return {
    eth: Number(eth) / 1e18,
    weth: Number(weth) / 1e18,
    wbtc: Number(wbtc) / 1e8,
    usdc: Number(usdc) / 1e6,
    collateral_usd: Number(collateral) / 1e8,
    debt_usd: Number(debt) / 1e8,
    room_usd: Number(room) / 1e8,
    liq_bp: Number(threshold),
    ltv_bp: Number(ltv),
    health: health > 10n ** 30n ? null : Number(health) / 1e18,
  };
}

async function send(label, to, data, value = 0n) {
  const [nonce, estimate] = await Promise.all([
    rpc("eth_getTransactionCount", [me, "pending"]).then(BigInt),
    rpc("eth_estimateGas", [{ from: me, to, data, value: `0x${value.toString(16)}` }]).then(BigInt),
  ]);
  const gasLimit = (estimate * 3n) / 2n;
  const fields = [big(CHAIN), big(nonce), big(TIP_WEI), big(MAX_FEE_WEI), big(gasLimit), hexToBytes(to.slice(2)), big(value), hexToBytes(data.slice(2)), []];
  const digest = keccak_256(concatBytes(Uint8Array.of(2), rlp(fields)));
  const sig = secp256k1.sign(digest, key, { prehash: false, format: "recovered" });
  const r = BigInt(`0x${bytesToHex(sig.slice(1, 33))}`);
  const s = BigInt(`0x${bytesToHex(sig.slice(33, 65))}`);
  const raw = concatBytes(Uint8Array.of(2), rlp([...fields, big(BigInt(sig[0])), big(r), big(s)]));
  const hash = await rpc("eth_sendRawTransaction", [`0x${bytesToHex(raw)}`]);
  let receipt = null;
  for (let i = 0; i < 40 && !receipt; i += 1) {
    await sleep(1500);
    receipt = await rpc("eth_getTransactionReceipt", [hash]);
  }
  if (!receipt) fail(`${label}: no receipt after a minute (${hash})`);
  const ok = BigInt(receipt.status) === 1n;
  const used = Number(BigInt(receipt.gasUsed));
  const paid = Number(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)) / 1e18;
  console.log(`${ok ? "ok    " : "FAILED"} ${label.padEnd(22)} gas used ${String(used).padStart(7)} (estimate ${estimate}), fee ${paid.toFixed(9)} ETH, ${hash}`);
  if (!ok) fail(`${label} reverted`);
  return { label, to, data, nonce: Number(nonce), hash, gas_used: used, gas_estimate: Number(estimate), fee_eth: paid };
}

// With --weth the collateral is wrapped test ETH, not WBTC: on 11 Nov the test market's WBTC supply cap (175 WBTC) was
// full, so a WBTC supply reverted, while WETH had room. WETH on Base is the chain's own wrapper: `deposit()` with ETH.
const WETH = "0x4200000000000000000000000000000000000006";
const WETH_WEI = 10_000_000_000_000_000n; // 0.01 WETH
const useWeth = process.argv.includes("--weth");
// With --unwrap the wallet only turns the WETH it holds back into test ETH, and no record is written. The Aave gate
// sends its wrapped collateral back to this wallet as WETH, and the backend's gas helper wraps from ETH.
const onlyUnwrap = process.argv.includes("--unwrap");
const heldWeth = onlyUnwrap ? await uint(WETH, call("balanceOf(address)", me)) : 0n;
if (onlyUnwrap && heldWeth === 0n) {
  console.log(`wallet ${me} holds no WETH: nothing to unwrap`);
  process.exit(0);
}
const steps = onlyUnwrap
  ? [["unwrap WETH (all held)", WETH, call("withdraw(uint256)", heldWeth)]]
  : useWeth
  ? [
      ["wrap ETH into WETH", WETH, call("deposit()"), WETH_WEI],
      ["approve WETH", WETH, call("approve(address,uint256)", POOL, MAX)],
      ["supply WETH", POOL, call("supply(address,uint256,address,uint16)", WETH, WETH_WEI, me, 0)],
      ["borrow USDC", POOL, call("borrow(address,uint256,uint256,uint16,address)", USDC, 10_000_000n, 2, 0, me)],
      ["approve USDC", USDC, call("approve(address,uint256)", POOL, MAX)],
      ["repay USDC (all)", POOL, call("repay(address,uint256,uint256,address)", USDC, MAX, 2, me)],
      ["withdraw WETH (all)", POOL, call("withdraw(address,uint256,address)", WETH, MAX, me)],
      ["unwrap WETH", WETH, call("withdraw(uint256)", WETH_WEI)],
    ]
  : [
      ["mint WBTC (faucet)", FAUCET, call("mint(address,address,uint256)", WBTC, me, WBTC_UNITS)],
      ["mint USDC (faucet)", FAUCET, call("mint(address,address,uint256)", USDC, me, USDC_EXTRA)],
      ["approve WBTC", WBTC, call("approve(address,uint256)", POOL, MAX)],
      ["supply WBTC", POOL, call("supply(address,uint256,address,uint16)", WBTC, WBTC_UNITS, me, 0)],
      ["borrow USDC", POOL, call("borrow(address,uint256,uint256,uint16,address)", USDC, BORROW_UNITS, 2, 0, me)],
      ["approve USDC", USDC, call("approve(address,uint256)", POOL, MAX)],
      ["repay USDC (all)", POOL, call("repay(address,uint256,uint256,address)", USDC, MAX, 2, me)],
      ["withdraw WBTC (all)", POOL, call("withdraw(address,uint256,address)", WBTC, MAX, me)],
    ];

console.log(`wallet ${me} on Base Sepolia`);
console.log("before:", JSON.stringify(await standing()));
for (const [label, to, data] of steps) console.log(`  ${label.padEnd(22)} to ${to}  data ${data.slice(0, 10)}… (${(data.length - 2) / 2} bytes)`);
if (!process.argv.includes("--send")) {
  console.log(onlyUnwrap ? "read only: add --send to unwrap" : "read only: add --send to do the round trip");
  process.exit(0);
}

const record = { wallet: me, chain_id: Number(CHAIN), started_utc: new Date().toISOString(), max_fee_wei: String(MAX_FEE_WEI), tip_wei: String(TIP_WEI), steps: [] };
for (const [label, to, data, value] of steps) {
  const done = await send(label, to, data, value ?? 0n);
  done.after = await standing();
  record.steps.push(done);
  console.log("        ", JSON.stringify(done.after));
}
if (onlyUnwrap) process.exit(0);
record.finished_utc = new Date().toISOString();
const file = useWeth ? "research/data/aave_spike_weth.json" : "research/data/aave_spike.json";
writeFileSync(path.join(root, file), `${JSON.stringify(record, null, 1)}\n`);
console.log(`saved ${file}`);
