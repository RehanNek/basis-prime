// The asset table, the unit helpers, the Hyperliquid ledger reader and the config.
import assert from "node:assert/strict";
import { test } from "node:test";

import { formatUnits, isValidAddress, mainnetPlaceholder, parseUnits, shimAssets } from "./assets.js";
import { shimConfig } from "./config.js";
import { incomingUsdc, usdSendAmount } from "./hl-float.js";

test("each test asset maps to its mainnet twin with the same decimals", () => {
  const table = shimAssets({ musdc: "musdc.pbf-ops.testnet", mnbtc: "mnbtc.pbf-ops.testnet" }).map((a) => [
    a.assetId,
    a.mainnetAssetId,
    a.decimals,
  ]);
  assert.deepEqual(table, [
    ["nep141:musdc.pbf-ops.testnet", "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", 6],
    ["nep141:mnbtc.pbf-ops.testnet", "nep141:nbtc.bridge.near", 8],
    ["1cs_v1:hypercore:hip1:0xeb62eee3685fc4c43992febcd9e75443", "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054", 8],
  ]);
});

test("formatUnits and parseUnits convert between units and decimals", () => {
  assert.equal(formatUnits(13117n, 8), "0.00013117");
  assert.equal(formatUnits("10000000", 6), "10");
  assert.equal(formatUnits(0n, 6), "0");
  assert.equal(parseUnits("10.5", 8), 1_050_000_000n);
  assert.equal(parseUnits("1", 6), 1_000_000n);
  assert.equal(parseUnits("0.000100", 4), 1n);
  assert.throws(() => parseUnits("0.123", 2), /more than 2 decimals/);
  assert.throws(() => parseUnits("-1", 6), /Not a decimal amount/);
});

test("addresses are checked per chain", () => {
  assert.ok(isValidAddress("near", "pbf-keeper.testnet"));
  assert.ok(isValidAddress("near", "5c224b2664c92e6bd71e04d7f7af7380de6e1c68c09e2872b25f94a2cfcb3bee"));
  assert.ok(!isValidAddress("near", "Bad.Account"));
  assert.ok(isValidAddress("hl", "0x5e9ee1089755c3435139848e47e6635505d5a13a"));
  assert.ok(!isValidAddress("hl", "pbf-keeper.testnet"));
  assert.equal(mainnetPlaceholder("near"), "aurora");
  assert.match(mainnetPlaceholder("hl"), /^0x[0-9a-f]{40}$/);
});

test("usdSend amounts are rounded down to 6 decimals", () => {
  assert.equal(usdSendAmount(968_123_456n), "9.681234");
  assert.equal(usdSendAmount(1_000_000_000n), "10");
});

test("the float's ledger: only USDC sent to the float counts, whatever the transfer kind", () => {
  const float = "0x00000000000000000000000000000000000f10a7";
  const sender = "0x1111111111111111111111111111111111111111";
  const updates = [
    { time: 1, hash: "0xa", delta: { type: "internalTransfer", usdc: "10.0", user: sender, destination: float } },
    { time: 2, hash: "0xb", delta: { type: "send", token: "USDC", amount: "2.5", user: sender.toUpperCase().replace("0X", "0x"), destination: float } },
    { time: 3, hash: "0xc", delta: { type: "spotTransfer", token: "USDC", amount: "1", user: sender, destination: float } },
    { time: 4, hash: "0xd", delta: { type: "spotTransfer", token: "HYPE", amount: "1", user: sender, destination: float } },
    { time: 5, hash: "0xe", delta: { type: "internalTransfer", usdc: "3", user: float, destination: sender } },
    { time: 6, hash: "0xf", delta: { type: "deposit", usdc: "100" } },
  ];
  assert.deepEqual(incomingUsdc(float, updates), [
    { hash: "0xa", time: 1, from: sender, amount: 1_000_000_000n },
    { hash: "0xb", time: 2, from: sender, amount: 250_000_000n },
    { hash: "0xc", time: 3, from: sender, amount: 100_000_000n },
  ]);
});

test("config: testnet only, floats off when their variables are empty, port from SHIM_URL", () => {
  const config = shimConfig({ NEAR_NETWORK: "testnet", SHIM_URL: "http://localhost:8787", SHIM_NEAR_ACCOUNT_ID: "shim.pbf-ops.testnet", SHIM_NEAR_PRIVATE_KEY: "" });
  assert.equal(config.port, 8787);
  assert.equal(config.near, undefined, "no key, no NEAR float");
  assert.equal(config.hl, undefined);
  assert.equal(config.adminToken, undefined);
  assert.equal(config.tokens.musdc, "musdc.pbf-ops.testnet");

  assert.throws(() => shimConfig({ NEAR_NETWORK: "mainnet" }), /testnet only/);
  assert.throws(() => shimConfig({ HL_API_URL: "https://api.hyperliquid.xyz" }), /only signs on testnet/);
});
