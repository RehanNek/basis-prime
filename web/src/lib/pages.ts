// The web app's pages (PLAN.md 5.8), and the phase that builds each one (PLAN.md 11).
// The navigation, the home page and the placeholders all read this list.
// The app's second shape (INTERFACES.md 49.1): the tabs are Home, Deposit & withdraw, Spot, Perps, Borrow, Basis trade
// and More. The tabs read left to right as the order a new client goes in (the user, 14 Nov: "the tabs act as a
// guide. First home, then deposit then buy spot then trade perps then borrow"). Credit check, Book and the other
// pages of before sit under More; the old order form keeps its address and is linked from nowhere.

export interface AppPage {
  href: string;
  title: string;
  /** What the page will show, in a sentence or two. */
  summary: string;
  phase: string;
  /** Does it need a signed-in wallet? */
  wallet: boolean;
  /** Shown on testnet only. */
  testnetOnly?: boolean;
  /** Where the navigation shows it: one of the tabs, or in the More menu (9 Nov redesign). */
  /** `none`: the page keeps its address and isn't linked from the tabs or the More menu. */
  place: 'tab' | 'more' | 'none';
  /** Its name in the navigation, in plain words. */
  label: string;
  /** One plain line under the name in the More menu. */
  blurb: string;
  /** A Bootstrap icon class. */
  icon: string;
}

export const PAGES: AppPage[] = [
  {
    href: '/spot',
    title: 'Spot',
    summary: 'Swap one token for another: what you pay, what you receive, the price as you type, and one Swap button.',
    phase: 'Second shape',
    wallet: true,
    place: 'tab',
    label: 'Spot',
    blurb: 'Swap one token for another at the live price',
    icon: 'bi-arrow-left-right',
  },
  {
    href: '/perps',
    title: 'Perps',
    summary: 'A perps market: its figures, a price chart, the order book and recent trades, the order form, and your positions and open orders.',
    phase: 'Second shape',
    wallet: true,
    place: 'tab',
    label: 'Perps',
    blurb: 'Trade perps on Hyperliquid, checked by the risk engine',
    icon: 'bi-graph-up',
  },
  {
    href: '/basis',
    title: 'Basis trade',
    summary: 'Pick a token, and the page leads through holding it, shorting the same amount and borrowing against both. Close everything in one guided run.',
    phase: 'Second shape',
    wallet: true,
    place: 'tab',
    label: 'Basis trade',
    blurb: 'Hold a token, short it, and borrow against both',
    icon: 'bi-layers',
  },
  {
    href: '/credit-check',
    title: 'Credit check',
    summary:
      'Paste any Hyperliquid address, or try the worked example, and add spot tokens if you like: what our pool would lend ' +
      'against the whole hedged book next to what Rhea would lend against the spot alone, the rate each charges, and why. ' +
      'Read from mainnet in an OutLayer enclave, with the attestation to check it. No wallet.',
    phase: 'Phase 5',
    wallet: false,
    place: 'more',
    label: 'Credit check',
    blurb: 'What any Hyperliquid book could borrow. No wallet needed',
    icon: 'bi-calculator',
  },
  {
    href: '/book',
    title: 'Book',
    summary:
      "The broker's pool: capital, loans out, utilisation, the rate per tier, interest earned, write-offs, the last 24 hours' " +
      'new lending against its 10% budget, exposure per bridged token and on Hyperliquid, and whether it is paused. ' +
      'Funding from lenders: the source order, what each client pays, the fees earned, the subsidies paid and what is lent through each lender. ' +
      'The daily stress test of the whole book, with its attestation. The operator sets KYB flags, co-signs, pauses, sets coin statuses and sets pricing here.',
    phase: 'Phase 2',
    wallet: false,
    place: 'more',
    label: 'Book',
    blurb: 'The broker\'s pool, its rates and its daily stress test',
    icon: 'bi-bank',
  },
  {
    href: '/account',
    title: 'Account',
    summary:
      'Create your client account, then see its balances, its loan, its latest verdict in plain words and its counter; ' +
      'ask for a check, and withdraw. Change or cancel its lender permission. Set up its Hyperliquid address and the gateway’s agent, and move USDC to and from Hyperliquid.',
    phase: 'Phase 2',
    wallet: true,
    place: 'more',
    label: 'Account details',
    blurb: 'Every detail of your account and its Hyperliquid setup',
    icon: 'bi-person-badge',
  },
  {
    href: '/deposit',
    // INTERFACES.md 50.1 point 3: depositing and withdrawing are one page, each one click away at its top.
    // A tab of its own, right after Home, since 14 Nov (INTERFACES.md 51.7): it was the first item under More.
    title: 'Deposit & withdraw',
    summary:
      'Depositing: test tokens from the faucet, then a deposit from your wallet. ' +
      'Withdrawing: a token out to a NEAR wallet, with its check first while a loan is open.',
    phase: 'Phase 2',
    wallet: true,
    place: 'tab',
    label: 'Deposit & withdraw',
    blurb: 'Put tokens into your account, or take them out to a wallet',
    icon: 'bi-arrow-down-up',
  },
  {
    href: '/trade',
    title: 'Trade',
    summary:
      "Hyperliquid orders through the gateway for the 23 allow-listed coins, with each coin's price band shown; open orders with " +
      'a cancel, positions and recent fills. Swaps through 1Click come later.',
    phase: 'Phase 3',
    wallet: true,
    // The user, 13 Nov: "remove trade classic from more - i dont want it". Perps is the order page now.
    place: 'none',
    label: 'Trade (classic)',
    blurb: 'The order form of before, kept until Perps is proven',
    icon: 'bi-graph-up-arrow',
  },
  {
    href: '/borrow',
    title: 'Borrow',
    summary:
      'What you can borrow now and its rate, an amount, where it would come from, and one Borrow button; below it what you ' +
      'owe, with Repay and Repay everything. Then what Rhea alone would lend, and the carry.',
    phase: 'Phase 2',
    wallet: true,
    place: 'tab',
    label: 'Borrow',
    blurb: 'Borrow and repay on one page',
    icon: 'bi-cash-coin',
  },
  {
    href: '/risk',
    title: 'Risk',
    summary:
      'The buffer and the initial requirement, the top three risks in words, the bands next to today\'s prices, the margin-call ' +
      'clock, the stored plan with each step\'s status, money in transit, and the history of verdicts and of the keeper\'s ' +
      'actions, with transaction and attestation links. Read only: any account can be looked at without a wallet.',
    phase: 'Phase 4',
    wallet: false,
    place: 'more',
    label: 'Risk',
    blurb: 'Health, margin calls and the unwind plan, for any account',
    icon: 'bi-shield-check',
  },
  {
    href: '/activity',
    title: 'Activity',
    summary:
      'Every deposit, loan, repayment, move to and from Hyperliquid, plan step and withdrawal, newest first, each linked to its ' +
      'transaction or attestation. Any account can be looked at without a wallet; its owner can withdraw here too.',
    phase: 'Phase 5',
    wallet: false,
    place: 'more',
    label: 'Activity',
    blurb: 'Everything that moved money, with links to check it',
    icon: 'bi-clock-history',
  },
  {
    href: '/drill',
    title: 'Drill',
    summary:
      'Testnet only: the nBTC/BTC ratio that plays a bridge depeg (one account at a time, once the drill has per-account ' +
      'ratios), the 1Click stand-in\'s fault switch (a refund, a failure or a late delivery), and the commands that run the ' +
      'slide, the keeper and the gate.',
    phase: 'Phase 4',
    wallet: false,
    testnetOnly: true,
    place: 'more',
    label: 'Drill',
    blurb: 'Play a depeg or a 1Click fault and watch the safety net',
    icon: 'bi-sliders',
  },
];

