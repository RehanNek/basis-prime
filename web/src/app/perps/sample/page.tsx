import { notFound } from 'next/navigation';

import { SampleView } from './sample-view';
import { STATES, type SampleState } from './states';

// Development only, like /dev/home: /perps/sample?state=live|thin|empty|down|expired|slow|far shows the Perps page from sample
// data, with no backend and no wallet. Its buttons play an order's wait and result; nothing is signed or sent.
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const asked = (await searchParams).state;
  const state = (STATES as readonly string[]).includes(String(asked)) ? (asked as SampleState) : 'live';
  return <SampleView key={state} state={state} />;
}
