// Privacy level 1, "hide who" (INTERFACES.md 48; research/privacy_level1_plan.md): the app shows a client account only
// to its owner and to us. This file is who is asking and who may see an account.
//
//   POST /api/session   {auth}: a wallet proves it holds a full-access key of itself, once, and gets a token for 12 hours
//   who(request)        none, our own service, or a wallet, from `Authorization: Bearer <token>`
//   mayView(who, id)    yes, or the refusal: 401 sign_in with no token, 403 not_yours for another wallet's account
//
// What it does not do: NEAR itself stays readable, the factory still lists each account with its owner, and
// Hyperliquid positions stay public. Our backend stops being the easy way in; it is not a wall.
//
// Nothing here logs or answers a token, a key or the secret. Tokens are compared in constant time.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Deps } from "./handlers.js";
import { parseAuth } from "./hl-handlers.js";
import { RateLimiter } from "./limiter.js";
import { verifyNep413 } from "./nep413.js";
import { NotDeployedError } from "./rpc.js";
import { asObject, badRequest, HttpError, isAccountId } from "./validate.js";

/** The NEP-413 recipient of a sign-in. An order's is the gateway's, so neither signature can pass as the other. */
export const SESSION_RECIPIENT = "pb-app-session";
/** A sign-in lasts 12 hours. */
export const SESSION_MS = 12 * 60 * 60_000;
/** A sign-in message's `until` is at most this far ahead: the app writes 10 minutes, and a clock may be a minute off. */
export const SIGN_IN_AHEAD_MS = 10 * 60_000 + 60_000;
/** Sign-ins a minute, all wallets together: each one costs a read of NEAR. */
export const SIGN_INS_PER_MINUTE = 30;
/** An account's owner is kept this long: it never changes, and the read is one view. */
export const OWNER_CACHE_MS = 60_000;
const FIRST_LINE = "Sign in to Prime Broker";

/** Who a request is from. */
export type Who = { kind: "none" } | { kind: "service" } | { kind: "wallet"; wallet: string };

export const NOBODY: Who = { kind: "none" };

const b64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

