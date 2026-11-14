// GET /api/rhea (INTERFACES.md 22): Rhea's lending terms on mainnet now, for the Borrow page's "compared with Rhea
// alone". Read-only, over mainnet RPC, kept for 5 minutes.
//
// The view is burrowland's `get_assets({token_ids})` -> Vec<AssetDetailedView> (github.com/ref-finance/burrowland,
// contracts/contract/src/asset.rs and asset_view.rs; 0.16.2 runs on mainnet, research/rhea.md 1). Each asset carries
// `config.volatility_ratio` (u32, out of 10,000: how much of its value counts toward borrowing, and how much of a debt
// in it is weighed up), `config.can_use_as_collateral`, `config.can_deposit`, `config.can_borrow`, and `borrow_apr` and `supply_apr` as
// decimal strings, a fraction a year ("0.1669..." is 16.69%). A token Rhea doesn't list is left out of the answer.
// Checked with one live call on 9 Nov at block 223,671,598: USDC 9500, USDt 9500, NBTC 8000, ETH 7500, wNEAR 7500,
// all collateral; USDC's borrow APR 16.70%.
//
// What Rhea would lend against a token alone, at a health factor of exactly 1.0, is its value x its volatility ratio x
// USDC's (research/rhea.md 3): NBTC 0.80 x 0.95 = 76%.
import type { Deps } from "./handlers.js";
import { MAINNET_TOKENS, RHEA_CONTRACT, SPOT_TOKENS, type SpotToken } from "./mainnet.js";
import { HttpError } from "./validate.js";

/** INTERFACES.md 22: Rhea's terms are kept for 5 minutes. */
export const RHEA_CACHE_MS = 5 * 60_000;

export interface RheaAsset {
  token_id: string;
  borrow_apr?: string;
  supply_apr?: string;
  /** Phase 6: the pool's balances, in the token's units x 10^extra_decimals, as strings. */
  supplied?: { balance?: string };
  borrowed?: { balance?: string };
  reserved?: string;
  prot_fee?: string;
  margin_debt?: { balance?: string };
  margin_pending_debt?: string;
  config?: { volatility_ratio?: number; can_use_as_collateral?: boolean; can_deposit?: boolean; can_borrow?: boolean; extra_decimals?: number };
}

export interface RheaToken {
  token: SpotToken;
  token_id: string;
  /** Rhea lists the token. */
  listed: boolean;
  volatility_bp: number | null;
  collateral: boolean;
  can_borrow: boolean;
  borrow_apr_bp: number | null;
  supply_apr_bp: number | null;
  /** What Rhea lends in USDC against it at a health factor of 1.0: its volatility ratio x USDC's, in bp. */
  ltv_bp: number | null;
}

export interface RheaTerms {
  contract: string;
  network: "mainnet";
  view: "get_assets";
  rpc: string;
  block_height: number;
  read_at_ms: number;
  usdc: { token_id: string; volatility_bp: number | null; borrow_apr_bp: number | null; supply_apr_bp: number | null };
  /** Phase 6 (INTERFACES.md 28): the USDC Rhea has free to lend, in micro-USD; null when the balances can't be read. */
  free_usdc: string | null;
  tokens: RheaToken[];
}

/** "0.166986378336576512798006891" -> 1670 bp, or null when it isn't a plain decimal. */
export function aprBp(text: unknown): number | null {
  if (typeof text !== "string" || !/^\d+(\.\d+)?$/.test(text)) return null;
  const bp = Math.round(Number(text) * 10_000);
  return Number.isFinite(bp) ? bp : null;
}

/**
 * What an asset has free to lend, in the token's own units. It is burrowland's own `Asset::available_amount`
 * (contracts/contract/src/asset.rs, read 10 Nov): supplied + reserved + prot_fee - borrowed - margin_debt -
 * margin_pending_debt. research/scripts/rhea_warehouse.py counts the same less the two margin terms, which were 0 for
 * USDC on mainnet at block 223,978,042. Rhea keeps balances with `config.extra_decimals` more decimals than the token,
 * so those are cut off. Null when a balance is missing.
 */
