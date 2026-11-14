// What the live tests share: settings from .env, the keeper as the paying client, read helpers,
// and a shim started inside the test process on a free local port.
import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { Account, actions, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";

import { OneClickClient, type QuoteResponse } from "@pb/oneclick";

import { formatUnits, shimAssets } from "./assets.js";
import { shimConfig, type ShimConfig } from "./config.js";
import { Engine } from "./engine.js";
import { hlFloat } from "./hl-float.js";
import { nearFloat } from "./near-float.js";
import { createShimServer } from "./server.js";
import { Store, type FaultMode } from "./state.js";

export const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const nearText = (yocto: bigint) => Number(formatUnits(yocto, 24)).toFixed(5);

export function fail(message: string, code = 1): never {
  console.error(`live test: ${message}`);
  process.exit(code);
}

export const stamp = new Date().toISOString().replace(/[:.]/g, "-");
export const stateDir = fileURLToPath(new URL("../state/", import.meta.url));

/** Settings for a live run: the shim on a free port, with its own state file. */
export function liveSetup(name: string) {
  const config = shimConfig(process.env, { port: 0, stateFile: `${stateDir}${name}-${stamp}.json`, pollMs: 2_000 });
  const keeperId = process.env.KEEPER_ACCOUNT_ID?.trim() || "pbf-keeper.testnet";
  const keeperKey = process.env.KEEPER_PRIVATE_KEY?.trim();
  if (!config.near) fail("SHIM_NEAR_ACCOUNT_ID or SHIM_NEAR_PRIVATE_KEY is empty: run bash scripts/shim-setup.sh first");
  if (!keeperKey) fail("KEEPER_PRIVATE_KEY is empty");
  if (!config.adminToken) fail("SHIM_ADMIN_TOKEN is empty: the fault switch needs it");

  const provider = new JsonRpcProvider({ url: config.nearRpcUrl });
  const keeper = new Account(keeperId, provider, keeperKey as KeyPairString);
  const view = <T extends string | object>(contractId: string, method: string, args: object) =>
    provider.callFunction<T>({ contractId, method, args: { ...args } });

  const reads = {
    view,
    balance: async (token: string, who: string) => BigInt((await view<string>(token, "ft_balance_of", { account_id: who })) ?? "0"),
    storageMin: async (token: string) => BigInt((await view<{ min: string }>(token, "storage_balance_bounds", {}))!.min),
    nearBalance: async (who: string) => BigInt((await provider.viewAccount({ accountId: who })).amount),
  };
  return { config, keeperId, keeper, reads, near: config.near };
}

/** Views read final blocks, a moment behind the transactions: ask again for a few seconds. */
export async function eventually(read: () => Promise<bigint>, expected: bigint): Promise<bigint> {
  let value = await read();
  for (let i = 0; i < 10 && value !== expected; i++) {
    await sleep(1_500);
    value = await read();
  }
  return value;
}

/** Fails early if a token contract isn't deployed. */
export async function requireTokens(reads: ReturnType<typeof liveSetup>["reads"], tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      await reads.view(token, "ft_metadata", {});
    } catch {
      fail(`${token} isn't deployed yet, so the live test waits on W1`);
    }
  }
}

/** Starts a shim in this process, with the real floats, on a free local port. */
export async function startShim(config: ShimConfig) {
  mkdirSync(stateDir, { recursive: true });
  // The live tests move mUSDC and mNBTC only, as before section 49: its three tokens aren't in this shim's list.
  const assets = shimAssets({ musdc: config.tokens.musdc, mnbtc: config.tokens.mnbtc });
  const near = config.near ? nearFloat(config.nearRpcUrl, config.near.accountId, config.near.privateKey) : undefined;
  const hl = config.hl ? hlFloat(config.hlApiUrl, config.hl.address, config.hl.privateKey) : undefined;
  const engine = new Engine({ store: new Store(config.stateFile), assets, near, hl, log: (line) => log(`  shim: ${line}`) });
  const server = createShimServer({
    engine,
    upstream: new OneClickClient({ baseUrl: config.oneClickUrl, apiKey: config.oneClickKey }),
    assets,
    floats: { near: Boolean(near), hl: Boolean(hl) },
    adminToken: config.adminToken,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ticker = setInterval(() => void engine.tick(), config.pollMs);
  log(`shim on ${url}`);

  return {
    client: new OneClickClient({ baseUrl: url }),
    async setFault(mode: FaultMode, delaySeconds = 30) {
      const response = await fetch(`${url}/admin/fault`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.adminToken}` },
        body: JSON.stringify({ mode, delaySeconds }),
      });
      if (!response.ok) throw new Error(`the fault switch answered HTTP ${response.status}`);
    },
    stop() {
      clearInterval(ticker);
      server.close();
    },
  };
}

/**
 * The client's side of a NEAR deposit: pay the deposit address's storage on the token (1Click's deposit
 * addresses have none: research/day1.md 6) and send it amountIn, in one transaction; then report it.
 */
export async function depositOnNear(
  setup: ReturnType<typeof liveSetup>,
  client: OneClickClient,
  token: string,
  quote: QuoteResponse,
): Promise<string> {
  const depositAddress = quote.quote.depositAddress!;
  const result = await setup.keeper.signAndSendTransaction({
    receiverId: token,
    actions: [
      actions.functionCall("storage_deposit", { account_id: depositAddress, registration_only: true }, teraToGas("10"), await setup.reads.storageMin(token)),
      actions.functionCall("ft_transfer", { receiver_id: depositAddress, amount: quote.quote.amountIn, memo: "pb shim live test" }, teraToGas("15"), 1n),
    ],
  });
  const txHash = result.transaction.hash;
  log(`deposit tx ${txHash}`);
  await client.submitDeposit({ txHash, depositAddress, nearSenderAccount: setup.keeperId });
  return txHash;
}

/** Mints `amount` of a test token to the keeper with the public faucet if it holds less than `atLeast`. */
export async function ensureKeeperHolds(setup: ReturnType<typeof liveSetup>, token: string, atLeast: bigint, amount: bigint): Promise<void> {
  if ((await setup.reads.balance(token, setup.keeperId)) >= atLeast) return;
  const registered = (await setup.reads.view(token, "storage_balance_of", { account_id: setup.keeperId })) !== null;
  log(`minting ${amount} units of ${token} to ${setup.keeperId} with the public faucet${registered ? "" : " (and registering it)"}`);
  await setup.keeper.callFunction({
    contractId: token,
    methodName: "mint",
    args: { account_id: setup.keeperId, amount: amount.toString() },
    deposit: registered ? 0n : await setup.reads.storageMin(token),
    gas: teraToGas("30"),
  });
}
