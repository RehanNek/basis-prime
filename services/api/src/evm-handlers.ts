// Stage 3 (INTERFACES.md 33; FUNDING.md 4.5 and 7.2): the accounts' side on Aave's chain (Base Sepolia on testnet).
//
//   POST /api/evm/submit  {account, nonce}: sends that entry of get_state().evm.signed, after reading it apart
//   POST /api/evm/gas     {account, mint?, wrap?}: testnet's gas wallet tops the account's address up with test ETH,
//                         mints test tokens to it from Aave's faucet, or wraps test ETH for it
//   GET  /api/evm/gas     whether the gas helper is on, and what its wallet holds (reads only; the gate's dry run asks)
//   GET  /api/lender/:account gains `evm` (evmView below), and Aave's entry gains `held`
//   GET  /api/lenders' testnet Aave row gains `collateral_room` (collateralRoom below)
//
// The account's address there is its Hyperliquid address (get_state().hl.address): the same Chain Signatures key. The
// backend never signs for an account: it only sends what the account itself signed, read from the chain. The one key
// it holds is the gas wallet's (EVM_GAS_PRIVATE_KEY), a test-chain key that pays for test ETH and nothing else.
import type { EvmChain, EvmReply, EvmRequest } from "./evm.js";
import { EvmError } from "./evm.js";
import { addressOfKey, CALLS, callData, decodeSignedTx, EvmTxError, keyBytes, POOL_CALLS, signTx, TOKEN_CALLS, type SignedTx, type Type2Tx } from "./evm-tx.js";
import { soft, type Deps } from "./handlers.js";
import {
  DAY_MS,
  FAUCET_MAX_USDC_TOKENS,
  FAUCET_MINTS_PER_HOUR,
  GAS_FLOOR_WEI,
  GAS_LOW_WEI,
  GAS_TOP_UPS_PER_ACCOUNT_PER_DAY,
  GAS_WALLET_RESERVE_WEI,
  GAS_WEI_PER_DAY,
  HOUR_MS,
  KeyedBudget,
  KeyedRateLimiter,
  WRAP_WEI_PER_ACCOUNT_PER_DAY,
} from "./limiter.js";
import { NotDeployedError } from "./rpc.js";
import { asObject, badRequest, HttpError, isPrimeAccount } from "./validate.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const UNITS = /^(0|[1-9]\d{0,38})$/;

/** A token on Aave's chain, as the account's config names it (INTERFACES.md 24). The address is kept lowercase. */
export interface EvmToken {
  symbol: string;
  address: string;
  decimals: number;
}

/** `get_config().lenders.aave`. */
export interface AaveConf {
  chainId: number;
  pool: string;
  usdc: EvmToken;
  collateral: EvmToken[];
  /** The most a signed transaction may pay per gas, in wei, as the config's string. */
  maxFeePerGas: string | null;
}

function tokenOf(value: unknown): EvmToken | null {
  const t = value as { symbol?: unknown; address?: unknown; decimals?: unknown } | null;
  if (!t || typeof t.symbol !== "string" || typeof t.address !== "string" || !ADDRESS.test(t.address) || typeof t.decimals !== "number" || !Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) return null;
  return { symbol: t.symbol, address: t.address.toLowerCase(), decimals: t.decimals };
}

/** The Aave settings of a Config (an account's own, or the factory's), or null when it has none that we can read. */
export function aaveConfOf(config: unknown): AaveConf | null {
  const a = (config as { lenders?: { aave?: { chain_id?: unknown; pool?: unknown; usdc?: unknown; collateral?: unknown; max_fee_per_gas?: unknown } | null } | null } | null)?.lenders?.aave;
  if (!a || typeof a.chain_id !== "number" || typeof a.pool !== "string" || !ADDRESS.test(a.pool)) return null;
  const usdc = tokenOf(a.usdc);
  if (!usdc) return null;
  const collateral = (Array.isArray(a.collateral) ? a.collateral : []).map(tokenOf).filter((t): t is EvmToken => t !== null);
  return { chainId: a.chain_id, pool: a.pool.toLowerCase(), usdc, collateral, maxFeePerGas: typeof a.max_fee_per_gas === "string" && UNITS.test(a.max_fee_per_gas) ? a.max_fee_per_gas : null };
}

/** One entry of get_state().evm.signed (INTERFACES.md 33). */
export interface EvmSignedEntry {
  nonce: number;
  kind: string;
  token: string | null;
  amount: string | null;
  raw: string;
  hash: string;
  /** "<pid>:<i>" for a plan step's transaction, else null. */
  step: string | null;
}

interface EvmStateView {
  hl?: { address?: string | null } | null;
  evm?: { nonce?: unknown; signed?: unknown } | null;
}

