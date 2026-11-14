// Rhea's price on testnet (FUNDING.md 7.1 and 9; research/rhea.md 12, "Our copy in the sandbox").
//
// Rhea runs no testnet, so we run a copy of its own contract file (rhea.pbf-ops.testnet). Mainnet Rhea reads prices
// from a live feed; our copy has none, so each token carries a fixed price inside the contract (the `default_price`
// of its price setting), which Rhea's code uses in place of the feed. The engine reads that same price. A fixed
// price goes stale as bitcoin moves, so on every tick the keeper compares the copy's BTC price with Hyperliquid's
// oracle price, which is what the engine itself counts bitcoin at, and sets it again when the two have drifted
// apart. Only the copy's owner can set a price: the keeper reads who that is and signs with that account's key (the
// operator's, OPERATOR_PRIVATE_KEY).
//
//   the band     0.25%: the copy's price is kept within this of Hyperliquid's oracle
//   it acts at   0.15%: a tick is 15 s, so acting before the edge keeps a move between two ticks inside the band
//
// The hold (testnet only). The Phase 6 gate has to show a top-up, which needs bitcoin to fall at Rhea, and the sync
// above would put any dropped price straight back. So a small file can put the price on hold a set distance from
// the oracle for a while: {"shift_bp": -1300, "until_ms": <unix ms>, "by": "<who>"}. While it is in force the keeper
// itself sets the copy's price to the oracle's less 13%, and keeps it within the same band of that level; when the
// hold ends, or is cleared, the price returns to the oracle. One writer, the keeper, so a script and the sync can't
// fight over the price. A hold lasts an hour at most, so a script that died can't leave the price wrong. It shows
// in the keeper's log (`rhea_price` lines, and `rhea_hold` on every tick) and in the backend's GET /api/keeper/:account.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Log } from "./jsonl.js";
import type { TxResult } from "./near-tx.js";

/** The copy's BTC price is kept within 0.25% of Hyperliquid's oracle price. */
export const RHEA_PRICE_BAND_BP = 25;
/** The keeper sets the price again once it is this far out: 0.15%. */
export const RHEA_PRICE_UPDATE_BP = 15;
/** Test nBTC has 8 decimals; the copy's price setting must say the same, or the keeper leaves it alone. */
export const NBTC_DECIMALS = 8;

/**
 * A token whose price the keeper keeps at our Rhea copy (INTERFACES.md 51.1): its id on NEAR, the Hyperliquid coin
 * whose oracle price it is kept at, and its own decimals, which the copy's price setting must repeat. Bitcoin was
 * the only one up to 14 Nov; test ETH (18 decimals, against ETH's oracle) is the second.
 */
export interface RheaToken {
  id: string;
  coin: "BTC" | "ETH";
  decimals: number;
}

/** How each coin is said in the log, and the range its oracle price must be in to be believed. */
const COINS: Record<RheaToken["coin"], { ticker: string; one: string; token: string; min: number; max: number }> = {
  BTC: { ticker: "BTC", one: "a bitcoin", token: "test nBTC", min: 1_000, max: 10_000_000 },
  ETH: { ticker: "ETH", one: "an ether", token: "test ETH", min: 50, max: 500_000 },
};

/** The pool's name for a token (the factory's `tokens[].symbol`) and the Hyperliquid coin it is priced as. */
const COIN_OF_SYMBOL: Record<string, RheaToken["coin"]> = { nBTC: "BTC", ETH: "ETH" };

/**
 * The tokens to keep, from the factory's settings: every id in `lenders.rhea.collateral` that the factory's own
 * token list names as bitcoin or ETH, with that list's decimals. A token of the list the keeper knows no Hyperliquid
 * price for is left alone, with the reason. A factory that can't be read, or lists nothing, gives bitcoin alone, as
 * before 51.1.
 */
