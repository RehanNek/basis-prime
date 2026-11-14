// INTERFACES.md 51.2: the stand-in's two ether routes, test ETH on NEAR to WETH on Base Sepolia and back, beside
// stage 4's four. The floats, the node and the real 1Click are made up here; nothing touches a network.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { QuoteRequest } from "@pb/oneclick";

import { BASE_TWINS, NEAR_TWINS } from "./assets.js";
import { Engine } from "./engine.js";
import { ETH_RESERVE_WEI, evmRoute, MAX_WETH_OUT, priceEvmRoute, RouteRefused, type PricedRoute } from "./evm-routes.js";
import { ASSETS_ALL, B_USDC, B_WBTC, B_WETH, BASE_TOKENS, ethRouteOut, FakeEvm, FakeHl, fakeEthUpstream, FakeNearWithMint, HL_USDC, METH, MNBTC, MUSDC, MUSDT, MWNEAR, request } from "./fakes.js";
import { createShimServer } from "./server.js";
import { Store } from "./state.js";

const ACCOUNT = "a.pbf.testnet";
/** The account's address on Base Sepolia (its Hyperliquid address). */
const ADDRESS = "0x5ebf298b5e84faf68d644b1b3987867c99fca794";
const WETH = BASE_TOKENS.weth.toLowerCase();
const METH_TOKEN = "meth.pbf-ops.testnet";
const asset = (id: string) => ASSETS_ALL.find((a) => a.assetId === id)!;
/** 0.02 test ETH, and what 1Click pays out for it as ETH on Base: 0.019994. */
const ETH_IN = 20_000_000_000_000_000n;
const WETH_OUT = 19_994_000_000_000_000n;

function setup() {
  const near = new FakeNearWithMint();
  const evm = new FakeEvm();
  const clock = { now: 1_800_000_000_000 };
  const logs: string[] = [];
  const upstream = fakeEthUpstream();
  const engine = new Engine({ store: new Store(), assets: ASSETS_ALL, near, hl: new FakeHl(), evm, now: () => clock.now, log: (l) => logs.push(l) });
  const price = (overrides: Partial<QuoteRequest>, withFloat = true): Promise<PricedRoute> => {
    const r = request({ deadline: new Date(clock.now + 600_000).toISOString(), ...overrides });
    const [origin, destination] = [asset(r.originAsset), asset(r.destinationAsset)];
    return priceEvmRoute({ upstream: upstream.client, assets: ASSETS_ALL, ...(withFloat ? { evm } : {}), now: () => clock.now, deadlineMs: 600_000 }, r, origin, destination, evmRoute(origin, destination)!);
  };
  /** A committed quote, as the server opens it: priced, then given its deposit address. */
  const open = async (overrides: Partial<QuoteRequest>) => {
    const out = await price(overrides);
    const evmFromBlock = asset(out.request.originAsset).chain === "evm" ? await evm.blockNumber() : undefined;
    return engine.openSwap(out.request, out.priced, { ...(evmFromBlock !== undefined ? { evmFromBlock } : {}), ...(out.note ? { note: out.note } : {}) });
  };
  return { engine, near, evm, clock, logs, upstream, price, open };
}
const refused = async (run: Promise<unknown>): Promise<string> => {
  let message = "";
  await assert.rejects(run, (e: unknown) => {
    assert.ok(e instanceof RouteRefused, String(e));
    message = e.message;
    return true;
  });
  return message;
};
const out = { originAsset: METH, destinationAsset: B_WETH, refundTo: ACCOUNT, recipient: ADDRESS };
const home = { originAsset: B_WETH, refundTo: ADDRESS, recipient: ACCOUNT };

