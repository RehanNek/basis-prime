// Phase 6, stage 1 (INTERFACES.md 28; FUNDING.md 7.2): the lenders' live terms, an account's standing at each lender,
// and how a loan would be funded. Everything here reads; nothing is signed or sent.
//
//   GET  /api/lenders          each lender's terms now: mainnet Aave and Rhea, testnet Aave, and our testnet Rhea copy
//   GET  /api/lender/:account  the account's permission, funding plan and lender positions (the held verdict's `ext`);
//                              stage 2: what it holds at Rhea as collateral and as a plain deposit, and the pool's pricing
//   POST /api/funding-plan     {account, amount}: a preview with the `fund` intent, as sources and steps
//
// Stage 2: our Rhea copy on testnet (RHEA_ACCOUNT_ID) is Rhea's 0.15.7 release file, read with the same `get_assets` as
// mainnet's 0.16.2. Nothing here reads `get_config`, whose `contract_mode` the copy doesn't have.
import { AAVE_MAINNET, AAVE_QUERY, readAaveApi, readAaveTestnet, type Terms } from "./aave.js";
import type { TokenConfig } from "./config.js";
import { collateralRoom, evmView, type CollateralRoom } from "./evm-handlers.js";
import { runPreview, soft, type Deps } from "./handlers.js";
import { aprBp, getRhea, rheaFree, type RheaAsset } from "./rhea.js";
import { asObject, badRequest, isAccountId, isPrimeAccount, isU128 } from "./validate.js";

/** INTERFACES.md 28: the lenders' terms are kept for 5 minutes, like Rhea's. */
export const LENDERS_CACHE_MS = 5 * 60_000;
/** INTERFACES.md 24: lender names, always in this order in lists. */
export const LENDER_NAMES = ["aave", "rhea"] as const;
export type LenderName = (typeof LENDER_NAMES)[number];
/** INTERFACES.md 27 and 28: a cushion under 13500 is thin, under 12000 needs action now. */
export const THIN_HF_BP = 13_500;
export const ACT_HF_BP = 12_000;
/**
 * Rhea has no fixed liquidation penalty: liquidators take a discount that grows as the health factor falls. On mainnet
 * they act just under 1.0 and took 0.24% to 0.28% (research/rhea.md 9); FUNDING.md 1 calls it "about 0.3%".
 */
export const RHEA_PENALTY_BP = 30;

/** What a token is called in plain words (INTERFACES.md 51.1): "bitcoin" for nBTC and WBTC, "ether" for ETH and WETH; else its own symbol. */
export function plainName(symbol: string): string {
  if (symbol === "nBTC" || symbol === "WBTC") return "bitcoin";
  if (symbol === "ETH" || symbol === "WETH") return "ether";
  return symbol;
}

/**
 * INTERFACES.md 51.1: one collateral token a lender takes, with its own terms: the most the lender lends against it
 * and where it liquidates, in bp, and its plain name. Rhea lends up to a health factor of 1.0, so its two are equal.
 */
export interface LenderCollateral {
  /** The token's id on NEAR. */
  token: string;
  /** The pool's name for it: "nBTC", "ETH". */
  symbol: string;
  /** "bitcoin", "ether". */
  name: string;
  decimals: number;
  ltv_bp: number;
  liq_bp: number;
}

/** One row of GET /api/lenders. `read_at_ms` is when this row was read, which a stale row needs. */
export interface LenderRow extends Terms {
  l: LenderName;
  network: "mainnet" | "testnet";
  chain: string;
  collateral: string;
  source: string;
  stale: boolean;
  read_at_ms: number;
  /**
   * Stage 3, testnet Aave only: how much more of each collateral token of the factory's settings Aave's pool can
   * take (evm-handlers.ts). "0" is a full cap; empty when it couldn't be read.
   */
  collateral_room?: CollateralRoom[];
  /**
   * INTERFACES.md 51.1, our testnet Rhea copy only: every collateral token of the factory's Rhea list that the copy
   * lists, bitcoin first, each with its own terms. The row's own `collateral`, `ltv_bp` and `liq_bp` stay bitcoin's,
   * as before, so a reader of before reads what it read.
   */
  collaterals?: LenderCollateral[];
}

