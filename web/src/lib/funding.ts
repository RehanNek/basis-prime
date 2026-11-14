// Funding from lenders (FUNDING.md; INTERFACES.md 27 to 29): where a loan would come from, in words. What the pool's
// pricing policy makes the client pay on each part is in lib/pricing.ts (stage 2).
// One loan can come partly from an outside lender (Aave or Rhea), which looks only at the bitcoin posted with it, and
// partly from our own pool, which looks at the whole hedged book. Pure functions, so the words can be tested.
import type {
  CreditFunding,
  CreditFundingLender,
  CushionStatus,
  FundingPlanAnswer,
  FundingSource,
  LenderAccountAnswer,
  LenderName,
  LenderPosition,
  LenderTerms,
  Micro,
} from './api.ts';
import type { Tone } from './cockpit.ts';
import { displayUnits, formatBp, formatUsd } from './units.ts';

const NAMES: Record<FundingSource, string> = { aave: 'Aave', rhea: 'Rhea', pool: 'Our pool' };

/** "Aave", "Rhea" or "Our pool"; a name this page doesn't know stays as it came. */
export const sourceName = (source: string): string => NAMES[source as FundingSource] ?? source;

/** Under this cushion the engine plans a top-up, and under the second it must act at once (INTERFACES.md 27 and 28). */
export const THIN_BELOW_BP = 13_500;
export const ACT_BELOW_BP = 12_000;
/** The cushion the engine borrows to, unless the client's permission asks for more. */
export const TARGET_CUSHION_BP = 15_000;

/** A micro-USD amount from the backend, a JSON integer or a string, as a bigint. Anything else counts as 0. */
export function toMicro(value: Micro | bigint | null | undefined): bigint {
  if (typeof value === 'bigint') return value;
  try {
    return BigInt(typeof value === 'number' ? Math.trunc(value) : (value ?? '0'));
  } catch {
    return 0n;
  }
}

/**
 * Dollars for a sentence, as the engine writes them in its own: to the nearest dollar from $100 up ("$56,667"), and
 * with cents below that unless the amount is whole ("$12.34", "$56").
 */
export function dollars(value: Micro | bigint): string {
  const micro = toMicro(value);
  const size = micro < 0n ? -micro : micro;
  const shown = size >= 100_000_000n ? ((size + 500_000n) / 1_000_000n) * 1_000_000n * (micro < 0n ? -1n : 1n) : micro;
  const text = formatUsd(shown);
  return text.endsWith('.00') ? text.slice(0, -3) : text;
}

/**
 * A share in basis points for a sentence, rounded down: 3333 -> "33%", 870 -> "8.7%", 30 -> "0.3%". With `fine`, a
 * tenth of a percent is kept above 10% too, as the engine's own sentences do: 3334 -> "33.3%".
 */
export function percent(bp: number, fine = false): string {
  if (!Number.isFinite(bp)) return '?';
  return `${bp >= 1_000 && !fine ? Math.floor(bp / 100) : Math.floor(bp / 10) / 10}%`;
}

/** A cushion in basis points as the number people say: 15000 -> "1.50". */
export const formatCushion = (bp: number): string => (bp / 10_000).toFixed(2);

/**
 * What is posted with a lender, in a word: "bitcoin" for WBTC or nBTC, "ether" for WETH, and "collateral" for a mix or
 * a token the page doesn't know (stage 3: Aave's test market takes either). With no reading of it, bitcoin: what the
 * lenders took before stage 3, and what they take on mainnet.
 */
export function postedWord(held: { symbol: string }[] | null | undefined): string {
  const kinds = new Set((held ?? []).map((h) => plainName(h.symbol)));
  return kinds.size === 0 ? 'bitcoin' : kinds.size === 1 ? [...kinds][0]! : 'collateral';
}

/**
 * A collateral token's plain name (INTERFACES.md 51.1), the one rule for both lenders: "bitcoin" for nBTC and WBTC,
 * "ether" for ETH and WETH, and "collateral" for a token the page doesn't know.
 */
export function plainName(symbol: string): string {
  return /BTC$/i.test(symbol) ? 'bitcoin' : /ETH$/i.test(symbol) ? 'ether' : 'collateral';
}

/**
 * The tokens Rhea takes as collateral from this account: `lenders.rhea.collateral` of a `get_config()` answer (the
 * account's own, or the factory's for an account not opened yet), as token ids. Null when the settings have no Rhea,
 * or weren't read. An account made before 14 Nov lists bitcoin alone; one made since may list test ETH too.
 */
