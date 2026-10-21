import Link from 'next/link';
import { api } from '@/lib/api';
import { resolveActivePortfolio, withPortfolio } from '@/lib/portfolio';
import { money, percentFromBps, rupees, shares, shortDate, signedRupees, toneFor } from '@/lib/format';
import type { BuyBack, PositionCycle, Trade } from '@/lib/types';
import { PortfolioPicker } from '../PortfolioPicker';
import { reverseTrade } from './actions';

export default async function TradesPage({
  searchParams,
}: {
  searchParams: Promise<{ portfolio?: string; symbol?: string }>;
}) {
  const params = await searchParams;
  const { portfolios, active } = await resolveActivePortfolio(params.portfolio);
  if (active === null) return <p className="text-sm text-slate-400">No portfolios.</p>;

  const symbolFilter = params.symbol?.toUpperCase();

  const [tradeData, cycleData] = await Promise.all([
    api<{ trades: Trade[]; nextCursor: string | null }>(
      `/api/portfolios/${active.id}/trades?includeReversed=true${
        symbolFilter !== undefined ? `&symbol=${symbolFilter}` : ''
      }`,
    ),
    api<{ cycles: PositionCycle[]; buyBacks: BuyBack[] }>(
      `/api/portfolios/${active.id}/cycles`,
    ),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Trades</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            {tradeData.trades.length} recorded
            {symbolFilter !== undefined && ` in ${symbolFilter}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PortfolioPicker portfolios={portfolios} activeId={active.id} />
          <Link href={withPortfolio('/trades/new', active.id)} className="btn-primary">
            Record a trade
          </Link>
        </div>
      </div>

      {/*
        Buy-backs first, because this is the figure no other view carries: the
        realised gain says what an exit made, not whether getting out and back
        in beat simply holding.
      */}
      {cycleData.buyBacks.length > 0 && (
        <div className="card p-0">
          <div className="border-b border-slate-800 px-4 py-3">
            <h2 className="text-sm font-medium text-slate-200">Buy-backs</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Whether stepping out and back in actually paid, over the shares you
              repurchased.
            </p>
          </div>
          <div className="divide-y divide-slate-800/70">
            {cycleData.buyBacks.map((back) => (
              <div
                key={back.buyTradeId}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-sm"
              >
                <span className="font-medium text-slate-200">{back.symbol}</span>
                <span className="text-slate-400">
                  sold at <span className="numeric">{money(back.previousExitPrice)}</span>, back
                  in at <span className="numeric">{money(back.buyPrice)}</span> after{' '}
                  {back.daysOut} {back.daysOut === 1 ? 'day' : 'days'}
                </span>
                {!back.fullyExited && (
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">
                    partial trim
                  </span>
                )}
                <span className={`numeric ml-auto font-medium ${toneFor(back.advantage)}`}>
                  {signedRupees(back.advantage)}
                  <span className="ml-2 text-xs opacity-70">
                    {percentFromBps(-back.priceChangeBps)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {cycleData.cycles.filter((cycle) => !cycle.isOpen).length > 0 && (
        <div className="card overflow-x-auto p-0">
          <div className="border-b border-slate-800 px-4 py-3">
            <h2 className="text-sm font-medium text-slate-200">Closed round trips</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Each position from opening to flat, kept separate so a good trade in one month
              and a bad one in another do not average into nothing.
            </p>
          </div>
          <table className="w-full min-w-[46rem]">
            <thead className="border-b border-slate-800">
              <tr>
                <th className="th">Symbol</th>
                <th className="th">Held</th>
                <th className="th text-right">Days</th>
                <th className="th text-right">Entry avg</th>
                <th className="th text-right">Exit avg</th>
                <th className="th text-right">Realised</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {cycleData.cycles
                .filter((cycle) => !cycle.isOpen)
                .map((cycle) => (
                  <tr key={`${cycle.symbol}-${cycle.index}`} className="hover:bg-slate-800/30">
                    <td className="td font-medium text-slate-200">{cycle.symbol}</td>
                    <td className="td text-xs text-slate-400">
                      {shortDate(cycle.openedOn)} → {shortDate(cycle.closedOn)}
                    </td>
                    <td className="td numeric text-right text-slate-400">{cycle.holdingDays}</td>
                    <td className="td numeric text-right">{money(cycle.entryAveragePrice)}</td>
                    <td className="td numeric text-right">{money(cycle.exitAveragePrice)}</td>
                    <td className={`td numeric text-right font-medium ${toneFor(cycle.realisedPnl)}`}>
                      {signedRupees(cycle.realisedPnl)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card overflow-x-auto p-0">
        <div className="border-b border-slate-800 px-4 py-3">
          <h2 className="text-sm font-medium text-slate-200">Ledger</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Append-only. A mistake is cancelled by a reversing entry, so both rows stay and
            the history of what was believed is intact.
          </p>
        </div>

        {tradeData.trades.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">No trades yet.</p>
        ) : (
          <table className="w-full min-w-[52rem]">
            <thead className="border-b border-slate-800">
              <tr>
                <th className="th">Date</th>
                <th className="th">Symbol</th>
                <th className="th">Side</th>
                <th className="th text-right">Shares</th>
                <th className="th text-right">Price</th>
                <th className="th text-right">Charges</th>
                <th className="th text-right">Net cash</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {tradeData.trades.map((trade) => (
                <tr
                  key={trade.id}
                  className={`hover:bg-slate-800/30 ${
                    trade.status === 'REVERSED' ? 'opacity-45' : ''
                  }`}
                >
                  <td className="td numeric text-slate-400">{shortDate(trade.tradedOn)}</td>
                  <td className="td">
                    <Link
                      href={`/signals/${trade.symbol}`}
                      className="font-medium text-slate-200 hover:text-emerald-400"
                    >
                      {trade.symbol}
                    </Link>
                  </td>
                  <td className="td">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                        trade.side === 'BUY'
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : 'bg-rose-500/10 text-rose-400'
                      }`}
                    >
                      {trade.side}
                    </span>
                  </td>
                  <td className="td numeric text-right">{shares(trade.quantity)}</td>
                  <td className="td numeric text-right">{money(trade.unitPrice)}</td>
                  <td className="td numeric text-right text-slate-500">
                    {trade.charges.total === 0 ? '—' : money(trade.charges.total)}
                  </td>
                  <td className="td numeric text-right">{rupees(trade.netCashFlow)}</td>
                  <td className="td text-right">
                    {trade.status === 'REVERSED' ? (
                      <span className="text-xs text-slate-600">
                        {trade.reversesTradeId === null ? 'reversed' : 'reversal'}
                      </span>
                    ) : (
                      <ReverseButton tradeId={trade.id} portfolioId={active.id} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ReverseButton({ tradeId, portfolioId }: { tradeId: string; portfolioId: string }) {
  return (
    <form action={reverseTrade}>
      <input type="hidden" name="tradeId" value={tradeId} />
      <input type="hidden" name="portfolioId" value={portfolioId} />
      <button type="submit" className="text-xs text-slate-500 hover:text-rose-400">
        Reverse
      </button>
    </form>
  );
}
