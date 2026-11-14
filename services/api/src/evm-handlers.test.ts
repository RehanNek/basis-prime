import assert from "node:assert/strict";
import { test } from "node:test";

import type { EvmRequest } from "./evm.js";
import { aaveConfOf, checkSigned, collateralRoom, evmStateOf, evmView, gasLimits, gasWalletOf, postEvmGas, postEvmSubmit, type EvmSignedEntry } from "./evm-handlers.js";
import { addressOfKey, bigBytes, CALLS, callData, decodeSignedTx, keyBytes, rlpEncode, signTx, type SignedTx } from "./evm-tx.js";
import { fakeChain, fakeDeps, fakeEvmChain, T0 } from "./fakes.js";
import { getLender, getLenders } from "./lenders.js";
import { RateLimiter } from "./limiter.js";
import { HttpError } from "./validate.js";

const ALICE = "alice.pbf.testnet";
const POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
const USDC = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
const WBTC = "0x54114591963CF60EF3aA63bEfD6eC263D98145a4";
const WETH = "0x4200000000000000000000000000000000000006";
const FAUCET = "0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc";
const PROVIDER = "0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b";
/** INTERFACES.md 24 and 33: the account's Aave settings on testnet. */
const AAVE = {
  chain_id: 84_532,
  pool: POOL,
  usdc: { symbol: "USDC", address: USDC, decimals: 6 },
  collateral: [
    { symbol: "WBTC", address: WBTC, decimals: 8 },
    { symbol: "WETH", address: WETH, decimals: 18 },
  ],
  max_fee_per_gas: "1000000000",
};
const CONFIG = { lenders: { aave: AAVE } };

