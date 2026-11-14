'use client';
// The Activity page (PLAN.md 5.8; INTERFACES.md 22): the account's history, newest first. Deposits, loans, repayments,
// moves to and from Hyperliquid, plan steps and withdrawals, each linked to its transaction on nearblocks, or for a
// step the gateway placed on Hyperliquid, to OutLayer's attestation. Like Risk, any account can be looked at without a
// wallet (?account=<name>); with one, it takes the wallet's account, and its owner can withdraw here too.
import { useState, type ReactNode } from 'react';

import { AccountPicker } from '@/components/account-picker';
import { ApiProblem, NotDeployed } from '@/components/notices';
import { AccountGate, VisitorNotice } from '@/components/sign-in-card';
import { Withdraw } from '@/components/withdraw-form';
import { accountUrl, FactoryContract, Tokens, txUrl } from '@/config';
import { useApi } from '@/hooks/use-api';
import { useClientAccount, type ClientAccount } from '@/hooks/use-client-account';
import { useDebounced } from '@/hooks/use-debounced';
import { accountPath, activityPath, CONFIG_PATH, type AccountAnswer, type ActivityAnswer, type ApiError, type ConfigAnswer } from '@/lib/api';
import { activityLines, MONEY_KINDS } from '@/lib/activity';
import { accountIdFor, nameProblem } from '@/lib/names';
import { visitorView } from '@/lib/session';
import { useNearWallet } from '@/providers/near-provider';
import { useSession } from '@/providers/session-provider';

export function ActivityView() {
  const { signedAccountId, loading } = useNearWallet();
  return (
    <main className="pb-container pb-page" style={{ maxWidth: 960 }}>
      <h1 className="h3">Activity</h1>
      <p className="lead">Everything that moved money in or out of the account, newest first, each with a link to check it.</p>
      {loading ? (
        <p className="text-body-secondary">Loading the wallet…</p>
      ) : signedAccountId ? (
        <AccountGate>
          <SignedIn />
        </AccountGate>
      ) : (
        <ByName />
      )}
    </main>
  );
}

/** With a wallet: the account the wallet works on, and the withdraw form for its owner. */
function SignedIn() {
  const client = useClientAccount(15_000);
  const config = useApi<ConfigAnswer>(CONFIG_PATH);
  return (
    <ActivityBody answer={client.answer} error={client.error} client={client} previewEnabled={config.data?.preview_enabled ?? false}>
      <AccountPicker name={client.name} problem={client.problem} onName={client.setName} answer={client.answer} owner={client.owner} errorCode={client.errorCode} mine={client.mine} finding={client.finding} />
    </ActivityBody>
  );
}

/**
 * Without a wallet. Privacy level 1 (INTERFACES.md 48.6): "Connect your wallet to see your account", and the accounts
 * anyone may look at as links; `?account=<an open account>` opens one, read only. With privacy off, the name field as
 * it was.
 */
function ByName() {
  const session = useSession();
  const [asked] = useState(() => new URLSearchParams(window.location.search).get('account'));
  if (session.checking) return <div className="pb-skeleton" style={{ height: 120 }} aria-busy="true" />;
  const view = visitorView({ mode: session.mode, openAccounts: session.openAccounts, asked, factory: FactoryContract });
  return view.kind === 'connect' ? <Visitor links={view.links} open={view.open} /> : <FreeText first={view.name} />;
}

/** A visitor with privacy on: the sentence, the open accounts, and the one that was opened, if any. */
function Visitor({ links, open }: { links: { account: string; name: string }[]; open: string | null }) {
  const read = useApi<AccountAnswer>(open ? accountPath(open) : null, 15_000);
  const answer = open && read.data?.account_id === open ? read.data : undefined;
  return (
    <ActivityBody answer={answer} error={read.error}>
      <VisitorNotice links={links} open={open} />
    </ActivityBody>
  );
}

