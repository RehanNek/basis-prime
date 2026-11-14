// INTERFACES.md 49.2 and 49.3: the Spot screen's backend.
//
//   GET  /api/spot/tokens?account=                 the tokens the screen lists, each with 1Click's real price (kept 60 s)
//   POST /api/quote {dry, swap: {from, to}, account, amount, slippageTolerance?}
//                                                  a price for swapping one token of the account for another, and
//                                                  with dry: false the account's next call
//
// NEAR Intents has no testnet. So the list and its prices come from 1Click's own host (GET /v0/tokens, a public read
// with no key: @pb/oneclick's `tokens()`), and a swap is carried by whatever `deps.oneClick` is: our stand-in on
// testnet. A token swaps here only when the account's own settings list a test token for it (49.2).
import type { QuoteRequest, TokenInfo } from "@pb/oneclick";

import { DEFAULT_SLIPPAGE_BP, DEPOSIT_MSG, oneClickCall, QUOTE_DEADLINE_MS, type Deps } from "./handlers.js";
import { expectOf, loanOpen, nextMoveId, transferMsg } from "./hl-handlers.js";
import { MAINNET_TOKENS, type SpotToken } from "./mainnet.js";
import { NotDeployedError } from "./rpc.js";
import { badRequest, HttpError, isPrimeAccount, isU128 } from "./validate.js";

/** How long the list is kept. 1Click's prices are for display; a swap's own price comes from its quote. */
export const SPOT_TTL_MS = 60_000;
/** "About 25 tokens" (49.1). */
export const MAX_SPOT_TOKENS = 25;

/**
 * The five tokens the engine prices and counts toward loans (risk/pb-read/src/near.rs, TOKEN_NAMES), by the name the
 * screen shows: nBTC shows as BTC and wNEAR as NEAR (49.2). The value is the pool's name, which is the `symbol` the
 * account's settings give the token.
 */
export const POOL_NAME: Record<string, SpotToken> = { USDC: "USDC", USDT: "USDT", BTC: "nBTC", ETH: "ETH", NEAR: "wNEAR" };

/**
 * Where 1Click's list names one of our perps coins differently (its list read 13 Nov): NEAR is `wNEAR` there, and
 * Hyperliquid's kPEPE is a thousand PEPE, which the list has as PEPE. The key is our coin, the value is the row.
 */
const LISTED_AS: Record<string, { symbol: string; oneClick: string }> = {
  NEAR: { symbol: "NEAR", oneClick: "wNEAR" },
  kPEPE: { symbol: "PEPE", oneClick: "PEPE" },
};

/** The coins' full names. 1Click's list gives none, so these are written here; a coin without one shows its symbol. */
const NAMES: Record<string, string> = {
  USDC: "USD Coin",
  USDT: "Tether",
  BTC: "Bitcoin",
  ETH: "Ethereum",
  ZEC: "Zcash",
  SOL: "Solana",
  NEAR: "NEAR",
  XRP: "XRP",
  PEPE: "Pepe",
  UNI: "Uniswap",
  BNB: "BNB",
  SUI: "Sui",
  AAVE: "Aave",
  DOGE: "Dogecoin",
  ARB: "Arbitrum",
  LINK: "Chainlink",
  AVAX: "Avalanche",
  ADA: "Cardano",
  TRX: "TRON",
  LTC: "Litecoin",
  HYPE: "Hyperliquid",
  ENA: "Ethena",
  PUMP: "Pump.fun",
  WLD: "Worldcoin",
  ONDO: "Ondo",
};

export interface SpotRow {
  /** The name on the screen: BTC, ETH, NEAR, USDC. */
  symbol: string;
  name: string;
  /** Dollars for one whole token, from 1Click's list; null when it gives none. */
  price_usd: number | null;
  /** 1Click's list has it. */
  on_intents: boolean;
  /** 1Click's own id for it on mainnet; null when its list doesn't have it. */
  intents_asset: string | null;
  /** The token's id on NEAR in the account's settings (the factory's, with no account); null when they list none. */
  token_id: string | null;
  decimals: number;
  /** A swap of it completes here: the settings list a token for it. */
  swaps_here: boolean;
  /** The engine counts it toward loans. */
  lendable: boolean;
}

