// 1Click shim for testnet (PLAN.md 5.4). 1Click has no testnet, so this serves the same API:
// dry quotes are the real 1Click's prices for the mainnet twins of our test assets, and committed
// quotes are settled from the shim's own floats after the quoted time. A fault switch can force a
// refund, a failure or a late delivery, for the drill.
//
// Run: pnpm --filter @pb/oneclick-shim start   (loads ../../.env; listens on SHIM_URL's port)
import { OneClickClient } from "@pb/oneclick";
import { JsonRpcProvider } from "near-api-js";

import { shimAssets, type EvmTokens } from "./assets.js";
import { evmTokensOf, hostOf, shimConfig } from "./config.js";
import { Engine } from "./engine.js";
import { evmFloat, type EvmFloat } from "./evm-float.js";
import { hlFloat } from "./hl-float.js";
import { nearFloat } from "./near-float.js";
import { deployProbe, ftDecimals } from "./near-tokens.js";
import { createShimServer } from "./server.js";
import { Store } from "./state.js";

const log = (line: string) => console.log(`${new Date().toISOString()} shim: ${line}`);

const config = shimConfig(process.env);
// Stage 4: Base Sepolia's tokens are the factory's Aave settings', read once at start (a view; nothing is signed).
// Without them the third chain is off, and the stand-in is what it was.
let evmTokens: EvmTokens | null = null;
let evmOff = "the factory's config has no Aave settings for this chain";
try {
  const factory = await new JsonRpcProvider({ url: config.nearRpcUrl }).callFunction({ contractId: config.factoryId, method: "get_config", args: {}, blockQuery: { finality: "final" } });
  evmTokens = evmTokensOf(factory, config.evm.chainId);
} catch (error) {
  evmOff = `the factory's config couldn't be read (${error instanceof Error ? error.message : String(error)})`;
}
const assets = shimAssets(config.tokens, evmTokens ?? undefined);
let evm: EvmFloat | undefined;
if (evmTokens && config.evm.privateKey) {
  try {
    evm = evmFloat({ rpcUrl: config.evm.rpcUrl, chainId: config.evm.chainId, privateKey: config.evm.privateKey, weth: evmTokens.weth ?? "0x0000000000000000000000000000000000000000", faucet: config.evm.faucet, dataProvider: config.evm.dataProvider });
  } catch (error) {
    // The reason never repeats the key.
    evmOff = error instanceof Error ? error.message : "EVM_GAS_PRIVATE_KEY can't be read";
  }
} else if (evmTokens) {
  evmOff = "EVM_GAS_PRIVATE_KEY is empty";
}
const store = new Store(config.stateFile);
const near = config.near ? nearFloat(config.nearRpcUrl, config.near.accountId, config.near.privateKey) : undefined;
const hl = config.hl ? hlFloat(config.hlApiUrl, config.hl.address, config.hl.privateKey) : undefined;

const engine = new Engine({ store, assets, near, hl, ...(evm ? { evm } : {}), log });
engine.recover();
// Section 49: test ETH, wNEAR and USDT may not be deployed yet. Each is asked about with a view when a quote names
// it (nothing is signed); once it answers, it is never asked again.
const deployed = deployProbe((contract) => ftDecimals(config.nearRpcUrl, contract));

const server = createShimServer({
  engine,
  upstream: new OneClickClient({ baseUrl: config.oneClickUrl, apiKey: config.oneClickKey }),
  assets,
  floats: { near: Boolean(near), hl: Boolean(hl), evm: Boolean(evm) },
  ...(evm ? { evm } : {}),
  deployed,
  adminToken: config.adminToken,
  log,
});

server.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port}; prices from ${hostOf(config.oneClickUrl)}${config.oneClickKey ? " with our key" : " without a key"}`);
  log(near ? `NEAR float ${near.accountId} via ${hostOf(config.nearRpcUrl)}` : "NEAR float off (SHIM_NEAR_ACCOUNT_ID or SHIM_NEAR_PRIVATE_KEY is empty)");
  log(hl ? `Hyperliquid float ${hl.address} via ${hostOf(config.hlApiUrl)}` : "Hyperliquid float off (HL_FLOAT_ADDRESS or HL_FLOAT_PRIVATE_KEY is empty)");
  log(evm ? `Base Sepolia float ${evm.address} (the gas wallet) via ${hostOf(config.evm.rpcUrl)}; tokens ${assets.filter((a) => a.chain === "evm").map((a) => a.symbol).join(", ")}` : `Base Sepolia float off (${evmOff})`);
  log(config.adminToken ? `fault switch on, now: ${engine.fault.mode}` : "fault switch off (SHIM_ADMIN_TOKEN is empty)");
  log(`state in ${config.stateFile}`);
  // Which of section 49's tokens are there now: three views, after the server is up, so a slow RPC holds nothing back.
  for (const asset of assets.filter((a) => a.checkDeployed)) {
    deployed(asset).then(
      (why) => log(why === null ? `test ${asset.symbol} is deployed at ${asset.contract}: it swaps` : `${why} (asked again when a quote names it)`),
      (error: unknown) => log(`couldn't ask whether ${asset.contract} is deployed (${error instanceof Error ? error.message : String(error)}); asked again when a quote names it`),
    );
  }
});

const timer = setInterval(() => void engine.tick(), config.pollMs);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    server.close();
    log("stopped");
  });
}
