'use client';
// Sending what the account signed for Aave's chain (stage 3; INTERFACES.md 33). A call such as lender_repay("aave")
// only has the account sign an Ethereum transaction: someone must then send it. The keeper does that for the plan
// steps it runs. For the client's own calls the page does: it finds the signed transaction's nonce, has the backend
// send it (POST /api/evm/submit), and follows it until the chain has mined it. The page signs nothing itself.
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiError, evmSubmit, lenderPath, type LenderAccountAnswer } from '@/lib/api';
import { evmSignedFromLogs, evmStatus, newSigned, statusWords } from '@/lib/evm';
import { txLogs, type Outcome } from '@/lib/tx';

/** How one signed transaction is going: looked for, being sent, sent, mined, failed on the chain, or never found. */
export interface EvmLine {
  key: number;
  what: string;
  phase: 'finding' | 'sending' | 'sent' | 'mined' | 'failed' | 'lost';
  hash?: string;
  why?: string;
}

/** Chain Signatures answer in 8 to 20 seconds; a slow signer still fits. */
const FIND_MS = 90_000;
/** Base Sepolia mines every 2 seconds; the backend's read of it is what the page waits on. */
const MINE_MS = 120_000;
const EVERY_MS = 2_500;
/** How long the backend may answer "no signed transaction with that nonce" before the page believes it. */
const NOT_YET_MS = 25_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function useEvmSend(accountId: string, onChange?: () => void) {
  const [lines, setLines] = useState<EvmLine[]>([]);
  const alive = useRef(true);
  const changed = useRef(onChange);
  const count = useRef(0);
  useEffect(() => {
    changed.current = onChange;
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * Sends the Ethereum transaction that `outcome`'s call had the account sign, and waits for it to be mined. `kind` is
   * what was signed (`repay`, `withdraw`, `transfer`, `approve`), and `fromNonce` the account's next Ethereum nonce
   * before the call. Returns whether the chain mined it without reverting.
   */
  const send = useCallback(
    async (outcome: Outcome, kind: string, what: string, fromNonce: number): Promise<boolean> => {
      const key = ++count.current;
      const put = (line: Omit<EvmLine, 'key' | 'what'>) => {
        if (alive.current) setLines((all) => [...all.filter((l) => l.key !== key), { key, what, ...line }]);
      };
      const read = () => api<LenderAccountAnswer>(lenderPath(accountId));

      // 1. Which transaction: the account's evm_signed event says, else the newest one of that kind it now lists.
      put({ phase: 'finding' });
      let nonce = evmSignedFromLogs(txLogs(outcome), kind)?.nonce ?? null;
      const findBy = Date.now() + FIND_MS;
      while (nonce === null && Date.now() < findBy && alive.current) {
        try {
          nonce = newSigned((await read()).evm, kind, fromNonce)?.nonce ?? null;
        } catch {
          // a missed read: try again
        }
        if (nonce === null) await sleep(EVERY_MS);
      }
      if (nonce === null) {
        put({ phase: 'lost', why: 'No signed transaction appeared. The signer may have timed out, and then nothing was signed: try again.' });
        return false;
      }

      // 2. The backend reads it from the account, checks it and sends it. A node that already knows it isn't an error.
      put({ phase: 'sending' });
      let hash: string;
      // The page learns the nonce from the call's own event a moment before the backend's read of NEAR shows the
      // signed transaction (the wallet and the backend may ask different NEAR nodes). So "no signed transaction with
      // that nonce" (404) is asked again for a short while before it counts as not sent. Seen on 13 Nov: the page
      // said "signed but wasn't sent" eight seconds before the transfer went out anyway.
      const askBy = Date.now() + NOT_YET_MS;
      for (;;) {
        try {
          const sent = await evmSubmit(accountId, nonce);
          hash = sent.hash;
          if (sent.status === 'mined') {
            // Mined already, and the backend says whether it failed there.
            put({ phase: sent.reverted ? 'failed' : 'mined', hash });
            changed.current?.();
            return !sent.reverted;
          }
          break;
        } catch (error) {
          if (error instanceof ApiError && error.status === 404 && Date.now() < askBy && alive.current) {
            await sleep(EVERY_MS);
            continue;
          }
          put({ phase: 'lost', why: `It is signed but wasn’t sent: ${error instanceof ApiError ? error.message : String(error)} The address card on Home can send it again.` });
          changed.current?.();
          return false;
        }
      }
      put({ phase: 'sent', hash });
      changed.current?.();

      // 3. Until the chain has mined it.
      const mineBy = Date.now() + MINE_MS;
      while (Date.now() < mineBy && alive.current) {
        await sleep(EVERY_MS);
        try {
          const entry = ((await read()).evm?.signed ?? []).find((e) => e.nonce === nonce && e.hash.toLowerCase() === hash.toLowerCase());
          const status = entry ? evmStatus(entry.status) : 'sent';
          if (status === 'mined' || status === 'failed') {
            put({ phase: status, hash });
            changed.current?.();
            return status === 'mined';
          }
          if (status === 'replaced') {
            put({ phase: 'lost', hash, why: statusWords(kind, status) });
            changed.current?.();
            return false;
          }
        } catch {
          // a missed read: try again
        }
      }
      put({ phase: 'sent', hash, why: 'Not mined within two minutes. The address card on Home shows it once it is.' });
      return false;
    },
    [accountId],
  );

  const busy = lines.some((l) => l.phase === 'finding' || l.phase === 'sending');
  return { lines, send, busy };
}