/** get_state().evm: the account's next nonce and its signed transactions, oldest first. Entries we can't read are dropped. */
export function evmStateOf(state: EvmStateView | null | undefined): { nonce: number | null; signed: EvmSignedEntry[] } {
  const evm = state?.evm;
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  const signed: EvmSignedEntry[] = [];
  for (const e of (Array.isArray(evm?.signed) ? evm.signed : []) as (Record<string, unknown> | null)[]) {
    const nonce = e ? nonceOf(e.nonce) : null;
    if (!e || nonce === null || typeof e.raw !== "string" || typeof e.hash !== "string" || !HASH.test(e.hash)) continue;
    signed.push({ nonce, kind: text(e.kind) ?? "?", token: text(e.token)?.toLowerCase() ?? null, amount: text(e.amount) ?? (typeof e.amount === "number" ? String(e.amount) : null), raw: e.raw, hash: e.hash.toLowerCase(), step: text(e.step) });
  }
  return { nonce: nonceOf(evm?.nonce), signed };
}

/** A nonce as the account writes it: a whole number, or the same in a string. Null for anything else. */
function nonceOf(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function addressOf(state: EvmStateView | null | undefined): string | null {
  const address = state?.hl?.address;
  return typeof address === "string" && ADDRESS.test(address) ? address.toLowerCase() : null;
}

function clientAccount(deps: Deps, value: unknown): string {
  const { factory } = deps.config.ids;
  if (!isPrimeAccount(value, factory)) throw badRequest(`account must be a client account, <name>.${factory}`);
  return value;
}

/** get_state and get_config of a client account; 404 while it has no contract. */
async function readAccount(deps: Deps, account: string): Promise<{ state: EvmStateView; aave: AaveConf | null }> {
  try {
    const [state, config] = await Promise.all([deps.chain.view<EvmStateView | null>(account, "get_state"), deps.chain.view<unknown>(account, "get_config")]);
    if (!state.value) throw new HttpError(404, "not_deployed", `${account} has no state`);
    return { state: state.value, aave: aaveConfOf(config.value) };
  } catch (error) {
    if (error instanceof NotDeployedError) throw new HttpError(404, "not_deployed", `${account} has no account contract yet (${error.reason})`);
    throw error;
  }
}

function chainOf(deps: Deps): EvmChain {
  if (!deps.evmChain) throw new HttpError(503, "evm_off", "The backend has no connection to Aave's chain");
  return deps.evmChain;
}

/** One batch, refusing a node that answers for another chain than EVM_CHAIN_ID before anything it said is used. */
async function ask(deps: Deps, requests: EvmRequest[]): Promise<EvmReply[]> {
  const { chainId, replies } = await chainOf(deps).batch(requests);
  if (chainId !== deps.config.evmChainId) throw new EvmError(`EVM_RPC_URL answers for chain ${chainId} but EVM_CHAIN_ID is ${deps.config.evmChainId}: point both at the same chain`);
  return replies;
}

/** A reply that must be a number (0x hex), in words when it isn't. */
function quantity(reply: EvmReply | undefined, what: string): bigint {
  if (!reply?.ok) throw new EvmError(`${what} failed: ${reply?.error ?? "no answer"}`);
  if (typeof reply.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(reply.result)) throw new EvmError(`${what} answered something that isn't a number`);
  return BigInt(reply.result);
}

/** A reply's first 32-byte word, for a call that answers one or more words. */
function word(reply: EvmReply | undefined, index: number, what: string): bigint {
  if (!reply?.ok) throw new EvmError(`${what} failed: ${reply?.error ?? "no answer"}`);
  const result = reply.result;
  if (typeof result !== "string" || !/^0x([0-9a-fA-F]{64})+$/.test(result) || result.length < 2 + 64 * (index + 1)) throw new EvmError(`${what} answered something that isn't whole 32-byte words`);
  return BigInt(`0x${result.slice(2 + 64 * index, 2 + 64 * (index + 1))}`);
}

/** A transaction's receipt as the node gives it: null while it isn't mined. */
function receiptOf(reply: EvmReply | undefined): { ok: boolean; block: number | null } | null {
  if (!reply?.ok) throw new EvmError(`eth_getTransactionReceipt failed: ${reply?.error ?? "no answer"}`);
  const r = reply.result as { status?: unknown; blockNumber?: unknown } | null;
  if (!r || typeof r !== "object") return null;
  return { ok: typeof r.status === "string" && /^0x0*1$/.test(r.status), block: typeof r.blockNumber === "string" && /^0x[0-9a-fA-F]+$/.test(r.blockNumber) ? Number(BigInt(r.blockNumber)) : null };
}

const ethCall = (to: string, data: string): EvmRequest => ({ method: "eth_call", params: [{ to, data }, "latest"] });
const receipt = (hash: string): EvmRequest => ({ method: "eth_getTransactionReceipt", params: [hash] });

// ---------- POST /api/evm/submit ----------

/**
 * Reads an account's signed transaction apart and refuses it unless it is what the account may send (INTERFACES.md
 * 33): it hashes to the entry's `hash`; it is for this chain and carries the entry's nonce; it moves no ETH; it goes
 * to Aave's Pool with one of the Pool's four calls, or to a token of the account's config with `approve` or
 * `transfer`; and the key behind the account's address signed it.
 */
export function checkSigned(entry: EvmSignedEntry, aave: AaveConf, chainId: number, address: string | null): SignedTx {
  const bad = (why: string) => new HttpError(422, "bad_entry", `The signed transaction with nonce ${entry.nonce} ${why}`);
  let tx: SignedTx;
  try {
    tx = decodeSignedTx(entry.raw);
  } catch (error) {
    throw bad(`can't be read: ${error instanceof EvmTxError ? error.message : "it isn't a transaction"}`);
  }
  if (tx.hash !== entry.hash) throw bad(`doesn't hash to the hash stored with it (${entry.hash})`);
  if (tx.chainId !== BigInt(chainId) || aave.chainId !== chainId) throw bad(`is for chain ${tx.chainId}, and the account's Aave settings name chain ${aave.chainId}: the backend sends on chain ${chainId} only`);
  if (tx.nonce !== BigInt(entry.nonce)) throw bad(`carries nonce ${tx.nonce} inside`);
  if (tx.value !== 0n) throw bad("moves ETH, which an account's transactions never do");
  const selector = tx.data.slice(0, 10);
  const tokens = [aave.usdc, ...aave.collateral];
  if (tx.to === aave.pool) {
    if (!POOL_CALLS.includes(selector)) throw bad("calls Aave's Pool with something other than supply, borrow, repay or withdraw");
  } else if (tokens.some((t) => t.address === tx.to)) {
    if (!TOKEN_CALLS.includes(selector)) throw bad("calls a token with something other than approve or transfer");
  } else {
    throw bad(`goes to ${tx.to}, which is neither Aave's Pool nor a token of the account's Aave settings`);
  }
  if (!address) throw bad("can't be sent: the account has no address on Aave's chain yet");
  if (tx.from !== address) throw bad(`was signed by ${tx.from}, not by the account's address ${address}`);
  return tx;
}

/** The node's words for "I have this one already", from go-ethereum (core/txpool/errors.go) and reth (rpc-eth-types). */
const KNOWN = /already known|known transaction|already imported/i;
/** "The chain has used this nonce": go-ethereum's core/error.go and reth say `nonce too low`. */
const NONCE_USED = /nonce too low/i;
/**
 * "That nonce is taken", for the gas wallet's own sends: mined already, or another transaction waits with it at the
 * same fee (`replacement transaction underpriced`). Stage 4: the stand-in's float signs with the same key from
 * another process, so the wallet reads the pending nonce right before each signature and, when the node says this,
 * reads it again and signs again.
 */
const NONCE_TAKEN = /nonce too low|replacement transaction underpriced/i;
const GAS_SEND_TRIES = 4;

/**
 * POST /api/evm/submit {account, nonce}: reads evm.signed from the chain (never from the browser), checks the entry
 * with that nonce (the newest, if a bump signed it again), and sends it with eth_sendRawTransaction. Sending twice is
 * harmless: the chain takes a nonce once. Answers `status`: `sent`, `known` (the node had it already) or `mined`.
 */
export async function postEvmSubmit(deps: Deps, body: unknown) {
  const fields = asObject(body);
  const account = clientAccount(deps, fields.account);
  const nonce = fields.nonce;
  if (typeof nonce !== "number" || !Number.isSafeInteger(nonce) || nonce < 0) throw badRequest("nonce must be the signed transaction's nonce, a whole number");
  chainOf(deps);
  if (deps.limits.evmSubmits && !deps.limits.evmSubmits.take()) throw new HttpError(429, "too_many_submits", "Too many transactions sent this minute; try again shortly");

  const { state, aave } = await readAccount(deps, account);
  const { signed } = evmStateOf(state);
  const entry = signed.filter((e) => e.nonce === nonce).at(-1);
  if (!entry) {
    const have = signed.map((e) => e.nonce);
    throw new HttpError(404, "no_entry", `${account} has no signed transaction with nonce ${nonce}${have.length ? ` (it keeps ${Math.min(...have)} to ${Math.max(...have)})` : " (it has none yet)"}`);
  }
  if (!aave) throw new HttpError(409, "no_aave", `${account} has no settings for Aave, so it has nothing to send there`);
  const tx = checkSigned(entry, aave, deps.config.evmChainId, addressOf(state));
  const answer = (status: "sent" | "known" | "mined", mined?: { ok: boolean; block: number | null }) => ({
    account,
    nonce,
    kind: entry.kind,
    hash: tx.hash,
    status,
    ...(mined ? { block: mined.block, reverted: !mined.ok } : {}),
  });

  // Mined already? Then there is nothing to send.
  const before = receiptOf((await ask(deps, [receipt(tx.hash)]))[0]);
  if (before) {
    deps.evmStatuses?.set(tx.hash, before.ok ? "mined" : "failed");
    return answer("mined", before);
  }
  const sent = (await ask(deps, [{ method: "eth_sendRawTransaction", params: [entry.raw] }]))[0]!;
  if (sent.ok) {
    if (typeof sent.result !== "string" || sent.result.toLowerCase() !== tx.hash) throw new HttpError(502, "evm", `The chain's node answered an unexpected hash for the transaction: ${String(sent.result).slice(0, 80)}`);
    return answer("sent");
  }
  if (KNOWN.test(sent.error)) return answer("known");
  if (NONCE_USED.test(sent.error)) {
    // The chain has used this nonce: by this transaction, mined a moment ago, or by another one signed for it.
    const after = receiptOf((await ask(deps, [receipt(tx.hash)]))[0]);
    if (after) return answer("mined", after);
    throw new HttpError(409, "nonce_used", `The chain has already used nonce ${nonce} with another transaction of this account's, so this one can't go through`);
  }
  throw new HttpError(502, "evm_refused", `The chain's node refused the transaction: ${sent.error}`);
}

// ---------- the gas wallet ----------

/** Testnet's gas wallet. `queue` runs one job at a time: two at once would sign with the same nonce. */
export interface GasWallet {
  address: string;
  sign(tx: Type2Tx): { raw: string; hash: string };
  queue<T>(job: () => Promise<T>): Promise<T>;
}

/** The wallet behind EVM_GAS_PRIVATE_KEY. The key stays inside this closure: nothing here logs or returns it. */
export function gasWalletOf(keyText: string): GasWallet {
  const key = keyBytes(keyText, "EVM_GAS_PRIVATE_KEY");
  let last: Promise<unknown> = Promise.resolve();
  return {
    address: addressOfKey(key),
    sign: (tx) => signTx(tx, key),
    queue<T>(job: () => Promise<T>): Promise<T> {
      const run = last.then(job, job);
      last = run.catch(() => undefined);
      return run;
    },
  };
}

/** The gas helper's limits (limiter.ts says why each). */
export interface GasLimits {
  /** Top-ups for one account in a day. */
  topUps: KeyedRateLimiter;
  /** Wei sent as top-ups in a day, all accounts together (one key). */
  dailyWei: KeyedBudget;
  /** Wei wrapped for one account in a day. */
  wraps: KeyedBudget;
  /** Aave's faucet: one mint an hour for one recipient and token. */
  mints: KeyedRateLimiter;
}

export function gasLimits(now: () => number = Date.now): GasLimits {
  return {
    topUps: new KeyedRateLimiter(GAS_TOP_UPS_PER_ACCOUNT_PER_DAY, DAY_MS, now),
    dailyWei: new KeyedBudget(GAS_WEI_PER_DAY, DAY_MS, now),
    wraps: new KeyedBudget(WRAP_WEI_PER_ACCOUNT_PER_DAY, DAY_MS, now),
    mints: new KeyedRateLimiter(FAUCET_MINTS_PER_HOUR, HOUR_MS, now),
  };
}

/** The gas wallet never pays more than this per gas: Base Sepolia's fee is thousands of times lower (0.005 gwei on 11 Nov). */
export const GAS_WALLET_MAX_FEE_WEI = 5_000_000_000n;
const MIN_TIP_WEI = 1_000_000n;
/** A plain ETH transfer to a wallet address. */
const TRANSFER_GAS = 21_000n;
/** WETH's deposit() used 44,866 gas and a token transfer under 60,000 on the live try (research/aave.md). */
const WRAP_GAS = 100_000n;
const TOKEN_TRANSFER_GAS = 100_000n;
/** The faucet's mint used 87,902: the node's own estimate, half as much again, and never more than this. */
const MINT_GAS_MAX = 300_000n;
/** How long the helper waits for its transactions to be mined before it answers anyway. Blocks there are 2 s or less. */
export const GAS_WAIT_MS = 20_000;

const eth = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} ETH`;

/**
 * POST /api/evm/gas {account, mint?: {token, amount}, wrap?: {amount}}. Testnet only (the backend starts on test
 * chains only, config.ts), and only for a client account of our factory that has Aave settings and an address.
 * - Gas: when the address holds under 0.001 test ETH, the gas wallet sends what brings it to 0.002.
 * - `mint`: the gas wallet calls Aave's faucet, `mint(token, address, amount)`, for a token of the account's config.
 * - `wrap`: the gas wallet wraps that much of its own test ETH (WETH's `deposit()`) and transfers the WETH to the
 *   address. `amount` is wei.
 * Every part is checked against its limit before anything is sent; one refusal sends nothing. The helper then waits
 * up to 20 s for its transactions to be mined, and answers either way.
 */
export async function postEvmGas(deps: Deps, body: unknown) {
  const fields = asObject(body);
  const account = clientAccount(deps, fields.account);
  const wallet = deps.gasWallet;
  const limits = deps.gasLimits;
  if (!wallet || !limits) throw new HttpError(503, "gas_off", "The gas helper is off: EVM_GAS_PRIVATE_KEY is empty in .env");
  chainOf(deps);

  const amountOf = (value: unknown, what: string): bigint => {
    if (typeof value !== "string" || !UNITS.test(value) || value === "0") throw badRequest(`${what} must be a positive whole number, as a string`);
    return BigInt(value);
  };
  const mintAsk = fields.mint === undefined || fields.mint === null ? null : asObject(fields.mint);
  const wrapAsk = fields.wrap === undefined || fields.wrap === null ? null : asObject(fields.wrap);
  if (mintAsk && (typeof mintAsk.token !== "string" || !ADDRESS.test(mintAsk.token))) throw badRequest("mint.token must be a token's 0x address");
  const mintAmount = mintAsk ? amountOf(mintAsk.amount, "mint.amount (the token's own units)") : 0n;
  const wrapAmount = wrapAsk ? amountOf(wrapAsk.amount, "wrap.amount (wei)") : 0n;

  const { state, aave } = await readAccount(deps, account);
  if (!aave) throw new HttpError(409, "no_aave", `${account} has no settings for Aave: it was made before Aave was added, and the gas helper serves only accounts that can use it`);
  if (aave.chainId !== deps.config.evmChainId) throw new HttpError(409, "wrong_chain", `${account}'s Aave settings name chain ${aave.chainId}, and the backend is on chain ${deps.config.evmChainId}`);
  const address = addressOf(state);
  if (!address) throw new HttpError(409, "no_address", `${account} has no address on Aave's chain yet: it gets one with its Hyperliquid address`);

  const tokens = [aave.usdc, ...aave.collateral];
  const mintToken = mintAsk ? tokens.find((t) => t.address === String(mintAsk.token).toLowerCase()) : undefined;
  if (mintAsk) {
    if (!mintToken) throw badRequest(`mint.token isn't a token of the account's Aave settings (${tokens.map((t) => t.symbol).join(", ")})`);
    // Aave's faucet gives at most 1,000,000 USDC, or 1 whole token of anything else, in one call (research/aave.md).
    const most = (mintToken.address === aave.usdc.address ? FAUCET_MAX_USDC_TOKENS : 1n) * 10n ** BigInt(mintToken.decimals);
    if (mintAmount > most) throw badRequest(`Aave's faucet gives at most ${mintToken.address === aave.usdc.address ? "1,000,000" : "1"} ${mintToken.symbol} in one call (${most} units)`);
  }
  const weth = aave.collateral.find((t) => t.symbol === "WETH");
  if (wrapAsk && !weth) throw badRequest("the account's Aave settings list no WETH, so there is nothing to wrap ETH into");
  if (wrapAsk && wrapAmount > WRAP_WEI_PER_ACCOUNT_PER_DAY) throw badRequest(`wrap.amount is at most ${eth(WRAP_WEI_PER_ACCOUNT_PER_DAY)} (${WRAP_WEI_PER_ACCOUNT_PER_DAY} wei)`);

  return wallet.queue(async () => {
    const mintData = mintToken ? callData(CALLS.mint.selector, [mintToken.address, address, mintAmount]) : null;
    const replies = await ask(deps, [
      { method: "eth_getBalance", params: [address, "latest"] },
      { method: "eth_getBalance", params: [wallet.address, "latest"] },
      { method: "eth_getTransactionCount", params: [wallet.address, "pending"] },
      { method: "eth_getBlockByNumber", params: ["latest", false] },
      { method: "eth_maxPriorityFeePerGas", params: [] },
      ...(mintData ? [{ method: "eth_estimateGas", params: [{ from: wallet.address, to: deps.config.aaveFaucet, data: mintData }] }] : []),
    ]);
    const balance = quantity(replies[0], "eth_getBalance");
    const walletBalance = quantity(replies[1], "eth_getBalance");
    // The nonce is read again right before each signature (below); this first read is only its floor.
    let nextNonce = quantity(replies[2], "eth_getTransactionCount");
    const block = replies[3]?.ok ? (replies[3].result as { baseFeePerGas?: unknown } | null) : null;
    if (typeof block?.baseFeePerGas !== "string") throw new EvmError("eth_getBlockByNumber answered no base fee");
    const suggested = replies[4]?.ok && typeof replies[4].result === "string" ? BigInt(replies[4].result) : MIN_TIP_WEI;
    const tip = suggested > MIN_TIP_WEI ? suggested : MIN_TIP_WEI;
    const maxFee = BigInt(block.baseFeePerGas) * 2n + tip;
    if (maxFee > GAS_WALLET_MAX_FEE_WEI) throw new HttpError(503, "gas_dear", `Gas on the chain costs ${Number(maxFee) / 1e9} gwei now, above what the gas helper pays (${Number(GAS_WALLET_MAX_FEE_WEI) / 1e9} gwei): try again later`);
    let mintGas = 0n;
    if (mintData) {
      // The node runs the mint without sending it: a faucet that would refuse (it gives once an hour) says so here.
      const estimate = replies[5];
      if (!estimate?.ok) throw new HttpError(409, "faucet_refused", `Aave's faucet wouldn't mint ${mintAmount} units of ${mintToken!.symbol} to ${address} now: ${estimate?.error ?? "no answer"}. It gives each address each token once an hour`);
      const half = (quantity(estimate, "eth_estimateGas") * 3n) / 2n;
      mintGas = half > MINT_GAS_MAX ? MINT_GAS_MAX : half;
    }

    // What each part needs, and whether every limit lets it through, before anything is sent.
    const topUp = balance < GAS_LOW_WEI ? GAS_FLOOR_WEI - balance : 0n;
    if (topUp > 0n) {
      if (!limits.topUps.available(account)) throw new HttpError(429, "too_many_top_ups", `${account} has had its ${GAS_TOP_UPS_PER_ACCOUNT_PER_DAY} gas top-ups for today. Its address holds ${eth(balance)}`);
      if (limits.dailyWei.left("all") < topUp) throw new HttpError(429, "gas_budget", `The gas helper has sent its ${eth(GAS_WEI_PER_DAY)} for today; it sends again tomorrow`);
    }
    const mintKey = mintToken ? `${address}:${mintToken.address}` : "";
    if (mintToken && !limits.mints.available(mintKey)) throw new HttpError(429, "too_many_mints", `Aave's faucet gives ${mintToken.symbol} to one address once an hour, and ${address} has had its turn this hour`);
    if (wrapAsk && limits.wraps.left(account) < wrapAmount) throw new HttpError(429, "wrap_budget", `${account} may have ${eth(WRAP_WEI_PER_ACCOUNT_PER_DAY)} wrapped for it in a day, and ${eth(limits.wraps.left(account))} of that is left`);
    const fees = maxFee * ((topUp > 0n ? TRANSFER_GAS : 0n) + mintGas + (wrapAsk ? WRAP_GAS + TOKEN_TRANSFER_GAS : 0n));
    const spend = topUp + wrapAmount + fees;
    if (walletBalance < spend) throw new HttpError(503, "gas_wallet_low", `The gas wallet (${wallet.address}) holds ${eth(walletBalance)}, less than the ${eth(spend)} this needs: send it test ETH`);
    if (wrapAsk && walletBalance - spend < GAS_WALLET_RESERVE_WEI) throw new HttpError(503, "gas_wallet_low", `Wrapping ${eth(wrapAmount)} would leave the gas wallet (${wallet.address}) with under ${eth(GAS_WALLET_RESERVE_WEI)}; it holds ${eth(walletBalance)}. Send it test ETH`);

    const chainId = BigInt(deps.config.evmChainId);
    const went: string[] = [];
    const pause = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const send = async (what: string, to: string, value: bigint, data: string, gasLimit: bigint): Promise<string> => {
      let refusal = "";
      for (let attempt = 1; attempt <= GAS_SEND_TRIES; attempt += 1) {
        // Never below what this request has used itself: a node behind the others can answer an older count.
        const pending = quantity((await ask(deps, [{ method: "eth_getTransactionCount", params: [wallet.address, "pending"] }]))[0], "eth_getTransactionCount");
        const nonce = pending > nextNonce ? pending : nextNonce;
        const signedTx = wallet.sign({ chainId, nonce, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, gasLimit, to, value, data });
        const reply = (await ask(deps, [{ method: "eth_sendRawTransaction", params: [signedTx.raw] }]))[0]!;
        if (reply.ok || KNOWN.test(reply.error)) {
          nextNonce = nonce + 1n;
          went.push(`${what} (${signedTx.hash})`);
          return signedTx.hash;
        }
        refusal = reply.error;
        if (!NONCE_TAKEN.test(refusal)) break;
        // The stand-in's float took that nonce: read it again and sign again.
        nextNonce = nonce + 1n;
        await pause(500 * attempt);
      }
      throw new HttpError(502, "evm_refused", `The chain's node refused ${what}: ${refusal}.${went.length ? ` Already sent: ${went.join("; ")}` : " Nothing was sent"}`);
    };

    let topUpHash: string | null = null;
    if (topUp > 0n) {
      limits.topUps.take(account);
      limits.dailyWei.take("all", topUp);
      topUpHash = await send(`the top-up of ${eth(topUp)}`, address, topUp, "0x", TRANSFER_GAS);
    }
    let mintHash: string | null = null;
    if (mintToken && mintData) {
      limits.mints.take(mintKey);
      mintHash = await send(`the mint of ${mintToken.symbol}`, deps.config.aaveFaucet.toLowerCase(), 0n, mintData, mintGas);
    }
    let wrapped: { deposit: string; transfer: string } | null = null;
    if (wrapAsk && weth) {
      limits.wraps.take(account, wrapAmount);
      const deposit = await send(`wrapping ${eth(wrapAmount)}`, weth.address, wrapAmount, CALLS.deposit.selector, WRAP_GAS);
      const transfer = await send("the transfer of the WETH", weth.address, 0n, callData(CALLS.transfer.selector, [address, wrapAmount]), TOKEN_TRANSFER_GAS);
      wrapped = { deposit, transfer };
    }

    // Wait for what was sent, a second at a time; answer after 20 s either way.
    const hashes = [topUpHash, mintHash, wrapped?.deposit ?? null, wrapped?.transfer ?? null].filter((h): h is string => h !== null);
    const mined = new Map<string, { ok: boolean; block: number | null }>();
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let waited = 0; hashes.some((h) => !mined.has(h)) && waited < GAS_WAIT_MS; waited += 1_000) {
      await sleep(1_000);
      const open = hashes.filter((h) => !mined.has(h));
      const receipts = await ask(deps, open.map(receipt)).catch(() => [] as EvmReply[]);
      open.forEach((h, i) => {
        const r = receipts[i]?.ok ? receiptOf(receipts[i]) : null;
        if (r) mined.set(h, r);
      });
    }
    const after = hashes.length ? await ask(deps, [{ method: "eth_getBalance", params: [address, "latest"] }]).then((r) => quantity(r[0], "eth_getBalance")).catch(() => balance) : balance;
    const state_ = (hash: string | null) => (hash === null ? {} : { mined: mined.has(hash), ...(mined.has(hash) ? { ok: mined.get(hash)!.ok } : {}) });
    return {
      account,
      address,
      eth: { balance: after.toString(), sent: topUp.toString(), hash: topUpHash, ...state_(topUpHash) },
      mint: mintToken && mintHash ? { token: mintToken.address, symbol: mintToken.symbol, amount: mintAmount.toString(), hash: mintHash, ...state_(mintHash) } : null,
      wrap: wrapped && weth ? { token: weth.address, symbol: weth.symbol, amount: wrapAmount.toString(), hash: wrapped.transfer, deposit_hash: wrapped.deposit, ...state_(wrapped.transfer) } : null,
      gas_wallet: wallet.address,
    };
  });
}

