// Phase 6, stage 2 (INTERFACES.md 26 and 28; FUNDING.md 5 and 8): what the operator has set clients to pay, what the
// pool has charged and paid for it, and what is lent through each lender. Read only: the operator signs set_pricing
// and set_funding with the wallet, in the app.
//
//   GET /api/pricing
//   {"read_at_ms", "funding", "limits", "pool": {"fees_charged", "fees_reversed", "subsidy_paid", "subsidy_left_24h"},
//    "tiers": [{"tier", "pricing"}],
//    "accounts": [{"account", "pricing", "from", "fees_charged", "fees_reversed", "subsidy_paid", "credit",
//                  "settled_at", "last": [LenderReport], "lender_debt": [{"lender", "debt"}]}]}
//
// Money is micro-USD in strings, as the pool writes it. Where it comes from:
//   funding, limits, tiers   the pool's get_params(): `funding`, `pricing_limits`, and `tier_pricing` (an object keyed
//                            by tier name, holding only the tiers that have a policy)
//   pool                     the pool's get_pool(): `fees_charged`, `fees_reversed`, `subsidy_paid`, `subsidy_left_24h`
//   accounts                 the pool's get_pricing(account_id), for each account the factory lists
//
// The pool's change of 12 Nov (INTERFACES.md 45.1). `limits` is the pool's `pricing_limits` as it writes it, so the
// three new limits on a settlement's fee come through by themselves: `max_lender_debt`, `account_fee_day` (both
// micro-USD in strings) and `pool_fee_day_bp`. `fees_reversed` is what the operator took back with `reverse_fee`,
// for the pool and for each account; a pool from before that change has no such total, and it reads "0".
//
// Which accounts: every one that has a lender loan, a policy of its own, or any fee, subsidy or credit on record. A
// lender loan shows in two places, and either is enough: the pool's last settlement report for the account (`last`),
// and the account's held verdict (`ext`). The second matters for a fresh loan: the pool learns of a lender's debt at
// the next settlement, so until then `last` still says 0. `lender_debt` is the verdict's figure, per lender, for
// that reason; `last` is the pool's own record, untouched.
//
// A pool from before stage 2 has none of this: `funding`, `limits` and `pool` are null and the lists are empty.
import type { Deps } from "./handlers.js";
import { soft } from "./handlers.js";
import { LENDER_NAMES, readExt } from "./lenders.js";

/** The answer is kept this long: one request reads two views for every account the factory lists. */
export const PRICING_CACHE_MS = 15_000;
/** At most this many accounts are read (the factory's first), a few at a time, so the free RPC isn't flooded. */
export const PRICING_MAX_ACCOUNTS = 200;
const AT_ONCE = 6;
const PAGE = 100;
/** The pool's tiers, in the order the app lists them. */
const TIERS = ["PREFERRED", "STANDARD", "WATCH"];

/** One line of a settlement report (contracts/types `LenderReport`). */
export interface LenderReport {
  lender: string;
  debt: string;
  rate_bp: number;
  supply_bp: number;
}

/** The pool's `get_pricing(account_id)` (INTERFACES.md 26). */
interface PricingView {
  pricing?: unknown;
  from?: unknown;
  fees_charged?: unknown;
  /** INTERFACES.md 45.1: the fees the operator took back with `reverse_fee`. */
  fees_reversed?: unknown;
  subsidy_paid?: unknown;
  credit?: unknown;
  settled_at?: unknown;
  last?: unknown;
}

export interface PricingAccount {
  account: string;
  pricing: unknown;
  from: string;
  fees_charged: string;
  /** Of those fees, what the operator took back (the pool's `reverse_fee`); "0" on a pool from before it. */
  fees_reversed: string;
  subsidy_paid: string;
  credit: string;
  settled_at: string;
  last: LenderReport[];
  /** What the account owes each lender by its held verdict, in micro-USD: ahead of `last` for a fresh loan. */
  lender_debt: { lender: string; debt: string }[];
}

