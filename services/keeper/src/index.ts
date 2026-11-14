// The keeper (PLAN.md 5.7; INTERFACES.md 17): a long-running process that watches every client account with a loan,
// asks for checks when prices cross the last verdict's bands, during margin calls and once an hour, confirms a
// DELEVERAGE with a second check about 2.5 minutes after the first, runs stored plans (the gateway's `deleverage`
// mode, and execute_step), cancels risky resting orders when an account leaves HEALTHY, and logs every action as a
// JSON line. It uses public methods only; the gateway's keeper modes answer our keeper alone.
//
//   pnpm --filter @pb/keeper start [-- --once] [--account <id> ...] [--dry-run]
//
// It signs with the keeper's key (KEEPER_PRIVATE_KEY) and runs pb-gateway with our OutLayer payment key
// (OUTLAYER_PAYMENT_KEY). Both come from the repo's .env and are never logged. The log goes to stdout and to
// KEEPER_LOG_FILE (default services/keeper/logs/keeper.jsonl); the status page is http://127.0.0.1:8789/.
//
// Phase 5: once a day, and at start when the last result is more than a day old, it runs the book stress test
// (book-stress.ts; INTERFACES.md 19) and appends the result to BOOK_STRESS_LOG_FILE. On testnet it compares each
// account's bands with that account's own drill ratio (get_ratio_for, INTERFACES.md 21) when the drill has one.
//
// Phase 6, stage 2 (FUNDING.md 7.1): it runs a funding plan's steps as soon as `fund` stores one, asking for the fresh
// check each borrowing step needs; runs a top-up plan's lender steps; asks for a check when bitcoin's move brings a
// lender's cushion near 1.35; and once an hour, right after the hourly check, calls the account's `settle()` where a
// lender is owed or the account's policy at our pool isn't pass-through. With RHEA_ACCOUNT_ID set it also keeps our
// Rhea copy's BTC price within 0.25% of Hyperliquid's oracle price, signing as the copy's owner, the operator
// (OPERATOR_PRIVATE_KEY; rhea-price.ts).
//
// Stage 3 (INTERFACES.md 33): Aave, on Base Sepolia. The keeper approves a token for Aave's Pool before the first
// supply or repayment of it (evm_approve), sends each transaction the account signs (through the backend's POST
// /api/evm/submit, and by itself as a backup), waits until the chain has used its nonce, asks for a fresh check, and
// only then runs the next step. One that stays unmined is signed again with a higher tip (evm_bump). It holds no
// Ethereum key: it reads EVM_RPC_URL and sends what the accounts signed.
import { oneClickFromEnv, type OneClickClient } from "@pb/oneclick";
import { JsonRpcProvider } from "near-api-js";

import { AccountLister, isClientAccount, newestOf } from "./accounts.js";
import { BookStressJob, stressHistory } from "./book-stress.js";
import { hostOf, keeperConfig } from "./config.js";
import { aaveSettings, backendSubmit, EvmHttp, EvmSender, readEvm } from "./evm.js";
import { hlExchange, SignedPoster } from "./hl-post.js";
import { HlReader } from "./hl.js";
import { isMissingMethod } from "./drill-kit.js";
import { JsonLog, readTail } from "./jsonl.js";
import { clientCheck, oneAtATime, tick, type AccountMemory, type CheckResult, type GatewayMode, type GatewayResult, type KeeperDeps, type SettleResult, type StepResult } from "./loop.js";
import { CHECK_DEPOSIT, nearCaller, stepStalled, TGAS_ACCOUNT, type NearCall } from "./near-tx.js";
import { formatNear, NearReader } from "./near.js";
import { attestationByTx, OutLayerRunner, readGatewayAnswer } from "./outlayer.js";
import { readHold, RheaPrices, type RheaCall } from "./rhea-price.js";
import { backendFetch, readServiceToken } from "./service-token.js";
import { isPriced, minPeriodMs, StateReader } from "./state.js";
import { accountStatus, statusServer } from "./status.js";

