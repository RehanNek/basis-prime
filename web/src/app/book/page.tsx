import type { Metadata } from 'next';

import { BookView } from './book-view';

export const metadata: Metadata = { title: 'Book' };

export default function Page() {
  return <BookView />;
}
