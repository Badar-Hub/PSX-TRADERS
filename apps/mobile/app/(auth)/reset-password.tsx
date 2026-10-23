import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AuthScreen } from '@/components/AuthScreen';
import { Banner, Button, Field } from '@/components/ui';
import { useSession } from '@/lib/session';
import { colors, space } from '@/lib/theme';

/**
 * The gate for an account created with a generated password.
 *
 * Not advisory. The API refuses every other route while the flag is set, so
 * this screen is the only thing the account can reach — and the root layout
 * routes here on RESET_PASSWORD rather than this screen deciding anything.
 */
export default function ResetPassword(): React.ReactNode {
  const { account, changePassword, signOut } = useSession();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setError(null);

    if (newPassword.length < 10) {
      setError('The new password must be at least 10 characters.');
      return;
    }
    // Checked here rather than at the API, which has no business knowing the
    // screen asked twice.
    if (newPassword !== confirmPassword) {
      setError('The two new passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      await changePassword({ currentPassword, newPassword });
      // No navigation. The root layout reads the account again and routes on
      // the step the API reports, which is now READY.
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not change the password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthScreen
      title="Choose a password"
      subtitle="This account was created for you with a temporary password. Pick one of your own before going any further."
    >
      {error !== null ? (
        <View style={styles.banner}>
          <Banner kind="error">{error}</Banner>
        </View>
      ) : null}

      <Text style={styles.email}>{account?.email ?? ''}</Text>

      <Field
        label="Temporary password"
        value={currentPassword}
        onChangeText={setCurrentPassword}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="current-password"
        textContentType="password"
      />
      <Field
        label="New password"
        value={newPassword}
        onChangeText={setNewPassword}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="new-password"
        textContentType="newPassword"
      />
      <Field
        label="New password again"
        value={confirmPassword}
        onChangeText={setConfirmPassword}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="new-password"
        textContentType="newPassword"
      />

      <Text style={styles.hint}>
        At least 10 characters. Length is the only rule — a long phrase beats a short one with
        symbols in it. Saving signs out every other session.
      </Text>

      <Button onPress={() => void submit()} busy={busy}>
        Set new password
      </Button>

      <View style={styles.actions}>
        <Button onPress={() => void signOut()} variant="ghost">
          Sign out
        </Button>
      </View>
    </AuthScreen>
  );
}

const styles = StyleSheet.create({
  banner: { marginBottom: space.md },
  email: { color: colors.textMuted, fontSize: 13, marginBottom: space.md },
  hint: { color: colors.textFaint, fontSize: 11, lineHeight: 17, marginBottom: space.md },
  actions: { marginTop: space.md },
});
