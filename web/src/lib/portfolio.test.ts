// Home's portfolio chart (INTERFACES.md 49.1 point 4): from the backend's points to a line the app draws itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { changeWords, chartPath, CHART_EMPTY_WORDS, moneyRow, portfolioPoints } from './portfolio.ts';

const T = 1_794_700_000_000;
const HOUR = 3_600_000;
const BOX = { width: 600, height: 120, pad: 10 };

test('the backend’s points become dollars, oldest first, and a point that can’t be read is left out', () => {
  const answer = {
    points: [
      { t_ms: T + HOUR, equity_micro: '1578000000', debt_micro: '500000000' },
      { t_ms: T, equity_micro: 1_500_000_000, debt_micro: 0 },
      { t_ms: T + 2 * HOUR, equity_micro: null, debt_micro: 0 },
      { t_ms: 'soon', equity_micro: 1, debt_micro: 0 },
    ],
  };
  assert.deepEqual(portfolioPoints(answer), [{ t: T, v: 1500 }, { t: T + HOUR, v: 1578 }]);
  assert.deepEqual(portfolioPoints(null), []);
  assert.deepEqual(portfolioPoints({ points: null }), []);
});

test('points become one SVG path: time left to right, value bottom to top, inside the box', () => {
  const shape = chartPath([{ t: T, v: 1000 }, { t: T + HOUR, v: 1200 }, { t: T + 2 * HOUR, v: 1100 }], BOX)!;
  // The lowest value sits 10 above the bottom, the highest 10 below the top, the middle one halfway.
  assert.equal(shape.line, 'M0 110 L300 10 L600 60');
  assert.equal(shape.area, 'M0 110 L300 10 L600 60 L600 120 L0 120 Z');
  assert.deepEqual([shape.min, shape.max], [1000, 1200]);
  // Uneven times keep their spacing: a point a quarter of the way along is a quarter of the way across.
  assert.equal(chartPath([{ t: T, v: 1 }, { t: T + HOUR, v: 2 }, { t: T + 4 * HOUR, v: 1 }], BOX)!.line, 'M0 110 L150 10 L600 110');
});

test('fewer than two points is no chart, and a value that never moved is a level line', () => {
  assert.equal(chartPath([], BOX), null);
  assert.equal(chartPath([{ t: T, v: 1000 }], BOX), null);
  assert.equal(CHART_EMPTY_WORDS, 'The chart fills in as checks come: each check of your account adds a point.');
  assert.equal(chartPath([{ t: T, v: 1000 }, { t: T + HOUR, v: 1000 }], BOX)!.line, 'M0 60 L600 60');
});

test('the change since the first point, in words', () => {
  const when = () => '12 Nov';
  assert.equal(changeWords([{ t: T, v: 1500 }, { t: T + HOUR, v: 1578 }], when), 'Up $78.00 since 12 Nov');
  assert.equal(changeWords([{ t: T, v: 1500 }, { t: T + HOUR, v: 1487.6 }], when), 'Down $12.40 since 12 Nov');
  assert.equal(changeWords([{ t: T, v: 1500 }, { t: T + HOUR, v: 1500 }], when), 'No change since 12 Nov');
  assert.equal(changeWords([{ t: T, v: 1500 }], when), null);
});

test('where the money is, in one row: NEAR, Hyperliquid, at lenders, less what is owed', () => {
  assert.deepEqual(moneyRow({ onNear: 1150, onHl: 428, atLenders: 516, owed: 1025.73 }), [
    { label: 'On NEAR', value: '$1,150.00' },
    { label: 'On Hyperliquid', value: '$428.00' },
    { label: 'At lenders', value: '$516.00' },
    { label: 'Less what you owe', value: '−$1,025.73' },
  ]);
  // A figure that isn't known yet shows a dash, and nothing owed shows as nothing.
  assert.deepEqual(moneyRow({ onNear: null, onHl: 0, atLenders: 0, owed: 0 }).map((p) => p.value), ['—', '$0.00', '$0.00', '$0.00']);
});

test('before a wallet connects the row stands empty: four places, four dashes', () => {
  assert.deepEqual(moneyRow({ onNear: null, onHl: null, atLenders: null, owed: null }), [
    { label: 'On NEAR', value: '—' },
    { label: 'On Hyperliquid', value: '—' },
    { label: 'At lenders', value: '—' },
    { label: 'Less what you owe', value: '—' },
  ]);
});
