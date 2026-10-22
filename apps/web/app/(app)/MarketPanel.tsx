import { rupeesCompact, shares, shortDate } from '@/lib/format';
import type { MarketStatus } from '@/lib/types';
import { MarketChart } from '@/components/MarketChart';

/**
 * Where the market is, above the user's own positions.
 *
 * NOT CURRENTLY RENDERED. The dashboard shows a chart of the user's own
 * holdings instead — see HoldingChart — because this panel's index is the
 * app's own equal-weighted construction and not the KSE-100, which the
 * exchange's bulk archive does not publish. The owner would rather see nothing
 * than a points figure that could be mistaken for a KSE-100 quote.
 *
 * Kept, not deleted: the moment an index feed is licensed (from PSX directly
 * or through a redistributor), this panel and /api/market/status are what it
 * plugs into. The service, the endpoint and its tests are all still live, and
 * the mobile market tab still uses them.
 *
 * It leads with the day's move in points, because that is the number a
 * Pakistani trader asks for first — but the heading says plainly that it is
 * this app's own index and not the KSE-100, and the basis sentence is there to
 * be read rather than buried. A figure that looks like an index quote and is
 * not one would be the most misleading thing on the page.
 */
export function MarketPanel({ status }: { status: MarketStatus }) {
  const { latest, series } = status;

  if (latest === null) {
    return (
      <div className="card">
        <p className="text-sm text-slate-400">
          No market history stored yet. Run{' '}
          <code className="numeric text-xs">pnpm --filter @psx/api nightly</code> to fill it.
        </p>
      </div>
    );
  }

  const first = series[0];
  // Over the charted window, not since the index began: the chart shows the
  // window, so the figure beside it has to describe the same thing.
  const windowChangeBps =
    first === undefined || first.level === 0
      ? null
      : Math.round((latest.level / first.level - 1) * 10_000);

  const up = latest.change > 0;
  const down = latest.change < 0;
  const netBreadth = latest.advances - latest.declines;

  return (
    <div className="card">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-200">Market</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            This app&rsquo;s own index of liquid PSX equities, not the KSE-100
          </p>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
          <div>
            <p className="label">Level</p>
            <p className="numeric mt-0.5 text-xl font-semibold text-slate-100">
              {latest.level.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </p>
          </div>
          <div>
            <p className="label">Today</p>
            <p
              className={`numeric mt-0.5 text-xl font-semibold ${
                up ? 'text-emerald-400' : down ? 'text-rose-400' : 'text-slate-300'
              }`}
            >
              {up ? '+' : down ? '−' : ''}
              {Math.abs(latest.change).toLocaleString('en-US', { minimumFractionDigits: 2 })}
              <span className="ml-1 text-xs font-normal">pts</span>
            </p>
            <p className={`numeric text-xs ${up ? 'text-emerald-400' : down ? 'text-rose-400' : 'text-slate-500'}`}>
              {up ? '+' : down ? '−' : ''}
              {Math.abs(latest.changeBps / 100).toFixed(2)}%
            </p>
          </div>
          {/*
            The median next to the mean, because when they part company the
            index is being carried by a minority of names — and "market up"
            then does not mean "your stocks up". It is the one number that
            stops an equal-weighted index being read as a KSE-100 quote.
          */}
          <div>
            <p className="label">Typical stock</p>
            <p
              className={`numeric mt-0.5 text-sm ${
                latest.medianChangeBps > 0
                  ? 'text-emerald-400'
                  : latest.medianChangeBps < 0
                    ? 'text-rose-400'
                    : 'text-slate-400'
              }`}
            >
              {latest.medianChangeBps > 0 ? '+' : latest.medianChangeBps < 0 ? '−' : ''}
              {Math.abs(latest.medianChangeBps / 100).toFixed(2)}%
            </p>
            <p className="text-xs text-slate-500">median</p>
          </div>
          <div>
            <p className="label">Breadth</p>
            <p className="numeric mt-0.5 text-sm text-slate-200">
              <span className="text-emerald-400">{latest.advances}</span>
              {' / '}
              <span className="text-rose-400">{latest.declines}</span>
            </p>
            <p
              className={`numeric text-xs ${
                netBreadth > 0 ? 'text-emerald-400' : netBreadth < 0 ? 'text-rose-400' : 'text-slate-500'
              }`}
            >
              {netBreadth > 0 ? '+' : netBreadth < 0 ? '−' : ''}
              {Math.abs(netBreadth)} net
            </p>
          </div>
          <div>
            <p className="label">Turnover</p>
            <p className="numeric mt-0.5 text-sm text-slate-200">
              {rupeesCompact(latest.tradedValue)}
            </p>
            <p className="numeric text-xs text-slate-500">{shares(latest.volume)} shares</p>
          </div>
        </div>
      </div>

      <div className="mt-4">
        <MarketChart series={series} />
      </div>

      <p className="mt-3 text-xs leading-relaxed text-slate-600">
        {shortDate(first?.date)} to {shortDate(latest.date)}
        {windowChangeBps !== null &&
          `, ${windowChangeBps >= 0 ? 'up' : 'down'} ${Math.abs(windowChangeBps / 100).toFixed(1)}% over the window`}
        . {latest.counted} stocks met the {shares(status.minVolume)}-share floor on the latest
        session. The lower bars are net advancing stocks, which is what tells a broad rise from a
        narrow one.
      </p>

      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-300">
          How this index is built
        </summary>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">{status.basis}</p>
      </details>
    </div>
  );
}
