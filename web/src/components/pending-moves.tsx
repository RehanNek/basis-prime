'use client';
// Money on its way (INTERFACES.md 14 and 36): the transfers through 1Click that the account lists as under way, each
// in a client's words, with where it stands and what to do about it. Where it stands comes from two places: 1Click's
// own status for the move (our stand-in on testnet), and the account's deadline for it.
//   - A move to Aave's chain that has arrived stays listed until a check sees the tokens there: the row offers one.
//   - A transfer past its deadline holds back borrowing, and withdrawing with a loan. The owner drops it with
//     forget_transfer.
import { CheckFlow } from '@/components/check-flow';
import { Dot } from '@/components/flow-progress';
import { TxStatus } from '@/components/tx-status';
import { Tokens } from '@/config';
import { useApi } from '@/hooks/use-api';
import type { ClientAccount } from '@/hooks/use-client-account';
import { useTx } from '@/hooks/use-tx';
import { statusPath, type AccountAnswer, type EvmToken, type StatusAnswer } from '@/lib/api';
import { listedWords, moveStage, recallMove, STAGE_LABEL, STAGE_TONE, statusQuery, transferWords, type KnownToken, type MoveStage, type StartedMove } from '@/lib/moves';
import { isOverdue, pendingTransfers, type PendingTransfer } from '@/lib/risk';
import { forgetTransferTx } from '@/lib/tx';

/** The tokens the page can name: the account's on NEAR by id, and those at its address on Aave's chain by 0x address. */
export function knownTokens(wallet: EvmToken[] | undefined, balances?: { token: string; symbol: string; decimals: number }[]): KnownToken[] {
  // The account's own tokens on NEAR come first where the page has them: one made since 14 Nov may hold test ETH.
  const own = (balances ?? []).filter((b) => !Tokens.some((t) => t.id === b.token)).map((b) => ({ id: b.token, symbol: b.symbol, decimals: b.decimals }));
  return [...Tokens.map((t) => ({ id: t.id, symbol: t.symbol, decimals: t.decimals })), ...own, ...(wallet ?? []).map((t) => ({ id: t.token, symbol: t.symbol, decimals: t.decimals }))];
}

/** What this browser remembers of a move it started: the memo 1Click tells it apart by. */
function remembered(account: string, id: string): StartedMove | null {
  try {
    return typeof window === 'undefined' ? null : recallMove(window.localStorage, account, id);
  } catch {
    return null;
  }
}

const FINAL: string[] = ['SUCCESS', 'REFUNDED', 'INCOMPLETE_DEPOSIT', 'FAILED'];

/** 1Click's status for one move, asked every 5 seconds until it is final. A null query asks nothing. */
export function useMoveStatus(query: { depositAddress: string; depositMemo: string | null } | null) {
  return useApi<StatusAnswer>(query ? statusPath(query.depositAddress, query.depositMemo) : null, 5_000, (s) => FINAL.includes(s.status));
}

const dot = (stage: MoveStage | null) => (stage === 'arrived' ? 'done' : stage === 'failed' || stage === 'overdue' ? 'failed' : stage === 'refunded' ? 'todo' : 'busy');

/** A stage as a pill, or "Under way" when all the page knows is that the account lists the transfer. */
export function StagePill({ stage }: { stage: MoveStage | null }) {
  return <span className={`pb-pill ms-2 ${stage ? STAGE_TONE[stage] : 'neutral'}`}>{stage ? STAGE_LABEL[stage] : 'Under way'}</span>;
}

/** Where one listed transfer stands, in words (lib/moves.ts, listedWords), with its deadline as a time of day. */
export function stageLine(transfer: PendingTransfer, stage: MoveStage | null, asked: boolean, error: string | undefined): string {
  return listedWords(transfer.kind, stage, { asked, error, until: transfer.deadlineMs ? new Date(transfer.deadlineMs).toLocaleTimeString() : null });
}

