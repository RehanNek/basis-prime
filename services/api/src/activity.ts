// GET /api/activity/:account (INTERFACES.md 22): the account's history, newest first. Deposits, loans, repayments,
// transfers to and from Hyperliquid, plan steps and withdrawals, each with its transaction hash.
//
// The source is FastNEAR's transactions API for testnet (https://docs.fastnear.com/tx; base https://tx.test.fastnear.com),
// which answered without a key on 9 Nov:
//   POST /v0/account      {account_id, desc, limit (1-200)} -> {account_txs: [{transaction_hash, tx_block_height,
//                         tx_block_timestamp, is_success, ...role flags}], txs_count, resume_token}
//                         (https://docs.fastnear.com/tx/account)
//   POST /v0/transactions {tx_hashes: up to 20} -> {transactions: [{transaction: {signer_id, receiver_id, hash, actions},
//                         execution_outcome, receipts: [{receipt, execution_outcome: {outcome: {executor_id, logs,
//                         status}}}]}]} (https://docs.fastnear.com/tx/transactions)
// Every receipt comes with its logs, so the history is read from what the contracts said happened: each token's NEP-141
// `ft_transfer` events (amounts in and out of the account), the pool's `pb-pool` events (`borrow`, `repay`) and the
// account's own (`plan_stored`, `step_run`, `transfer_done`), next to the method the transaction called and its
// arguments. An event counts only from the contract it belongs to: a token's from that token, the pool's from the pool.
// Plan steps the gateway placed on Hyperliquid have no NEAR transaction; they come from the keeper's log, with the
// run's attestation.
//
// FastNEAR's docs give no limit for calls without a key, and FASTNEAR_API_KEY, if set, goes as a bearer token. Each
// account is read at most every 30 s, and a transaction older than two minutes is kept once read: it can't change.
import { readJsonLines, type KeeperEvent } from "./drill.js";
import type { Deps } from "./handlers.js";
import { HttpError, isPrimeAccount } from "./validate.js";

/** INTERFACES.md 22: kept for 30 s. */
export const ACTIVITY_CACHE_MS = 30_000;
/** The API's largest page. */
export const ACTIVITY_LIST_LIMIT = 200;
/** The newest transactions read in full; older ones are counted. */
export const ACTIVITY_DETAILED = 100;
/** /v0/transactions takes at most 20 hashes. */
const BATCH = 20;
/** A transaction this old has all its receipts indexed, so its record is kept. */
const SETTLED_MS = 2 * 60_000;

export interface AccountTx {
  transaction_hash: string;
  tx_block_height: number;
  /** Nanoseconds, as a string. */
  tx_block_timestamp: string;
  is_success: boolean;
}

interface Outcome {
  executor_id?: string;
  logs?: string[];
  status?: unknown;
}

export interface IndexedTx {
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: unknown[] };
  execution_outcome?: { block_height?: number; outcome?: Outcome };
  receipts?: { receipt?: { receipt_id?: string; receiver_id?: string }; execution_outcome?: { block_height?: number; outcome?: Outcome } }[];
}

export interface TxIndexer {
  /** The indexer's host, for the page to name its source. */
  readonly host: string;
  accountTxs(accountId: string, limit: number): Promise<{ txs: AccountTx[]; total: number | null; more: boolean }>;
  transactions(hashes: string[]): Promise<IndexedTx[]>;
}

/** FastNEAR's transactions API. The key, if any, goes in the Authorization header only. */
export class FastNearTx implements TxIndexer {
  readonly host: string;
  readonly #url: string;
  readonly #key: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: { url: string; apiKey?: string; fetch?: typeof fetch }) {
    this.#url = options.url.replace(/\/+$/, "");
    this.host = new URL(this.#url).host;
    this.#key = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
  }