export interface PricingAnswer {
  read_at_ms: number;
  funding: unknown;
  limits: unknown;
  pool: { fees_charged: string; fees_reversed: string; subsidy_paid: string; subsidy_left_24h: string } | null;
  tiers: { tier: string; pricing: unknown }[];
  accounts: PricingAccount[];
}

const money = (value: unknown): string => (typeof value === "string" && /^\d+$/.test(value) ? value : "0");
const positive = (value: string) => value !== "0" && BigInt(value) > 0n;

/** A settlement report as the pool stores it; lines that aren't one are dropped. */
function reports(value: unknown): LenderReport[] {
  if (!Array.isArray(value)) return [];
  return (value as (Record<string, unknown> | null)[])
    .filter((r): r is Record<string, unknown> => typeof r?.lender === "string")
    .map((r) => ({ lender: r.lender as string, debt: money(r.debt), rate_bp: typeof r.rate_bp === "number" ? r.rate_bp : 0, supply_bp: typeof r.supply_bp === "number" ? r.supply_bp : 0 }));
}

/** `get_params().tier_pricing` as a list: the tiers that have a policy, the pool's three first, in their order. */
export function tierList(tierPricing: unknown): { tier: string; pricing: unknown }[] {
  if (!tierPricing || typeof tierPricing !== "object" || Array.isArray(tierPricing)) return [];
  const set = Object.entries(tierPricing as Record<string, unknown>).filter(([, pricing]) => pricing !== null && pricing !== undefined);
  const order = (tier: string) => (TIERS.includes(tier) ? TIERS.indexOf(tier) : TIERS.length);
  return set.sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b)).map(([tier, pricing]) => ({ tier, pricing }));
}

/** One account's line, or null when it has nothing to show: no lender loan, no policy of its own, nothing on record. */
export function pricingAccount(account: string, view: PricingView | null | undefined, ext: unknown): PricingAccount | null {
  if (!view || typeof view !== "object") return null;
  const line: PricingAccount = {
    account,
    pricing: view.pricing ?? "pass_through",
    from: typeof view.from === "string" ? view.from : "default",
    fees_charged: money(view.fees_charged),
    fees_reversed: money(view.fees_reversed),
    subsidy_paid: money(view.subsidy_paid),
    credit: money(view.credit),
    settled_at: money(view.settled_at),
    last: reports(view.last),
    lender_debt: readExt(ext)
      .filter((e) => e.d > 0)
      .map((e) => ({ lender: e.l, debt: String(Math.trunc(e.d)) })),
  };
  const lent = line.lender_debt.length > 0 || line.last.some((r) => (LENDER_NAMES as readonly string[]).includes(r.lender) && positive(r.debt));
  const onRecord = positive(line.fees_charged) || positive(line.subsidy_paid) || positive(line.credit);
  return lent || line.from === "account" || onRecord ? line : null;
}

/** One line of the factory's `list_accounts` (INTERFACES.md 3): the account, when it was made (ns), and its owner's wallet. */
export interface FactoryAccount {
  account_id: string;
  created_at: string;
  owner: string;
}

/** The factory's accounts with their owners, oldest first, a page at a time, up to the cap. A factory that isn't there has none. */
export async function listFactoryAccounts(deps: Deps): Promise<FactoryAccount[]> {
  const all: FactoryAccount[] = [];
  const text = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
  for (let from = 0; from < PRICING_MAX_ACCOUNTS; from += PAGE) {
    const page = await soft(deps.chain.view<({ account_id?: unknown; created_at?: unknown; owner?: unknown } | null)[] | null>(deps.config.ids.factory, "list_accounts", { from_index: from, limit: PAGE }));
    const entries = Array.isArray(page?.value) ? page.value : [];
    for (const e of entries) if (typeof e?.account_id === "string") all.push({ account_id: e.account_id, created_at: text(e.created_at), owner: text(e.owner) });
    if (entries.length < PAGE) break;
  }
  return all.slice(0, PRICING_MAX_ACCOUNTS);
}

