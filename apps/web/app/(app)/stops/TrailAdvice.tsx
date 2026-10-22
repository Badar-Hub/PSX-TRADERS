'use client';

import { useState, useTransition } from 'react';
import { percentFromBps, rupees, shortDate } from '@/lib/format';
import { getTrailAdvice, type TrailAdvice as Advice } from './actions';

/**
 * Is this trail right for this stock?
 *
 * The honest answer needs two things the user cannot work out from a form: how
 * much the stock actually moves, and what the trail they typed would have done
 * over the last year. A round ten percent is noise on a volatile small cap and
 * a disaster on a utility, and nobody can tell which they are holding by
 * looking at a price.
 *
 * The replay uses the same evaluator as the nightly job, so what it shows is
 * what the rule would really have done — not a separate backtest with its own
 * arithmetic that happens to share a name.
 */
export function TrailAdvice({
  symbol,
  trailPercent,
  onAdopt,
}: {
  symbol: string;
  trailPercent: string;
  onAdopt: (percent: string) => void;
}) {
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [pending, start] = useTransition();

  const check = (): void => {
    start(async () => {
      setAdvice(await getTrailAdvice(symbol, trailPercent));
    });
  };

  const suggestion = advice?.suggestion ?? null;
  const backtest = advice?.backtest ?? null;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="label">Check this trail</p>
        {/* A button, not a submit: this panel sits inside the arming form, and
            a nested form is invalid. The action is called as an RPC instead. */}
        <button
          type="button"
          onClick={check}
          disabled={pending || symbol.trim() === ''}
          className="btn-ghost text-xs"
        >
          {pending ? 'Checking…' : 'Check'}
        </button>
      </div>

      {advice === null ? (
        <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
          Replays this trail over the stored history for {symbol === '' ? 'the symbol' : symbol},
          and sizes one to how much it actually moves.
        </p>
      ) : advice.error !== null ? (
        <p className="mt-2 text-xs leading-relaxed text-amber-400">{advice.error}</p>
      ) : (
        <div className="mt-2 space-y-3">
          {suggestion !== null && (
            <div>
              <p className="text-xs leading-relaxed text-slate-300">{suggestion.reason}</p>
              {suggestion.trailBps !== null && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="numeric text-xs text-slate-500">
                    Suggested {(suggestion.trailBps / 100).toFixed(1)}% · stop at{' '}
                    {rupees(suggestion.suggestedStop)}
                  </span>
                  {Math.round(Number(trailPercent) * 100) !== suggestion.trailBps && (
                    <button
                      type="button"
                      onClick={() => onAdopt((suggestion.trailBps! / 100).toFixed(1))}
                      className="btn-ghost text-xs"
                    >
                      Use it
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {backtest !== null && (
            <div className="border-t border-slate-800 pt-2">
              <p className="text-xs leading-relaxed text-slate-300">{backtest.verdict}</p>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                <Row
                  label="Window"
                  value={`${shortDate(backtest.from)} – ${shortDate(backtest.to)}`}
                />
                <Row label="Bars" value={String(backtest.barsConsidered)} />
                {backtest.triggeredOn !== null && (
                  <Row label="Would have exited" value={shortDate(backtest.triggeredOn)} />
                )}
                {backtest.versusHoldingBps !== null && (
                  <Row
                    label="Versus holding"
                    value={percentFromBps(backtest.versusHoldingBps)}
                    tone={
                      backtest.versusHoldingBps > 0 ? 'text-emerald-400' : 'text-rose-400'
                    }
                  />
                )}
              </dl>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
                One symbol over one window. It says what this trail did, not what it will do.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-slate-600">{label}</dt>
      <dd className={`numeric ${tone ?? 'text-slate-400'}`}>{value}</dd>
    </div>
  );
}
