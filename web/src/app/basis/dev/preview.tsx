'use client';
// The Basis trade page from sample data (development only; see page.tsx). A stand-in answers the page's calls to
// /api/... from a small made-up account, and plays the chain, Hyperliquid, Aave's chain and 1Click on it, so both
// runs can be walked from end to end without a wallet. With `wallet=refuses` the wallet turns every approval down, as
// a client who closes the wallet would. Nothing is signed or sent, and nothing here ships: a production build
// answers this page with "not found".
import { useEffect, useMemo, useState } from 'react';

import { CloseTrade } from '@/components/basis/close-trade';
import { OpenTrade } from '@/components/basis/open-trade';
import { useBasisData } from '@/components/basis/use-basis-data';
import type { AccountAnswer, ConfigAnswer, LenderAccountAnswer, MarketsAnswer, PoolAnswer } from '@/lib/api';
import type { HlAnswer } from '@/lib/hl';
import { BORROWER, DEMO_BORROW, PARAMS, POOL, STATE } from '@/lib/test-fixtures';
import type { Tx } from '@/lib/tx';
import type { Intent, StoredVerdict } from '@/lib/types';
import { NearContext, type NearContextValue } from '@/providers/near-provider';
import { SESSION_OFF, SessionContext } from '@/providers/session-provider';

import { PREVIEW_STATES, type PreviewState } from './states';

const OWNER = 'alice.testnet';
const USDC = 'musdc.pbf-ops.testnet';
const NBTC = 'mnbtc.pbf-ops.testnet';
const AAVE_USDC = '0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f';
const WETH = '0x4200000000000000000000000000000000000006';
const EVM_ADDRESS = '0x8c01b1a86db01769c246d3739da0bb74ae3217fb';
const TOKENS = [
  { id: USDC, symbol: 'USDC', decimals: 6 },
  { id: NBTC, symbol: 'nBTC', decimals: 8 },
];
const WETH_POSTED = 20_000_000_000_000_000n;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The made-up account, and everything around it that the page reads. Money is micro-USD. */
interface World {
  /** State `btc-out`: Hyperliquid testnet's BTC price stands too far from its reference price for any order. */
  far: boolean;
  exists: boolean;
  usdc: bigint;
  nbtc: bigint;
  debt: bigint;
  counter: number;
  block: number;
  verdict: StoredVerdict | null;
  pending: { transfer: { id: string; kind: string; token: string; amount: string; dep: string; deadline: string } }[];
  moves: Record<string, string>;
  nextMove: number;
  hlAddress: boolean;
  hlUsd: bigint;
  agent: boolean;
  approved: boolean;
  short: boolean;
  hlSigned: { index: number; kind: string; amount: bigint }[];
  evmUsdc: bigint;
  evmWeth: bigint;
  posted: bigint;
  /** What Aave is owed, and what the last check read of it. */
  aaveOwed: bigint;
  aaveChecked: bigint;
  evmNonce: number;
  signed: { nonce: number; kind: string; token?: string; amount?: string; hash: string; status: string }[];
  approvedTokens: string[];
}

