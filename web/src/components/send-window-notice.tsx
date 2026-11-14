'use client';
// The pause banner: borrowing waits while a signed transfer out of Hyperliquid can still be posted
// (get_state().hl.send_open_until_ms; INTERFACES.md 8, "The send window"). lib/hl.ts has the rule and the words.
//   - An account as they are today (INTERFACES.md 50.1 point 5): the sentence of before, then "A new account can
//     borrow today." with the way to one: a new name is picked and Home opens on it, where the name can be changed.
//   - An account whose pause lifts early (INTERFACES.md 50.2; it shows `hl.open_sends`): the next check confirms the
//     transfer, so the banner offers "Check now", a plain check the broker pays for. When the pause is gone the
//     banner goes.
import { useRouter } from 'next/navigation';

import { CheckProgress } from '@/components/check-flow';
import { useCheckThenAct } from '@/hooks/use-check-then-act';
import { useNow } from '@/hooks/use-now';
import { NEW_ACCOUNT_WORDS, PAUSE_CHECK_WORDS, PAUSE_WAIT_WORDS, pauseBanner } from '@/lib/hl';
import { randomName } from '@/lib/names';
import type { HlState } from '@/lib/types';

interface Props {
  hl: HlState | null | undefined;
  /** The account the banner is about, and how the page reads it again: for "Check now". */
  accountId?: string | null;
  reload?: () => void;
  /** Sets the account name the wallet works on (the page's `client.setName`): for "Open a new account". */
  onNewName?: (name: string) => void;
}

export function SendWindowNotice({ hl, accountId, reload, onNewName }: Props) {
  const now = useNow(30_000);
  const router = useRouter();
  const flow = useCheckThenAct(accountId ?? '', reload);
  const banner = pauseBanner(hl, now);
  if (!banner) return null;

  if (banner.kind === 'check') {
    const running = flow.busy;
    return (
      <div className="alert alert-warning small">
        <div className="d-flex flex-wrap align-items-center gap-2">
          <span style={{ flex: '1 1 20rem', minWidth: 0 }}>{PAUSE_CHECK_WORDS}</span>
          {accountId && (
            <button type="button" className="btn btn-sm btn-primary" disabled={running} onClick={() => void flow.run({ intent: { check: {} } })}>
              {running ? 'Checking…' : 'Check now'}
            </button>
          )}
        </div>
        <CheckProgress state={flow.state} onConfirm={() => undefined} onReset={flow.reset} onWallet={() => flow.again('wallet')} />
        {/* A check that came back and left the pause on. */}
        {flow.state.phase === 'done' && flow.state.note && <div className="mt-2">{flow.state.note}</div>}
      </div>
    );
  }

  return (
    <div className="alert alert-warning small d-flex flex-wrap align-items-center gap-2">
      <span style={{ flex: '1 1 20rem', minWidth: 0 }}>
        <strong>Borrowing paused until {new Date(banner.untilMs).toLocaleString()}.</strong> {PAUSE_WAIT_WORDS} {NEW_ACCOUNT_WORDS}
      </span>
      {onNewName && (
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => {
            // A fresh name, remembered for this wallet: Home opens on it with the setup checklist, where it can be changed.
            onNewName(randomName());
            router.push('/');
          }}
        >
          Open a new account
        </button>
      )}
    </div>
  );
}
