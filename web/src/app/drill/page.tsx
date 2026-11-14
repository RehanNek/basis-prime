import type { Metadata } from 'next';

import { DrillView } from './drill-view';

export const metadata: Metadata = { title: 'Drill' };

export default function Page() {
  return <DrillView />;
}