/** A read through the 5-minute store: a fresh answer, else the last one marked stale, else nothing. */
async function kept(deps: Deps, key: string, read: () => Promise<LenderRow>): Promise<LenderRow | null> {
  const now = deps.now();
  const cache = deps.lenderTerms;
  try {
    const hit = cache?.get(key, now);
    return await (hit ? hit.value : cache ? cache.set(key, now, read()) : read());
  } catch {
    const last = cache?.last(key);
    return last ? { ...last.value, stale: true } : null;
  }
}

/** Rhea's terms from `get_assets` (rhea.ts says where its fields come from), for any copy of the contract. */
export function rheaTermsOf(assets: unknown, usdcId: string, btcId: string): Terms {
  if (!Array.isArray(assets)) throw new Error("get_assets answered something that isn't a list");
  const find = (id: string) => (assets as RheaAsset[]).find((a) => a && a.token_id === id);
  const usdc = find(usdcId);
  const btc = find(btcId);
  if (!usdc || !btc) throw new Error(`get_assets doesn't list ${usdc ? btcId : usdcId}`);
  const rate = aprBp(usdc.borrow_apr);
  const supply = aprBp(usdc.supply_apr);
  const free = rheaFree(usdc);
  const usdcVol = usdc.config?.volatility_ratio;
  const btcVol = btc.config?.volatility_ratio;
  if (rate === null || supply === null || free === null || typeof usdcVol !== "number" || typeof btcVol !== "number") throw new Error("get_assets left out USDC's rates or balances, or a volatility ratio");
  // As rhea.ts counts it: collateral only if Rhea takes deposits of it too. Rhea lends up to a health factor of 1.0,
  // so the most it lends and where it liquidates are the same figure.
  const collateral = btc.config?.can_use_as_collateral === true && btc.config.can_deposit === true;
  const ltv = collateral ? Math.floor((btcVol * usdcVol) / 10_000) : 0;
  return { rate_bp: rate, supply_bp: supply, free, ltv_bp: ltv, liq_bp: ltv, penalty_bp: RHEA_PENALTY_BP };
}

/**
 * What Rhea lends against one collateral token, in bp, from `get_assets`: the token's volatility ratio times
 * USDC's (as `rheaTermsOf` counts bitcoin's), 0 when Rhea doesn't take it as collateral. Null when `get_assets`
 * doesn't list the token or leaves a ratio out.
 */
export function rheaLtvOf(assets: unknown, usdcId: string, tokenId: string): number | null {
  if (!Array.isArray(assets)) return null;
  const find = (id: string) => (assets as RheaAsset[]).find((a) => a && a.token_id === id);
  const [usdc, token] = [find(usdcId), find(tokenId)];
  const [usdcVol, vol] = [usdc?.config?.volatility_ratio, token?.config?.volatility_ratio];
  if (!token || typeof usdcVol !== "number" || typeof vol !== "number") return null;
  return token.config?.can_use_as_collateral === true && token.config.can_deposit === true ? Math.floor((vol * usdcVol) / 10_000) : 0;
}

/**
 * The collateral tokens of the factory's Rhea settings (`lenders.rhea.collateral`), each with the name and decimals
 * the factory's own token list gives it, bitcoin first. With a factory that can't be read, or lists none: bitcoin alone.
 */
