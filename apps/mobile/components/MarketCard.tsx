import { StyleSheet, Text, View } from 'react-native';
import { Card, SectionTitle } from '@/components/ui';
import { IndexChart } from '@/components/IndexChart';
import { rupeesCompact, shares } from '@/lib/format';
import { colors, space, toneFor } from '@/lib/theme';
import type { MarketStatus } from '@/lib/types';

/**
 * Where the market is, in points.
 *
 * NOT CURRENTLY RENDERED. The market tab shows a chart of the user's own
 * holdings instead — see HoldingCard — for the same reason the web dashboard
 * does: this card's level is the app's own equal-weighted construction and not
 * the KSE-100, which the exchange's bulk archive does not publish. The owner
 * would rather see nothing than a points figure that could be read as a
 * KSE-100 quote.
 *
 * Kept, not deleted. The moment an index feed is licensed — from PSX directly
 * or through a redistributor — this card, IndexChart and /api/market/status
 * are what it plugs into, and the service and its twelve tests are all still
 * live. Moved out of the screen so the screen reads as what it now renders.
 *
 * The heading says whose index it is, and the median sits beside the mean
 * because when the two part company the index is being carried by a minority
 * of names, which is what stops "market up" being read as "my stocks up".
 */
export function MarketCard({
  status,
  width,
}: {
  status: MarketStatus;
  width: number;
}): React.ReactNode {
  const latest = status.latest;
  if (latest === null) return null;

  const first = status.series[0];
  const windowBps =
    first === undefined || first.level === 0
      ? null
      : Math.round((latest.level / first.level - 1) * 10_000);

  return (
    <Card>
      <SectionTitle hint="This app's own index of liquid PSX shares, not the KSE-100">
        Index
      </SectionTitle>

      <View style={styles.marketHead}>
        <View>
          <Text style={styles.level}>
            {latest.level.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </Text>
          <Text style={[styles.change, { color: toneFor(latest.change) }]}>
            {latest.change > 0 ? '+' : latest.change < 0 ? '−' : ''}
            {Math.abs(latest.change).toFixed(2)} pts (
            {latest.changeBps > 0 ? '+' : latest.changeBps < 0 ? '−' : ''}
            {Math.abs(latest.changeBps / 100).toFixed(2)}%)
          </Text>
        </View>
        <View style={styles.alignRight}>
          <Text style={styles.marketMeta}>
            <Text style={{ color: colors.gain }}>{latest.advances} up</Text> ·{' '}
            <Text style={{ color: colors.loss }}>{latest.declines} down</Text>
          </Text>
          <Text style={[styles.marketMeta, { color: toneFor(latest.medianChangeBps) }]}>
            median {latest.medianChangeBps > 0 ? '+' : latest.medianChangeBps < 0 ? '−' : ''}
            {Math.abs(latest.medianChangeBps / 100).toFixed(2)}%
          </Text>
          <Text style={styles.marketMeta}>{rupeesCompact(latest.tradedValue)} traded</Text>
        </View>
      </View>

      <View style={styles.chart}>
        <IndexChart series={status.series} width={width} />
      </View>

      <Text style={styles.marketFoot}>
        {windowBps === null
          ? ''
          : `${windowBps >= 0 ? 'Up' : 'Down'} ${Math.abs(windowBps / 100).toFixed(1)}% over the window. `}
        {latest.counted} shares met the {shares(status.minVolume)}-share floor. Lower bars are net
        advancing stocks, which tells a broad move from a narrow one.
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  marketHead: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  alignRight: { alignItems: 'flex-end' },
  level: { color: colors.text, fontSize: 26, fontWeight: '700' },
  change: { fontSize: 13, fontWeight: '600', marginTop: 2 },
  marketMeta: { color: colors.textFaint, fontSize: 11, marginTop: 1 },
  chart: { marginTop: space.md },
  marketFoot: { color: colors.textFaint, fontSize: 11, lineHeight: 17, marginTop: space.sm },
});
