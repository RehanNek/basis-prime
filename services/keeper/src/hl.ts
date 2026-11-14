// The keeper's Hyperliquid testnet info client (@nktkas/hyperliquid 0.33.3). Polling for now;
// PLAN.md 5.7 adds a WebSocket per 10 accounts later, with this as the fallback.
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";

export interface HlAccountState {
  accountValue: string;
  marginUsed: string;
  withdrawable: string;
  positions: number;
}

export class HlReader {
  readonly #info: InfoClient;

  constructor(apiUrl: string) {
    this.#info = new InfoClient({ transport: new HttpTransport({ isTestnet: true, apiUrl }) });
  }

  /** Mark prices by coin name. Asset numbers differ between testnet and mainnet, so never index by number. */
  async marks(): Promise<Map<string, number>> {
    return (await this.prices()).marks;
  }

  /**
   * Mark and oracle prices by coin name, from one read. The oracle price is what the engine counts a coin at (pb-read
   * reads `oraclePx`); Phase 6 keeps our Rhea copy's BTC price in step with it (rhea-price.ts).
   */
  async prices(): Promise<{ marks: Map<string, number>; oracles: Map<string, number> }> {
    const [meta, contexts] = await this.#info.metaAndAssetCtxs();
    const marks = new Map<string, number>();
    const oracles = new Map<string, number>();
    meta.universe.forEach((asset, i) => {
      const mark = contexts[i]?.markPx;
      if (mark) marks.set(asset.name, Number(mark));
      const oracle = contexts[i]?.oraclePx;
      if (oracle) oracles.set(asset.name, Number(oracle));
    });
    return { marks, oracles };
  }

  /** The coins an address holds a position in. */
  async perps(address: `0x${string}`): Promise<string[]> {
    const state = await this.#info.clearinghouseState({ user: address });
    return state.assetPositions.filter((p) => Number(p.position.szi) !== 0).map((p) => p.position.coin);
  }

  /** A Hyperliquid account's cross-margin summary. */
  async account(address: `0x${string}`): Promise<HlAccountState> {
    const state = await this.#info.clearinghouseState({ user: address });
    return {
      accountValue: state.marginSummary.accountValue,
      marginUsed: state.marginSummary.totalMarginUsed,
      withdrawable: state.withdrawable,
      positions: state.assetPositions.length,
    };
  }
}
