import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Engine, WATCH_AFTER_DEADLINE_MS } from "./engine.js";
import { ASSETS, FakeHl, FakeNear, HL_USDC, MNBTC, MUSDC, priced, request } from "./fakes.js";
import { Store } from "./state.js";

const MUSDC_TOKEN = "musdc.pbf-ops.testnet";
const MNBTC_TOKEN = "mnbtc.pbf-ops.testnet";

/** An engine with fake floats and a clock the test moves by hand. */
function setup(store = new Store()) {
  const near = new FakeNear();
  const hl = new FakeHl();
  const clock = { now: 1_000_000 };
  const logs: string[] = [];
  const engine = new Engine({ store, assets: ASSETS, near, hl, now: () => clock.now, log: (l) => logs.push(l) });
  return { engine, near, hl, clock, logs, store };
}

test("NEAR: quote, deposit, then delivery with ft_transfer after the quoted time", async () => {
  const { engine, near, clock } = setup();
  const quote = engine.openSwap(request(), priced());
  const address = quote.quote.depositAddress!;
  assert.match(address, /^[0-9a-f]{64}$/, "a fresh implicit account id");
  assert.equal(quote.quote.depositMemo, null);
  assert.equal(engine.statusOf(engine.find(address)!).status, "PENDING_DEPOSIT");

  await engine.tick();
  assert.equal(engine.find(address)!.status, "PENDING_DEPOSIT", "nothing has arrived yet");

  near.credit(MUSDC_TOKEN, address, 10_000_000n);
  await engine.tick();
  assert.equal(engine.find(address)!.status, "PROCESSING");

  clock.now += 19_000;
  await engine.tick();
  assert.equal(engine.find(address)!.status, "PROCESSING", "not before the quoted 20 s");
  assert.equal(near.transfers.length, 0);

  clock.now += 1_000;
  await engine.tick();
  const status = engine.statusOf(engine.find(address)!);
  assert.equal(status.status, "SUCCESS");
  assert.deepEqual(near.transfers[0], {
    token: MNBTC_TOKEN,
    receiverId: "pbf-ops.testnet",
    amount: 13117n,
    msg: undefined,
    memo: `1click-shim ${quote.correlationId}`,
  });
  assert.equal(status.swapDetails.amountOut, "13117");
  assert.equal(status.swapDetails.destinationChainTxHashes[0]?.explorerUrl, "https://testnet.nearblocks.io/txns/near-tx-1");
});

test("NEAR: with customRecipientMsg the delivery is ft_transfer_call with that msg", async () => {
  const { engine, near, clock } = setup();
  const msg = JSON.stringify({ pb: { transfer: 7 } });
  const quote = engine.openSwap(request({ originAsset: MNBTC, destinationAsset: MUSDC, customRecipientMsg: msg }), priced("13117", "9980000"));
  near.credit(MNBTC_TOKEN, quote.quote.depositAddress!, 13117n);
  await engine.tick();
  clock.now += 20_000;
  await engine.tick();

  assert.equal(near.transfers[0]?.token, MUSDC_TOKEN);
  assert.equal(near.transfers[0]?.msg, msg);
  assert.equal(engine.find(quote.quote.depositAddress!)!.status, "SUCCESS");
});

test("NEAR: if the receiver's ft_on_transfer hands the tokens back, the swap is FAILED", async () => {
  const { engine, near, clock } = setup();
  near.keptOnCall = 0n;
  const quote = engine.openSwap(request({ customRecipientMsg: "{}" }), priced());
  near.credit(MUSDC_TOKEN, quote.quote.depositAddress!, 10_000_000n);
  await engine.tick();
  clock.now += 20_000;
  await engine.tick();

  const swap = engine.find(quote.quote.depositAddress!)!;
  assert.equal(swap.status, "FAILED");
  assert.match(swap.reason ?? "", /kept 0 of 0.00013117 mNBTC/);
});

