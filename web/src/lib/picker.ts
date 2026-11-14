// The account picker's one line under the name field: whose account this is, in words (INTERFACES.md 48.6).
// With privacy on, another wallet's account shows nothing but that it is another wallet's: never the owner's id.
import type { PrivacyMode } from './session.ts';

export type PickerLine =
  | { kind: 'reading' }
  /** The name is free: the wallet can create it. */
  | { kind: 'new'; account: string }
  | { kind: 'not_client'; account: string }
  | { kind: 'yours'; account: string }
  /** Privacy on, and the backend refused (403 `not_yours`): nothing else about the account shows on the page. */
  | { kind: 'another_wallet' }
  /** Privacy on: the operator's or the keeper's wallet looking at a client's account. */
  | { kind: 'operator'; account: string }
  /** Privacy on: an account the backend lists as open for anyone to look at. */
  | { kind: 'open'; account: string }
  /** Privacy off, as before this section: another wallet's account, with its owner named. */
  | { kind: 'other'; account: string; owner: string };

export interface PickerInput {
  answer: { account_id: string; exists: boolean; state: { owner: string } | null } | null | undefined;
  /** The backend's error code for the account's read, if it refused. */
  errorCode?: string | null;
  /** The wallet that is connected. */
  owner: string;
  mode: PrivacyMode;
  /** The connected wallet is the operator's or the keeper's. */
  isOperator?: boolean;
  openAccounts?: string[];
}

export function pickerLine(input: PickerInput): PickerLine {
  const { answer, owner, mode } = input;
  if (input.errorCode === 'not_yours') return { kind: 'another_wallet' };
  if (!answer) return { kind: 'reading' };
  const account = answer.account_id;
  if (!answer.exists) return { kind: 'new', account };
  if (!answer.state) return { kind: 'not_client', account };
  if (answer.state.owner === owner) return { kind: 'yours', account };
  if (mode === 'off') return { kind: 'other', account, owner: answer.state.owner };
  if (input.isOperator) return { kind: 'operator', account };
  if ((input.openAccounts ?? []).includes(account)) return { kind: 'open', account };
  // The backend answered about another wallet's account, and the page can't say why: say only what is safe.
  return { kind: 'another_wallet' };
}

/** The line in plain words. The page links the account's id where it shows one. */
export function pickerWords(line: PickerLine): string {
  switch (line.kind) {
    case 'reading':
      return 'Reading the account…';
    case 'new':
      return `${line.account} doesn’t exist yet: create it below.`;
    case 'not_client':
      return `${line.account} exists, but isn’t a client account (it has no get_state view).`;
    case 'yours':
      return `${line.account}, owned by you.`;
    case 'another_wallet':
      return 'This name belongs to another wallet.';
    case 'operator':
      return `${line.account} belongs to another wallet. You are looking as the operator.`;
    case 'open':
      return `${line.account} belongs to another wallet. It is open for anyone to look at.`;
    default:
      return `${line.account} belongs to ${line.owner}, not you: you can look and ask for checks, but only the owner can borrow, repay or withdraw.`;
  }
}

/** "Your accounts", offered to choose from when the wallet has more than one (GET /api/accounts/mine). */
export function accountsToOffer(names: string[]): string[] {
  return names.length > 1 ? names : [];
}
