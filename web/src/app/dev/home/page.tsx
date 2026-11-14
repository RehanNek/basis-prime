import { notFound } from 'next/navigation';

import { Preview } from './preview';
import { STATES, type PreviewState } from './states';

// Development only: /dev/home?state=new|setup|ready|loan|call shows the Home cockpit from sample data.
// state=lenders|lender-thin|lender-act adds a position at a lender, and state=funding|funding-pool shows a credit
// check's answer with "How this loan would be funded" (states.ts). Stage 2: state=fund|plan|plan-expired|sources|credit
// is an account that borrows from Rhea, state=permission|account-new shows the Account page, and
// state=book|book-operator the Book page.
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const params = await searchParams;
  const asked = params.state;
  const state = (STATES as readonly string[]).includes(String(asked)) ? (asked as PreviewState) : 'loan';
  // `&page=borrow` shows the same sample account on the Borrow page (INTERFACES.md 50.1 point 2), and `&page=deposit`
  // on "Deposit & withdraw" (point 3).
  const page = params.page === 'borrow' ? 'borrow' : params.page === 'deposit' ? 'deposit' : 'home';
  return <Preview key={`${state}:${page}`} state={state} page={page} />;
}