const config = keeperConfig(process.env, process.argv.slice(2));
const { log } = new JsonLog({ file: config.logFile });
const near = new NearReader(config.nearRpcUrl);
const hl = new HlReader(config.hlApiUrl);
const states = new StateReader(near);
const lister = new AccountLister(near, config.factoryId);
const poster = new SignedPoster(hlExchange(config.hlApiUrl));
// Stage 3: Aave's chain, and the sender of the accounts' signed transactions (the backend first, then the keeper itself).
const evmNode = new EvmHttp({ url: config.evmRpcUrl, chainId: config.evmChainId });
// Privacy level 1 (INTERFACES.md 48.7): the keeper's one call to the backend carries its service token, when the file is there.
const evmSender = new EvmSender(evmNode, backendSubmit(config.apiUrl, backendFetch(config.serviceTokenFile)));
/** An allowance this large is an approval for good: evm_approve approves the largest number there is. */
const APPROVED_FROM = 1n << 200n;

let oneClick: OneClickClient | undefined;
try {
  oneClick = oneClickFromEnv(process.env);
} catch (error) {
  log("start", `1Click is off, so transfers aren't polled: ${error instanceof Error ? error.message : String(error)}`);
}

// The keys are read here once and handed to the clients; nothing logs them.
const keeperKey = process.env.KEEPER_PRIVATE_KEY?.trim() || undefined;
const paymentKey = process.env.OUTLAYER_PAYMENT_KEY?.trim() || undefined;
const provider = new JsonRpcProvider({ url: config.nearRpcUrl });
const call = keeperKey && !config.dryRun ? nearCaller(provider, config.keeperId, keeperKey) : null;
const outlayer = paymentKey && !config.dryRun ? new OutLayerRunner({ apiUrl: config.outlayerApiUrl, paymentKey, waitMs: config.outlayerWaitMs }) : null;

// Phase 6: our Rhea copy's BTC price (rhea-price.ts). Only the copy's owner can set it, which is the operator: the
// operator's key is loaded for this one job, and signs nothing but that call. Should the copy be handed to the
// keeper's own account, the keeper's key signs it instead; the job reads who the owner is.
const operatorKey = config.rheaId ? process.env.OPERATOR_PRIVATE_KEY?.trim() || undefined : undefined;
const operatorCall = operatorKey && !config.dryRun ? nearCaller(provider, config.operatorId, operatorKey) : null;
const priceSender = (signer: NearCall | null) => (signer ? (c: RheaCall) => signer(c.contract, c.method, c.args, { tgas: c.tgas, deposit: c.deposit, label: `${c.method} ${String(c.args.token_id)}` }) : null);
/** Hyperliquid's oracle prices as the tick's market read just saw them, for the price job. */
let oraclesNow: Map<string, number> | undefined;
// INTERFACES.md 51.1: every token of the factory's Rhea collateral list, bitcoin against BTC's oracle and test ETH
// against ETH's. Bitcoin alone while the factory's list can't be read.
const rheaPrice = config.rheaId
  ? new RheaPrices({
      rheaId: config.rheaId,
      bitcoinId: config.nbtcId,
      factoryConfig: () => near.viewOrNull<object>(config.factoryId, "get_config"),
      oracle: async (coin) => oraclesNow?.get(coin) ?? (await hl.prices()).oracles.get(coin) ?? Number.NaN,
      // Null while the copy isn't there, or has no setting for the token: the job says so and leaves it.
      info: (tokenId) => near.viewOrNull<object>(config.rheaId!, "get_token_pyth_info", { token_id: tokenId }),
      owner: async () => {
        const conf = await near.viewOrNull<{ owner_id?: unknown }>(config.rheaId!, "get_config");
        return typeof conf?.owner_id === "string" ? conf.owner_id : null;
      },
      signers: [
        { id: config.operatorId, keyName: "OPERATOR_PRIVATE_KEY", send: priceSender(operatorCall) },
        ...(config.keeperId !== config.operatorId ? [{ id: config.keeperId, keyName: "KEEPER_PRIVATE_KEY", send: priceSender(call) }] : []),
      ],
      hold: () => readHold(config.rheaHoldFile, Date.now()),
      log,
      now: Date.now,
      dryRun: config.dryRun,
    })
  : null;

