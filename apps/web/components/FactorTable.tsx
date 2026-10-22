'use client';

import { useState } from 'react';
import { categoryLabel } from '@/lib/format';
import type { FactorGuidance, SignalFactor } from '@/lib/types';

/**
 * The factor breakdown.
 *
 * This is the answer to "why", and it is built to be read in that order: the
 * factor that moved the score most comes first, its contribution is drawn as a
 * bar so the relative weight is visible without arithmetic, and the sentence
 * explaining it sits directly underneath rather than behind a tooltip.
 *
 * Both the score and the weight are shown. Either alone is misleading: a factor
 * can be screaming (-100) while carrying 4% of the decision, and the
 * contribution column is what reconciles the two.
 */

export function FactorTable({
  factors,
  onHighlight,
  guidance,
}: {
  factors: SignalFactor[];
  /** Called with the dates a factor fired on, so the chart can mark them. */
  onHighlight?: (dates: string[] | null) => void;
  /** Per-indicator reference text, keyed by factor key. Omitted if unavailable. */
  guidance?: Record<string, FactorGuidance>;
}) {
  const [expanded, setExpanded] = useState<string | null>(factors[0]?.key ?? null);

  // The bars are scaled against the largest contribution rather than against
  // 100, so the shape of a modest signal is still legible.
  const widest = Math.max(...factors.map((factor) => Math.abs(factor.contribution)), 1);

  return (
    <div className="divide-y divide-slate-800/70">
      {factors.map((factor) => {
        const open = expanded === factor.key;
        const positive = factor.contribution >= 0;
        const width = (Math.abs(factor.contribution) / widest) * 100;

        return (
          <div key={factor.key}>
            <button
              type="button"
              onClick={() => {
                const next = open ? null : factor.key;
                setExpanded(next);
                onHighlight?.(next === null ? null : factor.barDates);
              }}
              onMouseEnter={() => {
                if (factor.barDates.length > 0) onHighlight?.(factor.barDates);
              }}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-800/30"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm text-slate-200">{factor.label}</span>
                  <span className="shrink-0 text-xs text-slate-600">
                    {categoryLabel(factor.category)}
                  </span>
                </div>
                <p className="numeric mt-0.5 text-xs text-slate-500">{factor.display}</p>
              </div>

              {/* Contribution, drawn from a centre line so direction is instant. */}
              <div className="hidden w-40 shrink-0 items-center sm:flex">
                <div className="flex h-5 w-full items-center">
                  <div className="flex h-full w-1/2 justify-end">
                    {!positive && (
                      <div
                        className="h-2 self-center rounded-l bg-rose-500/70"
                        style={{ width: `${width}%` }}
                      />
                    )}
                  </div>
                  <div className="h-3 w-px bg-slate-700" />
                  <div className="flex h-full w-1/2">
                    {positive && (
                      <div
                        className="h-2 self-center rounded-r bg-emerald-500/70"
                        style={{ width: `${width}%` }}
                      />
                    )}
                  </div>
                </div>
              </div>

              <div className="w-24 shrink-0 text-right">
                <p
                  className={`numeric text-sm font-medium ${
                    positive ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {positive ? '+' : '−'}
                  {Math.abs(factor.contribution).toFixed(1)}
                </p>
                <p className="numeric text-xs text-slate-600">
                  {factor.score > 0 ? '+' : ''}
                  {factor.score} × {(factor.weight * 100).toFixed(0)}%
                </p>
              </div>
            </button>

            {open && (
              <div className="bg-slate-950/40 px-4 pb-4 pt-1">
                <p className="max-w-3xl text-sm leading-relaxed text-slate-300">
                  {factor.reason}
                </p>
                {factor.barDates.length > 0 && (
                  <p className="mt-2 text-xs text-slate-500">
                    Fired on {factor.barDates.join(', ')} — marked on the chart.
                  </p>
                )}

                {/*
                  What the indicator means and what changes it, which is the
                  honest answer to "so what do I do". Not a recommendation:
                  nothing in this app has settled long enough to justify one,
                  and the reason above is about this stock today while this is
                  about the indicator in general.
                */}
                {guidance?.[factor.key] !== undefined && (
                  <dl className="mt-4 max-w-3xl space-y-2.5 border-t border-slate-800 pt-3">
                    <div>
                      <dt className="label">How it is read</dt>
                      <dd className="mt-1 text-xs leading-relaxed text-slate-400">
                        {guidance[factor.key]!.reads}
                      </dd>
                    </div>
                    <div>
                      <dt className="label">What to watch</dt>
                      <dd className="mt-1 text-xs leading-relaxed text-slate-400">
                        {guidance[factor.key]!.watchFor}
                      </dd>
                    </div>
                    <div>
                      <dt className="label text-amber-600">Where it misleads</dt>
                      <dd className="mt-1 text-xs leading-relaxed text-amber-500/80">
                        {guidance[factor.key]!.caveat}
                      </dd>
                    </div>
                  </dl>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Group totals.
 *
 * Shows at a glance when the groups disagree — the trend block carrying a call
 * while valuation argues against it is the most useful thing to notice, and it
 * is invisible in a flat list of twelve factors.
 */
export function CategoryBreakdown({
  byCategory,
}: {
  byCategory: Array<{ category: string; contribution: number }>;
}) {
  const widest = Math.max(...byCategory.map((group) => Math.abs(group.contribution)), 1);

  return (
    <div className="space-y-2">
      {byCategory.map((group) => {
        const positive = group.contribution >= 0;
        return (
          <div key={group.category} className="flex items-center gap-3">
            <span className="w-28 shrink-0 truncate text-xs text-slate-400">
              {categoryLabel(group.category)}
            </span>
            <div className="flex h-4 flex-1 items-center">
              <div className="flex h-full w-1/2 justify-end">
                {!positive && (
                  <div
                    className="h-1.5 self-center rounded-l bg-rose-500/70"
                    style={{ width: `${(Math.abs(group.contribution) / widest) * 100}%` }}
                  />
                )}
              </div>
              <div className="h-2.5 w-px bg-slate-700" />
              <div className="flex h-full w-1/2">
                {positive && (
                  <div
                    className="h-1.5 self-center rounded-r bg-emerald-500/70"
                    style={{ width: `${(Math.abs(group.contribution) / widest) * 100}%` }}
                  />
                )}
              </div>
            </div>
            <span
              className={`numeric w-14 shrink-0 text-right text-xs ${
                positive ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {positive ? '+' : '−'}
              {Math.abs(group.contribution).toFixed(1)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
