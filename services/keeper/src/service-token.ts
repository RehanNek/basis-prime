// Privacy level 1 (INTERFACES.md 48.7): the keeper package's calls to our backend carry the backend's service token.
//
// With ACCOUNT_PRIVACY=owner the backend shows a client account only to its owner and to us. Our own services on
// this machine prove who they are with a token the backend makes when it starts and writes to a file only this user
// can read (services/api/logs/service-token unless SERVICE_TOKEN_FILE says otherwise). The keeper and the gate
// scripts read that file and send `Authorization: Bearer svc.<hex>` on every call to the backend. With no file
// (privacy off, or a backend from before 13 Nov) nothing is sent, and everything works as it did.
//
// The token goes to the backend and nowhere else: not to Hyperliquid, the stand-in or OutLayer. It is never logged.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Where the backend writes its token unless SERVICE_TOKEN_FILE says otherwise (services/api/src/config.ts has the same default). */
export const DEFAULT_SERVICE_TOKEN_FILE = fileURLToPath(new URL("../../api/logs/service-token", import.meta.url));

/** SERVICE_TOKEN_FILE, or the default: the same setting the backend reads. */
export function serviceTokenFile(setting: string | undefined): string {
  return setting?.trim() || DEFAULT_SERVICE_TOKEN_FILE;
}

type ReadFile = (file: string) => string;
const readText: ReadFile = (file) => readFileSync(file, "utf8");

/** The token in the file, or null: no file, a file that can't be read, or one that doesn't hold a service token. */
export function readServiceToken(file: string, read: ReadFile = readText): string | null {
  try {
    const text = read(file).trim();
    return /^svc\.[0-9a-f]{64}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * A `fetch` for calls to our backend. It adds the service token when the file has one, and nothing when it hasn't.
 * The file is read at the first call and kept. On a 401 it is read again: the backend makes a new token every time
 * it starts, and a keeper started before the backend found no file at all. If the file then gives another token,
 * the call is made once more with it; otherwise the 401 is the answer.
 */
export function backendFetch(file: string, fetchImpl: typeof fetch = fetch, read: ReadFile = readText): typeof fetch {
  let token: string | null | undefined;
  const withToken = (init: RequestInit | undefined, bearer: string | null): RequestInit | undefined =>
    bearer ? { ...init, headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}), Authorization: `Bearer ${bearer}` } } : init;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (token === undefined) token = readServiceToken(file, read);
    const answer = await fetchImpl(input, withToken(init, token));
    if (answer.status !== 401) return answer;
    const fresh = readServiceToken(file, read);
    if (fresh === null || fresh === token) return answer;
    token = fresh;
    return fetchImpl(input, withToken(init, fresh));
  }) as typeof fetch;
}
