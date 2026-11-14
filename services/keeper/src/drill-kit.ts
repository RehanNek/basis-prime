// The depeg drill's parts (INTERFACES.md 5, 17 and 21): reading ratios and slides from the command line, the slide's
// timetable, and the drill contract's methods. drill.ts and drill-demo.ts use them; the tests give fakes.
//
//   drill.pbf-ops.testnet: set_ratio({bp}) by its owner (the operator), get_ratio() -> {bp, set_at}, owner()
//   Phase 5 (INTERFACES.md 21), so one drill shocks one account: set_ratio_for({account_id, bp}) and
//   clear_ratio_for({account_id}) by the owner, get_ratio_for({account_id}) -> the account's own ratio, else the shared
//   one. pb-risk reads get_ratio_for on testnet. Until that code is deployed the methods aren't there, and the tools
//   fall back to the shared set_ratio, saying that it moves every account.

import type { NearCall, TxResult } from "./near-tx.js";

/** 1.0, in basis points. */
export const PAR_BP = 10_000;

/** "0.75" -> 7500. A ratio is above 0 and at most 1, with at most 4 decimals. */
export function parseRatio(text: string): number {
  const clean = text.trim();
  if (!/^(0|1)?(\.\d{1,4})?$/.test(clean) || clean === "" || clean === ".") throw new Error(`"${text}" isn't a ratio like 0.75 (above 0, at most 1, at most 4 decimals)`);
  const bp = Math.round(Number(clean) * PAR_BP);
  if (!(bp > 0 && bp <= PAR_BP)) throw new Error(`the ratio ${text} must be above 0 and at most 1`);
  return bp;
}

/** "0.84,0.80,0.75" -> [8400, 8000, 7500]. */
export function parseSlide(text: string): number[] {
  const points = text.split(",").map((part) => parseRatio(part));
  if (points.length === 0) throw new Error("--slide needs at least one ratio");
  return points;
}

/** Minutes between the slide's steps: above 0 and at most 60. */
export function parseMinutes(text: string): number {
  const minutes = Number(text);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60) throw new Error(`--every ${text} must be a number of minutes above 0 and at most 60`);
  return minutes;
}

export interface SlidePoint {
  at: number;
  bp: number;
}

/** The slide's timetable: the first ratio at once, each next one `everyMinutes` after the one before. */
export function slideSchedule(points: number[], everyMinutes: number, startMs: number): SlidePoint[] {
  return points.map((bp, i) => ({ at: startMs + Math.round(i * everyMinutes * 60_000), bp }));
}

/** A slide that doesn't go down step by step is allowed, but worth a word. */
export function slideWarnings(points: number[]): string[] {
  const warnings: string[] = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i]! >= points[i - 1]!) warnings.push(`step ${i + 1} (${showRatio(points[i]!)}) isn't below step ${i} (${showRatio(points[i - 1]!)})`);
  }
  return warnings;
}

export function showRatio(bp: number): string {
  return (bp / PAR_BP).toFixed(4);
}

/**
 * The states a three-step slide should show, one per step (PLAN.md 11.5). On the small demo book at BTC $75,800 they
 * turn below 0.8406 (WATCH), 0.7970 (MARGIN_CALL) and 0.7594 (DELEVERAGE), so §17's example 0.84,0.80,0.75 would skip
 * MARGIN_CALL: the slide comes from the bands instead.
 */
export const SLIDE_STATES = ["WATCH", "MARGIN_CALL", "DELEVERAGE"] as const;
/** Each step lands this far past its band, inside the 150-200 bp the risk side suggests. */
export const DEFAULT_BELOW_BP = 150;

export interface NbtcBands {
  im_bp: number;
  mr_bp: number;
  dl_bp: number;
}

/** The verdict's nBTC bands (RISK_ENGINE.md 8.3: π in bp where equity reaches IM, MR and 0.8 x MR), if all three are there. */
export function nbtcBands(bands: unknown): NbtcBands | null {
  const b = (bands as { nBTC?: Record<string, unknown> } | null | undefined)?.nBTC;
  if (!b || typeof b.im_bp !== "number" || typeof b.mr_bp !== "number" || typeof b.dl_bp !== "number") return null;
  return { im_bp: b.im_bp, mr_bp: b.mr_bp, dl_bp: b.dl_bp };
}

/** The slide from the bands: each band less `belowBp`, so each step lands just past where the state turns. */
export function slideFromBands(bands: NbtcBands, belowBp = DEFAULT_BELOW_BP): number[] {
  if (!Number.isInteger(belowBp) || belowBp < 0 || belowBp > 2_000) throw new Error(`--below ${belowBp} must be whole basis points from 0 to 2000`);
  const points = [bands.im_bp, bands.mr_bp, bands.dl_bp].map((bp) => bp - belowBp);
  if (points.some((bp) => bp <= 0 || bp > PAR_BP)) throw new Error(`the bands ${JSON.stringify(bands)} less ${belowBp} bp leave a ratio outside (0, 1]`);
  if (!(points[0]! > points[1]! && points[1]! > points[2]!)) throw new Error(`the bands ${JSON.stringify(bands)} don't go down from IM to MR to 0.8 x MR`);
  return points;
}

export interface Ratio {
  bp: number;
  set_at: string;
}

