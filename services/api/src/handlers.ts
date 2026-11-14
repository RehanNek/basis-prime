// The endpoints of INTERFACES.md 7. Each is a function of its dependencies, so the tests run them with a
// fake chain, a fake OutLayer and a fake 1Click. Answers use the contracts' snake_case field names.
import { OneClickError, type OneClickClient, type QuoteRequest } from "@pb/oneclick";

import type { AaveApi } from "./aave.js";
import type { ActivityAnswer, TxIndexer, TxStore } from "./activity.js";
import type { KeeperCheck } from "./check.js";
import type { ApiConfig } from "./config.js";
import type { CreditAnswer, ExampleAnswer } from "./credit.js";
import type { KeeperEvent, ShimAdmin } from "./drill.js";
import { postMoveQuote } from "./hl-handlers.js";
import { postSwapQuote } from "./spot.js";
import type { EvmChain, EvmReader } from "./evm.js";
import type { GasLimits, GasWallet } from "./evm-handlers.js";
import type { HlApi, TtlCache } from "./hl.js";
import type { LenderRow } from "./lenders.js";
import type { KeyedRateLimiter, RateLimiter } from "./limiter.js";
import type { OutLayerHealth } from "./outlayer-health.js";
import type { OutLayerClient } from "./outlayer.js";
import type { PricingAnswer } from "./pricing.js";
import type { RheaTerms } from "./rhea.js";
import { NotDeployedError, type ChainReader, type ViewResult } from "./rpc.js";
import { SESSION_MS, SESSION_RECIPIENT, type Sessions } from "./session.js";
import type { Shared } from "./shared.js";
import type { Universe } from "./universe.js";
import { asObject, badRequest, HttpError, isAccountId, isPrimeAccount, isU128, parseIntent, type Intent } from "./validate.js";

export interface Deps {
  config: ApiConfig;
  chain: ChainReader;
  /** Undefined when OUTLAYER_PAYMENT_KEY is empty: previews and gateway runs are then off. */
  outlayer: Pick<OutLayerClient, "run"> | undefined;
  /** INTERFACES.md 51.15: how OutLayer has answered this backend's own runs lately (GET /api/outlayer). */
  outlayerHealth?: () => OutLayerHealth;
  /** The shim on testnet (PLAN.md 5.4). */
  oneClick: Pick<OneClickClient, "baseUrl" | "quote" | "status">;
  previews: RateLimiter;
  /** Hyperliquid testnet (Phase 3), and a short cache for its info reads. */
  hl: HlApi;
  hlCache: TtlCache;
  /** Phase 3's limits (limiter.ts). */
  limits: {
    orders: KeyedRateLimiter;
    cancels: KeyedRateLimiter;
    leverage: KeyedRateLimiter;
    submits: RateLimiter;
    gatewayRuns: RateLimiter;
    /** Phase 4: changes to the stand-in's fault switch. */
    faults?: RateLimiter;
    /** Phase 5 (limiter.ts): credit checks in all and per client address, and activity reads. */
    creditChecks?: RateLimiter;
    creditPerClient?: KeyedRateLimiter;
    activityReads?: RateLimiter;
    /** Stage 3: sends of the accounts' signed Ethereum transactions, all together. */
    evmSubmits?: RateLimiter;
    /** INTERFACES.md 49.4: checks the keeper is asked for, per account. */
    checks?: KeyedRateLimiter;
  };
  /** research/data/universe_v0.json. */
  universe: () => Promise<Universe>;
  now: () => number;
  /** Phase 4: the stand-in's fault switch; undefined when SHIM_ADMIN_TOKEN or SHIM_URL is empty. */
  shimAdmin?: ShimAdmin;
  /** Phase 4: reads the keeper's JSON-lines log (drill.ts's readJsonLines unless a test gives another). */
  readKeeperLog?: (file: string) => { found: boolean; events: KeeperEvent[] };

  // ---------- Phase 5 (INTERFACES.md 18-22) ----------
  /** Mainnet RPC, views only: Rhea's terms. */
  mainnet?: ChainReader;
  /** Hyperliquid mainnet, /info only: the worked example's BTC price. */
  hlMainnet?: Pick<HlApi, "info">;
  /** 1Click's own host, for its token list only (INTERFACES.md 49.3): a public read, sent with no key. */
  oneClickMainnet?: Pick<OneClickClient, "tokens">;
  /** The testnet transaction indexer behind the activity page. */
  indexer?: TxIndexer;
  /** Reads an OutLayer attestation record (public, no key). */
  attestations?: (url: string) => Promise<unknown>;
  /** Reads the keeper's book stress results (drill.ts's readJsonLines unless a test gives another). */
  readBookStress?: (file: string) => { found: boolean; events: KeeperEvent[] };
  /** What is kept between requests: credit check results for 60 s, the example's price, Rhea's terms, activity. */
  creditResults?: Shared<CreditAnswer>;
  examplePrice?: Shared<ExampleAnswer>;
  rheaTerms?: Shared<RheaTerms>;
  activity?: Shared<ActivityAnswer>;
  txStore?: TxStore;

