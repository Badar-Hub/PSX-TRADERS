import Link from 'next/link';
import { api } from '@/lib/api';
import { resolveActivePortfolio } from '@/lib/portfolio';
import { percent, rupees, shares, shortDate } from '@/lib/format';
import type { PortfolioSummary, Signal } from '@/lib/types';
import { SignalBadge } from '@/components/SignalBadge';
import { SymbolSearch } from '../market/SymbolSearch';

/**
 * The predictions, with a front door.
 *
 * This page exists because the app's headline feature had no entry point. A
 * prediction lived only at /signals/<SYMBOL>, reachable by clicking a symbol
 * you already held or by knowing to type a ticker into a box on the Market
 * page — so the one thing the product is for was the one thing you could not
 * navigate to.
 *
 * It lists both horizons side by side on purpose. Swing and long term
 * routinely disagree on the same stock, and seeing "buy for weeks, sell for
 * quarters" next to each other is the honest presentation; showing one at a
 * time invites reading whichever is on screen as "the" prediction.
 */

interface AccuracyReport {
  horizon: string;
  settled: number;
  hits: number;
  misses: number;
  neutral: number;
  hitRate: number | null;
}

export const dynamic = 'force-dynamic';

export default async function PredictionsPage({
  searchParams,
}: {
  searchParams: Promise<{ portfolio?: string }>;
}) {
  const params = await searchParams;
  const { active } = await resolveActivePortfolio(params.portfolio);

  if (active === null) {
    return <p className="text-sm text-slate-400">No portfolio yet.</p>;
  }

  const [summary, swing, longTerm, accuracy] = await Promise.all([
    api<PortfolioSummary>(`/api/portfolios/${active.id}/positions`),
    api<{ signals: Array<{ symbol: string; signal: Signal | null }> }>(
      `/api/portfolios/${active.id}/signals?horizon=SWING`,
    ).catch(() => ({ signals: [] })),
    api<{ signals: Array<{ symbol: string; signal: Signal | null }> }>(
      `/api/portfolios/${active.id}/signals?horizon=LONG_TERM`,
    ).catch(() => ({ signals: [] })),
    // The hit rate is context, not the point; a failure must not blank the page.
    api<{ accuracy: AccuracyReport[]; note: string }>('/api/signals/stats/accuracy').catch(
      () => null,
    ),
  ]);

  const swingBy = new Map(swing.signals.map((entry) => [entry.symbol, entry.signal]));
  const longBy = new Map(longTerm.signals.map((entry) => [entry.symbol, entry.signal]));

  const held = summary.positions
    .filter((position) => position.quantity > 0)
    // Strongest conviction first, either direction: a firm sell is as worth
    // reading as a firm buy, and sorting by signed score would bury it.
    .sort((a, b) => {
      const scoreA = Math.abs(swingBy.get(a.symbol)?.score ?? 0);
      const scoreB = Math.abs(swingBy.get(b.symbol)?.score ?? 0);
      return scoreB - scoreA;
    });

  const settled = (accuracy?.accuracy ?? []).reduce((sum, row) => sum + row.settled, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-100">Predictions</h1>
        <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
          Scored from price history by the factor engine. Open one to see every factor that
          decided it, and what argued the other way.
        </p>
      </div>

      <SymbolSearch />

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-slate-200">What you hold</h2>
          {held.length > 1 && (
            <p className="text-xs text-slate-600">Strongest conviction first</p>
          )}
        </div>

        {held.length === 0 ? (
          <div className="card">
            <p className="text-sm text-slate-300">Nothing held in this portfolio.</p>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
              Predictions are computed for every liquid symbol on the exchange, not only what
              you own — use the box above to look up any ticker.
            </p>
          </div>
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full min-w-[42rem]">
              <thead className="border-b border-slate-800">
                <tr>
                  <th className="th text-left">Symbol</th>
                  <th className="th text-right">Held</th>
                  <th className="th text-left">Swing · days to weeks</th>
                  <th className="th text-left">Long term · months to years</th>
                  <th className="th text-right">As of</th>
                </tr>
              </thead>
              <tbody>
                {held.map((position) => {
                  const near = swingBy.get(position.symbol) ?? null;
                  const far = longBy.get(position.symbol) ?? null;
                  // The two horizons disagreeing is informative rather than a
                  // fault, so it is marked rather than smoothed over.
                  const split =
                    near !== null &&
                    far !== null &&
                    Math.sign(near.score) !== 0 &&
                    Math.sign(far.score) !== 0 &&
                    Math.sign(near.score) !== Math.sign(far.score);

                  return (
                    <tr key={position.symbol} className="border-b border-slate-800/60 last:border-0">
                      <td className="td">
                        <Link
                          href={`/signals/${position.symbol}`}
                          className="font-medium text-slate-100 hover:text-sky-300"
                        >
                          {position.symbol}
                        </Link>
                        <p className="text-xs text-slate-600">{position.name}</p>
                        {split && (
                          <p className="mt-0.5 text-xs text-amber-500">
                            horizons disagree
                          </p>
                        )}
                      </td>
                      <td className="td numeric text-right text-slate-300">
                        {shares(position.quantity)}
                        <p className="text-xs text-slate-600">{rupees(position.marketValue)}</p>
                      </td>
                      <td className="td">
                        {near === null ? (
                          <span className="text-xs text-slate-600">no prediction</span>
                        ) : (
                          <SignalBadge action={near.action} score={near.score} />
                        )}
                      </td>
                      <td className="td">
                        {far === null ? (
                          <span className="text-xs text-slate-600">no prediction</span>
                        ) : (
                          <SignalBadge action={far.action} score={far.score} />
                        )}
                      </td>
                      <td className="td numeric text-right text-xs text-slate-500">
                        {shortDate(near?.asOf ?? far?.asOf)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/*
        The hit rate belongs on this page more than anywhere else: it is the
        only honest answer to "should I believe these", and leaving it on a
        separate screen lets the predictions be read without it.
      */}
      <section className="card">
        <h2 className="text-sm font-semibold text-slate-200">How these have done</h2>
        {settled === 0 ? (
          <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
            Nothing has settled yet. A prediction is only scored once its whole horizon has
            elapsed, so this stays empty for a while rather than showing an early figure that
            would be mostly noise. Until it fills, the factor weights are a considered prior and
            not a model fitted to what actually happened — which is the most important thing to
            know about every number on this page.
          </p>
        ) : (
          <dl className="mt-2 space-y-1.5 text-sm">
            {(accuracy?.accuracy ?? []).map((row) => (
              <div key={row.horizon} className="flex justify-between">
                <dt className="text-slate-400">
                  {row.horizon === 'SWING' ? 'Swing' : 'Long term'}
                </dt>
                <dd className="numeric text-slate-200">
                  {row.hitRate === null ? 'not enough settled' : percent(row.hitRate, 1)}
                  <span className="ml-2 text-xs text-slate-600">
                    {row.settled} settled · {row.hits} right · {row.misses} wrong
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </div>
  );
}
