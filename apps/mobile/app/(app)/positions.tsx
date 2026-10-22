import { useMemo } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Link, Stack } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Badge, Banner, Card, Empty, Loading, Stat } from '@/components/ui';
import { usePortfolio } from '@/lib/portfolio';
import { useFetch } from '@/lib/useFetch';
import { actionLabel, percentFromBps, rupees, shares, signedRupees } from '@/lib/format';
import { actionTone, colors, radius, space, toneFor } from '@/lib/theme';
import type { PortfolioSummary, Position, Signal } from '@/lib/types';

export default function Positions(): React.ReactNode {
  const { active, portfolios, select, loading: loadingPortfolios } = usePortfolio();

  const summary = useFetch<PortfolioSummary>(
    active !== null ? `/api/portfolios/${active.id}/positions` : null,
  );
  const swing = useFetch<{ signals: Array<{ symbol: string; signal: Signal | null }> }>(
    active !== null ? `/api/portfolios/${active.id}/signals?horizon=SWING` : null,
  );

  // Signals arrive as a list keyed by symbol; the positions list needs them by
  // symbol, so index once here rather than scanning per row.
  const signalBySymbol = useMemo(() => {
    const map = new Map<string, Signal>();
    for (const entry of swing.data?.signals ?? []) {
      if (entry.signal !== null) map.set(entry.symbol, entry.signal);
    }
    return map;
  }, [swing.data]);

  if (loadingPortfolios || (summary.loading && summary.data === null)) {
    return <Loading what="Loading your portfolio" />;
  }

  if (active === null) {
    return (
      <Empty
        title="No portfolio yet"
        body="A portfolio is created with your account. If you are seeing this, try pulling to refresh."
      />
    );
  }

  const data = summary.data;

  return (
    <>
      <Stack.Screen
        options={{
          // `headerTitle`, not `title`: this screen belongs to the tab
          // navigator, and `title` would rename the tab in the bar as well —
          // the portfolio's name has no business being the tab's label.
          headerTitle: active.name,
          headerRight: () => (
            <Link href="/trade/new" asChild>
              <Pressable accessibilityLabel="Record a trade" style={styles.headerButton}>
                <Ionicons name="add" size={26} color={colors.accent} />
              </Pressable>
            </Link>
          ),
        }}
      />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={summary.refreshing}
            onRefresh={() => {
              summary.reload();
              swing.reload();
            }}
            tintColor={colors.accent}
          />
        }
      >
        {summary.error !== null ? <Banner kind="error">{summary.error}</Banner> : null}

        {portfolios.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.switcher}>
            <View style={styles.switcherRow}>
              {portfolios.map((portfolio) => (
                <Pressable
                  key={portfolio.id}
                  onPress={() => select(portfolio.id)}
                  style={[styles.chip, portfolio.id === active.id ? styles.chipActive : null]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      portfolio.id === active.id ? styles.chipTextActive : null,
                    ]}
                  >
                    {portfolio.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        ) : null}

        {data !== null ? (
          <>
            <Card>
              <View style={styles.stats}>
                <Stat label="Market value" value={rupees(data.marketValue)} />
                <Stat label="Invested" value={rupees(data.investedCost)} />
                <Stat
                  label="Unrealised"
                  value={signedRupees(data.unrealisedPnl)}
                  tone={toneFor(data.unrealisedPnl)}
                />
                <Stat
                  label="Realised"
                  value={signedRupees(data.realisedPnl)}
                  tone={toneFor(data.realisedPnl)}
                />
              </View>

              {data.hasMissingPrices ? (
                <Text style={styles.caveat}>
                  Some holdings have no recent close, so the market value excludes them. It is not a
                  total of everything you hold.
                </Text>
              ) : null}
              {data.isPaperTrading ? (
                <View style={styles.paper}>
                  <Badge tone={{ fg: colors.warn, bg: colors.warnDim }}>PAPER TRADING</Badge>
                </View>
              ) : null}
            </Card>

            {data.positions.length === 0 ? (
              <Empty
                title="Nothing held yet"
                body="Record a buy with the + button and it will show up here."
              />
            ) : (
              data.positions.map((position) => (
                <PositionCard
                  key={position.symbol}
                  position={position}
                  signal={signalBySymbol.get(position.symbol) ?? null}
                />
              ))
            )}
          </>
        ) : null}
      </ScrollView>
    </>
  );
}

function PositionCard({
  position,
  signal,
}: {
  position: Position;
  signal: Signal | null;
}): React.ReactNode {
  const tone = signal !== null ? actionTone(signal.action) : null;

  return (
    <Link href={`/signal/${position.symbol}`} asChild>
      <Pressable style={({ pressed }) => [styles.position, pressed ? styles.pressed : null]}>
        <View style={styles.positionTop}>
          <View style={styles.positionIdentity}>
            <Text style={styles.symbol}>{position.symbol}</Text>
            <Text style={styles.name} numberOfLines={1}>
              {position.name}
            </Text>
          </View>
          {tone !== null && signal !== null ? (
            <Badge tone={tone}>{actionLabel(signal.action)}</Badge>
          ) : null}
        </View>

        <View style={styles.positionFigures}>
          <View>
            <Text style={styles.figureLabel}>
              {shares(position.quantity)} @ {rupees(position.averageCost)}
            </Text>
            <Text style={styles.figureValue}>{rupees(position.marketValue)}</Text>
          </View>
          <View style={styles.alignRight}>
            <Text style={[styles.figureValue, { color: toneFor(position.unrealisedPnl) }]}>
              {signedRupees(position.unrealisedPnl)}
            </Text>
            <Text style={[styles.figureLabel, { color: toneFor(position.unrealisedPnlBps) }]}>
              {percentFromBps(position.unrealisedPnlBps)}
            </Text>
          </View>
        </View>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  content: { gap: space.md, padding: space.lg, paddingBottom: space.xl * 2 },
  headerButton: { paddingHorizontal: space.sm },

  switcher: { flexGrow: 0 },
  switcherRow: { flexDirection: 'row', gap: space.sm },
  chip: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: 6,
  },
  chipActive: { backgroundColor: colors.accentDim, borderColor: colors.accent },
  chipText: { color: colors.textMuted, fontSize: 13 },
  chipTextActive: { color: colors.accent, fontWeight: '600' },

  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg },
  caveat: { color: colors.warn, fontSize: 12, lineHeight: 18, marginTop: space.lg },
  paper: { marginTop: space.md },

  position: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg,
  },
  pressed: { opacity: 0.7 },
  positionTop: { alignItems: 'flex-start', flexDirection: 'row', justifyContent: 'space-between' },
  positionIdentity: { flexShrink: 1, paddingRight: space.sm },
  symbol: { color: colors.text, fontSize: 16, fontWeight: '700' },
  name: { color: colors.textFaint, fontSize: 12, marginTop: 1 },
  positionFigures: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.md,
  },
  alignRight: { alignItems: 'flex-end' },
  figureLabel: { color: colors.textFaint, fontSize: 12 },
  figureValue: { color: colors.text, fontSize: 15, fontWeight: '600', marginTop: 2 },
});
