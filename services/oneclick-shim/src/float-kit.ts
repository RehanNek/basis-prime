// What the testnet float tools share (INTERFACES.md 12): float:order, float:cancel and float:close trade from the
// stand-in's Hyperliquid float, so it can post the other side of a demo trade on testnet's thin book
// (research/day1.md 12). Testnet only: each refuses an HL_API_URL that isn't Hyperliquid testnet's. Each loads the
// repo's .env itself, and the key stays inside the process: nothing here prints it.
//
// Orders are limit orders in Hyperliquid's own terms (@nktkas/hyperliquid 0.33.3, exchange order(): a = asset,
// b = is buy, p = price, s = size, r = reduce-only, t = {limit: {tif}}). Prices and sizes must already follow
// Hyperliquid's tick and lot rules (for-developers/api/tick-and-lot-size): a size has at most szDecimals decimals;
// a price at most 5 significant figures and 6 - szDecimals decimals, and an integer price is always fine. A tool
// refuses an unrounded value and says the rounded one, as the gateway does, rather than rounding it silently.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";

import { TESTNET_HL_API } from "./config.js";
import { localWallet } from "./hl-wallet.js";

export type Side = "buy" | "sell";
export type Tif = "Gtc" | "Ioc" | "Alo";
export const TIFS: Tif[] = ["Gtc", "Ioc", "Alo"];

/** Hyperliquid's minimum order value. */
export const MIN_NOTIONAL_USD = 10;
/** Above this, a tool asks for --yes: the float's USDC is needed for the demo. */
export const CONFIRM_ABOVE_USD = 100;
/** float:close's default limit: this far past the mark, so the reduce-only IOC order fills. */
export const DEFAULT_CLOSE_SLIPPAGE_BP = 50;

export class FloatError extends Error {}

/** The repo's .env: from services/oneclick-shim/dist (or src) up three folders. */
export const ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));

/** Loads .env into process.env (values already set win, as with node --env-file). Returns whether it was there. */
export function loadDotEnv(file = ENV_FILE): boolean {
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}

/** HL_API_URL, which must be Hyperliquid testnet's. */
export function testnetApiUrl(env: Record<string, string | undefined>): string {
  const url = env.HL_API_URL?.trim() || TESTNET_HL_API;
  if (!new URL(url).hostname.includes("testnet")) throw new FloatError(`refusing: ${url} is not Hyperliquid testnet`);
  return url;
}

export interface CoinInfo {
  name: string;
  /** Read from testnet's meta by name: asset numbers differ between networks (research/day1.md 12). */
  asset: number;
  szDecimals: number;
  markPx: string;
}

type Meta = [{ universe: { name: string; szDecimals: number; isDelisted?: boolean }[] }, { markPx: string }[]];

export function findCoin(meta: Meta, coin: string): CoinInfo {
  const [{ universe }, ctxs] = meta;
  const asset = universe.findIndex((u) => u.name === coin);
  if (asset < 0) throw new FloatError(`${coin} isn't listed on Hyperliquid testnet`);
  const entry = universe[asset]!;
  if (entry.isDelisted) throw new FloatError(`${coin} is delisted on Hyperliquid testnet`);
  const markPx = ctxs[asset]?.markPx;
  if (!markPx) throw new FloatError(`Hyperliquid testnet has no mark price for ${coin}`);
  return { name: coin, asset, szDecimals: entry.szDecimals, markPx };
}

/** A plain decimal, written the way Hyperliquid writes it: no trailing zeros, no exponent. */
export function canonical(text: string): string {
  const clean = text.trim();
  if (!/^\d+(\.\d+)?$/.test(clean) && !/^\.\d+$/.test(clean)) throw new FloatError(`not a plain positive number: "${text}"`);
  const [whole = "0", fraction = ""] = clean.split(".");
  const intPart = whole.replace(/^0+(?=\d)/, "") || "0";
  const frac = fraction.replace(/0+$/, "");
  return frac ? `${intPart}.${frac}` : intPart;
}

export interface OrderWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: Tif } };
}

export interface CheckedOrder {
  order: OrderWire;
  notional: number;
  words: string;
}

