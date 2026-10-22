import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import type { ReactNode } from 'react';
import { colors, radius, space, type Tone } from '@/lib/theme';

/** The building blocks every screen uses. Kept in one file so the look of the
 * app is decided in one place rather than drifting screen by screen. */

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}): ReactNode {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }): ReactNode {
  return (
    <View style={styles.sectionTitle}>
      <Text style={styles.sectionTitleText}>{children}</Text>
      {hint !== undefined ? <Text style={styles.sectionHint}>{hint}</Text> : null}
    </View>
  );
}

export function Label({ children }: { children: string }): ReactNode {
  return <Text style={styles.label}>{children}</Text>;
}

export function Field({
  label,
  hint,
  error,
  ...props
}: TextInputProps & { label: string; hint?: string; error?: string | null }): ReactNode {
  return (
    <View style={styles.field}>
      <Label>{label}</Label>
      <TextInput
        placeholderTextColor={colors.textFaint}
        {...props}
        style={[styles.input, error != null ? styles.inputError : null, props.style]}
      />
      {error != null ? (
        <Text style={styles.fieldError}>{error}</Text>
      ) : hint !== undefined ? (
        <Text style={styles.fieldHint}>{hint}</Text>
      ) : null}
    </View>
  );
}

export function Button({
  children,
  onPress,
  variant = 'primary',
  busy = false,
  disabled = false,
}: {
  children: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  busy?: boolean;
  disabled?: boolean;
}): ReactNode {
  const inactive = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy }}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' ? styles.buttonPrimary : null,
        variant === 'ghost' ? styles.buttonGhost : null,
        variant === 'danger' ? styles.buttonDanger : null,
        pressed ? styles.buttonPressed : null,
        inactive ? styles.buttonDisabled : null,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={variant === 'primary' ? colors.bg : colors.text} size="small" />
      ) : (
        <Text
          style={[
            styles.buttonText,
            variant === 'primary' ? styles.buttonTextPrimary : null,
            variant === 'danger' ? styles.buttonTextDanger : null,
          ]}
        >
          {children}
        </Text>
      )}
    </Pressable>
  );
}

export function Badge({ tone, children }: { tone: Tone; children: string }): ReactNode {
  return (
    <View style={[styles.badge, { backgroundColor: tone.bg }]}>
      <Text style={[styles.badgeText, { color: tone.fg }]}>{children}</Text>
    </View>
  );
}

/** A labelled figure. The unit of the whole app's numeric display. */
export function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: string;
  hint?: string;
}): ReactNode {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, tone !== undefined ? { color: tone } : null]}>{value}</Text>
      {hint !== undefined ? <Text style={styles.statHint}>{hint}</Text> : null}
    </View>
  );
}

export function Banner({
  kind,
  children,
}: {
  kind: 'info' | 'warn' | 'error';
  children: ReactNode;
}): ReactNode {
  const tone =
    kind === 'error'
      ? { bg: colors.lossDim, fg: colors.loss }
      : kind === 'warn'
        ? { bg: colors.warnDim, fg: colors.warn }
        : { bg: colors.accentDim, fg: colors.accent };

  return (
    <View style={[styles.banner, { backgroundColor: tone.bg }]}>
      {typeof children === 'string' ? (
        <Text style={[styles.bannerText, { color: tone.fg }]}>{children}</Text>
      ) : (
        children
      )}
    </View>
  );
}

export function Loading({ what }: { what?: string }): ReactNode {
  return (
    <View style={styles.centred}>
      <ActivityIndicator color={colors.accent} />
      {what !== undefined ? <Text style={styles.centredText}>{what}</Text> : null}
    </View>
  );
}

export function Empty({ title, body }: { title: string; body?: string }): ReactNode {
  return (
    <View style={styles.centred}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {body !== undefined ? <Text style={styles.centredText}>{body}</Text> : null}
    </View>
  );
}

/** A labelled value in a row, for detail lists. */
export function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}): ReactNode {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, tone !== undefined ? { color: tone } : null]}>{value}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: space.lg,
  },
  sectionTitle: { marginBottom: space.sm },
  sectionTitleText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  sectionHint: { color: colors.textFaint, fontSize: 12, marginTop: 2 },

  label: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: space.xs,
  },
  field: { marginBottom: space.lg },
  input: {
    backgroundColor: colors.bg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: space.md,
    paddingVertical: 12,
  },
  inputError: { borderColor: colors.loss },
  fieldHint: { color: colors.textFaint, fontSize: 12, marginTop: space.xs },
  fieldError: { color: colors.loss, fontSize: 12, marginTop: space.xs },

  button: {
    alignItems: 'center',
    borderRadius: radius.md,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: space.lg,
  },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonGhost: {
    backgroundColor: 'transparent',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  buttonDanger: { backgroundColor: colors.lossDim },
  buttonPressed: { opacity: 0.7 },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  buttonTextPrimary: { color: colors.bg },
  buttonTextDanger: { color: colors.loss },

  badge: {
    alignSelf: 'flex-start',
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  badgeText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },

  stat: { flexGrow: 1, flexBasis: '45%' },
  statLabel: { color: colors.textFaint, fontSize: 11 },
  statValue: { color: colors.text, fontSize: 18, fontWeight: '600', marginTop: 2 },
  statHint: { color: colors.textFaint, fontSize: 11, marginTop: 1 },

  banner: { borderRadius: radius.md, padding: space.md },
  bannerText: { fontSize: 13, lineHeight: 19 },

  centred: { alignItems: 'center', gap: space.sm, padding: space.xl },
  centredText: { color: colors.textMuted, fontSize: 13, textAlign: 'center' },
  emptyTitle: { color: colors.text, fontSize: 15, fontWeight: '600', textAlign: 'center' },

  row: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 7,
  },
  rowLabel: { color: colors.textMuted, fontSize: 13 },
  rowValue: { color: colors.text, fontSize: 13, fontWeight: '500' },
});
