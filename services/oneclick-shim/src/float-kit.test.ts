// The float tools' pure parts: testnet only, coins by name, Hyperliquid's tick and lot rules, and the close order.
import assert from "node:assert/strict";
import { test } from "node:test";

import { canonical, checkOrder, closeOrder, findCoin, FloatError, floatClients, statusWords, testnetApiUrl } from "./float-kit.js";

/** A slice of testnet's metaAndAssetCtxs (8 Nov): SOL is asset 0 and BTC asset 3 there, unlike mainnet. */
const META = [
  { universe: [{ name: "SOL", szDecimals: 2 }, { name: "APT", szDecimals: 2 }, { name: "ZEC", szDecimals: 0, isDelisted: true }, { name: "BTC", szDecimals: 5 }] },
  [{ markPx: "89.437" }, { markPx: "4.1" }, { markPx: "138.65" }, { markPx: "75824.0" }],
] as Parameters<typeof findCoin>[0];
const BTC = findCoin(META, "BTC");

test("testnet only: a mainnet or other HL_API_URL is refused before anything else", () => {
  assert.equal(testnetApiUrl({}), "https://api.hyperliquid-testnet.xyz");
  assert.throws(() => testnetApiUrl({ HL_API_URL: "https://api.hyperliquid.xyz" }), /refusing: .* is not Hyperliquid testnet/);
  assert.throws(() => floatClients({ HL_API_URL: "https://api.hyperliquid.xyz", HL_FLOAT_ADDRESS: "0x1", HL_FLOAT_PRIVATE_KEY: "0x2" }), FloatError);
  assert.throws(() => floatClients({}), /HL_FLOAT_ADDRESS or HL_FLOAT_PRIVATE_KEY is empty/);
});

test("a key that isn't the float's is refused, and the message names neither", () => {
  const key = `0x${"01".repeat(32)}`;
  assert.throws(
    () => floatClients({ HL_FLOAT_ADDRESS: "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d", HL_FLOAT_PRIVATE_KEY: key }),
    (error: unknown) => error instanceof FloatError && !error.message.includes("0101") && /does not belong/.test(error.message),
  );
});

test("coins are found by name in testnet's meta; a missing or delisted coin is refused", () => {
  assert.deepEqual(BTC, { name: "BTC", asset: 3, szDecimals: 5, markPx: "75824.0" });
  assert.equal(findCoin(META, "SOL").asset, 0);
  assert.throws(() => findCoin(META, "XRP"), /isn't listed on Hyperliquid testnet/);
  assert.throws(() => findCoin(META, "ZEC"), /delisted/);
});

test("an order follows the tick and lot rules, or is refused with the rounded value", () => {
  const order = checkOrder({ coin: BTC, side: "buy", size: "0.00020", price: "75000.0", tif: "Gtc", reduceOnly: false, yes: false });
  assert.deepEqual(order.order, { a: 3, b: true, p: "75000", s: "0.0002", r: false, t: { limit: { tif: "Gtc" } } });
  assert.equal(order.notional, 15);
  assert.match(order.words, /buy 0\.0002 BTC at 75000 \(Gtc\), worth \$15\.00/);

  assert.throws(() => checkOrder({ coin: BTC, side: "buy", size: "0.000201", price: "75000", tif: "Gtc", reduceOnly: false, yes: false }), /at most 5 decimals: use 0\.0002$/);
  assert.throws(() => checkOrder({ coin: BTC, side: "buy", size: "0.0002", price: "75000.5", tif: "Gtc", reduceOnly: false, yes: false }), /use 75000$/);
  const sol = findCoin(META, "SOL");
  assert.equal(checkOrder({ coin: sol, side: "sell", size: "0.2", price: "89.437", tif: "Alo", reduceOnly: true, yes: false }).order.p, "89.437");
  assert.throws(() => checkOrder({ coin: sol, side: "sell", size: "0.2", price: "89.4375", tif: "Alo", reduceOnly: false, yes: false }), /use 89\.437$/);
});

test("an order below Hyperliquid's $10, or above $100 without --yes, is refused", () => {
  assert.throws(() => checkOrder({ coin: BTC, side: "sell", size: "0.0001", price: "75000", tif: "Ioc", reduceOnly: false, yes: false }), /worth \$7\.50; Hyperliquid's minimum is \$10/);
  assert.throws(() => checkOrder({ coin: BTC, side: "sell", size: "0.002", price: "75000", tif: "Ioc", reduceOnly: false, yes: false }), /\$150\.00, above \$100: add --yes/);
  assert.equal(checkOrder({ coin: BTC, side: "sell", size: "0.002", price: "75000", tif: "Ioc", reduceOnly: false, yes: true }).notional, 150);
  assert.throws(() => checkOrder({ coin: BTC, side: "sell", size: "-1", price: "75000", tif: "Ioc", reduceOnly: false, yes: true }), /not a plain positive number/);
});

test("closing: reduce-only IOC on the other side for the whole position, the limit past the mark", () => {
  const short = closeOrder({ coin: BTC, szi: "-0.00033", slippageBp: 50 });
  assert.deepEqual(short.order, { a: 3, b: true, p: "76203", s: "0.00033", r: true, t: { limit: { tif: "Ioc" } } }, "75824 * 1.005 = 76203.12, cut to a whole price");
  const long = closeOrder({ coin: BTC, szi: "0.5", slippageBp: 50 });
  assert.equal(long.order.b, false);
  assert.equal(long.order.p, "75444", "75824 * 0.995 = 75444.88, cut down");
  assert.equal(closeOrder({ coin: BTC, szi: "-0.00033", slippageBp: 50, price: "76000" }).order.p, "76000");
  assert.throws(() => closeOrder({ coin: BTC, szi: "0.0", slippageBp: 50 }), /holds no BTC position/);
});

test("decimals are written as Hyperliquid writes them; order statuses read as words", () => {
  assert.equal(canonical("0075000.000"), "75000");
  assert.equal(canonical(".50"), "0.5");
  assert.equal(statusWords({ resting: { oid: 7 } }), "resting, oid 7");
  assert.equal(statusWords({ filled: { totalSz: "0.0002", avgPx: "75012", oid: 8 } }), "filled 0.0002 at 75012, oid 8");
  assert.equal(statusWords({ error: "Order must have minimum value of $10." }), "refused: Order must have minimum value of $10.");
});
