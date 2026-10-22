import { useState } from 'react';
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Banner, Button, Card, Field, Loading, Row, SectionTitle, Stat } from '@/components/ui';
import { IndexChart } from '@/components/IndexChart';
import { useFetch } from '@/lib/useFetch';
import { percent, rupeesCompact, shares, shortDate } from '@/lib/format';
import { colors, space, toneFor } from '@/lib/theme';
import type { AccuracyReport, Coverage, MarketStatus } from '@/lib/types';

/**
 * What the engine is working from, and how it has been doing.
 *
 * The hit rate is on the same screen as the predictions' data coverage on
 * purpose: a prediction is only as good as the history behind it, and both
 * numbers answer "should I trust this" rather than "what should I buy".
 */
export default function Market(): React.ReactNode {
  const router = useRouter();
  const [symbol, setSymbol] = useState('');

  const { width } = useWindowDimensions();
  const status = useFetch<MarketStatus>('/api/market/status?days=120');
  const coverage = useFetch<{ coverage: Coverage }>('/api/market/coverage');
  const accuracy = useFetch<{ accuracy: AccuracyReport[]; note: string }>(
    '/api/signals/stats/accuracy',
  );

  const look = (): void => {
    const trimmed = symbol.trim().toUpperCase();
    if (trimmed === '') return;
    router.push(`/signal/${trimmed}`);
    setSymbol('');
  };

  if (coverage.loading && coverage.data === null) return <Loading what="Loading market data" />;

  const data = coverage.data?.coverage ?? null;
  const reports = accuracy.data?.accuracy ?? [];

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={coverage.refreshing}
          onRefresh={() => {
            status.reload();
            coverage.reload();
            accuracy.reload();
          }}
          tintColor={colors.accent}
        />
      }
    >
      {coverage.error !== null ? <Banner kind="error">{coverage.error}</Banner> : null}

      {/*
        The market first: on a phone this screen is what gets opened to answer
        "what's the market doing", and that should not be below a search box.
      */}
      {status.data?.latest != null ? (
        <MarketCard status={status.data} width={width - space.lg * 2 - space.lg * 2} />
      ) : null}

      <Card>
        <SectionTitle hint="Any PSX ticker, held or not">Look up a prediction</SectionTitle>
        <Field
          label="Symbol"
          value={symbol}
          onChangeText={setSymbol}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="e.g. LUCK"
          onSubmitEditing={look}
          returnKeyType="search"
        />
        <Button onPress={look} disabled={symbol.trim() === ''}>
          Show the reasoning
        </Button>
      </Card>

      {data !== null ? (
        <Card>
          <SectionTitle hint="What the engine has to work from">Price history</SectionTitle>
          <View style={styles.stats}>
            <Stat label="Trading days" value={shares(data.tradingDaysStored)} />
            <Stat label="Securities" value={shares(data.securities)} />
            <Stat label="Daily bars" value={shares(data.barRows)} />
            <Stat label="Latest close" value={shortDate(data.lastDay)} />
          </View>
          <Text style={styles.detail}>
            From {shortDate(data.firstDay)} to {shortDate(data.lastDay)}.
            {data.missingDays.length > 0
              ? ` ${data.missingDays.length} trading day${data.missingDays.length === 1 ? '' : 's'} missing from the series.`
              : ' No gaps in the series.'}
          </Text>
        </Card>
      ) : null}

      <Card>
        <SectionTitle>How the predictions have done</SectionTitle>
        {reports.length === 0 ? (
          <Text style={styles.detail}>
            Nothing has settled yet. A prediction is only scored once its horizon has fully elapsed,
            so this stays empty for a while rather than showing an early number that would be
            mostly noise.
          </Text>
        ) : (
          reports.map((report) => (
            <View key={`${report.horizon}-${report.engineVersion}`} style={styles.accuracy}>
              <Row
                label={report.horizon === 'SWING' ? 'Swing' : 'Long term'}
                value={report.hitRate !== null ? percent(report.hitRate, 1) : 'not enough settled'}
              />
              <Text style={styles.detail}>
                {report.settled} settled · {report.hits} right · {report.misses} wrong ·{' '}
                {report.neutral} neutral · engine {report.engineVersion}
              </Text>
            </View>
          ))
        )}
        {accuracy.data?.note !== undefined ? (
          <Text style={styles.note}>{accuracy.data.note}</Text>
        ) : null}
      </Card>
    </ScrollView>
  );
}

/**
 * Where the market is, in points.
 *
 * The heading says whose index this is. PSX's bulk archive publishes no
 * KSE-100 level, so a number that looked like a KSE-100 quote and was not one
 * would be the most misleading thing on the screen — and the median beside the
 * mean is what stops "market up" being read as "my stocks up".
 */
function MarketCard({ status, width }: { status: MarketStatus; width: number }): React.ReactNode {
  const latest = status.latest;
  if (latest === null) return null;

  const first = status.series[0];
  const windowBps =
    first === undefined || first.level === 0
      ? null
      : Math.round((latest.level / first.level - 1) * 10_000);

  return (
    <Card>
      {/* "Index", not "Market": the screen header already says Market, and two
          of the same word stacked reads like a rendering bug. */}
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
  content: { gap: space.md, padding: space.lg, paddingBottom: space.xl * 2 },
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
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg },
  detail: { color: colors.textFaint, fontSize: 12, lineHeight: 18, marginTop: space.sm },
  accuracy: { marginTop: space.sm },
  note: { color: colors.textFaint, fontSize: 11, lineHeight: 17, marginTop: space.md },
});
