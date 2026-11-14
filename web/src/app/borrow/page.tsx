import type { Metadata } from 'next';

import { BorrowView } from './borrow-view';

export const metadata: Metadata = { title: 'Borrow' };

export default function Page() {
  return <BorrowView />;
}
