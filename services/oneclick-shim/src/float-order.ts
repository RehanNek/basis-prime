// Places one limit order from the Hyperliquid testnet float, to post the other side of a demo trade on testnet's
// thin book (INTERFACES.md 12).
//
//   pnpm --filter @pb/oneclick-shim float:order -- --coin BTC --side buy --size 0.0002 --price 75000 [--tif Gtc] [--reduce-only] [--yes]
//
// --tif is Gtc (rest on the book, the default), Ioc (fill now or cancel) or Alo (only add liquidity). Orders above
// $100 need --yes. Testnet only; the key stays in this process.
import { parseArgs } from "node:util";

import { checkOrder, cliArgs, fail, findCoin, FloatError, floatPosition, log, startTool, statusWords, TIFS, type Side, type Tif } from "./float-kit.js";

const clients = startTool();
const { values } = parseArgs({
  args: cliArgs(process.argv.slice(2)),
  options: {
    coin: { type: "string" },
    side: { type: "string" },
    size: { type: "string" },
    price: { type: "string" },
    tif: { type: "string", default: "Gtc" },
    "reduce-only": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  },
});
if (!values.coin || !values.size || !values.price || (values.side !== "buy" && values.side !== "sell")) {
  fail("give --coin, --side buy|sell, --size and --price (and --tif Gtc|Ioc|Alo)", 2);
}
if (!TIFS.includes(values.tif as Tif)) fail(`--tif must be one of ${TIFS.join(", ")}`, 2);

try {
  const coin = findCoin(await clients.info.metaAndAssetCtxs(), values.coin);
  const checked = checkOrder({
    coin,
    side: values.side as Side,
    size: values.size,
    price: values.price,
    tif: values.tif as Tif,
    reduceOnly: values["reduce-only"],
    yes: values.yes,
  });
  const before = await floatPosition(clients, coin.name);
  log(`float ${clients.user} on ${new URL(clients.apiUrl).host}: ${before.accountValue} USDC in perps, ${coin.name} position ${before.szi}`);
  log(`${checked.words}; ${coin.name} mark ${coin.markPx}`);
  const answer = await clients.exchange.order({ orders: [checked.order], grouping: "na" });
  for (const status of answer.response.data.statuses) log(`Hyperliquid: ${statusWords(status)}`);
  const after = await floatPosition(clients, coin.name);
  log(`now ${after.accountValue} USDC in perps, ${coin.name} position ${after.szi}`);
} catch (error) {
  if (error instanceof FloatError) fail(error.message, 2);
  // The SDK throws ApiRequestError when Hyperliquid refuses; its message is Hyperliquid's own words.
  fail(`Hyperliquid refused or failed: ${error instanceof Error ? error.message : String(error)}`);
}
