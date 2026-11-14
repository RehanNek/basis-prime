// The coin list and its parameters: research/data/universe_v0.json, the file whose sha256 the factory pins as
// `params_hash` (INTERFACES.md 3). The trade page shows its coins, bands and size rules (INTERFACES.md 12).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** From services/api/dist/ (or src/) up to the repo root. */
export const UNIVERSE_FILE = fileURLToPath(new URL("../../../research/data/universe_v0.json", import.meta.url));

export interface UniverseCoin {
  /** On the allow-list (23 coins); the rest are next in line, and the gateway refuses them (P1). */
  allowed: boolean;
  tier: number;
  /** Mainnet's szDecimals when the file was made. Testnet's own meta wins for rounding there. */
  hl_sz_decimals: number;
  params: {
    /** The P2 band, as a fraction: 0.01 is 1% either side of the reference price (RISK_ENGINE.md 5.3, 9). */
    price_band: number;
    client_cap_usd: number;
    book_cap_usd: number;
  };
}

export interface Universe {
  /** Coins in the file's order (BTC, ETH, ...). */
  coins: [string, UniverseCoin][];
  /** sha256 of the file's bytes, in hex: what the factory's params_hash should be. */
  hash: string;
}

export function parseUniverse(bytes: Buffer): Universe {
  const parsed = JSON.parse(bytes.toString("utf8")) as { coins?: Record<string, UniverseCoin> };
  if (!parsed.coins || typeof parsed.coins !== "object") throw new Error("universe_v0.json has no coins");
  return { coins: Object.entries(parsed.coins), hash: createHash("sha256").update(bytes).digest("hex") };
}

/** Reads the file once; later calls share the first read. */
export function universeLoader(file = UNIVERSE_FILE): () => Promise<Universe> {
  let loaded: Promise<Universe> | undefined;
  return () => {
    loaded ??= readFile(file).then(parseUniverse);
    loaded.catch(() => (loaded = undefined));
    return loaded;
  };
}