  // ---------- Phase 6 (INTERFACES.md 28) ----------
  /** Aave's own API, for its mainnet terms. Read only. */
  aaveApi?: AaveApi;
  /** The chain Aave's test market is on (Base Sepolia), eth_call only. */
  evm?: EvmReader;
  /** Each lender's terms, kept 5 minutes, by "<lender>:<network>". */
  lenderTerms?: Shared<LenderRow>;
  /** Stage 2: GET /api/pricing's answer, kept 15 s. */
  pricingBook?: Shared<PricingAnswer>;

  // ---------- Stage 3 (INTERFACES.md 33) ----------
  /** Aave's chain, for balances, nonces and receipts, and for sending signed transactions. */
  evmChain?: EvmChain;
  /** Testnet's gas wallet (EVM_GAS_PRIVATE_KEY) and its limits; undefined when the key is empty. */
  gasWallet?: GasWallet;
  gasLimits?: GasLimits;
  /** Transactions already seen mined, by hash: a mined transaction's status doesn't change. */
  evmStatuses?: Map<string, "mined" | "failed">;
  /** The gas helper's wait between two looks for a receipt; tests pass one that doesn't wait. */
  sleep?: (ms: number) => Promise<void>;

  // ---------- Stage 4 (INTERFACES.md 36) ----------
  /** The committed move quotes this backend gave, so a move's status can be asked by its transfer id. */
  moves?: MoveBook;

  // ---------- Privacy level 1 (INTERFACES.md 48) ----------
  /** Sign-ins: the tokens' secret, the nonces taken, the service token. Made at start in `owner` mode; none with privacy off. */
  sessions?: Sessions;

  // ---------- The app's second shape (INTERFACES.md 49) ----------
  /** 49.4: the keeper's POST /check, with the service token. Undefined with privacy off, when there is no token to send. */
  keeperCheck?: KeeperCheck;
}

/** Where a committed move quote is paid: what 1Click's status is asked with. */
export interface KeptMove {
  depositAddress: string;
  depositMemo?: string;
}

/**
 * The backend's own record of the committed move quotes it gave: the newest for each account and transfer id
 * (`move:<n>`), kept in memory. A move that leaves Hyperliquid or Aave's chain is paid to the stand-in's float, and
 * only the quote's memo tells it from the others. The account's record doesn't keep the memo, so without this only
 * the browser that asked for the quote could follow it. A restart forgets them all.
 */
export class MoveBook {
  static readonly MAX = 2_000;
  readonly #kept = new Map<string, KeptMove>();

