// Live test on NEAR testnet, for the Phase 1 gate (PLAN.md 11.2): the shim delivers test tokens,
// and its fault switch forces a refund, a failure and a late delivery.
//
//   pnpm --filter @pb/oneclick-shim live:near
//
// It starts its own shim on a free local port, with the real float from .env (SHIM_NEAR_*), and plays
// the client as the keeper (KEEPER_*). For each fault mode it:
//   1. gets a committed quote for 10 mUSDC -> mNBTC, priced by the real 1Click;
//   2. pays the deposit address's storage and sends it the mUSDC, in one transaction;
//   3. reports the deposit with /v0/deposit/submit and polls /v0/status until it settles;
//   4. checks the balances moved as the status says.
// The recipient, pbf-ops.testnet, is a plain account, so the quote has no customRecipientMsg and the
// shim delivers with ft_transfer: an ft_transfer_call to an account with no ft_on_transfer is refunded.
// Each run costs the keeper about 0.0013 NEAR (the deposit address's storage, plus gas).
import { writeFileSync } from "node:fs";

import { teraToGas } from "near-api-js";

import { waitForStatus, type StatusResponse } from "@pb/oneclick";

import { formatUnits } from "./assets.js";
import type { ShimStatus } from "./engine.js";
import { depositOnNear, ensureKeeperHolds, eventually, liveSetup, log, nearText, requireTokens, sleep, stamp, startShim, stateDir } from "./live-kit.js";
import type { FaultMode } from "./state.js";

const AMOUNT = 10_000_000n; // 10 mUSDC
const RECIPIENT = "pbf-ops.testnet";
const LATE_SECONDS = 30;
const MODES: { mode: FaultMode; expect: string }[] = [
  { mode: "none", expect: "SUCCESS" },
  { mode: "refund", expect: "REFUNDED" },
  { mode: "fail", expect: "FAILED" },
  { mode: "late", expect: "SUCCESS" },
];

const setup = liveSetup("live-near");
const { config, keeperId, keeper, reads } = setup;
const { musdc, mnbtc } = config.tokens;
const floatId = setup.near.accountId;

// ---------- Before anything moves: the tokens exist, the keeper has mUSDC, the recipient can receive mNBTC ----------
await requireTokens(reads, [musdc, mnbtc]);
log(`float ${floatId} holds ${formatUnits(await reads.balance(musdc, floatId), 6)} mUSDC and ${formatUnits(await reads.balance(mnbtc, floatId), 8)} mNBTC`);
const keeperNearBefore = await reads.nearBalance(keeperId);
const floatNearBefore = await reads.nearBalance(floatId);

await ensureKeeperHolds(setup, musdc, AMOUNT * BigInt(MODES.length), 100_000_000n);
if ((await reads.view(mnbtc, "storage_balance_of", { account_id: RECIPIENT })) === null) {
  log(`registering ${RECIPIENT} on mNBTC, paid by ${keeperId}`);
  await keeper.callFunction({
    contractId: mnbtc,
    methodName: "storage_deposit",
    args: { account_id: RECIPIENT, registration_only: true },
    deposit: await reads.storageMin(mnbtc),
    gas: teraToGas("30"),
  });
}

const shim = await startShim(config);

interface RunResult {
  mode: FaultMode;
  expected: string;
  status: string;
  ok: boolean;
  checks: string[];
  seconds: number;
  depositAddress: string;
  depositTx: string;
  settleTx: string | null;
}