/** At most this many gateway runs a minute in all, to cap what the payment key can be made to spend. */
const GATEWAY_RUNS_PER_MINUTE = 30;
const gatewayRuns: number[] = [];

/** Each account's pinned pb-gateway (get_config().gateway), read once every 10 minutes. */
const pins = new Map<string, { at: number; pin: { project: string; versionKey: string | undefined } | null }>();
async function gatewayPin(account: string) {
  const cached = pins.get(account);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.pin;
  const conf = await near.viewOrNull<{ gateway?: { project_id?: unknown; version_key?: unknown } }>(account, "get_config");
  const g = conf?.gateway;
  const pin = g && typeof g.project_id === "string" ? { project: g.project_id, versionKey: typeof g.version_key === "string" && g.version_key ? g.version_key : undefined } : null;
  pins.set(account, { at: Date.now(), pin });
  return pin;
}

/**
 * The account's own drill ratio (INTERFACES.md 21). While the drill's code has no get_ratio_for, the answer is null for
 * 10 minutes at a time, and the shared ratio stands, as pb-risk falls back to it.
 */
let perAccountRatios: { known: boolean; at: number } | null = null;
async function readRatioFor(account: string): Promise<number | null> {
  if (perAccountRatios && !perAccountRatios.known && Date.now() - perAccountRatios.at < 10 * 60_000) return null;
  try {
    const ratio = await near.view<{ bp?: unknown }>(config.drillId, "get_ratio_for", { account_id: account });
    perAccountRatios = { known: true, at: Date.now() };
    return typeof ratio?.bp === "number" ? ratio.bp : null;
  } catch (error) {
    if (!isMissingMethod(error)) throw error;
    perAccountRatios = { known: false, at: Date.now() };
    return null;
  }
}

/** The pool the accounts borrow from, and its `min_period_ns` in ms as last read (INTERFACES.md 45.3, item 10). */
const poolId = config.poolId ?? `pool.${config.factoryId}`;
let minPeriod: { at: number; ms: number | null } | null = null;

function gatewayOff(reason: string): GatewayResult {
  return { ok: false, retry: false, replan: false, code: "OFF", reason, output: null, callId: null, attestationUrl: null, seconds: 0 };
}


/**
 * The account's `request_check(intent)` with 0.01 NEAR of the keeper's own. `intent` is the client's when its page
 * asked for the check through POST /check (INTERFACES.md 49.4); the keeper's own checks are a plain `{"check": {}}`.
 */
async function sendCheck(account: string, intent: unknown = { check: {} }): Promise<CheckResult> {
  if (config.dryRun) return { ok: true, hash: null, accepted: null, reason: "dry run: nothing sent", attestationUrl: null, seconds: 0 };
  if (!call) return { ok: false, hash: null, attestationUrl: null, seconds: 0, failure: "KEEPER_PRIVATE_KEY is empty in .env" };
  const tx = await call(account, "request_check", { intent }, { tgas: TGAS_ACCOUNT, deposit: CHECK_DEPOSIT, label: "request_check" });
  const answer = tx.result as { accepted?: unknown; reason?: unknown } | null | undefined;
  return {
    ok: tx.ok,
    hash: tx.hash,
    accepted: typeof answer?.accepted === "boolean" ? answer.accepted : null,
    reason: typeof answer?.reason === "string" ? answer.reason : null,
    attestationUrl: tx.hash ? attestationByTx(config.outlayerApiUrl, tx.hash) : null,
    seconds: tx.seconds,
    ...(tx.failure ? { failure: tx.failure } : {}),
  };
}