test("fault switch 'refund': the deposit goes back to refundTo and the status is REFUNDED", async () => {
  const { engine, near, clock } = setup();
  engine.setFault({ mode: "refund", delaySeconds: 600 });
  const quote = engine.openSwap(request(), priced());
  near.credit(MUSDC_TOKEN, quote.quote.depositAddress!, 10_000_000n);
  await engine.tick();
  clock.now += 20_000;
  await engine.tick();

  const status = engine.statusOf(engine.find(quote.quote.depositAddress!)!);
  assert.equal(status.status, "REFUNDED");
  assert.equal(status.swapDetails.refundedAmount, "10000000");
  assert.equal(status.swapDetails.refundReason, "the fault switch forced a refund");
  assert.equal(status.shim.fault, "refund");
  assert.deepEqual(near.transfers.map((t) => [t.token, t.receiverId, t.amount]), [[MUSDC_TOKEN, "pbf-keeper.testnet", 10_000_000n]]);
});

test("fault switch 'fail': nothing moves and the status is FAILED", async () => {
  const { engine, near, clock } = setup();
  engine.setFault({ mode: "fail", delaySeconds: 600 });
  const quote = engine.openSwap(request(), priced());
  near.credit(MUSDC_TOKEN, quote.quote.depositAddress!, 10_000_000n);
  await engine.tick();
  clock.now += 20_000;
  await engine.tick();

  assert.equal(engine.find(quote.quote.depositAddress!)!.status, "FAILED");
  assert.equal(near.transfers.length, 0);
});

test("fault switch 'late': still PROCESSING after the quoted time, delivered after the delay", async () => {
  const { engine, near, clock } = setup();
  engine.setFault({ mode: "late", delaySeconds: 120 });
  const quote = engine.openSwap(request(), priced());
  near.credit(MUSDC_TOKEN, quote.quote.depositAddress!, 10_000_000n);
  await engine.tick();

  clock.now += 20_000 + 119_000;
  await engine.tick();
  assert.equal(engine.find(quote.quote.depositAddress!)!.status, "PROCESSING");

  clock.now += 1_000;
  await engine.tick();
  assert.equal(engine.find(quote.quote.depositAddress!)!.status, "SUCCESS");
  assert.equal(near.transfers.length, 1);
});

test("the fault in force when the deposit arrives is the one that applies", async () => {
  const { engine, near, clock } = setup();
  const quote = engine.openSwap(request(), priced());
  near.credit(MUSDC_TOKEN, quote.quote.depositAddress!, 10_000_000n);
  await engine.tick(); // the deposit is seen with the switch off
  engine.setFault({ mode: "fail", delaySeconds: 600 });
  clock.now += 20_000;
  await engine.tick();
  assert.equal(engine.find(quote.quote.depositAddress!)!.status, "SUCCESS");
});

test("a short deposit waits (KNOWN_DEPOSIT_TX), then at the deadline is INCOMPLETE_DEPOSIT and refunded", async () => {
  const { engine, near, clock } = setup();
  const quote = engine.openSwap(request(), priced());
  near.credit(MUSDC_TOKEN, quote.quote.depositAddress!, 4_000_000n);
  await engine.tick();
  assert.equal(engine.find(quote.quote.depositAddress!)!.status, "KNOWN_DEPOSIT_TX");

  clock.now += 10 * 60_000 + 31_000;
  await engine.tick();
  const swap = engine.find(quote.quote.depositAddress!)!;
  assert.equal(swap.status, "INCOMPLETE_DEPOSIT");
  assert.equal(swap.refundedAmount, "4000000");
  assert.match(swap.reason ?? "", /only 4 mUSDC of 10 arrived/);
});