/**
 * GET /api/evm/gas: whether the gas helper is on, for which chain, and what its wallet holds, with the helper's
 * limits. Reads only. `balance` is null when the helper is off or the chain can't be read.
 */
export async function getEvmGas(deps: Deps) {
  const wallet = deps.gasWallet;
  const balance = wallet && deps.evmChain ? await ask(deps, [{ method: "eth_getBalance", params: [wallet.address, "latest"] }]).then((r) => quantity(r[0], "eth_getBalance").toString()).catch(() => null) : null;
  return {
    on: Boolean(wallet && deps.gasLimits && deps.evmChain),
    chain_id: deps.config.evmChainId,
    gas_wallet: wallet?.address ?? null,
    balance,
    floor: GAS_FLOOR_WEI.toString(),
    tops_up_under: GAS_LOW_WEI.toString(),
    top_ups_per_account_per_day: GAS_TOP_UPS_PER_ACCOUNT_PER_DAY,
    top_ups_per_day: GAS_WEI_PER_DAY.toString(),
    wrap_per_account_per_day: WRAP_WEI_PER_ACCOUNT_PER_DAY.toString(),
    wallet_reserve: GAS_WALLET_RESERVE_WEI.toString(),
  };
}

// ---------- GET /api/lender/:account: the `evm` part, and what is posted at Aave ----------