export function rheaTokens(factoryConfig: unknown, bitcoinId: string): { tokens: RheaToken[]; left: { id: string; why: string }[] } {
  const bitcoin: RheaToken = { id: bitcoinId, coin: "BTC", decimals: NBTC_DECIMALS };
  const config = factoryConfig as { tokens?: unknown; lenders?: { rhea?: { collateral?: unknown } | null } | null } | null | undefined;
  const listed = Array.isArray(config?.lenders?.rhea?.collateral) ? (config.lenders.rhea.collateral as unknown[]).filter((id): id is string => typeof id === "string") : [];
  if (listed.length === 0) return { tokens: [bitcoin], left: [] };
  const known = Array.isArray(config?.tokens) ? (config.tokens as { id?: unknown; symbol?: unknown; decimals?: unknown }[]) : [];
  const tokens: RheaToken[] = [];
  const left: { id: string; why: string }[] = [];
  for (const id of [...new Set(listed)]) {
    const entry = known.find((t) => t?.id === id);
    const coin = typeof entry?.symbol === "string" ? COIN_OF_SYMBOL[entry.symbol] : undefined;
    if (!entry) left.push({ id, why: "the factory's token list doesn't name it" });
    else if (!coin) left.push({ id, why: `the keeper knows no Hyperliquid price to keep ${String(entry.symbol)} at` });
    else if (typeof entry.decimals !== "number" || !Number.isInteger(entry.decimals) || entry.decimals < 0 || entry.decimals > 24) left.push({ id, why: "the factory's token list gives it no decimals" });
    else tokens.push({ id, coin, decimals: entry.decimals });
  }
  return { tokens, left };
}
/** A hold keeps the price between 50% under and 10% over the oracle, for an hour at most. */
export const HOLD_MIN_SHIFT_BP = -5_000;
export const HOLD_MAX_SHIFT_BP = 1_000;
export const HOLD_MAX_MS = 60 * 60_000;
/** The same trouble is logged again only after this long. */
const SAY_AGAIN_MS = 5 * 60_000;
/** After an update that failed, the next try waits this long: a transaction that can only fail still costs gas. */
export const RETRY_FAILED_MS = 60_000;
/** Who owns the copy is read again this often. */
const OWNER_FOR_MS = 10 * 60_000;

/** Rhea's `TokenPythInfo` (burrowland's `pyth.rs`), as `get_token_pyth_info` answers it. */
export interface TokenPriceInfo {
  /** The token's own decimals. */
  decimals: number;
  fraction_digits: number;
  /** The Pyth feed's id, 64 hex digits. Unused while `default_price` is set, but the setting must carry one. */
  price_identifier: string;
  extra_call: string | null;
  /** One of the token's smallest units is worth `multiplier / 10^decimals` dollars (burrowland's `Price`). */
  default_price: { multiplier: string; decimals: number };
}

/** Reads `get_token_pyth_info`'s answer, or says in words why the keeper can't work with it. */
export function readPriceInfo(value: unknown, token: Pick<RheaToken, "coin" | "decimals"> = { coin: "BTC", decimals: NBTC_DECIMALS }): TokenPriceInfo | string {
  const name = COINS[token.coin].token;
  if (value === null || value === undefined) return `our Rhea copy has no price setting for ${name} yet`;
  const v = value as Record<string, unknown>;
  const whole = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;
  if (typeof v !== "object" || !whole(v.decimals) || !whole(v.fraction_digits) || typeof v.price_identifier !== "string") return `our Rhea copy's price setting for ${name} isn't in the shape Rhea's code writes`;
  if (v.decimals !== token.decimals) return `our Rhea copy's price setting says ${name} has ${v.decimals} decimals, not ${token.decimals}: the keeper leaves its price alone`;
  const fixed = v.default_price as { multiplier?: unknown; decimals?: unknown } | null | undefined;
  if (!fixed) return `our Rhea copy has no fixed price for ${name} (its default_price is empty), so there is nothing for the keeper to keep in step`;
  if (typeof fixed.multiplier !== "string" || !/^[1-9]\d{0,30}$/.test(fixed.multiplier) || !whole(fixed.decimals)) return `our Rhea copy's fixed price for ${name} isn't a price`;
  const digits = fixed.decimals - v.decimals;
  if (digits < 0 || digits > 8) return `our Rhea copy's fixed price for ${name} has ${fixed.decimals} decimals, which the keeper can't write a dollar price in`;
  return {
    decimals: v.decimals,
    fraction_digits: v.fraction_digits,
    price_identifier: v.price_identifier,
    extra_call: typeof v.extra_call === "string" ? v.extra_call : null,
    default_price: { multiplier: fixed.multiplier, decimals: fixed.decimals },
  };
}

/** Digits after the point in the fixed price: its decimals less the token's. Two on our copy, so the multiplier is cents. */
function priceDigits(info: TokenPriceInfo): number {
  return info.default_price.decimals - info.decimals;
}

