// The credit check (INTERFACES.md 18 and 22): what our pool would lend against any mainnet Hyperliquid address, or a
// what-if book, plus a few spot tokens, next to what Rhea alone would lend. No wallet, no account: pb-risk runs in its
// `credit_check` mode over OutLayer's HTTPS API, paid by our key, reads mainnet, and signs and pays nothing there.
//
//   POST /api/credit-check           {hl_address?, book?, spot?} -> {result, run, program, output_sha256, attestation, ...}
//   GET  /api/credit-check/example   the worked example of PLAN.md 6.9 at today's BTC price, for the page's button
//
// Each run costs money, so: at most 6 a minute in all and 2 per client address, and identical inputs share one result for
// 60 s (a shared result costs no run and counts against no limit). The program is the pb-risk version the factory pins
// for new accounts (its get_config), as /api/preview runs the version an account pins.
import { createHash } from "node:crypto";

import type { Deps } from "./handlers.js";
import { MAINNET_TOKENS, isSpotToken, SPOT_TOKENS, type SpotToken } from "./mainnet.js";
import { NotDeployedError } from "./rpc.js";
import { asObject, badRequest, HttpError, isU128 } from "./validate.js";

/** INTERFACES.md 22: identical inputs share one result for this long. */
export const CREDIT_SHARE_MS = 60_000;
/** INTERFACES.md 18: at most 5 spot entries. */
export const MAX_SPOT = 5;
/** A what-if book: at most this many positions (the allow-list has 23 coins, and a few others show UNLISTED). */
export const MAX_POSITIONS = 25;
/** $1B in micro-USD: more than any book this page is for. */
const MAX_MICRO_USD = 10n ** 15n;
/** The worked example's BTC price is read again after this long. */
export const EXAMPLE_PRICE_MS = 60_000;

const HL_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Hyperliquid's main-dex perp names: BTC, ETH, kPEPE. */
const COIN = /^[A-Za-z0-9]{1,16}$/;
const MICRO_USD = /^(0|[1-9]\d{0,15})$/;
const SIGNED_MICRO_USD = /^-?[1-9]\d{0,15}$/;
const PROJECT_ID = /^[a-z\d._-]+\/[a-z\d._-]+$/;

export interface CreditBook {
  usdc: string;
  positions: { coin: string; usd: string }[];
}

/** pb-risk's credit_check input, less the mode and network (INTERFACES.md 18). */
export interface CreditInput {
  hl_address: string | null;
  book: CreditBook | null;
  spot: { token: SpotToken; amount: string }[];
}

/** Checks the body and puts it in one order, so the same question asked twice is the same key. */
export function parseCreditInput(body: unknown): CreditInput {
  const fields = asObject(body);
  const hasAddress = fields.hl_address !== undefined && fields.hl_address !== null && fields.hl_address !== "";
  const hasBook = fields.book !== undefined && fields.book !== null;
  if (hasAddress === hasBook) throw badRequest("Give exactly one of hl_address (a Hyperliquid address) and book (a what-if book)");

  let hl_address: string | null = null;
  if (hasAddress) {
    if (typeof fields.hl_address !== "string" || !HL_ADDRESS.test(fields.hl_address.trim())) {
      throw badRequest("hl_address must be a Hyperliquid address: 0x and 40 hex characters");
    }
    hl_address = fields.hl_address.trim().toLowerCase();
  }

  let book: CreditBook | null = null;
  if (hasBook) {
    const b = asObject(fields.book);
    if (typeof b.usdc !== "string" || !MICRO_USD.test(b.usdc) || BigInt(b.usdc) > MAX_MICRO_USD) {
      throw badRequest("book.usdc must be the USDC margin in micro-USD, as a whole number in a string, at most $1B");
    }
    if (!Array.isArray(b.positions) || b.positions.length > MAX_POSITIONS) throw badRequest(`book.positions must be a list of at most ${MAX_POSITIONS} positions`);
    const seen = new Set<string>();
    const positions = b.positions.map((raw, i) => {
      const p = asObject(raw);
      if (typeof p.coin !== "string" || !COIN.test(p.coin)) throw badRequest(`book.positions[${i}].coin must be a Hyperliquid coin name, like BTC`);
      if (seen.has(p.coin)) throw badRequest(`book.positions has ${p.coin} twice`);
      seen.add(p.coin);
      if (typeof p.usd !== "string" || !SIGNED_MICRO_USD.test(p.usd) || (BigInt(p.usd) < 0n ? -BigInt(p.usd) : BigInt(p.usd)) > MAX_MICRO_USD) {
        throw badRequest(`book.positions[${i}].usd must be the position at the mark in micro-USD, negative for a short, not 0, at most $1B`);
      }
      return { coin: p.coin, usd: p.usd };
    });
    positions.sort((x, y) => (x.coin < y.coin ? -1 : x.coin > y.coin ? 1 : 0));
    book = { usdc: b.usdc, positions };
  }

  const rawSpot = fields.spot ?? [];
  if (!Array.isArray(rawSpot) || rawSpot.length > MAX_SPOT) throw badRequest(`spot must be a list of at most ${MAX_SPOT} entries`);
  const tokens = new Set<string>();
  const spot = rawSpot.map((raw, i) => {
    const s = asObject(raw);
    if (!isSpotToken(s.token)) throw badRequest(`spot[${i}].token must be one of ${SPOT_TOKENS.join(", ")}`);
    if (tokens.has(s.token)) throw badRequest(`spot has ${s.token} twice`);
    tokens.add(s.token);
    if (!isU128(s.amount) || s.amount === "0") throw badRequest(`spot[${i}].amount must be a positive whole number of the mainnet token's units, as a string`);
    return { token: s.token, amount: s.amount };
  });
  spot.sort((x, y) => SPOT_TOKENS.indexOf(x.token) - SPOT_TOKENS.indexOf(y.token));
  return { hl_address, book, spot };
}

