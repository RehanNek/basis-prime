// The sample states of /basis/dev (development only). Kept apart from preview.tsx, which is a client file: the page,
// which runs on the server, reads this list.
// `btc-out` (INTERFACES.md 50.4): a new wallet while Hyperliquid testnet's BTC price stands 2.6% under its reference
// price, so no BTC order can be taken: the coin is marked, one line says why, and the button is off.
export const PREVIEW_STATES = ['new', 'margin', 'loan', 'open', 'aave-home', 'aave-repaid', 'empty', 'btc-out'] as const;
export type PreviewState = (typeof PREVIEW_STATES)[number];
