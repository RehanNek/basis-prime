// INTERFACES.md 49: is a NEAR test token deployed yet?
//
// Test ETH, wNEAR and USDT are deployed after this code is (research/spot_tokens_deploy.md). The stand-in knows their
// ids from its settings, and asks the chain before it quotes one: a view of the token's `ft_metadata`, nothing
// signed. No contract there, or other decimals than the stand-in counts in, and the quote is refused in words. Once a
// token has answered right it is never asked again; one that hasn't is asked again after a few seconds, so the
// stand-in needs no restart when the tokens are deployed.
import type { ShimAsset } from "./assets.js";

/** How long a "not there yet" is believed before the chain is asked again. */
export const RECHECK_MS = 15_000;

/** Why a quote can't name this asset yet, in words for whoever asked; null when it can. */
export type DeployProbe = (asset: ShimAsset) => Promise<string | null>;

/**
 * The decimals a NEAR token's `ft_metadata` gives, or null when there is no token contract at that id: no such
 * account, an account with no code, or code with no `ft_metadata`. Anything else (the RPC can't be reached, an answer
 * that doesn't read) throws: "couldn't ask" is never taken for "not there".
 *
 * The three "not there" answers are NEAR's JSON-RPC's own, read on testnet on 13 Nov:
 *   - no such account: `error.cause.name` is `UNKNOWN_ACCOUNT`;
 *   - no code: `result.error` says `CodeDoesNotExist`;
 *   - no such method: `result.error` says `MethodNotFound`.
 */
export async function ftDecimals(rpcUrl: string, contract: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "query",
    params: { request_type: "call_function", finality: "final", account_id: contract, method_name: "ft_metadata", args_base64: "e30=" },
  };
  const response = await fetchImpl(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`the NEAR RPC answered HTTP ${response.status}`);
  const answer = (await response.json()) as { error?: { cause?: { name?: unknown }; data?: unknown; message?: unknown }; result?: { result?: unknown; error?: unknown } };
  if (answer.error) {
    if (answer.error.cause?.name === "UNKNOWN_ACCOUNT") return null;
    throw new Error(`the NEAR RPC refused the view: ${String(answer.error.data ?? answer.error.message ?? answer.error.cause?.name ?? "no reason given")}`);
  }
  const failed = answer.result?.error;
  if (typeof failed === "string") {
    if (/CodeDoesNotExist|MethodNotFound/.test(failed)) return null;
    throw new Error(`${contract}'s ft_metadata failed: ${failed}`);
  }
  const bytes = answer.result?.result;
  if (!Array.isArray(bytes)) throw new Error(`the NEAR RPC's answer for ${contract}'s ft_metadata has no result`);
  let decimals: unknown;
  try {
    decimals = (JSON.parse(Buffer.from(bytes as number[]).toString("utf8")) as { decimals?: unknown } | null)?.decimals;
  } catch {
    decimals = undefined;
  }
  if (typeof decimals !== "number" || !Number.isInteger(decimals)) throw new Error(`${contract}'s ft_metadata gives no decimals`);
  return decimals;
}

/**
 * The probe the server asks before it quotes one of section 49's tokens. `read` is `ftDecimals` for a contract.
 * A token that answered with the right decimals is live for good; any other answer is asked again after
 * `recheckMs`. A read that throws is passed on, and nothing is remembered.
 */
export function deployProbe(read: (contract: string) => Promise<number | null>, now: () => number = Date.now, recheckMs = RECHECK_MS): DeployProbe {
  const live = new Set<string>();
  const notYet = new Map<string, { why: string; at: number }>();
  return async (asset) => {
    if (asset.chain !== "near" || !asset.checkDeployed || live.has(asset.contract)) return null;
    const last = notYet.get(asset.contract);
    if (last && now() - last.at < recheckMs) return last.why;
    const decimals = await read(asset.contract);
    if (decimals === asset.decimals) {
      live.add(asset.contract);
      notYet.delete(asset.contract);
      return null;
    }
    const why =
      decimals === null
        ? `Test ${asset.symbol} isn't on testnet yet: no token contract is deployed at ${asset.contract}. Until it is, the stand-in swaps mUSDC and mNBTC only`
        : `The token at ${asset.contract} counts in ${decimals} decimals, and the stand-in's test ${asset.symbol} counts in ${asset.decimals}: it won't quote it`;
    notYet.set(asset.contract, { why, at: now() });
    return why;
  };
}