/** Builds one limit order, refusing what Hyperliquid would refuse and asking for --yes above $100. */
export function checkOrder(input: { coin: CoinInfo; side: Side; size: string; price: string; tif: Tif; reduceOnly: boolean; yes: boolean }): CheckedOrder {
  const { coin, side, tif, reduceOnly } = input;
  const size = canonical(input.size);
  const price = canonical(input.price);
  const roundedSize = formatSize(size, coin.szDecimals);
  if (roundedSize !== size) throw new FloatError(`${coin.name} sizes have at most ${coin.szDecimals} decimals: use ${roundedSize}`);
  const roundedPrice = formatPrice(price, coin.szDecimals);
  if (roundedPrice !== price) throw new FloatError(`${price} isn't a valid ${coin.name} price (5 significant figures, at most ${Math.max(6 - coin.szDecimals, 0)} decimals): use ${roundedPrice}`);
  if (!TIFS.includes(tif)) throw new FloatError(`tif must be one of ${TIFS.join(", ")}`);
  const notional = Number(size) * Number(price);
  if (notional < MIN_NOTIONAL_USD) throw new FloatError(`the order is worth $${notional.toFixed(2)}; Hyperliquid's minimum is $${MIN_NOTIONAL_USD}`);
  if (notional > CONFIRM_ABOVE_USD && !input.yes) {
    throw new FloatError(`the order is worth $${notional.toFixed(2)}, above $${CONFIRM_ABOVE_USD}: add --yes to send it from the float`);
  }
  const words = `${side} ${size} ${coin.name} at ${price} (${tif}${reduceOnly ? ", reduce-only" : ""}), worth $${notional.toFixed(2)}`;
  return { order: { a: coin.asset, b: side === "buy", p: price, s: size, r: reduceOnly, t: { limit: { tif } } }, notional, words };
}

/**
 * The order that closes the float's position in a coin: reduce-only, IOC, for the whole size, with a limit
 * `slippageBp` past the mark (or `price`, if given), so it fills now or not at all. Reduce-only can't add risk, so
 * it needs no --yes.
 */
export function closeOrder(input: { coin: CoinInfo; szi: string; slippageBp: number; price?: string }): CheckedOrder {
  const held = Number(input.szi);
  if (!Number.isFinite(held) || held === 0) throw new FloatError(`the float holds no ${input.coin.name} position`);
  const side: Side = held < 0 ? "buy" : "sell";
  const mark = Number(input.coin.markPx);
  const target = input.price ?? String(side === "buy" ? mark * (1 + input.slippageBp / 10_000) : mark * (1 - input.slippageBp / 10_000));
  const price = formatPrice(target, input.coin.szDecimals);
  const size = formatSize(String(Math.abs(held)), input.coin.szDecimals);
  return checkOrder({ coin: input.coin, side, size, price, tif: "Ioc", reduceOnly: true, yes: true });
}

/** One status of an order answer, in words. */
export function statusWords(status: unknown): string {
  if (status && typeof status === "object") {
    const s = status as { resting?: { oid: number }; filled?: { totalSz: string; avgPx: string; oid: number }; error?: string };
    if (s.resting) return `resting, oid ${s.resting.oid}`;
    if (s.filled) return `filled ${s.filled.totalSz} at ${s.filled.avgPx}, oid ${s.filled.oid}`;
    if (s.error) return `refused: ${s.error}`;
  }
  return String(status);
}

/** `pnpm ... float:x -- --a 1` passes the "--" on; drop it. */
export function cliArgs(argv: string[]): string[] {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

export const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} float: ${line}`);

export function fail(message: string, code = 1): never {
  console.error(`float: ${message}`);
  process.exit(code);
}

/** The float's clients. Reads HL_FLOAT_ADDRESS and HL_FLOAT_PRIVATE_KEY from the environment; prints neither key nor secret. */
export function floatClients(env: Record<string, string | undefined>) {
  const apiUrl = testnetApiUrl(env);
  const address = env.HL_FLOAT_ADDRESS?.trim().toLowerCase();
  const key = env.HL_FLOAT_PRIVATE_KEY?.trim();
  if (!address || !key) throw new FloatError("HL_FLOAT_ADDRESS or HL_FLOAT_PRIVATE_KEY is empty in .env");
  const wallet = localWallet(key);
  if (wallet.address !== address) throw new FloatError("HL_FLOAT_PRIVATE_KEY does not belong to HL_FLOAT_ADDRESS");
  const transport = new HttpTransport({ isTestnet: true, apiUrl });
  return {
    apiUrl,
    user: address as `0x${string}`,
    info: new InfoClient({ transport }),
    // signatureChainId 0x66eee, as the Python SDK uses (research/hyperliquid.md 1). Orders and cancels are L1
    // actions, signed with source "b" on testnet (isTestnet).
    exchange: new ExchangeClient({ transport, wallet, signatureChainId: "0x66eee" }),
  };
}

/** Starts a tool: .env, then the clients; a FloatError ends it with its words. */
export function startTool(): ReturnType<typeof floatClients> {
  loadDotEnv();
  try {
    return floatClients(process.env);
  } catch (error) {
    if (error instanceof FloatError) fail(error.message, 2);
    throw error;
  }
}

/** The float's USDC in perps and its position in a coin (0 when it has none). */
export async function floatPosition(clients: ReturnType<typeof floatClients>, coin: string) {
  const state = await clients.info.clearinghouseState({ user: clients.user });
  const position = state.assetPositions.find((p) => p.position.coin === coin)?.position;
  return { accountValue: state.marginSummary.accountValue, szi: position?.szi ?? "0", entryPx: position?.entryPx ?? null, unrealizedPnl: position?.unrealizedPnl ?? "0" };
}
