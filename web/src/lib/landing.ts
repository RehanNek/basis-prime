// Home before a wallet connects (INTERFACES.md 50.1 point 1): the app's own frame, with a short row of live prices
// from the public GET /api/spot/tokens. Each price links to Spot and to that coin's market on Perps.
import { priceWords, shownSymbol, type SpotToken } from './spot.ts';

/** The coins the row shows, in this order, whatever the list's own order. */
export const HOME_COINS = ['BTC', 'ETH', 'NEAR'];

export interface HomeMarket {
  /** The coin's name on the screen: BTC, ETH, NEAR. */
  symbol: string;
  /** "$97,412.50", or "—" while the list hasn't answered or gave no price. */
  price: string;
  spotHref: string;
  perpsHref: string;
}

/**
 * The row's coins with their prices. A token the backend names by its NEAR name counts as its coin (nBTC is BTC, wNEAR
 * is NEAR). Every coin of the row is always there: one without a price shows a dash, never a gap.
 */
export function homeMarkets(tokens: SpotToken[], coins: string[] = HOME_COINS): HomeMarket[] {
  return coins.map((coin) => {
    const token = tokens.find((t) => shownSymbol(t.symbol).toUpperCase() === coin.toUpperCase());
    const price = token?.price_usd ?? null;
    return { symbol: coin, price: price === null ? '—' : priceWords(price), spotHref: '/spot', perpsHref: `/perps?coin=${encodeURIComponent(coin)}` };
  });
}
