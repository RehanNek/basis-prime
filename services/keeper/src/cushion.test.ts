import assert from "node:assert/strict";
import { test } from "node:test";

import type { Prices } from "./bands.js";
import { ACT_HF_BP, cushionMove, NEAR_HF_BP, NOW_HF_BP, showCushion, TARGET_HF_BP } from "./cushion.js";
import type { LenderExt } from "./plan.js";

const at = (btc: number, own?: Record<string, number>): Prices => ({ marks: { BTC: btc }, pi: {}, ...(own ? { lenders: own } : {}) });
const ext = (hf_bp: number, l: "aave" | "rhea" = "rhea", d = 50_667_000_000): LenderExt => ({ l, c: 100_000_000_000, d, hf_bp, r_bp: 1_591, s_bp: 1_032, room: 0, liq_bp: 7_600 });

test("the levels are the engine's: target 1.5, act 1.35, now 1.2, and near is 2% over act", () => {
  assert.deepEqual([TARGET_HF_BP, ACT_HF_BP, NOW_HF_BP, NEAR_HF_BP], [15_000, 13_500, 12_000, 13_770]);
  assert.deepEqual([showCushion(15_000), showCushion(13_500), showCushion(11_849)], ["1.50", "1.35", "1.18"]);
});

test("a cushion moves with bitcoin: the estimate is the verdict's figure scaled by the price since", () => {
  // From the target, bitcoin 10% down leaves 1.35 exactly: near, not under.
  const edge = cushionMove(ext(15_000), at(100_000), at(90_000))!;
  assert.deepEqual([edge.lender, edge.was, edge.est], ["rhea", 15_000, 13_500]);
  assert.match(edge.words, /about 1\.350 now, close to 1\.35, where it gets topped up$/);
  assert.match(cushionMove(ext(15_000), at(100_000), at(89_900))!.words, /about 1\.349 now, under 1\.35, where it gets topped up$/);
  assert.match(cushionMove(ext(15_000), at(100_000), at(79_800))!.words, /about 1\.197 now, under 1\.20, where it must be topped up now$/);
  assert.equal(cushionMove(ext(15_000), at(100_000), at(92_000)), null, "1.38: not near yet");
  assert.equal(cushionMove(ext(15_000), at(100_000), at(120_000)), null, "a rise asks for nothing");
});

test("under the near level a check is asked at each level crossed and at each further 1%", () => {
  assert.equal(cushionMove(ext(13_600), at(100_000), at(99_500)), null, "1.353: half a percent lower, and still over 1.35");
  assert.equal(cushionMove(ext(13_600), at(100_000), at(99_200))!.est, 13_491, "through 1.35");
  assert.equal(cushionMove(ext(13_000), at(100_000), at(99_500)), null, "under 1.35 already: wait for 1% more");
  assert.equal(cushionMove(ext(13_000), at(100_000), at(99_000))!.est, 12_870);
  assert.equal(cushionMove(ext(12_050), at(100_000), at(99_500))!.est, 11_990, "through 1.2");
});

test("the lender's own price counts where both readings have it; Aave is measured on Hyperliquid's; no debt or no price asks for nothing", () => {
  const own = cushionMove(ext(15_000), at(100_000, { rhea: 100_000 }), at(100_000, { rhea: 88_000 }))!;
  assert.match(own.words, /^Rhea's cushion was 1\.50 at the last check, and bitcoin's price at Rhea has gone from \$100,000 to \$88,000 since: about 1\.320 now/);
  assert.equal(cushionMove(ext(15_000), at(88_000, { rhea: 100_000 }), at(88_000, { rhea: 100_000 })), null);
  // Only one reading has the lender's price: both are taken from Hyperliquid.
  assert.match(cushionMove(ext(15_000), at(100_000), at(88_000, { rhea: 100_000 }))!.words, /BTC on Hyperliquid has gone from \$100,000 to \$88,000/);
  assert.match(cushionMove(ext(15_000, "aave"), at(100_000, { rhea: 100_000 }), at(88_000, { rhea: 100_000 }))!.words, /^Aave's cushion was 1\.50/);
  assert.equal(cushionMove(ext(15_000, "rhea", 0), at(100_000), at(50_000)), null);
  assert.equal(cushionMove(ext(0), at(100_000), at(50_000)), null);
  assert.equal(cushionMove(ext(15_000), { marks: {}, pi: {} }, at(50_000)), null);
});

test("51.1, the copy has a price for each token it takes: ether's fall at Rhea asks for a check and says ether; with bitcoin's alone the watch is as before; the one that fell furthest counts", () => {
  // Ether 13% down at the copy (the ETH gate's hold), bitcoin where it was: a Rhea loan against ether is near its act level.
  const ether = cushionMove(ext(15_000), at(76_000, { rhea: 76_000, "rhea:ETH": 1_950 }), at(76_000, { rhea: 76_000, "rhea:ETH": 1_696.5 }))!;
  assert.deepEqual([ether.lender, ether.was, ether.est], ["rhea", 15_000, 13_050]);
  assert.match(ether.words, /^Rhea's cushion was 1\.50 at the last check, and ether's price at Rhea has gone from \$1,950 to \$1,696\.5 since: about 1\.305 now, under 1\.35, where it gets topped up$/);
  // Bitcoin 12% down, ether up: bitcoin's counts, in the words of before.
  const bitcoin = cushionMove(ext(15_000), at(76_000, { rhea: 100_000, "rhea:ETH": 1_950 }), at(76_000, { rhea: 88_000, "rhea:ETH": 2_000 }))!;
  assert.match(bitcoin.words, /bitcoin's price at Rhea has gone from \$100,000 to \$88,000 since: about 1\.320 now/);
  // Neither moved: nothing. Ether known in one reading only (the keeper just started keeping it): bitcoin's alone decides.
  assert.equal(cushionMove(ext(15_000), at(76_000, { rhea: 76_000, "rhea:ETH": 1_950 }), at(76_000, { rhea: 76_000, "rhea:ETH": 1_950 })), null);
  assert.equal(cushionMove(ext(15_000), at(76_000, { rhea: 76_000 }), at(76_000, { rhea: 76_000, "rhea:ETH": 1_000 })), null);
  // Another lender's price is never taken for Rhea's.
  assert.equal(cushionMove(ext(15_000), at(76_000, { rhea: 76_000, "aave:ETH": 1_950 }), at(76_000, { rhea: 76_000, "aave:ETH": 1_000 })), null);
});
