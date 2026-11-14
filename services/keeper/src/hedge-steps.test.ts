// The gate's steps against a fake world: the chain, the backend, Hyperliquid and the float tools are all stand-ins,
// so these check the step logic and its bookkeeping, not the network.
import assert from "node:assert/strict";
import { test } from "node:test";

import { EXPIRY_MS, MAX_ORDER_LIFE_MS, orderLifeOf, planFor, planForCoin, type GateCoin, StepFailed, StepRunner, underLine, type Auth, type HedgeRecord } from "./hedge-kit.js";
import { coinOf, collateralOf, floatCheck, leftovers, orderLife, stepBorrow, stepBurst, stepCloseShort, stepRefuseClose, stepRefuseCoin, stepRepay, stepShort, stepTakeOut, type Gate, type TxResult, type World } from "./hedge-steps.js";

const ACCOUNT = "demo.pbf.testnet";
const KEEPER = "pbf-keeper.testnet";
const FLOAT = "0xfc9d786b69b900ec51dfe8ebbf19ed47be59009d";
const MUSDC = "musdc.pbf-ops.testnet";

/** The chain, for the steps that send transactions: balances by "token:holder", the pool's debt, verdicts in turn. */
interface Chain {
  balances: Record<string, bigint>;
  debt: bigint;
  loanOpen: boolean;
  /** Handed out one per request_check. */
  verdicts: Record<string, unknown>[];
  sendOpenUntilMs?: number;
}

interface Script {
  /** The account's BTC position (negative is short). */
  position: number;
  /** Answers /api/order in turn; "fill" fills the whole order and moves the position. */
  orders: ({ fill: number } | { code: string } | "fill")[];
  previews: Record<string, unknown>[];
  floatOpen: { coin: string; oid: number }[];
  floatHeld: number;
  chain?: Chain;
  /** The float's perps USDC and room (activeAssetData). */
  floatUsdc?: string;
  floatMaxSz?: string;
  /**
   * Hyperliquid's BTC mark (75824.0 unless given), its oracle price (none unless given) and the top of its real
   * book (unreadable unless given); and the band the backend says the account's gateway uses (100 bp unless given).
   */
  mark?: string;
  oracle?: string;
  book?: { bid: string; ask: string };
  bandBp?: number;
  /** INTERFACES.md 50.4: what the backend's GET /api/markets says to sign an order for (`order_life_ms`). Left out: the answer has no such field. */
  orderLifeMs?: unknown;
  /** The backend's GET /api/markets answers 502. */
  marketsDown?: boolean;
  /** INTERFACES.md 51.1: the coin the account's position is in. BTC unless given. */
  coin?: string;
}

interface Sent {
  contract: string;
  method: string;
  args: Record<string, unknown>;
}

