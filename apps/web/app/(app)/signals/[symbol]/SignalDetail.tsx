'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CategoryBreakdown, FactorTable } from '@/components/FactorTable';
import { PriceChart, type ChartBar } from '@/components/PriceChart';
import { ConfidenceMeter, SignalBadge } from '@/components/SignalBadge';
import { actionLabel } from '@/lib/format';
import type { FactorGuidance, SignalResponse } from '@/lib/types';

/**
 * The prediction view.
 *
 * A client component because the chart and the factor table talk to each other:
 * selecting a factor marks the bars it fired on. That interaction is the reason
 * the page exists — being shown the candles behind a pattern is a different
 * thing from being told a pattern was found.
 */
export function SignalDetail({
  symbol,
  horizon,
  active,
  other,
  bars,
  guidance,
}: {
  symbol: string;
  horizon: 'SWING' | 'LONG_TERM';
  active: SignalResponse;
  other: SignalResponse;
  bars: ChartBar[];
  /** Per-indicator reference text, keyed by factor key. Empty if unavailable. */
  guidance: Record<string, FactorGuidance>;
}) {
  const [highlight, setHighlight] = useState<string[] | null>(null);

  const otherHorizon = horizon === 'SWING' ? 'LONG_TERM' : 'SWING';
  const otherLabel = otherHorizon === 'SWING' ? 'Swing' : 'Long term';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {(['SWING', 'LONG_TERM'] as const).map((option) => (
          <Link
            key={option}
            href={`/signals/${symbol}?horizon=${option}`}
            scroll={false}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              option === horizon
                ? 'bg-slate-800 text-slate-100'
                : 'text-slate-400 hover:bg-slate-800/50'
            }`}
          >
            {option === 'SWING' ? 'Swing · days to weeks' : 'Long term · months to years'}
          </Link>
        ))}

        {/*
          The other horizon's verdict is shown even while viewing this one. The
          two disagreeing is usually the most informative thing here.
        */}
        {other.signal !== null && (
          <span className="ml-auto flex items-center gap-2 text-xs text-slate-500">
            {otherLabel} says
            <SignalBadge action={other.signal.action} score={other.signal.score} />
          </span>
        )}
      </div>

      <div className="card overflow-hidden p-0">
        <PriceChart bars={bars} highlightDates={highlight} />
      </div>

      {active.signal === null ? (
        /*
          A refusal is a legitimate answer, not an error state. It gets the same
          visual weight as a verdict would, because "this stock trades too
          thinly to say anything about" is useful information.
        */
        <div className="card">
          <p className="text-sm font-medium text-slate-300">No signal for {symbol}</p>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
            {active.refusal?.reason ??
              'The engine declined to produce a prediction for this symbol.'}
          </p>
          <p className="mt-3 text-xs text-slate-600">
            The engine refuses rather than guessing. A system that always produces an
            answer teaches you to ignore it.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="card lg:col-span-2">
              <div className="flex flex-wrap items-center gap-4">
                <SignalBadge action={active.signal.action} score={active.signal.score} size="lg" />
                <div>
                  <p className="label">Confidence</p>
                  <div className="mt-1">
                    <ConfidenceMeter
                      confidence={active.signal.confidence}
                      missingFactors={active.signal.missingFactors}
                      coverage={active.signal.coverage}
                      agreement={active.signal.agreement}
                    />
                  </div>
                </div>
              </div>

              {active.signal.narrative !== null && (
                <div className="mt-4 max-w-2xl">
                  <p className="text-sm leading-relaxed text-slate-300">
                    {active.signal.narrative}
                  </p>
                  {/*
                    Who wrote this. A reader deciding what to do with their
                    money is entitled to know whether a language model produced
                    the explanation, and the factor table below is the thing
                    that is actually authoritative either way.
                  */}
                  <p className="mt-2 text-xs text-slate-600">
                    {active.signal.narrativeModel === null
                      ? 'Written from the factor table below by the app itself, with no language model involved.'
                      : `Written by ${active.signal.narrativeModel} from the factor table below. The table is the source; this paragraph is a rendering of it.`}
                  </p>
                </div>
              )}
            </div>

            <div className="card">
              <p className="label mb-3">Where the score comes from</p>
              <CategoryBreakdown byCategory={active.signal.byCategory} />
            </div>
          </div>

          <div className="card p-0">
            <div className="flex items-baseline justify-between border-b border-slate-800 px-4 py-3">
              <div>
                <h2 className="text-sm font-medium text-slate-200">
                  Why this reads {actionLabel(active.signal.action).toLowerCase()}
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  {active.signal.factors.length} factors, strongest first. Select one for the
                  detail.
                </p>
              </div>
              <p className="numeric text-xs text-slate-600">score × weight = contribution</p>
            </div>

            <FactorTable
              factors={active.signal.factors}
              onHighlight={setHighlight}
              guidance={guidance}
            />
          </div>
        </>
      )}
    </div>
  );
}
