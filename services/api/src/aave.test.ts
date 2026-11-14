import assert from "node:assert/strict";
import { test } from "node:test";

import { AAVE_API_URL, AAVE_MAINNET, AAVE_QUERY, AAVE_TESTNET_TOKENS, aaveApi, aaveCalls, decimalToUnits, fractionBp, rayApyBp, readAaveApi, readAaveCalls, readAaveTestnet, SELECTORS } from "./aave.js";
import { AAVE_TESTNET_DATA_PROVIDER, BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_RPC } from "./config.js";
import { EvmError, EvmRpc, type EvmReader } from "./evm.js";
import { fakeFetch } from "./fakes.js";

/**
 * Keccak-256, written out so the selectors can be recomputed here without a new package (research/aave.md asks for
 * it). It is the compact form of the Keccak team's reference: 24 rounds of theta, rho and pi, chi and iota over 25
 * lanes of 64 bits, with a rate of 136 bytes and Keccak's 0x01 padding (not SHA-3's 0x06).
 */
function keccak256(input: Uint8Array): string {
  const mask = (1n << 64n) - 1n;
  const rol = (v: bigint, n: number) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & mask);
  const a = new Array<bigint>(25).fill(0n);
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((input.length + 1) / rate) * rate);
  padded.set(input);
  padded[input.length]! ^= 0x01;
  padded[padded.length - 1]! ^= 0x80;
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[offset + i * 8 + b]!);
      a[i]! ^= lane;
    }
    let lfsr = 1;
    for (let round = 0; round < 24; round++) {
      const c = [0, 1, 2, 3, 4].map((x) => a[x]! ^ a[x + 5]! ^ a[x + 10]! ^ a[x + 15]! ^ a[x + 20]!);
      for (let x = 0; x < 5; x++) {
        const d = c[(x + 4) % 5]! ^ rol(c[(x + 1) % 5]!, 1);
        for (let y = 0; y < 25; y += 5) a[x + y]! ^= d;
      }
      let x = 1;
      let y = 0;
      let current = a[1]!;
      for (let t = 0; t < 24; t++) {
        [x, y] = [y, (2 * x + 3 * y) % 5];
        const kept = a[x + 5 * y]!;
        a[x + 5 * y] = rol(current, (((t + 1) * (t + 2)) / 2) % 64);
        current = kept;
      }
      for (let row = 0; row < 25; row += 5) {
        const lanes = a.slice(row, row + 5);
        for (let i = 0; i < 5; i++) a[row + i] = lanes[i]! ^ (~lanes[(i + 1) % 5]! & mask & lanes[(i + 2) % 5]!);
      }
      for (let j = 0; j < 7; j++) {
        lfsr = ((lfsr << 1) ^ ((lfsr >> 7) * 0x71)) & 0xff;
        if (lfsr & 2) a[0]! ^= 1n << BigInt((1 << j) - 1);
      }
    }
  }
  let out = "";
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out += ((a[i]! >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, "0");
  return out;
}

const selector = (signature: string) => `0x${keccak256(new TextEncoder().encode(signature)).slice(0, 8)}`;
const hex = (...values: bigint[]) => `0x${values.map((v) => v.toString(16).padStart(64, "0")).join("")}`;

/** Aave's data provider on Base Sepolia as it answered on 10 Nov at block 57,135,551. */
const RESERVE_DATA = hex(0n, 30_037_429_057n, 51_859_252_766_568n, 0n, 7_152_228_230_247n, 911_669_480_384_519_912_838_080n, 7_350_160_413_001_912_115_431_107n, 0n, 0n, 1_244_884_701_053_326_239_932_388_465n, 1_297_755_086_611_011_380_098_791_613n, 1_794_348_968n);
const WBTC_CONFIG = hex(8n, 8_150n, 8_300n, 10_500n, 1_000n, 1n, 0n, 0n, 1n, 0n);
const FREE_USDC = hex(44_744_893_737_579n);
const LIVE = [RESERVE_DATA, WBTC_CONFIG, FREE_USDC];

