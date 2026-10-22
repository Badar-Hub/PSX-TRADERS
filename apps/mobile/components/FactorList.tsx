import { Pressable, StyleSheet, Text, View } from 'react-native';
import { categoryLabel } from '@/lib/format';
import { colors, radius, space } from '@/lib/theme';
import type { FactorGuidance, SignalFactor } from '@/lib/types';

/**
 * Why the engine said what it said.
 *
 * This is the answer to "show me the reason behind the prediction", so it does
 * not summarise: every factor that reported is listed with its own score, the
 * weight it carried, what it contributed to the total, and a sentence in
 * English. Expanding a factor that fired on specific bars marks them on the
 * chart above.
 *
 * The bar next to each factor is its contribution, not its score — a strong
 * reading on a lightly weighted factor moved the answer very little, and the
 * chart should show what moved the answer.
 */
export function FactorList({
  factors,
  expandedKey,
  onToggle,
  guidance,
}: {
  factors: SignalFactor[];
  expandedKey: string | null;
  onToggle: (factor: SignalFactor) => void;
  /** Per-indicator reference text, keyed by factor key. */
  guidance?: Record<string, FactorGuidance>;
}): React.ReactNode {
  if (factors.length === 0) {
    return <Text style={styles.none}>No factor reported for this symbol.</Text>;
  }

  // The widest contribution sets the scale, so the bars compare with each
  // other rather than against an arbitrary maximum.
  const widest = Math.max(...factors.map((factor) => Math.abs(factor.contribution)), 1);

  return (
    <View>
      {factors.map((factor) => {
        const expanded = expandedKey === factor.key;
        const positive = factor.contribution > 0;
        const share = Math.abs(factor.contribution) / widest;

        return (
          <Pressable
            key={factor.key}
            onPress={() => onToggle(factor)}
            style={({ pressed }) => [styles.factor, pressed ? styles.pressed : null]}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
          >
            <View style={styles.top}>
              <View style={styles.identity}>
                <Text style={styles.label}>{factor.label}</Text>
                <Text style={styles.category}>
                  {categoryLabel(factor.category)}
                  {factor.barDates.length > 0
                    ? ` · ${factor.barDates.length} bar${factor.barDates.length === 1 ? '' : 's'}`
                    : ''}
                </Text>
              </View>
              <View style={styles.numbers}>
                <Text style={[styles.contribution, { color: positive ? colors.gain : colors.loss }]}>
                  {factor.contribution > 0 ? '+' : factor.contribution < 0 ? '−' : ''}
                  {Math.abs(factor.contribution).toFixed(1)}
                </Text>
                <Text style={styles.weight}>{(factor.weight * 100).toFixed(0)}% weight</Text>
              </View>
            </View>

            {/* Zero sits in the middle: a factor arguing against the call grows
                leftwards, one arguing for it grows rightwards. */}
            <View style={styles.track}>
              <View style={styles.trackHalf}>
                {!positive ? (
                  <View
                    style={[
                      styles.bar,
                      styles.barLeft,
                      { backgroundColor: colors.loss, width: `${share * 100}%` },
                    ]}
                  />
                ) : null}
              </View>
              <View style={styles.zero} />
              <View style={styles.trackHalf}>
                {positive ? (
                  <View
                    style={[
                      styles.bar,
                      { backgroundColor: colors.gain, width: `${share * 100}%` },
                    ]}
                  />
                ) : null}
              </View>
            </View>

            {expanded ? (
              <View style={styles.detail}>
                <Text style={styles.reason}>{factor.reason}</Text>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Reading</Text>
                  <Text style={styles.detailValue}>{factor.display}</Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Score</Text>
                  <Text style={styles.detailValue}>{factor.score.toFixed(1)} of ±100</Text>
                </View>

                {/*
                  What the indicator means and what would change it. Not a
                  recommendation: the reason above is about this stock today,
                  this is about the indicator in general, and nothing in this
                  app has settled long enough to justify telling anyone to act.
                */}
                {guidance?.[factor.key] !== undefined ? (
                  <View style={styles.guide}>
                    <Text style={styles.guideLabel}>How it is read</Text>
                    <Text style={styles.guideText}>{guidance[factor.key]!.reads}</Text>
                    <Text style={styles.guideLabel}>What to watch</Text>
                    <Text style={styles.guideText}>{guidance[factor.key]!.watchFor}</Text>
                    <Text style={[styles.guideLabel, styles.guideWarnLabel]}>
                      Where it misleads
                    </Text>
                    <Text style={[styles.guideText, styles.guideWarn]}>
                      {guidance[factor.key]!.caveat}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  none: { color: colors.textFaint, fontSize: 12 },
  factor: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: space.md,
  },
  pressed: { opacity: 0.7 },
  top: { flexDirection: 'row', justifyContent: 'space-between' },
  identity: { flexShrink: 1, paddingRight: space.sm },
  label: { color: colors.text, fontSize: 14, fontWeight: '500' },
  category: { color: colors.textFaint, fontSize: 11, marginTop: 1 },
  numbers: { alignItems: 'flex-end' },
  contribution: { fontSize: 14, fontWeight: '700' },
  weight: { color: colors.textFaint, fontSize: 10, marginTop: 1 },

  track: { flexDirection: 'row', height: 4, marginTop: space.sm },
  trackHalf: { alignItems: 'flex-start', flex: 1, flexDirection: 'row' },
  barLeft: { marginLeft: 'auto' },
  bar: { borderRadius: 2, height: 4 },
  zero: { backgroundColor: colors.borderStrong, width: 1 },

  detail: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    marginTop: space.md,
    padding: space.md,
  },
  reason: { color: colors.text, fontSize: 13, lineHeight: 20 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.sm },
  detailLabel: { color: colors.textFaint, fontSize: 11 },
  detailValue: { color: colors.textMuted, fontSize: 11, fontWeight: '500' },

  guide: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: space.md,
    paddingTop: space.sm,
  },
  guideLabel: {
    color: colors.textFaint,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginTop: space.sm,
    textTransform: 'uppercase',
  },
  guideText: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 2 },
  guideWarnLabel: { color: colors.warn },
  guideWarn: { color: colors.warn },
});
