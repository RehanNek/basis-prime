// Moves the Hyperliquid testnet float's spot USDC into its perps balance.
//
//   pnpm --filter @pb/oneclick-shim float:to-perps
//
// Test USDC sent to the float with the Hyperliquid app's Send button lands in its spot balance. The shim delivers
// with usdSend, which spends perps USDC, and the demo's float posts perp orders, so top-ups have to be moved across.
// Testnet only: it refuses to run unless HL_API_URL is Hyperliquid's testnet API. The key stays in this process.
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";

import { shimConfig } from "./config.js";
import { localWallet } from "./hl-wallet.js";
import { fail, log } from "./live-kit.js";

const config = shimConfig(process.env);
if (!config.hl) fail("HL_FLOAT_ADDRESS or HL_FLOAT_PRIVATE_KEY is empty in .env", 2);
if (!config.hlApiUrl.includes("testnet")) fail(`refusing: ${config.hlApiUrl} is not Hyperliquid testnet`, 2);

const wallet = localWallet(config.hl.privateKey);
if (wallet.address !== config.hl.address.toLowerCase()) fail("HL_FLOAT_PRIVATE_KEY does not belong to HL_FLOAT_ADDRESS");

const transport = new HttpTransport({ isTestnet: true, apiUrl: config.hlApiUrl });
const info = new InfoClient({ transport });
const exchange = new ExchangeClient({ transport, wallet, signatureChainId: "0x66eee" });
const user = config.hl.address.toLowerCase() as `0x${string}`;

const balances = async () => {
  const spot = await info.spotClearinghouseState({ user });
  const usdc = spot.balances.find((b) => b.coin === "USDC");
  const free = usdc ? Number(usdc.total) - Number(usdc.hold) : 0;
  const perps = Number((await info.clearinghouseState({ user })).marginSummary.accountValue);
  return { free, perps };
};

const before = await balances();
log(`float ${user}: spot USDC free ${before.free}, perps ${before.perps}`);
// usdClassTransfer takes a decimal string; round down to cents so we never ask for more than is there.
const amount = Math.floor(before.free * 100) / 100;
if (amount < 0.01) {
  log("nothing to move");
} else {
  await exchange.usdClassTransfer({ amount: amount.toFixed(2), toPerp: true });
  const after = await balances();
  log(`moved ${amount.toFixed(2)} USDC to perps: spot USDC free ${after.free}, perps ${after.perps}`);
}
