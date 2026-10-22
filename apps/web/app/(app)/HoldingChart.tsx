'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { percentFromBps, rupees, shares, shortDate, toneFor } from '@/lib/format';
import type { ChartBar } from '@/components/PriceChart';
import { PriceChart } from '@/components/PriceChart';

/**
 * A price chart for one of the user's holdings, with a picker.
 *
 * This replaced an index chart. The index was the app's own equal-weighted
 * construction rather than the KSE-100 — the exchange's bulk archive does not
 * publish index levels — and a number that is not the one a Pakistani trader
 * means by "points" earns its place only if nothing better is available. For
 * the holdings there is something better: the actual stored OHLCV, which is
 * both real and the thing the user is exposed to.
 *
 * The selection lives in the query string, like the portfolio does, so the
 * chart someone is looking at survives a refresh and can be sent to someone
 * else. A client-held selection would lose it on every navigation.
 */
export function HoldingChart({
  holdings,
  selected,
  bars,
  name,
}: {
  holdings: Array<{
    symbol: string;
    quantity: number;
    marketValue: number | null;
    unrealisedPnl: number | null;
    unrealisedPnlBps: number | null;
  }>;
  selected: string;
  bars: ChartBar[];
  name: string;
}) {
  const router = useRouter();
  const params = useSearchParams();

  const choose = (symbol: string): void => {
    const next = new URLSearchParams(params.toString());
    next.set('chart', symbol);
    // Scroll preserved: the chart is partway down the page, and jumping to the
    // top on every pick would make comparing two holdings tiresome.
    router.replace(`/?${next.toString()}`, { scroll: false });
  };

  const position = holdings.find((holding) => holding.symbol === selected) ?? null;
  const first = bars[0];
  const last = bars[bars.length - 1];
  const periodBps =
    first === undefined || last === undefined || first.close === 0
      ? null
      : Math.round((last.close / first.close - 1) * 10_000);

  return (
    <div className="card">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-200">
            {selected}
            <span className="ml-2 text-xs font-normal text-slate-500">{name}</span>
          </h2>
          {position !== null && (
            <p className="numeric mt-0.5 text-xs text-slate-500">
              {shares(position.quantity)} shares · {rupees(position.marketValue)}
              {position.unrealisedPnlBps !== null && (
                <span className={`ml-2 ${toneFor(position.unrealisedPnl)}`}>
                  {percentFromBps(position.unrealisedPnlBps)} unrealised
                </span>
              )}
            </p>
          )}
        </div>

        <div className="text-right">
          {last !== undefined && (
            <p className="numeric text-xl font-semibold text-slate-100">
              {rupees(last.close)}
            </p>
          )}
          {periodBps !== null && (
            <p className={`numeric text-xs ${toneFor(periodBps)}`}>
              {percentFromBps(periodBps)} over {bars.length} sessions
            </p>
          )}
        </div>
      </div>

      {/*
        Chips rather than a dropdown. A handful of holdings is the normal case
        and a chip row shows all of them at once, so switching is one click
        instead of two. It wraps rather than scrolls, so none is hidden.
      */}
      {holdings.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {holdings.map((holding) => (
            <button
              key={holding.symbol}
              type="button"
              onClick={() => choose(holding.symbol)}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                holding.symbol === selected
                  ? 'bg-sky-600/15 text-sky-300 ring-1 ring-sky-600/40'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              {holding.symbol}
            </button>
          ))}
        </div>
      )}

      <div className="mt-4">
        {bars.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">
            No stored price history for {selected}. Run the ingest to fill it.
          </p>
        ) : (
          <div className="h-80">
            <PriceChart bars={bars} highlightDates={null} />
          </div>
        )}
      </div>

      {first !== undefined && last !== undefined && (
        <p className="mt-3 text-xs text-slate-600">
          {shortDate(first.date)} to {shortDate(last.date)}, from the closes the exchange
          published. Volume is the lower band.
        </p>
      )}
    </div>
  );
}
