// Builds the client our services use, from .env values (see .env.example).
// On testnet every 1Click call goes to our shim, because 1Click has no testnet (PLAN.md 5.4).
import { OneClickClient } from "./client.js";

export const ONECLICK_DEFAULT_URL = "https://1click.chaindefuser.com";

export type Env = Record<string, string | undefined>;

/**
 * testnet: the shim at SHIM_URL, with no key (the shim keeps its own copy for its dry quotes).
 * mainnet: ONECLICK_API_URL (or the public URL), with ONECLICK_JWT as X-API-Key.
 */
export function oneClickFromEnv(env: Env, fetchImpl?: typeof fetch): OneClickClient {
  const network = env.NEAR_NETWORK?.trim() || "testnet";
  if (network === "testnet") {
    const shimUrl = env.SHIM_URL?.trim();
    if (!shimUrl) throw new Error("NEAR_NETWORK is testnet, so 1Click calls go to the shim, but SHIM_URL is empty");
    return new OneClickClient({ baseUrl: shimUrl, fetch: fetchImpl });
  }
  if (network === "mainnet") {
    return new OneClickClient({
      baseUrl: env.ONECLICK_API_URL?.trim() || ONECLICK_DEFAULT_URL,
      apiKey: env.ONECLICK_JWT?.trim() || undefined,
      fetch: fetchImpl,
    });
  }
  throw new Error(`NEAR_NETWORK must be testnet or mainnet, not "${network}"`);
}