async function run(mode: FaultMode, expected: string): Promise<RunResult> {
  log(`--- fault switch: ${mode} (expect ${expected})`);
  await shim.setFault(mode, LATE_SECONDS);
  const keeperUsdc = await reads.balance(musdc, keeperId);
  const recipientBtc = await reads.balance(mnbtc, RECIPIENT);

  const quote = await shim.client.quote({
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: `nep141:${musdc}`,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: `nep141:${mnbtc}`,
    amount: AMOUNT.toString(),
    refundTo: keeperId,
    refundType: "ORIGIN_CHAIN",
    recipient: RECIPIENT,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  const depositAddress = quote.quote.depositAddress!;
  const amountOut = BigInt(quote.quote.amountOut);
  log(`quote: 10 mUSDC -> ${quote.quote.amountOutFormatted} mNBTC in ${quote.quote.timeEstimate} s; deposit to ${depositAddress}`);

  const depositTx = await depositOnNear(setup, shim.client, musdc, quote);
  const started = Date.now();
  const checks: string[] = [];
  let late = true;
  const onChange = (s: StatusResponse) => log(`status: ${s.status}`);
  if (mode === "late") {
    // At the quoted time plus a margin, a late delivery hasn't happened yet.
    const processing = (s: StatusResponse) => s.status !== "PENDING_DEPOSIT" && s.status !== "KNOWN_DEPOSIT_TX";
    await waitForStatus(shim.client, depositAddress, { intervalMs: 2_000, timeoutMs: 120_000, until: processing, onChange });
    await sleep((quote.quote.timeEstimate + 8) * 1000);
    const midway = await shim.client.status(depositAddress);
    late = midway.status === "PROCESSING";
    checks.push(`still ${midway.status} ${quote.quote.timeEstimate + 8} s after the deposit was seen`);
  }
  const final = (await waitForStatus(shim.client, depositAddress, {
    intervalMs: 3_000,
    timeoutMs: (quote.quote.timeEstimate + LATE_SECONDS + 180) * 1000,
    onChange,
  })) as ShimStatus;
  const seconds = Math.round((Date.now() - started) / 1000);

  // The balances must agree with the status.
  let ok = final.status === expected && late;
  if (expected === "SUCCESS") {
    const got = (await eventually(() => reads.balance(mnbtc, RECIPIENT), recipientBtc + amountOut)) - recipientBtc;
    checks.push(`${RECIPIENT} received ${formatUnits(got, 8)} mNBTC (quoted ${quote.quote.amountOutFormatted})`);
    ok &&= got === amountOut;
  } else if (expected === "REFUNDED") {
    const got = await eventually(() => reads.balance(musdc, keeperId), keeperUsdc);
    checks.push(`${keeperId}'s mUSDC is back to ${formatUnits(got, 6)} (was ${formatUnits(keeperUsdc, 6)} before the deposit)`);
    ok &&= got === keeperUsdc;
  } else {
    const keeperNow = await eventually(() => reads.balance(musdc, keeperId), keeperUsdc - AMOUNT);
    const recipientNow = await reads.balance(mnbtc, RECIPIENT);
    checks.push(`nothing delivered (${RECIPIENT} unchanged: ${recipientNow === recipientBtc}); the 10 mUSDC stays at the deposit address`);
    ok &&= recipientNow === recipientBtc && keeperNow === keeperUsdc - AMOUNT;
  }
  if (final.swapDetails.refundReason) checks.push(`reason: ${final.swapDetails.refundReason}`);
  const settleTx = final.swapDetails.destinationChainTxHashes[0]?.hash ?? final.shim.refundTxHash ?? null;
  log(`${ok ? "PASS" : "FAIL"}: ${final.status} after ${seconds} s. ${checks.join("; ")}`);
  return { mode, expected, status: final.status, ok, checks, seconds, depositAddress, depositTx, settleTx };
}

const results: RunResult[] = [];
try {
  for (const { mode, expect } of MODES) results.push(await run(mode, expect));
} finally {
  await shim.setFault("none").catch(() => {});
  shim.stop();
}

const keeperSpent = keeperNearBefore - (await reads.nearBalance(keeperId));
const floatSpent = floatNearBefore - (await reads.nearBalance(floatId));
console.log("\nmode    expected  got       time  deposit tx                                    delivery or refund tx");
for (const r of results) {
  console.log(`${r.mode.padEnd(8)}${r.expected.padEnd(10)}${r.status.padEnd(10)}${`${r.seconds} s`.padEnd(6)}${r.depositTx.padEnd(46)}${r.settleTx ?? "-"}`);
}
console.log(`\nNEAR spent: keeper ${nearText(keeperSpent)}, float ${nearText(floatSpent)}`);
const reportFile = `${stateDir}live-near-${stamp}-report.json`;
const report = { ranAt: new Date().toISOString(), recipient: RECIPIENT, keeper: keeperId, float: floatId, results, nearSpent: { keeper: keeperSpent.toString(), float: floatSpent.toString() } };
writeFileSync(reportFile, JSON.stringify(report, null, 1));
console.log(`report: ${reportFile}`);
process.exit(results.length === MODES.length && results.every((r) => r.ok) ? 0 : 1);
