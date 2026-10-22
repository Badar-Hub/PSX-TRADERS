'use client';

import { useActionState, useState, type ReactNode } from 'react';
import { createStop } from './actions';
import { initialStopState } from './formState';
import { TrailAdvice } from './TrailAdvice';

type StopType = 'STOP_LOSS' | 'TRAILING_STOP' | 'TAKE_PROFIT';

const TYPES: Array<{ value: StopType; label: string; blurb: string }> = [
  {
    value: 'TRAILING_STOP',
    label: 'Trailing stop',
    blurb:
      'Follows the price up and never down, so a run is locked in as it happens. Set the trail ' +
      'as a percentage below the high.',
  },
  {
    value: 'STOP_LOSS',
    label: 'Stop-loss',
    blurb: 'A fixed level below the price. It does not move, so it protects a decision you made once.',
  },
  {
    value: 'TAKE_PROFIT',
    label: 'Target',
    blurb: 'A fixed level above the price, to tell you when a position has reached what you wanted.',
  },
];

export function StopForm({
  portfolioId,
  defaultSymbol,
  held,
}: {
  portfolioId: string;
  defaultSymbol: string;
  held: Array<{ symbol: string; quantity: number; marketPrice: number | null }>;
}) {
  const [state, action, pending] = useActionState(createStop, initialStopState);
  const [type, setType] = useState<StopType>('TRAILING_STOP');
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [trailPercent, setTrailPercent] = useState('10');

  const trailing = type === 'TRAILING_STOP';
  const fieldError = (name: string) => state.fieldErrors?.[name];
  const chosen = TYPES.find((option) => option.value === type)!;

  return (
    <form action={action} className="card space-y-4">
      <input type="hidden" name="portfolioId" value={portfolioId} />
      <input type="hidden" name="type" value={type} />

      <div className="space-y-1.5">
        {TYPES.map((option) => (
          <label
            key={option.value}
            className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
              type === option.value
                ? 'border-sky-600 bg-sky-600/10 text-sky-300'
                : 'border-slate-700 text-slate-400 hover:bg-slate-800/50'
            }`}
          >
            <input
              type="radio"
              checked={type === option.value}
              onChange={() => setType(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
        <p className="pt-1 text-xs leading-relaxed text-slate-600">{chosen.blurb}</p>
      </div>

      <Field label="Symbol" name="symbol" error={fieldError('symbol')}>
        <input
          id="symbol"
          name="symbol"
          value={symbol}
          onChange={(event) => setSymbol(event.target.value.toUpperCase())}
          required
          placeholder="HBL"
          list="held-symbols"
          className="input uppercase"
        />
        {/* The held symbols as suggestions rather than a closed list: a stop on
            something not yet owned is a legitimate thing to want. */}
        <datalist id="held-symbols">
          {held.map((position) => (
            <option key={position.symbol} value={position.symbol} />
          ))}
        </datalist>
      </Field>

      {trailing ? (
        <>
          <Field label="Trail" name="trailPercent" error={fieldError('trailPercent')}>
            <div className="flex items-center gap-2">
              <input
                id="trailPercent"
                name="trailPercent"
                value={trailPercent}
                onChange={(event) => setTrailPercent(event.target.value)}
                required
                inputMode="decimal"
                className="input"
              />
              <span className="text-sm text-slate-500">% below the high</span>
            </div>
          </Field>

          {/* Armed from the latest close, so there is no level to type. Saying
              so prevents the obvious misreading of an empty price field. */}
          <p className="text-xs leading-relaxed text-slate-600">
            The stop starts one trail below the latest close and moves up from there. It never
            moves down.
          </p>

          <TrailAdvice
            symbol={symbol}
            trailPercent={trailPercent}
            onAdopt={(percent) => setTrailPercent(percent)}
          />
        </>
      ) : (
        <Field label="Level" name="thresholdPrice" error={fieldError('thresholdPrice')}>
          <input
            id="thresholdPrice"
            name="thresholdPrice"
            required
            inputMode="decimal"
            placeholder="170.19"
            className="input numeric"
          />
          <p className="mt-1 text-xs text-slate-600">
            {type === 'STOP_LOSS'
              ? 'Below the current price, or it would fire at once.'
              : 'Above the current price, or it would fire at once.'}
          </p>
        </Field>
      )}

      <Field label="Shares" name="quantity" error={fieldError('quantity')}>
        <input
          id="quantity"
          name="quantity"
          inputMode="numeric"
          placeholder="All held"
          className="input numeric"
        />
        <p className="mt-1 text-xs text-slate-600">
          Only used to show what is at risk. Leave blank to use the whole holding.
        </p>
      </Field>

      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-300">
          Trigger basis and expiry
        </summary>
        <div className="mt-3 space-y-4">
          <Field label="Trigger on" name="triggerOn">
            <select id="triggerOn" name="triggerOn" className="input" defaultValue="CLOSE">
              <option value="CLOSE">The closing price</option>
              <option value="INTRADAY_LOW">The day&rsquo;s low</option>
              <option value="INTRADAY_HIGH">The day&rsquo;s high</option>
            </select>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              The close is the honest default on end-of-day data: it is a price you could have
              acted on. The intraday options answer &ldquo;was this level touched&rdquo;, which is
              the right question for a stop but tells you nothing about what you would have
              received.
            </p>
          </Field>

          <Field label="Expires" name="expiresOn" error={fieldError('expiresOn')}>
            <input id="expiresOn" name="expiresOn" type="date" className="input" />
          </Field>

          <Field label="Note" name="note">
            <input id="note" name="note" maxLength={500} className="input" placeholder="Optional" />
          </Field>
        </div>
      </details>

      {state.error !== null && (
        <p className="rounded-lg border border-rose-800/40 bg-rose-950/30 px-3 py-2 text-sm leading-relaxed text-rose-300">
          {state.error}
        </p>
      )}
      {state.notice !== null && (
        <p className="rounded-lg border border-emerald-800/40 bg-emerald-950/30 px-3 py-2 text-sm leading-relaxed text-emerald-300">
          {state.notice}
        </p>
      )}

      <button type="submit" disabled={pending} className="btn-primary w-full">
        {pending ? 'Arming…' : 'Start watching'}
      </button>
    </form>
  );
}

function Field({
  label,
  name,
  error,
  children,
}: {
  label: string;
  name: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={name} className="label mb-1.5 block">
        {label}
      </label>
      {children}
      {error !== undefined && <p className="mt-1.5 text-xs text-rose-400">{error}</p>}
    </div>
  );
}