export function rheaFree(asset: RheaAsset | undefined): string | null {
  const whole = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);
  const supplied = whole(asset?.supplied?.balance);
  const borrowed = whole(asset?.borrowed?.balance);
  if (supplied === null || borrowed === null) return null;
  const extra = asset?.config?.extra_decimals ?? 0;
  if (!Number.isInteger(extra) || extra < 0 || extra > 30) return null;
  const lent = borrowed + (whole(asset?.margin_debt?.balance) ?? 0n) + (whole(asset?.margin_pending_debt) ?? 0n);
  const free = supplied + (whole(asset?.reserved) ?? 0n) + (whole(asset?.prot_fee) ?? 0n) - lent;
  return (free > 0n ? free / 10n ** BigInt(extra) : 0n).toString();
}

export function readRheaAssets(assets: unknown, blockHeight: number, readAtMs: number, rpcHost: string): RheaTerms {
  if (!Array.isArray(assets)) throw new HttpError(502, "rhea", `${RHEA_CONTRACT}.get_assets answered something that isn't a list`);
  const byId = new Map((assets as RheaAsset[]).filter((a) => a && typeof a.token_id === "string").map((a) => [a.token_id, a]));
  const vol = (a: RheaAsset | undefined) => (typeof a?.config?.volatility_ratio === "number" ? a.config.volatility_ratio : null);
  const usdcAsset = byId.get(MAINNET_TOKENS.USDC.id);
  const usdcVol = vol(usdcAsset);
  const tokens = SPOT_TOKENS.map((token): RheaToken => {
    const a = byId.get(MAINNET_TOKENS[token].id);
    const v = vol(a);
    // As pb-risk counts it (INTERFACES.md 18, as built): collateral only if Rhea takes deposits of it too.
    const collateral = a?.config?.can_use_as_collateral === true && a.config.can_deposit === true;
    return {
      token,
      token_id: MAINNET_TOKENS[token].id,
      listed: Boolean(a),
      volatility_bp: v,
      collateral,
      can_borrow: a?.config?.can_borrow === true,
      borrow_apr_bp: aprBp(a?.borrow_apr),
      supply_apr_bp: aprBp(a?.supply_apr),
      ltv_bp: collateral && v !== null && usdcVol !== null ? Math.floor((v * usdcVol) / 10_000) : collateral ? null : 0,
    };
  });
  return {
    contract: RHEA_CONTRACT,
    network: "mainnet",
    view: "get_assets",
    rpc: rpcHost,
    block_height: blockHeight,
    read_at_ms: readAtMs,
    usdc: { token_id: MAINNET_TOKENS.USDC.id, volatility_bp: usdcVol, borrow_apr_bp: aprBp(usdcAsset?.borrow_apr), supply_apr_bp: aprBp(usdcAsset?.supply_apr) },
    free_usdc: rheaFree(usdcAsset),
    tokens,
  };
}

/**
 * GET /api/rhea. If mainnet doesn't answer, the last terms read are answered with `stale: true` and their age; with
 * none, 502, and the page falls back to the 3 Nov figures (web/src/lib/carry.ts) and says so.
 */
export async function getRhea(deps: Deps) {
  const mainnet = deps.mainnet;
  if (!mainnet) throw new HttpError(503, "rhea_off", "Reading mainnet is off here");
  const now = deps.now();
  const rpcHost = new URL(deps.config.mainnetRpcUrl).host;
  const read = async () => {
    const view = await mainnet.view<unknown>(RHEA_CONTRACT, "get_assets", { token_ids: SPOT_TOKENS.map((t) => MAINNET_TOKENS[t].id) });
    return readRheaAssets(view.value, view.blockHeight, now, rpcHost);
  };
  const cache = deps.rheaTerms;
  try {
    const hit = cache?.get("terms", now);
    const terms = await (hit ? hit.value : cache ? cache.set("terms", now, read()) : read());
    return { ...terms, age_s: Math.max(0, Math.round((now - terms.read_at_ms) / 1000)), stale: false };
  } catch (error) {
    const last = cache?.last("terms");
    if (last) return { ...last.value, age_s: Math.round((now - last.value.read_at_ms) / 1000), stale: true, error: error instanceof Error ? error.message : String(error) };
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "rhea_unreachable", `Rhea's terms could not be read on mainnet: ${error instanceof Error ? error.message : String(error)}`);
  }
}
