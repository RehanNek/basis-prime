// Aave's chain as the keeper needs it (INTERFACES.md 33; FUNDING.md 4.5 and 7.1). Stage 3: an account signs Ethereum
// transactions through Chain Signatures and stores them in get_state().evm.signed. The keeper
//   - reads how many of them the chain has used (eth_getTransactionCount), which is how it knows one is mined;
//   - reads whether a token is approved for Aave's Pool (the token's `allowance`), before a supply or a repayment;
//   - sends a signed transaction itself (eth_sendRawTransaction), as a backup to the backend's POST /api/evm/submit.
// It holds no Ethereum key and signs nothing here. Every request goes in one batch with eth_chainId first, and a
// node that answers for another chain is refused before anything it said is used, or anything is sent to it.
//
// The keeper has no Keccak, so it can't hash a transaction itself. It reads the transaction's own fields instead (a
// small RLP reader, below): it sends only a type 2 transaction for the config's chain that goes to Aave's Pool or to
// a token of the config, and it checks that the node answers the hash the account stored.

/** A token on Aave's chain, as the account's config names it. The address is kept lowercase. */
export interface EvmToken {
  symbol: string;
  address: string;
  decimals: number;
}

/** `get_config().lenders.aave` (INTERFACES.md 24 and 33). */
export interface AaveSettings {
  chainId: number;
  pool: string;
  usdc: EvmToken;
  collateral: EvmToken[];
  /** The most a signed transaction may pay per gas, in wei; null if the config doesn't say. */
  maxFeePerGas: string | null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const WEI = /^(0|[1-9]\d{0,38})$/;

function tokenOf(value: unknown): EvmToken | null {
  const t = value as { symbol?: unknown; address?: unknown; decimals?: unknown } | null;
  if (!t || typeof t.symbol !== "string" || typeof t.address !== "string" || !ADDRESS.test(t.address) || typeof t.decimals !== "number") return null;
  return { symbol: t.symbol, address: t.address.toLowerCase(), decimals: t.decimals };
}

/** The Aave settings of an account's Config, or null when it has none the keeper can read. */
export function aaveSettings(config: unknown): AaveSettings | null {
  const a = (config as { lenders?: { aave?: { chain_id?: unknown; pool?: unknown; usdc?: unknown; collateral?: unknown; max_fee_per_gas?: unknown } | null } | null } | null)?.lenders?.aave;
  if (!a || typeof a.chain_id !== "number" || typeof a.pool !== "string" || !ADDRESS.test(a.pool)) return null;
  const usdc = tokenOf(a.usdc);
  if (!usdc) return null;
  const collateral = (Array.isArray(a.collateral) ? a.collateral : []).map(tokenOf).filter((t): t is EvmToken => t !== null);
  return { chainId: a.chain_id, pool: a.pool.toLowerCase(), usdc, collateral, maxFeePerGas: typeof a.max_fee_per_gas === "string" && WEI.test(a.max_fee_per_gas) ? a.max_fee_per_gas : null };
}

/** One entry of get_state().evm.signed. `kind` is approve, supply, borrow, repay, withdraw or transfer. */
export interface EvmSigned {
  nonce: number;
  kind: string;
  token: string | null;
  amount: string | null;
  raw: string;
  hash: string;
  /** "<pid>:<i>" for a plan step's transaction, else null. */
  step: string | null;
  /** The block time it was signed at, in ms (the view's `signed_at`, nanoseconds). Left out where the account doesn't say. */
  signedAtMs?: number;
}

/** A nonce as the account writes it: a whole number, or the same in a string. Null for anything else. */
function nonceOf(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** get_state().evm: the account's next nonce and its signed transactions, oldest first. Null for an account without it. */
export function readEvm(state: { evm?: unknown } | null | undefined): { nonce: number; signed: EvmSigned[] } | null {
  const evm = state?.evm as { nonce?: unknown; signed?: unknown } | null | undefined;
  const next = evm && typeof evm === "object" ? nonceOf(evm.nonce) : null;
  if (!evm || next === null) return null;
  const text = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
  const signed: EvmSigned[] = [];
  for (const e of (Array.isArray(evm.signed) ? evm.signed : []) as (Record<string, unknown> | null)[]) {
    const nonce = e ? nonceOf(e.nonce) : null;
    if (!e || nonce === null || typeof e.raw !== "string" || typeof e.hash !== "string" || !HASH.test(e.hash)) continue;
    const at = text(e.signed_at);
    const signedAtMs = at !== null && /^\d{1,25}$/.test(at) && BigInt(at) > 0n ? Number(BigInt(at) / 1_000_000n) : undefined;
    signed.push({ nonce, kind: typeof e.kind === "string" ? e.kind : "?", token: text(e.token)?.toLowerCase() ?? null, amount: text(e.amount), raw: e.raw, hash: e.hash.toLowerCase(), step: typeof e.step === "string" ? e.step : null, ...(signedAtMs !== undefined ? { signedAtMs } : {}) });
  }
  return { nonce: next, signed };
}

/** A signed Aave action the account still lists in `pending` (INTERFACES.md 33): it has `evm_nonce` and no `until_block`. */
export interface PendingAave {
  kind: string;
  amount: string;
  token: string | null;
  evmNonce: number;
}

/** The `{"lender": {"lender": "aave", …, "evm_nonce": n}}` entries of get_state().pending. */
export function pendingAave(pending: unknown): PendingAave[] {
  const out: PendingAave[] = [];
  for (const entry of Array.isArray(pending) ? pending : []) {
    const l = (entry as { lender?: Record<string, unknown> } | null)?.lender;
    const evmNonce = l && typeof l === "object" ? nonceOf(l.evm_nonce) : null;
    if (!l || l.lender !== "aave" || evmNonce === null) continue;
    out.push({ kind: String(l.kind ?? ""), amount: String(l.amount ?? ""), token: typeof l.token === "string" ? l.token.toLowerCase() : null, evmNonce });
  }
  return out;
}

// ---------- reading a signed transaction's own fields ----------

type Rlp = Uint8Array | Rlp[];

function decodeAt(bytes: Uint8Array, at: number): [Rlp, number] {
  const first = bytes[at];
  if (first === undefined) throw new Error("short");
  if (first < 0x80) return [bytes.subarray(at, at + 1), at + 1];
  const list = first >= 0xc0;
  let start = at + 1;
  let length = first - (list ? 0xc0 : 0x80);
  if (length > 55) {
    const sizeBytes = length - 55;
    if (sizeBytes > 4 || start + sizeBytes > bytes.length) throw new Error("length");
    length = 0;
    for (let i = 0; i < sizeBytes; i += 1) length = length * 256 + bytes[start + i]!;
    start += sizeBytes;
  }
  const end = start + length;
  if (end > bytes.length) throw new Error("short");
  if (!list) return [bytes.subarray(start, end), end];
  const items: Rlp[] = [];
  let next = start;
  while (next < end) {
    const [item, after] = decodeAt(bytes, next);
    items.push(item);
    next = after;
  }
  if (next !== end) throw new Error("list");
  return [items, end];
}

/** What a signed type 2 transaction says of itself: the first six of its twelve fields. */
export interface RawFields {
  chainId: number;
  nonce: number;
  /** max_priority_fee_per_gas and max_fee_per_gas, in wei. */
  tip: bigint;
  maxFee: bigint;
  to: string;
}

/** Reads a raw type 2 transaction's fields, or null if it isn't one (0x02, then an RLP list of 12, with a 20-byte receiver). */
export function rawFields(raw: string): RawFields | null {
  if (typeof raw !== "string" || !/^0x02([0-9a-fA-F]{2})+$/.test(raw)) return null;
  try {
    const bytes = Uint8Array.from(Buffer.from(raw.slice(4), "hex"));
    const [list, end] = decodeAt(bytes, 0);
    if (end !== bytes.length || !Array.isArray(list) || list.length !== 12) return null;
    const number = (i: number): bigint => {
      const item = list[i]!;
      if (Array.isArray(item) || item.length > 32) throw new Error("number");
      return item.length === 0 ? 0n : BigInt(`0x${Buffer.from(item).toString("hex")}`);
    };
    const to = list[5]!;
    if (Array.isArray(to) || to.length !== 20) return null;
    const [chainId, nonce] = [number(0), number(1)];
    if (chainId > BigInt(Number.MAX_SAFE_INTEGER) || nonce > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return { chainId: Number(chainId), nonce: Number(nonce), tip: number(2), maxFee: number(3), to: `0x${Buffer.from(to).toString("hex")}` };
  } catch {
    return null;
  }
}

/** Why the keeper won't send this entry itself, or null if it will: only what the account's Aave settings allow. */
export function sendProblem(entry: Pick<EvmSigned, "nonce" | "raw">, aave: AaveSettings): string | null {
  const fields = rawFields(entry.raw);
  if (!fields) return "it isn't a type 2 Ethereum transaction";
  if (fields.chainId !== aave.chainId) return `it is for chain ${fields.chainId}, and the account's Aave settings name chain ${aave.chainId}`;
  if (fields.nonce !== entry.nonce) return `it carries nonce ${fields.nonce} inside`;
  if (fields.to !== aave.pool && fields.to !== aave.usdc.address && !aave.collateral.some((t) => t.address === fields.to)) return `it goes to ${fields.to}, which is neither Aave's Pool nor a token of the account's Aave settings`;
  return null;
}

// ---------- the chain ----------

/** What became of a send. `known`: the node had it already. `used`: the chain has used that nonce already. */
export type SendAnswer = { status: "sent" | "known" | "used" } | { status: "refused"; why: string };

/** What the keeper needs from Aave's chain; tests pass a fake. */
export interface EvmNode {
  /** How many transactions of `address` the chain has mined: its next nonce. */
  chainNonce(address: string): Promise<number>;
  /** What `owner` lets `spender` take of `token`, in the token's units. */
  allowance(token: string, owner: string, spender: string): Promise<bigint>;
  /** Sends a signed transaction, and checks the node answers `hash` for it. */
  send(raw: string, hash: string): Promise<SendAnswer>;
}

/** `allowance(address,address)` on an ERC-20 token: the first four bytes of keccak256 of that signature (recomputed with @noble/hashes on 11 Nov). */
export const ALLOWANCE_SELECTOR = "0xdd62ed3e";
/** The node's words for "I have this one already" and "the chain has used this nonce" (go-ethereum's txpool and core errors; reth says the same). */
const KNOWN = /already known|known transaction|already imported/i;
const NONCE_USED = /nonce too low/i;

interface Reply {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown };
}

export class EvmHttp implements EvmNode {
  readonly #url: string;
  readonly #host: string;
  readonly #chainId: number;
  readonly #fetch: typeof fetch;

  constructor(options: { url: string; chainId: number; fetch?: typeof fetch }) {
    this.#url = options.url;
    // Only the host goes into messages: an RPC URL can carry a key.
    this.#host = new URL(options.url).host;
    this.#chainId = options.chainId;
    this.#fetch = options.fetch ?? fetch;
  }

  /** One request, in a batch behind eth_chainId. Its result, or `{error}` in the node's words. Throws when the node can't be read or is on another chain. */
  async #ask(method: string, params: unknown[]): Promise<{ result: unknown } | { error: string }> {
    let replies: unknown;
    try {
      const response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 0, method: "eth_chainId", params: [] },
          { jsonrpc: "2.0", id: 1, method, params },
        ]),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      replies = await response.json();
    } catch (error) {
      throw new Error(`Aave's chain (${this.#host}) didn't answer ${method}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(replies)) throw new Error(`Aave's chain (${this.#host}) refused the request for ${method}`);
    const byId = new Map((replies as Reply[]).map((r) => [r?.id, r]));
    const chain = byId.get(0)?.result;
    if (typeof chain !== "string" || !/^0x[0-9a-fA-F]+$/.test(chain)) throw new Error(`Aave's chain (${this.#host}) didn't say which chain it is`);
    if (Number(BigInt(chain)) !== this.#chainId) throw new Error(`EVM_RPC_URL (${this.#host}) answers for chain ${Number(BigInt(chain))}, and the keeper is set to chain ${this.#chainId}`);
    const reply = byId.get(1);
    if (!reply) throw new Error(`Aave's chain (${this.#host}) left ${method} out of its answer`);
    if (reply.error) return { error: String(reply.error.message ?? "no reason given").slice(0, 200) };
    return { result: reply.result ?? null };
  }

  async #quantity(method: string, params: unknown[]): Promise<bigint> {
    const answer = await this.#ask(method, params);
    if ("error" in answer) throw new Error(`${method} failed on ${this.#host}: ${answer.error}`);
    if (typeof answer.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(answer.result)) throw new Error(`${method} on ${this.#host} answered something that isn't a number`);
    return BigInt(answer.result);
  }

  async chainNonce(address: string): Promise<number> {
    return Number(await this.#quantity("eth_getTransactionCount", [address, "latest"]));
  }

  async allowance(token: string, owner: string, spender: string): Promise<bigint> {
    const word = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");
    return this.#quantity("eth_call", [{ to: token, data: `${ALLOWANCE_SELECTOR}${word(owner)}${word(spender)}` }, "latest"]);
  }

  async send(raw: string, hash: string): Promise<SendAnswer> {
    const answer = await this.#ask("eth_sendRawTransaction", [raw]);
    if ("error" in answer) {
      if (KNOWN.test(answer.error)) return { status: "known" };
      if (NONCE_USED.test(answer.error)) return { status: "used" };
      return { status: "refused", why: answer.error };
    }
    if (typeof answer.result !== "string" || answer.result.toLowerCase() !== hash.toLowerCase()) return { status: "refused", why: `the node answered another hash (${String(answer.result).slice(0, 70)}) than the account stored` };
    return { status: "sent" };
  }
}

/** The backend's POST /api/evm/submit {account, nonce}: its HTTP status and body. */
export type EvmSubmit = (account: string, nonce: number) => Promise<{ status: number; body: unknown }>;

export function backendSubmit(apiUrl: string, fetchImpl: typeof fetch = fetch): EvmSubmit {
  const url = `${apiUrl.replace(/\/+$/, "")}/api/evm/submit`;
  return async (account, nonce) => {
    const response = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account, nonce }), signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: response.status, body: text };
    }
  };
}

