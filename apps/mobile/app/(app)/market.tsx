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
import { HoldingCard } from '@/components/HoldingCard';
import { usePortfolio } from '@/lib/portfolio';
import { useFetch } from '@/lib/useFetch';
import { percent, shares, shortDate } from '@/lib/format';
import { colors, space } from '@/lib/theme';
import type { AccuracyReport, Coverage, PortfolioSummary } from '@/lib/types';

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
  const { active } = usePortfolio();
  const positions = useFetch<PortfolioSummary>(
    active !== null ? `/api/portfolios/${active.id}/positions` : null,
  );
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
            positions.reload();
            coverage.reload();
            accuracy.reload();
          }}
          tintColor={colors.accent}
        />
      }
    >
      {coverage.error !== null ? <Banner kind="error">{coverage.error}</Banner> : null}

      {/*
        Holdings first: on a phone this screen is what gets opened to answer
        "how are my stocks doing", and that should not be below a search box.
      */}
      {positions.data != null ? (
        <HoldingCard
          positions={positions.data.positions}
          width={width - space.lg * 2 - space.lg * 2}
        />
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

const styles = StyleSheet.create({
  content: { gap: space.md, padding: space.lg, paddingBottom: space.xl * 2 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg },
  detail: { color: colors.textFaint, fontSize: 12, lineHeight: 18, marginTop: space.sm },
  accuracy: { marginTop: space.sm },
  note: { color: colors.textFaint, fontSize: 11, lineHeight: 17, marginTop: space.md },
});