interface SettingsToken {
  id: string;
  symbol: string;
  decimals: number;
}

/** The token list of an account's settings (`get_config().tokens`), or of the factory's when the account has none. */
async function settingsTokens(deps: Deps, account: string | null): Promise<{ tokens: SettingsToken[]; usdc: string | null }> {
  const read = async (contract: string) => {
    try {
      return (await deps.chain.view<{ tokens?: unknown; usdc_token?: unknown } | null>(contract, "get_config")).value;
    } catch (error) {
      if (error instanceof NotDeployedError) return null;
      throw error;
    }
  };
  const config = (account ? await read(account) : null) ?? (await read(deps.config.ids.factory));
  const listed = Array.isArray(config?.tokens) ? (config.tokens as unknown[]) : [];
  const tokens = listed.flatMap((t): SettingsToken[] => {
    const row = t as { id?: unknown; symbol?: unknown; decimals?: unknown } | null;
    return row && typeof row.id === "string" && typeof row.symbol === "string" && typeof row.decimals === "number" && Number.isInteger(row.decimals) ? [{ id: row.id, symbol: row.symbol, decimals: row.decimals }] : [];
  });
  // Nothing readable on the chain: the backend's own two, which every account has had since Phase 2.
  const known = tokens.length ? tokens : deps.config.ids.tokens.map((t) => ({ id: t.id, symbol: t.symbol, decimals: t.decimals }));
  const usdc = typeof config?.usdc_token === "string" ? config.usdc_token : (known.find((t) => t.symbol === "USDC")?.id ?? null);
  return { tokens: known, usdc };
}

/** 1Click's own list, kept a minute and shared by every account's answer. */
function oneClickList(deps: Deps): Promise<TokenInfo[]> {
  const source = deps.oneClickMainnet;
  if (!source) throw new HttpError(503, "spot_off", "Reading 1Click's token list is off here");
  return deps.hlCache.get("spot:1click", SPOT_TTL_MS, async () => {
    let list: unknown;
    try {
      list = await source.tokens();
    } catch {
      throw new HttpError(502, "oneclick_unreachable", "1Click's token list isn't answering right now");
    }
    if (!Array.isArray(list)) throw new HttpError(502, "oneclick_unreachable", "1Click's token list came back in a shape the backend doesn't know");
    return list.filter((t): t is TokenInfo => Boolean(t) && typeof t === "object" && typeof (t as TokenInfo).assetId === "string" && typeof (t as TokenInfo).symbol === "string");
  });
}

/**
 * GET /api/spot/tokens?account=: USDC and USDT, then our perps coins that 1Click's list has, the biggest market
 * first (by the market value our coin file gives each, `mcap_usd`; the file's own order where it gives none), at
 * most 25. With `account`, the ids are that account's own; the server has already checked that the asker may see it.
 */