  async accountTxs(accountId: string, limit: number) {
    const body = (await this.#post("/v0/account", { account_id: accountId, desc: true, limit })) as { account_txs?: AccountTx[]; txs_count?: number; resume_token?: string };
    if (!Array.isArray(body.account_txs)) throw new HttpError(502, "indexer", `${this.host} answered an account history without account_txs`);
    return { txs: body.account_txs, total: typeof body.txs_count === "number" ? body.txs_count : null, more: typeof body.resume_token === "string" && body.resume_token !== "" };
  }

  async transactions(hashes: string[]) {
    const body = (await this.#post("/v0/transactions", { tx_hashes: hashes })) as { transactions?: IndexedTx[] };
    if (!Array.isArray(body.transactions)) throw new HttpError(502, "indexer", `${this.host} answered transactions without a list`);
    return body.transactions.filter((t) => t && typeof t.transaction?.hash === "string");
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.#key ? { Authorization: `Bearer ${this.#key}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new HttpError(502, "indexer", `The transaction indexer (${this.host}) did not answer: ${error instanceof Error ? error.name : "error"}`);
    }
    if (!response.ok) throw new HttpError(502, "indexer", `The transaction indexer (${this.host}) answered HTTP ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new HttpError(502, "indexer", `The transaction indexer (${this.host}) answered something that isn't JSON`);
    }
  }
}

// ---------- reading one transaction ----------

export type ActivityKind =
  | "create"
  | "deposit"
  | "borrow"
  | "repay"
  | "to_hl"
  | "home"
  | "arrived"
  | "refund"
  | "plan"
  | "plan_step"
  | "withdraw"
  | "setup"
  | "check"
  | "kyb"
  | "other";

/** A token moving into (+) or out of (-) the account in this transaction, in the token's own units. */
export interface Move {
  token: string;
  amount: string;
  /** Who it came from or went to. */
  other: string;
}

export interface ActivityItem {
  at_ms: number;
  block: number | null;
  /** The NEAR transaction, or null for a gateway run (which has an attestation instead). */
  tx: string | null;
  ok: boolean;
  kind: ActivityKind;
  /** The transaction's signer, or "keeper" for a line of the keeper's log. */
  by: string;
  moves: Move[];
  detail: Record<string, unknown>;
  source: "indexer" | "keeper_log";
  attestation_url?: string | null;
}

export interface ActivityContext {
  account: string;
  factory: string;
  pool: string;
  /** The tokens accounts hold (INTERFACES.md 1). */
  tokens: string[];
}

interface Event {
  executor: string;
  standard: string;
  event: string;
  data: unknown;
}

function base64Json(text: unknown): Record<string, unknown> {
  if (typeof text !== "string") return {};
  try {
    const parsed = JSON.parse(Buffer.from(text, "base64").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The transaction's first function call: its method and arguments. */
function firstCall(actions: unknown[]): { method: string; args: Record<string, unknown> } | null {
  for (const action of actions) {
    const call = (action as { FunctionCall?: { method_name?: unknown; args?: unknown } } | null)?.FunctionCall;
    if (call && typeof call.method_name === "string") return { method: call.method_name, args: base64Json(call.args) };
  }
  return null;
}

function outcomes(tx: IndexedTx): Outcome[] {
  return [tx.execution_outcome?.outcome, ...(tx.receipts ?? []).map((r) => r.execution_outcome?.outcome)].filter((o): o is Outcome => Boolean(o));
}

/** NEP-297 events, each with the contract that logged it. */
function eventsOf(tx: IndexedTx): Event[] {
  const events: Event[] = [];
  for (const o of outcomes(tx)) {
    for (const line of o.logs ?? []) {
      if (!line.startsWith("EVENT_JSON:")) continue;
      try {
        const e = JSON.parse(line.slice("EVENT_JSON:".length)) as { standard?: unknown; event?: unknown; data?: unknown };
        if (typeof e.standard === "string" && typeof e.event === "string") events.push({ executor: o.executor_id ?? "", standard: e.standard, event: e.event, data: e.data });
      } catch {
        // not an event after all
      }
    }
  }
  return events;
}

/** The plain log lines one contract wrote. */
function logsOf(tx: IndexedTx, executor: string): string[] {
  return outcomes(tx)
    .filter((o) => o.executor_id === executor)
    .flatMap((o) => (o.logs ?? []).filter((l) => !l.startsWith("EVENT_JSON:")));
}

function failedIn(tx: IndexedTx, executor: string): boolean {
  return outcomes(tx).some((o) => o.executor_id === executor && o.status !== null && typeof o.status === "object" && "Failure" in (o.status as object));
}

const asList = (data: unknown): Record<string, unknown>[] => (Array.isArray(data) ? data : [data]).filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === "object");
const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

/** The account's token moves, netted per token and counterparty, from each token's own ft_transfer events. */
export function tokenMoves(events: Event[], ctx: ActivityContext): Move[] {
  const net = new Map<string, bigint>();
  for (const e of events) {
    if (e.standard !== "nep141" || !ctx.tokens.includes(e.executor)) continue;
    for (const d of asList(e.data)) {
      const amount = /^\d+$/.test(String(d.amount ?? "")) ? BigInt(String(d.amount)) : 0n;
      const add = (other: string, delta: bigint) => net.set(`${e.executor} ${other}`, (net.get(`${e.executor} ${other}`) ?? 0n) + delta);
      if (e.event === "ft_transfer") {
        if (d.new_owner_id === ctx.account && typeof d.old_owner_id === "string") add(d.old_owner_id, amount);
        if (d.old_owner_id === ctx.account && typeof d.new_owner_id === "string") add(d.new_owner_id, -amount);
      } else if (e.event === "ft_mint" && d.owner_id === ctx.account) add("(minted)", amount);
      else if (e.event === "ft_burn" && d.owner_id === ctx.account) add("(burnt)", -amount);
    }
  }
  return [...net]
    .filter(([, v]) => v !== 0n)
    .map(([key, v]) => {
      const [token, other] = key.split(" ") as [string, string];
      return { token, amount: v.toString(), other };
    });
}

/** The transfer id in an ft_transfer_call msg, {"pb":{"transfer":"move:3"}}, if it is one. */
function transferIn(msg: unknown): string | null {
  if (typeof msg !== "string") return null;
  try {
    const id = (JSON.parse(msg) as { pb?: { transfer?: unknown } } | null)?.pb?.transfer;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/** "transfer move:3 under way: ..." in the account's logs: the id it gave a move or a step's transfer. */
function startedTransfer(lines: string[]): string | null {
  for (const line of lines) {
    const m = /^transfer (\S+) under way/.exec(line);
    if (m) return m[1]!;
  }
  return null;
}

/** One transaction as the account's history sees it: one item, plus one for each plan stored or move seen arriving. */
export function readTx(tx: IndexedTx, meta: { atMs: number; block: number | null; ok: boolean }, ctx: ActivityContext): ActivityItem[] {
  const top = tx.transaction;
  const call = firstCall(top.actions ?? []);
  const events = eventsOf(tx);
  const pool = events.filter((e) => e.executor === ctx.pool && e.standard === "pb-pool").flatMap((e) => asList(e.data).filter((d) => d.account_id === ctx.account).map((d) => ({ event: e.event, d })));
  const own = events.filter((e) => e.executor === ctx.account && e.standard === "pb-pool").map((e) => ({ event: e.event, d: asList(e.data)[0] ?? {} }));
  const moves = tokenMoves(events, ctx);
  const ok = meta.ok && !failedIn(tx, ctx.account);
  const items: ActivityItem[] = [];
  const add = (kind: ActivityKind, detail: Record<string, unknown>, itemMoves: Move[] = moves) =>
    items.push({ at_ms: meta.atMs, block: meta.block, tx: top.hash, ok, kind, by: top.signer_id, moves: itemMoves, detail, source: "indexer" });
  const repaid = pool.find((p) => p.event === "repay")?.d.amount ?? null;
  const transfer = startedTransfer(logsOf(tx, ctx.account));

  if (top.receiver_id === ctx.factory && call?.method === "create_account" && `${String(call.args.name)}.${ctx.factory}` === ctx.account) {
    add("create", { owner: str(call.args.owner), registered: pool.some((p) => p.event === "register") });
  } else if (ctx.tokens.includes(top.receiver_id) && call && ["ft_transfer_call", "ft_transfer"].includes(call.method) && call.args.receiver_id === ctx.account) {
    const id = transferIn(call.args.msg);
    const done = own.find((o) => o.event === "transfer_done" && o.d.id === id);
    if (id) add(done?.d.how === "refunded" ? "refund" : "arrived", { transfer: id, how: str(done?.d.how), token: top.receiver_id, sent: str(call.args.amount) });
    else add("deposit", { token: top.receiver_id, sent: str(call.args.amount), kept: moves.some((m) => m.token === top.receiver_id && !m.amount.startsWith("-")) });
  } else if (top.receiver_id === ctx.account && call) {
    const a = call.args;
    switch (call.method) {
      case "borrow": {
        const b = pool.find((p) => p.event === "borrow")?.d;
        add("borrow", { asked: str(a.amount), amount: str(b?.amount), debt: str(b?.debt), tier: str(b?.tier), returned: str(pool.find((p) => p.event === "loan_returned")?.d.amount) });
        break;
      }
      case "repay":
        add("repay", { sent: str(a.amount), amount: str(repaid) });
        break;
      case "withdraw":
        add(a.transfer ? "to_hl" : "withdraw", { token: str(a.token), amount: str(a.amount), to: str(a.receiver), transfer, implicit_receiver: typeof a.receiver === "string" && /^[0-9a-f]{64}$/.test(a.receiver) });
        break;
      case "hl_withdraw":
        add("home", { amount: str(a.amount), destination: str(a.destination), transfer });
        break;
      case "execute_step": {
        const run = own.find((o) => o.event === "step_run")?.d;
        add("plan_step", { pid: str(a.pid), i: typeof a.i === "number" ? a.i : null, k: str(run?.k), repaid: str(repaid), transfer });
        break;
      }
      case "request_check":
        add("check", { intent: a.intent ?? null });
        break;
      case "hl_init":
      case "request_agent":
      case "hl_approve_agent":
        add("setup", { method: call.method });
        break;
      default:
        add("other", { method: call.method, receiver: top.receiver_id });
    }
  } else if (top.receiver_id === ctx.pool && pool.some((p) => p.event === "set_kyb")) {
    add("kyb", { entity: pool.find((p) => p.event === "set_kyb")?.d.entity ?? null });
  } else {
    add("other", { method: call?.method ?? null, receiver: top.receiver_id });
  }

  // What else the transaction did for the account: a check that stored a plan, or saw a move arrive on Hyperliquid.
  for (const o of own) {
    if (o.event === "plan_stored") add("plan", { pid: str(o.d.pid), action: str(o.d.action), steps: Array.isArray(o.d.steps) ? o.d.steps : [] }, []);
    if (o.event === "transfer_done" && o.d.how === "verdict") add("arrived", { transfer: str(o.d.id), how: "verdict" }, []);
  }
  return items;
}

/** The gateway's placements of plan steps, from the keeper's log: they happen on Hyperliquid, so no NEAR transaction. */
export function keeperPlacements(events: KeeperEvent[], account: string): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const e of events) {
    if (e.account !== account || e.event !== "gateway" || e.mode !== "deleverage" || !Array.isArray(e.placed)) continue;
    for (const p of e.placed as Record<string, unknown>[]) {
      if (!p || typeof p !== "object") continue;
      items.push({
        at_ms: Date.parse(e.t),
        block: null,
        tx: null,
        ok: true,
        kind: "plan_step",
        by: "keeper",
        moves: [],
        detail: { pid: str(e.pid), i: typeof p.i === "number" ? p.i : null, k: str(p.k), status: str(p.status), filled_sz: str(p.filled_sz), avg_px: str(p.avg_px), via: "pb-gateway" },
        source: "keeper_log",
        attestation_url: typeof e.attestation_url === "string" ? e.attestation_url : null,
      });
    }
  }
  return items;
}

// ---------- GET /api/activity/:account ----------

export interface ActivityAnswer {
  account: string;
  read_at_ms: number;
  indexer: { host: string; docs: string };
  /** Transactions the indexer counts for the account, those it listed, and those read in full. */
  total: number | null;
  listed: number;
  detailed: number;
  /** Older transactions weren't read. */
  more: boolean;
  keeper_log: boolean;
  items: ActivityItem[];
}

/** Settled transactions, by hash: they never change once all their receipts are in. */
export class TxStore {
  readonly #txs = new Map<string, IndexedTx>();
  constructor(readonly max = 5_000) {}
  get(hash: string) {
    return this.#txs.get(hash);
  }
  keep(tx: IndexedTx) {
    if (this.#txs.size >= this.max) this.#txs.delete(this.#txs.keys().next().value!);
    this.#txs.set(tx.transaction.hash, tx);
  }
}

async function readActivity(deps: Deps, indexer: TxIndexer, account: string, now: number): Promise<ActivityAnswer> {
  const { ids } = deps.config;
  const ctx: ActivityContext = { account, factory: ids.factory, pool: ids.pool, tokens: ids.tokens.map((t) => t.id) };
  const list = await indexer.accountTxs(account, ACTIVITY_LIST_LIMIT);
  const newest = list.txs.slice(0, ACTIVITY_DETAILED);
  const store = deps.txStore;
  const missing = newest.map((t) => t.transaction_hash).filter((h) => !store?.get(h));
  const fetched = new Map<string, IndexedTx>();
  for (let i = 0; i < missing.length; i += BATCH) {
    for (const tx of await indexer.transactions(missing.slice(i, i + BATCH))) fetched.set(tx.transaction.hash, tx);
  }
  const items: ActivityItem[] = [];
  for (const t of newest) {
    const tx = store?.get(t.transaction_hash) ?? fetched.get(t.transaction_hash);
    if (!tx) continue;
    const atMs = Number(BigInt(/^\d+$/.test(t.tx_block_timestamp) ? t.tx_block_timestamp : "0") / 1_000_000n);
    if (store && fetched.has(t.transaction_hash) && now - atMs > SETTLED_MS) store.keep(tx);
    items.push(...readTx(tx, { atMs, block: t.tx_block_height ?? null, ok: t.is_success !== false }, ctx));
  }
  const log = (deps.readKeeperLog ?? readJsonLines)(deps.config.keeperLogFile);
  // Keep the keeper's placements within the span the transactions cover, so a cut-off list doesn't show steps alone.
  const oldest = newest.length === ACTIVITY_DETAILED || list.more ? (items.at(-1)?.at_ms ?? 0) : 0;
  items.push(...keeperPlacements(log.events, account).filter((p) => p.at_ms >= oldest));
  items.sort((x, y) => y.at_ms - x.at_ms);
  return {
    account,
    read_at_ms: now,
    indexer: { host: indexer.host, docs: "https://docs.fastnear.com/tx/account" },
    total: list.total,
    listed: list.txs.length,
    detailed: newest.length,
    more: list.more || list.txs.length > newest.length,
    keeper_log: log.found,
    items,
  };
}

/** GET /api/activity/:account: read at most every 30 s per account. */
export async function getActivity(deps: Deps, accountId: string) {
  const { factory } = deps.config.ids;
  if (!isPrimeAccount(accountId, factory)) throw new HttpError(400, "bad_request", `account must be a client account, <name>.${factory}`);
  const indexer = deps.indexer;
  if (!indexer) throw new HttpError(503, "activity_off", "The transaction indexer is off here");
  const now = deps.now();
  const cache = deps.activity;
  const hit = cache?.get(accountId, now);
  if (hit) return { ...(await hit.value), cached: true };
  if (deps.limits.activityReads && !deps.limits.activityReads.take()) {
    const last = cache?.last(accountId);
    if (last) return { ...last.value, cached: true, stale: true };
    throw new HttpError(429, "too_many_reads", "The history is read for many accounts at once just now; try again in a minute");
  }
  const answer = await (cache ? cache.set(accountId, now, readActivity(deps, indexer, accountId, now)) : readActivity(deps, indexer, accountId, now));
  return { ...answer, cached: false };
}