function worldFor(state: PreviewState): World {
  const base: World = {
    far: state === 'btc-out',
    exists: state !== 'new' && state !== 'btc-out',
    usdc: 0n,
    nbtc: 0n,
    debt: 0n,
    counter: 3,
    block: 1_000,
    verdict: null,
    pending: [],
    moves: {},
    nextMove: 1,
    hlAddress: false,
    hlUsd: 0n,
    agent: false,
    approved: false,
    short: false,
    hlSigned: [],
    evmUsdc: 0n,
    evmWeth: 0n,
    posted: 0n,
    aaveOwed: 0n,
    aaveChecked: 0n,
    evmNonce: 0,
    signed: [],
    approvedTokens: [],
  };
  if (state === 'new' || state === 'empty' || state === 'btc-out') return base;
  const coin = { ...base, nbtc: 1_500_000n, hlAddress: true };
  if (state === 'margin') return { ...coin, usdc: 450_000_000n };
  const hedged = { ...coin, usdc: 10_000_000n, hlUsd: 430_000_000n, agent: true, approved: true, short: true };
  if (state === 'loan') return { ...hedged, evmWeth: WETH_POSTED };
  const borrowed = [
    { nonce: 0, kind: 'approve', token: WETH, hash: '0x00', status: 'mined' },
    { nonce: 1, kind: 'supply', token: WETH, amount: WETH_POSTED.toString(), hash: '0x01', status: 'mined' },
    { nonce: 2, kind: 'borrow', token: AAVE_USDC, amount: '21710000', hash: '0x02', status: 'mined' },
  ];
  const atAave = { ...hedged, posted: WETH_POSTED, aaveChecked: 21_710_000n, evmNonce: 3, signed: borrowed };
  if (state === 'open') return { ...atAave, usdc: 488_280_000n, debt: 478_280_000n, evmUsdc: 21_719_550n, aaveOwed: 21_710_000n };
  // The loan from Aave was brought home and our pool repaid: Aave is owed, and its USDC is on NEAR.
  if (state === 'aave-home') return { ...atAave, usdc: 31_715_000n, aaveOwed: 21_710_000n };
  // Aave repaid, and the last check still shows the loan (INTERFACES.md 48.13).
  return { ...atAave, evmUsdc: 9_016n, evmNonce: 5, approvedTokens: [AAVE_USDC], signed: [...borrowed, { nonce: 3, kind: 'approve', token: AAVE_USDC, hash: '0x03', status: 'mined' }, { nonce: 4, kind: 'repay', token: AAVE_USDC, amount: '21710534', hash: '0x04', status: 'mined' }] };
}

// ---------- the reads ----------

function account(id: string, w: World): AccountAnswer {
  return {
    account_id: id,
    block_height: w.block,
    exists: w.exists,
    has_contract: w.exists,
    state: w.exists
      ? {
          ...STATE,
          owner: OWNER,
          counter: w.counter,
          verdict: w.verdict,
          loan: { principal: w.debt.toString(), open: w.debt > 0n },
          pending: w.pending,
          hl: { path: 'hyperliquid-1', address: w.hlAddress ? '0xabc' : null },
          evm: { nonce: w.evmNonce, signed: [], approved: w.approvedTokens },
        }
      : null,
    balances: [
      { token: USDC, symbol: 'USDC', decimals: 6, amount: w.usdc.toString() },
      { token: NBTC, symbol: 'nBTC', decimals: 8, amount: w.nbtc.toString() },
    ],
    debt: w.debt.toString(),
    borrower: w.exists ? BORROWER : null,
    not_deployed: [],
  };
}

function hl(id: string, w: World): HlAnswer {
  const value = (Number(w.hlUsd) / 1e6).toFixed(2);
  return {
    account_id: id,
    owner: OWNER,
    block_height: w.block,
    near_time_ms: Date.now(),
    hl: { path: 'hyperliquid-1', address: w.hlAddress ? '0xabc' : null, agent: w.agent ? { address: '0xAGENT', received_block: 900 } : null, signed: w.hlSigned.map((e) => ({ index: e.index, kind: e.kind, action: '{}', nonce: e.index, signature: { r: '0x', s: '0x', v: 27 }, signed_block: w.block })) },
    address: w.hlAddress ? '0xabc' : null,
    gateway: { project_id: 'pbf-keeper.testnet/pb-gateway', version_key: null },
    hyperliquid: w.hlAddress
      ? {
          clearinghouse_state: {
            marginSummary: { accountValue: value, totalNtlPos: '0', totalMarginUsed: '0' },
            crossMarginSummary: { accountValue: value, totalNtlPos: '0', totalMarginUsed: '0' },
            crossMaintenanceMarginUsed: '0',
            withdrawable: w.short ? (Number(w.hlUsd) / 2e6).toFixed(2) : value,
            assetPositions: w.short ? [{ position: { coin: 'BTC', szi: '-0.015', entryPx: '76000', positionValue: '1140', unrealizedPnl: '0', liquidationPx: null, leverage: { type: 'cross', value: 5 }, marginUsed: '228' } }] : [],
          },
          spot_usdc: null,
          abstraction: null,
          open_orders: [],
          fills: [],
          agents: w.approved ? [{ name: 'pb', address: '0xagent', validUntil: null }] : [],
          errors: {},
        }
      : null,
  };
}