/** Whether two texts are the same, in time that doesn't depend on where they differ. */
function sameText(a: string, b: string): boolean {
  const [x, y] = [Buffer.from(a, "utf8"), Buffer.from(b, "utf8")];
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * What the backend keeps for sign-ins, all in memory: the secret its tokens are signed with (32 random bytes, made
 * when it starts, so a restart signs every wallet out), the nonces of the sign-ins it has taken, the service token,
 * and each account's owner for a minute.
 */
export class Sessions {
  readonly #secret: Buffer;
  readonly #serviceToken: string | null;
  /** Nonces used for a sign-in, each kept until its message's `until`. */
  readonly #nonces = new Map<string, number>();
  readonly #owners = new Map<string, { at: number; owner: string }>();
  readonly signIns: RateLimiter;

  constructor(options: { secret?: Uint8Array; serviceToken?: string | null; now?: () => number } = {}) {
    this.#secret = Buffer.from(options.secret ?? randomBytes(32));
    if (this.#secret.length !== 32) throw new Error("the session secret is 32 bytes");
    this.#serviceToken = options.serviceToken ?? null;
    if (this.#serviceToken !== null && !/^svc\.[0-9a-f]{64}$/.test(this.#serviceToken)) throw new Error("a service token is svc. and 64 hex characters");
    this.signIns = new RateLimiter(SIGN_INS_PER_MINUTE, 60_000, options.now);
  }

  /** A wallet's token: `v1.<base64url of {"w", "exp"}>.<base64url of HMAC-SHA256(secret, "v1." + that part)>`. */
  issue(wallet: string, now: number): { token: string; wallet: string; expires_at_ms: number } {
    const expires = now + SESSION_MS;
    const signed = `v1.${b64url(JSON.stringify({ w: wallet, exp: expires }))}`;
    return { token: `${signed}.${this.#mac(signed)}`, wallet, expires_at_ms: expires };
  }

  /** The wallet a token is for, or null: not one of ours, changed, or expired. */
  walletOf(token: string, now: number): string | null {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) return null;
    // The check on the signature comes first, in constant time, before anything in the token is read.
    if (!sameText(parts[2], this.#mac(`v1.${parts[1]}`))) return null;
    try {
      const said = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { w?: unknown; exp?: unknown };
      if (!isAccountId(said.w) || typeof said.exp !== "number" || !Number.isSafeInteger(said.exp) || said.exp <= now) return null;
      return said.w;
    } catch {
      return null;
    }
  }

  /** Whether this is the service token the backend made at start. */
  isService(token: string): boolean {
    return this.#serviceToken !== null && sameText(token, this.#serviceToken);
  }

  /** Takes a sign-in's nonce: false if it was used before. It is kept until `untilMs`. */
  takeNonce(nonce: string, untilMs: number, now: number): boolean {
    for (const [used, until] of this.#nonces) if (until <= now) this.#nonces.delete(used);
    if (this.#nonces.has(nonce)) return false;
    this.#nonces.set(nonce, untilMs);
    return true;
  }

  /** Gives a nonce back, when the sign-in it was for couldn't be answered either way (NEAR's RPC was down). */
  releaseNonce(nonce: string): void {
    this.#nonces.delete(nonce);
  }

  ownerOf(account: string, now: number): string | undefined {
    const kept = this.#owners.get(account);
    return kept && now - kept.at < OWNER_CACHE_MS ? kept.owner : undefined;
  }

  keepOwner(account: string, owner: string, now: number): void {
    if (this.#owners.size > 5_000) this.#owners.clear(); // a flood of names can't grow it forever
    this.#owners.set(account, { at: now, owner });
  }

  #mac(text: string): string {
    return b64url(createHmac("sha256", this.#secret).update(text).digest());
  }
}

/** A new service token: `svc.` and 32 random bytes in hex. */
export function newServiceToken(): string {
  return `svc.${randomBytes(32).toString("hex")}`;
}

/** Writes the service token where our own services read it: the folder is made if missing, and the file is mode 600. */
export function writeServiceToken(file: string, token: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600); // an older file keeps its own mode through a rewrite
}

/** Removes the service token's file when the backend stops. A file that is gone already is fine. */
export function removeServiceToken(file: string): void {
  rmSync(file, { force: true });
}

/**
 * Who a request is from (INTERFACES.md 48.3), by its `Authorization: Bearer <token>`. A token that is bad, changed or
 * expired is treated as no token. With privacy off nobody is asked, and everybody is `none`.
 */
export function who(deps: Deps, request: { headers: Record<string, string | string[] | undefined> }): Who {
  const sessions = deps.sessions;
  if (deps.config.accountPrivacy === "off" || !sessions) return NOBODY;
  const header = request.headers.authorization;
  const text = Array.isArray(header) ? header[0] : header;
  const token = typeof text === "string" && text.startsWith("Bearer ") ? text.slice("Bearer ".length).trim() : "";
  if (!token || token.length > 600) return NOBODY;
  if (token.startsWith("svc.")) return sessions.isService(token) ? { kind: "service" } : NOBODY;
  const wallet = sessions.walletOf(token, deps.now());
  return wallet ? { kind: "wallet", wallet } : NOBODY;
}

/** Whether the asker is one of us: our own service, or the operator's or the keeper's wallet. */
export function isOurs(deps: Deps, asker: Who): boolean {
  const { operator, keeper } = deps.config.ids;
  return asker.kind === "service" || (asker.kind === "wallet" && (asker.wallet === operator || asker.wallet === keeper));
}

/**
 * Who may see an account (INTERFACES.md 48.4). It answers nothing when the asker may, and throws the refusal when
 * not: `401 sign_in` with no token, `403 not_yours` for another wallet's account. The refusal never names the owner.
 *
 * It is called before a route's own work: a stranger's request is refused before any read of the chain, any OutLayer
 * run and any rate limiter. The one read it may make itself is the account's `get_state`, for a signed-in wallet.
 */
export async function mayView(deps: Deps, asker: Who, account: string): Promise<void> {
  if (deps.config.accountPrivacy === "off") return;
  if (deps.config.openAccounts.includes(account)) return;
  if (asker.kind === "service") return;
  if (asker.kind === "none") throw new HttpError(401, "sign_in", "Sign in with the wallet that owns this account");
  if (isOurs(deps, asker)) return;
  // Not an account id at all: there is nothing to hide, and the route says what is wrong with it.
  if (!isAccountId(account)) return;
  const now = deps.now();
  let owner = deps.sessions?.ownerOf(account, now);
  if (owner === undefined) {
    try {
      owner = (await deps.chain.view<{ owner?: unknown } | null>(account, "get_state")).value?.owner as string | undefined;
    } catch (error) {
      // No such account, or one with no state: nothing of a client's is there, and the wallet may be about to make
      // it. This answer isn't kept: the next ask reads again. Any other failure is not a yes.
      if (error instanceof NotDeployedError) return;
      throw error;
    }
    if (typeof owner !== "string") return;
    deps.sessions?.keepOwner(account, owner, now);
  }
  if (owner === asker.wallet) return;
  throw new HttpError(403, "not_yours", "This account belongs to another wallet");
}

/**
 * POST /api/session {auth} (INTERFACES.md 48.2). The checks, in this order, each refusing with its own code:
 * the shape and the wallet named (400 bad_request); `until` (400 expired); the signature (400 auth); the nonce
 * (409 nonce_used); and that the key is a full-access key of the wallet on NEAR (403 not_your_key), without which
 * anyone could sign as anyone. An RPC that doesn't answer is 503, never a yes.
 */
export async function postSession(deps: Deps, body: unknown) {
  const sessions = deps.sessions;
  if (deps.config.accountPrivacy === "off" || !sessions) throw new HttpError(404, "not_found", "No route for POST /api/session");
  const parsed = parseAuth(asObject(body).auth, SESSION_RECIPIENT);
  const { auth } = parsed;
  const lines = /^([^\n]*)\nwallet: ([^\n]*)\nuntil: (0|[1-9]\d{0,15})$/.exec(auth.message);
  if (!lines || lines[1] !== FIRST_LINE) {
    throw badRequest(`auth.message must be exactly three lines: "${FIRST_LINE}", "wallet: <the wallet>", "until: <milliseconds since 1970>"`);
  }
  if (lines[2] !== auth.owner) throw badRequest("auth.message must name the wallet that signs it: its wallet line isn't auth.owner");
  const until = Number(lines[3]);
  const now = deps.now();
  if (!(until > now)) throw new HttpError(400, "expired", "This sign-in message's time has passed: sign a new one");
  if (until > now + SIGN_IN_AHEAD_MS) throw new HttpError(400, "expired", "This sign-in message is dated too far ahead: at most 10 minutes");
  if (!verifyNep413(parsed.publicKey, parsed.signature, { message: auth.message, nonce: parsed.nonce, recipient: SESSION_RECIPIENT })) {
    throw new HttpError(400, "auth", "The signature doesn't match the sign-in message and the key");
  }
  if (!sessions.takeNonce(auth.nonce, until, now)) throw new HttpError(409, "nonce_used", "This sign-in message was used already: sign a new one");
  // From here a request costs a read of NEAR, so the limit comes first. A signature alone proves nothing about the
  // wallet: anyone can make a key and sign with it.
  if (!sessions.signIns.take()) {
    sessions.releaseNonce(auth.nonce);
    throw new HttpError(429, "too_many_sign_ins", `At most ${SIGN_INS_PER_MINUTE} sign-ins a minute in all; try again shortly`);
  }
  let kind: "full" | "function_call" | "none";
  try {
    kind = await deps.chain.accessKey(auth.owner, auth.public_key);
  } catch {
    // Nobody is signed in on a read that failed. The nonce is given back, so the same message can be sent again.
    sessions.releaseNonce(auth.nonce);
    throw new HttpError(503, "near_rpc", "NEAR's RPC didn't answer, so the key couldn't be checked: try again in a moment");
  }
  if (kind !== "full") {
    throw new HttpError(403, "not_your_key", kind === "none" ? "This key isn't a key of that wallet on NEAR" : "This key can only call one contract for that wallet: sign in with the wallet's own full-access key");
  }
  return sessions.issue(auth.owner, now);
}
