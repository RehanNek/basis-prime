// The credit-check page (PLAN.md 2, step 1; INTERFACES.md 18 and 22): the request it sends, and pb-risk's answer in
// plain words, ours next to Rhea's. No wallet: everything here is read from mainnet by pb-risk in OutLayer's enclave.
import type { CreditAnswer, CreditExample, CreditRequest, CreditResult, SpotToken } from './api.ts';
import { riskWords } from './risk.ts';
import type { Tier } from './types.ts';
import { formatBp, formatUnits, formatUsd, parseUnits } from './units.ts';
import { bindingWords } from './verdict.ts';

/** RISK_ENGINE.md 5.4's NEAR-side tokens on mainnet, with each token's decimals from its ft_metadata (read 9 Nov). */
export const SPOT_TOKENS: { token: SpotToken; id: string; decimals: number; label: string }[] = [
  { token: 'nBTC', id: 'nbtc.bridge.near', decimals: 8, label: 'nBTC' },
  { token: 'USDC', id: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6, label: 'USDC' },
  { token: 'ETH', id: 'eth.bridge.near', decimals: 18, label: 'ETH' },
  { token: 'USDT', id: 'usdt.tether-token.near', decimals: 6, label: 'USDt' },
  { token: 'wNEAR', id: 'wrap.near', decimals: 24, label: 'wNEAR' },
];
/** INTERFACES.md 18: at most 5 spot entries, each token once. */
export const MAX_SPOT_ROWS = 5;

export interface SpotRow {
  token: SpotToken;
  /** What was typed: "1.32". */
  amount: string;
}

const HL_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The request for an address or the worked example's book, plus the spot rows typed; or what is wrong with them. */
export function creditRequest(input: { address: string; book: CreditExample['book'] | null; rows: SpotRow[] }): { request: CreditRequest | null; problems: string[] } {
  const problems: string[] = [];
  const spot: { token: SpotToken; amount: string }[] = [];
  const seen = new Set<string>();
  for (const row of input.rows) {
    if (!row.amount.trim()) continue;
    const meta = SPOT_TOKENS.find((t) => t.token === row.token)!;
    if (seen.has(row.token)) {
      problems.push(`${meta.label} is listed twice: put it in one row`);
      continue;
    }
    seen.add(row.token);
    try {
      const units = parseUnits(row.amount, meta.decimals);
      if (units === '0') problems.push(`The ${meta.label} amount must be above 0`);
      else spot.push({ token: row.token, amount: units });
    } catch (error) {
      problems.push(`${meta.label}: ${(error as Error).message}`);
    }
  }
  if (input.book) return { request: problems.length ? null : { book: input.book, spot }, problems };
  const address = input.address.trim();
  if (!address) problems.unshift('Paste a Hyperliquid address, or use the worked example');
  else if (!HL_ADDRESS.test(address)) problems.unshift('A Hyperliquid address is 0x and 40 hex characters');
  return { request: problems.length ? null : { hl_address: address.toLowerCase(), spot }, problems };
}

/** The worked example's spot rows, as amounts to show and edit. */
export function exampleRows(example: CreditExample): SpotRow[] {
  return example.spot.map((s) => ({ token: s.token, amount: formatUnits(s.amount, SPOT_TOKENS.find((t) => t.token === s.token)!.decimals) }));
}

/** The worked example's book in words, with where its BTC price comes from. */
export function exampleWords(example: CreditExample): string {
  const short = example.book.positions[0];
  const usd = (micro: string) => formatUsd(micro.replace('-', '')).replace('.00', '');
  const read = new Date(example.read_at_ms).toISOString().slice(11, 16);
  return `${usd(example.book.usdc)} of USDC margin on Hyperliquid and a ${short ? usd(short.usd) : '$0'} ${short?.coin ?? 'BTC'} short, with $100,000 of nBTC at $${Number(example.btc_usd).toLocaleString('en-US')} a BTC: ${example.price_source}, read at ${read} UTC.`;
}

const TIER_NAMES: Record<string, string> = { PREFERRED: 'Preferred', STANDARD: 'Standard', WATCH: 'Watch' };

/** What sets our line, in words: the engine's bound, or a coin outside the list, or prices too uncertain to lend on. */
export function lineWords(binding: string, tier?: Tier): string {
  if (binding === 'UNLISTED') return 'a position or an order in a coin outside the allow-list: no credit while it is open';
  if (binding === 'PRICE') return 'prices that are uncertain right now: no new credit until they settle';
  return bindingWords(binding, tier);
}

/** Micro-USD a coin's unit: cents from $1 up, more digits below. */
export function formatPrice(micro: number): string {
  if (!Number.isFinite(micro)) return '?';
  const usd = micro / 1e6;
  return usd >= 1 ? `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${usd.toLocaleString('en-US', { maximumSignificantDigits: 4 })}`;
}

