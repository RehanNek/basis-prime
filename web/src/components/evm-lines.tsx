'use client';
// A signed Ethereum transaction on its way to Aave's chain (stage 3): one line per transaction, from signed to mined,
// with its link on the chain's explorer.
import { FlowLine } from '@/components/flow-progress';
import type { EvmLine } from '@/hooks/use-evm-send';
import { EVM_CHAIN_NAME, evmTxUrl } from '@/lib/evm';

/** A transaction's hash as a link to Base Sepolia's explorer. */
export function EvmTxLink({ hash, text = `on ${EVM_CHAIN_NAME}` }: { hash?: string | null; text?: string }) {
  if (!hash) return null;
  return (
    <a href={evmTxUrl(hash)} target="_blank" rel="noreferrer" className="ms-1">
      {text} <i className="bi bi-box-arrow-up-right" style={{ fontSize: '0.7rem' }} aria-hidden="true" />
    </a>
  );
}

const SAID: Record<EvmLine['phase'], string> = {
  finding: 'Signed by the account. Chain Signatures are finishing the signature: usually 8 to 20 seconds.',
  sending: `Sending it to ${EVM_CHAIN_NAME}…`,
  sent: `Sent to ${EVM_CHAIN_NAME}, not mined yet.`,
  mined: `Mined on ${EVM_CHAIN_NAME}.`,
  failed: `${EVM_CHAIN_NAME} mined it, but it failed there, so nothing moved.`,
  lost: '',
};

export function EvmLines({ lines }: { lines: EvmLine[] }) {
  if (lines.length === 0) return null;
  return (
    <ul className="pb-flow mt-2 mb-0" aria-live="polite">
      {[...lines]
        .sort((a, b) => a.key - b.key)
        .map((line) => (
          <FlowLine
            key={line.key}
            mark={line.phase === 'mined' ? 'done' : line.phase === 'failed' || line.phase === 'lost' ? 'failed' : 'busy'}
            what={line.what}
            how={
              <>
                {line.why ?? SAID[line.phase]}
                <EvmTxLink hash={line.hash} />
              </>
            }
          />
        ))}
    </ul>
  );
}