export function rheaCollateralOf(config: unknown): string[] | null {
  const list = (config as { lenders?: { rhea?: { collateral?: unknown } | null } | null } | null | undefined)?.lenders?.rhea?.collateral;
  if (!Array.isArray(list)) return null;
  const ids = list.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return ids.length > 0 ? ids : null;
}

/**
 * What Rhea would take from this account, in a word, before anything is posted there (INTERFACES.md 51.1). Only the
 * tokens of the account's own list count: of those, the ones the account holds ("ether" for an account that holds
 * test ETH and no bitcoin, "bitcoin and ether" for one that holds both); with none held, the list itself ("bitcoin or
 * ether"). Without the list (it wasn't read, or the account has no Rhea) it is bitcoin, as before: nothing promises an
 * account from before the change a loan against its ether.
 */
export function wouldPostWord(collateral: string[] | null | undefined, tokens: { id: string; symbol: string }[], holds: (id: string) => boolean): string {
  const listed = (collateral ?? []).flatMap((id) => tokens.filter((t) => t.id === id));
  if (listed.length === 0) return 'bitcoin';
  const names = (list: { symbol: string }[]) => [...new Set(list.map((t) => plainName(t.symbol)))];
  const held = names(listed.filter((t) => holds(t.id)));
  return held.length > 0 ? held.join(' and ') : names(listed).join(' or ');
}

const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * What each lender looks at for this account, in a word, where the page knows it: what the lender already holds, and
 * for Aave also the collateral waiting at the account's address on its chain, which a loan would post. A lender with
 * neither says `would`'s word for it when the caller gives one, and is otherwise left out, and reads as bitcoin.
 */
export function postedWords(answer: LenderAccountAnswer | null | undefined, would: Partial<Record<LenderName, string>> = {}): Partial<Record<LenderName, string>> {
  // `would`: what a lender would take from the account before it holds anything (Rhea: wouldPostWord). What it holds wins.
  const out: Partial<Record<LenderName, string>> = { ...would };
  const some = (amount: unknown): boolean => toMicro(amount as Micro) > 0n;
  for (const position of answer?.lenders ?? []) {
    const held = (position.held ?? []).filter((h) => some(h.amount));
    if (held.length > 0) out[position.l] = postedWord(held);
  }
  const waiting = (answer?.evm?.wallet ?? []).filter((t) => t.symbol !== 'USDC' && some(t.amount));
  if (!out.aave && waiting.length > 0) out.aave = postedWord(waiting);
  return out;
}

/**
 * What a lender would take from an account's settings, in a word, with nothing held yet: "bitcoin" for settings from
 * before 14 Nov, "bitcoin or ether" once Rhea's list has test ETH (INTERFACES.md 51.1). For the permission's notes.
 */
export function settingsPostedWord(config: unknown): string {
  const list = (config as { tokens?: unknown } | null | undefined)?.tokens;
  const tokens = (Array.isArray(list) ? list : []).flatMap((t) => {
    const { id, symbol } = (t ?? {}) as Record<string, unknown>;
    return typeof id === 'string' && typeof symbol === 'string' ? [{ id, symbol }] : [];
  });
  return wouldPostWord(rheaCollateralOf(config), tokens, () => false);
}

/** "Cushion" in plain words. Each page says it once, where the word first appears. `posted` is what the lender holds, in a word. */
export function cushionExplained(targetBp: number = TARGET_CUSHION_BP, posted = 'bitcoin'): string {
  return `The cushion is how many times over the ${posted} posted with a lender covers the loan there, counted the way that lender counts it. At 1.00 the lender sells, so the engine borrows only up to a cushion of ${formatCushion(targetBp)}.`;
}

/**
 * The rate of a whole loan made of parts, weighted by amount, to the nearest basis point. Null when nothing is lent,
 * or when a part's rate isn't known.
 */
export function blendedBp(parts: { amount: Micro | bigint; rate_bp: number | null }[]): number | null {
  let total = 0n;
  let weighted = 0n;
  for (const part of parts) {
    const amount = toMicro(part.amount);
    if (amount <= 0n) continue;
    if (part.rate_bp === null || !Number.isFinite(part.rate_bp)) return null;
    total += amount;
    weighted += amount * BigInt(Math.round(part.rate_bp));
  }
  return total === 0n ? null : Number((weighted * 2n + total) / (total * 2n));
}

