import type { Metadata } from 'next';

import { DepositView } from './deposit-view';

export const metadata: Metadata = { title: 'Deposit & withdraw' };

export default function Page() {
  return <DepositView />;
}