export function rheaCollateralTokens(factoryConfig: unknown, bitcoin: TokenConfig): TokenConfig[] {
  const config = factoryConfig as { tokens?: unknown; lenders?: { rhea?: { collateral?: unknown } | null } | null } | null | undefined;
  const listed = Array.isArray(config?.lenders?.rhea?.collateral) ? (config.lenders.rhea.collateral as unknown[]).filter((id): id is string => typeof id === "string") : [];
  const known = Array.isArray(config?.tokens) ? (config.tokens as { id?: unknown; symbol?: unknown; decimals?: unknown }[]) : [];
  const others = [...new Set(listed)].flatMap((id): TokenConfig[] => {
    const t = known.find((k) => k?.id === id);
    return id !== bitcoin.id && t && typeof t.symbol === "string" && typeof t.decimals === "number" ? [{ id, symbol: t.symbol, decimals: t.decimals }] : [];
  });
  return [bitcoin, ...others];
}

/**
 * GET /api/lenders. Each lender is read on its own: one that can't be read gives its last answer with `stale: true`,
 * or is left out, and the others still answer.
 */
export async function getLenders(deps: Deps) {
  const now = deps.now();
  const { config } = deps;
  const host = (url: string) => new URL(url).host;

  const aaveMainnet = async (): Promise<LenderRow | null> => {
    const api = deps.aaveApi;
    if (!api) return null;
    return kept(deps, "aave:mainnet", async () => {
      const data = await api(AAVE_QUERY, { market: AAVE_MAINNET.market, chain: AAVE_MAINNET.chainId, usdc: AAVE_MAINNET.usdc, wbtc: AAVE_MAINNET.wbtc });
      return { l: "aave", network: "mainnet", chain: "Ethereum", collateral: "WBTC", ...readAaveApi(data), source: "Aave's API (api.v3.aave.com), the Ethereum core market", stale: false, read_at_ms: now };
    });
  };

  // Rhea on mainnet is the read GET /api/rhea already makes and keeps, with its own stale answer.
  const rheaMainnet = async (): Promise<LenderRow | null> => {
    try {
      const terms = await getRhea(deps);
      const nbtc = terms.tokens.find((t) => t.token === "nBTC");
      if (terms.usdc.borrow_apr_bp === null || terms.usdc.supply_apr_bp === null || terms.free_usdc === null || !nbtc || nbtc.ltv_bp === null) return null;
      return {
        l: "rhea",
        network: "mainnet",
        chain: "NEAR",
        collateral: "nBTC",
        rate_bp: terms.usdc.borrow_apr_bp,
        supply_bp: terms.usdc.supply_apr_bp,
        free: terms.free_usdc,
        ltv_bp: nbtc.ltv_bp,
        liq_bp: nbtc.ltv_bp,
        penalty_bp: RHEA_PENALTY_BP,
        source: `${terms.contract}.get_assets at block ${terms.block_height}, via ${terms.rpc}`,
        stale: terms.stale,
        read_at_ms: terms.read_at_ms,
      };
    } catch {
      return null;
    }
  };

  const aaveTestnet = async (): Promise<LenderRow | null> => {
    const evm = deps.evm;
    if (!evm) return null;
    return kept(deps, "aave:testnet", async () => {
      const terms = await readAaveTestnet(evm, config.evmChainId, config.aaveDataProvider);
      const chain = config.evmChainId === 84_532 ? "Base Sepolia" : `chain ${config.evmChainId}`;
      // The row stands without the caps: a read of them that fails leaves the list empty.
      const room = await collateralRoom(deps).catch(() => [] as CollateralRoom[]);
      return { l: "aave", network: "testnet", chain, collateral: "WBTC", ...terms, collateral_room: room, source: `eth_call to Aave's data provider ${config.aaveDataProvider}, via ${host(config.evmRpcUrl)}`, stale: false, read_at_ms: now };
    });
  };

  // Our Rhea copy on testnet exists from stage 2: until RHEA_ACCOUNT_ID is set and answers, there is no such row.
  const rheaTestnet = async (): Promise<LenderRow | null> => {
    const contract = config.rheaAccountId;
    if (!contract) return null;
    const [usdc, btc] = config.ids.tokens;
    return kept(deps, "rhea:testnet", async () => {
      // INTERFACES.md 51.1: every collateral token of the factory's Rhea list, bitcoin first. The factory's settings
      // are read softly: without them the row is bitcoin's alone, as before.
      const factory = await soft(deps.chain.view<unknown>(config.ids.factory, "get_config")).catch(() => null);
      const tokens = rheaCollateralTokens(factory?.value, btc!);
      const view = await deps.chain.view<unknown>(contract, "get_assets", { token_ids: [usdc!.id, ...tokens.map((t) => t.id)] });
      const collaterals = tokens.flatMap((t): LenderCollateral[] => {
        const ltv = rheaLtvOf(view.value, usdc!.id, t.id);
        return ltv === null ? [] : [{ token: t.id, symbol: t.symbol, name: plainName(t.symbol), decimals: t.decimals, ltv_bp: ltv, liq_bp: ltv }];
      });
      return { l: "rhea", network: "testnet", chain: "NEAR", collateral: btc!.symbol, ...rheaTermsOf(view.value, usdc!.id, btc!.id), collaterals, source: `${contract}.get_assets at block ${view.blockHeight}, via ${host(config.nearRpcUrl)}`, stale: false, read_at_ms: now };
    });
  };

  const rows = await Promise.all([aaveMainnet(), rheaMainnet(), aaveTestnet(), rheaTestnet()]);
  return { read_at_ms: now, lenders: rows.filter((row): row is LenderRow => row !== null) };
}

