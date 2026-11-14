// Live test on Hyperliquid testnet, for the Phase 1 gate (PLAN.md 11.2): the shim delivers test USDC there.
//
//   pnpm --filter @pb/oneclick-shim live:hl [--to 0x...]
//
// It needs the Hyperliquid float: HL_FLOAT_ADDRESS and HL_FLOAT_PRIVATE_KEY in .env, and test USDC in the
// float from Hyperliquid's testnet faucet. Until a teammate has done that, it stops and says so.
// The keeper deposits 5 mUSDC on NEAR. The shim prices it as NEAR USDC -> Hyperliquid USDC with the real
// 1Click (about $0.32 less) and sends the USDC from the float with usdSend. The recipient is --to, or else a
// fresh address, for which Hyperliquid takes its 1 USDC activation fee from the float.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";

import { waitForStatus } from "@pb/oneclick";

import { HL_TESTNET_USDC_ASSET, isValidAddress } from "./assets.js";
import type { ShimStatus } from "./engine.js";
import { depositOnNear, ensureKeeperHolds, fail, liveSetup, log, requireTokens, sleep, startShim } from "./live-kit.js";

const AMOUNT = 5_000_000n; // 5 mUSDC

const setup = liveSetup("live-hl");
const { config, keeperId, reads } = setup;
if (!config.hl) {
  fail("blocked: HL_FLOAT_ADDRESS or HL_FLOAT_PRIVATE_KEY is empty. A teammate funds the float from Hyperliquid's testnet faucet first", 2);
}
const argv = process.argv.slice(2);
const { values } = parseArgs({ args: argv[0] === "--" ? argv.slice(1) : argv, options: { to: { type: "string" } } });
const recipient = (values.to ?? `0x${randomBytes(20).toString("hex")}`).toLowerCase();
if (!isValidAddress("hl", recipient)) fail(`--to must be a 0x address, not ${values.to}`);

const info = new InfoClient({ transport: new HttpTransport({ isTestnet: true, apiUrl: config.hlApiUrl }) });
// The float delivers with usdSend, which spends perps USDC, so its check reads perps.
const perpsUsdc = async (address: string) =>
  Number((await info.clearinghouseState({ user: address as `0x${string}` })).marginSummary.accountValue);
// A recipient's USDC can sit in perps or, for a "unified" account, in spot, so its check adds both.
const totalUsdc = async (address: string) => {
  const spot = await info.spotClearinghouseState({ user: address as `0x${string}` });
  return (await perpsUsdc(address)) + Number(spot.balances.find((b) => b.coin === "USDC")?.total ?? 0);
};

const floatUsdc = await perpsUsdc(config.hl.address);
log(`Hyperliquid float ${config.hl.address} holds ${floatUsdc} USDC`);
if (floatUsdc < 7) fail(`the float needs at least 7 USDC on Hyperliquid testnet, and holds ${floatUsdc}`, 2);

await requireTokens(reads, [config.tokens.musdc]);
await ensureKeeperHolds(setup, config.tokens.musdc, AMOUNT, 100_000_000n);
const before = await totalUsdc(recipient);
const shim = await startShim(config);

try {
  await shim.setFault("none");
  const quote = await shim.client.quote({
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: `nep141:${config.tokens.musdc}`,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: HL_TESTNET_USDC_ASSET,
    amount: AMOUNT.toString(),
    refundTo: keeperId,
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  log(`quote: 5 mUSDC -> ${quote.quote.amountOutFormatted} USDC on Hyperliquid testnet for ${recipient}, in ${quote.quote.timeEstimate} s`);
  await depositOnNear(setup, shim.client, config.tokens.musdc, quote);

  const final = (await waitForStatus(shim.client, quote.quote.depositAddress!, {
    intervalMs: 3_000,
    timeoutMs: (quote.quote.timeEstimate + 180) * 1000,
    onChange: (s) => log(`status: ${s.status}`),
  })) as ShimStatus;

  const delivered = Number(final.swapDetails.amountOutFormatted ?? 0);
  let after = await totalUsdc(recipient);
  for (let i = 0; i < 10 && after - before < delivered - 1e-6; i++) {
    await sleep(1_500);
    after = await totalUsdc(recipient);
  }
  const ok = final.status === "SUCCESS" && after - before >= delivered - 1e-6;
  log(
    `${ok ? "PASS" : "FAIL"}: ${final.status}; ${recipient} went from ${before} to ${after} USDC ` +
      `(usdSend ${delivered}, ledger hash ${final.swapDetails.destinationChainTxHashes[0]?.hash || "not found"})` +
      (final.swapDetails.refundReason ? `; reason: ${final.swapDetails.refundReason}` : ""),
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  shim.stop();
}
