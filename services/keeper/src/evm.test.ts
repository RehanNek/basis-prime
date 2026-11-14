// Stage 3: Aave's chain as the keeper reads it and sends to it. The node and the backend here are fakes.
import assert from "node:assert/strict";
import { test } from "node:test";

import { BASE_SEPOLIA_CHAIN_ID, keeperConfig } from "./config.js";
import { aaveSettings, ALLOWANCE_SELECTOR, backendSubmit, EvmHttp, EvmSender, pendingAave, rawFields, readEvm, RESEND_MS, sendProblem, type EvmSigned, type SendAnswer } from "./evm.js";

const POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
const USDC = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
const WBTC = "0x54114591963CF60EF3aA63bEfD6eC263D98145a4";
const WETH = "0x4200000000000000000000000000000000000006";
const ADDRESS = "0x2031181d63507368232579af4c64a1c3428407ff";
const CONFIG = {
  lenders: {
    aave: {
      chain_id: 84_532,
      pool: POOL,
      usdc: { symbol: "USDC", address: USDC, decimals: 6 },
      collateral: [
        { symbol: "WBTC", address: WBTC, decimals: 8 },
        { symbol: "WETH", address: WETH, decimals: 18 },
      ],
      max_fee_per_gas: "1000000000",
    },
  },
};
const AAVE = aaveSettings(CONFIG)!;

/**
 * A transaction Base Sepolia really mined on 11 Nov: the gas wallet's approve(pool, max) on WETH (research/data/
 * aave_spike_weth.json). The backend's tests check these same bytes hash to MINED_HASH and lead back to ADDRESS.
 */
const MINED =
  "0x02f8b283014a3404830f4240843b9aca00830111c994420000000000000000000000000000000000000680b844095ea7b30000000000000000000000008bab6d1b75f19e9ed9fce8b9bd338844ff79ae27ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc080a036261f3cc07367f7574f7b54ad17a314ab20f5b667d6ada3631ac5741c162137a04b16bda1bf4738f935f800e233ac6cb35b42e0d77fb6099a7766f3fb9d80073c";
const MINED_HASH = "0x0e2cf3dceedd2056511fd28405dc5977e306aa9089be0954238fdef4765fd77d";

// A small RLP writer, for transactions with other fields. The keeper reads a transaction's fields and never its
// signature (it has no Keccak), so r and s here are filler.
type Item = Uint8Array | Item[];
const num = (v: bigint): Uint8Array => (v === 0n ? new Uint8Array(0) : Uint8Array.from(Buffer.from(v.toString(16).padStart(v.toString(16).length + (v.toString(16).length % 2), "0"), "hex")));
function rlp(item: Item): Uint8Array {
  const head = (n: number, base: number) => (n < 56 ? Uint8Array.of(base + n) : Uint8Array.of(base + 55 + num(BigInt(n)).length, ...num(BigInt(n))));
  if (Array.isArray(item)) {
    const body = Buffer.concat(item.map(rlp));
    return Uint8Array.of(...head(body.length, 0xc0), ...body);
  }
  return item.length === 1 && item[0]! < 0x80 ? item : Uint8Array.of(...head(item.length, 0x80), ...item);
}
function raw(nonce: number, to: string, options: { chainId?: bigint; tip?: bigint; data?: string } = {}): string {
  const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.slice(2), "hex"));
  const fields: Item[] = [num(options.chainId ?? 84_532n), num(BigInt(nonce)), num(options.tip ?? 1_000_000n), num(1_000_000_000n), num(300_000n), bytes(to), num(0n), bytes(options.data ?? "0x617ba037"), [], num(1n), new Uint8Array(32).fill(7), new Uint8Array(32).fill(9)];
  return `0x02${Buffer.from(rlp(fields)).toString("hex")}`;
}
const signed = (nonce: number, kind: string, to: string, options: Parameters<typeof raw>[2] = {}): EvmSigned => ({ nonce, kind, token: to.toLowerCase(), amount: "1", raw: raw(nonce, to, options), hash: `0x${String(nonce).padStart(2, "0").repeat(32)}`, step: null });