/** Hardhat's first two test accounts, keys every Ethereum developer knows: one stands in for the account's signer, one for the gas wallet. */
const SIGNER = keyBytes("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "test");
const GAS_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ADDRESS = addressOfKey(SIGNER);
const GAS_ADDRESS = addressOfKey(keyBytes(GAS_KEY, "test"));
const MAX = (1n << 256n) - 1n;
const q = (value: bigint | number) => `0x${BigInt(value).toString(16)}`;
const words = (...values: bigint[]) => `0x${values.map((v) => v.toString(16).padStart(64, "0")).join("")}`;
const ETH = 10n ** 18n;

/** An entry of evm.signed, as the account would store it after the signer answered. */
function entry(nonce: number, kind: string, to: string, data: string, extra: { key?: Uint8Array; chainId?: bigint; value?: bigint; token?: string; amount?: string } = {}) {
  const signed = signTx({ chainId: extra.chainId ?? 84_532n, nonce: BigInt(nonce), maxPriorityFeePerGas: 1_000_000n, maxFeePerGas: 1_000_000_000n, gasLimit: 300_000n, to: to.toLowerCase(), value: extra.value ?? 0n, data }, extra.key ?? SIGNER);
  return { nonce, kind, token: extra.token ?? to, amount: extra.amount ?? "1500000", to, raw: signed.raw, hash: signed.hash, step: kind === "approve" ? null : `f5000:${nonce}`, signed_at: "1794400000000000000" };
}
const APPROVE = entry(0, "approve", WBTC, callData(CALLS.approve.selector, [POOL, MAX]), { amount: MAX.toString() });
const SUPPLY = entry(1, "supply", POOL, callData(CALLS.supply.selector, [WBTC, 1_500_000n, ADDRESS, 0n]), { token: WBTC });
const BORROW = entry(2, "borrow", POOL, callData(CALLS.borrow.selector, [USDC, 570_000_000n, 2n, 0n, ADDRESS]), { token: USDC, amount: "570000000" });

function near(signed: unknown[] = [APPROVE, SUPPLY, BORROW], overrides: Record<string, unknown> = {}) {
  return fakeChain({
    views: {
      [`${ALICE}.get_state`]: { hl: { address: ADDRESS }, evm: { nonce: signed.length, signed }, verdict: null },
      [`${ALICE}.get_config`]: CONFIG,
      "pbf.testnet.get_config": CONFIG,
      ...overrides,
    },
  }).chain;
}

const rejects = (status: number, code: string, message?: RegExp) => (error: unknown) => {
  assert.ok(error instanceof HttpError, String(error));
  assert.deepEqual([error.status, error.code], [status, code], error.message);
  if (message) assert.match(error.message, message);
  return true;
};

// ---------- POST /api/evm/submit ----------

test("POST /api/evm/submit reads the signed transaction from the chain, checks it, and sends it; the answer is sent, known or mined", async () => {
  const methods = (asked: EvmRequest[]) => asked.map((r) => r.method);
  // Not mined, and new to the node: sent.
  const fresh = fakeEvmChain((r) => (r.method === "eth_sendRawTransaction" ? SUPPLY.hash : null));
  const sent = await postEvmSubmit(fakeDeps({ chain: near(), evmChain: fresh.chain }).deps, { account: ALICE, nonce: 1 });
  assert.deepEqual(sent, { account: ALICE, nonce: 1, kind: "supply", hash: SUPPLY.hash, status: "sent" });
  assert.deepEqual(methods(fresh.asked), ["eth_getTransactionReceipt", "eth_sendRawTransaction"]);
  assert.deepEqual(fresh.asked[1]!.params, [SUPPLY.raw], "the raw bytes as the account stored them");

  // The node has it already: that is no error.
  for (const words of ["already known", "ALREADY_EXISTS: already known", "transaction already imported"]) {
    const known = fakeEvmChain((r) => (r.method === "eth_sendRawTransaction" ? { error: words } : null));
    assert.equal((await postEvmSubmit(fakeDeps({ chain: near(), evmChain: known.chain }).deps, { account: ALICE, nonce: 1 })).status, "known", words);
  }

  // Mined already: nothing is sent, and the answer says whether it reverted.
  const statuses = new Map<string, "mined" | "failed">();
  const mined = fakeEvmChain((r) => (r.method === "eth_getTransactionReceipt" ? { status: "0x1", blockNumber: "0x36ceed1" } : null));
  assert.deepEqual(await postEvmSubmit(fakeDeps({ chain: near(), evmChain: mined.chain, evmStatuses: statuses }).deps, { account: ALICE, nonce: 2 }), { account: ALICE, nonce: 2, kind: "borrow", hash: BORROW.hash, status: "mined", block: 57_470_673, reverted: false });
  assert.deepEqual(methods(mined.asked), ["eth_getTransactionReceipt"]);
  assert.equal(statuses.get(BORROW.hash), "mined");
  const reverted = fakeEvmChain((r) => (r.method === "eth_getTransactionReceipt" ? { status: "0x0", blockNumber: "0x10" } : null));
  assert.deepEqual((await postEvmSubmit(fakeDeps({ chain: near(), evmChain: reverted.chain }).deps, { account: ALICE, nonce: 2 })).reverted, true);

  // Mined between the two looks: the node says the nonce is used, and the receipt is there on the second look.
  let looks = 0;
  const raced = fakeEvmChain((r) => (r.method === "eth_sendRawTransaction" ? { error: "nonce too low: next nonce 3, tx nonce 2" } : (looks += 1) > 1 ? { status: "0x1", blockNumber: "0x11" } : null));
  assert.equal((await postEvmSubmit(fakeDeps({ chain: near(), evmChain: raced.chain }).deps, { account: ALICE, nonce: 2 })).status, "mined");
  // The nonce is used and this transaction has no receipt: another one took it.
  const taken = fakeEvmChain((r) => (r.method === "eth_sendRawTransaction" ? { error: "nonce too low" } : null));
  await assert.rejects(postEvmSubmit(fakeDeps({ chain: near(), evmChain: taken.chain }).deps, { account: ALICE, nonce: 2 }), rejects(409, "nonce_used", /already used nonce 2 with another transaction/));
  // Anything else the node says comes back in its own words.
  const poor = fakeEvmChain((r) => (r.method === "eth_sendRawTransaction" ? { error: "insufficient funds for gas * price + value: have 0 want 300000000000000" } : null));
  await assert.rejects(postEvmSubmit(fakeDeps({ chain: near(), evmChain: poor.chain }).deps, { account: ALICE, nonce: 1 }), rejects(502, "evm_refused", /refused the transaction: insufficient funds for gas \* price \+ value/));
});

test("POST /api/evm/submit sends the newest entry of a nonce, and says which nonces the account keeps when it has none", async () => {
  // A bump signed nonce 1 again with a higher tip: the later entry is the one to send.
  const bumped = { ...entry(1, "supply", POOL, callData(CALLS.supply.selector, [WBTC, 1_500_000n, ADDRESS, 0n]), { token: WBTC }) };
  const higher = signTx({ ...decodeSignedTx(bumped.raw), maxPriorityFeePerGas: 10_000_000n }, SIGNER);
  const chain = near([APPROVE, SUPPLY, { ...bumped, raw: higher.raw, hash: higher.hash }]);
  const evm = fakeEvmChain((r) => (r.method === "eth_sendRawTransaction" ? higher.hash : null));
  assert.equal((await postEvmSubmit(fakeDeps({ chain, evmChain: evm.chain }).deps, { account: ALICE, nonce: 1 })).hash, higher.hash);

  const none = fakeEvmChain(() => null);
  await assert.rejects(postEvmSubmit(fakeDeps({ chain: near(), evmChain: none.chain }).deps, { account: ALICE, nonce: 7 }), rejects(404, "no_entry", /no signed transaction with nonce 7 \(it keeps 0 to 2\)/));
  await assert.rejects(postEvmSubmit(fakeDeps({ chain: near([]), evmChain: none.chain }).deps, { account: ALICE, nonce: 0 }), rejects(404, "no_entry", /it has none yet/));
  assert.equal(none.asked.length, 0, "nothing was asked of Aave's chain");
});

test("POST /api/evm/submit refuses what an account may not send: a wrong hash, chain, receiver, call or signer, and anything that moves ETH", async () => {
  const none = fakeEvmChain(() => null);
  const submit = (signed: unknown[], nonce: number) => postEvmSubmit(fakeDeps({ chain: near(signed), evmChain: none.chain }).deps, { account: ALICE, nonce });
  const bad = (why: RegExp) => rejects(422, "bad_entry", why);
  await assert.rejects(submit([{ ...SUPPLY, hash: APPROVE.hash }], 1), bad(/doesn't hash to the hash stored with it/));
  await assert.rejects(submit([{ ...SUPPLY, nonce: 5 }], 5), bad(/carries nonce 1 inside/));
  await assert.rejects(submit([entry(0, "supply", POOL, callData(CALLS.supply.selector, [WBTC, 1n, ADDRESS, 0n]), { chainId: 8_453n })], 0), bad(/is for chain 8453.*sends on chain 84532 only/));
  await assert.rejects(submit([entry(0, "transfer", "0x1111111111111111111111111111111111111111", callData(CALLS.transfer.selector, [ADDRESS, 1n]))], 0), bad(/neither Aave's Pool nor a token of the account's Aave settings/));
  await assert.rejects(submit([entry(0, "supply", POOL, callData(CALLS.approve.selector, [POOL, MAX]))], 0), bad(/calls Aave's Pool with something other than supply, borrow, repay or withdraw/));
  await assert.rejects(submit([entry(0, "approve", WBTC, callData(CALLS.mint.selector, [WBTC, ADDRESS, 1n]))], 0), bad(/calls a token with something other than approve or transfer/));
  await assert.rejects(submit([entry(0, "approve", WETH, CALLS.deposit.selector, { value: 5n })], 0), bad(/moves ETH/));
  await assert.rejects(submit([entry(0, "approve", WBTC, callData(CALLS.approve.selector, [POOL, MAX]), { key: keyBytes(GAS_KEY, "test") })], 0), bad(new RegExp(`was signed by ${GAS_ADDRESS}, not by the account's address ${ADDRESS}`)));
  await assert.rejects(submit([{ ...SUPPLY, raw: "0x02c0" }], 1), bad(/can't be read: the transaction doesn't have a type 2 transaction's 12 fields/));
  assert.equal(none.asked.length, 0, "none of them reached the chain");

  // What isn't a client account of our factory, a bad nonce, an account without Aave settings, and a node on another chain.
  const deps = fakeDeps({ chain: near(), evmChain: none.chain }).deps;
  await assert.rejects(postEvmSubmit(deps, { account: "alice.testnet", nonce: 1 }), rejects(400, "bad_request", /client account/));
  await assert.rejects(postEvmSubmit(deps, { account: ALICE, nonce: "1" }), rejects(400, "bad_request", /nonce must be/));
  await assert.rejects(postEvmSubmit(fakeDeps({ chain: near() }).deps, { account: ALICE, nonce: 1 }), rejects(503, "evm_off"));
  await assert.rejects(postEvmSubmit(fakeDeps({ chain: near([SUPPLY], { [`${ALICE}.get_config`]: { lenders: {} } }), evmChain: none.chain }).deps, { account: ALICE, nonce: 1 }), rejects(409, "no_aave"));
  await assert.rejects(postEvmSubmit(fakeDeps({ chain: fakeChain({}).chain, evmChain: none.chain }).deps, { account: ALICE, nonce: 1 }), rejects(404, "not_deployed"));
  const mainnet = fakeEvmChain(() => null, 8_453);
  await assert.rejects(postEvmSubmit(fakeDeps({ chain: near(), evmChain: mainnet.chain }).deps, { account: ALICE, nonce: 1 }), /EVM_RPC_URL answers for chain 8453 but EVM_CHAIN_ID is 84532/);
  assert.ok(!mainnet.asked.some((r) => r.method === "eth_sendRawTransaction"), "nothing is sent to a node on another chain");
  const limited = fakeDeps({ chain: near(), evmChain: none.chain }).deps;
  limited.limits.evmSubmits = new RateLimiter(1, 60_000, () => T0);
  await postEvmSubmit(limited, { account: ALICE, nonce: 1 }).catch(() => undefined);
  await assert.rejects(postEvmSubmit(limited, { account: ALICE, nonce: 1 }), rejects(429, "too_many_submits"));
});

test("a transaction the chain really mined passes the same checks: the gas wallet's approve of WETH on Base Sepolia, 11 Nov", () => {
  // research/data/aave_spike_weth.json, step "approve WETH"; evm-tx.test.ts builds the same bytes from its fields.
  const from = (text: string) => Uint8Array.from(Buffer.from(text.slice(2), "hex"));
  const data = "0x095ea7b30000000000000000000000008bab6d1b75f19e9ed9fce8b9bd338844ff79ae27ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  const body = rlpEncode([bigBytes(84_532n), bigBytes(4n), bigBytes(0xf4240n), bigBytes(0x3b9aca00n), bigBytes(0x111c9n), from(WETH), bigBytes(0n), from(data), [], bigBytes(0n), from("0x36261f3cc07367f7574f7b54ad17a314ab20f5b667d6ada3631ac5741c162137"), from("0x4b16bda1bf4738f935f800e233ac6cb35b42e0d77fb6099a7766f3fb9d80073c")]);
  const raw = `0x02${Buffer.from(body).toString("hex")}`;
  const mined: EvmSignedEntry = { nonce: 4, kind: "approve", token: WETH, amount: null, raw, hash: "0x0e2cf3dceedd2056511fd28405dc5977e306aa9089be0954238fdef4765fd77d", step: null };
  const tx = checkSigned(mined, aaveConfOf(CONFIG)!, 84_532, "0x2031181d63507368232579af4c64a1c3428407ff");
  assert.deepEqual([tx.to, tx.nonce, tx.maxFeePerGas], [WETH, 4n, 1_000_000_000n]);
  assert.throws(() => checkSigned(mined, aaveConfOf(CONFIG)!, 84_532, ADDRESS), /was signed by 0x2031181d63507368232579af4c64a1c3428407ff, not by the account's address/);
});

// ---------- POST /api/evm/gas ----------

/** Aave's chain for the gas helper: balances, the wallet's nonce, fees, and receipts that come after `minedAfter` looks. */
function gasWorld(options: { balance?: bigint; wallet?: bigint; baseFee?: bigint; estimate?: unknown; minedAfter?: number; refuse?: (tx: SignedTx) => string | null } = {}) {
  const sent: SignedTx[] = [];
  let looks = 0;
  let now = T0;
  const evm = fakeEvmChain((r) => {
    switch (r.method) {
      case "eth_getBalance":
        return q(r.params[0] === GAS_ADDRESS ? (options.wallet ?? ETH / 20n) : (options.balance ?? 0n) + sent.filter((t) => t.to === r.params[0]).reduce((sum, t) => sum + t.value, 0n));
      case "eth_getTransactionCount":
        return q(11 + sent.length);
      case "eth_getBlockByNumber":
        return { baseFeePerGas: q(options.baseFee ?? 5_000_000n) };
      case "eth_maxPriorityFeePerGas":
        return q(1_000_000);
      case "eth_estimateGas":
        return options.estimate ?? q(87_902);
      case "eth_sendRawTransaction": {
        const tx = decodeSignedTx(String(r.params[0]));
        const refusal = options.refuse?.(tx);
        if (refusal) return { error: refusal };
        sent.push(tx);
        return tx.hash;
      }
      case "eth_getTransactionReceipt":
        return (looks += 1) > (options.minedAfter ?? 0) ? { status: "0x1", blockNumber: "0x20" } : null;
      default:
        throw new Error(`unexpected ${r.method}`);
    }
  });
  const sleeps: number[] = [];
  const deps = fakeDeps({
    chain: near(),
    evmChain: evm.chain,
    gasWallet: gasWalletOf(GAS_KEY),
    gasLimits: gasLimits(() => now),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  }).deps;
  return { deps, sent, asked: evm.asked, sleeps, tick: (ms: number) => (now += ms) };
}

test("POST /api/evm/gas brings an address that holds under 0.001 test ETH up to 0.002, from the gas wallet, and leaves a funded one alone", async () => {
  const w = gasWorld({ balance: 300_000_000_000_000n, minedAfter: 2 });
  const answer = await postEvmGas(w.deps, { account: ALICE });
  assert.equal(w.sent.length, 1);
  const tx = w.sent[0]!;
  assert.deepEqual(
    { from: tx.from, to: tx.to, value: tx.value, data: tx.data, nonce: tx.nonce, chainId: tx.chainId, gasLimit: tx.gasLimit, tip: tx.maxPriorityFeePerGas, maxFee: tx.maxFeePerGas },
    // 0.002 less the 0.0003 it holds; twice the base fee plus the tip.
    { from: GAS_ADDRESS, to: ADDRESS, value: 1_700_000_000_000_000n, data: "0x", nonce: 11n, chainId: 84_532n, gasLimit: 21_000n, tip: 1_000_000n, maxFee: 11_000_000n },
  );
  assert.deepEqual(answer, {
    account: ALICE,
    address: ADDRESS,
    eth: { balance: "2000000000000000", sent: "1700000000000000", hash: tx.hash, mined: true, ok: true },
    mint: null,
    wrap: null,
    gas_wallet: GAS_ADDRESS,
  });
  assert.deepEqual(w.sleeps, [1_000, 1_000, 1_000], "it looked for the receipt a second apart until it was there");

  // 0.001 or more is enough for two transactions at the fee limit: nothing is sent, and no top-up is used up.
  const funded = gasWorld({ balance: 1_000_000_000_000_000n });
  assert.deepEqual(await postEvmGas(funded.deps, { account: ALICE }), { account: ALICE, address: ADDRESS, eth: { balance: "1000000000000000", sent: "0", hash: null }, mint: null, wrap: null, gas_wallet: GAS_ADDRESS });
  assert.equal(funded.sent.length, 0);

  // A transaction that isn't mined within 20 s: the answer says so, and gives the balance as it stands.
  const slow = gasWorld({ minedAfter: 1_000 });
  const pending = await postEvmGas(slow.deps, { account: ALICE });
  assert.deepEqual([pending.eth.sent, (pending.eth as { mined?: boolean }).mined, slow.sleeps.length], ["2000000000000000", false, 20]);
});

test("POST /api/evm/gas with mint calls Aave's faucet for a token of the account's settings, once an hour for an address and token", async () => {
  const w = gasWorld({ balance: 2_000_000_000_000_000n });
  const answer = await postEvmGas(w.deps, { account: ALICE, mint: { token: WBTC, amount: "1500000" } });
  assert.equal(w.sent.length, 1);
  const tx = w.sent[0]!;
  assert.deepEqual([tx.to, tx.value, tx.gasLimit, tx.data], [FAUCET.toLowerCase(), 0n, 131_853n, callData(CALLS.mint.selector, [WBTC, ADDRESS, 1_500_000n])], "mint(token, address, amount), with half as much gas again as the node's estimate");
  assert.deepEqual(answer.mint, { token: WBTC.toLowerCase(), symbol: "WBTC", amount: "1500000", hash: tx.hash, mined: true, ok: true });
  const estimate = w.asked.find((r) => r.method === "eth_estimateGas")!;
  assert.deepEqual(estimate.params, [{ from: GAS_ADDRESS, to: FAUCET, data: tx.data }]);

  // The same token again within the hour is refused before anything is sent; another token, and the next hour, go through.
  await assert.rejects(postEvmGas(w.deps, { account: ALICE, mint: { token: WBTC, amount: "1" } }), rejects(429, "too_many_mints", /once an hour/));
  assert.equal((await postEvmGas(w.deps, { account: ALICE, mint: { token: USDC, amount: "1000000000000" } })).mint?.symbol, "USDC");
  w.tick(60 * 60_000);
  assert.equal((await postEvmGas(w.deps, { account: ALICE, mint: { token: WBTC.toLowerCase(), amount: "100000000" } })).mint?.amount, "100000000");
  assert.equal(w.sent.length, 3);

  // The faucet's own limits, and what isn't a token of the settings.
  const fresh = () => gasWorld({ balance: 2_000_000_000_000_000n });
  await assert.rejects(postEvmGas(fresh().deps, { account: ALICE, mint: { token: WBTC, amount: "100000001" } }), rejects(400, "bad_request", /at most 1 WBTC in one call/));
  await assert.rejects(postEvmGas(fresh().deps, { account: ALICE, mint: { token: USDC, amount: "1000000000001" } }), rejects(400, "bad_request", /at most 1,000,000 USDC/));
  await assert.rejects(postEvmGas(fresh().deps, { account: ALICE, mint: { token: FAUCET, amount: "1" } }), rejects(400, "bad_request", /isn't a token of the account's Aave settings \(USDC, WBTC, WETH\)/));
  await assert.rejects(postEvmGas(fresh().deps, { account: ALICE, mint: { token: WBTC, amount: "0" } }), rejects(400, "bad_request", /mint\.amount/));
  // A faucet that would refuse says so when the node runs the call: nothing is sent, and the hour isn't used up.
  const refused = gasWorld({ balance: 2_000_000_000_000_000n, estimate: { error: "execution reverted" } });
  await assert.rejects(postEvmGas(refused.deps, { account: ALICE, mint: { token: WBTC, amount: "1" } }), rejects(409, "faucet_refused", /wouldn't mint 1 units of WBTC.*execution reverted/));
  assert.equal(refused.sent.length, 0);
});

test("POST /api/evm/gas with wrap turns the gas wallet's own test ETH into WETH and sends it to the address, within 0.02 ETH a day for an account", async () => {
  const w = gasWorld({ wallet: ETH / 20n });
  const answer = await postEvmGas(w.deps, { account: ALICE, wrap: { amount: "20000000000000000" } });
  // The top-up, WETH's deposit() with the ETH, then the WETH's transfer to the address: three nonces in a row.
  assert.deepEqual(
    w.sent.map((t) => [t.nonce, t.to, t.value, t.data]),
    [
      [11n, ADDRESS, 2_000_000_000_000_000n, "0x"],
      [12n, WETH, 20_000_000_000_000_000n, "0xd0e30db0"],
      [13n, WETH, 0n, callData(CALLS.transfer.selector, [ADDRESS, 20_000_000_000_000_000n])],
    ],
  );
  assert.deepEqual(answer.wrap, { token: WETH, symbol: "WETH", amount: "20000000000000000", hash: w.sent[2]!.hash, deposit_hash: w.sent[1]!.hash, mined: true, ok: true });
  // The day's 0.02 ETH is used: more waits for tomorrow.
  await assert.rejects(postEvmGas(w.deps, { account: ALICE, wrap: { amount: "1" } }), rejects(429, "wrap_budget", /0\.02 ETH wrapped for it in a day, and 0 ETH of that is left/));
  w.tick(24 * 60 * 60_000);
  assert.equal((await postEvmGas(w.deps, { account: ALICE, wrap: { amount: "1000" } })).wrap?.amount, "1000");

  // Never so much that the gas wallet is left with under 0.01 ETH; and never more than 0.02 at once.
  const thin = gasWorld({ balance: 2_000_000_000_000_000n, wallet: 25_000_000_000_000_000n });
  await assert.rejects(postEvmGas(thin.deps, { account: ALICE, wrap: { amount: "20000000000000000" } }), rejects(503, "gas_wallet_low", /would leave the gas wallet .* with under 0\.01 ETH; it holds 0\.025 ETH/));
  assert.equal((await postEvmGas(thin.deps, { account: ALICE, wrap: { amount: "10000000000000000" } })).wrap?.amount, "10000000000000000");
  await assert.rejects(postEvmGas(gasWorld().deps, { account: ALICE, wrap: { amount: "20000000000000001" } }), rejects(400, "bad_request", /at most 0\.02 ETH/));
  assert.equal(thin.sent.length, 2);
});

test("POST /api/evm/gas keeps to its limits: three top-ups a day for an account, 0.02 ETH of top-ups a day in all, and a wallet that can pay", async () => {
  // An address that is emptied again and again: the fourth top-up of the day is refused.
  const w = gasWorld({ balance: 0n });
  const empty = () => w.sent.splice(0); // the fake counts what was sent as the address's balance
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await postEvmGas(w.deps, { account: ALICE })).eth.sent, "2000000000000000");
    empty();
  }
  await assert.rejects(postEvmGas(w.deps, { account: ALICE }), rejects(429, "too_many_top_ups", /has had its 3 gas top-ups for today/));
  w.tick(24 * 60 * 60_000);
  assert.equal((await postEvmGas(w.deps, { account: ALICE })).eth.sent, "2000000000000000");

  // Ten accounts take the day's 0.02 ETH between them; the eleventh waits.
  const accounts = Array.from({ length: 11 }, (_, i) => `c${i}.pbf.testnet`);
  const views = Object.fromEntries(accounts.flatMap((a, i) => [[`${a}.get_state`, { hl: { address: `0x${String(i + 1).padStart(40, "0")}` }, evm: { nonce: 0, signed: [] } }], [`${a}.get_config`, CONFIG]]));
  const many = gasWorld();
  many.deps.chain = fakeChain({ views }).chain;
  for (const a of accounts.slice(0, 10)) assert.equal((await postEvmGas(many.deps, { account: a })).eth.sent, "2000000000000000");
  await assert.rejects(postEvmGas(many.deps, { account: accounts[10] }), rejects(429, "gas_budget", /has sent its 0\.02 ETH for today/));

  // A gas wallet that holds too little, a chain where gas is dear, and a helper with no key.
  await assert.rejects(postEvmGas(gasWorld({ wallet: 1_000_000_000_000_000n }).deps, { account: ALICE }), rejects(503, "gas_wallet_low", /holds 0\.001 ETH, less than/));
  await assert.rejects(postEvmGas(gasWorld({ baseFee: 3_000_000_000n }).deps, { account: ALICE }), rejects(503, "gas_dear", /above what the gas helper pays \(5 gwei\)/));
  await assert.rejects(postEvmGas(fakeDeps({ chain: near(), evmChain: fakeEvmChain(() => null).chain }).deps, { account: ALICE }), rejects(503, "gas_off", /EVM_GAS_PRIVATE_KEY is empty/));
});

test("POST /api/evm/gas serves only our factory's accounts that can use Aave, and says what went out when the node refuses a later part", async () => {
  const w = gasWorld();
  await assert.rejects(postEvmGas(w.deps, { account: "alice.testnet" }), rejects(400, "bad_request", /client account, <name>\.pbf\.testnet/));
  await assert.rejects(postEvmGas(w.deps, { account: "alice.other.testnet" }), rejects(400, "bad_request"));
  await assert.rejects(postEvmGas(w.deps, { account: "ghost.pbf.testnet" }), rejects(404, "not_deployed"));
  w.deps.chain = near([], { [`${ALICE}.get_config`]: { lenders: { rhea: { contract_id: "rhea.pbf-ops.testnet" } } } });
  await assert.rejects(postEvmGas(w.deps, { account: ALICE }), rejects(409, "no_aave", /has no settings for Aave/));
  w.deps.chain = near([], { [`${ALICE}.get_state`]: { hl: { address: null }, evm: { nonce: 0, signed: [] } } });
  await assert.rejects(postEvmGas(w.deps, { account: ALICE }), rejects(409, "no_address"));
  w.deps.chain = near([], { [`${ALICE}.get_config`]: { lenders: { aave: { ...AAVE, chain_id: 8_453 } } } });
  await assert.rejects(postEvmGas(w.deps, { account: ALICE }), rejects(409, "wrong_chain"));
  w.deps.chain = near([], { [`${ALICE}.get_config`]: { lenders: { aave: { ...AAVE, collateral: [AAVE.collateral[0]] } } } });
  await assert.rejects(postEvmGas(w.deps, { account: ALICE, wrap: { amount: "5" } }), rejects(400, "bad_request", /list no WETH/));
  assert.equal(w.sent.length, 0);

  // The top-up goes out, then the node refuses the mint: the answer names what was sent.
  const half = gasWorld({ refuse: (tx) => (tx.to === FAUCET.toLowerCase() ? "replacement transaction underpriced" : null) });
  await assert.rejects(postEvmGas(half.deps, { account: ALICE, mint: { token: WBTC, amount: "5" } }), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, "evm_refused");
    assert.equal(error.message, `The chain's node refused the mint of WBTC: replacement transaction underpriced. Already sent: the top-up of 0.002 ETH (${half.sent[0]!.hash})`);
    return true;
  });

  // Two requests at once never share a nonce: the wallet takes them one at a time.
  const both = gasWorld();
  const views = { "a.pbf.testnet.get_state": { hl: { address: `0x${"a".repeat(40)}` } }, "a.pbf.testnet.get_config": CONFIG, "b.pbf.testnet.get_state": { hl: { address: `0x${"b".repeat(40)}` } }, "b.pbf.testnet.get_config": CONFIG };
  both.deps.chain = fakeChain({ views }).chain;
  await Promise.all([postEvmGas(both.deps, { account: "a.pbf.testnet" }), postEvmGas(both.deps, { account: "b.pbf.testnet" })]);
  assert.deepEqual(both.sent.map((t) => t.nonce), [11n, 12n]);

  // GET /api/evm/gas: the helper's state, with the wallet's balance read from the chain.
  const { getEvmGas } = await import("./evm-handlers.js");
  const on = await getEvmGas(gasWorld({ wallet: 49_000_000_000_000_000n }).deps);
  assert.deepEqual([on.on, on.gas_wallet, on.balance, on.chain_id, on.wrap_per_account_per_day, on.wallet_reserve], [true, GAS_ADDRESS, "49000000000000000", 84_532, "20000000000000000", "10000000000000000"]);

  // The key never shows: a key that can't be read is refused in words without it.
  assert.throws(() => gasWalletOf("0xnot-a-key-1234"), (e: unknown) => e instanceof Error && e.message === "EVM_GAS_PRIVATE_KEY isn't a 32-byte key in hex (64 hex digits)");
  assert.ok(!JSON.stringify(gasWalletOf(GAS_KEY)).includes(GAS_KEY.slice(2)));
});

// ---------- GET /api/lender/:account's `evm`, and GET /api/lenders' collateral_room ----------

/** Aave's chain as the lender page reads it. `mined` are hashes with a receipt (true: it went through); `pooled` are in the node's hands. */
function lenderChain(options: { chainNonce: number; mined?: Record<string, boolean>; pooled?: string[]; posted?: Record<string, bigint>; caps?: Record<string, [bigint, bigint]> }) {
  return fakeEvmChain((r) => {
    if (r.method === "eth_getTransactionCount") return q(options.chainNonce);
    if (r.method === "eth_getBalance") return q(1_999_000_000_000_000n);
    if (r.method === "eth_getTransactionReceipt") {
      const ok = options.mined?.[String(r.params[0])];
      return ok === undefined ? null : { status: ok ? "0x1" : "0x0", blockNumber: "0x30" };
    }
    if (r.method === "eth_getTransactionByHash") return options.pooled?.includes(String(r.params[0])) ? { hash: r.params[0] } : null;
    if (r.method !== "eth_call") throw new Error(`unexpected ${r.method}`);
    const { to, data } = r.params[0] as { to: string; data: string };
    const selector = data.slice(0, 10);
    const asset = `0x${data.slice(34, 74)}`;
    if (selector === CALLS.balanceOf.selector) return words(to === USDC.toLowerCase() ? 570_000_000n : to === WETH ? 0n : 25_000n);
    if (to === PROVIDER && selector === CALLS.getUserReserveData.selector) return words(options.posted?.[asset] ?? 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 1n);
    if (to === PROVIDER && selector === CALLS.getReserveCaps.selector) return words(...(options.caps?.[asset] ?? [0n, 0n]));
    if (to === PROVIDER && selector === CALLS.getATokenTotalSupply.selector) return words(asset === WBTC.toLowerCase() ? 17_500_000_000n : 1_735_928_721_774_289_028_571n);
    throw new Error(`unexpected eth_call to ${to}`);
  });
}

test("GET /api/lender/:account's evm: the address, its nonces, its test ETH, the tokens it holds, and each signed transaction's status from the chain", async () => {
  const replaced = entry(3, "repay", POOL, callData(CALLS.repay.selector, [USDC, 5n, 2n, ADDRESS]), { token: USDC, amount: "5" });
  const waiting = entry(5, "withdraw", POOL, callData(CALLS.withdraw.selector, [WBTC, 5n, ADDRESS]), { token: WBTC, amount: "5" });
  const pooled = entry(4, "repay", POOL, callData(CALLS.repay.selector, [USDC, 6n, 2n, ADDRESS]), { token: USDC, amount: "6" });
  const signed = [APPROVE, SUPPLY, BORROW, replaced, pooled, waiting];
  const evm = lenderChain({ chainNonce: 4, mined: { [APPROVE.hash]: true, [SUPPLY.hash]: true, [BORROW.hash]: false }, pooled: [pooled.hash], posted: { [WBTC.toLowerCase()]: 1_500_000n } });
  const statuses = new Map<string, "mined" | "failed">();
  const deps = fakeDeps({ chain: near(signed), evmChain: evm.chain, evmStatuses: statuses }).deps;
  const view = await evmView(deps, { hl: { address: ADDRESS }, evm: { nonce: 6, signed } }, CONFIG);
  assert.deepEqual(view, {
    evm: {
      address: ADDRESS,
      nonce: 6,
      chain_nonce: 4,
      eth: "1999000000000000",
      wallet: [
        { token: USDC.toLowerCase(), symbol: "USDC", decimals: 6, amount: "570000000" },
        { token: WBTC.toLowerCase(), symbol: "WBTC", decimals: 8, amount: "25000" },
        { token: WETH, symbol: "WETH", decimals: 18, amount: "0" },
      ],
      posted: [{ token: WBTC.toLowerCase(), symbol: "WBTC", decimals: 8, amount: "1500000" }],
      signed: [
        { nonce: 0, kind: "approve", token: WBTC.toLowerCase(), amount: MAX.toString(), hash: APPROVE.hash, step: null, status: "mined" },
        // `step` says which plan step signed it, as the account's state has it; an approval is no step.
        { nonce: 1, kind: "supply", token: WBTC.toLowerCase(), amount: "1500000", hash: SUPPLY.hash, step: "f5000:1", status: "mined" },
        // Mined and reverted.
        { nonce: 2, kind: "borrow", token: USDC.toLowerCase(), amount: "570000000", hash: BORROW.hash, step: "f5000:2", status: "failed" },
        // The chain has used nonce 3 and this transaction has no receipt: another one took its nonce.
        { nonce: 3, kind: "repay", token: USDC.toLowerCase(), amount: "5", hash: replaced.hash, step: "f5000:3", status: "replaced" },
        { nonce: 4, kind: "repay", token: USDC.toLowerCase(), amount: "6", hash: pooled.hash, step: "f5000:4", status: "sent" },
        { nonce: 5, kind: "withdraw", token: WBTC.toLowerCase(), amount: "5", hash: waiting.hash, step: "f5000:5", status: "signed" },
      ],
      chain_error: null,
    },
    // What Aave's own books say is posted: WBTC, and no WETH.
    held: [{ token: WBTC.toLowerCase(), symbol: "WBTC", decimals: 8, amount: "1500000" }],
  });
  // A mined transaction's status is kept: the next read asks about the three that could still change.
  assert.deepEqual([...statuses.values()], ["mined", "mined", "failed"]);
  evm.asked.length = 0;
  await evmView(deps, { hl: { address: ADDRESS }, evm: { nonce: 6, signed } }, CONFIG);
  assert.equal(evm.asked.filter((r) => r.method === "eth_getTransactionReceipt" || r.method === "eth_getTransactionByHash").length, 3);

  // Through the route: Aave's entry carries `held`, and `evm` sits beside the lenders.
  const ext = [{ l: "aave", c: 1_100_000_000, d: 570_000_000, hf_bp: 15_900, r_bp: 74, s_bp: 9, room: 0, liq_bp: 8_300 }];
  const chain = near(signed, { [`${ALICE}.get_state`]: { hl: { address: ADDRESS }, evm: { nonce: 6, signed }, verdict: { verdict: { blk: 9, ext } } } });
  const answer = await getLender(fakeDeps({ chain, evmChain: evm.chain }).deps, ALICE);
  assert.deepEqual(answer.lenders.map((l) => [l.l, l.held]), [["aave", [{ token: WBTC.toLowerCase(), symbol: "WBTC", decimals: 8, amount: "1500000" }]]]);
  assert.deepEqual([answer.evm?.address, answer.evm?.chain_nonce, answer.evm?.signed.length], [ADDRESS, 4, 6]);
});

test("GET /api/lender/:account's evm when Aave's chain can't be read: the account's own part stands, every transaction shows as signed, and it says why", async () => {
  const state = { hl: { address: ADDRESS }, evm: { nonce: 1, signed: [APPROVE] } };
  const down = fakeEvmChain(() => ({ error: "over rate limit" }));
  const view = await evmView(fakeDeps({ evmChain: down.chain }).deps, state, CONFIG);
  assert.deepEqual(view, {
    evm: { address: ADDRESS, nonce: 1, chain_nonce: null, eth: null, wallet: [], posted: [], signed: [{ nonce: 0, kind: "approve", token: WBTC.toLowerCase(), amount: MAX.toString(), hash: APPROVE.hash, step: null, status: "signed" }], chain_error: "eth_getTransactionCount failed: over rate limit" },
    held: [],
  });
  assert.match((await evmView(fakeDeps({ evmChain: fakeEvmChain(() => null, 1).chain }).deps, state, CONFIG))!.evm.chain_error!, /answers for chain 1 but EVM_CHAIN_ID is 84532/);
  assert.equal((await evmView(fakeDeps({}).deps, state, CONFIG))!.evm.chain_error, "the backend has no connection to Aave's chain");
  // No Aave settings, or no address yet: no `evm` at all.
  assert.equal(await evmView(fakeDeps({ evmChain: down.chain }).deps, state, { lenders: { rhea: {} } }), null);
  assert.equal(await evmView(fakeDeps({ evmChain: down.chain }).deps, { hl: { address: null } }, CONFIG), null);
  // Entries that aren't signed transactions are dropped, and a missing nonce is null.
  assert.deepEqual(evmStateOf({ evm: { signed: [null, { nonce: "1" }, { nonce: 1, raw: "0x02", hash: "0x12" }] } }), { nonce: null, signed: [] });
});

test("GET /api/lenders: the testnet Aave row says how much more of each collateral token Aave can take: 0 when the cap is full, null with no cap", async () => {
  // Read on Base Sepolia on 11 Nov: WBTC's cap is 175 and 175 are supplied; WETH's is 2,500 with 1,735.93 supplied.
  const caps = { [WBTC.toLowerCase()]: [50n, 175n] as [bigint, bigint], [WETH]: [1_200n, 2_500n] as [bigint, bigint] };
  const evm = lenderChain({ chainNonce: 0, caps });
  const deps = fakeDeps({ chain: near(), evmChain: evm.chain }).deps;
  assert.deepEqual(await collateralRoom(deps), [
    { token: WBTC.toLowerCase(), symbol: "WBTC", decimals: 8, room: "0" },
    { token: WETH, symbol: "WETH", decimals: 18, room: "764071278225710971429" },
  ]);
  // A token with no cap (the provider answers 0), and a factory without Aave settings.
  assert.deepEqual((await collateralRoom(fakeDeps({ chain: near(), evmChain: lenderChain({ chainNonce: 0 }).chain }).deps)).map((r) => r.room), [null, null]);
  assert.deepEqual(await collateralRoom(fakeDeps({ chain: fakeChain({ views: { "pbf.testnet.get_config": { lenders: {} } } }).chain, evmChain: evm.chain }).deps), []);

  // In the row itself, beside the terms the data provider gave.
  const terms = [
    words(0n, 0n, 51_859_252_766_568n, 0n, 7_152_228_230_247n, 911_669_480_384_519_912_838_080n, 7_350_160_413_001_912_115_431_107n, 0n, 0n, 0n, 0n, 0n),
    words(8n, 8_150n, 8_300n, 10_500n, 1_000n, 1n, 0n, 0n, 1n, 0n),
    words(44_744_893_737_579n),
  ];
  const reader = { calls: async () => ({ chainId: 84_532, results: terms }) };
  const answer = await getLenders(fakeDeps({ chain: near(), evm: reader, evmChain: evm.chain }).deps);
  const row = answer.lenders.find((l) => l.l === "aave" && l.network === "testnet")!;
  assert.deepEqual(row.collateral_room?.map((r) => [r.symbol, r.room]), [["WBTC", "0"], ["WETH", "764071278225710971429"]]);
  assert.equal(row.ltv_bp, 8_150);
});

test("stage 4: the gas wallet shares its key with the stand-in's float, so it reads the pending nonce before each signature and signs again when the node says that nonce is taken", async () => {
  // The float's transaction takes nonce 11 between the wallet's read and its send: the node refuses the wallet's once.
  let refusals = 0;
  const w = gasWorld({ refuse: () => ((refusals += 1) === 1 ? "nonce too low: next nonce 12, tx nonce 11" : null) });
  const answer = await postEvmGas(w.deps, { account: ALICE });
  assert.equal(w.sent.length, 1);
  assert.deepEqual([w.sent[0]!.nonce, answer.eth.hash], [12n, w.sent[0]!.hash], "signed again with the next nonce, and that is the one that went out");
  const methods = w.asked.map((r) => r.method);
  const firstSend = methods.indexOf("eth_sendRawTransaction");
  assert.equal(methods[firstSend - 1], "eth_getTransactionCount", "the nonce was read right before the signature");
  assert.equal(methods.filter((m) => m === "eth_sendRawTransaction").length, 2);
  assert.deepEqual(w.asked.filter((r) => r.method === "eth_getTransactionCount").at(-1)!.params, [GAS_ADDRESS, "pending"]);

  // The same when another transaction waits with that nonce; a node that keeps saying so ends in its own words.
  let waits = 0;
  const waiting = gasWorld({ refuse: () => ((waits += 1) <= 2 ? "replacement transaction underpriced" : null) });
  await postEvmGas(waiting.deps, { account: ALICE });
  assert.deepEqual(waiting.sent.map((t) => t.nonce), [13n]);
  const stuck = gasWorld({ refuse: () => "nonce too low" });
  await assert.rejects(postEvmGas(stuck.deps, { account: ALICE }), rejects(502, "evm_refused", /refused the top-up of 0\.002 ETH: nonce too low\. Nothing was sent/));
  assert.equal(stuck.asked.filter((r) => r.method === "eth_sendRawTransaction").length, 4, "four tries, no more");
});