/** JSON with every object's keys sorted and no spaces: the form OutLayer's HTTPS API answers in (INTERFACES.md 6). */
export function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * SHA-256 of the sorted form of a parsed result. It equals the attestation's output_hash when the result holds no
 * fractions (a parsed 82310.0 prints as 82310); the run's own text, kept as written (canonical.ts), is used first.
 */
export function outputHash(output: unknown): string {
  return createHash("sha256").update(sortedJson(output)).digest("hex");
}

export interface AttestationCheck {
  found: boolean;
  wasm_hash: string | null;
  output_hash: string | null;
  input_hash: string | null;
  timestamp: number | null;
  /** The attestation's wasm is the version the factory pins. */
  wasm_matches: boolean | null;
  /** Its output_hash is the SHA-256 of the result we show. */
  output_matches: boolean | null;
  error: string | null;
}

export interface CreditAnswer {
  input: CreditInput;
  result: unknown;
  run: { call_id: string | null; attestation_url: string | null; time_ms: number | null; compute_cost: string | null };
  program: { project_id: string; version_key: string | null };
  output_sha256: string;
  attestation: AttestationCheck;
  computed_at_ms: number;
}

/** The pb-risk build the factory pins for new accounts: get_config().risk. */
async function factoryRiskPin(deps: Deps): Promise<{ project: string; versionKey: string | null }> {
  const { ids } = deps.config;
  let config: { risk?: { project_id?: unknown; version_key?: unknown } } | null;
  try {
    config = (await deps.chain.view<typeof config>(ids.factory, "get_config")).value;
  } catch (error) {
    if (error instanceof NotDeployedError) throw new HttpError(503, "not_deployed", `The factory ${ids.factory} isn't live, so there is no pinned pb-risk to run (${error.reason})`);
    throw error;
  }
  const project = typeof config?.risk?.project_id === "string" ? config.risk.project_id : ids.riskProject;
  if (!PROJECT_ID.test(project) || project !== ids.riskProject) {
    throw new HttpError(409, "bad_config", `The factory pins ${project}, not our pb-risk ${ids.riskProject}`);
  }
  const versionKey = typeof config?.risk?.version_key === "string" && config.risk.version_key ? config.risk.version_key : null;
  return { project, versionKey };
}

