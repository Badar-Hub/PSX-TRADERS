import Link from 'next/link';
import { api } from '@/lib/api';
import { money, percent, shortDate } from '@/lib/format';
import type { ChartBar } from '@/components/PriceChart';
import type { SignalResponse } from '@/lib/types';
import { SignalDetail } from './SignalDetail';

export default async function SignalPage({
  params,
  searchParams,
}: {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<{ horizon?: string }>;
}) {
  const { symbol: rawSymbol } = await params;
  const symbol = rawSymbol.toUpperCase();
  const { horizon: rawHorizon } = await searchParams;
  const horizon = rawHorizon === 'LONG_TERM' ? 'LONG_TERM' : 'SWING';

  // Both horizons plus the price history, in parallel. Fetching both horizons
  // is deliberate: seeing that the swing and long-term readings disagree is
  // often the most useful thing on the page, and it should not need a second
  // navigation to discover.
  const [swing, longTerm, history] = await Promise.all([
    api<SignalResponse>(`/api/securities/${symbol}/signal?horizon=SWING`),
    api<SignalResponse>(`/api/securities/${symbol}/signal?horizon=LONG_TERM`),
    api<{ symbol: string; name: string; bars: ChartBar[] }>(
      `/api/securities/${symbol}/bars?limit=180`,
    ).catch(() => ({ symbol, name: symbol, bars: [] as ChartBar[] })),
  ]);

  const active = horizon === 'SWING' ? swing : longTerm;
  const other = horizon === 'SWING' ? longTerm : swing;

  const lastBar = history.bars[history.bars.length - 1];
  const firstBar = history.bars[0];
  const periodChange =
    firstBar === undefined || lastBar === undefined || firstBar.close === 0
      ? null
      : ((lastBar.close - firstBar.close) / firstBar.close) * 100;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-xs text-slate-500 hover:text-slate-300">
          ← Positions
        </Link>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">{symbol}</h1>
          <p className="text-sm text-slate-400">{history.name}</p>
          {lastBar !== undefined && (
            <p className="numeric ml-auto text-sm text-slate-300">
              {money(lastBar.close)}
              <span className="ml-2 text-xs text-slate-500">{shortDate(lastBar.date)}</span>
            </p>
          )}
        </div>
        {periodChange !== null && (
          <p className="mt-1 text-xs text-slate-500">
            {history.bars.length} sessions shown ·{' '}
            <span className={periodChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              {periodChange >= 0 ? '+' : '−'}
              {Math.abs(periodChange).toFixed(1)}%
            </span>{' '}
            over the period
          </p>
        )}
      </div>

      <SignalDetail
        symbol={symbol}
        horizon={horizon}
        active={active}
        other={other}
        bars={history.bars}
      />

      {/*
        Coverage is worth stating on this page specifically. A prediction built
        on a series with a hole in it is wrong in a way nothing on screen would
        otherwise reveal.
      */}
      {active.signal !== null && (
        <p className="text-xs leading-relaxed text-slate-600">
          Computed by engine {active.signal.engineVersion} from prices up to{' '}
          {shortDate(active.signal.asOf)}
          {/*
            Coverage comes from the engine, not from counting factors here.
            This line used to compute 1 - missing / total, which gave "67% of
            the model" for a signal whose narrative said 78% — because the
            model is weighted, so it is not an equal number of parts, and the
            weighted share is the figure confidence is built from. A view
            deriving its own version of a number the engine already computed is
            how two figures end up disagreeing in one paragraph.
          */}
          {active.signal.missingFactors > 0 && (
            <>
              . {active.signal.missingFactors} factor
              {active.signal.missingFactors === 1 ? '' : 's'} could not be assessed
              {active.signal.coverage !== null
                ? `, so this rests on ${percent(active.signal.coverage)} of the model by weight`
                : ` (${active.signal.factors.length} of ${
                    active.signal.factors.length + active.signal.missingFactors
                  } reported)`}
            </>
          )}
          . Factor weights are a considered prior, not a model fitted to historical
          returns — no prediction has been settled long enough yet to measure a hit rate.
        </p>
      )}
    </div>
  );
}