export async function getSpotTokens(deps: Deps, query: URLSearchParams): Promise<{ tokens: SpotRow[]; read_at_ms: number }> {
  const asked = query.get("account");
  const account = asked === null || asked === "" ? null : asked;
  if (account !== null && !isPrimeAccount(account, deps.config.ids.factory)) throw badRequest(`account must be a client account, <name>.${deps.config.ids.factory}`);
  return deps.hlCache.get(`spot:tokens:${account ?? ""}`, SPOT_TTL_MS, async () => {
    const [list, settings, universe] = await Promise.all([oneClickList(deps), settingsTokens(deps, account), deps.universe()]);
    const row = (symbol: string, oneClickSymbol: string): SpotRow | null => {
      const pool = POOL_NAME[symbol];
      const candidates = list.filter((t) => t.symbol.toUpperCase() === oneClickSymbol.toUpperCase());
      // For the five the engine prices, 1Click's entry for the very token it reads on mainnet; else 1Click's first.
      const twin = pool ? candidates.find((t) => t.assetId === `nep141:${MAINNET_TOKENS[pool].id}`) : undefined;
      const listed = twin ?? candidates[0];
      const own = pool ? settings.tokens.find((t) => t.symbol === pool) : undefined;
      if (!listed && !own && !pool) return null;
      const price = listed && typeof listed.price === "number" && Number.isFinite(listed.price) && listed.price > 0 ? listed.price : null;
      return {
        symbol,
        name: NAMES[symbol] ?? symbol,
        price_usd: price,
        on_intents: Boolean(listed),
        intents_asset: listed?.assetId ?? null,
        token_id: own?.id ?? null,
        decimals: own?.decimals ?? listed?.decimals ?? (pool ? MAINNET_TOKENS[pool].decimals : 0),
        swaps_here: Boolean(own),
        lendable: Boolean(pool),
      };
    };
    const size = (coin: unknown) => {
      const value = (coin as { mcap_usd?: unknown }).mcap_usd;
      return typeof value === "number" && Number.isFinite(value) ? value : -1;
    };
    const coins = universe.coins
      .filter(([, coin]) => coin.allowed)
      .map(([name, coin], at) => ({ name, at, size: size(coin) }))
      .sort((a, b) => b.size - a.size || a.at - b.at);
    const rows: SpotRow[] = [row("USDC", "USDC")!, row("USDT", "USDT")!];
    for (const { name } of coins) {
      const as = LISTED_AS[name] ?? { symbol: name, oneClick: name };
      const made = row(as.symbol, as.oneClick);
      // A coin 1Click's list doesn't have is left out, unless the account holds a token for it.
      if (made && (made.on_intents || made.swaps_here) && !rows.some((r) => r.symbol === made.symbol)) rows.push(made);
    }
    return { tokens: rows.slice(0, MAX_SPOT_TOKENS), read_at_ms: deps.now() };
  });
}

/**
 * POST /api/quote {dry, swap: {from, to}, account, amount, slippageTolerance?}: a swap between two tokens of the
 * account's own settings, through `deps.oneClick`. `from` and `to` are token ids on NEAR; `amount` is in `from`'s
 * own units. The asset ids are the stand-in's for a NEAR test token, `nep141:<token id>`
 * (services/oneclick-shim/src/assets.ts), which is also how 1Click names a NEAR token.
 *
 * The answer is the quote, with `swap`:
 *   - `next` (with dry: false): the account's next call.
 *       Selling a token other than USDC: `withdraw` to the deposit address with `transfer: {"kind": "sell", "exp",
 *       "expect": {token, amount}}`. The account lists the sale as transfer `move:<n>`; the delivery carries that
 *       transfer's msg and settles it only as the token and amount the quote names (INTERFACES.md 47.3).
 *       Paying in USDC: a plain `withdraw` of USDC to the deposit address (the account refuses a `sell` of its
 *       USDC). The token bought arrives with the deposit msg, and the account books it as a deposit.
 *   - `delivers`: {token, symbol, amount}, what arrives.
 *   - `needs_check`: while the account owes our pool, the withdrawal to ask a check for first; else null.
 *   - `transfer_id`, `exp_ms`: the sale's record on the account, when there is one.
 */
