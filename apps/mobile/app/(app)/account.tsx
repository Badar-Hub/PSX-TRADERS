import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Badge, Button, Card, Row, SectionTitle } from '@/components/ui';
import { useSession } from '@/lib/session';
import { usePortfolio } from '@/lib/portfolio';
import { API_HOST_LABEL } from '@/lib/config';
import { shortDate } from '@/lib/format';
import { colors, radius, space } from '@/lib/theme';

export default function Account(): React.ReactNode {
  const { account, signOut } = useSession();
  const { portfolios } = usePortfolio();

  if (account === null) return null;
  const isAdmin = account.role === 'ADMIN';

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Card>
        <Text style={styles.name}>{account.name ?? account.email}</Text>
        {account.name !== null ? <Text style={styles.email}>{account.email}</Text> : null}
        <View style={styles.badges}>
          <Badge tone={{ fg: colors.gain, bg: colors.gainDim }}>APPROVED</Badge>
          {isAdmin ? <Badge tone={{ fg: colors.accent, bg: colors.accentDim }}>ADMIN</Badge> : null}
        </View>
      </Card>

      {isAdmin ? (
        <Link href="/admin/users" asChild>
          <Pressable style={({ pressed }) => [styles.linkCard, pressed ? styles.pressed : null]}>
            <View style={styles.linkText}>
              <Text style={styles.linkTitle}>Approval queue</Text>
              <Text style={styles.linkBody}>Let new accounts in, or turn them away</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
          </Pressable>
        </Link>
      ) : null}

      <Card>
        <SectionTitle>Account</SectionTitle>
        <Row label="Email verified" value={shortDate(account.emailVerifiedAt?.slice(0, 10))} />
        <Row label="Approved" value={shortDate(account.approvedAt?.slice(0, 10))} />
        <Row label="Portfolios" value={String(portfolios.length)} />
        <Row label="API" value={API_HOST_LABEL} />
      </Card>

      <Button onPress={() => void signOut()} variant="danger">
        Sign out
      </Button>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { gap: space.md, padding: space.lg, paddingBottom: space.xl * 2 },
  name: { color: colors.text, fontSize: 18, fontWeight: '700' },
  email: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  badges: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  linkCard: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: space.lg,
  },
  pressed: { opacity: 0.7 },
  linkText: { flexShrink: 1 },
  linkTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  linkBody: { color: colors.textFaint, fontSize: 12, marginTop: 2 },
});