const deps: KeeperDeps = {
  async readMarket() {
    const readAt = Date.now();
    const [block, { marks, oracles }, ratio, keeper] = await Promise.all([
      near.finalBlock(),
      hl.prices(),
      near.viewOrNull<{ bp: number; set_at: string }>(config.drillId, "get_ratio"),
      near.account(config.keeperId),
    ]);
    // Phase 6: our Rhea copy's BTC price, kept in step with the oracle price just read. What the copy counts a
    // bitcoin at goes into the prices, so a fall there (the gate's price drop) is seen like a fall anywhere else.
    oraclesNow = oracles;
    const btcOracle = oracles.get("BTC");
    const kept = rheaPrice ? await rheaPrice.tick() : [];
    const rhea = kept.find((k) => k.token.coin === "BTC")?.tick ?? null;
    // Ether's price at the copy, once the factory lists test ETH for Rhea: under `rhea:ETH`, beside bitcoin's (cushion.ts).
    const rheaEth = kept.find((k) => k.token.coin === "ETH")?.tick ?? null;
    const lenderPrices = { ...(rhea?.copy ? { rhea: rhea.copy } : {}), ...(rheaEth?.copy ? { "rhea:ETH": rheaEth.copy } : {}) };
    return {
      // On testnet the nBTC/BTC ratio is the drill's, which pb-risk reads as it is (INTERFACES.md 15).
      prices: { marks: Object.fromEntries(marks), pi: ratio ? { nBTC: ratio.bp } : ({} as Record<string, number>), ...(Object.keys(lenderPrices).length ? { lenders: lenderPrices } : {}) },
      chainNowMs: block.timeMs,
      chainBlock: block.height,
      readAt,
      summary: {
        block: block.height,
        btc_mark: marks.get("BTC") ?? null,
        nbtc_ratio_bp: ratio?.bp ?? null,
        keeper_near: formatNear(keeper.balance),
        // The copy's price, the oracle's, and the hold in force if there is one: the backend's GET /api/keeper/:account
        // and the gate script read them from here.
        ...(rheaPrice ? { btc_oracle: btcOracle ?? null, rhea_btc: rhea?.copy ?? null, rhea_hold: rhea?.hold ?? null } : {}),
        // The same for ether, once the copy's price of test ETH is kept (INTERFACES.md 51.1).
        ...(rheaEth ? { eth_oracle: oracles.get("ETH") ?? null, rhea_eth: rheaEth.copy ?? null, rhea_eth_hold: rheaEth.hold ?? null } : {}),
      },
    };
  },
  listAccounts: async () => newestOf(await lister.list(), config.newest),
  readState: (account) => states.state(account),
  blockTimeMs: (height) => states.blockTimeMs(height),
  readPerps: (address) => hl.perps(address),
  readRatioFor,
  // INTERFACES.md 49.4: one check at a time for an account. A second one (the loop's own while a client's is out,
  // or the other way round) waits here until the first is over, so the two never sit in OutLayer's queue together.
  // The loop's checks and the client's page's (POST /check) go out by this one door, one at a time for an account.
  requestCheck: oneAtATime((account: string, intent?: unknown) => sendCheck(account, intent)),
  async runGateway(account, mode: GatewayMode): Promise<GatewayResult> {
    if (config.dryRun) return { ok: true, retry: false, replan: false, code: null, reason: "dry run: nothing sent", output: null, callId: null, attestationUrl: null, seconds: 0 };
    if (!outlayer) return gatewayOff("OUTLAYER_PAYMENT_KEY is empty in .env, so the gateway can't run");
    const pin = await gatewayPin(account);
    if (!pin) return gatewayOff(`${account} pins no pb-gateway: it was made before Phase 3`);
    if (pin.project !== config.gatewayProject) return gatewayOff(`${account} pins ${pin.project}, not ${config.gatewayProject}`);
    const now = Date.now();
    while (gatewayRuns.length && now - gatewayRuns[0]! > 60_000) gatewayRuns.shift();
    if (gatewayRuns.length >= GATEWAY_RUNS_PER_MINUTE) return { ...gatewayOff("too many gateway runs this minute"), retry: true, code: "LIMIT" };
    gatewayRuns.push(now);
    const started = Date.now();
    try {
      const run = await outlayer.run(pin.project, { mode, account, network: "testnet" }, pin.versionKey);
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      if (run.status !== "completed") return { ok: false, retry: true, replan: false, code: "OUTLAYER", reason: `pb-gateway did not complete: ${run.error ?? run.status}`, output: run.output, callId: run.callId, attestationUrl: run.attestationUrl, seconds };
      const verdict = readGatewayAnswer(run.output);
      return { ...verdict, output: run.output, callId: run.callId, attestationUrl: run.attestationUrl, seconds };
    } catch (error) {
      // 408 and 500 may still have run: the gateway's step records stop a repeat from placing anything twice.
      return { ok: false, retry: true, replan: false, code: "OUTLAYER", reason: error instanceof Error ? error.message : String(error), output: null, callId: null, attestationUrl: null, seconds: Math.round((Date.now() - started) / 100) / 10 };
    }
  },
  async executeStep(account, pid, i, step): Promise<StepResult> {
    if (config.dryRun) return { ok: true, hash: null, logs: [], seconds: 0, retry: false };
    if (!call) return { ok: false, hash: null, failure: "KEEPER_PRIVATE_KEY is empty in .env", logs: [], seconds: 0, retry: false };
    const tx = await call(account, "execute_step", { pid, i }, { tgas: TGAS_ACCOUNT, deposit: 0n, label: `execute_step ${pid}:${i}` });
    // A step whose transaction went through can still have moved nothing: the pool lent nothing, Rhea refused, the
    // account held no USDC. The step reopens and may run again (near-tx.ts says how that shows).
    const stalled = stepStalled(step.k, tx);
    if (stalled) return { ok: false, hash: tx.hash, failure: stalled, logs: tx.logs, seconds: tx.seconds, retry: true };
    // A transfer to a NEAR deposit address: tell 1Click, as PLAN.md 5.7 says, so it picks the deposit up sooner.
    if (tx.ok && tx.hash && oneClick && step.dep && !step.dep.startsWith("0x") && (step.k === "sell" || step.k === "to_hl")) {
      await oneClick.submitDeposit({ txHash: tx.hash, depositAddress: step.dep }).catch(() => undefined);
    }
    return { ok: tx.ok, hash: tx.hash, ...(tx.failure ? { failure: tx.failure } : {}), logs: tx.logs, seconds: tx.seconds, retry: tx.hash === null };
  },
  // Phase 6 (INTERFACES.md 25): settle() takes no deposit. Anyone may call it; the account passes its fresh verdict's
  // lender report to the pool, and the transaction's answer is the pool's.
  async settle(account): Promise<SettleResult> {
    if (config.dryRun) return { ok: true, hash: null, result: { skipped: "dry run: nothing sent" }, logs: [], seconds: 0, retry: false };
    if (!call) return { ok: false, hash: null, failure: "KEEPER_PRIVATE_KEY is empty in .env", logs: [], seconds: 0, retry: false };
    const tx = await call(account, "settle", {}, { tgas: TGAS_ACCOUNT, deposit: 0n, label: "settle" });
    return { ok: tx.ok, hash: tx.hash, result: tx.result, ...(tx.failure ? { failure: tx.failure } : {}), logs: tx.logs, seconds: tx.seconds, retry: tx.hash === null };
  },
  // INTERFACES.md 40.4, item 10: the lender report the pool's last settlement stored for the account (a view, no
  // transaction). Null when the pool has no record of the account, or isn't there.
  // INTERFACES.md 45.3, item 9: `priced` says whether the policy that applies isn't pass-through.
  async readPricing(account) {
    const record = await near.viewOrNull<{ last?: unknown }>(poolId, "get_pricing", { account_id: account });
    if (!record) return null;
    const lines = Array.isArray(record.last) ? (record.last as ({ lender?: unknown; debt?: unknown } | null)[]) : [];
    return { last: lines.flatMap((line) => (typeof line?.lender === "string" && typeof line.debt === "string" ? [{ lender: line.lender, debt: line.debt }] : [])), priced: isPriced(record) };
  },
  // INTERFACES.md 45.3, item 10: the least time the pool keeps between two settlements, from its get_params (a view).
  // It is asked for only when the pool has skipped a settlement as too soon, and kept 10 minutes.
  async readMinPeriodMs() {
    if (minPeriod && Date.now() - minPeriod.at < 10 * 60_000) return minPeriod.ms;
    const ms = minPeriodMs(await near.viewOrNull<object>(poolId, "get_params"));
    minPeriod = { at: Date.now(), ms };
    return ms;
  },
  ...(oneClick && {
    transferStatus: async (dep: string) => {
      const status = await oneClick!.status(dep).catch(() => null);
      return status?.status ?? null;
    },
  }),
  ...(!config.dryRun && { postSigned: async (account, state) => poster.postNew(account, state.hl?.signed ?? []) }),
  // Stage 3: Aave's chain. An account whose Aave settings name another chain than the keeper's is left alone.
  async readAave(account) {
    const aave = aaveSettings(await near.viewOrNull<object>(account, "get_config"));
    if (aave && aave.chainId !== config.evmChainId) {
      log("error", `the account's Aave settings name chain ${aave.chainId}, and the keeper is set to chain ${config.evmChainId}: its Aave steps are left alone`, { account });
      return null;
    }
    return aave;
  },
  readEvmNonce: (address) => evmNode.chainNonce(address),
  readApproved: async (token, address, pool) => (await evmNode.allowance(token, address, pool)) >= APPROVED_FROM,
  // evm_approve and evm_bump are open to anyone (INTERFACES.md 33). The section names no deposit for them, so none is
  // sent, as for execute_step: the account pays the signer itself.
  async evmApprove(account, token): Promise<StepResult> {
    if (config.dryRun) return { ok: true, hash: null, logs: [], seconds: 0, retry: false };
    if (!call) return { ok: false, hash: null, failure: "KEEPER_PRIVATE_KEY is empty in .env", logs: [], seconds: 0, retry: false };
    const tx = await call(account, "evm_approve", { token }, { tgas: TGAS_ACCOUNT, deposit: 0n, label: `evm_approve ${token}` });
    return { ok: tx.ok, hash: tx.hash, ...(tx.failure ? { failure: tx.failure } : {}), logs: tx.logs, seconds: tx.seconds, retry: tx.hash === null };
  },
  async evmBump(account, nonce, maxFee, tip): Promise<StepResult> {
    if (config.dryRun) return { ok: true, hash: null, logs: [], seconds: 0, retry: false };
    if (!call) return { ok: false, hash: null, failure: "KEEPER_PRIVATE_KEY is empty in .env", logs: [], seconds: 0, retry: false };
    const tx = await call(account, "evm_bump", { nonce, max_fee: maxFee, tip }, { tgas: TGAS_ACCOUNT, deposit: 0n, label: `evm_bump ${nonce}` });
    return { ok: tx.ok, hash: tx.hash, ...(tx.failure ? { failure: tx.failure } : {}), logs: tx.logs, seconds: tx.seconds, retry: tx.hash === null };
  },
  ...(!config.dryRun && { sendEvm: async (account, state, chainNonce, aave) => evmSender.sendNew(account, readEvm(state)?.signed ?? [], chainNonce, aave) }),
  forget: (account) => states.forget(account),
  log,
  now: Date.now,
};

