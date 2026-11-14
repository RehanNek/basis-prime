// INTERFACES.md 49.4: checks the broker pays for.
//
//   POST /api/check {account, intent}
//
// The account's `request_check` may be called by anyone, and the keeper calls it every hour. So the app no longer
// has the client's wallet send it: the page posts here, the backend makes sure the wallet that asks owns the
// account, and hands the check to the keeper over the keeper's own port with the service token (48.3). The keeper
// sends it with 0.01 NEAR of its own, and asks again, up to three times, when OutLayer brings no verdict. The
// client's wallet then approves only the action.
//
// The page falls back to the check from the client's wallet when this answers 404 (privacy is off, so there is no
// owner to prove), 503 `keeper_off` (the keeper isn't running or doesn't know this backend), or a refusal.
import type { Deps } from "./handlers.js";
import { NotDeployedError } from "./rpc.js";
import type { Who } from "./session.js";
import { asObject, badRequest, HttpError, isPrimeAccount, parseIntent } from "./validate.js";

/** Checks one account's owner may ask the keeper for in a minute. Each one is a paid run and 0.01 NEAR of the keeper's. */
export const CHECKS_PER_MINUTE = 6;

/** What the keeper answers (services/keeper/src/loop.ts, ClientCheckAnswer). */
export type CheckAnswer = { accepted: true; blk: number | null; tries: number; tx: string | null } | { accepted: false; reason: string; tries: number; tx: string | null };

/** The keeper's POST /check, as the backend calls it: the HTTP status and the body. It throws when the keeper doesn't answer at all. */
export type KeeperCheck = (account: string, intent: unknown) => Promise<{ status: number; body: unknown }>;

/**
 * The keeper's door, over HTTP on this machine. `token` is the service token the backend made at start: the keeper
 * reads the same one from its file, and answers no other caller. `waitMs` is how long one run may take at
 * OutLayer; the keeper asks up to three times.
 */
export function keeperCheckOver(url: string, token: string, waitMs: number, fetchImpl: typeof fetch = fetch): KeeperCheck {
  return async (account, intent) => {
    const response = await fetchImpl(`${url}/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ account, intent }),
      signal: AbortSignal.timeout(3 * (waitMs + 30_000)),
    });
    const text = await response.text();
    try {
      return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
    } catch {
      return { status: response.status, body: null };
    }
  };
}

const KEEPER_OFF = "The keeper isn't running, so it can't ask for this check: ask for it from your wallet";
/** A call to the keeper that fails only after this long was taken and is being worked on: a refused connection fails in milliseconds. */
export const KEEPER_AT_WORK_MS = 30_000;

/**
 * POST /api/check. Only the account's owner, by a wallet's token: not our own service, and not the operator's or
 * the keeper's wallet unless it owns the account. Six a minute for an account. With privacy off nobody signs in,
 * so there is no owner to prove, and the route isn't there.
 */
export async function postCheck(deps: Deps, asker: Who, body: unknown): Promise<CheckAnswer> {
  const { ids } = deps.config;
  if (deps.config.accountPrivacy === "off" || !deps.sessions) throw new HttpError(404, "not_found", "No route for POST /api/check");
  if (asker.kind === "none") throw new HttpError(401, "sign_in", "Sign in with the wallet that owns this account");
  if (asker.kind !== "wallet") throw new HttpError(403, "not_yours", "Only the wallet that owns an account can ask for its check");
  const fields = asObject(body);
  const account = fields.account;
  if (!isPrimeAccount(account, ids.factory)) throw badRequest(`account must be a client account, <name>.${ids.factory}`);

  // The owner, before anything that costs: a wallet's token says who is asking, and the account says whose it is.
  const now = deps.now();
  let owner = deps.sessions.ownerOf(account, now);
  if (owner === undefined) {
    try {
      const state = (await deps.chain.view<{ owner?: unknown } | null>(account, "get_state")).value;
      owner = typeof state?.owner === "string" ? state.owner : undefined;
    } catch (error) {
      if (!(error instanceof NotDeployedError)) throw error;
    }
    if (owner === undefined) throw new HttpError(404, "no_account", `${account} isn't a client account yet: there is nothing to check`);
    deps.sessions.keepOwner(account, owner, now);
  }
  if (owner !== asker.wallet) throw new HttpError(403, "not_yours", "This account belongs to another wallet");

  // A withdrawal names one of the account's own tokens: its settings may list more than the backend's two.
  const config = await deps.chain.view<{ tokens?: ({ id?: unknown } | null)[] } | null>(account, "get_config").catch(() => null);
  const own = (config?.value?.tokens ?? []).map((t) => t?.id).filter((id): id is string => typeof id === "string");
  const intent = parseIntent(fields.intent, [...new Set([...ids.tokens.map((t) => t.id), ...own])]);

  const keeper = deps.keeperCheck;
  if (!keeper) throw new HttpError(503, "keeper_off", KEEPER_OFF);
  if (deps.limits.checks && !deps.limits.checks.take(account)) {
    throw new HttpError(429, "too_many_checks", `At most ${CHECKS_PER_MINUTE} checks a minute for an account; try again shortly`);
  }
  let answer: { status: number; body: unknown };
  const asked = deps.now();
  try {
    answer = await keeper(account, intent);
  } catch (error) {
    // Cut off while the keeper was still at it: the check may yet land, so the page waits and watches the account.
    // A keeper that isn't there refuses the connection at once. One that took the request and was cut off after
    // minutes is at work: Node drops a request with no answer after 300 seconds, with a plain "fetch failed"
    // (INTERFACES.md 51.15: on 14 Nov that sent a client to a wallet-paid check for the same slow OutLayer).
    const cutOff = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (cutOff || deps.now() - asked >= KEEPER_AT_WORK_MS) {
      throw new HttpError(504, "check_slow", "The check is taking longer than usual. Its result may still arrive");
    }
    throw new HttpError(503, "keeper_off", KEEPER_OFF);
  }
  // A keeper that doesn't know this backend's token was started with another backend, or reads another file.
  if (answer.status === 401 || answer.status === 404) throw new HttpError(503, "keeper_off", "The keeper doesn't take checks from this backend (start it again after the backend): ask for the check from your wallet");
  const said = (answer.body && typeof answer.body === "object" ? answer.body : {}) as { accepted?: unknown; blk?: unknown; tries?: unknown; tx?: unknown; reason?: unknown };
  if (answer.status !== 200 || typeof said.accepted !== "boolean") throw new HttpError(503, "keeper_failed", "The keeper couldn't ask for this check: ask for it from your wallet");
  const tries = typeof said.tries === "number" ? said.tries : 0;
  const tx = typeof said.tx === "string" ? said.tx : null;
  if (said.accepted) return { accepted: true, blk: typeof said.blk === "number" ? said.blk : null, tries, tx };
  return { accepted: false, reason: typeof said.reason === "string" ? said.reason : "The check brought no result", tries, tx };
}
