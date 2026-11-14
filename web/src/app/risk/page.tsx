import type { Metadata } from 'next';

import { RiskView } from './risk-view';

export const metadata: Metadata = { title: 'Risk' };

export default function Page() {
  return <RiskView />;
}
