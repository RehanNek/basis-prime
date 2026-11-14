// INTERFACES.md 49: five test tokens swap on NEAR (the Spot page). The floats, the chain and the real 1Click are made
// up here; nothing touches a network. Amounts are whole units in BigInt, with 6, 8, 18 and 24 decimals.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { QuoteRequest } from "@pb/oneclick";

import { formatUnits, NEAR_TWINS, shimAssets, type ShimAsset } from "./assets.js";
import { shimConfig } from "./config.js";
import { Engine } from "./engine.js";
import { ASSETS_FIVE, FakeHl, FakeNearWithMint, fakeSpotUpstream, HL_USDC, METH, MNBTC, MUSDC, MUSDT, MWNEAR, NEAR_LIST, NEAR_PRICES_E12, request, SPOT_TOKENS, spotOut } from "./fakes.js";
import { convertAtListPrices, LIST_PRICE_SECONDS, listPriceCovers, listPriceQuote, listPriceUnits } from "./near-routes.js";
import { deployProbe, ftDecimals, RECHECK_MS } from "./near-tokens.js";
import { createShimServer } from "./server.js";
import { Store } from "./state.js";

const ACCOUNT = "a.pbf.testnet";
const FIVE = [MUSDC, MNBTC, METH, MWNEAR, MUSDT];
/** One amount for each token, every digit of it meaning something: 1Click's own amounts for $50 on 13 Nov. */
const AMOUNT: Record<string, string> = {
  [MUSDC]: "50021909",
  [MNBTC]: "72526",
  [METH]: "25704297758585232",
  [MWNEAR]: "14164305949008498960367616",
  [MUSDT]: "50034073",
};
const asset = (id: string): ShimAsset => ASSETS_FIVE.find((a) => a.assetId === id)!;
const TOO_LOW = { status: 400, body: { message: "Amount is too low for bridge, try at least 7" } };

/**
 * The stand-in over a real local socket: the engine with a made-up float and a clock the test moves, the made-up
 * 1Click, and the chain's answer for each of section 49's tokens (`chain`: the decimals its contract gives, null
 * while there is none; all three deployed unless the test says otherwise).
 */