export async function postSwapQuote(deps: Deps, fields: Record<string, unknown>) {
  const { factory } = deps.config.ids;
  const swap = fields.swap as { from?: unknown; to?: unknown } | null;
  if (!swap || typeof swap !== "object" || typeof swap.from !== "string" || typeof swap.to !== "string" || !swap.from || !swap.to || swap.from.length > 100 || swap.to.length > 100) {
    throw badRequest('swap must be {"from": <token id>, "to": <token id>}');
  }
  if (typeof fields.dry !== "boolean") throw badRequest("dry must be true (a price) or false (a deposit address)");
  const account = fields.account;
  if (!isPrimeAccount(account, factory)) throw badRequest(`account must be a client account, <name>.${factory}`);
  if (!isU128(fields.amount) || fields.amount === "0") throw badRequest("amount must be a positive whole number of the token's own units, as a string");
  const slippage = fields.slippageTolerance ?? DEFAULT_SLIPPAGE_BP;
  if (typeof slippage !== "number" || !Number.isInteger(slippage) || slippage < 1 || slippage > 500) {
    throw badRequest("slippageTolerance must be a whole number of basis points from 1 to 500");
  }
  const { from, to } = swap as { from: string; to: string };
  if (from === to) throw new HttpError(400, "same_asset", "Pick two different tokens");

  let state: { loan?: { principal?: string; open?: boolean } | null; next_move?: unknown } | null;
  try {
    state = (await deps.chain.view<typeof state>(account, "get_state")).value;
  } catch (error) {
    if (!(error instanceof NotDeployedError)) throw error;
    state = null;
  }
  if (!state) throw new HttpError(404, "not_deployed", `${account} has no account contract yet`);
  const settings = await settingsTokens(deps, account);
  const [sold, bought] = [settings.tokens.find((t) => t.id === from), settings.tokens.find((t) => t.id === to)];
  // 49.2: only the account's own tokens swap here. The page shows any other pair's real price and its mainnet line.
  for (const [id, found] of [[from, sold], [to, bought]] as const) {
    if (!found) throw new HttpError(400, "not_here", `${id} isn't one of this account's tokens, so it can't be swapped here. This pair trades on mainnet`);
  }
  const sellsUsdc = from === settings.usdc;
  // A sale is a pending transfer, named before the call (INTERFACES.md 14); a plain withdrawal of USDC isn't.
  const transferId = fields.dry || sellsUsdc ? null : nextMoveId(state);
  const request: QuoteRequest = {
    dry: fields.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: slippage,
    originAsset: `nep141:${from}`,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: `nep141:${to}`,
    amount: fields.amount,
    refundTo: account,
    refundType: "ORIGIN_CHAIN",
    recipient: account,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(deps.now() + QUOTE_DEADLINE_MS).toISOString(),
    // Delivered with ft_transfer_call: the sale's own msg settles its transfer, and the plain one books a deposit.
    customRecipientMsg: transferId ? transferMsg(transferId) : DEPOSIT_MSG,
  };
  const quote = await oneClickCall(deps, () => deps.oneClick.quote(request));
  const deadline = Date.parse(quote.quote.deadline ?? request.deadline);
  const expMs = transferId && Number.isFinite(deadline) ? deadline : undefined;
  const depositAddress = quote.quote.depositAddress;
  let next: { method: string; args: Record<string, unknown> } | null = null;
  if (!fields.dry && depositAddress) {
    const transfer = expMs !== undefined ? { transfer: { kind: "sell", exp: expMs, ...expectOf(to, quote.quote.amountOut) } } : {};
    next = { method: "withdraw", args: { token: from, amount: quote.quote.amountIn, receiver: depositAddress, ...transfer } };
  }
  // While the account owes our pool, taking a token out needs a verdict for exactly that (INTERFACES.md 4 and 33).
  const needsCheck = !loanOpen(state.loan ?? undefined) ? null : { withdraw: { token: from, amount: fields.amount } };
  if (next && transferId && depositAddress) {
    deps.moves?.remember(account, transferId, { depositAddress, ...(quote.quote.depositMemo ? { depositMemo: quote.quote.depositMemo } : {}) });
  }
  return {
    ...quote,
    swap: {
      from,
      to,
      account,
      next,
      transfer_id: transferId,
      exp_ms: expMs ?? null,
      delivers: { token: to, symbol: bought!.symbol, amount: quote.quote.amountOut },
      needs_check: needsCheck,
      swaps_here: true,
    },
  };
}