/** One entry of a verdict's `ext` (INTERFACES.md 25): a lender position, in micro-USD and bp. */
export interface Ext {
  l: LenderName;
  c: number;
  d: number;
  hf_bp: number;
  r_bp: number;
  s_bp: number;
  room: number;
  liq_bp: number;
}

const isLender = (value: unknown): value is LenderName => typeof value === "string" && (LENDER_NAMES as readonly string[]).includes(value);

/** The verdict's `ext`, in INTERFACES.md 24's order. Entries that aren't a lender position are dropped; a missing number counts 0. */
export function readExt(value: unknown): Ext[] {
  if (!Array.isArray(value)) return [];
  const amount = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const out: Ext[] = [];
  for (const entry of value as (Record<string, unknown> | null)[]) {
    if (!entry || typeof entry !== "object" || !isLender(entry.l) || out.some((e) => e.l === entry.l)) continue;
    out.push({ l: entry.l, c: amount(entry.c), d: amount(entry.d), hf_bp: amount(entry.hf_bp), r_bp: amount(entry.r_bp), s_bp: amount(entry.s_bp), room: amount(entry.room), liq_bp: amount(entry.liq_bp) });
  }
  return out.sort((a, b) => LENDER_NAMES.indexOf(a.l) - LENDER_NAMES.indexOf(b.l));
}

/** `none` with no debt at the lender; else by the cushion: `act` under 12000, `thin` under 13500, else `safe`. */
export function lenderStatus(ext: Pick<Ext, "d" | "hf_bp">): "none" | "safe" | "thin" | "act" {
  if (ext.d === 0) return "none";
  return ext.hf_bp < ACT_HF_BP ? "act" : ext.hf_bp < THIN_HF_BP ? "thin" : "safe";
}

interface LenderState {
  permission?: unknown;
  /**
   * INTERFACES.md 40.1 (the audit's A8), accounts made since 12 Nov: the block the permission last changed in (the
   * account's making, when a permission came with it); 0 if none was ever set. `fund` and the lender steps take only
   * a verdict read after it, and `set_permission` no longer moves the counter.
   */
  permission_blk?: unknown;
  funding?: unknown;
  verdict?: { verdict?: { blk?: unknown; ext?: unknown } | null } | null;
}

/** The parts of an account's own Config that say where its lender positions are and how to count its tokens. */
interface LenderConfig {
  lenders?: (Partial<Record<LenderName, unknown>> & { rhea?: { contract_id?: unknown } | null }) | null;
  tokens?: { id?: unknown; symbol?: unknown; decimals?: unknown }[] | null;
  usdc_token?: unknown;
}

