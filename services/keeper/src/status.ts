// The keeper's status page: GET / (or /status) on localhost answers what the keeper is doing, as JSON. It only reads
// the keeper's memory; it changes nothing. .claude/launch.json's `keeper` entry waits on this port.
//
// INTERFACES.md 49.4: POST /check {account, intent} on the same port has the keeper ask for a check and pay for it.
// It answers only a caller with the backend's service token (48.3), which is our own backend: the page asks the
// backend, the backend checks that the wallet owns the account, and hands the check on here.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

import type { AccountMemory, ClientCheckAnswer } from "./loop.js";

export interface KeeperStatus {
  started_at: string;
  last_tick_at: string | null;
  tick_ms: number;
  dry_run: boolean;
  log_file: string;
  accounts: Record<string, unknown>;
}

/** What the page shows of one account's memory: its state and the times of the next checks. */
export function accountStatus(memory: AccountMemory): Record<string, unknown> {
  const m = memory.decide;
  const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());
  return {
    state: m.lastState ?? null,
    verdict: m.verdictKey ?? null,
    last_check_at: iso(m.lastCheckAt),
    // One check at a time: a check that hasn't come back (asked for then), and what waits to be asked behind it.
    check_out_since: iso(m.checkPending?.at),
    check_waiting: m.checkHeld ?? [],
    next_hourly_check_at: iso(m.nextHourlyAt),
    second_check: m.secondCheck ? { first_at: iso(m.secondCheck.firstAt), sent_at: iso(m.secondCheck.sentAt), tries: m.secondCheck.tries } : null,
    recovering_since: iso(m.recoveringSince),
    plans: m.plans ?? {},
    // Phase 6: the funding plan the keeper is running, the block a lender action is waited out until, and whether
    // the hourly settlement is still to go.
    fundings: m.fundings ?? {},
    lender_wait_until_block: m.lenderUntil ?? null,
    settle_due: m.settleDue !== undefined,
    transfers: memory.transfers,
    missing: memory.missing ?? false,
  };
}

/** INTERFACES.md 49.4: what POST /check needs. `token` reads the backend's service token (null: no file); `run` asks for the check. */
export interface CheckDoor {
  token(): string | null;
  run(account: string, intent: unknown): Promise<ClientCheckAnswer>;
}

const MAX_CHECK_BODY = 4 * 1024;

/** Whether the request carries the service token, compared in constant time. With no token on file nobody does. */
function hasServiceToken(request: IncomingMessage, token: string | null): boolean {
  const header = request.headers.authorization;
  const sent = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token || !sent) return false;
  const [a, b] = [Buffer.from(sent, "utf8"), Buffer.from(token, "utf8")];
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > MAX_CHECK_BODY) throw new Error("too large");
  }
  return JSON.parse(text) as unknown;
}

export function statusServer(status: () => KeeperStatus, check?: CheckDoor): Server {
  return createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    const send = (code: number, body: unknown) => {
      response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(body, null, 1));
    };
    if (request.method === "GET" && (path === "/" || path === "/status")) return send(200, status());
    if (request.method === "POST" && path === "/check" && check) {
      // The token comes first: nothing of the body is read for a caller without it.
      if (!hasServiceToken(request, check.token())) return send(401, { error: "unauthorized", message: "POST /check answers the backend's service token only" });
      readBody(request)
        .then(
          (body) => {
            const fields = (body && typeof body === "object" ? body : {}) as { account?: unknown; intent?: unknown };
            if (typeof fields.account !== "string" || !fields.account || !fields.intent || typeof fields.intent !== "object") {
              return send(400, { error: "bad_request", message: "POST /check takes {account, intent}" });
            }
            return check.run(fields.account, fields.intent).then((answer) => send(200, answer));
          },
          () => send(400, { error: "bad_request", message: "The body is not JSON, or is too large" }),
        )
        .catch(() => send(500, { error: "internal", message: "The keeper failed; its log says why" }));
      return;
    }
    send(404, { error: "not_found", message: "GET / for the keeper's status" });
  });
}