function fakeWorld(script: Script) {
  const log: string[] = [];
  const floatCalls: string[] = [];
  const gets: string[] = [];
  const orderMessages: string[] = [];
  const sent: Sent[] = [];
  let now = 1_794_000_000_000;
  let block = 100;
  let verdict: { received_block: number; verdict: Record<string, unknown> } | null = null;
  const bal = (token: string, holder: string) => script.chain!.balances[`${token}:${holder}`] ?? 0n;
  const move = (token: string, from: string | null, to: string, amount: bigint) => {
    const c = script.chain!;
    if (from) {
      if (bal(token, from) < amount) throw new Error(`${from} holds too little ${token}`);
      c.balances[`${token}:${from}`] = bal(token, from) - amount;
    }
    c.balances[`${token}:${to}`] = bal(token, to) + amount;
  };
  const world: World = {
    account: ACCOUNT,
    owner: KEEPER,
    ids: { factory: "pbf.testnet", pool: "pool.pbf.testnet", musdc: MUSDC, mnbtc: "mnbtc.pbf-ops.testnet", mpc: "v1.signer-prod.testnet", hlFloat: FLOAT },
    near: {
      call: async (contract, method, args, options) => {
        const c = script.chain;
        if (!c) throw new Error("no transactions in this test");
        sent.push({ contract, method, args });
        let result: unknown = null;
        const amount = BigInt(String(args.amount ?? "0"));
        if (method === "request_check") {
          block += 3;
          verdict = { received_block: block, verdict: c.verdicts.shift() ?? { ok: false, reason: "no verdict scripted" } };
          result = { accepted: true, reason: null };
        } else if (method === "borrow") {
          move(MUSDC, null, ACCOUNT, amount);
          c.debt += amount;
          c.loanOpen = true;
          result = true;
        } else if (method === "withdraw") {
          move(String(args.token), ACCOUNT, String(args.receiver), amount);
        } else if (method === "mint") {
          move(contract, null, String(args.account_id), amount);
        } else if (method === "ft_transfer_call") {
          move(contract, KEEPER, String(args.receiver_id), amount);
        } else if (method === "repay") {
          const used = amount < c.debt ? amount : c.debt;
          move(MUSDC, ACCOUNT, "pool.pbf.testnet", used);
          c.debt -= used;
          if (used < amount) c.loanOpen = false;
        } else {
          throw new Error(`unexpected call ${method}`);
        }
        return { label: options.label, hash: `H${sent.length}`, ok: true, gas_tgas: 1, seconds: 1, logs: [], result } satisfies TxResult;
      },
      view: async <T>(contract: string, method: string, args: Record<string, unknown> = {}) => {
        const c = script.chain;
        if (method === "debt_of") return (c ? c.debt.toString() : "100") as T;
        if (!c) return null as T;
        if (method === "ft_balance_of") return bal(contract, String(args.account_id)).toString() as T;
        if (method === "get_state") return { owner: KEEPER, counter: 3, loan: { principal: c.debt.toString(), open: c.loanOpen }, verdict, hl: { address: "0xa", send_open_until_ms: String(c.sendOpenUntilMs ?? 0) } } as T;
        if (method === "get_pool") return { cash: "10000000000998", loans: "0", capital: "10000000000998", paused: false, lent_24h: "-998", daily_budget: "1000000000099" } as T;
        if (method === "get_params") return { caps: { max_utilisation_bp: 9_000, client_share_bp: 2_500, new_account_limit: "25000000000", ceiling: { preferred: "5000000000000", standard: "1000000000000", watch: "100000000000" } } } as T;
        if (method === "get_borrower") return { debt: c.debt.toString(), tier: "WATCH", first_week_until: "1794657605449467967", blocked: false } as T;
        throw new Error(`unexpected view ${method}`);
      },
      exists: async () => true,
      finalBlockMs: async () => now,
    },
    api: {
      get: async (path) => {
        gets.push(path);
        // GET /api/markets?account=: the bands of the account's own pinned gateway (services/api/src/hl-handlers.ts).
        if (path.startsWith("/api/markets")) {
          if (script.marketsDown) return { status: 502, body: { error: "backend_down", message: "the backend isn't answering" } };
          return { status: 200, body: { band_from: "account", gateway_version: "9a2e", band_floor_bp: 0, ...("orderLifeMs" in script ? { order_life_ms: script.orderLifeMs } : {}), coins: [{ coin: "BTC", band_bp: script.bandBp ?? 100 }, { coin: "TAO", band_bp: 300 }, { coin: "ETH", band_bp: 300 }] } };
        }
        if (path.startsWith("/api/hl/")) {
          const positions = script.position === 0 ? [] : [{ position: { coin: script.coin ?? "BTC", szi: String(script.position) } }];
          return { status: 200, body: { owner: KEEPER, near_time_ms: now, hl: { address: "0xa" }, gateway: {}, hyperliquid: { clearinghouse_state: { crossMarginSummary: { accountValue: "59" }, withdrawable: "50", assetPositions: positions }, spot_usdc: { total: "0" }, open_orders: [], agents: [] } } };
        }
        throw new Error(`unexpected GET ${path}`);
      },
      post: async (path, body) => {
        if (path === "/api/preview") return { status: 200, body: { verdict: script.previews.shift(), run: { call_id: "pv", attestation_url: "https://a/pv" } } };
        if (path === "/api/order" || path === "/api/cancel") {
          const auth = (body as { auth: Auth }).auth;
          orderMessages.push(auth.message);
          const order = (JSON.parse(auth.message) as { order: { sz: string; is_buy: boolean } }).order;
          const next = script.orders.shift() ?? { code: "P8" };
          if (next === "fill" || "fill" in next) {
            const filled = next === "fill" ? Number(order.sz) : next.fill;
            script.position += order.is_buy ? filled : -filled;
            return { status: 200, body: { ok: true, status: filled < Number(order.sz) ? "partial" : "filled", filled_sz: String(filled), avg_px: "75600", call_id: `c${orderMessages.length}`, attestation_url: `https://a/c${orderMessages.length}` } };
          }
          return { status: 200, body: { ok: false, code: next.code, reason: `refused by ${next.code}`, call_id: `c${orderMessages.length}` } };
        }
        throw new Error(`unexpected POST ${path}`);
      },
    },
    hl: {
      info: async <T>(body: Record<string, unknown>) => {
        if (body.type === "metaAndAssetCtxs") return [{ universe: [{ name: "BTC", szDecimals: 5 }, { name: "TAO", szDecimals: 3 }, { name: "ETH", szDecimals: 4 }] }, [{ markPx: script.mark ?? "75824.0", ...(script.oracle ? { oraclePx: script.oracle } : {}) }, { markPx: "222.7" }, { markPx: "1913.1" }]] as T;
        // info `l2Book`: the bids, then the asks, best first (read on testnet on 12 Nov).
        if (body.type === "l2Book" && script.book) return { coin: body.coin, time: now, levels: [[{ px: script.book.bid, sz: "0.00126", n: 2 }], [{ px: script.book.ask, sz: "0.00053", n: 1 }]] } as T;
        if (body.type === "clearinghouseState") return { withdrawable: script.floatUsdc ?? "790.6", assetPositions: script.floatHeld ? [{ position: { coin: "BTC", szi: String(script.floatHeld) } }] : [] } as T;
        if (body.type === "openOrders") return script.floatOpen as T;
        if (body.type === "activeAssetData") return { maxTradeSzs: [script.floatMaxSz ?? "0.2", script.floatMaxSz ?? "0.2"], leverage: { type: "cross", value: 20 } } as T;
        throw new Error(`unexpected info ${String(body.type)}`);
      },
    },
    float: {
      order: async ({ side, sz, px, tif }) => {
        floatCalls.push(`order ${side} ${sz} at ${px} ${tif}`);
        return { oid: 900 + floatCalls.length, text: "Hyperliquid: resting" };
      },
      cancel: async (oid) => {
        floatCalls.push(`cancel ${oid}`);
        return "cancelled";
      },
      close: async () => {
        floatCalls.push("close");
        return "closed";
      },
    },
    sign: async (message) => ({ owner: KEEPER, public_key: "ed25519:x", signature: "s", message, nonce: "n", recipient: "pb-gateway" }),
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
    log: (line) => log.push(line),
  };
  return { world, log, floatCalls, orderMessages, sent, gets };
}

