'use client';
// Picks the client account a page works on: <name>.<factory>, remembered per wallet in this browser.
// Privacy level 1 (INTERFACES.md 48.6): another wallet's account gets one line, "This name belongs to another wallet",
// and nothing else; the wallet's own accounts are offered to choose from when it has more than one.
import { accountUrl, FactoryContract } from '@/config';
import type { AccountAnswer } from '@/lib/api';
import { randomName } from '@/lib/names';
import { accountsToOffer, pickerLine, pickerWords } from '@/lib/picker';
import { useSession } from '@/providers/session-provider';

interface Props {
  name: string;
  problem: string | null;
  onName: (name: string) => void;
  answer: AccountAnswer | undefined;
  owner: string;
  /** The backend's code when it refused to show the account (`not_yours`). */
  errorCode?: string | null;
  /** The wallet's own accounts, newest first: offered to choose from when there is more than one. */
  mine?: string[];
  /** Still asking the backend which accounts are the wallet's. */
  finding?: boolean;
}

export function AccountPicker({ name, problem, onName, answer, owner, errorCode, mine, finding }: Props) {
  const session = useSession();
  const line = pickerLine({ answer, errorCode, owner, mode: session.mode, isOperator: session.isOperator, openAccounts: session.openAccounts });
  const offered = accountsToOffer(mine ?? []);
  return (
    <div className="mb-3">
      <label className="form-label small text-body-secondary" htmlFor="account-name">
        Client account
      </label>
      <div className="input-group" style={{ maxWidth: 520 }}>
        <input
          id="account-name"
          className={`form-control ${problem && name ? 'is-invalid' : ''}`}
          value={name}
          onChange={(event) => onName(event.target.value)}
          placeholder="name"
          autoComplete="off"
          spellCheck={false}
        />
        <span className="input-group-text">.{FactoryContract}</span>
      </div>
      <div className="form-text">{finding ? 'Looking for your accounts…' : problem ? problem : <Line line={line} />}</div>
      <div className="d-flex flex-wrap align-items-center gap-2 mt-2 small">
        {offered.length > 0 && <span className="text-body-secondary">Your accounts:</span>}
        {offered.map((own) => (
          <button key={own} type="button" className={`btn btn-sm ${own === name ? 'btn-secondary' : 'btn-outline-secondary'}`} onClick={() => onName(own)}>
            {own}
          </button>
        ))}
        {/* A wallet that has an account already gets a random name for its next one too (INTERFACES.md 48.6). */}
        <button type="button" className="btn btn-sm btn-outline-primary" title="Fills in a random name for a new account" onClick={() => onName(randomName())}>
          New account
        </button>
      </div>
    </div>
  );
}

/** The line's words, with the account's id as a link to the explorer where the line names it. */
function Line({ line }: { line: ReturnType<typeof pickerLine> }) {
  const words = pickerWords(line);
  if (!('account' in line) || line.kind === 'new') return <>{words}</>;
  const rest = words.slice(line.account.length);
  return (
    <>
      <a href={accountUrl(line.account)} target="_blank" rel="noreferrer">
        {line.account}
      </a>
      {line.kind === 'other' ? (
        <>
          {' '}
          belongs to <code>{line.owner}</code>, not you: you can look and ask for checks, but only the owner can borrow, repay or withdraw.
        </>
      ) : (
        rest
      )}
    </>
  );
}