function Row({ transfer, client, answer, tokens, now, previewEnabled }: { transfer: PendingTransfer; client: ClientAccount; answer: AccountAnswer; tokens: KnownToken[]; now: number; previewEnabled: boolean }) {
  const query = statusQuery(transfer, remembered(answer.account_id, transfer.id));
  const status = useMoveStatus(query);
  const tx = useTx();
  const overdue = isOverdue(transfer, now);
  const stage = moveStage(status.data?.status ?? null, overdue);
  const reason = status.data?.swapDetails?.refundReason;
  return (
    <li>
      <Dot mark={dot(stage)} />
      <div>
        <div className="what">
          {transferWords(transfer, tokens)}
          <StagePill stage={stage} />
        </div>
        <div className="how">
          {stageLine(transfer, stage, query !== null, status.error?.message)}
          {reason && ` 1Click’s reason: ${reason}.`}
        </div>
        {/* The account can't see Aave's chain: a check tells it the tokens are there, and the move stops being listed. */}
        {transfer.kind === 'to_evm' && (stage === 'arrived' || stage === 'overdue') && (
          <div className="mt-2">
            <CheckFlow account={answer} fetchedAt={client.fetchedAt} reload={client.reload} intent={{ check: {} }} checkLabel="Check now" previewEnabled={previewEnabled} isOwner={client.isOwner} primary={false} />
          </div>
        )}
        {overdue && (
          <div className="mt-2">
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              disabled={!client.isOwner || tx.busy}
              onClick={async () => {
                await tx.run(`Drop ${transfer.id}`, forgetTransferTx(answer.account_id, transfer.id));
                client.reload();
              }}
            >
              Drop this move
            </button>
            <span className="form-text ms-2">
              {client.isOwner ? 'It takes the move off the list, so borrowing can go on. It moves no money.' : 'Only the account’s owner can drop it.'}
            </span>
            <TxStatus record={tx.last} busy={tx.busy} />
          </div>
        )}
      </div>
    </li>
  );
}

/** Home's card: every transfer the account lists as under way. It shows nothing when there is none. */
export function PendingMoves({ client, answer, wallet, now, previewEnabled }: { client: ClientAccount; answer: AccountAnswer; wallet: EvmToken[] | undefined; now: number; previewEnabled: boolean }) {
  const transfers = pendingTransfers(answer.state?.pending);
  if (transfers.length === 0) return null;
  const tokens = knownTokens(wallet, answer.balances);
  return (
    <section className="pb-card mb-4" aria-labelledby="moves-title">
      <h2 id="moves-title" className="pb-card-title">
        Money on its way
      </h2>
      <div className="small pb-muted mb-2">
        Moves through 1Click that haven’t settled yet. On testnet our own stand-in plays 1Click, and where each move stands is what the stand-in says. While one is listed
        it counts for less than money that has arrived, and once it is past its deadline, borrowing waits.
      </div>
      <ul className="pb-flow mt-0 mb-0">
        {transfers.map((transfer) => (
          <Row key={transfer.id} transfer={transfer} client={client} answer={answer} tokens={tokens} now={now} previewEnabled={previewEnabled} />
        ))}
      </ul>
    </section>
  );
}

/** One cell of the Risk page's table: the same stage, by 1Click's status and the deadline. No wallet is needed to look. */
export function TransferStage({ accountId, transfer, now }: { accountId: string; transfer: PendingTransfer; now: number }) {
  const query = statusQuery(transfer, remembered(accountId, transfer.id));
  const status = useMoveStatus(query);
  const stage = moveStage(status.data?.status ?? null, isOverdue(transfer, now));
  return (
    <>
      <span className={`badge text-bg-${stage === 'arrived' ? 'success' : stage === 'overdue' || stage === 'failed' ? 'danger' : stage === 'refunded' ? 'warning' : 'secondary'}`}>
        {stage ? STAGE_LABEL[stage] : 'Under way'}
      </span>{' '}
      {stageLine(transfer, stage, query !== null, status.error?.message)}
    </>
  );
}
