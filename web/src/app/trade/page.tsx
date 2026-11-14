import type { Metadata } from 'next';

import { TradeView } from './trade-view';

export const metadata: Metadata = { title: 'Trade' };

export default function Page() {
  return <TradeView />;
}
