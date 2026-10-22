import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Banner, Card, Empty, Loading, Row, SectionTitle, Stat } from '@/components/ui';
import { usePortfolio } from '@/lib/portfolio';
import { useFetch } from '@/lib/useFetch';
import { percent, rupees, shares, shortDate, signedRupees } from '@/lib/format';
import { colors, space, toneFor } from '@/lib/theme';
import type { BuyBack, PnlReport, PositionCycle } from '@/lib/types';

/**
 * The profit and loss statement.
 *
 * Every figure here is the server's. The screen does not add two numbers
 * together to make a third, which is why it can never show a total that the
 * ledger would dispute.
 */
export default function Pnl(): React.ReactNode {
  const { active, loading: loadingPortfolios } = usePortfolio();

  const report = useFetch<{ report: PnlReport }>(
    active !== null ? `/api/portfolios/${active.id}/reports/pnl` : null,
  );
  const cycles = useFetch<{ cycles: PositionCycle[]; buyBacks: BuyBack[] }>(
    active !== null ? `/api/portfolios/${active.id}/cycles` : null,
  );

  if (loadingPortfolios || (report.loading && report.data === null)) {
    return <Loading what="Working out your P&L" />;
  }
  if (active === null) return <Empty title="No portfolio yet" />;

  const data = report.data?.report ?? null;
  const buyBacks = cycles.data?.buyBacks ?? [];

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={report.refreshing}
          onRefresh={() => {
            report.reload();
            cycles.reload();
          }}
          tintColor={colors.accent}
        />
      }
    >
      {report.error !== null ? <Banner kind="error">{report.error}</Banner> : null}

      {data !== null ? (
        <>
          <Text style={styles.period}>
            {shortDate(data.from)} — {shortDate(data.to)}
          </Text>

          <Card>
            <View style={styles.stats}>
              <Stat
                label="Banked"
                value={signedRupees(data.bankedNet)}
                tone={toneFor(data.bankedNet)}
                hint="Realised, after charges and dividends"
              />
              <Stat
                label="Unrealised"
                value={signedRupees(data.unrealisedPnl)}
                tone={toneFor(data.unrealisedPnl)}
                hint="Still held"
              />
              <Stat
                label="Total return"
                value={signedRupees(data.totalReturn)}
                tone={toneFor(data.totalReturn)}
              />
              <Stat label="Charges paid" value={rupees(data.chargesPaid)} />
            </View>
          </Card>

          <Card>
            <SectionTitle hint="What makes up the banked figure">Realised</SectionTitle>
            <Row label="Gains" value={signedRupees(data.realisedGains)} tone={colors.gain} />
            <Row label="Losses" value={signedRupees(-data.realisedLosses)} tone={colors.loss} />
            <Row
              label="Net"
              value={signedRupees(data.realisedNet)}
              tone={toneFor(data.realisedNet)}
            />
            <View style={styles.divider} />
            <Row label="Dividends received" value={rupees(data.dividendGross)} />
            <Row label="Tax withheld on dividends" value={rupees(data.dividendTaxWithheld)} />
            <Row label="Dividends, net" value={rupees(data.dividendNet)} />
          </Card>

          <Card>
            <SectionTitle>Trading record</SectionTitle>
            <Row label="Closed trades" value={String(data.tradeCount)} />
            <Row label="Winners" value={String(data.winningTrades)} tone={colors.gain} />
            <Row label="Losers" value={String(data.losingTrades)} tone={colors.loss} />
            <Row label="Win rate" value={percent(data.winRate, 0)} />
            <Row
              label="Payoff ratio"
              value={data.payoffRatio !== null ? data.payoffRatio.toFixed(2) : '—'}
            />
            {data.bestTrade !== null ? (
              <Row
                label={`Best — ${data.bestTrade.symbol}`}
                value={signedRupees(data.bestTrade.realisedPnl)}
                tone={colors.gain}
              />
            ) : null}
            {data.worstTrade !== null ? (
              <Row
                label={`Worst — ${data.worstTrade.symbol}`}
                value={signedRupees(data.worstTrade.realisedPnl)}
                tone={colors.loss}
              />
            ) : null}
          </Card>

          {data.estimatedCgt !== null && data.cgtBasis !== null ? (
            <Card>
              <SectionTitle>Capital gains tax</SectionTitle>
              <Row label="Estimated" value={rupees(data.estimatedCgt)} />
              <Row
                label="Rate applied"
                value={`${(data.cgtBasis.rateBps / 100).toFixed(1)}% · ${data.cgtBasis.filerStatus.toLowerCase()}`}
              />
              <Text style={styles.caveat}>
                An estimate from a configured rate, not tax advice, and not filed for you. Check the
                rate for the year before relying on it.
              </Text>
            </Card>
          ) : null}

          {data.bySecurity.length > 0 ? (
            <Card>
              <SectionTitle>By security</SectionTitle>
              {data.bySecurity.map((line) => (
                <View key={line.symbol} style={styles.securityRow}>
                  <View>
                    <Text style={styles.securitySymbol}>{line.symbol}</Text>
                    <Text style={styles.securityDetail}>
                      {shares(line.sharesSold)} sold · {rupees(line.proceeds)}
                    </Text>
                  </View>
                  <Text style={[styles.securityPnl, { color: toneFor(line.realisedPnl) }]}>
                    {signedRupees(line.realisedPnl)}
                  </Text>
                </View>
              ))}
            </Card>
          ) : null}

          {buyBacks.length > 0 ? (
            <Card>
              <SectionTitle hint="Shares you sold and later bought again">Buy-backs</SectionTitle>
              {buyBacks.map((buyBack) => (
                <View key={buyBack.buyTradeId} style={styles.securityRow}>
                  <View style={styles.buyBackIdentity}>
                    <Text style={styles.securitySymbol}>{buyBack.symbol}</Text>
                    <Text style={styles.securityDetail}>
                      Out {shortDate(buyBack.previousExitOn)} at {rupees(buyBack.previousExitPrice)}
                      , back {shortDate(buyBack.boughtOn)} at {rupees(buyBack.buyPrice)}
                    </Text>
                    <Text style={styles.securityDetail}>
                      {buyBack.daysOut} day{buyBack.daysOut === 1 ? '' : 's'} out ·{' '}
                      {shares(buyBack.quantity)} shares
                    </Text>
                  </View>
                  <View style={styles.alignRight}>
                    <Text style={[styles.securityPnl, { color: toneFor(buyBack.advantage) }]}>
                      {signedRupees(buyBack.advantage)}
                    </Text>
                    <Text style={styles.securityDetail}>
                      {buyBack.advantage > 0 ? 'cheaper' : 'dearer'}
                    </Text>
                  </View>
                </View>
              ))}
            </Card>
          ) : null}

          {data.pricesMissingFor.length > 0 ? (
            <Banner kind="warn">
              {`No recent close for ${data.pricesMissingFor.join(', ')}, so the unrealised figure leaves them out.`}
            </Banner>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { gap: space.md, padding: space.lg, paddingBottom: space.xl * 2 },
  period: { color: colors.textFaint, fontSize: 12, textAlign: 'center' },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg },
  divider: {
    backgroundColor: colors.border,
    height: StyleSheet.hairlineWidth,
    marginVertical: space.sm,
  },
  caveat: { color: colors.textFaint, fontSize: 11, lineHeight: 17, marginTop: space.sm },
  securityRow: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: space.sm,
  },
  buyBackIdentity: { flexShrink: 1, paddingRight: space.sm },
  alignRight: { alignItems: 'flex-end' },
  securitySymbol: { color: colors.text, fontSize: 14, fontWeight: '600' },
  securityDetail: { color: colors.textFaint, fontSize: 11, lineHeight: 16, marginTop: 1 },
  securityPnl: { fontSize: 14, fontWeight: '600' },
});