test("the account's Aave settings, its signed transactions and the Aave actions it lists as under way, as the keeper reads them", () => {
  assert.deepEqual(AAVE, {
    chainId: 84_532,
    pool: POOL.toLowerCase(),
    usdc: { symbol: "USDC", address: USDC.toLowerCase(), decimals: 6 },
    collateral: [
      { symbol: "WBTC", address: WBTC.toLowerCase(), decimals: 8 },
      { symbol: "WETH", address: WETH, decimals: 18 },
    ],
    maxFeePerGas: "1000000000",
  });
  assert.equal(aaveSettings({ lenders: { rhea: { contract_id: "rhea.pbf-ops.testnet" } } }), null);
  assert.equal(aaveSettings({ lenders: { aave: { chain_id: 84_532, pool: "not an address" } } }), null);
  assert.equal(aaveSettings(null), null);

  const state = { evm: { nonce: 3, signed: [{ nonce: 2, kind: "borrow", token: USDC, amount: "570000000", to: POOL, raw: MINED, hash: MINED_HASH.toUpperCase().replace("0X", "0x"), step: "f5000:1", signed_at: "1794400000123456789" }, { nonce: "x" }, null] } };
  // INTERFACES.md 47.1: `signed_at` (nanoseconds) is read as the block time it was signed at, in ms: a bump by anyone but the owner waits a minute from it.
  assert.deepEqual(readEvm(state), { nonce: 3, signed: [{ nonce: 2, kind: "borrow", token: USDC.toLowerCase(), amount: "570000000", raw: MINED, hash: MINED_HASH, step: "f5000:1", signedAtMs: 1_794_400_000_123 }] });
  const unsaid = readEvm({ evm: { nonce: 3, signed: [{ nonce: 2, kind: "borrow", raw: MINED, hash: MINED_HASH }, { nonce: 1, kind: "supply", raw: MINED, hash: MINED_HASH, signed_at: "0" }] } });
  assert.deepEqual(unsaid?.signed.map((e) => e.signedAtMs), [undefined, undefined], "an entry that doesn't say when, or says 0, has none");
  assert.equal(readEvm({}), null, "an account from before stage 3 has no evm");
  assert.equal(readEvm({ evm: { signed: [] } }), null);

  // INTERFACES.md 33: an Aave action has evm_nonce and no until_block; Rhea's has until_block and isn't one of these.
  const pending = [
    { lender: { lender: "aave", kind: "borrow", amount: "570000000", token: USDC, evm_nonce: 2 } },
    { lender: { lender: "rhea", kind: "borrow", amount: "5", until_block: 123 } },
    { transfer: { id: "t1" } },
  ];
  assert.deepEqual(pendingAave(pending), [{ kind: "borrow", amount: "570000000", token: USDC.toLowerCase(), evmNonce: 2 }]);
  assert.deepEqual(pendingAave(null), []);
});

test("a signed transaction's own fields, read without hashing it: a real one from Base Sepolia, and what the keeper won't send", () => {
  assert.deepEqual(rawFields(MINED), { chainId: 84_532, nonce: 4, tip: 1_000_000n, maxFee: 1_000_000_000n, to: WETH });
  assert.equal(sendProblem({ nonce: 4, raw: MINED }, AAVE), null, "a call to a token of the settings, on their chain");
  assert.equal(sendProblem({ nonce: 5, raw: MINED }, AAVE), "it carries nonce 4 inside");
  assert.equal(sendProblem({ nonce: 1, raw: raw(1, POOL) }, AAVE), null, "a call to Aave's Pool");
  assert.equal(sendProblem({ nonce: 1, raw: raw(1, POOL, { chainId: 8_453n }) }, AAVE), "it is for chain 8453, and the account's Aave settings name chain 84532");
  assert.equal(sendProblem({ nonce: 1, raw: raw(1, "0x1111111111111111111111111111111111111111") }, AAVE), "it goes to 0x1111111111111111111111111111111111111111, which is neither Aave's Pool nor a token of the account's Aave settings");
  for (const bad of ["0x", "not hex", `0x01${MINED.slice(4)}`, MINED.slice(0, -2), `${MINED}00`, "0x02c0"]) {
    assert.equal(rawFields(bad), null, bad.slice(0, 12));
    assert.equal(sendProblem({ nonce: 4, raw: bad }, AAVE), "it isn't a type 2 Ethereum transaction");
  }
});

/** A node that answers each method with `answer`, in a batch behind eth_chainId. */
function node(answer: (method: string, params: unknown[]) => unknown, chainId = 84_532) {
  const asked: { method: string; params: unknown[] }[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const batch = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }[];
    const replies = batch.map((r) => {
      if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: `0x${chainId.toString(16)}` };
      asked.push({ method: r.method, params: r.params });
      const value = answer(r.method, r.params) as { error?: string } | string | null;
      return value && typeof value === "object" && value.error ? { jsonrpc: "2.0", id: r.id, error: { code: -32_000, message: value.error } } : { jsonrpc: "2.0", id: r.id, result: value };
    });
    return new Response(JSON.stringify(replies.reverse()), { status: 200 });
  }) as typeof fetch;
  return { evm: new EvmHttp({ url: "https://sepolia.base.org/v1/secret-key", chainId: 84_532, fetch: fetchImpl }), asked };
}