async function setup(options: { chain?: Record<string, number | null> } = {}) {
  const near = new FakeNearWithMint();
  const clock = { now: 1_800_000_000_000 };
  const logs: string[] = [];
  const upstream = fakeSpotUpstream();
  const chain: Record<string, number | null> = options.chain ?? { [SPOT_TOKENS.meth]: 18, [SPOT_TOKENS.mwnear]: 24, [SPOT_TOKENS.musdt]: 6 };
  const asked: string[] = [];
  const chainFails = { message: undefined as string | undefined };
  const deployed = deployProbe(async (contract) => {
    asked.push(contract);
    if (chainFails.message) throw new Error(chainFails.message);
    return chain[contract] ?? null;
  }, () => clock.now);
  const engine = new Engine({ store: new Store(), assets: ASSETS_FIVE, near, hl: new FakeHl(), now: () => clock.now, log: (l) => logs.push(l) });
  const server = createShimServer({ engine, upstream: upstream.client, assets: ASSETS_FIVE, floats: { near: true, hl: false }, deployed, adminToken: undefined, now: () => clock.now, log: (l) => logs.push(l) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  /** A swap request from the account, with the quote's deadline ten minutes ahead on the test's clock. */
  const swap = (from: string, to: string, overrides: Partial<QuoteRequest> = {}) =>
    request({ originAsset: from, destinationAsset: to, amount: AMOUNT[from]!, refundTo: ACCOUNT, recipient: ACCOUNT, deadline: new Date(clock.now + 600_000).toISOString(), ...overrides });
  const quote = (body: QuoteRequest) => call("POST", "/v0/quote", body);
  return { near, clock, logs, upstream, chain, asked, chainFails, engine, server, call, swap, quote };
}

test("the five NEAR test tokens are priced as 1Click's own USDC, BTC, ETH, wNEAR and USDT on NEAR, with the same decimals", () => {
  assert.deepEqual(
    ASSETS_FIVE.map((a) => [a.assetId, a.symbol, a.decimals, a.contract, a.mainnetAssetId, a.checkDeployed ?? false]),
    [
      ["nep141:musdc.pbf-ops.testnet", "mUSDC", 6, "musdc.pbf-ops.testnet", "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", false],
      ["nep141:mnbtc.pbf-ops.testnet", "mNBTC", 8, "mnbtc.pbf-ops.testnet", "nep141:nbtc.bridge.near", false],
      [HL_USDC, "USDC", 8, "USDC:0xeb62eee3685fc4c43992febcd9e75443", "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054", false],
      ["nep141:meth.pbf-ops.testnet", "ETH", 18, "meth.pbf-ops.testnet", "nep141:eth.bridge.near", true],
      ["nep141:mwnear.pbf-ops.testnet", "wNEAR", 24, "mwnear.pbf-ops.testnet", "nep141:wrap.near", true],
      ["nep141:musdt.pbf-ops.testnet", "USDT", 6, "musdt.pbf-ops.testnet", "nep141:usdt.tether-token.near", true],
    ],
  );
  // Each twin is a row of 1Click's own list on NEAR, with the test token's decimals, so amounts carry over unchanged.
  for (const id of FIVE) {
    const row = NEAR_LIST.find((t) => t.assetId === asset(id).mainnetAssetId);
    assert.deepEqual([row?.blockchain, row?.decimals], ["near", asset(id).decimals], id);
  }
  assert.deepEqual(Object.values(NEAR_TWINS).sort(), NEAR_LIST.map((t) => t.assetId).sort());
  // Without the three new ids the stand-in has the assets it always had, in the same order.
  assert.deepEqual(shimAssets({ musdc: "musdc.pbf-ops.testnet", mnbtc: "mnbtc.pbf-ops.testnet" }), ASSETS_FIVE.slice(0, 3));
  // The ids come from the settings, with defaults; no other setting changes.
  assert.deepEqual(shimConfig({}).tokens, SPOT_TOKENS);
  assert.deepEqual(shimConfig({ METH_TOKEN_ID: "eth.x.testnet", MWNEAR_TOKEN_ID: "near.x.testnet", MUSDT_TOKEN_ID: "usdt.x.testnet" }).tokens, { musdc: "musdc.pbf-ops.testnet", mnbtc: "mnbtc.pbf-ops.testnet", meth: "eth.x.testnet", mwnear: "near.x.testnet", musdt: "usdt.x.testnet" });
});

test("every direction among the five: priced by the real 1Click for the two twins, a deposit address of its own, delivered in whole units after the quoted time with the request's msg", async () => {
  const s = await setup();
  try {
    let pairs = 0;
    for (const from of FIVE) {
      for (const to of FIVE.filter((id) => id !== from)) {
        pairs += 1;
        const [origin, destination] = [asset(from), asset(to)];
        const msg = JSON.stringify({ pb: { transfer: `move:${pairs}` } });
        const amountIn = BigInt(AMOUNT[from]!);
        const expected = spotOut(amountIn, origin.mainnetAssetId, destination.mainnetAssetId);
        assert.ok(expected > 0n, `${from} to ${to}`);

        s.upstream.state.quotes.length = 0;
        const committed = await s.quote(s.swap(from, to, { customRecipientMsg: msg }));
        assert.equal(committed.status, 201, `${from} to ${to}: ${committed.body.message}`);
        // The real 1Click was asked for a price only, for the mainnet twins, with placeholder parties and no msg.
        const asked = s.upstream.state.quotes[0]!;
        assert.deepEqual([asked.dry, asked.originAsset, asked.destinationAsset, asked.amount, asked.recipient, asked.refundTo, asked.customRecipientMsg], [true, origin.mainnetAssetId, destination.mainnetAssetId, AMOUNT[from], "aurora", "aurora", undefined]);
        assert.equal(committed.body.shim, undefined, "1Click's own price: no note");
        assert.deepEqual([committed.body.quote.amountIn, committed.body.quote.amountOut], [AMOUNT[from], expected.toString()]);
        assert.deepEqual([committed.body.quoteRequest.originAsset, committed.body.quoteRequest.destinationAsset], [from, to]);
        const address = committed.body.quote.depositAddress as string;
        assert.match(address, /^[0-9a-f]{64}$/);

        // The deposit is seen at the quote's own address; nothing leaves before the quoted 20 s.
        s.near.credit(origin.contract, address, amountIn);
        await s.engine.tick();
        assert.equal(s.engine.find(address)!.status, "PROCESSING");
        s.clock.now += 19_000;
        await s.engine.tick();
        assert.equal(s.engine.find(address)!.status, "PROCESSING");
        s.clock.now += 1_000;
        await s.engine.tick();

        const status = (await s.call("GET", `/v0/status?depositAddress=${address}`)).body;
        assert.equal(status.status, "SUCCESS", `${from} to ${to}: ${status.swapDetails?.refundReason}`);
        assert.deepEqual(s.near.transfers.at(-1), { token: destination.contract, receiverId: ACCOUNT, amount: expected, msg, memo: `1click-shim ${committed.body.correlationId}` });
        assert.deepEqual(
          [status.swapDetails.depositedAmount, status.swapDetails.depositedAmountFormatted, status.swapDetails.amountOut, status.swapDetails.amountOutFormatted],
          [AMOUNT[from], formatUnits(amountIn, origin.decimals), expected.toString(), formatUnits(expected, destination.decimals)],
        );
      }
    }
    assert.equal(pairs, 20);
    // Three of them by hand (Python's whole numbers), so the arithmetic above isn't checking itself: 24, 18 and 8 decimals.
    assert.equal(spotOut(50_021_909n, NEAR_TWINS.usdc, NEAR_TWINS.wnear), 14_121_812_862_789_355_807_365_439n);
    assert.equal(spotOut(14_164_305_949_008_498_960_367_616n, NEAR_TWINS.wnear, NEAR_TWINS.eth), 25_627_184_865_309_480n);
    assert.equal(spotOut(25_704_297_758_585_232n, NEAR_TWINS.eth, NEAR_TWINS.nbtc), 72_309n);
    assert.equal(formatUnits(14_164_305_949_008_498_960_367_616n, 24), "14.164305949008498960367616");
    assert.equal(formatUnits(14_121_812_862_789_355_807_365_439n, 24), "14.121812862789355807365439");
  } finally {
    s.server.close();
  }
});

test("a dry quote among the five is a price only, and the listing has the five once they are deployed", async () => {
  const s = await setup();
  try {
    const dry = await s.quote(s.swap(MWNEAR, METH, { dry: true }));
    assert.equal(dry.status, 201);
    assert.deepEqual([dry.body.quote.amountOut, dry.body.quote.depositAddress, dry.body.quote.timeEstimate], ["25627184865309480", undefined, 20]);
    assert.equal(dry.body.quoteRequest.originAsset, MWNEAR);
    const list = (await s.call("GET", "/v0/tokens")).body as unknown as { assetId: string; symbol: string; decimals: number; price: number; contractAddress: string }[];
    assert.deepEqual(list.map((t) => [t.assetId, t.symbol, t.decimals, t.price, t.contractAddress]), [
      [MUSDC, "mUSDC", 6, 0.999562, "musdc.pbf-ops.testnet"],
      [MNBTC, "mNBTC", 8, 68940, "mnbtc.pbf-ops.testnet"],
      [HL_USDC, "USDC", 8, 0, "USDC:0xeb62eee3685fc4c43992febcd9e75443"],
      [METH, "ETH", 18, 1945.2, "meth.pbf-ops.testnet"],
      [MWNEAR, "wNEAR", 24, 3.53, "mwnear.pbf-ops.testnet"],
      [MUSDT, "USDT", 6, 0.999319, "musdt.pbf-ops.testnet"],
    ]);
  } finally {
    s.server.close();
  }
});

test("when 1Click gives no quote, a swap that touches a new token is priced from 1Click's token list, in whole units, and the quote says so", async () => {
  const s = await setup();
  try {
    s.upstream.state.refuse = TOO_LOW;
    // [from, to, amount in, amount out, the least out at 1% slippage, dollars in, dollars out]: Python's whole numbers.
    const cases: [string, string, string, string, string, string, string][] = [
      [MUSDC, METH, "1000", "513860785523", "508722177667", "0.000999562", "0.000999561999"],
      [MUSDT, MWNEAR, "1000", "283093201133144475920", "280262269121813031160", "0.000999319", "0.000999318999"],
      [MWNEAR, METH, "14164305949008498960367616", "25704297758585236", "25447254780999383", "50", "50"],
      [METH, MWNEAR, "25704297758585232", "14164305949008496681699716", "14022662889518411714882718", "49.999999999999", "49.999999999999"],
      [MNBTC, MUSDT, "3", "2069", "2048", "0.0020682", "0.002067591011"],
    ];
    for (const [from, to, amount, out, least, usdIn, usdOut] of cases) {
      const dry = await s.quote(s.swap(from, to, { dry: true, amount }));
      assert.equal(dry.status, 201, `${from} to ${to}: ${dry.body.message}`);
      const q = dry.body.quote;
      assert.deepEqual([q.amountIn, q.amountOut, q.minAmountOut, q.amountInUsd, q.amountOutUsd, q.timeEstimate, q.depositAddress], [amount, out, least, usdIn, usdOut, LIST_PRICE_SECONDS, undefined], `${from} to ${to}`);
      assert.deepEqual([q.amountInFormatted, q.amountOutFormatted], [formatUnits(amount, asset(from).decimals), formatUnits(out, asset(to).decimals)]);
      assert.deepEqual([dry.body.shim.price, dry.body.shim.said, dry.body.shim.asked, dry.body.shim.delivers, dry.body.shim.symbol], ["token_list", "Amount is too low for bridge, try at least 7", to, to, asset(to).symbol]);
    }
    const note = (await s.quote(s.swap(MUSDC, METH, { dry: true, amount: "1000" }))).body.shim;
    assert.equal(note.why, `1Click gave no quote for this ("Amount is too low for bridge, try at least 7"), so the price is from 1Click's token list: mUSDC at $0.999562 and ETH at $1945.2, with no cost taken off`);
    assert.deepEqual(note.usd, { origin: 0.999562, destination: 1945.2, originUpdatedAt: "2026-11-13T19:09:01.190Z", destinationUpdatedAt: "2026-11-13T19:09:01.190Z" });

    // A committed one lives the same life, and its status keeps the note.
    const msg = JSON.stringify({ pb: { deposit: {} } });
    const committed = await s.quote(s.swap(MUSDC, METH, { amount: "1000", customRecipientMsg: msg }));
    assert.deepEqual([committed.status, committed.body.shim.price, committed.body.quote.amountOut], [201, "token_list", "513860785523"]);
    const address = committed.body.quote.depositAddress as string;
    s.near.credit("musdc.pbf-ops.testnet", address, 1000n);
    await s.engine.tick();
    s.clock.now += LIST_PRICE_SECONDS * 1000;
    await s.engine.tick();
    const status = (await s.call("GET", `/v0/status?depositAddress=${address}`)).body;
    assert.deepEqual([status.status, status.swapDetails.amountOut, status.shim.note.price], ["SUCCESS", "513860785523", "token_list"]);
    assert.deepEqual(s.near.transfers.at(-1), { token: "meth.pbf-ops.testnet", receiverId: ACCOUNT, amount: 513_860_785_523n, msg, memo: `1click-shim ${committed.body.correlationId}` });
  } finally {
    s.server.close();
  }
});

test("no price is made up: without a list price, for mUSDC and mNBTC between themselves, or when 1Click fails otherwise, its answer goes back as it came", async () => {
  const s = await setup();
  try {
    s.upstream.state.refuse = TOO_LOW;
    // mUSDC and mNBTC between themselves answer what they answered before section 49, and the list isn't even read.
    for (const [from, to] of [[MUSDC, MNBTC], [MNBTC, MUSDC]] as const) {
      const old = await s.quote(s.swap(from, to, { dry: true, amount: "3" }));
      assert.deepEqual([old.status, old.body], [400, TOO_LOW.body]);
    }
    assert.equal(s.upstream.state.listReads, 0);

    // The list has no price for ETH (or a price of 0), or can't be read: 1Click's refusal, as it came.
    s.upstream.state.list = NEAR_LIST.filter((t) => t.assetId !== NEAR_TWINS.eth);
    assert.deepEqual((await s.quote(s.swap(MUSDC, METH, { dry: true, amount: "1000" }))).body, TOO_LOW.body);
    s.upstream.state.list = NEAR_LIST.map((t) => (t.assetId === NEAR_TWINS.eth ? { ...t, price: 0 } : t));
    assert.deepEqual((await s.quote(s.swap(METH, MUSDT, { dry: true, amount: "1000" }))).body, TOO_LOW.body);
    s.upstream.state.listFails = true;
    const unread = await s.quote(s.swap(MUSDC, METH, { dry: true, amount: "1000" }));
    assert.deepEqual([unread.status, unread.body], [400, TOO_LOW.body]);
    s.upstream.state.listFails = false;
    s.upstream.state.list = NEAR_LIST;

    // A slippage that isn't whole basis points may be what 1Click refused: no fallback.
    assert.deepEqual((await s.quote(s.swap(MUSDC, METH, { dry: true, amount: "1000", slippageTolerance: 1.5 }))).body, TOO_LOW.body);

    // 1Click failing in another way (not a refusal of the pair or the amount) is passed on too.
    s.upstream.state.refuse = { status: 500, body: { message: "Internal server error" } };
    const broken = await s.quote(s.swap(MUSDC, METH, { dry: true, amount: "1000" }));
    assert.deepEqual([broken.status, broken.body], [500, { message: "Internal server error" }]);

    // Worth less than the smallest unit of what would arrive: refused in words, never rounded up.
    s.upstream.state.refuse = TOO_LOW;
    const dust = await s.quote(s.swap(MWNEAR, MNBTC, { dry: true, amount: "1" }));
    assert.equal(dust.status, 400);
    assert.match(dust.body.message, /^That is too little wNEAR to arrive as any mNBTC: 1Click gave no quote for it \("Amount is too low for bridge, try at least 7"\)/);
  } finally {
    s.server.close();
  }
});

test("the list-price arithmetic is whole numbers end to end", () => {
  // A list price is read as a decimal with 12 places.
  assert.deepEqual([0.999562, 68940, 1945.2, 3.53, 0.999319].map(listPriceUnits), Object.values(NEAR_PRICES_E12).map((t) => t.price));
  assert.deepEqual([0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1", undefined, 1e-13, 1e15].map(listPriceUnits), [null, null, null, null, null, null, null, null]);
  const [usdc, eth, wnear] = [NEAR_PRICES_E12[NEAR_TWINS.usdc]!, NEAR_PRICES_E12[NEAR_TWINS.eth]!, NEAR_PRICES_E12[NEAR_TWINS.wnear]!];
  assert.equal(convertAtListPrices(50_021_909n, 6, usdc.price, 24, wnear.price), 14_164_305_780_129_745_042_492_917n);
  assert.equal(convertAtListPrices(14_164_305_949_008_498_960_367_616n, 24, wnear.price, 18, eth.price), 25_704_297_758_585_236n);
  // A million whole wNEAR, far past what a double holds exactly, to the last yoctoNEAR's worth.
  assert.equal(convertAtListPrices(10n ** 30n + 1n, 24, wnear.price, 6, usdc.price), 3_531_546_817_506n);
  // Which pairs fall back: a swap on NEAR with at least one of the three new tokens.
  const a = (id: string) => asset(id);
  assert.deepEqual([listPriceCovers(a(MUSDC), a(METH)), listPriceCovers(a(MWNEAR), a(MUSDT)), listPriceCovers(a(MUSDC), a(MNBTC)), listPriceCovers(a(METH), a(HL_USDC))], [true, true, false, false]);
  // The quote itself: the least out follows the request's slippage, and nothing is returned without both prices.
  const built = listPriceQuote(request({ originAsset: MUSDC, destinationAsset: MWNEAR, amount: "50021909", slippageTolerance: 250 }), a(MUSDC), a(MWNEAR), NEAR_LIST, "No liquidity", 1_800_000_000_000)!;
  assert.deepEqual([built.priced.quote.amountOut, built.priced.quote.minAmountOut, built.priced.timestamp], ["14164305780129745042492917", "13810198135626501416430594", "2027-01-15T08:00:00.000Z"]);
  assert.equal(listPriceQuote(request({ originAsset: MUSDC, destinationAsset: MWNEAR }), a(MUSDC), a(MWNEAR), [], "No liquidity", 0), null);
});

test("a float short of a test token mints what is missing, for a delivery and for a refund, and nothing when it holds enough", async () => {
  const s = await setup();
  try {
    const FLOAT = s.near.accountId;
    const run = async (from: string, to: string, overrides: Partial<QuoteRequest> = {}) => {
      const committed = await s.quote(s.swap(from, to, overrides));
      assert.equal(committed.status, 201, committed.body.message);
      s.near.credit(asset(from).contract, committed.body.quote.depositAddress, BigInt(AMOUNT[from]!));
      await s.engine.tick();
      s.clock.now += 20_000;
      await s.engine.tick();
      return { committed: committed.body, swap: s.engine.find(committed.body.quote.depositAddress)! };
    };

    // 24 decimals: the float holds no test wNEAR, so the token's faucet mints the whole delivery.
    const toNear = await run(MUSDC, MWNEAR);
    const nearOut = 14_121_812_862_789_355_807_365_439n;
    assert.equal(toNear.swap.status, "SUCCESS");
    assert.deepEqual(s.near.minted, [{ token: "mwnear.pbf-ops.testnet", amount: nearOut }]);
    assert.equal(s.near.transfers.at(-1)!.amount, nearOut);

    // 18 decimals: the float holds 0.01 test ETH of the 0.0256 it must deliver, so only the rest is minted.
    s.near.credit("meth.pbf-ops.testnet", FLOAT, 10_000_000_000_000_000n);
    const toEth = await run(MWNEAR, METH);
    assert.equal(toEth.swap.status, "SUCCESS");
    assert.deepEqual(s.near.minted.at(-1), { token: "meth.pbf-ops.testnet", amount: 25_627_184_865_309_480n - 10_000_000_000_000_000n });
    assert.equal(s.near.transfers.at(-1)!.amount, 25_627_184_865_309_480n);

    // It holds enough test USDT: nothing is minted.
    s.near.credit("musdt.pbf-ops.testnet", FLOAT, 1_000_000_000n);
    const before = s.near.minted.length;
    assert.equal((await run(MUSDC, MUSDT)).swap.status, "SUCCESS");
    assert.equal(s.near.minted.length, before);

    // A refund comes out of the float too (the deposit stays at its address): the float holds no mNBTC here, so it
    // mints the amount and sends it back with the quote's msg.
    s.engine.setFault({ mode: "refund", delaySeconds: 600 });
    const msg = JSON.stringify({ pb: { transfer: "move:7" } });
    const refunded = await run(MNBTC, METH, { customRecipientMsg: msg });
    assert.deepEqual([refunded.swap.status, refunded.swap.refundedAmount], ["REFUNDED", "72526"]);
    assert.deepEqual(s.near.minted.at(-1), { token: "mnbtc.pbf-ops.testnet", amount: 72_526n });
    assert.deepEqual(s.near.transfers.at(-1), { token: "mnbtc.pbf-ops.testnet", receiverId: ACCOUNT, amount: 72_526n, msg, memo: `1click-shim refund ${refunded.committed.correlationId}` });
  } finally {
    s.server.close();
  }
});

test("the fault switch on a swap among the five: a refund of 24-decimal units with the msg, a failure, and a late delivery", async () => {
  const s = await setup();
  try {
    const msg = JSON.stringify({ pb: { transfer: "move:3" } });
    const open = async (from: string, to: string) => {
      const committed = await s.quote(s.swap(from, to, { customRecipientMsg: msg }));
      s.near.credit(asset(from).contract, committed.body.quote.depositAddress, BigInt(AMOUNT[from]!));
      await s.engine.tick();
      return committed.body;
    };
    const statusOf = async (q: Record<string, any>) => (await s.call("GET", `/v0/status?depositAddress=${q.quote.depositAddress}`)).body;

    s.engine.setFault({ mode: "refund", delaySeconds: 600 });
    const refund = await open(MWNEAR, MUSDT);
    s.clock.now += 20_000;
    await s.engine.tick();
    const refunded = await statusOf(refund);
    assert.deepEqual([refunded.status, refunded.swapDetails.refundedAmount, refunded.swapDetails.refundedAmountFormatted, refunded.shim.fault], ["REFUNDED", "14164305949008498960367616", "14.164305949008498960367616", "refund"]);
    assert.deepEqual(s.near.transfers.at(-1), { token: "mwnear.pbf-ops.testnet", receiverId: ACCOUNT, amount: 14_164_305_949_008_498_960_367_616n, msg, memo: `1click-shim refund ${refund.correlationId}` });

    s.engine.setFault({ mode: "fail", delaySeconds: 600 });
    const sent = s.near.transfers.length;
    const fail = await open(METH, MNBTC);
    s.clock.now += 20_000;
    await s.engine.tick();
    assert.equal((await statusOf(fail)).status, "FAILED");
    assert.equal(s.near.transfers.length, sent, "nothing moved");

    s.engine.setFault({ mode: "late", delaySeconds: 90 });
    const late = await open(MUSDT, METH);
    s.clock.now += 20_000 + 89_000;
    await s.engine.tick();
    assert.equal((await statusOf(late)).status, "PROCESSING");
    s.clock.now += 1_000;
    await s.engine.tick();
    assert.equal((await statusOf(late)).status, "SUCCESS");
    assert.deepEqual([s.near.transfers.at(-1)!.token, s.near.transfers.at(-1)!.amount, s.near.transfers.at(-1)!.msg], ["meth.pbf-ops.testnet", spotOut(50_034_073n, NEAR_TWINS.usdt, NEAR_TWINS.eth), msg]);

    // A deposit short of amountIn at the deadline: the part that came goes back, in the origin's own units.
    s.engine.setFault({ mode: "none", delaySeconds: 600 });
    const short = (await s.quote(s.swap(METH, MWNEAR))).body;
    s.near.credit("meth.pbf-ops.testnet", short.quote.depositAddress, 5_704_297_758_585_232n);
    await s.engine.tick();
    assert.equal((await statusOf(short)).status, "KNOWN_DEPOSIT_TX");
    s.clock.now += 10 * 60_000 + 31_000;
    await s.engine.tick();
    const incomplete = await statusOf(short);
    assert.deepEqual([incomplete.status, incomplete.swapDetails.refundedAmount], ["INCOMPLETE_DEPOSIT", "5704297758585232"]);
    assert.match(incomplete.swapDetails.refundReason, /^only 0\.005704297758585232 ETH of 0\.025704297758585232 arrived before the deadline$/);
  } finally {
    s.server.close();
  }
});

test("before the three tokens are deployed: mUSDC and mNBTC swap as before, the others are refused in words, and each starts to swap once its contract is there", async () => {
  const s = await setup({ chain: {} });
  try {
    // The two that exist: priced and committed as before, and the chain is never asked about them.
    const old = await s.quote(s.swap(MUSDC, MNBTC));
    assert.equal(old.status, 201);
    assert.match(old.body.quote.depositAddress, /^[0-9a-f]{64}$/);
    assert.equal((await s.quote(s.swap(MNBTC, MUSDC, { dry: true }))).status, 201);
    assert.deepEqual(s.asked, []);
    // The listing is today's three.
    const list = async () => ((await s.call("GET", "/v0/tokens")).body as unknown as { symbol: string }[]).map((t) => t.symbol);
    assert.deepEqual(await list(), ["mUSDC", "mNBTC", "USDC"]);

    // The others: refused, dry or not, whichever side names them, before 1Click is asked anything.
    s.upstream.state.quotes.length = 0;
    const refusals: [string, string, boolean, string][] = [
      [MUSDC, METH, true, "Test ETH isn't on testnet yet: no token contract is deployed at meth.pbf-ops.testnet. Until it is, the stand-in swaps mUSDC and mNBTC only"],
      [MUSDC, METH, false, "Test ETH isn't on testnet yet: no token contract is deployed at meth.pbf-ops.testnet. Until it is, the stand-in swaps mUSDC and mNBTC only"],
      [MWNEAR, MUSDC, false, "Test wNEAR isn't on testnet yet: no token contract is deployed at mwnear.pbf-ops.testnet. Until it is, the stand-in swaps mUSDC and mNBTC only"],
      [MNBTC, MUSDT, true, "Test USDT isn't on testnet yet: no token contract is deployed at musdt.pbf-ops.testnet. Until it is, the stand-in swaps mUSDC and mNBTC only"],
      [MUSDT, MWNEAR, false, "Test USDT isn't on testnet yet: no token contract is deployed at musdt.pbf-ops.testnet. Until it is, the stand-in swaps mUSDC and mNBTC only"],
    ];
    for (const [from, to, dry, message] of refusals) {
      const refused = await s.quote(s.swap(from, to, { dry }));
      assert.deepEqual([refused.status, refused.body.message], [400, message], `${from} to ${to}`);
    }
    assert.equal(s.upstream.state.quotes.length, 0);
    // A token that isn't there is asked about again only after a while, not on every keystroke's price.
    assert.deepEqual([...new Set(s.asked)].sort(), ["meth.pbf-ops.testnet", "musdt.pbf-ops.testnet", "mwnear.pbf-ops.testnet"]);
    const asks = s.asked.length;
    await s.quote(s.swap(MUSDC, METH, { dry: true }));
    assert.equal(s.asked.length, asks);

    // Test ETH is deployed. The stand-in isn't restarted: after the wait it asks again, and ETH swaps.
    s.chain["meth.pbf-ops.testnet"] = 18;
    s.clock.now += RECHECK_MS;
    const live = await s.quote(s.swap(MUSDC, METH));
    assert.equal(live.status, 201, live.body.message);
    assert.equal(live.body.quote.amountOut, spotOut(50_021_909n, NEAR_TWINS.usdc, NEAR_TWINS.eth).toString());
    assert.deepEqual(await list(), ["mUSDC", "mNBTC", "USDC", "ETH"]);
    assert.equal((await s.quote(s.swap(METH, MWNEAR, { dry: true }))).status, 400, "test wNEAR still isn't there");
    // Once a token has answered it is never asked about again.
    const after = s.asked.filter((c) => c === "meth.pbf-ops.testnet").length;
    await s.quote(s.swap(METH, MUSDC, { dry: true }));
    assert.equal(s.asked.filter((c) => c === "meth.pbf-ops.testnet").length, after);

    // A contract with other decimals than the stand-in counts in is refused too: its amounts would be wrong.
    s.chain["musdt.pbf-ops.testnet"] = 18;
    s.clock.now += RECHECK_MS;
    const wrong = await s.quote(s.swap(MUSDC, MUSDT, { dry: true }));
    assert.deepEqual([wrong.status, wrong.body.message], [400, "The token at musdt.pbf-ops.testnet counts in 18 decimals, and the stand-in's test USDT counts in 6: it won't quote it"]);

    // The chain can't be asked: "couldn't ask" is never taken for "not there", or for "there".
    s.chainFails.message = "the NEAR RPC answered HTTP 429";
    s.clock.now += RECHECK_MS;
    const unknown = await s.quote(s.swap(MUSDC, MWNEAR, { dry: true }));
    assert.deepEqual([unknown.status, unknown.body.message], [502, "The stand-in couldn't ask NEAR testnet whether mwnear.pbf-ops.testnet (test wNEAR) is deployed: the NEAR RPC answered HTTP 429. Try again"]);
    assert.deepEqual(await list(), ["mUSDC", "mNBTC", "USDC", "ETH"]);
    assert.equal((await s.quote(s.swap(MUSDC, MNBTC, { dry: true }))).status, 201, "the two that exist don't depend on that read");
  } finally {
    s.server.close();
  }
});

test("a quote from a new NEAR token to Hyperliquid still needs that float, and an asset the stand-in doesn't know is refused as before", async () => {
  const s = await setup();
  try {
    const toHl = await s.quote(s.swap(METH, HL_USDC, { recipient: "0x3333333333333333333333333333333333333333" }));
    assert.deepEqual([toHl.status, /Hyperliquid float is off/.test(toHl.body.message)], [503, true]);
    const unknown = await s.quote(s.swap(METH, "nep141:wrap.testnet"));
    assert.deepEqual([unknown.status, /^Unknown destinationAsset nep141:wrap\.testnet\. The shim knows: /.test(unknown.body.message)], [400, true]);
  } finally {
    s.server.close();
  }
});

test("asking the chain for a token's decimals: NEAR's three ways of saying there is no token there, and a token's own answer", async () => {
  const answering = (status: number, body: unknown) => {
    const sent: { url: string; body: any }[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }) as typeof fetch;
    return { fake, sent };
  };
  const bytes = (text: string) => [...Buffer.from(text, "utf8")];
  const RPC = "https://test.rpc.fastnear.com";
  // The answers are testnet's own, read on 13 Nov.
  const gone = answering(200, { jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { info: { requested_account_id: "meth.pbf-ops.testnet" }, name: "UNKNOWN_ACCOUNT" }, code: -32000, message: "Server error", data: "account meth.pbf-ops.testnet does not exist while viewing" } });
  assert.equal(await ftDecimals(RPC, "meth.pbf-ops.testnet", gone.fake), null);
  assert.deepEqual(gone.sent, [{ url: RPC, body: { jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: "meth.pbf-ops.testnet", method_name: "ft_metadata", args_base64: "e30=" } } }]);
  const noCode = answering(200, { jsonrpc: "2.0", id: 1, result: { block_height: 1, logs: [], error: 'wasm execution failed with error: CompilationError(CodeDoesNotExist { account_id: "pbf-ops.testnet" })' } });
  assert.equal(await ftDecimals(RPC, "pbf-ops.testnet", noCode.fake), null);
  const noMethod = answering(200, { jsonrpc: "2.0", id: 1, result: { block_height: 1, logs: [], error: "wasm execution failed with error: MethodResolveError(MethodNotFound)" } });
  assert.equal(await ftDecimals(RPC, "pbf.testnet", noMethod.fake), null);
  const token = answering(200, { jsonrpc: "2.0", id: 1, result: { block_height: 1, logs: [], result: bytes('{"spec":"ft-1.0.0","name":"Mock USDC","symbol":"mUSDC","icon":null,"reference":null,"reference_hash":null,"decimals":6}') } });
  assert.equal(await ftDecimals(RPC, "musdc.pbf-ops.testnet", token.fake), 6);

  // Anything else is "couldn't ask", and throws.
  await assert.rejects(ftDecimals(RPC, "x.testnet", answering(429, "slow down").fake), /the NEAR RPC answered HTTP 429/);
  await assert.rejects(ftDecimals(RPC, "x.testnet", answering(200, { error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "PARSE_ERROR" }, data: "bad params" } }).fake), /the NEAR RPC refused the view: bad params/);
  await assert.rejects(ftDecimals(RPC, "x.testnet", answering(200, { result: { error: "wasm execution failed with error: HostError(GuestPanic { panic_msg: \"boom\" })" } }).fake), /ft_metadata failed/);
  await assert.rejects(ftDecimals(RPC, "x.testnet", answering(200, { result: { result: bytes('{"name":"no decimals"}') } }).fake), /gives no decimals/);

  // The probe: only section 49's tokens are asked about; a failed read is passed on and nothing is remembered.
  let reads = 0;
  let answer: number | null | Error = new Error("no route to host");
  const clock = { now: 0 };
  const probe = deployProbe(async () => {
    reads += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  }, () => clock.now);
  assert.equal(await probe(asset(MUSDC)), null);
  assert.equal(await probe(asset(HL_USDC)), null);
  assert.equal(reads, 0);
  await assert.rejects(probe(asset(METH)), /no route to host/);
  answer = 18;
  assert.equal(await probe(asset(METH)), null);
  assert.equal(reads, 2, "asked again at once after a read that failed");
});
