import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { AuthScreen } from '@/components/AuthScreen';
import { Banner, Button, Field } from '@/components/ui';
import { useSession } from '@/lib/session';
import { colors, space } from '@/lib/theme';

export default function SignIn(): React.ReactNode {
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await signIn({ email: email.trim(), password });
      // No navigation here. The gate in the root layout reads the account's
      // status and routes accordingly — signing in successfully may still land
      // on "enter your code" or "waiting for approval", and this screen has no
      // business deciding which.
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthScreen title="Sign in" subtitle="Your portfolio, P&L and predictions.">
      {error !== null ? (
        <View style={styles.banner}>
          <Banner kind="error">{error}</Banner>
        </View>
      ) : null}

      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        inputMode="email"
        placeholder="you@example.com"
        textContentType="emailAddress"
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="current-password"
        textContentType="password"
        onSubmitEditing={() => void submit()}
        returnKeyType="go"
      />

      <Button onPress={() => void submit()} busy={busy} disabled={email === '' || password === ''}>
        Sign in
      </Button>

      <View style={styles.switch}>
        <Text style={styles.switchText}>No account yet?</Text>
        <Link href="/(auth)/sign-up" asChild>
          <Pressable accessibilityRole="link">
            <Text style={styles.switchLink}>Create one</Text>
          </Pressable>
        </Link>
      </View>
    </AuthScreen>
  );
}

const styles = StyleSheet.create({
  banner: { marginBottom: space.lg },
  switch: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.xs,
    justifyContent: 'center',
    marginTop: space.lg,
  },
  switchText: { color: colors.textMuted, fontSize: 13 },
  switchLink: { color: colors.accent, fontSize: 13, fontWeight: '600' },
});
