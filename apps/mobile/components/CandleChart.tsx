import { Fragment, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Rect } from 'react-native-svg';
import { colors, space } from '@/lib/theme';
import type { ChartBar } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';

/**
 * A candlestick chart, drawn by hand in SVG.
 *
 * The web app uses lightweight-charts, which has no React Native build. The
 * alternatives were a WebView — a browser inside the app to draw a few hundred
 * rectangles — or a charting library whose gesture handling and native
 * dependencies cost more than the drawing. So the drawing is here: it is about
 * forty lines of arithmetic and has no dependencies beyond react-native-svg.
 *
 * `highlightDates` is what connects the chart to the factor table: tapping a
 * candlestick factor marks the bars it actually fired on. That link is the
 * difference between being told a pattern was found and being shown it.
 */
export function CandleChart({
  bars,
  highlightDates,
  height = 220,
  width,
}: {
  bars: ChartBar[];
  highlightDates: string[] | null;
  height?: number;
  width: number;
}): React.ReactNode {
  const highlighted = useMemo(() => new Set(highlightDates ?? []), [highlightDates]);

  const geometry = useMemo(() => {
    if (bars.length === 0) return null;

    // The price axis spans the extremes of the wicks, not the closes, so a
    // long shadow is never clipped — a wick cut off at the frame is exactly
    // the information a candlestick chart exists to show.
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (const bar of bars) {
      if (bar.low < low) low = bar.low;
      if (bar.high > high) high = bar.high;
    }
    // A flat series would divide by zero; one rupee of padding keeps it drawn
    // as a line through the middle instead of vanishing.
    const span = high - low === 0 ? 100 : high - low;
    const pad = span * 0.04;

    const top = low - pad;
    const bottom = high + pad;
    const slotWidth = width / bars.length;
    // Candle bodies take two thirds of their slot, leaving a visible gap, and
    // never go below one pixel — at 200 bars on a phone, a body is thinner
    // than its own outline.
    const bodyWidth = Math.max(1, slotWidth * 0.66);

    const y = (price: number): number =>
      height - ((price - top) / (bottom - top)) * height;

    return { y, slotWidth, bodyWidth, low, high };
  }, [bars, width, height]);

  if (geometry === null) {
    return (
      <View style={[styles.empty, { height }]}>
        <Text style={styles.emptyText}>No price history stored for this symbol.</Text>
      </View>
    );
  }

  const { y, slotWidth, bodyWidth } = geometry;
  const first = bars[0];
  const last = bars[bars.length - 1];

  return (
    <View>
      <Svg width={width} height={height}>
        {bars.map((bar, index) => {
          const centre = index * slotWidth + slotWidth / 2;
          const rising = bar.close >= bar.open;
          const mark = highlighted.has(bar.date);
          const stroke = mark ? colors.warn : rising ? colors.gain : colors.loss;

          const bodyTop = y(Math.max(bar.open, bar.close));
          const bodyBottom = y(Math.min(bar.open, bar.close));
          // A doji has no body to draw; one pixel keeps it on the chart as the
          // horizontal line it is.
          const bodyHeight = Math.max(1, bodyBottom - bodyTop);

          return (
            <Fragment key={bar.date}>
              <Line
                x1={centre}
                x2={centre}
                y1={y(bar.high)}
                y2={y(bar.low)}
                stroke={stroke}
                strokeWidth={mark ? 1.5 : 1}
                opacity={mark ? 1 : 0.8}
              />
              <Rect
                x={centre - bodyWidth / 2}
                y={bodyTop}
                width={bodyWidth}
                height={bodyHeight}
                fill={rising ? stroke : 'transparent'}
                stroke={stroke}
                strokeWidth={mark ? 1.5 : 1}
              />
            </Fragment>
          );
        })}
      </Svg>

      <View style={styles.axis}>
        <Text style={styles.axisText}>{shortDate(first?.date)}</Text>
        <Text style={styles.axisText}>
          {rupees(geometry.low)} — {rupees(geometry.high)}
        </Text>
        <Text style={styles.axisText}>{shortDate(last?.date)}</Text>
      </View>

      {highlightDates !== null && highlightDates.length > 0 ? (
        <Text style={styles.highlightNote}>
          {highlightDates.length} bar{highlightDates.length === 1 ? '' : 's'} marked in amber:{' '}
          {highlightDates.map((date) => shortDate(date)).join(', ')}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: colors.textFaint, fontSize: 12 },
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.sm },
  axisText: { color: colors.textFaint, fontSize: 10 },
  highlightNote: {
    color: colors.warn,
    fontSize: 11,
    lineHeight: 16,
    marginTop: space.sm,
  },
});
