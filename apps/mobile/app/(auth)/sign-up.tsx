import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { AuthScreen } from '@/components/AuthScreen';
import { Banner, Button, Field } from '@/components/ui';
import { useSession } from '@/lib/session';
import { colors, space } from '@/lib/theme';

/** The API's own floor. Checked here too so the user is told before the round
 * trip, not after it. */
const MIN_PASSWORD = 10;

export default function SignUp(): React.ReactNode {
  const { signUp } = useSession();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = password !== '' && password.length < MIN_PASSWORD;

  const submit = async (): Promise<void> => {
    if (tooShort) return;
    setError(null);
    setBusy(true);
    try {
      const trimmed = name.trim();
      await signUp({
        email: email.trim(),
        password,
        ...(trimmed !== '' ? { name: trimmed } : {}),
      });
      // The gate routes to the verify screen. A warning about the email having
      // failed to send is surfaced there, next to the resend button that fixes
      // it, rather than here on a screen that is about to disappear.
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the account');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthScreen
      title="Create an account"
      subtitle="We email you a code to confirm the address, then an administrator approves the account before it can be used."
    >
      {error !== null ? (
        <View style={styles.banner}>
          <Banner kind="error">{error}</Banner>
        </View>
      ) : null}

      <Field
        label="Name"
        value={name}
        onChangeText={setName}
        placeholder="Optional"
        autoComplete="name"
        textContentType="name"
      />
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
        autoComplete="new-password"
        textContentType="newPassword"
        hint={`At least ${MIN_PASSWORD} characters.`}
        error={tooShort ? `${MIN_PASSWORD} characters or more, please.` : null}
      />

      <Button
        onPress={() => void submit()}
        busy={busy}
        disabled={email === '' || password.length < MIN_PASSWORD}
      >
        Create account
      </Button>

      <View style={styles.switch}>
        <Text style={styles.switchText}>Already have one?</Text>
        <Link href="/(auth)/sign-in" asChild>
          <Pressable accessibilityRole="link">
            <Text style={styles.switchLink}>Sign in</Text>
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
