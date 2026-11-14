import type { Metadata } from 'next';

import { PerpsView } from './perps-view';

export const metadata: Metadata = { title: 'Perps' };

export default function Page() {
  return <PerpsView />;
}