test("each selector is the first four bytes of keccak256 of its signature in Aave's source", () => {
  assert.equal(keccak256(new Uint8Array()), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", "keccak256 of nothing, the known answer");
  // The Pool selectors research/aave.md lists: the same function gives them, so it is the right one.
  assert.equal(selector("getUserAccountData(address)"), "0xbf92857c");
  assert.equal(selector("supply(address,uint256,address,uint16)"), "0x617ba037");
  assert.equal(SELECTORS.getReserveData, selector("getReserveData(address)"));
  assert.equal(SELECTORS.getReserveConfigurationData, selector("getReserveConfigurationData(address)"));
  assert.equal(SELECTORS.getVirtualUnderlyingBalance, selector("getVirtualUnderlyingBalance(address)"));
});

test("the test market's read is three calls to the data provider, each a selector and a token's address padded to 32 bytes", () => {
  assert.deepEqual(aaveCalls(AAVE_TESTNET_DATA_PROVIDER), [
    { to: "0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b", data: "0x35ea6a75000000000000000000000000ba50cd2a20f6da35d788639e581bca8d0b5d4d5f" },
    { to: "0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b", data: "0x3e15014100000000000000000000000054114591963cf60ef3aa63befd6ec263d98145a4" },
    { to: "0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b", data: "0x6fb07f96000000000000000000000000ba50cd2a20f6da35d788639e581bca8d0b5d4d5f" },
  ]);
  assert.deepEqual([AAVE_TESTNET_TOKENS.usdc, AAVE_TESTNET_TOKENS.wbtc], ["0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", "0x54114591963CF60EF3aA63bEfD6eC263D98145a4"], "INTERFACES.md 24's test tokens");
});

test("Aave's test market as Base Sepolia answered on 10 Nov: rates compounded like Aave's API, free USDC, WBTC's LTV, threshold and penalty", () => {
  assert.deepEqual(readAaveCalls(LIVE), { rate_bp: 74, supply_bp: 9, free: "44744893737579", ltv_bp: 8_150, liq_bp: 8_300, penalty_bp: 500 });
  // A year's simple rate of 5% compounds each second to 5.127%.
  assert.equal(rayApyBp(50_000_000_000_000_000_000_000_000n), 513);
  assert.equal(rayApyBp(0n), 0);
  // WBTC switched off as collateral lends nothing.
  const off = hex(8n, 8_150n, 8_300n, 10_500n, 1_000n, 0n, 0n, 0n, 1n, 0n);
  assert.deepEqual([readAaveCalls([RESERVE_DATA, off, FREE_USDC]).ltv_bp, readAaveCalls([RESERVE_DATA, off, FREE_USDC]).liq_bp], [0, 0]);
  // An address that isn't the data provider answers another layout, or nothing.
  assert.throws(() => readAaveCalls([FREE_USDC, WBTC_CONFIG, FREE_USDC]), (e: unknown) => e instanceof EvmError && /getReserveData\(USDC\) answered 1 words/.test(e.message));
  assert.throws(() => readAaveCalls([RESERVE_DATA, WBTC_CONFIG, "0x"]), /getVirtualUnderlyingBalance\(USDC\) answered 0 words/);
  assert.throws(() => readAaveCalls([RESERVE_DATA, hex(8n, 1n << 200n, 8_300n, 10_500n, 1_000n, 1n, 0n, 0n, 1n, 0n), FREE_USDC]), /isn't a figure out of 10,000/);
});

test("the test market is read in one batch and decoded; an RPC that answers for another chain is refused", async () => {
  // The replies come back out of order, as a batch may.
  const replies = [
    { jsonrpc: "2.0", id: 2, result: WBTC_CONFIG },
    { jsonrpc: "2.0", id: 0, result: "0x14a34" },
    { jsonrpc: "2.0", id: 3, result: FREE_USDC },
    { jsonrpc: "2.0", id: 1, result: RESERVE_DATA },
  ];
  const { impl, calls } = fakeFetch({ status: 200, body: replies });
  const rpc = new EvmRpc({ url: BASE_SEPOLIA_RPC, fetch: impl });
  assert.deepEqual(await readAaveTestnet(rpc, BASE_SEPOLIA_CHAIN_ID, AAVE_TESTNET_DATA_PROVIDER), { rate_bp: 74, supply_bp: 9, free: "44744893737579", ltv_bp: 8_150, liq_bp: 8_300, penalty_bp: 500 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://sepolia.base.org");

  const other: EvmReader = { calls: async () => ({ chainId: 8_453, results: LIVE }) };
  await assert.rejects(readAaveTestnet(other, BASE_SEPOLIA_CHAIN_ID, AAVE_TESTNET_DATA_PROVIDER), /EVM_RPC_URL answers for chain 8453 but EVM_CHAIN_ID is 84532/);
});

/** Aave's API as it answered AAVE_QUERY on 10 Nov. */
const API_ANSWER = {
  usdc: {
    underlyingToken: { symbol: "USDC", decimals: 6 },
    supplyInfo: { apy: { value: "0.042975004835241658471549509" } },
    borrowInfo: { apy: { value: "0.050841553026630224387883458" }, availableLiquidity: { amount: { value: "163234342.643274" } } },
  },
  wbtc: {
    underlyingToken: { symbol: "WBTC", decimals: 8 },
    supplyInfo: { maxLTV: { value: "0.81" }, liquidationThreshold: { value: "0.85" }, liquidationBonus: { value: "0.05" }, canBeCollateral: true },
  },
};

test("Aave's mainnet terms from its own API: USDC's rates and free liquidity, WBTC's LTV, threshold and penalty", () => {
  assert.deepEqual(readAaveApi(API_ANSWER), { rate_bp: 508, supply_bp: 430, free: "163234342643274", ltv_bp: 8_100, liq_bp: 8_500, penalty_bp: 500 });
  assert.deepEqual([fractionBp("0.81"), fractionBp("0"), fractionBp(0.81), fractionBp("1e-2")], [8_100, 0, null, null]);
  assert.deepEqual([decimalToUnits("163234342.643274", 6), decimalToUnits("1.2345678", 6), decimalToUnits("7", 6), decimalToUnits("x", 6)], ["163234342643274", "1234567", "7000000", null]);
  assert.throws(() => readAaveApi({ usdc: API_ANSWER.usdc, wbtc: null }), /no WBTC reserve in the Ethereum core market/);
  assert.throws(() => readAaveApi({ usdc: { ...API_ANSWER.usdc, borrowInfo: null }, wbtc: API_ANSWER.wbtc }), /USDC can't be borrowed/);
  assert.throws(() => readAaveApi({ usdc: { ...API_ANSWER.usdc, supplyInfo: {} }, wbtc: API_ANSWER.wbtc }), /no deposit rate for USDC/);
  assert.throws(() => readAaveApi({ usdc: { ...API_ANSWER.usdc, underlyingToken: { symbol: "DAI", decimals: 18 } }, wbtc: API_ANSWER.wbtc }), /isn't 6-decimal USDC/);
  const notCollateral = { ...API_ANSWER.wbtc, supplyInfo: { ...API_ANSWER.wbtc.supplyInfo, canBeCollateral: false } };
  assert.deepEqual([readAaveApi({ usdc: API_ANSWER.usdc, wbtc: notCollateral }).ltv_bp, readAaveApi({ usdc: API_ANSWER.usdc, wbtc: notCollateral }).liq_bp], [0, 0]);
});

test("the Aave API client posts the query with its variables, and says why when the API refuses", async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { data: API_ANSWER } }, { status: 200, body: { errors: [{ message: "Unknown field" }] } }, { status: 503, body: "down" });
  const api = aaveApi({ fetch: impl });
  const variables = { market: AAVE_MAINNET.market, chain: 1, usdc: AAVE_MAINNET.usdc, wbtc: AAVE_MAINNET.wbtc };
  assert.deepEqual(await api(AAVE_QUERY, variables), API_ANSWER);
  assert.deepEqual([calls[0]!.url, calls[0]!.method, calls[0]!.body], [AAVE_API_URL, "POST", { query: AAVE_QUERY, variables }]);
  assert.match(AAVE_QUERY, /reserve\(request: \{ market: \$market, underlyingToken: \$usdc, chainId: \$chain \}\)/);
  await assert.rejects(api(AAVE_QUERY, variables), /Aave's API refused the query: Unknown field/);
  await assert.rejects(api(AAVE_QUERY, variables), /api\.v3\.aave\.com\) answered HTTP 503/);
});
