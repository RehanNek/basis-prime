// Live smoke test against the real 1Click API (mainnet, read-only): the token list and one dry quote.
// A dry quote makes no deposit address, so nothing can be sent. Run with `pnpm test:live`, which
// loads .env so the quote uses our key (ONECLICK_JWT) when it is set.
import assert from "node:assert/strict";
import { test } from "node:test";

import { OneClickClient } from "./client.js";
import { ONECLICK_DEFAULT_URL } from "./env.js";

const NEAR_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const NBTC = "nep141:nbtc.bridge.near";

const client = new OneClickClient({
  baseUrl: process.env.ONECLICK_API_URL?.trim() || ONECLICK_DEFAULT_URL,
  apiKey: process.env.ONECLICK_JWT?.trim() || undefined,
});

test("live: GET /v0/tokens lists NEAR USDC and nBTC with their decimals", async () => {
  const tokens = await client.tokens();
  assert.equal(tokens.find((t) => t.assetId === NEAR_USDC)?.decimals, 6);
  assert.equal(tokens.find((t) => t.assetId === NBTC)?.decimals, 8);
});

test("live: a dry quote for $10 of NEAR USDC into nBTC prices it and gives no deposit address", async () => {
  const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
  const response = await client.quote({
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: NEAR_USDC,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: NBTC,
    amount: "10000000",
    refundTo: "aurora",
    refundType: "ORIGIN_CHAIN",
    recipient: "aurora",
    recipientType: "DESTINATION_CHAIN",
    deadline,
  });
  assert.equal(response.quote.amountIn, "10000000");
  assert.ok(BigInt(response.quote.amountOut) > 0n, "amountOut should be positive");
  assert.ok(BigInt(response.quote.minAmountOut) <= BigInt(response.quote.amountOut));
  assert.ok(response.quote.timeEstimate > 0);
  assert.equal(response.quote.depositAddress, undefined);
  console.log(`dry quote: 10 USDC -> ${response.quote.amountOutFormatted} nBTC in about ${response.quote.timeEstimate} s`);
});