test("a deposit after the deadline is refunded", async () => {
  const { engine, near, clock } = setup();
  const quote = engine.openSwap(request(), priced());
  clock.now += 11 * 60_000;
  near.credit(MUSDC_TOKEN, quote.quote.depositAddress!, 10_000_000n);
  await engine.tick();
  const swap = engine.find(quote.quote.depositAddress!)!;
  assert.equal(swap.status, "REFUNDED");
  assert.match(swap.reason ?? "", /after the quote's deadline/);
});

test("the shim stops watching once the quote is inactive", async () => {
  const { engine, near, clock } = setup();
  const quote = engine.openSwap(request(), priced());
  clock.now += 10 * 60_000 + WATCH_AFTER_DEADLINE_MS + 1;
  near.credit(MUSDC_TOKEN, quote.quote.depositAddress!, 10_000_000n);
  await engine.tick();
  assert.equal(engine.find(quote.quote.depositAddress!)!.status, "PENDING_DEPOSIT");
});

test("a deposit above amountIn is processed, and the excess is refunded", async () => {
  const { engine, near, clock } = setup();
  const quote = engine.openSwap(request(), priced());
  near.credit(MUSDC_TOKEN, quote.quote.depositAddress!, 12_500_000n);
  await engine.tick();
  clock.now += 20_000;
  await engine.tick();
  const swap = engine.find(quote.quote.depositAddress!)!;
  assert.equal(swap.status, "SUCCESS");
  assert.equal(swap.refundedAmount, "2500000");
  assert.deepEqual(near.transfers[1], { token: MUSDC_TOKEN, receiverId: "pbf-keeper.testnet", amount: 2_500_000n, memo: `1click-shim refund ${swap.id}` });
});

test("deposit/submit records the hash and looks at the address at once", async () => {
  const { engine, near } = setup();
  const quote = engine.openSwap(request(), priced());
  const address = quote.quote.depositAddress!;

  const before = await engine.submitDeposit(address, "HASH1");
  assert.equal(before?.status, "KNOWN_DEPOSIT_TX", "reported, but nothing on chain yet");

  near.credit(MUSDC_TOKEN, address, 10_000_000n);
  const after = await engine.submitDeposit(address, "HASH1");
  assert.equal(after?.status, "PROCESSING");
  assert.deepEqual(after?.depositTxHashes, ["HASH1"]);
  assert.equal(await engine.submitDeposit("unknown", "H"), undefined);
});

test("a failed delivery is FAILED with the reason, and is never retried", async () => {
  const { engine, near, clock } = setup();
  const quote = engine.openSwap(request(), priced());
  near.credit(MUSDC_TOKEN, quote.quote.depositAddress!, 10_000_000n);
  await engine.tick();
  near.failNext = "The account pbf-ops.testnet is not registered";
  clock.now += 20_000;
  await engine.tick();
  await engine.tick();

  const swap = engine.find(quote.quote.depositAddress!)!;
  assert.equal(swap.status, "FAILED");
  assert.equal(swap.reason, "delivery failed: The account pbf-ops.testnet is not registered");
  assert.equal(near.transfers.length, 0);
});

test("Hyperliquid deposits: matched by sender and amount, oldest quote first, each transfer used once", async () => {
  const { engine, hl, clock } = setup();
  const sender = "0x1111111111111111111111111111111111111111";
  const hlRequest = request({ originAsset: HL_USDC, destinationAsset: MUSDC, refundTo: sender, amount: "1000000000" });
  const first = engine.openSwap(hlRequest, priced("1000000000", "9980000"));
  const second = engine.openSwap(hlRequest, priced("1000000000", "9980000"));
  assert.equal(first.quote.depositAddress, hl.address, "every Hyperliquid quote deposits to the float");
  assert.equal(first.quote.depositMemo, first.correlationId, "the memo tells them apart");

  hl.incoming.push(
    { hash: "0xother", time: clock.now, from: "0x2222222222222222222222222222222222222222", amount: 1_000_000_000n },
    { hash: "0xwrongamount", time: clock.now, from: sender, amount: 999_000_000n },
    { hash: "0xa", time: clock.now, from: sender, amount: 1_000_000_000n },
  );
  await engine.tick();
  assert.equal(engine.find(hl.address, first.correlationId)!.status, "PROCESSING");
  assert.deepEqual(engine.find(hl.address, first.correlationId)!.depositTxHashes, ["0xa"]);
  assert.equal(engine.find(hl.address, second.correlationId)!.status, "PENDING_DEPOSIT");

  hl.incoming.push({ hash: "0xb", time: clock.now, from: sender, amount: 1_000_000_000n });
  await engine.tick();
  assert.equal(engine.find(hl.address, second.correlationId)!.status, "PROCESSING");
});

test("Hyperliquid delivery is a usdSend from the float, rounded down to 6 decimals", async () => {
  const { engine, near, hl, clock } = setup();
  const quote = engine.openSwap(request({ destinationAsset: HL_USDC, recipient: "0x3333333333333333333333333333333333333333" }), priced("10000000", "968123456"));
  near.credit(MUSDC_TOKEN, quote.quote.depositAddress!, 10_000_000n);
  await engine.tick();
  clock.now += 20_000;
  await engine.tick();

  assert.deepEqual(hl.sends, [{ destination: "0x3333333333333333333333333333333333333333", amount: 968_123_456n }]);
  const status = engine.statusOf(engine.find(quote.quote.depositAddress!)!);
  assert.equal(status.status, "SUCCESS");
  assert.equal(status.swapDetails.amountOut, "968123400");
  assert.equal(status.swapDetails.destinationChainTxHashes[0]?.explorerUrl, "https://app.hyperliquid-testnet.xyz/explorer/tx/0xhl1");
});

test("after a crash mid-send, the swap is FAILED instead of being sent twice", () => {
  const { engine, store } = setup();
  const quote = engine.openSwap(request(), priced());
  const swap = engine.find(quote.quote.depositAddress!)!;
  swap.status = "PROCESSING";
  swap.sending = "delivery";

  engine.recover();
  assert.equal(swap.status, "FAILED");
  assert.equal(swap.sending, undefined);
  assert.match(swap.reason ?? "", /stopped while sending the delivery/);
  assert.equal(store.swaps().length, 1);
});

test("the state survives a restart through its JSON file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shim-state-"));
  try {
    const file = join(dir, "state.json");
    const { engine } = setup(new Store(file));
    engine.setFault({ mode: "late", delaySeconds: 42 });
    const quote = engine.openSwap(request(), priced());

    const reloaded = new Store(file);
    assert.deepEqual(reloaded.state.fault, { mode: "late", delaySeconds: 42 });
    assert.equal(reloaded.find(quote.quote.depositAddress!)?.status, "PENDING_DEPOSIT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 4: a refund to a NEAR account carries the quote's msg; the excess over amountIn goes back without it", async () => {
  // A move to Hyperliquid (INTERFACES.md 14): mUSDC from the account, refunded to the account with its transfer msg.
  const { engine, near, clock } = setup();
  const msg = JSON.stringify({ pb: { transfer: "move:4" } });
  engine.setFault({ mode: "refund", delaySeconds: 600 });
  const toHl = engine.openSwap(
    request({ destinationAsset: HL_USDC, recipient: "0x1b242c24f5e67e93d7b58c3dad77ccc90dacd7d0", refundTo: "demo.pbf.testnet", customRecipientMsg: msg }),
    priced("11000000", "1080000000"),
  );
  near.credit(MUSDC_TOKEN, toHl.quote.depositAddress!, 11_000_000n);
  await engine.tick();
  clock.now += 20_000;
  await engine.tick();
  assert.equal(engine.find(toHl.quote.depositAddress!)!.status, "REFUNDED");
  assert.deepEqual(near.transfers.at(-1), { token: MUSDC_TOKEN, receiverId: "demo.pbf.testnet", amount: 11_000_000n, msg, memo: `1click-shim refund ${toHl.correlationId}` });

  // The account hands a refund back (it doesn't know the transfer): the swap says so and is FAILED.
  near.keptOnCall = 0n;
  const handedBack = engine.openSwap(request({ customRecipientMsg: msg }), priced());
  near.credit(MUSDC_TOKEN, handedBack.quote.depositAddress!, 10_000_000n);
  await engine.tick();
  clock.now += 20_000;
  await engine.tick();
  const swap = engine.find(handedBack.quote.depositAddress!)!;
  assert.equal(swap.status, "FAILED");
  assert.match(swap.reason ?? "", /the refund's receiver kept only 0 of 10 mUSDC; the rest went back to the float/);

  // No fault, a deposit above amountIn: delivered with the msg, the excess sent back plainly.
  near.keptOnCall = undefined;
  engine.setFault({ mode: "none", delaySeconds: 600 });
  const over = engine.openSwap(request({ originAsset: MNBTC, destinationAsset: MUSDC, recipient: "demo.pbf.testnet", refundTo: "demo.pbf.testnet", customRecipientMsg: msg }), priced("13117", "9980000"));
  near.credit(MNBTC_TOKEN, over.quote.depositAddress!, 13_200n);
  await engine.tick();
  clock.now += 20_000;
  await engine.tick();
  const [delivery, excess] = near.transfers.slice(-2);
  assert.deepEqual([delivery!.token, delivery!.msg], [MUSDC_TOKEN, msg]);
  assert.deepEqual([excess!.token, excess!.amount, excess!.msg], [MNBTC_TOKEN, 83n, undefined]);
});
