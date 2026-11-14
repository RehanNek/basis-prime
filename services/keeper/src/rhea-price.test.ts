// The job that keeps our Rhea copy's BTC price in step with Hyperliquid's oracle, against a fake copy: a price
// setting that `update_token_pyth_info` replaces, an owner, and a list of what was sent and by whom. Nothing here
// reaches a chain.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { LogEvent } from "./jsonl.js";
import type { TxResult } from "./near-tx.js";
import { clearHold, gapBp, holdFor, holdProblem, multiplierFor, priceOf, readHold, readPriceInfo, rheaPriceCall, RheaPriceJob, RheaPrices, rheaTokens, setHold, type RheaCall, type RheaHold, type RheaToken, type TokenPriceInfo } from "./rhea-price.js";

const RHEA = "rhea.pbf-ops.testnet";
const MNBTC = "mnbtc.pbf-ops.testnet";
const OPERATOR = "pbf-ops.testnet";
const KEEPER = "pbf-keeper.testnet";
const BTC_FEED = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const T0 = Date.UTC(2026, 10, 12, 9, 0);

/** nBTC's price setting as research/rhea.md 12 writes it: the multiplier is the price of one whole nBTC in cents. */
const info = (cents: string): TokenPriceInfo => ({ decimals: 8, fraction_digits: 2, price_identifier: BTC_FEED, extra_call: null, default_price: { multiplier: cents, decimals: 10 } });

function world(options: { cents?: string; oracle?: number; owner?: string | null; operatorKey?: boolean; dryRun?: boolean; fails?: string } = {}) {
  const state = { setting: info(options.cents ?? "7600000") as unknown, oracle: options.oracle ?? 76_000, now: T0, hold: null as RheaHold | null, owner: options.owner === undefined ? OPERATOR : options.owner };
  const sent: (RheaCall & { by: string })[] = [];
  const events: LogEvent[] = [];
  const sender = (by: string) => async (call: RheaCall): Promise<TxResult> => {
    sent.push({ ...call, by });
    // Rhea's own refusal for anyone but the owner, and a failure a test asks for.
    const failure = options.fails ?? (by !== state.owner ? "Smart contract panicked: Not an owner" : undefined);
    if (failure) return { label: call.method, hash: "tx-bad", ok: false, gas_tgas: 2, failure, seconds: 1, logs: [] };
    state.setting = call.args.token_pyth_info; // update_token_pyth_info replaces the whole setting
    return { label: call.method, hash: `tx-${sent.length}`, ok: true, gas_tgas: 2.7, seconds: 2, logs: [] };
  };
  const job = new RheaPriceJob({
    rheaId: RHEA,
    tokenId: MNBTC,
    oracle: async () => state.oracle,
    info: async () => structuredClone(state.setting),
    owner: async () => state.owner,
    signers: [
      { id: OPERATOR, keyName: "OPERATOR_PRIVATE_KEY", send: options.operatorKey === false ? null : sender(OPERATOR) },
      { id: KEEPER, keyName: "KEEPER_PRIVATE_KEY", send: sender(KEEPER) },
    ],
    hold: () => state.hold,
    log: (event, msg, fields = {}) => events.push({ t: new Date(state.now).toISOString(), event, msg, ...fields }),
    now: () => state.now,
    dryRun: options.dryRun ?? false,
  });
  return { job, state, sent, events, said: () => events.map((e) => e.msg) };
}

