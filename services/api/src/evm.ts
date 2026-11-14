// A small Ethereum JSON-RPC client (INTERFACES.md 28 and 33). Every request goes as one batch with `eth_chainId`
// first, so an RPC URL that points at another chain is caught before its numbers are believed, or anything is sent
// to it. Stage 1 made `eth_call`s only (`calls`). Stage 3 adds `batch`, for the balances, nonces and receipts the
// lender page shows, and for `eth_sendRawTransaction`: the accounts' own signed transactions, and the gas wallet's.
// Nothing is signed here (evm-tx.ts signs for the gas wallet). Call data is written and results are read by hand.

/** The chain's RPC failed, or answered something we can't read. */
export class EvmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvmError";
  }
}

export interface EvmCall {
  to: string;
  data: string;
}

/** What the handlers need from an Ethereum chain; tests pass a fake. */
export interface EvmReader {
  /** The chain's id and each call's result as 0x hex, in the order asked, all at the latest block. */
  calls(calls: EvmCall[]): Promise<{ chainId: number; results: string[] }>;
}

/** One JSON-RPC request of a batch. */
export interface EvmRequest {
  method: string;
  params: unknown[];
}

/** One request's answer: its result, or the node's own words for why not. */
export type EvmReply = { ok: true; result: unknown } | { ok: false; error: string; code: number | null };

/** Stage 3: any request, with the chain's id read in the same batch. A request the node refuses is a reply, not a throw. */
export interface EvmChain extends EvmReader {
  batch(requests: EvmRequest[]): Promise<{ chainId: number; replies: EvmReply[] }>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SELECTOR = /^0x[0-9a-f]{8}$/;

export function isEvmAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS.test(value);
}

/** Call data for `f(address)`: the 4-byte selector, then the address left-padded to 32 bytes. */
export function callWithAddress(selector: string, address: string): string {
  if (!SELECTOR.test(selector)) throw new EvmError(`${selector} is not a 4-byte selector in lowercase hex`);
  if (!isEvmAddress(address)) throw new EvmError(`${address} is not a 0x address`);
  return `${selector}${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

/** A call's result as 32-byte words. A result with fewer than `atLeast` words isn't the layout we expect. */
export function words(result: string, atLeast: number, what: string): bigint[] {
  if (typeof result !== "string" || !/^0x([0-9a-fA-F]{64})*$/.test(result)) throw new EvmError(`${what} answered something that isn't whole 32-byte words`);
  const out: bigint[] = [];
  for (let i = 2; i < result.length; i += 64) out.push(BigInt(`0x${result.slice(i, i + 64)}`));
  if (out.length < atLeast) throw new EvmError(`${what} answered ${out.length} words where ${atLeast} were expected: is the address the right contract?`);
  return out;
}

interface RpcReply {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown; code?: unknown };
}

export class EvmRpc implements EvmChain {
  readonly #url: string;
  readonly #host: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: { url: string; fetch?: typeof fetch; timeoutMs?: number }) {
    this.#url = options.url;
    // Only the host goes into messages: an RPC URL can carry a key.
    this.#host = new URL(options.url).host;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async calls(calls: EvmCall[]): Promise<{ chainId: number; results: string[] }> {
    const { chainId, replies } = await this.batch(calls.map((call) => ({ method: "eth_call", params: [{ to: call.to, data: call.data }, "latest"] })));
    const results = calls.map((call, i) => {
      const reply = replies[i]!;
      const what = `eth_call to ${call.to}`;
      if (!reply.ok) throw new EvmError(`${what} failed on ${this.#host}: ${reply.error}`);
      if (typeof reply.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(reply.result)) throw new EvmError(`${what} on ${this.#host} answered something that isn't hex`);
      return reply.result;
    });
    return { chainId, results };
  }

  async batch(requests: EvmRequest[]): Promise<{ chainId: number; replies: EvmReply[] }> {
    const batch = [{ jsonrpc: "2.0", id: 0, method: "eth_chainId", params: [] }, ...requests.map((r, i) => ({ jsonrpc: "2.0", id: i + 1, method: r.method, params: r.params }))];
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new EvmError(`The Ethereum RPC (${this.#host}) didn't answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new EvmError(`The Ethereum RPC (${this.#host}) answered HTTP ${response.status}`);
    let replies: unknown;
    try {
      replies = await response.json();
    } catch {
      throw new EvmError(`The Ethereum RPC (${this.#host}) answered something that isn't JSON`);
    }
    if (!Array.isArray(replies)) {
      const message = (replies as RpcReply | null)?.error?.message;
      throw new EvmError(`The Ethereum RPC (${this.#host}) refused the batch${typeof message === "string" ? `: ${message.slice(0, 200)}` : ""}`);
    }
    // A batch may come back in any order: match by id.
    const byId = new Map((replies as RpcReply[]).map((reply) => [reply?.id, reply]));
    const reply = (id: number, what: string): EvmReply => {
      const answer = byId.get(id);
      if (!answer) throw new EvmError(`The Ethereum RPC (${this.#host}) left ${what} out of its answer`);
      if (answer.error) return { ok: false, error: String(answer.error.message ?? "no reason given").slice(0, 200), code: typeof answer.error.code === "number" ? answer.error.code : null };
      return { ok: true, result: answer.result ?? null };
    };
    const chain = reply(0, "eth_chainId");
    if (!chain.ok) throw new EvmError(`eth_chainId failed on ${this.#host}: ${chain.error}`);
    if (typeof chain.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(chain.result)) throw new EvmError(`eth_chainId on ${this.#host} answered something that isn't hex`);
    if (chain.result === "0x") throw new EvmError(`eth_chainId on ${this.#host} answered nothing`);
    const what = (r: EvmRequest) => (r.method === "eth_call" ? `eth_call to ${String((r.params[0] as { to?: unknown } | undefined)?.to)}` : r.method);
    return { chainId: Number(BigInt(chain.result)), replies: requests.map((r, i) => reply(i + 1, what(r))) };
  }
}
