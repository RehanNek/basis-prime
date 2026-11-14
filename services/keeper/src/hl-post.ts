// A backup for the web app (INTERFACES.md 8 and 11): the keeper posts each account's newly signed Hyperliquid
// actions (get_state().hl.signed) to Hyperliquid's /exchange, in case the page that asked for them closed before
// it posted. Posting twice is harmless: Hyperliquid refuses a nonce it has seen. So the keeper keeps no record
// between runs; it only skips entries it posted itself, and entries older than a few minutes, which the web app
// will have posted (or which Hyperliquid would refuse as stale anyway). Testnet actions only.

export interface SignedEntry {
  index: number;
  kind: string;
  /** Compact JSON, posted parsed, so its strings reach Hyperliquid unchanged. */
  action: string;
  nonce: number;
  signature: { r: string; s: string; v: number };
  signed_block: number;
}

/** Only actions signed this recently: their nonce is a time in ms, close to Hyperliquid's clock (INTERFACES.md 8). */
export const POST_WINDOW_MS = 10 * 60_000;
const KINDS = ["approveAgent", "sendAsset"];
const HEX64 = /^0x[0-9a-f]{64}$/i;

export type Exchange = (body: unknown) => Promise<{ status: number; body: unknown }>;

/** What goes to /exchange for one entry, or why it won't be posted. */
export function exchangeBody(entry: SignedEntry): { body?: { action: unknown; nonce: number; signature: SignedEntry["signature"] }; refused?: string } {
  if (!KINDS.includes(entry.kind)) return { refused: `a ${entry.kind}, which the keeper doesn't post` };
  let action: Record<string, unknown>;
  try {
    action = JSON.parse(entry.action) as Record<string, unknown>;
  } catch {
    return { refused: "its action isn't JSON" };
  }
  if (action?.type !== entry.kind) return { refused: `its action isn't a ${entry.kind}` };
  if (action.hyperliquidChain !== "Testnet") return { refused: `it is for Hyperliquid ${String(action.hyperliquidChain)}; the keeper posts testnet actions only` };
  if (action.nonce !== entry.nonce) return { refused: "its nonce doesn't match its action" };
  const { r, s, v } = entry.signature ?? ({} as SignedEntry["signature"]);
  if (!HEX64.test(r) || !HEX64.test(s) || (v !== 27 && v !== 28)) return { refused: "its signature isn't {r, s, v}" };
  return { body: { action, nonce: entry.nonce, signature: { r, s, v } } };
}

export class SignedPoster {
  readonly #exchange: Exchange;
  readonly #now: () => number;
  /** "<account>#<index>" for every entry this process has posted or refused. */
  readonly #done = new Set<string>();

  constructor(exchange: Exchange, now: () => number = Date.now) {
    this.#exchange = exchange;
    this.#now = now;
  }

  /** Posts the account's recent entries this process hasn't handled yet. Returns one log line per entry. */
  async postNew(account: string, entries: SignedEntry[]): Promise<string[]> {
    const lines: string[] = [];
    const fresh = entries.filter((e) => !this.#done.has(`${account}#${e.index}`) && this.#now() - e.nonce <= POST_WINDOW_MS);
    for (const entry of fresh.sort((a, b) => a.index - b.index)) {
      const key = `${account}#${entry.index}`;
      const { body, refused } = exchangeBody(entry);
      if (!body) {
        this.#done.add(key);
        lines.push(`signed #${entry.index} not posted: ${refused}`);
        continue;
      }
      try {
        const reply = await this.#exchange(body);
        this.#done.add(key);
        const answer = reply.body as { status?: unknown; response?: unknown } | string;
        const ok = reply.status === 200 && typeof answer === "object" && answer?.status === "ok";
        const words = ok ? "Hyperliquid accepted it" : `Hyperliquid answered ${typeof answer === "string" ? answer : JSON.stringify(answer?.response ?? answer)}`;
        lines.push(`signed #${entry.index} (${entry.kind}) posted: ${words}`);
      } catch (error) {
        // Not marked done: the next tick tries again while the entry is recent.
        lines.push(`signed #${entry.index} (${entry.kind}): Hyperliquid did not answer (${error instanceof Error ? error.message : String(error)}); will retry`);
      }
    }
    return lines;
  }
}

/** POST <api>/exchange. The keeper refuses a mainnet HL_API_URL at start (config.ts). */
export function hlExchange(apiUrl: string, fetchImpl: typeof fetch = fetch): Exchange {
  const url = `${apiUrl.replace(/\/+$/, "")}/exchange`;
  return async (body) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: response.status, body: text };
    }
  };
}