log("start", config.dryRun ? "the keeper is starting in a dry run: it sends nothing" : "the keeper is starting", {
  near: hostOf(config.nearRpcUrl),
  hyperliquid: hostOf(config.hlApiUrl),
  outlayer: hostOf(config.outlayerApiUrl),
  outlayer_wait_s: config.outlayerWaitMs / 1000,
  evm: `${hostOf(config.evmRpcUrl)} (chain ${config.evmChainId})`,
  backend: hostOf(config.apiUrl),
  oneclick: oneClick ? hostOf(oneClick.baseUrl) : null,
  keeper: config.keeperId,
  signing_key: keeperKey ? "present" : "missing",
  payment_key: paymentKey ? "present" : "missing",
  factory: config.factoryId,
  drill: config.drillId,
  gateway_project: config.gatewayProject,
  accounts: config.accounts.length ? config.accounts : config.newest ? `the factory's newest ${config.newest}` : "the factory's list",
  tick_ms: config.tickMs,
  log_file: config.logFile,
  book_stress_file: config.stressFile,
  rhea_copy: config.rheaId ?? null,
  rhea_price_signer: config.rheaId ? config.operatorId : null,
  rhea_price_key: config.rheaId ? (operatorKey ? "present" : "missing") : null,
  rhea_hold_file: config.rheaId ? config.rheaHoldFile : null,
});
if (!keeperKey && !config.dryRun) log("start", "KEEPER_PRIVATE_KEY is empty: checks and steps will fail until it is set");
if (!config.rheaId) log("start", "RHEA_ACCOUNT_ID is empty: our Rhea copy's BTC price isn't kept in step");
else if (!operatorKey && !config.dryRun) log("start", `OPERATOR_PRIVATE_KEY is empty: the keeper can read ${config.rheaId}'s BTC price but can't set it`);
if (!paymentKey && !config.dryRun) log("start", "OUTLAYER_PAYMENT_KEY is empty: the gateway's deleverage and cancel_risky modes can't run");

