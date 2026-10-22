import { StyleSheet, Text } from 'react-native';
import { AuthScreen } from '@/components/AuthScreen';
import { Button, Card } from '@/components/ui';
import { useSession } from '@/lib/session';
import { colors, space } from '@/lib/theme';

/**
 * Rejected or suspended.
 *
 * The administrator's note is shown when there is one. A refusal with no
 * reason invites the user to try again, assume a bug, and sign up a second
 * time; a reason ends the matter. There is no retry button, because there is
 * nothing the user can do from here.
 */
export default function Blocked(): React.ReactNode {
  const { account, signOut } = useSession();
  const suspended = account?.status === 'SUSPENDED';
  const note = account?.decisionNote ?? null;

  return (
    <AuthScreen
      title={suspended ? 'Account suspended' : 'Account not approved'}
      subtitle={
        suspended
          ? 'This account has been suspended, so it cannot be used for now.'
          : 'An administrator did not approve this account.'
      }
    >
      {note !== null && note !== '' ? (
        <Card>
          <Text style={styles.noteLabel}>Reason given</Text>
          <Text style={styles.note}>{note}</Text>
        </Card>
      ) : null}

      <Text style={styles.contact}>
        If you think this is a mistake, speak to whoever administers this app.
      </Text>

      <Button onPress={() => void signOut()} variant="ghost">
        Sign out
      </Button>
    </AuthScreen>
  );
}

const styles = StyleSheet.create({
  noteLabel: {
    color: colors.textFaint,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  note: { color: colors.text, fontSize: 14, lineHeight: 21, marginTop: space.sm },
  contact: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 20,
    marginTop: space.lg,
    marginBottom: space.xl,
  },
});
