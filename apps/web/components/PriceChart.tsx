'use client';

import { useEffect, useRef } from 'react';
import {
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';

/**
 * The price chart.
 *
 * TradingView's Lightweight Charts, because the exchange sells no data API and
 * their charting libraries expect you to supply your own series — which is
 * exactly the arrangement here. It is also what most Pakistani traders already
 * read, so the candles look like the ones they are used to.
 *
 * `highlightDates` is what connects the chart to the factor table: hovering a
 * candlestick factor marks the bars it actually fired on. That link is the
 * difference between being told a pattern was found and being shown it.
 */

export interface ChartBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function PriceChart({
  bars,
  highlightDates,
}: {
  bars: ChartBar[];
  highlightDates: string[] | null;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;

    const chart = createChart(element, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#64748b',
        fontFamily: 'ui-monospace, Consolas, monospace',
      },
      grid: {
        vertLines: { color: 'rgba(30, 41, 59, 0.5)' },
        horzLines: { color: 'rgba(30, 41, 59, 0.5)' },
      },
      rightPriceScale: { borderColor: '#1e293b' },
      timeScale: { borderColor: '#1e293b', timeVisible: false },
      crosshair: { mode: 1 },
      autoSize: true,
    });

    const candles = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#f43f5e',
      borderUpColor: '#10b981',
      borderDownColor: '#f43f5e',
      wickUpColor: '#10b981',
      wickDownColor: '#f43f5e',
      // Prices arrive as paisa integers; dividing here keeps the one conversion
      // at the display boundary.
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    candles.setData(
      bars.map((bar) => ({
        time: bar.date as Time,
        open: bar.open / 100,
        high: bar.high / 100,
        low: bar.low / 100,
        close: bar.close / 100,
      })),
    );

    const volume = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      color: 'rgba(100, 116, 139, 0.4)',
    });
    // Pinned to the bottom fifth so volume gives context without competing
    // with price for the eye.
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volume.setData(
      bars.map((bar) => ({
        time: bar.date as Time,
        value: bar.volume,
        color:
          bar.close >= bar.open ? 'rgba(16, 185, 129, 0.35)' : 'rgba(244, 63, 94, 0.35)',
      })),
    );

    chart.timeScale().fitContent();

    chartRef.current = chart;
    candlesRef.current = candles;

    return () => {
      chart.remove();
      chartRef.current = null;
      candlesRef.current = null;
    };
  }, [bars]);

  // Markers are applied in their own effect so hovering a factor does not
  // rebuild the whole chart.
  useEffect(() => {
    const candles = candlesRef.current;
    if (candles === null) return;

    if (highlightDates === null || highlightDates.length === 0) {
      candles.setMarkers([]);
      return;
    }

    const markers: SeriesMarker<Time>[] = highlightDates.map((date) => ({
      time: date as Time,
      position: 'aboveBar',
      color: '#fbbf24',
      shape: 'arrowDown',
      text: '',
    }));

    candles.setMarkers(markers);
  }, [highlightDates]);

  if (bars.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center text-sm text-slate-600">
        No price history for this symbol yet.
      </div>
    );
  }

  return <div ref={container} className="h-72 w-full" />;
}
