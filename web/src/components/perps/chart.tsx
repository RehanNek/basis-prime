'use client';
// The Perps page's price chart (INTERFACES.md 49.1 and 49.5): candles with volume underneath, drawn by the app itself
// in SVG, with no chart library. lib/perps.ts turns the candles into bars and scales for the box's size in pixels;
// this file measures the box, draws, and follows the pointer with a crosshair that names the candle's open, high, low
// and close. With little or no data it says "Testnet has few trades in this market" rather than stretching a few
// candles across the pane.
import { memo, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';

import { barAt, candleChange, candleNote, CHART, chartModel, INTERVALS, priceAt, priceText, THIN_WORDS, timeLabel, type Candle, type ChartBox, type ChartModel, type Interval } from '@/lib/perps';

import s from './perps.module.css';

interface Props {
  coin: string;
  szDecimals: number;
  /** Undefined while the first answer is on its way. */
  candles: Candle[] | undefined;
  /** The backend couldn't answer. */
  failed: boolean;
  interval: Interval;
  onInterval: (interval: Interval) => void;
}

export function ChartPanel({ coin, szDecimals, candles, failed, interval, onInterval }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<ChartBox>({ width: 0, height: 0 });
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  // The chart is laid out in real pixels, so its text stays one size at any width.
  useEffect(() => {
    const element = boxRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setBox((last) => (last.width === Math.round(width) && last.height === Math.round(height) ? last : { width: Math.round(width), height: Math.round(height) }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const model = useMemo(() => (candles ? chartModel(candles, box) : null), [candles, box]);
  const note = candles ? candleNote(candles) : null;
  const hovered = model && pointer ? barAt(model, pointer.x) : null;
  const shown = hovered ?? model?.bars.at(-1) ?? null;

  const follow = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPointer({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  return (
    <section className={`${s.panel} ${s.chart}`} aria-label={`${coin} price chart`}>
      <div className={s.panelHead}>
        <div className="btn-group btn-group-sm" role="group" aria-label="Candle length">
          {INTERVALS.map((i) => (
            <button key={i.id} type="button" className={`btn ${i.id === interval ? 'btn-primary' : 'btn-outline-secondary'}`} aria-pressed={i.id === interval} onClick={() => onInterval(i.id)}>
              {i.id}
            </button>
          ))}
        </div>
        {shown && (
          <div className={`${s.readout} ${s.num}`} aria-live="off">
            <span>{timeLabel(shown.candle.t, interval, { full: true })}</span>
            <span>O <b>{priceText(shown.candle.o, szDecimals)}</b></span>
            <span>H <b>{priceText(shown.candle.h, szDecimals)}</b></span>
            <span>L <b>{priceText(shown.candle.l, szDecimals)}</b></span>
            <span>C <b>{priceText(shown.candle.c, szDecimals)}</b></span>
            <span className={shown.up ? s.good : s.bad}>{candleChange(shown.candle).pct}</span>
            <span>Vol <b>{shown.candle.v.toLocaleString('en-US', { maximumFractionDigits: 4 })}</b></span>
          </div>
        )}
      </div>
      <div className={s.chartBox} ref={boxRef}>
        {model ? (
          <>
            <svg width={box.width} height={box.height} role="img" aria-label={`${coin} candles, ${interval}`} onPointerMove={follow} onPointerDown={follow} onPointerLeave={() => setPointer(null)}>
              <Candles model={model} box={box} szDecimals={szDecimals} interval={interval} />
              {pointer && hovered && <Crosshair model={model} box={box} x={hovered.x} y={pointer.y} t={hovered.candle.t} szDecimals={szDecimals} interval={interval} />}
            </svg>
            {note && <div className={s.chartCaption}>{note}.</div>}
          </>
        ) : (
          <div className={s.chartNote}>
            {candles === undefined && !failed ? (
              <div className="pb-skeleton w-100 h-100" aria-busy="true" />
            ) : failed && !candles ? (
              'The price chart isn’t available right now. It will show here when it is.'
            ) : candles && candles.length === 0 ? (
              `${THIN_WORDS}. Try a longer candle, like 1h or 1d.`
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

/** Everything that doesn't move with the pointer: the scales, the candles, the volume and the last price's line. */
const Candles = memo(function Candles({ model, box, szDecimals, interval }: { model: ChartModel; box: ChartBox; szDecimals: number; interval: Interval }) {
  const { plot, volume, bars, bodyWidth, last } = model;
  const axisX = plot.right + 6;
  return (
    <g>
      {model.priceTicks.map((tick) => (
        <g key={tick.price}>
          <line className={s.gridLine} x1={plot.left} x2={plot.right} y1={Math.round(tick.y) + 0.5} y2={Math.round(tick.y) + 0.5} />
          {/* The last price's own label takes the place of a tick's that would sit under it. */}
          {Math.abs(tick.y - last.y) >= 13 && (
            <text className={s.axisText} x={axisX} y={tick.y + 3.5}>
              {priceText(tick.price, szDecimals)}
            </text>
          )}
        </g>
      ))}
      <line className={s.gridLine} x1={plot.left} x2={box.width} y1={volume.bottom + 0.5} y2={volume.bottom + 0.5} />
      <line className={s.gridLine} x1={plot.right + 0.5} x2={plot.right + 0.5} y1={0} y2={volume.bottom} />
      {model.timeTicks
        .filter((tick) => tick.x > 24 && tick.x < plot.right - 16)
        .map((tick) => (
          <text key={tick.t} className={s.axisText} x={tick.x} y={box.height - 6} textAnchor="middle">
            {timeLabel(tick.t, interval)}
          </text>
        ))}
      {bars.map((bar) => {
        const tone = bar.up ? s.up : s.down;
        const x = Math.round(bar.x) + 0.5;
        return (
          <g key={bar.candle.t} className={tone}>
            <rect className={s.vol} x={x - bodyWidth / 2} y={bar.volTop} width={bodyWidth} height={bar.volHeight} />
            <line x1={x} x2={x} y1={bar.wickTop} y2={bar.wickBottom} strokeWidth={1} />
            <rect x={x - bodyWidth / 2} y={bar.bodyTop} width={bodyWidth} height={bar.bodyHeight} stroke="none" />
          </g>
        );
      })}
      <g className={last.up ? s.up : s.down}>
        <line className={s.lastLine} x1={plot.left} x2={plot.right} y1={Math.round(last.y) + 0.5} y2={Math.round(last.y) + 0.5} />
        <rect x={plot.right + 1} y={last.y - 8} width={CHART.axisRight - 1} height={16} stroke="none" />
        <text className={s.lastText} x={axisX} y={last.y + 3.5} stroke="none">
          {priceText(last.price, szDecimals)}
        </text>
      </g>
    </g>
  );
});

/** The crosshair: a line down the candle under the pointer with its time, and a line across with the price there. */
function Crosshair({ model, box, x, y, t, szDecimals, interval }: { model: ChartModel; box: ChartBox; x: number; y: number; t: number; szDecimals: number; interval: Interval }) {
  const { plot, volume } = model;
  const price = priceAt(model, y);
  const cx = Math.round(x) + 0.5;
  const label = timeLabel(t, interval, { full: true });
  const labelWidth = label.length * 6.2 + 10;
  const labelX = Math.min(Math.max(cx - labelWidth / 2, 0), plot.right - labelWidth);
  return (
    <g pointerEvents="none">
      <line className={s.cross} x1={cx} x2={cx} y1={plot.top} y2={volume.bottom} />
      <rect className={s.tag} x={labelX} y={volume.bottom + 2} width={labelWidth} height={16} rx={2} />
      <text className={s.tagText} x={labelX + labelWidth / 2} y={box.height - 6} textAnchor="middle">
        {label}
      </text>
      {price !== null && (
        <>
          <line className={s.cross} x1={plot.left} x2={plot.right} y1={Math.round(y) + 0.5} y2={Math.round(y) + 0.5} />
          <rect className={s.tag} x={plot.right + 1} y={y - 8} width={CHART.axisRight - 1} height={16} />
          <text className={s.tagText} x={plot.right + 6} y={y + 3.5}>
            {priceText(price, szDecimals)}
          </text>
        </>
      )}
    </g>
  );
}