test("Aave's chain: the nonce the chain has used, a token's allowance, and a send whose answer is sent, known, used or refused", async () => {
  const reads = node((method) => (method === "eth_getTransactionCount" ? "0xb" : `0x${"f".repeat(64)}`));
  assert.equal(await reads.evm.chainNonce(ADDRESS), 11);
  assert.deepEqual(reads.asked[0], { method: "eth_getTransactionCount", params: [ADDRESS, "latest"] });
  assert.equal(await reads.evm.allowance(WBTC, ADDRESS, POOL), (1n << 256n) - 1n);
  assert.equal(ALLOWANCE_SELECTOR, "0xdd62ed3e");
  assert.deepEqual(reads.asked[1], { method: "eth_call", params: [{ to: WBTC, data: `0xdd62ed3e${"0".repeat(24)}${ADDRESS.slice(2)}${"0".repeat(24)}${POOL.slice(2).toLowerCase()}` }, "latest"] });

  const send = async (reply: unknown): Promise<SendAnswer> => node(() => reply).evm.send(MINED, MINED_HASH);
  assert.deepEqual(await send(MINED_HASH), { status: "sent" });
  assert.deepEqual(await send({ error: "already known" }), { status: "known" });
  assert.deepEqual(await send({ error: "nonce too low: next nonce 5, tx nonce 4" }), { status: "used" });
  assert.deepEqual(await send({ error: "replacement transaction underpriced" }), { status: "refused", why: "replacement transaction underpriced" });
  assert.deepEqual(await send(`0x${"ab".repeat(32)}`), { status: "refused", why: `the node answered another hash (0x${"ab".repeat(32)}) than the account stored` });

  // A node on another chain is never read from or sent to; a node that is down says so by its host only.
  const mainnet = node(() => MINED_HASH, 8_453);
  await assert.rejects(mainnet.evm.send(MINED, MINED_HASH), /EVM_RPC_URL \(sepolia\.base\.org\) answers for chain 8453, and the keeper is set to chain 84532/);
  await assert.rejects(mainnet.evm.chainNonce(ADDRESS), /answers for chain 8453/);
  const down = new EvmHttp({ url: "https://sepolia.base.org/v1/secret-key", chainId: 84_532, fetch: (async () => new Response("slow down", { status: 429 })) as typeof fetch });
  await assert.rejects(down.chainNonce(ADDRESS), (e: Error) => /Aave's chain \(sepolia\.base\.org\) didn't answer eth_getTransactionCount: HTTP 429/.test(e.message) && !e.message.includes("secret-key"));
  await assert.rejects(node(() => ({ error: "execution reverted" })).evm.allowance(WBTC, ADDRESS, POOL), /eth_call failed on sepolia\.base\.org: execution reverted/);
});

test("the keeper's settings for Aave's chain: Base Sepolia unless set, test chains only, and the backend it sends through", async () => {
  const config = keeperConfig({}, []);
  assert.deepEqual([config.evmRpcUrl, config.evmChainId, config.apiUrl], ["https://sepolia.base.org", BASE_SEPOLIA_CHAIN_ID, "http://localhost:8788"]);
  assert.deepEqual([keeperConfig({ EVM_CHAIN_ID: "11155111", EVM_RPC_URL: "https://rpc.example/", API_URL: "http://localhost:9000/" }, []).evmRpcUrl, keeperConfig({ API_URL: "http://localhost:9000/" }, []).apiUrl], ["https://rpc.example", "http://localhost:9000"]);
  for (const mainnet of ["1", "8453", "42161", "soon"]) assert.throws(() => keeperConfig({ EVM_CHAIN_ID: mainnet }, []), /isn't a test chain the keeper knows \(84532 Base Sepolia, /, mainnet);

  // The backend's route, as the keeper calls it.
  const calls: { url: string; body: unknown }[] = [];
  const submit = backendSubmit("http://localhost:8788/", (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ hash: MINED_HASH, status: "sent" }), { status: 200 });
  }) as typeof fetch);
  assert.deepEqual(await submit("a.pbf.testnet", 4), { status: 200, body: { hash: MINED_HASH, status: "sent" } });
  assert.deepEqual(calls, [{ url: "http://localhost:8788/api/evm/submit", body: { account: "a.pbf.testnet", nonce: 4 } }]);
});