/** Rhea counts every token with 18 decimals inside (research/rhea.md 2 and 12): its balances are in those inner units. */
export const RHEA_INNER_DECIMALS = 18;

/** Collateral an account has posted at a lender, in the token's own units. */
export interface Held {
  token: string;
  symbol: string;
  decimals: number;
  amount: string;
}

interface RheaList {
  token_id?: unknown;
  balance?: unknown;
}

/**
 * What Rhea's own `get_account` says the account has there, beside its debt (stage 2; research/rhea.md 12):
 * - `held`: each collateral balance, turned from Rhea's 18 inner decimals into the token's own, rounded down. It is
 *   the most the client can take back. A token the account's config doesn't know is left out: its decimals aren't known.
 * - `deposit`: the USDC lying there as a plain deposit (`supplied`), in micro-USD, rounded down. A repayment above
 *   the debt leaves the rest there, and the client can bring it back.
 * `get_account` answers null for an account that never registered: nothing held, nothing deposited.
 */
export function rheaHoldings(account: unknown, tokens: TokenConfig[], usdcId: string): { held: Held[]; deposit: string } {
  const a = account as { collateral?: unknown; supplied?: unknown } | null;
  const entries = (list: unknown) => (Array.isArray(list) ? (list as (RheaList | null)[]) : []).filter((e): e is { token_id: string; balance: string } => typeof e?.token_id === "string" && typeof e.balance === "string" && /^\d+$/.test(e.balance));
  const own = (inner: string, decimals: number) => (decimals <= RHEA_INNER_DECIMALS ? BigInt(inner) / 10n ** BigInt(RHEA_INNER_DECIMALS - decimals) : 0n);
  const held: Held[] = [];
  for (const e of entries(a?.collateral)) {
    const token = tokens.find((t) => t.id === e.token_id);
    if (!token) continue;
    const amount = own(e.balance, token.decimals);
    if (amount > 0n) held.push({ token: token.id, symbol: token.symbol, decimals: token.decimals, amount: amount.toString() });
  }
  const usdc = tokens.find((t) => t.id === usdcId);
  const supplied = entries(a?.supplied).find((e) => e.token_id === usdcId);
  return { held, deposit: supplied && usdc ? own(supplied.balance, usdc.decimals).toString() : "0" };
}

/**
 * GET /api/lender/:account: the account's permission and funding plan from get_state, its lender positions from the
 * held verdict's `ext`, the lenders its config names, and the pool's `get_pricing` for it. An account made before Phase 6 has none of these, and a
 * pool without `get_pricing` (before stage 2) gives `pricing: null`: both are answers, not errors.
 *
 * Stage 2: each lender entry also has `held`, the collateral posted there in the token's own units, and Rhea's entry
 * has `deposit`, the USDC lying there as a plain deposit. Both come from Rhea's own `get_account`, read at the
 * contract the account's config names. If that read fails they are empty ("0"): the rest of the answer still stands.
 *
 * Stage 3 (INTERFACES.md 33): `evm` is the account's side on Aave's chain (its address, nonces, test ETH, the tokens
 * at the address, and each signed transaction with its status), and Aave's `held` is what it has posted there, from
 * Aave's own books. `evm` is null for an account without Aave settings or without an address.
 *
 * The audit fixes (INTERFACES.md 40.1): `permission_blk` is the block the permission last changed in, beside
 * `verdict_blk`, the block the held verdict was read at: a verdict not read after that change backs no `fund`. It is
 * null for an account made before the fix, which has no such rule.
 */
