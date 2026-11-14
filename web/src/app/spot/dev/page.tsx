import { notFound } from 'next/navigation';

import { Preview } from './preview';
import { STATES, type SpotState } from './standin';

// Development only: /spot/dev?state=visitor|ready|loan|refund|new|quiet shows the Spot page from sample data, with a
// wallet that sends nothing and a stand-in for the backend's routes (standin.ts). A production build answers it with
// "This page could not be found", as it does /dev/home.
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const asked = (await searchParams).state;
  const state = (STATES as readonly string[]).includes(String(asked)) ? (asked as SpotState) : 'ready';
  return <Preview key={state} state={state} />;
}