/** The factory's accounts, a page at a time, up to the cap. A factory that isn't there has none. */
async function listAccounts(deps: Deps): Promise<string[]> {
  return (await listFactoryAccounts(deps)).map((a) => a.account_id);
}

/**
 * GET /api/accounts/mine (INTERFACES.md 48.5): the client accounts a signed-in wallet owns, newest first, from the
 * factory's own list. With random account names this is how a wallet finds its account again in another browser.
 */
export async function getMyAccounts(deps: Deps, wallet: string) {
  const mine = (await listFactoryAccounts(deps)).filter((a) => a.owner === wallet);
  return { wallet, accounts: mine.reverse().map((a) => ({ account_id: a.account_id, created_at: a.created_at })), read_at_ms: deps.now() };
}

async function readPricing(deps: Deps, now: number, withAccounts = true): Promise<PricingAnswer> {
  const { pool } = deps.config.ids;
  const [params, view] = await Promise.all([
    soft(deps.chain.view<{ funding?: unknown; pricing_limits?: unknown; tier_pricing?: unknown } | null>(pool, "get_params")),
    soft(deps.chain.view<{ fees_charged?: unknown; fees_reversed?: unknown; subsidy_paid?: unknown; subsidy_left_24h?: unknown } | null>(pool, "get_pool")),
  ]);
  const p = params?.value;
  const v = view?.value;
  const live = p?.funding != null || p?.pricing_limits != null;
  const answer: PricingAnswer = {
    read_at_ms: now,
    funding: p?.funding ?? null,
    limits: p?.pricing_limits ?? null,
    pool: v && typeof v.fees_charged === "string" ? { fees_charged: money(v.fees_charged), fees_reversed: money(v.fees_reversed), subsidy_paid: money(v.subsidy_paid), subsidy_left_24h: money(v.subsidy_left_24h) } : null,
    tiers: tierList(p?.tier_pricing),
    accounts: [],
  };
  // A pool from before stage 2 has no pricing record for anyone: nothing more to read. Nor for an asker the
  // per-account list is hidden from (INTERFACES.md 48.5): no account is read for them.
  if (!live || !withAccounts) return answer;

  const ids = await listAccounts(deps);
  const lines: (PricingAccount | null)[] = new Array(ids.length).fill(null);
  let next = 0;
  // One account that can't be read is left out; the others still answer.
  const worker = async () => {
    for (let i = next++; i < ids.length; i = next++) {
      const account = ids[i]!;
      const [pricing, state] = await Promise.all([
        soft(deps.chain.view<PricingView | null>(pool, "get_pricing", { account_id: account })).catch(() => null),
        soft(deps.chain.view<{ verdict?: { verdict?: { ext?: unknown } | null } | null } | null>(account, "get_state")).catch(() => null),
      ]);
      lines[i] = pricingAccount(account, pricing?.value, state?.value?.verdict?.verdict?.ext);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, ids.length) }, worker));
  answer.accounts = lines.filter((line): line is PricingAccount => line !== null);
  return answer;
}

/**
 * GET /api/pricing. Kept 15 s; a read that fails isn't kept.
 *
 * Privacy level 1 (INTERFACES.md 48.5): with `hidden`, the per-account list is left out: `accounts` is empty and
 * `accounts_hidden` is true, and every other field stays. The list is for our own services, the operator and the
 * keeper. A hidden answer reads no account: it is the pool's own part, kept apart from the whole book.
 */
export async function getPricing(deps: Deps, hidden = false): Promise<PricingAnswer & { accounts_hidden?: true }> {
  const now = deps.now();
  const cache = deps.pricingBook;
  const hit = cache?.get("book", now);
  if (!hidden) return hit ? hit.value : cache ? cache.set("book", now, readPricing(deps, now)) : readPricing(deps, now);
  const pool = hit ?? cache?.get("pool", now);
  const answer = pool ? await pool.value : await (cache ? cache.set("pool", now, readPricing(deps, now, false)) : readPricing(deps, now, false));
  return { ...answer, accounts: [], accounts_hidden: true };
}