function gate(world: World, context: Record<string, unknown> = {}, size: "small" | "full" = "small"): Gate {
  const record: HedgeRecord = { version: 1, account: ACCOUNT, owner: KEEPER, size, api_url: "x", started_utc: "t", plan: planFor(size, 75_824), context, steps: [] };
  return { runner: new StepRunner(record, () => {}, () => {}, Date.now), plan: record.plan, world, name: "demo" };
}

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

test("the short: the float bids, IOC sells go through the gateway until the size is done, the float's leftover is cancelled", async () => {
  const script: Script = { position: 0, orders: [{ fill: 0.005 }, { code: "P0" }, "fill"], previews: [], floatOpen: [], floatHeld: 0 };
  const { world, floatCalls, orderMessages } = fakeWorld(script);
  const g = gate(world);
  await stepShort(g);

  const step = g.runner.record.steps[0]!;
  assert.equal(step.pass, true);
  assert.equal(Number(script.position.toFixed(5)), -0.015);
  assert.deepEqual(floatCalls, ["order buy 0.015 at 75596 Gtc", "cancel 901"], "a bid 0.3% under the mark, cancelled after");
  assert.deepEqual(
    orderMessages.map((m) => (JSON.parse(m) as { order: { sz: string } }).order.sz),
    ["0.015", "0.01", "0.01"],
    "what is left after a partial fill, and again after P0",
  );
  assert.ok(orderMessages.every((m) => m.startsWith('{"pb":"order","account":"demo.pbf.testnet","order":{"coin":"BTC","is_buy":false,')));
  assert.deepEqual(step.gateway.map((r) => [r.ok, r.code ?? null, r.call_id]), [[true, null, "c1"], [false, "P0", "c2"], [true, null, "c3"]]);
  assert.equal(g.runner.record.context.float_open_oid, null);
});

test("the borrow: a preview's line less 0.5%, a borrow check for it, then borrow", async () => {
  const chain: Chain = { balances: { [`${MUSDC}:${ACCOUNT}`]: USDC(10) }, debt: 0n, loanOpen: false, verdicts: [{ ok: true, state: "HEALTHY", tier: "STANDARD", allow: { borrow: 1_103_150_000, withdraw: 10_000_000 } }] };
  const { world, sent } = fakeWorld({ position: -0.015, orders: [], previews: [{ ok: true, state: "HEALTHY", tier: "STANDARD", allow: { borrow: 1_103_200_000, withdraw: 10_000_000 }, credit: { line: 1_103_200_000, binding: "C4" } }], floatOpen: [], floatHeld: 0, chain });
  const g = gate(world);
  await stepBorrow(g);
  const step = g.runner.record.steps[0]!;
  assert.equal(step.pass, true, JSON.stringify(step.detail));
  const amount = underLine(1_103_200_000n).toString();
  assert.equal(amount, "1097574230", "0.5% under the line, then 0.01% and 2 micro-USDC");
  assert.deepEqual(sent.map((s) => [s.method, JSON.stringify(s.args)]), [
    ["request_check", JSON.stringify({ intent: { borrow: { amount } } })],
    ["borrow", JSON.stringify({ amount })],
  ]);
  assert.equal(g.runner.record.context.borrowed, amount);
  assert.equal((step.detail as { set_by: string }).set_by, "the line less 0.5%");
});

test("the take-out: a withdrawal check for the loan, then the mUSDC goes to the keeper", async () => {
  const loan = 1_097_574_230n;
  const chain: Chain = { balances: { [`${MUSDC}:${ACCOUNT}`]: USDC(10) + loan }, debt: loan, loanOpen: true, verdicts: [{ ok: true, state: "HEALTHY", tier: "STANDARD", allow: { borrow: 0, withdraw: Number(loan) } }] };
  const { world, sent } = fakeWorld({ position: -0.015, orders: [], previews: [{ ok: true, state: "HEALTHY", allow: { borrow: 770_000_000, withdraw: 1_105_560_000 } }], floatOpen: [], floatHeld: 0, chain });
  const g = gate(world, { borrowed: loan.toString() });
  await stepTakeOut(g);
  const step = g.runner.record.steps[0]!;
  assert.equal(step.pass, true, JSON.stringify(step.detail));
  assert.deepEqual(sent.map((s) => [s.method, JSON.stringify(s.args)]), [
    ["request_check", JSON.stringify({ intent: { withdraw: { token: MUSDC, amount: loan.toString() } } })],
    ["withdraw", JSON.stringify({ token: MUSDC, amount: loan.toString(), receiver: KEEPER })],
  ]);
  assert.equal(chain.balances[`${MUSDC}:${ACCOUNT}`], USDC(10), "the client's own $10 stays");
  assert.equal(chain.balances[`${MUSDC}:${KEEPER}`], loan);
  assert.equal(g.runner.record.context.taken_out, loan.toString());

  // Taken out already (a resumed run): nothing is sent twice.
  const again = fakeWorld({ position: -0.015, orders: [], previews: [], floatOpen: [], floatHeld: 0, chain });
  const g2 = gate(again.world, { borrowed: loan.toString() });
  await stepTakeOut(g2);
  assert.equal(g2.runner.record.steps[0]!.pass, true);
  assert.deepEqual(again.sent, []);
});

