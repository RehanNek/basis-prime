// Development only: sample answers for the Spot page's routes (INTERFACES.md 49.3), so the page can be looked at and
// clicked through with no backend route, no wallet and no testnet account. Nothing here is real: the prices are a
// snapshot typed in by hand, the "wallet" sends nothing, and the "swap" is two sums on the sample's own balances.
//   GET  /api/spot/tokens        25 tokens, five of which swap here
//   GET  /api/account/<id>       the sample account, whatever name is asked
//   POST /api/quote (swap)       the two prices, less 0.1%; with dry: false a deposit address and the next call
//   POST /api/check              a check that passes after 2.5 seconds (state `loan`)
//   GET  /api/status             waiting, then swapping, then delivered (or sent back, in state `refund`)
import type { Outcome, Tx } from '@/lib/tx';

/**
 * visitor: no wallet.            ready: an account with USDC, bitcoin and ETH, no loan.
 * loan: the same, owing our pool, so a swap runs a check first.
 * refund: the swap is sent back. new: a wallet with no account yet.
 * quiet: the routes answer 404, as a backend from before this page does.
 */
export const STATES = ['visitor', 'ready', 'loan', 'refund', 'new', 'quiet'] as const;
export type SpotState = (typeof STATES)[number];

export const OWNER = 'alice.testnet';
const USDC = 'musdc.pbf-ops.testnet';
const NBTC = 'mnbtc.pbf-ops.testnet';
const ETH = 'eth.pbf-ops.testnet';
const WNEAR = 'wnear.pbf-ops.testnet';
const USDT = 'usdt.pbf-ops.testnet';

interface Row {
  symbol: string;
  name: string;
  price_usd: number;
  decimals: number;
  token_id: string | null;
  lendable: boolean;
}

const here = (symbol: string, name: string, price_usd: number, decimals: number, token_id: string): Row => ({ symbol, name, price_usd, decimals, token_id, lendable: true });
const there = (symbol: string, name: string, price_usd: number, decimals: number): Row => ({ symbol, name, price_usd, decimals, token_id: null, lendable: false });

