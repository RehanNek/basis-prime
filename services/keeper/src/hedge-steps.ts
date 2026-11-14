// The Phase 3 gate's steps (PLAN.md 11.4; INTERFACES.md 8-12), each a function of a `World`: the chain, the backend,
// Hyperliquid's info API, the float tools and a signer. hedge-demo.ts gives it the real ones; the tests give fakes.
//
//    1 create        create_account (6 NEAR since Phase 6, stage 2: the account's code grew), owned by the keeper. A gate may
//                    pass the owner's funding permission, which the factory hands to the new account
//    2 deposit       mint and deposit mUSDC and mNBTC
//    3 hl_init       derive the Hyperliquid address; record the gas the MPC signer's derived_public_key burnt
//    4 to_hl         a move quote, withdraw to its deposit address, the status until SUCCESS, the balance on Hyperliquid
//    5 agent         request_agent, until hl.agent is set
//    6 approve       hl_approve_agent, /api/hl/submit, until extraAgents lists the agent
//    7 short         the float bids; IOC sells through /api/order until the target size; the float's leftover cancelled
//    8 borrow        a preview, an on-chain borrow check for the line less 0.5%, then borrow
//      take_out      a withdrawal check, then the loan's mUSDC goes to the keeper ("the client takes the loan out",
//                    PLAN.md 2 step 5.5): the engine assumes a loan leaves the account (RISK_ENGINE.md 7.2), and with
//                    the loan still in the account, closing the short is let through
//    9 refuse_close  with the loan out, closing the whole short is refused
//      burst         40 small orders that add to the short, at once; afterwards the account must still be within the checks
//      refuse_coin   a coin outside the allow-list is refused with P1
//   10 repay (the keeper puts the loan back first), close_short, home (hl_withdraw, submit, delivered), withdraw
//      (both tokens, no verdict)
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";

import { VERDICT_WAIT_MS } from "./config.js";
import { belowLimit, BTC_SZ_DECIMALS, cancelMessage, coinSz, creditHolds, EXPIRY_MS, gatePx, gatewayRecord, HL_TESTNET_REACH_BP, orderLifeOf, orderMessage, poolRoom, positionSize, sizeAtLeast, tallyBurst, underLine, type Auth, type BorrowerView, type GateCoin, type GatewayAnswer, type GatewayRecord, type OrderFields, type ParamsView, type Plan, type PoolView, type Runner, type StepContext, type StepOutcome, type TxRecord } from "./hedge-kit.js";

export interface TxResult extends TxRecord {
  /** The transaction's return value (the last receipt's), when it succeeded. */
  result?: unknown;
  logs: string[];
}

export interface World {
  account: string;
  owner: string;
  ids: { factory: string; pool: string; musdc: string; mnbtc: string; mpc: string; hlFloat: string };
  near: {
    call(contract: string, method: string, args: Record<string, unknown>, options: { tgas: number; deposit: bigint; label: string }): Promise<TxResult>;
    view<T>(contract: string, method: string, args?: Record<string, unknown>): Promise<T>;
    exists(account: string): Promise<boolean>;
    /** The final block's timestamp, in ms. */
    finalBlockMs(): Promise<number>;
  };
  /** The backend, at API_URL. */
  api: {
    get(path: string): Promise<{ status: number; body: unknown }>;
    post(path: string, body: unknown, timeoutMs?: number): Promise<{ status: number; body: unknown }>;
  };
  /** Hyperliquid testnet's info API, read only. */
  hl: { info<T>(body: Record<string, unknown>): Promise<T> };
  /** services/oneclick-shim's float tools. */
  float: {
    order(order: { side: "buy" | "sell"; sz: string; px: string; tif: "Gtc" | "Ioc" }): Promise<{ oid: number | null; text: string }>;
    cancel(oid: number | null): Promise<string>;
    close(): Promise<string>;
  };
  /** Signs an order or cancel message for pb-gateway as the owner (NEP-413). */
  sign(message: string): Promise<Auth>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
  /** INTERFACES.md 51.1: the coin the gate hedges and the token it posts. Left out: BTC and test nBTC, as before. */
  coin?: GateCoin;
}

/** The gate's coin on Hyperliquid, its size decimals, a size as Hyperliquid writes it, and its collateral token on NEAR. */
export const coinOf = (w: World): string => w.coin?.coin ?? "BTC";
const szDec = (w: World): number => w.coin?.szDecimals ?? BTC_SZ_DECIMALS;
const szText = (w: World, size: number): string => coinSz(size, szDec(w));
export const collateralOf = (w: World): string => w.coin?.token ?? w.ids.mnbtc;

const TGAS_ACCOUNT = 300;
const ONE_YOCTO = 1n;
const CHECK_DEPOSIT = 10n ** 22n; // 0.01 NEAR
const STORAGE = 1_250_000_000_000_000_000_000n; // the test tokens' storage_balance_bounds().min
/**
 * What the factory asks for a new account (its MIN_DEPOSIT): 6 NEAR. It was 4 up to Phase 5 and 5 in stage 1. With Rhea's
 * steps the account's code is 471,865 bytes and locks 4.73 NEAR, and Rhea's registration takes 0.1 more. A smaller
 * creation is refused and refunded (INTERFACES.md 24, point 9).
 */
export const CREATE_DEPOSIT = 6n * 10n ** 24n;

/**
 * Polls `read` every `everyMs` until `done` says yes, or throws after `timeoutMs` saying what it waited for. With
 * `show`, the words also say what the last read saw, so a wait that runs out tells how far things got.
 */
