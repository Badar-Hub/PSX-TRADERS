import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Card, Loading, SectionTitle } from '@/components/ui';
import { CandleChart } from '@/components/CandleChart';
import { useFetch } from '@/lib/useFetch';
import { percentFromBps, rupees, shares, shortDate } from '@/lib/format';
import { colors, radius, space, toneFor } from '@/lib/theme';
import type { ChartBar, Position } from '@/lib/types';

/**
 * A price chart for one of the user's holdings, with a picker.
 *
 * The same swap the dashboard made: this replaced an index card whose level
 * was the app's own equal-weighted construction rather than the KSE-100. For
 * the holdings there is real stored OHLCV, and it is what the owner is
 * actually exposed to.
 *
 * Defaults to the largest holding by market value. The selection is component
 * state rather than a route parameter, unlike the web, because this card is
 * one part of a scrolling screen rather than the page itself — putting it in
 * the URL would mean a navigation on every tap and would scroll the screen
 * back to the top.
 */
export function HoldingCard({
  positions,
  width,
}: {
  positions: Position[];
  width: number;
}): React.ReactNode {
  const held = useMemo(
    () =>
      positions
        .filter((position) => position.quantity > 0)
        // Largest first, falling back to cost where no price is stored, so a
        // holding without a recent close still orders sensibly.
        .sort((a, b) => (b.marketValue ?? b.costBasis) - (a.marketValue ?? a.costBasis)),
    [positions],
  );

  const [chosen, setChosen] = useState<string | null>(null);
  // Validated against the list rather than trusted: a symbol can leave the
  // portfolio while this screen is open.
  const selected = held.find((position) => position.symbol === chosen) ?? held[0] ?? null;

  const history = useFetch<{ symbol: string; name: string; bars: ChartBar[] }>(
    selected === null ? null : `/api/securities/${selected.symbol}/bars?limit=120`,
  );

  if (held.length === 0) {
    return (
      <Card>
        <SectionTitle hint="Record a buy and it will be charted here">Your holdings</SectionTitle>
        <Text style={styles.empty}>Nothing held yet.</Text>
      </Card>
    );
  }

  if (selected === null) return null;

  const bars = history.data?.bars ?? [];
  const first = bars[0];
  const last = bars[bars.length - 1];
  const periodBps =
    first === undefined || last === undefined || first.close === 0
      ? null
      : Math.round((last.close / first.close - 1) * 10_000);

  return (
    <Card>
      <View style={styles.head}>
        <View style={styles.identity}>
          <Text style={styles.symbol}>{selected.symbol}</Text>
          <Text style={styles.name} numberOfLines={1}>
            {history.data?.name ?? selected.name}
          </Text>
          <Text style={styles.position}>
            {shares(selected.quantity)} shares · {rupees(selected.marketValue)}
          </Text>
        </View>
        <View style={styles.alignRight}>
          <Text style={styles.price}>{rupees(selected.marketPrice)}</Text>
          {selected.unrealisedPnlBps !== null ? (
            <Text style={[styles.change, { color: toneFor(selected.unrealisedPnl) }]}>
              {percentFromBps(selected.unrealisedPnlBps)} unrealised
            </Text>
          ) : null}
          {periodBps !== null ? (
            <Text style={[styles.change, { color: toneFor(periodBps) }]}>
              {percentFromBps(periodBps)} over {bars.length}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Chips, wrapped rather than scrolled, so no holding is hidden behind a
          gesture the user has to discover. */}
      {held.length > 1 ? (
        <View style={styles.chips}>
          {held.map((position) => (
            <Pressable
              key={position.symbol}
              onPress={() => setChosen(position.symbol)}
              style={[
                styles.chip,
                position.symbol === selected.symbol ? styles.chipActive : null,
              ]}
            >
              <Text
                style={[
                  styles.chipText,
                  position.symbol === selected.symbol ? styles.chipTextActive : null,
                ]}
              >
                {position.symbol}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={styles.chart}>
        {history.loading && history.data === null ? (
          <Loading />
        ) : bars.length === 0 ? (
          <Text style={styles.empty}>
            No stored price history for {selected.symbol}. Run the ingest to fill it.
          </Text>
        ) : (
          <CandleChart bars={bars} highlightDates={null} width={width} height={180} />
        )}
      </View>

      {first !== undefined && last !== undefined ? (
        <Text style={styles.foot}>
          {shortDate(first.date)} to {shortDate(last.date)}, from the closes the exchange
          published.
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between' },
  identity: { flexShrink: 1, paddingRight: space.sm },
  symbol: { color: colors.text, fontSize: 18, fontWeight: '700' },
  name: { color: colors.textFaint, fontSize: 12, marginTop: 1 },
  position: { color: colors.textMuted, fontSize: 12, marginTop: space.xs },
  alignRight: { alignItems: 'flex-end' },
  price: { color: colors.text, fontSize: 18, fontWeight: '600' },
  change: { fontSize: 11, marginTop: 1 },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  chip: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: 5,
  },
  chipActive: { backgroundColor: colors.accentDim, borderColor: colors.accent },
  chipText: { color: colors.textMuted, fontSize: 12 },
  chipTextActive: { color: colors.accent, fontWeight: '600' },

  chart: { marginTop: space.md },
  empty: { color: colors.textFaint, fontSize: 12, lineHeight: 18, marginTop: space.sm },
  foot: { color: colors.textFaint, fontSize: 11, lineHeight: 17, marginTop: space.sm },
});