test("the price setting: one whole nBTC in dollars from Rhea's multiplier and decimals, and back", () => {
  assert.equal(priceOf(info("7600000")), 76_000);
  assert.equal(priceOf(info("7512346")), 75_123.46);
  assert.equal(multiplierFor(info("1"), 75_123.456), "7512346", "rounded to the setting's last digit, a cent here");
  // Four digits after the point, as Rhea's own conversion of a Pyth price would make it for a token with fraction_digits 4.
  const fine: TokenPriceInfo = { ...info("1"), fraction_digits: 4, default_price: { multiplier: "760000000", decimals: 12 } };
  assert.equal(priceOf(fine), 76_000);
  assert.equal(multiplierFor(fine, 75_123.456), "751234560");
  assert.throws(() => multiplierFor(info("1"), 0), /isn't a price/);
  assert.equal(Math.round(gapBp(76_114, 76_000) * 10) / 10, 15);
});

test("THE CALL is research/rhea.md 12's: update_token_pyth_info with 1 yoctoNEAR, all five fields of the setting, and the price in cents", () => {
  assert.deepEqual(rheaPriceCall(RHEA, MNBTC, info("7600000"), 75_240.5), {
    contract: RHEA,
    method: "update_token_pyth_info",
    args: { token_id: MNBTC, token_pyth_info: { decimals: 8, fraction_digits: 2, price_identifier: BTC_FEED, extra_call: null, default_price: { multiplier: "7524050", decimals: 10 } } },
    deposit: 1n,
    tgas: 30,
  });
});

test("inside 0.15% the price is left alone, and said once; at 0.15% the copy's owner sets it to the oracle's, and the copy then reads the new price", async () => {
  const w = world({ cents: "7600000", oracle: 76_100 }); // 0.13% away
  assert.deepEqual(await w.job.tick(), { copy: 76_000, oracle: 76_100, target: 76_100, gap_bp: gapBp(76_000, 76_100), updated: false, hold: null });
  await w.job.tick();
  assert.deepEqual([w.sent, w.said()], [[], ["our Rhea copy counts a bitcoin at $76,000.00, 0.13% from Hyperliquid's oracle price of $76,100.00: inside the 0.25% band"]]);

  w.state.oracle = 76_120.4; // 0.16% away
  const moved = await w.job.tick();
  assert.deepEqual([moved.updated, moved.copy], [true, 76_120.4]);
  assert.deepEqual(w.sent.map((s) => s.by), [OPERATOR], "the operator owns the copy, so the operator's key signs");
  assert.equal((w.state.setting as TokenPriceInfo).default_price.multiplier, "7612040");
  const line = w.events.at(-1)!;
  assert.equal(line.msg, "set our Rhea copy's BTC price to $76,120.40: it was $76,000.00, 0.16% from Hyperliquid's oracle price of $76,120.40");
  assert.deepEqual([line.event, line.tx, line.set_usd, line.rhea, line.signer], ["rhea_price", "tx-1", 76_120.4, RHEA, OPERATOR]);
  // The next tick reads the new price from the copy: nothing more to do. A fall is followed the same way.
  assert.equal((await w.job.tick()).updated, false);
  w.state.oracle = 75_900;
  assert.deepEqual([(await w.job.tick()).copy, w.sent.length], [75_900, 2]);
});

test("a hold keeps the price a set distance under the oracle, follows the oracle from there, and gives the price back when it ends", async () => {
  const w = world({ cents: "7600000", oracle: 76_000 });
  await w.job.tick();
  w.state.hold = { shift_bp: -1_300, until_ms: T0 + 20 * 60_000, by: "funding:demo for demo.pbf.testnet" };
  const dropped = await w.job.tick();
  assert.deepEqual([dropped.updated, dropped.copy, dropped.target, dropped.hold], [true, 66_120, 66_120, w.state.hold]);
  assert.deepEqual(w.said().slice(1), [
    "a hold is on (funding:demo for demo.pbf.testnet): our Rhea copy's BTC price is kept 13.00% under Hyperliquid's oracle until 2026-11-12T09:20:00.000Z",
    "set our Rhea copy's BTC price to $66,120.00: it was $76,000.00, 14.94% from the hold's level of $66,120.00 (13.00% under Hyperliquid's oracle at $76,000.00)",
  ]);
  assert.deepEqual(w.events.at(-1)!.hold, w.state.hold, "the hold is in the log line's fields");
  // Bitcoin moves during the hold: the held price moves with it.
  w.state.oracle = 76_500;
  assert.equal((await w.job.tick()).copy, 66_555);
  w.state.hold = null;
  const back = await w.job.tick();
  assert.deepEqual([back.updated, back.copy, back.hold], [true, 76_500, null]);
  assert.equal(w.events.at(-2)!.msg, "the hold is over: our Rhea copy's BTC price goes back to Hyperliquid's oracle");
  assert.equal(w.sent.length, 3);
});

test("only the copy's owner can set a price: the job signs as whoever that is, and sends nothing when it holds no key for it", async () => {
  // Handed to the keeper's own account: the keeper's key signs.
  const handed = world({ oracle: 77_000, owner: KEEPER });
  assert.equal((await handed.job.tick()).updated, true);
  assert.deepEqual(handed.sent.map((s) => s.by), [KEEPER]);

  // The operator owns it, and its key is missing: said once in five minutes, and no transaction that could only fail.
  const noKey = world({ oracle: 77_000, operatorKey: false });
  await noKey.job.tick();
  noKey.state.oracle = 77_050; // the figures change, the trouble is the same
  noKey.state.now += 15_000;
  await noKey.job.tick();
  assert.deepEqual(noKey.said(), ["our Rhea copy counts a bitcoin at $76,000.00, 1.30% from Hyperliquid's oracle price of $77,000.00, and the keeper can't set it: OPERATOR_PRIVATE_KEY is empty in .env (the copy's owner is pbf-ops.testnet)"]);
  noKey.state.now += 5 * 60_000;
  await noKey.job.tick();
  assert.deepEqual([noKey.events.length, noKey.sent.length], [2, 0], "said again after five minutes");

  const other = world({ oracle: 77_000, owner: "someone.testnet" });
  assert.match((await other.job.tick()).problem!, /the keeper can't set it: the copy's owner is someone\.testnet, which is neither pbf-ops\.testnet nor pbf-keeper\.testnet$/);
  const unread = world({ oracle: 77_000, owner: null });
  assert.match((await unread.job.tick()).problem!, /the keeper couldn't read who owns the copy, so it sent nothing$/);
  assert.deepEqual([other.sent.length, unread.sent.length], [0, 0]);
});

test("a dry run reads and says, and sends nothing; an update that failed is tried again only after a minute", async () => {
  const dry = world({ oracle: 77_000, dryRun: true });
  const first = await dry.job.tick();
  assert.deepEqual([first.updated, first.copy, dry.sent.length], [false, 76_000, 0]);
  assert.equal(first.problem, "our Rhea copy counts a bitcoin at $76,000.00, 1.30% from Hyperliquid's oracle price of $77,000.00: a dry run, so it stays");

  const refused = world({ oracle: 77_000, fails: "Smart contract panicked: Requires attached deposit of exactly 1 yoctoNEAR" });
  const tried = await refused.job.tick();
  assert.deepEqual([tried.updated, tried.copy], [false, 76_000]);
  assert.match(tried.problem!, /and setting it as pbf-ops\.testnet failed: Smart contract panicked: Requires attached deposit of exactly 1 yoctoNEAR$/);
  refused.state.now += 15_000;
  assert.match((await refused.job.tick()).problem!, /the last try to set it failed, and the next one waits a minute$/);
  refused.state.now += 30_000;
  await refused.job.tick();
  assert.equal(refused.sent.length, 1, "a transaction that can only fail still costs gas: one a minute at most");
  refused.state.now += 15_000;
  await refused.job.tick();
  assert.equal(refused.sent.length, 2);
});

test("a copy that isn't there, has no fixed price, or counts nBTC with other decimals is left alone, with the reason in words", async () => {
  const cases: [unknown, RegExp][] = [
    [null, /^our Rhea copy has no price setting for test nBTC yet$/],
    [{ ...info("7600000"), default_price: null }, /has no fixed price for test nBTC \(its default_price is empty\)/],
    [{ ...info("7600000"), decimals: 18 }, /says test nBTC has 18 decimals, not 8: the keeper leaves its price alone/],
    [{ ...info("7600000"), default_price: { multiplier: "0", decimals: 10 } }, /fixed price for test nBTC isn't a price/],
    [{ ...info("7600000"), default_price: { multiplier: "76", decimals: 4 } }, /has 4 decimals, which the keeper can't write a dollar price in/],
    ["nonsense", /isn't in the shape Rhea's code writes/],
  ];
  for (const [setting, words] of cases) {
    const w = world({ oracle: 80_000 });
    w.state.setting = setting;
    const t = await w.job.tick();
    assert.match(t.problem ?? "", words);
    assert.deepEqual([t.copy, t.updated, w.sent.length], [null, false, 0]);
    assert.match(readPriceInfo(setting) as string, words);
  }
  // The copy's own answer in the sandbox (research/data/rhea_copy_views.json), keys in Rhea's order: read as it is.
  const real = { decimals: 8, default_price: { decimals: 10, multiplier: "7500000" }, extra_call: null, fraction_digits: 2, price_identifier: BTC_FEED };
  assert.equal(priceOf(readPriceInfo(real) as TokenPriceInfo), 75_000);
  // An oracle price that can't be right moves nothing, and a failed read is a trouble, not a crash.
  const odd = world({ oracle: 12 });
  assert.match((await odd.job.tick()).problem!, /Hyperliquid's BTC oracle price reads 12, which doesn't look right/);
  const down = new RheaPriceJob({ rheaId: RHEA, tokenId: MNBTC, oracle: async () => 76_000, info: async () => Promise.reject(new Error("RPC timeout")), owner: async () => OPERATOR, signers: [], hold: () => null, log: () => {}, now: () => T0, dryRun: false });
  assert.match((await down.tick()).problem!, /couldn't read our Rhea copy's BTC price or Hyperliquid's oracle: RPC timeout/);
});

test("the hold's file: read while it is in force, ignored once it has ended or been cleared, or when it asks for too much", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pb-rhea-hold-")), "hold.json");
  assert.equal(readHold(file, T0), null, "no file, no hold");
  setHold(file, { shift_bp: -1_300, until_ms: T0 + 30 * 60_000, by: "a test" }, T0);
  assert.deepEqual(readHold(file, T0 + 60_000), { shift_bp: -1_300, until_ms: T0 + 30 * 60_000, by: "a test" });
  assert.equal(readHold(file, T0 + 30 * 60_000), null, "ended");
  clearHold(file, "a test");
  assert.equal(readHold(file, T0 + 60_000), null, "cleared");
  assert.throws(() => setHold(file, { shift_bp: -6_000, until_ms: T0 + 60_000 }, T0), /not a hold the keeper follows: shift_bp must be a whole number from -5000 to 1000/);
  assert.throws(() => setHold(file, { shift_bp: -500, until_ms: T0 + 2 * 60 * 60_000 }, T0), /a hold lasts an hour at most/);
  assert.equal(holdProblem({ shift_bp: -500, until_ms: T0 + 60 * 60_000 }, T0), null);
  // A file someone wrote by hand that the keeper wouldn't follow is no hold.
  writeFileSync(file, JSON.stringify({ shift_bp: -9_000, until_ms: T0 + 60_000 }));
  assert.equal(readHold(file, T0), null);
  writeFileSync(file, "not json");
  assert.equal(readHold(file, T0), null);
});

// ---------- INTERFACES.md 51.1: every token of the factory's Rhea collateral list, each with its own decimals ----------

const METH = "meth.pbf-ops.testnet";
const ETH_FEED = "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
const ETHER: RheaToken = { id: METH, coin: "ETH", decimals: 18 };
/** Test ETH's price setting, in bitcoin's form with ETH's 18 decimals: the multiplier is the price of one whole ETH in cents, and the price's decimals are 18 + 2. */
const ethInfo = (cents: string): TokenPriceInfo => ({ decimals: 18, fraction_digits: 2, price_identifier: ETH_FEED, extra_call: null, default_price: { multiplier: cents, decimals: 20 } });
/** The factory's settings after 51.1's set_config: bitcoin and ETH at Rhea, and the five tokens. */
const FACTORY = {
  tokens: [
    { id: "musdc.pbf-ops.testnet", symbol: "USDC", decimals: 6 },
    { id: MNBTC, symbol: "nBTC", decimals: 8 },
    { id: METH, symbol: "ETH", decimals: 18 },
    { id: "mwnear.pbf-ops.testnet", symbol: "wNEAR", decimals: 24 },
    { id: "musdt.pbf-ops.testnet", symbol: "USDT", decimals: 6 },
  ],
  lenders: { rhea: { contract_id: RHEA, collateral: [MNBTC, METH] } },
};

test("51.1, ETH's 18 decimals to the unit: one whole ETH in dollars from the multiplier and back, and THE CALL carries 18, the feed, and the price in cents with 20 decimals", () => {
  assert.equal(priceOf(ethInfo("194823")), 1_948.23);
  assert.equal(priceOf(ethInfo("1")), 0.01);
  assert.equal(multiplierFor(ethInfo("1"), 1_948.23), "194823");
  assert.equal(multiplierFor(ethInfo("1"), 1_948.234_9), "194823", "rounded to the cent");
  assert.equal(multiplierFor(ethInfo("1"), 1_948.235_1), "194824");
  assert.equal(multiplierFor(ethInfo("1"), 2_000), "200000");
  // The same price with four digits after the point: the price's decimals are 18 + 4, and the multiplier a hundred times larger.
  const fine: TokenPriceInfo = { ...ethInfo("1"), fraction_digits: 4, default_price: { multiplier: "19482300", decimals: 22 } };
  assert.equal(priceOf(fine), 1_948.23);
  assert.equal(multiplierFor(fine, 1_948.234_56), "19482346");
  // What one of ETH's smallest units is worth: multiplier / 10^decimals, as Rhea counts it. 194823 / 10^20 dollars a wei is $1,948.23 an ETH.
  assert.equal((194_823n * 10n ** 18n) / 10n ** 20n, 1_948n);
  assert.deepEqual(rheaPriceCall(RHEA, METH, ethInfo("194823"), 1_950.5), {
    contract: RHEA,
    method: "update_token_pyth_info",
    args: { token_id: METH, token_pyth_info: { decimals: 18, fraction_digits: 2, price_identifier: ETH_FEED, extra_call: null, default_price: { multiplier: "195050", decimals: 20 } } },
    deposit: 1n,
    tgas: 30,
  });
  // Read as ETH's, the setting passes; read as bitcoin's, its 18 decimals are refused, and bitcoin's 8 are refused for ETH.
  assert.deepEqual(readPriceInfo(ethInfo("194823"), ETHER), ethInfo("194823"));
  assert.equal(readPriceInfo(ethInfo("194823")), "our Rhea copy's price setting says test nBTC has 18 decimals, not 8: the keeper leaves its price alone");
  assert.equal(readPriceInfo(info("7600000"), ETHER), "our Rhea copy's price setting says test ETH has 8 decimals, not 18: the keeper leaves its price alone");
  assert.equal(readPriceInfo(null, ETHER), "our Rhea copy has no price setting for test ETH yet");
  // A price written with fewer decimals than the token has can't be a dollar price for a whole token.
  assert.match(String(readPriceInfo({ ...ethInfo("194823"), default_price: { multiplier: "194823", decimals: 10 } }, ETHER)), /has 10 decimals, which the keeper can't write a dollar price in/);
});

test("51.1, which tokens are kept: the factory's Rhea collateral list, bitcoin against BTC and test ETH against ETH, each with the token list's decimals; one the keeper has no price for is left, with the reason", () => {
  assert.deepEqual(rheaTokens(FACTORY, MNBTC), { tokens: [{ id: MNBTC, coin: "BTC", decimals: 8 }, ETHER], left: [] });
  // Today's factory: bitcoin alone.
  assert.deepEqual(rheaTokens({ ...FACTORY, lenders: { rhea: { collateral: [MNBTC] } } }, MNBTC), { tokens: [{ id: MNBTC, coin: "BTC", decimals: 8 }], left: [] });
  // A factory that can't be read, has no Rhea, or lists nothing: bitcoin, as before.
  for (const config of [null, undefined, {}, { lenders: {} }, { lenders: { rhea: null } }, { lenders: { rhea: { collateral: [] } } }, "x"]) {
    assert.deepEqual(rheaTokens(config, MNBTC), { tokens: [{ id: MNBTC, coin: "BTC", decimals: 8 }], left: [] });
  }
  const odd = rheaTokens({ ...FACTORY, lenders: { rhea: { collateral: [MNBTC, "mwnear.pbf-ops.testnet", "other.testnet", METH, METH] } } }, MNBTC);
  assert.deepEqual(odd.tokens.map((t) => t.id), [MNBTC, METH]);
  assert.deepEqual(odd.left, [
    { id: "mwnear.pbf-ops.testnet", why: "the keeper knows no Hyperliquid price to keep wNEAR at" },
    { id: "other.testnet", why: "the factory's token list doesn't name it" },
  ]);
});

/** A copy with a setting for each token, an oracle for each coin, and what was sent. */
function both(options: { btcCents?: string; ethSetting?: unknown; btcOracle?: number; ethOracle?: number; factory?: unknown } = {}) {
  const state = {
    settings: { [MNBTC]: info(options.btcCents ?? "7600000") as unknown, [METH]: (options.ethSetting === undefined ? ethInfo("195000") : options.ethSetting) as unknown } as Record<string, unknown>,
    oracles: { BTC: options.btcOracle ?? 76_000, ETH: options.ethOracle ?? 1_950 } as Record<string, number>,
    factory: (options.factory === undefined ? FACTORY : options.factory) as unknown,
    hold: null as RheaHold | null,
    now: T0,
  };
  const sent: RheaCall[] = [];
  const events: LogEvent[] = [];
  const prices = new RheaPrices({
    rheaId: RHEA,
    bitcoinId: MNBTC,
    factoryConfig: async () => {
      if (state.factory instanceof Error) throw state.factory;
      return state.factory;
    },
    oracle: async (coin) => state.oracles[coin] ?? Number.NaN,
    info: async (tokenId) => structuredClone(state.settings[tokenId] ?? null),
    owner: async () => OPERATOR,
    signers: [
      {
        id: OPERATOR,
        keyName: "OPERATOR_PRIVATE_KEY",
        send: async (call) => {
          sent.push(call);
          state.settings[String(call.args.token_id)] = call.args.token_pyth_info;
          return { label: call.method, hash: `tx-${sent.length}`, ok: true, gas_tgas: 2.7, seconds: 2, logs: [] };
        },
      },
    ],
    hold: () => state.hold,
    log: (event, msg, fields = {}) => events.push({ t: new Date(state.now).toISOString(), event, msg, ...fields }),
    now: () => state.now,
    dryRun: false,
  });
  const multipliers = () => sent.map((c) => [c.args.token_id, (c.args.token_pyth_info as TokenPriceInfo).default_price.multiplier, (c.args.token_pyth_info as TokenPriceInfo).default_price.decimals, (c.args.token_pyth_info as TokenPriceInfo).decimals]);
  return { prices, state, sent, events, multipliers, said: () => events.map((e) => e.msg) };
}

test("51.1, each token is kept at its own coin's oracle price with its own decimals: bitcoin at BTC's in cents with 10, test ETH at ETH's in cents with 20, and one moving doesn't touch the other", async () => {
  const w = both();
  const first = await w.prices.tick();
  assert.deepEqual(first.map((k) => [k.token.id, k.token.coin, k.tick.copy, k.tick.oracle, k.tick.updated]), [[MNBTC, "BTC", 76_000, 76_000, false], [METH, "ETH", 1_950, 1_950, false]]);
  assert.deepEqual(w.said(), [
    "our Rhea copy counts a bitcoin at $76,000.00, 0.00% from Hyperliquid's oracle price of $76,000.00: inside the 0.25% band",
    "our Rhea copy counts an ether at $1,950.00, 0.00% from Hyperliquid's oracle price of $1,950.00: inside the 0.25% band",
  ]);
  // Ether moves 1%; bitcoin stays. One call, for test ETH, to the cent, with ETH's decimals.
  w.state.oracles.ETH = 1_969.51;
  const second = await w.prices.tick();
  assert.deepEqual(w.multipliers(), [[METH, "196951", 20, 18]]);
  assert.deepEqual(second.map((k) => [k.token.coin, k.tick.copy, k.tick.updated]), [["BTC", 76_000, false], ["ETH", 1_969.51, true]]);
  assert.equal(w.said().at(-1), "set our Rhea copy's ETH price to $1,969.51: it was $1,950.00, 0.99% from Hyperliquid's oracle price of $1,969.51");
  assert.deepEqual([w.events.at(-1)!.token, w.events.at(-1)!.coin], [METH, "ETH"], "a line about another token than bitcoin names it");
  // Bitcoin moves; ether stays. Bitcoin's call is the one of before.
  w.state.oracles.BTC = 76_500;
  await w.prices.tick();
  assert.deepEqual(w.multipliers().at(-1), [MNBTC, "7650000", 10, 8]);
  assert.equal(w.sent.length, 2);
  assert.equal("token" in w.events.at(-1)!, false, "bitcoin's lines are as they were");
});

test("51.1, a hold names the token it holds: one for test ETH moves ether's price and leaves bitcoin's at the oracle; one with no name is bitcoin's, as before", async () => {
  const w = both();
  await w.prices.tick();
  w.state.hold = { shift_bp: -1_300, until_ms: T0 + 20 * 60_000, by: "funding:demo", token: METH };
  const held = await w.prices.tick();
  // 13% under $1,950 is $1,696.50, to the cent. Bitcoin isn't touched and has no hold.
  assert.deepEqual(w.multipliers(), [[METH, "169650", 20, 18]]);
  assert.deepEqual(held.map((k) => [k.token.coin, k.tick.copy, k.tick.hold?.shift_bp ?? null]), [["BTC", 76_000, null], ["ETH", 1_696.5, -1_300]]);
  assert.ok(w.said().includes("a hold is on (funding:demo): our Rhea copy's ETH price is kept 13.00% under Hyperliquid's oracle until 2026-11-12T09:20:00.000Z"));
  // The hold ends: ether goes back to its oracle.
  w.state.hold = null;
  await w.prices.tick();
  assert.deepEqual(w.multipliers().at(-1), [METH, "195000", 20, 18]);

  // A hold with no name: bitcoin's, and ether stays at its oracle.
  const plain = both();
  await plain.prices.tick();
  plain.state.hold = { shift_bp: -1_300, until_ms: T0 + 20 * 60_000 };
  const kept = await plain.prices.tick();
  assert.deepEqual(plain.multipliers(), [[MNBTC, "6612000", 10, 8]]);
  assert.deepEqual(kept.map((k) => [k.token.coin, k.tick.hold?.shift_bp ?? null]), [["BTC", -1_300], ["ETH", null]]);

  // The rule on its own, and the file: the name is written and read back; a name that isn't a token id is no hold.
  const hold: RheaHold = { shift_bp: -500, until_ms: T0 + 60_000, token: METH };
  assert.deepEqual([holdFor(hold, METH, MNBTC), holdFor(hold, MNBTC, MNBTC), holdFor({ shift_bp: -500, until_ms: 1 }, MNBTC, MNBTC)?.shift_bp, holdFor({ shift_bp: -500, until_ms: 1 }, METH, MNBTC), holdFor(null, MNBTC, MNBTC)], [hold, null, -500, null, null]);
  const file = join(mkdtempSync(join(tmpdir(), "pb-hold-")), "hold.json");
  setHold(file, hold, T0);
  assert.deepEqual(readHold(file, T0), hold);
  assert.throws(() => setHold(file, { ...hold, token: "Not A Token" }, T0), /token must be the id of the token whose price is held/);
  writeFileSync(file, JSON.stringify({ shift_bp: -500, until_ms: T0 + 60_000, token: 5 }));
  assert.equal(readHold(file, T0), null, "a name that isn't a string names no token: not bitcoin's either");
});

test("51.1, a token whose setting isn't as expected is left alone with the reason, and never stops the others: no setting yet, other decimals, an oracle that doesn't look right", async () => {
  // The copy has no setting for test ETH yet (before the copy's listing): bitcoin is kept, ether is said once.
  const none = both({ ethSetting: null, btcOracle: 76_500 });
  const first = await none.prices.tick();
  assert.deepEqual(none.multipliers(), [[MNBTC, "7650000", 10, 8]]);
  assert.deepEqual(first.map((k) => [k.token.coin, k.tick.updated, k.tick.problem ?? null]), [["BTC", true, null], ["ETH", false, "our Rhea copy has no price setting for test ETH yet"]]);
  await none.prices.tick();
  assert.equal(none.said().filter((m) => m === "our Rhea copy has no price setting for test ETH yet").length, 1, "said once, not every tick");

  // A setting that says 8 decimals for test ETH: nothing is written for it, whatever its price.
  const wrong = both({ ethSetting: info("195000"), ethOracle: 2_100, btcOracle: 76_500 });
  await wrong.prices.tick();
  assert.deepEqual(wrong.multipliers(), [[MNBTC, "7650000", 10, 8]]);
  assert.ok(wrong.said().includes("our Rhea copy's price setting says test ETH has 8 decimals, not 18: the keeper leaves its price alone"));

  // ETH's oracle reads nonsense: ether is left; bitcoin is still set. And the other way round.
  const noEth = both({ ethOracle: 3, btcOracle: 76_500 });
  await noEth.prices.tick();
  assert.deepEqual(noEth.multipliers(), [[MNBTC, "7650000", 10, 8]]);
  assert.ok(noEth.said().includes("Hyperliquid's ETH oracle price reads 3, which doesn't look right: our Rhea copy's price is left as it is"));
  const noBtc = both({ btcOracle: Number.NaN, ethOracle: 1_969.51 });
  await noBtc.prices.tick();
  assert.deepEqual(noBtc.multipliers(), [[METH, "196951", 20, 18]]);
});

test("51.1, the list is the factory's, read again every five minutes: bitcoin alone until the factory lists test ETH, and the last list known while the factory can't be read", async () => {
  const w = both({ factory: { ...FACTORY, lenders: { rhea: { collateral: [MNBTC] } } }, ethOracle: 2_100 });
  assert.deepEqual((await w.prices.tick()).map((k) => k.token.id), [MNBTC]);
  // The factory's set_config adds test ETH: picked up within five minutes, with no restart.
  w.state.factory = FACTORY;
  w.state.now += 4 * 60_000;
  assert.deepEqual((await w.prices.tick()).map((k) => k.token.id), [MNBTC]);
  w.state.now += 61_000;
  assert.deepEqual((await w.prices.tick()).map((k) => k.token.id), [MNBTC, METH]);
  assert.deepEqual(w.multipliers(), [[METH, "210000", 20, 18]]);
  // The factory stops answering: both are still kept.
  w.state.factory = new Error("RPC timeout");
  w.state.now += 6 * 60_000;
  assert.deepEqual((await w.prices.tick()).map((k) => k.token.id), [MNBTC, METH]);
  // A keeper that never read the factory keeps bitcoin, as before 51.1.
  const cold = both({ factory: new Error("RPC timeout") });
  assert.deepEqual((await cold.prices.tick()).map((k) => k.token.id), [MNBTC]);
  // A token of the list the keeper has no price for is said once and left.
  const odd = both({ factory: { ...FACTORY, lenders: { rhea: { collateral: [MNBTC, "mwnear.pbf-ops.testnet"] } } } });
  await odd.prices.tick();
  assert.ok(odd.said().includes("our Rhea copy's price of mwnear.pbf-ops.testnet is left alone: the keeper knows no Hyperliquid price to keep wNEAR at"));
  assert.equal(odd.sent.length, 0);
});