/** How far bitcoin can fall before a lender with this cushion sells, in basis points: 1.5 leaves a third. */
export function fallBp(hfBp: number): number {
  return hfBp > 10_000 ? Math.floor(10_000 - 100_000_000 / hfBp) : 0;
}

/** A position's state from its cushion: none with nothing owed, act under 1.2, thin under 1.35, safe otherwise. */
export function cushionStatus(hfBp: number, debt: Micro | bigint): CushionStatus {
  if (toMicro(debt) <= 0n || !(hfBp > 0)) return 'none';
  if (hfBp < ACT_BELOW_BP) return 'act';
  return hfBp < THIN_BELOW_BP ? 'thin' : 'safe';
}

/** The cushion bar's zones, as shares of its width: Safe, Thin, Act (globals.css draws the same 6:2:2). */
export const CUSHION_ZONES = { thin: 60, act: 80 } as const;

const clamp = (x: number, low: number, high: number) => Math.min(high, Math.max(low, x));

/** Where the marker sits on the cushion bar, from 0 (safest) to 100: 2.0 or more on the left, 1.0 on the right. */
export function cushionMarker(hfBp: number): number {
  const { thin, act } = CUSHION_ZONES;
  if (hfBp >= THIN_BELOW_BP) return clamp((thin * (20_000 - hfBp)) / (20_000 - THIN_BELOW_BP), 2, thin - 1);
  if (hfBp >= ACT_BELOW_BP) return thin + ((act - thin) * (THIN_BELOW_BP - hfBp)) / (THIN_BELOW_BP - ACT_BELOW_BP);
  return clamp(act + ((100 - act) * (ACT_BELOW_BP - hfBp)) / (ACT_BELOW_BP - 10_000), act + 1, 98);
}

export interface CushionView {
  status: CushionStatus;
  label: string;
  tone: Tone;
  /** Null when nothing is owed: there is nothing to place. */
  marker: number | null;
  words: string;
}

const STATUSES: CushionStatus[] = ['none', 'safe', 'thin', 'act'];

/**
 * A lender position's cushion as a bar and a sentence. The backend's own status wins when it names one. The sentence
 * names what is posted there: bitcoin, or ether on Aave's test market (`held`).
 */
export function cushionView(position: Pick<LenderPosition, 'l' | 'hf_bp' | 'debt' | 'status' | 'held'>): CushionView {
  const name = sourceName(position.l);
  const status = STATUSES.includes(position.status) ? position.status : cushionStatus(position.hf_bp, position.debt);
  const fall = percent(fallBp(position.hf_bp));
  const marker = cushionMarker(position.hf_bp);
  const posted = postedWord(position.held);
  switch (status) {
    case 'none':
      return { status, label: 'Nothing owed', tone: 'neutral', marker: null, words: `Nothing is owed to ${name}, so nothing there can be sold.` };
    case 'safe':
      return { status, label: 'Safe', tone: 'good', marker, words: `${capital(posted)} could fall ${fall} before ${name} would sell.` };
    case 'thin':
      return {
        status,
        label: 'Thin',
        tone: 'warn',
        marker,
        words: `${capital(posted)} could fall only ${fall} before ${name} would sell. That is thin, so the engine plans a top-up from your spare ${posted} or cash.`,
      };
    default:
      return {
        status,
        label: 'Act now',
        tone: 'bad',
        marker,
        words:
          position.hf_bp > 10_000
            ? `${capital(posted)} could fall only ${fall} before ${name} would sell. Repay ${name} or post more ${posted} there now.`
            : `The loan has passed ${name}’s selling line, so ${name} can sell now. Repay ${name} or post more ${posted} there at once.`,
      };
  }
}

/** The lenders an account has anything at, posted or owed. No position, no card. */
export function lenderPositions(answer: LenderAccountAnswer | null | undefined): LenderPosition[] {
  return (answer?.lenders ?? []).filter((p) => toMicro(p.posted) > 0n || toMicro(p.debt) > 0n);
}

/**
 * Can this account's loans come from a lender at all? That is the account's own config: with lenders in it the account
 * borrows through `fund`, and with none the borrow panel stays exactly as it was. An older backend doesn't say which
 * lenders the config has; a permission or a lender position then shows it is such an account.
 */
export function canUseLenders(answer: LenderAccountAnswer | null | undefined): boolean {
  if (!answer) return false;
  if (Array.isArray(answer.config_lenders)) return answer.config_lenders.length > 0;
  return (answer.lenders?.length ?? 0) > 0 || Boolean(answer.permission);
}

