import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Link, Stack } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Badge, Banner, Button, Card, Empty, Loading, Row, SectionTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { usePortfolio } from '@/lib/portfolio';
import { useFetch } from '@/lib/useFetch';
import { percentFromBps, rupees, shares, shortDate } from '@/lib/format';
import { colors, radius, space } from '@/lib/theme';
import type { PortfolioSummary, StopEvaluation, StopRule } from '@/lib/types';

/**
 * Stops and targets.
 *
 * Leads with what has fired, because a triggered stop is the only thing in this
 * app the user may need to act on today — and on a phone, which is where they
 * will see it first, that has to be the top of the screen rather than something
 * to scroll for.
 *
 * Armed rules follow, sorted by how little headroom is left. These are alerts:
 * nothing is placed with a broker, so a trigger is a prompt rather than a sale,
 * and the screen says so.
 */
export default function Stops(): React.ReactNode {
  const { active, loading: loadingPortfolios } = usePortfolio();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stops = useFetch<{ rules: StopRule[]; counts: Record<string, number> }>(
    active !== null ? `/api/portfolios/${active.id}/stops` : null,
  );
  const positions = useFetch<PortfolioSummary>(
    active !== null ? `/api/portfolios/${active.id}/positions` : null,
  );

  const rules = stops.data?.rules ?? [];

  const armed = useMemo(
    () =>
      rules
        .filter((rule) => rule.status === 'ARMED')
        .sort(
          (a, b) =>
            (a.headroomBps ?? Number.MAX_SAFE_INTEGER) -
            (b.headroomBps ?? Number.MAX_SAFE_INTEGER),
        ),
    [rules],
  );
  const fired = useMemo(
    () =>
      rules.filter(
        (rule) =>
          rule.status === 'TRIGGERED' &&
          rule.events.some((event) => event.acknowledgedAt === null),
      ),
    [rules],
  );
  const seen = useMemo(
    () => rules.filter((rule) => rule.status === 'TRIGGERED' && !fired.includes(rule)),
    [rules, fired],
  );

  /** Holdings with no armed protective rule, which is the gap worth naming. */
  const unprotected = useMemo(
    () =>
      (positions.data?.positions ?? []).filter(
        (position) =>
          position.quantity > 0 &&
          !armed.some(
            (rule) =>
              rule.symbol === position.symbol &&
              (rule.type === 'STOP_LOSS' || rule.type === 'TRAILING_STOP'),
          ),
      ),
    [positions.data, armed],
  );

  const reload = (): void => {
    stops.reload();
    positions.reload();
  };

  const check = async (): Promise<void> => {
    if (active === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { summary } = await api<{ summary: StopEvaluation }>(
        `/api/portfolios/${active.id}/stops/evaluate`,
        { method: 'POST', body: {} },
      );
      const parts = [`${summary.rulesChecked} checked`];
      if (summary.triggered > 0) parts.push(`${summary.triggered} triggered`);
      if (summary.moved > 0) parts.push(`${summary.moved} trailed up`);
      if (summary.expired > 0) parts.push(`${summary.expired} expired`);
      setNotice(
        summary.triggered === 0 && summary.moved === 0
          ? `${parts.join(', ')}. Nothing has been breached.`
          : `${parts.join(', ')}.`,
      );
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not check the rules');
    } finally {
      setBusy(false);
    }
  };

  const acknowledge = async (eventId: string): Promise<void> => {
    try {
      await api(`/api/stop-events/${eventId}/acknowledge`, { method: 'POST', body: {} });
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not mark that as seen');
    }
  };

  const cancel = async (ruleId: string, symbol: string): Promise<void> => {
    try {
      await api(`/api/stops/${ruleId}/cancel`, { method: 'POST', body: {} });
      setNotice(`Stopped watching ${symbol}. The rule is kept as history.`);
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not stop watching');
    }
  };

  if (loadingPortfolios || (stops.loading && stops.data === null)) {
    return <Loading what="Loading your stops" />;
  }
  if (active === null) return <Empty title="No portfolio yet" />;

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/stop/new" asChild>
              <Pressable accessibilityLabel="Watch a symbol" style={styles.headerButton}>
                <Ionicons name="add" size={26} color={colors.accent} />
              </Pressable>
            </Link>
          ),
        }}
      />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={stops.refreshing} onRefresh={reload} tintColor={colors.accent} />
        }
      >
        {stops.error !== null ? <Banner kind="error">{stops.error}</Banner> : null}
        {error !== null ? <Banner kind="error">{error}</Banner> : null}
        {notice !== null ? <Banner kind="info">{notice}</Banner> : null}

        <Text style={styles.preamble}>
          Checked against each new close. These are alerts, not orders — nothing is placed with
          your broker, so a trigger is a prompt to act rather than a sale.
        </Text>

        <Button onPress={() => void check()} variant="ghost" busy={busy}>
          Check now
        </Button>

        {fired.length > 0 ? (
          <>
            <SectionTitle>
              {`${fired.length} stop${fired.length === 1 ? '' : 's'} fired`}
            </SectionTitle>
            {fired.map((rule) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                onAcknowledge={(eventId) => void acknowledge(eventId)}
                onCancel={() => void cancel(rule.id, rule.symbol)}
              />
            ))}
          </>
        ) : null}

        <SectionTitle hint={armed.length > 1 ? 'Closest to firing first' : undefined}>
          {`Armed${armed.length > 0 ? ` (${armed.length})` : ''}`}
        </SectionTitle>

        {armed.length === 0 ? (
          <Card>
            <Text style={styles.emptyTitle}>Nothing is being watched.</Text>
            <Text style={styles.emptyBody}>
              A stop is the one decision easiest to make calmly in advance and hardest to make
              while a position is falling. Add one with the + button.
            </Text>
          </Card>
        ) : (
          armed.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              onAcknowledge={(eventId) => void acknowledge(eventId)}
              onCancel={() => void cancel(rule.id, rule.symbol)}
            />
          ))
        )}

        {unprotected.length > 0 ? (
          <Card>
            <SectionTitle hint="Not a recommendation — some people hold without stops deliberately">
              Held with no stop
            </SectionTitle>
            {unprotected.map((position) => (
              <Row
                key={position.symbol}
                label={position.symbol}
                value={`${shares(position.quantity)} · ${rupees(position.marketValue)}`}
              />
            ))}
          </Card>
        ) : null}

        {seen.length > 0 ? (
          <>
            <SectionTitle>Already seen</SectionTitle>
            {seen.map((rule) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                onAcknowledge={(eventId) => void acknowledge(eventId)}
                onCancel={() => void cancel(rule.id, rule.symbol)}
              />
            ))}
          </>
        ) : null}
      </ScrollView>
    </>
  );
}

