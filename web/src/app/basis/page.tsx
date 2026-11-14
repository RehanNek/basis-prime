import type { Metadata } from 'next';

import { BasisView } from '@/components/basis/basis-view';

export const metadata: Metadata = { title: 'Basis trade' };

export default function Page() {
  return <BasisView />;
}