/** Privacy off, as before: any client account, read only. */
function FreeText({ first }: { first: string }) {
  const [name, setName] = useState(first);
  const problem = name ? nameProblem(name, FactoryContract) : null;
  const path = useDebounced(name && !problem ? accountPath(accountIdFor(name, FactoryContract)) : null, 400);
  const read = useApi<AccountAnswer>(path, 15_000);
  const answer = name && !problem && read.data?.account_id === accountIdFor(name, FactoryContract) ? read.data : undefined;
  return (
    <ActivityBody answer={answer} error={read.error}>
      <div className="mb-3">
        <label className="form-label small text-body-secondary" htmlFor="activity-account">
          Client account (no wallet needed to look)
        </label>
        <div className="input-group" style={{ maxWidth: 520 }}>
          <input id="activity-account" className={`form-control ${problem ? 'is-invalid' : ''}`} value={name} onChange={(e) => setName(e.target.value.trim().toLowerCase())} placeholder="name" autoComplete="off" spellCheck={false} />
          <span className="input-group-text">.{FactoryContract}</span>
        </div>
        <div className="form-text">
          {problem ??
            (answer ? (
              <a href={accountUrl(answer.account_id)} target="_blank" rel="noreferrer">
                {answer.account_id}
              </a>
            ) : name ? (
              'Reading the account…'
            ) : (
              'Type the name of a client account.'
            ))}
        </div>
      </div>
    </ActivityBody>
  );
}

function ActivityBody(props: { answer: AccountAnswer | undefined; error: ApiError | undefined; client?: ClientAccount; previewEnabled?: boolean; children: ReactNode }) {
  const { answer, error, client, previewEnabled, children } = props;
  const accountId = answer?.exists ? answer.account_id : null;
  return (
    <>
      <ApiProblem error={error} />
      {children}
      {answer && <NotDeployed contracts={answer.not_deployed} />}
      {answer && !answer.exists && <div className="alert alert-secondary small">This account doesn&apos;t exist yet: create it on the Account page.</div>}
      {accountId && <History accountId={accountId} />}
      {client && answer?.state && client.isOwner && <Withdraw client={client} answer={answer} previewEnabled={previewEnabled ?? false} />}
    </>
  );
}

function History({ accountId }: { accountId: string }) {
  const read = useApi<ActivityAnswer>(activityPath(accountId), 30_000);
  const config = useApi<ConfigAnswer>(CONFIG_PATH);
  const [all, setAll] = useState(false);
  const data = read.data?.account === accountId ? read.data : undefined;
  const items = data?.items ?? [];
  const shown = all ? items : items.filter((i) => MONEY_KINDS.includes(i.kind));
  const hidden = items.length - shown.length;
  const lines = activityLines(shown, Tokens, txUrl, config.data?.ids.shim_float);
  return (
    <section className="card mb-3">
      <div className="card-header fw-semibold">History</div>
      <div className="card-body small">
        {read.error && <div className="alert alert-warning py-1 px-2">{read.error.message}</div>}
        {!data ? (
          !read.error && <p className="mb-0 text-body-secondary">Reading the account&apos;s transactions…</p>
        ) : (
          <>
            <p className="text-body-secondary mb-2">
              From FastNEAR&apos;s transaction index for testnet ({data.indexer.host}), read {new Date(data.read_at_ms).toLocaleTimeString()}
              {data.stale ? ', the last read that worked' : ''}: each line is what the contracts logged. Plan steps placed on Hyperliquid come from the
              keeper&apos;s log{data.keeper_log ? '' : ', which isn’t on this machine'}.
              {data.more ? ` Only the newest ${data.detailed} of ${data.total ?? data.listed} transactions are shown.` : ''}
            </p>
            {lines.length === 0 ? (
              <p className="mb-0">Nothing yet.</p>
            ) : (
              <ul className="list-unstyled mb-2">
                {lines.map((line, i) => (
                  <li key={`${line.at}-${i}`} className="mb-2 d-flex flex-wrap gap-1">
                    <span className="text-body-secondary text-nowrap">{new Date(line.at).toLocaleString()}</span>
                    <span className={line.ok ? '' : 'text-danger'}>{line.what}</span>
                    {line.links.map((l) => (
                      <span key={l.href}>
                        {'· '}
                        <a href={l.href} target="_blank" rel="noreferrer">
                          {l.text}
                        </a>
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            )}
            {(hidden > 0 || all) && (
              <button className="btn btn-sm btn-outline-secondary" onClick={() => setAll(!all)}>
                {all ? 'Show money moves only' : `Show the ${hidden} checks and setup steps too`}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