/** The run's attestation record, read once, compared with what we show. Never fails: a problem is in `error`. */
async function checkAttestation(deps: Deps, url: string | null, versionKey: string | null, sha: string): Promise<AttestationCheck> {
  const none = (error: string): AttestationCheck => ({ found: false, wasm_hash: null, output_hash: null, input_hash: null, timestamp: null, wasm_matches: null, output_matches: null, error });
  if (!url) return none("OutLayer gave no attestation link for this run");
  // Only OutLayer's own host: the link came back from OutLayer, but we never fetch anywhere else with it.
  if (new URL(url).host !== new URL(deps.config.outlayerApiUrl).host) return none("The attestation link isn't on OutLayer's API host, so it wasn't read");
  if (!deps.attestations) return none("Reading attestations is off here");
  try {
    const record = (await deps.attestations(url)) as Record<string, unknown> | null;
    if (!record || typeof record !== "object") return none("OutLayer answered no attestation record yet");
    const text = (k: string) => (typeof record[k] === "string" ? (record[k] as string).toLowerCase() : null);
    const wasm = text("wasm_hash") ?? text("executed_wasm_sha256");
    const out = text("output_hash");
    return {
      found: true,
      wasm_hash: wasm,
      output_hash: out,
      input_hash: text("input_hash"),
      timestamp: typeof record.timestamp === "number" ? record.timestamp : null,
      wasm_matches: wasm && versionKey ? wasm === versionKey.toLowerCase() : null,
      output_matches: out ? out === sha : null,
      error: null,
    };
  } catch (error) {
    return none(`The attestation could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * POST /api/credit-check. `client` is the caller's address, for the per-client limit. A shared result answers with
 * `cached: true` and its age. pb-risk's own refusals ({"ok":false,"reason"}) are results, with HTTP 200, as in previews.
 */
export async function postCreditCheck(deps: Deps, body: unknown, client: string) {
  const input = parseCreditInput(body);
  const key = JSON.stringify(input);
  const now = deps.now();
  const shared = deps.creditResults?.get(key, now);
  if (shared) {
    const answer = await shared.value;
    return { ...answer, cached: true, age_s: Math.max(0, Math.round((now - shared.at) / 1000)) };
  }

  const outlayer = deps.outlayer;
  if (!outlayer) throw new HttpError(503, "credit_off", "Credit checks are off: OUTLAYER_PAYMENT_KEY is empty in the backend's environment");
  const { creditChecks, creditPerClient } = deps.limits;
  if (creditPerClient && !creditPerClient.available(client)) {
    throw new HttpError(429, "too_many_for_you", "At most 2 new credit checks a minute from one address (each one is a paid run); a repeat of the same check within a minute is free");
  }
  if (creditChecks && !creditChecks.available()) throw new HttpError(429, "too_many_credit_checks", "At most 6 new credit checks a minute in all; try again shortly");
  // Both limits passed: only now is either one used. Nothing is awaited between the look in the cache and keeping the
  // run there, so the same check asked twice at once makes one run.
  creditPerClient?.take(client);
  creditChecks?.take();

  const run = (async (): Promise<CreditAnswer> => {
    const pin = await factoryRiskPin(deps);
    const sent = { mode: "credit_check", network: "mainnet", ...input, snapshot: false };
    const result = await outlayer.run(pin.project, sent, pin.versionKey ?? undefined);
    if (result.status !== "completed") throw new HttpError(502, "outlayer_run", `pb-risk did not complete: ${result.error ?? result.status}`);
    const sha = result.outputSha256 ?? outputHash(result.output);
    return {
      input,
      result: result.output,
      run: { call_id: result.callId, attestation_url: result.attestationUrl, time_ms: result.timeMs, compute_cost: result.computeCost },
      program: { project_id: pin.project, version_key: pin.versionKey },
      output_sha256: sha,
      attestation: await checkAttestation(deps, result.attestationUrl, pin.versionKey, sha),
      computed_at_ms: deps.now(),
    };
  })();
  const answer = await (deps.creditResults ? deps.creditResults.set(key, now, run) : run);
  return { ...answer, cached: false, age_s: 0 };
}

// ---------- the worked example ----------

/** PLAN.md 6.9: $100k of nBTC, a $100k BTC short and $35k of USDC margin on Hyperliquid. */
export const EXAMPLE = { usdcMicro: 35_000_000_000n, shortMicro: 100_000_000_000n, nbtcMicro: 100_000_000_000n } as const;

/** "75711.6" -> 75711600000 micro-USD, or null for anything but a plain positive decimal. */
export function priceMicro(text: unknown): bigint | null {
  if (typeof text !== "string") return null;
  const m = /^(\d{1,9})(?:\.(\d{1,12}))?$/.exec(text.trim());
  if (!m) return null;
  const value = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0").slice(0, 6) || "0");
  return value > 0n ? value : null;
}

/** nBTC worth `usdMicro` at `btcMicro` per BTC, in nBTC's 8-decimal units, rounded down. */
export function nbtcUnits(usdMicro: bigint, btcMicro: bigint): bigint {
  return (usdMicro * 10n ** BigInt(MAINNET_TOKENS.nBTC.decimals)) / btcMicro;
}

export interface ExampleAnswer {
  book: CreditBook;
  spot: { token: SpotToken; amount: string }[];
  btc_usd: string;
  price_source: string;
  read_at_ms: number;
}

/**
 * GET /api/credit-check/example: the worked example as a request body, with the nBTC sized at today's BTC price.
 * The price is Hyperliquid mainnet's oracle price for BTC (metaAndAssetCtxs, read by name), kept for a minute.
 */
export async function getCreditExample(deps: Deps): Promise<ExampleAnswer> {
  const hl = deps.hlMainnet;
  if (!hl) throw new HttpError(503, "example_off", "Reading Hyperliquid mainnet is off here");
  const now = deps.now();
  const read = async (): Promise<ExampleAnswer> => {
    const [meta, ctxs] = await hl.info<[{ universe: { name: string }[] }, { oraclePx?: string }[]]>({ type: "metaAndAssetCtxs" });
    const i = meta.universe.findIndex((u) => u.name === "BTC");
    const px = i >= 0 ? priceMicro(ctxs[i]?.oraclePx) : null;
    if (!px) throw new HttpError(502, "hyperliquid", "Hyperliquid mainnet's answer had no BTC oracle price");
    return {
      book: { usdc: EXAMPLE.usdcMicro.toString(), positions: [{ coin: "BTC", usd: (-EXAMPLE.shortMicro).toString() }] },
      spot: [{ token: "nBTC", amount: nbtcUnits(EXAMPLE.nbtcMicro, px).toString() }],
      btc_usd: ctxs[i]!.oraclePx!,
      price_source: "Hyperliquid mainnet's oracle price",
      read_at_ms: now,
    };
  };
  const hit = deps.examplePrice?.get("BTC", now);
  if (hit) return hit.value;
  return deps.examplePrice ? deps.examplePrice.set("BTC", now, read()) : read();
}
