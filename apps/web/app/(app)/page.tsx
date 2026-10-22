import Link from 'next/link';
import { api } from '@/lib/api';
import { resolveActivePortfolio, withPortfolio } from '@/lib/portfolio';
import {
  money,
  percentFromBps,
  rupees,
  shares,
  shortDate,
  signedRupees,
  toneFor,
} from '@/lib/format';
import type { MarketStatus, PortfolioSummary, Signal } from '@/lib/types';
import { Stat } from '@/components/Stat';
import { SignalBadge } from '@/components/SignalBadge';
import { PortfolioPicker } from './PortfolioPicker';
import { MarketPanel } from './MarketPanel';

export default async function PositionsPage({
  searchParams,
}: {
  searchParams: Promise<{ portfolio?: string }>;
}) {
  const params = await searchParams;
  const { portfolios, active } = await resolveActivePortfolio(params.portfolio);

  if (active === null) {
    return (
      <div className="card">
        <p className="text-sm text-slate-400">
          No portfolios yet. One is created with your account, so if you are seeing this,
          something went wrong during registration.
        </p>
      </div>
    );
  }

  // Positions and signals in parallel: neither depends on the other, and the
  // signal lookup is the slower of the two.
  const [summary, signalsResponse, market] = await Promise.all([
    api<PortfolioSummary>(`/api/portfolios/${active.id}/positions`),
    api<{ signals: Array<{ symbol: string; signal: Signal | null }> }>(
      `/api/portfolios/${active.id}/signals?horizon=SWING`,
    ).catch(() => ({ signals: [] })),
    // The market panel is context, not the point of the page, so a failure
    // here must not take the portfolio down with it.
    api<MarketStatus>('/api/market/status?days=180').catch(() => null),
  ]);

  const signalBySymbol = new Map(
    signalsResponse.signals.map((entry) => [entry.symbol, entry.signal]),
  );

  const totalReturn =
    summary.unrealisedPnl === null ? null : summary.unrealisedPnl + summary.realisedPnl;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">{summary.name}</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            {summary.positionCount} open {summary.positionCount === 1 ? 'position' : 'positions'} ·{' '}
            {summary.costBasisMethod} cost basis
            {summary.isPaperTrading && ' · paper trading'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PortfolioPicker portfolios={portfolios} activeId={active.id} />
          <Link href={withPortfolio('/trades/new', active.id)} className="btn-primary">
            Record a trade
          </Link>
        </div>
      </div>

      {market !== null && <MarketPanel status={market} />}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Market value" value={rupees(summary.marketValue)} />
        <Stat label="Invested cost" value={rupees(summary.investedCost)} />
        <Stat
          label="Unrealised"
          value={signedRupees(summary.unrealisedPnl)}
          tone={summary.unrealisedPnl}
        />
        <Stat
          label="Realised"
          value={signedRupees(summary.realisedPnl)}
          tone={summary.realisedPnl}
          sub={totalReturn === null ? undefined : `${signedRupees(totalReturn)} in total`}
        />
      </div>

      {/*
        A total computed from an incomplete set of prices is worse than no
        total, because it looks authoritative. The API reports when a holding
        has no price, and that is surfaced rather than hidden.
      */}
      {summary.hasMissingPrices && (
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/15 px-4 py-3 text-sm text-amber-300">
          Some holdings have no price yet, so the market value and unrealised figures are
          incomplete. Run the ingest to fill the history:{' '}
          <code className="numeric text-xs">pnpm --filter @psx/api nightly</code>
        </div>
      )}

      {summary.positions.length === 0 ? (
        <div className="card text-center">
          <p className="text-sm text-slate-400">Nothing held in this portfolio yet.</p>
          <Link
            href={withPortfolio('/trades/new', active.id)}
            className="btn-primary mt-4 inline-flex"
          >
            Record your first trade
          </Link>
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[56rem]">
            <thead className="border-b border-slate-800">
              <tr>
                <th className="th">Symbol</th>
                <th className="th text-right">Shares</th>
                <th className="th text-right">Avg cost</th>
                <th className="th text-right">Price</th>
                <th className="th text-right">Market value</th>
                <th className="th text-right">Unrealised</th>
                <th className="th text-right">Weight</th>
                <th className="th">Swing signal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {summary.positions.map((position) => {
                const signal = signalBySymbol.get(position.symbol) ?? null;
                return (
                  <tr key={position.symbol} className="hover:bg-slate-800/30">
                    <td className="td">
                      <Link
                        href={`/signals/${position.symbol}`}
                        className="font-medium text-slate-100 hover:text-emerald-400"
                      >
                        {position.symbol}
                      </Link>
                      <p className="truncate text-xs text-slate-500">{position.name}</p>
                    </td>
                    <td className="td numeric text-right">{shares(position.quantity)}</td>
                    <td className="td numeric text-right">{money(position.averageCost)}</td>
                    <td className="td numeric text-right">
                      {money(position.marketPrice)}
                      {position.priceAsOf !== null && (
                        <p className="text-xs text-slate-600">{shortDate(position.priceAsOf)}</p>
                      )}
                    </td>
                    <td className="td numeric text-right">{money(position.marketValue)}</td>
                    <td className={`td numeric text-right ${toneFor(position.unrealisedPnl)}`}>
                      {signedRupees(position.unrealisedPnl)}
                      <p className="text-xs opacity-70">
                        {percentFromBps(position.unrealisedPnlBps)}
                      </p>
                    </td>
                    <td className="td numeric text-right text-slate-400">
                      {position.weightBps === null
                        ? '—'
                        : `${(position.weightBps / 100).toFixed(1)}%`}
                    </td>
                    <td className="td">
                      {signal === null ? (
                        <span className="text-xs text-slate-600">—</span>
                      ) : (
                        <Link href={`/signals/${position.symbol}`}>
                          <SignalBadge action={signal.action} score={signal.score} />
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
