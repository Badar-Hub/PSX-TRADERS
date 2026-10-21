import { api } from '@/lib/api';
import { resolveActivePortfolio } from '@/lib/portfolio';
import { money, percent, rupees, shortDate, signedRupees, toneFor } from '@/lib/format';
import type { PnlReport } from '@/lib/types';
import { Stat } from '@/components/Stat';
import { PortfolioPicker } from '../PortfolioPicker';
import { PeriodPicker } from './PeriodPicker';

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ portfolio?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const { portfolios, active } = await resolveActivePortfolio(params.portfolio);
  if (active === null) return <p className="text-sm text-slate-400">No portfolios.</p>;

  const query = new URLSearchParams();
  if (params.from !== undefined) query.set('from', params.from);
  if (params.to !== undefined) query.set('to', params.to);

  const { report } = await api<{ report: PnlReport }>(
    `/api/portfolios/${active.id}/reports/pnl${query.size > 0 ? `?${query.toString()}` : ''}`,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Profit and loss</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            {shortDate(report.from)} to {shortDate(report.to)}
            {params.from === undefined && ' · current Pakistani tax year'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PortfolioPicker portfolios={portfolios} activeId={active.id} />
          <PeriodPicker portfolioId={active.id} from={report.from} to={report.to} />
        </div>
      </div>

      {/*
        Three figures kept deliberately apart. A single "profit" number runs
        together settled gains, dividend income taxed differently, and an
        opinion about open positions that can evaporate before it is banked.
      */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Realised"
          value={signedRupees(report.realisedNet)}
          tone={report.realisedNet}
          sub={`${rupees(report.realisedGains)} gains · ${rupees(Math.abs(report.realisedLosses))} losses`}
        />
        <Stat
          label="Dividends"
          value={signedRupees(report.dividendNet)}
          tone={report.dividendNet}
          sub={
            report.dividendTaxWithheld > 0
              ? `${rupees(report.dividendTaxWithheld)} tax withheld`
              : undefined
          }
        />
        <Stat
          label="Banked"
          value={signedRupees(report.bankedNet)}
          tone={report.bankedNet}
          hint="Realised gains plus dividends received. What the period actually settled."
        />
        <Stat
          label="Unrealised"
          value={signedRupees(report.unrealisedPnl)}
          tone={report.unrealisedPnl}
          sub={report.totalReturn === null ? undefined : `${signedRupees(report.totalReturn)} total`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card">
          <p className="label">Charges paid</p>
          <p className="numeric mt-1.5 text-xl font-semibold text-slate-100">
            {rupees(report.chargesPaid)}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-slate-600">
            Already deducted from every figure above. Shown separately because it is the
            number that tells you whether trading frequently is eating the edge.
          </p>
        </div>

        <div className="card">
          <p className="label">Estimated capital gains tax</p>
          <p className="numeric mt-1.5 text-xl font-semibold text-slate-100">
            {rupees(report.estimatedCgt)}
          </p>
          {report.cgtBasis !== null && (
            <p className="mt-2 text-xs leading-relaxed text-slate-600">
              An <strong className="text-slate-500">estimate</strong> at{' '}
              {(report.cgtBasis.rateBps / 100).toFixed(1)}% ·{' '}
              {report.cgtBasis.filerStatus === 'FILER' ? 'filer' : 'non-filer'}. CGT on listed
              securities is withheld by NCCPL at rates that change with each finance act, so
              check this against your own position before relying on it.
            </p>
          )}
        </div>

        <div className="card">
          <p className="label">Trade record</p>
          <div className="mt-2 space-y-1.5 text-sm">
            <Row label="Closed trades" value={String(report.tradeCount)} />
            <Row
              label="Win rate"
              value={report.winRate === null ? '—' : percent(report.winRate)}
              sub={`${report.winningTrades} won · ${report.losingTrades} lost`}
            />
            <Row
              label="Payoff ratio"
              value={report.payoffRatio === null ? '—' : `${report.payoffRatio.toFixed(2)}×`}
              sub="average win ÷ average loss"
            />
          </div>
          {report.payoffRatio !== null && report.payoffRatio > 1 && report.winRate !== null && report.winRate < 0.5 && (
            <p className="mt-3 text-xs leading-relaxed text-slate-600">
              A win rate under half is still profitable here because the winners are bigger
              than the losers.
            </p>
          )}
        </div>
      </div>

      {(report.bestTrade !== null || report.worstTrade !== null) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {report.bestTrade !== null && (
            <div className="card">
              <p className="label">Best trade</p>
              <p className="mt-1.5 text-sm text-slate-200">
                {report.bestTrade.symbol}
                <span className="ml-2 text-xs text-slate-500">
                  closed {shortDate(report.bestTrade.soldOn)}
                </span>
              </p>
              <p className="numeric mt-0.5 text-lg font-semibold text-emerald-400">
                {signedRupees(report.bestTrade.realisedPnl)}
              </p>
            </div>
          )}
          {report.worstTrade !== null && (
            <div className="card">
              <p className="label">Worst trade</p>
              <p className="mt-1.5 text-sm text-slate-200">
                {report.worstTrade.symbol}
                <span className="ml-2 text-xs text-slate-500">
                  closed {shortDate(report.worstTrade.soldOn)}
                </span>
              </p>
              <p className="numeric mt-0.5 text-lg font-semibold text-rose-400">
                {signedRupees(report.worstTrade.realisedPnl)}
              </p>
            </div>
          )}
        </div>
      )}

      {report.bySecurity.length > 0 && (
        <div className="card overflow-x-auto p-0">
          <div className="border-b border-slate-800 px-4 py-3">
            <h2 className="text-sm font-medium text-slate-200">By security</h2>
          </div>
          <table className="w-full min-w-[52rem]">
            <thead className="border-b border-slate-800">
              <tr>
                <th className="th">Symbol</th>
                <th className="th text-right">Sold</th>
                <th className="th text-right">Proceeds</th>
                <th className="th text-right">Cost</th>
                <th className="th text-right">Realised</th>
                <th className="th text-right">Dividends</th>
                <th className="th text-right">Unrealised</th>
                <th className="th text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {report.bySecurity.map((line) => (
                <tr key={line.symbol} className="hover:bg-slate-800/30">
                  <td className="td font-medium text-slate-200">{line.symbol}</td>
                  <td className="td numeric text-right text-slate-400">
                    {line.sharesSold === 0 ? '—' : line.sharesSold}
                  </td>
                  <td className="td numeric text-right">{money(line.proceeds)}</td>
                  <td className="td numeric text-right">{money(line.costBasis)}</td>
                  <td className={`td numeric text-right ${toneFor(line.realisedPnl)}`}>
                    {line.realisedPnl === 0 ? '—' : signedRupees(line.realisedPnl)}
                  </td>
                  <td className="td numeric text-right text-slate-400">
                    {line.dividendIncome === 0 ? '—' : money(line.dividendIncome)}
                  </td>
                  <td className={`td numeric text-right ${toneFor(line.unrealisedPnl)}`}>
                    {line.unrealisedPnl === null ? '—' : signedRupees(line.unrealisedPnl)}
                  </td>
                  <td className={`td numeric text-right font-medium ${toneFor(line.totalReturn)}`}>
                    {signedRupees(line.totalReturn)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report.pricesMissingFor.length > 0 && (
        <p className="text-xs text-slate-600">
          No price available for {report.pricesMissingFor.join(', ')}, so those holdings are
          excluded from the unrealised figures.
        </p>
      )}
    </div>
  );
}

function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-right">
        <span className="numeric text-slate-200">{value}</span>
        {sub !== undefined && <span className="ml-2 text-xs text-slate-600">{sub}</span>}
      </span>
    </div>
  );
}