export interface EvmHeld {
  token: string;
  symbol: string;
  decimals: number;
  amount: string;
}

/** `signed` (not sent, as far as the node knows), `sent` (the node has it), `mined`, `failed` (mined and reverted), or `replaced` (another transaction used its nonce). */
export type EvmTxStatus = "signed" | "sent" | "mined" | "failed" | "replaced";

export interface EvmView {
  address: string;
  /** The account's own next nonce, and how many of its transactions the chain has mined; null if either couldn't be read. */
  nonce: number | null;
  chain_nonce: number | null;
  /** Test ETH at the address, in wei. */
  eth: string | null;
  /** USDC and each collateral token at the address, in the token's own units: spare collateral and cash. */
  wallet: EvmHeld[];
  /** What Aave's own books say the address has posted, token by token: the same list as Aave's `held`. */
  posted: EvmHeld[];
  /** Each signed transaction with its status. `step` is "<pid>:<i>" for a plan step's transaction, else null. */
  signed: { nonce: number; kind: string; token: string | null; amount: string | null; hash: string; step: string | null; status: EvmTxStatus }[];
  /** Why the chain's part is missing, when Aave's chain couldn't be read. */
  chain_error: string | null;
}

/**
 * The account's standing on Aave's chain, for GET /api/lender/:account, and what it has posted at Aave (`held`, each
 * collateral token's balance in Aave's own books, from the data provider's getUserReserveData). Null for an account
 * without Aave settings or without an address. If the chain can't be read, the account's own part still answers:
 * its transactions then show as `signed`, and `chain_error` says why.
 */