  remember(account: string, transfer: string, move: KeptMove) {
    const key = `${account} ${transfer}`;
    this.#kept.delete(key); // the newest goes last
    this.#kept.set(key, move);
    if (this.#kept.size > MoveBook.MAX) this.#kept.delete(this.#kept.keys().next().value!);
  }

  find(account: string, transfer: string): KeptMove | undefined {
    return this.#kept.get(`${account} ${transfer}`);
  }
}

/** The msg 1Click delivers with (ft_transfer_call), which the account books as a deposit (INTERFACES.md 4). */
export const DEPOSIT_MSG = JSON.stringify({ pb: { deposit: {} } });
/** 1Click's own default quote lifetime. */
export const QUOTE_DEADLINE_MS = 10 * 60_000;
/** 1%, the default; quotes may ask for 0.01% to 5%. */
export const DEFAULT_SLIPPAGE_BP = 100;

/** GET /api/config: the ids of INTERFACES.md 1, which of our contracts are live, and the factory's Config. */
export async function getConfig(deps: Deps) {
  const { ids } = deps.config;
  const contracts = [ids.factory, ids.pool, ...ids.tokens.map((t) => t.id), ids.drill];
  const accounts = await Promise.all(contracts.map((id) => deps.chain.account(id)));
  const deployed = Object.fromEntries(contracts.map((id, i) => [id, accounts[i]!.hasCode]));
  const factoryConfig = deployed[ids.factory] ? await soft(deps.chain.view(ids.factory, "get_config")) : null;

  return {
    network: ids.network,
    ids: {
      factory: ids.factory,
      pool: ids.pool,
      operator: ids.operator,
      keeper: ids.keeper,
      tokens: ids.tokens,
      drill: ids.drill,
      mpc: ids.mpc,
      outlayer: ids.outlayer,
      risk_project: ids.riskProject,
      gateway_project: ids.gatewayProject,
      shim_float: ids.shimFloat ?? null,
      hl_float: ids.hlFloat,
      hl_usdc_token: ids.hlUsdcToken,
      hl_usdc_asset: ids.hlUsdcAsset,
    },
    deployed,
    factory_config: factoryConfig?.value ?? null,
    preview_enabled: deps.outlayer !== undefined,
    /** Orders go through pb-gateway over OutLayer's HTTPS API, with the same payment key. */
    gateway_enabled: deps.outlayer !== undefined,
    hl_api: new URL(deps.config.hlApiUrl).host,
    /** Phase 5: credit checks run pb-risk with the same payment key. */
    credit_check_enabled: deps.outlayer !== undefined,
    /**
     * Privacy level 1 (INTERFACES.md 48.5): whether an account shows only to its owner and to us, the accounts
     * anyone may look at, and what a sign-in is signed for. A page that finds no `privacy` here treats it as off.
     */
    privacy: { mode: deps.config.accountPrivacy, open_accounts: deps.config.openAccounts, session_recipient: SESSION_RECIPIENT, session_ms: SESSION_MS },
  };
}

/** GET /api/pool: the pool's get_pool and get_params, or deployed: false. */
export async function getPool(deps: Deps) {
  const { pool } = deps.config.ids;
  try {
    const [view, params] = await Promise.all([deps.chain.view(pool, "get_pool"), deps.chain.view(pool, "get_params")]);
    return { pool_id: pool, deployed: true, block_height: Math.max(view.blockHeight, params.blockHeight), pool: view.value, params: params.value };
  } catch (error) {
    if (error instanceof NotDeployedError) return { pool_id: pool, deployed: false, reason: error.reason };
    throw error;
  }
}

/**
 * GET /api/account/:id: the account's get_state, its balance of each token, and the pool's debt_of and
 * get_borrower for it. Works for any account (a wallet has no state, but has balances). A read that needs
 * one of our contracts that isn't live yet comes back null, and the contract is listed in not_deployed.
 */
export async function getAccount(deps: Deps, accountId: string) {
  if (!isAccountId(accountId)) throw badRequest("Not a valid NEAR account id");
  const { ids } = deps.config;
  const notDeployed = new Set<string>();
  const read = <T>(contract: string, method: string, args: Record<string, unknown> = {}) =>
    soft(deps.chain.view<T>(contract, method, args), notDeployed);

  const tokens = await accountTokens(deps, accountId);
  const [account, state, debt, borrower, ...balances] = await Promise.all([
    deps.chain.account(accountId),
    read<unknown>(accountId, "get_state"),
    read<string>(ids.pool, "debt_of", { account_id: accountId }),
    read<unknown>(ids.pool, "get_borrower", { account_id: accountId }),
    ...tokens.map((t) => read<string>(t.id, "ft_balance_of", { account_id: accountId })),
  ]);
  // The account itself having no contract (or not ours) shows in has_contract and state, not here.
  notDeployed.delete(accountId);

  const heights = [state, debt, borrower, ...balances].map((r) => r?.blockHeight ?? 0);
  return {
    account_id: accountId,
    // The newest final block among the reads: the web app measures a verdict's age against it.
    block_height: Math.max(account.blockHeight, ...heights),
    exists: account.exists,
    has_contract: account.hasCode,
    state: state?.value ?? null,
    balances: tokens.map((t, i) => ({ token: t.id, symbol: t.symbol, decimals: t.decimals, amount: balances[i]?.value ?? null })),
    debt: debt?.value ?? null,
    borrower: borrower?.value ?? null,
    not_deployed: [...notDeployed].sort(),
  };
}

/** How long an account's own token list is kept. An account's settings are written once, when it is made. */
const ACCOUNT_TOKENS_TTL_MS = 10 * 60_000;

/**
 * The tokens an account's own settings list (`get_config().tokens`). Accounts made since 13 Nov list five (USDC,
 * nBTC, ETH, wNEAR, USDT: INTERFACES.md 49.6); older ones two. A wallet, an account not made yet, or settings that
 * can't be read get the backend's own two, and that answer isn't kept, so a new account shows its five at once.
 */
export async function accountTokens(deps: Deps, accountId: string): Promise<{ id: string; symbol: string; decimals: number }[]> {
  const own = await deps.hlCache
    .get(`account:tokens:${accountId}`, ACCOUNT_TOKENS_TTL_MS, async () => {
      const config = (await deps.chain.view<{ tokens?: unknown } | null>(accountId, "get_config")).value;
      const listed = Array.isArray(config?.tokens) ? (config.tokens as unknown[]) : [];
      const rows = listed.flatMap((t) => {
        const row = t as { id?: unknown; symbol?: unknown; decimals?: unknown } | null;
        return row && typeof row.id === "string" && typeof row.symbol === "string" && typeof row.decimals === "number" && Number.isInteger(row.decimals)
          ? [{ id: row.id, symbol: row.symbol, decimals: row.decimals }]
          : [];
      });
      if (rows.length === 0) throw new Error("no token list");
      return rows;
    })
    .catch(() => null);
  return own ?? deps.config.ids.tokens.map((t) => ({ id: t.id, symbol: t.symbol, decimals: t.decimals }));
}

/** The part of an account's Config (INTERFACES.md 3) that pins its pb-risk build. */
interface RiskPin {
  risk?: { project_id?: unknown; version_key?: unknown };
}

const PROJECT_ID = /^[a-z\d._-]+\/[a-z\d._-]+$/;

/**
 * POST /api/preview {account, intent}: pb-risk in preview mode over OutLayer's HTTPS API, so the UI can show
 * a verdict before anyone pays for an on-chain check. It runs the build the account pins, so the preview
 * matches what its request_check would get. pb-risk's own refusals ({"ok":false,"reason"}) come back as the
 * verdict, with HTTP 200: the run worked, the answer is no.
 */
export async function postPreview(deps: Deps, body: unknown) {
  const { ids } = deps.config;
  const fields = asObject(body);
  const account = fields.account;
  if (!isPrimeAccount(account, ids.factory)) throw badRequest(`account must be a client account, <name>.${ids.factory}`);
  const intent = parseIntent(fields.intent, ids.tokens.map((t) => t.id));
  return runPreview(deps, account, intent);
}

/** Phase 6 (INTERFACES.md 25): the intent behind POST /api/funding-plan. */
export type FundIntent = { fund: { amount: string } };

/** One preview run for a client account and an intent already checked: the pinned build, the limit, the run. */
export async function runPreview(deps: Deps, account: string, intent: Intent | FundIntent) {
  const { ids } = deps.config;
  const outlayer = deps.outlayer;
  if (!outlayer) throw new HttpError(503, "preview_off", "Previews are off: OUTLAYER_PAYMENT_KEY is empty in the backend's .env");

  let pin: RiskPin | null;
  try {
    pin = (await deps.chain.view<RiskPin | null>(account, "get_config")).value;
  } catch (error) {
    if (error instanceof NotDeployedError) {
      throw new HttpError(404, "not_deployed", `${account} has no account contract yet (${error.reason}), so there is nothing to preview`);
    }
    throw error;
  }
  const project = typeof pin?.risk?.project_id === "string" ? pin.risk.project_id : ids.riskProject;
  const versionKey = typeof pin?.risk?.version_key === "string" && pin.risk.version_key ? pin.risk.version_key : null;
  if (!PROJECT_ID.test(project)) throw new HttpError(502, "bad_config", `${account} pins an OutLayer project id that isn't owner/name`);

  if (!deps.previews.take()) throw new HttpError(429, "too_many_previews", "Too many previews this minute (each one is a paid run); try again shortly");
  const input = { mode: "preview", account, intent, network: ids.network, snapshot: false };
  const run = await outlayer.run(project, input, versionKey ?? undefined);
  if (run.status !== "completed") throw new HttpError(502, "outlayer_run", `pb-risk did not complete: ${run.error ?? run.status}`);

  return {
    account,
    intent,
    verdict: run.output,
    run: { call_id: run.callId, compute_cost: run.computeCost, time_ms: run.timeMs, attestation_url: run.attestationUrl },
    program: { project_id: project, version_key: versionKey },
  };
}

/**
 * POST /api/quote: a 1Click quote for a deposit into a client account (PLAN.md 5.4, "Deposit from any chain"):
 * {dry, originAsset, destinationAsset, amount, recipient, refundTo, slippageTolerance?}. The backend fills in
 * the rest: EXACT_INPUT, origin-chain deposit and refund, a 10-minute deadline, and the deposit msg, so 1Click
 * delivers with ft_transfer_call and the account books it.
 */
export async function postQuote(deps: Deps, body: unknown) {
  const { factory } = deps.config.ids;
  const fields = asObject(body);
  // Phase 3: moving USDC between the account and its Hyperliquid address (hl-handlers.ts).
  if (fields.move !== undefined) return postMoveQuote(deps, fields);
  // INTERFACES.md 49.3: a swap between two tokens of the account (spot.ts).
  if (fields.swap !== undefined) return postSwapQuote(deps, fields);
  if (typeof fields.dry !== "boolean") throw badRequest("dry must be true (a price) or false (a deposit address)");
  for (const name of ["originAsset", "destinationAsset", "refundTo"] as const) {
    if (typeof fields[name] !== "string" || !fields[name] || (fields[name] as string).length > 200) throw badRequest(`${name} is required`);
  }
  if (!isU128(fields.amount) || fields.amount === "0") throw badRequest("amount must be a positive whole number of the origin asset's units, as a string");
  if (!isPrimeAccount(fields.recipient, factory)) {
    throw badRequest(`recipient must be a client account, <name>.${factory}: Phase 2 quotes are deposits into an account`);
  }
  const slippage = fields.slippageTolerance ?? DEFAULT_SLIPPAGE_BP;
  if (typeof slippage !== "number" || !Number.isInteger(slippage) || slippage < 1 || slippage > 500) {
    throw badRequest("slippageTolerance must be a whole number of basis points from 1 to 500");
  }

  const request: QuoteRequest = {
    dry: fields.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: slippage,
    originAsset: fields.originAsset as string,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: fields.destinationAsset as string,
    amount: fields.amount,
    refundTo: fields.refundTo as string,
    refundType: "ORIGIN_CHAIN",
    recipient: fields.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(deps.now() + QUOTE_DEADLINE_MS).toISOString(),
    customRecipientMsg: DEPOSIT_MSG,
  };
  return oneClickCall(deps, () => deps.oneClick.quote(request));
}

/**
 * GET /api/status?depositAddress=...&depositMemo=...: 1Click's status for one deposit address.
 *
 * Or GET /api/status?account=<client account>&transfer=move:<n>: the same, for a move this backend gave the
 * committed quote for (POST /api/quote with `move`). It is found in the backend's own record of those quotes, so
 * a move home from Hyperliquid or from Aave's chain, which only its memo tells apart, can be followed by anyone who
 * reads the account, not only by the browser that started it. 404 `unknown_move` when no quote is on record.
 */
export async function getStatus(deps: Deps, query: URLSearchParams) {
  const depositAddress = query.get("depositAddress");
  const account = query.get("account");
  const transfer = query.get("transfer");
  if (!depositAddress && (account !== null || transfer !== null)) {
    const { factory } = deps.config.ids;
    if (!isPrimeAccount(account, factory)) throw badRequest(`account must be a client account, <name>.${factory}`);
    if (transfer === null || !/^move:\d{1,20}$/.test(transfer)) throw badRequest("transfer must be a move's id, move:<n>, as the account's pending transfer names it");
    const kept = deps.moves?.find(account, transfer);
    if (!kept) {
      throw new HttpError(404, "unknown_move", `No quote is on record for ${transfer} of ${account}. The backend keeps the move quotes it gave in memory, so a move from before its last start, or one it didn't quote, can only be followed with its deposit address and memo`);
    }
    return oneClickCall(deps, () => deps.oneClick.status(kept.depositAddress, kept.depositMemo));
  }
  if (!depositAddress || depositAddress.length > 200) throw badRequest("depositAddress is required, or account and transfer");
  const memo = query.get("depositMemo") || undefined;
  return oneClickCall(deps, () => deps.oneClick.status(depositAddress, memo));
}

/** 1Click's own errors pass through; not reaching it at all usually means the shim isn't running. */
export async function oneClickCall<T>(deps: Deps, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof OneClickError) throw error;
    throw new HttpError(
      502,
      "oneclick_unreachable",
      `1Click is unreachable at ${new URL(deps.oneClick.baseUrl).host}. On testnet that is the shim: pnpm --filter @pb/oneclick-shim start`,
    );
  }
}

/** A read that may hit a contract that isn't live yet: null instead of an error, and the contract noted. */
export async function soft<T>(read: Promise<ViewResult<T>>, notDeployed?: Set<string>): Promise<ViewResult<T> | null> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof NotDeployedError) {
      notDeployed?.add(error.contract);
      return null;
    }
    throw error;
  }
}