/** A view that failed because the contract has no such method: the drill's code from before per-account ratios. */
export function isMissingMethod(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // near-api-js 7.4.0: ContractMethodNotFoundError, "Contract method is not found at block height <h>" (read live, 9 Nov).
  return error.name === "ContractMethodNotFoundError" || /method is not found|MethodNotFound/i.test(error.message);
}

/** A ratio change, and whether it went to the shared ratio because the drill's code has no per-account ones yet. */
export type RatioTx = TxResult & { shared: boolean };

/** The drill contract: reads, and its owner's set_ratio, set_ratio_for and clear_ratio_for. */
export class DrillContract {
  readonly id: string;
  readonly #view: <T>(contract: string, method: string, args?: Record<string, unknown>) => Promise<T>;
  readonly #call: NearCall | null;
  /** Whether the deployed code has get_ratio_for, once asked. */
  #perAccount: boolean | undefined;

  constructor(id: string, view: <T>(contract: string, method: string, args?: Record<string, unknown>) => Promise<T>, call: NearCall | null) {
    this.id = id;
    this.#view = view;
    this.#call = call;
  }

  ratio(): Promise<Ratio> {
    return this.#view<Ratio>(this.id, "get_ratio");
  }

  owner(): Promise<string> {
    return this.#view<string>(this.id, "owner");
  }

  /** Whether the drill's code knows per-account ratios (INTERFACES.md 21): it has get_ratio_for. Asked once. */
  async perAccount(account: string): Promise<boolean> {
    if (this.#perAccount === undefined) {
      try {
        await this.#view<Ratio>(this.id, "get_ratio_for", { account_id: account });
        this.#perAccount = true;
      } catch (error) {
        if (!isMissingMethod(error)) throw error;
        this.#perAccount = false;
      }
    }
    return this.#perAccount;
  }

  /** The ratio pb-risk reads for the account: its own if it has one, else the shared one (and the shared one on old code). */
  async ratioFor(account: string): Promise<Ratio> {
    return (await this.perAccount(account)) ? this.#view<Ratio>(this.id, "get_ratio_for", { account_id: account }) : this.ratio();
  }

  /** set_ratio({bp}), the ratio every account without its own reads: no deposit, 30 TGas. */
  async set(bp: number): Promise<TxResult> {
    return this.#send("set_ratio", { bp }, `set_ratio ${showRatio(checkBp(bp))}`);
  }

  /** set_ratio_for({account_id, bp}): only this account's ratio. On the old code, the shared set_ratio instead. */
  async setFor(account: string, bp: number): Promise<RatioTx> {
    checkBp(bp);
    if (!(await this.perAccount(account))) return { ...(await this.set(bp)), shared: true };
    return { ...(await this.#send("set_ratio_for", { account_id: account, bp }, `set_ratio_for ${account} ${showRatio(bp)}`)), shared: false };
  }

  /** clear_ratio_for({account_id}): the account follows the shared ratio again. On the old code, the shared one back to 1.0. */
  async clearFor(account: string): Promise<RatioTx> {
    if (!(await this.perAccount(account))) return { ...(await this.set(PAR_BP)), shared: true };
    return { ...(await this.#send("clear_ratio_for", { account_id: account }, `clear_ratio_for ${account}`)), shared: false };
  }

  async #send(method: string, args: Record<string, unknown>, label: string): Promise<TxResult> {
    if (!this.#call) throw new Error("no signing key: a dry run sends nothing");
    return this.#call(this.id, method, args, { tgas: 30, deposit: 0n, label });
  }
}

function checkBp(bp: number): number {
  if (!Number.isInteger(bp) || bp <= 0 || bp > PAR_BP) throw new Error(`the ratio ${bp} bp must be a whole number above 0 and at most ${PAR_BP}`);
  return bp;
}

/**
 * Walks the ratio down the timetable: waits for each point, sets it, and says so. Stops at the end, or when `stop`
 * says so (the gate script stops early once the account is HEALTHY again). Returns every transaction. With `account`,
 * each step sets that account's own ratio (set_ratio_for), or the shared one on the drill's old code.
 */
export async function runSlide(
  drill: DrillContract,
  schedule: SlidePoint[],
  io: { now(): number; sleep(ms: number): Promise<void>; say(line: string): void; stop?(): boolean },
  account?: string,
): Promise<TxResult[]> {
  const sent: TxResult[] = [];
  for (const [i, point] of schedule.entries()) {
    while (io.now() < point.at) {
      if (io.stop?.()) return sent;
      await io.sleep(Math.min(5_000, point.at - io.now()));
    }
    if (io.stop?.()) return sent;
    const tx = account ? await drill.setFor(account, point.bp) : await drill.set(point.bp);
    sent.push(tx);
    const whose = !account ? "the nBTC/BTC ratio" : (tx as RatioTx).shared ? "the shared nBTC/BTC ratio (the drill has no per-account ratios yet)" : `${account}'s nBTC/BTC ratio`;
    io.say(`step ${i + 1} of ${schedule.length}: ${tx.ok ? `set ${whose} to ${showRatio(point.bp)}` : `${tx.label} FAILED: ${tx.failure ?? "no reason given"}`} (tx ${tx.hash ?? "none"})`);
    if (!tx.ok) break;
  }
  return sent;
}