test("the take-out stops when the engine refuses it, and while a signed transfer out of Hyperliquid can be posted", async () => {
  const loan = 1_000_000_000n;
  const refused: Chain = { balances: { [`${MUSDC}:${ACCOUNT}`]: loan }, debt: loan, loanOpen: true, verdicts: [{ ok: true, state: "HEALTHY", allow: { borrow: 0, withdraw: 0 } }] };
  const r = fakeWorld({ position: -0.015, orders: [], previews: [{ ok: true, state: "HEALTHY", allow: { withdraw: 1_000_000_000 } }], floatOpen: [], floatHeld: 0, chain: refused });
  await assert.rejects(stepTakeOut(gate(r.world, { borrowed: loan.toString() })), (e: unknown) => e instanceof StepFailed && e.step.ok === false);
  assert.deepEqual(r.sent.map((s) => s.method), ["request_check"], "no withdrawal without the verdict");

  const shut: Chain = { balances: { [`${MUSDC}:${ACCOUNT}`]: loan }, debt: loan, loanOpen: true, verdicts: [], sendOpenUntilMs: 1_794_200_000_000 };
  const s = fakeWorld({ position: -0.015, orders: [], previews: [], floatOpen: [], floatHeld: 0, chain: shut });
  await assert.rejects(stepTakeOut(gate(s.world, { borrowed: loan.toString() })), /signed a transfer out of Hyperliquid that can be posted until 2026-11-\d\dT.*Use a new --name/);
  assert.deepEqual(s.sent, []);
});

test("the repay: the keeper puts the loan back (minting only what it lacks), then repays the debt and a margin", async () => {
  const debt = 1_097_700_000n;
  const want = debt + debt / 1_000n + 1_000_000n;
  const chain: Chain = { balances: { [`${MUSDC}:${ACCOUNT}`]: USDC(10), [`${MUSDC}:${KEEPER}`]: 1_097_574_230n }, debt, loanOpen: true, verdicts: [] };
  const { world, sent } = fakeWorld({ position: -0.015, orders: [], previews: [], floatOpen: [], floatHeld: 0, chain });
  const g = gate(world);
  await stepRepay(g);
  const step = g.runner.record.steps[0]!;
  assert.equal(step.pass, true, JSON.stringify(step.detail));
  const putBack = want - USDC(10);
  assert.deepEqual(sent.map((s) => [s.method, String(s.args.amount)]), [
    ["ft_transfer_call", putBack.toString()],
    ["repay", want.toString()],
  ]);
  assert.equal(chain.debt, 0n);
  assert.equal(chain.loanOpen, false, "the pool sent part of it back, so the loan is closed");
  assert.equal(chain.balances[`${MUSDC}:${ACCOUNT}`], want - debt + 0n, "the margin over the debt is back in the account");

  const poor: Chain = { balances: { [`${MUSDC}:${ACCOUNT}`]: 0n, [`${MUSDC}:${KEEPER}`]: 5_000_000n }, debt: 100_000_000n, loanOpen: true, verdicts: [] };
  const p = fakeWorld({ position: 0, orders: [], previews: [], floatOpen: [], floatHeld: 0, chain: poor });
  await stepRepay(gate(p.world));
  const need = 100_000_000n + 100_000n + 1_000_000n;
  assert.deepEqual(p.sent.map((s) => [s.method, String(s.args.amount)]), [
    ["mint", (need - 5_000_000n).toString()],
    ["ft_transfer_call", need.toString()],
    ["repay", need.toString()],
  ]);
});

test("a refusal step passes only with the code it expects", async () => {
  const p8 = fakeWorld({ position: -0.015, orders: [{ code: "P8" }], previews: [], floatOpen: [], floatHeld: 0 });
  const g1 = gate(p8.world);
  await stepRefuseClose(g1);
  assert.equal(g1.runner.record.steps[0]!.pass, true);
  const msg = JSON.parse(p8.orderMessages[0]!) as { order: { is_buy: boolean; reduce_only: boolean; sz: string; limit_px: string; tif: string } };
  assert.deepEqual(msg.order, { coin: "BTC", is_buy: true, sz: "0.015", limit_px: "75596", reduce_only: true, tif: "Ioc" }, "the whole short, reduce-only, under the asks");

  // Let through by the checks (Hyperliquid then had nothing to fill it against): not as expected, but the run goes on
  // to the close-out, and the final test sees it.
  const hl = fakeWorld({ position: -0.015, orders: [{ code: "HL" }], previews: [], floatOpen: [], floatHeld: 0 });
  const g2 = gate(hl.world);
  await stepRefuseClose(g2);
  assert.deepEqual([g2.runner.record.steps[0]!.pass, g2.runner.record.steps[0]!.code], [false, "HL"]);

  const p1 = fakeWorld({ position: 0, orders: [{ code: "P1" }], previews: [], floatOpen: [], floatHeld: 0 });
  const g3 = gate(p1.world);
  await stepRefuseCoin(g3);
  assert.equal(g3.runner.record.steps[0]!.pass, true);
  assert.match(p1.orderMessages[0]!, /"coin":"TAO","is_buy":true,"sz":"0.048","limit_px":"222.03"/);
});