export async function evmView(deps: Deps, state: EvmStateView | null | undefined, config: unknown): Promise<{ evm: EvmView; held: EvmHeld[] } | null> {
  const aave = aaveConfOf(config);
  const address = addressOf(state);
  if (!aave || !address) return null;
  const own = evmStateOf(state);
  const tokens = [aave.usdc, ...aave.collateral];
  const view: EvmView = {
    address,
    nonce: own.nonce,
    chain_nonce: null,
    eth: null,
    wallet: [],
    posted: [],
    signed: own.signed.map((e) => ({ nonce: e.nonce, kind: e.kind, token: e.token, amount: e.amount, hash: e.hash, step: e.step, status: "signed" as EvmTxStatus })),
    chain_error: null,
  };
  let held: EvmHeld[] = [];
  if (!deps.evmChain) return { evm: { ...view, chain_error: "the backend has no connection to Aave's chain" }, held };
  try {
    if (aave.chainId !== deps.config.evmChainId) throw new EvmError(`the account's Aave settings name chain ${aave.chainId}, and the backend reads chain ${deps.config.evmChainId}`);
    const first = await ask(deps, [
      { method: "eth_getTransactionCount", params: [address, "latest"] },
      { method: "eth_getBalance", params: [address, "latest"] },
      ...tokens.map((t) => ethCall(t.address, callData(CALLS.balanceOf.selector, [address]))),
      ...aave.collateral.map((t) => ethCall(deps.config.aaveDataProvider, callData(CALLS.getUserReserveData.selector, [t.address, address]))),
    ]);
    const chainNonce = Number(quantity(first[0], "eth_getTransactionCount"));
    view.chain_nonce = chainNonce;
    view.eth = quantity(first[1], "eth_getBalance").toString();
    view.wallet = tokens.map((t, i) => ({ token: t.address, symbol: t.symbol, decimals: t.decimals, amount: word(first[2 + i], 0, `${t.symbol}'s balanceOf`).toString() }));
    held = aave.collateral
      .map((t, i) => ({ token: t.address, symbol: t.symbol, decimals: t.decimals, amount: word(first[2 + tokens.length + i], 0, `Aave's getUserReserveData for ${t.symbol}`).toString() }))
      .filter((h) => h.amount !== "0");
    view.posted = held;

    // Each transaction's status. One the chain has passed (its nonce is used) has a receipt, unless another
    // transaction took its nonce; one it hasn't is either in the node's hands or not sent yet.
    const cache = deps.evmStatuses;
    const open = view.signed.filter((e) => !cache?.has(e.hash));
    for (const e of view.signed) if (cache?.has(e.hash)) e.status = cache.get(e.hash)!;
    if (open.length) {
      const second = await ask(deps, open.map((e) => (e.nonce < chainNonce ? receipt(e.hash) : { method: "eth_getTransactionByHash", params: [e.hash] })));
      open.forEach((e, i) => {
        if (e.nonce < chainNonce) {
          const r = receiptOf(second[i]);
          e.status = r ? (r.ok ? "mined" : "failed") : "replaced";
          if (r) {
            if (cache && cache.size > 5_000) cache.clear();
            cache?.set(e.hash, e.status as "mined" | "failed");
          }
        } else {
          const known = second[i];
          e.status = known?.ok && known.result ? "sent" : "signed";
        }
      });
    }
  } catch (error) {
    view.chain_error = error instanceof Error ? error.message : String(error);
  }
  return { evm: view, held };
}

