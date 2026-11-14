import assert from "node:assert/strict";
import { test } from "node:test";

import { faultChecks, snapshotOf } from "./fault-kit.js";

const T0 = Date.UTC(2026, 10, 10, 12, 0);
const HL = { withdrawable: 23.68, account_value: 23.68 };
const pending = (id: string, kind: string) => [{ transfer: { id, kind, token: kind === "home" ? "USDC" : "musdc.pbf-ops.testnet", amount: "11000000", dep: "ab".repeat(32), deadline: String(BigInt(T0 + 40 * 60_000) * 1_000_000n) } }];
const snap = (musdc: string, list: unknown[] = []) => snapshotOf(T0, { counter: 4, pending: list }, musdc, HL);

test("refund: the transfer is recorded, then resolved by the refund's msg, and the mUSDC is back", () => {
  const ok = faultChecks({ fault: "refund", transferId: "move:4", amountMicro: 11_000_000n, before: snap("35000000"), during: snap("24000000", pending("move:4", "to_hl")), after: snap("35000000"), status: "REFUNDED" });
  assert.deepEqual([ok.recorded, ok.resolved, ok.balance_ok, ok.pass, ok.words], [true, true, true, true, []]);
  const stuck = faultChecks({ fault: "refund", transferId: "move:4", amountMicro: 11_000_000n, before: snap("35000000"), during: snap("24000000", pending("move:4", "to_hl")), after: snap("35000000", pending("move:4", "to_hl")), status: "REFUNDED" });
  assert.deepEqual([stuck.pass, stuck.words], [false, ["transfer move:4 is still pending after the refund"]]);
});

test("fail: nothing comes back, so the transfer stays pending; the mUSDC is gone", () => {
  const ok = faultChecks({ fault: "fail", transferId: "move:5", amountMicro: 11_000_000n, before: snap("35000000"), during: snap("24000000", pending("move:5", "to_hl")), after: snap("24000000", pending("move:5", "to_hl")), status: "FAILED" });
  assert.deepEqual([ok.resolved, ok.musdc.change, ok.musdc.expected_change, ok.pass], [true, "-11000000", "-11000000", true]);
  const vanished = faultChecks({ fault: "fail", transferId: "move:5", amountMicro: 11_000_000n, before: snap("35000000"), during: snap("24000000", pending("move:5", "to_hl")), after: snap("24000000"), status: "FAILED" });
  assert.deepEqual(vanished.words, ["transfer move:5 left pending though nothing came back"]);
});

test("late: SUCCESS after the delay, the transfer resolved by the delivery's msg, the mUSDC arrived", () => {
  const ok = faultChecks({ fault: "late", transferId: "move:6", amountMicro: 11_000_000n, deliveredMicro: 10_890_000n, before: snap("24000000"), during: snap("24000000", pending("move:6", "home")), after: snap("34890000"), status: "SUCCESS", late: { seconds: 130, delaySeconds: 90 } });
  assert.deepEqual([ok.pass, ok.late], [true, { seconds: 130, delay_seconds: 90, ok: true }]);
  const early = faultChecks({ fault: "late", transferId: "move:6", amountMicro: 11_000_000n, deliveredMicro: 10_890_000n, before: snap("24000000"), during: snap("24000000", pending("move:6", "home")), after: snap("34890000"), status: "SUCCESS", late: { seconds: 40, delaySeconds: 90 } });
  assert.deepEqual(early.words, ["the delivery came 40 s after the call, before the 90 s delay"]);
});

test("without a named transfer the account keeps no pending record, and the run says why", () => {
  const none = faultChecks({ fault: "refund", transferId: null, amountMicro: 11_000_000n, before: snap("35000000"), during: snap("24000000"), after: snap("35000000"), status: "REFUNDED" });
  assert.equal(none.pass, false);
  assert.match(none.words[0]!, /get_state has no next_move/);
});
