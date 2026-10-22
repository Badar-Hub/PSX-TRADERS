import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, space } from '@/lib/theme';
import { API_HOST_LABEL } from '@/lib/config';

/**
 * The frame every onboarding screen sits in.
 *
 * It also prints the API address at the bottom. That looks like debug clutter,
 * and on a shipped build it would be — but during development the single most
 * common failure is the phone talking to the wrong machine, and a line of grey
 * text turns ten minutes of confusion into a glance.
 */
export function AuthScreen({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}): ReactNode {
  const insets = useSafeAreaInsets();

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.xl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.brand}>PSX Trader</Text>
          <Text style={styles.title}>{title}</Text>
          {subtitle !== undefined ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>

        {children}

        {footer !== undefined ? <View style={styles.footer}>{footer}</View> : null}

        <Text style={styles.host}>API {API_HOST_LABEL}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: space.xl },
  header: { marginBottom: space.xl },
  brand: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  title: { color: colors.text, fontSize: 24, fontWeight: '700', marginTop: space.sm },
  subtitle: { color: colors.textMuted, fontSize: 14, lineHeight: 20, marginTop: space.sm },
  footer: { marginTop: space.xl },
  host: {
    color: colors.textFaint,
    fontSize: 11,
    marginTop: space.xl,
    textAlign: 'center',
  },
});