/** What the copy counts one whole bitcoin at, in dollars. */
export function priceOf(info: TokenPriceInfo): number {
  return Number(info.default_price.multiplier) / 10 ** priceDigits(info);
}

/** `dollars` for one whole bitcoin as the fixed price's multiplier, rounded to its last digit. */
export function multiplierFor(info: TokenPriceInfo, dollars: number): string {
  if (!Number.isFinite(dollars) || dollars <= 0) throw new Error(`${dollars} isn't a price`);
  return BigInt(Math.round(dollars * 10 ** priceDigits(info))).toString();
}

/** How far `price` is from `target`, in basis points of the target. */
export function gapBp(price: number, target: number): number {
  return (Math.abs(price - target) / target) * 10_000;
}

export interface RheaCall {
  contract: string;
  method: string;
  args: Record<string, unknown>;
  /** yoctoNEAR. */
  deposit: bigint;
  tgas: number;
}

// =====================================================================================================================
// THE CALL. Everything the keeper ever sends to our Rhea copy is built here, and nowhere else.
//
//   update_token_pyth_info({"token_id": "<nbtc>", "token_pyth_info": {"decimals": 8, "fraction_digits": 2,
//     "price_identifier": "e62df6c8…415b43", "extra_call": null,
//     "default_price": {"multiplier": "<price in cents>", "decimals": 10}}})
//   with exactly 1 yoctoNEAR, signed by the copy's owner.
//
// It is research/rhea.md 12's "Changing BTC's price", proved in the sandbox against Rhea's own release file
// (contracts/tests/tests/rhea.rs; `Rhea::set_btc_price` in common/rhea.rs): the call replaces the token's whole
// setting, so all five fields go every time, as read from `get_token_pyth_info`, and only the multiplier is new. It
// burnt 2.7 TGas and returns nothing; anyone else gets "Not an owner", and without the yoctoNEAR "Requires attached
// deposit of exactly 1 yoctoNEAR". Rhea's source: github.com/ref-finance/burrowland at a479b83, contracts/contract/src/lib.rs.
// =====================================================================================================================
export function rheaPriceCall(rheaId: string, tokenId: string, info: TokenPriceInfo, dollars: number): RheaCall {
  return {
    contract: rheaId,
    method: "update_token_pyth_info",
    args: {
      token_id: tokenId,
      token_pyth_info: {
        decimals: info.decimals,
        fraction_digits: info.fraction_digits,
        price_identifier: info.price_identifier,
        extra_call: info.extra_call,
        default_price: { multiplier: multiplierFor(info, dollars), decimals: info.default_price.decimals },
      },
    },
    deposit: 1n,
    tgas: 30,
  };
}

// ---------- the hold ----------

export interface RheaHold {
  /** How far from the oracle the price is held, in bp: -1300 is 13% under it. */
  shift_bp: number;
  /** When it ends, unix ms. */
  until_ms: number;
  by?: string;
  /** The token whose price is held (INTERFACES.md 51.1). Left out, it is bitcoin's, as every hold was before. */
  token?: string;
}

/** The hold as it applies to one token: a hold with no name is bitcoin's, and a named one is that token's alone. */
export function holdFor(hold: RheaHold | null, tokenId: string, bitcoinId: string): RheaHold | null {
  return hold && (hold.token ?? bitcoinId) === tokenId ? hold : null;
}

/** What is wrong with a hold at `now`, or null. */
export function holdProblem(hold: RheaHold, now: number): string | null {
  if (!Number.isInteger(hold.shift_bp) || hold.shift_bp < HOLD_MIN_SHIFT_BP || hold.shift_bp > HOLD_MAX_SHIFT_BP) return `shift_bp must be a whole number from ${HOLD_MIN_SHIFT_BP} to ${HOLD_MAX_SHIFT_BP}`;
  if (!Number.isFinite(hold.until_ms) || hold.until_ms - now > HOLD_MAX_MS) return "a hold lasts an hour at most";
  if (hold.token !== undefined && (typeof hold.token !== "string" || !/^([a-z\d]+[-_.])*[a-z\d]+$/.test(hold.token) || hold.token.length > 64)) return "token must be the id of the token whose price is held";
  return null;
}