test("the burst: 40 orders at once, tallied; it passes when the book after is HEALTHY and within P8's credit conditions", async () => {
  const answers: Script["orders"] = [...Array(3).fill("fill"), ...Array(30).fill({ code: "P0" }), ...Array(7).fill({ code: "P8" })];
  const healthy = { ok: true, state: "HEALTHY", tier: "STANDARD", eq: 477_000_000, eq_allow: 476_850_000, im: 248_100_000 };
  const loan: Chain = { balances: {}, debt: 1_097_700_000n, loanOpen: true, verdicts: [] };
  const ok = fakeWorld({ position: -0.015, orders: [...answers], previews: [healthy], floatOpen: [], floatHeld: 0, chain: loan });
  const g = gate(ok.world);
  await stepBurst(g);
  const step = g.runner.record.steps[0]!;
  assert.equal(step.pass, true, JSON.stringify(step.detail));
  assert.equal(step.gateway.filter((r) => r.label.startsWith("burst #")).length, 40);
  assert.deepEqual((step.detail as { tally: unknown }).tally, { sent: 40, filled: 3, partial: 0, resting: 0, refused: { P0: 30, P8: 7 }, filled_sz: 0.00042 });
  assert.deepEqual(ok.floatCalls, ["order buy 0.0056 at 75596 Gtc", "cancel 901"]);
  const expires = new Set(ok.orderMessages.map((m) => (JSON.parse(m) as { expires_ms: number }).expires_ms));
  assert.equal(expires.size, 1, "all 40 signed at once, 110 s ahead");

  const under = fakeWorld({ position: -0.015, orders: [...answers], previews: [{ ...healthy, eq_allow: 240_000_000 }], floatOpen: [], floatHeld: 0, chain: { ...loan } });
  const g2 = gate(under.world);
  await stepBurst(g2);
  assert.equal(g2.runner.record.steps[0]!.pass, false, "allowance equity under the requirement afterwards: more filled than the checks allow");

  const capped = fakeWorld({ position: -0.015, orders: [...answers], previews: [healthy], floatOpen: [], floatHeld: 0, chain: { ...loan, debt: 1_200_000_000n } });
  const g3 = gate(capped.world);
  await stepBurst(g3);
  assert.match(JSON.stringify(g3.runner.record.steps[0]!.detail), /above 70% of collateral/, "the loan above the Standard tier's 70% cap");
  assert.equal(g3.runner.record.steps[0]!.pass, false);
});

test("an action that fails stops the run; a float that can't carry its side stops it before posting", async () => {
  const { world, floatCalls } = fakeWorld({ position: 0, orders: [], previews: [], floatOpen: [], floatHeld: 0, floatMaxSz: "0.0001" });
  await assert.rejects(stepShort(gate(world)), (e: unknown) => e instanceof StepFailed && /can trade 0\.0001 BTC.*top up/.test(e.message));
  assert.deepEqual(floatCalls, [], "nothing posted");
});

test("the float check: the move to Hyperliquid comes out of the float's perps USDC, and it needs margin for its side", async () => {
  const today = fakeWorld({ position: 0, orders: [], previews: [], floatOpen: [], floatHeld: 0, floatUsdc: "790.6", floatMaxSz: "0.20866" });
  const small = await floatCheck(today.world, planFor("small", 75_824));
  assert.equal(small.problem, null);
  assert.deepEqual([small.need_usdc, small.side_btc], [544, 0.015], "430 to move, and a tenth of its $1,137 side");
  assert.ok(small.room_after_move > 0.09 && small.room_after_move < 0.1, String(small.room_after_move));

  const full = await floatCheck(today.world, planFor("full", 75_824));
  assert.match(full.problem ?? "", /holds 790\.60 USDC in perps and can trade 0\.20866 BTC\. A full run needs about 12000 USDC there: the 9500 it delivers/);
});