function labelFor(type: string): string {
  if (type === 'STOP_LOSS') return 'stop-loss';
  if (type === 'TRAILING_STOP') return 'trailing stop';
  if (type === 'TAKE_PROFIT') return 'target';
  return type.toLowerCase().replace('_', ' ');
}

function triggerLabel(triggerOn: string): string {
  if (triggerOn === 'CLOSE') return 'on the close';
  if (triggerOn === 'INTRADAY_LOW') return "on the day's low";
  return "on the day's high";
}

function RuleCard({
  rule,
  onAcknowledge,
  onCancel,
}: {
  rule: StopRule;
  onAcknowledge: (eventId: string) => void;
  onCancel: () => void;
}): React.ReactNode {
  const level = rule.type === 'TRAILING_STOP' ? rule.effectiveStop : rule.thresholdPrice;
  const armed = rule.status === 'ARMED';
  const event = rule.events[0];

  // Under 3% a stop is about to go, which is worth saying in amber rather than
  // leaving the user to compare two numbers themselves.
  const headroom = rule.headroomBps;
  const protective = rule.type === 'STOP_LOSS' || rule.type === 'TRAILING_STOP';
  // Nearness is a warning on a stop and good news on a target, so only the
  // protective kinds get the amber treatment.
  const tight = protective && headroom !== null && headroom >= 0 && headroom < 300;
  const through = headroom !== null && headroom < 0;

  const covers = rule.quantity ?? rule.sharesHeld ?? null;
  // A rule on a symbol you do not hold will fire with nothing to sell. Worth
  // naming: "covers 0 shares" reads like a bug rather than a fact.
  const holdsNothing = (rule.sharesHeld ?? 0) === 0 && rule.quantity === null;
  const overcommitted =
    rule.quantity !== null && rule.sharesHeld !== null && rule.quantity > rule.sharesHeld;

  return (
    <Card
      style={
        rule.status === 'TRIGGERED'
          ? styles.cardFired
          : tight
            ? styles.cardTight
            : undefined
      }
    >
      <View style={styles.top}>
        <Link href={`/signal/${rule.symbol}`} asChild>
          <Pressable>
            <Text style={styles.symbol}>{rule.symbol}</Text>
            <Text style={styles.name} numberOfLines={1}>
              {rule.securityName}
            </Text>
          </Pressable>
        </Link>
        <View style={styles.alignRight}>
          <Text style={styles.level}>{rupees(level)}</Text>
          <Text style={styles.basis}>
            {labelFor(rule.type)} · {triggerLabel(rule.triggerOn)}
          </Text>
          {rule.trailBps !== null ? (
            <Text style={styles.basis}>trails {(rule.trailBps / 100).toFixed(1)}%</Text>
          ) : null}
        </View>
      </View>

      {armed ? (
        <View style={styles.rows}>
          <Row label="Market" value={rupees(rule.marketPrice)} />
          <Row
            label={protective ? 'Headroom' : 'Still to rise'}
            value={headroom === null ? '—' : percentFromBps(headroom)}
            tone={through ? colors.loss : tight ? colors.warn : undefined}
          />
          {rule.highWaterMark !== null ? (
            <Row label="Trailed from" value={rupees(rule.highWaterMark)} />
          ) : null}
          {covers !== null && covers > 0 ? (
            <Row
              label="Covers"
              value={`${shares(covers)} shares`}
              tone={overcommitted ? colors.warn : undefined}
            />
          ) : null}
          {rule.valueAtStop !== null ? (
            <Row label="Value at stop" value={rupees(rule.valueAtStop)} />
          ) : null}
          {rule.expiresAt !== null ? <Row label="Expires" value={shortDate(rule.expiresAt)} /> : null}
          <Row
            label="Checked to"
            value={rule.lastCheckedOn === null ? 'not yet' : shortDate(rule.lastCheckedOn)}
            tone={rule.lastCheckedOn === null ? colors.warn : undefined}
          />
        </View>
      ) : null}

      {holdsNothing && armed ? (
        <Text style={styles.caveat}>
          You hold none of {rule.symbol}, so there is nothing for this rule to protect. It will
          still tell you when the level breaks.
        </Text>
      ) : null}

      {overcommitted ? (
        <Text style={styles.caveat}>
          This rule covers {shares(rule.quantity!)} shares but only {shares(rule.sharesHeld!)} are
          held, so the figure above overstates what is at risk.
        </Text>
      ) : null}

      {through && armed ? (
        <Text style={styles.through}>
          The last close is already through this level, and it has not been evaluated yet. Press
          &ldquo;check now&rdquo; above.
        </Text>
      ) : null}

      {rule.note !== null && rule.note !== '' ? (
        <Text style={styles.note}>{rule.note}</Text>
      ) : null}

      {rule.status === 'TRIGGERED' && event !== undefined ? (
        <View style={styles.firedBox}>
          <Text style={styles.firedMessage}>{event.message}</Text>
          <View style={styles.rows}>
            <Row label="Fired on" value={shortDate(event.triggeredOn)} />
            <Row label="At" value={rupees(event.triggerPrice)} />
            <Row label="Stop was" value={rupees(event.stopAtTrigger)} />
          </View>
          {event.acknowledgedAt === null ? (
            <View style={styles.action}>
              <Button onPress={() => onAcknowledge(event.id)} variant="ghost">
                Mark as seen
              </Button>
            </View>
          ) : (
            <View style={styles.action}>
              <Badge tone={{ fg: colors.textMuted, bg: colors.neutralDim }}>SEEN</Badge>
            </View>
          )}
        </View>
      ) : null}

      {armed ? (
        <View style={styles.action}>
          <Button onPress={onCancel} variant="ghost">
            Stop watching
          </Button>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  content: { gap: space.md, padding: space.lg, paddingBottom: space.xl * 2 },
  headerButton: { paddingHorizontal: space.sm },
  preamble: { color: colors.textFaint, fontSize: 12, lineHeight: 18 },

  cardFired: { borderColor: colors.loss },
  cardTight: { borderColor: colors.warn },

  top: { flexDirection: 'row', justifyContent: 'space-between' },
  symbol: { color: colors.text, fontSize: 16, fontWeight: '700' },
  name: { color: colors.textFaint, fontSize: 12, marginTop: 1 },
  alignRight: { alignItems: 'flex-end', flexShrink: 1 },
  level: { color: colors.text, fontSize: 18, fontWeight: '600' },
  basis: { color: colors.textFaint, fontSize: 11, marginTop: 1 },

  rows: { marginTop: space.sm },
  caveat: { color: colors.warn, fontSize: 11, lineHeight: 17, marginTop: space.sm },
  through: { color: colors.loss, fontSize: 11, lineHeight: 17, marginTop: space.sm },
  note: {
    borderLeftColor: colors.borderStrong,
    borderLeftWidth: 2,
    color: colors.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
    lineHeight: 18,
    marginTop: space.sm,
    paddingLeft: space.sm,
  },

  firedBox: {
    backgroundColor: colors.lossDim,
    borderRadius: radius.md,
    marginTop: space.md,
    padding: space.md,
  },
  firedMessage: { color: colors.text, fontSize: 13, lineHeight: 20 },
  action: { marginTop: space.md },

  emptyTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  emptyBody: { color: colors.textFaint, fontSize: 12, lineHeight: 18, marginTop: space.xs },
});