/** The pages to show on a network: the drill panel only on testnet. */
export function navPages(network: 'mainnet' | 'testnet'): AppPage[] {
  return PAGES.filter((page) => network === 'testnet' || !page.testnetOnly);
}

/** INTERFACES.md 49.1 and 51.7: the tabs after Home, in the user's order. */
const TAB_ORDER = ['/deposit', '/spot', '/perps', '/borrow', '/basis'];

/** The tabs after Home, in order: Deposit & withdraw, Spot, Perps, Borrow, Basis trade. */
export function tabPages(network: 'mainnet' | 'testnet'): AppPage[] {
  return navPages(network)
    .filter((page) => page.place === 'tab')
    .sort((a, b) => TAB_ORDER.indexOf(a.href) - TAB_ORDER.indexOf(b.href));
}

/** The More menu: the pages of before but the old order form, in the order people reach for them, with Credit check and Book. */
export function morePages(network: 'mainnet' | 'testnet'): AppPage[] {
  const order = ['/activity', '/risk', '/account', '/credit-check', '/book', '/drill'];
  return navPages(network)
    .filter((page) => page.place === 'more')
    .sort((a, b) => order.indexOf(a.href) - order.indexOf(b.href));
}

export function pageAt(href: string): AppPage {
  const page = PAGES.find((p) => p.href === href);
  if (!page) throw new Error(`No page at ${href}`);
  return page;
}