/** A transaction still not mined is sent again this often: a node can drop one it held. */
export const RESEND_MS = 60_000;

/**
 * Sends each account's signed transactions that the chain hasn't used yet: through the backend's route, and by
 * itself as a backup, the way SignedPoster backs up Hyperliquid posts. Sending twice is harmless (the chain takes a
 * nonce once), so nothing is kept between runs: an entry is sent again a minute later while it still isn't mined.
 */
export class EvmSender {
  readonly #node: Pick<EvmNode, "send">;
  readonly #submit: EvmSubmit | null;
  readonly #now: () => number;
  /** "<account>#<hash>" -> when it was last sent; a refused entry is kept with Infinity. */
  readonly #sent = new Map<string, number>();

  constructor(node: Pick<EvmNode, "send">, submit: EvmSubmit | null, now: () => number = Date.now) {
    this.#node = node;
    this.#submit = submit;
    this.#now = now;
  }

  /** One log line per entry handled, lowest nonce first. `chainNonce` is how many the chain has used. */
  async sendNew(account: string, entries: EvmSigned[], chainNonce: number, aave: AaveSettings): Promise<string[]> {
    const lines: string[] = [];
    // The newest entry of each nonce: a bump signs a nonce again, and the later one is the one to send.
    const newest = new Map<number, EvmSigned>();
    for (const e of entries) if (e.nonce >= chainNonce) newest.set(e.nonce, e);
    for (const entry of [...newest.values()].sort((a, b) => a.nonce - b.nonce)) {
      const key = `${account}#${entry.hash}`;
      const last = this.#sent.get(key);
      if (last !== undefined && this.#now() - last < RESEND_MS) continue;
      const name = `signed transaction ${entry.nonce} (${entry.kind})`;
      const problem = sendProblem(entry, aave);
      if (problem) {
        this.#sent.set(key, Number.POSITIVE_INFINITY);
        lines.push(`${name} not sent: ${problem}`);
        continue;
      }
      if (this.#sent.size > 5_000) this.#sent.clear();
      this.#sent.set(key, this.#now());
      const said: string[] = [];
      if (this.#submit) {
        try {
          const reply = await this.#submit(account, entry.nonce);
          const body = reply.body as { status?: unknown; message?: unknown } | string | null;
          said.push(reply.status === 200 && typeof body === "object" && typeof body?.status === "string" ? `the backend answered ${body.status}` : `the backend refused it (HTTP ${reply.status}${typeof body === "object" && typeof body?.message === "string" ? `: ${body.message}` : ""})`);
        } catch (error) {
          said.push(`the backend did not answer (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      try {
        const own = await this.#node.send(entry.raw, entry.hash);
        if (own.status === "refused") said.push(`the chain's node refused the keeper's own send: ${own.why}`);
        else said.push(own.status === "sent" ? "the keeper's own send went out" : own.status === "known" ? "the chain's node had it already" : "the chain has used that nonce already");
      } catch (error) {
        said.push(`the keeper's own send failed (${error instanceof Error ? error.message : String(error)})`);
      }
      lines.push(`${name} sent: ${said.join("; ")}`);
    }
    return lines;
  }
}
