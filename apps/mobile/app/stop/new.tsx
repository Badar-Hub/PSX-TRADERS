import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Banner, Button, Card, Field, SectionTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { usePortfolio } from '@/lib/portfolio';
import { rupees } from '@/lib/format';
import { colors, radius, space } from '@/lib/theme';
import type { StopRule, StopSuggestion } from '@/lib/types';

type StopType = 'TRAILING_STOP' | 'STOP_LOSS' | 'TAKE_PROFIT';

const TYPES: Array<{ value: StopType; label: string; blurb: string }> = [
  {
    value: 'TRAILING_STOP',
    label: 'Trailing stop',
    blurb:
      'Follows the price up and never down, so a run is locked in as it happens. Set the trail ' +
      'as a percentage below the high.',
  },
  {
    value: 'STOP_LOSS',
    label: 'Stop-loss',
    blurb:
      'A fixed level below the price. It does not move, so it protects a decision you made once.',
  },
  {
    value: 'TAKE_PROFIT',
    label: 'Target',
    blurb: 'A fixed level above the price, to say when a position has reached what you wanted.',
  },
];

/**
 * Arm a stop.
 *
 * The trail is entered as a percentage because that is how people say it, and
 * converted to basis points before it is sent so the API never receives a
 * fraction to round.
 *
 * The suggestion is the part worth having on a phone. A round ten percent is
 * noise on a volatile small cap and a disaster on a utility, and nobody can
 * tell which they are holding from a price — so the screen offers a width
 * measured from the symbol's own range, and says what it measured.
 */