export async function until<T>(w: World, what: string, timeoutMs: number, everyMs: number, read: () => Promise<T>, done: (value: T) => boolean, show?: (value: T) => string): Promise<T> {
  const deadline = w.now() + timeoutMs;
  let last: T | undefined;
  let lastError: unknown;
  for (;;) {
    try {
      last = await read();
      if (done(last)) return last;
    } catch (error) {
      lastError = error;
    }
    if (w.now() >= deadline) {
      const seen = show && last !== undefined ? `; last seen: ${show(last)}` : "";
      const why = lastError instanceof Error ? `; last error: ${lastError.message}` : "";
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${seen}${why}`);
    }
    await w.sleep(everyMs);
  }
}

export interface HlAnswer {
  owner: string;
  near_time_ms: number;
  /**
   * `open_sends` and `send_floor_until_ms` (INTERFACES.md 50.2) show on accounts made after that deploy: the nonces
   * of the transfers out of Hyperliquid no accepted check has shown as sent, and the floor a ninth open one leaves.
   */
  hl: { address: string | null; agent?: { address: string } | null; signed?: { index: number; kind: string }[]; send_open_until_ms?: string; open_sends?: string[]; send_floor_until_ms?: string } | null;
  gateway: unknown;
  hyperliquid: {
    clearinghouse_state: { crossMarginSummary: { accountValue: string }; withdrawable: string; assetPositions: unknown[] } | null;
    spot_usdc: { total: string } | null;
    open_orders: { coin: string; oid: number; side: string; sz: string; limitPx: string }[] | null;
    agents: { address: string; validUntil: number | null }[] | null;
  } | null;
}

export async function hlState(w: World, fresh = false): Promise<HlAnswer> {
  const { status, body } = await w.api.get(`/api/hl/${w.account}${fresh ? "?fresh=1" : ""}`);
  if (status !== 200) throw new Error(`GET /api/hl answered HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body as HlAnswer;
}

export async function state(w: World) {
  return w.near.view<{ owner: string; counter: number; loan: { principal: string; open?: boolean }; verdict: { intent?: unknown; received_block: number; verdict: Record<string, unknown> } | null; hl?: HlAnswer["hl"] }>(w.account, "get_state");
}

/** Testnet's BTC (or another coin's) mark price, oracle price and szDecimals, read by name. */
export async function market(w: World, coin: string): Promise<{ mark: number; oracle: number; szDecimals: number }> {
  const [meta, ctxs] = await w.hl.info<[{ universe: { name: string; szDecimals: number; isDelisted?: boolean }[] }, { markPx: string; oraclePx?: string }[]]>({ type: "metaAndAssetCtxs" });
  const i = meta.universe.findIndex((u) => u.name === coin);
  if (i < 0 || meta.universe[i]!.isDelisted) throw new Error(`${coin} isn't listed on Hyperliquid testnet`);
  return { mark: Number(ctxs[i]!.markPx), oracle: Number(ctxs[i]!.oraclePx), szDecimals: meta.universe[i]!.szDecimals };
}

/**
 * The top of Hyperliquid's real book for a coin (info `l2Book`: `levels` holds the bids, then the asks, best first;
 * read on testnet on 12 Nov). NaN for a side that is empty, or when the book couldn't be read: the mark then stands
 * in for it (hedge-kit's gatePx).
 */
export async function bookTop(w: World, coin: string): Promise<{ bestBid: number; bestAsk: number }> {
  try {
    const book = await w.hl.info<{ levels?: { px?: string }[][] }>({ type: "l2Book", coin });
    const best = (side: number) => Number(book.levels?.[side]?.[0]?.px ?? Number.NaN);
    return { bestBid: best(0), bestAsk: best(1) };
  } catch {
    return { bestBid: Number.NaN, bestAsk: Number.NaN };
  }
}

/**
 * The band the account's own pinned gateway uses for a coin, in bp (P2): the backend's GET /api/markets?account=
 * (INTERFACES.md 42). This is the one place the gates take the band from. An account that isn't made yet gets the
 * band of the gateway the factory pins, which is the one it will have.
 */
export async function gatewayBand(w: World, coin: string): Promise<{ bandBp: number; from: unknown; gateway: unknown; orderLifeMs: number }> {
  const { status, body } = await w.api.get(`/api/markets?account=${encodeURIComponent(w.account)}`).catch((error: unknown) => {
    throw new Error(`the backend didn't answer GET /api/markets (${error instanceof Error ? error.message : String(error)}): the gate takes the price band of the account's gateway from it`);
  });
  const answer = (body ?? {}) as { coins?: { coin: string; band_bp?: unknown }[]; band_from?: unknown; gateway_version?: unknown; message?: unknown };
  const band = answer.coins?.find((c) => c.coin === coin)?.band_bp;
  if (status !== 200 || typeof band !== "number" || !(band > 0)) {
    throw new Error(`the backend's GET /api/markets gave no price band for ${coin} (HTTP ${status}${answer.message ? `: ${String(answer.message)}` : ""}): the gate prices its orders inside the band of the account's gateway, and takes it from there`);
  }
  // The same answer says how long to sign an order for on that gateway (INTERFACES.md 50.4); 110 s when it doesn't.
  return { bandBp: band, from: answer.band_from ?? null, gateway: answer.gateway_version ?? null, orderLifeMs: orderLifeOf(body) };
}

/**
 * How long to sign an order or a cancel for on the account's own gateway, in ms: the backend's `order_life_ms`
 * (INTERFACES.md 50.4), for a step that doesn't read the band. 110 s when the backend doesn't answer or doesn't say.
 */
export async function orderLife(w: World): Promise<number> {
  try {
    const { status, body } = await w.api.get(`/api/markets?account=${encodeURIComponent(w.account)}`);
    return status === 200 ? orderLifeOf(body) : EXPIRY_MS;
  } catch {
    return EXPIRY_MS;
  }
}

/** What the gate prices an order from, read now: the mark and the oracle price, the book's top, and the gateway's band. */
export async function priceFacts(w: World, coin: string) {
  const [m, book, band] = await Promise.all([market(w, coin), bookTop(w, coin), gatewayBand(w, coin)]);
  return { mark: m.mark, oracle: m.oracle, ...book, bandBp: band.bandBp, venueBp: HL_TESTNET_REACH_BP, band_from: band.from, gateway: band.gateway, orderLifeMs: band.orderLifeMs };
}

/** One order or cancel through the backend, signed now. */
async function sendSigned(w: World, step: StepContext, label: string, message: string, path: "/api/order" | "/api/cancel", timeoutMs?: number): Promise<GatewayRecord & { answer: GatewayAnswer }> {
  const auth = await w.sign(message);
  const started = w.now();
  let status: number;
  let body: GatewayAnswer;
  try {
    const answer = await w.api.post(path, { account: w.account, auth }, timeoutMs);
    status = answer.status;
    body = (answer.body ?? {}) as GatewayAnswer;
  } catch (error) {
    status = 0;
    body = { error: "unreachable", message: error instanceof Error ? error.message : String(error) };
  }
  const record = gatewayRecord(label, status, body, Math.round((w.now() - started) / 100) / 10);
  step.gateway(record);
  return { ...record, answer: body };
}

async function expiry(w: World, aheadMs = EXPIRY_MS): Promise<number> {
  return (await w.near.finalBlockMs()) + aheadMs;
}

function order(coin: string, isBuy: boolean, sz: string, px: string, tif: OrderFields["tif"], reduceOnly = false): OrderFields {
  return { coin, is_buy: isBuy, sz, limit_px: px, reduce_only: reduceOnly, tif };
}

/** Sends a signed transaction and records it; throws with the contract's words if it failed. */
export async function call(w: World, step: StepContext, contract: string, method: string, args: Record<string, unknown>, tgas: number, deposit: bigint, label: string): Promise<TxResult> {
  const tx = await w.near.call(contract, method, args, { tgas, deposit, label });
  step.tx(tx);
  if (!tx.ok) throw new Error(`${label} failed: ${tx.failure ?? "no reason given"} (tx ${tx.hash})`);
  return tx;
}

/**
 * A call whose answer comes back through OutLayer (request_check, request_agent). Its transaction ends only when
 * the run has had its turn in OutLayer's queue, and the RPC can stop waiting before that: no outcome comes back, and
 * that is not a failure. Only a failure the chain reported stops the step; the caller then waits for what the call
 * brings (`waitFor`, which says so if it never comes).
 */
export async function callForVerdict(w: World, step: StepContext, contract: string, method: string, args: Record<string, unknown>, tgas: number, deposit: bigint, label: string): Promise<TxResult> {
  const tx = await w.near.call(contract, method, args, { tgas, deposit, label });
  step.tx(tx);
  if (!tx.ok && tx.hash !== null) throw new Error(`${label} failed: ${tx.failure ?? "no reason given"} (tx ${tx.hash})`);
  return tx;
}

/** `until`, for what such a call brings: up to VERDICT_WAIT_MS, and a timeout says what became of the call itself. */
export async function waitFor<T>(w: World, tx: TxResult, what: string, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  return until(w, what, VERDICT_WAIT_MS, 3_000, read, done).catch((error: unknown) => {
    const unseen = !tx.ok && tx.hash === null ? ` (the call's own end wasn't seen: ${tx.failure ?? "no reason given"})` : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${unseen}`);
  });
}

// ---------- the steps ----------

export interface Gate {
  runner: Runner;
  plan: Plan;
  world: World;
  name: string;
  /**
   * Phase 6 (INTERFACES.md 25): the owner's funding permission, signed with the account's opening:
   * `create_account(name, owner, permission)`. Left out, the account is opened with none, as before.
   */
  permission?: Record<string, unknown>;
}

/** The same JSON, whatever order its keys come in: for comparing a permission as asked with one as stored. */
export function sameJson(a: unknown, b: unknown): boolean {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, sorted(x)])) : v;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

export async function stepCreate({ runner, world: w, name, permission }: Gate) {
  const label = permission ? `create ${w.account}, owned by ${w.owner}, with the funding permission in the same signature` : `create ${w.account}, owned by ${w.owner}`;
  await runner.run("create", label, {}, async (step) => {
    let created = false;
    if (!(await w.near.exists(w.account))) {
      await call(w, step, w.ids.factory, "create_account", { name, owner: w.owner, ...(permission ? { permission } : {}) }, 300, CREATE_DEPOSIT, "create_account");
      await until(w, `${w.account} to exist`, 60_000, 2_000, () => w.near.exists(w.account), Boolean);
      created = true;
    }
    const st = await state(w);
    if (st.owner !== w.owner) throw new Error(`${w.account} belongs to ${st.owner}, not ${w.owner}`);
    const config = await w.near.view<{ gateway?: { project_id: string; version_key: string; secrets_ref: unknown }; risk: { version_key: string } }>(w.account, "get_config");
    if (!config.gateway?.version_key) throw new Error(`${w.account} has no pinned pb-gateway: it was made before Phase 3`);
    runner.record.context.gateway = config.gateway;
    runner.record.context.risk_version = config.risk.version_key;
    // The permission must be the one asked for, as the account stores it: an account that existed already, or was
    // made by a factory from before Phase 6, would hold another or none.
    const stored = (st as { permission?: unknown }).permission ?? null;
    if (permission && !sameJson(stored, permission)) {
      return { ok: false, detail: { why: `${w.account} doesn't hold the permission asked for${created ? ": the factory didn't pass it on (is it the Phase 6 factory?)" : ", and it existed already: use a new --name"}`, asked: permission, stored, created } };
    }
    return { ok: true, detail: { gateway: config.gateway, risk_version: config.risk.version_key, counter: st.counter, created, ...(permission ? { permission: stored } : {}) } };
  });
}

export async function stepDeposit({ runner, plan, world: w }: Gate) {
  await runner.run("deposit", "mint and deposit mUSDC and mNBTC", {}, async (step) => {
    for (const [token, amount] of [[w.ids.musdc, plan.deposit_usdc_micro], [collateralOf(w), plan.deposit_nbtc_units]] as const) {
      await call(w, step, token, "mint", { account_id: w.owner, amount }, 30, STORAGE, `mint ${token}`);
      await call(w, step, token, "ft_transfer_call", { receiver_id: w.account, amount, msg: "" }, 100, ONE_YOCTO, `deposit ${token}`);
    }
    const balances = {
      musdc: await w.near.view<string>(w.ids.musdc, "ft_balance_of", { account_id: w.account }),
      mnbtc: await w.near.view<string>(collateralOf(w), "ft_balance_of", { account_id: w.account }),
    };
    return { ok: BigInt(balances.musdc) >= BigInt(plan.deposit_usdc_micro) && BigInt(balances.mnbtc) >= BigInt(plan.deposit_nbtc_units), detail: { balances } };
  });
}

export async function stepHlInit({ runner, world: w }: Gate) {
  await runner.run("hl_init", "hl_init: the Hyperliquid address through Chain Signatures", {}, async (step) => {
    const tx = await call(w, step, w.account, "hl_init", {}, 100, 0n, "hl_init");
    const mpc = (tx.receipts ?? []).filter((r) => r.executor === w.ids.mpc);
    const st = await state(w);
    const address = st.hl?.address ?? null;
    runner.record.context.hl_address = address;
    return {
      ok: Boolean(address),
      detail: { address, returned: tx.result, derived_public_key_gas_tgas: mpc.reduce((sum, r) => sum + r.gas_tgas, 0), mpc_receipts: mpc, tx_gas_tgas: tx.gas_tgas },
    };
  });
}

/** Polls 1Click's status (the shim) for a deposit address until it is final. */
export async function settle(w: World, depositAddress: string, memo: string | null | undefined, timeoutMs: number) {
  const query = new URLSearchParams(memo ? { depositAddress, depositMemo: memo } : { depositAddress });
  const seen: string[] = [];
  const final = await until(
    w,
    `1Click's status for ${depositAddress} to be final`,
    timeoutMs,
    5_000,
    async () => {
      const { status, body } = await w.api.get(`/api/status?${query}`);
      if (status !== 200) throw new Error(`GET /api/status answered HTTP ${status}`);
      const s = (body as { status: string }).status;
      if (seen.at(-1) !== s) seen.push(s);
      return body as { status: string; swapDetails?: { refundReason?: string } };
    },
    (b) => ["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"].includes(b.status),
  );
  return { final, seen };
}

export async function stepToHl({ runner, plan, world: w }: Gate) {
  await runner.run("to_hl", `move ${Number(plan.to_hl_micro) / 1e6} USDC to Hyperliquid`, {}, async (step) => {
    const started = w.now();
    const { status, body } = await w.api.post("/api/quote", { dry: false, move: "to_hl", account: w.account, amount: plan.to_hl_micro });
    if (status !== 200) throw new Error(`the move quote failed: HTTP ${status} ${JSON.stringify(body).slice(0, 300)}`);
    const quote = body as { correlationId: string; quote: { depositAddress: string; amountIn: string; amountOut: string; amountOutFormatted: string; timeEstimate: number }; move: { next: { method: string; args: Record<string, unknown> } } };
    if (quote.move.next?.method !== "withdraw") throw new Error("the quote has no withdraw to send");
    runner.record.context.to_hl_quote = { correlationId: quote.correlationId, depositAddress: quote.quote.depositAddress, amountIn: quote.quote.amountIn, amountOut: quote.quote.amountOut };
    await call(w, step, w.account, "withdraw", quote.move.next.args, TGAS_ACCOUNT, ONE_YOCTO, "withdraw to the deposit address");
    const { final, seen } = await settle(w, quote.quote.depositAddress, null, (quote.quote.timeEstimate + 300) * 1000);
    if (final.status !== "SUCCESS") return { ok: false, detail: { status: final.status, seen, reason: final.swapDetails?.refundReason } };
    const expected = Number(quote.quote.amountOut) / 1e8;
    const hl = await until(w, `the USDC to show on Hyperliquid (about ${expected})`, 120_000, 3_000, () => hlState(w), (a) => equity(a) >= expected * 0.95);
    return { ok: true, detail: { statuses: seen, delivered: quote.quote.amountOutFormatted, hl_equity: equity(hl), seconds_to_hl: Math.round((w.now() - started) / 1000) } };
  });
}

/** The address's USDC on Hyperliquid: perps, plus spot for a unified account (INTERFACES.md 9, "As built"). */
function equity(a: HlAnswer): number {
  const perps = Number(a.hyperliquid?.clearinghouse_state?.crossMarginSummary.accountValue ?? 0);
  return perps + Number(a.hyperliquid?.spot_usdc?.total ?? 0);
}

export async function stepAgent({ runner, world: w }: Gate) {
  await runner.run("agent", "request_agent: pb-gateway names the agent, on-chain", {}, async (step) => {
    const tx = await callForVerdict(w, step, w.account, "request_agent", {}, TGAS_ACCOUNT, CHECK_DEPOSIT, "request_agent");
    const st = await waitFor(w, tx, "hl.agent", () => state(w), (s) => Boolean(s.hl?.agent));
    runner.record.context.agent = st.hl?.agent?.address;
    return { ok: true, detail: { agent: st.hl?.agent, returned: tx.result } };
  });
}

/** The newest signed entry of a kind, from the transaction's result or, failing that, from get_state. */
export async function signedIndex(w: World, tx: TxResult, kind: string, after: number): Promise<number> {
  const returned = tx.result as { index?: unknown; kind?: unknown } | null | undefined;
  if (returned && typeof returned.index === "number" && returned.kind === kind) return returned.index;
  const st = await until(w, `a new ${kind} in hl.signed`, 60_000, 2_500, () => state(w), (s) => (s.hl?.signed ?? []).some((e) => e.kind === kind && e.index > after));
  return Math.max(...(st.hl?.signed ?? []).filter((e) => e.kind === kind && e.index > after).map((e) => e.index));
}

export async function submit(w: World, step: StepContext, index: number, label: string) {
  const started = w.now();
  const { status, body } = await w.api.post("/api/hl/submit", { account: w.account, index });
  const answer = (body ?? {}) as { ok?: boolean; hl?: unknown; message?: string };
  step.gateway({ label, http_status: status, ok: status === 200 && answer.ok === true, reason: status === 200 ? JSON.stringify(answer.hl).slice(0, 300) : (answer.message ?? null), seconds: Math.round((w.now() - started) / 100) / 10 });
  return { ok: status === 200 && answer.ok === true, answer };
}

export async function stepApprove({ runner, world: w }: Gate) {
  await runner.run("approve", "hl_approve_agent, post it, until Hyperliquid lists the agent", {}, async (step) => {
    const before = await state(w);
    const after = Math.max(-1, ...(before.hl?.signed ?? []).map((e) => e.index));
    const agent = before.hl?.agent?.address?.toLowerCase();
    if (!agent) throw new Error("no agent yet");
    // Hyperliquid takes an agent's approval once: a second one is answered "Extra agent already used" (seen on
    // 12 Nov). So a run that goes on with an account whose approval already arrived reads the list first, and
    // signs and posts nothing.
    const listedBefore = (await hlState(w, true).catch(() => null))?.hyperliquid?.agents?.find((x) => x.address.toLowerCase() === agent);
    if (listedBefore) return { ok: true, detail: { agent, listed: listedBefore, already_listed: true } };
    const tx = await call(w, step, w.account, "hl_approve_agent", {}, TGAS_ACCOUNT, ONE_YOCTO, "hl_approve_agent");
    const index = await signedIndex(w, tx, "approveAgent", after);
    const posted = await submit(w, step, index, `submit approveAgent #${index}`);
    // A post Hyperliquid had already taken (the first try reached it and a retry was answered "duplicate nonce", as
    // on 12 Nov, right after its testnet API came back) is not a failure: the list below decides.
    const taken = !posted.ok && /duplicate nonce/i.test(JSON.stringify(posted.answer ?? ""));
    if (!posted.ok && !taken) return { ok: false, detail: { index, hl: posted.answer } };
    const hl = await until(w, "extraAgents to list the agent", 90_000, 3_000, () => hlState(w, true), (a) => (a.hyperliquid?.agents ?? []).some((x) => x.address.toLowerCase() === agent));
    const listed = hl.hyperliquid!.agents!.find((x) => x.address.toLowerCase() === agent);
    return { ok: true, detail: { index, agent, listed, mpc_receipts: (tx.receipts ?? []).filter((r) => r.executor === w.ids.mpc) } };
  });
}

/** The float rests one side; the account's IOC orders take it until `target` is done. Leftover float orders are cancelled. */
async function tradeAgainstFloat(
  w: World,
  step: StepContext,
  side: "sell" | "buy",
  targetSz: number,
  px: string,
  reduceOnly: boolean,
  labelPrefix: string,
  context: Record<string, unknown>,
  /** How long each order is signed for: the account's `order_life_ms` (INTERFACES.md 50.4). */
  lifeMs: number = EXPIRY_MS,
) {
  const floatOrder = await w.float.order({ side: side === "sell" ? "buy" : "sell", sz: szText(w, targetSz), px, tif: "Gtc" });
  context.float_open_oid = floatOrder.oid;
  let remaining = targetSz;
  let dust: string | null = null;
  const orders: GatewayRecord[] = [];
  try {
    for (let attempt = 0; attempt < 8 && remaining >= 0.00001; attempt++) {
      // The gateway takes no order under $10 (INTERFACES.md 9). Opening, a small remainder goes as a $10.5 order,
      // a few dollars over; closing (reduce-only) can't go over the position, so a remainder under $10 stays, reported.
      let sz = remaining;
      if (remaining * Number(px) < 10) {
        if (reduceOnly) {
          dust = `${szText(w, remaining)} ${coinOf(w)} is left: under Hyperliquid's $10 minimum, which the gateway applies to reduce-only orders too`;
          break;
        }
        sz = Number(sizeAtLeast(10.5, Number(px), szDec(w)));
      }
      const message = orderMessage(w.account, order(coinOf(w), side === "buy", szText(w, sz), px, "Ioc", reduceOnly), await expiry(w, lifeMs));
      const r = await sendSigned(w, step, `${labelPrefix} ${side} ${szText(w, sz)} ${coinOf(w)} at ${px} (IOC)`, message, "/api/order");
      orders.push(r);
      if (r.ok) {
        remaining = Number((remaining - Number(r.filled_sz ?? 0)).toFixed(5));
        if (Number(r.filled_sz ?? 0) === 0) await w.sleep(2_000);
      } else if (r.code === "P0" || r.code === "HL" || r.code === "READ" || r.http_status === 0 || r.http_status >= 500) {
        // Another order in flight (P0), nothing to match yet (HL), a read or the backend that failed: wait and try again.
        await w.sleep(3_000);
      } else {
        throw new Error(`the gateway refused: ${r.code} ${r.reason ?? ""}`);
      }
    }
  } finally {
    if (floatOrder.oid !== null) {
      await w.float.cancel(floatOrder.oid).catch((error: unknown) => w.log(`  could not cancel the float's order ${floatOrder.oid}: ${String(error)}`));
    }
    context.float_open_oid = null;
  }
  return { remaining, dust, orders, float_order: floatOrder };
}

export async function stepShort({ runner, plan, world: w }: Gate) {
  await runner.run("short", `open the short: ${plan.short_sz} ${coinOf(w)} through the gateway`, {}, async (step) => {
    const before = await hlState(w);
    const held = -positionSize(before.hyperliquid?.clearinghouse_state, coinOf(w));
    const target = Number(plan.short_sz) - Math.max(0, held);
    if (target < 0.00001) return { ok: true, detail: { already_short: held } };
    // The float's bid, 0.3% under the mark, inside the band of the account's gateway (hedge-kit's gatePx). A short
    // that couldn't be closed through the gateway isn't opened: the closing price must exist now too.
    const facts = await priceFacts(w, coinOf(w));
    const [bid, ask] = [gatePx("under", facts, szDec(w)), gatePx("over", facts, szDec(w))];
    if ("problem" in bid) throw new Error(`${bid.problem}. Nothing was posted`);
    if ("problem" in ask) throw new Error(`${ask.problem}. A short opened now couldn't be closed through the gateway, so it isn't opened: nothing was posted`);
    const { mark } = facts;
    const px = bid.px;
    await floatHasRoom(w, target);
    const traded = await tradeAgainstFloat(w, step, "sell", target, px, false, "short:", runner.record.context, facts.orderLifeMs);
    const after = await until(w, "the short to show", 30_000, 2_500, () => hlState(w), (a) => -positionSize(a.hyperliquid?.clearinghouse_state, coinOf(w)) > held);
    const short = -positionSize(after.hyperliquid?.clearinghouse_state, coinOf(w));
    runner.record.context.short_sz = short;
    return { ok: short >= Number(plan.short_sz) * 0.99, detail: { mark, oracle: facts.oracle, band_bp: facts.bandBp, band_from: facts.band_from, order_life_ms: facts.orderLifeMs, px, could_close_at: ask.px, short, remaining: traded.remaining, float_order: traded.float_order.text } };
  });
}

/**
 * How much BTC the float can still trade, from Hyperliquid's `activeAssetData` (info-endpoint/perpetuals,
 * "Retrieve user's active asset data"): `maxTradeSzs`, at its leverage and free margin. Read on 8 Nov: 20x cross,
 * 0.20866 BTC either way on 790.6 USDC.
 */
export async function floatRoom(w: World): Promise<{ maxSz: number; leverage: unknown }> {
  const d = await w.hl.info<{ maxTradeSzs: [string, string]; leverage: unknown }>({ type: "activeAssetData", user: w.ids.hlFloat, coin: coinOf(w) });
  return { maxSz: Math.min(...d.maxTradeSzs.map(Number)), leverage: d.leverage };
}

/** The float must be able to carry its side: refuses before posting if it can't. */
async function floatHasRoom(w: World, sizeBtc: number) {
  const room = await floatRoom(w);
  if (room.maxSz < sizeBtc) {
    throw new Error(`the float can trade ${room.maxSz} ${coinOf(w)} on Hyperliquid testnet, and its side is ${sizeBtc}: top up ${w.ids.hlFloat} (research/day1.md 2) and run float:to-perps`);
  }
}

/**
 * Can the float carry a whole run of this plan? The stand-in delivers the move to Hyperliquid from the float's perps
 * USDC (usdSend, services/oneclick-shim/src/hl-float.ts), and the float takes the other side of every trade, so it
 * needs the move plus margin for its largest side: a tenth of that side's notional covers 20x cross margin twice
 * over, and the fees. `problem` is null when it can.
 */
export async function floatCheck(w: World, plan: Plan) {
  const room = await floatRoom(w);
  const perps = await w.hl.info<{ withdrawable?: string }>({ type: "clearinghouseState", user: w.ids.hlFloat });
  const withdrawable = Number(perps.withdrawable ?? 0);
  const toHl = Number(plan.to_hl_micro) / 1e6;
  const side = Math.max(Number(plan.short_sz), Number(plan.burst.sz) * plan.burst.count);
  const needUsdc = Math.ceil(toHl + side * plan.btc_px * 0.1);
  // What it can still trade once the move has left its account.
  const roomAfter = withdrawable > 0 ? (room.maxSz * Math.max(0, withdrawable - toHl)) / withdrawable : 0;
  const ok = withdrawable >= needUsdc && roomAfter >= side;
  const problem = ok
    ? null
    : `the float (${w.ids.hlFloat}) holds ${withdrawable.toFixed(2)} USDC in perps and can trade ${room.maxSz} ${coinOf(w)}. A ${plan.size} run needs about ${needUsdc} USDC there: the ${toHl} it delivers to the account's Hyperliquid address through the stand-in, and margin for its ${side} ${coinOf(w)} side. Top it up on Hyperliquid testnet, then pnpm --filter @pb/oneclick-shim float:to-perps`;
  return { problem, withdrawable, max_sz: room.maxSz, room_after_move: Number(roomAfter.toFixed(5)), need_usdc: needUsdc, side_btc: side, leverage: room.leverage };
}

async function preview(w: World, step: StepContext, intent: Record<string, unknown>, label: string) {
  const started = w.now();
  const { status, body } = await w.api.post("/api/preview", { account: w.account, intent });
  const answer = (body ?? {}) as { verdict?: Record<string, unknown>; run?: { call_id?: string; attestation_url?: string }; message?: string };
  step.gateway({ label, http_status: status, ok: status === 200 && answer.verdict?.ok === true, call_id: answer.run?.call_id ?? null, attestation_url: answer.run?.attestation_url ?? null, reason: answer.message ?? (answer.verdict?.reason as string | undefined) ?? null, seconds: Math.round((w.now() - started) / 100) / 10 });
  if (status !== 200 || !answer.verdict) throw new Error(`the preview failed: HTTP ${status} ${answer.message ?? ""}`);
  return answer.verdict;
}

export function verdictSummary(v: Record<string, unknown>) {
  const pick = ["ok", "state", "action", "tier", "score", "rate_bp", "allow", "credit", "eq", "eq_allow", "im", "mm", "nonce", "blk", "reason"];
  return Object.fromEntries(pick.filter((k) => k in v).map((k) => [k, v[k]]));
}

/**
 * request_check with `intent`, then the verdict it brings (INTERFACES.md 4). The call's own answer, when the RPC has
 * it, is on_verdict's {accepted, reason}: a refused verdict stops here with the account's reason.
 */
export async function requestCheck(w: World, step: StepContext, intent: Record<string, unknown>, label: string) {
  const before = (await state(w)).verdict?.received_block ?? 0;
  const tx = await callForVerdict(w, step, w.account, "request_check", { intent }, TGAS_ACCOUNT, CHECK_DEPOSIT, label);
  const outcome = tx.result as { accepted?: unknown; reason?: unknown } | null | undefined;
  if (outcome && outcome.accepted === false) throw new Error(`the account refused the verdict: ${String(outcome.reason ?? "no reason given")}`);
  const st = await waitFor(w, tx, `the verdict for ${label}`, () => state(w), (s) => (s.verdict?.received_block ?? 0) > before);
  return st.verdict!.verdict;
}

/**
 * Why `what` (a borrow, or a withdrawal with a loan open) can't go ahead: the account signed a transfer out of
 * Hyperliquid, and holds back while that signature could still be posted (INTERFACES.md 8). Null when nothing is
 * in the way.
 *
 * An account made before the deploy of INTERFACES.md 50.2 waits the full 2 days and 1 hour: the words say to use a
 * new account, as before. One that shows `open_sends` doesn't have to wait: a check that sees the transfer in
 * Hyperliquid's own history lifts the pause, and the words say so.
 */
export function sendOpenProblem(account: string, hl: HlAnswer["hl"] | undefined, nowMs: number, what: string): string | null {
  const openUntil = Number(hl?.send_open_until_ms ?? 0);
  if (!(openUntil > nowMs)) return null;
  const until = new Date(openUntil).toISOString();
  if (!Array.isArray(hl?.open_sends)) return `${account} signed a transfer out of Hyperliquid that can be posted until ${until}: ${what} waits until then. Use a new --name.`;
  const floor = Number(hl.send_floor_until_ms ?? 0);
  if (floor > nowMs) return `${account} signed more than 8 transfers out of Hyperliquid that no check has seen as sent: ${what} waits until ${new Date(floor).toISOString()}, and no check ends that sooner. Use a new --name.`;
  return `${account} signed a transfer out of Hyperliquid that no check has seen as sent yet: ${what} waits. A check lifts this once Hyperliquid's history shows the transfer: ask for one (in gate 2, run from pause_lifted). Without one it ends by itself at ${until}.`;
}

/** A borrow, or a withdrawal with a loan open, waits while a signed sendAsset can still be posted (INTERFACES.md 8). */
async function assertNoSendOpen(w: World, what: string) {
  const problem = sendOpenProblem(w.account, (await state(w)).hl, await w.near.finalBlockMs(), what);
  if (problem) throw new Error(problem);
}

const amountOf = (value: unknown) => BigInt(Math.trunc(Number(value ?? 0)));

export async function stepBorrow({ runner, plan, world: w }: Gate) {
  await runner.run("borrow", "preview, a borrow check for the line less 0.5%, borrow", {}, async (step) => {
    await assertNoSendOpen(w, "borrowing");
    const seen = await preview(w, step, { check: {} }, "preview (check)");
    const line = amountOf((seen.allow as { borrow?: number } | undefined)?.borrow);
    // The pool's own limits hold whatever the verdict says (web/src/lib/borrow.ts): stay under each.
    const room = poolRoom(
      await w.near.view<PoolView>(w.ids.pool, "get_pool"),
      await w.near.view<ParamsView>(w.ids.pool, "get_params"),
      await w.near.view<BorrowerView | null>(w.ids.pool, "get_borrower", { account_id: w.account }),
      BigInt(w.now()) * 1_000_000n,
    );
    const limits = [{ label: "the line less 0.5%", amount: underLine(line) }, { label: `the ${plan.size} run's cap`, amount: BigInt(plan.caps.borrow_micro) }, ...room.map((l) => ({ label: l.label, amount: belowLimit(l.amount) }))];
    const binding = limits.reduce((a, b) => (a.amount <= b.amount ? a : b));
    let amount = binding.amount;
    if (amount <= 0n) return { ok: false, detail: { preview: verdictSummary(seen), why: `nothing to borrow: ${binding.label}` } };
    // The close-short refusal needs the loan near the line: the equity left after the loan is what it measures.
    if (amount * 100n < line * 98n) w.log(`  ${binding.label} holds the loan to ${amount} micro-USDC, under the line of ${line}: with less taken out, closing the short may not be refused`);

    const v = await requestCheck(w, step, { borrow: { amount: amount.toString() } }, "request_check (borrow)");
    const allowed = amountOf((v.allow as { borrow?: number } | undefined)?.borrow);
    if (v.ok !== true || v.state !== "HEALTHY" || allowed <= 0n) return { ok: false, detail: { preview: verdictSummary(seen), verdict: verdictSummary(v) } };
    if (allowed < amount) amount = underLine(allowed); // prices moved between the preview and the check
    const lent = await call(w, step, w.account, "borrow", { amount: amount.toString() }, TGAS_ACCOUNT, ONE_YOCTO, "borrow");
    // borrow returns on_borrowed's answer: false when the pool's own limits refused it (its log says which).
    if (lent.result === false) return { ok: false, detail: { preview: verdictSummary(seen), verdict: verdictSummary(v), why: "the pool refused the borrow", logs: lent.logs } };
    const debt = await until(w, "the pool's debt", 30_000, 2_000, () => w.near.view<string>(w.ids.pool, "debt_of", { account_id: w.account }), (d) => BigInt(d) > 0n);
    runner.record.context.borrowed = amount.toString();
    return { ok: true, detail: { preview: verdictSummary(seen), verdict: verdictSummary(v), line: line.toString(), set_by: binding.label, borrowed: amount.toString(), debt } };
  });
}

/**
 * "The client takes the loan out" (PLAN.md 2, step 5.5). The engine sizes a loan as if it leaves the account
 * (RISK_ENGINE.md 7.2), so the gate's refusals are measured with it gone: with the loan still in the account, its
 * USDC covers the unhedged nBTC and closing the short goes through. A preview gives the most USDC that may leave
 * now (allow.withdraw, 7.3); a withdraw check for the loan's amount, then withdraw to the keeper.
 */
export async function stepTakeOut({ runner, world: w }: Gate) {
  await runner.run("take_out", "take the loan out: a withdrawal check, then the mUSDC to the keeper", {}, async (step) => {
    const borrowed = BigInt(String(runner.record.context.borrowed ?? "0"));
    if (borrowed <= 0n) throw new Error("the record has no loan: run the borrow step first");
    const held = BigInt(await w.near.view<string>(w.ids.musdc, "ft_balance_of", { account_id: w.account }));
    if (held * 2n < borrowed) return { ok: true, detail: { already: `the account holds ${held} micro-USDC, under half the loan of ${borrowed}: it has left already` } };
    await assertNoSendOpen(w, "a withdrawal with a loan open");
    const seen = await preview(w, step, { check: {} }, "preview (check)");
    const most = amountOf((seen.allow as { withdraw?: number } | undefined)?.withdraw);
    const amount = [borrowed, held, belowLimit(most)].reduce((a, b) => (a < b ? a : b));
    if (amount <= 0n) return { ok: false, detail: { preview: verdictSummary(seen), why: "the preview allows no withdrawal" } };
    const v = await requestCheck(w, step, { withdraw: { token: w.ids.musdc, amount: amount.toString() } }, "request_check (withdraw)");
    // In the answer to a withdraw intent, allow.withdraw is the intent's amount if the engine allows it, else 0.
    const allowed = amountOf((v.allow as { withdraw?: number } | undefined)?.withdraw);
    if (v.ok !== true || v.state !== "HEALTHY" || allowed < amount) return { ok: false, detail: { amount: amount.toString(), preview: verdictSummary(seen), verdict: verdictSummary(v) } };
    await call(w, step, w.account, "withdraw", { token: w.ids.musdc, amount: amount.toString(), receiver: w.owner }, TGAS_ACCOUNT, ONE_YOCTO, "withdraw the loan to the keeper");
    runner.record.context.taken_out = amount.toString();
    const left = await w.near.view<string>(w.ids.musdc, "ft_balance_of", { account_id: w.account });
    return { ok: true, detail: { taken_out: amount.toString(), borrowed: borrowed.toString(), musdc_left: left, preview: verdictSummary(seen), verdict: verdictSummary(v) } };
  });
}

/** Risk codes a refusal of an order that adds risk may carry (RISK_ENGINE.md 9). */
const RISK_CODES = ["P5", "P6", "P7", "P8", "P9"];

export async function stepRefuseClose({ runner, world: w }: Gate) {
  await runner.run("refuse_close", "with the loan out, closing the whole short is refused", { expect_fail: true, expect_codes: RISK_CODES, observe: true }, async (step) => {
    const hl = await hlState(w);
    const short = -positionSize(hl.hyperliquid?.clearinghouse_state, coinOf(w));
    if (short <= 0) throw new Error("there is no short to close");
    // The limit sits under the asks, so if the checks wrongly let it through it can't fill and the hedge stays. The
    // gateway checks a buy at max(limit, mark) either way (P4), so the refusal is the same as for a fillable limit.
    // It also sits inside the band of the account's gateway, so that the refusal is a risk check's and not P2's.
    const facts = await priceFacts(w, coinOf(w));
    const under = gatePx("under", facts, szDec(w));
    if ("problem" in under) throw new Error(`${under.problem}. No buy could sit inside the band and under the asks, so the order wasn't sent`);
    const px = under.px;
    const close = async () => orderMessage(w.account, order(coinOf(w), true, szText(w, short), px, "Ioc", true), await expiry(w, facts.orderLifeMs));
    let r = await sendSigned(w, step, `close the whole short: buy ${szText(w, short)} ${coinOf(w)} at ${px} (IOC, reduce-only)`, await close(), "/api/order");
    if (!r.ok && r.code === "P0") {
      await w.sleep(3_000);
      r = await sendSigned(w, step, "the same, again after P0", await close(), "/api/order");
    }
    return { ok: r.ok, code: r.code, detail: { short, px, band_bp: facts.bandBp, reason: r.reason, call_id: r.call_id, attestation_url: r.attestation_url } };
  });
}

export async function stepBurst({ runner, plan, world: w }: Gate) {
  await runner.run("burst", `${plan.burst.count} orders that add to the short, sent at once`, { observe: true }, async (step) => {
    // The float's bid, as for the short: 0.3% under the mark, inside the band of the account's gateway.
    const facts = await priceFacts(w, coinOf(w));
    const bid = gatePx("under", facts, szDec(w));
    if ("problem" in bid) throw new Error(`${bid.problem}. Nothing was posted`);
    const px = bid.px;
    const total = Number(plan.burst.sz) * plan.burst.count;
    await floatHasRoom(w, total);
    const floatOrder = await w.float.order({ side: "buy", sz: szText(w, total), px, tif: "Gtc" });
    runner.record.context.float_open_oid = floatOrder.oid;
    let records: GatewayRecord[];
    try {
      // All 40 signed at once, for the account's order life (110 s on an older gateway, 230 s on one built since
      // INTERFACES.md 50.4): OutLayer works through 40 runs a couple at a time, and one that waits longer is refused
      // as expired.
      const expires = await expiry(w, facts.orderLifeMs);
      const messages = Array.from({ length: plan.burst.count }, () => orderMessage(w.account, order(coinOf(w), false, plan.burst.sz, px, "Ioc"), expires));
      records = await Promise.all(messages.map((m, i) => sendSigned(w, step, `burst #${i + 1}: sell ${plan.burst.sz} ${coinOf(w)} at ${px}`, m, "/api/order")));
    } finally {
      if (floatOrder.oid !== null) await w.float.cancel(floatOrder.oid).catch(() => undefined);
      runner.record.context.float_open_oid = null;
    }
    const tally = tallyBurst(records);
    await w.sleep(3_000);
    const after = await preview(w, step, { check: {} }, "preview after the burst");
    const hl = await hlState(w);
    const debt = BigInt(await w.near.view<string>(w.ids.pool, "debt_of", { account_id: w.account }));
    // The pass test: the short and the loan the 40 orders left are still a book the checks allow: HEALTHY, allowance
    // equity at least the requirement, the loan within the tier cap (P8, RISK_ENGINE.md 7.3 and 9).
    const credit = creditHolds(after, debt);
    const within = after.ok === true && after.state === "HEALTHY" && credit.holds;
    return {
      ok: within,
      detail: { px, tally, short_after: -positionSize(hl.hyperliquid?.clearinghouse_state, coinOf(w)), after: verdictSummary(after), debt: debt.toString(), credit },
    };
  });
}

/** TAO is next in line in universe_v0.json and listed on testnet, but not on the allow-list. */
export const OFF_LIST_COIN = "TAO";

export async function stepRefuseCoin({ runner, world: w }: Gate) {
  await runner.run("refuse_coin", `an order for ${OFF_LIST_COIN}, outside the allow-list, is refused with P1`, { expect_fail: true, expect_codes: ["P1"], observe: true }, async (step) => {
    const { mark, szDecimals } = await market(w, OFF_LIST_COIN);
    const sz = formatSize(String(Math.ceil((10.5 / mark) * 10 ** szDecimals) / 10 ** szDecimals), szDecimals);
    const px = formatPrice(String(mark * 0.997), szDecimals); // a buy under the asks: it couldn't fill even if let through
    const r = await sendSigned(w, step, `buy ${sz} ${OFF_LIST_COIN} at ${px} (IOC)`, orderMessage(w.account, order(OFF_LIST_COIN, true, sz, px, "Ioc"), await expiry(w, await orderLife(w))), "/api/order");
    return { ok: r.ok, code: r.code, detail: { sz, px, reason: r.reason, call_id: r.call_id } };
  });
}

export async function stepRepay({ runner, world: w }: Gate) {
  await runner.run("repay", "put the loan back and repay it all", {}, (step) => repayAll(w, step));
}

/**
 * Repays everything the account owes our pool, and checks that the loan closed. What the account is short of comes
 * from the owner first. The `repay` step's body, and gate 2's `repay_again` (INTERFACES.md 50.2).
 */
export async function repayAll(w: World, step: StepContext): Promise<StepOutcome> {
  {
    const debt = BigInt(await w.near.view<string>(w.ids.pool, "debt_of", { account_id: w.account }));
    const st0 = await state(w);
    if (debt === 0n && st0.loan.open !== true) return { ok: true, detail: { already: "no loan" } };
    // Interest accrues every second, and the pool sends back what is above the debt (as the web app's "All").
    const want = debt + debt / 1_000n + 1_000_000n;
    const held = BigInt(await w.near.view<string>(w.ids.musdc, "ft_balance_of", { account_id: w.account }));
    // The loan went to the keeper (take_out): it comes back the way it left, with the interest minted from the
    // test token's public faucet if the keeper is short.
    let putBack = 0n;
    let minted = 0n;
    if (held < want) {
      putBack = want - held;
      const keeperHas = BigInt(await w.near.view<string>(w.ids.musdc, "ft_balance_of", { account_id: w.owner }));
      if (keeperHas < putBack) {
        minted = putBack - keeperHas;
        await call(w, step, w.ids.musdc, "mint", { account_id: w.owner, amount: minted.toString() }, 30, STORAGE, "mint mUSDC to the keeper for the interest");
      }
      await call(w, step, w.ids.musdc, "ft_transfer_call", { receiver_id: w.account, amount: putBack.toString(), msg: "" }, 100, ONE_YOCTO, "deposit the loan back");
    }
    await call(w, step, w.account, "repay", { amount: want.toString() }, TGAS_ACCOUNT, ONE_YOCTO, "repay");
    const st = await until(w, "the loan to close", 30_000, 2_000, () => state(w), (s) => s.loan.open === false || s.loan.principal === "0", (s) => `the account's loan was ${JSON.stringify(s.loan)}`);
    const left = await w.near.view<string>(w.ids.pool, "debt_of", { account_id: w.account });
    return { ok: BigInt(left) === 0n && st.loan.open !== true, detail: { repaid: want.toString(), put_back: putBack.toString(), minted: minted.toString(), debt_before: debt.toString(), debt_after: left, loan: st.loan } };
  }
}

export async function stepCloseShort({ runner, world: w }: Gate) {
  await runner.run("close_short", "close the short through the gateway", {}, async (step) => {
    const before = await hlState(w);
    const short = -positionSize(before.hyperliquid?.clearinghouse_state, coinOf(w));
    let traded: Awaited<ReturnType<typeof tradeAgainstFloat>> | null = null;
    if (short > 0) {
      // The float's ask, 0.3% over the mark. The gateway refuses a price further from its reference price than the
      // band of the gateway the account pins (P2), and testnet's mark stands well over its oracle price (0.77% on
      // 11 Nov, 1.96% on 12 Nov): the ask is held a tenth of a percent inside the band, and must stay over the bids.
      const facts = await priceFacts(w, coinOf(w));
      const ask = gatePx("over", facts, szDec(w));
      if ("problem" in ask) throw new Error(`${ask.problem}. Nothing was posted, and the short stays open: run from close_short again once the mark is back inside`);
      traded = await tradeAgainstFloat(w, step, "buy", short, ask.px, true, "close:", runner.record.context, facts.orderLifeMs);
    }
    // Hyperliquid shows a fill within a couple of seconds; give it up to 30 s, then take what it shows.
    const after = await until(w, "the short to close", 30_000, 2_500, () => hlState(w), (a) => positionSize(a.hyperliquid?.clearinghouse_state, coinOf(w)) >= 0).catch(() => hlState(w));
    const left = positionSize(after.hyperliquid?.clearinghouse_state, coinOf(w));
    // The float took the other side of every trade; flatten what it holds now.
    const floatState = await w.hl.info<unknown>({ type: "clearinghouseState", user: w.ids.hlFloat });
    const floatHeld = positionSize(floatState, coinOf(w));
    // The step is about the account's short. A float it can't flatten (a leftover under Hyperliquid's $10 minimum,
    // seen on 12 Nov) is written down and named again at the end of the run; it doesn't fail the step.
    const flattened = floatHeld !== 0 ? await w.float.close().catch((e: unknown) => `not flattened: ${e instanceof Error ? e.message : String(e)}`) : `the float holds no ${coinOf(w)}`;
    return { ok: left === 0, detail: { closed: short, left, dust: traded?.dust ?? null, float_held: floatHeld, float_close: flattened.trim().split("\n").slice(-2).join(" | ") } };
  });
}

export async function stepHome({ runner, world: w }: Gate) {
  await runner.run("home", "bring the USDC home: quote, hl_withdraw, submit, delivered", {}, async (step) => {
    const hl = await hlState(w);
    const withdrawable = Number(hl.hyperliquid?.clearinghouse_state?.withdrawable ?? 0);
    // A cent under what Hyperliquid says is withdrawable, in micro-USDC: the stand-in matches the exact amount.
    const amount = BigInt(Math.floor(withdrawable * 1e6)) - 10_000n;
    if (amount < 1_000_000n) return { ok: true, detail: { withdrawable, why: "less than 1 USDC left on Hyperliquid: nothing to bring home" } };
    const { status, body } = await w.api.post("/api/quote", { dry: false, move: "home", account: w.account, amount: amount.toString() });
    if (status !== 200) throw new Error(`the move quote failed: HTTP ${status} ${JSON.stringify(body).slice(0, 300)}`);
    const quote = body as { correlationId: string; quote: { depositAddress: string; depositMemo: string | null; amountIn: string; amountOutFormatted: string; timeEstimate: number }; move: { next: { method: string; args: { amount: string; destination: string } } } };
    if (quote.move.next?.method !== "hl_withdraw") throw new Error("the quote has no hl_withdraw to send");
    runner.record.context.home_quote = { correlationId: quote.correlationId, depositAddress: quote.quote.depositAddress, depositMemo: quote.quote.depositMemo, amountIn: quote.quote.amountIn };
    const before = await state(w);
    const after = Math.max(-1, ...(before.hl?.signed ?? []).map((e) => e.index));
    const tx = await call(w, step, w.account, "hl_withdraw", { ...quote.move.next.args, source_dex: "" }, TGAS_ACCOUNT, ONE_YOCTO, "hl_withdraw");
    const index = await signedIndex(w, tx, "sendAsset", after);
    const posted = await submit(w, step, index, `submit sendAsset #${index}`);
    if (!posted.ok) return { ok: false, detail: { index, hl: posted.answer } };
    const { final, seen } = await settle(w, quote.quote.depositAddress, quote.quote.depositMemo, (quote.quote.timeEstimate + 600) * 1000);
    const st = await state(w);
    return { ok: final.status === "SUCCESS", detail: { amount: amount.toString(), index, statuses: seen, delivered: quote.quote.amountOutFormatted, reason: final.swapDetails?.refundReason, send_open_until_ms: st.hl?.send_open_until_ms, ...(st.hl?.open_sends ? { open_sends: st.hl.open_sends } : {}) } };
  });
}

export async function stepWithdraw({ runner, world: w }: Gate) {
  await runner.run("withdraw", "withdraw both tokens to the keeper, with no verdict", {}, async (step) => {
    const out: Record<string, string> = {};
    for (const token of [w.ids.musdc, collateralOf(w)]) {
      const balance = await w.near.view<string>(token, "ft_balance_of", { account_id: w.account });
      out[token] = balance;
      if (BigInt(balance) > 0n) await call(w, step, w.account, "withdraw", { token, amount: balance, receiver: w.owner }, TGAS_ACCOUNT, ONE_YOCTO, `withdraw ${token}`);
    }
    const left = await Promise.all([w.ids.musdc, collateralOf(w)].map((t) => w.near.view<string>(t, "ft_balance_of", { account_id: w.account })));
    return { ok: left.every((b) => b === "0"), detail: { withdrawn: out, left } };
  });
}

export const STEPS = {
  create: stepCreate,
  deposit: stepDeposit,
  hl_init: stepHlInit,
  to_hl: stepToHl,
  agent: stepAgent,
  approve: stepApprove,
  short: stepShort,
  borrow: stepBorrow,
  take_out: stepTakeOut,
  refuse_close: stepRefuseClose,
  burst: stepBurst,
  refuse_coin: stepRefuseCoin,
  repay: stepRepay,
  close_short: stepCloseShort,
  home: stepHome,
  withdraw: stepWithdraw,
} as const;

/**
 * What is still open on Hyperliquid after a run stopped, and how to close it. With `cancel`, resting orders (the
 * float's, through its tool, and the account's, through /api/cancel) are cancelled here. Positions are left for a
 * person, with the commands: the account's short may be all that hedges a loan.
 */
export async function leftovers(w: World, cancel: boolean): Promise<string[]> {
  const cancelFloatOrders = cancel;
  const cancelAccountOrders = cancel;
  const lines: string[] = [];
  try {
    const hl = await hlState(w);
    const short = positionSize(hl.hyperliquid?.clearinghouse_state, coinOf(w));
    if (short !== 0) {
      lines.push(`${w.account} holds ${short} ${coinOf(w)} on Hyperliquid. Close it with: pnpm --filter @pb/keeper hedge:demo -- --name ${w.account.split(".")[0]} --size <size> --from repay (it puts the loan back and repays first, then closes)`);
    }
    for (const o of hl.hyperliquid?.open_orders ?? []) {
      const what = `${w.account}'s open ${o.coin} order ${o.oid} (${o.side === "B" ? "buy" : "sell"} ${o.sz} at ${o.limitPx})`;
      if (!cancelAccountOrders) {
        lines.push(`${what}: cancel it on the Trade page`);
        continue;
      }
      const noted: GatewayRecord[] = [];
      const r = await sendSigned(w, { tx: () => {}, gateway: (g) => noted.push(g) }, `cancel ${o.oid}`, cancelMessage(w.account, o.coin, o.oid, await expiry(w, await orderLife(w))), "/api/cancel");
      lines.push(`${what}: ${r.ok ? "cancelled through the gateway" : `the cancel failed (${r.code} ${r.reason ?? ""}): cancel it on the Trade page`}`);
    }
  } catch (error) {
    lines.push(`couldn't read ${w.account} on Hyperliquid: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const open = await w.hl.info<{ coin: string; oid: number }[]>({ type: "openOrders", user: w.ids.hlFloat });
    for (const o of open) {
      if (cancelFloatOrders) {
        const said = await w.float.cancel(o.oid).catch((error: unknown) => `failed: ${String(error)}`);
        lines.push(`the float's open ${o.coin} order ${o.oid}: cancelled (${said.trim().split("\n").at(-1)})`);
      } else {
        lines.push(`the float has an open ${o.coin} order ${o.oid}: pnpm --filter @pb/oneclick-shim float:cancel -- --coin ${o.coin} --oid ${o.oid}`);
      }
    }
    const floatHeld = positionSize(await w.hl.info<unknown>({ type: "clearinghouseState", user: w.ids.hlFloat }), coinOf(w));
    if (floatHeld !== 0) lines.push(`the float holds ${floatHeld} ${coinOf(w)}: pnpm --filter @pb/oneclick-shim float:close -- --coin ${coinOf(w)}`);
  } catch (error) {
    lines.push(`couldn't read the float: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (lines.length === 0) lines.push("nothing is open on Hyperliquid");
  return lines;
}

/** For the tests. */
export const _internal = { tradeAgainstFloat };
