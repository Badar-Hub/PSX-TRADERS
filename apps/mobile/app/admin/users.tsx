import { useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { Badge, Banner, Button, Card, Empty, Field, Loading, Row } from '@/components/ui';
import { api } from '@/lib/api';
import { useFetch } from '@/lib/useFetch';
import { shortDate } from '@/lib/format';
import { colors, radius, space } from '@/lib/theme';
import type { AdminUser, AdminUsersResponse, UserStatus } from '@/lib/types';

const FILTERS: Array<{ status: UserStatus; label: string }> = [
  { status: 'PENDING_APPROVAL', label: 'Waiting' },
  { status: 'ACTIVE', label: 'Active' },
  { status: 'PENDING_VERIFICATION', label: 'Unverified' },
  { status: 'REJECTED', label: 'Rejected' },
  { status: 'SUSPENDED', label: 'Suspended' },
];

/**
 * The approval queue.
 *
 * Oldest first, as the API returns it: a queue should be served in the order
 * people joined it. The note box is optional for an approval and worth filling
 * in for a refusal — it is what the rejected account is shown instead of a
 * blank wall, and it is the only record of why six months later.
 */
export default function AdminUsers(): React.ReactNode {
  const [status, setStatus] = useState<UserStatus>('PENDING_APPROVAL');
  const queue = useFetch<AdminUsersResponse>(`/api/admin/users?status=${status}`);
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const decide = async (
    user: AdminUser,
    decision: 'approve' | 'reject' | 'suspend',
  ): Promise<void> => {
    setError(null);
    setActingOn(user.id);
    try {
      const note = notes[user.id]?.trim() ?? '';
      await api(`/api/admin/users/${user.id}/${decision}`, {
        method: 'POST',
        body: note !== '' ? { note } : {},
      });
      setNotes((current) => {
        const { [user.id]: _removed, ...rest } = current;
        return rest;
      });
      queue.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That decision did not go through');
    } finally {
      setActingOn(null);
    }
  };

  const confirm = (user: AdminUser, decision: 'reject' | 'suspend'): void => {
    // Both are visible to the person on the other end — a rejection emails
    // them — so they get a confirmation step. Approval does not: it is the
    // expected outcome and it is reversible by suspending.
    Alert.alert(
      decision === 'reject' ? 'Reject this account?' : 'Suspend this account?',
      decision === 'reject'
        ? `${user.email} will be emailed that the account was not approved.`
        : `${user.email} will lose access immediately.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: decision === 'reject' ? 'Reject' : 'Suspend',
          style: 'destructive',
          onPress: () => void decide(user, decision),
        },
      ],
    );
  };

  const counts = queue.data?.counts ?? {};
  const users = queue.data?.users ?? [];

  return (
    <>
      <Stack.Screen options={{ title: 'Approval queue' }} />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={queue.refreshing}
            onRefresh={queue.reload}
            tintColor={colors.accent}
          />
        }
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filters}>
          <View style={styles.filterRow}>
            {FILTERS.map((filter) => {
              const count = counts[filter.status];
              return (
                <Pressable
                  key={filter.status}
                  onPress={() => setStatus(filter.status)}
                  style={[styles.chip, filter.status === status ? styles.chipActive : null]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      filter.status === status ? styles.chipTextActive : null,
                    ]}
                  >
                    {filter.label}
                    {count !== undefined ? ` ${count}` : ''}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>

        {error !== null ? <Banner kind="error">{error}</Banner> : null}
        {queue.error !== null ? <Banner kind="error">{queue.error}</Banner> : null}

        {queue.loading && queue.data === null ? (
          <Loading what="Loading the queue" />
        ) : users.length === 0 ? (
          <Empty
            title={
              status === 'PENDING_APPROVAL' ? 'Nobody is waiting' : 'No accounts with that status'
            }
            body={
              status === 'PENDING_APPROVAL'
                ? 'New accounts show up here once they have confirmed their email address.'
                : undefined
            }
          />
        ) : (
          users.map((user) => (
            <Card key={user.id}>
              <View style={styles.identity}>
                <View style={styles.identityText}>
                  <Text style={styles.email}>{user.email}</Text>
                  {user.name !== null ? <Text style={styles.name}>{user.name}</Text> : null}
                </View>
                {user.role === 'ADMIN' ? (
                  <Badge tone={{ fg: colors.accent, bg: colors.accentDim }}>ADMIN</Badge>
                ) : null}
              </View>

              <View style={styles.meta}>
                <Row label="Signed up" value={shortDate(user.createdAt.slice(0, 10))} />
                <Row
                  label="Email verified"
                  value={
                    user.emailVerifiedAt !== null
                      ? shortDate(user.emailVerifiedAt.slice(0, 10))
                      : 'not yet'
                  }
                  tone={user.emailVerifiedAt === null ? colors.warn : undefined}
                />
                {user.approvedAt !== null ? (
                  <Row label="Approved" value={shortDate(user.approvedAt.slice(0, 10))} />
                ) : null}
                {user.decidedBy !== null ? <Row label="Decided by" value={user.decidedBy} /> : null}
              </View>

              {user.decisionNote !== null && user.decisionNote !== '' ? (
                <Text style={styles.existingNote}>“{user.decisionNote}”</Text>
              ) : null}

              {user.status === 'PENDING_APPROVAL' || user.status === 'ACTIVE' ? (
                <View style={styles.actions}>
                  <Field
                    label="Note"
                    value={notes[user.id] ?? ''}
                    onChangeText={(text) =>
                      setNotes((current) => ({ ...current, [user.id]: text }))
                    }
                    placeholder={
                      user.status === 'ACTIVE' ? 'Why suspend?' : 'Optional, shown if rejected'
                    }
                  />
                  {user.status === 'PENDING_APPROVAL' ? (
                    <>
                      <Button
                        onPress={() => void decide(user, 'approve')}
                        busy={actingOn === user.id}
                      >
                        Approve
                      </Button>
                      <Button onPress={() => confirm(user, 'reject')} variant="danger">
                        Reject
                      </Button>
                    </>
                  ) : (
                    <Button onPress={() => confirm(user, 'suspend')} variant="danger">
                      Suspend
                    </Button>
                  )}
                </View>
              ) : (
                <Text style={styles.terminal}>
                  {user.status === 'PENDING_VERIFICATION'
                    ? 'Cannot be approved until the email address is confirmed.'
                    : `Status: ${user.status.toLowerCase()}.`}
                </Text>
              )}
            </Card>
          ))
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { gap: space.md, padding: space.lg, paddingBottom: space.xl * 2 },
  filters: { flexGrow: 0 },
  filterRow: { flexDirection: 'row', gap: space.sm },
  chip: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: 6,
  },
  chipActive: { backgroundColor: colors.accentDim, borderColor: colors.accent },
  chipText: { color: colors.textMuted, fontSize: 13 },
  chipTextActive: { color: colors.accent, fontWeight: '600' },

  identity: { flexDirection: 'row', justifyContent: 'space-between' },
  identityText: { flexShrink: 1 },
  email: { color: colors.text, fontSize: 15, fontWeight: '600' },
  name: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
  meta: { marginTop: space.sm },
  existingNote: {
    color: colors.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
    lineHeight: 18,
    marginTop: space.sm,
  },
  actions: { gap: space.sm, marginTop: space.md },
  terminal: { color: colors.textFaint, fontSize: 12, lineHeight: 18, marginTop: space.sm },
});