export default function NewStop(): React.ReactNode {
  const router = useRouter();
  const { active } = usePortfolio();
  const params = useLocalSearchParams<{ symbol?: string }>();

  const [type, setType] = useState<StopType>('TRAILING_STOP');
  const [symbol, setSymbol] = useState((params.symbol ?? '').toUpperCase());
  const [trailPercent, setTrailPercent] = useState('10');
  const [thresholdPrice, setThresholdPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [suggestion, setSuggestion] = useState<StopSuggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  const trailing = type === 'TRAILING_STOP';

  const trailLooksWrong = trailing && !/^\d+(\.\d{1,2})?$/.test(trailPercent);
  const trailBps = trailLooksWrong ? null : Math.round(Number(trailPercent) * 100);
  const trailOutOfBand = trailBps !== null && (trailBps < 100 || trailBps > 5_000);
  const levelLooksWrong = !trailing && !/^\d+(\.\d{1,2})?$/.test(thresholdPrice);
  const quantityLooksWrong = quantity !== '' && !/^\d+$/.test(quantity);

  const ready =
    active !== null &&
    symbol.trim() !== '' &&
    !quantityLooksWrong &&
    (trailing ? !trailLooksWrong && !trailOutOfBand : !levelLooksWrong);

  const suggest = async (): Promise<void> => {
    const ticker = symbol.trim().toUpperCase();
    if (ticker === '') return;
    setSuggesting(true);
    setSuggestError(null);
    try {
      const response = await api<{ suggestion: StopSuggestion }>(
        `/api/securities/${ticker}/stop-suggestion`,
      );
      setSuggestion(response.suggestion);
    } catch (caught) {
      setSuggestion(null);
      setSuggestError(
        caught instanceof Error ? caught.message : 'Could not measure that symbol',
      );
    } finally {
      setSuggesting(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (!ready || active === null) return;
    setError(null);
    setBusy(true);
    try {
      await api<{ rule: StopRule }>(`/api/portfolios/${active.id}/stops`, {
        method: 'POST',
        body: {
          symbol: symbol.trim().toUpperCase(),
          type,
          ...(trailing ? { trailBps } : { thresholdPrice }),
          ...(quantity !== '' ? { quantity: Number(quantity) } : {}),
          ...(note.trim() !== '' ? { note: note.trim() } : {}),
        },
      });
      // Pushed from the stops tab there is somewhere to go back to; opened from
      // a link there is not, and back() would leave the form on screen.
      if (router.canGoBack()) router.back();
      else router.replace('/(app)/stops');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not arm the rule');
    } finally {
      setBusy(false);
    }
  };

  const chosen = TYPES.find((option) => option.value === type)!;

  return (
    <>
      <Stack.Screen options={{ title: 'Watch a symbol', presentation: 'modal' }} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {error !== null ? <Banner kind="error">{error}</Banner> : null}

          <Card>
            <View style={styles.types}>
              {TYPES.map((option) => (
                <Pressable
                  key={option.value}
                  onPress={() => setType(option.value)}
                  style={[styles.type, option.value === type ? styles.typeActive : null]}
                >
                  <Text
                    style={[
                      styles.typeText,
                      option.value === type ? styles.typeTextActive : null,
                    ]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.blurb}>{chosen.blurb}</Text>

            <Field
              label="Symbol"
              value={symbol}
              onChangeText={(text) => {
                setSymbol(text.toUpperCase());
                setSuggestion(null);
              }}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="e.g. LUCK"
            />

            {trailing ? (
              <>
                <Field
                  label="Trail, % below the high"
                  value={trailPercent}
                  onChangeText={setTrailPercent}
                  keyboardType="decimal-pad"
                  inputMode="decimal"
                  placeholder="10"
                  hint="The stop starts one trail below the latest close and only moves up."
                  error={
                    trailLooksWrong
                      ? 'A percentage like 10 or 7.5.'
                      : trailOutOfBand
                        ? 'Between 1% and 50%. Below 1% the stop sits inside the daily noise; above 50% it is not protecting anything.'
                        : null
                  }
                />

                <View style={styles.advice}>
                  <View style={styles.adviceHead}>
                    <Text style={styles.adviceLabel}>Size it to the stock</Text>
                    <Button
                      onPress={() => void suggest()}
                      variant="ghost"
                      busy={suggesting}
                      disabled={symbol.trim() === ''}
                    >
                      Measure
                    </Button>
                  </View>

                  {suggestError !== null ? (
                    <Text style={styles.adviceWarn}>{suggestError}</Text>
                  ) : suggestion === null ? (
                    <Text style={styles.adviceBody}>
                      Measures how much {symbol.trim() === '' ? 'the symbol' : symbol} actually
                      moves and suggests a trail from that, rather than a round number.
                    </Text>
                  ) : (
                    <>
                      <Text style={styles.adviceBody}>{suggestion.reason}</Text>
                      {suggestion.trailBps !== null ? (
                        <View style={styles.adoptRow}>
                          <Text style={styles.adoptText}>
                            {(suggestion.trailBps / 100).toFixed(1)}% · stop at{' '}
                            {rupees(suggestion.suggestedStop)}
                          </Text>
                          <Button
                            onPress={() =>
                              setTrailPercent((suggestion.trailBps! / 100).toFixed(1))
                            }
                            variant="ghost"
                          >
                            Use it
                          </Button>
                        </View>
                      ) : null}
                    </>
                  )}
                </View>
              </>
            ) : (
              <Field
                label="Level"
                value={thresholdPrice}
                onChangeText={setThresholdPrice}
                keyboardType="decimal-pad"
                inputMode="decimal"
                placeholder="170.19"
                hint={
                  type === 'STOP_LOSS'
                    ? 'Below the current price, or it would fire at once.'
                    : 'Above the current price, or it would fire at once.'
                }
                error={levelLooksWrong && thresholdPrice !== '' ? 'Rupees and paisa, like 170.19.' : null}
              />
            )}
          </Card>

          <Card>
            <SectionTitle hint="Only used to show what is at risk">Shares</SectionTitle>
            <Field
              label="Shares"
              value={quantity}
              onChangeText={setQuantity}
              keyboardType="number-pad"
              inputMode="numeric"
              placeholder="All held"
              error={quantityLooksWrong ? 'Whole shares only.' : null}
            />
            <Field
              label="Note"
              value={note}
              onChangeText={setNote}
              placeholder="Optional"
              multiline
            />
          </Card>

          <Button onPress={() => void submit()} busy={busy} disabled={!ready}>
            Start watching
          </Button>
          <Text style={styles.footer}>
            An alert, not an order. Nothing is placed with your broker — when the level breaks the
            app tells you, and the decision is yours.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { backgroundColor: colors.bg, flex: 1 },
  content: { gap: space.md, padding: space.lg, paddingBottom: space.xl * 2 },

  types: { gap: space.sm },
  type: {
    backgroundColor: colors.bg,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: space.md,
  },
  typeActive: { backgroundColor: colors.accentDim, borderColor: colors.accent },
  typeText: { color: colors.textMuted, fontSize: 15, textAlign: 'center' },
  typeTextActive: { color: colors.accent, fontWeight: '600' },
  blurb: {
    color: colors.textFaint,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: space.lg,
    marginTop: space.sm,
  },

  advice: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: space.md,
  },
  adviceHead: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  adviceLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  adviceBody: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: space.sm },
  adviceWarn: { color: colors.warn, fontSize: 12, lineHeight: 18, marginTop: space.sm },
  adoptRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.sm,
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  adoptText: { color: colors.text, flexShrink: 1, fontSize: 12 },

  footer: { color: colors.textFaint, fontSize: 11, lineHeight: 17, textAlign: 'center' },
});
