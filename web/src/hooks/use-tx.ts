'use client';
// Sends one transaction through the wallet and remembers how it went, for <TxStatus>.
import { useCallback, useState } from 'react';

import { txFailure, txHash, txLogs, type Outcome, type Tx } from '@/lib/tx';
import { useNearWallet } from '@/providers/near-provider';

export interface TxRecord {
  label: string;
  hash?: string;
  /** The wallet refused or the transaction never ran. */
  error?: string;
  /** It ran, but the contract (or one of its calls) failed. */
  failure?: string | null;
  logs: string[];
}

export function useTx() {
  const { sendTx } = useNearWallet();
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<TxRecord | null>(null);

  /** Returns the outcome when the transaction ran without a failure, else null. */
  const run = useCallback(
    async (label: string, tx: Tx): Promise<Outcome | null> => {
      setBusy(true);
      setLast(null);
      try {
        const outcome = await sendTx(tx);
        const failure = txFailure(outcome);
        setLast({ label, hash: txHash(outcome), failure, logs: txLogs(outcome) });
        return failure ? null : outcome;
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        setLast({ label, error: /reject|cancel/i.test(text) ? 'Cancelled in the wallet' : text, logs: [] });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [sendTx],
  );

  return { run, busy, last };
}
