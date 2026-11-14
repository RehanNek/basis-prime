// Fakes for the tests: a chain, a fetch, Hyperliquid, and a full set of handler dependencies.
import type { QuoteRequest, QuoteResponse, StatusResponse } from "@pb/oneclick";

import { ACTIVITY_CACHE_MS, TxStore } from "./activity.js";
import { apiConfig } from "./config.js";
import { CREDIT_SHARE_MS, EXAMPLE_PRICE_MS } from "./credit.js";
import type { EvmChain, EvmReply, EvmRequest } from "./evm.js";
import { LENDERS_CACHE_MS } from "./lenders.js";
import { PRICING_CACHE_MS } from "./pricing.js";
import { RHEA_CACHE_MS } from "./rhea.js";
import { Shared } from "./shared.js";
import { MoveBook, type Deps } from "./handlers.js";
import { TtlCache, type HlApi } from "./hl.js";
import { KeyedRateLimiter, RateLimiter } from "./limiter.js";
import type { OutLayerRun } from "./outlayer.js";
import { NotDeployedError, type AccessKeyKind, type AccountView, type ChainReader, type ViewResult } from "./rpc.js";
import type { Universe, UniverseCoin } from "./universe.js";

export const T0 = Date.UTC(2026, 10, 8, 12, 0);

/**
 * A chain made of canned views, keyed "contract.method". A contract listed in `missing` has no code;
 * an account in neither `views` nor `wallets` doesn't exist.
 */
export function fakeChain(options: {
  views?: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>;
  missing?: string[];
  wallets?: string[];
  height?: number;
  /** Privacy level 1: access keys, keyed "<account> <public key>". One not listed isn't on the account. */
  keys?: Record<string, AccessKeyKind | Error>;
}) {
  const calls: string[] = [];
  const views = options.views ?? {};
  const missing = new Set(options.missing ?? []);
  const height = options.height ?? 1000;
  const contracts = new Set(Object.keys(views).map((key) => key.slice(0, key.lastIndexOf("."))));

  const chain: ChainReader = {
    async view<T>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<ViewResult<T>> {
      calls.push(`${contract}.${method}(${JSON.stringify(args)})`);
      if (missing.has(contract)) throw new NotDeployedError(contract, "no contract code");
      const key = `${contract}.${method}`;
      if (!(key in views)) {
        if (contracts.has(contract)) throw new NotDeployedError(contract, `its contract has no ${method} method`);
        if (options.wallets?.includes(contract)) throw new NotDeployedError(contract, "no contract code");
        throw new NotDeployedError(contract, "no account");
      }
      const answer = views[key];
      if (answer instanceof Error) throw answer;
      const value = typeof answer === "function" ? (answer as (a: Record<string, unknown>) => unknown)(args) : answer;
      return { value: value as T, blockHeight: height };
    },
    async account(accountId: string): Promise<AccountView> {
      calls.push(`account(${accountId})`);
      const exists = contracts.has(accountId) || missing.has(accountId) || Boolean(options.wallets?.includes(accountId));
      return { exists, hasCode: contracts.has(accountId), blockHeight: exists ? height - 1 : 0 };
    },
    async finalBlock() {
      calls.push("finalBlock()");
      return { height, timeMs: T0 };
    },
    async accessKey(accountId: string, publicKey: string) {
      calls.push(`accessKey(${accountId})`);
      const kind = options.keys?.[`${accountId} ${publicKey}`] ?? "none";
      if (kind instanceof Error) throw kind;
      return kind;
    },
  };
  return { chain, calls };
}

/**
 * Hyperliquid made of canned info answers, keyed by request type (or "type:user"), and canned /exchange replies.
 * Every request is recorded. An answer that is an Error is thrown.
 */
export function fakeHl(options: { info?: Record<string, unknown>; exchange?: { status: number; body: unknown }[] } = {}) {
  const infoCalls: Record<string, unknown>[] = [];
  const exchangeCalls: unknown[] = [];
  const replies = [...(options.exchange ?? [])];
  const hl: HlApi = {
    async info<T>(body: Record<string, unknown>): Promise<T> {
      infoCalls.push(body);
      const key = `${String(body.type)}:${String(body.user ?? "")}`;
      const answer = options.info?.[key] ?? options.info?.[String(body.type)];
      if (answer === undefined) throw new Error(`no canned answer for ${key}`);
      if (answer instanceof Error) throw answer;
      return structuredClone(answer) as T;
    },
    async exchange(body: unknown) {
      exchangeCalls.push(body);
      return replies.shift() ?? { status: 200, body: { status: "ok", response: { type: "default" } } };
    },
  };
  return { hl, infoCalls, exchangeCalls };
}

const coin = (allowed: boolean, tier: number, sz: number, band: number): UniverseCoin => ({
  allowed,
  tier,
  hl_sz_decimals: sz,
  params: { price_band: band, client_cap_usd: 1_000_000, book_cap_usd: 3_000_000 },
});