/** Dearest market first, as the route lists them. The five with an id swap here (INTERFACES.md 49.2). */
const ROWS: Row[] = [
  here('BTC', 'Bitcoin', 97_412.5, 8, NBTC),
  here('ETH', 'Ethereum', 3_150.25, 18, ETH),
  here('USDT', 'Tether', 1.0004, 6, USDT),
  there('XRP', 'XRP', 2.31, 6),
  there('BNB', 'BNB', 652.1, 18),
  there('SOL', 'Solana', 182.4, 9),
  here('USDC', 'USD Coin', 1, 6, USDC),
  there('DOGE', 'Dogecoin', 0.1525, 8),
  there('ADA', 'Cardano', 0.71, 6),
  there('TRX', 'TRON', 0.244, 6),
  there('LINK', 'Chainlink', 17.85, 18),
  there('AVAX', 'Avalanche', 27.4, 18),
  there('SUI', 'Sui', 3.62, 9),
  there('XLM', 'Stellar', 0.292, 7),
  there('TON', 'Toncoin', 3.95, 9),
  there('LTC', 'Litecoin', 104.2, 8),
  there('BCH', 'Bitcoin Cash', 421.6, 8),
  here('NEAR', 'NEAR Protocol', 3.18, 24, WNEAR),
  there('UNI', 'Uniswap', 9.42, 18),
  there('AAVE', 'Aave', 241.3, 18),
  there('APT', 'Aptos', 6.88, 8),
  there('ARB', 'Arbitrum', 0.512, 18),
  there('OP', 'Optimism', 1.21, 18),
  there('PEPE', 'Pepe', 0.00001235, 18),
  there('ZEC', 'Zcash', 58.7, 8),
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** One sample world: balances, the swaps under way, and the check a loan needs. */
export function makeStandin(state: SpotState) {
  const balances: Record<string, bigint> = state === 'new' ? {} : { [USDC]: 500_000_000n, [NBTC]: 1_550_000n, [ETH]: 20_000_000_000_000_000n, [WNEAR]: 0n, [USDT]: 0n };
  const swaps = new Map<string, { from: string; to: string; amountIn: bigint; amountOut: bigint; sentAt: number | null; settled: boolean }>();
  let height = 190_000_000;
  let counter = 4;
  let verdict: unknown = null;
  let quotes = 0;

  const rowOf = (tokenId: string) => ROWS.find((r) => r.token_id === tokenId);

  /** A swap whose deposit left 8 seconds ago is delivered: the token bought lands, or in `refund` the one sent comes back. */
  const settle = () => {
    for (const swap of swaps.values()) {
      if (swap.settled || swap.sentAt === null || Date.now() - swap.sentAt < 8_000) continue;
      swap.settled = true;
      if (state === 'refund') balances[swap.from] = (balances[swap.from] ?? 0n) + swap.amountIn;
      else balances[swap.to] = (balances[swap.to] ?? 0n) + swap.amountOut;
    }
  };

  const account = (id: string) => {
    settle();
    height += 5;
    const exists = state !== 'new';
    return {
      account_id: id,
      block_height: height,
      exists,
      has_contract: exists,
      state: exists ? { owner: OWNER, counter, permission_blk: 0, blocked: false, loan: state === 'loan' ? { principal: '200000000', open: true } : { principal: '0', open: false }, verdict, pending: [] } : null,
      balances: exists ? [USDC, NBTC, ETH, WNEAR, USDT].map((token) => ({ token, symbol: rowOf(token)!.symbol, decimals: rowOf(token)!.decimals, amount: (balances[token] ?? 0n).toString() })) : [],
      debt: state === 'loan' ? '200000000' : '0',
      borrower: null,
      not_deployed: [],
    };
  };

  const quote = (body: { dry?: boolean; account?: string; amount?: string; swap?: { from?: string; to?: string } }) => {
    const from = rowOf(body.swap?.from ?? '');
    const to = rowOf(body.swap?.to ?? '');
    if (!from || !to || !/^\d+$/.test(body.amount ?? '')) return json({ error: 'bad_request', message: 'swap needs two tokens of the account and a whole amount' }, 400);
    const amountIn = BigInt(body.amount!);
    const inUsd = (Number(amountIn) / 10 ** from.decimals) * from.price_usd;
    if (inUsd < 1) return json({ error: 'too_small', message: 'The least a swap takes is $1' }, 409);
    const outUsd = inUsd * 0.999;
    const amountOut = BigInt(Math.floor((outUsd / to.price_usd) * 10 ** Math.min(to.decimals, 8))) * 10n ** BigInt(Math.max(0, to.decimals - 8));
    const figures = { amountIn: amountIn.toString(), amountOut: amountOut.toString(), minAmountOut: ((amountOut * 99n) / 100n).toString(), amountInUsd: inUsd.toFixed(2), amountOutUsd: outUsd.toFixed(2), timeEstimate: 20 };
    const needsCheck = state === 'loan' ? { withdraw: { token: from.token_id, amount: amountIn.toString() } } : null;
    if (body.dry !== false) return json({ correlationId: 'sample', quote: figures, swap: { from: from.token_id, to: to.token_id, next: null, needs_check: needsCheck } });
    quotes += 1;
    const depositAddress = quotes.toString(16).padStart(64, '5');
    const exp = Date.now() + 10 * 60_000;
    swaps.set(depositAddress, { from: from.token_id!, to: to.token_id!, amountIn, amountOut, sentAt: null, settled: false });
    const selling = from.token_id !== USDC;
    return json({
      correlationId: 'sample',
      quote: { ...figures, depositAddress, deadline: new Date(exp).toISOString() },
      swap: {
        from: from.token_id,
        to: to.token_id,
        next: { method: 'withdraw', args: { token: from.token_id, amount: amountIn.toString(), receiver: depositAddress, ...(selling && { transfer: { kind: 'sell', exp, expect: { token: to.token_id, amount: amountOut.toString() } } }) } },
        transfer_id: selling ? `move:${quotes}` : null,
        needs_check: needsCheck,
      },
    });
  };

  const status = (depositAddress: string) => {
    settle();
    const swap = swaps.get(depositAddress);
    if (!swap) return json({ error: 'not_found', message: 'The sample knows no swap with that deposit address.' }, 404);
    const age = swap.sentAt === null ? -1 : Date.now() - swap.sentAt;
    const said = age < 0 || age < 3_000 ? 'PENDING_DEPOSIT' : age < 8_000 ? 'PROCESSING' : state === 'refund' ? 'REFUNDED' : 'SUCCESS';
    return json({ status: said, updatedAt: new Date().toISOString(), swapDetails: said === 'SUCCESS' ? { amountOut: swap.amountOut.toString() } : said === 'REFUNDED' ? { refundReason: 'the sample sends this one back' } : {} });
  };

  /** Answers the page's routes from the sample, or null for a path that isn't one of them. */
  const answer = async (path: string, init?: RequestInit): Promise<Response | null> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = () => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (state === 'quiet' && (path.startsWith('/api/spot/') || path === '/api/quote')) return json({ error: 'not_found', message: `No route for ${method} ${path}` }, 404);
    if (path.startsWith('/api/spot/tokens')) {
      await sleep(300);
      return json({ tokens: ROWS.map((r) => ({ ...r, on_intents: true, intents_asset: `nep141:${r.symbol.toLowerCase()}.sample`, swaps_here: r.token_id !== null })), read_at_ms: Date.now() });
    }
    if (path.startsWith('/api/account/')) return json(account(decodeURIComponent(path.slice('/api/account/'.length))));
    if (path === '/api/quote' && method === 'POST') {
      await sleep(500);
      return quote(body());
    }
    if (path === '/api/check' && method === 'POST') {
      await sleep(2_500);
      height += 10;
      verdict = { intent: body().intent, received_block: height, verdict: { ok: true, nonce: counter, blk: height - 2, state: 'HEALTHY', allow: { withdraw: 0, borrow: 0 } } };
      return json({ accepted: true, blk: height - 2, tries: 1, tx: 'SIMcheck11111111' });
    }
    if (path.startsWith('/api/status?')) return status(new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('depositAddress') ?? '');
    return null;
  };

  /** The sample wallet: it waits a moment, moves the sample's own figures, and sends nothing. */
  const sendTx = async (tx: Tx): Promise<Outcome> => {
    await sleep(1_200);
    const call = tx.actions[0];
    const args = (call?.args ?? {}) as { token?: string; amount?: string; receiver?: string };
    const swap = swaps.get(args.receiver ?? '');
    if (call?.methodName === 'withdraw' && swap && args.token && args.amount) {
      balances[args.token] = (balances[args.token] ?? 0n) - BigInt(args.amount);
      swap.sentAt = Date.now();
      counter += 1;
    }
    return { transaction: { hash: 'SIMspot1111111111' }, status: { SuccessValue: '' }, receipts_outcome: [] };
  };

  return { answer, sendTx };
}
