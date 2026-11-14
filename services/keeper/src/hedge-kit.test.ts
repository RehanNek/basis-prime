// The gate script's pure parts: the messages pb-gateway parses, the NEP-413 Auth, the sizes and caps, and the step
// bookkeeping. Nothing here touches a network.
import assert from "node:assert/strict";
import { test } from "node:test";

import { KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";

import {
  BAND_EDGE_BP,
  belowLimit,
  btcSz,
  cancelMessage,
  creditHolds,
  gatePx,
  HL_TESTNET_REACH_BP,
  gatewayRecord,
  hedgeNow,
  isWireDecimal,
  limitPx,
  orderMessage,
  planFor,
  poolRoom,
  resumeAt,
  runPasses,
  signAuth,
  sizeAtLeast,
  STEP_IDS,
  StepFailed,
  stepPass,
  StepRunner,
  tallyBurst,
  THROUGH_MARK_BP,
  underLine,
  type HedgeRecord,
} from "./hedge-kit.js";

const ORDER = { coin: "BTC", is_buy: false, sz: "0.33", limit_px: "74500", reduce_only: false, tif: "Ioc" as const };

/** What services/api/src/nep413.ts exports, as used here. */
interface Nep413Api {
  ed25519PublicKey(text: string): Uint8Array | null;
  base64Bytes(text: string, length: number): Uint8Array | null;
  verifyNep413(publicKey: Uint8Array, signature: Uint8Array, payload: { message: string; nonce: Uint8Array; recipient: string }): boolean;
}

test("the order and cancel messages are byte for byte what msg.rs's parse_exact re-serialises", () => {
  // risk/pb-gateway/src/msg.rs, test only_the_exact_message_parses: these two strings parse.
  assert.equal(
    orderMessage("alice.pbf.testnet", ORDER, 1794000000000),
    '{"pb":"order","account":"alice.pbf.testnet","order":{"coin":"BTC","is_buy":false,"sz":"0.33","limit_px":"74500","reduce_only":false,"tif":"Ioc"},"expires_ms":1794000000000}',
  );
  assert.equal(cancelMessage("alice.pbf.testnet", "BTC", 123, 5), '{"pb":"cancel","account":"alice.pbf.testnet","cancel":{"coin":"BTC","oid":123},"expires_ms":5}');
  const shuffled = { tif: "Ioc" as const, reduce_only: false, limit_px: "74500", sz: "0.33", is_buy: false, coin: "BTC" };
  assert.equal(orderMessage("alice.pbf.testnet", shuffled, 1), orderMessage("alice.pbf.testnet", ORDER, 1), "the struct's key order, whatever the caller's");
  assert.throws(() => orderMessage("a.pbf.testnet", { ...ORDER, sz: "0.330" }, 1), /wire form/);
});

test("numbers in Hyperliquid's wire form, as msg.rs decimal() takes them", () => {
  for (const good of ["0.33", "74500", "0.001234", "0", "10"]) assert.ok(isWireDecimal(good), good);
  // msg.rs's own refusals: "", ".5", "5.", "0.330", "074500", "+1", "-1", "1e3", "1,5", " 1", "1.2.3", "0x10"
  for (const bad of ["", ".5", "5.", "0.330", "074500", "+1", "-1", "1e3", "1,5", " 1", "1.2.3", "0x10"]) assert.ok(!isWireDecimal(bad), bad);
  assert.equal(btcSz(0.33000000000000002), "0.33");
  assert.equal(btcSz(0.32980999999999998), "0.32981", "float noise from subtracting fills goes to the nearest step");
  assert.equal(sizeAtLeast(10.5, 75_800), "0.00014", "$10.61");
  assert.equal(limitPx(75_824, -30), "75596", "0.3% under, a whole price");
  assert.equal(limitPx(75_824, 30), "76051");
  assert.equal(belowLimit(24_150_000_000n), 24_147_584_998n, "as the web app: 0.01% plus 2 micro-USDC");
});

test("NEP-413: what the keeper signs checks out with the backend's own verifier (services/api/src/nep413.ts)", async () => {
  // The backend's own file, run by Node's type stripping: the keeper doesn't depend on the backend's package.
  const api = (await import(new URL("../../api/src/nep413.ts", import.meta.url).href)) as Nep413Api;
  const signer = KeyPairSigner.fromSecretKey(KeyPair.fromRandom("ed25519").toString() as KeyPairString);
  const message = orderMessage("demo.pbf.testnet", ORDER, 1794000090000);
  const auth = await signAuth(signer, "pbf-keeper.testnet", message);

  assert.equal(auth.recipient, "pb-gateway");
  assert.equal(auth.owner, "pbf-keeper.testnet");
  assert.equal(auth.message, message);
  const key = api.ed25519PublicKey(auth.public_key);
  const signature = api.base64Bytes(auth.signature, 64);
  const nonce = api.base64Bytes(auth.nonce, 32);
  assert.ok(key && signature && nonce, "the encodings are the ones the backend accepts");
  assert.equal(api.verifyNep413(key, signature, { message, nonce, recipient: "pb-gateway" }), true);
  assert.equal(api.verifyNep413(key, signature, { message: message.replace("0.33", "0.34"), nonce, recipient: "pb-gateway" }), false);
  const other = await signAuth(signer, "pbf-keeper.testnet", message);
  assert.notEqual(other.nonce, auth.nonce, "a fresh 32-byte nonce each time");
});

test("the sizes: small and full amounts, and the caps refuse anything bigger", () => {
  const small = planFor("small", 75_800);
  assert.deepEqual([small.deposit_usdc_micro, small.deposit_nbtc_units, small.to_hl_micro, small.short_sz], ["440000000", "1500000", "430000000", "0.015"]);
  assert.deepEqual(small.burst, { count: 40, sz: "0.00014" });
  const full = planFor("full", 75_800);
  assert.equal(full.to_hl_micro, "9500000000");
  assert.equal(full.short_sz, "0.32981", "$25k at 75,800");
  assert.equal(full.deposit_nbtc_units, "32981530", "$25k of nBTC");
  assert.ok(Number(full.short_sz) * 75_800 <= full.caps.short_usd);
  assert.throws(() => planFor("small", 10), /doesn't look right/);
  assert.throws(() => planFor("small", 200_000), /the short \(\$3000\.00\) is above the small cap of \$2000/, "the caps catch a wild price");
});

test("both books keep the proportions that make the close-short refusal bite: USDC under half the nBTC, the short hedging it", () => {
  for (const size of ["small", "full"] as const) {
    const plan = planFor(size, 75_800);
    const nbtcUsd = (Number(plan.deposit_nbtc_units) / 1e8) * 75_800;
    const usdc = Number(plan.deposit_usdc_micro) / 1e6;
    // The line is 70% of collateral (C4), and the unhedged nBTC's requirement is about 0.46 of its value
    // (RISK_ENGINE.md 13.7), so 0.3 * (nBTC + USDC) is under it while USDC < about 0.55 * nBTC.
    assert.ok(usdc / nbtcUsd < 0.45, `${size}: ${usdc} of USDC against $${nbtcUsd.toFixed(0)} of nBTC`);
    assert.ok(Math.abs(Number(plan.short_sz) * 1e8 - Number(plan.deposit_nbtc_units)) <= 1_000, `${size}: the short hedges the nBTC`);
    assert.ok(nbtcUsd + usdc > 1_100, `${size}: over the engine's $1,000 floor for credit (C0), with room`);
  }
});

test("the borrow amount, and P8's credit conditions read off a verdict", () => {
  assert.equal(underLine(24_159_800_000n), 24_036_597_098n, "0.5% under the line, then belowLimit");
  assert.equal(underLine(0n), 0n);
  // pb-risk's numbers for the full book with the loan out (smallprobe, 8 Nov): within; closing the short would not be.
  assert.deepEqual(creditHolds({ eq_allow: 10_475_000_000, im: 5_607_510_000, tier: "STANDARD" }, 24_039_000_000n), { holds: true, why: [] });
  assert.match(creditHolds({ eq_allow: 10_316_000_000, im: 11_576_000_000, tier: "STANDARD" }, 24_039_000_000n).why.join(), /under the requirement/);
  assert.match(creditHolds({ eq_allow: 10_000_000_000, im: 5_000_000_000, tier: "STANDARD" }, 24_039_000_000n).why.join(), /above 70% of collateral/);
  assert.equal(creditHolds({ eq_allow: 10_000_000_000, im: 5_000_000_000, tier: "PREFERRED" }, 24_039_000_000n).holds, true, "85% for Preferred");
  assert.equal(creditHolds({ eq: 10_475_000_000, im: 5_607_510_000, tier: "STANDARD" }, 0n).holds, true, "eq when there is no eq_allow");
  assert.match(creditHolds({ eq_allow: 1, im: 0, tier: "GOLD" }, 0n).why.join(), /no tier cap/);
});

function record(steps: HedgeRecord["steps"] = []): HedgeRecord {
  return { version: 1, account: "a.pbf.testnet", owner: "k.testnet", size: "small", api_url: "http://localhost:8788", started_utc: "t", plan: planFor("small", 75_800), context: {}, steps };
}

test("the bookkeeping: each step saved as it ends; ok == !expect_fail; a refusal must carry its expected code", async () => {
  const saves: number[] = [];
  const lines: string[] = [];
  let t = 0;
  const runner = new StepRunner(record(), (r) => saves.push(r.steps.length), (l) => lines.push(l), () => (t += 1_500));

  const created = await runner.run("create", "create", {}, async (step) => {
    step.tx({ label: "create_account", hash: "H1", ok: true, gas_tgas: 54, seconds: 7 });
    return { ok: true };
  });
  assert.equal(created.pass, true);
  assert.equal(created.seconds, 1.5);
  assert.deepEqual(created.txs.map((x) => x.hash), ["H1"]);

  const refused = await runner.run("refuse_coin", "P1", { expect_fail: true, expect_codes: ["P1"] }, async (step) => {
    step.gateway(gatewayRecord("TAO", 200, { ok: false, code: "P1", reason: "not on the allow-list", call_id: "c1", attestation_url: "https://x/c1" }, 2));
    return { ok: false, code: "P1" };
  });
  assert.equal(refused.pass, true);
  assert.equal(refused.gateway[0]!.attestation_url, "https://x/c1");
  assert.deepEqual(saves, [1, 2]);
  assert.match(lines.join("\n"), /refused, as expected \(P1\)/);

  await assert.rejects(
    runner.run("refuse_close", "close", { expect_fail: true, expect_codes: ["P8"] }, async () => ({ ok: false, code: "HL" })),
    (error: unknown) => error instanceof StepFailed && error.step.pass === false && error.step.code === "HL",
    "refused, but by Hyperliquid rather than a check: not as expected",
  );
  await assert.rejects(
    runner.run("deposit", "deposit", {}, async () => {
      throw new Error("mint failed: Smart contract panicked");
    }),
    (error: unknown) => error instanceof StepFailed && /mint failed/.test(error.message),
  );
  assert.deepEqual(saves, [1, 2, 3, 4], "a failed step is saved too");
  assert.equal(runner.record.steps.find((s) => s.id === "deposit")!.ok, false);
  assert.ok(stepPass({ ok: true, expect_fail: false }) && !stepPass({ ok: true, expect_fail: true }));
});

test("the run passes only when every step ran and passed; --from keeps the steps before it and drops the rest", () => {
  const ok = (id: (typeof STEP_IDS)[number]) => ({ id, label: id, ok: true, expect_fail: false, pass: true, started_utc: "t", seconds: 1, txs: [], gateway: [], detail: null });
  const all = record(STEP_IDS.map(ok));
  assert.equal(runPasses(all), true);
  assert.equal(runPasses(record(STEP_IDS.slice(0, 5).map(ok))), false, "a run that stopped hasn't passed");

  const resumed = resumeAt({ ...all, pass: true, finished_utc: "x", leftovers: ["l"], context: { hl_address: "0xa" } }, "borrow");
  assert.deepEqual(resumed.steps.map((s) => s.id), ["create", "deposit", "hl_init", "to_hl", "agent", "approve", "short"]);
  assert.equal(resumed.pass, undefined);
  assert.equal(resumed.leftovers, undefined);
  assert.deepEqual(resumed.context, { hl_address: "0xa" }, "the context carries over");
});

test("the 40 orders' tally: filled, partial, resting, and refusals by code", () => {
  const r = (status: number, answer: Record<string, unknown>) => gatewayRecord("b", status, answer, 1);
  const tally = tallyBurst([
    r(200, { ok: true, status: "filled", filled_sz: "0.00014" }),
    r(200, { ok: true, status: "partial", filled_sz: "0.0001" }),
    r(200, { ok: false, code: "P0" }),
    r(200, { ok: false, code: "P0" }),
    r(200, { ok: false, code: "P8" }),
    r(502, { error: "outlayer_unknown", message: "may still have reached Hyperliquid" }),
  ]);
  assert.deepEqual(tally, { sent: 6, filled: 1, partial: 1, resting: 0, refused: { P0: 2, P8: 1, outlayer_unknown: 1 }, filled_sz: 0.00024 });
});

test("the pool's own limits, as the web app reads them: the smallest binds, and a paused pool lends nothing", () => {
  const pool = { cash: "300000000000", loans: "0", capital: "300000000000", paused: false, lent_24h: "0", daily_budget: "30000000000" };
  const params = { caps: { max_utilisation_bp: 9_000, client_share_bp: 2_500, new_account_limit: "25000000000", ceiling: { preferred: "5000000000000", standard: "1000000000000", watch: "100000000000" } } };
  const borrower = { debt: "0", tier: "STANDARD" as const, first_week_until: "2000", blocked: false };
  const smallest = (limits: { label: string; amount: bigint }[]) => limits.reduce((a, b) => (a.amount <= b.amount ? a : b));
  assert.deepEqual(smallest(poolRoom(pool, params, borrower, 1_000n)), { label: "a new account's first-week limit", amount: 25_000_000_000n });
  assert.equal(smallest(poolRoom(pool, params, borrower, 3_000n)).label, "the daily lending budget", "after the first week");
  assert.equal(smallest(poolRoom({ ...pool, paused: true }, params, borrower, 1_000n)).amount, 0n);
  assert.equal(smallest(poolRoom(pool, params, null, 1_000n)).label, "the account is not registered with the pool");
});

// ---------- the gate's own order prices and the gateway's band (INTERFACES.md 42) ----------

/** Hyperliquid testnet's BTC on 12 Nov, when the Rhea gate's hedge was refused: the mark 1.96% over the oracle. */
const NOV_12 = { mark: 74_421, oracle: 72_987, bestBid: 74_421, bestAsk: 74_427 };
/** 11 Nov, when gate 2 passed with the hedge: the mark 0.77% over the oracle (a spread like 12 Nov's). */
const NOV_11 = { mark: 76_585, oracle: 76_000, bestBid: 76_585, bestAsk: 76_591 };

test("Hyperliquid testnet's own limit, nearer than the 3% band: the close of 12 Nov's night is priced 2.4% over the oracle, over the best bid, and not 0.3% over the mark", () => {
  // 22:11 UTC on 12 Nov: the mark 2.40% over the oracle. Buys at 0.3% over the mark (2.7% over the oracle) passed the
  // gateway and were refused by Hyperliquid: "Price too far from oracle".
  const night = { mark: 73_252, oracle: 71_533, bestBid: 73_238, bestAsk: 73_367, bandBp: 300 };
  assert.deepEqual(gatePx("over", night), { px: "73471", held_to_band: false }, "as it was priced: 2.71% over the oracle");
  const f = { ...night, venueBp: HL_TESTNET_REACH_BP };
  assert.deepEqual(gatePx("over", f), { px: "73249", held_to_band: true });
  assert.ok(73_249 / 71_533 - 1 < 0.024 && 73_249 > night.bestBid, "just inside 2.40% over the oracle, and over the best bid");
  assert.deepEqual(gatePx("under", f), { px: "73032", held_to_band: false }, "the bid, 0.3% under the mark, is nearer the oracle still");
  assert.match(hedgeNow(f).why, /the gateway's band is 3% \(Hyperliquid's own limit, about 2\.4%, is the nearer one\): the hedge opens with sells at \$73,032 and closes with buys at \$73,249/);
  // A best bid over that price: nothing that could trade would wait for the account, and the words name Hyperliquid.
  const stopped = gatePx("over", { ...f, bestBid: 73_260 });
  assert.match((stopped as { problem: string }).problem, /stands 2\.40% over its oracle price \(\$71,533\), and Hyperliquid testnet itself takes no trade more than about 2\.4% from that price\. The highest price that could trade, about \$73,249, is at or under the best bid \(\$73,260\)/);
  assert.match(hedgeNow({ ...f, bestBid: 73_260 }).why, /it can once the mark is within about 2\.4% of the oracle price/);
  // An older account's 1% band is the nearer limit, and nothing changes for it.
  assert.deepEqual(gatePx("over", { ...NOV_11, bandBp: 100, venueBp: HL_TESTNET_REACH_BP }), gatePx("over", { ...NOV_11, bandBp: 100 }));
  assert.equal(HL_TESTNET_REACH_BP, 240);
});

test("the gate's order prices under a 3% band: 0.3% through the mark both ways on a day like 12 Nov, inside the band and on the right side of the real book", () => {
  const f = { ...NOV_12, bandBp: 300 };
  // The short and the burst: the float bids 0.3% under the mark. 1.66% from the oracle, inside 3%; under the best ask.
  assert.deepEqual(gatePx("under", f), { px: "74197", held_to_band: false });
  // Closing: the float asks 0.3% over the mark. 2.27% from the oracle, inside 3%; over the best bid.
  assert.deepEqual(gatePx("over", f), { px: "74644", held_to_band: false });
  assert.deepEqual(hedgeNow(f), { ok: true, why: "Hyperliquid's BTC mark ($74,421) is 1.96% over its oracle price ($72,987), and the gateway's band is 3%: the hedge opens with sells at $74,197 and closes with buys at $74,644" });
  // 11 Nov: the same two prices, 0.3% either side of the mark.
  assert.deepEqual([gatePx("under", { ...NOV_11, bandBp: 300 }), gatePx("over", { ...NOV_11, bandBp: 300 })], [{ px: "76355", held_to_band: false }, { px: "76814", held_to_band: false }]);
  assert.deepEqual([THROUGH_MARK_BP, BAND_EDGE_BP], [30, 10]);
});

test("under the 1% band of an older gateway: 11 Nov's close is held to 0.9% over the oracle, as it was; 12 Nov's hedge is stopped in words before anything is posted", () => {
  // 11 Nov: the bid is inside; the ask, 0.3% over the mark, would be 1.07% from the oracle, so it is held to 0.9%.
  assert.deepEqual(gatePx("under", { ...NOV_11, bandBp: 100 }), { px: "76355", held_to_band: false });
  assert.deepEqual(gatePx("over", { ...NOV_11, bandBp: 100 }), { px: "76683", held_to_band: true });
  assert.equal(hedgeNow({ ...NOV_11, bandBp: 100 }).ok, true);
  // 12 Nov: the highest price a 1% gateway takes is under the best bid. An ask there would sell into the real bids,
  // and a buy there would reach no ask: the close can't be made, so the short isn't opened either.
  const stopped = gatePx("over", { ...NOV_12, bandBp: 100 });
  assert.deepEqual(stopped, {
    problem:
      "Hyperliquid's mark ($74,421) stands 1.96% over its oracle price ($72,987), and the account's gateway takes a price at most 1% from its reference price, which follows the oracle. The highest price it would take, about $73,643, is at or under the best bid ($74,421): an order the gateway takes couldn't fill, and the float's ask there would cross the real book",
  });
  assert.deepEqual(gatePx("under", { ...NOV_12, bandBp: 100 }), { px: "73643", held_to_band: true }, "a bid held down to the band still rests under the asks");
  const hedge = hedgeNow({ ...NOV_12, bandBp: 100 });
  assert.equal(hedge.ok, false);
  assert.ok(hedge.why.endsWith("The hedge can't be opened and closed through the gateway now: it can once the mark is within about 0.9% of the oracle price"), hedge.why);
});

test("how wide a gap the 3% band stands: the mark up to about 2.9% from the oracle, either way; past it the gate stops in words", () => {
  const at = (overBp: number) => ({ mark: 72_987 * (1 + overBp / 10_000), oracle: 72_987, bestBid: 72_987 * (1 + overBp / 10_000), bestAsk: 72_987 * (1 + overBp / 10_000) + 6, bandBp: 300 });
  // 2.5% over: both prices 0.3% through the mark. 2.7% over: the ask is held to the band's edge, still over the bids.
  assert.deepEqual([gatePx("under", at(250)), gatePx("over", at(250))], [{ px: "74587", held_to_band: false }, { px: "75036", held_to_band: false }]);
  assert.deepEqual(gatePx("over", at(270)), { px: "75103", held_to_band: true });
  assert.equal(hedgeNow(at(270)).ok, true);
  // 2.9% over: the band's edge is the best bid itself. Nothing can be closed, so nothing is opened.
  assert.equal(hedgeNow(at(290)).ok, false);
  assert.match((gatePx("over", at(300)) as { problem: string }).problem, /stands 3\.00% over its oracle price \(\$72,987\), and the account's gateway takes a price at most 3% from its reference price.*The highest price it would take, about \$75,103, is at or under the best bid \(\$75,176\.61\)/);
  // The other way round: a mark far under the oracle stops the bid, whose lowest in-band price is over the asks.
  const under = { mark: 70_000, oracle: 72_987, bestBid: 69_995, bestAsk: 70_000, bandBp: 300 };
  assert.match((gatePx("under", under) as { problem: string }).problem, /stands 4\.09% under its oracle price.*The lowest price it would take, about \$70,870, is at or over the best ask \(\$70,000\).*the float's bid there would cross the real book/);
  assert.equal(hedgeNow({ mark: 70_950, oracle: 72_987, bestBid: 70_945, bestAsk: 70_950, bandBp: 300 }).ok, true, "2.79% under: still inside");

  // Without an oracle price no band can be worked out: 0.3% through the mark, as before. Without the book, the mark stands in for it.
  assert.deepEqual([gatePx("under", { mark: 75_824, oracle: Number.NaN, bestBid: Number.NaN, bestAsk: Number.NaN, bandBp: 100 }), gatePx("over", { mark: 75_824, oracle: Number.NaN, bestBid: Number.NaN, bestAsk: Number.NaN, bandBp: 100 })], [{ px: "75596", held_to_band: false }, { px: "76051", held_to_band: false }]);
  assert.match((gatePx("over", { ...NOV_12, bestBid: Number.NaN, bandBp: 100 }) as { problem: string }).problem, /at or under the best bid \(\$74,421\)/);
  // A book that stands oddly to the mark is said for what it is: no price is moved across it.
  assert.deepEqual(gatePx("under", { mark: 74_421, oracle: 74_400, bestBid: 74_000, bestAsk: 74_100, bandBp: 300 }), { problem: "a bid at $74,197, 0.3% under the mark ($74,421), would be at or over the best ask ($74,100) and cross the real book" });
});
