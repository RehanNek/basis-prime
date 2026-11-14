import type { Metadata } from 'next';

import { SpotView } from '@/components/spot/spot-view';

export const metadata: Metadata = { title: 'Spot' };

export default function Page() {
  return <SpotView />;
}