export interface CreditView {
  ok: boolean;
  /** pb-risk's refusal, when it gave no result. */
  refusal: string | null;
  ours: { line: string; firstWeek: string; firstWeekBinds: boolean; tier: string; score: number; rateNow: string; rateAt60: string; sets: string; util: string } | null;
  rhea: { safe: string; max: string; usdcRate: string; rows: { token: string; value: string; ratio: string; collateral: boolean }[]; error: string | null; contract: string; blk: number } | null;
  risks: string[];
  unlisted: { coins: string[]; more: number; without: string | null };
  ignored: { what: string; why: string }[];
  prices: { coin: string; price: string }[];
  pi: { token: string; ratio: string; source: string }[];
  warnings: string[];
}

/** pb-risk's credit_check result in words, for the page. */
export function creditView(answer: CreditAnswer): CreditView {
  const empty: CreditView = { ok: false, refusal: null, ours: null, rhea: null, risks: [], unlisted: { coins: [], more: 0, without: null }, ignored: [], prices: [], pi: [], warnings: [] };
  const result = answer.result;
  if (!result || result.ok !== true) {
    const reason = result && 'reason' in result ? result.reason : 'pb-risk answered nothing';
    return { ...empty, refusal: reason };
  }
  const r = result as CreditResult;
  const v = r.verdict;
  const tier = TIER_NAMES[v.tier] ?? v.tier;
  const firstWeek = Math.min(v.credit.line, r.limits.first_week);
  const without = r.without_unlisted;
  const warnings: string[] = [];
  if (v.topup > 0) warnings.push(`A Hyperliquid top-up of ${formatUsd(v.topup)} would take a liquidation out of the top risks.`);
  const coins = v.coins ?? { uncertain: [], stale: [], reduce_only: [] };
  if (coins.uncertain.length) warnings.push(`Prices are uncertain for ${coins.uncertain.join(', ')}: no new credit rests on them.`);
  if (coins.stale.length) warnings.push(`Prices are stale for ${coins.stale.join(', ')}.`);
  if (coins.reduce_only.length) warnings.push(`Reduce-only: ${coins.reduce_only.join(', ')}.`);
  return {
    ok: true,
    refusal: null,
    ours: {
      line: formatUsd(v.credit.line),
      firstWeek: formatUsd(firstWeek),
      firstWeekBinds: r.limits.first_week < v.credit.line,
      tier,
      score: v.score,
      rateNow: formatBp(v.rate_bp),
      rateAt60: formatBp(v.rate_bp_at_60),
      sets: lineWords(v.credit.binding, v.tier),
      util: formatBp(r.pool.util_bp),
    },
    rhea: {
      safe: formatUsd(r.rhea.safe),
      max: formatUsd(r.rhea.max),
      usdcRate: formatBp(r.rhea.usdc_borrow_apr_bp),
      rows: r.rhea.tokens.map((t) => ({ token: t.token, value: formatUsd(t.value), ratio: (t.volatility_bp / 10_000).toFixed(2), collateral: t.collateral })),
      error: r.rhea.error ?? null,
      contract: r.rhea.contract,
      blk: r.rhea.blk,
    },
    risks: v.top.map(riskWords),
    unlisted: {
      coins: r.unlisted,
      more: r.unlisted_more ?? 0,
      without: without
        ? `Without them the line would be ${formatUsd(without.line)} (${TIER_NAMES[without.tier] ?? without.tier}, score ${without.score}, ${formatBp(without.rate_bp)} a year), set by ${lineWords(without.binding, without.tier)}.`
        : null,
    },
    ignored: r.ignored,
    prices: Object.entries(r.prices).map(([coin, price]) => ({ coin, price: formatPrice(price) })),
    pi: Object.entries(r.pi).map(([token, p]) => ({ token, ratio: (p.bp / 10_000).toFixed(4), source: p.source })),
    warnings,
  };
}

/** How to check the result yourself, step by step, with what this page could check already. */
export function checkSteps(answer: CreditAnswer): string[] {
  const version = answer.program.version_key;
  const a = answer.attestation;
  const steps = [
    `pb-risk ran in an Intel TDX enclave on OutLayer${answer.run.call_id ? `, call ${answer.run.call_id}` : ''}, as ${answer.program.project_id}${version ? ` version ${version}` : ' (its active version)'}: the version our factory pins for new accounts.`,
    `Its attestation names the program and the output. Its wasm_hash should be ${version ?? 'the version above'}, and its output_hash ${answer.output_sha256}: the SHA-256 of this result with its keys sorted.`,
  ];
  if (a.found) {
    const both = a.wasm_matches !== false && a.output_matches !== false;
    steps.push(
      both
        ? `This page read the attestation: the wasm hash ${a.wasm_matches ? 'matches' : 'is there'} and the output hash ${a.output_matches ? 'matches' : 'is there'}.`
        : `This page read the attestation and something doesn't match: wasm ${a.wasm_matches === false ? 'differs' : 'ok'}, output ${a.output_matches === false ? 'differs' : 'ok'}. Don't rely on this result.`,
    );
  } else if (a.error) steps.push(`The attestation could not be read here (${a.error}); open the link to look.`);
  steps.push(
    'The wasm hash is the SHA-256 of the program, which builds from risk/pb-risk in this repo: anyone can rebuild it and compare.',
    'The result is a pure function of what pb-risk read. Run with "snapshot": true, pb-risk also returns those reads, and cargo run -p backtest --release -- credit <file> in risk/ recomputes the same result and prints its hash.',
  );
  return steps;
}
