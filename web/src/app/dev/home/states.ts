// The sample states the development preview of Home can show.
// Phase 6 (INTERFACES.md 29) adds the lender cards with each cushion state (`lenders` also has the borrow panel's
// "Where it comes from"), and the credit check's "How this loan would be funded" with Aave used and with our pool alone.
// Stage 2 adds a loan through `fund` and its steps, one loan from two sources, a credit to claim, the permission on the
// Account page, and the Book page's pricing with and without the operator's wallet.
// Stage 3 adds Aave on Base Sepolia: test collateral for it, a loan whose steps are signed Ethereum transactions, one
// loan from three sources with the account's address there, and a credit check that counts the bitcoin's trip back.
export const STATES = [
  'new',
  'setup',
  'ready',
  'loan',
  'call',
  'paused',
  'paused-new',
  'lenders',
  'lender-thin',
  'lender-act',
  'funding',
  'funding-pool',
  'funding-noback',
  'aave',
  'aave-bitcoin',
  'aave-plan',
  'aave-eth',
  'three',
  'move-waiting',
  'move-way',
  'move-arrived',
  'move-refunded',
  'move-overdue',
  'fund',
  'plan',
  'plan-expired',
  'sources',
  'rhea-eth',
  'credit',
  'leave',
  'permission',
  'account-new',
  'book',
  'book-operator',
] as const;
export type PreviewState = (typeof STATES)[number];

/**
 * The pause after a transfer out of Hyperliquid (INTERFACES.md 50.1 point 5, 50.2), on the `ready` account:
 * - `paused`: an account as they are today. The banner says until when, and "A new account can borrow today."
 * - `paused-new`: an account whose pause lifts early (it shows `hl.open_sends`). The banner offers "Check now". The
 *   sample's first check doesn't find the transfer yet; its second does, and the banner goes.
 */
export const PAUSE_STATES = ['paused', 'paused-new'] as const;
export const isPauseState = (state: PreviewState): state is (typeof PAUSE_STATES)[number] => (PAUSE_STATES as readonly string[]).includes(state);

/** The states that show Home with a position at a lender. Their account is the `loan` state's. */
export const LENDER_STATES = ['lenders', 'lender-thin', 'lender-act'] as const;
export type LenderState = (typeof LENDER_STATES)[number];
export const isLenderState = (state: PreviewState): state is LenderState => (LENDER_STATES as readonly string[]).includes(state);

/**
 * The states that show a credit check's answer instead of Home. Stage 3: the move to Aave is counted there and back.
 * `funding`: over a year the saving covers both ways. `funding-pool`: over 90 days it doesn't. `funding-noback`: no
 * quote came for the way back, so it is counted as the way there.
 */
export const FUNDING_STATES = ['funding', 'funding-pool', 'funding-noback'] as const;
export type CreditState = (typeof FUNDING_STATES)[number];
export const isFundingState = (state: PreviewState): state is CreditState => (FUNDING_STATES as readonly string[]).includes(state);

/**
 * Stage 3's states of an account whose config has Aave and Rhea (INTERFACES.md 33):
 * - `aave`: hedged and ready, with nothing at its address on Base Sepolia. The checklist's "Get test collateral for
 *   Aave" offers test ether, because Aave's test pool for bitcoin is full. Then Borrow runs a plan whose Aave steps go
 *   from signed to sent to mined. `aave-bitcoin`: the same with room in Aave's pool, so the step offers test bitcoin.
 * - `aave-plan`: a loan on its way: the collateral is mined at Aave, the borrow is signed and not yet mined.
 * - `three`: one loan from our pool, Rhea and Aave. Repay pays the dearest of three; Aave's card repays it or takes
 *   collateral back; the address card sends a token out.
 */
export const AAVE_STATES = ['aave', 'aave-bitcoin', 'aave-plan', 'three'] as const;
export type AaveState = (typeof AAVE_STATES)[number];
export const isAaveState = (state: PreviewState): state is AaveState => (AAVE_STATES as readonly string[]).includes(state);

/**
 * Stage 4's states (INTERFACES.md 36): the `three` account with one move between NEAR and Aave's chain under way, at
 * each stage "Money on its way" can show. moves-standin.ts says what each one is.
 * - `move-waiting`: the loan on its way home, its transfer out of the address signed and not yet mined.
 * - `move-way`: bitcoin on its way to Aave's chain. It arrives a little later.
 * - `move-arrived`: bitcoin that has arrived there, still listed until a check sees it.
 * - `move-refunded`: collateral on its way home that 1Click sent back.
 * - `move-overdue`: USDC for Aave's chain that failed, past its deadline: "Drop this move".
 * The moves themselves start from `three` (bring the loan home, send USDC, bring the bitcoin home) and from `aave`
 * (move bitcoin to Aave's chain), with a stand-in that quotes and delivers.
 */
export const MOVE_STATES = ['move-waiting', 'move-way', 'move-arrived', 'move-refunded', 'move-overdue'] as const;
export type MoveState = (typeof MOVE_STATES)[number];
export const isMoveState = (state: PreviewState): state is MoveState => (MOVE_STATES as readonly string[]).includes(state);

/**
 * The Aave sample a state's account is built from: its own, or `three` for a state that shows a move under way.
 * `aave-eth` (INTERFACES.md 51.2) is the `aave` account made since 14 Nov: its settings list test ETH and it holds
 * some, so the address card offers "Move ETH to Aave's chain", with the cap said before an amount is typed.
 */
export const aaveSampleOf = (state: PreviewState): AaveState | null => (isAaveState(state) ? state : isMoveState(state) ? 'three' : state === 'aave-eth' ? 'aave' : null);

/**
 * Stage 2's states of an account that can borrow from Rhea:
 * - `fund`: hedged and ready. Borrow runs the check, `fund`, then the loan's steps, with a stand-in keeper.
 * - `plan`: a loan on its way, its second step running. `plan-expired`: one that ran out of time with steps left.
 * - `sources`: one loan from our pool and from Rhea. Repay pays the dearest first; the card takes collateral back.
 * - `credit`: a loan from Rhea alone, under a policy that caps Rhea's rate, with a credit the pool owes back.
 * - `leave`: leaving Rhea. A loan from Rhea alone, to pay off with "All of Rhea", and USDC sitting at Rhea to bring back.
 * - `permission`: the `sources` account on the Account page, where the permission is changed or cancelled.
 */
// `rhea-eth` (INTERFACES.md 51.1): the `sources` loan on an account made since 14 Nov, whose Rhea holds test ETH: the
// lender's card, the repay form and the take-back panel say "ether".
export const RHEA_STATES = ['fund', 'plan', 'plan-expired', 'sources', 'rhea-eth', 'credit', 'leave', 'permission'] as const;
export type RheaState = (typeof RHEA_STATES)[number];
export const isRheaState = (state: PreviewState): state is RheaState => (RHEA_STATES as readonly string[]).includes(state);

/** The states that show the Account page instead of Home: the permission card, and creating an account with it. */
export const isAccountState = (state: PreviewState): state is 'permission' | 'account-new' => state === 'permission' || state === 'account-new';

/** The states that show the Book page: its pricing for anyone, and with the operator's wallet signed in. */
export const isBookState = (state: PreviewState): state is 'book' | 'book-operator' => state === 'book' || state === 'book-operator';
