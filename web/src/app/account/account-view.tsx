'use client';
// The account page (PLAN.md 5.8): create a client account through the factory, then see where its funds are,
// its loan, its latest verdict and its counter; ask for a check; withdraw. Phase 3 adds the Hyperliquid card
// (set up, agent, approval, equity and positions) and moving USDC to and from Hyperliquid (INTERFACES.md 12).
// Phase 6, stage 2 (INTERFACES.md 25 and 29): creating the account can sign the funding permission in the same
// approval, and the permission card changes or cancels it.
import { useCallback, useState } from 'react';

import { AccountPicker } from '@/components/account-picker';
import { CheckFlow } from '@/components/check-flow';
import { HyperliquidCard } from '@/components/hyperliquid-card';
import { MoveUsdc } from '@/components/move-usdc';
import { ApiProblem, NotDeployed, WalletGate } from '@/components/notices';
import { OpeningPermission, PermissionCard } from '@/components/permission';
import { SendWindowNotice } from '@/components/send-window-notice';
import { TxStatus } from '@/components/tx-status';
import { VerdictCard } from '@/components/verdict-card';
import { Withdraw } from '@/components/withdraw-form';
import { FactoryContract, Tokens } from '@/config';
import { useApi } from '@/hooks/use-api';
import { useOwnSettings } from '@/hooks/use-own-settings';
import { useClientAccount, type ClientAccount } from '@/hooks/use-client-account';
import { useLenderAccount } from '@/hooks/use-lender-account';
import { useNow } from '@/hooks/use-now';
import { useTx } from '@/hooks/use-tx';
import { api, CONFIG_PATH, hlPath, type AccountAnswer, type ConfigAnswer } from '@/lib/api';
import { planRunning } from '@/lib/fund';
import { hlSummary, type HlAnswer } from '@/lib/hl';
import { settingsPostedWord, wouldPostWord } from '@/lib/funding';
import { configuredLenders, defaultPermission } from '@/lib/permission';
import { createAccountTx } from '@/lib/tx';
import type { Permission } from '@/lib/types';
import { displayUnits, formatDollars } from '@/lib/units';
import { SECONDS_PER_BLOCK } from '@/lib/verdict';

export function AccountView() {
  return (
    <main className="pb-container pb-page" style={{ maxWidth: 960 }}>
      <h1 className="h3">Account</h1>
      <p className="lead">
        One contract account per client holds its collateral and its loan. Create it, then see where the funds are and what
        the risk engine last said.
      </p>
      <WalletGate>
        <AccountBody />
      </WalletGate>
    </main>
  );
}

function AccountBody() {
  const client = useClientAccount();
  const config = useApi<ConfigAnswer>(CONFIG_PATH);
  const { answer } = client;
  const accountId = answer?.state ? answer.account_id : null;
  // INTERFACES.md 51.1: what Rhea takes from this account, by its own settings, for the permission's notes.
  const own = useOwnSettings(accountId);
  const hl = useApi<HlAnswer>(accountId ? hlPath(accountId) : null, 10_000);
  const { reload: reloadHl } = hl;
  // After an approval, read the agents at once rather than waiting out the backend's few-second cache.
  const reloadHlFresh = useCallback(() => {
    if (!accountId) return;
    void api<HlAnswer>(hlPath(accountId, true))
      .catch(() => undefined)
      .finally(reloadHl);
  }, [accountId, reloadHl]);
  const hlData = hl.data?.account_id === accountId ? hl.data : undefined;
  // Phase 6: the lenders the account's own config names, for its permission card.
  const lender = useLenderAccount(accountId);
  const now = useNow(30_000);

  return (
    <>
      <ApiProblem error={config.error ?? client.error} />
      <AccountPicker name={client.name} problem={client.problem} onName={client.setName} answer={answer} owner={client.owner} errorCode={client.errorCode} mine={client.mine} finding={client.finding} />
      {answer && <NotDeployed contracts={answer.not_deployed} />}
      {answer && !answer.exists && client.accountId && (
        <CreateAccount
          client={client}
          accountId={client.accountId}
          factoryLive={config.data?.deployed[FactoryContract]}
          offered={defaultPermission(configuredLenders(config.data?.factory_config))}
          posted={settingsPostedWord(config.data?.factory_config)}
        />
      )}
      {answer?.state && (
        <>
          <Overview client={client} answer={answer} hl={hlData} />
          {/* Accounts made before Phase 6 have no permission in their state at all: for them there is no card. */}
          {answer.state.permission !== undefined && (
            <PermissionCard
              posted={wouldPostWord(own.rheaCollateral, own.tokens ?? [], () => false)}
              accountId={answer.account_id}
              isOwner={client.isOwner}
              permission={answer.state.permission}
              available={lender.data?.config_lenders ?? answer.state.permission?.lenders ?? []}
              planRunning={planRunning(answer.state.funding, now)}
              onChanged={() => {
                client.reload();
                lender.reload();
              }}
            />
          )}
          <SendWindowNotice hl={answer.state.hl} accountId={answer.account_id} reload={client.reload} onNewName={client.setName} />
          <HyperliquidCard accountId={answer.account_id} isOwner={client.isOwner} hl={hlData} error={hl.error} reload={reloadHl} reloadFresh={reloadHlFresh} />
          <MoveUsdc client={client} answer={answer} hl={hlData} reloadHl={reloadHl} previewEnabled={config.data?.preview_enabled ?? false} />
          <section className="card mb-3">
            <div className="card-header fw-semibold">Ask for a check</div>
            <div className="card-body">
              <p className="small">
                Anyone can ask, and the verdict lands in the account. It costs 0.01 NEAR, paid to OutLayer, which refunds the
                unused part. A plain check backs no action; borrowing and withdrawing with a loan need their own check.
              </p>
              <CheckFlow
                account={answer}
                fetchedAt={client.fetchedAt}
                reload={client.reload}
                intent={{ check: {} }}
                checkLabel="Ask for a check"
                previewEnabled={config.data?.preview_enabled ?? false}
                isOwner={client.isOwner}
              />
            </div>
          </section>
          <Withdraw client={client} answer={answer} previewEnabled={config.data?.preview_enabled ?? false} />
        </>
      )}
    </>
  );
}

