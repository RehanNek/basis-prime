// The backend (INTERFACES.md 7 and 11; PLAN.md 4): chain views over NEAR RPC, pb-risk previews and pb-gateway
// orders over OutLayer's HTTPS API, Hyperliquid testnet reads, and 1Click quotes and statuses (the shim on
// testnet). It holds OUTLAYER_PAYMENT_KEY and, through @pb/oneclick, ONECLICK_JWT, and never sends either to the
// browser. It signs nothing: the browser signs every transaction and every order with the wallet, and the only
// thing it posts to Hyperliquid is an action the account contract had the MPC signer sign.
//
//   pnpm --filter @pb/api start        (reads ../../.env; listens on API_URL, default http://localhost:8788)
import { OneClickClient, oneClickFromEnv } from "@pb/oneclick";

import { aaveApi } from "./aave.js";
import { ACTIVITY_CACHE_MS, FastNearTx, TxStore } from "./activity.js";
import { CHECKS_PER_MINUTE, keeperCheckOver } from "./check.js";
import { apiConfig, EVM_TEST_CHAINS, hostOf } from "./config.js";
import { CREDIT_SHARE_MS, EXAMPLE_PRICE_MS } from "./credit.js";
import { shimAdmin } from "./drill.js";
import { EvmRpc } from "./evm.js";
import { gasLimits, gasWalletOf, type GasWallet } from "./evm-handlers.js";
import { MoveBook } from "./handlers.js";
import { HlHttp, TtlCache } from "./hl.js";
import { LENDERS_CACHE_MS } from "./lenders.js";
import {
  ACTIVITY_READS_PER_MINUTE,
  CANCELS_PER_MINUTE,
  CREDIT_CHECKS_PER_CLIENT,
  CREDIT_CHECKS_PER_MINUTE,
  FAULTS_PER_MINUTE,
  GATEWAY_RUNS_PER_MINUTE,
  EVM_SUBMITS_PER_MINUTE,
  KeyedRateLimiter,
  LEVERAGE_SETS_PER_MINUTE,
  ORDERS_PER_MINUTE,
  PREVIEWS_PER_MINUTE,
  RateLimiter,
  SUBMITS_PER_MINUTE,
} from "./limiter.js";
import { OutLayerClient } from "./outlayer.js";
import { PRICING_CACHE_MS } from "./pricing.js";
import { RHEA_CACHE_MS } from "./rhea.js";
import { NearRpc } from "./rpc.js";
import { createApiServer } from "./server.js";
import { newServiceToken, removeServiceToken, Sessions, writeServiceToken } from "./session.js";
import { Shared } from "./shared.js";
import { universeLoader } from "./universe.js";

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} api: ${line}`);

const config = apiConfig(process.env);
const oneClick = oneClickFromEnv(process.env);
const outlayer = config.outlayerPaymentKey
  ? new OutLayerClient({ apiUrl: config.outlayerApiUrl, paymentKey: config.outlayerPaymentKey, waitMs: config.outlayerWaitMs })
  : undefined;
const hlMainnet = new HlHttp({ apiUrl: config.hlMainnetApiUrl });
const evm = new EvmRpc({ url: config.evmRpcUrl });
// Stage 3: testnet's gas wallet. A key that can't be read turns the gas helper off; the reason never repeats the key.
let gasWallet: GasWallet | undefined;
let gasWalletProblem: string | null = null;
if (config.evmGasPrivateKey) {
  try {
    gasWallet = gasWalletOf(config.evmGasPrivateKey);
  } catch (error) {
    gasWalletProblem = error instanceof Error ? error.message : "EVM_GAS_PRIVATE_KEY can't be read";
  }
}
// Privacy level 1 (INTERFACES.md 48). In `owner` mode the backend makes two secrets when it starts and keeps both in
// memory: the one its sign-in tokens are signed with, and a service token for our own services on this machine
// (the keeper and the gate scripts), which it also writes to a file only this user can read. Neither is ever logged.
const privacyOn = config.accountPrivacy === "owner";
const serviceToken = privacyOn ? newServiceToken() : null;
let serviceTokenProblem: string | null = null;
if (serviceToken) {
  try {
    writeServiceToken(config.serviceTokenFile, serviceToken);
  } catch (error) {
    serviceTokenProblem = error instanceof Error ? error.message : "the file couldn't be written";
  }
}
const sessions = privacyOn ? new Sessions({ serviceToken }) : undefined;
/** The file goes when the backend stops: a token that no backend knows is of no use to anyone. */
const stop = () => {
  if (serviceToken && !serviceTokenProblem) {
    try {
      removeServiceToken(config.serviceTokenFile);
    } catch {
      // nothing more to do on the way out
    }
  }
};
process.on("exit", stop);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));

/** OutLayer's attestation records are public: a plain GET on OutLayer's own host (credit.ts checks the host). */
const readAttestation = async (url: string): Promise<unknown> => {
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`OutLayer answered HTTP ${response.status}`);
  return response.json();
};

const server = createApiServer(
  {
    config,
    chain: new NearRpc({ url: config.nearRpcUrl }),
    outlayer,
    oneClick,
    previews: new RateLimiter(PREVIEWS_PER_MINUTE, 60_000),
    hl: new HlHttp({ apiUrl: config.hlApiUrl }),
    hlCache: new TtlCache(),
    limits: {
      orders: new KeyedRateLimiter(ORDERS_PER_MINUTE, 60_000),
      cancels: new KeyedRateLimiter(CANCELS_PER_MINUTE, 60_000),
      leverage: new KeyedRateLimiter(LEVERAGE_SETS_PER_MINUTE, 60_000),
      submits: new RateLimiter(SUBMITS_PER_MINUTE, 60_000),
      gatewayRuns: new RateLimiter(GATEWAY_RUNS_PER_MINUTE, 60_000),
      faults: new RateLimiter(FAULTS_PER_MINUTE, 60_000),
      creditChecks: new RateLimiter(CREDIT_CHECKS_PER_MINUTE, 60_000),
      creditPerClient: new KeyedRateLimiter(CREDIT_CHECKS_PER_CLIENT, 60_000),
      activityReads: new RateLimiter(ACTIVITY_READS_PER_MINUTE, 60_000),
      evmSubmits: new RateLimiter(EVM_SUBMITS_PER_MINUTE, 60_000),
      checks: new KeyedRateLimiter(CHECKS_PER_MINUTE, 60_000),
    },
    universe: universeLoader(),
    now: Date.now,
    // Phase 5 (INTERFACES.md 18-22): mainnet reads, the activity indexer, and what is kept between requests.
    mainnet: new NearRpc({ url: config.mainnetRpcUrl }),
    hlMainnet: { info: (body) => hlMainnet.info(body) },
    // INTERFACES.md 49.3: 1Click's own token list for the Spot screen. A public read: no key is sent.
    oneClickMainnet: new OneClickClient({ baseUrl: config.oneClickMainnetUrl, timeoutMs: 15_000 }),
    indexer: new FastNearTx({ url: config.txIndexerUrl, ...(config.fastnearApiKey ? { apiKey: config.fastnearApiKey } : {}) }),
    attestations: readAttestation,
    creditResults: new Shared(CREDIT_SHARE_MS),
    examplePrice: new Shared(EXAMPLE_PRICE_MS),
    rheaTerms: new Shared(RHEA_CACHE_MS),
    activity: new Shared(ACTIVITY_CACHE_MS),
    txStore: new TxStore(),
    // Phase 6, stage 1 (INTERFACES.md 28): the lenders' terms, read only. No Ethereum key is used here.
    aaveApi: aaveApi(),
    evm,
    // Stage 3: the same chain for balances, receipts and sends; the gas wallet and its limits; mined statuses kept.
    evmChain: evm,
    ...(gasWallet ? { gasWallet, gasLimits: gasLimits() } : {}),
    evmStatuses: new Map(),
    // Stage 4: the committed move quotes given, so a move's status can be asked by its transfer id.
    moves: new MoveBook(),
    // Privacy level 1: who is asking. None with ACCOUNT_PRIVACY=off.
    ...(sessions ? { sessions } : {}),
    // INTERFACES.md 49.4: checks the keeper asks and pays for, handed over with the service token.
    ...(serviceToken ? { keeperCheck: keeperCheckOver(config.keeperUrl, serviceToken, config.outlayerWaitMs) } : {}),
    lenderTerms: new Shared(LENDERS_CACHE_MS),
    // Stage 2: the pricing book, kept 15 s (it reads two views for each account).
    pricingBook: new Shared(PRICING_CACHE_MS),
    // Phase 4: the stand-in's fault switch, with its admin token (testnet only; apiConfig refuses anything else).
    ...(config.shimUrl && config.shimAdminToken ? { shimAdmin: shimAdmin(config.shimUrl, config.shimAdminToken) } : {}),
  },
  log,
);

server.listen(config.port, config.host, () => {
  const { ids } = config;
  log(`listening on http://${config.host}:${config.port}`);
  log(
    `NEAR via ${hostOf(config.nearRpcUrl)}; 1Click via ${hostOf(oneClick.baseUrl)}; Hyperliquid via ${hostOf(config.hlApiUrl)}; ` +
      `previews and orders ${outlayer ? `on, via ${hostOf(config.outlayerApiUrl)} (${ids.riskProject}, ${ids.gatewayProject}); a run may take ${config.outlayerWaitMs / 1000} s, its wait in OutLayer's queue included` : "off (OUTLAYER_PAYMENT_KEY is empty)"}`,
  );
  log(`factory ${ids.factory}, pool ${ids.pool}, tokens ${ids.tokens.map((t) => t.id).join(" and ")}`);
  log(
    privacyOn
      ? `privacy: a client account shows only to its owner's wallet, to ${ids.operator} and ${ids.keeper}, and to our own services; ` +
          `open to anyone: ${config.openAccounts.length ? config.openAccounts.join(", ") : "none"}; ` +
          (serviceTokenProblem ? `THE SERVICE TOKEN COULDN'T BE WRITTEN to ${config.serviceTokenFile} (${serviceTokenProblem}): the keeper and the gate scripts will be refused` : `the service token is in ${config.serviceTokenFile}, for this user only`)
      : "privacy: off (ACCOUNT_PRIVACY=off): every account shows to anyone who asks, and no sign-in is asked",
  );
  log(`drill ${ids.drill}; the stand-in's fault switch ${config.shimUrl && config.shimAdminToken ? `on, via ${hostOf(config.shimUrl)}` : "off (SHIM_URL or SHIM_ADMIN_TOKEN is empty)"}; the keeper's log ${config.keeperLogFile}`);
  log(
    `Phase 5: mainnet reads via ${hostOf(config.mainnetRpcUrl)} and ${hostOf(config.hlMainnetApiUrl)}; ` +
      `activity via ${hostOf(config.txIndexerUrl)}${config.fastnearApiKey ? " with a key" : " without a key"}; book stress results ${config.bookStressFile}`,
  );
  log(
    `Phase 6: lenders' terms from Aave's API, ${hostOf(config.mainnetRpcUrl)} and chain ${config.evmChainId} (${EVM_TEST_CHAINS[config.evmChainId]}, a test chain) via ${hostOf(config.evmRpcUrl)} (data provider ${config.aaveDataProvider}); ` +
      `our Rhea copy ${config.rheaAccountId ?? "not set (RHEA_ACCOUNT_ID is empty)"}`,
  );
  log(
    `Stage 3: signed Ethereum transactions go out through ${hostOf(config.evmRpcUrl)}; the gas helper is ` +
      (gasWallet ? `on, paying from ${gasWallet.address} (Aave's faucet ${config.aaveFaucet})` : `off (${gasWalletProblem ?? "EVM_GAS_PRIVATE_KEY is empty"})`),
  );
});
