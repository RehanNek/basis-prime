import type { Metadata } from 'next';

import { CreditCheckView } from './credit-check-view';

export const metadata: Metadata = { title: 'Credit check' };

export default function Page() {
  return <CreditCheckView />;
}