function CreateAccount({ client, accountId, factoryLive, offered, posted }: { client: ClientAccount; accountId: string; factoryLive: boolean | undefined; offered: Permission | null; posted?: string }) {
  const tx = useTx();
  // The permission on offer is signed with the account unless the client unticks it.
  const [withPermission, setWithPermission] = useState(true);
  const create = async () => {
    await tx.run(`Create ${accountId}`, createAccountTx(FactoryContract, client.name, client.owner, withPermission ? offered : null));
    client.reload();
  };
  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">Create {accountId}</div>
      <div className="card-body small">
        <p>
          In one transaction the factory creates the account, deploys the account contract with you as its owner, registers it
          on each token and registers it with the pool. You attach 6 NEAR: about 4.7 NEAR stays as the account&apos;s storage,
          and if any step fails the factory refunds you.
        </p>
        <OpeningPermission offered={offered} on={withPermission} onToggle={setWithPermission} posted={posted} />
        <NotDeployed contracts={factoryLive === false ? [FactoryContract] : []} what="Accounts can be created once the factory is live." />
        <button className="btn btn-primary" disabled={!factoryLive || tx.busy} onClick={create}>
          Create account (6 NEAR)
        </button>
        <TxStatus record={tx.last} busy={tx.busy} />
        {tx.last?.hash && !tx.last.failure && <p className="mt-2 mb-0">Waiting for the account to appear; this page reads it every few seconds.</p>}
      </div>
    </section>
  );
}

function Overview({ client, answer, hl }: { client: ClientAccount; answer: AccountAnswer; hl: HlAnswer | undefined }) {
  const now = useNow(1000);
  const onHl = hl?.hyperliquid ? hlSummary(hl.hyperliquid) : null;
  const state = answer.state!;
  const height = answer.block_height + Math.floor((now - client.fetchedAt) / (SECONDS_PER_BLOCK * 1000));
  const borrower = answer.borrower;
  const poolLive = answer.debt !== null; // debt_of answers once the pool is live

  return (
    <>
      <section className="card mb-3">
        <div className="card-header fw-semibold">Where the funds are</div>
        <div className="card-body small">
          <div className="row g-4">
            <div className="col-md-6">
              <h2 className="h6">In the account</h2>
              <table className="table table-sm mb-0">
                <tbody>
                  {answer.balances.map((b) => {
                    const token = Tokens.find((t) => t.id === b.token);
                    return (
                      <tr key={b.token}>
                        <td>{token?.label ?? b.symbol}</td>
                        <td className="text-end font-monospace">{b.amount === null ? 'not deployed' : displayUnits(b.amount, b.decimals, b.decimals)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <h2 className="h6 mt-3">On Hyperliquid</h2>
              <p className="mb-0">
                {!hl
                  ? 'Reading…'
                  : !hl.address
                    ? 'No Hyperliquid address yet: set it up in the Hyperliquid card.'
                    : onHl?.equity !== null && onHl?.equity !== undefined
                      ? `${formatDollars(onHl.equity)} of equity, ${onHl.positions.length} position(s).`
                      : 'Hyperliquid did not answer just now.'}
              </p>
            </div>
            <div className="col-md-6">
              <h2 className="h6">The loan</h2>
              <dl className="mb-2">
                <dt className="fw-normal text-body-secondary">Owed to the pool, with interest (pool.debt_of)</dt>
                <dd className="font-monospace">{answer.debt === null ? 'the pool is not deployed yet' : `${displayUnits(answer.debt, 6, 6)} USDC`}</dd>
                <dt className="fw-normal text-body-secondary">Borrowed less repaid (the account&apos;s record)</dt>
                <dd className="font-monospace">{displayUnits(state.loan.principal, 6, 6)} USDC</dd>
              </dl>
              <h2 className="h6">Status</h2>
              <ul className="list-unstyled mb-0">
                <li>Counter: {state.counter} (each verdict must carry it; each borrow or withdrawal moves it on)</li>
                <li>
                  With the pool:{' '}
                  {borrower
                    ? `registered, tier ${borrower.tier.toLowerCase()}${borrower.blocked ? ', blocked' : ''}`
                    : poolLive
                      ? 'not registered'
                      : 'the pool is not deployed yet'}
                </li>
                {state.blocked && <li className="text-danger">Blocked after a default</li>}
              </ul>
            </div>
          </div>
        </div>
      </section>
      {state.verdict ? (
        <VerdictCard verdict={state.verdict.verdict} intent={state.verdict.intent} title="Latest check" stored={{ counter: state.counter, height, permissionBlk: state.permission_blk }} />
      ) : (
        <p className="small text-body-secondary">No check yet: ask for one below.</p>
      )}
    </>
  );
}
