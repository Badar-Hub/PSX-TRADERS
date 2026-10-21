import Link from 'next/link';
import { api } from '@/lib/api';
import { shortDate } from '@/lib/format';
import type { Coverage } from '@/lib/types';
import { Stat } from '@/components/Stat';
import { SymbolSearch } from './SymbolSearch';

interface AccuracyReport {
  horizon: string;
  engineVersion: string;
  settled: number;
  hits: number;
  misses: number;
  neutral: number;
  hitRate: number | null;
}

export default async function MarketPage() {
  const [{ coverage }, accuracy] = await Promise.all([
    api<{ coverage: Coverage }>('/api/market/coverage'),
    api<{ accuracy: AccuracyReport[]; note: string }>('/api/signals/stats/accuracy'),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-100">Market data</h1>
        <p className="mt-0.5 text-xs text-slate-500">
          What history is stored, and how the engine has been doing
        </p>
      </div>

      <SymbolSearch />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Trading days"
          value={String(coverage.tradingDaysStored)}
          sub={
            coverage.firstDay === null
              ? undefined
              : `${shortDate(coverage.firstDay)} → ${shortDate(coverage.lastDay)}`
          }
        />
        <Stat label="Securities" value={String(coverage.securities)} />
        <Stat label="Price rows" value={coverage.barRows.toLocaleString('en-PK')} />
        <Stat
          label="Gaps"
          value={String(coverage.missingDays.length)}
          hint={
            coverage.missingDays.length === 0
              ? 'Every weekday is either stored or recorded as a non-trading day.'
              : 'Weekdays with no prices and no holiday record. Backfill these.'
          }
        />
      </div>

      {/*
        A gap in the series is the one data problem that nothing else on screen
        would reveal: indicators computed across a hole describe the hole.
      */}
      {coverage.missingDays.length > 0 && (
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/15 px-4 py-3 text-sm text-amber-300">
          <p className="font-medium">
            {coverage.missingDays.length} unexplained {coverage.missingDays.length === 1 ? 'gap' : 'gaps'} in the price history
          </p>
          <p className="numeric mt-1 text-xs opacity-80">
            {coverage.missingDays.slice(0, 12).join(', ')}
            {coverage.missingDays.length > 12 && ` and ${coverage.missingDays.length - 12} more`}
          </p>
          <p className="mt-2 text-xs opacity-80">
            Fill them with{' '}
            <code>pnpm --filter @psx/api backfill {coverage.missingDays[0]} {coverage.missingDays[coverage.missingDays.length - 1]}</code>
          </p>
        </div>
      )}

      <div className="card">
        <h2 className="text-sm font-medium text-slate-200">Prediction accuracy</h2>

        {accuracy.accuracy.length === 0 || accuracy.accuracy.every((row) => row.settled === 0) ? (
          <>
            <p className="mt-2 text-sm text-slate-400">{accuracy.note}</p>
            <p className="mt-3 text-xs leading-relaxed text-slate-600">
              Predictions are judged after their horizon has elapsed — 20 sessions for a
              swing call, 120 for a long-term one — and a move smaller than the threshold
              counts as neither right nor wrong. Until then there is no hit rate to show,
              and a number here would be invented.
            </p>
          </>
        ) : (
          <>
            <table className="mt-3 w-full">
              <thead>
                <tr>
                  <th className="th">Horizon</th>
                  <th className="th">Engine</th>
                  <th className="th text-right">Settled</th>
                  <th className="th text-right">Hit</th>
                  <th className="th text-right">Miss</th>
                  <th className="th text-right">Neutral</th>
                  <th className="th text-right">Hit rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {accuracy.accuracy.map((row) => (
                  <tr key={`${row.horizon}-${row.engineVersion}`}>
                    <td className="td text-slate-200">{row.horizon}</td>
                    <td className="td numeric text-xs text-slate-500">{row.engineVersion}</td>
                    <td className="td numeric text-right">{row.settled}</td>
                    <td className="td numeric text-right text-emerald-400">{row.hits}</td>
                    <td className="td numeric text-right text-rose-400">{row.misses}</td>
                    <td className="td numeric text-right text-slate-500">{row.neutral}</td>
                    <td className="td numeric text-right font-medium">
                      {row.hitRate === null ? '—' : `${(row.hitRate * 100).toFixed(0)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs leading-relaxed text-slate-600">{accuracy.note}</p>
          </>
        )}
      </div>

      <p className="text-xs text-slate-600">
        Prices come from the exchange&apos;s own published archives and are stored
        unadjusted, exactly as published. Run{' '}
        <code className="numeric">pnpm --filter @psx/api nightly</code> after the close to
        bring them up to date.{' '}
        <Link href="/" className="text-slate-500 hover:text-slate-300">
          Back to positions
        </Link>
      </p>
    </div>
  );
}
