import { notFound } from 'next/navigation';

import { BasisPreview } from './preview';
import { PREVIEW_STATES, type PreviewState } from './states';

// Development only: /basis/dev?state=new|margin|loan|open|aave-home|aave-repaid|empty|btc-out shows the Basis trade page from sample
// data. Its wallet approves at once and a stand-in plays the chain, so both runs can be walked from end to end;
// with &wallet=refuses the wallet turns every approval down, to see what a failure says. Nothing is signed or sent.
// A production build answers "This page could not be found".
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const asked = await searchParams;
  const state = (PREVIEW_STATES as readonly string[]).includes(String(asked.state)) ? (asked.state as PreviewState) : 'loan';
  const refuses = asked.wallet === 'refuses';
  return <BasisPreview key={`${state}-${refuses}`} state={state} refuses={refuses} />;
}
