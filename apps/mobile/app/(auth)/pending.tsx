import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AuthScreen } from '@/components/AuthScreen';
import { Banner, Button, Card } from '@/components/ui';
import { useSession } from '@/lib/session';
import { colors, space } from '@/lib/theme';

/**
 * The second gate: verified, waiting on a person.
 *
 * The screen polls `/auth/me` every fifteen seconds from the session provider,
 * so an approval lands without the user doing anything. The manual check is
 * here anyway — someone told "you're approved" over WhatsApp will press a
 * button, and having nothing to press reads as the app being stuck.
 */
export default function Pending(): React.ReactNode {
  const { account, refresh, signOut, error } = useSession();
  const [checking, setChecking] = useState(false);

  const check = async (): Promise<void> => {
    setChecking(true);
    try {
      await refresh();
    } finally {
      setChecking(false);
    }
  };

  return (
    <AuthScreen
      title="Waiting for approval"
      subtitle="Your email is confirmed. An administrator has to approve the account before it can be used."
    >
      {error !== null ? (
        <View style={styles.banner}>
          <Banner kind="warn">{error}</Banner>
        </View>
      ) : null}

      <Card>
        <Text style={styles.email}>{account?.email ?? ''}</Text>
        <Text style={styles.body}>
          You will get an email as soon as the account is approved. This screen checks for itself
          every few seconds, so you can leave it open.
        </Text>
      </Card>

      <View style={styles.actions}>
        <Button onPress={() => void check()} busy={checking} variant="ghost">
          Check now
        </Button>
        <Button onPress={() => void signOut()} variant="ghost">
          Sign out
        </Button>
      </View>
    </AuthScreen>
  );
}

const styles = StyleSheet.create({
  banner: { marginBottom: space.lg },
  email: { color: colors.text, fontSize: 15, fontWeight: '600' },
  body: { color: colors.textMuted, fontSize: 13, lineHeight: 20, marginTop: space.sm },
  actions: { gap: space.sm, marginTop: space.xl },
});