/** The hold in force at `now`: the file's, if it is well formed, moves the price, and hasn't ended. Else null. */
export function readHold(file: string, now: number): RheaHold | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; // no file, or not JSON: no hold
  }
  const h = parsed as { shift_bp?: unknown; until_ms?: unknown; by?: unknown; token?: unknown } | null;
  if (!h || typeof h.shift_bp !== "number" || typeof h.until_ms !== "number") return null;
  // A name that isn't a string names no token: such a hold is nobody's, not bitcoin's.
  if (h.token !== undefined && typeof h.token !== "string") return null;
  const hold: RheaHold = { shift_bp: h.shift_bp, until_ms: h.until_ms, ...(typeof h.by === "string" ? { by: h.by.slice(0, 120) } : {}), ...(typeof h.token === "string" ? { token: h.token } : {}) };
  if (hold.shift_bp === 0 || hold.until_ms <= now || holdProblem(hold, now)) return null;
  return hold;
}

/** Sets a hold: the keeper picks it up on its next tick. Throws if it isn't one the keeper would follow. */
export function setHold(file: string, hold: RheaHold, now: number): void {
  const problem = holdProblem(hold, now);
  if (problem) throw new Error(`not a hold the keeper follows: ${problem}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(hold)}\n`);
}

/** Clears the hold: the keeper brings the price back to the oracle on its next tick. */
export function clearHold(file: string, by: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ shift_bp: 0, until_ms: 0, by })}\n`);
}

// ---------- the job ----------

/** An account the keeper may sign as: its id, the setting its key comes from, and the sender, null when that key is empty. */
export interface RheaSigner {
  id: string;
  keyName: string;
  send: ((call: RheaCall) => Promise<TxResult>) | null;
}

export interface RheaPriceDeps {
  rheaId: string;
  /** The token whose price is kept: test nBTC, unless `token` says another. */
  tokenId: string;
  /** What the token is (INTERFACES.md 51.1). Left out: bitcoin, with 8 decimals, as before. */
  token?: RheaToken;
  /** Hyperliquid's oracle price for the token's coin, in dollars. */
  oracle(): Promise<number>;
  /** The copy's `get_token_pyth_info({token_id})`. */
  info(): Promise<unknown>;
  /** The copy's owner (`get_config().owner_id`), the only account that can set a price. */
  owner(): Promise<string | null>;
  /** The accounts the keeper may sign as: the operator, and the keeper itself. */
  signers: RheaSigner[];
  hold(): RheaHold | null;
  log: Log;
  now(): number;
  dryRun: boolean;
}

export interface RheaPriceTick {
  /** What the copy counts a bitcoin at after this tick, in dollars; null if it couldn't be read. */
  copy: number | null;
  oracle: number | null;
  /** The price the copy is kept at: the oracle's, or the hold's. */
  target: number | null;
  /** How far the copy was from the target when the tick began, in bp. */
  gap_bp: number | null;
  updated: boolean;
  hold: RheaHold | null;
  problem?: string;
}

const usd = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (bp: number) => `${(bp / 100).toFixed(2)}%`;

export class RheaPriceJob {
  readonly #deps: RheaPriceDeps;
  #said: { what: string; at: number } | undefined;
  #holding = false;
  #started = false;
  #owner: { id: string; at: number } | undefined;
  #failedAt: number | undefined;

  readonly #token: RheaToken;

  constructor(deps: RheaPriceDeps) {
    this.#deps = deps;
    this.#token = deps.token ?? { id: deps.tokenId, coin: "BTC", decimals: NBTC_DECIMALS };
  }

  /** One look at the copy's BTC price, and one update if it is out of step. Never throws. */
  async tick(): Promise<RheaPriceTick> {
    const d = this.#deps;
    const token = this.#token;
    const { ticker, one, min, max } = COINS[token.coin];
    const hold = d.hold();
    const nothing = { copy: null, oracle: null, target: null, gap_bp: null, updated: false, hold };
    let oracle: number;
    let raw: unknown;
    try {
      [oracle, raw] = await Promise.all([d.oracle(), d.info()]);
    } catch (error) {
      return { ...nothing, problem: this.#trouble(`the keeper couldn't read our Rhea copy's ${ticker} price or Hyperliquid's oracle: ${error instanceof Error ? error.message : String(error)}`) };
    }
    if (!(oracle >= min && oracle <= max)) {
      return { ...nothing, problem: this.#trouble(`Hyperliquid's ${ticker} oracle price reads ${oracle}, which doesn't look right: our Rhea copy's price is left as it is`) };
    }
    const info = readPriceInfo(raw, token);
    if (typeof info === "string") return { ...nothing, oracle, problem: this.#trouble(info) };

    const copy = priceOf(info);
    const target = hold ? oracle * (1 + hold.shift_bp / 10_000) : oracle;
    const gap = gapBp(copy, target);
    const side = hold ? `${pct(Math.abs(hold.shift_bp))} ${hold.shift_bp < 0 ? "under" : "over"}` : "";
    const aim = hold ? `the hold's level of ${usd(target)} (${side} Hyperliquid's oracle at ${usd(oracle)})` : `Hyperliquid's oracle price of ${usd(oracle)}`;
    // A line about another token than bitcoin names it; bitcoin's lines are as they were.
    const fields = { rhea: d.rheaId, ...(token.coin === "BTC" ? {} : { token: token.id, coin: token.coin }), copy_usd: copy, oracle_usd: oracle, target_usd: target, gap_bp: Math.round(gap * 10) / 10, hold: hold ?? null };
    if (hold && !this.#holding) d.log("rhea_price", `a hold is on${hold.by ? ` (${hold.by})` : ""}: our Rhea copy's ${ticker} price is kept ${side} Hyperliquid's oracle until ${new Date(hold.until_ms).toISOString()}`, fields);
    if (!hold && this.#holding) d.log("rhea_price", `the hold is over: our Rhea copy's ${ticker} price goes back to Hyperliquid's oracle`, fields);
    this.#holding = hold !== null;

    const same = { copy, oracle, target, gap_bp: gap, updated: false, hold };
    if (gap < RHEA_PRICE_UPDATE_BP) {
      if (!this.#started) d.log("rhea_price", `our Rhea copy counts ${one} at ${usd(copy)}, ${pct(gap)} from ${aim}: inside the ${pct(RHEA_PRICE_BAND_BP)} band`, fields);
      this.#started = true;
      this.#said = undefined;
      this.#failedAt = undefined;
      return same;
    }
    this.#started = true;
    const off = `our Rhea copy counts ${one} at ${usd(copy)}, ${pct(gap)} from ${aim}`;
    if (d.dryRun) return { ...same, problem: this.#trouble(`${off}: a dry run, so it stays`, fields) };
    const now = d.now();
    if (this.#failedAt !== undefined && now - this.#failedAt < RETRY_FAILED_MS) return { ...same, problem: `${off}; the last try to set it failed, and the next one waits a minute` };

    // Only the copy's owner can set a price. A transaction from anyone else can only fail, so none is sent.
    const owner = await this.#ownerId();
    if (!owner) return { ...same, problem: this.#trouble(`${off}, and the keeper couldn't read who owns the copy, so it sent nothing`, fields) };
    const signer = d.signers.find((s) => s.id === owner);
    if (!signer) {
      return { ...same, problem: this.#trouble(`${off}, and the keeper can't set it: the copy's owner is ${owner}, which is neither ${d.signers.map((s) => s.id).join(" nor ")}`, fields) };
    }
    if (!signer.send) return { ...same, problem: this.#trouble(`${off}, and the keeper can't set it: ${signer.keyName} is empty in .env (the copy's owner is ${owner})`, fields) };

    const call = rheaPriceCall(d.rheaId, d.tokenId, info, target);
    const tx = await signer.send(call);
    if (!tx.ok) {
      this.#failedAt = now;
      this.#owner = undefined; // the owner may have changed: read it again before the next try
      return { ...same, problem: this.#trouble(`${off}, and setting it as ${owner} failed: ${tx.failure ?? "no reason given"}`, { ...fields, tx: tx.hash }) };
    }
    const set = Number((call.args.token_pyth_info as { default_price: { multiplier: string } }).default_price.multiplier) / 10 ** priceDigits(info);
    this.#said = undefined;
    this.#failedAt = undefined;
    d.log("rhea_price", `set our Rhea copy's ${ticker} price to ${usd(set)}: it was ${usd(copy)}, ${pct(gap)} from ${aim}`, { ...fields, set_usd: set, signer: owner, tx: tx.hash, gas_tgas: tx.gas_tgas });
    return { copy: set, oracle, target, gap_bp: gap, updated: true, hold };
  }

  /** The copy's owner, read at most every ten minutes. */
  async #ownerId(): Promise<string | null> {
    const now = this.#deps.now();
    if (this.#owner && now - this.#owner.at < OWNER_FOR_MS) return this.#owner.id;
    const id = await this.#deps.owner().catch(() => null);
    if (id) this.#owner = { id, at: now };
    return id;
  }

  /** Logs a trouble once, and again only after five minutes of the same. Returns the words. */
  #trouble(what: string, fields: Record<string, unknown> = {}): string {
    const now = this.#deps.now();
    // The dollar figures change every tick: the same trouble is told apart by its words without them.
    const key = what.replace(/\$[\d,.]+|[\d.]+%/g, "#");
    if (this.#said?.what !== key || now - this.#said.at >= SAY_AGAIN_MS) {
      this.#deps.log("rhea_price", what, { rhea: this.#deps.rheaId, ok: false, ...fields });
      this.#said = { what: key, at: now };
    }
    return what;
  }
}

// ---------- every collateral token (INTERFACES.md 51.1) ----------

/** The factory's Rhea collateral list is read again this often: a token added to it is picked up without a restart. */
const TOKENS_FOR_MS = 5 * 60_000;

export interface RheaPricesDeps extends Omit<RheaPriceDeps, "tokenId" | "token" | "oracle" | "info"> {
  /** Test nBTC: the token an unnamed hold is for, and the one kept when the factory's list can't be read. */
  bitcoinId: string;
  /** The factory's `get_config()`, or null when it can't be read. */
  factoryConfig(): Promise<unknown>;
  /** Hyperliquid's oracle price for a coin, in dollars. */
  oracle(coin: RheaToken["coin"]): Promise<number>;
  /** The copy's `get_token_pyth_info({token_id})`. */
  info(tokenId: string): Promise<unknown>;
}

/**
 * Keeps the copy's price of every token in the factory's Rhea collateral list, one `RheaPriceJob` each: bitcoin
 * against BTC's oracle, test ETH against ETH's, each with its own decimals and its own hold. They run one after the
 * other (the same account signs each update), and one token's trouble never stops another: a token whose setting
 * isn't as expected is left alone by its own job, with the reason in the log.
 */
export class RheaPrices {
  readonly #deps: RheaPricesDeps;
  readonly #jobs = new Map<string, RheaPriceJob>();
  #tokens: { list: RheaToken[]; at: number } | undefined;
  readonly #saidLeft = new Map<string, number>();

  constructor(deps: RheaPricesDeps) {
    this.#deps = deps;
  }

  /** One look at each token's price, and one update for each that is out of step. Never throws. */
  async tick(): Promise<{ token: RheaToken; tick: RheaPriceTick }[]> {
    const d = this.#deps;
    const out: { token: RheaToken; tick: RheaPriceTick }[] = [];
    for (const token of await this.#list()) {
      let job = this.#jobs.get(token.id);
      if (!job) {
        const { bitcoinId: _b, factoryConfig: _f, oracle: _o, info: _i, ...shared } = d;
        job = new RheaPriceJob({ ...shared, tokenId: token.id, token, oracle: () => d.oracle(token.coin), info: () => d.info(token.id), hold: () => holdFor(d.hold(), token.id, d.bitcoinId) });
        this.#jobs.set(token.id, job);
      }
      try {
        out.push({ token, tick: await job.tick() });
      } catch (error) {
        // The job never throws; if it ever did, the other tokens still get their turn.
        out.push({ token, tick: { copy: null, oracle: null, target: null, gap_bp: null, updated: false, hold: null, problem: error instanceof Error ? error.message : String(error) } });
      }
    }
    return out;
  }

  /** The tokens to keep: the factory's list, read at most every five minutes; the last one known while it can't be read; bitcoin alone before any. */
  async #list(): Promise<RheaToken[]> {
    const d = this.#deps;
    const now = d.now();
    if (this.#tokens && now - this.#tokens.at < TOKENS_FOR_MS) return this.#tokens.list;
    const config = await d.factoryConfig().catch(() => null);
    if (config === null || config === undefined) return this.#tokens?.list ?? [{ id: d.bitcoinId, coin: "BTC", decimals: NBTC_DECIMALS }];
    const { tokens, left } = rheaTokens(config, d.bitcoinId);
    for (const l of left) {
      if (now - (this.#saidLeft.get(l.id) ?? Number.NEGATIVE_INFINITY) < 60 * 60_000) continue;
      this.#saidLeft.set(l.id, now);
      d.log("rhea_price", `our Rhea copy's price of ${l.id} is left alone: ${l.why}`, { rhea: d.rheaId, token: l.id, ok: false });
    }
    this.#tokens = { list: tokens, at: now };
    return tokens;
  }
}