test("test ETH to WETH and WETH to test ETH are routes of their own; WETH to mNBTC stays the bitcoin route, the first four are what they were, and no other pair with a new NEAR token crosses", () => {
  const route = (from: string, to: string) => evmRoute(asset(from), asset(to));
  assert.deepEqual([route(METH, B_WETH), route(B_WETH, METH)], ["eth_out", "eth_home"]);
  // WETH comes home as bitcoin unless the quote's destination is test ETH.
  assert.equal(route(B_WETH, MNBTC), "btc_home");
  assert.deepEqual([route(MNBTC, B_WBTC), route(MNBTC, B_WETH), route(MUSDC, B_USDC), route(B_USDC, MUSDC), route(B_WBTC, MNBTC)], ["btc_out", "btc_out", "usdc_out", "usdc_home", "btc_home"]);
  assert.equal(route(METH, MUSDC), null, "a swap on NEAR is no route to Base Sepolia");
  const notRoutes = [[METH, B_WBTC], [METH, B_USDC], [B_WBTC, METH], [B_USDC, METH], [MWNEAR, B_WETH], [B_WETH, MWNEAR], [MUSDT, B_USDC], [B_WETH, MUSDC], [MUSDC, B_WETH], [HL_USDC, B_WETH]] as const;
  for (const [from, to] of notRoutes) {
    assert.throws(() => route(from, to), (e: unknown) => e instanceof RouteRefused && /Ether has two more: ETH to WETH, and WETH to ETH\. \S+ to \S+ isn't one$/.test(e.message), `${from} to ${to}`);
  }
  assert.throws(() => route(METH, B_WBTC), (e: unknown) => e instanceof RouteRefused && e.message.endsWith("ETH to WBTC isn't one"));
});

test("ether to Aave's chain and back is priced by 1Click as ETH on NEAR and ETH on Base, which WETH wraps one for one: 1Click has no price for WETH itself", async () => {
  const { price, upstream } = setup();
  const going = await price({ ...out, amount: ETH_IN.toString() });
  // 1Click was asked once, for a price only, about ETH on NEAR to ETH on Base, with placeholder parties.
  assert.equal(upstream.state.quotes.length, 1);
  const asked = upstream.state.quotes[0]!;
  assert.deepEqual([asked.dry, asked.originAsset, asked.destinationAsset, asked.amount, asked.refundTo], [true, "nep141:eth.bridge.near", "nep141:base.omft.near", "20000000000000000", "aurora"]);
  assert.match(asked.recipient, /^0x[0-9a-f]{40}$/);
  // The quote is WETH's: what was asked for is what arrives, in 1Click's own units and time, and there is no note.
  assert.deepEqual([going.request.destinationAsset, going.priced.quote.amountIn, going.priced.quote.amountOut, going.priced.quote.amountOutFormatted, going.priced.quote.timeEstimate, going.note], [B_WETH, "20000000000000000", WETH_OUT.toString(), "0.019994", 22, undefined]);
  assert.equal(WETH_OUT, ethRouteOut(ETH_IN, NEAR_TWINS.eth, BASE_TWINS.eth));

  const coming = await price({ ...home, destinationAsset: METH, amount: "20000000000000000" });
  const back = upstream.state.quotes[1]!;
  assert.deepEqual([back.dry, back.originAsset, back.destinationAsset, back.amount, back.recipient], [true, "nep141:base.omft.near", "nep141:eth.bridge.near", "20000000000000000", "aurora"]);
  assert.deepEqual([coming.request.destinationAsset, coming.priced.quote.amountOut, coming.priced.quote.timeEstimate, coming.note], [METH, "19994000000000000", 35, undefined]);

  // The made-up 1Click answers as the real one did on 14 Nov: nothing between ETH on NEAR and WETH on Base.
  await assert.rejects(upstream.client.quote({ ...request(), dry: true, originAsset: NEAR_TWINS.eth, destinationAsset: BASE_TWINS.weth }), /No liquidity available/);
});

test("WETH out keeps its cap: more than 0.02 WETH in one move is refused in words that give the most test ETH that fits, and so is a float that couldn't wrap it and keep its gas", async () => {
  const { evm, price } = setup();
  // 0.03 test ETH would arrive as 0.029991 WETH. The words say how much test ETH brings exactly the cap.
  assert.equal(
    await refused(price({ ...out, amount: "30000000000000000" })),
    "This would arrive as 0.029991 WETH, and the stand-in brings at most 0.02 WETH in one move: its float has little test ETH. Send at most 0.020006001800540162 ETH (20006001800540162 units)",
  );
  assert.equal((20_006_001_800_540_162n * 9_997n) / 10_000n <= MAX_WETH_OUT, true, "the amount the words name does fit");
  // The cap is on the size of a move, so it is said with the float off too (a dry price while the stand-in has no key there).
  assert.match(await refused(price({ ...out, amount: "30000000000000000" }, false)), /^This would arrive as 0\.029991 WETH/);
  // Under the cap, but the float can't wrap that much test ETH and keep 0.003 for its own gas.
  evm.eth = 21_000_000_000_000_000n;
  assert.equal(
    await refused(price({ ...out, amount: ETH_IN.toString() })),
    `The stand-in's float holds 0.021 test ETH and 0 WETH: it can't wrap 0.019994 more and keep 0.003 for gas. Ask for less, or send the float (${evm.address}) test ETH on Base Sepolia`,
  );
  assert.equal(21_000_000_000_000_000n < WETH_OUT + ETH_RESERVE_WEI, true);
  // WETH the float already holds counts first: with 0.005 wrapped it wraps 0.014994, and keeps its reserve.
  evm.balances.set(WETH, 5_000_000_000_000_000n);
  assert.equal((await price({ ...out, amount: ETH_IN.toString() })).priced.quote.amountOut, WETH_OUT.toString());
  // The way home has no such cap: test ETH on NEAR is minted, not wrapped.
  assert.equal((await price({ ...home, destinationAsset: METH, amount: "1000000000000000000" })).priced.quote.amountOut, "999700000000000000");
});

test("ether out, end to end: the test ETH is seen at the quote's own NEAR address, WETH is wrapped from the float's test ETH and sent to the account's address, and a forced refund sends the test ETH back with the transfer's msg", async () => {
  const { engine, near, evm, clock, open } = setup();
  const msg = '{"pb":{"transfer":"move:5"}}';
  const quote = await open({ ...out, amount: ETH_IN.toString(), customRecipientMsg: msg });
  const address = quote.quote.depositAddress!;
  assert.match(address, /^[0-9a-f]{64}$/, "a NEAR deposit address of its own, as for every NEAR origin");
  assert.deepEqual([quote.quoteRequest.originAsset, quote.quoteRequest.destinationAsset, quote.shim], [METH, B_WETH, undefined]);

  near.credit(METH_TOKEN, address, ETH_IN);
  await engine.tick();
  assert.equal(engine.find(address)!.status, "PROCESSING");
  clock.now += 21_000;
  await engine.tick();
  assert.equal(engine.find(address)!.status, "PROCESSING", "not before 1Click's 22 s");
  clock.now += 1_000;
  await engine.tick();
  const status = engine.statusOf(engine.find(address)!);
  assert.equal(status.status, "SUCCESS", status.swapDetails.refundReason);
  assert.deepEqual(evm.sent, [
    { kind: "wrap", amount: WETH_OUT },
    { kind: "transfer", token: WETH, to: ADDRESS, amount: WETH_OUT },
  ]);
  assert.equal(evm.eth, 48_000_000_000_000_000n - WETH_OUT);
  assert.deepEqual([status.swapDetails.amountOut, status.swapDetails.amountOutFormatted, status.swapDetails.depositedAmountFormatted], [WETH_OUT.toString(), "0.019994", "0.02"]);
  assert.deepEqual(status.swapDetails.destinationChainTxHashes, [{ hash: "0xbase2", explorerUrl: "https://sepolia.basescan.org/tx/0xbase2" }]);
  assert.equal(near.transfers.length, 0, "nothing left the float on NEAR");

  // The fault switch: the deposit stays at its address, and the float sends the test ETH back with the msg.
  engine.setFault({ mode: "refund", delaySeconds: 600 });
  const second = await open({ ...out, amount: "10000000000000000", customRecipientMsg: msg });
  near.credit(METH_TOKEN, second.quote.depositAddress!, 10_000_000_000_000_000n);
  await engine.tick();
  clock.now += 22_000;
  await engine.tick();
  assert.equal(engine.find(second.quote.depositAddress!)!.status, "REFUNDED");
  assert.deepEqual(near.transfers.at(-1), { token: METH_TOKEN, receiverId: ACCOUNT, amount: 10_000_000_000_000_000n, msg, memo: `1click-shim refund ${second.correlationId}` });
  assert.equal(evm.sent.length, 2, "nothing more left the float on Base Sepolia");
});

test("WETH that comes home with test ETH as the quote's destination is handed back as test ETH on NEAR, minted when the float is short, with the transfer's msg, and the WETH is unwrapped; the same WETH with mNBTC as its destination still comes home as bitcoin", async () => {
  const { engine, near, evm, clock, open } = setup();
  const msg = '{"pb":{"transfer":"move:6"}}';
  const send = async (quote: Awaited<ReturnType<typeof open>>, amount: bigint) => {
    evm.deposit(WETH, ADDRESS, amount);
    evm.block += 10;
    await engine.tick();
    assert.equal(engine.find(evm.address, quote.correlationId)!.status, "PROCESSING");
    clock.now += 35_000;
    await engine.tick();
    return engine.find(evm.address, quote.correlationId)!;
  };

  // Destination test ETH: the float holds none, so the token's faucet mints the whole delivery.
  const asEth = await open({ ...home, destinationAsset: METH, amount: ETH_IN.toString(), customRecipientMsg: msg });
  assert.deepEqual([asEth.quote.depositAddress, asEth.quote.depositMemo], [evm.address, asEth.correlationId], "the float's address on Base Sepolia, with the quote's id as its memo");
  const first = await send(asEth, ETH_IN);
  assert.equal(first.status, "SUCCESS", first.reason);
  assert.deepEqual(near.transfers.at(-1), { token: METH_TOKEN, receiverId: ACCOUNT, amount: 19_994_000_000_000_000n, msg, memo: `1click-shim ${asEth.correlationId}` });
  assert.deepEqual(near.minted, [{ token: METH_TOKEN, amount: 19_994_000_000_000_000n }]);
  // The WETH is the float's test ETH again, so it can wrap it for the next move out.
  assert.deepEqual(evm.sent, [{ kind: "unwrap", amount: ETH_IN }]);
  assert.deepEqual([evm.eth, evm.balances.get(WETH)], [68_000_000_000_000_000n, 0n]);

  // With stock on NEAR nothing is minted: only what is short ever is.
  near.credit(METH_TOKEN, near.accountId, 1_000_000_000_000_000_000n);
  const again = await open({ ...home, destinationAsset: METH, amount: "10000000000000000" });
  assert.equal((await send(again, 10_000_000_000_000_000n)).status, "SUCCESS");
  assert.equal(near.minted.length, 1);
  assert.deepEqual([near.transfers.at(-1)!.token, near.transfers.at(-1)!.amount], [METH_TOKEN, 9_997_000_000_000_000n]);

  // The same WETH, the same sender, with mNBTC as the destination: bitcoin, as before section 51.
  const asBtc = await open({ ...home, destinationAsset: MNBTC, amount: ETH_IN.toString(), customRecipientMsg: msg });
  assert.equal(asBtc.quoteRequest.destinationAsset, MNBTC);
  const third = await send(asBtc, ETH_IN);
  assert.equal(third.status, "SUCCESS", third.reason);
  // 0.02 WETH is $38.3052, 56,788 satoshis of cbBTC at the list's prices, and 1Click's cbBTC to nBTC pays 56,770.
  assert.deepEqual(near.transfers.at(-1), { token: "mnbtc.pbf-ops.testnet", receiverId: ACCOUNT, amount: 56_770n, msg, memo: `1click-shim ${asBtc.correlationId}` });
  assert.equal(evm.sent.filter((s) => s.kind === "unwrap").length, 3, "every WETH that came home was unwrapped");
});

test("over HTTP: the two ether routes quote and commit as 1Click's API does, a move past the cap answers 400 with the words, and a pair that isn't a route names the six", async () => {
  const near = new FakeNearWithMint();
  const evm = new FakeEvm();
  const upstream = fakeEthUpstream();
  const engine = new Engine({ store: new Store(), assets: ASSETS_ALL, near, hl: new FakeHl(), evm });
  const server = createShimServer({ engine, upstream: upstream.client, assets: ASSETS_ALL, floats: { near: true, hl: false, evm: true }, evm, deployed: async () => null, adminToken: undefined });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const post = async (body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v0/quote`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const deadline = new Date(Date.now() + 600_000).toISOString();
  try {
    const going = await post(request({ ...out, amount: ETH_IN.toString(), deadline, customRecipientMsg: '{"pb":{"transfer":"move:1"}}' }));
    assert.equal(going.status, 201, going.body.message);
    assert.match(going.body.quote.depositAddress, /^[0-9a-f]{64}$/);
    assert.deepEqual([going.body.quote.amountOut, going.body.quoteRequest.destinationAsset, going.body.shim], [WETH_OUT.toString(), B_WETH, undefined]);
    const coming = await post(request({ ...home, destinationAsset: METH, amount: ETH_IN.toString(), deadline, customRecipientMsg: '{"pb":{"transfer":"move:2"}}' }));
    assert.equal(coming.status, 201, coming.body.message);
    assert.deepEqual([coming.body.quote.depositAddress, coming.body.quote.depositMemo, coming.body.quote.amountOut, coming.body.quoteRequest.destinationAsset], [evm.address, coming.body.correlationId, "19994000000000000", METH]);
    assert.equal((await post(request({ ...out, amount: ETH_IN.toString(), dry: true }))).body.quote.depositAddress, undefined, "a dry quote is a price only");

    const tooMuch = await post(request({ ...out, amount: "30000000000000000", deadline, dry: true }));
    assert.deepEqual([tooMuch.status, /^This would arrive as 0\.029991 WETH, and the stand-in brings at most 0\.02 WETH in one move/.test(tooMuch.body.message)], [400, true]);
    const wrongPair = await post(request({ originAsset: METH, destinationAsset: B_WBTC, amount: "1000", refundTo: ACCOUNT, recipient: ADDRESS, deadline, dry: true }));
    assert.deepEqual([wrongPair.status, wrongPair.body.message], [400, "The stand-in moves bitcoin and USDC between NEAR and Base Sepolia on four routes only: mNBTC to WBTC (or WETH), mUSDC to USDC, USDC to mUSDC, and WBTC or WETH to mNBTC. Ether has two more: ETH to WETH, and WETH to ETH. ETH to WBTC isn't one"]);
    const badAddress = await post(request({ ...out, amount: ETH_IN.toString(), recipient: ACCOUNT, deadline }));
    assert.deepEqual([badAddress.status, badAddress.body.message], [400, "recipient is not a valid Base Sepolia address"]);
    // The four of before still answer through the same door: USDC out is 1Click's USDC to USDC.
    const usdc = await post(request({ originAsset: MUSDC, destinationAsset: B_USDC, amount: "25000000", refundTo: ACCOUNT, recipient: ADDRESS, deadline, dry: true }));
    assert.deepEqual([usdc.status, usdc.body.quote.amountOut], [201, "24992500"]);
  } finally {
    server.close();
  }
});
