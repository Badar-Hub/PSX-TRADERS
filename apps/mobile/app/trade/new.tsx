import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Banner, Button, Card, Field, SectionTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { usePortfolio } from '@/lib/portfolio';
import { colors, radius, space } from '@/lib/theme';
import type { Trade } from '@/lib/types';

/**
 * Record a trade.
 *
 * The price is sent as a string, never a JSON number. "170.19" parsed as a
 * float is 170.18999999999999, and every rounding back to paisa after that is
 * a guess; as a string the API parses it into exact integer paisa. The same
 * reason the ledger is integers all the way down is the reason this one field
 * is not a number input.
 *
 * Charges are left to the server unless the user fills them in. The default is
 * computed from the portfolio's brokerage schedule; typing the figures off a
 * contract note instead is what makes the portfolio reconcile with the broker
 * to the paisa.
 */
/**
 * Today, where the phone is.
 *
 * Not `toISOString().slice(0, 10)`, which is the date in UTC: Pakistan is five
 * hours ahead, so for the first five hours of every trading day that would
 * default the form to yesterday — and a trade dated a day early lands in the
 * wrong tax year at the turn of July.
 */
function todayLocal(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export default function NewTrade(): React.ReactNode {
  const router = useRouter();
  const { active } = usePortfolio();

  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [symbol, setSymbol] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [tradedOn, setTradedOn] = useState(todayLocal);
  const [note, setNote] = useState('');
  const [brokerage, setBrokerage] = useState('');
  const [showCharges, setShowCharges] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dateLooksWrong = !/^\d{4}-\d{2}-\d{2}$/.test(tradedOn);
  const quantityLooksWrong = quantity !== '' && !/^\d+$/.test(quantity);
  const priceLooksWrong = unitPrice !== '' && !/^\d+(\.\d{1,2})?$/.test(unitPrice);

  const ready =
    active !== null &&
    symbol.trim() !== '' &&
    quantity !== '' &&
    unitPrice !== '' &&
    !dateLooksWrong &&
    !quantityLooksWrong &&
    !priceLooksWrong;

  const submit = async (): Promise<void> => {
    if (!ready || active === null) return;
    setError(null);
    setBusy(true);
    try {
      await api<{ trade: Trade }>(`/api/portfolios/${active.id}/trades`, {
        method: 'POST',
        body: {
          symbol: symbol.trim().toUpperCase(),
          side,
          tradedOn,
          quantity: Number(quantity),
          unitPrice,
          ...(note.trim() !== '' ? { note: note.trim() } : {}),
          ...(brokerage.trim() !== '' ? { charges: { brokerage: brokerage.trim() } } : {}),
        },
      });
      // Pushed from the portfolio tab there is somewhere to go back to; opened
      // from a link or a notification there is not, and `back()` would leave
      // the user looking at the form they just submitted.
      if (router.canGoBack()) router.back();
      else router.replace('/(app)/positions');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not record the trade');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Record a trade', presentation: 'modal' }} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {error !== null ? <Banner kind="error">{error}</Banner> : null}

          <Card>
            <View style={styles.sides}>
              {(['BUY', 'SELL'] as const).map((option) => (
                <Pressable
                  key={option}
                  onPress={() => setSide(option)}
                  style={[
                    styles.side,
                    option === side
                      ? option === 'BUY'
                        ? styles.sideBuy
                        : styles.sideSell
                      : null,
                  ]}
                >
                  <Text
                    style={[
                      styles.sideText,
                      option === side
                        ? { color: option === 'BUY' ? colors.gain : colors.loss }
                        : null,
                    ]}
                  >
                    {option === 'BUY' ? 'Buy' : 'Sell'}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Field
              label="Symbol"
              value={symbol}
              onChangeText={setSymbol}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="e.g. LUCK"
            />
            <Field
              label="Shares"
              value={quantity}
              onChangeText={setQuantity}
              keyboardType="number-pad"
              inputMode="numeric"
              placeholder="100"
              error={quantityLooksWrong ? 'Whole shares only.' : null}
            />
            <Field
              label="Price per share"
              value={unitPrice}
              onChangeText={setUnitPrice}
              keyboardType="decimal-pad"
              inputMode="decimal"
              placeholder="170.19"
              hint="In rupees, up to two decimal places."
              error={priceLooksWrong ? 'Rupees and paisa, like 170.19.' : null}
            />
            <Field
              label="Traded on"
              value={tradedOn}
              onChangeText={setTradedOn}
              placeholder="2026-10-22"
              autoCorrect={false}
              error={dateLooksWrong ? 'Use YYYY-MM-DD.' : null}
            />
          </Card>

          <Card>
            <Pressable onPress={() => setShowCharges((shown) => !shown)}>
              <SectionTitle hint="Leave blank and the brokerage schedule is used">
                Charges from the contract note
              </SectionTitle>
            </Pressable>
            {showCharges ? (
              <Field
                label="Brokerage"
                value={brokerage}
                onChangeText={setBrokerage}
                keyboardType="decimal-pad"
                inputMode="decimal"
                placeholder="e.g. 25.50"
                hint="Only override this if you are copying a figure off the note."
              />
            ) : (
              <Text style={styles.collapsed}>Tap to enter the exact figures.</Text>
            )}
            <Field
              label="Note"
              value={note}
              onChangeText={setNote}
              placeholder="Optional"
              multiline
            />
          </Card>

          <Button onPress={() => void submit()} busy={busy} disabled={!ready}>
            {side === 'BUY' ? 'Record the buy' : 'Record the sell'}
          </Button>
          <Text style={styles.ledgerNote}>
            Trades are never edited or deleted — a mistake is cancelled by a reversing entry, so
            the history always shows what actually happened.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { backgroundColor: colors.bg, flex: 1 },
  content: { gap: space.md, padding: space.lg, paddingBottom: space.xl * 2 },
  sides: { flexDirection: 'row', gap: space.sm, marginBottom: space.lg },
  side: {
    backgroundColor: colors.bg,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    paddingVertical: space.md,
  },
  sideBuy: { backgroundColor: colors.gainDim, borderColor: colors.gain },
  sideSell: { backgroundColor: colors.lossDim, borderColor: colors.loss },
  sideText: { color: colors.textMuted, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  collapsed: { color: colors.textFaint, fontSize: 12, marginBottom: space.lg },
  ledgerNote: { color: colors.textFaint, fontSize: 11, lineHeight: 17, textAlign: 'center' },
});