/** A small universe: three allowed coins (one missing from testnet) and one next in line. */
export const UNIVERSE: Universe = {
  coins: [
    ["BTC", coin(true, 1, 5, 0.01)],
    ["SOL", coin(true, 2, 2, 0.02)],
    ["XRP", coin(true, 3, 0, 0.03)],
    ["TAO", coin(false, 3, 3, 0.03)],
  ],
  hash: "3d362b434adaad0e0c909605bd792232acf964b9143a95ccb2541a0f65c4c263",
};

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that records each call and answers with the next canned response. */
export function fakeFetch(...answers: { status: number; body: unknown }[]) {
  const calls: FetchCall[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const answer = answers.shift() ?? { status: 500, body: "no canned answer left" };
    const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return new Response(text, { status: answer.status });
  }) as typeof fetch;
  return { impl, calls };
}

/** Handler dependencies with every outside service faked. */
export function fakeDeps(overrides: Partial<Deps> = {}) {
  const runs: { project: string; input: unknown; versionKey: string | undefined }[] = [];
  const quotes: QuoteRequest[] = [];
  const statuses: { depositAddress: string; memo: string | undefined }[] = [];
  // Privacy is off here, so every test from before INTERFACES.md 48 means what it meant. The tests of 48 turn it on.
  const config = apiConfig({ NEAR_NETWORK: "testnet", SHIM_NEAR_ACCOUNT_ID: "shim.pbf-ops.testnet", ACCOUNT_PRIVACY: "off" });

  const deps: Deps = {
    config,
    chain: fakeChain({}).chain,
    outlayer: {
      async run(project: string, input: unknown, versionKey?: string): Promise<OutLayerRun> {
        runs.push({ project, input, versionKey });
        return {
          callId: "call-1",
          status: "completed",
          output: { ok: true, v: 1, state: "HEALTHY", allow: { borrow: 24_150_000_000, withdraw: 0 } },
          error: null,
          computeCost: "1000",
          timeMs: 812,
          attestationUrl: "https://testnet-api.outlayer.ai/attestations/by-call/call-1",
        };
      },
    },
    oneClick: {
      baseUrl: "http://localhost:8787",
      async quote(request: QuoteRequest): Promise<QuoteResponse> {
        quotes.push(request);
        return { correlationId: "q-1", quoteRequest: request, quote: { amountOut: "99000000" } } as QuoteResponse;
      },
      async status(depositAddress: string, memo?: string | null): Promise<StatusResponse> {
        statuses.push({ depositAddress, memo: memo ?? undefined });
        return { correlationId: "q-1", status: "PROCESSING" } as StatusResponse;
      },
    },
    previews: new RateLimiter(20, 60_000, () => T0),
    hl: fakeHl().hl,
    hlCache: new TtlCache(() => T0),
    limits: {
      orders: new KeyedRateLimiter(60, 60_000, () => T0),
      cancels: new KeyedRateLimiter(60, 60_000, () => T0),
      leverage: new KeyedRateLimiter(6, 60_000, () => T0),
      submits: new RateLimiter(30, 60_000, () => T0),
      gatewayRuns: new RateLimiter(240, 60_000, () => T0),
      creditChecks: new RateLimiter(6, 60_000, () => T0),
      creditPerClient: new KeyedRateLimiter(2, 60_000, () => T0),
      activityReads: new RateLimiter(30, 60_000, () => T0),
    },
    universe: async () => UNIVERSE,
    now: () => T0,
    creditResults: new Shared(CREDIT_SHARE_MS),
    examplePrice: new Shared(EXAMPLE_PRICE_MS),
    rheaTerms: new Shared(RHEA_CACHE_MS),
    activity: new Shared(ACTIVITY_CACHE_MS),
    txStore: new TxStore(),
    lenderTerms: new Shared(LENDERS_CACHE_MS),
    pricingBook: new Shared(PRICING_CACHE_MS),
    moves: new MoveBook(),
    ...overrides,
  };
  return { deps, runs, quotes, statuses };
}

/**
 * Stage 3: Aave's chain made of one function. `answer` gives each request's result (a value), or an error in the
 * node's words (`{error: "…"}`); every request is recorded in the order asked.
 */
export function fakeEvmChain(answer: (request: EvmRequest) => unknown, chainId = 84_532) {
  const asked: EvmRequest[] = [];
  const reply = (request: EvmRequest): EvmReply => {
    asked.push(request);
    const value = answer(request);
    const refused = value as { error?: unknown } | null;
    if (refused && typeof refused === "object" && typeof refused.error === "string") return { ok: false, error: refused.error, code: -32_000 };
    return { ok: true, result: value ?? null };
  };
  const chain: EvmChain = {
    async batch(requests) {
      return { chainId, replies: requests.map(reply) };
    },
    async calls(calls) {
      const results = calls.map((call) => {
        const r = reply({ method: "eth_call", params: [{ to: call.to, data: call.data }, "latest"] });
        if (!r.ok) throw new Error(r.error);
        return String(r.result);
      });
      return { chainId, results };
    },
  };
  return { chain, asked };
}
