// Stage 4 (INTERFACES.md 36): the stand-in's third chain, Base Sepolia. The float, the node and the real 1Click are
// made up here; nothing touches a network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { baseSepoliaAssetId, type QuoteRequest } from "@pb/oneclick";

import { BASE_TWINS, shimAssets } from "./assets.js";
import { evmTokensOf, shimConfig } from "./config.js";
import { Engine } from "./engine.js";
import { addressOfKey, callData, EVM_CALLS, evmFloat, LOG_RANGE, signEvmTx, TRANSFER_EVENT, TRANSFER_TOPIC } from "./evm-float.js";
import { ETH_RESERVE_WEI, evmRoute, MAX_WETH_OUT, priceEvmRoute, RouteRefused, type PricedRoute } from "./evm-routes.js";
import { ASSETS_WITH_BASE, B_USDC, B_WBTC, B_WETH, BASE_TOKENS, FakeEvm, FakeHl, FakeNearWithMint, fakeUpstream, HL_USDC, MNBTC, MUSDC, request } from "./fakes.js";
import { Store } from "./state.js";

const ACCOUNT = "a.pbf.testnet";
/** The account's address on Base Sepolia (its Hyperliquid address): gate 3's, from INTERFACES.md 35. */
const ADDRESS = "0x5ebf298b5e84faf68d644b1b3987867c99fca794";
const WETH = BASE_TOKENS.weth.toLowerCase();
const WBTC = BASE_TOKENS.wbtc.toLowerCase();
const USDC = BASE_TOKENS.usdc.toLowerCase();
const asset = (id: string) => ASSETS_WITH_BASE.find((a) => a.assetId === id)!;

