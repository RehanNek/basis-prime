'use client';
// The account page's Hyperliquid card (INTERFACES.md 12): set up the account's Hyperliquid address, get the
// gateway's agent and approve it through Chain Signatures; then its equity, positions and margin ratio.
//   1. hl_init: the MPC signer derives the address (anyone can ask).
//   2. A first deposit of at least $10: Hyperliquid opens the address then, and keeps 1 USDC for it.
//   3. request_agent (0.01 NEAR): pb-gateway names this account's agent, on-chain.
//   4. hl_approve_agent: the MPC signer signs ApproveAgent; the backend posts it; Hyperliquid's extraAgents lists it.
import Link from 'next/link';
import type { ReactNode } from 'react';

import { TxStatus } from '@/components/tx-status';
import { useSignAndPost, type SignPhase } from '@/hooks/use-sign-and-post';
import { useTx } from '@/hooks/use-tx';
import type { ApiError } from '@/lib/api';
import { agentApproved, hlFunded, hlSummary, lastSignedIndex, setupStep, submitWords, type HlAnswer } from '@/lib/hl';
import { hlApproveAgentTx, hlInitTx, requestAgentTx } from '@/lib/tx';
import { formatDollars as usd } from '@/lib/units';

interface Props {
  accountId: string;
  isOwner: boolean;
  hl: HlAnswer | undefined;
  error: ApiError | undefined;
  reload: () => void;
  /** Re-reads with ?fresh=1, so a new approval shows at once. */
  reloadFresh: () => void;
}

