'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ColorType,
  createChart,
  LineStyle,
  type IChartApi,
  type Time,
} from 'lightweight-charts';
import type { MarketDay } from '@/lib/types';

/**
 * The market's index level, as a line.
 *
 * A line rather than candles: the level is derived from a day's worth of
 * closes, so it has no open, high or low of its own. Drawing candles would
 * invent three prices out of one.
 *
 * The area fill is tinted by the direction of the whole window, not of the
 * last day, so the colour answers "how has it gone" rather than flickering
 * with each session. The breadth histogram underneath is net advancing stocks
 * per day: a rise on narrowing breadth and a rise on broadening breadth are
 * different markets, and the two series together say which one this is.
 */
export function MarketChart({ series }: { series: MarketDay[] }) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [hover, setHover] = useState<MarketDay | null>(null);

  useEffect(() => {
    const element = container.current;
    if (element === null || series.length === 0) return;

    const first = series[0]!;
    const last = series[series.length - 1]!;
    const rising = last.level >= first.level;

    const chart = createChart(element, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#64748b',
        fontFamily: 'ui-monospace, Consolas, monospace',
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: 'rgba(30, 41, 59, 0.5)' },
      },
      rightPriceScale: { borderColor: '#1e293b' },
      timeScale: { borderColor: '#1e293b', timeVisible: false },
      crosshair: { mode: 1 },
      autoSize: true,
    });

    const line = chart.addAreaSeries({
      lineColor: rising ? '#10b981' : '#f43f5e',
      topColor: rising ? 'rgba(16, 185, 129, 0.28)' : 'rgba(244, 63, 94, 0.28)',
      bottomColor: 'rgba(2, 6, 23, 0)',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    line.setData(series.map((day) => ({ time: day.date as Time, value: day.level })));

    // The base is where the index started, so a glance says whether the market
    // is above or below where this history begins.
    line.createPriceLine({
      price: first.level,
      color: 'rgba(100, 116, 139, 0.5)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
      title: '',
    });

    const breadth = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'breadth',
      color: 'rgba(100, 116, 139, 0.4)',
    });
    breadth.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    breadth.setData(
      series.map((day) => {
        const net = day.advances - day.declines;
        return {
          time: day.date as Time,
          value: Math.abs(net),
          color: net >= 0 ? 'rgba(16, 185, 129, 0.35)' : 'rgba(244, 63, 94, 0.35)',
        };
      }),
    );

    chart.timeScale().fitContent();

    // The crosshair drives a readout above the chart. Without it the only way
    // to read a particular day is to guess from the axis.
    const byDate = new Map(series.map((day) => [day.date, day]));
    chart.subscribeCrosshairMove((param) => {
      const time = param.time;
      setHover(typeof time === 'string' ? byDate.get(time) ?? null : null);
    });

    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [series]);

  if (series.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No stored sessions yet, so there is nothing to chart. Run the ingest.
      </p>
    );
  }

  const shown = hover ?? series[series.length - 1]!;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
        <span className="text-slate-500">{shown.date}</span>
        <span className="numeric text-slate-200">
          {shown.level.toLocaleString('en-US', { minimumFractionDigits: 2 })}
        </span>
        <span
          className={`numeric ${
            shown.change > 0 ? 'text-emerald-400' : shown.change < 0 ? 'text-rose-400' : 'text-slate-400'
          }`}
        >
          {shown.change > 0 ? '+' : shown.change < 0 ? '−' : ''}
          {Math.abs(shown.change).toLocaleString('en-US', { minimumFractionDigits: 2 })} pts (
          {shown.changeBps > 0 ? '+' : shown.changeBps < 0 ? '−' : ''}
          {Math.abs(shown.changeBps / 100).toFixed(2)}%)
        </span>
        <span className="numeric text-slate-500">
          median{' '}
          {shown.medianChangeBps > 0 ? '+' : shown.medianChangeBps < 0 ? '−' : ''}
          {Math.abs(shown.medianChangeBps / 100).toFixed(2)}%
        </span>
        <span className="text-slate-500">
          <span className="text-emerald-400">{shown.advances} up</span>
          {' · '}
          <span className="text-rose-400">{shown.declines} down</span>
          {' · '}
          {shown.unchanged} flat
        </span>
      </div>
      <div ref={container} className="h-72 w-full" />
    </div>
  );
}