function lender(id: string, w: World): LenderAccountAnswer {
  return {
    account: id,
    read_at_ms: Date.now(),
    config_lenders: ['aave', 'rhea'],
    permission: { lenders: ['aave', 'rhea'], min_hf_bp: 15_000, max_rate_bp: 2_500, moves: 'any' },
    funding: null,
    verdict_blk: null,
    // What the last check read: after a repayment it still shows the loan until the next check.
    lenders: w.aaveChecked > 0n ? [{ l: 'aave', posted: 39_260_000, debt: Number(w.aaveChecked), hf_bp: 15_400, liq_bp: 8_300, rate_bp: 74, supply_bp: 10, room: 0, status: 'safe' }] : [],
    pricing: null,
    evm: w.hlAddress
      ? {
          address: EVM_ADDRESS,
          nonce: w.evmNonce,
          chain_nonce: w.evmNonce,
          eth: '2000000000000000',
          wallet: [
            { token: AAVE_USDC, symbol: 'USDC', decimals: 6, amount: w.evmUsdc.toString() },
            { token: WETH, symbol: 'WETH', decimals: 18, amount: w.evmWeth.toString() },
          ],
          posted: w.posted > 0n ? [{ token: WETH, symbol: 'WETH', decimals: 18, amount: w.posted.toString() }] : [],
          signed: w.signed,
        }
      : null,
  };
}

const CONFIG: ConfigAnswer = {
  network: 'testnet',
  ids: { factory: 'pbf.testnet', pool: 'pool.pbf.testnet', operator: 'pbf-ops.testnet', keeper: 'pbf-keeper.testnet', tokens: TOKENS, drill: 'drill.pbf-ops.testnet', mpc: 'v1.signer-prod.testnet', outlayer: 'outlayer.testnet', risk_project: 'pbf-keeper.testnet/pb-risk', shim_float: null },
  deployed: { 'pbf.testnet': true, 'pool.pbf.testnet': true },
  factory_config: { tokens: TOKENS, lenders: { aave: {}, rhea: {} } },
  preview_enabled: false,
  privacy: { mode: 'off' },
};

const MARKETS: MarketsAnswer = {
  network: 'testnet',
  hl_api: 'api.hyperliquid-testnet.xyz',
  hl_error: null,
  params_hash: '',
  params_hash_pinned: null,
  params_hash_matches: null,
  pool_statuses: 'read',
  // INTERFACES.md 50.4: the sample account's gateway is testnet's new one, so its orders are signed for 230 s.
  order_life_ms: 230_000,
  coins: [{ coin: 'BTC', allowed: true, tier: 1, band_bp: 300, universe_sz_decimals: 5, client_cap_usd: 1_000_000, testnet: { asset: 3, sz_decimals: 5, max_leverage: 40, delisted: false, mark_px: '76010', oracle_px: '76000', mid_px: null, day_ntl_vlm: null }, status: null }],
};

const POOL_ANSWER: PoolAnswer = { pool_id: 'pool.pbf.testnet', deployed: true, block_height: 1_000, pool: POOL, params: PARAMS };

// ---------- the writes: the chain, Hyperliquid, Aave's chain and 1Click, played on the made-up account ----------