export interface LenderCard {
  l: LenderName;
  name: string;
  /** "On Base Sepolia", when the lender's terms for this network are known. */
  where: string | null;
  posted: string;
  postedSub: string;
  owed: string;
  rate: string;
  cushion: string;
  /** When the lender sells, in words. */
  sells: string;
  /** What the lender could still lend, or null when nothing. */
  room: string | null;
  view: CushionView;
}

/** One lender card on Home: what is posted there, what is owed, the rate and the cushion. */
export function lenderCard(position: LenderPosition, terms?: LenderTerms | null): LenderCard {
  const name = sourceName(position.l);
  const view = cushionView(position);
  const room = toMicro(position.room);
  // The tokens posted there by name, when the lender's own record was read: "Your 0.02 WETH", "Your 0.006 nBTC".
  const held = (position.held ?? []).filter((h) => toMicro(h.amount) > 0n).map((h) => `${displayUnits(toMicro(h.amount), h.decimals, h.decimals)} ${h.symbol}`);
  return {
    l: position.l,
    name,
    where: terms ? `On ${terms.chain}` : null,
    posted: formatUsd(toMicro(position.posted)),
    postedSub: held.length > 0 ? `Your ${held.join(' and ')}, at today’s price` : terms ? `Your ${terms.collateral}, at today’s price` : 'Your bitcoin, at today’s price',
    owed: formatUsd(toMicro(position.debt)),
    rate: typeof position.rate_bp === 'number' ? `${formatBp(position.rate_bp)} a year` : 'Not read yet',
    cushion: view.status === 'none' ? '—' : formatCushion(position.hf_bp),
    sells: `${name} sells once the loan passes ${percent(position.liq_bp)} of the ${postedWord(position.held)}’s value.`,
    room: room > 0n ? `${name} could lend ${dollars(room)} more against what you hold.` : null,
    view,
  };
}

/** The lender's terms on this network, from GET /api/lenders. */
export function termsFor(lenders: LenderTerms[] | undefined, l: LenderName, network: string): LenderTerms | null {
  return lenders?.find((t) => t.l === l && t.network === network) ?? null;
}

/**
 * What each source looks at before it lends: a lender sees only what is posted with it, our pool sees the whole book.
 * `posted` is that in a word, bitcoin unless the page knows the lender holds something else (lib/funding.ts, postedWord).
 */
export const looksAt = (source: string, posted = 'bitcoin'): string => (source === 'pool' ? 'your whole hedged book' : `your ${posted}`);

/**
 * The split in a sentence or two: "Aave lends $56,667 against your bitcoin at 5.33%. Our pool lends the other $37,833
 * against your whole hedged book at 6.50%." With `would`, for a split the engine wouldn't use: "Rhea would lend …".
 */
export function splitWords(parts: { source: string; amount: Micro | bigint; rate_bp: number | null }[], would = false): string {
  const lent = parts.filter((p) => toMicro(p.amount) > 0n);
  const lends = would ? 'would lend' : 'lends';
  return lent
    .map((p, i) => {
      const share = lent.length === 1 ? 'all ' : i > 0 ? 'the other ' : '';
      return `${sourceName(p.source)} ${lends} ${share}${dollars(p.amount)} against ${looksAt(p.source)}${p.rate_bp === null ? '' : ` at ${formatBp(p.rate_bp)}`}.`;
    })
    .join(' ');
}

export interface PlanView {
  /**
   * A rate is null when the answer didn't carry it. `note` is there only when the pool's pricing policy makes the client
   * pay another rate than the source's own (lib/pricing.ts, pricedPlan), and says the difference.
   */
  rows: { source: string; name: string; amount: string; rate: string | null; note?: string }[];
  total: string;
  /** The whole loan's rate. */
  rate: string | null;
  words: string;
  /** When the engine would fund less than was asked. */
  short: string | null;
}

/**
 * "Where it comes from", for the borrow panel: each source, its amount and its rate, then the whole loan's rate. Null
 * when there is nothing to show: no answer, or a refusal (the pinned engine may not know the question yet). Each rate
 * here is the source's own; lib/pricing.ts turns them into what the client pays under the pool's pricing policy.
 */
