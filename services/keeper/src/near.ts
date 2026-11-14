// The keeper's NEAR RPC client (near-api-js 7.4.0). Read-only so far: it reads each account's get_state
// (INTERFACES.md 4); signing request_check and execute_step comes with the keeper's full loop (Phase 4).
import { JsonRpcProvider } from "near-api-js";
import { AccountDoesNotExistError, ContractCodeDoesNotExistError, ContractMethodNotFoundError } from "near-api-js/rpc-errors";

export interface NearAccountState {
  exists: boolean;
  /** In yoctoNEAR. */
  balance: bigint;
  hasContract: boolean;
}

const NO_CODE = "11111111111111111111111111111111";

export class NearReader {
  readonly #provider: JsonRpcProvider;

  constructor(rpcUrl: string) {
    this.#provider = new JsonRpcProvider({ url: rpcUrl });
  }

  /** The latest final block height. */
  async blockHeight(): Promise<number> {
    return (await this.#provider.viewBlock({ finality: "final" })).header.height;
  }

  /** The latest final block: its height and its time in ms (the contracts' clock). */
  async finalBlock(): Promise<{ height: number; timeMs: number }> {
    const { header } = await this.#provider.viewBlock({ finality: "final" });
    return { height: header.height, timeMs: Number(BigInt(header.timestamp_nanosec) / 1_000_000n) };
  }

  async account(accountId: string): Promise<NearAccountState> {
    try {
      const view = await this.#provider.viewAccount({ accountId });
      return { exists: true, balance: BigInt(view.amount), hasContract: view.code_hash !== NO_CODE };
    } catch (error) {
      if (error instanceof AccountDoesNotExistError) return { exists: false, balance: 0n, hasContract: false };
      throw error;
    }
  }

  /** A contract view call, decoded from JSON. */
  view<T extends string | number | boolean | object>(contractId: string, method: string, args: Record<string, unknown> = {}) {
    return this.#provider.callFunction<T>({ contractId, method, args });
  }

  /**
   * The same, but null while the contract isn't there yet: no account, no code, or no such method. Our
   * contracts go live during Phase 2's integration, and an account the keeper watches may not exist yet.
   */
  async viewOrNull<T extends string | number | boolean | object>(contractId: string, method: string, args: Record<string, unknown> = {}) {
    try {
      return (await this.view<T>(contractId, method, args)) ?? null;
    } catch (error) {
      if (error instanceof AccountDoesNotExistError || error instanceof ContractCodeDoesNotExistError || error instanceof ContractMethodNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  /** When a block was made, in ms. */
  async blockTimeMs(height: number): Promise<number> {
    const block = await this.#provider.viewBlock({ blockId: height });
    return Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
  }
}

/** 9941900000000000000000000n -> "9.9419" */
export function formatNear(yocto: bigint): string {
  return (Number(yocto / 10n ** 20n) / 1e4).toFixed(4);
}