// The daily book stress test: pb-risk's `book` mode, with the version the factory pins, paid by our key.
const stressFile = new JsonLog({ file: config.stressFile, out: () => {} });
const stress =
  outlayer || config.dryRun
    ? new BookStressJob(
        {
          async pin() {
            const conf = await near.viewOrNull<{ risk?: { project_id?: unknown; version_key?: unknown } }>(config.factoryId, "get_config");
            const risk = conf?.risk;
            if (!risk || risk.project_id !== `${config.keeperId}/pb-risk`) return null;
            return { project: risk.project_id, versionKey: typeof risk.version_key === "string" && risk.version_key ? risk.version_key : undefined };
          },
          run: (project, input, versionKey) => outlayer!.run(project, input, versionKey),
          record: stressFile.log,
          log,
          now: Date.now,
          dryRun: config.dryRun,
        },
        stressHistory(readTail(config.stressFile).events),
      )
    : null;
if (!stress) log("start", "OUTLAYER_PAYMENT_KEY is empty: the daily book stress test can't run");

const memory = new Map<string, AccountMemory>();
const startedAt = new Date().toISOString();
let lastTickAt: string | null = null;
const once = async () => {
  await tick(deps, memory, { accounts: config.accounts });
  lastTickAt = new Date().toISOString();
};