export function HyperliquidCard({ accountId, isOwner, hl, error, reload, reloadFresh }: Props) {
  const init = useTx();
  const agent = useTx();
  const approve = useSignAndPost(accountId);

  if (!hl) {
    return (
      <section className="card mb-3">
        <div className="card-header fw-semibold">Hyperliquid</div>
        <div className="card-body small">{error ? <div className="text-warning-emphasis">{error.message}</div> : 'Reading the account’s Hyperliquid side…'}</div>
      </section>
    );
  }

  const step = setupStep(hl);
  const view = hl.hyperliquid;
  const summary = view ? hlSummary(view) : null;
  const approval = agentApproved(hl);
  const canTrade = hl.gateway !== null;
  const ownerOnly = isOwner ? null : <span className="text-body-secondary"> Only the owner can do this.</span>;

  return (
    <section className="card mb-3">
      <div className="card-header d-flex align-items-center gap-2">
        <span className="fw-semibold">Hyperliquid</span>
        <span className={`badge text-bg-${step === 'ready' ? 'success' : 'secondary'}`}>{step === 'ready' ? 'ready to trade' : 'setting up'}</span>
      </div>
      <div className="card-body small">
        <p>
          The account owns a Hyperliquid address through Chain Signatures: no person holds its key. Only the gateway&apos;s agent
          trades on it, and every order passes the risk checks first.
        </p>
        {error && <div className="alert alert-warning py-1 px-2">{error.message}</div>}
        {!canTrade && (
          <div className="alert alert-secondary py-1 px-2">
            This account was made before Phase 3: its config names no gateway, so it can&apos;t get an agent or trade. Create a new
            account to try the hedge.
          </div>
        )}

        <ol className="list-unstyled mb-3">
          <Step n={1} done={hl.address !== null} title="Set up the address">
            {hl.address ? (
              <>
                <code>{hl.address}</code>, path <code>{hl.hl?.path}</code>
              </>
            ) : (
              <>
                The account asks the MPC signer for its address on path <code>hyperliquid-1</code>. Anyone can ask.{' '}
                <button
                  className="btn btn-sm btn-outline-primary ms-1"
                  disabled={!canTrade || init.busy}
                  onClick={async () => {
                    await init.run('Set up Hyperliquid (hl_init)', hlInitTx(accountId));
                    reload();
                  }}
                >
                  Set up
                </button>
                <TxStatus record={init.last} busy={init.busy} />
              </>
            )}
          </Step>

          <Step n={2} done={hlFunded(view)} title="First deposit">
            {hlFunded(view)
              ? 'Hyperliquid has opened the address.'
              : 'Hyperliquid opens the address on its first deposit of at least $10, and keeps 1 USDC for it. Move USDC there below.'}
          </Step>

          <Step n={3} done={Boolean(hl.hl?.agent)} title="Get the gateway's agent">
            {hl.hl?.agent ? (
              <>
                Agent <code>{hl.hl.agent.address}</code>, named by pb-gateway at block {hl.hl.agent.received_block.toLocaleString()}.
              </>
            ) : (
              <>
                The account asks pb-gateway, inside OutLayer, which agent key belongs to it. Costs 0.01 NEAR, paid to OutLayer, which
                refunds the unused part.{' '}
                <button
                  className="btn btn-sm btn-outline-primary ms-1"
                  disabled={!hl.address || !canTrade || !isOwner || agent.busy}
                  onClick={async () => {
                    await agent.run("Get the gateway's agent (request_agent)", requestAgentTx(accountId));
                    reload();
                  }}
                >
                  Get the agent (0.01 NEAR)
                </button>
                {ownerOnly}
                <TxStatus record={agent.last} busy={agent.busy} />
              </>
            )}
          </Step>

          <Step n={4} done={approval.approved === true} title="Approve the agent on Hyperliquid">
            {approval.approved ? (
              <>
                Hyperliquid lists the agent{approval.validUntil ? `, valid until ${new Date(approval.validUntil).toLocaleDateString()}` : ''}. It can trade, but can&apos;t
                withdraw or send.
              </>
            ) : (
              <>
                The MPC signer signs Hyperliquid&apos;s ApproveAgent for the account, then the backend posts it.{' '}
                <button
                  className="btn btn-sm btn-outline-primary ms-1"
                  disabled={!hl.hl?.agent || !hlFunded(view) || !isOwner || approve.tx.busy || approve.phase.kind === 'waiting' || approve.phase.kind === 'posting'}
                  onClick={async () => {
                    await approve.run('Approve the agent (hl_approve_agent)', hlApproveAgentTx(accountId), 'approveAgent', lastSignedIndex(hl.hl));
                    reloadFresh();
                  }}
                >
                  Approve
                </button>
                {ownerOnly}
                <TxStatus record={approve.tx.last} busy={approve.tx.busy} />
                <PhaseLine phase={approve.phase} />
              </>
            )}
          </Step>
        </ol>

        {summary && (
          <>
            <h2 className="h6">On Hyperliquid now</h2>
            <dl className="row mb-2">
              <Fact label="Equity (what its margin works from)" value={usd(summary.equity)} />
              <Fact label="Margin ratio (liquidation at 100%)" value={summary.marginRatioBp === null ? '?' : `${(summary.marginRatioBp / 100).toFixed(2)}%`} />
              <Fact label="USDC in perps / in spot" value={`${usd(summary.perps)} / ${usd(summary.spotUsdc)}`} />
              <Fact label="Account mode (userAbstraction)" value={summary.mode ?? '?'} />
              <Fact label="Maintenance margin used" value={usd(summary.maintenance)} />
              <Fact label="Open orders" value={String(view?.open_orders?.length ?? '?')} />
            </dl>
            {summary.note && <p className="text-warning-emphasis">{summary.note}</p>}
            {summary.positions.length > 0 ? (
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>Position</th>
                    <th className="text-end">Size</th>
                    <th className="text-end">Entry</th>
                    <th className="text-end">Value</th>
                    <th className="text-end">PnL</th>
                    <th className="text-end">Liquidation</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.positions.map((p) => (
                    <tr key={p.coin}>
                      <td>
                        {p.coin} {p.side} <span className="text-body-secondary">({p.leverage})</span>
                      </td>
                      <td className="text-end font-monospace">{p.size}</td>
                      <td className="text-end font-monospace">{p.entryPx}</td>
                      <td className="text-end font-monospace">{usd(p.value)}</td>
                      <td className={`text-end font-monospace ${p.pnl < 0 ? 'text-danger' : ''}`}>{usd(p.pnl)}</td>
                      <td className="text-end font-monospace">{p.liquidationPx ?? 'none'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-body-secondary">No positions.</p>
            )}
            {Object.keys(view?.errors ?? {}).length > 0 && (
              <p className="text-warning-emphasis">Hyperliquid didn&apos;t answer: {Object.keys(view!.errors).join(', ')}. The page tries again shortly.</p>
            )}
            {step === 'ready' && (
              <p className="mb-2">
                <Link href="/perps">Trade on the Perps page</Link>: every order goes through the gateway&apos;s checks.
              </p>
            )}
          </>
        )}

        {(hl.hl?.signed?.length ?? 0) > 0 && <SignedActions accountId={accountId} hl={hl} onPosted={reloadFresh} />}
      </div>
    </section>
  );
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: ReactNode }) {
  return (
    <li className="mb-2 d-flex gap-2">
      <span className={`badge rounded-pill align-self-start text-bg-${done ? 'success' : 'light'} border`}>{done ? '✓' : n}</span>
      <div>
        <div className="fw-semibold">{title}</div>
        <div>{children}</div>
      </div>
    </li>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="col-sm-6 d-flex gap-2">
      <dt className="fw-normal text-body-secondary">{label}</dt>
      <dd className="mb-1 font-monospace">{value}</dd>
    </div>
  );
}

/** Where a signed action stands: waiting for the signature, posting, or Hyperliquid's answer. */
export function PhaseLine({ phase }: { phase: SignPhase }) {
  if (phase.kind === 'idle') return null;
  if (phase.kind === 'waiting') return <p className="mt-1 mb-0">Waiting for the MPC signer: usually 8 to 20 seconds.</p>;
  if (phase.kind === 'posting') return <p className="mt-1 mb-0">Posting signed action {phase.index} to Hyperliquid…</p>;
  if (phase.kind === 'failed') return <p className="mt-1 mb-0 text-danger">{phase.message}</p>;
  return <p className={`mt-1 mb-0 ${phase.answer.ok ? 'text-success' : 'text-danger'}`}>{submitWords(phase.answer)}</p>;
}

/** Every signed action the account keeps (the last 20), each of which can be posted again. */
function SignedActions({ accountId, hl, onPosted }: { accountId: string; hl: HlAnswer; onPosted: () => void }) {
  const poster = useSignAndPost(accountId);
  const entries = [...(hl.hl?.signed ?? [])].sort((a, b) => b.index - a.index);
  return (
    <details className="mt-2">
      <summary>Signed actions ({entries.length})</summary>
      <p className="mt-2 mb-1 text-body-secondary">
        The backend reads each one from the chain and posts it. Posting again is harmless: Hyperliquid refuses a nonce it has seen.
      </p>
      <table className="table table-sm mb-1">
        <tbody>
          {entries.map((e) => (
            <tr key={e.index}>
              <td>#{e.index}</td>
              <td>{e.kind}</td>
              <td className="font-monospace">nonce {e.nonce}</td>
              <td>block {e.signed_block.toLocaleString()}</td>
              <td className="text-end">
                <button
                  className="btn btn-sm btn-outline-secondary py-0"
                  disabled={poster.phase.kind === 'posting'}
                  onClick={async () => {
                    await poster.post(e.index);
                    onPosted();
                  }}
                >
                  Post to Hyperliquid
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <PhaseLine phase={poster.phase} />
    </details>
  );
}