export async function getLender(deps: Deps, accountId: string) {
  if (!isAccountId(accountId)) throw badRequest("Not a valid NEAR account id");
  const [state, pricing, config] = await Promise.all([
    soft(deps.chain.view<LenderState | null>(accountId, "get_state")),
    soft(deps.chain.view<unknown>(deps.config.ids.pool, "get_pricing", { account_id: accountId })),
    soft(deps.chain.view<LenderConfig | null>(accountId, "get_config")),
  ]);
  const held = state?.value?.verdict?.verdict ?? null;
  const ext = readExt(held?.ext);

  // Rhea's own record, only when the verdict shows a Rhea position to hang it on.
  const conf = config?.value;
  const rheaId = conf?.lenders?.rhea?.contract_id;
  let rhea: { held: Held[]; deposit: string } = { held: [], deposit: "0" };
  if (ext.some((e) => e.l === "rhea") && isAccountId(rheaId)) {
    const tokens = (conf?.tokens ?? []).filter((t): t is TokenConfig => typeof t?.id === "string" && typeof t.symbol === "string" && typeof t.decimals === "number");
    const known = tokens.length ? tokens : deps.config.ids.tokens;
    const usdcId = typeof conf?.usdc_token === "string" ? conf.usdc_token : deps.config.ids.tokens[0]!.id;
    const account = await deps.chain.view<unknown>(rheaId, "get_account", { account_id: accountId }).catch(() => null);
    if (account) rhea = rheaHoldings(account.value, known, usdcId);
  }
  // Stage 3: the account's standing on Aave's chain, and what it has posted at Aave, read from that chain.
  const aave = await evmView(deps, state?.value as Parameters<typeof evmView>[1], conf);

  return {
    account: accountId,
    read_at_ms: deps.now(),
    // The lenders the account's own config has settings for: the app shows the funding view only for these accounts.
    config_lenders: LENDER_NAMES.filter((l) => conf?.lenders?.[l] != null),
    permission: state?.value?.permission ?? null,
    permission_blk: typeof state?.value?.permission_blk === "number" ? state.value.permission_blk : null,
    funding: state?.value?.funding ?? null,
    verdict_blk: typeof held?.blk === "number" ? held.blk : null,
    lenders: ext.map((e) => ({
      l: e.l,
      posted: e.c,
      debt: e.d,
      hf_bp: e.hf_bp,
      liq_bp: e.liq_bp,
      rate_bp: e.r_bp,
      supply_bp: e.s_bp,
      room: e.room,
      status: lenderStatus(e),
      held: e.l === "rhea" ? rhea.held : (aave?.held ?? []),
      ...(e.l === "rhea" ? { deposit: rhea.deposit } : {}),
    })),
    evm: aave?.evm ?? null,
    pricing: pricing?.value ?? null,
  };
}

export interface FundingSource {
  source: LenderName | "pool";
  amount: number;
  rate_bp: number | null;
}

/**
 * A `fund` verdict as the Borrow panel shows it (INTERFACES.md 27-28): what each source lends (the steps' `l_borrow`
 * and `p_borrow` amounts), at what rate (the lender's `r_bp` from `ext`; the pool's is the verdict's `rate_bp`), and
 * the whole loan's rate, weighted by amount. A refusal, or a verdict from an engine that doesn't know `fund`, gives
 * no sources.
 */
export function fundingView(verdict: unknown) {
  const v = (verdict && typeof verdict === "object" ? verdict : {}) as { ok?: unknown; fund?: unknown; ext?: unknown; allow?: { fund?: unknown }; rate_bp?: unknown };
  const steps = v.ok === false || !Array.isArray(v.fund) ? [] : (v.fund as unknown[]);
  const ext = v.ok === false ? [] : readExt(v.ext);
  const lent = new Map<FundingSource["source"], number>();
  for (const step of steps as ({ k?: unknown; l?: unknown; amt?: unknown } | null)[]) {
    const amount = typeof step?.amt === "number" && step.amt > 0 ? step.amt : 0;
    if (step?.k === "l_borrow" && isLender(step.l)) lent.set(step.l, (lent.get(step.l) ?? 0) + amount);
    if (step?.k === "p_borrow") lent.set("pool", (lent.get("pool") ?? 0) + amount);
  }
  const poolRate = typeof v.rate_bp === "number" ? v.rate_bp : null;
  const sources: FundingSource[] = ([...LENDER_NAMES, "pool"] as const)
    .filter((source) => (lent.get(source) ?? 0) > 0)
    .map((source) => ({ source, amount: lent.get(source)!, rate_bp: source === "pool" ? poolRate : (ext.find((e) => e.l === source)?.r_bp ?? null) }));
  const lentInAll = sources.reduce((sum, s) => sum + s.amount, 0);
  const total = typeof v.allow?.fund === "number" && v.ok !== false ? v.allow.fund : lentInAll;
  const blended = sources.length > 0 && sources.every((s) => s.rate_bp !== null) ? Math.round(sources.reduce((sum, s) => sum + s.amount * s.rate_bp!, 0) / lentInAll) : null;
  return { total, sources, steps, ext, blended_bp: blended };
}