const event = (name: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard: 'pb-pool', version: '1.0.0', event: name, data: [data] })}`;
const outcome = (logs: string[] = []) => ({ transaction: { hash: `preview${Math.random().toString(36).slice(2, 10)}` }, status: { SuccessValue: '' }, receipts_outcome: [{ outcome: { logs, status: { SuccessValue: '' } } }] });
const later = (ms: number, effect: () => void) => void setTimeout(effect, ms);
const drop = (w: World, id: string) => {
  w.pending = w.pending.filter((p) => p.transfer.id !== id);
};

/** What one transaction does to the made-up account, and the logs it leaves. */
function apply(w: World, tx: Tx): string[] {
  const logs: string[] = [];
  for (const { methodName: method, args } of tx.actions) {
    const a = args as Record<string, string> & { transfer?: { kind: string; exp: number } };
    const amount = BigInt(a.amount ?? '0');
    const sign = (kind: string, token?: string) => {
      const entry = { nonce: w.evmNonce++, kind, token, amount: a.amount, hash: `0x${(w.evmNonce + 16).toString(16)}`, status: 'signed' };
      w.signed = [...w.signed, entry];
      logs.push(event('evm_signed', { nonce: entry.nonce, kind, hash: entry.hash }));
    };
    const list = (kind: string, token: string, dep: string) => {
      const id = `move:${w.nextMove++}`;
      w.pending = [...w.pending, { transfer: { id, kind, token, amount: a.amount, dep, deadline: `${Date.now() + 40 * 60_000}000000` } }];
      return id;
    };
    if (method === 'create_account') w.exists = true;
    else if (method === 'mint' && tx.receiverId === USDC) w.usdc += amount;
    else if (method === 'mint') w.nbtc += amount;
    else if (method === 'hl_init') w.hlAddress = true;
    else if (method === 'request_agent') later(1_500, () => (w.agent = true));
    else if (method === 'hl_approve_agent' || method === 'hl_withdraw') {
      const entry = { index: w.hlSigned.length, kind: method === 'hl_withdraw' ? 'sendAsset' : 'approveAgent', amount };
      w.hlSigned = [...w.hlSigned, entry];
      if (method === 'hl_withdraw') list('home', 'USDC', a.destination);
      logs.push(event('hl_signed', { index: entry.index, kind: entry.kind }));
    } else if (method === 'withdraw' && a.transfer?.kind === 'to_hl') {
      w.usdc -= amount;
      const id = list('to_hl', a.token, a.receiver);
      later(3_000, () => {
        w.hlUsd += amount - 1_000_000n;
        w.moves[a.receiver] = 'SUCCESS';
        drop(w, id);
      });
    } else if (method === 'withdraw' && a.transfer?.kind === 'to_evm') {
      w.usdc -= amount;
      list('to_evm', a.token, a.receiver);
      // It arrives, and stays listed until a check sees it.
      later(4_000, () => {
        w.evmUsdc += amount - 5_000n;
        w.moves[a.receiver] = 'SUCCESS';
      });
    } else if (method === 'withdraw') {
      if (a.token === USDC) w.usdc -= amount;
      else w.nbtc -= amount;
    } else if (method === 'repay') {
      const paid = amount < w.debt ? amount : w.debt;
      w.usdc -= paid;
      w.debt -= paid;
    } else if (method === 'fund' || method === 'borrow') {
      w.debt += amount;
      w.usdc += amount;
      w.counter += 1;
    } else if (method === 'evm_approve') {
      sign('approve', a.token);
      w.approvedTokens = [...w.approvedTokens, a.token];
    } else if (method === 'lender_repay') sign('repay', AAVE_USDC);
    else if (method === 'lender_withdraw') sign('withdraw', a.token);
    else if (method === 'evm_withdraw') {
      sign('transfer', a.token);
      list('e_home', a.token, a.to);
      if (w.debt > 0n) w.counter += 1;
    } else if (method === 'forget_transfer') drop(w, a.id);
  }
  return logs;
}

/** A signed transaction reaches Aave's chain and is mined. */
function mine(w: World, nonce: number) {
  const entry = w.signed.find((e) => e.nonce === nonce);
  if (!entry) return null;
  const amount = BigInt(entry.amount ?? '0');
  if (entry.status !== 'mined') {
    if (entry.kind === 'repay') {
      const paid = amount < w.aaveOwed ? amount : w.aaveOwed;
      w.evmUsdc -= paid;
      w.aaveOwed -= paid;
    } else if (entry.kind === 'withdraw') {
      w.posted -= amount;
      w.evmWeth += amount;
    } else if (entry.kind === 'transfer') {
      const home = w.pending.find((p) => p.transfer.kind === 'e_home' && p.transfer.amount === entry.amount);
      if (entry.token === AAVE_USDC) w.evmUsdc -= amount;
      else w.evmWeth -= amount;
      later(4_000, () => {
        if (entry.token === AAVE_USDC) w.usdc += amount - 5_000n;
        else w.nbtc += 56_013n;
        if (home) drop(w, home.transfer.id);
      });
    }
    w.signed = w.signed.map((e) => (e.nonce === nonce ? { ...e, status: 'mined' } : e));
  }
  return { hash: entry.hash, status: 'mined', reverted: false };
}

/** The stand-in's answer to one call, or undefined for a path it doesn't know. */
function answer(path: string, body: Record<string, unknown> | null, w: World): unknown {
  const id = decodeURIComponent(path.split('?')[0]!.split('/').pop() ?? '');
  if (!body) {
    if (path.startsWith('/api/config')) return CONFIG;
    if (path.startsWith('/api/pool')) return POOL_ANSWER;
    // 13 Nov, 22:28 UTC: BTC's mark stood 2.60% under its oracle price.
    if (path.startsWith('/api/markets')) return w.far ? { ...MARKETS, coins: MARKETS.coins.map((c) => ({ ...c, testnet: c.testnet && { ...c.testnet, mark_px: '74024', oracle_px: '76000' } })) } : MARKETS;
    if (path.startsWith('/api/evm/gas')) return { on: true };
    if (path.startsWith('/api/account/')) return account(id, w);
    if (path.startsWith('/api/hl/')) return hl(id, w);
    if (path.startsWith('/api/lender/')) return lender(id, w);
    if (path.startsWith('/api/status')) return { status: w.moves[new URLSearchParams(path.split('?')[1]).get('depositAddress') ?? ''] ?? 'PROCESSING', updatedAt: new Date().toISOString() };
    return undefined;
  }
  if (path.startsWith('/api/quote')) {
    const move = String(body.move);
    const amount = String(body.amount);
    const exp = Date.now() + 10 * 60_000;
    const n = w.nextMove;
    const dep = move === 'to_hl' ? `dep-hl-${n}` : move === 'to_evm' ? `dep-evm-${n}` : move === 'home' ? '0xf10a7' : `0x${'1'.repeat(39)}${n % 10}`;
    const token = String(body.token ?? (move === 'e_home' ? AAVE_USDC : USDC));
    const next =
      move === 'to_hl' || move === 'to_evm'
        ? { method: 'withdraw', args: { token: move === 'to_hl' ? USDC : token, amount, receiver: dep, transfer: { kind: move, exp } } }
        : move === 'home'
          ? { method: 'hl_withdraw', args: { amount, destination: dep, exp } }
          : { method: 'evm_withdraw', args: { token, amount, to: dep, exp } };
    const check = w.debt === 0n ? null : move === 'e_home' ? { evm_withdraw: { token, amount } } : move === 'to_evm' ? { withdraw: { token, amount } } : null;
    return {
      correlationId: 'preview',
      quote: { depositAddress: dep, depositMemo: move === 'home' || move === 'e_home' ? `memo-${n}` : null, amountIn: amount, amountInFormatted: amount, amountOut: amount, amountOutFormatted: amount, minAmountOut: amount, timeEstimate: 4, deadline: new Date(exp).toISOString() },
      move: { kind: move, account: body.account, next, transfer_id: `move:${n}`, exp_ms: exp, needs_check: check },
    };
  }
  if (path.startsWith('/api/hl/submit')) {
    const entry = w.hlSigned[Number(body.index)];
    if (!entry) return undefined;
    if (entry.kind === 'approveAgent') w.approved = true;
    else {
      w.hlUsd -= entry.amount;
      later(3_000, () => {
        w.usdc += entry.amount;
        const home = w.pending.find((p) => p.transfer.kind === 'home');
        if (home) drop(w, home.transfer.id);
      });
    }
    return { account: body.account, index: entry.index, kind: entry.kind, nonce: 1, ok: true, http_status: 200, hl: { status: 'ok' } };
  }
  if (path.startsWith('/api/order')) {
    w.short = !w.short;
    return { ok: true, status: 'filled', filled_sz: '0.015', avg_px: '76000', sent: { coin: 'BTC', is_buy: !w.short, sz: '0.015', limit_px: '76000', tif: 'Ioc', reduce_only: !w.short } };
  }
  if (path.startsWith('/api/evm/submit')) return mine(w, Number(body.nonce)) ?? undefined;
  if (path.startsWith('/api/evm/gas')) {
    const mint = body.mint as { amount?: string } | undefined;
    if (mint) w.evmUsdc += BigInt(mint.amount ?? '0');
    else if (body.wrap) w.evmWeth += WETH_POSTED;
    return { address: EVM_ADDRESS, eth: { hash: null, balance: '2000000000000000', sent: null }, mint: mint ? { hash: '0xfa', amount: mint.amount ?? '0', mined: true, ok: true } : null, wrap: body.wrap ? { hash: '0xfb', amount: WETH_POSTED.toString(), mined: true, ok: true } : null };
  }
  if (path.startsWith('/api/check')) {
    // The check lands a moment later: the account stores its result, and it sees what has arrived on Aave's chain.
    const intent = body.intent as Intent;
    later(2_500, () => {
      w.block += 1;
      const asked = 'fund' in intent ? Number(intent.fund.amount) : 0;
      w.verdict = { intent, received_block: w.block, verdict: { ...DEMO_BORROW, nonce: w.counter, blk: w.block, allow: { withdraw: 1e15, borrow: 500_000_000, fund: asked }, fund: asked ? [{ k: 'p_borrow', amt: asked }] : [] } };
      w.pending = w.pending.filter((p) => !(p.transfer.kind === 'to_evm' && w.moves[p.transfer.dep] === 'SUCCESS'));
      w.aaveChecked = w.aaveOwed;
    });
    return { accepted: true, blk: w.block + 1, tries: 1, tx: null };
  }
  return undefined;
}

export function BasisPreview({ state, refuses }: { state: PreviewState; refuses: boolean }) {
  const world = useMemo(() => worldFor(state), [state]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
      if (!url.startsWith('/api/')) return real(input, init);
      const body = init?.method === 'POST' ? (JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>) : null;
      const found = answer(url, body, world);
      if (found !== undefined) return new Response(JSON.stringify(found), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ error: 'preview', message: 'The preview has no answer for this call.' }), { status: 404 });
    };
    const timer = setTimeout(() => setReady(true), 0);
    return () => {
      clearTimeout(timer);
      window.fetch = real;
    };
  }, [world]);

  const wallet = useMemo((): NearContextValue => {
    const refuse = async (): Promise<never> => {
      await sleep(1_200);
      throw new Error('User rejected the request');
    };
    const send = async (tx: Tx) => {
      await sleep(1_200);
      return outcome(apply(world, tx));
    };
    return {
      loading: false,
      signedAccountId: OWNER,
      signIn: async () => undefined,
      signOut: async () => undefined,
      viewFunction: async () => ({ tokens: TOKENS }),
      callFunction: refuse,
      sendTx: refuses ? refuse : send,
      sendTxs: refuses ? refuse : async (txs) => Promise.all(txs.map(send)),
      signMessage: refuses ? refuse : async () => (await sleep(800), { accountId: OWNER, publicKey: `ed25519:${'1'.repeat(32)}`, signature: `${'A'.repeat(86)}==` }),
    };
  }, [world, refuses]);

  return (
    <main className="pb-container pb-page" style={{ maxWidth: 880 }}>
      <h1 className="h3">Basis trade</h1>
      <p className="small pb-muted">
        Sample data, state “{state}” ({PREVIEW_STATES.join(', ')}). The wallet here {refuses ? 'refuses every approval' : 'approves at once, and a stand-in plays the chain'}: nothing is signed or sent.
      </p>
      {ready && (
        <NearContext.Provider value={wallet}>
          <SessionContext.Provider value={SESSION_OFF}>
            <Body />
          </SessionContext.Provider>
        </NearContext.Provider>
      )}
    </main>
  );
}

function Body() {
  const data = useBasisData();
  const [running, setRunning] = useState<'open' | 'close' | null>(null);
  return (
    <>
      <OpenTrade data={data} closing={running === 'close'} onRunning={(on) => setRunning(on ? 'open' : null)} />
      <CloseTrade data={data} opening={running === 'open'} onRunning={(on) => setRunning(on ? 'close' : null)} />
    </>
  );
}