// ---------- GET /api/lenders: how much more of each collateral token Aave's test market can take ----------

export interface CollateralRoom {
  token: string;
  symbol: string;
  decimals: number;
  /** The token's own units; "0" when the supply cap is full; null when the token has no cap. */
  room: string | null;
}

/**
 * For each collateral token of the factory's Aave settings: its supply cap (getReserveCaps' second word, in whole
 * tokens; 0 means none) less what is supplied (getATokenTotalSupply, in the token's own units). Aave refuses a supply
 * that would pass the cap, so "0" here means that token can't be posted now. Empty when the factory has no Aave
 * settings yet.
 */
export async function collateralRoom(deps: Deps): Promise<CollateralRoom[]> {
  const factory = await soft(deps.chain.view<unknown>(deps.config.ids.factory, "get_config"));
  const aave = aaveConfOf(factory?.value);
  if (!aave || !aave.collateral.length || !deps.evmChain) return [];
  if (aave.chainId !== deps.config.evmChainId) throw new EvmError(`the factory's Aave settings name chain ${aave.chainId}, and the backend reads chain ${deps.config.evmChainId}`);
  const provider = deps.config.aaveDataProvider;
  const replies = await ask(
    deps,
    aave.collateral.flatMap((t) => [ethCall(provider, callData(CALLS.getReserveCaps.selector, [t.address])), ethCall(provider, callData(CALLS.getATokenTotalSupply.selector, [t.address]))]),
  );
  return aave.collateral.map((t, i) => {
    const cap = word(replies[2 * i], 1, `Aave's getReserveCaps for ${t.symbol}`);
    const supplied = word(replies[2 * i + 1], 0, `Aave's getATokenTotalSupply for ${t.symbol}`);
    const most = cap * 10n ** BigInt(t.decimals);
    return { token: t.address, symbol: t.symbol, decimals: t.decimals, room: cap === 0n ? null : (most > supplied ? most - supplied : 0n).toString() };
  });
}