export function planView(answer: FundingPlanAnswer | null | undefined): PlanView | null {
  if (!answer || (answer as { ok?: boolean }).ok === false || answer.verdict?.ok === false || !Array.isArray(answer.sources)) return null;
  const sources = answer.sources.filter((s) => toMicro(s.amount) > 0n);
  const total = sources.reduce((sum, s) => sum + toMicro(s.amount), 0n);
  if (total === 0n) return null;
  const blended = typeof answer.blended_bp === 'number' ? answer.blended_bp : blendedBp(sources);
  const asked = toMicro(answer.asked);
  return {
    rows: sources.map((s) => ({ source: s.source, name: sourceName(s.source), amount: formatUsd(toMicro(s.amount)), rate: s.rate_bp === null ? null : formatBp(s.rate_bp) })),
    total: formatUsd(total),
    rate: blended === null ? null : formatBp(blended),
    words: splitWords(sources),
    short: asked > total ? `The engine would fund ${formatUsd(total)} of the ${formatUsd(asked)} asked.` : null,
  };
}

export interface FundingLenderView {
  l: LenderName;
  name: string;
  where: string;
  used: boolean;
  /** The split, in a sentence or two. */
  headline: string;
  rows: [string, string][];
  /** Moving the bitcoin to the lender's chain: its cost against what it saves. The page says it when the engine gave no reason. */
  move: string;
  /**
   * Stage 3: the bitcoin's trip there and back in dollars, against what the lender's lower rate saves. Null when the
   * lender needs no move, no quote came, or the engine is from before the trip back was counted.
   */
  trip: string | null;
  /** The engine's own reason for using this lender or not, as it wrote it. */
  why: string;
}

export interface FundingView {
  intro: string;
  /** Which way the engine would fund the loan. */
  choice: string;
  cushion: string;
  lenders: FundingLenderView[];
}

/**
 * A move's two ways (stage 3; INTERFACES.md 33): the way there, the way back and both together, in micro-USD. Null for
 * an engine from before the trip back was counted, which sends the way there alone. When no quote came for the way
 * back (`back_quoted` false), the engine counted it as the way there.
 */
export function moveBothWays(move: CreditFundingLender['move']): { there: bigint; back: bigint; total: bigint; backQuoted: boolean } | null {
  if (!move || (move.back === undefined && move.total === undefined)) return null;
  const there = toMicro(move.cost);
  const back = move.back === undefined ? there : toMicro(move.back);
  return { there, back, total: move.total === undefined ? there + back : toMicro(move.total), backQuoted: move.back_quoted !== false };
}

/**
 * The trip in dollars: "Moving the bitcoin there costs $490 and bringing it back $130. Aave's lower rate saves $207
 * over 90 days, which doesn't cover the $620." The engine moves bitcoin only when the saving beats both ways.
 */
export function tripWords(lender: Pick<CreditFundingLender, 'l' | 'move'>, days: number): string | null {
  const ways = moveBothWays(lender.move);
  if (!ways) return null;
  const name = sourceName(lender.l);
  const saves = toMicro(lender.move!.saves);
  const cost = ways.backQuoted
    ? `Moving the bitcoin there costs ${dollars(ways.there)} and bringing it back ${dollars(ways.back)}.`
    : `Moving the bitcoin there costs ${dollars(ways.there)}. No quote came for bringing it back, so that is counted as the same again.`;
  if (saves <= 0n) return `${cost} ${name}’s rate is no lower than our pool’s, so the move saves nothing against the ${dollars(ways.total)}.`;
  return `${cost} ${name}’s lower rate saves ${dollars(saves)} over ${days} days, which ${saves > ways.total ? 'covers' : 'doesn’t cover'} the ${dollars(ways.total)}.`;
}

function moveWords(lender: CreditFundingLender, days: number): string {
  const name = sourceName(lender.l);
  if (!lender.move) {
    return lender.l === 'rhea' ? 'Your bitcoin stays on NEAR, so there is nothing to move.' : `No quote came for moving the bitcoin to ${lender.chain}, so that cost isn’t counted here.`;
  }
  const trip = tripWords(lender, days);
  if (trip) return trip;
  const { cost_bp, source } = lender.move;
  const cost = toMicro(lender.move.cost);
  const saves = toMicro(lender.move.saves);
  const start = `Moving the bitcoin to ${lender.chain} as ${lender.collateral} would cost about ${dollars(cost)} (${formatBp(cost_bp)}; ${source}).`;
  if (saves <= 0n) return `${start} Over ${days} days ${name} would save nothing against borrowing it all from our pool, so the move doesn’t pay.`;
  return `${start} Over ${days} days ${name} would save ${dollars(saves)} of interest against borrowing it all from our pool, so the move ${saves > cost ? 'pays for itself' : 'costs more than it saves'}.`;
}

