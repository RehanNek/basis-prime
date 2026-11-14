// Closes the Hyperliquid testnet float's position in a coin with a reduce-only IOC order (INTERFACES.md 12).
//
//   pnpm --filter @pb/oneclick-shim float:close -- --coin BTC [--slippage-bp 50] [--price 76000]
//
// The limit is --slippage-bp past the mark (50 bp by default), or --price. Reduce-only can't add to the position, so
// a close needs no --yes. Testnet only; the key stays in this process.
import { parseArgs } from "node:util";

import { cliArgs, closeOrder, DEFAULT_CLOSE_SLIPPAGE_BP, fail, findCoin, FloatError, floatPosition, log, startTool, statusWords } from "./float-kit.js";

const clients = startTool();
const { values } = parseArgs({
  args: cliArgs(process.argv.slice(2)),
  options: { coin: { type: "string" }, "slippage-bp": { type: "string", default: String(DEFAULT_CLOSE_SLIPPAGE_BP) }, price: { type: "string" } },
});
const slippageBp = Number(values["slippage-bp"]);
if (!values.coin) fail("give --coin (and optionally --slippage-bp or --price)", 2);
if (!Number.isInteger(slippageBp) || slippageBp < 1 || slippageBp > 500) fail("--slippage-bp must be a whole number from 1 to 500", 2);

try {
  const coin = findCoin(await clients.info.metaAndAssetCtxs(), values.coin);
  const before = await floatPosition(clients, coin.name);
  log(`float ${clients.user}: ${before.accountValue} USDC in perps, ${coin.name} position ${before.szi}${before.entryPx ? ` from ${before.entryPx}` : ""}`);
  if (Number(before.szi) === 0) {
    log(`nothing to close in ${coin.name}`);
    process.exit(0);
  }
  const checked = closeOrder({ coin, szi: before.szi, slippageBp, price: values.price });
  log(`${checked.words}; mark ${coin.markPx}`);
  const answer = await clients.exchange.order({ orders: [checked.order], grouping: "na" });
  for (const status of answer.response.data.statuses) log(`Hyperliquid: ${statusWords(status)}`);
  const after = await floatPosition(clients, coin.name);
  log(`now ${after.accountValue} USDC in perps, ${coin.name} position ${after.szi}`);
} catch (error) {
  if (error instanceof FloatError) fail(error.message, 2);
  fail(`Hyperliquid refused or failed: ${error instanceof Error ? error.message : String(error)}`);
}
