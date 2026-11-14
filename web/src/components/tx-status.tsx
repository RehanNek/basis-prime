'use client';
// How the last transaction went: waiting for the wallet, done with a link to it, or failed in the contract's words,
// with its log lines (the account logs which verdict check failed there).
import { Dot, TxLink } from '@/components/flow-progress';
import type { TxRecord } from '@/hooks/use-tx';

export function TxStatus({ record, busy }: { record: TxRecord | null; busy?: boolean }) {
  if (busy) {
    return (
      <ul className="pb-flow mt-2 mb-0">
        <li>
          <Dot mark="busy" />
          <div className="what">Approve it in your wallet…</div>
        </li>
      </ul>
    );
  }
  if (!record) return null;
  const failed = Boolean(record.error || record.failure);
  return (
    <ul className="pb-flow mt-2 mb-0">
      <li>
        <Dot mark={failed ? 'failed' : 'done'} />
        <div>
          <div className="what">
            {record.label}:{' '}
            {record.error ? (
              <span className="text-danger">{record.error}</span>
            ) : record.failure ? (
              <span className="text-danger">failed: {record.failure}</span>
            ) : (
              'done'
            )}
            <TxLink hash={record.hash} />
          </div>
          {record.logs.length > 0 && (
            <details className="how">
              <summary>The contract’s log ({record.logs.length} lines)</summary>
              <pre className="small mb-0 text-wrap">{record.logs.join('\n')}</pre>
            </details>
          )}
        </div>
      </li>
    </ul>
  );
}