/**
 * POST /api/funding-plan {account, amount}: a preview run with the `fund` intent, through the same path as
 * POST /api/preview (the account's pinned build, the previews limit). pb-risk's refusals come back as the verdict with
 * HTTP 200 and no sources, as previews do: an engine from before Phase 6 refuses `fund` that way.
 */
export async function postFundingPlan(deps: Deps, body: unknown) {
  const { factory } = deps.config.ids;
  const fields = asObject(body);
  const account = fields.account;
  if (!isPrimeAccount(account, factory)) throw badRequest(`account must be a client account, <name>.${factory}`);
  if (!isU128(fields.amount) || fields.amount === "0") throw badRequest("amount must be a positive whole number of micro-USD, as a string");
  const preview = await runPreview(deps, account, { fund: { amount: fields.amount } });
  const view = fundingView(preview.verdict);
  // INTERFACES.md 51.1: what the plan posts at each lender, by its plain name ("bitcoin", "ether"). The names are
  // the account's own settings'; a read of them that fails leaves the backend's own two tokens to name bitcoin.
  const config = view.steps.length ? await soft(deps.chain.view<LenderConfig | null>(account, "get_config")).catch(() => null) : null;
  return { asked: fields.amount, ...view, posted: postedOf(view.steps, config?.value ?? null, deps.config.ids.tokens), verdict: preview.verdict, run: preview.run };
}

/** One thing a funding plan posts at a lender as collateral: the token, what it is called, and how much, in the token's own units. */
export interface Posted {
  l: LenderName;
  token: string;
  symbol: string | null;
  name: string;
  decimals: number | null;
  amount: string;
}

/**
 * What a `fund` plan's steps post as collateral (`l_supply`: `{l, tok, amt}`), named from the account's own
 * settings: a NEAR token by its list of tokens, a token on Aave's chain by its Aave settings' collateral list. A
 * token neither names is given by its id.
 */
export function postedOf(steps: unknown[], config: LenderConfig | null, fallback: TokenConfig[]): Posted[] {
  const near = [...(config?.tokens ?? []), ...fallback].filter((t): t is TokenConfig => typeof t?.id === "string" && typeof t.symbol === "string" && typeof t.decimals === "number");
  const aave = ((config?.lenders?.aave as { collateral?: unknown } | null | undefined)?.collateral ?? []) as { symbol?: unknown; address?: unknown; decimals?: unknown }[];
  const out: Posted[] = [];
  for (const step of steps as ({ k?: unknown; l?: unknown; tok?: unknown; amt?: unknown } | null)[]) {
    if (step?.k !== "l_supply" || !isLender(step.l) || typeof step.tok !== "string") continue;
    const tok = step.tok;
    const onNear = near.find((t) => t.id === tok);
    const onAave = Array.isArray(aave) ? aave.find((t) => typeof t?.address === "string" && t.address.toLowerCase() === tok.toLowerCase()) : undefined;
    const symbol = onNear?.symbol ?? (typeof onAave?.symbol === "string" ? onAave.symbol : null);
    const decimals = onNear?.decimals ?? (typeof onAave?.decimals === "number" ? onAave.decimals : null);
    out.push({ l: step.l, token: tok, symbol, name: symbol ? plainName(symbol) : tok, decimals, amount: String(step.amt ?? "0") });
  }
  return out;
}