/**
 * The credit check's "How this loan would be funded" (INTERFACES.md 27), in words. Null when the result has no
 * `funding`: an older engine, and the page shows nothing.
 */
/**
 * A lender's penalty in words. The engine answers 0 for a lender with no fixed penalty: Rhea's liquidators take a
 * discount that grows with how far past the line the loan is, about 0.3% in what we have seen (research/rhea.md).
 */
export function penaltyWords(penaltyBp: number | null | undefined): string {
  return penaltyBp ? percent(penaltyBp, true) : 'No fixed penalty: a small discount, about 0.3% so far';
}

export function fundingView(funding: CreditFunding | null | undefined): FundingView | null {
  if (!funding || !Array.isArray(funding.lenders)) return null;
  const poolRate = formatBp(funding.pool_rate_bp);
  // A book that gets no line has nothing to fund: each lender keeps its name and the engine's reason, no figures.
  const hasLine = toMicro(funding.line) > 0n;
  const lenders = funding.lenders.map((lender): FundingLenderView => {
    const name = sourceName(lender.l);
    const rows: [string, string][] = [];
    if (hasLine) {
      rows.push(['The whole loan would cost', `${formatBp(lender.blended_bp)} a year`], ['From our pool alone it would cost', `${poolRate} a year`]);
      // How far bitcoin can fall only means something when the lender would lend.
      if (toMicro(lender.lends) > 0n) {
        rows.push([`Bitcoin can fall, before ${name} would sell`, percent(lender.fall_bp, true)], [`${name}’s penalty if it sells`, penaltyWords(lender.penalty_bp)]);
      }
      if (lender.move) {
        rows.push(['Moving the bitcoin there costs', `${dollars(lender.move.cost)} (${formatBp(lender.move.cost_bp)})`]);
        // Stage 3: the trip back counts too, and the saving is weighed against both ways.
        const ways = moveBothWays(lender.move);
        if (ways) {
          const share = lender.move.back_bp === undefined ? '' : ` (${formatBp(lender.move.back_bp)})`;
          rows.push(['Bringing it back costs', ways.backQuoted ? `${dollars(ways.back)}${share}` : `${dollars(ways.back)}: no quote came, so it is counted as the way there`], ['There and back', dollars(ways.total)]);
        }
        rows.push([`Interest saved over ${funding.loan_days} days`, toMicro(lender.move.saves) > 0n ? dollars(lender.move.saves) : '$0']);
      } else {
        rows.push(['Moving the bitcoin', lender.l === 'rhea' ? 'Not needed: it stays on NEAR' : 'No quote came, so its cost isn’t counted']);
      }
    }
    return {
      l: lender.l,
      name,
      where: `On ${lender.chain}, against ${lender.collateral}`,
      used: lender.used,
      headline: !hasLine
        ? 'This book gets no credit line, so there is nothing to fund.'
        : toMicro(lender.lends) > 0n
          ? splitWords(
              [
                { source: lender.l, amount: lender.lends, rate_bp: lender.rate_bp },
                { source: 'pool', amount: lender.pool, rate_bp: funding.pool_rate_bp },
              ],
              !lender.used,
            )
          : `${name} would lend nothing against your bitcoin now, so our pool would lend all ${dollars(funding.line)} against your whole hedged book at ${poolRate}.`,
      rows,
      move: moveWords(lender, funding.loan_days),
      trip: hasLine ? tripWords(lender, funding.loan_days) : null,
      why: lender.why ?? '',
    };
  });
  return {
    intro: `A lender such as Aave or Rhea looks only at the bitcoin posted with it. Our pool looks at your whole hedged book, so it can lend the part a lender won’t.${
      hasLine ? ` This is the ${dollars(funding.line)} line with each lender, with our pool at ${poolRate} a year: its rate once 60% of the pool is lent out.` : ''
    }`,
    choice: !hasLine
      ? 'This book gets no credit line, so there is nothing to fund.'
      : funding.choice === 'pool'
        ? `The engine would fund this loan from our pool alone, at ${poolRate} a year.`
        : `The engine would use ${sourceName(funding.choice)} for the part against your bitcoin, and our pool for the rest.`,
    cushion: `No lender is asked for the most it would lend. ${cushionExplained(funding.target_hf_bp)}`,
    lenders,
  };
}