test("the sender: every transaction the chain hasn't used goes out through the backend and by the keeper itself, lowest nonce first, and again a minute later while it isn't mined", async () => {
  let now = 1_000_000;
  const sent: string[] = [];
  const submitted: number[] = [];
  let backend: { status: number; body: unknown } | Error = { status: 200, body: { status: "sent" } };
  let own: SendAnswer | Error = { status: "known" };
  const sender = new EvmSender(
    {
      send: async (rawTx) => {
        sent.push(rawTx);
        if (own instanceof Error) throw own;
        return own;
      },
    },
    async (_account, nonce) => {
      submitted.push(nonce);
      if (backend instanceof Error) throw backend;
      return backend;
    },
    () => now,
  );
  const approve = signed(0, "approve", WBTC);
  const supply = signed(1, "supply", POOL);
  const borrow = signed(2, "borrow", POOL);
  // The chain has used nonce 0: the approval is mined and isn't sent again.
  assert.deepEqual(await sender.sendNew("a.pbf.testnet", [approve, borrow, supply], 1, AAVE), [
    "signed transaction 1 (supply) sent: the backend answered sent; the chain's node had it already",
    "signed transaction 2 (borrow) sent: the backend answered sent; the chain's node had it already",
  ]);
  assert.deepEqual([submitted, sent], [[1, 2], [supply.raw, borrow.raw]]);
  // Within the minute nothing goes again; after it, what still isn't mined does.
  now += 30_000;
  assert.deepEqual(await sender.sendNew("a.pbf.testnet", [approve, supply, borrow], 1, AAVE), []);
  now += RESEND_MS;
  own = { status: "sent" };
  assert.deepEqual(await sender.sendNew("a.pbf.testnet", [approve, supply, borrow], 2, AAVE), ["signed transaction 2 (borrow) sent: the backend answered sent; the keeper's own send went out"]);

  // The backend down, refusing, or the node refusing: each is said, and the other way still goes.
  now += RESEND_MS;
  backend = new Error("connect ECONNREFUSED 127.0.0.1:8788");
  own = { status: "used" };
  assert.deepEqual(await sender.sendNew("a.pbf.testnet", [borrow], 2, AAVE), ["signed transaction 2 (borrow) sent: the backend did not answer (connect ECONNREFUSED 127.0.0.1:8788); the chain has used that nonce already"]);
  now += RESEND_MS;
  backend = { status: 422, body: { error: "bad_entry", message: "The signed transaction with nonce 2 moves ETH" } };
  own = { status: "refused", why: "insufficient funds for gas * price + value" };
  assert.deepEqual(await sender.sendNew("a.pbf.testnet", [borrow], 2, AAVE), [
    "signed transaction 2 (borrow) sent: the backend refused it (HTTP 422: The signed transaction with nonce 2 moves ETH); the chain's node refused the keeper's own send: insufficient funds for gas * price + value",
  ]);
  now += RESEND_MS;
  own = new Error("Aave's chain (sepolia.base.org) didn't answer eth_sendRawTransaction: HTTP 429");
  assert.match((await sender.sendNew("a.pbf.testnet", [borrow], 2, AAVE))[0]!, /the keeper's own send failed \(Aave's chain \(sepolia\.base\.org\) didn't answer/);

  // A bump signs a nonce again: the later entry is the one sent. And a transaction to anywhere else is never sent.
  const before = sent.length;
  const bumped = { ...signed(3, "repay", POOL, { tip: 10_000_000n }), hash: `0x${"cd".repeat(32)}` };
  own = { status: "sent" };
  backend = { status: 200, body: { status: "sent" } };
  assert.deepEqual(await sender.sendNew("b.pbf.testnet", [signed(3, "repay", POOL), bumped], 3, AAVE), ["signed transaction 3 (repay) sent: the backend answered sent; the keeper's own send went out"]);
  assert.deepEqual(sent.slice(before), [bumped.raw]);
  const stray = signed(4, "transfer", "0x1111111111111111111111111111111111111111");
  assert.deepEqual(await sender.sendNew("b.pbf.testnet", [stray], 4, AAVE), ["signed transaction 4 (transfer) not sent: it goes to 0x1111111111111111111111111111111111111111, which is neither Aave's Pool nor a token of the account's Aave settings"]);
  now += 10 * RESEND_MS;
  assert.deepEqual(await sender.sendNew("b.pbf.testnet", [stray], 4, AAVE), [], "and it is said once");
  assert.equal(sent.length, before + 1);
});