test("after a stop: the float's resting orders are cancelled; positions are listed with the commands that close them", async () => {
  const { world, floatCalls } = fakeWorld({ position: -0.015, orders: [], previews: [], floatOpen: [{ coin: "BTC", oid: 77 }], floatHeld: 0.015 });
  const lines = await leftovers(world, true);
  assert.deepEqual(floatCalls, ["cancel 77"]);
  assert.match(lines[0]!, /demo\.pbf\.testnet holds -0\.015 BTC.*--name demo --size <size> --from repay \(it puts the loan back and repays first/);
  assert.match(lines[1]!, /the float's open BTC order 77: cancelled/);
  assert.match(lines[2]!, /the float holds 0\.015 BTC: pnpm --filter @pb\/oneclick-shim float:close -- --coin BTC/);
  const quiet = fakeWorld({ position: 0, orders: [], previews: [], floatOpen: [], floatHeld: 0 });
  assert.deepEqual(await leftovers(quiet.world, true), ["nothing is open on Hyperliquid"]);
});

test("a remainder under $10: opening sends a $10.5 order instead; closing stops and reports it as dust", async () => {
  const open = fakeWorld({ position: 0, orders: [{ fill: 0.01495 }, "fill"], previews: [], floatOpen: [], floatHeld: 0 });
  const g1 = gate(open.world);
  await stepShort(g1);
  assert.deepEqual(open.orderMessages.map((m) => (JSON.parse(m) as { order: { sz: string } }).order.sz), ["0.015", "0.00014"], "0.00005 left is $3.79: sent as 0.00014");
  assert.equal(g1.runner.record.steps[0]!.pass, true);

  const close = fakeWorld({ position: -0.0002, orders: [{ fill: 0.0001 }], previews: [], floatOpen: [], floatHeld: 0 });
  await assert.rejects(stepCloseShort(gate(close.world)), (e: unknown) => {
    assert.ok(e instanceof StepFailed);
    assert.equal((e.step.detail as { left: number }).left, -0.0001);
    assert.match((e.step.detail as { dust: string }).dust, /0\.0001 BTC is left: under Hyperliquid's \$10 minimum/);
    return true;
  });
  assert.equal(close.orderMessages.length, 1, "no order for the dust");
  assert.deepEqual(close.floatCalls, ["order sell 0.0002 at 76051 Gtc", "cancel 901"]);
});

// ---------- the gateway's price band (INTERFACES.md 42) ----------

/** Hyperliquid testnet on 12 Nov, when the Rhea gate's hedge was refused: the mark 1.96% over its oracle price. */
const NOV_12 = { mark: "74421.0", oracle: "72987.0", book: { bid: "74421.0", ask: "74427.0" } };
const limitOf = (message: string) => (JSON.parse(message) as { order: { limit_px: string; is_buy: boolean } }).order;

test("12 Nov's prices under the 3% band of a new gateway: the short, the close that is refused, the burst and the close each price 0.3% through the mark, and the band is asked of the backend for this account", async () => {
  // The short: the float bids at 74197, 1.66% over the oracle (inside 3%) and under the best ask; the sells go there.
  const short = fakeWorld({ position: 0, orders: ["fill"], previews: [], floatOpen: [], floatHeld: 0, ...NOV_12, bandBp: 300 });
  const g1 = gate(short.world);
  await stepShort(g1);
  assert.deepEqual(short.floatCalls, ["order buy 0.015 at 74197 Gtc", "cancel 901"]);
  assert.deepEqual(limitOf(short.orderMessages[0]!), { coin: "BTC", is_buy: false, sz: "0.015", limit_px: "74197", reduce_only: false, tif: "Ioc" });
  const opened = g1.runner.record.steps[0]!.detail as Record<string, unknown>;
  assert.deepEqual([opened.mark, opened.oracle, opened.band_bp, opened.band_from, opened.px, opened.could_close_at], [74_421, 72_987, 300, "account", "74197", "74644"]);
  assert.ok(short.gets.includes("/api/markets?account=demo.pbf.testnet"), "the band is the backend's, for the gate's own account");

  // The close that must be refused by a risk check: the same price, under the asks and inside the band, so P2 isn't the reason.
  const refuse = fakeWorld({ position: -0.015, orders: [{ code: "P8" }], previews: [], floatOpen: [], floatHeld: 0, ...NOV_12, bandBp: 300 });
  const g2 = gate(refuse.world);
  await stepRefuseClose(g2);
  assert.deepEqual([g2.runner.record.steps[0]!.pass, limitOf(refuse.orderMessages[0]!).limit_px, limitOf(refuse.orderMessages[0]!).is_buy], [true, "74197", true]);

  // The burst: the float's bid and the 40 sells at the same price.
  const healthy = { ok: true, state: "HEALTHY", tier: "STANDARD", eq: 477_000_000, eq_allow: 476_850_000, im: 248_100_000 };
  const burst = fakeWorld({ position: -0.015, orders: Array(40).fill("fill"), previews: [healthy], floatOpen: [], floatHeld: 0, chain: { balances: {}, debt: 1_097_700_000n, loanOpen: true, verdicts: [] }, ...NOV_12, bandBp: 300 });
  await stepBurst(gate(burst.world));
  assert.equal(burst.floatCalls[0], "order buy 0.0056 at 74197 Gtc");
  assert.deepEqual([...new Set(burst.orderMessages.map((m) => limitOf(m).limit_px))], ["74197"]);

  // The close: the float asks at 74644, 2.27% over the oracle (inside 3%) and over the best bid; the buys go there.
  // The 1% band's cap would have put this ask at 73643, under the real bids.
  const close = fakeWorld({ position: -0.015, orders: ["fill"], previews: [], floatOpen: [], floatHeld: 0, ...NOV_12, bandBp: 300 });
  await stepCloseShort(gate(close.world));
  assert.deepEqual(close.floatCalls, ["order sell 0.015 at 74644 Gtc", "cancel 901"]);
  assert.deepEqual([limitOf(close.orderMessages[0]!).limit_px, limitOf(close.orderMessages[0]!).is_buy, close.gets.includes("/api/markets?account=demo.pbf.testnet")], ["74644", true, true]);
});

test("12 Nov's prices under the 1% band of an older gateway: no short is opened that couldn't be closed, a close waits in words, and nothing is posted to the real book", async () => {
  // The bid alone would fit (held down to 0.9% over the oracle), but no ask the gateway takes sits over the bids.
  const short = fakeWorld({ position: 0, orders: ["fill"], previews: [], floatOpen: [], floatHeld: 0, ...NOV_12, bandBp: 100 });
  await assert.rejects(stepShort(gate(short.world)), (e: unknown) => {
    assert.ok(e instanceof StepFailed);
    assert.equal(
      e.message,
      "Hyperliquid's mark ($74,421) stands 1.96% over its oracle price ($72,987), and the account's gateway takes a price at most 1% from its reference price, which follows the oracle. The highest price it would take, about $73,643, is at or under the best bid ($74,421): an order the gateway takes couldn't fill, and the float's ask there would cross the real book. A short opened now couldn't be closed through the gateway, so it isn't opened: nothing was posted",
    );
    return true;
  });
  assert.deepEqual([short.floatCalls, short.orderMessages], [[], []]);

  // A short that is open already: the close stops with the same words, and the float posts no ask under the real bids.
  const close = fakeWorld({ position: -0.015, orders: ["fill"], previews: [], floatOpen: [], floatHeld: 0, ...NOV_12, bandBp: 100 });
  await assert.rejects(stepCloseShort(gate(close.world)), (e: unknown) => e instanceof StepFailed && /is at or under the best bid \(\$74,421\).*Nothing was posted, and the short stays open: run from close_short again once the mark is back inside$/.test(e.message));
  assert.deepEqual([close.floatCalls, close.orderMessages], [[], []]);

  // The close that is meant to be refused still goes: held to 0.9% over the oracle it is inside the band and under the asks.
  const refuse = fakeWorld({ position: -0.015, orders: [{ code: "P8" }], previews: [], floatOpen: [], floatHeld: 0, ...NOV_12, bandBp: 100 });
  const g = gate(refuse.world);
  await stepRefuseClose(g);
  assert.deepEqual([g.runner.record.steps[0]!.pass, limitOf(refuse.orderMessages[0]!).limit_px], [true, "73643"]);

  // 11 Nov, the mark 0.77% over the oracle: an older gateway's hedge goes through, the ask held to 0.9% over the oracle.
  const nov11 = { mark: "76585.0", oracle: "76000.0", book: { bid: "76585.0", ask: "76591.0" } };
  const open = fakeWorld({ position: 0, orders: ["fill"], previews: [], floatOpen: [], floatHeld: 0, ...nov11, bandBp: 100 });
  await stepShort(gate(open.world));
  assert.equal(open.floatCalls[0], "order buy 0.015 at 76355 Gtc");
  const shut = fakeWorld({ position: -0.015, orders: ["fill"], previews: [], floatOpen: [], floatHeld: 0, ...nov11, bandBp: 100 });
  await stepCloseShort(gate(shut.world));
  assert.equal(shut.floatCalls[0], "order sell 0.015 at 76683 Gtc");

  // A backend that gives no band stops the step: the gate takes the band from nowhere else.
  const silent = fakeWorld({ position: 0, orders: [], previews: [], floatOpen: [], floatHeld: 0, bandBp: 0 });
  await assert.rejects(stepShort(gate(silent.world)), (e: unknown) => e instanceof StepFailed && /the backend's GET \/api\/markets gave no price band for BTC \(HTTP 200\)/.test(e.message));
  assert.deepEqual(silent.floatCalls, []);
});

// ---------- INTERFACES.md 50.4: a signed order lives up to 4 minutes on testnet ----------

/** The fake's clock at its start: its final block's time, which an order's expiry is counted from. */
const START = 1_794_000_000_000;
const aheadOf = (messages: string[]) => messages.map((m) => (JSON.parse(m) as { expires_ms: number }).expires_ms - START);
const HEALTHY_AFTER = { ok: true, state: "HEALTHY", tier: "STANDARD", eq: 477_000_000, eq_allow: 476_850_000, im: 248_100_000 };

test("50.4: the gate signs every order for the life the backend says for the account's own gateway: 230 s on the new one, for the short, the refused close, the 40 at once, the off-list coin and the close", async () => {
  const on = (script: Omit<Script, "orderLifeMs">): Script => ({ ...script, orderLifeMs: 230_000 });

  const short = fakeWorld(on({ position: 0, orders: ["fill"], previews: [], floatOpen: [], floatHeld: 0 }));
  const g = gate(short.world);
  await stepShort(g);
  assert.deepEqual(aheadOf(short.orderMessages), [230_000]);
  assert.equal((g.runner.record.steps[0]!.detail as { order_life_ms: number }).order_life_ms, 230_000, "the record says what it signed for");

  const refused = fakeWorld(on({ position: -0.015, orders: [{ code: "P8" }], previews: [], floatOpen: [], floatHeld: 0 }));
  await stepRefuseClose(gate(refused.world));
  assert.deepEqual(aheadOf(refused.orderMessages), [230_000]);

  const burst = fakeWorld(on({ position: -0.015, orders: Array(40).fill({ code: "P0" }), previews: [HEALTHY_AFTER], floatOpen: [], floatHeld: 0, chain: { balances: {}, debt: 1_097_700_000n, loanOpen: true, verdicts: [] } }));
  await stepBurst(gate(burst.world));
  assert.deepEqual([burst.orderMessages.length, [...new Set(aheadOf(burst.orderMessages))]], [40, [230_000]], "all 40 signed at once, 230 s ahead");

  const coin = fakeWorld(on({ position: 0, orders: [{ code: "P1" }], previews: [], floatOpen: [], floatHeld: 0 }));
  await stepRefuseCoin(gate(coin.world));
  assert.deepEqual(aheadOf(coin.orderMessages), [230_000]);
  assert.ok(coin.gets.includes("/api/markets?account=demo.pbf.testnet"), "asked of the backend for the gate's own account");

  const close = fakeWorld(on({ position: -0.015, orders: ["fill"], previews: [], floatOpen: [], floatHeld: 0 }));
  await stepCloseShort(gate(close.world));
  assert.deepEqual(aheadOf(close.orderMessages), [230_000]);

  // An account on an older gateway is told 110 s, and that is what its orders are signed for.
  const older = fakeWorld({ position: 0, orders: ["fill"], previews: [], floatOpen: [], floatHeld: 0, orderLifeMs: 110_000 });
  await stepShort(gate(older.world));
  assert.deepEqual(aheadOf(older.orderMessages), [110_000]);
});

test("50.4: the gate falls back to 110 s when the backend doesn't say how long to sign for: no such field, a figure no gateway takes, or a backend that doesn't answer", async () => {
  assert.equal(EXPIRY_MS, 110_000);
  // A backend from before 50.4: its answer has the band and no order_life_ms.
  const before = fakeWorld({ position: 0, orders: ["fill"], previews: [], floatOpen: [], floatHeld: 0 });
  await stepShort(gate(before.world));
  assert.deepEqual(aheadOf(before.orderMessages), [110_000]);
  const burst = fakeWorld({ position: -0.015, orders: Array(40).fill({ code: "P0" }), previews: [HEALTHY_AFTER], floatOpen: [], floatHeld: 0, chain: { balances: {}, debt: 1_097_700_000n, loanOpen: true, verdicts: [] } });
  await stepBurst(gate(burst.world));
  assert.deepEqual([...new Set(aheadOf(burst.orderMessages))], [110_000]);

  // Figures that aren't a life: over the 230 s the longest-lived gateway is signed for, under 10 s, not a whole number, not a number.
  for (const odd of [230_001, 240_000, 3_600_000, 9_999, 0, -5, 150_000.5, "230000", null, true]) {
    assert.equal(orderLifeOf({ order_life_ms: odd }), 110_000, String(odd));
    const world = fakeWorld({ position: 0, orders: [{ code: "P1" }], previews: [], floatOpen: [], floatHeld: 0, orderLifeMs: odd });
    await stepRefuseCoin(gate(world.world));
    assert.deepEqual(aheadOf(world.orderMessages), [110_000], String(odd));
  }
  assert.deepEqual([orderLifeOf({ order_life_ms: 230_000 }), orderLifeOf({ order_life_ms: 110_000 }), orderLifeOf({ order_life_ms: 10_000 }), orderLifeOf({}), orderLifeOf(null), orderLifeOf("x"), MAX_ORDER_LIFE_MS], [230_000, 110_000, 10_000, 110_000, 110_000, 110_000, 230_000]);

  // The backend down: a step that reads only the life still signs, for 110 s.
  const down = fakeWorld({ position: 0, orders: [{ code: "P1" }], previews: [], floatOpen: [], floatHeld: 0, marketsDown: true, orderLifeMs: 230_000 });
  assert.equal(await orderLife(down.world), 110_000);
  await stepRefuseCoin(gate(down.world));
  assert.deepEqual(aheadOf(down.orderMessages), [110_000]);
  const up = fakeWorld({ position: 0, orders: [], previews: [], floatOpen: [], floatHeld: 0, orderLifeMs: 230_000 });
  assert.equal(await orderLife(up.world), 230_000);
});

// ---------- INTERFACES.md 51.1: the hedge steps take the coin; with none set, bitcoin as before ----------

const ETH_COIN: GateCoin = { coin: "ETH", szDecimals: 4, token: "meth.pbf-ops.testnet", tokenDecimals: 18 };

test("51.1, the ETH plan is the bitcoin plan's book in dollars: test ETH worth the bitcoin, cut to ETH's 4 size decimals and written in its 18, and a short of that size; for BTC the plan is the one of before", () => {
  const btc = planFor("small", 67_400);
  assert.deepEqual(planForCoin("small", 67_400, { coin: "BTC", szDecimals: 5, token: "mnbtc.pbf-ops.testnet", tokenDecimals: 8 }, 67_400), btc);
  const eth = planForCoin("small", 67_400, ETH_COIN, 1_913.1);
  // 0.015 BTC at $67,400 is $1,011; at $1,913.1 an ETH that is 0.52846..., cut to 0.5284.
  assert.deepEqual([eth.short_sz, eth.deposit_nbtc_units, eth.btc_px, eth.coin, eth.token_decimals], ["0.5284", "528400000000000000", 1_913.1, "ETH", 18]);
  assert.equal(BigInt(eth.deposit_nbtc_units), 5_284n * 10n ** 14n, "to the unit: 0.5284 with 18 decimals");
  assert.deepEqual([eth.deposit_usdc_micro, eth.to_hl_micro, eth.caps], [btc.deposit_usdc_micro, btc.to_hl_micro, btc.caps], "the USDC side and the caps are the bitcoin plan's");
  assert.equal(eth.burst.sz, "0.0055", "the small orders are sized in ETH, with ETH's size decimals");
  assert.deepEqual([btc.coin, btc.token_decimals, btc.short_sz, btc.deposit_nbtc_units], [undefined, undefined, "0.015", "1500000"]);
  assert.throws(() => planForCoin("small", 67_400, ETH_COIN, 0), /the ETH price 0 doesn't look right/);
});

test("51.1, with the coin set to ETH the short's orders name ETH with ETH's size decimals and price rule, and the deposit and the withdrawal are the ETH token's; with none set they are bitcoin's, as before", async () => {
  const script: Script = { position: 0, orders: ["fill"], previews: [], floatOpen: [], floatHeld: 0, coin: "ETH", bandBp: 300, mark: "75824.0", floatMaxSz: "5" };
  const eth = fakeWorld(script);
  eth.world.coin = ETH_COIN;
  const g = gate(eth.world);
  g.plan = planForCoin("small", 75_824, ETH_COIN, 1_913.1);
  await stepShort(g);
  const order = (JSON.parse(eth.orderMessages[0]!) as { order: Record<string, unknown> }).order;
  // 0.3% under ETH's mark of $1,913.1, to five figures, as Hyperliquid writes a price.
  assert.deepEqual(order, { coin: "ETH", is_buy: false, sz: "0.5945", limit_px: "1907.3", reduce_only: false, tif: "Ioc" });
  assert.deepEqual(eth.floatCalls, ["order buy 0.5945 at 1907.3 Gtc", "cancel 901"]);
  assert.equal(script.position, -0.5945, "the fake's position is in ETH");
  assert.match(g.runner.record.steps[0]!.label, /^open the short: 0\.5945 ETH through the gateway$/);

  // No coin set: the order of before, in BTC with 5 size decimals.
  const btc = fakeWorld({ position: 0, orders: ["fill"], previews: [], floatOpen: [], floatHeld: 0 });
  const gb = gate(btc.world);
  await stepShort(gb);
  assert.deepEqual((JSON.parse(btc.orderMessages[0]!) as { order: Record<string, unknown> }).order, { coin: "BTC", is_buy: false, sz: "0.015", limit_px: "75596", reduce_only: false, tif: "Ioc" });
  assert.match(gb.runner.record.steps[0]!.label, /^open the short: 0\.015 BTC through the gateway$/);
  assert.deepEqual([collateralOf(btc.world), collateralOf(eth.world), coinOf(btc.world), coinOf(eth.world)], ["mnbtc.pbf-ops.testnet", "meth.pbf-ops.testnet", "BTC", "ETH"]);
});
