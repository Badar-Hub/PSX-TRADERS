import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Path, Rect } from 'react-native-svg';
import { colors, space } from '@/lib/theme';
import { shortDate } from '@/lib/format';
import type { MarketDay } from '@/lib/types';

/**
 * The market index as a line, with net breadth underneath.
 *
 * Drawn in SVG by hand for the same reason the candlestick chart is:
 * lightweight-charts, which the dashboard uses, has no React Native build, and
 * a WebView to draw one polyline costs more than the arithmetic.
 *
 * A line, not candles: the level is derived from a day of closes, so it has no
 * open, high or low of its own and drawing candles would invent three prices
 * out of one. The bars below are net advancing stocks, which is what separates
 * a broad rise from a narrow one — the index alone cannot say which it is.
 */
export function IndexChart({
  series,
  width,
  height = 160,
}: {
  series: MarketDay[];
  width: number;
  height?: number;
}): React.ReactNode {
  const geometry = useMemo(() => {
    if (series.length < 2) return null;

    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    let widestBreadth = 1;
    for (const day of series) {
      if (day.level < low) low = day.level;
      if (day.level > high) high = day.level;
      const net = Math.abs(day.advances - day.declines);
      if (net > widestBreadth) widestBreadth = net;
    }

    const span = high - low === 0 ? 1 : high - low;
    const pad = span * 0.08;
    const top = high + pad;
    const bottom = low - pad;

    // The breadth bars get the bottom fifth, so they give context without
    // competing with the line for the eye.
    const lineHeight = height * 0.78;
    const breadthTop = height * 0.84;
    const breadthHeight = height - breadthTop;

    const x = (index: number): number => (index / (series.length - 1)) * width;
    const y = (level: number): number =>
      lineHeight - ((level - bottom) / (top - bottom)) * lineHeight;

    const path = series
      .map((day, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(day.level).toFixed(1)}`)
      .join(' ');

    return { x, y, path, low, high, lineHeight, breadthTop, breadthHeight, widestBreadth };
  }, [series, width, height]);

  if (geometry === null) {
    return (
      <View style={[styles.empty, { height }]}>
        <Text style={styles.emptyText}>Not enough stored sessions to chart yet.</Text>
      </View>
    );
  }

  const first = series[0]!;
  const last = series[series.length - 1]!;
  const rising = last.level >= first.level;
  const stroke = rising ? colors.gain : colors.loss;

  // Closing the line path down to the axis and filling it reads as an area
  // chart without needing a second path definition.
  const fill = `${geometry.path} L${width.toFixed(1)},${geometry.lineHeight.toFixed(1)} L0,${geometry.lineHeight.toFixed(1)} Z`;

  return (
    <View>
      <Svg width={width} height={height}>
        {/* Where the window began, so a glance says above or below. */}
        <Line
          x1={0}
          x2={width}
          y1={geometry.y(first.level)}
          y2={geometry.y(first.level)}
          stroke={colors.borderStrong}
          strokeWidth={1}
          strokeDasharray="3,3"
        />

        <Path d={fill} fill={rising ? colors.gainDim : colors.lossDim} />
        <Path d={geometry.path} stroke={stroke} strokeWidth={2} fill="none" />

        {series.map((day, index) => {
          const net = day.advances - day.declines;
          const barHeight = (Math.abs(net) / geometry.widestBreadth) * geometry.breadthHeight;
          const slot = width / series.length;
          return (
            <Rect
              key={day.date}
              x={geometry.x(index) - slot / 2}
              y={geometry.breadthTop + (geometry.breadthHeight - barHeight)}
              width={Math.max(0.6, slot * 0.7)}
              height={Math.max(0.6, barHeight)}
              fill={net >= 0 ? colors.gainDim : colors.lossDim}
            />
          );
        })}
      </Svg>

      <View style={styles.axis}>
        <Text style={styles.axisText}>{shortDate(first.date)}</Text>
        <Text style={styles.axisText}>
          {geometry.low.toLocaleString('en-US', { maximumFractionDigits: 0 })} —{' '}
          {geometry.high.toLocaleString('en-US', { maximumFractionDigits: 0 })}
        </Text>
        <Text style={styles.axisText}>{shortDate(last.date)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: colors.textFaint, fontSize: 12 },
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.sm },
  axisText: { color: colors.textFaint, fontSize: 10 },
});
