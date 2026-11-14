// The network and our contract ids, from NEXT_PUBLIC_* values (see .env.example; next.config.js passes on
// those in the repo's .env). Each defaults to its testnet id in INTERFACES.md 1. Only public ids belong
// here: the keys stay in the backend. Testnet until the mainnet run, which needs a yes (PLAN.md 8, 12).
import type { Token } from '@/lib/types';

// Next inlines each process.env.NEXT_PUBLIC_* it finds written out in full, so every name is spelled out.
const pick = (value: string | undefined, fallback: string) => value?.trim() || fallback;

export const NetworkId: 'mainnet' | 'testnet' = process.env.NEXT_PUBLIC_NEAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';

/** Client accounts are <name>.<factory>. */
export const FactoryContract = pick(process.env.NEXT_PUBLIC_FACTORY_ACCOUNT_ID, 'pbf.testnet');
export const PoolContract = pick(process.env.NEXT_PUBLIC_POOL_ACCOUNT_ID, 'pool.pbf.testnet');

/** The tokens accounts hold, as in the factory's Config. On testnet they have a public faucet (PLAN.md 5.1). */
export const Tokens: Token[] = [
  { id: pick(process.env.NEXT_PUBLIC_MUSDC_TOKEN_ID, 'musdc.pbf-ops.testnet'), symbol: 'USDC', label: 'mUSDC', decimals: 6 },
  { id: pick(process.env.NEXT_PUBLIC_MNBTC_TOKEN_ID, 'mnbtc.pbf-ops.testnet'), symbol: 'nBTC', label: 'mNBTC', decimals: 8 },
];
/** The pool lends this one. */
export const UsdcToken = Tokens[0]!;

const explorers = { mainnet: 'https://nearblocks.io', testnet: 'https://testnet.nearblocks.io' };
export const NearExplorer = explorers[NetworkId];

export const txUrl = (hash: string) => `${NearExplorer}/txns/${hash}`;
export const accountUrl = (id: string) => `${NearExplorer}/address/${id}`;