function setup(options: { evm?: FakeEvm } = {}) {
  const near = new FakeNearWithMint();
  const evm = options.evm ?? new FakeEvm();
  const clock = { now: 1_000_000 };
  const logs: string[] = [];
  const store = new Store();
  const upstream = fakeUpstream();
  const engine = new Engine({ store, assets: ASSETS_WITH_BASE, near, hl: new FakeHl(), evm, now: () => clock.now, log: (l) => logs.push(l) });
  const price = (overrides: Partial<QuoteRequest>, withFloat = true): Promise<PricedRoute> => {
    const r = request(overrides);
    const [origin, destination] = [asset(r.originAsset), asset(r.destinationAsset)];
    return priceEvmRoute({ upstream, assets: ASSETS_WITH_BASE, ...(withFloat ? { evm } : {}), now: () => clock.now, deadlineMs: 600_000 }, r, origin, destination, evmRoute(origin, destination)!);
  };
  /** A committed quote, as the server opens it: priced, then given its deposit address. */
  const open = async (overrides: Partial<QuoteRequest>) => {
    const out = await price(overrides);
    const evmFromBlock = asset(out.request.originAsset).chain === "evm" ? await evm.blockNumber() : undefined;
    return engine.openSwap(out.request, out.priced, { ...(evmFromBlock !== undefined ? { evmFromBlock } : {}), ...(out.note ? { note: out.note } : {}) });
  };
  return { engine, near, evm, clock, logs, store, upstream, price, open };
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

test("Base Sepolia's three tokens are assets of their own, priced as 1Click's USDC, cbBTC and WETH on Base", () => {
  assert.deepEqual(
    ASSETS_WITH_BASE.filter((a) => a.chain === "evm").map((a) => [a.assetId, a.symbol, a.decimals, a.contract, a.mainnetAssetId]),
    [
      ["1cs_v1:base-sepolia:erc20:0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f", "USDC", 6, USDC, "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"],
      // 1Click lists no WBTC on Base: cbBTC is the bitcoin it delivers there, with the same 8 decimals.
      ["1cs_v1:base-sepolia:erc20:0x54114591963cf60ef3aa63befd6ec263d98145a4", "WBTC", 8, WBTC, "nep141:base-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near"],
      ["1cs_v1:base-sepolia:erc20:0x4200000000000000000000000000000000000006", "WETH", 18, WETH, "nep141:base-0x4200000000000000000000000000000000000006.omft.near"],
    ],
  );
  assert.equal(B_WETH, baseSepoliaAssetId(BASE_TOKENS.weth));
  assert.equal(shimAssets({ musdc: "m", mnbtc: "n" }).length, 3, "without the factory's Aave settings the stand-in has its three assets, as before");
  // The tokens come from the factory's config, and only for the chain the stand-in is set to.
  const factory = { lenders: { aave: { chain_id: 84_532, usdc: { symbol: "USDC", address: BASE_TOKENS.usdc, decimals: 6 }, collateral: [{ symbol: "WBTC", address: BASE_TOKENS.wbtc, decimals: 8 }, { symbol: "WETH", address: BASE_TOKENS.weth, decimals: 18 }] } } };
  assert.deepEqual(evmTokensOf(factory, 84_532), BASE_TOKENS);
  assert.equal(evmTokensOf(factory, 11_155_111), null);
  assert.equal(evmTokensOf({ lenders: { rhea: {} } }, 84_532), null);
  assert.deepEqual(evmTokensOf({ lenders: { aave: { chain_id: 84_532, usdc: { address: BASE_TOKENS.usdc }, collateral: [] } } }, 84_532), { usdc: BASE_TOKENS.usdc });
  // Settings: Base Sepolia unless set, test chains only, and no new names.
  const config = shimConfig({});
  assert.deepEqual([config.evm.rpcUrl, config.evm.chainId, config.evm.privateKey, config.evm.faucet, config.factoryId], ["https://sepolia.base.org", 84_532, undefined, "0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc", "pbf.testnet"]);
  assert.throws(() => shimConfig({ EVM_CHAIN_ID: "8453" }), /isn't a test chain the stand-in knows/);
  assert.throws(() => shimConfig({ AAVE_FAUCET_ADDRESS: "0x12" }), /AAVE_FAUCET_ADDRESS is not a 0x address/);
});

test("the four routes, and nothing else, between NEAR and Base Sepolia", () => {
  const route = (from: string, to: string) => evmRoute(asset(from), asset(to));
  assert.deepEqual([route(MNBTC, B_WBTC), route(MNBTC, B_WETH), route(MUSDC, B_USDC), route(B_USDC, MUSDC), route(B_WBTC, MNBTC), route(B_WETH, MNBTC)], ["btc_out", "btc_out", "usdc_out", "usdc_home", "btc_home", "btc_home"]);
  assert.equal(route(MUSDC, MNBTC), null, "a route that doesn't touch Base Sepolia is priced as it always was");
  assert.equal(route(MUSDC, HL_USDC), null);
  for (const [from, to] of [[MUSDC, B_WBTC], [MNBTC, B_USDC], [B_USDC, MNBTC], [B_WETH, MUSDC], [HL_USDC, B_USDC], [B_WBTC, B_WETH]] as const) {
    assert.throws(() => route(from, to), (e: unknown) => e instanceof RouteRefused && /on four routes only/.test(e.message), `${from} to ${to}`);
  }
});

test("bitcoin to Aave's chain: WBTC while Aave has room for it, wrapped test ETH of the same dollar value when it hasn't, and the quote says which and why", async () => {
  const { evm, price, upstream } = setup();
  const btc = { originAsset: MNBTC, destinationAsset: B_WBTC, amount: "55000", refundTo: ACCOUNT, recipient: ADDRESS };
  // Aave has room: 0.00055 nBTC arrives as WBTC, at 1Click's price for nBTC to cbBTC on Base.
  evm.room[WBTC] = 2_500_000_000n;
  const asWbtc = await price(btc);
  assert.deepEqual([asWbtc.request.destinationAsset, asWbtc.priced.quote.amountOut, asWbtc.note], [B_WBTC, "54835", undefined]);
  assert.deepEqual([upstream.calls[0]!.originAsset, upstream.calls[0]!.destinationAsset, upstream.calls[0]!.dry], ["nep141:nbtc.bridge.near", BASE_TWINS.wbtc, true]);
  // The float holds no WBTC: Aave's faucet would mint it, so the quote stands. A faucet that would refuse is said now.
  evm.mintRefusal = "execution reverted: Error: Mint limit transaction exceeded";
  assert.equal(await refused(price(btc)), "The stand-in's float holds 0 WBTC, and Aave's faucet wouldn't mint the 0.00054835 WBTC it is short of now (execution reverted: Error: Mint limit transaction exceeded): it gives each address each token once an hour");
  evm.mintRefusal = null;

  // Aave's supply cap is full (as on 11 Nov): the same bitcoin arrives as WETH worth the same dollars.
  evm.room[WBTC] = 0n;
  const asWeth = await price(btc);
  assert.equal(asWeth.request.destinationAsset, B_WETH, "the answer's request names what is delivered");
  // $40.8549 of cbBTC at 1Click's $2,078.08 for WETH.
  assert.deepEqual([asWeth.priced.quote.amountOut, asWeth.priced.quote.amountOutFormatted, asWeth.priced.quote.amountOutUsd], ["19659886000000000", "0.019659886", "40.854817"]);
  assert.equal(asWeth.priced.quote.minAmountOut, ((19_659_886_000_000_000n * 54_286n) / 54_835n).toString(), "the floor keeps the route's own slippage");
  assert.deepEqual(asWeth.note, {
    asked: B_WBTC,
    delivers: B_WETH,
    symbol: "WETH",
    why: "Aave's test market has room for 0 more WBTC (its supply cap), less than the 0.00054835 this would bring: the bitcoin arrives as wrapped test ETH of the same dollar value",
  });
  // WETH asked for by name is the same quote, with nothing to explain.
  const named = await price({ ...btc, destinationAsset: B_WETH });
  assert.deepEqual([named.priced.quote.amountOut, named.note], ["19659886000000000", undefined]);

  // One move brings at most 0.02 WETH: more is refused when the quote is asked for, with the most that fits.
  assert.equal(MAX_WETH_OUT, 20_000_000_000_000_000n);
  assert.equal(
    await refused(price({ ...btc, amount: "1600000" })),
    "This would arrive as 0.571923968 WETH, and the stand-in brings at most 0.02 WETH in one move: its float has little test ETH. Send at most 0.00055951 mNBTC (55951 units)",
  );
  // A float that couldn't wrap it and keep its gas says so too; with the WETH already there it can.
  evm.eth = 20_000_000_000_000_000n;
  assert.match(await refused(price(btc)), /^The stand-in's float holds 0\.02 test ETH and 0 WETH: it can't wrap 0\.019659886 more and keep 0\.003 for gas\. Ask for less, or send the float \(0x2031181d63507368232579af4c64a1c3428407ff\) test ETH on Base Sepolia$/);
  assert.equal(ETH_RESERVE_WEI, 3_000_000_000_000_000n);
  evm.balances.set(WETH, 19_659_886_000_000_000n);
  assert.equal((await price(btc)).request.destinationAsset, B_WETH);
  // With the float off, a price is still a price: 1Click's, for WBTC, with nothing known of Aave's room.
  assert.equal((await price(btc, false)).request.destinationAsset, B_WBTC);
});

test("the way home and the two USDC routes: each priced by 1Click's own route, WETH through its dollar value in cbBTC", async () => {
  const { price, upstream, evm } = setup();
  const out = await price({ originAsset: MUSDC, destinationAsset: B_USDC, amount: "25000000", refundTo: ACCOUNT, recipient: ADDRESS });
  assert.deepEqual([out.priced.quote.amountOut, upstream.calls.at(-1)!.destinationAsset], ["24992500", BASE_TWINS.usdc]);
  const home = await price({ originAsset: B_USDC, destinationAsset: MUSDC, amount: "23033364", refundTo: ADDRESS, recipient: ACCOUNT });
  assert.deepEqual([home.priced.quote.amountOut, upstream.calls.at(-1)!.originAsset], ["23026453", BASE_TWINS.usdc]);
  const wbtcHome = await price({ originAsset: B_WBTC, destinationAsset: MNBTC, amount: "54835", refundTo: ADDRESS, recipient: ACCOUNT });
  assert.deepEqual([wbtcHome.priced.quote.amountOut, upstream.calls.at(-1)!.originAsset, upstream.calls.at(-1)!.amount], ["54670", BASE_TWINS.wbtc, "54835"]);
  // 0.02 WETH is $41.5616, which is 0.00055783 cbBTC: that much cbBTC is priced home to nBTC.
  const wethHome = await price({ originAsset: B_WETH, destinationAsset: MNBTC, amount: "20000000000000000", refundTo: ADDRESS, recipient: ACCOUNT });
  assert.deepEqual([upstream.calls.at(-1)!.originAsset, upstream.calls.at(-1)!.amount], [BASE_TWINS.wbtc, "55783"]);
  assert.deepEqual([wethHome.priced.quote.amountIn, wethHome.priced.quote.amountInFormatted, wethHome.priced.quote.amountInUsd, wethHome.priced.quote.amountOut], ["20000000000000000", "0.02", "41.561600", "55615"]);
  assert.equal(await refused(price({ originAsset: B_WETH, destinationAsset: MNBTC, amount: "1000", refundTo: ADDRESS, recipient: ACCOUNT })), "That is too little WETH to come home as any bitcoin");
  // USDC to Aave's chain: what the float holds, or what Aave's faucet gives in one call (1,000,000 USDC).
  evm.balances.set(USDC, 5_000_000n);
  assert.match(await refused(price({ originAsset: MUSDC, destinationAsset: B_USDC, amount: "2000000000000", refundTo: ACCOUNT, recipient: ADDRESS })), /^The stand-in's float holds 5 USDC, and Aave's faucet gives at most 1000000 USDC in one call: it can't deliver 19993\d\d(\.\d+)? USDC$/);
});

test("bitcoin out as WETH: the deposit on NEAR, then the float wraps only what it is short of and sends it; the status links to Base Sepolia's explorer", async () => {
  const { engine, near, evm, clock, open } = setup();
  evm.room[WBTC] = 0n;
  evm.balances.set(WETH, 5_000_000_000_000_000n); // 0.005 WETH that came back earlier and stayed wrapped
  const quote = await open({ originAsset: MNBTC, destinationAsset: B_WBTC, amount: "55000", refundTo: ACCOUNT, recipient: ADDRESS, customRecipientMsg: '{"pb":{"transfer":"move:1"}}' });
  assert.equal(quote.shim?.delivers, B_WETH, "the committed quote carries the note too");
  assert.equal(quote.quoteRequest.destinationAsset, B_WETH);
  const address = quote.quote.depositAddress!;
  assert.match(address, /^[0-9a-f]{64}$/, "a NEAR deposit address of its own, as for every NEAR origin");

  near.credit("mnbtc.pbf-ops.testnet", address, 55_000n);
  await engine.tick();
  assert.equal(engine.find(address)!.status, "PROCESSING");
  clock.now += 22_000;
  await engine.tick();
  const status = engine.statusOf(engine.find(address)!);
  assert.equal(status.status, "SUCCESS");
  assert.deepEqual(evm.sent, [
    { kind: "wrap", amount: 14_659_886_000_000_000n },
    { kind: "transfer", token: WETH, to: ADDRESS, amount: 19_659_886_000_000_000n },
  ]);
  assert.equal(evm.eth, 48_000_000_000_000_000n - 14_659_886_000_000_000n);
  assert.deepEqual(status.swapDetails.destinationChainTxHashes, [{ hash: "0xbase2", explorerUrl: "https://sepolia.basescan.org/tx/0xbase2" }]);
  assert.deepEqual([status.swapDetails.amountOut, status.swapDetails.amountOutFormatted, status.shim.note?.symbol], ["19659886000000000", "0.019659886", "WETH"]);

  // The fault switch works as on the other routes: a forced refund sends the nBTC back on NEAR with the transfer's msg.
  engine.setFault({ mode: "refund", delaySeconds: 600 });
  const second = await open({ originAsset: MNBTC, destinationAsset: B_WETH, amount: "20000", refundTo: ACCOUNT, recipient: ADDRESS, customRecipientMsg: '{"pb":{"transfer":"move:2"}}' });
  near.credit("mnbtc.pbf-ops.testnet", second.quote.depositAddress!, 20_000n);
  await engine.tick();
  clock.now += 22_000;
  await engine.tick();
  assert.equal(engine.find(second.quote.depositAddress!)!.status, "REFUNDED");
  assert.deepEqual(near.transfers.at(-1), { token: "mnbtc.pbf-ops.testnet", receiverId: ACCOUNT, amount: 20_000n, msg: '{"pb":{"transfer":"move:2"}}', memo: `1click-shim refund ${second.correlationId}` });
  assert.equal(evm.sent.length, 2, "nothing more left the float");
});

test("a deposit on Base Sepolia is the oldest unused transfer of the quote's token from its sender for exactly amountIn, read 200 blocks at a time from where the quote began", async () => {
  const { engine, near, evm, clock, open, store } = setup();
  // An old transfer of the same amount from the same address, before the quote: never this quote's deposit.
  evm.deposit(USDC, ADDRESS, 23_033_364n);
  evm.block += 50;
  const msg = '{"pb":{"transfer":"move:3"}}';
  const quote = await open({ originAsset: B_USDC, destinationAsset: MUSDC, amount: "23033364", refundTo: ADDRESS, recipient: ACCOUNT, customRecipientMsg: msg });
  assert.deepEqual([quote.quote.depositAddress, quote.quote.depositMemo], [evm.address, quote.correlationId], "the float's address, with the quote's id as the memo that tells quotes apart");
  const swap = () => engine.find(evm.address, quote.correlationId)!;
  assert.equal(swap().evmFromBlock, 57_000_050);

  // Nothing yet. Then transfers that aren't it: another sender, another amount, another token.
  evm.block += 15;
  await engine.tick();
  assert.equal(swap().status, "PENDING_DEPOSIT");
  assert.deepEqual(evm.ranges, [[USDC, 57_000_050, 57_000_060]], "one read, from the quote's block to five blocks behind the newest");
  evm.deposit(USDC, "0x9999999999999999999999999999999999999999", 23_033_364n);
  evm.deposit(USDC, ADDRESS, 23_033_363n);
  evm.deposit(WETH, ADDRESS, 23_033_364n);
  evm.block += 15;
  await engine.tick();
  assert.equal(swap().status, "PENDING_DEPOSIT");
  assert.deepEqual(evm.ranges.at(-1), [USDC, 57_000_061, 57_000_075], "the next read starts where the last one ended");

  // The stand-in was away for five minutes of blocks: it catches up 200 blocks at a time, never more in one read.
  evm.block += 700;
  const deposit = evm.deposit(USDC, ADDRESS, 23_033_364n);
  evm.block += 800;
  await engine.tick();
  const read = evm.ranges.slice(2);
  assert.equal(read.length, 8);
  assert.ok(read.every(([, from, to]) => to - from < LOG_RANGE));
  assert.deepEqual([read[0]![1], read.at(-1)![2]], [57_000_076, 57_001_575]);
  assert.equal(swap().status, "PROCESSING");
  assert.deepEqual([swap().depositTxHashes, swap().depositedAmount], [[deposit.hash], "23033364"]);
  assert.deepEqual(store.state.usedEvmLogs, [`${deposit.hash}:0`]);

  // Delivered on NEAR with the transfer's msg, as `home` is, so the account settles the transfer.
  clock.now += 22_000;
  await engine.tick();
  assert.equal(swap().status, "SUCCESS");
  assert.deepEqual(near.transfers.at(-1), { token: "musdc.pbf-ops.testnet", receiverId: ACCOUNT, amount: 23_026_453n, msg, memo: `1click-shim ${quote.correlationId}` });
  // The NEAR float held no mUSDC, so the test token's own faucet minted what it was short of.
  assert.deepEqual(near.minted, [{ token: "musdc.pbf-ops.testnet", amount: 23_026_453n }]);

  // A second quote for the same amount from the same address takes the next transfer, never the used one.
  const again = await open({ originAsset: B_USDC, destinationAsset: MUSDC, amount: "23033364", refundTo: ADDRESS, recipient: ACCOUNT });
  evm.block += 10;
  await engine.tick();
  assert.equal(engine.find(evm.address, again.correlationId)!.status, "PENDING_DEPOSIT");
  const next = evm.deposit(USDC, ADDRESS, 23_033_364n);
  evm.block += 10;
  await engine.tick();
  assert.deepEqual(engine.find(evm.address, again.correlationId)!.depositTxHashes, [next.hash]);
});

test("a reported deposit is read from its own receipt; WETH that comes home is delivered as nBTC and unwrapped; a refund on Base Sepolia sends the token back", async () => {
  const { engine, near, evm, clock, open, logs } = setup();
  const quote = await open({ originAsset: B_WETH, destinationAsset: MNBTC, amount: "20000000000000000", refundTo: ADDRESS, recipient: ACCOUNT, customRecipientMsg: '{"pb":{"transfer":"move:9"}}' });
  // The account's evm_withdraw is mined: the transfer is in that transaction's receipt, and its hash is reported.
  const hash = `0x${"8f".repeat(32)}`;
  evm.balances.set(WETH, 20_000_000_000_000_000n);
  evm.receipts.set(hash, [{ hash, logIndex: 3, block: evm.block + 4, token: WETH, from: ADDRESS, amount: 20_000_000_000_000_000n }]);
  const before = evm.ranges.length;
  await engine.submitDeposit(evm.address, hash, quote.correlationId);
  const swap = () => engine.find(evm.address, quote.correlationId)!;
  assert.equal(swap().status, "PROCESSING");
  assert.equal(evm.ranges.length, before, "no logs were read for it");
  clock.now += 22_000;
  await engine.tick();
  assert.equal(swap().status, "SUCCESS");
  assert.deepEqual(near.transfers.at(-1), { token: "mnbtc.pbf-ops.testnet", receiverId: ACCOUNT, amount: 55_615n, msg: '{"pb":{"transfer":"move:9"}}', memo: `1click-shim ${quote.correlationId}` });
  // The WETH is test ETH again, so the float's ETH goes round.
  assert.deepEqual(evm.sent, [{ kind: "unwrap", amount: 20_000_000_000_000_000n }]);
  assert.deepEqual([evm.eth, evm.balances.get(WETH), swap().unwrapTxHash], [68_000_000_000_000_000n, 0n, "0xbase1"]);
  // An unwrap that fails doesn't undo the delivery: the WETH stays wrapped, and the next delivery of WETH uses it first.
  const second = await open({ originAsset: B_WETH, destinationAsset: MNBTC, amount: "10000000000000000", refundTo: ADDRESS, recipient: ACCOUNT });
  evm.deposit(WETH, ADDRESS, 10_000_000_000_000_000n);
  evm.block += 5;
  await engine.tick();
  clock.now += 22_000;
  evm.failNext = "unwrapping would fail: over rate limit";
  await engine.tick();
  assert.equal(engine.find(evm.address, second.correlationId)!.status, "SUCCESS");
  assert.match(logs.at(-1)!, /the 0\.01 WETH that came back stays wrapped \(unwrapping would fail: over rate limit\); the next delivery of WETH uses it first/);

  // The fault switch forces a refund: the USDC goes back from the float to the address it came from.
  engine.setFault({ mode: "refund", delaySeconds: 600 });
  const third = await open({ originAsset: B_USDC, destinationAsset: MUSDC, amount: "5000000", refundTo: ADDRESS, recipient: ACCOUNT });
  evm.deposit(USDC, ADDRESS, 5_000_000n);
  evm.block += 5;
  await engine.tick();
  clock.now += 22_000;
  await engine.tick();
  const refundedSwap = engine.find(evm.address, third.correlationId)!;
  assert.deepEqual([refundedSwap.status, refundedSwap.refundedAmount], ["REFUNDED", "5000000"]);
  assert.deepEqual(evm.sent.at(-1), { kind: "transfer", token: USDC, to: ADDRESS, amount: 5_000_000n });
  assert.deepEqual(engine.statusOf(refundedSwap).swapDetails.originChainTxHashes.at(-1)?.explorerUrl, "https://sepolia.basescan.org/tx/0xbase2");
});

test("USDC and WBTC to Aave's chain come from the float, and from Aave's faucet for what it is short of", async () => {
  const { engine, near, evm, clock, open } = setup();
  evm.balances.set(USDC, 10_000_000n);
  const quote = await open({ originAsset: MUSDC, destinationAsset: B_USDC, amount: "25000000", refundTo: ACCOUNT, recipient: ADDRESS, customRecipientMsg: '{"pb":{"transfer":"move:4"}}' });
  near.credit("musdc.pbf-ops.testnet", quote.quote.depositAddress!, 25_000_000n);
  await engine.tick();
  clock.now += 22_000;
  await engine.tick();
  assert.equal(engine.find(quote.quote.depositAddress!)!.status, "SUCCESS");
  assert.deepEqual(evm.sent, [
    { kind: "mint", token: USDC, amount: 14_992_500n },
    { kind: "transfer", token: USDC, to: ADDRESS, amount: 24_992_500n },
  ]);
  // A faucet that refuses when the delivery is due fails the swap in its own words; nothing is lost on NEAR.
  evm.room[WBTC] = 2_500_000_000n;
  const btc = await open({ originAsset: MNBTC, destinationAsset: B_WBTC, amount: "55000", refundTo: ACCOUNT, recipient: ADDRESS });
  near.credit("mnbtc.pbf-ops.testnet", btc.quote.depositAddress!, 55_000n);
  await engine.tick();
  clock.now += 22_000;
  evm.mintRefusal = "execution reverted";
  await engine.tick();
  const failed = engine.find(btc.quote.depositAddress!)!;
  assert.deepEqual([failed.status, failed.reason], ["FAILED", "delivery failed: Aave's faucet minting would fail: execution reverted"]);
});

test("the float's own wallet: selectors from their signatures, a type 2 transaction signed as the backend signs it, and a nonce read again when the other process took it", async () => {
  const sha3 = (text: string) => bytesToHex(keccak_256(utf8ToBytes(text)));
  for (const [name, call] of Object.entries(EVM_CALLS)) assert.equal(`0x${sha3(call.signature).slice(0, 8)}`, call.selector, name);
  assert.equal(`0x${sha3(TRANSFER_EVENT)}`, TRANSFER_TOPIC);
  // Hardhat's first test account, a key every Ethereum developer knows; the bytes are what services/api's signer gives
  // for the same transaction, and its decoder is checked against a transaction Base Sepolia mined.
  const key = Uint8Array.from(Buffer.from("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "hex"));
  assert.equal(addressOfKey(key), "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  const data = callData(EVM_CALLS.transfer.selector, ["0x1111111111111111111111111111111111111111", 20_000_000_000_000_000n]);
  const signed = signEvmTx({ chainId: 84_532n, nonce: 7n, tip: 1_000_000n, maxFee: 11_000_000n, gasLimit: 90_000n, to: WETH, value: 0n, data }, key);
  assert.equal(
    signed.raw,
    "0x02f8b183014a3407830f424083a7d8c083015f9094420000000000000000000000000000000000000680b844a9059cbb000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000470de4df820000c080a0af4935bba739737e8c7d5480f0aac76c0c03faf97b08b8ba0b118a7a954d443ca018b0447227783752ed29e57e49a3bf9e6ed9c2d8345cf3451a62ddfb0b7de709",
  );
  assert.equal(signed.hash, "0x8a560fe3fe4e00f457160cc5a3f288d426c909945ec6e5acd0a448540d1bdb75");

  // A made-up node. The backend's gas helper takes nonce 11 between this float's read and its send.
  const asked: { method: string; params: unknown[] }[] = [];
  let pending = 11;
  let refusals = ["nonce too low: next nonce 12, tx nonce 11"];
  let receiptStatus = "0x1";
  let chain = "0x14a34";
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    asked.push({ method, params });
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    const refuse = (message: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32_000, message } }), { status: 200 });
    switch (method) {
      case "eth_chainId":
        return reply(chain);
      case "eth_estimateGas":
        return (params[0] as { data: string }).data.startsWith("0xc6c3bbe6") && refusals.includes("faucet") ? refuse("execution reverted: Error: Mint limit transaction exceeded") : reply("0xea60");
      case "eth_getTransactionCount":
        assert.deepEqual(params, ["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", "pending"]);
        return reply(`0x${pending.toString(16)}`);
      case "eth_getBlockByNumber":
        return reply({ baseFeePerGas: "0x4c4b40" });
      case "eth_maxPriorityFeePerGas":
        return reply("0xf4240");
      case "eth_sendRawTransaction": {
        const refusal = refusals.find((r) => r !== "faucet");
        if (!refusal) return reply(`0x${createHash("sha256").update(String(params[0])).digest("hex")}`);
        refusals = refusals.filter((r) => r !== refusal);
        pending += 1; // the other process's transaction is in
        return refuse(refusal);
      }
      case "eth_getTransactionReceipt":
        return reply({ status: receiptStatus, logs: [{ address: BASE_TOKENS.usdc, topics: [TRANSFER_TOPIC, `0x${"0".repeat(24)}${ADDRESS.slice(2)}`, `0x${"0".repeat(24)}f39fd6e51aad88f6f4ce6ab8827279cfffb92266`], data: "0x15f7594", transactionHash: `0x${"AB".repeat(32)}`, logIndex: "0x2", blockNumber: "0x365c100" }] });
      case "eth_getLogs": {
        const filter = params[0] as { fromBlock: string; toBlock: string };
        return Number(BigInt(filter.toBlock)) - Number(BigInt(filter.fromBlock)) >= 200 ? refuse("eth_getLogs is limited to a 200 range") : reply([]);
      }
      case "eth_call": {
        const callData_ = (params[0] as { data: string }).data;
        // getReserveCaps: a borrow cap of 50 and a supply cap of 175 whole WBTC; getATokenTotalSupply: 175 supplied.
        return reply(callData_.startsWith("0x46fbe558") ? `0x${(50).toString(16).padStart(64, "0")}${(175).toString(16).padStart(64, "0")}` : `0x${(17_500_000_000).toString(16).padStart(64, "0")}`);
      }
      default:
        throw new Error(`unexpected ${method}`);
    }
  }) as typeof fetch;
  const float = evmFloat({ rpcUrl: "https://sepolia.base.org/v1/secret", chainId: 84_532, privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", weth: WETH, faucet: "0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc", dataProvider: "0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b", fetch: fetchImpl, sleep: async () => {} });
  assert.equal(float.address, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");

  await float.transfer(WETH, ADDRESS, 20_000_000_000_000_000n);
  const sends = asked.filter((a) => a.method === "eth_sendRawTransaction");
  assert.equal(sends.length, 2, "refused once, sent again");
  // Each try read the pending nonce right before signing: 11 the first time, 12 the second. (0x0b and 0x0c in the bytes.)
  assert.deepEqual(asked.filter((a) => a.method === "eth_getTransactionCount").length, 2);
  assert.deepEqual(sends.map((s) => String(s.params[0]).slice(16, 18)), ["0b", "0c"]);

  // A transaction that is mined and reverted, a node that refuses for another reason, and a node on another chain.
  receiptStatus = "0x0";
  await assert.rejects(float.wrap(5n), /^Error: wrapping 5 wei of the float's test ETH was mined and reverted \(0x[0-9a-f]{64}\)$/);
  receiptStatus = "0x1";
  refusals = ["insufficient funds for gas * price + value"];
  await assert.rejects(float.unwrap(5n), /^Error: unwrapping 5 wei of WETH was refused by the node: eth_sendRawTransaction: insufficient funds for gas \* price \+ value$/);
  refusals = ["faucet"];
  assert.equal(await float.mintProblem(USDC, 1n), "eth_estimateGas: execution reverted: Error: Mint limit transaction exceeded");
  await assert.rejects(float.mint(USDC, 1n), /Aave's faucet minting 1 units of 0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f would fail: eth_estimateGas: execution reverted: Error: Mint limit transaction exceeded/);
  refusals = [];
  assert.equal(await float.mintProblem(USDC, 1n), null);

  // Reads: Aave's room (a full cap is 0), a receipt's transfers into the float, and a log read that keeps to 200 blocks.
  assert.equal(await float.aaveRoom(WBTC, 8), 0n);
  assert.deepEqual(await float.receiptTransfers(`0x${"ab".repeat(32)}`), [{ hash: `0x${"ab".repeat(32)}`, logIndex: 2, block: 57_000_192, token: USDC, from: ADDRESS, amount: 23_033_236n }]);
  assert.deepEqual(await float.incoming(USDC, 100, 299), []);
  await assert.rejects(float.incoming(USDC, 100, 300), /eth_getLogs covers at most 200 blocks, and 100 to 300 was asked for/);
  const logs = asked.find((a) => a.method === "eth_getLogs")!.params[0] as { address: string; topics: (string | null)[] };
  assert.deepEqual([logs.address, logs.topics], [USDC, [TRANSFER_TOPIC, null, `0x${"0".repeat(24)}f39fd6e51aad88f6f4ce6ab8827279cfffb92266`]]);

  chain = "0x2105";
  const mainnet = evmFloat({ rpcUrl: "https://sepolia.base.org/v1/secret", chainId: 84_532, privateKey: "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", weth: WETH, faucet: WETH, dataProvider: WETH, fetch: fetchImpl, sleep: async () => {} });
  const before = asked.filter((a) => a.method === "eth_sendRawTransaction").length;
  await assert.rejects(mainnet.transfer(WETH, ADDRESS, 1n), (e: Error) => /EVM_RPC_URL \(sepolia\.base\.org\) answers for chain 8453, and the stand-in is set to chain 84532/.test(e.message) && !e.message.includes("secret"));
  assert.equal(asked.filter((a) => a.method === "eth_sendRawTransaction").length, before, "nothing is sent to another chain");
  assert.throws(() => evmFloat({ rpcUrl: "https://sepolia.base.org", chainId: 84_532, privateKey: "0xabc", weth: WETH, faucet: WETH, dataProvider: WETH }), (e: Error) => e.message === "EVM_GAS_PRIVATE_KEY isn't a 32-byte key in hex (64 hex digits)");
});
