'use client';
// Everything the Basis trade page reads (INTERFACES.md 49.1, point 5): the account, its Hyperliquid side, its lenders,
// the markets, the pool, and the tokens of the account's own settings. The page decides every step from these reads,
// never from what it remembers, so a reload shows the trade where it really stands.
import { NetworkId } from '@/config';
import { useApi } from '@/hooks/use-api';
import { useClientAccount } from '@/hooks/use-client-account';
import { useLenderAccount } from '@/hooks/use-lender-account';
import { useNow } from '@/hooks/use-now';
import { useOwnSettings } from '@/hooks/use-own-settings';
import { CONFIG_PATH, EVM_GAS_PATH, hlPath, marketsPath, POOL_PATH, type ConfigAnswer, type EvmGasInfo, type MarketsAnswer, type PoolAnswer } from '@/lib/api';
import { basisTokens, settingsTokens, type SettingsToken } from '@/lib/basis';
import { borrowEstimate, rateFor } from '@/lib/cockpit';
import { lenderPositions, rheaCollateralOf, wouldPostWord } from '@/lib/funding';
import { holdsLoan, type HlAnswer } from '@/lib/hl';
import { loanView } from '@/lib/loan';
import { configuredLenders, defaultPermission } from '@/lib/permission';
import { freshness, SECONDS_PER_BLOCK } from '@/lib/verdict';

export function useBasisData() {
  const client = useClientAccount();
  const answer = client.answer;
  const state = answer?.state ?? null;
  /** The account once it exists: nothing about Hyperliquid or lenders is read before. */
  const accountId = state ? answer!.account_id : null;
  const testnet = NetworkId === 'testnet';
  const config = useApi<ConfigAnswer>(CONFIG_PATH);
  const pool = useApi<PoolAnswer>(POOL_PATH, 15_000);
  const hl = useApi<HlAnswer>(accountId ? hlPath(accountId) : null, 10_000);
  const markets = useApi<MarketsAnswer>(marketsPath(accountId), 30_000);
  const lender = useLenderAccount(accountId);
  const lenderData = lender.data;
  const gasHelp = useApi<EvmGasInfo>(testnet && (lenderData?.config_lenders ?? []).includes('aave') ? EVM_GAS_PATH : null, 60_000);
  const now = useNow(5_000);
  const hlData = hl.data?.account_id === accountId ? hl.data : undefined;
  const own = useOwnSettings(accountId);

  // The settings the trade's token comes from: the account's own once it exists, and the factory's, which a new
  // account gets, before. Where the settings can't be read, the tokens the backend reads balances for stand in.
  const known: SettingsToken[] = (answer?.balances ?? config.data?.ids.tokens.map((t) => ({ token: t.id, symbol: t.symbol, decimals: t.decimals })) ?? []).map((b) => ({
    id: b.token,
    symbol: b.symbol,
    decimals: b.decimals,
  }));
  const settings = accountId ? (own.tokens ?? known) : (settingsTokens(config.data?.factory_config) ?? known);
  const options = basisTokens(settings, known.map((t) => t.symbol), markets.data?.coins, testnet);
  const usdc = known.find((t) => t.symbol === 'USDC') ?? null;
  // INTERFACES.md 51.1: the tokens Rhea takes from this account (its own settings; the factory's before it is opened),
  // and what Rhea would take in a word: only what the list names, so an account from before is promised nothing more.
  const rheaCollateral = accountId ? own.rheaCollateral : rheaCollateralOf(config.data?.factory_config);
  const holds = (id: string) => BigInt(answer?.balances.find((b) => b.token === id)?.amount ?? '0') > 0n;
  const would = { rhea: wouldPostWord(rheaCollateral, settings, holds) };

  // What the account could borrow now, as Home works it out: the engine's own figure once a check has given one.
  const debt = BigInt(answer?.debt ?? state?.loan.principal ?? '0');
  const poolLive = pool.data?.deployed ? pool.data : null;
  const rateBp = poolLive ? rateFor(poolLive.pool, answer?.borrower?.tier ?? state?.verdict?.verdict.tier) : null;
  const loan = loanView({ poolDebt: debt, poolRateBp: rateBp, lenders: lenderPositions(lenderData), pricing: lenderData?.pricing?.pricing });
  const stored = state?.verdict ?? null;
  const verdict = stored?.verdict ?? null;
  const height = answer ? answer.block_height + Math.floor((now - client.fetchedAt) / (SECONDS_PER_BLOCK * 1000)) : 0;
  const live = Boolean(stored && state && verdict && verdict.nonce === state.counter && freshness(verdict.blk, height).fresh && 'borrow' in stored.intent);
  const estimate = state && poolLive && answer ? borrowEstimate({ pool: poolLive.pool, params: poolLive.params, borrower: answer.borrower, verdict, live, debt: loan.total, nowNs: BigInt(now) * 1_000_000n }).amount : null;

  const reloadAll = () => {
    client.reload();
    hl.reload();
    lender.reload();
  };

  return {
    client,
    answer,
    state,
    accountId,
    testnet,
    now,
    config: config.data,
    hl: hlData,
    hlError: hl.error,
    lender: lenderData,
    helperOn: gasHelp.data?.on,
    options,
    usdc,
    /** The ids of the tokens Rhea takes from this account as collateral; null without Rhea, or while unread. */
    rheaCollateral,
    /** What each lender would take from the account, in a word, before it holds anything (lib/funding.ts). */
    would,
    /** The account's reads are in: a page that decides from them waits for this. */
    settled: Boolean(answer && (!state || ((hlData || hl.error) && own.settled))),
    loan,
    rateBp,
    estimate,
    /** The lender permission a new account is offered, signed with the opening (INTERFACES.md 24). */
    offered: defaultPermission(configuredLenders(config.data?.factory_config)),
    factoryLive: config.data ? config.data.deployed[config.data.ids.factory] : undefined,
    previewEnabled: config.data?.preview_enabled ?? false,
    /** The loan step waits: only on an account of before. One whose pause lifts early (INTERFACES.md 50.2) runs its check, which lifts it. */
    paused: state ? holdsLoan(state.hl, now) : false,
    error: client.error ?? config.error ?? markets.error,
    reloadAll,
    reloadHl: hl.reload,
    reloadLender: lender.reload,
  };
}

export type BasisData = ReturnType<typeof useBasisData>;
