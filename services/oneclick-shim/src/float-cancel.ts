// Cancels resting orders of the Hyperliquid testnet float (INTERFACES.md 12).
//
//   pnpm --filter @pb/oneclick-shim float:cancel -- --coin BTC --oid 123
//   pnpm --filter @pb/oneclick-shim float:cancel -- --all [--coin BTC]
//
// Testnet only; the key stays in this process.
import { parseArgs } from "node:util";

import { cliArgs, fail, findCoin, FloatError, log, startTool, statusWords } from "./float-kit.js";

const clients = startTool();
const { values } = parseArgs({
  args: cliArgs(process.argv.slice(2)),
  options: { coin: { type: "string" }, oid: { type: "string" }, all: { type: "boolean", default: false } },
});
if (!values.all && (!values.coin || !values.oid || !/^\d+$/.test(values.oid))) fail("give --coin and --oid, or --all (optionally with --coin)", 2);

try {
  const meta = await clients.info.metaAndAssetCtxs();
  const open = await clients.info.openOrders({ user: clients.user });
  const chosen = values.all
    ? open.filter((o) => !values.coin || o.coin === values.coin)
    : open.filter((o) => o.coin === values.coin && o.oid === Number(values.oid));
  if (chosen.length === 0) {
    log(values.all ? `the float has no open orders${values.coin ? ` in ${values.coin}` : ""}` : `the float has no open ${values.coin} order ${values.oid}`);
    process.exit(0);
  }
  for (const o of chosen) log(`cancelling ${o.coin} ${o.side === "B" ? "buy" : "sell"} ${o.sz} at ${o.limitPx}, oid ${o.oid}`);
  const answer = await clients.exchange.cancel({ cancels: chosen.map((o) => ({ a: findCoin(meta, o.coin).asset, o: o.oid })) });
  for (const status of answer.response.data.statuses) log(`Hyperliquid: ${status === "success" ? "cancelled" : statusWords(status)}`);
  const left = await clients.info.openOrders({ user: clients.user });
  log(`the float has ${left.length} open order(s) left`);
} catch (error) {
  if (error instanceof FloatError) fail(error.message, 2);
  fail(`Hyperliquid refused or failed: ${error instanceof Error ? error.message : String(error)}`);
}
