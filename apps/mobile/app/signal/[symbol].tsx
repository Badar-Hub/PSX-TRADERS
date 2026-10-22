import { useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Badge, Banner, Card, Loading, Row, SectionTitle } from '@/components/ui';
import { CandleChart } from '@/components/CandleChart';
import { FactorList } from '@/components/FactorList';
import { useFetch } from '@/lib/useFetch';
import { actionLabel, categoryLabel, percent, rupees, shortDate } from '@/lib/format';
import { actionTone, colors, radius, space, toneFor } from '@/lib/theme';
import type { ChartBar, Signal, SignalFactor, SignalResponse } from '@/lib/types';

type Horizon = 'SWING' | 'LONG_TERM';

/**
 * The prediction, and the reasoning behind it.
 *
 * The score and the explanation come from the same code on the server: the
 * factors listed here are the ones that were summed to produce the number, not
 * a commentary written separately about it. That is why nothing on this screen
 * is computed locally — if the app worked out its own total, the two could
 * disagree and the explanation would stop being an explanation.
 */
export default function SignalScreen(): React.ReactNode {
  const { symbol: raw } = useLocalSearchParams<{ symbol: string }>();
  const symbol = (raw ?? '').toUpperCase();
  const [horizon, setHorizon] = useState<Horizon>('SWING');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string[] | null>(null);
  const { width } = useWindowDimensions();

  const signal = useFetch<SignalResponse>(
    symbol !== '' ? `/api/securities/${symbol}/signal?horizon=${horizon}` : null,
  );
  const bars = useFetch<{ symbol: string; name: string; bars: ChartBar[] }>(
    symbol !== '' ? `/api/securities/${symbol}/bars?limit=180` : null,
  );

  const onToggleFactor = (factor: SignalFactor): void => {
    const next = expandedKey === factor.key ? null : factor.key;
    setExpandedKey(next);
    setHighlight(next === null || factor.barDates.length === 0 ? null : factor.barDates);
  };

  const data = signal.data ?? null;
  const prediction = data?.signal ?? null;

  const sorted = useMemo(
    () =>
      prediction === null
        ? []
        : [...prediction.factors].sort(
            (a, b) => Math.abs(b.contribution) - Math.abs(a.contribution),
          ),
    [prediction],
  );

  // The chart is as wide as the card it sits in: screen, less the screen's
  // padding, less the card's own.
  const chartWidth = width - space.lg * 2 - space.lg * 2;

  return (
    <>
      <Stack.Screen options={{ title: symbol }} />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={signal.refreshing}
            onRefresh={() => {
              signal.reload();
              bars.reload();
            }}
            tintColor={colors.accent}
          />
        }
      >
        <View style={styles.horizons}>
          {(['SWING', 'LONG_TERM'] as const).map((option) => (
            <Pressable
              key={option}
              onPress={() => {
                setHorizon(option);
                setExpandedKey(null);
                setHighlight(null);
              }}
              style={[styles.horizon, option === horizon ? styles.horizonActive : null]}
            >
              <Text
                style={[styles.horizonText, option === horizon ? styles.horizonTextActive : null]}
              >
                {option === 'SWING' ? 'Swing' : 'Long term'}
              </Text>
            </Pressable>
          ))}
        </View>

        {signal.error !== null ? <Banner kind="error">{signal.error}</Banner> : null}

        {signal.loading && data === null ? <Loading what="Scoring the factors" /> : null}

        {/*
          A refusal is a legitimate answer, not an error. The engine declines
          when the history is too short or too stale to score honestly, and
          saying so is more useful than a confident HOLD built on nothing.
        */}
        {data?.refusal !== undefined ? (
          <Card>
            <SectionTitle>No prediction for {symbol}</SectionTitle>
            <Text style={styles.refusal}>{data.refusal.reason}</Text>
          </Card>
        ) : null}

        {prediction !== null ? (
          <>
            <Card>
              <View style={styles.verdict}>
                <View>
                  <Badge tone={actionTone(prediction.action)}>
                    {actionLabel(prediction.action)}
                  </Badge>
                  <Text style={styles.security}>{prediction.securityName}</Text>
                </View>
                <View style={styles.alignRight}>
                  <Text style={[styles.score, { color: toneFor(prediction.score) }]}>
                    {prediction.score > 0 ? '+' : prediction.score < 0 ? '−' : ''}
                    {Math.abs(prediction.score).toFixed(0)}
                  </Text>
                  <Text style={styles.scoreLabel}>of ±100</Text>
                </View>
              </View>

              <View style={styles.meta}>
                <Row label="Confidence" value={percent(prediction.confidence, 0)} />
                <Row label="Price at signal" value={rupees(prediction.priceAtSignal)} />
                <Row label="As of" value={shortDate(prediction.asOf)} />
                {prediction.missingFactors > 0 ? (
                  <Row
                    label="Factors unavailable"
                    value={String(prediction.missingFactors)}
                    tone={colors.warn}
                  />
                ) : null}
              </View>

              {prediction.missingFactors > 0 ? (
                <Text style={styles.caveat}>
                  {prediction.missingFactors} factor
                  {prediction.missingFactors === 1 ? '' : 's'} could not be computed, so the
                  remaining weights were scaled up to fill the gap. The confidence above already
                  accounts for it.
                </Text>
              ) : null}

              {data?.source === 'computed' ? (
                <Text style={styles.caveat}>
                  Computed just now from stored prices — this symbol had no overnight prediction.
                </Text>
              ) : null}
            </Card>

            {prediction.narrative !== null ? (
              <Card>
                <SectionTitle hint="Written from the factors below">In short</SectionTitle>
                <Text style={styles.narrative}>{prediction.narrative}</Text>
                {/*
                  Who wrote this. A reader deciding what to do with their money
                  is entitled to know whether a language model produced the
                  explanation, and the factor table is authoritative either way.
                */}
                <Text style={styles.attribution}>
                  {prediction.narrativeModel === null
                    ? 'Written by the app itself from the factors below, with no language model involved.'
                    : `Written by ${prediction.narrativeModel} from the factors below. The factors are the source; this is a rendering of them.`}
                </Text>
              </Card>
            ) : null}

            <Card>
              <SectionTitle hint="Tap a factor for the detail; amber bars are where it fired">
                Price history
              </SectionTitle>
              {bars.loading && bars.data === null ? (
                <Loading />
              ) : (
                <CandleChart
                  bars={bars.data?.bars ?? []}
                  highlightDates={highlight}
                  width={chartWidth}
                />
              )}
            </Card>

            <Card>
              <SectionTitle hint="Sorted by how much each moved the answer">
                Why this call
              </SectionTitle>
              <FactorList
                factors={sorted}
                expandedKey={expandedKey}
                onToggle={onToggleFactor}
              />
            </Card>

            {prediction.byCategory.length > 0 ? (
              <Card>
                <SectionTitle>By category</SectionTitle>
                {prediction.byCategory.map((entry) => (
                  <Row
                    key={entry.category}
                    label={categoryLabel(entry.category)}
                    value={`${entry.contribution > 0 ? '+' : entry.contribution < 0 ? '−' : ''}${Math.abs(entry.contribution).toFixed(1)}`}
                    tone={toneFor(entry.contribution)}
                  />
                ))}
              </Card>
            ) : null}

            <Text style={styles.footer}>
              Engine {prediction.engineVersion}. A factor score is a reading of the data, not a
              forecast of a price, and nothing here is advice.
            </Text>
          </>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { gap: space.md, padding: space.lg, paddingBottom: space.xl * 2 },
  horizons: { flexDirection: 'row', gap: space.sm },
  horizon: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    paddingVertical: space.sm,
  },
  horizonActive: { backgroundColor: colors.accentDim, borderColor: colors.accent },
  horizonText: { color: colors.textMuted, fontSize: 13, textAlign: 'center' },
  horizonTextActive: { color: colors.accent, fontWeight: '600' },

  verdict: { flexDirection: 'row', justifyContent: 'space-between' },
  security: { color: colors.textMuted, fontSize: 13, marginTop: space.sm },
  alignRight: { alignItems: 'flex-end' },
  score: { fontSize: 32, fontWeight: '700' },
  scoreLabel: { color: colors.textFaint, fontSize: 11 },
  meta: { marginTop: space.md },
  caveat: { color: colors.warn, fontSize: 11, lineHeight: 17, marginTop: space.md },
  narrative: { color: colors.text, fontSize: 14, lineHeight: 22 },
  attribution: { color: colors.textFaint, fontSize: 11, lineHeight: 17, marginTop: space.sm },
  refusal: { color: colors.textMuted, fontSize: 13, lineHeight: 20 },
  footer: {
    color: colors.textFaint,
    fontSize: 11,
    lineHeight: 17,
    marginTop: space.sm,
    textAlign: 'center',
  },
});
