// 1Click's statuses in words (PLAN.md 5.4: REFUNDED, FAILED and INCOMPLETE_DEPOSIT are shown, not hidden), for a
// move whose two ends the caller names.
import type { SwapStatus } from './api.ts';

export interface StatusWords {
  words: string;
  tone: 'secondary' | 'info' | 'success' | 'warning' | 'danger';
  done: boolean;
}

export function swapStatusWords(status: SwapStatus, ends: { to: string; refundTo: string }): StatusWords {
  switch (status) {
    case 'PENDING_DEPOSIT':
      return { words: 'Waiting for the deposit to reach the deposit address.', tone: 'secondary', done: false };
    case 'KNOWN_DEPOSIT_TX':
      return { words: 'The deposit is on its way.', tone: 'info', done: false };
    case 'PROCESSING':
      return { words: `The deposit arrived; it is being delivered to ${ends.to}.`, tone: 'info', done: false };
    case 'SUCCESS':
      return { words: `Delivered to ${ends.to}.`, tone: 'success', done: true };
    case 'INCOMPLETE_DEPOSIT':
      return { words: `Less than the quoted amount arrived before the deadline; what came goes back to ${ends.refundTo}.`, tone: 'warning', done: true };
    case 'REFUNDED':
      return { words: `Refunded to ${ends.refundTo}.`, tone: 'warning', done: true };
    case 'FAILED':
      return { words: 'Failed: nothing was delivered.', tone: 'danger', done: true };
    default:
      return { words: String(status), tone: 'secondary', done: false };
  }
}
