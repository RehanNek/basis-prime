// Home's portfolio (INTERFACES.md 49.1 point 4): the account's value now, and a chart of it over time, drawn by the
// app itself. The points come from GET /api/portfolio/:account: one per check result the account has stored, oldest
// first, with the engine's equity and the debt in micro-USD. This file turns them into a line.

/** One point of the chart: when (ms), and the account's value then, in dollars. */
export interface ChartPoint {
  t: number;
  v: number;
}

/**
 * The answer's points as the chart draws them: the engine's equity in dollars, oldest first. A point the page can't
 * read is left out, and two at the same moment keep the later one.
 */
export function portfolioPoints(answer: { points?: { t_ms?: unknown; equity_micro?: unknown }[] | null } | null | undefined): ChartPoint[] {
  const points: ChartPoint[] = [];
  for (const p of answer?.points ?? []) {
    const t = Number(p?.t_ms);
    const micro = Number(p?.equity_micro);
    if (!Number.isFinite(t) || t <= 0 || p?.equity_micro === null || p?.equity_micro === undefined || !Number.isFinite(micro)) continue;
    points.push({ t, v: micro / 1e6 });
  }
  points.sort((a, b) => a.t - b.t);
  return points.filter((p, i) => i === points.length - 1 || points[i + 1]!.t !== p.t);
}

export interface ChartBox {
  width: number;
  height: number;
  /** Room kept clear inside the box, top and bottom, so the line never touches the edge. */
  pad: number;
}

export interface ChartShape {
  /** The line: an SVG path through every point, left to right. */
  line: string;
  /** The same line closed down to the bottom of the box, to fill under it. */
  area: string;
  min: number;
  max: number;
}

const n = (value: number): string => String(Math.round(value * 10) / 10);

/**
 * The points as an SVG path inside the box: time runs left to right from the first point to the last, and value runs
 * bottom to top from the lowest to the highest. Null with fewer than two points: one point is not a chart. A value
 * that never changed draws a level line across the middle.
 */
export function chartPath(points: ChartPoint[], box: ChartBox): ChartShape | null {
  if (points.length < 2) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const span = last.t - first.t;
  if (!(span > 0)) return null;
  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const inner = box.height - 2 * box.pad;
  const x = (t: number) => ((t - first.t) / span) * box.width;
  const y = (v: number) => (max === min ? box.height / 2 : box.pad + (1 - (v - min) / (max - min)) * inner);
  const line = points.map((p, i) => (i === 0 ? 'M' : 'L') + n(x(p.t)) + ' ' + n(y(p.v))).join(' ');
  return { line, area: line + ' L' + n(box.width) + ' ' + n(box.height) + ' L0 ' + n(box.height) + ' Z', min, max };
}

const dollars = (value: number): string => '$' + Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "Up $12.40 since 12 Nov, 14:09" from the first point to the last. Null with fewer than two points. */
export function changeWords(points: ChartPoint[], when: (ms: number) => string): string | null {
  if (points.length < 2) return null;
  const first = points[0]!;
  const change = points[points.length - 1]!.v - first.v;
  if (Math.abs(change) < 0.005) return 'No change since ' + when(first.t);
  return (change > 0 ? 'Up ' : 'Down ') + dollars(change) + ' since ' + when(first.t);
}

/** What Home says in the chart's place while there are too few points to draw. */
export const CHART_EMPTY_WORDS = 'The chart fills in as checks come: each check of your account adds a point.';

/** One figure of the row under the chart. */
export interface MoneyPart {
  label: string;
  /** "$1,150.00", or "—" while a price is still being read. */
  value: string;
}

/**
 * Where the money is, in one row: on NEAR, on Hyperliquid, at lenders (what is posted with them and what sits at the
 * account's address on a lender's chain), less what is owed. Dollars; null where a figure isn't known yet, and all
 * four null before a wallet connects.
 */
export function moneyRow(input: { onNear: number | null; onHl: number | null; atLenders: number | null; owed: number | null }): MoneyPart[] {
  const show = (value: number | null) => (value === null || !Number.isFinite(value) ? '—' : dollars(value));
  return [
    { label: 'On NEAR', value: show(input.onNear) },
    { label: 'On Hyperliquid', value: show(input.onHl) },
    { label: 'At lenders', value: show(input.atLenders) },
    // Null before a wallet connects (INTERFACES.md 50.1 point 1): the card stands empty, so this is a dash too.
    { label: 'Less what you owe', value: input.owed === null ? '—' : input.owed > 0 ? '−' + dollars(input.owed) : dollars(0) },
  ];
}