await once();
if (config.once) {
  await stress?.maybeRun();
  log("stop", "--once: done");
} else {
  const server = statusServer(() => ({
    started_at: startedAt,
    last_tick_at: lastTickAt,
    tick_ms: config.tickMs,
    dry_run: config.dryRun,
    log_file: config.logFile,
    accounts: Object.fromEntries([...memory].map(([id, m]) => [id, accountStatus(m)])),
  }),
  // INTERFACES.md 49.4: POST /check, for the backend alone (its service token, read from the file it writes at start).
  // A keeper that sends nothing (a dry run, or no key) has no such door: the backend then answers `keeper_off`, and
  // the page asks for the check from the client's wallet, as before.
  config.dryRun || !call ? undefined : { token: () => readServiceToken(config.serviceTokenFile), run: (account, intent) => (isClientAccount(account, config.factoryId) ? clientCheck(deps, memory, account, intent) : Promise.resolve({ accepted: false, reason: `not a client account of ${config.factoryId}`, tries: 0, tx: null })) },
  );
  server.on("error", (error) => log("start", `the status page is off: ${error.message}`));
  server.listen(config.statusPort, "127.0.0.1", () => log("start", `status page on http://127.0.0.1:${config.statusPort}/`));

  let running = false; // a slow tick is never overlapped by the next one
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void once().finally(() => (running = false));
  }, config.tickMs);
  // The stress test runs beside the ticks, never inside one: a run takes several seconds.
  void stress?.maybeRun();
  const stressTimer = setInterval(() => void stress?.maybeRun(), 60_000);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      clearInterval(timer);
      clearInterval(stressTimer);
      server.close();
      log("stop", `stopped by ${signal}`);
      process.exit(0);
    });
  }
}
